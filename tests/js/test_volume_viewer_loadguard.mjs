// Structural test for ELE-10 / RACE-001: in VolumeViewer.loadVolume (slices path),
// a staleness guard (loadId !== _loadCounter) must run BEFORE the entry is published
// (_activateVolumeEntry) and BEFORE GPU uploads in the per-slice finally.
//
// volume-viewer.js is a large IIFE that references THREE at load and exposes no
// testable seam for loadVolume, so it cannot be loaded headless without a browser.
// This locks the invariant by inspecting the source. (Plus `node --check`.)
//
// Run: node tests/js/test_volume_viewer_loadguard.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const src = readFileSync(path.join(ROOT, 'js/viewers/volume-viewer.js'), 'utf8');

const start = src.indexOf('const loadId = ++_loadCounter;');
assert.ok(start > 0, 'loadVolume token (loadId = ++_loadCounter) found');

// 1) a guard must precede the first _activateVolumeEntry(entry, ...) publication
const firstPublish = src.indexOf('_activateVolumeEntry(entry,', start);
assert.ok(firstPublish > start, '_activateVolumeEntry(entry, ...) found');
const guardBeforePublish = src.indexOf('loadId !== _loadCounter', start);
assert.ok(guardBeforePublish > start && guardBeforePublish < firstPublish,
  'a "loadId !== _loadCounter" guard must run before the entry is published');

// 2) the per-slice finally must gate GPU uploads behind a stale check
const staleGate = src.indexOf('const stale = loadId !== _loadCounter', start);
const uploadIdx = src.indexOf('textures.forEach(t => { t.needsUpdate', start);
assert.ok(uploadIdx > start, 'GPU upload line found');
assert.ok(staleGate > start && staleGate < uploadIdx,
  'a "const stale = loadId !== _loadCounter" gate must precede the GPU upload');
assert.ok(src.indexOf('if (!stale)', staleGate) < uploadIdx && src.indexOf('if (!stale)', staleGate) > staleGate,
  'GPU upload must be wrapped in "if (!stale)"');

console.log('ELE-10 volume-viewer loadVolume staleness guards: OK');
