// P-fft — determinism of the pixel operations of ij-proc-fft.js through the REAL engine: Bandpass Filter and Swap Quadrants give the
// same bytes whatever the band height (1 row, 7 rows, the whole image; adaptive:false), and the synchronous loops of the package
// (applyMask, smooth, powerSpectrumMean, fingerprint, swapQuadrants, floatMinMax) call the cooperative check() so that Cancel is heard.
//
// Run: node tests/js/test_ij_fft_bands.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT } from './harness.mjs';

const DIR = path.join(ROOT, 'js', 'modules', 'studio', 'advanced-studio');
const sandbox = { console, setTimeout, clearTimeout, MessageChannel, performance, TextEncoder, TextDecoder };
sandbox.self = sandbox;
vm.createContext(sandbox);
for (const f of ['ij-core.js', 'ij-analysis.js', 'ij-proc-shared.js', 'ij-engine.js', 'ij-proc-fft.js']) vm.runInContext(fs.readFileSync(path.join(DIR, f), 'utf8'), sandbox, { filename: f });
vm.runInContext(`IJOpRegistry.define('fftTestLoad', { kind: 'size', version: 1,
  async run(view, params) { return { width: params.width, height: params.height, bitDepth: params.bitDepth, channels: params.channels.map((d, i) => ({ data: d, name: 'C' + (i + 1), color: '#ffffff' })) }; } });`, sandbox);
const { IJEngine, IJFftPkg: P } = sandbox;
assert.ok(IJEngine && P, 'modules loaded');

const closers = [];
function client(opts = {}) {
  const waiters = new Map();
  let n = 0;
  const fake = { navigator: {}, onmessage: null, postMessage(m) { if (m.id !== undefined && 'ok' in m) { const w = waiters.get(m.id); if (w) { waiters.delete(m.id); w(m); } } } };
  const eng = IJEngine.start(fake, Object.assign({ storage: 'memory', idleMs: 3600000, bandPixels: 1 << 20, adaptive: false, verifyInputs: true }, opts));
  closers.push(() => eng.dispose());
  const c = {
    call(cmd, args) { return new Promise((res) => { const id = ++n; waiters.set(id, res); fake.onmessage({ data: { id, cmd, args } }); }); },
    async ok(cmd, args) { const m = await c.call(cmd, args); assert.ok(m.ok, `${cmd} failed: ${m.error && m.error.code}`); return m.result; },
    async load(W, H, bd, data) {
      const { docId } = await c.ok('doc.create', { name: 'fx', width: 1, height: 1, bitDepth: 8, channels: [{ name: 'A', color: '#fff' }] });
      await c.ok('doc.run', { docId, op: 'fftTestLoad', params: { width: W, height: H, bitDepth: bd, channels: [data] }, roi: null, channel: 0 });
      return docId;
    },
    async pixels(docId) { return Array.from((await c.ok('doc.tile', { docId, channel: 0, level: 0, tx: 0, ty: 0 })).data); }
  };
  return c;
}
const lcg = (seed) => () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
function image(W, H, bd) {
  const rnd = lcg(12345), n = W * H;
  const a = bd === 8 ? new Uint8Array(n) : bd === 16 ? new Uint16Array(n) : new Float32Array(n);
  for (let i = 0; i < n; i++) { const v = rnd() >>> 16; a[i] = bd === 8 ? v & 255 : bd === 16 ? v : (v - 20000) / 37; }
  return a;
}

let passed = 0;
async function test(name, fn) { try { await fn(); passed++; console.log('  ok  ' + name); } catch (e) { console.error('FAIL ' + name); throw e; } }

await test('Bandpass Filter: 1-row bands = 7-row bands = the whole image, byte for byte (8 / 16 / 32 bits, every stripe option)', async () => {
  const W = 37, H = 29;
  for (const bd of [8, 16, 32]) {
    const data = image(W, H, bd);
    for (const stripes of [0, 1, 2]) {
      const outs = [];
      for (const bandPixels of [W, W * 7, 1 << 20]) {
        const c = client({ bandPixels });
        const id = await c.load(W, H, bd, data.slice());
        await c.ok('doc.run', { docId: id, op: 'bandpass', params: { large: 10, small: 2, stripes, tolerance: 5, autoscale: true, saturate: true }, roi: null, channel: 0 });
        outs.push(await c.pixels(id));
      }
      assert.deepEqual(outs[1], outs[0], `${bd}-bit stripes ${stripes}: 7-row bands`);
      assert.deepEqual(outs[2], outs[0], `${bd}-bit stripes ${stripes}: whole image`);
    }
  }
});

await test('Bandpass Filter with a selection and Swap Quadrants: the same bytes whatever the band height', async () => {
  const W = 37, H = 29, data = image(W, H, 8);
  const outs = [];
  for (const bandPixels of [W, W * 7, 1 << 20]) {
    const c = client({ bandPixels });
    const id = await c.load(W, H, 8, data.slice());
    await c.ok('doc.run', { docId: id, op: 'bandpass', params: { large: 10, small: 2, stripes: 0, tolerance: 5, autoscale: false, saturate: false }, roi: { type: 'rect', x: 5, y: 4, w: 20, h: 17 }, channel: 0 });
    outs.push(await c.pixels(id));
  }
  assert.deepEqual(outs[1], outs[0]); assert.deepEqual(outs[2], outs[0]);
  const S = 32, sq = image(S, S, 16), sw = [];
  for (const bandPixels of [S, S * 7, 1 << 20]) {
    const c = client({ bandPixels });
    const id = await c.load(S, S, 16, sq.slice());
    await c.ok('doc.run', { docId: id, op: 'swapQuadrants', params: {}, roi: null, channel: 0 });
    sw.push(await c.pixels(id));
  }
  assert.deepEqual(sw[1], sw[0]); assert.deepEqual(sw[2], sw[0]);
  assert.notDeepEqual(sw[0], Array.from(sq), 'the quadrants moved');
});

await test('the synchronous loops of the package call check() (Cancel is heard on a large spectrum) and still give the same values', async () => {
  const n = 1024;
  let calls = 0;
  const hk = { check() { calls++; }, tick() {} };
  const mask = new Uint8Array(n * n).fill(7); mask[5] = 0;
  const fht = new Float32Array(n * n).fill(1.5);
  P.applyMask(fht, n, mask, n, n, 8, hk);
  assert.ok(calls >= 4, 'applyMask: ' + calls);
  calls = 0; P.powerSpectrumMean(fht, n, hk); assert.ok(calls >= 2, 'powerSpectrumMean: ' + calls);
  calls = 0; P.fingerprint(mask, 8, hk); assert.ok(calls >= 1, 'fingerprint: ' + calls);
  calls = 0; P.swapQuadrants(new Uint8Array(2048 * 2048), 2048, 2048, true, hk); assert.ok(calls >= 1, 'swapQuadrants: ' + calls);
  assert.equal(P.fingerprint(mask, 8, hk), P.fingerprint(mask, 8), 'the hooks change nothing');
  // a check() that throws stops the loop
  const stop = { check() { throw Object.assign(new Error('cancel'), { code: 'IJ_CANCELLED' }); }, tick() {} };
  assert.throws(() => P.applyMask(fht, n, mask, n, n, 8, stop), /cancel/);
  assert.throws(() => P.powerSpectrumMean(fht, n, stop), /cancel/);
  assert.throws(() => P.fingerprint(mask, 8, stop), /cancel/);
});

for (const f of closers) f();
console.log(`test_ij_fft_bands: ${passed} tests passed`);
