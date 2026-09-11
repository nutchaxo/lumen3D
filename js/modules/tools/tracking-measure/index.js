/* Tracking Measure — index.js
 *
 * Cell-to-cell distance on a tracked timelapse: with the "cell distance" tool
 * current, two clicks on two tracked cells give their separation in
 * micrometres, in the frame of reference on screen (stabilised or raw). Two
 * modes: a SNAPSHOT keeps the two positions of the frame it was taken on; a
 * FOLLOW-CELLS measurement re-reads both cells at every frame and reports
 * "out of frame" when one of them is not there.
 *
 * Measurements persist through MeasurementStore under the 'tracking' scope —
 * the same store the viewer's surface-point measurements use under 'viewer' —
 * so the workspace and the Download Center carry them for free. The lines and
 * markers are children of the volume cube, sized in micrometres like the
 * centroids, so they stay honest at any zoom and follow the clip box.
 */
PluginRegistry.implement('tracking-measure', {
  _ctx: null,
  _T: null,
  _panel: null,
  _els: null,
  _unsubs: [],
  _ac: null,
  _mode: 'snapshot',
  _draft: [],
  _measurements: [],
  _indexById: null,
  _group: null,
  _pointerStart: null,

  COLORS: ['#ff4d4f', '#ffd700', '#00ffff', '#7fff00', '#ff69b4', '#9400d3', '#1e90ff', '#ff8c00'],
  LINE_RADIUS_UM: 1.2,
  MARKER_RADIUS_UM: 3.5,

  _t(key, params) { return this._ctx.i18n.t(key, params); },
  _esc(s) { return this._ctx.ui.escapeHtml(s); },

  init(ctx) {
    this._ctx = ctx;
    this._T = ctx.tracking;
    if (!this._T || !this._T.isAvailable()) return this;
    this._measurements = ctx.measurements.list('tracking');
    this._panel = ctx.ui.addCanvasPanel({
      id: 'tracking-measure',
      html: this._html(),
      bind: (root) => this._bind(root)
    });
    this._unsubs = [
      this._T.on('loaded', () => { this._indexById = null; this._renderAll(); }),
      this._T.on('frame', () => this._renderAll()),
      this._T.on('refresh', () => this._draw()),
      this._T.on('style', () => this._draw()),
      ctx.tools.onChange((tool) => this._onTool(tool))
    ];
    this._bindCanvas();
    ctx.i18n.onLanguageChange?.(() => this._applyLabels());
    this._renderAll();
    return this;
  },

  // ── Workspace state ───────────────────────────────────────

  getState() {
    return { mode: this._mode, measurements: this._ctx.measurements.list('tracking') };
  },

  setState(s) {
    if (!s || typeof s !== 'object') return;
    if (s.mode === 'snapshot' || s.mode === 'follow-cells') this._mode = s.mode;
    if (Array.isArray(s.measurements)) this._measurements = this._ctx.measurements.setAll('tracking', s.measurements);
    this._syncMode();
    this._renderAll();
  },

  reset() {
    this._mode = 'snapshot';
    this._clear();
    this._syncMode();
  },

  getExports() {
    const on = this._measurements.length > 0;
    return [
      { action: 'tracking-measure-csv', icon: 'ruler', label: this._t('exportCsv'), enabled: on, handler: () => this._export('csv') },
      { action: 'tracking-measure-json', icon: 'braces', label: this._t('exportJson'), enabled: on, handler: () => this._export('json') }
    ];
  },

  dispose() {
    this._unsubs.forEach(fn => fn());
    this._unsubs = [];
    this._ac?.abort?.();
    this._destroyGroup();
    this._panel?.remove();
    this._panel = null;
  },

  // ── Measurement model ─────────────────────────────────────

  _lookup(id) {
    const data = this._T.getData();
    if (!data) return -1;
    if (!this._indexById) {
      this._indexById = new Map();
      for (let c = 0; c < data.cellTotal; c++) this._indexById.set(String(data.ids[c]), c);
    }
    const c = this._indexById.get(String(id));
    return c === undefined ? -1 : c;
  },

  _distance(a, b) {
    return Math.hypot((a[0] || 0) - (b[0] || 0), (a[1] || 0) - (b[1] || 0), (a[2] || 0) - (b[2] || 0));
  },

  /** A stored row as it stands at the current frame. */
  resolve(row) {
    const base = { ...row, status: row.status || 'ok', points: Array.isArray(row.points) ? row.points : [], cells: Array.isArray(row.cells) ? row.cells : [] };
    if (row.mode !== 'follow-cells') return base;
    const frame = this._T.getFrame();
    const a = this._T.positionUm(this._lookup(base.cells[0]), frame);
    const b = this._T.positionUm(this._lookup(base.cells[1]), frame);
    if (!a || !b) return { ...base, status: 'out-of-frame', distance: null, points: [] };
    return { ...base, status: 'ok', distance: this._distance(a, b), points: [a, b], timepoint: frame };
  },

  listMeasurements() { return this._measurements.map(row => this.resolve(row)); },

  _addDraft(c) {
    if (c < 0) return;
    if (this._draft.length >= 2 || this._draft.includes(c)) this._draft = [];
    this._draft.push(c);
    if (this._draft.length === 2) this._commit();
    this._renderAll();
  },

  _commit() {
    const data = this._T.getData();
    const frame = this._T.getFrame();
    const a = this._T.positionUm(this._draft[0], frame);
    const b = this._T.positionUm(this._draft[1], frame);
    if (!data || !a || !b) { this._draft = []; return; }
    this._ctx.measurements.add('tracking', {
      scope: 'tracking',
      datasetId: this._ctx.dataset.getId(),
      label: this._t('measureN', { n: this._measurements.length + 1 }),
      mode: this._mode,
      unit: 'um',
      timepoint: frame,
      distance: this._distance(a, b),
      cells: [String(data.ids[this._draft[0]]), String(data.ids[this._draft[1]])],
      points: [a, b],
      color: this.COLORS[this._measurements.length % this.COLORS.length],
      metadata: { coordinateSpace: this._T.isStabilized() ? 'stabilized' : 'raw', tracks: [data.trackIds[this._draft[0]], data.trackIds[this._draft[1]]] }
    });
    this._measurements = this._ctx.measurements.list('tracking');
    this._draft = [];
  },

  _clear() {
    this._draft = [];
    this._measurements = this._ctx.measurements.clear('tracking');
    this._renderAll();
  },

  // ── Interaction ───────────────────────────────────────────

  _bindCanvas() {
    const canvas = this._ctx.ui.getCanvas?.();
    if (!canvas) return;
    this._ac = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const opts = this._ac ? { signal: this._ac.signal } : undefined;
    canvas.addEventListener('pointerdown', (e) => {
      this._pointerStart = (e.button === 0) ? { x: e.clientX, y: e.clientY } : null;
    }, opts);
    canvas.addEventListener('pointerup', (e) => {
      const start = this._pointerStart;
      this._pointerStart = null;
      if (!start || this._ctx.tools.current() !== 'cell-measure') return;
      if (Math.hypot(e.clientX - start.x, e.clientY - start.y) >= 6) return;
      this._addDraft(this._T.pick(e.clientX, e.clientY));
    }, opts);
  },

  _onTool(tool) {
    const on = tool === 'cell-measure';
    if (this._panel) this._panel.toggle(on);
    if (!on) { this._draft = []; this._renderAll(); }
    const canvas = this._ctx.ui.getCanvas?.();
    if (canvas && on) canvas.style.cursor = 'crosshair';
    else if (canvas && canvas.style.cursor === 'crosshair' && this._ctx.tools.current() !== 'inspect') canvas.style.cursor = '';
  },

  // ── 3D ────────────────────────────────────────────────────

  _ensureGroup() {
    if (this._group) return true;
    const parent = this._T.getVolumeObject();
    if (!parent) return false;
    this._group = new THREE.Group();
    this._group.renderOrder = 42;
    parent.add(this._group);
    return true;
  },

  _clearGroup() {
    if (!this._group) return;
    while (this._group.children.length) {
      const child = this._group.children[this._group.children.length - 1];
      this._group.remove(child);
      child.traverse?.((o) => { o.geometry?.dispose?.(); o.material?.dispose?.(); });
    }
  },

  _destroyGroup() {
    if (!this._group) return;
    this._clearGroup();
    this._T?.getVolumeObject()?.remove(this._group);
    this._group = null;
  },

  _toObject(um) {
    return this._T.umToObject(new THREE.Vector3(um[0], um[1], um[2]), new THREE.Vector3());
  },

  /** A sphere of `radiusUm` at an object-space point, round in world space. */
  _marker(o, radiusUm, color) {
    const S = this._T.getAcquisitionSpace().size;
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 8),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.95, depthTest: false, depthWrite: false }));
    mesh.scale.set(radiusUm / S.x, radiusUm / S.y, radiusUm / S.z);
    mesh.position.copy(o);
    return mesh;
  },

  _segment(a, b, color) {
    const S = this._T.getAcquisitionSpace().size;
    const length = a.distanceTo(b);
    if (length <= 0) return null;
    const r = this.LINE_RADIUS_UM / S.x;
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(r, r, length, 8),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.95, depthTest: false, depthWrite: false }));
    mesh.position.copy(a).lerp(b, 0.5);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
    return mesh;
  },

  _draw() {
    if (!this._T.getData() || !this._T.getAcquisitionSpace() || !this._ensureGroup()) return;
    this._clearGroup();
    const style = this._T.getStyle() || {};
    if (style.visible !== false) {
      for (const row of this.listMeasurements()) {
        if (row.visible === false || row.points.length !== 2) continue;
        const a = this._toObject(row.points[0]), b = this._toObject(row.points[1]);
        if (!a || !b) continue;
        if (!this._T.isInsideClip(a) && !this._T.isInsideClip(b)) continue;
        const seg = this._segment(a, b, row.color || '#ff4d4f');
        if (seg) this._group.add(seg);
        this._group.add(this._marker(a, this.MARKER_RADIUS_UM, row.color || '#ff4d4f'));
        this._group.add(this._marker(b, this.MARKER_RADIUS_UM, row.color || '#ff4d4f'));
      }
      if (this._draft.length === 1) {
        const o = this._T.positionObject(this._draft[0], this._T.getFrame(), new THREE.Vector3());
        if (o) this._group.add(this._marker(o, this.MARKER_RADIUS_UM, '#ff9f43'));
      }
    }
    this._group.visible = this._group.children.length > 0;
    this._T.triggerRender();
  },

  // ── Panel ─────────────────────────────────────────────────

  _html() {
    const esc = (s) => this._esc(s);
    return `
      <div class="scientific-panel-header">
        <strong data-tm="title">${esc(this._t('title'))}</strong>
        <button class="btn btn-icon btn-ghost" type="button" id="tm-close" aria-label="${esc(this._t('close'))}"><i data-lucide="x"></i></button>
      </div>
      <div class="scientific-panel-body">
        <div class="segmented" id="tm-mode">
          <button class="btn btn-ghost btn-sm active" type="button" data-tm-mode="snapshot" data-tm="snapshot">${esc(this._t('snapshot'))}</button>
          <button class="btn btn-ghost btn-sm" type="button" data-tm-mode="follow-cells" data-tm="followCells">${esc(this._t('followCells'))}</button>
        </div>
        <div id="tm-status" class="tracking-inspector text-sm text-muted">${esc(this._t('measureDesc'))}</div>
        <div class="tracking-science-box" id="tm-list">${esc(this._t('noMeasure'))}</div>
        <div class="channel-actions">
          <button class="btn btn-outline btn-sm" type="button" id="tm-clear"><i data-lucide="eraser"></i> <span data-tm="clear">${esc(this._t('clear'))}</span></button>
        </div>
      </div>`;
  },

  _bind(root) {
    this._els = { status: root.querySelector('#tm-status'), list: root.querySelector('#tm-list'), mode: root.querySelector('#tm-mode') };
    root.querySelector('#tm-close')?.addEventListener('click', () => this._ctx.tools.activate('navigate'));
    root.querySelector('#tm-clear')?.addEventListener('click', () => this._clear());
    root.querySelectorAll('[data-tm-mode]').forEach(btn => btn.addEventListener('click', () => {
      this._mode = btn.getAttribute('data-tm-mode') === 'follow-cells' ? 'follow-cells' : 'snapshot';
      this._syncMode();
      this._renderAll();
    }));
    this._els.list?.addEventListener('click', (e) => {
      const action = e.target.closest?.('[data-tm-action]')?.getAttribute('data-tm-action');
      const id = e.target.closest?.('[data-measurement-id]')?.getAttribute('data-measurement-id');
      if (!action || !id) return;
      if (action === 'toggle') {
        const row = this._measurements.find(r => r.id === id);
        if (row) this._ctx.measurements.update('tracking', id, { visible: row.visible === false });
      } else if (action === 'delete') {
        this._ctx.measurements.remove('tracking', id);
      }
      this._measurements = this._ctx.measurements.list('tracking');
      this._renderAll();
    });
    this._syncMode();
  },

  _syncMode() {
    this._els?.mode?.querySelectorAll('[data-tm-mode]').forEach(btn => {
      btn.classList.toggle('active', btn.getAttribute('data-tm-mode') === this._mode);
    });
  },

  _renderAll() {
    this._renderPanel();
    this._draw();
  },

  _renderPanel() {
    if (!this._els) return;
    const esc = (s) => this._esc(s);
    const rows = this.listMeasurements();
    this._els.list.innerHTML = rows.length ? rows.map((row, idx) => `
      <div class="measurement-row">
        <strong>${esc(row.label || this._t('measureN', { n: idx + 1 }))}</strong>
        <span>
          ${row.status === 'out-of-frame' ? esc(this._t('outOfFrame')) : `${this._fmt(row.distance)} µm`}<br>
          <small>${esc(row.mode === 'follow-cells' ? this._t('followCells') : this._t('snapshot'))} · ${esc((row.metadata?.tracks || row.cells || []).join(' → '))}</small>
        </span>
        <span class="related-actions">
          <button class="btn btn-ghost btn-sm" type="button" data-tm-action="toggle" data-measurement-id="${esc(row.id)}"><i data-lucide="${row.visible === false ? 'eye-off' : 'eye'}"></i></button>
          <button class="btn btn-ghost btn-sm" type="button" data-tm-action="delete" data-measurement-id="${esc(row.id)}"><i data-lucide="trash-2"></i></button>
        </span>
      </div>`).join('') : esc(this._t('noMeasure'));
    this._ctx.ui.createIcons({ nodes: [this._els.list] });

    const data = this._T.getData();
    if (!data || !this._draft.length) { this._els.status.innerHTML = esc(this._t('measureDesc')); return; }
    const first = this._draft[0];
    this._els.status.innerHTML = `
      <div class="metric-tile"><small>${esc(this._t('cellA'))}</small><strong>${esc(data.trackIds[first])}</strong></div>
      <div class="text-xs text-muted">${esc(this._t('clickSecond'))}</div>`;
  },

  _export(format) {
    const rows = this.listMeasurements();
    if (!rows.length) return;
    const text = format === 'csv' ? MeasurementStore.toCsv(rows) : MeasurementStore.toJson(rows);
    const meta = this._ctx.dataset.getMeta();
    const name = String(meta?.name || this._ctx.dataset.getId() || 'tracking').replace(/[^a-z0-9._-]+/gi, '_').replace(/^_+|_+$/g, '');
    this._ctx.ui.downloadText(text, `${name}_cell_distances.${format}`, format === 'csv' ? 'text/csv' : 'application/json');
  },

  _fmt(v) { return Number.isFinite(v) ? v.toFixed(v >= 10 ? 1 : 2) : '—'; },

  _applyLabels() {
    if (!this._panel) return;
    this._panel.root.querySelectorAll('[data-tm]').forEach(el => { el.textContent = this._t(el.getAttribute('data-tm')); });
    this._renderPanel();
  }
});
