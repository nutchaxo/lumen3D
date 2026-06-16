// Unit tests for the brick-loader concurrency hardening (ELE-12/13/17).
//  - ELE-13 (RACE-004): _cacheKey is prefixed by the dataset tag (no inter-dataset collision).
//  - ELE-17 (RACE-031): a per-load signal abort rejects only that caller, without
//    aborting the shared loader-owned pack fetch (concurrent caller still gets the buffer).
//  - ELE-12 (RACE-003): a result that completes after a dataset switch (generation bump)
//    is NOT written into the new dataset's cache.
//
// Run: node tests/js/test_brick_loader_concurrency.mjs
import assert from 'node:assert/strict';
import { loadModule } from './harness.mjs';

function makeLoader({ getContextTruthy = true, fetchImpl } = {}) {
  return loadModule('js/core/brick-loader.js', 'BrickLoader', {
    document: { createElement: () => ({ getContext: () => (getContextTruthy ? {} : null) }) },
    navigator: { hardwareConcurrency: 1 },
    performance: { now: () => Date.now() },
    window: {},
    AbortController: globalThis.AbortController,
    DOMException: globalThis.DOMException,
    fetch: fetchImpl || (async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(0) })),
  });
}
const tick = () => new Promise((r) => setTimeout(r, 5));

// ---- ELE-13: dataset-tagged cache key ----
{
  const BL = makeLoader({ getContextTruthy: false });
  BL.init('DATA_WEB/fixed/A/bricks', { levels: [], channels: 1 });
  const kA = BL._cacheKey(0, 0, 1, 2, 3);
  BL.init('DATA_WEB/fixed/B/bricks', { levels: [], channels: 1 });
  const kB = BL._cacheKey(0, 0, 1, 2, 3);
  assert.notEqual(kA, kB, 'cache keys must differ between datasets for the same coord');
  assert.ok(kA.includes('A'), 'key A carries its dataset tag');
  assert.ok(kB.includes('B'), 'key B carries its dataset tag');
  assert.equal(kA.split(':').pop(), '1_2_3', 'coord remains the last ":"-segment');
}

// ---- ELE-17: pack-fetch abort isolation ----
{
  let resolveAB;
  const sharedAB = new Promise((res) => { resolveAB = res; });
  let fetchCalls = 0;
  const fetchImpl = (url, opts) => { fetchCalls++; return Promise.resolve({ ok: true, arrayBuffer: () => sharedAB }); };
  const BL = makeLoader({ fetchImpl });
  BL.init('DATA_WEB/fixed/A/bricks', { levels: [], channels: 1 });

  const cA = new globalThis.AbortController();
  const p1 = BL._fetchPackBuffer('pack0.bin', cA.signal);
  const p2 = BL._fetchPackBuffer('pack0.bin', new globalThis.AbortController().signal); // shares cached promise
  cA.abort();
  let p1err = null;
  await p1.then(() => {}, (e) => { p1err = e; });
  assert.ok(p1err && p1err.name === 'AbortError', 'aborting caller A rejects only A with AbortError');
  resolveAB(new ArrayBuffer(8)); // shared fetch was never aborted
  const buf = await p2;
  assert.ok(buf instanceof ArrayBuffer && buf.byteLength === 8, 'concurrent caller still receives the buffer');
  assert.equal(fetchCalls, 1, 'fetch is shared per pack URL (one network call)');
}

// ---- ELE-12: stale result dropped after a dataset switch ----
{
  let resolveFetch;
  const gate = new Promise((res) => { resolveFetch = res; });
  const fetchImpl = () => Promise.resolve({ ok: true, arrayBuffer: () => gate });
  const manifest = {
    channels: 1,
    brickTransport: { encoding: 'raw-u8', mode: 'direct' },
    levels: [{ level: 0, dimensions: { x: 128, y: 128, z: 128 }, brickSize: 128, chunks: [{ id: '0_0_0', nonEmpty: true }] }],
  };
  const BL = makeLoader({ fetchImpl, getContextTruthy: true });
  BL.init('DATA_WEB/fixed/A/bricks', manifest);
  const loadP = BL.loadBrickTasks([{ lod: 0, channel: 0, bx: 0, by: 0, bz: 0 }], { cacheResults: true });
  await tick();
  BL.init('DATA_WEB/fixed/B/bricks', manifest); // bumps generation + cancels A
  resolveFetch(new ArrayBuffer(128 * 128 * 128)); // stale A fetch completes after the switch
  await loadP.catch(() => {});
  await tick();
  assert.equal(BL.getCacheStats().entries, 0, 'a result completing after a switch must not populate the new cache');
}

console.log('ELE-12/13/17 brick-loader concurrency: OK');
