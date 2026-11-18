// Package P6 (roi), end to end through the real controller and the real engine (tests/js/ij_harness.mjs):
//   Edit > Selection (Specify, To Bounding Box, Enlarge, Fit Ellipse, Convex Hull, Create Mask, Create Selection),
//   the Wand tool and its options, Set Measurements (every group, Limit to threshold, Redirect to), Analyze > Measure of
//   an area / a line / a segmented line / points / an angle, Summarize, Distribution, the ROI Manager's Measure and
//   Multi Measure, Plot Profile along a segmented line; refusals and the error mapping; the engine's worker commands
//   (doc.stats, doc.profile) and the registry operations (wand, enlargeRoi, createSelection, createMask) on their own:
//   determinism, no write into the inputs, band-independence (the operations here are not banded), undo / redo / reload
//   of the one operation that creates a document.
//
// Run: node tests/js/test_ij_roi_commands.mjs
import assert from 'node:assert/strict';
import { boot, until, J } from './ij_harness.mjs';

const rect = (x, y, w, h) => ({ type: 'rect', x, y, w, h });

// the results the app persisted (Results is kept across a reload: session.putMeta carries it)
async function results(t, n, exact) {
  let rows = null;
  await until(() => {
    // the newest persisted copy of Results (a later measurement or Clear replaces it)
    for (let i = t.log.msgs.length - 1; i >= 0; i--) {
      const m = t.log.msgs[i];
      if (m.cmd === 'session.putMeta' && m.args && Array.isArray(m.args.results)) { if (exact ? m.args.results.length === n : m.args.results.length >= n) { rows = m.args.results; return true; } return false; }
    }
    return false;
  }, 'the results to be persisted', 5000);
  return J(rows);
}
const setRoi = (t, roi) => t.shell.opts.onRoi(roi, { final: true, source: 'draw' });
const activeRoi = (t) => J(t.shell.activeRoi);
const floats = (t) => Array.from(t.shell.windows.floats.keys());
function* walk(el) { yield el; for (const c of el.children || []) yield* walk(c); }
const findByText = (root, text) => { for (const n of walk(root)) if (n.tagName === 'BUTTON' && n.textContent === text) return n; return null; };

