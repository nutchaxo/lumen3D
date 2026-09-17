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
  const _notifyCameraChange = () => {};
  ${lift('_nearestZSpin')}
  ${lift('setFrameQuaternion')}
  ${lift('setView')}
  return {
    cube, setView, setFrameQuaternion,
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

// ── 6. The 3D view is the home pose when one is registered ───────────────────
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

console.log('VolumeViewer.setView in a calibrated frame (raw · in-plane · nearest spin · degenerate · lock · home): OK');
