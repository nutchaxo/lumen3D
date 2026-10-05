// BrickLoader concurrency across datasets and callers (current loader API):
//  - a dataset switch (init on another dataset root) cancels every running batch with
//    reason 'dataset-switch': the stale bricks are never delivered, every task of the
//    cancelled batch is listed in summary.skipped, and the new dataset fetches its own
//    packs under its own URLs (nothing of the old dataset can be read back);
//  - another quality / timepoint of the SAME dataset cancels nothing;
//  - a per-caller AbortSignal on _fetchPackBuffer rejects only that caller: the shared
//    pack download continues for the other caller (one network request);
//  - pack URLs carry the manifest's ?v= version stamp.
//
// Run: node tests/js/test_brick_loader_concurrency.mjs
import assert from 'node:assert/strict';
import { loadModule } from './harness.mjs';

const BS = 64;
const MOSAIC = 512;
const settle = (ms = 15) => new Promise((r) => setTimeout(r, ms));

// A "WebP" is the raw 512² gray mosaic (8×8 tiles of 64²); the fake decoder reads it back.
function mainThreadDecoder() {
  return {
    Blob: function (parts) { this.bytes = new Uint8Array(parts[0]); },
    createImageBitmap: async (blob) => ({ width: MOSAIC, height: MOSAIC, gray: blob.bytes, close() {} }),
    OffscreenCanvas: function (w, h) {
      this.width = w; this.height = h;
      let img = null;
      this.getContext = () => ({
        globalCompositeOperation: '',
        drawImage: (bmp) => { img = bmp; },
        getImageData: (x, y, ww, hh) => {
          const data = new Uint8ClampedArray(ww * hh * 4);
          for (let j = 0; j < hh; j++) for (let i = 0; i < ww; i++) data[(j * ww + i) * 4] = img.gray[(y + j) * MOSAIC + x + i];
          return { data };
        },
      });
    },
  };
}

// One pack per dataset: lod0/c0/pack_0.bin holds two bricks (x000, x001), the bytes
// of dataset `tag` filled with `fill` so a delivered brick tells where it came from.
function manifestFor(fill) {
  const brick = MOSAIC * MOSAIC;
  const pack = new Uint8Array(brick * 2).fill(fill);
  const brickToPack = {
    'lod0/c0/x000_y000_z000.webp': { url: 'lod0/c0/pack_0.bin', offset: 0, length: brick },
    'lod0/c0/x001_y000_z000.webp': { url: 'lod0/c0/pack_0.bin', offset: brick, length: brick },
  };
  return {
    pack,
    manifest: {
      levels: [{ level: 0, dimensions: { x: 2 * BS, y: BS, z: BS }, brickSize: BS, chunks: [{ id: '0_0_0' }, { id: '0_0_1' }] }],
      channels: 1,
      brickPacking: { mode: 'grid', cols: 8, rows: 8 },
      brickTransport: { encoding: 'webp-lossless', mode: 'packs', brickToPack, packHashes: { 'lod0/c0/pack_0.bin': `hash-${fill}` } },
    },
  };
}

// fetch answers at once; each body lands when the test says so.
function makeLoader(bodies) {
  const requests = [];
  const fetchImpl = async (url, init = {}) => {
    const full = String(url);
    const key = Object.keys(bodies).find((root) => full.startsWith(root));
    const req = { url: full, aborted: false };
    requests.push(req);
    let land;
    const gate = new Promise((resolve, reject) => {
      land = resolve;
      init.signal?.addEventListener('abort', () => { req.aborted = true; reject(new DOMException('Aborted', 'AbortError')); }, { once: true });
    });
    gate.catch(() => {});
    req.land = land;
    return { ok: true, status: 200, arrayBuffer: async () => { await gate; return bodies[key].slice().buffer; } };
  };
  const BL = loadModule('js/core/brick-loader.js', 'BrickLoader', {
    document: { createElement: () => ({ getContext: () => ({}) }) },
    navigator: { hardwareConcurrency: 1 },
    performance: { now: () => Date.now() },
    window: {},
    AbortController, DOMException, fetch: fetchImpl,
    ...mainThreadDecoder(),
  });
  BL.configure({ decodeWorkers: 0 });
  return { BL, requests };
}

