/* Restore Workspace — index.js */
PluginRegistry.implement('restore-workspace', {
  init(ctx) { this._ctx = ctx; return this; },
  activate() {
    if (typeof ExportManager !== 'undefined') ExportManager.restoreWorkspace('viewer');
  },
  dispose() {}
});
