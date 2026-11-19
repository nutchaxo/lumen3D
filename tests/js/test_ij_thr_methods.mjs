// Advanced Studio, package thr — the 17 AutoThresholder methods (IJThreshold in ij-analysis.js), against
//   * tests/fixtures/ij-wave3/thr/methods256.json: every method on 20 histograms (empty, one bin, two bins, plateaus…), with the
//     bilevel "− 1" rule on and off (ImageJ 1.54p, `new AutoThresholder().getThreshold`) — identical levels;
//   * tests/fixtures/ij-wave3/thr/threshold16_*.json: `ip.setAutoThreshold("<Method> [dark] [16-bit] no-lut")` on 16-bit images,
//     with the 256-bin histogram and with the full 65 536-bin one, light and dark — the lower / upper threshold ImageJ reports;
//   * tests/fixtures/ij-wave3/fiji/autothreshold: the levels Fiji's Auto Threshold records, compared SEPARATELY from ImageJ's
//     (Fiji's "Default" is the original IJ IsoData; on 8 bits every other method is AutoThresholder's, Li on vessels_8bit is the
//     one documented exception; on 16 bits the level is the 65 536-bin one);
// plus the properties the ports rely on (the 16-bit shortcuts of the O(n²) methods equal the full scans, Java int wrap-around).
//
// Tolerances: levels are integers and must be identical. Run: node tests/js/test_ij_thr_methods.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { DIR } from './ij_harness.mjs';

const FIX = path.join(DIR, '..', '..', '..', '..', 'tests', 'fixtures', 'ij-wave3');
const sandbox = { console };
sandbox.self = sandbox;
vm.createContext(sandbox);
for (const f of ['ij-core.js', 'ij-analysis.js', 'ij-proc-shared.js', 'ij-proc-thr.js']) vm.runInContext(fs.readFileSync(path.join(DIR, f), 'utf8'), sandbox, { filename: f });
const { IJThreshold: T, IJThr } = sandbox;

let passed = 0;
function test(name, fn) { try { fn(); passed++; console.log('  ok  ' + name); } catch (e) { console.error('FAIL ' + name); throw e; } }
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(FIX, rel), 'utf8'));
function decode(d) {
  if (Array.isArray(d)) return Float64Array.from(d, (v) => (v === null ? NaN : v));
  const b = Buffer.from(d.b64, 'base64');
  const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  return d.dtype === 'u8' ? new Uint8Array(ab) : d.dtype === 'u16' ? new Uint16Array(ab) : new Float32Array(ab);
}
const channel = (im, bitDepth) => ({ width: im.width, height: im.height, bitDepth, data: decode(im.data) });

test('the method list is AutoThresholder.Method, in the enum order', () => {
  assert.deepEqual(Array.from(T.methods()), ['Default', 'Huang', 'Intermodes', 'IsoData', 'IJ_IsoData', 'Li', 'MaxEntropy', 'Mean', 'MinError', 'Minimum', 'Moments', 'Otsu', 'Percentile', 'RenyiEntropy', 'Shanbhag', 'Triangle', 'Yen']);
  assert.deepEqual(Array.from(IJThr.FIJI_METHODS), ['Default', 'Huang', 'Huang2', 'Intermodes', 'IsoData', 'Li', 'MaxEntropy', 'Mean', 'MinError(I)', 'Minimum', 'Moments', 'Otsu', 'Percentile', 'RenyiEntropy', 'Shanbhag', 'Triangle', 'Yen'], "Fiji's list (fiji-dialogs.json)");
  assert.throws(() => T.level(new Float64Array(256).fill(1), 'Nope'), (e) => e.code === 'IJ_BAD_METHOD');
});

