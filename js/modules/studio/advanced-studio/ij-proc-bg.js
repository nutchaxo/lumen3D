/* ij-proc-bg.js — package P1 (bg): Subtract Background and Enhance Contrast.
 *
 * Loaded on the page AND in the worker (ij-worker.js loads it in its own try/catch). Pure: no DOM, no
 * engine globals; the operations are registered with IJOpRegistry.define(name, spec) (PLAN-wave2 §2.1).
 *
 * Reference: ImageJ 1.54p (public domain), ported faithfully.
 *   ij.plugin.filter.BackgroundSubtracter   rolling ball + sliding paraboloid, per-type offset / clamp
 *   ij.plugin.ContrastEnhancer              saturated range, Normalize, Equalize
 *   ij.process.{Byte,Short,Float}Statistics the histogram the saturated range reads
 * Java `float` arithmetic is reproduced with Math.fround at every step (a Float32Array store rounds the
 * same way); Java `int` casts with d2i(); ImageJ's bugs-by-design are kept (quoted beside each port).
 *
 * Operations
 *   subtractBackground  pixel   Process > Subtract Background. A selection is IGNORED (roi 'ignore'):
 *        BackgroundSubtracter.flags = DOES_ALL|FINAL_PROCESSING|KEEP_PREVIEW|PARALLELIZE_STACKS, no SUPPORTS_MASKING,
 *        and rollingBallBackground() never reads the processor's roi: the whole image is processed.
 *        setup("final") calls resetMinAndMax() → `display: true` (the engine resets the display range).
 *   saturatedRange      compute ContrastEnhancer.stretchHistogram without Normalize: the display range of the
 *        selection's histogram (the command hands it to api.setDisplay; pixels are never touched).
 *   enhanceNormalize    pixel   ContrastEnhancer.normalize(ip, min, max) with the range saturatedRange returned.
 *   enhanceEqualize     pixel   ContrastEnhancer.equalize(ip, histogram) — histogram of the selection's bounding
 *        rectangle, the lookup table is applied to the WHOLE image.
 */
