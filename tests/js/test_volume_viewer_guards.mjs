// Structural tests for the volume-viewer.js guards + dead-code batch. volume-viewer.js
// touches THREE/DOM at load (not vm-loadable), so this asserts the fixes are present in
// source + `node --check`. Edit specs were produced by a parallel workflow and applied
// verbatim; this is the integration guard.
//   BUG-006 implicit global _draggedLabelSprite -> declared
//   BUG-007 _renderMeasurements crashed on absent item.distance -> guarded
//   EDGE-026 channel color parseInt without hex validation -> NaN uniform
//   EDGE-027 loadVolume allocated before validating dims (Rule 1.4)
//   PERF-004 new THREE.Raycaster() per pointer event -> reuse module _raycaster
//   PERF-020 hover raycast on axes/grid even when off -> gated
//   BUG-027 setView/resetView ignored _rotationLocked
//   BUG-029 setCameraState applied quaternion without finiteness/normalization
//   BUG-038 roll ignored in orthogonal plane modes
//   DEAD-027 dead dims.gridSize branch in _orderBricksForStreaming
//   DEAD-029 dead sync _seedTexturesFromActive + _intersectGizmo removed
//   DEAD-030 duplicate _raycaster.setFromCamera in pickVolumePoint
//   LEAK-023 seed rAF not tracked/cancellable
//   BUG-011 onBrickError not wired -> dropped bricks never surfaced
//
// Run: node tests/js/test_volume_viewer_guards.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const s = readFileSync(path.join(ROOT, 'js/viewers/volume-viewer.js'), 'utf8');
const count = (re) => (s.match(re) || []).length;

// BUG-006
assert.equal(count(/let _draggedLabelSprite = null;/g), 1, 'BUG-006: _draggedLabelSprite declared exactly once');

// BUG-007
assert.ok(/Number\.isFinite\(item\.distance\)/.test(s), 'BUG-007: measurement distance guarded');
assert.ok(!/\$\{item\.distance\.toFixed/.test(s), 'BUG-007: unguarded item.distance.toFixed removed');

// EDGE-026
assert.ok(/\[0-9a-fA-F\]\{6\}/.test(s), 'EDGE-026: channel color validated against 6-digit hex');

// EDGE-027
assert.ok(/Invalid volume dimensions/.test(s), 'EDGE-027: dims validated before allocation');

// PERF-004 (only the module-level Raycaster remains)
assert.equal(count(/new THREE\.Raycaster\(\)/g), 1, 'PERF-004: single shared Raycaster instance');

// PERF-020
assert.ok(/isAxesVisible\(\)[^\n]*getGridMode\(\)|getGridMode\(\)[^\n]*isAxesVisible\(\)/.test(s),
  'PERF-020: axes/grid hover raycast gated on visibility');

// BUG-027
assert.ok(/_rotationLocked/.test(s) && /if \(!cube\) return;/.test(s), 'BUG-027: rotation-lock + cube null-guard in setView');

// BUG-029
assert.ok(/lengthSq\(\) > 1e-8/.test(s) && /\.every\(Number\.isFinite\)/.test(s),
  'BUG-029: setCameraState validates + normalizes quaternion');

// BUG-038
assert.ok(/setFromAxisAngle\(new THREE\.Vector3\(0, 0, 1\)/.test(s), 'BUG-038: roll applied about plane normal in ortho modes');

// DEAD-027 (no dims.gridSize fallback; the only gridSize left is the manifest read)
assert.ok(!/dims\.gridSize/.test(s), 'DEAD-027: dead dims.gridSize branch removed');

// DEAD-029
assert.equal(count(/function _intersectGizmo/g), 0, 'DEAD-029: dead _intersectGizmo removed');
assert.equal(count(/function _seedTexturesFromActive\(/g), 0, 'DEAD-029: dead sync _seedTexturesFromActive removed');
assert.ok(/_seedTexturesFromActiveAsync/.test(s), 'DEAD-029: live async seed variant kept');

// DEAD-030 (no two consecutive identical setFromCamera lines)
assert.ok(!/_raycaster\.setFromCamera\(_pointer, camera\);\s*\r?\n\s*_raycaster\.setFromCamera\(_pointer, camera\);/.test(s),
  'DEAD-030: duplicate setFromCamera removed');

// LEAK-023
assert.ok(/_seedRafId/.test(s) && /cancelAnimationFrame\(_seedRafId\)/.test(s), 'LEAK-023: seed rAF tracked + cancellable');

// BUG-011
assert.ok(/onBrickError/.test(s) && /failedBricks/.test(s), 'BUG-011: onBrickError wired, failures surfaced');

console.log('volume-viewer guards + dead code (14 findings): OK');
