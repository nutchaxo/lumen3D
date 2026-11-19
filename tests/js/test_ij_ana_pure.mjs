// P-ana (wave 3), the pure and engine side: IJAna (ij-proc-ana.js) and the doc.* handlers it feeds, against the ImageJ 1.54p goldens of
// tests/fixtures/ij-wave3/ana/ (particles, particles_calibrated, histogram, profile, invert_y) and against independent computations.
//
// Tolerances: integers exact; the profile of a straight line and of a polyline exact to 1e-9 (the same float samples); a 16 / 32-bit
// histogram statistic to 1e-9 relative (double sums in a different order); ImageJ's single-precision shape columns (Round, AR, Circ.) 1e-6.
//
// Run: node tests/js/test_ij_ana_pure.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { boot } from './ij_harness.mjs';
import { ROOT } from './harness.mjs';

const DIR = path.join(ROOT, 'js', 'modules', 'studio', 'advanced-studio');
const FIX = path.join(ROOT, 'tests', 'fixtures', 'ij-wave3', 'ana');
const fixture = (n) => JSON.parse(fs.readFileSync(path.join(FIX, n + '.json'), 'utf8'));
const ctx = vm.createContext({ console, setTimeout, clearTimeout, MessageChannel, performance, TextEncoder, TextDecoder, Blob, queueMicrotask, navigator: {} });
ctx.self = ctx;
for (const f of ['ij-core.js', 'ij-analysis.js', 'ij-proc-shared.js', 'ij-proc-roi.js', 'ij-proc-ana.js']) vm.runInContext(fs.readFileSync(path.join(DIR, f), 'utf8'), ctx, { filename: f });
const A = ctx.IJAna;
assert.ok(A, 'IJAna is attached');

let passed = 0;
async function test(name, fn) { try { await fn(); passed++; console.log('  ok  ' + name); } catch (e) { console.error('FAIL ' + name); throw e; } }
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol * Math.max(1, Math.abs(b)), `${msg || 'near'}: ${a} vs ${b}`);
const decode = (o) => {
  const b = Buffer.from(o.data.b64, 'base64');
  const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  const T = { u8: Uint8Array, u16: Uint16Array, f32: Float32Array }[o.data.dtype];
  return { width: o.width, height: o.height, bitDepth: o.bitDepth, data: new T(ab) };
};
const sameArr = (a, b) => a.length === b.length && Array.prototype.every.call(a, (v, i) => v === b[i]);

await test('ResultsTable.d2s and getValueAsString (Java DecimalFormat, HALF_EVEN, scientific notation)', () => {
  assert.equal(A.d2s(1.5, 0), '2');
  assert.equal(A.d2s(2.5, 0), '3', 'df[0] is HALF_UP');
  assert.equal(A.d2s(0.125, 2), '0.12', 'an exact tie goes to the even digit');
  assert.equal(A.d2s(0.375, 2), '0.38');
  assert.equal(A.d2s(1.005, 2), '1.00', 'the binary value of 1.005 is below the tie');
  assert.equal(A.d2s(3.14159, 3), '3.142');
  assert.equal(A.d2s(-0.0004, 2), '-4.000E-4');
  assert.equal(A.d2s(-1.5, 1), '-1.5');
  assert.equal(A.d2s(0.0004, 3), '4.000E-4', 'a value under 1/10^places is printed in scientific notation');
  assert.equal(A.d2s(1234.5678, -2), '1.23E3');
  assert.equal(A.d2s(1e13, 3), '1.000E13');
  assert.equal(A.d2s(NaN, 3), 'NaN');
  assert.equal(A.d2s(Infinity, 3), 'Infinity');
  assert.equal(A.d2s(0, 3), '0.000');
  assert.equal(A.cellString(30, 3), '30', 'a whole number has no decimals');
  assert.equal(A.cellString(30.5, 3), '30.500');
  assert.equal(A.cellString(30, -3), '3.000E1', 'scientific notation formats every number');
  assert.equal(A.cellString(NaN, 3), 'NaN');
  assert.equal(A.cellString('abc', 3), 'abc');
  assert.equal(A.cellString(undefined, 3), '');
  assert.equal(A.cellString(3e10, 3), '30000000000.000', '(int)n != n for a value beyond int: the precision applies');
});

await test('Analyze Particles dialog strings (ParticleAnalyzer.showDialog)', () => {
  assert.deepEqual({ ...A.particleSettings('0-Infinity', '0.00-1.00', 1) }, { minSize: 0, maxSize: Infinity, minCirc: 0, maxCirc: 1 });
  assert.deepEqual({ ...A.particleSettings('10-200', '0.5-1', 0.25) }, { minSize: 40, maxSize: 800, minCirc: 0.5, maxCirc: 1 }, 'calibrated sizes are divided by the pixel area');
  assert.deepEqual({ ...A.particleSettings('5', '', 1) }, { minSize: 5, maxSize: Infinity, minCirc: 0, maxCirc: 1 }, 'one number = a minimum');
  assert.equal(A.particleSettings('20 100', '0 1', 1).maxSize, 100, 'a space separates like a dash (Tools.split(str, " -"))');
  assert.equal(A.particleSettings('50-10', '0-1', 1).maxSize, Infinity, 'a maximum under the minimum is no limit');
  assert.equal(A.particleSettings('abc', 'x-y', 1).minSize, 0, 'unreadable text is the default, never a refusal');
  const c = A.particleSettings('0-Infinity', '0.9-0.3', 1);
  assert.deepEqual([c.minCirc, c.maxCirc], [0.3, 0.3], 'minCirc > maxCirc: the minimum comes down; then the maximum is raised');
  assert.deepEqual([A.particleSettings('0-1', '1-1', 1).minCirc], [0], '1-1 is 0-1');
  assert.deepEqual([A.particleSettings('0-1', '0.5-1', 1).minCirc, A.particleSettings('0-1', '-0.5-1', 1).minCirc], [0.5, 0.5]);
  assert.equal(A.sizeText(0, Infinity, 1), '0-Infinity');
  assert.equal(A.sizeText(40, 800, 0.25), '10-200');
  assert.equal(A.sizeText(1, 7, 0.25), '0.25-1.75', 'decimals only when a limit is not whole');
  assert.equal(A.circText(0, 1), '0.00-1.00');
});

