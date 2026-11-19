// Advanced Studio, package P3 (seg): the menu commands of ij-cmds-seg.js, end to end through tests/js/ij_harness.mjs —
// dialog values → the real controller → the REAL worker engine → undo → redo → reload() restores the journal → the same pixels.
//
//   • where each command sits (menu, order, separator, no shortcut), when it is enabled, a failed package disables it;
//   • Process › Binary › Distance Map / Ultimate Points / Voronoi (Overwrite and the 8 / 16 / 32-bit new image), Watershed,
//     Skeletonize, Outline: the pixels equal the reference computed on the very pixels the engine held, undo / redo / restore;
//   • refusals: a non-binary image shows ImageJ's sentence, nothing changes;
//   • Process › Find Maxima…: the dialog (fields, defaults, memory of the last values), every output type, the selection,
//     Light background, Above lower threshold, the live preview (overlay of points), 8 / 16 / 32 bit.
//
// Run: node tests/js/test_ij_seg_commands.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { boot, until, sleep, EN, DIR } from './ij_harness.mjs';

const sandbox = { console, setTimeout, clearTimeout };
sandbox.self = sandbox;
vm.createContext(sandbox);
for (const f of ['ij-core.js', 'ij-analysis.js', 'ij-proc-shared.js', 'ij-proc-seg.js']) vm.runInContext(fs.readFileSync(path.join(DIR, f), 'utf8'), sandbox, { filename: f });
const { IJSeg, IJBinary } = sandbox;

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok  ' + name); } catch (e) { console.error('FAIL ' + name); throw e; }
}
const A = (x) => Array.from(x);
const same = (a, b, msg) => assert.equal(a.length, b.length, msg + ' (length)') || assert.ok(a.every((v, i) => v === b[i] || (v !== v && b[i] !== b[i])), msg);
const VOL = { width: 80, height: 60, depth: 3, channels: 1 };
const textOf = (el) => (el ? [el.textContent || '', ...(el.children || []).map(textOf)].join('|') : '');

async function maskDoc(t) { // Process › Binary › Convert to Mask on the projected image → the active image is the new 8-bit mask
  await t.runCommand('binMask');
  const id = t.activeId();
  const info = (await t.docs()).find((d) => d.docId === id);
  assert.equal(info.bitDepth, 8);
  return { id, w: info.width, h: info.height };
}
async function activate(t, id) { // Window › Next until the image is the active one
  for (let i = 0; i < 12 && t.activeId() !== id; i++) await t.runCommand('windowNext');
  assert.equal(t.activeId(), id);
}
async function restoreAll(t) {
  const t2 = await t.reload();
  const w2 = await t2.spawn();
  for (const k of (await t2.store.shared.list()).map((x) => x.key)) {
    const r = await t2.engine('session.restore', { key: k }, w2);
    assert.equal(r.warnings.length, 0, JSON.stringify(r.warnings));
  }
  return t2;
}

