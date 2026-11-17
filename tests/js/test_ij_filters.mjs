// Package P2 (filters) of the Advanced Studio: the operations of js/modules/studio/advanced-studio/ij-proc-filters.js
// run through the REAL engine (ij-engine.js, input hashing on) against
//   1. every golden fixture recorded with ImageJ 1.54p (tests/fixtures/ij-wave2/flt, 129 files), value for value;
//   2. determinism: the same result whatever the band height (1 row / 7 rows / the whole image), with and without
//      a selection, for every pixel op and every bit depth;
//   3. refusals (bit depth, parameters), cancel, never writing into an input;
//   4. the pure helpers the dialogs use (Integer.parseInt(s, 2), the kernel text, the Java casts).
//
// Fixture accuracy: every fixture is compared exactly (integer and float images bit for bit: the ports round with
// Math.fround where Java rounds to float, and Unsharp Mask carries GaussianBlur's float arithmetic). One documented
// exception:
//   - nanbackground_2_f32: ImageJ's ImageMath.setBackgroundToNaN loops over the WHOLE image and the runner then
//     restores only the pixels inside the selection RECTANGLE that lie outside its MASK; the op ignores the selection
//     (roi:'ignore'), so the pixels of that ring differ; everything else must match.
//
// Run: node tests/js/test_ij_filters.mjs
import assert from 'node:assert/strict';
import { startEngine, closeAll, M, loadFixture, listFixtures, imageOf, roiOf, diff } from './ij_filters_support.mjs';

const P = (x) => JSON.parse(JSON.stringify(x));
function rng(seed) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; }

// ── 1. golden fixtures ────────────────────────────────────────────────────────────────────────────────────
{
  const c = startEngine();
  const names = listFixtures();
  assert.equal(names.length, 129, 'the 129 fixtures of the package are there');
  const report = { exact: 0, quirk: [] };
  const opsSeen = new Set();
  for (const name of names) {
    const fx = loadFixture(name);
    opsSeen.add(fx.op);
    const W = fx.input.width, H = fx.input.height, bd = fx.input.bitDepth;
    const doc = await c.makeDoc(W, H, bd, [imageOf(fx.input)]);
    const roi = roiOf(fx, W, H);
    await c.run(doc.id, fx.op, fx.params, { roi });
    const out = await c.pixels(doc.id, 0);
    const exp = imageOf(fx.output);
    assert.equal(out.length, exp.length, name);
    if (name === 'nanbackground_2_f32') {
      // outside the selection RECTANGLE the whole image is thresholded; inside the mask too
      const r = fx.roi, m = fx.roi.mask, md = Array.isArray(m.data) ? m.data : null;
      let ring = 0, bad = 0;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const inBox = x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;
        const inMask = inBox && md && md[(y - m.y) * m.w + (x - m.x)] === 1;
        const i = y * W + x;
        const same = out[i] === exp[i] || (out[i] !== out[i] && exp[i] !== exp[i]);
        if (inBox && !inMask) { if (!same) ring++; } else if (!same) bad++;
      }
      assert.equal(bad, 0, name + ': outside the rectangle and inside the mask the result equals ImageJ');
      assert.ok(ring > 0, name + ': the documented difference of ImageMath.setBackgroundToNaN exists');
      report.quirk.push(name + ' (' + ring + ' px of the rectangle-outside-mask ring)');
      continue;
    }
    const d = diff(out, exp);
    assert.equal(d.n, 0, `${name}: ${d.n} of ${out.length} px differ (first #${d.first}: ${out[d.first]} vs ImageJ ${exp[d.first]})`);
    report.exact++;
  }
  for (const op of ['filter3x3', 'unsharpMask', 'convolve', 'rankExtra', 'rank', 'topHat', 'removeNaNs', 'math2', 'nanBackground']) assert.ok(opsSeen.has(op), `fixtures of ${op}`);
  console.log(`fixtures: ${names.length} files, ${report.exact} bit-exact, ${report.quirk.length} documented`);
  for (const t of report.quirk) console.log('  quirk: ' + t);
}

