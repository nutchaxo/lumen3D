// Unit test for STREAMING-2 / DEAD-026 / BUG-036: the brick-loader fallback
// BRICK_SIZE must be 64 (the real brick size produced by 3-chunk_packer.py),
// not the legacy 128. The old value was the ONE size that never matches real
// data: it mis-sized blank-brick fallbacks (8× too big) and inflated the
// getCacheStats memory estimate by 8× (128³/64³).
//
// Run: node tests/js/test_brick_size_64.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadModule } from './harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function makeLoader() {
  return loadModule('js/core/brick-loader.js', 'BrickLoader', {
    document: { createElement: () => ({ getContext: () => ({}) }) },
    navigator: { hardwareConcurrency: 1 },
    performance: { now: () => Date.now() },
    window: {},
    AbortController: globalThis.AbortController,
    DOMException: globalThis.DOMException,
    fetch: async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(0) }),
  });
}

// ── Behavioral: getDimensions falls back to BRICK_SIZE when a level omits
// brickSize. After the fix that fallback is 64, not 128. ──
{
  const BL = makeLoader();
  // valid manifest, level[0] OMITS brickSize (and no top-level brickSize) ->
  // getDimensions must use the BRICK_SIZE fallback.
  BL.init('DATA_WEB/3d/A/bricks', {
    levels: [{ level: 0, dimensions: { x: 256, y: 256, z: 256 } }],
    channels: 1, brickTransport: { encoding: 'raw-u8' },
  });
  const dims = BL.getDimensions(0);
  assert.equal(dims.brickSize, 64, 'getDimensions fallback brickSize is 64 (was legacy 128)');
}

// ── A manifest declaring another brick size is REJECTED: the decoder, the SVR atlas
// and both shaders are built on 64, so a 32³ manifest would mount scrambled. ──
{
  const BL = makeLoader();
  assert.throws(() => BL.init('DATA_WEB/3d/B/bricks', {
    levels: [{ level: 0, dimensions: { x: 256, y: 256, z: 256 }, brickSize: 32 }],
    channels: 1, brickTransport: { encoding: 'raw-u8' },
  }), /brickSize must be 64/, 'level.brickSize 32 rejected');
  assert.throws(() => BL.init('DATA_WEB/3d/B/bricks', {
    brickSize: 128, levels: [{ level: 0, dimensions: { x: 256, y: 256, z: 256 } }],
    channels: 1, brickTransport: { encoding: 'raw-u8' },
  }), /brickSize must be 64/, 'manifest brickSize 128 rejected');
  assert.equal(BL.isReady(), false, 'nothing mounted');
}

// ── Behavioral: getCacheStats memory estimate uses 64³ per brick (256 KiB),
// not 128³ (2 MiB). With BRICK_SIZE=64 and N cached bricks, MB ≈ N * 64³ / 1MiB. ──
{
  const BL = makeLoader();
  // Decoded bricks are not cached any more: the estimate is the compressed bytes held.
  const stats = BL.getCacheStats();
  assert.equal(stats.memoryEstimateMB, 0, 'empty cache estimate is 0');
  assert.equal(stats.entries, 0, 'no decoded-brick cache');
}

// ── Structural: header comment fixed + BRICK_SIZE drives the cache estimate. ──
// (The brick-fetch-worker.js assertions were removed in v1.0.50 — that worker was
//  dead code, never instantiated, and the file was deleted per DEAD-003/DEAD-039.)
{
  const loaderSrc = readFileSync(path.join(ROOT, 'js/core/brick-loader.js'), 'utf8');
  assert.ok(/const BRICK_SIZE = 64;/.test(loaderSrc), 'BRICK_SIZE constant is 64');
  assert.ok(!/Loads chunked volume bricks \(128/.test(loaderSrc), 'header comment no longer says 128³');
  assert.ok(!/LRU_LIMIT/.test(loaderSrc), 'the dead decoded-brick LRU is gone');
}

console.log('STREAMING-2 BRICK_SIZE=64 fallback: OK');