// ═════════════════════════════════════════ registration ═════════════════════════════════════════
await test('commands: menu, order, separator, no shortcut, enabled rules', async () => {
  const t = await boot({ volume: VOL });
  const by = (id) => t.IJApp.COMMANDS.find((c) => c.id === id);
  const expect = {
    procFindMaxima: [['Process'], 40], binOutline: [['Process', 'Binary'], 60], binSkeletonize: [['Process', 'Binary'], 80],
    binDistanceMap: [['Process', 'Binary'], 90], binUltimatePoints: [['Process', 'Binary'], 100], binWatershed: [['Process', 'Binary'], 110], binVoronoi: [['Process', 'Binary'], 120]
  };
  for (const [id, [menu, order]] of Object.entries(expect)) {
    const c = by(id);
    assert.ok(c, id);
    assert.equal(c.pkg, 'seg');
    assert.deepEqual(A(c.menu), menu, id);
    assert.equal(c.order, order, id);
    assert.equal(c.shortcut, null, id + ' has no shortcut (PLAN §1)');
    assert.equal(c.labelKey, 'cmd.' + id);
  }
  assert.equal(by('binDistanceMap').separatorBefore, true, 'the Distance Map group is set apart');
  assert.equal(by('binOutline').separatorBefore, true, 'Outline starts its group (Process > Binary, IJ_Props.txt binary09)');
  for (const id of ['binDistanceMap', 'binUltimatePoints', 'binVoronoi']) assert.ok(!/…/.test(EN.cmd[id]), id + ' has no ellipsis: the EDM has no dialog');
  // the neighbours of PLAN §1: Outline between Close and Fill Holes, Skeletonize after Fill Holes
  assert.ok(by('binClose').order < by('binOutline').order && by('binOutline').order < by('binFillHoles').order && by('binFillHoles').order < by('binSkeletonize').order);
  const st = (doc, o) => Object.assign({ doc, roi: null, prevRoi: null, busy: false, nDocs: 1, canUndo: false, canRedo: false, dirty: false, hasResults: false, canProject: true, threshold: null, activeChannel: 0 }, o);
  const img = (bd) => ({ docId: 'x', name: 'x', width: 10, height: 10, bitDepth: bd, channels: [{ name: 'a' }] });
  for (const id of ['binOutline', 'binSkeletonize', 'binDistanceMap', 'binUltimatePoints', 'binWatershed', 'binVoronoi']) {
    assert.equal(by(id).enabled(st(null)), false, id + ' needs an image');
    assert.equal(by(id).enabled(st(img(8))), true, id + ' on 8-bit');
    assert.equal(by(id).enabled(st(img(16))), false, id + ' refuses 16-bit');
    assert.equal(by(id).enabled(st(img(32))), false, id + ' refuses 32-bit');
    assert.equal(by(id).enabled(st(img(8), { busy: true })), false, id + ' while a step runs');
  }
  for (const bd of [8, 16, 32]) assert.equal(by('procFindMaxima').enabled(st(img(bd))), true, 'Find Maxima on ' + bd + '-bit');
  assert.equal(by('procFindMaxima').enabled(st(null)), false);
  assert.equal(by('procFindMaxima').enabled(st(img(8), { busy: true })), false);
  t.close();
});

await test('a package that failed to load disables its commands (the view stays usable)', async () => {
  const t = await boot({ volume: VOL, brokenPackages: ['ij-proc-seg.js'] });
  await t.open();
  await until(() => t.failedPackages().has('seg'), 'packageFailed seg');
  for (const id of ['procFindMaxima', 'binOutline', 'binSkeletonize', 'binDistanceMap', 'binUltimatePoints', 'binWatershed', 'binVoronoi']) assert.equal(t.isEnabled(id), false, id);
  assert.equal(t.isEnabled('binMask'), true, 'another package is unaffected');
  t.close();
});

// ═════════════════════════════════════════ binary operations ═════════════════════════════════════════
const REFS = {
  binDistanceMap: async (px, w, h) => IJSeg.overwriteBytes(await IJSeg.edmFloat(px, w, h, false, null)),
  binUltimatePoints: async (px, w, h) => IJSeg.overwriteBytes(await IJSeg.uepFloat(px, w, h, false, null)),
  binVoronoi: async (px, w, h) => IJSeg.overwriteBytes(await IJSeg.voronoiFloat(px, w, h, false, null)),
  binWatershed: (px, w, h) => IJSeg.watershedBinary(px, w, h, false, null),
  binSkeletonize: (px, w, h) => IJSeg.skeletonize(px, w, h, 255, null),
  binOutline: (px, w, h) => IJBinary.outline(px, w, h, {})
};
for (const id of Object.keys(REFS)) {
  await test(`${id}: pixels = ImageJ's algorithm on the engine's pixels; undo, redo, restore after a reload`, async () => {
    const t = await boot({ volume: VOL });
    await t.open();
    const m = await maskDoc(t);
    const before = A(await t.pixels(m.id, 0));
    const bin = Uint8Array.from(before);
    const expected = A(await REFS[id](bin, m.w, m.h));
    assert.ok(before.some((v) => v === 255) && before.some((v) => v === 0), 'a mask with objects and background');
    // the commands with a dialog answer its defaults (Overwrite); the others have none
    await t.runCommand(id);
    same(A(await t.pixels(m.id, 0)), expected, id + ' result');
    if (id !== 'binWatershed') assert.notDeepEqual(A(await t.pixels(m.id, 0)), before, id + ' changed the image');
    const info = (await t.docs()).find((d) => d.docId === m.id);
    assert.equal(info.undoDepth, 1, 'one undo step');
    await t.runCommand('editUndo');
    same(A(await t.pixels(m.id, 0)), before, 'undo');
    await t.runCommand('editRedo');
    same(A(await t.pixels(m.id, 0)), expected, 'redo');
    const t2 = await restoreAll(t);
    same(A(await t2.pixels(m.id, 0)), expected, 'restored from the journal');
    t2.close();
    t.close();
  });
}

