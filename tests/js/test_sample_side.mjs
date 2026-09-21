// The sample side and the z-stack browser's opening pose (web v1.55.7).
// `metadata.upsideDown` says the raw file shows the sample from below: the core shows
// it turned over about its X axis, the z-stack browser looks at its top face, and on
// the admin preview the orientation plugin's calibration turns over with the volume.
//   • orientation-axes: SET_SAMPLE_UPSIDE_DOWN turns Q_base over once per change and
//     replies with what the panel must store; an uncalibrated dataset starts on the raw
//     pose the core shows; a default view still lands the promised anatomy on the camera
//     (behavioural, real three.js);
//   • zstack-browser: opening poses the stack top-down with the nearest spin (animated),
//     the track re-poses and locks, the slider, the sync payload, a restored workspace
//     keeps its pose (behavioural);
//   • viewer.js, tab-datasets.js, admpan.html, the dictionaries and the manifests
//     (structural).
//
// Run: node tests/js/test_sample_side.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { loadModule, ROOT } from './harness.mjs';

const require = createRequire(import.meta.url);
const THREE = require('../../js/vendor/three.min.js');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r/g, '');
const same = (a, b, msg) => assert.ok(Math.abs(Math.abs(a.dot(b)) - 1) < 1e-9, `${msg} (got ${a.toArray().map((v) => v.toFixed(4))})`);
const Rx = (t) => new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), t);
const Rz = (t) => new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), t);

// ── orientation-axes ─────────────────────────────────────────────────────────
{
  let plugin = null;
  let rawPose = new THREE.Quaternion();
  const src = read('js/modules/tools/orientation-axes/index.js');
  new Function('THREE', 'PluginRegistry', 'window', 'document', 'Utils', 'VolumeViewer', src)(
    THREE,
    { implement: (_id, impl) => { plugin = impl; } },
    { addEventListener() {} },
    { createElement: () => ({ getContext: () => ({ fillText() {} }), width: 0, height: 0 }) },
    { isTrustedMessageOrigin: () => true },
    { getRawPoseQuaternion: () => rawPose.clone(), setHomeQuaternion() {}, triggerRender() {} },
  );
  assert.ok(plugin, 'plugin implementation must register');
  const send = (message) => {
    let reply = null;
    plugin._onMessage({ origin: 'x', data: message, source: { postMessage: (m) => { reply = m; } } });
    return reply;
  };

  // Calibrated, right side up: switching turns Q_base over once, and back.
  const Q = Rz(0.6).multiply(Rx(0.2));
  plugin._ctx = { dataset: { getMeta: () => ({ orientation: Q.toArray(), upsideDown: false }) } };
  plugin._readConfig();
  assert.equal(plugin._calibrated, true);
  same(plugin._baseQuaternion, Q, 'Q_base is the saved calibration');
  let r = send({ type: 'SET_SAMPLE_UPSIDE_DOWN', value: true });
  assert.equal(r.type, 'SAMPLE_SIDE_RESULT');
  assert.equal(r.upsideDown, true);
  same(new THREE.Quaternion().fromArray(r.orientation), Q.clone().multiply(Rx(Math.PI)), 'the calibration turned over with the volume');
  r = send({ type: 'SET_SAMPLE_UPSIDE_DOWN', value: true });
  same(new THREE.Quaternion().fromArray(r.orientation), Q.clone().multiply(Rx(Math.PI)), 'the same side again changes nothing');
  r = send({ type: 'SET_SAMPLE_UPSIDE_DOWN', value: false });
  same(new THREE.Quaternion().fromArray(r.orientation), Q, 'and back');

  // Uncalibrated, upside down: Q_base is the raw pose the core shows, nothing to store.
  rawPose = Rx(Math.PI);
  plugin._ctx = { dataset: { getMeta: () => ({ upsideDown: true }) } };
  plugin._readConfig();
  assert.equal(plugin._calibrated, false);
  same(plugin._baseQuaternion, Rx(Math.PI), 'an uncalibrated upside-down file starts on the turned-over raw pose');
  r = send({ type: 'SET_SAMPLE_UPSIDE_DOWN', value: false });
  assert.equal(r.orientation, null, 'no calibration to hand back');
  same(plugin._baseQuaternion, new THREE.Quaternion(), 'the raw pose turned back');

  // A default view after the flip still lands the promised anatomy on the camera.
  rawPose = new THREE.Quaternion();
  plugin._ctx = { dataset: { getMeta: () => ({ orientation: Q.toArray(), upsideDown: false }) } };
  plugin._readConfig();
  send({ type: 'SET_SAMPLE_UPSIDE_DOWN', value: true });
  const cube = { quaternion: new THREE.Quaternion() };
  plugin._getCube = () => cube;
  send({ type: 'APPLY_ORIENTATION_VIEW', value: { preset: 'ventral' } });
  const anat = cube.quaternion.clone().multiply(plugin._baseQuaternion.clone().invert());
  const v = new THREE.Vector3(0, 0, 1).applyQuaternion(anat);
  assert.ok(v.distanceTo(new THREE.Vector3(0, 0, 1)) < 1e-9, 'ventral faces the camera on the turned-over calibration');
}

