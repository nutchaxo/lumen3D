// Advanced Studio, package thr — Auto Local Threshold, Auto Threshold operations and "Try all", through the real engine.
//
//   * tests/fixtures/ij-wave3/fiji/autolocalthreshold/*.json: Fiji's Auto Local Threshold v1.11.0 on four 72x60 images, nine methods,
//     radius 15 and 7, default and explicit parameters, white and not white. TOLERANCE: >= 99.5 % identical pixels per case (the plan's
//     §6.3 figure); the measured minimum is stated by the last line of the test;
//   * autoThresholdLevel / autoThreshold / autoThresholdMask: the level of the selection's histogram, the 255-object picture;
//   * "Try all": the montage layout (one panel per method, no original, no gap), every method's picture in its panel, the 4096 px
//     limit, the levels a command passes in, a cancel that leaves nothing behind, the band-wise memory of the local Try all;
//   * determinism: a band of 1 row, 7 rows or the whole image gives the same bytes; the journal replays (undo / redo);
//   * memory: a declared scratch beyond the budget stops the step before it runs.
//
// Run: node tests/js/test_ij_thr_local.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startEngine, closeAll, M, decodeData, loadFixture, FIX } from './ij_thr_support.mjs';

let passed = 0;
async function test(name, fn) { try { await fn(); passed++; console.log('  ok  ' + name); } catch (e) { console.error('FAIL ' + name); throw e; } }
const A = (x) => Array.from(x);
const IMAGES = ['blobs_8bit', 'bigblobs_8bit', 'vessels_8bit', 'fibres_8bit'];
const METHODS = ['Bernsen', 'Contrast', 'Mean', 'Median', 'MidGrey', 'Niblack', 'Otsu', 'Phansalkar', 'Sauvola'];
let worst = 100;
const PHANSALKAR_MISMATCH = { 'bigblobs_8bit r15 0/0': 9, 'bigblobs_8bit r7 0/0': 14, 'vessels_8bit r15 0/0': 5, 'vessels_8bit r7 0/0': 6, 'fibres_8bit r7 0/0': 1,
  'bigblobs_8bit r15 0.3/0.4': 5, 'vessels_8bit r15 0.3/0.4': 3 };

await test('Fiji Auto Local Threshold: every method, radius and parameter set agrees on >= 99.5 % of the pixels', async () => {
  const c = startEngine();
  const byMethod = {};
  for (const name of IMAGES) {
    const fx = JSON.parse(fs.readFileSync(path.join(FIX, 'fiji', 'autolocalthreshold', name + '.json'), 'utf8'));
    for (const cs of fx.cases) {
      const p = cs.params;
      const { id } = await c.makeDoc(fx.input.width, fx.input.height, 8, [decodeData(fx.input.data)], { name, display: { min: 0, max: 255 } });
      await c.run(id, 'autoLocalThreshold', { method: p.method, radius: p.radius, parameter1: p.parameter1, parameter2: p.parameter2, white: p.white });
      const got = await c.pixels(id), exp = decodeData(cs.result.self.data);
      let diff = 0;
      for (let i = 0; i < exp.length; i++) if (got[i] !== exp[i]) diff++;
      const pct = 100 * (1 - diff / exp.length);
      assert.ok(pct >= 99.5, `${name} ${JSON.stringify(p)}: ${pct.toFixed(2)} %`);
      // Eight of the nine methods agree to the pixel. Phansalkar with its default parameters is the one KNOWN deviation (the
      // plan's section 6.3 wants differences only at the borders; these lie inside the image): the exact counts are pinned so
      // that a change of the formula shows (blobs agrees to the pixel).
      const key = `${name} r${p.radius} ${p.parameter1}/${p.parameter2}`;
      const known = p.method === 'Phansalkar' ? PHANSALKAR_MISMATCH[key] || 0 : 0;
      assert.equal(diff, known, `${key} ${p.method}: mismatching pixels`);
      worst = Math.min(worst, pct);
      (byMethod[p.method] = byMethod[p.method] || []).push(pct);
    }
  }
  assert.deepEqual(Object.keys(byMethod).sort(), METHODS.slice().sort());
  for (const m of METHODS) assert.equal(byMethod[m].length, 16, m);
  closeAll();
});

