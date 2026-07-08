/* ============================================================
   IRIBHM Microscopy Platform — Plugin Sandbox (host side)
   ============================================================
   Runs an APPROVED-SANDBOXED (or untrusted-but-wanted) plugin's
   index.js inside a null-origin <iframe sandbox="allow-scripts">
   — no parent DOM, no cookies, no localStorage, no credentialed
   same-origin fetch to /api/auth.php, no network at all
   (internal CSP connect-src 'none'). The plugin never receives the
   ViewerContext; it talks to the host ONLY through a narrow,
   capability-scoped postMessage RPC that the host brokers and
   validates. This is the defense-in-depth lane for code the
   operator does not fully trust.

   Security invariants (see DOCS/plugin-sandbox/SPEC.md):
     INV-6  frame has no DOM/cookies/network (sandbox attrs + CSP)
     INV-7  RPC auth = window IDENTITY (event.source), not origin
     INV-8  host→frame is targeted; a per-type key whitelist; no secrets
     INV-9  payloads never pollute the host realm (destructure, freeze)
     INV-10 rate-limit + heartbeat + abuse-kill (no 60fps stall / DoS)
     INV-11 downloads require a real click (gesture gate)
     INV-12 the RPC bus is namespaced ('lumen-plugin'), never SYNC_*
   ============================================================ */

