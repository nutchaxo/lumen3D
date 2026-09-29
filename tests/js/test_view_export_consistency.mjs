// 3D view export: every tile of one image shows the same volume and the same display.
// The real VolumeViewer.renderViewImage / _waitForSteadyVolume / _isVolumeStreaming /
// _exportFingerprint / loadVolume are lifted and run against a real three.js scene, with
// the GPU parts (targets, tile render) stubbed:
//   • a brick stream that replaced another one mid-stream (its predecessor's `finally`
//     cleared _isStreamingBricks, _fgStreamActive still counts it) holds the export
//     back, and one starting between two tiles restarts the image;
//   • a slice-stack (webstack) load of loadVolume does the same while it is the current
//     load; a superseded one that only drains its fetches does not; loadVolume
//     unregisters itself however it ends (a throw included);
//   • a display change between two tiles (exposure, channel colour, render mode, a
//     define, grid shown / hidden / rebuilt, z display scale, idle steps, cut plane, a
//     texture re-upload) restarts the image; the uniforms a tile sets itself and the
//     render loop's step count do not, nor does the live pose (the tiles render a
//     snapshot of it); a change on every attempt ends in 'display-changed' after three
//     restarts, a stream that never ends in 'unstable'.
//
// Run: node tests/js/test_view_export_consistency.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from './harness.mjs';

const require = createRequire(import.meta.url);
const THREE = require('../../js/vendor/three.min.js');
const vvSrc = readFileSync(path.join(ROOT, 'js/viewers/volume-viewer.js'), 'utf8').replace(/\r\n/g, '\n');

const lift = (name) => {
  const m = vvSrc.match(new RegExp(`\\n  (?:async )?function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n  \\}\\n`));
  assert.ok(m, `${name} must be defined at module level in volume-viewer.js`);
  return m[0];
};
const volatile = vvSrc.match(/\n  const EXPORT_VOLATILE_UNIFORMS = [^\n]*\n/);
assert.ok(volatile, 'EXPORT_VOLATILE_UNIFORMS declared');

const FS = 'void main() { /* ray march */ }';

function makeScene() {
  const scene = new THREE.Scene();
  const atlas = new THREE.DataTexture(new Uint8Array(4), 1, 1);
  const uniforms = {
    svrAtlas0: { value: atlas },
    steps: { value: 100 },
    renderMode: { value: 2 },
    exposure: { value: 1 },
    fragCoordOffset: { value: new THREE.Vector2(0, 0) },
    exportAlpha: { value: 0 },
    clipMin: { value: new THREE.Vector3(0, 0, 0) },
    clipMax: { value: new THREE.Vector3(1, 1, 1) },
    volumeWarp: { value: new THREE.Matrix4() },
    color0: { value: new THREE.Vector3(0, 1, 0) }, min0: { value: 0 }, max0: { value: 1 }, en0: { value: 1 },
  };
  const material = new THREE.ShaderMaterial({ fragmentShader: FS, uniforms, defines: { ENABLE_CHANNEL_0: 1 } });
  const cube = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), material);
  scene.add(cube);
  const measurements = new THREE.Group();
  cube.add(measurements);
  // The grid: its projection wall shares the ray-march shader and, by reference, the
  // volume's uniforms, plus its own.
  const buildGrid = () => {
    const grid = new THREE.Group();
    const projUniforms = { ...uniforms, projAxis: { value: 2 }, invCubeScale: { value: new THREE.Vector3(1, 1, 1) } };
    grid.add(new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.ShaderMaterial({ fragmentShader: FS, uniforms: projUniforms })));
    grid.add(new THREE.Mesh(new THREE.SphereGeometry(0.04), new THREE.MeshBasicMaterial()));
    scene.add(grid);
    return grid;
  };
  const grid = buildGrid();
  const camera = new THREE.PerspectiveCamera(45, 1.5, 0.1, 100);
  camera.position.set(0, 0, 2.5);
  return { scene, cube, material, uniforms, atlas, grid, buildGrid, measurements, camera };
}