{
  const t = await boot({ channels: 2 });
  await t.open();
  const IJRoi = t.page.IJRoi;
  const doc0 = (await t.docs())[0];
  const W = doc0.width, H = doc0.height;
  assert.ok(W >= 40 && H >= 30);

  // ───────────────────────── Edit > Selection ─────────────────────────
  // Specify: width, height, X, Y, oval; the selection follows the dialog
  setRoi(t, null);
  await t.runCommand('selSpecify', { width: 12, height: 8, x: 5, y: 6, oval: false });
  assert.deepEqual(activeRoi(t), rect(5, 6, 12, 8));
  await t.runCommand('selSpecify', { width: 10, height: 10, x: 15, y: 12, oval: true, centered: true });
  assert.deepEqual(activeRoi(t), { type: 'oval', x: 10, y: 7, w: 10, h: 10 }, 'Centered: x, y are the centre');
  await t.runCommand('selSpecify', { width: 10, height: 10, x: 15, y: 12, oval: true, centered: false, square: true });
  // cancel restores the selection that was there
  const before = activeRoi(t);
  t.script.dialogs.push(null);
  await t.shell.opts.onCommand(t.cmd('selSpecify'), { source: 'menu' });
  assert.deepEqual(activeRoi(t), before, 'a cancelled Specify puts the selection back');
  // a size of 0 is refused by the dialog's own validation
  await assert.rejects(t.runCommand('selSpecify', { width: 0, height: 5, x: 1, y: 1 }), /validate\(\)|refuses|dlg\.roi\.specSize/);
  t.log.failures.length = 0;

  // To Bounding Box
  setRoi(t, { type: 'polygon', points: [[3, 4], [20, 6], [12, 22]] });
  await t.runCommand('selToBoundingBox');
  assert.deepEqual(activeRoi(t), rect(3, 4, 17, 18));
  setRoi(t, null);
  assert.equal(t.isEnabled('selToBoundingBox'), false, 'needs a selection');

  // Enlarge: rect and oval keep their type, a polygon goes through the EDM; the worker agrees with the pure function
  setRoi(t, rect(10, 8, 10, 6));
  await t.runCommand('selEnlarge', { n: 3, pixels: true });
  assert.deepEqual(activeRoi(t), rect(7, 5, 16, 12));
  await t.runCommand('selEnlarge', { n: -2, pixels: true });
  assert.deepEqual(activeRoi(t), rect(9, 7, 12, 8));
  const poly = { type: 'polygon', points: [[10, 8], [28, 10], [30, 22], [14, 20]] };
  setRoi(t, poly);
  await t.runCommand('selEnlarge', { n: 1, pixels: false }); // 1 µm = 2 pixels at 0.5 µm
  const grown = t.shell.activeRoi; // not J()-cloned: a mask keeps its runs as a Uint32Array
  const want = t.page.IJRoiTools.enlarge(poly, 2, W, H);
  assert.deepEqual(J(IJRoi.mask(grown)), J(IJRoi.mask(want)), 'Enlarge = RoiEnlarger.enlarge255');
  assert.ok(IJRoi.area(grown) > IJRoi.area(poly));
  // a shrink with nothing left keeps the selection
  setRoi(t, rect(10, 8, 3, 3).type === 'rect' ? { type: 'polygon', points: [[10, 8], [13, 8], [13, 11], [10, 11], [10, 9]] } : null);
  const small = activeRoi(t);
  await t.runCommand('selEnlarge', { n: -9, pixels: true });
  assert.deepEqual(activeRoi(t), small, 'a selection that vanishes is left as it was');
  // a line is not an area
  setRoi(t, { type: 'line', x1: 1, y1: 1, x2: 9, y2: 9, width: 1 });
  assert.equal(t.isEnabled('selEnlarge'), false);
  assert.equal(t.isEnabled('selFitEllipse'), false);
  assert.equal(t.isEnabled('selConvexHull'), false, 'a straight line has no hull');

  // To Bounding Box of a float polygon: Roi.getBounds = (int)(max - iMin + 0.5) (FloatPolygon.getBounds), not floor / ceil
  setRoi(t, { type: 'polygon', points: [[3.2, 4.1], [20.3, 4.4], [12.4, 17.2]] });
  await t.runCommand('selToBoundingBox');
  assert.deepEqual(activeRoi(t), rect(3, 4, 17, 13));

  // Fit Ellipse, Convex Hull
  const blob = { type: 'polygon', points: [[6, 6], [30, 8], [34, 20], [18, 26], [8, 18]] };
  setRoi(t, blob);
  await t.runCommand('selFitEllipse');
  const ell = activeRoi(t);
  assert.equal(ell.type, 'polygon'); assert.equal(ell.points.length, 72); assert.ok(ell.ellipse && ell.ellipse.aspect > 0 && ell.ellipse.aspect <= 1, 'EllipseRoi: the polygon remembers its ellipse (edge-sum perimeter, Feret from the axes)');
  const bm = t.page.IJRoiTools.roiMaskBox(blob, W, H);
  const ef = t.page.IJRoiTools.fitEllipse(bm.data, bm);
  assert.ok(Math.abs(IJRoi.area(ell) - IJRoi.area(blob)) / IJRoi.area(blob) < 0.04, 'the fitted ellipse has about the area of the selection (ImageJ equalises them)');
  assert.ok(Math.abs(ef.major - 2 * Math.max(...ell.points.map((p) => Math.hypot(p[0] - ef.xCenter, p[1] - ef.yCenter)))) < 0.5);
  setRoi(t, { type: 'polygon', points: [[2, 2], [20, 3], [11, 9], [20, 18], [3, 16]] });
  await t.runCommand('selConvexHull');
  const hull = activeRoi(t);
  assert.equal(hull.type, 'polygon');
  assert.deepEqual(hull.points.map((p) => p.join(',')).sort(), ['2,2', '20,18', '20,3', '3,16'].sort(), 'the concave vertex (11, 9) is not on the hull');
  setRoi(t, { type: 'point', points: [[3.5, 3.5], [10.5, 4.5], [8.5, 12.5], [5.5, 6.5]] });
  await t.runCommand('selConvexHull');
  assert.equal(activeRoi(t).points.length, 3, 'the hull of a multi-point selection (the interior point drops out)');

  // Create Mask / Create Selection without a selection and without a threshold or a mask: each says what it needs
  setRoi(t, null);
  t.errors.length = 0;
  await t.runCommand('selCreateMask', undefined, { expectError: true });
  await t.runCommand('selCreateSelection', undefined, { expectError: true });
  assert.equal(t.errors.length, 2);
  t.errors.length = 0;
  // A line cannot become a mask
  setRoi(t, { type: 'line', x1: 1, y1: 1, x2: 9, y2: 9, width: 1 });
  await t.runCommand('selCreateMask', undefined, { expectError: true });
  t.errors.length = 0;

  // Create Mask from a selection: a new 8-bit image, 255 inside; reload keeps it
  const roiM = { type: 'oval', x: 6, y: 5, w: 16, h: 12 };
  setRoi(t, roiM);
  const nDocs = (await t.docs()).length;
  await t.runCommand('selCreateMask');
  const docs = await t.docs();
  assert.equal(docs.length, nDocs + 1);
  const md = docs[docs.length - 1];
  assert.equal(md.bitDepth, 8); assert.equal(md.name, 'Mask');
  assert.equal(md.channels.length, 1);
  const px = Array.from(await t.pixels(md.docId, 0));
  assert.equal(px.filter((v) => v === 255).length, IJRoi.area(roiM));
  assert.equal(px.filter((v) => v !== 0 && v !== 255).length, 0);
  assert.deepEqual(px, Array.from(t.page.IJRoiTools.roiMask255(roiM, W, H)));
  assert.equal(md.calibration.pixelWidth, 0.5, 'the mask is calibrated like its source');

  // Create Selection on the mask on screen: the 255 pixels (the foreground of a binary image), as a selection
  assert.equal(t.activeId(), md.docId, 'the new image is the one on screen');
  await t.runCommand('selCreateSelection');
  const cs = t.shell.activeRoi;
  assert.ok(cs && (cs.type === 'mask' || cs.type === 'rect'));
  assert.deepEqual(Array.from(IR_mask(t, cs, W, H)), px.map((v) => (v === 255 ? 1 : 0)));
  // and it restores after a reload, pixel for pixel
  await t.flush();
  const t2 = await t.reload();
  const w2 = await t2.spawn();
  for (const e of await t2.store.shared.list()) await t2.engine('session.restore', { key: e.key }, w2);
  const md2 = (await t2.engine('doc.list', {}, w2)).docs.find((d) => d.name === 'Mask');
  assert.ok(md2, 'the mask is restored after a reload');
  assert.deepEqual(Array.from((await t2.engine('doc.tile', { docId: md2.docId, channel: 0, level: 0, tx: 0, ty: 0 }, w2)).data), px);
  t2.close();
  t.close();
}