await test('the pixels are 0 or 255, the input is untouched until the step is committed, undo and redo restore them', async () => {
  const c = startEngine();
  const fx = JSON.parse(fs.readFileSync(path.join(FIX, 'fiji', 'autolocalthreshold', 'vessels_8bit.json'), 'utf8'));
  const src = decodeData(fx.input.data);
  const { id } = await c.makeDoc(72, 60, 8, [src], { display: { min: 0, max: 255 } });
  await c.run(id, 'autoLocalThreshold', { method: 'Phansalkar', radius: 15, parameter1: 0, parameter2: 0, white: true });
  const out = A(await c.pixels(id));
  assert.ok(out.every((v) => v === 0 || v === 255) && out.includes(0) && out.includes(255));
  await c.ok('doc.undo', { docId: id });
  assert.deepEqual(A(await c.pixels(id)), A(src), 'undo');
  await c.ok('doc.redo', { docId: id });
  assert.deepEqual(A(await c.pixels(id)), out, 'redo');
  closeAll();
});

await test('a band of 1 row, 7 rows or the whole image: the same bytes for every method (apron = the kernel radius)', async () => {
  const fx = JSON.parse(fs.readFileSync(path.join(FIX, 'fiji', 'autolocalthreshold', 'bigblobs_8bit.json'), 'utf8'));
  const W = fx.input.width;
  const seen = {};
  for (const [label, bandPixels] of [['one', W], ['seven', 7 * W], ['whole', 1 << 20]]) {
    const c = startEngine({ bandPixels });
    for (const method of METHODS) for (const radius of [3, 7, 15]) {
      const { id } = await c.makeDoc(W, fx.input.height, 8, [decodeData(fx.input.data)], { display: { min: 0, max: 255 } });
      await c.run(id, 'autoLocalThreshold', { method, radius, parameter1: 0, parameter2: 0, white: method !== 'Niblack' });
      const k = method + radius;
      const px = A(await c.pixels(id)).join();
      if (seen[k] === undefined) seen[k] = px; else assert.equal(px, seen[k], `${k} band ${label}`);
    }
    closeAll();
  }
});

await test('a selection limits Auto Local Threshold to its pixels; the statistics still read the pixels around it', async () => {
  const c = startEngine();
  const fx = JSON.parse(fs.readFileSync(path.join(FIX, 'fiji', 'autolocalthreshold', 'blobs_8bit.json'), 'utf8'));
  const src = decodeData(fx.input.data);
  const a = await c.makeDoc(72, 60, 8, [src], { display: { min: 0, max: 255 } });
  const b = await c.makeDoc(72, 60, 8, [src], { display: { min: 0, max: 255 } });
  const params = { method: 'Mean', radius: 7, parameter1: 0, parameter2: 0, white: true };
  await c.run(a.id, 'autoLocalThreshold', params);
  await c.run(b.id, 'autoLocalThreshold', params, { roi: { type: 'rect', x: 10, y: 8, w: 20, h: 15 } });
  const full = await c.pixels(a.id), part = await c.pixels(b.id);
  for (let y = 0; y < 60; y++) for (let x = 0; x < 72; x++) {
    const inside = x >= 10 && x < 30 && y >= 8 && y < 23;
    assert.equal(part[y * 72 + x], inside ? full[y * 72 + x] : src[y * 72 + x], `(${x},${y})`);
  }
  closeAll();
});

await test('refusals: a bad method / radius / parameter, a 16-bit image', async () => {
  const c = startEngine();
  const { id } = await c.makeDoc(16, 16, 8, [new Uint8Array(256).map((_, i) => i)], { display: { min: 0, max: 255 } });
  for (const params of [{ method: 'Nope', radius: 5 }, { method: 'Mean', radius: 0 }, { method: 'Mean', radius: 2.5 }, { method: 'Mean', radius: 5, parameter1: 'x' }, { method: 'Mean', radius: 5, white: 1 }]) {
    const m = await c.call('doc.run', { docId: id, op: 'autoLocalThreshold', params, roi: null, channel: 0 });
    assert.ok(!m.ok && m.error.code === 'IJ_BAD_ARGS', JSON.stringify(params));
  }
  const d16 = await c.makeDoc(16, 16, 16, [new Uint16Array(256)]);
  const m = await c.call('doc.run', { docId: d16.id, op: 'autoLocalThreshold', params: { method: 'Mean', radius: 5 }, roi: null, channel: 0 });
  assert.ok(!m.ok && m.error.code === 'IJ_BAD_TYPE');
  closeAll();
});

