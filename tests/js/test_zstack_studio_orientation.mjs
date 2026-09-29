// The Z-stack browser's Studio figure is drawn the way the 3D view shows the stack.
//
// The browser lays the stack flat with setView('xy', { side: 'top', spin }): the
// sample's top face toward the camera (the −Z face, a mirror image, when the file is
// upside down), turned in-plane by the calibrated frame spin plus the Rotation
// slider. The Studio figure used to be the plane of the RAW voxel frame (image right
// = voxel +X, image up = voxel +Y, seen from +Z), so it came out rotated and/or
// mirrored against the screen. The contract checked here:
//   • VolumeViewer.getScreenFrameInVolume: the camera's right/up expressed in the
//     physically proportioned volume frame (checked against the cube's own inverse
//     world matrix, a rotated camera and a Z display stretch included), `toward`
//     normal to both, the pose in flight replaced by the pose it flies to;
//   • viewer.js _zstackStudioSpec over the REAL setView poses (frame spins, the
//     Rotation slider, both sample sides, anisotropic volumes, a display stretch):
//     the slicer's canvas → texture map equals the screen → texture map up to a
//     positive scale — same turn, same handedness — the plane sits at the slab
//     centre and samples exactly the slab's slices;
//   • a free 3D pose gets the flat pose nearest it (tr(Rᵀ·M) maximal among every
//     face × roll), the fallback without a frame is the former raw XY plane, and the
//     back face's normal stays a clean −Z for the native pass's axis test;
//   • _slicePixelSizeUm: square pixels of 2·EXTENT·maxP / renderRes µm on every
//     plane — the physical length the slicer's own geometry gives per pixel along
//     both canvas axes (XZ / YZ / non-square XY cuts were short by p_axis / maxP).
//
// Run: node tests/js/test_zstack_studio_orientation.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { loadModule, ROOT } from './harness.mjs';

const require = createRequire(import.meta.url);
const THREE = require('../../js/vendor/three.min.js');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const volumeSrc = read('js/viewers/volume-viewer.js');
const viewerSrc = read('js/pages/viewer.js');

function lift(src, name, file) {
  const m = src.match(new RegExp(`\\n  function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n  \\}\\n`));
  assert.ok(m, `${name} must be defined at module level in ${file}`);
  return m[0];
}

const VolumeSlicer = loadModule('js/viewers/volume-slicer.js', 'VolumeSlicer', { THREE, window: {} });
assert.ok(VolumeSlicer && typeof VolumeSlicer.planeGeometry === 'function', 'VolumeSlicer.planeGeometry');
const EXTENT_UNITS = VolumeSlicer.getPlaneExtentUnits();
assert.equal(EXTENT_UNITS, 1.5, 'the slicer draws 2·EXTENT = 1.5 quad units across its frame');

// ── The viewer's closure: cube, camera, poses, lifted from volume-viewer.js ─────
const view = new Function('THREE', `
  const cube = { quaternion: new THREE.Quaternion(), scale: new THREE.Vector3(1, 1, 1), parent: null,
                 position: new THREE.Vector3() };
  const camera = new THREE.PerspectiveCamera(45, 1.4, 0.1, 100);
  camera.position.set(0, 0, 3);
  let _rotationLocked = false;
  let _homeQuaternion = null;
  let _frameQuaternion = null;
  let _upsideDown = false;
  let _poseAnim = null;
  let _hasLoadedVolume = true;
  let _physical = null;
  const getPhysicalSize = () => _physical;
  const _notifyCameraChange = () => {};
  const _scheduleFrame = () => {};
  ${lift(volumeSrc, '_nearestZSpin', 'volume-viewer.js')}
  ${lift(volumeSrc, 'setFrameQuaternion', 'volume-viewer.js')}
  ${lift(volumeSrc, '_halfTurn', 'volume-viewer.js')}
  ${lift(volumeSrc, '_rawPoseQuaternion', 'volume-viewer.js')}
  ${lift(volumeSrc, 'setSampleUpsideDown', 'volume-viewer.js')}
  ${lift(volumeSrc, '_resolveViewSide', 'volume-viewer.js')}
  ${lift(volumeSrc, '_tiltToViewAxis', 'volume-viewer.js')}
  ${lift(volumeSrc, '_tiltPose', 'volume-viewer.js')}
  ${lift(volumeSrc, '_poseTo', 'volume-viewer.js')}
  ${lift(volumeSrc, '_stepPoseAnimation', 'volume-viewer.js')}
  ${lift(volumeSrc, 'setView', 'volume-viewer.js')}
  ${lift(volumeSrc, 'getScreenFrameInVolume', 'volume-viewer.js')}
  return {
    cube, camera, setView, setFrameQuaternion, setSampleUpsideDown, getScreenFrameInVolume,
    setPhysical: (p) => { _physical = p; },
    physical: () => _physical,
    anim: () => _poseAnim,
    step: (now) => _stepPoseAnimation(now),
  };
`)(THREE);

