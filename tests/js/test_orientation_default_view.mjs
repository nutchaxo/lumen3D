// Geometry contract of the orientation-axes default view.
//
// The feature rests on two lines of algebra (see the plugin header):
//   Q_anat = Q_cube · Q_base⁻¹     the anatomical frame's world pose
//   Q_cube = Q_anat · Q_base       how a default view is applied
// A sign slip in either one orients every dataset wrongly while still "working",
// so the presets are checked against what the operator was promised: the named
// anatomical direction ends up facing the camera (world +Z) with the named one up.
//
// Run: node tests/js/test_orientation_default_view.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const THREE = require('../../js/vendor/three.min.js');

// The plugin is a classic script that calls PluginRegistry.implement() at load; run
// it with the globals it expects so the REAL implementation is what gets tested.
let plugin = null;
const src = readFileSync(new URL('../../js/modules/tools/orientation-axes/index.js', import.meta.url), 'utf8');
new Function('THREE', 'PluginRegistry', 'window', 'document', 'Utils', src)(
  THREE,
  { implement: (_id, impl) => { plugin = impl; } },
  { addEventListener() {} },
  { createElement: () => ({ getContext: () => ({ fillText() {} }), width: 0, height: 0 }) },
  { isTrustedMessageOrigin: () => true },
);
assert.ok(plugin, 'plugin implementation must register');

const ANAT = {
  A: new THREE.Vector3(0, 1, 0), P: new THREE.Vector3(0, -1, 0),
  V: new THREE.Vector3(0, 0, 1), D: new THREE.Vector3(0, 0, -1),
  R: new THREE.Vector3(1, 0, 0), L: new THREE.Vector3(-1, 0, 0),
};
const CAMERA = new THREE.Vector3(0, 0, 1);   // world +Z — the camera looks down −Z
const UP = new THREE.Vector3(0, 1, 0);

/** Drive the plugin exactly as the admin panel does, and read back what it stored. */
function applyView(meta, cubeQuat, message) {
  plugin._ctx = { dataset: { getMeta: () => meta } };
  plugin._readConfig();
  const cube = { quaternion: cubeQuat.clone() };
  plugin._getCube = () => cube;
  let reply = null;
  plugin._onMessage({
    origin: 'x', data: message,
    source: { postMessage: (m) => { reply = m; } },
  });
  return { cube, reply };
}

// ── 1. Every preset points the promised anatomy at the camera ─────────────────
const EXPECT = {
  ventral:   { face: 'V', up: 'A' },
  dorsal:    { face: 'D', up: 'A' },
  left:      { face: 'L', up: 'A' },
  right:     { face: 'R', up: 'A' },
  anterior:  { face: 'A', up: 'D' },
  posterior: { face: 'P', up: 'D' },
};
// A non-trivial calibration: the composition must cancel it, whatever it is.
const base = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.7, -1.2, 0.4));
const baseMeta = { orientation: { x: base.x, y: base.y, z: base.z, w: base.w } };

for (const [preset, want] of Object.entries(EXPECT)) {
  const { cube, reply } = applyView(baseMeta, new THREE.Quaternion(),
    { type: 'APPLY_ORIENTATION_VIEW', value: { preset } });

  assert.equal(reply.type, 'ORIENTATION_VIEW_RESULT', `${preset}: must reply`);
  assert.equal(reply.preset, preset, `${preset}: preset echoed back`);
  assert.ok(Array.isArray(reply.quaternion) && reply.quaternion.every(Number.isFinite),
    `${preset}: a finite Q_anat must be handed to the panel`);

  // The stored value is Q_anat, so the anatomy lands where promised once the CUBE
  // pose (Q_anat · Q_base) carries the specimen's own axes through it.
  const qAnat = new THREE.Quaternion().fromArray(reply.quaternion);
  const faceDir = ANAT[want.face].clone().applyQuaternion(qAnat);
  const upDir = ANAT[want.up].clone().applyQuaternion(qAnat);
  assert.ok(faceDir.dot(CAMERA) > 0.999, `${preset}: ${want.face} must face the camera (got ${faceDir.toArray()})`);
  assert.ok(upDir.dot(UP) > 0.999, `${preset}: ${want.up} must point up (got ${upDir.toArray()})`);

  // And the cube really was posed — this is what makes the admin preview honest.
  const applied = new THREE.Quaternion().copy(qAnat).multiply(base);
  assert.ok(Math.abs(Math.abs(cube.quaternion.dot(applied)) - 1) < 1e-6,
    `${preset}: cube must be posed at Q_anat · Q_base`);
}

