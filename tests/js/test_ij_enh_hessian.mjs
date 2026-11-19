// P-enh: Tubeness and Frangi Vesselness (the `tubeness` and `frangi` newdoc ops over the IJHessian band engine).
//
// References and tolerances (PLAN-wave3 §6.3):
//   Frangi: tests/fixtures/ij-wave3/fiji/frangi/*.json = the output of Fiji's net.imagej.ops.commands.filter.FrangiVesselness (imagej-ops 2.2.0, BSD:
//           the op is a direct port of DefaultFrangi, decompiled from the jar). Tolerance asked: <= 1e-5 relative. MEASURED: every pixel of all 20 cases
//           within 1e-6 relative (most bit-identical, doGauss = true bit-identical on FloatType input: the Gauss3 float arithmetic is reproduced; the fixtures feed ArrayImg<FloatType>,
//           so an 8 / 16-bit document is checked against typed_blobs8 / typed_blobs16 = UnsignedByteType / UnsignedShortType input, where the Gaussian is rounded to integers), because the 2 x 2 eigenvalues come
//           from a port of Jama (jama-1.0.3) that is bit-identical to the real library on the 326 tie matrices of tests/fixtures/ij-wave3/enh/jama_ties.json
//           (when |l1| = |l2| to the last bit, which one is "the larger" decides between 0 and a vesselness of 0.09).
//   Tubeness: tests/fixtures/ij-wave3/fiji/tubeness/*.json = Fiji's VIB Tubeness (GPL, never read: recovered from the outputs). Tolerance asked: relative
//           error <= 1e-3 on pixels >= 3 sigma from the border and correlation >= 0.999. MEASURED: relative <= 7e-4 (above 1e-3 of the maximum), correlation > 0.9999999.
//           GAP: every Fiji case with "Use calibration information" ticked has pixelWidth 1, so the calibrated path (sigma / pw, Dxx / pw^2) is checked only
//           against its own consistency (sigma 1 um at 0.5 um/px = sigma 2 px), not against Fiji: a FijiRefs case with pw = 0.5 and the box ticked would close it.
// Band independence: IJHessian.setBandBudget forces bands of one row, a few rows and the whole image: byte-identical results.
//
// Run: node tests/js/test_ij_enh_hessian.mjs
import assert from 'node:assert/strict';
import { M, startEngine, loadFixture, imageOf, decodeData, closeAll } from './ij_enh_support.mjs';

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { console.error('FAIL ' + name); throw e; }
}
const arr = (a) => Array.from(a);
const H = M.IJHessian, E = M.IJEnhPkg;
const f32 = (a) => new Float32Array(a);
const parseList = (s) => s.split(/(?:,|\s)\s*/).map(Number);

function stats(got, exp, W, Hh, border) {
  let maxRef = 0;
  for (let i = 0; i < exp.length; i++) if (Math.abs(exp[i]) > maxRef) maxRef = Math.abs(exp[i]);
  let maxRel = 0, bad = 0, sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0, n = 0;
  for (let y = border; y < Hh - border; y++) for (let x = border; x < W - border; x++) {
    const i = y * W + x, e = exp[i], g = got[i];
    if (Math.abs(e) > 1e-3 * maxRef) { const r = Math.abs(g - e) / Math.abs(e); if (r > maxRel) maxRel = r; if (r > 1e-3) bad++; }
    sa += e; sb += g; saa += e * e; sbb += g * g; sab += e * g; n++;
  }
  const corr = (sab - sa * sb / n) / Math.sqrt((saa - sa * sa / n) * (sbb - sb * sb / n));
  return { maxRel, bad, corr };
}