await test('a selection does not limit the binary operations (ImageJ: EDM ignores ROIs, Skeletonize resets it)', async () => {
  const t = await boot({ volume: VOL });
  await t.open();
  const m = await maskDoc(t);
  const before = Uint8Array.from(await t.pixels(m.id, 0));
  t.shell.opts.onRoi({ type: 'oval', x: 5, y: 5, w: 30, h: 20 }, { final: true });
  await t.runCommand('binSkeletonize');
  same(A(await t.pixels(m.id, 0)), A(await IJSeg.skeletonize(before, m.w, m.h, 255, null)), 'the whole image was skeletonized');
  t.close();
});

await test('Distance Map / Ultimate Points / Voronoi: the EDM output is a new image of the chosen type', async () => {
  const t = await boot({ volume: VOL });
  await t.open();
  const m = await maskDoc(t);
  const bin = Uint8Array.from(await t.pixels(m.id, 0));
  const before = A(bin);
  const kinds = { binDistanceMap: ['EDM of ', IJSeg.edmFloat], binUltimatePoints: ['UEPs of ', IJSeg.uepFloat], binVoronoi: ['Voronoi of ', IJSeg.voronoiFloat] };
  const made = [];
  for (const [id, [prefix, fn]] of Object.entries(kinds)) {
    const f = await fn(bin, m.w, m.h, false, null);
    for (const [out, bd] of [['float', 32], ['short', 16], ['byte', 8]]) {
      const n0 = (await t.docs()).length;
      // the output type is the "EDM output" of Process > Binary > Options (setting thr.edmOutput), no dialog of its own
      t.api('thr').settings.set('thr.edmOutput', out);
      await t.runCommand(id);
      const docs = await t.docs();
      assert.equal(docs.length, n0 + 1, id + ' ' + out + ': a new image');
      const nd = docs[docs.length - 1];
      assert.equal(nd.name, prefix + 'HARNESS', 'named as ImageJ names it (' + nd.name + ')');
      assert.equal(nd.bitDepth, bd);
      assert.equal(nd.width, m.w);
      const px = await t.pixels(nd.docId, 0);
      const exp = out === 'float' ? f : out === 'short' ? IJSeg.scaledShorts(f) : IJSeg.scaledBytes(f);
      same(A(px), A(exp), id + ' ' + out);
      assert.notEqual(t.activeId(), m.id, 'the new image is shown');
      assert.equal(nd.channels[0].color.toLowerCase(), '#ffffff');
      made.push([nd.docId, A(exp)]);
      await activate(t, m.id); // back to the mask for the next one
    }
  }
  same(A(await t.pixels(m.id, 0)), before, 'the mask itself is untouched');
  assert.equal((await t.docs()).find((d) => d.docId === m.id).undoDepth, 0);
  // the new images survive a reload (each has its baseline)
  const t2 = await restoreAll(t);
  for (const [docId, exp] of made) same(A(await t2.pixels(docId, 0)), exp, 'restored ' + docId);
  t2.close();
  t.close();
});

await test('Distance Map has no dialog: its output type is the EDM output of Binary Options, which Overwrite leaves out of the way', async () => {
  const t = await boot({ volume: Object.assign({}, VOL, { channels: 2 }), channels: 2 });
  await t.open();
  assert.equal(t.api('thr').settings.get('thr.edmOutput'), undefined, 'Overwrite is the default');
  const n = t.log.dialogSpecs.length;
  // the projected image has two non-binary channels: ImageJ's refusal, and no dialog was shown
  await t.runCommand('binDistanceMap', undefined, { expectError: true });
  assert.equal(t.log.dialogSpecs.length, n, 'no dialog');
  t.api('thr').settings.set('thr.edmOutput', 'float');
  await t.runCommand('binUltimatePoints', undefined, { expectError: true });
  assert.equal(t.log.dialogSpecs.length, n, 'still no dialog');
  t.close();
});

