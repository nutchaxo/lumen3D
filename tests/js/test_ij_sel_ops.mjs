// Package sel (wave 3): the page-pure geometry (IJSelOps) on its own — properties that must hold for every selection type, independently
// of the ImageJ fixtures (test_ij_sel_fixtures.mjs checks the numbers, test_ij_sel_commands.mjs the commands):
//   - every operation keeps `roi.name` (PLAN-wave3 §2.7) and never writes into the selection it is given (deep-frozen inputs);
//   - determinism (the same call gives the same bytes), no timing, no randomness;
//   - geometric identities: rotate by 360° / by +a then −a, scale by 1, translate by an integer, Fit Circle of a circle, a spline
//     passes through its nodes (open) and closes on itself (closed), Interpolate spaces the points by the interval (Adjust: the last
//     segment hits the end point), Line to Area of a horizontal line, Straighten of a ramp, Make Band against a brute-force distance;
//   - Straighten in 8, 16 and 32 bits: a single channel is a Java float (32-bit), several channels come back in the bit depth of the source
//     through TypeConverter (value + 0.5, clamped), NaN stays NaN in a float image;
//   - refusals and their codes.
//
// Run: node tests/js/test_ij_sel_ops.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT } from './harness.mjs';

const DIR = path.join(ROOT, 'js', 'modules', 'studio', 'advanced-studio');
const sb = { console, setTimeout, clearTimeout };
sb.self = sb;
vm.createContext(sb);
for (const f of ['ij-core.js', 'ij-analysis.js', 'ij-proc-shared.js', 'ij-proc-roi.js', 'ij-proc-sel.js']) vm.runInContext(fs.readFileSync(path.join(DIR, f), 'utf8'), sb, { filename: f });
const S = sb.IJSelOps, IJRoi = sb.IJRoi;
const J = (x) => JSON.parse(JSON.stringify(x));
const fr = Math.fround;
let n = 0;
async function test(name, fn) { await fn(); n++; console.log('  ok  ' + name); }
function deepFreeze(o) { if (o && typeof o === 'object' && !ArrayBuffer.isView(o)) { Object.freeze(o); for (const k of Object.keys(o)) deepFreeze(o[k]); } return o; }
const frozen = (o) => deepFreeze(JSON.parse(JSON.stringify(o)));
const mask = (roi, W, H) => { const m = IJRoi.mask(roi, W, H); const s = []; for (let j = 0; j < m.h; j++) for (let i = 0; i < m.w; i++) if (m.data[j * m.w + i]) s.push((m.y + j) * 100000 + m.x + i); return s; };
const W = 80, H = 60;
const ring = IJRoi.translate(IJRoi.fromMask(Uint8Array.from({ length: 12 * 12 }, (_, i) => { const x = i % 12, y = (i / 12) | 0; const d = Math.hypot(x - 5.5, y - 5.5); return d < 5.5 && d > 2 ? 1 : 0; }), 12, 12), 20, 14);
const SAMPLES = {
  rect: { type: 'rect', x: 10, y: 8, w: 24, h: 14, name: 'n-rect' },
  oval: { type: 'oval', x: 12, y: 6, w: 28, h: 22, name: 'n-oval' },
  polygon: { type: 'polygon', points: [[8, 6], [40, 10], [52, 30], [30, 22], [36, 40], [14, 34]], name: 'n-polygon' },
  traced: { type: 'polygon', traced: true, points: [[10, 10], [30, 10], [30, 14], [24, 14], [24, 26], [10, 26]], name: 'n-traced' },
  freehand: { type: 'freehand', points: Array.from({ length: 48 }, (_, i) => [Math.round(30 + 14 * Math.cos(i / 48 * 6.2832) + (i % 3)), Math.round(25 + 10 * Math.sin(i / 48 * 6.2832))]), name: 'n-freehand' },
  polyline: { type: 'polyline', points: [[6, 38], [18, 12], [33, 30], [46, 10], [58, 28]], name: 'n-polyline' },
  freeline: { type: 'polyline', freeline: true, points: Array.from({ length: 40 }, (_, i) => [4 + i, Math.round(24 + 10 * Math.sin(i / 6))]), name: 'n-freeline' },
  line: { type: 'line', x1: 6, y1: 40, x2: 58, y2: 8, width: 1, name: 'n-line' },
  point: { type: 'point', points: [[10, 10], [30, 8], [46, 20], [40, 38], [14, 36], [8, 24]], name: 'n-point' },
  mask: Object.assign({}, ring, { name: 'n-mask' })
};
const isArea = (k) => ['rect', 'oval', 'polygon', 'traced', 'freehand', 'mask'].includes(k);

