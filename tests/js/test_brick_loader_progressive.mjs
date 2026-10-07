// A pack is read as it arrives: a brick is cut out as soon as its own bytes have
// landed, not when the whole pack body is in (the volume used to appear pack by
// pack, in jolts).
//   • one pack of eight bricks streamed in eight chunks: brick k is delivered while
//     chunk k+1 has not been sent yet, every brick carries its own bytes;
//   • the order inside a pack follows the byte offsets, not the raster order;
//   • a body without Content-Length (the buffer grows) still delivers every brick;
//   • with verifyHashes on and a pack hash in the manifest, nothing is delivered
//     before the whole pack is in and verified;
//   • a stalled pack aborted mid-body fails its remaining bricks, keeps the delivered ones.
//
// Run: node tests/js/test_brick_loader_progressive.mjs
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { loadModule } from './harness.mjs';

const BS = 64;
const BRICK = BS * BS * BS;
const N = 8;
const PACK = 'lod0/c0/pack_00.bin';

// One pack of N raw-u8 bricks; brick bx is byte-filled with bx + 1. `reverse` stores
// them in the pack in the opposite order to the raster order.
function makeWorld({ reverse = false } = {}) {
  const pack = new Uint8Array(N * BRICK);
  const brickToPack = {};
  const chunks = [];
  for (let bx = 0; bx < N; bx++) {
    const slot = reverse ? N - 1 - bx : bx;
    pack.fill(bx + 1, slot * BRICK, (slot + 1) * BRICK);
    brickToPack[`lod0/c0/x${String(bx).padStart(3, '0')}_y000_z000.webp`] = { url: PACK, offset: slot * BRICK, length: BRICK };
    chunks.push({ id: `0_0_${bx}` });
  }
  return { pack, brickToPack, chunks };
}

// fetch() answers with a streamed body whose chunks (one brick each) are pushed by the test.
function makeLoader(world, { contentLength = true, hash = null } = {}) {
  const streams = [];
  const fetchImpl = async (url, init = {}) => {
    let controller;
    const body = new ReadableStream({ start(c) { controller = c; } });
    let sent = 0;
    const s = {
      push() {
        if (sent >= N) return;
        controller.enqueue(world.pack.slice(sent * BRICK, (sent + 1) * BRICK));
        if (++sent === N) controller.close();
      },
      get sent() { return sent; }
    };
    init.signal?.addEventListener('abort', () => { try { controller.error(new DOMException('Aborted', 'AbortError')); } catch (e) { /* closed */ } }, { once: true });
    streams.push(s);
    const headers = new Map(contentLength ? [['content-length', String(world.pack.length)]] : []);
    return { ok: true, status: 200, body, headers: { get: (k) => headers.get(k.toLowerCase()) ?? null } };
  };
  const BL = loadModule('js/core/brick-loader.js', 'BrickLoader', {
    document: { createElement: () => ({ getContext: () => ({}) }) },
    navigator: { hardwareConcurrency: 2 },
    performance: { now: () => Date.now() },
    window: {},
    crypto: globalThis.crypto,
    AbortController: globalThis.AbortController,
    DOMException: globalThis.DOMException,
    ReadableStream: globalThis.ReadableStream,
    fetch: fetchImpl,
  });
  const transport = { encoding: 'raw-u8', mode: 'packs', packSize: N, brickToPack: world.brickToPack };
  if (hash) transport.packHashes = { [PACK]: hash };
  BL.init('DATA_WEB/3d/R/bricks', {
    levels: [{ level: 0, dimensions: { x: N * BS, y: BS, z: BS }, brickSize: BS, chunks: world.chunks }],
    channels: 1,
    brickTransport: transport,
  });
  return { BL, streams };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));
const tasks = () => Array.from({ length: N }, (_, bx) => ({ lod: 0, channel: 0, bx, by: 0, bz: 0 }));
const load = (BL) => {
  const rows = [];
  const done = BL.loadBrickTasks(tasks(), { onBrickLoaded: (r) => rows.push(r) }).catch((e) => e);
  return { rows, done };
};

// ── 1. Bricks are delivered while their pack is still downloading ────────────
{
  const { BL, streams } = makeLoader(makeWorld());
  const run = load(BL);
  await settle();
  assert.equal(streams.length, 1, 'one request for the pack');
  for (let k = 0; k < N; k++) {
    streams[0].push();
    await settle();
    assert.equal(run.rows.length, k + 1, `after ${k + 1}/${N} chunks, ${k + 1} bricks are delivered (pack not finished)`);
  }
  const r = await run.done;
  assert.ok(!(r instanceof Error), `batch completes (${r?.message || 'ok'})`);
  for (const row of run.rows) assert.ok(row.data.every((v) => v === row.bx + 1), `brick ${row.bx} carries its own bytes`);
  assert.equal(BL.getCacheStats().packBytes, 0, 'the pack is released once cut');
}

// ── 2. Inside a pack, byte order wins over raster order ──────────────────────
{
  const { BL, streams } = makeLoader(makeWorld({ reverse: true }));
  const run = load(BL);
  await settle();
  streams[0].push();
  streams[0].push();
  await settle();
  assert.deepEqual(run.rows.map((r) => r.bx), [N - 1, N - 2], 'the bricks stored first are delivered first');
  while (streams[0].sent < N) streams[0].push();
  await run.done;
  assert.equal(run.rows.length, N);
  for (const row of run.rows) assert.equal(row.data[0], row.bx + 1);
}

// ── 3. No Content-Length: the receive buffer grows, nothing is lost ──────────
{
  const { BL, streams } = makeLoader(makeWorld(), { contentLength: false });
  const run = load(BL);
  await settle();
  streams[0].push();
  await settle();
  assert.equal(run.rows.length, 1, 'progressive without Content-Length too');
  while (streams[0].sent < N) { streams[0].push(); await settle(); }
  await run.done;
  assert.equal(run.rows.length, N);
  for (const row of run.rows) assert.ok(row.data.every((v) => v === row.bx + 1), `brick ${row.bx} intact after the buffer grew`);
}

// ── 4. A pack that must match its hash is used only once whole and verified ──
{
  const world = makeWorld();
  const hash = createHash('sha256').update(world.pack).digest('hex');
  const { BL, streams } = makeLoader(world, { hash });
  BL.configure({ verifyHashes: true });
  const run = load(BL);
  await settle();
  for (let k = 0; k < N - 1; k++) streams[0].push();
  await settle();
  assert.equal(run.rows.length, 0, 'no brick of an unverified pack is delivered');
  streams[0].push();
  const r = await run.done;
  assert.ok(!(r instanceof Error), `verified batch completes (${r?.message || 'ok'})`);
  assert.equal(run.rows.length, N);
}

// ── 5. A body that stalls mid-pack: delivered bricks stay, the rest fail ─────
{
  const { BL, streams } = makeLoader(makeWorld());
  BL.configure({ fetchStallMs: 50 });
  const errors = [];
  const rows = [];
  const done = BL.loadBrickTasks(tasks(), { onBrickLoaded: (r) => rows.push(r), onBrickError: (e) => errors.push(e) }).catch((e) => e);
  await settle();
  streams[0].push();
  streams[0].push();
  // Every new request stalls too: retries cannot complete.
  const r = await done;
  assert.ok(!(r instanceof Error), 'the batch settles');
  assert.equal(rows.length, 2, 'the two bricks that had landed were delivered');
  assert.equal(rows.length + errors.length, N, 'every other brick is reported as failed, none delivered as zeros');
}

console.log('BrickLoader progressive pack read (bricks cut while the pack downloads · byte order · no Content-Length · hash-gated · stall): OK');
