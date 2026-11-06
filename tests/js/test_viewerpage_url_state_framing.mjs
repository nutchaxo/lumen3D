// A #state= link or a pending workspace makes init() skip the first camera fit (the
// saved camera is about to be applied). When no saved camera is actually put on the
// volume, the volume must still be framed (viewer.js _applyInitialViewState):
//   • a corrupt or truncated link (the prompt answers null), "open as new", a saved
//     view without a camera, a camera the renderer refuses, a restore that throws
//     → VolumeViewer.resetView (clip box reset only for "open as new");
//   • nothing mounted yet → the renderer is told no volume was framed, so the first
//     activation fits the camera itself;
//   • a saved camera applied (link or pending state) → left alone;
//   • VolumeViewer.setCameraState says whether it applied a camera.
//
// Run: node tests/js/test_viewerpage_url_state_framing.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { ROOT } from './harness.mjs';

const require = createRequire(import.meta.url);
const THREE = require('../../js/vendor/three.min.js');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const viewerSrc = read('js/pages/viewer.js');
const vvSrc = read('js/viewers/volume-viewer.js');
function lift(src, name) {
  const m = src.match(new RegExp(`\\n  (?:async )?function ${name}\\([^\\n]*\\) \\{\\n[\\s\\S]*?\\n  \\}\\n`));
  assert.ok(m, `${name} must be defined at module level`);
  return m[0];
}

// The real core hands setCameraState's answer to the caller.
{
  const core = lift(viewerSrc, '_applyWorkspaceStateCore');
  assert.match(core, /const cameraApplied = VolumeViewer\.setCameraState\(viewerState\.camera\) === true;/);
  assert.match(core, /if \(out\) out\.cameraApplied = cameraApplied;/);
  const init = lift(viewerSrc, 'init');
  assert.match(init, /_applyInitialViewState\(urlChoice, Boolean\(hasPendingCameraState\)\)/, 'init() goes through the one restore door');
  assert.ok(!/VolumeViewer\.resetView\(\{ resetClipping: true \}\)/.test(init), 'no separate "open as new" framing left in init()');
}

function makePage({ pending = null, mounted = true, accept = true }) {
  const log = [];
  const VolumeViewer = {
    setCameraState: (cam) => { log.push(['camera', cam]); return accept; },
    resetView: (opts) => { log.push(['reset', opts]); },
    setHasLoadedVolume: (v) => { log.push(['hasLoaded', v]); }
  };
  const body = `
    let _pendingWorkspaceState = env.pending;
    const UrlState = { clearHash: () => env.log.push(['clearHash']) };
    const ExportManager = { toast: () => env.log.push(['toast']) };
    function _t(k, f) { return f; }
    function _hasMountedVolume() { return env.mounted; }
    // The camera line of the real core; the rest of it is not what this test is about.
    function _applyWorkspaceStateCore(state, out = null) {
      if (state.throws) throw new Error('bad state');
      const viewerState = state.viewer && Object.keys(state.viewer).length ? state.viewer : state;
      if (viewerState.camera) {
        const cameraApplied = VolumeViewer.setCameraState(viewerState.camera) === true;
        if (out) out.cameraApplied = cameraApplied;
      }
      if (state.throwsAfterCamera) throw new Error('bad tail');
    }
    ${['_applyWorkspaceStateNow', '_applyInitialViewState'].map(n => lift(viewerSrc, n)).join('\n')}
    return { apply: _applyInitialViewState, pending: () => _pendingWorkspaceState };
  `;
  const api = new Function('env', 'VolumeViewer', 'console', body)({ pending, mounted, log }, VolumeViewer, { warn() {} });
  return { api, log };
}

const cam = { kind: 'volume', cameraZ: 3.1, quaternion: [0, 0, 0, 1] };
const resets = (log) => log.filter(e => e[0] === 'reset');

// A corrupt or truncated link: the prompt cleared the hash and answered null.
{
  const { api, log } = makePage({});
  assert.equal(api.apply(null, true), false);
  assert.deepEqual(resets(log), [['reset', { resetClipping: false }]], 'the volume is framed');
}
// "Open the dataset as new".
{
  const { api, log } = makePage({});
  assert.equal(api.apply({ choice: 'fresh' }, true), false);
  assert.deepEqual(log.map(e => e[0]), ['clearHash', 'reset']);
  assert.deepEqual(resets(log)[0][1], { resetClipping: true }, 'clip box reset as before');
}
// A saved view without a camera, a camera refused, a restore that throws.
for (const [label, state, accept] of [
  ['no camera', { viewer: { channels: [] } }, true],
  ['camera refused', { viewer: { camera: { kind: 'slice' } } }, false],
  ['restore throws', { throws: true }, true],
  ['throws after its camera', { viewer: { camera: cam }, throwsAfterCamera: true }, true]
]) {
  const { api, log } = makePage({ accept });
  assert.equal(api.apply({ choice: 'restore', state }, true), true, `${label}: the link's view was used`);
  assert.equal(resets(log).length, 1, `${label}: the volume is framed`);
}
// The saved camera applied: nothing else moves it.
{
  const { api, log } = makePage({});
  assert.equal(api.apply({ choice: 'restore', state: { viewer: { camera: cam } } }, true), true);
  assert.equal(resets(log).length, 0, 'a restored camera is kept');
}
// A pending state (Compare, brick-tree handoff) with its camera.
{
  const { api, log } = makePage({ pending: { viewer: { camera: cam } } });
  api.apply(null, true);
  assert.equal(resets(log).length, 0, 'the pending camera is kept');
  assert.equal(api.pending(), null, 'the pending state is consumed');
}
// Nothing suppressed the first fit: nothing to do.
{
  const { api, log } = makePage({});
  api.apply(null, false);
  assert.equal(log.length, 0);
}
// No volume mounted yet: the first activation frames it.
{
  const { api, log } = makePage({ mounted: false });
  api.apply(null, true);
  assert.deepEqual(log, [['hasLoaded', false]]);
}
console.log('initial framing after a #state= link or a pending view: OK');

// ── VolumeViewer.setCameraState answers whether it applied a camera ───────────────
{
  const body = `
    let _hasLoadedVolume = false;
    let _poseAnim = null;
    const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 100);
    camera.position.z = 2.5;
    const cube = new THREE.Object3D();
    function setZDisplayScale() {}
    function _scheduleFrame() {}
    ${lift(vvSrc, 'setCameraState')}
    return { set: setCameraState, z: () => camera.position.z, loaded: () => _hasLoadedVolume };
  `;
  const vv = new Function('THREE', body)(THREE);
  assert.equal(vv.set(null), false);
  assert.equal(vv.set({ kind: 'slice', cameraZ: 4 }), false, 'another kind of view');
  assert.equal(vv.set({ kind: 'volume' }), false, 'no field');
  assert.equal(vv.loaded(), false, 'nothing applied: the first fit is not suppressed');
  assert.equal(vv.set({ kind: 'volume', quaternion: [0, 0, 0, 0] }), false, 'a degenerate pose alone applies nothing');
  assert.equal(vv.set({ kind: 'volume', cameraZ: 4.2 }), true);
  assert.equal(vv.z(), 4.2);
  assert.equal(vv.set({ kind: 'volume', quaternion: [0, 0, 0, 1] }), true);
  console.log('setCameraState reports whether it applied a camera: OK');
}

console.log('url state framing: OK');