await test('Calibration.getY with Invert Y coordinates, Results sort, Find Commands matching', () => {
  const row = { yCentroid: 18, yCenterOfMass: 18.469, by: 8, feretY: 8, xCentroid: 25 };
  A.invertY(row, 48, 1);
  assert.deepEqual({ ...row }, { yCentroid: 47 - 18, yCenterOfMass: 47 - 18.469, by: 47 - 8, feretY: 8, xCentroid: 25 }, 'FeretY and X stay');
  const r2 = { yCentroid: 9 }; A.invertY(r2, 48, 0.5);
  assert.equal(r2.yCentroid, 47 * 0.5 - 9);
  const rows = [{ Area: 5 }, { Area: 2 }, { Area: NaN }, { Area: 2, k: 1 }, {}];
  assert.deepEqual(A.sortOrder(rows, 'Area', false), [4, 1, 3, 0, 2], 'stable ascending, NaN last, a missing cell is 0');
  assert.deepEqual(A.sortOrder(rows, 'Area', true), [1, 3, 0, 2, 4], 'with NaN empty cells the missing cell is NaN too');
  assert.ok(A.rankMatches(A.searchWords('gauss blur'), 'Gaussian Blur…', 'Process>Filters'));
  assert.ok(A.rankMatches(A.searchWords('process gauss'), 'Gaussian Blur…', 'Process>Filters'), 'a word may match the menu path');
  assert.ok(!A.rankMatches(A.searchWords('median blur'), 'Gaussian Blur…', 'Process>Filters'));
});

await test('Plot Profile against ProfilePlot.getProfile (8-bit golden: rectangle, vertical, line, wide line, polyline; interpolate on / off)', () => {
  const f = fixture('profile');
  const img = decode(f.input8);
  let n = 0;
  for (const c of f.cases.filter((x) => x.bitDepth === 8)) {
    const fp = c.roi.floatPolygon, roi = c.roi.class === 'Line' ? { type: 'line', x1: 4, y1: 30, x2: 40, y2: 6, width: c.roi.strokeWidth }
      : c.roi.class === 'PolygonRoi' ? { type: 'polyline', points: [[4, 30], [16, 8], [28, 28], [42, 10]], width: 0 }
        : { type: 'rect', x: c.roi.bounds[0], y: c.roi.bounds[1], w: c.roi.bounds[2], h: c.roi.bounds[3] };
    void fp;
    const got = A.profile(img, roi, { interpolate: c.params.interpolate, vertical: c.params.vertical, calibration: { pixelWidth: 1, pixelHeight: 1 } });
    const ref = c.result.profile;
    assert.equal(got.values.length, ref.length, c.name + ' length');
    for (let i = 0; i < ref.length; i++) near(got.values[i], ref[i], 1e-9, `${c.name} ${JSON.stringify(c.params)}[${i}]`);
    n++;
  }
  assert.equal(n, 14);
  // the step: pixel width, the pixel height of a vertical profile, the calibrated over the pixel length of a line with non-square pixels
  const cal = { pixelWidth: 2, pixelHeight: 0.5 };
  assert.equal(A.profile(img, { type: 'rect', x: 1, y: 1, w: 5, h: 4 }, { calibration: cal }).step, 2);
  assert.equal(A.profile(img, { type: 'rect', x: 1, y: 1, w: 5, h: 4 }, { calibration: cal, vertical: true }).step, 0.5);
  near(A.profile(img, { type: 'line', x1: 0, y1: 0, x2: 4, y2: 3, width: 1 }, { calibration: cal }).step, Math.sqrt(64 + 2.25) / 5, 1e-12);
  assert.throws(() => A.profile(img, { type: 'oval', x: 0, y: 0, w: 3, h: 3 }), (e) => e.code === 'IJ_BAD_ROI');
  assert.throws(() => A.profile(img, { type: 'rect', x: 100, y: 0, w: 3, h: 3 }), (e) => e.code === 'IJ_EMPTY_ROI');
  // a NaN pixel of a 32-bit image is left out of the average
  const f32 = { width: 3, height: 2, bitDepth: 32, data: new Float32Array([1, NaN, 5, 3, 4, NaN]) };
  const pr = A.profile(f32, { type: 'rect', x: 0, y: 0, w: 3, h: 2 }, {}).values;
  assert.deepEqual([pr[0], pr[1], pr[2]], [2, 4, 5]);
  const pr2 = A.profile(f32, { type: 'rect', x: 0, y: 0, w: 3, h: 2 }, { vertical: true }).values;
  assert.deepEqual([pr2[0], pr2[1]], [3, 3.5]);
});

