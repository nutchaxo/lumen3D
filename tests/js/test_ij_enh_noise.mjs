// P-enh: Add Noise / Add Specified Noise / Salt and Pepper (addNoise, saltAndPepper) against ImageJ 1.54p.
//
// tests/fixtures/ij-wave3/enh/{noise_u8,noise_u16,noise_f32,noise_stream_u8,noise_stream_u16,salt_and_pepper}.json were recorded from
// the real ij.process.{Byte,Short,Float}Processor.noise and ij.plugin.filter.SaltAndPepper with a seeded java.util.Random.
// Tolerance: BIT-IDENTICAL (the generator is IJShared.JavaRandom, an exact java.util.Random; float noise is a float addition).
//
// Also: the engine's band size does not change the result (the ops are `whole`: the rows of the selection's bounding box
// are visited in one pass, whatever bandPixels is: 1 row / 7 rows / everything); several channels of one run share ONE stream in
// index order; a selection leaves the pixels outside its mask alone; the ops never write into their input (the engine
// runs with verifyInputs); refusals (bad seed / sd / percent, 16-bit Salt and Pepper); memory declaration; cancel leaves
// the document untouched; a replay of the journaled params gives the same noise.
//
// Run: node tests/js/test_ij_enh_noise.mjs
import assert from 'node:assert/strict';
import { M, startEngine, loadFixture, imageOf, roiOf, diff, closeAll } from './ij_enh_support.mjs';

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { console.error('FAIL ' + name); throw e; }
}
const arr = (a) => Array.from(a);

const BANDS = [['1 row', (W) => W], ['7 rows', (W) => 7 * W], ['whole', () => 1 << 20]];

for (const [file, bd] of [['enh/noise_u8', 8], ['enh/noise_u16', 16], ['enh/noise_f32', 32]]) {
  await test(`${file}: every seeded case is bit-identical to ImageJ (selection cases included), for 1-row / 7-row / whole bands`, async () => {
    const fx = loadFixture(file);
    const W = fx.input.width, H = fx.input.height, inp = imageOf(fx.input);
    for (const [bandName, bandOf] of BANDS) {
      const c = startEngine({ bandPixels: bandOf(W) });
      for (const cs of fx.cases) {
        const d = await c.makeDoc(W, H, bd, [inp]);
        const roi = roiOf(cs, W, H);
        await c.run(d.id, 'addNoise', cs.params, { roi });
        const r = diff(await c.pixels(d.id), imageOf(cs.output));
        assert.equal(r.n, 0, `${file} ${JSON.stringify(cs.params)} ${cs.roi ? cs.roi.type : 'no selection'} (${bandName}): ${r.n} pixels differ, first at ${r.first}`);
      }
    }
    closeAll();
  });
}

for (const [file, bd] of [['enh/noise_stream_u8', 8], ['enh/noise_stream_u16', 16]]) {
  await test(`${file}: three channels of one run take their noise from ONE seeded stream, in index order (ImageProcessor's static rnd)`, async () => {
    const fx = loadFixture(file);
    const W = fx.inputs[0].width, H = fx.inputs[0].height;
    const c = startEngine();
    const d = await c.makeDoc(W, H, bd, fx.inputs.map(imageOf));
    await c.ok('doc.run', { docId: d.id, op: 'addNoise', params: fx.params, roi: null, channel: 'all' });
    for (let k = 0; k < 3; k++) {
      const r = diff(await c.pixels(d.id, k), imageOf(fx.outputs[k]));
      assert.equal(r.n, 0, `channel ${k}: ${r.n} pixels differ`);
    }
    // the same channels one by one, with the same seed each time, are NOT the stream: channel 1 differs from the stream's channel 1
    const e = await c.makeDoc(W, H, bd, fx.inputs.map(imageOf));
    await c.ok('doc.run', { docId: e.id, op: 'addNoise', params: fx.params, roi: null, channel: 1 });
    assert.ok(diff(await c.pixels(e.id, 1), imageOf(fx.outputs[1])).n > 0, 'a run on channel 1 alone restarts the stream');
    closeAll();
  });
}

await test('enh/salt_and_pepper: bit-identical to ImageJ (n/2 white-then-black hits, selection case included), for every band size', async () => {
  const fx = loadFixture('enh/salt_and_pepper');
  const W = fx.input.width, H = fx.input.height, inp = imageOf(fx.input);
  for (const [bandName, bandOf] of BANDS) {
    const c = startEngine({ bandPixels: bandOf(W) });
    for (const cs of fx.cases) {
      const d = await c.makeDoc(W, H, 8, [inp]);
      await c.run(d.id, 'saltAndPepper', cs.params, { roi: roiOf(cs, W, H) });
      const r = diff(await c.pixels(d.id), imageOf(cs.output));
      assert.equal(r.n, 0, `${JSON.stringify(cs.params)} ${cs.roi ? 'selection' : 'whole'} (${bandName}): ${r.n} pixels differ`);
    }
  }
  closeAll();
});