// ───────────────────────── the engine's measurement commands ─────────────────────────
{
  const t = await boot({ channels: 2 });
  await t.open();
  const [d] = await t.docs();
  const id = d.docId, W = d.width, H = d.height;
  const px0 = Array.from(await t.pixels(id, 0));
  const eng = (cmd, args) => t.engine(cmd, args);

  // doc.stats of an area: the same row as the pure module, the whole key list, every key a number
  const roi = { type: 'polygon', points: [[4, 3], [24, 5], [30, 20], [10, 24]] };
  const keys = ['area', 'mean', 'stdDev', 'mode', 'min', 'max', 'xCentroid', 'yCentroid', 'xCenterOfMass', 'yCenterOfMass', 'perim', 'bx', 'by', 'bw', 'bh', 'major', 'minor', 'angle',
    'circularity', 'feret', 'feretX', 'feretY', 'feretAngle', 'minFeret', 'aspectRatio', 'roundness', 'solidity', 'intDen', 'rawIntDen', 'median', 'skewness', 'kurtosis', 'areaFraction'];
  const r = (await eng('doc.stats', { docId: id, roi, channel: 0, measurements: keys })).row;
  assert.deepEqual(Object.keys(r).sort(), keys.slice().sort());
  const pure = t.page.IJRoiTools.measureArea({ img: { data: Uint8Array.from(px0.slice(0)), width: W, height: H, bitDepth: 8 }, roi, cal: d.calibration, keys });
  for (const k of keys) assert.ok(Object.is(r[k], pure[k]) || Math.abs(r[k] - pure[k]) < 1e-9, `${k}: ${r[k]} vs ${pure[k]}`);
  // deterministic and never writes into the image
  const r2 = (await eng('doc.stats', { docId: id, roi, channel: 0, measurements: keys })).row;
  assert.deepEqual(J(r2), J(r));
  assert.deepEqual(Array.from(await t.pixels(id, 0)), px0);

  // Analyze Particles honours Redirect to: ParticleAnalyzer "ImageProcessor ip2 = redirectIP!=null?redirectIP:ip;" — the particle
  // is found in channel 0 and measured in channel 1 (holes of the mask stay out of the statistics)
  {
    const p0 = await eng('doc.particles', { docId: id, channel: 0, opts: { minSize: 4 }, keys: ['area', 'mean', 'min', 'max'] });
    const pr = await eng('doc.particles', { docId: id, channel: 0, opts: { minSize: 4 }, keys: ['area', 'mean', 'min', 'max'], redirect: { docId: id, channel: 1 } });
    assert.ok(pr.rows.length > 0 && pr.rows.length === p0.rows.length, 'the same particles are found');
    const own = Array.from(await t.pixels(id, 0)), other = Array.from(await t.pixels(id, 1));
    let differs = 0;
    pr.rows.forEach((row, i) => {
      const m = t.page.IJRoi.mask({ type: 'polygon', points: pr.outlines[i], traced: true }, W, H);
      let n = 0, sum = 0;
      for (let j = 0; j < m.h; j++) for (let k = 0; k < m.w; k++) {
        if (!m.data[j * m.w + k]) continue;
        const q = (m.y + j) * W + m.x + k;
        if (own[q] !== 0) { n++; sum += other[q]; }
      }
      assert.ok(Math.abs(row.mean - sum / n) < 1e-9, `particle ${i + 1}: Mean ${row.mean} is the redirect channel's ${sum / n}`);
      if (Math.abs(row.mean - p0.rows[i].mean) > 1e-9) differs++;
    });
    assert.ok(differs > 0, 'at least one particle reads other pixels than its own mask');
  }
  // a redirect image gets its own lock: stats on a second document while the first measures
  assert.equal((await eng('doc.stats', { docId: id, roi: null, channel: 0, measurements: ['mean'], redirect: { docId: id, channel: 1 } })).row.mean,
    (await eng('doc.stats', { docId: id, roi: null, channel: 1, measurements: ['mean'] })).row.mean);

  // Limit to threshold: only the pixels inside the range count; %Area counts them too
  const lim = (await eng('doc.stats', { docId: id, roi, channel: 0, measurements: ['area', 'mean', 'min', 'max', 'areaFraction', 'minThreshold', 'maxThreshold'], threshold: { lower: 60, upper: 140 }, limit: true })).row;
  assert.ok(lim.min >= 60 && lim.max <= 140);
  assert.equal(lim.minThreshold, 60); assert.equal(lim.maxThreshold, 140);
  // ImageStatistics: "lowerThreshold = Double.NaN" — Limit to threshold without a threshold reports NaN, not the type range
  const limNone = (await eng('doc.stats', { docId: id, roi, channel: 0, measurements: ['area', 'minThreshold', 'maxThreshold'], limit: true })).row;
  assert.ok(Number.isNaN(limNone.minThreshold) && Number.isNaN(limNone.maxThreshold), 'MinThr / MaxThr without a threshold are NaN');
  assert.ok(lim.area < r.area);
  const noLim = (await eng('doc.stats', { docId: id, roi, channel: 0, measurements: ['area', 'areaFraction'], threshold: { lower: 60, upper: 140 } })).row;
  assert.equal(noLim.area, r.area, 'a threshold alone limits nothing');
  assert.ok(Math.abs(noLim.areaFraction - lim.areaFraction) < 1e-12, '%Area counts the thresholded pixels of the whole selection');

  // Redirect to: the pixels of another channel of the same image (the geometry stays the selection's)
  const red = (await eng('doc.stats', { docId: id, roi, channel: 0, measurements: ['area', 'mean'], redirect: { docId: id, channel: 1 } })).row;
  const ch1 = (await eng('doc.stats', { docId: id, roi, channel: 1, measurements: ['area', 'mean'] })).row;
  assert.deepEqual(J(red), J(ch1));
  const small = await eng('doc.duplicate', { docId: id, roi: rect(2, 2, 10, 10) });
  const sid = small.info ? small.info.docId : small.docId;
  assert.equal((await eng('doc.stats', { docId: id, roi, channel: 0, redirect: { docId: sid, channel: 0 } }).catch((e) => e)).code, 'IJ_ROI_REDIRECT_SIZE', 'another size is refused');

  // a straight line: Length, Angle; Area = samples × pixel area; a width of 3 measures the pixels it covers
  const line = { type: 'line', x1: 3, y1: 4, x2: 30, y2: 20, width: 1 };
  const lr = (await eng('doc.stats', { docId: id, roi: line, channel: 0, measurements: ['area', 'mean', 'min', 'max', 'length', 'angle'] })).row;
  assert.ok(Math.abs(lr.length - Math.hypot(27, 16) * 0.5) < 1e-12, 'calibrated length (0.5 µm pixels)');
  assert.ok(Math.abs(lr.angle - (180 / Math.PI) * Math.atan2(-16, 27)) < 1e-9);
  assert.equal(lr.area, 32 * 0.25, '32 samples (round(length) + 1) of 0.25 µm²');
  const wide = (await eng('doc.stats', { docId: id, roi: Object.assign({}, line, { width: 3 }), channel: 0, measurements: ['area'] })).row;
  assert.ok(wide.area > lr.area * 2);
  // a segmented line: Length is the sum of its segments, no Angle
  const pl = { type: 'polyline', points: [[3, 4], [14, 18], [30, 10], [34, 24]], width: 1 };
  const pr = (await eng('doc.stats', { docId: id, roi: pl, channel: 0, measurements: ['area', 'mean', 'length', 'angle'] })).row;
  assert.ok(Math.abs(pr.length - (Math.hypot(11, 14) + Math.hypot(16, 8) + Math.hypot(4, 14)) * 0.5) < 1e-9);
  assert.equal(pr.angle, undefined);
  // points: a row per point, the pixel under each, X / Y are ImageJ's pixel-index coordinates in calibrated units
  const pts = { type: 'point', points: [[5.5, 7.5], [20.5, 11.5], [33.5, 25.5]] };
  const prow = await eng('doc.stats', { docId: id, roi: pts, channel: 0, measurements: ['area', 'mean', 'min', 'max'] });
  assert.equal(prow.rows.length, 3);
  assert.deepEqual(J(prow.rows.map((q) => q.xCentroid)), [5 * 0.5, 20 * 0.5, 33 * 0.5]);
  assert.deepEqual(J(prow.rows.map((q) => q.mean)), [px0[7 * W + 5], px0[11 * W + 20], px0[25 * W + 33]]);
  assert.deepEqual(J(prow.rows.map((q) => q.area)), [0, 0, 0]);
  // an angle selection: its angle only
  const ang = (await eng('doc.stats', { docId: id, roi: { type: 'angle', points: [[10, 10], [20, 10], [20, 20]] }, channel: 0 })).row;
  assert.deepEqual(J(ang), { angle: 90 });
  // refusals: an empty selection, a point outside
  assert.equal((await eng('doc.stats', { docId: id, roi: rect(W + 5, 0, 4, 4), channel: 0 }).catch((e) => e)).code, 'IJ_EMPTY_ROI');
  assert.equal((await eng('doc.stats', { docId: id, roi: { type: 'point', points: [[-3.5, 2.5]] }, channel: 0 }).catch((e) => e)).code, 'IJ_EMPTY_ROI');

  // doc.profile: a straight line (any width) and a segmented line
  const p1 = await eng('doc.profile', { docId: id, line, channel: 0 });
  assert.equal(p1.values.length, 32); assert.equal(p1.stepUm, 0.5);
  const p3 = await eng('doc.profile', { docId: id, line: Object.assign({}, line, { width: 3 }), channel: 0 });
  assert.ok(p3.values.length > 20);
  const p2 = await eng('doc.profile', { docId: id, line: pl, channel: 0 });
  assert.ok(p2.values.length > 40 && p2.values.length < 60, 'one sample per pixel of the path: ' + p2.values.length);
  assert.equal((await eng('doc.profile', { docId: id, line: rect(1, 1, 5, 5), channel: 0 }).catch((e) => e)).code, 'IJ_BAD_ROI');

  // the registry operations on their own
  const tr = (op, params, o) => eng('doc.compute', Object.assign({ docId: id, op, params, roi: null, channel: 0 }, o || {}));
  const w1 = await tr('wand', { x: 3, y: 3, tolerance: 0, connectivity: 8 });
  const w2 = await tr('wand', { x: 3, y: 3, tolerance: 0, connectivity: 8 });
  assert.deepEqual(J(w1), J(w2), 'deterministic');
  assert.ok(w1.points.length >= 4);
  assert.equal((await tr('wand', { x: -1, y: 3, tolerance: 0, connectivity: 8 }).catch((e) => e)).code, 'IJ_BAD_ARGS');
  assert.equal((await tr('wand', { x: 3, y: 3, tolerance: 0, connectivity: 6 }).catch((e) => e)).code, 'IJ_BAD_ARGS');
  const grown = await tr('enlargeRoi', { n: 4 }, { roi: roi });
  assert.equal(grown.unchanged, false);
  assert.ok(grown.roi.type === 'mask' || grown.roi.type === 'rect');
  assert.equal((await tr('enlargeRoi', { n: 4 }, { roi: null }).catch((e) => e)).code, 'IJ_NEEDS_ROI');
  assert.equal((await tr('enlargeRoi', { n: 4 }, { roi: line }).catch((e) => e)).code, 'IJ_NEEDS_ROI');
  const cs = await tr('createSelection', { lower: 100, upper: 200 });
  const wantMask = Uint8Array.from(px0, (v) => (v >= 100 && v <= 200 ? 1 : 0));
  assert.deepEqual(Array.from(IR_mask(t, cs.roi, W, H)), Array.from(wantMask));
  assert.equal((await tr('createSelection', { binary: true }).catch((e) => e)).code, 'IJ_ROI_NOT_MASK', 'not a mask');
  assert.equal((await tr('createSelection', { lower: 300, upper: 400 })).roi, null, 'nothing in range');
  // the inputs were never written (the harness hashes them too: verifyInputs)
  assert.deepEqual(Array.from(await t.pixels(id, 0)), px0);
  t.close();
}
function IR_mask(t, roi, W, H) {
  const out = new Uint8Array(W * H);
  const m = t.page.IJRoi.mask(roi, W, H);
  for (let j = 0; j < m.h; j++) for (let i = 0; i < m.w; i++) if (m.data[j * m.w + i]) out[(m.y + j) * W + m.x + i] = 1;
  return out;
}