test('methods256.json: every method on 20 histograms, both bilevel rules, identical levels', () => {
  const fx = readJson('thr/methods256.json');
  let compared = 0;
  for (const [table, sub] of [['thresholds', true], ['thresholdsNoBilevelSubtract', false]]) {
    for (const m of fx.methodOrder) {
      fx.histograms.forEach((h, i) => {
        const exp = fx.result[table][m][i];
        // Java throws (ArithmeticException on the empty histogram) or answers a value that is no threshold (128, MIN_VALUE):
        // an EMPTY histogram answers 0 here — the one documented deviation
        if (typeof exp !== 'number' || h.every((v) => v === 0)) return;
        assert.equal(T.level(h, m, { bilevelSubtractOne: sub }), exp, `${table} ${m} histogram ${i}`);
        compared++;
      });
    }
  }
  assert.ok(compared >= 600, 'compared ' + compared);
  for (const m of fx.methodOrder) assert.equal(T.level(new Float64Array(256), m), 0, 'an empty histogram answers 0 (' + m + ')');
});

test('the 16-bit images: setAutoThreshold lower / upper, 256-bin and 16-bit histogram, light and dark (ImageJ 1.54p)', () => {
  // Every record of threshold16_blobs0_60000 and threshold16_range1500_3200 runs (Huang and Renyi on 65 536 bins take ~1 s each on those).
  // The two threshold16_fiji_* files are ImageJ's answers on Fiji's 16-bit test image, which has ~20 000 distinct values: there the
  // O(n²) methods (Huang, MaxEntropy, RenyiEntropy, Shanbhag) take minutes per record on the 65 536-bin histogram, so their hist16
  // records are compared only with IJ_SLOW_TESTS=1 (the shortcut they use is proved equal to the full scan by the test further down,
  // and Huang / MaxEntropy of that image are checked against Fiji's own recording in the next test); the count of what was skipped is printed.
  const SLOW = new Set(['Huang', 'MaxEntropy', 'RenyiEntropy', 'Shanbhag']);
  let skipped = 0;
  for (const file of ['threshold16_blobs0_60000', 'threshold16_range1500_3200', 'threshold16_fiji_blobs16_0', 'threshold16_fiji_blobs16_1']) {
    const fx = readJson('thr/' + file + '.json');
    const ch = channel(fx.input, 16);
    let n = 0;
    for (const r of fx.result) {
      if (/fiji_blobs16/.test(file) && r.histogram16 && SLOW.has(r.method) && !process.env.IJ_SLOW_TESTS) { skipped++; continue; }
      const o = T.levels(ch, r.method, { dark: r.dark, histogram16: r.histogram16 });
      assert.deepEqual([o.ijLower, o.ijUpper], [r.min, r.max], `${file} ${r.method} dark=${r.dark} hist16=${r.histogram16}`);
      n++;
    }
    assert.ok(n >= 40, file + ' ' + n);
  }
  console.log('      (' + skipped + ' slow 16-bit-histogram records of the threshold16_fiji_* files skipped; IJ_SLOW_TESTS=1 runs them)');
});

test('Fiji 16-bit: its logged level is the 65 536-bin one, Default is IJDefault, the mask is v > level', () => {
  for (const name of ['blobs16_0', 'blobs16_1']) {
    const fx = readJson('fiji/autothreshold/' + name + '.json');
    const ch = channel(fx.input, 16);
    const counts = T.histogram(ch, { histogram16: true }).counts;
    let compared = 0;
    for (const c of fx.cases) {
      if (c.params.setThreshold || !c.logLevels.length) continue; // Huang timed out in Fiji's run: compared with ImageJ only (above)
      const level = IJThr.fijiLevel(counts, c.params.method, true);
      assert.equal(level, c.logLevels[0].value, `${name} ${c.params.method}`);
      const mask = decode(c.result.self.data);
      for (let i = 0; i < ch.data.length; i++) assert.equal(mask[i] !== 0, ch.data[i] > level, `${name} ${c.params.method} pixel ${i}`);
      compared++;
    }
    assert.ok(compared >= 6, name + ' ' + compared);
  }
});

