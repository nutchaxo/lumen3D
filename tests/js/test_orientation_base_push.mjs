// A calibration saved (or thrown away) in the admin editor must reach the preview
// that is still open, or a custom default view captured afterwards is stored against
// the OLD Q_base and every visitor opens the dataset in the wrong pose.
//   • orientation-axes: SET_ORIENTATION_BASE adopts the new Q_base (calibrated, or
//     the raw pose for null), leaves the volume where it is, and from then on
//     GET_ORIENTATION_VIEW returns Q_cube · Q_new⁻¹ and SET_SAMPLE_UPSIDE_DOWN keeps
//     the calibration; a capture during calibration is refused; a foreign origin is
//     ignored (behavioural);
//   • viewer.js answers SET_ORIENTATION_BASE by updating datasetMeta.orientation and
//     the frame quaternion; tab-datasets.js pushes the draft's Q_base after the save
//     reads it back and on a discard, and refuses a default view while calibrating
//     (structural).
//
// Run: node tests/js/test_orientation_base_push.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from './harness.mjs';

const require = createRequire(import.meta.url);
const THREE = require('../../js/vendor/three.min.js');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r/g, '');
const same = (a, b, msg) => assert.ok(Math.abs(Math.abs(a.dot(b)) - 1) < 1e-9, `${msg} (got ${a.toArray().map((v) => v.toFixed(4))})`);
const Rx = (t) => new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), t);
const Ry = (t) => new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), t);
const Rz = (t) => new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), t);

const ORIGIN = 'https://lab.example';
let plugin = null;
let renders = 0;
new Function('THREE', 'PluginRegistry', 'window', 'document', 'Utils', 'VolumeViewer', read('js/modules/tools/orientation-axes/index.js'))(
  THREE,
  { implement: (_id, impl) => { plugin = impl; } },
  { addEventListener() {} },
  { createElement: () => ({ getContext: () => ({ fillText() {} }), width: 0, height: 0 }) },
  { isTrustedMessageOrigin: (e) => e.origin === ORIGIN },
  {
    getRawPoseQuaternion: (flag) => (flag ? Ry(Math.PI) : new THREE.Quaternion()),
    setHomeQuaternion() {}, triggerRender() { renders++; }
  },
);
assert.ok(plugin, 'plugin implementation must register');

const cube = { quaternion: new THREE.Quaternion() };
plugin._getCube = () => cube;
plugin._visible = true;     // the gizmo is already shown: CALIBRATE_ORIENTATION_START skips activate()
const send = (data, origin = ORIGIN) => {
  let reply = null;
  plugin._onMessage({ origin, data, source: { postMessage: (m) => { reply = m; } } });
  return reply;
};

// An uncalibrated dataset in the preview.
plugin._ctx = { dataset: { getMeta: () => ({ upsideDown: false }) } };
plugin._readConfig();
assert.equal(plugin._calibrated, false);

// The operator aligns the specimen on the axes: a capture now is refused.
send({ type: 'CALIBRATE_ORIENTATION_START' });
assert.equal(plugin._calibrationMode, true);
const Qnew = Rz(0.7).multiply(Rx(-0.4));
cube.quaternion.copy(Qnew);
let r = send({ type: 'GET_ORIENTATION_VIEW' });
assert.equal(r.type, 'ORIENTATION_VIEW_RESULT');
assert.equal(r.quaternion, null, 'a pose being calibrated is not an anatomical view');
assert.equal(r.reason, 'calibrating');
assert.equal(plugin._defaultView, null, 'nothing captured');

// Save: the admin reads the pose, stops the calibration and pushes the new Q_base.
r = send({ type: 'GET_ORIENTATION' });
same(new THREE.Quaternion(r.quaternion.x, r.quaternion.y, r.quaternion.z, r.quaternion.w), Qnew, 'the pose read back');
send({ type: 'CALIBRATE_ORIENTATION_STOP' });

// A foreign origin cannot move the calibration.
send({ type: 'SET_ORIENTATION_BASE', quaternion: Rx(1).toArray() }, 'https://evil.example');
assert.equal(plugin._calibrated, false, 'cross-origin SET_ORIENTATION_BASE ignored');

const before = renders;
send({ type: 'SET_ORIENTATION_BASE', quaternion: Qnew.toArray() });
assert.equal(plugin._calibrated, true);
same(plugin._baseQuaternion, Qnew, 'the preview adopts the saved calibration');
same(cube.quaternion, Qnew, 'the volume is not moved');
assert.ok(renders > before, 'the gizmo is redrawn');

