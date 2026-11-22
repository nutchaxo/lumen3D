// The page state a macro reads and writes (DOCS/studio-advanced/macros/INTEGRATION.md §2.3, §2.8, §4.4, §4.5): the mirror's format,
// the Results table and named tables as Tables (a macro-made column is the row key 'mac:<heading>', a package column its declared key),
// tables re-sent only when they changed, the per-image threshold table and its sync with the Threshold window, the macro settings
// allowlist, colours, measurements, ROI Manager display, channel visibility and the status line.
//
// Run: node tests/js/test_ij_macro_state.mjs
import assert from 'node:assert/strict';
import { boot, until, J } from './ij_harness.mjs';
import { FAKE_SOURCES, startRun } from './ij_macro_plumbing_fakes.mjs';

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok  ' + name); } catch (err) { console.error('FAIL ' + name); throw err; }
}
// the page's objects live in another realm: compared through JSON
const norm = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));
const deq = (a, b, m) => assert.deepEqual(norm(a), norm(b), m);
const throwsCode = (fn, code, what) => {
  let err = null;
  try { fn(); } catch (e) { err = e; }
  assert.ok(err, what + ': it must throw');
  assert.equal(err.code, code, what + ': ' + (err && err.code));
};
async function start() {
  const t = await boot(FAKE_SOURCES);
  const sh = await t.open();
  return { t, sh, api: t.api('macro'), id: t.activeId() };
}

await test('mirror: every image (opening order, hidden ones too) with the fields of §4.4, current image, selections, ROI Manager, settings, measurements, colours, workspace', async () => {
  const { t, api, id } = await start();
  const h = await t.api(null).addDoc({ name: 'hid', width: 4, height: 2, bitDepth: 16, calibration: { pixelWidth: 0.5, pixelHeight: 0.5, unit: 'µm' },
    channels: [{ data: new Uint16Array(8), name: 'A' }] }, { hidden: true });
  t.api(null).setRoi({ type: 'rect', x: 1, y: 2, w: 3, h: 4 }, { docId: id });
  const m = api.macro.mirror();
  deq(Object.keys(m).sort(), ['colors', 'current', 'images', 'lineWidth', 'measurements', 'roiManager', 'selections', 'settings', 'tables', 'thresholdWindow', 'thresholds', 'tool', 'workspace'].sort());
  deq(m.images.map((i) => i.docId), [id, h], 'opening order, the hidden image included');
  const im = m.images[0];
  deq(Object.keys(im).sort(), ['active', 'bitDepth', 'calibration', 'changes', 'display', 'docId', 'ephemeral', 'height', 'hidden', 'hyperstack', 'id', 'mode', 'nC', 'nT', 'nZ', 'pos', 'rgb', 'title', 'visible', 'width'].sort());
  assert.equal(im.id, -1, 'the first image met is ImageJ id -1');
  assert.equal(m.images[1].id, -2);
  assert.equal(api.macro.ijId(h), -2);
  assert.equal(api.macro.docOf(-1), id);
  assert.equal(api.macro.docOf(-99), null);
  assert.equal(im.nC, 2);
  deq(J(im.pos), { c: 0, z: 0, t: 0 });
  deq(Object.keys(im.calibration).sort(), ['fps', 'frameInterval', 'pixelDepth', 'pixelHeight', 'pixelWidth', 'timeUnit', 'unit', 'xOrigin', 'yOrigin', 'zOrigin'].sort());
  assert.equal(im.display.length, 2);
  deq(Object.keys(im.display[0]).sort(), ['invert', 'lut', 'max', 'min']);
  const ih = m.images[1];
  deq([ih.hidden, ih.bitDepth, ih.calibration.pixelWidth, ih.calibration.unit], [true, 16, 0.5, 'µm']);
  assert.equal(m.current, id);
  deq(J(m.selections[id]), { type: 'rect', x: 1, y: 2, w: 3, h: 4 });
  assert.equal(m.selections[h], null);
  deq(Object.keys(m.settings).sort(), Array.from(t.IJApp.MACRO_SETTING_KEYS).sort());
  deq(J(m.measurements), { groups: ['area', 'mean', 'minMax'], decimals: 3 });
  deq(J(m.colors), { foreground: [255, 255, 255], background: [0, 0, 0], selection: [255, 255, 0] });
  deq(J(m.workspace), { width: 1000, height: 700 });
  deq(J(m.roiManager), { list: [], selected: [], showAll: false, labels: false });
  assert.equal(m.thresholdWindow, null);
  deq(Object.keys(m.tables), ['Results']);
  deq(J(m.tables.Results), { name: 'Results', size: 0, headings: [], columns: {}, labels: null, rev: m.tables.Results.rev });
  t.close();
});

