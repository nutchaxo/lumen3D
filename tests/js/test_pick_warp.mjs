// The depth pick on a stabilised timelapse. The display box holds every frame's box
// carried into the stabilised frame, so it reaches past the acquisition box by the
// drift of the series, and the voxels of the frame on screen live in that frame's own
// texture (volumeWarp · object), not in the display frame.
//   • a point in the drift margin keeps its position (normalized past 1, physicalUm
//     past the acquisition size) instead of being pinned to the acquisition box face;
//   • a box hit is confined to the display box, an unwarped one to the unit box;
//   • `acquisition` = volumeWarp · object, null where the frame on screen has no voxel;
//   • DataAccess.screenToVoxel reads the voxel in the frame's texture (the drifted
//     position, not the display one) and answers null in the drift margin;
//   • pickVolumePoint's bounding-box fallback intersects the display box under warp.
// setStabilizationSpace / _rebuildCubeGeometry / setTimepointTransform / _pickResult
// are lifted from volume-viewer.js and run against the real three.js.
//
// Run: node tests/js/test_pick_warp.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT, loadModule } from './harness.mjs';

const require = createRequire(import.meta.url);
const THREE = require('../../js/vendor/three.min.js');
const VV = readFileSync(path.join(ROOT, 'js/viewers/volume-viewer.js'), 'utf8').replace(/\r\n/g, '\n');
const lift = (name) => {
  const m = VV.match(new RegExp(`\\n  (?:async )?function ${name}\\((?:[^()]|\\([^()]*\\))*\\) \\{[\\s\\S]*?\\n  \\}\\n`));
  assert.ok(m, `${name} must be defined at module level in volume-viewer.js`);
  return m[0];
};

const U = new Function('THREE', `
  let _acqExtent = null, _displayBox = null, _warpActive = false;
  let _cutPlaneMesh = null, _transitionMaterial = null;
  const VolumeGrid = undefined;
  const cube = { geometry: { dispose() {} }, userData: {} };
  const material = {
    defines: {},
    uniforms: {
      volumeWarp: { value: new THREE.Matrix4().makeTranslation(0.5, 0.5, 0.5) },
      clipBoxMin: { value: new THREE.Vector3(-0.5, -0.5, -0.5) },
      clipBoxSize: { value: new THREE.Vector3(1, 1, 1) }
    }
  };
  function _clearTransitionVolume() {}
  function _syncCutPlaneToOrbit() {}
  function _scheduleFrame() {}
  ${lift('_objectFromUm')}
  ${lift('setStabilizationSpace')}
  ${lift('_rebuildCubeGeometry')}
  ${lift('setTimepointTransform')}
  ${lift('_pickResult')}
  const warp = () => (material.defines.VOLUME_WARP
    ? { matrix: material.uniforms.volumeWarp.value, boxMin: material.uniforms.clipBoxMin.value, boxSize: material.uniforms.clipBoxSize.value }
    : null);
  return { setStabilizationSpace, setTimepointTransform, _pickResult, warp, material };
`)(THREE);

const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;
const ACQ = { x: 1000, y: 800, z: 400 };
const physical = { ...ACQ };

// Acquisition box [0, 1000] × [0, 800] × [0, 400] µm; over the series the specimen
// drifts so that the stabilised frame needs [0, 1100] in X. At the late timepoint on
// screen, raw µm + 100 = stabilised µm (the matrix maps raw → stabilised).
U.setStabilizationSpace({ min: [0, 0, 0], max: [ACQ.x, ACQ.y, ACQ.z] }, { min: [0, 0, 0], max: [1100, ACQ.y, ACQ.z] });
const raw2stab = new THREE.Matrix4().makeTranslation(100, 0, 0).toArray();
assert.equal(U.setTimepointTransform(raw2stab), true, 'the warp is on');
const warp = U.warp();
assert.ok(warp && near(warp.boxSize.x, 1.1) && near(warp.boxMin.x, -0.5), 'display box: 1.1 acquisition widths from −½');

// ── a structure in the drift margin keeps its place ─────────────────────────
{
  // Stabilised x = 1050 µm (object 0.55): raw 950 µm, inside this frame's data.
  const r = U._pickResult(new THREE.Vector3(0.55, 0, 0), 'volume', physical, warp);
  assert.ok(near(r.normalized.x, 1.05), `normalized past the acquisition box (${r.normalized.x})`);
  assert.ok(near(r.physicalUm.x, 1050), 'physicalUm in the stabilised frame, not pinned to 1000');
  assert.ok(r.acquisition && near(r.acquisition.x, 0.95) && near(r.acquisition.y, 0.5) && near(r.acquisition.z, 0.5),
    'acquisition = volumeWarp · object');
  assert.ok(near(r.acquisitionUm.x, 950), 'acquisitionUm in the frame the voxels are stored in');
  const tex = new THREE.Vector3(0.55, 0, 0).applyMatrix4(warp.matrix);
  assert.ok(near(tex.x, r.acquisition.x) && near(tex.y, r.acquisition.y) && near(tex.z, r.acquisition.z), 'same as the shader\'s toTexture');
  console.log('drift margin point kept, acquisition through the warp: OK');
}