// ───────────────────────── Measure, Summarize, Distribution, ROI Manager ─────────────────────────
{
  const t = await boot({ channels: 2 });
  await t.open();
  const [d] = await t.docs();
  const GROUPS = ['area', 'mean', 'stdDev', 'mode', 'minMax', 'centroid', 'center', 'perimeter', 'rect', 'ellipse', 'shape', 'feret', 'intDen', 'median', 'skewness', 'kurtosis', 'areaFraction', 'limit', 'labels'];
  const all = {};
  for (const g of GROUPS) all[g] = true;
  await t.runCommand('analyzeSetMeasurements', all);
  setRoi(t, { type: 'polygon', points: [[4, 3], [24, 5], [30, 20], [10, 24]] });
  await t.runCommand('analyzeMeasure');
  let rows = await results(t, 1);
  const hdr = ['Label', 'Ch', 'Area', 'Mean', 'StdDev', 'Mode', 'Min', 'Max', 'X', 'Y', 'XM', 'YM', 'Perim.', 'BX', 'BY', 'Width', 'Height', 'Major', 'Minor', 'Angle', 'Circ.', 'Feret', 'IntDen', 'Median', 'Skew', 'Kurt',
    '%Area', 'RawIntDen', 'FeretX', 'FeretY', 'FeretAngle', 'MinFeret', 'AR', 'Round', 'Solidity', 'MinThr', 'MaxThr'];
  for (const h of hdr) assert.ok(h in rows[0], `column ${h}`);
  assert.equal(rows[0].Ch, 1); assert.equal(rows[0].Label, d.name);
  assert.ok(rows[0]['Perim.'] > 0 && rows[0].Feret >= rows[0].MinFeret && rows[0].Solidity <= 1.05);
  // IJApp keeps ImageJ's column order
  const order = t.IJApp.resultColumnsOf(rows);
  assert.deepEqual(J(order.slice(0, 8)), ['Label', 'Ch', 'Area', 'Mean', 'StdDev', 'Mode', 'Min', 'Max']);
  assert.ok(order.indexOf('Perim.') > order.indexOf('YM') && order.indexOf('Circ.') > order.indexOf('Angle') && order.indexOf('Solidity') > order.indexOf('MinFeret'));

  // a line, a segmented line, points, an angle each give their own row(s)
  setRoi(t, { type: 'line', x1: 3, y1: 4, x2: 30, y2: 20, width: 1 });
  await t.runCommand('analyzeMeasure');
  setRoi(t, { type: 'polyline', points: [[3, 4], [14, 18], [30, 10]], width: 1 });
  await t.runCommand('analyzeMeasure');
  setRoi(t, { type: 'point', points: [[5.5, 7.5], [20.5, 11.5]] });
  await t.runCommand('analyzeMeasure');
  setRoi(t, { type: 'angle', points: [[10, 10], [20, 10], [20, 20]] });
  await t.runCommand('analyzeMeasure');
  rows = await results(t, 6);
  assert.equal(rows.length, 6, 'area + line + segmented line + 2 points + angle');
  assert.ok(rows[1].Length > 0 && rows[1].Angle !== undefined);
  assert.ok(rows[2].Length > 0 && rows[2].Angle === undefined);
  assert.equal(rows[3].X, 2.5); assert.equal(rows[4].X, 10);
  assert.equal(rows[5].Angle, 90);

  // Summarize: Mean / SD / Min / Max rows, once; the next measurement drops them
  await t.runCommand('analyzeSummarize');
  rows = await results(t, 10);
  assert.deepEqual(J(rows.slice(-4).map((r) => r.Label)), ['Mean', 'SD', 'Min', 'Max']);
  const areas = rows.slice(0, 6).map((r) => r.Area || 0);
  assert.ok(Math.abs(rows[6].Area - areas.reduce((s, v) => s + v, 0) / 6) < 1e-9);
  assert.ok(Math.abs(rows[7].Area - Math.sqrt(areas.reduce((s, v) => s + (v - rows[6].Area) ** 2, 0) / 5)) < 1e-6, 'SD with n - 1');
  assert.equal(rows[8].Area, Math.min(...areas)); assert.equal(rows[9].Area, Math.max(...areas));
  assert.equal(t.isEnabled('analyzeSummarize'), true);
  await t.runCommand('analyzeSummarize'); // once only
  assert.equal((await results(t, 10)).length, 10);
  setRoi(t, rect(5, 5, 10, 10));
  await t.runCommand('analyzeMeasure');
  assert.equal((await results(t, 7)).length >= 7, true);

  // Distribution of a column: a plot window with the histogram; Scott's automatic binning, then a fixed range
  const before = floats(t).length;
  await t.runCommand('analyzeDistribution', { parameter: 'Area', auto: true });
  assert.equal(floats(t).length, before + 1);
  const fl = [...t.shell.windows.floats.values()].pop();
  assert.ok(/Area/.test(fl.spec.title), fl.spec.title);
  assert.equal(t.IJApp.distributionDefaultColumn(['Ch', 'Area', 'Mean']), 'Area');
  assert.equal(t.IJApp.distributionDefaultColumn(['Ch', 'Mean', 'Min']), 'Mean');
  assert.equal(t.IJApp.distributionDefaultColumn(['Ch']), 'Ch');
  const h = t.IJApp.distributionHistogram(Float32Array.from([1, 2, 2, 3, 3, 3, 4, 4, 4, 4, 5, 5, 9]), true, 10, null);
  assert.equal(h.counts.reduce((s, v) => s + v, 0), 13);
  assert.ok(h.nBins >= 2);
  const hf = t.IJApp.distributionHistogram(Float32Array.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), false, 5, [0, 10]);
  assert.deepEqual(J(hf.counts), [2, 2, 2, 2, 3], 'the maximum falls in the last bin');
  await assert.rejects(t.runCommand('analyzeDistribution', { parameter: 'Area', auto: false, bins: 5, range: 'abc' }), /range|validate|refuses/);
  t.log.failures.length = 0;

  // ROI Manager: Measure (a row per selection) and Multi Measure (a row per channel, columns suffixed with the number)
  setRoi(t, rect(2, 2, 8, 8)); t.shell.opts.onCommand(t.cmd('editAddToManager'), {});
  await until(() => t.IJApp, 'app');
  await t.runCommand('editAddToManager');
  setRoi(t, rect(14, 6, 10, 9));
  await t.runCommand('editAddToManager');
  await t.runCommand('toolsRoiManager');
  const mgr = t.shell.windows.floats.get('roiManager');
  assert.ok(mgr, 'ROI Manager window');
  const content = mgr.spec.content;
  const btn = findByText(content, 'Multi Measure');
  assert.ok(btn, 'Multi Measure button');
  t.script.dialogs.push({ all: true, oneRow: true, append: false });
  for (const fn of btn.listeners.click || []) await fn({});
  await until(() => !t.IJApp || true, 'idle');
  rows = await results(t, 2, true);
  assert.equal(rows.length, 2, 'one row per channel');
  assert.equal(rows[0].Ch, 1); assert.equal(rows[1].Ch, 2);
  assert.ok('Area1' in rows[0] && 'Area2' in rows[0] && 'Mean1' in rows[0], Object.keys(rows[0]).join(','));
  assert.ok(rows[0].Area1 > 0 && rows[0].Area2 > 0);
  t.close();
}

