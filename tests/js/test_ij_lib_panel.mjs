// File › Open from Library… (ij-cmds-lib.js): the panel's controller over a synthetic ctx.studio.library, through the real controller, worker and
// engine of tests/js/ij_harness.mjs. The grid (search, type chips, keyboard), what describe() switches on or off, the defaults and the
// remembered choices, level estimates against the memory budget, and every way of opening: a z projection of the processed volume and of the
// original TIFF (equal to IJProject over the same data), an oblique plane brick by brick (equal to IJOblique.reference), a photograph (TIFF or
// webp), a timelapse frame; cancel, errors, the document it makes (undo / redo / reload).
//
// Run: node tests/js/test_ij_lib_panel.mjs
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

// ═════════════ the grid ═════════════
await test('the grid: every dataset a card; search over name / stage / type; type chips; badges and the on-screen mark', async () => {
  const { t, ctl } = await start();
  assert.equal(ctl.visible().length, 5);
  assert.match(ctl.text(), /5 of 5 datasets/);
  ctl.setQuery('live');
  deepEq(arr(ctl.visible()).map((x) => x.id), ['live/L'], 'the type label is searchable');
  ctl.setQuery('e8.5 a');
  deepEq(arr(ctl.visible()).map((x) => x.id), ['3d/A'], 'every word must match');
  ctl.setQuery('nothing like it');
  assert.equal(ctl.visible().length, 0);
  assert.match(ctl.text(), /No dataset matches/);
  ctl.setQuery('');
  ctl.toggleType('2d');
  deepEq(arr(ctl.visible()).map((x) => x.id), ['2d/P']);
  ctl.toggleType('live');
  assert.equal(ctl.visible().length, 2);
  ctl.toggleType('2d'); ctl.toggleType('live');
  assert.equal(ctl.visible().length, 5, 'no chip = every type');
  assert.match(ctl.text(), /On screen/, 'A is the dataset on screen');
  const cardText = (id) => { const i = ctl.visible().findIndex((x) => x.id === id); return ctl.text(ctl.refs.cards[i]); };
  assert.doesNotMatch(cardText('3d/A'), /TIFF/, 'a card has no TIFF badge before its dataset was described');
  assert.match(cardText('3d/A'), /On screen/);
  await ctl.pick('3d/A');
  await until(() => ctl.st.descState === 'ready', 'described');
  assert.match(cardText('3d/A'), /TIFF/, 'A has an original TIFF: its card says so');
  await ctl.pick('3d/C');
  await until(() => ctl.st.descState === 'ready' && ctl.st.desc.id === '3d/C', 'C described');
  assert.doesNotMatch(cardText('3d/C'), /TIFF/, 'C has none');
  t.close();
});

await test('keyboard: arrows move the cursor without any request, Enter picks, Home / End', async () => {
  const { t, lib, ctl } = await start();
  const before = lib.log.calls.length;
  assert.equal(ctl.st.cursor, 0);
  assert.equal(ctl.key('ArrowRight'), true);
  assert.equal(ctl.key('ArrowRight'), true);
  assert.equal(ctl.st.cursor, 2);
  ctl.key('ArrowLeft');
  assert.equal(ctl.st.cursor, 1);
  ctl.key('End'); assert.equal(ctl.st.cursor, 4);
  ctl.key('ArrowRight'); assert.equal(ctl.st.cursor, 4, 'stops at the end');
  ctl.key('Home'); assert.equal(ctl.st.cursor, 0);
  assert.equal(ctl.key('x'), false);
  assert.equal(lib.log.calls.length, before, 'moving the cursor asks the server nothing');
  ctl.key('ArrowRight');
  const shown = ctl.visible()[1];
  ctl.key('Enter');
  await until(() => ctl.st.descState === 'ready', 'described');
  assert.equal(ctl.st.selected, shown.id);
  assert.equal(lib.log.calls.filter((c) => c[0] === 'describe' && c[1] === shown.id).length, 1, 'one describe for one pick');
  t.close();
});

// ═════════════ what describe() switches on ═════════════
await test('A (on screen, with its TIFF): z-stack, TIFF by default, Average Intensity on first use, whole range, oblique on; the badge is remembered', async () => {
  const fresh = await boot({ channels: 2 });
  assert.equal(fresh.page.IJLibPage.createController(fresh.api('lib')).st.method, 'avg', 'Average Intensity on first use (ZProjector: Prefs.get(METHOD_KEY, AVG_METHOD))');
  fresh.close();
  const { t, ctl } = await start();
  await ctl.pick('3d/A');
  await until(() => ctl.st.tiffs.every((x) => x.state !== 'loading') && ctl.st.descState === 'ready', 'indexed');
  const s = ctl.st;
  deepEq([s.mode, s.method, s.source, s.first, s.last, s.level, s.tiffFile], ['z', 'avg', 'tiff', 0, 5, 0, 'A.tif']);
  assert.match(ctl.text(), /Original TIFF — raw, no background subtraction, 16-bit, 20 × 16 × 6/);
  assert.match(ctl.text(), /from \.ims resolution level 0/);
  assert.match(ctl.text(), /Processed volume — background subtracted, 8-bit, 20 × 16/);
  assert.match(ctl.text(), /TIFF/);
  assert.equal(ctl.plan().kind, 'zTiff');
  assert.equal(t.settings.get('lib.badges')['3d/A'], true, 'the TIFF badge is cached across reloads');
  assert.match(ctl.resultLine(), /Result: 20 × 16, 2 channel\(s\), 16-bit/);
  ctl.setMode('oblique');
  assert.equal(ctl.st.mode, 'oblique');
  assert.equal(ctl.plan().kind, 'oblique');
  t.close();
});

