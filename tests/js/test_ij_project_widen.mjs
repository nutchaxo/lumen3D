// IJProject (ij-core.js) widened to 16-bit and 32-bit float input blocks (PLAN-wave3 §3.4), against an
// independent per-pixel evaluation of ImageJ 1.54 ZProjector's arithmetic:
//   AverageIntensity / sum   float32 running sum, (float) sum / num, (short)(mean + 0.5f) for 16-bit
//   MaxIntensity / Min       float comparisons, start ∓Float.MAX_VALUE, NaN never wins
//   StandardDeviation        double sums, (float)sqrt(((n·Σx² − (Σx)²)/n) / (n − 1)), NaN → 0
//   Median                   Arrays.sort (NaN last), (a[m−1] + a[m]) / 2f in float
//   doAverageFloatProjection (32-bit average) double sum / count per pixel, NaN skipped, 0 / 0 = NaN
// Blocks arrive in bands and z chunks in any order. tests/fixtures/ij-wave3/lib/zproject_*.json (recorded
// from a real ImageJ) is checked when present.
//
// Run: node tests/js/test_ij_project_widen.mjs
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FILE = 'js/modules/studio/advanced-studio/ij-core.js';
vm.runInThisContext(readFileSync(path.join(ROOT, FILE), 'utf8'), { filename: FILE });
const { IJProject } = globalThis;

let passed = 0;
function test(name, fn) { fn(); passed++; }
const f = Math.fround;
const FMAX = 3.4028234663852886e38;

function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// ZProjector, per pixel, from the list of the pixel's values through the stack.
function refPixel(method, bd, vals) {
  const n = vals.length;
  switch (method) {
    case 'max': { let m = -FMAX; for (const v of vals) if (!Number.isNaN(v) && v > m) m = v; return m; }
    case 'min': { let m = FMAX; for (const v of vals) if (!Number.isNaN(v) && v < m) m = v; return m; }
    case 'sum': { let s = 0; for (const v of vals) s = f(s + v); return s; }
    case 'avg': {
      if (bd === 32) { let s = 0, c = 0; for (const v of vals) if (!Number.isNaN(v)) { s += v; c++; } return f(s / c); }
      let s = 0; for (const v of vals) s = f(s + v);
      const mean = f(s / n);
      return bd === 8 ? Math.trunc(f(mean + 0.5)) : Math.trunc(f(mean + 0.5)) & 0xffff;
    }
    case 'sd': {
      let s = 0, s2 = 0; for (const v of vals) { s += v; s2 += v * v; }
      if (n <= 1) return 0;
      const sd = (n * s2 - s * s) / n;
      return sd > 0 ? f(Math.sqrt(sd / (n - 1))) : 0;
    }
    default: {
      const a = Float32Array.from(vals).sort();
      const m = a.length >> 1;
      const r = (a.length & 1) ? a[m] : f(f(a[m - 1] + a[m]) / 2);
      return bd === 8 ? Math.trunc(f(r + 0.5)) : r;
    }
  }
}

function makeStack(bd, W, H, D, rand, { nan = false } = {}) {
  const T = bd === 8 ? Uint8Array : bd === 16 ? Uint16Array : Float32Array;
  return Array.from({ length: D }, () => {
    const p = new T(W * H);
    for (let i = 0; i < p.length; i++) {
      p[i] = bd === 8 ? Math.floor(rand() * 256) : bd === 16 ? Math.floor(rand() * 65536) : (rand() - 0.5) * 1e4;
      if (bd === 32 && nan && rand() < 0.15) p[i] = NaN;
    }
    return p;
  });
}

// Feed the stack in bands of `rows` rows and z chunks of `chunk` planes, in a shuffled order.
function feed(proj, planes, W, H, rows, chunk, rand) {
  const jobs = [];
  for (let y0 = 0; y0 < H; y0 += rows) for (let z0 = 0; z0 < planes.length; z0 += chunk) jobs.push({ y0, r: Math.min(rows, H - y0), z0, d: Math.min(chunk, planes.length - z0) });
  for (let i = jobs.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [jobs[i], jobs[j]] = [jobs[j], jobs[i]]; }
  for (const b of jobs) {
    const T = planes[0].constructor;
    const data = new T(b.d * b.r * W);
    for (let z = 0; z < b.d; z++) data.set(planes[b.z0 + z].subarray(b.y0 * W, (b.y0 + b.r) * W), z * b.r * W);
    proj.addBlock({ channel: 0, y0: b.y0, rows: b.r, z0: b.z0, depth: b.d, data });
  }
}

