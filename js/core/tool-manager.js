/* ============================================================
   IRIBHM Microscopy Platform — Tool Manager
   ============================================================ */

const ToolManager = (() => {
  let _activeTool = 'navigate';
  let _callbacks = {};
  // Keyboard shortcuts → tool name. 'navigate' is the built-in core tool; all
  // other tools declare their own shortcut in plugin.json (subtype:'tool'), so
  // adding/removing a tool plugin adds/removes its shortcut with no edit here.
  let _shortcuts = { v: 'navigate', escape: 'navigate' };

  /**
   * Register a tool's keyboard shortcut. Called for each discovered tool plugin
   * in init(); also exposed so a plugin can register one explicitly.
   */
  function registerTool(def) {
    if (def && def.name && def.shortcut) {
      _shortcuts[String(def.shortcut).toLowerCase()] = def.name;
    }
  }

  function init(options = {}) {
    _callbacks = options;
    // Pull shortcuts declared by tool-subtype plugins (data-driven autonomy).
    if (typeof PluginRegistry !== 'undefined' && PluginRegistry.listByPlacement) {
      PluginRegistry.listByPlacement('tools')
        .filter(m => m.subtype === 'tool' && m.shortcut)
        .forEach(m => registerTool({ name: m.tool || m.id, shortcut: m.shortcut }));
    }
    document.querySelectorAll('[data-tool]').forEach(button => {
      if (!button.disabled) {
        button.addEventListener('click', () => activate(button.dataset.tool));
      }
    });
    document.addEventListener('keydown', _handleShortcut);
    activate(options.defaultTool || 'navigate', { silent: true });
  }

  function activate(tool, options = {}) {
    if (!_isToolAvailable(tool)) return;
    _activeTool = tool || 'navigate';
    document.querySelectorAll('[data-tool]').forEach(button => {
      button.classList.toggle('active', button.dataset.tool === _activeTool);
    });
    document.body.dataset.activeTool = _activeTool;
    if (!options.silent) _callbacks.onChange?.(_activeTool);
  }

  function current() {
    return _activeTool;
  }

  function _handleShortcut(e) {
    if (e.target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;
    const tool = _shortcuts[e.key.toLowerCase()];
    if (tool) activate(tool);
  }

  function _isToolAvailable(tool) {
    if (!tool) return true;
    const button = document.querySelector(`[data-tool="${tool}"]`);
    return Boolean(button && !button.disabled);
  }

  return { init, activate, current, registerTool };
})();