await test('a selection: pixels outside its mask are untouched, the stream still runs over the whole bounding box', async () => {
  const fx = loadFixture('enh/noise_u8');
  const W = fx.input.width, H = fx.input.height, inp = imageOf(fx.input);
  const oval = fx.cases.find((x) => x.roi && x.roi.type === 'oval');
  const c = startEngine();
  const d = await c.makeDoc(W, H, 8, [inp]);
  await c.run(d.id, 'addNoise', oval.params, { roi: roiOf(oval, W, H) });
  const got = await c.pixels(d.id), m = oval.roi.mask;
  const md = Array.isArray(m.data) ? m.data : null;
  assert.ok(md, 'the fixture lists the mask');
  let inside = 0, changed = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x, mi = (y - m.y) * m.w + (x - m.x);
    const in_ = x >= m.x && x < m.x + m.w && y >= m.y && y < m.y + m.h && md[mi] !== 0;
    if (in_) inside++; else assert.equal(got[i], inp[i], `pixel ${x},${y} outside the mask`);
    if (got[i] !== inp[i]) changed++;
  }
  assert.ok(inside > 0 && changed > 0 && changed <= inside);
  closeAll();
});

await test('determinism: the journaled params are the whole story (same seed, same noise; another seed, other noise); the input is never written', async () => {
  const fx = loadFixture('enh/noise_u16');
  const W = fx.input.width, H = fx.input.height, inp = imageOf(fx.input);
  const c = startEngine();
  const out = [];
  for (const seed of [5, 5, 6]) {
    const d = await c.makeDoc(W, H, 16, [inp]);
    await c.run(d.id, 'addNoise', { seed, sd: 25 });
    out.push(arr(await c.pixels(d.id)));
  }
  assert.deepEqual(out[0], out[1], 'same seed');
  assert.notDeepEqual(out[0], out[2], 'another seed');
  // undo, redo: redo reinstates the stored result
  const d = await c.makeDoc(W, H, 16, [inp]);
  await c.run(d.id, 'addNoise', { seed: 5, sd: 25 });
  await c.ok('doc.undo', { docId: d.id });
  assert.deepEqual(arr(await c.pixels(d.id)), arr(inp));
  await c.ok('doc.redo', { docId: d.id });
  assert.deepEqual(arr(await c.pixels(d.id)), out[0]);
  closeAll();
});

await test('refusals: bad seed / sd / percent, 16- and 32-bit Salt and Pepper', async () => {
  const c = startEngine();
  const a = await c.makeDoc(8, 8, 8, [new Uint8Array(64).fill(100)]);
  for (const bad of [{ seed: 1.5, sd: 25 }, { seed: NaN, sd: 25 }, { seed: 1, sd: -1 }, { seed: 1, sd: NaN }, { seed: 1, sd: M.IJEnhPkg.NOISE_MAX_SD + 1 }, { seed: 1 }, { sd: 25 }]) {
    const e = await c.err('doc.run', { docId: a.id, op: 'addNoise', params: bad, roi: null, channel: 0 });
    assert.equal(e.code, 'IJ_BAD_ARGS', JSON.stringify(bad));
  }
  for (const bad of [{ seed: 1, percent: 0 }, { seed: 1, percent: 1.5 }, { seed: 1, percent: NaN }, { percent: 0.05 }]) {
    const e = await c.err('doc.run', { docId: a.id, op: 'saltAndPepper', params: bad, roi: null, channel: 0 });
    assert.equal(e.code, 'IJ_BAD_ARGS', JSON.stringify(bad));
  }
  for (const bd of [16, 32]) {
    const d = await c.makeDoc(8, 8, bd, [bd === 16 ? new Uint16Array(64) : new Float32Array(64)]);
    const e = await c.err('doc.run', { docId: d.id, op: 'saltAndPepper', params: { seed: 1, percent: 0.05 }, roi: null, channel: 0 });
    assert.equal(e.code, 'IJ_BAD_TYPE', bd + '-bit');
  }
  assert.deepEqual(arr(await c.pixels(a.id)), arr(new Uint8Array(64).fill(100)), 'a refused step changes nothing');
  closeAll();
});