const same = (a, b) => a.length === b.length && a.every((v, i) => Object.is(v, b[i]) || (v === b[i]));

test('16-bit and 32-bit input: every method equals ZProjector\'s float arithmetic', () => {
  const W = 7, H = 5;
  for (const bd of [16, 32]) {
    for (const method of ['max', 'min', 'sum', 'avg', 'sd', 'median']) {
      for (const [depth, nan] of [[1, false], [2, false], [5, false], [6, false], [9, true], [4, true]]) {
        if (nan && bd !== 32) continue;
        const rand = rng(bd * 1000 + depth * 17 + method.length);
        const planes = makeStack(bd, W, H, depth, rand, { nan });
        const proj = IJProject.create({ method, width: W, height: H, depth, channels: 1, inputBitDepth: bd });
        feed(proj, planes, W, H, 2, 2, rand);
        const out = proj.finish()[0];
        assert.equal(out.bitDepth, IJProject.outputBitDepth(method, depth, bd));
        const want = Array.from({ length: W * H }, (_, i) => refPixel(method, bd, planes.map((p) => p[i])));
        const got = Array.from(out.data);
        assert.ok(got.every((v, i) => Object.is(v, want[i]) || v === want[i] || (Number.isNaN(v) && Number.isNaN(want[i]))),
          `${bd}-bit ${method} depth ${depth}${nan ? ' with NaN' : ''}: ${got.slice(0, 5)} vs ${want.slice(0, 5)}`);
      }
    }
  }
});

test('32-bit: NaN rules (max / min skip it, average skips it, sum propagates it, an all-NaN pixel)', () => {
  const W = 1, H = 1;
  const run = (method, vals) => {
    const proj = IJProject.create({ method, width: W, height: H, depth: vals.length, channels: 1, inputBitDepth: 32 });
    feed(proj, vals.map((v) => Float32Array.of(v)), W, H, 1, 1, () => 0.5);
    return proj.finish()[0].data[0];
  };
  assert.equal(run('max', [NaN, 3, 7, NaN]), 7);
  assert.equal(run('min', [NaN, 3, 7, NaN]), 3);
  assert.equal(run('avg', [NaN, 3, 7, NaN]), 5, 'doAverageFloatProjection: NaN skipped per pixel');
  assert.ok(Number.isNaN(run('avg', [NaN, NaN])), '0 / 0');
  assert.ok(Number.isNaN(run('sum', [1, NaN, 2])));
  assert.equal(run('max', [NaN, NaN]), -FMAX, 'all NaN: the initial −Float.MAX_VALUE stays');
  assert.equal(run('min', [NaN]), FMAX);
  assert.equal(run('sd', [1, NaN, 3]), 0, 'a NaN sum fails sd > 0: 0f');
  assert.equal(run('median', [NaN, 1, 2]), 2, 'Arrays.sort puts NaN last: the middle of [1, 2, NaN]');
});

test('16-bit: sums above 2^24 lose precision as float32 does; averages end at (short)(mean + 0.5f)', () => {
  const W = 1, H = 1, D = 600;
  const planes = Array.from({ length: D }, () => Uint16Array.of(65535));
  const run = (method) => {
    const proj = IJProject.create({ method, width: W, height: H, depth: D, channels: 1, inputBitDepth: 16 });
    feed(proj, planes, W, H, 1, 50, () => 0.3);
    return proj.finish()[0].data[0];
  };
  let s = 0; for (let i = 0; i < D; i++) s = f(s + 65535);
  assert.equal(run('sum'), s);
  assert.equal(run('avg'), refPixel('avg', 16, planes.map((p) => p[0])), 'the float32 mean, then (short)(mean + 0.5f): ImageJ wraps the same way');
  // a mean ending at .5 rounds up: (1 + 2) / 2 = 1.5 → 2, (2 + 3) / 2 = 2.5 → 3
  const two = (a, b, method = 'avg') => { const p = IJProject.create({ method, width: 1, height: 1, depth: 2, channels: 1, inputBitDepth: 16 }); feed(p, [Uint16Array.of(a), Uint16Array.of(b)], 1, 1, 1, 1, () => 0); return p.finish()[0].data[0]; };
  assert.equal(two(1, 2), 2); assert.equal(two(2, 3), 3); assert.equal(two(0, 65535), 32768);
  assert.equal(two(1, 2, 'median'), 1.5, '16-bit median is a float image');
});

