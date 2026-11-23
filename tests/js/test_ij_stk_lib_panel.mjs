// File › Open from Library… with the "Stack" choice (ij-cmds-lib.js + ij-proc-lib.js): the panel's controller over a synthetic ctx.studio.library
// through the real controller, worker and engine of tests/js/ij_harness.mjs. The slices of the range open as a real z-stack — from the
// processed volume (planes streamed in bands: doc.stack.*) and from the original TIFF (doc.tiff.stack, batched Range requests) — with the
// channels as channels and the z step as pixelDepth; refused with the size and the budget when it does not fit, before anything is read;
// cancel leaves nothing.   (The grid, the projections, the photographs: test_ij_lib_panel.mjs.)
//
// Run: node tests/js/test_ij_stk_lib_panel.mjs
import assert from 'node:assert/strict';
import { boot, until } from './ij_harness.mjs';
import { buildTiff, imagej, host, makeLibrary, sameArray } from './ij_lib_support.mjs';

let passed = 0;
async function test(name, fn) { try { await fn(); passed++; } catch (err) { console.error('FAIL ' + name); throw err; } }
const J = (x) => JSON.parse(JSON.stringify(x));
const arr = (a) => Array.from(a);
// documents and states come from vm contexts (another realm's arrays): compared by value
const deepEq = (a, b, m) => assert.equal(JSON.stringify(a), JSON.stringify(b), m);

// ── the synthetic site ──
const VOL = { dims: { x: 20, y: 16, z: 6 }, nc: 2, value: (c, x, y, z) => ((x * 3 + y * 5 + z * 17 + c * 40) % 250) + 1 };
const LEVELS = [
  { level: 0, dims: { x: 20, y: 16, z: 6 }, voxelUm: { x: 1, y: 1, z: 2 }, width: 20, height: 16 },
  { level: 1, dims: { x: 10, y: 8, z: 6 }, voxelUm: { x: 2, y: 2, z: 2 }, width: 10, height: 8 }];
const CHANNELS = [{ index: 0, name: 'DAPI', color: '#4488ff', window: { min: 0, max: 255 } }, { index: 1, name: 'GFP', color: '#44ff44', window: { min: 0, max: 255 } }];
const item = (id, name, type, o) => Object.assign({ id, name, type, stage: 'E8.5', embryo: 1, formatVersion: 4, dims: { x: 20, y: 16, z: 6 }, channels: CHANNELS.map((c) => ({ name: c.name, color: c.color })),
  physicalUm: { x: 20, y: 16, z: 12 }, thumbnail: 'DATA_WEB/' + id + '/thumbnail.webp', timepoints: null, mounted: false }, o || {});
const desc = (id, name, type, o) => Object.assign({ id, name, type, formatVersion: 4, timepoint: null, timepoints: null, mounted: false, treeKey: 'tk-' + name, channels: CHANNELS,
  physicalUm: { x: 20, y: 16, z: 12, calibrated: true }, levels: LEVELS,
  z: { available: true, levels: [0, 1], backend: 'bricks' }, oblique: { available: true, levels: [0, 1], backend: 'bricks' }, tiffs: [], photo: null }, o || {});

// the original TIFF of A: 16-bit, 2 channels × 6 slices at the volume's own sampling (1 µm, 2 µm), zlib + predictor
const TIFF_A = buildTiff({ w: 20, h: 16, pages: 12, bits: 16, rowsPerStrip: 4, compression: 'deflate', predictor: 2, name: 'A.tif', resolution: { x: 1, y: 1, unit: 1 },
  imagej: imagej({ channels: 2, slices: 6, spacing: 2, ranges: [0, 4000, 10, 3000], colors: ['#0000ff', '#00ff00'], labels: ['DAPI', 'GFP'], info: 'Dataset: A\nSource: Imaris .ims ResolutionLevel 0, native uint16\nVoxel size (um): X=1 Y=1 Z=2' }),
  pixel: (p, x, y) => ((p + 1) * 997 + x * 131 + y * 71) % 4001 });
