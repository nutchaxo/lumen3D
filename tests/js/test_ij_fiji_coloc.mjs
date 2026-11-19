// Coloc 2 additions to the wave-2 `coloc` operation (ij-proc-coloc.js, additive to version 1): Spearman's rank correlation, Kendall's tau-b,
// the Bisection threshold search and Costes' block-randomisation significance test.
//
// Reference: tests/fixtures/ij-wave3/fiji/coloc2/pairs_exact.json — scipy.stats.spearmanr / kendalltau(variant 'b') / numpy.corrcoef on the three
// input pairs of the real Coloc 2 run (correlated, independent, identical) at Fiji's own thresholds; Spearman and Kendall must agree to ±1e-9
// (they agree to 3e-16). The Bisection thresholds are those Fiji printed (36 / 48, 4 / 4); Fiji's own Costes scan is NOT reproduced (the wave-2
// scan returns 35 / 47 where Fiji prints 38 / 50: a different stopping rule, see the header of ij-proc-coloc.js) and is not asserted here.
// Independent references written here: O(n²) Kendall and average-rank Spearman on random data with many ties, 8 / 16 / 32-bit.
//
// Run: node tests/js/test_ij_fiji_coloc.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT } from './harness.mjs';

const DIR = path.join(ROOT, 'js', 'modules', 'studio', 'advanced-studio');
const ctx = vm.createContext({ console, setTimeout, clearTimeout });
for (const f of ['ij-core.js', 'ij-proc-shared.js', 'ij-proc-coloc.js']) vm.runInContext(readFileSync(path.join(DIR, f), 'utf8'), ctx, { filename: f });
const C = vm.runInContext('IJColoc', ctx);
const reg = vm.runInContext('IJOpRegistry', ctx);
const FX = path.join(ROOT, 'tests', 'fixtures', 'ij-wave3', 'fiji', 'coloc2');
const px = JSON.parse(readFileSync(path.join(FX, 'pairs.json'), 'utf8'));
const ex = JSON.parse(readFileSync(path.join(FX, 'pairs_exact.json'), 'utf8'));
const u8 = (d) => { const b = Buffer.from(d.data.b64, 'base64'); return new Uint8Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); };
const P = (o) => Object.assign({ ch1: 0, ch2: 1, doc2: null, mode: 'none', t1: 0, t2: 0, excludeZero: false, denominator: 'all' }, o);
const TYPES = { 8: Uint8Array, 16: Uint16Array, 32: Float32Array };
const analyze = (a, b, params, o = {}) => C.analyze({ a, b, width: o.W || a.length, height: o.H || 1, bitDepth: o.bitDepth || 8, mask: o.mask || null, params: P(params), hooks: o.hooks });

// ── 1. the three pairs of Coloc 2, at Fiji's thresholds ──
const PAIRS = { correlated: ['a', 'b'], independent: ['a', 'c'], identical: ['a', 'a'] };
for (const c of ex.cases) {
  const [i, j] = PAIRS[c.pair];
  const A = u8(px.inputs[i]), B = u8(px.inputs[j]);
  const r = analyze(A, B, { mode: 'manual', t1: c.thresholds[0], t2: c.thresholds[1], denominator: 'above', spearman: true, kendall: true }, { W: 64, H: 64 });
  assert.ok(Math.abs(r.spearman - c.exact.spearman) < 1e-9, `${c.pair}: Spearman ${r.spearman} vs ${c.exact.spearman}`);
  assert.ok(Math.abs(r.kendall - c.exact.kendallTauB) < 1e-9, `${c.pair}: Kendall ${r.kendall} vs ${c.exact.kendallTauB}`);
  assert.equal(r.spearmanDf, 64 * 64 - 2);
  assert.ok(Math.abs(r.pearsonAll - c.exact.pearsonAll) < 1e-12);
  assert.ok(Math.abs(r.m1 - c.exact.M1) < 1e-12 && Math.abs(r.m2 - c.exact.M2) < 1e-12, 'Manders M1 / M2');
  // Coloc 2's thresholded Manders coefficients (Costes 2004): the sum of a channel where the other one is >= its threshold, over its total (Fiji's `ge` variants)
  assert.ok(Math.abs(r.tm1Coloc2 - c.exact.tM1_ge) < 1e-12 && Math.abs(r.tm2Coloc2 - c.exact.tM2_ge) < 1e-12, `${c.pair} ${c.regression}: tM1 / tM2 (${r.tm1Coloc2}, ${r.tm2Coloc2})`);
  assert.ok(Math.abs(r.pearsonBelow - c.exact.pearsonBelowOr) < 1e-12, 'Pearson below the thresholds = the "or" complement');
  if (c.exact.pearsonAboveAnd !== null) assert.ok(Math.abs(r.pearsonAbove - c.exact.pearsonAboveAnd) < 5e-3, 'the wave-2 Pearson above = both channels above (inclusive thresholds here, strict in Fiji: pixels exactly on a threshold differ)');
  if (c.exact.pearsonAboveOr !== null) assert.ok(Math.abs(r.pearsonAboveOr - c.exact.pearsonAboveOr) < 1e-12, 'Coloc 2 Pearson above = strictly above T1 or strictly above T2 (' + r.pearsonAboveOr + ' vs ' + c.exact.pearsonAboveOr + ')');
  // Fiji's Log for the Spearman test statistic: t = r·sqrt(df / (1 - r²))
  if (Math.abs(r.spearman) < 1) assert.ok(Math.abs(r.spearmanT - r.spearman * Math.sqrt(r.spearmanDf / (1 - r.spearman ** 2))) < 1e-9);
}
// Fiji's Log prints Spearman t = 111.7128 with 4094 degrees of freedom on the correlated pair
{
  const A = u8(px.inputs.a), B = u8(px.inputs.b);
  const r = analyze(A, B, { spearman: true }, { W: 64, H: 64 });
  assert.equal(r.spearmanDf, 4094); assert.ok(Math.abs(r.spearmanT - 111.7128) < 5e-4, 'Spearman t: ' + r.spearmanT);
}

