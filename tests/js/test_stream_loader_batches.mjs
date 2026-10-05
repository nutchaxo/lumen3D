// BrickLoader batches, sources and decode pool (the streaming core):
//   • a brick that cannot be decoded is reported (onBrickError + summary.failed),
//     never delivered as its compressed bytes; same without any decode worker;
//   • a batch started with cancelPrevious:false is independent: a later stream batch
//     does not cancel it; stream batches supersede each other; an external
//     AbortSignal cancels its batch alone; every undelivered task is in the summary;
//   • a source no live task needs is aborted in flight; one shared with another
//     batch keeps downloading; landed packs are released when their bricks are cut;
//   • pack-major order starts at the caller's first brick and expands outward by pack;
//   • a decode worker that dies is replaced and its jobs retried;
//   • compose: one RGBA row per brick, channels interleaved + LUT in the worker,
//     an edge brick cut to the volume;
//   • a host that ignores Range costs one whole-pack download per pack;
//   • pack URLs carry a version stamp derived from the manifest.
//
// Run: node tests/js/test_stream_loader_batches.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { loadModule, ROOT } from './harness.mjs';

const BS = 64;
const MOSAIC = 512;
const WORKER_SRC = readFileSync(path.join(ROOT, 'js/core/brick-decode-worker.js'), 'utf8');
const settle = (ms = 15) => new Promise((r) => setTimeout(r, ms));
const voxel = (c, x, y, z) => (c * 50 + x + 3 * y + 7 * z) & 0xFF;

// A "WebP" here is the raw 512² gray mosaic (8×8 tiles of 64², tile z at (z%8, z/8)):
// the fake createImageBitmap reads it back, a buffer of any other size is "corrupt".
function mosaicFor(c, bx, by, bz) {
  const m = new Uint8Array(MOSAIC * MOSAIC);
  for (let z = 0; z < BS; z++) {
    const tx = (z % 8) * BS, ty = Math.floor(z / 8) * BS;
    for (let y = 0; y < BS; y++) for (let x = 0; x < BS; x++) m[(ty + y) * MOSAIC + tx + x] = voxel(c + bx + by + bz, x, y, z);
  }
  return m;
}

