// Structural test for ELE-26 / BUG-005: the seed (_seedTexturesFromActiveAsync)
// must resolve its Promise on the abort branch too, otherwise
// loadBrickedVolumeStream's `await new Promise(resolve => seed(..., resolve))`
// hangs forever on a mid-seed dataset switch. volume-viewer.js is not
// headless-loadable, so this is structural + `node --check`.
//
// Run: node tests/js/test_volume_viewer_seed_promise.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const src = readFileSync(path.join(ROOT, 'js/viewers/volume-viewer.js'), 'utf8');

const fnStart = src.indexOf('function _seedTexturesFromActiveAsync');
assert.ok(fnStart > 0, '_seedTexturesFromActiveAsync found');
const fn = src.slice(fnStart, fnStart + 3000);

// the abort guard must now call onDone() and no longer be a bare silent return
const guard = 'if (abortRef.cancelled || loadId !== _loadCounter) {';
const gi = fn.indexOf(guard);
assert.ok(gi > 0, 'abort guard present in the seed loop');
const seg = fn.slice(gi, gi + 420);
assert.ok(seg.includes('onDone()'), 'abort branch resolves the Promise (onDone())');
assert.ok(!seg.includes('return; // Abort silently'), 'bare silent return removed');

// onDone() is invoked on all exits (early-return, abort, completion) => >= 3
const onDoneCalls = (fn.match(/onDone\(\)/g) || []).length;
assert.ok(onDoneCalls >= 3, `seed resolves on every exit (found ${onDoneCalls} onDone() calls)`);

console.log('ELE-26 seed Promise resolves on abort: OK');
