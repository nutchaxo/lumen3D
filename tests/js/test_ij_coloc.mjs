// Analyze > Colocalization (package P7): the pure statistics of ij-proc-coloc.js and the registry op.
//
// There is no ImageJ command for colocalisation (Coloc 2 is a Fiji plugin, GPL, never copied) and so no golden
// fixture: the statistics are checked against (1) hand-computable vectors, (2) a naive pixel-by-pixel reference
// written here (a different algorithm from the module's pair-table passes), (3) the independence of the result
// from the storage path (8-bit histogram, 16-bit dense, 16-bit sparse, 32-bit pixel list) and (4) in
// tests/test_ij_coloc_numpy.py an independent numpy implementation (eigenvector regression, np.corrcoef).
//
// Run: node tests/js/test_ij_coloc.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT } from './harness.mjs';

const DIR = path.join(ROOT, 'js', 'modules', 'studio', 'advanced-studio');
const ctx = vm.createContext({ console, setTimeout, clearTimeout });
for (const f of ['ij-core.js', 'ij-proc-coloc.js']) vm.runInContext(readFileSync(path.join(DIR, f), 'utf8'), ctx, { filename: f });
const IJColoc = vm.runInContext('IJColoc', ctx);
const reg = vm.runInContext('IJOpRegistry', ctx);
assert.ok(IJColoc && reg.get('coloc'), 'the module and its op are registered');

const P = (o) => Object.assign({ ch1: 0, ch2: 1, doc2: null, mode: 'none', t1: 0, t2: 0, excludeZero: false, denominator: 'all' }, o);
const near = (x, y, tol, msg) => {
  if (y === null) return assert.equal(x, null, msg);
  assert.ok(x !== null && Math.abs(x - y) <= tol * Math.max(1, Math.abs(y)), `${msg}: ${x} vs ${y}`);
};
const TYPES = { 8: Uint8Array, 16: Uint16Array, 32: Float32Array };
function analyze(av, bv, params, o = {}) {
  const bd = o.bitDepth || 8, T = TYPES[bd];
  const W = o.W || av.length, H = o.H || 1;
  return IJColoc.analyze({ a: T.from(av), b: T.from(bv), width: W, height: H, bitDepth: bd, mask: o.mask || null, params: P(params), hooks: o.hooks, denseLimit: o.denseLimit });
}
const plain = (r) => { const { hist, ...rest } = r; return JSON.parse(JSON.stringify(rest)); };

// ── 1. hand-checkable vectors ──
{
  const r = analyze([1, 2, 3, 4], [2, 4, 6, 8]);
  assert.equal(r.n, 4);
  assert.equal(r.pearsonAll, 1);
  assert.equal(r.overlap, 1, 'Σab = 60, Σa² = 30, Σb² = 120');
  assert.equal(r.m1, 1); assert.equal(r.m2, 1);
  assert.equal(r.icq, 0.5, 'every product of differences is positive');
  assert.equal(r.costes, null);
  assert.equal(r.nAbove, 4);
  const r2 = analyze([1, 2, 3, 4], [8, 6, 4, 2]);
  assert.equal(r2.pearsonAll, -1);
  assert.equal(r2.icq, -0.5);
  near(r2.overlap, 40 / 60, 1e-15, 'Σab = 40');
}
{
  // a = 0 0 5 5, b = 0 5 0 5: uncorrelated, half of each channel overlaps the other
  const r = analyze([0, 0, 5, 5], [0, 5, 0, 5]);
  assert.equal(r.pearsonAll, 0);
  assert.equal(r.m1, 0.5); assert.equal(r.m2, 0.5);
  assert.equal(r.overlap, 0.5);
  assert.equal(r.icq, 0, 'two positive, two negative products');
  assert.equal(r.nAbove, 1, 'above zero on both: the last pixel');
  assert.equal(r.pearsonAbove, null, 'one pixel: undefined');
  assert.equal(r.tm1, 0.5); assert.equal(r.tm2, 0.5);
  assert.equal(r.nBelow, 3);
  near(r.pearsonBelow, -0.5, 1e-15, 'r of (0,0) (0,5) (5,0), worked out by hand');
  assert.equal(r.slope, null, 'no positive correlation: no orthogonal slope');
}
{
  // Li 2004: ICQ = N(PDM > 0) / N(total) - 0.5. A zero product is neither positive nor negative but STAYS in the total.
  // a = 2 4 6 (mean 4), b = 1 1 3 (mean 5/3): PDM = (-2)(-2/3) > 0, (0)(...) = 0, (2)(4/3) > 0 → 2/3 - 0.5
  const r = analyze([2, 4, 6], [1, 1, 3]);
  assert.equal(r.icqPositive, 2);
  near(r.icq, 2 / 3 - 0.5, 1e-15, 'ICQ keeps the zero-product pixel in the total (regression: it used to be dropped, giving 0.5)');
  // a constant channel: every PDM is 0, ICQ is undefined, not -0.5
  assert.equal(analyze([3, 3, 3], [1, 2, 3]).icq, null);
}
{
  // exclude zero-zero pixels
  const a = [0, 0, 0, 5, 5], b = [0, 0, 5, 0, 5];
  assert.equal(analyze(a, b).n, 5);
  const r = analyze(a, b, { excludeZero: true });
  assert.equal(r.n, 3);
  near(r.pearsonAll, -0.5, 1e-15, 'the (0,0) pixels no longer weigh in');
  assert.throws(() => analyze([0, 0], [0, 0], { excludeZero: true }), (e) => e.code === 'IJ_COLOC_NO_PIXELS');
  assert.throws(() => analyze([3], [4]), (e) => e.code === 'IJ_COLOC_NO_PIXELS', 'one pixel is not enough');
}
{
  // manual thresholds, INCLUSIVE ">=" like ImageJ's Threshold window (a pixel ON the threshold is above), both denominators
  const a = [10, 20, 30, 40], b = [5, 15, 25, 35];
  const r = analyze(a, b, { mode: 'manual', t1: 15, t2: 10 });
  assert.equal(r.nAbove, 3); assert.equal(r.nBelow, 1);
  assert.equal(r.pearsonAbove, 1);
  assert.equal(r.pearsonBelow, null, 'a single pixel');
  near(r.tm1, 90 / 100, 1e-15, 'Σ a above both / Σ a over the selection'); near(r.tm2, 75 / 80, 1e-15, 'tM2, all');
  const ra = analyze(a, b, { mode: 'manual', t1: 15, t2: 10, denominator: 'above' });
  near(ra.tm1, 1, 1e-15, 'Σ a above both / Σ a above T1'); near(ra.tm2, 1, 1e-15, 'tM2, above');
  const edge = analyze(a, b, { mode: 'manual', t1: 20, t2: 15 });
  assert.equal(edge.nAbove, 3, 'a = 20 and b = 15 are ON the thresholds: above (inclusive, regression: strict dropped them)');
  assert.equal(edge.nBelow, 1);
  assert.equal(edge.t1, 20); assert.equal(edge.t2, 15);
  const edge2 = analyze(a, b, { mode: 'manual', t1: 20.5, t2: 15 });
  assert.equal(edge2.nAbove, 2);
  // `none` stays strict: above ZERO means non-zero
  assert.equal(analyze([0, 1, 2], [5, 0, 3]).nAbove, 1);
  // tM with the 'above' denominator: the pixel on the threshold counts in D1 as well
  const ea = analyze(a, b, { mode: 'manual', t1: 20, t2: 15, denominator: 'above' });
  near(ea.tm1, 1, 1e-15, 'D1 = Σ a over a >= 20 = 90, numerator = 90');
}

