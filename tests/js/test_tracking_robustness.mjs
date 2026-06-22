// Structural tests for the tracking robustness batch (timeline.js, tracking.js,
// tracking-viewer.js all touch DOM/THREE at load → structural + node --check):
//   BUG-052  density legend used hardcoded _globalDensityStats, not real stats
//   EDGE-016 timeline frame count hardcoded to 10, not derived from data
//   EDGE-040 timeline init didn't coerce totalFrames/speed/smooth numerics
//   LEAK-007 InstancedMesh / GLB scene not disposed on reload
//   LEAK-008 legend re-added a document click listener without detaching (mode switch)
//   PERF-025 timeline play() used setInterval instead of rAF
//   DEAD-036 duplicate dataset-subtitle assignment (tracking.js)
//
// Run: node tests/js/test_tracking_robustness.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');

// ── timeline.js: EDGE-040 + PERF-025 ──
{
  const s = read('js/components/timeline.js');
  assert.ok(/Number\.isFinite\(tf\)/.test(s), 'EDGE-040: totalFrames coerced via Number.isFinite');
  assert.ok(/speedValue = Number\.isFinite/.test(s) && /smoothValue = Number\.isFinite/.test(s), 'EDGE-040: speed/smooth coerced');
  assert.ok(/requestAnimationFrame\(tick\)/.test(s), 'PERF-025: play() uses requestAnimationFrame');
  assert.ok(/cancelAnimationFrame\(_playTimer\)/.test(s), 'PERF-025: pause() cancels the rAF');
  assert.ok(!/window\.setInterval\(/.test(s) && !/clearInterval\(/.test(s), 'PERF-025: setInterval/clearInterval calls removed');
}

// ── tracking.js: DEAD-036 + EDGE-016 + LEAK-008 ──
{
  const s = read('js/pages/tracking.js');
  assert.equal((s.match(/getElementById\('dataset-subtitle'\)\.textContent =/g) || []).length, 1, 'DEAD-036: single dataset-subtitle assignment');
  assert.ok(/TrackingViewer\.getFrameCount/.test(s), 'EDGE-016: frame count derived from TrackingViewer.getFrameCount');
  assert.ok(!/dimensions\?\.t \|\| 10/.test(s), 'EDGE-016: hardcoded "|| 10" frame fallback removed');
  // LEAK-008: the detach happens before the early returns (top of function), not only inside if(btn)
  const fn = s.slice(s.indexOf('function _renderTrackingLegend'), s.indexOf('function _renderTrackingLegend') + 900);
  const detachIdx = fn.indexOf("removeEventListener('click', node._outsideClickListener)");
  const branchIdx = fn.indexOf('getLegendState');
  assert.ok(detachIdx > 0 && detachIdx < branchIdx, 'LEAK-008: outside-click listener detached before the legend-mode branches (incl. the uniform early return)');
}

// ── tracking-viewer.js: BUG-052 + EDGE-016 + LEAK-007 ──
{
  const s = read('js/viewers/tracking-viewer.js');
  assert.ok(/const stats = allValues\.length \? _densityStats\(allValues\) : _globalDensityStats/.test(s),
    'BUG-052: density stats computed from real values');
  assert.ok(/function getFrameCount/.test(s) && /getFrameCount,/.test(s), 'EDGE-016: getFrameCount defined + exported');
  // LEAK-007: instanced mesh + glb scene disposed on reload
  assert.ok(/_cellMesh\.geometry\?\.dispose\?\.\(\)/.test(s) && /_cellMesh\.dispose\?\.\(\)/.test(s), 'LEAK-007: InstancedMesh disposed');
  assert.ok(/_glbScene\.traverse\(\(c\) =>/.test(s), 'LEAK-007: old GLB scene geometries/materials disposed on reload');
}

console.log('tracking robustness (BUG-052, EDGE-016/040, LEAK-007/008, PERF-025, DEAD-036): OK');
