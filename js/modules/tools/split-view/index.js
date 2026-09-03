/* Split View — index.js
 *
 * The second photograph is this same page in an iframe (?panelIndex=1). The two
 * sides exchange PHYSICAL views — µm per screen pixel and the physical offset
 * of the screen centre from the photograph's centre — so two embryos taken at
 * different zooms sit at the same magnification, and a pan on either side
 * moves both by the same distance. The page suppresses the echo of a view it
 * was given; this plugin does the same on the host side.
 */
PluginRegistry.implement('split-view', {
  _ctx: null,
  _ui: null,
  _pane: null,
  _frame: null,
  _targetId: null,
  _link: true,
  _suppress: false,
  _unsubs: [],

  _t(key, params) { return this._ctx.i18n.t(key, params); },
  onLanguageChange() { this._render(); },

  init(ctx) {
    this._ctx = ctx;
    const { section, body } = ctx.ui.addSidebarSection({ id: 'split-view-section', title: this._t('panel') });
    section.hidden = true;
    this._ui = { section, body };
    this._render();
    this._onMessage = (e) => this._handleMessage(e);
    window.addEventListener('message', this._onMessage);
    this._unsubs.push(ctx.viewer.onViewChange(() => this._pushView()));
    this._unsubs.push(ctx.dataset.onChange(() => this._render()));
    return this;
  },

  activate() {
    if (this._pane) this._close();
    else this._openPane(this._targetId || this._defaultTarget()?.id);
    return { active: Boolean(this._pane) };
  },

  getState() { return { open: Boolean(this._pane), targetId: this._targetId, link: this._link }; },

  setState(s) {
    if (!s) return;
    if (typeof s.link === 'boolean') this._link = s.link;
    if (s.open && s.targetId) this._openPane(s.targetId);
    else if (s.open === false) this._close();
    PluginRegistry.syncToolbarButton('split-view', { active: Boolean(this._pane) });
    this._render();
  },

  reset() { this._close(); },

  dispose() {
    this._close();
    this._unsubs.forEach(fn => fn());
    window.removeEventListener('message', this._onMessage);
    this._ui?.section.remove();
  },

  // ── Pane ──────────────────────────────────────────────────────────────────
  _defaultTarget() {
    const list = this._ctx.dataset.getCollection();
    const idx = list.findIndex(d => d.id === this._ctx.dataset.getId());
    return list.length > 1 ? list[(idx + 1) % list.length] : null;
  },

  _openPane(targetId) {
    const target = targetId && this._ctx.dataset.getCollection().find(d => d.id === targetId);
    if (!target) return;
    this._targetId = target.id;
    if (!this._pane) {
      this._frame = document.createElement('iframe');
      this._frame.title = this._t('paneTitle');
      this._frame.addEventListener('load', () => this._pushView(true));
      const tag = document.createElement('span');
      tag.className = 'wm-split-tag';
      this._pane = document.createElement('div');
      this._pane.className = 'wm-split-pane';
      this._pane.append(this._frame, tag);
      const stage = this._ctx.ui.getStage();
      stage.parentElement.insertBefore(this._pane, stage.nextSibling);
      this._frame.src = `wholemount.html?id=${encodeURIComponent(target.id)}&hideHeader=true&panelIndex=1`;
    } else {
      this._frame.contentWindow?.postMessage({ type: 'WM_OPEN_DATASET', id: target.id }, Utils.trustedTargetOrigin());
    }
    this._pane.querySelector('.wm-split-tag').textContent = target.name;
    this._ui.section.hidden = false;
    this._ctx.ui.scheduleResize();
    this._render();
  },

  _close() {
    this._pane?.remove();
    this._pane = null;
    this._frame = null;
    this._ui.section.hidden = true;
    this._ctx.ui.scheduleResize();
  },

  _swap() {
    const mine = this._ctx.dataset.getId();
    if (!this._targetId || !mine) return;
    const target = this._targetId;
    this._ctx.dataset.open(target);
    this._openPane(mine);
  },

  // ── Linked view ───────────────────────────────────────────────────────────
  _pushView(force) {
    if (!this._frame || this._suppress || (!this._link && !force)) return;
    this._frame.contentWindow?.postMessage({ type: 'WM_SET_PHYSICAL_VIEW', view: this._ctx.viewer.getPhysicalView() }, Utils.trustedTargetOrigin());
  },

  _handleMessage(e) {
    if (!Utils.isTrustedMessageOrigin(e) || !this._frame || e.source !== this._frame.contentWindow) return;
    if (e.data?.type !== 'WM_PHYSICAL_VIEW' || !this._link) return;
    this._suppress = true;
    this._ctx.viewer.setPhysicalView(e.data.view);
    this._suppress = false;
  },

  // ── Panel ─────────────────────────────────────────────────────────────────
  _render() {
    if (!this._ui) return;
    const esc = s => this._ctx.ui.escapeHtml(s);
    const mine = this._ctx.dataset.getId();
    const options = this._ctx.dataset.getCollection().filter(d => d.id !== mine).map(d =>
      `<option value="${esc(d.id)}"${d.id === this._targetId ? ' selected' : ''}>${esc(Utils.formatStage(d.stage))} · ${esc(d.name)}</option>`).join('');
    this._ui.body.innerHTML = `
      <div class="wm-plugin-row">
        <label for="split-target">${esc(this._t('compareWith'))}</label>
        <select class="form-input" id="split-target">${options}</select>
      </div>
      <label class="wm-check"><input type="checkbox" id="split-link"${this._link ? ' checked' : ''}> ${esc(this._t('link'))}</label>
      <div class="wm-plugin-actions">
        <button type="button" class="btn btn-outline btn-sm" id="split-swap"><i data-lucide="arrow-left-right"></i> ${esc(this._t('swap'))}</button>
        <button type="button" class="btn btn-outline btn-sm" id="split-fit"><i data-lucide="maximize"></i> ${esc(this._t('fitBoth'))}</button>
        <button type="button" class="btn btn-ghost btn-sm" id="split-close"><i data-lucide="x"></i> ${esc(this._t('close'))}</button>
      </div>
      <div class="wm-plugin-hint">${esc(this._t('hint'))}</div>`;
    this._ctx.ui.createIcons({ nodes: [this._ui.body] });
    this._ui.body.querySelector('#split-target').addEventListener('change', (e) => this._openPane(e.target.value));
    this._ui.body.querySelector('#split-link').addEventListener('change', (e) => { this._link = e.target.checked; this._pushView(); });
    this._ui.body.querySelector('#split-swap').addEventListener('click', () => this._swap());
    this._ui.body.querySelector('#split-fit').addEventListener('click', () => { this._ctx.viewer.fit(); this._pushView(true); });
    this._ui.body.querySelector('#split-close').addEventListener('click', () => {
      this._close();
      PluginRegistry.syncToolbarButton('split-view', { active: false });
    });
  }
});