function makeViewer(world, onTile) {
  const gl = {
    MAX_VIEWPORT_DIMS: 1, MAX_RENDERBUFFER_SIZE: 2,
    getParameter: (p) => (p === 1 ? [4096, 4096] : 4096),
    isContextLost: () => false,
  };
  const factory = new Function('THREE', 'world', 'gl', 'onTile', `
    const scene = world.scene, camera = world.camera, cube = world.cube, material = world.material;
    const fragmentShader = ${JSON.stringify(FS)};
    const renderer = { getContext: () => gl, capabilities: { maxTextureSize: 4096, isWebGL2: true, maxSamples: 4 } };
    // _waitForSteadyVolume polls every 250 ms: here at once (the test flips the state
    // from the 'waiting' progress callback).
    const setTimeout = (fn) => Promise.resolve().then(fn);
    let _viewExportInFlight = false;
    let _contextLost = false;
    let _isStreamingBricks = false;
    let _fgStreamActive = 0;
    let _loadCounter = 1;
    const _sliceLoads = new Set();
    let _activeVolumeEntry = { name: 'A' };
    let _qualityState = { progress: 0.4 };
    let _targetSteps = 400;
    let _planeSpec = { mode: 'xy', value: 0.5, yaw: 0, pitch: 0, roll: 0, visible: false };
    ${volatile[0]}
    function _allocExportCanvas(width, height) { return { canvas: { width, height }, ctx: { clearRect() {} } }; }
    function _createExportComposite() { return { material: { dispose() {} }, geometry: { dispose() {} } }; }
    function _allocExportTargets(config) { return { tile: config.tile, samples: config.samples }; }
    function _disposeExportTargets() {}
    function _scheduleFrame() {}
    function _micronsPerPixelFor() { return 0; }
    function getPhysicalSize() { return null; }
    function _macrotask() { return Promise.resolve(); }
    let api = null;
    function _renderExportTile(tile, job) { onTile(tile, job, api); return true; }
    let _loadSliceVolume = null;
    ${lift('_viewExportError')}
    ${lift('_viewExportAbortError')}
    ${lift('_throwIfViewExportStopped')}
    ${lift('_exportTileConfigs')}
    ${lift('_planExportTiles')}
    ${lift('_rayMarchMaterials')}
    ${lift('_isVolumeStreaming')}
    ${lift('_pushExportValue')}
    ${lift('_exportFingerprint')}
    ${lift('_sameExportFingerprint')}
    ${lift('_waitForSteadyVolume')}
    ${lift('renderViewImage')}
    ${lift('loadVolume')}
    api = {
      renderViewImage, loadVolume, _isVolumeStreaming, _exportFingerprint, _sameExportFingerprint,
      setStreamingBricks: (v) => { _isStreamingBricks = v; },
      setFgStreams: (n) => { _fgStreamActive = n; },
      bumpLoadCounter: () => ++_loadCounter,
      loadCounter: () => _loadCounter,
      addSliceLoad: (loadId) => { const job = { loadId }; _sliceLoads.add(job); return job; },
      removeSliceLoad: (job) => _sliceLoads.delete(job),
      sliceLoadCount: () => _sliceLoads.size,
      setEntry: (e) => { _activeVolumeEntry = e; },
      setTargetSteps: (n) => { _targetSteps = n; },
      setPlane: (p) => { _planeSpec = { ..._planeSpec, ...p }; },
      setSliceLoader: (fn) => { _loadSliceVolume = fn; },
    };
    return api;
  `);
  return factory(THREE, world, gl, onTile);
}

// 5000 × 3000 in 2048 px tiles: 3 × 2 = 6 tiles.
const SIZE = { width: 5000, height: 3000 };
const TILES = 6;

async function run(world, onTile, before = null, onWaiting = null) {
  const renders = [];
  const waits = [];
  const viewer = makeViewer(world, (tile, job, api) => {
    renders.push(tile);
    onTile?.(renders.length, api, world);
  });
  before?.(viewer, world);
  let error = null;
  let canvas = null;
  try {
    canvas = await viewer.renderViewImage({
      ...SIZE,
      onProgress: (p) => {
        if (p.phase === 'waiting') {
          waits.push(p.progress);
          onWaiting?.(waits.length, viewer, world);
        }
      },
    });
  } catch (err) {
    error = err;
  }
  return { renders: renders.length, waits: waits.length, waitProgress: waits, canvas, error, viewer };
}

// ── Steady volume, untouched display: one pass ────────────────────────────────
{
  const r = await run(makeScene());
  assert.equal(r.error, null);
  assert.equal(r.renders, TILES, 'every tile rendered once');
  assert.equal(r.waits, 0, 'nothing to wait for');
  assert.equal(r.canvas.exportInfo.tiles, TILES);
  console.log('steady export: OK');
}

