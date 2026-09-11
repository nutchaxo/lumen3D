/* ============================================================
   IRIBHM Microscopy Platform — Tracking overlay
   ============================================================
   Draws the tracked cell centroids of a 4D series on top of the volume, in the
   volume's own frame. Parented to the volume cube, so the orbit, the pan, the
   physical aspect ratio and the operator's Z display scale all apply for free.

   Two decisions worth stating, because getting either wrong is invisible at the
   first timepoint and grossly wrong at the last:

   1. WHICH COORDINATES. The cube's object space IS stabilised micrometres when the
      shader warp is active (volumeWarp = toTex . M^-1 . toUm, so a sampling point
      is read as already-stabilised), and RAW acquisition micrometres when it is
      not. tracks.json carries both sets, so this is a dictionary switch, never a
      matrix multiply. Applying M to already-stabilised points would send them into
      a third frame — identical at t=1 (that transform is the identity) and ~250 um
      out by t=30, which reads as a general alignment bug rather than a wrong branch.

   2. HOW BIG. Instanced spheres, not THREE.Points. gl_PointSize is a pixel count:
      to express a diameter in micrometres it has to be divided by tan(fov/2), it
      is clamped by the driver's ALIASED_POINT_SIZE_RANGE (63 px on some Intel
      parts, so points stop growing when you zoom in), and it draws squares. A
      sphere whose per-instance scale compensates cube.scale is round in world
      space, honest in micrometres at any zoom, and survives the Z display scale.

   The overlay also owns the packed tracking tables for the whole page: the
   analysis plugins (trails, surface, inspector, charts, cell distance) read
   positions through positionUm()/positionObject() and pick cells through pick(),
   so there is exactly one copy of the data and one um -> object transform.
   ============================================================ */

