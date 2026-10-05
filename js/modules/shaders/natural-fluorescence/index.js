/* Natural Fluorescence Shader — index.js
   Selects render mode 2 of the volume ray-marcher (emission-absorption with depth) through the
   viewer context, which is also what a sandboxed copy of the plugin receives. */
PluginRegistry.implement('natural-fluorescence', {
  init(ctx) { this._ctx = ctx; return this; },

  activate() {
    const viewer = this._ctx?.viewer;
    if (viewer && typeof viewer.setRenderMode === 'function') viewer.setRenderMode(2);
    else if (typeof VolumeViewer !== 'undefined') VolumeViewer.setRenderMode(2);
  },

  // Nothing to undo: the next shader's activate() sets its own mode.
  deactivate() {},

  dispose() { this._ctx = null; }
});
