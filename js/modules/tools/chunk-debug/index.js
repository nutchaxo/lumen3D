/* Chunk Debug — index.js
 *
 * Developer overlay that exposes the brick (chunk) decomposition of the active
 * volume. When toggled on it draws the EDGES of every non-empty chunk of the
 * currently-displayed LOD and, on hover, surfaces that chunk's id, voxel/µm
 * size and the .bin pack file it is stored in. CTRL + mouse wheel walks the
 * stack of chunks under the cursor by depth (front → back and back again);
 * a plain wheel keeps the viewer's normal zoom. CLICK copies the hovered
 * chunk's metadata (the tooltip contents) to the clipboard.
 *
 * Three render shapes, one model — everything is computed in the cube's LOCAL
 * space [-0.5,0.5]³ (normalized volume coord = local + 0.5):
 *   • plain 3D            → full box wireframe (12 edges)               [BOX]
 *   • z-stack browser     → chunk ∩ axial slice → axis-aligned square   [SLICE]
 *   • oblique cut plane   → chunk ∩ oblique plane → deformed polygon     [SLICE]
 * The slice plane is read from VolumeViewer.getPlaneSpec() (oblique/ortho) or
 * synthesised from ctx._state.zstack* (z-stack disables the slicer). In local
 * space the cut plane is { x : normal·x = value - 0.5 }.
 *
 * Why a 2D overlay canvas instead of THREE.Line objects in the scene: the
 * viewer drops its renderer pixelRatio to 0.40–0.50 during camera interaction
 * (a deliberate fill-rate optimisation), which blurs the whole WebGL framebuffer
 * — lines included. Drawing the edges on a separate full-resolution 2D canvas,
 * projected in JS each time the camera moves, keeps the borders crisp at all
 * times (and sidesteps the 1px-only limit of WebGL LineBasicMaterial). No second
 * WebGL context is created. Hit-testing stays in JS (ray↔AABB for boxes,
 * point-in-polygon on the plane for slices) so it is independent of rendering.
 */
