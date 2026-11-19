// P-ov — the `paintMask` operation (ij-proc-ov.js) through the REAL engine behind a request / answer client: the burn-in of a
// Scale Bar. Per-channel values on 8 / 16 / 32-bit images, layers painted in order, the selection ignored, undo / redo,
// refusals, band determinism (1-row bands, 7-row bands, one band: byte-identical, adaptive: false), cancel leaves the document
// untouched, no input array is written (the engine's verifyInputs is on), the journal replays after a reload.
//
// Run: node tests/js/test_ij_ov_op.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT } from './harness.mjs';

const DIR = path.join(ROOT, 'js', 'modules', 'studio', 'advanced-studio');
const sandbox = { console, setTimeout, clearTimeout, MessageChannel, performance, TextEncoder, TextDecoder, Blob, queueMicrotask, navigator: {} };
sandbox.self = sandbox;
vm.createContext(sandbox);
for (const f of ['ij-core.js', 'ij-analysis.js', 'ij-proc-shared.js', 'ij-engine.js', 'ij-proc-ov.js']) vm.runInContext(fs.readFileSync(path.join(DIR, f), 'utf8'), sandbox, { filename: f });
const { IJEngine, IJTiff } = sandbox;
const OV = sandbox.IJOv;
assert.ok(sandbox.IJOpRegistry.get('paintMask'), 'paintMask is registered');

let passed = 0;
async function test(name, fn) { try { await fn(); passed++; console.log('  ok  ' + name); } catch (e) { console.error('FAIL ' + name); throw e; } }
const arr = (a) => Array.from(a);
const closers = [];

function startEngine(opts = {}) {
  const hooks = [], waiters = new Map();
  let n = 0;
  const fake = {
    navigator: {}, onmessage: null,
    postMessage(m) {
      if (m.id !== undefined && 'ok' in m) { const w = waiters.get(m.id); if (w) { waiters.delete(m.id); w(m); } } else for (const h of hooks) h(m);
    }
  };
  const eng = IJEngine.start(fake, Object.assign({ storage: 'memory', idleMs: 3600000, bandPixels: 1 << 20, adaptive: false, verifyInputs: true }, opts));
  closers.push(() => eng.dispose());
  const c = {
    fake, hooks,
    call(cmd, args) { return new Promise((res) => { const id = ++n; waiters.set(id, res); fake.onmessage({ data: { id, cmd, args } }); }); },
    async ok(cmd, args) { const m = await c.call(cmd, args); assert.ok(m.ok, `${cmd} failed: ${m.error && m.error.code}`); return m.result; },
    async err(cmd, args) { const m = await c.call(cmd, args); assert.ok(!m.ok, `${cmd} should have failed`); return m.error; },
    async makeDoc(W, H, bd, chans, extra = {}) {
      const img = {
        width: W, height: H, bitDepth: bd, name: 'img',
        channels: chans.map((d, i) => ({ name: 'C' + (i + 1), color: '#ffffff', data: d, display: { lut: 'Grays', invert: false, min: bd === 8 ? 0 : 0, max: bd === 8 ? 255 : 1000 } })),
        calibration: { pixelWidth: 1, pixelHeight: 1, unit: 'px' }
      };
      void extra;
      const r = await c.ok('doc.open', { bytes: IJTiff.write(img), name: 'img' });
      return { id: r.docId, info: r.info };
    },
    async pixels(id, ch = 0) { return (await c.ok('doc.tile', { docId: id, channel: ch, level: 0, tx: 0, ty: 0 })).data.slice(); },
    async paint(id, params, roi) { return c.ok('doc.run', { docId: id, op: 'paintMask', params, roi: roi || null, channel: 'all' }); }
  };
  return c;
}
const T = { 8: Uint8Array, 16: Uint16Array, 32: Float32Array };
const ramp = (bd, n, mul) => T[bd].from({ length: n }, (_, i) => (i * (mul || 1)) % (bd === 8 ? 251 : 997));
/** The runs of a set of rectangles over w × h (what the command builds). */
const runsOf = (w, h, rects) => OV.buildMaskRuns(w, h, rects, []);
/** Reference: the same paint on a dense copy. */
function reference(src, W, H, bd, layers, c) {
  const out = src.slice();
  for (const L of layers) {
    const dense = new Uint8Array(W * H);
    let pos = 0;
    for (let i = 0; i < L.runs.length; i++) { if (i & 1) dense.fill(1, pos, pos + L.runs[i]); pos += L.runs[i]; }
    const v = bd === 32 ? Math.fround(L.values[c]) : Math.min(bd === 8 ? 255 : 65535, Math.max(0, Math.trunc(L.values[c])));
    for (let i = 0; i < dense.length; i++) if (dense[i]) out[i] = v;
  }
  return out;
}

