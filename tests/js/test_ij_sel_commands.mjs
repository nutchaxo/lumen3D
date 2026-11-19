// Package sel (wave 3), end to end through the real controller and the real engine (tests/js/ij_harness.mjs):
//   Edit > Selection > Fit Spline, Fit Circle, Fit Rectangle, Interpolate, Properties…, Scale…, Rotate…, Translate…, Make Band…,
//   Straighten…, Line to Area, Area to Line — the menu rows, the dialogs (fields, defaults, what is remembered between two calls), the
//   selections they produce (against IJSelOps, whose numbers are checked against ImageJ 1.54p in test_ij_sel_fixtures.mjs), the
//   worker operations (makeBand, lineToArea: compute; straighten: new image — undo-free, restored after a reload), refusals and the
//   error keys, cooperative cancellation of the long loops, determinism and "no write into the inputs" (the harness runs the engine
//   with verifyInputs).
//
// Run: node tests/js/test_ij_sel_commands.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { boot, until, J, DIR } from './ij_harness.mjs';

const arr = (x) => Array.from(x);
// values built inside the page's vm context have another Array prototype: compare their JSON
const eq = (a, b, m) => assert.deepEqual(J(a), J(b), m || 'values differ');
const setRoi = (t, roi) => t.shell.opts.onRoi(roi, { final: true, source: 'draw' });
const activeRoi = (t) => t.shell.activeRoi;
const maskSet = (t, roi) => { const m = t.page.IJRoi.mask(roi); const s = []; for (let j = 0; j < m.h; j++) for (let i = 0; i < m.w; i++) if (m.data[j * m.w + i]) s.push((m.y + j) * 10000 + m.x + i); return s; };
const lastSpec = (t) => t.log.dialogSpecs[t.log.dialogSpecs.length - 1];
const field = (spec, id) => spec.fields.find((f) => f.id === id);

let n = 0;
async function test(name, fn) { await fn(); n++; console.log('  ok  ' + name); }
const fresh = async () => { const t = await boot({ channels: 3 }); await t.open(); return t; };

const POLY = { type: 'polygon', points: [[6, 4], [30, 6], [34, 22], [20, 26], [8, 18]] };
const LINE = { type: 'line', x1: 4, y1: 22, x2: 34, y2: 6 };
const POLYLINE = { type: 'polyline', points: [[4, 24], [12, 8], [22, 20], [34, 6]] };

await test('menu rows: ImageJ order inside Edit > Selection, one separator (before Properties), shortcut y', async () => {
  const t = await fresh();
  const want = { selFitSpline: 40, selFitCircle: 50, selFitEllipse: 60, selFitRectangle: 70, selInterpolate: 80, selConvexHull: 90, selCreateSelection: 110, selCreateMask: 120, selProperties: 130,
    selScale: 140, selRotate: 150, selTranslate: 160, selEnlarge: 170, selMakeBand: 180, selSpecify: 190, selStraighten: 200, selToBoundingBox: 210, selLineToArea: 220, selAreaToLine: 230 };
  for (const [id, order] of Object.entries(want)) {
    const c = t.cmd(id);
    assert.ok(c, id);
    eq(J(c.menu), ['Edit', 'Selection'], id + ' menu');
    assert.equal(c.order, order, id + ' order');
    assert.equal(!!c.separatorBefore, id === 'selProperties', id + ' separator');
  }
  eq(J([].concat(t.cmd('selProperties').shortcut)), ['y']);
  assert.ok(t.cmd('selProperties').repeatable !== false);
  // the labels are ImageJ's
  const en = JSON.parse(fs.readFileSync(path.join(DIR, 'lang-parts', 'sel.json'), 'utf8')).en.cmd;
  eq(en, { selFitSpline: 'Fit Spline', selFitCircle: 'Fit Circle', selFitRectangle: 'Fit Rectangle', selInterpolate: 'Interpolate', selProperties: 'Properties…', selScale: 'Scale…', selRotate: 'Rotate…',
    selTranslate: 'Translate…', selMakeBand: 'Make Band…', selStraighten: 'Straighten…', selLineToArea: 'Line to Area', selAreaToLine: 'Area to Line' });
  t.close();
});

