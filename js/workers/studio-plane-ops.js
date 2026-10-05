/* ============================================================
   Lumen3D — Studio native plane: geometry and voxel bookkeeping
   ============================================================
   Pure arithmetic shared by the page (viewer.js) and the Studio plane worker
   (studio-plane-worker.js): no DOM, no three.js, plain {x, y, z} vectors.

   The Studio's native picture of an AXIS-ALIGNED plane (an inspector XY / XZ /
   YZ cut, every z-stack figure of an unwarped volume) does not need a 3D atlas:
   the slice shader reads, for every pixel, voxel floor(clamp(uvw·dim, 0, dim−1))
   with uvw = base + ½ and base = origin + a·right + b·up (+ t·step along a slab),
   and along an axis-aligned normal e_k the k-coordinate of uvw does not depend on
   the pixel. So the voxels the plane reads along k are a handful of indices known
   up front (sampleLayers), and the native picture only needs those voxel planes —
   or, for a MIP slab, their per-channel maximum — as a 2D array texture
   (VolumeSlicer.createPlaneVolume). Everything else about the picture (frame,
   in-plane mapping, crop window, presence, fallback, raw output) stays the GPU's,
   through the same shader as the atlas path.

   A sample whose k-coordinate lies within VOXEL_EPS voxel of a voxel boundary may
   be floored to either side by the GPU's float32 arithmetic: a single plane then
   keeps both candidate planes (the shader picks the one it computes), a slab is
   left to the atlas path (a MIP over the wrong voxel would not be the same picture).
   ============================================================ */

