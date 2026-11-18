// Package P6 (roi) against the golden fixtures recorded with the real ImageJ 1.54p
// (tests/fixtures/ij-wave2/roi, tools/ij_fixtures/P6.java): Wand outlines, measurements (area, shape, Feret, ellipse,
// threshold-limited, calibrated, line, segmented line, points), Enlarge, Create Mask / Selection, Convex Hull,
// Fit Ellipse, profiles and the Angle tool. Integer results (outlines, masks, selections) are compared exactly.
// Float results are compared with a relative tolerance of 1e-9 (Java accumulates some sums in a different order
// than this port: the two raw-moment formulas of ImageStatistics against our central moments); the flattened oval
// outline (OvalRoi.getFloatPolygon, Java float coordinates) with 2e-5 absolute.
//
// Run: node tests/js/test_ij_roi_fixtures.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT } from './harness.mjs';

const DIR = path.join(ROOT, 'js', 'modules', 'studio', 'advanced-studio');
const FX = path.join(ROOT, 'tests', 'fixtures', 'ij-wave2', 'roi');
const sb = { console, setTimeout, clearTimeout };
sb.self = sb;
vm.createContext(sb);
for (const f of ['ij-core.js', 'ij-analysis.js', 'ij-proc-shared.js', 'ij-proc-roi.js']) vm.runInContext(fs.readFileSync(path.join(DIR, f), 'utf8'), sb, { filename: f });
const T = sb.IJRoiTools, IJRoi = sb.IJRoi, Reg = sb.IJOpRegistry;

function decodeData(d) {
  if (Array.isArray(d)) return Float64Array.from(d, (v) => (v === null ? NaN : v));
  const b = Buffer.from(d.b64, 'base64');
  const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  return d.dtype === 'u8' ? new Uint8Array(ab) : d.dtype === 'u16' ? new Uint16Array(ab) : new Float32Array(ab);
}
const num = (v) => (v === 'Infinity' ? Infinity : v === '-Infinity' ? -Infinity : v === null ? NaN : v);
function image(im) {
  let data = decodeData(im.data);
  if (im.bitDepth === 8 && !(data instanceof Uint8Array)) data = Uint8Array.from(data);
  else if (im.bitDepth === 16 && !(data instanceof Uint16Array)) data = Uint16Array.from(data);
  else if (im.bitDepth === 32 && !(data instanceof Float32Array)) data = Float32Array.from(data, Math.fround);
  return { width: im.width, height: im.height, bitDepth: im.bitDepth, data };
}
function pairs(flat) { const o = []; for (let i = 0; i < flat.length; i += 2) o.push([flat[i], flat[i + 1]]); return o; }
function toRoi(r) {
  if (r.type === 'rect' || r.type === 'oval') return { type: r.type, x: r.x, y: r.y, w: r.w, h: r.h };
  const o = { type: 'polygon', points: pairs(r.pts) };
  if (r.traced) o.traced = true;
  return o;
}
function lineRoi(r) {
  if (r.type === 'line') return { type: 'line', x1: r.x1, y1: r.y1, x2: r.x2, y2: r.y2, width: r.width };
  return { type: 'polyline', points: pairs(r.pts), width: r.width };
}
const files = fs.readdirSync(FX).filter((f) => f.endsWith('.json')).sort();
const J = (f) => JSON.parse(fs.readFileSync(path.join(FX, f), 'utf8'));
const close = (a, b, rel = 1e-9, abs = 1e-9) => {
  if (Number.isNaN(a) && Number.isNaN(b)) return true;
  if (a === b) return true;
  return Math.abs(a - b) <= Math.max(abs, rel * Math.max(Math.abs(a), Math.abs(b)));
};

