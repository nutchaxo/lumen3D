// Geometry contract of VolumeViewer.setView() in a calibrated frame.
//
// The z-stack browser locks the view top-down with setView('xy'). That view must
// look down the VOXEL Z axis (it shows acquisition planes) but the spin about the
// viewing axis is free — and it used to be reset to the raw orientation of the
// file, throwing away the calibration the operator defined (metadata.orientation,
// registered through setFrameQuaternion). The contract checked here:
//   • no frame ⇒ exactly the former poses (identity / Rx(π/2) / Ry(−π/2));
//   • a frame that is a pure spin about Z is honoured verbatim in the xy view;
//   • a tilted frame ⇒ the xy view is still a spin about Z, and it is the NEAREST
//     such spin to the frame (no other angle is closer);
//   • xz / yz keep looking down their voxel axis, spin chosen the same way;
//   • a degenerate frame (half-turn about an XY-plane axis) falls back to identity;
//   • the rotation lock still wins (BUG-027).
//
// volume-viewer.js touches THREE/DOM at load, so the two functions are lifted out
// of the source text and run against the real three.js.
//
// Run: node tests/js/test_view_frame_spin.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const THREE = require('../../js/vendor/three.min.js');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const src = readFileSync(path.join(ROOT, 'js/viewers/volume-viewer.js'), 'utf8').replace(/\r\n/g, '\n');

function lift(name) {
  const m = src.match(new RegExp(`\\n  function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n  \\}\\n`));
  assert.ok(m, `${name} must be defined at module level in volume-viewer.js`);
  return m[0];
}

// Rebuild the closure the functions live in: the cube, the two registered poses
// and the rotation lock, with the camera-change notifier as a no-op.
const harness = new Function('THREE', `
  let cube = { quaternion: new THREE.Quaternion(),
               rotateX(a) { this.quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1,0,0), a)); },
               rotateY(a) { this.quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,1,0), a)); } };
  let _rotationLocked = false;
  let _homeQuaternion = null;
  let _frameQuaternion = null;
  let _upsideDown = false;
  let _poseAnim = null;
  let _hasLoadedVolume = false;
  let notified = 0;
  const _notifyCameraChange = () => { notified++; };
  const _scheduleFrame = () => {};
  ${lift('_nearestZSpin')}
  ${lift('setFrameQuaternion')}
  ${lift('_halfTurnX')}
  ${lift('_rawPoseQuaternion')}
  ${lift('setSampleUpsideDown')}
  ${lift('isSampleUpsideDown')}
  ${lift('_resolveViewSide')}
  ${lift('_poseTo')}
  ${lift('_stepPoseAnimation')}
  ${lift('setView')}
  return {
    cube, setView, setFrameQuaternion, setSampleUpsideDown, isSampleUpsideDown,
    rawPose: () => _rawPoseQuaternion(),
    step: (now) => _stepPoseAnimation(now),
    anim: () => _poseAnim,
    notified: () => notified,
    frame: () => _frameQuaternion,
    loaded: (v) => { _hasLoadedVolume = v; },
    lock: (v) => { _rotationLocked = v; },
    home: (q) => { _homeQuaternion = q; },
  };
`)(THREE);

const { cube, setView, setFrameQuaternion } = harness;
const same = (a, b, msg) => assert.ok(Math.abs(Math.abs(a.dot(b)) - 1) < 1e-9, `${msg} (got ${a.toArray().map((v) => v.toFixed(4))})`);
const Rz = (t) => new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), t);
const Rx = (t) => new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), t);
const Ry = (t) => new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), t);
const RAW = { xy: new THREE.Quaternion(), xz: Rx(Math.PI / 2), yz: Ry(-Math.PI / 2) };
// The voxel axis each view looks along: after the pose, it must lie on world ±Z.
const LOOKS_ALONG = { xy: new THREE.Vector3(0, 0, 1), xz: new THREE.Vector3(0, 1, 0), yz: new THREE.Vector3(1, 0, 0) };

// ── 1. No frame: the historical poses, bit for bit ───────────────────────────
setFrameQuaternion(null);
for (const view of ['xy', 'xz', 'yz']) {
  cube.quaternion.set(0.3, 0.4, 0.5, 0.7).normalize();
  setView(view);
  same(cube.quaternion, RAW[view], `${view} without a frame is the raw voxel-axis pose`);
}

// ── 2. A pure spin about Z is honoured verbatim ──────────────────────────────
{
  const spin = Rz(0.7);
  setFrameQuaternion(spin);
  cube.quaternion.identity();
  setView('xy');
  same(cube.quaternion, spin, 'xy view adopts an in-plane calibration exactly');
}

