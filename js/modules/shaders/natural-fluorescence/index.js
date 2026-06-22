/* Natural Fluorescence Shader — index.js
   Emission–absorption ray-march with chroma-locked highlight compression.
   The shader math lives in VolumeViewer (renderMode 2); this module just selects it. */
PluginRegistry.implement('natural-fluorescence', {
  init(ctx) { this._ctx = ctx; return this; },

  activate() {
    if (typeof VolumeViewer !== 'undefined') VolumeViewer.setRenderMode(2);
  },

  dispose() {}
});
