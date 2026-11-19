// Advanced Studio, package thr — the Binary operations: Options (iterations, count, pad edges, foreground), Binary Median.
//
//   * tests/fixtures/ij-wave3/thr/binary_{disks,lines}_*.json: ImageJ 1.54p `Binary.run` for erode / dilate / open / close / outline /
//     fill holes / skeletonize, iterations 1 and 3, count 1 and 4, Pad edges off and on — byte-identical;
//   * thr/binary_foreground_rule.json: `foreground = blackBackground ? 255 : 0; if (ip.isInvertedLut()) foreground = 255 − foreground`
//     over the four (Black background, LUT) combinations, through the `foreground` parameter and the `invert` arrays of ij-proc-seg.js;
//   * thr/binary_median_r1.json, r3.json: Binary.median = RankFilters MEAN then threshold(128, 255);
//   * thr/make_binary_mask.json (Thresholder.createMask) and thr/edm_outputs_*.json (every EDM output type), cancel, the non-binary refusal;
//   * the v1 `binary` journal: an entry written before the options (no `padEdges` / `foreground`) replays to the v1 pixels;
//   * determinism: a band of 1 row, 7 rows or the whole image gives the same bytes (the apron is the true reach).
//
// Run: node tests/js/test_ij_thr_binary.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startEngine, closeAll, M, decodeData, loadFixture, FIX } from './ij_thr_support.mjs';

let passed = 0;
async function test(name, fn) { try { await fn(); passed++; console.log('  ok  ' + name); } catch (e) { console.error('FAIL ' + name); throw e; } }
const A = (x) => Array.from(x);
const sameBytes = (a, b, msg) => { assert.equal(a.length, b.length, msg + ' (length)'); let n = 0; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++; assert.equal(n, 0, msg + ': ' + n + ' pixels differ'); };

async function docOf(c, im, name) {
  const W = im.width, H = im.height;
  return c.makeDoc(W, H, 8, [decodeData(im.data)], { name: name || 'bin', display: { min: 0, max: 255 } });
}

const OPS = { erode: 'erode', dilate: 'dilate', open: 'open', close: 'close', outline: 'outline', fill_holes: 'fillHoles' };

await test('Binary Options matrix (ImageJ 1.54p): iterations, count, Pad edges — erode / dilate / open / close / outline / fill holes', async () => {
  const c = startEngine();
  let n = 0;
  for (const shape of ['disks', 'lines']) {
    for (const key of Object.keys(OPS)) {
      const fx = loadFixture(`thr/binary_${shape}_${key}`);
      for (const cs of fx.cases) {
        const p = cs.params;
        const { id } = await docOf(c, fx.input, `${shape}_${key}`);
        await c.run(id, 'binary', { op: OPS[key], iterations: p.iterations, count: p.count, padEdges: p.padEdges, foreground: 255 });
        sameBytes(await c.pixels(id), decodeData(cs.output.data), `${shape} ${key} ${JSON.stringify(p)}`);
        n++;
      }
    }
  }
  assert.ok(n >= 48, 'cases ' + n);
  closeAll();
});

await test('Skeletonize (the seg operation, fed the foreground as the `invert` array) equals Binary.skeletonize', async () => {
  const c = startEngine();
  for (const shape of ['disks', 'lines']) {
    const fx = loadFixture(`thr/binary_${shape}_skeletonize`);
    const { id } = await docOf(c, fx.input);
    await c.run(id, 'skeletonize', { invert: [false] });
    sameBytes(await c.pixels(id), decodeData(fx.cases[0].output.data), shape);
  }
  closeAll();
});

await test('the foreground rule: Black background x inverting LUT, as `foreground` and as the invert arrays', async () => {
  const fx = loadFixture('thr/binary_foreground_rule');
  const c = startEngine();
  let n = 0;
  for (const cs of fx.cases) {
    const p = cs.params;
    const fg0 = p.blackBackground ? 255 : 0, fg = p.invertedLut ? 255 - fg0 : fg0; // Binary.run
    const { id } = await docOf(c, fx.input, 'fg');
    const exp = decodeData(cs.output.data);
    if (p.op === 'erode' || p.op === 'dilate') await c.run(id, 'binary', { op: p.op, iterations: 1, count: 1, padEdges: false, foreground: fg });
    else if (p.op === 'fill holes') await c.run(id, 'binary', { op: 'fillHoles', foreground: fg });
    else if (p.op === 'outline') await c.run(id, 'segOutline', { invert: [fg === 0] });
    else if (p.op === 'skeletonize') await c.run(id, 'skeletonize', { invert: [fg === 0] });
    else assert.fail('unknown op ' + p.op);
    sameBytes(await c.pixels(id), exp, `${p.op} blackBackground=${p.blackBackground} invertedLut=${p.invertedLut}`);
    assert.equal(cs.outputInvertedLut, p.invertedLut, 'the LUT is not changed by the operation');
    n++;
  }
  assert.equal(n, 20);
  closeAll();
});