// ── Tubeness ───────────────────────────────────────────────────────────────────────────────────────────────
await test('Tubeness: Fiji reference outputs, every sigma / calibration case: relative error <= 1e-3 away from the border, correlation >= 0.999, outer ring 0', async () => {
  const c = startEngine();
  let cases = 0;
  for (const n of ['blobs_8bit', 'vessels_8bit', 'blobs_16bit']) {
    const fx = loadFixture('fiji/tubeness/' + n);
    const W = fx.input.width, Hh = fx.input.height, bd = fx.input.bitDepth, inp = imageOf(fx.input);
    for (const cs of fx.cases) {
      const d = await c.makeDoc(W, Hh, bd, [inp], { calibration: { pixelWidth: cs.params.pixelWidth, pixelHeight: cs.params.pixelWidth, unit: 'um' } });
      const r = await c.ok('doc.run', { docId: d.id, op: 'tubeness', params: { sigma: cs.params.sigma, useCalibration: cs.params.useCalibration }, roi: null, channel: 0 });
      const nd = r.newDocIds[0];
      assert.equal(r.newInfos[0].bitDepth, 32); assert.equal(r.newInfos[0].name, 'tubeness of img');
      const got = await c.pixels(nd), exp = imageOf(cs.result.created[0].image);
      const s = stats(got, exp, W, Hh, Math.ceil(3 * cs.params.sigma));
      assert.ok(s.maxRel <= 1e-3, `${n} ${JSON.stringify(cs.params)}: relative error ${s.maxRel}`);
      assert.ok(s.corr >= 0.999, `${n} ${JSON.stringify(cs.params)}: correlation ${s.corr}`);
      for (let x = 0; x < W; x++) assert.ok(got[x] === 0 && got[(Hh - 1) * W + x] === 0, 'top and bottom rows are 0');
      for (let y = 0; y < Hh; y++) assert.ok(got[y * W] === 0 && got[y * W + W - 1] === 0, 'left and right columns are 0');
      cases++;
    }
  }
  assert.equal(cases, 18);
  closeAll();
});

await test('Tubeness: "use calibration" reads the sigma in calibrated units: sigma 1 um at 0.5 um/px = sigma 2 px; without it the calibration is ignored; anisotropic pixels differ', async () => {
  const c = startEngine();
  const fx = loadFixture('fiji/tubeness/vessels_8bit');
  const W = fx.input.width, Hh = fx.input.height, inp = imageOf(fx.input);
  const run = async (cal, params) => {
    const d = await c.makeDoc(W, Hh, 8, [inp], { calibration: cal });
    const r = await c.ok('doc.run', { docId: d.id, op: 'tubeness', params, roi: null, channel: 0 });
    return arr(await c.pixels(r.newDocIds[0]));
  };
  const um = (pw, ph) => ({ pixelWidth: pw, pixelHeight: ph, unit: 'um' });
  const a = await run(um(0.5, 0.5), { sigma: 1, useCalibration: true });
  const b = await run(um(1, 1), { sigma: 2, useCalibration: false });
  for (let i = 0; i < a.length; i++) assert.ok(Math.abs(a[i] - b[i]) <= 1e-5 * Math.max(1, Math.abs(b[i])), `pixel ${i}: ${a[i]} vs ${b[i]}`);
  const noCal = await run(um(0.5, 0.5), { sigma: 2, useCalibration: false });
  assert.deepEqual(noCal, b, 'a calibration that is not used changes nothing');
  const aniso = await run(um(1, 2), { sigma: 2, useCalibration: true });
  assert.notDeepEqual(aniso, b, 'anisotropic pixels change the result');
  closeAll();
});

await test('Tubeness: 1 / 2 / 3-pixel-wide images (all border), a flat image (all 0), a bright line responds along the line', async () => {
  const c = startEngine();
  for (const [W, Hh] of [[1, 1], [2, 5], [5, 2], [3, 3], [1, 9]]) {
    const d = await c.makeDoc(W, Hh, 8, [Uint8Array.from({ length: W * Hh }, (_, i) => (i * 37) & 255)]);
    const r = await c.ok('doc.run', { docId: d.id, op: 'tubeness', params: { sigma: 1, useCalibration: false }, roi: null, channel: 0 });
    const out = await c.pixels(r.newDocIds[0]);
    if (W < 3 || Hh < 3) assert.ok(out.every((v) => v === 0), `${W}x${Hh}`);
  }
  const W = 40, Hh = 40, line = new Uint8Array(W * Hh);
  for (let y = 0; y < Hh; y++) for (let x = 0; x < W; x++) line[y * W + x] = Math.abs(x - 20) <= 1 ? 200 : 20;
  const d = await c.makeDoc(W, Hh, 8, [line]);
  const r = await c.ok('doc.run', { docId: d.id, op: 'tubeness', params: { sigma: 1.5, useCalibration: false }, roi: null, channel: 0 });
  const out = await c.pixels(r.newDocIds[0]);
  assert.ok(out[20 * W + 20] > 50, 'on the line');
  assert.equal(out[20 * W + 5], 0, 'away from the line');
  const flat = await c.makeDoc(W, Hh, 8, [new Uint8Array(W * Hh).fill(77)]);
  const r2 = await c.ok('doc.run', { docId: flat.id, op: 'tubeness', params: { sigma: 2, useCalibration: false }, roi: null, channel: 0 });
  assert.ok((await c.pixels(r2.newDocIds[0])).every((v) => v === 0));
  closeAll();
});