await test('every operation keeps the name and leaves its input alone; the same call gives the same bytes', async () => {
  for (const [k, roi0] of Object.entries(SAMPLES)) {
    const roi = roi0.rle ? Object.assign({}, roi0) : frozen(roi0);
    if (roi.rle) { Object.freeze(roi); }
    const calls = [];
    calls.push(['interpolate', () => S.interpolate(roi, 2.5, true, false)]);
    calls.push(['scale', () => S.scale(roi, 1.25, 0.8, false, W, H)]);
    calls.push(['scaleC', () => S.scale(roi, 1.25, 0.8, true, W, H)]);
    calls.push(['rotate', () => S.rotate(roi, 20, false, W, H)]);
    calls.push(['rotateImg', () => S.rotate(roi, -35, true, W, H)]);
    calls.push(['translate', () => S.translate(roi, 3, -2)]);
    if (['polygon', 'traced', 'freehand', 'polyline', 'freeline'].includes(k)) calls.push(['fitSpline', () => S.fitSpline(roi)]);
    if (k !== 'line') calls.push(['fitCircle', () => S.fitCircle(roi, W, H)], ['fitRectangle', () => S.fitRectangle(roi)]);
    if (isArea(k) && k !== 'mask') calls.push(['areaToLine', () => S.areaToLine(roi, W, H)]);
    if (['line', 'polyline', 'freeline'].includes(k)) calls.push(['lineToArea', () => S.lineToArea(Object.assign({}, roi, { width: 3 }))]);
    for (const [op, f] of calls) {
      let a, b;
      try { a = f(); b = f(); } catch (e) { if (k === 'point' && op === 'interpolate') continue; throw new Error(`${k} ${op}: ${e.stack}`); }
      assert.ok(a.roi, `${k} ${op}`);
      if (!a.unchanged) assert.equal(a.roi.name, roi.name, `${k} ${op}: the name is kept`);
      assert.deepEqual(J(a), J(b), `${k} ${op}: deterministic`);
      assert.doesNotThrow(() => IJRoi.validate(a.roi), `${k} ${op}: a valid selection`);
    }
    const band = isArea(k) ? await S.makeBand(roi, 4, W, H) : null;
    if (band) { assert.equal(band.roi.name, roi.name, k + ' band name'); IJRoi.validate(band.roi); }
  }
});

await test('rotate: 360° is the identity, +a then −a gives the selection back, 90° swaps the sides of a rectangle, the centre is the box centre', async () => {
  const p = SAMPLES.polygon;
  const r360 = S.rotate(p, 360, false, W, H).roi;
  p.points.forEach((q, i) => { assert.ok(Math.abs(r360.points[i][0] - q[0]) < 2e-5 && Math.abs(r360.points[i][1] - q[1]) < 2e-5); });
  const back = S.rotate(S.rotate(p, 33, false, W, H).roi, -33, false, W, H).roi;
  p.points.forEach((q, i) => { assert.ok(Math.abs(back.points[i][0] - q[0]) < 1e-4 && Math.abs(back.points[i][1] - q[1]) < 1e-4); });
  const r90 = S.rotate({ type: 'rect', x: 10, y: 10, w: 20, h: 6 }, 90, false, W, H).roi;
  const xs = r90.points.map((q) => q[0]), ys = r90.points.map((q) => q[1]);
  assert.ok(Math.abs(Math.max(...xs) - Math.min(...xs) - 6) < 1e-4 && Math.abs(Math.max(...ys) - Math.min(...ys) - 20) < 1e-4);
  // positive = clockwise on the screen: the top-left corner goes to the top-right
  assert.ok(Math.abs(r90.points[0][0] - 23) < 1e-4 && Math.abs(r90.points[0][1] - 3) < 1e-4, JSON.stringify(r90.points[0]));
  assert.deepEqual(J(r90.rotationCenter), [20, 13]);
  // a rotated rectangle keeps being a rectangle of the same width
  const rr = S.fitRectangle(p).roi;
  const rot = S.rotate(rr, 30, false, W, H).roi;
  assert.ok(Math.abs(rot.rotRectWidth - rr.rotRectWidth) < 1e-9 && rot.points.length === 4);
  // a composite turned by 90° keeps its pixel count
  const m90 = S.rotate(SAMPLES.mask, 90, false, W, H).roi;
  assert.equal(IJRoi.area(m90), IJRoi.area(SAMPLES.mask));
});