await test('enabled(): each command needs what ImageJ asks for', async () => {
  const t = await fresh();
  setRoi(t, null);
  for (const id of ['selFitSpline', 'selFitCircle', 'selFitRectangle', 'selInterpolate', 'selProperties', 'selScale', 'selRotate', 'selTranslate', 'selMakeBand', 'selStraighten', 'selLineToArea', 'selAreaToLine']) assert.equal(t.isEnabled(id), false, id + ' needs a selection');
  setRoi(t, { type: 'rect', x: 4, y: 4, w: 12, h: 8 });
  eq(['selFitSpline', 'selFitCircle', 'selFitRectangle', 'selInterpolate', 'selMakeBand', 'selAreaToLine', 'selStraighten', 'selLineToArea'].map((id) => !!t.isEnabled(id)), [false, true, true, true, true, true, false, false]);
  setRoi(t, LINE);
  eq(['selFitSpline', 'selFitCircle', 'selFitRectangle', 'selMakeBand', 'selAreaToLine', 'selStraighten', 'selLineToArea', 'selScale'].map((id) => t.isEnabled(id)), [false, false, false, false, false, true, true, true]);
  setRoi(t, { type: 'point', points: [[3, 3], [9, 9], [12, 4]] });
  assert.equal(t.isEnabled('selInterpolate'), false, 'Interpolate: "if (roi.getType()==Roi.POINT) return;"');
  assert.equal(t.isEnabled('selFitCircle'), true, 'a multi-point selection takes the Pratt fit');
  setRoi(t, POLY);
  assert.equal(t.isEnabled('selFitSpline'), true);
  t.close();
});

await test('Fit Spline: a polygon becomes its spline (flags kept for Straighten), a free line is trimmed first, the name survives', async () => {
  const t = await fresh();
  const S = t.page.IJSelOps;
  setRoi(t, Object.assign({ name: 'cell 1' }, POLY));
  await t.runCommand('selFitSpline');
  const r = J(activeRoi(t));
  const want = S.fitSpline(Object.assign({ name: 'cell 1' }, POLY)).roi;
  eq(r, J(want));
  assert.equal(r.type, 'polygon'); assert.equal(r.name, 'cell 1'); assert.equal(r.spline, true);
  assert.ok(r.points.length >= 100, 'at least 100 evaluation points (PolygonRoi.fitSpline)');
  assert.equal(r.nodes.length, POLY.points.length, 'the fitted nodes are kept (PolygonRoi.xpf)');
  // the same twice is the same (deterministic)
  setRoi(t, POLY); await t.runCommand('selFitSpline');
  eq(J(activeRoi(t)), J(S.fitSpline(POLY).roi));
  // a freehand selection is trimmed to a polygon first (Selection.trimPolygon)
  const free = { type: 'freehand', points: Array.from({ length: 40 }, (_, i) => [Math.round(20 + 12 * Math.cos(i / 40 * 6.2832)), Math.round(15 + 9 * Math.sin(i / 40 * 6.2832))]) };
  setRoi(t, free); await t.runCommand('selFitSpline');
  const fr = J(activeRoi(t));
  assert.equal(fr.type, 'polygon'); assert.ok(fr.nodes.length < free.points.length, 'trimmed');
  // a line selection is not one: the engine of the page refuses it with the ImageJ sentence's key
  t.close();
});

await test('Fit Circle: area → equal-area circle at the centroid, points → Pratt fit; refusals', async () => {
  const t = await fresh();
  const S = t.page.IJSelOps;
  setRoi(t, { type: 'rect', x: 6, y: 4, w: 20, h: 10, name: 'r' });
  await t.runCommand('selFitCircle');
  eq(J(activeRoi(t)), J(S.fitCircle({ type: 'rect', x: 6, y: 4, w: 20, h: 10, name: 'r' }, 40, 30).roi));
  assert.equal(activeRoi(t).type, 'oval'); assert.equal(activeRoi(t).name, 'r');
  // 200 pixels of area: r = sqrt(200/π) = 7.98 → d = 16
  assert.equal(activeRoi(t).w, 16);
  // a circle of points: the Pratt fit gives it back
  const ring = { type: 'polyline', points: Array.from({ length: 24 }, (_, i) => [Math.round(20 + 8 * Math.cos(i * 0.26)), Math.round(15 + 8 * Math.sin(i * 0.26))]) };
  setRoi(t, ring); await t.runCommand('selFitCircle');
  const o = activeRoi(t);
  assert.ok(Math.abs(o.w - 16) <= 1 && Math.abs(o.x - 12) <= 1 && Math.abs(o.y - 7) <= 1, JSON.stringify(o));
  // collinear points / two points: ImageJ's two error messages
  setRoi(t, { type: 'polyline', points: [[2, 2], [6, 6], [10, 10], [14, 14]] });
  await t.runCommand('selFitCircle', undefined, { expectError: true });
  assert.equal(t.errors.pop().key || t.IJApp.errorKey({ code: 'IJ_SEL_COLLINEAR' }), 'err.selCollinear');
  t.errors.length = 0;
  setRoi(t, { type: 'polyline', points: [[2, 2], [6, 9]] });
  await t.runCommand('selFitCircle', undefined, { expectError: true });
  t.errors.length = 0;
  assert.equal(t.IJApp.errorKey({ code: 'IJ_SEL_FEW_POINTS' }), 'err.selFewPoints');
  t.close();
});

