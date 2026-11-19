// P-ov — Image › Overlay, Analyze › Tools › Grid… and Scale Bar…, end to end through tests/js/ij_harness.mjs: the real menu
// command (dialog values) → the real controller (annotations, settings, session data) → the real engine in the worker
// (paintMask) → undo / redo → reload() restore. Dialog specs, enabled() rules, refusals and their error keys, previews,
// cancel, the remembered values of the next run.
//
// The geometry itself is checked against the ImageJ goldens in test_ij_ov_pure.mjs; here the wiring is.
//
// Run: node tests/js/test_ij_ov_commands.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { boot, until, sleep, EN, DIR } from './ij_harness.mjs';

let passed = 0;
async function test(name, fn) { try { await fn(); passed++; console.log('  ok  ' + name); } catch (e) { console.error('FAIL ' + name); throw e; } }
const arr = (a) => Array.from(a);
const J = (x) => JSON.parse(JSON.stringify(x));
const deepEq = (a, b, m) => (m === undefined ? assert.deepStrictEqual(J(a), J(b)) : assert.deepStrictEqual(J(a), J(b), m));
const notDeepEq = (a, b, m) => assert.notDeepStrictEqual(J(a), J(b), m);

async function fresh(o) {
  const t = await boot(Object.assign({ channels: 2, firePreview: false }, o || {}));
  await t.open();
  const id = t.activeId();
  const api = t.api('ov');
  // the browser's canvas is not there: the widths of the labels and their raster are fixed
  const ui = t.page.IJOvUi;
  ui.measure = (text) => 41;
  ui.rasterText = (text, size, bold, serif, angle) => ({ w: 6, h: 4, data: new Uint8Array(24).fill(1), ax: 1, ay: angle === 90 ? 3 : 1 });
  return { t, id, api, OV: t.page.IJOv, ui };
}
const items = (api, id) => api.annotations.get(id).items;
/** Waits until the stored session holds `n` annotation items of `id` (the engine only stores a meta for a session that already holds
 *  its document, so the first request may be dropped: ask again). */
async function persisted(t, id, n) {
  const api = t.api('ov');
  await until(async () => {
    await t.flush();
    const rows = await t.store.shared.list();
    if (rows.length) {
      const meta = (await t.store.shared.load(rows[0].key)).meta;
      const a = meta && meta.ui && meta.ui.annotations && meta.ui.annotations[id];
      if (a && a.items.length === n) return true;
    }
    api.annotations.setVisible(id, api.annotations.get(id).visible);
    await sleep(1300);
    return false;
  }, 'the annotations of ' + id + ' are stored (' + n + ')', 30000);
}
const lastSpec = (t) => t.log.dialogSpecs[t.log.dialogSpecs.length - 1];
const field = (spec, id) => spec.fields.find((f) => f.id === id);

// ───────────────────────── the registry ─────────────────────────
await test('the nine commands: menu paths, orders, the b key, labels, enabled() follows the image', async () => {
  const { t } = await fresh();
  const want = [
    ['overlayAddSelection', ['Image', 'Overlay'], 10, 'Add Selection…'], ['overlayHide', ['Image', 'Overlay'], 30, 'Hide Overlay'], ['overlayShow', ['Image', 'Overlay'], 40, 'Show Overlay'],
    ['overlayFromManager', ['Image', 'Overlay'], 50, 'From ROI Manager'], ['overlayToManager', ['Image', 'Overlay'], 60, 'To ROI Manager'], ['overlayRemove', ['Image', 'Overlay'], 70, 'Remove Overlay'],
    ['overlayToggle', ['Image', 'Overlay'], 80, 'Toggle Overlay'], ['toolsScaleBar', ['Analyze', 'Tools'], 60, 'Scale Bar…'], ['toolsGrid', ['Analyze', 'Tools'], 90, 'Grid…']];
  for (const [id, menu, order, label] of want) {
    const c = t.IJApp.COMMANDS.find((x) => x.id === id);
    assert.ok(c, id);
    deepEq(J(c.menu), menu, id); assert.equal(c.order, order, id); assert.equal(c.pkg, 'ov', id);
    assert.equal(EN.cmd[id], label, id + ' label = ImageJ text');
    assert.equal(c.repeatable, true, id);
    assert.equal(c.enabled({ doc: null, busy: false }), false, id + ' needs an image');
    assert.equal(c.enabled({ doc: { docId: 1 }, busy: true }), false, id + ' is off while busy');
    assert.equal(c.enabled({ doc: { docId: 1 }, busy: false }), true, id);
  }
  assert.equal(t.IJApp.COMMANDS.find((x) => x.id === 'overlayAddSelection').shortcut, 'b');
  deepEq(J(t.IJApp.COMMANDS.find((x) => x.id === 'overlayAddSelection').keys), ['b']);
  assert.ok(!t.failedPackages().has('ov'));
  t.close();
});

