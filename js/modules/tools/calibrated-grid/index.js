/* Calibrated Grid — index.js
 *
 * A screen-aligned grid in physical units, anchored on the top-left corner of
 * the (oriented) photograph. The step is the 1-2-5 length nearest to a target
 * spacing, so the grid stays legible at every zoom; line labels give the
 * distance from the image corner. Display only — nothing reads it.
 */
PluginRegistry.implement('calibrated-grid', {
  _ctx: null,
  _mode: 0,               // 0 none, 1 coarse (~120 px), 2 fine (~60 px)
  _remove: null,

  init(ctx) {
    this._ctx = ctx;
    this._remove = ctx.viewer.addOverlay((c, h) => this._draw(c, h));
    return this;
  },

  activate() {
    this._mode = (this._mode + 1) % 3;
    this._ctx.viewer.redraw();
    return { active: this._mode > 0 };
  },

  getState() { return { gridMode: this._mode }; },

  setState(s) {
    if (typeof s?.gridMode !== 'number') return;
    this._mode = s.gridMode;
    PluginRegistry.syncToolbarButton('calibrated-grid', { active: this._mode > 0 });
    this._ctx.viewer.redraw();
  },

  reset() { this.setState({ gridMode: 0 }); },

  dispose() { this._remove?.(); this._mode = 0; },

  _draw(c, h) {
    if (!this._mode || !h.pixelSizeUm) return;
    const cssPerUm = h.scale / h.pixelSizeUm;
    const stepUm = h.niceLength((this._mode === 1 ? 120 : 60) / cssPerUm);
    const step = stepUm * cssPerUm;
    if (step < 6) return;
    const origin = h.orientedToCanvas(0, 0);
    const labelled = step >= 44;
    c.lineWidth = 1;
    c.strokeStyle = 'rgba(255, 255, 255, 0.28)';
    c.font = '10px "JetBrains Mono", monospace';
    c.textBaseline = 'top';
    c.textAlign = 'left';
    for (let k = Math.ceil(-origin.x / step); k <= Math.floor((h.width - origin.x) / step); k++) {
      const x = Math.round(origin.x + k * step) + 0.5;
      c.beginPath(); c.moveTo(x, 0); c.lineTo(x, h.height); c.stroke();
      if (labelled && k !== 0) this._tick(c, h.formatUm(k * stepUm), x + 3, 3);
    }
    for (let k = Math.ceil(-origin.y / step); k <= Math.floor((h.height - origin.y) / step); k++) {
      const y = Math.round(origin.y + k * step) + 0.5;
      c.beginPath(); c.moveTo(0, y); c.lineTo(h.width, y); c.stroke();
      if (labelled && k !== 0) this._tick(c, h.formatUm(k * stepUm), 3, y + 3);
    }
    h.label(`${this._ctx.i18n.t('step')} ${h.formatUm(stepUm)}`, h.width - 70, h.height - 22, '#fff', 11);
  },

  _tick(c, text, x, y) {
    c.fillStyle = 'rgba(0, 0, 0, 0.55)';
    const w = c.measureText(text).width + 6;
    c.fillRect(x - 2, y - 1, w, 13);
    c.fillStyle = 'rgba(255, 255, 255, 0.85)';
    c.fillText(text, x + 1, y);
  }
});
