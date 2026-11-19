// Package sel (wave 3) against the golden fixtures recorded with the real ImageJ 1.54p (tests/fixtures/ij-wave3/sel,
// tools/ij_fixtures/W3Sel.java): Fit Spline, Fit Circle, Fit Rectangle, Interpolate, Scale, Rotate, Translate, Make Band,
// Line to Area, Area to Line, Straighten (pixels of 8-bit and 16-bit sources).
//
// Tolerances (each stated where used):
//   vertices of a polygon / polyline    bit-identical Java floats (Math.fround); vertices that read or write an oval are compared at 1e-5 (the flattened Java
//                                       path: measured max |Δ| 7.6e-6 over every oval case, one float ULP at 64)
//   masks (the pixel set of a selection) identical pixel sets
//   Straighten pixels (Java float)      bit-identical
//
// Run: node tests/js/test_ij_sel_fixtures.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT } from './harness.mjs';

const DIR = path.join(ROOT, 'js', 'modules', 'studio', 'advanced-studio');
const FX = path.join(ROOT, 'tests', 'fixtures', 'ij-wave3', 'sel');
const sb = { console, setTimeout, clearTimeout };
sb.self = sb;
vm.createContext(sb);
for (const f of ['ij-core.js', 'ij-analysis.js', 'ij-proc-shared.js', 'ij-proc-roi.js', 'ij-proc-sel.js']) vm.runInContext(fs.readFileSync(path.join(DIR, f), 'utf8'), sb, { filename: f });
const S = sb.IJSelOps, IJRoi = sb.IJRoi;
const fr = Math.fround;
const W = 64, H = 48; // the 64×48 image of the driver

const load = (n) => JSON.parse(fs.readFileSync(path.join(FX, n + '.json'), 'utf8'));
function bytes(d) { const b = Buffer.from(d.b64, 'base64'); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); }
function typed(d) {
  if (Array.isArray(d)) return Float64Array.from(d);
  const ab = bytes(d);
  return d.dtype === 'u8' ? new Uint8Array(ab) : d.dtype === 'u16' ? new Uint16Array(ab) : new Float32Array(ab);
}
const pairs = (flat) => { const o = []; for (let i = 0; i < flat.length; i += 2) o.push([flat[i], flat[i + 1]]); return o; };

// ImageJ's roiFull() → this Studio's selection
function toRoi(r, lineHint) {
  const fb = r.floatBounds;
  let o;
  switch (r.typeName) {
    case 'Rectangle': o = { type: 'rect', x: fb[0], y: fb[1], w: fb[2], h: fb[3] }; break;
    case 'Oval': o = { type: 'oval', x: fb[0], y: fb[1], w: fb[2], h: fb[3] }; break;
    case 'Polygon': o = { type: 'polygon', points: pairs(r.floatPolygon) }; break;
    case 'Freehand': o = { type: 'freehand', points: pairs(r.floatPolygon) }; break;
    case 'Traced': o = { type: 'polygon', points: pairs(r.floatPolygon), traced: true }; break;
    case 'Polyline': o = { type: 'polyline', points: pairs(r.floatPolygon) }; break;
    case 'Freeline': o = { type: 'polyline', points: pairs(r.floatPolygon), freeline: true }; break;
    case 'Point': o = { type: 'point', points: pairs(r.floatPolygon) }; break;
    case 'Straight Line': { const p = lineHint || r.floatPolygon; o = { type: 'line', x1: p[0], y1: p[1], x2: p[p.length === 4 && !lineHint ? 2 : 2], y2: p[3] }; if (r.strokeWidth > 1) o.width = r.strokeWidth; break; }
    case 'Composite': {
      const m = r.mask, d = new Uint8Array(bytes(m.data));
      o = IJRoi.translate(IJRoi.fromMask(d, m.w, m.h), m.x, m.y);
      break;
    }
    default: throw new Error('type ' + r.typeName);
  }
  if (r.strokeWidth > 0 && (o.type === 'line' || o.type === 'polyline')) o.width = r.strokeWidth;
  return o;
}
const LINE_HINT = [6, 40, 58, 8]; // new Line(6, 40, 58, 8) of the driver: a wide line's floatPolygon is its outline

