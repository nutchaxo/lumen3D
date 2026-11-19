// P-ana (wave 3), end to end through tests/js/ij_harness.mjs: the real menu commands (dialog values) → the real engine in the worker →
// the Results window → undo / reload. Covered: Analyze Particles (ImageJ's dialog, defaults of a first use, every option, the Show: images,
// overlays, the Manager, the Summary), Set Measurements (Invert Y, scientific notation, NaN empty cells, decimal places, Add to overlay), Histogram
// (8 bit without a dialog, 16 / 32 bit with it, List / Copy / Log), Plot Profile of a rectangle and Edit › Options › Plots, the Results window
// (selection, Delete, Sort, Find, Rename, Duplicate, Copy / Save with Edit › Options › Input/Output), Repeat Command, Find Commands.
//
// Run: node tests/js/test_ij_ana_cmds.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { boot, until, EN, sleep, langPart } from './ij_harness.mjs';
import { ROOT } from './harness.mjs';

let passed = 0;
async function test(name, fn) { try { await fn(); passed++; console.log('  ok  ' + name); } catch (e) { console.error('FAIL ' + name); throw e; } }
const arr = (a) => Array.from(a);
// values built in the page's realm: compare them as JSON
const deq = (a, b, m) => assert.deepEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)), m);
const ndeq = (a, b, m) => assert.notDeepEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)), m);

// the particle image of the goldens: 72 x 56, 8 particles
const f = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'ij-wave3', 'ana', 'particles.json'), 'utf8'));
const BIN = new Uint8Array(Buffer.from(f.input.data.b64, 'base64'));
const W = 72, H = 56;

async function fresh(opts) {
  const t = await boot(Object.assign({ channels: 1 }, opts || {}));
  // the harness's fake elements keep their children when `textContent = ''` is assigned: give the page's elements the DOM behaviour
  const create = t.page.document.createElement;
  t.page.document.createElement = (tag) => {
    const e = create(tag);
    let v = '';
    Object.defineProperty(e, 'textContent', { get: () => v, set: (x) => { v = x; if (x === '') e.children.length = 0; }, configurable: true });
    return e;
  };
  await t.open();
  return t;
}
/** An image of the test as a document shown on screen. */
async function addDoc(t, o) {
  const data = o.data || BIN.slice();
  const id = await t.api('ana').addDoc({ name: o.name || 'particles', width: o.width || W, height: o.height || H, bitDepth: o.bitDepth || 8,
    calibration: o.calibration || { pixelWidth: 1, pixelHeight: 1, unit: 'pixel' }, channels: [{ data, name: 'c', color: '#ffffff' }] }, { sessionKey: (await t.store.shared.list())[0].key });
  await until(() => t.activeId() === id, 'the image is on screen');
  return id;
}
async function activate(t, docId) {
  const c = t.shell.opts.commands.find((x) => x.id === 'winImg' + docId);
  assert.ok(c, 'window menu entry of ' + docId);
  await c.run();
  await until(() => t.activeId() === docId, 'image ' + docId + ' on screen');
}
const lastSpec = (t) => t.log.dialogSpecs[t.log.dialogSpecs.length - 1];
const fieldOf = (spec, id) => spec.fields.find((x) => x.id === id);
const label = (field) => (field.labelKey ? EN.dlg.ana[field.labelKey.split('.').pop()] : field.label);
function walk(el, fn) { fn(el); for (const c of el.children || []) walk(c, fn); }
function texts(el, tag) { const out = []; walk(el, (e) => { if (e.tagName === tag) out.push(e); }); return out; }
const cellText = (tr) => (tr.children || []).map((c) => c.textContent);
const resultsRows = (t) => { const win = t.panel('results'); const rows = texts(win, 'TR'); return rows.map(cellText); };
const click = (el, ev) => { const l = (el.listeners.click || [])[0]; assert.ok(l, 'a click listener on ' + el.tagName + ' ' + el.textContent); return l(Object.assign({ target: el }, ev || {})); };
function button(panel, text) {
  let hit = null;
  walk(panel, (e) => { if (!hit && e.tagName === 'BUTTON' && e.textContent === text) hit = e; });
  assert.ok(hit, 'a button "' + text + '"');
  return hit;
}
const wait = async (fn, what) => until(fn, what, 4000);
const floats = (t) => [...t.shell.windows.floats.keys()];
async function settle() { await sleep(120); }

await test('Analyze Particles: the dialog of a first use is ImageJ\'s (strings, Show: list, only Clear results ticked)', async () => {
  const t = await fresh();
  await addDoc(t, {});
  await t.runCommand('analyzeParticles', null);   // cancelled
  const spec = lastSpec(t);
  assert.equal(spec.title, EN.cmd.analyzeParticles);
  deq(spec.fields.map((x) => x.id), ['size', 'circularity', 'show', 'display', 'exclude', 'clear', 'holes', 'summarize', 'overlay', 'manager', 'composite', 'record'],
    'no "Pixel units" on an image without a scale');
  assert.equal(fieldOf(spec, 'size').label, 'Size (pixel^2):');
  assert.equal(fieldOf(spec, 'size').value, '0-Infinity');
  assert.equal(fieldOf(spec, 'circularity').value, '0.00-1.00');
  assert.equal(label(fieldOf(spec, 'circularity')), 'Circularity:');
  deq(fieldOf(spec, 'show').options.map((o) => EN.dlg.ana[o.labelKey.split('.').pop()]), ['Nothing', 'Overlay', 'Overlay Masks', 'Outlines', 'Bare Outlines', 'Ellipses', 'Masks', 'Count Masks']);
  assert.equal(fieldOf(spec, 'show').value, 'nothing');
  const on = spec.fields.filter((x) => x.type === 'check' && x.value).map((x) => x.id);
  deq(on, ['clear'], 'ParticleAnalyzer.java:98: Prefs.getInt(OPTIONS, CLEAR_WORKSHEET)');
  deq(['display', 'exclude', 'clear', 'holes', 'summarize', 'overlay', 'manager', 'composite', 'record'].map((id) => label(fieldOf(spec, id))),
    ['Display results', 'Exclude on edges', 'Clear results', 'Include holes', 'Summarize', 'Overlay', 'Add to Manager', 'Composite ROIs', 'Record starts']);
  // a calibrated image has Pixel units and the unit in the label
  const id2 = await addDoc(t, { name: 'cal', calibration: { pixelWidth: 0.5, pixelHeight: 0.5, unit: 'um' } });
  await t.runCommand('analyzeParticles', null);
  const s2 = lastSpec(t);
  assert.equal(fieldOf(s2, 'size').label, 'Size (um^2):');
  assert.ok(fieldOf(s2, 'pixelUnits') && label(fieldOf(s2, 'pixelUnits')) === 'Pixel units');
  assert.ok(t.docs && id2);
  t.close();
});

