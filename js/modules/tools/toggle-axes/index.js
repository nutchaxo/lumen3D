/* Toggle Axes — index.js */
PluginRegistry.implement('toggle-axes', {
  _visible: false,

  init(ctx) {
    this._ctx = ctx;
    this._visible = false;
    return this;
  },

  activate() {
    this._visible = !this._visible;
    if (typeof VolumeViewer !== 'undefined') VolumeViewer.setAxesVisible(this._visible);
    return { active: this._visible };
  },

  getState() { return { axesVisible: this._visible }; },

  setState(s) {
    if (typeof s?.axesVisible === 'boolean') {
      this._visible = s.axesVisible;
      if (typeof VolumeViewer !== 'undefined') VolumeViewer.setAxesVisible(this._visible);
    }
  },

  dispose() { this._visible = false; }
});
