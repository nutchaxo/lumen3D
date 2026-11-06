// BrickLoader.prefetchPacks under its budget (prefetchCacheBytes):
//   • the calls the viewer makes in one run (t+1, t−1, t+2) share ONE budget: a pack
//     still downloading counts at its planned size, so the first call's packs are
//     admitted and the later ones stop where the budget ends — nothing is downloaded
//     only to be thrown away;
//   • the packs of the first call are still held once everything has landed;
//   • a later burst makes room by dropping the lowest-ranked packs of the earlier one;
//   • a foreground batch that needs a pack whose prefetch is still waiting for a fetch
//     slot moves it ahead of the other background fetches; a promoted fetch whose batch
//     is cancelled leaves the queue and is never sent.
//
// Run: node tests/js/test_prefetch_budget.mjs
import assert from 'node:assert/strict';
import { buildV3Tree, mockFetch, loadBrickLoader } from './test_v3_loader_fixtures.mjs';

const MiB = 1024 * 1024;
const tick = () => new Promise((r) => setTimeout(r, 0));

/** fetch over synthetic packs of `sizes` (path → bytes); every request logged. */
function sizedFetch(sizes) {
  const log = [];
  const fn = async (url, init = {}) => {
    if (init.signal?.aborted) throw new DOMException('aborted', 'AbortError');
    const p = String(url).split('?')[0];
    log.push(p);
    const n = sizes.get(p);
    if (!n) return new Response('not found', { status: 404 });
    return new Response(new Uint8Array(n), { status: 200, headers: { 'Content-Length': String(n) } });
  };
  fn.log = log;
  return fn;
}

/** A v2 timepoint transport whose packs are `packs` (names) of `size` bytes each. */
function transportOf(packs, size) {
  const brickToPack = {};
  packs.forEach((name, i) => {
    brickToPack[`lod0/c0/${i}_0_0`] = { url: `lod0/${name}.bin`, offset: 0, length: size };
  });
  return { brickToPack };
}

// ── One burst shares one budget; the first call's packs stay held ────────────
{
  const base = 'DATA_WEB/live/T/bricks';
  const frames = { t1: ['a1', 'a2'], t2: ['b1', 'b2'], t3: ['c1', 'c2'], t4: ['d1', 'd2'] };
  const sizes = new Map();
  for (const [t, packs] of Object.entries(frames)) for (const p of packs) sizes.set(`${base}/${t}/lod0/${p}.bin`, MiB);
  const fetchImpl = sizedFetch(sizes);
  const BL = loadBrickLoader(fetchImpl);
  BL.configure({ prefetchCacheBytes: 3 * MiB });
  const tr = Object.fromEntries(Object.entries(frames).map(([t, p]) => [t, transportOf(p, MiB)]));

  // The viewer's loop: t+1, t−1, t+2, synchronously.
  const counts = await Promise.all(['t1', 't2', 't3'].map(t => BL.prefetchPacks(`${base}/${t}`, tr[t], 0, 0, 8)));
  assert.deepEqual(counts, [2, 1, 0], 'the budget is shared in call order (t+1 whole, then what is left)');
  assert.deepEqual([...fetchImpl.log].sort(),
    [`${base}/t1/lod0/a1.bin`, `${base}/t1/lod0/a2.bin`, `${base}/t2/lod0/b1.bin`],
    'only the packs that fit were downloaded');
  assert.equal(fetchImpl.log.length, 3, 'three packs downloaded, none thrown away');
  assert.equal(BL.getCacheStats().packBytes, 3 * MiB, 'everything that landed is held');

  // The first call's packs are still there: asking again downloads nothing.
  const before = fetchImpl.log.length;
  assert.equal(await BL.prefetchPacks(`${base}/t1`, tr.t1, 0, 0, 8), 2, 't+1 still held');
  assert.equal(fetchImpl.log.length, before, 'no second download of t+1');
  console.log('one burst, one budget, t+1 kept: OK');

  // A later burst (another frame step) drops the lowest-ranked packs to make room:
  // the older burst's last call (b1) goes before its first one (t1), which this burst
  // asked for again and so outranks it.
  await tick();
  const n = await Promise.all([BL.prefetchPacks(`${base}/t1`, tr.t1, 0, 0, 8), BL.prefetchPacks(`${base}/t4`, tr.t4, 0, 0, 8)]);
  assert.deepEqual(n, [2, 1], 't1 kept, one pack of t4 fits once b1 is dropped');
  assert.ok(fetchImpl.log.includes(`${base}/t4/lod0/d1.bin`), 'd1 downloaded');
  assert.ok(!fetchImpl.log.includes(`${base}/t4/lod0/d2.bin`), 'd2 does not fit beside t1 + d1');
  assert.equal(BL.getCacheStats().packBytes, 3 * MiB, 'the budget holds');
  const again = fetchImpl.log.length;
  assert.equal(await BL.prefetchPacks(`${base}/t1`, tr.t1, 0, 0, 8), 2, 't1 survived the later burst');
  assert.equal(fetchImpl.log.length, again, 't1 not downloaded again');
  console.log('a later burst drops the lowest-ranked packs first: OK');
}

