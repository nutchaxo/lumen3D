// Units of the volume renderer, lifted from the source and run as written:
//   • the interactive quality controller (_nextAdaptiveState) and the settled sample
//     cap (_settledSampleCap);
//   • the stream's level choice under a VRAM budget (_chooseStreamLevel) and the
//     cache budget (_volumeCacheBudget);
//   • the GPU pick decoding (_decodePickTexels), the sampled histogram, the
//     centre-first brick order in micrometres, setClipRange's explicit 0;
//   • the ray-march shader: sampling interval in voxels, brick-exit skipping with one
//     page-table read per brick, textureLod in the march, no per-sample clip test,
//     saturating MIP termination, Beer–Lambert opacity correction in Structure DVR —
//     and a numerical check that the DVR column opacity no longer depends on the
//     number of samples (it did: 0.05 per sample);
//   • TrackingOverlay: InstancedMesh disposed, a hidden layer is not picked, load() is
//     re-entrant and a disposed load rejects, positions validated.
//
// Run: node tests/js/test_render_units.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT } from './harness.mjs';

const require = createRequire(import.meta.url);
const THREE = require('../../js/vendor/three.min.js');
const VV = readFileSync(path.join(ROOT, 'js/viewers/volume-viewer.js'), 'utf8').replace(/\r\n/g, '\n');
const lift = (name) => {
  // Parameters may hold one level of parentheses (a default value that is a call).
  const m = VV.match(new RegExp(`\\n  (?:async )?function ${name}\\((?:[^()]|\\([^()]*\\))*\\) \\{[\\s\\S]*?\\n  \\}\\n`));
  assert.ok(m, `${name} must be defined at module level in volume-viewer.js`);
  return m[0];
};
const MiB = 1024 * 1024;

const U = new Function('THREE', `
  const MAX_MARCH_STEPS = 4096;
  const INTERACTIVE_TARGET_MS = 16.7;
  const ADAPTIVE_LIMITS = { minScale: 0.25, maxScale: 1, minRate: 0.1, maxRate: 0.75 };
  const SETTLED_PIXEL_SAMPLE_BUDGET = 6e9;
  const VOLUME_BRICK_SIZE = 64;
  let _physicalSizeUm = null;
  const clipPlanes = { xMin: 0, xMax: 1, yMin: 0, yMax: 1, zMin: 0, zMax: 1 };
  const material = { uniforms: { clipMin: { value: new THREE.Vector3(0, 0, 0) }, clipMax: { value: new THREE.Vector3(1, 1, 1) } } };
  function _scheduleFrame() {}
  function _gpuBudgetBytes() { return 2048 * 1024 * 1024; }
  ${lift('_nextAdaptiveState')}
  ${lift('_settledSampleCap')}
  ${lift('_chooseStreamLevel')}
  ${lift('_volumeCacheBudget')}
  ${lift('_decodePickTexels')}
  ${lift('_channelHistogram')}
  ${lift('_orderBricksForStreaming')}
  ${lift('_buildSampleIndices')}
  ${lift('_sampleArray')}
  ${lift('setClipRange')}
  ${lift('setClip')}
  return { _nextAdaptiveState, _settledSampleCap, _chooseStreamLevel, _volumeCacheBudget, _decodePickTexels,
           _channelHistogram, _orderBricksForStreaming, _buildSampleIndices, _sampleArray, setClipRange, setClip,
           clipPlanes, material };
`)(THREE);

