/* Display Adjustments — index.js
 *
 * Display-only curves applied by Viewer2D.setAdjustments: nothing here
 * changes the photograph, the measurements or the stain isolation (which reads
 * the raw pixels). The panel is the single place the values are edited; the
 * viewer keeps the cache.
 */
PluginRegistry.implement('display-adjust', {
  _ctx: null,
  _ui: null,
  _open: false,

  CONTROLS: [
    { key: 'brightness', min: -100, max: 100, step: 1, unit: '' },
    { key: 'contrast', min: -100, max: 100, step: 1, unit: '' },
    { key: 'gamma', min: 0.3, max: 3, step: 0.05, unit: '' },
    { key: 'wbRed', min: 0.6, max: 1.6, step: 0.02, unit: '×' },
    { key: 'wbBlue', min: 0.6, max: 1.6, step: 0.02, unit: '×' }
  ],

  _t(key, params) { return this._ctx.i18n.t(key, params); },
  onLanguageChange() { this._render(); },

  init(ctx) {
    this._ctx = ctx;
    const { section, body } = ctx.ui.addSidebarSection({ id: 'display-adjust-section', title: this._t('panel') });
    section.hidden = true;
    this._ui = { section, body };
    this._render();
    return this;
  },

  activate() {
    this._open = !this._open;
    this._ui.section.hidden = !this._open;
    return { active: this._open };
  },

  getState() { return { adjustments: this._ctx.viewer.getAdjustments(), open: this._open }; },

  setState(s) {
    if (s?.adjustments) { this._ctx.viewer.setAdjustments(s.adjustments); this._sync(); }
    if (typeof s?.open === 'boolean') {
      this._open = s.open;
      this._ui.section.hidden = !s.open;
      PluginRegistry.syncToolbarButton('display-adjust', { active: s.open });
    }
  },

  reset() {
    this._ctx.viewer.setAdjustments({ brightness: 0, contrast: 0, gamma: 1, wbRed: 1, wbBlue: 1, flatten: false });
    this._sync();
  },

  dispose() { this._ui?.section.remove(); },

  _render() {
    const esc = s => this._ctx.ui.escapeHtml(s);
    const rows = this.CONTROLS.map(c => `
      <div class="p2d-plugin-row">
        <label for="adj-${c.key}">${esc(this._t(c.key))}</label>
        <input type="range" id="adj-${c.key}" data-adj="${c.key}" min="${c.min}" max="${c.max}" step="${c.step}">
        <span class="p2d-plugin-value" data-adj-value="${c.key}"></span>
      </div>`).join('');
    this._ui.body.innerHTML = `${rows}
      <label class="p2d-check"><input type="checkbox" id="adj-flatten"> ${esc(this._t('flatten'))}</label>
      <div class="p2d-plugin-hint">${esc(this._t('hint'))}</div>
      <div class="p2d-plugin-actions">
        <button type="button" class="btn btn-ghost btn-sm" id="adj-reset"><i data-lucide="undo-2"></i> ${esc(this._t('reset'))}</button>
      </div>`;
    this._ctx.ui.createIcons({ nodes: [this._ui.body] });
    this._ui.body.querySelectorAll('[data-adj]').forEach(input => {
      input.addEventListener('input', () => this._ctx.viewer.setAdjustments({ [input.dataset.adj]: Number(input.value) }) || this._sync());
    });
    this._ui.body.querySelector('#adj-flatten').addEventListener('change', (e) => this._ctx.viewer.setAdjustments({ flatten: e.target.checked }));
    this._ui.body.querySelector('#adj-reset').addEventListener('click', () => this.reset());
    this._sync();
  },

  _sync() {
    const a = this._ctx.viewer.getAdjustments();
    for (const c of this.CONTROLS) {
      const input = this._ui.body.querySelector(`[data-adj="${c.key}"]`);
      const out = this._ui.body.querySelector(`[data-adj-value="${c.key}"]`);
      if (!input) continue;
      input.value = a[c.key];
      out.textContent = `${c.step < 1 ? a[c.key].toFixed(2) : a[c.key]}${c.unit}`;
    }
    const flatten = this._ui.body.querySelector('#adj-flatten');
    if (flatten) flatten.checked = Boolean(a.flatten);
  }
});