await test('memory: scratchBytes is declared, a budget that cannot hold it refuses BEFORE the run; the step never started', async () => {
  const spec = M.IJOpRegistry.get('addNoise');
  const need = spec.scratchBytes({ width: 1000, height: 1000, bitDepth: 16, channels: 1, region: null });
  assert.ok(need >= 1000 * 1000 * 2, 'at least the crop of the region');
  const c = startEngine({ budgetBytes: 3000000 });
  const W = 700, H = 700;
  const inp = new Uint16Array(W * H).fill(1000);
  const d = await c.makeDoc(W, H, 16, [inp]);
  const e = await c.err('doc.run', { docId: d.id, op: 'addNoise', params: { seed: 1, sd: 25 }, roi: null, channel: 0 });
  assert.equal(e.code, 'IJ_OVER_BUDGET');
  assert.deepEqual(arr((await c.pixels(d.id)).subarray(0, 50)), arr(inp.subarray(0, 50)), 'untouched');
  closeAll();
});

await test('cancel in the middle leaves the document untouched; progress is reported', async () => {
  const c = startEngine();
  const W = 1200, H = 1200;
  const d = await c.makeDoc(W, H, 8, [new Uint8Array(W * H).fill(120)]);
  const before = arr((await c.pixels(d.id)).subarray(0, 4096));
  let sawProgress = 0;
  c.hooks.push((m) => { if (m.event === 'progress') { sawProgress++; if (sawProgress === 2) c.fake.onmessage({ data: { id: 777001, cmd: 'cancel', args: { targetId: m.id } } }); } });
  const r = await c.call('doc.run', { docId: d.id, op: 'addNoise', params: { seed: 3, sd: 40 }, roi: null, channel: 0 });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'IJ_CANCELLED');
  assert.ok(sawProgress >= 2, 'progress events ' + sawProgress);
  assert.deepEqual(arr((await c.pixels(d.id)).subarray(0, 4096)), before, 'untouched after the cancel');
  closeAll();
});

await test('a huge sd on an 8-bit image still serves cancel / progress inside the redraw loop (every NOISE_CHECK_DRAWS draws), and the result is unchanged', async () => {
  const spec = M.IJOpRegistry.get('addNoise');
  const N = M.IJEnhPkg.NOISE_CHECK_DRAWS;
  const run = async (sd, cancelAfter) => {
    let checks = 0, ticks = 0;
    const ctx = { check() { checks++; if (cancelAfter && checks >= cancelAfter) { const e = new Error('cancelled'); e.code = 'IJ_CANCELLED'; throw e; } }, tick: async () => { ticks++; } };
    const prep = spec.prepare({ bitDepth: 8 }, 0, { seed: 5, sd }, ctx);
    const out = await prep.fn({ data: Uint8Array.from({ length: 64 }, (_, i) => (i * 37) & 255), width: 8, height: 8 });
    return { out: arr(out), checks, ticks };
  };
  const big = await run(100000, 0);
  // ~sd * 2.5 / 256 ~ 1000 draws per pixel: well over the 8 per-row checks of before (24 now)
  assert.ok(big.checks + big.ticks > 20, 'checks inside the redraw loop: ' + (big.checks + big.ticks));
  assert.ok(big.out.every((v) => v >= 0 && v <= 255));
  // a cancel is honoured within a row (before: only between rows)
  await assert.rejects(() => run(100000, 5), (e) => e.code === 'IJ_CANCELLED');
  // an sd that never redraws many times is unaffected (same bytes whatever the check cadence)
  assert.equal(N & (N - 1), 0, 'a power of two');
  const small = await run(25, 0);
  assert.deepEqual(small.out, arr((await (async () => { const sp = spec.prepare({ bitDepth: 8 }, 0, { seed: 5, sd: 25 }, null); return sp.fn({ data: Uint8Array.from({ length: 64 }, (_, i) => (i * 37) & 255), width: 8, height: 8 }); })())));
});

await test('noiseSeconds: grows with sd on 8 / 16-bit (redraws), is flat on 32-bit, and warns above 10 s for a large image at a huge sd', async () => {
  const E = M.IJEnhPkg;
  assert.ok(E.noiseSeconds(1000, 1000, 1, 8, 25) < 1);
  assert.ok(E.noiseSeconds(6000, 6000, 1, 8, 100000) > 10);
  assert.ok(E.noiseSeconds(6000, 6000, 1, 32, 100000) < E.noiseSeconds(6000, 6000, 1, 8, 100000));
  assert.ok(E.noiseSeconds(1000, 1000, 3, 16, 25) < 1);
});

console.log(`ij enh noise: OK (${passed} groups)`);
