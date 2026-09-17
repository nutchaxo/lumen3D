// A batch that needs only part of some packs (a cut through the volume) fetches the
// byte runs of its bricks with Range requests instead of whole packs
// (loadBrickTasks `byteRanges`):
//   • runs are the bricks' intervals merged across small gaps; a pack whose runs still
//     cover most of it, or need too many requests, is fetched whole;
//   • one request per run, shared by every brick in it, its bytes sliced per brick;
//   • a server answering 200 to a Range request has sent the whole pack, kept as such;
//     any other answer drops the plan for that pack and fetches it whole;
//   • without `byteRanges` nothing changes (the viewer's whole-level streams);
//   • taskBytes / estimateTaskBytes read the compressed sizes from the pack index.
//
// Run: node tests/js/test_brick_loader_ranges.mjs
import assert from 'node:assert/strict';
import { loadModule } from './harness.mjs';

const BS = 64;
// Objects built inside the module's vm realm carry that realm's prototypes: compare as plain data.
const plain = (o) => JSON.parse(JSON.stringify(o));
const BRICK = BS * BS * BS;
const NX = 20;

// Two packs of NX bricks each (a row per pack), raw-u8 bricks of BRICK bytes, laid
// end to end; brick (bx, by) is byte-filled with (bx + 10 * by) & 0xFF.
function makeWorld() {
  const packs = { 'lod0/c0/pack_00.bin': new Uint8Array(NX * BRICK), 'lod0/c0/pack_01.bin': new Uint8Array(NX * BRICK) };
  const brickToPack = {};
  const chunks = [];
  for (let by = 0; by < 2; by++) {
    const url = `lod0/c0/pack_0${by}.bin`;
    for (let bx = 0; bx < NX; bx++) {
      packs[url].fill((bx + 10 * by) & 0xFF, bx * BRICK, (bx + 1) * BRICK);
      brickToPack[`lod0/c0/x${String(bx).padStart(3, '0')}_y${String(by).padStart(3, '0')}_z000.webp`] = { url, offset: bx * BRICK, length: BRICK };
      chunks.push({ id: `0_${by}_${bx}` });
    }
  }
  return { packs, brickToPack, chunks };
}

