/* ij-proc-coloc.js — package P7 (coloc): Analyze > Colocalization.
 *
 * Loaded on the page AND in the worker (ij-worker.js loads it in its own try/catch: a failure here
 * disables the package's command, it never takes the Advanced view down). Pure: no DOM, no engine
 * globals; the operation is registered with IJOpRegistry.define (ij-core.js, PLAN-wave2 §2.1).
 *
 *   IJColoc.analyze({ a, b, width, height, bitDepth, mask, params, hooks }) → result
 *   op 'coloc' (compute, version 1)  params = { ch1, ch2, doc2, mode, t1, t2, excludeZero, denominator }
 *
 * ── What is computed (every formula is from the papers: this is NOT a port of Fiji's Coloc 2, which is GPL) ──
 *
 * Notation. S = the pixels measured: the area selection of the first image (the whole image when there is
 * none or it is a line / point), minus the pixels where a channel is NaN / ±Infinity (32-bit), minus, when
 * `excludeZero` is ticked, the pixels where BOTH channels are exactly 0. a_i = channel 1, b_i = channel 2,
 * n = |S|. ā, b̄ = their means over S. All sums run over S.
 *   T1, T2   the thresholds: `none` → 0 and 0 (so "above" means "above zero", Manders 1993); `manual` → the
 *            two values typed; `costes` → found below.
 *   A        "above both thresholds". `manual` and `costes`: A = { a_i >= T1 and b_i >= T2 }, INCLUSIVE like
 *            ImageJ's own thresholds (ThresholdToSelection.selected: "return v>=min && v<=max;"), so the lower
 *            bound an operator reads in the Threshold window selects the pixels that window selects.
 *            `none`: A = { a_i > 0 and b_i > 0 } (STRICT: "above zero" must mean non-zero; there is no level to read).
 *   B        "below" = S \ A, the exact complement: { a_i < T1 or b_i < T2 } (inclusive modes).
 *   Pearson r (all)    = Σ(a-ā)(b-b̄) / sqrt(Σ(a-ā)² Σ(b-b̄)²)  over S      (Pearson 1896)
 *   Pearson r (above)  = the same over A;   Pearson r (below) = the same over B.
 *   M1, M2   Manders 1993: M1 = Σ_{b_i > 0} a_i / Σ a_i ,  M2 = Σ_{a_i > 0} b_i / Σ b_i. The denominator is the
 *            sum over ALL pixels of S (the "above zero" of Manders: no threshold is used).
 *   tM1, tM2 thresholded Manders (Costes 2004): tM1 = Σ_{i in A} a_i / D1 and tM2 = Σ_{i in A} b_i / D2, with
 *            the denominator the operator chooses (it is NAMED in the column header of the table):
 *              `all`   D1 = Σ_S a_i , D2 = Σ_S b_i              (Manders 1993 / Costes 2004: all ROI pixels)
 *              `above` D1 = Σ_{a_i above T1} a_i , D2 = Σ_{b_i above T2} b_i   (the denominator Coloc 2 reports)
 *   Manders' ratios and the overlap coefficient assume non-negative intensities (a sum that cancels gives a
 *   "fraction" outside [0, 1]): when a channel of S has a negative value (a background-subtracted 32-bit image)
 *   M1, M2, tM1, tM2 and the overlap are NOT reported (null) and `negative` is true.
 *   overlap  Manders' overlap coefficient  Σ a_i b_i / sqrt(Σ a_i² Σ b_i²)  over S (not centred).
 *   ICQ      Li et al. 2004: ICQ = N(PDM > 0) / N(total) - 0.5, PDM_i = (a_i-ā)(b_i-b̄), in [-0.5, +0.5]. A pixel
 *            whose PDM is 0 is neither positive nor negative but STAYS in the total. Undefined (null) when a
 *            channel is constant (every PDM is 0).
 *   Costes   automatic thresholds (Costes et al. 2004, Biophys J 86:3993): the orthogonal regression line
 *            b = m·a + c of S (Deming regression with δ = 1, i.e. the first principal axis of the
 *            covariance matrix: m = (Sbb - Saa + sqrt((Sbb-Saa)² + 4 Sab²)) / (2 Sab), c = b̄ - m ā; it is NOT
 *            invariant to a change of the intensity scale of one channel alone, which is documented, not
 *            hidden). T2 = m·T1 + c. T1 is the LARGEST level for which the pixels below the thresholds are not
 *            positively correlated: r(B) <= 0 (an undefined r — fewer than 2 pixels or no variance — also
 *            counts as uncorrelated). r(B) is not monotone in T1 on real images, so the answer is the largest
 *            level of the whole ladder, not the first crossing met by a coarse walk.
 *              8/16-bit: the ladder is every integer level 0 .. max(a): T1 is exactly what the classical scan
 *                        from the maximum down returns (the first level, from the top, where r(B) <= 0).
 *              32-bit:   the ladder is 2^16 equal steps of [min a, max a]; inside the winning step a second
 *                        ladder of 2^16 steps refines it (resolution 2^-32 of the range). T1 is the largest
 *                        level of that second ladder; the first ladder is exact at its own steps, so a
 *                        stretch between two of its steps where r(B) would dip below 0 and rise again is not seen.
 *            The sweep is linear: the set A(T1) = { a >= T1 and b >= m·T1 + c } only GROWS as T1 falls (both
 *            conditions loosen), so each pixel joins B at one level — the level `entry` below — and the sums of
 *            B at every level come from a running total over per-level accumulators: one pass over the
 *            pixels, whatever the number of levels. (B is nested, so no Fenwick tree is needed.)
 *            No positive correlation (Sab <= 0 or a constant channel) → status `failed`: T1, T2 and everything
 *            that depends on them (pixels above, Pearson above / below, tM1, tM2) are null.
 *
 * ── Exactness and memory ──
 * 8-bit data are reduced to the 256 x 256 joint histogram (a table of the distinct pairs with their counts).
 * 16- and 32-bit data are read from the channels themselves when every pixel is measured (no scratch), else
 * gathered into two compact lists (4 or 8 bytes per measured pixel, reserved through hooks.reserve once the
 * count is known). Sums are accumulated in doubles around the channel means (shifted data), in the order of
 * the table (8-bit) or of the raster (16/32-bit): independent of the selection's shape and of the band layout.
 *
 * ── ImageJ conventions kept (ij.process, 1.54p) ──
 * ROI mask: ByteStatistics.getStatistics / FloatStatistics.getStatistics
 *     "if (mask==null || mask[mi++]!=0) {"
 * non-finite pixels: FloatStatistics.getStatistics, minThreshold = -Float.MAX_VALUE, maxThreshold = Float.MAX_VALUE
 *     "if (v>=minThreshold && v<=maxThreshold) {"
 *   a NaN fails both comparisons and ±Infinity fails one: they are not measured. Same here.
 * inclusive thresholds: ij.plugin.filter.ThresholdToSelection.selected
 *     "return v>=min && v<=max;"
 * There is no ImageJ command for colocalisation (Coloc 2 is a Fiji plugin): no golden fixture exists, the
 * numbers are validated against an independent numpy reference (tests/test_ij_coloc_numpy.py) and by
 * hand-checkable vectors (tests/js/test_ij_coloc.mjs).
 */
