// Structural test for ELE-28 / PERF-002: _updateClipCap must skip the per-triangle
// clip-cap rebuild when the plane spec + visible surface-mesh set are unchanged.
// tracking-viewer.js is not headless-loadable, so this is structural + `node --check`.
//
// Run: node tests/js/test_tracking_clipcap_memo.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const src = readFileSync(path.join(ROOT, 'js/viewers/tracking-viewer.js'), 'utf8');

assert.ok(src.includes('let _clipCapKey = null;'), '_clipCapKey declared');
assert.ok(/function _clipCapSignature\(meshes\)/.test(src), '_clipCapSignature defined');

// signature must capture the time-varying inputs (visible variant set + plane spec),
// not be collapsed to a constant (which would phantom-freeze the cap across scrub)
const sigStart = src.indexOf('function _clipCapSignature');
const sig = src.slice(sigStart, sigStart + 600);
assert.ok(sig.includes('surfaceVariant'), 'signature includes the visible-variant identity');
assert.ok(sig.includes('s.mode') && sig.includes('s.value'), 'signature includes plane spec');

// the cache-hit guard runs before the heavy per-triangle walk / plane build
const fnStart = src.indexOf('function _updateClipCap()');
const fn = src.slice(fnStart, fnStart + 900);
const guard = fn.indexOf('=== _clipCapKey');
const collect = fn.indexOf('_collectPlaneSegments(');
const build = fn.indexOf('_buildClipPlane()');
assert.ok(guard > 0, 'cache-hit guard present');
assert.ok(build > guard, 'guard runs before _buildClipPlane()');
if (collect > 0) assert.ok(collect > guard, 'guard runs before the per-triangle _collectPlaneSegments walk');

console.log('ELE-28 clip-cap memoization: OK');