// ── 3. A tilted frame: still top-down, nearest spin ──────────────────────────
function assertNearestSpin(view, frame) {
  setFrameQuaternion(frame);
  cube.quaternion.set(0.1, -0.2, 0.3, 0.9).normalize();
  setView(view);
  const q = cube.quaternion.clone();
  const axis = LOOKS_ALONG[view].clone().applyQuaternion(q);
  assert.ok(Math.abs(Math.abs(axis.z) - 1) < 1e-9, `${view}: the voxel axis must still lie on the viewing axis (got ${axis.toArray()})`);
  // Nearest: sweep every spin about Z applied on top of the raw view pose — none
  // may sit closer to the frame than the one chosen.
  const best = Math.abs(q.dot(frame));
  for (let t = 0; t < 2 * Math.PI; t += 0.01) {
    const cand = Rz(t).multiply(RAW[view]);
    assert.ok(Math.abs(cand.dot(frame)) <= best + 1e-9, `${view}: spin ${t.toFixed(2)} would be closer to the frame`);
  }
}
const tilted = Rz(0.7).multiply(Rx(0.35)).multiply(Ry(-0.2));
for (const view of ['xy', 'xz', 'yz']) assertNearestSpin(view, tilted);
// The in-plane component is the one the operator sees: a frame with a 40° spin and
// a 20° tilt must give a 40° spin, not something dragged toward the tilt.
{
  setFrameQuaternion(Rz(0.7).multiply(Rx(0.35)));
  setView('xy');
  same(cube.quaternion, Rz(0.7), 'xy view keeps the in-plane spin of a tilted frame');
}

// ── 4. Degenerate frame: no in-plane component ⇒ raw ─────────────────────────
{
  setFrameQuaternion(Ry(Math.PI));       // (0, 1, 0, 0): z = w = 0
  cube.quaternion.set(0.3, 0.4, 0.5, 0.7).normalize();
  setView('xy');
  same(cube.quaternion, RAW.xy, 'a half-turn about Y carries no spin: identity, not NaN');
  assert.ok([cube.quaternion.x, cube.quaternion.y, cube.quaternion.z, cube.quaternion.w].every(Number.isFinite));
}

// ── 5. Garbage frames are ignored, the lock wins ─────────────────────────────
{
  setFrameQuaternion(Rz(0.5));
  setFrameQuaternion([0, 0, 0, 0]);       // zero-length: keep the previous frame
  setFrameQuaternion({ x: 1, y: 'x', z: 0, w: 0 });
  cube.quaternion.identity();
  setView('xy');
  same(cube.quaternion, Rz(0.5), 'an invalid frame does not replace a valid one');

  harness.lock(true);
  const before = Rz(1.1).multiply(Rx(0.4));
  cube.quaternion.copy(before);
  setView('xy');
  same(cube.quaternion, before, 'rotation lock: setView leaves the pose alone');
  harness.lock(false);
}

// ── 6. The back side: same voxel axis, looked at from the opposite face ──────
// The z-stack browser asks for it: seen from +Z the specimens were mirrored with
// respect to the acquisition. Screen-up must survive (a half-turn about the vertical,
// not about the horizontal), and with a frame the nearest-spin rule still applies.
{
  setFrameQuaternion(null);
  cube.quaternion.set(0.3, 0.4, 0.5, 0.7).normalize();
  setView('xy', { side: 'back' });
  same(cube.quaternion, Ry(Math.PI), 'xy from the back without a frame is a half-turn about Y');
  const z = new THREE.Vector3(0, 0, 1).applyQuaternion(cube.quaternion);
  const y = new THREE.Vector3(0, 1, 0).applyQuaternion(cube.quaternion);
  const x = new THREE.Vector3(1, 0, 0).applyQuaternion(cube.quaternion);
  assert.ok(Math.abs(z.z + 1) < 1e-9, 'the −Z face looks at the camera');
  assert.ok(Math.abs(y.y - 1) < 1e-9, 'screen-up is kept');
  assert.ok(Math.abs(x.x + 1) < 1e-9, 'left and right are mirrored, as when turning the sample over');

  // With a frame: the back pose is the front pose turned over about the vertical —
  // same in-plane spin, seen from behind. (Re-choosing the spin against the frame
  // from behind would be meaningless: a half-turn about an in-plane axis has no Z
  // component, so every back pose is equally far from a front-facing frame.)
  for (const view of ['xy', 'xz', 'yz']) {
    setFrameQuaternion(tilted);
    setView(view);
    const front = cube.quaternion.clone();
    setView(view, { side: 'back' });
    const back = cube.quaternion.clone();
    same(back, Ry(Math.PI).multiply(front), `${view}: back = front turned over about world Y`);
    const axis = LOOKS_ALONG[view].clone().applyQuaternion(back);
    const frontAxis = LOOKS_ALONG[view].clone().applyQuaternion(front);
    assert.ok(Math.abs(axis.z + frontAxis.z) < 1e-9 && Math.abs(Math.abs(axis.z) - 1) < 1e-9,
      `${view}: the opposite face looks at the camera`);
    // Screen-up names the same voxel direction from both sides.
    const upFront = new THREE.Vector3(0, 1, 0).applyQuaternion(front.clone().invert());
    const upBack = new THREE.Vector3(0, 1, 0).applyQuaternion(back.clone().invert());
    assert.ok(upFront.distanceTo(upBack) < 1e-9, `${view}: screen-up is the same voxel direction from both sides`);
  }
  // A pure Z calibration seen from behind: anterior still up, mirrored.
  setFrameQuaternion(Rz(0.7));
  setView('xy', { side: 'back' });
  same(cube.quaternion, Ry(Math.PI).multiply(Rz(0.7)), 'back view keeps the in-plane calibration');
  // An unknown side is the front.
  setView('xy', { side: 'sideways' });
  same(cube.quaternion, Rz(0.7), 'an unknown side means the front');
  setFrameQuaternion(null);
}

