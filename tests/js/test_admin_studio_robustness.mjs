// Structural tests for the admin/studio batch (admpan.js + studio-editor.js touch
// the DOM at load → structural + node --check):
//   BUG-057  saveDataset/saveThumbnail fired rebuild_catalog fire-and-forget
//   EDGE-018 orientation quaternion stored without validation/normalization
//   EDGE-019 imported studio JSON layers mounted without numeric bounds checks
//   DEAD-038 OPACITY_LEVELS defined but never read
//
// Run: node tests/js/test_admin_studio_robustness.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');

// ── admin datasets tab (was admpan.js before the v1.4.0 SPA refactor) ──
{
  const s = read('js/pages/admin/tab-datasets.js');
  // BUG-057: both rebuild_catalog calls in save paths are awaited + checked
  assert.equal((s.match(/await apiFetch\(`\$\{API_DATASETS\}\?action=rebuild_catalog`/g) || []).length, 3,
    'BUG-057: rebuild_catalog awaited in saveDataset + saveThumbnail (+ manual rebuild)');
  assert.ok(!/^\s*apiFetch\(`\$\{API_DATASETS\}\?action=rebuild_catalog`/m.test(s),
    'BUG-057: no un-awaited fire-and-forget rebuild_catalog remains');
  // EDGE-018: orientation quaternion validated + normalized before storing
  assert.ok(/ORIENTATION_RESULT/.test(s) && /Math\.hypot\(a\[0\], a\[1\], a\[2\], a\[3\]\)/.test(s),
    'EDGE-018: quaternion length computed for normalization');
  assert.ok(/a\.every\(Number\.isFinite\)/.test(s), 'EDGE-018: quaternion finiteness checked');
  assert.ok(!/_draft\.orientation = e\.data\.quaternion;/.test(s), 'EDGE-018: raw unchecked assignment removed');
}

// ── studio-editor.js ──
{
  const s = read('js/components/studio-editor.js');
  assert.ok(!/OPACITY_LEVELS/.test(s), 'DEAD-038: unused OPACITY_LEVELS removed');
  // EDGE-019: numeric geometry sanitized in _migrateLayer (reusing _clamp/_clamp01)
  const fn = s.slice(s.indexOf('function _migrateLayer'), s.indexOf('function _migrateLayer') + 1600);
  assert.ok(/Number\.isFinite\(Number\(v\)\)/.test(fn), 'EDGE-019: numeric coercion helper in _migrateLayer');
  assert.ok(/layer\.style\.opacity = _clamp01\(/.test(fn), 'EDGE-019: opacity clamped (reuses _clamp01)');
  assert.ok(/layer\.style\.strokeWidth = _clamp\(/.test(fn), 'EDGE-019: strokeWidth clamped (reuses _clamp)');
  assert.ok(/Number\.isFinite\(Number\(p\.x\)\)/.test(fn), 'EDGE-019: polyline points validated');
}

console.log('admin/studio robustness (BUG-057, EDGE-018/019, DEAD-038): OK');