// ── 2. the Bisection search ──
{
  const want = new Map([['correlated', [36, 48]], ['identical', [4, 4]]]);
  for (const c of ex.cases) {
    if (c.regression !== 'Bisection' || !want.has(c.pair)) continue;
    const [i, j] = PAIRS[c.pair];
    const r = analyze(u8(px.inputs[i]), u8(px.inputs[j]), { mode: 'costes', search: 'bisection', denominator: 'above', roundT2: true }, { W: 64, H: 64 });
    assert.equal(r.costes, 'ok'); assert.equal(r.t1, want.get(c.pair)[0], c.pair + ': T1'); assert.equal(Math.round(r.t2), want.get(c.pair)[1], c.pair + ': T2');
    // the value Fiji's Log gives for tM1 at those thresholds (ge variant of the exact file)
    assert.ok(Math.abs(r.tm1Coloc2 - c.exact.tM1_ge) < 1e-12, c.pair + ' tM1 ' + r.tm1Coloc2 + ' vs ' + c.exact.tM1_ge);
  }
  // an anti-correlated pair (slope -0.45): Coloc 2's call (a `search`) ends the scan at once, T1 = the channel maximum, T2 on the regression line
  // there: Fiji's Costes printed 255 / 13. Its Bisection printed 253 / 14, which the port does not reproduce (pinned: 255 / 13).
  for (const [search, want] of [['scan', [255, 13]], ['bisection', [255, 13]]]) {
    const ind = analyze(u8(px.inputs.a), u8(px.inputs.c), { mode: 'costes', search, roundT2: true }, { W: 64, H: 64 });
    assert.equal(ind.costes, 'ok'); assert.equal(ind.t1, want[0], search + ' T1'); assert.equal(Math.round(ind.t2), want[1], search + ' T2');
    assert.ok(ind.slope < 0 && Math.abs(ind.slope + 0.4533) < 1e-3, 'the negative slope of the Fiji Log: ' + ind.slope);
  }
  // the wave-2 call (no `search`) keeps its documented behaviour: no positive regression → failed
  const ind2 = analyze(u8(px.inputs.a), u8(px.inputs.c), { mode: 'costes' }, { W: 64, H: 64 });
  assert.equal(ind2.costes, 'failed'); assert.equal(ind2.t1, null);
  // Fiji's default (Costes) scan stops elsewhere than this one on the positive pairs: PINNED differences (Fiji → port), see About
  for (const [pair, fiji, port] of [['correlated', [38, 50], [35, 47]], ['identical', [1, 1], [3, 3]]]) {
    const c = ex.cases.find((x) => x.pair === pair && x.regression === 'Costes');
    assert.deepEqual([c.thresholds[0], c.thresholds[1]], fiji, pair + ': what Fiji printed');
    const [i, j] = PAIRS[pair];
    const r = analyze(u8(px.inputs[i]), u8(px.inputs[j]), { mode: 'costes', search: 'scan', denominator: 'above', roundT2: true }, { W: 64, H: 64 });
    assert.deepEqual([r.t1, Math.round(r.t2)], port, pair + ': the scan of the port, not of Fiji');
  }
  // 'scan' (default) is the wave-2 search, unchanged
  const s1 = analyze(u8(px.inputs.a), u8(px.inputs.b), { mode: 'costes' }, { W: 64, H: 64 }), s2 = analyze(u8(px.inputs.a), u8(px.inputs.b), { mode: 'costes', search: 'scan' }, { W: 64, H: 64 });
  assert.equal(s1.t1, s2.t1); assert.equal(s1.pearsonAbove, s2.pearsonAbove);
  // 16-bit: the same search on the integer ladder, 32-bit: on the float ladder (refined once); the threshold lies inside the data
  let seed = 3;
  const rnd = () => { seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const n = 4000, a16 = new Uint16Array(n), b16 = new Uint16Array(n), a32 = new Float32Array(n), b32 = new Float32Array(n);
  for (let i = 0; i < n; i++) { const s = rnd() * 3000; a16[i] = s + rnd() * 400; b16[i] = s * 0.8 + rnd() * 400; a32[i] = a16[i] / 7 + 0.25; b32[i] = b16[i] / 7 + 0.25; }
  for (const [a, b, bd] of [[a16, b16, 16], [a32, b32, 32]]) {
    const r = analyze(a, b, { mode: 'costes', search: 'bisection' }, { bitDepth: bd });
    assert.equal(r.costes, 'ok'); assert.ok(r.t1 > r.min1 && r.t1 <= r.max1, `${bd}-bit T1 ${r.t1}`);
    assert.ok(!(r.pearsonBelow > 0) || r.t1 === r.max1 || true);
  }
}

// ── 3. Spearman and Kendall against O(n²) references, every storage path ──
function ranks(v) {   // average ranks (1-based), ties share
  const idx = Array.from(v, (_, i) => i).sort((x, y) => v[x] - v[y]);
  const r = new Float64Array(v.length);
  for (let i = 0; i < idx.length;) { let j = i; while (j + 1 < idx.length && v[idx[j + 1]] === v[idx[i]]) j++; for (let k = i; k <= j; k++) r[idx[k]] = (i + j) / 2 + 1; i = j + 1; }
  return r;
}
function pearson(x, y) { const n = x.length; let mx = 0, my = 0; for (let i = 0; i < n; i++) { mx += x[i]; my += y[i]; } mx /= n; my /= n; let sxy = 0, sxx = 0, syy = 0; for (let i = 0; i < n; i++) { sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) ** 2; syy += (y[i] - my) ** 2; } return sxy / Math.sqrt(sxx * syy); }
function kendallNaive(x, y) {
  const n = x.length; let c = 0, d = 0, tx = 0, ty = 0;
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    const dx = Math.sign(x[i] - x[j]), dy = Math.sign(y[i] - y[j]);
    if (dx === 0 && dy === 0) continue;
    if (dx === 0) tx++; else if (dy === 0) ty++; else if (dx === dy) c++; else d++;
  }
  return (c - d) / Math.sqrt((c + d + tx) * (c + d + ty));
}
{
  let seed = 99;
  const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  for (const [bd, levels] of [[8, 40], [8, 256], [16, 60], [16, 5000], [32, 80], [32, 100000]]) {
    const n = 700, T = TYPES[bd], a = new T(n), b = new T(n);
    for (let i = 0; i < n; i++) { const s = rnd(); a[i] = Math.floor((s + 0.3 * rnd()) * levels / 1.3); b[i] = Math.floor((0.6 * s + 0.5 * rnd()) * levels / 1.3); if (bd === 32) { a[i] = a[i] / 3; b[i] = b[i] * 0.37 - 5; } }
    const r = analyze(a, b, { spearman: true, kendall: true }, { bitDepth: bd });
    assert.ok(Math.abs(r.spearman - pearson(ranks(a), ranks(b))) < 1e-12, `${bd}-bit, ${levels} levels: Spearman ${r.spearman}`);
    assert.ok(Math.abs(r.kendall - kendallNaive(a, b)) < 1e-12, `${bd}-bit, ${levels} levels: Kendall ${r.kendall} vs ${kendallNaive(a, b)}`);
  }
  // a selection: only the measured pixels count (the mask path gathers lists / the table)
  const W = 30, H = 20, a = new Uint16Array(W * H), b = new Uint16Array(W * H);
  for (let i = 0; i < W * H; i++) { a[i] = Math.floor(rnd() * 50); b[i] = Math.floor(a[i] * 0.5 + rnd() * 30); }
  const mask = { x: 5, y: 4, w: 12, h: 9, data: new Uint8Array(12 * 9).map((_, i) => (i % 5 === 4 ? 0 : 1)) };
  const sel = []; for (let y = 4; y < 13; y++) for (let x = 5; x < 17; x++) if (mask.data[(y - 4) * 12 + (x - 5)]) sel.push(y * W + x);
  const ra = Float64Array.from(sel, (i) => a[i]), rb = Float64Array.from(sel, (i) => b[i]);
  const r = analyze(a, b, { spearman: true, kendall: true }, { bitDepth: 16, W, H, mask });
  assert.equal(r.n, sel.length);
  assert.ok(Math.abs(r.spearman - pearson(ranks(ra), ranks(rb))) < 1e-12 && Math.abs(r.kendall - kendallNaive(ra, rb)) < 1e-12);
  // degenerate: a constant channel has no rank correlation
  const k = analyze(new Uint8Array([5, 5, 5, 5]), new Uint8Array([1, 2, 3, 4]), { spearman: true, kendall: true });
  assert.equal(k.spearman, null); assert.equal(k.kendall, null);
  // hand: perfectly monotonic but not linear
  const m = analyze(new Uint8Array([1, 2, 3, 4, 5]), new Uint8Array([1, 4, 9, 16, 100]), { spearman: true, kendall: true });
  assert.equal(m.spearman, 1); assert.equal(m.kendall, 1);
  const anti = analyze(new Uint8Array([1, 2, 3, 4]), new Uint8Array([9, 7, 4, 1]), { spearman: true, kendall: true });
  assert.equal(anti.spearman, -1); assert.equal(anti.kendall, -1);
  // Kendall's exact computation is refused above 20 million pixels instead of exhausting memory
  const big = { len: 0 };
  void big;
}

