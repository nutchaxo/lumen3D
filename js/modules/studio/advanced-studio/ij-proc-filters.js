/* ij-proc-filters.js — package P2 (filters): 3x3 filters, Unsharp Mask, Convolve, Variance / Remove Outliers /
 * Remove NaNs / Top Hat, the Process > Math operations and NaN Background.
 *
 * Classic script, page AND worker (ij-worker.js loads it in its own try/catch: a failure here disables the
 * package's commands, it never takes the Advanced view down). Pure: no DOM, no engine globals besides the
 * registry and the modules loaded before it (IJFilters, IJShared). Every operation is a pixel spec of
 * IJOpRegistry (ij-core.js, PLAN-wave2 §2.1); the engine commits what `region` / `fn` return and never lets
 * an op write into its input arrays.
 *
 *   filter3x3    type smooth | sharpen | edges        ByteProcessor / ShortProcessor / FloatProcessor.filter3x3
 *   unsharpMask  sigma, weight                        ij.plugin.filter.UnsharpMask.sharpenFloat
 *   convolve     kernel, kw, kh, normalize            ij.plugin.filter.Convolver.convolveFloat
 *   rankExtra    type variance | outliersBright | outliersDark, radius, threshold    RankFilters (VARIANCE / OUTLIERS)
 *   topHat       radius, light, dontSubtract          RankFilters TOP_HAT (min then max, apron 2r)
 *   removeNaNs   radius                               RankFilters REMOVE_NAN
 *   math2        op log exp sqr sqrt reciprocal gamma and or xor, value      ImageMath → ImageProcessor.process
 *   nanBackground lower, upper                        ImageMath.setBackgroundToNaN
 * Despeckle is the v1 `rank` op (median, radius 1).
 *
 * Java float semantics: ImageJ accumulates in `float` almost everywhere here, so every float operation of a port
 * is rounded with Math.fround exactly where the Java expression rounds. The sources are ImageJ 1.54p
 * (public domain); each port cites its Class.method and quotes the lines that settle a trap.
 */