function makeLoader(world, { rangeStatus = 206 } = {}) {
  const requests = [];
  const fetchImpl = async (url, init = {}) => {
    const rel = String(url).split('/bricks/')[1];
    const pack = world.packs[rel];
    if (!pack) return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
    const range = init.headers?.Range || null;
    requests.push({ rel, range });
    if (range) {
      if (rangeStatus === 206) {
        const [lo, hi] = range.slice(6).split('-').map(Number);
        return { ok: true, status: 206, arrayBuffer: async () => pack.buffer.slice(lo, hi + 1) };
      }
      if (rangeStatus === 200) return { ok: true, status: 200, arrayBuffer: async () => pack.buffer.slice(0) };
      return { ok: false, status: rangeStatus, arrayBuffer: async () => new ArrayBuffer(0) };
    }
    return { ok: true, status: 200, arrayBuffer: async () => pack.buffer.slice(0) };
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
  return { BL, requests };
}

const task = (bx, by) => ({ lod: 0, channel: 0, bx, by, bz: 0 });
const rowsOf = async (BL, tasks, opts) => {
  const rows = [];
  await BL.loadBrickTasks(tasks, { ...opts, onBrickLoaded: (r) => rows.push(r) });
  return rows;
};

// ── T1: the plan — merged runs, whole pack above the threshold ─────────────────
{
  const world = makeWorld();
  const { BL } = makeLoader(world);
  const plan = BL._planRanges([task(2, 0), task(3, 0), task(9, 0)]);
  // The Map comes from the module's vm realm: duck-type it rather than instanceof.
  assert.ok(plan && typeof plan.get === 'function' && plan.size === 1, 'one pack planned');
  const runs = plan.get('lod0/c0/pack_00.bin').map((r) => [r.start, r.end]);
  assert.deepEqual(plain(runs), [[2 * BRICK, 4 * BRICK], [9 * BRICK, 10 * BRICK]], 'adjacent bricks merged, a far one on its own run');
  assert.equal(BL._planRanges([task(0, 0), task(1, 0), task(2, 0), task(3, 0), task(4, 0), task(5, 0), task(6, 0), task(7, 0), task(8, 0), task(9, 0), task(10, 0), task(11, 0), task(12, 0)]), null,
    'thirteen of twenty bricks (65 %) -> the whole pack is cheaper');
  assert.equal(BL.taskBytes(task(4, 1)), BRICK, 'compressed bytes of one brick');
  assert.equal(BL.estimateTaskBytes([task(4, 1), task(5, 1), { lod: 0, channel: 3, bx: 0, by: 0, bz: 0 }]), 2 * BRICK, 'unknown bricks count for nothing');
  console.log('range plan: OK');
}

// ── T2: range fetches, one request per run, bytes sliced per brick ──────────────
{
  const world = makeWorld();
  const { BL, requests } = makeLoader(world);
  const rows = await rowsOf(BL, [task(2, 0), task(3, 0), task(9, 0), task(7, 1)], { byteRanges: true, cacheResults: false, streamOnly: true, concurrency: 4 });
  assert.equal(rows.length, 4, 'four bricks delivered');
  for (const r of rows) {
    assert.equal(r.data.length, BRICK, `brick (${r.bx},${r.by}) whole`);
    assert.equal(r.data[0], (r.bx + 10 * r.by) & 0xFF, `brick (${r.bx},${r.by}) carries its own bytes`);
    assert.equal(r.data[BRICK - 1], (r.bx + 10 * r.by) & 0xFF);
  }
  const ranges = requests.filter((q) => q.range).map((q) => `${q.rel} ${q.range}`).sort();
  assert.deepEqual(ranges, [
    `lod0/c0/pack_00.bin bytes=${2 * BRICK}-${4 * BRICK - 1}`,
    `lod0/c0/pack_00.bin bytes=${9 * BRICK}-${10 * BRICK - 1}`,
    `lod0/c0/pack_01.bin bytes=${7 * BRICK}-${8 * BRICK - 1}`,
  ].sort(), 'three runs, three Range requests, no whole pack');
  assert.equal(requests.filter((q) => !q.range).length, 0, 'no whole-pack fetch');
  console.log('range fetch: OK');
}

// ── T3: a server without range support answers 200: the whole pack is kept ────
{
  const world = makeWorld();
  const { BL, requests } = makeLoader(world, { rangeStatus: 200 });
  const rows = await rowsOf(BL, [task(2, 0), task(9, 0)], { byteRanges: true, cacheResults: false, streamOnly: true, concurrency: 1 });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].data[0], 2); assert.equal(rows[1].data[0], 9);
  assert.equal(requests.length, 1, 'the 200 answer served the second brick from the kept pack');
  console.log('range -> 200 fallback: OK');
}

// ── T4: a refused range (416) drops the plan for that pack, fetched whole once ──
{
  const world = makeWorld();
  const { BL, requests } = makeLoader(world, { rangeStatus: 416 });
  const rows = await rowsOf(BL, [task(2, 0), task(9, 0)], { byteRanges: true, cacheResults: false, streamOnly: true, concurrency: 1 });
  assert.equal(rows.length, 2, 'both bricks still delivered');
  assert.equal(rows[0].data[0], 2); assert.equal(rows[1].data[0], 9);
  assert.equal(requests.filter((q) => q.range).length, 1, 'one refused range');
  assert.equal(requests.filter((q) => !q.range).length, 1, 'then the whole pack, once');
  console.log('range -> 416 fallback: OK');
}

// ── T5: without byteRanges, whole packs as before ──────────────────────────────
{
  const world = makeWorld();
  const { BL, requests } = makeLoader(world);
  const rows = await rowsOf(BL, [task(2, 0), task(9, 0)], { cacheResults: false, streamOnly: true, concurrency: 2 });
  assert.equal(rows.length, 2);
  assert.equal(requests.filter((q) => q.range).length, 0, 'no Range header');
  assert.equal(requests.length, 1, 'one whole pack');
  console.log('whole packs by default: OK');
}

console.log('brick loader byte ranges: OK');