// Gen.tex(bits, w, h, seed) of tools/ij_fixtures/Gen.java, rebuilt with java.util.Random (IJShared.JavaRandom): the 16 and 32-bit inputs of the profile golden are not
// stored in the fixture, only the 8-bit one (which this generator must reproduce pixel for pixel, the proof that the 16 and 32-bit ones are the same texture)
function genTex(bits, w, h, seed) {
  const r = new ctx.IJShared.JavaRandom(seed);
  const n = 5, sMin = 2.5, sMax = 6, slopeX = 0.15, slopeY = 0.1, base = 0.12, noise = 0.03;
  const cx = [], cy = [], sg = [], am = [];
  for (let i = 0; i < n; i++) { cx[i] = r.nextDouble() * w; cy[i] = r.nextDouble() * h; sg[i] = sMin + r.nextDouble() * (sMax - sMin); am[i] = 0.3 + 0.5 * r.nextDouble(); }
  const v = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = base + slopeX * x / w + slopeY * y / h;
      for (let i = 0; i < n; i++) { const dx = x - cx[i], dy = y - cy[i]; s += am[i] * Math.exp(-(dx * dx + dy * dy) / (2 * sg[i] * sg[i])); }
      s += noise * r.nextGaussian();
      v[y * w + x] = Math.max(0, Math.min(1, s));
    }
  }
  const jround = (a) => Math.floor(a + 0.5);
  if (bits === 8) return { width: w, height: h, bitDepth: 8, data: Uint8Array.from(v, (a) => jround(Math.fround(a * 255)) & 255) };
  if (bits === 16) return { width: w, height: h, bitDepth: 16, data: Uint16Array.from(v, (a) => jround(Math.fround(a * 60000)) & 65535) };
  return { width: w, height: h, bitDepth: 32, data: Float32Array.from(v, (a) => Math.fround(Math.fround(a * 500) - 100)) };
}

await test('Plot Profile against ProfilePlot.getProfile for 16 and 32-bit images (inputs rebuilt from the golden\'s generator, 8-bit input proven identical)', () => {
  const f = fixture('profile');
  const g8 = decode(f.input8);
  const mine = genTex(8, 48, 36, 13);
  assert.ok(sameArr(mine.data, g8.data), 'the generator reproduces the stored 8-bit input of the golden');
  let n = 0;
  for (const bits of [16, 32]) {
    const img = genTex(bits, 48, 36, 13);
    for (const c of f.cases.filter((x) => x.bitDepth === bits)) {
      const roi = c.roi.class === 'Line' ? { type: 'line', x1: 4, y1: 30, x2: 40, y2: 6, width: c.roi.strokeWidth }
        : c.roi.class === 'PolygonRoi' ? { type: 'polyline', points: [[4, 30], [16, 8], [28, 28], [42, 10]], width: 0 }
          : { type: 'rect', x: c.roi.bounds[0], y: c.roi.bounds[1], w: c.roi.bounds[2], h: c.roi.bounds[3] };
      const got = A.profile(img, roi, { interpolate: c.params.interpolate, vertical: c.params.vertical, calibration: { pixelWidth: 1, pixelHeight: 1 } });
      const ref = c.result.profile;
      assert.equal(got.values.length, ref.length, bits + ' ' + c.name + ' length');
      for (let i = 0; i < ref.length; i++) near(got.values[i], ref[i], 1e-9, `${bits}-bit ${c.name} ${JSON.stringify(c.params)}[${i}]`);
      n++;
    }
  }
  assert.equal(n, 28, 'both depths: 14 cases each');
});

await test('Plot Profile of a rectangle partly outside the image: rect.width values, NaN where ImageProcessor.getLine reads outside (ProfilePlot.java:223-239)', () => {
  const img = { width: 4, height: 3, bitDepth: 8, data: Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]) };
  const p = A.profile(img, { type: 'rect', x: 2, y: 1, w: 5, h: 4 }, {}).values;
  assert.equal(p.length, 5, 'rect.width values');
  assert.deepEqual([p[0], p[1]], [(7 + 11) / 2, (8 + 12) / 2]);
  assert.ok(p[2] !== p[2] && p[3] !== p[3] && p[4] !== p[4], 'NaN outside the image');
  const q = A.profile(img, { type: 'rect', x: 2, y: 1, w: 5, h: 4 }, { vertical: true }).values;
  assert.equal(q.length, 4, 'rect.height values');
  assert.deepEqual([q[0], q[1]], [(7 + 8) / 2, (11 + 12) / 2]);
  assert.ok(q[2] !== q[2] && q[3] !== q[3]);
  assert.throws(() => A.profile(img, { type: 'rect', x: -9, y: 0, w: 3, h: 3 }), (e) => e.code === 'IJ_EMPTY_ROI');
});

await test('HistogramPlot.d2s and IJ.d2s(x, significantDigits, maxDigits): whole numbers have no decimals, any other 3 significant digits within 8', () => {
  assert.equal(A.histNumber(55), '55');
  assert.equal(A.histNumber(0), '0');
  assert.equal(A.histNumber(-3), '-3');
  assert.equal(A.histNumber(55.748), '55.748', 'a mean of an 8-bit image keeps its decimals');
  assert.equal(A.histNumber(2592.1186), '2592.119');
  assert.equal(A.histNumber(0.12345), '0.123');
  assert.equal(A.histNumber(0.0012345), '0.00123', 'magnitude -2: 5 decimals keep 3 significant digits');
  assert.equal(A.histNumber(1234567.891), '1234567.9', 'magnitude 7 of 8 digits: one decimal remains');
  assert.equal(A.histNumber(123456789.5), '1.235E8', 'beyond 8 digits: scientific notation');
  assert.equal(A.histNumber(1e-9), '1.000E-9');
  assert.equal(A.histNumber(NaN), 'NaN');
  assert.equal(A.histNumber(3e10), '3.000E10', '(int)d != d beyond the int range');
});

