// The entry flow of the Advanced view (Studio figure → Z Project) with the original TIFF of the dataset: the Source choice of the dialog,
// the default method rule (Average Intensity on first use, then the last one used), the TIFF read through doc.tiff.project and the
// figure's slices mapped to the TIFF planes by µm, the session keys (`fkey|tiff|…`) and the resume rows labelled by source, the Open from
// Library button of a figure the view cannot read, cancel — through tests/js/ij_harness.mjs (the real controller, worker and engine).
//
// Run: node tests/js/test_ij_lib_entry.mjs
import assert from 'node:assert/strict';
import { boot, until, EN } from './ij_harness.mjs';
import { buildTiff, imagej, host, makeLibrary, sameArray } from './ij_lib_support.mjs';

let passed = 0;
async function test(name, fn) { try { await fn(); passed++; } catch (err) { console.error('FAIL ' + name); throw err; } }
const J = (x) => JSON.parse(JSON.stringify(x));
const deepEq = (a, b, m) => assert.equal(JSON.stringify(a), JSON.stringify(b), m);

// the harness figure: 40 × 30 × 5, 2 channels, voxel 0.5 × 0.5 × 2 µm; its original TIFF is 16-bit at the same sampling
const W = 40, H = 30, D = 5;
const TIFF = (over) => buildTiff(Object.assign({ w: W, h: H, pages: 2 * D, bits: 16, rowsPerStrip: 10, compression: 'deflate', predictor: 2, name: 'HARNESS.tif', dataset: '3d/HARNESS', resolution: { x: 2, y: 2, unit: 1 },
  imagej: imagej({ channels: 2, slices: D, spacing: 2, ranges: [0, 4000, 0, 3000], colors: ['#4488ff', '#44ff44'], labels: ['DAPI', 'GFP'], info: 'Source: Imaris .ims ResolutionLevel 0, native uint16' }),
  pixel: (p, x, y) => ((p + 3) * 811 + x * 53 + y * 17) % 4001 }, over || {}));
const describeOf = (t, o, depth) => Object.assign({ id: '3d/HARNESS', name: 'HARNESS', type: '3d', formatVersion: 4, timepoint: null, timepoints: null, mounted: true, treeKey: 'tree1',
  channels: [{ index: 0, name: 'DAPI', color: '#4488ff', window: { min: 0, max: 255 } }, { index: 1, name: 'GFP', color: '#44ff44', window: { min: 0, max: 255 } }],
  physicalUm: { x: W * 0.5, y: H * 0.5, z: (depth || D) * 2, calibrated: true },
  levels: [{ level: 0, dims: { x: W, y: H, z: depth || D }, voxelUm: { x: 0.5, y: 0.5, z: 2 }, width: W, height: H }],
  z: { available: true, levels: [0], backend: 'bricks' }, oblique: { available: true, levels: [0], backend: 'bricks' }, tiffs: [], photo: null }, o || {});

async function start(o) {
  const opt = o || {};
  const tiff = opt.tiff === undefined ? TIFF() : opt.tiff;
  const t = await boot({ channels: 2, localStore: opt.localStore, storage: opt.storage });
  const datasets = { '3d/HARNESS': { item: { id: '3d/HARNESS' }, tiffs: tiff ? { 'HARNESS.tif': tiff.index } : {}, desc: describeOf(t, tiff ? { tiffs: [{ file: 'HARNESS.tif', url: 'DATA_WEB/3d/HARNESS/download/HARNESS.tif', sizeBytes: tiff.file.length }] } : {}, opt.depth) } };
  const lib = opt.noLibrary ? null : makeLibrary({ datasets });
  if (lib) t.ctx.studio.library = lib;
  const files = [tiff].filter(Boolean);
  const delay = opt.delay || 0;
  const routes = new Map(files.map((f) => [f.index.url, host(f.file)]));
  t.page.atob = atob;
  const Orig = t.page.Worker;
  t.page.Worker = class extends Orig {
    constructor(u) {
      super(u);
      const fetch = async (url, init) => { if (delay) await new Promise((r) => setTimeout(r, delay)); const h = routes.get(String(url)); return h ? h.fetchImpl(url, init) : new Response('', { status: 404 }); };
      Object.assign(this.far, { fetch, AbortController, setInterval, clearInterval, DecompressionStream, atob });
    }
  };
  return { t, lib, tiff, routes };
}
// t.api is the harness's api-of-a-package function: the Studio's own api object (exit / close) is rebuilt here
const mountApp = (t) => t.IJApp.mount(t.root, { ctx: t.ctx, api: { exits: 0, async exit() { this.exits++; return true; }, async close() { return true; }, getDocument: () => null, token: () => 1 } });