const stats = {};
const mismatches = [];
function pass(kind) { (stats[kind] = stats[kind] || { ok: 0, n: 0 }).ok++; stats[kind].n++; }
function failCase(kind, name, why) { (stats[kind] = stats[kind] || { ok: 0, n: 0 }).n++; mismatches.push(`${kind} ${name}: ${why}`); }
function check(kind, name, fn) { try { fn(); pass(kind); } catch (e) { failCase(kind, name, String(e.message).split('\n')[0].slice(0, 300)); } }

// ---- the rasterisation of ImageJ's own selections: IJRoi.mask against the recorded mask --------------
for (const f of files) {
  const j = J(f);
  if (!j.roi || !j.roi.mask || j.op === 'createMask' || j.op === 'fitEllipse') continue;
  check('roiMask', f, () => {
    const m = j.roi.mask, got = IJRoi.mask(toRoi(j.roi));
    assert.deepEqual([got.x, got.y, got.w, got.h], [m.x, m.y, m.w, m.h], 'box');
    assert.deepEqual(Array.from(got.data), Array.from(decodeData(m.data)), 'pixels');
  });
}

for (const f of files) {
  const j = J(f), name = f.replace('.json', '');
  switch (j.op) {
    case 'wand': check('wand', name, () => {
      const img = image(j.input);
      const p = j.params;
      const pts = T.wandOutline(img, p.x, p.y, { tolerance: p.tolerance, mode: p.connectivity });
      assert.equal(JSON.stringify(pts ? pts.flat() : []), JSON.stringify(Array.from(j.result.pts)), 'outline vertices');
      const roi = { type: 'polygon', points: pts, traced: true }, m = IJRoi.mask(roi), want = j.result.mask;
      assert.deepEqual([m.x, m.y, m.w, m.h], [want.x, want.y, want.w, want.h]);
      assert.deepEqual(Array.from(m.data), Array.from(decodeData(want.data)), 'mask of the outline');
    }); break;

    case 'measure': check('measure', name, () => {
      const img = image(j.input);
      const cal = j.params.calibration ? { pixelWidth: j.params.calibration.pixelWidth, pixelHeight: j.params.calibration.pixelHeight } : null;
      const KEYS = { Area: 'area', Mean: 'mean', StdDev: 'stdDev', Mode: 'mode', Min: 'min', Max: 'max', X: 'xCentroid', Y: 'yCentroid', XM: 'xCenterOfMass', YM: 'yCenterOfMass', 'Perim.': 'perim', BX: 'bx', BY: 'by', Width: 'bw', Height: 'bh', Major: 'major', Minor: 'minor', Angle: 'angle', 'Circ.': 'circularity', Feret: 'feret', IntDen: 'intDen', Median: 'median', Skew: 'skewness', Kurt: 'kurtosis', '%Area': 'areaFraction', RawIntDen: 'rawIntDen', FeretX: 'feretX', FeretY: 'feretY', FeretAngle: 'feretAngle', MinFeret: 'minFeret', AR: 'aspectRatio', Round: 'roundness', Solidity: 'solidity', MinThr: 'minThreshold', MaxThr: 'maxThreshold' };
      const keys = Object.values(KEYS);
      const row = T.measureArea({ img, roi: j.roi ? toRoi(j.roi) : null, cal, keys, thr: j.params.threshold || null, limit: !!j.params.limit });
      const bad = [];
      for (const [col, v] of Object.entries(j.result.columns)) {
        const k = KEYS[col];
        if (!k) { bad.push('unknown column ' + col); continue; }
        if (!(k in row)) { if (!(col === 'MinThr' || col === 'MaxThr')) bad.push(col + ' missing'); continue; }
        if (!close(row[k], num(v))) bad.push(`${col}: got ${row[k]} want ${num(v)}`);
      }
      assert.equal(bad.length, 0, bad.join('; '));
    }); break;

    case 'measurePoints': check('measurePoints', name, () => {
      const img = image(j.input);
      const cal = j.params.calibration ? { pixelWidth: j.params.calibration.pixelWidth, pixelHeight: j.params.calibration.pixelHeight } : null;
      // ImageJ point coordinates are pixel indices: this view marks pixel i by its centre i + 0.5
      const pts = pairs(j.params.pts).map(([x, y]) => [x + 0.5, y + 0.5]);
      const rows = T.measurePoints({ img, roi: { type: 'point', points: pts }, cal, keys: ['area', 'mean', 'min', 'max'] });
      assert.equal(rows.length, j.result.rows.length);
      rows.forEach((r, i) => {
        const w = j.result.rows[i];
        assert.equal(r.area, w.Area); assert.ok(close(r.mean, w.Mean), 'Mean'); assert.ok(close(r.min, w.Min)); assert.ok(close(r.max, w.Max));
        assert.ok(close(r.xCentroid, w.X, 1e-6), 'X ' + r.xCentroid + ' ' + w.X); assert.ok(close(r.yCentroid, w.Y, 1e-6), 'Y ' + r.yCentroid + ' ' + w.Y);
      });
    }); break;

    case 'measureLine': check('measureLine', name, () => {
      const img = image(j.input);
      const cal = j.params.calibration ? { pixelWidth: j.params.calibration.pixelWidth, pixelHeight: j.params.calibration.pixelHeight } : null;
      const row = T.measureLine({ img, roi: lineRoi(j.params.roi), cal, keys: ['area', 'mean', 'min', 'max'] });
      const c = j.result.columns;
      for (const [col, k] of [['Area', 'area'], ['Mean', 'mean'], ['Min', 'min'], ['Max', 'max'], ['Length', 'length'], ['Angle', 'angle']]) {
        if (c[col] === undefined) { assert.equal(row[k], undefined, col + ' must be absent'); continue; }
        assert.ok(close(row[k], c[col], 1e-9, 1e-9), `${col}: got ${row[k]} want ${c[col]}`);
      }
    }); break;

    case 'enlargeRoi': {
      // the command (|n| < 256: enlarge255, bytes) and the exact EDM path (float, what a distance of 256 and more runs)
      for (const [kind, want, exact] of [['enlarge', j.result.menu, false], ['enlargeExact', j.result.exact, true]]) check(kind, name, () => {
        const roi = toRoi(j.roi), n = j.params.n;
        const got = T.enlarge(roi, n, 64, 64, null, { exact });
        if (want.type === 'rect' || want.type === 'oval') {
          assert.equal(got.type, want.type);
          assert.deepEqual([got.x, got.y, got.w, got.h], [want.bounds.x, want.bounds.y, want.bounds.w, want.bounds.h]);
          return;
        }
        const gm = IJRoi.mask(got), wm = want.mask;
        assert.deepEqual([gm.x, gm.y, gm.w, gm.h], [wm.x, wm.y, wm.w, wm.h], 'bounds');
        assert.deepEqual(Array.from(gm.data), Array.from(decodeData(wm.data)), 'pixels');
      });
    } break;

    case 'createMask': check('createMask', name, () => {
      const out = image(j.output);
      const got = T.roiMask255(toRoi(j.roi), j.params.width, j.params.height);
      assert.deepEqual(Array.from(got), Array.from(out.data));
    }); break;

    case 'createSelection': check('createSelection', name, () => {
      const img = image(j.input), p = j.params;
      const m = sb.IJShared.thresholdMask(img, p.lower, p.upper);
      const roi = sb.IJShared.maskToRoi(m, img.width, img.height);
      const want = j.result;
      if (!want) { assert.equal(roi, null); return; }
      const gm = IJRoi.mask(roi), wm = want.mask;
      assert.deepEqual([gm.x, gm.y, gm.w, gm.h], [wm.x, wm.y, wm.w, wm.h], 'bounds');
      assert.deepEqual(Array.from(gm.data), Array.from(decodeData(wm.data)), 'pixels');
      // Perim. of the selection: ShapeRoi.getLength = the traced perimeter of each recorded polygon (>1 subpath forces the
      // traced type); the port builds the polygons the way ThresholdToSelection does (8-connected through pinch vertices).
      const polys = want.polygons.map((f) => pairs(f));
      const sumRef = polys.reduce((a, q) => a + IJRoi.tracedPerimeter(q, 1, 1), 0);
      const got = T.maskOutlines(roi);
      assert.equal(got.length, polys.length, 'polygon count');
      const area = (q) => { let a = 0; for (let i = 0; i < q.length; i++) { const u = q[i], v = q[(i + 1) % q.length]; a += u[0] * v[1] - v[0] * u[1]; } return Math.abs(a / 2); };
      assert.deepEqual(Array.from(got, area).sort((a, b) => a - b), polys.map(area).sort((a, b) => a - b), 'polygon areas');
      if (polys.length > 1) assert.ok(close(T.perimeter(roi, 1, 1), sumRef, 1e-12, 1e-9), `perimeter ${T.perimeter(roi, 1, 1)} vs ${sumRef}`);
    }); break;

    case 'convexHull': check('convexHull', name, () => {
      const roi = toRoi(j.roi);
      const v = T.roiVertices(roi), h = T.convexHull(v.xs, v.ys);
      const want = Array.from(j.result.pts);
      assert.equal(h.xs.length * 2, want.length, 'vertex count');
      const tol = roi.type === 'oval' ? 2e-5 : 0;
      for (let i = 0; i < h.xs.length; i++) {
        assert.ok(Math.abs(h.xs[i] - want[2 * i]) <= tol && Math.abs(h.ys[i] - want[2 * i + 1]) <= tol, `vertex ${i}: ${h.xs[i]},${h.ys[i]} vs ${want[2 * i]},${want[2 * i + 1]}`);
      }
    }); break;

    case 'fitEllipse': check('fitEllipse', name, () => {
      const roi = toRoi(j.roi), r = j.result;
      const m = IJRoi.mask(roi, 64, 64);
      const ef = T.fitEllipse(roi.type === 'rect' ? null : m.data, { x: m.x, y: m.y, w: m.w, h: m.h });
      assert.ok(close(ef.major, r.major) && close(ef.minor, r.minor) && close(ef.angle, r.angle) && close(ef.xCenter, r.xCentroid) && close(ef.yCenter, r.yCentroid), `fit ${JSON.stringify(ef)} vs ${JSON.stringify(r)}`);
      const dx = ef.major * Math.cos(ef.angle / 180.0 * Math.PI) / 2.0, dy = -ef.major * Math.sin(ef.angle / 180.0 * Math.PI) / 2.0;
      const poly = T.ellipsePolygon(ef.xCenter - dx, ef.yCenter - dy, ef.xCenter + dx, ef.yCenter + dy, ef.minor / ef.major);
      const want = Array.from(r.polygon);
      assert.equal(poly.length * 2, want.length);
      poly.forEach((p, i) => assert.ok(Math.abs(p[0] - want[2 * i]) < 1e-4 && Math.abs(p[1] - want[2 * i + 1]) < 1e-4, `polygon vertex ${i}`));
      const mk = T.roiMaskBox({ type: 'freehand', points: poly });
      const wm = r.mask;
      assert.deepEqual([mk.x, mk.y, mk.w, mk.h], [wm.x, wm.y, wm.w, wm.h], 'ellipse mask box');
      assert.deepEqual(Array.from(mk.data), Array.from(decodeData(wm.data)), 'ellipse mask');
    }); break;

    case 'profile': check('profile', name, () => {
      const img = image(j.input);
      // The recorded selection of profile_polyline_width3_u16 is the 59-point spline: Straightener.straightenLine(imp, width)
      // calls fitSplineForStraightening() on imp.getRoi() itself, so the driver read the selection AFTER ImageJ replaced it.
      // The polyline that was drawn is (5,5) (20,10) (30,28) (12,35); the profile was taken along it (FIXTURES-AUDIT.md).
      const drawn = name === 'profile_polyline_width3_u16' ? { type: 'polyline', pts: [5, 5, 20, 10, 30, 28, 12, 35], width: j.params.roi.width } : j.params.roi;
      const roi = lineRoi(drawn);
      const got = T.profile(img, roi), want = Array.from(j.result.profile, num);
      assert.equal(got.length, want.length, 'length');
      for (let i = 0; i < got.length; i++) assert.ok(close(got[i], want[i], 1e-9, 1e-9), `sample ${i}: ${got[i]} vs ${want[i]}`);
    }); break;

    case 'angle': check('angle', name, () => {
      const got = T.angleOf(pairs(j.params.pts), 1, 1);
      assert.ok(close(got, j.result.angle, 1e-9, 1e-9), `${got} vs ${j.result.angle}`);
      assert.ok(close(got, j.result.measureAngle, 1e-9, 1e-9));
    }); break;
    default: failCase('unknown', name, 'no comparator for ' + j.op);
  }
}


