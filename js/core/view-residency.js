/* ============================================================
   IRIBHM Microscopy Platform — view-dependent brick residency
   ============================================================
   Keeps in the GPU only the bricks the screen can tell apart, at the coarsest level
   that still shows every pixel, and never finer than the quality the user chose.

   plan()  — which (level, brick) the current view needs. Pure geometry, the one the
             ray-marcher uses: a brick is the box [b·64, (b+1)·64] / dims of its own
             level in TEXTURE space, mapped to clip space by the very matrix the shader
             applies (texToClip); the clip box and the lattice of levels come from the
             caller. A brick is wanted when
               • its box meets the view frustum and the clip box,
               • no coarser stored level is good enough there (see below),
               • it is not finer than `ceilingLod` (the user's quality: 512 chosen ⇒ no
                 brick of level 1024 or native, ever).
             Level criterion. Let fp be the world size of a pixel at the brick's centre
             depth (2·z·tan(fovY/2) / viewportHeight) and v the lateral voxel size of a
             level in world units (max over x, y of volumeWorldSize / dims). A level is
             enough when v ≤ fp / voxelsPerPixel (default 1.5 ⇒ v ≤ 0.67 fp). The chosen
             level is the COARSEST enough one, floored at the ceiling. Hysteresis: a
             brick shown at level c keeps it while c is enough and the next coarser level
             is not clearly enough (v ≤ HYSTERESIS · fp / voxelsPerPixel), so a zoom that
             hovers on a boundary does not flip a brick back and forth. The decision is a
             function of the view only — never of whether the user is interacting.

   Scheduler — turns successive plans into loads and evictions against a slot budget.
             Nothing is requested twice (resident, pending, or asked and not yet
             evicted), a coarse brick stays until every finer brick that replaces it is
             resident (no hole), the base level is never evicted, eviction is LRU among
             what the current plan does not need.
   ============================================================ */
