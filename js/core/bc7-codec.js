/* ============================================================
   IRIBHM Microscopy Platform — BC7 (BPTC) mode 6 block codec, prototype
   ============================================================
   One BC7 block is 4 × 4 texels × RGBA in 16 bytes: three or four channels of a
   fluorescence brick in 1 byte per voxel, where the RGTC atlas takes 1.5 (BC5 + BC4)
   or 2 (BC5 + BC5). Only mode 6 is produced: a single subset, endpoints of 7 bits plus
   one shared low bit each (8 bits effective), 4-bit indices, one line through RGBA
   space. A block whose channels vary independently (a green structure touching a red
   one) does not lie on one line; the prototype exists to measure how often that costs
   quality on real data (see the A5 section of the performance study).

   Layout (little-endian bit stream, bit 0 = LSB of byte 0):
     bits 0–6    mode: six zeros and a one (mode 6)
     then        R0 R1 G0 G1 B0 B1 A0 A1, 7 bits each, then P0, P1 (1 bit each)
     then        sixteen indices: texel 0 on 3 bits (its top bit is implied 0), the others on 4
   Palette: with endpoints e0, e1 (8 bits) and w = [0,4,9,13,17,21,26,30,34,38,43,47,51,55,60,64]
     colour_k = (e0·(64 − w_k) + e1·w_k + 32) >> 6.
   A zero block stays exactly zero: endpoints 0, 0.
   ============================================================ */
