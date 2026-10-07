/* ============================================================
   IRIBHM Microscopy Platform — BC4 / BC5 block codec
   ============================================================
   The GPU-compressed display atlas (svr-manager.js, `compressed`) keeps the
   voxels of a timepoint in RGTC blocks the GPU samples directly
   (EXT_texture_compression_rgtc): BC4 = one channel, BC5 = two BC4 blocks
   (R then G). A block is 4 × 4 texels of ONE z plane in 8 bytes per channel,
   i.e. 4 bits per voxel and channel instead of 8: the atlas takes half the
   VRAM of an R8 / RG8 one, and its upload is a copy (the GPU decodes on
   every fetch, in hardware).

   Block layout (Khronos Data Format spec §21, RGTC): byte 0 = r0, byte 1 =
   r1, bytes 2…7 = sixteen 3-bit indices, texel i = 4·y + x at bits 3i of
   that little-endian 48-bit field. The palette p[k] of index k is
     r0 > r1  : p0 = r0, p1 = r1, p_k = ((8 − k)·r0 + (k − 1)·r1) / 7   k = 2…7
     r0 ≤ r1  : p0 = r0, p1 = r1, p_k = ((6 − k)·r0 + (k − 1)·r1) / 5   k = 2…5,
                p6 = 0, p7 = 255.
   Values are bytes / 255 on the GPU (UNORM); the interpolants are not rounded
   to a byte there, so they are kept as reals here too.

   Encoder (deterministic, no search):
     mode 8  r0 = max, r1 = min of the block: eight evenly spaced levels, each
             value to the nearest, |error| ≤ (max − min) / 14.
     mode 6  r0 = min, r1 = max of the values that are neither 0 nor 255, six
             evenly spaced levels plus EXACT 0 and 255: |error| ≤ (max − min) / 10
             over those values, none on the zeros. A fluorescence brick is mostly
             background-subtracted zeros beside signal; mode 6 keeps every zero
             a zero (the ray-marcher's empty-space look is unchanged) where
             mode 8 would spread the block's range over them.
     Each mode then refits its two endpoints once by least squares for the
     levels its values chose (value ≈ (1 − q/n)·lo + (q/n)·hi), kept only when
     the squared error drops. The mode with the smaller sum of squared errors
     is stored (mode 8 on a tie).
     A uniform block, and every block holding at most two distinct values of
     which one is 0 or 255, is exact; an all-zero block is eight zero bytes —
     what a freshly allocated texture already holds.

   Classic script, usable from a window and from a worker (importScripts). No DOM.
   ============================================================ */

