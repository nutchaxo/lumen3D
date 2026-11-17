/*
 * ij-analysis.js — thresholds, binary morphology, particle analysis and filters
 * of the Advanced Studio, ported from ImageJ 1.54 (ij.process.AutoThresholder,
 * ij.process.ByteProcessor erode/dilate, ij.plugin.filter.Binary,
 * ij.gui.Wand + ij.plugin.filter.ParticleAnalyzer, ij.plugin.filter.GaussianBlur,
 * ij.plugin.filter.RankFilters).
 *
 * Classic script, no DOM, no dependency: it runs in the page and in a worker and
 * attaches IJThreshold, IJBinary, IJParticles and IJFilters to `self`.
 *
 * Conventions
 *   - A channel image is { width, height, bitDepth, data } with bitDepth 8
 *     (Uint8Array), 16 (Uint16Array) or 32 (Float32Array).
 *   - A mask box is { x, y, w, h, data } (what IJRoi.mask returns): data[j*w+i]
 *     is non-zero when pixel (x+i, y+j) is selected. null = the whole image.
 *   - A binary image is a Uint8Array of w*h values, 0 = background, 255 =
 *     foreground (ImageJ "black background" convention). Every binary routine
 *     returns a NEW array holding exactly 0 or 255.
 *   - Errors carry a `code` (IJ_*), never a user-facing message.
 *
 * Deviations from ImageJ are listed where they occur and in the file's tail.
 */