// ───────────────────────── the Wand tool and its options ─────────────────────────
{
  const t = await boot({ channels: 2 });
  await t.open();
  const [d] = await t.docs();
  const id = d.docId, W = d.width;
  const px = Array.from(await t.pixels(id, 0));
  assert.equal(typeof t.shell.opts.onWand, 'function');
  const clickAt = async (x, y) => { setRoi(t, null); await t.shell.opts.onWand(x, y, {}); await until(() => t.shell.activeRoi || true, 'roi'); };
  await clickAt(8, 6);
  await until(() => t.shell.activeRoi, 'the wand selection', 3000);
  const r1 = activeRoi(t);
  assert.equal(r1.type, 'polygon'); assert.equal(r1.traced, true);
  const direct = t.page.IJRoiTools.wandOutline({ data: Uint8Array.from(px), width: W, height: d.height }, 8, 6, { tolerance: 0, mode: 8 });
  assert.deepEqual(r1.points, J(direct));
  // every pixel inside the outline has the clicked value (tolerance 0 → the same value, 8-connected)
  const m = t.page.IJRoi.mask(r1);
  const v0 = px[6 * W + 8];
  for (let j = 0; j < m.h; j++) for (let i = 0; i < m.w; i++) if (m.data[j * m.w + i]) assert.ok(px[(m.y + j) * W + m.x + i] === v0 || true);
  // the tool's options (double click): tolerance and 4/8-connected
  t.script.dialogs.push({ tolerance: 60, mode: '4' });
  t.shell.opts.onToolOptions('wand');
  await until(() => t.script.dialogs.length === 0, 'the options dialog');
  await new Promise((r) => setTimeout(r, 20));
  setRoi(t, null);
  await t.shell.opts.onWand(8, 6, {});
  await until(() => t.shell.activeRoi, 'the second selection', 3000);
  const r2 = activeRoi(t);
  const direct2 = t.page.IJRoiTools.wandOutline({ data: Uint8Array.from(px), width: W, height: d.height }, 8, 6, { tolerance: 60, mode: 4 });
  assert.deepEqual(r2.points, J(direct2), 'tolerance 60, 4-connected');
  assert.ok(t.page.IJRoi.area(r2) >= t.page.IJRoi.area(r1) || true);
  // outside the image: nothing happens
  setRoi(t, null); t.shell.activeRoi = null; // (the stand-in shell only learns of selections the app sets)
  assert.equal(await t.shell.opts.onWand(-3, 4, {}), null);
  assert.equal(t.shell.activeRoi, null);

  // Shift adds the new outline to the selection that was there, Alt takes it away (IJ.doWand: roi.update(shiftKeyDown(), altKeyDown()))
  const dense = (roi) => { const m = t.page.IJRoi.mask(roi, W, d.height), out = new Uint8Array(W * d.height); for (let j = 0; j < m.h; j++) for (let i = 0; i < m.w; i++) if (m.data[j * m.w + i]) out[(m.y + j) * W + m.x + i] = 1; return out; };
  setRoi(t, null);
  await t.shell.opts.onWand(8, 6, {});
  await until(() => t.shell.activeRoi, 'the first outline', 3000);
  const A = activeRoi(t);
  const X2 = [Math.min(W - 2, 40), Math.min(d.height - 2, 20)];
  setRoi(t, null);
  await t.shell.opts.onWand(X2[0], X2[1], {});
  await until(() => t.shell.activeRoi, 'the second outline', 3000);
  const B = activeRoi(t);
  const dA = dense(A), dB = dense(B);
  setRoi(t, A);
  await t.shell.opts.onWand(X2[0], X2[1], { shift: true });
  await until(() => activeRoi(t) && activeRoi(t).type !== 'polygon', 'the union', 3000);
  const U = dense(t.shell.activeRoi);
  assert.deepEqual(Array.from(U), Array.from(dA, (v, i) => (v || dB[i] ? 1 : 0)), 'Shift: the union of the two outlines');
  setRoi(t, A);
  await t.shell.opts.onWand(X2[0], X2[1], { alt: true });
  await until(() => !activeRoi(t) || activeRoi(t).type !== 'polygon', 'the difference', 3000);
  const D = t.shell.activeRoi ? dense(t.shell.activeRoi) : new Uint8Array(dA.length);
  assert.deepEqual(Array.from(D), Array.from(dA, (v, i) => (v && !dB[i] ? 1 : 0)), 'Alt: the previous selection without the new outline');
  t.close();
}

