/**
 * DataAccess — the one door to the NATIVE, LOSSLESS voxels (DOCS/dataset-migrations/SPEC.md
 * §14.8), exposed to plugins as `ctx.data`.
 *
 * What the viewer DISPLAYS may be a compressed cell of the quality matrix (a coarser level,
 * a ±2 / ±4 quantizer, WebP lossy); anything that reports a number — an intensity profile,
 * a region histogram, a measurement — reads here instead: level 0 of the tree ON SCREEN (a timelapse frame), its
 * lossless column (`ll` of a v5 tree; the only column of a v3 or v2 tree), decoded by the
 * loader's workers, never the GPU atlas.
 *
 * Frames:
 *   screen pixel → display box (VolumeViewer.pickVolumePoint) → texture [0, 1]³ of the
 *     timepoint on screen (the pick's `acquisition`: through the stabilisation warp on a
 *     stabilised timelapse, whose display frame is not the frame the voxels are stored in)
 *   → physical µm: µm = voxel · voxelSize₀, origin at the corner of voxel (0, 0, 0)
 *   → level-k voxel: v_k = µm / voxelSize_k (voxelSize_k = voxelSize₀ · dims₀ / dims_k per
 *     XY axis; Z is never reduced in format 5)
 *   → file: the 64³ brick floor(v₀ / 64), its pack, byte offset and length.
 */