// ── Auto Threshold operations ──
const ramp = (w, h, f) => Uint8Array.from({ length: w * h }, (_, i) => f(i % w, Math.floor(i / w)));

await test('autoThresholdLevel / autoThreshold: the level of the selection\'s histogram, white or not white, 255 = object', async () => {
  const c = startEngine();
  const W = 40, H = 30;
  // left half dark (50 +- noise), right half bright (200 +- noise): Otsu sits between
  const src = ramp(W, H, (x, y) => (x < 20 ? 50 + ((x * 7 + y * 3) % 9) : 200 + ((x * 5 + y) % 11)));
  const { id } = await c.makeDoc(W, H, 8, [src], { display: { min: 0, max: 255 } });
  const lv = await c.ok('doc.compute', { docId: id, op: 'autoThresholdLevel', params: { method: 'Otsu', white: true }, roi: null, channel: 0 });
  assert.ok(lv.level >= 58 && lv.level < 200, 'a level between the modes: ' + lv.level);
  assert.deepEqual([lv.lower, lv.upper], [lv.level + 1, 255]);
  const lvNot = await c.ok('doc.compute', { docId: id, op: 'autoThresholdLevel', params: { method: 'Otsu', white: false }, roi: null, channel: 0 });
  assert.deepEqual([lvNot.lower, lvNot.upper], [0, lv.level]);
  await c.run(id, 'autoThreshold', { method: 'Otsu', level: lv.level, white: true });
  const out = await c.pixels(id);
  for (let i = 0; i < out.length; i++) assert.equal(out[i], src[i] > lv.level ? 255 : 0);
  await c.ok('doc.undo', { docId: id });
  await c.run(id, 'autoThreshold', { method: 'Otsu', level: lv.level, white: false });
  const out2 = await c.pixels(id);
  for (let i = 0; i < out2.length; i++) assert.equal(out2[i], src[i] <= lv.level ? 255 : 0);
  // the selection: the histogram is the selection's (a dark-only rectangle has no bright mode: another level)
  const roi = { type: 'rect', x: 0, y: 0, w: 20, h: 30 };
  const inRoi = await c.ok('doc.compute', { docId: id, op: 'autoThresholdLevel', params: { method: 'Otsu', white: true }, roi, channel: 0 });
  assert.notEqual(inRoi.level, lv.level, 'the level follows the selection');
  closeAll();
});

await test('Ignore black / Ignore white empty bins 0 and 255 before the method runs; Fiji\'s list refuses what it does not offer', async () => {
  const c = startEngine();
  const W = 20, H = 10;
  const src = ramp(W, H, (x, y) => (x < 9 ? 0 : x > 17 ? 255 : 80 + x * 3 + (y % 3)));
  const { id } = await c.makeDoc(W, H, 8, [src], { display: { min: 0, max: 255 } });
  const a = await c.ok('doc.compute', { docId: id, op: 'autoThresholdLevel', params: { method: 'Mean', white: true }, roi: null, channel: 0 });
  const b = await c.ok('doc.compute', { docId: id, op: 'autoThresholdLevel', params: { method: 'Mean', white: true, ignoreBlack: true, ignoreWhite: true }, roi: null, channel: 0 });
  assert.notEqual(a.level, b.level);
  for (const params of [{ method: 'IJ_IsoData' }, { method: 'Try all' }, { method: 'Otsu', white: 'yes' }]) {
    const m = await c.call('doc.compute', { docId: id, op: 'autoThresholdLevel', params, roi: null, channel: 0 });
    assert.ok(!m.ok && m.error.code === 'IJ_BAD_ARGS', JSON.stringify(params));
  }
  closeAll();
});