await test('scale: ×1 is the identity, ×2 about the origin doubles every vertex, centred keeps the centroid, a composite scales its pixels', async () => {
  const p = SAMPLES.polygon;
  assert.deepEqual(J(S.scale(p, 1, 1, false, W, H).roi.points), J(p.points));
  assert.deepEqual(J(S.scale(p, 2, 2, false, W, H).roi.points), p.points.map((q) => [q[0] * 2, q[1] * 2]));
  const c = S.scale({ type: 'rect', x: 10, y: 10, w: 20, h: 10 }, 2, 2, true, W, H).roi;
  assert.deepEqual(J(c.points), [[0, 5], [40, 5], [40, 25], [0, 25]]);
  assert.equal(S.scale(SAMPLES.oval, 1.5, 1.5, false, W, H).roi.type, 'freehand', 'RoiScaler: an oval becomes a FREEROI');
  assert.equal(S.scale(SAMPLES.traced, 1.5, 1.5, false, W, H).roi.type, 'freehand', 'a traced polygon too');
  assert.equal(S.scale(SAMPLES.rect, 1.5, 1.5, false, W, H).roi.type, 'polygon', 'a rectangle becomes a polygon');
  assert.equal(S.scale(SAMPLES.polygon, 1.5, 1.5, false, W, H).roi.type, 'polygon');
  const mm = S.scale(SAMPLES.mask, 2, 2, false, W, H).roi;
  const a0 = IJRoi.area(SAMPLES.mask), a1 = IJRoi.area(mm);
  assert.ok(a1 > 3.4 * a0 && a1 < 4.6 * a0, `area ${a0} → ${a1}`);
  assert.ok(IJRoi.outlines(mm).length === 2, 'the ring keeps its hole');
  assert.throws(() => S.scale(p, NaN, 1, false, W, H), (e) => e.code === 'IJ_BAD_ARGS');
});

await test('translate: an integer offset is exact for every type, the spline nodes move with it, the rotation centre stays where Roi.setLocation leaves it', async () => {
  for (const [k, roi] of Object.entries(SAMPLES)) {
    const t = S.translate(roi, 7, -4).roi;
    assert.equal(t.type, roi.type, k);
    if (t.points) roi.points.forEach((q, i) => { assert.deepEqual([t.points[i][0], t.points[i][1]], [q[0] + 7, q[1] - 4]); });
  }
  const sp = S.fitSpline(SAMPLES.polygon).roi;
  const mv = S.translate(sp, 5, 3).roi;
  assert.deepEqual(J(mv.nodeBase), [sp.nodeBase[0] + 5, sp.nodeBase[1] + 3]);
  // Roi.setLocation (Roi.java:273-291, :2680-2694) leaves xcenter / ycenter alone
  const turned = S.rotate(SAMPLES.rect, 30, false, W, H).roi;
  assert.deepEqual(J(S.translate(turned, 9, 2).roi.rotationCenter), J(turned.rotationCenter));
  // a straightening of the moved spline equals the straightening of the original, shifted: use a ramp image and compare by value
  const img = (W2, H2, f) => ({ width: W2, height: H2, bitDepth: 32, channels: [{ data: Float32Array.from({ length: W2 * H2 }, (_, i) => f(i % W2, (i / W2) | 0)) }] });
  const ramp = img(120, 90, (x, y) => x * 3 + y);
  const open = { type: 'polyline', points: [[10, 20], [30, 10], [50, 30], [70, 15]] };
  const a = S.straightenPlanes(ramp, S.fitSpline(open).roi, 5), b = S.straightenPlanes(ramp, S.translate(S.fitSpline(open).roi, 20, 7).roi, 5);
  assert.equal(a.width, b.width);
  for (let i = 0; i < a.planes[0].length; i++) assert.ok(Math.abs(b.planes[0][i] - a.planes[0][i] - 20 * 3 - 7) < 1e-3, 'shifted by the offset on a ramp');
});