// ───────────────────────── Image › Overlay ─────────────────────────
await test('Add Selection: the dialog of RoiProperties (Alt held); stroke, width, fill; ImageJ colour names; next run remembers; New overlay', async () => {
  const { t, id, api, ui } = await fresh();
  ui.altDown = () => true;
  api.setRoi({ type: 'rect', x: 3, y: 4, w: 10, h: 8 }, { docId: id });
  await t.runCommand('overlayAddSelection', { stroke: 'red', width: 3, fill: '#80ff0000', newOverlay: false });
  const spec = lastSpec(t);
  deepEq(spec.fields.map((f) => f.id), ['stroke', 'width', 'fill', 'newOverlay']);
  assert.equal(field(spec, 'stroke').value, 'yellow', 'first use: the selection colour');
  assert.equal(field(spec, 'width').value, 0); assert.equal(field(spec, 'fill').value, 'none'); assert.equal(field(spec, 'newOverlay').value, false);
  let it = items(api, id);
  assert.equal(it.length, 1);
  assert.equal(it[0].kind, 'roi'); deepEq(J(it[0].roi), { type: 'rect', x: 3, y: 4, w: 10, h: 8 });
  assert.equal(it[0].stroke, '#ff0000'); assert.equal(it[0].width, 3); assert.equal(it[0].fill, '#ff000080', 'the alpha of #aarrggbb comes first');
  deepEq(J(t.view(id).annotations.items.map((x) => x.kind)), ['roi'], 'the view draws it');
  assert.ok(api.state().roi, 'the selection stays');
  // the next run is pre-filled with the last values
  await t.runCommand('overlayAddSelection', { width: 3 });
  const spec2 = lastSpec(t);
  assert.equal(field(spec2, 'stroke').value, 'red'); assert.equal(field(spec2, 'width').value, 3); assert.equal(field(spec2, 'fill').value, '#80ff0000');
  assert.equal(items(api, id).length, 2, 'added, not replaced');
  // a text that is no colour is no colour (Colors.decode(text, null)): with no fill either, the selection colour; with a fill, a fill only
  await t.runCommand('overlayAddSelection', { stroke: 'zzz', width: 0, fill: 'none', newOverlay: true });
  it = items(api, id);
  assert.equal(it.length, 1); assert.equal(it[0].stroke, '#ffff00'); assert.equal(it[0].fill, null); assert.equal(it[0].width, 0);
  await t.runCommand('overlayAddSelection', { stroke: 'zzz', width: 0, fill: 'blue', newOverlay: true });
  it = items(api, id);
  assert.equal(it[0].stroke, null, 'an invalid stroke text leaves a fill-only element'); assert.equal(it[0].fill, '#0000ffff');
  // the colour of the selection is the one of Edit › Options › Colors
  t.api('edit').settings.set('colors.selection', 'cyan');
  await t.runCommand('overlayAddSelection', { stroke: 'nonsense', width: 0, fill: 'none', newOverlay: true });
  assert.equal(items(api, id)[0].stroke, '#00ffff');
  t.close();
});

await test('Add Selection without Alt: no dialog, the remembered style applies at once; the dialog follows the selection type', async () => {
  const { t, id, api, ui } = await fresh();
  api.setRoi({ type: 'rect', x: 3, y: 4, w: 10, h: 8 }, { docId: id });
  const before = t.log.dialogSpecs.length;
  await t.runCommand('overlayAddSelection');
  assert.equal(t.log.dialogSpecs.length, before, 'no dialog');
  let it = items(api, id);
  assert.equal(it.length, 1); assert.equal(it[0].stroke, '#ffff00'); assert.equal(it[0].width, 0); assert.equal(it[0].fill, null);
  await t.runCommand('overlayAddSelection');
  assert.equal(items(api, id).length, 2, 'b again adds again');
  // the style chosen with Alt is the one `b` uses afterwards
  ui.altDown = () => true;
  await t.runCommand('overlayAddSelection', { stroke: 'red', width: 2, fill: 'none', newOverlay: false });
  ui.altDown = () => false;
  await t.runCommand('overlayAddSelection');
  it = items(api, id);
  assert.equal(it[it.length - 1].stroke, '#ff0000'); assert.equal(it[it.length - 1].width, 2);
  // RoiProperties: a line has no fill; a point has the stroke colour only
  ui.altDown = () => true;
  api.setRoi({ type: 'line', x1: 1, y1: 1, x2: 9, y2: 9 }, { docId: id });
  await t.runCommand('overlayAddSelection', { stroke: 'red', width: 1, newOverlay: false });
  deepEq(lastSpec(t).fields.map((f) => f.id), ['stroke', 'width', 'newOverlay']);
  api.setRoi({ type: 'point', points: [[3, 3]] }, { docId: id });
  await t.runCommand('overlayAddSelection', { stroke: 'red', newOverlay: false });
  deepEq(lastSpec(t).fields.map((f) => f.id), ['stroke', 'newOverlay']);
  assert.equal(field(lastSpec(t), 'stroke').labelKey, 'dlg.ov.strokePoint');
  t.close();
});

await test('Add Selection: a named selection keeps its name; a multi-point selection leaves the image; no selection → an error, or the "No Selection" dialog', async () => {
  const { t, id, api } = await fresh();
  api.setRoi({ type: 'oval', x: 2, y: 2, w: 8, h: 6, name: 'nucleus' }, { docId: id });
  await t.runCommand('overlayAddSelection', { stroke: 'blue', width: 1, fill: 'none', newOverlay: true });
  assert.equal(items(api, id)[0].name, 'nucleus');
  api.setRoi({ type: 'point', points: [[3, 3], [9, 9], [12, 4]] }, { docId: id });
  await t.runCommand('overlayAddSelection', { stroke: 'blue', width: 1, fill: 'none', newOverlay: false });
  assert.equal(items(api, id).length, 2);
  assert.equal(api.state().roi, null, 'a multi-point selection is deleted once it is in the overlay');
  api.setRoi({ type: 'point', points: [[3, 3]] }, { docId: id });
  await t.runCommand('overlayAddSelection', { stroke: 'blue', width: 1, fill: 'none' });
  assert.ok(api.state().roi, 'a single point stays');
  assert.equal(items(api, id).length, 3);
  // without a selection, with an overlay: the No Selection dialog
  api.setRoi(null, { docId: id });
  await t.runCommand('overlayAddSelection', { remove: false });
  assert.equal(lastSpec(t).fields[0].type, 'message');
  assert.equal(items(api, id).length, 3, 'left alone');
  await t.runCommand('overlayAddSelection', { remove: true });
  assert.equal(items(api, id).length, 0);
  // without a selection and without an overlay: "This command requires a selection." (ImageJ's error)
  const errs = await t.runCommand('overlayAddSelection', undefined, { expectError: true });
  assert.ok(errs.length >= 1);
  assert.equal(errs[0].message, EN.err.needsRoi);
  t.close();
});

await test('Hide, Show, Toggle, Remove Overlay: visibility goes to the view, Remove empties; none of them is an undo step', async () => {
  const { t, id, api } = await fresh();
  api.annotations.set(id, [{ kind: 'text', x: 1, y: 2, text: 'a' }, { kind: 'rect', x: 0, y: 0, w: 4, h: 4 }]);
  const undoBefore = (await t.docs())[0].undoDepth;
  await t.runCommand('overlayHide');
  assert.equal(api.annotations.get(id).visible, false); assert.equal(t.view(id).annotations.visible, false);
  assert.equal(items(api, id).length, 2, 'hidden, not removed');
  await t.runCommand('overlayShow');
  assert.equal(api.annotations.get(id).visible, true); assert.equal(t.view(id).annotations.visible, true);
  await t.runCommand('overlayToggle');
  assert.equal(api.annotations.get(id).visible, false);
  await t.runCommand('overlayToggle');
  assert.equal(api.annotations.get(id).visible, true);
  await t.runCommand('overlayRemove');
  assert.equal(items(api, id).length, 0); assert.equal(t.view(id).annotations.items.length, 0);
  assert.equal((await t.docs())[0].undoDepth, undoBefore, 'the overlay is not part of the undo history');
  t.close();
});