await test('Analyze Particles: Display results / Clear results / Record starts / Summarize / filters, the columns of Set Measurements, the Summary row', async () => {
  const t = await fresh();
  await addDoc(t, {});
  assert.equal(t.isEnabled('analyzeParticles'), true);
  await t.runCommand('analyzeParticles', { display: true, clear: true, summarize: true, record: true });
  await until(() => t.shell.windows.floats.has('results') && t.shell.windows.floats.has('summary'), 'Results and Summary open');
  await settle();
  let rows = resultsRows(t);
  deq(rows[0], [' ', 'Area', 'Mean', 'Min', 'Max', 'XStart', 'YStart'], 'the default measurements (Area, Mean, Min & max) and the recorded starts');
  assert.equal(rows.length, 9, 'a header and 8 particles');
  deq(rows[1].slice(0, 5), ['1', '30', '255', '255', '255'], 'a whole number has no decimals');
  // Summarize adds the Area measurement and a Summary row: Count, Total Area, Average Size, %Area, Mean
  const summary = texts(t.panel('summary'), 'TR').map(cellText);
  deq(summary[0], ['Slice', 'Count', 'Total Area', 'Average Size', '%Area', 'Mean']);
  assert.equal(summary[1][0], 'particles');
  assert.equal(summary[1][1], '8');
  assert.equal(summary[1][2], '720', '30 + 1 + 351 + 112 + 184 + 9 + 18 + 15');
  assert.equal(summary[1][3], '90');
  // the options are remembered: the next dialog comes back as it was left
  await t.runCommand('analyzeParticles', null);
  const spec = lastSpec(t);
  deq(spec.fields.filter((x) => x.type === 'check' && x.value).map((x) => x.id), ['display', 'clear', 'summarize', 'record']);
  assert.equal(t.settings.get('ana.particles').record, true);
  // filters: Size and Circularity strings, Exclude on edges
  await t.runCommand('analyzeParticles', { size: '20-300', display: true, clear: true });
  await settle();
  assert.equal(resultsRows(t).length - 1, 3, 'size 20-300');
  await t.runCommand('analyzeParticles', { size: '0-Infinity', circularity: '0.6-1', display: true, clear: true });
  await settle();
  assert.equal(resultsRows(t).length - 1, 7, 'circularity 0.6-1');
  await t.runCommand('analyzeParticles', { circularity: '0.00-1.00', exclude: true, display: true, clear: true });
  await settle();
  assert.equal(resultsRows(t).length - 1, 6, 'exclude on edges');
  // "Clear results" off appends; Display results off leaves the table alone
  await t.runCommand('analyzeParticles', { display: true, clear: false, exclude: false });
  await settle();
  assert.equal(resultsRows(t).length - 1, 14, 'appended');
  await t.runCommand('analyzeParticles', { display: false, clear: false });
  await settle();
  assert.equal(resultsRows(t).length - 1, 14, 'not displayed, not added');
  // ParticleAnalyzer.java:566-576: Display off + Clear on with the Results window open clears the table AND closes the window (the rows go to the system table)
  await t.runCommand('analyzeParticles', { display: false, clear: true });
  await settle();
  assert.equal(t.shell.windows.floats.has('results'), false, 'the Results window was closed by "Clear results"');
  await t.runCommand('windowResults', null);
  await until(() => t.shell.windows.floats.has('results'), 'Results reopened');
  await settle();
  assert.equal(resultsRows(t).length - 1, 8, 'the 8 particles of the run are in the system table, shown or not');
  // no Results window + Display off + Clear off: ImageJ still adds the rows to the system table
  t.shell.windows.floats.get('results').close();
  await until(() => !t.shell.windows.floats.has('results'), 'Results closed');
  await t.runCommand('analyzeParticles', { display: false, clear: false });
  await settle();
  await t.runCommand('windowResults', null);
  await until(() => t.shell.windows.floats.has('results'), 'Results reopened again');
  await settle();
  assert.equal(resultsRows(t).length - 1, 16, 'the rows were added without being displayed');
  t.close();
});

await test('Analyze Particles on a calibrated image: sizes in unit^2, "Pixel units", calibrated columns', async () => {
  const t = await fresh();
  await addDoc(t, { calibration: { pixelWidth: 0.5, pixelHeight: 0.5, unit: 'um' } });
  await t.runCommand('analyzeParticles', { size: '5-Infinity', display: true, clear: true });
  await settle();
  assert.equal(resultsRows(t).length - 1, 4, '5 um^2 = 20 pixels: 30, 351, 112 and 184');
  assert.equal(resultsRows(t)[1][1], '7.500', '30 pixels of 0.25 um^2');
  await t.runCommand('analyzeParticles', { size: '5-Infinity', pixelUnits: true, display: true, clear: true });
  await settle();
  assert.equal(resultsRows(t).length - 1, 7, 'in pixels: 5 pixels and more');
  t.close();
});

await test('Set Measurements: ImageJ\'s second group, Decimal places; Scientific notation, NaN empty cells and Invert Y change what the table shows', async () => {
  const t = await fresh();
  await addDoc(t, {});
  await t.runCommand('analyzeSetMeasurements', null);
  const spec = lastSpec(t);
  const ids = spec.fields.map((x) => x.id).filter((id) => !/^redirect/.test(id));
  deq(ids.slice(-7), ['limit', 'labels', 'invertY', 'scientific', 'addToOverlay', 'nanEmpty', 'decimals']);
  deq(['limit', 'labels', 'invertY', 'scientific', 'addToOverlay', 'nanEmpty'].map((id) => spec.fields.find((x) => x.id === id).label),
    ['Limit to threshold', 'Display label', 'Invert Y coordinates', 'Scientific notation', 'Add to overlay', 'NaN empty cells']);
  assert.equal(fieldOf(spec, 'decimals').value, 3);
  assert.equal(label(fieldOf(spec, 'decimals')), 'Decimal places (0-9):');
  // Measure a rectangle with the centroid, the decimals at 3 then 1 then scientific
  t.shell.opts.onRoi({ type: 'rect', x: 10, y: 8, w: 30, h: 20 }, { final: true });
  await t.runCommand('analyzeSetMeasurements', { area: true, mean: true, minMax: false, centroid: true, decimals: 3 });
  await t.runCommand('analyzeMeasure');
  await settle();
  let r = resultsRows(t);
  deq(r[0], [' ', 'Area', 'Mean', 'X', 'Y']);
  assert.equal(r[1][1], '600');
  const mean = r[1][2];
  assert.match(mean, /^\d+\.\d{3}$/, 'three decimals: ' + mean);
  assert.equal(r[1][3], '25'); assert.equal(r[1][4], '18');
  await t.runCommand('analyzeSetMeasurements', { area: true, mean: true, centroid: true, decimals: 1 });
  await settle();
  r = resultsRows(t);
  assert.match(String(r[1][2]), /^\d+\.\d$/, 'one decimal ' + JSON.stringify(r));
  await t.runCommand('analyzeSetMeasurements', { area: true, mean: true, centroid: true, scientific: true, decimals: 2 });
  await settle();
  r = resultsRows(t);
  assert.match(String(r[1][1]), /^6\.00E2$/, 'scientific notation: ' + JSON.stringify(r));
  // Invert Y: Y' = (height - 1) - Y for the centroid; the second row is the inverted measurement
  await t.runCommand('analyzeSetMeasurements', { area: true, mean: true, centroid: true, scientific: false, invertY: true, decimals: 3 });
  await t.runCommand('analyzeMeasure');
  await settle();
  r = resultsRows(t);
  assert.equal(r[2][3], '25'); assert.equal(r[2][4], String(H - 1 - 18), 'Y = (height - 1) - 18');
  // NaN empty cells: a cell nobody filled is 0, or NaN
  await t.runCommand('analyzeSetMeasurements', { area: true, mean: true, centroid: true, invertY: false, nanEmpty: false, decimals: 3 });
  await t.runCommand('analyzeSetMeasurements', { area: true, mean: true, centroid: true, rect: true, decimals: 3 });
  await t.runCommand('analyzeMeasure');
  await settle();
  r = resultsRows(t);
  deq(r[0].slice(-4), ['BX', 'BY', 'Width', 'Height']);
  deq(r[1].slice(-4), ['0', '0', '0', '0'], 'earlier rows have 0 in a column added later');
  await t.runCommand('analyzeSetMeasurements', { area: true, mean: true, centroid: true, rect: true, nanEmpty: true, decimals: 3 });
  await settle();
  deq(resultsRows(t)[1].slice(-4), ['NaN', 'NaN', 'NaN', 'NaN']);
  t.close();
});