await test('Fit Circle: a circle of points gives its centre and radius; the area form keeps the area; collinear / too few points refuse', async () => {
  const pts = Array.from({ length: 36 }, (_, i) => [Math.round(30 + 12 * Math.cos(i / 36 * 6.28319)), Math.round(25 + 12 * Math.sin(i / 36 * 6.28319))]);
  const c = S.fitCircle({ type: 'polyline', points: pts }, W, H).roi;
  assert.deepEqual([c.x, c.y, c.w, c.h], [18, 13, 24, 24]);
  const o = S.fitCircle({ type: 'oval', x: 10, y: 10, w: 30, h: 30 }, W, H).roi;
  assert.deepEqual([o.x, o.y, o.w], [10, 10, 30], 'a circle is its own fit');
  const r = S.fitCircle({ type: 'rect', x: 0, y: 0, w: 20, h: 20 }, W, H).roi;
  assert.ok(Math.abs(IJRoi.area(r) - 400) < 25, 'about the area of the rectangle');
  assert.throws(() => S.fitCircle({ type: 'polyline', points: [[1, 1], [5, 5], [9, 9]] }, W, H), (e) => e.code === 'IJ_SEL_COLLINEAR');
  assert.throws(() => S.fitCircle({ type: 'polyline', points: [[1, 1], [5, 9]] }, W, H), (e) => e.code === 'IJ_SEL_FEW_POINTS');
  assert.throws(() => S.fitCircle({ type: 'line', x1: 1, y1: 1, x2: 9, y2: 9 }, W, H), (e) => e.code === 'IJ_SEL_FEW_POINTS');
});

await test('Fit Rectangle: an axis-aligned rectangle is its own fit; a rotated box is recovered; a line is refused', async () => {
  const a = S.fitRectangle({ type: 'rect', x: 10, y: 8, w: 30, h: 20 }).roi;
  assert.deepEqual(J(a.points), [[10, 8], [40, 8], [40, 28], [10, 28]]);
  const box = S.rotate({ type: 'rect', x: 20, y: 20, w: 30, h: 10 }, 25, false, W, H).roi;
  const f = S.fitRectangle(box).roi;
  const area = (p) => Math.abs(p.reduce((s, q, i) => s + q[0] * p[(i + 1) % p.length][1] - p[(i + 1) % p.length][0] * q[1], 0)) / 2;
  assert.ok(Math.abs(area(f.points) - 300) < 0.05, 'the minimum area box has the area of the rotated rectangle: ' + area(f.points));
  assert.ok(Math.abs(f.rotRectWidth - 10) < 1e-3 || Math.abs(f.rotRectWidth - 30) < 1e-3);
  assert.throws(() => S.fitRectangle(SAMPLES.line), (e) => e.code === 'IJ_SEL_NEEDS_AREA_OR_POINTS');
  // Selection.fitRectangle: "At least three points are required" has its own code, not the circle's sentence
  assert.throws(() => S.fitRectangle({ type: 'point', points: [[1, 1], [3, 5]] }), (e) => e.code === 'IJ_SEL_FEW_POINTS_RECT');
  assert.throws(() => S.fitRectangle({ type: 'point', points: [[1, 1], [3, 3], [5, 5]] }), (e) => e.code === 'IJ_SEL_COLLINEAR');
});

