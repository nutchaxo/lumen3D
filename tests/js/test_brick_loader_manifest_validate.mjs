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
  levels: [{ level: 0, dimensions: { x: 128, y: 128, z: 128 }, brickSize: 64 }],
  channels: 1, brickTransport: { encoding: 'raw-u8' },
};

// valid manifest mounts cleanly
{
  const BL = makeLoader();
  BL.init('DATA_WEB/3d/A/bricks', VALID);
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
    { levels: [{ level: 0, dimensions: { x: 1, y: 1, z: 1 }, brickSize: 32 }] },                   // not 64
    { brickSize: 128, levels: [{ level: 0, dimensions: { x: 1, y: 1, z: 1 } }] },                  // not 64
    { levels: [{ level: 1, dimensions: { x: 1, y: 1, z: 1 } }, { level: 0, dimensions: { x: 1, y: 1, z: 1 } }] }, // out of order
  ];
  for (const m of bad) {
    assert.throws(() => BL._validateManifest(m), `should reject ${JSON.stringify(m)}`);
  }
}

// reject BEFORE mutation: a bad init() must not corrupt a mounted valid dataset
{
  const BL = makeLoader();
  BL.init('DATA_WEB/3d/A/bricks', VALID);
  const before = BL.getManifest();
  assert.throws(() => BL.init('DATA_WEB/3d/B/bricks', { levels: [] }), 'malformed init throws');
  assert.ok(BL.isReady(), 'previous valid dataset still mounted after rejected init');
  assert.equal(BL.getManifest(), before, 'mounted manifest unchanged (no partial mutation on reject)');
  assert.equal(BL.getDimensions(0).x, 128, 'mounted dimensions unchanged');
  assert.equal(BL.getDimensions(7), null, 'a level the manifest does not have has no dimensions');
}

console.log('ELE-21 brick-loader manifest validation: OK');
