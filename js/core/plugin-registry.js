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
          entry.instance = await entry.impl.init(_ctx);
        }
        entry.state = 'initialized';
      } catch (err) {
        console.error(`[PluginRegistry] Failed to init module "${id}":`, err);
      }
    }
    _emit('modules-initialized');
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
    loadModules,
    implement,
    initAll,
    activate,
    deactivate,
    getModule,
    listByPlacement,
    listByGroup,
    getWorkspaceState,
    setWorkspaceState,
    bindToolbarButtons,
    disposeAll,
    on
  };
})();