// ── 2. determinism: any band height gives the same bytes ──────────────────────────────────────────────────
function testImage(bd, W, H, seed, nans) {
  const r = rng(seed);
  const T = bd === 8 ? Uint8Array : bd === 16 ? Uint16Array : Float32Array;
  const d = new T(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const blob = Math.exp(-(((x - W * 0.35) ** 2 + (y - H * 0.4) ** 2) / 90)) + 0.7 * Math.exp(-(((x - W * 0.75) ** 2 + (y - H * 0.7) ** 2) / 40));
    const v = blob * 0.6 + r() * 0.4;
    d[y * W + x] = bd === 8 ? Math.floor(v * 255) : bd === 16 ? Math.floor(v * 65535) : v * 400 - 100;
  }
  if (bd === 32 && nans) for (let k = 0; k < 6; k++) { const x0 = Math.floor(r() * (W - 4)), y0 = Math.floor(r() * (H - 3)); for (let y = 0; y < 3; y++) for (let x = 0; x < 4; x++) d[(y0 + y) * W + x0 + x] = NaN; }
  return d;
}
{
  const W = 53, H = 41;
  const k5 = [0, 1, 2, 1, 0, 1, 3, 5, 3, 1, 2, 5, 9, 5, 2, 1, 3, 5, 3, 1, 0, 1, 2, 1, 0];
  const cases = [
    ['filter3x3', { type: 'smooth' }], ['filter3x3', { type: 'sharpen' }], ['filter3x3', { type: 'edges' }],
    ['unsharpMask', { sigma: 2, weight: 0.6 }], ['unsharpMask', { sigma: 0.7, weight: 0.3 }], ['unsharpMask', { sigma: 6, weight: 0.5 }], ['unsharpMask', { sigma: 9, weight: 0.5 }],
    ['convolve', { kernel: k5, kw: 5, kh: 5, normalize: true }], ['convolve', { kernel: [1, -2, 1], kw: 1, kh: 3, normalize: false }], ['convolve', { kernel: [1, 2, 4, 2, 1], kw: 5, kh: 1, normalize: true }],
    ['rankExtra', { type: 'variance', radius: 2 }], ['rankExtra', { type: 'variance', radius: 3.5 }], ['rankExtra', { type: 'variance', radius: 1 }],
    ['rankExtra', { type: 'outliersBright', radius: 2, threshold: 20 }], ['rankExtra', { type: 'outliersDark', radius: 3, threshold: 20 }],
    ['topHat', { radius: 3, light: false, dontSubtract: false }], ['topHat', { radius: 4.5, light: true, dontSubtract: false }], ['topHat', { radius: 3, light: false, dontSubtract: true }],
    ['math2', { op: 'log' }], ['math2', { op: 'exp' }], ['math2', { op: 'sqr' }], ['math2', { op: 'sqrt' }], ['math2', { op: 'gamma', value: 0.5 }], ['math2', { op: 'gamma', value: 2.2 }],
    ['math2', { op: 'and', value: 0xf0 }], ['math2', { op: 'or', value: 0x0f }], ['math2', { op: 'xor', value: 0xaa }], ['math2', { op: 'reciprocal' }],
    ['removeNaNs', { radius: 2 }], ['nanBackground', { lower: 20, upper: 250 }]
  ];
  const oval = { type: 'oval', x: 6, y: 5, w: 38, h: 29 };
  const bands = [W, W * 7, 1 << 20];
  const clients = bands.map((b) => startEngine({ bandPixels: b }));
  let n = 0;
  for (const bd of [8, 16, 32]) {
    const img = testImage(bd, W, H, 40 + bd, true);
    for (const [op, params] of cases) {
      const spec = M.IJOpRegistry.get(op);
      if (!spec.bitDepths.includes(bd)) continue;
      if (op === 'math2' && ((['and', 'or', 'xor'].includes(params.op) && bd === 32) || (params.op === 'reciprocal' && bd !== 32))) continue;
      for (const roi of [null, oval]) {
        const outs = [];
        for (const c of clients) {
          const doc = await c.makeDoc(W, H, bd, [img]);
          await c.run(doc.id, op, params, { roi });
          outs.push(await c.pixels(doc.id, 0));
        }
        for (let i = 1; i < outs.length; i++) {
          const d = diff(outs[0], outs[i]);
          assert.equal(d.n, 0, `${op} ${JSON.stringify(params)} ${bd}-bit roi=${!!roi}: band ${bands[0]} vs ${bands[i]} differ on ${d.n} px (first #${d.first})`);
        }
        n++;
      }
    }
  }
  // a multi-channel document: each channel its own result (bands cross channels too)
  {
    const c = clients[0], a = testImage(16, W, H, 7), b = testImage(16, W, H, 8);
    const doc = await c.makeDoc(W, H, 16, [a, b]);
    await c.run(doc.id, 'filter3x3', { type: 'smooth' }, { channel: 'all' });
    const ref = startEngine({ bandPixels: 1 << 20 });
    const d0 = await ref.makeDoc(W, H, 16, [a]); await ref.run(d0.id, 'filter3x3', { type: 'smooth' });
    const d1 = await ref.makeDoc(W, H, 16, [b]); await ref.run(d1.id, 'filter3x3', { type: 'smooth' });
    assert.equal(diff(await c.pixels(doc.id, 0), await ref.pixels(d0.id, 0)).n, 0);
    assert.equal(diff(await c.pixels(doc.id, 1), await ref.pixels(d1.id, 0)).n, 0);
  }
  console.log(`determinism: ${n} (op, params, depth, selection) cases byte-identical over bands of 1 / 7 rows / whole`);
}

