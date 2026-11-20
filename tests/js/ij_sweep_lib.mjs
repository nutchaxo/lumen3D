// Shared helpers of the stack sweep tests (not a test: no `test_` prefix): the real engine + every ij-proc package behind a fake
// `self`, and a reader that turns the ImageJ 1.54p golden fixtures of tests/fixtures/ij-stacks into stack images and back.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT } from './harness.mjs';

export const DIR = path.join(ROOT, 'js', 'modules', 'studio', 'advanced-studio');
export const FIX = path.join(ROOT, 'tests', 'fixtures', 'ij-stacks');
export const PKGS = ['bg', 'filters', 'seg', 'multi', 'geom', 'roi', 'coloc', 'thr', 'enh', 'fft', 'sel', 'io', 'ov', 'ana', 'edit', 'fiji', 'lib', 'stk'];

export function loadWorld(pkgs = PKGS, extra = {}) {
  const sandbox = Object.assign({ console, setTimeout, clearTimeout, MessageChannel, performance, TextEncoder, TextDecoder }, extra);
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  const files = ['ij-core.js', 'ij-analysis.js', 'ij-proc-shared.js'];
  for (const p of pkgs) if (fs.existsSync(path.join(DIR, 'ij-proc-' + p + '.js'))) files.push('ij-proc-' + p + '.js');
  files.push('ij-engine.js');
  for (const f of files) vm.runInContext(fs.readFileSync(path.join(DIR, f), 'utf8'), sandbox, { filename: f });
  return sandbox;
}

export const fixture = (group, name) => JSON.parse(fs.readFileSync(path.join(FIX, group, name + '.json'), 'utf8'));
export const fixtureExists = (group, name) => fs.existsSync(path.join(FIX, group, name + '.json'));

// ── fixture ARRAY / STACK -> typed arrays / stack image ──
export function decodeArray(d) {
  if (Array.isArray(d)) return Float64Array.from(d, (v) => (v === null ? NaN : v));
  const b = Buffer.from(d.b64, 'base64');
  const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  return d.dtype === 'u8' ? new Uint8Array(ab) : d.dtype === 'u16' ? new Uint16Array(ab) : new Float32Array(ab);
}
const typed = (bd, a) => (bd === 8 ? Uint8Array.from(a) : bd === 16 ? Uint16Array.from(a) : Float32Array.from(a));

/** STACK of a fixture -> the stack image the engine imports (API.md §3). ImageJ plane order n = t*nC*nZ + z*nC + c. */
export function toStackImage(S, name) {
  const { dims, width, height } = S;
  const rgb = S.bitDepth === 24;
  const bd = rgb ? 8 : S.bitDepth;
  const nC = rgb ? 1 : dims.c;
  const NP = dims.z * dims.t;
  const cal = S.calibration || {};
  const calibration = { pixelWidth: cal.pixelWidth || 1, pixelHeight: cal.pixelHeight || 1, pixelDepth: cal.pixelDepth || 1, unit: cal.unit || 'pixel' };
  if (cal.frameInterval) { calibration.frameInterval = cal.frameInterval; calibration.timeUnit = cal.timeUnit; }
  const img = { name: name || S.title, width, height, bitDepth: bd, nZ: dims.z, nT: dims.t, hyperstack: !!S.hyperstack, calibration, channels: [] };
  if (S.labels) img.labels = S.labels.slice();
  if (rgb) {
    img.rgb = true;
    const lists = [[], [], []];
    for (let pi = 0; pi < NP; pi++) {
      const px = decodeArray(S.planes[pi]);
      for (let k = 0; k < 3; k++) { const o = new Uint8Array(width * height); for (let i = 0; i < o.length; i++) o[i] = px[i * 3 + k]; lists[k].push(o); }
    }
    img.channels = [['Red', '#ff0000'], ['Green', '#00ff00'], ['Blue', '#0000ff']].map(([n, c], k) => ({ name: n, color: c, planes: lists[k] }));
    return img;
  }
  const COLORS = ['#ffffff', '#ff0000', '#00ff00', '#0000ff', '#00ffff', '#ff00ff', '#ffff00'];
  for (let c = 0; c < nC; c++) {
    const list = [];
    for (let pi = 0; pi < NP; pi++) {
      const t = Math.floor(pi / dims.z), z = pi % dims.z;
      list.push(typed(bd, decodeArray(S.planes[t * nC * dims.z + z * nC + c])));
    }
    const r = S.displayRanges && S.displayRanges[c];
    const ch = { name: nC > 1 ? 'C' + (c + 1) : 'ch', color: nC > 1 ? COLORS[(c + 1) % COLORS.length] : '#ffffff', planes: list };
    if (r) ch.display = { min: r[0], max: r[1] };
    img.channels.push(ch);
  }
  return img;
}

