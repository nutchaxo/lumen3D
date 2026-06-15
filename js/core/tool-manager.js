/* ============================================================
   IRIBHM Microscopy Platform — Tool Manager
   ============================================================ */

const ToolManager = (() => {
  let _activeTool = 'navigate';
  let _callbacks = {};

  function init(options = {}) {
    _callbacks = options;
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
    const key = e.key.toLowerCase();
    if (key === 'v') activate('navigate');
    if (key === 'c') activate('cut');
    if (key === 'm') activate('measure');
    if (key === 'escape') activate('navigate');
  }

  function _isToolAvailable(tool) {
    if (!tool) return true;
    const button = document.querySelector(`[data-tool="${tool}"]`);
    return Boolean(button && !button.disabled);
  }

  return { init, activate, current };
})();