await test('Fit Spline: the open spline starts and ends on its nodes, the closed one closes on itself, ≥ 100 points, refuses the others', async () => {
  const open = S.fitSpline(SAMPLES.polyline).roi;
  assert.deepEqual(J(open.points[0]), SAMPLES.polyline.points[0]);
  const last = open.points[open.points.length - 1], tl = SAMPLES.polyline.points[SAMPLES.polyline.points.length - 1];
  assert.ok(Math.abs(last[0] - tl[0]) < 1e-3 && Math.abs(last[1] - tl[1]) < 1e-3);
  assert.ok(open.points.length >= 100 && open.type === 'polyline');
  const closed = S.fitSpline(SAMPLES.polygon).roi;
  const cl = closed.points[closed.points.length - 1];
  assert.ok(Math.abs(cl[0] - closed.points[0][0]) < 1e-3 && Math.abs(cl[1] - closed.points[0][1]) < 1e-3, 'closed');
  // every node is within a hair of the curve
  const segDist = (q, a, b) => { const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy || 1; const t = Math.max(0, Math.min(1, ((q[0] - a[0]) * dx + (q[1] - a[1]) * dy) / l2)); return Math.hypot(q[0] - a[0] - t * dx, q[1] - a[1] - t * dy); };
  for (const q of SAMPLES.polygon.points) assert.ok(Math.min(...closed.points.slice(1).map((c, i) => segDist(q, closed.points[i], c))) < 0.05, 'node ' + q);
  // fitting the fitted selection again starts from its nodes: same nodes
  assert.deepEqual(J(S.fitSpline(closed).roi.nodes.length), SAMPLES.polygon.points.length);
  for (const k of ['rect', 'oval', 'line', 'point', 'mask']) assert.throws(() => S.fitSpline(SAMPLES[k]), (e) => e.code === 'IJ_SEL_NEEDS_POLY', k);
  // an EllipseRoi (Fit Ellipse) is left alone
  assert.equal(S.fitSpline({ type: 'polygon', points: SAMPLES.polygon.points, ellipse: { x1: 0, y1: 0, x2: 1, y2: 1, aspect: 0.5 } }).unchanged, true);
});

await test('Interpolate: points one interval apart, Adjust makes the last segment hit the end point, a point selection is left alone, small intervals refuse', async () => {
  const line = { type: 'polyline', points: [[5, 5], [45, 5]] };
  const r = S.interpolate(line, 4, false, false).roi;
  assert.equal(r.freeline, true, 'a line gives a free line below an interval of 8');
  assert.deepEqual(J(r.points.slice(0, 3)), [[5, 5], [9, 5], [13, 5]], 'one interval apart');
  const r2 = S.interpolate(line, 4.3, false, true).roi;
  const pts = r2.points;
  assert.deepEqual(J(pts[pts.length - 1]), [45, 5], 'Adjust: the end point is kept');
  const gaps = pts.slice(1).map((q, i) => Math.hypot(q[0] - pts[i][0], q[1] - pts[i][1]));
  assert.ok(gaps[0] < 4.3 && gaps[0] > 0.8 * 4.3, 'the interval was shortened (never below 80 %)');
  assert.ok(Math.abs(gaps[gaps.length - 1] - gaps[0]) < 0.05, 'the last segment matches within 0.05 pixel (Roi.getInterpolatedPolygon stops there)');
  assert.ok(gaps.slice(0, -1).every((g) => Math.abs(g - gaps[0]) < 1e-4), 'every other segment is one interval');
  assert.equal(S.interpolate(SAMPLES.point, 2, false, false).unchanged, true);
  assert.throws(() => S.interpolate(SAMPLES.polygon, 0.005, false, false), (e) => e.code === 'IJ_SEL_INTERVAL');
  assert.throws(() => S.interpolate(SAMPLES.polygon, NaN, false, false), (e) => e.code === 'IJ_BAD_ARGS');
});

await test('Area to Line / Line to Area: the −0.5 shift, the line types, a composite refuses, a horizontal line paints width × (length + 1) pixels', async () => {
  const al = S.areaToLine(SAMPLES.polygon, W, H).roi;
  assert.deepEqual(J(al.points), SAMPLES.polygon.points.map((q) => [q[0] - 0.5, q[1] - 0.5]));
  assert.equal(S.areaToLine(SAMPLES.traced, W, H).roi.freeline, true);
  assert.equal(S.areaToLine({ type: 'rect', x: 78, y: 58, w: 4, h: 4 }, W, H).roi.type, 'polyline');
  assert.throws(() => S.areaToLine(SAMPLES.mask, W, H), (e) => e.code === 'IJ_SEL_COMPOSITE');
  assert.throws(() => S.areaToLine(SAMPLES.line, W, H), (e) => e.code === 'IJ_SEL_NEEDS_AREA');
  const hl = { type: 'polyline', points: [[10, 20], [30, 20]], width: 3 };
  const a = S.lineToArea(hl).roi;
  assert.equal(IJRoi.area(a), 3 * 21, 'the line covers its end pixels: 21 pixels long');
  assert.throws(() => S.lineToArea(SAMPLES.rect), (e) => e.code === 'IJ_SEL_NEEDS_LINE');
  // width < 1 is 1
  assert.equal(S.lineToArea({ type: 'line', x1: 0, y1: 0, x2: 10, y2: 0, width: 0 }).roi.rotRectWidth, 1);
  // a repeated vertex does not poison the other segments (PolygonFiller skips the NaN polygons)
  const dup = S.lineToArea({ type: 'polyline', points: [[10, 20], [20, 20], [20, 20], [30, 20]], width: 3 }).roi;
  assert.ok(IJRoi.area(dup) >= 3 * 15 && IJRoi.area(dup) <= 3 * 21);
});