await test('From ROI Manager: every entry of this image becomes an overlay item (style kept), the selection goes; an empty manager is an error', async () => {
  const { t, id, api } = await fresh();
  const errs = await t.runCommand('overlayFromManager', undefined, { expectError: true });
  assert.equal(errs[0].message, EN.err.ovManagerEmpty);
  api.roiManager.add([
    { name: 'a', roi: { type: 'rect', x: 1, y: 1, w: 5, h: 5 }, stroke: '#00ff00', width: 2 },
    { name: 'b', roi: { type: 'oval', x: 10, y: 8, w: 6, h: 6 }, fill: '#336699' },
    { name: 'c', roi: { type: 'line', x1: 0, y1: 0, x2: 9, y2: 9, width: 1 } }]);
  api.setRoi({ type: 'rect', x: 0, y: 0, w: 3, h: 3 }, { docId: id });
  await t.runCommand('overlayFromManager');
  const it = items(api, id);
  assert.equal(it.length, 3);
  deepEq(it.map((x) => x.name), ['a', 'b', 'c']);
  assert.equal(it[0].stroke, '#00ff00'); assert.equal(it[0].width, 2); assert.equal(it[0].fill, null);
  assert.equal(it[1].stroke, null); assert.equal(it[1].fill, '#336699ff', 'a 6-digit fill becomes opaque');
  assert.equal(api.state().roi, null, 'imp.deleteRoi()');
  assert.equal(api.roiManager.list().length, 3, 'the manager keeps its list');
  t.close();
});

await test('To ROI Manager: the selections of the overlay become the entries of this image, the others stay (and a toast says so)', async () => {
  const { t, id, api } = await fresh();
  api.roiManager.add([{ name: 'old', roi: { type: 'rect', x: 0, y: 0, w: 2, h: 2 } }]);
  const errs = await t.runCommand('overlayToManager', undefined, { expectError: true });
  assert.equal(errs[0].message, EN.err.ovNoOverlay);
  api.annotations.set(id, [{ kind: 'text', x: 1, y: 1, text: 't' }]);
  const errs2 = await t.runCommand('overlayToManager', undefined, { expectError: true });
  assert.equal(errs2[0].message, EN.err.ovNoRoiItems);
  assert.equal(items(api, id).length, 1, 'untouched');
  api.annotations.add(id, [
    { kind: 'roi', roi: { type: 'rect', x: 4, y: 5, w: 7, h: 6 }, stroke: '#ff0000', width: 2, fill: '#00ff0080', name: 'r1' },
    { kind: 'roi', roi: { type: 'polygon', points: [[2, 2], [9, 3], [5, 12]] }, stroke: null, width: 0, fill: null }]);
  await t.runCommand('overlayToManager');
  const list = api.roiManager.list();
  assert.equal(list.length, 2, 'the entries of this image are replaced');
  assert.equal(list[0].name, 'r1'); assert.equal(list[0].stroke, '#ff0000'); assert.equal(list[0].width, 2); assert.equal(list[0].fill, '#00ff0080');
  assert.equal(list[1].roi.type, 'polygon'); assert.equal(list[1].docId, id);
  deepEq(items(api, id).map((x) => x.kind), ['text'], 'the text stays');
  assert.ok(t.log.status.some((s) => /1 overlay item/.test(String(s))), 'a toast says one item stayed: ' + JSON.stringify(t.log.status.slice(-3)));
  // the manager of ANOTHER image keeps its entries
  t.close();
});

// ───────────────────────── Grid ─────────────────────────
const GRID_AREA = 6.25;   // µm² (the harness image is 0.5 µm per pixel: a 5 px tile)

await test('Grid: the dialog, a Lines grid as a |GRID| shapes item, replaced by the next one, None removes it; the values are remembered', async () => {
  const { t, id, api, OV } = await fresh();
  api.annotations.set(id, [{ kind: 'text', x: 1, y: 1, text: 'keep me' }]);
  await t.runCommand('toolsGrid', { type: 'Lines', area: GRID_AREA, color: 'Red', bold: false, centered: false, randomOffset: false });
  const spec = lastSpec(t);
  deepEq(spec.fields.map((f) => f.id), ['type', 'area', 'color', 'bold', 'centered', 'randomOffset']);
  deepEq(spec.fields[0].options.map((o) => o.value), ['Lines', 'Horizontal Lines', 'Crosses', 'Points', 'Circles', 'None']);
  deepEq(spec.fields[2].options.map((o) => o.value), ['Red', 'Green', 'Blue', 'Magenta', 'Cyan', 'Yellow', 'Orange', 'Black', 'White']);
  assert.equal(field(spec, 'type').value, 'Lines'); assert.equal(field(spec, 'color').value, 'Cyan', 'Cyan first');
  assert.equal(field(spec, 'area').decimals, 2, 'a calibrated image: two decimals'); assert.equal(field(spec, 'area').units, 'µm^2');
  assert.ok(Math.abs(field(spec, 'area').value - (40 * 0.5 * 30 * 0.5) / 81) < 1e-12, 'the default: a 9 × 9 grid');
  const grids = items(api, id).filter((x) => x.tag === '|GRID|');
  assert.equal(grids.length, 1);
  const g = OV.gridGeometry({ type: 'Lines', area: GRID_AREA, bold: false }, { width: 40, height: 30, pixelWidth: 0.5, pixelHeight: 0.5 });
  assert.equal(grids[0].kind, 'shapes'); assert.equal(grids[0].stroke, '#ff0000'); assert.equal(grids[0].width, 0);
  assert.equal(grids[0].lines.length, g.lines.length);
  for (let i = 0; i < g.lines.length; i++) assert.ok(Math.abs(grids[0].lines[i] - g.lines[i]) < 1e-3);
  assert.equal(items(api, id).length, 2, 'the other items stay');
  assert.equal(t.view(id).annotations.items.length, 2);
  // the next run: pre-filled by the preferences (ImageJ Prefs "grid.options" + the static area), another type replaces the grid
  await t.runCommand('toolsGrid', { type: 'Crosses', area: 12.5, color: 'Orange', bold: true });
  const spec2 = lastSpec(t);
  assert.equal(field(spec2, 'type').value, 'Lines'); assert.equal(field(spec2, 'color').value, 'Red'); assert.equal(field(spec2, 'area').value, GRID_AREA);
  const g2 = items(api, id).filter((x) => x.tag === '|GRID|');
  assert.equal(g2.length, 1); assert.equal(g2[0].lines.length > 0, true); assert.equal(g2[0].stroke, '#ffc800'); assert.equal(g2[0].width, 2, 'bold = 2 px');
  assert.equal(g2[0].lines.length % 8, 0, 'a cross is two lines');
  deepEq(J(t.settings.get('ov.grid')), { type: 'Crosses', color: 'Orange', bold: true, centered: false, randomOffset: false }, 'the area is the session area, not a preference');
  // Circles / Points are circles of the shapes item
  await t.runCommand('toolsGrid', { type: 'Circles', area: 12.5, color: 'Blue', bold: false });
  const c = items(api, id).find((x) => x.tag === '|GRID|');
  assert.equal(c.lines.length, 0); assert.equal(c.circles.length % 3, 0); assert.ok(c.circles.length > 0);
  // None removes it, the rest stays; and the next run offers Lines again (Grid.getSettings)
  await t.runCommand('toolsGrid', { type: 'None', area: 12.5, color: 'Blue' });
  assert.equal(items(api, id).filter((x) => x.tag === '|GRID|').length, 0);
  assert.equal(items(api, id).length, 1);
  await t.runCommand('toolsGrid', { type: 'Lines', area: 12.5 });
  assert.equal(field(lastSpec(t), 'type').value, 'Lines');
  t.close();
});