const BC7Codec = (() => {
  const WEIGHTS = [0, 4, 9, 13, 17, 21, 26, 30, 34, 38, 43, 47, 51, 55, 60, 64];

  function _palette(e0, e1) {
    const pal = new Array(16);
    for (let k = 0; k < 16; k++) {
      const w = WEIGHTS[k];
      pal[k] = [0, 1, 2, 3].map((c) => ((e0[c] * (64 - w) + e1[c] * w + 32) >> 6));
    }
    return pal;
  }

  /** Quantise an 8-bit endpoint to 7 bits + one shared p-bit: returns { q: [4], p, eff: [4] }. */
  function _quantEndpoint(v) {
    let best = null;
    for (let p = 0; p < 2; p++) {
      const q = v.map((x) => Math.max(0, Math.min(127, Math.round((x - p) / 2))));
      const eff = q.map((x) => (x << 1) | p);
      const err = v.reduce((s, x, c) => s + (x - eff[c]) ** 2, 0);
      if (!best || err < best.err) best = { q, p, eff, err };
    }
    return best;
  }

  function _assign(vals, pal) {
    const idx = new Array(16);
    let err = 0;
    for (let i = 0; i < 16; i++) {
      let bi = 0, be = Infinity;
      for (let k = 0; k < 16; k++) {
        const e = (vals[i][0] - pal[k][0]) ** 2 + (vals[i][1] - pal[k][1]) ** 2 + (vals[i][2] - pal[k][2]) ** 2 + (vals[i][3] - pal[k][3]) ** 2;
        if (e < be) { be = e; bi = k; }
      }
      idx[i] = bi;
      err += be;
    }
    return { idx, err };
  }

  /** Least-squares endpoints for the given indices (per channel, exact solve of the 2 × 2 system). */
  function _fit(vals, idx) {
    let a = 0, b = 0, d = 0;
    const r0 = [0, 0, 0, 0], r1 = [0, 0, 0, 0];
    for (let i = 0; i < 16; i++) {
      const w = WEIGHTS[idx[i]] / 64, u = 1 - w;
      a += u * u; b += u * w; d += w * w;
      for (let c = 0; c < 4; c++) { r0[c] += u * vals[i][c]; r1[c] += w * vals[i][c]; }
    }
    const det = a * d - b * b;
    if (Math.abs(det) < 1e-9) return null;
    const e0 = [0, 0, 0, 0], e1 = [0, 0, 0, 0];
    for (let c = 0; c < 4; c++) {
      e0[c] = Math.max(0, Math.min(255, (d * r0[c] - b * r1[c]) / det));
      e1[c] = Math.max(0, Math.min(255, (a * r1[c] - b * r0[c]) / det));
    }
    return [e0, e1];
  }

  /**
   * Encode 16 RGBA texels (`vals[i] = [r, g, b, a]`, texel i = 4·y + x) into `out` at `offset`.
   */
  function encodeBlock(vals, out, offset = 0) {
    let allZero = true;
    for (let i = 0; i < 16 && allZero; i++) if (vals[i][0] | vals[i][1] | vals[i][2] | vals[i][3]) allZero = false;
    let e0q, e1q, idx;
    if (allZero) {
      e0q = e1q = _quantEndpoint([0, 0, 0, 0]);
      idx = new Array(16).fill(0);
    } else {
      // Principal axis by power iteration on the covariance of the block.
      const mean = [0, 0, 0, 0];
      for (let i = 0; i < 16; i++) for (let c = 0; c < 4; c++) mean[c] += vals[i][c] / 16;
      let axis = [1, 1, 1, 1];
      for (let it = 0; it < 4; it++) {
        const nx = [0, 0, 0, 0];
        for (let i = 0; i < 16; i++) {
          const dx = [0, 1, 2, 3].map((c) => vals[i][c] - mean[c]);
          const dot = dx[0] * axis[0] + dx[1] * axis[1] + dx[2] * axis[2] + dx[3] * axis[3];
          for (let c = 0; c < 4; c++) nx[c] += dx[c] * dot;
        }
        const len = Math.hypot(...nx);
        if (len < 1e-9) break;
        axis = nx.map((x) => x / len);
      }
      // Endpoints: the extreme texels along the axis (the palette then holds both exactly).
      let lo = Infinity, hi = -Infinity, ilo = 0, ihi = 0;
      for (let i = 0; i < 16; i++) {
        const t = (vals[i][0] - mean[0]) * axis[0] + (vals[i][1] - mean[1]) * axis[1] + (vals[i][2] - mean[2]) * axis[2] + (vals[i][3] - mean[3]) * axis[3];
        if (t < lo) { lo = t; ilo = i; }
        if (t > hi) { hi = t; ihi = i; }
      }
      let best = null;
      let ends = [vals[ilo].slice(), vals[ihi].slice()];
      for (let round = 0; round < 4; round++) {
        const q0 = _quantEndpoint(ends[0]), q1 = _quantEndpoint(ends[1]);
        const as = _assign(vals, _palette(q0.eff, q1.eff));
        if (!best || as.err < best.err) best = { q0, q1, idx: as.idx, err: as.err };
        if (as.err === 0) break;
        const fit = _fit(vals, as.idx);
        if (!fit) break;
        ends = fit;
      }
      e0q = best.q0; e1q = best.q1; idx = best.idx;
    }
    // The anchor texel's index has its top bit implied 0: swap the endpoints when it is set.
    if (idx[0] >= 8) {
      [e0q, e1q] = [e1q, e0q];
      idx = idx.map((k) => 15 - k);
    }
    // Bit stream.
    const bytes = new Uint8Array(16);
    let pos = 0;
    const put = (value, bits) => { for (let b = 0; b < bits; b++, pos++) if ((value >> b) & 1) bytes[pos >> 3] |= 1 << (pos & 7); };
    put(0x40, 7);
    for (let c = 0; c < 4; c++) { put(e0q.q[c], 7); put(e1q.q[c], 7); }
    put(e0q.p, 1); put(e1q.p, 1);
    for (let i = 0; i < 16; i++) put(idx[i], i === 0 ? 3 : 4);
    out.set(bytes, offset);
  }

  /** Decode a block to 16 [r, g, b, a] byte texels, exactly what the hardware returns. */
  function decodeBlock(bytes, offset = 0) {
    let pos = 0;
    const get = (bits) => { let v = 0; for (let b = 0; b < bits; b++, pos++) v |= ((bytes[offset + (pos >> 3)] >> (pos & 7)) & 1) << b; return v; };
    if (get(7) !== 0x40) throw new Error('not a BC7 mode 6 block');
    const q0 = [0, 0, 0, 0], q1 = [0, 0, 0, 0];
    for (let c = 0; c < 4; c++) { q0[c] = get(7); q1[c] = get(7); }
    const p0 = get(1), p1 = get(1);
    const e0 = q0.map((q) => (q << 1) | p0), e1 = q1.map((q) => (q << 1) | p1);
    const pal = _palette(e0, e1);
    const out = new Array(16);
    for (let i = 0; i < 16; i++) out[i] = pal[get(i === 0 ? 3 : 4)];
    return out;
  }

  /**
   * Encode a box of `components`-byte voxels (x fastest) as BC7 blocks per z plane, like
   * BCCodec.encodeBox: blocks cover whole 4 × 4 tiles, edges replicated. Channels beyond
   * `components` are zero. → { bytes, width, height, depth } with 16 bytes per block.
   */
  function encodeBox(data, components, w, h, d) {
    const bw = (w + 3) >> 2, bh = (h + 3) >> 2;
    const bytes = new Uint8Array(d * bh * bw * 16);
    const vals = Array.from({ length: 16 }, () => [0, 0, 0, 0]);
    let o = 0;
    for (let z = 0; z < d; z++) {
      for (let by = 0; by < bh; by++) {
        for (let bx = 0; bx < bw; bx++) {
          for (let ty = 0; ty < 4; ty++) {
            const y = Math.min(h - 1, by * 4 + ty);
            for (let tx = 0; tx < 4; tx++) {
              const x = Math.min(w - 1, bx * 4 + tx);
              const src = ((z * h + y) * w + x) * components;
              const v = vals[ty * 4 + tx];
              for (let c = 0; c < 4; c++) v[c] = c < components ? data[src + c] : 0;
            }
          }
          encodeBlock(vals, bytes, o);
          o += 16;
        }
      }
    }
    return { bytes, width: bw * 4, height: bh * 4, depth: d };
  }

  function decodeBox(enc, components, w, h, d) {
    const out = new Float32Array(w * h * d * components);
    const bw = enc.width >> 2, bh = enc.height >> 2;
    let o = 0;
    for (let z = 0; z < d; z++) for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++, o += 16) {
      const block = decodeBlock(enc.bytes, o);
      for (let ty = 0; ty < 4; ty++) for (let tx = 0; tx < 4; tx++) {
        const x = bx * 4 + tx, y = by * 4 + ty;
        if (x >= w || y >= h) continue;
        for (let c = 0; c < components; c++) out[((z * h + y) * w + x) * components + c] = block[ty * 4 + tx][c];
      }
    }
    return out;
  }

  return { WEIGHTS, encodeBlock, decodeBlock, encodeBox, decodeBox };
})();

if (typeof self !== 'undefined' && typeof self.BC7Codec === 'undefined') {
  try { self.BC7Codec = BC7Codec; } catch (_) { /* frozen global */ }
}