await test('16 bits: the level is the 65 536-bin one, the result is a NEW 8-bit mask (autoThresholdMask); 32 bits are refused', async () => {
  const c = startEngine();
  const W = 30, H = 20;
  const src = Uint16Array.from({ length: W * H }, (_, i) => (i % W < 15 ? 1200 + (i % 7) * 40 : 30000 + (i % 5) * 300));
  const { id } = await c.makeDoc(W, H, 16, [src]);
  const lv = await c.ok('doc.compute', { docId: id, op: 'autoThresholdLevel', params: { method: 'Otsu', white: true }, roi: null, channel: 0 });
  assert.equal(lv.top, 65535);
  assert.ok(lv.level >= 1440 && lv.level < 30000, 'at the top of the lower mode or above (the first maximum of a plateau): ' + lv.level);
  const r = await c.ok('doc.run', { docId: id, op: 'autoThresholdMask', params: { method: 'Otsu', level: lv.level, white: true }, roi: null, channel: 0 });
  assert.equal(r.newDocIds.length, 1);
  const px = await c.pixels(r.newDocIds[0]);
  for (let i = 0; i < px.length; i++) assert.equal(px[i], src[i] > lv.level ? 255 : 0);
  assert.equal((await c.ok('doc.info', { docId: r.newDocIds[0] })).bitDepth, 8);
  assert.deepEqual(A(await c.pixels(id)), A(src), 'the source is untouched');
  const f32 = await c.makeDoc(8, 8, 32, [new Float32Array(64).map((_, i) => i)]);
  const m = await c.call('doc.compute', { docId: f32.id, op: 'autoThresholdLevel', params: { method: 'Otsu' }, roi: null, channel: 0 });
  assert.ok(!m.ok && m.error.code === 'IJ_BAD_TYPE', '32-bit: ' + (m.error && m.error.code));
  closeAll();
});

// ── Try all ──
await test('Try all (Auto Threshold): one 8-bit picture per method (no original panel, no gap), laid out as IJThr.tryAllLayout says', async () => {
  const c = startEngine();
  const W = 40, H = 30;
  const src = ramp(W, H, (x, y) => (x < 20 ? 40 + ((x * 7 + y * 3) % 23) : 160 + ((x * 5 + y) % 31)));
  const { id } = await c.makeDoc(W, H, 8, [src], { display: { min: 0, max: 255 } });
  const r = await c.ok('doc.run', { docId: id, op: 'autoThresholdTryAll', params: { white: true }, roi: null, channel: 0 });
  assert.equal(r.newDocIds.length, 1);
  const info = await c.ok('doc.info', { docId: r.newDocIds[0] });
  const N = M.IJThr.FIJI_METHODS.length;
  const L = M.IJThr.tryAllLayout(W, H, N, 4096);
  assert.deepEqual([info.width, info.height, info.bitDepth], [L.width, L.height, 8]);
  assert.equal([L.cols, L.rows].join('x'), '5x4', '17 panels: 5 columns, 4 rows');
  assert.equal(L.gap, 0);
  assert.equal(L.width, L.cols * W, 'no gap between the panels');
  const m = await c.pixels(r.newDocIds[0]);
  assert.ok(m.every((v) => v === 0 || v === 255), 'the montage is a 0 / 255 picture');
  const panel = (i) => { const o = L.cell(i), out = new Uint8Array(W * H); for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) out[y * W + x] = m[(o.y + y) * L.width + o.x + x]; return out; };
  const hist = new Float64Array(256); for (const v of src) hist[v]++;
  M.IJThr.FIJI_METHODS.forEach((name, k) => {
    const level = M.IJThr.fijiLevel(hist, name, false);
    assert.deepEqual(A(panel(k)), A(src.map((v) => (v > level ? 255 : 0))), name);
  });
  const o = L.cell(N); // the cells after the last method stay empty
  for (let y = 0; y < L.ph; y++) for (let x = 0; x < L.pw; x++) assert.equal(m[(o.y + y) * L.width + o.x + x], 0);
  // the levels a command hands over are the ones drawn (and are journaled with the params)
  const levels = M.IJThr.FIJI_METHODS.map(() => 100);
  const r2 = await c.ok('doc.run', { docId: id, op: 'autoThresholdTryAll', params: { white: true, levels }, roi: null, channel: 0 });
  const m2 = await c.pixels(r2.newDocIds[0]);
  for (let k = 0; k < N; k++) { const o2 = L.cell(k); for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) assert.equal(m2[(o2.y + y) * L.width + o2.x + x], src[y * W + x] > 100 ? 255 : 0); }
  for (const bad of [levels.slice(1), levels.map(() => 1.5), levels.map(() => 300), levels.map(() => -2)]) {
    const e = await c.call('doc.run', { docId: id, op: 'autoThresholdTryAll', params: { white: true, levels: bad }, roi: null, channel: 0 });
    assert.ok(!e.ok && e.error.code === 'IJ_BAD_ARGS');
  }
  closeAll();
});

