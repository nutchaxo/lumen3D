/* Toggle Volume Visibility — index.js */
PluginRegistry.implement('toggle-volume', {
  _visible: true,

  init(ctx) {
    this._ctx = ctx;
    this._visible = true;
    return this;
  },

  activate() {
    this._visible = !this._visible;
    if (typeof VolumeViewer !== 'undefined') VolumeViewer.setVolumeVisible(this._visible);
    return {
      active: !this._visible,
      icon: this._visible ? 'eye-off' : 'eye'
    };
  },

  getState() { return { volumeVisible: this._visible }; },

  setState(s) {
    if (typeof s?.volumeVisible === 'boolean') {
      this._visible = s.volumeVisible;
      if (typeof VolumeViewer !== 'undefined') VolumeViewer.setVolumeVisible(this._visible);
    }
  },

  dispose() { this._visible = true; }
});
