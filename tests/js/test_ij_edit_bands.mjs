// Package edit (wave 3) — band variation: `paste` and `draw` declare `whole: true`, which today bypasses banding; this test keeps a future change
// of that flag (or of the apron) honest. The same operations run through the real engine with bandPixels of 1 row, 7 rows and the whole image
// (adaptive: false) and must give byte-identical tiles. Run: node tests/js/test_ij_edit_bands.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT } from './harness.mjs';

const DIR = path.join(ROOT, 'js', 'modules', 'studio', 'advanced-studio');
const sandbox = { console, setTimeout, clearTimeout, MessageChannel, performance, TextEncoder, TextDecoder, Blob, queueMicrotask, navigator: {} };
sandbox.self = sandbox;
vm.createContext(sandbox);
for (const f of ['ij-core.js', 'ij-analysis.js', 'ij-proc-shared.js', 'ij-engine.js', 'ij-proc-multi.js', 'ij-proc-geom.js', 'ij-proc-edit.js']) {
  vm.runInContext(fs.readFileSync(path.join(DIR, f), 'utf8'), sandbox, { filename: f });
}

function start(opts) {
  let n = 0;
  const waiters = new Map();
  const fake = { navigator: {}, onmessage: null, postMessage(m) { if (m.id !== undefined && 'ok' in m) { const w = waiters.get(m.id); if (w) { waiters.delete(m.id); w(m); } } } };
  const eng = sandbox.IJEngine.start(fake, Object.assign({ storage: 'memory', idleMs: 3600000, bandPixels: 1 << 20, adaptive: false, verifyInputs: true }, opts));
  const c = {
    eng,
    call(cmd, args) { return new Promise((res) => { const id = ++n; waiters.set(id, res); fake.onmessage({ data: { id, cmd, args } }); }); },
    async ok(cmd, args) { const m = await c.call(cmd, args); if (!m.ok) throw Object.assign(new Error(cmd + ' ' + JSON.stringify(m.error)), { e: m.error }); return m.result; }
  };
  return c;
}
async function open(c, W, H, bd, data) {
  const img = { width: W, height: H, bitDepth: bd, name: 'a', channels: [{ name: 'C1', color: '#ffffff', data, display: { min: 0, max: bd === 8 ? 255 : bd === 16 ? 65535 : 1, lut: 'Grays', invert: false } }], calibration: { pixelWidth: 1, pixelHeight: 1, unit: 'px' } };
  return (await c.ok('doc.open', { bytes: sandbox.IJTiff.write(img), name: 'a' })).docId;
}

const W = 37, H = 29;
const res = {};
const push = (k, label, v) => { (res[k] = res[k] || []).push([label, v]); };
for (const [label, bp] of [['one row', W], ['seven rows', 7 * W], ['whole', 1 << 20]]) {
  const c = start({ bandPixels: bp });
  for (const bd of [8, 16, 32]) {
    const T = bd === 8 ? Uint8Array : bd === 16 ? Uint16Array : Float32Array;
    const top = bd === 8 ? 256 : 65536;
    const src = new T(W * H);
    for (let i = 0; i < W * H; i++) src[i] = bd === 32 ? (i % 17) / 7 - 1 : (i * 37) % top;
    const clip = new T(13 * 9);
    for (let i = 0; i < clip.length; i++) clip[i] = bd === 32 ? (i % 5) - 2 : (i * 91) % top;
    const mask = new Uint8Array(13 * 9);
    for (let i = 0; i < mask.length; i++) mask[i] = i % 3 ? 1 : 0;
    // the clipboard hangs over the left edge (x = -3) and sits across the selection's rows
    for (const mode of ['copy', 'blend', 'difference', 'transparent-white', 'subtract', 'divide', 'max']) {
      const id = await open(c, W, H, bd, src);
      await c.ok('doc.run', { docId: id, op: 'paste', params: { data: clip, w: 13, h: 9, x: -3, y: 20, mode, mask }, roi: { type: 'rect', x: 0, y: 20, w: 10, h: 9 }, channel: 0 });
      const t = await c.ok('doc.tile', { docId: id, channel: 0, level: 0, tx: 0, ty: 0 });
      push('paste' + bd + mode, label, Array.from(t.data).join());
    }
    for (const roi of [{ type: 'oval', x: 3, y: 4, w: 20, h: 15 }, { type: 'line', x1: 2, y1: 3, x2: 30, y2: 25, width: 5 }, { type: 'polygon', points: [[1, 1], [30, 5], [20, 27]] }]) {
      const id = await open(c, W, H, bd, src);
      await c.ok('doc.run', { docId: id, op: 'draw', params: { value: 200, lineWidth: roi.width || 3, staticWidth: 1, shape: roi }, roi, channel: 0 });
      const t = await c.ok('doc.tile', { docId: id, channel: 0, level: 0, tx: 0, ty: 0 });
      push('draw' + bd + roi.type, label, Array.from(t.data).join());
    }
  }
  if (c.eng.dispose) c.eng.dispose();
}
let keys = 0;
for (const [k, v] of Object.entries(res)) {
  keys++;
  assert.equal(v.length, 3, k);
  for (const x of v) assert.equal(x[1], v[0][1], k + ': ' + x[0] + ' differs from ' + v[0][0]);
}
assert.ok(keys >= 30, 'keys ' + keys);
console.log('  ok  paste (7 modes x 3 depths) and draw (oval, wide line, polygon x 3 depths): ' + keys + ' results byte-identical for 1 row / 7 rows / whole bands');
