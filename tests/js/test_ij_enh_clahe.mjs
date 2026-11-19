// P-enh: Enhance Local Contrast (CLAHE) — the `clahe` pixel op and its `claheMask` helper.
//
// References and tolerances (PLAN-wave3 §6.3: "CLAHE fast mean |d| <= 1 grey level and >= 95 % of pixels within +-2 (8-bit), slow likewise"):
//   tests/fixtures/ij-wave3/fiji/clahe/*.json are the outputs of Fiji's mpicbg CLAHE (GPL code, never read: the op is written from
//   Zuiderveld 1994 and calibrated on these files). Differences are measured in 8-bit grey levels (a 16-bit difference is scaled by 255/60000).
//     256 bins, exact window (slow)  : mean |d| <= 0.1, max |d| <= 2         (measured 0.014 .. 0.054, max 1)
//     256 bins, fast                 : mean |d| <= 0.7, >= 95 % within 2     (measured 0.08 .. 0.61; Fiji's own fast mode is not published)
//     128 bins                       : mean |d| <= 0.6, >= 95 % within 2     (measured 0.22 .. 0.42)
//      64 bins                       : mean |d| <= 1, >= 95 % within 2       (measured 0.34 .. 0.58 since the bin is round(v (bins-1)/255))
//   Also an independent brute-force reference (no sliding histogram, own clip loop) of the same algorithm: slow mode is EXACTLY equal to it,
//   with and without a mask, on 8-, 16- and 32-bit images.
// GAP: there is no Fiji fixture for a 32-bit image, a selection or a mask: the 32-bit path (FloatProcessor.create8BitImage, out = v * eq8 / in8) is extrapolated
//   from the 16-bit one and checked against the brute-force reference only.
// Band independence: region(full, rect) in 1-row / 7-row / whole splits, and the engine with bandPixels 1 row / 7 rows / whole, are byte-identical.
//
// Run: node tests/js/test_ij_enh_clahe.mjs
import assert from 'node:assert/strict';
import { M, startEngine, loadFixture, imageOf, closeAll } from './ij_enh_support.mjs';

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { console.error('FAIL ' + name); throw e; }
}
const arr = (a) => Array.from(a);
const spec = M.IJOpRegistry.get('clahe');
const noCtx = { range: (c) => ({ min: 0, max: 255 }), check() {}, tick: async () => {} };

async function regionRun(bd, W, H, data, p, splits, display) {
  const view = { bitDepth: bd, channels: [{ display: display || { min: 0, max: 255 } }] };
  const params = spec.resolve ? spec.resolve(view, Object.assign({}, p), [0]) : p;
  const ctx = Object.assign({}, noCtx, { range: () => ({ min: display ? display.min : 0, max: display ? display.max : 255 }) });
  const prep = spec.prepare(view, 0, params, ctx);
  const full = { width: W, height: H, bitDepth: bd, data };
  const out = bd === 8 ? new Uint8Array(W * H) : bd === 16 ? new Uint16Array(W * H) : new Float32Array(W * H);
  let y = 0, i = 0;
  while (y < H) {
    const h = Math.min(splits[i++ % splits.length], H - y);
    out.set(await prep.region(full, { x: 0, y, w: W, h }), y * W);
    y += h;
  }
  return out;
}

// ── 1. the Fiji reference outputs ──────────────────────────────────────────────────────────────────────────
const LIMITS = { // by bins and mode: [mean, share within 2]
  '256/slow': [0.1, 0.99], '256/fast': [0.7, 0.95], '128/slow': [0.6, 0.95], '64/fast': [1, 0.95]
};
await test('Fiji reference outputs: mean |d| and the share within 2 grey levels, per configuration', async () => {
  const c = startEngine();
  const rows = [];
  for (const n of ['blobs_8bit', 'vessels_8bit', 'bigblobs_8bit', 'blobs_16bit', 'bigblobs_16bit']) {
    const fx = loadFixture('fiji/clahe/' + n);
    const bd = fx.input.bitDepth, inp = imageOf(fx.input), range = bd === 8 ? 255 : 60000;
    for (const cs of fx.cases) {
      const d = await c.makeDoc(fx.input.width, fx.input.height, bd, [inp]);
      await c.run(d.id, 'clahe', cs.params);
      const got = await c.pixels(d.id), exp = imageOf(cs.result.self);
      let sum = 0, within = 0, max = 0;
      for (let i = 0; i < got.length; i++) { const e = Math.abs(got[i] - exp[i]) * 255 / range; sum += e; if (e <= 2) within++; if (e > max) max = e; }
      const key = `${cs.params.bins}/${cs.params.fast ? 'fast' : 'slow'}`;
      const lim = LIMITS[key] || LIMITS[`${cs.params.bins}/slow`] || LIMITS['256/fast'];
      const mean = sum / got.length, share = within / got.length;
      rows.push(`${n} ${JSON.stringify(cs.params)} mean ${mean.toFixed(3)} within2 ${share.toFixed(4)} max ${max.toFixed(1)}`);
      assert.ok(mean <= lim[0], `${n} ${key}: mean |d| ${mean} > ${lim[0]}`);
      assert.ok(share >= lim[1], `${n} ${key}: share within 2 ${share} < ${lim[1]}`);
      if (key === '256/slow') assert.ok(max <= 2, `${n} ${key}: max |d| ${max}`);
    }
  }
  closeAll();
  if (process.env.ENH_VERBOSE) console.log(rows.join('\n'));
});