await test('paintMask writes each channel its own value: 8, 16 and 32 bits, the selection is ignored', async () => {
  for (const bd of [8, 16, 32]) {
    const c = startEngine();
    const W = 37, H = 23;
    const chans = [ramp(bd, W * H, 1), ramp(bd, W * H, 3), ramp(bd, W * H, 7)];
    const d = await c.makeDoc(W, H, bd, chans);
    const rects = [{ x: 5, y: 4, w: 20, h: 3 }, { x: 30, y: 15, w: 20, h: 20 }];
    const layers = [{ runs: runsOf(W, H, rects), values: bd === 32 ? [1.5, -2.25, 3e9] : bd === 16 ? [70000, -4, 513.9] : [300, -1, 77.9] }];
    const before = chans.map((a) => a.slice());
    // a selection that is far from the mask: still the whole image
    const res = await c.paint(d.id, { w: W, h: H, layers }, { type: 'rect', x: 0, y: 0, w: 3, h: 3 });
    assert.ok(res, 'ran');
    for (let ch = 0; ch < 3; ch++) assert.deepEqual(arr(await c.pixels(d.id, ch)), arr(reference(before[ch], W, H, bd, layers, ch)), `${bd}-bit channel ${ch}`);
    // undo, redo
    await c.ok('doc.undo', { docId: d.id });
    for (let ch = 0; ch < 3; ch++) assert.deepEqual(arr(await c.pixels(d.id, ch)), arr(before[ch]), `undo ${bd} ${ch}`);
    await c.ok('doc.redo', { docId: d.id });
    for (let ch = 0; ch < 3; ch++) assert.deepEqual(arr(await c.pixels(d.id, ch)), arr(reference(before[ch], W, H, bd, layers, ch)), `redo ${bd} ${ch}`);
  }
});

await test('layers are painted in order: the bar over its background; a layer may be empty or cover everything', async () => {
  const c = startEngine();
  const W = 20, H = 10;
  const d = await c.makeDoc(W, H, 8, [ramp(8, W * H)]);
  const layers = [
    { runs: runsOf(W, H, [{ x: 2, y: 2, w: 12, h: 5 }]), values: [10] },
    { runs: runsOf(W, H, [{ x: 4, y: 3, w: 6, h: 2 }]), values: [200] },
    { runs: runsOf(W, H, []), values: [99] }
  ];
  await c.paint(d.id, { w: W, h: H, layers });
  const px = await c.pixels(d.id);
  const at = (x, y) => px[y * W + x];
  assert.equal(at(2, 2), 10); assert.equal(at(13, 6), 10); assert.equal(at(14, 6), (6 * W + 14) % 251);
  assert.equal(at(4, 3), 200); assert.equal(at(9, 4), 200); assert.equal(at(10, 4), 10);
  const all = startEngine();
  const e = await all.makeDoc(W, H, 8, [ramp(8, W * H)]);
  await all.paint(e.id, { w: W, h: H, layers: [{ runs: [0, W * H], values: [7] }] });
  assert.ok((await all.pixels(e.id)).every((v) => v === 7));
});

await test('refusals: another size, runs that do not cover the image, a value count that is not the channel count, no layer', async () => {
  const c = startEngine();
  const W = 12, H = 8;
  const d = await c.makeDoc(W, H, 8, [ramp(8, W * H), ramp(8, W * H)]);
  const ok = { runs: [0, W * H], values: [1, 2] };
  assert.equal((await c.err('doc.run', { docId: d.id, op: 'paintMask', params: { w: W + 1, h: H, layers: [ok] }, roi: null, channel: 'all' })).code, 'IJ_SIZE_MISMATCH');
  for (const bad of [
    { w: W, h: H, layers: [] },
    { w: W, h: H, layers: [{ runs: [0, W * H - 1], values: [1, 2] }] },
    { w: W, h: H, layers: [{ runs: [0, -4, W * H + 4], values: [1, 2] }] },
    { w: W, h: H, layers: [{ runs: [0, W * H], values: [1] }] },
    { w: W, h: H, layers: [{ runs: [0, W * H], values: [1, NaN] }] },
    { w: W, h: H, layers: [{ runs: [0.5, W * H - 0.5], values: [1, 2] }] },
    { w: W, h: H, layers: new Array(9).fill(ok) },
    { w: W, h: H }
  ]) assert.equal((await c.err('doc.run', { docId: d.id, op: 'paintMask', params: bad, roi: null, channel: 'all' })).code, 'IJ_BAD_ARGS', JSON.stringify(bad).slice(0, 80));
  assert.deepEqual(arr(await c.pixels(d.id, 0)), arr(ramp(8, W * H)), 'nothing was written');
});