// ── 2. a naive reference on random data ──
function lcg(seed) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; }
function naive(a, b, inS, T1, T2, incl = true) {
  // returns the statistics of the module computed pixel by pixel with plain two-pass formulas
  const idx = []; for (let i = 0; i < a.length; i++) if (inS(i)) idx.push(i);
  const n = idx.length;
  let sa = 0, sb = 0; for (const i of idx) { sa += a[i]; sb += b[i]; }
  const ma = sa / n, mb = sb / n;
  const corr = (sel) => {
    if (sel.length < 2) return null;
    let xa = 0, xb = 0; for (const i of sel) { xa += a[i]; xb += b[i]; }
    xa /= sel.length; xb /= sel.length;
    let saa = 0, sbb = 0, sab = 0; for (const i of sel) { saa += (a[i] - xa) ** 2; sbb += (b[i] - xb) ** 2; sab += (a[i] - xa) * (b[i] - xb); }
    return saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : null;
  };
  const gt = (v, t) => (incl ? v >= t : v > t);
  const above = idx.filter((i) => gt(a[i], T1) && gt(b[i], T2)), below = idx.filter((i) => !(gt(a[i], T1) && gt(b[i], T2)));
  let num1 = 0, num2 = 0, saa = 0, sbb = 0, sab = 0, pos = 0, nz = 0, aA = 0, aB = 0, gA = 0, gB = 0;
  for (const i of idx) {
    if (b[i] > 0) num1 += a[i];
    if (a[i] > 0) num2 += b[i];
    saa += a[i] * a[i]; sbb += b[i] * b[i]; sab += a[i] * b[i];
    const p = (a[i] - ma) * (b[i] - mb); if (p > 0) pos++;
    if (gt(a[i], T1)) gA += a[i];
    if (gt(b[i], T2)) gB += b[i];
  }
  for (const i of above) { aA += a[i]; aB += b[i]; }
  return { n, nAbove: above.length, nBelow: below.length, pearsonAll: corr(idx), pearsonAbove: corr(above), pearsonBelow: corr(below),
    m1: num1 / sa, m2: num2 / sb, overlap: sab / Math.sqrt(saa * sbb), icq: pos / n - 0.5, tmAll1: aA / sa, tmAll2: aB / sb, tmAb1: aA / gA, tmAb2: aB / gB };
}
function makeData(seed, N, bd, kind) {
  const rnd = lcg(seed), a = new Array(N), b = new Array(N);
  const top = bd === 8 ? 255 : 4095;
  for (let i = 0; i < N; i++) {
    const sig = rnd() < 0.3;
    const base = Math.floor(rnd() * top * 0.25);
    if (sig) { const s = Math.floor((0.3 + 0.7 * rnd()) * top); a[i] = Math.min(top, s + Math.floor(rnd() * top * 0.05)); b[i] = Math.min(top, Math.floor(s * 0.8) + Math.floor(rnd() * top * 0.05)); }
    else { a[i] = base; b[i] = Math.floor(rnd() * top * 0.25); }
    if (rnd() < 0.1) { a[i] = 0; b[i] = 0; }
  }
  return { a, b };
}
for (const bd of [8, 16]) {
  const N = 3000;
  const { a, b } = makeData(7 + bd, N, bd);
  const r = analyze(a, b, { mode: 'manual', t1: bd === 8 ? 70 : 1000, t2: bd === 8 ? 50 : 700 }, { bitDepth: bd, W: 60, H: 50 });
  const want = naive(a, b, () => true, bd === 8 ? 70 : 1000, bd === 8 ? 50 : 700);
  assert.equal(r.n, want.n); assert.equal(r.nAbove, want.nAbove); assert.equal(r.nBelow, want.nBelow);
  for (const k of ['pearsonAll', 'pearsonAbove', 'pearsonBelow', 'm1', 'm2', 'overlap', 'icq']) near(r[k], want[k], 1e-12, `${bd}-bit ${k}`);
  near(r.tm1, want.tmAll1, 1e-12, 'tM1 all'); near(r.tm2, want.tmAll2, 1e-12, 'tM2 all');
  const ra = analyze(a, b, { mode: 'manual', t1: bd === 8 ? 70 : 1000, t2: bd === 8 ? 50 : 700, denominator: 'above' }, { bitDepth: bd, W: 60, H: 50 });
  near(ra.tm1, want.tmAb1, 1e-12, 'tM1 above'); near(ra.tm2, want.tmAb2, 1e-12, 'tM2 above');
}