// ── zstack-browser ───────────────────────────────────────────────────────────
{
  const elements = new Map();
  const makeEl = (id) => {
    const classes = new Set();
    const el = {
      id, style: {}, attrs: {}, textContent: '', value: '', max: '', title: '', disabled: false,
      classList: {
        add: (c) => classes.add(c), remove: (c) => classes.delete(c),
        toggle: (c, on) => { on ? classes.add(c) : classes.delete(c); return classes.has(c); },
        contains: (c) => classes.has(c),
      },
      setAttribute: (k, v) => { el.attrs[k] = String(v); },
      addEventListener() {},
      querySelector: () => null,
      getContext: () => new Proxy({}, { get: () => () => {} }),
      width: 200, height: 280,
    };
    return el;
  };
  const $ = (id) => { if (!elements.has(id)) elements.set(id, makeEl(id)); return elements.get(id); };
  let plugin = null;
  loadModule('js/modules/tools/zstack-browser/index.js', 'ZNone', {
    PluginRegistry: { implement: (_id, obj) => { plugin = obj; }, syncToolbarButton() {} },
    document: { getElementById: $ },
    AbortController,
  });
  const views = [];
  const posts = [];
  let spinBack = 123;
  const ctx = {
    _state: { zstackActive: false, zstackCurrentSlice: 0, suppressZstackSync: false },
    iframe: { isIframe: () => true, postMessage: (m) => posts.push(m), panelIndex: () => 0 },
    viewer: {
      setClipRange_z() {}, setRotationLocked() {}, resetClipping() {},
      setView: (v, o) => { views.push({ view: v, ...o }); return { spinDeg: spinBack }; },
    },
    dataset: { getMeta: () => ({ dimensions: { z: 50, c: 1 }, voxel_size: { z: 1 } }) },
    ui: { scheduleResize() {}, openStudio() {} },
    i18n: { t: (k) => k, onLanguageChange() {} },
  };
  plugin.init(ctx);

  plugin.activate();
  assert.deepEqual(views, [{ view: 'xy', side: 'top', spin: 'nearest', animate: 1500, force: true }],
    'opening: top face toward the camera, the smallest spin from where the volume was, over 1.5 s');
  assert.equal(plugin._spin, 123, 'the spin landed on is remembered');
  assert.equal($('zstack-spin').value, '123', 'and shown on the slider');

  plugin._goToSlice(10);
  assert.deepEqual(views.at(-1), { view: 'xy', side: 'top', spin: 'nearest', animate: 1200, force: true },
    'entering the track: nearest spin again, animated, before the lock');
  assert.equal(posts.at(-1).spin, 123, 'the sync payload carries the spin');

  plugin._setSpin(30);
  assert.deepEqual(views.at(-1), { view: 'xy', side: 'top', spin: 30, animate: 0, force: true }, 'the slider: at once, through the lock');
  assert.equal(posts.at(-1).spin, 30);

  spinBack = 200;
  plugin.applySync({ sliceTotal: 50, mode: 'slice', cursor: 5, thickness: 1, crop: [0, 49], spin: 200 });
  assert.deepEqual(views.at(-1), { view: 'xy', side: 'top', spin: 200, animate: 400, force: true }, 'a sibling’s spin is followed in the track');
  assert.equal(plugin.getState().spin, 200);

  plugin.applyState(false, null);
  views.length = 0;
  plugin.setState({ zstackActive: true, mode: '3d', cursor: 0, thickness: 1, crop: [0, 49], spin: 55 });
  assert.equal(views.length, 0, 'a restored workspace keeps its pose: no opening move');
  assert.equal(plugin._spin, 55, 'but the saved spin is back on the slider');
  plugin.applyState(false, null);
  plugin.dispose();
}

