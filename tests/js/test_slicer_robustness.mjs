// Unit tests for the slicer robustness + dead-code batch:
//   EDGE-009 oblique quaternion / plane normal accepted NaN/Infinity angles
//   EDGE-034 setPlaneSpec accepted unbounded value (offset plane outside [0,1])
//            and `value || 0.5` rewrote a legitimate 0
//   EDGE-035 _syncUniforms divided by a 0 physical dimension (Infinity/NaN uniforms)
//   DEAD-017 dead `volumeScale` uniform (declared + wired, never used in GLSL)
//   DEAD-031 stale header comment ("DataTexture3D" — render goes through the SVR atlas)
//
// volume-slicer.js
// touches THREE/DOM at load -> structural read-asserts.
//
// Run: node tests/js/test_slicer_robustness.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadModule } from './harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// ── Structural: slicer sanitize / guard / dead-code ──
{
  const src = readFileSync(path.join(ROOT, 'js/viewers/volume-slicer.js'), 'utf8');
  const sps = src.slice(src.indexOf('function setPlaneSpec'), src.indexOf('function setPlaneSpec') + 800);
  assert.ok(/yaw['"]?, ['"]pitch['"]?, ['"]roll/.test(sps) || /'yaw', 'pitch', 'roll'/.test(sps), 'EDGE-009: setPlaneSpec sanitizes yaw/pitch/roll');
  assert.ok(/Number\.isFinite/.test(sps), 'EDGE-009/034: setPlaneSpec uses finiteness checks');
  assert.ok(/Math\.min\(1, Math\.max\(0,/.test(sps), 'EDGE-034: value clamped to [0,1]');
  assert.ok(!/spec\.value \|\| 0\.5/.test(src), 'EDGE-034: `value || 0.5` (drops legitimate 0) removed');

  assert.ok(/physical\.x > 0 \? physical\.x : 1/.test(src), 'EDGE-035: zero physical dimension guarded');

  assert.ok(!/volumeScale/.test(src), 'DEAD-017: dead volumeScale uniform fully removed (GLSL + JS)');
  assert.ok(!/DataTexture3D/.test(src), 'DEAD-031: stale DataTexture3D comment updated');
  assert.ok(/SVR atlas/.test(src), 'DEAD-031: header now describes the SVR atlas path');
}

console.log('slicer robustness (EDGE-009/034/035, DEAD-017/031): OK');