await test('Make Band against a brute-force distance: the rounded Euclidean distance to the selection is in 1..n, the selection itself is excluded', async () => {
  const roi = { type: 'polygon', points: [[20, 14], [42, 18], [38, 36], [24, 32]] };
  const Wd = 70, Hd = 56, nb = 6;
  const band = (await S.makeBand(roi, nb, Wd, Hd)).roi;
  const inside = mask(roi, Wd, Hd).map((v) => [v % 100000, Math.floor(v / 100000)]);
  const bs = new Set(mask(band, Wd, Hd));
  const ms = new Set(mask(roi, Wd, Hd));
  for (let y = 0; y < Hd; y++) for (let x = 0; x < Wd; x++) {
    let d = Infinity;
    for (const [px, py] of inside) d = Math.min(d, Math.hypot(px - x, py - y));
    const key = y * 100000 + x;
    const rounded = Math.floor(d + 0.5);
    if (ms.has(key)) assert.ok(!bs.has(key), 'inside is not band');
    else if (rounded <= nb) assert.ok(bs.has(key), `(${x},${y}) at ${d.toFixed(3)} is in the band`);
    else assert.ok(!bs.has(key), `(${x},${y}) at ${d.toFixed(3)} is outside the band`);
  }
  await assert.rejects(S.makeBand(roi, 300, Wd, Hd), (e) => e.code === 'IJ_SEL_BAND_TOO_WIDE');
  await assert.rejects(S.makeBand(roi, 0, Wd, Hd), (e) => e.code === 'IJ_SEL_NO_BAND', 'n = 0: no pixel below 0');
  await assert.rejects(S.makeBand(SAMPLES.line, 4, Wd, Hd), (e) => e.code === 'IJ_SEL_NEEDS_AREA');
  // a selection touching the image corner: the band is cut by the image
  const corner = (await S.makeBand({ type: 'rect', x: 0, y: 0, w: 10, h: 8 }, 5, Wd, Hd)).roi;
  for (const v of mask(corner, Wd, Hd)) assert.ok(v % 100000 >= 0 && Math.floor(v / 100000) >= 0);
});

