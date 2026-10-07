// v3 brick trees in the viewer, and the region-of-interest detail streaming.
//
// Units (SVRRoi, svr-manager.js, pure): pixels per voxel, the detail level the view
// needs, frustum ∩ clip-box culling in texture space, the priority order (big on
// screen, central first), one round's want / load / keep / evict within the capacity;
// SVRManager residency (touch keeps a brick off the LRU, evict frees its slot).
//
// End to end (the real volume-viewer.js + brick-loader.js + svr-manager.js +
// brick-decode-worker.js in a vm, a v3 tree served from memory by the loader tests'
// fixtures, a recording WebGL stub):
//   • quality presets map to levels per SPEC §13.7 and getQualityLevels reports them;
//   • a v3 level streams into a bordered atlas (66³ slots, R8 / RG8) or, when it fits,
//     a dense texture holding the 64³ interiors at 64·b;
//   • live v3 manifests: one tree per timepoint, its index inside it (memoised);
//   • zooming past the resident level's resolution streams the finer level's bricks in
//     view into a detail atlas (ROI_DETAIL), within the budget, in short byte-range
//     batches; a camera move cancels nothing and no brick is fetched twice; zooming out
//     keeps the atlas (zooming back in downloads nothing); bricks that left the view are
//     recycled first; a new volume tears the detail down.
//
// Run: node tests/js/test_v3_render_roi.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT } from './harness.mjs';
import { buildV3Tree, mockFetch, VmBrickWorker } from './test_v3_loader_fixtures.mjs';