// ── 7. The 3D view is the home pose when one is registered ───────────────────
{
  const home = Rz(0.3).multiply(Rx(-0.5));
  harness.home(home);
  setView('3d');
  same(cube.quaternion, home, '3d view returns to the registered home pose');
  harness.home(null);
  setView('3d');
  const legacy = new THREE.Quaternion().multiply(Rx(-Math.PI / 6)).multiply(Ry(Math.PI / 5));
  same(cube.quaternion, legacy, '3d view without a home is the historical tilt');
}

// ── 8. Sample side: 'top' / 'bottom' follow the upside-down flag ─────────────
{
  setFrameQuaternion(null);
  harness.setSampleUpsideDown(false);
  cube.quaternion.set(0.3, 0.4, 0.5, 0.7).normalize();
  setView('xy', { side: 'top' });
  same(cube.quaternion, RAW.xy, 'right side up: the top face is +Z, the front pose');
  setView('xy', { side: 'bottom' });
  same(cube.quaternion, Ry(Math.PI), 'right side up: the bottom face is the back pose');
  harness.setSampleUpsideDown(true);
  setView('xy', { side: 'top' });
  same(cube.quaternion, Ry(Math.PI), 'upside down: the top face is −Z, the back pose');
  setView('xy', { side: 'bottom' });
  same(cube.quaternion, RAW.xy, 'upside down: the bottom face is the front pose');
  assert.equal(harness.isSampleUpsideDown(), true);
  same(harness.rawPose(), Rx(Math.PI), 'the raw pose of an upside-down file is a half-turn about X');
  harness.setSampleUpsideDown(false);
  same(harness.rawPose(), new THREE.Quaternion(), 'and the identity otherwise');
}

// ── 9. spin 'nearest': the smallest move from the current pose ───────────────
{
  setFrameQuaternion(tilted);
  for (const side of ['front', 'back']) {
    setView('xy', { side, spin: 'frame' });
    const Q0 = cube.quaternion.clone();
    // Start somewhere: the top-down pose spun by 100°, then tilted a little.
    const start = Rz(THREE.MathUtils.degToRad(100)).multiply(Q0).premultiply(Rx(0.3));
    cube.quaternion.copy(start);
    const r = setView('xy', { side, spin: 'nearest' });
    const q = cube.quaternion.clone();
    const axis = LOOKS_ALONG.xy.clone().applyQuaternion(q);
    assert.ok(Math.abs(Math.abs(axis.z) - 1) < 1e-9, `${side}: still top-down`);
    // No other Rz(θ)·Q0 sits closer to where the volume was.
    const best = Math.abs(q.dot(start));
    for (let t = 0; t < 2 * Math.PI; t += 0.01) {
      const cand = Rz(t).multiply(Q0);
      assert.ok(Math.abs(cand.dot(start)) <= best + 1e-9, `${side}: spin ${t.toFixed(2)} would be a smaller move`);
    }
    assert.ok(r && Math.abs(r.spinDeg - 100) < 1e-6, `${side}: the pose reports the spin it landed on (got ${r && r.spinDeg})`);
    same(q, Rz(THREE.MathUtils.degToRad(r.spinDeg)).multiply(Q0), `${side}: the reported spin reproduces the pose`);
  }
  setFrameQuaternion(null);
}

