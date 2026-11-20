/* ij-proc-fft.js — package P-fft (wave 3): the Process › FFT family and Analyze › Directionality.
 *
 * Loaded on the page AND in the worker (ij-worker.js loads it in its own try/catch). Pure: no DOM, no engine
 * globals; the operations are registered with IJOpRegistry.define(name, spec) (ij-core.js).
 *
 *   fft                newdoc   ij.plugin.FFT.run("fft"): "FFT of <name>" (8-bit power spectrum) and/or "PS of <name>" (32-bit raw)
 *   inverseFft         newdoc   ij.plugin.FFT.run("inverse") + doMasking: the power spectrum, edited, masks the transform
 *   bandpass           pixel    ij.plugin.filter.FFTFilter.filter (whole; the selection's bounding rectangle only)
 *   bandpassFilter     newdoc   the "Display filter" image of FFTFilter.filterLargeSmall (an op of this package beyond the frozen table)
 *   swapQuadrants      pixel    ij.plugin.FFT.swapQuadrants (square images)
 *   directionality     compute  Fourier components / Local gradient orientation (Liu 1991), Gaussian fit of the histogram
 *
 * Reference: ImageJ 1.54p (public domain), FHT.java / FFT.java / FFTFilter.java, ported line by line. Every Java float
 * operation is rounded to float (Math.fround) exactly where Java rounds it: a double + - * / of two floats rounded once
 * to float is the correctly rounded float result, so only NESTED expressions need an explicit fround per operation.
 * The Fast Hartley Transform (Bracewell 1986, Arlo Reeves' NIH Image code) was released to the public domain by
 * Stanford in 1995.
 *
 * Directionality is NOT a port: the plugin (Fiji, GPL) was only run. It follows Liu (1991) and the public description of
 * the method and is calibrated against tests/fixtures/ij-wave3/fiji/directionality/gratings.json (see the DIRECTIONALITY
 * section for what is measured and what is a choice).
 *
 * Determinism: no clock, no random number; the band size never matters (these operations take the whole image).
 */