const require = createRequire(import.meta.url);
const REAL_THREE = require('../../js/vendor/three.min.js');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');
const MiB = 1024 * 1024;
const plain = (o) => JSON.parse(JSON.stringify(o));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function waitFor(cond, ms = 8000, label = 'condition') {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${label}`);
    await sleep(10);
  }
}

// ── SVRRoi units ──────────────────────────────────────────────────────────────
const svrCtx = vm.createContext({ console: { warn() {}, log() {}, error() {} }, window: {}, navigator: {}, THREE: REAL_THREE,
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} } });
vm.runInContext(read('js/core/svr-manager.js') + '\n;globalThis.__R = SVRRoi; globalThis.__S = SVRManager;', svrCtx);
const Roi = svrCtx.__R;
const SVR = svrCtx.__S;

{
  const f = Roi.focalPx(600, 45);
  assert.ok(Math.abs(f - 600 / (2 * Math.tan(Math.PI / 8))) < 1e-9, 'focal length in pixels');
  assert.ok(Math.abs(Roi.pixelsPerVoxel(1000, 0.002, 1) - 2) < 1e-12);
  const levels = [{ level: 0, voxelWorld: 1 / 1024 }, { level: 1, voxelWorld: 1 / 512 }, { level: 2, voxelWorld: 1 / 256 }, { level: 3, voxelWorld: 1 / 128 }];
  const at = (basePpv) => Roi.chooseDetailLevel({ levels, baseLevel: 2, focalPx: 256 * basePpv, distance: 1 });
  assert.equal(at(1.5).level, null, 'a base voxel under 2 px: no detail');
  assert.equal(at(2).level, null, 'exactly 2 px: still fine');
  assert.equal(at(2.5).level, 1, 'base at 2.5 px: level 1 (1.25 px) is enough — the coarsest finer level that resolves it');
  assert.equal(at(3.9).level, 1, 'level 1 at 1.95 px');
  assert.equal(at(4.4).level, 0, 'level 1 at 2.2 px is not enough: level 0');
  assert.equal(at(50).level, 0, 'zoomed far in: the finest level there is');
  assert.equal(Roi.chooseDetailLevel({ levels, baseLevel: 0, focalPx: 1e6, distance: 1 }).level, null, 'level 0 resident: nothing finer');
  // Hysteresis (1.3): the level held stays around its switch points.
  const hold = (basePpv, current) => Roi.chooseDetailLevel({ levels, baseLevel: 2, focalPx: 256 * basePpv, distance: 1, current }).level;
  assert.equal(hold(1.8, 1), 1, 'base at 1.8 px is not comfortably enough (> 2/1.3): level 1 kept');
  assert.equal(hold(1.4, 1), null, 'base at 1.4 px: the detail is let go');
  assert.equal(hold(4.4, 1), 1, 'level 1 at 2.2 px is within 2·1.3: kept instead of switching to level 0');
  assert.equal(hold(5.6, 1), 0, 'level 1 at 2.8 px: level 0');
  assert.equal(hold(4.4, 0), 0, 'level 0 kept while level 1 (2.2 px) is not comfortably enough');
  assert.equal(hold(2.8, 0), 1, 'level 1 at 1.4 px is comfortably enough: back to it');
  assert.equal(Roi.depthQuantile([5, 1, 3, 2, 4], 0.5), 3);
  assert.equal(Roi.depthQuantile([5, 1, 3, 2, 4], 0), 1);
  assert.equal(Roi.depthQuantile([], 0.5), null);
  // Wanted bricks: the viewport two bricks deep, within [48, 320].
  const wb = (depth) => Roi.wantedBricks({ viewportW: 1000, viewportH: 600, focalPx: 1000, voxelWorld: 0.002, depth });
  assert.equal(wb(1), 108, 'bricks of 128 px: (8 + 1) × (5 + 1) across the viewport, two deep');
  assert.equal(wb(0.1), 48, 'a few huge bricks: never fewer than 48');
  assert.equal(wb(10), 320, 'tiny bricks: never more than 320');
  console.log('detail level choice (2 px per voxel, hysteresis), depth quantile, wanted bricks: OK');
}

{
  // A grid of 4 × 1 × 1 bricks of a 256 × 64 × 64 level; the view holds x ≤ 0.5.
  const bricks = [0, 1, 2, 3].map(bx => ({ bx, by: 0, bz: 0 }));
  const dims = { x: 256, y: 64, z: 64 };
  const planes = [[-1, 0, 0, 0.5]];
  const project = (u) => ({ x: (u - 0.25) * 4, y: 0, depth: 1 });
  const ranked = Roi.rankVisible({ bricks, dims, planes, project });
  assert.deepEqual(plain(ranked.map(r => r.bx)), [0, 1, 2], 'brick 3 is outside the frustum; brick 2 touches it');
  assert.ok(ranked[0].priority === ranked[1].priority && ranked[1].priority > ranked[2].priority, 'central bricks first, ties in grid order');
  const clipped = Roi.rankVisible({ bricks, dims, planes, project, clipMin: { x: 0.3, y: 0, z: 0 }, clipMax: { x: 1, y: 1, z: 1 } });
  assert.deepEqual(plain(clipped.map(r => r.bx)), [1, 2], 'a brick wholly outside the clip box is not in view');
  const near = Roi.rankVisible({ bricks: bricks.slice(0, 2), dims, planes: [], project: (u) => ({ x: 0, y: 0, depth: u < 0.25 ? 4 : 1 }) });
  assert.deepEqual(plain(near.map(r => r.bx)), [1, 0], 'nearer (bigger on screen) first');
  const deep = Roi.rankVisible({ bricks: bricks.slice(0, 2), dims, planes: [], project: (u) => ({ x: 0, y: 0, depth: u < 0.25 ? 4 : 1 }), maxDepth: 2 });
  assert.deepEqual(plain(deep.map(r => r.bx)), [1], 'a brick deeper than maxDepth is left out (the resident level resolves it)');
  assert.equal(deep[0].depth, 1, 'each entry carries its depth');
  assert.equal(Roi.boxOutside({ x: 0, y: 0, z: 0 }, { x: 1, y: 1, z: 1 }, [[0, 0, 1, -1.01]]), true, 'box behind a plane');

  const rk = (keys) => keys.map(k => ({ key: k, bx: 0, by: 0, bz: 0 }));
  const resident = new Set(['a', 'c', 'x', 'y']);
  const plan = Roi.plan({ ranked: rk(['a', 'b', 'c', 'd', 'e']), isResident: k => resident.has(k), inFlight: new Set(['d']), capacity: 4, residentKeys: ['x', 'a', 'y', 'c'] });
  assert.deepEqual(plain(plan.want), ['a', 'b', 'c', 'd'], 'the capacity most important');
  assert.deepEqual(plain(plan.load.map(r => r.key)), ['b'], 'neither resident nor in flight');
  assert.deepEqual(plain(plan.keep), ['c', 'a'], 'kept, least important first (touched last = most recent)');
  assert.deepEqual(plain(plan.evict), ['x', 'y'], 'resident but unwanted, least recently used first');
  assert.equal(plan.inView, 5);
  assert.equal(plan.dropped, 1, 'one brick in view does not fit');
  console.log('frustum ∩ clip culling, priority, round plan within the capacity: OK');
}

{
  // Residency: touch keeps a brick, the LRU recycles the others, evict frees a slot.
  const gl = { NO_ERROR: 0, getError: () => 0, createTexture: () => ({}), deleteTexture() {}, bindTexture() {}, getParameter: () => null, texParameteri() {}, texStorage3D() {} };
  const props = new Map();
  const renderer = { capabilities: { max3DTextureSize: 2048 }, getContext: () => gl, properties: { get: (o) => { if (!props.has(o)) props.set(o, {}); return props.get(o); } } };
  const u = () => ({ value: null });
  const material = { defines: {}, uniforms: { detailPageTable: u(), detailAtlas0: u(), detailAtlasDim: u(), detailVolumeDim: u(), detailPtDim: u(), detailSlotStride: u(), detailApron: u(), detailPageCount: u() } };
  const svr = new SVR();
  svr.init(1, { x: 64 * 20, y: 64, z: 64, brickStride: 66, apron: 1 }, renderer, material, { role: 'detail', components: 1, targetSlots: 16, budgetBytes: 1024 ** 3 });
  assert.equal(material.defines.ROI_DETAIL, 1, 'a detail atlas publishes ROI_DETAIL');
  assert.equal(material.defines.ROI_DETAIL_COMPONENTS, 1);
  assert.equal(material.uniforms.detailSlotStride.value, 66);
  assert.equal(material.uniforms.detailPageCount.value, svr.atlases.length);
  svr._uploadRgbaRegion = () => true;
  const cap = svr.maxSlots;
  const brick = new Uint8Array(66 ** 3);
  for (let i = 0; i < cap; i++) svr.writeRgbaBrick(i, 0, 0, brick, 66, 66, 66);
  svr.touch(0, 0, 0);
  svr.writeRgbaBrick(cap, 0, 0, brick, 66, 66, 66);
  assert.equal(svr.has(0, 0, 0), true, 'a touched brick survives');
  assert.equal(svr.has(1, 0, 0), false, 'the least recently used one was recycled');
  assert.equal(svr.residentCount(), cap);
  assert.equal(svr.evict(2, 0, 0), true);
  assert.equal(svr.has(2, 0, 0), false);
  assert.equal(svr.freeSlots.length, 1, 'evict frees the slot');
  assert.equal(svr.residentKeys()[svr.residentKeys().length - 1], `${cap}_0_0`, 'most recent last');
  SVR.unpublishDetail(material);
  assert.ok(!('ROI_DETAIL' in material.defines) && material.uniforms.detailPageCount.value === 0, 'unpublish removes the define and the pages');
  console.log('detail atlas residency (touch, LRU recycle, evict, publish/unpublish): OK');
}

// ── The viewer world ──────────────────────────────────────────────────────────
function makeGl() {
  const log = { storage: [], subImage: [], params: [] };
  const gl = {
    log,
    NO_ERROR: 0, CONTEXT_LOST_WEBGL: 0x9242, TEXTURE_3D: 0x806f, TEXTURE_BINDING_3D: 0x806a,
    R8: 0x8229, RG8: 0x822b, RGBA8: 0x8058, RED: 0x1903, RG: 0x8227, RGBA: 0x1908, UNSIGNED_BYTE: 0x1401,
    LINEAR: 0x2601, NEAREST: 0x2600, CLAMP_TO_EDGE: 0x812f, TEXTURE_MIN_FILTER: 0x2801, TEXTURE_MAG_FILTER: 0x2800,
    TEXTURE_WRAP_S: 0x2802, TEXTURE_WRAP_T: 0x2803, TEXTURE_WRAP_R: 0x8072, PIXEL_UNPACK_BUFFER: 0x88ec,
    UNPACK_ALIGNMENT: 0x0cf5, UNPACK_ROW_LENGTH: 0x0cf2, UNPACK_IMAGE_HEIGHT: 0x806e, UNPACK_SKIP_PIXELS: 0x0cf4,
    UNPACK_SKIP_ROWS: 0x0cf3, UNPACK_SKIP_IMAGES: 0x806d, UNPACK_FLIP_Y_WEBGL: 0x9240, UNPACK_PREMULTIPLY_ALPHA_WEBGL: 0x9241, RENDERER: 0x1f01,
    getError: () => 0, getExtension: () => null, getParameter: (p) => (p === 0x1f01 ? 'Test GPU' : null), isContextLost: () => false,
    createTexture: () => ({}), deleteTexture() {}, bindTexture() {}, pixelStorei() {}, bindBuffer() {},
    texParameteri(t, p, v) { log.params.push([p, v]); },
    texStorage3D(target, levels, internal, w, h, d) { log.storage.push({ internal, w, h, d }); },
    texImage3D() {},
    texSubImage3D(target, level, x, y, z, w, h, d, format, type, data) { log.subImage.push({ x, y, z, w, h, d, format, bytes: data.length, data: data.slice(0, Math.min(data.length, 4096)) }); }
  };
  return gl;
}

function makeWorld({ files, max3D = 2048, fetchMode = 'multipart', delay = 0 }) {
  const gl = makeGl();
  const canvas = {
    style: {}, clientWidth: 800, clientHeight: 600, parentElement: { clientWidth: 800, clientHeight: 600, style: {} },
    addEventListener() {}, getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 })
  };
  const props = new WeakMap();
  const renderer = {
    domElement: canvas,
    capabilities: { max3DTextureSize: max3D, isWebGL2: true, maxTextureSize: 4096 },
    properties: { get(o) { let p = props.get(o); if (!p) { p = {}; props.set(o, p); } return p; }, remove(o) { props.delete(o); } },
    state: { bindTexture() {}, bindFramebuffer() {} },
    getContext: () => gl,
    setSize() {}, setPixelRatio(r) { this._pr = r; }, getPixelRatio() { return this._pr || 1; },
    setClearColor() {}, getClearColor(c) { return c; }, getClearAlpha() { return 1; },
    getSize(v) { return v.set(800, 600); },
    getRenderTarget() { return null; }, setRenderTarget() {}, clear() {}, render() {}, dispose() {}
  };
  const THREE = Object.assign({}, REAL_THREE, { WebGLRenderer: function WebGLRenderer() { return renderer; } });
  const fetchImpl = mockFetch(files, { mode: fetchMode, delay });
  const ctx = vm.createContext({
    console: { log() {}, warn() {}, error() {}, info() {} },
    setTimeout, clearTimeout, Promise, URL, Map, Set, WeakMap, Uint8Array, Float64Array, Int32Array, ArrayBuffer, DataView, TextDecoder,
    AbortController, DOMException, CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
    MessageChannel, Blob, Response, crypto: webcrypto,
    THREE, window: { devicePixelRatio: 1, addEventListener() {}, dispatchEvent() { return true; } },
    fetch: fetchImpl, Worker: VmBrickWorker,
    performance: { now: () => Date.now() },
    navigator: { hardwareConcurrency: 3, deviceMemory: 8 },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    requestAnimationFrame: (cb) => setTimeout(() => cb(Date.now()), 0),
    cancelAnimationFrame: (id) => clearTimeout(id),
    document: { getElementById: (id) => (id === 'webgl-canvas' ? canvas : null), createElement: () => ({ getContext: () => ({}) }) }
  });
  vm.runInContext(read('js/core/svr-manager.js'), ctx, { filename: 'svr-manager.js' });
  vm.runInContext(read('js/core/brick-loader.js'), ctx, { filename: 'brick-loader.js' });
  vm.runInContext(read('js/viewers/volume-viewer.js') + '\n;globalThis.__VV = VolumeViewer; globalThis.__SVR = SVRManager; globalThis.__BL = BrickLoader;', ctx, { filename: 'volume-viewer.js' });
  ctx.__BL.configure({ decodeWorkers: 1 });
  return { gl, ctx, renderer, fetch: fetchImpl, VV: ctx.__VV, SVR: ctx.__SVR, BL: ctx.__BL };
}

const value = (k, c, x, y, z) => 1 + ((x * 7 + y * 13 + z * 29 + c * 101 + k * 53) % 250);
const meta = (id, dims, channels) => ({ id, type: '3d', dimensions: { ...dims, c: channels }, voxel_size: { x: 0.5, y: 0.5, z: 2 } });

// ── Quality presets → levels (SPEC §13.7) ────────────────────────────────────
{
  const W = makeWorld({ files: new Map() });
  const manifest = { schema: 'iribhm-bricks-v3', version: 3, levels: [2048, 1024, 512, 256].map((s, level) => ({ level, dimensions: { x: s, y: s * 0.75, z: 100 }, voxelSize: { x: 1 << level, y: 1 << level, z: 2 } })) };
  const q = W.VV.getQualityLevels(['256x256', '512x512', '1024x1024', 'native'], manifest);
  assert.deepEqual(plain(q.map(r => [r.key, r.level])), [['256x256', 3], ['512x512', 2], ['1024x1024', 1], ['native', 0]],
    '"512" = finest with max(x, y) ≤ 768, "1024" ≤ 1536, native = 0');
  assert.deepEqual(plain(q[1].dims), { x: 512, y: 384, z: 100 }, 'the real dimensions travel with the level');
  const odd = { ...manifest, levels: [{ level: 0, dimensions: { x: 3000, y: 3000, z: 9 } }, { level: 1, dimensions: { x: 1500, y: 1500, z: 9 } }] };
  assert.deepEqual(plain(W.VV.getQualityLevels(['512x512', '1024x1024'], odd).map(r => r.level)), [1, 1], 'none small enough: the coarsest');
  const v2 = { levels: [{ dimensions: { x: 1000, y: 1000, z: 50 } }, { dimensions: { x: 500, y: 500, z: 50 } }] };
  assert.deepEqual(plain(W.VV.getQualityLevels(['512x512', '1024x1024'], v2).map(r => r.level)), [1, 0], 'v2 keeps the nearest-size rule');
  console.log('quality presets map to v3 levels by XY size: OK');
}

// ── Live v3: one tree per timepoint ──────────────────────────────────────────
{
  const W = makeWorld({ files: new Map() });
  const root = { schema: 'iribhm-bricks-v3', version: 3, channels: 1, levels: [], timepoints: [
    { path: 't000', index: { url: 't000/index.bin', bytes: 10, sha256: 'a'.repeat(64) } },
    { path: 't001', index: { url: 't001/index.bin', bytes: 12, sha256: 'b'.repeat(64) } },
    { path: 't002', index: { url: 'index.bin', bytes: 12, sha256: 'c'.repeat(64) } }
  ] };
  const s1 = W.VV.selectBrickManifest(root, 1);
  assert.equal(s1.available, true);
  assert.equal(s1.subPath, 't001');
  assert.equal(s1.manifest.index.url, 'index.bin', 'the index relative to its own tree');
  assert.equal(s1.manifest.index.sha256, 'b'.repeat(64));
  assert.equal(s1.manifest.timepoints, null);
  assert.equal(W.VV.selectBrickManifest(root, 1).manifest, s1.manifest, 'the same timepoint yields the same manifest object');
  assert.equal(W.VV.selectBrickManifest(root, 2).available, false, 'an index outside its tree is refused');
  assert.equal(W.VV.selectBrickManifest(root, 7).available, false);
  // A frame's own histograms (timepointHistograms) set its background floor, as in v2.
  const hRoot = [{ total: 10, counts: [5, 5] }];
  const h1 = [{ total: 20, counts: [2, 18], backgroundFloor: 12 }];
  const withHist = { ...root, histograms: hRoot, timepointHistograms: { t001: h1 } };
  const sh1 = W.VV.selectBrickManifest(withHist, 1);
  assert.deepEqual(plain(sh1.histograms), plain(h1), "the frame's histograms");
  assert.deepEqual(plain(sh1.manifest.histograms), plain(h1));
  assert.deepEqual(plain(W.VV.selectBrickManifest(withHist, 0).histograms), plain(hRoot), 'no frame entry: the root histograms');
  console.log('live v3 manifests: per-timepoint tree and index: OK');
}

// ── A v3 level streamed into a bordered atlas ────────────────────────────────
const BASE_SVR = 'D/s/bricks';
// Pages are n·66 texels (n ≥ 4): with max3D = 264 a level wider than 264 needs the
// atlas, a narrower one fits a dense texture.
const LEVELS = [
  { dims: { x: 600, y: 300, z: 64 }, voxelSize: { x: 0.5, y: 0.5, z: 2 } },
  { dims: { x: 300, y: 150, z: 64 }, voxelSize: { x: 1, y: 1, z: 2 } },
  { dims: { x: 150, y: 75, z: 64 }, voxelSize: { x: 2, y: 2, z: 2 } }
];
const tree2 = buildV3Tree({ base: BASE_SVR, channels: 2, levels: LEVELS, value, perPack: 4 });
{
  const W = makeWorld({ files: tree2.files, max3D: 264 });
  W.SVR.setVramBudget(2048 * MiB);
  W.VV.setDetailMode('off');
  W.VV.init('webgl-canvas');
  const res = await W.VV.loadBrickedVolumeStream('D/s', meta('D/s', LEVELS[0].dims, 2), null, null, { quality: 'lod1' });
  assert.equal(res.available, true, res.reason);
  assert.equal(res.lod, 1);
  assert.equal(res.failedLoads, 0);
  assert.deepEqual(plain([res.width, res.height, res.depth]), [300, 150, 64]);
  const atlas = W.gl.log.storage.find(s => s.internal === W.gl.RG8);
  assert.ok(atlas && atlas.w % 66 === 0 && atlas.d % 66 === 0, 'a two-channel bordered atlas: RG8 pages in multiples of 66');
  assert.ok(W.gl.log.params.some(([p, v]) => p === W.gl.TEXTURE_MIN_FILTER && v === W.gl.LINEAR), 'LINEAR filtering');
  const bricks = W.gl.log.subImage.filter(u => u.format === W.gl.RG);
  assert.equal(bricks.length, 5 * 3 * 1, 'one upload per brick');
  assert.ok(bricks.every(u => u.x % 66 === 0 && u.y % 66 === 0 && u.z % 66 === 0 && u.w <= 66 && u.h <= 66 && u.d <= 66), 'each at its slot origin, ≤ 66³');
  // Edge brick (4, 2, 0) of 300 × 150 × 64: stored voxels in [−1, dim] → 300 − 256 + 2 = 46, 150 − 128 + 2 = 24, 66.
  assert.ok(bricks.some(u => u.w === 46 && u.h === 24 && u.d === 66), 'an edge brick keeps one border voxel past the volume');
  const m = W.VV.getMaterial();
  assert.equal(m.uniforms.slotStride.value, 66);
  assert.equal(m.uniforms.brickApron.value, 1);
  assert.equal(m.defines.SVR_COMPONENTS, 2);
  // First uploaded texel of brick (0, 0, 0): stored voxel (0,0,0) = volume voxel (−1,−1,−1) clamped = (0,0,0).
  const b000 = bricks.find(u => u.w === 66 && u.h === 66 && u.d === 66);
  assert.ok(b000, 'an interior brick arrives whole (66³)');
  const lvl = W.VV.getActiveLevel();
  assert.deepEqual(plain([lvl.level, lvl.treeVersion, lvl.apron, lvl.components, lvl.mode]), [1, 3, 1, 2, 'svr']);
  // Real per-level bytes: RG8 66³ slots + page table.
  const fp = W.VV.getQualityFootprints(['lod1']).levels.find(l => l.lod === 1);
  assert.equal(fp.components, 2);
  assert.equal(fp.stride, 66);
  assert.equal(fp.bytes % 1, 0);
  assert.ok(fp.bytes >= 15 * 66 ** 3 * 2 + 15 * 4, 'priced as 66³ RG8 slots + page table');
  W.VV.dispose();
  console.log('v3 level → bordered RG8 atlas (66³ slots, LINEAR, edge borders, footprint): OK');
}

// ── A v3 level that fits a dense texture: interiors at 64·b ──────────────────
{
  const BASE = 'D/d/bricks';
  const levels = [{ dims: { x: 150, y: 100, z: 70 }, voxelSize: { x: 1, y: 1, z: 1 } }];
  const tree = buildV3Tree({ base: BASE, channels: 1, levels, value, perPack: 3 });
  const W = makeWorld({ files: tree.files, max3D: 2048 });
  W.SVR.setVramBudget(2048 * MiB);
  W.VV.setDetailMode('off');
  W.VV.init('webgl-canvas');
  const res = await W.VV.loadBrickedVolumeStream('D/d', meta('D/d', levels[0].dims, 1), null, null, { quality: 'native' });
  assert.equal(res.available, true, res.reason);
  assert.ok(W.gl.log.storage.some(s => s.internal === W.gl.R8 && s.w === 150 && s.h === 100 && s.d === 70), 'one dense R8 texture of the level');
  const ups = W.gl.log.subImage.filter(u => u.format === W.gl.RED);
  assert.equal(ups.length, 3 * 2 * 2);
  assert.ok(ups.every(u => u.x % 64 === 0 && u.y % 64 === 0 && u.z % 64 === 0 && u.w <= 64 && u.h <= 64 && u.d <= 64), 'interiors at 64·b');
  const edge = ups.find(u => u.x === 128 && u.y === 64 && u.z === 64);
  assert.deepEqual(plain([edge.w, edge.h, edge.d]), [22, 36, 6], 'the edge interior, no border');
  // The first row of brick (2,1,1): volume voxels x = 128..149 at (y, z) = (64, 64) — floor LUT applied by the loader.
  // Its first texels: volume voxels (128…, 64, 64), through the stream's background-
  // floor LUT (no histogram in the manifest: floor 8, v ≤ 8 → 0, else (v − 8)·255/247).
  const lut = (v) => (v <= 8 ? 0 : Math.min(255, Math.round((v - 8) * 255 / 247)));
  assert.deepEqual(plain(Array.from(edge.data.subarray(0, 22))), Array.from({ length: 22 }, (_, i) => lut(value(0, 0, 128 + i, 64, 64))),
    'the interior row, not the border (stored voxel 1 is volume voxel 64·b)');
  W.VV.dispose();
  console.log('v3 level → dense texture holding the 64³ interiors: OK');
}

// ── Region of interest ───────────────────────────────────────────────────────
{
  const W = makeWorld({ files: tree2.files, max3D: 264 });
  W.SVR.setVramBudget(2048 * MiB);
  W.VV.setDetailMode('auto');
  W.VV.init('webgl-canvas');
  const statuses = [];
  W.VV.onDetailStatus(s => statuses.push(s));
  // Every round's loader batch, recorded.
  const batches = [];
  const orig = W.BL.loadBrickTasks;
  W.BL.loadBrickTasks = async (tasks, options) => {
    const rec = { group: options.group, tasks: tasks.length, byteRanges: options.byteRanges === true, summary: null };
    batches.push(rec);
    const r = await orig(tasks, options);
    rec.summary = r.summary;
    return r;
  };
  const res = await W.VV.loadBrickedVolumeStream('D/s', meta('D/s', LEVELS[0].dims, 2), null, null, { quality: 'lod2' });
  assert.equal(res.lod, 2);
  // Far away: a level-2 voxel covers well under 1.5 px.
  W.VV.setCameraState({ kind: 'volume', cameraZ: 12 });
  W.VV.refreshDetail();
  await sleep(500);
  assert.equal(W.VV.getDetailStatus().active, false);
  assert.equal(W.VV.getDetailStatus().reason, 'zoomed-out');
  assert.ok(!batches.some(b => b.group === 'roi'), 'no detail round while the resident level suffices');

  // Zoom in: the camera close to the volume.
  W.VV.setCameraState({ kind: 'volume', cameraZ: 0.9 });
  W.VV.refreshDetail();
  await waitFor(() => W.VV.getDetailStatus().reason === 'ready', 10000, 'first detail round');
  const st = W.VV.getDetailStatus();
  assert.equal(st.active, true);
  assert.ok(st.level === 0 || st.level === 1, 'a finer level');
  assert.ok(st.inView > 0 && st.resident === Math.min(st.inView, st.capacity), 'every brick in view (within capacity) resident');
  assert.match(st.message, /Detail: \d+ bricks of level \d in view/);
  const m = W.VV.getMaterial();
  assert.equal(m.defines.ROI_DETAIL, 1, 'the shader samples the detail atlas');
  assert.equal(m.defines.ROI_DETAIL_COMPONENTS, 2);
  assert.ok(m.uniforms.detailPageTable.value, 'detail page table bound');
  assert.equal(m.uniforms.detailSlotStride.value, 66);
  const roiBatch = batches.filter(b => b.group === 'roi');
  assert.ok(roiBatch.length >= 1 && roiBatch.every(b => b.tasks <= 24 * 2), 'short batches: at most 24 bricks each');
  assert.equal(roiBatch.reduce((n, b) => n + b.tasks, 0), st.resident * 2, 'one task per wanted brick and channel, none twice');
  assert.ok(st.wanted <= st.inView && st.resident === st.wanted, 'every wanted brick resident');
  const roiFetches = W.fetch.log.filter(e => /\/l(\d)\//.test(e.path) && Number(/\/l(\d)\//.exec(e.path)[1]) === st.level);
  assert.ok(roiFetches.length > 0, 'the finer level is fetched');
  assert.ok(roiBatch.every(b => b.byteRanges), 'detail batches ask byte ranges (a pack is fetched whole only when most of it is wanted)');

  // A second round while the first still loads: the first goes on (nothing downloaded
  // is thrown away), the next batch follows the new view, no brick is fetched twice.
  const slow = makeWorld({ files: tree2.files, max3D: 264, delay: 150 });
  slow.SVR.setVramBudget(2048 * MiB);
  slow.VV.setDetailMode('on');
  slow.VV.init('webgl-canvas');
  const sb = [];
  const so = slow.BL.loadBrickTasks;
  slow.BL.loadBrickTasks = async (tasks, options) => {
    const rec = { group: options.group, keys: tasks.map(t => `${t.bx}_${t.by}_${t.bz}:${t.channel}`), summary: null };
    sb.push(rec);
    const r = await so(tasks, options);
    rec.summary = r.summary;
    return r;
  };
  await slow.VV.loadBrickedVolumeStream('D/s', meta('D/s', LEVELS[0].dims, 2), null, null, { quality: 'lod2' });
  slow.VV.setCameraState({ kind: 'volume', cameraZ: 0.9 });
  slow.VV.refreshDetail();
  await waitFor(() => sb.some(b => b.group === 'roi'), 5000, 'slow round started');
  slow.VV.setCameraState({ kind: 'volume', cameraZ: 0.9, position: [0.3, 0, 0] });
  slow.VV.refreshDetail();
  await waitFor(() => slow.VV.getDetailStatus().reason === 'ready', 20000, 'rounds done');
  const slowRoi = sb.filter(b => b.group === 'roi');
  assert.ok(slowRoi.every(b => b.summary && !b.summary.cancelled), 'a camera move cancels no batch');
  const all = slowRoi.flatMap(b => b.keys);
  assert.equal(new Set(all).size, all.length, 'no brick fetched twice');
  slow.VV.dispose();

  // Zoom out: the detail atlas stays (finer is never wrong) and nothing more is fetched;
  // zooming back in finds its bricks there.
  const roiBefore = batches.filter(b => b.group === 'roi').length;
  W.VV.setCameraState({ kind: 'volume', cameraZ: 6 });
  W.VV.refreshDetail();
  await waitFor(() => W.VV.getDetailStatus().reason === 'zoomed-out', 5000, 'zoom-out');
  assert.equal(m.defines.ROI_DETAIL, 1, 'the detail atlas stays published');
  assert.equal(W.VV.getDetailStatus().active, false);
  W.VV.setCameraState({ kind: 'volume', cameraZ: 0.9 });
  W.VV.refreshDetail();
  await waitFor(() => W.VV.getDetailStatus().reason === 'ready', 10000, 'detail again');
  assert.equal(batches.filter(b => b.group === 'roi').length, roiBefore, 'zooming back in downloads nothing: the bricks were kept');

  // 'off' never streams; a new volume tears the detail down.
  await W.VV.loadBrickedVolumeStream('D/s', meta('D/s', LEVELS[0].dims, 2), null, null, { quality: 'lod1' });
  assert.ok(!('ROI_DETAIL' in m.defines) || W.VV.getDetailStatus().level === 0, 'the old detail went with its volume');
  W.VV.setDetailMode('off');
  assert.ok(!('ROI_DETAIL' in m.defines), "'off' drops it at once");
  assert.equal(W.VV.getDetailStatus().mode, 'off');
  W.VV.dispose();
  console.log('region of interest: short ranged batches, no cancellation on move, kept on zoom-out, released with the volume and off: OK');
}

// ── ROI within a small budget: capacity, eviction of bricks that left the view ─
{
  const W = makeWorld({ files: tree2.files, max3D: 264 });
  W.VV.setDetailMode('on');
  W.VV.init('webgl-canvas');
  // The dense base (150 × 75 × 64 RGBA8, 2.7 MiB) plus 3/4 of what is left must hold
  // exactly two layers of 4 × 4 slots of 66³ RG8 (17.5 MiB): 32 slots.
  W.SVR.setVramBudget(29 * MiB);
  const res = await W.VV.loadBrickedVolumeStream('D/s', meta('D/s', LEVELS[0].dims, 2), null, null, { quality: 'lod2' });
  assert.equal(res.available, true);
  W.VV.setCameraState({ kind: 'volume', cameraZ: 0.6 });
  W.VV.refreshDetail();
  await waitFor(() => W.VV.getDetailStatus().reason === 'ready', 10000, 'budgeted round');
  const st = W.VV.getDetailStatus();
  assert.equal(st.capacity, 32, 'the detail atlas takes what the budget leaves');
  assert.ok(st.inView > st.capacity, 'more bricks in view than fit');
  assert.equal(st.resident, 32, 'the 32 most important are resident');
  assert.ok(W.SVR.liveAtlasBytes() <= 29 * MiB, 'every atlas within the budget');
  const atlasBytes = W.SVR.liveAtlasBytes();
  const fetchedBefore = W.fetch.log.length;
  // Pan: other bricks come into view, those that left it are recycled.
  W.VV.setCameraState({ kind: 'volume', cameraZ: 0.6, position: [0.4, 0.2, 0] });
  W.VV.refreshDetail();
  await sleep(450);
  await waitFor(() => W.VV.getDetailStatus().reason === 'ready', 10000, 'panned round');
  const st2 = W.VV.getDetailStatus();
  assert.equal(st2.resident, Math.min(st2.inView, 32), 'what is in view now is resident, within the same 32 slots');
  assert.ok(W.fetch.log.length > fetchedBefore, 'the newly visible bricks were fetched');
  assert.equal(W.SVR.liveAtlasBytes(), atlasBytes, 'no new allocation: slots recycled');
  W.VV.dispose();
  W.SVR.setVramBudget(null);
  console.log('region of interest within the VRAM budget (capacity, recycling on pan): OK');
}

// ── A v2 tree keeps the 1.58 behaviour: no detail streaming ─────────────────
{
  const BRICK = 64 ** 3;
  const files = new Map();
  const b2p = {};
  const chunksOf = (nx, ny, nz) => { const out = []; for (let bz = 0; bz < nz; bz++) for (let by = 0; by < ny; by++) for (let bx = 0; bx < nx; bx++) out.push({ id: `${bz}_${by}_${bx}` }); return out; };
  const levels = [
    { level: 0, dimensions: { x: 512, y: 256, z: 64 }, chunks: chunksOf(8, 4, 1) },
    { level: 1, dimensions: { x: 256, y: 128, z: 64 }, chunks: chunksOf(4, 2, 1) },
    { level: 2, dimensions: { x: 128, y: 64, z: 64 }, chunks: chunksOf(2, 1, 1) }
  ];
  for (const lv of levels) {
    for (const ch of lv.chunks) {
      const [bz, by, bx] = ch.id.split('_').map(Number);
      const rel = `lod${lv.level}/c0/x${String(bx).padStart(3, '0')}_y${String(by).padStart(3, '0')}_z${String(bz).padStart(3, '0')}.webp`;
      const url = `pk/${lv.level}_${ch.id}.bin`;
      files.set(`D/v2/bricks/${url}`, new Uint8Array(BRICK).fill(40 + lv.level));
      b2p[rel] = { url, offset: 0, length: BRICK };
    }
  }
  const manifest = { channels: 1, brickSize: 64, levels, brickTransport: { encoding: 'raw-u8', mode: 'packs', brickToPack: b2p } };
  files.set('D/v2/bricks/manifest.json', new TextEncoder().encode(JSON.stringify(manifest)));
  const W = makeWorld({ files, max3D: 2048 });
  W.SVR.setVramBudget(2048 * MiB);
  W.VV.setDetailMode('on');
  W.VV.init('webgl-canvas');
  const batches = [];
  const orig = W.BL.loadBrickTasks;
  W.BL.loadBrickTasks = async (tasks, options) => { batches.push(options.group); return orig(tasks, options); };
  const res = await W.VV.loadBrickedVolumeStream('D/v2', meta('D/v2', levels[0].dimensions, 1), null, null, { quality: 'lod2' });
  assert.equal(res.available, true, res.reason);
  assert.equal(res.lod, 2);
  assert.equal(W.VV.getActiveLevel().treeVersion, 2);
  W.VV.setCameraState({ kind: 'volume', cameraZ: 0.6 });
  W.VV.refreshDetail();
  await waitFor(() => W.VV.getDetailStatus().reason === 'unsupported', 5000, 'v2 detail refused');
  assert.ok(!batches.includes('roi'), 'no detail batch on a v2 tree');
  assert.ok(!('ROI_DETAIL' in W.VV.getMaterial().defines), 'the shader keeps the v2 permutation');
  W.VV.dispose();
  console.log('v2 tree: no region-of-interest streaming (1.58 behaviour): OK');
}

console.log('v3 render + region of interest: OK');