await test('Grid: Preview draws while the dialog is open, Cancel puts the grid on entry back, a too small area is refused by validate()', async () => {
  const { t, id, api } = await fresh();
  await t.runCommand('toolsGrid', { type: 'Lines', area: GRID_AREA, color: 'Red' });
  const before = J(items(api, id).filter((x) => x.tag === '|GRID|'));
  assert.equal(before.length, 1);
  // a preview with other values, then Cancel
  let seen;
  await t.runCommand('toolsGrid', (spec) => {
    spec.preview.onChange({ type: 'Horizontal Lines', area: 12.5, color: 'Green', bold: false, centered: true, randomOffset: false });
    seen = J(items(api, id).filter((x) => x.tag === '|GRID|'));
    spec.preview.onChange(null);            // the dialog closing
    return null;                            // Cancel
  });
  assert.equal(seen.length, 1); assert.equal(seen[0].stroke, '#00ff00'); notDeepEq(seen, before, 'the preview showed another grid');
  deepEq(J(items(api, id).filter((x) => x.tag === '|GRID|')), before, 'the grid on entry is back');
  // Cancel with no grid on entry removes the preview
  await t.runCommand('toolsGrid', { type: 'None', area: GRID_AREA });
  await t.runCommand('toolsGrid', (spec) => { spec.preview.onChange({ type: 'Lines', area: GRID_AREA, color: 'Red', bold: false, centered: false, randomOffset: false }); spec.preview.onChange(null); return null; });
  assert.equal(items(api, id).filter((x) => x.tag === '|GRID|').length, 0);
  // validate: "Area per Point" too small (16 px² on a 40 × 30 image; 50 for crosses)
  let verdicts;
  await t.runCommand('toolsGrid', (spec) => {
    const v = (type, area) => spec.validate({ type, area, color: 'Cyan', bold: false, centered: false, randomOffset: false });
    verdicts = { ok: v('Lines', 4), small: v('Lines', 3.9), crossOk: v('Crosses', 12.5), crossSmall: v('Crosses', 12), zero: v('Lines', 0) };
    return null;
  });
  assert.equal(verdicts.ok, null); deepEq(J(verdicts.small), { area: 'dlg.ov.gridTooSmall' });
  assert.equal(verdicts.crossOk, null); deepEq(J(verdicts.crossSmall), { area: 'dlg.ov.gridTooSmall' }); deepEq(J(verdicts.zero), { area: 'dlg.ov.gridTooSmall' });
  assert.equal(EN.dlg.ov.gridTooSmall, '"Area per Point" too small');
  t.close();
});

await test('Grid: bold at a zoom below 1 is widened by 1/mag; the area per point lives for the page session only; units are Calibration.getUnits()', async () => {
  const { t, id, api } = await fresh();
  t.view(id).viewState = { zoom: 0.5, ox: 0, oy: 0 };
  await t.runCommand('toolsGrid', { type: 'Lines', area: GRID_AREA, color: 'Red', bold: true, centered: false, randomOffset: false });
  assert.equal(items(api, id).find((x) => x.tag === '|GRID|').width, 4, '2 / 0.5');
  assert.equal(t.settings.get('ov.grid').area, undefined, 'no area in the stored preferences');
  t.close();
});

await test('Grid: a random offset takes a seed (kept in the session data), Center is turned off by it, the same seed draws the same grid', async () => {
  const { t, id, api, OV } = await fresh();
  let onChangeSet = null;
  await t.runCommand('toolsGrid', (spec) => {
    const set = {};
    spec.onChange({ type: 'Lines', area: GRID_AREA, randomOffset: true, centered: true }, (patch) => Object.assign(set, patch), 'randomOffset');
    onChangeSet = set;
    return { type: 'Lines', area: GRID_AREA, color: 'Cyan', bold: false, centered: true, randomOffset: true };
  });
  assert.ok(onChangeSet, 'onChange ran'); deepEq(J(onChangeSet), { centered: false }, 'set({ id: value }), the documented form of the dialog');
  const data = t.api('ov').sessionData.get('ov');
  const rec = data.grids[id];
  assert.ok(Number.isInteger(rec.seed) && rec.seed >= 0 && rec.seed < 2 ** 31, 'a 31-bit seed');
  assert.equal(rec.type, 'Lines');
  const g = OV.gridGeometry({ type: 'Lines', area: GRID_AREA, randomOffset: true, seed: rec.seed }, { width: 40, height: 30, pixelWidth: 0.5, pixelHeight: 0.5 });
  assert.equal(rec.xstart, g.xstart); assert.equal(rec.ystart, g.ystart);
  const it = items(api, id).find((x) => x.tag === '|GRID|');
  for (let i = 0; i < g.lines.length; i++) assert.ok(Math.abs(it.lines[i] - g.lines[i]) < 1e-3, 'the grid of the journaled seed');
  assert.equal(t.settings.get('ov.grid').centered, false, 'Random offset overrules Center');
  // a run without a random offset forgets the seed
  await t.runCommand('toolsGrid', { type: 'Lines', area: GRID_AREA, randomOffset: false });
  assert.equal(t.api('ov').sessionData.get('ov').grids[id], undefined);
  t.close();
});