await test('IJParticles: the scan is a generator (analyze = analyzeAsync = analyzeSteps), the yield points are data-only, a throw from the step cancels; scratchBytes covers the real peak', async () => {
  const f = fixture('particles');
  const small = decode(f.input);
  const img = { width: 200, height: 200, data: new Uint8Array(200 * 200).map((v, i) => ((i * 7919) % 13 < 4 ? 255 : 0)) };
  const o = { calibration: { pixelWidth: 1, pixelHeight: 1 } };
  const sync = ctx.IJParticles.analyze(img.data, img.width, img.height, Object.assign({}, o));
  let steps = 0, last = -1;
  const asy = await ctx.IJParticles.analyzeAsync(img.data, img.width, img.height, Object.assign({}, o), (fr) => { steps++; assert.ok(fr >= last && fr <= 1); last = fr; return Promise.resolve(); });
  const sig = (r) => JSON.parse(JSON.stringify(r.particles.map((p) => [p.areaPx, p.perimeter, p.xCentroid, p.yStart])));
  assert.deepEqual(sig(asy), sig(sync));
  assert.ok(sync.particles.length > 20);
  assert.ok(steps >= 2, 'a 200 x 200 image yields every 16384 pixels scanned or filled: ' + steps);
  let again = 0;
  await ctx.IJParticles.analyzeAsync(img.data, img.width, img.height, Object.assign({}, o), () => { again++; });
  assert.equal(again, steps, 'the same yield points on every run');
  let none = 0;
  await ctx.IJParticles.analyzeAsync(small.data, small.width, small.height, Object.assign({}, o), () => { none++; });
  assert.equal(none, 0, 'a 72 x 56 image never reaches the first yield');
  // a throw from the step stops the analysis (this is how a cancel reaches the scan)
  let seen = 0;
  await assert.rejects(() => ctx.IJParticles.analyzeAsync(img.data, img.width, img.height, Object.assign({}, o), () => { seen++; throw Object.assign(new Error('cancelled'), { code: 'IJ_CANCELLED' }); }), (e) => e.code === 'IJ_CANCELLED');
  assert.equal(seen, 1, 'stopped at the first yield');
  // a 1 x n image with one big particle: the pixel list and the flood-fill stack reach their doubled sizes
  const w = 300, h = 300, big = new Uint8Array(w * h).fill(255);
  let maxPix = 0;
  ctx.IJParticles.analyze(big, w, h, { sink: (rec, pix, np) => { maxPix = Math.max(maxPix, np); } });
  assert.equal(maxPix, w * h);
  const n = w * h, p2 = 131072;
  assert.ok(ctx.IJParticles.scratchBytes(w, h, {}) >= n * 2 + 2 * 6 * p2, 'work + out + (pix + stack at 6 x the next power of two)');
  assert.ok(ctx.IJParticles.scratchBytes(w, h, { counts: true, roi: true, ellipses: true }) > ctx.IJParticles.scratchBytes(w, h, {}) + 3 * n - 1);
});

await test('IJParticles.perimeterOf (Composite ROIs): the filter and the perimeter read the hook\'s length', () => {
  const w = 20, h = 12, d = new Uint8Array(w * h);
  for (let y = 2; y < 10; y++) for (let x = 2; x < 10; x++) d[y * w + x] = 255;
  for (let y = 4; y < 8; y++) for (let x = 4; x < 8; x++) d[y * w + x] = 0;
  const plain = ctx.IJParticles.analyze(d, w, h, {}).particles;
  near(plain[0].perimeter, 32 - 4 * (2 - Math.SQRT2), 1e-12, 'traced');
  const T = ctx.IJRoiTools;
  const hook = (outline, pix, np, rect, pw, ph) => {
    const sub = new Uint8Array(rect.w * rect.h);
    for (let k = 0; k < np; k++) { const px = pix[k], x = px % w, y = (px - x) / w; sub[(y - rect.y) * rect.w + (x - rect.x)] = 1; }
    return T.maskPerimeter({ type: 'mask', x: rect.x, y: rect.y, w: rect.w, h: rect.h, rle: Uint32Array.from(ctx.IJRoi.rleEncode(sub)) }, pw, ph);
  };
  const comp = ctx.IJParticles.analyze(d, w, h, { perimeterOf: hook }).particles;
  const corner = 2 - Math.SQRT2;
  near(comp[0].perimeter, (32 - 4 * corner) + (16 - 4 * corner), 1e-12, 'the outline plus the hole, each traced (ImageJ 1.54p: 43.3137)');
  near(comp[0].circularity, 4 * Math.PI * 48 / (comp[0].perimeter * comp[0].perimeter), 1e-12);
  assert.equal(ctx.IJParticles.analyze(d, w, h, { perimeterOf: hook, minCirc: 0.5 }).particles.length, 0, 'the filter reads the perimeter of the hook (0.32 < 0.5)');
  assert.equal(ctx.IJParticles.analyze(d, w, h, { minCirc: 0.5 }).particles.length, 1, 'the traced one passes (0.69)');
});

