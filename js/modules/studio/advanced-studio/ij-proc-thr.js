/* ij-proc-thr.js — package thr (wave 3): Auto Threshold, Auto Local Threshold, Binary Median.
 *
 * Loaded on the page AND in the worker (ij-worker.js loads it in its own try/catch: a failure here disables the package's
 * commands, it never takes the Advanced view down). Pure: no DOM; the operations are registered with IJOpRegistry.define.
 *
 *   autoThresholdLevel     compute  Image › Adjust › Auto Threshold: the level of a method on the histogram of the selection
 *   autoThreshold          pixel    8-bit: the binary image of a level, in place (255 = objects)
 *   autoThresholdMask      newdoc   16-bit: the 8-bit mask of a level
 *   autoThresholdTryAll    newdoc   "Try all": a montage of every method's result (one panel per method)
 *   autoLocalThreshold     pixel    Image › Adjust › Auto Local Threshold, 8-bit, in place (255 = objects)
 *   autoLocalThresholdTryAll newdoc "Try all" of the local methods
 *   binaryMedian           pixel    Process › Binary › Median: Binary.median (refuses a non-binary image, as Binary.setup does)
 *   thrIsBinary            compute  is the channel 0 / 255 only? (Binary Options offers "Do:" only then)
 *
 * References: ImageJ 1.54p (public domain) ij.process.AutoThresholder, ij.plugin.filter.Binary, ij.plugin.filter.RankFilters
 * (the circular kernel); Auto Local Threshold from the papers (Bernsen 1986, Niblack 1986, Sauvola & Pietikäinen 2000,
 * Phansalkar et al. 2011, Otsu 1979; Contrast, Mean, Median and MidGrey are the textbook rules) and checked against the
 * outputs of Fiji's plugin recorded in tests/fixtures/ij-wave3/fiji/autolocalthreshold (the plugin's code was not read).
 *
 * Determinism: every operation is a pure function of its parameters and of the pixels it reads (a pixel's apron is its true
 * reach: the kernel radius), nothing reads a clock, a random number or the display state (the Try all montage and the levels it draws are functions of the
 * params and the pixels alone).
 */