// ── What the tiles set themselves, the render loop's steps, the live pose ─────
{
  const r = await run(makeScene(), (n, api, w) => {
    w.uniforms.steps.value = 24 + n;                 // the render loop's interactive steps
    w.uniforms.fragCoordOffset.value.set(n, -n);     // a tile's jitter offset
    w.uniforms.exportAlpha.value = n % 2;            // a transparent export's alpha hook
    w.cube.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), n * 0.1); // a pose animation
    w.cube.position.set(n * 0.01, 0, 0);
  });
  assert.equal(r.error, null);
  assert.equal(r.renders, TILES, 'no restart: none of these changes what a tile shows');
  console.log('volatile uniforms and live pose ignored: OK');
}

// ── A display change between two tiles restarts the image ─────────────────────
const once = (change) => (n, api, w) => { if (n === 2) change(w, api); };
for (const [what, change] of [
  ['exposure', (w) => { w.uniforms.exposure.value = 1.5; }],
  ['render mode', (w) => { w.uniforms.renderMode.value = 0; }],
  ['channel colour', (w) => { w.uniforms.color0.value.set(1, 0, 1); }],
  ['channel window', (w) => { w.uniforms.max0.value = 0.5; }],
  ['channel off', (w) => { w.uniforms.en0.value = 0; }],
  ['clip range', (w) => { w.uniforms.clipMax.value.set(1, 1, 0.5); }],
  ['stabilisation warp', (w) => { w.uniforms.volumeWarp.value.makeTranslation(0.1, 0, 0); }],
  ['a define', (w) => { w.material.defines.VOLUME_WARP = 1; }],
  ['volume hidden', (w) => { w.material.visible = false; }],
  ['grid hidden', (w) => { w.grid.visible = false; }],
  ['grid rebuilt', (w) => { w.scene.remove(w.grid); w.buildGrid(); }],
  ['grid wall scale', (w) => { w.grid.children[0].material.uniforms.invCubeScale.value.set(1, 1, 2); }],
  ['a measurement added', (w) => { w.measurements.add(new THREE.Sprite()); }],
  ['z display scale', (w) => { w.cube.scale.set(1, 1, 2); }],
  ['idle step count', (w, api) => { api.setTargetSteps(800); }],
  ['cut plane', (w, api) => { api.setPlane({ value: 0.3 }); }],
  ['atlas re-upload', (w) => { w.atlas.needsUpdate = true; }],
]) {
  const r = await run(makeScene(), once(change));
  assert.equal(r.error, null, `${what}: the image completes`);
  assert.equal(r.renders, 2 + TILES, `${what}: restarted after the second tile, then one full pass`);
}
console.log('display changes restart the image: OK');

// A change on every attempt: three restarts, then 'display-changed'.
{
  const r = await run(makeScene(), (n, api, w) => { w.uniforms.exposure.value += 0.1; });
  assert.ok(r.error, 'gives up');
  assert.equal(r.error.code, 'display-changed', 'says the display kept changing, not the volume');
  assert.equal(r.renders, 4, 'one tile per attempt, four attempts (three restarts)');
}

// ── #11: a stream superseded by another one mid-stream ─────────────────────────
{
  // At the start: _isStreamingBricks already cleared by the superseded stream's
  // finally, the newer stream still counted.
  const r = await run(makeScene(), null, (viewer) => {
    viewer.setStreamingBricks(false);
    viewer.setFgStreams(1);
  }, (n, viewer) => { if (n === 3) viewer.setFgStreams(0); });
  assert.equal(r.error, null);
  assert.equal(r.waits, 3, 'the export waits for the stream that is still running');
  assert.ok(r.waitProgress.every((p) => p === 0.4), 'with the stream\'s own progress');
  assert.equal(r.renders, TILES);

  // Between two tiles: a quality switch starts a stream.
  const r2 = await run(makeScene(), once((w, api) => { api.setFgStreams(1); }), null,
    (n, viewer) => { viewer.setFgStreams(0); });
  assert.equal(r2.error, null);
  assert.equal(r2.renders, 2 + TILES, 'restarted, after waiting for the stream');
  assert.equal(r2.waits, 1);
  console.log('superseded brick stream (_fgStreamActive) gates the export: OK');
}