// ── 3. the storage path does not change the numbers ──
{
  // 16-bit: the channels read in place (every pixel measured) = the same pixels gathered through a selection
  const { a, b } = makeData(11, 4096, 16);
  const base = analyze(a, b, { mode: 'costes' }, { bitDepth: 16, W: 64, H: 64 });
  const PW = 80, PH = 70, pa = new Array(PW * PH).fill(77), pb = new Array(PW * PH).fill(1234);
  for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) { pa[(y + 3) * PW + x + 9] = a[y * 64 + x]; pb[(y + 3) * PW + x + 9] = b[y * 64 + x]; }
  const gathered = analyze(pa, pb, { mode: 'costes' }, { bitDepth: 16, W: PW, H: PH, mask: { x: 9, y: 3, w: 64, h: 64, data: new Uint8Array(4096).fill(1) } });
  assert.deepEqual(plain(gathered), plain(base), '16-bit gathered through a selection = read in place, field for field');
  assert.deepEqual(Array.from(gathered.hist), Array.from(base.hist));
  assert.equal(base.costes, 'ok');
  // the same values as float: every statistic that does not depend on integer levels
  const f = analyze(a, b, { mode: 'none' }, { bitDepth: 32, W: 64, H: 64 });
  const i16 = analyze(a, b, { mode: 'none' }, { bitDepth: 16, W: 64, H: 64 });
  for (const k of ['n', 'nAbove', 'nBelow', 'mean1', 'mean2', 'pearsonAll', 'pearsonAbove', 'pearsonBelow', 'm1', 'm2', 'tm1', 'tm2', 'overlap', 'icq', 'slope', 'intercept']) near(f[k], i16[k], 1e-11, '32-bit vs 16-bit ' + k);
  // 8-bit data stored in 16 bits (the 8-bit table sums in key order, the 16-bit list in raster order: floats near, integers exact)
  const { a: a8, b: b8 } = makeData(5, 2000, 8);
  const x8 = analyze(a8, b8, { mode: 'costes' }, { bitDepth: 8, W: 50, H: 40 }), x16 = analyze(a8, b8, { mode: 'costes' }, { bitDepth: 16, W: 50, H: 40 });
  for (const k of ['n', 'nAbove', 'nBelow', 'costes', 't1', 'icqPositive']) assert.deepEqual(x16[k], x8[k], '8-bit vs 16-bit ' + k);
  for (const k of ['pearsonAll', 'pearsonAbove', 'pearsonBelow', 'm1', 'm2', 'tm1', 'tm2', 'overlap', 'icq', 't2', 'slope', 'intercept']) near(x16[k], x8[k], 1e-11, '8-bit vs 16-bit ' + k);
}