(function (root) {
  'use strict';

  function fail(code, message) {
    const e = new Error(message || code);
    e.code = code;
    return e;
  }

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  function typedFor(bitDepth, n) {
    if (bitDepth === 8) return new Uint8Array(n);
    if (bitDepth === 16) return new Uint16Array(n);
    if (bitDepth === 32) return new Float32Array(n);
    throw fail('IJ_BAD_BITDEPTH');
  }

  function checkChannel(ch) {
    if (!ch || !ch.data || !(ch.width > 0) || !(ch.height > 0)) throw fail('IJ_BAD_IMAGE');
    if (ch.bitDepth !== 8 && ch.bitDepth !== 16 && ch.bitDepth !== 32) throw fail('IJ_BAD_BITDEPTH');
    if (ch.data.length !== ch.width * ch.height) throw fail('IJ_BAD_IMAGE');
  }

  // Clip a mask box to the image: { x0, y0, x1, y1 } (half-open) or the whole image.
  function boxBounds(mb, w, h) {
    if (!mb) return { x0: 0, y0: 0, x1: w, y1: h };
    return {
      x0: Math.max(0, mb.x), y0: Math.max(0, mb.y),
      x1: Math.min(w, mb.x + mb.w), y1: Math.min(h, mb.y + mb.h)
    };
  }

  // Minimum and maximum of the selected pixels; NaN ignored in 32-bit data.
  function rangeOf(ch, mb) {
    const d = ch.data, w = ch.width, h = ch.height, isF = ch.bitDepth === 32;
    let min = Infinity, max = -Infinity;
    const b = boxBounds(mb, w, h);
    for (let y = b.y0; y < b.y1; y++) {
      const row = y * w;
      const mrow = mb ? (y - mb.y) * mb.w - mb.x : 0;
      for (let x = b.x0; x < b.x1; x++) {
        if (mb && !mb.data[mrow + x]) continue;
        const v = d[row + x];
        if (isF && v !== v) continue;
        if (v < min) min = v;
        if (v > max) max = v;
      }
    }
    if (min > max) return { min: 0, max: 0 };
    return { min: min, max: max };
  }

  // 256-bin histogram of the image ImageJ actually thresholds on. For 16/32-bit
  // data ImageProcessor.setAutoThreshold(Method, …) converts to 8 bits first
  // (resetMinAndMax + convertToByte(true)) and uses that histogram:
  //   16-bit  TypeConverter.convertShortToByte: (int)((v − min)·(256/(max − min + 1)) + 0.5), clamped to 0..255
  //   32-bit  FloatProcessor.create8BitImage:   (int)((v − min)·(255/(max − min)) + 0.5),      clamped to 0..255
  // 8-bit data is counted exactly. NaN is not counted.
  function histogram256(ch, mb, min, max) {
    const counts = new Float64Array(256);
    const d = ch.data, w = ch.width, h = ch.height;
    const b = boxBounds(mb, w, h);
    const is8 = ch.bitDepth === 8, is16 = ch.bitDepth === 16;
    const scale = is16 ? 256 / (max - min + 1) : (max > min ? 255 / (max - min) : 0);
    for (let y = b.y0; y < b.y1; y++) {
      const row = y * w;
      const mrow = mb ? (y - mb.y) * mb.w - mb.x : 0;
      for (let x = b.x0; x < b.x1; x++) {
        if (mb && !mb.data[mrow + x]) continue;
        const v = d[row + x];
        if (is8) { counts[v]++; continue; }
        if (v !== v) continue;
        let idx = Math.trunc((v - min) * scale + 0.5);
        if (idx < 0) idx = 0; else if (idx > 255) idx = 255;
        counts[idx]++;
      }
    }
    return counts;
  }

  // ---------------------------------------------------------------------------
  // IJThreshold — ij.process.AutoThresholder
  // ---------------------------------------------------------------------------
  const IJThreshold = (function () {
    const METHODS = ['Default', 'Huang', 'IsoData', 'Li', 'MaxEntropy', 'Mean', 'Otsu', 'Triangle'];
    const EPS = 2.220446049250313E-16; // Double.MIN_VALUE / DBL_EPSILON of the C sources

    // "Default" of the Threshold dialog = ImageJ's modified IsoData (IJ_IsoData).
    // Bins 0 and 255 are ignored so saturated/erased areas do not count.
    // AutoThresholder.defaultIsoData first clips a dominant mode: when the
    // highest count exceeds twice the second highest (and that one is not 0) the
    // mode bin is set to (int)(1.5 · second highest), then IJ_IsoData runs.
    function ijDefault(data) {
      const maxValue = data.length - 1;
      let mode = 0, maxCount = 0;
      for (let i = 0; i <= maxValue; i++) if (data[i] > maxCount) { maxCount = data[i]; mode = i; }
      let maxCount2 = 0;
      for (let i = 0; i <= maxValue; i++) if (data[i] > maxCount2 && i !== mode) maxCount2 = data[i];
      if (maxCount > maxCount2 * 2 && maxCount2 !== 0) data[mode] = Math.trunc(maxCount2 * 1.5);
      data[0] = 0;
      data[maxValue] = 0;
      let min = 0;
      while (data[min] === 0 && min < maxValue) min++;
      let max = maxValue;
      while (data[max] === 0 && max > 0) max--;
      if (min >= max) return Math.floor(data.length / 2);
      let movingIndex = min;
      let result;
      do {
        let sum1 = 0, sum2 = 0, sum3 = 0, sum4 = 0;
        for (let i = min; i <= movingIndex; i++) { sum1 += i * data[i]; sum2 += data[i]; }
        for (let i = movingIndex + 1; i <= max; i++) { sum3 += i * data[i]; sum4 += data[i]; }
        result = (sum1 / sum2 + sum3 / sum4) / 2.0;
        movingIndex++;
      } while ((movingIndex + 1) <= result && movingIndex < max - 1);
      return Math.round(result);
    }

    // Huang's fuzzy thresholding (minimum fuzzy entropy), ImageJ port of the
    // Fourier library implementation. Deviation: a one-bin histogram returns
    // that bin (ImageJ divides by zero there and ends with -1, i.e. 0).
    function huang(data) {
      let firstBin = 0;
      for (let ih = 0; ih < 256; ih++) if (data[ih] !== 0) { firstBin = ih; break; }
      let lastBin = 255;
      for (let ih = 255; ih >= firstBin; ih--) if (data[ih] !== 0) { lastBin = ih; break; }
      if (lastBin === firstBin) return firstBin;
      const term = 1.0 / (lastBin - firstBin);
      const mu0 = new Float64Array(256);
      let sumPix = 0, numPix = 0;
      for (let ih = firstBin; ih < 256; ih++) {
        sumPix += ih * data[ih];
        numPix += data[ih];
        mu0[ih] = sumPix / numPix;
      }
      const mu1 = new Float64Array(256);
      sumPix = 0; numPix = 0;
      for (let ih = lastBin; ih > 0; ih--) {
        sumPix += ih * data[ih];
        numPix += data[ih];
        mu1[ih - 1] = sumPix / numPix;
      }
      let threshold = -1;
      let minEnt = Number.MAX_VALUE;
      for (let it = 0; it < 256; it++) {
        let ent = 0.0;
        for (let ih = 0; ih <= it; ih++) {
          const mu = 1.0 / (1.0 + term * Math.abs(ih - mu0[it]));
          if (!(mu < 1e-06 || mu > 0.999999)) {
            ent += data[ih] * (-mu * Math.log(mu) - (1.0 - mu) * Math.log(1.0 - mu));
          }
        }
        for (let ih = it + 1; ih < 256; ih++) {
          const mu = 1.0 / (1.0 + term * Math.abs(ih - mu1[it]));
          if (!(mu < 1e-06 || mu > 0.999999)) {
            ent += data[ih] * (-mu * Math.log(mu) - (1.0 - mu) * Math.log(1.0 - mu));
          }
        }
        if (ent < minEnt) { minEnt = ent; threshold = it; }
      }
      return threshold;
    }

    // Ridler & Calvard iterative intermeans. The two class means use integer
    // division exactly as ImageJ's int arithmetic does.
    function isoData(data) {
      let g = 0;
      for (let i = 1; i < data.length; i++) {
        if (data[i] > 0) { g = i + 1; break; }
      }
      for (;;) {
        let l = 0, totl = 0;
        for (let i = 0; i < g; i++) { totl += data[i]; l += data[i] * i; }
        let h = 0, toth = 0;
        for (let i = g + 1; i < data.length; i++) { toth += data[i]; h += data[i] * i; }
        if (totl > 0 && toth > 0) {
          l = Math.floor(l / totl);
          h = Math.floor(h / toth);
          if (g === Math.round((l + h) / 2.0)) break;
        }
        g++;
        if (g > data.length - 2) return -1; // "IsoData Threshold not found"
      }
      return g;
    }

    // Li's iterative minimum cross entropy.
    function li(data) {
      const tolerance = 0.5;
      let numPixels = 0;
      for (let ih = 0; ih < 256; ih++) numPixels += data[ih];
      let mean = 0.0;
      for (let ih = 1; ih < 256; ih++) mean += ih * data[ih];
      mean /= numPixels;
      let newThresh = mean;
      let oldThresh, threshold;
      let guard = 0;
      do {
        oldThresh = newThresh;
        threshold = Math.trunc(oldThresh + 0.5);
        let sumBack = 0, numBack = 0;
        for (let ih = 0; ih <= threshold; ih++) { sumBack += ih * data[ih]; numBack += data[ih]; }
        const meanBack = numBack === 0 ? 0.0 : sumBack / numBack;
        let sumObj = 0, numObj = 0;
        for (let ih = threshold + 1; ih < 256; ih++) { sumObj += ih * data[ih]; numObj += data[ih]; }
        const meanObj = numObj === 0 ? 0.0 : sumObj / numObj;
        const temp = (meanBack - meanObj) / (Math.log(meanBack) - Math.log(meanObj));
        if (temp < -EPS) newThresh = Math.trunc(temp - 0.5);
        else newThresh = Math.trunc(temp + 0.5);
        if (!(newThresh === newThresh)) break; // NaN: a class is empty
      } while (Math.abs(newThresh - oldThresh) > tolerance && ++guard < 10000);
      return threshold;
    }

    // Kapur, Sahoo & Wong maximum entropy.
    function maxEntropy(data) {
      let total = 0;
      for (let ih = 0; ih < 256; ih++) total += data[ih];
      const norm = new Float64Array(256);
      for (let ih = 0; ih < 256; ih++) norm[ih] = data[ih] / total;
      const P1 = new Float64Array(256), P2 = new Float64Array(256);
      P1[0] = norm[0];
      P2[0] = 1.0 - P1[0];
      for (let ih = 1; ih < 256; ih++) {
        P1[ih] = P1[ih - 1] + norm[ih];
        P2[ih] = 1.0 - P1[ih];
      }
      let firstBin = 0;
      for (let ih = 0; ih < 256; ih++) {
        if (!(Math.abs(P1[ih]) < EPS)) { firstBin = ih; break; }
      }
      let lastBin = 255;
      for (let ih = 255; ih >= firstBin; ih--) {
        if (!(Math.abs(P2[ih]) < EPS)) { lastBin = ih; break; }
      }
      let threshold = -1;
      let maxEnt = Number.MIN_VALUE; // smallest positive double, as Double.MIN_VALUE
      for (let it = firstBin; it <= lastBin; it++) {
        let entBack = 0.0;
        for (let ih = 0; ih <= it; ih++) {
          if (data[ih] !== 0) entBack -= (norm[ih] / P1[it]) * Math.log(norm[ih] / P1[it]);
        }
        let entObj = 0.0;
        for (let ih = it + 1; ih < 256; ih++) {
          if (data[ih] !== 0) entObj -= (norm[ih] / P2[it]) * Math.log(norm[ih] / P2[it]);
        }
        const totEnt = entBack + entObj;
        if (maxEnt < totEnt) { maxEnt = totEnt; threshold = it; }
      }
      return threshold;
    }

    function meanMethod(data) {
      let tot = 0, sum = 0;
      for (let i = 0; i < 256; i++) { tot += data[i]; sum += i * data[i]; }
      return Math.floor(sum / tot);
    }

    // Otsu, the Celebi/Landini formulation of ImageJ >= 1.53k: first maximum of
    // the between-class variance wins.
    function otsu(data) {
      let numPixels = 0;
      for (let ih = 0; ih < 256; ih++) numPixels += data[ih];
      const term = 1.0 / numPixels;
      const histo = new Float64Array(256), cnh = new Float64Array(256), mean = new Float64Array(256);
      for (let ih = 0; ih < 256; ih++) histo[ih] = term * data[ih];
      cnh[0] = histo[0];
      for (let ih = 1; ih < 256; ih++) cnh[ih] = cnh[ih - 1] + histo[ih];
      mean[0] = 0.0;
      for (let ih = 1; ih < 256; ih++) mean[ih] = mean[ih - 1] + ih * histo[ih];
      const totalMean = mean[255];
      let threshold = -1;
      let maxBcv = 0.0;
      for (let ih = 0; ih < 256; ih++) {
        let bcv = totalMean * cnh[ih] - mean[ih];
        bcv *= bcv / (cnh[ih] * (1.0 - cnh[ih]));
        if (maxBcv < bcv) { maxBcv = bcv; threshold = ih; }
      }
      return threshold;
    }

    // Zack, Rogers & Latt triangle; the histogram is mirrored when its longer
    // tail is on the left so the peak-to-tail line is always taken on the long side.
    function triangle(data) {
      const L = data.length;
      let min = 0, dmax = 0, max = 0, min2 = 0;
      for (let i = 0; i < L; i++) if (data[i] > 0) { min = i; break; }
      if (min > 0) min--;
      for (let i = L - 1; i > 0; i--) if (data[i] > 0) { min2 = i; break; }
      if (min2 < L - 1) min2++;
      for (let i = 0; i < L; i++) if (data[i] > dmax) { max = i; dmax = data[i]; }
      let inverted = false;
      if ((max - min) < (min2 - max)) {
        inverted = true;
        data.reverse();
        min = L - 1 - min2;
        max = L - 1 - max;
      }
      if (min === max) return inverted ? L - 1 - min : min;
      let nx = data[max];
      let ny = min - max;
      let d = Math.sqrt(nx * nx + ny * ny);
      nx /= d;
      ny /= d;
      d = nx * min + ny * data[min];
      let split = min;
      let splitDistance = 0;
      for (let i = min + 1; i <= max; i++) {
        const newDistance = nx * i + ny * data[i] - d;
        if (newDistance > splitDistance) { split = i; splitDistance = newDistance; }
      }
      split--;
      return inverted ? L - 1 - split : split;
    }

    function canonicalMethod(method) {
      const m = String(method == null ? 'Default' : method);
      if (m === 'IJ_IsoData' || m === 'IJ_Default') return 'Default';
      const lower = m.toLowerCase();
      for (let i = 0; i < METHODS.length; i++) if (METHODS[i].toLowerCase() === lower) return METHODS[i];
      throw fail('IJ_BAD_METHOD');
    }

    // Threshold bin (0..255) of a 256-bin histogram. As ImageJ's getThreshold:
    // a method that finds nothing (-1) answers 0. Deviation: an empty histogram
    // answers 0 instead of producing NaNs.
    function level(counts, method) {
      if (!counts || counts.length !== 256) throw fail('IJ_BAD_HISTOGRAM');
      const name = canonicalMethod(method);
      const data = new Float64Array(256);
      let total = 0;
      for (let i = 0; i < 256; i++) { data[i] = counts[i]; total += data[i]; }
      if (!(total > 0)) return 0;
      // AutoThresholder.bilevel: a histogram with one or two non-empty bins
      // answers (index of the only / second bin) − 1, whatever the method.
      let nz = 0, first = -1, second = -1;
      for (let i = 0; i < 256; i++) {
        if (data[i] > 0) { nz++; if (nz > 2) break; if (first < 0) first = i; else second = i; }
      }
      if (nz === 1 || nz === 2) {
        const bl = (nz === 1 ? first : second) - 1;
        if (bl >= 0) return bl;
      }
      let t;
      switch (name) {
        case 'Huang': t = huang(data); break;
        case 'IsoData': t = isoData(data); break;
        case 'Li': t = li(data); break;
        case 'MaxEntropy': t = maxEntropy(data); break;
        case 'Mean': t = meanMethod(data); break;
        case 'Otsu': t = otsu(data); break;
        case 'Triangle': t = triangle(data); break;
        default: t = ijDefault(data);
      }
      if (!(t >= 0)) t = 0;
      return t > 255 ? 255 : t;
    }

    // The 256-bin histogram the methods run on, plus the value range it spans.
    function histogram(ch, opts) {
      checkChannel(ch);
      opts = opts || {};
      let min = 0, max = 255;
      if (ch.bitDepth !== 8) {
        const r = rangeOf(ch, opts.maskBox);
        min = opts.min != null ? opts.min : r.min;
        max = opts.max != null ? opts.max : r.max;
      }
      return { counts: histogram256(ch, opts.maskBox || null, min, max), min: min, max: max };
    }

    // Lower/upper pixel values selected by an automatic threshold, ImageJ's
    // ImageProcessor.setAutoThreshold(method, darkBackground):
    //   dark background  → the objects are the bright pixels: lower = t+1 (bin), upper = 255 (bin)
    //   light background → the objects are the dark pixels:   lower = 0,   upper = t
    // 16/32-bit bins are mapped back with value = min + bin/255 · (max − min).
    function levels(ch, method, opts) {
      opts = opts || {};
      const hs = histogram(ch, opts);
      const t = level(hs.counts, method);
      let lower, upper;
      if (opts.dark) { lower = t + 1; upper = 255; } else { lower = 0; upper = t; }
      if (lower > 255) lower = 255;
      if (ch.bitDepth !== 8) {
        if (hs.max > hs.min) {
          lower = hs.min + (lower / 255.0) * (hs.max - hs.min);
          upper = hs.min + (upper / 255.0) * (hs.max - hs.min);
        } else {
          lower = upper = hs.min;
        }
      }
      return { lower: lower, upper: upper, level: t, min: hs.min, max: hs.max };
    }

    // 0/255 mask of the pixels with lower <= value <= upper (NaN never selected).
    function toMask(ch, lower, upper) {
      checkChannel(ch);
      const d = ch.data, n = d.length;
      const out = new Uint8Array(n);
      for (let i = 0; i < n; i++) {
        const v = d[i];
        if (v >= lower && v <= upper) out[i] = 255;
      }
      return out;
    }

    return {
      methods: function () { return METHODS.slice(); },
      level: level,
      histogram: histogram,
      levels: levels,
      toMask: toMask
    };
  })();

  // ---------------------------------------------------------------------------
  // IJBinary — ByteProcessor.erode/dilate(count, background) and ij.plugin.filter.Binary
  // ---------------------------------------------------------------------------
  const IJBinary = (function () {
    // Pixels outside the image count as background (ImageJ default, "Pad edges
    // when eroding" off): a particle touching the border erodes from it.
    function padded(src, w, h) {
      const pw = w + 2;
      const pad = new Uint8Array(pw * (h + 2));
      for (let y = 0; y < h; y++) {
        const o = (y + 1) * pw + 1, s = y * w;
        for (let x = 0; x < w; x++) if (src[s + x] !== 0) pad[o + x] = 1;
      }
      return pad;
    }

    // One pass. Erode: a foreground pixel with >= count background 8-neighbours
    // becomes background. Dilate: a background pixel with >= count foreground
    // 8-neighbours becomes foreground.
    function pass(src, w, h, isDilate, count) {
      const pw = w + 2;
      const pad = padded(src, w, h);
      const out = new Uint8Array(w * h);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const p = (y + 1) * pw + x + 1;
          const v = pad[p];
          const fgNeighbours = pad[p - pw - 1] + pad[p - pw] + pad[p - pw + 1] +
            pad[p - 1] + pad[p + 1] + pad[p + pw - 1] + pad[p + pw] + pad[p + pw + 1];
          if (isDilate) {
            out[y * w + x] = (v || fgNeighbours >= count) ? 255 : 0;
          } else {
            out[y * w + x] = (v && (8 - fgNeighbours) < count) ? 255 : 0;
          }
        }
      }
      return out;
    }

    function readOpts(opts) {
      const o = opts || {};
      const iterations = o.iterations == null ? 1 : Math.floor(o.iterations);
      const count = o.count == null ? 1 : Math.floor(o.count);
      if (!(iterations >= 1) || !(count >= 1 && count <= 8)) throw fail('IJ_BAD_PARAMS');
      return { iterations: iterations, count: count };
    }

    function repeated(src, w, h, isDilate, o) {
      let cur = src;
      for (let i = 0; i < o.iterations; i++) cur = pass(cur, w, h, isDilate, o.count);
      return cur;
    }

    function coreErode(src, w, h, opts) {
      const o = readOpts(opts);
      return repeated(src, w, h, false, o);
    }
    function coreDilate(src, w, h, opts) {
      const o = readOpts(opts);
      return repeated(src, w, h, true, o);
    }
    // Binary.open: `iterations` erosions then `iterations` dilations.
    function coreOpen(src, w, h, opts) {
      const o = readOpts(opts);
      return repeated(repeated(src, w, h, false, o), w, h, true, o);
    }
    // Binary.close: `iterations` dilations then `iterations` erosions.
    function coreClose(src, w, h, opts) {
      const o = readOpts(opts);
      return repeated(repeated(src, w, h, true, o), w, h, false, o);
    }

    // Binary.fill: background pixels 4-connected to the image border stay
    // background, everything else becomes foreground (FloodFiller is 4-connected).
    function coreFillHoles(src, w, h) {
      const n = w * h;
      const outside = new Uint8Array(n);
      const stack = new Int32Array(n);
      let sp = 0;
      function seed(i) { if (src[i] === 0 && !outside[i]) { outside[i] = 1; stack[sp++] = i; } }
      for (let x = 0; x < w; x++) { seed(x); seed((h - 1) * w + x); }
      for (let y = 0; y < h; y++) { seed(y * w); seed(y * w + w - 1); }
      while (sp > 0) {
        const i = stack[--sp];
        const x = i % w, y = (i - x) / w;
        if (x > 0) seed(i - 1);
        if (x < w - 1) seed(i + 1);
        if (y > 0) seed(i - w);
        if (y < h - 1) seed(i + w);
      }
      const out = new Uint8Array(n);
      for (let i = 0; i < n; i++) out[i] = outside[i] ? 0 : 255;
      return out;
    }

    // BinaryProcessor.outline: a foreground pixel survives only when one of its
    // eight neighbours is background (outside the image counts as background).
    function coreOutline(src, w, h) {
      const pw = w + 2;
      const pad = padded(src, w, h);
      const out = new Uint8Array(w * h);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const p = (y + 1) * pw + x + 1;
          if (!pad[p]) continue;
          const s = pad[p - pw - 1] + pad[p - pw] + pad[p - pw + 1] + pad[p - 1] +
            pad[p + 1] + pad[p + pw - 1] + pad[p + pw] + pad[p + pw + 1];
          if (s < 8) out[y * w + x] = 255;
        }
      }
      return out;
    }

    // Both call shapes: (data, w, h, opts) → Uint8Array, or (channel, opts) →
    // an 8-bit channel image.
    function wrap(core) {
      return function (a, b, c, d) {
        if (a && a.data && a.width > 0 && typeof b !== 'number') {
          return { width: a.width, height: a.height, bitDepth: 8, data: core(a.data, a.width, a.height, b || {}) };
        }
        if (!a || !(b > 0) || !(c > 0) || a.length !== b * c) throw fail('IJ_BAD_IMAGE');
        return core(a, b, c, d || {});
      };
    }

    return {
      erode: wrap(coreErode),
      dilate: wrap(coreDilate),
      open: wrap(coreOpen),
      close: wrap(coreClose),
      fillHoles: wrap(coreFillHoles),
      outline: wrap(coreOutline)
    };
  })();

  // ---------------------------------------------------------------------------
  // IJParticles — ij.plugin.filter.ParticleAnalyzer on a binary image
  // ---------------------------------------------------------------------------
  const IJParticles = (function () {
    const DX = [1, 0, -1, 0];
    const DY = [0, 1, 0, -1];

    // Trace the outer boundary of the 8-connected object whose first pixel in
    // raster order is (sx, sy), on pixel corners, keeping the object on the
    // right-hand side (clockwise on screen). The returned polygon holds only the
    // vertices where the direction changes, like ij.gui.Wand. Pixels connected
    // only diagonally belong to the same object: the contour turns left around
    // the diagonal neighbour instead of cutting it off.
    function traceOutline(work, w, h, sx, sy) {
      function fg(x, y) { return x >= 0 && y >= 0 && x < w && y < h && work[y * w + x] === 1; }
      const pts = [];
      let x = sx, y = sy, d = 0;
      const limit = 4 * (w + 1) * (h + 1) + 16;
      for (let steps = 0; steps < limit; steps++) {
        x += DX[d];
        y += DY[d];
        // The two pixels flanking the edge that would continue straight ahead.
        let lx, ly, rx, ry;
        if (d === 0) { lx = x; ly = y - 1; rx = x; ry = y; }
        else if (d === 1) { lx = x; ly = y; rx = x - 1; ry = y; }
        else if (d === 2) { lx = x - 1; ly = y; rx = x - 1; ry = y - 1; }
        else { lx = x - 1; ly = y - 1; rx = x; ry = y - 1; }
        let nd;
        if (fg(lx, ly)) nd = (d + 3) & 3;      // turn left
        else if (fg(rx, ry)) nd = d;           // straight on
        else nd = (d + 1) & 3;                 // turn right
        if (nd !== d) pts.push([x, y]);
        if (x === sx && y === sy) return pts;
        d = nd;
      }
      throw fail('IJ_TRACE_FAILED');
    }

    // PolygonRoi.getTracedPerimeter: Σ|dx|·pw + Σ|dy|·ph − nCorners·((pw + ph) − √(pw² + ph²)).
    // The corner count depends on which vertex comes first (ImageJ documents this),
    // so analyze() hands it the outline starting where ImageJ's Wand does.
    function tracedPerimeter(pts, pw, ph) {
      const n = pts.length;
      if (n < 4) return 0;
      let sumdx = 0, sumdy = 0, nCorners = 0;
      let dx1 = pts[0][0] - pts[n - 1][0];
      let dy1 = pts[0][1] - pts[n - 1][1];
      let side1 = Math.abs(dx1) + Math.abs(dy1);
      let corner = false;
      for (let i = 0; i < n; i++) {
        const next = i + 1 === n ? 0 : i + 1;
        const dx2 = pts[next][0] - pts[i][0];
        const dy2 = pts[next][1] - pts[i][1];
        sumdx += Math.abs(dx1);
        sumdy += Math.abs(dy1);
        const side2 = Math.abs(dx2) + Math.abs(dy2);
        if (side1 > 1 || !corner) { corner = true; nCorners++; } else { corner = false; }
        dx1 = dx2;
        dy1 = dy2;
        side1 = side2;
      }
      return sumdx * pw + sumdy * ph - nCorners * ((pw + ph) - Math.sqrt(pw * pw + ph * ph));
    }

    // Statistics of the image pixels listed in idx[0..n) (ImageStatistics rules,
    // as IJOps.statistics): mean, sample stdDev, min, max, median (8/16-bit: first
    // value whose running count exceeds n/2; 32-bit: sorted middle, mean of the
    // two middle values for an even count), mode, intDen = area·mean, rawIntDen,
    // centre of mass. NaN / ±Infinity pixels of a 32-bit image are left out.
    function particleStats(ch, idx, n, pw, ph, w) {
      const d = ch.data, f32 = ch.bitDepth === 32;
      let k = 0, sum = 0, min = Infinity, max = -Infinity, vx = 0, vy = 0;
      const vals = f32 ? new Float32Array(n) : null;
      const counts = f32 ? null : new Uint32Array(ch.bitDepth === 8 ? 256 : 65536);
      for (let j = 0; j < n; j++) {
        const i = idx[j], v = d[i];
        if (f32 && v - v !== 0) continue;
        const x = i % w, y = (i - x) / w;
        k++; sum += v;
        if (v < min) min = v;
        if (v > max) max = v;
        vx += v * (x + 0.5); vy += v * (y + 0.5);
        if (f32) vals[k - 1] = v; else counts[v]++;
      }
      if (k === 0) return { mean: NaN, stdDev: NaN, min: NaN, max: NaN, median: NaN, mode: NaN, intDen: 0, rawIntDen: 0, xCenterOfMass: NaN, yCenterOfMass: NaN };
      const mean = sum / k;
      let m2 = 0;
      for (let j = 0; j < n; j++) {
        const v = d[idx[j]];
        if (f32 && v - v !== 0) continue;
        m2 += (v - mean) * (v - mean);
      }
      let median, mode = 0;
      if (f32) {
        const sorted = vals.subarray(0, k).sort();
        const m = k >> 1;
        median = (k & 1) ? sorted[m] : Math.fround((sorted[m - 1] + sorted[m]) / 2);
        if (max === min) mode = min;
        else {
          const c = new Uint32Array(256), bw = (max - min) / 256;
          for (let j = 0; j < k; j++) { let b = Math.floor((sorted[j] - min) / bw); if (b > 255) b = 255; c[b]++; }
          let best = 0;
          for (let b = 1; b < 256; b++) if (c[b] > c[best]) best = b;
          mode = min + best * bw + bw / 2;
        }
      } else {
        let cum = 0, bestC = -1, found = false;
        median = 0;
        for (let v = 0; v < counts.length; v++) {
          const c = counts[v];
          if (c > bestC) { bestC = c; mode = v; }
          if (!found) { cum += c; if (cum > k / 2) { median = v; found = true; } }
        }
      }
      return {
        mean: mean, stdDev: k > 1 ? Math.sqrt(m2 / (k - 1)) : 0, min: min, max: max, median: median, mode: mode,
        intDen: k * pw * ph * mean, rawIntDen: sum,
        xCenterOfMass: sum !== 0 ? vx / sum * pw : NaN, yCenterOfMass: sum !== 0 ? vy / sum * ph : NaN
      };
    }

    // True when a pixel across one of the outline's edges (the side away from the
    // particle; the outline runs clockwise, object on the right) lies inside the
    // image but outside the selection mask: the particle touches the selection's edge.
    function touchesOutside(outline, mb, w, h) {
      const n = outline.length;
      for (let i = 0; i < n; i++) {
        const p = outline[i], q = outline[(i + 1) % n];
        const sxn = Math.sign(q[0] - p[0]), syn = Math.sign(q[1] - p[1]);
        const len = Math.abs(q[0] - p[0]) + Math.abs(q[1] - p[1]);
        for (let k = 0; k < len; k++) {
          const x = p[0] + sxn * k, y = p[1] + syn * k;
          let px, py;
          if (sxn > 0) { px = x; py = y - 1; }
          else if (sxn < 0) { px = x - 1; py = y; }
          else if (syn > 0) { px = x; py = y; }
          else { px = x - 1; py = y - 1; }
          if (px < 0 || py < 0 || px >= w || py >= h) continue;
          if (px < mb.x || py < mb.y || px >= mb.x + mb.w || py >= mb.y + mb.h || mb.data[(py - mb.y) * mb.w + (px - mb.x)] === 0) return true;
        }
      }
      return false;
    }

    // opts: calibration, minSize/maxSize (pixels), minCirc/maxCirc, excludeEdges,
    // includeHoles, maskBox (analysis restricted to a selection) and channel
    // (the image the binary was made from, { data, bitDepth } of the same size:
    // each particle then carries `stats`, the measurements of its pixels).
    function analyze(mask, w, h, opts) {
      opts = opts || {};
      if (!mask || !(w > 0) || !(h > 0) || mask.length !== w * h) throw fail('IJ_BAD_IMAGE');
      const cal = opts.calibration || {};
      const pw = cal.pixelWidth > 0 ? cal.pixelWidth : 1;
      const ph = cal.pixelHeight > 0 ? cal.pixelHeight : 1;
      const minSize = opts.minSize != null ? opts.minSize : 0;
      const maxSize = opts.maxSize != null ? opts.maxSize : Infinity;
      const minCirc = opts.minCirc != null ? opts.minCirc : 0;
      const maxCirc = opts.maxCirc != null ? opts.maxCirc : 1;
      const excludeEdges = !!opts.excludeEdges;
      const includeHoles = !!opts.includeHoles;
      const n = w * h;

      // Working copy: 1 = foreground not yet analysed. Analysed particles are
      // erased (ImageJ fills them) whether or not they pass the filters.
      const work = new Uint8Array(n);
      const mb = opts.maskBox || null;
      for (let i = 0; i < n; i++) if (mask[i] !== 0) work[i] = 1;
      if (mb) {
        const b = boxBounds(mb, w, h);
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            const inside = x >= b.x0 && x < b.x1 && y >= b.y0 && y < b.y1 &&
              mb.data[(y - mb.y) * mb.w + (x - mb.x)] !== 0;
            if (!inside) work[y * w + x] = 0;
          }
        }
      }

      // Selection the analysis is restricted to: ImageJ excludes on the edges of
      // THIS rectangle (r = ip.getRoi()) and divides %Area by its (mask) area.
      const sb = mb ? boxBounds(mb, w, h) : { x0: 0, y0: 0, x1: w, y1: h };
      let roiPx = n;
      if (mb) {
        roiPx = 0;
        for (let y = sb.y0; y < sb.y1; y++) for (let x = sb.x0; x < sb.x1; x++) if (mb.data[(y - mb.y) * mb.w + (x - mb.x)] !== 0) roiPx++;
      }
      const img = opts.channel && opts.channel.data && opts.channel.data.length === n ? opts.channel : null;
      let pix = img ? new Int32Array(1024) : null, np = 0;
      const addPix = img ? function (i) {
        if (np === pix.length) { const bigger = new Int32Array(pix.length * 2); bigger.set(pix); pix = bigger; }
        pix[np++] = i;
      } : null;

      let stack = new Int32Array(1024);
      const particles = [];
      let totalAreaPx = 0, totalArea = 0;

      for (let start = 0; start < n; start++) {
        if (work[start] !== 1) continue;
        const sx = start % w, sy = (start - sx) / w;
        let outline = traceOutline(work, w, h, sx, sy);
        // ImageJ's Wand starts at the vertex below the end of the first row run
        // (xEnd, sy + 1), walking down, and its polygon begins with the first
        // corner at or after it; traceOutline starts on the top-left corner, so
        // its first vertex is (xEnd, sy) and the ImageJ order begins one later.
        // The traced perimeter's corner count depends on this start.
        {
          let xEnd = sx;
          while (xEnd < w && work[sy * w + xEnd] === 1) xEnd++;
          if (outline.length > 1 && outline[0][0] === xEnd && outline[0][1] === sy) outline = outline.slice(1).concat([outline[0]]);
        }
        np = 0;

        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (let i = 0; i < outline.length; i++) {
          const p = outline[i];
          if (p[0] < minX) minX = p[0];
          if (p[0] > maxX) maxX = p[0];
          if (p[1] < minY) minY = p[1];
          if (p[1] > maxY) maxY = p[1];
        }
        const bw = maxX - minX, bh = maxY - minY;

        let areaPx = 0, sumX = 0, sumY = 0;
        if (includeHoles) {
          // Every pixel whose centre lies inside the traced polygon (even-odd
          // rule on the vertical edges), interior islands included; all erased.
          const rows = new Array(bh);
          for (let i = 0; i < outline.length; i++) {
            const p = outline[i], q = outline[(i + 1) % outline.length];
            if (p[0] === q[0] && p[1] !== q[1]) {
              const y0 = Math.min(p[1], q[1]), y1 = Math.max(p[1], q[1]);
              for (let yy = y0; yy < y1; yy++) {
                const k = yy - minY;
                (rows[k] || (rows[k] = [])).push(p[0]);
              }
            }
          }
          for (let k = 0; k < bh; k++) {
            const xs = rows[k];
            if (!xs) continue;
            xs.sort(function (a, b) { return a - b; });
            const y = minY + k;
            for (let j = 0; j + 1 < xs.length; j += 2) {
              for (let x = xs[j]; x < xs[j + 1]; x++) {
                work[y * w + x] = 0;
                if (addPix) addPix(y * w + x);
                areaPx++;
                sumX += x;
                sumY += y;
              }
            }
          }
        } else {
          // The 8-connected component alone: holes stay out of the area and
          // particles inside a hole are analysed on their own.
          let sp = 0;
          stack[sp++] = start;
          work[start] = 0;
          while (sp > 0) {
            const i = stack[--sp];
            const x = i % w, y = (i - x) / w;
            if (addPix) addPix(i);
            areaPx++;
            sumX += x;
            sumY += y;
            for (let dy = -1; dy <= 1; dy++) {
              const yy = y + dy;
              if (yy < 0 || yy >= h) continue;
              for (let dx = -1; dx <= 1; dx++) {
                const xx = x + dx;
                if (xx < 0 || xx >= w) continue;
                const j = yy * w + xx;
                if (work[j] === 1) {
                  work[j] = 0;
                  if (sp === stack.length) {
                    const bigger = new Int32Array(stack.length * 2);
                    bigger.set(stack);
                    stack = bigger;
                  }
                  stack[sp++] = j;
                }
              }
            }
          }
        }

        const area = areaPx * pw * ph;
        const perimeter = tracedPerimeter(outline, pw, ph);
        let circularity = perimeter === 0 ? 0 : 4 * Math.PI * (area / (perimeter * perimeter));
        if (circularity > 1) circularity = 1;

        let keep = areaPx >= minSize && areaPx <= maxSize;
        if (keep && (circularity < minCirc || circularity > maxCirc)) keep = false;
        if (keep && excludeEdges) {
          if (minX <= sb.x0 || minY <= sb.y0 || maxX >= sb.x1 || maxY >= sb.y1) keep = false;
          else if (mb && touchesOutside(outline, mb, w, h)) keep = false;
        }
        if (!keep) continue;

        const rec = {
          area: area,
          areaPx: areaPx,
          perimeter: perimeter,
          circularity: circularity,
          bx: minX, by: minY, bw: bw, bh: bh,
          xCentroid: (sumX / areaPx + 0.5) * pw,
          yCentroid: (sumY / areaPx + 0.5) * ph,
          outline: outline
        };
        if (img) rec.stats = particleStats(img, pix, np, pw, ph, w);
        particles.push(rec);
        totalAreaPx += areaPx;
        totalArea += area;
      }

      const count = particles.length;
      const fraction = roiPx > 0 ? totalAreaPx / roiPx : 0;  // ImageJ: the selection's area, else the whole image
      return {
        particles: particles,
        count: count,
        totalArea: totalArea,
        averageSize: count ? totalArea / count : 0,
        areaFraction: fraction,        // 0..1
        percentArea: fraction * 100    // ImageJ's "%Area"
      };
    }

    return { analyze: analyze, tracedPerimeter: tracedPerimeter };
  })();

  // ---------------------------------------------------------------------------
  // IJFilters — GaussianBlur and RankFilters
  // ---------------------------------------------------------------------------
  const IJFilters = (function () {
    // Optional cooperative hook: opts.yieldEvery = { rows, fn } (or a bare
    // function, every 64 rows). fn(rowsDone, rowsTotal) may throw to cancel.
    function makeTick(opts, total) {
      const y = opts && opts.yieldEvery;
      let fn = null, every = 64;
      if (typeof y === 'function') fn = y;
      else if (y && typeof y.fn === 'function') { fn = y.fn; if (y.rows > 0) every = y.rows | 0; }
      if (!fn) return null;
      let since = 0, done = 0;
      return function (rows) {
        done += rows;
        since += rows;
        if (since >= every) { since = 0; fn(done, total); }
      };
    }

    function regionOf(region, w, h) {
      if (!region) return { x0: 0, y0: 0, x1: w, y1: h };
      const x0 = Math.max(0, Math.floor(region.x0)), y0 = Math.max(0, Math.floor(region.y0));
      const x1 = Math.min(w, Math.ceil(region.x1)), y1 = Math.min(h, Math.ceil(region.y1));
      if (!(x1 > x0) || !(y1 > y0)) throw fail('IJ_BAD_REGION');
      return { x0: x0, y0: y0, x1: x1, y1: y1 };
    }

    // ---- Gaussian --------------------------------------------------------

    // Half-width (in pixels, centre excluded counts as index 0) ImageJ uses
    // for a given sigma and accuracy: ceil(σ·√(−2·ln accuracy)) + 1.
    function kernelRadius(sigma, accuracy) {
      return Math.ceil(sigma * Math.sqrt(-2 * Math.log(accuracy))) + 1;
    }

    // GaussianBlur.makeGaussianKernel: Float32 kernel of kRadius taps (tap 0 =
    // centre), tails bent into a parabola-in-√ so the kernel ends smoothly,
    // normalised so centre + 2·Σ(taps) = 1; `sums[i]` is the weight of every tap
    // beyond i on one side (the edge-replication weights).
    function makeKernel(sigma, accuracy, maxRadius) {
      let kRadius = kernelRadius(sigma, accuracy);
      if (maxRadius < 50) maxRadius = 50;
      if (kRadius > maxRadius) kRadius = maxRadius;
      const kernel = new Float32Array(kRadius);
      const sums = new Float32Array(kRadius);
      for (let i = 0; i < kRadius; i++) kernel[i] = Math.exp(-0.5 * i * i / sigma / sigma);
      if (kRadius < maxRadius && kRadius > 3) {
        let sqrtSlope = Number.MAX_VALUE;
        let r = kRadius;
        while (r > Math.floor(kRadius / 2)) {
          r--;
          const a = Math.sqrt(kernel[r]) / (kRadius - r);
          if (a < sqrtSlope) sqrtSlope = a; else break;
        }
        for (let r1 = r + 2; r1 < kRadius; r1++) {
          kernel[r1] = (kRadius - r1) * (kRadius - r1) * sqrtSlope * sqrtSlope;
        }
      }
      let sum;
      if (kRadius < maxRadius) {
        sum = kernel[0];
        for (let i = 1; i < kRadius; i++) sum += 2 * kernel[i];
      } else {
        sum = sigma * Math.sqrt(2 * Math.PI);
      }
      let rsum = 0.5 + 0.5 * kernel[0] / sum;
      for (let i = 0; i < kRadius; i++) {
        const v = kernel[i] / sum;
        kernel[i] = v;
        rsum -= v;
        sums[i] = rsum;
      }
      return { kernel: kernel, sums: sums, radius: kRadius };
    }

    function storeValue(bitDepth, v) {
      if (bitDepth === 32) return v;
      const r = Math.floor(v + 0.5);
      const max = bitDepth === 8 ? 255 : 65535;
      return r < 0 ? 0 : (r > max ? max : r);
    }

    // Separable Gaussian, X then Y, edge pixels replicated beyond the image
    // (ImageJ's out-of-image rule). Float32 intermediate, results rounded half up
    // and clamped for 8/16 bits. Deviation: no downscaling shortcut for large
    // sigma — the answer equals ImageJ's within its accuracy bound (0.002 for
    // 8-bit, 0.0002 for 16/32-bit, of the kernel peak).
    // opts: accuracy, region {x0,y0,x1,y1} (only that part is computed; the
    // returned image has the region's size and x0/y0), yieldEvery.
    function gaussian(ch, sigmaX, sigmaY, opts) {
      checkChannel(ch);
      opts = opts || {};
      const w = ch.width, h = ch.height, bd = ch.bitDepth, src = ch.data;
      if (sigmaY == null) sigmaY = sigmaX;
      if (!(sigmaX >= 0) || !(sigmaY >= 0)) throw fail('IJ_BAD_PARAMS');
      const accuracy = opts.accuracy > 0 ? opts.accuracy : (bd === 8 ? 0.002 : 0.0002);
      const reg = regionOf(opts.region, w, h);
      const rw = reg.x1 - reg.x0, rh = reg.y1 - reg.y0;
      const kx = sigmaX > 0 ? makeKernel(sigmaX, accuracy, w) : null;
      const ky = sigmaY > 0 ? makeKernel(sigmaY, accuracy, h) : null;
      const Rx = kx ? kx.radius - 1 : 0;
      const Ry = ky ? ky.radius - 1 : 0;
      const ya = ky ? Math.max(0, reg.y0 - Ry) : reg.y0;
      const yb = ky ? Math.min(h, reg.y1 + Ry) : reg.y1;
      const midRows = yb - ya;
      const tick = makeTick(opts, midRows + rh);

      // X pass over the rows the Y pass will read.
      const mid = new Float32Array(midRows * rw);
      const pad = new Float32Array(rw + 2 * Rx);
      for (let r = 0; r < midRows; r++) {
        const rowBase = (ya + r) * w;
        const o = r * rw;
        if (kx) {
          for (let i = 0; i < pad.length; i++) pad[i] = src[rowBase + clamp(reg.x0 - Rx + i, 0, w - 1)];
          const k = kx.kernel, k0 = k[0];
          for (let x = 0; x < rw; x++) {
            const c = x + Rx;
            let acc = k0 * pad[c];
            for (let t = 1; t <= Rx; t++) acc += k[t] * (pad[c - t] + pad[c + t]);
            mid[o + x] = acc;
          }
        } else {
          for (let x = 0; x < rw; x++) mid[o + x] = src[rowBase + reg.x0 + x];
        }
        if (tick) tick(1);
      }

      // Y pass.
      const out = typedFor(bd, rw * rh);
      const acc = new Float64Array(rw);
      for (let oy = 0; oy < rh; oy++) {
        const ry = reg.y0 + oy;
        const c0 = (ry - ya) * rw;
        if (ky) {
          const k = ky.kernel, k0 = k[0];
          for (let x = 0; x < rw; x++) acc[x] = k0 * mid[c0 + x];
          for (let t = 1; t <= Ry; t++) {
            const a = (clamp(ry - t, 0, h - 1) - ya) * rw;
            const b = (clamp(ry + t, 0, h - 1) - ya) * rw;
            const kv = k[t];
            for (let x = 0; x < rw; x++) acc[x] += kv * (mid[a + x] + mid[b + x]);
          }
        } else {
          for (let x = 0; x < rw; x++) acc[x] = mid[c0 + x];
        }
        const oo = oy * rw;
        for (let x = 0; x < rw; x++) out[oo + x] = storeValue(bd, acc[x]);
        if (tick) tick(1);
      }
      return { width: rw, height: rh, bitDepth: bd, data: out, x0: reg.x0, y0: reg.y0 };
    }

    // Source pixels a region needs around it (for callers that hand over a crop).
    function gaussianApron(sigma, accuracy, bitDepth) {
      const acc = accuracy > 0 ? accuracy : (bitDepth === 8 ? 0.002 : 0.0002);
      return sigma > 0 ? kernelRadius(sigma, acc) - 1 : 0;
    }

    // ---- Rank filters ----------------------------------------------------

    // RankFilters.makeLineRadii: the circular kernel of squared radius r²+1.
    // Row dy (−kRadius..kRadius) spans x ∈ [−dxs[dy+kRadius], +dxs[dy+kRadius]].
    // ImageJ widens 1.5–1.75 to 1.75 and 2.5–2.85 to 2.85 to keep old sizes.
    function kernelOffsets(radius) {
      if (!(radius >= 0)) throw fail('IJ_BAD_PARAMS');
      let r = radius;
      if (r >= 1.5 && r < 1.75) r = 1.75;
      else if (r >= 2.5 && r < 2.85) r = 2.85;
      const r2 = Math.floor(r * r) + 1;
      const kRadius = Math.floor(Math.sqrt(r2 + 1e-10));
      const dxs = new Int32Array(2 * kRadius + 1);
      dxs[kRadius] = kRadius;
      let nPixels = 1 + 2 * kRadius;
      for (let y = 1; y <= kRadius; y++) {
        const dx = Math.floor(Math.sqrt(r2 - y * y + 1e-10));
        dxs[kRadius - y] = dx;
        dxs[kRadius + y] = dx;
        nPixels += 4 * dx + 2;
      }
      return { kRadius: kRadius, dxs: dxs, nPixels: nPixels };
    }

    function rankApron(radius) { return kernelOffsets(radius).kRadius; }

    // Hoare quickselect: k-th smallest of a[0..n) (reorders a).
    function selectKth(a, n, k) {
      let lo = 0, hi = n - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        const x = a[lo], y = a[mid], z = a[hi];
        const pivot = x < y ? (y < z ? y : (x < z ? z : x)) : (x < z ? x : (y < z ? z : y));
        let i = lo, j = hi;
        while (i <= j) {
          while (a[i] < pivot) i++;
          while (a[j] > pivot) j--;
          if (i <= j) { const t = a[i]; a[i] = a[j]; a[j] = t; i++; j--; }
        }
        if (k <= j) hi = j;
        else if (k >= i) lo = i;
        else return a[k];
      }
      return a[k];
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

    /* The float median of ij.plugin.filter.RankFilters (filterType MEDIAN, isFloat), the NaN rule 2 of `rank`:
     *     median = Float.isNaN(values[p]) ? Float.NaN : values[p];          // the first guess is the pixel itself
     *     median = getNaNAwareMedian(cache, x, cachePointers, above, below, kNPoints, median);
     * with getNaNAwareMedian: NaNs are not counted (kNPoints--), values above / below the guess are collected, and
     *     if (kNPoints == 0) return NaN;  half = kNPoints/2;
     *     if (nAbove>half) return findNthLowestNumber(above, nAbove, nAbove-half-1);
     *     else if (nBelow>half) return findNthLowestNumber(below, nBelow, half);  else return guess;
     * A NaN pixel keeps its NaN (every `v > NaN` / `v < NaN` is false, so both sides stay empty and the guess comes
     * back); with an even number of numbers left the answer is a lower middle, an upper middle or the pixel's own
     * value, whichever ImageJ's split gives. Without NaN the count is odd and the answer is the exact median. */
    function medianIJ(src, w, h, k, reg, out, tick) {
      const rw = reg.x1 - reg.x0, rh = reg.y1 - reg.y0;
      const above = new Float32Array(k.nPixels), below = new Float32Array(k.nPixels);
      const kR = k.kRadius, dxs = k.dxs;
      for (let oy = 0; oy < rh; oy++) {
        const y = reg.y0 + oy;
        for (let ox = 0; ox < rw; ox++) {
          const x = reg.x0 + ox;
          const guess = src[y * w + x];
          let kN = k.nPixels, nA = 0, nB = 0;
          for (let r = 0; r <= 2 * kR; r++) {
            const base = clamp(y + r - kR, 0, h - 1) * w;
            const dx = dxs[r];
            for (let xx = x - dx; xx <= x + dx; xx++) {
              const v = src[base + (xx < 0 ? 0 : (xx > w - 1 ? w - 1 : xx))];
              if (v !== v) kN--;
              else if (v > guess) above[nA++] = v;
              else if (v < guess) below[nB++] = v;
            }
          }
          let res;
          if (kN === 0) res = NaN;
          else {
            const half = kN >> 1;
            if (nA > half) res = findNth(above, nA, nA - half - 1);
            else if (nB > half) res = findNth(below, nB, half);
            else res = guess;
          }
          out[oy * rw + ox] = res;
        }
        if (tick) tick(1);
      }
    }

    // Any bit depth; the only path for 32-bit data. NaN pixels are ignored
    // (all-NaN window → NaN), the median of an even count takes the upper middle.
    // `nanRule` 2 (median only): medianIJ, ImageJ's own NaN handling; anything else is the rule every journal entry
    // recorded before it replays with. Without NaN both rules give the same value; the sign of a zero may differ
    // (medianIJ returns ImageJ's guess / partition order, this function sorts). No command passes rule 2 until the
    // engine forwards `nanRule` under a bumped op version.
    function rankGeneric(src, w, h, type, k, reg, out, tick, nanRule) {
      if (type === 'median' && nanRule === 2) return medianIJ(src, w, h, k, reg, out, tick);
      const rw = reg.x1 - reg.x0, rh = reg.y1 - reg.y0;
      const buf = new Float64Array(k.nPixels);
      const kR = k.kRadius, dxs = k.dxs;
      for (let oy = 0; oy < rh; oy++) {
        const y = reg.y0 + oy;
        for (let ox = 0; ox < rw; ox++) {
          const x = reg.x0 + ox;
          let cnt = 0;
          for (let r = 0; r <= 2 * kR; r++) {
            const base = clamp(y + r - kR, 0, h - 1) * w;
            const dx = dxs[r];
            for (let xx = x - dx; xx <= x + dx; xx++) {
              const v = src[base + (xx < 0 ? 0 : (xx > w - 1 ? w - 1 : xx))];
              if (v === v) buf[cnt++] = v;
            }
          }
          let res;
          if (cnt === 0) res = NaN;
          else if (type === 'mean') { let s = 0; for (let i = 0; i < cnt; i++) s += buf[i]; res = s / cnt; }
          else if (type === 'min') { res = buf[0]; for (let i = 1; i < cnt; i++) if (buf[i] < res) res = buf[i]; }
          else if (type === 'max') { res = buf[0]; for (let i = 1; i < cnt; i++) if (buf[i] > res) res = buf[i]; }
          else res = selectKth(buf, cnt, cnt >> 1);
          out[oy * rw + ox] = res;
        }
        if (tick) tick(1);
      }
    }

    // 8/16-bit median with a sliding two-level histogram (coarse bins of 2^shift
    // values); the window moves one pixel right by updating the two end pixels
    // of each kernel row. Exact: the n-th smallest of the replicated window.
    function medianHist(src, w, h, bits, k, reg, out, tick) {
      const rw = reg.x1 - reg.x0, rh = reg.y1 - reg.y0;
      const nb = 1 << bits, shift = bits >> 1;
      const fine = new Int32Array(nb), coarse = new Int32Array(nb >> shift);
      const kR = k.kRadius, dxs = k.dxs, rows = 2 * kR + 1;
      const target = (k.nPixels - 1) >> 1;
      const base = new Int32Array(rows);
      for (let oy = 0; oy < rh; oy++) {
        const y = reg.y0 + oy;
        fine.fill(0);
        coarse.fill(0);
        for (let r = 0; r < rows; r++) {
          base[r] = clamp(y + r - kR, 0, h - 1) * w;
          const dx = dxs[r];
          for (let xx = reg.x0 - dx; xx <= reg.x0 + dx; xx++) {
            const v = src[base[r] + (xx < 0 ? 0 : (xx > w - 1 ? w - 1 : xx))];
            fine[v]++;
            coarse[v >> shift]++;
          }
        }
        for (let ox = 0; ox < rw; ox++) {
          const x = reg.x0 + ox;
          let acc = 0, c = 0;
          while (acc + coarse[c] <= target) { acc += coarse[c]; c++; }
          let v = c << shift;
          while (acc + fine[v] <= target) { acc += fine[v]; v++; }
          out[oy * rw + ox] = v;
          if (ox + 1 < rw) {
            for (let r = 0; r < rows; r++) {
              const dx = dxs[r];
              const a = x - dx, b = x + dx + 1;
              const rem = src[base[r] + (a < 0 ? 0 : (a > w - 1 ? w - 1 : a))];
              const add = src[base[r] + (b < 0 ? 0 : (b > w - 1 ? w - 1 : b))];
              if (rem !== add) {
                fine[rem]--; coarse[rem >> shift]--;
                fine[add]++; coarse[add >> shift]++;
              }
            }
          }
        }
        if (tick) tick(1);
      }
    }

    /* 16-bit median: the same exact n-th smallest of the replicated window as medianHist, with three histogram levels
     * (32 bins of 2^11 values, 1024 bins of 2^6, the 65536 values) instead of two (256 + 256). The search for the
     * (target+1)-th element walks at most 32 + 32 + 64 bins instead of up to 256 + 256, for one more counter per update;
     * a row ends by taking its last window out again (kN decrements) instead of clearing 67 000 counters. Window
     * moves inside the image skip the edge clamps. A counter can reach the kernel size, which exceeds 65 535 from
     * radius 145 on: all counters are Int32. */
    function medianHist16(src, w, h, k, reg, out, tick) {
      const rw = reg.x1 - reg.x0, rh = reg.y1 - reg.y0;
      const fine = new Int32Array(65536), mid = new Int32Array(1024), top = new Int32Array(32);
      const kR = k.kRadius, dxs = k.dxs, rows = 2 * kR + 1;
      const target = (k.nPixels - 1) >> 1;
      const base = new Int32Array(rows);
      const wm = w - 1;
      for (let oy = 0; oy < rh; oy++) {
        const y = reg.y0 + oy;
        for (let r = 0; r < rows; r++) {
          base[r] = clamp(y + r - kR, 0, h - 1) * w;
          const dx = dxs[r];
          for (let xx = reg.x0 - dx; xx <= reg.x0 + dx; xx++) {
            const v = src[base[r] + (xx < 0 ? 0 : (xx > wm ? wm : xx))];
            fine[v]++; mid[v >> 6]++; top[v >> 11]++;
          }
        }
        for (let ox = 0; ox < rw; ox++) {
          const x = reg.x0 + ox;
          let acc = 0, c = 0;
          while (acc + top[c] <= target) { acc += top[c]; c++; }
          c <<= 5;
          while (acc + mid[c] <= target) { acc += mid[c]; c++; }
          let v = c << 6;
          while (acc + fine[v] <= target) { acc += fine[v]; v++; }
          out[oy * rw + ox] = v;
          if (ox + 1 < rw) {
            if (x >= kR && x + kR + 1 <= wm) {
              for (let r = 0; r < rows; r++) {
                const dx = dxs[r], b0 = base[r] + x;
                const rem = src[b0 - dx], add = src[b0 + dx + 1];
                if (rem !== add) {
                  fine[rem]--; mid[rem >> 6]--; top[rem >> 11]--;
                  fine[add]++; mid[add >> 6]++; top[add >> 11]++;
                }
              }
            } else {
              for (let r = 0; r < rows; r++) {
                const dx = dxs[r];
                const a = x - dx, b = x + dx + 1;
                const rem = src[base[r] + (a < 0 ? 0 : (a > wm ? wm : a))];
                const add = src[base[r] + (b < 0 ? 0 : (b > wm ? wm : b))];
                if (rem !== add) {
                  fine[rem]--; mid[rem >> 6]--; top[rem >> 11]--;
                  fine[add]++; mid[add >> 6]++; top[add >> 11]++;
                }
              }
            }
          }
        }
        // take the last window out: every counter is zero again for the next row
        const xl = reg.x0 + rw - 1;
        for (let r = 0; r < rows; r++) {
          const dx = dxs[r];
          for (let xx = xl - dx; xx <= xl + dx; xx++) {
            const v = src[base[r] + (xx < 0 ? 0 : (xx > wm ? wm : xx))];
            fine[v]--; mid[v >> 6]--; top[v >> 11]--;
          }
        }
        if (tick) tick(1);
      }
    }

    // 8/16-bit mean with a sliding integer sum (exact in doubles), rounded half up.
    function meanSliding(src, w, h, k, reg, out, tick) {
      const rw = reg.x1 - reg.x0, rh = reg.y1 - reg.y0;
      const kR = k.kRadius, dxs = k.dxs, rows = 2 * kR + 1, n = k.nPixels;
      const base = new Int32Array(rows);
      for (let oy = 0; oy < rh; oy++) {
        const y = reg.y0 + oy;
        let sum = 0;
        for (let r = 0; r < rows; r++) {
          base[r] = clamp(y + r - kR, 0, h - 1) * w;
          const dx = dxs[r];
          for (let xx = reg.x0 - dx; xx <= reg.x0 + dx; xx++) {
            sum += src[base[r] + (xx < 0 ? 0 : (xx > w - 1 ? w - 1 : xx))];
          }
        }
        for (let ox = 0; ox < rw; ox++) {
          const x = reg.x0 + ox;
          out[oy * rw + ox] = Math.floor(sum / n + 0.5);
          if (ox + 1 < rw) {
            for (let r = 0; r < rows; r++) {
              const dx = dxs[r];
              const a = x - dx, b = x + dx + 1;
              sum += src[base[r] + (b < 0 ? 0 : (b > w - 1 ? w - 1 : b))] -
                src[base[r] + (a < 0 ? 0 : (a > w - 1 ? w - 1 : a))];
            }
          }
        }
        if (tick) tick(1);
      }
    }

    // 8/16-bit minimum / maximum: per kernel row a monotonic-deque sliding
    // extreme along x, combined over the rows.
    function extremeFilter(src, w, h, isMax, k, reg, out, tick) {
      const rw = reg.x1 - reg.x0, rh = reg.y1 - reg.y0;
      const kR = k.kRadius, dxs = k.dxs, rows = 2 * kR + 1;
      const ext = new Int32Array(rw + 2 * kR);
      const dq = new Int32Array(rw + 2 * kR);
      const acc = new Int32Array(rw);
      const init = isMax ? -1 : 0x7fffffff;
      for (let oy = 0; oy < rh; oy++) {
        const y = reg.y0 + oy;
        acc.fill(init);
        for (let r = 0; r < rows; r++) {
          const base = clamp(y + r - kR, 0, h - 1) * w;
          const dx = dxs[r];
          const len = rw + 2 * dx, m = 2 * dx + 1;
          for (let i = 0; i < len; i++) {
            const xx = reg.x0 - dx + i;
            ext[i] = src[base + (xx < 0 ? 0 : (xx > w - 1 ? w - 1 : xx))];
          }
          let head = 0, tail = 0;
          for (let i = 0; i < len; i++) {
            const v = ext[i];
            if (isMax) { while (tail > head && ext[dq[tail - 1]] <= v) tail--; }
            else { while (tail > head && ext[dq[tail - 1]] >= v) tail--; }
            dq[tail++] = i;
            if (dq[head] <= i - m) head++;
            if (i >= m - 1) {
              const e = ext[dq[head]], j = i - m + 1;
              if (isMax ? e > acc[j] : e < acc[j]) acc[j] = e;
            }
          }
        }
        out.set(acc, oy * rw);
        if (tick) tick(1);
      }
    }

    // ImageJ RankFilters over the circular kernel of squared radius r²+1;
    // out-of-image pixels are the nearest edge pixels. Median/min/max return
    // values present in the window, mean is rounded half up for 8/16 bits.
    // opts: region {x0,y0,x1,y1} (computed alone; result carries x0/y0),
    // yieldEvery, nanRule (2 = ImageJ's NaN-aware float median, see medianIJ). 32-bit data takes the generic per-pixel path (NaN aware).
    function rank(ch, radius, type, opts) {
      checkChannel(ch);
      opts = opts || {};
      const t = String(type).toLowerCase();
      if (t !== 'median' && t !== 'mean' && t !== 'min' && t !== 'max') throw fail('IJ_BAD_PARAMS');
      const w = ch.width, h = ch.height, bd = ch.bitDepth, src = ch.data;
      const k = kernelOffsets(radius);
      const reg = regionOf(opts.region, w, h);
      const rw = reg.x1 - reg.x0, rh = reg.y1 - reg.y0;
      const out = typedFor(bd, rw * rh);
      const tick = makeTick(opts, rh);
      if (bd === 32) rankGeneric(src, w, h, t, k, reg, out, tick, opts.nanRule);
      else if (t === 'median') (bd === 16 ? medianHist16(src, w, h, k, reg, out, tick) : medianHist(src, w, h, bd, k, reg, out, tick));
      else if (t === 'mean') meanSliding(src, w, h, k, reg, out, tick);
      else extremeFilter(src, w, h, t === 'max', k, reg, out, tick);
      return { width: rw, height: rh, bitDepth: bd, data: out, x0: reg.x0, y0: reg.y0 };
    }

    return {
      kernelRadius: kernelRadius,
      makeKernel: makeKernel,
      gaussian: gaussian,
      gaussianApron: gaussianApron,
      kernelOffsets: kernelOffsets,
      rankApron: rankApron,
      rank: rank
    };
  })();

  root.IJThreshold = IJThreshold;
  root.IJBinary = IJBinary;
  root.IJParticles = IJParticles;
  root.IJFilters = IJFilters;
})(typeof self !== 'undefined' ? self : globalThis);
