/* Presentation Mode — index.js */
PluginRegistry.implement('presentation-mode', {
  _active: false,

  init(ctx) {
    this._ctx = ctx;
    this._active = document.body.classList.contains('presentation-mode');
    return this;
  },

  activate() {
    this._active = !this._active;
    document.body.classList.toggle('presentation-mode', this._active);
    if (this._ctx?.ui?.scheduleResize) this._ctx.ui.scheduleResize();
    return { active: this._active };
  },

  getState() { return { presentationMode: this._active }; },

  setState(s) {
    if (typeof s?.presentationMode === 'boolean') {
      this._active = s.presentationMode;
      document.body.classList.toggle('presentation-mode', this._active);
      if (this._ctx?.ui?.scheduleResize) this._ctx.ui.scheduleResize();
    }
  },

  dispose() { this._active = false; }
});