// ── adaptive quality ──────────────────────────────────────────────────────────
{
  const L = { minScale: 0.25, maxScale: 1, minRate: 0.1, maxRate: 0.75 };
  let s = { scale: 1, rate: 0.5 };
  s = U._nextAdaptiveState(s, 66.8, 16.7, L);   // 4× too slow → ½ the resolution
  assert.equal(s.scale, 0.5, 'a 4x-too-slow frame halves the resolution (cost ∝ scale²)');
  assert.equal(s.rate, 0.5, 'the sample rate is kept while the resolution can still shrink');
  s = U._nextAdaptiveState({ scale: 0.25, rate: 0.5 }, 33.4, 16.7, L);
  assert.equal(s.scale, 0.25);
  assert.equal(s.rate, 0.25, 'at the floor resolution, the rate follows the cost ratio');
  assert.deepEqual(U._nextAdaptiveState({ scale: 0.5, rate: 0.4 }, 20, 16.7, L), { scale: 0.5, rate: 0.4 }, 'no change inside the band');
  s = U._nextAdaptiveState({ scale: 0.5, rate: 0.4 }, 16.7, 16.7, L);
  assert.ok(s.rate > 0.4 && s.scale === 0.5, 'an on-target frame raises the rate first');
  s = U._nextAdaptiveState({ scale: 0.5, rate: 0.75 }, 10, 16.7, L);
  assert.equal(s.rate, 0.75);
  assert.equal(s.scale, 0.55, 'then the resolution, quantised to 1/20');
  assert.deepEqual(U._nextAdaptiveState({ scale: 0.6, rate: 0.3 }, NaN, 16.7, L), { scale: 0.6, rate: 0.3 }, 'no measurement, no change');
  for (let i = 0; i < 50; i++) s = U._nextAdaptiveState(s, 1000, 16.7, L);
  assert.deepEqual(s, { scale: 0.25, rate: 0.1 }, 'bounded below');
  // From the floor, fast frames bring the resolution back (x1.05 alone rounded back
  // down to 0.25 at every step below 0.5: one slow frame pinned it for the session).
  for (let i = 0; i < 200; i++) s = U._nextAdaptiveState(s, 5, 16.7, L);
  assert.deepEqual(s, { scale: 1, rate: 0.75 }, 'recovers from the floor to full resolution');
  assert.equal(U._nextAdaptiveState({ scale: 0.25, rate: 0.75 }, 10, 16.7, L).scale, 0.3, 'one quantum up from the floor');
}
{
  assert.equal(U._settledSampleCap(800 * 600), 4096, 'a small view samples every voxel of the longest native ray');
  assert.equal(U._settledSampleCap(3840 * 2160 * 4), 256, 'a 4K DPR-2 frame stays within the watchdog budget (floor 256)');
  assert.equal(U._settledSampleCap(1e12), 256, 'never below 256');
  assert.equal(U._settledSampleCap(1920 * 1080, 0.5), 1446, 'scaled by the learned budget (3e9 / 2073600)');
  assert.equal(U._settledSampleCap(1920 * 1080, 1), 2893);
  console.log('adaptive quality + settled cap: OK');
}

// ── level choice under a budget ───────────────────────────────────────────────
{
  const lv = (lod, mode, bytes, planned = true) => ({ lod, mode, bytes, planned });
  const levels = [lv(0, 'svr', 5120 * MiB), lv(1, 'svr', 1536 * MiB), lv(2, 'svr', 512 * MiB), lv(3, 'monolithic', 257 * MiB)];
  let c = U._chooseStreamLevel(levels, { available: 2048 * MiB });
  assert.equal(c.level.lod, 1, 'the finest level that fits');
  assert.deepEqual(c.skipped.map(s => [s.lod, s.reason]), [[0, 'vram-budget']]);
  c = U._chooseStreamLevel(levels, { available: 300 * MiB });
  assert.equal(c.level.lod, 3);
  c = U._chooseStreamLevel([lv(0, 'svr', Infinity, false), lv(1, 'svr', 64 * MiB)], { available: 1e12 });
  assert.equal(c.level.lod, 1);
  assert.equal(c.skipped[0].reason, 'capacity', 'an atlas that cannot be laid out is skipped as capacity');
  c = U._chooseStreamLevel(levels, { available: 1e12, preload: true });
  assert.equal(c.level.lod, 3, 'a prefetch never takes an atlas');
  assert.equal(U._chooseStreamLevel(levels, { available: 100 * MiB }).level, null, 'nothing fits: no level');
  c = U._chooseStreamLevel(levels, { available: 100 * MiB, lastResort: true });
  assert.equal(c.level.lod, 3, 'nothing on screen: the coarsest level is attempted over the budget');
  assert.equal(c.level.overBudget, true);
  assert.equal(U._chooseStreamLevel(levels, { available: 100 * MiB, lastResort: true, preload: true }).level, null, 'never for a prefetch');
  assert.equal(U._chooseStreamLevel([lv(0, 'svr', Infinity, false)], { available: 1, lastResort: true }).level, null, 'a level that cannot be laid out is never forced');
  assert.equal(U._volumeCacheBudget(4096 * MiB), 768 * MiB, 'cache capped at 768 MiB');
  assert.equal(U._volumeCacheBudget(1024 * MiB), Math.floor(1024 * MiB * 0.4), '40 % of a small budget');
  assert.equal(U._volumeCacheBudget(128 * MiB), 128 * MiB, 'never below 128 MiB');
  console.log('VRAM-aware level choice: OK');
}