test('block typing, depth validation, estimateBytes', () => {
  const code = (fn) => { try { fn(); } catch (e) { return e.code; } return null; };
  assert.equal(code(() => IJProject.create({ method: 'max', width: 2, height: 2, depth: 2, channels: 1, inputBitDepth: 12 })), 'IJ_BAD_DEPTH');
  const p16 = IJProject.create({ method: 'max', width: 2, height: 1, depth: 1, channels: 1, inputBitDepth: 16 });
  assert.equal(code(() => p16.addBlock({ channel: 0, y0: 0, rows: 1, z0: 0, depth: 1, data: new Uint8Array(2) })), 'IJ_BAD_BLOCK');
  const p32 = IJProject.create({ method: 'max', width: 2, height: 1, depth: 1, channels: 1, inputBitDepth: 32 });
  assert.equal(code(() => p32.addBlock({ channel: 0, y0: 0, rows: 1, z0: 0, depth: 1, data: new Uint32Array(2) })), 'IJ_BAD_BLOCK');
  const e = (method, bd, extra) => IJProject.estimateBytes({ method, width: 100, height: 20, depth: 10, channels: 2, inputBitDepth: bd, ...extra });
  assert.equal(e('max', 16), 2 * 100 * 20 * 2 + 2 * 20 * 100 * 2);
  assert.equal(e('avg', 32, { pendingPlanes: 0 }), 2 * 100 * 20 * 4 + 2 * 20 * 100 * 12);
  // an in-order 16 / 32-bit sum keeps planes that arrive early: counted (default 32 planes, here capped by the depth 10)
  assert.equal(e('avg', 32), 2 * 100 * 20 * 4 + 2 * (20 * 100 * 12 + 10 * 20 * 100 * 4));
  assert.equal(e('sum', 16, { pendingPlanes: 3 }), 2 * 100 * 20 * 4 + 2 * (20 * 100 * 4 + 3 * 20 * 100 * 2));
  assert.equal(e('sum', 8), 2 * 100 * 20 * 4 + 2 * 20 * 100 * 4, '8-bit sums are order-free');
  assert.equal(e('median', 16), 2 * 100 * 20 * 4 + 2 * 20 * 100 * 10 * 2);
  assert.equal(IJProject.outputBitDepth('avg', 3, 32), 32);
  assert.equal(IJProject.outputBitDepth('max', 3, 16), 16);
});

test('recorded ImageJ outputs (tests/fixtures/ij-wave3/lib/zproject_*.json) when present', () => {
  const dir = path.join(ROOT, 'tests', 'fixtures', 'ij-wave3', 'lib');
  const files = existsSync(dir) ? readdirSync(dir).filter((n) => /^zproject_.*\.json$/.test(n)) : [];
  if (!files.length) { console.log('SKIP ImageJ ZProjector fixtures: none recorded yet'); return; }
  for (const name of files) {
    const fx = JSON.parse(readFileSync(path.join(dir, name), 'utf8'));
    const cases = Array.isArray(fx) ? fx : (fx.cases || [fx]);
    for (const c of cases) {
      if (!c.method || !c.input || !c.expected) continue;       // another shape: left to the fixture's owner
      const bd = c.bitDepth || 8, W = c.width, H = c.height;
      const T = bd === 8 ? Uint8Array : bd === 16 ? Uint16Array : Float32Array;
      const planes = c.input.map((p) => T.from(p.map((v) => (v === null ? NaN : v))));
      const proj = IJProject.create({ method: c.method, width: W, height: H, depth: planes.length, channels: 1, inputBitDepth: bd });
      feed(proj, planes, W, H, Math.max(1, H >> 1), 2, rng(5));
      const got = Array.from(proj.finish()[0].data), want = c.expected.map((v) => (v === null ? NaN : v));
      assert.ok(got.every((v, i) => Object.is(v, want[i]) || v === want[i]), `${name}: ${c.method} ${bd}-bit`);
    }
  }
});

console.log(`test_ij_project_widen: ${passed} groups passed`);
