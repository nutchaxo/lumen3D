/* Tracking Inspector — index.js
 *
 * The "inspect" tool of a tracked timelapse: click a cell (or type its id) and
 * the sidebar describes it — track, region, life span, path length, net
 * displacement, straightness, mean speed — with its lineage (parent, daughters,
 * each a click away) and its neighbours at the current frame. Two optional 3D
 * layers ride along: the neighbour network of the selected cell and a velocity
 * field over every cell, both drawn as children of the volume cube so they
 * follow orbit, clipping and stabilisation like the centroids.
 *
 * Everything is computed from the packed tables the overlay already holds
 * (ctx.tracking.getData) — no second copy of tracks.json, and every number is
 * in the frame of reference on screen (stabilised or raw).
 */
PluginRegistry.implement('tracking-inspector', {
  _ctx: null,
  _T: null,
  _section: null,
  _els: null,
  _unsubs: [],
  _ac: null,
  _showNeighbors: false,
  _showVelocity: false,
  _neighborGroup: null,
  _neighborLines: null,
  _neighborGeometry: null,
  _neighborMaterial: null,
  _velocityGroup: null,
  _pending: null,          // a workspace selection waiting for the tracks
  _pointerStart: null,

  THRESHOLDS: [35, 55, 85, 120],
  MAX_ARROWS: 260,
  MAX_NEIGHBOR_LINES: 24,

  _t(key, params) { return this._ctx.i18n.t(key, params); },
  _esc(s) { return this._ctx.ui.escapeHtml(s); },

  init(ctx) {
    this._ctx = ctx;
    this._T = ctx.tracking;
    if (!this._T || !this._T.isAvailable()) return this;
    this._section = ctx.ui.addSidebarSection({
      id: 'tracking-inspector',
      title: this._t('title'),
      html: this._html(),
      bind: (body) => this._bind(body)
    });
    this._unsubs = [
      this._T.on('loaded', () => { this._applyPending(); this._renderAll(); }),
      this._T.on('frame', () => this._renderDynamic()),
      this._T.on('refresh', () => this._rebuild3d()),
      this._T.on('style', () => this._rebuild3d()),
      this._T.on('selection', () => this._renderAll()),
      this._T.on('options', () => { this._syncThreshold(); this._renderAll(); }),
      ctx.tools.onChange((tool) => this._onTool(tool))
    ];
    this._bindCanvas();
    ctx.i18n.onLanguageChange?.(() => this._applyLabels());
    this._renderAll();
    return this;
  },

  // ── Workspace state ───────────────────────────────────────

  getState() {
    const data = this._T?.getData();
    const c = this._T?.getSelected() ?? -1;
    return {
      selectedId: (data && c >= 0) ? String(data.ids[c]) : null,
      showNeighbors: this._showNeighbors,
      showVelocity: this._showVelocity,
      neighborThresholdUm: this._T?.getOptions().neighborThresholdUm
    };
  },

  setState(s) {
    if (!s || typeof s !== 'object' || !this._T) return;
    if (typeof s.showNeighbors === 'boolean') this._showNeighbors = s.showNeighbors;
    if (typeof s.showVelocity === 'boolean') this._showVelocity = s.showVelocity;
    if (Number.isFinite(s.neighborThresholdUm)) this._T.setOptions({ neighborThresholdUm: s.neighborThresholdUm });
    this._syncControls();
    if (s.selectedId !== undefined) {
      this._pending = s.selectedId;
      this._applyPending();
    }
    this._renderAll();
  },

  reset() {
    this._showNeighbors = false;
    this._showVelocity = false;
    this._pending = null;
    this._T?.setOptions({ neighborThresholdUm: 55 });
    this._T?.select(-1);
    this._syncControls();
    this._renderAll();
  },

  /** Download Center entries — only meaningful once a cell is selected. */
  getExports() {
    const c = this._T?.getSelected() ?? -1;
    const on = c >= 0 && Boolean(this._T.getData());
    return [
      { action: 'tracking-track-csv', icon: 'route', label: this._t('exportTrack'), enabled: on, handler: () => this._exportTrack() },
      { action: 'tracking-neighbors-csv', icon: 'network', label: this._t('neighborsCsv'), enabled: on, handler: () => this._exportNeighbors() },
      { action: 'tracking-lineage-json', icon: 'git-branch', label: this._t('lineageJson'), enabled: on, handler: () => this._exportLineage() }
    ];
  },

  dispose() {
    this._unsubs.forEach(fn => fn());
    this._unsubs = [];
    this._ac?.abort?.();
    this._destroy3d();
    this._section?.remove();
    this._section = null;
  },

  // ── Analysis (pure functions of the packed tables) ────────

  /** Whole-track metrics of cell `c`, in the frame of reference on screen. */
  cellMetrics(c, data = this._T.getData()) {
    if (!data || c < 0 || c >= data.cellTotal) return null;
    const first = data.firstFrame[c], last = data.lastFrame[c];
    const a = [0, 0, 0], b = [0, 0, 0];
    let pathLength = 0;
    let prev = null;
    let frames = 0;
    for (let f = first; f <= last; f++) {
      if (!this._T.positionUm(c, f, {}, a)) continue;
      frames++;
      if (prev) pathLength += Math.hypot(a[0] - prev[0], a[1] - prev[1], a[2] - prev[2]);
      prev = prev || [0, 0, 0];
      prev[0] = a[0]; prev[1] = a[1]; prev[2] = a[2];
    }
    const start = this._T.positionUm(c, first, {}, a);
    const end = this._T.positionUm(c, last, {}, b);
    const displacement = (start && end && frames > 1) ? Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) : 0;
    const t = data.timepoints;
    const duration = (frames > 1 && t && t.length > last) ? Math.max(1e-6, t[last] - t[first]) : 1;
    return {
      index: c,
      id: String(data.ids[c]),
      trackId: data.trackIds[c],
      region: data.regions[c],
      frames, firstFrame: first, lastFrame: last,
      pathLength, displacement,
      straightness: pathLength > 0 ? displacement / pathLength : 0,
      meanSpeed: pathLength / duration,          // um per timepoint unit
      isMitosis: Boolean(data.flags[c] & 1),
      isFusion: Boolean(data.flags[c] & 2)
    };
  },

  /** Cells within the neighbour radius of `c` at `frame`, nearest first. */
  neighborRows(c, frame, maxRows = 16, data = this._T.getData()) {
    if (!data || c < 0) return [];
    const p = this._T.positionUm(c, frame);
    if (!p) return [];
    const radius = this._T.getOptions().neighborThresholdUm;
    const q = [0, 0, 0];
    const rows = [];
    for (const other of this._T.cellsAt(frame)) {
      if (other === c || !this._T.positionUm(other, frame, {}, q)) continue;
      const distance = Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]);
      if (distance > radius) continue;
      rows.push({ index: other, id: String(data.ids[other]), trackId: data.trackIds[other], region: data.regions[other], distance });
    }
    rows.sort((x, y) => x.distance - y.distance);
    return rows.slice(0, maxRows);
  },

  lineage(c, data = this._T.getData()) {
    if (!data || c < 0) return null;
    const brief = (i) => ({ index: i, id: String(data.ids[i]), trackId: data.trackIds[i], region: data.regions[i] });
    const parent = data.parent[c];
    const daughters = [];
    for (let k = data.daughterStart[c]; k < data.daughterStart[c + 1]; k++) daughters.push(brief(data.daughterIdx[k]));
    return { ...brief(c), parent: parent >= 0 ? brief(parent) : null, daughters, metrics: this.cellMetrics(c, data) };
  },

  /** A cell by its key, its id or its Imaris track id. */
  findCell(query, data = this._T.getData()) {
    if (!data) return -1;
    const s = String(query ?? '').trim();
    if (!s) return -1;
    for (let c = 0; c < data.cellTotal; c++) {
      if (String(data.ids[c]) === s || String(data.trackIds[c]) === s) return c;
    }
    return -1;
  },

  /** Per-frame speed of every cell present at `frame` and the next, fastest first. */
  velocityRows(frame, maxRows = this.MAX_ARROWS, data = this._T.getData()) {
    if (!data) return [];
    const a = [0, 0, 0], b = [0, 0, 0];
    const dt = (data.timepoints && data.timepoints.length > frame + 1)
      ? Math.max(1e-6, data.timepoints[frame + 1] - data.timepoints[frame]) : 1;
    const rows = [];
    for (const c of this._T.cellsAt(frame)) {
      if (!this._T.positionUm(c, frame, {}, a) || !this._T.positionUm(c, frame + 1, {}, b)) continue;
      const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
      const speed = Math.hypot(dx, dy, dz) / dt;
      if (speed <= 0) continue;
      rows.push({ index: c, speed, x: a[0], y: a[1], z: a[2], dx, dy, dz });
    }
    rows.sort((x, y) => y.speed - x.speed);
    return rows.slice(0, maxRows);
  },

  trackCsv(c, data = this._T.getData()) {
    if (!data || c < 0) return '';
    const rows = [['timepoint', 'x', 'y', 'z', 'raw_x', 'raw_y', 'raw_z']];
    const s = [0, 0, 0], r = [0, 0, 0];
    for (let f = data.firstFrame[c]; f <= data.lastFrame[c]; f++) {
      if (!this._T.positionUm(c, f, { stabilized: true }, s)) continue;
      this._T.positionUm(c, f, { stabilized: false }, r);
      rows.push([data.timepoints[f], s[0], s[1], s[2], r[0], r[1], r[2]]);
    }
    return this._csv(rows);
  },

  // ── Private: selection ────────────────────────────────────

  _applyPending() {
    if (this._pending === null || this._pending === undefined) return;
    const data = this._T.getData();
    if (!data) return;
    const c = this._findByKey(this._pending, data);
    this._pending = null;
    this._T.select(c);
  },

  _findByKey(key, data) {
    const s = String(key);
    for (let c = 0; c < data.cellTotal; c++) if (String(data.ids[c]) === s) return c;
    return this.findCell(s, data);
  },

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
      if (!start || this._ctx.tools.current() !== 'inspect') return;
      // A drag orbits the volume; only a still click picks.
      if (Math.hypot(e.clientX - start.x, e.clientY - start.y) >= 6) return;
      const c = this._T.pick(e.clientX, e.clientY);
      if (c >= 0) this._T.select(c);
    }, opts);
  },

  _onTool(tool) {
    const canvas = this._ctx.ui.getCanvas?.();
    if (canvas) canvas.style.cursor = tool === 'inspect' ? 'crosshair' : '';
  },

  // ── Private: 3D layers ────────────────────────────────────

  _ensure3d() {
    const parent = this._T.getVolumeObject();
    if (!parent) return false;
    if (!this._neighborGroup) {
      this._neighborGeometry = new THREE.BufferGeometry();
      const cap = this.MAX_NEIGHBOR_LINES * 2 * 3;
      const pos = new THREE.BufferAttribute(new Float32Array(cap), 3);
      const col = new THREE.BufferAttribute(new Float32Array(cap), 3);
      pos.setUsage(THREE.DynamicDrawUsage); col.setUsage(THREE.DynamicDrawUsage);
      this._neighborGeometry.setAttribute('position', pos);
      this._neighborGeometry.setAttribute('color', col);
      this._neighborGeometry.setDrawRange(0, 0);
      this._neighborMaterial = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.85, depthTest: false, depthWrite: false });
      this._neighborLines = new THREE.LineSegments(this._neighborGeometry, this._neighborMaterial);
      this._neighborLines.frustumCulled = false;
      this._neighborGroup = new THREE.Group();
      this._neighborGroup.renderOrder = 41;
      this._neighborGroup.add(this._neighborLines);
      parent.add(this._neighborGroup);
    }
    if (!this._velocityGroup) {
      this._velocityGroup = new THREE.Group();
      this._velocityGroup.renderOrder = 41;
      parent.add(this._velocityGroup);
    }
    return true;
  },

  _clearGroup(group) {
    while (group.children.length) {
      const child = group.children[group.children.length - 1];
      group.remove(child);
      child.line?.geometry?.dispose?.(); child.line?.material?.dispose?.();
      child.cone?.geometry?.dispose?.(); child.cone?.material?.dispose?.();
    }
  },

  _destroy3d() {
    const parent = this._T?.getVolumeObject();
    if (this._neighborGroup) { parent?.remove(this._neighborGroup); this._neighborGeometry?.dispose?.(); this._neighborMaterial?.dispose?.(); }
    if (this._velocityGroup) { this._clearGroup(this._velocityGroup); parent?.remove(this._velocityGroup); }
    this._neighborGroup = null; this._neighborLines = null; this._neighborGeometry = null; this._neighborMaterial = null;
    this._velocityGroup = null;
  },

  _rebuild3d() {
    if (!this._T.getData() || !this._ensure3d()) return;
    this._rebuildNeighbors();
    this._rebuildVelocity();
    this._T.triggerRender();
  },

  _rebuildNeighbors() {
    const data = this._T.getData();
    const c = this._T.getSelected();
    const style = this._T.getStyle() || {};
    const geometry = this._neighborGeometry;
    let n = 0;
    if (this._showNeighbors && c >= 0 && style.visible !== false) {
      const frame = this._T.getFrame();
      const origin = this._T.positionObject(c, frame, new THREE.Vector3());
      const radius = this._T.getOptions().neighborThresholdUm;
      const pos = geometry.attributes.position.array, col = geometry.attributes.color.array;
      const v = new THREE.Vector3(), color = new THREE.Color();
      if (origin) {
        for (const row of this.neighborRows(c, frame, this.MAX_NEIGHBOR_LINES, data)) {
          if (!this._T.positionObject(row.index, frame, v)) continue;
          if (!this._T.isInsideClip(v) && !this._T.isInsideClip(origin)) continue;
          color.set(row.distance <= radius * 0.55 ? 0x00a654 : 0x00d2ff);
          const o = n * 3;
          pos[o] = origin.x; pos[o + 1] = origin.y; pos[o + 2] = origin.z;
          pos[o + 3] = v.x; pos[o + 4] = v.y; pos[o + 5] = v.z;
          col[o] = color.r; col[o + 1] = color.g; col[o + 2] = color.b;
          col[o + 3] = color.r; col[o + 4] = color.g; col[o + 5] = color.b;
          n += 2;
        }
      }
    }
    geometry.setDrawRange(0, n);
    geometry.attributes.position.needsUpdate = true;
    geometry.attributes.color.needsUpdate = true;
    this._neighborGroup.visible = n > 0;
  },

  _rebuildVelocity() {
    this._clearGroup(this._velocityGroup);
    const style = this._T.getStyle() || {};
    if (!this._showVelocity || style.visible === false) { this._velocityGroup.visible = false; return; }
    const data = this._T.getData();
    const space = this._T.getAcquisitionSpace();
    if (!space) return;
    const S = space.size;
    const frame = this._T.getFrame();
    const rows = this.velocityRows(frame, this.MAX_ARROWS, data);
    const maxSpeed = Math.max(1e-6, ...rows.map(r => r.speed));
    const origin = new THREE.Vector3(), dir = new THREE.Vector3();
    for (const row of rows) {
      const flags = data.flags[row.index];
      if (style.showMitosis === false && (flags & 1)) continue;
      if (style.showFusion === false && (flags & 2)) continue;
      if (!this._T.positionObject(row.index, frame, origin) || !this._T.isInsideClip(origin)) continue;
      // Length in micrometres (4–48 um, growing with speed), expressed in the
      // cube's object space: a um vector divides by the acquisition size per axis.
      const lengthUm = Math.max(4, Math.min(48, row.speed * 0.75));
      const norm = Math.hypot(row.dx, row.dy, row.dz) || 1;
      dir.set(row.dx / norm * lengthUm / S.x, row.dy / norm * lengthUm / S.y, row.dz / norm * lengthUm / S.z);
      const length = dir.length();
      if (length <= 0) continue;
      const color = new THREE.Color().setHSL(0.58 - Math.min(1, row.speed / maxSpeed) * 0.58, 0.95, 0.56);
      const arrow = new THREE.ArrowHelper(dir.clone().normalize(), origin.clone(), length, color, length * 0.28, length * 0.16);
      arrow.line.material.depthTest = false; arrow.cone.material.depthTest = false;
      arrow.line.material.transparent = true; arrow.cone.material.transparent = true;
      this._velocityGroup.add(arrow);
    }
    this._velocityGroup.visible = this._velocityGroup.children.length > 0;
  },

  // ── Private: rendering ────────────────────────────────────

  _renderAll() {
    this._renderInspector();
    this._renderLineage();
    this._renderNeighbors();
    this._rebuild3d();
  },

  _renderDynamic() {
    this._renderNeighbors();
    this._renderInspector();
    this._rebuild3d();
  },

  _speedText(m) {
    const meta = this._ctx.dataset.getMeta();
    const perFrame = `${this._fmt(m.meanSpeed)} ${this._t('umPerFrame')}`;
    const minutes = Number(meta?.timeline?.intervalMinutes);
    if (Number.isFinite(minutes) && minutes > 0) return `${perFrame} · ${this._fmt(m.meanSpeed / minutes)} ${this._t('umPerMin')}`;
    return perFrame;
  },

  _renderInspector() {
    const node = this._els?.inspector;
    if (!node) return;
    const c = this._T.getSelected();
    const data = this._T.getData();
    if (c < 0 || !data) { node.innerHTML = this._esc(this._t('inspectorDesc')); return; }
    const m = this.cellMetrics(c, data);
    const neighbors = this.neighborRows(c, this._T.getFrame(), 4, data);
    const esc = (s) => this._esc(s);
    node.innerHTML = `
      <div class="metric-grid">
        <div class="metric-tile"><small>${esc(this._t('cell'))}</small><strong>${esc(m.id)}</strong></div>
        <div class="metric-tile"><small>${esc(this._t('track'))}</small><strong>${esc(m.trackId)}</strong></div>
        <div class="metric-tile"><small>${esc(this._t('region'))}</small><strong>${esc(m.region)}</strong></div>
        <div class="metric-tile"><small>${esc(this._t('lifeSpan'))}</small><strong>${m.firstFrame + 1}–${m.lastFrame + 1} · ${m.frames}</strong></div>
        <div class="metric-tile"><small>${esc(this._t('meanSpeed'))}</small><strong>${esc(this._speedText(m))}</strong></div>
        <div class="metric-tile"><small>${esc(this._t('pathLength'))}</small><strong>${this._fmt(m.pathLength)} µm</strong></div>
        <div class="metric-tile"><small>${esc(this._t('displacement'))}</small><strong>${this._fmt(m.displacement)} µm</strong></div>
        <div class="metric-tile"><small>${esc(this._t('straightness'))}</small><strong>${this._fmt(m.straightness)}</strong></div>
        <div class="metric-tile"><small>${esc(this._t('events'))}</small><strong>${esc(m.isMitosis ? this._t('mitosis') : (m.isFusion ? this._t('fusion') : '—'))}</strong></div>
      </div>
      <div>
        <strong>${esc(this._t('nearest'))}</strong>
        <div class="text-xs text-muted mt-1">
          ${neighbors.length ? neighbors.map(n => `<a href="#" data-ti-cell="${n.index}">${esc(this._t('cellN', { id: n.id }))}</a> (${this._fmt(n.distance)} µm)`).join(' &middot; ') : esc(this._t('noNeighborNow'))}
        </div>
      </div>
      <button class="btn btn-outline btn-sm" type="button" id="ti-export-track"><i data-lucide="download"></i> ${esc(this._t('exportTrack'))}</button>`;
    node.querySelector('#ti-export-track')?.addEventListener('click', () => this._exportTrack());
    this._ctx.ui.createIcons({ nodes: [node] });
  },

  _renderLineage() {
    const node = this._els?.lineage;
    if (!node) return;
    const c = this._T.getSelected();
    const data = this._T.getData();
    if (c < 0 || !data) { node.innerHTML = this._esc(this._t('lineageDesc')); return; }
    const lineage = this.lineage(c, data);
    // The cell id, not the track id: in an Imaris export the whole lineage shares
    // one track id, so mother and daughters would all read the same.
    const row = (label, item) => item
      ? `<div class="lineage-node"><span>${this._esc(label)}</span><span><a href="#" data-ti-cell="${item.index}"><strong>${this._esc(this._t('cellN', { id: item.id }))}</strong></a><br><small>${this._esc(item.region)} · ${this._esc(this._t('trackN', { id: item.trackId }))}</small></span></div>`
      : `<div class="lineage-node"><span>${this._esc(label)}</span><span class="text-muted">${this._esc(this._t('none'))}</span></div>`;
    node.innerHTML = row(this._t('parent'), lineage.parent) + row(this._t('cell'), lineage)
      + (lineage.daughters.length
        ? lineage.daughters.map((d, i) => row(this._t('daughterN', { n: i + 1 }), d)).join('')
        : `<div class="text-xs text-muted">${this._esc(this._t('noDaughter'))}</div>`);
  },

  _renderNeighbors() {
    const node = this._els?.neighbors;
    if (!node) return;
    const c = this._T.getSelected();
    if (c < 0 || !this._T.getData()) { node.innerHTML = this._esc(this._t('neighborDesc')); return; }
    const rows = this.neighborRows(c, this._T.getFrame(), 10);
    if (!rows.length) { node.innerHTML = this._esc(this._t('noNeighbors')); return; }
    node.innerHTML = rows.map((r, i) => `
      <div class="neighbor-row">
        <strong>${i + 1}. <a href="#" data-ti-cell="${r.index}">${this._esc(this._t('cellN', { id: r.id }))}</a></strong>
        <span>${this._fmt(r.distance)} µm<br><small>${this._esc(r.region)} · ${this._esc(this._t('trackN', { id: r.trackId }))}</small></span>
      </div>`).join('');
  },

  // ── Private: exports ──────────────────────────────────────

  _exportTrack() {
    const c = this._T.getSelected();
    const data = this._T.getData();
    if (c < 0 || !data) return;
    this._ctx.ui.downloadText(this.trackCsv(c, data), `${this._safeName()}_${data.ids[c]}_track.csv`, 'text/csv');
  },

  _exportNeighbors() {
    const c = this._T.getSelected();
    const data = this._T.getData();
    if (c < 0 || !data) return;
    const frame = this._T.getFrame();
    const rows = [['selected_track', 'timepoint', 'neighbor_track', 'neighbor_id', 'region', 'distance_um']];
    this.neighborRows(c, frame, 500, data).forEach(r => {
      rows.push([data.trackIds[c], data.timepoints[frame], r.trackId, r.id, r.region, r.distance]);
    });
    this._ctx.ui.downloadText(this._csv(rows), `${this._safeName()}_${data.ids[c]}_neighbors.csv`, 'text/csv');
  },

  _exportLineage() {
    const c = this._T.getSelected();
    const data = this._T.getData();
    if (c < 0 || !data) return;
    const payload = {
      version: 2,
      datasetId: this._ctx.dataset.getId(),
      exportedAt: new Date().toISOString(),
      coordinateSpace: this._T.isStabilized() ? 'stabilized' : 'raw',
      lineage: this.lineage(c, data)
    };
    this._ctx.ui.downloadText(JSON.stringify(payload, null, 2), `${this._safeName()}_${data.ids[c]}_lineage.json`, 'application/json');
  },

  _csv(rows) {
    return rows.map(row => row.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
  },

  _safeName() {
    const meta = this._ctx.dataset.getMeta();
    return String(meta?.name || this._ctx.dataset.getId() || 'tracking').replace(/[^a-z0-9._-]+/gi, '_').replace(/^_+|_+$/g, '');
  },

  _fmt(v) { return Number.isFinite(v) ? v.toFixed(v >= 10 ? 1 : 2) : '—'; },

  // ── Private: sidebar ──────────────────────────────────────

  _html() {
    const esc = (s) => this._esc(s);
    const threshold = this._T.getOptions().neighborThresholdUm;
    return `
      <div class="flex items-center gap-2">
        <input type="text" id="ti-find" class="form-input flex-1 text-sm p-1.5 rounded border border-light bg-surface text-primary" placeholder="${esc(this._t('findPlaceholder'))}" data-ti-placeholder="findPlaceholder">
        <button class="btn btn-primary btn-sm" type="button" id="ti-find-btn" data-ti="findBtn">${esc(this._t('findBtn'))}</button>
      </div>
      <div id="ti-find-status" class="text-xs text-muted" style="min-height:16px;"></div>
      <div id="ti-inspector" class="tracking-inspector text-muted text-sm">${esc(this._t('inspectorDesc'))}</div>
      <div class="tracking-tool-stack">
        <label class="tool-toggle"><input type="checkbox" id="ti-velocity"><span><i data-lucide="move-3d"></i> <span data-ti="velocityField">${esc(this._t('velocityField'))}</span></span></label>
        <label class="tool-toggle"><input type="checkbox" id="ti-neighbors"><span><i data-lucide="network"></i> <span data-ti="neighborNetwork">${esc(this._t('neighborNetwork'))}</span></span></label>
        <label class="text-xs text-muted"><span data-ti="neighborDist">${esc(this._t('neighborDist'))}</span>
          <select id="ti-threshold" class="form-select text-sm p-1 rounded border border-light bg-surface text-primary" style="width:100%;">
            ${this.THRESHOLDS.map(v => `<option value="${v}" ${v === threshold ? 'selected' : ''}>${v} µm</option>`).join('')}
          </select>
        </label>
        <div class="tracking-tool-actions">
          <button class="btn btn-outline btn-sm" type="button" id="ti-export-neighbors"><i data-lucide="table"></i> <span data-ti="neighborsCsv">${esc(this._t('neighborsCsv'))}</span></button>
          <button class="btn btn-outline btn-sm" type="button" id="ti-export-lineage"><i data-lucide="git-branch"></i> <span data-ti="lineageJson">${esc(this._t('lineageJson'))}</span></button>
        </div>
      </div>
      <div class="panel-title" style="margin-top:var(--space-2);" data-ti="lineageTree">${esc(this._t('lineageTree'))}</div>
      <div id="ti-lineage" class="tracking-science-box text-muted text-sm">${esc(this._t('lineageDesc'))}</div>
      <div class="panel-title" style="margin-top:var(--space-2);" data-ti="neighborTitle">${esc(this._t('neighborTitle'))}</div>
      <div id="ti-neighbors-list" class="tracking-science-box text-muted text-sm">${esc(this._t('neighborDesc'))}</div>`;
  },

  _bind(body) {
    const $ = (id) => body.querySelector(`#${id}`);
    this._els = {
      find: $('ti-find'), findBtn: $('ti-find-btn'), findStatus: $('ti-find-status'),
      inspector: $('ti-inspector'), velocity: $('ti-velocity'), neighborsToggle: $('ti-neighbors'),
      threshold: $('ti-threshold'), lineage: $('ti-lineage'), neighbors: $('ti-neighbors-list')
    };
    const find = () => {
      const q = this._els.find.value.trim();
      if (!q) return;
      const c = this.findCell(q);
      if (c >= 0) {
        this._T.select(c);
        this._els.findStatus.textContent = this._t('foundCell', { id: q, track: this._T.getData().trackIds[c] });
        this._els.findStatus.style.color = 'var(--color-success)';
      } else {
        this._els.findStatus.textContent = this._t('cellNotFound', { id: q });
        this._els.findStatus.style.color = 'var(--color-error)';
      }
    };
    this._els.findBtn?.addEventListener('click', find);
    this._els.find?.addEventListener('keyup', (e) => { if (e.key === 'Enter') find(); });
    this._els.velocity?.addEventListener('change', () => { this._showVelocity = this._els.velocity.checked; this._rebuild3d(); });
    this._els.neighborsToggle?.addEventListener('change', () => { this._showNeighbors = this._els.neighborsToggle.checked; this._rebuild3d(); });
    this._els.threshold?.addEventListener('change', () => {
      this._T.setOptions({ neighborThresholdUm: Number(this._els.threshold.value) });
    });
    $('ti-export-neighbors')?.addEventListener('click', () => this._exportNeighbors());
    $('ti-export-lineage')?.addEventListener('click', () => this._exportLineage());
    // Any track id painted in the section is a link to that cell.
    body.addEventListener('click', (e) => {
      const link = e.target.closest?.('[data-ti-cell]');
      if (!link) return;
      e.preventDefault();
      this._T.select(Number(link.getAttribute('data-ti-cell')));
    });
    this._syncControls();
  },

  _syncThreshold() {
    if (this._els?.threshold) this._els.threshold.value = String(this._T.getOptions().neighborThresholdUm);
  },

  _syncControls() {
    if (!this._els) return;
    if (this._els.velocity) this._els.velocity.checked = this._showVelocity;
    if (this._els.neighborsToggle) this._els.neighborsToggle.checked = this._showNeighbors;
    this._syncThreshold();
  },

  _applyLabels() {
    if (!this._section) return;
    this._section.setTitle(this._t('title'));
    this._section.body.querySelectorAll('[data-ti]').forEach(el => { el.textContent = this._t(el.getAttribute('data-ti')); });
    this._section.body.querySelectorAll('[data-ti-placeholder]').forEach(el => { el.placeholder = this._t(el.getAttribute('data-ti-placeholder')); });
    this._renderAll();
  }
});
