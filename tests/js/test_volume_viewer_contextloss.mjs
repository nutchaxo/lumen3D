// Structural test for ELE-18 / EDGE-001: VolumeViewer must handle WebGL context
// loss gracefully (Rule 1.1) — preventDefault, stop the render loop, surface a
// visible status — instead of drawing on a dead context. volume-viewer.js is a
// large IIFE that references THREE at load, so the invariant is locked
// structurally. (Plus `node --check` on both files.)
//
// Run: node tests/js/test_volume_viewer_contextloss.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const vv = readFileSync(path.join(ROOT, 'js/viewers/volume-viewer.js'), 'utf8');
const viewer = readFileSync(path.join(ROOT, 'js/pages/viewer.js'), 'utf8');

// listeners registered with preventDefault
assert.ok(vv.includes("addEventListener('webglcontextlost'"), 'webglcontextlost listener registered');
assert.ok(vv.includes("addEventListener('webglcontextrestored'"), 'webglcontextrestored listener registered');
const lost = vv.indexOf("addEventListener('webglcontextlost'");
const lostBody = vv.slice(lost, lost + 600);
assert.ok(lostBody.includes('e.preventDefault()'), 'context-lost handler calls preventDefault (required for restore)');
assert.ok(lostBody.includes('_contextLost = true'), 'context-lost sets the flag');
assert.ok(/cancelAnimationFrame|animationId = null/.test(lostBody), 'context-lost stops the render loop');

// render loop is gated by the flag
assert.ok(vv.includes('if (_contextLost) { animationId = null; return; }'), '_animate bails while context lost');
assert.ok(vv.includes('!animationId && renderer && !_contextLost'), '_scheduleFrame gated by !_contextLost');

// hooks exposed
assert.ok(/onContextLost,\s*\n\s*onContextRestored,/.test(vv) || (vv.includes('onContextLost,') && vv.includes('onContextRestored,')),
  'onContextLost/onContextRestored exported');
assert.ok(vv.includes('function onContextLost(callback)') && vv.includes('function onContextRestored(callback)'),
  'hook setters defined');

// viewer.js wires the hooks to a visible status channel (_setQualityStatus)
assert.ok(viewer.includes('VolumeViewer.onContextLost?.(') && viewer.includes('VolumeViewer.onContextRestored?.('),
  'viewer.js wires both context hooks');
const wireIdx = viewer.indexOf('VolumeViewer.onContextLost?.(');
assert.ok(viewer.slice(wireIdx, wireIdx + 200).includes('_setQualityStatus'),
  'context-lost hook surfaces a visible status via _setQualityStatus');

console.log('ELE-18 WebGL context-loss handling: OK');