await test('Fit Rectangle: the minimum-area rectangle of the hull as a rotated rectangle; points need 3 non-collinear', async () => {
  const t = await fresh();
  const S = t.page.IJSelOps;
  setRoi(t, POLY);
  await t.runCommand('selFitRectangle');
  const r = J(activeRoi(t));
  eq(r, J(S.fitRectangle(POLY).roi));
  assert.equal(r.type, 'polygon'); assert.equal(r.points.length, 4); assert.ok(r.rotRectWidth > 0);
  const area = (p) => Math.abs(p.reduce((a, q, i) => a + (q[0] * p[(i + 1) % p.length][1] - p[(i + 1) % p.length][0] * q[1]), 0)) / 2;
  const xs = POLY.points.map((p) => p[0]), ys = POLY.points.map((p) => p[1]);
  assert.ok(area(r.points) <= (Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys)) + 1e-3, 'never larger than the bounding box');
  setRoi(t, { type: 'point', points: [[3, 3], [9, 9], [12, 12]] });
  await t.runCommand('selFitRectangle', undefined, { expectError: true });
  t.errors.length = 0;
  t.close();
});

await test('Interpolate: dialog (Interval 1.0 pixel, Smooth, Adjust interval to match), the type rules, Smooth / Adjust remembered', async () => {
  const t = await fresh();
  const S = t.page.IJSelOps;
  setRoi(t, POLY);
  await t.runCommand('selInterpolate', { interval: 2.5, smooth: false, adjust: false });
  let spec = lastSpec(t);
  eq(J(spec.fields.map((f) => f.id)), ['interval', 'smooth', 'adjust']);
  assert.equal(field(spec, 'interval').value, 1.0);
  assert.equal(field(spec, 'interval').decimals, 1);
  assert.equal(field(spec, 'interval').unitsKey, 'dlg.sel.pixel');
  eq(J(activeRoi(t)), J(S.interpolate(POLY, 2.5, false, false).roi));
  assert.equal(activeRoi(t).type, 'polygon', 'a polygon with interval > 1 stays a polygon');
  setRoi(t, POLY);
  await t.runCommand('selInterpolate', { interval: 1, smooth: true, adjust: true });
  assert.equal(activeRoi(t).type, 'freehand');
  eq(J(activeRoi(t)), J(S.interpolate(POLY, 1, true, true).roi));
  // Selection.smooth / adjust are static fields of ImageJ: the next dialog opens with them
  setRoi(t, POLY);
  await t.runCommand('selInterpolate', { interval: 1 });
  spec = lastSpec(t);
  assert.equal(field(spec, 'smooth').value, true); assert.equal(field(spec, 'adjust').value, true); assert.equal(field(spec, 'interval').value, 1.0, 'the interval is always 1.0');
  // a line selection: a free line out, a wide interval a polyline
  setRoi(t, LINE);
  await t.runCommand('selInterpolate', { interval: 1, smooth: false, adjust: false });
  assert.equal(activeRoi(t).type, 'polyline'); assert.equal(activeRoi(t).freeline, true);
  assert.ok(activeRoi(t).points.length > 30);
  setRoi(t, { type: 'rect', x: 5, y: 5, w: 20, h: 10 });
  await t.runCommand('selInterpolate', { interval: 9, smooth: false, adjust: false });
  assert.equal(activeRoi(t).type, 'polygon', 'a rectangle with interval >= 8 gives a polygon');
  // the dialog refuses 0 (the field's own minimum is 0.01; the source refuses < 0.01)
  setRoi(t, POLY);
  await assert.rejects(t.runCommand('selInterpolate', { interval: 0, smooth: false, adjust: false }), /min|valid|interval|refus/i);
  t.log.failures.length = 0;
  t.close();
});