// ── pick decoding, histogram, brick order, clip range ─────────────────────────
{
  const p = U._decodePickTexels([128, 0, 64, 0], [255, 255, 255, 255], false, null, null);
  assert.ok(Math.abs(p.x - (128 * 256 / 65535 - 0.5)) < 1e-12 && Math.abs(p.z - 0.5) < 1e-12, 'unwarped: object = c − ½');
  const w = U._decodePickTexels([0, 0, 255, 255], [0, 0, 255, 255], true, { x: -1, y: -2, z: -3 }, { x: 2, y: 4, z: 6 });
  assert.deepEqual([w.x, w.y, w.z], [-1, 2, -3], 'warped: the display box');
  assert.equal(U._decodePickTexels([1, 2, 3, 4], [0, 0, 0, 0], false), null, 'alpha 0: nothing hit');

  const values = new Uint8Array(1000);
  for (let i = 0; i < 1000; i++) values[i] = i < 250 ? 0 : 255;
  const h = U._channelHistogram(values, 256, 100);
  assert.equal(h.total, 1000, 'counts scaled back to the voxel count');
  assert.equal(h.counts[0], 250);
  assert.equal(h.counts[255], 750);

  // A 3×3×3 grid of 64³ bricks whose Z voxel is 10× deeper: the corner (0,0,0) is
  // far in Z, so a brick of the middle layer two columns out comes before it.
  const bricks = [];
  for (let bz = 0; bz < 3; bz++) for (let by = 0; by < 3; by++) for (let bx = 0; bx < 3; bx++) bricks.push({ bx, by, bz });
  const order = U._orderBricksForStreaming(bricks, { x: 192, y: 192, z: 192, brickSize: 64 }, { x: 192, y: 192, z: 1920 });
  assert.deepEqual(order[0], { bx: 1, by: 1, bz: 1 }, 'the centre brick first');
  const rank = (b) => order.findIndex(o => o.bx === b.bx && o.by === b.by && o.bz === b.bz);
  assert.ok(rank({ bx: 0, by: 0, bz: 1 }) < rank({ bx: 1, by: 1, bz: 0 }), 'distance in micrometres, not in brick indices');
  const flat = U._orderBricksForStreaming(bricks, { x: 192, y: 192, z: 192 }, null);
  assert.deepEqual(flat[0], { bx: 1, by: 1, bz: 1 }, 'a missing brickSize falls back to 64, not NaN');

  assert.deepEqual(U._buildSampleIndices(100, 1), [50], 'one sample: the middle slice, not NaN');
  assert.deepEqual(U._sampleArray(['a', 'b', 'c'], 1), ['b']);

  U.setClipRange('z', 0, 0);
  assert.equal(U.material.uniforms.clipMax.value.z, 0, 'an explicit 0 is a value, not "unset"');
  U.setClipRange('x', 0.2, undefined);
  assert.equal(U.material.uniforms.clipMax.value.x, 1, 'a missing max is 1');
  U.setClipRange('y', 0.6, 0.3);
  assert.equal(U.material.uniforms.clipMax.value.y, 0.6, 'max never below min');
  U.setClip('y', 0.1);
  assert.equal(U.material.uniforms.clipMax.value.y, 0.6, 'setClip never puts max under min');
  console.log('pick decode, histogram, brick order, clip range: OK');
}

