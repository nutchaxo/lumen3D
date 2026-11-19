// Analyze > Tools > Fractal Box Count…: ImageJ 1.54p's FractalBoxCounter (ij-proc-fiji.js, IJFractal / op fractalBoxCount).
//
// Reference: tests/fixtures/ij-wave3/fiji/fractal_box_count.json — the real plugin on four binary images (a carpet, dust, thin lines, discs
// on a non-square image), three size lists, object = 255 / black background off / inverted LUT: 36 runs. Counts must be identical and D
// (-slope of the straight-line CurveFitter fit of ln(count) on ln(size), both as floats) identical to the last bit.
//
// Run: node tests/js/test_ij_fiji_fractal.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT } from './harness.mjs';

const DIR = path.join(ROOT, 'js', 'modules', 'studio', 'advanced-studio');
const ctx = vm.createContext({ console, setTimeout, clearTimeout });
for (const f of ['ij-core.js', 'ij-proc-shared.js', 'ij-proc-fiji.js']) vm.runInContext(readFileSync(path.join(DIR, f), 'utf8'), ctx, { filename: f });
const FR = vm.runInContext('IJFractal', ctx);
const reg = vm.runInContext('IJOpRegistry', ctx);
const fx = JSON.parse(readFileSync(path.join(ROOT, 'tests', 'fixtures', 'ij-wave3', 'fiji', 'fractal_box_count.json'), 'utf8'));
const u8 = (d) => { const b = Buffer.from(d.data.b64, 'base64'); return new Uint8Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); };
const hooks = { check() {}, async tick() {} };
const plain = (x) => JSON.parse(JSON.stringify(x));

// ── 1. the box sizes string: StringTokenizer(s, ", \t") and Integer.parseInt ──
assert.deepEqual(plain(FR.parseBoxSizes('2,3,4,6,8,12,16,32,64')), [2, 3, 4, 6, 8, 12, 16, 32, 64]);
assert.deepEqual(plain(FR.parseBoxSizes(' 2 ,\t3;')), null, 'a token that is not an integer makes the whole string invalid');
assert.deepEqual(plain(FR.parseBoxSizes('2, 3 4,,5')), [2, 3, 4, 5], 'commas, blanks and tabs separate, empty tokens vanish');
assert.deepEqual(plain(FR.parseBoxSizes('1.5')), null); assert.deepEqual(plain(FR.parseBoxSizes('+7,-2')), [7, -2]);
assert.deepEqual(plain(FR.parseBoxSizes('')), []);

// ── 2. the 36 runs ──
let n = 0;
for (const c of fx.cases) {
  const im = fx.inputs.find((i) => i.name === c.image).image;
  // `inverted`: the image the plugin saw has its object at 0 (black background off): the fixture's input is the 255-object one
  let data = u8(im);
  if (c.params.inverted) data = data.map((v) => 255 - v);
  let foreground = c.params.blackBackground ? 255 : 0;
  if (c.params.invertedLut) foreground = 255 - foreground;
  const r = await FR.fractalBoxCount(data, im.width, im.height, { boxSizes: FR.parseBoxSizes(c.params.boxSizes), foreground }, hooks);
  const want = c.result;
  assert.deepEqual(plain(want.headings.slice(1, -1)), plain(r.sizes.map((s) => 'C' + s)));
  assert.deepEqual(plain(r.counts), want.values.slice(1, -1), `${c.image} ${JSON.stringify(c.params)}: counts`);
  assert.equal(r.D, want.values[want.values.length - 1], `${c.image} ${JSON.stringify(c.params)}: D`);
  n++;
}
assert.equal(n, 36);

// ── 3. by hand: the margins and the box walk ──
{
  // a 10 x 10 image with one object pixel: every box size counts exactly one box
  const d = new Uint8Array(100); d[3 * 10 + 4] = 255;
  const r = await FR.fractalBoxCount(d, 10, 10, { boxSizes: [1, 2, 3, 5, 64], foreground: 255 }, hooks);
  assert.deepEqual(plain(r.counts), [1, 1, 1, 1, 1]);
  assert.deepEqual(plain(r.bounds), { x: 4, y: 3, width: 1, height: 1 });
  // a full 8 x 8 square, boxes of 3: ceil(8/3)² = 9 boxes; of 8: one
  const f = new Uint8Array(64).fill(255);
  const r2 = await FR.fractalBoxCount(f, 8, 8, { boxSizes: [3, 8, 1], foreground: 255 }, hooks);
  assert.deepEqual(plain(r2.counts), [9, 1, 64]);
  assert.ok(Math.abs(r2.D - 2) < 0.01, 'a filled square has dimension 2: ' + r2.D);
  // two pixels far apart
  const g = new Uint8Array(64); g[0] = 255; g[63] = 255;
  assert.deepEqual(plain((await FR.fractalBoxCount(g, 8, 8, { boxSizes: [2, 4, 8], foreground: 255 }, hooks)).counts), [2, 2, 1]);
}

// ── 4. refusals ──
{
  const grey = new Uint8Array(16).map((_, i) => i * 10);
  await assert.rejects(FR.fractalBoxCount(grey, 4, 4, { boxSizes: [2], foreground: 255 }, hooks), (e) => e.code === 'IJ_FIJI_NOT_BINARY');
  await assert.rejects(FR.fractalBoxCount(new Uint8Array(16), 4, 4, { boxSizes: [2], foreground: 255 }, hooks), (e) => e.code === 'IJ_FIJI_NO_FOREGROUND', 'No non-background pixels');
  const spec = reg.get('fractalBoxCount');
  assert.equal(spec.kind, 'compute'); assert.deepEqual(plain(spec.bitDepths), [8]);
  for (const bad of [null, { boxSizes: [], foreground: 255 }, { boxSizes: [0], foreground: 255 }, { boxSizes: [2.5], foreground: 255 }, { boxSizes: [2], foreground: 7 }, { boxSizes: [70000], foreground: 255 }]) {
    assert.throws(() => spec.validate(bad), (e) => e.code === 'IJ_BAD_ARGS', JSON.stringify(bad));
  }
  spec.validate({ boxSizes: [2, 4], foreground: 0 });
  // a cancel while counting: nothing comes back
  let k = 0;
  const big = new Uint8Array(4096 * 64).fill(255);
  await assert.rejects(FR.fractalBoxCount(big, 4096, 64, { boxSizes: [1], foreground: 255 }, { check() { if (++k > 3) throw Object.assign(new Error('c'), { code: 'IJ_CANCELLED' }); }, async tick() {} }), (e) => e.code === 'IJ_CANCELLED');
  // the op reads the channel it is asked for and never writes it
  const frozen = Object.freeze({ id: 'd', name: 'x', width: 8, height: 8, bitDepth: 8, active: 0, channels: [{ data: new Uint8Array(64).fill(255) }] });
  const res = await spec.run(frozen, { boxSizes: [2, 4], foreground: 255 }, null, { channel: 0, tick: async () => {}, check() {} });
  assert.deepEqual(plain(res.counts), [16, 4]);
}

console.log('ij fiji fractal: OK (36 fixture runs)');
