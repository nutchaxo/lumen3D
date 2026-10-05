/* Fluorescence (Imaris-like) Shader — index.js
   Selects render mode 1 of the volume ray-marcher (per-channel maximum-intensity projection) through the
   viewer context, which is also what a sandboxed copy of the plugin receives. */
PluginRegistry.implement('fluorescence', {
  init(ctx) { this._ctx = ctx; return this; },

  activate() {
    const viewer = this._ctx?.viewer;
    if (viewer && typeof viewer.setRenderMode === 'function') viewer.setRenderMode(1);
    else if (typeof VolumeViewer !== 'undefined') VolumeViewer.setRenderMode(1);
  },

  // Nothing to undo: the next shader's activate() sets its own mode.
  deactivate() {},

  dispose() { this._ctx = null; }
});
