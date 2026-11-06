// A composed brick (every channel decoded into one buffer by ONE worker) picks its
// worker before its bytes land. The pick counts the units bound to a worker that have
// not posted anything yet, so the bricks a batch starts together go to different
// workers instead of all queueing on the first one:
//   • four 3-channel bricks started together on a pool of four: each worker
//     assembles exactly one brick, and a worker's first job is not behind another's;
//   • the reservations are released after the batch, after a cancellation, and after
//     a brick restarted on another worker because its worker was lost;
//   • compose `split: true` asks the worker for the RG / R planes of a split atlas and
//     delivers them as the row's `split` (no RGBA `data`); a worker answering another
//     layout fails the brick instead of uploading it.
//
// Run: node tests/js/test_brick_loader_worker_spread.mjs
import assert from 'node:assert/strict';
import { loadModule } from './harness.mjs';

const BS = 64;
const NX = 4;
const C = 3;
const DECODE_MS = 15;

// A Worker-shaped object that decodes nothing: it answers DECODE after DECODE_MS,
// one job at a time like a real worker, and TAKE with a buffer of the asked size.
const pool = [];
class FakeWorker {
  constructor() {
    this.index = pool.length;
    this.jobs = [];
    this.busyUntil = 0;
    this.dead = false;
    this.onmessage = null;
    this.onerror = null;
    pool.push(this);
  }
  postMessage(m) {
    if (this.dead || (m.type !== 'DECODE' && m.type !== 'TAKE')) return;
    this.jobs.push(m);
    if (this.crashOn && this.crashOn(m)) {
      this.dead = true;
      setTimeout(() => this.onerror?.({ message: 'simulated crash', preventDefault() {} }), 0);
      return;
    }
    const cost = m.type === 'DECODE' ? DECODE_MS : 1;
    const start = Math.max(Date.now(), this.busyUntil);
    this.busyUntil = start + cost;
    setTimeout(() => {
      if (this.dead) return;
      let data = {};
      if (m.type === 'TAKE' && m.split) {
        const n = this.badSplit ? m.voxels - 1 : m.voxels;
        data = { split: { planes: [new Uint8Array(n * 2).fill(1).buffer, new Uint8Array(n).fill(2).buffer] } };
      } else if (m.type === 'TAKE') {
        data = { buffer: new Uint8Array(m.voxels * m.components).buffer };
      }
      this.onmessage?.({ data: { type: 'DECODE_RESULT', id: m.id, ok: true, ...data } });
    }, this.busyUntil - Date.now());
  }
  terminate() { this.dead = true; }
}

function makeLoader({ fetchDelay = 5 } = {}) {
  pool.length = 0;
  const brickToPack = {};
  const chunks = [];
  for (let c = 0; c < C; c++) {
    for (let bx = 0; bx < NX; bx++) {
      brickToPack[`lod0/c${c}/x${String(bx).padStart(3, '0')}_y000_z000.webp`] = { url: `lod0/c${c}/pack_0.bin`, offset: bx * 100, length: 100 };
    }
  }
  for (let bx = 0; bx < NX; bx++) chunks.push({ id: `0_0_${bx}` });
  const fetchImpl = (url, init = {}) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve({
      ok: true, status: 200, headers: { get: () => null },
      arrayBuffer: async () => new Uint8Array(NX * 100).fill(7).buffer,
    }), fetchDelay);
    init.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')); }, { once: true });
  });
  const BL = loadModule('js/core/brick-loader.js', 'BrickLoader', {
    document: { createElement: () => ({ getContext: () => ({}) }) },
    navigator: { hardwareConcurrency: 8 },
    performance: { now: () => Date.now() },
    window: {},
    AbortController: globalThis.AbortController,
    DOMException: globalThis.DOMException,
    fetch: fetchImpl,
    Worker: FakeWorker,
  });
  BL.configure({ decodeWorkers: 4 });
  BL.init('DATA_WEB/3d/S/bricks', {
    levels: [{ level: 0, dimensions: { x: NX * BS, y: BS, z: BS }, brickSize: BS, chunks }],
    channels: C,
    brickPacking: { mode: 'grid', cols: 8, rows: 8 },
    brickTransport: { encoding: 'webp-lossless', mode: 'packs', brickToPack },
  });
  return BL;
}

const tasks = () => {
  const out = [];
  for (let bx = 0; bx < NX; bx++) for (let c = 0; c < C; c++) out.push({ lod: 0, channel: c, bx, by: 0, bz: 0 });
  return out;
};
const unitOf = (m) => (m.assemble ? m.assemble.key : m.key).split(':')[1];
const reservedTotal = (BL) => BL._workerLoads().reduce((s, w) => s + w.reserved, 0);