(function (root) {
  'use strict';

  const fround = Math.fround;
  // Math functions held in locals: a global lookup (`Math.`) inside a hot loop is slow wherever the global object is
  // an interceptor-backed one (a vm context, as in the test harness) and costs nothing to avoid.
  const m_trunc = Math.trunc, m_sqrt = Math.sqrt, m_floor = Math.floor, m_min = Math.min, m_max = Math.max;
  const FLOAT_MAX = 3.4028234663852886e38; // Float.MAX_VALUE
  const INT_MAX = 2147483647;
  const C_THIRD = fround(0.33333333); // the float literal 0.33333333f of filter3()

  function fail(code, msg) { return Object.assign(new Error(msg || code), { code }); }

  /* Java (int)(double): NaN → 0, saturating, truncation toward zero. */
  function d2i(x) {
    if (x !== x) return 0;
    if (x >= 2147483647) return 2147483647;
    if (x <= -2147483648) return -2147483648;
    return m_trunc(x);
  }

  const noHooks = { tick: async () => {}, check: () => {} };
  const yieldEvery = 32; // lines / rows between two progress ticks

  // ──────────────────────────── Rolling ball ────────────────────────────

  /* BackgroundSubtracter.RollingBall: the shrink factor and the patch of the ball.
   *   radius <= 10: 1 / trim 24 %; <= 30: 2 / 24 %; <= 100: 4 / 32 %; else 8 / 40 %. */
  function shrinkFactorOf(radius) {
    if (radius <= 10) return 1;
    if (radius <= 30) return 2;
    if (radius <= 100) return 4;
    return 8;
  }

  function buildBall(radius) {
    let arcTrimPer, shrinkFactor;
    if (radius <= 10) { shrinkFactor = 1; arcTrimPer = 24; }
    else if (radius <= 30) { shrinkFactor = 2; arcTrimPer = 24; }
    else if (radius <= 100) { shrinkFactor = 4; arcTrimPer = 32; }
    else { shrinkFactor = 8; arcTrimPer = 40; }
    let smallballradius = radius / shrinkFactor;
    if (smallballradius < 1) smallballradius = 1;
    const rsquare = smallballradius * smallballradius;
    const xtrim = m_trunc(m_trunc(arcTrimPer * smallballradius) / 100); // (int)(arcTrimPer*smallballradius)/100
    const halfWidth = m_floor((smallballradius - xtrim) + 0.5);              // (int)Math.round(...)
    const width = 2 * halfWidth + 1;
    const data = new Float32Array(width * width);
    for (let y = 0, p = 0; y < width; y++) {
      for (let x = 0; x < width; x++, p++) {
        const xval = x - halfWidth, yval = y - halfWidth;
        const temp = rsquare - xval * xval - yval * yval;
        // "-Float.MAX_VALUE might be better than 0f, but gives different results than earlier versions"
        data[p] = temp > 0 ? m_sqrt(temp) : 0;
      }
    }
    return { data, width, shrinkFactor };
  }

  /* BackgroundSubtracter.filter3x3 / filter3: 3×3 maximum (returns the mean shift) or mean, as two 1-D passes. */
  function filter3(pixels, length, pixel0, inc, isMax) {
    let shiftBy = 0;
    let v3 = pixels[pixel0];
    let v2 = v3;
    let v1;
    for (let i = 0, p = pixel0; i < length; i++, p += inc) {
      v1 = v2;
      v2 = v3;
      if (i < length - 1) v3 = pixels[p + inc];
      if (isMax) {
        let max = v1 > v3 ? v1 : v3;
        if (v2 > max) max = v2;
        shiftBy += fround(max - v2);
        pixels[p] = max;
      } else pixels[p] = fround(fround(fround(v1 + v2) + v3) * C_THIRD);
    }
    return shiftBy;
  }

  // `hooks` (optional) only adds a cancel check every `yieldEvery` rows of either pass; no value depends on it.
  function filter3x3(pixels, width, height, isMax, hooks) {
    let shiftBy = 0;
    for (let y = 0; y < height; y++) {
      if (hooks && y % yieldEvery === 0) hooks.check();
      shiftBy += filter3(pixels, width, y * width, 1, isMax);
    }
    // The column pass of ImageJ walks one column at a time (a cache line per pixel). Here the same per-pixel arithmetic
    // sweeps the rows, the previous ORIGINAL row kept in `prev`; the shift of a column is still summed in ascending y
    // (colShift[x], starting at 0) and the columns are added in ascending x, so every rounding of `shiftBy` is the same.
    const prev = new Float32Array(width);
    const colShift = new Float64Array(width);
    prev.set(pixels.subarray(0, width));
    for (let y = 0, row = 0; y < height; y++, row += width) {
      if (hooks && y % yieldEvery === 0) hooks.check();
      const next = y < height - 1 ? row + width : row; // the last row repeats itself as v3
      if (isMax) {
        for (let x = 0; x < width; x++) {
          const v1 = prev[x], v2 = pixels[row + x], v3 = pixels[next + x];
          let max = v1 > v3 ? v1 : v3;
          if (v2 > max) max = v2;
          colShift[x] += fround(max - v2);
          prev[x] = v2;
          pixels[row + x] = max;
        }
      } else {
        for (let x = 0; x < width; x++) {
          const v1 = prev[x], v2 = pixels[row + x], v3 = pixels[next + x];
          prev[x] = v2;
          pixels[row + x] = fround(fround(fround(v1 + v2) + v3) * C_THIRD);
        }
      }
    }
    if (isMax) for (let x = 0; x < width; x++) shiftBy += colShift[x];
    return shiftBy / width / height;
  }

  /* BackgroundSubtracter.shrinkImage: each point of the small image is the minimum of its neighbourhood. */
  function shrinkImage(pixels, width, height, shrinkFactor) {
    const sWidth = m_trunc((width + shrinkFactor - 1) / shrinkFactor);
    const sHeight = m_trunc((height + shrinkFactor - 1) / shrinkFactor);
    const sPixels = new Float32Array(sWidth * sHeight);
    for (let ySmall = 0; ySmall < sHeight; ySmall++) {
      for (let xSmall = 0; xSmall < sWidth; xSmall++) {
        let min = FLOAT_MAX;
        for (let j = 0, y = shrinkFactor * ySmall; j < shrinkFactor && y < height; j++, y++) {
          for (let k = 0, x = shrinkFactor * xSmall; k < shrinkFactor && x < width; k++, x++) {
            const thispixel = pixels[x + y * width];
            if (thispixel < min) min = thispixel;
          }
        }
        sPixels[xSmall + ySmall * sWidth] = min;
      }
    }
    return { pixels: sPixels, width: sWidth, height: sHeight };
  }

  /* BackgroundSubtracter.rollBall: the ball is rolled under the (shrunken) image; `pixels` becomes the background.
   *
   * ImageJ scatters: for every ball position (x,y) it takes z = min(cache - zBall) over the footprint (pass 1, an
   * erosion) and then raises every pixel of the footprint to at least z + zBall (pass 2, a dilation). Pass 2 is
   * rewritten here as the equivalent GATHER: pixel (x,y) = max over the ball positions that cover it of
   * z(x',y') + zBall[(y-y')+r][(x-x')+r] (the same set of terms, since the ball is addressed by the offset between
   * the two positions). A max of unrounded sums rounded once equals the sequence of rounded conditional stores
   * (rounding is monotonic), and the accumulator stays in a register instead of a read-modify-write per tap.
   * z rows (the whole width + one ball radius either side) live in a ring of `ballWidth` rows; the output row
   * y - r is final as soon as z row y exists, and its input row is long since copied into `cache`.
   * Both passes compute four neighbouring outputs per ball tap, so a ball value is loaded once for four taps. */
  async function rollBall(ball, pixels, width, height, hooks, p0, p1) {
    const zBall = ball.data;
    const bw = ball.width;
    const radius = m_trunc(bw / 2);
    const cache = new Float32Array(width * bw);
    const zw = width + 2 * radius;
    const zring = new Float32Array(zw * bw);
    const rowBase = new Int32Array(bw); // cache offset of the footprint row j
    const ballRow = new Int32Array(bw); // zBall offset of the footprint row j
    const yTotal = height + 2 * radius;
    // a row costs (width + ballWidth) * ballWidth^2 operations: a big ball is checked every row (and inside it)
    const checkMask = bw > 32 ? 0 : 7;
    const xInteriorLo = 2 * radius;       // zring index of the first x whose whole footprint is inside the image
    const xInteriorHi = width - 1;        // ... and of the last one
    for (let y = -radius; y < height + radius; y++) {
      if (((y + radius) & checkMask) === 0) { hooks.check(); await hooks.tick(p0 + (p1 - p0) * ((y + radius) / yTotal)); }
      const nextLineToRead = y + radius;
      if (nextLineToRead < height) {
        const o = (nextLineToRead % bw) * width;
        cache.set(pixels.subarray(nextLineToRead * width, nextLineToRead * width + width), o);
      }
      let y0 = y - radius;
      if (y0 < 0) y0 = 0;
      const yBall0 = y0 - y + radius;
      let yend = y + radius;
      if (yend >= height) yend = height - 1;
      const nRows = yend - y0 + 1;
      for (let j = 0; j < nRows; j++) { rowBase[j] = ((y0 + j) % bw) * width; ballRow[j] = (yBall0 + j) * bw; }
      // pass 1: z of every ball position of this row, into its ring slot
      const zo = ((y + radius) % bw) * zw;
      let xi = 0;
      for (; xi < zw && xi < xInteriorLo; xi++) { if (checkMask === 0 && (xi & 15) === 0) hooks.check(); zring[zo + xi] = zBorder(cache, zBall, rowBase, ballRow, nRows, xi - radius, radius, width, bw); }
      let lastInterior = m_min(xInteriorHi, zw - 1);
      for (; xi + 3 <= lastInterior; xi += 4) {
        if (checkMask === 0 && (xi & 15) === 0) hooks.check(); // every 16 positions (4 iterations)
        const xs = xi - 2 * radius; // x - radius of the first of the four outputs
        let z0 = FLOAT_MAX, z1 = FLOAT_MAX, z2 = FLOAT_MAX, z3 = FLOAT_MAX;
        for (let j = 0; j < nRows; j++) {
          const cb = rowBase[j] + xs, bb = ballRow[j];
          for (let k = 0; k < bw; k++) {
            const b = zBall[bb + k], c = cb + k;
            const d0 = cache[c] - b, d1 = cache[c + 1] - b, d2 = cache[c + 2] - b, d3 = cache[c + 3] - b;
            if (d0 < z0) z0 = d0;
            if (d1 < z1) z1 = d1;
            if (d2 < z2) z2 = d2;
            if (d3 < z3) z3 = d3;
          }
        }
        zring[zo + xi] = z0; zring[zo + xi + 1] = z1; zring[zo + xi + 2] = z2; zring[zo + xi + 3] = z3;
      }
      for (; xi <= lastInterior; xi++) {
        const xs = xi - 2 * radius;
        let z = FLOAT_MAX;
        for (let j = 0; j < nRows; j++) {
          const cb = rowBase[j] + xs, bb = ballRow[j];
          for (let k = 0; k < bw; k++) { const d = cache[cb + k] - zBall[bb + k]; if (d < z) z = d; }
        }
        zring[zo + xi] = z;
      }
      for (; xi < zw; xi++) { if (checkMask === 0 && (xi & 15) === 0) hooks.check(); zring[zo + xi] = zBorder(cache, zBall, rowBase, ballRow, nRows, xi - radius, radius, width, bw); }
      if (checkMask === 0) hooks.check();
      // pass 2: output row r = y - radius
      const r = y - radius;
      if (r < 0) continue;
      let lo = r - radius; if (lo < -radius) lo = -radius;
      const out = r * width;
      const nz = y - lo + 1; // footprint rows y' = lo .. y
      for (let j = 0; j < nz; j++) { rowBase[j] = ((lo + j + radius) % bw) * zw; ballRow[j] = (r - (lo + j) + radius) * bw; }
      let x = 0;
      for (; x + 3 < width; x += 4) {
        if (checkMask === 0 && (x & 15) === 0) hooks.check();
        let m0 = -FLOAT_MAX, m1 = -FLOAT_MAX, m2 = -FLOAT_MAX, m3 = -FLOAT_MAX;
        for (let j = 0; j < nz; j++) {
          const zb = rowBase[j] + x, bb = ballRow[j];
          for (let k = 0; k < bw; k++) {
            // zBall[bb + k] is column k = x' - x + r of the ball, where the ImageJ formula reads column (x - x') + r = 2r - k:
            // the same value because buildBall is exactly symmetric in x.
            const b = zBall[bb + k], c = zb + k;
            const v0 = zring[c] + b, v1 = zring[c + 1] + b, v2 = zring[c + 2] + b, v3 = zring[c + 3] + b;
            if (v0 > m0) m0 = v0;
            if (v1 > m1) m1 = v1;
            if (v2 > m2) m2 = v2;
            if (v3 > m3) m3 = v3;
          }
        }
        pixels[out + x] = m0; pixels[out + x + 1] = m1; pixels[out + x + 2] = m2; pixels[out + x + 3] = m3;
      }
      for (; x < width; x++) {
        let m = -FLOAT_MAX;
        for (let j = 0; j < nz; j++) {
          const zb = rowBase[j] + x, bb = ballRow[j];
          for (let k = 0; k < bw; k++) { const v = zring[zb + k] + zBall[bb + k]; if (v > m) m = v; }
        }
        pixels[out + x] = m;
      }
    }
  }

  /* z of the ball at x (possibly outside the image) where the footprint is clipped to the image: the border case of pass 1. */
  function zBorder(cache, zBall, rowBase, ballRow, nRows, x, radius, width, bw) {
    let x0 = x - radius;
    if (x0 < 0) x0 = 0;
    const xBall0 = x0 - x + radius;
    let xend = x + radius;
    if (xend >= width) xend = width - 1;
    let z = FLOAT_MAX;
    for (let j = 0; j < nRows; j++) {
      for (let xp = x0, c = rowBase[j] + x0, bp = ballRow[j] + xBall0; xp <= xend; xp++, c++, bp++) {
        const d = cache[c] - zBall[bp];
        if (d < z) z = d;
      }
    }
    return z;
  }

  /* BackgroundSubtracter.makeInterpolationArrays */
  function makeInterpolationArrays(smallIndices, weights, length, smallLength, shrinkFactor) {
    for (let i = 0; i < length; i++) {
      let smallIndex = m_trunc((i - m_trunc(shrinkFactor / 2)) / shrinkFactor); // Java int division
      if (smallIndex >= smallLength - 1) smallIndex = smallLength - 2;
      smallIndices[i] = smallIndex;
      const distance = fround(fround(fround(i + 0.5) / shrinkFactor) - fround(smallIndex + 0.5)); // distance of pixel centers
      weights[i] = fround(1 - distance);
    }
  }

  /* BackgroundSubtracter.enlargeImage: bilinear interpolation of the small background (extrapolation at the edges). */
  function enlargeImage(sPixels, smallWidth, smallHeight, pixels, width, height, shrinkFactor) {
    const xSmallIndices = new Int32Array(width);
    const xWeights = new Float32Array(width);
    makeInterpolationArrays(xSmallIndices, xWeights, width, smallWidth, shrinkFactor);
    const ySmallIndices = new Int32Array(height);
    const yWeights = new Float32Array(height);
    makeInterpolationArrays(ySmallIndices, yWeights, height, smallHeight, shrinkFactor);
    let line0 = new Float32Array(width);
    let line1 = new Float32Array(width);
    for (let x = 0; x < width; x++) {
      line1[x] = fround(fround(sPixels[xSmallIndices[x]] * xWeights[x]) + fround(sPixels[xSmallIndices[x] + 1] * fround(1 - xWeights[x])));
    }
    let ySmallLine0 = -1;
    for (let y = 0; y < height; y++) {
      if (ySmallLine0 < ySmallIndices[y]) {
        const swap = line0; line0 = line1; line1 = swap; // previous line1 -> line0
        ySmallLine0++;
        const sYPointer = (ySmallIndices[y] + 1) * smallWidth;
        for (let x = 0; x < width; x++) {
          line1[x] = fround(fround(sPixels[sYPointer + xSmallIndices[x]] * xWeights[x]) + fround(sPixels[sYPointer + xSmallIndices[x] + 1] * fround(1 - xWeights[x])));
        }
      }
      const weight = yWeights[y];
      const omw = fround(1 - weight);
      for (let x = 0, p = y * width; x < width; x++, p++) pixels[p] = fround(fround(line0[x] * weight) + fround(line1[x] * omw));
    }
  }

  /* BackgroundSubtracter.rollingBallFloatBackground: `pixels` (Float32Array, width·height) becomes the background. */
  async function rollingBallFloatBackground(pixels, width, height, invert, doPresmooth, ball, hooks) {
    const shrink = ball.shrinkFactor > 1;
    if (invert) for (let i = 0; i < pixels.length; i++) pixels[i] = -pixels[i];
    if (doPresmooth) filter3x3(pixels, width, height, false);
    hooks.check();
    if (shrink) {
      const small = shrinkImage(pixels, width, height, ball.shrinkFactor);
      await rollBall(ball, small.pixels, small.width, small.height, hooks, 0.1, 0.9);
      await hooks.tick(0.9);
      enlargeImage(small.pixels, small.width, small.height, pixels, width, height, ball.shrinkFactor);
    } else {
      await rollBall(ball, pixels, width, height, hooks, 0.1, 0.9);
    }
    if (invert) for (let i = 0; i < pixels.length; i++) pixels[i] = -pixels[i];
  }

  // ──────────────────────────── Sliding paraboloid ────────────────────────────

  const X_DIRECTION = 0, Y_DIRECTION = 1, DIAGONAL_1A = 2, DIAGONAL_1B = 3, DIAGONAL_2A = 4, DIAGONAL_2B = 5;

  function pow6(dx) { return fround(fround(fround(fround(fround(dx * dx) * dx) * dx) * dx) * dx); } // dx*dx*dx*dx*dx*dx

  /* 1/d and coeff2*d (double) for d = 0 .. length, shared by the lines of one pass (same coeff2, same or shorter length). */
  let slopeTabCache = { coeff2: -1, inv: new Float64Array(0), ct: new Float64Array(0), cr: new Float64Array(0) };
  function slopeTables(coeff2, length) {
    const t = slopeTabCache;
    if (t.coeff2 === coeff2 && t.inv.length > length) return t;
    const n = m_max(length + 1, t.coeff2 === coeff2 ? 2 * t.inv.length : 0);
    const inv = new Float64Array(n), ct = new Float64Array(n), cr = new Float64Array(n);
    for (let d = 1; d < n; d++) { inv[d] = 1 / d; ct[d] = coeff2 * d; cr[d] = fround(coeff2 * d); } // cr: the float product of ImageJ
    slopeTabCache = { coeff2, inv, ct, cr };
    return slopeTabCache;
  }

  let slideFirstCorner = 0, slideLastCorner = 0; // results of slideFrom for the edge estimate of lineSlideParabola

  /* The touch-point search of lineSlideParabola from touch point i1 on, over the linked list nextPoint (the loop of
   * BackgroundSubtracter.lineSlideParabola). cache holds the line, pixels receives the parabola segments. */
  function slideFrom(pixels, start, inc, length, coeff2, cache, nextPoint, i1, tabs, minValue) {
    const invTab = tabs.inv, ctTab = tabs.ct; // 1/d and coeff2*d in double
    let firstCorner = length - 1;
    let lastCorner = 0;
    while (i1 < length - 1) {
      const v1 = cache[i1];
      let minSlope = FLOAT_MAX;
      let i2 = 0;
      let searchTo = length;
      let recalculateLimitNow = 0; // when 0, limits for searching will be recalculated
      for (let j = nextPoint[i1]; j < searchTo; j = nextPoint[j], recalculateLimitNow++) {
        const v2 = cache[j];
        const d = j - i1;
        // Almost every candidate loses against minSlope. A division-free estimate a + b (a = (v2-v1)/d, b = coeff2*d,
        // from the tables) settles those: the float slope of ImageJ differs from the exact a + b by at most four
        // float roundings, i.e. 4 * 2^-24 * (|a| + b) < 1e-6 * (|a| + b); a candidate whose estimate exceeds
        // minSlope by more than that cannot satisfy `slope < minSlope`, so only the others compute the float slope.
        const a = (v2 - v1) * invTab[d];
        const approx = a + ctTab[d];
        // Two cases always go to the exact float path: d <= 0 (nextPoint jumped back or stayed after the i2 <= i1
        // fallback, so the tables have no entry and a is NaN) and v2 - v1 < -FLOAT_MAX (fround gives -Infinity, which
        // the finite double estimate cannot see).
        if (d <= 0 || v2 - v1 < -FLOAT_MAX || approx - (a < 0 ? -a + ctTab[d] : approx) * 1e-6 < minSlope) {
          const slope = fround(fround(fround(v2 - v1) / d) + fround(coeff2 * d));
          if (slope < minSlope) {
            minSlope = slope;
            i2 = j;
            recalculateLimitNow = -3;
          }
        }
        if (recalculateLimitNow === 0) { // time-consuming recalculation of search limit: wait a bit after slope is updated
          const b = fround(fround(0.5 * minSlope) / coeff2);
          const maxSearch = (i1 + d2i(b + m_sqrt(b * b + fround(fround(v1 - minValue) / coeff2)) + 1)) | 0; // (numeric overflow may make this negative)
          if (maxSearch < searchTo && maxSearch > 0) searchTo = maxSearch;
        }
      }
      if (i2 <= i1) i2 = i1 + 1; // NaN data: ImageJ would loop forever here
      if (i1 === 0) firstCorner = i2;
      if (i2 === length - 1) lastCorner = i1;
      // interpolate between the two points where the parabola touches
      for (let j = i1 + 1, p = start + j * inc; j < i2; j++, p += inc) {
        pixels[p] = fround(v1 + fround((j - i1) * fround(minSlope - fround((j - i1) * coeff2))));
      }
      i1 = i2; // continue from this new point
    }
    slideFirstCorner = firstCorner; slideLastCorner = lastCorner;
  }

  /* BackgroundSubtracter.lineSlideParabola: slides a parabola along one line from below and sets the values so
   * that every point is reachable. With `correctedEdges` (Float32Array(2)) it also returns the two edge values
   * estimated without an edge particle. */
  function lineSlideParabola(pixels, start, inc, length, coeff2, cache, nextPoint, correctedEdges) {
    let minValue = FLOAT_MAX;
    let lastpoint = 0;
    let vPrevious1 = 0;
    let vPrevious2 = 0;
    const curvatureTest = fround(fround(1.999) * coeff2); // not 2: numeric scatter of 2nd derivative
    const tabs = slopeTables(coeff2, length);
    for (let i = 0, p = start; i < length; i++, p += inc) {
      const v = pixels[p];
      cache[i] = v;
      if (v < minValue) minValue = v;
      if (i >= 2 && fround(fround(fround(vPrevious1 + vPrevious1) - vPrevious2) - v) < curvatureTest) {
        nextPoint[lastpoint] = i - 1; // point i-1 may be touched
        lastpoint = i - 1;
      }
      vPrevious2 = vPrevious1;
      vPrevious1 = v;
    }
    nextPoint[lastpoint] = length - 1;
    nextPoint[length - 1] = INT_MAX; // breaks the search loop

    slideFrom(pixels, start, inc, length, coeff2, cache, nextPoint, 0, tabs, minValue);
    let firstCorner = slideFirstCorner, lastCorner = slideLastCorner;
    // Estimated edge values without an edge particle, allowing for vignetting described as a 6th-order polynomial
    if (correctedEdges) {
      if (4 * firstCorner >= length) firstCorner = 0; // edge particles must be < 1/4 image size
      if (4 * (length - 1 - lastCorner) >= length) lastCorner = length - 1;
      const v1 = cache[firstCorner];
      const v2 = cache[lastCorner];
      const slope = fround(fround(v2 - v1) / (lastCorner - firstCorner)); // of the line through the two outermost non-edge touching points
      const value0 = fround(v1 - fround(slope * firstCorner)); // offset of this line
      let coeff6 = 0; // coefficient of 6th order polynomial
      const mid = fround(0.5 * (lastCorner + firstCorner));
      for (let i = m_trunc((length + 2) / 3); i <= m_trunc((2 * length) / 3); i++) { // compare with mid-image pixels to detect vignetting
        const dx = fround(fround(fround(i - mid) * 2) / (lastCorner - firstCorner));
        const poly6 = fround(pow6(dx) - 1); // the 6th order polynomial, zero at firstCorner and lastCorner
        const lineAt = fround(value0 + fround(slope * i));
        if (cache[i] < fround(lineAt + fround(coeff6 * poly6))) {
          coeff6 = fround(-fround(lineAt - cache[i]) / poly6);
        }
      }
      let dx = fround(fround(fround(firstCorner - mid) * 2) / (lastCorner - firstCorner));
      correctedEdges[0] = fround(fround(value0 + fround(coeff6 * fround(pow6(dx) - 1))) + fround(fround(coeff2 * firstCorner) * firstCorner));
      dx = fround(fround(fround(lastCorner - mid) * 2) / (lastCorner - firstCorner));
      const tail = length - 1 - lastCorner;
      correctedEdges[1] = fround(fround(fround(value0 + fround((length - 1) * slope)) + fround(coeff6 * fround(pow6(dx) - 1))) + fround(fround(coeff2 * tail) * tail));
    }
    return correctedEdges;
  }

  /* lineSlideParabola without the edge estimate, for the lines of the four passes. Same arithmetic, same result, faster:
   * the candidate touch points that nextPoint links (the points of non-positive curvature) are also kept as two
   * dense arrays, P (positions, P[0] = 0, last = length - 1, then INT_MAX) and V (their values), so the search of one
   * touch point reads them in order instead of chasing nextPoint[j] and gathering cache[j]. For a candidate after
   * touch point i1 the distance d = j - i1 is always >= 1 here, so the d <= 0 case of slideFrom cannot occur; the
   * one way a touch point leaves the list (no slope below FLOAT_MAX: NaN / infinite data, the `i2 <= i1` fallback
   * of ImageJ, which then reads whatever nextPoint holds) is handed to slideFrom with nextPoint, cache and pixels in
   * exactly the state the reference loop would have. nextPoint is still written for that. */
  function slideFast(pixels, start, inc, length, coeff2, cache, nextPoint, P, V) {
    let minValue = FLOAT_MAX;
    let lastpoint = 0;
    let vPrevious1 = 0;
    let vPrevious2 = 0;
    let n = 0; // last used index of P / V
    const curvatureTest = fround(fround(1.999) * coeff2);
    const tabs = slopeTables(coeff2, length);
    const invTab = tabs.inv, crTab = tabs.cr;
    // Whether a point is a candidate is data dependent and close to a coin toss on noisy images, so a branch on it is
    // mispredicted about every other point (measured: 7.5 vs 4.3 ns per pixel). The entries are written
    // unconditionally and only the counters move, by the 0/1 of the comparison. The write to nextPoint[lastpoint] for a
    // point that is not a candidate is overwritten by the next candidate or by the end of the line, so nextPoint ends
    // up exactly as in ImageJ's loop.
    {
      let v = pixels[start];
      cache[0] = v;
      if (v < minValue) minValue = v;
      vPrevious1 = v;
      v = pixels[start + inc];
      cache[1] = v;
      if (v < minValue) minValue = v;
      vPrevious2 = vPrevious1;
      vPrevious1 = v;
    }
    for (let i = 2, p = start + 2 * inc; i < length; i++, p += inc) {
      const v = pixels[p];
      cache[i] = v;
      if (v < minValue) minValue = v;
      const c = (fround(fround(fround(vPrevious1 + vPrevious1) - vPrevious2) - v) < curvatureTest) | 0;
      nextPoint[lastpoint] = i - 1;
      P[n + 1] = i - 1; V[n + 1] = vPrevious1;
      n += c;
      lastpoint += c * (i - 1 - lastpoint);
      vPrevious2 = vPrevious1;
      vPrevious1 = v;
    }
    nextPoint[lastpoint] = length - 1;
    nextPoint[length - 1] = INT_MAX;
    P[0] = 0; V[0] = cache[0];
    n++; P[n] = length - 1; V[n] = cache[length - 1];
    P[n + 1] = INT_MAX;
    // A subnormal quotient has a fixed grid on which x / d can be an exact midpoint (x = 2^-149 M, d even), and the
    // product by 1 / d would then decide the tie differently from the division. A difference of two floats is below 1e-30
    // (a quotient below 2^-126) without being zero only when the smaller of them is below ~1e-23, so a line holding a
    // candidate of magnitude in (0, 1e-20) is left to the division loop of ImageJ (never met in image data).
    for (let m = 0; m <= n; m++) {
      const x = V[m];
      if (x !== 0 && x < 1e-20 && x > -1e-20) {
        lineSlideParabola(pixels, start, inc, length, coeff2, cache, nextPoint, null);
        return;
      }
    }

    let i1 = 0, m0 = 0;
    while (i1 < length - 1) {
      const v1 = V[m0];
      let minSlope = FLOAT_MAX;
      let i2 = 0, mBest = 0;
      let searchTo = length;
      let recalculateLimitNow = 0;
      for (let m = m0 + 1, j = P[m]; j < searchTo; j = P[++m], recalculateLimitNow++) {
        const v2 = V[m];
        const d = j - i1;
        const diff = v2 - v1;
        // ImageJ's float arithmetic: (float)((float)(v2 - v1) / d) + (float)(coeff2 * d); crTab[d] is the second term, d >= 1.
        // The float quotient of a float x by an integer d < 2^23 is fround(x * (1 / d)) with 1 / d in double (a division
        // is several times slower and sits on the critical path of every visit): x / d lies exactly on a midpoint between
        // two floats only if x had 25 significant bits, which a float has not; off a midpoint it is at least 2^-25/d
        // (relative, so 2^-48 for d < 2^23) from one while the product errs by about 2^-52. That holds for a normal result (the lines that could
        // produce a subnormal one never get here, see the 1e-20 scan above).
        const slope = fround(fround(fround(diff) * invTab[d]) + crTab[d]);
        if (slope < minSlope) {
          minSlope = slope;
          i2 = j; mBest = m;
          recalculateLimitNow = -3;
        }
        if (recalculateLimitNow === 0) { // search limit: recalculated a little after the slope improved
          const b = fround(fround(0.5 * minSlope) / coeff2);
          const maxSearch = (i1 + d2i(b + m_sqrt(b * b + fround(fround(v1 - minValue) / coeff2)) + 1)) | 0;
          if (maxSearch < searchTo && maxSearch > 0) searchTo = maxSearch;
        }
      }
      if (i2 <= i1) { // ImageJ: i2 = i1 + 1 and the loop goes on over whatever nextPoint says
        slideFrom(pixels, start, inc, length, coeff2, cache, nextPoint, i1 + 1, tabs, minValue);
        return;
      }
      for (let j = i1 + 1, p = start + j * inc; j < i2; j++, p += inc) {
        pixels[p] = fround(v1 + fround((j - i1) * fround(minSlope - fround((j - i1) * coeff2))));
      }
      i1 = i2; m0 = mBest;
    }
  }

  /* BackgroundSubtracter.correctCorners: detect corner particles and lower the corner pixels when one is there,
   * averaging the correction values of the three directions through each corner. */
  function correctCorners(pixels, width, height, coeff2, cache, nextPoint) {
    const corners = new Float32Array(4); // (0,0); (xmax,0); (ymax,0); (xmax,ymax)
    const ce = new Float32Array(2);
    lineSlideParabola(pixels, 0, 1, width, coeff2, cache, nextPoint, ce);
    corners[0] = ce[0]; corners[1] = ce[1];
    lineSlideParabola(pixels, (height - 1) * width, 1, width, coeff2, cache, nextPoint, ce);
    corners[2] = ce[0]; corners[3] = ce[1];
    lineSlideParabola(pixels, 0, width, height, coeff2, cache, nextPoint, ce);
    corners[0] += ce[0]; corners[2] += ce[1];
    lineSlideParabola(pixels, width - 1, width, height, coeff2, cache, nextPoint, ce);
    corners[1] += ce[0]; corners[3] += ce[1];
    const diagLength = m_min(width, height); // length of a 45-degree line from a corner
    const coeff2diag = fround(2 * coeff2);
    lineSlideParabola(pixels, 0, 1 + width, diagLength, coeff2diag, cache, nextPoint, ce);
    corners[0] += ce[0];
    lineSlideParabola(pixels, width - 1, -1 + width, diagLength, coeff2diag, cache, nextPoint, ce);
    corners[1] += ce[0];
    lineSlideParabola(pixels, (height - 1) * width, 1 - width, diagLength, coeff2diag, cache, nextPoint, ce);
    corners[2] += ce[0];
    lineSlideParabola(pixels, width * height - 1, -1 - width, diagLength, coeff2diag, cache, nextPoint, ce);
    corners[3] += ce[0];
    const c0 = fround(corners[0] / 3), c1 = fround(corners[1] / 3), c2 = fround(corners[2] / 3), c3 = fround(corners[3] / 3);
    if (pixels[0] > c0) pixels[0] = c0;
    if (pixels[width - 1] > c1) pixels[width - 1] = c1;
    if (pixels[(height - 1) * width] > c2) pixels[(height - 1) * width] = c2;
    if (pixels[width * height - 1] > c3) pixels[width * height - 1] = c3;
  }

  /* BackgroundSubtracter.filter1D: all the lines of one direction (diagonals: half the image per call). */
  async function filter1D(pixels, width, height, direction, coeff2, cache, nextPoint, P, V, hooks, f0, f1) {
    let startLine = 0, nLines = 0, lineInc = 0, pointInc = 0, length = 0;
    switch (direction) {
      case X_DIRECTION: nLines = height; lineInc = width; pointInc = 1; length = width; break;
      case Y_DIRECTION: nLines = width; lineInc = 1; pointInc = width; length = height; break;
      case DIAGONAL_1A: nLines = width - 2; lineInc = 1; pointInc = width + 1; break; // the algorithm makes no sense for lines shorter than 3 pixels
      case DIAGONAL_1B: startLine = 1; nLines = height - 2; lineInc = width; pointInc = width + 1; break;
      case DIAGONAL_2A: startLine = 2; nLines = width; lineInc = 1; pointInc = width - 1; break;
      case DIAGONAL_2B: startLine = 0; nLines = height - 2; lineInc = width; pointInc = width - 1; break;
      default: break;
    }
    for (let i = startLine; i < nLines; i++) {
      if (i % yieldEvery === 0) { hooks.check(); await hooks.tick(f0 + (f1 - f0) * (i / nLines)); }
      let startPixel = i * lineInc;
      if (direction === DIAGONAL_2B) startPixel += width - 1;
      switch (direction) {
        case DIAGONAL_1A: length = m_min(height, width - i); break;
        case DIAGONAL_1B: length = m_min(width, height - i); break;
        case DIAGONAL_2A: length = m_min(height, i + 1); break;
        case DIAGONAL_2B: length = m_min(width, height - i); break;
        default: break;
      }
      if (length >= 4) slideFast(pixels, startPixel, pointInc, length, coeff2, cache, nextPoint, P, V);
      else lineSlideParabola(pixels, startPixel, pointInc, length, coeff2, cache, nextPoint, null);
    }
  }

  /* BackgroundSubtracter.slidingParaboloidFloatBackground: `pixels` becomes the background. */
  async function slidingParaboloidFloatBackground(pixels, width, height, radius, invert, doPresmooth, doCorners, hooks) {
    const cache = new Float32Array(m_max(width, height));
    const nextPoint = new Int32Array(m_max(width, height));
    const P = new Int32Array(m_max(width, height) + 2), V = new Float64Array(m_max(width, height) + 1);
    const coeff2 = fround(0.5 / radius); // 2nd-order coefficient of the polynomial approximating the ball
    const coeff2diag = fround(1 / radius); // same for diagonal directions where step is sqrt2
    if (invert) for (let i = 0; i < pixels.length; i++) pixels[i] = -pixels[i];
    let shiftBy = 0;
    if (doPresmooth) {
      shiftBy = fround(filter3x3(pixels, width, height, true, hooks)); // 3x3 maximum to remove dust etc.
      await hooks.tick(0.05);
      filter3x3(pixels, width, height, false, hooks); // smoothing to remove noise
    }
    hooks.check();
    if (doCorners) correctCorners(pixels, width, height, coeff2, cache, nextPoint); // avoids subtracting corner particles
    // Slide the parabola over the image in different directions (diagonals last: faster)
    const passes = [[X_DIRECTION, coeff2], [Y_DIRECTION, coeff2], [X_DIRECTION, coeff2],
      [DIAGONAL_1A, coeff2diag], [DIAGONAL_1B, coeff2diag], [DIAGONAL_2A, coeff2diag], [DIAGONAL_2B, coeff2diag],
      [DIAGONAL_1A, coeff2diag], [DIAGONAL_1B, coeff2diag]];
    // Progress weight of a pass = its share of the pixels slid over: a row / column pass covers the whole image, a
    // diagonal half-pass about half of it.
    const weights = passes.map((q) => (q[0] === X_DIRECTION || q[0] === Y_DIRECTION ? 2 : 1));
    const totalWeight = weights.reduce((a, b) => a + b, 0);
    let done = 0;
    for (let k = 0; k < passes.length; k++) {
      const f0 = 0.1 + 0.9 * (done / totalWeight);
      done += weights[k];
      await filter1D(pixels, width, height, passes[k][0], passes[k][1], cache, nextPoint, P, V, hooks, f0, 0.1 + 0.9 * (done / totalWeight));
    }
    if (invert) for (let i = 0; i < pixels.length; i++) pixels[i] = -fround(pixels[i] - shiftBy);
    else if (doPresmooth) for (let i = 0; i < pixels.length; i++) pixels[i] = fround(pixels[i] - shiftBy); // correct for shift by 3x3 maximum
  }

  // ──────────────────────────── Subtract Background: one channel ────────────────────────────

  /* The background of one channel (Float32Array, same size).
   *   opts { radius, invert, presmooth, sliding, correctCorners } — `invert` is the already combined
   *   (invertedLut && !light) || (!invertedLut && light) of rollingBallBackground. */
  async function background(data, width, height, opts, hooks) {
    const h = hooks || noHooks;
    const fp = new Float32Array(data.length);
    fp.set(data); // ip.toFloat(): exact for 8 and 16 bits, a copy for 32
    if (opts.sliding) await slidingParaboloidFloatBackground(fp, width, height, fround(opts.radius), !!opts.invert, !!opts.presmooth, opts.correctCorners !== false, h);
    else {
      const ball = buildBall(opts.radius);
      if (ball.shrinkFactor > 1) {
        const sw = m_trunc((width + ball.shrinkFactor - 1) / ball.shrinkFactor), sh = m_trunc((height + ball.shrinkFactor - 1) / ball.shrinkFactor);
        // enlargeImage reads sPixels[xSmallIndices[x]] with index -1 only when the shrunken width is 1 (ArrayIndexOutOfBounds);
        // a shrunken height of 1 leaves line0 at zero and ImageJ returns a result: reproduced.
        if (sw < 2) throw fail('IJ_BG_TOO_SMALL', 'image too small for this radius');
      }
      await rollingBallFloatBackground(fp, width, height, !!opts.invert, !!opts.presmooth, ball, h);
    }
    return fp;
  }

  /* The subtracted (or, with `create`, the background) image of the rectangle `rect`, typed like `data`.
   *   ShortProcessor: offset = invert ? 65535.5f : 0.5f; value = (pixels[p]&0xffff) - bgPixels[p] + offset;
   *                   if (value<0f) value = 0f; if (value>65535f) value = 65535f; pixels[p] = (short)(value);
   *   ByteProcessor:  same with 255.5f / 255f.   FloatProcessor: bgPixels[p] = snapshotPixels[p]-bgPixels[p].
   *   create: ip.setPixels(channel, fp) = (value = fp + 0.5f, clamped, truncated) for 8 / 16 bits, the float as is. */
  function render(data, bg, bitDepth, invert, create, width, rect) {
    const rw = rect.w, rh = rect.h;
    const out = bitDepth === 8 ? new Uint8Array(rw * rh) : bitDepth === 16 ? new Uint16Array(rw * rh) : new Float32Array(rw * rh);
    const top = bitDepth === 8 ? 255 : 65535;
    const offset = invert ? top + 0.5 : 0.5;
    for (let y = 0; y < rh; y++) {
      let p = (rect.y + y) * width + rect.x;
      const o = y * rw;
      if (bitDepth === 32) {
        if (create) for (let x = 0; x < rw; x++, p++) out[o + x] = bg[p];
        else for (let x = 0; x < rw; x++, p++) out[o + x] = data[p] - bg[p]; // Float32Array store = (float)
      } else if (create) {
        for (let x = 0; x < rw; x++, p++) {
          let value = fround(bg[p] + 0.5);
          if (value < 0) value = 0;
          if (value > top) value = top;
          out[o + x] = m_trunc(value);
        }
      } else {
        for (let x = 0; x < rw; x++, p++) {
          let value = fround(fround(data[p] - bg[p]) + offset);
          if (value < 0) value = 0;
          if (value > top) value = top;
          out[o + x] = m_trunc(value);
        }
      }
    }
    return out;
  }

  // ──────────────────────────── Enhance Contrast ────────────────────────────

  /* The statistics ContrastEnhancer.stretchHistogram reads: ImageStatistics.getStatistics(ip, MIN_MAX, null) of the
   * processor whose roi is `rect` and whose mask is `maskBox` (a box { x, y, w, h, data } of 0 / non-0 inside the
   * image, or null = the whole rectangle).
   *   8-bit  ByteStatistics:  histogram = ip.getHistogram() (256 bins), histMin 0, binSize 1.
   *   16-bit ShortStatistics: histogram16 = the 65536-bin histogram, which stretchHistogram uses for ShortProcessors.
   *   32-bit FloatStatistics: 256 bins over the min..max of the selection; a value outside
   *          [-Float.MAX_VALUE, Float.MAX_VALUE] (±Infinity) or a NaN is neither counted nor binned. */
  async function statistics(data, width, bitDepth, rect, maskBox, io) {
    const hooks = io || noHooks;
    const inMask = (x, y) => !maskBox || (x >= maskBox.x && x < maskBox.x + maskBox.w && y >= maskBox.y && y < maskBox.y + maskBox.h && maskBox.data[(y - maskBox.y) * maskBox.w + (x - maskBox.x)] !== 0);
    const x1 = rect.x + rect.w, y1 = rect.y + rect.h;
    if (bitDepth === 8 || bitDepth === 16) {
      const hist = new Int32Array(bitDepth === 8 ? 256 : 65536);
      let pixelCount = 0;
      for (let y = rect.y; y < y1; y++) {
        if ((y & 255) === 0) { hooks.check(); await hooks.tick((y - rect.y) / rect.h); }
        const row = y * width;
        if (!maskBox) for (let x = rect.x; x < x1; x++) { hist[data[row + x]]++; pixelCount++; }
        else for (let x = rect.x; x < x1; x++) if (inMask(x, y)) { hist[data[row + x]]++; pixelCount++; }
      }
      return { bitDepth, pixelCount, histogram: hist, hist16: bitDepth === 16 ? hist : null, histMin: 0, binSize: 1 };
    }
    // FloatStatistics.getStatistics
    let roiMin = FLOAT_MAX, roiMax = -FLOAT_MAX;
    for (let y = rect.y; y < y1; y++) {
      if ((y & 255) === 0) { hooks.check(); await hooks.tick(0.5 * (y - rect.y) / rect.h); }
      const row = y * width;
      for (let x = rect.x; x < x1; x++) {
        if (!inMask(x, y)) continue;
        const v = data[row + x];
        if (v >= -FLOAT_MAX && v <= FLOAT_MAX) { if (v < roiMin) roiMin = v; if (v > roiMax) roiMax = v; }
      }
    }
    const nBins = 256;
    const histMin = roiMin, histMax = roiMax; // histMin == 0 && histMax == 0 (ip.getHistogramMin/Max) → the min and max of the selection
    const binSize = (histMax - histMin) / nBins;
    const scale = nBins / (histMax - histMin);
    const histogram = new Int32Array(nBins);
    let pixelCount = 0;
    for (let y = rect.y; y < y1; y++) {
      if ((y & 255) === 0) { hooks.check(); await hooks.tick(0.5 + 0.5 * (y - rect.y) / rect.h); }
      const row = y * width;
      for (let x = rect.x; x < x1; x++) {
        if (!inMask(x, y)) continue;
        const v = data[row + x];
        if (v >= -FLOAT_MAX && v <= FLOAT_MAX && v >= histMin && v <= histMax) {
          pixelCount++;
          let index = d2i(scale * (v - histMin));
          if (index >= nBins) index = nBins - 1;
          histogram[index]++;
        }
      }
    }
    return { bitDepth, pixelCount, histogram, hist16: null, histMin, binSize };
  }

  /* ContrastEnhancer.getMinAndMax: the saturated pixels are split half per tail (saturated/200):
   *   threshold = (int)(stats.pixelCount*saturated/200.0)   (0 when saturated is 0)
   * and hmin / hmax are the first / last bins at which the running count exceeds it. */
  function saturatedBins(stats, saturated) {
    const histogram = stats.hist16 || stats.histogram;
    const hsize = histogram.length;
    const threshold = saturated > 0 ? d2i(stats.pixelCount * saturated / 200.0) : 0;
    let i = -1, count = 0, found = false;
    const maxindex = hsize - 1;
    do { i++; count += histogram[i]; found = count > threshold; } while (!found && i < maxindex);
    const hmin = i;
    i = hsize; count = 0;
    do { i--; count += histogram[i]; found = count > threshold; } while (!found && i > 0);
    return { hmin, hmax: i };
  }

  /* ContrastEnhancer.stretchHistogram(ip, saturated, stats): the range the display (or Normalize) gets.
   *   min = stats.histMin+hmin*stats.binSize, max = stats.histMin+hmax*stats.binSize (hmin / hmax themselves for a
   *   ShortProcessor). Nothing happens unless hmax > hmin. The display range ImageJ then holds is
   *   setMinAndMax(min, max): (int)Math.round on 8 / 16 bits, (float) on 32. */
  function rangeOf(stats, saturated) {
    const { hmin, hmax } = saturatedBins(stats, saturated);
    if (!(hmax > hmin)) return { valid: false, pixelCount: stats.pixelCount };
    let min = stats.histMin + hmin * stats.binSize;
    let max = stats.histMin + hmax * stats.binSize;
    if (stats.hist16) { min = hmin; max = hmax; }
    const rounded = (v) => (stats.bitDepth === 32 ? fround(v) : m_floor(v + 0.5));
    return { valid: true, min, max, displayMin: rounded(min), displayMax: rounded(max), pixelCount: stats.pixelCount };
  }

  /* ContrastEnhancer.normalize: the lookup table of an 8 / 16-bit image.
   *   if (i<=min) lut[i] = 0; else if (i>=max) lut[i] = max2; else lut[i] = (int)(((double)(i-min)/(max-min))*max2); */
  function normalizeTable(bitDepth, min, max) {
    const max2 = bitDepth === 16 ? 65535 : 255;
    const range = bitDepth === 16 ? 65536 : 256;
    const lut = bitDepth === 16 ? new Uint16Array(range) : new Uint8Array(range);
    for (let i = 0; i < range; i++) {
      if (i <= min) lut[i] = 0;
      else if (i >= max) lut[i] = max2;
      else lut[i] = m_trunc(((i - min) / (max - min)) * max2);
    }
    return lut;
  }

  /* ContrastEnhancer.normalizeFloat: v = pixels[i] - min; if (v<0.0) v = 0.0; v *= scale; if (v>1.0) v = 1.0 (in double). */
  function normalizeFloat(src, min, max) {
    const scale = max > min ? 1.0 / (max - min) : 1.0;
    const out = new Float32Array(src.length);
    for (let i = 0; i < src.length; i++) {
      let v = src[i] - min;
      if (v < 0.0) v = 0.0;
      v *= scale;
      if (v > 1.0) v = 1.0;
      out[i] = v;
    }
    return out;
  }

  /* ContrastEnhancer.equalize(ip, histogram): the weights are sqrt(h) (h itself when h < 2 or `classic`, the Alt key).
   *   sum = w(0); for (i=1; i<max; i++) sum += 2*w(i); sum += w(max); scale = range/sum;
   *   lut[0] = 0; sum = w(0); for (i=1; i<max; i++) { delta = w(i); sum += delta; lut[i] = (int)Math.round(sum*scale); sum += delta; } lut[max] = max */
  function equalizeTable(histogram, bitDepth, classic) {
    const max = bitDepth === 16 ? 65535 : 255;
    const range = max;
    const w = (i) => { const h = histogram[i]; return (h < 2 || classic) ? h : m_sqrt(h); };
    let sum = w(0);
    for (let i = 1; i < max; i++) sum += 2 * w(i);
    sum += w(max);
    const scale = range / sum;
    const lut = bitDepth === 16 ? new Uint16Array(range + 1) : new Uint8Array(range + 1);
    lut[0] = 0;
    sum = w(0);
    for (let i = 1; i < max; i++) {
      const delta = w(i);
      sum += delta;
      lut[i] = m_floor(sum * scale + 0.5); // (int)Math.round
      sum += delta;
    }
    lut[max] = max;
    return lut;
  }

  /* ip.getHistogram() of the rectangle (ImagePlus.getProcessor() hands equalize() the selection's BOUNDING RECTANGLE:
   * `if (roi!=null && roi.isArea()) ip.setRoi(roi.getBounds())` — the mask is not used). */
  function rectHistogram(data, width, bitDepth, rect) {
    const hist = new Int32Array(bitDepth === 16 ? 65536 : 256);
    const x1 = rect.x + rect.w, y1 = rect.y + rect.h;
    for (let y = rect.y; y < y1; y++) { const row = y * width; for (let x = rect.x; x < x1; x++) hist[data[row + x]]++; }
    return hist;
  }

  function applyTable(src, lut) {
    const out = new src.constructor(src.length);
    for (let i = 0; i < src.length; i++) out[i] = lut[src[i]];
    return out;
  }

  const IJBg = {
    shrinkFactorOf, buildBall, filter3x3, shrinkImage, rollBall, enlargeImage, lineSlideParabola, background, render,
    statistics, saturatedBins, rangeOf, normalizeTable, normalizeFloat, equalizeTable, rectHistogram, applyTable, d2i
  };
  root.IJBg = IJBg;

  // ──────────────────────────── operations ────────────────────────────

  const Reg = root.IJOpRegistry;
  if (!Reg) return;
  const define = (name, spec) => Reg.define(name, spec); // a name another package took throws IJ_BAD_ARGS
  const isNum = (v) => typeof v === 'number' && isFinite(v);
  const bytesOf = (bd) => bd / 8;

  define('subtractBackground', {
    kind: 'pixel', version: 1, stack: 'ask', rgb: 'each', channels: 'each', roi: 'ignore', preview: 'reduced', display: true,
    validate(p, info) {
      if (!isNum(p.radius) || !(p.radius > 0.0001) || p.radius > 10000) throw fail('IJ_BAD_ARGS', 'radius');
      for (const k of ['light', 'createBackground', 'sliding', 'disableSmoothing']) if (p[k] !== undefined && typeof p[k] !== 'boolean') throw fail('IJ_BAD_ARGS', k);
      if (p.correctCorners !== undefined && typeof p.correctCorners !== 'boolean') throw fail('IJ_BAD_ARGS', 'correctCorners');
      if (!p.sliding && info && shrinkFactorOf(p.radius) > 1) {
        const s = shrinkFactorOf(p.radius);
        if (m_trunc((info.width + s - 1) / s) < 2) throw fail('IJ_BG_TOO_SMALL', 'image too small for this radius');
      }
    },
    // Whether a channel shows with an inverting LUT is display state, not journaled: copied into the params.
    resolve(view, params, chans) {
      const p = Object.assign({}, params);
      const inv = Object.assign({}, p.invertedLut);
      for (const c of chans) if (inv[c] === undefined) inv[c] = !!(view.channels[c] && view.channels[c].display && view.channels[c].display.invert);
      p.invertedLut = inv;
      return p;
    },
    // the float working copy, the source crop the engine hands a whole op is not made (region form), the result
    scratchBytes(info, params) {
      const n = info.width * info.height;
      const s = params && !params.sliding ? shrinkFactorOf(params.radius) : 1;
      // the shrunken copies exist only when the image is shrunk (radius > 10): small + its background;
      // the paraboloid keeps a line cache + nextPoint (two arrays of the longer side)
      const small = s > 1 ? (n / (s * s)) * 4 * 2 : 0;
      // line cache + nextPoint (4 + 4 B), the candidate lists P / V (4 + 8 B) and the slope tables (inv, ct, cr: 3 x 8 B, up to doubled by the growth rule of slopeTables)
      const lines = params && params.sliding ? m_max(info.width, info.height) * (8 + 12 + 48) : 0;
      // rolling ball: line cache (sw * bw) and z ring ((sw + 2r) * bw) of the shrunken image, bw = 2r + 1 (upper bound)
      let ring = 0;
      if (params && !params.sliding) {
        const sw = Math.ceil(info.width / s), br = Math.ceil(params.radius / s), bwid = 2 * br + 1;
        ring = (sw + (sw + 2 * br)) * bwid * 4;
      }
      return n * 4 + n * bytesOf(info.bitDepth) + small + lines + ring + 4 * 1048576;
    },
    prepare(view, c, p, ctx) {
      const scale = (ctx && ctx.scale) || 1;
      const hooks = ctx ? { tick: (f) => ctx.tick(f, 'op.subtractBackground'), check: () => ctx.check() } : noHooks;
      // invertedLut = ip.isInvertedLut(); invert = (invertedLut && !lightBackground) || (!invertedLut && lightBackground)
      const invertedLut = !!(p.invertedLut && p.invertedLut[c]);
      const invert = (invertedLut && !p.light) || (!invertedLut && !!p.light);
      const bd = view.bitDepth;
      return {
        // A background depends on the whole image (the paraboloid slides along whole lines): a preview computes
        // it over the whole image at the level where that fits (ij-engine climbs levels for a 'reduced' op).
        apron: { x: view.width, y: view.height },
        whole: true,
        async region(full, rect) {
          const bg = await background(full.data, full.width, full.height, {
            radius: p.radius / scale, invert, presmooth: !p.disableSmoothing, sliding: !!p.sliding, correctCorners: p.correctCorners !== false
          }, hooks);
          return render(full.data, bg, bd, invert, !!p.createBackground, full.width, rect);
        }
      };
    }
  });

  define('saturatedRange', {
    kind: 'compute', version: 1, stack: 'plane', rgb: 'gray', channels: 'one',
    validate(p) {
      if (!isNum(p.saturated) || p.saturated < 0 || p.saturated > 100) throw fail('IJ_BAD_ARGS', 'saturated');
    },
    scratchBytes(info) {
      // histogram + the selection's mask box (up to the bounding rectangle, a byte per pixel)
      const r = info && info.roi;
      let box = 0;
      if (r) { try { const b = root.IJRoi.bounds(r); box = m_min(info.width, m_max(0, b.w)) * m_min(info.height, m_max(0, b.h)); } catch (e) { box = info.width * info.height; } }
      return 65536 * 4 + box + 1048576;
    },
    async run(view, params, roi, io) {
      const c = Number.isInteger(io.channel) ? io.channel : (view.active || 0);
      if (!(c >= 0 && c < view.channels.length)) throw fail('IJ_BAD_ARGS', 'channel');
      const W = view.width, H = view.height;
      let rect = { x: 0, y: 0, w: W, h: H }, maskBox = null;
      if (roi) {
        // ImageProcessor.setRoi(Roi): "setMask(roi.getMask()); setRoi(roi.getBounds());"
        const IJRoi = io.dep('IJRoi');
        if (IJRoi.isArea(roi)) { maskBox = io.roiMask(roi); rect = { x: maskBox.x, y: maskBox.y, w: maskBox.w, h: maskBox.h }; }
        else {
          let b;
          if (roi.type === 'line') {
            // Roi.setIntBounds of a line: x = floor(bx+0.5); width = floor(bx+bw+1.5) - x (both axes)
            const bx = m_min(roi.x1, roi.x2), by = m_min(roi.y1, roi.y2);
            const bw = Math.abs(roi.x2 - roi.x1), bh = Math.abs(roi.y2 - roi.y1);
            const x = m_floor(bx + 0.5), y = m_floor(by + 0.5);
            b = { x, y, w: m_floor(bx + bw + 1.5) - x, h: m_floor(by + bh + 1.5) - y };
          } else b = IJRoi.bounds(roi);
          const x0 = m_max(0, b.x), y0 = m_max(0, b.y), x1 = m_min(W, b.x + b.w), y1 = m_min(H, b.y + b.h);
          if (!(x1 > x0 && y1 > y0)) return { valid: false, pixelCount: 0, bitDepth: view.bitDepth }; // empty roi: nothing counted
          rect = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
          if (roi.type === 'point') {
            // PointRoi.getMask: only the pixels of the points
            const data = new Uint8Array(rect.w * rect.h);
            for (const p of roi.points) {
              const i = m_floor(p[0]) - rect.x, j = m_floor(p[1]) - rect.y;
              if (i >= 0 && j >= 0 && i < rect.w && j < rect.h) data[j * rect.w + i] = 1;
            }
            maskBox = { x: rect.x, y: rect.y, w: rect.w, h: rect.h, data };
          } else if ((roi.type === 'polyline' || roi.type === 'angle') && roi.points.length >= 3) {
            // PolygonRoi.getMask fills the polygon of its vertices
            maskBox = io.roiMask({ type: 'polygon', points: roi.points });
            rect = { x: maskBox.x, y: maskBox.y, w: maskBox.w, h: maskBox.h };
          }
        }
      }
      const stats = await statistics(view.channels[c].data, W, view.bitDepth, rect, maskBox, { check: () => io.check(), tick: (f) => io.tick(f, 'op.saturatedRange') });
      const r = rangeOf(stats, params.saturated);
      r.bitDepth = view.bitDepth;
      return r;
    }
  });

  define('enhanceNormalize', {
    kind: 'pixel', version: 1, stack: 'ask', rgb: 'each', channels: 'one', roi: 'mask', preview: false, display: true,
    validate(p) {
      if (!isNum(p.min) || !isNum(p.max) || !(p.max > p.min)) throw fail('IJ_BAD_ARGS', 'range');
    },
    scratchBytes(info) { return info.bitDepth === 32 ? 0 : (info.bitDepth === 16 ? 131072 : 256); },
    prepare(view, c, p) {
      const bd = view.bitDepth;
      if (bd === 32) return { apron: { x: 0, y: 0 }, fn: (src) => normalizeFloat(src.data, p.min, p.max) };
      // An RGB image (ContrastEnhancer.normalize → ColorProcessor.setMinAndMax): "v = i-(int)min; v = (int)(256.0*v/(max-min)); clamp 0..255" on each colour
      // (rewrites the pixels; measured on tests/fixtures/ij-stacks/rgb/filter_enhance), not the table of the grey types.
      let lut = null;
      if (view.rgb) {
        lut = new Uint8Array(256);
        const mn = m_trunc(p.min);
        for (let i = 0; i < 256; i++) { let v = m_trunc(256.0 * (i - mn) / (p.max - p.min)); if (v < 0) v = 0; if (v > 255) v = 255; lut[i] = v; }
      } else lut = normalizeTable(bd, p.min, p.max);
      return { apron: { x: 0, y: 0 }, fn: (src) => applyTable(src.data, lut) };
    }
  });

  define('enhanceEqualize', {
    kind: 'pixel', version: 1, stack: 'ask', rgb: 'each', channels: 'one', roi: 'ignore', preview: false, display: true, bitDepths: [8, 16],
    validate(p, info) {
      if (p.classic !== undefined && typeof p.classic !== 'boolean') throw fail('IJ_BAD_ARGS', 'classic');
      if (p.rect !== undefined && p.rect !== null) {
        const r = p.rect;
        if (!r || !Number.isInteger(r.x) || !Number.isInteger(r.y) || !Number.isInteger(r.w) || !Number.isInteger(r.h) || r.w < 1 || r.h < 1 ||
          r.x < 0 || r.y < 0 || (info && (r.x + r.w > info.width || r.y + r.h > info.height))) throw fail('IJ_BAD_ARGS', 'rect');
      }
    },
    scratchBytes(info) { return info.bitDepth === 16 ? 262144 + 131072 : 4096; },
    prepare(view, c, p) {
      const bd = view.bitDepth;
      const rect = p.rect || { x: 0, y: 0, w: view.width, h: view.height };
      const hist = rectHistogram(view.channels[c].data, view.width, bd, rect);
      const lut = equalizeTable(hist, bd, !!p.classic);
      return { apron: { x: 0, y: 0 }, fn: (src) => applyTable(src.data, lut) };
    }
  });
})(typeof self !== 'undefined' ? self : globalThis);
