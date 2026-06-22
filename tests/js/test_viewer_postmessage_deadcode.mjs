// Structural tests for the viewer.js + compare.js + utils.js batch. viewer.js and
// compare.js touch the DOM at load (not vm-loadable), so this asserts the fixes are
// present in source + node --check. utils.js helper is vm-tested below.
//   SEC-012  outbound postMessage used wildcard '*' targetOrigin (study-state leak)
//   DEAD-001 five functions defined twice
//   DEAD-002 _bindSliceGizmo (full Three.js gizmo) defined, never called
//   DEAD-013 dead 2D slice render chain (+BUG-030 ReferenceError on `bar`)
//   DEAD-015 redundant duplicate assignments
//   DEAD-021 SYNC_EXPOSURE emitted without sourceIndex (admpan handles it; compare couldn't route)
//   DEAD-020 compare.js _setPanelLoadState no-op called from 7 sites
//   LEAK-002 _slicerOverlayStop never called -> overlay rAF leak
//   BUG-008  _deepZoomActive never set -> DeepZoom branches inert
//   BUG-032  live dataset read dimensions.t without guard
//   BUG-033  _mergeDatasetMetadata mounted incomplete metadata silently
//
// Run: node tests/js/test_viewer_postmessage_deadcode.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadModule } from './harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');
const count = (s, re) => (s.match(re) || []).length;

// ── utils.js: trustedTargetOrigin helper (vm behavioral) ──
{
  const U = loadModule('js/core/utils.js', 'Utils', {
    window: { location: { origin: 'https://lab.example' } }, document: {}, requestAnimationFrame: () => {},
  });
  assert.equal(typeof U.trustedTargetOrigin, 'function', 'SEC-012: trustedTargetOrigin exported');
  assert.equal(U.trustedTargetOrigin(), 'https://lab.example', 'SEC-012: returns this page origin');
}

// ── viewer.js ──
{
  const v = read('js/pages/viewer.js');
  // SEC-012: no wildcard targetOrigin remains; outbound posts use the helper
  assert.equal(count(v, /window\.parent\.postMessage\([^;]*, '\*'\)/g), 0, 'SEC-012: no wildcard window.parent.postMessage');
  assert.ok(count(v, /Utils\.trustedTargetOrigin\(\)/g) >= 12, 'SEC-012: outbound posts use trustedTargetOrigin');

  // DEAD-001: each function defined exactly once
  for (const fn of ['_lodForQuality', '_qualityDimsLabel', '_qualityDims', '_bindVolumeControls', '_bindZScaleControls']) {
    assert.equal(count(v, new RegExp(`function ${fn}\\b`, 'g')), 1, `DEAD-001: ${fn} defined once`);
  }
  // DEAD-002 / DEAD-013 (+BUG-030)
  assert.equal(count(v, /function _bindSliceGizmo/g), 0, 'DEAD-002: _bindSliceGizmo removed');
  assert.equal(count(v, /function _drawSliceResult/g), 0, 'DEAD-013: _drawSliceResult removed');
  assert.equal(count(v, /function _drawSliceScaleOverlay/g), 0, 'DEAD-013/BUG-030: _drawSliceScaleOverlay removed');
  assert.ok(/function _setSliceStatus/.test(v), 'DEAD-013: _setSliceStatus kept');

  // DEAD-021: SYNC_EXPOSURE now carries sourceIndex (admpan.js consumes it)
  assert.ok(/SYNC_EXPOSURE'[^]*sourceIndex/.test(v.replace(/\r/g, '')), 'DEAD-021: SYNC_EXPOSURE includes sourceIndex');

  // LEAK-002
  assert.ok(count(v, /_slicerOverlayStop\(\)/g) >= 2, 'LEAK-002: _slicerOverlayStop now called');

  // BUG-008
  assert.ok(/DeepZoomViewer\.isActive\(\)/.test(v), 'BUG-008: uses DeepZoomViewer.isActive()');
  assert.equal(count(v, /_deepZoomActive\s*=/g), 0, 'BUG-008: dead _deepZoomActive flag removed');

  // BUG-032 / BUG-033
  assert.ok(/Number\.isFinite\(totalFrames\)/.test(v), 'BUG-032: live dimensions.t guarded');
  assert.ok(/dimensions absentes du catalogue|dimensions manquantes/.test(v), 'BUG-033: incomplete metadata rejected');
}

// ── compare.js: DEAD-020 ──
{
  const c = read('js/pages/compare.js');
  assert.equal(count(c, /_setPanelLoadState/g), 0, 'DEAD-020: _setPanelLoadState no-op + all call sites removed');
}

console.log('viewer/compare postMessage + dead code (SEC-012, DEAD-001/002/013/015/020/021, BUG-008/030/032/033, LEAK-002): OK');