// ── 3. independent checks of the arithmetic ───────────────────────────────────────────────────────────────
{
  const c = startEngine();
  const W = 11, H = 9;
  // Convolve is a correlation (the kernel is not flipped): a unit impulse reproduces the kernel mirrored
  const img = new Uint8Array(W * H); img[4 * W + 5] = 100;
  const doc = await c.makeDoc(W, H, 8, [img]);
  await c.run(doc.id, 'convolve', { kernel: [1, 2, 3, 4, 5, 6, 7, 8, 9], kw: 3, kh: 3, normalize: false });
  const out = await c.pixels(doc.id);
  // output(x,y) = sum_k kernel[k] * img(x+u, y+v): the impulse at (5,4) lands at (5-u, 4-v), kernel index (v+1)*3+(u+1)
  assert.equal(out[(4 - 1) * W + (5 - 1)], 100 * 9 > 255 ? 255 : 900, 'correlation, not convolution: the corner tap k[8]=9 appears at (-1,-1)');
  assert.equal(out[(4 + 1) * W + (5 + 1)], 100, 'k[0]=1 appears at (+1,+1)');
  assert.equal(out[4 * W + 5], 255, '5 x 100 clamps to 255 (8-bit saturates)');

  // a normalised kernel keeps a flat image flat; a zero-sum kernel is NOT scaled
  const flat = await c.makeDoc(W, H, 16, [new Uint16Array(W * H).fill(1234)]);
  await c.run(flat.id, 'convolve', { kernel: [1, 2, 1, 2, 4, 2, 1, 2, 1], kw: 3, kh: 3, normalize: true });
  assert.ok((await c.pixels(flat.id)).every((v) => v === 1234));
  const zs = await c.makeDoc(W, H, 16, [new Uint16Array(W * H).fill(1234)]);
  await c.run(zs.id, 'convolve', { kernel: [-1, 0, 1, -2, 0, 2, -1, 0, 1], kw: 3, kh: 3, normalize: true });
  assert.ok((await c.pixels(zs.id)).every((v) => v === 0), 'a flat image through a Sobel kernel is 0 (sum 0: no division)');

  // Unsharp: a flat image is a fixed point; weight 0 is the identity
  const uf = await c.makeDoc(W, H, 32, [new Float32Array(W * H).fill(7.5)]);
  await c.run(uf.id, 'unsharpMask', { sigma: 2, weight: 0.6 });
  assert.ok((await c.pixels(uf.id)).every((v) => Math.abs(v - 7.5) < 1e-5));
  const u0 = await c.makeDoc(W, H, 8, [Uint8Array.from({ length: W * H }, (_, i) => (i * 37) & 255)]);
  const before = await c.pixels(u0.id);
  await c.run(u0.id, 'unsharpMask', { sigma: 1.5, weight: 0 });
  assert.deepEqual(Array.from(await c.pixels(u0.id)), Array.from(before), 'weight 0: (v - 0*g)/(1 - 0) = v');

  // Variance of a flat image is 0, of a 2-valued checker of the 3x3-ish neighbourhood is positive; 8-bit clips at 255
  const vf = await c.makeDoc(W, H, 16, [new Uint16Array(W * H).fill(500)]);
  await c.run(vf.id, 'rankExtra', { type: 'variance', radius: 2 });
  assert.ok((await c.pixels(vf.id)).every((v) => v === 0));
  const spike = new Uint8Array(W * H); spike[4 * W + 5] = 255;
  const vs = await c.makeDoc(W, H, 8, [spike]);
  await c.run(vs.id, 'rankExtra', { type: 'variance', radius: 1 });
  const vout = await c.pixels(vs.id);
  // radius 1 = the 5-point plus: n = 5, mean 51, variance = (255^2 + 0)/5 - 51^2 = 13005 - 2601 = 10404 → clipped to 255
  assert.equal(vout[4 * W + 5], 255);
  // Remove outliers: a bright spike 200 over a flat 20 field is replaced by the median when the threshold allows it
  const so = new Uint8Array(W * H).fill(20); so[4 * W + 5] = 220;
  const od = await c.makeDoc(W, H, 8, [so]);
  await c.run(od.id, 'rankExtra', { type: 'outliersBright', radius: 2, threshold: 50 });
  assert.equal((await c.pixels(od.id))[4 * W + 5], 20, 'bright outlier removed');
  const od2 = await c.makeDoc(W, H, 8, [so]);
  await c.run(od2.id, 'rankExtra', { type: 'outliersBright', radius: 2, threshold: 200 });
  assert.equal((await c.pixels(od2.id))[4 * W + 5], 220, 'v - median = 200 is not > 200: kept');
  const od3 = await c.makeDoc(W, H, 8, [so]);
  await c.run(od3.id, 'rankExtra', { type: 'outliersDark', radius: 2, threshold: 50 });
  assert.equal((await c.pixels(od3.id))[4 * W + 5], 220, 'a bright pixel is no dark outlier');

  // Top hat: a thin bright line on a flat field survives, the flat field goes to 0; light background mirrors it
  const line = new Uint8Array(W * H).fill(40); for (let y = 0; y < H; y++) line[y * W + 5] = 200;
  const th = await c.makeDoc(W, H, 8, [line]);
  await c.run(th.id, 'topHat', { radius: 2, light: false, dontSubtract: false });
  const tout = await c.pixels(th.id);
  assert.equal(tout[4 * W + 5], 160); assert.equal(tout[4 * W + 2], 0);
  const lt = await c.makeDoc(W, H, 8, [line.map((v) => 255 - v)]);
  await c.run(lt.id, 'topHat', { radius: 2, light: true, dontSubtract: false });
  const lout = await c.pixels(lt.id);
  assert.equal(lout[4 * W + 5], 255 - 160, 'light background: original - closed + 255');
  assert.equal(lout[4 * W + 2], 255);

  // Remove NaNs
  const nn = new Float32Array(W * H).fill(3); nn[4 * W + 5] = NaN;
  const nd = await c.makeDoc(W, H, 32, [nn]);
  await c.run(nd.id, 'removeNaNs', { radius: 1 });
  assert.ok((await c.pixels(nd.id)).every((v) => v === 3));

  // Math on 8 bits: Log / Exp tables (ImageProcessor.process)
  const ramp = Uint8Array.from({ length: W * H }, (_, i) => i % 256);
  const rd = await c.makeDoc(W, H, 8, [ramp]);
  await c.run(rd.id, 'math2', { op: 'log' });
  const lg = await c.pixels(rd.id);
  const SCALE = 255 / Math.log(255);
  for (let i = 0; i < ramp.length; i++) assert.equal(lg[i], ramp[i] === 0 ? 0 : Math.trunc(Math.log(ramp[i]) * SCALE), 'log LUT ' + ramp[i]);
  assert.equal(lg[255 % 256], lg[255 % 256]);
  // 32-bit Log of a non-positive value: -Infinity / NaN as FloatProcessor.process; Reciprocal 0 → NaN
  const ld = await c.makeDoc(4, 1, 32, [Float32Array.from([1, 0, -1, Math.E])]);
  await c.run(ld.id, 'math2', { op: 'log' });
  const lo = await c.pixels(ld.id);
  assert.equal(lo[0], 0); assert.equal(lo[1], -Infinity); assert.ok(Number.isNaN(lo[2])); assert.ok(Math.abs(lo[3] - 1) < 1e-6);
  const rcd = await c.makeDoc(4, 1, 32, [Float32Array.from([0, 2, -4, 1e-3])]);
  await c.run(rcd.id, 'math2', { op: 'reciprocal' });
  const rc = await c.pixels(rcd.id);
  assert.ok(Number.isNaN(rc[0])); assert.equal(rc[1], 0.5); assert.equal(rc[2], -0.25); assert.equal(rc[3], Math.fround(1 / Math.fround(1e-3)));
  // Square on 16 bits saturates at 65535; Sqrt truncates
  const sq = await c.makeDoc(4, 1, 16, [Uint16Array.from([0, 255, 256, 65535])]);
  await c.run(sq.id, 'math2', { op: 'sqr' });
  assert.deepEqual(Array.from(await c.pixels(sq.id)), [0, 65025, 65535, 65535]);
  const sr = await c.makeDoc(4, 1, 16, [Uint16Array.from([0, 3, 15, 65535])]);
  await c.run(sr.id, 'math2', { op: 'sqrt' });
  assert.deepEqual(Array.from(await c.pixels(sr.id)), [0, 1, 3, 255]);
  // Unsharp Mask with a large sigma: ImageJ downscales (GaussianBlur.blur1Direction); the answer stays within the
  // approximation of that shortcut of a plain separable Gaussian (whole image; selections are pinned against ImageJ in section 6). Such an op always runs as ONE band (apron >= WHOLE_APRON), so band variation cannot apply to it
  {
    const Wb = 120, Hb = 90, r = rng(5);
    const d = new Float32Array(Wb * Hb);
    for (let y = 0; y < Hb; y++) for (let x = 0; x < Wb; x++) d[y * Wb + x] = 200 * Math.exp(-(((x - 50) ** 2 + (y - 40) ** 2) / 400)) + 30 * r();
    for (const sg of [4, 6, 9, 15]) {
      const doc = await c.makeDoc(Wb, Hb, 32, [d]);
      await c.run(doc.id, 'unsharpMask', { sigma: sg, weight: 0.5 });
      const out = await c.pixels(doc.id);
      const g = M.IJFilters.gaussian({ width: Wb, height: Hb, bitDepth: 32, data: d }, sg, sg, { accuracy: 0.01 }).data;
      let worst = 0;
      for (let i = 0; i < d.length; i++) worst = Math.max(worst, Math.abs(out[i] - (d[i] - 0.5 * g[i]) / 0.5));
      assert.ok(worst < (sg > 4.5 && sg >= 8 ? 1.0 : 1e-3), `unsharp sigma ${sg}: within the downscaling approximation of the plain Gaussian (${worst})`);
    }
  }
  console.log('arithmetic checks: OK');
}

