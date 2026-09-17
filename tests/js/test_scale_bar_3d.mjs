// Unit tests for the 3D scale bar (web v1.55.4): the bar of `#viewer-scale-bar` is a
// 1-2-5 length in real µm read at the depth of the specimen centre, not a fixed
// "200 µm" over one grid cell whatever the dataset.
//   • Utils.niceScaleLength / Utils.formatMicrons (behavioural);
//   • VolumeGrid._updateScaleBar lifted out of the source and run against the real
//     three.js: known camera / viewport / calibration → known label and width,
//     panning keeps the scale (depth along the view axis), zooming rescales it,
//     no calibration or no grid → hidden;
//   • the staged slice's bar shares the helpers and the calibration rule (structural).
//
// Run: node tests/js/test_scale_bar_3d.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { loadModule, ROOT } from './harness.mjs';

const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r/g, '');
const Utils = loadModule('js/core/utils.js', 'Utils', {
  window: { location: { origin: 'https://lab.example' } }, document: {}, requestAnimationFrame: () => {},
});

// ── helpers ──────────────────────────────────────────────────────────────────
assert.equal(Utils.niceScaleLength(900.58), 500);
assert.equal(Utils.niceScaleLength(450.3), 200);
assert.equal(Utils.niceScaleLength(160), 100);
assert.equal(Utils.niceScaleLength(2), 2);
assert.equal(Utils.niceScaleLength(0.37), 0.2, 'sub-micron targets snap too, without float noise');
assert.equal(Utils.niceScaleLength(0), 0);
assert.equal(Utils.niceScaleLength(NaN), 0);
assert.equal(Utils.formatMicrons(500), '500 µm');
assert.equal(Utils.formatMicrons(2000), '2 mm');
assert.equal(Utils.formatMicrons(1500), '1.5 mm');
assert.equal(Utils.formatMicrons(0.5), '0.5 µm');
assert.equal(Utils.formatMicrons(NaN), '—');

// ── VolumeGrid._updateScaleBar against the real three.js ─────────────────────
const require = createRequire(import.meta.url);
const THREE = require('../../js/vendor/three.min.js');
const src = read('js/viewers/volume-grid.js');
const lift = (name) => {
  const m = src.match(new RegExp(`\\n  function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n  \\}\\n`));
  assert.ok(m, `${name} must be defined at module level in volume-grid.js`);
  return m[0];
};
const bar = { classes: new Set(['hidden']), style: {}, textContent: '' };
bar.classList = { add: (c) => bar.classes.add(c), remove: (c) => bar.classes.delete(c) };
const document = { getElementById: (id) => (id === 'viewer-scale-bar' ? bar : null) };
const rect = { width: 800, height: 600 };
const camera = new THREE.PerspectiveCamera(45, rect.width / rect.height, 0.1, 100);
camera.position.set(0, 0, 2.5);
camera.lookAt(0, 0, 0);
camera.updateMatrixWorld();
const cube = { position: new THREE.Vector3(0, 0, 0), scale: new THREE.Vector3(1, 1, 0.323) };
let physical = { x: 1630.656774, y: 1630.656774, z: 527.05, calibrationStatus: 'estimated', mode: 'estimated' };
let gridMode = 1;
const H = new Function('THREE', 'document', 'Utils', 'env', `
  const _scaleDir = new THREE.Vector3();
  const _scaleRel = new THREE.Vector3();
  let _camera = env.camera, _renderer = env.renderer, _cube = env.cube;
  let _gridMode = 1;
  let _getPhysicalSize = () => env.physical();
  ${lift('_updateScaleBar')}
  return { update: _updateScaleBar, setGridMode: (m) => { _gridMode = m; } };
`)(THREE, document, Utils, {
  camera, cube,
  renderer: { domElement: { getBoundingClientRect: () => rect } },
  physical: () => physical,
});
const hidden = () => bar.classes.has('hidden');
const widthPx = () => Number(String(bar.style.width).replace('px', ''));

// Camera at 2.5 with a 45° fov: 2·tan(22.5°)·2.5 = 2.0711 world units span the 600 px
// height → 289.7 px per unit; one unit is 1630.66 µm → 0.17766 px/µm. A fifth of the
// 800 px width (160 px) is 900.6 µm → 500 µm → 88.8 px.
H.update();
assert.ok(!hidden(), 'shown with the grid and a calibration');
assert.equal(bar.textContent, '500 µm');
assert.equal(widthPx(), 89);

// Panning the specimen sideways changes its distance but not its depth: same bar.
cube.position.set(0.4, 0.3, 0);
H.update();
assert.equal(widthPx(), 89, 'depth is measured along the view axis');
assert.equal(bar.textContent, '500 µm');
cube.position.set(0, 0, 0);

// Zooming in (camera at 1.25) doubles the pixels per µm: 450 µm target → 200 µm → 71 px.
camera.position.set(0, 0, 1.25);
camera.updateMatrixWorld();
H.update();
assert.equal(bar.textContent, '200 µm');
assert.equal(widthPx(), 71);
camera.position.set(0, 0, 2.5);
camera.updateMatrixWorld();

// A wider specimen: the cube is normalised to the longer of X and Y, so the same
// world unit means more µm and the bar shrinks in pixels for the same label.
physical = { x: 3261.3, y: 1630.66, z: 527, calibrationStatus: 'exact', mode: 'physical' };
H.update();
assert.equal(bar.textContent, '1 mm', 'label in mm past 1000 µm');
assert.equal(widthPx(), 89, '1 mm of a 3261 µm-wide specimen spans the same 89 px as 500 µm of a 1631 µm one');

// The display Z override never touches the bar: it reads the X axis.
cube.scale.set(1, 0.5, 0.646);
H.update();
assert.equal(bar.textContent, '1 mm');

// No calibration: a bar in µm would be a voxel count — hidden.
physical = { x: 512, y: 512, z: 128, calibrationStatus: 'metadata-missing', mode: 'metadata-missing' };
H.update();
assert.ok(hidden(), 'hidden without calibration');
physical = { x: 1630.656774, y: 1630.656774, z: 527.05, calibrationStatus: 'estimated', mode: 'estimated' };
H.update();
assert.ok(!hidden());

// No grid: hidden, as before.
H.setGridMode(0);
H.update();
assert.ok(hidden(), 'hidden with the grid off');

// ── Structural ───────────────────────────────────────────────────────────────
assert.ok(/\n  function syncTransforms\(\) \{[\s\S]*?_updateScaleBar\(\);/.test(src), 'syncTransforms refreshes the bar every frame');
assert.ok(!/200 µm/.test(src), 'no fixed label left');
assert.ok(/_getPhysicalSize = typeof deps\.getPhysicalSize === 'function'/.test(src), 'the calibration is an injected dependency');
const vv = read('js/viewers/volume-viewer.js');
assert.ok(/VolumeGrid\.init\(\{[\s\S]*?getPhysicalSize\s*\n\s*\}\)/.test(vv), 'VolumeViewer hands its calibration to the grid');
const viewer = read('js/pages/viewer.js');
const stage = viewer.slice(viewer.indexOf('function _updateSliceStageScale'), viewer.indexOf('function _updateSliceStageScale') + 1800);
assert.ok(/Utils\.niceScaleLength\(/.test(stage) && /Utils\.formatMicrons\(/.test(stage), 'the staged slice bar shares the helpers');
assert.ok(/calibrationStatus !== 'metadata-missing'/.test(stage), 'and hides without calibration');

console.log('3D scale bar (1-2-5 in real µm at the specimen depth, hidden without calibration): OK');