// ── 10. A numeric spin is honoured and reported in [0, 360) ─────────────────
{
  setFrameQuaternion(Rz(0.7));
  const r1 = setView('xy', { spin: 45 });
  same(cube.quaternion, Rz(THREE.MathUtils.degToRad(45)).multiply(Rz(0.7)), 'a spin counts from the frame spin');
  assert.equal(r1.spinDeg, 45);
  const r2 = setView('xy', { spin: -90 });
  assert.equal(r2.spinDeg, 270, 'negative degrees wrap');
  same(cube.quaternion, Rz(-Math.PI / 2).multiply(Rz(0.7)));
  const r3 = setView('xy', { spin: 'frame' });
  assert.equal(r3.spinDeg, 0);
  same(cube.quaternion, Rz(0.7));
  setFrameQuaternion(null);
}

// ── 11. Animated poses: shortest arc, eased, settled exactly, cancellable ─────
{
  setFrameQuaternion(null);
  cube.quaternion.copy(Rz(2.0));
  const before = harness.notified();
  setView('xy', { animate: 1000 });
  const a = harness.anim();
  assert.ok(a, 'a pose in flight');
  same(cube.quaternion, Rz(2.0), 'nothing moved yet');
  harness.step(a.start + 500);
  const mid = cube.quaternion.clone();
  const total = Rz(2.0).angleTo(RAW.xy);
  const gone = Rz(2.0).angleTo(mid);
  const left = mid.angleTo(RAW.xy);
  assert.ok(Math.abs(gone + left - total) < 1e-9, 'the half-way pose lies on the shortest arc');
  assert.ok(Math.abs(gone - total / 2) < 1e-9, 'smoothstep is at its midpoint half-way through');
  assert.equal(harness.notified(), before, 'no camera notification while in flight');
  harness.step(a.start + 1000);
  same(cube.quaternion, RAW.xy, 'settles exactly on the target');
  assert.equal(harness.anim(), null, 'and the flight is over');
  assert.equal(harness.notified(), before + 1, 'one notification when it settles');

  harness.lock(true);
  cube.quaternion.copy(Rz(1.0));
  assert.equal(setView('xy', { spin: 'nearest' }), null, 'refused while locked');
  same(cube.quaternion, Rz(1.0));
  const forced = setView('xy', { spin: 'nearest', force: true });
  assert.ok(forced && Math.abs(forced.spinDeg - THREE.MathUtils.radToDeg(1.0)) < 1e-6, 'forced through the lock: nearest spin from the current pose');
  harness.lock(false);

  cube.quaternion.copy(Rz(2.0));
  setView('xy', { animate: 1000 });
  setView('xy', { spin: 90, animate: 0 });
  assert.equal(harness.anim(), null, 'a snap replaces a flight');
  same(cube.quaternion, Rz(Math.PI / 2));
}

// ── 12. Turning the sample over on the spot ─────────────────────────────────
{
  setFrameQuaternion(Rz(0.7));
  harness.home(Rz(0.3));
  cube.quaternion.copy(Rz(1.1));
  harness.setSampleUpsideDown(true, { turnOver: true });
  same(cube.quaternion, Rz(1.1).multiply(Rx(Math.PI)), 'the volume turns over about its own X axis');
  same(harness.frame(), Rz(0.7).multiply(Rx(Math.PI)), 'the calibration frame turns over with it');
  harness.setSampleUpsideDown(true, { turnOver: true });
  same(cube.quaternion, Rz(1.1).multiply(Rx(Math.PI)), 'the same side again changes nothing');
  harness.setSampleUpsideDown(false, { turnOver: true });
  same(cube.quaternion, Rz(1.1), 'and back');
  same(harness.frame(), Rz(0.7));
  harness.home(null);
  // Before anything posed the volume: the raw pose is applied at once.
  harness.loaded(false);
  cube.quaternion.identity();
  harness.setSampleUpsideDown(true);
  same(cube.quaternion, Rx(Math.PI), 'an upside-down file starts turned over');
  harness.setSampleUpsideDown(false);
  same(cube.quaternion, new THREE.Quaternion());
  setView('3d');
  const legacy = new THREE.Quaternion().multiply(Rx(-Math.PI / 6)).multiply(Ry(Math.PI / 5));
  same(cube.quaternion, legacy, 'the 3d tilt starts from the raw pose');
  harness.setSampleUpsideDown(true);
  setView('3d');
  same(cube.quaternion, Rx(Math.PI).multiply(Rx(-Math.PI / 6)).multiply(Ry(Math.PI / 5)), 'turned over when the file is upside down');
  harness.setSampleUpsideDown(false);
  setFrameQuaternion(null);
}

console.log('VolumeViewer.setView in a calibrated frame (raw · in-plane · nearest spin · degenerate · lock · home · sample side · nearest-to-current · animation): OK');
