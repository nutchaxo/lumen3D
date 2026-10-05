/* Tracking Surface — index.js
 *
 * The specimen surface the tracking analysis exported (model.glb: one mesh per
 * timepoint, in the raw and in the stabilised frame), shown INSIDE the volume.
 * The GLB vertices are acquisition micrometres, the same space as the tracks,
 * so the group holding them is simply the um -> object-space transform of the
 * cube (o = (p - acqMin) / acqSize - 0.5): a scale and a translation, parented
 * to the volume object. Orbit, pan, physical aspect ratio, Z display scale and
 * stabilisation therefore apply exactly as they do to the volume and the points.
 *
 * Colouring: uniform, local cell density (a Gaussian kernel around the tracked
 * cells of the current frame, or a _DENSITY attribute baked into the mesh), or
 * region (nearest tracked cell's region), each smoothed over the mesh. The cells
 * are bucketed in a uniform grid so a vertex only visits its neighbourhood, the
 * mesh adjacency and the vertex positions in um are computed once per mesh, and the
 * colour attribute is rewritten in place; the pass is memoised on every input that
 * can change it.
 *
 * Clipping: the surface follows the volume's own clip box (Z-stack slab, clip
 * sliders) by default, and an oblique cut plane with a filled cap can be added.
 * Clipping planes are world-space in three.js, and the cube rotates under the
 * camera, so the planes are re-expressed in world space right before each draw.
 *
 * GLTFLoader (three's own, vendored) is fetched on first use with the integrity
 * digest the platform pins for it — the viewer page does not carry it.
 */