await test('Tubeness and Frangi work on the channel the request names; the source is untouched; 8 / 16 / 32-bit sources are accepted', async () => {
  const c = startEngine();
  const W = 30, Hh = 24;
  const mk = (bd, k) => { const T = bd === 8 ? Uint8Array : bd === 16 ? Uint16Array : Float32Array; return T.from({ length: W * Hh }, (_, i) => ((i * (7 + k) + ((i / W) | 0) * 13) % 200) * (bd === 16 ? 100 : 1)); };
  for (const bd of [8, 16, 32]) {
    const a = mk(bd, 0), b = mk(bd, 5);
    const d = await c.makeDoc(W, Hh, bd, [a, b]);
    for (const [op, params] of [['tubeness', { sigma: 1, useCalibration: false }], ['frangi', { doGauss: false, spacing: [1, 1], scales: [2] }]]) {
      const r1 = await c.ok('doc.run', { docId: d.id, op, params, roi: null, channel: 1 });
      const r0 = await c.ok('doc.run', { docId: d.id, op, params, roi: null, channel: 0 });
      assert.notDeepEqual(arr(await c.pixels(r1.newDocIds[0])), arr(await c.pixels(r0.newDocIds[0])), `${op} ${bd}-bit: channel 1 differs from channel 0`);
      assert.equal(r1.newInfos[0].channels.length, op === 'frangi' ? 1 : 1);
    }
    assert.deepEqual(arr(await c.pixels(d.id, 0)), arr(a)); assert.deepEqual(arr(await c.pixels(d.id, 1)), arr(b));
  }
  closeAll();
});

// ── Frangi ─────────────────────────────────────────────────────────────────────────────────────────────────
await test('Frangi: all Fiji reference planes (20 cases, 1-3 scales, doGauss, anisotropic spacing) within 1e-6 relative; one 32-bit channel per scale named "Scale <s>"', async () => {
  const c = startEngine();
  let planes = 0, exact = 0, total = 0;
  for (const n of ['blobs', 'disks', 'fibres', 'vessels']) {
    const fx = loadFixture('fiji/frangi/' + n);
    const W = fx.input.width, Hh = fx.input.height, inp = imageOf(fx.input);
    for (const cs of fx.cases) {
      const scales = parseList(cs.params.scales), spacing = parseList(cs.params.spacing);
      // the fixtures feed ArrayImg<FloatType>: a 32-bit document (an 8 / 16-bit one rounds the Gaussian, see the typed test below)
      const d = await c.makeDoc(W, Hh, 32, [Float32Array.from(inp)]);
      const r = await c.ok('doc.run', { docId: d.id, op: 'frangi', params: { doGauss: cs.params.doGauss, spacing, scales }, roi: null, channel: 0 });
      assert.equal(r.newDocIds.length, 1);
      const info = r.newInfos[0];
      assert.equal(info.bitDepth, 32); assert.equal(info.channels.length, scales.length);
      assert.deepEqual(arr(info.channels.map((ch) => ch.name)), scales.map((s) => 'Scale ' + s));
      const exp = decodeData(cs.result.values);
      for (let k = 0; k < scales.length; k++) {
        const got = await c.pixels(r.newDocIds[0], k);
        for (let i = 0; i < W * Hh; i++) {
          const e = exp[k * W * Hh + i], g = got[i], dd = Math.abs(g - e);
          total++;
          if (dd === 0) exact++;
          assert.ok(dd <= 1e-6 * Math.max(Math.abs(e), 1e-3), `${n} ${JSON.stringify(cs.params)} scale ${scales[k]} pixel ${i}: ${g} vs ${e}`);
        }
        planes++;
      }
    }
  }
  assert.equal(planes, 4 * (2 + 2 + 1 + 3 + 1));
  assert.ok(exact / total > 0.999, 'bit-identical on ' + exact + ' / ' + total);
  closeAll();
});

