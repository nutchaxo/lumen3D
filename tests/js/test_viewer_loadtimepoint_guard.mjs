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

const start = src.indexOf('async function _loadTimepoint');
assert.ok(start > 0, '_loadTimepoint found');
const end = src.indexOf('\n  async function ', start + 1);
const body = src.slice(start, end > 0 ? end : undefined);

// helper present
assert.ok(body.includes('const _isStale = () => loadToken !== _activeLoadToken;'), '_isStale helper declared');
assert.ok(body.includes('const _bailStale ='), '_bailStale helper declared');

// every post-await resumption guards with a stale bail (>= 4 sites)
const bails = (body.match(/if \(_isStale\(\)\) \{ _bailStale\(\); return; \}/g) || []).length;
assert.ok(bails >= 4, `expected >= 4 stale bails, found ${bails}`);

// the manifest assignment inside the try is guarded
assert.ok(body.includes('if (!_isStale() && result && result.manifest)'),
  'try-block manifest assignment guarded by !_isStale()');

// the final manifest assignment is immediately preceded by a stale bail
const lastManifest = body.lastIndexOf('_brickManifest = result.manifest;');
assert.ok(lastManifest > 0, 'final manifest assignment found');
const precedingBail = body.lastIndexOf('if (_isStale()) { _bailStale(); return; }', lastManifest);
assert.ok(precedingBail > 0 && lastManifest - precedingBail < 140,
  'final manifest assignment must be preceded by a stale bail');

console.log('ELE-11 _loadTimepoint staleness guards: OK');