await test('Histogram statistics against ImageStatistics (16 and 32-bit goldens, ranges, NaN pixels)', () => {
  const f = fixture('histogram');
  const imgs = { 16: decode(f.input), 32: decode(f.input32) };
  const IJOps = ctx.IJOps;
  for (const c of f.cases) {
    const img = imgs[c.bitDepth];
    const o = { bins: c.params.bins, histMin: c.params.xMin, histMax: c.params.xMax };
    const st = A.histogramStats(img, null, o);
    const tag = `${c.bitDepth}-bit ${JSON.stringify(c.params)}`;
    assert.equal(st.n, c.pixelCount, tag + ' count');
    assert.equal(st.maxCount, c.maxCount, tag + ' modal count');
    if (c.mean === null) assert.ok(Number.isNaN(st.mean), tag + ' mean NaN'); else near(st.mean, c.mean, 1e-9, tag + ' mean');
    near(st.dmode, c.mode, 1e-9, tag + ' mode');
    // the engine histogram the window draws is the golden histogram
    const h = IJOps.histogram(img, null, { bins: c.params.bins, min: c.params.xMin || c.params.xMax ? c.params.xMin : undefined, max: c.params.xMin || c.params.xMax ? c.params.xMax : undefined });
    assert.ok(sameArr(Array.from(h.counts), c.histogram), tag + ' bins');
  }
  // an 8-bit image: the 256 bins of the values, the standard deviation of n - 1
  const b = { width: 4, height: 1, bitDepth: 8, data: new Uint8Array([10, 10, 20, 30]) };
  const s8 = A.histogramStats(b, null, {});
  assert.equal(s8.n, 4); assert.equal(s8.dmode, 10); assert.equal(s8.maxCount, 2); near(s8.mean, 17.5, 1e-12); near(s8.stdDev, Math.sqrt(((7.5 ** 2) * 2 + 2.5 ** 2 + 12.5 ** 2) / 3), 1e-12);
  const m = { x: 1, y: 0, w: 2, h: 1, data: new Uint8Array([1, 0]) };
  assert.equal(A.histogramStats(b, m, {}).n, 1, 'a selection mask limits the pixels');
});

// ── the engine: doc.particles, particleImage, doc.stats Invert Y, doc.profile, doc.histogram ──
const t = await boot({ channels: 1 });
const W = await t.spawn();
const E = (c, a) => t.engine(c, a, W);
const jeq = (a, b, m) => assert.deepEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)), m);
const importDoc = async (img, cal, name) => {
  const r = await E('doc.import', { image: { name: name || 'p', width: img.width, height: img.height, bitDepth: img.bitDepth, calibration: cal || { pixelWidth: 1, pixelHeight: 1, unit: 'pixel' }, channels: [{ name: 'c', color: '#ffffff', data: img.data.slice() }] } });
  return r.info.docId;
};
const KEYS = ['area', 'mean', 'stdDev', 'mode', 'min', 'max', 'xCentroid', 'yCentroid', 'xCenterOfMass', 'yCenterOfMass', 'perim', 'bx', 'by', 'bw', 'bh', 'major', 'minor', 'angle',
  'circularity', 'feret', 'intDen', 'median', 'skewness', 'kurtosis', 'areaFraction', 'rawIntDen', 'feretX', 'feretY', 'feretAngle', 'minFeret', 'aspectRatio', 'roundness', 'solidity'];
const COL = { area: 'Area', mean: 'Mean', stdDev: 'StdDev', mode: 'Mode', min: 'Min', max: 'Max', xCentroid: 'X', yCentroid: 'Y', xCenterOfMass: 'XM', yCenterOfMass: 'YM', perim: 'Perim.',
  bx: 'BX', by: 'BY', bw: 'Width', bh: 'Height', major: 'Major', minor: 'Minor', angle: 'Angle', circularity: 'Circ.', feret: 'Feret', intDen: 'IntDen', median: 'Median', skewness: 'Skew',
  kurtosis: 'Kurt', areaFraction: '%Area', rawIntDen: 'RawIntDen', feretX: 'FeretX', feretY: 'FeretY', feretAngle: 'FeretAngle', minFeret: 'MinFeret', aspectRatio: 'AR', roundness: 'Round', solidity: 'Solidity', xStart: 'XStart', yStart: 'YStart' };
const optsOf = (p) => {
  const o = { minCirc: p.minCirc, maxCirc: p.maxCirc };
  if (p.minSize) o.minSize = p.minSize;
  if (Number.isFinite(p.maxSize)) o.maxSize = p.maxSize;
  if (p.options & 8) o.excludeEdges = true;
  if (p.options & 1024) o.includeHoles = true;
  return o;
};
const compareTable = (rows, table, tag) => {
  assert.equal(rows.length, table.rows.length, tag + ' count');
  table.rows.forEach((ref, i) => {
    table.headings.forEach((h, k) => {
      const key = Object.keys(COL).find((x) => COL[x] === h);
      const v = rows[i][key], r = ref[k];
      if (r === null) { assert.ok(v === null || v === undefined || Number.isNaN(v), `${tag} row ${i} ${h}: NaN expected, got ${v}`); return; }
      near(v, r, h === 'Round' || h === 'AR' ? 1e-6 : 1e-9, `${tag} row ${i} ${h}`);
    });
  });
};

await test('doc.particles: every column of the golden table, the filters, Exclude on edges, Include holes, Record starts', async () => {
  const f = fixture('particles');
  const id = await importDoc(decode(f.input));
  for (const c of f.cases.filter((x) => ['default', 'size_20_300', 'circ_0p6_1', 'exclude_edges', 'include_holes', 'record_starts', 'show_masks', 'show_count_masks_exclude_edges'].includes(x.name))) {
    const res = await E('doc.particles', { docId: id, channel: 0, opts: optsOf(c.params), keys: KEYS });
    compareTable(res.rows, c.result.table, c.name);
    assert.equal(res.summary.count, c.result.count);
  }
  // Record starts: the first pixel of every particle in raster order, which is the Wand start ImageJ records (XStart / YStart)
  const img = decode(f.input);
  const res = await E('doc.particles', { docId: id, channel: 0, opts: {}, keys: ['area'] });
  for (const r of res.rows) {
    assert.equal(img.data[r.yStart * img.width + r.xStart], 255, 'the start pixel belongs to the particle');
    assert.ok(r.xStart === 0 || img.data[r.yStart * img.width + r.xStart - 1] === 0 || r.areaPx > 0);
  }
  assert.ok(res.rows.every((r, i, a) => i === 0 || a[i - 1].yStart < r.yStart || (a[i - 1].yStart === r.yStart && a[i - 1].xStart < r.xStart)), 'in raster order of the start');
});