await test('Binary Median is the MEAN of the kernel, thresholded at 128 (Binary.java:169-173), radius 1 and 3', async () => {
  const c = startEngine();
  for (const r of [1, 3]) {
    const fx = loadFixture('thr/binary_median_r' + r);
    const { id } = await docOf(c, fx.input);
    await c.run(id, 'binaryMedian', { radius: fx.params.radius });
    sameBytes(await c.pixels(id), decodeData(fx.output.data), 'median r' + r);
  }
  // a fractional radius, as the dialog accepts (IJ.getNumber): RankFilters' kernel for r = 2.6 is the r = 2.85 one
  const fx = loadFixture('thr/binary_median_r3');
  const a = await docOf(c, fx.input), b = await docOf(c, fx.input);
  await c.run(a.id, 'binaryMedian', { radius: 2.6 });
  await c.run(b.id, 'binaryMedian', { radius: 2.85 });
  sameBytes(await c.pixels(a.id), await c.pixels(b.id), 'RankFilters widens 2.5-2.85 to 2.85');
  closeAll();
});

await test('v1 `binary` journal entries (no padEdges / foreground) replay to the v1 pixels', async () => {
  // the v1 operation, re-implemented here from the 1.83 code: outside = background, 255 objects, count of background neighbours
  function v1(src, w, h, op, iterations, count) {
    const pass = (s, dil) => {
      const out = new Uint8Array(w * h);
      const at = (x, y) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : (s[y * w + x] !== 0 ? 1 : 0));
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        let f = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (dx || dy) f += at(x + dx, y + dy);
        const v = at(x, y);
        out[y * w + x] = dil ? ((v || f >= count) ? 255 : 0) : ((v && 8 - f < count) ? 255 : 0);
      }
      return out;
    };
    let cur = src;
    const rep = (dil) => { for (let i = 0; i < iterations; i++) cur = pass(cur, dil); };
    if (op === 'erode') rep(false); else if (op === 'dilate') rep(true); else if (op === 'open') { rep(false); rep(true); } else { rep(true); rep(false); }
    return cur;
  }
  const fx = loadFixture('thr/binary_disks_erode');
  const W = fx.input.width, H = fx.input.height, src = decodeData(fx.input.data);
  const c = startEngine();
  for (const [op, it, cnt] of [['erode', 1, 1], ['dilate', 2, 3], ['open', 2, 1], ['close', 1, 4]]) {
    const { id } = await docOf(c, fx.input);
    await c.run(id, 'binary', { op, iterations: it, count: cnt }); // the entry as 1.84 wrote it: no new parameters
    sameBytes(await c.pixels(id), v1(src, W, H, op, it, cnt), 'v1 ' + op);
    const entry = M.IJOpRegistry.get('binary');
    assert.equal(entry.version, 1, 'binary stays at version 1');
  }
  closeAll();
});

await test('a band of 1 row, 7 rows or the whole image: the same bytes (apron = reach), every operation', async () => {
  const fx = loadFixture('thr/binary_lines_open');
  const W = fx.input.width;
  const results = {};
  for (const [label, bandPixels] of [['one', W], ['seven', 7 * W], ['whole', 1 << 20]]) {
    const c = startEngine({ bandPixels });
    for (const [op, params] of [
      ['binary', { op: 'erode', iterations: 3, count: 2, padEdges: true, foreground: 255 }], ['binary', { op: 'dilate', iterations: 2, count: 1, foreground: 0 }],
      ['binary', { op: 'open', iterations: 2, count: 1, padEdges: true, foreground: 255 }], ['binary', { op: 'close', iterations: 3, count: 3, foreground: 255 }],
      ['binary', { op: 'outline', foreground: 255 }], ['binary', { op: 'fillHoles', foreground: 0 }], ['binaryMedian', { radius: 3 }], ['binaryMedian', { radius: 1.4 }]
    ]) {
      const { id } = await docOf(c, fx.input);
      await c.run(id, op, params);
      (results[op + JSON.stringify(params)] = results[op + JSON.stringify(params)] || []).push([label, A(await c.pixels(id)).join()]);
    }
    closeAll();
  }
  for (const [k, v] of Object.entries(results)) assert.ok(v.every((x) => x[1] === v[0][1]), 'band-invariant: ' + k);
});

