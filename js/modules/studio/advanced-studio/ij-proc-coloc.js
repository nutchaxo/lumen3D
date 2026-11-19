/* ij-proc-coloc.js — package P7 (coloc): Analyze > Colocalization.
 *
 * Loaded on the page AND in the worker (ij-worker.js loads it in its own try/catch: a failure here
 * disables the package's command, it never takes the Advanced view down). Pure: no DOM, no engine
 * globals; the operation is registered with IJOpRegistry.define (ij-core.js, PLAN-wave2 §2.1).
 *
 *   IJColoc.analyze({ a, b, width, height, bitDepth, mask, params, hooks }) → result
 *   op 'coloc' (compute, version 1)  params = { ch1, ch2, doc2, mode, t1, t2, excludeZero, denominator,
 *                                                 spearman?, kendall?, search? ('scan' | 'bisection'), roundT2?, costes? { psf, n, seed } }
 *   (the last four are additive: absent = the behaviour of the first release; see "Coloc 2 additions" below)
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
  // One entry per pixel (w === null) is the same sum with weight 1: 1·x is exact, so the unweighted loops below add the
  // very same doubles in the very same order as the weighted ones, minus the multiplications and the branch.
  function momentsChunk1(a, b, s, e, m) {
    let sa = m.sa, sb = m.sb, saa = m.saa, sbb = m.sbb, sab = m.sab, num1 = m.num1, num2 = m.num2;
    let amin = m.amin, amax = m.amax, bmin = m.bmin, bmax = m.bmax;
    for (let i = s; i < e; i++) {
      const va = a[i], vb = b[i];
      sa += va; sb += vb; saa += va * va; sbb += vb * vb; sab += va * vb;
      if (vb > 0) num1 += va;
      if (va > 0) num2 += vb;
      if (va < amin) amin = va;
      if (va > amax) amax = va;
      if (vb < bmin) bmin = vb;
      if (vb > bmax) bmax = vb;
    }
    m.sa = sa; m.sb = sb; m.saa = saa; m.sbb = sbb; m.sab = sab; m.num1 = num1; m.num2 = num2;
    m.amin = amin; m.amax = amax; m.bmin = bmin; m.bmax = bmax;
  }

  function moments(T, hooks, ph) {
    const a = T.a, b = T.b, w = T.w, hw = w !== null, len = T.len;
    if (!hw) {
      const m = { sa: 0, sb: 0, saa: 0, sbb: 0, sab: 0, num1: 0, num2: 0, amin: Infinity, amax: -Infinity, bmin: Infinity, bmax: -Infinity };
      for (let s = 0; s < len; s += CHUNK) {
        const e = Math.min(len, s + CHUNK);
        momentsChunk1(a, b, s, e, m);
        hooks.check(); ph(e / len);
      }
      return m;
    }
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
  // Unweighted pass: the centred moments AND the plot's histogram in one sweep (the plot only needs the channel extremes,
  // known after `moments`); the two sets of accumulators are independent, so each is the sum the separate passes made.
  function centredChunk1(a, b, s, e, c, hs) {
    let Saa = c.Saa, Sbb = c.Sbb, Sab = c.Sab, pos = c.pos;
    const hist = hs.hist, ax0 = hs.ax[0], bx0 = hs.bx[0], wa = hs.wa, wb = hs.wb, top = BINS - 1, ma = c.ma, mb = c.mb;
    for (let i = s; i < e; i++) {
      const va = a[i], vb = b[i], dx = va - ma, dy = vb - mb, p = dx * dy;
      Saa += dx * dx; Sbb += dy * dy; Sab += p;
      if (p > 0) pos++;
      const qx = (va - ax0) / wa, qy = (vb - bx0) / wb;
      const xb = qx >= top ? top : (qx < 0 ? 0 : qx | 0);
      const yb = qy >= top ? top : (qy < 0 ? 0 : qy | 0);
      hist[(yb << 8) + xb]++;
    }
    c.Saa = Saa; c.Sbb = Sbb; c.Sab = Sab; c.pos = pos;
  }

  function centredFused(T, ma, mb, hs, hooks, ph) {
    const c = { Saa: 0, Sbb: 0, Sab: 0, pos: 0, ma, mb }, len = T.len;
    for (let s = 0; s < len; s += CHUNK) {
      const e = Math.min(len, s + CHUNK);
      centredChunk1(T.a, T.b, s, e, c, hs);
      hooks.check(); ph(e / len);
    }
    return c;
  }

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
  // Unweighted chunk (weight 1 is exact, same sums in the same order); r holds the accumulators between chunks.
  function regionChunk1(a, b, s, e, T1, T2, incl, ma, mb, r) {
    let nA = r.nA, sxA = r.sxA, syA = r.syA, sxxA = r.sxxA, syyA = r.syyA, sxyA = r.sxyA;
    let nB = r.nB, sxB = r.sxB, syB = r.syB, sxxB = r.sxxB, syyB = r.syyB, sxyB = r.sxyB;
    let aboveA = r.aboveA, aboveB = r.aboveB, gtA = r.gtA, gtB = r.gtB, mA = r.mA, mB = r.mB;
    let nO = r.nO, sxO = r.sxO, syO = r.syO, sxxO = r.sxxO, syyO = r.syyO, sxyO = r.sxyO;
    let nS = r.nS, sxS = r.sxS, syS = r.syS, sxxS = r.sxxS, syyS = r.syyS, sxyS = r.sxyS;
    for (let i = s; i < e; i++) {
      const va = a[i], vb = b[i];
      const gx = incl ? va >= T1 : va > T1, gy = incl ? vb >= T2 : vb > T2;
      if (gx) { gtA += va; mB += vb; }
      if (gy) { gtB += vb; mA += va; }
      const dx = va - ma, dy = vb - mb;
      if (gx || gy) { nO++; sxO += dx; syO += dy; sxxO += dx * dx; syyO += dy * dy; sxyO += dx * dy; }
      // Coloc 2's "above" set is STRICT (v > T) whatever the inclusive flag says: a pixel exactly on a threshold is below it there
      if (incl ? (va > T1 || vb > T2) : (gx || gy)) { nS++; sxS += dx; syS += dy; sxxS += dx * dx; syyS += dy * dy; sxyS += dx * dy; }
      if (gx && gy) {
        nA++; sxA += dx; syA += dy; sxxA += dx * dx; syyA += dy * dy; sxyA += dx * dy;
        aboveA += va; aboveB += vb;
      } else {
        nB++; sxB += dx; syB += dy; sxxB += dx * dx; syyB += dy * dy; sxyB += dx * dy;
      }
    }
    r.nA = nA; r.sxA = sxA; r.syA = syA; r.sxxA = sxxA; r.syyA = syyA; r.sxyA = sxyA;
    r.nB = nB; r.sxB = sxB; r.syB = syB; r.sxxB = sxxB; r.syyB = syyB; r.sxyB = sxyB;
    r.aboveA = aboveA; r.aboveB = aboveB; r.gtA = gtA; r.gtB = gtB; r.mA = mA; r.mB = mB;
    r.nO = nO; r.sxO = sxO; r.syO = syO; r.sxxO = sxxO; r.syyO = syyO; r.sxyO = sxyO;
    r.nS = nS; r.sxS = sxS; r.syS = syS; r.sxxS = sxxS; r.syyS = syyS; r.sxyS = sxyS;
  }

  function region(T, T1, T2, incl, ma, mb, hooks, ph) {
    const a = T.a, b = T.b, w = T.w, hw = w !== null, len = T.len;
    if (!hw) {
      const r = { nA: 0, sxA: 0, syA: 0, sxxA: 0, syyA: 0, sxyA: 0, nB: 0, sxB: 0, syB: 0, sxxB: 0, syyB: 0, sxyB: 0, aboveA: 0, aboveB: 0, gtA: 0, gtB: 0, mA: 0, mB: 0, nO: 0, sxO: 0, syO: 0, sxxO: 0, syyO: 0, sxyO: 0, nS: 0, sxS: 0, syS: 0, sxxS: 0, syyS: 0, sxyS: 0 };
      for (let s = 0; s < len; s += CHUNK) {
        const e = Math.min(len, s + CHUNK);
        regionChunk1(a, b, s, e, T1, T2, incl, ma, mb, r);
        hooks.check(); ph(e / len);
      }
      return {
        nA: r.nA, nB: r.nB, aboveA: r.aboveA, aboveB: r.aboveB, gtA: r.gtA, gtB: r.gtB, mA: r.mA, mB: r.mB,
        rAbove: pearson(r.nA, r.sxA, r.syA, r.sxxA, r.syyA, r.sxyA), rOr: pearson(r.nS, r.sxS, r.syS, r.sxxS, r.syyS, r.sxyS),
        rBelow: pearson(r.nB, r.sxB, r.syB, r.sxxB, r.syyB, r.sxyB)
      };
    }
    let nA = 0, sxA = 0, syA = 0, sxxA = 0, syyA = 0, sxyA = 0;
    let nB = 0, sxB = 0, syB = 0, sxxB = 0, syyB = 0, sxyB = 0;
    let aboveA = 0, aboveB = 0, gtA = 0, gtB = 0, mA = 0, mB = 0;
    let nO = 0, sxO = 0, syO = 0, sxxO = 0, syyO = 0, sxyO = 0;
    for (let s = 0; s < len; s += CHUNK) {
      const e = Math.min(len, s + CHUNK);
      for (let i = s; i < e; i++) {
        const wi = hw ? w[i] : 1, va = a[i], vb = b[i];
        const gx = incl ? va >= T1 : va > T1, gy = incl ? vb >= T2 : vb > T2;
        if (gx) { gtA += wi * va; mB += wi * vb; }
        if (gy) { gtB += wi * vb; mA += wi * va; }
        const dx = va - ma, dy = vb - mb;
        if (incl ? (va > T1 || vb > T2) : (gx || gy)) { nO += wi; sxO += wi * dx; syO += wi * dy; sxxO += wi * dx * dx; syyO += wi * dy * dy; sxyO += wi * dx * dy; }   // strict, see regionChunk1
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
      nA, nB, aboveA, aboveB, gtA, gtB, mA, mB,
      rAbove: pearson(nA, sxA, syA, sxxA, syyA, sxyA), rOr: pearson(nO, sxO, syO, sxxO, syyO, sxyO),
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
    // Integer channels (8/16-bit): the level that channel 2 allows depends on vb alone, so it is tabulated once per value
    // (65536 calls of the very `entry` formula's channel-2 half; precondition: channel 2 holds integers in [0, 65535], which
    // the engine guarantees for 8/16-bit) and the per-pixel work is a table read and a min.
    let kbTable = null;
    if (isInt) {
      kbTable = new Int32Array(65536);
      for (let vb = 0; vb < 65536; vb++) {
        let kb = Math.floor((vb - c) / m);
        if (kb > NB) kb = NB; else if (!(kb >= -1)) kb = -1;
        while (kb < NB && vb >= m * (kb + 1) + c) kb++;
        while (kb >= 0 && !(vb >= m * kb + c)) kb--;
        kbTable[vb] = kb;
      }
    }
    return { edge, entry, NB, kbTable };
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

  // ladderChunk for an integer ladder: entry = min(va, kbTable[vb]) (-1 when va < 0), the same level as lad.entry.
  function ladderChunkInt(a, b, w, s, e, acc, kbTable, ma, mb) {
    if (w === null) {
      for (let i = s; i < e; i++) {
        const va = a[i], vb = b[i], kb = kbTable[vb];
        const j = 6 * ((va < 0 ? -1 : (va < kb ? va : kb)) + 1), dx = va - ma, dy = vb - mb;
        acc[j] += 1; acc[j + 1] += dx; acc[j + 2] += dy;
        acc[j + 3] += dx * dx; acc[j + 4] += dy * dy; acc[j + 5] += dx * dy;
      }
      return;
    }
    for (let i = s; i < e; i++) {
      const va = a[i], vb = b[i], kb = kbTable[vb];
      const j = 6 * ((va < 0 ? -1 : (va < kb ? va : kb)) + 1), wi = w[i], dx = va - ma, dy = vb - mb;
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
      if (lad.kbTable !== null && only === null) ladderChunkInt(a, b, w, s, e, acc, lad.kbTable, ma, mb);
      else ladderChunk(a, b, w, s, e, acc, entry, oEntry, oK, ma, mb);
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

  // The bin is clamped on the double BEFORE the integer conversion: floor(q) > top <=> q >= top + 1 and floor(q) = top for
  // q in [top, top + 1), so `q >= top ? top : q < 0 ? 0 : q | 0` is the same bin as clamp(floor(q)) while the index stays a
  // small integer (a floor() result is a double, which sends the typed-array store down V8's slow keyed path: 8 s at 5735²).
  // A NaN q (zero bin width) is never filled by the callers: the pixel is left out of the plot, as before.
  function histChunk(A, B, w, s, e, hist, ax0, bx0, wa, wb) {
    const hw = w !== null, top = BINS - 1;
    for (let i = s; i < e; i++) {
      const qx = (A[i] - ax0) / wa, qy = (B[i] - bx0) / wb;
      const xb = qx >= top ? top : (qx < 0 ? 0 : qx | 0);
      const yb = qy >= top ? top : (qy < 0 ? 0 : qy | 0);
      hist[(yb << 8) + xb] += hw ? w[i] : 1;
    }
  }

  // The 2D histogram of the measured pixels, BINS x BINS, row 0 = the lowest channel-2 values.
  function histSetup(bitDepth, mo) {
    const amin = mo.amin, amax = mo.amax, bmin = mo.bmin, bmax = mo.bmax;
    let ax, bx;
    if (bitDepth === 8) { ax = [-0.5, 255.5]; bx = [-0.5, 255.5]; }
    else if (bitDepth === 16) { ax = [amin - 0.5, amax + 0.5]; bx = [bmin - 0.5, bmax + 0.5]; }
    else { ax = [amin, amax > amin ? amax : amin + 1]; bx = [bmin, bmax > bmin ? bmax : bmin + 1]; }
    const wa = (ax[1] - ax[0]) / BINS, wb = (bx[1] - bx[0]) / BINS;
    return { hist: new Uint32Array(BINS * BINS), ax, bx, wa, wb };
  }

  function histogram2d(T, hs, hooks, ph) {
    const hist = hs.hist, ax = hs.ax, bx = hs.bx, wa = hs.wa, wb = hs.wb;
    const A = T.a, B = T.b, w = T.w, len = T.len;
    for (let s = 0; s < len; s += CHUNK) {
      const e = Math.min(len, s + CHUNK);
      histChunk(A, B, w, s, e, hist, ax[0], bx[0], wa, wb);
      hooks.check(); ph(e / len);
    }
    return hs;
  }

  // ───────────────────────────── Coloc 2 additions: bisection, Spearman, Kendall, Costes' significance test ─────────────────────────────
  /* All of this is additive to op 'coloc' version 1 (params spearman, kendall, search, costes: absent = the previous behaviour).
   *
   * Bisection (the "Threshold regression" choice of Coloc 2): the same search target as the Costes scan (the largest T1 whose pixels below
   * the thresholds are not positively correlated, r(B) <= 0, T2 = m·T1 + c) found by halving [0, max] instead of walking down from the
   * maximum: T1 = the upper end of the last interval, which is the value a real Fiji returned on three test pairs (36 / 48, 4 / 4) where the scan gives (38 / 50, 3 / 3).
   *
   * Spearman's rank correlation (Spearman 1904): Pearson's r of the RANKS, ties given their average rank — exact, from the marginal
   * histograms of 8 / 16-bit data (a rank is a table lookup), from sorted copies of the channels for 32-bit. Its t statistic is
   * r·sqrt((n-2)/(1-r²)) with n-2 degrees of freedom.
   *
   * Kendall's tau-b (Kendall 1945): (C - D) / sqrt((n0 - n1)(n0 - n2)), n0 = n(n-1)/2, n1 / n2 the tied pairs of each channel. 8-bit data: from the
   * 256 x 256 joint histogram and its 2D cumulative sums, O(bins²). 16 / 32-bit data: Knight's O(n log n) algorithm (sort by channel 1 then
   * channel 2, count the inversions of channel 2 by merge sort; Knight 1966) — refused above 20 million measured pixels (IJ_FIJI_KENDALL_TOO_LARGE).
   *
   * Costes' significance test (Costes et al. 2004, Biophys J 86:3993): channel 2 is scrambled in blocks of the PSF width (round(psf) pixels,
   * the whole blocks of the image shuffled among themselves, the pixels inside a block kept together), Pearson's r of the measured pixels is
   * computed again, `n` times with ONE java.util.Random seeded by `seed`; P = the fraction of the randomised r below the observed r. */
  const KENDALL_MAX = 20e6;

  function averageRankTable(counts) {   // counts[v] -> the average (1-based) rank of value v
    const rk = new Float64Array(counts.length);
    let below = 0;
    for (let v = 0; v < counts.length; v++) { const c = counts[v]; if (c) { rk[v] = below + (c + 1) / 2; below += c; } }
    return rk;
  }
  function lowerBound(arr, x) { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >>> 1; if (arr[m] < x) lo = m + 1; else hi = m; } return lo; }
  function upperBound(arr, x) { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >>> 1; if (arr[m] <= x) lo = m + 1; else hi = m; } return lo; }

  function spearmanOf(T, bitDepth, hooks, reserve) {
    const len = T.len, a = T.a, b = T.b, w = T.w, n = T.total;
    let rankA, rankB;
    if (bitDepth === 32) {
      reserve(len * 8);
      const sa = Float32Array.from(a.subarray ? a.subarray(0, len) : a).sort(), sb = Float32Array.from(b.subarray ? b.subarray(0, len) : b).sort();
      rankA = (v) => { const lo = lowerBound(sa, v), hi = upperBound(sa, v); return lo + (hi - lo + 1) / 2; };
      rankB = (v) => { const lo = lowerBound(sb, v), hi = upperBound(sb, v); return lo + (hi - lo + 1) / 2; };
    } else {
      const size = bitDepth === 8 ? 256 : 65536;
      const ca = new Float64Array(size), cb = new Float64Array(size);
      for (let i = 0; i < len; i++) { const wi = w === null ? 1 : w[i]; ca[a[i]] += wi; cb[b[i]] += wi; }
      const ta = averageRankTable(ca), tb = averageRankTable(cb);
      rankA = (v) => ta[v]; rankB = (v) => tb[v];
    }
    let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
    const mean = (n + 1) / 2;   // both rank vectors have mean (n+1)/2: shift by it
    for (let i = 0; i < len; i++) {
      const wi = w === null ? 1 : w[i], x = rankA(a[i]) - mean, y = rankB(b[i]) - mean;
      sx += wi * x; sy += wi * y; sxx += wi * x * x; syy += wi * y * y; sxy += wi * x * y;
      if ((i & 0xFFFF) === 0xFFFF) hooks.check();
    }
    const vx = sxx - sx * sx / n, vy = syy - sy * sy / n, c = sxy - sx * sy / n;
    if (!(vx > 0 && vy > 0)) return NaN;
    return Math.max(-1, Math.min(1, c / Math.sqrt(vx * vy)));
  }

  function kendallOf(T, bitDepth, hooks, reserve) {
    const len = T.len, n = T.total, a = T.a, b = T.b, w = T.w;
    const n0 = n * (n - 1) / 2;
    if (bitDepth === 8) {
      // cell[x][y] = pixels with channel 1 = x and channel 2 = y; P[i][j] = pixels with x' < i and y' < j (i, j = 0..256)
      const cell = new Float64Array(256 * 256), P = new Float64Array(257 * 257), ra = new Float64Array(256), rb = new Float64Array(256);
      for (let i = 0; i < len; i++) { const wi = w === null ? 1 : w[i]; cell[a[i] * 256 + b[i]] += wi; ra[a[i]] += wi; rb[b[i]] += wi; }
      for (let x = 0; x < 256; x++) for (let y = 0; y < 256; y++) P[(x + 1) * 257 + y + 1] = cell[x * 256 + y] + P[x * 257 + y + 1] + P[(x + 1) * 257 + y] - P[x * 257 + y];
      // pixels with x1 <= x' <= x2 and y1 <= y' <= y2
      const rect = (x1, x2, y1, y2) => (x1 > x2 || y1 > y2 ? 0 : P[(x2 + 1) * 257 + y2 + 1] - P[x1 * 257 + y2 + 1] - P[(x2 + 1) * 257 + y1] + P[x1 * 257 + y1]);
      let con2 = 0, dis2 = 0;   // twice the concordant / discordant pair counts
      for (let x = 0; x < 256; x++) {
        for (let y = 0; y < 256; y++) {
          const c = cell[x * 256 + y];
          if (!c) continue;
          con2 += c * (rect(0, x - 1, 0, y - 1) + rect(x + 1, 255, y + 1, 255));
          dis2 += c * (rect(0, x - 1, y + 1, 255) + rect(x + 1, 255, 0, y - 1));
        }
      }
      return finishKendall(con2 / 2, dis2 / 2, n0, ra, rb);
    }
    if (n > KENDALL_MAX) throw fail('IJ_FIJI_KENDALL_TOO_LARGE', 'too many pixels for the exact Kendall computation');
    reserve(n * 36);
    // dense ranks of both channels (sorted unique values, binary search), no Float64 array of image size anywhere
    const dense = (v) => {
      const sorted = Float32Array.from(v.subarray ? v.subarray(0, len) : v).sort();
      let k = 0;
      for (let i = 0; i < sorted.length; i++) if (i === 0 || sorted[i] !== sorted[i - 1]) sorted[k++] = sorted[i];
      const u = sorted.subarray(0, k), r = new Uint32Array(len);
      for (let i = 0; i < len; i++) { r[i] = lowerBound(u, v[i]); if ((i & 0xFFFF) === 0xFFFF) hooks.check(); }
      return { r, k };
    };
    const A = dense(a), B = dense(b), ra = A.r, rb = B.r, na = A.k, nb = B.k;
    const tiesA = new Float64Array(na), tiesB = new Float64Array(nb);
    for (let i = 0; i < len; i++) { tiesA[ra[i]]++; tiesB[rb[i]]++; }
    // the order sorted by (channel 1, channel 2): a stable counting sort by channel 2, then by channel 1
    const sortBy = (key, kn, src) => {
      const start = new Uint32Array(kn + 1);
      for (let i = 0; i < len; i++) start[key[src ? src[i] : i] + 1]++;
      for (let i = 0; i < kn; i++) start[i + 1] += start[i];
      const dst = new Uint32Array(len);
      for (let i = 0; i < len; i++) { const j = src ? src[i] : i; dst[start[key[j]]++] = j; }
      return dst;
    };
    const order = sortBy(ra, na, sortBy(rb, nb, null));
    const seq = new Int32Array(len);
    let nJoint = 0;
    for (let i = 0; i < len; i++) seq[i] = rb[order[i]];
    // joint ties: runs of equal (ra, rb)
    for (let i = 0, j = 0; i < len; i = j) {
      j = i + 1;
      while (j < len && ra[order[j]] === ra[order[i]] && rb[order[j]] === rb[order[i]]) j++;
      const t = j - i;
      nJoint += t * (t - 1) / 2;
    }
    // inversions of seq (strict): bottom-up merge sort
    let src = seq, dst = new Int32Array(len), inv = 0, work = 0;
    for (let width = 1; width < len; width *= 2) {
      for (let lo = 0; lo < len; lo += 2 * width) {
        const mid = Math.min(lo + width, len), hi = Math.min(lo + 2 * width, len);
        if ((work += hi - lo) >= CHUNK) { work = 0; hooks.check(); }   // a pass over 16 M pixels is far longer than the cancellation budget
        let i = lo, j = mid, k = lo;
        while (i < mid && j < hi) { if (src[j] < src[i]) { inv += mid - i; dst[k++] = src[j++]; } else dst[k++] = src[i++]; }
        while (i < mid) dst[k++] = src[i++];
        while (j < hi) dst[k++] = src[j++];
      }
      const t = src; src = dst; dst = t;
      hooks.check();
    }
    let n1 = 0, n2 = 0;
    for (let i = 0; i < na; i++) n1 += tiesA[i] * (tiesA[i] - 1) / 2;
    for (let i = 0; i < nb; i++) n2 += tiesB[i] * (tiesB[i] - 1) / 2;
    // C - D = n0 - n1 - n2 + n3 - 2·inversions   (n3 = pairs tied in both channels; scipy.stats.kendalltau, variant 'b')
    const cMinusD = n0 - n1 - n2 + nJoint - 2 * inv;
    const den = Math.sqrt((n0 - n1) * (n0 - n2));
    return den > 0 ? Math.max(-1, Math.min(1, cMinusD / den)) : NaN;
  }
  function finishKendall(C, D, n0, ra, rb) {
    let n1 = 0, n2 = 0;
    for (let i = 0; i < ra.length; i++) { n1 += ra[i] * (ra[i] - 1) / 2; n2 += rb[i] * (rb[i] - 1) / 2; }
    const den = Math.sqrt((n0 - n1) * (n0 - n2));
    return den > 0 ? Math.max(-1, Math.min(1, (C - D) / den)) : NaN;
  }

  /* Costes' block randomisation: returns { p, mean, sd, ratioGE, n }. o = { a, b, width, height, bitDepth, mask }, observed = Pearson r of the measured pixels. */
  function costesRandomisation(o, observed, ma, mb, excludeZero, ct, hooks, reserve) {
    const { a, b, width, height, bitDepth } = o;
    const block = Math.max(1, Math.round(ct.psf));
    const bx = Math.floor(width / block), by = Math.floor(height / block), nBlocks = bx * by;
    const rng = new root.IJShared.JavaRandom(ct.seed);
    const Ta = bitDepth === 8 ? Uint8Array : (bitDepth === 16 ? Uint16Array : Float32Array);
    reserve(a.length * Ta.BYTES_PER_ELEMENT);
    const shuffled = new Ta(b.length);
    const box = scanBox(o.mask || null, width, height);
    const rs = [];
    const perm = new Int32Array(nBlocks);
    for (let it = 0; it < ct.n; it++) {
      for (let i = 0; i < nBlocks; i++) perm[i] = i;
      for (let i = nBlocks - 1; i > 0; i--) { const j = rng.nextInt(i + 1); const t = perm[i]; perm[i] = perm[j]; perm[j] = t; }
      shuffled.set(b);   // pixels outside the whole blocks stay where they are
      for (let k = 0; k < nBlocks; k++) {
        const dx = (k % bx) * block, dy = Math.floor(k / bx) * block, sx = (perm[k] % bx) * block, sy = Math.floor(perm[k] / bx) * block;
        for (let y = 0; y < block; y++) {
          const d = (dy + y) * width + dx, s = (sy + y) * width + sx;
          for (let x = 0; x < block; x++) shuffled[d + x] = b[s + x];
        }
        if ((k & 255) === 255) hooks.check();
      }
      // Pearson r of the measured pixels (same positions as the observed value; the zero-zero test uses the original pair)
      let n = 0, sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
      for (let y = box.y0; y < box.y1; y++) {
        const row = y * width, mrow = box.data ? (y - box.my) * box.mw - box.mx : 0;
        if (((y - box.y0) & 31) === 31) hooks.check();
        for (let x = box.x0; x < box.x1; x++) {
          if (box.data && box.data[mrow + x] === 0) continue;
          const va = a[row + x], vo = b[row + x];
          if (bitDepth === 32 && !(isFinite(va) && isFinite(vo))) continue;
          if (excludeZero && va === 0 && vo === 0) continue;
          const dx = va - ma, dy = shuffled[row + x] - mb;
          n++; sa += dx; sb += dy; saa += dx * dx; sbb += dy * dy; sab += dx * dy;
        }
      }
      const vx = saa - sa * sa / n, vy = sbb - sb * sb / n;
      rs.push(vx > 0 && vy > 0 ? Math.max(-1, Math.min(1, (sab - sa * sb / n) / Math.sqrt(vx * vy))) : NaN);
      hooks.check();
    }
    let less = 0, ge = 0, sum = 0, cnt = 0;
    for (const r of rs) { if (!(r === r)) continue; cnt++; sum += r; if (r < observed) less++; else ge++; }
    const mean = cnt ? sum / cnt : NaN;
    let ss = 0;
    for (const r of rs) if (r === r) ss += (r - mean) * (r - mean);
    return { p: cnt ? less / cnt : NaN, mean, sd: cnt > 1 ? Math.sqrt(ss / (cnt - 1)) : NaN, ratioGE: cnt ? ge / cnt : NaN, n: cnt };
  }

  // Bisection search of the thresholds (see the note above); same return shape as costesSearch.
  function bisectionSearch(T, mo, ma, mb, Sab, Saa, Sbb, isInt, hooks, ph) {
    const failed = { status: 'failed', t1: 0, t2: 0, slope: null, intercept: null };
    if (!(Sab > 0) || !(Saa > 0) || !(Sbb > 0)) return failed;
    const slope = (Sbb - Saa + Math.sqrt((Sbb - Saa) * (Sbb - Saa) + 4 * Sab * Sab)) / (2 * Sab);
    const intercept = mb - slope * ma;
    if (!isFinite(slope) || !isFinite(intercept) || !(slope > 0)) return failed;
    const lo0 = isInt ? 0 : mo.amin, hi0 = mo.amax;
    const unfound = Object.assign({}, failed, { slope, intercept });
    if (!(hi0 > lo0)) return unfound;
    const rBelow = (t1) => region(T, t1, slope * t1 + intercept, true, ma, mb, hooks, () => {}).rBelow;
    const bisect = (from, to, steps, edge) => {
      let lo = 0, hi = steps;
      while (hi - lo > 1) {
        const mid = Math.floor((lo + hi) / 2), r = rBelow(edge(mid));
        if (r > 0) hi = mid; else lo = mid;
        hooks.check();
      }
      return hi;
    };
    let t1;
    if (isInt) t1 = bisect(0, hi0, hi0, (k) => k);
    else {
      const step = (hi0 - lo0) / LADDER_32, edge1 = (k) => (k >= LADDER_32 ? hi0 : lo0 + k * step);
      const k1 = bisect(lo0, hi0, LADDER_32, edge1);
      const a2 = edge1(Math.max(0, k1 - 1)), b2 = edge1(k1), step2 = (b2 - a2) / LADDER_32;
      const k2 = bisect(a2, b2, LADDER_32, (k) => (k >= LADDER_32 ? b2 : a2 + k * step2));
      t1 = k2 >= LADDER_32 ? b2 : a2 + k2 * step2;
    }
    ph(1);
    return { status: 'ok', t1, t2: slope * t1 + intercept, slope, intercept };
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
    if (p.maskDoc !== undefined && p.maskDoc !== null && !(Number.isInteger(p.maskDoc) || (typeof p.maskDoc === 'string' && p.maskDoc))) throw bad('maskDoc');   // an open 8-bit image: its non-zero pixels are measured
    if (p.spearman !== undefined && typeof p.spearman !== 'boolean') throw bad('spearman');
    if (p.kendall !== undefined && typeof p.kendall !== 'boolean') throw bad('kendall');
    if (p.search !== undefined && p.search !== 'scan' && p.search !== 'bisection') throw bad('search');
    if (p.roundT2 !== undefined && typeof p.roundT2 !== 'boolean') throw bad('roundT2');
    if (p.costes !== undefined && p.costes !== null) {
      const c = p.costes;
      if (typeof c !== 'object' || !(c.psf > 0 && c.psf <= 1000) || !(Number.isInteger(c.n) && c.n >= 1 && c.n <= 1000) || !Number.isInteger(c.seed)) throw bad('costes');
    }
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
    const hs = histSetup(bd, mo);
    // A zero bin width (a 32-bit channel constant at |v| >= 2^53) makes every q NaN: the plot is then left empty, as the separate pass did.
    const fused = T.w === null && hs.wa > 0 && hs.wb > 0;
    const ce = fused ? centredFused(T, ma, mb, hs, hooks, prog(0.22, 0.28)) : centred(T, ma, mb, hooks, prog(0.22, 0.28));
    const negative = mo.amin < 0 || mo.bmin < 0;
    const pearsonAll = ce.Saa > 0 && ce.Sbb > 0 ? Math.max(-1, Math.min(1, ce.Sab / Math.sqrt(ce.Saa * ce.Sbb))) : NaN;
    const overlap = !negative && mo.saa > 0 && mo.sbb > 0 ? mo.sab / Math.sqrt(mo.saa * mo.sbb) : NaN;
    const icq = ce.Saa > 0 && ce.Sbb > 0 ? ce.pos / n - 0.5 : NaN;

    let t1 = 0, t2 = 0, status = null, slope = null, intercept = null;
    if (p.mode === 'manual') { t1 = p.t1; t2 = p.t2; }
    else if (p.mode === 'costes') {
      let c;
      if (p.search !== undefined && ce.Sab < 0 && ce.Saa > 0 && ce.Sbb > 0) {
        // Coloc 2 on an anti-correlated pair (measured on a real Fiji, fixture pair "independent", slope -0.45): the regression line has a negative
        // slope, every pixel below the thresholds is anti-correlated already, so the scan ends at once: channel 1's threshold is its maximum and
        // channel 2's the regression line there (Fiji printed 255 / 13; its Bisection printed 253 / 14, which this port does not reproduce).
        // Without `search` (the wave-2 call) such a pair keeps its documented `failed` status.
        const sl = (ce.Sbb - ce.Saa + Math.sqrt((ce.Sbb - ce.Saa) * (ce.Sbb - ce.Saa) + 4 * ce.Sab * ce.Sab)) / (2 * ce.Sab), ic = mb - sl * ma;
        c = isFinite(sl) && isFinite(ic) ? { status: 'ok', t1: mo.amax, t2: sl * mo.amax + ic, slope: sl, intercept: ic } : { status: 'failed', t1: 0, t2: 0, slope: null, intercept: null };
      } else c = (p.search === 'bisection' ? bisectionSearch : costesSearch)(T, mo, ma, mb, ce.Sab, ce.Saa, ce.Sbb, isInt, hooks, prog(0.28, 0.8));
      status = c.status; t1 = c.t1; t2 = c.t2; slope = c.slope; intercept = c.intercept;
      // Coloc 2 reports the channel 2 threshold of an integer image as a whole number: m·T1 + c rounded to the nearest level
      if (p.roundT2 && isInt && status === 'ok') t2 = Math.round(t2);
    }
    if (slope === null && ce.Sab > 0 && ce.Saa > 0 && ce.Sbb > 0) {
      slope = (ce.Sbb - ce.Saa + Math.sqrt((ce.Sbb - ce.Saa) * (ce.Sbb - ce.Saa) + 4 * ce.Sab * ce.Sab)) / (2 * ce.Sab);
      intercept = mb - slope * ma;
    }
    const failedSearch = status === 'failed';
    const rg = failedSearch ? null : region(T, t1, t2, p.mode !== 'none', ma, mb, hooks, prog(0.8, 0.9));
    const d1 = rg ? (p.denominator === 'above' ? rg.gtA : mo.sa) : 0;
    const d2 = rg ? (p.denominator === 'above' ? rg.gtB : mo.sb) : 0;
    const h = fused || !(hs.wa > 0 && hs.wb > 0) ? hs : histogram2d(T, hs, hooks, prog(0.9, 1));
    const result = {
      version: 1, bitDepth: bd, n, nAbove: rg ? rg.nA : null, nBelow: rg ? rg.nB : null, mode: p.mode, costes: status, denominator: p.denominator, excludeZero: !!p.excludeZero,
      negative,
      mean1: fin(ma), mean2: fin(mb), min1: fin(mo.amin), max1: fin(mo.amax), min2: fin(mo.bmin), max2: fin(mo.bmax),
      slope: fin(slope), intercept: fin(intercept), t1: failedSearch ? null : fin(t1), t2: failedSearch ? null : fin(t2),
      pearsonAll: fin(pearsonAll), pearsonAbove: rg ? fin(rg.rAbove) : null, pearsonBelow: rg ? fin(rg.rBelow) : null,
      m1: fin(!negative && mo.sa > 0 ? mo.num1 / mo.sa : NaN), m2: fin(!negative && mo.sb > 0 ? mo.num2 / mo.sb : NaN),
      tm1: fin(rg && !negative && d1 > 0 ? rg.aboveA / d1 : NaN), tm2: fin(rg && !negative && d2 > 0 ? rg.aboveB / d2 : NaN),
      // Coloc 2's own thresholded Manders coefficients (Costes 2004): tM1 = Σ ch1 where ch2 >= T2 / Σ ch1, tM2 = Σ ch2 where ch1 >= T1 / Σ ch2
      pearsonAboveOr: rg ? fin(rg.rOr) : null,   // Coloc 2's "Pearson's R value (above threshold)": the pixels above T1 OR above T2
      tm1Coloc2: fin(rg && !negative && mo.sa > 0 ? rg.mA / mo.sa : NaN), tm2Coloc2: fin(rg && !negative && mo.sb > 0 ? rg.mB / mo.sb : NaN),
      overlap: fin(overlap), icq: fin(icq), icqPositive: ce.pos,
      hist: h.hist, histBins: BINS, xRange: h.ax, yRange: h.bx
    };
    if (p.spearman) {
      const r = spearmanOf(T, bd, hooks, hooks.reserve);
      result.spearman = fin(r);
      result.spearmanDf = n - 2;
      result.spearmanT = fin(n > 2 && Math.abs(r) < 1 ? r * Math.sqrt((n - 2) / (1 - r * r)) : NaN);
    }
    if (p.kendall) result.kendall = fin(kendallOf(T, bd, hooks, hooks.reserve));
    if (p.costes) {
      const ct = costesRandomisation(o, pearsonAll, ma, mb, !!p.excludeZero, p.costes, hooks, hooks.reserve);
      result.costesP = fin(ct.p); result.costesMean = fin(ct.mean); result.costesSd = fin(ct.sd); result.costesRatioGE = fin(ct.ratioGE); result.costesN = ct.n;
    }
    return result;
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
        const hasDoc2 = p.doc2 !== undefined && p.doc2 !== null, hasMask = p.maskDoc !== undefined && p.maskDoc !== null;
        if (!hasDoc2 && p.ch1 === p.ch2) throw bad('the same channel twice');
        if (other.length !== (hasDoc2 ? 1 : 0) + (hasMask ? 1 : 0)) throw bad('the other images are not named in docIds');
        for (const d of other) if (d.width !== info.width || d.height !== info.height) throw fail('IJ_SIZE_MISMATCH', 'the images differ in size');
        // docIds lists the second image first, then the mask: each is checked by its own place, whatever else is given
        if (hasDoc2) {
          const d = other[0];
          if (d.bitDepth !== info.bitDepth) throw fail('IJ_COLOC_MIXED_DEPTH', 'the two images differ in bit depth');
          if (p.ch2 >= d.channels) throw bad('channel 2');
        }
        if (hasMask && other[hasDoc2 ? 1 : 0].bitDepth !== 8) throw fail('IJ_BAD_TYPE', 'the mask is not 8-bit');
      },

      // What exists whatever the data: the Costes ladder's accumulators (6 x 65538 doubles), the plot's histogram, the
      // integer-ladder table kbTable (65536 x 4 bytes), the 8-bit joint histogram and the selection mask the engine builds (one byte per pixel). The two lists a selection
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
        let mask = roi ? io.roiMask(roi) : null;
        if (p.maskDoc !== undefined && p.maskDoc !== null) {
          // an open 8-bit image as the mask: the pixels where it is not zero (and, with a selection, inside it)
          const mv = io.readDoc(p.maskDoc);
          if (mv.width !== v1.width || mv.height !== v1.height) throw fail('IJ_SIZE_MISMATCH', 'the mask differs in size');
          if (mv.bitDepth !== 8) throw fail('IJ_BAD_TYPE', 'the mask is not 8-bit');
          const W = v1.width, H = v1.height, md = mv.channels[0].data;
          if (io.reserve) io.reserve(W * H);
          const full = new Uint8Array(W * H);
          for (let y = 0; y < H; y++) {
            for (let x = 0; x < W; x++) {
              let inside = md[y * W + x] !== 0;
              if (inside && mask) inside = x >= mask.x && y >= mask.y && x < mask.x + mask.w && y < mask.y + mask.h && (!mask.data || mask.data[(y - mask.y) * mask.w + (x - mask.x)] !== 0);
              full[y * W + x] = inside ? 1 : 0;
            }
          }
          mask = { x: 0, y: 0, w: W, h: H, data: full };
        }
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
