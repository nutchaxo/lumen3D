// Structural test for ELE-24 / BUG-003: the `dims.brickSize || 128` fallback
// (wrong; real brick is 64) must be gone everywhere in volume-viewer.js,
// replaced by an authoritative VOLUME_BRICK_SIZE = 64 constant. volume-viewer.js
// is not headless-loadable, so this is structural + cross-module consistency.
//
// Run: node tests/js/test_volume_viewer_bricksize.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(path.join(ROOT, p), 'utf8');
const count = (s, sub) => s.split(sub).length - 1;

const vv = read('js/viewers/volume-viewer.js');
assert.ok(vv.includes('const VOLUME_BRICK_SIZE = 64;'), 'VOLUME_BRICK_SIZE = 64 constant defined');
assert.equal(count(vv, 'dims.brickSize || 128'), 0, 'no `|| 128` fallback remains');
assert.equal(count(vv, 'dims.brickSize || VOLUME_BRICK_SIZE'), 10, 'all 10 sites use the constant');

// Cross-module: 64 is authoritative.
const svr = read('js/core/svr-manager.js');
assert.ok(/this\.brickSize = 64;/.test(svr), 'svr-manager brickSize = 64');
const worker = read('js/core/brick-decode-worker.js');
assert.ok(worker.includes('msg.brickSize || 64'), 'decode worker defaults brickSize to 64');

console.log('ELE-24 brickSize fallback unified to 64: OK');
