// The "Stack" choice of the entry flow of the Advanced view (Studio figure → Z Project dialog → "Stack (no projection)"): the slices of the
// figure's range open as the slices of a real z-stack, from the dataset's original TIFF (doc.tiff.stack) or the processed volume
// (doc.stack.*), channels as channels, the z step as pixelDepth; refused by the dialog's own check when the stack does not fit the memory.
// Through tests/js/ij_harness.mjs (the real controller, worker and engine).   (The projections: test_ij_lib_entry.mjs.)
//
// Run: node tests/js/test_ij_stk_lib_entry.mjs
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
  const t = await boot({ channels: 2, localStore: opt.localStore, storage: opt.storage, brokenPackages: opt.brokenPackages || [] });
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


await test('the dialog offers Stack beside the projections; a Stack answer is not remembered as the last projection', async () => {
  const { t } = await start();
  t.settings.set('lib.method', 'median');
  let spec = null;
  t.script.dialogs.push((s) => { spec = s; return { source: 'processed', method: 'stack', start: 1, stop: D, level: 0 }; });
  mountApp(t);
  await until(() => spec, 'the Z Project dialog');
  const method = spec.fields.find((f) => f.id === 'method');
  assert.equal(method.options[method.options.length - 1].value, 'stack');
  assert.equal(method.value, 'median');
  await until(() => t.shells.length && t.shell.images.filter(Boolean).some((i) => i.docId !== -1 && i.name), 'image');
  assert.equal(t.settings.get('lib.method'), 'median', 'the last projection stays the default');
  t.close();
});

await test('Stack from the original TIFF: the TIFF planes of the figure\'s slices, 16-bit, channels as channels, the z step, one key', async () => {
  const { t, tiff, routes } = await start();
  await t.open({ source: 'tiff', method: 'stack', start: 2, stop: 4 });
  const docs = await t.docs();
  assert.equal(docs.length, 1);
  const d = docs[0];
  deepEq([d.nZ, d.nT, d.bitDepth, d.hyperstack, d.channels.length, d.nSlices], [3, 1, 16, true, 2, 6]);
  assert.match(d.name, /^HARNESS Z 1–3$/);
  for (let z = 0; z < 3; z++) for (let c = 0; c < 2; c++) {
    const want = new Uint16Array(W * H); for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) want[y * W + x] = tiff.pixel((z + 1) * 2 + c, x, y, 0);
    sameArray((await t.engine('doc.tile', { docId: d.docId, channel: c, level: 0, tx: 0, ty: 0, pos: { z } })).data, want, `channel ${c} slice ${z + 1}`);
  }
  deepEq(d.channels.map((c) => [c.name, c.color]), [['DAPI', '#4488ff'], ['GFP', '#44ff44']]);
  deepEq([d.calibration.pixelWidth, d.calibration.unit, d.calibration.pixelDepth], [0.5, 'µm', 2]);
  assert.equal(d.provenance.method, 'stack');
  assert.match(d.provenance.sessionKey, /^3d\/HARNESS\|tree1\|\|z\|0-4\|tiff\|HARNESS\.tif\|stack\|2-4\|[0-9a-z]+$/);
  assert.equal(t.settings.get('lib.source'), 'tiff');
  assert.ok(routes.get(tiff.index.url).log.requests <= 2, 'range requests, not one per plane: ' + routes.get(tiff.index.url).log.requests);
  t.close();
});

await test('Stack from the processed volume: every plane of the range, 8-bit, channels kept, equal to the volume', async () => {
  const { t } = await start();
  await t.open({ source: 'processed', method: 'stack', start: 2, stop: 5, level: 0 });
  const [d] = await t.docs();
  deepEq([d.nZ, d.nT, d.bitDepth, d.hyperstack, d.channels.length], [4, 1, 8, true, 2]);
  assert.match(d.name, /^HARNESS Z 1–4$/);
  assert.equal(d.calibration.pixelDepth, 2);
  for (let z = 0; z < 4; z++) for (let c = 0; c < 2; c++) {
    const want = new Uint8Array(W * H); for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) want[y * W + x] = t.vol.value(c, z + 1, y, x);
    sameArray((await t.engine('doc.tile', { docId: d.docId, channel: c, level: 0, tx: 0, ty: 0, pos: { z } })).data, want, `channel ${c} slice ${z + 1}`);
  }
  assert.match(d.provenance.sessionKey, /^3d\/HARNESS\|tree1\|\|z\|0-4\|0\|stack\|2-5\|[0-9a-z]+$/);
  t.close();
});

await test('a Stack that does not fit the memory is refused by the dialog own check, a projection of the same range is not', async () => {
  // 12000 × 9000 × 2 channels × 5 planes × 2 bytes = 2.2 GB: more than the 1 GiB default budget, a 16-bit max (one plane per channel) fits
  const big = TIFF();
  big.index.width = 12000; big.index.height = 9000; big.index.rowsPerStrip = 9000; big.index.strips.perPage = 1; big.index.resolution = { x: 600, y: 600, unit: 1 };
  const offs = new Float64Array(10), cnts = new Uint32Array(10);
  for (let i = 0; i < 10; i++) { offs[i] = 8 + i * 100; cnts[i] = 10; }
  big.index.strips.offsets = Buffer.from(new Uint8Array(offs.buffer)).toString('base64');
  big.index.strips.byteCounts = Buffer.from(new Uint8Array(cnts.buffer)).toString('base64');
  const { t, routes } = await start({ tiff: big });
  let spec = null;
  t.script.dialogs.push((s) => { spec = s; return { source: 'processed', method: 'max', start: 1, stop: D, level: 0 }; });
  mountApp(t);
  await until(() => spec, 'dialog');
  const base = { start: 1, stop: D, level: 0 };
  assert.equal(spec.validate({ ...base, source: 'tiff', method: 'max' }), null);
  deepEq(spec.validate({ ...base, source: 'tiff', method: 'stack' }), { method: 'proj.stackTooLarge' });
  assert.equal(spec.validate({ ...base, source: 'processed', method: 'stack' }), null, 'the small processed volume fits as a stack');
  assert.equal(spec.validate({ start: 2, stop: 2, source: 'tiff', method: 'stack', level: 0 }), null, 'one plane of the TIFF fits');
  assert.equal(routes.get(big.index.url).log.requests, 0, 'nothing was requested');
  await until(() => t.shells.length && t.shell.images.filter(Boolean).some((i) => i.docId !== -1 && i.name), 'image');
  t.close();
});

console.log(`ok test_ij_stk_lib_entry (${passed} groups)`);
