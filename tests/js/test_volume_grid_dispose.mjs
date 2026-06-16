// Unit test for ELE-30 / LEAK-001: VolumeGrid._disposeGroup must free per-instance
// GPU resources (geometries, materials, sprite CanvasTexture maps) of a removed
// group, WITHOUT disposing THREE.ArrowHelper's line/cone geometry — a module-level
// singleton in three r0.167 shared by every ArrowHelper.
//
// Run: node tests/js/test_volume_grid_dispose.mjs
import assert from 'node:assert/strict';
import { loadModule } from './harness.mjs';

const VolumeGrid = loadModule('js/viewers/volume-grid.js', 'VolumeGrid', {
  THREE: { Vector3: function () {} }, window: {}, document: {},
});
assert.equal(typeof VolumeGrid._disposeGroup, 'function', '_disposeGroup exposed');

// Build a fake group graph with its own traverse(): one normal mesh, an
// ArrowHelper whose line/cone SHARE a singleton geometry, and a sprite with a map.
function spy() { const f = (...a) => { f.calls++; }; f.calls = 0; return f; }

const sharedArrowGeom = { dispose: spy() };            // the dangerous singleton
const meshGeom = { dispose: spy() };
const meshMat = { dispose: spy() };
const arrowLineMat = { dispose: spy() };
const arrowConeMat = { dispose: spy() };
const spriteMap = { dispose: spy() };
const spriteMat = { dispose: spy(), map: spriteMap };

const arrow = { type: 'ArrowHelper' };
const nodes = [
  { type: 'Mesh', geometry: meshGeom, material: meshMat, parent: null },
  { type: 'Line', geometry: sharedArrowGeom, material: arrowLineMat, parent: arrow },
  { type: 'Mesh', geometry: sharedArrowGeom, material: arrowConeMat, parent: arrow },
  { type: 'Sprite', geometry: undefined, material: spriteMat, parent: null },
];
const group = { traverse: (cb) => nodes.forEach(cb) };

VolumeGrid._disposeGroup(group);

assert.equal(meshGeom.dispose.calls, 1, 'normal mesh geometry disposed');
assert.equal(meshMat.dispose.calls, 1, 'normal mesh material disposed');
assert.equal(arrowLineMat.dispose.calls, 1, 'arrow line material disposed (per-instance)');
assert.equal(arrowConeMat.dispose.calls, 1, 'arrow cone material disposed (per-instance)');
assert.equal(spriteMat.dispose.calls, 1, 'sprite material disposed');
assert.equal(spriteMap.dispose.calls, 1, 'sprite CanvasTexture map disposed (the live leak)');
assert.equal(sharedArrowGeom.dispose.calls, 0, 'ArrowHelper SHARED geometry must NOT be disposed');

assert.equal(typeof VolumeGrid.dispose, 'function', 'public dispose() exposed');

console.log('ELE-30 VolumeGrid dispose (ArrowHelper-safe): OK');