await test('a non-binary image is refused with ImageJ\'s sentence and stays as it was', async () => {
  const t = await boot({ volume: VOL });
  await t.open();
  const id = t.activeId();
  const before = A(await t.pixels(id, 0));
  for (const cmd of ['binWatershed', 'binSkeletonize']) {
    const errs = await t.runCommand(cmd, undefined, { expectError: true });
    assert.equal(errs[0].message, EN.err.segNotBinary, cmd);
    assert.match(EN.err.segNotBinary, /binary/);
  }
  for (const cmd of ['binDistanceMap', 'binUltimatePoints', 'binVoronoi']) {
    const errs = await t.runCommand(cmd, undefined, { expectError: true });
    assert.equal(errs[0].message, EN.err.segNotBinary, cmd);
  }
  same(A(await t.pixels(id, 0)), before, 'nothing changed');
  assert.equal((await t.docs()).find((d) => d.docId === id).undoDepth, 0);
  t.close();
});

await test('the other bit depths: Binary commands are disabled, Find Maxima works', async () => {
  const t = await boot({ volume: VOL });
  await t.open();
  await t.runCommand('typeBit16', {});
  for (const id of ['binWatershed', 'binDistanceMap', 'binSkeletonize', 'binOutline', 'binUltimatePoints', 'binVoronoi']) assert.equal(t.isEnabled(id), false, id + ' on 16-bit');
  assert.equal(t.isEnabled('procFindMaxima'), true);
  await t.runCommand('typeBit32', {});
  assert.equal(t.isEnabled('binWatershed'), false);
  await t.runCommand('procFindMaxima', { prominence: 4, output: 'count' });
  assert.equal(t.shell.opts.getState().hasResults, true);
  t.close();
});

// ═════════════════════════════════════════ Find Maxima ═════════════════════════════════════════
const direct = async (px, w, h, p, outputType, roi) => IJSeg.findMaxima({ data: p.light ? IJSeg.invertedCopy(px, 8) : px, width: w, height: h }, {
  tolerance: p.prominence, strict: !!p.strict, excludeOnEdges: !!p.excludeEdges, outputType, threshold: IJSeg.NO_THRESHOLD, roi: roi || null, mask: null, contains: null
});

await test('Find Maxima…: the dialog of ImageJ (fields, defaults, output choice), remembered values', async () => {
  const t = await boot({ volume: VOL });
  await t.open();
  await t.runCommand('procFindMaxima', {});
  let spec = t.log.dialogSpecs[t.log.dialogSpecs.length - 1];
  assert.equal(spec.title, EN.cmd.procFindMaxima);
  assert.deepEqual(A(spec.fields.map((f) => f.id)), ['prominence', 'strict', 'excludeEdges', 'light', 'output'], 'no "Above lower threshold" without a threshold');
  assert.deepEqual(A(spec.fields.map((f) => f.value)), [10, false, false, false, 'points'], 'ImageJ defaults: prominence 10, Point Selection');
  assert.deepEqual(A(spec.fields[4].options.map((o) => o.value)), ['single', 'tolerance', 'segmented', 'points', 'list', 'count'], 'MaximumFinder.outputTypeNames, in order');
  assert.deepEqual(A(spec.fields[4].options.map((o) => EN.dlg.seg.type[o.value])), ['Single Points', 'Maxima Within Tolerance', 'Segmented Particles', 'Point Selection', 'List', 'Count']);
  assert.equal(spec.fields[0].min, 0);
  assert.equal(typeof (spec.preview && spec.preview.onChange), 'function', 'a live preview');
  await t.runCommand('procFindMaxima', { prominence: 25.5, strict: true, excludeEdges: true, light: true, output: 'count' });
  await t.runCommand('procFindMaxima', {});
  spec = t.log.dialogSpecs[t.log.dialogSpecs.length - 1];
  assert.deepEqual(A(spec.fields.map((f) => f.value)), [25.5, true, true, true, 'count'], 'ImageJ keeps the last values (static fields)');
  t.close();
  // 32-bit: two decimals, a finer step
  const t2 = await boot({ volume: VOL });
  await t2.open();
  await t2.runCommand('typeBit32', {});
  await t2.runCommand('procFindMaxima', {});
  const s2 = t2.log.dialogSpecs[t2.log.dialogSpecs.length - 1];
  assert.equal(s2.fields[0].decimals, 2);
  t2.close();
});

