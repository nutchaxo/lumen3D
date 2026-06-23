/* Download Center — index.js */
PluginRegistry.implement('download-center', {
  _ctx: null,

  init(ctx) { this._ctx = ctx; return this; },

  activate() {
    if (typeof ExportManager === 'undefined' || !this._ctx) return;
    ExportManager.openDownloadCenter({
      dataset: this._ctx.dataset.getMeta(),
      scope: 'viewer',
      getCanvas: () => document.getElementById('webgl-canvas'),
      getCanvasBlob: this._ctx.getCanvasBlob,
      getCustomExports: this._ctx.getCustomExports,
      getWorkspaceState: this._ctx.workspace.getState,
      applyWorkspaceState: this._ctx.workspace.applyState,
      getMeasurements: () => this._ctx.measurements.list('viewer'),
      getAnnotations: () => (typeof AnnotationManager !== 'undefined' ? AnnotationManager.all() : [])
    });
  },

  dispose() {}
});