// B: format 1, nothing readable but its TIFF (a coarser one: 10 × 8)
const TIFF_B = buildTiff({ w: 10, h: 8, pages: 12, bits: 8, name: 'B.tif', resolution: { x: 0.5, y: 0.5, unit: 1 }, dataset: '3d/B',
  imagej: imagej({ channels: 2, slices: 6, spacing: 2, info: 'Source: Imaris .ims ResolutionLevel 1, native uint8' }) });
// P: a photograph, its original is a 3-page ImageJ composite
const TIFF_P = buildTiff({ w: 12, h: 8, pages: 3, bits: 8, name: 'P x.tif', dataset: '2d/P', resolution: { x: 100, y: 100, unit: 3 },
  imagej: imagej({ channels: 3, slices: 1, spacing: 1, info: '', extra: { unit: '' }, colors: [] }) });
// L: a timelapse; its bundle TIFF is the frame 1
const TIFF_L = buildTiff({ w: 20, h: 16, pages: 6, bits: 8, name: 'L.tif', dataset: 'live/L', resolution: { x: 1, y: 1, unit: 1 },
  imagej: imagej({ channels: 1, slices: 6, spacing: 2, info: 'Source: Imaris .ims ResolutionLevel 0, native uint8, timepoint 1 of 0..2' }) });
const tiffEntry = (t, file) => ({ file: file || t.index.file, url: 'DATA_WEB/' + t.index.dataset + '/download/' + (file || t.index.file), sizeBytes: t.file.length });

// oblique: a plane through the volume (single / slab); bricks of 8³ — a column of them stored, one ESS, one failed in the failing variant
const GEOM = (spec) => ({ dims: VOL.dims, width: 18, height: 10, o: [0.05, 0.1, 0.2 + 0.01 * (spec.yaw || 0) / 10], a: [0.05, 0.004, 0.002], b: [-0.004, 0.08, 0.01], c: [0.01, 0.005, 0.05],
  steps: spec.projection === 'single' ? 1 : spec.thickness, projected: spec.projection !== 'single', projMode: spec.projection === 'max' ? 'max' : spec.projection === 'mean' ? 'mean' : null });
const brickBoxes = () => { const o = []; for (let z = 0; z < 6; z += 8) for (let y = 0; y < 16; y += 8) for (let x = 0; x < 20; x += 8) o.push({ x0: x, y0: y, z0: z, x1: Math.min(20, x + 8), y1: Math.min(16, y + 8), z1: Math.min(6, z + 8) }); return o; };
const dataOf = (b, c) => { const w = b.x1 - b.x0, h = b.y1 - b.y0, d = b.z1 - b.z0, a = new Uint8Array(w * h * d); for (let z = 0; z < d; z++) for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) a[(z * h + y) * w + x] = VOL.value(c, b.x0 + x, b.y0 + y, b.z0 + z); return a; };

