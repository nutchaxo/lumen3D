// Structural test for ELE-29 / PERF-003: _updateSurfaceColor must short-circuit
// (memo) before its O(vertices x cells) recompute when no coloring input changed,
// and every input mutator must invalidate the memo. tracking-viewer.js is not
// headless-loadable, so this is structural + `node --check`.
//
// Run: node tests/js/test_tracking_surface_memo.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const src = readFileSync(path.join(ROOT, 'js/viewers/tracking-viewer.js'), 'utf8');

assert.ok(src.includes('let _surfaceColorSig = null;'), '_surfaceColorSig declared');
assert.ok(src.includes('let _regionRevision = 0;'), '_regionRevision declared');

const fnStart = src.indexOf('function _updateSurfaceColor()');
const fn = src.slice(fnStart, fnStart + 1400);
const guard = fn.indexOf('if (_sig === _surfaceColorSig) return;');
const heavy = fn.indexOf('_scene.updateMatrixWorld(true)');
const traverse = fn.indexOf('.traverse');
assert.ok(guard > 0, 'memo guard present in _updateSurfaceColor');
assert.ok(heavy > guard, 'memo guard runs before updateMatrixWorld (heavy)');
if (traverse > 0) assert.ok(traverse > guard, 'memo guard runs before the scene traverse');

// the signature tracks the real time-varying inputs (not collapsed to mode only)
assert.ok(fn.includes('_surfaceFrameValue(_currentTime)') && fn.includes('_regionRevision'),
  'signature includes quantized frame + region revision');

// invalidation on every mutator + on palette rebuild
assert.ok((src.match(/_surfaceColorSig = null;/g) || []).length >= 3, 'memo invalidated by >= 3 mutators');
assert.ok(src.includes('_regionRevision++'), 'region palette rebuild bumps the revision');

console.log('ELE-29 surface-color memoization: OK');
