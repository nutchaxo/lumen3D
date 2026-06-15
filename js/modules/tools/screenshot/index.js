/* Screenshot — index.js */
PluginRegistry.implement('screenshot', {
  _ctx: null,

  init(ctx) {
    this._ctx = ctx;
    return this;
  },

  async activate() {
    const ctx = this._ctx;
    if (!ctx) return;
    const blob = await ctx.getCanvasBlob({ mime: 'image/png', quality: 0.95 });
    if (!blob) return;
    const meta = ctx.dataset.getMeta();
    const name = meta ? meta.name : 'viewer';
    if (typeof ExportManager !== 'undefined') {
      ExportManager.downloadBlob(blob, `${name}_screenshot.png`);
    }
  },

  dispose() {}
});