// ── 4. refusals, errors, cancel, inputs never written ─────────────────────────────────────────────────────
{
  const c = startEngine();
  const W = 12, H = 10;
  const mk = (bd) => c.makeDoc(W, H, bd, [testImage(bd, W, H, 3)]);
  const code = async (id, op, params, o) => (await c.err('doc.run', { docId: id, op, params, roi: null, channel: 0 })).code;
  const d8 = await mk(8), d16 = await mk(16), d32 = await mk(32);
  // bit depth
  assert.equal(await code(d8.id, 'removeNaNs', { radius: 2 }), 'IJ_BAD_TYPE');
  assert.equal(await code(d16.id, 'removeNaNs', { radius: 2 }), 'IJ_BAD_TYPE');
  assert.equal(await code(d8.id, 'nanBackground', { lower: 0, upper: 1 }), 'IJ_BAD_TYPE');
  assert.equal(await code(d16.id, 'nanBackground', { lower: 0, upper: 1 }), 'IJ_BAD_TYPE');
  assert.equal(await code(d8.id, 'math2', { op: 'reciprocal' }), 'IJ_BAD_TYPE');
  assert.equal(await code(d16.id, 'math2', { op: 'reciprocal' }), 'IJ_BAD_TYPE');
  for (const o of ['and', 'or', 'xor']) assert.equal(await code(d32.id, 'math2', { op: o, value: 3 }), 'IJ_BAD_TYPE', o + ' is refused on 32 bits (FloatProcessor.and is an empty method)');
  // parameters
  assert.equal(await code(d8.id, 'filter3x3', { type: 'blur' }), 'IJ_BAD_ARGS');
  assert.equal(await code(d8.id, 'unsharpMask', { sigma: -1, weight: 0.5 }), 'IJ_BAD_ARGS');
  assert.equal(await code(d8.id, 'unsharpMask', { sigma: 1, weight: 0.995 }), 'IJ_BAD_ARGS', 'weight > 0.99');
  assert.equal(await code(d8.id, 'unsharpMask', { sigma: 1, weight: -0.1 }), 'IJ_BAD_ARGS');
  assert.equal(await code(d8.id, 'convolve', { kernel: [1, 2, 3, 4], kw: 2, kh: 2, normalize: true }), 'IJ_BAD_ARGS', 'even kernel');
  assert.equal(await code(d8.id, 'convolve', { kernel: [1, 2, 3], kw: 3, kh: 3, normalize: true }), 'IJ_BAD_ARGS', 'kernel length');
  assert.equal(await code(d8.id, 'convolve', { kernel: new Array(33 * 33).fill(1), kw: 33, kh: 33, normalize: true }), 'IJ_BAD_ARGS', 'larger than 31 x 31');
  assert.equal(await code(d8.id, 'convolve', { kernel: [1, NaN, 1], kw: 3, kh: 1, normalize: true }), 'IJ_BAD_ARGS');
  assert.equal(await code(d8.id, 'rankExtra', { type: 'median', radius: 2 }), 'IJ_BAD_ARGS');
  assert.equal(await code(d8.id, 'rankExtra', { type: 'variance', radius: -1 }), 'IJ_BAD_ARGS');
  assert.equal(await code(d8.id, 'rankExtra', { type: 'variance', radius: 1001 }), 'IJ_BAD_ARGS');
  assert.equal(await code(d8.id, 'rankExtra', { type: 'outliersBright', radius: 101, threshold: 5 }), 'IJ_BAD_ARGS', 'outliers: radius <= 100');
  assert.equal(await code(d8.id, 'rankExtra', { type: 'outliersBright', radius: 2, threshold: -1 }), 'IJ_BAD_ARGS');
  assert.equal(await code(d8.id, 'rankExtra', { type: 'outliersBright', radius: 2 }), 'IJ_BAD_ARGS', 'threshold missing');
  assert.equal(await code(d32.id, 'removeNaNs', { radius: 101 }), 'IJ_BAD_ARGS');
  assert.equal(await code(d8.id, 'topHat', { radius: -2 }), 'IJ_BAD_ARGS');
  assert.equal(await code(d8.id, 'topHat', { radius: 2, light: 'yes' }), 'IJ_BAD_ARGS');
  assert.equal(await code(d8.id, 'math2', { op: 'cube' }), 'IJ_BAD_ARGS');
  assert.equal(await code(d8.id, 'math2', { op: 'gamma', value: 0.01 }), 'IJ_BAD_ARGS', 'Gamma must be between 0.05 and 5.0');
  assert.equal(await code(d8.id, 'math2', { op: 'gamma', value: 5.5 }), 'IJ_BAD_ARGS');
  assert.equal(await code(d8.id, 'math2', { op: 'and', value: 1.5 }), 'IJ_BAD_ARGS');
  assert.equal(await code(d8.id, 'math2', { op: 'and', value: 2 ** 31 }), 'IJ_BAD_ARGS', 'beyond an int');
  assert.equal(await code(d32.id, 'nanBackground', { lower: 5, upper: 1 }), 'IJ_BAD_ARGS');
  assert.equal(await code(d32.id, 'nanBackground', { lower: 'a', upper: 1 }), 'IJ_BAD_ARGS');
  // a refused request changes nothing and journals nothing
  for (const d of [d8, d16, d32]) { const info = await c.ok('doc.info', { docId: d.id }); assert.equal(info.rev, 0); assert.equal(info.undoDepth, 0); }
  // the 16-bit display range is copied into the journaled params (replay must not depend on the display of that moment)
  {
    const d = await mk(16);
    const view = { bitDepth: 16, channels: [{ display: { min: 1000, max: 40000 } }] };
    const p = M.IJOpRegistry.get('math2').resolve(view, { op: 'log' }, [0]);
    assert.deepEqual(P(p.ranges), { 0: { min: 1000, max: 40000 } });
    assert.deepEqual(P(M.IJOpRegistry.get('math2').resolve(view, p, [0])), P(p), 'resolve is idempotent');
    const inv = M.IJOpRegistry.get('topHat').resolve({ channels: [{ display: { invert: true } }] }, { radius: 2 }, [0]);
    assert.deepEqual(P(inv.invertedLuts), { 0: true });
    await c.ok('doc.run', { docId: d.id, op: 'math2', params: { op: 'log' }, roi: null, channel: 0 });
    const entry = await c.ok('doc.info', { docId: d.id });
    assert.equal(entry.rev, 1);
  }
  // an inverted LUT swaps bright and dark outliers / light and dark background (RankFilters.rank)
  {
    const so = new Uint8Array(W * H).fill(20); so[4 * W + 5] = 220;
    const d = await c.makeDoc(W, H, 8, [so]);
    await c.run(d.id, 'rankExtra', { type: 'outliersBright', radius: 2, threshold: 50, invertedLuts: { 0: true } });
    assert.equal((await c.pixels(d.id))[4 * W + 5], 220, 'with an inverting LUT "bright" means low values: the high spike is kept');
    const d2 = await c.makeDoc(W, H, 8, [so]);
    await c.run(d2.id, 'rankExtra', { type: 'outliersDark', radius: 2, threshold: 50, invertedLuts: { 0: true } });
    assert.equal((await c.pixels(d2.id))[4 * W + 5], 20, 'and "dark" the high spike');
  }
  // nanBackground ignores a selection (whole image)
  {
    const d = await c.makeDoc(W, H, 32, [Float32Array.from({ length: W * H }, (_, i) => i)]);
    await c.run(d.id, 'nanBackground', { lower: 10, upper: 100 }, { roi: { type: 'rect', x: 2, y: 2, w: 3, h: 3 } });
    const o = await c.pixels(d.id);
    assert.ok(Number.isNaN(o[0]) && Number.isNaN(o[W * H - 1]) && o[50] === 50, 'NaN outside the threshold range everywhere');
  }
  // a line / point selection means the whole image (ImageJ resetRoi)
  {
    const d = await mk(8);
    const ref = await mk(8);
    await c.run(ref.id, 'filter3x3', { type: 'smooth' });
    await c.run(d.id, 'filter3x3', { type: 'smooth' }, { roi: { type: 'line', x1: 0, y1: 0, x2: 5, y2: 5, width: 1 } });
    assert.equal(diff(await c.pixels(d.id), await c.pixels(ref.id)).n, 0);
  }
  console.log('refusals and parameter errors: OK');
}
{
  // cancel: the first progress event cancels the run that emitted it; the document is untouched
  const W = 160, H = 120;
  const ops = [['unsharpMask', { sigma: 2, weight: 0.5 }], ['convolve', { kernel: new Array(25).fill(1), kw: 5, kh: 5, normalize: true }], ['rankExtra', { type: 'variance', radius: 3 }],
    ['topHat', { radius: 3, light: false, dontSubtract: false }], ['filter3x3', { type: 'edges' }], ['math2', { op: 'sqrt' }]];
  for (const [op, params] of ops) {
    const c = startEngine({ sliceMs: 0.001, bandPixels: W * 3 });
    const doc = await c.makeDoc(W, H, 16, [testImage(16, W, H, 5)]);
    const before = Array.from(await c.pixels(doc.id));
    let fired = false;
    c.hooks.push((m) => { if (m.event === 'progress' && !fired) { fired = true; c.fake.onmessage({ data: { id: 9001, cmd: 'cancel', args: { targetId: m.id } } }); } });
    const m = await c.call('doc.run', { docId: doc.id, op, params, roi: null, channel: 0 });
    assert.equal(fired, true, op + ': progress events are emitted');
    assert.equal(m.ok, false, op + ': cancelled');
    assert.equal(m.error.code, 'IJ_CANCELLED');
    assert.deepEqual(Array.from(await c.pixels(doc.id)), before, op + ': a cancelled run leaves the pixels alone');
    assert.equal((await c.ok('doc.info', { docId: doc.id })).undoDepth, 0);
  }
  console.log('cancel: OK');
}

