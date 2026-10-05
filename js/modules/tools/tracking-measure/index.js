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
  _group: null,            // um-space group under the volume cube (o = (p - acqMin) / acqSize - 0.5)
  _umGroup: null,
  _spheres: [],            // pooled meshes, reused across redraws
  _cylinders: [],
  _sphereGeometry: null,
  _cylinderGeometry: null,
  _materials: new Map(),   // colour -> shared material
  _unsubLang: null,
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
      this._T.on('frame', () => {
        // Only a follow-cells row or a pending first pick depends on the frame.
        if (this._draft.length || this._measurements.some(r => r.mode === 'follow-cells')) this._renderAll();
      }),
      this._T.on('refresh', () => this._draw()),
      this._T.on('style', () => this._draw()),
      ctx.tools.onChange((tool) => this._onTool(tool))
    ];
    this._bindCanvas();
    this._unsubLang = ctx.i18n.onLanguageChange?.(() => this._applyLabels()) || null;
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
    this._unsubLang?.();
    this._unsubLang = null;
    this._ac?.abort?.();
    this._ac = null;
    const canvas = this._ctx?.ui.getCanvas?.();
    if (canvas && canvas.style.cursor === 'crosshair') canvas.style.cursor = '';
    this._destroyGroup();
    this._panel?.remove();
    this._panel = null;
    this._els = null;
    this._draft = [];
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
      // A hidden layer is not clickable.
      if ((this._T.getStyle() || {}).visible === false) return;
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
    this._umGroup = new THREE.Group();
    this._group.add(this._umGroup);
    parent.add(this._group);
    this._sphereGeometry = new THREE.SphereGeometry(1, 12, 8);
    this._cylinderGeometry = new THREE.CylinderGeometry(1, 1, 1, 8);
    return true;
  },

  _destroyGroup() {
    if (!this._group) return;
    this._T?.getVolumeObject()?.remove(this._group);
    this._sphereGeometry?.dispose?.();
    this._cylinderGeometry?.dispose?.();
    this._materials.forEach(m => m.dispose());
    this._materials.clear();
    this._spheres = []; this._cylinders = [];
    this._group = null; this._umGroup = null;
    this._sphereGeometry = null; this._cylinderGeometry = null;
  },

  _material(color) {
    const key = String(color);
    let m = this._materials.get(key);
    if (!m) {
      m = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.95, depthTest: false, depthWrite: false });
      this._materials.set(key, m);
    }
    return m;
  },

  /** The pooled mesh number `i` of a list, created on first use. */
  _pooled(list, i, geometry) {
    let mesh = list[i];
    if (!mesh) {
      mesh = new THREE.Mesh(geometry, this._material('#ffffff'));
      list.push(mesh);
      this._umGroup.add(mesh);
    }
    mesh.visible = true;
    return mesh;
  },

  /** Everything is drawn in micrometres under a group that maps um to the cube's
   *  object space, so a sphere of radius r um and a cylinder of radius r um are
   *  round in the specimen whatever the acquisition box proportions. */
  _fitUmGroup(space) {
    const A = space.min, S = space.size;
    this._umGroup.scale.set(1 / S.x, 1 / S.y, 1 / S.z);
    this._umGroup.position.set(-A.x / S.x - 0.5, -A.y / S.y - 0.5, -A.z / S.z - 0.5);
  },

  _draw() {
    const space = this._T.getAcquisitionSpace();
    if (!this._T.getData() || !space || !this._ensureGroup()) return;
    this._fitUmGroup(space);
    const style = this._T.getStyle() || {};
    const oa = this._oa || (this._oa = new THREE.Vector3());
    const ob = this._ob || (this._ob = new THREE.Vector3());
    const up = this._up || (this._up = new THREE.Vector3(0, 1, 0));
    const dir = this._dir || (this._dir = new THREE.Vector3());
    let spheres = 0, cylinders = 0;
    const sphere = (p, radius, color) => {
      const m = this._pooled(this._spheres, spheres++, this._sphereGeometry);
      m.material = this._material(color);
      m.position.set(p[0], p[1], p[2]);
      m.scale.setScalar(radius);
    };
    if (style.visible !== false) {
      for (const row of this.listMeasurements()) {
        if (row.visible === false || row.points.length !== 2) continue;
        const pa = row.points[0], pb = row.points[1];
        this._T.umToObject(oa.set(pa[0], pa[1], pa[2]), oa);
        this._T.umToObject(ob.set(pb[0], pb[1], pb[2]), ob);
        if (!this._T.isInsideClip(oa) && !this._T.isInsideClip(ob)) continue;
        const color = row.color || '#ff4d4f';
        dir.set(pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]);
        const length = dir.length();
        if (length > 0) {
          const seg = this._pooled(this._cylinders, cylinders++, this._cylinderGeometry);
          seg.material = this._material(color);
          seg.position.set((pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2, (pa[2] + pb[2]) / 2);
          seg.quaternion.setFromUnitVectors(up, dir.divideScalar(length));
          seg.scale.set(this.LINE_RADIUS_UM, length, this.LINE_RADIUS_UM);
        }
        sphere(pa, this.MARKER_RADIUS_UM, color);
        sphere(pb, this.MARKER_RADIUS_UM, color);
      }
      if (this._draft.length === 1) {
        const p = this._T.positionUm(this._draft[0], this._T.getFrame());
        if (p) sphere(p, this.MARKER_RADIUS_UM, '#ff9f43');
      }
    }
    for (let i = spheres; i < this._spheres.length; i++) this._spheres[i].visible = false;
    for (let i = cylinders; i < this._cylinders.length; i++) this._cylinders[i].visible = false;
    this._group.visible = spheres + cylinders > 0;
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