const TASKS = [{ lod: 0, channel: 0, bx: 0, by: 0, bz: 0 }, { lod: 0, channel: 0, bx: 1, by: 0, bz: 0 }];

// ── A dataset switch cancels the old dataset's batches; nothing stale is delivered ──
{
  const A = manifestFor(11), B = manifestFor(22);
  const { BL, requests } = makeLoader({ 'DATA_WEB/3d/A/': A.pack, 'DATA_WEB/3d/B/': B.pack });
  BL.init('DATA_WEB/3d/A/bricks', A.manifest);
  const deliveredA = [];
  const batchA = BL.loadBrickTasks(TASKS, { streamOnly: true, onBrickLoaded: (r) => deliveredA.push(r) });
  await settle();
  assert.equal(requests.length, 1, 'one pack request for the two bricks of dataset A');
  assert.ok(/\?v=/.test(requests[0].url), 'pack URLs carry the manifest version stamp');

  BL.init('DATA_WEB/3d/B/bricks', B.manifest);      // another dataset: cancels A
  requests[0].land();                                // A's pack lands after the switch
  const resA = await batchA;
  await settle();
  assert.equal(resA.summary.cancelled, true, 'the old dataset batch is cancelled');
  assert.equal(resA.summary.reason, 'dataset-switch');
  assert.equal(resA.summary.skipped.length, 2, 'its undelivered tasks are listed as skipped');
  assert.equal(deliveredA.length, 0, 'a stale brick is never delivered');

  const deliveredB = [];
  const before = requests.length;
  const batchB = BL.loadBrickTasks(TASKS, { streamOnly: true, onBrickLoaded: (r) => deliveredB.push(r) });
  await settle();
  assert.equal(requests.length, before + 1, 'the new dataset fetches its own pack');
  const reqB = requests[requests.length - 1];
  assert.ok(reqB.url.startsWith('DATA_WEB/3d/B/bricks/'), 'under its own URL');
  reqB.land();
  const resB = await batchB;
  assert.equal(resB.summary.delivered, 2);
  assert.ok(deliveredB.every((r) => r.data[0] === 22), 'every delivered voxel is dataset B\'s');
}

// ── Another quality / timepoint of the same dataset cancels nothing ──────────────
{
  const T7 = manifestFor(7), T8 = manifestFor(8);
  const { BL, requests } = makeLoader({ 'DATA_WEB/live/L/bricks/t007': T7.pack, 'DATA_WEB/live/L/bricks/t008': T8.pack });
  BL.init('DATA_WEB/live/L/bricks/t007', T7.manifest);
  const rows7 = [];
  const batch7 = BL.loadBrickTasks(TASKS, { group: 'frame-7', streamOnly: true, onBrickLoaded: (r) => rows7.push(r) });
  await settle();
  BL.init('DATA_WEB/live/L/bricks/t008', T8.manifest);
  requests[0].land();
  const res7 = await batch7;
  assert.equal(res7.summary.cancelled, false, 'a timepoint switch keeps the running batch');
  assert.equal(res7.summary.delivered, 2);
  assert.ok(rows7.every((r) => r.data[0] === 7), 'the batch reads the mount it was started on');
}

// ── A caller's abort rejects only that caller; the shared download continues ──────
{
  const A = manifestFor(5);
  const { BL, requests } = makeLoader({ 'DATA_WEB/3d/A/': A.pack });
  BL.init('DATA_WEB/3d/A/bricks', A.manifest);
  const cA = new AbortController();
  const p1 = BL._fetchPackBuffer('lod0/c0/pack_0.bin', cA.signal);
  const p2 = BL._fetchPackBuffer('lod0/c0/pack_0.bin', new AbortController().signal);
  await settle();
  cA.abort();
  let p1err = null;
  await p1.then(() => {}, (e) => { p1err = e; });
  assert.ok(p1err && p1err.name === 'AbortError', 'aborting caller A rejects only A with AbortError');
  assert.equal(requests.length, 1, 'one network request shared by both callers');
  assert.equal(requests[0].aborted, false, 'the shared download is not aborted');
  requests[0].land();
  const buf = await p2;
  assert.ok(buf instanceof ArrayBuffer && buf.byteLength === A.pack.byteLength, 'the other caller still receives the pack');
}

console.log('brick-loader concurrency (dataset switch, same-dataset mounts, per-caller abort, ?v= stamp): OK');
