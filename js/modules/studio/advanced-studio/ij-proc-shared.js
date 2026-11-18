/* ij-proc-shared.js — primitives shared by the processing packages of the Advanced Studio.
 *
 * Classic script, page and worker, loaded after ij-core.js / ij-analysis.js and before every
 * ij-proc-<pkg>.js (PLAN-wave2 §2.4). W0-owned: a package never edits this file; it reports what
 * it misses. Attaches `IJShared` to `self`.
 *
 *   IJShared.makeFloatEDM(mask8, w, h, opts) → Float32Array   exact Euclidean distance map
 *   IJShared.makeFloatEDMAsync(mask8, w, h, opts) → Promise   same, awaiting opts.check()/opts.tick(fraction) about every 2^19 pixels
 *   IJShared.maskToRoi(mask8, w, h) → ROI | null              ThresholdToSelection-compatible
 *   IJShared.thresholdMask(ch, lower, upper) → Uint8Array     255 inside [lower, upper], else 0
 *   IJShared.lightBackgroundInvert(light, invertedLut) → bool the "light background" convention
 *   IJShared.hasInvertedLut(display) → bool
 *
 * Reference: ImageJ 1.54f (public domain).
 */
(function (root) {
  'use strict';
  const fround = Math.fround, msqrt = Math.sqrt; // locals: a global lookup is slow in a sandboxed realm

  function fail(code, message) {
    const e = new Error(message || code);
    e.code = code;
    return e;
  }

  /* ij.plugin.filter.EDM.makeFloatEDM(ImageProcessor ip, int backgroundValue, boolean edgesAreBackground),
   * ported line by line. The two-pass exact algorithm: for every pixel the nearest background point
   * found so far is remembered per column (`points`), a line is processed left to right and right to
   * left, then the whole image bottom to top, each pixel taking the closest of its own column's
   * candidate, the diagonal one and the previous one in the sweep. A point is packed as
   * `x | y << 16` in a Java int; -1 means "none".
   *
   * This port is written from the documented algorithm; the golden fixtures recorded from a real
   * ImageJ 1.54f (PLAN-wave2 §6, tests/fixtures/ij-wave2/seg) validate it bit for bit.
   *
   *   mask8   Uint8Array w·h; a pixel is background when it equals opts.backgroundValue (default 0:
   *           white-on-black masks, Prefs.blackBackground = true and a normal LUT), foreground otherwise
   *   opts.edgesAreBackground  false (default): the image edge is not a background (scipy's
   *           distance_transform_edt convention); true: pixels outside count as background
   *   returns the distance in pixels (the square root is taken at the end, as FloatProcessor.sqrt()).
   *   An image without any background pixel keeps ImageJ's value sqrt(2^31) ≈ 46341.
   *
   * Cooperative: the work is one generator (`edmSteps`) that yields its progress (0..1) about every 2^19 pixels.
   * `makeFloatEDM` (synchronous, the historical signature) runs it to the end; `makeFloatEDMAsync` awaits
   * `opts.tick(fraction)` (and `opts.check()`) at every yield, so a caller inside the engine can report progress
   * and be cancelled (an exception thrown by either aborts the transform). Both run the same code. */
  const EDM_YIELD_PIXELS = 1 << 19;
  function* edmSteps(mask8, w, h, opts) {
    const o = opts || {};
    const backgroundValue = o.backgroundValue === undefined ? 0 : o.backgroundValue;
    const edgesAreBackground = !!o.edgesAreBackground;
    if (!(Number.isInteger(w) && Number.isInteger(h) && w > 0 && h > 0) || !mask8 || mask8.length !== w * h) throw fail('IJ_BAD_ARGS', 'edm size');
    const n = w * h;
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) if (mask8[i] !== backgroundValue) out[i] = 3.4028234663852886e38; // Float.MAX_VALUE
    const pointBufs = [new Int32Array(w), new Int32Array(w)];
    const MAXI = 2147483647;
    let yDist = MAXI; // used only when the edges are background

    /* One line, both directions. Each foreground pixel takes the nearest of three candidates — the point remembered
     * for its column (previous line), the diagonal one and the previous one of the sweep (EDM.minDist2) — and keeps the
     * smaller of that squared distance and what an earlier sweep left in `out`. */
    function edmLine(offset, y) {
      let points = pointBufs[0]; // left-to-right pass
      let pPrev = -1, pDiag = -1, pNextDiag;
      const edgeBg = yDist !== MAXI;
      let distSqr = MAXI; // used only if the edges are background
      for (let x = 0; x < w; x++, offset++) {
        pNextDiag = points[x];
        if (mask8[offset] === backgroundValue) {
          points[x] = x | (y << 16);
        } else {
          if (edgeBg) distSqr = (x + 1 < yDist) ? (x + 1) * (x + 1) : yDist * yDist;
          const p0 = pNextDiag; // points[x] before this pixel
          let nearest = p0;
          let dsq = distSqr;
          if (p0 !== -1) {
            const dx = x - (p0 & 0xffff), dy = y - ((p0 >> 16) & 0xffff);
            const d = dx * dx + dy * dy;
            if (d < dsq) dsq = d;
          }
          if (pDiag !== p0 && pDiag !== -1) {
            const dx = x - (pDiag & 0xffff), dy = y - ((pDiag >> 16) & 0xffff);
            const d = dx * dx + dy * dy;
            if (d < dsq) { nearest = pDiag; dsq = d; }
          }
          if (pPrev !== pDiag && pPrev !== -1) {
            const dx = x - (pPrev & 0xffff), dy = y - ((pPrev >> 16) & 0xffff);
            const d = dx * dx + dy * dy;
            if (d < dsq) { nearest = pPrev; dsq = d; }
          }
          points[x] = nearest;
          const d2 = fround(dsq); // stored into a Float32Array: (float) distSqr
          if (out[offset] > d2) out[offset] = d2;
        }
        pPrev = points[x];
        pDiag = pNextDiag;
      }
      offset--; // the last pixel of the line
      points = pointBufs[1]; // right-to-left pass
      pPrev = -1; pDiag = -1;
      for (let x = w - 1; x >= 0; x--, offset--) {
        pNextDiag = points[x];
        if (mask8[offset] === backgroundValue) {
          points[x] = x | (y << 16);
        } else {
          if (edgeBg) distSqr = (w - x < yDist) ? (w - x) * (w - x) : yDist * yDist;
          const p0 = pNextDiag;
          let nearest = p0;
          let dsq = distSqr;
          if (p0 !== -1) {
            const dx = x - (p0 & 0xffff), dy = y - ((p0 >> 16) & 0xffff);
            const d = dx * dx + dy * dy;
            if (d < dsq) dsq = d;
          }
          if (pDiag !== p0 && pDiag !== -1) {
            const dx = x - (pDiag & 0xffff), dy = y - ((pDiag >> 16) & 0xffff);
            const d = dx * dx + dy * dy;
            if (d < dsq) { nearest = pDiag; dsq = d; }
          }
          if (pPrev !== pDiag && pPrev !== -1) {
            const dx = x - (pPrev & 0xffff), dy = y - ((pPrev >> 16) & 0xffff);
            const d = dx * dx + dy * dy;
            if (d < dsq) { nearest = pPrev; dsq = d; }
          }
          points[x] = nearest;
          const d2 = fround(dsq);
          if (out[offset] > d2) out[offset] = d2;
        }
        pPrev = points[x];
        pDiag = pNextDiag;
      }
    }

    const rowsPerYield = Math.max(1, Math.floor(EDM_YIELD_PIXELS / w));
    yield 0;
    // passes 1 & 2: increasing y (and both x directions inside edmLine)
    pointBufs[0].fill(-1); pointBufs[1].fill(-1);
    for (let y = 0; y < h; y++) {
      if (edgesAreBackground) yDist = y + 1; // distance to the nearest background point along y
      edmLine(y * w, y);
      if ((y + 1) % rowsPerYield === 0) yield 0.45 * ((y + 1) / h);
    }
    // passes 3 & 4: decreasing y
    pointBufs[0].fill(-1); pointBufs[1].fill(-1);
    for (let y = h - 1; y >= 0; y--) {
      if (edgesAreBackground) yDist = h - y;
      edmLine(y * w, y);
      if ((h - y) % rowsPerYield === 0) yield 0.45 + 0.45 * ((h - y) / h);
    }
    // fp.sqrt(): v <= 0 → 0, else (float) msqrt(v)
    const sqrtChunk = EDM_YIELD_PIXELS * 4;
    for (let a = 0; a < n; a += sqrtChunk) {
      const e = Math.min(n, a + sqrtChunk);
      for (let i = a; i < e; i++) { const v = out[i]; out[i] = v <= 0 ? 0 : msqrt(v); }
      yield 0.9 + 0.1 * (e / n);
    }
    return out;
  }

  function makeFloatEDM(mask8, w, h, opts) {
    const g = edmSteps(mask8, w, h, opts);
    for (;;) { const r = g.next(); if (r.done) return r.value; }
  }

  async function makeFloatEDMAsync(mask8, w, h, opts) {
    const o = opts || {};
    const g = edmSteps(mask8, w, h, o);
    for (;;) {
      const r = g.next();
      if (r.done) return r.value;
      if (o.check) await o.check();
      if (o.tick) await o.tick(r.value);
    }
  }

  /* 255 where lower <= v <= upper (NaN never), else 0 — the 8-bit mask ImageJ's Create Mask and
   * Convert to Mask build from a threshold. */
  function thresholdMask(ch, lower, upper) {
    const d = ch.data, n = d.length;
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) { const v = d[i]; if (v >= lower && v <= upper) out[i] = 255; }
    return out;
  }

  /* A mask (0 / non-0, w·h) as a selection: a rectangle when the set pixels fill their bounding
   * box, else a `mask` ROI (exact pixel set, runs as a Uint32Array); null when nothing is set.
   * A selection made of a huge number of runs throws IJ_ROI_TOO_COMPLEX (IJRoi.fromMask). The
   * traced outline of the pixel set (what ImageJ's ThresholdToSelection builds) is IJRoi.outlines. */
  function maskToRoi(mask8, w, h) {
    const IJRoi = root.IJRoi;
    if (!IJRoi) throw fail('IJ_MODULE_MISSING', 'IJRoi');
    const r = IJRoi.fromMask(mask8, w, h);
    if (!r.w || !r.h) return null;
    let on = 0;
    for (let i = 1; i < r.rle.length; i += 2) on += r.rle[i];
    if (on === r.w * r.h) return { type: 'rect', x: r.x, y: r.y, w: r.w, h: r.h };
    return r;
  }

  /* ImageJ's "light background" convention (BackgroundSubtracter, Find Maxima, Top Hat …):
   *   invert = (lightBackground && !ip.isInvertedLut()) || (!lightBackground && ip.isInvertedLut())
   * i.e. the data is inverted when the user says the background is light on a normal LUT, or says
   * nothing on an inverting LUT. */
  function lightBackgroundInvert(lightBackground, invertedLut) {
    return (!!lightBackground && !invertedLut) || (!lightBackground && !!invertedLut);
  }
  /* A channel shows with an inverting LUT when its display says `invert`. */
  function hasInvertedLut(display) { return !!(display && display.invert); }

  root.IJShared = { makeFloatEDM, makeFloatEDMAsync, thresholdMask, maskToRoi, lightBackgroundInvert, hasInvertedLut };
})(typeof self !== 'undefined' ? self : globalThis);