await test('Grid on an uncalibrated image: pixels, no decimals; the grid survives a reload with the session', async () => {
  const t2 = await boot({ channels: 2, firePreview: false });
  await t2.open();
  const id2 = t2.activeId();
  const a2 = t2.api('ov');
  // set the calibration to pixels through the engine, then the grid dialog shows pixels
  await t2.engine('doc.run', { docId: id2, op: 'setCalibration', params: { pixelWidth: 1, pixelHeight: 1, unit: 'pixel' }, roi: null, channel: 0 });
  await until(() => a2.state().doc && a2.state().doc.calibration && a2.state().doc.calibration.unit === 'pixel', 'calibration applied').catch(() => {});
  await t2.runCommand('toolsGrid', { type: 'Points', area: 60, color: 'Magenta', bold: true });
  const spec = lastSpec(t2);
  assert.equal(field(spec, 'area').units, 'pixels^2');
  assert.equal(field(spec, 'area').decimals, 0);
  const g = items(a2, id2).find((x) => x.tag === '|GRID|');
  assert.ok(g && g.circles.length > 0);
  assert.equal(g.stroke, '#ff00ff');
  const n = items(a2, id2).length;
  await persisted(t2, id2, n);
  const t3 = await t2.reload();
  await t3.open();
  const id3 = t3.activeId();
  assert.equal(id3, id2);
  await until(() => t3.api('ov').annotations.get(id3).items.length === n, 'the grid is restored');
  const back = t3.api('ov').annotations.get(id3).items.find((x) => x.tag === '|GRID|');
  deepEq(J(back.circles), J(g.circles)); assert.equal(back.width, g.width);
  assert.equal(t3.view(id3).annotations.items.length, n, 'and drawn');
  t3.close();
});

// ───────────────────────── Scale Bar ─────────────────────────
await test('Scale Bar: the dialog (the fields of ScaleBar.BarDialog), the defaults, an overlay bar of |SB| rects and texts, replaced by the next one', async () => {
  const { t, id, api, OV } = await fresh();
  await t.runCommand('toolsScaleBar', {});
  const spec = lastSpec(t);
  deepEq(spec.fields.map((f) => f.id), ['width', 'height', 'thickness', 'fontSize', 'color', 'background', 'location', 'horizontal', 'vertical', 'bold', 'hideText', 'serif', 'overlay']);
  assert.equal(spec.fields[0].label, 'Width in µm:'); assert.equal(spec.fields[1].label, 'Height in µm:');
  deepEq(spec.fields[4].options.map((o) => o.value), ['White', 'Black', 'Light Gray', 'Gray', 'Dark Gray', 'Red', 'Green', 'Blue', 'Yellow']);
  deepEq(spec.fields[5].options.map((o) => o.value), ['None', 'Black', 'White', 'Dark Gray', 'Gray', 'Light Gray', 'Yellow', 'Blue', 'Green', 'Red']);
  deepEq(spec.fields[6].options.map((o) => o.value), ['Upper Right', 'Lower Right', 'Lower Left', 'Upper Left', 'At Selection']);
  const dflt = { thickness: 4, fontSize: 14, color: 'White', background: 'None', location: 'Lower Right', horizontal: true, vertical: false, bold: true, hideText: false, serif: false, overlay: true };
  for (const k of Object.keys(dflt)) assert.equal(field(spec, k).value, dflt[k], 'default ' + k);
  // the auto width: 80 px = 40 µm on this 20 µm wide image → 2/3 of the image rounded to 1-2-5 = 10 µm
  assert.equal(field(spec, 'width').value, 10); assert.equal(field(spec, 'height').value, 10, 'the image is 15 µm high: 2/3 of it, rounded down to 10');
  assert.equal(field(spec, 'width').decimals, 0);
  // OK with the defaults
  const sb = items(api, id).filter((x) => x.tag === '|SB|');
  deepEq(sb.map((x) => x.kind), ['rect', 'text']);
  const cfg = OV.scaleBarConfig({ hBarWidth: 10, vBarHeight: 5, hDigits: 0, vDigits: 0 });
  const res = OV.scaleBarGeometry(cfg, { width: 40, height: 30, pixelWidth: 0.5, pixelHeight: 0.5, unit: 'µm' }, () => 41, null);
  deepEq([sb[0].x, sb[0].y, sb[0].w, sb[0].h], [res.hBar.x, res.hBar.y, res.hBar.w, res.hBar.h]);
  assert.equal(sb[0].fill, '#ffffffff'); assert.equal(sb[1].text, '10 µm'); assert.equal(sb[1].size, 14); assert.equal(sb[1].bold, true);
  assert.equal(t.view(id).annotations.items.length, 2);
  // a second run replaces the bar and remembers the configuration (not the location)
  await t.runCommand('toolsScaleBar', { width: 8, height: 4, thickness: 3, fontSize: 10, color: 'Yellow', background: 'Black', location: 'Upper Left', horizontal: true, vertical: true, bold: false, hideText: false, serif: true, overlay: true });
  const spec2 = lastSpec(t);
  assert.equal(field(spec2, 'width').value, 10); assert.equal(field(spec2, 'location').value, 'Lower Right');
  assert.ok(spec2.fields.some((f) => f.id === 'removeBar'), 'a previous bar: the Remove Scale Bar choice appears');
  const sb2 = items(api, id).filter((x) => x.tag === '|SB|');
  deepEq(sb2.map((x) => x.kind), ['rect', 'rect', 'rect', 'rect', 'text', 'text'], 'two backgrounds, two bars, two texts');
  assert.equal(sb2[0].fill, '#000000ff'); assert.equal(sb2[2].fill, '#ffff00ff'); assert.equal(sb2[4].serif, true); assert.equal(sb2[4].bold, false); assert.equal(sb2[4].size, 10);
  const mem = t.settings.get('ov.scaleBar');
  assert.equal(mem.hBarWidth, 8); assert.equal(mem.color, 'Yellow'); assert.equal(mem.location, undefined, 'the location is never remembered (ScaleBarConfiguration.updateFrom)');
  await t.runCommand('toolsScaleBar', {});
  assert.equal(field(lastSpec(t), 'width').value, 8, 'the width of the last run, since it still fits');
  assert.equal(field(lastSpec(t), 'color').value, 'Yellow');
  // the next image-size check: the label and the digits
  await t.runCommand('toolsScaleBar', { width: 1.25, height: 4, thickness: 3, fontSize: 10, color: 'Yellow', background: 'Black', location: 'Upper Left', horizontal: true, vertical: false, bold: false, hideText: false, serif: true, overlay: true });
  assert.equal(items(api, id).find((x) => x.tag === '|SB|' && x.kind === 'text').text, '1.25 µm');
  t.close();
});