/** The planes of the document `d` (engine inspectDoc) in the fixture's ImageJ order; an RGB plane is interleaved R,G,B. */
export function planesInIJOrder(d) {
  const nC = d.rgb ? 1 : d.channels.length;
  const out = [];
  for (let t = 0; t < d.nT; t++) for (let z = 0; z < d.nZ; z++) for (let c = 0; c < nC; c++) {
    const pi = t * d.nZ + z;
    if (d.rgb) {
      const a = new Uint8Array(d.width * d.height * 3);
      for (let k = 0; k < 3; k++) { const p = d.channels[k].planes[pi]; for (let i = 0; i < p.length; i++) a[i * 3 + k] = p[i]; }
      out.push(a);
    } else out.push(d.channels[c].planes[pi]);
  }
  return out;
}
/** The planes of a fixture STACK as typed arrays (RGB planes stay interleaved). */
export function fixturePlanes(S) { return S.planes.map(decodeArray); }

export function sameArrays(a, b, tol = 0) {
  if (a.length !== b.length) return false;
  const abs = typeof tol === 'number' ? tol : (tol.abs || 0), rel = typeof tol === 'number' ? 0 : (tol.rel || 0);
  for (let i = 0; i < a.length; i++) {
    const x = a[i], y = b[i];
    if (Number.isNaN(x) && Number.isNaN(y)) continue;
    if (!(Math.abs(x - y) <= abs + rel * Math.abs(y))) return false;
  }
  return true;
}
export function diffAt(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i] && !(Number.isNaN(a[i]) && Number.isNaN(b[i]))) return `first difference at ${i}: ${a[i]} vs ${b[i]} (lengths ${a.length}/${b.length})`;
  return 'equal';
}
/** Compares the planes of an engine document to a fixture STACK; returns '' when equal, else the first discrepancy. */
export function compareDoc(d, S, tol = 0) {
  if (d.width !== S.width || d.height !== S.height) return `size ${d.width}x${d.height} vs ${S.width}x${S.height}`;
  const bd = d.rgb ? 24 : d.bitDepth;
  if (bd !== S.bitDepth) return `bitDepth ${bd} vs ${S.bitDepth}`;
  const nC = d.rgb ? 1 : d.channels.length;
  if (nC !== S.dims.c || d.nZ !== S.dims.z || d.nT !== S.dims.t) return `dims c${nC} z${d.nZ} t${d.nT} vs ${JSON.stringify(S.dims)}`;
  const got = planesInIJOrder(d), exp = fixturePlanes(S);
  for (let i = 0; i < exp.length; i++) if (!sameArrays(got[i], exp[i], tol)) return `plane ${i + 1}: ${diffAt(got[i], exp[i])}`;
  return '';
}

// ── the engine client ──
export function client(world, opts = {}) {
  const { IJEngine } = world;
  const log = [];
  const waiters = new Map();
  let n = 0;
  const fake = { navigator: {}, onmessage: null, postMessage(m) { log.push(m); if (m.id !== undefined && 'ok' in m) { const w = waiters.get(m.id); if (w) { waiters.delete(m.id); w(m); } } } };
  const eng = IJEngine.start(fake, Object.assign({ storage: 'memory', idleMs: 3600000, bandPixels: 1 << 20, verifyInputs: true }, opts));
  const c = {
    log, eng,
    call(cmd, args) { return new Promise((res) => { const id = ++n; waiters.set(id, res); fake.onmessage({ data: { id, cmd, args } }); }); },
    async ok(cmd, args) { const m = await c.call(cmd, args); assert.ok(m.ok, `${cmd} failed: ${m.error && m.error.code} ${m.error && m.error.message}`); return m.result; },
    async err(cmd, args) { const m = await c.call(cmd, args); assert.ok(!m.ok, `${cmd} should have failed`); return m.error; },
    // imports a fixture STACK and moves to its current position (ImageJ's currentSlice)
    async open(S, name) {
      const r = await c.ok('doc.import', { image: toStackImage(S, name) });
      const p = S.position;
      if (p && (p.z > 1 || p.t > 1 || p.c > 1)) await c.ok('doc.setPosition', { docId: r.docId, z: p.z - 1, t: p.t - 1, c: S.bitDepth === 24 ? 0 : p.c - 1 });
      return r.docId;
    },
    doc(id) { return eng.inspectDoc(id); },
    dispose() { eng.dispose(); }
  };
  return c;
}
