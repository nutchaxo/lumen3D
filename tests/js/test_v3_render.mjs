// v3 brick trees in the viewer.
//
// End to end (the real volume-viewer.js + brick-loader.js + svr-manager.js +
// brick-decode-worker.js in a vm, a v3 tree served from memory by the loader tests'
// fixtures, a recording WebGL stub):
//   • quality presets map to levels per SPEC §13.7 and getQualityLevels reports them;
//   • a v3 level streams into a bordered atlas (66³ slots, R8 / RG8) or, when it fits,
//     a dense texture holding the 64³ interiors at 64·b;
//   • live v3 manifests: one tree per timepoint, its index inside it (memoised).
//
// Run: node tests/js/test_v3_render.mjs
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

console.log('v3 render: OK');