// ── 5. the pure helpers of the dialogs ────────────────────────────────────────────────────────────────────
{
  const H = M.IJFiltersPkg;
  assert.equal(H.parseBinary('11110000'), 240);
  assert.equal(H.parseBinary('+101'), 5);
  assert.equal(H.parseBinary('-101'), -5);
  assert.equal(H.parseBinary('0'), 0);
  assert.equal(H.parseBinary('1'.repeat(31)), 2147483647);
  assert.equal(H.parseBinary('1'.repeat(32)), null, 'Integer.parseInt overflows');
  assert.equal(H.parseBinary('-1' + '0'.repeat(31)), -2147483648);
  for (const bad of ['', '2', '10 1', '1.0', 'abc', '--1', null]) assert.equal(H.parseBinary(bad), null, String(bad));
  assert.equal(H.jint(3.9), 3); assert.equal(H.jint(-3.9), -3); assert.equal(H.jint(NaN), 0); assert.equal(H.jint(Infinity), 2147483647); assert.equal(H.jint(-1e12), -2147483648);
  const k = H.parseKernel('-1 -1 -1\n-1  8 -1\r\n-1 -1 -1\n');
  assert.equal(k.kw, 3); assert.equal(k.kh, 3); assert.deepEqual(P(k.kernel), [-1, -1, -1, -1, 8, -1, -1, -1, -1]);
  assert.equal(H.parseKernel('1 2 3').kh, 1);
  assert.equal(H.parseKernel('').error, 'dlg.flt.kernelEmpty');
  assert.equal(H.parseKernel('1 2\n3').error, 'dlg.flt.kernelRagged');
  assert.equal(H.parseKernel('1 2\n3 4').error, 'dlg.flt.kernelEven');
  assert.equal(H.parseKernel('1 x 3').error, 'dlg.flt.kernelNaN');
  assert.equal(H.parseKernel(new Array(33).fill('1').join(' ')).error, 'dlg.flt.kernelBig');
  assert.equal(H.kernelScale(new Float32Array([1, 2, 1])), 0.25);
  assert.equal(H.kernelScale(new Float32Array([-1, 0, 1])), 1.0, 'a zero sum is not normalised');
  console.log('dialog helpers: OK');
}

