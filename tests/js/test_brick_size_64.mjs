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
  BL.init('DATA_WEB/fixed/A/bricks', {
    levels: [{ level: 0, dimensions: { x: 256, y: 256, z: 256 } }],
    channels: 1, brickTransport: { encoding: 'raw-u8' },
  });
  const dims = BL.getDimensions(0);
  assert.equal(dims.brickSize, 64, 'getDimensions fallback brickSize is 64 (was legacy 128)');
}

// ── Regression: an explicit per-level brickSize is still honored (fallback only
// fires when absent). ──
{
  const BL = makeLoader();
  BL.init('DATA_WEB/fixed/B/bricks', {
    levels: [{ level: 0, dimensions: { x: 256, y: 256, z: 256 }, brickSize: 32 }],
    channels: 1, brickTransport: { encoding: 'raw-u8' },
  });
  assert.equal(BL.getDimensions(0).brickSize, 32, 'explicit level.brickSize honored over fallback');
}

// ── Behavioral: getCacheStats memory estimate uses 64³ per brick (256 KiB),
// not 128³ (2 MiB). With BRICK_SIZE=64 and N cached bricks, MB ≈ N * 64³ / 1MiB. ──
{
  const BL = makeLoader();
  // getCacheStats reads _cache.size; with an empty cache the estimate is 0 either
  // way, so assert the formula constant directly via the source AND the empty case.
  const stats = BL.getCacheStats();
  assert.equal(stats.memoryEstimateMB, 0, 'empty cache estimate is 0');
}

// ── Structural: header comment fixed + brick-fetch-worker literals are 64. ──
{
  const loaderSrc = readFileSync(path.join(ROOT, 'js/core/brick-loader.js'), 'utf8');
  assert.ok(/const BRICK_SIZE = 64;/.test(loaderSrc), 'BRICK_SIZE constant is 64');
  assert.ok(!/Loads chunked volume bricks \(128/.test(loaderSrc), 'header comment no longer says 128³');
  // the 8×-wrong cache estimate is now driven by the corrected constant
  assert.ok(/_cache\.size \* BRICK_SIZE \* BRICK_SIZE \* BRICK_SIZE/.test(loaderSrc),
    'getCacheStats still derives from BRICK_SIZE (now 64)');

  const workerSrc = readFileSync(path.join(ROOT, 'js/core/brick-fetch-worker.js'), 'utf8');
  assert.ok(!/brickSize \|\| 128/.test(workerSrc), 'fetch-worker no longer falls back to 128');
  const matches64 = workerSrc.match(/brickSize \|\| 64/g) || [];
  assert.equal(matches64.length, 2, 'both fetch-worker blank-brick fallbacks use 64');
}

console.log('STREAMING-2 BRICK_SIZE=64 fallback: OK');
