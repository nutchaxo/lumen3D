// BrickLoader keeps at most a few pack BODIES in flight (packFetchSlots, 4 by default):
// a browser opens six HTTP/1.1 connections to a host and queues the rest in arrival
// order, the page's own requests included — with every socket busy on a pack body,
// the admin panel's next call (the metadata of the dataset just clicked, the list
// after a save) waited for whole packs to land.
//   • four bodies in flight, the fifth starts when one has landed, every brick arrives;
//   • the cap is configurable, and raising it lets the waiting bodies start;
//   • a dataset switch aborts the bodies in flight AND empties the queue: the next
//     dataset starts its four bodies at once.
//
// Run: node tests/js/test_brick_loader_sockets.mjs
import assert from 'node:assert/strict';
import { loadModule } from './harness.mjs';

const BS = 64;
const BRICK = BS * BS * BS;
const N = 12;

// Twelve packs of one raw-u8 brick each; pack `bx` is byte-filled with bx + 1.
function makeWorld() {
  const packs = {};
  const brickToPack = {};
  const chunks = [];
  for (let bx = 0; bx < N; bx++) {
    const url = `lod0/c0/pack_${String(bx).padStart(2, '0')}.bin`;
    packs[url] = new Uint8Array(BRICK).fill(bx + 1);
    brickToPack[`lod0/c0/x${String(bx).padStart(3, '0')}_y000_z000.webp`] = { url, offset: 0, length: BRICK };
    chunks.push({ id: `0_0_${bx}` });
  }
  return { packs, brickToPack, chunks };
}

// fetch() answers at once with a body that lands only when the test says so; an
// abort of the request's signal rejects the body, as a real fetch does.
function makeLoader(world) {
  const started = [];
  const fetchImpl = async (url, init = {}) => {
    const rel = String(url).split('/bricks/')[1];
    const pack = world.packs[rel];
    if (!pack) return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
    let land, fail;
    const gate = new Promise((resolve, reject) => { land = resolve; fail = reject; });
    gate.catch(() => {});
    init.signal?.addEventListener('abort', () => fail(new DOMException('Aborted', 'AbortError')), { once: true });
    const entry = { rel, landed: false, land: () => { entry.landed = true; land(); } };
    started.push(entry);
    return { ok: true, status: 200, arrayBuffer: async () => { await gate; return pack.buffer.slice(0); } };
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
  const mount = (root = 'R') => BL.init(`DATA_WEB/3d/${root}/bricks`, {
    levels: [{ level: 0, dimensions: { x: N * BS, y: BS, z: BS }, brickSize: BS, chunks: world.chunks }],
    channels: 1,
    brickTransport: { encoding: 'raw-u8', mode: 'packs', packSize: 1, brickToPack: world.brickToPack },
  });
  mount();
  return { BL, started, mount };
}

const tasks = () => Array.from({ length: N }, (_, bx) => ({ lod: 0, channel: 0, bx, by: 0, bz: 0 }));
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
const load = (BL) => {
  const rows = [];
  const done = BL.loadBrickTasks(tasks(), { onBrickLoaded: (r) => rows.push(r) }).catch((e) => e);
  return { rows, done };
};
const landAll = async (started) => {
  while (started.some((s) => !s.landed)) {
    started.filter((s) => !s.landed).forEach((s) => s.land());
    await settle();
  }
};

// ── 1. Four bodies in flight; the fifth starts when one lands; everything arrives ──
{
  const { BL, started } = makeLoader(makeWorld());
  const first = load(BL);
  await settle();
  assert.equal(started.length, 4, 'four pack bodies in flight, the other eight wait for a slot');
  started[0].land();
  await settle();
  assert.equal(started.length, 5, 'the fifth body starts when one has landed');
  await landAll(started);
  const r = await first.done;
  assert.ok(!(r instanceof Error), `the batch completes (${r?.message || 'ok'})`);
  assert.equal(started.length, N, 'every pack fetched exactly once');
  assert.equal(first.rows.length, N, 'every brick delivered');
  for (const row of first.rows) assert.equal(row.data[0], row.bx + 1, `brick ${row.bx} carries its own pack's bytes`);
  const again = load(BL);
  await settle();
  await again.done;
  assert.equal(started.length, N, 'a second batch over the same bricks fetches nothing (LRU)');
  assert.equal(again.rows.length, N);
}

// ── 2. The cap is configurable; raising it releases the queue ────────────────
{
  const { BL, started } = makeLoader(makeWorld());
  BL.configure({ packFetchSlots: 2 });
  const batch = load(BL);
  await settle();
  assert.equal(started.length, 2, 'configure({ packFetchSlots: 2 }): two bodies in flight');
  BL.configure({ packFetchSlots: 99 });
  started[0].land();
  await settle();
  assert.equal(started.length, N, 'with the cap raised (clamped to 16), one landing lets every waiting body start');
  await landAll(started);
  const r = await batch.done;
  assert.ok(!(r instanceof Error));
  assert.equal(batch.rows.length, N);
}

// ── 3. A dataset switch frees the slots and empties the queue ────────────────
{
  const { BL, started, mount } = makeLoader(makeWorld());
  const first = load(BL);
  await settle();
  assert.equal(started.length, 4);
  mount('S');
  await settle();
  const r = await first.done;
  assert.ok(!(r instanceof Error), 'the abandoned batch ends instead of hanging on its queued bodies');
  const second = load(BL);
  await settle();
  assert.equal(started.length, 8, 'the next dataset starts four bodies at once: the aborted ones freed their slots and the waiters left the queue');
  await landAll(started);
  const r2 = await second.done;
  assert.ok(!(r2 instanceof Error), `the new batch completes (${r2?.message || 'ok'})`);
  assert.equal(second.rows.length, N, 'every brick of the new dataset delivered');
  assert.equal(started.length, 4 + N, 'the new dataset fetched each of its packs once');
}

console.log('BrickLoader pack-fetch slots (four bodies in flight · configurable · freed on a dataset switch): OK');