// ── The page's closure: the spec builder and the pixel size, lifted from viewer.js ─
let zDepth = 100;
let sliceRange = null;
let screenFrameApi = true;
const page = new Function('THREE', 'VolumeViewer', 'VolumeSlicer', 'env', `
  let _zstackCurrentSlice = 0;
  const _zstackGetDims = () => ({ z: env.z() });
  const _zstackModule = () => ({ impl: { getStudioSliceRange: () => env.range() } });
  ${lift(viewerSrc, '_zstackStudioSpec', 'viewer.js')}
  ${lift(viewerSrc, '_zstackFlatPose', 'viewer.js')}
  ${lift(viewerSrc, '_slicePixelSizeUm', 'viewer.js')}
  return { spec: _zstackStudioSpec, flatPose: _zstackFlatPose, pixel: _slicePixelSizeUm };
`)(
  THREE,
  {
    get getScreenFrameInVolume() { return screenFrameApi ? view.getScreenFrameInVolume : undefined; },
    getPhysicalSize: () => view.physical(),
  },
  VolumeSlicer,
  { z: () => zDepth, range: () => sliceRange },
);

const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg}: ${a} vs ${b}`);
const Rx = (t) => new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), t);
const Ry = (t) => new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), t);
const Rz = (t) => new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), t);
const deg = (d) => (d * Math.PI) / 180;

// Mirrors computePhysicalScale → _applyDisplayScale: the cube stretched to the
// physical proportions (reference = the longest of x and y), Z times the display scale.
function mountVolume(physical, zDisplayScale = 1) {
  view.setPhysical(physical);
  const ref = Math.max(physical.x, physical.y, 1);
  view.cube.scale.set(physical.x / ref, physical.y / ref, Math.max(0.01, physical.z / ref) * zDisplayScale);
}

// The texture displacement (uvw) of the voxel the 3D view shows `a` world units to
// the right and `b` up of the cube centre, on the screen-parallel plane through it:
// world W = a·camRight + b·camUp, local L = s⁻¹ ⊙ Qc⁻¹·W, uvw = L + ½ (both shaders).
function screenToTexture(a, b) {
  view.camera.updateMatrixWorld();
  const right = new THREE.Vector3().setFromMatrixColumn(view.camera.matrixWorld, 0).normalize();
  const up = new THREE.Vector3().setFromMatrixColumn(view.camera.matrixWorld, 1).normalize();
  const w = right.multiplyScalar(a).add(up.multiplyScalar(b));
  const cubeObj = new THREE.Object3D();
  cubeObj.quaternion.copy(view.anim() ? view.anim().to : view.cube.quaternion);
  cubeObj.scale.copy(view.cube.scale);
  cubeObj.updateMatrixWorld(true);
  return w.applyMatrix4(new THREE.Matrix4().copy(cubeObj.matrixWorld).invert());
}

// The slicer's canvas → texture map equals the screen's, up to one positive scale:
// the Studio figure is the picture on screen, same turn, same handedness.
function assertFigureMatchesScreen(spec, physical, label) {
  const g = VolumeSlicer.planeGeometry(spec, physical);
  const sr = screenToTexture(1, 0);
  const su = screenToTexture(0, 1);
  near(sr.z, 0, 1e-9, `${label}: the screen's right lies in the slice plane`);
  near(su.z, 0, 1e-9, `${label}: the screen's up lies in the slice plane`);
  near(g.right.z, 0, 1e-9, `${label}: the canvas right lies in the slice plane`);
  near(g.up.z, 0, 1e-9, `${label}: the canvas up lies in the slice plane`);
  const k = Math.hypot(g.right.x, g.right.y) / Math.hypot(sr.x, sr.y);
  assert.ok(k > 0 && Number.isFinite(k), `${label}: scale`);
  near(g.right.x, k * sr.x, 1e-9, `${label}: canvas right x`);
  near(g.right.y, k * sr.y, 1e-9, `${label}: canvas right y`);
  near(g.up.x, k * su.x, 1e-9, `${label}: canvas up x (same scale: no stretch)`);
  near(g.up.y, k * su.y, 1e-9, `${label}: canvas up y (same scale: no stretch)`);
  return g;
}