// The object form the editor may hold works too.
send({ type: 'SET_ORIENTATION_BASE', quaternion: { x: Qnew.x, y: Qnew.y, z: Qnew.z, w: Qnew.w } });
same(plugin._baseQuaternion, Qnew);

// The operator turns the volume and captures a custom default view.
const Qcube = Ry(0.9).multiply(Qnew);
cube.quaternion.copy(Qcube);
r = send({ type: 'GET_ORIENTATION_VIEW' });
const qAnat = new THREE.Quaternion().fromArray(r.quaternion);
same(qAnat, Qcube.clone().multiply(Qnew.clone().invert()), 'Q_anat = Q_cube · Q_new⁻¹');
// What a visitor gets: Q_anat · Q_base, with the SAVED calibration — the captured pose.
same(qAnat.clone().multiply(Qnew), Qcube, 'the stored view reopens the captured pose');

// The sample-side switch keeps a fresh calibration.
send({ type: 'SET_SAMPLE_UPSIDE_DOWN', value: true });
same(plugin._baseQuaternion, Qnew, 'the sample side never replaces a calibration');

// A discarded draft without calibration: back to the raw pose of the current side.
send({ type: 'SET_ORIENTATION_BASE', quaternion: null });
assert.equal(plugin._calibrated, false);
same(plugin._baseQuaternion, Ry(Math.PI), 'uncalibrated ⇒ the raw pose the core shows (upside down here)');
send({ type: 'SET_SAMPLE_UPSIDE_DOWN', value: false });
same(plugin._baseQuaternion, new THREE.Quaternion(), 'and the switch follows it again');

// A malformed quaternion is treated as "no calibration", never as identity garbage.
send({ type: 'SET_ORIENTATION_BASE', quaternion: [0, 0, 0, 0] });
assert.equal(plugin._calibrated, false);

// ── viewer.js: the core keeps its own copy of Q_base in step ───────────────────
{
  const src = read('js/pages/viewer.js');
  const i = src.indexOf("data.type === 'SET_ORIENTATION_BASE'");
  assert.ok(i > 0, 'viewer.js handles SET_ORIENTATION_BASE');
  const block = src.slice(i, src.indexOf('} else if', i + 10));
  assert.match(block, /datasetMeta\.orientation\s*=/, 'datasetMeta.orientation follows the editor');
  assert.match(block, /delete datasetMeta\.orientation/, 'a null calibration clears it');
  assert.match(block, /setFrameQuaternion\?\.\(_baseQuaternion\(\)\)/, 'the axis-aligned views read the new frame');
  // It lives in the parent-only listener (origin + window.parent checked).
  const listener = src.lastIndexOf("window.addEventListener('message'", i);
  assert.match(src.slice(listener, listener + 200), /isTrustedMessageOrigin\(e\) \|\| e\.source !== window\.parent/);
}

// ── tab-datasets.js: the editor pushes what its draft holds ────────────────────
{
  const src = read('js/pages/admin/tab-datasets.js');
  assert.match(src, /function pushOrientationBase\(\) \{[\s\S]*?type: 'SET_ORIENTATION_BASE', quaternion: _draft\.orientation \|\| null[\s\S]*?window\.location\.origin/,
    'pushOrientationBase posts the draft calibration to the preview, same origin');
  const save = src.slice(src.indexOf('async function saveDatasetNow()'));
  const readBack = save.indexOf("type: 'GET_ORIENTATION'");
  const push = save.indexOf('pushOrientationBase()');
  const post = save.indexOf('apiFetch(');
  assert.ok(readBack > 0 && push > readBack && push < post, 'the save pushes the calibration it just read back');
  const discard = src.slice(src.indexOf('function discardChanges('), src.indexOf('// ── List'));
  assert.match(discard, /pushOrientationBase\(\)/, 'a discarded draft puts the saved calibration back on the preview');
  const req = src.slice(src.indexOf('function requestOrientationView('), src.indexOf('function updateVisibilityUI('));
  assert.ok(req.indexOf('_isCalibratingOrientation') > 0 && req.indexOf('_isCalibratingOrientation') < req.indexOf('postMessage(message'),
    'no default view is resolved while the volume is being calibrated');
  assert.match(req, /reason === 'calibrating'/, 'the plugin\'s refusal is explained');
  assert.match(req, /admin\.viewDuringCalibration/);
}

// ── manifest ───────────────────────────────────────────────────────────────────
{
  const meta = JSON.parse(read('js/modules/tools/orientation-axes/plugin.json'));
  const [maj, min, pat] = meta.version.split('.').map(Number);
  assert.ok(maj > 1 || (maj === 1 && (min > 3 || (min === 3 && pat >= 5))), 'orientation-axes version bumped');
}

console.log('test_orientation_base_push: ok');