function site(over) {
  const o = over || {};
  const datasets = {
    '3d/A': { item: item('3d/A', 'A', '3d', { mounted: true }), desc: desc('3d/A', 'A', '3d', { mounted: true, tiffs: [tiffEntry(TIFF_A)] }), tiffs: { 'A.tif': TIFF_A.index }, volume: VOL,
      geometry: GEOM, bricks: () => brickBoxes().map((box, i) => ({ box, data: (c) => dataOf(box, c), skip: o.ess && i === o.ess ? 'ess' : o.fail && i === o.fail ? 'fail' : null })) },
    '3d/B': { item: item('3d/B', 'B', '3d', { formatVersion: 1 }), tiffs: { 'B.tif': TIFF_B.index },
      desc: desc('3d/B', 'B', '3d', { formatVersion: 1, z: { available: false, levels: [], backend: 'none', reasonCode: 'LIBRARY_FORMAT_UNSUPPORTED' }, oblique: { available: false, levels: [], backend: 'none', reasonCode: 'LIBRARY_OBLIQUE_UNSUPPORTED' }, tiffs: [tiffEntry(TIFF_B)] }) },
    '3d/C': { item: item('3d/C', 'C', '3d', { formatVersion: 6 }), volume: VOL, geometry: GEOM, bricks: () => [], desc: desc('3d/C', 'C', '3d', { formatVersion: 6, z: { available: true, levels: [0], backend: 'planes' }, oblique: { available: true, levels: [0], backend: 'cuts' } }) },
    '2d/P': { item: item('2d/P', 'P', '2d', { dims: null, channels: [], timepoints: null }), tiffs: { 'P x.tif': TIFF_P.index },
      desc: desc('2d/P', 'P', '2d', { levels: [], channels: CHANNELS.concat([{ index: 2, name: 'C3', color: '#ff4444', window: { min: 0, max: 255 } }]), physicalUm: { x: 360, y: 240, z: null },
        z: { available: false, levels: [], backend: 'none', reasonCode: 'LIBRARY_FORMAT_UNSUPPORTED' }, oblique: { available: false, levels: [], backend: 'none', reasonCode: 'LIBRARY_OBLIQUE_UNSUPPORTED' },
        tiffs: [tiffEntry(TIFF_P, 'P x.tif')], photo: { imageUrl: 'DATA_WEB/2d/P/image.webp', previewUrl: 'DATA_WEB/2d/P/preview.webp', width: 12, height: 8, pixelSizeUm: { x: 30, y: 30 } } }) },
    'live/L': { item: item('live/L', 'L', 'live', { timepoints: 3 }), tiffs: { 'L.tif': TIFF_L.index }, volume: VOL,
      desc: (opt) => desc('live/L', 'L', 'live', { timepoint: opt.timepoint === undefined ? 0 : opt.timepoint, timepoints: 3, treeKey: 'tk-L' + (opt.timepoint || 0), tiffs: [tiffEntry(TIFF_L)] }) }
  };
  // the figure of the harness (what the entry flow asks the library about): a dataset the panel does not list, without a TIFF
  datasets['3d/HARNESS'] = { listed: false, item: item('3d/HARNESS', 'HARNESS', '3d'), desc: desc('3d/HARNESS', 'HARNESS', '3d') };
  if (o.noTiffA) datasets['3d/A'].desc.tiffs = [];
  return datasets;
}

// the worker of the harness has no network: the TIFFs of the site are served by fake hosts
function installWorkerGlobals(t, files) {
  const routes = new Map(files.map((f) => [f.index.url, host(f.file)]));
  const hostFetch = (url, init) => { const h = routes.get(String(url)); if (!h) return Promise.resolve(new Response('', { status: 404 })); return h.fetchImpl(url, init); };
  t.page.atob = atob;                                  // the page of the harness is a bare vm context
  const Orig = t.page.Worker;
  t.page.Worker = class extends Orig { constructor(u) { super(u); Object.assign(this.far, { fetch: hostFetch, AbortController, setInterval, clearInterval, DecompressionStream, atob }); } };
  return { routes, hostFetch };
}

async function start(over) {
  const o = over || {};
  const t = await boot({ channels: 2, localStore: o.localStore });
  const lib = makeLibrary({ datasets: site(o.site), preview: o.preview, bandRows: o.bandRows });
  t.ctx.studio.library = lib;
  const net = installWorkerGlobals(t, [TIFF_A, TIFF_B, TIFF_P, TIFF_L]);
  await t.open({ method: o.method || 'avg', start: 1, stop: t.vol.D, level: 0 });
  const api = t.api('lib');
  const photo = o.photo || (async () => ({ width: 6, height: 4, channels: [new Uint8Array(24).fill(9)] }));
  const ctl = t.page.IJLibPage.createController(api, { decodePhoto: photo, delay: (fn) => { const id = setTimeout(fn, 0); return () => clearTimeout(id); } });
  if (o.dom) o.dom(t);
  const el = t.page.document.createElement('div');
  ctl.mount(el);
  return { t, lib, ctl, api, net };
}
const newDocs = async (t, before) => (await t.docs()).filter((d) => !before.includes(d.docId));
const ids = async (t) => (await t.docs()).map((d) => d.docId);


