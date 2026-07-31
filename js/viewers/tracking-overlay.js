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
  let _frame = 0;
  let _stabilized = false;
  let _style = { visible: true, diameterUm: 12, opacity: 0.95 };

  const _v = new THREE.Vector3();
  const _o = new THREE.Vector3();
  const _m = new THREE.Matrix4();
  const _c = new THREE.Color();

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
    _group.add(_mesh);
    _volumeObject.add(_group);
  }

  function _destroyMesh() {
    if (_group && _volumeObject) _volumeObject.remove(_group);
    _geometry?.dispose?.();
    _material?.dispose?.();
    _mesh = null; _geometry = null; _material = null; _group = null;
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
      _v.set(src[base + i * 3], src[base + i * 3 + 1], src[base + i * 3 + 2]);
      if (!_umToObject(_v, _o)) continue;
      // Same clip test the shader runs, so the layer follows the Z-stack slab and
      // the clip sliders instead of floating over a volume that is mostly hidden.
      if (!_isInsideClip(_o)) continue;
      _m.makeScale(sx, sy, sz);
      _m.setPosition(_o.x, _o.y, _o.z);
      _mesh.setMatrixAt(drawn, _m);
      const c = cellIdx[f * maxN + i] * 3;
      _c.setRGB(palette[c], palette[c + 1], palette[c + 2]);
      _mesh.setColorAt(drawn, _c);
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
  /** True when the file carries raw coordinates for every cell. Without them the
   *  layer cannot be shown against an UNstabilised volume — the two would be in
   *  different frames, and a plausible-looking wrong overlay is worse than none. */
  function hasRawCoordinates() { return Boolean(_data && _data.hasRaw); }
  function getRegions() {
    if (!_data) return [];
    const seen = new Map();
    for (let c = 0; c < _data.cellTotal; c++) {
      const name = _data.regions[c] || 'Unknown';
      if (!seen.has(name)) {
        seen.set(name, {
          name,
          color: `#${[0, 1, 2].map(k => Math.round(_data.palette[c * 3 + k] * 255)
            .toString(16).padStart(2, '0')).join('')}`,
          cells: 0
        });
      }
      seen.get(name).cells++;
    }
    return [...seen.values()].sort((a, b) => b.cells - a.cells);
  }

  function dispose() {
    _disposed = true;
    _terminate();
    _destroyMesh();
    _data = null;
  }

  return {
    init, load, setFrame, setStyle, getStyle, refresh, dispose,
    isLoaded, getCount, getRegions, hasRawCoordinates
  };
})();