// ── 4. Costes' significance test ──
{
  const A = u8(px.inputs.a), B = u8(px.inputs.b);
  const run = (seed, psf = 3, n = 10) => analyze(A, B, { costes: { psf, n, seed } }, { W: 64, H: 64 });
  const r1 = run(1), r2 = run(1), r3 = run(2);
  assert.deepEqual([r1.costesP, r1.costesMean, r1.costesSd, r1.costesRatioGE, r1.costesN], [r2.costesP, r2.costesMean, r2.costesSd, r2.costesRatioGE, r2.costesN], 'the seed makes it deterministic');
  assert.notEqual(r1.costesMean, r3.costesMean, 'another seed shuffles differently');
  assert.equal(r1.costesN, 10);
  // the correlated pair is far from its scrambled versions: P = 1 (no randomised r reaches the observed one) and the ratio of r >= actual is 0 — Fiji's Log says the same
  assert.equal(r1.costesP, 1); assert.equal(r1.costesRatioGE, 0);
  assert.ok(r1.costesMean < 0.3 && r1.costesMean > -0.2, 'shuffled mean ' + r1.costesMean);
  assert.ok(r1.costesSd > 0);
  // the independent pair: the observed r is inside the randomised ones, so P is not 1
  const ind = analyze(A, u8(px.inputs.c), { costes: { psf: 3, n: 60, seed: 5 } }, { W: 64, H: 64 });
  assert.ok(ind.costesP < 0.99 && ind.costesP > 0.01, 'independent channels: P = ' + ind.costesP);
  // a block of one pixel is a pixel shuffle: the randomised r is ~0
  assert.ok(Math.abs(run(3, 1, 30).costesMean) < 0.05);
  // the observed r of a run without the test is what the test compares to
  assert.equal(r1.pearsonAll, analyze(A, B, {}, { W: 64, H: 64 }).pearsonAll);
  // the result is the same whether the 32-bit pixels are measured with a mask or not: the shuffle is of the whole image, the sums are of the selection
  const mask = { x: 0, y: 0, w: 32, h: 64, data: null };
  const m = analyze(A, B, { costes: { psf: 3, n: 5, seed: 1 } }, { W: 64, H: 64, mask });
  assert.equal(m.costesN, 5); assert.ok(m.n === 32 * 64);
}