await test('Find Maxima…: Point Selection, List and Count equal the finder on the same pixels', async () => {
  const t = await boot({ volume: VOL });
  await t.open();
  const id = t.activeId();
  const px = Uint8Array.from(await t.pixels(id, 0));
  const w = 80, h = 60;
  const p = { prominence: 15, strict: false, excludeEdges: false, light: false };
  const exp = await direct(px, w, h, p, IJSeg.POINT_SELECTION);
  assert.ok(exp.points.length >= 6, 'enough maxima to compare: ' + exp.points.length / 2);
  await t.runCommand('procFindMaxima', Object.assign({ output: 'points' }, p));
  const roi = t.shell.activeRoi;
  assert.equal(roi.type, 'point');
  same(roi.points.flat().map((v) => v - 0.5), exp.points, 'the point selection holds the maxima in ImageJ\'s order, at the pixel centres');
  // List: a table window X, Y
  await t.runCommand('procFindMaxima', Object.assign({ output: 'list' }, p));
  const win = [...t.shell.windows.floats.values()].find((x) => x.spec.title === EN.res.fmList);
  assert.ok(win, 'a table window');
  const cells = textOf(win.spec.content).split('|').filter((s) => /^\d+$/.test(s)).map(Number);
  same(cells.slice(0, 4), exp.points.slice(0, 4), 'the first rows of the list');
  assert.equal(cells.length, exp.points.length, 'one row per maximum');
  assert.ok(/X\|Y/.test(textOf(win.spec.content).replace(/\|+/g, '|')), 'columns X and Y');
  // Count: a Results row
  await t.runCommand('procFindMaxima', Object.assign({ output: 'count' }, p));
  const res = [...t.shell.windows.floats.values()].find((x) => x.spec.title === 'Results');
  assert.ok(res && /Count/.test(textOf(res.spec.content)));
  assert.ok(textOf(res.spec.content).split('|').includes(String(exp.points.length / 2)), 'the count: ' + exp.points.length / 2);
  // none of the three is an edit: nothing to undo
  assert.equal((await t.docs())[0].undoDepth, 0);
  t.close();
});

await test('Find Maxima…: Single Points / Maxima Within Tolerance / Segmented Particles are new 8-bit images', async () => {
  const t = await boot({ volume: VOL });
  await t.open();
  const id = t.activeId();
  const src = (await t.docs())[0];
  const px = Uint8Array.from(await t.pixels(id, 0));
  const p = { prominence: 15, strict: false, excludeEdges: true, light: false };
  const made = [];
  for (const [out, type, suffix] of [['single', IJSeg.SINGLE_POINTS, ' Maxima'], ['tolerance', IJSeg.IN_TOLERANCE, ' Maxima'], ['segmented', IJSeg.SEGMENTED, ' Segmented']]) {
    await activate(t, id);
    const n0 = (await t.docs()).length;
    await t.runCommand('procFindMaxima', Object.assign({ output: out }, p));
    const docs = await t.docs();
    assert.equal(docs.length, n0 + 1, out + ': one new image');
    const nd = docs[docs.length - 1];
    assert.equal(nd.name, src.name + suffix);
    assert.equal(nd.bitDepth, 8);
    assert.equal(nd.width, 80);
    assert.deepEqual(A(nd.calibration && Object.keys(nd.calibration).sort()), A(Object.keys(src.calibration).sort()), 'calibration kept');
    const exp = (await direct(px, 80, 60, p, type)).out;
    const got = await t.pixels(nd.docId, 0);
    same(A(got), A(exp), out);
    assert.ok(got.some((v) => v === 255) && got.some((v) => v === 0), out + ' has marks on a black background');
    made.push([nd.docId, A(exp)]);
    assert.equal(t.activeId(), nd.docId);
  }
  const t2 = await restoreAll(t);
  for (const [docId, exp] of made) same(A(await t2.pixels(docId, 0)), exp, 'restored ' + docId);
  t2.close();
  t.close();
});

