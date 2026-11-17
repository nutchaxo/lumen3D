// Package P5 (geom) of the Advanced Studio against the golden fixtures recorded with the real ImageJ 1.54p
// (tests/fixtures/ij-wave2/geom/*.json: Rotate, Rotate + Enlarge, Scale in place, Scale (new window), Size, Canvas Size,
// Translate, Bin), through the REAL engine (ij-engine.js + ij-proc-geom.js) behind a request / answer client:
//   • every fixture is compared value for value (exactly, floats included: see compare());
//   • band determinism: the pixel operations (Rotate, Scale in place, Translate) answer byte-identically when the
//     engine cuts the image in 1-row bands, 7-row bands or one band (adaptive: false), with and without a selection;
//   • the engine's `verifyInputs` is on: an operation that wrote into an array it was given fails with IJ_INTERNAL.
//
// Run: node tests/js/test_ij_geom_fixtures.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT } from './harness.mjs';

const DIR = path.join(ROOT, 'js', 'modules', 'studio', 'advanced-studio');
const FIX = path.join(ROOT, 'tests', 'fixtures', 'ij-wave2', 'geom');

const sandbox = { console, setTimeout, clearTimeout, MessageChannel, performance, TextEncoder, TextDecoder, Blob, queueMicrotask, navigator: {} };
sandbox.self = sandbox;
vm.createContext(sandbox);
for (const f of ['ij-core.js', 'ij-analysis.js', 'ij-proc-shared.js', 'ij-engine.js', 'ij-proc-geom.js']) {
  vm.runInContext(fs.readFileSync(path.join(DIR, f), 'utf8'), sandbox, { filename: f });
}
const { IJEngine, IJTiff, IJRoi, IJGeom } = sandbox;
assert.ok(IJEngine && IJTiff && IJGeom, 'modules loaded');
assert.ok(sandbox.IJOpRegistry.get('rotate') && sandbox.IJOpRegistry.get('bin'), 'the geom ops are registered');

// ── client ───────────────────────────────────────────────────────────────────────────────────
const closers = [];
function startEngine(opts = {}) {
  const waiters = new Map();
  let n = 0;
  const fake = {
    navigator: {}, onmessage: null,
    postMessage(m) { if (m.id !== undefined && 'ok' in m) { const w = waiters.get(m.id); if (w) { waiters.delete(m.id); w(m); } } }
  };
  const eng = IJEngine.start(fake, Object.assign({ storage: 'memory', idleMs: 3600000, bandPixels: 1 << 20, adaptive: false, verifyInputs: true }, opts));
  closers.push(() => eng.dispose());
  const c = {
    call(cmd, args) { return new Promise((res) => { const id = ++n; waiters.set(id, res); fake.onmessage({ data: { id, cmd, args } }); }); },
    async ok(cmd, args) { const m = await c.call(cmd, args); assert.ok(m.ok, `${cmd} failed: ${m.error && m.error.code}`); return m.result; },
    async makeDoc(img, calibration) {
      const channels = [{
        name: 'C1', color: '#ffffff', data: img.data,
        display: { lut: 'Grays', invert: false, min: img.bitDepth === 8 ? 0 : Math.min(...img.data), max: img.bitDepth === 8 ? 255 : Math.max(...img.data) }
      }];
      const bytes = IJTiff.write({ width: img.width, height: img.height, bitDepth: img.bitDepth, name: 'img', channels, calibration: calibration || { pixelWidth: 1, pixelHeight: 1, unit: 'px' } });
      const r = await c.ok('doc.open', { bytes, name: 'img' });
      return { id: r.docId, info: r.info };
    },
    async pixels(id) { const t = await c.ok('doc.tile', { docId: id, channel: 0, level: 0, tx: 0, ty: 0 }); return t.data.slice(); }
  };
  return c;
}

// ── fixtures ─────────────────────────────────────────────────────────────────────────────────
function decodeData(d) {
  if (Array.isArray(d)) return Float64Array.from(d, (v) => (v === null ? NaN : v));
  const b = Buffer.from(d.b64, 'base64');
  const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  return d.dtype === 'u8' ? new Uint8Array(ab) : d.dtype === 'u16' ? new Uint16Array(ab) : new Float32Array(ab);
}
function imageOf(img) {
  const T = img.bitDepth === 8 ? Uint8Array : img.bitDepth === 16 ? Uint16Array : Float32Array;
  return { width: img.width, height: img.height, bitDepth: img.bitDepth, data: T.from(decodeData(img.data)) };
}
const files = fs.readdirSync(FIX).filter((f) => f.endsWith('.json')).sort();
assert.ok(files.length >= 276, 'the geom fixtures are there: ' + files.length);