const PluginSandbox = (() => {
  const NS = 'lumen-plugin';
  const PROTO_V = 1;
  const SPAWN_TIMEOUT = 10000;
  const REQ_TIMEOUT = 8000;
  const HEARTBEAT_MS = 1500;
  const MAX_MISSED_PONGS = 3;
  const RATE_CAP = 40;            // token bucket burst
  const RATE_REFILL_PER_S = 20;
  const ABUSE_LIMIT = 50;        // malformed/forbidden within ABUSE_WINDOW → kill
  const ABUSE_WINDOW_MS = 10000;
  const GESTURE_WINDOW_MS = 1500;
  const MAX_TOAST = 200;
  const MAX_DOWNLOAD_BYTES = 32 * 1024 * 1024;
  const DOWNLOAD_MIME = new Set(['image/png', 'image/jpeg', 'application/json', 'text/csv', 'text/plain']);
  const EVENT_TOPICS = new Set(['render', 'channels-updated', 'camera']);

  // Per-page CSP nonce (L9): sourced from THIS script tag's own .nonce, captured
  // synchronously at load (document.currentScript valid only during initial run).
  // The srcdoc frame inherits the parent CSP, so its inline bootstrap must carry the
  // PAGE nonce. Nonce-hiding keeps the .nonce IDL property but clears the DOM
  // attribute → not exfiltrable via a CSS attribute-selector, unlike a <meta content>.
  const _PAGE_NONCE = (() => {
    try {
      const s = document.currentScript;
      const n = s && s.nonce;
      return n && n !== '{{CSP_NONCE}}' ? n : null;
    } catch (_) { return null; }
  })();

  const _hosts = new Map();   // Window → entry   (INV-7 primary authenticator)
  const _byId = new Map();    // pluginId → entry
  let _hostCtx = null;        // capability target, installed by bindContext()
  let _hostContainer = null;
  let _listenerBound = false;
  let _hbTimer = null;
  let _now = () => (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();

  // ── srcdoc: internal CSP (first) + host bootstrap + plugin code ─────────────
  function _buildSrcdoc(code, nonce, token, pluginId) {
    // default-src 'none' + explicit worker/child/frame/connect 'none': the frame
    // cannot reach the network (no exfil) or spawn workers/frames to busy-loop.
    const csp = "default-src 'none'; script-src 'nonce-" + nonce + "'; " +
                "connect-src 'none'; img-src 'none'; style-src 'none'; font-src 'none'; " +
                "media-src 'none'; child-src 'none'; worker-src 'none'; frame-src 'none'; " +
                "object-src 'none'; base-uri 'none'";
    // The plugin code runs verbatim inside the frame but only ever sees window.LumenPlugin.
    // </script> inside plugin code can't break out (CSP blocks any non-nonce script),
    // but we still guard the closing tag so a literal doesn't truncate our document.
    // Match the HTML spec's script-data end-tag (name + whitespace/'/'/'>' ), not
    // just the literal — so "</script >", "</script\n>", "</script/>" can't truncate
    // our document (defense in depth; the frame's strict CSP already contains impact).
    const safeCode = String(code).replace(/<\/script([\s/>])/gi, '<\\/script$1');
    return '<!DOCTYPE html><html><head><meta charset="utf-8">'
      + '<meta http-equiv="Content-Security-Policy" content="' + csp + '">'
      + '<script nonce="' + nonce + '">' + _bootstrapSource(token, pluginId) + '<\/script>'
      + '<script nonce="' + nonce + '">' + safeCode + '<\/script>'
      + '</head><body></body></html>';
  }

  // Runs INSIDE the frame. Authored by the host (trusted); wraps the plugin in the
  // LumenPlugin SDK and mediates all host communication. Serialized to a string;
  // TOKEN and PLUGIN_ID are injected as JSON literals (never read from the DOM).
  function _bootstrapSource(token, pluginId) {
    return '(' + function (TOKEN, PLUGIN_ID) {
      'use strict';
      var NS = 'lumen-plugin', V = 1, seq = 1, pending = {}, impl = null, dict = {}, subs = {};
      function post(dir, type, payload, id, extra) {
        var env = { ns: NS, v: V, dir: dir, id: id != null ? id : seq++, plugin: PLUGIN_ID,
                    token: TOKEN, type: type };
        if (payload !== undefined) env.payload = payload;
        if (extra) { for (var k in extra) env[k] = extra[k]; }
        parent.postMessage(env, '*');
        return env.id;
      }
      function request(type, payload) {
        return new Promise(function (resolve, reject) {
          var id = post('req', type, payload);
          pending[id] = { resolve: resolve, reject: reject };
        });
      }
      window.LumenPlugin = {
        register: function (i) { impl = i; },
        addButton: function (spec) { post('sys', 'declare-button', { label: String(spec && spec.label || ''),
                                        icon: String(spec && spec.icon || 'square') }); return 'btn'; },
        toast: function (m) { return request('ui.toast', { message: String(m) }); },
        download: function (filename, mime, data) { return request('ui.download', {
          filename: String(filename), mime: String(mime), dataB64: _b64(data) }); },
        getCanvasBlob: function (o) { return request('viewer.getCanvasBlob', o || {})
          .then(function (r) { return _unb64(r.dataB64); }); },
        getInfo: function () { return request('viewer.getInfo', {}); },
        setRenderMode: function (mode) { return request('viewer.setRenderMode', { mode: String(mode) }); },
        getChannels: function () { return request('channels.getState', {}); },
        on: function (topic, cb) { (subs[topic] = subs[topic] || []).push(cb); post('sys', 'subscribe', { topic: String(topic) }); },
        off: function (topic, cb) { if (subs[topic]) subs[topic] = subs[topic].filter(function (f) { return f !== cb; }); },
        saveState: function (s) { post('sys', 'state', s); },   // pushed to the host cache for workspace save
        t: function (k) { return (dict && dict[k]) || k; }
      };
      function _b64(data) {
        if (data == null) return '';
        if (typeof data === 'string') return btoa(unescape(encodeURIComponent(data)));
        var u = data instanceof Uint8Array ? data : new Uint8Array(data), s = '';
        for (var i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
        return btoa(s);
      }
      function _unb64(b) { var s = atob(b || ''), u = new Uint8Array(s.length);
        for (var i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u; }
      window.addEventListener('message', function (e) {
        if (e.source !== parent) return;               // only the host
        var env = e.data;
        if (!env || env.ns !== NS || env.v !== V || env.token !== TOKEN) return;
        if (env.dir === 'res') {
          var p = pending[env.id]; if (!p) return; delete pending[env.id];
          if (env.ok === false) p.reject(env.error || { code: 'error' }); else p.resolve(env.payload);
          return;
        }
        if (env.dir === 'evt') {
          var list = subs[env.type] || []; for (var i = 0; i < list.length; i++) { try { list[i](env.payload); } catch (_) {} }
          return;
        }
        if (env.dir === 'sys') {
          if (env.type === 'ping') { post('sys', 'pong', undefined, env.id); return; }
          if (env.type === 'init') {
            dict = (env.payload && env.payload.i18n) || {};
            Promise.resolve(impl && impl.init && impl.init()).then(function () {
              post('sys', 'init-done'); }).catch(function () { post('sys', 'init-done'); });
            return;
          }
          if (env.type === 'activate') {
            Promise.resolve(impl && impl.activate && impl.activate()).then(function (r) {
              post('sys', 'button-state', r || {}); }).catch(function () {});  // sys → host _handleSys
            return;
          }
          if (env.type === 'deactivate') { try { impl && impl.deactivate && impl.deactivate(); } catch (_) {} return; }
          if (env.type === 'set-state') { try { impl && impl.setState && impl.setState(env.payload); } catch (_) {} return; }
          if (env.type === 'i18n') { dict = env.payload || {}; return; }
          if (env.type === 'teardown') { try { impl && impl.dispose && impl.dispose(); } catch (_) {} return; }
        }
      });
      post('sys', 'ready', { sdk: 1 });
    }.toString() + ')(' + JSON.stringify(token) + ',' + JSON.stringify(pluginId) + ');';
  }

  // ── Host-side RPC ───────────────────────────────────────────────────────────
  function _send(entry, dir, type, payload, id, extra) {
    if (!entry || !entry.win) return;
    const env = { ns: NS, v: PROTO_V, dir, id: id != null ? id : 0, plugin: entry.meta.id,
                  token: entry.token, type };
    if (payload !== undefined) env.payload = payload;
    if (extra) Object.assign(env, extra);
    try { entry.win.postMessage(env, '*'); } catch (_) { /* frame gone */ }
  }

  function _abuse(entry) {
    const t = _now();
    if (t - entry.abuseAt > ABUSE_WINDOW_MS) { entry.abuseAt = t; entry.abuseCount = 0; }
    if (++entry.abuseCount > ABUSE_LIMIT) kill(entry.meta.id, 'abuse');
  }

  function _rateOk(entry) {
    const t = _now();
    entry.tokens = Math.min(RATE_CAP, entry.tokens + (t - entry.tokenAt) / 1000 * RATE_REFILL_PER_S);
    entry.tokenAt = t;
    if (entry.tokens < 1) return false;
    entry.tokens -= 1;
    return true;
  }

  function _onMessage(event) {
    const env = event.data;
    // (0) namespace discriminant FIRST — never confuse with SYNC_* (INV-12).
    if (!env || env.ns !== NS || env.v !== PROTO_V) return;
    // (a) source identity is the PRIMARY authenticator (INV-7), O(1).
    const entry = _hosts.get(event.source);
    if (!entry) return;
    // (b) origin is a secondary filter; a sandboxed srcdoc frame is 'null'.
    if (event.origin !== 'null') return;
    // (c) shape + membership + per-frame token (3rd factor).
    if (typeof env.id !== 'number' || env.plugin !== entry.meta.id ||
        typeof env.type !== 'string' || env.token !== entry.token) { _abuse(entry); return; }

    // Back-pressure on EVERY inbound message — sys included (INV-10). A valid-envelope
    // flood (e.g. 'pong'/'subscribe' in a loop) must not saturate the host main thread
    // and stall the 60fps render; sustained flooding trips _abuse → kill.
    if (!_rateOk(entry)) {
      _abuse(entry);
      if (env.dir === 'req') _send(entry, 'res', env.type, undefined, env.id, { ok: false, error: { code: 'busy' } });
      return;
    }

    if (env.dir === 'req') {
      if (!entry.allowedReq.has(env.type)) {
        _send(entry, 'res', env.type, undefined, env.id, { ok: false, error: { code: 'forbidden' } });
        _abuse(entry); return;
      }
      _handleReq(entry, env);
    } else if (env.dir === 'sys') {
      _handleSys(entry, env);
    }
  }

  function _resolveSpawn(entry, ok, err) {
    if (!entry._spawn) return;
    const s = entry._spawn; entry._spawn = null;
    clearTimeout(s.timer);
    ok ? s.resolve() : s.reject(err || new Error('spawn failed'));
  }

  function _handleSys(entry, env) {
    switch (env.type) {
      case 'ready':
        // Frame is up — send init (public dataset info + i18n only; NO secrets).
        _send(entry, 'sys', 'init', { meta: { id: entry.meta.id }, i18n: entry.i18n });
        break;
      case 'init-done':
        _resolveSpawn(entry, true);
        break;
      case 'declare-button':
        // textContent-only label + allowlisted icon (INV-8/9) — captured into meta.
        entry.button = { label: String(env.payload && env.payload.label || entry.meta.name || entry.meta.id).slice(0, 64),
                         icon: String(env.payload && env.payload.icon || entry.meta.icon || 'square').slice(0, 40) };
        break;
      case 'button-state':
        entry.lastToggle = _plainToggle(env.payload);
        _applyButtonState(entry);   // L5: drive the toolbar button from the real result
        break;
      case 'state':
        // Workspace state pushed by the plugin — cached (opaque, by value; already
        // a structured-clone with no functions) for getWorkspaceState() to read.
        entry.cachedState = env.payload;
        break;
      case 'subscribe':
        _subscribe(entry, String(env.payload && env.payload.topic || ''));
        break;
      case 'pong':
        entry.missedPongs = 0;
        break;
    }
  }

  function _plainToggle(p) {
    return { active: !!(p && p.active), icon: p && typeof p.icon === 'string' ? p.icon.slice(0, 40) : undefined };
  }

  // ── Capability broker — every call is validated and mapped to moduleCtx ──────
  function _handleReq(entry, env) {
    const type = env.type;
    const p = env.payload || {};
    const ok = (payload) => _send(entry, 'res', type, payload, env.id, { ok: true });
    const fail = (code) => _send(entry, 'res', type, undefined, env.id, { ok: false, error: { code } });
    if (!_hostCtx) { fail('not-ready'); return; }
    try {
      switch (type) {
        case 'ui.toast': {
          const msg = String(p.message == null ? '' : p.message).slice(0, MAX_TOAST);
          _hostCtx.ui && _hostCtx.ui.toast && _hostCtx.ui.toast(msg);
          ok({});
          break;
        }
        case 'ui.download': {
          // INV-11: only within the gesture window opened by a real toolbar click.
          if (_now() - entry.lastActivateAt > GESTURE_WINDOW_MS || entry.downloadUsed) { fail('no-gesture'); break; }
          const filename = String(p.filename == null ? 'download' : p.filename).slice(0, 128).replace(/[\\/:*?"<>|\x00-\x1f]/g, '_');
          const mime = String(p.mime || '');
          if (!DOWNLOAD_MIME.has(mime)) { fail('bad-mime'); break; }
          const bytes = _fromB64(p.dataB64);
          if (!bytes || bytes.length > MAX_DOWNLOAD_BYTES) { fail('too-large'); break; }
          entry.downloadUsed = true;
          _hostCtx.ui && _hostCtx.ui.downloadBlob
            ? _hostCtx.ui.downloadBlob(new Blob([bytes], { type: mime }), filename)
            : _fallbackDownload(new Blob([bytes], { type: mime }), filename);
          ok({});
          break;
        }
        case 'viewer.getInfo': {
          ok(_projectInfo());
          break;
        }
        case 'viewer.getCanvasBlob': {
          if (entry.canvasInFlight) { fail('busy'); break; }
          const g = _hostCtx.getCanvasBlob;
          if (!g) { fail('unsupported'); break; }
          entry.canvasInFlight = true;
          Promise.resolve(g({ mime: p.mime === 'image/jpeg' ? 'image/jpeg' : 'image/png',
                              quality: typeof p.quality === 'number' ? p.quality : 0.95 }))
            .then((blob) => blob ? _blobToB64(blob) : null)
            .then((b64) => { entry.canvasInFlight = false; b64 ? ok({ dataB64: b64 }) : fail('internal'); })
            .catch(() => { entry.canvasInFlight = false; fail('internal'); });
          break;
        }
        case 'viewer.setRenderMode': {
          const mode = String(p.mode || '');
          const known = (_hostCtx.viewer && _hostCtx.viewer.renderModes && _hostCtx.viewer.renderModes()) || [];
          if (known.length && known.indexOf(mode) < 0) { fail('unknown-mode'); break; }
          _hostCtx.viewer && _hostCtx.viewer.setRenderMode && _hostCtx.viewer.setRenderMode(mode);
          ok({});
          break;
        }
        case 'channels.getState': {
          ok(_projectChannels());
          break;
        }
        default:
          fail('forbidden');
      }
    } catch (_) {
      fail('internal');
    }
  }

  // Whitelisted read projections — a fresh plain object, never a live THREE object
  // or the raw ctx return (which could carry callbacks/DOM → clone error / leak).
  function _projectInfo() {
    const ds = (_hostCtx.dataset && _hostCtx.dataset.meta && _hostCtx.dataset.meta()) || {};
    return {
      datasetId: String(ds.id || ''), name: String(ds.name || ''),
      dims: Array.isArray(ds.dimensions) ? ds.dimensions.map(Number) : null,
      voxelSize: Array.isArray(ds.voxelSize) ? ds.voxelSize.map(Number) : null,
      channelCount: Number(ds.channelCount || (Array.isArray(ds.channels) ? ds.channels.length : 0)) || 0,
    };
  }
  function _projectChannels() {
    const g = _hostCtx.channels && _hostCtx.channels.getState;
    const raw = g ? g() : [];
    return (Array.isArray(raw) ? raw : []).map((c, i) => ({
      index: i, color: String(c && c.color || ''), gamma: Number(c && c.gamma) || 1,
      min: Number(c && c.min) || 0, max: Number(c && c.max) || 1, visible: !!(c && c.enabled),
    }));
  }

  // ── Events: real host listeners registered once; targeted fan-out, projected ──
  function _subscribe(entry, topic) {
    if (!EVENT_TOPICS.has(topic) || !entry.allowedReq.has('events.subscribe')) return;
    entry.subscribed.add(topic);
  }
  function emit(topic, payload) {
    if (!EVENT_TOPICS.has(topic)) return;
    const safe = _projectEvent(topic, payload);
    for (const entry of _hosts.values()) {
      if (entry.subscribed.has(topic)) _send(entry, 'evt', topic, safe);
    }
  }
  function _projectEvent(topic, p) {
    if (topic === 'camera' && p) return { position: (p.position || []).map(Number), target: (p.target || []).map(Number) };
    if (topic === 'channels-updated') return _projectChannels();
    return {};  // 'render' carries no payload
  }

  // ── Spawn / lifecycle ───────────────────────────────────────────────────────
  async function spawn(meta, expectedHash, caps, code) {
    // The registry already verified (INV-2) that `code` is the exact index.js bytes
    // whose composite hash == the operator-approved hash. `caps` were intersected
    // server-side (declared ∩ approved ∩ allowlist), so they are safe to grant here.
    if (!_hostContainer) {
      _hostContainer = document.createElement('div');
      _hostContainer.id = 'plugin-sandbox-hosts';
      _hostContainer.style.cssText = 'position:fixed;width:0;height:0;border:0;visibility:hidden;pointer-events:none;left:-9999px';
      document.body.appendChild(_hostContainer);
    }
    if (!_listenerBound) { window.addEventListener('message', _onMessage); _listenerBound = true; _startHeartbeat(); }

    // The srcdoc frame INHERITS the parent page's CSP (about:srcdoc is a local
    // scheme), and CSP is conjunctive — the frame's inline scripts must satisfy BOTH
    // the frame's own meta-CSP AND the inherited parent script-src. So they must
    // carry the PAGE nonce, not a fresh one. `token` stays random (RPC auth factor).
    // Fallback to random only on a host with no CSP header (nonce is inert there).
    const nonce = _PAGE_NONCE || _rand(16);
    const token = _rand(24);
    const iframe = document.createElement('iframe');
    iframe.setAttribute('sandbox', 'allow-scripts');   // NEVER allow-same-origin (INV-6)
    iframe.setAttribute('referrerpolicy', 'no-referrer');
    iframe.srcdoc = _buildSrcdoc(code, nonce, token, meta.id);

    const entry = {
      meta, frame: iframe, win: null, token,
      caps: new Set(caps || []),
      allowedReq: new Set(caps || []),
      i18n: (meta.i18n && (meta.i18n[_lang()] || meta.i18n.en)) || {},
      subscribed: new Set(), button: null, lastToggle: { active: false },
      // -Infinity, NOT 0: early in page life _now() is small, and 0 would fall
      // INSIDE the gesture window → a download with no activation (real hole).
      lastActivateAt: -Infinity, downloadUsed: false, canvasInFlight: false,
      tokens: RATE_CAP, tokenAt: _now(), abuseCount: 0, abuseAt: _now(), missedPongs: 0,
      _spawn: null,
    };
    _byId.set(meta.id, entry);
    _hostContainer.appendChild(iframe);
    entry.win = iframe.contentWindow;                   // capture identity immediately (INV-7)
    _hosts.set(entry.win, entry);

    await new Promise((resolve, reject) => {
      entry._spawn = { resolve, reject, timer: setTimeout(() => {
        // Tear the frame DOWN before rejecting — otherwise a plugin that sends 'ready'
        // but never 'init-done' leaves a live, capability-holding zombie iframe in
        // _hosts (the registry only quarantines; it wouldn't detach the frame).
        entry._spawn = null;               // prevent kill()'s own reject branch (settle once)
        kill(meta.id, 'spawn-timeout');    // removes _hosts/_byId + detaches the iframe
        reject(new Error('spawn-timeout'));
      }, SPAWN_TIMEOUT) };
    });

    // Expose the declared button through the normal toolbar meta path.
    if (entry.button) { meta.icon = entry.button.icon; meta._sandboxLabel = entry.button.label; }
    return _makeShim(entry);
  }

  function _makeShim(entry) {
    return {
      init() { return this; },                          // real init already ran in-frame
      activate() { entry.lastActivateAt = _now(); entry.downloadUsed = false;
                   _send(entry, 'sys', 'activate'); return entry.lastToggle; },
      deactivate() { _send(entry, 'sys', 'deactivate'); },
      // Workspace state is bridged: the plugin pushes state via LumenPlugin.saveState
      // (cached in entry.cachedState, read here on save); restore forwards it back.
      getState() { return entry.cachedState; },
      setState(s) { entry.cachedState = s; _send(entry, 'sys', 'set-state', s); },
      dispose() { kill(entry.meta.id, 'dispose'); },
      onLanguageChange() { entry.i18n = (entry.meta.i18n && (entry.meta.i18n[_lang()] || entry.meta.i18n.en)) || {};
                           _send(entry, 'sys', 'i18n', entry.i18n); },
    };
  }

  // L5: drive the toolbar button visual state from the plugin's REAL toggle result
  // (arrives async via 'button-state'), not the stale synchronous shim return.
  function _applyButtonState(entry) {
    const t = entry.lastToggle || {};
    const btn = document.querySelector(`[data-plugin-id="${(window.CSS && CSS.escape) ? CSS.escape(entry.meta.id) : entry.meta.id}"]`);
    if (!btn) return;
    btn.classList.toggle('btn-solid', !!t.active);
    btn.classList.toggle('btn-ghost', !t.active);
    if (t.icon) {
      const iconEl = btn.querySelector('i[data-lucide]');
      if (iconEl) { iconEl.setAttribute('data-lucide', t.icon); if (window.lucide) lucide.createIcons({ nodes: [btn] }); }
    }
  }

  /** Install the real capability target once the ViewerContext exists (after the
      volume loads). Requests arriving before this get {code:'not-ready'} + retry. */
  function bindContext(ctx) { _hostCtx = ctx; }

  function kill(pluginId, reason) {
    const entry = _byId.get(pluginId);
    if (!entry) return;
    _send(entry, 'sys', 'teardown');
    // Remove identity entries BEFORE detaching (in-flight messages → unknown source).
    if (entry.win) _hosts.delete(entry.win);
    _byId.delete(pluginId);
    if (entry._spawn) { clearTimeout(entry._spawn.timer); entry._spawn.reject(new Error('killed:' + reason)); entry._spawn = null; }
    try { entry.frame.remove(); } catch (_) {}
  }
  function killAll() { for (const id of Array.from(_byId.keys())) kill(id, 'killAll');
    if (_listenerBound) { window.removeEventListener('message', _onMessage); _listenerBound = false; }
    if (_hbTimer) { clearInterval(_hbTimer); _hbTimer = null; } }

  function isSandboxed(pluginId) { return _byId.has(pluginId); }

  function _startHeartbeat() {
    if (_hbTimer) return;
    _hbTimer = setInterval(() => {
      for (const entry of _hosts.values()) {
        if (++entry.missedPongs > MAX_MISSED_PONGS) { kill(entry.meta.id, 'heartbeat'); continue; }
        _send(entry, 'sys', 'ping');
      }
    }, HEARTBEAT_MS);
  }

  // ── helpers ─────────────────────────────────────────────────────────────────
  function _rand(n) {
    // Must be a CSPRNG — the token is a per-frame auth factor (INV-7). Call with the
    // correct receiver (crypto), never an unbound reference (throws in some engines)
    // and never a zero-filled fallback (a predictable token would be a real hole).
    const a = new Uint8Array(n);
    crypto.getRandomValues(a);
    let s = '';
    for (let i = 0; i < a.length; i++) s += a[i].toString(16).padStart(2, '0');
    return s;
  }
  function _lang() { try { return (typeof I18n !== 'undefined' && I18n.getLanguage) ? I18n.getLanguage() : 'en'; } catch (_) { return 'en'; } }
  function _fromB64(b64) { try { const s = atob(String(b64 || '')); const u = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u; } catch (_) { return null; } }
  function _blobToB64(blob) { return new Promise((res, rej) => { const r = new FileReader();
    r.onload = () => res(String(r.result).split(',')[1] || ''); r.onerror = rej; r.readAsDataURL(blob); }); }
  function _fallbackDownload(blob, name) {
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 0);
  }

  return { spawn, bindContext, kill, killAll, isSandboxed, emit };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = PluginSandbox;