// ── 2. an independent brute-force reference ────────────────────────────────────────────────────────────────
function refClahe(bd, W, H, data, p, mask, display) {
  const bins = p.bins, r = (p.blocksize - 1) >> 1;
  // the 8-bit view
  const q = new Uint8Array(W * H);
  if (bd === 8) q.set(data);
  else if (bd === 16) {
    const lo = Math.floor(display.min + 0.5), hi = Math.floor(display.max + 0.5), sc = 256.0 / (hi - lo + 1);
    for (let i = 0; i < q.length; i++) { let v = data[i] - lo; if (v < 0) v = 0; v = Math.trunc(v * sc + 0.5); q[i] = v > 255 ? 255 : v; }
  } else {
    const lo = Math.fround(display.min), hi = Math.fround(display.max), sc = 255.0 / (hi - lo);
    for (let i = 0; i < q.length; i++) { let v = data[i] - lo; if (v < 0) v = 0; v = Number.isNaN(v) ? 0 : Math.trunc(v * sc + 0.5); q[i] = v > 255 ? 255 : v; }
  }
  const out = bd === 8 ? new Uint8Array(W * H) : bd === 16 ? new Uint16Array(W * H) : new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x;
    if (mask && !mask[i]) { out[i] = data[i]; continue; }
    const h = new Array(bins).fill(0);
    let N = 0;
    for (let yy = Math.max(0, y - r); yy <= Math.min(H - 1, y + r); yy++) for (let xx = Math.max(0, x - r); xx <= Math.min(W - 1, x + r); xx++) {
      if (mask && !mask[yy * W + xx]) continue;
      h[Math.round(q[yy * W + xx] * (bins - 1) / 255)]++; N++;
    }
    const limit = Math.trunc(p.slope * N / bins + 0.5);
    let prev = -1;
    for (let k = 0; k < 200; k++) {
      let cl = 0;
      for (let b = 0; b < bins; b++) if (h[b] > limit) { cl += h[b] - limit; h[b] = limit; }
      const d = Math.trunc(cl / bins), m = cl % bins;
      for (let b = 0; b < bins; b++) h[b] += d;
      if (m) { const s = Math.trunc(bins / m); for (let b = s - 1; b < bins; b += s) h[b]++; }
      if (cl === prev || cl === 0) break;
      prev = cl;
    }
    let cm = 0, tot = 0;
    for (let b = 0; b < bins; b++) { if (!cm && h[b]) cm = h[b]; tot += h[b]; }
    let cdf = 0;
    const bin = Math.round(q[i] * (bins - 1) / 255);
    for (let b = 0; b <= bin; b++) cdf += h[b];
    const t = (cdf - cm) / (tot - cm) * 255, out8 = Math.floor(t + 0.5);
    if (bd === 8) out[i] = out8;
    else if (q[i] === 0) out[i] = data[i];
    else { const v = data[i] * out8 / q[i]; out[i] = bd === 16 ? Math.min(65535, Math.max(0, Math.floor(v + 0.5))) : Math.fround(v); }
  }
  return out;
}

function randomImage(bd, W, H, seed) {
  let s = seed;
  const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
  const a = bd === 8 ? new Uint8Array(W * H) : bd === 16 ? new Uint16Array(W * H) : new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const base = 0.5 + 0.4 * Math.sin(x / 7) * Math.cos(y / 5), v = Math.min(1, Math.max(0, base * (0.4 + 0.6 * rnd())));
    a[y * W + x] = bd === 8 ? Math.floor(v * 255) : bd === 16 ? Math.floor(v * 40000) : Math.fround(v * 300 - 20);
  }
  return a;
}