// The selection of a fixture: a rectangle as such, an oval as the exact mask ImageJ rasterised.
function roiOf(fx, W, H) {
  const r = fx.roi;
  if (!r) return null;
  if (r.type === 'rect') return { type: 'rect', x: r.x, y: r.y, w: r.w, h: r.h };
  const m = r.mask, d = decodeData(m.data);
  const full = new Uint8Array(W * H);
  for (let y = 0; y < m.h; y++) for (let x = 0; x < m.w; x++) if (d[y * m.w + x]) full[(m.y + y) * W + m.x + x] = 1;
  return IJRoi.fromMask(full, W, H);
}
const boundsOf = (roi, W, H) => {
  if (!roi) return null;
  const b = IJRoi.bounds(roi);
  const x0 = Math.max(0, b.x), y0 = Math.max(0, b.y), x1 = Math.min(W, b.x + b.w), y1 = Math.min(H, b.y + b.h);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
};
const POS = { 'Top-Left': 'topLeft', 'Top-Center': 'topCenter', 'Top-Right': 'topRight', 'Center-Left': 'centerLeft', 'Center': 'center', 'Center-Right': 'centerRight', 'Bottom-Left': 'bottomLeft', 'Bottom-Center': 'bottomCenter', 'Bottom-Right': 'bottomRight' };

// How a fixture maps onto an engine request: { op, params, roi, kind }
function requestOf(fx) {
  const W = fx.input.width, H = fx.input.height;
  const roi = roiOf(fx, W, H);
  const rect = boundsOf(roi, W, H);
  const p = fx.params;
  switch (fx.op) {
    case 'rotate': return { op: 'rotate', kind: 'pixel', roi, params: { angle: p.angle, interpolation: p.interpolation, rect } };
    case 'rotateEnlarge': return { op: 'rotateEnlarge', kind: 'size', roi: null, params: { angle: p.angle, interpolation: p.interpolation } };
    case 'scaleInPlace': return { op: 'scaleInPlace', kind: 'pixel', roi, params: { xscale: p.xscale, yscale: p.yscale, interpolation: p.interpolation, rect } };
    case 'scaleNew': return { op: 'scaleNew', kind: 'newdoc', roi, params: { xscale: p.xscale, yscale: p.yscale, interpolation: p.interpolation, averageWhenDownsizing: p.averageWhenDownsizing, width: p.width, height: p.height } };
    case 'resize': return { op: 'resize', kind: 'size', roi, params: { width: p.width, height: p.height, interpolation: p.interpolation, averageWhenDownsizing: p.averageWhenDownsizing } };
    case 'canvasSize': return { op: 'canvasSize', kind: 'size', roi: null, params: { width: p.width, height: p.height, position: POS[p.position] } };
    case 'translate': return { op: 'translate', kind: 'pixel', roi, params: { dx: p.dx, dy: p.dy, interpolation: p.interpolation } };
    case 'bin': return { op: 'bin', kind: 'size', roi: null, params: { xshrink: p.xshrink, yshrink: p.yshrink, method: p.method } };
    default: throw new Error('unknown fixture op ' + fx.op);
  }
}

/* Every output, integer or float, is compared exactly. Java evaluates sin / cos with the JDK's intrinsics and JavaScript with
 * fdlibm: on the recorded angles (15, -30, 90.5 degrees) the two agree to the last bit and so does every float image — a
 * different angle could differ by one ulp of the double, which moves a bilinear value by far less than one float32 ulp. The
 * tests therefore keep to the recorded angles; if a platform's Math.sin / cos ever disagreed, this is the place to look. */
function compare(a, b) {
  assert.equal(a.length, b.length, 'same length');
  let n = 0, first = -1;
  for (let i = 0; i < a.length; i++) {
    const x = a[i], y = b[i];
    if (x === y || (x !== x && y !== y)) continue;
    n++;
    if (first < 0) first = i;
  }
  return { n, first };
}

async function runFixture(c, fx, req) {
  const input = imageOf(fx.input);
  const doc = await c.makeDoc(input);
  const res = await c.ok('doc.run', { docId: doc.id, op: req.op, params: req.params, roi: req.roi, channel: 'all' });
  if (req.kind === 'newdoc') {
    assert.equal(res.newDocIds.length, 1, 'one new document');
    const info = res.newInfos[0];
    return { width: info.width, height: info.height, data: await c.pixels(res.newDocIds[0]), info, doc: res.newDocIds[0] };
  }
  return { width: res.info.width, height: res.info.height, data: await c.pixels(doc.id), info: res.info, doc: doc.id };
}