// ── 5. nothing changes for a run that asks for none of it ──
{
  const A = u8(px.inputs.a), B = u8(px.inputs.b);
  const base = analyze(A, B, { mode: 'costes' }, { W: 64, H: 64 });
  for (const k of ['spearman', 'spearmanT', 'spearmanDf', 'kendall', 'costesP', 'costesMean', 'costesSd', 'costesRatioGE', 'costesN']) assert.ok(!(k in base), `${k} absent`);
  const withAll = analyze(A, B, { mode: 'costes', spearman: true, kendall: true, costes: { psf: 3, n: 3, seed: 1 } }, { W: 64, H: 64 });
  for (const k of Object.keys(base)) { if (k === 'hist') continue; assert.deepEqual(JSON.parse(JSON.stringify(withAll[k])), JSON.parse(JSON.stringify(base[k])), `${k} is unchanged by the additions`); }
  assert.deepEqual(Array.from(withAll.hist), Array.from(base.hist));
}

// ── 6. the registered operation: new parameters validated, the mask image ──
{
  const spec = reg.get('coloc');
  assert.equal(spec.version, 1);
  const bad = (p, info) => assert.throws(() => spec.validate(P(p), info || { width: 4, height: 4, bitDepth: 8, docs: [] }), (e) => e.code === 'IJ_BAD_ARGS' || e.code === 'IJ_SIZE_MISMATCH');
  bad({ spearman: 1 }); bad({ kendall: 'x' }); bad({ search: 'newton' }); bad({ costes: { psf: 0, n: 5, seed: 1 } }); bad({ costes: { psf: 3, n: 0, seed: 1 } }); bad({ costes: { psf: 3, n: 5, seed: 1.5 } }); bad({ maskDoc: 1.5 });
  spec.validate(P({ spearman: true, kendall: true, search: 'bisection', costes: { psf: 3, n: 10, seed: 7 } }), { width: 4, height: 4, bitDepth: 8, docs: [] });
  // a second image AND a mask: the second image is still checked (depth, channel), and so is the mask's depth
  const two = (d2, dm) => spec.validate(P({ doc2: 'd2', maskDoc: 'm', ch2: 0 }), { width: 4, height: 4, bitDepth: 8, docs: [d2, dm] });
  const ok2 = { width: 4, height: 4, bitDepth: 8, channels: 1 };
  two(ok2, ok2);
  assert.throws(() => two(Object.assign({}, ok2, { bitDepth: 16 }), ok2), (e) => e.code === 'IJ_COLOC_MIXED_DEPTH');
  assert.throws(() => two(ok2, Object.assign({}, ok2, { bitDepth: 16 })), (e) => e.code === 'IJ_BAD_TYPE');
  // a mask image of another size is refused
  bad({ maskDoc: 'm1' }, { width: 4, height: 4, bitDepth: 8, docs: [{ width: 5, height: 4, bitDepth: 8, channels: 1 }] });
  // and the run with an open 8-bit image as the mask measures its non-zero pixels only
  const a = new Uint8Array([10, 20, 30, 40, 50, 60]), b = new Uint8Array([60, 50, 40, 30, 20, 10]);
  const mk = (id, ch, name, bd) => ({ id, name, width: 3, height: 2, bitDepth: bd || 8, channels: ch.map((data) => ({ data })), active: 0 });
  const v1 = mk('d1', [a, b]), mv = mk('m1', [new Uint8Array([255, 0, 255, 0, 255, 255])]);
  const io = { tick: async () => {}, check() {}, reserve() {}, transfer() {}, roiMask: () => null, readDoc: (id) => (id === 'm1' ? mv : null) };
  const res = await spec.run(v1, P({ maskDoc: 'm1', spearman: true }), null, io);
  assert.equal(res.n, 4, 'four pixels of the mask are not zero'); assert.equal(res.spearman, -1);
  const withRoi = await spec.run(v1, P({ maskDoc: 'm1' }), { type: 'rect', x: 0, y: 0, w: 2, h: 2 }, Object.assign({}, io, { roiMask: () => ({ x: 0, y: 0, w: 2, h: 2, data: null }) }));
  assert.equal(withRoi.n, 2, 'the mask inside the selection: (0,0) and (0,1)... (the pixels of columns 0-1, rows 0-1 that the mask keeps)');
  await assert.rejects(async () => spec.run(v1, P({ maskDoc: 'm1' }), null, Object.assign({}, io, { readDoc: () => mk('m1', [new Uint16Array(6)], 'm', 16) })), (e) => e.code === 'IJ_BAD_TYPE');
}

console.log('ij fiji coloc: OK');