await test('doc.particles on a calibrated image: sizes in unit^2 (Pixel units off), calibrated columns', async () => {
  const f = fixture('particles_calibrated');
  const id = await importDoc(decode(f.input), { pixelWidth: 0.5, pixelHeight: 0.5, unit: 'um' });
  for (const c of f.cases) {
    // the golden's ParticleAnalyzer constructor takes its minimum in PIXELS (its call text says calibrated units, the constructor says "in pixels")
    const res = await E('doc.particles', { docId: id, channel: 0, opts: c.params.minSize ? { minSize: c.params.minSize } : {}, keys: KEYS });
    assert.equal(res.rows.length, c.result.count, 'minSize ' + c.params.minSize);
    compareTable(res.rows, c.result.table, 'calibrated ' + c.params.minSize);
  }
  // 5 um^2 at 0.5 um per pixel = 20 pixels: Size (unit^2) without "Pixel units"
  const um = await E('doc.particles', { docId: id, channel: 0, opts: { minSize: 5, unit: 'um2' }, keys: ['area'] });
  assert.deepEqual(Array.from(um.rows.map((r) => r.areaPx)), [30, 351, 112, 184]);
});

await test('particleImage: Outlines, Bare Outlines, Ellipses, Masks (inverted LUT) and Count Masks match the ImageJ images', async () => {
  const f = fixture('particles');
  const id = await importDoc(decode(f.input), undefined, 'p');
  for (const c of f.cases.filter((x) => x.result.output)) {
    const show = { Outlines: 'outlines', 'Bare Outlines': 'bareOutlines', Ellipses: 'ellipses', Masks: 'masks', 'Count Masks': 'countMasks' }[c.params.show];
    const run = await E('doc.run', { docId: id, op: 'particleImage', params: { show, opts: optsOf(c.params) }, roi: null, channel: 0 });
    assert.equal(run.newDocIds.length, 1);
    const info = run.newInfos[0];
    assert.equal(info.name, c.result.outputTitle.replace(/ p$/, '') + ' p', c.name + ' title');
    const ref = decode(c.result.output);
    assert.equal(info.bitDepth, ref.bitDepth, c.name + ' depth');
    assert.equal(info.channels[0].display.invert === true, c.result.outputInvertedLut === true, c.name + ' inverted LUT');
    const px = (await E('doc.tile', { docId: run.newDocIds[0], channel: 0, level: 0, tx: 0, ty: 0 })).data;
    if (show === 'outlines') {
      // the labels are text pixels in ImageJ (value 1, Java's font): only the outline pixels (0) and the page (255) are compared
      let bad = 0;
      for (let i = 0; i < px.length; i++) if (ref.data[i] !== 1 && px[i] !== ref.data[i]) bad++;
      assert.equal(bad, 0, c.name + ' outline pixels');
    } else assert.ok(sameArr(px, ref.data), c.name + ' pixels');
  }
  // a selection limits the analysis (the particles inside) and the image is a new document: the source is untouched
  const src = (await E('doc.tile', { docId: id, channel: 0, level: 0, tx: 0, ty: 0 })).data.slice();
  const run = await E('doc.run', { docId: id, op: 'particleImage', params: { show: 'countMasks', opts: {} }, roi: { type: 'rect', x: 0, y: 0, w: 36, h: 30 }, channel: 0 });
  const lab = (await E('doc.tile', { docId: run.newDocIds[0], channel: 0, level: 0, tx: 0, ty: 0 })).data;
  assert.ok(Math.max(...lab) >= 1 && lab.every((v, i) => v === 0 || src[i] === 255));
  assert.ok(sameArr((await E('doc.tile', { docId: id, channel: 0, level: 0, tx: 0, ty: 0 })).data, src), 'the source is not modified');
  const bad = await E('doc.run', { docId: id, op: 'particleImage', params: { show: 'nope' }, roi: null, channel: 0 }).catch((e) => e);
  assert.equal(bad.code, 'IJ_BAD_ARGS');
});

await test('Composite ROIs: a particle with a hole carries its pixels as a mask selection; Include holes does not', async () => {
  const w = 12, h = 12, d = new Uint8Array(w * h);
  for (let y = 2; y < 10; y++) for (let x = 2; x < 10; x++) d[y * w + x] = 255;
  for (let y = 4; y < 8; y++) for (let x = 4; x < 8; x++) d[y * w + x] = 0;   // a 4 x 4 hole
  d[5 * w + 5] = 255; d[6 * w + 6] = 255;                                      // an island in the hole
  const id = await importDoc({ width: w, height: h, bitDepth: 8, data: d });
  const res = await E('doc.particles', { docId: id, channel: 0, opts: {}, keys: ['area'], composite: true });
  assert.equal(res.rows.length, 2, 'the ring and the island');
  const ring = res.rows[0];
  assert.equal(ring.area, 64 - 16);
  assert.equal(ring.maskRoi.type, 'mask');
  assert.deepEqual([ring.maskRoi.x, ring.maskRoi.y, ring.maskRoi.w, ring.maskRoi.h], [2, 2, 8, 8]);
  assert.ok(!res.rows[1].maskRoi, 'the island has no hole');
  const noHoles = await E('doc.particles', { docId: id, channel: 0, opts: { includeHoles: true }, keys: ['area'], composite: true });
  assert.equal(noHoles.rows.length, 1);
  assert.ok(!noHoles.rows[0].maskRoi, 'Composite ROIs is ignored with Include holes (ParticleAnalyzer: "compositeRois && floodFill")');
  const plain = await E('doc.particles', { docId: id, channel: 0, opts: {}, keys: ['area'] });
  assert.ok(!plain.rows[0].maskRoi);
});