// The Fiji GUI hands an 8 / 16-bit image to the command as UnsignedByteType / UnsignedShortType; with "Apply Gaussian at each scale" the
// smoothed image has the INPUT's type, so it is rounded to integers (Util.round(float)) before the Hessian. Reference: tools/ij_fixtures/fiji/FrangiTyped.java.
for (const [name, bd] of [['typed_blobs8', 8], ['typed_blobs16', 16]]) {
  await test(`Frangi on a ${bd}-bit document (UnsignedShortType / UnsignedByteType input of the Fiji GUI): doGauss rounds the smoothed image like Fiji, within 1e-6 relative`, async () => {
    const c = startEngine();
    const fx = loadFixture('fiji/frangi/' + name);
    const W = fx.input.width, Hh = fx.input.height, inp = imageOf(fx.input);
    let gauss = 0;
    for (const cs of fx.cases) {
      const scales = parseList(cs.params.scales), spacing = parseList(cs.params.spacing);
      const d = await c.makeDoc(W, Hh, bd, [bd === 8 ? Uint8Array.from(inp) : Uint16Array.from(inp)]);
      const r = await c.ok('doc.run', { docId: d.id, op: 'frangi', params: { doGauss: cs.params.doGauss, spacing, scales }, roi: null, channel: 0 });
      const exp = decodeData(cs.result.values);
      for (let k = 0; k < scales.length; k++) {
        const got = await c.pixels(r.newDocIds[0], k);
        for (let i = 0; i < W * Hh; i++) {
          const e = exp[k * W * Hh + i], dd = Math.abs(got[i] - e);
          assert.ok(dd <= 1e-6 * Math.max(Math.abs(e), 1e-3), `${name} ${JSON.stringify(cs.params)} scale ${scales[k]} pixel ${i}: ${got[i]} vs ${e}`);
        }
      }
      if (cs.params.doGauss) gauss++;
    }
    assert.equal(gauss, 2);
    // and the rounding is what makes it match: the unrounded (32-bit) path is measurably different on the same values
    const cs = fx.cases[0], scales = parseList(cs.params.scales), spacing = parseList(cs.params.spacing);
    const d32 = await c.makeDoc(W, Hh, 32, [Float32Array.from(inp)]);
    const r32 = await c.ok('doc.run', { docId: d32.id, op: 'frangi', params: { doGauss: true, spacing, scales }, roi: null, channel: 0 });
    const exp = decodeData(cs.result.values), got32 = await c.pixels(r32.newDocIds[0], 0);
    let off = 0;
    for (let i = 0; i < W * Hh; i++) if (Math.abs(got32[i] - exp[i]) > 1e-6 * Math.max(Math.abs(exp[i]), 1e-3)) off++;
    assert.ok(off > 0, 'a float document does not round: it differs from the integer-typed reference');
    closeAll();
  });
}

await test('the Jama port (symmetric 2 x 2 eigenvalues, tred2 + tql2) is bit-identical to jama-1.0.3 on the 326 tie matrices of the Frangi fixtures', async () => {
  const fx = loadFixture('enh/jama_ties');
  assert.equal(fx.cases.length, 326);
  const dv = new DataView(new ArrayBuffer(8));
  const bits = (x) => { dv.setFloat64(0, x); return dv.getBigInt64(0).toString(); };
  for (const cs of fx.cases) {
    const r = E.jamaEig2(cs.h00, cs.h01, cs.h11);
    assert.deepEqual([bits(r[0]), bits(r[1])], cs.bits, JSON.stringify([cs.h00, cs.h01, cs.h11]));
  }
  // and it agrees with the closed form where nothing ties
  for (let t = 0; t < 2000; t++) {
    const a = Math.sin(t * 12.9898) * 10, b = Math.sin(t * 78.233) * 10, c2 = Math.cos(t * 3.7) * 10;
    const r = E.jamaEig2(a, b, c2), tr = (a + c2) / 2, e = Math.sqrt(((a - c2) / 2) ** 2 + b * b);
    assert.ok(Math.abs(r[0] - (tr - e)) < 1e-12 && Math.abs(r[1] - (tr + e)) < 1e-12);
  }
});

