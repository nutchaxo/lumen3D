/* ============================================================
   Lumen3D — 2D pixel operations
   ============================================================
   The per-pixel maths behind the 2D viewer's display adjustments and
   stain isolation, kept free of any DOM so the same code runs in the
   pixel worker (js/workers/pixel-2d-worker.js, which loads this file with
   importScripts), on the main thread when a worker is unavailable, and
   under Node in the tests.

   Every function works on RGBA bytes (a Uint8ClampedArray as ImageData
   holds them) and on small RGBA samples produced by the caller: the
   downscaling itself needs a canvas, the arithmetic does not.
   ============================================================ */

const PixelOps2D = (() => {
  const FLAT_SCALE = 8;                    // illumination map resolution (1/8)
  const FLAT_BACKGROUND_FRACTION = 0.4;    // the darkest 40 % of cells define the illumination model

  const ISO_RATIO_LO = 1.0, ISO_RATIO_HI = 1.8;   // B/R mapped to 0..1
  const ISO_CTX_SCALE = 4, ISO_CTX_RADIUS = 5;    // context map: 1/4 res, 5-cell box ~ 40 px
  const ISO_CTX_MIN = 5;                          // tissue-context gate

  function unit(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

  /**
   * Per-channel look-up:  x = v/255 · whiteBalance
   *                       x = (x − ½)·(1 + contrast/100) + ½ + brightness/100
   *                       x = clamp(x)^(1/gamma)
   * `a` carries finite numbers only (the viewer sanitises them).
   */
  function channelLuts(a) {
    const k = 1 + a.contrast / 100, br = a.brightness / 100, g = 1 / Math.max(0.1, a.gamma);
    const build = (wb) => {
      const lut = new Uint8ClampedArray(256);
      for (let v = 0; v < 256; v++) {
        const x = unit(((v / 255) * wb - 0.5) * k + 0.5 + br);
        lut[v] = Math.round(Math.pow(x, g) * 255);
      }
      return lut;
    };
    return { r: build(a.wbRed), g: build(1), b: build(a.wbBlue) };
  }

  function percentile(values, fraction) {
    const sorted = Float32Array.from(values).sort();
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
  }

  function quadratic(c, x, y) {
    return c[0] + c[1] * x + c[2] * y + c[3] * x * x + c[4] * y * y + c[5] * x * y;
  }

  /** Least-squares fit of z = c0 + c1·x + c2·y + c3·x² + c4·y² + c5·xy over cells with z ≤ cutoff. */
  function fitQuadratic(lum, cw, ch, cutoff) {
    const n = 6, ata = Array.from({ length: n }, () => new Float64Array(n)), atb = new Float64Array(n);
    for (let y = 0; y < ch; y++) {
      for (let x = 0; x < cw; x++) {
        const z = lum[y * cw + x];
        if (z > cutoff) continue;
        const u = x / cw, v = y / ch, row = [1, u, v, u * u, v * v, u * v];
        for (let i = 0; i < n; i++) {
          atb[i] += row[i] * z;
          for (let j = 0; j < n; j++) ata[i][j] += row[i] * row[j];
        }
      }
    }
    return solve(ata, atb);
  }

  /** Gaussian elimination with partial pivoting; a singular system yields a flat surface. */
  function solve(a, b) {
    const n = b.length, m = Array.from(a, (row, i) => [...row, b[i]]);
    for (let col = 0; col < n; col++) {
      let pivot = col;
      for (let r = col + 1; r < n; r++) if (Math.abs(m[r][col]) > Math.abs(m[pivot][col])) pivot = r;
      if (Math.abs(m[pivot][col]) < 1e-12) return [b[0] / Math.max(1, a[0][0]), 0, 0, 0, 0, 0];
      [m[col], m[pivot]] = [m[pivot], m[col]];
      for (let r = 0; r < n; r++) {
        if (r === col) continue;
        const f = m[r][col] / m[col][col];
        for (let c = col; c <= n; c++) m[r][c] -= f * m[col][c];
      }
    }
    return m.map((row, i) => row[n] / row[i]);
  }

  /** Size of the sample the illumination map is fitted on. */
  function flatSampleSize(w, h) {
    return { w: Math.ceil(w / FLAT_SCALE), h: Math.ceil(h / FLAT_SCALE) };
  }

  /**
   * gain(x, y) = mean illumination / local illumination, on a coarse map.
   * The illumination is modelled as a quadratic surface fitted by least squares
   * to the DARK cells only (the lower part of the luminance distribution, i.e.
   * the matte background) — a smooth model cannot follow the embryo, so the
   * specimen keeps its own contrast while the vignette is levelled.
   * @param {Uint8ClampedArray} px RGBA of the image downscaled to flatSampleSize
   */
  function flattenMap(px, cw, ch) {
    const lum = new Float32Array(cw * ch);
    for (let i = 0; i < cw * ch; i++) lum[i] = 0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2];
    const cutoff = percentile(lum, FLAT_BACKGROUND_FRACTION);
    const coef = fitQuadratic(lum, cw, ch, cutoff);
    const gain = new Float32Array(cw * ch);
    let mean = 0;
    for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) mean += quadratic(coef, x / cw, y / ch);
    mean /= cw * ch;
    for (let y = 0; y < ch; y++) {
      for (let x = 0; x < cw; x++) {
        gain[y * cw + x] = Math.max(0.5, Math.min(3, mean / Math.max(1, quadratic(coef, x / cw, y / ch))));
      }
    }
    return { gain, w: cw, h: ch };
  }

  /** In-place adjustment of an RGBA frame; `flat` is a flattenMap result or null. */
  function applyAdjust(d, w, h, lut, flat) {
    for (let y = 0, i = 0; y < h; y++) {
      const row = flat ? (y / FLAT_SCALE | 0) * flat.w : 0;
      for (let x = 0; x < w; x++, i += 4) {
        const gain = flat ? flat.gain[row + (x / FLAT_SCALE | 0)] : 1;
        d[i] = lut.r[Math.min(255, d[i] * gain) | 0];
        d[i + 1] = lut.g[Math.min(255, d[i + 1] * gain) | 0];
        d[i + 2] = lut.b[Math.min(255, d[i + 2] * gain) | 0];
      }
    }
  }

  /** Size of the sample the tissue context is built from. */
  function tissueSampleSize(w, h) {
    return { w: Math.ceil(w / ISO_CTX_SCALE), h: Math.ceil(h / ISO_CTX_SCALE) };
  }

  /**
   * Box-blurred yellowness at 1/ISO_CTX_SCALE resolution (summed-area table).
   * @param {Uint8ClampedArray} px RGBA of the image downscaled to tissueSampleSize
   */
  function tissueContext(px, cw, ch) {
    const sat = new Float32Array((cw + 1) * (ch + 1));
    for (let y = 1; y <= ch; y++) {
      let run = 0;
      for (let x = 1; x <= cw; x++) {
        const i = ((y - 1) * cw + (x - 1)) * 4;
        run += Math.max(0, (px[i] + px[i + 1]) / 2 - px[i + 2]);
        sat[y * (cw + 1) + x] = sat[(y - 1) * (cw + 1) + x] + run;
      }
    }
    const data = new Float32Array(cw * ch);
    const r = ISO_CTX_RADIUS, stride = cw + 1;
    for (let y = 0; y < ch; y++) {
      const y0 = Math.max(0, y - r), y1 = Math.min(ch, y + r + 1);
      for (let x = 0; x < cw; x++) {
        const x0 = Math.max(0, x - r), x1 = Math.min(cw, x + r + 1);
        const sum = sat[y1 * stride + x1] - sat[y0 * stride + x1] - sat[y1 * stride + x0] + sat[y0 * stride + x0];
        data[y * cw + x] = sum / ((y1 - y0) * (x1 - x0));
      }
    }
    return { data, w: cw, h: ch };
  }

  /**
   * Stain isolation — a display aid, nothing measured reads it.
   *
   * X-gal lowers red and green far more than blue, so a stained pixel has
   * B/R well above 1 (measured 2 to 4 in the densest cores) while unstained
   * tissue sits near 0.6. The term is gated by a TISSUE CONTEXT — the local
   * mean of "yellowness" (R+G)/2 − B over a ~40 px window — because the
   * matte background carries blue speckles that would otherwise light up: a
   * stain is something blue INSIDE yellow tissue. The gate is low (5) on
   * purpose: a wide stained trunk drags the local mean down to 6–9 while
   * the background never exceeds 2–6. The specimen is painted in dimmed grey
   * and the stain in cyan.
   */
  function applyIsolation(d, w, h, ctxMap) {
    for (let y = 0, i = 0; y < h; y++) {
      const row = (y / ISO_CTX_SCALE | 0) * ctxMap.w;
      for (let x = 0; x < w; x++, i += 4) {
        const r = d[i], g = d[i + 1], b = d[i + 2];
        const lum = 0.299 * r + 0.587 * g + 0.114 * b;
        const tissue = ctxMap.data[row + (x / ISO_CTX_SCALE | 0)];
        const v = tissue > ISO_CTX_MIN ? unit((b / (r + 1) - ISO_RATIO_LO) / (ISO_RATIO_HI - ISO_RATIO_LO)) : 0;
        const grey = lum * 0.35 * (1 - v);
        d[i] = grey + v * 90;
        d[i + 1] = grey + v * 160;
        d[i + 2] = grey + v * 255;
      }
    }
  }

  /**
   * One job, whatever the thread: `frame` is the image's RGBA, `sample(w, h)`
   * returns the image downscaled to w×h (RGBA) for the illumination / context
   * maps, and `cache` ({flat, tissue}) keeps those maps for as long as the
   * image is the same, so a slider drag recomputes the look-up and nothing else.
   * @param {{kind:'adjust'|'isolate', adjust?:object}} job
   */
  function run(job, frame, w, h, sample, cache) {
    if (job.kind === 'isolate') {
      if (!cache.tissue) {
        const s = tissueSampleSize(w, h);
        cache.tissue = tissueContext(sample(s.w, s.h), s.w, s.h);
      }
      applyIsolation(frame, w, h, cache.tissue);
      return;
    }
    let flat = null;
    if (job.adjust.flatten) {
      if (!cache.flat) {
        const s = flatSampleSize(w, h);
        cache.flat = flattenMap(sample(s.w, s.h), s.w, s.h);
      }
      flat = cache.flat;
    }
    applyAdjust(frame, w, h, channelLuts(job.adjust), flat);
  }

  return { channelLuts, flattenMap, flatSampleSize, applyAdjust, tissueContext, tissueSampleSize, applyIsolation, run, percentile, unit };
})();
