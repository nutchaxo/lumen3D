// Shared support of the P-thr tests of the Advanced Studio: not a test (no `test_` prefix).
//
//   startEngine(opts)   the REAL engine (ij-engine.js) with the REAL pure modules and ij-proc-seg.js + ij-proc-thr.js, in one
//                       vm context, behind a request / answer client (the way test_ij_engine.mjs does it);
//   decodeData / imageOf / diff helpers for the recordings of tests/fixtures/ij-wave3 (ImageJ 1.54p and Fiji).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT } from './harness.mjs';

export const DIR = path.join(ROOT, 'js', 'modules', 'studio', 'advanced-studio');
export const FIX = path.join(ROOT, 'tests', 'fixtures', 'ij-wave3');

const sandbox = { console, setTimeout, clearTimeout, MessageChannel, performance, TextEncoder, TextDecoder, Blob, queueMicrotask, navigator: {} };
sandbox.self = sandbox;
vm.createContext(sandbox);
for (const f of ['ij-core.js', 'ij-analysis.js', 'ij-proc-shared.js', 'ij-engine.js', 'ij-proc-seg.js', 'ij-proc-thr.js']) {
  vm.runInContext(fs.readFileSync(path.join(DIR, f), 'utf8'), sandbox, { filename: f });
}
export const M = sandbox;

const closers = [];
export function closeAll() { for (const c of closers.splice(0)) c(); }

export function startEngine(opts = {}) {
  const log = [];
  const hooks = [];
  const waiters = new Map();
  let n = 0;
  const fake = {
    navigator: {}, onmessage: null,
    postMessage(m) {
      log.push(m);
      if (m.id !== undefined && 'ok' in m) { const w = waiters.get(m.id); if (w) { waiters.delete(m.id); w(m); } }
      else for (const h of hooks) h(m);
    }
  };
  const eng = sandbox.IJEngine.start(fake, Object.assign({ storage: 'memory', idleMs: 3600000, bandPixels: 1 << 20, adaptive: false, verifyInputs: true }, opts));
  closers.push(() => eng.dispose());
  const c = {
    log, eng, fake, hooks, lastId: 0,
    call(cmd, args) { return new Promise((res) => { const id = ++n; c.lastId = id; waiters.set(id, res); fake.onmessage({ data: { id, cmd, args } }); }); },
    async ok(cmd, args) {
      const m = await c.call(cmd, args);
      assert.ok(m.ok, `${cmd} failed: ${m.error && m.error.code}`);
      return m.result;
    },
    async err(cmd, args) {
      const m = await c.call(cmd, args);
      assert.ok(!m.ok, `${cmd} should have failed`);
      return m.error;
    },
    /** A document from typed arrays (one per channel), through a TIFF the engine opens. */
    async makeDoc(W, H, bd, chans, o = {}) {
      const range = bd === 8 ? { min: 0, max: 255 } : null;
      const img = {
        width: W, height: H, bitDepth: bd, name: o.name || 'img',
        channels: chans.map((d, i) => {
          let r = range;
          if (!r) { let lo = Infinity, hi = -Infinity; for (let k = 0; k < d.length; k++) { const v = d[k]; if (v === v) { if (v < lo) lo = v; if (v > hi) hi = v; } } r = lo <= hi ? { min: lo, max: hi } : { min: 0, max: 1 }; if (!(r.max > r.min)) r = { min: r.min, max: r.min + 1 }; }
          return { name: 'C' + (i + 1), color: ['#ffffff', '#00ff00', '#ff0000'][i] || '#ffffff', data: d, display: Object.assign({ lut: 'Grays', invert: false }, o.display || r) };
        }),
        calibration: o.calibration || { pixelWidth: 1, pixelHeight: 1, unit: 'px' }
      };
      const bytes = sandbox.IJTiff.write(img);
      const r = await c.ok('doc.open', { bytes, name: img.name });
      return { id: r.docId, info: r.info };
    },
    async pixels(id, ch = 0) {
      const t = await c.ok('doc.tile', { docId: id, channel: ch, level: 0, tx: 0, ty: 0 });
      return t.data.slice();
    },
    async run(id, op, params, o = {}) {
      return c.ok('doc.run', { docId: id, op, params, roi: o.roi === undefined ? null : o.roi, channel: o.channel === undefined ? 0 : o.channel });
    }
  };
  return c;
}

// ── fixtures ──
export function decodeData(d, bitDepth) {
  if (Array.isArray(d)) {
    const a = Float64Array.from(d, (v) => (v === null ? NaN : v));
    return a;
  }
  const b = Buffer.from(d.b64, 'base64');
  const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  return d.dtype === 'u8' ? new Uint8Array(ab) : d.dtype === 'u16' ? new Uint16Array(ab) : new Float32Array(ab);
}
export function typed(bd, arr) {
  const T = bd === 8 ? Uint8Array : bd === 16 ? Uint16Array : Float32Array;
  return T.from(arr); // a plain float list is the shortest repr of a float32: the Float32Array conversion is Math.fround
}
export function imageOf(img) { return typed(img.bitDepth, decodeData(img.data, img.bitDepth)); }
export const loadFixture = (name) => JSON.parse(fs.readFileSync(path.join(FIX, name + '.json'), 'utf8'));

/** The selection of a fixture: a rectangle as such, an oval / polygon as the exact mask ImageJ rasterised. */
export function roiOf(fx, W, H) {
  const r = fx.roi;
  if (!r) return null;
  if (r.type === 'rect') return { type: 'rect', x: r.x, y: r.y, w: r.w, h: r.h };
  const m = r.mask;
  const d = decodeData(m.data);
  const full = new Uint8Array(W * H);
  for (let y = 0; y < m.h; y++) for (let x = 0; x < m.w; x++) if (d[y * m.w + x]) full[(m.y + y) * W + m.x + x] = 1;
  return sandbox.IJRoi.fromMask(full, W, H);
}

/** Compares two arrays element by element: NaN equals NaN, -0 equals 0. Returns { n, max, first } for the mismatches. */
export function diff(a, b, tol = 0) {
  assert.equal(a.length, b.length, 'same length');
  let n = 0, max = 0, first = -1;
  for (let i = 0; i < a.length; i++) {
    const x = a[i], y = b[i];
    if (x === y || (x !== x && y !== y)) continue;
    const d = Math.abs(x - y);
    if (tol > 0 && d <= tol) continue;
    n++;
    if (d > max || d !== d) max = d;
    if (first < 0) first = i;
  }
  return { n, max, first };
}