// ── shader ────────────────────────────────────────────────────────────────────
{
  const frag = VV.slice(VV.indexOf('const fragmentShader = `'), VV.indexOf('`;', VV.indexOf('const fragmentShader = `')));
  assert.ok(/float nu = max\(length\(dirTex \* volumeVoxels\), 1e-6\);/.test(frag), 'voxel lengths per unit of ray parameter');
  assert.ok(/float delta = 1\.0 \/ \(max\(sampleRate, 1e-3\) \* nu\);/.test(frag), 'one sample every 1/sampleRate voxels');
  assert.ok(/if \(rayLength \/ delta > maxSamples\) delta = rayLength \/ maxSamples;/.test(frag), 'capped by the sample budget');
  assert.ok(/for \(int i = 0; i < MAX_MARCH_STEPS; i\+\+\)/.test(frag), 'loop bound from the constant');
  assert.ok(/float brickExit\(vec3 uvw, vec3 dirTex, vec3 cell\)/.test(frag), 'brick exit');
  assert.ok(/t \+= max\(delta, ceil\(skip \/ delta\) \* delta\);/.test(frag), 'an empty brick is skipped to its exit, on the sample lattice');
  assert.ok(/if \(any\(notEqual\(cell, cachedCell\)\)\)/.test(frag), 'the page table is read once per brick');
  assert.ok(!/[^D]texture\(svrAtlas/.test(frag) && /textureLod\(svrAtlas0, atlasCoord, 0\.0\)/.test(frag), 'textureLod in the march');
  assert.ok(!/clipCoord\.x >= clipMin\.x/.test(frag), 'no per-sample clip test (the march is confined to the clip box)');
  assert.ok(/if \(all\(greaterThanEqual\(mip, mipCeil\)\)\) break;/.test(frag), 'MIP stops once every channel is saturated');
  assert.ok(/float aStep = 1\.0 - pow\(max\(1\.0 - DVR_REF_ALPHA \* localAlpha, 0\.0\), dvrExponent\);/.test(frag), 'DVR opacity correction');
  assert.ok(!/0\.05 \* dvrW/.test(frag), 'no per-sample constant weight left');
  assert.ok(/#ifdef PICK_MODE/.test(frag) && /PICK_SURFACE \* peak/.test(frag), 'the depth pick pass');
  console.log('shader structure: OK');
  // A superseded stream's finally must not clear the flag of the one replacing it.
  assert.ok(/_fgStreamActive = Math\.max\(0, _fgStreamActive - 1\);\s*\/\/[^\n]*\n\s*_isStreamingBricks = _fgStreamActive > 0;/.test(VV), 'streaming flag follows the live display streams');
  assert.ok(!/minInterval = 25/.test(VV), 'no 40 FPS cap while interacting');
  assert.ok(/antialias: false/.test(VV), 'no MSAA on the ray-marched canvas');
}

// ── DVR: column opacity independent of the number of samples ──────────────────
{
  // The shader's compositing, written out: a uniform column of displayed value a,
  // length L (object units), sampled n times.
  const REF_STEP = 0.01, REF_ALPHA = 0.05;
  const columnNew = (a, L, n) => {
    const delta = L / n;
    const aStep = 1 - Math.pow(1 - REF_ALPHA * a, delta / REF_STEP);
    let A = 0;
    for (let i = 0; i < n; i++) A += (1 - A) * aStep;
    return A;
  };
  const columnOld = (a, n) => Math.min(1, n * a * 0.05);   // 0.05 per sample
  const exact = (a, L) => 1 - Math.pow(1 - REF_ALPHA * a, L / REF_STEP);
  for (const n of [24, 48, 256, 600]) {
    assert.ok(Math.abs(columnNew(0.3, 0.2, n) - exact(0.3, 0.2)) < 1e-9, `n=${n}: the opacity of the column`);
  }
  assert.ok(Math.abs(columnOld(0.3, 24) - columnOld(0.3, 600)) > 0.5, 'the old weight changed with the sample count');
  console.log('DVR opacity is sample-count invariant: OK');
}

// ── TrackingOverlay ───────────────────────────────────────────────────────────
{
  const workers = [];
  class FakeWorker {
    constructor() { this.terminated = false; workers.push(this); }
    postMessage() {}
    terminate() { this.terminated = true; }
  }
  const ctx = vm.createContext({ THREE, console, setTimeout, Worker: FakeWorker, URL, location: { href: 'https://lab.example/viewer.html' }, DOMException });
  vm.runInContext(readFileSync(path.join(ROOT, 'js/viewers/tracking-overlay.js'), 'utf8') + '\n;globalThis.__T = TrackingOverlay;', ctx);
  const T = ctx.__T;
  const volume = new THREE.Object3D();
  volume.scale.set(1, 1, 1);
  T.init({ volumeObject: volume, umToObject: (v, o) => o.set(v.x / 100 - 0.5, v.y / 100 - 0.5, v.z / 100 - 0.5), onDirty() {}, acqSize: { x: 100, y: 100, z: 100 } });

  // Re-entrant load: the first is superseded (AbortError) and its late answer ignored.
  const first = T.load('DATA_WEB/live/x', { tracksPath: 'tracks.json' });
  const second = T.load('DATA_WEB/live/x', { tracksPath: 'tracks.json' });
  await assert.rejects(first, (e) => e.name === 'AbortError', 'a superseded load rejects');
  assert.equal(workers[0].terminated, true, 'its worker is terminated');
  const data = {
    phase: 'done', maxN: 2, frameCount: 1, counts: [2], cellIdx: new Int32Array([0, 1]), cellTotal: 2,
    posRaw: new Float32Array([10, 10, 10, 90, 90, 90]), posStab: new Float32Array([10, 10, 10, 90, 90, 90]),
    palette: new Float32Array([1, 0, 0, 0, 1, 0]), flags: new Uint8Array([0, 0]),
    cellFrameSlot: new Int32Array([0, 1]), hasRaw: true, regionNames: [], regionColors: [], regionIdx: new Int32Array(2)
  };
  workers[0].onmessage?.({ data: { ...data, maxN: 99 } });   // the stale worker answering anyway
  workers[1].onmessage({ data });
  const loaded = await second;
  assert.equal(loaded.maxN, 2, 'the latest load wins');
  assert.equal(T.getCount(), 2);

  // positions
  assert.equal(T.positionUm(0.5, 0), null, 'a non-integer cell index is refused');
  assert.deepEqual([...T.positionUm(1, 0)], [90, 90, 90]);
  const out = new THREE.Vector3();
  assert.equal(T.positionObject(1, 0, out), out);
  assert.ok(Math.abs(out.x - 0.4) < 1e-6);

  // style validation
  T.setStyle({ diameterUm: NaN, opacity: 7 });
  assert.equal(T.getStyle().diameterUm, 12, 'a NaN diameter is ignored');
  assert.equal(T.getStyle().opacity, 1, 'opacity clamped');

  // A hidden layer is not picked (the raycaster tests layers, not visibility).
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
  camera.position.set(-0.4, -0.4, 3);
  camera.lookAt(-0.4, -0.4, 0);
  camera.updateMatrixWorld();
  const dom = { getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }) };
  T.setStyle({ diameterUm: 40 });
  assert.equal(T.pick(50, 50, camera, dom), 0, 'the visible cell is picked');
  T.setStyle({ visible: false });
  assert.equal(T.pick(50, 50, camera, dom), -1, 'the hidden layer is not');
  T.setStyle({ visible: true });
  T.setAutoHidden(true);
  assert.equal(T.pick(50, 50, camera, dom), -1, 'nor an auto-hidden one');
  assert.equal(T.getStyle().visible, true, 'auto-hiding leaves the user setting alone');
  T.setAutoHidden(false);

  // dispose: the InstancedMesh itself is disposed, a pending load rejects.
  const mesh = volume.children[0].children[0];
  let meshDisposed = false;
  mesh.addEventListener('dispose', () => { meshDisposed = true; });
  const pending = T.load('DATA_WEB/live/x', { tracksPath: 'tracks.json' });
  T.dispose();
  assert.equal(meshDisposed, true, 'InstancedMesh.dispose() releases its instance buffers');
  await assert.rejects(pending, (e) => e.name === 'AbortError', 'a load pending at dispose rejects instead of hanging');
  console.log('TrackingOverlay (dispose, hidden pick, re-entrant load, validation): OK');
}

console.log('render units: OK');
