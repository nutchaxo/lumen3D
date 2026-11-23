// Shared support of the WORKER tests of the macro extras phase (not a test: no `test_` prefix). Contract: DOCS/studio-advanced/macros/
// EXTRAS.md §3 (L3–L5), §8, §9, §10.
//
//   langSource()   ij-macro-lang.js (with L3 IJMacro.prepare / run(prepared, { entry }), L4 IJMacro.pixelProgram, L5 readVars);
//                  standIn() is true only for a language without them (the runs would then fail).
//   engineClient() an engine of the real worker files (core, engine, the language, ij-proc-macro.js, ij-macro-math.js) over a fake `self`,
//                  for the op tests (doc.import / doc.run / doc.preview / session.restore).
//   xrt(opts)      the scripted page + real worker runtime of ij_macro_files_rt_support.mjs (frt) with ij-macro-params.js and ij-macro-math.js.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import zlib from 'node:zlib';
import { ROOT } from './harness.mjs';

export const DIR = path.join(ROOT, 'js', 'modules', 'studio', 'advanced-studio');
export const FIX = path.join(ROOT, 'tests', 'fixtures', 'ij-macro');
const read = (f) => fs.readFileSync(path.join(DIR, f), 'utf8');

const LANG_SRC = read('ij-macro-lang.js');
export const standIn = () => !/function pixelProgram/.test(LANG_SRC) || !/function prepare/.test(LANG_SRC);
export function langSource() { return LANG_SRC; }

// ---------------------------------------------------------------- an engine of the real worker files (op tests)
export function engineContext(extra = []) {
  const sandbox = { console, setTimeout, clearTimeout, setInterval, clearInterval, MessageChannel, performance, TextEncoder, TextDecoder, AbortController, structuredClone };
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  for (const f of ['ij-core.js', 'ij-analysis.js', 'ij-proc-shared.js', 'ij-engine.js', ...extra]) vm.runInContext(read(f), sandbox, { filename: f });
  vm.runInContext(langSource(), sandbox, { filename: 'ij-macro-lang.js' });
  if (fs.existsSync(path.join(DIR, 'ij-macro-params.js'))) vm.runInContext(read('ij-macro-params.js'), sandbox, { filename: 'ij-macro-params.js' });
  vm.runInContext(read('ij-macro-math.js'), sandbox, { filename: 'ij-macro-math.js' });
  vm.runInContext(read('ij-proc-macro.js'), sandbox, { filename: 'ij-proc-macro.js' });
  return sandbox;
}
export function engineClient(sandbox, opts = {}) {
  const log = [];
  const waiters = new Map();
  let n = 0;
  const fake = {
    navigator: {}, onmessage: null,
    postMessage(m) { log.push(m); if (m.id !== undefined && 'ok' in m) { const w = waiters.get(m.id); if (w) { waiters.delete(m.id); w(m); } } }
  };
  const eng = sandbox.IJEngine.start(fake, Object.assign({ storage: 'memory', idleMs: 3600000, bandPixels: 1 << 20, verifyInputs: true }, opts));
  const c = {
    log, eng,
    call(cmd, args) { return new Promise((res) => { const id = ++n; waiters.set(id, res); fake.onmessage({ data: { id, cmd, args } }); }); },
    async ok(cmd, args) { const m = await c.call(cmd, args); assert.ok(m.ok, cmd + ' failed: ' + (m.error && m.error.code) + ' ' + (m.error && m.error.message)); return m.result; },
    async err(cmd, args) { const m = await c.call(cmd, args); assert.ok(!m.ok, cmd + ' should have failed'); return m.error; },
    async open(img, o = {}) { return (await c.ok('doc.import', Object.assign({ image: img }, o))).docId; },
    doc(id) { return eng.inspectDoc(id); },
    dispose() { eng.dispose(); }
  };
  return c;
}

