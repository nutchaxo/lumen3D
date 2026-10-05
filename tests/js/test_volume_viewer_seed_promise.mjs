// Structural test, successor of ELE-26 / BUG-005. The LOD seed loop
// (_seedTexturesFromActiveAsync) awaited one animation frame per four slices before
// an SVR stream could start, copying CPU data that sparse atlases never have — dead
// work that also hung in a hidden tab, where requestAnimationFrame does not run. It
// is gone: no stream may wait on an animation frame before its first brick request
// other than the single paint yield, and nothing awaits a seed promise any more.
// volume-viewer.js is not headless-loadable, so this is structural + `node --check`.
//
// Run: node tests/js/test_volume_viewer_seed_promise.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const src = readFileSync(path.join(ROOT, 'js/viewers/volume-viewer.js'), 'utf8');

assert.ok(!src.includes('function _seedTexturesFromActiveAsync'), 'the seed loop is removed');
assert.ok(!/new Promise\(resolve => \{\s*_seedTextures/.test(src), 'no stream awaits a seed promise');

const start = src.indexOf('async function loadBrickedVolumeStream');
assert.ok(start > 0, 'loadBrickedVolumeStream found');
const end = src.indexOf('BrickLoader.loadBrickTasks(', start);
assert.ok(end > start, 'the stream issues its brick batch');
const before = src.slice(start, end);
const frames = (before.match(/requestAnimationFrame/g) || []).length;
assert.equal(frames, 0, 'no animation frame is awaited before the first brick request (besides _yieldToPaint)');

console.log('seed loop removed: streams start without waiting on animation frames: OK');