await test('Find Maxima…: a selection limits the maxima, "Segmented Particles" ignores it, Light background', async () => {
  const t = await boot({ volume: VOL });
  await t.open();
  const id = t.activeId();
  const px = Uint8Array.from(await t.pixels(id, 0));
  const p = { prominence: 12, strict: false, excludeEdges: false, light: false };
  const all = await direct(px, 80, 60, p, IJSeg.POINT_SELECTION);
  t.shell.opts.onRoi({ type: 'rect', x: 10, y: 8, w: 40, h: 30 }, { final: true });
  await t.runCommand('procFindMaxima', Object.assign({ output: 'points' }, p));
  const pts = t.shell.activeRoi.points.map(([x, y]) => [x - 0.5, y - 0.5]);
  const inside = [];
  for (let i = 0; i < all.points.length; i += 2) { const x = all.points[i], y = all.points[i + 1]; if (x >= 10 && x < 50 && y >= 8 && y < 38) inside.push([x, y]); }
  assert.ok(pts.length >= 1 && pts.length < all.points.length / 2, 'fewer maxima inside the rectangle');
  for (const [x, y] of pts) assert.ok(x >= 10 && x < 50 && y >= 8 && y < 38);
  // the ones the rectangle holds are the maxima of the whole image inside it, but the list can also hold a maximum whose
  // plateau centre lies inside while it was found from a pixel of the rectangle: compare as sets of what the finder says
  const exp = await direct(px, 80, 60, p, IJSeg.POINT_SELECTION, { x: 10, y: 8, w: 40, h: 30 });
  const expIn = []; for (let i = 0; i < exp.points.length; i += 2) { const x = exp.points[i], y = exp.points[i + 1]; if (x >= 10 && x < 50 && y >= 8 && y < 38) expIn.push([x, y]); }
  assert.deepEqual(JSON.parse(JSON.stringify(pts)), expIn);
  // segmented: the picture of the whole image although a rectangle is selected
  await t.runCommand('procFindMaxima', Object.assign({ output: 'segmented' }, p));
  const nd = (await t.docs()).pop();
  same(A(await t.pixels(nd.docId, 0)), A((await direct(px, 80, 60, p, IJSeg.SEGMENTED)).out), 'segmented ignores the selection');
  // Light background finds the minima: the same as the maxima of the inverted pixels
  t.shell.opts.onRoi(null, { final: true });
  await activate(t, id);
  await t.runCommand('procFindMaxima', Object.assign({ output: 'points' }, p, { light: true }));
  const light = t.shell.activeRoi.points.flat().map((v) => v - 0.5);
  same(light, (await direct(px, 80, 60, Object.assign({}, p, { light: true }), IJSeg.POINT_SELECTION)).points, 'light background');
  t.close();
});