// ── 4. Costes ──
// The reference is the classical scan, written independently of the module's one-pass ladder: every integer
// level from the maximum of channel 1 down to 0, the first level where the pixels below are not positively correlated.
function belowR(a, b, t1, t2) {
  const sel = []; for (let i = 0; i < a.length; i++) if (!(a[i] >= t1 && b[i] >= t2)) sel.push(i);
  if (sel.length < 2) return null;
  let ma = 0, mb = 0; for (const i of sel) { ma += a[i]; mb += b[i]; } ma /= sel.length; mb /= sel.length;
  let saa = 0, sbb = 0, sab = 0; for (const i of sel) { saa += (a[i] - ma) ** 2; sbb += (b[i] - mb) ** 2; sab += (a[i] - ma) * (b[i] - mb); }
  return saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : null;
}
function classicalScan(a, b, slope, intercept) {
  let hi = -Infinity; for (let i = 0; i < a.length; i++) if (a[i] > hi) hi = a[i];
  const G = [];
  let first = null;
  for (let t = hi; t >= 0; t--) { const v = belowR(a, b, t, slope * t + intercept); G[t] = !(v > 0); if (first === null && G[t]) first = t; }
  return { first, G, hi };
}
{
  const { a, b } = makeData(21, 6000, 8);
  const r = analyze(a, b, { mode: 'costes' }, { W: 100, H: 60 });
  assert.equal(r.costes, 'ok');
  assert.ok(Number.isInteger(r.t1) && r.t1 > 0 && r.t1 < 255, 'an integer level inside the range: ' + r.t1);
  const cs = classicalScan(a, b, r.slope, r.intercept);
  assert.equal(r.t1, cs.first, 'T1 = the classical scan from the maximum down');
  assert.ok(cs.G[r.t1] && !cs.G[r.t1 + 1], 'g(T1) and not g(T1 + 1)');
  near(r.t2, r.slope * r.t1 + r.intercept, 1e-15, 'T2 is on the orthogonal regression line');
  assert.ok(!(r.pearsonBelow > 1e-9) || r.pearsonBelow === null, 'r(below) <= 0 at the answer');
  assert.ok(r.pearsonAbove > r.pearsonAll - 1e-9, 'the correlated population is above the thresholds');
  assert.equal(r.nAbove + r.nBelow, r.n, 'above and below partition the selection');
  // the line is the Deming (δ = 1) fit: its slope solves tan(2θ) = 2 Sab / (Saa - Sbb) (principal axis)
  const n = a.length; let ma = 0, mb = 0; for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; } ma /= n; mb /= n;
  let saa = 0, sbb = 0, sab = 0; for (let i = 0; i < n; i++) { saa += (a[i] - ma) ** 2; sbb += (b[i] - mb) ** 2; sab += (a[i] - ma) * (b[i] - mb); }
  near(r.slope, Math.tan(0.5 * Math.atan2(2 * sab, saa - sbb)), 1e-9, 'principal axis slope');
  near(r.intercept, mb - r.slope * ma, 1e-12, 'the line goes through the means');
}
{
  // Regression of the coarse walk (K = 32 steps + bisection) that took the first crossing it met: r(below) is not
  // monotone in T1 on random 8-bit data, and the module's T1 must equal the full scan on every case.
  let compared = 0, nonMonotone = 0;
  for (let seed = 1; seed < 700; seed++) {
    const rnd = lcg(seed), N = 60 + Math.floor(rnd() * 200), a = new Array(N), b = new Array(N);
    for (let i = 0; i < N; i++) { const s = Math.floor(rnd() * 255); a[i] = s; b[i] = Math.max(0, Math.min(255, Math.floor(s * 0.3 + rnd() * 180))); }
    const r = analyze(a, b, { mode: 'costes' }, { W: N, H: 1 });
    if (r.costes !== 'ok') continue;
    const cs = classicalScan(a, b, r.slope, r.intercept);
    assert.equal(r.t1, cs.first, 'seed ' + seed + ': T1 equals the full scan (' + r.t1 + ' vs ' + cs.first + ')');
    let flips = 0; for (let t = cs.hi - 1; t >= 0; t--) if (cs.G[t] !== cs.G[t + 1]) flips++;
    if (flips > 1) nonMonotone++;
    compared++;
  }
  assert.ok(compared > 400 && nonMonotone > 20, `the comparison is meaningful: ${compared} cases, ${nonMonotone} with a non-monotone r(below)`);
  // 16-bit (12-bit values): every integer level of a ladder of thousands of levels
  for (const seed of [3, 4, 5]) {
    const { a, b } = makeData(seed, 2500, 16);
    const r = analyze(a, b, { mode: 'costes' }, { bitDepth: 16, W: 50, H: 50 });
    assert.equal(r.costes, 'ok');
    assert.equal(r.t1, classicalScan(a, b, r.slope, r.intercept).first, '16-bit seed ' + seed);
  }
}
{
  // a pair that does correlate: Costes finds a threshold, and it is the one a hand scan finds
  const a = [], b = [];
  const rnd = lcg(99);
  for (let i = 0; i < 400; i++) { const s = Math.floor(rnd() * 200); a.push(s); b.push(Math.min(255, Math.floor(s * 0.9 + rnd() * 40))); }
  const r = analyze(a, b, { mode: 'costes' }, { W: 20, H: 20 });
  assert.equal(r.costes, 'ok');
  assert.equal(r.t1, classicalScan(a, b, r.slope, r.intercept).first);
  assert.ok(r.t1 > 0);
}
{
  // not positively correlated: the search fails; the thresholds and what depends on them are null (not 0)
  const r = analyze([1, 2, 3, 4, 5, 6], [6, 5, 4, 3, 2, 1], { mode: 'costes' });
  assert.equal(r.costes, 'failed');
  for (const k of ['t1', 't2', 'nAbove', 'nBelow', 'pearsonAbove', 'pearsonBelow', 'tm1', 'tm2']) assert.equal(r[k], null, 'a failed search leaves ' + k + ' empty');
  assert.equal(r.pearsonAll, -1, 'what does not depend on the thresholds is still reported');
  assert.ok(r.m1 !== null && r.overlap !== null);
  const c = analyze([5, 5, 5, 5], [1, 2, 3, 4], { mode: 'costes' });
  assert.equal(c.costes, 'failed', 'a constant channel has no regression');
}
{
  // 32-bit: T1 is the largest level of a 2^-32 ladder; everything downstream is exact once T is given
  const { a, b } = makeData(33, 3000, 8);
  const fa = a.map((v) => v / 255), fb = b.map((v) => v / 255);
  const r = analyze(fa, fb, { mode: 'costes' }, { bitDepth: 32, W: 60, H: 50 });
  assert.equal(r.costes, 'ok');
  const A = Float32Array.from(fa), B = Float32Array.from(fb);
  const g = (t) => { const v = belowR(A, B, t, r.slope * t + r.intercept); return !(v > 0); };
  const range = r.max1 - r.min1, step2 = range * Math.pow(2, -32);
  assert.ok(g(r.t1), 'g(T1)');
  assert.ok(!g(r.t1 + step2 * 1.001), 'not g(T1 + one step of the fine ladder)');
  assert.equal(r.t2, r.slope * r.t1 + r.intercept);
  const want = naive(A, B, () => true, r.t1, r.t2);
  assert.equal(r.nAbove, want.nAbove); assert.equal(r.nBelow, want.nBelow);
  for (const k of ['pearsonAbove', 'pearsonBelow']) near(r[k], want[k], 1e-9, '32-bit Costes ' + k);
  near(r.tm1, want.tmAll1, 1e-9, 'tM1'); near(r.tm2, want.tmAll2, 1e-9, 'tM2');
  // and T1 is at least as high as the largest level of a coarse 1024-step scan that satisfies g
  let coarse = null;
  for (let k = 1024; k >= 0; k--) { const t = r.min1 + (k * range) / 1024; if (g(t)) { coarse = t; break; } }
  assert.ok(r.t1 >= coarse - 1e-12, 'T1 >= the best of a 1024-step scan');
}

