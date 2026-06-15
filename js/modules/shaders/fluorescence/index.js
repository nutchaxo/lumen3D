/* Fluorescence (Imaris-like) Shader — index.js */
PluginRegistry.implement('fluorescence', {
  init(ctx) { this._ctx = ctx; return this; },

  activate() {
    if (typeof VolumeViewer !== 'undefined') VolumeViewer.setRenderMode(1);
  },

  dispose() {}
});