await test('refusals: a bad option, a non-8-bit image, nothing written into the input; undo / redo of an option run', async () => {
  const c = startEngine();
  const fx = loadFixture('thr/binary_disks_erode');
  const { id } = await docOf(c, fx.input);
  const before = A(await c.pixels(id));
  for (const params of [{ op: 'erode', foreground: 128 }, { op: 'erode', padEdges: 'yes' }, { op: 'erode', iterations: 101 }, { op: 'erode', count: 9 }, { op: 'erode', foreground: [7] }]) {
    const m = await c.call('doc.run', { docId: id, op: 'binary', params, roi: null, channel: 0 });
    assert.ok(!m.ok, JSON.stringify(params) + ' is refused');
  }
  const m16 = await c.makeDoc(8, 8, 16, [new Uint16Array(64)]);
  const bad = await c.call('doc.run', { docId: m16.id, op: 'binaryMedian', params: { radius: 1 }, roi: null, channel: 0 });
  assert.ok(!bad.ok && bad.error.code === 'IJ_BAD_TYPE', 'binaryMedian on 16 bits: ' + (bad.error && bad.error.code));
  const neg = await c.call('doc.run', { docId: id, op: 'binaryMedian', params: { radius: -1 }, roi: null, channel: 0 });
  assert.ok(!neg.ok && neg.error.code === 'IJ_BAD_ARGS');
  assert.deepEqual(A(await c.pixels(id)), before, 'nothing changed');
  // undo / redo of an option run
  await c.run(id, 'binary', { op: 'erode', iterations: 2, count: 1, padEdges: true, foreground: 255 });
  const after = A(await c.pixels(id));
  assert.notDeepEqual(after, before);
  await c.ok('doc.undo', { docId: id });
  assert.deepEqual(A(await c.pixels(id)), before, 'undo');
  await c.ok('doc.redo', { docId: id });
  assert.deepEqual(A(await c.pixels(id)), after, 'redo');
  closeAll();
});

await test('a selection limits Binary Median and the options runs to its pixels (SUPPORTS_MASKING)', async () => {
  const c = startEngine();
  const fx = loadFixture('thr/binary_median_r3');
  const W = fx.input.width, H = fx.input.height;
  const { id } = await docOf(c, fx.input);
  const before = A(await c.pixels(id));
  const roi = { type: 'rect', x: 5, y: 4, w: 12, h: 9 };
  await c.run(id, 'binaryMedian', { radius: 3 }, { roi });
  const got = A(await c.pixels(id)), full = decodeData(fx.output.data);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const inside = x >= 5 && x < 17 && y >= 4 && y < 13;
    assert.equal(got[y * W + x], inside ? full[y * W + x] : before[y * W + x], `(${x},${y})`);
  }
  closeAll();
});

await test('thr/make_binary_mask.json: Thresholder.createMask (255 inside [lower, upper]) for 8, 16 and 32 bits = the toMask operation', async () => {
  const c = startEngine();
  const fx = loadFixture('thr/make_binary_mask');
  assert.equal(fx.cases.length, 3);
  for (const cs of fx.cases) {
    const im = cs.input;
    const src = decodeData(im.data, im.bitDepth);
    const { id } = await c.makeDoc(im.width, im.height, im.bitDepth, [src], im.bitDepth === 8 ? { display: { min: 0, max: 255 } } : {});
    const r = await c.ok('doc.run', { docId: id, op: 'toMask', params: { lower: cs.lower, upper: cs.upper }, roi: null, channel: 0 });
    assert.equal(r.newDocIds.length, 1);
    assert.equal((await c.ok('doc.info', { docId: r.newDocIds[0] })).bitDepth, 8);
    sameBytes(A(await c.pixels(r.newDocIds[0])), A(decodeData(cs.mask.data)), 'make binary ' + im.bitDepth + '-bit');
  }
  closeAll();
});

