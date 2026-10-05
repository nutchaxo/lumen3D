/* Structure (DVR) Shader — index.js
   Selects render mode 0 of the volume ray-marcher (front-to-back emission and occlusion) through the
   viewer context, which is also what a sandboxed copy of the plugin receives. */
PluginRegistry.implement('structure-dvr', {
  init(ctx) { this._ctx = ctx; return this; },

  activate() {
    const viewer = this._ctx?.viewer;
    if (viewer && typeof viewer.setRenderMode === 'function') viewer.setRenderMode(0);
    else if (typeof VolumeViewer !== 'undefined') VolumeViewer.setRenderMode(0);
  },

  // Nothing to undo: the next shader's activate() sets its own mode.
  deactivate() {},

  dispose() { this._ctx = null; }
});
