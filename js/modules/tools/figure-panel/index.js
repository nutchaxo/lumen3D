/* Figure Panel Builder — index.js
 *
 * Picks photographs of the collection and lays them out in a grid, two ways:
 *   physical — every panel is resampled to the coarsest pixel size of the
 *              selection (never upsampled), so ONE scale bar is true for all;
 *   sameSize — every panel fills the same cell, so each keeps its own pixel
 *              size and gets its own bar.
 * Either way the Studio receives one calibration rectangle per panel
 * (`layoutMaps`): a scale bar or a distance placed on a panel reads that
 * panel's µm/px, and follows it when moved onto another one.
 * Each photograph is drawn in its saved orientation (metadata.orientation2d).
 */
PluginRegistry.implement('figure-panel', {
  _ctx: null,
  _modal: null,
  _selected: new Set(),
  _options: { columns: 'auto', scale: 'physical', label: 'stage', background: 'dark', bar: 'auto' },
  _result: null,
  _images: new Map(),       // dataset id -> { promise, pixels }: decoded photographs, newest last

  MAX_WIDTH: 6000,
  MAX_SIDE: 16000,              // what a browser reliably allocates for one canvas side
  MAX_CANVAS_PIXELS: 120e6,
  MAX_CACHED_PIXELS: 48e6,      // decoded photographs kept between two renders (~190 MB)
  DECODE_CONCURRENCY: 3,
  PLACEHOLDER_W: 1600,          // size assumed for a photograph that declares none and cannot be read
  PLACEHOLDER_H: 1200,
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

  dispose() {
    this._releaseImages();
    this._modal?.remove();
    this._modal = null;
  },

  // ── Modal ─────────────────────────────────────────────────────────────────
  _buildModal() {
    const esc = s => this._ctx.ui.escapeHtml(s);
    const modal = document.createElement('div');
    modal.className = 'p2d-modal';
    modal.hidden = true;
    modal.innerHTML = `
      <div class="p2d-modal-card" role="dialog" aria-label="${esc(this._t('title'))}">
        <div class="p2d-modal-head">
          <h2>${esc(this._t('title'))}</h2>
          <button type="button" class="btn btn-ghost btn-sm" data-fp="all">${esc(this._t('selectAll'))}</button>
          <button type="button" class="btn btn-ghost btn-sm" data-fp="none">${esc(this._t('selectNone'))}</button>
          <button type="button" class="btn btn-icon btn-ghost" data-fp="close" aria-label="${esc(this._t('close'))}"><i data-lucide="x"></i></button>
        </div>
        <div class="p2d-modal-body">
          <div class="p2d-modal-list" id="fp-list"></div>
          <div class="p2d-modal-main">
            <div class="p2d-modal-options">
              <label>${esc(this._t('columns'))}
                <select class="form-input" data-fp-opt="columns">
                  <option value="auto">${esc(this._t('auto'))}</option><option>1</option><option>2</option><option>3</option><option>4</option><option>5</option>
                </select></label>
              <label>${esc(this._t('scale'))}
                <select class="form-input" data-fp-opt="scale">
                  <option value="physical">${esc(this._t('scaleCommon'))}</option>
                  <option value="sameSize">${esc(this._t('scaleFit'))}</option>
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
            <div class="p2d-modal-preview"><canvas id="fp-preview"></canvas></div>
          </div>
        </div>
        <div class="p2d-modal-foot">
          <span class="p2d-modal-status" id="fp-status"></span>
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
      return Utils.el('label', { class: 'p2d-pick' }, input,
        Utils.el('img', { src: this._ctx.dataset.fileUrl(ds, ds.image?.preview || 'preview.webp'), alt: '', loading: 'lazy' }),
        Utils.el('span', { class: 'p2d-pick-name' }, `${Utils.formatStage(ds.stage)} · ${ds.name}`));
    }));
  },

  _onClick(e) {
    const action = e.target.closest('[data-fp]')?.dataset.fp;
    if (!action) return;
    if (action === 'close') { this._modal.hidden = true; this._releaseImages(); }
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
  // A photograph is decoded, drawn into the figure and let go: at most
  // DECODE_CONCURRENCY are in flight, and only a bounded number of decoded pixels
  // stays cached for the next option change. A photograph that fails to load is a
  // blank labelled cell, never a failed figure.
  async _preview() {
    const status = this._modal.querySelector('#fp-status');
    const datasets = this._ctx.dataset.getCollection().filter(d => this._selected.has(d.id));
    if (!datasets.length) { status.textContent = this._t('pickSome'); this._result = null; return; }
    status.textContent = this._t('rendering');
    const token = (this._token = (this._token || 0) + 1);
    try {
      const sizes = await this._sizes(datasets, token);
      if (token !== this._token) return;
      const result = await this._compose(datasets, sizes, token);
      if (!result || token !== this._token) return;
      this._result = result;
      this._paintPreview();
      status.textContent = result.failed
        ? this._t('readyPartial', { n: datasets.length, w: result.canvas.width, h: result.canvas.height, failed: result.failed })
        : this._t('ready', { n: datasets.length, w: result.canvas.width, h: result.canvas.height });
    } catch (err) {
      status.textContent = this._t('loadFailed');
      console.warn('[figure-panel]', err);
    }
  },

  /** Oriented-box input: the declared size of each photograph; one that declares none is decoded to read it. */
  async _sizes(datasets, token) {
    const sizes = datasets.map(ds => {
      const w = Number(ds.image?.width ?? ds.dimensions?.x), h = Number(ds.image?.height ?? ds.dimensions?.y);
      return w > 0 && h > 0 ? { w, h } : null;
    });
    const unknown = datasets.map((_, i) => i).filter(i => !sizes[i]);
    await this._forEachLimited(unknown, async (i) => {
      if (token !== this._token) return;
      try {
        const img = await this._loadImage(datasets[i]);
        sizes[i] = { w: img.naturalWidth, h: img.naturalHeight };
      } catch (_) { sizes[i] = { w: this.PLACEHOLDER_W, h: this.PLACEHOLDER_H }; }
    });
    return sizes;
  },

  async _forEachLimited(items, fn) {
    let next = 0;
    const lanes = Array.from({ length: Math.min(this.DECODE_CONCURRENCY, items.length) }, async () => {
      while (next < items.length) await fn(items[next++]);
    });
    await Promise.all(lanes);
  },

  _loadImage(ds) {
    const cached = this._images.get(ds.id);
    if (cached) {
      this._images.delete(ds.id);       // re-inserted below: Map order is the recency order
      this._images.set(ds.id, cached);
      return cached.promise;
    }
    const img = new Image();
    img.decoding = 'async';
    img.src = this._ctx.dataset.fileUrl(ds, ds.image?.native || 'image.webp');
    const entry = { promise: null, pixels: 0 };
    entry.promise = img.decode().then(() => {
      entry.pixels = img.naturalWidth * img.naturalHeight;
      this._evict();
      return img;
    });
    entry.promise.catch(() => this._images.delete(ds.id));
    this._images.set(ds.id, entry);
    return entry.promise;
  },

  /** Keep the most recent decoded photographs within MAX_CACHED_PIXELS. */
  _evict() {
    let total = 0;
    for (const entry of this._images.values()) total += entry.pixels;
    for (const [id, entry] of this._images) {
      if (total <= this.MAX_CACHED_PIXELS || this._images.size <= 1) break;
      total -= entry.pixels;
      this._images.delete(id);
    }
  },

  _releaseImages() {
    this._token = (this._token || 0) + 1;
    this._images.clear();
    this._result = null;
    const view = this._modal?.querySelector('#fp-preview');
    if (view) { view.width = 1; view.height = 1; }
  },

  /** Oriented bounding box of a photograph, in its own pixels. */
  _orientedBox(ds, size) {
    const th = ((ds.orientation2d?.rotationDeg) || 0) * Math.PI / 180;
    const c = Math.abs(Math.cos(th)), s = Math.abs(Math.sin(th));
    return { w: size.w * c + size.h * s, h: size.w * s + size.h * c };
  },

  /** µm per pixel from the metadata, or null: a photograph without a calibration has no physical scale. */
  _pixelSize(ds) {
    const v = Number(ds.pixelSizeUm?.x);
    return Number.isFinite(v) && v > 0 ? v : null;
  },

  /**
   * Cell size and per-panel magnification for the chosen layout.
   *   physical: factor_i = px_i / px_max  (the coarsest photograph stays 1:1)
   *   sameSize: factor_i = fit of the oriented box into the largest box
   * A photograph without a calibration cannot take part in the physical scale: it
   * is fitted into the cell the calibrated ones define, and carries no bar.
   */
  _layout(datasets, boxes) {
    const pxs = datasets.map(d => this._pixelSize(d));
    const calibrated = pxs.map(p => p !== null);
    const fit = (b, cellW, cellH) => Math.min(cellW / b.w, cellH / b.h);
    if (this._options.scale === 'sameSize' || !calibrated.some(Boolean)) {
      const cellW = Math.max(...boxes.map(b => b.w)), cellH = Math.max(...boxes.map(b => b.h));
      return { cellW, cellH, factors: boxes.map(b => fit(b, cellW, cellH)), pxs, shared: false };
    }
    const pxOut = Math.max(...pxs.filter(p => p !== null));
    const factors = pxs.map(px => (px === null ? null : px / pxOut));
    const cellW = Math.max(...boxes.map((b, i) => (factors[i] === null ? 0 : b.w * factors[i])));
    const cellH = Math.max(...boxes.map((b, i) => (factors[i] === null ? 0 : b.h * factors[i])));
    return { cellW, cellH, factors: factors.map((f, i) => (f === null ? fit(boxes[i], cellW, cellH) : f)), pxs, shared: true };
  },

  async _compose(datasets, sizes, token) {
    const boxes = datasets.map((d, i) => this._orientedBox(d, sizes[i]));
    const lay = this._layout(datasets, boxes);
    const cols = this._options.columns === 'auto' ? Math.ceil(Math.sqrt(datasets.length)) : Number(this._options.columns);
    const rows = Math.ceil(datasets.length / cols);
    const gap0 = lay.cellW * this.GAP_RATIO;
    const fullW = cols * lay.cellW + (cols + 1) * gap0;
    const fullH = rows * lay.cellH + (rows + 1) * gap0;
    // The figure fits MAX_WIDTH and what a browser can actually allocate for one canvas.
    const shrink = Math.min(1, this.MAX_WIDTH / fullW, this.MAX_SIDE / fullW, this.MAX_SIDE / fullH,
      Math.sqrt(this.MAX_CANVAS_PIXELS / (fullW * fullH)));
    const cellW = Math.max(1, Math.round(lay.cellW * shrink)), cellH = Math.max(1, Math.round(lay.cellH * shrink));
    const g = Math.round(gap0 * shrink);

    const canvas = document.createElement('canvas');
    canvas.width = cols * cellW + (cols + 1) * g;
    canvas.height = rows * cellH + (rows + 1) * g;
    const c = canvas.getContext('2d');
    const light = this._options.background === 'light';
    c.fillStyle = light ? '#ffffff' : '#000000';
    c.fillRect(0, 0, canvas.width, canvas.height);

    const withBars = this._options.bar !== 'none';
    let failed = 0;
    const layoutMaps = datasets.map((ds, i) => {
      const f = lay.factors[i] * shrink;
      const x = g + (i % cols) * (cellW + g), y = g + Math.floor(i / cols) * (cellH + g);
      const w = boxes[i].w * f, h = boxes[i].h * f;
      const calibrated = lay.pxs[i] !== null;
      // Pixels per µm of the composite at this rectangle; an uncalibrated photograph is
      // given in its own pixels and flagged, so nothing reads it as micrometres.
      const px = (calibrated ? lay.pxs[i] : 1) / f;
      return { x: x + (cellW - w) / 2, y: y + (cellH - h) / 2, w, h, pixelSizeUm: { x: px, y: px }, calibrated, channelState: [], _cell: { x, y }, _f: f };
    });

    await this._forEachLimited(datasets.map((_, i) => i), async (i) => {
      if (token !== this._token) return;
      const ds = datasets[i], map = layoutMaps[i];
      try {
        const img = await this._loadImage(ds);
        if (token !== this._token) return;
        this._drawPanel(c, ds, img, map._cell.x, map._cell.y, cellW, cellH, map._f, light);
      } catch (err) {
        failed++;
        console.warn('[figure-panel] photograph unavailable:', ds.id, err);
        this._drawUnavailable(c, ds, map._cell.x, map._cell.y, cellW, cellH, light);
      }
    });
    if (token !== this._token) return null;

    layoutMaps.forEach((map, i) => {
      if (map.calibrated) { if (withBars && !lay.shared) this._drawScaleBar(c, map, map.pixelSizeUm.x, light); }
      else this._drawUncalibratedTag(c, map, light);
      delete map._cell;
      delete map._f;
    });
    const sharedPx = lay.shared ? Math.max(...lay.pxs.filter(p => p !== null)) / shrink : null;
    if (withBars && lay.shared) this._drawScaleBar(c, { x: 0, y: 0, w: canvas.width, h: canvas.height }, sharedPx, light);
    const firstCalibrated = layoutMaps.find(m => m.calibrated);
    return {
      canvas, layoutMaps, count: datasets.length, failed,
      pixelSizeUm: sharedPx || firstCalibrated?.pixelSizeUm.x || 1,
      calibrated: Boolean(sharedPx || firstCalibrated)
    };
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
    this._drawLabel(c, ds, x, y, h, light);
  },

  /** A photograph that could not be loaded keeps its place in the grid, with its label. */
  _drawUnavailable(c, ds, x, y, w, h, light) {
    c.save();
    c.strokeStyle = light ? 'rgba(0,0,0,0.35)' : 'rgba(255,255,255,0.35)';
    c.setLineDash([8, 6]);
    c.strokeRect(x + 1, y + 1, w - 2, h - 2);
    c.setLineDash([]);
    const size = Math.max(14, Math.round(h / 22));
    c.font = `600 ${size}px Inter, system-ui, sans-serif`;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillStyle = light ? '#555' : '#aaa';
    c.fillText(this._t('unavailable'), x + w / 2, y + h / 2);
    c.restore();
    this._drawLabel(c, ds, x, y, h, light);
  },

  _drawLabel(c, ds, x, y, h, light) {
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

  _drawUncalibratedTag(c, rect, light) {
    const size = Math.max(12, Math.round(rect.h / 40));
    c.save();
    c.font = `600 ${size}px Inter, system-ui, sans-serif`;
    c.textAlign = 'right';
    c.textBaseline = 'bottom';
    c.fillStyle = light ? '#8a5a00' : '#ffb454';
    c.fillText(this._t('uncalibrated'), rect.x + rect.w - size, rect.y + rect.h - size);
    c.restore();
  },

  _labelText(ds) {
    const mode = this._options.label;
    if (mode === 'none') return '';
    if (mode === 'name') return ds.name;
    if (mode === 'both') return `${Utils.formatStage(ds.stage)} — ${ds.name}`;
    return Utils.formatStage(ds.stage);
  },

  /** One 1-2-5 bar about a fifth of the rectangle wide, at its bottom-right. */
  _drawScaleBar(c, rect, pxUm, light) {
    const targetUm = (rect.w / 5) * pxUm;
    const exp = Math.pow(10, Math.floor(Math.log10(targetUm)));
    const m = targetUm / exp;
    const lengthUm = (m >= 5 ? 5 : m >= 2 ? 2 : 1) * exp;
    const px = lengthUm / pxUm;
    const size = Math.max(12, Math.round(rect.h / 40));
    const x1 = rect.x + rect.w - size, y = rect.y + rect.h - size, x0 = x1 - px;
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
    this._result.canvas.toBlob(blob => { if (blob) ExportManager.downloadBlob(blob, `figure_panel_${this._result.count}.png`); }, 'image/png');
  },

  _openStudio() {
    if (!this._result) return;
    const px = this._result.pixelSizeUm;
    this._ctx.ui.openStudioWith({
      canvas: this._result.canvas, width: this._result.canvas.width, height: this._result.canvas.height,
      source: '2d-figure', quality: 'native', timepoint: 0,
      pixelSizeUm: { x: px, y: px }, calibrated: this._result.calibrated, layoutMaps: this._result.layoutMaps,
      dataset: { name: `figure_panel_${this._result.count}` }, channelState: []
    });
    this._modal.hidden = true;
    this._releaseImages();
  }
});