await test('without a library the dialog is the one of wave 2 (no Source), Average Intensity first on first use, ZProjector order', async () => {
  const { t } = await start({ noLibrary: true });
  let spec = null;
  t.script.dialogs.push((s) => { spec = s; return { method: 'max', start: 1, stop: D, level: 0 }; });
  mountApp(t);
  const sh = await until(() => t.shells[t.shells.length - 1], 'shell');
  await until(() => spec, 'the Z Project dialog');
  await until(() => sh.images.filter(Boolean).some((i) => i.docId !== -1 && i.name), 'first image');
  const ids = spec.fields.map((f) => f.id);
  deepEq(ids, ['start', 'stop', 'method', 'level', 'note'], 'no source field: ZProjector.java:295-297 (Start slice, Stop slice, Projection type)');
  const method = spec.fields.find((f) => f.id === 'method');
  assert.equal(method.value, 'avg');
  deepEq(method.options.map((o) => o.value), ['avg', 'max', 'min', 'sum', 'sd', 'median']);
  assert.equal(t.settings.get('lib.method'), 'max', 'the method answered is remembered');
  t.close();
});

await test('the method last used is the next default (the library panel shares it)', async () => {
  const { t } = await start({ noLibrary: true });
  t.settings.set('lib.method', 'median');
  let spec = null;
  t.script.dialogs.push((s) => { spec = s; return { method: 'median', start: 1, stop: D, level: 0 }; });
  mountApp(t);
  await until(() => spec, 'dialog');
  assert.equal(spec.fields.find((f) => f.id === 'method').value, 'median');
  t.close();
});

await test('with the dataset\'s TIFF: a Source choice (TIFF by default, both sizes shown), the level only for the processed volume', async () => {
  const { t, lib } = await start();
  let spec = null;
  t.script.dialogs.push((s) => { spec = s; return { source: 'processed', method: 'max', start: 1, stop: D, level: 0 }; });
  mountApp(t);
  await until(() => spec, 'the Z Project dialog');
  deepEq(spec.fields.map((f) => f.id), ['start', 'stop', 'method', 'source', 'tiffNote', 'level', 'note']);
  const src = spec.fields.find((f) => f.id === 'source');
  assert.equal(src.value, 'tiff');
  assert.match(src.options[0].label, /Original TIFF — raw, no background subtraction, 16-bit, 40 × 30 × 5, .* from \.ims resolution level 0/);
  assert.match(src.options[1].label, /Processed volume — background subtracted, 8-bit, 40 × 30/);
  const level = spec.fields.find((f) => f.id === 'level');
  assert.equal(level.visibleIf({ source: 'tiff' }), false);
  assert.equal(level.visibleIf({ source: 'processed' }), true);
  assert.equal(spec.fields.find((f) => f.id === 'tiffNote').visibleIf({ source: 'processed' }), false);
  assert.equal(spec.validate({ source: 'tiff', method: 'max' }), null, 'a small TIFF fits');
  assert.equal(lib.log.calls.filter((c) => c[0] === 'tiffIndex').length, 1);
  await until(() => t.shells.length && t.shell.images.filter(Boolean).some((i) => i.docId !== -1 && i.name), 'image');
  assert.equal(t.settings.get('lib.source'), 'processed', 'the answer is remembered');
  t.close();
});