PluginRegistry.implement('chunk-debug', {
  _ctx: null,
  _active: false,

  _COLOR_BASE: '#ffd400',
  _COLOR_HILITE: '#ff3b30',
  _POLL_MS: 120,
  _DRAG_PX: 6,
  // 8 box corners (m=min, M=max) and the 12 edges that connect them.
  _BOX_EDGES: [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]],

  init(ctx) {
    this._ctx = ctx;
    this._active = false;
    this._scene = null;
    this._cube = null;
    this._canvas = null;        // the WebGL canvas (events + sizing reference)
    this._oc = null;            // 2D overlay canvas
    this._octx = null;
    this._ocW = 0; this._ocH = 0; this._ocDpr = 1;
    this._chunks = [];
    this._stack = [];
    this._stackKey = '';
    this._depthIndex = 0;
    this._selected = null;
    this._lastPointer = null;
    this._downXY = null;
    this._mode = { type: 'box' };
    this._lod = 0;
    this._lastSig = '';
    this._raycaster = new THREE.Raycaster();
    this._v = new THREE.Vector3();
    this._tooltip = null;
    this._moveRaf = null;
    this._pollId = null;
    this._ro = null;
    this._unsubPlane = null;
    this._unsubCamera = null;
    this._wheelOpts = { capture: true, passive: false };
    this._onMove = this._handlePointerMove.bind(this);
    this._onLeave = this._handlePointerLeave.bind(this);
    this._onWheel = this._handleWheel.bind(this);
    this._onDown = this._handlePointerDown.bind(this);
    this._onClick = this._handleClick.bind(this);
    this._onResize = () => { this._syncOverlaySize(); this._drawOverlay(); };
    return this;
  },

  activate() {
    this._active = !this._active;
    if (this._active) this._enable();
    else this._disable();
    this._syncButton();
    return { active: this._active };
  },

  // Workspace persistence (save/restore-workspace plugins round-trip this).
  getState() { return { active: this._active }; },
  setState(s) {
    if (!s || typeof s.active !== 'boolean') return;
    if (s.active && !this._active) { this._active = true; this._enable(); }
    else if (!s.active && this._active) { this._active = false; this._disable(); }
    this._syncButton();
  },

  dispose() { this._disable(); this._ctx = null; },

  // ── helpers ──────────────────────────────────────────────────────────────

  _t(key, params) { return this._ctx && this._ctx.i18n ? this._ctx.i18n.t(key, params) : key; },

  _syncButton() {
    const btn = document.getElementById('btn-chunk-debug');
    if (!btn) return;
    btn.classList.toggle('btn-solid', this._active);
    btn.classList.toggle('btn-ghost', !this._active);
  },

  // ── enable / disable ───────────────────────────────────────────────────────

  _enable() {
    if (typeof BrickLoader === 'undefined' || !BrickLoader.isReady()) {
      this._ctx.ui.toast(this._t('noBricks'));
      this._active = false;
      return;
    }
    const scene = (typeof VolumeViewer !== 'undefined') ? VolumeViewer.getScene() : null;
    const material = (typeof VolumeViewer !== 'undefined') ? VolumeViewer.getMaterial() : null;
    const renderer = (typeof VolumeViewer !== 'undefined') ? VolumeViewer.getRenderer() : null;
    if (!scene || !material || !renderer) { this._active = false; return; }

    // The volume mesh is the only Mesh sharing the ray-march ShaderMaterial — a
    // reference match identifies it without depending on a name we don't own.
    this._cube = null;
    scene.traverse(o => { if (!this._cube && o.isMesh && o.material === material) this._cube = o; });
    if (!this._cube) { this._ctx.ui.toast(this._t('noVolume')); this._active = false; return; }

    this._scene = scene;
    this._canvas = renderer.domElement;

    try {
      this._createOverlay();
      this._buildTooltip();

      this._canvas.addEventListener('pointermove', this._onMove);
      this._canvas.addEventListener('pointerleave', this._onLeave);
      this._canvas.addEventListener('pointerdown', this._onDown);
      this._canvas.addEventListener('click', this._onClick);
      // Capture phase so we pre-empt the viewer's own wheel-zoom listener when
      // cycling depth; stopPropagation there keeps the camera still.
      this._canvas.addEventListener('wheel', this._onWheel, this._wheelOpts);
      window.addEventListener('resize', this._onResize);

      // Redraw the (full-resolution) overlay whenever the camera moves — this is
      // what keeps the borders crisp while the WebGL volume renders low-res.
      if (typeof VolumeViewer.onCameraChange === 'function') {
        this._unsubCamera = VolumeViewer.onCameraChange(() => this._recomputeStack());
      }
      if (typeof VolumeViewer.onPlaneSpecChange === 'function') {
        this._unsubPlane = VolumeViewer.onPlaneSpecChange(() => this._rebuild());
      }
      // z-stack slice / quality (LOD) changes emit no event a plugin can grab —
      // a cheap signature poll catches every mode/slice/LOD transition.
      this._pollId = setInterval(() => {
        if (!this._active) return;
        if (this._stateSignature() !== this._lastSig) this._rebuild();
      }, this._POLL_MS);

      this._rebuild();
    } catch (e) {
      // Never leave listeners / interval / DOM dangling on a partial enable.
      console.error('[chunk-debug] enable failed:', e);
      this._disable();
      this._active = false;
    }
  },

  _disable() {
    if (this._canvas) {
      this._canvas.removeEventListener('pointermove', this._onMove);
      this._canvas.removeEventListener('pointerleave', this._onLeave);
      this._canvas.removeEventListener('pointerdown', this._onDown);
      this._canvas.removeEventListener('click', this._onClick);
      this._canvas.removeEventListener('wheel', this._onWheel, this._wheelOpts);
    }
    window.removeEventListener('resize', this._onResize);
    if (this._ro) { try { this._ro.disconnect(); } catch (e) {} this._ro = null; }
    if (this._pollId) { clearInterval(this._pollId); this._pollId = null; }
    if (this._moveRaf) { cancelAnimationFrame(this._moveRaf); this._moveRaf = null; }
    if (this._unsubCamera) { this._unsubCamera(); this._unsubCamera = null; }
    if (this._unsubPlane) { this._unsubPlane(); this._unsubPlane = null; }

    if (this._oc) { this._oc.remove(); this._oc = null; this._octx = null; }
    if (this._tooltip) { this._tooltip.remove(); this._tooltip = null; }

    this._chunks = [];
    this._stack = [];
    this._stackKey = '';
    this._depthIndex = 0;
    this._selected = null;
    this._lastPointer = null;
    this._downXY = null;
    this._lastSig = '';
  },

  // ── overlay canvas ───────────────────────────────────────────────────────

  _createOverlay() {
    const parent = this._canvas.parentElement || this._canvas;
    const oc = document.createElement('canvas');
    oc.className = 'chunk-debug-canvas';
    oc.style.cssText = 'position:absolute;pointer-events:none;z-index:6;';
    parent.appendChild(oc);
    this._oc = oc;
    this._octx = oc.getContext('2d');
    this._syncOverlaySize();
    // The viewer resizes the WebGL canvas via a ResizeObserver (sidebar toggles,
    // window changes) without always firing window 'resize' — mirror it.
    if (typeof ResizeObserver !== 'undefined') {
      this._ro = new ResizeObserver(() => { this._syncOverlaySize(); this._drawOverlay(); });
      this._ro.observe(parent);
    }
  },

  _syncOverlaySize() {
    if (!this._oc || !this._canvas) return;
    const gl = this._canvas;
    const w = Math.max(1, gl.clientWidth);
    const h = Math.max(1, gl.clientHeight);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this._oc.style.left = gl.offsetLeft + 'px';
    this._oc.style.top = gl.offsetTop + 'px';
    this._oc.style.width = w + 'px';
    this._oc.style.height = h + 'px';
    this._oc.width = Math.round(w * dpr);
    this._oc.height = Math.round(h * dpr);
    this._ocW = w; this._ocH = h; this._ocDpr = dpr;
  },

  _project(local, cam) {
    const v = this._v.copy(local);
    this._cube.localToWorld(v);              // local → world
    v.applyMatrix4(cam.matrixWorldInverse);  // world → view space
    if (v.z > -1e-4) return null;            // at/behind the camera → skip
    v.applyMatrix4(cam.projectionMatrix);    // view → NDC (perspective divide)
    return { x: (v.x * 0.5 + 0.5) * this._ocW, y: (1 - (v.y * 0.5 + 0.5)) * this._ocH };
  },

  _strokeChunk(ctx, c, cam) {
    const corners = c.corners;
    if (!corners) return;
    const proj = corners.map(p => this._project(p, cam));
    for (const e of c.edges) {
      const a = proj[e[0]], b = proj[e[1]];
      if (a && b) { ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); }
    }
  },

  _drawOverlay() {
    const ctx = this._octx;
    if (!ctx || !this._active || !this._cube) return;
    if (this._canvas.clientWidth !== this._ocW || this._canvas.clientHeight !== this._ocH) this._syncOverlaySize();
    const cam = VolumeViewer.getCamera();
    if (!cam) return;
    cam.updateMatrixWorld();
    this._cube.updateMatrixWorld();

    ctx.setTransform(this._ocDpr, 0, 0, this._ocDpr, 0, 0);
    ctx.clearRect(0, 0, this._ocW, this._ocH);
    ctx.lineJoin = 'round';

    ctx.beginPath();
    ctx.lineWidth = 1.25;
    ctx.strokeStyle = this._COLOR_BASE;
    ctx.globalAlpha = 0.9;
    for (const c of this._chunks) this._strokeChunk(ctx, c, cam);
    ctx.stroke();

    if (this._selected) {
      ctx.beginPath();
      ctx.lineWidth = 2.25;
      ctx.strokeStyle = this._COLOR_HILITE;
      ctx.globalAlpha = 1.0;
      this._strokeChunk(ctx, this._selected, cam);
      ctx.stroke();
    }
    ctx.globalAlpha = 1.0;
  },

  // ── state signature & LOD ──────────────────────────────────────────────────

  _stateSignature() {
    const st = (this._ctx && this._ctx._state) || {};
    let ps = {};
    try { ps = VolumeViewer.getPlaneSpec() || {}; } catch (e) {}
    return [
      st.zstackActive ? 1 : 0,
      st.zstackCurrentSlice | 0,
      ps.visible ? 1 : 0,
      ps.mode || '',
      (+ps.value || 0).toFixed(4),
      (+ps.yaw || 0).toFixed(2),
      (+ps.pitch || 0).toFixed(2),
      (+ps.roll || 0).toFixed(2),
      ps.projection || 'single',
      (+ps.slabThickness || 1) | 0,
      this._currentQuality()
    ].join('|');
  },

  _currentQuality() {
    try {
      const qs = VolumeViewer.getQualityState ? VolumeViewer.getQualityState() : null;
      return qs ? (qs.active || qs.target || 'native') : 'native';
    } catch (e) { return 'native'; }
  },

  // Mirror of VolumeViewer._lodForQuality (private) so the overlay shows the
  // chunks of the LOD actually on screen. Falls back to the finest LOD that has
  // bricks, so the overlay is never silently empty.
  _resolveLod(manifest) {
    const levels = (manifest && manifest.levels) || [];
    if (!levels.length) return 0;
    const maxIdx = levels.length - 1;
    const quality = this._currentQuality();
    let lod = 0;
    const lodMatch = /^lod(\d+)$/.exec(quality);
    const resMatch = /^(\d+)x\d+$/.exec(quality);
    if (quality === 'native') {
      lod = 0;
    } else if (lodMatch) {
      lod = Math.min(maxIdx, parseInt(lodMatch[1], 10));
    } else if (resMatch) {
      const target = parseInt(resMatch[1], 10);
      let best = 0, minDiff = Infinity;
      for (let i = 0; i < levels.length; i++) {
        const d = levels[i] && levels[i].dimensions;
        if (d && d.x && d.y) {
          const diff = Math.abs(Math.max(d.x, d.y) - target);
          if (diff < minDiff) { minDiff = diff; best = i; }
        }
      }
      lod = best;
    }
    if (BrickLoader.activeBricks(lod).length === 0) {
      for (let i = 0; i < levels.length; i++) {
        const lv = levels[i].level;
        if (BrickLoader.activeBricks(lv).length > 0) { lod = lv; break; }
      }
    }
    return lod;
  },

  // ── chunk model ────────────────────────────────────────────────────────────

  _rebuild() {
    if (!this._active) return;

    const manifest = BrickLoader.getManifest();
    if (!manifest) { this._lastSig = this._stateSignature(); return; }

    const lod = this._resolveLod(manifest);
    this._lod = lod;
    const dims = BrickLoader.getDimensions(lod);
    const level = (manifest.levels || []).find(l => l.level === lod) || manifest.levels[lod] || manifest.levels[0];
    if (!dims || !level) { this._lastSig = this._stateSignature(); return; }

    // brick grid coords (bx_by_bz) → chunk metadata (id 'z_y_x', voxel min/max)
    const metaByKey = new Map();
    if (Array.isArray(level.chunks)) {
      for (const c of level.chunks) {
        const p = String(c.id).split('_');
        if (p.length === 3) metaByKey.set(`${+p[2]}_${+p[1]}_${+p[0]}`, c);
      }
    }

    const channels = manifest.channels || dims.channels || 1;
    const voxelSize = manifest.voxelSize || null;
    const scale = level.scale || 1;
    const b2p = (manifest.brickTransport && manifest.brickTransport.brickToPack) || null;
    const dimX = level.dimensions.x, dimY = level.dimensions.y, dimZ = level.dimensions.z;
    const bs = dims.brickSize;

    this._chunks = BrickLoader.activeBricks(lod).map(b => {
      const key = `${b.bx}_${b.by}_${b.bz}`;
      const meta = metaByKey.get(key);
      const vMin = meta && meta.min ? meta.min : [b.bx * bs, b.by * bs, b.bz * bs];
      const vMax = meta && meta.max ? meta.max : [
        Math.min((b.bx + 1) * bs, dimX),
        Math.min((b.by + 1) * bs, dimY),
        Math.min((b.bz + 1) * bs, dimZ)
      ];
      const localMin = new THREE.Vector3(vMin[0] / dimX - 0.5, vMin[1] / dimY - 0.5, vMin[2] / dimZ - 0.5);
      const localMax = new THREE.Vector3(vMax[0] / dimX - 0.5, vMax[1] / dimY - 0.5, vMax[2] / dimZ - 0.5);
      const voxDims = [vMax[0] - vMin[0], vMax[1] - vMin[1], vMax[2] - vMin[2]];
      const umDims = voxelSize
        ? [voxDims[0] * voxelSize.x / scale, voxDims[1] * voxelSize.y / scale, voxDims[2] * voxelSize.z / scale]
        : null;
      const store = this._lookupStorage(b2p, lod, b.bx, b.by, b.bz, channels);
      return {
        key,
        id: meta && meta.id ? meta.id : `${b.bz}_${b.by}_${b.bx}`,
        localMin, localMax, voxDims, umDims, channels,
        bytes: store.bytes, file: store.file,
        corners: null, edges: null, poly2: null
      };
    });

    this._mode = this._sliceMode();
    this._buildShapes(this._mode);
    this._selected = null;
    this._lastSig = this._stateSignature();
    this._recomputeStack(); // re-derives _selected for the current cursor + redraws
  },

  // Sum compressed bytes across channels; return the first pack file found.
  _lookupStorage(b2p, lod, bx, by, bz, channels) {
    if (!b2p) return { bytes: null, file: null };
    const p3 = v => String(v).padStart(3, '0');
    let bytes = 0, file = null, found = false;
    for (let c = 0; c < channels; c++) {
      const tail = 'c' + c;
      const nameBack = `lod${lod}\\${tail}\\x${p3(bx)}_y${p3(by)}_z${p3(bz)}.webp`;
      const nameFwd = `lod${lod}/${tail}/x${p3(bx)}_y${p3(by)}_z${p3(bz)}.webp`;
      const entry = b2p[nameBack] || b2p[nameFwd];
      if (entry) {
        found = true;
        if (Number.isFinite(entry.length)) bytes += entry.length;
        if (file === null && entry.url) file = entry.url;
      }
    }
    return { bytes: found ? bytes : null, file };
  },

  _sliceMode() {
    const st = (this._ctx && this._ctx._state) || {};
    if (st.zstackActive) {
      const meta = this._ctx.dataset.getMeta();
      const z = Number(meta && meta.dimensions && meta.dimensions.z) || 1;
      const s = Number(st.zstackCurrentSlice) || 0;
      const normZ = z > 1 ? (s + 0.5) / z : 0.5;
      const n = new THREE.Vector3(0, 0, 1);
      const basis = this._planeBasis(n);
      return { type: 'slice', n, d: normZ - 0.5, u: basis.u, v: basis.v, h: 0 };
    }
    let ps = null;
    try { ps = VolumeViewer.getPlaneSpec(); } catch (e) {}
    if (ps && ps.visible && Array.isArray(ps.normal)) {
      // ps.normal is defined in the cube's UNSCALED local space, but the cube carries
      // a non-uniform scale (anisotropic voxels + z display stretch). The actual cut
      // plane the viewer renders has, in the displayed [-0.5,0.5]³ grid, the normal
      // normalize(scale ⊙ rawNormal) — NOT rawNormal. Clipping the chunks with the raw
      // normal put every oblique section on a different plane than the rendered cut
      // mesh (axis-aligned cuts are immune: scale ⊙ eᵢ ∥ eᵢ, so they were unaffected).
      // Derivation: the plane mesh sits at world point cubeR·(localPos⊙scale)+pos with
      // world normal cubeR·rawN; pulling that back through the cube transform gives
      //   x · (scale ⊙ rawN) = (value-0.5)·((scale ⊙ rawN)·rawN)   in local space.
      const rawN = new THREE.Vector3().fromArray(ps.normal).normalize();
      const scale = (this._cube && this._cube.scale) || new THREE.Vector3(1, 1, 1);
      const Np = new THREE.Vector3(rawN.x * scale.x, rawN.y * scale.y, rawN.z * scale.z);
      const npLen = Np.length() || 1;
      const n = Np.clone().multiplyScalar(1 / npLen);
      const d = ((Number(ps.value) || 0) - 0.5) * Np.dot(rawN) / npLen;
      const basis = this._planeBasis(n);
      const h = this._slabHalfThickness(ps, npLen);
      return { type: 'slice', n, d, u: basis.u, v: basis.v, h };
    }
    return { type: 'box' };
  },

  // Half-thickness of the MIP/average slab expressed in the cube's local [-0.5,0.5]³
  // grid, measured as an offset of the (scaled) cut plane along its normal. Mirrors
  // volume-slicer.js: each of the (slabThickness-1) extra samples integrates maxP/256
  // µm of depth along the plane normal, so the slab spans (steps-1)·maxP/256 µm. One
  // world unit equals `reference` µm (max of the x/y physical extents, the cube scale
  // reference), and a world offset δ along the normal shifts the local plane by δ/|Np|
  // (Np = scale ⊙ rawNormal). Returns 0 for the thin single-sample plane so the overlay
  // collapses to its original behaviour. Kept in lock-step with VolumeViewer's slab
  // faces so the yellow band and the blue slab mesh always coincide.
  _slabHalfThickness(ps, npLen) {
    const proj = ps.projection || 'single';
    const steps = Math.max(1, Math.min(64, Number(ps.slabThickness) || 1));
    if ((proj !== 'mip' && proj !== 'average') || steps <= 1) return 0;
    let physical = null;
    try { physical = VolumeViewer.getPhysicalSize ? VolumeViewer.getPhysicalSize() : null; } catch (e) {}
    const px = physical && physical.x > 0 ? physical.x : 1;
    const py = physical && physical.y > 0 ? physical.y : 1;
    const pz = physical && physical.z > 0 ? physical.z : 1;
    const maxP = Math.max(px, py, pz);
    const reference = Math.max(px, py) || 1;
    const totalUm = (steps - 1) * maxP / 256;     // slab depth along the normal (µm)
    const halfWorld = totalUm / (2 * reference);  // world half-thickness
    return halfWorld / npLen;                     // → local offset along the scaled normal
  },

  _planeBasis(n) {
    const ref = Math.abs(n.x) < 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
    const u = new THREE.Vector3().crossVectors(ref, n).normalize();
    const v = new THREE.Vector3().crossVectors(n, u).normalize();
    return { u, v };
  },

  // Per chunk, derive the projectable corner list + edge index pairs for the
  // active mode (full box vs. its section polygon on the plane).
  _buildShapes(mode) {
    if (mode.type === 'box') {
      for (const c of this._chunks) {
        const m = c.localMin, M = c.localMax;
        c.corners = [
          new THREE.Vector3(m.x, m.y, m.z), new THREE.Vector3(M.x, m.y, m.z),
          new THREE.Vector3(M.x, M.y, m.z), new THREE.Vector3(m.x, M.y, m.z),
          new THREE.Vector3(m.x, m.y, M.z), new THREE.Vector3(M.x, m.y, M.z),
          new THREE.Vector3(M.x, M.y, M.z), new THREE.Vector3(m.x, M.y, M.z)
        ];
        c.edges = this._BOX_EDGES;
        c.poly2 = null;
      }
    } else {
      for (const c of this._chunks) {
        const shape = mode.h > 0
          ? this._clipBoxBySlab(c.localMin, c.localMax, mode)
          : this._thinSliceShape(c.localMin, c.localMax, mode);
        if (!shape) { c.corners = null; c.edges = null; c.poly2 = null; continue; }
        c.corners = shape.corners;
        c.edges = shape.edges;
        c.poly2 = shape.poly2;
      }
    }
  },

  // Single thin cut: box ∩ plane → one closed polygon outline.
  _thinSliceShape(m, M, mode) {
    const poly = this._clipBoxByPlane(m, M, mode.n, mode.d, mode.u, mode.v);
    if (!poly) return null;
    const edges = [];
    for (let i = 0; i < poly.length; i++) edges.push([i, (i + 1) % poly.length]);
    return { corners: poly, edges, poly2: poly.map(p => ({ u: p.dot(mode.u), v: p.dot(mode.v) })) };
  },

  // Slab (MIP/average): the box ∩ slab solid drawn as two cap outlines (where each
  // slab face cuts the box) plus the box's own edges trimmed to the [d-h, d+h] band.
  // A chunk fully inside the slab yields no caps but full trimmed edges (a whole box);
  // a chunk straddling one face yields one cap + partial edges — both read correctly.
  _clipBoxBySlab(m, M, mode) {
    const { n, d, u, v, h } = mode;
    const corners = [];
    const edges = [];
    const addLoop = (poly) => {
      if (!poly || poly.length < 2) return;
      const base = corners.length;
      for (const p of poly) corners.push(p);
      for (let i = 0; i < poly.length; i++) edges.push([base + i, base + ((i + 1) % poly.length)]);
    };
    addLoop(this._clipBoxByPlane(m, M, n, d - h, u, v));
    addLoop(this._clipBoxByPlane(m, M, n, d + h, u, v));

    const c = [
      [m.x, m.y, m.z], [M.x, m.y, m.z], [M.x, M.y, m.z], [m.x, M.y, m.z],
      [m.x, m.y, M.z], [M.x, m.y, M.z], [M.x, M.y, M.z], [m.x, M.y, M.z]
    ];
    const E = [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]];
    for (const [ia, ib] of E) {
      const seg = this._clipSegmentToSlab(c[ia], c[ib], n, d, h);
      if (!seg) continue;
      const base = corners.length;
      corners.push(new THREE.Vector3(seg.a[0], seg.a[1], seg.a[2]));
      corners.push(new THREE.Vector3(seg.b[0], seg.b[1], seg.b[2]));
      edges.push([base, base + 1]);
    }
    if (corners.length === 0) return null;

    // Hover hit-testing uses the centre section; chunks the centre plane misses (but
    // that still lie in the slab) are covered by the ray↔slab test in _recomputeStack.
    const centre = this._clipBoxByPlane(m, M, n, d, u, v);
    const poly2 = centre ? centre.map(p => ({ u: p.dot(u), v: p.dot(v) })) : null;
    return { corners, edges, poly2 };
  },

  // Clip segment A→B to the slab band d-h ≤ n·p ≤ d+h. Returns the trimmed
  // endpoints {a, b} (arrays) or null if the segment lies entirely outside the band.
  _clipSegmentToSlab(A, B, n, d, h) {
    const fa = n.x * A[0] + n.y * A[1] + n.z * A[2] - d;
    const df = (n.x * B[0] + n.y * B[1] + n.z * B[2] - d) - fa;
    let t0 = 0, t1 = 1;
    // Two half-space constraints: f ≤ h (sign +1) and -f ≤ h (sign -1).
    for (const sign of [1, -1]) {
      const aa = sign * df;
      const bb = h - sign * fa;          // require aa·t ≤ bb
      if (Math.abs(aa) < 1e-12) {
        if (bb < 0) return null;          // violated for all t
      } else if (aa > 0) {
        if (bb / aa < t1) t1 = bb / aa;   // upper bound
      } else {
        if (bb / aa > t0) t0 = bb / aa;   // lower bound
      }
    }
    if (t1 < t0) return null;
    const lerp = (t) => [A[0] + t * (B[0] - A[0]), A[1] + t * (B[1] - A[1]), A[2] + t * (B[2] - A[2])];
    return { a: lerp(t0), b: lerp(t1) };
  },

  // Box ∩ plane (normal·x = d) → ordered polygon, via edge crossings. 4 points
  // for an axis-aligned cut (a square), 3–6 for an oblique one. Null if no cut.
  _clipBoxByPlane(m, M, n, d, u, v) {
    const c = [
      [m.x, m.y, m.z], [M.x, m.y, m.z], [M.x, M.y, m.z], [m.x, M.y, m.z],
      [m.x, m.y, M.z], [M.x, m.y, M.z], [M.x, M.y, M.z], [m.x, M.y, M.z]
    ];
    const e = [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]];
    const dist = c.map(p => n.x * p[0] + n.y * p[1] + n.z * p[2] - d);
    const pts = [];
    for (const [a, b] of e) {
      const sa = dist[a], sb = dist[b];
      if ((sa <= 0 && sb > 0) || (sb <= 0 && sa > 0)) {
        const t = sa / (sa - sb);
        pts.push(new THREE.Vector3(
          c[a][0] + t * (c[b][0] - c[a][0]),
          c[a][1] + t * (c[b][1] - c[a][1]),
          c[a][2] + t * (c[b][2] - c[a][2])
        ));
      }
    }
    if (pts.length < 3) return null;
    // Order CCW around the centroid in the in-plane (u,v) basis.
    let cu = 0, cv = 0;
    for (const p of pts) { cu += p.dot(u); cv += p.dot(v); }
    cu /= pts.length; cv /= pts.length;
    pts.sort((p, q) =>
      Math.atan2(p.dot(v) - cv, p.dot(u) - cu) - Math.atan2(q.dot(v) - cv, q.dot(u) - cu));
    return pts;
  },

  // ── hover / depth cycling / copy ─────────────────────────────────────────────

  _handlePointerMove(e) {
    this._lastPointer = { x: e.clientX, y: e.clientY };
    if (this._tooltip && this._tooltip.style.display !== 'none') this._positionTooltip();
    if (this._moveRaf) return;
    this._moveRaf = requestAnimationFrame(() => { this._moveRaf = null; this._recomputeStack(); });
  },

  _handlePointerLeave() {
    this._lastPointer = null;
    this._setStack([]);
  },

  _handlePointerDown(e) {
    this._downXY = { x: e.clientX, y: e.clientY };
  },

  // CTRL + wheel cycles the overlap stack; a plain wheel falls through to the
  // viewer's normal zoom (we don't touch the event).
  _handleWheel(e) {
    if (!this._active || !e.ctrlKey || !this._stack.length) return;
    e.preventDefault();
    e.stopPropagation();
    const dir = e.deltaY > 0 ? 1 : -1;
    const next = Math.max(0, Math.min(this._stack.length - 1, this._depthIndex + dir));
    if (next !== this._depthIndex) {
      this._depthIndex = next;
      this._selected = this._stack[this._depthIndex] || null;
      this._drawOverlay();
      this._updateTooltip();
    }
  },

  // Click (not a drag) over a selected chunk → copy its metadata.
  _handleClick(e) {
    if (!this._active || !this._selected) return;
    if (this._downXY && Math.hypot(e.clientX - this._downXY.x, e.clientY - this._downXY.y) > this._DRAG_PX) return;
    this._copyText(this._metaClipboardText(this._selected));
  },

  _recomputeStack() {
    if (!this._active || !this._cube || !this._lastPointer) { this._setStack([]); return; }
    const camera = VolumeViewer.getCamera();
    const renderer = VolumeViewer.getRenderer();
    if (!camera || !renderer) return;
    const rect = renderer.domElement.getBoundingClientRect();
    const ndc = {
      x: ((this._lastPointer.x - rect.left) / Math.max(1, rect.width)) * 2 - 1,
      y: -(((this._lastPointer.y - rect.top) / Math.max(1, rect.height)) * 2 - 1)
    };
    this._raycaster.setFromCamera(ndc, camera);
    this._cube.updateMatrixWorld();
    const inv = new THREE.Matrix4().copy(this._cube.matrixWorld).invert();
    const ray = this._raycaster.ray.clone().applyMatrix4(inv);

    const hits = [];
    if (this._mode.type === 'box') {
      for (const c of this._chunks) {
        const t = this._rayAabb(ray, c.localMin, c.localMax);
        if (t !== null) hits.push({ c, t });
      }
    } else if (this._mode.h > 0) {
      // Slab: a chunk is under the cursor when the ray crosses (box ∩ slab).
      const { n, d, h } = this._mode;
      for (const c of this._chunks) {
        if (!this._raySlabBox(ray, c.localMin, c.localMax, n, d, h)) continue;
        const center = c.localMin.clone().add(c.localMax).multiplyScalar(0.5);
        hits.push({ c, t: center.sub(ray.origin).dot(ray.direction) });
      }
    } else {
      const { n, d, u, v } = this._mode;
      const denom = n.dot(ray.direction);
      if (Math.abs(denom) > 1e-6) {
        const t = (d - n.dot(ray.origin)) / denom;
        if (t > 0) {
          const p = ray.origin.clone().addScaledVector(ray.direction, t);
          const pu = p.dot(u), pv = p.dot(v);
          for (const c of this._chunks) {
            if (!c.poly2 || !this._pointInPoly(pu, pv, c.poly2)) continue;
            // Order overlapping sections by camera depth (distance along the ray
            // to the chunk centre) so the wheel walks them front → back.
            const center = c.localMin.clone().add(c.localMax).multiplyScalar(0.5);
            hits.push({ c, t: center.sub(ray.origin).dot(ray.direction) });
          }
        }
      }
    }
    hits.sort((a, b) => a.t - b.t);
    this._setStack(hits.map(h => h.c));
  },

  _rayAabb(ray, min, max) {
    const o = ray.origin, dir = ray.direction;
    let tmin = -Infinity, tmax = Infinity;
    for (const ax of ['x', 'y', 'z']) {
      const dd = dir[ax];
      if (Math.abs(dd) < 1e-9) {
        // Ray parallel to this slab: a miss unless the origin is already inside
        // it. Guarding here avoids 0·Infinity = NaN poisoning the comparisons.
        if (o[ax] < min[ax] || o[ax] > max[ax]) return null;
        continue;
      }
      const inv = 1 / dd;
      let t1 = (min[ax] - o[ax]) * inv;
      let t2 = (max[ax] - o[ax]) * inv;
      if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
      if (t1 > tmin) tmin = t1;
      if (t2 < tmax) tmax = t2;
      if (tmax < tmin) return null;
    }
    if (tmax < 0) return null;
    return tmin >= 0 ? tmin : tmax; // entry distance (exit if the camera is inside)
  },

  // Ray ↔ AABB as the full [t0, t1] entry/exit interval (null = miss). Unlike
  // _rayAabb it keeps both bounds so the slab test can intersect the two intervals.
  _rayAabbRange(ray, min, max) {
    const o = ray.origin, dir = ray.direction;
    let tmin = -Infinity, tmax = Infinity;
    for (const ax of ['x', 'y', 'z']) {
      const dd = dir[ax];
      if (Math.abs(dd) < 1e-9) {
        if (o[ax] < min[ax] || o[ax] > max[ax]) return null;
        continue;
      }
      const inv = 1 / dd;
      let t1 = (min[ax] - o[ax]) * inv;
      let t2 = (max[ax] - o[ax]) * inv;
      if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
      if (t1 > tmin) tmin = t1;
      if (t2 < tmax) tmax = t2;
      if (tmax < tmin) return null;
    }
    return { t0: tmin, t1: tmax };
  },

  // True when the ray crosses (box ∩ slab) in front of the camera — i.e. the box
  // entry/exit interval, the slab band -h ≤ n·p-d ≤ h interval and t ≥ 0 all overlap.
  _raySlabBox(ray, min, max, n, d, h) {
    const box = this._rayAabbRange(ray, min, max);
    if (!box) return false;
    let s0 = -Infinity, s1 = Infinity;
    const a = n.dot(ray.direction);
    const b = n.dot(ray.origin) - d;
    if (Math.abs(a) < 1e-9) {
      if (Math.abs(b) > h) return false;     // ray parallel to the slab and outside it
    } else {
      let ta = (-h - b) / a, tb = (h - b) / a;
      if (ta > tb) { const tmp = ta; ta = tb; tb = tmp; }
      s0 = ta; s1 = tb;
    }
    const lo = Math.max(box.t0, s0);
    const hi = Math.min(box.t1, s1);
    return hi >= lo && hi >= 0;
  },

  _pointInPoly(px, py, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i].u, yi = poly[i].v, xj = poly[j].u, yj = poly[j].v;
      if (((yi > py) !== (yj > py)) && (px < (xj - xi) * (py - yi) / (yj - yi) + xi)) inside = !inside;
    }
    return inside;
  },

  _setStack(arr) {
    const key = arr.map(c => c.key).join(',');
    if (key !== this._stackKey) { this._stackKey = key; this._depthIndex = 0; }
    this._stack = arr;
    if (this._depthIndex > arr.length - 1) this._depthIndex = Math.max(0, arr.length - 1);
    this._selected = arr[this._depthIndex] || null;
    this._drawOverlay();
    this._updateTooltip();
  },

  // ── tooltip + clipboard ──────────────────────────────────────────────────────

  _buildTooltip() {
    if (this._tooltip) return;
    const el = document.createElement('div');
    el.className = 'chunk-debug-tooltip';
    el.style.cssText = [
      'position:fixed',
      'z-index:var(--z-viewer-popover, 9999)',
      'pointer-events:none',
      'display:none',
      'max-width:340px',
      'padding:var(--space-2, 8px) var(--space-3, 12px)',
      'background:var(--bg-surface, #1A1A2E)',
      'color:var(--text-primary, #E8E8F0)',
      'border:1px solid var(--color-primary, #00A654)',
      'border-radius:var(--radius-md, 10px)',
      'box-shadow:var(--shadow-lg, 0 10px 30px rgba(0,0,0,0.4))',
      'font-size:var(--text-xs, 11px)',
      'line-height:1.55',
      'backdrop-filter:blur(6px)',
      '-webkit-backdrop-filter:blur(6px)'
    ].join(';');
    document.body.appendChild(el);
    this._tooltip = el;
  },

  // Shared value strings so the tooltip and the clipboard text never drift.
  _metaValues(sel) {
    const um = sel.umDims ? ` (${sel.umDims.map(x => x.toFixed(1)).join('×')} µm)` : '';
    const size = `${sel.voxDims.join('×')} ${this._t('tipVox')}${um}`;
    let stored = null;
    if (sel.bytes != null) {
      const ch = sel.channels > 1 ? ` · ${sel.channels} ${this._t('tipChannels')}` : '';
      stored = `${this._fmtBytes(sel.bytes)}${ch}`;
    }
    return { size, stored };
  },

  _updateTooltip() {
    const tip = this._tooltip;
    if (!tip) return;
    const sel = this._selected;
    if (!sel || !this._lastPointer) { tip.style.display = 'none'; return; }
    const esc = s => (this._ctx.ui && this._ctx.ui.escapeHtml) ? this._ctx.ui.escapeHtml(String(s)) : String(s);
    const vals = this._metaValues(sel);
    const multi = this._stack.length > 1;
    const depth = multi ? ` · ${this._t('tipDepth')} ${this._depthIndex + 1}/${this._stack.length}` : '';
    const rows = [];
    rows.push(`<div style="font-weight:600;color:var(--color-primary,#00A654);margin-bottom:2px">${this._t('tipId')} ${esc(sel.id)}</div>`);
    rows.push(`<div>${this._t('tipSize')}: ${esc(vals.size)}</div>`);
    if (vals.stored) rows.push(`<div>${this._t('tipStored')}: ${esc(vals.stored)}</div>`);
    if (sel.file) rows.push(`<div>${this._t('tipFile')}: <span style="font-family:var(--font-mono,monospace);word-break:break-all">${esc(sel.file)}</span></div>`);
    rows.push(`<div style="opacity:.65;margin-top:2px">${this._t('tipLod')} ${this._lod}${depth}</div>`);
    const hint = this._t('hintCopy') + (multi ? ` · ${this._t('hintCycle')}` : '');
    rows.push(`<div style="opacity:.5;margin-top:3px">${esc(hint)}</div>`);
    tip.innerHTML = rows.join('');
    tip.style.display = 'block';
    this._positionTooltip();
  },

  _positionTooltip() {
    const tip = this._tooltip;
    if (!tip || !this._lastPointer) return;
    const pad = 14;
    let x = this._lastPointer.x + pad;
    let y = this._lastPointer.y + pad;
    const w = tip.offsetWidth, h = tip.offsetHeight;
    if (x + w > window.innerWidth) x = Math.max(0, this._lastPointer.x - pad - w);
    if (y + h > window.innerHeight) y = Math.max(0, this._lastPointer.y - pad - h);
    tip.style.left = x + 'px';
    tip.style.top = y + 'px';
  },

  _metaClipboardText(sel) {
    const vals = this._metaValues(sel);
    const lines = [
      `${this._t('tipId')}: ${sel.id}`,
      `${this._t('tipSize')}: ${vals.size}`
    ];
    if (vals.stored) lines.push(`${this._t('tipStored')}: ${vals.stored}`);
    if (sel.file) lines.push(`${this._t('tipFile')}: ${sel.file}`);
    lines.push(`${this._t('tipLod')}: ${this._lod}`);
    return lines.join('\n');
  },

  _copyText(text) {
    const ok = () => { if (this._ctx.ui && this._ctx.ui.toast) this._ctx.ui.toast(this._t('copied')); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(ok).catch(() => this._copyFallback(text, ok));
    } else {
      this._copyFallback(text, ok);
    }
  },

  // Fallback for non-secure contexts where the async Clipboard API is blocked.
  _copyFallback(text, ok) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
      ok();
    } catch (e) {
      console.warn('[chunk-debug] clipboard copy failed:', e);
    }
  },

  _fmtBytes(n) {
    if (!Number.isFinite(n)) return '—';
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(2)} MB`;
  }
});
