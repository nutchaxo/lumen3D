// Shared helpers of the stack package tests (not a test: no `test_` prefix).
//   • a vm context with the REAL pure modules and the stack / multi / edit packages (the op registry the engine reads);
//   • fixtures of tests/fixtures/ij-stacks (decode a STACK, an options string);
//   • a signature of a stack (fixture STACK or op result) so two stacks compare slice by slice in ImageJ's stack order.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT } from './harness.mjs';

export const DIR = path.join(ROOT, 'js', 'modules', 'studio', 'advanced-studio');
export const FX = path.join(ROOT, 'tests', 'fixtures', 'ij-stacks');

export function loadContext(files = ['ij-core.js', 'ij-analysis.js', 'ij-proc-shared.js', 'ij-proc-multi.js', 'ij-proc-geom.js', 'ij-proc-stk.js']) {
  const ctx = vm.createContext({ console, setTimeout, clearTimeout, MessageChannel, performance, TextEncoder, TextDecoder });
  ctx.self = ctx;
  for (const f of files) vm.runInContext(fs.readFileSync(path.join(DIR, f), 'utf8'), ctx, { filename: f });
  return ctx;
}

export const hasFixtures = () => fs.existsSync(FX);
export const fixtureFiles = (group) => fs.readdirSync(path.join(FX, group)).filter((f) => f.endsWith('.json')).sort().map((f) => path.join(FX, group, f));
export const readFx = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

/** ARRAY of the fixture README -> typed array of the bit depth (NaN for null). */
export function decodeArr(d, bd) {
  const C = bd === 8 ? Uint8Array : bd === 16 ? Uint16Array : Float32Array;
  if (Array.isArray(d)) return C.from(Float64Array.from(d, (v) => (v === null ? NaN : v)));
  const b = Buffer.from(d.b64, 'base64');
  const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  return d.dtype === 'u8' ? new Uint8Array(ab) : d.dtype === 'u16' ? new Uint16Array(ab) : new Float32Array(ab);
}
/** Interleaved RGB bytes -> [R, G, B] arrays. */
export function splitRgb(d) {
  const b = Buffer.from(d.b64, 'base64');
  const n = d.length / 3, r = new Uint8Array(n), g = new Uint8Array(n), bl = new Uint8Array(n);
  for (let i = 0; i < n; i++) { r[i] = b[3 * i]; g[i] = b[3 * i + 1]; bl[i] = b[3 * i + 2]; }
  return [r, g, bl];
}

const LUT_GRAYS = 'grays';
function lutName(l) {
  if (l === LUT_GRAYS) return { lut: 'Grays', invert: false };
  if (l === 'inverting') return { lut: 'Grays', invert: true };
  // a table: 768 bytes R[256] G[256] B[256] -> r, g, b per level
  const raw = Buffer.from(l.rgb, 'base64');
  const t = new Uint8Array(768);
  for (let i = 0; i < 256; i++) { t[i * 3] = raw[i]; t[i * 3 + 1] = raw[256 + i]; t[i * 3 + 2] = raw[512 + i]; }
  return { lut: t, invert: false };
}