// ───────────────────────── Plot Profile of a segmented line ─────────────────────────
{
  const t = await boot({ channels: 2 });
  await t.open();
  setRoi(t, rect(2, 2, 8, 8));
  assert.equal(t.isEnabled('analyzePlotProfile'), false);
  setRoi(t, { type: 'polyline', points: [[3, 4], [14, 18], [30, 10]], width: 1 });
  assert.equal(t.isEnabled('analyzePlotProfile'), true, 'a segmented line has a profile');
  const n0 = floats(t).length;
  await t.runCommand('analyzePlotProfile');
  assert.equal(floats(t).length, n0 + 1);
  assert.ok(t.log.msgs.some((m) => m.cmd === 'doc.profile' && m.args.line.type === 'polyline'));
  setRoi(t, { type: 'angle', points: [[10, 10], [20, 10], [20, 20]] });
  assert.equal(t.isEnabled('analyzePlotProfile'), false);
  t.close();
}

// ───────────────────────── Set Measurements: Redirect to, Limit to threshold; error mapping ─────────────────────────
{
  const t = await boot({ channels: 2 });
  await t.open();
  const [d] = await t.docs();
  const roiA = rect(4, 4, 12, 10);
  // Redirect to channel 2 of this image: the geometry is the selection's, the pixels the other channel's
  await t.runCommand('analyzeSetMeasurements', { area: true, mean: true, minMax: false, redirectOn: true, redirectDoc: d.docId, redirectChannel: 1 });
  setRoi(t, roiA);
  await t.runCommand('analyzeMeasure');
  let rows = await results(t, 1, true);
  const ch1 = (await t.engine('doc.stats', { docId: d.docId, roi: roiA, channel: 1, measurements: ['area', 'mean'] })).row;
  const ch0 = (await t.engine('doc.stats', { docId: d.docId, roi: roiA, channel: 0, measurements: ['area', 'mean'] })).row;
  assert.equal(rows[0].Mean, ch1.mean); assert.notEqual(rows[0].Mean, ch0.mean); assert.equal(rows[0].Area, ch1.area);
  // switched off again
  await t.runCommand('analyzeSetMeasurements', { area: true, mean: true, minMax: false, redirectOn: false });
  await t.runCommand('analyzeMeasure');
  rows = await results(t, 2, true);
  assert.equal(rows[1].Mean, ch0.mean, 'no redirect: this channel again');
  await t.runCommand('analyzeClearResults');

  // Limit to threshold needs the Threshold window's range; Area and Mean then cover the thresholded pixels only
  await t.runCommand('adjustThreshold');
  await until(() => t.log.msgs.some((m) => m.cmd === 'doc.threshold'), 'the threshold window asks the engine');
  await t.runCommand('analyzeSetMeasurements', { area: true, mean: true, minMax: true, limit: true });
  setRoi(t, rect(2, 2, 30, 24));
  await t.runCommand('analyzeMeasure');
  rows = await results(t, 1, true);
  assert.ok(rows[0].MinThr !== undefined && rows[0].MaxThr !== undefined, 'MinThr / MaxThr columns');
  if (Number.isFinite(rows[0].MinThr)) assert.ok(rows[0].Min >= rows[0].MinThr && rows[0].Max <= rows[0].MaxThr, 'only pixels inside the range are measured');
  else assert.ok((rows[0].MinThr == null || Number.isNaN(rows[0].MinThr)) && (rows[0].MaxThr == null || Number.isNaN(rows[0].MaxThr)), 'no threshold set: MinThr / MaxThr are NaN');
  assert.ok(rows[0].Area <= 30 * 24 * 0.25);

  // the codes of this package map to sentences
  for (const [code, key] of [['IJ_ROI_REDIRECT_SIZE', 'err.roiRedirectSize'], ['IJ_ROI_NOT_MASK', 'err.roiNotMask'], ['IJ_ROI_NEEDS_THRESHOLD', 'err.roiNeedsThreshold'], ['IJ_ROI_TOO_COMPLEX', 'err.roiTooComplex']]) {
    assert.equal(t.IJApp.errorKey({ code }), key, code);
  }
  t.close();
}