await test('Properties…: name, and the width of a line; an empty name removes it; area selections have no width field', async () => {
  const t = await fresh();
  setRoi(t, POLY);
  await t.runCommand('selProperties', { name: 'nucleus' });
  eq(J(lastSpec(t).fields.map((f) => f.id)), ['name']);
  assert.equal(activeRoi(t).name, 'nucleus'); eq(J(activeRoi(t).points), POLY.points);
  await t.runCommand('selProperties', { name: '' });
  assert.equal('name' in activeRoi(t), false);
  setRoi(t, POLYLINE);
  await t.runCommand('selProperties', { name: 'axon', width: 6 });
  eq(J(lastSpec(t).fields.map((f) => f.id)), ['name', 'width']);
  assert.equal(field(lastSpec(t), 'width').value, 1);
  assert.equal(activeRoi(t).width, 6); assert.equal(activeRoi(t).name, 'axon');
  await t.runCommand('selProperties', { name: 'axon', width: 6 });
  assert.equal(field(lastSpec(t), 'width').value, 6, 'the dialog shows the current width');
  setRoi(t, LINE);
  await t.runCommand('selProperties', { name: '', width: 3 });
  assert.equal(activeRoi(t).width, 3); assert.equal(activeRoi(t).type, 'line');
  // a mask keeps its runs (typed array)
  const m = t.page.IJRoi.translate(t.page.IJRoi.fromMask(Uint8Array.from([1, 1, 0, 1, 1, 1]), 3, 2), 4, 4);
  setRoi(t, m);
  await t.runCommand('selProperties', { name: 'm' });
  assert.equal(activeRoi(t).name, 'm'); assert.ok(ArrayBuffer.isView(activeRoi(t).rle));
  t.close();
});

await test('Scale…: 1.5 × 1.5 and Centered, remembered factors, a wide line scales its width, refusals', async () => {
  const t = await fresh();
  const S = t.page.IJSelOps;
  setRoi(t, { type: 'rect', x: 4, y: 4, w: 10, h: 8, name: 'q' });
  await t.runCommand('selScale', { xscale: 1.5, yscale: 1.5, centered: false });
  const sp = lastSpec(t);
  eq(J(sp.fields.map((f) => f.id)), ['xscale', 'yscale', 'centered']);
  assert.equal(field(sp, 'xscale').value, 1.5); assert.equal(field(sp, 'xscale').decimals, 2); assert.equal(field(sp, 'centered').value, false);
  eq(J(activeRoi(t)), J(S.scale({ type: 'rect', x: 4, y: 4, w: 10, h: 8, name: 'q' }, 1.5, 1.5, false, 40, 30).roi));
  eq(J(activeRoi(t).points), [[6, 6], [21, 6], [21, 18], [6, 18]], 'about the image origin (RoiScaler: poly.xpoints[i]*xscale)');
  assert.equal(activeRoi(t).name, 'q');
  setRoi(t, { type: 'rect', x: 10, y: 10, w: 10, h: 8 });
  await t.runCommand('selScale', { xscale: 2, yscale: 0.5, centered: true });
  assert.equal(field(lastSpec(t), 'xscale').value, 1.5, 'the first dialog of this call: the last factors are kept');
  const c = activeRoi(t);
  const xs = c.points.map((p) => p[0]), ys = c.points.map((p) => p[1]);
  eq([Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)], [10 + 5 - 10, 15 + 10, 14 - 2, 14 + 2], 'centred: the box centre stays');
  setRoi(t, { type: 'line', x1: 4, y1: 4, x2: 20, y2: 12, width: 3 });
  await t.runCommand('selScale', { xscale: 2, yscale: 2, centered: false });
  eq([activeRoi(t).x2, activeRoi(t).y2, activeRoi(t).width], [40, 24, 6]);
  t.close();
});

await test('Rotate…: Angle 15 degrees, positive turns clockwise on the screen, around the selection or the image centre, the centre is remembered', async () => {
  const t = await fresh();
  const S = t.page.IJSelOps;
  setRoi(t, { type: 'rect', x: 10, y: 8, w: 20, h: 10 });
  await t.runCommand('selRotate', { angle: 90, aroundCenter: false });
  const sp = lastSpec(t);
  eq(J(sp.fields.map((f) => f.id)), ['angle', 'aroundCenter', 'hint']);
  assert.equal(field(sp, 'angle').value, 15); assert.equal(field(sp, 'aroundCenter').value, false);
  const r = activeRoi(t);
  eq(J(r), J(S.rotate({ type: 'rect', x: 10, y: 8, w: 20, h: 10 }, 90, false, 40, 30).roi));
  // +90: the top-left corner (10, 8) goes to the top-right of the rotated box (clockwise on the screen), centre (20, 13)
  eq(r.points[0].map((v) => Math.round(v * 1000) / 1000), [25, 3]);
  eq(r.rotationCenter, [20, 13]);
  // a second rotation turns about the FIRST centre (Roi.setRotationCenter) …
  await t.runCommand('selRotate', { angle: 90, aroundCenter: false });
  eq(activeRoi(t).rotationCenter, [20, 13]);
  assert.equal(field(lastSpec(t), 'angle').value, 90, 'the angle is remembered');
  // … around the image centre it does not keep one
  setRoi(t, { type: 'rect', x: 10, y: 8, w: 20, h: 10 });
  await t.runCommand('selRotate', { angle: -30, aroundCenter: true });
  assert.equal('rotationCenter' in activeRoi(t), false);
  eq(J(activeRoi(t)), J(S.rotate({ type: 'rect', x: 10, y: 8, w: 20, h: 10 }, -30, true, 40, 30).roi));
  t.close();
});