// ── 5. 32-bit: NaN / ±Infinity are not measured (FloatStatistics: v>=minThreshold && v<=maxThreshold) ──
{
  const a = [1, 2, NaN, 4, Infinity, 6], b = [2, 4, 6, NaN, 3, 12];
  const r = analyze(a, b, {}, { bitDepth: 32 });
  assert.equal(r.n, 3, 'pixels 0, 1, 5 only');
  const clean = analyze([1, 2, 6], [2, 4, 12], {}, { bitDepth: 32 });
  assert.deepEqual(plain(r), plain(clean));
  assert.throws(() => analyze([NaN, NaN], [1, 2], {}, { bitDepth: 32 }), (e) => e.code === 'IJ_COLOC_NO_PIXELS');
  // negative values: "above zero" is strict, a negative pixel is not above
  const q = analyze([-1, 1, 2, 3], [-2, 2, 4, 6], {}, { bitDepth: 32 });
  assert.equal(q.nAbove, 3);
}

// ── 6. the selection ──
{
  const W = 12, H = 10, { a, b } = makeData(41, W * H, 8);
  const mask = { x: 3, y: 2, w: 5, h: 4, data: new Uint8Array(20).fill(255) };
  mask.data[0] = 0; mask.data[7] = 0; mask.data[19] = 0; // an irregular area
  const inside = new Uint8Array(W * H);
  for (let y = 0; y < 4; y++) for (let x = 0; x < 5; x++) if (mask.data[y * 5 + x]) inside[(2 + y) * W + 3 + x] = 1;
  const r = analyze(a, b, { mode: 'manual', t1: 40, t2: 30 }, { W, H, mask });
  const want = naive(a, b, (i) => inside[i] === 1, 40, 30);
  assert.equal(r.n, 17); assert.equal(r.n, want.n);
  for (const k of ['pearsonAll', 'pearsonAbove', 'pearsonBelow', 'm1', 'm2', 'overlap', 'icq']) near(r[k], want[k], 1e-12, 'ROI ' + k);
  // a rectangle equals the cropped image
  const rect = { x: 2, y: 3, w: 6, h: 5, data: new Uint8Array(30).fill(1) };
  const cropA = [], cropB = [];
  for (let y = 3; y < 8; y++) for (let x = 2; x < 8; x++) { cropA.push(a[y * W + x]); cropB.push(b[y * W + x]); }
  const rr = analyze(a, b, { mode: 'costes' }, { W, H, mask: rect });
  const rc = analyze(cropA, cropB, { mode: 'costes' }, { W: 6, H: 5 });
  assert.deepEqual(plain(rr), plain(rc), 'a rectangular selection = the cropped image');
}