/** The view an operation receives (engine makeView) for a fixture STACK. */
export function viewOfStack(S, id = 'd1', o = {}) {
  const rgb = S.bitDepth === 24;
  const bd = rgb ? 8 : S.bitDepth;
  const nC = rgb ? 1 : S.dims.c, nZ = S.dims.z, nT = S.dims.t;
  const NP = nZ * nT;
  const cur = S.position || { c: 1, z: 1, t: 1 };
  const z = cur.z - 1, t = cur.t - 1, pi = t * nZ + z;
  const mk = (planes, name, color, rngIdx) => {
    const rg = S.displayRanges && S.displayRanges[rngIdx] ? S.displayRanges[rngIdx] : [0, 255];
    const l = S.luts && S.luts[rngIdx] ? lutName(S.luts[rngIdx]) : { lut: 'Grays', invert: false };
    return Object.freeze({ data: planes[pi], planes: Object.freeze(planes), name, color, display: Object.freeze({ min: rg[0], max: rg[1], lut: l.lut, invert: l.invert }) });
  };
  let channels;
  if (rgb) {
    const split = S.planes.map((p) => splitRgb(p));
    channels = ['Red', 'Green', 'Blue'].map((nm, k) => mk(split.map((s) => s[k]), nm, ['#ff0000', '#00ff00', '#0000ff'][k], 0));
  } else {
    channels = [];
    for (let c = 0; c < nC; c++) {
      const planes = new Array(NP);
      for (let tt = 0; tt < nT; tt++) for (let zz = 0; zz < nZ; zz++) planes[tt * nZ + zz] = decodeArr(S.planes[tt * nC * nZ + zz * nC + c], bd);
      channels.push(mk(planes, 'C' + (c + 1), ['#ff0000', '#00ff00', '#0000ff', '#ffffff', '#00ffff', '#ff00ff', '#ffff00'][c] || '#ffffff', c));
    }
  }
  const mode = S.composite ? (S.mode === 'grayscale' ? 'gray' : S.mode) : (nC > 1 ? 'composite' : 'gray');
  return Object.freeze({
    id, name: S.title, width: S.width, height: S.height, bitDepth: bd,
    calibration: Object.freeze(calOf(S.calibration)), provenance: null,
    channels: Object.freeze(channels), active: Math.min(nC - 1, (cur.c || 1) - 1), mode,
    nC, nZ, nT, z, t, hyperstack: !!S.hyperstack, rgb, labels: S.labels ? Object.freeze(S.labels.slice()) : null
  });
}
function calOf(c) {
  return { pixelWidth: c.pixelWidth, pixelHeight: c.pixelHeight, pixelDepth: c.pixelDepth, unit: c.unit, frameInterval: c.frameInterval, timeUnit: c.timeUnit, xOrigin: c.xOrigin, yOrigin: c.yOrigin, zOrigin: c.zOrigin, fps: c.fps, loop: c.loop };
}

/** The io an op receives; `views` = every document the request named (the first is the primary). */
export function makeIo(views, o = {}) {
  const ticks = [];
  return {
    docIds: views.map((v) => v.id), channel: o.channel === undefined ? null : o.channel, region: null,
    pos: o.pos || { z: views[0].z, t: views[0].t },
    tick: async (f, k) => { ticks.push(f); }, check() {}, reserve() {}, release() {}, ticks,
    dep: (n) => null,
    readDoc: (id) => { const v = views.find((x) => x.id === id); if (!v) throw Object.assign(new Error('doc'), { code: 'IJ_BAD_ARGS' }); return v; },
    planes: (c) => views[0].channels[c].planes.slice()
  };
}

const unitOf = (u) => (u === undefined || u === null || u === 'pixel' || u === 'px' || u === 'pixels' || u === '' ? 'pixel' : (u === 'micron' || u === 'um' || u === 'µm' || u === 'microns' ? 'um' : u));

/** A comparable signature of a fixture STACK. */
export function sigOfStack(S) {
  const rgb = S.bitDepth === 24, bd = rgb ? 8 : S.bitDepth;
  const slices = S.planes.map((p) => (rgb ? splitRgb(p).map((a) => Array.from(a)) : [Array.from(decodeArr(p, bd))]));
  return {
    w: S.width, h: S.height, bd: S.bitDepth, nC: rgb ? 1 : S.dims.c, nZ: S.dims.z, nT: S.dims.t, hyper: !!S.hyperstack, slices,
    labels: S.labels && S.labels.some((l) => l !== null) ? S.labels.slice() : null,
    cal: { pw: S.calibration.pixelWidth, ph: S.calibration.pixelHeight, pd: S.calibration.pixelDepth, unit: unitOf(S.calibration.unit), fi: S.calibration.frameInterval || 0 },
    mode: S.composite ? S.mode : null
  };
}
/** A comparable signature of a stack image (API.md §3) an operation returned. */
export function sigOfImage(img, calFallback) {
  const rgb = !!img.rgb;
  const lists = img.channels.map((c) => (Array.isArray(c.planes) ? c.planes : [c.data]));
  const NP = lists[0].length;
  const nZ = img.nZ === undefined ? NP : img.nZ, nT = img.nT === undefined ? (img.nZ === undefined ? 1 : NP / nZ) : img.nT;
  const nC = rgb ? 1 : lists.length;
  const slices = [];
  for (let t = 0; t < nT; t++) for (let z = 0; z < nZ; z++) for (let c = 0; c < nC; c++) {
    const pi = t * nZ + z;
    slices.push(rgb ? lists.map((l) => Array.from(l[pi])) : [Array.from(lists[c][pi])]);
  }
  const cal = img.calibration || calFallback || {};
  return {
    w: img.width, h: img.height, bd: rgb ? 24 : img.bitDepth, nC, nZ, nT, hyper: !!img.hyperstack, slices,
    labels: Array.isArray(img.labels) && img.labels.some((l) => l !== null && l !== undefined) ? img.labels.slice() : null,
    cal: { pw: cal.pixelWidth, ph: cal.pixelHeight, pd: cal.pixelDepth, unit: unitOf(cal.unit), fi: cal.frameInterval || 0 },
    mode: img.mode || null, name: img.name
  };
}

