/* Structure (DVR) Shader — index.js */
PluginRegistry.implement('structure-dvr', {
  init(ctx) { this._ctx = ctx; return this; },

  activate() {
    if (typeof VolumeViewer !== 'undefined') VolumeViewer.setRenderMode(0);
  },

  dispose() {}
});