(function (root) {
  'use strict';
  const fround = Math.fround;
  const R = root.IJOpRegistry;

  function ijError(code, message) { const e = new Error(message || code); e.code = code; return e; }

  // Java (int) of a double: NaN -> 0, saturating, truncating toward zero.
  function d2i(x) {
    if (x !== x) return 0;
    if (x >= 2147483647) return 2147483647;
    if (x <= -2147483648) return -2147483648;
    return x < 0 ? Math.ceil(x) : Math.floor(x);
  }
  const bytesOf = (bd) => (bd === 8 ? 1 : bd === 16 ? 2 : 4);
  const ctorOf = (bd) => (bd === 8 ? Uint8Array : bd === 16 ? Uint16Array : Float32Array);
  const isNum = (v) => typeof v === 'number' && isFinite(v);

  // Largest padded side the package accepts (PLAN-wave3 §0: memory cap, ImageJ's own limit is 65536 — FFT.java:344).
  const MAX_PADDED = 8192;

  // A cooperative loop: `hooks.check()` / `hooks.tick(f)` about every STEP_WORK elementary operations, counted, never timed.
  const noHooks = { check() {}, tick() {} };
  const STEP_WORK = 1 << 19;
  // Cooperative cancellation of a synchronous loop: check() once per STEP_WORK elements, counted by index (never timed).
  const stepCheck = (h, i) => { if ((i & (STEP_WORK - 1)) === STEP_WORK - 1) h.check(); };
  const hooksOf = (io, key) => (io ? { check: () => io.check(), tick: (f) => io.tick(Math.min(1, Math.max(0, f)), key) } : noHooks);

  // ======================================================================================================
  // FHT — ij/process/FHT.java
  // ======================================================================================================
  const tableCache = new Map();

  /* makeSinCosTables / makeBitReverseTable (FHT.java:211-229, 386-392). The angle is accumulated, as Java does
   * ("theta += dTheta"), and rounded to float when stored. */
  function fhtTables(maxN) {
    let T = tableCache.get(maxN);
    if (T) return T;
    const n = maxN >> 2;
    const C = new Float32Array(n), S = new Float32Array(n);
    let theta = 0.0;
    const dTheta = 2.0 * Math.PI / maxN;
    for (let i = 0; i < n; i++) { C[i] = Math.cos(theta); S[i] = Math.sin(theta); theta += dTheta; }
    let nLog2 = 31;
    while (!(maxN & (1 << nLog2))) nLog2--;
    const bitrev = new Int32Array(maxN);
    for (let i = 0; i < maxN; i++) {
      let temp = 0;
      for (let b = 0; b <= nLog2; b++) if (i & (1 << b)) temp |= (1 << (nLog2 - b - 1));
      bitrev[i] = temp;
    }
    T = { n: maxN, C, S, bitrev, log2: nLog2 };
    if (tableCache.size > 8) tableCache.clear();
    tableCache.set(maxN, T);
    return T;
  }

  /* FHT.dfht3 (FHT.java:278-350): the optimised 1D FHT of x[base .. base+maxN). `tmp` = scratch of maxN floats.
   * "rt1 = x[Ad2]*C + x[Ad4]*S" is evaluated in float: each product and the sum are rounded. */
  function dfht3(x, base, inverse, maxN, T, tmp) {
    const C = T.C, S = T.S, bitrev = T.bitrev, Nlog2 = T.log2;
    for (let i = 0; i < maxN; i++) tmp[i] = x[base + bitrev[i]];
    for (let i = 0; i < maxN; i++) x[base + i] = tmp[i];
    let gpSize = 2;
    let numGps = maxN >> 2;
    for (let gpNum = 0; gpNum < numGps; gpNum++) {
      const Ad1 = base + gpNum * 4, Ad2 = Ad1 + 1, Ad3 = Ad1 + gpSize, Ad4 = Ad2 + gpSize;
      const rt1 = x[Ad1] + x[Ad2];   // a + b
      const rt2 = x[Ad1] - x[Ad2];   // a - b
      const rt3 = x[Ad3] + x[Ad4];   // c + d
      const rt4 = x[Ad3] - x[Ad4];   // c - d
      // each is a float (a Float32Array store rounds it); the double sums below add two floats once
      const f1 = fround(rt1), f2 = fround(rt2), f3 = fround(rt3), f4 = fround(rt4);
      x[Ad1] = f1 + f3;
      x[Ad2] = f2 + f4;
      x[Ad3] = f1 - f3;
      x[Ad4] = f2 - f4;
    }
    if (Nlog2 > 2) {
      gpSize = 4;
      let numBfs = 2;
      numGps = numGps >> 1;
      for (let stage = 2; stage < Nlog2; stage++) {
        for (let gpNum = 0; gpNum < numGps; gpNum++) {
          const Ad0 = gpNum * gpSize * 2;
          let Ad1 = base + Ad0, Ad2 = Ad1 + gpSize, Ad3 = Ad1 + (gpSize >> 1), Ad4 = Ad3 + gpSize;
          let rt1 = x[Ad1];
          x[Ad1] = x[Ad1] + x[Ad2];
          x[Ad2] = rt1 - x[Ad2];
          rt1 = x[Ad3];
          x[Ad3] = x[Ad3] + x[Ad4];
          x[Ad4] = rt1 - x[Ad4];
          for (let bfNum = 1; bfNum < numBfs; bfNum++) {
            Ad1 = bfNum + Ad0 + base;
            Ad2 = Ad1 + gpSize;
            Ad3 = gpSize - bfNum + Ad0 + base;
            Ad4 = Ad3 + gpSize;
            const CSAd = bfNum * numGps;
            const cs = C[CSAd], sn = S[CSAd];
            const x2 = x[Ad2], x4 = x[Ad4];
            rt1 = fround(fround(x2 * cs) + fround(x4 * sn));
            const rt2 = fround(fround(x4 * cs) - fround(x2 * sn));
            x[Ad2] = x[Ad1] - rt1;
            x[Ad1] = x[Ad1] + rt1;
            x[Ad4] = x[Ad3] + rt2;
            x[Ad3] = x[Ad3] - rt2;
          }
        }
        gpSize *= 2;
        numBfs *= 2;
        numGps = numGps >> 1;
      }
    }
    if (inverse) for (let i = 0; i < maxN; i++) x[base + i] = x[base + i] / maxN;
  }

  // FHT.transposeR: a pure permutation, done in 32 x 32 tiles (the order of the swaps cannot change the result); the
  // caller's check() runs between rows of tiles so Cancel is heard on a 8192 x 8192 image too.
  async function transpose(x, n, hooks) {
    const B = 32;
    const rowsPerStep = Math.max(1, Math.floor(STEP_WORK / (n * B)));
    for (let r0 = 0, k = 0; r0 < n; r0 += B, k++) {
      for (let c0 = r0; c0 < n; c0 += B) {
        const rEnd = Math.min(n, r0 + B), cEnd = Math.min(n, c0 + B);
        for (let r = r0; r < rEnd; r++) {
          for (let c = (c0 === r0 ? r + 1 : c0); c < cEnd; c++) {
            const a = r * n + c, b = c * n + r;
            const t = x[a]; x[a] = x[b]; x[b] = t;
          }
        }
      }
      if (hooks && (k + 1) % rowsPerStep === 0) hooks.check();
    }
  }

  /* FHT.rc2DFHT (FHT.java:232-263): rows, transpose, rows, transpose, then Bracewell's correction
   * "E = ((A + D) - (B + C)) / 2" on the four mirrored samples. Async only to give the caller a chance to
   * check / tick (every STEP_WORK elements); the arithmetic is the same as the Java one. */
  async function rc2DFHT(x, inverse, n, hooks) {
    const h = hooks || noHooks;
    const T = fhtTables(n);
    const tmp = new Float32Array(n);
    const rowsPerStep = Math.max(1, Math.floor(STEP_WORK / (n * Math.max(1, T.log2))));
    for (let row = 0; row < n; row++) {
      dfht3(x, row * n, inverse, n, T, tmp);
      if ((row + 1) % rowsPerStep === 0) { h.check(); await h.tick(0.4 * (row + 1) / n); }
    }
    await transpose(x, n, h);
    for (let row = 0; row < n; row++) {
      dfht3(x, row * n, inverse, n, T, tmp);
      if ((row + 1) % rowsPerStep === 0) { h.check(); await h.tick(0.4 + 0.3 * (row + 1) / n); }
    }
    await transpose(x, n, h);
    h.check();
    await h.tick(0.75);
    const half = n >> 1;
    for (let row = 0; row <= half; row++) {
      const mRow = (n - row) % n;
      for (let col = 0; col <= half; col++) {
        const mCol = (n - col) % n;
        const iA = row * n + col, iB = mRow * n + col, iC = row * n + mCol, iD = mRow * n + mCol;
        const A = x[iA], B = x[iB], C = x[iC], D = x[iD];
        const E = fround(fround(fround(A + D) - fround(B + C)) / 2);
        x[iA] = A - E;
        x[iB] = B + E;
        x[iC] = C + E;
        x[iD] = D - E;
      }
      if ((row + 1) % Math.max(1, Math.floor(STEP_WORK / n)) === 0) { h.check(); await h.tick(0.75 + 0.25 * row / (half + 1)); }
    }
  }

  /* FFT.swapQuadrants(ImageProcessor) (FFT.java:458-477), generic typed array: size = width/2 (integer division);
   * quadrants 1 <-> 3 and 2 <-> 4. ImageJ crops the two quadrants of a pair and inserts each in the other's place; the
   * four windows never overlap, so the same result is four element exchanges. The last row and column of an odd image
   * (not part of any window) are not touched, as in ImageJ. Returns a new array unless `inPlace`. */
  function swapQuadrants(data, width, height, inPlace, hooks) {
    const hk = hooks || noHooks;
    const out = inPlace ? data : data.slice();
    const size = width >> 1;
    for (let y = 0; y < size && y + size < height; y++) {
      stepCheck(hk, y * size + size - 1);
      const o1 = y * width, o2 = (y + size) * width;
      for (let x = 0; x < size; x++) {
        let t = out[o1 + x]; out[o1 + x] = out[o2 + x + size]; out[o2 + x + size] = t;            // top left <-> bottom right
        t = out[o1 + x + size]; out[o1 + x + size] = out[o2 + x]; out[o2 + x] = t;                // top right <-> bottom left
      }
    }
    return out;
  }

  /* FHT.getPowerSpectrum (FHT.java:401-446) and getRawPowerSpectrum (:449-457).
   *   fht2ps:  ps = (sqr(fht[i]) + sqr(fht[l]))/2f, l = ((maxN-row)%maxN)*maxN + (maxN-c)%maxN       (float)
   *   "max = (float)Math.log(max); min = (float)Math.log(min); if (Float.isNaN(min) || max-min>50) min = max - 50;
   *    scale = (float)(253.999/(max-min));  r = ((float)Math.log(r)-min)*scale;  ps = (byte)(r+1f)"  (1..254)
   * The raw spectrum (32-bit, unswapped) is returned too: the 8-bit one is `ps8` already swapped. */
  async function powerSpectrum(fht, n, hooks) {
    const h = hooks || noHooks;
    const fps = new Float32Array(n * n);
    let min = 3.4028234663852886e38; // Float.MAX_VALUE
    let max = 1.401298464324817e-45; // Float.MIN_VALUE (the smallest POSITIVE float)
    const rowsPerStep = Math.max(1, Math.floor(STEP_WORK / n));
    for (let row = 0; row < n; row++) {
      const base = row * n;
      const rowL = ((n - row) % n) * n;
      for (let c = 0; c < n; c++) {
        const a = fht[base + c], b = fht[rowL + ((n - c) % n)];
        const r = fround(fround(fround(a * a) + fround(b * b)) / 2);
        fps[base + c] = r;
        if (r < min) min = r;
        if (r > max) max = r;
      }
      if ((row + 1) % rowsPerStep === 0) { h.check(); await h.tick(0.3 * (row + 1) / n); }
    }
    max = fround(Math.log(max));
    min = fround(Math.log(min));
    if (min !== min || fround(max - min) > 50) min = fround(max - 50);
    const scale = fround(253.999 / fround(max - min));
    const ps = new Uint8Array(n * n);
    for (let row = 0; row < n; row++) {
      const base = row * n;
      for (let c = 0; c < n; c++) {
        let r = fround(fround(fround(Math.log(fps[base + c])) - min) * scale);
        if (r !== r || r < 0) r = 0;
        ps[base + c] = d2i(fround(r + 1));
      }
      if ((row + 1) % rowsPerStep === 0) { h.check(); await h.tick(0.3 + 0.3 * (row + 1) / n); }
    }
    swapQuadrants(ps, n, n, true);
    return { ps8: ps, fps };
  }

  /* The mean of the 8-bit power spectrum (what FFT stores as `powerSpectrumMean = ps.getStats().mean`) without building
   * the spectrum: the same float arithmetic as powerSpectrum(), two passes (extremes, then the bytes' sum). */
  function powerSpectrumMean(fht, n, hooks) {
    const h = hooks || noHooks;
    const sq = (v) => fround(v * v);
    let min = 3.4028234663852886e38, max = 1.401298464324817e-45;
    const at = (row, c) => fround(fround(sq(fht[row * n + c]) + sq(fht[((n - row) % n) * n + ((n - c) % n)])) / 2);
    for (let row = 0; row < n; row++) {
      for (let c = 0; c < n; c++) { const r = at(row, c); if (r < min) min = r; if (r > max) max = r; }
      stepCheck(h, row * n + n - 1);
    }
    max = fround(Math.log(max));
    min = fround(Math.log(min));
    if (min !== min || fround(max - min) > 50) min = fround(max - 50);
    const scale = fround(253.999 / fround(max - min));
    let sum = 0;
    for (let row = 0; row < n; row++) {
      for (let c = 0; c < n; c++) {
        let r = fround(fround(fround(Math.log(at(row, c))) - min) * scale);
        if (r !== r || r < 0) r = 0;
        sum += d2i(fround(r + 1));
      }
      stepCheck(h, row * n + n - 1);
    }
    return sum / (n * n);
  }

  // ======================================================================================================
  // FFT — ij/plugin/FFT.java
  // ======================================================================================================

  // The mean ImageStatistics.getStatistics(ip, MEAN, null) reports: exact integer sums for 8 / 16 bits, a double
  // running sum in row-major order for floats (FloatStatistics.getStatistics: "sum += v").
  function meanOf(data, bitDepth, hooks) {
    const h = hooks || noHooks;
    const n = data.length;
    if (bitDepth === 32) {
      let sum = 0;
      for (let i = 0; i < n; i++) { const v = data[i]; if (v >= -3.4028234663852886e38 && v <= 3.4028234663852886e38) sum += v; stepCheck(h, i); }
      let cnt = 0;
      for (let i = 0; i < n; i++) { const v = data[i]; if (v >= -3.4028234663852886e38 && v <= 3.4028234663852886e38) cnt++; stepCheck(h, i); }
      return sum / cnt;
    }
    let sum = 0;
    for (let i = 0; i < n; i++) { sum += data[i]; stepCheck(h, i); }
    return sum / n;
  }

  /* FFT.pad (FFT.java:332-356): "i = 2; while (i<maxN) i *= 2; if (i==maxN && w==h) no padding; ...
   * stats = getStatistics(ip, MEAN); ip2 = ip.createProcessor(maxN, maxN); ip2.setValue(stats.mean); ip2.fill();
   * ip2.insert(ip, 0, 0)". setValue truncates the mean on 8 and 16 bits (`fgColor = (int)value`, clamped), a float
   * processor keeps (float)value. Returns { side, padded, data: Float32Array(side*side) } (the FHT constructor's
   * convertToFloat). */
  function padToFloat(src, w, h, bitDepth, hooks) {
    const hk = hooks || noHooks;
    const maxN0 = Math.max(w, h);
    let side = 2;
    while (side < maxN0) side *= 2;
    if (side === maxN0 && w === h) {
      const data = new Float32Array(src.length);
      for (let i = 0; i < src.length; i++) { data[i] = src[i]; stepCheck(hk, i); }
      return { side, padded: false, data };
    }
    const mean = meanOf(src, bitDepth, hk);
    let fill;
    if (bitDepth === 32) fill = fround(mean);
    else { fill = d2i(mean); const top = bitDepth === 8 ? 255 : 65535; if (fill < 0) fill = 0; if (fill > top) fill = top; }
    const data = new Float32Array(side * side);
    data.fill(fill);
    for (let y = 0; y < h; y++) { const so = y * w, d0 = y * side; for (let x = 0; x < w; x++) data[d0 + x] = src[so + x]; stepCheck(hk, y * w + w - 1); }
    return { side, padded: true, data };
  }

  const cropRect = (data, W, rect) => {
    if (rect.x === 0 && rect.y === 0 && rect.w === W && data.length === rect.w * rect.h) return data;
    const out = new data.constructor(rect.w * rect.h);
    for (let y = 0; y < rect.h; y++) { const o = (rect.y + y) * W + rect.x; out.set(data.subarray(o, o + rect.w), y * rect.w); }
    return out;
  };

  // Two 32-bit lanes (FNV-1a over the words, and a position-weighted sum) of the values of an array: a source that
  // was edited since its transform has another one. Floats are read bit for bit.
  function fingerprint(data, bitDepth, hooks) {
    const h = hooks || noHooks;
    let a = 0x811c9dc5 | 0, b = 0;
    const n = data.length;
    const words = bitDepth === 32 ? new Uint32Array(data.buffer, data.byteOffset, n) : data;
    for (let i = 0; i < n; i++) {
      const v = words[i] | 0;
      a = Math.imul(a ^ v, 0x01000193);
      b = (b + Math.imul(v ^ (i + 1), 0x9e3779b1)) | 0;
      stepCheck(h, i);
    }
    return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0') + ':' + n + ':' + bitDepth;
  }

  /* FFT.doForwardTransform's transform of one image plane: crop (done by the caller), pad, FHT.transform().
   *   src      the plane, bitDepth 8 / 16 / 32, w x h
   * returns { fht, side, padded, origW, origH } with origW/origH = w, h. Refuses a padded side above MAX_PADDED. */
  async function forwardFht(src, w, h, bitDepth, hooks) {
    let side = 2;
    while (side < Math.max(w, h)) side *= 2;
    if (side > MAX_PADDED) throw ijError('IJ_FFT_TOO_LARGE', 'padded side ' + side + ' exceeds ' + MAX_PADDED);
    const p = padToFloat(src, w, h, bitDepth, hooks);
    await rc2DFHT(p.data, false, p.side, hooks);
    return { fht: p.data, side: p.side, padded: p.padded, origW: w, origH: h };
  }

  /* FFT.changeValuesAndSymmetrize (FFT.java:402-416) and smooth (:421-448), on a byte image n x n. */
  function changeValuesAndSymmetrize(pixels, n, v1, v2) {
    for (let i = 0; i < pixels.length; i++) {
      if (pixels[i] === v1) {            // the pixel has been edited for pass or filter: its symmetry-equivalent too
        if (i % n === 0) { if (i > 0) pixels[n * n - i] = v1; }        // left edge
        else if (i < n) pixels[n - i] = v1;                            // top edge
        else pixels[n * (n + 1) - i] = v1;                             // no edge
      } else pixels[i] = v2;                                            // reset all other pixel values
    }
  }
  function smooth(pixels, n, hooks) {
    const h = hooks || noHooks;
    const pixels2 = pixels.slice();
    const iMinus = new Int32Array(n), iPlus = new Int32Array(n);
    for (let i = 0; i < n; i++) { iMinus[i] = (i - 1 + n) % n; iPlus[i] = (i + 1) % n; }
    for (let y = 0; y < n; y++) {
      stepCheck(h, y * n + n - 1);
      const o1 = n * iMinus[y], o2 = n * y, o3 = n * iPlus[y];
      for (let x = 0; x < n; x++) {
        const sum = pixels2[o1 + iMinus[x]] + pixels2[o1 + x] + pixels2[o1 + iPlus[x]]
          + pixels2[o2 + iMinus[x]] + pixels2[o2 + x] + pixels2[o2 + iPlus[x]]
          + pixels2[o3 + iMinus[x]] + pixels2[o3 + x] + pixels2[o3 + iPlus[x]];
        pixels[o2 + x] = ((sum + 4) / 9) | 0;
      }
    }
  }

  /* ip.convertToByte(false) of an edited power spectrum of any depth (TypeConverter, doScaling false):
   *   16-bit  value = pixels16[i]&0xffff; if (value>255) value = 255
   *   32-bit  ByteProcessor.setPixels(0, fp): value = fPixels[i] + 0.5f; < 0 -> 0; > 255 -> 255; (byte)value */
  function toByteNoScale(data, bitDepth) {
    if (bitDepth === 8) return data.slice();
    const out = new Uint8Array(data.length);
    if (bitDepth === 16) { for (let i = 0; i < data.length; i++) out[i] = data[i] > 255 ? 255 : data[i]; return out; }
    for (let i = 0; i < data.length; i++) {
      let v = fround(data[i] + 0.5);
      if (v < 0) v = 0;
      if (v > 255) v = 255;
      out[i] = d2i(v);
    }
    return out;
  }

  /* FFT.doMasking (FFT.java:365-397): the 8-bit power spectrum as the operator edited it.
   *   no pixel 0 and none 255      -> no filtering (mode 'none')
   *   any 255                      -> pass mode:   changeValuesAndSymmetrize(mask, 255, 0)
   *   else (any 0)                 -> filter mode: changeValuesAndSymmetrize(mask, 0, 255)
   *   3 x smooth, swapQuadrants, fht[i] = (float)(fht[i]*(mask[i]&255)/255.0)
   * Modifies `fht` in place. Returns { mode, mean } (mean of the unedited-or-edited mask, for ImageJ's notice). */
  function applyMask(fht, n, maskData, maskW, maskH, maskBitDepth, hooks) {
    const hk = hooks || noHooks;
    if (maskW !== n || maskH !== n) return { mode: 'skip', mean: 0 };
    let mask = toByteNoScale(maskData, maskBitDepth);
    let h0 = 0, h255 = 0, sum = 0;
    for (let i = 0; i < mask.length; i++) { const v = mask[i]; sum += v; if (v === 0) h0++; else if (v === 255) h255++; stepCheck(hk, i); }
    const mean = sum / mask.length;
    if (h0 === 0 && h255 === 0) return { mode: 'none', mean };
    const pass = h255 !== 0;
    if (pass) changeValuesAndSymmetrize(mask, n, 255, 0);
    else changeValuesAndSymmetrize(mask, n, 0, 255);
    for (let i = 0; i < 3; i++) smooth(mask, n, hk);
    swapQuadrants(mask, n, n, true, hk);
    for (let i = 0; i < fht.length; i++) { fht[i] = fround(fht[i] * mask[i]) / 255.0; stepCheck(hk, i); }
    return { mode: pass ? 'pass' : 'filter', mean };
  }

  // FloatProcessor.findMinAndMax (1.54p): NaN is skipped, the infinities count.
  function floatMinMax(data, hooks) {
    const h = hooks || noHooks;
    let i = 0;
    const len = data.length;
    for (; i < len; i++) if (!Number.isNaN(data[i])) break;
    if (i >= len) return { min: NaN, max: NaN };
    let min = data[i], max = data[i];
    for (; i < len; i++) { const v = data[i]; if (v < min) min = v; else if (v > max) max = v; stepCheck(h, i); }
    return { min, max };
  }

  /* TypeConverter float -> 8 / 16 bits.
   *   doScaling 8-bit  FloatProcessor.create8BitImage: value = pixels[i]-min2 (double, min2 = getMin()); < 0 -> 0;
   *                    ivalue = (int)(value*scale+0.5), scale = 255.0/(max2-min2); > 255 -> 255
   *   doScaling 16-bit convertFloatToShort: scale = (max-min)==0 ? 1 : 65535.0/(max-min); value = (p-min)*scale;
   *                    clamp 0..65535; (short)(value+0.5)
   *   no scaling       8-bit = toByteNoScale(32), 16-bit: value = pixels32[i], clamp, (short)(value+0.5)
   * min / max are the float display range (doubles of floats). */
  function floatToType(data, bitDepth, doScaling, min, max) {
    const n = data.length;
    if (bitDepth === 32) return data;
    if (bitDepth === 8) {
      if (!doScaling) return toByteNoScale(data, 32);
      const out = new Uint8Array(n);
      const scale = 255.0 / (max - min);
      for (let i = 0; i < n; i++) {
        let value = data[i] - min;
        if (value < 0.0) value = 0.0;
        let iv = d2i(value * scale + 0.5);
        if (iv > 255) iv = 255;
        out[i] = iv;
      }
      return out;
    }
    const out = new Uint16Array(n);
    const scale = (max - min) === 0.0 ? 1.0 : 65535.0 / (max - min);
    for (let i = 0; i < n; i++) {
      let value = doScaling ? (data[i] - min) * scale : data[i];
      if (value < 0.0) value = 0.0;
      if (value > 65535.0) value = 65535.0;
      out[i] = d2i(value + 0.5) & 0xffff;
    }
    return out;
  }

  /* The display range the Java result image ends with. ContrastEnhancer.stretchHistogram(imp, saturated) of a float
   * processor: FloatStatistics with 256 bins between the extreme finite values, then the first / last bin whose running count
   * exceeds (int)(pixelCount*saturated/200.0); the range is histMin + bin*binSize, rounded to float. Nothing is set when
   * the last bin is not above the first one (ContrastEnhancer.java:132-151; getMinAndMax :154-185).
   * `fallback` = what the processor already holds in that case. */
  async function stretchRange(data, saturated, fallback, hooks) {
    const h = hooks || noHooks;
    const FMAX = 3.4028234663852886e38;
    const n = data.length;
    let roiMin = Number.MAX_VALUE, roiMax = -Number.MAX_VALUE;
    for (let i = 0; i < n; i++) {
      const v = data[i];
      if (v >= -FMAX && v <= FMAX) { if (v < roiMin) roiMin = v; if (v > roiMax) roiMax = v; }
      if ((i & 0x3ffff) === 0x3ffff) { h.check(); await h.tick(0.3 * i / n); }
    }
    const histMin = roiMin, histMax = roiMax;
    const nBins = 256;
    const binSize = (histMax - histMin) / nBins;
    const scale = nBins / (histMax - histMin);
    const hist = new Int32Array(nBins);
    let pixelCount = 0;
    for (let i = 0; i < n; i++) {
      const v = data[i];
      if (v >= -FMAX && v <= FMAX && v >= histMin && v <= histMax) {
        pixelCount++;
        let index = d2i(scale * (v - histMin));
        if (index >= nBins) index = nBins - 1;
        hist[index]++;
      }
      if ((i & 0x3ffff) === 0x3ffff) { h.check(); await h.tick(0.3 + 0.3 * i / n); }
    }
    if (!pixelCount) return fallback;
    const threshold = saturated > 0.0 ? d2i(pixelCount * saturated / 200.0) : 0;
    let i = -1, count = 0, found = false;
    do { i++; count += hist[i]; found = count > threshold; } while (!found && i < nBins - 1);
    const hmin = i;
    i = nBins; count = 0;
    do { i--; count += hist[i]; found = count > threshold; } while (!found && i > 0);
    const hmax = i;
    if (!(hmax > hmin)) return fallback;
    return { min: fround(histMin + hmin * binSize), max: fround(histMin + hmax * binSize) };
  }

  // ======================================================================================================
  // Bandpass — ij/plugin/filter/FFTFilter.java
  // ======================================================================================================

  function flipH(a, w, h) { for (let y = 0; y < h; y++) { const o = y * w; for (let x = 0, z = w - 1; x < z; x++, z--) { const t = a[o + x]; a[o + x] = a[o + z]; a[o + z] = t; } } }
  function flipV(a, w, h) { for (let y = 0, z = h - 1; y < z; y++, z--) { for (let x = 0; x < w; x++) { const t = a[y * w + x]; a[y * w + x] = a[z * w + x]; a[z * w + x] = t; } } }

  /* FFTFilter.tileMirror(ip, width, height, x, y) (FFTFilter.java:160-213): `src` (w2 x h2, already the crop) is put at
   * (x, y) of a width x height float image and mirrored around its edges, with the alternating flips of the Java code
   * (the loops are copied as they are, their inserts are clipped to the image like ip.insert). */
  function tileMirror(src, w2, h2, width, height, x, y, hooks) {
    const hk = hooks || noHooks;
    const out = new Float32Array(width * height);
    const ip2 = Float32Array.from(src);
    const i1 = Math.ceil(x / w2), i2 = Math.ceil((width - x) / w2);
    const j1 = Math.ceil(y / h2), j2 = Math.ceil((height - y) / h2);
    const insert = (dx, dy) => {
      for (let yy = 0; yy < h2; yy++) {
        const oy = dy + yy;
        if (oy < 0 || oy >= height) continue;
        stepCheck(hk, yy * w2 + w2 - 1);
        const xs = Math.max(0, -dx), xe = Math.min(w2, width - dx);
        for (let xx = xs; xx < xe; xx++) out[oy * width + dx + xx] = ip2[yy * w2 + xx];
      }
    };
    if ((i1 % 2) > 0.5) flipH(ip2, w2, h2);
    if ((j1 % 2) > 0.5) flipV(ip2, w2, h2);
    for (let i = -i1; i < i2; i += 2) for (let j = -j1; j < j2; j += 2) insert(x - i * w2, y - j * h2);
    flipH(ip2, w2, h2);
    for (let i = -i1 + 1; i < i2; i += 2) for (let j = -j1; j < j2; j += 2) insert(x - i * w2, y - j * h2);
    flipV(ip2, w2, h2);
    for (let i = -i1 + 1; i < i2; i += 2) for (let j = -j1 + 1; j < j2; j += 2) insert(x - i * w2, y - j * h2);
    flipH(ip2, w2, h2);
    for (let i = -i1; i < i2; i += 2) for (let j = -j1 + 1; j < j2; j += 2) insert(x - i * w2, y - j * h2);
    return out;
  }

  /* FFTFilter.filterLargeSmall (FFTFilter.java:225-405): multiplies the transform by the band-pass of the two
   * Gaussians (and the stripe term) IN PLACE, evaluating the filter per (row, col) — the Java code also keeps a second
   * full array only to display it, which is built here only when `filterOut` is given. Every factor is a Java float
   * ("float rowFactLarge = (float) Math.exp(...)", "factor = (1 - rowFactLarge*colFactLarge) * rowFactSmall*colFactSmall"):
   * each operation is rounded to float. `fht[i] *= factor` is one float product (a Float32Array store rounds it). */
  async function filterLargeSmall(fht, maxN, filterLarge, filterSmall, stripesHorVert, scaleStripes0, filterOut, hooks) {
    const hk = hooks || noHooks;
    const half = maxN >> 1;
    const scaleLarge = filterLarge * filterLarge;
    const scaleSmall = filterSmall * filterSmall;
    const scaleStripes = scaleStripes0 * scaleStripes0;
    const mul = filterOut
      ? (i, f) => { fht[i] *= f; filterOut[i] *= f; }
      : (i, f) => { fht[i] *= f; };
    const set0 = (i) => { fht[i] = 0; if (filterOut) filterOut[i] = 0; };
    const ex = (e) => fround(Math.exp(e));
    // loop over rows
    const rowsPerStep = Math.max(1, Math.floor(STEP_WORK / maxN));
    for (let j = 1; j < half; j++) {
      const row = j * maxN, backrow = (maxN - j) * maxN;
      const rowFactLarge = ex(-(j * j) * scaleLarge);
      const rowFactSmall = ex(-(j * j) * scaleSmall);
      for (let col = 1; col < half; col++) {
        const backcol = maxN - col;
        const colFactLarge = ex(-(col * col) * scaleLarge);
        const colFactSmall = ex(-(col * col) * scaleSmall);
        let factor = fround(fround(fround(1 - fround(rowFactLarge * colFactLarge)) * rowFactSmall) * colFactSmall);
        if (stripesHorVert === 1) factor = fround(factor * fround(1 - ex(-(col * col) * scaleStripes)));      // hor stripes
        else if (stripesHorVert === 2) factor = fround(factor * fround(1 - ex(-(j * j) * scaleStripes)));    // vert stripes
        mul(col + row, factor);
        mul(col + backrow, factor);
        mul(backcol + row, factor);
        mul(backcol + backrow, factor);
      }
      if (j % rowsPerStep === 0) { hk.check(); await hk.tick(j / half); }
    }

    // meeting points (maxN/2,0), (0,maxN/2), (maxN/2,maxN/2)
    const rowmid = maxN * half;
    let rowFactLarge = ex(-(half * half) * scaleLarge);
    let rowFactSmall = ex(-(half * half) * scaleSmall);
    let factStripes = ex(-(half * half) * scaleStripes);
    const m1 = fround(fround(1 - rowFactLarge) * rowFactSmall);
    const m2 = fround(fround(fround(1 - fround(rowFactLarge * rowFactLarge)) * rowFactSmall) * rowFactSmall);
    mul(half, m1);                  // (maxN/2,0)
    mul(rowmid, m1);                // (0,maxN/2)
    mul(half + rowmid, m2);         // (maxN/2,maxN/2)
    const oneMinusStripes = fround(1 - factStripes);
    if (stripesHorVert === 1) {
      mul(half, oneMinusStripes);
      set0(rowmid);
      mul(half + rowmid, oneMinusStripes);
    } else if (stripesHorVert === 2) {
      set0(half);
      mul(rowmid, oneMinusStripes);
      mul(half + rowmid, oneMinusStripes);
    }

    // loop along row 0 and maxN/2
    rowFactLarge = ex(-(half * half) * scaleLarge);
    rowFactSmall = ex(-(half * half) * scaleSmall);
    for (let col = 1; col < half; col++) {
      const backcol = maxN - col;
      const colFactLarge = ex(-(col * col) * scaleLarge);
      const colFactSmall = ex(-(col * col) * scaleSmall);
      const a = fround(fround(1 - colFactLarge) * colFactSmall);
      const b = fround(fround(fround(1 - fround(colFactLarge * rowFactLarge)) * colFactSmall) * rowFactSmall);
      if (stripesHorVert === 0) {
        mul(col, a); mul(backcol, a); mul(col + rowmid, b); mul(backcol + rowmid, b);
      } else if (stripesHorVert === 1) {
        const fs = ex(-(col * col) * scaleStripes);
        const k = fround(1 - fs);
        const a1 = fround(a * k), b1 = fround(b * k);
        mul(col, a1); mul(backcol, a1); mul(col + rowmid, b1); mul(backcol + rowmid, b1);
      } else {
        const fs = ex(-(half * half) * scaleStripes);
        const k = fround(1 - fs);
        const b1 = fround(b * k);
        set0(col); set0(backcol);
        mul(col + rowmid, b1); mul(backcol + rowmid, b1);
      }
    }

    // loop along column 0 and maxN/2
    const colFactLarge = ex(-(half * half) * scaleLarge);
    const colFactSmall = ex(-(half * half) * scaleSmall);
    for (let j = 1; j < half; j++) {
      const row = j * maxN, backrow = (maxN - j) * maxN;
      const rl = ex(-(j * j) * scaleLarge);
      const rs = ex(-(j * j) * scaleSmall);
      const a = fround(fround(1 - rl) * rs);
      const b = fround(fround(fround(1 - fround(rl * colFactLarge)) * rs) * colFactSmall);
      if (stripesHorVert === 0) {
        mul(row, a); mul(backrow, a); mul(row + half, b); mul(backrow + half, b);
      } else if (stripesHorVert === 1) {
        const fs = ex(-(half * half) * scaleStripes);
        const k = fround(1 - fs);
        const b1 = fround(b * k);
        set0(row); set0(backrow);
        mul(row + half, b1); mul(backrow + half, b1);
      } else {
        const fs = ex(-(j * j) * scaleStripes);
        const k = fround(1 - fs);
        const a1 = fround(a * k), b1 = fround(b * k);
        mul(row, a1); mul(backrow, a1); mul(row + half, b1); mul(backrow + half, b1);
      }
    }
  }

  // The padded side FFTFilter.filter() uses: "i = 2; while (i < 1.5*maxN) i *= 2".
  function bandpassSide(w, h) {
    const maxN = Math.max(w, h);
    let i = 2;
    while (i < 1.5 * maxN) i *= 2;
    return i;
  }

  /* FFTFilter.filter(ip) for one plane and the selection's bounding rectangle `rect` (FFTFilter.java:61-149):
   *   pad to the smallest power of 2 >= 1.5*max(w, h) by mirroring, FHT, filterLargeSmall (large / small = 2*dia/size),
   *   inverse FHT, crop to the rectangle; if doScaling: stretchHistogram(saturate ? 1.0 : 0.0) and the conversion
   *   to the original type scales between the new display range; otherwise the plain conversion. 32-bit keeps the floats.
   * returns the rectangle's new values (w*h of the plane's type). */
  async function bandpassPlane(data, W, rect, bitDepth, p, hooks, filterOut) {
    const h = hooks || noHooks;
    const i = bandpassSide(rect.w, rect.h);
    if (i > MAX_PADDED) throw ijError('IJ_FFT_TOO_LARGE', 'padded side ' + i + ' exceeds ' + MAX_PADDED);
    const sharpness = (100.0 - p.tolerance) / 100.0;
    const filterLarge = 2.0 * p.large / i;
    const filterSmall = 2.0 * p.small / i;
    const fx = Math.round((i - rect.w) / 2.0), fy = Math.round((i - rect.h) / 2.0);
    h.check();
    const tile = tileMirror(cropRect(data, W, rect), rect.w, rect.h, i, i, fx, fy, h);
    h.check();
    await rc2DFHT(tile, false, i, { check: h.check, tick: (f) => h.tick(0.05 + 0.4 * f) });
    await filterLargeSmall(tile, i, filterLarge, filterSmall, p.stripes, sharpness, filterOut || null, { check: h.check, tick: (f) => h.tick(0.45 + 0.05 * f) });
    await rc2DFHT(tile, true, i, { check: h.check, tick: (f) => h.tick(0.5 + 0.4 * f) });
    // fht.setRoi(fitRect); ip2 = fht.crop(): the crop's display range is the whole padded array's (createProcessor)
    const padRange = floatMinMax(tile, h);
    const crop = new Float32Array(rect.w * rect.h);
    for (let y = 0; y < rect.h; y++) crop.set(tile.subarray((fy + y) * i + fx, (fy + y) * i + fx + rect.w), y * rect.w);
    let range = (padRange.min === 0 && padRange.max === 0) ? floatMinMax(crop, h) : padRange;
    if (p.autoscale) range = await stretchRange(crop, p.saturate ? 1.0 : 0.0, range, { check: h.check, tick: (f) => h.tick(0.9 + 0.1 * f) });
    return floatToType(crop, bitDepth, !!p.autoscale, fround(range.min), fround(range.max));
  }

  // ======================================================================================================
  // operations
  // ======================================================================================================

  /* The rectangle an ImageJ command works on: ImagePlus.getProcessor() sets the processor's roi to the selection's bounds
   * for an area selection and resets it for a line / point. Clipped to the image (ImageProcessor.setRoi(Rectangle)). */
  function selectionRect(roi, W, H, io) {
    if (roi && root.IJRoi && root.IJRoi.isArea(roi)) {
      const box = io ? io.roiMask(roi) : null;
      if (box) return { x: box.x, y: box.y, w: box.w, h: box.h };
      const b = root.IJRoi.bounds(roi);
      const x0 = Math.max(0, Math.floor(b.x)), y0 = Math.max(0, Math.floor(b.y));
      const x1 = Math.min(W, Math.ceil(b.x + b.w)), y1 = Math.min(H, Math.ceil(b.y + b.h));
      if (!(x1 > x0 && y1 > y0)) throw ijError('IJ_EMPTY_ROI', 'the selection is outside the image');
      return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    }
    return { x: 0, y: 0, w: W, h: H };
  }

  const sideOf = (w, h) => { let s = 2; while (s < Math.max(w, h)) s *= 2; return s; };
  const channelOfView = (view, io) => (Number.isInteger(io && io.channel) ? io.channel : (view.active || 0));


  // ======================================================================================================
  // DIRECTIONALITY (Analyze > Directionality)
  // ======================================================================================================
  /* NOT a port. The Fiji plugin (GPL) was only run; this follows Liu (1991) and the public description of the method
   * ("Fourier components" and "Local gradient orientation") and is CALIBRATED against the Fiji run recorded in
   * tests/fixtures/ij-wave3/fiji/directionality/gratings.json (14 test images x 2 methods x 2-3 histogram settings).
   * What the recorded run proves, and what this code therefore does:
   *   - the histogram has `nbins` bins at start + j*W, W = 180/(nbins-1), j = 0 .. nbins-1 (so the last label is start+180)
   *     and sums to 1; the fit is a Gaussian a + b*exp(-(x-c)^2/(2 d^2)) of the histogram against its labels in RADIANS,
   *     with NO wrap-around (a peak split across the two ends fits badly in Fiji too: grating0 with start 0);
   *     Direction = c, Dispersion = |d|, Amount = the part of the histogram within c +- 2 d (exact on the recorded cases),
   *     Goodness = 1 - (SSE/(n-5))/(SST/(n-1)) (adjusted R2 of the 4-parameter fit).
   *   - Local gradient orientation: a separable 5 x 5 derivative (D = [-0.672 -1 0 1 0.672] across, S = [0.3223 0.5425 1
   *     0.5425 0.3223] along), edges replicated, orientation = atan2(-gy, gx) + 90 degrees, each pixel weighted by its
   *     SQUARED gradient magnitude, bin = floor((angle - start)/W) (the label is the bin's lower edge). The taps were
   *     fitted to the recorded histograms (L1 distance ~0.02 per image).
   *   - Fourier components: SQUARE pieces of side min(width, height) (at most PIECE_MAX), Hann window, mean removed,
   *     zero-padded power spectrum, the power of every frequency pixel of radius 1 .. side/2 cycles added at the angle of
   *     the fibre it describes (perpendicular to the frequency vector), smoothed over about +-2 degrees (cos^2, 1.95) and integrated
   *     over the bin centred on each label; the two end bins also see the angles of the other end (the recorded
   *     histograms are symmetric there). Pieces step by their side, the last one flush with the image edge.
   * The test prints how close the fits come to the recorded ones. */
  const DIR_RES = 0.05;                       // degrees of the fine angular density
  const DIR_SMOOTH = 1.95;                     // degrees: half width of the cos^2 smoothing of the Fourier method
  const PIECE_MAX = 160;                      // largest piece side (pixels): the recorded images need 160
  const PIECES_MAX = 100;                     // most pieces analysed (regular sub-sampling beyond)
  const DIR_KD = [-0.672, -1, 0, 1, 0.672];   // derivative taps (calibrated)
  const DIR_KS = [0.3223, 0.5425, 1, 0.5425, 0.3223]; // smoothing taps (calibrated)

  function mod(a, m) { const r = a % m; return r < 0 ? r + m : r; }

  // Gauss-Jordan on a 4 x 4 system with partial pivoting; null when singular.
  function solve4(M, g) {
    const a = M.map((row, i) => row.concat([g[i]]));
    for (let c = 0; c < 4; c++) {
      let piv = c;
      for (let r = c + 1; r < 4; r++) if (Math.abs(a[r][c]) > Math.abs(a[piv][c])) piv = r;
      if (Math.abs(a[piv][c]) < 1e-300) return null;
      if (piv !== c) { const t = a[c]; a[c] = a[piv]; a[piv] = t; }
      for (let r = 0; r < 4; r++) {
        if (r === c) continue;
        const f = a[r][c] / a[c][c];
        for (let k = c; k < 5; k++) a[r][k] -= f * a[c][k];
      }
    }
    return [a[0][4] / a[0][0], a[1][4] / a[1][1], a[2][4] / a[2][2], a[3][4] / a[3][3]];
  }

  /* The Gaussian fit of Directionality: least squares of a + b*exp(-(x-c)^2/(2 d^2)) on the histogram, Levenberg-Marquardt
   * from three deterministic starts (the width started at 0.03, 0.1 and 0.3 rad), the best sum of squares kept. */
  function gaussFit(x, h) {
    const n = x.length;
    let best = null;
    const model = (p, xi) => p[0] + p[1] * Math.exp(-((xi - p[2]) * (xi - p[2])) / (2 * p[3] * p[3]));
    const sse = (p) => { let s = 0; for (let i = 0; i < n; i++) { const r = h[i] - model(p, x[i]); s += r * r; } return s; };
    let hmin = Infinity, hmax = -Infinity, imax = 0;
    for (let i = 0; i < n; i++) { if (h[i] < hmin) hmin = h[i]; if (h[i] > hmax) { hmax = h[i]; imax = i; } }
    for (const d0 of [0.03, 0.1, 0.3]) {
      let p = [hmin, hmax - hmin, x[imax], d0];
      let cost = sse(p), lambda = 1e-3;
      for (let iter = 0; iter < 200; iter++) {
        const A = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]], g = [0, 0, 0, 0];
        for (let i = 0; i < n; i++) {
          const dx = x[i] - p[2], e = Math.exp(-(dx * dx) / (2 * p[3] * p[3]));
          const J = [1, e, p[1] * e * dx / (p[3] * p[3]), p[1] * e * dx * dx / (p[3] * p[3] * p[3])];
          const r = h[i] - (p[0] + p[1] * e);
          for (let u = 0; u < 4; u++) { g[u] += J[u] * r; for (let v = 0; v < 4; v++) A[u][v] += J[u] * J[v]; }
        }
        let improved = false, converged = false;
        for (let tries = 0; tries < 12; tries++) {
          const M = A.map((row, u) => row.map((v, w) => (u === w ? v * (1 + lambda) + 1e-18 : v)));
          const step = solve4(M, g);
          if (step) {
            const q = [p[0] + step[0], p[1] + step[1], p[2] + step[2], Math.max(1e-4, Math.abs(p[3] + step[3]))];
            const c2 = sse(q);
            if (c2 <= cost) { converged = (cost - c2) <= 1e-13 * (cost + 1e-30); p = q; cost = c2; lambda = Math.max(lambda / 5, 1e-12); improved = true; break; }
          }
          lambda *= 6;
        }
        if (!improved || converged) break;
      }
      if (!best || cost < best.sse) best = { p, sse: cost };
    }
    return best;
  }

  // Direction / Dispersion / Amount / Goodness of a normalised histogram (labels in degrees).
  function analyseHistogram(hist, labelsDeg) {
    const n = hist.length;
    const x = new Float64Array(n);
    for (let i = 0; i < n; i++) x[i] = labelsDeg[i] * Math.PI / 180;
    const fit = gaussFit(x, hist);
    const p = fit.p, d = Math.abs(p[3]);
    let amount = 0, mean = 0;
    for (let i = 0; i < n; i++) { mean += hist[i]; if (Math.abs(x[i] - p[2]) <= 2 * d) amount += hist[i]; }
    mean /= n;
    let sst = 0;
    for (let i = 0; i < n; i++) sst += (hist[i] - mean) * (hist[i] - mean);
    const goodness = sst > 0 && n > 5 ? 1 - (fit.sse / (n - 5)) / (sst / (n - 1)) : 0;
    return { a: p[0], b: p[1], c: p[2], d, sse: fit.sse, direction: p[2] * 180 / Math.PI, dispersion: d * 180 / Math.PI, amount, goodness };
  }

  /* Local gradient orientation: the histogram (normalised) and, when `wantMap`, the orientation of every pixel (degrees in
   * [start, start+180); GRADIENT_NONE where the gradient is zero). `data` = the rect's values (w x h, any type). */
  const GRADIENT_NONE = -1e30;
  async function gradientHistogram(data, w, h, nb, start, wantMap, hooks) {
    const hk = hooks || noHooks;
    const W = 180.0 / (nb - 1);
    // horizontal passes (D and S of every row), then the vertical ones per output row
    const hd = new Float32Array(w * h), hs = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      const o = y * w;
      for (let x = 0; x < w; x++) {
        let sd = 0, ss = 0;
        for (let k = 0; k < 5; k++) { const xx = x + k - 2, v = data[o + (xx < 0 ? 0 : xx >= w ? w - 1 : xx)]; sd += DIR_KD[k] * v; ss += DIR_KS[k] * v; }
        hd[o + x] = sd; hs[o + x] = ss;
      }
      if ((y & 63) === 63) { hk.check(); await hk.tick(0.3 * y / h); }
    }
    const hist = new Float64Array(nb);
    const map = wantMap ? new Float32Array(w * h) : null;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        // gx = S(y) (x) D(x) (the rows differentiated across, smoothed down); gy = D(y) (x) S(x)
        let gx = 0, gy = 0;
        for (let k = 0; k < 5; k++) {
          const yy = y + k - 2, i = (yy < 0 ? 0 : yy >= h ? h - 1 : yy) * w + x;
          gx += DIR_KS[k] * hd[i];
          gy += DIR_KD[k] * hs[i];
        }
        const wgt = gx * gx + gy * gy;
        if (wgt > 0) {
          const t = mod(Math.atan2(-gy, gx) * 180 / Math.PI + 90.0 - start, 180.0);
          let idx = Math.floor(t / W);
          if (idx > nb - 1) idx = nb - 1;
          hist[idx] += wgt;
          if (map) map[y * w + x] = start + t;
        } else if (map) map[y * w + x] = GRADIENT_NONE;
      }
      if ((y & 63) === 63) { hk.check(); await hk.tick(0.3 + 0.7 * y / h); }
    }
    let sum = 0;
    for (let i = 0; i < nb; i++) sum += hist[i];
    if (!(sum > 0)) throw ijError('IJ_DIR_NO_SIGNAL', 'the image has no gradient');
    for (let i = 0; i < nb; i++) hist[i] /= sum;
    return { hist, map };
  }

  const hannCache = new Map();
  function hann(n) {
    let w = hannCache.get(n);
    if (!w) {
      w = new Float64Array(n);
      for (let i = 0; i < n; i++) w[i] = n > 1 ? 0.5 * (1 - Math.cos(2 * Math.PI * i / (n - 1))) : 1;
      if (hannCache.size > 8) hannCache.clear();
      hannCache.set(n, w);
    }
    return w;
  }

  /* Fourier components: see the section header. Returns { hist, pieces, side }. */
  async function fourierHistogram(data, W, H, nb, start, hooks) {
    const hk = hooks || noHooks;
    const side = Math.min(W, H, PIECE_MAX);
    if (side < 16) throw ijError('IJ_DIR_TOO_SMALL', 'the image is too small for the Fourier method');
    const M = 512;                                // zero-padded size of every piece's transform (side <= PIECE_MAX < M/3)
    // pieces: regular grid, the last one flush with the edge; at most PIECES_MAX of them (a regular stride beyond)
    const starts = (len) => { const a = []; for (let p = 0; p + side <= len; p += side) a.push(p); if (a[a.length - 1] !== len - side) a.push(len - side); return a; };
    let xs = starts(W), ys = starts(H);
    const piecesAll = xs.length * ys.length;
    if (xs.length * ys.length > PIECES_MAX) {
      // the same fraction of each axis, evenly spaced and keeping both ends, so the grid fills the cap (13×13 → 10×10, not 7×7)
      const f = Math.sqrt(PIECES_MAX / (xs.length * ys.length));
      const pick = (a, n) => {
        n = Math.max(1, Math.min(a.length, n));
        if (n === a.length) return a;
        if (n === 1) return [a[Math.floor((a.length - 1) / 2)]];
        const out = [];
        for (let i = 0; i < n; i++) out.push(a[Math.round(i * (a.length - 1) / (n - 1))]);
        return out;
      };
      xs = pick(xs, Math.floor(xs.length * f)); ys = pick(ys, Math.floor(ys.length * f));
    }
    // the fine angular bin of every frequency pixel whose radius is in [1, side/2] cycles per piece
    const nFine = Math.round(180 / DIR_RES);
    const ang = new Int16Array(M * M).fill(-1);
    for (let row = 0; row < M; row++) {
      const v = (row < M / 2 ? row : row - M) * (side / M);
      for (let c = 0; c < M; c++) {
        const u = (c < M / 2 ? c : c - M) * (side / M);
        const r = Math.hypot(u, v);
        if (r < 1.0 || r > side / 2) continue;
        // image columns are x, rows y (down): the frequency (u, v) of a fibre at angle a (counter-clockwise on screen) is
        // (sin a, cos a), hence a = atan2(u, v)
        const t = mod(Math.atan2(u, v) * 180 / Math.PI + 90.0, 180.0);
        let idx = Math.floor(t / DIR_RES);
        if (idx >= nFine) idx = nFine - 1;
        ang[row * M + c] = idx;
      }
    }
    const win = hann(side);
    const dens = new Float64Array(nFine);
    const buf = new Float32Array(M * M);
    let done = 0;
    const total = xs.length * ys.length;
    for (const y0 of ys) {
      for (const x0 of xs) {
        let mean = 0;
        for (let y = 0; y < side; y++) { const o = (y0 + y) * W + x0; for (let x = 0; x < side; x++) mean += data[o + x]; }
        mean /= side * side;
        buf.fill(0);
        for (let y = 0; y < side; y++) {
          const o = (y0 + y) * W + x0, wy = win[y];
          for (let x = 0; x < side; x++) buf[y * M + x] = (data[o + x] - mean) * wy * win[x];
        }
        await rc2DFHT(buf, false, M, { check: hk.check, tick() {} });
        // |F|^2 = (H(k)^2 + H(-k)^2)/2
        for (let row = 0; row < M; row++) {
          const mrow = ((M - row) % M) * M, base = row * M;
          for (let c = 0; c < M; c++) {
            const a = ang[base + c];
            if (a < 0) continue;
            const p = buf[base + c], q = buf[mrow + ((M - c) % M)];
            dens[a] += (p * p + q * q) / 2;
          }
        }
        done++;
        hk.check();
        await hk.tick(done / total);
      }
    }
    // smoothing over +-DIR_SMOOTH degrees (cos^2), circular
    const hw = Math.round(DIR_SMOOTH / DIR_RES);
    const kern = new Float64Array(2 * hw + 1);
    let ksum = 0;
    for (let i = -hw; i <= hw; i++) { const c = Math.cos(Math.PI / 2 * i / hw); kern[i + hw] = c * c; ksum += c * c; }
    const sm = new Float64Array(nFine);
    for (let i = 0; i < nFine; i++) {
      let s = 0;
      for (let k = -hw; k <= hw; k++) s += kern[k + hw] * dens[(i + k + nFine) % nFine];
      sm[i] = s / ksum;
    }
    // integrate over the bin centred on each label (round assignment; the two end bins also see the other end)
    const Wd = 180.0 / (nb - 1);
    const hist = new Float64Array(nb);
    for (let i = 0; i < nFine; i++) {
      const a = -90 + (i + 0.5) * DIR_RES;
      const t = mod(a - start, 180.0);
      let j = Math.floor(t / Wd + 0.5);
      if (j > nb - 1) j = nb - 1;
      hist[j] += sm[i];
      if (t < Wd / 2) hist[nb - 1] += sm[i];
      else if (t > 180 - Wd / 2) hist[0] += sm[i];
    }
    let sum = 0;
    for (let i = 0; i < nb; i++) sum += hist[i];
    if (!(sum > 0)) throw ijError('IJ_DIR_NO_SIGNAL', 'the image has no structure');
    for (let i = 0; i < nb; i++) hist[i] /= sum;
    return { hist, pieces: total, piecesAll, side };
  }

  if (!R) { root.IJFftPkg = { gaussFit, analyseHistogram, gradientHistogram, fourierHistogram, DIR_KD, DIR_KS, PIECE_MAX, fhtTables, dfht3, rc2DFHT, swapQuadrants, powerSpectrum, powerSpectrumMean, forwardFht, padToFloat, applyMask, tileMirror, filterLargeSmall, bandpassPlane, bandpassSide, stretchRange, floatToType, meanOf, fingerprint, MAX_PADDED }; return; }

  const defineOp = (name, spec) => R.define(name, spec);

  // ---- fft ------------------------------------------------------------------------------------------------
  defineOp('fft', {
    kind: 'newdoc', version: 1, stack: 'plane', rgb: 'gray', channels: 'one', roi: 'bounds', preview: false,
    validate(p) {
      for (const k of ['fftWindow', 'rawPs']) if (p[k] !== undefined && typeof p[k] !== 'boolean') throw ijError('IJ_BAD_ARGS', k);
      if (p.sourceRev !== undefined && p.sourceRev !== null && !isNum(p.sourceRev)) throw ijError('IJ_BAD_ARGS', 'sourceRev');
      if (p.fftWindow === false && !p.rawPs) throw ijError('IJ_FFT_NO_OUTPUT', 'no output requested');
    },
    scratchBytes(info, params) {
      let rect;
      try { rect = selectionRect(info.roi, info.width, info.height, null); } catch (e) { return 0; }
      const side = sideOf(rect.w, rect.h);
      if (side > MAX_PADDED) return 0; // run() refuses it with IJ_FFT_TOO_LARGE
      const n = side * side;
      // fht + power spectrum (float) + 8-bit spectrum + the crop; the raw spectrum reuses the float one
      return n * 4 * 2 + n + rect.w * rect.h * bytesOf(info.bitDepth);
    },
    async run(view, params, roi, io) {
      const c = channelOfView(view, io);
      if (!(c >= 0 && c < view.channels.length)) throw ijError('IJ_BAD_ARGS', 'channel');
      const rect = selectionRect(roi, view.width, view.height, io);
      const side = sideOf(rect.w, rect.h);
      if (side > MAX_PADDED) throw ijError('IJ_FFT_TOO_LARGE', 'padded side ' + side + ' exceeds ' + MAX_PADDED);
      const hk = hooksOf(io, 'op.fft');
      const src = cropRect(view.channels[c].data, view.width, rect);
      const fp = fingerprint(src, view.bitDepth, hk);
      const f = await forwardFht(src, rect.w, rect.h, view.bitDepth, { check: hk.check, tick: (x) => hk.tick(0.6 * x) });
      const ps = await powerSpectrum(f.fht, f.side, { check: hk.check, tick: (x) => hk.tick(0.6 + 0.4 * x) });
      f.fht = null; // the transform is not needed any more: its memory goes before the copies below
      const fftWindow = params.fftWindow !== false;
      const prov = (kind) => Object.assign({}, view.provenance, {
        fft: { kind, sourceDocId: view.id, sourceRev: isNum(params.sourceRev) ? params.sourceRev : null, channel: c, padded: f.side, origW: rect.w, origH: rect.h, crop: rect, bitDepth: view.bitDepth, fingerprint: fp }
      });
      const cal = view.calibration ? Object.assign({}, view.calibration) : view.calibration;
      const out = [];
      const chName = view.channels[c].name;
      if (params.rawPs) {
        // doForwardTransform: rawps = fht.getRawPowerSpectrum(); swapQuadrants(rawps); enhanceContrast(imp2) = "Enhance Contrast saturated=0.35"
        const raw = swapQuadrants(ps.fps, f.side, f.side, true, hk);
        const r = await stretchRange(raw, 0.35, floatMinMax(raw, hk), { check: hk.check, tick: () => {} });
        out.push({
          name: 'PS of ' + view.name, width: f.side, height: f.side, bitDepth: 32,
          // FFT.java:254-257: new ImagePlus("PS of "+fileName, rawps) has no calibration (only "FFT of" gets setCalibration)
          calibration: { pixelWidth: 1, pixelHeight: 1, unit: 'pixel' }, provenance: prov('ps'),
          channels: [{ name: chName, color: '#ffffff', data: raw, display: { min: r.min, max: r.max, lut: 'Grays', invert: false } }]
        });
      }
      if (fftWindow) {
        out.push({
          name: 'FFT of ' + view.name, width: f.side, height: f.side, bitDepth: 8, calibration: cal, provenance: prov('fft'),
          channels: [{ name: chName, color: '#ffffff', data: ps.ps8, display: { min: 0, max: 255, lut: 'Grays', invert: false } }]
        });
      }
      return out;
    }
  });

  // ---- inverseFft -------------------------------------------------------------------------------------------
  const sourceChanged = () => ijError('IJ_FFT_SOURCE_CHANGED', 'the image the spectrum came from is gone or changed');

  defineOp('inverseFft', {
    kind: 'newdoc', version: 1, stack: 'plane', rgb: false, channels: 'one', roi: 'ignore', preview: false,
    validate(p, info) {
      if (info && Array.isArray(info.docs) && info.docs.length !== 1) throw ijError('IJ_FFT_SOURCE_CHANGED', 'the source image must be named');
    },
    scratchBytes(info) {
      const s = info.docs && info.docs[0];
      if (!s) return 0;
      const side = sideOf(s.width, s.height);
      if (side > MAX_PADDED) return 0;
      const n = side * side;
      // fht (float) + the mask copy and its smoothing copy (bytes) + the cropped / converted output
      return n * 4 + n * 2 + s.width * s.height * 8;
    },
    async run(view, params, roi, io) {
      const meta = view.provenance && view.provenance.fft;
      if (!meta || meta.kind !== 'fft') throw ijError('IJ_FFT_NOT_FD', 'frequency domain image required');
      const ids = io.docIds || [];
      let src = null;
      if (ids.length > 1 && ids[1] === meta.sourceDocId) { try { src = io.readDoc(ids[1]); } catch (e) { src = null; } }
      if (!src) throw sourceChanged();
      const c = meta.channel, rect = meta.crop;
      if (!(c >= 0 && c < src.channels.length) || src.bitDepth !== meta.bitDepth || !rect || rect.x + rect.w > src.width || rect.y + rect.h > src.height) throw sourceChanged();
      const side = sideOf(rect.w, rect.h);
      if (side > MAX_PADDED) throw ijError('IJ_FFT_TOO_LARGE', 'padded side ' + side + ' exceeds ' + MAX_PADDED);
      const hk = hooksOf(io, 'op.inverseFft');
      const data = cropRect(src.channels[c].data, src.width, rect);
      if (fingerprint(data, src.bitDepth, hk) !== meta.fingerprint) throw sourceChanged();
      const f = await forwardFht(data, rect.w, rect.h, src.bitDepth, { check: hk.check, tick: (x) => hk.tick(0.4 * x) });
      const fht = f.fht;
      // doMasking: imp.getProcessor() of the edited power spectrum
      const m = applyMask(fht, f.side, view.channels[0].data, view.width, view.height, view.bitDepth, hk);
      await hk.tick(0.45);
      let notice = false;
      if (m.mode === 'none' && view.bitDepth === 8) {
        // "if (bitDepth==8 && ip.powerSpectrumMean!=stats.mean) IJ.showMessage(...)": the mean of the spectrum as FFT stored it
        notice = powerSpectrumMean(f.fht, f.side, hk) !== m.mean;
      }
      // fht.inverseTransform(); (quadrantSwapNeeded is never set); fht.resetMinAndMax()
      if (m.mode === 'none' || m.mode === 'skip') { /* the masked array is the plain transform: nothing was multiplied */ }
      await rc2DFHT(fht, true, f.side, { check: hk.check, tick: (x) => hk.tick(0.5 + 0.5 * x) });
      const padRange = floatMinMax(fht, hk);
      let plane = fht;
      if (f.padded) {
        // fht.setRoi(0, 0, originalWidth, originalHeight); ip2 = fht.crop()
        plane = new Float32Array(rect.w * rect.h);
        for (let y = 0; y < rect.h; y++) plane.set(fht.subarray(y * f.side, y * f.side + rect.w), y * rect.w);
      }
      const bd = src.bitDepth;
      const data2 = floatToType(plane, bd, false, 0, 0);
      // The display range of the image ImageJ shows. 8-bit: TypeConverter.convertFloatToByte (TypeConverter.java:84-86) calls
      // bp.setPixels(0, fp) and then "bp.resetMinAndMax(); //don't take min&max from ip", ByteProcessor.resetMinAndMax =
      // setMinAndMax(0, 255) (ByteProcessor.java:476-477): 0..255. A 16-bit result takes its data range, a float one the padded range.
      const sch = src.channels[c];
      let display;
      if (bd === 8) {
        display = { min: 0, max: 255 };
      } else if (bd === 32) {
        display = { min: fround(padRange.min), max: fround(padRange.max) };
        if (!(display.max > display.min)) display = { min: 0, max: 1 };
      } else {
        const r = floatMinMax(data2, hk);
        display = r.max > r.min ? { min: r.min, max: r.max } : { min: 0, max: 65535 };
      }
      display.lut = sch.display ? sch.display.lut : 'Grays';
      display.invert = !!(sch.display && sch.display.invert);
      const name = view.name.indexOf('FFT of ') === 0 ? view.name.substring(7) : view.name;
      const provenance = Object.assign({}, view.provenance);
      delete provenance.fft;
      provenance.fftInverse = { sourceDocId: meta.sourceDocId, mask: m.mode, notice };
      return [{
        name: 'Inverse FFT of ' + name, width: rect.w, height: rect.h, bitDepth: bd,
        calibration: view.calibration ? Object.assign({}, view.calibration) : view.calibration, provenance,
        channels: [{ name: sch.name, color: sch.color, data: data2, display }]
      }];
    }
  });

  // ---- bandpass ----------------------------------------------------------------------------------------------
  const STRIPES = ['none', 'horizontal', 'vertical'];
  function validateBandpass(p) {
    if (!isNum(p.large) || p.large < 0 || p.large > 100000) throw ijError('IJ_BAD_ARGS', 'large');
    if (!isNum(p.small) || p.small < 0 || p.small > 100000) throw ijError('IJ_BAD_ARGS', 'small');
    if (p.stripes !== 0 && p.stripes !== 1 && p.stripes !== 2) throw ijError('IJ_BAD_ARGS', 'stripes');
    if (!isNum(p.tolerance) || p.tolerance < 0 || p.tolerance > 100) throw ijError('IJ_BAD_ARGS', 'tolerance');
    for (const k of ['autoscale', 'saturate']) if (typeof p[k] !== 'boolean') throw ijError('IJ_BAD_ARGS', k);
  }

  defineOp('bandpass', {
    kind: 'pixel', version: 1, stack: 'ask', rgb: 'each', channels: 'each', roi: 'bounds', preview: false, display: true,
    validate: validateBandpass,
    scratchBytes(info) {
      const r = info.region || { w: info.width, h: info.height };
      const side = bandpassSide(r.w, r.h);
      if (side > MAX_PADDED) return 0; // region() refuses it with IJ_FFT_TOO_LARGE
      const n = side * side;
      return n * 4 + n * 4 + r.w * r.h * 4;
    },
    prepare(view, c, params, ctx) {
      const bd = view.bitDepth;
      return {
        apron: { x: 0, y: 0 },
        whole: true,
        async region(full, rect) {
          return bandpassPlane(full.data, full.width, rect, bd, params, ctx ? { check: () => ctx.check(), tick: (f) => ctx.tick(f, 'op.bandpass') } : noHooks, null);
        }
      };
    }
  });

  // The image "Display filter" shows (FFTFilter.java:400-404): the multiplier of filterLargeSmall as a 32-bit image, quadrants swapped.
  defineOp('bandpassFilter', {
    kind: 'newdoc', version: 1, stack: 'plane', rgb: 'each', channels: 'one', roi: 'bounds', preview: false,
    validate: validateBandpass,
    scratchBytes(info) {
      let rect;
      try { rect = selectionRect(info.roi, info.width, info.height, null); } catch (e) { return 0; }
      const side = bandpassSide(rect.w, rect.h);
      if (side > MAX_PADDED) return 0;
      return side * side * 4 * 2;
    },
    async run(view, params, roi, io) {
      const rect = selectionRect(roi, view.width, view.height, io);
      const side = bandpassSide(rect.w, rect.h);
      if (side > MAX_PADDED) throw ijError('IJ_FFT_TOO_LARGE', 'padded side ' + side + ' exceeds ' + MAX_PADDED);
      const hk = hooksOf(io, 'op.bandpassFilter');
      const filter = new Float32Array(side * side).fill(1);
      const sink = new Float32Array(side * side).fill(1);
      // the multiplier = filterLargeSmall applied to an array of ones (exactly what Java accumulates in `filter[]`)
      await filterLargeSmall(sink, side, 2.0 * params.large / side, 2.0 * params.small / side, params.stripes, (100.0 - params.tolerance) / 100.0, null, hk);
      filter.set(sink);
      const swapped = swapQuadrants(filter, side, side, false);
      const r = floatMinMax(swapped);
      const ch = view.channels[channelOfView(view, io)];
      return [{
        name: 'Filter', width: side, height: side, bitDepth: 32, calibration: view.calibration ? Object.assign({}, view.calibration) : view.calibration,
        provenance: Object.assign({}, view.provenance),
        channels: [{ name: ch.name, color: '#ffffff', data: swapped, display: { min: r.min, max: r.max > r.min ? r.max : r.min + 1, lut: 'Grays', invert: false } }]
      }];
    }
  });

  // ---- swapQuadrants -----------------------------------------------------------------------------------------
  defineOp('swapQuadrants', {
    kind: 'pixel', version: 1, stack: 'ask', rgb: 'each', channels: 'each', roi: 'ignore', preview: false,
    validate(p, info) { if (info && info.width !== info.height) throw ijError('IJ_FFT_NOT_SQUARE', 'image must be square'); },
    scratchBytes: () => 0,
    prepare() {
      return { apron: { x: 0, y: 0 }, whole: true, fn: (src) => swapQuadrants(src.data, src.width, src.height, false) };
    }
  });


  // ---- directionality ----------------------------------------------------------------------------------------
  defineOp('directionality', {
    kind: 'compute', version: 1, stack: 'plane', rgb: 'gray', channels: 'one',
    validate(p) {
      if (p.method !== 'fourier' && p.method !== 'gradient') throw ijError('IJ_BAD_ARGS', 'method');
      if (!Number.isInteger(p.nbins) || p.nbins < 5 || p.nbins > 720) throw ijError('IJ_BAD_ARGS', 'nbins');
      if (!isNum(p.start) || p.start < -180 || p.start > 180) throw ijError('IJ_BAD_ARGS', 'start');
      if (p.map !== undefined && typeof p.map !== 'boolean') throw ijError('IJ_BAD_ARGS', 'map');
    },
    scratchBytes(info, params) {
      let rect;
      try { rect = selectionRect(info.roi, info.width, info.height, null); } catch (e) { return 0; }
      const n = rect.w * rect.h;
      if (params && params.method === 'fourier') return n * bytesOf(info.bitDepth) + 512 * 512 * 4 + 512 * 512 * 2 + 3600 * 16 + 1048576;
      return n * 4 * 2 + (params && params.map ? n * 4 : 0) + n * bytesOf(info.bitDepth) + 1048576;
    },
    async run(view, params, roi, io) {
      const c = channelOfView(view, io);
      if (!(c >= 0 && c < view.channels.length)) throw ijError('IJ_BAD_ARGS', 'channel');
      const rect = selectionRect(roi, view.width, view.height, io);
      const hk = hooksOf(io, 'op.directionality');
      const out = await directionalityAnalyse(view, params, rect, c, hk);
      if (out.map) io.transfer(out.map.data.buffer);
      return out;
    }
  });

  async function directionalityAnalyse(view, params, rect, c, hk) {
    {
      if (Math.min(rect.w, rect.h) < (params.method === 'fourier' ? 16 : 8)) throw ijError('IJ_DIR_TOO_SMALL', 'the image is too small');
      const data = cropRect(view.channels[c].data, view.width, rect);
      const nb = params.nbins, start = params.start;
      // a uniform region has no orientation (the derivative taps would only give rounding noise)
      let lo = Infinity, hi = -Infinity;
      for (let i = 0; i < data.length; i++) { const v = data[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
      if (!(hi > lo)) throw ijError('IJ_DIR_NO_SIGNAL', 'the image is uniform');
      let hist, map = null, pieces = 0, piecesAll = 0, side = 0;
      if (params.method === 'fourier') {
        const f = await fourierHistogram(data, rect.w, rect.h, nb, start, hk);
        hist = f.hist; pieces = f.pieces; piecesAll = f.piecesAll; side = f.side;
      } else {
        const g = await gradientHistogram(data, rect.w, rect.h, nb, start, !!params.map, hk);
        hist = g.hist; map = g.map;
      }
      const Wd = 180.0 / (nb - 1);
      const labels = new Array(nb);
      for (let i = 0; i < nb; i++) labels[i] = start + i * Wd;
      const a = analyseHistogram(hist, labels);
      const out = {
        method: params.method, nbins: nb, start, end: start + 180, channel: c, rect, pieces, piecesAll, pieceSide: side,
        bins: labels, histogram: Array.from(hist),
        fit: { a: a.a, b: a.b, c: a.c, d: a.d, sse: a.sse },
        direction: a.direction, dispersion: a.dispersion, amount: a.amount, goodness: a.goodness
      };
      if (map) out.map = { width: rect.w, height: rect.h, data: map, none: GRADIENT_NONE };
      return out;
    }
  }

  /* The orientation map as a document built in the worker: the page never holds the image-sized array. The pixels no gradient reached
   * take the value just under the wheel's range (display index 0 = black), as the page used to write them. args: { docId, channel, roi,
   * method: 'gradient', nbins, start, name }. → { result (the fit, no map), info } */
  const WHEEL_LUT = 'Directionality';
  if (typeof R.defineCommand === 'function') {
    R.defineCommand('doc.dirmap.create', {
      pkg: 'fft', long: true,
      async handler(a, E) {
        if (!a || typeof a !== 'object' || a.docId === undefined || a.docId === null) throw ijError('IJ_BAD_ARGS', 'args');
        const params = { method: 'gradient', nbins: a.nbins, start: a.start, map: true };
        if (!Number.isInteger(params.nbins) || params.nbins < 5 || params.nbins > 720) throw ijError('IJ_BAD_ARGS', 'nbins');
        if (!isNum(params.start) || params.start < -180 || params.start > 180) throw ijError('IJ_BAD_ARGS', 'start');
        if (typeof a.name !== 'string' || !a.name || a.name.length > 255) throw ijError('IJ_BAD_ARGS', 'name');
        if (a.roi && root.IJRoi) root.IJRoi.validate(a.roi);
        return E.lockDocs([a.docId], async () => {
          const view = E.readDoc(a.docId);
          const c = Number.isInteger(a.channel) ? a.channel : (view.active || 0);
          if (!(c >= 0 && c < view.channels.length)) throw ijError('IJ_BAD_ARGS', 'channel');
          const rect = selectionRect(a.roi || null, view.width, view.height, null);
          const n = rect.w * rect.h;
          // the same working set as the compute operation: two float images of the gradients, the map (which becomes the document), the crop
          E.reserve(n * 4 * 3 + n * bytesOf(view.bitDepth) + 1048576);
          const hk = { check: () => E.check(), tick: (f) => E.tick(Math.min(1, Math.max(0, f)), 'op.directionality') };
          const res = await directionalityAnalyse(view, params, rect, c, hk);
          const map = res.map.data, below = params.start - 180 / 255 - 1;
          for (let i = 0; i < map.length; i++) if (map[i] < -1e29) map[i] = below;
          E.check();
          const info = E.createDoc({
            name: a.name, width: rect.w, height: rect.h, bitDepth: 32,
            calibration: view.calibration ? Object.assign({}, view.calibration) : view.calibration,
            channels: [{ name: 'Orientation', color: '#ffffff', data: map, display: { min: params.start - 180 / 255, max: params.start + 180, lut: WHEEL_LUT, invert: false } }]
          }, { provenance: {} });
          delete res.map;
          return { result: res, info };
        });
      }
    });
  }

  root.IJFftPkg = {
    gaussFit, analyseHistogram, gradientHistogram, fourierHistogram, DIR_KD, DIR_KS, PIECE_MAX,
    fhtTables, dfht3, rc2DFHT, swapQuadrants, powerSpectrum, powerSpectrumMean, forwardFht, padToFloat, applyMask, tileMirror, filterLargeSmall,
    bandpassPlane, bandpassSide, stretchRange, floatToType, meanOf, fingerprint, MAX_PADDED, STRIPES
  };
})(typeof self !== 'undefined' ? self : globalThis);