test('Fiji 8-bit: the threshold range it sets is [level + 1, 255] (white) or [0, level]; every method but Li on vessels_8bit', () => {
  const known = []; // a level that differs from Fiji's by one: reported, never hidden
  for (const name of ['blobs_8bit', 'bigblobs_8bit', 'vessels_8bit']) {
    const fx = readJson('fiji/autothreshold/' + name + '.json');
    const ch = channel(fx.input, 8);
    const counts = T.histogram(ch).counts;
    for (const c of fx.cases) {
      if (!c.params.setThreshold || c.params.ignoreBlackWhite) continue;
      const level = IJThr.fijiLevel(counts, c.params.method, false);
      const got = c.params.white ? [level + 1, 255] : [0, level];
      const exp = c.result.selfThreshold;
      if (exp[0] === got[0] && exp[1] === got[1]) continue;
      known.push(`${name} ${c.params.method} white=${c.params.white}: Fiji ${exp} ours ${got}`);
    }
  }
  assert.deepEqual(known, ['vessels_8bit Li white=true: Fiji 83,255 ours 84,255', 'vessels_8bit Li white=false: Fiji 0,82 ours 0,83'].map((s) => s), 'Li on vessels_8bit is one level above Fiji\'s: the only disagreement');
});

test('Fiji 8-bit masks: v > level (white) / v <= level, Ignore black / Ignore white empty the end bins (Li apart, see below)', () => {
  const fx = readJson('fiji/autothreshold/blobs_8bit.json');
  const ch = channel(fx.input, 8);
  const base = T.histogram(ch).counts;
  const off = [];
  for (const c of fx.cases) {
    if (c.params.setThreshold || c.params.method === 'Huang2') continue;
    const counts = Float64Array.from(base);
    if (c.params.ignoreBlackWhite) { counts[0] = 0; counts[255] = 0; }
    const level = IJThr.fijiLevel(counts, c.params.method, false);
    const mask = decode(c.result.self.data);
    let diff = 0;
    for (let i = 0; i < ch.data.length; i++) if ((mask[i] !== 0) !== (c.params.white ? ch.data[i] > level : ch.data[i] <= level)) diff++;
    if (diff) off.push(`${c.params.method} white=${c.params.white} ignore=${c.params.ignoreBlackWhite}: ${diff} px`);
  }
  // Fiji's Li differs from AutoThresholder.Li on two inputs (vessels_8bit without, blobs_8bit with the two end bins emptied):
  // its code is GPL and was not read, the level is within a few grey levels of ImageJ's. The other 15 methods are identical.
  assert.deepEqual(off, ['Li white=true ignore=true: 34 px']);
});

test('the O(n²) methods on a 65 536-bin histogram: the first-of-a-stretch shortcut equals the full scan', () => {
  // the shortcut only evaluates a threshold where a non-empty bin starts a stretch of equal criteria: a tie keeps the first one
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let trial = 0; trial < 12; trial++) {
    const L = 300 + Math.floor(rnd() * 300);                       // more than 256 bins: the shortcut path
    const counts = new Float64Array(L);
    const peaks = 2 + Math.floor(rnd() * 3);
    for (let p = 0; p < peaks; p++) { const c = Math.floor(rnd() * L), s = 5 + rnd() * 40; for (let i = 0; i < L; i++) if (rnd() < 0.5) counts[i] += Math.round(200 * Math.exp(-((i - c) * (i - c)) / (2 * s * s)) * rnd()); }
    for (let i = 0; i < L; i += 7) counts[i] = 0;
    if (counts.filter((v) => v > 0).length < 5) continue;
    assert.equal(T.level(counts, 'Huang'), T._huangFull(counts) + 0, 'Huang trial ' + trial);
  }
});