for (const bd of [8, 16, 32]) {
  await test(`${bd}-bit: the exact (slow) mode equals an independent brute-force reference, with and without a mask, odd and even sizes`, async () => {
    const display = bd === 8 ? { min: 0, max: 255 } : bd === 16 ? { min: 0, max: 40000 } : { min: -20, max: 280 };
    for (const [W, H, p] of [[37, 29, { blocksize: 15, bins: 256, slope: 3, fast: false }], [24, 31, { blocksize: 9, bins: 64, slope: 2, fast: false }], [20, 20, { blocksize: 41, bins: 100, slope: 4.5, fast: false }]]) {
      const data = randomImage(bd, W, H, W * 131 + H);
      if (bd === 32) { data[5] = NaN; data[W + 3] = -50; }
      const got = await regionRun(bd, W, H, data, p, [H], display);
      const exp = refClahe(bd, W, H, data, p, null, display);
      assert.deepEqual(arr(got).map((v) => (v !== v ? 'NaN' : v)), arr(exp).map((v) => (v !== v ? 'NaN' : v)), `${W}x${H} ${JSON.stringify(p)}`);
      // with a mask
      const mask = new Uint8Array(W * H);
      for (let i = 0; i < mask.length; i++) mask[i] = ((i * 7 + (i >> 3)) % 5) === 0 ? 0 : 1;
      const view = { bitDepth: bd, channels: [{ display }] };
      const params = spec.resolve(view, Object.assign({ mask }, p), [0]);
      const prep = spec.prepare(view, 0, params, Object.assign({}, noCtx, { range: () => display }));
      const gm = await prep.region({ width: W, height: H, bitDepth: bd, data }, { x: 0, y: 0, w: W, h: H });
      const em = refClahe(bd, W, H, data, p, mask, display);
      assert.deepEqual(arr(gm).map((v) => (v !== v ? 'NaN' : v)), arr(em).map((v) => (v !== v ? 'NaN' : v)), `masked ${W}x${H}`);
      for (let i = 0; i < mask.length; i++) if (!mask[i]) assert.ok(Object.is(gm[i], data[i]) || (gm[i] !== gm[i] && data[i] !== data[i]), 'a masked-out pixel is left alone');
    }
  });
}

// ── 3. band independence ───────────────────────────────────────────────────────────────────────────────────
await test('region(full, rect) in 1-row / 7-row / whole splits is byte-identical, exact and fast, 8 / 16 / 32 bit', async () => {
  for (const bd of [8, 16, 32]) {
    const W = 53, H = 41, display = bd === 8 ? { min: 0, max: 255 } : bd === 16 ? { min: 0, max: 40000 } : { min: -20, max: 280 };
    const data = randomImage(bd, W, H, 99 + bd);
    for (const p of [{ blocksize: 21, bins: 256, slope: 3, fast: false }, { blocksize: 21, bins: 128, slope: 2.5, fast: true }, { blocksize: 127, bins: 256, slope: 3, fast: true }]) {
      const whole = await regionRun(bd, W, H, data, p, [H], display);
      for (const split of [[1], [7], [3, 11, 1]]) {
        const got = await regionRun(bd, W, H, data, p, split, display);
        assert.deepEqual(arr(got), arr(whole), `${bd}-bit ${JSON.stringify(p)} split ${split}`);
      }
    }
  }
});

await test('through the engine: bandPixels of 1 row / 7 rows / everything give the same bytes (exact and fast); a selection is ignored (UNVERIFIED against Fiji: no fixture has a selection)', async () => {
  const fx = loadFixture('fiji/clahe/blobs_8bit');
  const W = fx.input.width, H = fx.input.height, inp = imageOf(fx.input);
  for (const p of [{ blocksize: 63, bins: 256, slope: 3, fast: true }, { blocksize: 31, bins: 128, slope: 2, fast: false }]) {
    const outs = [];
    for (const bandPixels of [W, 7 * W, 1 << 20]) {
      const c = startEngine({ bandPixels });
      const d = await c.makeDoc(W, H, 8, [inp]);
      await c.run(d.id, 'clahe', p);
      outs.push(arr(await c.pixels(d.id)));
      closeAll();
    }
    assert.deepEqual(outs[1], outs[0], 'band 7 rows == 1 row');
    assert.deepEqual(outs[2], outs[0], 'whole == 1 row');
  }
  const c = startEngine();
  const a = await c.makeDoc(W, H, 8, [inp]), b = await c.makeDoc(W, H, 8, [inp]);
  const p = { blocksize: 31, bins: 256, slope: 3, fast: true };
  await c.run(a.id, 'clahe', p);
  await c.run(b.id, 'clahe', p, { roi: { type: 'rect', x: 10, y: 10, w: 20, h: 12 } });
  assert.deepEqual(arr(await c.pixels(b.id)), arr(await c.pixels(a.id)), 'a selection is ignored (unverified against Fiji): the mask is the way to restrict');
  closeAll();
});