await test('doc.particles: Cancel stops the scan (progress is posted, the analysis yields), the reserved scratch is given back, the document is untouched', async () => {
  const w = 1200, h = 1200;
  const data = new Uint8Array(w * h).map((v, i) => ((i * 7919) % 13 < 4 ? 255 : 0));
  const id = await importDoc({ width: w, height: h, bitDepth: 8, data });
  const orig = W.far.postMessage;
  let sent = 0, progress = 0;
  W.far.postMessage = function (m) {
    if (m && m.event === 'progress' && m.stepKey === 'op.particles') {
      progress++;
      if (!sent) { sent = 1; W.far.onmessage({ data: { id: 9101, cmd: 'cancel', args: { targetId: m.id } } }); }
    }
    return orig.apply(W.far, arguments);
  };
  try {
    await assert.rejects(() => E('doc.particles', { docId: id, channel: 0, opts: {}, keys: ['area'], measureImage: false }), (e) => e.code === 'IJ_CANCELLED');
  } finally { W.far.postMessage = orig; }
  assert.equal(sent, 1, 'the analysis yielded and posted its progress while it ran');
  assert.ok(progress >= 1);
  const info = await E('doc.info', { docId: id });
  assert.equal(info.rev, 0); assert.equal(info.undoDepth, 0);
  // the scratch is released: the same request, not cancelled, now succeeds
  const ok = await E('doc.particles', { docId: id, channel: 0, opts: { minSize: 1e9 }, keys: ['area'], measureImage: false });
  assert.equal(ok.summary.count, 0);
});

await test('doc.particles: the threshold range is the analysed pixels, requireBinary refuses a grey image, Composite ROIs perimeters come from the particle\'s selection', async () => {
  const wd = 30, ht = 20, d = new Uint8Array(wd * ht).fill(10);
  for (let y = 2; y < 6; y++) for (let x = 2; x < 6; x++) d[y * wd + x] = 200;
  for (let y = 10; y < 14; y++) for (let x = 10; x < 15; x++) d[y * wd + x] = 120;
  const id = await importDoc({ width: wd, height: ht, bitDepth: 8, data: d });
  const bad = await E('doc.particles', { docId: id, channel: 0, opts: {}, keys: ['area'], requireBinary: true }).catch((e) => e);
  assert.equal(bad.code, 'IJ_PARTICLES_THRESHOLD');
  const t1 = await E('doc.particles', { docId: id, channel: 0, opts: {}, keys: ['area', 'mean'], threshold: { lower: 100, upper: 255 }, requireBinary: true });
  jeq(t1.rows.map((r) => r.area), [16, 20], 'the two blobs; the background (10) is outside the range');
  jeq(t1.rows.map((r) => r.mean), [200, 120], 'measured on the grey values');
  const t2 = await E('doc.particles', { docId: id, channel: 0, opts: {}, keys: ['area'], threshold: { lower: 150, upper: 255 } });
  jeq(t2.rows.map((r) => r.area), [16]);
  // without a threshold and without the flag every non-zero pixel is foreground (the historical rule of the engine)
  const t3 = await E('doc.particles', { docId: id, channel: 0, opts: {}, keys: ['area'] });
  assert.equal(t3.rows.length, 1, 'one particle: the whole non-zero image');
  // Composite ROIs on a ring: Perim. = traced outline + traced hole (ImageJ 1.54p: 43.3137), Circ. from it
  const ring = new Uint8Array(wd * ht);
  for (let y = 2; y < 10; y++) for (let x = 2; x < 10; x++) ring[y * wd + x] = 255;
  for (let y = 4; y < 8; y++) for (let x = 4; x < 8; x++) ring[y * wd + x] = 0;
  const rid = await importDoc({ width: wd, height: ht, bitDepth: 8, data: ring });
  const plain = await E('doc.particles', { docId: rid, channel: 0, opts: {}, keys: ['area', 'perim', 'circularity'] });
  near(plain.rows[0].perim, 32 - 4 * (2 - Math.SQRT2), 1e-12);
  const comp = await E('doc.particles', { docId: rid, channel: 0, opts: {}, keys: ['area', 'perim', 'circularity'], composite: true });
  near(comp.rows[0].perim, 48 - 8 * (2 - Math.SQRT2), 1e-12, 'perim (43.3137)');
  near(comp.rows[0].perimeter, 48 - 8 * (2 - Math.SQRT2), 1e-12, 'the particle\'s own perimeter');
  near(comp.rows[0].circularity, 4 * Math.PI * 48 / ((48 - 8 * (2 - Math.SQRT2)) ** 2), 1e-12);
  const filtered = await E('doc.particles', { docId: rid, channel: 0, opts: { minCirc: 0.5 }, keys: ['area'], composite: true });
  assert.equal(filtered.rows.length, 0, 'the circularity filter reads the composite perimeter');
  // the Show: image op takes the same threshold and numbers from rowOffset
  const run = await E('doc.run', { docId: id, op: 'particleImage', params: { show: 'countMasks', opts: {}, threshold: { lower: 100, upper: 255 }, rowOffset: 4 }, roi: null, channel: 0 });
  const nd = run.newDocIds[0];
  const px = Array.from((await E('doc.tile', { docId: nd, channel: 0, level: 0, tx: 0, ty: 0 })).data);
  jeq([...new Set(px)].sort((a, b) => a - b), [0, 5, 6], 'Count Masks levels continue at rt.size() = 4 + the particle number');
  // a "newdoc" op leaves the source alone and the new image starts at its own baseline: there is nothing to undo on either, and the engine says so
  const srcInfo = await E('doc.info', { docId: id });
  assert.equal(srcInfo.undoDepth, 0, 'the source image has no step added');
  const newInfo = await E('doc.info', { docId: nd });
  assert.equal(newInfo.undoDepth, 0); assert.equal(newInfo.rev, 0);
  const noUndo = await E('doc.undo', { docId: nd }).catch((e) => e);
  assert.equal(noUndo.code, 'IJ_NOTHING_TO_UNDO');
  assert.equal((await E('doc.info', { docId: nd })).bitDepth, 16, 'the new image is intact after the refused undo');
});