await test('Results as a Table: a measurement maps to its ImageJ headers; replace() keeps v1 / package columns under their keys and a macro column as mac:<heading>; tables are re-sent only when they changed', async () => {
  const { t, api } = await start();
  await t.runCommand('analyzeMeasure');
  const r1 = api.macro.results.get();
  assert.equal(r1.size, 1);
  assert.ok(r1.headings.includes('Area') && r1.headings.includes('Mean'), 'ImageJ headers');
  assert.ok(!r1.headings.includes('Label'), 'Label is not a heading');
  const mean = r1.columns.Mean[0];
  // a macro adds a column of its own (MyCol) and a package column (stk's %Volume family: key 'voxels', header 'Voxels'), and a row
  const t2 = { name: 'Results', size: 2, headings: r1.headings.concat(['MyCol', 'Voxels']), columns: {}, labels: ['a', null], rev: 0 };
  for (const hd of r1.headings) t2.columns[hd] = [r1.columns[hd][0], null];
  t2.columns.MyCol = [5, 6];
  t2.columns.Voxels = [7, null];
  api.macro.results.replace(t2);
  const back = api.macro.results.get();
  assert.equal(back.size, 2);
  assert.ok(back.headings.includes('MyCol') && back.headings.includes('Voxels'), 'the headings come back as headings');
  deq(back.columns.MyCol, [5, 6]);
  deq(back.columns.Voxels, [7, null], 'an empty cell is null');
  assert.equal(back.columns.Mean[0], mean);
  deq(back.labels, ['a', null]);
  assert.equal(t.IJApp.columnHeader('mac:MyCol'), 'MyCol');
  // the row keys, as the session meta stores them
  await until(() => t.log.msgs.some((m) => m.cmd === 'session.putMeta' && Array.isArray(m.args.results) && m.args.results.length === 2), 'the meta with the rows', 4000);
  const rows = t.log.msgs.filter((m) => m.cmd === 'session.putMeta' && Array.isArray(m.args.results) && m.args.results.length === 2).pop().args.results;
  assert.equal(rows[0]['mac:MyCol'], 5, 'a macro column is mac:<heading>');
  assert.equal(rows[0].X, undefined, 'and no other key');
  assert.equal(rows[0].voxels, 7, 'a package column keeps its key');
  assert.equal(rows[0].Mean, mean, 'a v1 column is its header');
  assert.equal(rows[0].Label, 'a');
  assert.equal(rows[1].Label, undefined);
  throwsCode(() => api.macro.results.replace({ size: 1, headings: ['A'], columns: { A: [] } }), 'IJ_BAD_ARGS', 'a column of the wrong length');
  // named tables
  api.macro.tables.replace('T1', { size: 1, headings: ['v'], columns: { v: [3] }, labels: null });
  deq(api.macro.tables.list(), ['T1']);
  deq(J(api.macro.tables.get('T1').columns), { v: [3] });
  assert.equal(api.macro.tables.get('nope'), null);
  // within a run, a mirror sends a table once, then { same: true } until it changes
  const run = await startRun(t);
  const first = run.first.mirror.tables;
  assert.equal(first.Results.size, 2, 'the run got Results in full');
  assert.equal(first.T1.size, 1);
  const m2 = api.macro.mirror();
  deq(J(m2.tables), { Results: { same: true }, T1: { same: true } }, 'unchanged since the last mirror of this run');
  api.macro.tables.replace('T1', { size: 2, headings: ['v'], columns: { v: [3, 4] }, labels: null });
  const m3 = api.macro.mirror();
  assert.equal(m3.tables.T1.size, 2, 'changed: sent again');
  deq(J(m3.tables.Results), { same: true });
  api.macro.tables.rename('T1', 'T2');
  deq(api.macro.tables.list(), ['T2']);
  assert.equal(api.macro.tables.show('T2'), true, 'a table window');
  assert.ok(Array.from(t.shell.windows.floats.values()).some((w) => w.spec.title === 'T2'));
  api.macro.tables.remove('T2');
  deq(api.macro.tables.list(), []);
  assert.ok(!Array.from(t.shell.windows.floats.values()).some((w) => w.spec.title === 'T2'), 'its window closed');
  api.macro.tables.remove('Results');
  assert.equal(api.macro.results.get().size, 0, 'removing Results empties it');
  await run.end();
  t.close();
});