// ── 1. every fixture, value for value ────────────────────────────────────────────────────────
const failures = [];
let pass = 0;
const perOp = {};
{
  const c = startEngine();
  for (const f of files) {
    const fx = JSON.parse(fs.readFileSync(path.join(FIX, f), 'utf8'));
    const req = requestOf(fx);
    const exp = imageOf(fx.output);
    const row = perOp[fx.op] || (perOp[fx.op] = { pass: 0, total: 0 });
    row.total++;
    let got;
    try { got = await runFixture(c, fx, req); } catch (e) { failures.push(`${fx.case}: threw ${e.message}`); continue; }
    if (got.width !== exp.width || got.height !== exp.height) { failures.push(`${fx.case}: size ${got.width}x${got.height}, expected ${exp.width}x${exp.height}`); continue; }
    const d = compare(got.data, exp.data);
    if (d.n) failures.push(`${fx.case}: ${d.n} values differ (first at ${d.first}: got ${got.data[d.first]} expected ${exp.data[d.first]})`);
    else { pass++; row.pass++; }
  }
}
for (const [op, r] of Object.entries(perOp)) console.log(`  ${op.padEnd(14)} ${r.pass}/${r.total}`);
console.log(`fixtures: ${pass}/${files.length} match`);
if (failures.length) { console.error(failures.join('\n')); }
assert.equal(failures.length, 0, `${failures.length} fixture(s) differ from ImageJ 1.54p`);

// ── 2. the Canvas Size anchors compute the offsets ImageJ recorded ───────────────────────────
{
  let n = 0;
  for (const f of files.filter((x) => x.startsWith('canvas_'))) {
    const fx = JSON.parse(fs.readFileSync(path.join(FIX, f), 'utf8'));
    const o = IJGeom.canvasOffsets(fx.input.width, fx.input.height, fx.params.width, fx.params.height, POS[fx.params.position]);
    assert.deepEqual([o.x, o.y], [fx.params.xOffset, fx.params.yOffset], fx.case);
    n++;
  }
  assert.ok(n >= 37);
}

// ── 3. band determinism: 1-row bands, 7-row bands, one band; with and without a selection ────
{
  const whole = startEngine({ bandPixels: 1 << 24 });
  const dets = ['rotate', 'scaleInPlace', 'translate'];
  const cases = files.filter((f) => /^(rotate_(15|m30|90p5)_(bilinear|bicubic|none)_u(8|16)|rotate_roi_|scale_in_|translate_)/.test(f));
  assert.ok(cases.length > 30, 'band cases: ' + cases.length);
  let compared = 0;
  for (const f of cases) {
    const fx = JSON.parse(fs.readFileSync(path.join(FIX, f), 'utf8'));
    if (!dets.includes(fx.op)) continue;
    const req = requestOf(fx);
    const ref = await runFixture(whole, fx, req);
    for (const rows of [1, 7]) {
      // The band size is an engine option: a client of its own per image width.
      const part = await runFixture(startEngine({ bandPixels: fx.input.width * rows }), fx, req);
      const same = Buffer.compare(Buffer.from(part.data.buffer, part.data.byteOffset, part.data.byteLength), Buffer.from(ref.data.buffer, ref.data.byteOffset, ref.data.byteLength)) === 0;
      assert.ok(same, `${fx.case}: ${rows}-row bands differ from one band`);
      compared++;
    }
  }
  console.log(`band determinism: ${compared} comparisons byte-identical`);
}

// Review-round regressions: the 16-bit scale fill rounds the display minimum (ShortProcessor.setMinAndMax: (int)Math.round);
// Bin declares the copy of its input for every depth (an inverted display copies at 32 bits too).
assert.equal(IJGeom.scaleFill(16, 12.7), 13);
assert.equal(IJGeom.scaleFill(16, 12.4), 12);
assert.equal(IJGeom.scaleFill(16, -1.2), 0xFFFF);
for (const bd of [8, 16, 32]) {
  const need = sandbox.IJOpRegistry.get('bin').scratchBytes({ channels: 1, width: 64, height: 64, bitDepth: bd }, { xshrink: 2, yshrink: 2 });
  assert.equal(need, (32 * 32 + 64 * 64) * bd / 8, 'bin scratchBytes at ' + bd);
}

for (const x of closers) x();
console.log('test_ij_geom_fixtures: ok');