await test('Straighten: 8 / 16 / 32 bits, one channel → a float image, several channels → the bit depth of the source (TypeConverter), NaN stays NaN', async () => {
  const mk = (bitDepth, C, f) => {
    const Ctor = bitDepth === 8 ? Uint8Array : bitDepth === 16 ? Uint16Array : Float32Array;
    return { width: 60, height: 40, bitDepth, channels: Array.from({ length: C }, (_, c) => ({ data: Ctor.from({ length: 60 * 40 }, (_, i) => f(i % 60, (i / 60) | 0, c)) })) };
  };
  const line = { type: 'line', x1: 5, y1: 10, x2: 45, y2: 10 };
  // a horizontal line over the ramp v = 3x: every row of the output is the ramp sampled each pixel
  const one = S.straightenPlanes(mk(8, 1, (x) => x * 3), Object.assign({ width: 1 }, line), 1);
  assert.equal(one.bitDepth, 32); assert.equal(one.planes[0].constructor.name, 'Float32Array');
  assert.equal(one.width, 41); assert.equal(one.height, 1);
  for (let i = 0; i < one.width; i++) assert.ok(Math.abs(one.planes[0][i] - 3 * (5 + i)) < 1e-4, 'ramp ' + i);
  // 16-bit, three channels: back to 16-bit with +0.5 and clamping at 65535
  const multi = S.straightenPlanes(mk(16, 2, (x, y, c) => (c ? 65535 : x * 1000)), Object.assign({ width: 3 }, line), 3);
  assert.equal(multi.bitDepth, 16); assert.equal(multi.planes[0].constructor.name, 'Uint16Array');
  assert.equal(multi.height, 3);
  assert.ok(multi.planes[1].every((v) => v === 65535));
  assert.equal(multi.planes[0][0], 5000);
  // 8-bit with an overshoot: bicubic is not used, bilinear never leaves the data range
  const m8 = S.straightenPlanes(mk(8, 3, (x, y, c) => (x * 4 + c) & 255), { type: 'polyline', points: [[3, 5], [30, 20], [50, 12]], width: 6 }, 6);
  assert.equal(m8.bitDepth, 8);
  for (const p of m8.planes) assert.equal(p.constructor.name, 'Uint8Array');
  // 32-bit with NaN: the float image keeps NaN where a sample touches it (ImageProcessor.getInterpolatedValue)
  const nan = mk(32, 1, (x, y) => (x === 20 ? NaN : x));
  const fn = S.straightenPlanes(nan, Object.assign({ width: 1 }, line), 1);
  assert.ok(Number.isNaN(fn.planes[0][15]), 'x = 20 is NaN');
  assert.equal(fn.bitDepth, 32);
  // a line leaving the image: 0 outside (getInterpolatedValue returns 0 beyond one pixel)
  const out = S.straightenPlanes(mk(8, 1, () => 100), { type: 'line', x1: -20, y1: 10, x2: 20, y2: 10, width: 1 }, 1);
  assert.equal(out.planes[0][0], 0); assert.ok(out.planes[0][out.width - 1] > 0);
  // refusals
  assert.throws(() => S.straightenPlanes(mk(8, 1, () => 1), SAMPLES.rect, 5), (e) => e.code === 'IJ_SEL_NEEDS_LINE');
  assert.throws(() => S.straightenPlanes(mk(8, 1, () => 1), line, 0), (e) => e.code === 'IJ_BAD_ARGS');
  // deterministic
  const again = S.straightenPlanes(mk(8, 1, (x) => x * 3), Object.assign({ width: 1 }, line), 1);
  assert.deepEqual(Array.from(again.planes[0]), Array.from(one.planes[0]));
});

await test('an EllipseRoi (Fit Ellipse) is a FREEROI: Interpolate smooths it, Area to Line gives a freeline, Rotate / Scale a freehand', async () => {
  const pts = Array.from({ length: 72 }, (_, i) => [fr(30 + 20 * Math.cos(i / 72 * 2 * Math.PI)), fr(25 + 10 * Math.sin(i / 72 * 2 * Math.PI))]);
  const ell = { type: 'polygon', points: pts, ellipse: { x1: 10, y1: 25, x2: 50, y2: 25, aspect: 0.5 } };
  assert.equal(S.kindOf(ell), 'freehand');
  assert.equal(S.kindOf({ type: 'polygon', points: pts }), 'polygon');
  const a = S.interpolate(ell, 2.5, true, false).roi, b = S.interpolate(ell, 2.5, false, false).roi;
  assert.equal(a.type, 'freehand');
  assert.notDeepEqual(J(a.points), J(b.points), 'Smooth changes the vertices');
  assert.equal(S.interpolate(ell, 9, false, false).roi.type, 'polygon', 'interval >= 8 gives a polygon for a FREEROI');
  const l = S.areaToLine(ell, W, H).roi;
  assert.equal(l.type, 'polyline'); assert.equal(l.freeline, true);
  assert.equal(S.rotate(ell, 20, false, W, H).roi.type, 'freehand');
  assert.equal(S.scale(ell, 2, 2, false).roi.type, 'freehand');
});

await test('Interpolate of a ShapeRoi with ONE part takes the plain path (Adjust honoured, FREEROI, never smoothed), a holed one the composite path', async () => {
  const band = IJRoi.fromMask(Uint8Array.from({ length: 20 * 14 }, (_, i) => ((i % 20) < 5 || Math.floor(i / 20) >= 9 ? 1 : 0)), 20, 14);
  assert.equal(IJRoi.outlines(band).length, 1);
  const plain = S.interpolate(band, 2.5, false, false).roi, adj = S.interpolate(band, 2.5, false, true).roi;
  assert.equal(plain.type, 'freehand');
  assert.notEqual(adj.points.length, plain.points.length, 'Adjust interval to match changes the spacing');
  assert.deepEqual(J(S.interpolate(band, 2.5, true, false).roi.points), J(plain.points), 'a COMPOSITE is never smoothed');
  assert.equal(S.interpolate(ring, 2.5, false, false).roi.type, 'mask', 'a holed shape stays a composite');
});