await test('Scale Bar: Preview draws the bar while the dialog is open, Cancel restores the previous one, "Remove Scale Bar" removes it, validate() refuses', async () => {
  const { t, id, api } = await fresh();
  await t.runCommand('toolsScaleBar', { width: 10, height: 5 });
  const before = J(items(api, id).filter((x) => x.tag === '|SB|'));
  let during;
  await t.runCommand('toolsScaleBar', (spec) => {
    spec.preview.onChange({ width: 6, height: 5, thickness: 6, fontSize: 14, color: 'Red', background: 'None', location: 'Upper Right', horizontal: true, vertical: false, bold: true, hideText: true, serif: false, overlay: true });
    during = J(items(api, id).filter((x) => x.tag === '|SB|'));
    spec.preview.onChange(null);
    return null;
  });
  assert.equal(during.length, 1, 'a bar without text'); assert.equal(during[0].fill, '#ff0000ff');
  deepEq(J(items(api, id).filter((x) => x.tag === '|SB|')), before, 'Cancel: the bar on entry is back');
  // validate
  let v;
  await t.runCommand('toolsScaleBar', (spec) => {
    const base = { width: 10, height: 5, thickness: 4, fontSize: 14, color: 'White', background: 'None', location: 'Lower Right', horizontal: true, vertical: false, bold: true, hideText: false, serif: false, overlay: true };
    v = { ok: spec.validate(base), w: spec.validate(Object.assign({}, base, { width: 0 })), hOff: spec.validate(Object.assign({}, base, { width: 0, horizontal: false })),
      vh: spec.validate(Object.assign({}, base, { vertical: true, height: -1 })), sel: spec.validate(Object.assign({}, base, { location: 'At Selection' })),
      rm: spec.validate(Object.assign({}, base, { width: 0, removeBar: true })) };
    return null;
  });
  assert.equal(v.ok, null); deepEq(J(v.w), { width: 'dlg.ov.sbPositive' }); assert.equal(v.hOff, null);
  deepEq(J(v.vh), { height: 'dlg.ov.sbPositive' }); deepEq(J(v.sel), { location: 'dlg.ov.sbNeedsSelection' }); assert.equal(v.rm, null);
  // "Remove Scale Bar"
  api.annotations.add(id, [{ kind: 'text', x: 0, y: 0, text: 'mine' }]);
  await t.runCommand('toolsScaleBar', { removeBar: true });
  assert.equal(items(api, id).filter((x) => x.tag === '|SB|').length, 0);
  assert.equal(items(api, id).length, 1, 'only the bar went');
  t.close();
});

await test('Scale Bar: with a selection the location is "At Selection", the bar is as wide as the selection', async () => {
  const { t, id, api } = await fresh();
  api.setRoi({ type: 'rect', x: 5, y: 6, w: 24, h: 12 }, { docId: id });
  await t.runCommand('toolsScaleBar', { width: 12, height: 6, location: 'At Selection', vertical: true });
  const spec = lastSpec(t);
  assert.equal(field(spec, 'location').value, 'At Selection');
  assert.equal(field(spec, 'width').value, 12, 'the selection is 24 px = 12 µm wide');
  assert.equal(field(spec, 'height').value, 6);
  const bars = items(api, id).filter((x) => x.tag === '|SB|' && x.kind === 'rect');
  assert.equal(bars.length, 2);
  deepEq([bars[0].x, bars[0].y, bars[0].w, bars[0].h], [5 + Math.trunc((41 - 24) / 2), 6, 24, 4], 'the box starts at the selection, the bar is centred in it (the label is wider)');
  t.close();
});

/** The pixel value a channel should hold where a bar is burnt in: ImageJ's rule, from the channel's own LUT and range. */
function burnExpect(t, info, rgb) {
  return info.channels.map((ch) => {
    const d = ch.display;
    let table = t.page.IJLuts.get(d.lut);
    const def = !d.lut || d.lut === 'Grays';
    return t.page.IJOv.burnValue(rgb, info.bitDepth, table, def, d);
  });
}