await test('thresholds per image and channel: set/get/reset without the window (the view draws the overlay), the window starts from it and writes it, mode, the window\'s own threshold ends with it, Convert to Mask reads it', async () => {
  const { t, sh, api, id } = await start();
  api.macro.thresholds.set(id, 0, { lower: 10, upper: 100, dark: true });
  deq(J(api.macro.thresholds.get(id, 0)), { lower: 10, upper: 100, dark: true });
  assert.equal(api.macro.thresholds.get(id, 1), null);
  deq(J(t.view(id).thr), { channel: 0, lower: 10, upper: 100, mode: 'red' }, 'the red overlay without the window');
  deq(J(t.api(null).state().threshold), { docId: id, channel: 0, lower: 10, upper: 100, dark: true }, 'state().threshold reads it');
  deq(J(api.macro.mirror().thresholds), { [id]: { 0: { lower: 10, upper: 100, dark: true } } });
  throwsCode(() => api.macro.thresholds.set(id, 0, { lower: 5, upper: 1 }), 'IJ_BAD_ARGS', 'lower > upper');
  throwsCode(() => api.macro.thresholds.set(id, 7, { lower: 1, upper: 2 }), 'IJ_BAD_ARGS', 'no such channel');
  // the Threshold window starts from the image's threshold instead of a new automatic one
  await t.api(null).openTool('threshold');
  const st = t.api(null).state().threshold;
  deq([st.lower, st.upper], [10, 100], 'the window took the kept range');
  deq(J(api.macro.mirror().thresholdWindow), { docId: id, channel: 0, mode: 'red' });
  api.macro.thresholds.set(id, 0, { lower: 20, upper: 90, dark: true });
  deq([t.api(null).state().threshold.lower, t.api(null).state().threshold.upper], [20, 90], 'a set while the window holds the image moves the window');
  api.macro.thresholdMode('bw');
  assert.equal(api.macro.mirror().thresholdWindow.mode, 'bw');
  assert.equal(t.view(id).thr.mode, 'bw', 'the window draws in that mode');
  throwsCode(() => api.macro.thresholdMode('pink'), 'IJ_BAD_ARGS', 'unknown mode');
  // closing the window: the macro's threshold stays, drawn on the image
  t.shell.windows.floats.get('threshold').close();
  deq(J(api.macro.thresholds.get(id, 0)), { lower: 20, upper: 90, dark: true }, 'kept after the window closed');
  assert.ok(t.view(id).thr && t.view(id).thr.lower === 20, 'drawn again by the view');
  // Convert to Mask reads it (Thresholder: imp.isThreshold())
  api.macro.thresholds.reset(id, 0);
  assert.equal(api.macro.thresholds.get(id, 0), null);
  assert.equal(t.view(id).thr, null, 'reset clears the overlay');
  assert.equal(t.api(null).state().threshold, null);
  api.macro.thresholds.set(id, 0, { lower: 30, upper: 200, dark: false });
  await t.runCommand('binMask');
  const run = t.log.msgs.filter((m) => m.cmd === 'doc.run' && m.args.op === 'toMask').pop();
  deq([run.args.params.lower, run.args.params.upper], [30, 200], 'the mask used the kept threshold');
  t.close();
});