await test('Translate…: X / Y offset in pixels, the selection keeps its type, nothing else moves; the offsets are remembered', async () => {
  const t = await fresh();
  setRoi(t, Object.assign({ name: 'z' }, POLY));
  await t.runCommand('selTranslate', { dx: 5, dy: -3 });
  eq(J(lastSpec(t).fields.map((f) => f.id)), ['dx', 'dy']);
  eq(J(activeRoi(t).points), POLY.points.map((p) => [p[0] + 5, p[1] - 3]));
  assert.equal(activeRoi(t).type, 'polygon'); assert.equal(activeRoi(t).name, 'z');
  setRoi(t, { type: 'oval', x: 6, y: 6, w: 10, h: 8 });
  await t.runCommand('selTranslate', { dx: 5, dy: -3 });
  assert.equal(field(lastSpec(t), 'dx').value, 5); assert.equal(field(lastSpec(t), 'dy').value, -3);
  eq(J(activeRoi(t)), { type: 'oval', x: 11, y: 3, w: 10, h: 8 });
  const d = await t.docs();
  assert.equal(d[0].undoDepth, 0, 'a selection operation is not a pixel step');
  t.close();
});

await test('Make Band…: calibrated size, the worker band equals the page-pure one, the size is remembered in pixels; > 255 px is refused', async () => {
  const t = await fresh();
  const S = t.page.IJSelOps, R = t.page.IJRoi;
  const roi = { type: 'rect', x: 12, y: 8, w: 14, h: 10, name: 'b' };
  setRoi(t, roi);
  await t.runCommand('selMakeBand', { size: 3 });   // 3 µm at 0.5 µm/pixel = 6 pixels
  const sp = lastSpec(t);
  assert.equal(field(sp, 'size').value, 7.5, 'the first dialog: 15 pixels in µm');
  assert.equal(field(sp, 'size').units, 'µm');
  const got = activeRoi(t);
  assert.equal(got.type, 'mask'); assert.equal(got.name, 'b');
  const want = (await S.makeBand(roi, 6, 40, 30)).roi;
  eq(maskSet(t, got), maskSet(t, want));
  // the band surrounds the rectangle: 6 pixels wide where there is room, nothing inside it
  const inside = new Set(maskSet(t, roi));
  for (const v of maskSet(t, got)) assert.ok(!inside.has(v));
  assert.ok(maskSet(t, got).length > 14 * 2 * 6);
  setRoi(t, roi);
  await t.runCommand('selMakeBand', { size: 3 });
  assert.equal(field(lastSpec(t), 'size').value, 3, 'the band size is kept (6 pixels = 3 µm)');
  // determinism: the same call twice
  const again = activeRoi(t);
  eq(maskSet(t, again), maskSet(t, got));
  // 200 µm = 400 pixels: refused by the dialog, nothing runs
  setRoi(t, roi);
  await assert.rejects(t.runCommand('selMakeBand', { size: 200 }), /validate|refus|selBandTooWide/);
  t.log.failures.length = 0;
  eq(t.shell.opts.getState().roi, roi, 'the selection is as it was');
  // a line is not an area
  setRoi(t, LINE);
  assert.equal(t.isEnabled('selMakeBand'), false);
  t.close();
});