const DataAccess = (() => {
  const BS = 64;
  const MAX_REGION_BYTES = 512 * 1024 * 1024;

  function _ready() {
    if (typeof BrickLoader === 'undefined' || !BrickLoader.isReady?.()) {
      throw Object.assign(new Error('DataAccess: no dataset is mounted'), { code: 'NO_DATASET' });
    }
  }

  function _level(k = 0) {
    const info = BrickLoader.getLevelInfo?.(k);
    if (!info) throw Object.assign(new Error(`DataAccess: level ${k} does not exist`), { code: 'NO_LEVEL' });
    return info;
  }

  // ── The tree on screen ────────────────────────────────────────────────────
  // BrickLoader's mounted tree is not always the frame on screen: the background prefetch
  // of a timelapse mounts the timepoints after it, and a cached frame is shown without a
  // mount. Every read that reports voxel values pins the displayed frame's tree
  // (BrickLoader.pinTree) and reads it whatever is mounted meanwhile.

  /**
   * The brick tree of the volume on screen: { path, manifest }. A page with a VolumeViewer
   * answers from it alone: when it shows no brick tree (nothing activated yet, the volumes
   * released by a WebGL context loss, a slice stack) the answer is { path: null } — the
   * mounted tree is then whatever the prefetch left, another frame than the one the
   * timeline names. Only a page without a viewer falls back to the mounted tree.
   */
  function displayedTree() {
    if (typeof VolumeViewer !== 'undefined' && typeof VolumeViewer.getDisplayedTree === 'function') {
      const shown = VolumeViewer.getDisplayedTree();
      return shown && shown.path && shown.manifest
        ? { path: String(shown.path).replace(/\/$/, ''), manifest: shown.manifest }
        : { path: null, manifest: null };
    }
    if (typeof BrickLoader === 'undefined') return { path: null, manifest: null };
    return { path: BrickLoader.getBasePath?.() || null, manifest: BrickLoader.getManifest?.() || null };
  }

  let _pin = null;   // { path, manifest, handle } of the last tree pinned

  /**
   * A BrickLoader handle on the tree on screen (for `loadBrickTasks(…, { mount })` and
   * `BrickLoader.withMount`), or null from a loader that cannot pin (the read then
   * addresses the mounted tree). Rejects BRICKS_MOUNT_CHANGED when the volume on screen
   * belongs to another dataset than the mounted one (a dataset switch under way), and
   * NO_DATASET when the viewer shows no brick tree (displayedTree() has no path): reading
   * the mounted tree then would report a frame nobody sees.
   */
  async function pinDisplayed({ signal } = {}) {
    _ready();
    if (typeof BrickLoader.pinTree !== 'function') return null;
    const t = displayedTree();
    if (!t.path || !t.manifest) {
      throw Object.assign(new Error('DataAccess: no brick tree is on screen'), { code: 'NO_DATASET' });
    }
    const handle = await BrickLoader.pinTree(t.path, t.manifest, { signal });
    _pin = { path: t.path, manifest: t.manifest, handle };
    return handle;
  }

  /** `fn()` answered by the pinned tree on screen when it is still the one shown, else by the mounted tree. */
  function _onShownTree(fn) {
    const t = _pin ? displayedTree() : null;
    if (t && _pin.path === t.path && _pin.manifest === t.manifest) {
      try {
        return BrickLoader.withMount(_pin.handle, fn);
      } catch (err) {
        if (!err || err.code !== 'BRICKS_MOUNT_CHANGED') throw err;
        _pin = null;
      }
    }
    return fn();
  }

  /** Voxel size (µm) of level k, derived from level 0 and the level's dimensions. */
  function voxelSize(k = 0) {
    _ready();
    const L0 = _level(0);
    const Lk = _level(k);
    const v0 = L0.voxelSize || (typeof VolumeViewer !== 'undefined' ? _physicalVoxel(L0) : null) || { x: 1, y: 1, z: 1 };
    if (Lk.voxelSize) return { ...Lk.voxelSize };
    return {
      x: v0.x * L0.dims.x / Lk.dims.x,
      y: v0.y * L0.dims.y / Lk.dims.y,
      z: v0.z * L0.dims.z / Lk.dims.z
    };
  }

  function _physicalVoxel(L0) {
    const p = VolumeViewer.getPhysicalSize?.();
    if (!p || !(p.x > 0)) return null;
    return { x: p.x / L0.dims.x, y: p.y / L0.dims.y, z: p.z / L0.dims.z };
  }

  /** {version, columns, channels, dims0, voxelSize0, lossless} of the mounted tree. */
  function info() {
    _ready();
    const fmt = BrickLoader.getFormat();
    const L0 = _level(0);
    return {
      version: fmt.version,
      columns: fmt.columns ? fmt.columns.map(c => c.id) : ['ll'],
      channels: fmt.channels,
      dims0: { ...L0.dims },
      voxelSize0: voxelSize(0),
      lossless: true
    };
  }

  /** The levels of the mounted tree, finest first: [{ level, dims: {x, y, z}, voxelSize: {x, y, z} }]. */
  function levels() {
    _ready();
    const out = [];
    for (let k = 0; ; k++) {
      const L = BrickLoader.getLevelInfo?.(k);
      if (!L) break;
      out.push({ level: k, dims: { ...L.dims }, voxelSize: voxelSize(k) });
    }
    return out;
  }

  /** Physical µm → voxel coordinates (floats) of level k. */
  function toVoxel(um, { level = 0 } = {}) {
    const v = voxelSize(level);
    return { x: um.x / v.x, y: um.y / v.y, z: um.z / v.z };
  }

  /** Voxel coordinates of level k → physical µm (of the voxel's corner for integers). */
  function toUm(voxel, { level = 0 } = {}) {
    const v = voxelSize(level);
    return { x: voxel.x * v.x, y: voxel.y * v.y, z: voxel.z * v.z };
  }

  /**
   * The native voxel under a screen point: { um (acquisition frame, = voxelFloat ·
   * voxelSize₀), voxel (integer, level 0), voxelFloat, onBoundingBox, depthSource } — or
   * null when nothing of the volume is there, including a point of a stabilised
   * timelapse's display box that the timepoint on screen does not cover.
   */
  function screenToVoxel(clientX, clientY) {
    _ready();
    const hit = VolumeViewer.pickVolumePoint?.(clientX, clientY);
    const t = hit?.acquisition;
    if (!t) return null;
    const d = _level(0).dims;
    // Texture coordinate → voxel the way the shader reads it (voxel floor(t · dims)).
    const vf = { x: t.x * d.x, y: t.y * d.y, z: t.z * d.z };
    const voxel = {
      x: Math.min(d.x - 1, Math.max(0, Math.floor(vf.x))),
      y: Math.min(d.y - 1, Math.max(0, Math.floor(vf.y))),
      z: Math.min(d.z - 1, Math.max(0, Math.floor(vf.z)))
    };
    return { um: toUm(vf, { level: 0 }), voxel, voxelFloat: vf, onBoundingBox: Boolean(hit.onBoundingBox), depthSource: hit.depthSource || null };
  }

  /**
   * Where a native voxel's lossless value is stored: { brick: {bx, by, bz}, inBrick: {x,y,z},
   * pack: {url (relative to the tree), offset, length} | null (the brick holds only zeros),
   * plane: {url, tile: {tx, ty}} | null (format ≥ 2: planes/zNNNNN.bin) }. The pack is the
   * one of the tree on screen once it is pinned (any readRegion / valueAt, or pinDisplayed()).
   */
  function locate(voxel, channel = 0) {
    _ready();
    const d = _level(0).dims;
    const x = Math.floor(voxel.x), y = Math.floor(voxel.y), z = Math.floor(voxel.z);
    if (!(x >= 0 && x < d.x && y >= 0 && y < d.y && z >= 0 && z < d.z)) {
      throw Object.assign(new Error('DataAccess.locate: voxel outside the volume'), { code: 'OUTSIDE' });
    }
    const brick = { bx: Math.floor(x / BS), by: Math.floor(y / BS), bz: Math.floor(z / BS) };
    const pack = _onShownTree(() => BrickLoader.brickLocation({ lod: 0, channel, ...brick, column: 'll' }));
    return {
      brick,
      inBrick: { x: x - brick.bx * BS, y: y - brick.by * BS, z: z - brick.bz * BS },
      pack: pack ? { url: pack.url.replace(/\?v=.*$/, ''), offset: pack.offset, length: pack.length } : null,
      plane: { url: `planes/z${String(z).padStart(5, '0')}.bin`, tile: { tx: Math.floor(x / 512), ty: Math.floor(y / 512) } }
    };
  }

  /**
   * The lossless voxels of `box` ({x0, x1, y0, y1, z0, z1}, voxel bounds, end exclusive) of
   * level `level` (0 = native) for `channels`: { dims: {x, y, z}, data: [Uint8Array] one per
   * channel (z-major, then y, then x) }. Refused above 512 MiB (code REGION_TOO_LARGE).
   * `onProgress(f)`: the fraction of the region's bricks settled, 0..1, ending at 1.
   */
  async function readRegion(box, channels = [0], { level = 0, signal, onProgress } = {}) {
    _ready();
    // The occupancy and the reads below are the tree on screen's, pinned now: another
    // timepoint mounted meanwhile (the prefetch of the next frames) changes nothing.
    const handle = await pinDisplayed({ signal });
    const onTree = (fn) => (handle ? BrickLoader.withMount(handle, fn) : fn());
    const L = onTree(() => _level(level));
    const d = L.dims;
    const b = {
      x0: Math.max(0, Math.floor(box.x0)), x1: Math.min(d.x, Math.ceil(box.x1)),
      y0: Math.max(0, Math.floor(box.y0)), y1: Math.min(d.y, Math.ceil(box.y1)),
      z0: Math.max(0, Math.floor(box.z0)), z1: Math.min(d.z, Math.ceil(box.z1))
    };
    const w = b.x1 - b.x0, h = b.y1 - b.y0, dd = b.z1 - b.z0;
    if (w <= 0 || h <= 0 || dd <= 0) throw Object.assign(new Error('DataAccess.readRegion: empty box'), { code: 'EMPTY' });
    const chans = (Array.isArray(channels) ? channels : [channels]).map(Number);
    if (w * h * dd * chans.length > MAX_REGION_BYTES) {
      throw Object.assign(new Error('DataAccess.readRegion: the region exceeds 512 MiB'), { code: 'REGION_TOO_LARGE' });
    }
    const apron = Number(onTree(() => BrickLoader.getFormat()).apron) || 0;
    // Without a pin (an older loader), the read names the mounted manifest it was planned
    // on, so a timepoint mounted meanwhile fails it rather than mixing two frames.
    const manifest = handle ? null : (typeof BrickLoader.getManifest === 'function' ? BrickLoader.getManifest() : null);
    const out = chans.map(() => new Uint8Array(w * h * dd));
    const tasks = [];
    onTree(() => {
      for (let bz = Math.floor(b.z0 / BS); bz * BS < b.z1; bz++) {
        for (let by = Math.floor(b.y0 / BS); by * BS < b.y1; by++) {
          for (let bx = Math.floor(b.x0 / BS); bx * BS < b.x1; bx++) {
            if (BrickLoader.hasBrick && !BrickLoader.hasBrick(bx, by, bz, level)) continue;
            // The box of this brick's interior inside the region, in the brick's frame.
            const r = {
              x0: Math.max(b.x0, bx * BS) - bx * BS, x1: Math.min(b.x1, bx * BS + BS) - bx * BS,
              y0: Math.max(b.y0, by * BS) - by * BS, y1: Math.min(b.y1, by * BS + BS) - by * BS,
              z0: Math.max(b.z0, bz * BS) - bz * BS, z1: Math.min(b.z1, bz * BS + BS) - bz * BS
            };
            const region = { x0: r.x0 + apron, x1: r.x1 + apron, y0: r.y0 + apron, y1: r.y1 + apron, z0: r.z0 + apron, z1: r.z1 + apron };
            chans.forEach((c, i) => tasks.push({ bx, by, bz, lod: level, channel: c, column: 'll', region, _slot: i, _r: r }));
          }
        }
      }
    });
    // A failing progress callback is the caller's bug: it must not abort the read.
    const progress = (f) => {
      if (typeof onProgress !== 'function') return;
      try { onProgress(Math.min(1, Math.max(0, Number(f) || 0))); } catch (err) { console.error('[DataAccess] onProgress failed:', err); }
    };
    if (!tasks.length) { progress(1); return { dims: { x: w, y: h, z: dd }, data: out }; }
    const bySlot = new Map(tasks.map(t => [`${t.bx}_${t.by}_${t.bz}_${t.channel}`, t]));
    const result = await BrickLoader.loadBrickTasks(tasks.map(({ _slot, _r, ...t }) => t), {
      group: `data-access-${Math.random().toString(36).slice(2)}`,
      cancelPrevious: false,
      byteRanges: true,
      streamOnly: true,
      signal,
      ...(handle ? { mount: handle } : (manifest ? { manifest } : {})),
      onProgress: progress,
      onBrickLoaded: (row) => {
        const t = bySlot.get(`${row.bx}_${row.by}_${row.bz}_${row.channel}`);
        if (!t || !row.data) return;
        const r = t._r;
        const rw = r.x1 - r.x0, rh = r.y1 - r.y0, rd = r.z1 - r.z0;
        if (row.data.length !== rw * rh * rd) return;
        const dst = out[t._slot];
        const ox = t.bx * BS + r.x0 - b.x0, oy = t.by * BS + r.y0 - b.y0, oz = t.bz * BS + r.z0 - b.z0;
        for (let z = 0; z < rd; z++) {
          for (let y = 0; y < rh; y++) {
            const s = (z * rh + y) * rw;
            dst.set(row.data.subarray(s, s + rw), ((oz + z) * h + (oy + y)) * w + ox);
          }
        }
      }
    });
    const failed = result?.summary?.failed || [];
    if (failed.length) throw Object.assign(new Error(`DataAccess.readRegion: ${failed.length} brick(s) could not be read`), { code: 'READ_FAILED', failed });
    if (result?.summary?.cancelled) throw Object.assign(new Error('DataAccess.readRegion: cancelled'), { name: 'AbortError' });
    return { dims: { x: w, y: h, z: dd }, data: out };
  }

  /** The lossless values of one native voxel: [value per channel]. */
  async function valueAt(voxel, channels = null, opts = {}) {
    const chans = channels || Array.from({ length: info().channels }, (_, c) => c);
    const x = Math.floor(voxel.x), y = Math.floor(voxel.y), z = Math.floor(voxel.z);
    const r = await readRegion({ x0: x, x1: x + 1, y0: y, y1: y + 1, z0: z, z1: z + 1 }, chans, opts);
    return r.data.map(a => a[0]);
  }

  return { info, levels, voxelSize, toVoxel, toUm, screenToVoxel, locate, readRegion, valueAt, displayedTree, pinDisplayed, MAX_REGION_BYTES };
})();
