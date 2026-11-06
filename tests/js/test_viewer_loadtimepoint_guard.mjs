// Structural test for ELE-11 / RACE-002: _loadTimepoint must not apply side
// effects (_brickManifest, _qualityMode, quality select) from a stale load.
// viewer.js is a large page controller (depends on VolumeViewer/ChannelPanel/
// document/PluginRegistry at load) and cannot run headless without a browser,
// so the invariant is locked structurally. (Plus `node --check`.)
//
// Run: node tests/js/test_viewer_loadtimepoint_guard.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const src = readFileSync(path.join(ROOT, 'js/pages/viewer.js'), 'utf8');

// _loadTimepoint is a wrapper that holds playback around _loadTimepointInner, which
// carries the load itself (and its staleness guards).
assert.ok(/function _loadTimepoint\(basePath, t, opts = \{\}\) \{\s*_holdPlayback\(\);\s*return _loadTimepointInner\(/.test(src),
  '_loadTimepoint wraps _loadTimepointInner and holds playback');
const start = src.indexOf('async function _loadTimepointInner');
assert.ok(start > 0, '_loadTimepointInner found');
const end = src.indexOf('\n  async function ', start + 1);
const body = src.slice(start, end > 0 ? end : undefined);

// helper present
assert.ok(body.includes('const _isStale = () => loadToken !== _activeLoadToken;'), '_isStale helper declared');
assert.ok(body.includes('const _bailStale ='), '_bailStale helper declared');

// every post-await resumption guards with a stale bail (>= 4 sites)
const bails = (body.match(/if \(_isStale\(\)\) \{ _bailStale\(\); return; \}/g) || []).length;
assert.ok(bails >= 4, `expected >= 4 stale bails, found ${bails}`);

// the manifest (and the quality labels it refreshes) is applied once per load: a
// second copy inside the try refreshed the quality controls twice per timepoint
const assignments = (body.match(/_brickManifest = result\.manifest;/g) || []).length;
assert.equal(assignments, 1, `expected one manifest assignment per load, found ${assignments}`);

// that manifest assignment is immediately preceded by a stale bail
const lastManifest = body.lastIndexOf('_brickManifest = result.manifest;');
assert.ok(lastManifest > 0, 'manifest assignment found');
const precedingBail = body.lastIndexOf('if (_isStale()) { _bailStale(); return; }', lastManifest);
assert.ok(precedingBail > 0 && lastManifest - precedingBail < 140,
  'manifest assignment must be preceded by a stale bail');

console.log('ELE-11 _loadTimepoint staleness guards: OK');