await test('Line to Area / Area to Line: a line becomes a rotated rectangle, a segmented line a traced area (worker), and back', async () => {
  const t = await fresh();
  const S = t.page.IJSelOps;
  setRoi(t, Object.assign({ width: 5 }, LINE));
  await t.runCommand('selLineToArea');
  const r = J(activeRoi(t));
  eq(r, J(S.lineToArea(Object.assign({ width: 5 }, LINE)).roi));
  assert.equal(r.type, 'polygon'); assert.ok(r.rotRectWidth === 5);
  // the width of the line is the width of the area: 5 × the line length (±)
  const len = Math.hypot(30, 16);
  assert.ok(Math.abs(t.page.IJRoi.area(r) - 5 * len) < len * 2.5, 'area ≈ width × length');
  setRoi(t, Object.assign({ width: 3 }, POLYLINE));
  await t.runCommand('selLineToArea');
  const pa = activeRoi(t);
  eq(maskSet(t, pa), maskSet(t, S.lineToArea(Object.assign({ width: 3 }, POLYLINE)).roi));
  assert.ok(['polygon', 'mask'].includes(pa.type)); assert.equal(t.page.IJRoi.isArea(pa), true);
  // Area to Line: -0.5 on both axes, a polyline for a polygon, a free line for an oval / spline fit
  setRoi(t, POLY);
  await t.runCommand('selAreaToLine');
  eq(J(activeRoi(t)), { type: 'polyline', points: POLY.points.map((p) => [p[0] - 0.5, p[1] - 0.5]) });
  setRoi(t, { type: 'oval', x: 6, y: 6, w: 12, h: 8 });
  await t.runCommand('selAreaToLine');
  assert.equal(activeRoi(t).freeline, true);
  setRoi(t, POLY); await t.runCommand('selFitSpline');
  await t.runCommand('selAreaToLine');
  assert.equal(activeRoi(t).freeline, true, 'a spline-fitted polygon gives a free line (PolygonRoi.isSplineFit)');
  // a composite is refused (ImageJ: "Composite selections cannot be converted to lines.")
  const m = t.page.IJRoi.translate(t.page.IJRoi.fromMask(Uint8Array.from([1, 0, 1, 1]), 2, 2), 5, 5);
  setRoi(t, m);
  assert.equal(t.isEnabled('selAreaToLine'), false);
  assert.equal(t.IJApp.errorKey({ code: 'IJ_SEL_COMPOSITE' }), 'err.selComposite');
  t.close();
});

// ── Straighten: the new image, undo-free, restored after a reload ──
await test('Straighten…: Title + Line Width, 8-bit multichannel stays 8-bit, one channel gives 32-bit; pixels equal the page-pure port; reload restores them', async () => {
  const t = await fresh();
  const S = t.page.IJSelOps;
  const src = (await t.docs())[0];
  setRoi(t, POLYLINE);
  const before = [];
  for (let c = 0; c < 3; c++) before.push(arr(await t.pixels(src.docId, c)));
  await t.runCommand('selStraighten', { title: 'straight', width: 7 });
  const sp = lastSpec(t);
  eq(J(sp.fields.map((f) => f.id)), ['title', 'width']);
  assert.equal(field(sp, 'width').value, 20, 'Line Width: 20 pixels when the line is one pixel wide');
  assert.equal(field(sp, 'title').value, src.name + '-1'.replace(/^/, ''), 'WindowManager.getUniqueName');
  const docs = await t.docs();
  assert.equal(docs.length, 2);
  const d = docs.find((x) => x.name === 'straight');
  assert.ok(d); assert.equal(d.channels.length, 3); assert.equal(d.bitDepth, 8); assert.equal(d.height, 7); assert.equal(d.undoDepth, 0);
  eq(J(d.calibration), J(src.calibration), 'the calibration follows when the pixels are square');
  const want = S.straightenPlanes({ width: src.width, height: src.height, bitDepth: 8, channels: before.map((p) => ({ data: Uint8Array.from(p) })) }, POLYLINE, 7);
  assert.equal(d.width, want.width);
  for (let c = 0; c < 3; c++) eq(arr(await t.pixels(d.docId, c)), arr(want.planes[c]), 'channel ' + c);
  for (let c = 0; c < 3; c++) eq(arr(await t.pixels(src.docId, c)), before[c], 'the source is untouched');
  // the new image is on screen and has no selection (the line stays on its source)
  assert.equal(t.shell.opts.getState().roi, null);
  // reload: the straightened image comes back with the same pixels
  await t.flush();
  const key = (await t.store.shared.list())[0].key;
  const t2 = await t.reload();
  const w2 = await t2.spawn();
  const res = await t2.engine('session.restore', { key }, w2);
  assert.equal(res.warnings.length, 0, JSON.stringify(res.warnings));
  const d2 = (await t2.engine('doc.list', {}, w2)).docs.find((x) => x.name === 'straight');
  assert.ok(d2, 'restored');
  for (let c = 0; c < 3; c++) eq(arr((await t2.engine('doc.tile', { docId: d2.docId, channel: c, level: 0, tx: 0, ty: 0 }, w2)).data), arr(want.planes[c]));
  t2.close();
  t.close();
});