const StudioPlaneOps = (() => {
  const AXES = ['x', 'y', 'z'];
  // The two in-plane axes (texture u, v) of a plane whose normal is the key.
  const PLANE_AXES = { x: ['y', 'z'], y: ['x', 'z'], z: ['x', 'y'] };
  // float32 keeps 24 bits: a texture coordinate near 1 is exact to ~6e-8, i.e. about
  // 3e-4 voxel on the longest axis of a 5735-voxel volume. 4e-3 voxel is far above
  // that and below anything a plane position is chosen at.
  const VOXEL_EPS = 4e-3;

  const vec = (p) => ({ x: Number(p?.x) || 0, y: Number(p?.y) || 0, z: Number(p?.z) || 0 });

  /** The geometry of VolumeSlicer.planeGeometry as plain numbers (worker-transferable). */
  function plainGeometry(g) {
    if (!g) return null;
    return {
      origin: vec(g.origin), center: vec(g.center), right: vec(g.right), up: vec(g.up),
      step: vec(g.step), normal: vec(g.normal),
      steps: Math.max(1, Math.round(Number(g.steps) || 1)),
      delta: Number(g.delta) || 0,
      projMode: Number(g.projMode) || 0,
      projected: Boolean(g.projected),
      halfThickness: Number(g.halfThickness) || 0,
      extent: Number(g.extent) || 0.75,
      warped: Boolean(g.warped)
    };
  }

  /** 'x' | 'y' | 'z' when the texture-space normal is that axis (either sign), else null. */
  function axisOf(normal, tol = 1e-9) {
    const n = vec(normal);
    for (const k of AXES) {
      if (Math.abs(Math.abs(n[k]) - 1) > tol) continue;
      if (AXES.every(o => o === k || Math.abs(n[o]) <= tol)) return k;
    }
    return null;
  }

  /**
   * The voxel indices along axis k the shader reads for the plane `g` (a plain
   * geometry, unwarped). One plane: uvw_k = center_k. A slab: the N samples
   *   uvw_k,i = center_k + (−H + i·δ)·step_k,  H = (N − 1)·δ / 2,
   * the ones inside [0, 1] (the shader's inBox, on the k-coordinate; the in-plane
   * test is the same for every sample of a pixel). Voxel = floor(clamp(uvw·dim,
   * 0, dim − 1)).
   * → { exact, layers: sorted unique voxel indices, reduced: g.projected, hits }
   *   exact false: a slab sample too close to a voxel boundary or to the box face to
   *   know which voxel (or whether any) the GPU reads.
   */
  function sampleLayers(g, dims, k) {
    const dim = Math.max(1, Math.floor(Number(dims?.[k]) || 1));
    const positions = [];
    if (!g.projected) positions.push(g.center[k]);
    else {
      const H = (g.steps - 1) * g.delta * 0.5;
      for (let i = 0; i < g.steps; i++) positions.push(g.center[k] + (-H + i * g.delta) * g.step[k]);
    }
    const layers = new Set();
    let hits = 0;
    for (const u of positions) {
      const t = u * dim;
      if (!Number.isFinite(t)) return { exact: false, layers: [], reduced: g.projected, hits: 0 };
      // The box faces: inside means 0 ≤ uvw ≤ 1, i.e. 0 ≤ t ≤ dim.
      const nearFace = Math.abs(t) < VOXEL_EPS || Math.abs(t - dim) < VOXEL_EPS;
      if (nearFace && g.projected) return { exact: false, layers: [], reduced: true, hits: 0 };
      if (!nearFace && (t < 0 || t > dim)) continue;
      hits++;
      // The voxel of t ± the float32 uncertainty, each clamped as the shader clamps.
      const lo = Math.floor(Math.min(Math.max(t - VOXEL_EPS, 0), dim - 1));
      const hi = Math.floor(Math.min(Math.max(t + VOXEL_EPS, 0), dim - 1));
      if (lo !== hi && g.projected) return { exact: false, layers: [], reduced: true, hits: 0 };
      for (let v = lo; v <= hi; v++) layers.add(v);
    }
    return { exact: true, layers: [...layers].sort((a, b) => a - b), reduced: g.projected, hits };
  }

  /**
   * The bricks an axis-aligned native picture needs, without a 3D atlas.
   * `active` lists the non-empty bricks of the level ({bx, by, bz}); an empty one
   * (dropped by the packer's ESS) is zero voxels, never fetched — the atlas path points
   * it at a slot of zeros (SVRManager.pointEmptyBricks), the plane path marks its
   * column present over the zero-initialised texture (viewer.js _planeNativeBackend).
   * → null when the plane path cannot reproduce the atlas picture exactly (oblique,
   *   an average slab — a float sum in sample order —, a slab sample on a voxel
   *   boundary), else
   *   { axis, uAxis, vAxis, reduced, layerBase, layers (count), voxels (the indices),
   *     size: {w, h} texture texels, bs, columns: Map key → {bu, bv, need, layer?},
   *     bricks: [{ bx, by, bz, region, column, layerOffsets?: [{layer, offset}],
   *     keep?: [offsets] }], empty }
   * One plane: layer i is voxel layerBase + i (one or two adjacent indices), each read
   * from the brick holding it; a column (u, v) of bricks is present per layer. A MIP
   * slab: one layer, the per-channel maximum over every voxel the samples read, built
   * from the non-empty bricks of the column (`need` of them); a column with none is
   * left out (all zeros).
   */
  function planePlan(g, dims, active, bs = 64) {
    if (!g || g.warped) return null;
    const k = axisOf(g.normal);
    if (!k) return null;
    if (g.projected && g.projMode !== 1) return null;
    const s = sampleLayers(g, dims, k);
    if (!s.exact) return null;
    const [U, V] = PLANE_AXES[k];
    const plan = {
      axis: k, uAxis: U, vAxis: V, reduced: s.reduced, bs,
      voxels: s.layers,
      layerBase: s.reduced ? 0 : (s.layers[0] || 0),
      layers: s.reduced ? 1 : Math.max(1, s.layers.length),
      size: { w: Math.max(1, Math.floor(dims[U])), h: Math.max(1, Math.floor(dims[V])) },
      columns: new Map(),
      bricks: [],
      empty: !s.layers.length
    };
    if (plan.empty) return plan;
    if (!s.reduced && s.layers.length > 1 && s.layers[s.layers.length - 1] - s.layers[0] !== s.layers.length - 1) return null;

    const key3 = (u, v, w) => `${u}_${v}_${w}`;
    const activeSet = new Set();
    const columns = new Map();
    for (const b of active || []) {
      const c = { x: b.bx, y: b.by, z: b.bz };
      activeSet.add(key3(c[U], c[V], c[k]));
      const ck = `${c[U]}_${c[V]}`;
      if (!columns.has(ck)) columns.set(ck, { bu: c[U], bv: c[V] });
    }
    const brickOf = (bu, bv, bk) => {
      const c = {};
      c[U] = bu; c[V] = bv; c[k] = bk;
      return { bx: c.x, by: c.y, bz: c.z };
    };
    const regionFor = (lo, hi) => {
      const r = { x0: 0, x1: bs, y0: 0, y1: bs, z0: 0, z1: bs };
      r[k + '0'] = lo;
      r[k + '1'] = hi + 1;
      return r;
    };
    // Voxels by brick index along k.
    const byLayerBrick = new Map();
    s.layers.forEach((v, i) => {
      const bk = Math.floor(v / bs);
      if (!byLayerBrick.has(bk)) byLayerBrick.set(bk, []);
      byLayerBrick.get(bk).push({ voxel: v, layer: i });
    });

    for (const [ck, col] of columns) {
      if (s.reduced) {
        // An empty brick of the column holds zero voxels: the maximum is the other bricks'.
        const needed = [...byLayerBrick.keys()].filter(bk => activeSet.has(key3(col.bu, col.bv, bk)));
        if (!needed.length) continue;
        plan.columns.set(ck, { bu: col.bu, bv: col.bv, need: needed.length });
        for (const bk of needed) {
          const vox = byLayerBrick.get(bk).map(e => e.voxel - bk * bs);
          const lo = Math.min(...vox);
          const hi = Math.max(...vox);
          plan.bricks.push({ ...brickOf(col.bu, col.bv, bk), region: regionFor(lo, hi), column: ck, keep: vox.map(o => o - lo) });
        }
      } else {
        let any = false;
        for (const [bk, list] of byLayerBrick) {
          if (!activeSet.has(key3(col.bu, col.bv, bk))) continue;
          const offs = list.map(e => e.voxel - bk * bs);
          const lo = Math.min(...offs);
          const hi = Math.max(...offs);
          plan.bricks.push({
            ...brickOf(col.bu, col.bv, bk), region: regionFor(lo, hi), column: ck,
            layerOffsets: list.map(e => ({ layer: e.layer, offset: e.voxel - bk * bs - lo }))
          });
          any = true;
        }
        if (any) plan.columns.set(ck, { bu: col.bu, bv: col.bv, need: 0 });
      }
    }
    return plan;
  }

  /** {x0..z1} of a delivered box; null = a whole bs³ brick. */
  function boxOf(region, bs = 64) {
    return region ? { x0: region.x0, x1: region.x1, y0: region.y0, y1: region.y1, z0: region.z0, z1: region.z1 }
      : { x0: 0, x1: bs, y0: 0, y1: bs, z0: 0, z1: bs };
  }

  /**
   * The texels a delivered box covers in the plane texture: origin (u0, v0) and size,
   * for a brick (bx, by, bz) of `bs` voxels and a plane of normal axis k.
   */
  function tilePlacement(brick, box, k, bs = 64) {
    const [U, V] = PLANE_AXES[k];
    const o = { x: brick.bx * bs, y: brick.by * bs, z: brick.bz * bs };
    return {
      u0: o[U] + box[U + '0'], v0: o[V] + box[V + '0'],
      w: box[U + '1'] - box[U + '0'], h: box[V + '1'] - box[V + '0']
    };
  }

  /**
   * One voxel plane (index `off` along k inside the box) of an RGBA box laid out
   * z-major (((z·h + y)·w + x)·4), as a (u, v) tile of the plane texture: rows of u
   * for each v — u = x, v = y for k = z; u = x, v = z for k = y; u = y, v = z for k = x.
   */
  function extractLayer(data, box, k, off) {
    const rw = box.x1 - box.x0;
    const rh = box.y1 - box.y0;
    const rd = box.z1 - box.z0;
    if (!data || data.length < rw * rh * rd * 4) throw new Error('box data shorter than its region');
    if (k === 'z') {
      const plane = rw * rh * 4;
      return { data: data.slice(off * plane, (off + 1) * plane), w: rw, h: rh };
    }
    if (k === 'y') {
      const out = new Uint8Array(rw * rd * 4);
      const row = rw * 4;
      for (let z = 0; z < rd; z++) {
        const src = ((z * rh + off) * rw) * 4;
        out.set(data.subarray(src, src + row), z * row);
      }
      return { data: out, w: rw, h: rd };
    }
    const out = new Uint8Array(rh * rd * 4);
    for (let z = 0; z < rd; z++) {
      for (let y = 0; y < rh; y++) {
        const src = ((z * rh + y) * rw + off) * 4;
        const dst = (z * rh + y) * 4;
        out[dst] = data[src]; out[dst + 1] = data[src + 1]; out[dst + 2] = data[src + 2]; out[dst + 3] = data[src + 3];
      }
    }
    return { data: out, w: rh, h: rd };
  }

  /**
   * The per-channel maximum, over the voxel planes `keep` (offsets along k inside the
   * box), of an RGBA box — the MIP the slab shader takes over those voxels, as a tile
   * of the plane texture (same (u, v) layout as extractLayer). Into `out` when given
   * (its previous contents are max-ed in: a column built from several bricks).
   */
  function reduceMax(data, box, k, keep, out = null) {
    const rw = box.x1 - box.x0;
    const rh = box.y1 - box.y0;
    const rd = box.z1 - box.z0;
    if (!data || data.length < rw * rh * rd * 4) throw new Error('box data shorter than its region');
    const w = k === 'x' ? rh : rw;
    const h = k === 'z' ? rh : rd;
    const dst = out && out.length === w * h * 4 ? out : new Uint8Array(w * h * 4);
    const list = Array.isArray(keep) || ArrayBuffer.isView(keep) ? Array.from(keep) : [];
    for (const off of list) {
      if (k === 'z') {
        const base = off * rw * rh * 4;
        for (let i = 0, n = rw * rh * 4; i < n; i++) {
          const v = data[base + i];
          if (v > dst[i]) dst[i] = v;
        }
      } else if (k === 'y') {
        for (let z = 0; z < rd; z++) {
          const src = ((z * rh + off) * rw) * 4;
          const d0 = z * rw * 4;
          for (let i = 0, n = rw * 4; i < n; i++) {
            const v = data[src + i];
            if (v > dst[d0 + i]) dst[d0 + i] = v;
          }
        }
      } else {
        for (let z = 0; z < rd; z++) {
          for (let y = 0; y < rh; y++) {
            const src = ((z * rh + y) * rw + off) * 4;
            const d = (z * rh + y) * 4;
            for (let c = 0; c < 4; c++) if (data[src + c] > dst[d + c]) dst[d + c] = data[src + c];
          }
        }
      }
    }
    return { data: dst, w, h };
  }

  // ── Frame geometry ─────────────────────────────────────────────────────────
  const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
  const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
  const scale = (a, s) => ({ x: a.x * s, y: a.y * s, z: a.z * s });

  /** Column-major 4×4 affine (16 numbers) → { L (row-major 3×3), t }, or null. */
  function _affine(warp) {
    if (!warp || warp.length !== 16) return null;
    const e = Array.from(warp, Number);
    if (!e.every(Number.isFinite)) return null;
    return { L: [e[0], e[4], e[8], e[1], e[5], e[9], e[2], e[6], e[10]], t: { x: e[12], y: e[13], z: e[14] } };
  }
  const _mul3 = (m, v) => ({ x: m[0] * v.x + m[1] * v.y + m[2] * v.z, y: m[3] * v.x + m[4] * v.y + m[5] * v.z, z: m[6] * v.x + m[7] * v.y + m[8] * v.z });
  function _inv3(m) {
    const [a, b, c, d, e, f, g, h, i] = m;
    const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
    const det = a * A + b * B + c * C;
    if (!(Math.abs(det) > 1e-300)) return null;
    const r = 1 / det;
    return [A * r, -(b * i - c * h) * r, (b * f - c * e) * r,
      B * r, (a * i - c * g) * r, -(a * f - c * d) * r,
      C * r, -(a * h - b * g) * r, (a * e - b * d) * r];
  }

  /** The texture coordinate of cube point p: p + ½, or W·p on a warped volume. */
  function _texOf(p, aff) {
    if (!aff) return { x: p.x + 0.5, y: p.y + 0.5, z: p.z + 0.5 };
    return add(_mul3(aff.L, p), aff.t);
  }

  /**
   * The pixel box of a plane's footprint on the volume in a renderRes frame — the
   * crop the Studio frames, computed from the geometry instead of read back from a
   * full-frame render. The footprint is the set of frame points base = origin +
   * a·right + b·up with a sample base + t·step (|t| ≤ H, H = 0 for one plane) inside
   * the texture box [0, 1]³; in (a, b, t) coordinates the box is a parallelepiped
   * (cube space is affine to texture space), so the footprint is the projection on
   * (a, b) of its intersection with the slab |t| ≤ H, a convex polygon whose vertices
   * are the box corners inside the slab and the crossings of the box edges with the
   * planes t = ±H. Frame pixel (px, py), y down, has its centre at
   *   a = ((px + ½)/R − ½)·2E,   b = (½ − (py + ½)/R)·2E.
   * → { x, y, x2, y2, renderRes } (inclusive pixel bounds, `pad` px of margin, inside
   *   the frame), or null when the plane misses the volume.
   */
  function cropRect(g, renderRes, warp = null, pad = 10) {
    const R = Math.max(1, Math.round(Number(renderRes) || 0));
    if (!g || !(R > 0)) return null;
    const aff = _affine(warp);
    let corners;
    if (aff) {
      const Li = _inv3(aff.L);
      if (!Li) return null;
      corners = [];
      for (let i = 0; i < 8; i++) {
        const tex = { x: i & 1 ? 1 : 0, y: i & 2 ? 1 : 0, z: i & 4 ? 1 : 0 };
        corners.push(_mul3(Li, sub(tex, aff.t)));
      }
    } else {
      corners = [];
      for (let i = 0; i < 8; i++) corners.push({ x: i & 1 ? 0.5 : -0.5, y: i & 2 ? 0.5 : -0.5, z: i & 4 ? 0.5 : -0.5 });
    }
    // (a, b, t) of a cube point: solve [right up step]·(a, b, t) = p − origin.
    const M = [g.right.x, g.up.x, g.step.x, g.right.y, g.up.y, g.step.y, g.right.z, g.up.z, g.step.z];
    const Mi = _inv3(M);
    if (!Mi) return null;
    const abt = corners.map(c => _mul3(Mi, sub(c, g.origin)));
    const H = g.projected ? (g.steps - 1) * g.delta * 0.5 : 0;
    const pts = [];
    abt.forEach(p => { if (Math.abs(p.z) <= H + 1e-12) pts.push(p); });
    for (let i = 0; i < 8; i++) {
      for (const bit of [1, 2, 4]) {
        const j = i | bit;
        if (j === i) continue;
        const p = abt[i];
        const q = abt[j];
        for (const level of H > 0 ? [-H, H] : [0]) {
          const dz = q.z - p.z;
          if (Math.abs(dz) < 1e-15) continue;
          const s = (level - p.z) / dz;
          if (s >= 0 && s <= 1) pts.push(add(p, scale(sub(q, p), s)));
        }
      }
    }
    if (!pts.length) return null;
    const E = g.extent > 0 ? g.extent : 0.75;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of pts) {
      const px = (p.x / (2 * E) + 0.5) * R - 0.5;
      const py = (0.5 - p.y / (2 * E)) * R - 0.5;
      minX = Math.min(minX, px); maxX = Math.max(maxX, px);
      minY = Math.min(minY, py); maxY = Math.max(maxY, py);
    }
    const x = Math.max(0, Math.floor(minX) - pad);
    const y = Math.max(0, Math.floor(minY) - pad);
    const x2 = Math.min(R - 1, Math.ceil(maxX) + pad);
    const y2 = Math.min(R - 1, Math.ceil(maxY) + pad);
    if (x > x2 || y > y2) return null;
    return { x, y, x2, y2, renderRes: R };
  }

  /**
   * The footprint of a projected slab over the frame window `win` ({x, y, w, h},
   * frame pixels, y down): 255 where at least one of the slab's samples
   *   t_i = −H + i·δ,  i = 0 … N − 1
   * of the pixel lies inside the texture box, 0 elsewhere — the pixels the slicer's
   * colour path writes (hits > 0) and its raw path leaves (0,0,0,0). Along the pixel's
   * line base + t·step the box is the interval [t_lo, t_hi] (slab method, per axis),
   * so the test is ⌈(t_lo + H)/δ⌉ ≤ ⌊(t_hi + H)/δ⌋ within [0, N − 1]. → Uint8Array(w·h),
   * rows top-down.
   */
  function coverageMask(g, renderRes, win, warp = null) {
    const R = Math.max(1, Math.round(Number(renderRes) || 0));
    const w = Math.max(0, Math.floor(win?.w || 0));
    const h = Math.max(0, Math.floor(win?.h || 0));
    const out = new Uint8Array(w * h);
    if (!g || !w || !h) return out;
    const aff = _affine(warp);
    const E = g.extent > 0 ? g.extent : 0.75;
    const N = Math.max(1, g.steps | 0);
    const H = (N - 1) * g.delta * 0.5;
    const d = g.delta > 0 ? g.delta : 1;
    const texDir = aff ? _mul3(aff.L, g.step) : g.step;
    const texR = aff ? _mul3(aff.L, g.right) : g.right;
    const da = (2 * E) / R;
    for (let j = 0; j < h; j++) {
      const b = (0.5 - (win.y + j + 0.5) / R) * 2 * E;
      const a0 = ((win.x + 0.5) / R - 0.5) * 2 * E;
      // texture coordinate of base at the row's first pixel, and its step per pixel
      let t0 = _texOf(add(add(g.origin, scale(g.right, a0)), scale(g.up, b)), aff);
      const row = j * w;
      for (let i = 0; i < w; i++) {
        let lo = -Infinity;
        let hi = Infinity;
        for (const k of AXES) {
          const p = t0[k];
          const s = texDir[k];
          if (Math.abs(s) < 1e-15) {
            if (p < 0 || p > 1) { lo = 1; hi = 0; break; }
            continue;
          }
          let ta = (0 - p) / s;
          let tb = (1 - p) / s;
          if (ta > tb) { const tmp = ta; ta = tb; tb = tmp; }
          if (ta > lo) lo = ta;
          if (tb < hi) hi = tb;
        }
        if (lo <= hi) {
          const iLo = Math.max(0, Math.ceil((lo + H) / d - 1e-9));
          const iHi = Math.min(N - 1, Math.floor((hi + H) / d + 1e-9));
          if (iLo <= iHi) out[row + i] = 255;
        }
        t0 = { x: t0.x + texR.x * da, y: t0.y + texR.y * da, z: t0.z + texR.z * da };
      }
    }
    return out;
  }

  return {
    VOXEL_EPS,
    PLANE_AXES,
    plainGeometry,
    axisOf,
    sampleLayers,
    planePlan,
    boxOf,
    tilePlacement,
    extractLayer,
    reduceMax,
    cropRect,
    coverageMask
  };
})();

if (typeof window !== 'undefined') window.StudioPlaneOps = StudioPlaneOps;
