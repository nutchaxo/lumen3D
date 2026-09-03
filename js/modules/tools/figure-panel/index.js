/* Figure Panel Builder — index.js
 *
 * Picks photographs of the collection and lays them out in a grid at ONE
 * physical scale: every panel is resampled to the coarsest pixel size of the
 * selection (never upsampled), so a single scale bar is true for all of them.
 * Each photograph is drawn in its saved orientation (metadata.orientation2d).
 * The result goes out as a PNG or into the Studio, calibrated in µm/px.
 */
PluginRegistry.implement('figure-panel', {
  _ctx: null,
  _modal: null,
  _selected: new Set(),
  _options: { columns: 'auto', scale: 'common', label: 'stage', background: 'dark', bar: 'auto' },
  _result: null,
  _images: new Map(),

  MAX_WIDTH: 6000,
  GAP_RATIO: 0.03,

  _t(key, params) { return this._ctx.i18n.t(key, params); },

  init(ctx) { this._ctx = ctx; return this; },

  activate() {
    if (!this._modal) this._modal = this._buildModal();
    if (!this._selected.size) this._selected.add(this._ctx.dataset.getId());
    this._renderList();
    this._modal.hidden = false;
    this._preview();
  },

  dispose() { this._modal?.remove(); this._modal = null; },

  // ── Modal ─────────────────────────────────────────────────────────────────
  _buildModal() {
    const esc = s => this._ctx.ui.escapeHtml(s);
    const modal = document.createElement('div');
    modal.className = 'wm-modal';
    modal.hidden = true;
    modal.innerHTML = `
      <div class="wm-modal-card" role="dialog" aria-label="${esc(this._t('title'))}">
        <div class="wm-modal-head">
          <h2>${esc(this._t('title'))}</h2>
          <button type="button" class="btn btn-ghost btn-sm" data-fp="all">${esc(this._t('selectAll'))}</button>
          <button type="button" class="btn btn-ghost btn-sm" data-fp="none">${esc(this._t('selectNone'))}</button>
          <button type="button" class="btn btn-icon btn-ghost" data-fp="close" aria-label="${esc(this._t('close'))}"><i data-lucide="x"></i></button>
        </div>
        <div class="wm-modal-body">
          <div class="wm-modal-list" id="fp-list"></div>
          <div class="wm-modal-main">
            <div class="wm-modal-options">
              <label>${esc(this._t('columns'))}
                <select class="form-input" data-fp-opt="columns">
                  <option value="auto">${esc(this._t('auto'))}</option><option>1</option><option>2</option><option>3</option><option>4</option><option>5</option>
                </select></label>
              <label>${esc(this._t('scale'))}
                <select class="form-input" data-fp-opt="scale">
                  <option value="common">${esc(this._t('scaleCommon'))}</option>
                  <option value="fit">${esc(this._t('scaleFit'))}</option>
                </select></label>
              <label>${esc(this._t('labelOpt'))}
                <select class="form-input" data-fp-opt="label">
                  <option value="stage">${esc(this._t('labelStage'))}</option>
                  <option value="name">${esc(this._t('labelName'))}</option>
                  <option value="both">${esc(this._t('labelBoth'))}</option>
                  <option value="none">${esc(this._t('labelNone'))}</option>
                </select></label>
              <label>${esc(this._t('background'))}
                <select class="form-input" data-fp-opt="background">
                  <option value="dark">${esc(this._t('bgDark'))}</option>
                  <option value="light">${esc(this._t('bgLight'))}</option>
                </select></label>
              <label>${esc(this._t('scaleBar'))}
                <select class="form-input" data-fp-opt="bar">
                  <option value="auto">${esc(this._t('auto'))}</option>
                  <option value="none">${esc(this._t('labelNone'))}</option>
                </select></label>
            </div>
            <div class="wm-modal-preview"><canvas id="fp-preview"></canvas></div>
          </div>
        </div>
        <div class="wm-modal-foot">
          <span class="wm-modal-status" id="fp-status"></span>
          <button type="button" class="btn btn-outline btn-sm" data-fp="png"><i data-lucide="download"></i> ${esc(this._t('exportPng'))}</button>
          <button type="button" class="btn btn-primary btn-sm" data-fp="studio"><i data-lucide="pen-tool"></i> ${esc(this._t('openStudio'))}</button>
        </div>
      </div>`;
    document.body.appendChild(modal);
    this._ctx.ui.createIcons({ nodes: [modal] });
    modal.addEventListener('click', (e) => this._onClick(e));
    modal.addEventListener('change', (e) => this._onChange(e));
    return modal;
  },

  _renderList() {
    const list = this._modal.querySelector('#fp-list');
    list.replaceChildren(...this._ctx.dataset.getCollection().map(ds => {
      const input = Utils.el('input', { type: 'checkbox', 'data-fp-pick': ds.id });
      input.checked = this._selected.has(ds.id);
      return Utils.el('label', { class: 'wm-pick' }, input,
        Utils.el('img', { src: this._ctx.dataset.fileUrl(ds, ds.image?.preview || 'preview.webp'), alt: '', loading: 'lazy' }),
        Utils.el('span', { class: 'wm-pick-name' }, `${Utils.formatStage(ds.stage)} · ${ds.name}`));
    }));
  },

  _onClick(e) {
    const action = e.target.closest('[data-fp]')?.dataset.fp;
    if (!action) return;
    if (action === 'close') this._modal.hidden = true;
    else if (action === 'all') { this._ctx.dataset.getCollection().forEach(d => this._selected.add(d.id)); this._renderList(); this._preview(); }
    else if (action === 'none') { this._selected.clear(); this._renderList(); this._preview(); }
    else if (action === 'png') this._exportPng();
    else if (action === 'studio') this._openStudio();
  },

  _onChange(e) {
    const pick = e.target.dataset.fpPick;
    if (pick) { e.target.checked ? this._selected.add(pick) : this._selected.delete(pick); this._preview(); return; }
    const opt = e.target.dataset.fpOpt;
    if (opt) { this._options[opt] = e.target.value; this._preview(); }
  },

  // ── Rendering ─────────────────────────────────────────────────────────────
  async _preview() {
    const status = this._modal.querySelector('#fp-status');
    const datasets = this._ctx.dataset.getCollection().filter(d => this._selected.has(d.id));
    if (!datasets.length) { status.textContent = this._t('pickSome'); this._result = null; return; }
    status.textContent = this._t('rendering');
    const token = (this._token = (this._token || 0) + 1);
    try {
      const images = await Promise.all(datasets.map(ds => this._loadImage(ds)));
      if (token !== this._token) return;
      this._result = this._compose(datasets, images);
      this._paintPreview();
      status.textContent = this._t('ready', { n: datasets.length, w: this._result.canvas.width, h: this._result.canvas.height });
    } catch (err) {
      status.textContent = this._t('loadFailed');
      console.warn('[figure-panel]', err);
    }
  },

  _loadImage(ds) {
    if (this._images.has(ds.id)) return this._images.get(ds.id);
    const img = new Image();
    img.decoding = 'async';
    img.src = this._ctx.dataset.fileUrl(ds, ds.image?.native || 'image.webp');
    const promise = img.decode().then(() => img);
    this._images.set(ds.id, promise);
    promise.catch(() => this._images.delete(ds.id));
    return promise;
  },

  /** Oriented bounding box of a photograph, in its own pixels. */
  _orientedBox(ds, img) {
    const th = ((ds.orientation2d?.rotationDeg) || 0) * Math.PI / 180;
    const c = Math.abs(Math.cos(th)), s = Math.abs(Math.sin(th));
    return { w: img.naturalWidth * c + img.naturalHeight * s, h: img.naturalWidth * s + img.naturalHeight * c };
  },

  _compose(datasets, images) {
    const common = this._options.scale === 'common';
    const pxs = datasets.map(d => d.pixelSizeUm?.x || 1);
    const pxOut = common ? Math.max(...pxs) : null;          // coarsest: nothing is upsampled
    const boxes = datasets.map((d, i) => this._orientedBox(d, images[i]));
    const factors = datasets.map((d, i) => common ? pxs[i] / pxOut : 1);
    let cellW = Math.max(...boxes.map((b, i) => b.w * factors[i]));
    let cellH = Math.max(...boxes.map((b, i) => b.h * factors[i]));
    const cols = this._options.columns === 'auto' ? Math.ceil(Math.sqrt(datasets.length)) : Number(this._options.columns);
    const rows = Math.ceil(datasets.length / cols);
    let shrink = 1;
    const gap = Math.round(cellW * this.GAP_RATIO);
    const fullW = cols * cellW + (cols + 1) * gap;
    if (fullW > this.MAX_WIDTH) shrink = this.MAX_WIDTH / fullW;
    cellW = Math.round(cellW * shrink); cellH = Math.round(cellH * shrink);
    const g = Math.round(gap * shrink);
    const canvas = document.createElement('canvas');
    canvas.width = cols * cellW + (cols + 1) * g;
    canvas.height = rows * cellH + (rows + 1) * g;
    const c = canvas.getContext('2d');
    const light = this._options.background === 'light';
    c.fillStyle = light ? '#ffffff' : '#000000';
    c.fillRect(0, 0, canvas.width, canvas.height);
    datasets.forEach((ds, i) => {
      const x = g + (i % cols) * (cellW + g), y = g + Math.floor(i / cols) * (cellH + g);
      this._drawPanel(c, ds, images[i], x, y, cellW, cellH, factors[i] * shrink, light);
    });
    const pxFigure = pxOut ? pxOut / shrink : null;
    if (pxFigure && this._options.bar !== 'none') this._drawScaleBar(c, canvas, pxFigure, light);
    return { canvas, pixelSizeUm: pxFigure, count: datasets.length };
  },

  _drawPanel(c, ds, img, x, y, w, h, factor, light) {
    const th = ((ds.orientation2d?.rotationDeg) || 0) * Math.PI / 180;
    c.save();
    c.beginPath(); c.rect(x, y, w, h); c.clip();
    c.translate(x + w / 2, y + h / 2);
    c.scale(factor, factor);
    c.rotate(th);
    if (ds.orientation2d?.flipH) c.scale(-1, 1);
    c.imageSmoothingQuality = 'high';
    c.drawImage(img, -img.naturalWidth / 2, -img.naturalHeight / 2);
    c.restore();
    const text = this._labelText(ds);
    if (!text) return;
    const size = Math.max(14, Math.round(h / 22));
    c.font = `600 ${size}px Inter, system-ui, sans-serif`;
    c.textBaseline = 'top';
    c.textAlign = 'left';
    c.fillStyle = light ? 'rgba(255,255,255,0.75)' : 'rgba(0,0,0,0.55)';
    c.fillRect(x + size * 0.4, y + size * 0.4, c.measureText(text).width + size * 0.8, size * 1.5);
    c.fillStyle = light ? '#111' : '#fff';
    c.fillText(text, x + size * 0.8, y + size * 0.65);
  },

  _labelText(ds) {
    const mode = this._options.label;
    if (mode === 'none') return '';
    if (mode === 'name') return ds.name;
    if (mode === 'both') return `${Utils.formatStage(ds.stage)} — ${ds.name}`;
    return Utils.formatStage(ds.stage);
  },

  /** One 1-2-5 bar about a fifth of a panel wide, bottom-right of the figure. */
  _drawScaleBar(c, canvas, pxUm, light) {
    const targetUm = (canvas.width / 5) * pxUm;
    const exp = Math.pow(10, Math.floor(Math.log10(targetUm)));
    const m = targetUm / exp;
    const lengthUm = (m >= 5 ? 5 : m >= 2 ? 2 : 1) * exp;
    const px = lengthUm / pxUm;
    const size = Math.max(14, Math.round(canvas.height / 40));
    const x1 = canvas.width - size, y = canvas.height - size, x0 = x1 - px;
    c.lineWidth = Math.max(3, size / 4);
    c.strokeStyle = light ? '#111' : '#fff';
    c.beginPath(); c.moveTo(x0, y); c.lineTo(x1, y); c.stroke();
    c.font = `600 ${size}px Inter, system-ui, sans-serif`;
    c.textAlign = 'center';
    c.textBaseline = 'bottom';
    c.fillStyle = light ? '#111' : '#fff';
    c.fillText(lengthUm >= 1000 ? `${lengthUm / 1000} mm` : `${lengthUm} µm`, (x0 + x1) / 2, y - size * 0.4);
  },

  _paintPreview() {
    const view = this._modal.querySelector('#fp-preview');
    const src = this._result.canvas;
    const box = view.parentElement.getBoundingClientRect();
    const k = Math.min(1, (box.width - 24) / src.width, (box.height - 24) / src.height);
    view.width = Math.max(1, Math.round(src.width * k));
    view.height = Math.max(1, Math.round(src.height * k));
    view.getContext('2d').drawImage(src, 0, 0, view.width, view.height);
  },

  // ── Output ────────────────────────────────────────────────────────────────
  _exportPng() {
    if (!this._result || typeof ExportManager === 'undefined') return;
    this._result.canvas.toBlob(blob => { if (blob) ExportManager.downloadBlob(blob, `wholemount_figure_${this._result.count}.png`); }, 'image/png');
  },

  _openStudio() {
    if (!this._result) return;
    const px = this._result.pixelSizeUm || 1;
    this._ctx.ui.openStudioWith({
      canvas: this._result.canvas, width: this._result.canvas.width, height: this._result.canvas.height,
      source: 'wholemount-figure', quality: 'native', timepoint: 0,
      pixelSizeUm: { x: px, y: px }, dataset: { name: `wholemount_figure_${this._result.count}` }, channelState: []
    });
    this._modal.hidden = true;
  }
});