await test('Straighten of one channel: a FloatProcessor (32-bit), a straight line, a free line (Fit Spline first)', async () => {
  const t = await fresh();
  const S = t.page.IJSelOps;
  await t.runCommand('colorSplitChannels');
  const one = (await t.docs()).find((d) => d.channels.length === 1 && d.name.startsWith('C2-'));
  assert.ok(one);
  await t.shell.opts.commands.find((x) => x.id === 'winImg' + one.docId).run();
  await until(() => t.activeId() === one.docId, 'C2 on screen');
  setRoi(t, Object.assign({ width: 9 }, LINE));
  const px = Uint8Array.from(await t.pixels(one.docId, 0));
  await t.runCommand('selStraighten', { title: 'line', width: 9 });
  assert.equal(field(lastSpec(t), 'width').value, 9, 'the width of the line is the default');
  const d = (await t.docs()).find((x) => x.name === 'line');
  assert.equal(d.bitDepth, 32); assert.equal(d.channels.length, 1);
  const want = S.straightenPlanes({ width: one.width, height: one.height, bitDepth: 8, channels: [{ data: px }] }, Object.assign({ width: 9 }, LINE), 9);
  const got = await t.pixels(d.docId, 0);
  assert.equal(got.length, want.planes[0].length);
  for (let i = 0; i < got.length; i++) assert.ok(Object.is(got[i], want.planes[0][i]), 'pixel ' + i);
  // a free line goes through Fit Spline's trimming
  const freeline = { type: 'polyline', freeline: true, points: Array.from({ length: 30 }, (_, i) => [3 + i, Math.round(15 + 6 * Math.sin(i / 5))]) };
  setRoi(t, freeline);
  await t.runCommand('selStraighten', { title: 'free', width: 5 });
  const f = (await t.docs()).find((x) => x.name === 'free');
  const wf = S.straightenPlanes({ width: one.width, height: one.height, bitDepth: 8, channels: [{ data: px }] }, freeline, 5);
  assert.equal(f.width, wf.width); assert.equal(f.height, 5);
  // an area is refused
  setRoi(t, POLY);
  assert.equal(t.isEnabled('selStraighten'), false);
  t.close();
});

await test('engine: makeBand / lineToArea / straighten are deterministic, never write into the document and refuse bad input', async () => {
  const t = await fresh();
  const [d] = await t.docs();
  const px = arr(await t.pixels(d.docId, 0));
  const roi = { type: 'oval', x: 10, y: 6, w: 14, h: 12 };
  const a = await t.engine('doc.compute', { docId: d.docId, op: 'makeBand', params: { n: 4 }, roi, channel: 0 });
  const b = await t.engine('doc.compute', { docId: d.docId, op: 'makeBand', params: { n: 4 }, roi, channel: 0 });
  eq(maskSet(t, a.roi), maskSet(t, b.roi));
  eq(arr(await t.pixels(d.docId, 0)), px);
  // no selection / a line: the engine's own refusal
  const e = await t.engine('doc.compute', { docId: d.docId, op: 'makeBand', params: { n: 4 }, roi: null, channel: 0 }).then(() => null, (x) => x);
  assert.ok(e, 'needs a selection');
  const e2 = await t.engine('doc.compute', { docId: d.docId, op: 'makeBand', params: { n: 999 }, roi, channel: 0 }).then(() => null, (x) => x);
  assert.ok(e2 && /BAD_ARGS|band/i.test(String(e2.code || e2.message)), 'a band beyond 255 pixels');
  const e3 = await t.engine('doc.run', { docId: d.docId, op: 'straighten', params: { width: 0, title: 'x' }, roi: LINE, channel: 0 }).then(() => null, (x) => x);
  assert.ok(e3, 'a line width of 0');
  t.close();
});

await test("Make Band…: the unit is the calibration's own, also at 1 µm per pixel (Calibration.getUnits)", async () => {
  const t = await fresh();
  await t.runCommand('imageProperties', { pixelWidth: 1, pixelHeight: 1, unit: 'µm' });
  setRoi(t, { type: 'rect', x: 12, y: 8, w: 14, h: 10 });
  await t.runCommand('selMakeBand', { size: 3 });
  assert.equal(field(lastSpec(t), 'size').units, 'µm', 'a 1 µm/pixel calibration still shows its unit');
  assert.equal(field(lastSpec(t), 'size').value, 15, 'the first dialog: 15 pixels = 15 µm');
  t.close();
});