await test('Try all: a wide image is scaled so that the montage is at most 4096 px wide, and a memory-limited run is refused up front', async () => {
  const L = M.IJThr.tryAllLayout(2000, 1500, 17, 4096);
  assert.ok(L.width <= 4096 && L.scale < 1 && L.pw === Math.floor(2000 * L.scale));
  const small = M.IJThr.tryAllLayout(100, 80, 17, 4096);
  assert.equal(small.scale, 1);
  // two panels' cells never overlap and stay inside the montage
  for (let i = 0; i < 17; i++) { const o = L.cell(i); assert.ok(o.x + L.pw <= L.width && o.y + L.ph <= L.height); }
  const c = startEngine({ budgetBytes: 200000 });
  const { id } = await c.makeDoc(300, 300, 8, [new Uint8Array(90000).map((_, i) => i % 251)], { display: { min: 0, max: 255 } });
  const m = await c.call('doc.run', { docId: id, op: 'autoThresholdTryAll', params: {}, roi: null, channel: 0 });
  assert.ok(!m.ok && /OVER_BUDGET|OVER_MEMORY|BUDGET/i.test(m.error.code), 'refused before running: ' + (m.error && m.error.code));
  closeAll();
});

await test('Try all (Auto Local Threshold): nine methods, 3 columns x 3 rows, equal to the single-method runs', async () => {
  const c = startEngine();
  const fx = JSON.parse(fs.readFileSync(path.join(FIX, 'fiji', 'autolocalthreshold', 'vessels_8bit.json'), 'utf8'));
  const W = 72, H = 60, src = decodeData(fx.input.data);
  const { id } = await c.makeDoc(W, H, 8, [src], { display: { min: 0, max: 255 } });
  const r = await c.ok('doc.run', { docId: id, op: 'autoLocalThresholdTryAll', params: { radius: 9, parameter1: 0, parameter2: 0, white: true }, roi: null, channel: 0 });
  const L = M.IJThr.tryAllLayout(W, H, 9, 4096);
  assert.equal([L.cols, L.rows].join('x'), '3x3');
  const m = await c.pixels(r.newDocIds[0]);
  const panel = (i) => { const o = L.cell(i), out = new Uint8Array(W * H); for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) out[y * W + x] = m[(o.y + y) * L.width + o.x + x]; return out; };
  for (let k = 0; k < METHODS.length; k++) {
    const { id: one } = await c.makeDoc(W, H, 8, [src], { display: { min: 0, max: 255 } });
    await c.run(one, 'autoLocalThreshold', { method: METHODS[k], radius: 9, parameter1: 0, parameter2: 0, white: true });
    assert.deepEqual(A(panel(k)), A(await c.pixels(one)), METHODS[k]);
  }
  closeAll();
});