// ── #12: a slice-stack (webstack) load ─────────────────────────────────────────
{
  let job = null;
  const r = await run(makeScene(), null, (viewer) => {
    job = viewer.addSliceLoad(viewer.loadCounter());
  }, (n, viewer) => { if (n === 2) viewer.removeSliceLoad(job); });
  assert.equal(r.error, null);
  assert.equal(r.waits, 2, 'the current slice load holds the export back');
  assert.equal(r.renders, TILES);

  // A superseded load only drains its fetches: it does not hold anything back.
  const r2 = await run(makeScene(), null, (viewer) => {
    viewer.addSliceLoad(viewer.loadCounter());
    viewer.bumpLoadCounter(); // a newer load (or a brick stream) took over
  });
  assert.equal(r2.error, null);
  assert.equal(r2.waits, 0, 'a stale load is not waited for');
  assert.equal(r2.renders, TILES);

  // Starting between two tiles restarts the image; one that never ends gives up.
  const r3 = await run(makeScene(), once((w, api) => { api.addSliceLoad(api.loadCounter()); }), null,
    (n, viewer) => { if (n >= 1) viewer.bumpLoadCounter(); });
  assert.equal(r3.error, null);
  assert.equal(r3.renders, 2 + TILES, 'a slice load starting mid-export restarts it');
  // A load after every first tile (a timelapse stepping on): each attempt waits for it,
  // then the next one lands under the tiles again.
  const jobs = [];
  const r4 = await run(makeScene(), (n, api) => { jobs.push(api.addSliceLoad(api.loadCounter())); }, null,
    (n, viewer) => { while (jobs.length) viewer.removeSliceLoad(jobs.pop()); });
  assert.ok(r4.error && r4.error.code === 'unstable', 'the volume kept changing: unstable, not display-changed');
  assert.equal(r4.renders, 4, 'four attempts');
  console.log('slice-stack load gates the export: OK');
}

// ── loadVolume registers the load for its whole life, a throw included ────────
{
  const viewer = makeViewer(makeScene(), () => {});
  let seen = null;
  viewer.setSliceLoader(async (basePath, metadata, timepoint, onProgress, options, job) => {
    job.loadId = viewer.bumpLoadCounter();
    await Promise.resolve();
    seen = { count: viewer.sliceLoadCount(), streaming: viewer._isVolumeStreaming(), args: [basePath, timepoint, options.quality] };
    return { ok: true };
  });
  const result = await viewer.loadVolume('DATA_WEB/3d/x', {}, 3, null, { quality: '512x512' });
  assert.deepEqual(result, { ok: true }, 'the load\'s own result');
  assert.deepEqual(seen, { count: 1, streaming: true, args: ['DATA_WEB/3d/x', 3, '512x512'] }, 'registered and streaming while it runs');
  assert.equal(viewer.sliceLoadCount(), 0, 'unregistered once done');
  assert.equal(viewer._isVolumeStreaming(), false);

  viewer.setSliceLoader(async (basePath, metadata, timepoint, onProgress, options, job) => {
    job.loadId = viewer.bumpLoadCounter();
    throw new Error('No volume slices could be loaded');
  });
  await assert.rejects(viewer.loadVolume('x', {}), /No volume slices/);
  assert.equal(viewer.sliceLoadCount(), 0, 'a failed load never leaves the export waiting');
  assert.equal(viewer._isVolumeStreaming(), false);
  console.log('loadVolume registration: OK');
}

// ── Structure: the real loadVolume path records its load id; the stream gate is shared ──
{
  assert.ok(/async function _loadSliceVolume\(basePath, metadata, timepoint, onProgress, options, job\) \{[\s\S]*?const loadId = \+\+_loadCounter;\n    job\.loadId = loadId;/.test(vvSrc),
    'the slice load records its id as soon as it has one');
  const render = lift('renderViewImage');
  assert.ok(/await _waitForSteadyVolume\(signal, onProgress\);[\s\S]*?const fingerprint = _exportFingerprint\(\);/.test(render),
    'the fingerprint is taken with the pose snapshot');
  assert.ok(/if \(_isVolumeStreaming\(\) \|\| _activeVolumeEntry !== entry\)/.test(render), 'tile gate: any stream, or a swapped volume');
  assert.ok(/_sameExportFingerprint\(fingerprint, _exportFingerprint\(\)\)/.test(render), 'tile gate: the display fingerprint');
  assert.ok(/if \(!_isVolumeStreaming\(\)\) return;/.test(lift('_waitForSteadyVolume')), 'wait gate: the same test');
  console.log('export gates wiring: OK');
}

console.log('3D view export consistency (streams, slice loads, display changes): OK');
