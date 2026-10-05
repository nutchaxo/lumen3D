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
    const fail = () => ctx.ui?.toast?.(ctx.i18n?.t?.('failed') ?? 'Screenshot failed');
    let blob = null;
    try {
      blob = await ctx.getCanvasBlob({ mime: 'image/png', quality: 0.95 });
    } catch (err) {
      console.warn('[screenshot] capture failed:', err);
    }
    if (!blob) { fail(); return; }
    const meta = ctx.dataset.getMeta();
    const name = String(meta?.name || 'viewer').replace(/[^\w.-]+/g, '_');
    if (typeof ExportManager !== 'undefined') {
      ExportManager.downloadBlob(blob, `${name}_screenshot.png`);
    }
  },

  dispose() {}
});