await test('Z Project from the original TIFF: the same µm, 16 bits kept, equal to IJProject; the key is fkey|tiff|…; one probe per figure', async () => {
  const { t, lib, tiff, routes } = await start();
  await t.open({ source: 'tiff', method: 'max', start: 2, stop: 4 });
  const docs = await t.docs();
  assert.equal(docs.length, 1);
  const d = docs[0];
  assert.equal(d.bitDepth, 16, 'Max of a 16-bit TIFF is 16-bit');
  assert.deepEqual([d.width, d.height], [W, H]);
  assert.match(d.name, /^HARNESS Z 1.3 \(Max Intensity\)$/, 'the figure\'s slices 2..4 are voxels 1..3');
  const ref = t.page.IJProject.create({ method: 'max', width: W, height: H, depth: 3, channels: 2, inputBitDepth: 16 });
  for (let c = 0; c < 2; c++) for (let z = 1; z <= 3; z++) {
    const p = new Uint16Array(W * H); for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) p[y * W + x] = tiff.pixel(z * 2 + c, x, y, 0);
    ref.addBlock({ channel: c, y0: 0, rows: H, z0: z - 1, depth: 1, data: p });
  }
  const want = ref.finish();
  for (let c = 0; c < 2; c++) sameArray(await t.pixels(d.docId, c), want[c].data, 'channel ' + c);
  assert.equal(d.provenance.source, 'figure');
  assert.equal(d.provenance.input, 'tiff');
  assert.equal([d.provenance.first, d.provenance.last].join('-'), '1-3');
  assert.match(d.provenance.sessionKey, /^3d\/HARNESS\|tree1\|\|z\|0-4\|tiff\|HARNESS\.tif\|max\|2-4\|[0-9a-z]+$/);
  deepEq(d.channels.map((c) => [c.name, c.color]), [['DAPI', '#4488ff'], ['GFP', '#44ff44']]);
  deepEq(d.calibration, { pixelWidth: 0.5, pixelHeight: 0.5, unit: 'µm' });
  assert.equal(routes.get(tiff.index.url).log.requests <= 2, true, 'range requests: ' + routes.get(tiff.index.url).log.requests);
  assert.equal(t.settings.get('lib.source'), 'tiff');
  // the Z Project command again on the same figure does not ask the server again
  const before = lib.log.calls.length;
  await t.runCommand('stackProject', { source: 'processed', method: 'sum', start: 1, stop: D, level: 0 });
  assert.equal(lib.log.calls.length, before, 'the probe is cached per figure');
  assert.equal((await t.docs()).length, 2);
  t.close();
});

await test('a TIFF that cannot serve the figure is not offered: unreadable, another field of view, no TIFF at all, a library that fails', async () => {
  const cases = [
    ['unsupported', { tiff: TIFF({ compression: 'none', predictor: 1 }), mutate: (x) => { x.index.compression = 5; } }],
    ['extent', { tiff: TIFF({ resolution: { x: 1, y: 1, unit: 1 } }) }],
    ['none', { tiff: null }]
  ];
  for (const [what, c] of cases) {
    if (c.mutate) c.mutate(c.tiff);
    const { t } = await start({ tiff: c.tiff });
    let spec = null;
    t.script.dialogs.push((s) => { spec = s; return { method: 'max', start: 1, stop: D, level: 0 }; });
    mountApp(t);
    await until(() => spec, what + ': the dialog');
    assert.equal(spec.fields.some((f) => f.id === 'source'), false, what + ': no Source choice');
    await until(() => t.shells.length && t.shell.images.filter(Boolean).some((i) => i.docId !== -1 && i.name), what + ': image');
    t.close();
  }
  // describe throws: the dialog is still the classic one
  const t = await boot({ channels: 2 });
  t.ctx.studio.library = makeLibrary({ datasets: {} });
  let spec = null;
  t.script.dialogs.push((s) => { spec = s; return { method: 'max', start: 1, stop: D, level: 0 }; });
  mountApp(t);
  await until(() => spec, 'dialog without a usable library');
  assert.equal(spec.fields.some((f) => f.id === 'source'), false);
  t.close();
});

await test('a stack that is not an XY stack (an XZ figure) never offers the TIFF', async () => {
  const { t, lib } = await start();
  t.vol.desc.axis = 'y';
  let spec = null;
  t.script.dialogs.push((s) => { spec = s; return { method: 'max', start: 1, stop: D, level: 0 }; });
  mountApp(t);
  await until(() => spec, 'dialog');
  assert.equal(spec.fields.some((f) => f.id === 'source'), false);
  assert.equal(lib.log.calls.filter((c) => c[0] === 'describe').length, 0, 'the library is not even asked');
  t.close();
});