await test('the operator\'s Threshold window keeps its old behaviour: its threshold ends when it closes; a hidden image takes a threshold too', async () => {
  const { t, api, id } = await start();
  await t.api(null).openTool('threshold');
  const auto = t.api(null).state().threshold;
  assert.ok(auto && auto.docId === id, 'the automatic threshold');
  deq(J(api.macro.thresholds.get(id, 0)), { lower: auto.lower, upper: auto.upper, dark: auto.dark }, 'the window writes the image\'s entry');
  t.shell.windows.floats.get('threshold').close();
  assert.equal(api.macro.thresholds.get(id, 0), null, 'gone with the window');
  assert.equal(t.view(id).thr, null, 'no overlay left');
  assert.equal(t.api(null).state().threshold, null);
  const h = await t.api(null).addDoc({ name: 'h', width: 4, height: 4, bitDepth: 8, channels: [{ data: new Uint8Array(16), name: 'A' }] }, { hidden: true });
  api.macro.thresholds.set(h, 0, { lower: 1, upper: 2 });
  deq(J(api.macro.thresholds.get(h, 0)), { lower: 1, upper: 2, dark: false });
  t.close();
});

await test('settings (macro allowlist), measurements, colours, ROI Manager display, channel visibility, status', async () => {
  const { t, sh, api, id } = await start();
  assert.equal(api.macro.settings.get('conv.scale'), true);
  api.macro.settings.set('conv.weighted', true);
  assert.equal(t.settings.get('conv.weighted'), true, 'stored like the Options dialog stores it');
  api.macro.settings.set('thr.blackBackground', false);
  assert.equal(t.settings.get('thr.blackBackground'), false, 'a key another package owns, on the macro list');
  throwsCode(() => api.macro.settings.get('colors.foreground'), 'IJ_EXT_FORBIDDEN', 'not on the list');
  throwsCode(() => api.macro.settings.set('ana.decimals', 2), 'IJ_EXT_FORBIDDEN', 'not on the list');
  assert.equal(api.macro.mirror().settings['conv.weighted'], true);
  api.macro.measurements.set({ groups: ['area', 'stdDev'], decimals: 5 });
  deq(J(api.macro.measurements.get()), { groups: ['area', 'stdDev'], decimals: 5 });
  assert.equal(t.settings.get('ana.decimals'), 5);
  throwsCode(() => api.macro.measurements.set({ groups: ['nope'] }), 'IJ_BAD_ARGS', 'unknown group');
  throwsCode(() => api.macro.measurements.set({ decimals: 12 }), 'IJ_BAD_ARGS', 'decimals 0-9');
  api.macro.colors.set({ foreground: [255, 0, 0], selection: [0, 255, 255] });
  // Colors.colorToString: a named colour is stored by its name (the Colors dialog and Make Montage read names), another as #rrggbb
  assert.equal(t.settings.get('colors.foreground'), 'red');
  api.macro.colors.set({ background: [1, 2, 3] });
  assert.equal(t.settings.get('colors.background'), '#010203');
  api.macro.colors.set({ background: [0, 0, 0] });
  deq(J(api.macro.colors.get()), { foreground: [255, 0, 0], background: [0, 0, 0], selection: [0, 255, 255] });
  throwsCode(() => api.macro.colors.set({ background: [1, 2] }), 'IJ_BAD_ARGS', 'three components');
  api.macro.roiManagerShow({ showAll: true, labels: true });
  deq([api.macro.mirror().roiManager.showAll, api.macro.mirror().roiManager.labels], [true, true]);
  assert.equal(sh.rois[sh.rois.length - 1].showAll, true, 'the views were told');
  api.macro.setVisible(id, [true, false]);
  deq(api.macro.mirror().images[0].visible, [true, false]);
  throwsCode(() => api.macro.setVisible(id, [true]), 'IJ_BAD_ARGS', 'one flag per channel');
  api.macro.status('macro says hi');
  assert.equal(t.log.status[t.log.status.length - 1], 'macro says hi');
  t.close();
});

console.log(`test_ij_macro_state: ${passed} passed`);