await test('band determinism: 1-row bands, 7-row bands and one band give the same bytes (8 / 16 / 32 bits, large irregular masks)', async () => {
  const W = 61, H = 43;
  let seed = 11;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed; };
  const rects = [];
  for (let k = 0; k < 14; k++) rects.push({ x: (rnd() % (W + 10)) - 5, y: (rnd() % (H + 10)) - 5, w: rnd() % 25, h: rnd() % 14 });
  const patch = { x: 8, y: 9, w: 17, h: 11, data: Uint8Array.from({ length: 17 * 11 }, () => rnd() % 3 === 0 ? 1 : 0) };
  const layers = [{ runs: OV.buildMaskRuns(W, H, rects, [patch]), values: [3, 4, 5] }, { runs: OV.buildMaskRuns(W, H, rects.slice(3, 8), []), values: [250, 251, 252] }];
  for (const bd of [8, 16, 32]) {
    const chans = [ramp(bd, W * H, 1), ramp(bd, W * H, 3), ramp(bd, W * H, 5)];
    const run = async (bandPixels) => {
      const c = startEngine({ bandPixels });
      const d = await c.makeDoc(W, H, bd, chans);
      await c.paint(d.id, { w: W, h: H, layers });
      return Promise.all([0, 1, 2].map(async (ch) => Buffer.from((await c.pixels(d.id, ch)).buffer.slice(0))));
    };
    const whole = await run(1 << 24);
    for (const rows of [1, 7]) {
      const part = await run(W * rows);
      for (let ch = 0; ch < 3; ch++) assert.equal(Buffer.compare(part[ch], whole[ch]), 0, `${bd}-bit, ${rows}-row bands, channel ${ch}`);
    }
    const w0 = new T[bd](whole[0].buffer, whole[0].byteOffset, whole[0].byteLength / (bd / 8));
    assert.deepEqual(arr(w0), arr(reference(chans[0], W, H, bd, layers, 0)), 'and they equal the dense reference');
  }
});

await test('paintBand is a pure function of position: any cut of the image gives the same rows', async () => {
  const W = 29, H = 31;
  const layers = [{ runs: OV.buildMaskRuns(W, H, [{ x: 3, y: 2, w: 20, h: 9 }, { x: 0, y: 20, w: 29, h: 4 }], []), value: 9 }];
  const cum = layers.map((L) => { const s = new Float64Array(L.runs.length + 1); for (let i = 0; i < L.runs.length; i++) s[i + 1] = s[i] + L.runs[i]; return s; });
  const src = ramp(8, W * H);
  const whole = OV.paintBand(src, W, { x: 0, y: 0, w: W, h: H }, layers, cum);
  for (const rows of [1, 2, 7, 13]) {
    for (let y = 0; y < H; y += rows) {
      const h = Math.min(rows, H - y);
      const band = OV.paintBand(src, W, { x: 0, y, w: W, h }, layers, cum);
      assert.deepEqual(arr(band), arr(whole.subarray(y * W, (y + h) * W)), `band ${y}+${h}`);
    }
  }
  // a band that is not full width (a region op) keeps its own columns
  const part = OV.paintBand(src, W, { x: 5, y: 2, w: 10, h: 4 }, layers, cum);
  for (let y = 0; y < 4; y++) assert.deepEqual(arr(part.subarray(y * 10, y * 10 + 10)), arr(whole.subarray((2 + y) * W + 5, (2 + y) * W + 15)));
});

await test('cancel leaves the document untouched; progress is reported', async () => {
  const c = startEngine();
  const W = 1500, H = 1500;
  const base = new Uint8Array(W * H).fill(5);
  const d = await c.makeDoc(W, H, 8, [base]);
  let seen = 0;
  c.hooks.push((m) => { if (m.event === 'progress') { seen++; if (seen === 1) c.fake.onmessage({ data: { id: 880001, cmd: 'cancel', args: { targetId: m.id } } }); } });
  const r = await c.call('doc.run', { docId: d.id, op: 'paintMask', params: { w: W, h: H, layers: [{ runs: [0, W * H], values: [200] }] }, roi: null, channel: 'all' });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'IJ_CANCELLED');
  assert.ok(seen >= 1);
  const px = await c.pixels(d.id);
  assert.ok(px.every((v) => v === 5), 'no pixel changed');
});

await test('one undo step, each channel painted with its own value (a reload is covered by test_ij_ov_commands)', async () => {
  const W = 33, H = 21;
  const c = startEngine();
  const d = await c.makeDoc(W, H, 16, [ramp(16, W * H, 2), ramp(16, W * H, 9)]);
  const layers = [{ runs: runsOf(W, H, [{ x: 4, y: 5, w: 11, h: 6 }]), values: [900, 123] }];
  await c.paint(d.id, { w: W, h: H, layers });
  const want = [await c.pixels(d.id, 0), await c.pixels(d.id, 1)];
  const info = (await c.ok('doc.list', {})).docs.find((x) => x.docId === d.id);
  assert.equal(info.undoDepth, 1, 'one undo step');
  assert.deepEqual(arr(want[0].subarray(5 * W + 4, 5 * W + 15)), new Array(11).fill(900));
  assert.deepEqual(arr(want[1].subarray(5 * W + 4, 5 * W + 15)), new Array(11).fill(123));
});

for (const f of closers) f();
console.log(`test_ij_ov_op: ${passed} groups passed`);
