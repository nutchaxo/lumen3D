// Unit test for ELE-20 / EDGE-003: a failed brick (404 / missing from pack index)
// must degrade gracefully and TRACEABLY (Rule 1.1) — dropped + onBrickError —
// NOT returned as silent zeros. A legitimately-empty brick (ESS, not referenced
// by the manifest) still returns zeros silently with no error.
//
// Run: node tests/js/test_brick_loader_degrade.mjs
import assert from 'node:assert/strict';
import { loadModule } from './harness.mjs';

function makeLoader(fetchImpl) {
  return loadModule('js/core/brick-loader.js', 'BrickLoader', {
    document: { createElement: () => ({ getContext: () => ({}) }) },
    navigator: { hardwareConcurrency: 1 },
    performance: { now: () => Date.now() },
    window: {},
    AbortController: globalThis.AbortController,
    DOMException: globalThis.DOMException,
    fetch: fetchImpl,
  });
}

// T1: an EXPECTED brick that 404s -> dropped + onBrickError, never cached as zeros
{
  const BL = makeLoader(async () => ({ ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) }));
  BL.init('DATA_WEB/fixed/A/bricks', {
    levels: [{ level: 0, dimensions: { x: 128, y: 128, z: 128 }, brickSize: 128, chunks: [{ id: '0_0_0' }] }],
    channels: 1, brickTransport: { encoding: 'raw-u8', mode: 'direct' },
  });
  const errors = [];
  await BL.loadBrickTasks([{ lod: 0, channel: 0, bx: 0, by: 0, bz: 0 }],
    { cacheResults: true, onBrickError: (e) => errors.push(e) });
  assert.equal(errors.length, 1, 'failed brick notifies onBrickError (traceable drop)');
  assert.equal(BL.getCacheStats().entries, 0, 'failed brick is dropped, not cached as silent zeros');
}

// T2: a NOT-expected brick (ESS-empty, absent from the pack index) -> silent zeros, no error
{
  const BL = makeLoader(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(0) }));
  BL.init('DATA_WEB/fixed/B/bricks', {
    levels: [{ level: 0, dimensions: { x: 128, y: 128, z: 128 }, brickSize: 128 }],  // no chunks => nothing "expected"
    channels: 1,
    brickTransport: { mode: 'packs', encoding: 'raw-u8', brickToPack: { 'lod0/other.bin': { url: 'p.bin', offset: 0, length: 10 } } },
  });
  const errors = [];
  let loaded = 0;
  await BL.loadBrickTasks([{ lod: 0, channel: 0, bx: 9, by: 9, bz: 9 }],
    { cacheResults: true, onBrickError: (e) => errors.push(e), onBrickLoaded: () => loaded++ });
  assert.equal(errors.length, 0, 'ESS-empty brick (not expected) raises no error');
  assert.equal(loaded, 1, 'ESS-empty brick still resolves (zeros)');
}

console.log('ELE-20 brick failure degrade vs ESS: OK');