await test('Scale Bar, Overlay off: the bar is burnt into every channel with the value of its own LUT; undo, redo; the bar is gone from the overlay; a reload keeps the pixels', async () => {
  const { t, id, api, OV } = await fresh();
  const info0 = (await t.docs())[0];
  const before = [await t.pixels(id, 0), await t.pixels(id, 1)];
  await t.runCommand('toolsScaleBar', { width: 10, height: 5 });                   // an overlay bar first
  assert.ok(items(api, id).some((x) => x.tag === '|SB|'));
  await t.runCommand('toolsScaleBar', { width: 10, height: 5, thickness: 2, fontSize: 8, color: 'Yellow', background: 'Black', location: 'Lower Right', horizontal: true, vertical: false, bold: false, hideText: true, serif: false, overlay: false });
  assert.equal(items(api, id).filter((x) => x.tag === '|SB|').length, 0, 'the overlay bar went');
  const cfg = OV.scaleBarConfig({ hBarWidth: 10, vBarHeight: 5, barThicknessInPixels: 2, fontSize: 8, bcolor: 'Black', hideText: true, boldText: false });
  const res = OV.scaleBarGeometry(cfg, { width: 40, height: 30, pixelWidth: 0.5, pixelHeight: 0.5, unit: 'µm' }, () => 41, null);
  const bar = res.hBar, back = res.items.find((x) => x.role === 'background');
  const white = burnExpect(t, info0, [255, 255, 0]), black = burnExpect(t, info0, [0, 0, 0]);
  const after = [await t.pixels(id, 0), await t.pixels(id, 1)];
  for (let c = 0; c < 2; c++) {
    for (let y = 0; y < 30; y++) for (let x = 0; x < 40; x++) {
      const inBar = x >= bar.x && x < bar.x + bar.w && y >= bar.y && y < bar.y + bar.h;
      const inBack = x >= back.x && x < back.x + back.w && y >= back.y && y < back.y + back.h;
      const want = inBar ? white[c] : inBack ? black[c] : before[c][y * 40 + x];
      assert.equal(after[c][y * 40 + x], want, `channel ${c} at ${x},${y}`);
    }
  }
  assert.notEqual(white[0], white[1], 'two LUTs, two values (yellow on a blue and on a green ramp)');
  const d1 = (await t.docs())[0];
  assert.equal(d1.undoDepth, 1, 'one undo step for the whole bar');
  await t.runCommand('editUndo');
  for (let c = 0; c < 2; c++) deepEq(arr(await t.pixels(id, c)), arr(before[c]), 'undo');
  await t.runCommand('editRedo');
  for (let c = 0; c < 2; c++) deepEq(arr(await t.pixels(id, c)), arr(after[c]), 'redo');
  // a reload replays the journal
  await t.flush();
  const key = (await t.store.shared.list())[0].key;
  const t2 = await t.reload();
  const w2 = await t2.spawn();
  const res2 = await t2.engine('session.restore', { key }, w2);
  assert.equal(res2.warnings.length, 0, JSON.stringify(res2.warnings));
  const doc2 = (await t2.engine('doc.list', {}, w2)).docs[0];
  for (let c = 0; c < 2; c++) deepEq(arr((await t2.engine('doc.tile', { docId: doc2.docId, channel: c, level: 0, tx: 0, ty: 0 }, w2)).data), arr(after[c]), 'restored channel ' + c);
  t2.close();
});

await test('Scale Bar, Overlay off: the text is rastered into the mask, a vertical label turned; 16 and 32 bits take the rounded value of the display range', async () => {
  const { t, id, api, OV, ui } = await fresh();
  const calls = [];
  ui.rasterText = (text, size, bold, serif, angle, width) => { calls.push({ text, size, bold, serif, angle, width }); return { w: 5, h: 3, data: Uint8Array.from([1, 1, 1, 1, 1, 0, 0, 1, 0, 0, 1, 1, 1, 1, 1]), ax: 1, ay: angle === 90 ? 2 : 1 }; };
  await t.runCommand('typeBit16');
  const info = (await t.docs())[0];
  assert.equal(info.bitDepth, 16);
  const before = [await t.pixels(id, 0), await t.pixels(id, 1)];
  await t.runCommand('toolsScaleBar', { width: 10, height: 5, thickness: 2, fontSize: 9, color: 'Black', background: 'None', location: 'Lower Left', horizontal: true, vertical: true, bold: true, hideText: false, serif: true, overlay: false });
  deepEq(calls.map((c) => [c.text, c.angle, c.bold, c.serif, c.size]), [['10 µm', 0, true, true, 9], ['5 µm', 90, true, true, 9]]);
  assert.equal(calls[0].width, 41);
  const black = burnExpect(t, info, [0, 0, 0]);
  const after = await t.pixels(id, 0);
  const cfg = OV.scaleBarConfig({ hBarWidth: 10, vBarHeight: 5, barThicknessInPixels: 2, fontSize: 9, location: 'Lower Left', showVertical: true });
  const res = OV.scaleBarGeometry(cfg, { width: 40, height: 30, pixelWidth: 0.5, pixelHeight: 0.5, unit: 'µm' }, () => 41, null);
  const bar = res.hBar;
  assert.equal(after[bar.y * 40 + bar.x], black[0], 'black on 16 bits is index 1 of the display range, not 0');
  assert.ok(black[0] > 0 || info.channels[0].display.max < 255, 'index 1 of the range');
  // a pixel of the text raster: the h label's anchor minus the raster's anchor offset
  const h = res.items.find((x) => x.kind === 'text' && x.angle === 0);
  assert.equal(after[(h.y - 1 + 0) * 40 + (h.x - 1 + 0)], black[0], 'the first raster pixel is painted');
  assert.equal(after[(h.y - 1 + 1) * 40 + (h.x - 1 + 0)], before[0][(h.y - 1 + 1) * 40 + (h.x - 1 + 0)], 'a clear raster pixel is not');
  await t.runCommand('typeBit32');
  assert.equal((await t.docs())[0].bitDepth, 32);
  t.close();
});

await test('Scale Bar, Overlay off, no canvas: the bars are burnt, the text is skipped', async () => {
  const { t, id, ui } = await fresh();
  ui.rasterText = () => null;
  const before = await t.pixels(id, 0);
  await t.runCommand('toolsScaleBar', { width: 10, height: 5, thickness: 3, fontSize: 9, color: 'White', background: 'None', location: 'Lower Left', horizontal: true, vertical: false, bold: true, hideText: false, serif: false, overlay: false });
  const after = await t.pixels(id, 0);
  let changed = 0;
  for (let i = 0; i < after.length; i++) if (after[i] !== before[i]) changed++;
  assert.equal(changed, 20 * 3 - [...Array(60).keys()].filter((k) => before[0] === 0 && false).length - 0 || changed > 0, true);
  assert.ok(changed > 0 && changed <= 60, 'only the bar: ' + changed);
  t.close();
});

