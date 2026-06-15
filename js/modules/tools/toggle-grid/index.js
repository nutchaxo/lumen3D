/* Toggle Grid — index.js */
PluginRegistry.implement('toggle-grid', {
  _mode: 0,

  init(ctx) {
    this._ctx = ctx;
    this._mode = 0;
    return this;
  },

  activate() {
    this._mode = (this._mode + 1) % 3;
    if (typeof VolumeViewer !== 'undefined') {
      VolumeViewer.setGridMode(this._mode);
    }
    return { active: this._mode > 0 };
  },

  getState() { return { gridMode: this._mode }; },

  setState(s) {
    if (typeof s?.gridMode === 'number') {
      this._mode = s.gridMode;
      if (typeof VolumeViewer !== 'undefined') VolumeViewer.setGridMode(this._mode);
    }
  },

  dispose() { this._mode = 0; }
});