await test('Gauss3 kernels as imglib2 builds them: size, normalisation, the smoothed edge', async () => {
  for (const s of [1, 2, 3, 5, 0.4]) {
    const g = H.gauss3Kernel(s);
    assert.equal(g.R, Math.max(2, Math.trunc(3 * s + 0.5) + 1) - 1, 'radius of sigma ' + s);
    assert.equal(g.k.length, 2 * g.R + 1);
    let sum = 0; for (const v of g.k) sum += v;
    assert.ok(Math.abs(sum - 1) < 1e-6, 'sums to 1: ' + sum);
    for (let i = 0; i < g.R; i++) assert.equal(g.k[g.R - i], g.k[g.R + i], 'symmetric');
    for (let i = 1; i <= g.R; i++) assert.ok(g.k[g.R + i] <= g.k[g.R + i - 1], 'monotone');
  }
  const k = H.gaussKernel(2, 6); let sum = 0; for (const v of k) sum += v;
  assert.ok(Math.abs(sum - 1) < 1e-14);
});

await test('mirror boundary without repeating the edge pixel: -1 -> 1, n -> n-2, any distance, size 1 and 2', async () => {
  for (const [i, n, w] of [[-1, 5, 1], [-2, 5, 2], [5, 5, 3], [6, 5, 2], [-5, 5, 3], [9, 5, 1], [13, 5, 3], [0, 1, 0], [7, 1, 0], [-3, 2, 1], [2, 2, 0], [3, 2, 1], [-1, 3, 1], [3, 3, 1]]) assert.equal(H.mirror(i, n), w, `mirror(${i}, ${n})`);
});

// ── band independence ──────────────────────────────────────────────────────────────────────────────────────
await test('IJHessian bands: a one-row band, a few rows and the whole image give the same bytes (Tubeness; Frangi with and without the Gaussian)', async () => {
  const W = 61, Hh = 47, inp = Uint8Array.from({ length: W * Hh }, (_, i) => (((i * 2654435761) >>> 24) & 255) ^ ((i % W) * 3));
  const runAll = async () => {
    const c = startEngine();
    const d = await c.makeDoc(W, Hh, 8, [inp]);
    const outs = [];
    for (const [op, params] of [['tubeness', { sigma: 2.5, useCalibration: false }], ['frangi', { doGauss: false, spacing: [1, 1.5], scales: [1, 3] }], ['frangi', { doGauss: true, spacing: [1, 1], scales: [2, 4] }]]) {
      const r = await c.ok('doc.run', { docId: d.id, op, params, roi: null, channel: 0 });
      const n = r.newInfos[0].channels.length;
      for (let k = 0; k < n; k++) outs.push(arr(await c.pixels(r.newDocIds[0], k)));
    }
    closeAll();
    return outs;
  };
  const whole = await runAll();
  for (const budget of [1, 3 * W, 12 * W, 40 * W]) {
    const old = H.setBandBudget(budget);
    try {
      const got = await runAll();
      assert.deepEqual(got, whole, 'band budget ' + budget);
    } finally { H.setBandBudget(old); }
  }
});

await test('the smoother reads rows of the image only (mirror rows beyond the edge) and never writes into its input', async () => {
  const W = 9, Hh = 7, src = Float32Array.from({ length: W * Hh }, (_, i) => (i * 7) % 23);
  const copy = f32(src);
  const g = H.gaussKernel(1.2, 4);
  const sm = H.makeSmoother(src, W, Hh, { k: g, R: 4 }, { k: g, R: 4 }, false);
  const dst = new Float64Array(3 * W);
  await sm.rows(-1, 1, dst, null);
  await sm.rows(Hh - 1, Hh + 1, new Float64Array(3 * W), null);
  assert.deepEqual(arr(src), arr(copy), 'input untouched');
  // row -1 of the smoothed image is its row 1 (mirror), and row Hh is row Hh-2
  const a = new Float64Array(W), b = new Float64Array(W);
  const top = new Float64Array(3 * W); await sm.rows(-1, 1, top, null);
  const one = new Float64Array(W); await sm.rows(1, 1, one, null);
  for (let x = 0; x < W; x++) a[x] = top[x], b[x] = one[x];
  assert.deepEqual(arr(a), arr(b), 'mirror row');
});