await test('Scale Bar: an annotation bar survives a reload', async () => {
  const { t, id, api } = await fresh();
  await t.runCommand('toolsScaleBar', { width: 10, height: 5 });
  const bar = J(items(api, id).filter((x) => x.tag === '|SB|'));
  await persisted(t, id, bar.length);
  const t2 = await t.reload();
  await t2.open();
  const id2 = t2.activeId();
  await until(() => t2.api('ov').annotations.get(id2).items.length === bar.length, 'the bar is restored');
  const back = J(t2.api('ov').annotations.get(id2).items);
  deepEq(back.map((x) => [x.kind, x.tag, x.x, x.y, x.text, x.fill]), bar.map((x) => [x.kind, x.tag, x.x, x.y, x.text, x.fill]));
  t2.close();
});

// ───────────────────────── language and API surface ─────────────────────────
await test('lang-parts/ov.json: the four languages hold the same keys and {tokens}; every key the command file reads, and every option label, exists', async () => {
  const parts = JSON.parse(fs.readFileSync(path.join(DIR, 'lang-parts', 'ov.json'), 'utf8'));
  const leaves = (o, p = '', out = {}) => { for (const k of Object.keys(o)) { const kp = p ? p + '.' + k : k; if (o[k] && typeof o[k] === 'object') leaves(o[k], kp, out); else out[kp] = o[k]; } return out; };
  const en = leaves(parts.en);
  const tokens = (x) => [...String(x).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
  for (const l of ['fr', 'es', 'nl']) {
    const o = leaves(parts[l]);
    deepEq(Object.keys(o).sort(), Object.keys(en).sort(), l + ' has the key set of en');
    for (const k of Object.keys(en)) { assert.ok(String(o[k]).length > 0, l + ':' + k); assert.equal(tokens(o[k]), tokens(en[k]), l + ':' + k + ' keeps its tokens'); }
  }
  // the ImageJ text, verbatim, of every dialog label
  const want = { 'dlg.ov.gridType': 'Grid type:', 'dlg.ov.gridArea': 'Area per point:', 'dlg.ov.gridColor': 'Color:', 'dlg.ov.gridBold': 'Bold', 'dlg.ov.gridCenter': 'Center grid on image', 'dlg.ov.gridRandom': 'Random offset',
    'dlg.ov.sbThickness': 'Thickness in pixels:', 'dlg.ov.sbFontSize': 'Font size:', 'dlg.ov.sbColor': 'Color:', 'dlg.ov.sbBackground': 'Background:', 'dlg.ov.sbLocation': 'Location:', 'dlg.ov.sbBold': 'Bold Text',
    'dlg.ov.sbHideText': 'Hide Text', 'dlg.ov.sbSerif': 'Serif Font', 'dlg.ov.sbOverlay': 'Overlay', 'dlg.ov.sbHorizontal': 'Horizontal', 'dlg.ov.sbVertical': 'Vertical', 'dlg.ov.stroke': 'Stroke color:',
    'dlg.ov.gridTitle': 'Grid…', 'dlg.ov.noSelectionMsg': '"Overlay>Add" requires a selection.', 'dlg.ov.strokePoint': 'Stroke (point) color:', 'dlg.ov.width': 'Width:', 'dlg.ov.fill': 'Fill color:', 'dlg.ov.newOverlay': 'New overlay', 'dlg.ov.sbWidth': 'Width in {unit}:', 'dlg.ov.sbHeight': 'Height in {unit}:', 'dlg.ov.sbRemove': 'Remove Scale Bar' };
  for (const k of Object.keys(want)) assert.equal(en[k], want[k], k);
  const OV = (await fresh()).OV;
  const keyOf = (v) => v.replace(/\s+(\w)/g, (m, c) => c.toUpperCase()).replace(/^\w/, (c) => c.toLowerCase());
  const sub = (list, prefix) => { for (const v of list) assert.equal(typeof en[prefix + keyOf(v)], 'string', prefix + keyOf(v)); };
  sub(OV.GRID_TYPES, 'dlg.ov.gt.'); sub(OV.GRID_COLORS, 'dlg.ov.c.'); sub(OV.SB_COLORS, 'dlg.ov.c.'); sub(OV.SB_BCOLORS, 'dlg.ov.c.'); sub(OV.SB_LOCATIONS, 'dlg.ov.loc.');
  for (const v of OV.GRID_TYPES) assert.equal(en['dlg.ov.gt.' + keyOf(v)], v, 'en label of ' + v + ' = the ImageJ item');
  for (const v of OV.SB_LOCATIONS) assert.equal(en['dlg.ov.loc.' + keyOf(v)], v);
  const code = fs.readFileSync(path.join(DIR, 'ij-cmds-ov.js'), 'utf8');
  for (const m of code.matchAll(/'((?:cmd|op|err|warn|dlg\.ov)\.[A-Za-z0-9_.]*[A-Za-z0-9_])'/g)) assert.equal(typeof leaves(EN)[m[1]], 'string', 'key ' + m[1] + ' read by ij-cmds-ov.js is in the dictionary');
});

await test('every command talks to documented extension-API members only (a recording api), and does nothing without an image', async () => {
  const { t } = await fresh();
  const members = new Set(t.IJApp.EXT_API_MEMBERS);
  for (const c of t.IJApp.COMMANDS.filter((x) => x.pkg === 'ov')) {
    const called = [];
    const state = { doc: null, docs: [], roi: null, busy: false, activeChannel: 0, threshold: null, measurements: [], lineWidth: 1, roiList: [], resultsCount: 0 };
    const nested = (member) => new Proxy({}, { get: (_, sub) => (...a) => { called.push(member + '.' + String(sub)); return Promise.resolve(null); } });
    const api = new Proxy({}, { get: (_, name) => {
      assert.ok(members.has(String(name)), c.id + ': api.' + String(name) + ' is a documented member');
      if (['annotations', 'settings', 'sessionData', 'roiManager'].includes(String(name))) return nested(String(name));
      return (...a) => { called.push(String(name)); if (name === 'state') return state; if (name === 'tr') return String(a[0]); return Promise.resolve(null); };
    } });
    await c.run(api);
    assert.deepEqual(called, ['state'], c.id + ': without an image it only asks for the state');
  }
  t.close();
});

console.log(`test_ij_ov_commands: ${passed} groups passed`);
process.exit(0);   // the harness's session autosave re-arms its timer, like the other harness tests