const ViewResidency = (() => {
  const BRICK = 64;
  const HYSTERESIS = 0.8;
  const DEFAULT_VOXELS_PER_PIXEL = 1.5;

  const key = (lod, bx, by, bz) => `${lod}:${bx}:${by}:${bz}`;

  /**
   * The levels of a mounted tree, finest first. `has(lod, bx, by, bz)` tells whether the
   * level stores that brick (the packer drops empty ones).
   */
  function makeLevels(dimsByLod, has) {
    return dimsByLod.map((d, lod) => ({
      lod, dims: { x: d.x, y: d.y, z: d.z },
      nx: Math.max(1, Math.ceil(d.x / BRICK)), ny: Math.max(1, Math.ceil(d.y / BRICK)), nz: Math.max(1, Math.ceil(d.z / BRICK)),
      has: (bx, by, bz) => has(lod, bx, by, bz)
    }));
  }

  /** Texture-space box of brick (bx, by, bz) of a level. */
  function brickBox(level, bx, by, bz) {
    const d = level.dims;
    return {
      lo: [bx * BRICK / d.x, by * BRICK / d.y, bz * BRICK / d.z],
      hi: [Math.min(1, (bx + 1) * BRICK / d.x), Math.min(1, (by + 1) * BRICK / d.y), Math.min(1, (bz + 1) * BRICK / d.z)]
    };
  }

  function boxCorners(lo, hi) {
    const out = [];
    for (let i = 0; i < 8; i++) out.push([i & 1 ? hi[0] : lo[0], i & 2 ? hi[1] : lo[1], i & 4 ? hi[2] : lo[2]]);
    return out;
  }

  /** m (16 numbers, column-major as THREE.Matrix4.elements) applied to (x, y, z, 1). */
  function apply(m, p) {
    return [
      m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
      m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
      m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
      m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15]
    ];
  }

  /**
   * Does the box meet the frustum? All eight corners outside the same plane of
   * −w ≤ x, y, z ≤ w is a certain miss; anything else is kept (conservative).
   */
  function meetsFrustum(texToClip, lo, hi) {
    const c = boxCorners(lo, hi).map((p) => apply(texToClip, p));
    for (let axis = 0; axis < 3; axis++) {
      if (c.every((q) => q[axis] < -q[3])) return false;
      if (c.every((q) => q[axis] > q[3])) return false;
    }
    return true;
  }

  function meetsClip(clip, lo, hi) {
    if (!clip) return true;
    for (let k = 0; k < 3; k++) if (hi[k] <= clip.min[k] || lo[k] >= clip.max[k]) return false;
    return true;
  }

  /**
   * @param {object} p
   * @param {Array}  p.levels      makeLevels(...)
   * @param {number} p.ceilingLod  finest level allowed (the user's quality)
   * @param {number} p.baseLod     coarsest level, always resident
   * @param {Float32Array|number[]} p.texToClip  projection · view · model · (texture → object), column-major
   * @param {Float32Array|number[]} p.texToView  view · model · (texture → object): its z is minus the depth
   * @param {{x,y,z}} p.volumeWorld  world size of the whole volume per axis
   * @param {number} p.fovY, p.viewportHeight  vertical field of view (rad) and drawing-buffer height (px)
   * @param {{min:number[],max:number[]}} [p.clip]  clip box in texture space
   * @param {number} [p.voxelsPerPixel=1.5]
   * @param {function([number,number,number]):(number|undefined)} [p.shownAt]  level currently shown at a texture point (hysteresis)
   * @returns {{ bricks: Array<{lod,bx,by,bz,depth,screen:number}>, stats: object }}
   */
  function plan(p) {
    const { levels, ceilingLod, baseLod } = p;
    const vpp = Number(p.voxelsPerPixel) > 0 ? Number(p.voxelsPerPixel) : DEFAULT_VOXELS_PER_PIXEL;
    const tanHalf = Math.tan(p.fovY / 2);
    const out = [];
    const stats = { visited: 0, culled: 0, byLod: {} };
    const base = levels[baseLod];

    const voxelWorld = (level) => Math.max(p.volumeWorld.x / level.dims.x, p.volumeWorld.y / level.dims.y);
    const fpAt = (depth) => (2 * Math.max(depth, 1e-4) * tanHalf) / p.viewportHeight;
    const enough = (level, depth, factor = 1) => voxelWorld(level) <= (fpAt(depth) / vpp) * factor;

    function centreDepth(lo, hi) {
      const c = apply(p.texToView, [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2]);
      return -c[2];
    }

    const seen = new Set();   // a finer brick straddling two parents is reached twice
    function visit(lod, bx, by, bz) {
      const sk = key(lod, bx, by, bz);
      if (seen.has(sk)) return;
      seen.add(sk);
      const level = levels[lod];
      const { lo, hi } = brickBox(level, bx, by, bz);
      stats.visited++;
      if (!meetsClip(p.clip, lo, hi) || !meetsFrustum(p.texToClip, lo, hi)) { stats.culled++; return; }
      const depth = centreDepth(lo, hi);
      // The coarsest enough level shows this brick. Hysteresis: where a finer level is
      // already shown and still enough, the coarser one must be clearly enough
      // (HYSTERESIS · threshold) to replace it.
      const cur = p.shownAt ? p.shownAt([(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2]) : undefined;
      const keepFiner = cur !== undefined && cur < lod && !enough(level, depth, p.hysteresis ?? HYSTERESIS);
      if (lod <= ceilingLod || (enough(level, depth) && !keepFiner)) {
        emit(level, lod, bx, by, bz, depth, lo, hi);
        return;
      }
      // Too coarse here: refine into the children of the next finer level.
      const finer = levels[lod - 1];
      if (!finer) { emit(level, lod, bx, by, bz, depth, lo, hi); return; }
      const x0 = Math.floor(lo[0] * finer.dims.x / BRICK), x1 = Math.ceil(hi[0] * finer.dims.x / BRICK) - 1;
      const y0 = Math.floor(lo[1] * finer.dims.y / BRICK), y1 = Math.ceil(hi[1] * finer.dims.y / BRICK) - 1;
      const z0 = Math.floor(lo[2] * finer.dims.z / BRICK), z1 = Math.ceil(hi[2] * finer.dims.z / BRICK) - 1;
      for (let z = z0; z <= Math.min(z1, finer.nz - 1); z++)
        for (let y = y0; y <= Math.min(y1, finer.ny - 1); y++)
          for (let x = x0; x <= Math.min(x1, finer.nx - 1); x++) visit(lod - 1, x, y, z);
    }

    function emit(level, lod, bx, by, bz, depth, lo, hi) {
      if (!level.has(bx, by, bz)) return;
      const c = apply(p.texToClip, [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2]);
      const w = Math.abs(c[3]) > 1e-9 ? c[3] : 1e-9;
      const screen = Math.hypot(c[0] / w, c[1] / w);
      out.push({ lod, bx, by, bz, depth, screen });
      stats.byLod[lod] = (stats.byLod[lod] || 0) + 1;
    }

    for (let bz = 0; bz < base.nz; bz++) for (let by = 0; by < base.ny; by++) for (let bx = 0; bx < base.nx; bx++) visit(baseLod, bx, by, bz);
    out.sort((a, b) => a.screen - b.screen);
    return { bricks: out, stats };
  }


  /**
   * Plans, loads and evicts against a slot budget. The caller supplies
   *   request(bricks): start loading these ({lod,bx,by,bz}, centre of the screen first) and
   *                    call arrived(brick) for each one uploaded (or failed(brick));
   *   evict(brick):    free the slot of a brick (and repoint the page table).
   */
  class Scheduler {
    constructor({ levels, baseLod, ceilingLod, maxSlots, request, evict, voxelsPerPixel }) {
      this.levels = levels;
      this.baseLod = baseLod;
      this.ceilingLod = ceilingLod;
      this.maxSlots = Math.max(1, maxSlots | 0);
      this.requestFn = request;
      this.evictFn = evict || (() => {});
      this.voxelsPerPixel = voxelsPerPixel;
      this.resident = new Map();      // key → { lod, bx, by, bz, last }
      this.pending = new Set();
      this.requestedKeys = new Map(); // key → times asked over the session
      this.tick = 0;
      this.counters = { requests: 0, duplicateWhileHeld: 0, rerequestsAfterEvict: 0, evictions: 0, deferred: 0 };
      this.lastNeeded = new Set();
    }

    _shownAt(pt) {
      for (let lod = 0; lod <= this.baseLod; lod++) {
        const L = this.levels[lod];
        const k = key(lod, Math.min(L.nx - 1, Math.floor(pt[0] * L.dims.x / BRICK)),
          Math.min(L.ny - 1, Math.floor(pt[1] * L.dims.y / BRICK)), Math.min(L.nz - 1, Math.floor(pt[2] * L.dims.z / BRICK)));
        if (this.resident.has(k)) return lod;
      }
      return undefined;
    }

    baseBricks() {
      const base = this.levels[this.baseLod];
      const out = [];
      for (let bz = 0; bz < base.nz; bz++) for (let by = 0; by < base.ny; by++) for (let bx = 0; bx < base.nx; bx++) {
        if (base.has(bx, by, bz)) out.push({ lod: this.baseLod, bx, by, bz, depth: 0, screen: 1e9 });
      }
      return out;
    }

    /** The base level, requested up front (it is the fallback that leaves no hole). */
    seedBase() {
      const list = this.baseBricks();
      for (const b of list) {
        const k = key(b.lod, b.bx, b.by, b.bz);
        this.requestedKeys.set(k, 1);
        this.counters.requests++;
        this.pending.add(k);
      }
      this.requestFn(list);
      return list;
    }

    /** One view update: returns what was asked and what was evicted. */
    update(view) {
      this.tick++;
      const { bricks } = plan({ ...view, levels: this.levels, baseLod: this.baseLod, ceilingLod: this.ceilingLod,
        voxelsPerPixel: this.voxelsPerPixel ?? view.voxelsPerPixel, shownAt: (pt) => this._shownAt(pt) });
      // The base level is the fallback that leaves no hole: wanted whatever the view says,
      // after what the screen needs.
      const needed = bricks.concat(this.baseBricks().filter((b) => !bricks.some((n) => n.lod === b.lod && n.bx === b.bx && n.by === b.by && n.bz === b.bz)));
      const neededKeys = new Set(needed.map((b) => key(b.lod, b.bx, b.by, b.bz)));
      this.lastNeeded = neededKeys;
      for (const b of needed) {
        const e = this.resident.get(key(b.lod, b.bx, b.by, b.bz));
        if (e) e.last = this.tick;
      }
      let missing = needed.filter((b) => {
        const k = key(b.lod, b.bx, b.by, b.bz);
        return !this.resident.has(k) && !this.pending.has(k);
      });
      const evicted = [];
      const room = () => this.maxSlots - this.resident.size - this.pending.size;
      if (missing.length > room()) {
        const protectedBoxes = missing.map((b) => brickBox(this.levels[b.lod], b.bx, b.by, b.bz));
        const candidates = [...this.resident.values()]
          .filter((e) => e.lod !== this.baseLod && !neededKeys.has(key(e.lod, e.bx, e.by, e.bz)))
          .filter((e) => {
            const box = brickBox(this.levels[e.lod], e.bx, e.by, e.bz);
            // still the only picture of a place a wanted brick has not reached yet
            return !protectedBoxes.some((q) => [0, 1, 2].every((k) => box.hi[k] > q.lo[k] && box.lo[k] < q.hi[k]));
          })
          .sort((a, b) => a.last - b.last);
        for (const e of candidates) {
          if (missing.length <= room()) break;
          this.resident.delete(key(e.lod, e.bx, e.by, e.bz));
          this.evictFn(e);
          this.counters.evictions++;
          evicted.push(e);
        }
      }
      if (missing.length > room()) {
        this.counters.deferred += missing.length - Math.max(0, room());
        missing = missing.slice(0, Math.max(0, room()));
      }
      for (const b of missing) {
        const k = key(b.lod, b.bx, b.by, b.bz);
        const before = this.requestedKeys.get(k) || 0;
        if (before) this.counters.rerequestsAfterEvict++;
        this.requestedKeys.set(k, before + 1);
        this.pending.add(k);
        this.counters.requests++;
      }
      if (missing.length) this.requestFn(missing);
      return { requested: missing, evicted, needed };
    }

    arrived(b) {
      const k = key(b.lod, b.bx, b.by, b.bz);
      this.pending.delete(k);
      this.resident.set(k, { lod: b.lod, bx: b.bx, by: b.by, bz: b.bz, last: this.tick });
    }

    failed(b) {
      this.pending.delete(key(b.lod, b.bx, b.by, b.bz));
    }

    /** Voxels held by the resident bricks (interior 64³ of each, at its own level). */
    residentVoxels() { return this.resident.size * BRICK ** 3; }

    stats() {
      const byLod = {};
      for (const e of this.resident.values()) byLod[e.lod] = (byLod[e.lod] || 0) + 1;
      return { resident: this.resident.size, pending: this.pending.size, byLod, ...this.counters };
    }
  }

  return { BRICK, HYSTERESIS, DEFAULT_VOXELS_PER_PIXEL, key, makeLevels, brickBox, plan, Scheduler };
})();

if (typeof self !== 'undefined' && typeof self.ViewResidency === 'undefined') {
  try { self.ViewResidency = ViewResidency; } catch (_) { /* frozen global */ }
}