function maskSet(roi) {
  const m = IJRoi.mask(roi);
  const s = new Set();
  for (let j = 0; j < m.h; j++) for (let i = 0; i < m.w; i++) if (m.data[j * m.w + i]) s.add((m.y + j) + ',' + (m.x + i));
  return s;
}
function fixtureMaskSet(r) {
  const m = r.mask, d = new Uint8Array(bytes(m.data));
  const s = new Set();
  for (let j = 0; j < m.h; j++) for (let i = 0; i < m.w; i++) if (d[j * m.w + i]) s.add((m.y + j) + ',' + (m.x + i));
  return s;
}
function sameSet(a, b) { if (a.size !== b.size) return false; for (const v of a) if (!b.has(v)) return false; return true; }

const stats = {};
const problems = [];
function note(kind, name, ok, why) {
  const s = stats[kind] = stats[kind] || { ok: 0, n: 0 };
  s.n++;
  if (ok) s.ok++; else problems.push(`${kind} ${name}: ${why}`);
}

// type of a result as ImageJ names it
function typeNameOf(roi) {
  switch (roi.type) {
    case 'rect': return 'Rectangle';
    case 'oval': return 'Oval';
    case 'polygon': return roi.rotRectWidth !== undefined ? 'Rotated Rectangle' : roi.traced ? 'Traced' : 'Polygon';
    case 'freehand': return 'Freehand';
    case 'polyline': return roi.freeline ? 'Freeline' : 'Polyline';
    case 'line': return 'Straight Line';
    case 'mask': return 'Composite';
    case 'point': return 'Point';
    default: return roi.type;
  }
}

/* compares a result to ImageJ's `output`: its type, its vertices and its pixel set. `looseVerts` = an absolute tolerance on the
 * vertices (0 = bit-identical floats). Returns '' when equal, else why. */
function compare(roi, out, looseVerts = 0, opts = {}) {
  // OvalRoi.getFloatPolygon is a flattened Java path: the wave-2 port agrees to 2e-5 (test_ij_roi_fixtures.mjs); a transform of it
  // measured 7.6e-6 here, so every case that reads or writes an oval vertex list is compared at 1e-5 (measured max |Δ| = 7.63e-6, one float ULP at 64)
  if (opts.oval) looseVerts = Math.max(looseVerts, 1e-5);
  const want = out.typeName;
  const have = typeNameOf(roi);
  // ThresholdToSelection gives a traced polygon for one outline and a composite otherwise; this port does the same
  if (have !== want && !(opts.anyTrace && ['Traced', 'Composite'].includes(have) && ['Traced', 'Composite'].includes(want))) return `type ${have} ≠ ${want}`;
  if (out.floatPolygon && roi.type !== 'mask' && !opts.skipVerts) {
    const exp = out.floatPolygon.map(fr);
    let got;
    if (roi.type === 'line') got = [roi.x1, roi.y1, roi.x2, roi.y2];
    else if (roi.type === 'rect') got = [roi.x, roi.y, roi.x + roi.w, roi.y, roi.x + roi.w, roi.y + roi.h, roi.x, roi.y + roi.h];
    else if (roi.type === 'oval') { const v = sb.IJRoiTools.roiVertices(roi); got = v.xs.flatMap((x, i) => [x, v.ys[i]]); }
    else got = roi.points.flat();
    if (opts.anyTrace && have === 'Traced' && want === 'Traced') {
      // the traced outline of the same pixel set: ThresholdToSelection and this port may start it at another corner
      const key = (a) => { const o = []; for (let i = 0; i < a.length; i += 2) o.push(a[i] + ',' + a[i + 1]); return o.sort().join(';'); };
      if (key(got) !== key(exp)) return `traced vertices differ (${got.length / 2} vs ${exp.length / 2})`;
    } else {
    if (got.length !== exp.length) return `vertex count ${got.length / 2} ≠ ${exp.length / 2}`;
    for (let i = 0; i < exp.length; i++) if (Math.abs(got[i] - exp[i]) > looseVerts) return `vertex ${i >> 1}${i & 1 ? 'y' : 'x'}: ${got[i]} ≠ ${exp[i]}`;
    }
  }
  if (out.mask && !opts.skipMask) {
    const a = maskSet(roi), b = fixtureMaskSet(out);
    if (!sameSet(a, b)) { let miss = 0, extra = 0; for (const v of b) if (!a.has(v)) miss++; for (const v of a) if (!b.has(v)) extra++; return `mask differs: ${miss} missing, ${extra} extra of ${b.size}`; }
  }
  return '';
}