(function (root) {
  'use strict';

  const REG = root.IJOpRegistry;
  if (!REG) throw new Error('ij-proc-filters: IJOpRegistry is missing');
  const fround = Math.fround;
  const FLT_MAX = 3.4028234663852886e38; // Float.MAX_VALUE
  // A band of a large-apron op recomputes 2 x apron rows: past this apron the op takes its whole region in one band.
  const WHOLE_APRON = 16;
  const MAX_BAND = 4194304;              // the engine's largest band (pixels); only used to size scratchBytes

  function fail(code, message) {
    const e = new Error(message || code);
    e.code = code;
    return e;
  }
  const bad = (msg) => fail('IJ_BAD_ARGS', msg);
  const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
  const clampI = (v, lo, hi) => (v < lo ? lo : (v > hi ? hi : v));

  /* Java's (int) cast of a double: NaN → 0, saturating at the int range, truncating toward zero. */
  function jint(d) {
    if (d !== d) return 0;
    if (d >= 2147483647) return 2147483647;
    if (d <= -2147483648) return -2147483648;
    return d < 0 ? Math.ceil(d) : Math.floor(d);
  }
  /* Java's Math.round(double) → long (the display range of a ShortProcessor is rounded with it). */
  const jround = (d) => Math.floor(d + 0.5);

  const typedFor = (bd, n) => (bd === 8 ? new Uint8Array(n) : (bd === 16 ? new Uint16Array(n) : new Float32Array(n)));
  const nowMs = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());

  /* Float pixels back into the image type, as ByteProcessor / ShortProcessor.setPixels(channel, FloatProcessor):
   *   value = fPixels[i] + 0.5f; if (value<0f) value = 0f; if (value>255f) value = 255f; pixels[i] = (byte)value;
   * (65535f for 16 bits). The addition is a float addition; a NaN falls through both tests and (byte)NaN is 0. */
  function floatToType(f, bd) {
    if (bd === 32) return f;
    const n = f.length, maxV = bd === 8 ? 255 : 65535;
    const o = typedFor(bd, n);
    for (let i = 0; i < n; i++) {
      const t = fround(f[i] + 0.5);
      o[i] = t < 0 ? 0 : (t > maxV ? maxV : (t | 0));
    }
    return o;
  }

  /* Cooperative progress: tick(f) at most every ~40 ms, check() (cancel) otherwise. Never changes a result. */
  function ticker(ctx) {
    let last = nowMs();
    return async function (frac) {
      if (!ctx) return;
      const t = nowMs();
      if (t - last >= 40) { last = t; if (ctx.tick) await ctx.tick(Math.min(1, Math.max(0, frac))); } else if (ctx.check) ctx.check();
    };
  }

  // Scratch of a band-wise region op: a window (the band plus an apron) held a few times as 32-bit floats.
  function bandBytes(info, ax, ay, copies) {
    const reg = info.region || { w: info.width, h: info.height };
    const rows = Math.max(1, Math.min(reg.h, Math.floor(MAX_BAND / Math.max(1, reg.w))));
    const ww = Math.min(info.width + 2 * ax, reg.w + 2 * ax), wh = Math.min(info.height + 2 * ay, rows + 2 * ay);
    return ww * wh * 4 * copies;
  }

  // ----------------------------------------------------------------------------------------------------------
  // 3x3 filters: Process > Smooth / Sharpen / Find Edges
  // ----------------------------------------------------------------------------------------------------------
  /* ij.plugin.filter.Filters.run: ip.smooth() / ip.sharpen() / ip.findEdges(), and ImageProcessor:
   *     public void smooth()    { if (width>1) filter(BLUR_MORE); }
   *     public void sharpen()   { if (width>1) { int[] kernel = {-1,-1,-1, -1,12,-1, -1,-1,-1}; convolve3x3(kernel); } }
   *     public void findEdges() { if (width>1) filter(FIND_EDGES); }
   * so an image one pixel wide is left alone. The neighbourhood outside the image is the nearest edge pixel
   * (ByteProcessor.getEdgePixel; ShortProcessor / FloatProcessor.filter3x3 hold the pointer on the last column / row),
   * and pixels outside the selection RECTANGLE are read as they are (the filter reads the snapshot).
   * Deliberate deviation (ImageJ bug, not reproduced): ByteProcessor.filter, for a rectangle ending at W-2 / H-2, runs
   *     if (xMax==width-2) filterEdge(type, pixels2, roiHeight, roiX+roiWidth-1, roiY, 0, 1);  (and the row twin)
   * which writes column W-1 / row H-1, OUTSIDE the selection. Here only pixels inside the rectangle change, on every
   * bit depth (16/32-bit ImageJ already agree); test_ij_filters_cmds.mjs pins it.
   *
   * ByteProcessor.filter  BLUR_MORE:  sum = (p1+p2+p3+p4+p5+p6+p7+p8+p9+4)/9;
   *                       FIND_EDGES: sum1 = p1 + 2*p2 + p3 - p7 - 2*p8 - p9;  sum2 = p1  + 2*p4 + p7 - p3 - 2*p6 - p9;
   *                                   sum = (int)Math.sqrt(sum1*sum1 + sum2*sum2);  if (sum> 255) sum = 255;
   * ByteProcessor.convolve3x3 (scale = 12 - 8 = 4):   sum = (sum+scale/2)/scale;   //add scale/2 to round
   *                                                   if (sum>255) sum = 255;  if (sum<0) sum = 0;
   *   — Java int division truncates toward zero.
   * ShortProcessor.filter3x3 is the same on 0..65535 with double sums for FIND_EDGES:
   *     double result = Math.sqrt(sum1*sum1 + sum2*sum2);  if (result>65535.0) result = 65535.0;  pixels[p] = (short)result;
   * FloatProcessor.filter3x3 works in float: BLUR_MORE  pixels[p] = (v1+v2+...+v9)*0.11111111f;
   *     FIND_EDGES  float sum1 = v1 + 2*v2 + v3 - v7 - 2*v8 - v9; ... (float)Math.sqrt(sum1*sum1 + sum2*sum2);
   *     CONVOLVE    float sum = k1*v1 + k2*v2 + ... + k9*v9;  sum *= scale;  with scale = 1f/4f. */
  const F_NINTH = fround(0.11111111);

  /* `rgb`: the plane is one colour of a 24-bit image. ColorProcessor.sharpen() is not ByteProcessor's: convolve3x3 visits the INTERIOR only
   * (xMin..xMax, yMin..yMax: the border keeps its value) and divides by the kernel sum with Java's truncating int division, no +scale/2:
   *     sum = 12*p5 - (the other eight);  sum /= 4;  clamp to 0..255 (verified against ImageJ 1.54p, tests/fixtures/ij-stacks/rgb/filter_sharpen). */
  function filter3x3Region(full, rect, type, rgb) {
    const W = full.width, H = full.height, bd = full.bitDepth, s = full.data;
    const o = typedFor(bd, rect.w * rect.h);
    if (W <= 1) { // "if (width>1)": nothing happens on a one-pixel-wide image
      for (let y = 0; y < rect.h; y++) for (let x = 0; x < rect.w; x++) o[y * rect.w + x] = s[(rect.y + y) * W + rect.x + x];
      return o;
    }
    const xl = new Int32Array(rect.w), xr = new Int32Array(rect.w);
    for (let x = 0; x < rect.w; x++) { const gx = rect.x + x; xl[x] = gx > 0 ? gx - 1 : 0; xr[x] = gx < W - 1 ? gx + 1 : W - 1; }
    for (let y = 0; y < rect.h; y++) {
      const gy = rect.y + y;
      const r0 = (gy > 0 ? gy - 1 : 0) * W, r1 = gy * W, r2 = (gy < H - 1 ? gy + 1 : H - 1) * W;
      const ob = y * rect.w;
      for (let x = 0; x < rect.w; x++) {
        const gx = rect.x + x, a = xl[x], c = xr[x];
        const p1 = s[r0 + a], p2 = s[r0 + gx], p3 = s[r0 + c];
        const p4 = s[r1 + a], p5 = s[r1 + gx], p6 = s[r1 + c];
        const p7 = s[r2 + a], p8 = s[r2 + gx], p9 = s[r2 + c];
        let v;
        if (bd === 32) {
          if (type === 'smooth') {
            let t = fround(p1 + p2); t = fround(t + p3); t = fround(t + p4); t = fround(t + p5); t = fround(t + p6); t = fround(t + p7); t = fround(t + p8); t = fround(t + p9);
            v = fround(t * F_NINTH);
          } else if (type === 'edges') {
            let s1 = fround(p1 + fround(2 * p2)); s1 = fround(s1 + p3); s1 = fround(s1 - p7); s1 = fround(s1 - fround(2 * p8)); s1 = fround(s1 - p9);
            let s2 = fround(p1 + fround(2 * p4)); s2 = fround(s2 + p7); s2 = fround(s2 - p3); s2 = fround(s2 - fround(2 * p6)); s2 = fround(s2 - p9);
            v = fround(Math.sqrt(fround(fround(s1 * s1) + fround(s2 * s2))));
          } else {
            // k = {-1,-1,-1,-1,12,-1,-1,-1,-1}; each product and each partial sum is a float
            let t = fround(-p1); t = fround(t + (-p2)); t = fround(t + (-p3)); t = fround(t + (-p4)); t = fround(t + fround(12 * p5));
            t = fround(t + (-p6)); t = fround(t + (-p7)); t = fround(t + (-p8)); t = fround(t + (-p9));
            v = fround(t * 0.25);
          }
        } else if (rgb && type === 'sharpen') {
          if (gx === 0 || gx === W - 1 || gy === 0 || gy === H - 1) v = p5;
          else { v = Math.trunc((12 * p5 - p1 - p2 - p3 - p4 - p6 - p7 - p8 - p9) / 4); v = v > 255 ? 255 : (v < 0 ? 0 : v); }
        } else if (bd === 8) {
          if (type === 'smooth') v = Math.floor((p1 + p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9 + 4) / 9);
          else if (type === 'edges') {
            const s1 = p1 + 2 * p2 + p3 - p7 - 2 * p8 - p9, s2 = p1 + 2 * p4 + p7 - p3 - 2 * p6 - p9;
            v = Math.floor(Math.sqrt(s1 * s1 + s2 * s2));
            if (v > 255) v = 255;
          } else {
            v = Math.trunc((12 * p5 - p1 - p2 - p3 - p4 - p6 - p7 - p8 - p9 + 2) / 4);
            v = v > 255 ? 255 : (v < 0 ? 0 : v);
          }
        } else {
          if (type === 'smooth') v = Math.floor((p1 + p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9 + 4) / 9);
          else if (type === 'edges') {
            const s1 = p1 + 2 * p2 + p3 - p7 - 2 * p8 - p9, s2 = p1 + 2 * p4 + p7 - p3 - 2 * p6 - p9;
            let r = Math.sqrt(s1 * s1 + s2 * s2);
            if (r > 65535.0) r = 65535.0;
            v = Math.floor(r);
          } else {
            v = Math.trunc((12 * p5 - p1 - p2 - p3 - p4 - p6 - p7 - p8 - p9 + 2) / 4);
            v = v > 65535 ? 65535 : (v < 0 ? 0 : v);
          }
        }
        o[ob + x] = v;
      }
    }
    return o;
  }

  REG.define('filter3x3', {
    kind: 'pixel', version: 1, stack: 'ask', rgb: 'each', preview: false,
    validate(p) { if (['smooth', 'sharpen', 'edges'].indexOf(p.type) < 0) throw bad('filter3x3 type'); },
    scratchBytes: () => 0,
    prepare(view, c, p) {
      const type = p.type;
      return { apron: { x: 1, y: 1 }, region: (full, rect) => filter3x3Region(full, rect, type, !!view.rgb) };
    }
  });

  // ----------------------------------------------------------------------------------------------------------
  // Unsharp Mask
  // ----------------------------------------------------------------------------------------------------------
  /* ij.plugin.filter.UnsharpMask: flags DOES_ALL|SUPPORTS_MASKING|CONVERT_TO_FLOAT|SNAPSHOT, so the image is a float
   * image and the snapshot its input:
   *     public void sharpenFloat(FloatProcessor fp, double sigma, float weight) {
   *         gb.blurGaussian(fp, sigma, sigma, 0.01);                         // accuracy 0.01, the same in both axes
   *         ... pixels[p] = (snapshotPixels[p] - weight*pixels[p])/(1f - weight);   // float arithmetic
   * dialogItemChanged refuses sigma < 0, weight < 0 or weight > 0.99. The float result is put back with
   * setPixels(channel, fp) (floatToType).
   *
   * GaussianBlur.blurFloat is ported below with its float arithmetic (blur1Direction → downscaleLine / convolveLine /
   * upscaleLine, makeGaussianKernel = IJFilters.makeKernel, makeDownscaleKernel, makeUpscaleKernel). No deviation: the
   * downscaled grid of a column is anchored at ImageJ's own `readFrom = max(0, writeFrom - kRadius)` of the selection.
   * Downscaling starts above sigma 2*4+0.5 = 8.5, where the apron ceil(5*sigma) >= 43 exceeds WHOLE_APRON, so the op
   * always runs as ONE band and needs no band-independent grid. */
  const UPSCALE_K_RADIUS = 2;            // GaussianBlur.blur1Direction: number of pixels to add for upscaling
  const MIN_DOWNSCALED_SIGMA = 4.0;      // minimum standard deviation in the downscaled image

  /* GaussianBlur.makeDownscaleKernel: "The kernel function preserves norm and 1st moment ... standard deviation 1/2". */
  function makeDownscaleKernel(unitLength) {
    const mid = Math.floor(unitLength * 3 / 2);
    const kernel = new Float32Array(3 * unitLength);
    for (let i = 0; i <= Math.floor(unitLength / 2); i++) {
      const x = i / unitLength;
      const v = (0.75 - x * x) / unitLength;
      kernel[mid - i] = v;
      kernel[mid + i] = v;
    }
    for (let i = Math.floor(unitLength / 2) + 1; i < Math.floor((unitLength * 3 + 1) / 2); i++) {
      const x = i / unitLength;
      const v = (0.125 + 0.5 * (x - 1) * (x - 2)) / unitLength;
      kernel[mid - i] = v;
      kernel[mid + i] = v;
    }
    return kernel;
  }
  /* GaussianBlur.makeUpscaleKernel: "a convolution of four unit squares". */
  function makeUpscaleKernel(unitLength) {
    const kernel = new Float32Array(4 * unitLength);
    const mid = 2 * unitLength;
    kernel[0] = 0;
    for (let i = 0; i < unitLength; i++) {
      const x = i / unitLength;
      const v = (2. / 3. - x * x * (1 - 0.5 * x));
      kernel[mid + i] = v;
      kernel[mid - i] = v;
    }
    for (let i = unitLength; i < 2 * unitLength; i++) {
      const x = i / unitLength;
      const v = (2. - x) * (2. - x) * (2. - x) / 6.;
      kernel[mid + i] = v;
      kernel[mid - i] = v;
    }
    return kernel;
  }
  /* GaussianBlur.downscaleLine: `get(i)` is the input line (i clamped to the line: "Out-of-line pixels of the input are
   * replaced by the edge pixels"), unscaled0 the input index of cache index 0. All sums are floats. */
  function downscaleLine(get, cache, kernel, reduceBy, unscaled0, length, newLength) {
    let p = unscaled0 - Math.floor(reduceBy * 3 / 2);
    const last = length - 1;
    for (let xout = -1; xout <= newLength; xout++) {
      let sum0 = 0, sum1 = 0, sum2 = 0;
      for (let x = 0; x < reduceBy; x++, p++) {
        const v = get(p < 0 ? 0 : (p > last ? last : p));
        sum0 = fround(sum0 + fround(v * kernel[x + 2 * reduceBy]));
        sum1 = fround(sum1 + fround(v * kernel[x + reduceBy]));
        sum2 = fround(sum2 + fround(v * kernel[x]));
      }
      if (xout > 0) cache[xout - 1] = fround(cache[xout - 1] + sum0);
      if (xout >= 0 && xout < newLength) cache[xout] = fround(cache[xout] + sum1);
      if (xout + 1 < newLength) cache[xout + 1] = sum2;
    }
  }
  /* GaussianBlur.upscaleLine, writing out[point0 + i*pointInc]. */
  function upscaleLine(cache, out, kernel, reduceBy, unscaled0, writeFrom, writeTo, point0, pointInc) {
    let p = point0 + writeFrom * pointInc;
    for (let xout = writeFrom; xout < writeTo; xout++, p += pointInc) {
      const xin = Math.floor((xout - unscaled0 + reduceBy - 1) / reduceBy); // the cache point (if exact) or the one above
      const x = reduceBy - 1 - (xout - unscaled0 + reduceBy - 1) % reduceBy;
      let r = fround(cache[xin - 2] * kernel[x]);
      r = fround(r + fround(cache[xin - 1] * kernel[x + reduceBy]));
      r = fround(r + fround(cache[xin] * kernel[x + 2 * reduceBy]));
      r = fround(r + fround(cache[xin + 1] * kernel[x + 3 * reduceBy]));
      out[p] = r;
    }
  }
  /* GaussianBlur.convolveLine: out-of-edge pixels are replaced by the nearest edge pixel through the running sum
   * `kernSum` (kernel[1]); every operation is a float operation. */
  function convolveLine(input, out, kern, kernSum, writeFrom, writeTo, point0, pointInc) {
    const length = input.length;
    const first = input[0], last = input[length - 1]; // out-of-edge pixels are replaced by nearest edge pixels
    const kern0 = kern[0], kRadius = kern.length;
    const firstPart = kRadius < length ? kRadius : length;
    let p = point0 + writeFrom * pointInc;
    let i = writeFrom;
    for (; i < firstPart; i++, p += pointInc) { // while the sum would include pixels < 0
      let result = fround(input[i] * kern0);
      result = fround(result + fround(kernSum[i] * first));
      if (i + kRadius > length) result = fround(result + fround(kernSum[length - i - 1] * last));
      for (let k = 1; k < kRadius; k++) {
        let v = 0;
        if (i - k >= 0) v = fround(v + input[i - k]);
        if (i + k < length) v = fround(v + input[i + k]);
        result = fround(result + fround(kern[k] * v));
      }
      out[p] = result;
    }
    const iEndInside = length - kRadius < writeTo ? length - kRadius : writeTo;
    /* four neighbouring pixels per pass: the chain result -> fround(result + ...) of one pixel is latency bound, four
     * independent chains overlap. Each pixel still runs exactly the operations of the loop below, in the same order. */
    for (; i + 3 < iEndInside; i += 4, p += 4 * pointInc) {
      let r0 = fround(input[i] * kern0), r1 = fround(input[i + 1] * kern0), r2 = fround(input[i + 2] * kern0), r3 = fround(input[i + 3] * kern0);
      for (let k = 1; k < kRadius; k++) {
        const kv = kern[k];
        r0 = fround(r0 + fround(kv * fround(input[i - k] + input[i + k])));
        r1 = fround(r1 + fround(kv * fround(input[i + 1 - k] + input[i + 1 + k])));
        r2 = fround(r2 + fround(kv * fround(input[i + 2 - k] + input[i + 2 + k])));
        r3 = fround(r3 + fround(kv * fround(input[i + 3 - k] + input[i + 3 + k])));
      }
      out[p] = r0; out[p + pointInc] = r1; out[p + 2 * pointInc] = r2; out[p + 3 * pointInc] = r3;
    }
    for (; i < iEndInside; i++, p += pointInc) { // while only pixels within the line are addressed (the easy case)
      let result = fround(input[i] * kern0);
      for (let k = 1; k < kRadius; k++) result = fround(result + fround(kern[k] * fround(input[i - k] + input[i + k])));
      out[p] = result;
    }
    for (; i < writeTo; i++, p += pointInc) { // while the sum would include pixels >= length
      let result = fround(input[i] * kern0);
      if (i < kRadius) result = fround(result + fround(kernSum[i] * first));
      if (i + kRadius >= length) result = fround(result + fround(kernSum[length - i - 1] * last));
      for (let k = 1; k < kRadius; k++) {
        let v = 0;
        if (i - k >= 0) v = fround(v + input[i - k]);
        if (i + k < length) v = fround(v + input[i + k]);
        result = fround(result + fround(kern[k] * v));
      }
      out[p] = result;
    }
  }

  /* One direction of GaussianBlur.blur1Direction for one line. `get(i)` reads the line, `out[point0 + i*pointInc]` receives
   * the points writeFrom..writeTo; `plan` holds the constants of the direction. */
  function blurLine(plan, get, out, writeFrom, writeTo, point0, pointInc, readFrom, caches) {
    const length = plan.length, reduceBy = plan.reduceBy, gauss = plan.gauss;
    const readTo = writeTo + plan.kRadius > length ? length : writeTo + plan.kRadius;
    if (plan.doDownscaling) {
      const newLength = Math.floor((readTo - readFrom + reduceBy - 1) / reduceBy) + 2 * (UPSCALE_K_RADIUS + 1);
      const unscaled0 = readFrom - (UPSCALE_K_RADIUS + 1) * reduceBy;
      const c1 = caches.c1(newLength), c2 = caches.c2(newLength);
      downscaleLine(get, c1, plan.downK, reduceBy, unscaled0, length, newLength);
      convolveLine(c1, c2, gauss.kernel, gauss.sums, 1, newLength - 1, 0, 1);
      upscaleLine(c2, out, plan.upK, reduceBy, unscaled0, writeFrom, writeTo, point0, pointInc);
    } else {
      const c1 = caches.c1(length);
      for (let i = readFrom; i < readTo; i++) c1[i] = get(i);
      convolveLine(c1, out, gauss.kernel, gauss.sums, writeFrom, writeTo, point0, pointInc);
    }
  }
  function directionPlan(sigma, accuracy, length) {
    const doDownscaling = sigma > 2 * MIN_DOWNSCALED_SIGMA + 0.5;
    const reduceBy = doDownscaling ? Math.min(Math.floor(sigma / MIN_DOWNSCALED_SIGMA), length) : 1;
    // Downscaling and upscaling blur the image a bit: the standard deviation is corrected for it (1/sqrt(3) and 1/2).
    const sigmaGauss = doDownscaling ? Math.sqrt(sigma * sigma / (reduceBy * reduceBy) - 1. / 3. - 1. / 4.) : sigma;
    const maxLength = doDownscaling ? Math.floor((length + reduceBy - 1) / reduceBy) + 2 * (UPSCALE_K_RADIUS + 1) : length;
    const gauss = root.IJFilters.makeKernel(sigmaGauss, accuracy, maxLength);
    return {
      length, doDownscaling, reduceBy, gauss, kRadius: gauss.kernel.length * reduceBy,
      downK: doDownscaling ? makeDownscaleKernel(reduceBy) : null, upK: doDownscaling ? makeUpscaleKernel(reduceBy) : null
    };
  }
  function lineCaches() {
    let a = null, b = null;
    return {
      c1(n) { if (!a || a.length !== n) a = new Float32Array(n); return a; },
      c2(n) { if (!b || b.length !== n) b = new Float32Array(n); return b; }
    };
  }

  /* GaussianBlur.blurFloat(fp, sigma, sigma, accuracy) over `rect` of a W x H image (src any typed array, read as float):
   * rows rect.y - ceil(5 sigma) .. rect.y + rect.h + ceil(5 sigma) are blurred along x first ("extraLines"), the columns of
   * the rectangle along y after that, reading the x-blurred rows where they exist and the original pixels elsewhere (the
   * array is blurred in place). Returns the Float32Array of the rect. */
  async function gaussianBlurFloat(src, W, H, rect, sigma, accuracy, tk) {
    const extra = Math.ceil(5 * sigma);
    const ys0 = Math.max(0, rect.y - extra), ys1 = Math.min(H, rect.y + rect.h + extra);
    const nRows = ys1 - ys0;
    const buf = new Float32Array(nRows * rect.w);
    const px = directionPlan(sigma, accuracy, W), py = directionPlan(sigma, accuracy, H);
    const writeFromX = rect.x, writeToX = rect.x + rect.w;
    const readFromX = Math.max(0, writeFromX - px.kRadius);
    const cx = lineCaches();
    for (let r = ys0; r < ys1; r++) {
      const base = r * W;
      blurLine(px, (i) => src[base + i], buf, writeFromX, writeToX, (r - ys0) * rect.w - rect.x, 1, readFromX, cx);
      await tk(0.5 * (r - ys0 + 1) / nRows);
    }
    const out = new Float32Array(rect.w * rect.h);
    const writeFromY = rect.y, writeToY = rect.y + rect.h;
    const cy = lineCaches();
    const rw = rect.w;
    /* Rows whose whole kernel lies inside the line AND inside the x-blurred rows (`buf`): convolveLine's "easy case",
     *     result = fround(in[i] * kern0); for k = 1..kRadius-1: result = fround(result + fround(kern[k] * fround(in[i-k] + in[i+k])))
     * is evaluated row by row for four neighbouring columns at once (contiguous reads, four independent chains) instead of
     * column by column through a stride of rect.w floats. The other rows (the first / last kRadius of the image, or beyond
     * the x-blurred rows) go through the per-column path of ImageJ. Same operations per pixel, so the same bits. */
    const kernY = py.gauss.kernel, kRadY = kernY.length;
    let fastFrom = 0, fastTo = 0;
    if (!py.doDownscaling) {
      fastFrom = Math.max(writeFromY, kRadY, ys0 + kRadY - 1);
      fastTo = Math.min(writeToY, H - kRadY, ys1 - kRadY + 1);
      if (fastTo <= fastFrom) fastFrom = fastTo = 0;
    }
    const columns = async (wf, wt) => {
      if (wt <= wf) return;
      const readFromY = Math.max(0, wf - py.kRadius);
      for (let x = rect.x; x < rect.x + rw; x++) {
        const bx = x - rect.x;
        const get = (i) => ((i >= ys0 && i < ys1) ? buf[(i - ys0) * rw + bx] : src[i * W + x]);
        blurLine(py, get, out, wf, wt, bx - rect.y * rw, rw, readFromY, cy);
        // this segment covers rows wf..wt of the rect: its share of the second half grows with the columns done
        if ((bx & 15) === 15) await tk(0.5 + 0.5 * ((wf - rect.y) + (wt - wf) * (bx + 1) / rw) / rect.h);
      }
    };
    if (fastTo > fastFrom) {
      await columns(writeFromY, fastFrom);
      const k0 = kernY[0];
      for (let i = fastFrom; i < fastTo; i++) {
        const ib = (i - ys0) * rw, ob = (i - rect.y) * rw;
        let x = 0;
        for (; x + 3 < rw; x += 4) {
          let r0 = fround(buf[ib + x] * k0), r1 = fround(buf[ib + x + 1] * k0), r2 = fround(buf[ib + x + 2] * k0), r3 = fround(buf[ib + x + 3] * k0);
          for (let k = 1; k < kRadY; k++) {
            const kv = kernY[k], up = ib + x - k * rw, dn = ib + x + k * rw;
            r0 = fround(r0 + fround(kv * fround(buf[up] + buf[dn])));
            r1 = fround(r1 + fround(kv * fround(buf[up + 1] + buf[dn + 1])));
            r2 = fround(r2 + fround(kv * fround(buf[up + 2] + buf[dn + 2])));
            r3 = fround(r3 + fround(kv * fround(buf[up + 3] + buf[dn + 3])));
          }
          out[ob + x] = r0; out[ob + x + 1] = r1; out[ob + x + 2] = r2; out[ob + x + 3] = r3;
        }
        for (; x < rw; x++) {
          let r = fround(buf[ib + x] * k0);
          for (let k = 1; k < kRadY; k++) r = fround(r + fround(kernY[k] * fround(buf[ib + x - k * rw] + buf[ib + x + k * rw])));
          out[ob + x] = r;
        }
        await tk(0.5 + 0.5 * (i - rect.y + 1) / rect.h);
      }
      await columns(fastTo, writeToY);
    } else {
      await columns(writeFromY, writeToY);
    }
    return out;
  }

  async function unsharpRegion(full, rect, sigma, weight, tk) {
    const W = full.width, bd = full.bitDepth, s = full.data;
    const w = fround(weight), den = fround(1 - w);
    const out = new Float32Array(rect.w * rect.h);
    const blurred = sigma > 0 ? await gaussianBlurFloat(s, W, full.height, rect, sigma, 0.01, tk) : null;
    for (let y = 0; y < rect.h; y++) {
      const sb = (rect.y + y) * W + rect.x, ob = y * rect.w;
      for (let x = 0; x < rect.w; x++) {
        const orig = s[sb + x];
        const b = blurred ? blurred[ob + x] : orig;
        out[ob + x] = fround(fround(orig - fround(w * b)) / den);
      }
    }
    return floatToType(out, bd);
  }

  REG.define('unsharpMask', {
    kind: 'pixel', version: 1, stack: 'ask', rgb: 'each', preview: 'reduced',
    validate(p) {
      if (!isNum(p.sigma) || p.sigma < 0) throw bad('sigma');
      if (!isNum(p.weight) || p.weight < 0 || p.weight > 0.99) throw bad('weight');
    },
    scratchBytes(info, p) {
      const a = Math.ceil(5 * p.sigma);
      const reg = info.region || { w: info.width, h: info.height };
      const rows = a >= WHOLE_APRON ? reg.h : Math.max(1, Math.min(reg.h, Math.floor(MAX_BAND / Math.max(1, reg.w))));
      const held = Math.min(info.height, rows + 2 * a); // the rows actually held: never more than the image
      return held * reg.w * 4 + reg.w * rows * 8 + 8 * (Math.max(info.width, info.height) + 64);
    },
    prepare(view, c, p, ctx) {
      if (!root.IJFilters) throw fail('IJ_MODULE_MISSING', 'IJFilters');
      const sg = p.sigma / ((ctx && ctx.scale) || 1);
      const a = sg > 0 ? Math.ceil(5 * sg) : 0;
      const tk = ticker(ctx);
      return { whole: a >= WHOLE_APRON, apron: { x: a, y: a }, region: (full, rect) => unsharpRegion(full, rect, sg, p.weight, tk) };
    }
  });

  // ----------------------------------------------------------------------------------------------------------
  // Convolve
  // ----------------------------------------------------------------------------------------------------------
  /* ij.plugin.filter.Convolver (flags DOES_ALL|CONVERT_TO_FLOAT|SUPPORTS_MASKING|SNAPSHOT → a float image):
   *     for (int v=-vc; v <= vc; v++) { offset = x+(y+v)*width;
   *         for(int u = -uc; u <= uc; u++) {
   *             if (edgePixel) sum += getPixel(x+u, y+v, pixels2, width, height)*kernel[i++];     // edge = nearest pixel
   *             else           sum += pixels2[offset+u]*kernel[i++];
   *     pixels[x+y*width] = (float)(sum*scale);
   * `sum` is a double, the product float*float is a FLOAT (rounded) before it is added: fround(p*k). The kernel is
   * indexed row by row and NOT mirrored: a correlation. scale (getScale): `double scale = 1.0; double sum = 0.0;
   * for (...) sum += kernel[i]; if (sum!=0.0) scale = 1.0/sum;` — applied only when "Normalize Kernel" is ticked
   * (`double scale = normalize?getScale(kernel):1.0`). A 1xN / Nx1 kernel takes convolveFloat1D, whose sums are
   * the same terms in the same order. decodeKernel: odd width and height ("Kernel must have odd width and height"),
   * every row as long as the first; the values are stored as floats ((float)Tools.parseDouble). */
  function convolveRegion(full, rect, kern, kw, kh, scale, tk) {
    const W = full.width, H = full.height, bd = full.bitDepth, s = full.data;
    const uc = kw >> 1, vc = kh >> 1;
    const out = new Float32Array(rect.w * rect.h);
    const xs = new Int32Array(kw * rect.w); // clamped column of tap u for pixel x
    for (let x = 0; x < rect.w; x++) for (let u = 0; u < kw; u++) xs[x * kw + u] = clampI(rect.x + x + u - uc, 0, W - 1);
    const rows = new Int32Array(kh);
    return (async () => {
      for (let y = 0; y < rect.h; y++) {
        for (let v = 0; v < kh; v++) rows[v] = clampI(rect.y + y + v - vc, 0, H - 1) * W;
        const ob = y * rect.w;
        for (let x = 0; x < rect.w; x++) {
          let sum = 0.0, i = 0;
          const xb = x * kw;
          for (let v = 0; v < kh; v++) {
            const rb = rows[v];
            for (let u = 0; u < kw; u++) sum += fround(s[rb + xs[xb + u]] * kern[i++]);
          }
          out[ob + x] = fround(sum * scale);
        }
        await tk(y / rect.h);
      }
      return floatToType(out, bd);
    })();
  }

  function kernelScale(kern) {
    let sum = 0.0;
    for (let i = 0; i < kern.length; i++) sum += kern[i];
    return sum !== 0.0 ? 1.0 / sum : 1.0;
  }

  REG.define('convolve', {
    kind: 'pixel', version: 1, stack: 'ask', rgb: 'each',
    validate(p) {
      if (!Number.isInteger(p.kw) || !Number.isInteger(p.kh) || p.kw < 1 || p.kh < 1 || (p.kw & 1) !== 1 || (p.kh & 1) !== 1) throw bad('kernel size');
      if (p.kw > 31 || p.kh > 31) throw bad('kernel too large');
      if (!Array.isArray(p.kernel) && !ArrayBuffer.isView(p.kernel)) throw bad('kernel');
      if (p.kernel.length !== p.kw * p.kh) throw bad('kernel length');
      for (let i = 0; i < p.kernel.length; i++) if (!isNum(p.kernel[i])) throw bad('kernel value');
      if (p.normalize !== undefined && typeof p.normalize !== 'boolean') throw bad('normalize');
    },
    scratchBytes: (info, p) => bandBytes(info, p.kw >> 1, p.kh >> 1, 2),
    prepare(view, c, p, ctx) {
      const kern = Float32Array.from(p.kernel); // (float)Tools.parseDouble
      const scale = p.normalize === false ? 1.0 : kernelScale(kern);
      const tk = ticker(ctx);
      return { apron: { x: p.kw >> 1, y: p.kh >> 1 }, region: (full, rect) => convolveRegion(full, rect, kern, p.kw, p.kh, scale, tk) };
    }
  });

  // ----------------------------------------------------------------------------------------------------------
  // RankFilters core: Variance, Remove Outliers, Remove NaNs, Top Hat (Minimum / Maximum for the latter)
  // ----------------------------------------------------------------------------------------------------------
  /* ij.plugin.filter.RankFilters.doFiltering / filterLine, single-threaded. The input of a line is the float cache
   * (`cache`), padded with the nearest edge pixel; the kernel is the circular makeLineRadii(radius) shape
   * (IJFilters.kernelOffsets is that routine). One ring of kHeight cache lines holds the rows y-kRadius..y+kRadius;
   * `ptr` holds, for each kernel row, the cache index of its first and last pixel at x = 0 (RankFilters.cachePointers).
   * Everything below is a transcription: the incremental sums / maxima and the median "guess" are kept because the
   * result of a variance (double running sums) and of getMedian on NaN data depends on them. */

  function getAreaMax(cache, x0, ptr, ignoreRight, max, sign) {
    for (let kk = 0; kk < ptr.length; kk += 2) {
      const end = ptr[kk + 1] + x0 - ignoreRight;
      for (let p = ptr[kk] + x0; p <= end; p++) { const v = cache[p] * sign; if (max < v) max = v; }
    }
    return max;
  }
  function getSideMax(cache, x0, ptr, isRight, sign) {
    let max = -FLT_MAX;
    if (!isRight) x0--;
    for (let kk = isRight ? 1 : 0; kk < ptr.length; kk += 2) { const v = cache[x0 + ptr[kk]] * sign; if (max < v) max = v; }
    return max;
  }
  function getAreaSums(cache, x0, ptr, sums) {
    let sum = 0, sum2 = 0;
    for (let kk = 0; kk < ptr.length; kk += 2) {
      const end = ptr[kk + 1] + x0;
      for (let p = ptr[kk] + x0; p <= end; p++) { const v = cache[p]; sum += v; sum2 += v * v; }
    }
    sums[0] = sum; sums[1] = sum2;
  }
  function addSideSums(cache, x0, ptr, sums) {
    let sum = 0, sum2 = 0;
    for (let kk = 0; kk < ptr.length;) {
      let v = cache[ptr[kk++] + (x0 - 1)]; // this value is not in the kernel area any more
      sum -= v; sum2 -= v * v;
      v = cache[ptr[kk++] + x0];           // this value comes into the kernel area
      sum += v; sum2 += v * v;
    }
    sums[0] += sum; sums[1] += sum2;
  }
  /* RankFilters.findNthLowestNumber (Hoare's find, contributed by Heinz Klar), verbatim. */
  function findNth(buf, len, n) {
    let l = 0, m = len - 1;
    let med = buf[n];
    while (l < m) {
      let i = l, j = m;
      do {
        while (buf[i] < med) i++;
        while (med < buf[j]) j--;
        const dum = buf[j]; buf[j] = buf[i]; buf[i] = dum;
        i++; j--;
      } while (j >= n && i <= n);
      if (j < n) l = i;
      if (n < i) m = j;
      med = buf[n];
    }
    return med;
  }
  /* getMedian: values above / below the guess are collected; the median is the guess when neither side holds
   * more than half of the kernel ("if (nAbove>half) ... else if (nBelow>half) ... else return guess"). */
  function getMedian(cache, x0, ptr, above, below, kN, guess) {
    let nA = 0, nB = 0;
    for (let kk = 0; kk < ptr.length; kk += 2) {
      const end = ptr[kk + 1] + x0;
      for (let p = ptr[kk] + x0; p <= end; p++) {
        const v = cache[p];
        if (v > guess) above[nA++] = v;
        else if (v < guess) below[nB++] = v;
      }
    }
    const half = kN >> 1;
    if (nA > half) return findNth(above, nA, nA - half - 1);
    if (nB > half) return findNth(below, nB, half);
    return guess;
  }
  /* getNaNAwareMedian: "NaN data values are ignored; the output is NaN only if there are only NaN values in the
   * kernel-sized neighborhood". kNPoints counts down per NaN, so with an even number of values left and a
   * balanced split the median is the guess itself — that is ImageJ's behaviour and it is kept. */
  function getNaNAwareMedian(cache, x0, ptr, above, below, kN, guess) {
    let nA = 0, nB = 0;
    for (let kk = 0; kk < ptr.length; kk += 2) {
      const end = ptr[kk + 1] + x0;
      for (let p = ptr[kk] + x0; p <= end; p++) {
        const v = cache[p];
        if (v !== v) kN--;
        else if (v > guess) above[nA++] = v;
        else if (v < guess) below[nB++] = v;
      }
    }
    if (kN === 0) return NaN;
    const half = kN >> 1;
    if (nA > half) return findNth(above, nA, nA - half - 1);
    if (nB > half) return findNth(below, nB, half);
    return guess;
  }

  const MODE_VARIANCE = 1, MODE_OUTLIERS = 2, MODE_NAN = 3;

  /* One RankFilters pass over `rect` of the W x H image `src` (any typed array). Returns the float values of the
   * rect. mode: MODE_VARIANCE, MODE_OUTLIERS (sign, thr), MODE_NAN; Minimum / Maximum live in minMaxPass. `maxValue` = (float)ip.maxValue() for 8 / 16 bits, NaN for float. */
  async function rankPass(src, W, H, rect, k, mode, sign, thr, maxValue, tk, f0, f1) {
    const kR = k.kRadius, kH = 2 * kR + 1, dxs = k.dxs, kN = k.nPixels;
    const cw = rect.w + 2 * kR;
    const cache = new Float32Array(cw * kH);
    const xmin = rect.x - kR, xmax = rect.x + rect.w + kR;
    const padL = xmin < 0 ? -xmin : 0, padR = xmax > W ? xmax - W : 0;
    const xIn = xmin > 0 ? xmin : 0, wIn = Math.min(xmax, W) - xIn;
    const out = new Float32Array(rect.w * rect.h);
    const ptr = new Int32Array(2 * kH);
    const medianMode = mode === MODE_OUTLIERS || mode === MODE_NAN;
    const above = medianMode ? new Float32Array(kN) : null, below = medianMode ? new Float32Array(kN) : null;
    const sums = [0, 0];
    const smallKernel = kR < 2;
    const maxOrOut = mode === MODE_OUTLIERS;
    const sumFilter = mode === MODE_VARIANCE;
    // RankFilters.readLineToCache: nearest edge pixel in x, rows outside the image are copies of row 0 / H-1
    function load(yy) {
      const slot = ((yy % kH) + kH) % kH;
      const base = slot * cw, row = clampI(yy, 0, H - 1) * W;
      for (let i = 0; i < wIn; i++) cache[base + padL + i] = src[row + xIn + i];
      const left = cache[base + padL], right = cache[base + padL + wIn - 1];
      for (let i = 0; i < padL; i++) cache[base + i] = left;
      for (let i = 0; i < padR; i++) cache[base + padL + wIn + i] = right;
    }
    let loaded = rect.y - kR - 1;
    const thrF = fround(thr || 0);
    for (let y = rect.y; y < rect.y + rect.h; y++) {
      while (loaded < y + kR) load(++loaded);
      for (let j = 0; j < kH; j++) {
        const slot = (((y - kR + j) % kH) + kH) % kH;
        ptr[2 * j] = slot * cw + kR - dxs[j];
        ptr[2 * j + 1] = slot * cw + kR + dxs[j];
      }
      const cacheLineP = (((y % kH) + kH) % kH) * cw + kR;
      const ob = (y - rect.y) * rect.w;
      let max = 0;
      let median = cache[cacheLineP] !== cache[cacheLineP] ? 0 : cache[cacheLineP]; // a first guess
      let full = true;
      for (let x = 0; x < rect.w; x++) {
        if (full) {
          full = smallKernel; // for a small kernel always the full area, never the incremental algorithm
          if (maxOrOut) max = getAreaMax(cache, x, ptr, 0, -FLT_MAX, sign);
          if (sumFilter) getAreaSums(cache, x, ptr, sums);
        } else if (maxOrOut) {
          const newMax = getSideMax(cache, x, ptr, true, sign);
          if (newMax >= max) max = newMax; // compare with the previous maximum
          else {
            const removedMax = getSideMax(cache, x, ptr, false, sign);
            if (removedMax >= max) max = getAreaMax(cache, x, ptr, 1, newMax, sign);
          }
        } else if (sumFilter) {
          addSideSums(cache, x, ptr, sums);
          if (sums[0] !== sums[0]) full = true; // avoid perpetuating NaNs into the remaining line
        }
        if (sumFilter) {
          // Variance: sum of squares - square of sums
          let value = fround((sums[1] - sums[0] * sums[0] / kN) / kN);
          if (value > maxValue) value = maxValue;
          if (value < 0) value = 0; // numeric noise can cause values < 0
          out[ob + x] = value;
        } else if (mode === MODE_OUTLIERS) {
          let v = cache[cacheLineP + x];
          const t = fround(fround(v * sign) + thrF);
          if (t < max) { // for low outliers the median can't be higher than max (sign is +1)
            median = getMedian(cache, x, ptr, above, below, kN, median);
            if (t < fround(median * sign)) v = median; // beyond the threshold: the outlier becomes the median
          }
          out[ob + x] = v;
        } else if (mode === MODE_NAN) {
          const v = cache[cacheLineP + x];
          if (v !== v) out[ob + x] = getNaNAwareMedian(cache, x, ptr, above, below, kN, median);
          else { median = v; out[ob + x] = v; } // initial guess for the next point
        }
      }
      await tk(f0 + (f1 - f0) * ((y - rect.y + 1) / rect.h));
    }
    return out;
  }

  /* Minimum / Maximum of RankFilters (the two passes of Top Hat): RankFilters.doFiltering for MIN / MAX, with the same
   * incremental maximum along a line (new right-hand edge, left-hand edge only when the maximum may have left, a full
   * kernel area only when it did). Bit-identical to ImageJ's RankFilters, which computes
   * `max = max(cache[p] * sign)` and stores `max * sign`; here the line cache is filled with `src * sign` (the very
   * same double product, rounded to the float the cache holds) so the inner loops are plain maximum searches without
   * a multiplication, and `max * sign` is the same final product. Ties (+0 / -0) keep the first value met, as before,
   * because the scan order and the strict `<` are those of ImageJ. */
  function areaMaxS(cache, x0, ptr, ignoreRight, max) {
    for (let kk = 0; kk < ptr.length; kk += 2) {
      const end = ptr[kk + 1] + x0 - ignoreRight;
      for (let p = ptr[kk] + x0; p <= end; p++) { const v = cache[p]; if (max < v) max = v; }
    }
    return max;
  }
  /* The right-hand edge maximum of EVERY x of a line at once: R[x] = max over the kernel rows j (top to bottom, the
   * order rightMax of ImageJ scans them) of cache[ptr[2j+1] + x]. Row-major, so each pass reads one cache row
   * sequentially instead of striding over 2 * kRadius + 1 rows per pixel; same values, same first-wins ties. */
  function rightMaxLine(cache, ptr, R, n) {
    R.fill(-FLT_MAX);
    let kk = 1;
    // four kernel rows per sweep (kept in the same order), one store of R[x] per sweep instead of one per row
    for (; kk + 6 < ptr.length; kk += 8) {
      const o0 = ptr[kk], o1 = ptr[kk + 2], o2 = ptr[kk + 4], o3 = ptr[kk + 6];
      for (let x = 0; x < n; x++) {
        let m = R[x], v = cache[o0 + x];
        if (m < v) m = v;
        v = cache[o1 + x]; if (m < v) m = v;
        v = cache[o2 + x]; if (m < v) m = v;
        v = cache[o3 + x]; if (m < v) m = v;
        R[x] = m;
      }
    }
    for (; kk < ptr.length; kk += 2) {
      const o = ptr[kk];
      for (let x = 0; x < n; x++) { const v = cache[o + x]; if (R[x] < v) R[x] = v; }
    }
  }
  function leftMaxS(cache, x0, ptr) {
    let max = -FLT_MAX;
    x0--;
    for (let kk = 0; kk < ptr.length; kk += 2) { const v = cache[x0 + ptr[kk]]; if (max < v) max = v; }
    return max;
  }
  async function minMaxPass(src, W, H, rect, k, sign, tk, f0, f1) {
    const kR = k.kRadius, kH = 2 * kR + 1, dxs = k.dxs;
    const cw = rect.w + 2 * kR;
    const cache = new Float32Array(cw * kH);
    const xmin = rect.x - kR, xmax = rect.x + rect.w + kR;
    const padL = xmin < 0 ? -xmin : 0, padR = xmax > W ? xmax - W : 0;
    const xIn = xmin > 0 ? xmin : 0, wIn = Math.min(xmax, W) - xIn;
    const out = new Float32Array(rect.w * rect.h);
    const ptr = new Int32Array(2 * kH);
    const R = new Float32Array(rect.w);
    const smallKernel = kR < 2;
    function load(yy) {
      const slot = ((yy % kH) + kH) % kH;
      const base = slot * cw + padL, row = clampI(yy, 0, H - 1) * W + xIn;
      if (sign === 1) for (let i = 0; i < wIn; i++) cache[base + i] = src[row + i];
      else for (let i = 0; i < wIn; i++) cache[base + i] = src[row + i] * -1;
      const left = cache[base], right = cache[base + wIn - 1], b0 = slot * cw;
      for (let i = 0; i < padL; i++) cache[b0 + i] = left;
      for (let i = 0; i < padR; i++) cache[base + wIn + i] = right;
    }
    let loaded = rect.y - kR - 1;
    for (let y = rect.y; y < rect.y + rect.h; y++) {
      while (loaded < y + kR) load(++loaded);
      for (let j = 0; j < kH; j++) {
        const slot = (((y - kR + j) % kH) + kH) % kH;
        ptr[2 * j] = slot * cw + kR - dxs[j];
        ptr[2 * j + 1] = slot * cw + kR + dxs[j];
      }
      const ob = (y - rect.y) * rect.w;
      rightMaxLine(cache, ptr, R, rect.w);
      let max = 0, full = true;
      for (let x = 0; x < rect.w; x++) {
        if (full) {
          full = smallKernel; // for a small kernel always the full area, never the incremental algorithm
          max = areaMaxS(cache, x, ptr, 0, -FLT_MAX);
        } else {
          const newMax = R[x];
          if (newMax >= max) max = newMax; // compare with the previous maximum
          else if (leftMaxS(cache, x, ptr) >= max) max = areaMaxS(cache, x, ptr, 1, newMax);
        }
        out[ob + x] = max * sign;
      }
      await tk(f0 + (f1 - f0) * ((y - rect.y + 1) / rect.h));
    }
    return out;
  }

  /* Minimum / Maximum of an 8 / 16-bit image (Top Hat of integer data), the same values as minMaxPass.
   *
   * Why not minMaxPass: its incremental maximum rescans the whole kernel area (~345 pixels at r = 10) every time the
   * maximum leaves the window, which on real data happens for a large share of the pixels (profile: areaMaxS + leftMaxS
   * = 80 % of Top Hat). Here the cost per pixel is independent of the data
   * (O(kR) comparisons, no rescans). The disc is cut into COLUMNS instead of rows:
   *     O[y][x] = max over t = -kR..kR of  C_|t|[y][x + t],     C_t[y][c] = max of column c over rows y-h(t)..y+h(t),
   * where h(t) is the largest dy whose kernel row reaches dx >= t (the half-height of the disc at offset t from its centre;
   * kernel rows are symmetric and their half-widths never grow away from the centre). The C_t are nested (h(t) shrinks
   * as t grows), so each is the previous one plus the two rows it adds: every cache row is read once per output row.
   * A maximum of integers does not depend on the order it is searched in, so the values equal minMaxPass's; the cache
   * holds src * sign as int32 (zero stays +0 where the float path holds -0, and the result `max * sign` of the float path
   * is +0 for a zero maximum, which `m ? m * sign : 0` reproduces). Not used for 32-bit data (NaN, -0 order). */
  async function minMaxPassInt(src, W, H, rect, k, sign, tk, f0, f1) {
    const kR = k.kRadius, kH = 2 * kR + 1, dxs = k.dxs;
    const cw = rect.w + 2 * kR, rw = rect.w;
    const cache = new Int32Array(cw * kH);
    const xmin = rect.x - kR, xmax = rect.x + rect.w + kR;
    const padL = xmin < 0 ? -xmin : 0, padR = xmax > W ? xmax - W : 0;
    const xIn = xmin > 0 ? xmin : 0, wIn = Math.min(xmax, W) - xIn;
    const out = new Float32Array(rw * rect.h);
    // h[t] for t = 0..kR, then the distinct column maxima: slot[t] indexes C (equal h shares one array)
    const hT = new Int32Array(kR + 1), slot = new Int32Array(kR + 1);
    for (let t = 0; t <= kR; t++) { let h = 0; while (h < kR && dxs[kR + h + 1] >= t) h++; hT[t] = h; }
    let nSlots = 0;
    for (let t = kR; t >= 0; t--) slot[t] = (t < kR && hT[t] === hT[t + 1]) ? slot[t + 1] : nSlots++;
    const C = new Int32Array(nSlots * cw);
    const acc = new Int32Array(rw);
    const rowOf = new Int32Array(kH); // cache offset of kernel row j (dy = j - kR)
    function load(yy) {
      const sl = ((yy % kH) + kH) % kH;
      const base = sl * cw + padL, row = clampI(yy, 0, H - 1) * W + xIn;
      if (sign === 1) for (let i = 0; i < wIn; i++) cache[base + i] = src[row + i];
      else for (let i = 0; i < wIn; i++) cache[base + i] = -src[row + i];
      const left = cache[base], right = cache[base + wIn - 1], b0 = sl * cw;
      for (let i = 0; i < padL; i++) cache[b0 + i] = left;
      for (let i = 0; i < padR; i++) cache[base + wIn + i] = right;
    }
    let loaded = rect.y - kR - 1;
    for (let y = rect.y; y < rect.y + rect.h; y++) {
      while (loaded < y + kR) load(++loaded);
      for (let j = 0; j < kH; j++) rowOf[j] = ((((y - kR + j) % kH) + kH) % kH) * cw;
      // C_t from the widest offset (smallest disc height) down to t = 0, over the columns O reads: c in [kR - t, kR + rw + t)
      for (let t = kR; t >= 0; t--) {
        if (t < kR && slot[t] === slot[t + 1]) continue;
        const d = slot[t] * cw, c0 = kR - t, c1 = kR + rw + t, h = hT[t];
        // the array this one extends: the centre row (t = kR) or the previous, wider-offset array, which covers a wider
        // column range than this one and so is valid over [c0, c1)
        let from, dy;
        const cen = rowOf[kR];
        if (t === kR) { from = cen; dy = 1; if (h < 1) { for (let c = c0; c < c1; c++) C[d + c] = cache[cen + c]; continue; } } else { from = slot[t + 1] * cw; dy = hT[t + 1] + 1; }
        const src0 = t === kR ? cache : C;
        // first extension reads `from`, the others update C[d] in place; two rows per sweep
        let ra = rowOf[kR - dy], rb = rowOf[kR + dy];
        for (let c = c0; c < c1; c++) {
          let m = src0[from + c];
          const u = cache[ra + c], v = cache[rb + c];
          if (u > m) m = u;
          if (v > m) m = v;
          C[d + c] = m;
        }
        dy++;
        for (; dy + 1 <= h; dy += 2) {
          ra = rowOf[kR - dy]; rb = rowOf[kR + dy];
          const rc = rowOf[kR - dy - 1], rd = rowOf[kR + dy + 1];
          for (let c = c0; c < c1; c++) {
            let m = C[d + c], u = cache[ra + c];
            if (u > m) m = u;
            u = cache[rb + c]; if (u > m) m = u;
            u = cache[rc + c]; if (u > m) m = u;
            u = cache[rd + c]; if (u > m) m = u;
            C[d + c] = m;
          }
        }
        if (dy <= h) {
          ra = rowOf[kR - dy]; rb = rowOf[kR + dy];
          for (let c = c0; c < c1; c++) {
            let m = C[d + c];
            const u = cache[ra + c], v = cache[rb + c];
            if (u > m) m = u;
            if (v > m) m = v;
            C[d + c] = m;
          }
        }
      }
      const ob = (y - rect.y) * rw;
      const d0 = slot[0] * cw + kR;
      for (let x = 0; x < rw; x++) acc[x] = C[d0 + x];
      let t = 1;
      // four offsets per sweep: one read and one write of acc for eight column maxima
      for (; t + 3 <= kR; t += 4) {
        const l0 = slot[t] * cw + kR - t, r0 = slot[t] * cw + kR + t;
        const l1 = slot[t + 1] * cw + kR - t - 1, r1 = slot[t + 1] * cw + kR + t + 1;
        const l2 = slot[t + 2] * cw + kR - t - 2, r2 = slot[t + 2] * cw + kR + t + 2;
        const l3 = slot[t + 3] * cw + kR - t - 3, r3 = slot[t + 3] * cw + kR + t + 3;
        for (let x = 0; x < rw; x++) {
          let m = acc[x], v = C[l0 + x];
          if (v > m) m = v;
          v = C[r0 + x]; if (v > m) m = v;
          v = C[l1 + x]; if (v > m) m = v;
          v = C[r1 + x]; if (v > m) m = v;
          v = C[l2 + x]; if (v > m) m = v;
          v = C[r2 + x]; if (v > m) m = v;
          v = C[l3 + x]; if (v > m) m = v;
          v = C[r3 + x]; if (v > m) m = v;
          acc[x] = m;
        }
      }
      for (; t <= kR; t++) {
        const dl = slot[t] * cw + kR - t, dr = slot[t] * cw + kR + t;
        for (let x = 0; x < rw; x++) {
          let m = acc[x];
          const a = C[dl + x], b = C[dr + x];
          if (a > m) m = a;
          if (b > m) m = b;
          acc[x] = m;
        }
      }
      if (sign === 1) for (let x = 0; x < rw; x++) out[ob + x] = acc[x];
      else for (let x = 0; x < rw; x++) { const m = acc[x]; out[ob + x] = m ? -m : 0; }
      await tk(f0 + (f1 - f0) * ((y - rect.y + 1) / rect.h));
    }
    return out;
  }

  const rankKernel = (radius) => root.IJFilters.kernelOffsets(radius);
  const maxOf = (bd) => (bd === 8 ? 255 : (bd === 16 ? 65535 : NaN));

  /* The engine hands a band-wise op rows in slices of a few milliseconds, which for Top Hat can shrink to a single
   * row; each call would then redo the 2 * kRadius rows of apron of both passes (21 x the work for r = 10).
   * Every output row depends only on the source (the result is band independent), so once the engine asks
   * for the rows that follow the previous call, a block that doubles up to MAX_BAND pixels is computed at once and the
   * next calls are served from it. The first call computes exactly what was asked, so a selection that fits one band
   * costs nothing extra; a block never reaches past the image; a whole-image op is never grown. Cancel and progress
   * go through the pass' own ticker as before. A block is not capped by the selection's bottom (the engine does not tell it),
 * so the last block of a tall selection ending mid-image may compute up to 2 * lastH rows nobody asks for (output unaffected). `compute(full, rect)` returns the rect's typed result. */
  function growingRegion(compute, whole) {
    let blk = null, lastEnd = -1, lastH = 0, lastKey = null;
    return async (full, rect) => {
      const key = full.data;
      if (blk && blk.key === key && blk.x === rect.x && blk.w === rect.w && rect.y >= blk.y0 && rect.y + rect.h <= blk.y1) {
        lastEnd = rect.y + rect.h;
        const part = blk.data.subarray((rect.y - blk.y0) * rect.w, (rect.y - blk.y0 + rect.h) * rect.w);
        if (rect.y + rect.h >= blk.y1) blk = null; // consumed: a finished channel keeps no block alive
        return part;
      }
      let h = rect.h;
      if (!whole && lastKey === key && rect.y === lastEnd) {
        const cap = Math.max(rect.h, Math.floor(MAX_BAND / Math.max(1, rect.w)));
        h = Math.min(full.height - rect.y, Math.max(rect.h, Math.min(cap, 2 * lastH)));
      }
      const data = await compute(full, { x: rect.x, y: rect.y, w: rect.w, h });
      blk = { key, x: rect.x, w: rect.w, y0: rect.y, y1: rect.y + h, data };
      lastKey = key; lastEnd = rect.y + rect.h; lastH = h;
      if (h === rect.h) blk = null;
      return h === rect.h ? data : data.subarray(0, rect.w * rect.h);
    };
  }

  /* RankFilters: the dialog accepts radius 0..100 for outliers / remove NaNs and 0..1000 for the others
   * (dialogItemChanged: int maxRadius = (filterType==MEDIAN || filterType==OUTLIERS || filterType==REMOVE_NAN) ? 100 : 1000;
   * outliers also need threshold >= 0). */
  REG.define('rankExtra', {
    kind: 'pixel', version: 1, stack: 'ask', rgb: 'each',
    validate(p) {
      if (['variance', 'outliersBright', 'outliersDark'].indexOf(p.type) < 0) throw bad('rank type');
      if (!isNum(p.radius) || p.radius < 0 || p.radius > (p.type === 'variance' ? 1000 : 100)) throw bad('radius');
      if (p.type !== 'variance' && (!isNum(p.threshold) || p.threshold < 0)) throw bad('threshold');
    },
    // The LUT is not journaled state: it is copied in while the request is accepted (a replay reads the params only).
    resolve(view, params, chans) {
      const p = Object.assign({}, params);
      if (p.type !== 'variance') {
        p.invertedLuts = Object.assign({}, p.invertedLuts);
        for (const c of chans) if (p.invertedLuts[c] === undefined) p.invertedLuts[c] = !!(root.IJShared && root.IJShared.hasInvertedLut(view.channels[c].display));
      }
      return p;
    },
    scratchBytes(info, p) {
      const k = rankKernel(p.radius);
      return bandBytes(info, k.kRadius, k.kRadius, 1) + 4 * (info.region ? info.region.w : info.width) * 2;
    },
    prepare(view, c, p, ctx) {
      const k = rankKernel(p.radius);
      const bd = view.bitDepth, kR = k.kRadius;
      const tk = ticker(ctx);
      let mode = MODE_VARIANCE, sign = 1;
      if (p.type !== 'variance') {
        mode = MODE_OUTLIERS;
        /* RankFilters.rank:  if (filterType == OUTLIERS)  //sign is -1 for high outliers: compare number with minimum
         *     minMaxOutliersSign = (ip.isInvertedLut()==(whichOutliers==DARK_OUTLIERS)) ? -1f : 1f;  */
        const inverted = !!(p.invertedLuts && p.invertedLuts[c]);
        sign = (inverted === (p.type === 'outliersDark')) ? -1 : 1;
      }
      return {
        apron: { x: kR, y: kR },
        region: async (full, rect) => floatToTypeKeep(await rankPass(full.data, full.width, full.height, rect, k, mode, sign, p.threshold, maxOf(bd), tk, 0, 1), bd)
      };
    }
  });

  /* writeLineToPixels:  bPixels[p] = (byte)(((int)(values[i] + 0.5f))&0xff);   (short: & 0xffff). Variance is clipped to
   * the type's range and the other values are existing pixel values, so the mask never bites. */
  function floatToTypeKeep(f, bd) {
    if (bd === 32) return f;
    const n = f.length, o = typedFor(bd, n), m = bd === 8 ? 0xff : 0xffff;
    for (let i = 0; i < n; i++) o[i] = jint(fround(f[i] + 0.5)) & m;
    return o;
  }

  // Remove NaNs
  REG.define('removeNaNs', {
    kind: 'pixel', version: 1, stack: 'ask', rgb: false, bitDepths: [32],
    validate(p) { if (!isNum(p.radius) || p.radius < 0 || p.radius > 100) throw bad('radius'); },
    scratchBytes(info, p) { const k = rankKernel(p.radius); return bandBytes(info, k.kRadius, k.kRadius, 1) + 4 * (info.region ? info.region.w : info.width) * 2; },
    prepare(view, c, p, ctx) {
      const k = rankKernel(p.radius), kR = k.kRadius, tk = ticker(ctx);
      return { apron: { x: kR, y: kR }, region: (full, rect) => rankPass(full.data, full.width, full.height, rect, k, MODE_NAN, 1, 0, NaN, tk, 0, 1) };
    }
  });

  // Top Hat
  /* RankFilters.rank for TOP_HAT: two passes, the first on the selection grown by (kRadius, kHeight/2):
   *     boolean invert = (invertedLut && !lightBackground) || (!invertedLut && lightBackground);
   *     minMaxOutliersSign = invert ? 1f : -1f;
   *     filterType1 = (minMaxOutliersSign == -1f) ? MIN : MAX;  ... doFiltering(type1) ...
   *     filterType2 = (minMaxOutliersSign == -1f) ? MAX : MIN;  doFiltering(type2, -minMaxOutliersSign)
   * A dark background is therefore opened (min then max), a light one closed (max then min). Unless "Don't subtract":
   *     float offset = 0;
   *     if (minMaxOutliersSign == 1f && !(ip instanceof FloatProcessor)) offset = (float)ip.maxValue();
   *     pixels[p] = snapPixels[p] - pixels[p] + offset;
   * (original − opened, or original − closed + 255 / 65535; float: no offset). With "Don't subtract" the opened /
   * closed image is the result. The second pass reads the first pass' output, which covers the selection plus the
   * kernel reach (the apron is 2r in all). */
  REG.define('topHat', {
    kind: 'pixel', version: 1, stack: 'ask', rgb: 'each', preview: 'reduced',
    validate(p) {
      if (!isNum(p.radius) || p.radius < 0 || p.radius > 1000) throw bad('radius');
      for (const f of ['light', 'dontSubtract']) if (p[f] !== undefined && typeof p[f] !== 'boolean') throw bad(f);
    },
    resolve(view, params, chans) {
      const p = Object.assign({}, params);
      p.invertedLuts = Object.assign({}, p.invertedLuts);
      for (const c of chans) if (p.invertedLuts[c] === undefined) p.invertedLuts[c] = !!(root.IJShared && root.IJShared.hasInvertedLut(view.channels[c].display));
      return p;
    },
    scratchBytes(info, p) {
      const k = rankKernel(p.radius);
      if (k.kRadius >= WHOLE_APRON) {
        // r1 = the selection grown by kRadius, clamped to the image, then two region-sized floats (first pass out, result)
        const reg = info.region || { w: info.width, h: info.height };
        const r1w = Math.min(info.width, reg.w + 2 * k.kRadius), r1h = Math.min(info.height, reg.h + 2 * k.kRadius);
        // + minMaxPassInt's row cache (2kR+1 rows) and column maxima (at most kR+1 arrays), Int32, rect width + 2kR
        return r1w * r1h * 4 * 2 + reg.w * reg.h * 4 * 2 + (3 * k.kRadius + 2) * (r1w + 2 * k.kRadius) * 4;
      }
      const regW = info.region ? info.region.w : info.width;
      return bandBytes(info, 2 * k.kRadius, 2 * k.kRadius, 2) + bandBytes(info, k.kRadius, k.kRadius, 3) +
        (3 * k.kRadius + 2) * (regW + 4 * k.kRadius) * 4;
    },
    prepare(view, c, p, ctx) {
      const sc = (ctx && ctx.scale) || 1;
      const k = rankKernel(p.radius / sc);
      const kR = k.kRadius, bd = view.bitDepth, tk = ticker(ctx);
      const inverted = !!(p.invertedLuts && p.invertedLuts[c]);
      const light = !!p.light;
      const invert = (inverted && !light) || (!inverted && light);
      const sign = invert ? 1 : -1;
      const dontSubtract = !!p.dontSubtract;
      const compute = async (full, rect) => {
        const W = full.width, H = full.height;
        const r1x = Math.max(0, rect.x - kR), r1y = Math.max(0, rect.y - kR);
        const r1 = { x: r1x, y: r1y, w: Math.min(W, rect.x + rect.w + kR) - r1x, h: Math.min(H, rect.y + rect.h + kR) - r1y };
        const mm = bd === 32 ? minMaxPass : minMaxPassInt;
        const st1 = await mm(full.data, W, H, r1, k, sign, tk, 0, 0.5);
        const r2 = { x: rect.x - r1.x, y: rect.y - r1.y, w: rect.w, h: rect.h };
        const st2 = await mm(st1, r1.w, r1.h, r2, k, -sign, tk, 0.5, 1);
        if (dontSubtract) return floatToTypeKeep(st2, bd);
        const offset = (sign === 1 && bd !== 32) ? (bd === 8 ? 255 : 65535) : 0;
        const s = full.data, n = rect.w * rect.h;
        const res = new Float32Array(n);
        for (let y = 0; y < rect.h; y++) {
          const sb = (rect.y + y) * W + rect.x, ob = y * rect.w;
          for (let x = 0; x < rect.w; x++) res[ob + x] = fround(fround(s[sb + x] - st2[ob + x]) + offset);
        }
        return floatToType(res, bd);
      };
      return {
        whole: kR >= WHOLE_APRON,
        apron: { x: 2 * kR, y: 2 * kR },
        region: growingRegion(compute, kR >= WHOLE_APRON)
      };
    }
  });

  // ----------------------------------------------------------------------------------------------------------
  // Math
  // ----------------------------------------------------------------------------------------------------------
  /* ij.plugin.filter.ImageMath → ImageProcessor.process(op, value), per type.
   *
   * ByteProcessor (ImageProcessor.process: a 256-entry table, applied with applyTable):
   *     double SCALE = 255.0/Math.log(255.0);
   *     LOG:   if (i==0) v = 0; else v = (int)(Math.log(i) * SCALE);
   *     EXP:   v = (int)(Math.exp(i/SCALE));
   *     SQR:   v = i*i;            SQRT: v = (int)Math.sqrt(i);
   *     GAMMA: v = (int)(Math.exp(Math.log(i/255.0)*value)*255.0);
   *     AND/OR/XOR: v = i & (int)value ...      then  if (v < 0) v = 0; if (v > 255) v = 255;
   * ShortProcessor.process (relative to the DISPLAY range: `double range = getMax()-getMin();` and
   * `int min2 = (int)getMin() - offset; int max2 = (int)getMax() - offset;`):
   *     GAMMA: if (range<=0.0 || v1==min2) v2 = v1; else v2 = (int)(Math.exp(value*Math.log((v1-min2)/range))*range+min2);
   *     LOG:   if (v1<=0) v2 = 0; else v2 = (int)(Math.log(v1)*(max2/Math.log(max2)));
   *     EXP:   v2 = (int)(Math.exp(v1*(Math.log(max2)/max2)));
   *     SQR:   double d1 = v1; v2 = (int)(d1*d1);      SQRT: v2 = (int)Math.sqrt(v1);
   *     AND:   v2 = v1 & intValue ...                  then clamped to 0..65535
   *   The display range is not journaled state: `resolve` copies it into params.ranges[c] (ShortProcessor.setMinAndMax
   *   rounds it: min = (int)Math.round(minimum), and 0..0 means "reset to the data range").
   * FloatProcessor.process (float arithmetic, c = (float)value):
   *     GAMMA: if (v1<=0f) v2 = 0f; else v2 = (float)Math.exp(c*Math.log(v1));
   *     LOG:   v2 = (float)Math.log(v1);   EXP: v2 = (float)Math.exp(v1);   SQR: v2 = v1*v1;
   *     SQRT:  if (v1<=0f) v2 = 0f; else v2 = (float)Math.sqrt(v1);
   *   and for Reciprocal (ImageMath.run):  value==0f?Float.NaN:1f/value  (32-bit only: "canceled = true; return" otherwise).
   * FloatProcessor.and / or / xor are empty methods (they do nothing): this port refuses them on 32 bits instead.
   * ImageMath: "gammaValue<0.05 || gammaValue>5.0 → Gamma must be between 0.05 and 5.0"; AND / OR / XOR take a
   * binary string (Integer.parseInt(andValue,2), a NumberFormatException is an error). */
  const MATH_OPS = ['log', 'exp', 'sqr', 'sqrt', 'reciprocal', 'gamma', 'and', 'or', 'xor'];

  function lut8(op, value) {
    const SCALE = 255.0 / Math.log(255.0);
    const lut = new Uint8Array(256);
    const iv = jint(value);
    for (let i = 0; i < 256; i++) {
      let v;
      switch (op) {
        case 'log': v = i === 0 ? 0 : jint(Math.log(i) * SCALE); break;
        case 'exp': v = jint(Math.exp(i / SCALE)); break;
        case 'sqr': v = i * i; break;
        case 'sqrt': v = jint(Math.sqrt(i)); break;
        case 'gamma': v = jint(Math.exp(Math.log(i / 255.0) * value) * 255.0); break;
        case 'and': v = i & iv; break;
        case 'or': v = i | iv; break;
        case 'xor': v = i ^ iv; break;
        default: v = i;
      }
      lut[i] = v < 0 ? 0 : (v > 255 ? 255 : v);
    }
    return lut;
  }

  function lut16(op, value, dmin, dmax) {
    const range = dmax - dmin;
    const min2 = jint(dmin), max2 = jint(dmax);
    const intValue = jint(value);
    const lut = new Uint16Array(65536);
    for (let v1 = 0; v1 < 65536; v1++) {
      let v2;
      switch (op) {
        case 'gamma':
          if (range <= 0.0 || v1 === min2) v2 = v1;
          else v2 = jint(Math.exp(value * Math.log((v1 - min2) / range)) * range + min2);
          break;
        case 'log': v2 = v1 <= 0 ? 0 : jint(Math.log(v1) * (max2 / Math.log(max2))); break;
        case 'exp': v2 = jint(Math.exp(v1 * (Math.log(max2) / max2))); break;
        case 'sqr': { const d1 = v1; v2 = jint(d1 * d1); break; }
        case 'sqrt': v2 = jint(Math.sqrt(v1)); break;
        case 'and': v2 = v1 & intValue; break;
        case 'or': v2 = v1 | intValue; break;
        case 'xor': v2 = v1 ^ intValue; break;
        default: v2 = v1;
      }
      lut[v1] = v2 < 0 ? 0 : (v2 > 65535 ? 65535 : v2); // ShortProcessor.process: if (v2 < 0) v2 = 0; if (v2 > 65535) v2 = 65535;
    }
    return lut;
  }

  function mathFloat(op, value, d) {
    const n = d.length, o = new Float32Array(n), c = fround(value);
    switch (op) {
      case 'log': for (let i = 0; i < n; i++) o[i] = Math.log(d[i]); break;
      case 'exp': for (let i = 0; i < n; i++) o[i] = Math.exp(d[i]); break;
      case 'sqr': for (let i = 0; i < n; i++) { const v = d[i]; o[i] = v * v; } break;
      case 'sqrt': for (let i = 0; i < n; i++) { const v = d[i]; o[i] = v <= 0 ? 0 : Math.sqrt(v); } break;
      case 'gamma': for (let i = 0; i < n; i++) { const v = d[i]; o[i] = v <= 0 ? 0 : Math.exp(c * Math.log(v)); } break;
      case 'reciprocal': for (let i = 0; i < n; i++) { const v = d[i]; o[i] = v === 0 ? NaN : 1 / v; } break; // stored through Float32Array = (float)
      default: o.set(d);
    }
    return o;
  }

  REG.define('math2', {
    kind: 'pixel', version: 1, stack: 'ask', rgb: 'each', preview: 'region',
    validate(p, info) {
      if (MATH_OPS.indexOf(p.op) < 0) throw bad('math op');
      if (p.op === 'gamma' && !(isNum(p.value) && p.value >= 0.05 && p.value <= 5.0)) throw bad('gamma value');
      if ((p.op === 'and' || p.op === 'or' || p.op === 'xor')) {
        if (!Number.isInteger(p.value) || p.value < -2147483648 || p.value > 2147483647) throw bad('binary value');
        if (info && info.bitDepth === 32) throw fail('IJ_BAD_TYPE', 'AND / OR / XOR need an 8 or 16-bit image');
      }
      if (p.op === 'reciprocal' && info && info.bitDepth !== 32) throw fail('IJ_BAD_TYPE', 'Reciprocal needs a 32-bit image');
    },
    // A 16-bit result is relative to the display range, which is not journaled state.
    resolve(view, params, chans) {
      const p = Object.assign({}, params);
      if (view.bitDepth === 16 && p.displayMin === undefined) {
        p.ranges = Object.assign({}, p.ranges);
        for (const c of chans) if (!p.ranges[c]) { const d = view.channels[c].display; p.ranges[c] = { min: d.min, max: d.max }; }
      }
      return p;
    },
    scratchBytes: () => 0,
    prepare(view, c, p, ctx) {
      const bd = view.bitDepth, op = p.op;
      const none = { x: 0, y: 0 };
      if (bd === 8) {
        const lut = lut8(op, p.value);
        return { apron: none, fn(src) { const d = src.data, o = new Uint8Array(d.length); for (let i = 0; i < d.length; i++) o[i] = lut[d[i]]; return o; } };
      }
      if (bd === 16) {
        let lo, hi;
        const r = p.ranges && p.ranges[c];
        if (r) { lo = r.min; hi = r.max; } else if (isNum(p.displayMin) && isNum(p.displayMax)) { lo = p.displayMin; hi = p.displayMax; } else { const dr = ctx.range(c); lo = dr.min; hi = dr.max; }
        lo = jround(lo); hi = jround(hi);
        if (lo === 0 && hi === 0) { const dr = ctx.range(c); lo = dr.min; hi = dr.max; } // setMinAndMax(0, 0) = resetMinAndMax
        const lut = lut16(op, p.value, lo, hi);
        return { apron: none, fn(src) { const d = src.data, o = new Uint16Array(d.length); for (let i = 0; i < d.length; i++) o[i] = lut[d[i]]; return o; } };
      }
      return { apron: none, fn: (src) => mathFloat(op, p.value, src.data) };
    }
  });

  /* ImageMath.setBackgroundToNaN: the loop runs over the WHOLE image ("for (int y=0; y<height; y++) for (int x=0; x<width; x++)")
   * whatever the selection is (the runner only restores the pixels inside the selection rectangle that lie outside its
   * mask), so the op ignores the selection:  if (v<lower || v>upper) pixels[y*width+x] = Float.NaN;  The thresholds are
   * those of the thresholded 32-bit image ("Thresholded 32-bit float image required"); the command takes them from the
   * Threshold window. A NaN stays NaN. */
  REG.define('nanBackground', {
    kind: 'pixel', version: 1, stack: 'ask', rgb: false, bitDepths: [32], channels: 'one', roi: 'ignore', preview: false,
    validate(p) { if (!isNum(p.lower) || !isNum(p.upper) || p.lower > p.upper) throw bad('threshold range'); },
    scratchBytes: () => 0,
    prepare(view, c, p) {
      const lo = p.lower, hi = p.upper;
      return {
        apron: { x: 0, y: 0 },
        fn(src) {
          const d = src.data, o = new Float32Array(d.length);
          for (let i = 0; i < d.length; i++) { const v = d[i]; o[i] = (v < lo || v > hi) ? NaN : v; }
          return o;
        }
      };
    }
  });

  /* ImageProcessor.resetMinAndMax of Convolver / ImageMath.setBackgroundToNaN: the display range becomes the exact
   * minimum and maximum of the whole image (ShortProcessor / FloatProcessor.findMinAndMax; a float ignores NaN and
   * the infinities). A compute helper of the package, not a tool: no histogram bin edges, never the selection. */
  REG.define('fltDataRange', {
    kind: 'compute', version: 1, stack: 'plane', rgb: 'gray', channels: 'one', roi: 'ignore', preview: false,
    validate() {},
    scratchBytes: () => 0,
    async run(view, p, roi, io) {
      const c = Number.isInteger(io && io.channel) ? io.channel : (view.active || 0);
      if (!(c >= 0 && c < view.channels.length)) throw bad('channel');
      const d = view.channels[c].data;
      let min = Infinity, max = -Infinity;
      const isF = d instanceof Float32Array;
      for (let i = 0; i < d.length; i++) {
        const v = d[i];
        if (isF && v - v !== 0) continue;
        if (v < min) min = v;
        if (v > max) max = v;
      }
      if (min > max) { min = 0; max = 0; }
      return { min, max, bitDepth: view.bitDepth };
    }
  });

  // Pure helpers the commands and the tests share.
  root.IJFiltersPkg = {
    jint, floatToType, filter3x3Region, kernelScale,
    /* Integer.parseInt(text, 2): null when Java would throw a NumberFormatException. */
    parseBinary(text) {
      const s = String(text == null ? '' : text);
      if (!/^[+-]?[01]+$/.test(s)) return null;
      const v = parseInt(s, 2);
      return Number.isInteger(v) && v >= -2147483648 && v <= 2147483647 ? v : null;
    },
    /* Convolver.decodeKernel: rows split on newlines, values on whitespace. → { kw, kh, kernel } | { error: key } */
    parseKernel(text) {
      const t = String(text == null ? '' : text).trim();
      if (!t) return { error: 'dlg.flt.kernelEmpty' };
      const rows = t.split(/\r?\n/);
      const kh = rows.length;
      const first = rows[0].trim().split(/\s+/);
      const kw = first.length;
      const kernel = [];
      for (let y = 0; y < kh; y++) {
        const vals = rows[y].trim().split(/\s+/);
        if (vals.length !== kw) return { error: 'dlg.flt.kernelRagged' };
        for (const s of vals) {
          const v = Number(s);
          if (!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(s) || !Number.isFinite(v)) return { error: 'dlg.flt.kernelNaN' };
          kernel.push(v);
        }
      }
      if ((kw & 1) !== 1 || (kh & 1) !== 1) return { error: 'dlg.flt.kernelEven' };
      if (kw > 31 || kh > 31) return { error: 'dlg.flt.kernelBig' };
      return { kw, kh, kernel };
    }
  };
})(typeof self !== 'undefined' ? self : globalThis);
