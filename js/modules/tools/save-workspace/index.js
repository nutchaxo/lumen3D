/* Save Workspace — index.js */
PluginRegistry.implement('save-workspace', {
  init(ctx) { this._ctx = ctx; return this; },
  activate() {
    if (typeof ExportManager !== 'undefined') ExportManager.saveWorkspace('viewer');
  },
  dispose() {}
});