await test('Set Measurements › Invert Y coordinates: Y, YM and BY become (height - 1) * pixelHeight - value; FeretY and X do not move', async () => {
  const f = fixture('invert_y');
  // the golden's invertY:false rows are the baseline; the flag is the Calibration.getY formula (the golden's invertY:true rows equal them because its driver
  // never set the global flag Calibration.getY reads — see the fixture notes in the reply)
  const base = f.cases.filter((c) => c.name === 'rect' && !c.params.invertY);
  const pix = new Uint8Array(64 * 48).map((v, i) => (i * 7 + (i >> 6) * 3) % 251);
  for (const cal of [{ pixelWidth: 1, pixelHeight: 1, unit: 'pixel' }, { pixelWidth: 0.5, pixelHeight: 0.5, unit: 'um' }]) {
    const id = await importDoc({ width: 64, height: 48, bitDepth: 8, data: pix }, cal);
    const roi = { type: 'rect', x: 10, y: 8, w: 30, h: 20 };
    const keys = ['area', 'xCentroid', 'yCentroid', 'xCenterOfMass', 'yCenterOfMass', 'bx', 'by', 'bw', 'bh', 'feret', 'feretX', 'feretY'];
    const a = (await E('doc.stats', { docId: id, roi, channel: 0, measurements: keys })).row;
    const b = (await E('doc.stats', { docId: id, roi, channel: 0, measurements: keys, invertY: true })).row;
    const top = 47 * cal.pixelHeight;
    for (const k of ['yCentroid', 'yCenterOfMass', 'by']) near(b[k], top - a[k], 1e-12, k);
    for (const k of ['xCentroid', 'xCenterOfMass', 'bx', 'bw', 'bh', 'area', 'feret', 'feretX', 'feretY']) assert.equal(b[k], a[k], k + ' unchanged');
    // a point and a line
    const pRoi = { type: 'point', points: [[5.5, 7.5]] };
    const p0 = (await E('doc.stats', { docId: id, roi: pRoi, channel: 0, measurements: ['xCentroid', 'yCentroid'] })).row;
    const p = (await E('doc.stats', { docId: id, roi: pRoi, channel: 0, measurements: ['xCentroid', 'yCentroid'], invertY: true })).row;
    near(p.yCentroid, (48 - p0.yCentroid / cal.pixelHeight - 1) * cal.pixelHeight, 1e-12, 'point Y = (H - y - 1) * ph');
  }
  assert.equal(base.length, 2);
});

await test('doc.profile: a rectangle (column / row average), interpolation off, lines unchanged', async () => {
  const f = fixture('profile');
  const img = decode(f.input8);
  const id = await importDoc(img);
  const r1 = await E('doc.profile', { docId: id, line: { type: 'rect', x: 5, y: 4, w: 20, h: 14 }, channel: 0 });
  const ref = f.cases.find((c) => c.bitDepth === 8 && c.name === 'rect' && !c.params.vertical && !c.params.interpolate).result.profile;
  assert.equal(r1.values.length, 20);
  for (let i = 0; i < 20; i++) near(r1.values[i], ref[i], 1e-9);
  const r2 = await E('doc.profile', { docId: id, line: { type: 'rect', x: 5, y: 4, w: 20, h: 14 }, channel: 0, vertical: true });
  assert.equal(r2.values.length, 14);
  const nearest = await E('doc.profile', { docId: id, line: { type: 'line', x1: 4, y1: 30, x2: 40, y2: 6, width: 1 }, channel: 0, interpolate: false });
  const refN = f.cases.find((c) => c.bitDepth === 8 && c.name === 'line_w1' && !c.params.interpolate).result.profile;
  assert.equal(nearest.values.length, refN.length);
  for (let i = 0; i < refN.length; i++) near(nearest.values[i], refN[i], 1e-9);
  const bad = await E('doc.profile', { docId: id, line: { type: 'oval', x: 1, y: 1, w: 4, h: 4 }, channel: 0 }).catch((e) => e);
  assert.equal(bad.code, 'IJ_BAD_ROI');
});

await test('doc.histogram carries the numbers of the histogram window; a custom range is the golden range', async () => {
  const f = fixture('histogram');
  const id16 = await importDoc(decode(f.input));
  const c = f.cases.find((x) => x.bitDepth === 16 && x.params.bins === 100 && x.params.xMin === 5000);
  const r = await E('doc.histogram', { docId: id16, roi: null, channel: 0, bins: 100, min: 5000, max: 40000 });
  assert.ok(sameArr(Array.from(r.counts), c.histogram));
  assert.equal(r.stats.n, c.pixelCount); near(r.stats.mean, c.mean, 1e-9); assert.equal(r.stats.dmode, c.mode);
  const r8 = await E('doc.histogram', { docId: await importDoc({ width: 2, height: 2, bitDepth: 8, data: new Uint8Array([1, 2, 2, 9]) }), roi: null, channel: 0, bins: 256 });
  assert.equal(r8.stats.n, 4); assert.equal(r8.stats.dmode, 2);
});

t.close();
console.log(`ij ana (pure + engine): OK (${passed} groups)`);
process.exit(0);