const TrackingOverlay = (() => {
  let _volumeObject = null;
  let _umToObject = null;
  let _isInsideClip = null;
  let _onDirty = null;
  let _acqSize = null;

  let _group = null;
  let _mesh = null;
  let _geometry = null;
  let _material = null;
  let _worker = null;
  let _disposed = false;

  let _data = null;          // packed arrays from the worker
  let _drawn = null;         // instance index -> cell index, for picking
  let _frame = 0;
  let _stabilized = false;
  let _selected = -1;
  let _style = { visible: true, diameterUm: 12, opacity: 0.95, showMitosis: true, showFusion: true };

  const SELECTED_SCALE = 1.8;
  const FLAG_MITOSIS = 1;
  const FLAG_FUSION = 2;

  const _v = new THREE.Vector3();
  const _o = new THREE.Vector3();
  const _m = new THREE.Matrix4();
  const _c = new THREE.Color();
  const _raycaster = new THREE.Raycaster();
  const _ndc = new THREE.Vector2();

  function init(opts = {}) {
    _volumeObject = opts.volumeObject || null;
    _umToObject = opts.umToObject || null;
    _isInsideClip = opts.isInsideClip || (() => true);
    _onDirty = opts.onDirty || (() => {});
    _acqSize = opts.acqSize || null;
    _disposed = false;
    return Boolean(_volumeObject && _umToObject && _acqSize);
  }

  function _ensureMesh(maxN) {
    if (_mesh && _mesh.count >= 0 && _geometry && _mesh.instanceMatrix.count >= maxN) return;
    _destroyMesh();
    _group = new THREE.Group();
    _group.renderOrder = 40;          // above the measurement group (30/35)
    // Unit DIAMETER sphere: instance scale is then the world diameter directly.
    _geometry = new THREE.SphereGeometry(0.5, 12, 8);
    _material = new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: _style.opacity,
      depthWrite: false,
      // The volume is an additive raymarch with no depth: a depth test would hide
      // every centroid behind the front face of the cube.
      depthTest: false
    });
    _mesh = new THREE.InstancedMesh(_geometry, _material, Math.max(1, maxN));
    _mesh.frustumCulled = false;      // positions are rewritten per frame
    _mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    _mesh.count = 0;
    _drawn = new Int32Array(Math.max(1, maxN));
    _group.add(_mesh);
    _volumeObject.add(_group);
  }

  function _destroyMesh() {
    if (_group && _volumeObject) _volumeObject.remove(_group);
    _geometry?.dispose?.();
    _material?.dispose?.();
    _mesh = null; _geometry = null; _material = null; _group = null; _drawn = null;
  }

  function _passesFilters(c) {
    const f = _data.flags[c];
    if (!_style.showMitosis && (f & FLAG_MITOSIS)) return false;
    if (!_style.showFusion && (f & FLAG_FUSION)) return false;
    return true;
  }

  /** Rebuild the instance matrices for the current frame. Cheap enough to redo on
   *  any change (<= 348 instances on the reference series). */
  function _rebuild() {
    if (!_data || !_mesh || _disposed) return;
    const { maxN, counts, cellIdx, palette } = _data;
    const src = _stabilized ? _data.posStab : _data.posRaw;
    const f = Math.max(0, Math.min(_data.frameCount - 1, _frame | 0));
    const n = counts[f] || 0;
    const base = f * maxN * 3;

    // 1 um in x = cube.scale.x / acqSize.x world units. Using x as the reference
    // keeps the sphere isotropic in WORLD space; dividing by each axis' own scale
    // undoes the cube's anisotropy (and the operator's Z display scale) so it does
    // not come out as an ellipsoid.
    const s = _volumeObject.scale;
    const dWorld = _style.diameterUm * (s.x / _acqSize.x);
    const sx = dWorld / (s.x || 1), sy = dWorld / (s.y || 1), sz = dWorld / (s.z || 1);

    let drawn = 0;
    for (let i = 0; i < n; i++) {
      const c = cellIdx[f * maxN + i];
      if (!_passesFilters(c)) continue;
      _v.set(src[base + i * 3], src[base + i * 3 + 1], src[base + i * 3 + 2]);
      if (!_umToObject(_v, _o)) continue;
      // Same clip test the shader runs, so the layer follows the Z-stack slab and
      // the clip sliders instead of floating over a volume that is mostly hidden.
      if (!_isInsideClip(_o)) continue;
      const k = c === _selected ? SELECTED_SCALE : 1;
      _m.makeScale(sx * k, sy * k, sz * k);
      _m.setPosition(_o.x, _o.y, _o.z);
      _mesh.setMatrixAt(drawn, _m);
      _c.setRGB(palette[c * 3], palette[c * 3 + 1], palette[c * 3 + 2]);
      _mesh.setColorAt(drawn, _c);
      _drawn[drawn] = c;
      drawn++;
    }
    _mesh.count = drawn;
    _mesh.instanceMatrix.needsUpdate = true;
    if (_mesh.instanceColor) _mesh.instanceColor.needsUpdate = true;
    _group.visible = _style.visible && drawn > 0;
    _onDirty();
  }

  function load(basePath, trackingMeta, onProgress) {
    return new Promise((resolve, reject) => {
      const path = trackingMeta && trackingMeta.tracksPath;
      if (!path) { reject(new Error('no tracksPath')); return; }
      // Version the worker URL: .htaccess caches js/ for a week, and
      // build_release.py only stamps HTML src attributes — never a string inside
      // JS — so an unversioned worker would be frozen on the host after a fix.
      _worker = new Worker(`js/workers/tracks-load-worker.js?v=${Date.now()}`);
      _worker.onmessage = (ev) => {
        const d = ev.data || {};
        if (_disposed) return;
        if (d.phase === 'error') { _terminate(); reject(new Error(d.message)); return; }
        if (d.phase !== 'done') { onProgress?.(d); return; }
        _terminate();                       // one-shot job: release it immediately
        _data = d;
        if (d.unmapped) {
          console.warn(`[TrackingOverlay] ${d.unmapped} timepoint keys had no matching frame`);
        }
        _ensureMesh(d.maxN);
        _rebuild();
        resolve(d);
      };
      _worker.onerror = (e) => { _terminate(); reject(new Error(e.message || 'worker failed')); };
      // Absolute: a relative URL inside a worker resolves against the WORKER's own
      // location (js/workers/), not the page, so `DATA_WEB/...` would 404.
      _worker.postMessage({ url: new URL(`${basePath}/${path}`, location.href).href });
    });
  }

  function _terminate() {
    _worker?.terminate?.();
    _worker = null;
  }

  function setFrame(frame, opts = {}) {
    if (Number.isFinite(frame)) _frame = frame;
    if (typeof opts.stabilized === 'boolean') _stabilized = opts.stabilized;
    _rebuild();
  }

  function setStyle(patch = {}) {
    Object.assign(_style, patch);
    if (_material && typeof patch.opacity === 'number') _material.opacity = patch.opacity;
    _rebuild();
  }

  function getStyle() { return { ..._style }; }

  /** Re-evaluate positions/scale/clip without a timepoint change (Z display scale,
   *  clip sliders, Z-stack slab). */
  function refresh() { _rebuild(); }

  function isLoaded() { return Boolean(_data); }
  function getCount() { return _mesh ? _mesh.count : 0; }
  function getData() { return _data; }
  function getFrame() { return _frame; }
  function isStabilizedFrame() { return _stabilized; }

  /** True when the file carries raw coordinates for every cell. Without them the
   *  layer cannot be shown against an UNstabilised volume — the two would be in
   *  different frames, and a plausible-looking wrong overlay is worse than none. */
  function hasRawCoordinates() { return Boolean(_data && _data.hasRaw); }

  function getRegions() {
    if (!_data) return [];
    const cells = new Array(_data.regionNames.length).fill(0);
    for (let c = 0; c < _data.cellTotal; c++) cells[_data.regionIdx[c]]++;
    return _data.regionNames
      .map((name, r) => ({ name, color: _data.regionColors[r], cells: cells[r] }))
      .sort((a, b) => b.cells - a.cells);
  }

  // ── Selection ────────────────────────────────────────────────────────────────

  function setSelected(cellIndex) {
    const next = (Number.isInteger(cellIndex) && _data && cellIndex >= 0 && cellIndex < _data.cellTotal)
      ? cellIndex : -1;
    if (next === _selected) return _selected;
    _selected = next;
    _rebuild();
    return _selected;
  }

  function getSelected() { return _selected; }

  // ── Positions ────────────────────────────────────────────────────────────────

  /** Acquisition micrometres of cell `c` at frame `f` in the reference frame the
   *  overlay currently draws (stabilised or raw), or the one forced by `opts`.
   *  Returns [x, y, z] (a fresh array, or `out` when given) or null when the cell
   *  does not exist at that frame. */
  function positionUm(c, f, opts = {}, out) {
    if (!_data) return null;
    const frame = Number.isFinite(f) ? (f | 0) : _frame;
    if (c < 0 || c >= _data.cellTotal || frame < 0 || frame >= _data.frameCount) return null;
    const slot = _data.cellFrameSlot[c * _data.frameCount + frame];
    if (slot < 0) return null;
    const stab = typeof opts.stabilized === 'boolean' ? opts.stabilized : _stabilized;
    const src = stab ? _data.posStab : _data.posRaw;
    const o = frame * _data.maxN * 3 + slot * 3;
    const r = out || [0, 0, 0];
    r[0] = src[o]; r[1] = src[o + 1]; r[2] = src[o + 2];
    return r;
  }

  /** Same point in the cube's object space (what a child of the volume object
   *  draws in). Fills `out` (a THREE.Vector3) and returns it, or null. */
  function positionObject(c, f, out, opts = {}) {
    const p = positionUm(c, f, opts);
    if (!p || !_umToObject) return null;
    _v.set(p[0], p[1], p[2]);
    return _umToObject(_v, out || new THREE.Vector3());
  }

  /** Indices of the cells present at frame `f` (filters NOT applied). */
  function cellsAt(f) {
    if (!_data) return [];
    const frame = Number.isFinite(f) ? (f | 0) : _frame;
    if (frame < 0 || frame >= _data.frameCount) return [];
    const n = _data.counts[frame] || 0;
    const outArr = new Array(n);
    for (let i = 0; i < n; i++) outArr[i] = _data.cellIdx[frame * _data.maxN + i];
    return outArr;
  }

  function insideClipObject(o) { return _isInsideClip ? _isInsideClip(o) : true; }

  // ── Picking ──────────────────────────────────────────────────────────────────

  /** The cell under a client-space point, or -1. Casts against the instanced mesh
   *  the frame actually drew, so a hidden (filtered / clipped) cell is never hit. */
  function pick(clientX, clientY, camera, domElement) {
    if (!_mesh || !_mesh.count || !_drawn || !camera || !domElement) return -1;
    const rect = domElement.getBoundingClientRect();
    _ndc.x = ((clientX - rect.left) / Math.max(1, rect.width)) * 2 - 1;
    _ndc.y = -(((clientY - rect.top) / Math.max(1, rect.height)) * 2 - 1);
    _raycaster.setFromCamera(_ndc, camera);
    const hits = _raycaster.intersectObject(_mesh, false);
    const hit = hits.find(h => h.instanceId !== undefined && h.instanceId < _mesh.count);
    return hit ? _drawn[hit.instanceId] : -1;
  }

  function dispose() {
    _disposed = true;
    _terminate();
    _destroyMesh();
    _data = null;
    _selected = -1;
  }

  return {
    init, load, setFrame, setStyle, getStyle, refresh, dispose,
    isLoaded, getCount, getRegions, hasRawCoordinates,
    getData, getFrame, isStabilizedFrame,
    setSelected, getSelected,
    positionUm, positionObject, cellsAt, insideClipObject, pick
  };
})();