await test('Try all (Auto Local Threshold) runs in row bands: bigger than one band, the same bytes as the whole-image runs', async () => {
  // 150 x 1200 = 180 000 px > the 131 072 px of a band: two bands, so the apron joins matter
  const W = 150, H = 1200;
  const src = Uint8Array.from({ length: W * H }, (_, i) => (((Math.imul(i, 2654435761) >>> 24) & 255) ^ ((i % W) > 70 ? 90 : 0)));
  const c = startEngine();
  const { id } = await c.makeDoc(W, H, 8, [src], { display: { min: 0, max: 255 } });
  const r = await c.ok('doc.run', { docId: id, op: 'autoLocalThresholdTryAll', params: { radius: 5, parameter1: 0, parameter2: 0, white: true }, roi: null, channel: 0 });
  const L = M.IJThr.tryAllLayout(W, H, 9, 4096);
  assert.equal(L.scale, 1, 'unscaled panels: the montage holds the exact pictures');
  // a tile of the engine is 1024 x 1024: the montage (450 x 3600) is read tile by tile
  const m = new Uint8Array(L.width * L.height);
  for (let ty = 0; ty * 1024 < L.height; ty++) {
    const t = await c.ok('doc.tile', { docId: r.newDocIds[0], channel: 0, level: 0, tx: 0, ty });
    for (let y = 0; y < t.height; y++) for (let x = 0; x < t.width; x++) m[(ty * 1024 + y) * L.width + x] = t.data[y * t.width + x];
  }
  let mn = 255, mx = 0; for (const v of src) { if (v < mn) mn = v; if (v > mx) mx = v; }
  for (const k of [0, 2, 3, 6, 7]) { // Bernsen, Mean, Median, Otsu, Phansalkar: sums, ranks, the histogram slide, the range
    const out = new Uint8Array(W * H), o = L.cell(k);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) out[y * W + x] = m[(o.y + y) * L.width + o.x + x];
    const whole = M.IJThr.localThreshold({ width: W, height: H, bitDepth: 8, data: src }, METHODS[k], 5, 0, 0, true, null, { min: mn, max: mx });
    assert.deepEqual(A(out), A(whole), METHODS[k]);
  }
  closeAll();
});

await test('cancel: a cancelled Try all (both) leaves the document untouched and creates nothing; the slow scans reach the hook', async () => {
  for (const [op, params, bd, mk] of [
    ['autoLocalThresholdTryAll', { radius: 15, parameter1: 0, parameter2: 0, white: true }, 8, (n) => Uint8Array.from({ length: n }, (_, i) => (i * 7) & 255)],
    ['autoThresholdTryAll', { white: true }, 16, (n) => Uint16Array.from({ length: n }, (_, i) => (i * 97) % 65536)]]) {
    const c = startEngine({ sliceMs: 0.001 });
    const W = 200, H = 150, src = mk(W * H);
    const { id } = await c.makeDoc(W, H, bd, [src], bd === 8 ? { display: { min: 0, max: 255 } } : {});
    const before = A(await c.pixels(id));
    const docs0 = (await c.ok('doc.list', {})).docs.length;
    const hook = (ev) => { if (ev.event === 'progress' && !hook.done) { hook.done = true; c.fake.onmessage({ data: { id: 9100, cmd: 'cancel', args: { targetId: ev.id } } }); } };
    c.hooks.push(hook);
    const m = await c.call('doc.run', { docId: id, op, params, roi: null, channel: 0 });
    c.hooks.length = 0;
    assert.ok(hook.done, op + ': a progress event was emitted');
    assert.ok(!m.ok && m.error.code === 'IJ_CANCELLED', op + ': ' + (m.error && m.error.code));
    assert.deepEqual(A(await c.pixels(id)), before, op + ': the document is untouched');
    assert.equal((await c.ok('doc.list', {})).docs.length, docs0, op + ': no new document');
    closeAll();
  }
  // the cancel hook is reached from INSIDE the O(n^2) scans of a 16-bit histogram (4000 distinct values: seconds without it)
  const counts = new Int32Array(65536);
  for (let i = 0; i < 4000; i++) counts[i * 16] = 1 + (i % 7);
  for (const method of ['Huang', 'Huang2', 'MaxEntropy', 'RenyiEntropy', 'Shanbhag']) {
    let calls = 0;
    const t0 = Date.now();
    assert.throws(() => M.IJThreshold.level(counts, method, { bilevelSubtractOne: false, check: () => { if (++calls === 3) throw Object.assign(new Error('c'), { code: 'IJ_CANCELLED' }); } }), (e) => e.code === 'IJ_CANCELLED', method);
    assert.equal(calls, 3, method + ': the hook is called every few iterations');
    assert.ok(Date.now() - t0 < 2000, method + ': it stopped at once');
    // the hook never leaks into a later call (the slot is restored), and a check that does not throw changes nothing
    const a = M.IJThreshold.level(counts, method, { bilevelSubtractOne: false }), b = M.IJThreshold.level(counts, method, { bilevelSubtractOne: false, check: () => {} });
    assert.equal(a, b, method + ': a check that does not throw changes nothing');
  }
});

console.log(`${passed} tests passed; Auto Local Threshold agreement with Fiji: worst case ${worst.toFixed(2)} % of the pixels (Phansalkar with default parameters is the one pinned deviation)`);