const BCCodec = (() => {
  'use strict';

  const BLOCK_BYTES = 8;   // one BC4 block, one channel

  // Scratch for one block's sixteen values and level choices (the encoder is synchronous).
  const _vals = new Uint8Array(16);
  const _q = new Int8Array(16);
  const _q8 = new Int8Array(16);
  const _q6 = new Int8Array(16);
  const ZERO = -1;    // mode 6: the exact 0 (p6)
  const FULL = -2;    // mode 6: the exact 255 (p7)

  /**
   * Nearest level of every value for endpoints lo ≤ hi and `steps` intervals (7 for
   * mode 8, 5 for mode 6): level q ∈ 0…steps is lo + q·(hi − lo)/steps. In mode 6 a
   * value nearer the exact 0 or 255 than to every level takes that one instead.
   * Writes `q` and returns the sum of squared errors.
   */
  function _quantize(vals, lo, hi, steps, mode6, q) {
    const span = hi - lo;
    let err = 0;
    for (let i = 0; i < 16; i++) {
      const v = vals[i];
      let k = span > 0 ? Math.round((v - lo) * steps / span) : 0;
      if (k < 0) k = 0; else if (k > steps) k = steps;
      let d = v - (lo + k * span / steps);
      if (mode6) {
        if (v * v <= d * d) { k = ZERO; d = v; }
        else if ((255 - v) * (255 - v) <= d * d) { k = FULL; d = 255 - v; }
      }
      q[i] = k;
      err += d * d;
    }
    return err;
  }

  /**
   * Least-squares endpoints for the levels in `q`: value ≈ (1 − w)·lo + w·hi with
   * w = q/steps, over the values on a level (not the exact 0 / 255 of mode 6). Rounded
   * to bytes. → [lo, hi], or null when the system is singular (every value on one level).
   */
  function _fitEndpoints(vals, q, steps) {
    let aa = 0, ab = 0, bb = 0, av = 0, bv = 0;
    for (let i = 0; i < 16; i++) {
      if (q[i] < 0) continue;
      const w = q[i] / steps;
      const u = 1 - w;
      aa += u * u; ab += u * w; bb += w * w;
      av += u * vals[i]; bv += w * vals[i];
    }
    const det = aa * bb - ab * ab;
    if (!(Math.abs(det) > 1e-9)) return null;
    const lo = Math.round((av * bb - bv * ab) / det);
    const hi = Math.round((bv * aa - av * ab) / det);
    return [Math.max(0, Math.min(255, lo)), Math.max(0, Math.min(255, hi))];
  }

  /**
   * Endpoints and levels of one mode: start from the extremes, then one least-squares
   * refit of the endpoints for the levels chosen, kept only when it lowers the error.
   * `ok(lo, hi)` says whether the mode can store that pair (mode 8 needs hi > lo).
   * Writes `q`, returns { lo, hi, err }.
   */
  function _bestFit(vals, lo, hi, steps, mode6, q, ok) {
    let err = _quantize(vals, lo, hi, steps, mode6, q);
    if (err === 0) return { lo, hi, err };
    const fit = _fitEndpoints(vals, q, steps);
    if (fit && ok(fit[0], fit[1]) && (fit[0] !== lo || fit[1] !== hi)) {
      const err2 = _quantize(vals, fit[0], fit[1], steps, mode6, _q);
      if (err2 < err) {
        q.set(_q);
        return { lo: fit[0], hi: fit[1], err: err2 };
      }
    }
    return { lo, hi, err };
  }

  /**
   * Encode the 16 values of `vals` (texel i = 4·y + x) into the 8 bytes of `out` at `o`.
   * @returns {number} the block's sum of squared errors (in byte units²)
   */
  function encodeBlock(vals, out, o) {
    let lo = 255, hi = 0;
    let midLo = 255, midHi = 0, mids = 0;
    for (let i = 0; i < 16; i++) {
      const v = vals[i];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
      if (v !== 0 && v !== 255) {
        if (v < midLo) midLo = v;
        if (v > midHi) midHi = v;
        mids++;
      }
    }
    if (lo === hi) {
      // Uniform: r0 = r1 = v, every index 0 (r0 ≤ r1 layout, p0 = v). Exact.
      out[o] = lo; out[o + 1] = lo;
      for (let k = 2; k < 8; k++) out[o + k] = 0;
      return 0;
    }

    // Mode 8: r0 = hi, r1 = lo; level q = 7 is index 0, q = 0 index 1, q ∈ 1…6 index 8 − q.
    const m8 = _bestFit(vals, lo, hi, 7, false, _q8, (a, b) => b > a);
    // Mode 6: r0 = lo, r1 = hi of the values other than 0 and 255; level q = 0 is index
    // 0, q = 5 index 1, q ∈ 1…4 index q + 1; the exact 0 index 6, the exact 255 index 7.
    const m6 = _bestFit(vals, mids ? midLo : 0, mids ? midHi : 0, 5, true, _q6, (a, b) => b >= a);

    const six = m6.err < m8.err;
    const q = six ? _q6 : _q8;
    out[o] = six ? m6.lo : m8.hi;
    out[o + 1] = six ? m6.hi : m8.lo;
    // Sixteen 3-bit indices, little-endian: texels 0…7 in bytes 2…4, 8…15 in 5…7.
    let a = 0, b = 0;
    for (let i = 0; i < 16; i++) {
      const k = q[i];
      const index = six
        ? (k === ZERO ? 6 : k === FULL ? 7 : k === 0 ? 0 : k === 5 ? 1 : k + 1)
        : (k === 7 ? 0 : k === 0 ? 1 : 8 - k);
      if (i < 8) a |= index << (3 * i);
      else b |= index << (3 * (i - 8));
    }
    out[o + 2] = a & 0xff; out[o + 3] = (a >>> 8) & 0xff; out[o + 4] = (a >>> 16) & 0xff;
    out[o + 5] = b & 0xff; out[o + 6] = (b >>> 8) & 0xff; out[o + 7] = (b >>> 16) & 0xff;
    return six ? m6.err : m8.err;
  }

  /** The 16 values (reals, byte units) of the block at `o` of `src`, into `out`. */
  function decodeBlock(src, o, out) {
    const r0 = src[o], r1 = src[o + 1];
    const a = src[o + 2] | (src[o + 3] << 8) | (src[o + 4] << 16);
    const b = src[o + 5] | (src[o + 6] << 8) | (src[o + 7] << 16);
    for (let i = 0; i < 16; i++) {
      const k = i < 8 ? (a >>> (3 * i)) & 7 : (b >>> (3 * (i - 8))) & 7;
      let v;
      if (k === 0) v = r0;
      else if (k === 1) v = r1;
      else if (r0 > r1) v = ((8 - k) * r0 + (k - 1) * r1) / 7;
      else if (k <= 5) v = ((6 - k) * r0 + (k - 1) * r1) / 5;
      else v = k === 6 ? 0 : 255;
      out[i] = v;
    }
    return out;
  }

  /**
   * The planes of a display atlas of `channels` channels: one BC5 texture per pair
   * of channels, a BC4 one for a channel left alone.
   *   1 → [bc4 (c0)]   2 → [bc5 (c0, c1)]   3 → [bc5 (c0, c1), bc4 (c2)]
   *   4 → [bc5 (c0, c1), bc5 (c2, c3)]
   * texelBytes: bytes per texel of the plane (0.5 per channel).
   */
  function planesFor(channels) {
    const n = Math.max(1, Math.min(4, Math.round(Number(channels) || 1)));
    const planes = [];
    for (let c = 0; c < n; c += 2) {
      const chans = c + 1 < n ? [c, c + 1] : [c];
      planes.push({ format: chans.length === 2 ? 'bc5' : 'bc4', channels: chans, texelBytes: chans.length * 0.5 });
    }
    return planes;
  }

  /** Bytes per texel of all the planes of `channels` channels together. */
  function texelBytesFor(channels) {
    return planesFor(channels).reduce((s, p) => s + p.texelBytes, 0);
  }

  /**
   * Encode a box of voxels into the planes of `channels` channels.
   *   data        the box, `components` bytes per voxel interleaved (channel c in byte
   *               c), z-major then y then x: voxel (x, y, z) at ((z·h + y)·w + x)·components
   *   w, h, d     the box's extent
   * Each z plane is cut in 4 × 4 blocks; a box whose w or h is not a multiple of 4 is
   * padded by repeating its last column / row (clamp to edge: the padding never
   * widens a block's range, and the atlas never samples it).
   * → { planes: [{ format, channels, bytes: Uint8Array }], width, height, depth } with
   *   width = 4·⌈w/4⌉, height = 4·⌈h/4⌉, depth = d: the box a compressedTexSubImage3D
   *   of each plane covers. A plane's bytes are its z planes in order, each one its
   *   block rows top to bottom, each row its blocks left to right, a BC5 block the
   *   BC4 block of its first channel followed by that of its second.
   */
  function encodeBox(data, components, w, h, d, channels) {
    const comps = Math.max(1, Math.round(Number(components) || 1));
    if (!(w > 0 && h > 0 && d > 0)) throw new Error('BCCodec.encodeBox: empty box');
    if (!data || data.length < w * h * d * comps) {
      throw new Error(`BCCodec.encodeBox: ${data ? data.length : 0} bytes for a ${w}×${h}×${d}×${comps} box`);
    }
    const bw = (w + 3) >> 2;
    const bh = (h + 3) >> 2;
    const planeSpecs = planesFor(Math.min(channels || comps, comps === 4 ? 4 : comps));
    const out = [];
    for (const spec of planeSpecs) {
      const nch = spec.channels.length;
      const bytes = new Uint8Array(d * bh * bw * BLOCK_BYTES * nch);
      let o = 0;
      for (let z = 0; z < d; z++) {
        const zOff = z * h;
        for (let by = 0; by < bh; by++) {
          for (let bx = 0; bx < bw; bx++) {
            for (let k = 0; k < nch; k++) {
              const c = spec.channels[k];
              for (let ty = 0; ty < 4; ty++) {
                const y = Math.min(h - 1, by * 4 + ty);
                const row = (zOff + y) * w;
                for (let tx = 0; tx < 4; tx++) {
                  const x = Math.min(w - 1, bx * 4 + tx);
                  _vals[ty * 4 + tx] = data[(row + x) * comps + c];
                }
              }
              encodeBlock(_vals, bytes, o);
              o += BLOCK_BYTES;
            }
          }
        }
      }
      out.push({ format: spec.format, channels: spec.channels.slice(), bytes });
    }
    return { planes: out, width: bw * 4, height: bh * 4, depth: d };
  }

  /**
   * The voxel values (reals) a GPU reads back from an encoded box: a Float32Array of
   * w·h·d·components, the box's own extent (the padding dropped), channels a plane
   * does not carry left at 0. For tests and for error measurements.
   */
  function decodeBox(encoded, components, w, h, d) {
    const comps = Math.max(1, Math.round(Number(components) || 1));
    const out = new Float32Array(w * h * d * comps);
    const bw = encoded.width >> 2;
    const bh = encoded.height >> 2;
    const block = new Float32Array(16);
    for (const plane of encoded.planes) {
      const nch = plane.channels.length;
      let o = 0;
      for (let z = 0; z < d; z++) {
        for (let by = 0; by < bh; by++) {
          for (let bx = 0; bx < bw; bx++) {
            for (let k = 0; k < nch; k++) {
              decodeBlock(plane.bytes, o, block);
              o += BLOCK_BYTES;
              const c = plane.channels[k];
              if (c >= comps) continue;
              for (let ty = 0; ty < 4; ty++) {
                const y = by * 4 + ty;
                if (y >= h) continue;
                for (let tx = 0; tx < 4; tx++) {
                  const x = bx * 4 + tx;
                  if (x >= w) continue;
                  out[((z * h + y) * w + x) * comps + c] = block[ty * 4 + tx];
                }
              }
            }
          }
        }
      }
    }
    return out;
  }

  return { BLOCK_BYTES, encodeBlock, decodeBlock, planesFor, texelBytesFor, encodeBox, decodeBox };
})();

if (typeof self !== 'undefined' && typeof self.BCCodec === 'undefined') {
  try { self.BCCodec = BCCodec; } catch (_) { /* frozen global */ }
}