// ── Structural ───────────────────────────────────────────────────────────────
{
  const vv = read('js/viewers/volume-viewer.js');
  for (const name of ['setSampleUpsideDown', 'isSampleUpsideDown', 'getRawPoseQuaternion', 'isPoseAnimating']) {
    assert.ok(new RegExp(`\\n    ${name}[,:]`).test(vv), `VolumeViewer exports ${name}`);
  }
  assert.ok(/if \(_stepPoseAnimation\(now\)\) _needsRender = true;/.test(vv), 'the render loop steps a pose in flight');
  assert.equal((vv.match(/_poseAnim = null;   \/\/ the user took the volume/g) || []).length, 2, 'a rotate drag cancels the flight (both branches)');

  const v = read('js/pages/viewer.js');
  assert.ok(/VolumeViewer\.setSampleUpsideDown\?\.\(datasetMeta\?\.upsideDown === true\);/.test(v), 'the flag reaches the core at init');
  assert.ok(/data\.type === 'SET_SAMPLE_UPSIDE_DOWN'[\s\S]*?setSampleUpsideDown\?\.\(data\.value === true, \{ turnOver: true \}\)/.test(v), 'the admin preview turns the volume over');

  const tab = read('js/pages/admin/tab-datasets.js');
  assert.ok(/fSampleSide: el\('f-sample-side'\)/.test(tab), 'the editor knows the switch');
  assert.ok(/upsideDown: !!meta\.upsideDown,/.test(tab), 'the flag is part of the dirty fingerprint');
  assert.ok(/meta\.upsideDown = meta\.upsideDown === true;/.test(tab), 'always posted as a boolean (merge backends)');
  assert.ok(/type: 'SET_SAMPLE_UPSIDE_DOWN', value: !!_draft\.upsideDown/.test(tab), 'the switch reaches the preview');
  assert.ok(/e\.data\?\.type !== 'SAMPLE_SIDE_RESULT'/.test(tab) && /_draft\.orientation = Array\.isArray\(_draft\.orientation\)/.test(tab), 'the turned-over calibration is stored');
  const html = read('admpan.html');
  assert.ok(/id="f-sample-side"/.test(html) && /name="f-sample-side" value="1"/.test(html), 'two radios');
  assert.ok(/data-i18n="admin\.sampleSideUp"/.test(html) && /data-i18n="admin\.sampleSideDown"/.test(html));
  for (const code of ['en', 'fr', 'es', 'nl']) {
    const dict = JSON.parse(read(`lang/${code}.json`));
    for (const k of ['sampleSide', 'sampleSideUp', 'sampleSideDown', 'sampleSideHint']) assert.equal(typeof dict.admin?.[k], 'string', `${code}: admin.${k}`);
    const zs = JSON.parse(read(`js/modules/tools/zstack-browser/lang/${code}.json`));
    for (const k of ['spin', 'spinTitle']) assert.equal(typeof zs[k], 'string', `${code}: zstack ${k}`);
  }
  assert.ok(/id="zstack-spin"[^>]*min="0" max="360"/.test(read('viewer.html')), 'the spin slider spans a full turn');
  const zs = JSON.parse(read('js/modules/tools/zstack-browser/plugin.json'));
  assert.equal(zs.version, '1.2.0');
  assert.equal(zs.platformCompat, '>=1.55.7', 'the browser needs the core that resolves side top and animates');
  const ori = JSON.parse(read('js/modules/tools/orientation-axes/plugin.json'));
  assert.equal(ori.version, '1.3.0');
  assert.equal(ori.platformCompat, '>=1.55.7');
}

console.log('sample side (upside-down flag, turned-over calibration, z-stack opening pose + spin slider): OK');