// The slab's sample depths (texture z) as the slicer's shader computes them.
function sampleDepths(g) {
  const half = (g.steps - 1) * g.delta * 0.5;
  const out = [];
  for (let i = 0; i < g.steps; i++) out.push(g.center.z + (-half + i * g.delta) * (g.steps > 1 ? g.step.z : 0));
  return out.sort((a, b) => a - b);
}

// ── 1. getScreenFrameInVolume against the cube's own inverse world matrix ─────
{
  mountVolume({ x: 1137, y: 820, z: 310 }, 1.6);
  const P = view.physical();
  const maxP = Math.max(P.x, P.y, P.z);
  const toP = (L) => new THREE.Vector3(L.x * P.x / maxP, L.y * P.y / maxP, L.z * P.z / maxP);
  const poses = [
    new THREE.Quaternion(),
    Rz(0.8),
    Rz(-2.1).multiply(Ry(Math.PI)),
    Rx(-Math.PI / 6).multiply(Ry(Math.PI / 5)),
    new THREE.Quaternion(0.31, -0.52, 0.17, 0.77).normalize(),
  ];
  const cameraSpins = [new THREE.Quaternion(), Rz(deg(30)), Rx(deg(10)).multiply(Ry(deg(-15)))];
  for (const q of poses) {
    for (const cq of cameraSpins) {
      view.cube.quaternion.copy(q);
      view.camera.quaternion.copy(cq);
      const f = view.getScreenFrameInVolume();
      const r = toP(screenToTexture(1, 0)).normalize();
      const u = toP(screenToTexture(0, 1)).normalize();
      near(f.right.distanceTo(r), 0, 1e-9, 'right = the P direction of the screen right');
      near(f.up.distanceTo(u), 0, 1e-9, 'up = the P direction of the screen up');
      near(f.toward.dot(f.right), 0, 1e-9, 'toward is normal to the screen plane (right)');
      near(f.toward.dot(f.up), 0, 1e-9, 'toward is normal to the screen plane (up)');
      assert.ok(f.toward.dot(new THREE.Vector3().crossVectors(f.right, f.up)) > 0, 'toward faces the camera');
      assert.equal(f.settling, false);
    }
  }
  view.camera.quaternion.identity();
}

// ── 2. The browser's flat poses: the figure is the screen ─────────────────────
{
  const volumes = [
    { physical: { x: 1137, y: 1137, z: 696 }, zds: 1 },
    { physical: { x: 1200, y: 640, z: 250 }, zds: 1 },
    { physical: { x: 500, y: 900, z: 1300 }, zds: 1.8 },
  ];
  const frames = [null, Rz(0.7), Rz(-1.9).multiply(Rx(0.35)).multiply(Ry(-0.2))];
  const spins = [undefined, 'tilt', 0, 37, 90, 180, 271.5];
  const slabs = [{ lo: 40, hi: 40 }, { lo: 40, hi: 44 }, { lo: 10, hi: 89 }, { lo: 0, hi: 99 }];
  let checked = 0;
  for (const { physical, zds } of volumes) {
    mountVolume(physical, zds);
    for (const frame of frames) {
      view.setFrameQuaternion(frame);
      for (const upsideDown of [false, true]) {
        view.setSampleUpsideDown(upsideDown);
        for (const spin of spins) {
          // Start from an arbitrary 3D pose so 'tilt' has something to lay flat.
          view.cube.quaternion.copy(Rx(-0.5).multiply(Ry(0.6)).multiply(Rz(0.2)));
          view.setView('xy', { side: 'top', spin, force: true });
          for (const range of slabs) {
            sliceRange = range;
            zDepth = 100;
            const spec = page.spec();
            const label = `p=${JSON.stringify(physical)} zds=${zds} frame=${frame ? 'set' : 'none'} upsideDown=${upsideDown} spin=${spin} slab=${range.lo}-${range.hi}`;
            assert.equal(spec.mode, 'oblique', `${label}: an oblique plane carries the turn`);
            assert.equal(spec.pitch, 0, `${label}: pitch 0`);
            assert.equal(spec.yaw, upsideDown ? 180 : 0, `${label}: the top face is the −Z one when the file is upside down`);
            const g = assertFigureMatchesScreen(spec, physical, label);
            const n = range.hi - range.lo + 1;
            near(g.center.z, (range.lo + n / 2) / zDepth, 1e-12, `${label}: the plane sits at the slab centre`);
            assert.equal(g.steps, n, `${label}: one sample per slice`);
            assert.equal(spec.projection, n > 1 ? 'mip' : 'single', `${label}: projection`);
            const expected = Array.from({ length: n }, (_, k) => (range.lo + 0.5 + k) / zDepth);
            const got = n > 1 ? sampleDepths(g) : [g.center.z];
            got.forEach((d, k) => near(d, expected[k], 1e-12, `${label}: sample ${k} lands on its slice centre`));
            // The canvas handedness: a mirror image exactly when the −Z face is shown.
            const det = g.right.x * g.up.y - g.right.y * g.up.x;
            assert.ok(upsideDown ? det < 0 : det > 0, `${label}: mirrored iff the back face is shown`);
            checked++;
          }
        }
      }
    }
  }
  assert.equal(checked, 3 * 3 * 2 * 7 * 4);
  view.setFrameQuaternion(null);
  view.setSampleUpsideDown(false);
}

