/* ij-proc-shared.js — primitives shared by the processing packages of the Advanced Studio.
 *
 * Classic script, page and worker, loaded after ij-core.js / ij-analysis.js and before every
 * ij-proc-<pkg>.js (PLAN-wave2 §2.4). W0-owned: a package never edits this file; it reports what
 * it misses. Attaches `IJShared` to `self`.
 *
 *   IJShared.makeFloatEDM(mask8, w, h, opts) → Float32Array   exact Euclidean distance map
 *   IJShared.maskToRoi(mask8, w, h) → ROI | null              ThresholdToSelection-compatible
 *   IJShared.thresholdMask(ch, lower, upper) → Uint8Array     255 inside [lower, upper], else 0
 *   IJShared.lightBackgroundInvert(light, invertedLut) → bool the "light background" convention
 *   IJShared.hasInvertedLut(display) → bool
 *
 * Reference: ImageJ 1.54f (public domain).
 */
(function (root) {
  'use strict';

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
   * ImageJ 1.54f (PLAN-wave2 §6, tests/fixtures/ij-wave2/seg) validate it bit for bit. Until they
   * exist the tests compare against a brute-force Euclidean distance.
   *
   *   mask8   Uint8Array w·h; a pixel is background when it equals opts.backgroundValue (default 0:
   *           white-on-black masks, Prefs.blackBackground = true and a normal LUT), foreground otherwise
   *   opts.edgesAreBackground  false (default): the image edge is not a background (scipy's
   *           distance_transform_edt convention); true: pixels outside count as background
   *   returns the distance in pixels (the square root is taken at the end, as FloatProcessor.sqrt()).
   *   An image without any background pixel keeps ImageJ's value sqrt(2^31) ≈ 46341. */
  function makeFloatEDM(mask8, w, h, opts) {
    const o = opts || {};
    const backgroundValue = o.backgroundValue === undefined ? 0 : o.backgroundValue;
    const edgesAreBackground = !!o.edgesAreBackground;
    if (!(Number.isInteger(w) && Number.isInteger(h) && w > 0 && h > 0) || !mask8 || mask8.length !== w * h) throw fail('IJ_BAD_ARGS', 'edm size');
    const out = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) if (mask8[i] !== backgroundValue) out[i] = 3.4028234663852886e38; // Float.MAX_VALUE
    const pointBufs = [new Int32Array(w), new Int32Array(w)];
    const MAXI = 2147483647;
    let yDist = MAXI; // used only when the edges are background

    // minDist2: nearest of the candidates (own column of the previous line, diagonal, previous in the sweep)
    function minDist2(points, pPrev, pDiag, x, y, distSqr) {
      const p0 = points[x];
      let nearest = p0;
      if (p0 !== -1) {
        const x0 = p0 & 0xffff, y0 = (p0 >> 16) & 0xffff;
        const d = (x - x0) * (x - x0) + (y - y0) * (y - y0);
        if (d < distSqr) distSqr = d;
      }
      if (pDiag !== p0 && pDiag !== -1) {
        const x1 = pDiag & 0xffff, y1 = (pDiag >> 16) & 0xffff;
        const d = (x - x1) * (x - x1) + (y - y1) * (y - y1);
        if (d < distSqr) { nearest = pDiag; distSqr = d; }
      }
      if (pPrev !== pDiag && pPrev !== -1) {
        const x1 = pPrev & 0xffff, y1 = (pPrev >> 16) & 0xffff;
        const d = (x - x1) * (x - x1) + (y - y1) * (y - y1);
        if (d < distSqr) { nearest = pPrev; distSqr = d; }
      }
      points[x] = nearest;
      return distSqr; // stored into a Float32Array: (float) distSqr
    }

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
          const d2 = Math.fround(minDist2(points, pPrev, pDiag, x, y, distSqr));
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
          const d2 = Math.fround(minDist2(points, pPrev, pDiag, x, y, distSqr));
          if (out[offset] > d2) out[offset] = d2;
        }
        pPrev = points[x];
        pDiag = pNextDiag;
      }
    }

    // passes 1 & 2: increasing y (and both x directions inside edmLine)
    pointBufs[0].fill(-1); pointBufs[1].fill(-1);
    for (let y = 0; y < h; y++) {
      if (edgesAreBackground) yDist = y + 1; // distance to the nearest background point along y
      edmLine(y * w, y);
    }
    // passes 3 & 4: decreasing y
    pointBufs[0].fill(-1); pointBufs[1].fill(-1);
    for (let y = h - 1; y >= 0; y--) {
      if (edgesAreBackground) yDist = h - y;
      edmLine(y * w, y);
    }
    // fp.sqrt(): v <= 0 → 0, else (float) Math.sqrt(v)
    for (let i = 0; i < out.length; i++) { const v = out[i]; out[i] = v <= 0 ? 0 : Math.sqrt(v); }
    return out;
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

  root.IJShared = { makeFloatEDM, thresholdMask, maskToRoi, lightBackgroundInvert, hasInvertedLut };
})(typeof self !== 'undefined' ? self : globalThis);