await test('the smoother keeps the horizontal pass between bands: one-row bands cost ~H + 2 Ry rows, not H (2 Ry + 1); any order of calls gives the bytes of a fresh smoother', async () => {
  const W = 40, Hh = 60, src = Float32Array.from({ length: W * Hh }, (_, i) => ((i * 2654435761) >>> 20) & 1023);
  const Ry = 12, g = H.gaussKernel(4, Ry);
  const kx = { k: g, R: Ry }, ky = { k: g, R: Ry };
  for (const float of [false, true]) {
    const fresh = async (a, b) => { const s = H.makeSmoother(src, W, Hh, kx, ky, float); const d = new Float64Array((b - a + 1) * W); await s.rows(a, b, d, null); return arr(d); };
    const sm = H.makeSmoother(src, W, Hh, kx, ky, float);
    for (let t = 0; t < Hh; t++) {
      const d = new Float64Array(W); await sm.rows(t, t, d, null);
      assert.deepEqual(arr(d), await fresh(t, t), 'row ' + t);
    }
    assert.ok(sm.stats.hrows <= Hh + 2 * Ry + Ry, `${float}: ${sm.stats.hrows} horizontal rows for ${Hh} one-row bands (no reuse would be ${Hh * (2 * Ry + 1)})`);
    // forward, backward, overlapping, disjoint and edge-crossing calls on ONE smoother
    for (const [a, b] of [[10, 20], [5, 14], [40, 41], [-3, 4], [55, 62], [0, 59], [30, 30], [29, 45], [-12, -1]]) {
      const d = new Float64Array((b - a + 1) * W); await sm.rows(a, b, d, null);
      assert.deepEqual(arr(d), await fresh(a, b), `rows ${a}..${b}`);
    }
  }
});

await test('roundOut stores like an integer-typed image: Util.round(float) = floor(f + 0.5f) once, at the final store', async () => {
  const W = 17, Hh = 15, src = Float32Array.from({ length: W * Hh }, (_, i) => (i * 37) % 251);
  const { k, R } = H.gauss3Kernel(2);
  const a = H.makeSmoother(src, W, Hh, { k, R }, { k, R }, true), b = H.makeSmoother(src, W, Hh, { k, R }, { k, R }, true, true);
  const da = new Float64Array(Hh * W), db = new Float64Array(Hh * W);
  await a.rows(0, Hh - 1, da, null); await b.rows(0, Hh - 1, db, null);
  let frac = 0;
  for (let i = 0; i < da.length; i++) {
    assert.equal(db[i], Math.floor(Math.fround(da[i] + 0.5)), 'pixel ' + i);
    assert.ok(Number.isInteger(db[i]));
    if (!Number.isInteger(da[i])) frac++;
  }
  assert.ok(frac > 0, 'the unrounded smoothing has fractions: the test means something');
});

// ── refusals, memory, cancel, parsers ──────────────────────────────────────────────────────────────────────
await test('refusals: bad sigma / scales / spacing (IJ_BAD_ARGS); nothing is created', async () => {
  const c = startEngine();
  const a = await c.makeDoc(12, 12, 8, [new Uint8Array(144).fill(5)]);
  for (const [op, p] of [
    ['tubeness', { sigma: 0, useCalibration: true }], ['tubeness', { sigma: -1, useCalibration: true }], ['tubeness', { sigma: 101, useCalibration: true }], ['tubeness', { sigma: NaN, useCalibration: true }],
    ['tubeness', { sigma: 1 }], ['tubeness', { sigma: 1, useCalibration: 1 }], ['tubeness', { sigma: 1, useCalibration: true, pixelWidth: 0 }],
    ['frangi', { doGauss: false, spacing: [1, 1], scales: [] }], ['frangi', { doGauss: false, spacing: [1, 1], scales: [0] }], ['frangi', { doGauss: false, spacing: [1, 1], scales: [2.5] }],
    ['frangi', { doGauss: false, spacing: [1, 1], scales: [65] }], ['frangi', { doGauss: false, spacing: [1, 1], scales: new Array(33).fill(1) }], ['frangi', { doGauss: false, spacing: [1], scales: [2] }],
    ['frangi', { doGauss: false, spacing: [1, 0], scales: [2] }], ['frangi', { doGauss: 'no', spacing: [1, 1], scales: [2] }], ['frangi', { spacing: [1, 1], scales: [2] }]]) {
    const e = await c.err('doc.run', { docId: a.id, op, params: p, roi: null, channel: 0 });
    assert.equal(e.code, 'IJ_BAD_ARGS', op + ' ' + JSON.stringify(p));
  }
  assert.equal((await c.ok('doc.list', {})).docs.length, 1, 'no document created by a refused step');
  closeAll();
});