const cmp = (c, roi, extra) => compare(roi, c.output, 0, Object.assign({ oval: c.input.typeName === 'Oval' || c.output.typeName === 'Oval' }, extra));

// ───────────────────────── Fit Spline ─────────────────────────
for (const c of load('fit_spline').cases) {
  const out = S.fitSpline(toRoi(c.input)).roi;
  const why = cmp(c, out);
  note('fitSpline', c.name, !why, why);
}
// ───────────────────────── Fit Circle ─────────────────────────
for (const c of load('fit_circle').cases) {
  let why;
  try { why = cmp(c, S.fitCircle(toRoi(c.input), W, H).roi); } catch (e) { why = 'threw ' + e.message; }
  note('fitCircle', c.name, !why, why);
}
// ───────────────────────── Fit Rectangle ─────────────────────────
for (const c of load('fit_rectangle').cases) {
  let why;
  try { why = cmp(c, S.fitRectangle(toRoi(c.input)).roi); } catch (e) { why = 'threw ' + e.message; }
  note('fitRectangle', c.name, !why, why);
}
// ───────────────────────── Interpolate ─────────────────────────
for (const c of load('interpolate').cases) {
  const o = c.options;
  const interval = Number(/interval=([0-9.]+)/.exec(o)[1]), smooth = /smooth/.test(o), adjust = /adjust/.test(o);
  let why;
  try { why = cmp(c, S.interpolate(toRoi(c.input, c.name === 'line' ? LINE_HINT : undefined), interval, smooth, adjust).roi); } catch (e) { why = 'threw ' + e.message; }
  note('interpolate', c.name + ' ' + o, !why, why);
}
// ───────────────────────── EllipseRoi (Fit Ellipse): a FREEROI polygon ─────────────────────────
{
  const ELL = { x1: 10, y1: 20, x2: 50, y2: 30, aspect: 0.5 };
  const toEllipse = (c) => ({ type: 'polygon', points: pairs(c.input.floatPolygon), ellipse: Object.assign({}, ELL) });
  for (const c of load('ellipse').cases) {
    let why, name = c.name;
    try {
      if (c.name === 'interpolate') {
        const o = c.options;
        name += ' ' + o;
        why = cmp(c, S.interpolate(toEllipse(c), Number(/interval=([0-9.]+)/.exec(o)[1]), /smooth/.test(o), /adjust/.test(o)).roi);
      } else if (c.name === 'areaToLine') why = cmp(c, S.areaToLine(toEllipse(c), W, H).roi);
      else if (c.name === 'rotate') { name += ' ' + c.params.angle; why = cmp(c, S.rotate(toEllipse(c), c.params.angle, false, W, H).roi); }
      else why = cmp(c, S.scale(toEllipse(c), c.params.xscale, c.params.yscale, c.params.centered).roi);
    } catch (e) { why = 'threw ' + e.message; }
    note('ellipse', name, !why, why);
  }
}
// ───────────────────────── Interpolate on a ShapeRoi of one part ─────────────────────────
for (const c of load('interpolate_onepart').cases) {
  const o = c.options;
  let why;
  try { why = cmp(c, S.interpolate(toRoi(c.input), Number(/interval=([0-9.]+)/.exec(o)[1]), /smooth/.test(o), /adjust/.test(o)).roi); } catch (e) { why = 'threw ' + e.message; }
  note('interpolateOnePart', o, !why, why);
}
// ───────────────────────── Scale / Rotate / Translate ─────────────────────────
for (const c of load('scale').cases) {
  let why;
  try { why = cmp(c, S.scale(toRoi(c.input, c.name === 'line' ? LINE_HINT : undefined), c.params.xscale, c.params.yscale, c.params.centered).roi); } catch (e) { why = 'threw ' + e.message; }
  note('scale', c.name + ' ' + JSON.stringify(c.params), !why, why);
}
for (const c of load('rotate').cases) {
  const around = c.params.center !== 'roi';
  let why;
  try { why = cmp(c, S.rotate(toRoi(c.input, c.name === 'line' ? LINE_HINT : undefined), c.params.angle, around, W, H).roi); } catch (e) { why = 'threw ' + e.message; }
  note('rotate', c.name + ' ' + JSON.stringify(c.params), !why, why);
}
for (const c of load('translate').cases) {
  let why;
  try { why = cmp(c, S.translate(toRoi(c.input, c.name === 'line' ? LINE_HINT : undefined), c.params.dx, c.params.dy).roi); } catch (e) { why = 'threw ' + e.message; }
  note('translate', c.name + ' ' + JSON.stringify(c.params), !why, why);
}
// ───────────────────────── Area to Line / Line to Area ─────────────────────────
for (const c of load('area_to_line').cases) {
  let why;
  try { why = cmp(c, S.areaToLine(toRoi(c.input), W, H).roi); } catch (e) { why = 'threw ' + e.message; }
  note('areaToLine', c.name, !why, why);
}
for (const c of load('line_to_area').cases) {
  let why;
  try {
    const roi = toRoi(c.input, c.name === 'line' ? LINE_HINT : undefined);
    roi.width = c.params.width;
    why = cmp(c, S.lineToArea(roi).roi, { anyTrace: true });
  } catch (e) { why = 'threw ' + e.message; }
  note('lineToArea', c.name + ' ' + JSON.stringify(c.params), !why, why);
}
// ───────────────────────── Make Band ─────────────────────────
for (const c of load('make_band').cases) {
  let why;
  try { why = cmp(c, (await S.makeBand(toRoi(c.input), c.params.size, W, H)).roi); } catch (e) { why = 'threw ' + e.message; }
  note('makeBand', c.name + ' ' + JSON.stringify(c.params), !why, why);
}
// ───────────────────────── Straighten ─────────────────────────
{
  const j = load('straighten');
  const imgs = { 8: j.input, 16: j.input16 };
  for (const c of j.cases) {
    const src = imgs[c.bitDepth];
    const data = typed(src.data);
    const view = { width: src.width, height: src.height, bitDepth: c.bitDepth, channels: [{ data }] };
    let why = '';
    try {
      const roi = toRoi(c.roi, c.name === 'line' ? LINE_HINT : undefined);
      roi.width = c.params.width;
      const res = S.straightenPlanes(view, roi, c.params.width);
      const exp = c.result.output;
      const e = typed(exp.data);
      if (res.width !== exp.width || res.height !== exp.height) why = `size ${res.width}×${res.height} ≠ ${exp.width}×${exp.height}`;
      else {
        const g = res.planes[0];
        let bad = 0, first = -1;
        for (let i = 0; i < e.length; i++) if (!Object.is(g[i], e[i])) { bad++; if (first < 0) first = i; }
        if (bad) why = `${bad} of ${e.length} pixels differ (first ${first}: ${g[first]} ≠ ${e[first]})`;
      }
    } catch (err) { why = 'threw ' + err.message; }
    note('straighten', `${c.bitDepth}-bit ${c.name} ${c.params.width}`, !why, why);
  }
}

for (const [k, v] of Object.entries(stats)) console.log(`${k}: ${v.ok}/${v.n}`);
if (problems.length) { console.log(problems.join('\n')); }
assert.equal(problems.length, 0, `${problems.length} fixture mismatches`);
console.log('ij sel fixtures: OK');