await test('Set Measurements › Add to overlay: the measured selection joins the overlay, named by its row', async () => {
  const t = await fresh();
  const id = await addDoc(t, {});
  await t.runCommand('analyzeSetMeasurements', { area: true, addToOverlay: true, decimals: 3 });
  t.shell.opts.onRoi({ type: 'rect', x: 10, y: 8, w: 30, h: 20 }, { final: true });
  await t.runCommand('analyzeMeasure');
  await t.runCommand('analyzeMeasure');
  const a = t.api('ana').annotations.get(id);
  const rois = a.items.filter((i) => i.kind === 'roi');
  assert.equal(rois.length, 2);
  deq(rois.map((r) => r.name), ['1', '2']);
  deq(a.items.filter((i) => i.kind === 'text').map((i) => i.text), ['1', '2']);
  t.close();
});

await test('Analyze Particles › Show: the five images, undo-free new documents, restored after a reload; labels of Outlines are text items', async () => {
  const t = await fresh();
  const id = await addDoc(t, {});
  const n0 = (await t.docs()).length;
  for (const [show, name, depth, invert] of [['masks', 'Mask of particles', 8, true], ['countMasks', 'Count Masks of particles', 16, false], ['outlines', 'Drawing of particles', 8, false],
    ['bareOutlines', 'Drawing of particles', 8, false], ['ellipses', 'Drawing of particles', 8, false]]) {
    await activate(t, id);
    await t.runCommand('analyzeParticles', { show, display: false, clear: true });
    await wait(async () => (await t.docs()).length > n0 + ['masks', 'countMasks', 'outlines', 'bareOutlines', 'ellipses'].indexOf(show), 'the ' + show + ' image');
  }
  const docs = await t.docs();
  assert.equal(docs.length, n0 + 5);
  const mask = docs.find((d) => d.name === 'Mask of particles');
  assert.equal(mask.bitDepth, 8); assert.equal(mask.channels[0].display.invert, true);
  const cm = docs.find((d) => d.name === 'Count Masks of particles');
  assert.equal(cm.bitDepth, 16);
  const px = (await t.engine('doc.tile', { docId: cm.docId, channel: 0, level: 0, tx: 0, ty: 0 })).data;
  assert.equal(Math.max(...px), 8, 'eight particles are numbered 1..8');
  const drawings = docs.filter((d) => d.name === 'Drawing of particles');
  assert.equal(drawings.length, 3);
  // the Outlines image carries the numbers as text items (the first drawing is the Outlines one)
  const withLabels = drawings.filter((d) => t.api('ana').annotations.get(d.docId).items.length);
  assert.equal(withLabels.length, 1);
  deq(t.api('ana').annotations.get(withLabels[0].docId).items.map((i) => i.text), ['1', '2', '3', '4', '5', '6', '7', '8']);
  assert.equal(t.api('ana').annotations.get(id).items.length, 0, 'the source image has no overlay');
  // reload: the images come back with the same pixels (a new document has its own baseline)
  const before = (await t.engine('doc.tile', { docId: mask.docId, channel: 0, level: 0, tx: 0, ty: 0 })).data.slice();
  const key = (await t.store.shared.list())[0].key;
  const t2 = await t.reload();
  const w2 = await t2.spawn();
  await t2.engine('session.restore', { key }, w2);
  const infos = (await t2.engine('doc.list', {}, w2)).docs;
  const m2 = infos.find((d) => d.name === 'Mask of particles');
  assert.ok(m2, 'the Mask image is restored: ' + infos.map((d) => d.name).join('|'));
  deq(arr((await t2.engine('doc.tile', { docId: m2.docId, channel: 0, level: 0, tx: 0, ty: 0 }, w2)).data), arr(before));
  t2.close();
});