await test('memory: the declared peak includes the output planes; an image whose planes do not fit is refused before the run; cancel creates no document', async () => {
  const sp = M.IJOpRegistry.get('frangi'), st = M.IJOpRegistry.get('tubeness');
  const info = { width: 4000, height: 3000, bitDepth: 16, channels: 1, region: null };
  assert.ok(sp.scratchBytes(info, { doGauss: true, spacing: [1, 1], scales: [2, 5, 8] }) >= 3 * 4000 * 3000 * 4, 'one float plane per scale');
  assert.ok(st.scratchBytes(info, { sigma: 2, useCalibration: false, pixelWidth: 1, pixelHeight: 1 }) >= 4000 * 3000 * 4);
  assert.ok(sp.scratchBytes(info, { doGauss: false, spacing: [1, 1], scales: [2] }) < 4000 * 3000 * 4 + 64 * 1024 * 1024, 'bands, not whole planes of doubles');
  {
    const c = startEngine({ budgetBytes: 2000000 });
    const W = 400, Hh = 300;
    const d = await c.makeDoc(W, Hh, 8, [new Uint8Array(W * Hh).fill(9)]);
    const e = await c.err('doc.run', { docId: d.id, op: 'frangi', params: { doGauss: false, spacing: [1, 1], scales: [1, 2, 3, 4, 5] }, roi: null, channel: 0 });
    assert.equal(e.code, 'IJ_OVER_BUDGET');
    closeAll();
  }
  const c = startEngine();
  const W = 700, Hh = 500;
  const d = await c.makeDoc(W, Hh, 8, [Uint8Array.from({ length: W * Hh }, (_, i) => (i * 31) & 255)]);
  let seen = 0;
  c.hooks.push((m) => { if (m.event === 'progress') { seen++; if (seen === 2) c.fake.onmessage({ data: { id: 777003, cmd: 'cancel', args: { targetId: m.id } } }); } });
  const r = await c.call('doc.run', { docId: d.id, op: 'frangi', params: { doGauss: true, spacing: [1, 1], scales: [3, 6, 9] }, roi: null, channel: 0 });
  assert.equal(r.ok, false); assert.equal(r.error.code, 'IJ_CANCELLED');
  assert.equal((await c.ok('doc.list', {})).docs.length, 1, 'a cancelled step creates no document');
  assert.ok(seen >= 2);
  closeAll();
});

await test('the command parsers: Frangi spacing (cut / filled with the last value) and scale lists as FrangiVesselness reads them', async () => {
  assert.deepEqual(arr(E.parseSpacing('1, 1', 2)), [1, 1]);
  assert.deepEqual(arr(E.parseSpacing('1,2', 2)), [1, 2]);
  assert.deepEqual(arr(E.parseSpacing('1.5', 2)), [1.5, 1.5], 'too few values: the last one fills the rest');
  assert.deepEqual(arr(E.parseSpacing('1 2 3', 2)), [1, 2], 'too many values are cut');
  assert.deepEqual(arr(E.parseSpacing('0.5   2', 2)), [0.5, 2]);
  assert.equal(E.parseSpacing('', 2), null); assert.equal(E.parseSpacing('a, b', 2), null);
  assert.deepEqual(arr(E.parseNumberList('2, 5', true)), [2, 5]);
  assert.deepEqual(arr(E.parseNumberList('1 2 3', true)), [1, 2, 3]);
  assert.deepEqual(arr(E.parseNumberList('3', true)), [3]);
  assert.equal(E.parseNumberList('2.5', true), null, 'Integer.parseInt refuses 2.5');
  assert.equal(E.parseNumberList('2,, 5', true), null, 'an empty token makes parseInt throw');
  assert.deepEqual(arr(E.parseNumberList('2, 5,', true)), [2, 5], 'String.split drops the trailing empty token');
  assert.equal(E.parseNumberList('x', true), null);
});

console.log(`ij enh hessian: OK (${passed} groups)`);