const same = (a, b, tol) => (Object.is(a, b) || a === b || (a !== a && b !== b) || (tol && Math.abs(a - b) <= tol));
/** The differences of two signatures (an empty list = equal). opts: { tol, noLabels, noCal, noHyper, noMode, flat (only the slice count, not the c/z/t split) }. */
export function diffSig(got, want, opts = {}) {
  const out = [];
  const eq = (what, a, b) => { if (JSON.stringify(a) !== JSON.stringify(b)) out.push(`${what}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`); };
  eq('size', [got.w, got.h], [want.w, want.h]);
  eq('bitDepth', got.bd, want.bd);
  if (opts.flat) eq('slice count', got.nC * got.nZ * got.nT, want.nC * want.nZ * want.nT);
  else eq('c/z/t', [got.nC, got.nZ, got.nT], [want.nC, want.nZ, want.nT]);
  if (!opts.noHyper && !opts.flat) eq('hyperstack', got.hyper, want.hyper);
  if (!opts.noLabels) eq('labels', got.labels, want.labels);
  if (!opts.noCal) {
    const g = got.cal, w = want.cal;
    eq('calibration', [g.pw, g.ph, g.pd, g.unit, opts.noFi ? 0 : g.fi], [w.pw, w.ph, w.pd, w.unit, opts.noFi ? 0 : w.fi]);
  }
  if (!opts.noMode && want.mode && got.mode !== want.mode && !(want.mode === 'grayscale' && got.mode === 'gray')) out.push(`mode: got ${got.mode}, want ${want.mode}`);
  if (out.length) return out;
  const tol = opts.tol || 0;
  for (let n = 0; n < want.slices.length; n++) {
    for (let k = 0; k < want.slices[n].length; k++) {
      const a = got.slices[n][k], b = want.slices[n][k];
      if (a.length !== b.length) { out.push(`slice ${n + 1}: ${a.length} values, want ${b.length}`); continue; }
      for (let i = 0; i < a.length; i++) if (!same(a[i], b[i], tol)) { out.push(`slice ${n + 1}${want.slices[n].length > 1 ? ' ch' + k : ''} px ${i}: got ${a[i]}, want ${b[i]}`); break; }
    }
    if (out.length > 4) break;
  }
  return out;
}

/** ImageJ's macro options string -> { key: value | true }.  key=value, key=[value with spaces], bare key. */
export function parseOpts(s) {
  const out = {};
  const rx = /([A-Za-z0-9_.\-]+)(?:=(\[[^\]]*\]|\S*))?/g;
  let m;
  while ((m = rx.exec(s || '')) !== null) {
    let v = m[2];
    if (v === undefined) v = true;
    else if (v.charAt(0) === '[' && v.charAt(v.length - 1) === ']') v = v.substring(1, v.length - 1);
    out[m[1]] = v;
  }
  return out;
}

export function makeTester(name) {
  let passed = 0, failed = 0;
  const failures = [];
  return {
    async test(label, fn) {
      try { await fn(); passed++; }
      catch (e) { failed++; failures.push({ label, e }); console.error('FAIL ' + name + ': ' + label + '\n   ' + String(e && e.message ? e.message : e).split('\n').slice(0, 6).join('\n   ')); }
    },
    done() {
      console.log(`${name}: ${passed} passed, ${failed} failed`);
      if (failed) process.exit(1);
    },
    get passed() { return passed; }, get failed() { return failed; }
  };
}
export { assert };