// ── 3. The Rotation slider turns the figure with the screen ───────────────────
{
  mountVolume({ x: 1000, y: 800, z: 400 });
  sliceRange = { lo: 20, hi: 20 };
  view.setView('xy', { side: 'front', spin: 0, force: true });
  const r0 = page.spec().roll;
  for (const s of [15, 90, 200, 359]) {
    view.setView('xy', { side: 'front', spin: s, force: true });
    const d = ((page.spec().roll - r0) % 360 + 360) % 360;
    // The pose Rz(θ) puts the screen's right on (cos θ, −sin θ, 0): the figure turns by −θ.
    near(Math.min(Math.abs(d - (360 - s) % 360), 360 - Math.abs(d - (360 - s) % 360)), 0, 1e-9, `slider ${s}°: roll follows`);
  }
}

// ── 4. A pose in flight: the figure is the pose it settles on ─────────────────
{
  mountVolume({ x: 1137, y: 900, z: 500 });
  view.setSampleUpsideDown(true);
  sliceRange = { lo: 30, hi: 34 };
  view.setView('xy', { side: 'top', spin: 64, force: true });
  const settled = page.spec();
  view.cube.quaternion.copy(Rx(0.9).multiply(Ry(-0.4)));
  view.setView('xy', { side: 'top', spin: 64, animate: 1500, force: true });
  assert.ok(view.anim(), 'the pose is in flight');
  assert.equal(view.getScreenFrameInVolume().settling, true);
  const mid = page.spec();
  assert.equal(mid.yaw, settled.yaw);
  near(mid.roll, settled.roll, 1e-9, 'mid-flight roll = the settled one');
  near(mid.value, settled.value, 1e-12, 'mid-flight depth = the settled one');
  view.step(Number.MAX_SAFE_INTEGER);
  assert.equal(view.anim(), null);
  view.setSampleUpsideDown(false);
}

// ── 5. A free 3D pose: the nearest flat pose ──────────────────────────────────
{
  mountVolume({ x: 1137, y: 700, z: 420 }, 1.3);
  sliceRange = { lo: 5, hi: 60 };
  const rot = (spec) => VolumeSlicer.planeGeometry(spec, { x: 1, y: 1, z: 1 });
  const trace = (g, M) => g.right.dot(M.r) + g.up.dot(M.u) + g.normal.dot(M.n);
  let seed = 7;
  const rand = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  for (let i = 0; i < 40; i++) {
    const q = new THREE.Quaternion(rand() - 0.5, rand() - 0.5, rand() - 0.5, rand() - 0.5).normalize();
    view.cube.quaternion.copy(q);
    const f = view.getScreenFrameInVolume();
    const M = { r: f.right, u: f.up, n: new THREE.Vector3().crossVectors(f.right, f.up).normalize() };
    const spec = page.spec();
    const best = trace(rot(spec), M);
    for (const yaw of [0, 180]) {
      for (let roll = 0; roll < 360; roll += 0.25) {
        const cand = trace(rot({ mode: 'oblique', yaw, pitch: 0, roll }), M);
        assert.ok(cand <= best + 1e-9, `pose ${i}: yaw ${yaw} roll ${roll} would be nearer the screen (${cand} > ${best})`);
      }
    }
  }
  // A small tilt away from a flat pose keeps that pose's face and nearly its roll.
  view.cube.quaternion.copy(Rz(deg(40)).multiply(Rx(deg(8))));
  let spec = page.spec();
  assert.equal(spec.yaw, 0);
  near(spec.roll, -40, 1.5, 'tilted front pose: roll ≈ −40°');
  view.cube.quaternion.copy(Rz(deg(40)).multiply(Ry(Math.PI)).multiply(Rx(deg(8))));
  spec = page.spec();
  assert.equal(spec.yaw, 180);
  near(spec.roll, -40, 1.5, 'tilted back pose: roll ≈ −40°');
}