// ── 4. rules of the 16 / 32-bit path, mask helper, journal ─────────────────────────────────────────────────
await test('16 / 32-bit: the pixel is scaled by what the 8-bit view did (out = v * eq8 / in8); a value that maps to level 0 stays; NaN stays NaN', async () => {
  const W = 40, H = 30;
  const d16 = randomImage(16, W, H, 5); d16[3] = 0; d16[4] = 20;      // in8 = 0 for both (scale 256/40001 per count)
  const g16 = await regionRun(16, W, H, d16, { blocksize: 15, bins: 256, slope: 3, fast: false }, [H], { min: 0, max: 40000 });
  assert.equal(g16[3], 0); assert.equal(g16[4], 20, 'in8 = 0: the pixel is left as it is');
  const d32 = randomImage(32, W, H, 6); d32[7] = NaN; d32[8] = Infinity;
  const g32 = await regionRun(32, W, H, d32, { blocksize: 15, bins: 256, slope: 3, fast: false }, [H], { min: -20, max: 280 });
  assert.ok(Number.isNaN(g32[7]), 'NaN stays NaN');
  assert.equal(g32[8], Infinity, 'Infinity: in8 = 255, v * eq8 / 255 stays infinite');
  assert.equal(g32.length, W * H);
});

await test('claheMask: 1 where the 8-bit mask image is not 0; refuses another size and a non 8-bit image; the mask goes through the engine as a blob and the journal replays it', async () => {
  const c = startEngine();
  const W = 30, H = 20;
  const img = randomImage(8, W, H, 3), msk = new Uint8Array(W * H);
  for (let i = 0; i < msk.length; i++) msk[i] = (i % 7 < 3) ? 0 : 200;
  const a = await c.makeDoc(W, H, 8, [img]), m = await c.makeDoc(W, H, 8, [msk]);
  const r = await c.ok('doc.compute', { docId: a.id, docIds: [a.id, m.id], op: 'claheMask', params: { maskDocId: m.id }, channel: 0 });
  assert.equal(r.width, W); assert.equal(r.height, H);
  assert.deepEqual(arr(r.data), arr(msk).map((v) => (v ? 1 : 0)));
  const odd = await c.makeDoc(W + 1, H, 8, [new Uint8Array((W + 1) * H)]);
  const e1 = await c.err('doc.compute', { docId: a.id, docIds: [a.id, odd.id], op: 'claheMask', params: { maskDocId: odd.id }, channel: 0 });
  assert.equal(e1.code, 'IJ_ENH_MASK_SIZE');
  const d16 = await c.makeDoc(W, H, 16, [new Uint16Array(W * H)]);
  const e2 = await c.err('doc.compute', { docId: a.id, docIds: [a.id, d16.id], op: 'claheMask', params: { maskDocId: d16.id }, channel: 0 });
  assert.equal(e2.code, 'IJ_ENH_MASK_TYPE');
  // a run with the mask: the masked-out pixels are untouched, the others change
  const mask = new Uint8Array(r.data);
  const p = { blocksize: 15, bins: 256, slope: 3, fast: false, mask };
  await c.run(a.id, 'clahe', p);
  const got = await c.pixels(a.id);
  const exp = refClahe(8, W, H, img, p, mask, null);
  assert.deepEqual(arr(got), arr(exp));
  closeAll();
});