// ── A queued prefetch a foreground batch needs goes first ───────────────────
const BASE = 'DATA_WEB/3d/pf/bricks';
const tree = buildV3Tree({
  base: BASE, channels: 2,
  levels: [
    { dims: { x: 130, y: 64, z: 64 }, voxelSize: { x: 1, y: 1, z: 1 } },
    { dims: { x: 65, y: 32, z: 64 }, voxelSize: { x: 2, y: 2, z: 1 } }
  ],
  value: (k, c, x, y, z) => 1 + ((x + y + z + c + k) % 200),
  perPack: 1
});
const packOf = (k, c, p = 0) => `${BASE}/l${k}/c${c}/p${String(p).padStart(5, '0')}.bin`;

function gatedFetch(files) {
  const inner = mockFetch(files);
  const gates = new Map();
  const order = [];
  const fn = async (url, init = {}) => {
    const p = String(url).split('?')[0];
    if (p.endsWith('.bin') && !p.endsWith('index.bin')) order.push(p);
    const gate = gates.get(p);
    if (gate) {
      await new Promise((resolve, reject) => {
        if (init.signal?.aborted) { reject(new DOMException('aborted', 'AbortError')); return; }
        gate.waiters.push(resolve);
        if (gate.open) resolve();
        init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
      });
    }
    return inner(url, init);
  };
  fn.order = order;
  fn.hold = (p) => gates.set(p, { open: false, waiters: [] });
  fn.release = (p) => { const g = gates.get(p); if (g) { g.open = true; g.waiters.splice(0).forEach(r => r()); } };
  return fn;
}

async function scenario(cancelForeground) {
  const fetchImpl = gatedFetch(tree.files);
  const BL = loadBrickLoader(fetchImpl);
  await BL.init(BASE, tree.manifest);
  BL.configure({ prefetchCacheBytes: 64 * MiB, packFetchSlots: 1 });
  const x = packOf(1, 0), b = packOf(1, 1), a = packOf(0, 0, 1);
  fetchImpl.hold(x);
  // One burst: x takes the only slot, then b and a wait in the background queue (b first).
  const prefetches = [
    BL.prefetchPacks(BASE, tree.manifest, 1, 0, 1),
    BL.prefetchPacks(BASE, tree.manifest, 1, 1, 1),
    BL.prefetchPacks(BASE, tree.manifest, 0, 0, 2)
  ];
  for (let i = 0; i < 10; i++) await tick();
  assert.deepEqual(fetchImpl.order, [x], 'x holds the slot, the others wait');

  // A foreground batch needs a brick of pack a (level 0, channel 0, brick x = 1).
  const ctrl = new AbortController();
  const fg = BL.loadBrickTasks([{ lod: 0, channel: 0, bx: 1, by: 0, bz: 0 }], { streamOnly: true, signal: ctrl.signal, cancelPrevious: false });
  for (let i = 0; i < 10; i++) await tick();
  if (cancelForeground) {
    ctrl.abort();
    for (let i = 0; i < 5; i++) await tick();
  }
  fetchImpl.release(x);
  const summary = (await fg).summary;
  await Promise.all(prefetches);
  for (let i = 0; i < 20; i++) await tick();
  return { order: fetchImpl.order, summary, x, a, b };
}

{
  const { order, summary, x, a, b } = await scenario(false);
  assert.deepEqual(order.slice(0, 3), [x, a, b], 'the pack the foreground batch needs is fetched before the other background one');
  assert.equal(summary.delivered, 1, 'the foreground brick delivered');
  assert.equal(summary.failed.length, 0);
  console.log('a needed prefetch joins the foreground queue: OK');
}
{
  const { order, summary, x, a, b } = await scenario(true);
  assert.equal(summary.cancelled, true, 'the foreground batch was cancelled');
  assert.deepEqual(order.slice(0, 2), [x, b], 'the cancelled promoted fetch left the queue: the background one goes next');
  assert.ok(!order.includes(a), 'the cancelled pack is never requested');
  console.log('a cancelled promoted fetch leaves the queue: OK');
}

console.log('test_prefetch_budget: all OK');