// ── 7. determinism, cancellation, the inputs stay untouched ──
{
  const { a, b } = makeData(55, 5000, 16);
  const A = Uint16Array.from(a), B = Uint16Array.from(b), copyA = A.slice(), copyB = B.slice();
  const run = (hooks) => IJColoc.analyze({ a: A, b: B, width: 100, height: 50, bitDepth: 16, mask: null, params: P({ mode: 'costes' }), hooks });
  const one = run(), two = run({ check() {}, tick() {} });
  assert.deepEqual(plain(one), plain(two)); assert.deepEqual(Array.from(one.hist), Array.from(two.hist));
  assert.deepEqual(A, copyA); assert.deepEqual(B, copyB);
  let calls = 0;
  assert.throws(() => run({ check() { if (++calls === 3) { const e = new Error('c'); e.code = 'IJ_CANCELLED'; throw e; } } }), (e) => e.code === 'IJ_CANCELLED', 'a cancel from the engine stops the passes');
  assert.ok(calls >= 3, 'check() is called while the passes run');
  assert.deepEqual(A, copyA);
  const ticks = []; run({ tick: (f) => ticks.push(f) });
  assert.ok(ticks.length >= 2 && ticks.every((f, i) => f >= 0 && f <= 1 && (i === 0 || f >= ticks[i - 1])), 'progress is monotone in [0, 1]');
  // the histogram: every measured pixel is counted once
  assert.equal(Array.from(one.hist).reduce((s, v) => s + v, 0), one.n);
  assert.equal(one.hist.length, 65536);
}

// ── 8. the 8-bit histogram bins are the data values ──
{
  const r = analyze([0, 255, 255, 7], [0, 255, 3, 7]);
  assert.equal(r.hist[0 * 256 + 0], 1);
  assert.equal(r.hist[255 * 256 + 255], 1);
  assert.equal(r.hist[3 * 256 + 255], 1, 'row = channel 2 value, column = channel 1 value');
  assert.equal(r.hist[7 * 256 + 7], 1);
  assert.deepEqual(Array.from(r.xRange), [-0.5, 255.5]);
}

// ── 9. the registry op ──
{
  const spec = reg.get('coloc');
  assert.equal(spec.kind, 'compute'); assert.equal(spec.version, 1); assert.equal(spec.preview, false); assert.deepEqual(Array.from(spec.bitDepths), [8, 16, 32]);
  const info = (o) => Object.assign({ width: 8, height: 8, bitDepth: 8, channels: 1, region: null, roi: null, docs: [] }, o);
  const code = (fn) => { try { fn(); } catch (e) { return e.code; } return null; };
  spec.validate(P({}), info());
  assert.equal(code(() => spec.validate(P({ mode: 'bogus' }), info())), 'IJ_BAD_ARGS');
  assert.equal(code(() => spec.validate(P({ mode: 'manual', t1: NaN }), info())), 'IJ_BAD_ARGS');
  assert.equal(code(() => spec.validate(P({ ch1: -1 }), info())), 'IJ_BAD_ARGS');
  assert.equal(code(() => spec.validate(P({ ch2: 1.5 }), info())), 'IJ_BAD_ARGS');
  assert.equal(code(() => spec.validate(P({ denominator: 'x' }), info())), 'IJ_BAD_ARGS');
  assert.equal(code(() => spec.validate(P({ excludeZero: 'yes' }), info())), 'IJ_BAD_ARGS');
  assert.equal(code(() => spec.validate(null, info())), 'IJ_BAD_ARGS');
  assert.equal(code(() => spec.validate(P({ doc2: 5 }), info())), 'IJ_BAD_ARGS', 'a second image that docIds does not name');
  assert.equal(code(() => spec.validate(P({ doc2: 5 }), info({ docs: [{ width: 9, height: 8, bitDepth: 8, channels: 2 }] }))), 'IJ_SIZE_MISMATCH');
  assert.equal(code(() => spec.validate(P({ doc2: 5 }), info({ docs: [{ width: 8, height: 8, bitDepth: 16, channels: 2 }] }))), 'IJ_COLOC_MIXED_DEPTH');
  assert.equal(code(() => spec.validate(P({ doc2: 5, ch2: 2 }), info({ docs: [{ width: 8, height: 8, bitDepth: 8, channels: 2 }] }))), 'IJ_BAD_ARGS', 'channel 3 of a two-channel image');
  spec.validate(P({ doc2: 5, ch2: 1 }), info({ docs: [{ width: 8, height: 8, bitDepth: 8, channels: 2 }] }));
  // scratch: what exists whatever the data (regression: the declaration was >= 65 MB for ANY 16-bit image, which threw
  // undo history away for a read-only measurement and refused 5735^2 x 3 on a small device). The lists a selection needs
  // are reserved through io.reserve once the count is known.
  const sb = (bd, w, h, roi) => spec.scratchBytes(info({ bitDepth: bd, width: w, height: h, roi: roi ? { type: 'rect' } : null }), P({}));
  for (const bd of [8, 16, 32]) {
    assert.ok(sb(bd, 256, 256) <= 8 << 20, bd + '-bit: a small declaration for a small image: ' + sb(bd, 256, 256));
    assert.equal(sb(bd, 5735, 5735), sb(bd, 256, 256), bd + '-bit: no per-pixel term (the lists are reserved when their size is known)');
  }
  assert.ok(sb(8, 100, 100, true) === sb(8, 100, 100, false) + 10000, 'a selection adds its mask');
  // run() through a recording io: two documents, a selection, the transfer of the histogram
  const W = 10, H = 6, rnd = lcg(3);
  const mk = (id, bd, n) => ({ id, name: 'd' + id, width: W, height: H, bitDepth: bd, channels: Array.from({ length: n }, () => ({ data: TYPES[bd].from(Array.from({ length: W * H }, () => Math.floor(rnd() * (bd === 8 ? 200 : 3000)))) })) });
  const v1 = mk(1, 8, 2), v2 = mk(2, 8, 2), v3 = mk(3, 16, 1), v4 = mk(4, 8, 1);
  v4.width = 11;
  const docs = { 2: v2, 3: v3, 4: v4 };
  const transferred = [], ticks = [];
  const io = { readDoc: (id) => { if (!docs[id]) { const e = new Error('x'); e.code = 'IJ_BAD_ARGS'; throw e; } return docs[id]; },
    roiMask: (roi) => (roi && roi.type === 'rect' ? { x: roi.x, y: roi.y, w: roi.w, h: roi.h, data: new Uint8Array(roi.w * roi.h).fill(1) } : null),
    check() {}, tick: (f, k) => ticks.push([f, k]), transfer: (b) => transferred.push(b) };
  const same = spec.run(v1, P({ ch1: 0, ch2: 1 }), null, io);
  assert.equal(same.n, W * H);
  assert.equal(transferred.length, 1); assert.equal(transferred[0], same.hist.buffer);
  assert.ok(ticks.every(([, k]) => k === 'op.coloc'));
  const two = spec.run(v1, P({ ch1: 1, ch2: 0, doc2: 2 }), null, io);
  assert.equal(two.n, W * H);
  const sel = spec.run(v1, P({ ch1: 0, ch2: 0, doc2: 2 }), { type: 'rect', x: 2, y: 1, w: 4, h: 3 }, io);
  assert.equal(sel.n, 12, 'the area selection limits the measured pixels');
  const line = spec.run(v1, P({}), { type: 'line', x1: 0, y1: 0, x2: 3, y2: 3, width: 1 }, io);
  assert.equal(line.n, W * H, 'a line selection means the whole image');
  assert.equal(code(() => spec.run(v1, P({ ch1: 0, ch2: 0 }), null, io)), 'IJ_BAD_ARGS', 'the same channel twice');
  assert.equal(code(() => spec.run(v1, P({ ch1: 0, ch2: 5 }), null, io)), 'IJ_BAD_ARGS', 'a channel the image does not have');
  assert.equal(code(() => spec.run(v1, P({ doc2: 3, ch2: 0 }), null, io)), 'IJ_COLOC_MIXED_DEPTH');
  assert.equal(code(() => spec.run(v1, P({ doc2: 4, ch2: 0 }), null, io)), 'IJ_SIZE_MISMATCH');
  assert.equal(code(() => spec.run(v1, P({ doc2: 9, ch2: 0 }), null, io)), 'IJ_BAD_ARGS', 'an image docIds does not name');
  assert.equal(code(() => spec.run(v1, P({ mode: 'costes', excludeZero: true }), { type: 'rect', x: 0, y: 0, w: 1, h: 1 }, io)), 'IJ_COLOC_NO_PIXELS', 'one pixel');
}