await test('Stack is offered beside the projections; the result line says what it will make', async () => {
  const { t, ctl } = await start();
  await ctl.pick('3d/A');
  await until(() => ctl.st.tiffs.every((x) => x.state === 'ok') && ctl.st.descState === 'ready', 'indexed');
  assert.equal(ctl.isStack(), false);
  ctl.setStack(true);
  assert.equal(ctl.isStack(), true);
  assert.match(ctl.text(), /Stack \(no projection\)/);
  assert.match(ctl.resultLine(), /a stack of 6 slice\(s\), 20 × 16, 2 channel\(s\), 16-bit/);
  assert.equal(ctl.plan().kind, 'stackTiff');
  ctl.setSource('processed');
  assert.equal(ctl.plan().kind, 'stackProcessed');
  assert.match(ctl.resultLine(), /a stack of 6 slice\(s\), 20 × 16, 2 channel\(s\), 8-bit/);
  ctl.setRange(2, 2);
  assert.equal(ctl.isStack(), false, 'a single plane is no stack');
  assert.equal(ctl.plan().kind, 'zProcessed');
  t.close();
});

await test('open: the PROCESSED volume as a z-stack — every plane, channels kept, z step, names, provenance', async () => {
  const { t, lib, ctl } = await start({ bandRows: 5 });
  await ctl.pick('3d/A');
  await until(() => ctl.st.descState === 'ready', 'described');
  ctl.setSource('processed');
  ctl.setRange(1, 4);
  ctl.setStack(true);
  const before = await ids(t);
  assert.equal(await ctl.open(), true, ctl.st.note);
  const [doc] = await newDocs(t, before);
  assert.ok(doc, 'a new document');
  assert.equal(doc.name, 'A z 1-4');
  deepEq([doc.nZ, doc.nT, doc.bitDepth, doc.hyperstack, doc.nSlices, doc.channels.length], [4, 1, 8, true, 8, 2]);
  deepEq(doc.channels.map((c) => c.name), ['DAPI', 'GFP']);
  assert.equal(doc.calibration.pixelDepth, 2);
  deepEq([doc.calibration.pixelWidth, doc.calibration.unit], [1, 'µm']);
  for (let z = 0; z < 4; z++) for (let c = 0; c < 2; c++) {
    const want = new Uint8Array(320); for (let y = 0; y < 16; y++) for (let x = 0; x < 20; x++) want[y * 20 + x] = VOL.value(c, x, y, z + 1);
    const got = (await t.engine('doc.tile', { docId: doc.docId, channel: c, level: 0, tx: 0, ty: 0, pos: { z } })).data;
    sameArray(got, want, `channel ${c} slice ${z + 1}`);
  }
  assert.equal(doc.provenance.source, 'library');
  assert.match(doc.provenance.sessionKey, /^lib\|3d\/A\|tk-A\|\|z:1-4\|0\|stack\|processed\|[0-9a-z]+$/);
  assert.equal(t.shell.lay.adds.at(-1).placement, 'tab');
  assert.equal(lib.log.released.filter((x) => x === '3d/A').length, 1, 'the session was released');
  assert.equal(ctl.st.run, null);
  t.close();
});

await test('open: the original TIFF as a z-stack — 16-bit planes, display ranges and colours of the file, a few range requests', async () => {
  const { t, net, ctl } = await start();
  await ctl.pick('3d/A');
  await until(() => ctl.st.tiffs.every((x) => x.state === 'ok') && ctl.st.descState === 'ready', 'indexed');
  ctl.setRange(1, 4);
  ctl.setStack(true);
  assert.equal(ctl.plan().kind, 'stackTiff');
  const before = await ids(t);
  assert.equal(await ctl.open(), true, ctl.st.note);
  const [doc] = await newDocs(t, before);
  assert.equal(doc.name, 'A z 1-4');
  deepEq([doc.nZ, doc.nT, doc.bitDepth, doc.hyperstack, doc.channels.length], [4, 1, 16, true, 2]);
  deepEq(doc.channels.map((c) => [c.name, c.color]), [['DAPI', '#0000ff'], ['GFP', '#00ff00']]);
  deepEq([doc.channels[0].display.min, doc.channels[0].display.max, doc.channels[1].display.min, doc.channels[1].display.max], [0, 4000, 10, 3000]);
  assert.equal(doc.calibration.pixelDepth, 2);
  for (let z = 0; z < 4; z++) for (let c = 0; c < 2; c++) {
    const want = new Uint16Array(320); for (let y = 0; y < 16; y++) for (let x = 0; x < 20; x++) want[y * 20 + x] = TIFF_A.pixel((z + 1) * 2 + c, x, y, 0);
    sameArray((await t.engine('doc.tile', { docId: doc.docId, channel: c, level: 0, tx: 0, ty: 0, pos: { z } })).data, want, `channel ${c} slice ${z + 1}`);
  }
  assert.equal(doc.provenance.input, 'tiff');
  assert.match(doc.provenance.sessionKey, /\|z:1-4\|0\|stack\|tiff\|/);
  assert.ok(net.routes.get(TIFF_A.index.url).log.requests <= 2, 'no per-plane request burst: ' + net.routes.get(TIFF_A.index.url).log.requests);
  t.close();
});