await test('too large for the device: the TIFF choice is refused by the dialog\'s own check, per method (Sum is 32-bit float)', async () => {
  // 12000 × 9000 × 2 channels: 16-bit max fits the 1 GiB default budget with an undo step, a 32-bit sum does not
  const big = TIFF();
  big.index.width = 12000; big.index.height = 9000; big.index.rowsPerStrip = 9000; big.index.strips.perPage = 1; big.index.resolution = { x: 600, y: 600, unit: 1 };   // 12000 px of 1/600 µm = the figure's 20 µm
  // 1 strip per page needs 10 strips in total, not 40: rebuild the tables for one strip per page
  const offs = new Float64Array(10), cnts = new Uint32Array(10);
  for (let i = 0; i < 10; i++) { offs[i] = 8 + i * 100; cnts[i] = 10; }
  big.index.strips.offsets = Buffer.from(new Uint8Array(offs.buffer)).toString('base64');
  big.index.strips.byteCounts = Buffer.from(new Uint8Array(cnts.buffer)).toString('base64');
  const { t } = await start({ tiff: big });
  let spec = null;
  t.script.dialogs.push((s) => { spec = s; return { source: 'processed', method: 'max', start: 1, stop: D, level: 0 }; });
  mountApp(t);
  await until(() => spec, 'dialog');
  assert.equal(spec.fields.some((f) => f.id === 'source'), true);
  assert.equal(spec.validate({ source: 'tiff', method: 'max' }), null, 'Max of 16 bits: 12000 × 9000 × 2 channels × 2 bytes plus an undo step fits 1 GiB');
  deepEq(spec.validate({ source: 'tiff', method: 'sum' }), { source: 'proj.tooLarge' });
  assert.equal(spec.validate({ source: 'processed', method: 'sum' }), null, 'the processed volume has its own per-level check');
  await until(() => t.shells.length && t.shell.images.filter(Boolean).some((i) => i.docId !== -1 && i.name), 'image');
  t.close();
});