(function (root) {
  'use strict';
  const R = root.IJOpRegistry;
  if (!R) return;

  function ijError(code, message) { const e = new Error(message || code); e.code = code; return e; }
  const isNum = (v) => typeof v === 'number' && isFinite(v);
  const dep = (name) => { const m = root[name]; if (!m) throw ijError('IJ_MODULE_MISSING', 'module ' + name + ' is not loaded'); return m; };

  // ── methods ────────────────────────────────────────────────────────────────────────────────────────────────
  // Image › Adjust › Auto Threshold (Fiji): the list of the dialog, in Fiji's order (`fiji-dialogs.json`), "Try all" first.
  const FIJI_METHODS = ['Default', 'Huang', 'Huang2', 'Intermodes', 'IsoData', 'Li', 'MaxEntropy', 'Mean', 'MinError(I)', 'Minimum',
    'Moments', 'Otsu', 'Percentile', 'RenyiEntropy', 'Shanbhag', 'Triangle', 'Yen'];
  const LOCAL_METHODS = ['Bernsen', 'Contrast', 'Mean', 'Median', 'MidGrey', 'Niblack', 'Otsu', 'Phansalkar', 'Sauvola'];

  /** The level a Fiji Auto Threshold method finds on a histogram (256 bins, or the 65 536 of a 16-bit image).
   *  "Default" is the ORIGINAL ImageJ IsoData (AutoThresholder.IJDefault), not the modified one of ImageJ's own Threshold
   *  window: Fiji's recorded levels (`fiji/autothreshold`) say so on 8 and 16 bits; every other method is
   *  AutoThresholder's. A 16-bit histogram uses no "− 1" in the bilevel rule (ImageProcessor.setAutoThreshold, addOne). */
  function fijiLevel(counts, method, hist16, check) {
    const T = dep('IJThreshold');
    // `check` (throws IJ_CANCELLED) is reached from inside the O(n²) scans of a 16-bit histogram (IJThreshold.level)
    const o = { bilevelSubtractOne: !hist16, check };
    return method === 'Default' ? T.levelIJDefault(counts, o) : T.level(counts, method, o);
  }

  function checkFijiMethod(m) {
    if (FIJI_METHODS.indexOf(m) < 0) throw ijError('IJ_BAD_ARGS', 'method');
  }

  // ── Auto Threshold ─────────────────────────────────────────────────────────────────────────────────────────

  // The histogram Fiji's Auto Threshold runs on: 256 bins on 8 bits, the full 65 536 on 16 bits (trimmed by getThreshold),
  // of the selection when there is one; "Ignore black / white" empty the first / last bin (0 and 255, 0 and 65535).
  //
  // NOT checked against a recording of Fiji (no fixture has them), so they are our reading, not a measured fact:
  //  - a selection limits the histogram AND the pixels written (the 16-bit mask is zeroed outside it);
  //  - on 16 bits "Ignore black / white" empties bins 0 and 65535 of the full histogram (Fiji may instead drop the end bins of
  //    the TRIMMED histogram);
  //  - an inverting LUT is ignored: the objects follow "White objects on black background" alone (Fiji's own `call` text says
  //    "255 objects unless the LUT is inverted").
  // Known deviation, measured against fiji/autothreshold (pinned by tests/js/test_ij_thr_methods.mjs): the Li level of an 8-bit image
  // differs from Fiji's on two inputs — vessels_8bit (ours 83, Fiji 82) and blobs_8bit with "Ignore black" and "Ignore white" both
  // ticked (34 mask pixels); Li & Tam iterations with other roundings / tolerances did not give Fiji's 82 / 118 / 53. Every other
  // method and every 16-bit level (Li included) agrees.
  function histogramOf(view, c, roi, io, p) {
    const bd = view.bitDepth;
    if (bd !== 8 && bd !== 16) throw ijError('IJ_THR_32BIT', 'Auto Threshold needs an 8-bit or a 16-bit image');
    const ch = { width: view.width, height: view.height, bitDepth: bd, data: view.channels[c].data };
    const mask = roi && io ? io.roiMask(roi) : null;
    const hs = dep('IJThreshold').histogram(ch, { maskBox: mask, histogram16: bd === 16 });
    const counts = hs.counts;
    if (p.ignoreBlack) counts[0] = 0;
    if (p.ignoreWhite) counts[counts.length - 1] = 0;
    return { counts, hist16: bd === 16, top: bd === 16 ? 65535 : 255 };
  }

  // The objects of a level: "White objects on black background" = the pixels ABOVE the level (what the levels of
  // fiji/autothreshold say: setthreshold gives [level + 1, 255]); otherwise the pixels at or below it ([0, level]).
  function objectRange(level, white, top) { return white ? { lower: level + 1, upper: top } : { lower: 0, upper: level }; }

  function validateLevelParams(p) {
    if (p.method !== undefined) checkFijiMethod(p.method);
    for (const k of ['white', 'ignoreBlack', 'ignoreWhite']) if (p[k] !== undefined && typeof p[k] !== 'boolean') throw ijError('IJ_BAD_ARGS', k);
  }

  R.define('autoThresholdLevel', {
    kind: 'compute', version: 1, bitDepths: [8, 16], channels: 'one',
    validate(p) { validateLevelParams(p); if (p.method === undefined) throw ijError('IJ_BAD_ARGS', 'method'); },
    scratchBytes: (info) => (info.bitDepth === 16 ? 65536 * 8 * 4 : 4096),
    async run(view, p, roi, io) {
      const c = Number.isInteger(io.channel) ? io.channel : (view.active || 0);
      const h = histogramOf(view, c, roi, io, p);
      await io.tick(0.1, 'op.autoThreshold');
      const level = fijiLevel(h.counts, p.method, h.hist16, () => io.check());
      io.check();
      const o = objectRange(level, p.white !== false, h.top);
      return { level, lower: o.lower, upper: o.upper, bitDepth: view.bitDepth, top: h.top };
    }
  });

  function validateLevel(p, top) {
    if (!Number.isInteger(p.level) || p.level < -1 || p.level > top) throw ijError('IJ_BAD_ARGS', 'level');
    if (p.white !== undefined && typeof p.white !== 'boolean') throw ijError('IJ_BAD_ARGS', 'white');
  }

  // 8-bit, in place: 255 where the pixel is an object, 0 elsewhere.
  R.define('autoThreshold', {
    kind: 'pixel', version: 1, bitDepths: [8], channels: 'one', preview: false,
    validate(p) { validateLevel(p, 255); },
    scratchBytes: () => 0,
    prepare(view, c, p) {
      const level = p.level, white = p.white !== false;
      return {
        apron: { x: 0, y: 0 },
        fn: (src) => {
          const d = src.data, out = new Uint8Array(d.length);
          if (white) for (let i = 0; i < d.length; i++) out[i] = d[i] > level ? 255 : 0;
          else for (let i = 0; i < d.length; i++) out[i] = d[i] <= level ? 255 : 0;
          return out;
        }
      };
    }
  });

  const baseName = (name) => String(name || 'image').replace(/\.[A-Za-z0-9]+$/, '');

  // 16-bit in, 8-bit mask out (Fiji turns the image into the 8-bit mask itself; a document cannot change its depth in place
  // here, so the mask is a new document). A selection restricts the objects to its pixels.
  R.define('autoThresholdMask', {
    kind: 'newdoc', version: 1, bitDepths: [16], channels: 'one',
    validate(p) { validateLevel(p, 65535); },
    scratchBytes: (info) => info.width * info.height,
    async run(view, p, roi, io) {
      const W = view.width, H = view.height;
      const c = Number.isInteger(io.channel) ? io.channel : (view.active || 0);
      const white = p.white !== false, level = p.level;
      io.reserve(W * H);
      const d = view.channels[c].data, out = new Uint8Array(W * H);
      if (white) for (let i = 0; i < out.length; i++) out[i] = d[i] > level ? 255 : 0;
      else for (let i = 0; i < out.length; i++) out[i] = d[i] <= level ? 255 : 0;
      const mask = roi ? io.roiMask(roi) : null;
      if (mask) restrictToMask(out, W, H, mask);
      io.check();
      return [{ name: baseName(view.name) + '-mask', width: W, height: H, bitDepth: 8,
        channels: [{ name: view.channels[c].name, color: '#ffffff', data: out }] }];
    }
  });

  // Zero every pixel outside the mask box { x, y, w, h, data }.
  function restrictToMask(out, W, H, m) {
    for (let y = 0; y < H; y++) {
      const inRow = y >= m.y && y < m.y + m.h;
      for (let x = 0; x < W; x++) {
        const inside = inRow && x >= m.x && x < m.x + m.w && m.data[(y - m.y) * m.w + (x - m.x)] !== 0;
        if (!inside) out[y * W + x] = 0;
      }
    }
  }

  // ── Try all: a montage with the result of every method ────────────────────────────────────────────────────

  /** Layout of a montage of `n` panels of an image `w × h` (PLAN-wave3 §10.2: one 8-bit panel per method): ⌈√n⌉ columns, at
   *  most `maxWidth` pixels wide (the panels are scaled by `scale`, nearest neighbour), NO gap between the panels (the montage
   *  stays a 0/255 picture; the page draws the names). `cell(i)` = the top-left corner of panel i. */
  function tryAllLayout(w, h, n, maxWidth) {
    const gap = 0;
    const cols = Math.ceil(Math.sqrt(n)), rows = Math.ceil(n / cols);
    const limit = maxWidth || 4096;
    const scale = Math.min(1, limit / (cols * w));
    const pw = Math.max(1, Math.floor(w * scale)), ph = Math.max(1, Math.floor(h * scale));
    return {
      cols, rows, pw, ph, gap, scale,
      width: cols * pw, height: rows * ph,
      cell: (i) => ({ x: (i % cols) * pw, y: Math.floor(i / cols) * ph })
    };
  }

  // Panel `i` of the montage ← a w×h 0/255 (or any 8-bit) picture, sampled nearest-neighbour into the panel.
  function paintPanel(montage, L, i, pic, w, h) {
    const o = L.cell(i);
    for (let y = 0; y < L.ph; y++) {
      const sy = Math.min(h - 1, Math.floor((y + 0.5) * h / L.ph));
      const dst = (o.y + y) * L.width + o.x;
      for (let x = 0; x < L.pw; x++) montage[dst + x] = pic[sy * w + Math.min(w - 1, Math.floor((x + 0.5) * w / L.pw))];
    }
  }

  function montageBytes(info, n) {
    const L = tryAllLayout(info.width, info.height, n, 4096);
    return L.width * L.height;
  }

  // The levels Try all draws, when the command has computed them itself (to log them): one integer per method, in
  // FIJI_METHODS order. They are journaled with the parameters, so a replay draws the same montage.
  function validateLevels(levels, top) {
    if (levels === undefined) return;
    if (!Array.isArray(levels) || levels.length !== FIJI_METHODS.length) throw ijError('IJ_BAD_ARGS', 'levels');
    for (const v of levels) if (!Number.isInteger(v) || v < 0 || (top !== undefined && v > top)) throw ijError('IJ_BAD_ARGS', 'levels');
  }

  R.define('autoThresholdTryAll', {
    kind: 'newdoc', version: 1, bitDepths: [8, 16], channels: 'one',
    validate(p) { validateLevelParams(p); validateLevels(p.levels, 65535); },
    scratchBytes: (info) => montageBytes(info, FIJI_METHODS.length) + info.width * info.height * 2 + 65536 * 8,
    async run(view, p, roi, io) {
      const W = view.width, H = view.height;
      const c = Number.isInteger(io.channel) ? io.channel : (view.active || 0);
      const white = p.white !== false;
      const L = tryAllLayout(W, H, FIJI_METHODS.length, 4096);
      io.reserve(L.width * L.height + W * H);
      const montage = new Uint8Array(L.width * L.height); // the empty cells of the grid stay 0
      const d = view.channels[c].data, pic = new Uint8Array(W * H);
      let levels = p.levels;
      if (levels) validateLevels(levels, view.bitDepth === 16 ? 65535 : 255);
      else {
        const h = histogramOf(view, c, roi, io, p);
        levels = [];
        for (let m = 0; m < FIJI_METHODS.length; m++) {
          await io.tick(m / FIJI_METHODS.length, 'op.autoThreshold');
          levels.push(fijiLevel(h.counts, FIJI_METHODS[m], h.hist16, () => io.check()));
        }
      }
      for (let m = 0; m < FIJI_METHODS.length; m++) {
        const level = levels[m];
        if (white) for (let i = 0; i < pic.length; i++) pic[i] = d[i] > level ? 255 : 0;
        else for (let i = 0; i < pic.length; i++) pic[i] = d[i] <= level ? 255 : 0;
        paintPanel(montage, L, m, pic, W, H);
        io.check();
      }
      return [{ name: baseName(view.name) + '-AutoThreshold', width: L.width, height: L.height, bitDepth: 8,
        channels: [{ name: view.channels[c].name, color: '#ffffff', data: montage }] }];
    }
  });

  // ── Auto Local Threshold ───────────────────────────────────────────────────────────────────────────────────

  function validateLocal(p) {
    if (LOCAL_METHODS.indexOf(p.method) < 0) throw ijError('IJ_BAD_ARGS', 'method');
    if (!Number.isInteger(p.radius) || p.radius < 1 || p.radius > 1000) throw ijError('IJ_BAD_ARGS', 'radius');
    for (const k of ['parameter1', 'parameter2']) if (p[k] !== undefined && !isNum(p[k])) throw ijError('IJ_BAD_ARGS', k);
    if (p.white !== undefined && typeof p.white !== 'boolean') throw ijError('IJ_BAD_ARGS', 'white');
  }

  // Row-wise prefix sums of the pixels and of their squares, the rows padded by `pad` copies of their end pixels (the
  // out-of-image pixels of RankFilters are the nearest edge pixels): S[y][i] = Σ row[clamp(j)] for j < i − pad.
  function prefixRows(d, w, h, pad, wantSq) {
    const stride = w + 2 * pad + 1;
    const S = new Float64Array(h * stride), Q = wantSq ? new Float64Array(h * stride) : null;
    for (let y = 0; y < h; y++) {
      let s = 0, q = 0;
      const o = y * stride, r = y * w;
      for (let i = 0; i < w + 2 * pad; i++) {
        const v = d[r + (i < pad ? 0 : (i - pad >= w ? w - 1 : i - pad))];
        s += v; if (wantSq) q += v * v;
        S[o + i + 1] = s; if (wantSq) Q[o + i + 1] = q;
      }
    }
    return { S, Q, stride };
  }

  // Sum (and sum of squares) of the pixels of the circular kernel of radius `radius` at every pixel, as two Float64 arrays.
  // The kernel lines are those of RankFilters.makeLineRadii; every term is an integer below 2^53, so the sums are exact.
  function kernelSums(d, w, h, k, wantSq, check) {
    const pad = k.kRadius;
    const { S, Q, stride } = prefixRows(d, w, h, pad, wantSq);
    const sum = new Float64Array(w * h), sq = wantSq ? new Float64Array(w * h) : null;
    for (let y = 0; y < h; y++) {
      if (check) check();
      for (let dy = -pad; dy <= pad; dy++) {
        const yy = y + dy < 0 ? 0 : (y + dy >= h ? h - 1 : y + dy);
        const dx = k.dxs[dy + pad], o = yy * stride, lo = pad - dx, hi = pad + dx + 1;
        for (let x = 0; x < w; x++) {
          sum[y * w + x] += S[o + x + hi] - S[o + x + lo];
          if (wantSq) sq[y * w + x] += Q[o + x + hi] - Q[o + x + lo];
        }
      }
    }
    return { sum, sq };
  }

  /** Local Otsu: the Otsu level (AutoThresholder.Otsu) of the 256-bin histogram of the pixels under an ImageJ OvalRoi
   *  (x − r, y − r, 2r, 2r) around each pixel, clipped to the image (NO edge pixels repeated: the recorded outputs of
   *  Fiji's plugin agree with this on every pixel of the four test images at r = 7 and 15). The oval is IJRoi's own mask,
   *  one span per row; the histogram slides along the row: the pixels leaving and entering each span are removed and added. */
  function localOtsuLevels(d, w, h, radius, io) {
    const T = dep('IJThreshold'), IJRoi = dep('IJRoi');
    const size = 2 * radius;
    const m = IJRoi.mask({ type: 'oval', x: 0, y: 0, w: size, h: size }, size, size);
    const rowsN = m.h, a = new Int32Array(rowsN), b = new Int32Array(rowsN);
    for (let j = 0; j < rowsN; j++) {
      a[j] = -1; b[j] = -2;
      for (let i = 0; i < m.w; i++) if (m.data[j * m.w + i]) { if (a[j] < 0) a[j] = i; b[j] = i; }
    }
    const hist = new Float64Array(256), levelOf = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      hist.fill(0);
      // the span of row j lies on image row y − r + j, columns x − r + a[j] … x − r + b[j]
      for (let j = 0; j < rowsN; j++) {
        const yy = y - radius + j;
        if (yy < 0 || yy >= h || a[j] < 0) continue;
        const x0 = Math.max(0, -radius + a[j]), x1 = Math.min(w - 1, -radius + b[j]);
        for (let xx = x0; xx <= x1; xx++) hist[d[yy * w + xx]]++;
      }
      for (let x = 0; x < w; x++) {
        if (x > 0) {
          for (let j = 0; j < rowsN; j++) {
            const yy = y - radius + j;
            if (yy < 0 || yy >= h || a[j] < 0) continue;
            const out = x - 1 - radius + a[j], inn = x - radius + b[j];
            if (out >= 0 && out < w) hist[d[yy * w + out]]--;
            if (inn >= 0 && inn < w) hist[d[yy * w + inn]]++;
          }
        }
        const lv = T.level(hist, 'Otsu');
        levelOf[y * w + x] = lv < 0 ? 0 : (lv > 255 ? 255 : lv);
      }
      if (io && io.check && (y & 15) === 15) io.check();
    }
    return levelOf;
  }

  /** The 0/255 picture of one local method on an 8-bit image. `white` = objects are the pixels ABOVE the local threshold
   *  (result 255 there), else those at or below it. Parameters 1 and 2 are the plugin's; 0 selects the method's default
   *  (Bernsen: contrast threshold 15; Mean, Median, MidGrey: C = 0; Niblack: k = 0.2, C = 0; Phansalkar: k = 0.25,
   *  r = 0.5; Sauvola: k = 0.5, r = 128). */
  function localThreshold(img, method, radius, par1, par2, white, ctl, range) {
    const IJF = dep('IJFilters');
    const w = img.width, h = img.height, d = img.data;
    const k = IJF.kernelOffsets(radius);
    const n = w * h, out = new Uint8Array(n);
    // Objects are the pixels above the local threshold when `white`, else the others (the complement of "above"): the
    // recorded outputs of the plugin show that with "White objects on black background" off the threshold carries NO C
    // (Parameter 1 of Mean / Median / MidGrey, Parameter 2 of Niblack) — only the parameters that shape the statistic count.
    // UNVERIFIED beyond the cases recorded (|C| < 1: 0.3 and 0.4): the same rule for a larger C is our reading, not a measurement.
    const above = (v, t) => (white ? v > t : v <= t);
    const tick = ctl && ctl.tick ? ctl.tick : null;
    const chk = ctl && typeof ctl.check === 'function' ? ctl.check : null;
    const rankOpts = chk ? { yieldEvery: { fn: () => chk(), rows: 16 } } : undefined; // RankFilters: a cancel check every 16 rows
    switch (method) {
      case 'Mean':
      case 'Niblack':
      case 'Sauvola':
      case 'Phansalkar': {
        const wantSq = method !== 'Mean';
        const { sum, sq } = kernelSums(d, w, h, k, wantSq, chk);
        const N = k.nPixels;
        const kk = par1 !== 0 ? par1 : (method === 'Niblack' ? 0.2 : (method === 'Sauvola' ? 0.5 : 0.25));
        const rr = par2 !== 0 ? par2 : (method === 'Sauvola' ? 128 : 0.5);
        for (let i = 0; i < n; i++) {
          const mean = sum[i] / N;
          let t;
          if (method === 'Mean') t = white ? mean - par1 : mean;
          else {
            let v = (sq[i] - sum[i] * sum[i] / N) / N;
            if (v < 0) v = 0;
            const sd = Math.sqrt(v);
            if (method === 'Niblack') t = mean + kk * sd - (white ? par2 : 0);
            else if (method === 'Sauvola') t = mean * (1.0 + kk * (sd / rr - 1.0));
            else {
              // Phansalkar et al. 2011 on the image normalised to [0, 1]: T = m·(1 + p·e^(−q·m) + k·(s/r − 1)), p = 2, q = 10.
              // The recorded outputs of Fiji's plugin normalise by the image's own range ((v − min)/(max − min), whole image):
              // dividing by 255 instead disagrees on every image that does not span 0..255.
              // KNOWN DEVIATION (measured, fiji/autolocalthreshold): default Parameters 0/0 — 9 / 14 pixels of bigblobs at r15 / r7,
              // 5 / 6 of vessels, 1 of fibres at r7, 0 of blobs — and the recorded k = 0.3, r = 0.4 case with white objects off
              // (5 of bigblobs, 3 of vessels). The pixels lie inside the image (e.g. (39,32) of bigblobs) and their value is within
              // 0.4 grey levels of our threshold.
              // Tried without closing the gap: float32 normalisation / mean / variance, byte-rounded mean or variance, other
              // ranges (255, 256, max, range + 1), other p, q, comparing in the normalised domain, `>=`.
              const lo = range ? range.min : 0, sc = range && range.max > range.min ? range.max - range.min : 255;
              const m = (mean - lo) / sc, s = sd / sc;
              t = lo + sc * (m * (1.0 + 2.0 * Math.exp(-10.0 * m) + kk * (s / rr - 1.0)));
            }
          }
          out[i] = above(d[i], t) ? 255 : 0;
        }
        break;
      }
      case 'Median': {
        const med = IJF.rank(img, radius, 'median', rankOpts).data;
        for (let i = 0; i < n; i++) out[i] = above(d[i], white ? med[i] - par1 : med[i]) ? 255 : 0;
        break;
      }
      case 'Bernsen':
      case 'Contrast':
      case 'MidGrey': {
        const mn = IJF.rank(img, radius, 'min', rankOpts).data, mx = IJF.rank(img, radius, 'max', rankOpts).data;
        const c0 = par1 !== 0 ? par1 : 15;
        for (let i = 0; i < n; i++) {
          const v = d[i];
          let obj;
          if (method === 'Bernsen') {
            // the mid-range is an INTEGER ((max + min) / 2 in int arithmetic): `v >= mid` is the object rule
            const mid = (mn[i] + mx[i]) >> 1;
            const contrast = mx[i] - mn[i];
            obj = contrast < c0 ? (mid >= 128) === white : (v >= mid) === white;
          } else if (method === 'Contrast') obj = white ? (v - mn[i]) >= (mx[i] - v) : (v - mn[i]) < (mx[i] - v);
          else obj = above(v, white ? (mn[i] + mx[i]) / 2.0 - par1 : (mn[i] + mx[i]) / 2.0);
          out[i] = obj ? 255 : 0;
        }
        break;
      }
      case 'Otsu': {
        const lv = localOtsuLevels(d, w, h, radius, ctl);
        for (let i = 0; i < n; i++) out[i] = above(d[i], lv[i]) ? 255 : 0;
        break;
      }
      default: throw ijError('IJ_BAD_ARGS', 'method');
    }
    if (tick) tick(1);
    return out;
  }

  // Phansalkar normalises by the range of the WHOLE channel, which a band's crop cannot know: `resolve` copies it into the
  // params when the request is accepted (so the journal replays the same numbers), `prepare` falls back to ctx.range.
  function rangeOf(p, ctx, c) {
    if (isNum(p.dataMin) && isNum(p.dataMax)) return { min: p.dataMin, max: p.dataMax };
    const r = ctx && ctx.range ? ctx.range(c) : null;
    return r ? { min: r.min, max: r.max } : null;
  }

  R.define('autoLocalThreshold', {
    kind: 'pixel', version: 1, bitDepths: [8], channels: 'one', preview: 'region',
    validate(p) { validateLocal(p); for (const k of ['dataMin', 'dataMax']) if (p[k] !== undefined && !isNum(p[k])) throw ijError('IJ_BAD_ARGS', k); },
    resolve(view, p, chans) {
      if (isNum(p.dataMin) && isNum(p.dataMax)) return p;
      const d = view.channels[chans && chans.length ? chans[0] : (view.active || 0)].data;
      let mn = 255, mx = 0;
      for (let i = 0; i < d.length; i++) { const v = d[i]; if (v < mn) mn = v; if (v > mx) mx = v; }
      return Object.assign({}, p, { dataMin: mn, dataMax: mx });
    },
    scratchBytes: (info, p) => {
      const rad = dep('IJFilters').rankApron(p && p.radius ? p.radius : 15);
      const stride = info.width + 2 * rad + 1;
      return info.height * stride * 16 + info.width * info.height * 28 + 65536;
    },
    prepare(view, c, p, ctx) {
      const IJF = dep('IJFilters');
      const apron = IJF.rankApron(p.radius);
      return {
        apron: { x: apron, y: apron },
        fn: (src) => localThreshold(src, p.method, p.radius, p.parameter1 || 0, p.parameter2 || 0, p.white !== false, { check: ctx.check }, rangeOf(p, ctx, c))
      };
    }
  });

  // Rows of one band of the Try all of the local methods: the picture is computed band by band (the kernel's reach = the apron
  // above and below, as the pixel operation does), so no image-sized Float64Array exists (rule 4).
  const BAND_PIXELS = 1 << 17;
  const bandRowsOf = (w) => Math.max(16, Math.floor(BAND_PIXELS / Math.max(1, w)));

  R.define('autoLocalThresholdTryAll', {
    kind: 'newdoc', version: 1, bitDepths: [8], channels: 'one',
    validate(p) {
      if (!Number.isInteger(p.radius) || p.radius < 1 || p.radius > 1000) throw ijError('IJ_BAD_ARGS', 'radius');
      for (const k of ['parameter1', 'parameter2']) if (p[k] !== undefined && !isNum(p[k])) throw ijError('IJ_BAD_ARGS', k);
      if (p.white !== undefined && typeof p.white !== 'boolean') throw ijError('IJ_BAD_ARGS', 'white');
    },
    scratchBytes: (info, p) => {
      const rad = dep('IJFilters').rankApron(p && p.radius ? p.radius : 15);
      const rows = Math.min(info.height, bandRowsOf(info.width) + 2 * rad);
      return montageBytes(info, LOCAL_METHODS.length) + info.width * info.height * 2 + rows * (info.width + 2 * rad + 1) * 16 + rows * info.width * 28 + 65536;
    },
    async run(view, p, roi, io) {
      const IJF = dep('IJFilters');
      const W = view.width, H = view.height;
      const c = Number.isInteger(io.channel) ? io.channel : (view.active || 0);
      const L = tryAllLayout(W, H, LOCAL_METHODS.length, 4096);
      const apron = IJF.rankApron(p.radius), rows = bandRowsOf(W);
      io.reserve(L.width * L.height + W * H * 2 + Math.min(H, rows + 2 * apron) * W * 28);
      const montage = new Uint8Array(L.width * L.height);
      const d = view.channels[c].data, pic = new Uint8Array(W * H);
      let mn = 255, mx = 0;
      for (let i = 0; i < d.length; i++) { const v = d[i]; if (v < mn) mn = v; if (v > mx) mx = v; }
      const range = { min: mn, max: mx };
      const ctl = { check: () => io.check() };
      for (let m = 0; m < LOCAL_METHODS.length; m++) {
        for (let y0 = 0; y0 < H; y0 += rows) {
          await io.tick((m + y0 / H) / LOCAL_METHODS.length, 'op.autoLocalThreshold');
          const y1 = Math.min(H, y0 + rows), c0 = Math.max(0, y0 - apron), c1 = Math.min(H, y1 + apron);
          const crop = { width: W, height: c1 - c0, bitDepth: 8, data: d.subarray(c0 * W, c1 * W) };
          const band = localThreshold(crop, LOCAL_METHODS[m], p.radius, p.parameter1 || 0, p.parameter2 || 0, p.white !== false, ctl, range);
          pic.set(band.subarray((y0 - c0) * W, (y1 - c0) * W), y0 * W);
        }
        paintPanel(montage, L, m, pic, W, H);
        io.check();
      }
      return [{ name: baseName(view.name) + '-AutoLocalThreshold', width: L.width, height: L.height, bitDepth: 8,
        channels: [{ name: view.channels[c].name, color: '#ffffff', data: montage }] }];
    }
  });

  // ── Binary image test (ImageProcessor.isBinary: only the values 0 and 255) ─────────────────────────────────

  function isBinaryData(d) {
    for (let i = 0; i < d.length; i++) { const v = d[i]; if (v !== 0 && v !== 255) return false; }
    return true;
  }

  // Binary Options offers "Do:" only on such an image (Binary.setup returns NO_IMAGE_REQUIRED for any other: no Do:, no Preview).
  R.define('thrIsBinary', {
    kind: 'compute', version: 1, bitDepths: [8], channels: 'one', roi: 'ignore', preview: false,
    scratchBytes: () => 4096,
    async run(view, p, roi, io) {
      const c = Number.isInteger(io.channel) ? io.channel : (view.active || 0);
      return { binary: isBinaryData(view.channels[c].data) };
    }
  });

  // ── Binary Median ──────────────────────────────────────────────────────────────────────────────────────────
  // Binary.median (Binary.java:169-173):
  //     ip.resetThreshold();
  //     new RankFilters().rank(ip, medianRadius, RankFilters.MEAN);
  //     ip.threshold(128,255);
  // It is NOT a median: the MEAN of the circular kernel, then "pixels less than 128 or greater than 255 → 0, the others 255".
  R.define('binaryMedian', {
    kind: 'pixel', version: 1, bitDepths: [8], channels: 'each', preview: 'reduced',
    validate(p) { if (!isNum(p.radius) || p.radius < 0 || p.radius > 1000) throw ijError('IJ_BAD_ARGS', 'radius'); },
    scratchBytes: (info) => info.width * info.height * 2,
    prepare(view, c, p, ctx) {
      const IJF = dep('IJFilters');
      // Binary.setup (Binary.java:82-84): "if (!((ByteProcessor)imp.getProcessor()).isBinary()) { IJ.error("8-bit binary (0 and 255
      // only) image required."); return DONE; }" — every argument but "options", the median included.
      if (!isBinaryData(view.channels[c].data)) throw ijError('IJ_THR_NOT_BINARY', '8-bit binary (0 and 255 only) image required.');
      const s = (ctx && ctx.scale) || 1;
      const radius = p.radius / s;
      return {
        apron: { x: IJF.rankApron(radius), y: IJF.rankApron(radius) },
        fn: (src) => {
          const m = IJF.rank(src, radius, 'mean').data, out = new Uint8Array(m.length);
          for (let i = 0; i < m.length; i++) out[i] = m[i] < 128 ? 0 : 255;
          return out;
        }
      };
    }
  });

  root.IJThr = { isBinaryData, FIJI_METHODS, LOCAL_METHODS, fijiLevel, tryAllLayout, localThreshold, objectRange };
})(typeof self !== 'undefined' ? self : globalThis);