(function (root) {
  'use strict';

  const BINS = 256;                 // the joint histogram of the plot is BINS x BINS
  const CHUNK = 1 << 16;            // elements between two cancellation checks (a few ms)
  const LADDER_32 = 1 << 16;        // steps of a 32-bit Costes ladder (twice: coarse, then refinement)
  const MODES = ['none', 'manual', 'costes'];
  const DENOMINATORS = ['all', 'above'];

  function fail(code, message) {
    const e = new Error(message || code);
    e.code = code;
    return e;
  }
  const bad = (m) => fail('IJ_BAD_ARGS', m);
  const noop = () => {};
  const fin = (v) => (typeof v === 'number' && isFinite(v) ? v : null);
  // A progress function for the slice [from, to] of the run's 0..1 bar.
  const slice = (hooks, from, to) => (f) => hooks.tick(from + (to - from) * (f > 1 ? 1 : f));

  // ───────────────────────────── the table of measured pixels ─────────────────────────────

  /* The measured pixels as { len, a, b, w, total }: w = Uint32 counts for 8-bit data (the distinct pairs,
   * `a`-major), null for 16/32-bit data (one entry per pixel, raster order, weight 1). */

  function scanBox(mask, width, height) {
    if (!mask) return { x0: 0, y0: 0, x1: width, y1: height, mw: 0, mx: 0, my: 0, data: null };
    return { x0: Math.max(0, mask.x), y0: Math.max(0, mask.y), x1: Math.min(width, mask.x + mask.w), y1: Math.min(height, mask.y + mask.h), mw: mask.w, mx: mask.x, my: mask.y, data: mask.data };
  }

  // visit(va, vb) for every pixel of the selection, row after row; check() and progress every few rows.
  function scan(a, b, width, box, hooks, ph, visit) {
    const data = box.data, rows = Math.max(1, box.y1 - box.y0);
    for (let y = box.y0; y < box.y1; y++) {
      const row = y * width;
      if (data) {
        const mrow = (y - box.my) * box.mw - box.mx;
        for (let x = box.x0; x < box.x1; x++) if (data[mrow + x] !== 0) visit(a[row + x], b[row + x]);
      } else {
        for (let x = box.x0; x < box.x1; x++) visit(a[row + x], b[row + x]);
      }
      if (((y - box.y0) & 31) === 31) { hooks.check(); ph((y - box.y0 + 1) / rows); }
    }
    ph(1);
  }

  function collect(a, b, width, height, bitDepth, mask, excludeZero, hooks, prog) {
    const box = scanBox(mask, width, height);
    if (bitDepth === 8) {
      const hist = new Uint32Array(65536);
      scan(a, b, width, box, hooks, prog(0, 0.16), (va, vb) => { if (excludeZero && va === 0 && vb === 0) return; hist[(va << 8) | vb]++; });
      let len = 0, total = 0;
      for (let i = 0; i < 65536; i++) if (hist[i] !== 0) { len++; total += hist[i]; }
      const ta = new Uint16Array(len), tb = new Uint16Array(len), tw = new Uint32Array(len);
      let k = 0;
      for (let i = 0; i < 65536; i++) {
        const c = hist[i];
        if (c === 0) continue;
        ta[k] = i >> 8; tb[k] = i & 255; tw[k] = c; k++;
      }
      return { len, a: ta, b: tb, w: tw, total };
    }
    // 16- and 32-bit: count first, then (only when something is left out) gather into compact lists.
    // 32-bit: finite pairs only (FloatStatistics: NaN and ±Infinity are not measured).
    const finiteOnly = bitDepth === 32;
    let n = 0;
    scan(a, b, width, box, hooks, prog(0, 0.08), (va, vb) => {
      if (finiteOnly && !(isFinite(va) && isFinite(vb))) return;
      if (excludeZero && va === 0 && vb === 0) return;
      n++;
    });
    if (n === width * height) return { len: n, a, b, w: null, total: n }; // every pixel is measured: the channels themselves
    hooks.reserve(n * (bitDepth === 16 ? 4 : 8));
    const Ta = bitDepth === 16 ? Uint16Array : Float32Array;
    const ga = new Ta(n), gb = new Ta(n);
    let k = 0;
    scan(a, b, width, box, hooks, prog(0.08, 0.16), (va, vb) => {
      if (finiteOnly && !(isFinite(va) && isFinite(vb))) return;
      if (excludeZero && va === 0 && vb === 0) return;
      ga[k] = va; gb[k++] = vb;
    });
    return { len: n, a: ga, b: gb, w: null, total: n };
  }

  // ───────────────────────────── the passes over the table ─────────────────────────────

  function pearson(n, sx, sy, sxx, syy, sxy) {
    if (!(n >= 2)) return NaN;
    const vx = sxx - (sx * sx) / n, vy = syy - (sy * sy) / n, c = sxy - (sx * sy) / n;
    if (!(vx > 0 && vy > 0)) return NaN;
    const r = c / Math.sqrt(vx * vy);
    return r > 1 ? 1 : (r < -1 ? -1 : r);
  }

  // Raw moments of S, the numerators of Manders' M1 / M2 and the extremes of both channels.
  function moments(T, hooks, ph) {
    const a = T.a, b = T.b, w = T.w, hw = w !== null, len = T.len;
    let sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0, num1 = 0, num2 = 0;
    let amin = Infinity, amax = -Infinity, bmin = Infinity, bmax = -Infinity;
    for (let s = 0; s < len; s += CHUNK) {
      const e = Math.min(len, s + CHUNK);
      for (let i = s; i < e; i++) {
        const wi = hw ? w[i] : 1, va = a[i], vb = b[i];
        sa += wi * va; sb += wi * vb; saa += wi * va * va; sbb += wi * vb * vb; sab += wi * va * vb;
        if (vb > 0) num1 += wi * va;
        if (va > 0) num2 += wi * vb;
        if (va < amin) amin = va;
        if (va > amax) amax = va;
        if (vb < bmin) bmin = vb;
        if (vb > bmax) bmax = vb;
      }
      hooks.check(); ph(e / len);
    }
    return { sa, sb, saa, sbb, sab, num1, num2, amin, amax, bmin, bmax };
  }

  // Centred second moments of S and the number of pixels whose product of differences is positive.
  function centred(T, ma, mb, hooks, ph) {
    const a = T.a, b = T.b, w = T.w, hw = w !== null, len = T.len;
    let Saa = 0, Sbb = 0, Sab = 0, pos = 0;
    for (let s = 0; s < len; s += CHUNK) {
      const e = Math.min(len, s + CHUNK);
      for (let i = s; i < e; i++) {
        const wi = hw ? w[i] : 1, dx = a[i] - ma, dy = b[i] - mb, p = dx * dy;
        Saa += wi * dx * dx; Sbb += wi * dy * dy; Sab += wi * p;
        if (p > 0) pos += wi;
      }
      hooks.check(); ph(e / len);
    }
    return { Saa, Sbb, Sab, pos };
  }

  // The two sets of a threshold pair, with the sums Pearson needs (shifted by the channel means of S).
  // incl: "above" means >= (manual / Costes) or > (none).
  function region(T, T1, T2, incl, ma, mb, hooks, ph) {
    const a = T.a, b = T.b, w = T.w, hw = w !== null, len = T.len;
    let nA = 0, sxA = 0, syA = 0, sxxA = 0, syyA = 0, sxyA = 0;
    let nB = 0, sxB = 0, syB = 0, sxxB = 0, syyB = 0, sxyB = 0;
    let aboveA = 0, aboveB = 0, gtA = 0, gtB = 0;
    for (let s = 0; s < len; s += CHUNK) {
      const e = Math.min(len, s + CHUNK);
      for (let i = s; i < e; i++) {
        const wi = hw ? w[i] : 1, va = a[i], vb = b[i];
        const gx = incl ? va >= T1 : va > T1, gy = incl ? vb >= T2 : vb > T2;
        if (gx) gtA += wi * va;
        if (gy) gtB += wi * vb;
        const dx = va - ma, dy = vb - mb;
        if (gx && gy) {
          nA += wi; sxA += wi * dx; syA += wi * dy; sxxA += wi * dx * dx; syyA += wi * dy * dy; sxyA += wi * dx * dy;
          aboveA += wi * va; aboveB += wi * vb;
        } else {
          nB += wi; sxB += wi * dx; syB += wi * dy; sxxB += wi * dx * dx; syyB += wi * dy * dy; sxyB += wi * dx * dy;
        }
      }
      hooks.check(); ph(e / len);
    }
    return {
      nA, nB, aboveA, aboveB, gtA, gtB,
      rAbove: pearson(nA, sxA, syA, sxxA, syyA, sxyA),
      rBelow: pearson(nB, sxB, syB, sxxB, syyB, sxyB)
    };
  }

  // ───────────────────────────── Costes ─────────────────────────────

  /* A ladder of NB + 1 levels edge(0) = lo .. edge(NB) = top (integers: lo = 0, top = NB, edge(k) = k).
   * entry(va, vb) = the largest level k in [-1, NB] at which the pixel is ABOVE both thresholds,
   *   va >= edge(k) and vb >= m·edge(k) + c  (-1: at no level). Both conditions loosen as k falls (m > 0), so a
   * pixel is above at every level <= entry and below at every level > entry: B(k) = { entry < k }.
   * The estimate (value - lo) / step is exact for the integer ladder and within a step for a float one; the
   * two while loops settle it on the very comparisons the final threshold pass makes (monotone in k). */
  function makeLadder(lo, top, NB, m, c, isInt) {
    const step = (top - lo) / NB;
    const edge = (k) => (k >= NB ? top : lo + k * step);
    // integer ladder: edge(k) = k, so the level of channel 1 is the value itself
    const entry = isInt ? (va, vb) => {
      if (va < 0) return -1;
      let kb = Math.floor((vb - c) / m);
      if (kb > NB) kb = NB; else if (!(kb >= -1)) kb = -1;
      while (kb < NB && vb >= m * (kb + 1) + c) kb++;
      while (kb >= 0 && !(vb >= m * kb + c)) kb--;
      return va < kb ? va : kb;
    } : (va, vb) => {
      let ka = Math.floor((va - lo) / step);
      if (ka > NB) ka = NB; else if (!(ka >= -1)) ka = -1;
      while (ka < NB && va >= edge(ka + 1)) ka++;
      while (ka >= 0 && !(va >= edge(ka))) ka--;
      if (ka < 0) return -1;
      let kb = Math.floor(((vb - c) / m - lo) / step);
      if (kb > NB) kb = NB; else if (!(kb >= -1)) kb = -1;
      while (kb < NB && vb >= m * edge(kb + 1) + c) kb++;
      while (kb >= 0 && !(vb >= m * edge(kb) + c)) kb--;
      return ka < kb ? ka : kb;
    };
    return { edge, entry, NB };
  }

  // The hot loop of ladderSweep, one chunk at a time (a separate function keeps V8 from leaving and re-entering an
  // on-stack-replaced loop at every chunk boundary).
  function ladderChunk(a, b, w, s, e, acc, entry, oEntry, oK, ma, mb) {
    const hw = w !== null;
    for (let i = s; i < e; i++) {
      const va = a[i], vb = b[i];
      if (oEntry !== null && oEntry(va, vb) !== oK) continue;
      const j = 6 * (entry(va, vb) + 1), wi = hw ? w[i] : 1, dx = va - ma, dy = vb - mb;
      acc[j] += wi; acc[j + 1] += wi * dx; acc[j + 2] += wi * dy;
      acc[j + 3] += wi * dx * dx; acc[j + 4] += wi * dy * dy; acc[j + 5] += wi * dx * dy;
    }
  }

  /* One pass over the pixels (those of the level `only.k` of `only.lad` when `only` is given) into per-level
   * accumulators (six doubles per level, interleaved: one cache line per pixel), then the running total over
   * the levels: B(k) = the pixels whose entry < k, i.e. bins 0..k (bin = entry + 1) on top of `base`.
   * Returns { best, snap }: best = the largest level whose B has no positive correlation (-1 if none),
   * snap = the sums of that B (the next refinement's base). */
  function ladderSweep(T, lad, ma, mb, base, only, hooks, ph) {
    const NB = lad.NB, a = T.a, b = T.b, w = T.w, len = T.len, entry = lad.entry;
    const acc = new Float64Array(6 * (NB + 2));
    const oEntry = only ? only.lad.entry : null, oK = only ? only.k : 0;
    for (let s = 0; s < len; s += CHUNK) {
      const e = Math.min(len, s + CHUNK);
      ladderChunk(a, b, w, s, e, acc, entry, oEntry, oK, ma, mb);
      hooks.check(); ph(0.9 * e / len);
    }
    let n = base[0], sx = base[1], sy = base[2], sxx = base[3], syy = base[4], sxy = base[5];
    let best = -1, snap = null;
    for (let k = 0; k <= NB; k++) {
      const j = 6 * k;
      n += acc[j]; sx += acc[j + 1]; sy += acc[j + 2]; sxx += acc[j + 3]; syy += acc[j + 4]; sxy += acc[j + 5];
      if (!(pearson(n, sx, sy, sxx, syy, sxy) > 0)) { best = k; snap = [n, sx, sy, sxx, syy, sxy]; }
      if ((k & 0x3FFF) === 0x3FFF) { hooks.check(); ph(0.9 + 0.1 * k / NB); }
    }
    ph(1);
    return { best, snap };
  }

  // Returns { status:'ok'|'failed', t1, t2, slope, intercept }.
  function costesSearch(T, mo, ma, mb, Sab, Saa, Sbb, isInt, hooks, ph) {
    const failed = { status: 'failed', t1: 0, t2: 0, slope: null, intercept: null };
    if (!(Sab > 0) || !(Saa > 0) || !(Sbb > 0)) return failed;
    const slope = (Sbb - Saa + Math.sqrt((Sbb - Saa) * (Sbb - Saa) + 4 * Sab * Sab)) / (2 * Sab);
    const intercept = mb - slope * ma;
    if (!isFinite(slope) || !isFinite(intercept) || !(slope > 0)) return failed;
    const lo = isInt ? 0 : mo.amin, hi = mo.amax;
    const unfound = Object.assign({}, failed, { slope, intercept });
    if (!(hi > lo)) return unfound;
    const zero = [0, 0, 0, 0, 0, 0];
    const NB = isInt ? hi : LADDER_32;
    const lad = makeLadder(lo, hi, NB, slope, intercept, isInt);
    const first = ladderSweep(T, lad, ma, mb, zero, null, hooks, isInt ? ph : (f) => ph(0.5 * f));
    if (first.best < 0) return unfound;
    let t1 = lad.edge(first.best);
    if (!isInt && first.best < NB) {
      const lad2 = makeLadder(lad.edge(first.best), lad.edge(first.best + 1), LADDER_32, slope, intercept, false);
      const second = ladderSweep(T, lad2, ma, mb, first.snap, { lad, k: first.best }, hooks, (f) => ph(0.5 + 0.5 * f));
      if (second.best >= 0) t1 = lad2.edge(second.best);
    }
    return { status: 'ok', t1, t2: slope * t1 + intercept, slope, intercept };
  }

  function histChunk(A, B, w, s, e, hist, ax0, bx0, wa, wb) {
    const hw = w !== null, top = BINS - 1;
    for (let i = s; i < e; i++) {
      let xb = Math.floor((A[i] - ax0) / wa), yb = Math.floor((B[i] - bx0) / wb);
      if (xb > top) xb = top; else if (xb < 0) xb = 0;
      if (yb > top) yb = top; else if (yb < 0) yb = 0;
      hist[yb * BINS + xb] += hw ? w[i] : 1;
    }
  }

  // The 2D histogram of the measured pixels, BINS x BINS, row 0 = the lowest channel-2 values.
  function histogram2d(T, bitDepth, mo, hooks, ph) {
    const amin = mo.amin, amax = mo.amax, bmin = mo.bmin, bmax = mo.bmax;
    let ax, bx;
    if (bitDepth === 8) { ax = [-0.5, 255.5]; bx = [-0.5, 255.5]; }
    else if (bitDepth === 16) { ax = [amin - 0.5, amax + 0.5]; bx = [bmin - 0.5, bmax + 0.5]; }
    else { ax = [amin, amax > amin ? amax : amin + 1]; bx = [bmin, bmax > bmin ? bmax : bmin + 1]; }
    const wa = (ax[1] - ax[0]) / BINS, wb = (bx[1] - bx[0]) / BINS;
    const hist = new Uint32Array(BINS * BINS);
    const A = T.a, B = T.b, w = T.w, len = T.len;
    for (let s = 0; s < len; s += CHUNK) {
      const e = Math.min(len, s + CHUNK);
      histChunk(A, B, w, s, e, hist, ax[0], bx[0], wa, wb);
      hooks.check(); ph(e / len);
    }
    return { hist, xRange: ax, yRange: bx };
  }

  // ───────────────────────────── analyze ─────────────────────────────

  function checkParams(p) {
    if (!p || typeof p !== 'object') throw bad('params');
    if (!Number.isInteger(p.ch1) || p.ch1 < 0 || !Number.isInteger(p.ch2) || p.ch2 < 0) throw bad('channel');
    if (MODES.indexOf(p.mode) < 0) throw bad('mode');
    if (p.mode === 'manual' && !(Number.isFinite(p.t1) && Number.isFinite(p.t2))) throw bad('thresholds');
    if (DENOMINATORS.indexOf(p.denominator) < 0) throw bad('denominator');
    if (p.excludeZero !== undefined && typeof p.excludeZero !== 'boolean') throw bad('excludeZero');
    if (p.doc2 !== undefined && p.doc2 !== null && !(Number.isInteger(p.doc2) || (typeof p.doc2 === 'string' && p.doc2))) throw bad('doc2'); // a document id
  }

  /* a, b: the two channels (same type, width·height values). mask: { x, y, w, h, data } | null.
   * params: see checkParams. hooks: { check(), tick(f), reserve(bytes) }. Returns a plain object (numbers or null, plus hist). */
  function analyze(o) {
    const hooks = Object.assign({ check: noop, tick: noop, reserve: noop }, o.hooks || {});
    const p = o.params;
    checkParams(p);
    const bd = o.bitDepth;
    if (bd !== 8 && bd !== 16 && bd !== 32) throw fail('IJ_BAD_TYPE', 'bit depth');
    const prog = (from, to) => slice(hooks, from, to);
    const T = collect(o.a, o.b, o.width, o.height, bd, o.mask || null, !!p.excludeZero, hooks, prog);
    const n = T.total;
    if (n < 2) throw fail('IJ_COLOC_NO_PIXELS', 'fewer than two pixels to measure');
    const isInt = bd !== 32;
    const mo = moments(T, hooks, prog(0.16, 0.22));
    const ma = mo.sa / n, mb = mo.sb / n;
    const ce = centred(T, ma, mb, hooks, prog(0.22, 0.28));
    const negative = mo.amin < 0 || mo.bmin < 0;
    const pearsonAll = ce.Saa > 0 && ce.Sbb > 0 ? Math.max(-1, Math.min(1, ce.Sab / Math.sqrt(ce.Saa * ce.Sbb))) : NaN;
    const overlap = !negative && mo.saa > 0 && mo.sbb > 0 ? mo.sab / Math.sqrt(mo.saa * mo.sbb) : NaN;
    const icq = ce.Saa > 0 && ce.Sbb > 0 ? ce.pos / n - 0.5 : NaN;

    let t1 = 0, t2 = 0, status = null, slope = null, intercept = null;
    if (p.mode === 'manual') { t1 = p.t1; t2 = p.t2; }
    else if (p.mode === 'costes') {
      const c = costesSearch(T, mo, ma, mb, ce.Sab, ce.Saa, ce.Sbb, isInt, hooks, prog(0.28, 0.8));
      status = c.status; t1 = c.t1; t2 = c.t2; slope = c.slope; intercept = c.intercept;
    }
    if (slope === null && ce.Sab > 0 && ce.Saa > 0 && ce.Sbb > 0) {
      slope = (ce.Sbb - ce.Saa + Math.sqrt((ce.Sbb - ce.Saa) * (ce.Sbb - ce.Saa) + 4 * ce.Sab * ce.Sab)) / (2 * ce.Sab);
      intercept = mb - slope * ma;
    }
    const failedSearch = status === 'failed';
    const rg = failedSearch ? null : region(T, t1, t2, p.mode !== 'none', ma, mb, hooks, prog(0.8, 0.9));
    const d1 = rg ? (p.denominator === 'above' ? rg.gtA : mo.sa) : 0;
    const d2 = rg ? (p.denominator === 'above' ? rg.gtB : mo.sb) : 0;
    const h = histogram2d(T, bd, mo, hooks, prog(0.9, 1));
    return {
      version: 1, bitDepth: bd, n, nAbove: rg ? rg.nA : null, nBelow: rg ? rg.nB : null, mode: p.mode, costes: status, denominator: p.denominator, excludeZero: !!p.excludeZero,
      negative,
      mean1: fin(ma), mean2: fin(mb), min1: fin(mo.amin), max1: fin(mo.amax), min2: fin(mo.bmin), max2: fin(mo.bmax),
      slope: fin(slope), intercept: fin(intercept), t1: failedSearch ? null : fin(t1), t2: failedSearch ? null : fin(t2),
      pearsonAll: fin(pearsonAll), pearsonAbove: rg ? fin(rg.rAbove) : null, pearsonBelow: rg ? fin(rg.rBelow) : null,
      m1: fin(!negative && mo.sa > 0 ? mo.num1 / mo.sa : NaN), m2: fin(!negative && mo.sb > 0 ? mo.num2 / mo.sb : NaN),
      tm1: fin(rg && !negative && d1 > 0 ? rg.aboveA / d1 : NaN), tm2: fin(rg && !negative && d2 > 0 ? rg.aboveB / d2 : NaN),
      overlap: fin(overlap), icq: fin(icq), icqPositive: ce.pos,
      hist: h.hist, histBins: BINS, xRange: h.xRange, yRange: h.yRange
    };
  }

  const IJColoc = { analyze, BINS, MODES, DENOMINATORS, LADDER_32 };
  root.IJColoc = IJColoc;

  // ───────────────────────────── the operation ─────────────────────────────

  const reg = root.IJOpRegistry;
  if (reg) {
    reg.define('coloc', {
      kind: 'compute', version: 1, bitDepths: [8, 16, 32], channels: 'one', roi: 'mask', preview: false,

      // info.docs = the shape of the other document named in docIds (the second image, when it is not the first).
      validate(p, info) {
        checkParams(p);
        const other = info && info.docs ? info.docs : [];
        if ((p.doc2 === undefined || p.doc2 === null) && p.ch1 === p.ch2) throw bad('the same channel twice');
        if (p.doc2 !== undefined && p.doc2 !== null) {
          if (other.length !== 1) throw bad('the second image is not named in docIds');
          const d = other[0];
          if (d.width !== info.width || d.height !== info.height) throw fail('IJ_SIZE_MISMATCH', 'the two images differ in size');
          if (d.bitDepth !== info.bitDepth) throw fail('IJ_COLOC_MIXED_DEPTH', 'the two images differ in bit depth');
          if (p.ch2 >= d.channels) throw bad('channel 2');
        }
      },

      // What exists whatever the data: the Costes ladder's accumulators (6 x 65538 doubles), the plot's histogram, the
      // 8-bit joint histogram and the selection mask the engine builds (one byte per pixel). The two lists a selection
      // or an excluded value needs (4 / 8 bytes per MEASURED pixel) are reserved through io.reserve once the count is known.
      scratchBytes(info) {
        const n = info.width * info.height, mask = info.roi ? n : 0, fixed = 6 << 20;
        return fixed + mask;
      },

      run(view, p, roi, io) {
        checkParams(p);
        const v1 = view;
        const same = p.doc2 === undefined || p.doc2 === null || p.doc2 === v1.id;
        if (same && p.ch1 === p.ch2) throw bad('the same channel twice');
        const v2 = same ? v1 : io.readDoc(p.doc2);
        if (v2.width !== v1.width || v2.height !== v1.height) throw fail('IJ_SIZE_MISMATCH', 'the two images differ in size');
        if (v2.bitDepth !== v1.bitDepth) throw fail('IJ_COLOC_MIXED_DEPTH', 'the two images differ in bit depth');
        if (p.ch1 >= v1.channels.length || p.ch2 >= v2.channels.length) throw bad('channel');
        const a = v1.channels[p.ch1].data, b = v2.channels[p.ch2].data;
        const mask = roi ? io.roiMask(roi) : null;
        io.tick(0, 'op.coloc');
        const res = analyze({
          a, b, width: v1.width, height: v1.height, bitDepth: v1.bitDepth, mask, params: p,
          hooks: { check: () => io.check(), tick: (f) => io.tick(f, 'op.coloc'), reserve: (bytes) => { if (io.reserve) io.reserve(bytes); } }
        });
        io.transfer(res.hist.buffer);
        return res;
      }
    });
  }
})(typeof self !== 'undefined' ? self : globalThis);
