/* Orientation 2D — index.js
 *
 * A photograph is taken in whatever pose the embryo settled in. This panel
 * rotates and mirrors it into the lab's convention (anterior up); the viewer
 * does the geometry (see Viewer2D.setOrientation), this plugin owns
 * the controls, the compass overlay and the admin handshake — the same
 * CALIBRATE_ORIENTATION_START / GET_ORIENTATION / ORIENTATION_RESULT messages
 * the 3D orientation plugin answers, with an `orientation2d` payload.
 */
PluginRegistry.implement('orientation-2d', {
  _ctx: null,
  _ui: null,
  _open: false,
  _unsubs: [],

  _t(key, params) { return this._ctx.i18n.t(key, params); },
  onLanguageChange() { this._ui?.rebuild(); },

  init(ctx) {
    this._ctx = ctx;
    this._ui = this._buildPanel();
    this._unsubs.push(ctx.viewer.addOverlay((c, h) => this._drawCompass(c, h)));
    this._unsubs.push(ctx.dataset.onChange(() => this._syncControls()));
    this._onMessage = (e) => this._handleMessage(e);
    window.addEventListener('message', this._onMessage);
    this._syncControls();
    return this;
  },

  activate() {
    this._setOpen(!this._open);
    return { active: this._open };
  },

  getState() { return { orientation: this._ctx.viewer.getOrientation(), open: this._open }; },

  setState(s) {
    if (s?.orientation) this._apply(s.orientation);
    if (typeof s?.open === 'boolean') this._setOpen(s.open);
  },

  reset() { this._apply({ rotationDeg: 0, flipH: false }); },

  dispose() {
    this._unsubs.forEach(fn => fn());
    this._unsubs = [];
    window.removeEventListener('message', this._onMessage);
    this._ui?.section.remove();
  },

  // ── Panel ─────────────────────────────────────────────────────────────────
  _buildPanel() {
    const { section, body } = this._ctx.ui.addSidebarSection({ id: 'orientation-2d-section', title: this._t('panel') });
    section.hidden = true;
    const ui = { section, body, rebuild: () => this._render(ui) };
    this._render(ui);
    return ui;
  },

  _render(ui) {
    const esc = s => this._ctx.ui.escapeHtml(s);
    ui.body.innerHTML = `
      <div class="p2d-plugin-row">
        <label for="o2d-rotation">${esc(this._t('rotation'))}</label>
        <input type="range" id="o2d-rotation" min="-180" max="180" step="1" value="0">
        <span class="p2d-plugin-value" id="o2d-rotation-value">0°</span>
      </div>
      <div class="p2d-plugin-actions">
        <button type="button" class="btn btn-outline btn-sm" data-o2d="left" title="${esc(this._t('rotateLeft'))}"><i data-lucide="rotate-ccw"></i> 90°</button>
        <button type="button" class="btn btn-outline btn-sm" data-o2d="right" title="${esc(this._t('rotateRight'))}"><i data-lucide="rotate-cw"></i> 90°</button>
        <button type="button" class="btn btn-outline btn-sm" data-o2d="flip" id="o2d-flip"><i data-lucide="flip-horizontal"></i> ${esc(this._t('mirror'))}</button>
        <button type="button" class="btn btn-ghost btn-sm" data-o2d="reset"><i data-lucide="undo-2"></i> ${esc(this._t('reset'))}</button>
      </div>
      <div class="p2d-plugin-hint">${esc(this._t('hint'))}</div>`;
    this._ctx.ui.createIcons({ nodes: [ui.body] });
    ui.slider = ui.body.querySelector('#o2d-rotation');
    ui.value = ui.body.querySelector('#o2d-rotation-value');
    ui.flip = ui.body.querySelector('#o2d-flip');
    ui.slider.addEventListener('input', () => this._apply({ ...this._ctx.viewer.getOrientation(), rotationDeg: Number(ui.slider.value) }));
    ui.body.addEventListener('click', (e) => {
      const action = e.target.closest('[data-o2d]')?.dataset.o2d;
      if (action) this._action(action);
    });
    this._syncControls();
  },

  _action(action) {
    const o = this._ctx.viewer.getOrientation();
    if (action === 'left') this._apply({ ...o, rotationDeg: o.rotationDeg - 90 });
    else if (action === 'right') this._apply({ ...o, rotationDeg: o.rotationDeg + 90 });
    else if (action === 'flip') this._apply({ ...o, flipH: !o.flipH });
    else if (action === 'reset') this.reset();
  },

  _apply(o) {
    this._ctx.viewer.setOrientation(o);
    this._syncControls();
  },

  _syncControls() {
    if (!this._ui?.slider) return;
    const o = this._ctx.viewer.getOrientation();
    this._ui.slider.value = o.rotationDeg;
    this._ui.value.textContent = `${o.rotationDeg}°${o.flipH ? ' ⇋' : ''}`;
    this._ui.flip.classList.toggle('btn-solid', o.flipH);
  },

  _setOpen(open) {
    this._open = open;
    this._ui.section.hidden = !open;
    PluginRegistry.syncToolbarButton('orientation-2d', { active: open });
    this._ctx.viewer.redraw();
  },

  // ── Compass overlay: the convention the operator is aiming for ────────────
  _drawCompass(c, h) {
    if (!this._open) return;
    const top = h.orientedToCanvas(h.oriented.w / 2, 0);
    const bottom = h.orientedToCanvas(h.oriented.w / 2, h.oriented.h);
    const color = '#7FFF00';
    c.strokeStyle = color;
    c.lineWidth = 2;
    c.setLineDash([6, 6]);
    c.beginPath();
    c.moveTo(top.x, top.y);
    c.lineTo(bottom.x, bottom.y);
    c.stroke();
    c.setLineDash([]);
    h.label(this._t('anterior'), top.x, Math.max(14, top.y - 14), color, 13);
    h.label(this._t('posterior'), bottom.x, Math.min(h.height - 14, bottom.y + 14), color, 13);
    h.label(`${h.orientation.rotationDeg}°${h.orientation.flipH ? ' ⇋' : ''}`, 60, 16, '#fff', 12);
  },

  // ── Admin handshake ───────────────────────────────────────────────────────
  _handleMessage(e) {
    if (!Utils.isTrustedMessageOrigin(e)) return;
    const type = e.data?.type;
    if (type === 'CALIBRATE_ORIENTATION_START') this._setOpen(true);
    else if (type === 'CALIBRATE_ORIENTATION_STOP') this._setOpen(false);
    else if (type === 'GET_ORIENTATION') {
      e.source?.postMessage({ type: 'ORIENTATION_RESULT', orientation2d: this._ctx.viewer.getOrientation() }, e.origin);
    }
  }
});