await test('resume: one stored session of the processed volume asks the plain question; sessions of both sources are offered, each row labelled', async () => {
  const { t } = await start();
  await t.open({ source: 'processed', method: 'max', start: 1, stop: D, level: 0 });
  await t.runCommand('stackProject', { source: 'tiff', method: 'max', start: 1, stop: D });
  const keys = (await t.docs()).map((d) => d.provenance.sessionKey);
  assert.equal(keys.length, 2);
  assert.ok(keys.some((k) => /\|tiff\|/.test(k)) && keys.some((k) => /\|0\|max\|/.test(k)));
  const store = t.store.shared;
  const t2 = await t.reload();
  const { lib } = { lib: makeLibrary({ datasets: { '3d/HARNESS': { item: { id: '3d/HARNESS' }, tiffs: {}, desc: describeOf(t2, {}) } } }) };
  t2.ctx.studio.library = lib;
  // both sources: two rows, the first (newest) is the primary
  t2.script.nextAsk = 'resume2';
  mountApp(t2);
  await until(() => t2.script.asks.some((a) => a.title === 'Resume your work?'), 'the resume question');
  const ask = t2.script.asks.find((a) => a.title === 'Resume your work?');
  deepEq(ask.options.map((o) => o.id), ['resume', 'resume2', 'fresh', 'cancel']);
  assert.match(ask.options[0].label, /^Resume the work from the (original TIFF|processed volume) \(/);
  assert.match(ask.options[1].label, /^Resume the work from the (original TIFF|processed volume) \(/);
  assert.notEqual(ask.options[0].label.replace(/\(.*$/, ''), ask.options[1].label.replace(/\(.*$/, ''), 'each row names its source');
  assert.match(ask.message, /more than one source/);
  await until(() => t2.shells.length && t2.shell.images.filter(Boolean).some((i) => i.docId !== -1 && i.name), 'restored');
  const back = await t2.docs();
  assert.equal(back.length, 1, 'only the chosen session came back');
  t2.close();
  void store;
});

await test('resume with one source only keeps the wave-2 question and button', async () => {
  const { t } = await start({ noLibrary: true });
  await t.open({ method: 'max', start: 1, stop: D, level: 0 });
  const t2 = await t.reload({ noLibrary: true });
  t2.script.nextAsk = 'resume';
  mountApp(t2);
  await until(() => t2.script.asks.some((a) => a.title === 'Resume your work?'), 'the resume question');
  const ask = t2.script.asks.find((a) => a.title === 'Resume your work?');
  deepEq(ask.options.map((o) => [o.id, o.label]), [['resume', 'Resume the saved work'], ['fresh', 'Start again from the data'], ['cancel', 'Cancel']]);
  assert.match(ask.message, /saved in this browser on/);
  await until(() => t2.shells.length && t2.shell.images.filter(Boolean).some((i) => i.docId !== -1 && i.name), 'restored');
  t2.close();
});

await test('the figure the view cannot read offers File › Open from Library… (and the Simple view)', async () => {
  const { t } = await start();
  t.vol.source.describe = () => ({ available: false, reasonKey: 'studioAdvanced.notSupported' });
  mountApp(t);
  const sh = await until(() => t.shells[t.shells.length - 1], 'shell');
  const texts = (el, out = []) => { if (el.tagName === 'BUTTON') out.push([el.textContent, el]); for (const c of el.children || []) texts(c, out); return out; };
  const empty = await until(() => sh.workspace.children.find((c) => c.className === 'ij-empty'), 'the empty state');
  const buttons = texts(empty);
  deepEq(buttons.map((b) => b[0]), ['Open from Library…', EN.cmd.fileSimple]);
  assert.equal(t.isEnabled('fileOpenLibrary'), true, 'the command works with no figure');
  buttons[0][1].listeners.click[0]();
  await until(() => t.panel('library'), 'the panel opened');
  t.close();
});

await test('the entry screen offers Open from Library… beside Z Project / Open / Simple view when a library exists, and not without one', async () => {
  for (const noLibrary of [false, true]) {
    const { t } = await start({ noLibrary });
    t.script.dialogs.push(() => new Promise(() => {}));                  // the Z Project dialog stays open: the entry screen stays
    mountApp(t);
    const sh = await until(() => t.shells[t.shells.length - 1], 'shell');
    const texts = (el, out = []) => { if (el.tagName === 'BUTTON') out.push([el.textContent, el]); for (const c of el.children || []) texts(c, out); return out; };
    const empty = await until(() => sh.workspace.children.find((c) => c.className === 'ij-empty'), 'the entry screen');
    const labels = texts(empty).map((b) => b[0]);
    assert.equal(labels.includes('Open from Library…'), !noLibrary, noLibrary ? 'no library, no button' : 'the library button: ' + labels.join(' | '));
    if (!noLibrary) {
      texts(empty).find((b) => b[0] === 'Open from Library…')[1].listeners.click[0]();
      await until(() => t.panel('library'), 'the panel opened');
    }
    t.close();
  }
});

await test('cancel while the TIFF is read: Cancel of the status bar stops the worker, no image, no error dialog', async () => {
  const slow = TIFF({ pages: 2 * 60, imagej: imagej({ channels: 2, slices: 60, spacing: 2, info: 'Source: Imaris .ims ResolutionLevel 0, native uint16' }), w: 40, h: 30, rowsPerStrip: 30, compression: 'none', predictor: 1 });
  const { t, routes } = await start({ tiff: slow, delay: 300, depth: 60 });
  t.vol.desc.levels[0].indices = Array.from({ length: 60 }, (_, i) => i);      // the figure has 60 slices of 2 µm too
  t.vol.desc.levels[0].dims.z = 60;
  let spec = null;
  t.script.dialogs.push((s) => { spec = s; return { source: 'tiff', method: 'max', start: 1, stop: 60 }; });
  mountApp(t);
  await until(() => spec, 'dialog');
  await until(() => routes.get(slow.index.url).log.requests >= 1, 'the read started');
  t.shell.opts.onCancel();
  await until(() => t.shell.progress.length && t.shell.progress.at(-1) === null, 'the busy state ended');
  await new Promise((r) => setTimeout(r, 100));
  assert.equal((await t.docs()).length, 0, 'no image');
  assert.equal(t.errors.length, 0, 'a cancel is not an error');
  t.close();
});

console.log('test_ij_lib_entry: ' + passed + ' groups passed');
void J;
