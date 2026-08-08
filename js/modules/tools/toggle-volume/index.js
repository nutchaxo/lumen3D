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
      // The button advertises the ACTION, not the state: while the volume shows,
      // pressing it hides — hence 'eye-off' (the plugin.json default) on a visible
      // volume, and it reads as active only while the volume is hidden.
      PluginRegistry.syncToolbarButton('toggle-volume', {
        active: !this._visible,
        icon: this._visible ? 'eye-off' : 'eye'
      });
    }
  },

  reset() { this.setState({ volumeVisible: true }); },

  dispose() { this._visible = true; }
});