// ── where the frame on screen holds no voxel ────────────────────────────────
{
  // Stabilised x = 50 µm: raw −50 µm, outside this frame's acquisition box.
  const r = U._pickResult(new THREE.Vector3(-0.45, 0, 0), 'bounding-box', physical, warp);
  assert.ok(near(r.normalized.x, 0.05), 'still a point of the display box');
  assert.equal(r.acquisition, null, 'no voxel of this timepoint there');
  assert.equal(r.acquisitionUm, null);
  console.log('no data under the point: acquisition null: OK');
}

// ── confinement ──────────────────────────────────────────────────────────────
{
  const w = U._pickResult(new THREE.Vector3(0.7, 0.9, -0.8), 'bounding-box', physical, warp);
  assert.ok(near(w.normalized.x, 1.1) && near(w.normalized.y, 1) && near(w.normalized.z, 0), 'warped: confined to the display box');
  const u = U._pickResult(new THREE.Vector3(0.7, 0, 0), 'volume', physical, null);
  assert.ok(near(u.normalized.x, 1) && near(u.acquisition.x, 1), 'unwarped: confined to the unit box, acquisition = normalized');
  const p = U._pickResult(new THREE.Vector3(0.8, 0, 0), 'projection', physical, null);
  assert.ok(near(p.normalized.x, 1.3), 'a projection wall keeps its own position');
  assert.equal(p.acquisition, null, 'and holds no voxel outside the volume');
  const face = U._pickResult(new THREE.Vector3(0.5 + 1e-9, 0, 0), 'volume', physical, null);
  assert.ok(face.acquisition && face.acquisition.x === 1, 'a face hit is inside, clamped to 1');
  assert.equal(U._pickResult(new THREE.Vector3(0, 0, 0), 'volume', null, null).physicalUm, null, 'no calibration: no µm');
  console.log('confinement: OK');
}

// ── DataAccess.screenToVoxel reads the frame's own voxel ────────────────────
{
  const DIMS = { x: 500, y: 400, z: 100 };
  let hit = null;
  const DataAccess = loadModule('js/core/data-access.js', 'DataAccess', {
    BrickLoader: {
      isReady: () => true,
      getLevelInfo: (k) => (k === 0 ? { dims: { ...DIMS }, voxelSize: { x: ACQ.x / DIMS.x, y: ACQ.y / DIMS.y, z: ACQ.z / DIMS.z } } : null)
    },
    VolumeViewer: { pickVolumePoint: () => hit }
  });
  hit = { ...U._pickResult(new THREE.Vector3(0.55, 0.1, -0.2), 'volume', physical, warp), depthSource: 'volume', onBoundingBox: false };
  const v = DataAccess.screenToVoxel(1, 1);
  assert.equal(v.voxel.x, Math.floor(0.95 * DIMS.x), `stored voxel at raw 950 µm (got ${v.voxel.x}), not at the display 1050 µm`);
  assert.equal(v.voxel.y, Math.floor(0.6 * DIMS.y));
  assert.equal(v.voxel.z, Math.floor(0.3 * DIMS.z));
  assert.ok(near(v.um.x, 950) && near(v.um.y, 480) && near(v.um.z, 120), 'um in the acquisition frame');
  assert.equal(v.depthSource, 'volume');

  hit = { ...U._pickResult(new THREE.Vector3(-0.45, 0, 0), 'volume', physical, warp), depthSource: 'volume', onBoundingBox: false };
  assert.equal(DataAccess.screenToVoxel(1, 1), null, 'drift margin: no voxel of this frame, not the edge voxel');
  hit = null;
  assert.equal(DataAccess.screenToVoxel(1, 1), null, 'nothing picked');
  console.log('screenToVoxel in the frame the voxels live in: OK');
}

// ── wiring of pickVolumePoint ────────────────────────────────────────────────
{
  const pick = lift('pickVolumePoint');
  assert.ok(/material\?\.defines\?\.VOLUME_WARP/.test(pick), 'the warp is read from the volume material');
  assert.ok(/new THREE\.Box3\(warp\.boxMin\.clone\(\), warp\.boxMin\.clone\(\)\.add\(warp\.boxSize\)\)/.test(pick),
    'the bounding-box fallback intersects the display box under warp');
  assert.ok(/_pickResult\(local, source, getPhysicalSize\(\), warp\)/.test(pick), 'frames built by _pickResult');
  assert.ok(!/Math\.min\(1, local\.x \+ 0\.5\)/.test(pick), 'no clamp to the acquisition box left');
  console.log('pickVolumePoint wiring: OK');
}

console.log('stabilised pick frames: OK');