// ── 2. Capture → apply is a round trip ───────────────────────────────────────
// What the operator poses by hand must reopen in exactly that pose.
const posed = new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.3, 2.1, 0.9));
const captured = applyView(baseMeta, posed, { type: 'GET_ORIENTATION_VIEW' }).reply;
assert.equal(captured.preset, 'custom', 'a hand-built pose is stored as custom');

const reopened = applyView(
  { ...baseMeta, orientationAxes: { defaultView: captured } },
  new THREE.Quaternion(),
  { type: 'APPLY_ORIENTATION_VIEW', value: captured },
);
assert.ok(Math.abs(Math.abs(reopened.cube.quaternion.dot(posed)) - 1) < 1e-6,
  'reopening a captured view must reproduce the exact pose it was captured from');

// ── 3. prepare() is the pre-load lane, and it is fail-safe ───────────────────
// Applying the view after the volume is on screen would snap a visible specimen, so
// the pose is set from prepare() — before the first brick — via the viewer's home
// quaternion, which is also what "reset view" returns to.
{
  const meta = { ...baseMeta, orientationAxes: { defaultView: captured } };
  let home = null;
  globalThis.VolumeViewer = { setHomeQuaternion: (q, o) => { home = { q, o }; } };
  plugin.prepare({ dataset: { getMeta: () => meta } });
  assert.ok(home, 'prepare() must register the dataset pose as the viewer home');
  assert.equal(home.o?.apply, true, 'prepare() must also adopt the pose immediately');
  assert.ok(Math.abs(Math.abs(home.q.dot(posed)) - 1) < 1e-6, 'home pose must be Q_anat · Q_base');

  // No default view, a malformed one, or no calibration at all: leave the scene alone
  // rather than guess (rule 1.1 — a bad metadata field must not orient a dataset).
  for (const orientationAxes of [undefined, {}, { defaultView: {} },
    { defaultView: { quaternion: [0, 0, 0, 0] } },
    { defaultView: { quaternion: [1, 'x', 0, 0] } },
    { defaultView: { preset: 'sideways' } }]) {
    home = null;
    plugin.prepare({ dataset: { getMeta: () => ({ ...baseMeta, orientationAxes }) } });
    assert.equal(home, null, `no pose may be applied for ${JSON.stringify(orientationAxes)}`);
  }

  // An uncalibrated dataset still honours a captured view: Q_base is then identity,
  // so Q_anat is the raw cube pose and the round trip holds anyway.
  home = null;
  plugin.prepare({ dataset: { getMeta: () => ({ orientationAxes: { defaultView: { preset: 'dorsal' } } }) } });
  assert.ok(home, 'a default view must apply without a calibration');
  delete globalThis.VolumeViewer;
}

// ── 4. Hidden and renamed arms ───────────────────────────────────────────────
// The gizmo is what the operator edits in the panel; a rename must survive and a
// hidden arm must not be built at all (it costs GPU sprites, not just visibility).
{
  plugin._ctx = {
    dataset: { getMeta: () => ({ orientationAxes: { labels: { A: 'Rostral', P: '  ' }, hidden: ['D', 'V', 'bogus'] } }) },
    i18n: { t: (k) => k },
  };
  plugin._readConfig();
  assert.equal(plugin._axisLabel('A'), 'Rostral', 'a rename must be used');
  assert.equal(plugin._axisLabel('P'), 'P', 'a blank rename falls back to the glyph');
  assert.equal(plugin._axisLabel('R'), 'R', 'an absent rename falls back to the glyph');
  assert.ok(plugin._hidden.has('D') && plugin._hidden.has('V'), 'hidden arms must be recorded');
  assert.ok(!plugin._hidden.has('bogus'), 'an unknown axis code must be dropped');

  plugin._buildGroup();
  const arrows = plugin._group.children.filter((c) => c.type === 'Object3D' || c.isObject3D && c.line);
  const sprites = plugin._group.children.filter((c) => c.isSprite);
  assert.equal(sprites.length, 4, 'two hidden arms ⇒ four labels built, not six');
  assert.ok(arrows.length >= 4, 'two hidden arms ⇒ four arrows built');
}

console.log('orientation-axes default view (presets · round trip · prepare lane · axis editor): OK');