// ── 10. regressions of the review round ──
{
  // negative intensities (a background-subtracted 32-bit image): Manders' ratios and the overlap are not reported
  const r = analyze([-2, 1, 3, 5, 0.5], [-1, 2, 4, 6, 1], { mode: 'manual', t1: 0, t2: 0 }, { bitDepth: 32 });
  assert.equal(r.negative, true);
  for (const k of ['m1', 'm2', 'tm1', 'tm2', 'overlap']) assert.equal(r[k], null, k + ' needs non-negative intensities');
  assert.ok(r.pearsonAll > 0.9, 'Pearson does not');
  const ok = analyze([1, 2, 3], [2, 3, 5], {}, { bitDepth: 32 });
  assert.equal(ok.negative, false); assert.ok(ok.m1 !== null && ok.overlap !== null);
}
{
  // progress while the pixels are collected, and a cancel there (regression: ticks only came from the Costes search)
  const N = 512, rnd = lcg(5), a = new Uint16Array(N * N), b = new Uint16Array(N * N);
  for (let i = 0; i < a.length; i++) { a[i] = Math.floor(rnd() * 65535); b[i] = Math.min(65535, Math.floor(a[i] * 0.5 + rnd() * 30000)); }
  const ticks = [];
  let checks = 0;
  const mask = { x: 10, y: 10, w: 400, h: 400, data: new Uint8Array(160000).fill(1) };
  IJColoc.analyze({ a, b, width: N, height: N, bitDepth: 16, mask, params: P({ mode: 'costes' }), hooks: { tick: (f) => ticks.push(f), check: () => { checks++; } } });
  assert.ok(ticks.filter((f) => f < 0.16).length >= 4, 'progress is reported while the pixels are collected');
  assert.ok(ticks.every((f, i) => f >= 0 && f <= 1 && (i === 0 || f >= ticks[i - 1])), 'monotone in [0, 1]');
  assert.ok(checks >= 8 * Math.floor(160000 / 65536), 'the engine is asked about cancellation every 2^16 elements or every 32 rows of every pass: ' + checks);
  let n = 0;
  assert.throws(() => IJColoc.analyze({ a, b, width: N, height: N, bitDepth: 16, mask, params: P({ mode: 'costes' }), hooks: { check() { if (++n === 3) { const e = new Error('c'); e.code = 'IJ_CANCELLED'; throw e; } } } }), (e) => e.code === 'IJ_CANCELLED');
  assert.ok(n === 3, 'a cancel during the collection stops it');
}
{
  // the speed PLAN §5 asks for: full-range 16-bit Costes is linear (regression: 5 s at 2048^2, 15 s at 4096^2)
  const N = 1024, rnd = lcg(6), a = new Uint16Array(N * N), b = new Uint16Array(N * N);
  for (let i = 0; i < a.length; i++) { a[i] = Math.floor(rnd() * 65535); b[i] = Math.min(65535, Math.floor(a[i] * 0.6 + rnd() * 25000)); }
  const t0 = Date.now();
  const r = IJColoc.analyze({ a, b, width: N, height: N, bitDepth: 16, mask: null, params: P({ mode: 'costes' }) });
  const dt = Date.now() - t0;
  assert.equal(r.costes, 'ok');
  assert.ok(dt < 4000, 'a 1 M pixel full-range 16-bit Costes run takes well under 4 s (here ' + dt + ' ms)');
  // and it is the classical answer: a thinned check of g around T1 on a subsample is not enough, so compare with the 8-bit
  // table on the same data scaled to 8 bits (the ladder code is shared; the 8-bit case is checked against the full scan above)
}
{
  // the reserve calls: nothing when every pixel is measured, 4 / 8 bytes per measured pixel when a list is gathered
  const spec = reg.get('coloc');
  const W = 20, H = 10;
  const mk = (bd, vals) => ({ id: 1, name: 'd', width: W, height: H, bitDepth: bd, channels: [{ data: TYPES[bd].from(vals(0)) }, { data: TYPES[bd].from(vals(1)) }] });
  const rnd = lcg(8);
  const vals16 = (c) => Array.from({ length: W * H }, (_, i) => 1 + Math.floor(rnd() * 3000) + c);
  const run = (view, roi, over) => {
    const reserved = [];
    const io = { readDoc: () => view, roiMask: (r) => ({ x: r.x, y: r.y, w: r.w, h: r.h, data: new Uint8Array(r.w * r.h).fill(1) }), check() {}, tick() {}, transfer() {}, reserve: (n) => reserved.push(n) };
    spec.run(view, P(over || {}), roi, io);
    return reserved;
  };
  const v16 = mk(16, vals16);
  assert.deepEqual(run(v16, null), [], 'every pixel measured: the channels are read in place, nothing reserved');
  assert.deepEqual(run(v16, { type: 'rect', x: 2, y: 2, w: 5, h: 4 }), [5 * 4 * 4], '16-bit selection: 4 bytes per measured pixel');
  const v32 = mk(32, (c) => vals16(c).map((v) => v / 10));
  assert.deepEqual(run(v32, { type: 'rect', x: 2, y: 2, w: 5, h: 4 }), [5 * 4 * 8], '32-bit selection: 8 bytes per measured pixel');
  const z = mk(16, (c) => vals16(c).map((v, i) => (i < 7 ? 0 : v)));
  assert.deepEqual(run(z, null, { excludeZero: true }), [(W * H - 7) * 4], 'excluded zero-zero pixels: the gathered list');
  assert.deepEqual(run(mk(8, (c) => vals16(c).map((v) => v % 200)), { type: 'rect', x: 0, y: 0, w: 5, h: 5 }), [], '8-bit uses the joint histogram: nothing to reserve');
  // a refusal of the reserve is the engine's (IJ_OVER_BUDGET): it propagates
  const refusing = { readDoc: () => v16, roiMask: (r) => ({ x: r.x, y: r.y, w: r.w, h: r.h, data: new Uint8Array(r.w * r.h).fill(1) }), check() {}, tick() {}, transfer() {}, reserve() { const e = new Error('x'); e.code = 'IJ_OVER_BUDGET'; throw e; } };
  assert.throws(() => spec.run(v16, P({}), { type: 'rect', x: 2, y: 2, w: 5, h: 4 }, refusing), (e) => e.code === 'IJ_OVER_BUDGET');
}
{
  // the same-channel refusal is about (image, channel), not about the arrays: two images may hand back the same array
  const spec = reg.get('coloc');
  const W = 6, H = 5, shared = Uint8Array.from({ length: W * H }, (_, i) => (i * 7) % 90);
  const other = Uint8Array.from({ length: W * H }, (_, i) => (i * 5) % 80);
  const d1 = { id: 1, name: 'a', width: W, height: H, bitDepth: 8, channels: [{ data: shared }, { data: other }] };
  const d2 = { id: 2, name: 'b', width: W, height: H, bitDepth: 8, channels: [{ data: shared }] };
  const io = { readDoc: () => d2, roiMask: () => null, check() {}, tick() {}, transfer() {} };
  const r = spec.run(d1, P({ ch1: 0, ch2: 0, doc2: 2 }), null, io);
  assert.equal(r.n, W * H, 'two images sharing an array are still two images');
  assert.equal(r.pearsonAll, 1);
  assert.throws(() => spec.run(d1, P({ ch1: 1, ch2: 1 }), null, io), (e) => e.code === 'IJ_BAD_ARGS', 'the same channel of the same image');
  assert.throws(() => spec.validate(P({ ch1: 1, ch2: 1 }), { width: W, height: H, bitDepth: 8, channels: 2, docs: [] }), (e) => e.code === 'IJ_BAD_ARGS');
}

console.log('ij coloc: OK');
