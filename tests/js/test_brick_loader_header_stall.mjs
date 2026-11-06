// A request whose server never sends the response headers is bounded by
// `fetchStallMs` like a body that stops mid-way:
//   • a whole-pack request that hangs before its headers frees its fetch slot (the
//     only one here), and the brick is retried on a fresh request that succeeds;
//   • a host's first Range request (the probe every other run of that host waits
//     behind) that hangs ends the probe: the waiting run goes out, the hung run is
//     retried, every brick is delivered;
//   • a pack that never answers fails its bricks (coded BRICKS_FETCH_STALL) instead
//     of holding the batch forever.
//
// Run: node tests/js/test_brick_loader_header_stall.mjs
import assert from 'node:assert/strict';
import { loadModule } from './harness.mjs';

const BS = 64;
const BRICK = BS * BS * BS;
const NX = 20;

// Two packs of NX raw-u8 bricks; brick (bx, by) is byte-filled with (bx + 10·by) & 0xFF.
function makeWorld() {
  const packs = {};
  const brickToPack = {};
  const chunks = [];
  for (let by = 0; by < 2; by++) {
    const url = `lod0/c0/pack_0${by}.bin`;
    packs[url] = new Uint8Array(NX * BRICK);
    for (let bx = 0; bx < NX; bx++) {
      packs[url].fill((bx + 10 * by) & 0xFF, bx * BRICK, (bx + 1) * BRICK);
      brickToPack[`lod0/c0/x${String(bx).padStart(3, '0')}_y${String(by).padStart(3, '0')}_z000.webp`] = { url, offset: bx * BRICK, length: BRICK };
      chunks.push({ id: `0_${by}_${bx}` });
    }
  }
  return { packs, brickToPack, chunks };
}

// `hang(req, n)` decides whether the n-th request (from 0) never answers; a hung
// request rejects only when its signal aborts, as a browser fetch does.
function makeLoader(world, hang) {
  const requests = [];
  const fetchImpl = (url, init = {}) => {
    const rel = String(url).split('/bricks/')[1].split('?')[0];
    const range = init.headers?.Range || null;
    const req = { rel, range, settled: false };
    const n = requests.length;
    requests.push(req);
    if (hang(req, n)) {
      return new Promise((resolve, reject) => {
        init.signal?.addEventListener('abort', () => { req.settled = true; reject(new DOMException('Aborted', 'AbortError')); }, { once: true });
      });
    }
    req.settled = true;
    const pack = world.packs[rel];
    if (range) {
      const [lo, hi] = range.slice(6).split('-').map(Number);
      return Promise.resolve({ ok: true, status: 206, headers: { get: () => null }, arrayBuffer: async () => pack.buffer.slice(lo, hi + 1) });
    }
    return Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, arrayBuffer: async () => pack.buffer.slice(0) });
  };
  const BL = loadModule('js/core/brick-loader.js', 'BrickLoader', {
    document: { createElement: () => ({ getContext: () => ({}) }) },
    navigator: { hardwareConcurrency: 2 },
    performance: { now: () => Date.now() },
    window: {},
    AbortController: globalThis.AbortController,
    DOMException: globalThis.DOMException,
    fetch: fetchImpl,
  });
  BL.init('DATA_WEB/3d/R/bricks', {
    levels: [{ level: 0, dimensions: { x: NX * BS, y: 2 * BS, z: BS }, brickSize: BS, chunks: world.chunks }],
    channels: 1,
    brickTransport: { encoding: 'raw-u8', mode: 'packs', packSize: NX, brickToPack: world.brickToPack },
  });
  // The smallest deadline the loader accepts.
  BL.configure({ fetchStallMs: 1000 });
  return { BL, requests };
}

const task = (bx, by) => ({ lod: 0, channel: 0, bx, by, bz: 0 });
async function run(BL, tasks, opts = {}) {
  const rows = [];
  const errors = [];
  const summary = (await BL.loadBrickTasks(tasks, { cacheResults: false, streamOnly: true, ...opts, onBrickLoaded: (r) => rows.push(r), onBrickError: (e) => errors.push(e) })).summary;
  return { rows, errors, summary };
}

// ── 1. A hung whole-pack request frees the only fetch slot and is retried ─────
{
  const world = makeWorld();
  const { BL, requests } = makeLoader(world, (req, n) => n === 0);
  BL.configure({ packFetchSlots: 1 });
  const t0 = Date.now();
  const { rows, errors } = await run(BL, [task(3, 0), task(5, 1)], { concurrency: 2 });
  assert.equal(errors.length, 0, 'no brick failed');
  assert.equal(rows.length, 2, 'both bricks delivered');
  for (const r of rows) assert.equal(r.data[0], (r.bx + 10 * r.by) & 0xFF, `brick (${r.bx},${r.by}) carries its own bytes`);
  assert.ok(requests[0].settled, 'the hung request was cancelled');
  assert.ok(requests.length >= 3, 'the hung pack was asked again');
  assert.ok(Date.now() - t0 < 10000, 'freed by the deadline, not by luck');
  console.log('hung whole-pack request -> slot freed, retried: OK');
}

// ── 2. A hung range probe releases the runs of its host waiting behind it ─────
{
  const world = makeWorld();
  const { BL, requests } = makeLoader(world, (req, n) => n === 0 && Boolean(req.range));
  const { rows, errors } = await run(BL, [task(2, 0), task(9, 0), task(7, 1)], { byteRanges: true, concurrency: 4 });
  assert.equal(errors.length, 0, 'no brick failed');
  assert.equal(rows.length, 3, 'every brick delivered');
  for (const r of rows) assert.equal(r.data[0], (r.bx + 10 * r.by) & 0xFF, `brick (${r.bx},${r.by}) carries its own bytes`);
  assert.ok(requests[0].range && requests[0].settled, 'the probe was a Range request, cancelled at the deadline');
  console.log('hung range probe -> host released, run retried: OK');
}

// ── 3. A pack that never answers fails its brick with a stall code ────────────
{
  const world = makeWorld();
  const { BL } = makeLoader(world, (req) => req.rel === 'lod0/c0/pack_00.bin');
  const { rows, errors, summary } = await run(BL, [task(4, 0), task(4, 1)], { concurrency: 2 });
  assert.equal(rows.length, 1, 'the brick of the answering pack is delivered');
  assert.equal(rows[0].by, 1);
  assert.equal(errors.length, 1, 'the brick of the silent pack is reported');
  assert.equal(errors[0].error?.code, 'BRICKS_FETCH_STALL', 'its failure says the server did not answer');
  assert.equal(summary.failed.length, 1);
  assert.equal(summary.cancelled, false, 'a stall is a failure, not a cancellation');
  console.log('silent pack -> BRICKS_FETCH_STALL: OK');
}

console.log('BrickLoader header deadline (slot freed · probe released · stall coded): OK');
