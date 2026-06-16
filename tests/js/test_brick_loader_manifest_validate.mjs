// Unit test for ELE-21 / EDGE-004: brick-loader must validate the manifest
// before mounting (Rule 1.4) and reject a malformed one WITHOUT mutating the
// state of an already-mounted valid dataset.
//
// Run: node tests/js/test_brick_loader_manifest_validate.mjs
import assert from 'node:assert/strict';
import { loadModule } from './harness.mjs';

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

const VALID = {
  levels: [{ level: 0, dimensions: { x: 128, y: 128, z: 128 }, brickSize: 128 }],
  channels: 1, brickTransport: { encoding: 'raw-u8' },
};

// valid manifest mounts cleanly
{
  const BL = makeLoader();
  BL.init('DATA_WEB/fixed/A/bricks', VALID);
  assert.ok(BL.isReady(), 'valid manifest mounts');
  assert.equal(typeof BL._validateManifest, 'function', '_validateManifest exposed');
}

// malformed manifests are rejected (throw)
{
  const BL = makeLoader();
  const bad = [
    null, {}, { levels: [] }, { levels: 'x' },
    { levels: [{ level: 0 }] },                                       // dimensions missing
    { levels: [{ level: 0, dimensions: { x: 0, y: 1, z: 1 } }] },     // non-positive dim
    { levels: [{ level: -1, dimensions: { x: 1, y: 1, z: 1 } }] },    // negative level
    { levels: [{ level: 0, dimensions: { x: 1, y: 1, z: 1 } }], channels: 0 },  // channels < 1
    { levels: [{ level: 0, dimensions: { x: 1, y: 1, z: 1 } }], brickTransport: { encoding: 'bogus' } }, // unknown enc
  ];
  for (const m of bad) {
    assert.throws(() => BL._validateManifest(m), `should reject ${JSON.stringify(m)}`);
  }
}

// reject BEFORE mutation: a bad init() must not corrupt a mounted valid dataset
{
  const BL = makeLoader();
  BL.init('DATA_WEB/fixed/A/bricks', VALID);
  const kA = BL._cacheKey(0, 0, 1, 2, 3);
  assert.throws(() => BL.init('DATA_WEB/fixed/B/bricks', { levels: [] }), 'malformed init throws');
  assert.ok(BL.isReady(), 'previous valid dataset still mounted after rejected init');
  assert.equal(BL._cacheKey(0, 0, 1, 2, 3), kA, 'cache key tag unchanged (no partial mutation on reject)');
}

console.log('ELE-21 brick-loader manifest validation: OK');