// ---------------------------------------------------------------- the math goldens
export function mathGolden() {
  const p = path.join(FIX, 'math-golden.json');
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
}
/** A golden input file as the engine's image (API.md §3): planes in stack order, RGB = R, G, B planes per slice. */
export function goldenImage(c, name) {
  const im = c.image, W = im.width, H = im.height, n = im.slices || 1, bd = im.bitDepth;
  const buf = fs.readFileSync(path.join(FIX, 'math', name));
  const u8 = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  const N = W * H;
  const cal = { pixelWidth: 1, pixelHeight: 1, pixelDepth: 1, unit: 'pixel' };
  if (bd === 24) {
    const ch = [[], [], []];
    for (let z = 0; z < n; z++) for (let k = 0; k < 3; k++) ch[k].push(u8.slice((z * 3 + k) * N, (z * 3 + k + 1) * N));
    return { name: 'img', width: W, height: H, bitDepth: 8, rgb: true, nZ: n, nT: 1, calibration: cal,
      channels: ['Red', 'Green', 'Blue'].map((nm, k) => ({ name: nm, color: ['#ff0000', '#00ff00', '#0000ff'][k], planes: ch[k] })) };
  }
  const planes = [];
  const bpp = bd / 8;
  for (let z = 0; z < n; z++) {
    const s = u8.slice(z * N * bpp, (z + 1) * N * bpp);
    planes.push(bd === 8 ? s : bd === 16 ? new Uint16Array(s.buffer) : new Float32Array(s.buffer));
  }
  return { name: 'img', width: W, height: H, bitDepth: bd, nZ: n, nT: 1, calibration: cal, channels: [{ name: 'C1', color: '#ffffff', planes }] };
}
export function goldenRoi(r) {
  if (!r) return null;
  return { type: r.type === 'oval' ? 'oval' : 'rect', x: r.x, y: r.y, w: r.width, h: r.height };
}
/** "code=…[ stack|slice]" or a bare "v=…": the code and the stack word as ImageJ's Macro.getValue / getOptions read them. */
export function parseMathOptions(opts) {
  let s = opts;
  if (s.startsWith('v=')) s = 'code=' + s;
  let code, rest;
  if (s.startsWith('code=[')) { const e = s.indexOf(']', 6); code = s.substring(6, e); rest = s.substring(e + 1); }
  else { const m = /^code=(\S+)(.*)$/.exec(s); code = m[1]; rest = m[2]; }
  const words = rest.trim().split(/\s+/).filter(Boolean);
  return { code, stack: words.indexOf('stack') >= 0 };
}

// ---------------------------------------------------------------- the scripted page + worker runtime with the phase's files
export async function xrt(opts = {}) {
  const { frt } = await import('./ij_macro_files_rt_support.mjs');
  const sources = Object.assign({
    'ij-macro-lang.js': langSource() + (fs.existsSync(path.join(DIR, 'ij-macro-params.js')) ? '\n' + read('ij-macro-params.js') : '') + '\n' + read('ij-macro-math.js')
  }, opts.sources || {});
  return frt(Object.assign({}, opts, { rt: Object.assign({ sources }, opts.rt || {}) }));
}

/**
 * withExtras(t): macro.run arguments the scripted page of rt() does not send yet (entry, batch, readVars) and the write ops of the phase
 * it does not apply (batch.save, recorded in t.batchSaves instead). → t.runX(source, extra, o) / t.runFX(source, extra, o) (with the vfs).
 */
export function withExtras(t) {
  const spec = t.W.IJOpRegistry.getCommand('macro.run');
  const orig = spec.handler;
  let next = null;
  t.batchSaves = [];
  t.batchEvents = [];
  spec.handler = (a, E) => {
    const E2 = Object.create(E);
    // pictures need the browser's decoders: this realm reads PNG itself; TIFF and text go to the engine's own decoder when it has one
    E2.decodeImage = (bytes, o) => (o.kind !== 'picture' && typeof E.decodeImage === 'function' ? E.decodeImage(bytes, o) : decodeForTests(t.W, bytes, o));
    E2.postEvent = (ev) => {
      if (ev && ev.event === 'macro.batch') t.batchEvents.push(Object.assign({}, ev));
      if (ev && ev.event === 'macro.rpc' && Array.isArray(ev.writes)) {
        const keep = [];
        for (const w of ev.writes) { if (w[0] === 'batch.save') t.batchSaves.push(w[1]); else keep.push(w); }
        ev = Object.assign({}, ev, { writes: keep });
      }
      return E.postEvent(ev);
    };
    const extra = next;
    next = null;
    return orig(extra ? Object.assign({}, a, extra) : a, E2);
  };
  t.runX = (source, extra, o) => { next = extra || null; return t.run(source, o || {}); };
  t.runFX = (source, extra, o) => { next = extra || null; return t.runF(source, o || {}); };
  return t;
}

/** A folder of the fixtures as a fake disk tree for makeDisk (names in the order the file system lists them, sub-folders included). */
export function diskTree(rel) {
  const base = path.join(FIX, rel);
  const tree = {};
  const walk = (dir, pre) => {
    for (const name of fs.readdirSync(dir).sort()) {
      const full = path.join(dir, name);
      if (fs.statSync(full).isDirectory()) { tree[pre + name + '/'] = {}; walk(full, pre + name + '/'); }
      else tree[pre + name] = new Uint8Array(fs.readFileSync(full));
    }
  };
  if (fs.existsSync(base)) walk(base, '');
  return tree;
}

/* E.decodeImage of FILES.md §10.2 for this Node realm: TIFF (the core codec), text images, and PNG (8-bit grey, grey + alpha, RGB, RGBA or
 * palette, not interlaced: what ImageJ's PNG_Writer and the fixtures hold) — the browser's createImageBitmap is not available here. */