function workerGlobals() {
  return {
    Blob: function (parts) { this.bytes = new Uint8Array(parts[0]); },
    createImageBitmap: async (blob) => {
      if (blob.bytes.length !== MOSAIC * MOSAIC) throw new Error('corrupt webp');
      return { width: MOSAIC, height: MOSAIC, gray: blob.bytes, close() {} };
    },
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

// The real worker script, run in its own realm behind a Worker-shaped object.
const workerLog = { spawned: 0, killNext: false };
class FakeWorker {
  constructor() {
    workerLog.spawned++;
    this.onmessage = null; this.onerror = null; this.dead = false;
    const self = { postMessage: (m) => { if (!this.dead) setTimeout(() => this.onmessage?.({ data: m }), 0); } };
    this.ctx = vm.createContext({ self, console, performance: { now: () => 0 }, ...workerGlobals() });
    vm.runInContext(WORKER_SRC, this.ctx);
    this.self = self;
  }
  postMessage(m) {
    if (this.dead) return;
    if (workerLog.killNext && m.type === 'DECODE') {
      workerLog.killNext = false;
      this.dead = true;
      setTimeout(() => this.onerror?.({ message: 'simulated crash', preventDefault() {} }), 0);
      return;
    }
    setTimeout(() => this.self.onmessage({ data: m }), 0);
  }
  terminate() { this.dead = true; }
}

// One channel per pack row: pack lod0/c<c>/pack_<by>.bin holds the NX bricks of row
// `by`, end to end. `corrupt` lists "c/bx/by" bricks stored as 10 junk bytes.
function makeWorld({ NX = 4, NY = 2, C = 1, corrupt = [] } = {}) {
  const packs = {}, brickToPack = {}, chunks = [], packHashes = {};
  for (let c = 0; c < C; c++) for (let by = 0; by < NY; by++) {
    const url = `lod0/c${c}/pack_${by}.bin`;
    const parts = [];
    let off = 0;
    for (let bx = 0; bx < NX; bx++) {
      const bytes = corrupt.includes(`${c}/${bx}/${by}`) ? new Uint8Array(10).fill(9) : mosaicFor(c, bx, by, 0);
      brickToPack[`lod0/c${c}/x${String(bx).padStart(3, '0')}_y${String(by).padStart(3, '0')}_z000.webp`] = { url, offset: off, length: bytes.length };
      parts.push(bytes); off += bytes.length;
    }
    const pack = new Uint8Array(off);
    let at = 0; for (const p of parts) { pack.set(p, at); at += p.length; }
    packs[url] = pack;
    packHashes[url] = `h${c}${by}`;
  }
  for (let by = 0; by < NY; by++) for (let bx = 0; bx < NX; bx++) chunks.push({ id: `0_${by}_${bx}` });
  return { packs, brickToPack, chunks, packHashes, NX, NY, C };
}

// fetch: answers at once; the body lands after `delay` ms, or when `gate` says so.
function makeLoader(world, { workers = true, rangeStatus = 206, gated = false, dims = null } = {}) {
  const requests = [];
  const fetchImpl = async (url, init = {}) => {
    const full = String(url);
    const rel = full.split('/bricks/')[1].split('?')[0];
    const pack = world.packs[rel];
    if (!pack) return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
    const range = init.headers?.Range || null;
    const req = { url: full, rel, range, aborted: false, landed: false };
    requests.push(req);
    let land;
    const gate = new Promise((resolve, reject) => {
      land = resolve;
      init.signal?.addEventListener('abort', () => { req.aborted = true; reject(new DOMException('Aborted', 'AbortError')); }, { once: true });
    });
    gate.catch(() => {});
    req.land = () => { req.landed = true; land(); };
    if (!gated) setTimeout(req.land, 1);
    let body = pack, status = 200;
    if (range && rangeStatus === 206) {
      const [lo, hi] = range.slice(6).split('-').map(Number);
      body = pack.subarray(lo, hi + 1); status = 206;
    } else if (range && rangeStatus !== 200) {
      return { ok: false, status: rangeStatus, arrayBuffer: async () => new ArrayBuffer(0) };
    }
    return { ok: true, status, arrayBuffer: async () => { await gate; return body.slice().buffer; } };
  };
  const sandbox = {
    document: { createElement: () => ({ getContext: () => ({}) }) },
    navigator: { hardwareConcurrency: 3 },
    performance: { now: () => Date.now() },
    window: {},
    AbortController, DOMException, fetch: fetchImpl,
    ...workerGlobals(),
  };
  if (workers) sandbox.Worker = FakeWorker;
  const BL = loadModule('js/core/brick-loader.js', 'BrickLoader', sandbox);
  BL.configure({ decodeWorkers: 2 });
  BL.init('DATA_WEB/3d/W/bricks', {
    levels: [{ level: 0, dimensions: dims || { x: world.NX * BS, y: world.NY * BS, z: BS }, brickSize: BS, chunks: world.chunks }],
    channels: world.C,
    brickPacking: { mode: 'grid', cols: 8, rows: 8 },
    brickTransport: { encoding: 'webp-lossless', mode: 'packs', brickToPack: world.brickToPack, packHashes: world.packHashes },
  });
  return { BL, requests };
}

const tasksOf = (world, channels = [0]) => {
  const out = [];
  for (let by = 0; by < world.NY; by++) for (let bx = 0; bx < world.NX; bx++) for (const c of channels) out.push({ lod: 0, channel: c, bx, by, bz: 0 });
  return out;
};
const checkBrick = (row, c) => {
  assert.equal(row.data.length, BS * BS * BS, 'whole brick');
  for (const [x, y, z] of [[0, 0, 0], [5, 7, 9], [63, 63, 63]]) {
    assert.equal(row.data[(z * BS + y) * BS + x], voxel(c + row.bx + row.by + row.bz, x, y, z), `voxel ${x},${y},${z} of brick ${row.bx},${row.by}`);
  }
};

// ── 1. A corrupt brick is reported, never delivered as compressed bytes ─────────
for (const workers of [true, false]) {
  const world = makeWorld({ corrupt: ['0/2/1'] });
  const { BL } = makeLoader(world, { workers });
  const rows = [], errors = [];
  const res = await BL.loadBrickTasks(tasksOf(world), { streamOnly: true, onBrickLoaded: (r) => rows.push(r), onBrickError: (e) => errors.push(e) });
  assert.equal(rows.length, 7, `seven good bricks delivered (${workers ? 'worker' : 'main thread'})`);
  rows.forEach((r) => checkBrick(r, 0));
  assert.ok(!rows.some((r) => r.bx === 2 && r.by === 1), 'the corrupt brick is not delivered');
  assert.equal(errors.length, 1, 'and is reported once');
  assert.equal(res.summary.failed.length, 1);
  assert.equal(res.summary.delivered, 7);
  assert.equal(res.summary.skipped.length, 0);
}
console.log('corrupt brick reported, never delivered: OK');

// ── 2. Batch isolation ───────────────────────────────────────────────────────────
{
  const world = makeWorld({ NX: 4, NY: 2 });
  const { BL, requests } = makeLoader(world, { gated: true });
  const studioRows = [], streamRows = [];
  const studio = BL.loadBrickTasks(tasksOf(world).filter((t) => t.by === 0), { cancelPrevious: false, streamOnly: true, onBrickLoaded: (r) => studioRows.push(r) });
  const stream1 = BL.loadBrickTasks(tasksOf(world).filter((t) => t.by === 1), { streamOnly: true, onBrickLoaded: (r) => streamRows.push(r) });
  await settle();
  const stream2 = BL.loadBrickTasks(tasksOf(world).filter((t) => t.by === 1), { streamOnly: true, onBrickLoaded: (r) => streamRows.push(r) });
  await settle();
  const s1 = await stream1;
  assert.equal(s1.summary.cancelled, true, 'a stream batch supersedes the previous stream batch');
  assert.equal(s1.summary.reason, 'superseded');
  assert.equal(s1.summary.skipped.length + s1.summary.delivered + s1.summary.failed.length, 4, 'every task accounted for');
  assert.equal(s1.summary.skipped.length, 4, 'the superseded batch lists its undelivered tasks');
  requests.forEach((r) => !r.aborted && r.land());
  const st = await studio;
  const s2 = await stream2;
  assert.equal(st.summary.cancelled, false, 'the independent batch was not cancelled');
  assert.equal(studioRows.length, 4, 'and delivered every brick');
  assert.equal(s2.summary.delivered, 4);
  assert.equal(requests.filter((r) => r.rel.endsWith('pack_1.bin') && !r.aborted).length, 1, 'the shared pack was fetched once and kept for the new batch');

  // External signal cancels its own batch only.
  const ctl = new AbortController();
  const other = BL.loadBrickTasks(tasksOf(world).filter((t) => t.by === 0), { group: 'g2', streamOnly: true });
  const mine = BL.loadBrickTasks(tasksOf(world).filter((t) => t.by === 1), { cancelPrevious: false, signal: ctl.signal, streamOnly: true });
  ctl.abort();
  await settle();
  requests.forEach((r) => !r.aborted && !r.landed && r.land());
  const m = await mine, o = await other;
  assert.equal(m.summary.cancelled, true);
  assert.equal(m.summary.reason, 'signal');
  assert.equal(o.summary.cancelled, false, 'the other batch is untouched');
  assert.equal(o.summary.delivered, 4);
  console.log('batch isolation: OK');
}

// ── 3. Refcounted sources: abort what nobody needs, release what was cut ─────────
{
  const world = makeWorld({ NX: 4, NY: 3 });
  const { BL, requests } = makeLoader(world, { gated: true });
  const a = BL.loadBrickTasks(tasksOf(world).filter((t) => t.by !== 2), { group: 'a', streamOnly: true });
  const b = BL.loadBrickTasks(tasksOf(world).filter((t) => t.by === 1), { group: 'b', streamOnly: true });
  await settle();
  BL.cancelGroup('a');
  await settle();
  const r0 = requests.find((r) => r.rel.endsWith('pack_0.bin'));
  const r1 = requests.find((r) => r.rel.endsWith('pack_1.bin'));
  assert.equal(r0.aborted, true, 'the pack only the cancelled batch needed is aborted in flight');
  assert.equal(r1.aborted, false, 'the pack the other batch still needs keeps downloading');
  r1.land();
  const rb = await b;
  await a;
  assert.equal(rb.summary.delivered, 4);
  const stats = BL.getCacheStats();
  assert.equal(stats.packBytes, 0, 'landed packs are released once their bricks are cut');
  assert.equal(stats.pendingSources, 0, 'nothing left in flight');
  console.log('refcounted sources: OK');
}

// ── 4. Byte budget during a batch ───────────────────────────────────────────────
{
  const world = makeWorld({ NX: 4, NY: 6 });
  const { BL } = makeLoader(world);
  BL.configure({ packCacheBytes: 8 * 1024 * 1024, lookaheadBytes: 0 });
  let peak = 0;
  const res = await BL.loadBrickTasks(tasksOf(world), { streamOnly: true, concurrency: 2, onBrickLoaded: () => { peak = Math.max(peak, BL.getCacheStats().packBytes); } });
  assert.equal(res.summary.delivered, 24);
  assert.ok(peak <= 2 * 4 * MOSAIC * MOSAIC, `at most two packs held at once (peak ${peak})`);
  assert.equal(BL.getCacheStats().refetches, 0, 'pack-major order: no pack fetched twice');
  console.log('byte budget: OK');
}

// ── 5. Pack-major order ──────────────────────────────────────────────────────────
{
  const world = makeWorld({ NX: 4, NY: 3 });
  const { BL } = makeLoader(world);
  // A centre-first caller order alternating between rows 1, 0, 2.
  const order = [[1, 1], [2, 0], [0, 1], [1, 2], [3, 0], [3, 1]].map(([bx, by]) => ({ lod: 0, channel: 0, bx, by, bz: 0 }));
  const rows = [];
  await BL.loadBrickTasks(order, { streamOnly: true, concurrency: 1, onBrickLoaded: (r) => rows.push(`${r.bx},${r.by}`) });
  assert.deepEqual(rows, ['0,1', '1,1', '3,1', '2,0', '3,0', '1,2'],
    "grouped by pack, starting at the first brick's pack and expanding outward (row 0 is nearer in raster order than row 2 on a tie)");
  const strict = [];
  await BL.loadBrickTasks(order, { streamOnly: true, concurrency: 1, strictOrder: true, onBrickLoaded: (r) => strict.push(`${r.bx},${r.by}`) });
  assert.deepEqual(strict, order.map((t) => `${t.bx},${t.by}`), 'strictOrder keeps the literal order');
  console.log('pack-major order: OK');
}

// ── 6. A dead decode worker is replaced, its jobs retried ───────────────────────
{
  const world = makeWorld();
  const { BL } = makeLoader(world);
  const before = workerLog.spawned;
  workerLog.killNext = true;
  const rows = [], errors = [];
  const res = await BL.loadBrickTasks(tasksOf(world), { streamOnly: true, onBrickLoaded: (r) => rows.push(r), onBrickError: (e) => errors.push(e) });
  assert.equal(rows.length, 8, 'every brick delivered after the crash');
  rows.forEach((r) => checkBrick(r, 0));
  assert.equal(errors.length, 0);
  assert.equal(res.summary.delivered, 8);
  assert.ok(workerLog.spawned > before, 'the crashed worker was replaced');
  console.log('worker crash recovery: OK');
}

// ── 7. Compose: RGBA per brick, LUT in the worker, edge brick cut to the volume ──
{
  const world = makeWorld({ NX: 2, NY: 1, C: 3 });
  const dims = { x: BS + 20, y: BS, z: 40 };   // brick 1 is 20 voxels wide, every brick 40 deep
  const { BL } = makeLoader(world, { dims });
  const lut1 = new Uint8Array(256).map((_, v) => 255 - v);
  const rows = [];
  const res = await BL.loadBrickTasks(tasksOf(world, [0, 1, 2]), {
    streamOnly: true, compose: { channels: 3, luts: [null, lut1, null], cropToVolume: true },
    onBrickLoaded: (r) => rows.push(r),
  });
  assert.equal(rows.length, 2, 'one row per brick');
  assert.equal(res.summary.delivered, 6, 'all six channel tasks delivered');
  for (const r of rows) {
    assert.equal(r.composed, true);
    const w = r.bx === 0 ? BS : 20;
    assert.equal(r.data.length, w * BS * 40 * 4, `brick ${r.bx} cut to ${w}x64x40 RGBA`);
    for (const [x, y, z] of [[0, 0, 0], [w - 1, 63, 39], [7, 3, 11]]) {
      const i = ((z * BS + y) * w + x) * 4;
      assert.equal(r.data[i], voxel(0 + r.bx, x, y, z), 'channel 0 in byte 0');
      assert.equal(r.data[i + 1], 255 - voxel(1 + r.bx, x, y, z), 'channel 1 in byte 1, LUT applied');
      assert.equal(r.data[i + 2], voxel(2 + r.bx, x, y, z), 'channel 2 in byte 2');
      assert.equal(r.data[i + 3], 0, 'no channel 3');
    }
  }
  console.log('composed bricks: OK');
}

// ── 7b. Compose survives a worker lost mid-brick; a failed channel stays zero and is reported ──
{
  const world = makeWorld({ NX: 2, NY: 1, C: 2, corrupt: ['1/1/0'] });
  const { BL } = makeLoader(world);
  workerLog.killNext = true;
  const rows = [], errors = [];
  const res = await BL.loadBrickTasks(tasksOf(world, [0, 1]), {
    streamOnly: true, compose: { channels: 2 }, onBrickLoaded: (r) => rows.push(r), onBrickError: (e) => errors.push(e),
  });
  assert.equal(rows.length, 2, 'both bricks delivered');
  for (const r of rows) {
    for (const [x, y, z] of [[0, 0, 0], [63, 63, 63], [9, 4, 33]]) {
      const i = ((z * BS + y) * BS + x) * 4;
      assert.equal(r.data[i], voxel(r.bx, x, y, z), 'channel 0 intact after the restart');
      assert.equal(r.data[i + 1], r.bx === 1 ? 0 : voxel(1 + r.bx, x, y, z), 'failed channel left at zero');
    }
  }
  const b1 = rows.find((r) => r.bx === 1);
  assert.deepEqual(Array.from(b1.failedChannels), [1], 'the row names the failed channel');
  assert.equal(errors.length, 1);
  assert.equal(res.summary.failed.length, 1);
  console.log('compose recovery: OK');
}

// ── 8. A host ignoring Range: one whole download per pack, then no more ranges ───
{
  const world = makeWorld({ NX: 8, NY: 2 });
  const { BL, requests } = makeLoader(world, { rangeStatus: 200 });
  const sparse = [0, 3, 6].flatMap((bx) => [0, 1].map((by) => ({ lod: 0, channel: 0, bx, by, bz: 0 })));
  const res = await BL.loadBrickTasks(sparse, { streamOnly: true, byteRanges: true, concurrency: 6 });
  assert.equal(res.summary.delivered, 6);
  for (const pack of ['pack_0.bin', 'pack_1.bin']) {
    assert.equal(requests.filter((r) => r.rel.endsWith(pack)).length, 1, `${pack} downloaded once`);
  }
  console.log('Range-less host: OK');
}

// ── 9. Pack URLs are versioned by the manifest ───────────────────────────────────
{
  const world = makeWorld();
  const { BL, requests } = makeLoader(world);
  await BL.loadBrickTasks(tasksOf(world).slice(0, 1), { streamOnly: true });
  const first = requests[0].url;
  assert.match(first, /pack_0\.bin\?v=[0-9a-z]+$/, 'pack URL carries ?v=<stamp>');
  const world2 = makeWorld();
  world2.packHashes['lod0/c0/pack_0.bin'] = 'changed';
  const { BL: BL2, requests: req2 } = makeLoader(world2);
  await BL2.loadBrickTasks(tasksOf(world2).slice(0, 1), { streamOnly: true });
  assert.notEqual(req2[0].url, first, 'a re-processed dataset gets another stamp');
  console.log('versioned pack URLs: OK');
}

console.log('stream loader batches: OK');