await test('Find Maxima…: "Above lower threshold" appears with a threshold, follows it, and is refused with Light background', async () => {
  const t = await boot({ volume: VOL });
  await t.open();
  await t.runCommand('typeBit16', {});
  const id = t.activeId();
  const px = Uint16Array.from(await t.pixels(id, 0));
  await t.runCommand('adjustThreshold', {});
  await until(() => t.shell.opts.getState().threshold, 'the threshold window holds its range');
  const thr = t.shell.opts.getState().threshold;
  const p = { prominence: 8, strict: false, excludeEdges: false };
  await t.runCommand('procFindMaxima', Object.assign({ output: 'count', aboveLower: true, light: false }, p));
  let spec = t.log.dialogSpecs[t.log.dialogSpecs.length - 1];
  assert.deepEqual(A(spec.fields.map((f) => f.id)), ['prominence', 'strict', 'excludeEdges', 'aboveLower', 'light', 'output']);
  assert.equal(spec.fields[3].enabledIf({ light: false }), true);
  assert.equal(spec.fields[3].enabledIf({ light: true }), false, 'not with Light background (MaximumFinder: "cannot be used when finding minima")');
  const withT = await IJSeg.findMaxima({ data: px, width: 80, height: 60 }, { tolerance: 8, strict: false, excludeOnEdges: false, outputType: IJSeg.POINT_SELECTION, threshold: thr.lower, roi: null, mask: null, contains: null });
  const noT = await IJSeg.findMaxima({ data: px, width: 80, height: 60 }, { tolerance: 8, strict: false, excludeOnEdges: false, outputType: IJSeg.POINT_SELECTION, threshold: IJSeg.NO_THRESHOLD, roi: null, mask: null, contains: null });
  assert.ok(withT.points.length < noT.points.length, 'the threshold dropped some maxima: ' + withT.points.length / 2 + ' < ' + noT.points.length / 2);
  const res = [...t.shell.windows.floats.values()].find((x) => x.spec.title === 'Results');
  assert.ok(textOf(res.spec.content).split('|').includes(String(withT.points.length / 2)), 'Count = ' + withT.points.length / 2);
  t.close();
});

await test('Find Maxima…: the live preview draws the maxima as points over the visible region', async () => {
  const t = await boot({ volume: VOL });
  await t.open();
  const id = t.activeId();
  const px = Uint8Array.from(await t.pixels(id, 0));
  // The harness ticks Preview itself but stops at the first note; here the dialog is driven by hand and the overlay awaited.
  let drawn = null, countLine = null;
  t.script.dialogs.push(async (spec) => {
    const before = t.log.overlays.length;
    spec.preview.onChange({ prominence: 15, strict: false, excludeEdges: false, light: false, output: 'points' }, { note() {} });
    await until(() => t.log.overlays.slice(before).some(Boolean), 'the overlay of the preview');
    drawn = t.log.overlays.slice(before).filter(Boolean).pop();
    countLine = t.log.status.filter((s) => typeof s === 'string' && /maxima/.test(s)).pop();
    spec.preview.onChange(null, { note() {} });
    return null; // Cancel
  });
  await t.runCommand('procFindMaxima');
  assert.equal(drawn.length, 1);
  const it = drawn[0];
  assert.equal(it.kind, 'points');
  assert.equal(it.color, '#ffff00');
  const exp = (await direct(px, 80, 60, { prominence: 15 }, IJSeg.POINT_SELECTION)).points;
  same(it.pts.map((v) => v - 0.5), exp, 'the preview points are the maxima of the image (the whole image is visible)');
  assert.equal(countLine, EN.dlg.seg.previewCount.replace('{n}', String(exp.length / 2)), 'the status line says how many');
  assert.ok(!t.shell.activeRoi, 'a cancelled dialog changes no selection');
  // the preview is not an edit: no undo step, no new image
  assert.equal((await t.docs()).length, 1);
  assert.equal((await t.docs())[0].undoDepth, 0);
  // and the harness' own preview round trip (Preview ticked, then unticked) runs the compute without error
  await t.runCommand('procFindMaxima', { prominence: 15, output: 'count' });
  t.close();
});

await test('Find Maxima…: 32-bit image, float prominence', async () => {
  const t = await boot({ volume: VOL });
  await t.open();
  await t.runCommand('typeBit32', {});
  const id = t.activeId();
  const px = Float32Array.from(await t.pixels(id, 0));
  const exp = await IJSeg.findMaxima({ data: px, width: 80, height: 60 }, { tolerance: 7.5, strict: false, excludeOnEdges: false, outputType: IJSeg.POINT_SELECTION, threshold: IJSeg.NO_THRESHOLD, roi: null, mask: null, contains: null });
  await t.runCommand('procFindMaxima', { prominence: 7.5, output: 'points' });
  same(t.shell.activeRoi.points.flat().map((v) => v - 0.5), A(exp.points), '32-bit maxima');
  t.close();
});

await sleep(0);
console.log(`\n${passed} tests passed`);
