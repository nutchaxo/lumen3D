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

  // ─── Discovery ────────────────────────────────────────────

  // Crash-proof floor (rule 1.1): if both the live endpoint and the generated
  // manifest are unavailable, the viewer still boots with the core plugin set.
  // This is the ONLY place the built-in list is enumerated; it is intentionally
  // a safety net, not the source of truth — real discovery is folder-driven.
  const _DEFAULT_MODULE_PATHS = [
    'tools/toggle-grid', 'tools/toggle-axes', 'tools/orientation-axes', 'tools/toggle-volume',
    'tools/screenshot', 'tools/presentation-mode', 'tools/save-workspace',
    'tools/restore-workspace', 'tools/download-center', 'tools/decompose-channels',
    'tools/zstack-browser', 'tools/deepzoom-2d', 'tools/slice-inspector',
    'tools/measure-distance', 'shaders/natural-fluorescence', 'shaders/fluorescence', 'shaders/structure-dvr',
    'channels/histogram', 'channels/gaussian-filter'
  ];

  /**
   * Fetch a plugin list from one source and normalize it to an array of paths.
   * Returns null on any failure (network, non-OK, non-JSON such as raw PHP
   * served statically, or wrong shape) so the caller can fall through.
   */
  async function _fetchPluginList(url) {
    try {
      const resp = await fetch(url, { cache: 'no-store' });
      if (!resp.ok) return null;
      const data = await resp.json(); // throws on non-JSON body → caught below
      const plugins = Array.isArray(data) ? data : data?.plugins;
      if (!Array.isArray(plugins)) return null;
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
  async function loadModules(basePath, modulePaths) {
    const loadPromises = modulePaths.map(async (modPath) => {
      try {
        const jsonUrl = `${basePath}/${modPath}/plugin.json`;
        const resp = await fetch(jsonUrl);
        if (!resp.ok) {
          console.error(`[PluginRegistry] Failed to load ${jsonUrl}: ${resp.status}`);
          return;
        }
        const meta = await resp.json();

        // Validate placement matches directory
        const expectedPlacement = modPath.split('/')[0]; // 'tools', 'channels', 'shaders'
        if (meta.placement && meta.placement !== expectedPlacement) {
          console.error(`[PluginRegistry] Module "${meta.id}" declares placement="${meta.placement}" but is in "${expectedPlacement}/". Skipping.`);
          return;
        }
        meta.placement = meta.placement || expectedPlacement;
        meta._path = `${basePath}/${modPath}`;

        // Register metadata
        _modules.set(meta.id, {
          meta,
          impl: null,
          instance: null,
          state: 'registered'
        });

        // Pre-load this plugin's own translation dictionaries into the i18n
        // tree (plugins.<id>.*) BEFORE any UI is built, so toolbar labels and
        // runtime strings resolve on first paint. `i18nLanguages` (plugin.json)
        // lists the shipped locales; English is always loaded as the per-plugin
        // fallback (rule: a platform locale the plugin lacks → English).
        if (typeof I18n !== 'undefined' && I18n.loadPluginLang) {
          await I18n.loadPluginLang(meta.id, meta._path, meta.i18nLanguages);
        }

        // Inject <script> for index.js
        await _loadScript(`${basePath}/${modPath}/index.js`);

      } catch (err) {
        console.error(`[PluginRegistry] Error loading module "${modPath}":`, err);
      }
    });
    await Promise.all(loadPromises);
  }

  /**
   * Dynamically inject a <script> tag and wait for it to load.
   * @param {string} src
   * @returns {Promise<void>}
   */
  function _loadScript(src) {
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = src;
      script.onload = () => resolve();
      script.onerror = () => {
        console.error(`[PluginRegistry] Failed to load script: ${src}`);
        resolve(); // Don't break the chain — continue loading other modules
      };
      document.body.appendChild(script);
    });
  }

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
        console.warn(`[PluginRegistry] Module "${id}" has no implementation (index.js missing or failed to call implement).`);
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
        console.error(`[PluginRegistry] Failed to init module "${id}":`, err);
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
    if (!entry || !entry.impl || entry.state === 'disposed') return null;
    if (typeof entry.impl.activate === 'function') {
      const result = entry.impl.activate.call(entry.instance || entry.impl);
      entry.state = 'active';
      _emit('module-activated', { id, result });
      return result;
    }
    return null;
  }

  /**
   * Deactivate a module.
   */
  function deactivate(id) {
    const entry = _modules.get(id);
    if (!entry || !entry.impl) return;
    if (typeof entry.impl.deactivate === 'function') {
      entry.impl.deactivate.call(entry.instance || entry.impl);
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

  // ─── Public API ───────────────────────────────────────────

  return {
    discover,
    loadModules,
    implement,
    initAll,
    activate,
    deactivate,
    getModule,
    listByPlacement,
    listByGroup,
    buildToolbarButtons,
    getWorkspaceState,
    setWorkspaceState,
    bindToolbarButtons,
    disposeAll,
    on
  };
})();