PluginRegistry.implement('tracking-surface', {
  _ctx: null,
  _T: null,
  _active: false,
  _section: null,
  _legend: null,
  _els: null,
  _unsubs: [],
  _loader: null,          // promise of the GLTFLoader script
  _loading: null,         // promise of the model
  _group: null,           // um-space group under the volume object
  _glb: null,
  _variants: { raw: [], stab: [] },
  _matUniform: null,
  _matVertex: null,
  _planes: [],            // the array shared by every material (mutated in place)
  _cutPlane: null,
  _capGroup: null,
  _helper: null,
  _capKey: null,
  _colorSig: null,
  _legendKey: null,
  _legendState: null,
  _meshData: new WeakMap(),   // mesh -> { umPos, adjStart, adjList, attr, scratch*, ... }
  _luts: {},                  // colormap -> Float32Array(256 * 3)
  _boxPlanes: [],             // six volume-box planes, object space (reused)
  _planePool: [],             // world-space planes handed to the materials (reused)
  _planeCount: -1,
  _lastSyncFrame: -1,
  _cutCache: null,
  _bounds: null,          // { min, max, center, span } in um
  _opts: {
    opacity: 0.55, colorMode: 'density', colormap: 'viridis', followVolumeClip: true,
    clip: { enabled: false, mode: 'xy', value: 1, yaw: 0, pitch: 0 }
  },

  LOADER_SRC: 'js/vendor/three-GLTFLoader.js',
  LOADER_SRI: 'sha384-FassWWYNEPQsuRQm+59KIMcDetEc30bNyE9yfx16Ok8lvoowyH81LtrPmLWltJMh',
  COLOR_MAPS: {
    viridis: ['#440154', '#31688e', '#35b779', '#fde725'],
    magma: ['#000004', '#51127c', '#b63679', '#fc8961'],
    plasma: ['#0d0887', '#9c179e', '#bd3786', '#ed7953', '#f0f921'],
    inferno: ['#000004', '#57106e', '#bb3754', '#f98d0a'],
    turbo: ['#23171b', '#4a58dd', '#2f9df5', '#27d7c4', '#4df884', '#95fb51', '#dedd32', '#ffa423', '#f65f18', '#c9220a', '#7a0403'],
    coolwarm: ['#3b4cc0', '#8caff6', '#dddddd', '#f49a7b', '#b40426'],
    gray: ['#000000', '#ffffff']
  },
  CUT_COLOR: '#00d2ff',

  _t(key, params) { return this._ctx.i18n.t(key, params); },
  _esc(s) { return this._ctx.ui.escapeHtml(s); },

  init(ctx) {
    this._ctx = ctx;
    this._T = ctx.tracking;
    if (!this._T || !this._T.isAvailable()) return this;
    this._section = ctx.ui.addSidebarSection({
      id: 'tracking-surface',
      title: this._t('title'),
      html: this._html(),
      hidden: true,
      bind: (body) => this._bind(body)
    });
    const container = ctx.ui.getCanvasContainer?.();
    if (container) {
      this._legend = document.createElement('div');
      this._legend.className = 'viewer-legend hidden';
      this._legend.id = 'tracking-surface-legend';
      container.appendChild(this._legend);
    }
    this._unsubs = [
      this._T.on('loaded', () => this._update()),
      this._T.on('frame', () => this._update()),
      this._T.on('refresh', () => this._update()),
      this._T.on('style', () => { this._colorSig = null; this._update(); }),
      this._T.on('options', () => { this._colorSig = null; this._update(); })
    ];
    this._unsubLang = ctx.i18n.onLanguageChange?.(() => { this._applyLabels(); this._legendKey = null; this._renderLegend(); }) || null;
    return this;
  },

  activate() {
    this._setActive(!this._active);
    return { active: this._active };
  },

  // ── Workspace state ───────────────────────────────────────

  getState() { return { active: this._active, ...this._opts, clip: { ...this._opts.clip } }; },

  setState(s) {
    if (!s || typeof s !== 'object') return;
    if (Number.isFinite(s.opacity)) this._opts.opacity = Math.max(0, Math.min(1, s.opacity));
    if (['uniform', 'density', 'region'].includes(s.colorMode)) this._opts.colorMode = s.colorMode;
    if (this.COLOR_MAPS[s.colormap]) this._opts.colormap = s.colormap;
    if (typeof s.followVolumeClip === 'boolean') this._opts.followVolumeClip = s.followVolumeClip;
    if (s.clip && typeof s.clip === 'object') this._opts.clip = this._normalizeClip({ ...this._opts.clip, ...s.clip });
    this._colorSig = null;
    this._capKey = null;
    this._syncControls();
    this._setActive(Boolean(s.active));
    PluginRegistry.syncToolbarButton('tracking-surface', { active: this._active });
  },

  reset() {
    this._opts = {
      opacity: 0.55, colorMode: 'density', colormap: 'viridis', followVolumeClip: true,
      clip: { enabled: false, mode: 'xy', value: 1, yaw: 0, pitch: 0 }
    };
    this._colorSig = null;
    this._capKey = null;
    this._syncControls();
    this._setActive(false);
    PluginRegistry.syncToolbarButton('tracking-surface', { active: false });
  },

  dispose() {
    this._unsubs.forEach(fn => fn());
    this._unsubs = [];
    this._unsubLang?.();
    this._unsubLang = null;
    this._destroyModel();
    this._dropLegendListener();
    this._legend?.remove();
    this._legend = null;
    this._legendKey = null;
    this._section?.remove();
    this._section = null;
    this._els = null;
    this._active = false;
  },

  // ── Private: activation & loading ─────────────────────────

  _setActive(on) {
    // A workspace saved on a tracked timelapse can reach a dataset without the
    // block: there is no model to fetch, so the state is ignored.
    if (on && !this._T.isAvailable()) on = false;
    this._active = Boolean(on);
    if (this._section) this._section.root.hidden = !this._active;
    if (this._active) {
      this._ensureModel().then(() => this._update()).catch(err => {
        console.warn('[tracking-surface] model unavailable:', err);
        this._ctx.ui.toast(this._t('loadFailed'));
        this._active = false;
        if (this._section) this._section.root.hidden = true;
        PluginRegistry.syncToolbarButton('tracking-surface', { active: false });
      });
    } else {
      if (this._group) this._group.visible = false;
      this._legend?.classList.add('hidden');
      this._T.triggerRender();
    }
  },

  _ensureLoader() {
    if (typeof THREE !== 'undefined' && THREE.GLTFLoader) return Promise.resolve(THREE.GLTFLoader);
    if (this._loader) return this._loader;
    this._loader = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = this.LOADER_SRC;
      script.integrity = this.LOADER_SRI;
      script.crossOrigin = 'anonymous';
      script.onload = () => (THREE.GLTFLoader ? resolve(THREE.GLTFLoader) : reject(new Error('GLTFLoader did not register')));
      script.onerror = () => reject(new Error('GLTFLoader failed to load'));
      document.head.appendChild(script);
    }).catch(err => { this._loader = null; throw err; });
    return this._loader;
  },

  async _fetchModel(url) {
    if ('DecompressionStream' in window) {
      try {
        const gz = await fetch(`${url}.gz`, { cache: 'no-store' });
        if (gz.ok && gz.body) {
          return await new Response(gz.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
        }
      } catch (_) { /* fall through to the plain file */ }
    }
    const resp = await fetch(url, { cache: 'no-store' });
    if (!resp.ok) throw new Error(`HTTP ${resp.status} on ${url}`);
    return await resp.arrayBuffer();
  },

  _ensureModel() {
    if (this._glb) return Promise.resolve(this._glb);
    if (this._loading) return this._loading;
    const meta = this._T.getMeta() || {};
    const url = `${this._ctx.dataset.getBasePath()}/${meta.surfacePath || 'model.glb'}`;
    this._loading = Promise.all([this._ensureLoader(), this._fetchModel(url), this._T.whenLoaded()])
      .then(([Loader, bytes]) => new Promise((resolve, reject) => {
        new Loader().parse(bytes, `${this._ctx.dataset.getBasePath()}/`, resolve, reject);
      }))
      .then((gltf) => { this._attach(gltf); return this._glb; })
      .finally(() => { this._loading = null; });
    return this._loading;
  },

  _attach(gltf) {
    const parent = this._T.getVolumeObject();
    const space = this._T.getAcquisitionSpace();
    if (!parent || !space) throw new Error('no volume to attach to');
    this._destroyModel();
    const renderer = this._T.getRenderer();
    if (renderer) {
      this._prevLocalClipping = renderer.localClippingEnabled;
      renderer.localClippingEnabled = true;
    }

    this._matUniform = new THREE.MeshBasicMaterial({ color: 0x87ceeb, transparent: true, opacity: this._opts.opacity, side: THREE.DoubleSide, depthWrite: false });
    this._matVertex = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: this._opts.opacity, side: THREE.DoubleSide, depthWrite: false });
    this._planes = [];
    this._matUniform.clippingPlanes = this._planes;
    this._matVertex.clippingPlanes = this._planes;
    this._boxPlanes = Array.from({ length: 6 }, () => new THREE.Plane());
    this._planePool = Array.from({ length: 7 }, () => new THREE.Plane());
    this._planeCount = -1;
    this._lastSyncFrame = -1;

    // um -> cube object space: o = (p - min) / size - 0.5
    const A = space.min, S = space.size;
    this._group = new THREE.Group();
    this._group.scale.set(1 / S.x, 1 / S.y, 1 / S.z);
    this._group.position.set(-A.x / S.x - 0.5, -A.y / S.y - 0.5, -A.z / S.z - 0.5);
    this._group.renderOrder = 38;
    this._glb = gltf.scene;
    this._group.add(this._glb);
    this._capGroup = new THREE.Group();
    this._group.add(this._capGroup);
    parent.add(this._group);

    const box = new THREE.Box3();
    this._variants = { raw: [], stab: [] };
    this._glb.updateMatrixWorld(true);
    this._glb.traverse((child) => {
      if (!child.isMesh) return;
      child.userData.originalMaterial = child.material;
      child.material = this._matUniform;
      child.visible = false;
      child.frustumCulled = false;
      child.onBeforeRender = (renderer) => this._syncPlanes(renderer);
      const info = this._parseVariant(child.name || child.parent?.name || '');
      if (!info) return;
      child.userData.surfaceVariant = info;
      this._variants[info.space].push({ ...info, mesh: child });
      box.expandByObject(child);
    });
    ['raw', 'stab'].forEach(space => this._variants[space].sort((a, b) => a.frameValue - b.frameValue));
    if (!this._variants.raw.length && !this._variants.stab.length) throw new Error('model.glb carries no surface variant');
    const size = box.getSize(new THREE.Vector3());
    this._bounds = { min: box.min.clone(), max: box.max.clone(), center: box.getCenter(new THREE.Vector3()), span: Math.max(size.x, size.y, size.z, 1) };
    this._colorSig = null;
    this._capKey = null;
  },

  _destroyModel() {
    this._clearCap();
    if (this._group) {
      this._T?.getVolumeObject()?.remove(this._group);
      this._group.traverse((o) => {
        if (!o.isMesh) return;
        o.onBeforeRender = () => {};
        o.geometry?.dispose?.();
        const own = o.userData.originalMaterial;
        if (own && own !== this._matUniform && own !== this._matVertex) own.dispose?.();
      });
    }
    this._meshData = new WeakMap();
    this._matUniform?.dispose?.();
    this._matVertex?.dispose?.();
    const renderer = this._T?.getRenderer?.();
    if (renderer && this._prevLocalClipping !== undefined) renderer.localClippingEnabled = this._prevLocalClipping;
    this._prevLocalClipping = undefined;
    this._group = null; this._glb = null; this._capGroup = null; this._helper = null;
    this._matUniform = null; this._matVertex = null;
    this._variants = { raw: [], stab: [] };
    this._planes = []; this._cutCache = null; this._planeCount = -1; this._lastSyncFrame = -1;
    this._bounds = null; this._colorSig = null; this._capKey = null;
  },

  /** raw_tp_12_0 / stab_interp_tp_12_5 -> which space, which frame (0-based, tenths). */
  _parseVariant(name = '') {
    const m = /^(raw|stab)(_interp)?_tp_(\d+)_(\d+)/i.exec(name);
    if (!m) return null;
    const tp = Number(m[3]), frac = Number(m[4]);
    return {
      space: m[1].toLowerCase(), interpolated: Boolean(m[2]), tp, frac,
      frameValue: Math.max(0, (tp - 1) + frac / 10),
      key: `${m[1].toLowerCase()}:${m[2] ? 'interp' : 'base'}:${tp}:${frac}`
    };
  },

  // ── Private: per-frame update ─────────────────────────────

  _visibleEntries() {
    const space = this._T.isStabilized() ? 'stab' : 'raw';
    let entries = this._variants[space];
    if (!entries.length) entries = this._variants[space === 'stab' ? 'raw' : 'stab'];
    if (!entries.length) return [];
    const base = entries.filter(e => !e.interpolated);
    const pool = base.length ? base : entries;
    const target = this._T.getFrame();
    let best = [], bestDistance = Infinity;
    for (const entry of pool) {
      const d = Math.abs(entry.frameValue - target);
      if (d + 1e-6 < bestDistance) { bestDistance = d; best = [entry]; }
      else if (Math.abs(d - bestDistance) < 1e-6) best.push(entry);
    }
    return best;
  },

  _update() {
    if (!this._active || !this._glb || !this._T.getData()) return;
    const style = this._T.getStyle() || {};
    const visible = this._visibleEntries();
    const active = new Set(visible.map(e => e.mesh.uuid));
    this._glb.traverse((child) => {
      if (child.isMesh && child.userData.surfaceVariant) child.visible = active.has(child.uuid);
    });
    this._group.visible = style.visible !== false && visible.length > 0;
    this._matUniform.opacity = this._opts.opacity;
    this._matVertex.opacity = this._opts.opacity;
    this._matUniform.depthWrite = this._opts.opacity >= 0.999;
    this._matVertex.depthWrite = this._opts.opacity >= 0.999;
    this._colorSurfaces(visible.map(e => e.mesh));
    this._updateCut(visible.map(e => e.mesh));
    this._renderLegend();
    this._T.triggerRender();
  },

  // ── Private: colouring ────────────────────────────────────

  /** Tracked cells of the current frame as flat tables: um positions in the
   *  group's space (xyz triplets) and region indices. */
  _cellRows() {
    const data = this._T.getData();
    const style = this._T.getStyle() || {};
    const frame = this._T.getFrame();
    const cells = this._T.cellsAt(frame);
    const pos = new Float32Array(cells.length * 3);
    const region = new Int32Array(cells.length);
    const scratch = [0, 0, 0];
    let n = 0;
    for (const c of cells) {
      const flags = data.flags[c];
      if (style.showMitosis === false && (flags & 1)) continue;
      if (style.showFusion === false && (flags & 2)) continue;
      const p = this._T.positionUm(c, frame, {}, scratch);
      if (!p) continue;
      pos[n * 3] = p[0]; pos[n * 3 + 1] = p[1]; pos[n * 3 + 2] = p[2];
      region[n] = data.regionIdx[c];
      n++;
    }
    return { n, pos, region };
  },

  /** Uniform bucket grid over the cell rows: a vertex only visits the buckets
   *  around it instead of every cell. `size` is the bucket edge in um. */
  _buildGrid(rows, size) {
    const cells = new Map();
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < rows.n; i++) {
      const ix = Math.floor(rows.pos[i * 3] / size), iy = Math.floor(rows.pos[i * 3 + 1] / size), iz = Math.floor(rows.pos[i * 3 + 2] / size);
      const key = this._gridKey(ix, iy, iz);
      const bucket = cells.get(key);
      if (bucket) bucket.push(i); else cells.set(key, [i]);
      if (ix < lo[0]) lo[0] = ix; if (ix > hi[0]) hi[0] = ix;
      if (iy < lo[1]) lo[1] = iy; if (iy > hi[1]) hi[1] = iy;
      if (iz < lo[2]) lo[2] = iz; if (iz > hi[2]) hi[2] = iz;
    }
    return { cells, size, lo, hi };
  },

  _gridKey(ix, iy, iz) { return ((ix + 4096) * 8192 + (iy + 4096)) * 8192 + (iz + 4096); },

  /** Per-mesh data that depends on the geometry alone: vertex positions in the
   *  group's um space, the vertex adjacency (CSR, one entry per triangle edge so
   *  the weighting equals a per-triangle accumulation) and the colour buffers. */
  _meshCache(mesh) {
    let d = this._meshData.get(mesh);
    const geo = mesh.geometry;
    const pos = geo?.attributes?.position;
    if (!pos) return null;
    if (d && d.count === pos.count) return d;
    const count = pos.count;
    const e = this._umMatrix(mesh).elements;
    const umPos = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      // p' = M . (x, y, z, 1), M column-major
      umPos[i * 3] = e[0] * x + e[4] * y + e[8] * z + e[12];
      umPos[i * 3 + 1] = e[1] * x + e[5] * y + e[9] * z + e[13];
      umPos[i * 3 + 2] = e[2] * x + e[6] * y + e[10] * z + e[14];
    }
    const index = geo.index?.array;
    const triCount = index ? Math.floor(index.length / 3) : Math.floor(count / 3);
    const at = (t, k) => (index ? index[t * 3 + k] : t * 3 + k);
    const adjStart = new Uint32Array(count + 1);
    for (let t = 0; t < triCount; t++) {
      for (let k = 0; k < 3; k++) adjStart[at(t, k) + 1] += 2;
    }
    for (let i = 0; i < count; i++) adjStart[i + 1] += adjStart[i];
    const adjList = new Uint32Array(adjStart[count]);
    const fill = adjStart.slice(0, count);
    for (let t = 0; t < triCount; t++) {
      const a = at(t, 0), b = at(t, 1), c = at(t, 2);
      adjList[fill[a]++] = b; adjList[fill[a]++] = c;
      adjList[fill[b]++] = a; adjList[fill[b]++] = c;
      adjList[fill[c]++] = a; adjList[fill[c]++] = b;
    }
    d = { count, umPos, adjStart, adjList, raw: new Float32Array(count * 3), tmp: new Float32Array(count * 3),
      attr: new THREE.BufferAttribute(new Float32Array(count * 3), 3), values: new Float32Array(count) };
    this._meshData.set(mesh, d);
    return d;
  },

  /** 256-entry colour table of a colormap, built once. */
  _lut(name) {
    const key = this.COLOR_MAPS[name] ? name : 'viridis';
    let lut = this._luts[key];
    if (lut) return lut;
    lut = new Float32Array(256 * 3);
    const stops = this.COLOR_MAPS[key].map(c => new THREE.Color(c));
    const tmp = new THREE.Color();
    for (let i = 0; i < 256; i++) {
      const scaled = (i / 255) * (stops.length - 1);
      const k = Math.min(stops.length - 2, Math.floor(scaled));
      tmp.copy(stops[k]).lerp(stops[k + 1], scaled - k);
      lut[i * 3] = tmp.r; lut[i * 3 + 1] = tmp.g; lut[i * 3 + 2] = tmp.b;
    }
    this._luts[key] = lut;
    return lut;
  },

  _colorSurfaces(meshes) {
    const style = this._T.getStyle() || {};
    const mode = this._opts.colorMode;
    // A baked density is a property of the mesh: the tracked cells (hence the
    // frame, the stabilisation, the neighbour radius and the filters) only matter
    // when the colour is computed from them.
    const fromCells = mode === 'region' || (mode === 'density' && meshes.some(m => !this._bakedDensity(m)));
    const sig = [mode, this._opts.colormap, fromCells ? this._T.getFrame() : '', fromCells ? this._T.isStabilized() : '',
      fromCells ? this._T.getOptions().neighborThresholdUm : '', fromCells ? style.showMitosis : '', fromCells ? style.showFusion : '',
      meshes.map(m => m.uuid).sort().join(',')].join('|');
    if (sig === this._colorSig) return;
    this._colorSig = sig;
    if (mode === 'uniform') {
      meshes.forEach(m => { m.material = this._matUniform; });
      this._legendState = { kind: 'uniform' };
      return;
    }
    const rows = fromCells ? this._cellRows() : null;
    if (mode === 'region') {
      const grid = rows.n ? this._buildGrid(rows, 40) : null;
      meshes.forEach(m => {
        const d = grid ? this._meshCache(m) : null;
        if (d) { this._regionColors(d, rows, grid); this._applyColors(m, d); m.material = this._matVertex; }
        else m.material = this._matUniform;
      });
      this._legendState = { kind: 'region' };
      return;
    }
    // density
    const sigma = Math.max(8, Math.min(54, this._T.getOptions().neighborThresholdUm * 0.52));
    const grid = rows && rows.n ? this._buildGrid(rows, Math.max(18, sigma * 2.8)) : null;
    const computed = [];
    let total = 0;
    meshes.forEach(m => {
      const d = this._meshCache(m);
      if (!d) return;
      const baked = this._bakedDensity(m);
      if (baked) { computed.push({ mesh: m, d, baked }); return; }
      if (!grid) { computed.push({ mesh: m, d, values: null }); return; }
      this._kernelDensity(d, rows, grid, sigma);
      computed.push({ mesh: m, d, values: d.values });
      total += d.count;
    });
    let stats = null;
    if (total) {
      const all = new Float32Array(total);
      let o = 0;
      computed.forEach(c => { if (c.values) { all.set(c.values, o); o += c.d.count; } });
      stats = this._densityStats(all);
    }
    const lut = this._lut(this._opts.colormap);
    computed.forEach(({ mesh, d, values, baked }) => {
      if (baked) { this._bakedColors(baked, d, lut); this._applyColors(mesh, d); mesh.material = this._matVertex; return; }
      if (!values || !stats) { mesh.material = this._matUniform; return; }
      this._densityColors(values, stats, d, lut);
      this._applyColors(mesh, d);
      mesh.material = this._matVertex;
    });
    this._legendState = { kind: 'density', min: stats?.p10 ?? 0, max: stats?.p90 ?? 1 };
  },

  /** Smooth the raw colours of `d`, write them into the mesh's own colour
   *  attribute and flag it for upload. The attribute is created once per mesh. */
  _applyColors(mesh, d) {
    this._smooth(d, d.raw, d.attr.array);
    if (mesh.geometry.attributes.color !== d.attr) mesh.geometry.setAttribute('color', d.attr);
    d.attr.needsUpdate = true;
  },

  _bakedDensity(mesh) {
    const attrs = mesh.geometry?.attributes || {};
    if (attrs._DENSITY) return attrs._DENSITY;
    if (attrs._density) return attrs._density;
    if (attrs.density) return attrs.density;
    return null;
  },

  _bakedColors(attr, d, lut) {
    const out = d.raw;
    const n = Math.min(attr.count, d.count);
    for (let i = 0; i < n; i++) {
      const raw = attr.array[i];
      const t = Math.max(0, Math.min(1, raw > 1 ? raw / 255 : raw));
      const k = Math.round(t * 255) * 3;
      out[i * 3] = lut[k]; out[i * 3 + 1] = lut[k + 1]; out[i * 3 + 2] = lut[k + 2];
    }
  },

  /** Gaussian kernel density of the tracked cells at each vertex:
   *    rho(v) = sum_c exp(-|v - c|^2 / (2 sigma^2))   for |v - c| <= 2.8 sigma
   *  The kernel width follows the shared neighbour radius, so "dense" means the
   *  same thing here and in the neighbour network. The grid bucket edge equals the
   *  cut-off radius, so the 27 buckets around a vertex hold every contributor. */
  _kernelDensity(d, rows, grid, sigma) {
    const radius = Math.max(18, sigma * 2.8);
    const radiusSq = radius * radius;
    const inv2s2 = 1 / (2 * sigma * sigma);
    const { umPos, values, count } = d;
    const { cells, size } = grid;
    const rp = rows.pos;
    for (let i = 0; i < count; i++) {
      const x = umPos[i * 3], y = umPos[i * 3 + 1], z = umPos[i * 3 + 2];
      const cx = Math.floor(x / size), cy = Math.floor(y / size), cz = Math.floor(z / size);
      let density = 0;
      for (let ix = cx - 1; ix <= cx + 1; ix++) for (let iy = cy - 1; iy <= cy + 1; iy++) for (let iz = cz - 1; iz <= cz + 1; iz++) {
        const bucket = cells.get(this._gridKey(ix, iy, iz));
        if (!bucket) continue;
        for (let b = 0; b < bucket.length; b++) {
          const r = bucket[b] * 3;
          const dx = x - rp[r], dy = y - rp[r + 1], dz = z - rp[r + 2];
          const dSq = dx * dx + dy * dy + dz * dz;
          if (dSq > radiusSq) continue;
          density += Math.exp(-dSq * inv2s2);
        }
      }
      values[i] = density;
    }
  },

  /** Colour of the region of the nearest tracked cell, found by growing square
   *  shells of buckets until no closer cell can exist: a cell in shell r+1 is at
   *  least r * size away. */
  _regionColors(d, rows, grid) {
    const data = this._T.getData();
    const palette = data.regionColors.map(hex => new THREE.Color(hex));
    const fallback = new THREE.Color(0x9aa4b3);
    const { umPos, raw, count } = d;
    const { cells, size, lo, hi } = grid;
    const rp = rows.pos;
    for (let i = 0; i < count; i++) {
      const x = umPos[i * 3], y = umPos[i * 3 + 1], z = umPos[i * 3 + 2];
      const cx = Math.floor(x / size), cy = Math.floor(y / size), cz = Math.floor(z / size);
      const maxR = Math.max(Math.abs(cx - lo[0]), Math.abs(cx - hi[0]), Math.abs(cy - lo[1]), Math.abs(cy - hi[1]),
        Math.abs(cz - lo[2]), Math.abs(cz - hi[2]));
      let best = Infinity, nearest = -1;
      for (let r = 0; r <= maxR; r++) {
        for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) {
          const edge = Math.abs(dx) === r || Math.abs(dy) === r;
          // Interior columns of a shell only touch its two caps (dz = +-r).
          const step = edge || r === 0 ? 1 : 2 * r;
          for (let dz = -r; dz <= r; dz += step) {
            const bucket = cells.get(this._gridKey(cx + dx, cy + dy, cz + dz));
            if (!bucket) continue;
            for (let b = 0; b < bucket.length; b++) {
              const k = bucket[b] * 3;
              const ex = x - rp[k], ey = y - rp[k + 1], ez = z - rp[k + 2];
              const dSq = ex * ex + ey * ey + ez * ez;
              if (dSq < best) { best = dSq; nearest = rows.region[bucket[b]]; }
            }
          }
        }
        const reach = r * size;
        if (best <= reach * reach) break;
      }
      const c = nearest >= 0 && palette[nearest] ? palette[nearest] : fallback;
      raw[i * 3] = c.r; raw[i * 3 + 1] = c.g; raw[i * 3 + 2] = c.b;
    }
  },

  _densityStats(values) {
    let n = 0;
    for (let i = 0; i < values.length; i++) if (Number.isFinite(values[i])) n++;
    if (!n) return null;
    const sorted = new Float32Array(n);
    for (let i = 0, o = 0; i < values.length; i++) if (Number.isFinite(values[i])) sorted[o++] = values[i];
    sorted.sort();
    return {
      min: sorted[0], max: sorted[n - 1],
      p10: sorted[Math.floor((n - 1) * 0.1)],
      p90: sorted[Math.floor((n - 1) * 0.9)]
    };
  },

  _densityColors(values, stats, d, lut) {
    const low = stats.p10, high = stats.p90, out = d.raw;
    const span = high - low;
    for (let i = 0; i < d.count; i++) {
      const t = span > 0 ? Math.max(0, Math.min(1, (values[i] - low) / span)) : 0;
      const k = Math.round(t * 255) * 3;
      out[i * 3] = lut[k]; out[i * 3 + 1] = lut[k + 1]; out[i * 3 + 2] = lut[k + 2];
    }
  },

  /** Laplacian smoothing of vertex colours over the mesh adjacency, so triangle
   *  boundaries do not read as colour steps:
   *    c'_i = (1 - blend) c_i + blend * mean(c_i, c_j for j in N(i)).
   *  Ping-pongs between the mesh's scratch buffer and `out` (the last pass lands in
   *  `out`), so nothing is allocated. */
  _smooth(d, src, out, iterations = 2, blend = 0.5) {
    const { count, adjStart, adjList } = d;
    let from = src;
    for (let it = 0; it < iterations; it++) {
      const to = (iterations - 1 - it) % 2 === 0 ? out : d.tmp;
      for (let i = 0; i < count; i++) {
        const s = adjStart[i], e = adjStart[i + 1];
        const r0 = from[i * 3], g0 = from[i * 3 + 1], b0 = from[i * 3 + 2];
        if (s === e) { to[i * 3] = r0; to[i * 3 + 1] = g0; to[i * 3 + 2] = b0; continue; }
        let r = r0, g = g0, b = b0;
        for (let k = s; k < e; k++) { const j = adjList[k] * 3; r += from[j]; g += from[j + 1]; b += from[j + 2]; }
        const inv = blend / (e - s + 1);
        to[i * 3] = r0 * (1 - blend) + r * inv;
        to[i * 3 + 1] = g0 * (1 - blend) + g * inv;
        to[i * 3 + 2] = b0 * (1 - blend) + b * inv;
      }
      from = to;
    }
    return out;
  },

  /** Vertex position of `mesh` in the group's um space (independent of the cube's
   *  orbit): group^-1 . mesh.world. */
  _umMatrix(mesh) {
    this._group.updateWorldMatrix(true, false);
    mesh.updateWorldMatrix(true, false);
    return new THREE.Matrix4().copy(this._group.matrixWorld).invert().multiply(mesh.matrixWorld);
  },

  // ── Private: clipping ─────────────────────────────────────

  _normalizeClip(spec = {}) {
    return {
      enabled: Boolean(spec.enabled),
      mode: ['xy', 'xz', 'yz', 'oblique'].includes(spec.mode) ? spec.mode : 'xy',
      value: Number.isFinite(spec.value) ? Math.max(0, Math.min(1, spec.value)) : 1,
      yaw: Number.isFinite(spec.yaw) ? spec.yaw : 0,
      pitch: Number.isFinite(spec.pitch) ? Math.max(-89, Math.min(89, spec.pitch)) : 0
    };
  },

  _cutNormal(spec = this._opts.clip) {
    if (spec.mode === 'yz') return new THREE.Vector3(1, 0, 0);
    if (spec.mode === 'xz') return new THREE.Vector3(0, 1, 0);
    if (spec.mode === 'oblique') {
      const yaw = THREE.MathUtils.degToRad(spec.yaw || 0), pitch = THREE.MathUtils.degToRad(spec.pitch || 0);
      return new THREE.Vector3(Math.cos(pitch) * Math.sin(yaw), Math.sin(pitch), Math.cos(pitch) * Math.cos(yaw)).normalize();
    }
    return new THREE.Vector3(0, 0, 1);
  },

  /** The cut plane in the group's um space. Everything BEYOND the plane along its
   *  normal is removed, so 100 % keeps the whole surface and sliding down cuts
   *  into it. Recomputed only when the clip spec or the surface bounds change;
   *  callers must copy it before transforming it. */
  _cutPlaneUm() {
    const spec = this._opts.clip;
    if (!spec.enabled || !this._bounds) return null;
    const c = this._cutCache;
    if (c && c.mode === spec.mode && c.value === spec.value && c.yaw === spec.yaw && c.pitch === spec.pitch && c.bounds === this._bounds) return c.plane;
    const n = this._cutNormal(spec);
    const q = this._bounds.center.clone().addScaledVector(n, (spec.value - 0.5) * this._bounds.span);
    // Keep p where n.(q - p) >= 0  <=>  (-n).p + n.q >= 0
    const plane = new THREE.Plane(n.clone().negate(), n.dot(q));
    this._cutCache = { mode: spec.mode, value: spec.value, yaw: spec.yaw, pitch: spec.pitch, bounds: this._bounds, plane };
    return plane;
  },

  /** The volume's clip box (Z-stack slab, clip sliders) as six planes in the
   *  CUBE's object space, mirroring the shader's own test. Fills the reused
   *  `_boxPlanes`; false when the volume has no clip uniforms. */
  _fillVolumeBoxPlanes() {
    const material = this._ctx.viewer.getMaterial?.();
    const u = material?.uniforms;
    if (!u || !u.clipMin || !u.clipMax) return false;
    const lo = this._lo || (this._lo = new THREE.Vector3());
    const hi = this._hi || (this._hi = new THREE.Vector3());
    const tmp = this._tmpV || (this._tmpV = new THREE.Vector3());
    if (this._T.isStabilized() && u.clipBoxMin && u.clipBoxSize) {
      lo.copy(u.clipBoxMin.value).add(tmp.copy(u.clipMin.value).multiply(u.clipBoxSize.value));
      hi.copy(u.clipBoxMin.value).add(tmp.copy(u.clipMax.value).multiply(u.clipBoxSize.value));
    } else {
      lo.copy(u.clipMin.value).subScalar(0.5);
      hi.copy(u.clipMax.value).subScalar(0.5);
    }
    const P = this._boxPlanes;
    P[0].set(tmp.set(1, 0, 0), -lo.x); P[1].set(tmp.set(-1, 0, 0), hi.x);
    P[2].set(tmp.set(0, 1, 0), -lo.y); P[3].set(tmp.set(0, -1, 0), hi.y);
    P[4].set(tmp.set(0, 0, 1), -lo.z); P[5].set(tmp.set(0, 0, -1), hi.z);
    return true;
  },

  /** Re-express the clipping planes in WORLD space for this draw. Runs from the
   *  meshes' onBeforeRender, so the cube's current orbit is what gets used; the
   *  work is done once per render call, not once per visible mesh. */
  _syncPlanes(renderer) {
    if (!this._group) return;
    const cube = this._T.getVolumeObject();
    if (!cube) return;
    const frame = renderer?.info?.render?.frame;
    if (Number.isFinite(frame) && frame === this._lastSyncFrame) return;
    this._lastSyncFrame = Number.isFinite(frame) ? frame : -1;
    const pool = this._planePool;
    let n = 0;
    if (this._opts.followVolumeClip && this._fillVolumeBoxPlanes()) {
      cube.updateWorldMatrix(true, false);
      for (let i = 0; i < 6; i++) pool[n++].copy(this._boxPlanes[i]).applyMatrix4(cube.matrixWorld);
    }
    const cut = this._cutPlaneUm();
    if (cut) {
      this._group.updateWorldMatrix(true, false);
      pool[n++].copy(cut).applyMatrix4(this._group.matrixWorld);
    }
    // Mutate the shared array in place: both materials point at it.
    this._planes.length = 0;
    for (let i = 0; i < n; i++) this._planes.push(pool[i]);
    // three.js caches the projected planes per material; a change of COUNT needs
    // a program refresh, a change of values does not.
    if (this._matUniform && this._planeCount !== n) {
      this._planeCount = n;
      this._matUniform.needsUpdate = true;
      this._matVertex.needsUpdate = true;
    }
  },

  _updateCut(meshes) {
    if (!this._capGroup) return;
    const plane = this._cutPlaneUm();
    const key = plane ? [this._opts.clip.mode, this._opts.clip.value, this._opts.clip.yaw, this._opts.clip.pitch,
      meshes.map(m => m.uuid).sort().join(',')].join('|') : 'disabled';
    if (key === this._capKey) return;
    this._capKey = key;
    this._clearCap();
    if (!plane || !this._bounds) return;

    // A translucent sheet showing where the cut is…
    const n = plane.normal.clone().negate();
    const q = this._bounds.center.clone().addScaledVector(n, (this._opts.clip.value - 0.5) * this._bounds.span);
    const side = this._bounds.span * 1.15;
    this._helper = new THREE.Mesh(new THREE.PlaneGeometry(side, side),
      new THREE.MeshBasicMaterial({ color: this.CUT_COLOR, transparent: true, opacity: 0.18, side: THREE.DoubleSide, depthWrite: false }));
    this._helper.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
    this._helper.position.copy(q);
    this._capGroup.add(this._helper);

    // …and the filled section: the mesh/plane intersection segments, in the
    // plane's own 2D frame, chained into closed contours; nested contours are
    // holes (even-odd), so a lumen or a notch stays empty.
    const helper = Math.abs(n.y) > 0.8 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
    const right = helper.clone().cross(n).normalize();
    const up = n.clone().cross(right).normalize();
    const segments = [];
    meshes.forEach(mesh => this._planeSegments(mesh, plane, q, right, up, segments));
    const regions = this._nestLoops(this._assembleLoops(segments));
    if (!regions.length) return;
    const shapes = regions.map(({ outer, holes }) => {
      const shape = new THREE.Shape(outer.map(p => new THREE.Vector2(p.x, p.y)));
      holes.forEach(h => shape.holes.push(new THREE.Path(h.map(p => new THREE.Vector2(p.x, p.y)))));
      return shape;
    });
    const basis = new THREE.Matrix4().makeBasis(right, up, n).setPosition(q);
    const cap = new THREE.Mesh(new THREE.ShapeGeometry(shapes),
      new THREE.MeshBasicMaterial({ color: this.CUT_COLOR, transparent: true, opacity: 0.5, side: THREE.DoubleSide, depthWrite: false }));
    cap.applyMatrix4(basis);
    this._capGroup.add(cap);
    const outline = [];
    regions.forEach(({ outer, holes }) => [outer, ...holes].forEach(loop => {
      for (let i = 0; i < loop.length; i++) {
        const a = loop[i], b = loop[(i + 1) % loop.length];
        outline.push(a.x, a.y, 0, b.x, b.y, 0);
      }
    }));
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(outline, 3));
    const edge = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.95 }));
    edge.applyMatrix4(basis);
    this._capGroup.add(edge);
  },

  _clearCap() {
    if (!this._capGroup) { this._helper = null; return; }
    while (this._capGroup.children.length) {
      const child = this._capGroup.children[this._capGroup.children.length - 1];
      this._capGroup.remove(child);
      child.geometry?.dispose?.(); child.material?.dispose?.();
    }
    this._helper = null;
  },

  /** Triangle/plane intersection segments of `mesh`, appended to `out` as
   *  x0, y0, x1, y1 in the plane's frame (origin `q`, axes `right`, `up`). A
   *  triangle contributes the two distinct points where it crosses the plane. */
  _planeSegments(mesh, plane, q, right, up, out) {
    const d = this._meshCache(mesh);
    if (!d) return;
    const index = mesh.geometry.index?.array;
    const triCount = index ? Math.floor(index.length / 3) : Math.floor(d.count / 3);
    const P = d.umPos;
    const nx = plane.normal.x, ny = plane.normal.y, nz = plane.normal.z, k = plane.constant;
    const eps = 1e-4;
    const hits = [];
    for (let t = 0; t < triCount; t++) {
      const ia = (index ? index[t * 3] : t * 3) * 3, ib = (index ? index[t * 3 + 1] : t * 3 + 1) * 3, ic = (index ? index[t * 3 + 2] : t * 3 + 2) * 3;
      const da = nx * P[ia] + ny * P[ia + 1] + nz * P[ia + 2] + k;
      const db = nx * P[ib] + ny * P[ib + 1] + nz * P[ib + 2] + k;
      const dc = nx * P[ic] + ny * P[ic + 1] + nz * P[ic + 2] + k;
      if ((da > eps && db > eps && dc > eps) || (da < -eps && db < -eps && dc < -eps)) continue;
      hits.length = 0;
      this._edgeHit(P, ia, ib, da, db, eps, hits);
      this._edgeHit(P, ib, ic, db, dc, eps, hits);
      this._edgeHit(P, ic, ia, dc, da, eps, hits);
      // A vertex lying on the plane is hit by both of its edges: keep distinct points.
      const distinct = [];
      for (const h of hits) {
        if (!distinct.some(g => (g[0] - h[0]) ** 2 + (g[1] - h[1]) ** 2 + (g[2] - h[2]) ** 2 < 1e-8)) distinct.push(h);
      }
      // Three distinct points = a triangle lying in the plane: no crossing line.
      if (distinct.length !== 2) continue;
      for (const h of distinct) {
        const rx = h[0] - q.x, ry = h[1] - q.y, rz = h[2] - q.z;
        out.push(rx * right.x + ry * right.y + rz * right.z, rx * up.x + ry * up.y + rz * up.z);
      }
    }
  },

  /** Where edge (a, b) of signed distances (da, db) meets the plane. The edge is
   *  evaluated from its lexicographically smaller end, so the two triangles that
   *  share it compute the identical point and their segments chain exactly. */
  _edgeHit(P, ia, ib, da, db, eps, hits) {
    if (Math.abs(da) <= eps && Math.abs(db) <= eps) { hits.push([P[ia], P[ia + 1], P[ia + 2]], [P[ib], P[ib + 1], P[ib + 2]]); return; }
    if ((da > eps && db > eps) || (da < -eps && db < -eps)) return;
    if (Math.abs(da - db) <= eps) return;
    if (P[ia] > P[ib] || (P[ia] === P[ib] && (P[ia + 1] > P[ib + 1] || (P[ia + 1] === P[ib + 1] && P[ia + 2] > P[ib + 2])))) {
      const t = ia; ia = ib; ib = t;
      const u = da; da = db; db = u;
    }
    const s = da / (da - db);
    if (s < -eps || s > 1 + eps) return;
    const c = Math.max(0, Math.min(1, s));
    hits.push([P[ia] + (P[ib] - P[ia]) * c, P[ia + 1] + (P[ib + 1] - P[ia + 1]) * c, P[ia + 2] + (P[ib + 2] - P[ia + 2]) * c]);
  },

  /** Chain 2D segments (flat x0, y0, x1, y1) that share end points into closed
   *  contours. An end point is identified at 0.1 nm; a chain that cannot close
   *  (an open mesh) is closed by its own chord. Contours of fewer than three
   *  points are dropped. Returns arrays of {x, y}. */
  _assembleLoops(segs) {
    const ids = new Map();
    const xs = [], ys = [];
    const node = (x, y) => {
      const key = `${Math.round(x * 1e4)}:${Math.round(y * 1e4)}`;
      let id = ids.get(key);
      if (id === undefined) { id = xs.length; ids.set(key, id); xs.push(x); ys.push(y); }
      return id;
    };
    const edges = [];
    const adj = [];
    const seen = new Set();
    for (let i = 0; i + 3 < segs.length; i += 4) {
      const a = node(segs[i], segs[i + 1]), b = node(segs[i + 2], segs[i + 3]);
      if (a === b) continue;
      // An edge lying in the plane is met from both of its triangles.
      const ek = a < b ? `${a}_${b}` : `${b}_${a}`;
      if (seen.has(ek)) continue;
      seen.add(ek);
      const e = edges.length / 2;
      edges.push(a, b);
      (adj[a] || (adj[a] = [])).push(e);
      (adj[b] || (adj[b] = [])).push(e);
    }
    const used = new Uint8Array(edges.length / 2);
    const loops = [];
    for (let e0 = 0; e0 < used.length; e0++) {
      if (used[e0]) continue;
      used[e0] = 1;
      const start = edges[e0 * 2];
      let cur = edges[e0 * 2 + 1];
      const chain = [start, cur];
      while (cur !== start) {
        const list = adj[cur] || [];
        let next = -1;
        for (const e of list) if (!used[e]) { next = e; break; }
        if (next < 0) break;
        used[next] = 1;
        cur = edges[next * 2] === cur ? edges[next * 2 + 1] : edges[next * 2];
        chain.push(cur);
      }
      if (chain[chain.length - 1] === start) chain.pop();
      if (chain.length >= 3) loops.push(chain.map(id => ({ x: xs[id], y: ys[id] })));
    }
    return loops;
  },

  /** Group contours into filled regions with the even-odd rule: a contour inside
   *  an even number of others bounds a region, one inside an odd number is a hole
   *  of the smallest contour that encloses it. */
  _nestLoops(loops) {
    const area = (l) => {
      let a = 0;
      for (let i = 0; i < l.length; i++) { const p = l[i], q = l[(i + 1) % l.length]; a += p.x * q.y - q.x * p.y; }
      return Math.abs(a) / 2;
    };
    const inside = (pt, l) => {
      let c = false;
      for (let i = 0, j = l.length - 1; i < l.length; j = i++) {
        if ((l[i].y > pt.y) !== (l[j].y > pt.y) && pt.x < (l[j].x - l[i].x) * (pt.y - l[i].y) / (l[j].y - l[i].y) + l[i].x) c = !c;
      }
      return c;
    };
    const kept = loops.map(l => ({ loop: l, area: area(l) })).filter(e => e.area > 1e-6);
    const groups = new Map();
    const holes = [];
    kept.forEach((e, i) => {
      const parents = [];
      kept.forEach((o, j) => { if (j !== i && o.area > e.area && inside(e.loop[0], o.loop)) parents.push(j); });
      if (parents.length % 2 === 0) groups.set(i, { outer: e.loop, holes: [] });
      else {
        const parent = parents.reduce((best, j) => (kept[j].area < kept[best].area ? j : best), parents[0]);
        holes.push({ loop: e.loop, parent });
      }
    });
    holes.forEach(h => groups.get(h.parent)?.holes.push(h.loop));
    return [...groups.values()];
  },

  // ── Private: legend ───────────────────────────────────────

  _dropLegendListener() {
    const node = this._legend;
    if (node?._outsideClickListener) {
      document.removeEventListener('click', node._outsideClickListener);
      node._outsideClickListener = null;
    }
  },

  _densityRangeText(state) {
    return `${this._fmt(state.min)} → ${this._fmt(state.max)} ${this._t('relative')}`;
  },

  /** The legend DOM is rebuilt only when its structure changes (kind, colormap,
   *  language): during playback only the range numbers move, and replacing the
   *  nodes would close the colormap menu the user has open. */
  _renderLegend() {
    const node = this._legend;
    if (!node) return;
    const state = this._legendState;
    if (!this._active || !this._glb || !state || state.kind === 'uniform') {
      if (this._legendKey !== 'hidden') {
        this._dropLegendListener();
        node.classList.add('hidden');
        node.innerHTML = '';
        this._legendKey = 'hidden';
      }
      return;
    }
    const key = state.kind === 'region' ? 'region' : `density|${this._opts.colormap}`;
    if (key === this._legendKey) {
      node.classList.remove('hidden');
      if (state.kind === 'density') {
        const range = node.querySelector('.viewer-legend-range');
        if (range) range.textContent = this._densityRangeText(state);
      }
      return;
    }
    this._legendKey = key;
    this._dropLegendListener();
    const esc = (s) => this._esc(s);
    node.classList.remove('hidden');
    if (state.kind === 'region') {
      const regions = (this._T.getData()?.regionNames || []).map((name, r) => ({ name, color: this._T.getData().regionColors[r] }));
      node.innerHTML = `
        <div class="viewer-legend-title">${esc(this._t('legendRegion'))}</div>
        <div class="viewer-legend-items">
          ${regions.slice(0, 8).map(item => `
            <div class="viewer-legend-item">
              <span class="viewer-legend-swatch" style="background:${esc(item.color)}"></span>
              <span>${esc(item.name)}</span>
            </div>`).join('')}
        </div>`;
      return;
    }
    const maps = Object.keys(this.COLOR_MAPS);
    const activeMap = this._opts.colormap;
    node.innerHTML = `
      <div class="viewer-legend-title">${esc(this._t('legendDensity'))}</div>
      <div class="viewer-legend-gradient" id="tsf-legend-gradient" style="cursor:pointer; position:relative;" title="${esc(this._t('changeColormap'))}">
        ${this.COLOR_MAPS[activeMap].map(color => `<span style="background:${esc(color)}"></span>`).join('')}
      </div>
      <div class="viewer-legend-range">${esc(this._densityRangeText(state))}</div>
      <div id="tsf-colormap-menu" style="display:none; position:absolute; bottom:calc(100% + 8px); left:0; width:100%; background:var(--bg-surface); border:1px solid var(--border-subtle); border-radius:var(--radius-md); padding:var(--space-2); box-shadow:var(--shadow-md); z-index:20; max-height:220px; overflow-y:auto; flex-direction:column; gap:4px;">
        <div style="font-size:10px; color:var(--text-muted); padding-left:24px; margin-bottom:4px; text-transform:uppercase; font-weight:600;">${esc(this._t('selectColormap'))}</div>
        ${maps.map(n => {
          const isSel = n === activeMap;
          // Hover/selection are CSS state (.colormap-option[.selected]); the map
          // name and the stop colours are escaped like any painted string.
          return `
            <div class="colormap-option${isSel ? ' selected' : ''}" data-map="${esc(n)}" style="display:flex; align-items:center; gap:8px; padding:6px; cursor:pointer; border-radius:var(--radius-sm);">
              <div style="width:12px; font-size:11px; text-align:center; color:var(--text-primary); font-weight:bold;">${isSel ? '✓' : ''}</div>
              <div style="flex:1; display:flex; height:12px; border-radius:3px; overflow:hidden;">
                ${this.COLOR_MAPS[n].map(c => `<span style="flex:1; background:${esc(c)};"></span>`).join('')}
              </div>
              <div style="font-size:11px; width:54px; text-transform:capitalize; color:var(--text-secondary);">${esc(n)}</div>
            </div>`;
        }).join('')}
      </div>`;
    const btn = node.querySelector('#tsf-legend-gradient');
    const menu = node.querySelector('#tsf-colormap-menu');
    if (!btn || !menu) return;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      menu.style.display = menu.style.display === 'none' ? 'flex' : 'none';
    });
    const outside = (e) => { if (!menu.contains(e.target) && !btn.contains(e.target)) menu.style.display = 'none'; };
    document.addEventListener('click', outside);
    node._outsideClickListener = outside;
    menu.querySelectorAll('.colormap-option').forEach(opt => opt.addEventListener('click', (e) => {
      e.stopPropagation();
      this._opts.colormap = opt.getAttribute('data-map');
      this._colorSig = null;
      this._syncControls();
      this._update();
    }));
  },

  _fmt(v) { return Number.isFinite(v) ? v.toFixed(v >= 10 ? 1 : 2) : '—'; },

  // ── Private: sidebar ──────────────────────────────────────

  _html() {
    const esc = (s) => this._esc(s);
    const o = this._opts;
    const maps = Object.keys(this.COLOR_MAPS);
    return `
      <div class="layer-row">
        <label for="tsf-opacity" data-tsf="opacity">${esc(this._t('opacity'))}</label>
        <input type="range" id="tsf-opacity" min="0" max="100" step="5" value="${Math.round(o.opacity * 100)}">
        <output id="tsf-opacity-out">${Math.round(o.opacity * 100)}%</output>
      </div>
      <label class="text-xs text-muted"><span data-tsf="colorMode">${esc(this._t('colorMode'))}</span>
        <select id="tsf-mode" class="form-select text-sm p-1 rounded border border-light bg-surface text-primary" style="width:100%;">
          <option value="uniform" data-tsf="uniform">${esc(this._t('uniform'))}</option>
          <option value="density" data-tsf="density">${esc(this._t('density'))}</option>
          <option value="region" data-tsf="region">${esc(this._t('region'))}</option>
        </select>
      </label>
      <label class="text-xs text-muted" id="tsf-colormap-row"><span data-tsf="colormap">${esc(this._t('colormap'))}</span>
        <select id="tsf-colormap" class="form-select text-sm p-1 rounded border border-light bg-surface text-primary" style="width:100%;">
          ${maps.map(n => `<option value="${esc(n)}">${esc(n)}</option>`).join('')}
        </select>
      </label>
      <label class="tool-toggle"><input type="checkbox" id="tsf-follow" ${o.followVolumeClip ? 'checked' : ''}><span data-tsf="followClip">${esc(this._t('followClip'))}</span></label>
      <div class="panel-title" style="margin-top:var(--space-2);" data-tsf="clipTitle">${esc(this._t('clipTitle'))}</div>
      <label class="tool-toggle"><input type="checkbox" id="tsf-clip-enabled"><span data-tsf="clipEnable">${esc(this._t('clipEnable'))}</span></label>
      <div class="segmented" id="tsf-clip-mode">
        <button class="btn btn-ghost btn-sm active" type="button" data-tsf-mode="xy">XY</button>
        <button class="btn btn-ghost btn-sm" type="button" data-tsf-mode="xz">XZ</button>
        <button class="btn btn-ghost btn-sm" type="button" data-tsf-mode="yz">YZ</button>
        <button class="btn btn-ghost btn-sm" type="button" data-tsf-mode="oblique" data-tsf="oblique">${esc(this._t('oblique'))}</button>
      </div>
      <div class="layer-row">
        <label for="tsf-clip-value" data-tsf="planePos">${esc(this._t('planePos'))}</label>
        <input type="range" id="tsf-clip-value" min="0" max="100" step="1" value="100">
        <output id="tsf-clip-value-out">100%</output>
      </div>
      <div class="slice-studio-grid" id="tsf-oblique" hidden>
        <label><span data-tsf="yaw">${esc(this._t('yaw'))}</span><input type="number" id="tsf-yaw" min="-180" max="180" step="1" value="0"></label>
        <label><span data-tsf="pitch">${esc(this._t('pitch'))}</span><input type="number" id="tsf-pitch" min="-89" max="89" step="1" value="0"></label>
      </div>
      <div class="slice-actions">
        <button class="btn btn-outline btn-sm" type="button" id="tsf-clip-reset"><i data-lucide="rotate-ccw"></i> <span data-tsf="resetClip">${esc(this._t('resetClip'))}</span></button>
      </div>`;
  },

  _bind(body) {
    const $ = (id) => body.querySelector(`#${id}`);
    this._els = {
      opacity: $('tsf-opacity'), opacityOut: $('tsf-opacity-out'), mode: $('tsf-mode'),
      colormapRow: $('tsf-colormap-row'), colormap: $('tsf-colormap'), follow: $('tsf-follow'),
      clipEnabled: $('tsf-clip-enabled'), clipMode: $('tsf-clip-mode'), clipValue: $('tsf-clip-value'),
      clipValueOut: $('tsf-clip-value-out'), oblique: $('tsf-oblique'), yaw: $('tsf-yaw'), pitch: $('tsf-pitch')
    };
    const E = this._els;
    E.opacity?.addEventListener('input', () => {
      this._opts.opacity = Number(E.opacity.value) / 100;
      if (E.opacityOut) E.opacityOut.textContent = `${E.opacity.value}%`;
      this._update();
    });
    E.mode?.addEventListener('change', () => { this._opts.colorMode = E.mode.value; this._colorSig = null; this._syncControls(); this._update(); });
    E.colormap?.addEventListener('change', () => { this._opts.colormap = E.colormap.value; this._colorSig = null; this._update(); });
    E.follow?.addEventListener('change', () => { this._opts.followVolumeClip = E.follow.checked; this._T.triggerRender(); });
    const applyClip = (patch = {}) => {
      this._opts.clip = this._normalizeClip({ ...this._opts.clip, ...patch });
      this._capKey = null;
      this._syncControls();
      this._update();
    };
    E.clipEnabled?.addEventListener('change', () => applyClip({ enabled: E.clipEnabled.checked }));
    E.clipMode?.querySelectorAll('[data-tsf-mode]').forEach(btn => btn.addEventListener('click', () => applyClip({ mode: btn.getAttribute('data-tsf-mode'), enabled: true })));
    E.clipValue?.addEventListener('input', () => applyClip({ value: Number(E.clipValue.value) / 100, enabled: true }));
    E.yaw?.addEventListener('input', () => applyClip({ yaw: Number(E.yaw.value) }));
    E.pitch?.addEventListener('input', () => applyClip({ pitch: Number(E.pitch.value) }));
    $('tsf-clip-reset')?.addEventListener('click', () => applyClip({ enabled: false, mode: 'xy', value: 1, yaw: 0, pitch: 0 }));
    this._syncControls();
  },

  _syncControls() {
    const E = this._els;
    if (!E) return;
    const o = this._opts;
    if (E.opacity) E.opacity.value = String(Math.round(o.opacity * 100));
    if (E.opacityOut) E.opacityOut.textContent = `${Math.round(o.opacity * 100)}%`;
    if (E.mode) E.mode.value = o.colorMode;
    if (E.colormap) E.colormap.value = o.colormap;
    if (E.colormapRow) E.colormapRow.hidden = o.colorMode !== 'density';
    if (E.follow) E.follow.checked = o.followVolumeClip;
    if (E.clipEnabled) E.clipEnabled.checked = o.clip.enabled;
    E.clipMode?.querySelectorAll('[data-tsf-mode]').forEach(btn => btn.classList.toggle('active', btn.getAttribute('data-tsf-mode') === o.clip.mode));
    if (E.clipValue) E.clipValue.value = String(Math.round(o.clip.value * 100));
    if (E.clipValueOut) E.clipValueOut.textContent = `${Math.round(o.clip.value * 100)}%`;
    if (E.oblique) E.oblique.hidden = o.clip.mode !== 'oblique';
    if (E.yaw) E.yaw.value = String(o.clip.yaw);
    if (E.pitch) E.pitch.value = String(o.clip.pitch);
  },

  _applyLabels() {
    if (!this._section) return;
    this._section.setTitle(this._t('title'));
    this._section.body.querySelectorAll('[data-tsf]').forEach(el => { el.textContent = this._t(el.getAttribute('data-tsf')); });
  }
});