await test('refusals: bad parameters (IJ_BAD_ARGS); the exact mode above 16 megapixels (IJ_ENH_CLAHE_SLOW_TOO_LARGE); a mask of the wrong size', async () => {
  const c = startEngine();
  const a = await c.makeDoc(16, 16, 8, [new Uint8Array(256).fill(9)]);
  const good = { blocksize: 127, bins: 256, slope: 3, fast: true };
  for (const bad of [{ blocksize: 2 }, { blocksize: 10.5 }, { bins: 1 }, { bins: 257 }, { slope: 0.5 }, { slope: NaN }, { fast: 1 }, { blocksize: '127' }]) {
    const e = await c.err('doc.run', { docId: a.id, op: 'clahe', params: Object.assign({}, good, bad), roi: null, channel: 0 });
    assert.equal(e.code, 'IJ_BAD_ARGS', JSON.stringify(bad));
  }
  let thrown = null;
  try { spec.validate({ blocksize: 127, bins: 256, slope: 3, fast: false }, { width: 4001, height: 4001, bitDepth: 8, channels: 1, region: null }); } catch (e) { thrown = e; }
  assert.ok(thrown && thrown.code === 'IJ_ENH_CLAHE_SLOW_TOO_LARGE', 'slow mode above 16 Mpx');
  assert.doesNotThrow(() => spec.validate({ blocksize: 127, bins: 256, slope: 3, fast: false }, { width: 4000, height: 4000, bitDepth: 8, channels: 1, region: null }), '16 Mpx exactly is allowed');
  assert.doesNotThrow(() => spec.validate(good, { width: 6000, height: 6000, bitDepth: 8, channels: 4, region: null }), 'fast mode takes a large image');
  const e = await c.err('doc.run', { docId: a.id, op: 'clahe', params: Object.assign({}, good, { mask: new Uint8Array(5) }), roi: null, channel: 0 });
  assert.equal(e.code, 'IJ_BAD_ARGS', 'mask size');
  assert.deepEqual(arr(await c.pixels(a.id)), arr(new Uint8Array(256).fill(9)), 'a refused step changes nothing');
  closeAll();
});

await test('memory is declared (the 8-bit view, three node rows) and a budget that cannot hold it refuses before the run; cancel mid-way leaves the pixels; progress is reported', async () => {
  const need16 = spec.scratchBytes({ width: 2000, height: 1000, bitDepth: 16, channels: 1, region: null }, { fast: true, bins: 256 });
  const need8 = spec.scratchBytes({ width: 2000, height: 1000, bitDepth: 8, channels: 1, region: null }, { fast: true, bins: 256 });
  assert.ok(need16 >= 2000 * 1000 + need8 - 1, '16-bit pays for its 8-bit view'); assert.ok(need8 > 0);
  {
    const c = startEngine({ budgetBytes: 1500000 });
    const W = 600, H = 600;
    const d = await c.makeDoc(W, H, 16, [new Uint16Array(W * H).fill(1000)]);
    const e = await c.err('doc.run', { docId: d.id, op: 'clahe', params: { blocksize: 127, bins: 256, slope: 3, fast: true }, roi: null, channel: 0 });
    assert.equal(e.code, 'IJ_OVER_BUDGET');
    closeAll();
  }
  const c = startEngine();
  const W = 300, H = 300, img = randomImage(8, W, H, 4);
  const d = await c.makeDoc(W, H, 8, [img]);
  const before = arr(await c.pixels(d.id));
  let sawProgress = 0;
  c.hooks.push((m) => { if (m.event === 'progress') { sawProgress++; if (sawProgress === 2) c.fake.onmessage({ data: { id: 777002, cmd: 'cancel', args: { targetId: m.id } } }); } });
  const r = await c.call('doc.run', { docId: d.id, op: 'clahe', params: { blocksize: 127, bins: 256, slope: 3, fast: false }, roi: null, channel: 0 });
  assert.equal(r.ok, false); assert.equal(r.error.code, 'IJ_CANCELLED');
  assert.deepEqual(arr(await c.pixels(d.id)), before, 'untouched');
  assert.ok(sawProgress >= 2);
  closeAll();
});

await test('the journal: a replay of the stored params (display range included) gives the same pixels as the live run (16-bit)', async () => {
  const c = startEngine();
  const W = 48, H = 36, data = randomImage(16, W, H, 12);
  const d = await c.makeDoc(W, H, 16, [data], { display: { min: 100, max: 39000 } });
  await c.run(d.id, 'clahe', { blocksize: 21, bins: 256, slope: 3, fast: false });
  const live = arr(await c.pixels(d.id));
  // the display range moves on after the step: the journaled params carry the range the step used
  await c.ok('doc.setDisplay', { docId: d.id, channel: 0, min: 0, max: 65535 });
  await c.ok('doc.undo', { docId: d.id });
  await c.ok('doc.setDisplay', { docId: d.id, channel: 0, min: 5, max: 50000 });
  await c.ok('doc.redo', { docId: d.id });
  assert.deepEqual(arr(await c.pixels(d.id)), live, 'redo');
  closeAll();
});

console.log(`ij enh clahe: OK (${passed} groups)`);