await test('Analyze Particles › Overlay, Overlay Masks, Add to Manager, Composite ROIs, Include holes', async () => {
  const t = await fresh();
  const w = 12, h = 12, d = new Uint8Array(w * h);
  for (let y = 2; y < 10; y++) for (let x = 2; x < 10; x++) d[y * w + x] = 255;
  for (let y = 4; y < 8; y++) for (let x = 4; x < 8; x++) d[y * w + x] = 0;
  d[5 * w + 5] = 255; d[6 * w + 6] = 255;
  const id = await addDoc(t, { name: 'ring', width: w, height: h, data: d });
  await t.runCommand('analyzeParticles', { show: 'overlay', display: true, clear: true });
  await settle();
  let a = t.api('ana').annotations.get(id);
  assert.equal(a.items.filter((i) => i.kind === 'roi').length, 2, 'two particles: the ring and the island');
  assert.equal(a.items.find((i) => i.kind === 'roi').stroke, '#00ffff');
  deq(a.items.filter((i) => i.kind === 'roi').map((i) => i.name), ['1', '2'], 'named by their row when the results are displayed');
  await t.runCommand('analyzeParticles', { show: 'overlayMasks', display: true, clear: true });
  a = t.api('ana').annotations.get(id);
  assert.equal(a.items.filter((i) => i.kind === 'roi').length, 2, 'the particle overlay is replaced, not stacked');
  assert.ok(a.items.filter((i) => i.kind === 'roi').every((i) => /^#[0-9a-f]{8}$/.test(i.fill)), 'Overlay Masks fills every particle');
  // "Overlay" ticked with Show: Nothing builds the same overlay
  await t.runCommand('analyzeParticles', { show: 'nothing', overlay: true, display: false, clear: true });
  assert.equal(t.api('ana').annotations.get(id).items.filter((i) => i.kind === 'roi').length, 2);
  // Add to Manager: outlines (traced), a mask ROI for the ring with Composite ROIs, one polygon with Include holes
  await t.runCommand('analyzeParticles', { show: 'nothing', overlay: false, manager: true, composite: true, display: false, clear: true });
  await settle();
  let list = t.api('ana').roiManager.list();
  assert.equal(list.length, 2);
  assert.equal(list[0].roi.type, 'mask', 'the ring keeps its hole');
  assert.equal(list[1].roi.type, 'polygon');
  await t.runCommand('analyzeParticles', { manager: true, composite: false, display: false, clear: true });
  list = t.api('ana').roiManager.list();
  deq(list.map((r) => r.roi.type), ['polygon', 'polygon']);
  assert.ok(list.every((r) => r.roi.traced === true));
  await t.runCommand('analyzeParticles', { manager: true, holes: true, display: true, clear: true });
  await settle();
  assert.equal(t.api('ana').roiManager.list().length, 1, 'Include holes: the island is part of the ring');
  assert.equal(resultsRows(t).length - 1, 1);
  t.close();
});

// the image of the ImageJ 1.54p run that gave the numbers below (ParticleAnalyzer, Measurements.AREA|PERIMETER|SHAPE_DESCRIPTORS): a ring (8x8, hole 4x4),
// a disk, a solid 10x6 rectangle and a 10x6 rectangle with an L-shaped hole of 3 pixels
function compositeImage() {
  const w = 40, h = 30, d = new Uint8Array(w * h);
  const set = (x, y, v) => { d[y * w + x] = v; };
  for (let y = 2; y < 10; y++) for (let x = 2; x < 10; x++) set(x, y, 255);
  for (let y = 4; y < 8; y++) for (let x = 4; x < 8; x++) set(x, y, 0);
  for (let y = 14; y < 20; y++) for (let x = 2; x < 12; x++) set(x, y, 255);
  for (let y = 2; y < 12; y++) for (let x = 20; x < 30; x++) { const dx = x - 24.5, dy = y - 6.5; if (dx * dx + dy * dy < 20) set(x, y, 255); }
  for (let y = 16; y < 22; y++) for (let x = 20; x < 30; x++) set(x, y, 255);
  set(24, 18, 0); set(25, 18, 0); set(24, 19, 0);
  return { w, h, d };
}

await test('Analyze Particles / Composite ROIs: Perim., Circ. and the circularity filter read the selection of the particle (ImageJ 1.54p numbers)', async () => {
  const t = await fresh();
  const im = compositeImage();
  await addDoc(t, { name: 'comp', width: im.w, height: im.h, data: im.d });
  await t.runCommand('analyzeSetMeasurements', { area: true, perimeter: true, shape: true, decimals: 3 });
  const col = (rows, name) => { const k = rows[0].indexOf(name); return rows.slice(1).map((r) => r[k]); };
  await t.runCommand('analyzeParticles', { composite: false, display: true, clear: true });
  await settle();
  let rows = resultsRows(t);
  // ImageJ without Composite ROIs: the traced perimeter of the outline (ring: 29.657, the hole does not count)
  deq(col(rows, 'Area'), ['48', '60', '60', '57']);
  deq(col(rows, 'Perim.'), ['29.657', '27.314', '29.657', '29.657']);
  deq(col(rows, 'Circ.'), ['0.686', '1', '0.857', '0.814']);
  await t.runCommand('analyzeParticles', { composite: true, display: true, clear: true });
  await settle();
  rows = resultsRows(t);
  // ParticleAnalyzer.java:915-927 "roi = roi2" precedes "roi.getLength()": the ring is 29.657 + 13.657 (its hole), the rectangle a Roi.RECTANGLE (2w + 2h = 32),
  // the L-holed rectangle 29.657 + 5.657; the disk is a single traced polygon and does not change
  deq(col(rows, 'Area'), ['48', '60', '60', '57']);
  deq(col(rows, 'Perim.'), ['43.314', '27.314', '32', '35.314']);
  deq(col(rows, 'Circ.'), ['0.322', '1', '0.736', '0.574']);
  // the circularity filter reads the same perimeter: the ring (0.322 with Composite ROIs, 0.686 without) leaves with 0.5-1
  await t.runCommand('analyzeParticles', { composite: true, circularity: '0.50-1.00', display: true, clear: true });
  await settle();
  assert.equal(resultsRows(t).length - 1, 3, 'Composite ROIs, circularity 0.5-1: the ring is out');
  await t.runCommand('analyzeParticles', { composite: false, circularity: '0.50-1.00', display: true, clear: true });
  await settle();
  assert.equal(resultsRows(t).length - 1, 4, 'without Composite ROIs the ring stays');
  // a Show: image obeys the same filter
  const n0 = (await t.docs()).length;
  await t.runCommand('analyzeParticles', { composite: true, circularity: '0.50-1.00', show: 'countMasks', display: true, clear: true });
  await wait(async () => (await t.docs()).length > n0, 'the count masks image');
  const cm = (await t.docs()).find((d) => d.name === 'Count Masks of comp');
  const px = (await t.engine('doc.tile', { docId: cm.docId, channel: 0, level: 0, tx: 0, ty: 0 })).data;
  assert.equal(Math.max(...px), 3, 'three particles are numbered');
  assert.equal(px[3 * im.w + 3], 0, 'the ring is not drawn');
  t.close();
});

await test('Analyze Particles / the analysed pixels are the threshold range, an unthresholded grey image is refused (ParticleAnalyzer.setThresholdLevels)', async () => {
  const t = await fresh();
  const w = 40, h = 30, d = new Uint8Array(w * h).fill(10);
  const blob = (x0, y0, v) => { for (let y = y0; y < y0 + 6; y++) for (let x = x0; x < x0 + 6; x++) d[y * w + x] = v; };
  blob(2, 2, 200); blob(15, 2, 120); blob(28, 2, 250); blob(2, 15, 120);
  const greyId = await addDoc(t, { name: 'grey', width: w, height: h, data: d });
  await t.runCommand('analyzeParticles', { display: true, clear: true }, { expectError: true });
  assert.ok(t.errors.some((e) => e.message === EN.dlg.ana.partNeedsThreshold), 'ImageJ message: ' + JSON.stringify(t.errors));
  assert.equal(EN.dlg.ana.partNeedsThreshold, 'A thresholded image or 8-bit binary image is required.');
  // a binary 0 / 255 image needs no threshold
  const bin = new Uint8Array(w * h); for (let y = 2; y < 8; y++) for (let x = 2; x < 8; x++) bin[y * w + x] = 255;
  await addDoc(t, { name: 'bin', width: w, height: h, data: bin });
  await t.runCommand('analyzeParticles', { display: true, clear: true });
  await settle();
  assert.equal(resultsRows(t).length - 1, 1);
  // the Threshold window's range selects the pixels
  await activate(t, greyId);
  await t.runCommand('adjustThreshold');
  await wait(() => t.api('ana').state().threshold, 'the threshold window range');
  const T = t.api('ana').state().threshold;
  const inRange = (v) => v >= T.lower && v <= T.upper;
  assert.equal(inRange(10), false, 'the background is outside the automatic range: ' + T.lower + '-' + T.upper);
  let expected = 0;   // the blobs are 6x6 squares that do not touch
  for (const v of [200, 120, 250, 120]) if (inRange(v)) expected++;
  assert.ok(expected > 0);
  await t.runCommand('analyzeParticles', { display: true, clear: true });
  await settle();
  assert.equal(resultsRows(t).length - 1, expected, 'the particles are the blobs inside ' + T.lower + '-' + T.upper);
  t.close();
});

await test('Analyze Particles / numbers follow rt.size() (overlay names, Count Masks levels); Add to Manager names are nnnn-yyyy', async () => {
  const t = await fresh();
  const id = await addDoc(t, {});
  await t.runCommand('analyzeParticles', { display: true, clear: true });
  await settle();
  assert.equal(resultsRows(t).length - 1, 8);
  // Clear results off: the next run's particles are numbered 9..16 (ParticleAnalyzer.java:1016-1018 "rt.size()")
  const n0 = (await t.docs()).length;
  await t.runCommand('analyzeParticles', { show: 'countMasks', display: true, clear: false });
  await wait(async () => (await t.docs()).length > n0, 'the count masks image');
  const cm = (await t.docs()).filter((d) => d.name === 'Count Masks of particles').pop();
  const px = Array.from((await t.engine('doc.tile', { docId: cm.docId, channel: 0, level: 0, tx: 0, ty: 0 })).data).filter((v) => v > 0);
  assert.equal(Math.min(...px), 9); assert.equal(Math.max(...px), 16);
  await activate(t, id);
  await t.runCommand('analyzeParticles', { show: 'overlay', display: true, clear: false });
  await settle();
  deq(t.api('ana').annotations.get(id).items.filter((i) => i.kind === 'roi').map((i) => i.name), ['17', '18', '19', '20', '21', '22', '23', '24']);
  // Add to Manager: RoiManager.getLabel(imp, roi, n) with n = the particle number: "nnnn-yyyy" (n, then the y centre of the bounds)
  await t.runCommand('analyzeParticles', { manager: true, display: false, clear: true });
  const list = t.api('ana').roiManager.list();
  assert.equal(list.length, 8);
  assert.match(list[0].name, /^0001-\d{4}$/); assert.match(list[7].name, /^0008-\d{4}$/);
  t.close();
});

await test('Set Measurements / Add to overlay keeps the name a selection already has (Analyzer.addRoiToOverlay)', async () => {
  const t = await fresh();
  const id = await addDoc(t, {});
  await t.runCommand('analyzeSetMeasurements', { area: true, addToOverlay: true });
  t.shell.opts.onRoi({ type: 'rect', x: 3, y: 3, w: 10, h: 8, name: 'mine' }, { final: true });
  await settle();
  await t.runCommand('analyzeMeasure');
  await settle();
  const items = t.api('ana').annotations.get(id).items.filter((i) => i.kind === 'roi');
  assert.equal(items[items.length - 1].name, 'mine');
  t.close();
});

await test('Histogram: 8 and 16-bit have no dialog (Histogram.java:34); 32-bit asks Bins / Use pixel value range / X min / X max / Y max; the window prints the numbers of HistogramPlot; List, Copy and Log', async () => {
  const t = await fresh();
  const id8 = await addDoc(t, { name: 'eight' });
  const n0 = t.log.dialogSpecs.length;
  await t.runCommand('analyzeHistogram');
  assert.equal(t.log.dialogSpecs.length, n0, 'no dialog for an 8-bit image');
  await wait(() => floats(t).some((k) => /^plot-/.test(k)), 'the histogram window');
  const req = t.log.msgs.filter((m) => m.cmd === 'doc.histogram').pop();
  assert.equal(req.args.bins, 256);
  // 16-bit: "if (bitDepth==32 || IJ.altKeyDown() ...) showDialog" - 256 bins over the pixel range, no dialog
  const px16 = new Uint16Array(W * H).map((v, i) => 1000 + ((i * 37) % 9000));
  await addDoc(t, { name: 'sixteen', bitDepth: 16, data: px16 });
  const n1 = t.log.dialogSpecs.length;
  await t.runCommand('analyzeHistogram', null);
  assert.equal(t.log.dialogSpecs.length, n1, 'no dialog for a 16-bit image');
  await settle();
  let r = t.log.msgs.filter((m) => m.cmd === 'doc.histogram').pop();
  assert.equal(r.args.bins, 256); assert.equal(r.args.min, undefined, 'the pixel value range: no range sent');
  let key = floats(t).filter((k) => /^plot-/.test(k)).pop();
  let pre = texts(t.shell.windows.floats.get(key).spec.content, 'PRE')[0].textContent;
  // HistogramPlot.d2s: a whole number has no decimals, any other 3 significant decimals
  assert.match(pre, /^N: 4032\nMean: \d+\.\d{3}\nStdDev: \d+\.\d{3}\nMode: [\d.]+ \(\d+\)\*?\nMin: 1000\nMax: 9994\nBins: 256\nBin Width: 35\.137$/, pre);
  // 32-bit: the dialog
  const f32 = new Float32Array(W * H).map((v, i) => Math.sin(i / 7) * 50);
  const id32 = await addDoc(t, { name: 'float', bitDepth: 32, data: f32 });
  await t.runCommand('analyzeHistogram', { bins: 64, useRange: true });
  let spec = lastSpec(t);
  deq(spec.fields.filter((x) => x.type !== 'message').map((x) => x.id), ['bins', 'useRange', 'xMin', 'xMax', 'yMax']);
  deq(['bins', 'useRange', 'xMin', 'xMax', 'yMax'].map((id) => label(fieldOf(spec, id))), ['Bins:', 'Use pixel value range', 'X min:', 'X max:', 'Y max:']);
  assert.equal(fieldOf(spec, 'yMax').value, 'Auto');
  r = t.log.msgs.filter((m) => m.cmd === 'doc.histogram').pop();
  assert.equal(r.args.bins, 64); assert.equal(r.args.min, undefined, 'the pixel value range: no range sent');
  await t.runCommand('analyzeHistogram', { bins: 100, useRange: false, xMin: -20, xMax: 30, yMax: '50' });
  r = t.log.msgs.filter((m) => m.cmd === 'doc.histogram').pop();
  deq([r.args.bins, r.args.min, r.args.max], [100, -20, 30]);
  // remembered for the same image: the next dialog comes back with the last values
  await t.runCommand('analyzeHistogram', null);
  spec = lastSpec(t);
  assert.equal(fieldOf(spec, 'bins').value, 100); assert.equal(fieldOf(spec, 'xMin').value, -20); assert.equal(fieldOf(spec, 'yMax').value, '50');
  assert.equal(fieldOf(spec, 'useRange').value, false);
  // "if (imp.getID()!=imageID ...) useImageMinAndMax = true": another 32-bit image starts again from its pixel range (Bins and Y max stay)
  const id32b = await addDoc(t, { name: 'float2', bitDepth: 32, data: f32.map((v) => v * 2) });
  await t.runCommand('analyzeHistogram', null);
  spec = lastSpec(t);
  assert.equal(fieldOf(spec, 'useRange').value, true, 'a new image uses its own range');
  assert.equal(fieldOf(spec, 'bins').value, 100); assert.equal(fieldOf(spec, 'yMax').value, '50');
  // the window: the numbers of HistogramPlot, List / Copy / Log
  await t.runCommand('analyzeHistogram', { bins: 64, useRange: true });
  await settle();
  key = floats(t).filter((k) => /^plot-/.test(k)).pop();
  const win = t.shell.windows.floats.get(key).spec.content;
  pre = texts(win, 'PRE')[0].textContent;
  assert.match(pre, /^N: 4032\nMean: -?\d+\.\d{1,3}\nStdDev: /);
  assert.match(pre, /Mode: -?[\d.]+ \(\d+\)\*?\nMin: -?[\d.]+\nMax: -?[\d.]+\nBins: 64\nBin Width: [\d.]+$/);
  let copied = '';
  t.page.navigator.clipboard = { writeText: async (s) => { copied = s; } };
  await click(button(win, EN.res.copy));
  await wait(() => copied, 'the copied list');
  // HistogramWindow.copyToClipboard: "d2s(value, digits)\t count \n" per bin, no heading
  const lines = copied.split('\n');
  assert.equal(lines.length, 65, '64 bins, each line ending with a newline');
  assert.equal(lines[64], '');
  assert.ok(/^-?\d+\.\d+\t\d+$/.test(lines[0]), 'no header line: ' + lines[0]);
  const nTables = floats(t).filter((k) => /^table-/.test(k)).length;
  await click(button(win, EN.hist.list));
  const tab = floats(t).filter((k) => /^table-/.test(k)).pop();
  assert.equal(floats(t).filter((k) => /^table-/.test(k)).length, nTables + 1, 'List opens a table of the bins');
  deq(texts(t.shell.windows.floats.get(tab).spec.content, 'TH').map((e) => e.textContent), ['index', 'bin start', 'count'], 'HistogramWindow.getResultsTable: English headings');
  await click(button(win, EN.hist.log));   // toggles the logarithmic plot, no error
  assert.ok(id8 !== undefined && id32 !== undefined && id32b !== undefined);
  t.close();
});

await test('Plot Profile of a rectangle (column / row average), Edit › Options › Plots (fixed y axis, vertical, interpolate)', async () => {
  const t = await fresh();
  await addDoc(t, { name: 'ramp', data: new Uint8Array(W * H).map((v, i) => (i % W) * 3) });
  assert.equal(t.isEnabled('analyzePlotProfile'), false);
  t.shell.opts.onRoi({ type: 'rect', x: 5, y: 4, w: 20, h: 14 }, { final: true });
  assert.equal(t.isEnabled('analyzePlotProfile'), true);
  const n0 = floats(t).length;
  await t.runCommand('analyzePlotProfile');
  await wait(() => floats(t).length > n0, 'the plot window');
  let req = t.log.msgs.filter((m) => m.cmd === 'doc.profile').pop();
  assert.equal(req.args.line.type, 'rect'); assert.equal(req.args.vertical, false); assert.equal(req.args.interpolate, true);
  // Plots…: the dialog of Profiler.doOptions
  await t.runCommand('optPlots', null);
  const spec = lastSpec(t);
  assert.equal(spec.title, 'Plot Defaults');
  deq(spec.fields.map((x) => x.id), ['fixedScale', 'ymin', 'ymax', 'vertical', 'interpolate']);
  deq(spec.fields.map(label), ['Fixed y-axis scale', 'Minimum Y:', 'Maximum Y:', 'Vertical', 'Interpolate']);
  deq(spec.fields.map((x) => x.value), [false, 0, 0, false, true]);
  await t.runCommand('optPlots', { fixedScale: true, ymin: 200, ymax: 10, vertical: true, interpolate: false });
  assert.equal(t.settings.get('ana.fixedScale'), true);
  deq([t.settings.get('ana.ymin'), t.settings.get('ana.ymax')], [10, 200], 'the limits are put in order');
  assert.equal(t.settings.get('ana.vertical'), true);
  assert.equal(t.settings.get('ana.interpolate'), false);
  await t.runCommand('analyzePlotProfile');
  await settle();
  req = t.log.msgs.filter((m) => m.cmd === 'doc.profile').pop();
  assert.equal(req.args.vertical, true); assert.equal(req.args.interpolate, false);
  // a typed range with the box unticked fixes the scale; both zero = automatic ("if (!fixedScale && !wasFixedScale && (ymin!=0.0 || ymax!=0.0)) fixedScale = true")
  await t.runCommand('optPlots', { fixedScale: false, ymin: 0, ymax: 0 });
  assert.equal(t.settings.get('ana.fixedScale'), false);
  await t.runCommand('optPlots', { fixedScale: false, ymin: 5, ymax: 50 });
  assert.equal(t.settings.get('ana.fixedScale'), true, 'a range typed with the box unticked fixes the scale');
  t.close();
});

await test('Results window: row selection (click, Shift, Ctrl), Edit › Clear deletes the rows, Select All, Copy', async () => {
  const t = await fresh();
  await addDoc(t, {});
  await t.runCommand('analyzeParticles', { display: true, clear: true });
  await settle();
  const win = t.panel('results');
  const body = texts(win, 'TBODY')[0];
  const trs = texts(win, 'TR').slice(1);
  assert.equal(trs.length, 8);
  const sel = () => trs.map((tr) => !!tr.style.background);
  click(body, { target: trs[1].children[1] });
  deq(sel(), [false, true, false, false, false, false, false, false]);
  click(body, { target: trs[3].children[1], shiftKey: true });
  deq(sel(), [false, true, true, true, false, false, false, false], 'Shift extends from the first click');
  click(body, { target: trs[6].children[1], ctrlKey: true });
  deq(sel(), [false, true, true, true, false, false, true, false], 'Ctrl adds a row');
  click(body, { target: trs[2].children[1], ctrlKey: true });
  deq(sel(), [false, true, false, true, false, false, true, false], 'Ctrl removes a row');
  // Copy: the selected rows, tab separated, row numbers on, headers off (the defaults of Input/Output)
  let copied = '';
  t.page.navigator.clipboard = { writeText: async (s) => { copied = s; } };
  click(button(win, 'Edit'));
  click(button(win, 'Copy'));
  await wait(() => copied, 'copied');
  deq(copied.trim().split('\n').map((l) => l.split('\t')[0]), ['2', '4', '7']);
  copied = '';
  // TextPanel.copySelection: "if (i<selEnd || selEnd>selStart) sb.append(newline)" — one single row has no trailing newline, several rows do
  click(body, { target: trs[4].children[1] });
  click(button(win, 'Edit'));
  click(button(win, 'Copy'));
  await wait(() => copied, 'copied one row');
  assert.ok(!copied.endsWith('\n'), 'a single row: ' + JSON.stringify(copied));
  deq(copied.split('\t')[0], '5');
  copied = '';
  click(body, { target: trs[1].children[1] });
  click(body, { target: trs[2].children[1], shiftKey: true });
  click(button(win, 'Edit'));
  click(button(win, 'Copy'));
  await wait(() => copied, 'copied two rows');
  assert.ok(copied.endsWith('\n'), 'several rows: every one ends with a newline');
  click(body, { target: trs[1].children[1] });
  click(body, { target: trs[3].children[1], shiftKey: true });
  click(body, { target: trs[6].children[1], ctrlKey: true });
  click(body, { target: trs[2].children[1], ctrlKey: true });
  copied = '';
  // Edit › Clear deletes the three selected rows
  click(button(win, 'Clear'));
  await settle();
  assert.equal(resultsRows(t).length - 1, 5);
  assert.equal(t.api('ana').state().resultsCount, 5);
  // Select All then Cut = copy everything, delete everything
  click(button(win, 'Select All'));
  assert.ok(texts(win, 'TR').slice(1).every((tr) => tr.style.background));
  click(button(win, 'Cut'));
  await wait(() => copied, 'cut copied');
  assert.equal(copied.trim().split('\n').length, 5);
  await settle();
  assert.equal(resultsRows(t).length - 1, 0);
  t.close();
});

await test('Results window: Sort…, Find… / Find Next, Rename…, Duplicate…, Plot…, Results › Summarize / Distribution', async () => {
  const t = await fresh();
  await addDoc(t, {});
  await t.runCommand('analyzeParticles', { display: true, clear: true });
  await settle();
  const win = t.panel('results');
  // Sort: ascending by a column, stable
  click(button(win, 'Results'));
  const p = click(button(win, 'Sort…'));
  await wait(() => lastSpec(t).title === 'Sort Table', 'the sort dialog (PlotContents / TextPanel.sort: "Sort Table")');
  void p;
  await settle();
  t.script.dialogs.length = 0;
  await t.runCommand('analyzeParticles', { display: true, clear: true });
  t.script.dialogs.push({ column: 'Area' });
  click(button(win, 'Sort…'));
  await settle();
  await wait(() => resultsRows(t)[1][1] === '1', 'sorted by Area');
  deq(resultsRows(t).slice(1).map((r) => Number(r[1])), [1, 9, 15, 18, 30, 112, 184, 351]);
  // Find: the first row whose text contains it, Find Next after the selection
  t.script.dialogs.push({ find: '255' });
  click(button(win, 'Edit'));
  click(button(win, 'Find…'));
  await settle();
  let sel = texts(win, 'TR').slice(1).map((tr) => !!tr.style.background);
  deq(sel.indexOf(true), 0);
  click(button(win, 'Find Next'));
  await settle();
  sel = texts(win, 'TR').slice(1).map((tr) => !!tr.style.background);
  deq(sel.indexOf(true), 1);
  // Duplicate: a table window; the Results stay
  const tables = () => floats(t).filter((k) => /^table-/.test(k));
  t.script.dialogs.push({ title: 'copy of results' });
  click(button(win, 'File'));
  click(button(win, 'Duplicate…'));
  await wait(() => tables().length === 1, 'the duplicate');
  assert.equal(t.shell.windows.floats.get(tables()[0]).spec.title, 'copy of results');
  assert.equal(t.api('ana').state().resultsCount, 8);
  // Rename: the table moves to a window of its own, Results are empty
  t.script.dialogs.push({ title: 'particles table' });
  click(button(win, 'Rename…'));
  await wait(() => tables().length === 2, 'the renamed table');
  assert.equal(t.api('ana').state().resultsCount, 0);
  // Plot…: a plot window of a column
  await t.runCommand('analyzeParticles', { display: true, clear: true });
  await settle();
  const plots = () => floats(t).filter((k) => /^plot-/.test(k)).length;
  const p0 = plots();
  t.script.dialogs.push({ table: 'Results', x: 'Area', y: 'Mean', color: 'red', lineWidth: 1, symbol: 'Circle', label: '' });
  click(button(win, 'Results'));
  click(button(win, 'Plot…'));
  await wait(() => plots() > p0, 'the plot of the table');
  // Summarize / Distribution are the commands of the Analyze menu
  click(button(win, 'Summarize'));
  await settle();
  assert.equal(resultsRows(t).length - 1, 12, 'Mean, SD, Min and Max rows');
  t.close();
});

await test('Results > Plot...: the defaults of PlotContentsDialog (blue, Circle, width 1, x = the first column), remembered after OK; "Plot of Results", x label "x" for "---"', async () => {
  const t = await fresh();
  await addDoc(t, {});
  await t.runCommand('analyzeParticles', { display: true, clear: true });
  await settle();
  const win = t.panel('results');
  const plots = () => floats(t).filter((k) => /^plot-/.test(k));
  const p0 = plots().length;
  t.script.dialogs.push({ x: '---', y: 'Mean', color: 'red', lineWidth: 2, symbol: 'Bar', label: '' });
  click(button(win, 'File'));   // the menu button toggles: switch through another menu
  click(button(win, 'Results'));
  click(button(win, 'Plot…'));
  await wait(() => plots().length > p0, 'the plot window');
  const spec = lastSpec(t);
  const val = (id) => fieldOf(spec, id).value;
  deq([val('color'), val('lineWidth'), val('symbol'), val('x'), val('y')], ['blue', 1, 'Circle', 'Area', 'Mean']);
  assert.equal(t.shell.windows.floats.get(plots().pop()).spec.title, 'Plot of Results');
  // PlotContentsDialog keeps the colour, the width and the symbol for the next plot
  t.script.dialogs.push({ x: 'Area', y: 'Mean', color: 'red', lineWidth: 2, symbol: 'Bar', label: '' });
  click(button(win, 'File'));   // the menu button toggles: switch through another menu
  click(button(win, 'Results'));
  click(button(win, 'Plot…'));
  await wait(() => plots().length > p0 + 1, 'the second plot window');
  t.script.dialogs.push({ x: 'Area', y: 'Mean', color: 'red', lineWidth: 2, symbol: 'Bar', label: '' });
  click(button(win, 'File'));   // the menu button toggles: switch through another menu
  click(button(win, 'Results'));
  click(button(win, 'Plot…'));
  await wait(() => plots().length > p0 + 2, 'the third plot window');
  const s2 = lastSpec(t);
  deq([fieldOf(s2, 'color').value, fieldOf(s2, 'lineWidth').value, fieldOf(s2, 'symbol').value], ['red', 2, 'Bar']);
  t.close();
});

await test('Edit > Options > Plots: Minimum Y / Maximum Y have 2 decimals (Profiler.java:66-67)', async () => {
  const t = await fresh();
  await addDoc(t, {});
  await t.runCommand('optPlots', null);
  const spec = lastSpec(t);
  deq(['ymin', 'ymax'].map((id) => fieldOf(spec, id).decimals), [2, 2]);
  t.close();
});

await test('Edit › Options › Input/Output: copy / save headers and row numbers, the file extension decides the delimiter', async () => {
  const t = await fresh();
  await addDoc(t, {});
  await t.runCommand('optInputOutput', null);
  const spec = lastSpec(t);
  assert.equal(spec.title, 'I/O Options');
  deq(spec.fields.filter((x) => x.type !== 'message').map((x) => x.id), ['ext', 'copyHeaders', 'copyRowNumbers', 'saveHeaders', 'saveRowNumbers']);
  deq(spec.fields.filter((x) => x.type !== 'message').map((x) => x.value), ['.csv', false, true, true, true]);
  assert.equal(spec.fields[0].labelKey && EN.dlg.ana.ioExt, 'File extension for tables (.csv, .tsv or .txt):');
  await t.runCommand('analyzeParticles', { display: true, clear: true, summarize: false });
  await settle();
  // default: Save As CSV with headers and row numbers; the numbers are written with the table's precision
  await t.runCommand('fileSaveResults');
  await wait(() => t.saved.length === 1, 'the saved file');
  assert.equal(t.saved[0].name, 'Results.csv');
  let text = Buffer.from(await t.saved[0].blob.arrayBuffer()).toString('utf8');
  let lines = text.replace(/\n+$/, '').split('\n');
  assert.equal(lines[0], ' ,Area,Mean,Min,Max');
  assert.equal(lines[1], '1,30,255,255,255');
  // tab separated text, no headers, no row numbers
  await t.runCommand('optInputOutput', { ext: 'txt', copyHeaders: true, copyRowNumbers: false, saveHeaders: false, saveRowNumbers: false });
  assert.equal(t.settings.get('ana.ext'), '.txt', 'a missing dot is added');
  await t.runCommand('optInputOutput', { ext: '', copyHeaders: false, copyRowNumbers: true, saveHeaders: true, saveRowNumbers: true });
  assert.equal(t.settings.get('ana.ext'), '.', 'Options.io: an empty extension becomes "." (nothing else is added)');
  await t.runCommand('optInputOutput', { ext: 'txt', copyHeaders: true, copyRowNumbers: false, saveHeaders: false, saveRowNumbers: false });
  await t.runCommand('fileSaveResults');
  await wait(() => t.saved.length === 2, 'the second file');
  assert.equal(t.saved[1].name, 'Results.txt');
  text = Buffer.from(await t.saved[1].blob.arrayBuffer()).toString('utf8');
  lines = text.trim().split('\n');
  assert.equal(lines.length, 8);
  assert.equal(lines[0], '30\t255\t255\t255');
  // Copy with headers and without row numbers
  let copied = '';
  t.page.navigator.clipboard = { writeText: async (s) => { copied = s; } };
  const win = t.panel('results');
  click(button(win, 'Edit'));
  click(button(win, 'Select All'));
  click(button(win, 'Copy'));
  await wait(() => copied, 'copied');
  assert.equal(copied.split('\n')[0], 'Area\tMean\tMin\tMax');
  assert.equal(copied.split('\n')[1], '30\t255\t255\t255');
  // decimal places in the file
  await t.runCommand('analyzeSetMeasurements', { area: true, mean: true, minMax: false, decimals: 5 });
  t.shell.opts.onRoi({ type: 'rect', x: 10, y: 8, w: 30, h: 20 }, { final: true });
  await t.runCommand('analyzeMeasure');
  await t.runCommand('optInputOutput', { ext: '.csv', saveHeaders: true, saveRowNumbers: true });
  await t.runCommand('fileSaveResults');
  await wait(() => t.saved.length === 3, 'the third file');
  lines = Buffer.from(await t.saved[2].blob.arrayBuffer()).toString('utf8').trim().split('\n');
  assert.match(lines[lines.length - 1], /^9,600,\d+\.\d{5},0,0$/, 'the cells nobody filled are 0');
  t.close();
});

await test('Repeat Command: runs the last command again, its dialog pre-filled with the last values; Undo is not remembered', async () => {
  const t = await fresh({ channels: 1 });
  const cmd = t.cmd('procRepeatCommand');
  deq(cmd.shortcut, ['r']);
  deq(cmd.menu, ['Process']);
  assert.equal(cmd.order, 120);
  assert.equal(cmd.repeatable, false);
  // nothing ran yet: a note, no error
  const d0 = t.log.dialogSpecs.length;
  await t.runCommand('procRepeatCommand');
  await settle();
  assert.equal(t.log.dialogSpecs.length, d0, 'no dialog, nothing to repeat');
  await t.runCommand('filterGaussian', { sigma: 3.5 });
  assert.equal(fieldOf(lastSpec(t), 'sigma').value, 2, 'the first run shows the default');
  const before = t.log.dialogSpecs.length;
  await t.runCommand('procRepeatCommand', { sigma: 3.5 });
  assert.equal(t.log.dialogSpecs.length, before + 1, 'the dialog comes back');
  assert.equal(fieldOf(lastSpec(t), 'sigma').value, 3.5, 'pre-filled with the value of the last run (ImageJ shows 3.50)');
  // a cancelled dialog leaves the remembered values alone
  await t.runCommand('filterGaussian', null);
  await t.runCommand('procRepeatCommand', null);
  assert.equal(fieldOf(lastSpec(t), 'sigma').value, 3.5);
  // Invert, Undo, Repeat inverts again: Undo is not the command to repeat (Executer.java:37-45)
  const id = t.activeId();
  const px0 = arr(await t.pixels(id, 0));
  await t.runCommand('editInvert');
  const px1 = arr(await t.pixels(id, 0));
  ndeq(px1, px0);
  await t.runCommand('editUndo');
  deq(arr(await t.pixels(id, 0)), px0);
  await t.runCommand('procRepeatCommand');
  deq(arr(await t.pixels(id, 0)), px1, 'Repeat inverted again');
  assert.equal(t.api('ana').lastCommand().id, 'editInvert');
  t.close();
});

await test('Find Commands: a search field over the commands, every word in the name or the menu path, Enter runs the only match, disabled rows greyed', async () => {
  const t = await fresh();
  await addDoc(t, {});
  const c = t.cmd('utilFindCommands');
  deq(c.menu, ['Plugins', 'Utilities']); assert.equal(c.order, 10); deq(c.shortcut, ['l']);
  await t.runCommand('utilFindCommands');
  await wait(() => t.panel('findCommands'), 'the panel');
  const root = t.panel('findCommands');
  const input = texts(root, 'INPUT').find((e) => e.type === 'text');
  const type = (text) => { input.value = text; for (const l of input.listeners.input || []) l({ target: input }); };
  const rowsOf = () => { const out = []; walk(root, (e) => { if (e.className && /ij-list-row/.test(e.className)) out.push(e); }); return out; };
  const names = () => rowsOf().map((r) => r.children[0].textContent);
  type('gauss');
  assert.ok(names().includes('Gaussian Blur…'), names().join('|'));
  type('process gauss');
  deq(names(), ['Gaussian Blur…'], 'a word may be part of the menu path');
  type('gauss nothing');
  assert.equal(names().length, 0);
  // matching is case-insensitive; the list is "Arrays.sort(commands)" (CommandFinder.java:472), a String sort that puts upper case before lower case
  type('FILTER');
  const all = names();
  assert.ok(all.length > 3);
  deq(all, all.slice().sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
  type('');
  const every = names();
  assert.ok(every.length > 100);
  deq(every, every.slice().sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)), 'the whole list in code-unit order');
  assert.ok(every.some((n, i) => i > 0 && every[i - 1].toLowerCase() > n.toLowerCase()), 'which is not the order without regard to case');
  // a command that cannot run now is greyed (no selection: Clear)
  type('clear outside');
  assert.ok(rowsOf()[0].className.includes('is-disabled'));
  // Enter on the only match runs it: Clear Results empties the table
  await t.runCommand('analyzeParticles', { display: true, clear: true });
  await settle();
  assert.equal(t.api('ana').state().resultsCount, 8);
  type('clear results');
  deq(names(), ['Clear Results']);
  input.listeners.keydown[0]({ key: 'Enter', preventDefault() {} });
  await wait(() => t.api('ana').state().resultsCount === 0, 'Clear Results ran');
  // the arrows move the selection, Enter runs it
  type('close');
  const n = names().length;
  assert.ok(n >= 2);
  input.listeners.keydown[0]({ key: 'ArrowUp', preventDefault() {} });
  assert.ok(rowsOf()[n - 1].className.includes('is-selected'), 'Up from the field selects the last row');
  input.listeners.keydown[0]({ key: 'ArrowDown', preventDefault() {} });
  assert.ok(rowsOf()[0].className.includes('is-selected'));
  t.close();
});

await test('every key the package reads exists in the four languages; plugin version untouched', async () => {
  const parts = langPart('ana');
  const flat = (o, p = '', out = {}) => { for (const k of Object.keys(o)) { if (o[k] && typeof o[k] === 'object') flat(o[k], p + k + '.', out); else out[p + k] = o[k]; } return out; };
  const en = flat(parts.en);
  for (const lang of ['fr', 'es', 'nl']) {
    const l = flat(parts[lang]);
    deq(Object.keys(l).sort(), Object.keys(en).sort(), lang + ' has the keys of en');
    for (const k of Object.keys(en)) assert.equal((en[k].match(/\{\w+\}/g) || []).sort().join(), (l[k].match(/\{\w+\}/g) || []).sort().join(), lang + ' ' + k + ' keeps its tokens');
  }
  const pj = JSON.parse(fs.readFileSync(path.join(ROOT, 'js', 'modules', 'studio', 'advanced-studio', 'plugin.json'), 'utf8'));
  assert.equal(pj.version, '1.1.0');
});

console.log(`ij ana commands: OK (${passed} groups)`);
process.exit(0);