// ── 1. Bricks started together are assembled by different workers ────────────
{
  const BL = makeLoader();
  const rows = [];
  const errors = [];
  await BL.loadBrickTasks(tasks(), {
    streamOnly: true, concurrency: NX * C, compose: { channels: C },
    onBrickLoaded: (r) => rows.push(r), onBrickError: (e) => errors.push(e),
  });
  assert.equal(errors.length, 0, 'no brick failed');
  assert.equal(rows.length, NX, 'every brick delivered');
  assert.equal(pool.length, 4, 'a pool of four workers');
  const unitsPerWorker = pool.map((w) => new Set(w.jobs.map(unitOf)).size);
  assert.deepEqual(unitsPerWorker, [1, 1, 1, 1], `each worker assembled one brick (got ${unitsPerWorker.join('/')})`);
  for (const w of pool) {
    assert.equal(w.jobs.filter((m) => m.type === 'DECODE').length, C, `worker ${w.index} decoded the ${C} channels of its brick`);
  }
  assert.equal(reservedTotal(BL), 0, 'no reservation left after the batch');
  console.log('compose units spread over the pool: OK');
}

// ── 2. A cancelled batch releases its reservations ────────────────────────────
{
  const BL = makeLoader({ fetchDelay: 200 });
  const done = BL.loadBrickTasks(tasks(), { group: 'g', streamOnly: true, concurrency: NX * C, compose: { channels: C } });
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(reservedTotal(BL) > 0, 'units waiting for their bytes hold their workers');
  BL.cancelGroup('g');
  const result = await done;
  assert.equal(result.summary.cancelled, true, 'the batch reports its cancellation');
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(reservedTotal(BL), 0, 'no reservation left after a cancellation');
  console.log('reservations released on cancel: OK');
}

// ── 3. A brick whose worker is lost restarts elsewhere, reservations balanced ─
{
  const BL = makeLoader();
  // Prime the pool, then make worker 0 crash on the first DECODE it gets.
  await BL.loadBrickTasks(tasks(), { streamOnly: true, concurrency: NX * C, compose: { channels: C } });
  pool[0].crashOn = (m) => m.type === 'DECODE';
  const rows = [];
  const errors = [];
  await BL.loadBrickTasks(tasks(), {
    streamOnly: true, concurrency: NX * C, compose: { channels: C },
    onBrickLoaded: (r) => rows.push(r), onBrickError: (e) => errors.push(e),
  });
  assert.equal(errors.length, 0, 'the brick of the lost worker was restarted, not dropped');
  assert.equal(rows.length, NX, 'every brick delivered');
  assert.equal(reservedTotal(BL), 0, 'no reservation left after a restart');
  for (const w of BL._workerLoads()) assert.ok(w.reserved >= 0 && w.inflight >= 0, 'no negative count');
  console.log('restart after a lost worker keeps reservations balanced: OK');
}

// ── 4. Split rows: the planes come from the worker, checked against the box ───
{
  const BL = makeLoader();
  const rows = [];
  const errors = [];
  await BL.loadBrickTasks(tasks(), {
    streamOnly: true, concurrency: NX * C, compose: { channels: C, components: 4, split: true, cropToVolume: true },
    onBrickLoaded: (r) => rows.push(r), onBrickError: (e) => errors.push(e),
  });
  assert.equal(errors.length, 0, 'no brick failed');
  assert.equal(rows.length, NX, 'every brick delivered');
  const takes = pool.flatMap((w) => w.jobs.filter((m) => m.type === 'TAKE'));
  assert.ok(takes.length === NX && takes.every((m) => m.split === true && !m.encode), `every TAKE asks for the split planes (${JSON.stringify(takes.map((m) => ({ split: m.split, encode: m.encode, components: m.components })))})`);
  for (const r of rows) {
    assert.equal(r.data, null, 'no RGBA buffer');
    const v = r.region ? (r.region.x1 - r.region.x0) * (r.region.y1 - r.region.y0) * (r.region.z1 - r.region.z0) : BS ** 3;
    assert.equal(r.split.planes.length, 2);
    assert.equal(r.split.planes[0].length, v * 2, 'RG plane of the box');
    assert.equal(r.split.planes[1].length, v, 'R plane of the box');
  }

  for (const w of pool) w.badSplit = true;
  const bad = [];
  const badRows = [];
  await BL.loadBrickTasks(tasks(), {
    streamOnly: true, concurrency: NX * C, compose: { channels: C, components: 4, split: true, cropToVolume: true },
    onBrickLoaded: (r) => badRows.push(r), onBrickError: (e) => bad.push(e),
  });
  assert.equal(badRows.length, 0, 'planes of the wrong size are never delivered');
  assert.equal(bad.length, NX * C, 'every channel of every brick is reported');

  // Two components: nothing to split, the RGBA path stays.
  for (const w of pool) w.badSplit = false;
  const plainRows = [];
  await BL.loadBrickTasks(tasks().filter((t) => t.channel < 2), {
    streamOnly: true, concurrency: NX * 2, compose: { channels: 2, components: 2, split: true },
    onBrickLoaded: (r) => plainRows.push(r),
  });
  assert.equal(plainRows.length, NX);
  assert.ok(plainRows.every((r) => r.data && !r.split), 'two components keep their interleaved buffer');
  console.log('compose split rows: OK');
}

console.log('BrickLoader compose worker spread: OK');