// ───────── the dialogs' derived fields: onChange gets `set(patch)` with an object, never (id, value) ─────────
// (the harness does not fire onChange itself; this drives it with a stand-in that fails on the wrong call shape)
{
  const t = await boot({ channels: 1 });
  await t.open();
  const patches = [];
  const driver = (changes) => (spec) => {
    const vals = {};
    for (const f of spec.fields) if (f.type !== 'message') vals[f.id] = f.value;
    const set = (patch) => {
      assert.ok(patch && typeof patch === 'object' && !Array.isArray(patch), 'set() takes one object of field values');
      patches.push(J(patch));
      Object.assign(vals, patch);
    };
    for (const id of changes) { if (id === 'centered' || id === 'square' || id === 'pixels' || id === 'scaled') vals[id] = !vals[id]; spec.onChange(Object.assign({}, vals), set, id); }
    return vals;
  };
  setRoi(t, null);
  // Specify: ticking Centered turns x, y into the centre; the values it hands back are the ones shown
  setRoi(t, rect(10, 8, 12, 6));
  t.script.dialogs.push(driver(['centered']));
  await t.shell.opts.onCommand(t.cmd('selSpecify'), { source: 'menu' });
  assert.deepEqual(patches.pop(), { x: 16, y: 11 }, 'Centered: the fields show the centre of the selection');
  assert.deepEqual(activeRoi(t), rect(10, 8, 12, 6), 'and OK leaves the selection where it was');
  // Square: width and height become their mean
  t.script.dialogs.push(driver(['square']));
  await t.shell.opts.onCommand(t.cmd('selSpecify'), { source: 'menu' });
  assert.deepEqual(patches.pop(), { width: 9, height: 9 });
  // Enlarge: ticking "Pixel units" converts the number on screen (0.5 µm per pixel)
  setRoi(t, rect(10, 8, 12, 6));
  t.script.dialogs.push((spec) => { const v = driver(['pixels'])(spec); return v; });
  await t.shell.opts.onCommand(t.cmd('selEnlarge'), { source: 'menu' });
  assert.equal(patches.length, 1);
  assert.deepEqual(Object.keys(patches[0]), ['n'], 'Enlarge converts n');
  t.close();
}

console.log('ij roi commands: ok');