// ── 6. review round: ImageJ recordings (tests/fixtures/ij-wave2/flt-review) and scratch accounting ────────
{
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { ROOT } = await import('./harness.mjs');
  const rec = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'ij-wave2', 'flt-review', 'review-probes.json'), 'utf8'));
  const dec = (bd, b64) => { const b = Buffer.from(b64, 'base64'); const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.length); return bd === 8 ? new Uint8Array(ab) : (bd === 16 ? new Uint16Array(ab) : new Float32Array(ab)); };
  const c = startEngine();
  let n = 0;
  for (const [name, fx] of Object.entries(rec.cases)) {
    const im = rec.inputs[fx.input];
    const input = dec(im.bd, im.data);
    const doc = await c.makeDoc(im.w, im.h, im.bd, [input]);
    await c.run(doc.id, fx.op, fx.params, { roi: fx.roi });
    const out = await c.pixels(doc.id);
    const exp = dec(im.bd, fx.output), r = fx.roi;
    let bad = 0, outside = 0;
    for (let y = 0; y < im.h; y++) for (let x = 0; x < im.w; x++) {
      const i = y * im.w + x;
      const inside = x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;
      if (inside) { if (out[i] !== exp[(y - r.y) * r.w + (x - r.x)]) bad++; } else if (out[i] !== input[i]) outside++;
    }
    assert.equal(bad, 0, `${name}: the selection matches ImageJ 1.54p value for value`);
    // Unsharp Mask above sigma 8.5 anchors its downscaled column grid on ImageJ's readFrom = max(0, writeFrom - kRadius):
    // y = 61 and y = 87 are not multiples of the reduction factor (a snapped grid differed on ~2000 pixels).
    // Smooth / Find Edges 8-bit with a rectangle ending at W-2 / H-2: ImageJ's filterEdge also rewrites column W-1 /
    // row H-1 (outside the selection, an ImageJ bug); the port leaves everything outside the rectangle alone.
    assert.equal(outside, 0, `${name}: nothing outside the selection changes`);
    n++;
  }
  assert.ok(n >= 9);
  // scratchBytes never exceeds what the image itself can hold
  const info = { width: 5735, height: 5735, bitDepth: 16, region: { w: 5735, h: 5735 } };
  const us = M.IJOpRegistry.get('unsharpMask').scratchBytes(info, { sigma: 1000, weight: 0.6 });
  assert.ok(us <= 5735 * 5735 * 4 + 5735 * 5735 * 8 + 1e6, `unsharp sigma 1000 declares ${us}`);
  const th = M.IJOpRegistry.get('topHat').scratchBytes(info, { radius: 1000 });
  assert.ok(th <= 5735 * 5735 * 4 * 4 + 1, `top hat radius 1000 declares ${th}`);
  console.log('review probes: OK (' + n + ' ImageJ recordings)');
}

closeAll();
console.log('ij filters: OK');