await test('a stack that does not fit is refused with its size and the budget BEFORE anything is read', async () => {
  const { t, lib, net, ctl } = await start();
  await ctl.pick('3d/A');
  await until(() => ctl.st.tiffs.every((x) => x.state === 'ok') && ctl.st.descState === 'ready', 'indexed');
  ctl.setStack(true);
  // 6 planes × 2 channels × 20 × 16 × 2 bytes = 7680 B in memory, twice with the undo step
  t.page.IJLibPage.attach(t.ctx, { budget: () => 9000 });
  const p = ctl.plan();
  assert.equal(p.ok, false);
  assert.equal(p.reason, 'dlg.lib.stackTooLarge');
  ctl.setStack(true);                                                           // redraws the panel
  assert.match(ctl.text(), /This stack needs .* in memory and the Advanced view can use/);
  const before = await ids(t);
  assert.equal(await ctl.open(), false);
  assert.equal(net.routes.get(TIFF_A.index.url).log.requests, 0, 'nothing requested');
  assert.equal((await newDocs(t, before)).length, 0);
  // the processed volume: 6 × 2 × 320 = 3840 B, ×2 = 7680 fits 9000 at level 0; at 5000 only level 1 (10 × 8) fits
  ctl.setSource('processed');
  deepEq(ctl.levelRows().map((r) => [r.level, r.fits]), [[0, true], [1, true]]);
  t.page.IJLibPage.attach(t.ctx, { budget: () => 5000 });
  ctl.setStack(true);                                                           // the defaults are judged again
  deepEq(ctl.levelRows().map((r) => [r.level, r.fits]), [[0, false], [1, true]], 'a stack is judged with all its planes');
  ctl.setLevel(0);
  assert.equal(ctl.st.level, 1, 'a level that does not fit cannot be chosen');
  assert.equal(ctl.plan().ok, true);
  assert.equal(await ctl.open(), true, ctl.st.note);
  const [doc] = await newDocs(t, before);
  deepEq([doc.width, doc.height, doc.nZ], [10, 8, 6]);
  t.page.IJLibPage.attach(t.ctx, { budget: () => 0 });
  t.close();
});

await test('a projection chosen again after Stack goes back to the method', async () => {
  const { t, ctl } = await start();
  await ctl.pick('3d/A');
  await until(() => ctl.st.descState === 'ready', 'described');
  ctl.setStack(true);
  ctl.setStack(false);
  ctl.setMethod('max');
  assert.equal(ctl.isStack(), false);
  assert.equal(ctl.st.method, 'max');
  assert.notEqual(ctl.plan().kind, 'stackProcessed');
  t.close();
});

await test('cancel: a streamed stack read stops, the accumulator is dropped, no document appears', async () => {
  const { t, lib, ctl } = await start({ bandRows: 4 });
  await ctl.pick('3d/A');
  await until(() => ctl.st.descState === 'ready', 'described');
  ctl.setSource('processed');
  ctl.setStack(true);
  const before = await ids(t);
  const run = ctl.open();
  await until(() => !!ctl.st.run, 'running');
  ctl.cancel();
  assert.equal(await run, false);
  assert.equal((await newDocs(t, before)).length, 0);
  assert.equal(lib.log.released.filter((x) => x === '3d/A').length >= 1, true, 'session released');
  assert.match(ctl.st.note, /Cancelled/);
  t.close();
});

console.log(`ok test_ij_stk_lib_panel (${passed} groups)`);