// ───────────── regressions of the review round (no recorded fixture covers them) ─────────────
{
  // a traced polygon of 400k vertices: the mask must not overflow the call stack (Math.max.apply over the edges did)
  const pts = [];
  for (let y = 0; y < 100000; y++) pts.push([1 + (y & 1), y]);
  for (let y = 99999; y >= 0; y--) pts.push([6 + (y & 1), y]);
  const m = IJRoi.mask({ type: 'polygon', points: pts }, 9, 100000);
  assert.ok(m.w > 0 && m.h >= 99990 && m.data.some((v) => v === 1), 'a polygon of 200000 vertices has a mask ' + JSON.stringify([m.x, m.y, m.w, m.h]));
}
{
  // Fit Ellipse result: EllipseRoi.getLength is the plain edge sum, getFeretValues takes the axes
  const poly = T.ellipsePolygon(5, 20, 45, 20, 0.5);
  const ell = { type: 'polygon', points: poly, ellipse: { x1: 5, y1: 20, x2: 45, y2: 20, aspect: 0.5 } };
  let sum = 0;
  for (let i = 0; i < poly.length; i++) { const a = poly[i], b = poly[(i + 1) % poly.length]; sum += Math.hypot(b[0] - a[0], b[1] - a[1]); }
  assert.equal(T.perimeter(ell, 1, 1), sum, 'edge sum, not the smoothed length of a freehand');
  assert.notEqual(T.perimeter({ type: 'freehand', points: poly }, 1, 1), sum);
  const f = T.feretValues(ell, 1, 1, 100, 100);
  assert.equal(f.feret, 40); assert.equal(f.min, 20, 'MinFeret = minor axis (EllipseRoi.getFeretValues)');
  assert.ok(T.feretValues({ type: 'polygon', points: poly }, 1, 1, 100, 100).min !== 20, 'a plain polygon keeps the caliper value');
}
{
  // To Bounding Box: Roi.getBounds of a float polygon is (int)(max - iMin + 0.5), not floor / ceil
  const roi = { type: 'polygon', points: [[3.2, 4.1], [20.3, 4.4], [12.4, 17.2]] };
  const b = T.roiBounds(roi), box = T.roiMaskBox(roi, 64, 64);
  assert.deepEqual([b.x, b.y, b.w, b.h], [3, 4, 17, 13]);
  assert.notDeepEqual([b.x, b.y, b.w, b.h], Array.from([IJRoi.bounds(roi)], (q) => [q.x, q.y, q.w, q.h])[0]);
  assert.ok(box.x >= b.x && box.x + box.w <= b.x + b.w && box.y + box.h <= b.y + b.h);
}
{
  const img = { width: 16, height: 16, bitDepth: 8, data: Uint8Array.from({ length: 256 }, (_, i) => (i * 7) & 255) };
  // points: "stats.xCenterOfMass = p.xpoints[i];" — the raw index, never multiplied by the pixel size
  const rows = T.measurePoints({ img, roi: { type: 'point', points: [[4.5, 6.5]] }, cal: { pixelWidth: 0.5, pixelHeight: 0.25 }, keys: ['xCenterOfMass', 'yCenterOfMass', 'xCentroid', 'yCentroid'] });
  assert.equal(rows[0].xCenterOfMass, 4); assert.equal(rows[0].yCenterOfMass, 6);
  assert.equal(rows[0].xCentroid, 2); assert.equal(rows[0].yCentroid, 1.5, 'X / Y are calibrated');
  // a line with no statistics group ticked: Length and Angle only
  const line = { type: 'line', x1: 1, y1: 1, x2: 10, y2: 6, width: 1 };
  const only = T.measureLine({ img, roi: line, cal: null, keys: ['perim', 'bx', 'bw', 'length', 'angle'], thr: null, limit: false });
  assert.deepEqual(Object.keys(only).sort(), ['angle', 'length']);
  // Limit to threshold on an 8-bit image: the profile goes through convertToByte(false) (value + 0.5 truncated)
  const poly = { type: 'polyline', points: [[1.3, 1.3], [9.7, 3.1], [12.2, 11.9]], width: 1 };
  const lim = T.measureLine({ img, roi: poly, cal: null, keys: ['area', 'mean', 'min', 'max'], thr: { lower: 0, upper: 255 }, limit: true });
  const prof = T.profile(img, poly), rounded = Array.from(prof, (v) => Math.floor(Math.min(255, Math.max(0, v)) + 0.5));
  assert.equal(lim.min, Math.min(...rounded)); assert.equal(lim.max, Math.max(...rounded));
  assert.ok(Math.abs(lim.mean - rounded.reduce((a, v) => a + v, 0) / rounded.length) < 1e-9, 'rounded values');
}
{
  // MinThr / MaxThr without a threshold are NaN (ImageStatistics.lowerThreshold = Double.NaN)
  const img = { width: 8, height: 8, bitDepth: 8, data: new Uint8Array(64).fill(9) };
  const r = T.measureArea({ img, roi: null, cal: null, keys: ['minThreshold', 'maxThreshold'], thr: null, limit: true });
  assert.ok(Number.isNaN(r.minThreshold) && Number.isNaN(r.maxThreshold));
}
{
  // A mask of 8-connected pixels: ShapeRoi.getLength forces the traced type for every outline of a composite selection
  const d = new Uint8Array(6 * 4);
  for (const [x, y] of [[1, 1], [2, 2], [3, 1], [4, 2]]) d[y * 6 + x] = 1;   // a zig-zag touching only at corners
  const roi = IJRoi.fromMask(d, 6, 4);
  const polys = T.maskOutlines(roi);
  assert.ok(polys.length < 4, 'diagonal neighbours share a polygon through the pinch vertex (4 pixels would be 4 loops)');
  assert.equal(T.perimeter(roi, 1, 1), polys.reduce((a, q) => a + IJRoi.tracedPerimeter(q, 1, 1), 0));
}

let total = 0, ok = 0;
for (const [k, v] of Object.entries(stats)) { total += v.n; ok += v.ok; console.log(`${k.padEnd(16)} ${v.ok}/${v.n}`); }
console.log(`total ${ok}/${total}`);
if (process.env.SHOW_ALL) for (const m of mismatches) console.log('  MISMATCH', m);
// Fixtures this port is known not to match, with the reason (kept explicit so a regression elsewhere cannot hide).
const KNOWN = [];
const unexpected = mismatches.filter((m) => !KNOWN.some((rx) => rx.test(m)));
for (const m of unexpected) console.error('MISMATCH', m);
assert.equal(unexpected.length, 0, `${unexpected.length} fixtures differ from ImageJ 1.54p`);
console.log('ij roi fixtures: ok');