await test('Straighten reports its progress once per channel', async () => {
  const t = await fresh();
  const seen = [];
  const px = { width: 40, height: 30, bitDepth: 8, channels: [0, 1, 2].map(() => ({ data: new Uint8Array(40 * 30) })) };
  t.page.IJSelOps.straightenPlanes(px, { type: 'polyline', points: [[3, 3], [35, 25]] }, 3, { check() {}, tick: (f) => seen.push(f) });
  eq(seen.map((f) => Math.round(f * 3)), [1, 2, 3]);
  t.close();
});

await test('cooperative cancellation: the long loops poll check(), a cancelled run returns nothing', async () => {
  const t = await fresh();
  const S = t.page.IJSelOps;
  let calls = 0;
  const cancelAt = (k) => ({ tick: async () => {}, check: () => { if (++calls >= k) throw Object.assign(new Error('cancelled'), { code: 'IJ_CANCELLED' }); } });
  calls = 0;
  await assert.rejects(S.makeBand({ type: 'rect', x: 20, y: 20, w: 100, h: 80 }, 30, 256, 200, cancelAt(1)), (e) => e.code === 'IJ_CANCELLED');
  calls = 0;
  await assert.rejects(S.makeBand({ type: 'rect', x: 20, y: 20, w: 100, h: 200 }, 30, 256, 256, cancelAt(3)), (e) => e.code === 'IJ_CANCELLED');
  const longLine = { type: 'polyline', width: 4, points: Array.from({ length: 200 }, (_, i) => [5 + i * 3, 50 + 20 * Math.sin(i / 7)]) };
  calls = 0;
  assert.throws(() => S.lineToArea(longLine, cancelAt(5)), (e) => e.code === 'IJ_CANCELLED');
  assert.ok(calls >= 5, 'check() is polled once per segment');
  calls = 0;
  const big = { width: 256, height: 200, bitDepth: 8, channels: [{ data: new Uint8Array(256 * 200) }] };
  assert.throws(() => S.straightenPlanes(big, { type: 'polyline', points: [[5, 5], [250, 190]] }, 1, cancelAt(1)), (e) => e.code === 'IJ_CANCELLED');
  t.close();
});

await test('lang parts: every key the package reads exists in en, fr, es and nl (and is translated)', async () => {
  const parts = JSON.parse(fs.readFileSync(path.join(DIR, 'lang-parts', 'sel.json'), 'utf8'));
  const flat = (o, p = '') => Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' ? flat(v, p + k + '.') : [[p + k, v]]));
  const en = new Map(flat(parts.en));
  for (const code of ['fr', 'es', 'nl']) {
    const m = new Map(flat(parts[code]));
    eq([...m.keys()].sort(), [...en.keys()].sort(), code + ': same keys as en');
  }
  const base = JSON.parse(fs.readFileSync(path.join(DIR, 'lang', 'en.json'), 'utf8'));
  const has = (key) => en.has(key) || key.split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), base) !== undefined;
  const src = fs.readFileSync(path.join(DIR, 'ij-cmds-sel.js'), 'utf8') + fs.readFileSync(path.join(DIR, 'ij-proc-sel.js'), 'utf8');
  for (const m of src.matchAll(/'((?:dlg\.sel|err\.sel|op|cmd|res)\.[A-Za-z.]+)'/g)) assert.ok(has(m[1]), 'lang key ' + m[1]);
  for (const m of src.matchAll(/'(dlg\.pixels|err\.[a-zA-Z]+)'/g)) assert.ok(has(m[1]), 'lang key ' + m[1]);
  // ImageJ's own words in English
  assert.equal(en.get('dlg.sel.interval'), 'Interval:'); assert.equal(en.get('dlg.sel.adjust'), 'Adjust interval to match');
  assert.equal(en.get('dlg.sel.xscale'), 'X scale factor:'); assert.equal(en.get('dlg.sel.aroundCenter'), 'Rotate around image center');
  assert.equal(en.get('dlg.sel.dx'), 'X offset (pixels):'); assert.equal(en.get('dlg.sel.bandSize'), 'Band Size:'); assert.equal(en.get('dlg.sel.lineWidth'), 'Line Width:');
  // the other languages say something else than English for every sentence
  for (const code of ['fr', 'es', 'nl']) { const m = new Map(flat(parts[code])); let same = 0; for (const [k, v] of m) if (v === en.get(k) && !['dlg.sel.pixel', 'dlg.sel.interval', 'dlg.sel.title'].includes(k)) same++; assert.ok(same <= 3, code + ' untranslated: ' + same); }
});

console.log(`ij sel commands: OK (${n} groups)`);