export async function decodeForTests(W, bytes, o) {
  const cal = { pixelWidth: 1, pixelHeight: 1, pixelDepth: 1, unit: 'pixel' };
  if (o.kind === 'tiff') {
    const image = await W.IJTiff.read(bytes, o.name);
    if (!o.plane) return image;
    const k = o.plane - 1, nC = image.rgb ? 1 : image.channels.length, nZ = image.nZ || 1;
    const c = image.rgb ? 0 : k % nC, z = Math.floor(k / nC) % nZ, tt = Math.floor(k / (nC * nZ));
    const chans = image.rgb ? image.channels : [image.channels[c]];
    return Object.assign({}, image, { nZ: 1, nT: 1, hyperstack: false, mode: undefined, channels: chans.map((ch) => Object.assign({}, ch, { planes: [ch.planes ? ch.planes[tt * nZ + z] : ch.data] })) });
  }
  if (o.kind === 'text') {
    const im = W.IJTextIo.parseTextImage(new TextDecoder().decode(bytes));
    return { name: o.name, width: im.width, height: im.height, bitDepth: 32, nZ: 1, nT: 1, rgb: false, hyperstack: false, calibration: cal,
      channels: [{ name: 'C1', color: '#ffffff', display: { min: 0, max: 255, lut: 'Grays', invert: false }, planes: [im.data] }] };
  }
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (o.kind === 'picture' && u8[0] === 137 && u8[1] === 80 && u8[2] === 78 && u8[3] === 71) {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    let at = 8, w = 0, h = 0, depth = 0, ctype = 0, inter = 0, pal = null;
    const idat = [];
    while (at < u8.length) {
      const len = dv.getUint32(at), type = String.fromCharCode(...u8.subarray(at + 4, at + 8));
      const body = u8.subarray(at + 8, at + 8 + len);
      if (type === 'IHDR') { w = dv.getUint32(at + 8); h = dv.getUint32(at + 12); depth = body[8]; ctype = body[9]; inter = body[12]; }
      else if (type === 'PLTE') pal = body.slice();
      else if (type === 'IDAT') idat.push(body);
      else if (type === 'IEND') break;
      at += 12 + len;
    }
    const bpp = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ctype];
    if (depth !== 8 || inter !== 0 || !bpp) { const e = new Error('png'); e.code = 'IJ_IO_DECODE'; throw e; }
    const raw = zlib.inflateSync(Buffer.concat(idat.map((x) => Buffer.from(x))));
    const stride = w * bpp, px = new Uint8Array(stride * h);
    for (let y = 0; y < h; y++) {
      const f = raw[y * (stride + 1)], src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? px[y * stride + i - bpp] : 0, b = y > 0 ? px[(y - 1) * stride + i] : 0, c = i >= bpp && y > 0 ? px[(y - 1) * stride + i - bpp] : 0;
        let p = src[i];
        if (f === 1) p += a; else if (f === 2) p += b; else if (f === 3) p += (a + b) >> 1;
        else if (f === 4) { const q = a + b - c, pa = Math.abs(q - a), pb = Math.abs(q - b), pc = Math.abs(q - c); p += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
        px[y * stride + i] = p & 255;
      }
    }
    const N = w * h;
    const gray = (ctype === 0 || ctype === 4) || (ctype === 3 && pal && Array.from({ length: pal.length / 3 }, (_, i) => pal[i * 3] === pal[i * 3 + 1] && pal[i * 3] === pal[i * 3 + 2]).every(Boolean));
    if (gray) {
      const g = new Uint8Array(N);
      for (let i = 0; i < N; i++) g[i] = ctype === 3 ? pal[px[i] * 3] : px[i * bpp];
      return { name: o.name, width: w, height: h, bitDepth: 8, nZ: 1, nT: 1, rgb: false, hyperstack: false, calibration: cal,
        channels: [{ name: 'C1', color: '#ffffff', display: { min: 0, max: 255, lut: 'Grays', invert: false }, planes: [g] }] };
    }
    const r = new Uint8Array(N), g = new Uint8Array(N), bl = new Uint8Array(N);
    for (let i = 0; i < N; i++) {
      if (ctype === 3) { r[i] = pal[px[i] * 3]; g[i] = pal[px[i] * 3 + 1]; bl[i] = pal[px[i] * 3 + 2]; } else { r[i] = px[i * bpp]; g[i] = px[i * bpp + 1]; bl[i] = px[i * bpp + 2]; }
    }
    return { name: o.name, width: w, height: h, bitDepth: 8, nZ: 1, nT: 1, rgb: true, hyperstack: false, calibration: cal,
      channels: [['Red', '#ff0000', r], ['Green', '#00ff00', g], ['Blue', '#0000ff', bl]].map(([nm, col, p]) => ({ name: nm, color: col, display: { min: 0, max: 255, lut: nm, invert: false }, planes: [p] })) };
  }
  const e = new Error('picture');
  e.code = 'IJ_IO_DECODE';
  throw e;
}
