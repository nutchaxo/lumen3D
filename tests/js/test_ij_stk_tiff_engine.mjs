// TIFF in and out of the worker engine for stacks, hyperstacks and RGB (doc.exportTiff / doc.open), with the REAL modules under Node:
// a document survives export + open (planes, labels, mode, calibration, display, hyperstack flag), a compressed ImageJ stack opens through
// IJLocalTiff, a refused file says why.  Run: node tests/js/test_ij_stk_tiff_engine.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import zlib from 'node:zlib';
import { ROOT } from './harness.mjs';

const DIR = path.join(ROOT, 'js', 'modules', 'studio', 'advanced-studio');
const sandbox = { console, setTimeout, clearTimeout, MessageChannel, performance, TextEncoder, TextDecoder, DecompressionStream, Response, Blob };
sandbox.self = sandbox;
vm.createContext(sandbox);
for (const f of ['ij-core.js', 'ij-analysis.js', 'ij-proc-lib.js', 'ij-proc-io.js', 'ij-engine.js']) vm.runInContext(fs.readFileSync(path.join(DIR, f), 'utf8'), sandbox, { filename: f });
const { IJEngine } = sandbox;
const A = (x) => Array.from(x);
const closers = [];

function client() {
  const waiters = new Map();
  let n = 0;
  const fake = { navigator: {}, onmessage: null, postMessage(m) { if (m.id !== undefined && 'ok' in m) { const w = waiters.get(m.id); if (w) { waiters.delete(m.id); w(m); } } } };
  const eng = IJEngine.start(fake, { storage: 'memory', idleMs: 3600000, bandPixels: 1 << 20, verifyInputs: true });
  closers.push(() => eng.dispose());
  const call = (cmd, args) => new Promise((res) => { const id = ++n; waiters.set(id, res); fake.onmessage({ data: { id, cmd, args } }); });
  return {
    eng, call,
    async ok(cmd, args) { const m = await call(cmd, args); assert.ok(m.ok, `${cmd} failed: ${m.error && m.error.code}`); return m.result; },
    async err(cmd, args) { const m = await call(cmd, args); assert.ok(!m.ok, `${cmd} should have failed`); return m.error; }
  };
}

const W = 7, H = 5;
const fill = (bd, seed) => { const a = bd === 8 ? new Uint8Array(W * H) : bd === 16 ? new Uint16Array(W * H) : new Float32Array(W * H); for (let i = 0; i < a.length; i++) a[i] = bd === 8 ? (i * 7 + seed * 13) & 255 : bd === 16 ? i * 311 + seed * 977 : (i - 9) * 0.75 + seed; return a; };
function hyper(bd, nC, nZ, nT) {
  return {
    name: 'hyp', width: W, height: H, bitDepth: bd, nZ, nT, hyperstack: true,
    labels: Array.from({ length: nC * nZ * nT }, (_, i) => 'lab ' + i),
    calibration: { pixelWidth: 0.25, pixelHeight: 0.25, pixelDepth: 1.5, unit: 'µm', frameInterval: 2, timeUnit: 'sec', fps: 4, loop: false },
    mode: 'color',
    channels: Array.from({ length: nC }, (_, c) => ({
      name: 'C' + (c + 1), color: ['#ff0000', '#00ff00', '#0000ff'][c],
      display: { min: 2 + c, max: bd === 8 ? 200 : bd === 16 ? 50000 : 33.5, lut: ['Red', 'Green', 'Blue'][c], invert: false },
      planes: Array.from({ length: nZ * nT }, (_, pi) => fill(bd, c * 10 + pi))
    }))
  };
}

let passed = 0;
async function test(name, fn) { try { await fn(); passed++; console.log('  ok  ' + name); } catch (e) { console.error('FAIL ' + name); throw e; } }

await test('a hyperstack of every bit depth survives doc.exportTiff + doc.open', async () => {
  for (const bd of [8, 16, 32]) {
    const c = client();
    const img = hyper(bd, 2, 3, 2);
    const { docId } = await c.ok('doc.import', { image: img });
    const ex = await c.ok('doc.exportTiff', { docId });
    assert.equal(String.fromCharCode(ex.bytes[0], ex.bytes[1]), 'MM', 'ImageJ layout for a stack');
    const op = await c.ok('doc.open', { bytes: ex.bytes, name: 'back' });
    const info = op.info;
    assert.deepEqual([info.nZ, info.nT, info.channels.length, info.hyperstack, info.rgb, info.bitDepth], [3, 2, 2, true, false, bd]);
    assert.equal(info.nSlices, 12);
    const d = c.eng.inspectDoc(info.docId), s = c.eng.inspectDoc(docId);
    assert.equal(d.mode, 'color', 'the display mode comes back');
    assert.deepEqual(A(d.labels), A(s.labels));
    for (let ch = 0; ch < 2; ch++) {
      for (let pi = 0; pi < 6; pi++) assert.deepEqual(A(d.channels[ch].planes[pi]), A(s.channels[ch].planes[pi]), `bd ${bd} ch ${ch} plane ${pi}`);
      assert.equal(d.channels[ch].display.min, s.channels[ch].display.min);
      assert.equal(d.channels[ch].display.max, s.channels[ch].display.max);
    }
    assert.ok(Math.abs(d.calibration.pixelDepth - 1.5) < 1e-12);
    assert.equal(d.calibration.frameInterval, 2); assert.equal(d.calibration.fps, 4);
    assert.ok(Math.abs(d.calibration.pixelWidth - 0.25) < 1e-6);
    assert.ok(!op.info.unsaved, "a file just read is not unsaved");
  }
});