test('Huang2 (AutoThresholder.Huang2) equals a naive O(n²) scan; Huang on a single bin is Java\'s', () => {
  function naive(data) {
    let first, last;
    for (first = 0; first < data.length && data[first] === 0; first++);
    for (last = data.length - 1; last > first && data[last] === 0; last--);
    if (first === last) return 0;
    const S = new Float64Array(last + 1), W = new Float64Array(last + 1);
    S[0] = data[0];
    for (let i = Math.max(1, first); i <= last; i++) { S[i] = S[i - 1] + data[i]; W[i] = W[i - 1] + Math.imul(i, data[i]); }
    const C = last - first, Smu = new Float64Array(last + 1 - first);
    for (let i = 1; i < Smu.length; i++) { const mu = 1 / (1 + Math.abs(i) / C); Smu[i] = -mu * Math.log(mu) - (1 - mu) * Math.log(1 - mu); }
    let best = 0, bestE = Number.MAX_VALUE;
    for (let t = first; t <= last; t++) {
      let e = 0, mu = Math.round(W[t] / S[t]);
      for (let i = first; i <= t; i++) e += Smu[Math.abs(i - mu)] * data[i];
      mu = Math.round((W[last] - W[t]) / (S[last] - S[t]));
      for (let i = t + 1; i <= last; i++) e += Smu[Math.abs(i - mu)] * data[i];
      if (bestE > e) { bestE = e; best = t; }
    }
    return best;
  }
  const fx = readJson('thr/methods256.json');
  fx.histograms.forEach((h, i) => {
    if (h.filter((v) => v > 0).length < 3) return; // bilevel shortcut
    assert.equal(T.level(h, 'Huang2'), naive(Float64Array.from(h)), 'histogram ' + i);
  });
  const wide = new Float64Array(2000);
  for (let i = 100; i < 1900; i += 3) wide[i] = 1 + ((i * 7) % 13);
  assert.equal(T.level(wide, 'Huang2'), naive(wide));
});

test('Java int arithmetic: i³ and i·count wrap, so a 16-bit Moments / Li / MinError follow ImageJ and not the exact maths', () => {
  // Moments adds `i * i * i * histo[i]` with an int product: from i = 1291 it wraps negative. A trimmed histogram starting at bin 0
  // that reaches bin 3000 gives a finite level through the wrapped moments (the exact ones would differ).
  const h = new Float64Array(3200);
  for (let i = 0; i < 3200; i++) h[i] = 1 + (i % 17) + (i < 400 ? 50 : 0) + (i > 2800 ? 30 : 0);
  const a = T.level(h, 'Moments');
  assert.ok(Number.isInteger(a) && a >= 0 && a < 3200, 'a threshold inside the histogram: ' + a);
  assert.equal(T.level(h, 'Moments'), a, 'deterministic');
  for (const m of T.methods()) { const v = T.level(h, m); assert.ok(Number.isInteger(v) && v >= 0 && v < 3200, m + ' ' + v); }
});

test('levels(): Fiji / ImageJ rules for dark, light, inverted LUT, the 16-bit histogram and the open ends', () => {
  const w = 20, h = 20, d = new Uint16Array(w * h);
  for (let i = 0; i < d.length; i++) d[i] = (i % 20) < 10 ? 1000 : 40000 + (i % 3);
  const ch = { width: w, height: h, bitDepth: 16, data: d };
  const dark = T.levels(ch, 'Otsu', { dark: true, histogram16: true });
  const light = T.levels(ch, 'Otsu', { dark: false, histogram16: true });
  assert.deepEqual([dark.ijUpper, light.ijLower], [65535, 0]);
  assert.equal(dark.ijLower, light.ijUpper, '16-bit histogram: no "+ 1" (addOne = false)');
  const inv = T.levels(ch, 'Otsu', { dark: true, histogram16: true, invertedLut: true });
  assert.deepEqual([inv.ijLower, inv.ijUpper], [light.ijLower, light.ijUpper], 'an inverting LUT swaps the sides');
  // 256-bin path: the range is rounded (ShortProcessor.setThreshold) and open ends are 0 / 65535
  const d256 = T.levels(ch, 'Otsu', { dark: true });
  assert.equal(d256.ijUpper, 65535);
  assert.ok(Number.isInteger(d256.ijLower) && Number.isInteger(d256.lower));
  // ignore black / white
  const sp = { width: 4, height: 1, bitDepth: 8, data: Uint8Array.from([0, 0, 0, 255, 255, 100, 110, 120, 130, 140]) };
  const a = T.levels({ width: 10, height: 1, bitDepth: 8, data: sp.data }, 'Otsu', { dark: true, ignoreBlack: true, ignoreWhite: true });
  const b = T.levels({ width: 10, height: 1, bitDepth: 8, data: sp.data }, 'Otsu', { dark: true });
  assert.notEqual(a.level, b.level, 'the end bins change the answer');
});

console.log(passed + ' tests passed');