// ── 6. Fallbacks and the native pass's axis test ──────────────────────────────
{
  mountVolume({ x: 1137, y: 1137, z: 696 });
  sliceRange = { lo: 12, hi: 16 };
  zDepth = 50;
  screenFrameApi = false;
  const raw = page.spec();
  screenFrameApi = true;
  assert.deepEqual([raw.yaw, raw.pitch, raw.roll], [0, 0, 0], 'no screen frame: the raw voxel frame');
  const gRaw = VolumeSlicer.planeGeometry(raw, view.physical());
  const gXy = VolumeSlicer.planeGeometry({ ...raw, mode: 'xy' }, view.physical());
  for (const k of ['right', 'up', 'center', 'normal']) near(gRaw[k].distanceTo(gXy[k]), 0, 1e-12, `raw fallback = the former XY plane (${k})`);
  assert.deepEqual(page.flatPose(null), { back: false, roll: 0 });
  assert.deepEqual(page.flatPose({ right: { x: NaN, y: 0, z: 0 }, up: { x: 0, y: 1, z: 0 } }), { back: false, roll: 0 });

  // The back face: the normal is −Z to the last bit the native pass tests (|n.z| > 0.999999).
  view.setSampleUpsideDown(true);
  view.setView('xy', { side: 'top', spin: 123.4, force: true });
  const back = page.spec();
  const g = VolumeSlicer.planeGeometry(back, view.physical());
  assert.ok(Math.abs(g.normal.z) > 0.999999 && Math.abs(g.normal.x) < 1e-12 && Math.abs(g.normal.y) < 1e-12, `back normal is a clean ±Z (got ${g.normal.toArray()})`);
  near(g.center.z, (12 + 5 / 2) / 50, 1e-12, 'back face: plane at the slab centre');
  near(g.halfThickness, 4 / 2 / 50, 1e-12, 'back face: the slab spans its slices');
  assert.ok(back.value >= 0 && back.value <= 1, 'value stays in the slicer range');
  view.setSampleUpsideDown(false);
  zDepth = 100;
}

// ── 7. Square pixels of 2·EXTENT·maxP / renderRes on every plane ──────────────
{
  const physical = { x: 1137, y: 600, z: 250 };
  mountVolume(physical);
  const maxP = 1137;
  const R = 1706;
  const specs = [
    { mode: 'xy', value: 0.5 },
    { mode: 'xz', value: 0.5 },
    { mode: 'yz', value: 0.5 },
    { mode: 'oblique', value: 0.4, yaw: 30, pitch: 20, roll: 10 },
    { mode: 'oblique', value: 0.6, yaw: 180, pitch: 0, roll: 77 },
  ];
  for (const spec of specs) {
    const px = page.pixel(spec, R);
    near(px.x, (EXTENT_UNITS * maxP) / R, 1e-12, `${spec.mode}: µm/px`);
    assert.equal(px.x, px.y, `${spec.mode}: square pixels`);
    // The slicer's own geometry: a pixel is EXTENT_UNITS / R quad units, a quad unit
    // along the canvas axis is the texture step g.right / g.up, and a texture unit
    // along axis i is p_i µm.
    const g = VolumeSlicer.planeGeometry(spec, physical);
    const um = (v) => Math.hypot(v.x * physical.x, v.y * physical.y, v.z * physical.z) * EXTENT_UNITS / R;
    near(um(g.right), px.x, 1e-9, `${spec.mode}: one pixel along the canvas right`);
    near(um(g.up), px.y, 1e-9, `${spec.mode}: one pixel along the canvas up`);
  }
  view.setPhysical(null);
  near(page.pixel({ mode: 'xy' }, 300).x, 1.5 / 300, 1e-15, 'no calibration: axes count as 1');
  view.setPhysical({ x: 0, y: 40, z: -3 });
  near(page.pixel({ mode: 'xz' }, 400).y, (1.5 * 40) / 400, 1e-15, 'a non-positive axis counts as 1, as in planeGeometry');
}

console.log('zstack Studio figure follows the screen (face, turn, slab) + square slice pixels: OK');