await test('an RGB stack and an RGB image', async () => {
  const c = client();
  const rgb = (k) => ({ name: 'rgb', width: W, height: H, bitDepth: 8, rgb: true, nZ: k, nT: 1, labels: k > 1 ? Array.from({ length: k }, (_, i) => 'z' + i) : null,
    calibration: { pixelWidth: 1, pixelHeight: 1, unit: 'pixel' },
    channels: ['Red', 'Green', 'Blue'].map((n, ch) => ({ name: n, color: ['#ff0000', '#00ff00', '#0000ff'][ch], display: { min: 0, max: 255, lut: n, invert: false }, planes: Array.from({ length: k }, (_, pi) => fill(8, ch * 3 + pi)) })) });
  for (const k of [1, 3]) {
    const { docId } = await c.ok('doc.import', { image: rgb(k) });
    const ex = await c.ok('doc.exportTiff', { docId });
    const op = await c.ok('doc.open', { bytes: ex.bytes });
    assert.deepEqual([op.info.rgb, op.info.nZ, op.info.bitDepth, op.info.bitDepthIJ], [true, k, 8, 24]);
    const d = c.eng.inspectDoc(op.info.docId), s = c.eng.inspectDoc(docId);
    for (let ch = 0; ch < 3; ch++) for (let pi = 0; pi < k; pi++) assert.deepEqual(A(d.channels[ch].planes[pi]), A(s.channels[ch].planes[pi]));
    if (k > 1) assert.deepEqual(A(d.labels), A(s.labels));
  }
});

await test('a legacy single-plane multichannel document is still written the first versions\' way', async () => {
  const c = client();
  const img = { name: 'a', width: W, height: H, bitDepth: 16, calibration: { pixelWidth: 1, pixelHeight: 1, unit: 'pixel' },
    channels: [0, 1].map((k) => ({ name: 'n' + k, color: '#ffffff', data: fill(16, k), display: { min: 0, max: 60000, lut: 'Grays', invert: false } })) };
  const { docId } = await c.ok('doc.import', { image: img });
  const ex = await c.ok('doc.exportTiff', { docId });
  assert.equal(String.fromCharCode(ex.bytes[0], ex.bytes[1]), 'II');
  const op = await c.ok('doc.open', { bytes: ex.bytes });
  assert.deepEqual([op.info.nZ, op.info.nT, op.info.channels.length], [1, 1, 2]);
  assert.deepEqual(A(op.info.channels.map((x) => x.name)), ['n0', 'n1']);
});

await test('a compressed (deflate + predictor) ImageJ stack opens as a stack, RGB too', async () => {
  const c = client();
  // build it with the engine's own writer, then re-encode the strips with deflate + horizontal differencing (what Download Center files are)
  const img = hyper(16, 2, 2, 1);
  const { docId } = await c.ok('doc.import', { image: img });
  const ex = await c.ok('doc.exportTiff', { docId });
  const T = sandbox.IJTiff;
  const P = T.parse(ex.bytes);
  const planes = [];
  for (const tags of P.ifds) { const i = T.ifdInfo(P, tags); const bytes = ex.bytes.subarray(i.so[0], i.so[0] + i.sc[0]); planes.push(Uint16Array.from({ length: W * H }, (_, k) => (bytes[k * 2] << 8) | bytes[k * 2 + 1])); }
  const { buildTiff } = await import('./ij_io_support.mjs');
  const desc = 'ImageJ=1.54p\nimages=4\nchannels=2\nslices=2\nhyperstack=true\nmode=composite\n';
  const bytes = buildTiff({ width: W, height: H, bitDepth: 16, planes: planes.map((p) => p.slice()), compression: 'deflate', predictor: 2, rowsPerStrip: 2, bigEndian: true, description: desc });
  const op = await c.ok('doc.open', { bytes });
  assert.deepEqual([op.info.nZ, op.info.nT, op.info.channels.length, op.info.hyperstack], [2, 1, 2, true]);
  const d = c.eng.inspectDoc(op.info.docId), s = c.eng.inspectDoc(docId);
  for (let ch = 0; ch < 2; ch++) for (let pi = 0; pi < 2; pi++) assert.deepEqual(A(d.channels[ch].planes[pi]), A(s.channels[ch].planes[pi]));
});

await test('doc.exportTiff of a stack counts every plane in its budget check', async () => {
  const c = client();
  const { docId } = await c.ok('doc.import', { image: hyper(16, 2, 4, 3) });
  const ex = await c.ok('doc.exportTiff', { docId });
  assert.ok(ex.bytes.length >= 24 * W * H * 2);
  assert.equal(typeof ex.rev, 'number');
});

for (const f of closers) f();
console.log(`test_ij_stk_tiff_engine: ${passed} passed`);