await test('thr/edm_outputs_*.json: EDM / Ultimate Points / Voronoi with every "EDM output" (Overwrite, 8-bit, 16-bit, 32-bit), ImageJ 1.54p', async () => {
  const c = startEngine();
  const OUT = { 'overwrite': 'overwrite', '8-bit': 'byte', '16-bit': 'short', '32-bit': 'float' };
  let n = 0;
  for (const kind of ['edm', 'ultimatePoints', 'voronoi']) for (const shape of ['disks', 'lines']) {
    const fx = loadFixture(`thr/edm_outputs_${kind}_${shape}`);
    assert.equal(fx.op, kind);
    const im = fx.input;
    for (const cs of fx.cases) {
      const { id } = await docOf(c, im, kind + shape);
      const want = decodeData(cs.output.data, cs.output.bitDepth);
      let got, bd;
      if (cs.params.output === 'overwrite') {
        await c.run(id, kind, { output: 'overwrite' });
        got = await c.pixels(id); bd = 8;
      } else {
        const r = await c.ok('doc.run', { docId: id, op: 'edmOutput', params: { kind, output: OUT[cs.params.output] }, roi: null, channel: 0 });
        assert.equal(r.newDocIds.length, 1);
        const info = await c.ok('doc.info', { docId: r.newDocIds[0] });
        bd = info.bitDepth;
        got = await c.pixels(r.newDocIds[0]);
      }
      assert.equal(bd, cs.output.bitDepth, `${kind} ${shape} ${cs.params.output}: bit depth`);
      sameBytes(A(got), A(want), `${kind} ${shape} ${cs.params.output}`);
      n++;
    }
  }
  assert.equal(n, 24);
  closeAll();
});

await test('cancel: a cancelled Binary Median / Binary operation leaves the document untouched and writes no undo step', async () => {
  const W = 300, H = 300;
  const src = Uint8Array.from({ length: W * H }, (_, i) => ((Math.floor((i % W) / 17) + Math.floor(i / W / 13)) % 3 === 0 ? 255 : 0));
  for (const [op, params] of [['binaryMedian', { radius: 4 }], ['binary', { op: 'dilate', iterations: 3, count: 1 }]]) {
    const c = startEngine({ sliceMs: 0.001, bandPixels: W * 3 });
    const { id } = await c.makeDoc(W, H, 8, [src], { display: { min: 0, max: 255 } });
    const before = A(await c.pixels(id));
    const hook = (ev) => { if (ev.event === 'progress' && !hook.done) { hook.done = true; c.fake.onmessage({ data: { id: 9200, cmd: 'cancel', args: { targetId: ev.id } } }); } };
    c.hooks.push(hook);
    const m = await c.call('doc.run', { docId: id, op, params, roi: null, channel: 0 });
    c.hooks.length = 0;
    assert.ok(hook.done, op + ': a progress event was emitted');
    assert.ok(!m.ok && m.error.code === 'IJ_CANCELLED', op + ': ' + (m.error && m.error.code));
    assert.deepEqual(A(await c.pixels(id)), before, op + ': untouched');
    assert.equal((await c.ok('doc.info', { docId: id })).undoDepth, 0, op + ': no step');
    closeAll();
  }
});

await test('Binary Median refuses an image that is not binary, as Binary.setup does (every argument but options, the median included)', async () => {
  const c = startEngine();
  const grey = Uint8Array.from({ length: 64 }, (_, i) => (i % 5 === 0 ? 255 : i % 7 === 0 ? 0 : 100));
  const { id } = await c.makeDoc(8, 8, 8, [grey], { display: { min: 0, max: 255 } });
  const e = await c.call('doc.run', { docId: id, op: 'binaryMedian', params: { radius: 2 }, roi: null, channel: 0 });
  assert.ok(!e.ok && e.error.code === 'IJ_THR_NOT_BINARY', e.error && e.error.code);
  assert.deepEqual(A(await c.pixels(id)), A(grey));
  assert.equal((await c.ok('doc.info', { docId: id })).undoDepth, 0);
  const bin = await c.makeDoc(8, 8, 8, [grey.map((v) => (v > 50 ? 255 : 0))], { display: { min: 0, max: 255 } });
  await c.run(bin.id, 'binaryMedian', { radius: 2 });
  closeAll();
});

console.log(passed + ' tests passed (fixtures: ' + FIX.replace(/\\/g, '/').split('/').slice(-2).join('/') + ')');
void fs;
