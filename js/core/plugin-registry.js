/* ============================================================
   IRIBHM Microscopy Platform — Plugin Registry  (v2)
   ============================================================
   Central registry for viewer modules.

   Module Structure:
     js/modules/<placement>/<module-id>/
       ├── plugin.json   — metadata (id, name, version, creator, placement, group, icon, …)
       └── index.js       — implementation (calls PluginRegistry.implement)

   Placements:
     'tools'    → toolbar buttons (tools, export, visuals, layouts, help)
     'channels' → per-channel sidebar controls (histogram, gaussian filter, …)
     'shaders'  → render mode entries (populate render-mode selector)

   Loading Flow:
     1. viewer.js calls PluginRegistry.loadModules(basePath, listOfPaths)
     2. For each path, the registry fetches plugin.json → validates → injects <script> for index.js
     3. index.js calls PluginRegistry.implement(id, { init, activate, … })
     4. viewer.js calls PluginRegistry.initAll(ctx) after all modules are loaded

   ============================================================ */

const PluginRegistry = (() => {
  // id → { meta, impl, instance, state }
  const _modules = new Map();
  // hookName → Set<callback>
  const _hooks = new Map();
  // ViewerContext provided by viewer.js
  let _ctx = null;
  // Trust epoch (from /api/plugins) — bumped server-side on approve/revoke. The
  // runtime-revocation watcher compares it to detect a live revocation.
  let _trustEpoch = null;
  let _trustWatchTimer = null;

  // ─── Discovery ────────────────────────────────────────────

  // Crash-proof floor (rule 1.1): if both the live endpoint and the generated
  // manifest are unavailable, the viewer still boots with the core plugin set.
  // This is the ONLY place the built-in list is enumerated; it is intentionally
  // a safety net, not the source of truth — real discovery is folder-driven.
  const _DEFAULT_MODULE_PATHS = [
    'tools/toggle-grid', 'tools/toggle-axes', 'tools/orientation-axes', 'tools/toggle-volume',
    'tools/screenshot', 'tools/presentation-mode', 'tools/download-center', 'tools/decompose-channels',
    'tools/zstack-browser', 'tools/slice-inspector',
    'tools/measure-distance', 'tools/chunk-debug',
    'shaders/fluorescence', 'shaders/structure-dvr',
    'channels/histogram', 'channels/gaussian-filter'
  ];

  // Rich plugin metadata captured during discover() when a source provides it
  // inline. The live /api/plugins endpoint returns each plugin's full plugin.json
  // (plus an `i18n` map of its translation dictionaries); the static manifest
  // returns only {path,placement,id} triples and the embedded default only bare
  // paths. Keyed by module path ('<placement>/<id>'). loadModules() consults this
  // to skip the redundant per-plugin plugin.json fetch (and, when `i18n` is
  // present, the per-locale lang fetches). Empty ⇒ loadModules fetches plugin.json
  // as before, so static/PHP hosts are unaffected (no v0.12.45-class regression).
  const _discoveredMeta = new Map();

  // Quarantine ledger: every plugin rejected before/at load or failing init lands
  // here with an actionable reason, instead of silently vanishing from the UI.
  // Surfaced to the admin panel (and the console) via getQuarantined().
  // Keyed by module path ('<placement>/<id>') — reset on each discover().
  const _quarantined = new Map();

  function _quarantine(modPath, reason, detail) {
    _quarantined.set(modPath, { path: modPath, reason, detail, at: Date.now() });
    console.warn(`[PluginRegistry] Quarantined "${modPath}" (${reason}): ${detail}`);
  }

  /** @returns {Array<{path, reason, detail, at}>} plugins rejected this session */
  function getQuarantined() {
    return Array.from(_quarantined.values());
  }

  // A discovery entry is "rich" — a full plugin.json safe to use without a
  // separate fetch — only when it carries fields the {path,placement,id} manifest
  // triple never has. `name` is mandatory in every plugin.json; never trust the
  // triple as authoritative for toolbar fields (group/subtype/icon/order/i18n*).
  function _isRichMeta(p) {
    return !!p && typeof p === 'object'
      && (typeof p.name === 'string' || typeof p.subtype === 'string' || !!p.i18n);
  }

  /**
   * Fetch a plugin list from one source and normalize it to an array of paths.
   * Returns null on any failure (network, non-OK, non-JSON such as raw PHP
   * served statically, or wrong shape) so the caller can fall through. As a side
   * effect, captures any rich inline metadata into _discoveredMeta (see above).
   */
  async function _fetchPluginList(url) {
    try {
      const resp = await fetch(url, { cache: 'no-store' });
      if (!resp.ok) return null;
      const data = await resp.json(); // throws on non-JSON body → caught below
      const plugins = Array.isArray(data) ? data : data?.plugins;
      if (!Array.isArray(plugins)) return null;
      // Capture the trust epoch so the runtime-revocation watcher can detect an
      // approve/revoke on the server and tear down a now-revoked sandboxed plugin.
      if (data && typeof data.trustEpoch === 'number') _trustEpoch = data.trustEpoch;
      // Capture rich inline meta as a side effect (no array allocation here).
      for (const p of plugins) {
        const mp = typeof p === 'string' ? p : p?.path;
        if (typeof mp === 'string' && mp.includes('/') && _isRichMeta(p)) _discoveredMeta.set(mp, p);
      }
      const paths = plugins
        .map(p => (typeof p === 'string' ? p : p?.path))
        .filter(p => typeof p === 'string' && p.includes('/'));
      return paths.length ? paths : null;
    } catch (_) {
      return null;
    }
  }

  /**
   * Resolve the list of plugin module paths with a hybrid strategy so the
   * platform auto-detects folders dropped into js/modules/ without a hardcoded
   * manifest, while still booting on any host:
   *   1. live discovery endpoint  (dev_server.py /api/plugins, or PHP plugins.php)
   *   2. generated static manifest (js/modules/manifest.json — static/PHP hosts)
   *   3. embedded default list     (crash-proof floor)
   * @param {string} basePath  e.g. 'js/modules'
   * @returns {Promise<string[]>} module paths like ['tools/toggle-grid', …]
   */
  async function discover(basePath = 'js/modules') {
    _discoveredMeta.clear(); // drop any inline meta from a previous discover()
    _quarantined.clear();
    const candidates = ['api/plugins', 'api/plugins.php', `${basePath}/manifest.json`];
    for (const url of candidates) {
      const paths = await _fetchPluginList(url);
      if (paths) {
        console.log(`[PluginRegistry] Discovered ${paths.length} plugins via ${url}`);
        return paths;
      }
    }
    console.warn('[PluginRegistry] Discovery failed (endpoint + manifest unavailable) — using embedded default list.');
    return _DEFAULT_MODULE_PATHS.slice();
  }

  // ─── Module Loading ───────────────────────────────────────

  /**
   * Load modules from their directories.
   * @param {string} basePath  e.g. 'js/modules'
   * @param {string[]} modulePaths  e.g. ['tools/toggle-grid', 'shaders/fluorescence']
   */
  // version.json `files` map (release installs) — the content-addressed source of
  // truth for 'bundled'. Fetched once per loadModules batch; null on dev/static.
  async function _releaseManifest() {
    try {
      const resp = await fetch('version.json', { cache: 'no-store' });
      if (!resp.ok) return null;
      const m = await resp.json();
      return (m && m.files && typeof m.files === 'object') ? m.files : null;
    } catch (_) { return null; }
  }

  async function loadModules(basePath, modulePaths) {
    // Resolved once for the whole batch: version.json (release installs) →
    // /api/health (dev server) → null (gate inert — see js/core/compat.js).
    const platformVer = (typeof Compat !== 'undefined' && Compat.platformVersion)
      ? await Compat.platformVersion()
      : null;
    const releaseManifest = (typeof PluginTrust !== 'undefined') ? await _releaseManifest() : null;

    const loadPromises = modulePaths.map(async (modPath) => {
      try {
        // Prefer rich metadata captured during discover() (live endpoint) to skip
        // a redundant plugin.json round-trip; otherwise fetch it (static manifest
        // / PHP / embedded-default hosts, or a direct loadModules(paths) call).
        let meta = _discoveredMeta.get(modPath) || null;
        if (!meta) {
          const jsonUrl = `${basePath}/${modPath}/plugin.json`;
          const resp = await fetch(jsonUrl);
          if (!resp.ok) {
            _quarantine(modPath, 'meta-unreachable', `plugin.json fetch failed (${resp.status})`);
            return;
          }
          try {
            meta = await resp.json();
          } catch (err) {
            _quarantine(modPath, 'invalid-meta', `plugin.json is not valid JSON (${err.message})`);
            return;
          }
        }

        // Hard meta validation BEFORE anything executes or gets keyed: an id-less
        // or mis-labelled plugin.json must never register (Map key `undefined`
        // would shadow/collide) and must never inject code.
        const [expectedPlacement, folderId] = modPath.split('/');
        if (!meta || typeof meta.id !== 'string' || !meta.id.trim()) {
          _quarantine(modPath, 'invalid-meta', 'plugin.json has no usable "id"');
          return;
        }
        if (meta.id !== folderId) {
          _quarantine(modPath, 'invalid-meta', `id "${meta.id}" ≠ folder "${folderId}"`);
          return;
        }
        if (meta.placement && meta.placement !== expectedPlacement) {
          _quarantine(modPath, 'invalid-meta',
            `declares placement="${meta.placement}" but lives in "${expectedPlacement}/"`);
          return;
        }

        // Compatibility gate (fail-closed) — an incompatible plugin's index.js is
        // NEVER injected; the viewer boots without it and the admin panel explains
        // why. Restored automatically once a core update satisfies the constraint.
        if (typeof Compat !== 'undefined') {
          const compat = Compat.satisfies(platformVer, meta.platformCompat);
          if (!compat.ok) {
            _quarantine(modPath, 'incompatible', compat.reason);
            return;
          }
        }

        meta.placement = meta.placement || expectedPlacement;
        meta._path = `${basePath}/${modPath}`;
        meta._modPath = modPath;

        // ── Trust gate (Phase 2) — untrusted code must NOT run in-page ──────────
        // The server vouches a tier + hash in meta.trust; PluginTrust re-hashes the
        // EXACT bytes it will execute (anti-TOCTOU, INV-2) and returns the tier.
        //   untrusted → never injected (quarantined for operator approval);
        //   sandboxed → runs in a null-origin iframe via PluginSandbox (no ctx/DOM);
        //   bundled/dev/approved-trusted → executed IN-PAGE from the hashed bytes.
        if (typeof PluginTrust !== 'undefined') {
          const verdict = await PluginTrust.evaluate(meta, basePath, modPath, releaseManifest);
          if (verdict.tier === 'untrusted') {
            _quarantine(modPath, 'untrusted', verdict.reason);
            return;
          }
          meta._trust = { tier: verdict.tier, hash: verdict.hash };

          if (verdict.tier === 'sandboxed') {
            if (expectedPlacement !== 'tools' ||
                (meta.subtype !== 'action' && meta.subtype !== 'toggle')) {
              // By design, not a bug — see DOCS/plugin-sandbox/SPEC.md §"Placement scope".
              // shaders: a GLSL render mode compiles synchronously into the volume
              //   material and runs on the GPU every frame; there is no async RPC
              //   boundary a null-origin iframe could sit behind → in-page trust ONLY.
              // channels: the channel-panel API hands plugins the channel-item DOM
              //   element directly (getChannelUI/bindChannelUI) — the exact privilege
              //   the sandbox removes; a sandboxed channel would need a declarative
              //   schema + channel-effect capabilities that no plugin yet consumes.
              const why = expectedPlacement === 'shaders'
                ? 'shader plugins run GLSL on the GPU synchronously and cannot be sandboxed (in-page trust required)'
                : expectedPlacement === 'channels'
                  ? 'sandboxed channel UI is not yet supported (declarative-schema path deferred — see SPEC.md)'
                  : `sandboxed plugins support only tools action/toggle (got ${expectedPlacement}/${meta.subtype})`;
              _quarantine(modPath, 'sandbox-unsupported-placement', why);
              return;
            }
            if (typeof PluginSandbox === 'undefined') {
              _quarantine(modPath, 'sandbox-unavailable', 'PluginSandbox not loaded on this page');
              return;
            }
            const code = new TextDecoder('utf-8').decode(verdict.bytes);
            try {
              const shim = await PluginSandbox.spawn(meta, verdict.hash, verdict.caps || [], code);
              _modules.set(meta.id, { meta, impl: shim, instance: shim, state: 'initialized' });
            } catch (e) {
              // Defense in depth: ensure no live/zombie frame survives a boot failure
              // (spawn() also self-cleans on timeout — this covers every reject path).
              try { PluginSandbox.kill(meta.id, 'boot-failed'); } catch (_) {}
              _quarantine(modPath, 'sandbox-boot-failed', String(e && e.message || e));
            }
            return;
          }
          // Trusted in-page: register + execute the exact hashed bytes (no re-fetch).
          _modules.set(meta.id, { meta, impl: null, instance: null, state: 'registered' });
          const [, execOk] = await Promise.all([_grafti18n(meta), _execTrustedInPage(meta, verdict.bytes)]);
          if (!execOk) {
            _modules.delete(meta.id);
            _quarantine(modPath, 'script-failed', 'index.js failed to load or parse');
          }
          return;
        }

        // FAIL CLOSED: PluginTrust is a mandatory security dependency. If it failed
        // to load, we must NOT inject unverified code — quarantine instead of
        // falling back to a trust-less URL injection (that would be fail-open).
        _quarantine(modPath, 'trust-unavailable',
          'plugin-trust.js not loaded — refusing to inject an unverified plugin');
        return;

      } catch (err) {
        _quarantine(modPath, 'load-error', String(err && err.message || err));
      }
    });
    await Promise.all(loadPromises);
  }

  /**
   * Graft a plugin's own translation dictionaries into the i18n tree before UI is
   * built (preserves the v0.12.45 invariant). Returns a promise for the fetch
   * fallback, or a resolved promise when dictionaries arrived inline (live endpoint).
   */
  function _grafti18n(meta) {
    if (typeof I18n === 'undefined') return Promise.resolve();
    if (meta.i18n && meta.i18n.en && I18n.registerPluginLang) {
      I18n.registerPluginLang(meta.id, meta._path, meta.i18n, meta.i18nLanguages);
      return Promise.resolve();
    }
    if (I18n.loadPluginLang) return I18n.loadPluginLang(meta.id, meta._path, meta.i18nLanguages);
    return Promise.resolve();
  }

  /**
   * Execute a TRUSTED plugin's index.js from the EXACT bytes that were hashed
   * (INV-2, anti-TOCTOU): a Blob URL of those bytes — never a re-fetch by the
   * plugin's URL, which would let the file change between hash and execution.
   * The Blob URL is same-origin-ish 'self' script for CSP purposes.
   */
  function _execTrustedInPage(meta, bytes) {
    return new Promise((resolve) => {
      const url = URL.createObjectURL(new Blob([bytes], { type: 'text/javascript' }));
      const script = document.createElement('script');
      script.src = url;
      if (_pageNonce) script.setAttribute('nonce', _pageNonce);
      script.onload = () => { URL.revokeObjectURL(url); resolve(true); };
      script.onerror = () => {
        URL.revokeObjectURL(url);
        console.error(`[PluginRegistry] Failed to execute plugin: ${meta._modPath}`);
        resolve(false);
      };
      document.body.appendChild(script);
    });
  }

  // Per-page nonce for the strict-CSP path: legitimate scripts (incl. trusted plugin
  // blob-URLs) carry it; plugin code can never read it. Sourced from THIS script tag's
  // own nonce (L9) — `document.currentScript.nonce`, captured synchronously at load
  // while currentScript is still valid. The browser hides the nonce from the DOM
  // (element.getAttribute('nonce')==='' post-parse) yet keeps the .nonce IDL property,
  // so it can't be exfiltrated via a CSS attribute-selector side channel the way a
  // world-readable <meta content> could. null when CSP isn't enforced (unsubstituted
  // placeholder on a static host → treated as absent).
  const _pageNonce = (() => {
    try {
      const s = document.currentScript;
      const n = s && s.nonce;
      return n && n !== '{{CSP_NONCE}}' ? n : null;
    } catch (_) { return null; }
  })();

  // ─── Implementation Binding ───────────────────────────────

  /**
   * Called by a module's index.js to provide its implementation.
   * The module must have been previously registered via loadModules().
   *
   * @param {string} id  Module id (must match plugin.json id)
   * @param {Object} impl  Implementation object with methods:
   *   init(ctx), activate(), deactivate(), getState(), setState(s), dispose()
   *   For channels: getChannelUI(idx, state), onChannelUIEvent(idx, e)
   *   For shaders: (activate sets the render mode)
   */
  function implement(id, impl) {
    const entry = _modules.get(id);
    if (!entry) {
      console.error(`[PluginRegistry] implement("${id}") called but no plugin.json was loaded for this id. Register it first via loadModules().`);
      return;
    }
    entry.impl = impl;
  }

  // ─── Lifecycle ────────────────────────────────────────────

  /**
   * Provide the ViewerContext and initialize all loaded modules.
   */
  async function initAll(ctx) {
    _ctx = ctx;
    for (const [id, entry] of _modules) {
      if (!entry.impl) {
        entry.state = 'quarantined';
        _quarantine(entry.meta._modPath || id, 'no-impl',
          'index.js loaded but never called implement()');
        continue;
      }
      try {
        if (typeof entry.impl.init === 'function') {
          // Each plugin gets its own ctx whose `i18n` is bound to the plugin
          // id (ctx.i18n.t('key') → plugins.<id>.key). The shared ctx is the
          // prototype, so every other façade (viewer/dataset/ui/…) is inherited.
          const pctx = Object.create(ctx);
          pctx.i18n = (typeof I18n !== 'undefined' && I18n.forPlugin)
            ? I18n.forPlugin(id)
            : { t: (k) => k, getLanguage: () => 'en', onLanguageChange: () => {} };
          entry.ctx = pctx;
          entry.instance = await entry.impl.init(pctx);
        }
        entry.state = 'initialized';
      } catch (err) {
        // One plugin throwing in init() must never block the others (rule 1.1).
        entry.state = 'quarantined';
        _quarantine(entry.meta._modPath || id, 'init-failed', String(err && err.message || err));
      }
    }
    _bindLanguageChange();
    _emit('modules-initialized');
  }

  // Re-render plugin-owned dynamic content on a language switch. Static
  // toolbar labels carry data-i18n-title and are handled by I18n itself;
  // this drives the runtime strings a plugin paints into its panels.
  let _langBound = false;
  function _bindLanguageChange() {
    if (_langBound || typeof I18n === 'undefined' || !I18n.onLanguageChange) return;
    _langBound = true;
    I18n.onLanguageChange(() => {
      for (const [id, entry] of _modules) {
        if (entry.state === 'disposed' || !entry.impl) continue;
        if (typeof entry.impl.onLanguageChange === 'function') {
          try {
            entry.impl.onLanguageChange.call(entry.instance || entry.impl);
          } catch (err) {
            console.warn(`[PluginRegistry] onLanguageChange failed for "${id}":`, err);
          }
        }
      }
    });
  }

  /**
   * Activate a module (toolbar toggle/action, shader switch, etc.).
   * Returns the result of the module's activate() call, if any.
   */
  function activate(id) {
    const entry = _modules.get(id);
    if (!entry || !entry.impl || entry.state === 'disposed' || entry.state === 'quarantined') return null;
    if (typeof entry.impl.activate === 'function') {
      try {
        const result = entry.impl.activate.call(entry.instance || entry.impl);
        entry.state = 'active';
        _emit('module-activated', { id, result });
        return result;
      } catch (err) {
        // A throwing activate() must not surface as an uncaught error on a
        // toolbar click, and must not flip the state to 'active'.
        console.error(`[PluginRegistry] activate failed for "${id}":`, err);
        return null;
      }
    }
    return null;
  }

  /**
   * Deactivate a module.
   */
  function deactivate(id) {
    const entry = _modules.get(id);
    if (!entry || !entry.impl || entry.state === 'quarantined') return;
    if (typeof entry.impl.deactivate === 'function') {
      try {
        entry.impl.deactivate.call(entry.instance || entry.impl);
      } catch (err) {
        console.error(`[PluginRegistry] deactivate failed for "${id}":`, err);
      }
    }
    if (entry.state === 'active') entry.state = 'initialized';
    _emit('module-deactivated', { id });
  }

  // ─── Queries ──────────────────────────────────────────────

  /**
   * Get a module entry by id.
   * @returns {{ meta, impl, instance, state } | null}
   */
  function getModule(id) {
    return _modules.get(id) || null;
  }

  /**
   * List all modules matching a placement.
   * @param {'tools'|'channels'|'shaders'} placement
   * @returns {Array<Object>} Array of meta objects
   */
  function listByPlacement(placement) {
    const results = [];
    for (const [, entry] of _modules) {
      if (entry.meta.placement === placement) {
        results.push(entry.meta);
      }
    }
    results.sort((a, b) => {
      const oa = Number.isFinite(a.order) ? a.order : 999;
      const ob = Number.isFinite(b.order) ? b.order : 999;
      if (oa !== ob) return oa - ob;
      return (a.name || '').localeCompare(b.name || '');
    });
    return results;
  }

  /**
   * List all modules in a given group (for tools placement).
   * @param {string} group  e.g. 'visuals', 'export', 'layouts'
   * @returns {Array<Object>}
   */
  function listByGroup(group) {
    return listByPlacement('tools').filter(m => m.group === group);
  }

  // ─── Workspace State ──────────────────────────────────────

  /**
   * Collect workspace state from all modules.
   * @returns {Object} { moduleId: state, … }
   */
  function getWorkspaceState() {
    const state = {};
    for (const [id, entry] of _modules) {
      if (entry.state === 'disposed' || !entry.impl) continue;
      if (typeof entry.impl.getState === 'function') {
        try {
          const s = entry.impl.getState.call(entry.instance || entry.impl);
          if (s !== undefined && s !== null) {
            state[id] = s;
          }
        } catch (err) {
          console.warn(`[PluginRegistry] getState failed for "${id}":`, err);
        }
      }
    }
    return state;
  }

  /**
   * Restore workspace state for all modules.
   * @param {Object} state { moduleId: state, … }
   */
  function setWorkspaceState(state) {
    if (!state || typeof state !== 'object') return;
    for (const [id, moduleState] of Object.entries(state)) {
      const entry = _modules.get(id);
      if (!entry || entry.state === 'disposed' || !entry.impl) continue;
      // A module that is only 'registered' (index.js ran implement() but initAll()
      // hasn't called init(ctx) yet) has a null context — setState would throw.
      if (entry.state === 'registered') continue;
      if (typeof entry.impl.setState === 'function') {
        try {
          entry.impl.setState.call(entry.instance || entry.impl, moduleState);
        } catch (err) {
          console.warn(`[PluginRegistry] setState failed for "${id}":`, err);
        }
      }
    }
  }

  // ─── Toolbar Button Generation ────────────────────────────

  /**
   * Generate toolbar buttons for every 'tools' plugin from its plugin.json,
   * so the toolbar is driven by what is in js/modules/tools/ (drop-in / drop-out)
   * exactly the way the shader dropdown and per-channel controls already are.
   *
   * Per plugin.json: `group` selects the cluster, `order` the position,
   * `subtype` the kind (action/toggle → data-plugin-id wired by
   * bindToolbarButtons; tool → data-tool chip wired by ToolManager),
   * `icon`/`i18nTitle`/`i18nAria`/`buttonId` the presentation, and an optional
   * `requires` array gates visibility against the dataset's volumeSources.
   *
   * Idempotent: previously generated nodes are removed first, so re-running it
   * (or booting N compare iframes) never duplicates buttons.
   *
   * @param {Object} opts
   * @param {Array<{group:string, container:(HTMLElement|string)}>} opts.groups
   *        ordered cluster mapping (container is an element or a CSS selector)
   * @param {Object} [opts.dataset]  dataset meta, for `requires` predicates
   */
  function buildToolbarButtons(opts = {}) {
    const groups = Array.isArray(opts.groups) ? opts.groups : [];
    const sources = Array.isArray(opts.dataset?.volumeSources) ? opts.dataset.volumeSources : [];
    const hasSource = (kind) => sources.some(s => s && s.kind === kind && s.available !== false);

    const containerFor = {};
    const touched = [];
    for (const g of groups) {
      const el = typeof g.container === 'string' ? document.querySelector(g.container) : g.container;
      if (!el) continue;
      // Remove buttons from a previous build (keeps static core chips like navigate).
      el.querySelectorAll('[data-plugin-generated]').forEach(n => n.remove());
      containerFor[g.group] = el;
      touched.push(el);
    }

    // Resolve a toolbar label preferring the plugin's OWN dictionary
    // (plugins.<id>.<key>) and falling back to a platform key (legacy
    // plugin.json values like 'tips.measureDist'), then to a literal
    // fallback. Returns the resolved text plus the key to stamp into
    // data-i18n-* so the label re-translates on a language switch.
    const resolveLabel = (id, key, fallback) => {
      if (!key || typeof I18n === 'undefined' || !I18n.t) {
        return { text: fallback || key || '', attrKey: null };
      }
      const nsKey = `plugins.${id}.${key}`;
      const ns = I18n.t(nsKey);
      if (ns !== nsKey) return { text: ns, attrKey: nsKey };
      const plat = I18n.t(key);
      if (plat !== key) return { text: plat, attrKey: key };
      return { text: fallback || key, attrKey: key };
    };

    for (const meta of listByPlacement('tools')) {
      try {
      const container = containerFor[meta.group];
      if (!container) {
        console.warn(`[PluginRegistry] Tool "${meta.id}" has group "${meta.group}" with no toolbar cluster — button skipped.`);
        continue;
      }

      const btn = document.createElement('button');
      btn.dataset.pluginGenerated = '1';
      if (meta.buttonId) btn.id = meta.buttonId;

      if (meta.subtype === 'tool') {
        // ToolManager-mux tool (exclusive): wired by ToolManager via [data-tool].
        btn.className = 'btn btn-icon btn-ghost tool-chip';
        btn.dataset.tool = meta.tool || meta.id;
      } else {
        // action / toggle: wired by bindToolbarButtons via [data-plugin-id].
        btn.className = 'btn btn-icon btn-ghost';
        btn.dataset.pluginId = meta.id;
      }

      const titleR = resolveLabel(meta.id, meta.i18nTitle, meta.name || meta.id);
      const ariaR = resolveLabel(meta.id, meta.i18nAria || meta.i18nTitle, titleR.text);
      btn.title = titleR.text;
      btn.setAttribute('aria-label', ariaR.text);
      if (titleR.attrKey) btn.setAttribute('data-i18n-title', titleR.attrKey);
      if (ariaR.attrKey) btn.setAttribute('data-i18n-aria', ariaR.attrKey);

      const icon = document.createElement('i');
      icon.setAttribute('data-lucide', meta.icon || 'square');
      btn.appendChild(icon);

      // Declarative visibility: hide until the dataset offers the required source(s).
      if (Array.isArray(meta.requires) && meta.requires.length && !meta.requires.every(hasSource)) {
        btn.style.display = 'none';
      }

      container.appendChild(btn);
      } catch (err) {
        // One malformed plugin.json must never cost the other plugins their
        // buttons — skip this one, keep building (rule 1.1).
        console.warn(`[PluginRegistry] Toolbar build failed for "${meta && meta.id}":`, err);
      }
    }

    if (window.lucide && touched.length) lucide.createIcons({ nodes: touched });
    if (typeof I18n !== 'undefined' && I18n.translateDOM) I18n.translateDOM();
  }

  // ─── Toolbar Button Binding ───────────────────────────────

  /**
   * Connect toolbar modules to existing HTML buttons via data-plugin-id.
   */
  function bindToolbarButtons() {
    document.querySelectorAll('[data-plugin-id]').forEach(btn => {
      const pluginId = btn.dataset.pluginId;
      const entry = _modules.get(pluginId);
      if (!entry) return;

      const meta = entry.meta;

      btn.addEventListener('click', () => {
        const result = activate(pluginId);
        // Update visual state for toggles
        if (meta.subtype === 'toggle' && result) {
          btn.classList.toggle('btn-solid', !!result.active);
          btn.classList.toggle('btn-ghost', !result.active);
          if (result.icon) {
            const iconEl = btn.querySelector('i[data-lucide]');
            if (iconEl) {
              iconEl.setAttribute('data-lucide', result.icon);
              if (window.lucide) lucide.createIcons({ nodes: [btn] });
            }
          }
        }
      });
    });
  }

  // ─── Cleanup ──────────────────────────────────────────────

  /**
   * Dispose all modules.
   */
  function disposeAll() {
    for (const [id, entry] of _modules) {
      if (entry.impl && typeof entry.impl.dispose === 'function') {
        try {
          entry.impl.dispose.call(entry.instance || entry.impl);
        } catch (err) {
          console.warn(`[PluginRegistry] dispose failed for "${id}":`, err);
        }
      }
      entry.state = 'disposed';
    }
    _emit('modules-disposed');
  }

  // ─── Event System ─────────────────────────────────────────

  function on(hook, cb) {
    if (!_hooks.has(hook)) _hooks.set(hook, new Set());
    _hooks.get(hook).add(cb);
    return () => _hooks.get(hook)?.delete(cb);
  }

  function _emit(hook, data) {
    const listeners = _hooks.get(hook);
    if (!listeners) return;
    for (const cb of listeners) {
      try { cb(data); } catch (err) {
        console.warn(`[PluginRegistry] Hook "${hook}" listener error:`, err);
      }
    }
  }

  // ─── Runtime trust revocation ─────────────────────────────
  // An operator approve/revoke bumps the server's trustEpoch. This watcher notices
  // the change in an already-open viewer and tears down a now-revoked SANDBOXED
  // plugin (killing its iframe removes all its capabilities immediately). In-page
  // plugins (bundled/dev/approved-trusted) cannot be un-executed at runtime, so a
  // revocation of those still takes effect on the next reload (server excludes them
  // from discovery) — only the iframe lane supports live teardown.

  async function _revokeCheck() {
    let epoch;
    try {
      const h = await (await fetch('api/health', { cache: 'no-store' })).json();
      epoch = h && h.trustEpoch;
    } catch (_) { return; }
    if (typeof epoch !== 'number' || _trustEpoch === null || epoch === _trustEpoch) return;
    _trustEpoch = epoch;
    // Re-fetch the authoritative vouched set; anything sandboxed and no longer
    // vouched (revoked / made incompatible) is torn down.
    let vouched;
    try {
      const data = await (await fetch('api/plugins', { cache: 'no-store' })).json();
      vouched = new Set((data.plugins || []).map(p => p.id));
    } catch (_) { return; }
    for (const [id, entry] of _modules) {
      const sandboxed = typeof PluginSandbox !== 'undefined' && PluginSandbox.isSandboxed && PluginSandbox.isSandboxed(id);
      if (sandboxed && !vouched.has(id)) {
        try { PluginSandbox.kill(id, 'revoked'); } catch (_) {}
        _modules.delete(id);
        _quarantine(entry.meta._modPath || id, 'revoked', 'operator revoked approval (torn down live)');
        // Remove its toolbar button (action/toggle → data-plugin-id).
        document.querySelectorAll(`[data-plugin-id="${CSS.escape(id)}"]`).forEach(b => b.remove());
        console.info(`[PluginRegistry] sandboxed plugin "${id}" revoked — iframe torn down`);
      }
    }
  }

  /** Start watching for live approve/revoke (poll + on tab focus). Idempotent. */
  function startTrustWatch(intervalMs = 8000) {
    if (_trustWatchTimer || typeof PluginSandbox === 'undefined') return;
    _trustWatchTimer = setInterval(_revokeCheck, intervalMs);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) _revokeCheck(); });
  }

  // ─── Public API ───────────────────────────────────────────

  return {
    discover,
    loadModules,
    implement,
    initAll,
    activate,
    deactivate,
    getModule,
    getQuarantined,
    listByPlacement,
    listByGroup,
    buildToolbarButtons,
    getWorkspaceState,
    setWorkspaceState,
    bindToolbarButtons,
    disposeAll,
    startTrustWatch,
    on
  };
})();