await test('B (format 1, nothing readable but a coarser TIFF): the TIFF is the only source, oblique is off with its reason and a link to the viewer', async () => {
  const { t, ctl } = await start();
  await ctl.pick('3d/B');
  await until(() => ctl.st.tiffs.length && ctl.st.tiffs.every((x) => x.state !== 'loading'), 'indexed');
  const s = ctl.st;
  deepEq([s.mode, s.source, s.tiffs[0].state], ['z', 'tiff', 'ok']);
  assert.equal(ctl.plan().kind, 'zTiff');
  assert.match(ctl.text(), /The TIFF is 10 × 8, coarser than the volume's 20 × 16/);
  assert.match(ctl.text(), /An oblique plane of this dataset cannot be read here\. Open it in the viewer\./);
  assert.match(ctl.text(), /Open this dataset in the viewer/);
  assert.match(ctl.text(), /Processed volume — not readable here/, 'the processed radio names the processed volume and says why it is off');
  ctl.setMode('oblique');
  assert.equal(ctl.st.mode, 'z', 'refused');
  ctl.setSource('processed');
  assert.equal(ctl.st.source, 'processed', 'the choice is stored, but Open is off:');
  assert.equal(ctl.plan().ok, false);
  t.close();
});

await test('C (no TIFF, format 6): only the processed volume; 2d P: TIFF or photograph; the badge of a dataset without TIFF is false', async () => {
  const { t, ctl } = await start();
  await ctl.pick('3d/C');
  await until(() => ctl.st.descState === 'ready', 'described');
  deepEq([ctl.st.source, ctl.plan().kind], ['processed', 'zProcessed']);
  assert.match(ctl.text(), /No original TIFF for this dataset/);
  assert.equal(t.settings.get('lib.badges')['3d/C'], false);
  await ctl.pick('2d/P');
  await until(() => ctl.st.tiffs.length && ctl.st.tiffs.every((x) => x.state !== 'loading'), 'indexed');
  assert.equal(ctl.st.mode, 'photo');
  deepEq([ctl.st.source, ctl.plan().kind], ['tiff', 'photoTiff']);
  assert.match(ctl.text(), /Photograph \(processed, 12 × 8\)/);
  ctl.setSource('processed');
  assert.equal(ctl.plan().kind, 'photoWebp');
  t.close();
});

await test('the source and the method are remembered (lib.source, lib.method); the next dataset starts from them', async () => {
  const { t, ctl } = await start();
  await ctl.pick('3d/A');
  await until(() => ctl.st.tiffs.every((x) => x.state === 'ok'), 'indexed');
  ctl.setSource('processed');
  ctl.setMethod('median');
  assert.equal(t.settings.get('lib.source'), 'processed');
  assert.equal(t.settings.get('lib.method'), 'median');
  await ctl.pick('3d/C');
  await until(() => ctl.st.descState === 'ready', 'described');
  assert.equal(ctl.st.method, 'median');
  await ctl.pick('3d/A');
  await until(() => ctl.st.tiffs.every((x) => x.state === 'ok') && ctl.st.descState === 'ready', 'indexed again');
  assert.equal(ctl.st.source, 'processed', 'the remembered source wins over "TIFF by default"');
  const t2 = await t.reload();
  const c2 = t2.page.IJLibPage.createController(t2.api('lib'));
  assert.equal(c2.st.method, 'median', 'a new page starts from the stored method');
  assert.equal(c2.st.badges['3d/A'], true, 'and from the stored badges');
  t2.close();
});

await test('levels: the memory budget disables what does not fit, the default is the finest that fits; a range of one slice is a single plane', async () => {
  const { t, ctl } = await start();
  t.page.IJLibPage.attach(t.ctx, { budget: () => 4000 });                       // level 0 as a 32-bit Sum: 20·16·2·4 = 2560 B, ×2 for the undo step
  ctl.setMethod('sum');
  await ctl.pick('3d/C');
  await until(() => ctl.st.descState === 'ready', 'described');
  deepEq(ctl.levelRows().map((r) => [r.level, r.fits]), [[0, false]], 'C offers level 0 only, and it does not fit');
  assert.equal(ctl.plan().ok, false);
  assert.match(ctl.text(), /Nothing fits the memory of this device/);
  await ctl.pick('3d/A');
  await until(() => ctl.st.descState === 'ready' && ctl.st.tiffs.every((x) => x.state === 'ok'), 'A');
  ctl.setSource('processed');
  deepEq(ctl.levelRows().map((r) => [r.level, r.fits]), [[0, false], [1, true]]);
  assert.equal(ctl.st.level, 1, 'the finest level that fits');
  ctl.setLevel(0);
  assert.equal(ctl.st.level, 1, 'a level that does not fit cannot be chosen');
  ctl.setMethod('max');                                                             // 8-bit output: 20·16·2 = 640 B
  deepEq(ctl.levelRows().map((r) => [r.level, r.fits]), [[0, true], [1, true]], 'the budget is judged at the method\'s output depth');
  ctl.setLevel(0);
  assert.equal(ctl.st.level, 0);
  ctl.setRange(2, 2);
  deepEq([ctl.st.first, ctl.st.last], [2, 2]);
  assert.match(ctl.text(), /Single plane: slice 2/);
  ctl.setRange(3, 1);
  assert.ok(ctl.st.first <= ctl.st.last, 'first never passes last');
  t.page.IJLibPage.attach(t.ctx, { budget: () => 0 });
  t.close();
});

await test('a timelapse: the timepoint field re-describes; the TIFF (one frame) is offered for its own timepoint only', async () => {
  const { t, lib, ctl } = await start();
  await ctl.pick('live/L');
  await until(() => ctl.st.tiffs.length && ctl.st.tiffs.every((x) => x.state !== 'loading'), 'indexed');
  assert.equal(ctl.st.timepoint, 0);
  assert.equal(ctl.st.tiffs[0].state, 'bad', 'the TIFF holds frame 1, not frame 0');
  assert.equal(ctl.st.tiffs[0].reason, 'frame');
  assert.match(ctl.text(), /The TIFF is of another timepoint/);
  assert.equal(ctl.plan().kind, 'zProcessed');
  await ctl.setTimepoint(1);
  await until(() => ctl.st.tiffs.length && ctl.st.tiffs.every((x) => x.state !== 'loading') && ctl.st.descState === 'ready', 're-described');
  assert.equal(ctl.st.tiffs[0].state, 'ok');
  deepEq(lib.log.calls.filter((c) => c[0] === 'describe' && c[1] === 'live/L').map((c) => c[2]), [0, 1], 'describe gets the timepoint');
  assert.equal(ctl.plan().kind, 'zTiff');
  await ctl.setTimepoint(9);
  assert.equal(ctl.st.timepoint, 2, 'clamped to the last frame');
  t.close();
});

await test('a describe that fails is said in the panel (and the viewer link when the viewer can serve it); an older answer never overwrites a newer pick', async () => {
  const sd = site();
  sd['3d/C'].describeError = 'LIBRARY_FORMAT_UNSUPPORTED';
  sd['3d/A'].latency = 60;
  const t = await boot({ channels: 2 });
  t.ctx.studio.library = makeLibrary({ datasets: sd });
  await t.open();
  const ctl = t.page.IJLibPage.createController(t.api('lib'), { delay: (fn) => { const i = setTimeout(fn, 0); return () => clearTimeout(i); } });
  ctl.mount(t.page.document.createElement('div'));
  await ctl.pick('3d/C');
  await until(() => ctl.st.descState === 'error', 'error');
  assert.match(ctl.text(), /stored in a way that cannot be read here/);
  assert.match(ctl.text(), /Open this dataset in the viewer/);
  const slow = ctl.pick('3d/A');
  await ctl.pick('3d/B');
  await slow;
  await until(() => ctl.st.descState === 'ready', 'ready');
  assert.equal(ctl.st.desc.id, '3d/B', 'the pick of B was the last one');
  t.close();
});

// ═════════════ opening ═════════════
await test('open: z projection of the PROCESSED volume equals IJProject over the same data; names, provenance, session key; one tab', async () => {
  const { t, lib, ctl } = await start();
  await ctl.pick('3d/A');
  await until(() => ctl.st.descState === 'ready', 'described');
  ctl.setSource('processed');
  ctl.setRange(1, 4);
  ctl.setMethod('sum');
  const before = await ids(t);
  assert.equal(await ctl.open(), true);
  const [doc] = await newDocs(t, before);
  assert.ok(doc, 'a new document');
  assert.equal(doc.name, 'SUM_A z 1-4');
  assert.equal(doc.bitDepth, 32, 'Sum of 8-bit slices: 32-bit float (ZProjector)');
  deepEq([doc.width, doc.height], [20, 16]);
  deepEq(doc.channels.map((c) => c.name), ['DAPI', 'GFP']);
  const ref = t.page.IJProject.create({ method: 'sum', width: 20, height: 16, depth: 4, channels: 2, inputBitDepth: 8 });
  for (let c = 0; c < 2; c++) for (let z = 1; z <= 4; z++) {
    const p = new Uint8Array(20 * 16); for (let y = 0; y < 16; y++) for (let x = 0; x < 20; x++) p[y * 20 + x] = VOL.value(c, x, y, z);
    ref.addBlock({ channel: c, y0: 0, rows: 16, z0: z - 1, depth: 1, data: p });
  }
  const want = ref.finish();
  for (let c = 0; c < 2; c++) sameArray(await t.pixels(doc.docId, c), want[c].data, 'channel ' + c);
  assert.equal(doc.provenance.source, 'library');
  assert.equal(doc.provenance.input, 'processed');
  assert.match(doc.provenance.sessionKey, /^lib\|3d\/A\|tk-A\|\|z:1-4\|0\|sum\|processed\|[0-9a-z]+$/);
  assert.equal(t.shell.lay.adds.at(-1).placement, 'tab');
  deepEq(J(doc.calibration), { pixelWidth: 1, pixelHeight: 1, unit: 'µm' });
  deepEq(lib.log.released.filter((x) => x === '3d/A').length, 1, 'the session was released');
  assert.match(ctl.st.note, /Opened as a new image/);
  assert.equal(ctl.st.run, null, 'the panel is free again');
  // a single slice: the plane itself, no prefix
  ctl.setRange(3, 3);
  const b2 = await ids(t);
  assert.equal(await ctl.open(), true);
  const [one] = await newDocs(t, b2);
  assert.equal(one.name, 'A z 3');
  sameArray(await t.pixels(one.docId, 1), (() => { const p = new Uint8Array(320); for (let y = 0; y < 16; y++) for (let x = 0; x < 20; x++) p[y * 20 + x] = VOL.value(1, x, y, 3); return p; })(), 'single plane (avg of one)');
  t.close();
});

await test('open: z projection of the ORIGINAL TIFF — 16-bit stays 16-bit for Max, equals IJProject, the display range and colours come from the file', async () => {
  const { t, net, ctl } = await start();
  await ctl.pick('3d/A');
  await until(() => ctl.st.tiffs.every((x) => x.state === 'ok') && ctl.st.descState === 'ready', 'indexed');
  ctl.setRange(1, 4);
  ctl.setMethod('max');
  assert.equal(ctl.st.source, 'tiff');
  const r = ctl.tiffRangeFor(ctl.st.tiffs[0]);
  deepEq(J(r), { jlo: 1, jhi: 4, single: false }, 'same z sampling: the same planes');
  const before = await ids(t);
  assert.equal(await ctl.open(), true);
  const [doc] = await newDocs(t, before);
  assert.equal(doc.name, 'MAX_A z 1-4');
  assert.equal(doc.bitDepth, 16);
  const ref = t.page.IJProject.create({ method: 'max', width: 20, height: 16, depth: 4, channels: 2, inputBitDepth: 16 });
  for (let c = 0; c < 2; c++) for (let z = 1; z <= 4; z++) {
    const p = new Uint16Array(320); for (let y = 0; y < 16; y++) for (let x = 0; x < 20; x++) p[y * 20 + x] = TIFF_A.pixel(z * 2 + c, x, y, 0);
    ref.addBlock({ channel: c, y0: 0, rows: 16, z0: z - 1, depth: 1, data: p });
  }
  const want = ref.finish();
  for (let c = 0; c < 2; c++) sameArray(await t.pixels(doc.docId, c), want[c].data, 'TIFF channel ' + c);
  deepEq(doc.channels.map((c) => [c.name, c.color]), [['DAPI', '#0000ff'], ['GFP', '#00ff00']]);
  deepEq([doc.channels[0].display.min, doc.channels[0].display.max, doc.channels[1].display.min, doc.channels[1].display.max], [0, 4000, 10, 3000]);
  assert.equal(doc.provenance.input, 'tiff');
  deepEq(J(doc.provenance.tiff), { file: 'A.tif', etag: TIFF_A.file.length + '-1731234567' });
  assert.match(doc.provenance.sessionKey, /\|z:1-4\|0\|max\|tiff\|/);
  assert.ok(net.routes.get(TIFF_A.index.url).log.requests <= 2, 'a few range requests for 8 pages, not one per strip: ' + net.routes.get(TIFF_A.index.url).log.requests);
  // a sum is 32-bit float whatever the input
  ctl.setMethod('sum');
  const b2 = await ids(t);
  await ctl.open();
  assert.equal((await newDocs(t, b2))[0].bitDepth, 32);
  t.close();
});

await test('open: the TIFF z range follows the µm of the dataset when the TIFF is coarser in z', async () => {
  const sd = site();
  const coarse = buildTiff({ w: 20, h: 16, pages: 6, bits: 8, name: 'A.tif', resolution: { x: 1, y: 1, unit: 1 }, imagej: imagej({ channels: 2, slices: 3, spacing: 4, info: 'Source: Imaris .ims ResolutionLevel 0' }) });
  sd['3d/A'].tiffs = { 'A.tif': coarse.index };
  sd['3d/A'].desc.tiffs = [tiffEntry(coarse)];
  const t = await boot({ channels: 2 });
  t.ctx.studio.library = makeLibrary({ datasets: sd });
  installWorkerGlobals(t, [coarse]);
  await t.open();
  const ctl = t.page.IJLibPage.createController(t.api('lib'));
  ctl.mount(t.page.document.createElement('div'));
  await ctl.pick('3d/A');
  await until(() => ctl.st.tiffs.every((x) => x.state === 'ok') && ctl.st.descState === 'ready', 'indexed');
  const rng = (a, b) => { ctl.setRange(a, b); return J(ctl.tiffRangeFor(ctl.st.tiffs[0])); };
  deepEq(rng(0, 5), { jlo: 0, jhi: 2, single: false }, 'the whole stack');
  deepEq(rng(2, 3), { jlo: 1, jhi: 1, single: false }, 'µm [4,8) is TIFF plane 1');
  deepEq(rng(3, 3), { jlo: 1, jhi: 1, single: true }, 'the centre 7 µm');
  deepEq(rng(1, 2), { jlo: 0, jhi: 1, single: false }, 'µm [2,6) touches planes 0 and 1');
  t.close();
});

await test('open: an oblique plane brick by brick equals IJOblique.reference; ESS bricks are zeros (nothing missing); a failed brick is said; backpressure', async () => {
  for (const variant of ['plain', 'ess', 'fail']) {
    const { t, lib, ctl } = await start({ site: { ess: variant === 'ess' ? 1 : 0, fail: variant === 'fail' ? 1 : 0 } });
    await ctl.pick('3d/A');
    await until(() => ctl.st.descState === 'ready', 'described');
    ctl.setMode('oblique');
    ctl.setSpec({ yaw: 20, pitch: -10, roll: 5, depth: 0.4, thickness: 3, projection: 'mean' });
    deepEq(J(ctl.st.spec), { yaw: 20, pitch: -10, roll: 5, depth: 0.4, thickness: 3, projection: 'mean' });
    const before = await ids(t);
    assert.equal(await ctl.open(), true, variant);
    const [doc] = await newDocs(t, before);
    assert.match(doc.name, /^A oblique \(yaw 20°, pitch -10°, roll 5°\)$/);
    deepEq([doc.width, doc.height, doc.bitDepth], [18, 10, 8]);
    deepEq(J(doc.calibration), { pixelWidth: 1.5, pixelHeight: 1.5, unit: 'µm' });
    const g = GEOM(ctl.st.spec);
    const boxes = brickBoxes();
    const lost = variant === 'plain' ? null : boxes[1];
    for (let c = 0; c < 2; c++) {
      const want = t.page.IJOblique.reference(g, (x, y, z) => (lost && x >= lost.x0 && x < lost.x1 && y >= lost.y0 && y < lost.y1 && z >= lost.z0 && z < lost.z1 ? 0 : VOL.value(c, x, y, z)));
      sameArray(await t.pixels(doc.docId, c), want, `${variant} channel ${c}`);
    }
    const adds = t.log.msgs.filter((m) => m.cmd === 'doc.oblique.add' && !m.args.done).length;
    assert.equal(adds, (boxes.length - (variant === 'plain' ? 0 : 1)) * 2, 'one add per delivered brick and channel');
    assert.ok(lib.log.maxOutstanding <= 8 && lib.log.maxOutstanding >= 1, 'bricks are awaited');
    const said = t.log.status.filter((s) => /could not be read and are left empty/.test(s));
    if (variant === 'fail') assert.equal(said.length, 1, 'the failed brick is said once');
    else assert.equal(said.length, 0, variant + ': nothing is said');
    assert.equal(doc.provenance.mode, 'oblique');
    assert.match(doc.provenance.sessionKey, /^lib\|3d\/A\|tk-A\|\|obl:20,-10,5,0.4,3,mean\|0\|mean\|processed\|/);
    assert.ok(lib.log.released.includes('3d/A#oblique'));
    t.close();
  }
});

await test('open: photographs — the original TIFF (3 pages = 3 channels, calibrated) or the picture decoded on the page; a grey picture is one channel', async () => {
  const seen = [];
  const { t, ctl } = await start({ photo: async (url) => { seen.push(url); return { width: 6, height: 4, channels: [new Uint8Array(24).fill(7), new Uint8Array(24).fill(8), new Uint8Array(24).fill(9)] }; } });
  await ctl.pick('2d/P');
  await until(() => ctl.st.tiffs.every((x) => x.state === 'ok') && ctl.st.descState === 'ready', 'indexed');
  const before = await ids(t);
  assert.equal(await ctl.open(), true);
  const [tiff] = await newDocs(t, before);
  assert.equal(tiff.name, 'P');
  deepEq([tiff.width, tiff.height, tiff.bitDepth, tiff.channels.length], [12, 8, 8, 3]);
  deepEq(J(tiff.calibration), { pixelWidth: 100, pixelHeight: 100, unit: 'µm' });
  for (let c = 0; c < 3; c++) sameArray(await t.pixels(tiff.docId, c), (() => { const p = new Uint8Array(96); for (let y = 0; y < 8; y++) for (let x = 0; x < 12; x++) p[y * 12 + x] = TIFF_P.pixel(c, x, y, 0); return p; })(), 'page ' + c);
  deepEq(tiff.channels.map((c) => c.color), ['#ff0000', '#00ff00', '#0000ff'], 'ImageJ default colours for 3 channels without LUTs');
  ctl.setSource('processed');
  const b2 = await ids(t);
  assert.equal(await ctl.open(), true);
  deepEq(seen, ['DATA_WEB/2d/P/image.webp']);
  const [webp] = await newDocs(t, b2);
  deepEq([webp.width, webp.height, webp.channels.length], [6, 4, 3]);
  deepEq(J(webp.calibration), { pixelWidth: 30, pixelHeight: 30, unit: 'µm' });
  deepEq(webp.channels.map((c) => c.name), ['R', 'G', 'B']);
  assert.equal((await t.pixels(webp.docId, 2))[0], 9);
  t.close();
  // a grey picture
  const g = await start({ photo: async () => ({ width: 6, height: 4, channels: [new Uint8Array(24).fill(5)] }) });
  await g.ctl.pick('2d/P');
  await until(() => g.ctl.st.descState === 'ready', 'described');
  g.ctl.setSource('processed');
  const b3 = await ids(g.t);
  await g.ctl.open();
  const [grey] = await newDocs(g.t, b3);
  deepEq([grey.channels.length, grey.channels[0].name], [1, 'Gray']);
  g.t.close();
});

await test('open: a timelapse frame carries its timepoint in the name, the key and the provenance', async () => {
  const { t, lib, ctl } = await start();
  await ctl.pick('live/L');
  await until(() => ctl.st.descState === 'ready', 'described');
  await ctl.setTimepoint(2);
  await until(() => ctl.st.descState === 'ready' && ctl.st.desc.timepoint === 2, 'frame 2');
  ctl.setSource('processed');
  ctl.setRange(0, 2);
  const before = await ids(t);
  assert.equal(await ctl.open(), true);
  const [doc] = await newDocs(t, before);
  assert.match(doc.name, /^AVG_L z 0-2 t2$/);
  assert.equal(doc.provenance.timepoint, 2);
  assert.match(doc.provenance.sessionKey, /^lib\|live\/L\|tk-L2\|2\|z:0-2\|0\|avg\|processed\|/);
  assert.equal(lib.log.calls.find((c) => c[0] === 'openPlanes')[2].timepoint, 2);
  t.close();
});

// ═════════════ cancel, errors ═════════════
await test('cancel: the panel stops a streamed read, aborts the accumulator, releases the session, and no document appears', async () => {
  const { t, lib, ctl } = await start({ bandRows: 2, zChunk: 1 });
  await ctl.pick('3d/A');
  await until(() => ctl.st.descState === 'ready', 'described');
  ctl.setSource('processed');
  const before = await ids(t);
  const running = ctl.open();
  await until(() => t.log.msgs.some((m) => m.cmd === 'doc.zproj.add'), 'the stream started');
  assert.equal(ctl.cancel(), true);
  assert.equal(await running, false);
  await until(() => t.log.msgs.some((m) => m.cmd === 'doc.zproj.abort'), 'the accumulator was dropped');
  deepEq(await newDocs(t, before), []);
  assert.equal(ctl.st.run, null);
  assert.match(ctl.st.note, /Cancelled/);
  assert.ok(lib.log.released.includes('3d/A'));
  assert.equal(t.errors.length, 0, 'a cancel is not an error');
  assert.equal(ctl.cancel(), false, 'nothing to cancel');
  t.close();
});

await test('errors: a library refusal reaches the operator as a sentence of the dictionary, never the message; the panel is usable again', async () => {
  const sd = site();
  sd['3d/A'].obliqueError = 'LIBRARY_PLANE_MISSES';
  const t = await boot({ channels: 2 });
  t.ctx.studio.library = makeLibrary({ datasets: sd });
  installWorkerGlobals(t, [TIFF_A]);
  await t.open();
  const ctl = t.page.IJLibPage.createController(t.api('lib'));
  ctl.mount(t.page.document.createElement('div'));
  await ctl.pick('3d/A');
  await until(() => ctl.st.descState === 'ready', 'described');
  ctl.setMode('oblique');
  const before = await ids(t);
  assert.equal(await ctl.open(), false);
  assert.equal(t.errors.length, 1);
  assert.match(t.errors[0].message, /The plane does not meet the volume/);
  assert.doesNotMatch(t.errors[0].message, /oblique$/, 'not err.message');
  deepEq(await newDocs(t, before), []);
  assert.equal(ctl.st.run, null);
  assert.match(ctl.st.note, /was not opened/);
  t.errors.length = 0;
  // a worker command that refuses (bad TIFF range) is reported once by the app, the panel does not repeat it
  ctl.setMode('z');
  t.close();
});

// ═════════════ the command, the panel window, the document ═════════════
await test('File › Open from Library…: enabled when the page has a library, opens the panel window, builds the controller; off without a library', async () => {
  const none = await boot({ channels: 2 });
  await none.open();
  assert.equal(none.isEnabled('fileOpenLibrary'), false, 'no ctx.studio.library: the command is off');
  none.close();
  const { t, ctl } = await start();
  assert.equal(t.isEnabled('fileOpenLibrary'), true);
  const c = t.cmd('fileOpenLibrary');
  deepEq([c.menu.join('/'), c.order, c.labelKey], ['File', 12, 'cmd.fileOpenLibrary']);
  await t.runCommand('fileOpenLibrary');
  const el = t.panel('library');
  assert.ok(el, 'the panel is a tool window');
  const built = t.page.IJLibPage.last();
  assert.ok(built && built !== ctl, 'its own controller');
  assert.equal(built.visible().length, 5, 'built from library.list()');
  assert.match(built.text(), /Original TIFFs exist on the server only where the operator built the download bundles/);
  t.api('lib').closePanel('library');
  await until(() => t.page.IJLibPage.last() === null, 'disposed');
  t.close();
});

await test('the library document is an image like any other: a command, undo, redo; and it survives a reload (File › Recover)', async () => {
  const { t, ctl } = await start();
  await ctl.pick('3d/A');
  await until(() => ctl.st.descState === 'ready' && ctl.st.tiffs.every((x) => x.state === 'ok'), 'indexed');
  ctl.setMethod('max');
  ctl.setRange(0, 5);
  const before = await ids(t);
  await ctl.open();
  const [doc] = await newDocs(t, before);
  const pix0 = await t.pixels(doc.docId, 0);
  await t.runCommand('editInvert');
  const inv = await t.pixels(doc.docId, 0);
  assert.notDeepEqual(arr(inv.slice(0, 20)), arr(pix0.slice(0, 20)));
  await t.runCommand('editUndo');
  sameArray(await t.pixels(doc.docId, 0), pix0, 'undone');
  await t.runCommand('editRedo');
  sameArray(await t.pixels(doc.docId, 0), inv, 'redone');
  const key = doc.provenance.sessionKey;
  const t2 = await t.reload();
  const t2lib = makeLibrary({ datasets: site() });
  t2.ctx.studio.library = t2lib;
  await t2.open();
  t2.script.dialogs.length = 0;                                  // the figure's own session was resumed: its Z Project answer was not used
  const rec = (await t2.engine('session.list', {})).sessions.find((s) => s.key === key);
  assert.ok(rec, 'the library session is stored: File › Recover lists it');
  await t2.runCommand('fileRecover', { key, action: 'restore' });
  const restored = (await t2.docs()).find((d) => d.name === 'MAX_A z 0-5');
  assert.ok(restored, 'the document came back');
  sameArray(await t2.pixels(restored.docId, 0), inv, 'with its edit');
  t2.close();
});

// ═════════════ the preview, the viewer link, several TIFFs ═════════════
await test('the live preview: a mounted dataset only, 256 px, debounced 250 ms, the plane of the sliders; nothing for another dataset', async () => {
  const bitmaps = [];
  const { t, lib } = await start({ preview: (id, q) => { const b = { width: 256, height: 200, closed: false, close() { b.closed = true; } }; bitmaps.push([id, q, b]); return b; } });
  const ctl = t.page.IJLibPage.createController(t.api('lib'));          // the real 250 ms debounce
  ctl.mount(t.page.document.createElement('div'));
  await ctl.pick('3d/A');
  await until(() => ctl.st.descState === 'ready', 'described');
  ctl.setRange(1, 3); ctl.setRange(2, 3); ctl.setRange(2, 4);
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(lib.log.calls.filter((c) => c[0] === 'preview').length, 0, 'not before the debounce');
  await until(() => lib.log.calls.some((c) => c[0] === 'preview'), 'a preview', 2000);
  const calls = lib.log.calls.filter((c) => c[0] === 'preview');
  assert.equal(calls.length, 1, 'three moves, one preview');
  deepEq(calls[0].slice(1), ['3d/A', { z: 2 }, 256]);
  await until(() => ctl.st.previewState === 'shown', 'drawn');
  assert.equal(bitmaps[0][2].closed, true, 'the bitmap is released after drawing');
  ctl.setMode('oblique');
  ctl.setSpec({ yaw: 30 });
  await until(() => lib.log.calls.filter((c) => c[0] === 'preview').length === 2, 'the oblique preview', 2000);
  assert.equal(lib.log.calls.filter((c) => c[0] === 'preview')[1][2].spec.yaw, 30);
  const n = lib.log.calls.filter((c) => c[0] === 'preview').length;
  await ctl.pick('3d/C');                                                // not on screen: no preview at all
  await until(() => ctl.st.descState === 'ready' && ctl.st.desc.id === '3d/C', 'C');
  ctl.setRange(0, 1);
  await new Promise((r) => setTimeout(r, 350));
  assert.equal(lib.log.calls.filter((c) => c[0] === 'preview').length, n);
  ctl.dispose();
  t.close();
});

await test('a refusal while opening that the viewer can serve leaves a link to it beside the note', async () => {
  const sd = site();
  sd['3d/A'].obliqueError = 'LIBRARY_OBLIQUE_UNSUPPORTED';
  const t = await boot({ channels: 2 });
  t.ctx.studio.library = makeLibrary({ datasets: sd });
  installWorkerGlobals(t, [TIFF_A]);
  await t.open();
  const ctl = t.page.IJLibPage.createController(t.api('lib'));
  ctl.mount(t.page.document.createElement('div'));
  await ctl.pick('3d/A');
  await until(() => ctl.st.descState === 'ready', 'described');
  ctl.setMode('oblique');
  await ctl.open();
  assert.equal(ctl.st.noteViewer, true);
  assert.match(ctl.text(), /Open this dataset in the viewer/);
  assert.match(t.errors[0].message, /An oblique plane of this dataset cannot be read here/);
  t.close();
});

await test('several TIFFs: a choice of file, the largest first; one that the stream cannot read is left out', async () => {
  const sd = site();
  const small = buildTiff({ w: 10, h: 8, pages: 12, bits: 8, name: 'A-small.tif', dataset: '3d/A', resolution: { x: 0.5, y: 0.5, unit: 1 },
    imagej: imagej({ channels: 2, slices: 6, spacing: 2, info: 'Source: Imaris .ims ResolutionLevel 1' }) });
  const odd = buildTiff({ w: 20, h: 16, pages: 12, bits: 8, name: 'A-odd.tif', dataset: '3d/A', resolution: { x: 1, y: 1, unit: 1 }, imagej: imagej({ channels: 2, slices: 6, spacing: 2, info: '' }) });
  odd.index.compression = 5;
  sd['3d/A'].tiffs = { 'A.tif': TIFF_A.index, 'A-small.tif': small.index, 'A-odd.tif': odd.index };
  sd['3d/A'].desc.tiffs = [tiffEntry(small), tiffEntry(odd), tiffEntry(TIFF_A)];
  const t = await boot({ channels: 2 });
  t.ctx.studio.library = makeLibrary({ datasets: sd });
  t.page.atob = atob;
  await t.open();
  const ctl = t.page.IJLibPage.createController(t.api('lib'));
  ctl.mount(t.page.document.createElement('div'));
  await ctl.pick('3d/A');
  await until(() => ctl.st.tiffs.length === 3 && ctl.st.tiffs.every((x) => x.state !== 'loading'), 'indexed');
  deepEq(ctl.st.tiffs.map((x) => [x.file, x.state, x.reason]), [['A-small.tif', 'ok', null], ['A-odd.tif', 'bad', 'unsupported'], ['A.tif', 'ok', null]]);
  assert.equal(ctl.st.tiffFile, 'A.tif', 'the finest by default');
  assert.match(ctl.text(), /TIFF file/);
  ctl.setTiff('A-small.tif');
  assert.equal(ctl.st.tiffFile, 'A-small.tif');
  assert.match(ctl.text(), /The TIFF is 10 × 8, coarser than the volume's 20 × 16/);
  ctl.setTiff('A-odd.tif');
  assert.equal(ctl.st.tiffFile, 'A-small.tif', 'an unusable file cannot be chosen');
  t.close();
});


// ═════════════ review fixes ═════════════
// the buttons of a rendered subtree (the stand-in elements keep `textContent` and `children`)
const buttonsOf = (n, out = []) => { if (n.tagName === 'BUTTON') out.push(n.textContent); for (const c of n.children || []) buttonsOf(c, out); return out; };

await test('the panel builds on a DOM whose `children` is getter-only (an Element: assigning it throws in strict mode)', async () => {
  const { t, ctl } = await start({ dom: (tt) => {
    const orig = tt.page.document.createElement;
    tt.page.document.createElement = (tag) => {
      const e = orig(tag);
      const kids = e.children;
      delete e.children;
      Object.defineProperty(e, 'children', { get: () => kids });
      e.replaceChildren = () => { kids.length = 0; };
      e.remove = () => { const p = e.parentNode; if (p) { const i = p.children.indexOf(e); if (i >= 0) p.children.splice(i, 1); } };
      return e;
    };
  } });
  assert.equal(ctl.refs.cards.length, 5, 'the grid is drawn');
  ctl.setQuery('live');
  assert.equal(ctl.refs.cards.length, 1, 'and redrawn');
  ctl.setQuery('');
  await ctl.pick('3d/A');
  await until(() => ctl.st.descState === 'ready', 'described');
  assert.match(ctl.text(), /Open/);
  t.close();
});

await test('a TIFF read offers no Cancel in the panel (it cannot reach the worker request), shows the worker\'s progress, and still opens', async () => {
  const { t, ctl } = await start();
  await ctl.pick('3d/A');
  await until(() => ctl.st.tiffs.every((x) => x.state === 'ok') && ctl.st.descState === 'ready', 'indexed');
  assert.equal(ctl.st.source, 'tiff');
  const seen = new Set();
  let polling = true;
  (async () => { while (polling) { if (ctl.st.run && ctl.st.run.label) seen.add(ctl.st.run.label); await new Promise((r) => setImmediate(r)); } })();
  const before = await ids(t);
  const run = ctl.open();
  assert.equal(ctl.st.run.kind, 'tiff');
  assert.ok(!buttonsOf(ctl.refs.detail).includes('Cancel'), 'no Cancel button for the TIFF read: ' + buttonsOf(ctl.refs.detail).join('|'));
  assert.match(ctl.text(), /Use Cancel in the status bar/);
  assert.equal(await run, true);
  polling = false;
  assert.ok([...seen].some((l) => /Reading the volume/.test(l)), 'the panel shows a per-page share: ' + [...seen].join(' | '));
  assert.equal((await newDocs(t, before)).length, 1);
  // a processed read keeps its Cancel
  ctl.setSource('processed');
  const p2 = ctl.open();
  assert.ok(buttonsOf(ctl.refs.detail).includes('Cancel'), 'a processed read can be cancelled from the panel');
  await p2;
  t.close();
});

await test('the TIFF read is refused up front when its accumulators cannot fit the memory (the entry flow does the same)', async () => {
  const { t, ctl } = await start();
  t.page.IJLibPage.attach(t.ctx, { budget: () => 1 << 20 });
  await ctl.pick('3d/A');
  await until(() => ctl.st.tiffs.every((x) => x.state === 'ok') && ctl.st.descState === 'ready', 'indexed');
  assert.equal(ctl.st.source, 'tiff');
  assert.equal(ctl.plan().ok, false);
  assert.equal(ctl.plan().reason, 'dlg.lib.noLevelFits');
  t.page.IJLibPage.attach(t.ctx, { budget: () => 256 << 20 });
  ctl.setRange(0, 5);
  assert.equal(ctl.plan().kind, 'zTiff');
  t.page.IJLibPage.attach(t.ctx, { budget: () => 0 });
  t.close();
});

await test('a photograph decoded on the page travels as RGBA and is split in the worker: grey = one channel, colour = R, G, B', async () => {
  const rgba = (f) => { const a = new Uint8ClampedArray(6 * 4 * 4); for (let i = 0; i < 24; i++) { const [r, g, b] = f(i); a.set([r, g, b, 255], i * 4); } return a; };
  for (const variant of ['colour', 'grey']) {
    const { t, ctl } = await start({ photo: async () => ({ width: 6, height: 4, rgba: variant === 'grey' ? rgba((i) => [i * 9, i * 9, i * 9]) : rgba((i) => [i, 2 * i, 3 * i]) }) });
    await ctl.pick('2d/P');
    await until(() => ctl.st.descState === 'ready', 'described');
    ctl.setSource('processed');
    const before = await ids(t);
    assert.equal(await ctl.open(), true);
    const [doc] = await newDocs(t, before);
    deepEq([doc.width, doc.height, doc.bitDepth], [6, 4, 8]);
    deepEq(J(doc.calibration), { pixelWidth: 30, pixelHeight: 30, unit: 'µm' });
    if (variant === 'grey') {
      deepEq(doc.channels.map((c) => c.name), ['Gray']);
      sameArray(await t.pixels(doc.docId, 0), Uint8Array.from({ length: 24 }, (_, i) => i * 9), 'grey');
    } else {
      deepEq(doc.channels.map((c) => c.name), ['R', 'G', 'B']);
      sameArray(await t.pixels(doc.docId, 1), Uint8Array.from({ length: 24 }, (_, i) => 2 * i), 'G');
      sameArray(await t.pixels(doc.docId, 2), Uint8Array.from({ length: 24 }, (_, i) => 3 * i), 'B');
    }
    t.close();
  }
});

await test('a photograph opened from a TIFF without a resolution is calibrated with the dataset\'s pixelSizeUm', async () => {
  const sd = site();
  const bare = buildTiff({ w: 12, h: 8, pages: 3, bits: 8, name: 'P x.tif', dataset: '2d/P', resolution: null, imagej: imagej({ channels: 3, slices: 1, spacing: 1, info: '', extra: { unit: '' }, colors: [] }) });
  sd['2d/P'].tiffs = { 'P x.tif': bare.index };
  sd['2d/P'].desc.tiffs = [tiffEntry(bare, 'P x.tif')];
  const t = await boot({ channels: 2 });
  t.ctx.studio.library = makeLibrary({ datasets: sd });
  installWorkerGlobals(t, [bare]);
  await t.open();
  const ctl = t.page.IJLibPage.createController(t.api('lib'));
  ctl.mount(t.page.document.createElement('div'));
  await ctl.pick('2d/P');
  await until(() => ctl.st.tiffs.every((x) => x.state === 'ok') && ctl.st.descState === 'ready', 'indexed');
  const before = await ids(t);
  assert.equal(await ctl.open(), true);
  const [doc] = await newDocs(t, before);
  deepEq(J(doc.calibration), { pixelWidth: 30, pixelHeight: 30, unit: 'µm' });
  t.close();
});

await test('a coarser TIFF that maps the chosen slices onto one plane is a copy: named, keyed and run as such (no method prefix)', async () => {
  const sd = site();
  const one = buildTiff({ w: 20, h: 16, pages: 2, bits: 8, name: 'A.tif', resolution: { x: 1, y: 1, unit: 1 }, imagej: imagej({ channels: 2, slices: 1, spacing: 12, info: 'Source: Imaris .ims ResolutionLevel 0' }) });
  sd['3d/A'].tiffs = { 'A.tif': one.index };
  sd['3d/A'].desc.tiffs = [tiffEntry(one)];
  const t = await boot({ channels: 2 });
  t.ctx.studio.library = makeLibrary({ datasets: sd });
  installWorkerGlobals(t, [one]);
  await t.open();
  const ctl = t.page.IJLibPage.createController(t.api('lib'));
  ctl.mount(t.page.document.createElement('div'));
  await ctl.pick('3d/A');
  await until(() => ctl.st.tiffs.every((x) => x.state === 'ok') && ctl.st.descState === 'ready', 'indexed');
  ctl.setRange(0, 5);
  ctl.setMethod('max');
  const before = await ids(t);
  assert.equal(await ctl.open(), true);
  const [doc] = await newDocs(t, before);
  assert.doesNotMatch(doc.name, /^MAX_/, 'the title does not claim a Max projection: ' + doc.name);
  assert.equal(doc.provenance.method, 'avg');
  assert.match(doc.provenance.sessionKey, /\|avg\|tiff\|/);
  t.close();
});

await test('a timepoint change keeps the slice range; the slab thickness is off for a single plane; the missing pixels of an oblique plane stay in the panel', async () => {
  const { t, ctl } = await start({ site: { fail: 1 } });
  await ctl.pick('live/L');
  await until(() => ctl.st.descState === 'ready', 'described');
  ctl.setRange(1, 3);
  await ctl.setTimepoint(1);
  await until(() => ctl.st.descState === 'ready' && ctl.st.timepoint === 1, 're-described');
  deepEq([ctl.st.first, ctl.st.last], [1, 3], 'the same slices of the next timepoint');
  await ctl.pick('3d/A');
  await until(() => ctl.st.descState === 'ready', 'A');
  ctl.setMode('oblique');
  ctl.setSpec({ projection: 'single' });
  assert.equal(ctl.refs.bindings.thickness.range.disabled, true, 'no thickness for a single plane');
  ctl.setSpec({ projection: 'max', thickness: 4 });
  assert.equal(ctl.refs.bindings.thickness.range.disabled, false);
  assert.match(ctl.refs.bindings.thickness.readout.textContent, /4 samples/, 'a sample count, said so');
  assert.equal(await ctl.open(), true);
  assert.match(ctl.st.noteExtra, /could not be read and are left empty/);
  assert.match(ctl.text(), /left empty/);
  t.close();
});

console.log('test_ij_lib_panel: ' + passed + ' groups passed');