await test('Fit Spline trimming works on coordinates relative to the bounds (Selection.trimPolygon): far from the origin gives the same vertices', async () => {
  let seed = 12345;
  const rnd = () => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed / 4294967296; };
  for (let k = 0; k < 4000; k++) {
    const n = 40 + Math.floor(rnd() * 60), off = 1000 + Math.floor(rnd() * 7000), offY = 1000 + Math.floor(rnd() * 7000);
    const xs = [], ys = [];
    for (let i = 0; i < n; i++) { const a = 2 * Math.PI * i / n, r = 14 + 3 * Math.sin(3 * a) + Math.floor(rnd() * 3); xs.push(Math.round(32 + r * Math.cos(a))); ys.push(Math.round(24 + r * Math.sin(a))); }
    const len = 90 + rnd() * 60;
    const a = S.trimPolygonInt('freehand', xs, ys, len), b = S.trimPolygonInt('freehand', xs.map((v) => v + off), ys.map((v) => v + offY), len);
    assert.deepEqual(J(b.xs), J(a.xs.map((v) => v + off)), 'case ' + k);
    assert.deepEqual(J(b.ys), J(a.ys.map((v) => v + offY)), 'case ' + k);
  }
});

await test('Fit Circle: the pixel count and centroid read in strips equal the whole mask, with or without an image', async () => {
  const HH = 200, WW = 90;
  const shapes = [{ type: 'rect', x: -5, y: 3, w: 50, h: 190 }, { type: 'rect', x: 10.5, y: 20.5, w: 20, h: 30 }, { type: 'oval', x: 5, y: 2, w: 70, h: 180 },
    { type: 'polygon', points: [[8, 6], [60, 10], [80, 150], [30, 190], [14, 90]] }, ring];
  for (const roi of shapes) {
    const m = IJRoi.mask(roi, WW, HH);
    let count = 0, xs = 0, ys = 0;
    for (let j = 0; j < m.h; j++) for (let i = 0; i < m.w; i++) if (m.data[j * m.w + i]) { count++; xs += m.x + i; ys += m.y + j; }
    const r = S.fitCircle(roi, WW, HH).roi;
    const rad = Math.sqrt(count / Math.PI), cx = xs / count + 0.5, cy = ys / count + 0.5;
    assert.deepEqual(J(r), { type: 'oval', x: Math.floor(cx - rad + 0.5), y: Math.floor(cy - rad + 0.5), w: Math.floor(2 * rad + 0.5), h: Math.floor(2 * rad + 0.5) }, JSON.stringify(roi).slice(0, 40));
  }
  assert.equal(S.fitCircle({ type: 'rect', x: 0, y: 0, w: 20, h: 20 }).roi.w, Math.floor(2 * Math.sqrt(400 / Math.PI) + 0.5));
});

await test('the worker operations are registered with their kinds, versions and memory declarations', async () => {
  const R = sb.IJOpRegistry;
  for (const [name, kind] of [['makeBand', 'compute'], ['lineToArea', 'compute'], ['straighten', 'newdoc']]) {
    const spec = R.get(name);
    assert.ok(spec, name);
    assert.equal(spec.kind, kind); assert.equal(spec.version, 1); assert.equal(spec.preview, false); assert.equal(typeof spec.scratchBytes, 'function');
    assert.ok(spec.scratchBytes({ width: 1000, height: 800, bitDepth: 8, channels: 1, roi: SAMPLES.polyline }, { n: 5, width: 20 }) > 0);
  }
  assert.throws(() => R.get('makeBand').validate({ n: 300 }), (e) => e.code === 'IJ_BAD_ARGS');
  assert.throws(() => R.get('straighten').validate({ width: 5000, title: 'x' }), (e) => e.code === 'IJ_BAD_ARGS');
  assert.throws(() => R.get('straighten').validate({ width: 5, title: 7 }), (e) => e.code === 'IJ_BAD_ARGS');
  // makeBand peaks at ~9 bytes a pixel (mask 1, float EDM 4, byte EDM 1, box mask, region, dense): a 6000² image is declared as such
  assert.ok(R.get('makeBand').scratchBytes({ width: 6000, height: 6000 }) >= 6000 * 6000 * 9);
});

console.log(`ij sel ops: OK (${n} groups)`);
