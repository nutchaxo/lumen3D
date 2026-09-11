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
 * region (nearest tracked cell's region), each smoothed over the mesh. The
 * O(vertices x cells) pass is memoised on every input that can change it.
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
  _volumePlanes: [],
  _cutPlane: null,
  _capGroup: null,
  _helper: null,
  _capKey: null,
  _colorSig: null,
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
    ctx.i18n.onLanguageChange?.(() => { this._applyLabels(); this._renderLegend(); });
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
    this._destroyModel();
    this._legend?.remove();
    this._legend = null;
    this._section?.remove();
    this._section = null;
  },

  // ── Private: activation & loading ─────────────────────────

  _setActive(on) {
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
    if (renderer) renderer.localClippingEnabled = true;

    this._matUniform = new THREE.MeshBasicMaterial({ color: 0x87ceeb, transparent: true, opacity: this._opts.opacity, side: THREE.DoubleSide, depthWrite: false });
    this._matVertex = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: this._opts.opacity, side: THREE.DoubleSide, depthWrite: false });
    this._planes = [];
    this._matUniform.clippingPlanes = this._planes;
    this._matVertex.clippingPlanes = this._planes;

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
      child.material = this._matUniform;
      child.visible = false;
      child.frustumCulled = false;
      child.onBeforeRender = () => this._syncPlanes();
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
    if (this._group) {
      this._T?.getVolumeObject()?.remove(this._group);
      this._group.traverse((o) => { if (o.isMesh) { o.geometry?.dispose?.(); } });
    }
    this._matUniform?.dispose?.();
    this._matVertex?.dispose?.();
    this._helper?.geometry?.dispose?.(); this._helper?.material?.dispose?.();
    this._group = null; this._glb = null; this._capGroup = null; this._helper = null;
    this._matUniform = null; this._matVertex = null;
    this._variants = { raw: [], stab: [] };
    this._planes = []; this._volumePlanes = []; this._cutPlane = null;
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

  /** Tracked cells of the current frame, as um positions in the group's space. */
  _cellRows() {
    const data = this._T.getData();
    const style = this._T.getStyle() || {};
    const frame = this._T.getFrame();
    const rows = [];
    for (const c of this._T.cellsAt(frame)) {
      const flags = data.flags[c];
      if (style.showMitosis === false && (flags & 1)) continue;
      if (style.showFusion === false && (flags & 2)) continue;
      const p = this._T.positionUm(c, frame);
      if (!p) continue;
      rows.push({ index: c, region: data.regionIdx[c], position: new THREE.Vector3(p[0], p[1], p[2]) });
    }
    return rows;
  },

  /** Vertex position of `mesh` in the group's um space (independent of the cube's
   *  orbit): group^-1 . mesh.world. */
  _umMatrix(mesh) {
    this._group.updateWorldMatrix(true, false);
    mesh.updateWorldMatrix(true, false);
    return new THREE.Matrix4().copy(this._group.matrixWorld).invert().multiply(mesh.matrixWorld);
  },

  _colorSurfaces(meshes) {
    const style = this._T.getStyle() || {};
    const sig = [this._opts.colorMode, this._opts.colormap, this._T.getFrame(), this._T.isStabilized(),
      this._T.getOptions().neighborThresholdUm, style.showMitosis, style.showFusion,
      meshes.map(m => m.uuid).sort().join(',')].join('|');
    if (sig === this._colorSig) return;
    this._colorSig = sig;
    const mode = this._opts.colorMode;
    if (mode === 'uniform') {
      meshes.forEach(m => { m.material = this._matUniform; });
      this._legendState = { kind: 'uniform' };
      return;
    }
    const rows = this._cellRows();
    if (mode === 'region') {
      meshes.forEach(m => {
        const colors = this._regionColors(m, rows);
        if (colors) { this._applyColors(m, colors); m.material = this._matVertex; }
        else m.material = this._matUniform;
      });
      this._legendState = { kind: 'region' };
      return;
    }
    // density
    let stats = null;
    const computed = [];
    meshes.forEach(m => {
      const baked = this._bakedDensity(m);
      if (baked) { computed.push({ mesh: m, values: null, baked }); return; }
      computed.push({ mesh: m, values: this._kernelDensity(m, rows) });
    });
    const all = computed.flatMap(c => c.values || []);
    if (all.length) stats = this._densityStats(all);
    computed.forEach(({ mesh, values, baked }) => {
      if (baked) { this._applyColors(mesh, this._bakedColors(baked)); mesh.material = this._matVertex; return; }
      if (!values || !values.length || !stats) { mesh.material = this._matUniform; return; }
      this._applyColors(mesh, this._densityColors(values, stats));
      mesh.material = this._matVertex;
    });
    this._legendState = { kind: 'density', min: stats?.p10 ?? 0, max: stats?.p90 ?? 1 };
  },

  _applyColors(mesh, colors) {
    const smoothed = this._smooth(mesh, colors);
    mesh.geometry.setAttribute('color', new THREE.BufferAttribute(smoothed, 3));
    mesh.geometry.attributes.color.needsUpdate = true;
  },

  _bakedDensity(mesh) {
    const attrs = mesh.geometry?.attributes || {};
    if (attrs._DENSITY) return attrs._DENSITY;
    if (attrs._density) return attrs._density;
    if (attrs.density) return attrs.density;
    return null;
  },

  _bakedColors(attr) {
    const colors = new Float32Array(attr.count * 3);
    for (let i = 0; i < attr.count; i++) {
      const raw = attr.array[i];
      const c = this._rampColor(Math.max(0, Math.min(1, raw > 1 ? raw / 255 : raw)));
      colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
    }
    return colors;
  },

  /** Gaussian kernel density of the tracked cells at each vertex. The kernel
   *  width follows the shared neighbour radius, so "dense" means the same thing
   *  here and in the neighbour network. */
  _kernelDensity(mesh, rows) {
    const attr = mesh.geometry?.attributes?.position;
    if (!attr || !rows.length) return [];
    const sigma = Math.max(8, Math.min(54, this._T.getOptions().neighborThresholdUm * 0.52));
    const radiusSq = Math.pow(Math.max(18, sigma * 2.8), 2);
    const m = this._umMatrix(mesh);
    const v = new THREE.Vector3();
    const values = new Array(attr.count);
    for (let i = 0; i < attr.count; i++) {
      v.fromBufferAttribute(attr, i).applyMatrix4(m);
      let density = 0;
      for (const row of rows) {
        const dSq = v.distanceToSquared(row.position);
        if (dSq > radiusSq) continue;
        density += Math.exp(-dSq / (2 * sigma * sigma));
      }
      values[i] = density;
    }
    return values;
  },

  _regionColors(mesh, rows) {
    const attr = mesh.geometry?.attributes?.position;
    if (!attr || !rows.length) return null;
    const data = this._T.getData();
    const m = this._umMatrix(mesh);
    const v = new THREE.Vector3();
    const colors = new Float32Array(attr.count * 3);
    const palette = data.regionColors.map(hex => new THREE.Color(hex));
    for (let i = 0; i < attr.count; i++) {
      v.fromBufferAttribute(attr, i).applyMatrix4(m);
      let nearest = -1, best = Infinity;
      for (const row of rows) {
        const dSq = v.distanceToSquared(row.position);
        if (dSq < best) { best = dSq; nearest = row.region; }
      }
      const c = nearest >= 0 ? palette[nearest] : new THREE.Color(0x9aa4b3);
      colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
    }
    return colors;
  },

  _densityStats(values) {
    const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
    if (!sorted.length) return null;
    return {
      min: sorted[0], max: sorted[sorted.length - 1],
      p10: sorted[Math.floor((sorted.length - 1) * 0.1)],
      p90: sorted[Math.floor((sorted.length - 1) * 0.9)]
    };
  },

  _densityColors(values, stats) {
    const low = stats.p10, high = stats.p90;
    const colors = new Float32Array(values.length * 3);
    values.forEach((value, i) => {
      const t = high > low ? Math.max(0, Math.min(1, (value - low) / (high - low))) : 0;
      const c = this._rampColor(t);
      colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
    });
    return colors;
  },

  _rampColor(t) {
    const stops = (this.COLOR_MAPS[this._opts.colormap] || this.COLOR_MAPS.viridis).map(c => new THREE.Color(c));
    const scaled = Math.max(0, Math.min(1, t)) * (stops.length - 1);
    const i = Math.min(stops.length - 2, Math.floor(scaled));
    return stops[i].clone().lerp(stops[i + 1], scaled - i);
  },

  /** Laplacian smoothing of vertex colours over the mesh adjacency, so triangle
   *  boundaries do not read as colour steps. */
  _smooth(mesh, colors, iterations = 2, blend = 0.5) {
    const geo = mesh.geometry;
    const count = geo?.attributes?.position?.count || 0;
    if (!count || colors.length !== count * 3) return colors;
    const adj = Array.from({ length: count }, () => []);
    const index = geo.index?.array;
    const triCount = index ? Math.floor(index.length / 3) : Math.floor(count / 3);
    for (let t = 0; t < triCount; t++) {
      const a = index ? index[t * 3] : t * 3, b = index ? index[t * 3 + 1] : t * 3 + 1, c = index ? index[t * 3 + 2] : t * 3 + 2;
      adj[a].push(b, c); adj[b].push(a, c); adj[c].push(a, b);
    }
    let current = new Float32Array(colors);
    for (let it = 0; it < iterations; it++) {
      const next = new Float32Array(current);
      for (let i = 0; i < count; i++) {
        const nb = adj[i];
        if (!nb.length) continue;
        let r = current[i * 3], g = current[i * 3 + 1], b = current[i * 3 + 2], n = 1;
        for (const j of nb) { r += current[j * 3]; g += current[j * 3 + 1]; b += current[j * 3 + 2]; n++; }
        next[i * 3] = current[i * 3] * (1 - blend) + (r / n) * blend;
        next[i * 3 + 1] = current[i * 3 + 1] * (1 - blend) + (g / n) * blend;
        next[i * 3 + 2] = current[i * 3 + 2] * (1 - blend) + (b / n) * blend;
      }
      current = next;
    }
    return current;
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
   *  into it. */
  _cutPlaneUm() {
    const spec = this._opts.clip;
    if (!spec.enabled || !this._bounds) return null;
    const n = this._cutNormal(spec);
    const q = this._bounds.center.clone().addScaledVector(n, (spec.value - 0.5) * this._bounds.span);
    // Keep p where n.(q - p) >= 0  <=>  (-n).p + n.q >= 0
    return new THREE.Plane(n.clone().negate(), n.dot(q));
  },

  /** The volume's clip box (Z-stack slab, clip sliders) as six planes in the
   *  CUBE's object space, mirroring the shader's own test. */
  _volumeBoxPlanes() {
    const material = this._ctx.viewer.getMaterial?.();
    const u = material?.uniforms;
    if (!u || !u.clipMin || !u.clipMax) return [];
    const lo = new THREE.Vector3(), hi = new THREE.Vector3();
    if (this._T.isStabilized() && u.clipBoxMin && u.clipBoxSize) {
      lo.copy(u.clipBoxMin.value).add(u.clipMin.value.clone().multiply(u.clipBoxSize.value));
      hi.copy(u.clipBoxMin.value).add(u.clipMax.value.clone().multiply(u.clipBoxSize.value));
    } else {
      lo.copy(u.clipMin.value).subScalar(0.5);
      hi.copy(u.clipMax.value).subScalar(0.5);
    }
    return [
      new THREE.Plane(new THREE.Vector3(1, 0, 0), -lo.x), new THREE.Plane(new THREE.Vector3(-1, 0, 0), hi.x),
      new THREE.Plane(new THREE.Vector3(0, 1, 0), -lo.y), new THREE.Plane(new THREE.Vector3(0, -1, 0), hi.y),
      new THREE.Plane(new THREE.Vector3(0, 0, 1), -lo.z), new THREE.Plane(new THREE.Vector3(0, 0, -1), hi.z)
    ];
  },

  /** Re-express the clipping planes in WORLD space for this draw. Runs from the
   *  meshes' onBeforeRender, so the cube's current orbit is what gets used. */
  _syncPlanes() {
    if (!this._group) return;
    const cube = this._T.getVolumeObject();
    if (!cube) return;
    const next = [];
    if (this._opts.followVolumeClip) {
      cube.updateWorldMatrix(true, false);
      for (const p of this._volumeBoxPlanes()) next.push(p.applyMatrix4(cube.matrixWorld));
    }
    const cut = this._cutPlaneUm();
    if (cut) {
      this._group.updateWorldMatrix(true, false);
      next.push(cut.applyMatrix4(this._group.matrixWorld));
    }
    // Mutate the shared array in place: both materials point at it.
    this._planes.length = 0;
    next.forEach(p => this._planes.push(p));
    // three.js caches the projected planes per material; a change of COUNT needs
    // a program refresh, a change of values does not.
    if (this._matUniform && this._planeCount !== next.length) {
      this._planeCount = next.length;
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

    // …and a filled cap over the cut section: the convex hull of the mesh/plane
    // intersection segments, in the plane's own 2D frame.
    const segments = [];
    meshes.forEach(mesh => this._planeSegments(mesh, plane, segments));
    if (segments.length < 3) return;
    const helper = Math.abs(n.y) > 0.8 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
    const right = helper.clone().cross(n).normalize();
    const up = n.clone().cross(right).normalize();
    const pts = segments.map(p => ({ x: p.clone().sub(q).dot(right), y: p.clone().sub(q).dot(up) }));
    const hull = this._convexHull(pts);
    if (hull.length < 3) return;
    const shape = new THREE.Shape();
    shape.moveTo(hull[0].x, hull[0].y);
    for (let i = 1; i < hull.length; i++) shape.lineTo(hull[i].x, hull[i].y);
    shape.closePath();
    const basis = new THREE.Matrix4().makeBasis(right, up, n).setPosition(q);
    const cap = new THREE.Mesh(new THREE.ShapeGeometry(shape),
      new THREE.MeshBasicMaterial({ color: this.CUT_COLOR, transparent: true, opacity: 0.5, side: THREE.DoubleSide, depthWrite: false }));
    cap.applyMatrix4(basis);
    this._capGroup.add(cap);
    const loop = hull.map(p => new THREE.Vector3(p.x, p.y, 0));
    loop.push(loop[0].clone());
    const edge = new THREE.Line(new THREE.BufferGeometry().setFromPoints(loop),
      new THREE.LineBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.95 }));
    edge.applyMatrix4(basis);
    this._capGroup.add(edge);
  },

  _clearCap() {
    if (!this._capGroup) return;
    while (this._capGroup.children.length) {
      const child = this._capGroup.children[this._capGroup.children.length - 1];
      this._capGroup.remove(child);
      child.geometry?.dispose?.(); child.material?.dispose?.();
    }
    this._helper = null;
  },

  _planeSegments(mesh, plane, out) {
    const position = mesh.geometry?.attributes?.position;
    if (!position) return;
    const index = mesh.geometry.index;
    const m = this._umMatrix(mesh);
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
    const readIndex = (tri, corner) => (index ? index.array[tri * 3 + corner] : tri * 3 + corner);
    const triCount = index ? Math.floor(index.count / 3) : Math.floor(position.count / 3);
    const eps = 1e-4;
    for (let tri = 0; tri < triCount; tri++) {
      a.fromBufferAttribute(position, readIndex(tri, 0)).applyMatrix4(m);
      b.fromBufferAttribute(position, readIndex(tri, 1)).applyMatrix4(m);
      c.fromBufferAttribute(position, readIndex(tri, 2)).applyMatrix4(m);
      const da = plane.distanceToPoint(a), db = plane.distanceToPoint(b), dc = plane.distanceToPoint(c);
      const hits = [];
      this._edgeHit(a, b, da, db, eps, hits);
      this._edgeHit(b, c, db, dc, eps, hits);
      this._edgeHit(c, a, dc, da, eps, hits);
      if (hits.length >= 2) out.push(hits[0], hits[1]);
    }
  },

  _edgeHit(a, b, da, db, eps, hits) {
    if (Math.abs(da) <= eps && Math.abs(db) <= eps) { hits.push(a.clone(), b.clone()); return; }
    if ((da > eps && db > eps) || (da < -eps && db < -eps)) return;
    if (Math.abs(da - db) <= eps) return;
    const t = da / (da - db);
    if (t < -eps || t > 1 + eps) return;
    hits.push(a.clone().lerp(b, THREE.MathUtils.clamp(t, 0, 1)));
  },

  _convexHull(points) {
    const unique = [];
    const seen = new Set();
    for (const p of points) {
      const key = `${p.x.toFixed(3)}|${p.y.toFixed(3)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push(p);
    }
    unique.sort((p, q) => (p.x === q.x ? p.y - q.y : p.x - q.x));
    if (unique.length < 3) return unique;
    const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
    const lower = [];
    for (const p of unique) {
      while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
      lower.push(p);
    }
    const upper = [];
    for (let i = unique.length - 1; i >= 0; i--) {
      const p = unique[i];
      while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
      upper.push(p);
    }
    lower.pop(); upper.pop();
    return lower.concat(upper);
  },

  // ── Private: legend ───────────────────────────────────────

  _renderLegend() {
    const node = this._legend;
    if (!node) return;
    if (node._outsideClickListener) {
      document.removeEventListener('click', node._outsideClickListener);
      node._outsideClickListener = null;
    }
    const state = this._legendState;
    if (!this._active || !this._glb || !state || state.kind === 'uniform') {
      node.classList.add('hidden');
      node.innerHTML = '';
      return;
    }
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
      <div class="viewer-legend-range">${this._fmt(state.min)} → ${this._fmt(state.max)} ${esc(this._t('relative'))}</div>
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
