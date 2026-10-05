// VolumeViewer streaming, end to end without a browser: the real volume-viewer.js,
// brick-loader.js and svr-manager.js run in one context against the real three.js,
// with only the GPU (a recording WebGL stub behind a stub WebGLRenderer), the network
// (raw-u8 bricks served from memory) and the DOM stubbed.
//   • a dense level is allocated with texStorage3D (no zero upload), filled brick by
//     brick with texSubImage3D, and keeps no CPU copy of the volume;
//   • a level over the VRAM budget is never allocated: the next coarser one is, and
//     the result says why (downgradeReason 'vram-budget');
//   • a brick that cannot be loaded is reported (failedLoads, status) and the volume
//     is shown but not cached as complete;
//   • coarse-first shows the coarsest level, fires onFirstPicture, then swaps in the
//     requested level;
//   • getQualityFootprints prices every level as the stream would allocate it;
//   • the depth pick decodes the GPU pick target, and falls back to a flagged
//     bounding-box point when the ray finds nothing;
//   • denoise is reported unavailable on a sparse atlas;
//   • a WebGL context loss halves the budget, frees every volume, and the restore
//     replays the last load;
//   • dispose() deletes the GL textures and removes the listeners.
//
// Run: node tests/js/test_render_stream_integration.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT } from './harness.mjs';

const require = createRequire(import.meta.url);
const REAL_THREE = require('../../js/vendor/three.min.js');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');
const MiB = 1024 * 1024;

// ── WebGL stub ────────────────────────────────────────────────────────────────
function makeGl() {
  const log = { storage: [], subImage: [], texImage: 0, deleted: 0, created: 0 };
  let nextError = 0;
  const gl = {
    log,
    NO_ERROR: 0, OUT_OF_MEMORY: 0x0505, CONTEXT_LOST_WEBGL: 0x9242, TEXTURE_3D: 0x806f, TEXTURE_BINDING_3D: 0x806a,
    R8: 0x8229, RGBA8: 0x8058, RED: 0x1903, RG: 0x8227, RG8: 0x822b, RGBA: 0x1908, UNSIGNED_BYTE: 0x1401,
    LINEAR: 0x2601, NEAREST: 0x2600, CLAMP_TO_EDGE: 0x812f, TEXTURE_MIN_FILTER: 0x2801, TEXTURE_MAG_FILTER: 0x2800,
    TEXTURE_WRAP_S: 0x2802, TEXTURE_WRAP_T: 0x2803, TEXTURE_WRAP_R: 0x8072, PIXEL_UNPACK_BUFFER: 0x88ec,
    UNPACK_ALIGNMENT: 0x0cf5, UNPACK_ROW_LENGTH: 0x0cf2, UNPACK_IMAGE_HEIGHT: 0x806e, UNPACK_SKIP_PIXELS: 0x0cf4,
    UNPACK_SKIP_ROWS: 0x0cf3, UNPACK_SKIP_IMAGES: 0x806d, UNPACK_FLIP_Y_WEBGL: 0x9240, UNPACK_PREMULTIPLY_ALPHA_WEBGL: 0x9241,
    RENDERER: 0x1f01,
    failNextAllocation: false,
    getError() { const e = nextError; nextError = 0; return e; },
    getExtension() { return null; },
    getParameter(p) { return p === gl.RENDERER ? 'Test GPU' : null; },
    isContextLost() { return false; },
    createTexture() { log.created++; return { id: log.created }; },
    deleteTexture() { log.deleted++; },
    bindTexture() {},
    texParameteri() {},
    pixelStorei() {},
    bindBuffer() {},
    texStorage3D(target, levels, internal, w, h, d) {
      log.storage.push({ internal, w, h, d });
      if (gl.failNextAllocation) { gl.failNextAllocation = false; nextError = gl.OUT_OF_MEMORY; }
    },
    texImage3D() { log.texImage++; },
    texSubImage3D(target, level, x, y, z, w, h, d, format, type, data) {
      log.subImage.push({ x, y, z, w, h, d, format, bytes: data.length, first: Array.from(data.subarray(0, 8)) });
    },
    // Read-back of one Z layer of a 3D texture (the denoise path): every texel reads
    // (10 + z, 20 + z, 0, 255).
    FRAMEBUFFER: 0x8d40, COLOR_ATTACHMENT0: 0x8ce0, FRAMEBUFFER_COMPLETE: 0x8cd5,
    _layer: 0,
    createFramebuffer() { return {}; },
    deleteFramebuffer() {},
    framebufferTextureLayer(target, attachment, tex, level, layer) { gl._layer = layer; },
    checkFramebufferStatus() { return gl.FRAMEBUFFER_COMPLETE; },
    readPixels(x, y, w, h, format, type, buf) {
      log.readLayers = (log.readLayers || 0) + 1;
      for (let i = 0; i < w * h; i++) { buf[i * 4] = 10 + gl._layer; buf[i * 4 + 1] = 20 + gl._layer; buf[i * 4 + 2] = 0; buf[i * 4 + 3] = 255; }
    },
  };
  return gl;
}

// The blur worker pool, answering in a macrotask: each chunk comes back +1 (a stand-in
// for the filter), or as an error when `fail` is set.
function makeBlurWorker(state) {
  return class Worker {
    constructor() { this.onmessage = null; }
    postMessage(msg) {
      setTimeout(() => {
        if (state.fail) {
          this.onmessage?.({ data: { type: 'error', taskId: msg.taskId, chunkIndex: msg.chunkIndex, message: 'boom' } });
          return;
        }
        const out = new Uint8Array(msg.rawData).map(v => v + 1);
        this.onmessage?.({ data: { type: 'result', taskId: msg.taskId, chunkIndex: msg.chunkIndex, blurredData: out, effectiveSigma: msg.sigma } });
      }, 0);
    }
    terminate() {}
  };
}

// ── The viewer's world ────────────────────────────────────────────────────────
function makeWorld({ max3D = 256, blurWorker = null } = {}) {
  const gl = makeGl();
  const listeners = new Map();
  const canvas = {
    style: {},
    clientWidth: 800,
    clientHeight: 600,
    parentElement: { clientWidth: 800, clientHeight: 600, style: {} },
    addEventListener(type, fn, opts) { listeners.set(type, { fn, signal: opts?.signal || null }); },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
  };
  let pickBytes = [[64, 0, 128, 0], [192, 0, 255, 255]];   // x = .25, y = .5, z = .75, hit
  const props = new WeakMap();
  let renderTarget = null;
  const renderer = {
    domElement: canvas,
    capabilities: { max3DTextureSize: max3D, isWebGL2: true, maxTextureSize: 4096 },
    properties: {
      get(o) { let p = props.get(o); if (!p) { p = {}; props.set(o, p); } return p; },
      remove(o) { props.delete(o); },
    },
    state: { bindTexture() {}, bindFramebuffer() {} },
    getContext: () => gl,
    setSize() {}, setPixelRatio(r) { this._pr = r; }, getPixelRatio() { return this._pr || 1; },
    setClearColor() {}, getClearColor(c) { return c; }, getClearAlpha() { return 1; },
    getSize(v) { return v.set(800, 600); },
    getRenderTarget() { return renderTarget; }, setRenderTarget(t) { renderTarget = t; },
    clear() {}, render() {}, dispose() { this.disposed = true; },
    readRenderTargetPixels(target, x, y, w, h, buf) {
      const pass = world.VV.getMaterial().uniforms.pickPass.value;
      buf.set(pickBytes[pass]);
    },
  };
  const THREE = Object.assign({}, REAL_THREE, { WebGLRenderer: function WebGLRenderer() { return renderer; } });
  const events = [];
  const rafQueue = [];
  const window = {
    devicePixelRatio: 1,
    addEventListener() {},
    dispatchEvent(e) { events.push(e); return true; },
  };
  const files = new Map();
  let fetches = 0;
  const fetchImpl = async (url) => {
    fetches++;
    const key = String(url).split('?')[0];
    if (!files.has(key)) return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0), json: async () => null };
    const body = files.get(key);
    return { ok: true, status: 200, json: async () => body, arrayBuffer: async () => body.slice(0) };
  };
  const ctx = vm.createContext({
    console: { log() {}, warn() {}, error() {}, info() {} },
    setTimeout, clearTimeout, Promise, URL, Map, Set, WeakMap, Uint8Array, Float64Array, Int32Array, ArrayBuffer,
    AbortController, DOMException, CustomEvent, MessageChannel,
    THREE, window, fetch: fetchImpl,
    ...(blurWorker ? { Worker: blurWorker } : {}),
    performance: { now: () => Date.now() },
    navigator: { hardwareConcurrency: 1, deviceMemory: 8 },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    requestAnimationFrame: (cb) => setTimeout(() => cb(Date.now()), 0),
    cancelAnimationFrame: (id) => clearTimeout(id),
    document: {
      getElementById: (id) => (id === 'webgl-canvas' ? canvas : null),
      createElement: () => ({ getContext: () => ({}) }),
    },
  });
  vm.runInContext(read('js/core/svr-manager.js'), ctx, { filename: 'svr-manager.js' });
  vm.runInContext(read('js/core/brick-loader.js'), ctx, { filename: 'brick-loader.js' });
  vm.runInContext(read('js/viewers/volume-viewer.js') + '\n;globalThis.__VV = VolumeViewer; globalThis.__SVR = SVRManager; globalThis.__BL = BrickLoader;', ctx, { filename: 'volume-viewer.js' });
  // The render loop is driven by hand: a frame runs when the test (or a paint yield)
  // drains the queue, so a test never spins on 120 idle frames.
  const pump = async () => {
    for (let i = 0; i < 4; i++) {
      const batch = rafQueue.splice(0);
      batch.forEach(cb => { try { cb(Date.now()); } catch (e) { throw e; } });
      await new Promise(r => setTimeout(r, 0));
    }
  };
  // These scenarios test the stream itself: the region-of-interest rounds (which
  // the framing of this 800 × 600 view would start on LOD1) have their own test.
  ctx.__VV.setDetailMode('off');
  const world = {
    gl, canvas, listeners, renderer, events, files, ctx, rafQueue, pump,
    VV: ctx.__VV, SVR: ctx.__SVR, BL: ctx.__BL,
    setPick(bytes) { pickBytes = bytes; },
    fetches: () => fetches,
  };
  return world;
}

// A two-level, two-channel dataset served as raw-u8 bricks, one file per brick:
// LOD0 512×512×64 (8×8×1 bricks, wider than max3D = 256 → sparse atlas),
// LOD1 256×256×64 (4×4×1 bricks → one dense RGBA texture of 16 MiB).
function serveDataset(world, base, { missing = [] } = {}) {
  const levels = [[512, 512, 64], [256, 256, 64]].map(([x, y, z], level) => {
    const chunks = [];
    for (let by = 0; by < y / 64; by++) for (let bx = 0; bx < x / 64; bx++) chunks.push({ id: `0_${by}_${bx}` });
    return { level, dimensions: { x, y, z }, brickSize: 64, chunks };
  });
  const manifest = { channels: 2, levels, brickTransport: { encoding: 'raw-u8', mode: 'direct' } };
  world.files.set(`${base}/bricks/manifest.json`, manifest);
  const brick = new Uint8Array(64 * 64 * 64).fill(200).buffer;
  levels.forEach(({ level, dimensions }) => {
    for (let c = 0; c < 2; c++) {
      for (let by = 0; by < dimensions.y / 64; by++) {
        for (let bx = 0; bx < dimensions.x / 64; bx++) {
          const name = `x${String(bx).padStart(3, '0')}_y${String(by).padStart(3, '0')}_z000`;
          const url = `${base}/bricks/lod${level}/c${c}/${name}.bin`;
          if (!missing.includes(url)) world.files.set(url, brick);
        }
      }
    }
  });
  return {
    id: base, type: '3d',
    dimensions: { x: 512, y: 512, z: 64, c: 2 },
    voxel_size: { x: 1, y: 1, z: 2 }, optical_section_thickness_um: 2,
  };
}

const isStorage = (s, w, h, d) => s.w === w && s.h === h && s.d === d;

// ── 1. dense level: texStorage3D, brick uploads, no CPU copy, cached ─────────
{
  const W = makeWorld();
  W.VV.init('webgl-canvas');
  const meta = serveDataset(W, 'D/a');
  const res = await W.VV.loadBrickedVolumeStream('D/a', meta, null, null, { quality: '256x256' });
  assert.equal(res.available, true, 'the dense level streams');
  assert.equal(res.lod, 1);
  assert.equal(res.failedLoads, 0);
  assert.equal(res.degraded, false);
  assert.ok(W.gl.log.storage.some(s => isStorage(s, 256, 256, 64) && s.internal === W.gl.RGBA8), 'RGBA8 storage allocated');
  assert.equal(W.gl.log.texImage, 0, 'no texImage3D: no zero buffer uploaded');
  const uploads = W.gl.log.subImage.filter(u => u.w === 64 && u.h === 64 && u.d === 64);
  assert.equal(uploads.length, 16, 'one texSubImage3D per brick');
  assert.ok(uploads.every(u => u.bytes === 64 * 64 * 64 * 4), 'each brick composed RGBA by the loader');
  const sv = W.VV.getSamplingVolume();
  assert.equal(sv.data, null, 'no CPU mirror of the volume');
  assert.equal(W.VV.hasCachedVolume('D/a', '256x256', null), true, 'complete volume cached');
  const stats = W.VV.getCacheStats();
  assert.equal(stats.cachedGpuBytes, 256 * 256 * 64 * 4, 'priced at its real GPU size');
  assert.equal(stats.cachedCpuBytes, 0, 'no CPU bytes held');
  console.log('dense level streamed without a CPU copy: OK');

  // getQualityFootprints prices both levels as the stream allocates them.
  const fp = W.VV.getQualityFootprints(['256x256', 'native']);
  assert.equal(fp.levels.length, 2);
  assert.equal(fp.levels[0].mode, 'svr');
  // Two channels: RG8 slots (half of RGBA8), plus the page table (8 × 8 × 1 RGBA8 texels).
  assert.equal(fp.levels[0].components, 2, 'LOD0: a two-channel atlas is RG8');
  assert.equal(fp.levels[0].bytes, 32 * MiB + 8 * 8 * 4, 'LOD0: a 256×256×256 atlas of 64 half-MiB slots and its page table');
  assert.equal(fp.levels[1].mode, 'monolithic');
  assert.equal(fp.levels[1].bytes, 16 * MiB);
  assert.equal(fp.qualities.native.lod, 0);
  assert.equal(fp.qualities['256x256'].lod, 1);
  console.log('quality footprints: OK');

  // Depth pick: decoded from the pick target; nothing hit → flagged box point.
  const p = W.VV.pickVolumePoint(400, 300);
  assert.equal(p.depthSource, 'volume');
  assert.equal(p.onBoundingBox, false);
  assert.ok(Math.abs(p.normalized.x - 64 * 256 / 65535) < 1e-9 && Math.abs(p.normalized.z - 192 * 256 / 65535) < 1e-9, 'pick decoded from the 16-bit texels');
  W.setPick([[0, 0, 0, 0], [0, 0, 0, 0]]);
  const miss = W.VV.pickVolumePoint(400, 300);
  assert.equal(miss.depthSource, 'bounding-box');
  assert.equal(miss.onBoundingBox, true, 'a ray that finds nothing is flagged, not presented as a depth');
  console.log('depth pick: OK');

  // dispose(): GL textures deleted, listeners removed.
  const before = W.gl.log.deleted;
  const signal = W.listeners.get('pointerdown').signal;
  W.VV.dispose();
  assert.ok(W.gl.log.deleted > before, 'the dense texture is deleted');
  assert.equal(signal.aborted, true, 'canvas listeners removed');
  assert.equal(W.renderer.disposed, true, 'renderer disposed');
  console.log('dispose: OK');
}

// ── 2. sparse level within budget; denoise unavailable there ─────────────────
{
  const W = makeWorld();
  W.SVR.setVramBudget(1024 * MiB);
  W.VV.init('webgl-canvas');
  const meta = serveDataset(W, 'D/b');
  const res = await W.VV.loadBrickedVolumeStream('D/b', meta, null, null, { quality: 'native' });
  assert.equal(res.available, true);
  assert.equal(res.lod, 0);
  assert.equal(res.downgraded, false);
  assert.ok(W.gl.log.storage.some(s => isStorage(s, 256, 256, 256)), 'a 64-slot atlas page');
  assert.equal(W.gl.log.subImage.filter(u => u.d === 64).length, 64, 'every brick written into the atlas');
  W.events.length = 0;
  W.VV.updateChannel(0, { denoise_sigma: 2 });
  await new Promise(r => setTimeout(r, 0));
  const ev = W.events.find(e => e.type === 'volume-denoise-state');
  assert.ok(ev && ev.detail.available === false && ev.detail.reason === 'sparse-atlas', 'denoise says it is unavailable on a sparse atlas');
  assert.equal(W.VV.getCapabilities().denoise.available, false);
  W.VV.dispose();
  W.SVR.setVramBudget(null);
  console.log('sparse level + denoise capability: OK');
}

// ── 3. over the VRAM budget: the coarser level, never the allocation ─────────
{
  const W = makeWorld();
  W.SVR.setVramBudget(32 * MiB);
  W.VV.init('webgl-canvas');
  const meta = serveDataset(W, 'D/c');
  const res = await W.VV.loadBrickedVolumeStream('D/c', meta, null, null, { quality: 'native' });
  assert.equal(res.available, true);
  assert.equal(res.requestedLod, 0);
  assert.equal(res.lod, 1, 'degraded to the level that fits');
  assert.equal(res.downgraded, true);
  assert.equal(res.downgradeReason, 'vram-budget');
  assert.equal(res.neededBytes, 32 * MiB + 8 * 8 * 4, 'the refused level is priced (RG8 atlas + page table)');
  assert.ok(!W.gl.log.storage.some(s => isStorage(s, 256, 256, 256)), 'the over-budget atlas is never allocated');
  W.VV.dispose();
  W.SVR.setVramBudget(null);
  console.log('VRAM-aware level choice: OK');
}

// ── 4. a GPU that refuses the allocation: next level, reason alloc-failed ───
{
  const W = makeWorld();
  W.SVR.setVramBudget(1024 * MiB);
  W.VV.init('webgl-canvas');
  const meta = serveDataset(W, 'D/d');
  W.gl.failNextAllocation = true;
  const res = await W.VV.loadBrickedVolumeStream('D/d', meta, null, null, { quality: 'native' });
  assert.equal(res.available, true);
  assert.equal(res.lod, 1);
  assert.equal(res.downgradeReason, 'alloc-failed');
  W.VV.dispose();
  W.SVR.setVramBudget(null);
  W.SVR.resetGpuBudget();
  console.log('GPU allocation refusal degrades: OK');
}

// ── 5. a missing brick: reported, shown, not cached as complete ──────────────
{
  const W = makeWorld();
  W.VV.init('webgl-canvas');
  const meta = serveDataset(W, 'D/e', { missing: ['D/e/bricks/lod1/c1/x001_y000_z000.bin'] });
  const states = [];
  W.VV.onQualityProgress((s) => states.push(s));
  const res = await W.VV.loadBrickedVolumeStream('D/e', meta, null, null, { quality: '256x256' });
  assert.equal(res.available, true, 'the volume is still shown');
  assert.equal(res.failedLoads, 1, 'the brick with a missing channel is counted');
  assert.equal(res.degraded, true);
  assert.equal(W.VV.hasCachedVolume('D/e', '256x256', null), false, 'a holed volume is never cached as complete');
  assert.ok(/1 of 16 bricks missing/.test(states[states.length - 1].message), 'the final status keeps the dropped bricks');
  W.VV.dispose();
  console.log('dropped bricks surfaced, not cached: OK');
}

// ── 6. coarse first ──────────────────────────────────────────────────────────
{
  const W = makeWorld();
  W.SVR.setVramBudget(1024 * MiB);
  W.VV.init('webgl-canvas');
  const meta = serveDataset(W, 'D/f');
  const pictures = [];
  const res = await W.VV.loadBrickedVolumeStream('D/f', meta, null, null, {
    quality: 'native', coarseFirst: true, onFirstPicture: (info) => pictures.push(info)
  });
  assert.equal(res.available, true);
  assert.equal(res.lod, 0, 'the requested level ends on screen');
  assert.equal(res.previewLod, 1, 'after the coarse preview');
  assert.equal(pictures.length, 1, 'one first picture');
  assert.equal(pictures[0].preview, true);
  assert.equal(pictures[0].lod, 1);
  assert.equal(W.VV.getSamplingVolume().width, 512, 'the requested level is the one shown');
  W.VV.dispose();
  W.SVR.setVramBudget(null);
  console.log('coarse first: OK');
}

// ── 7. first picture without coarse-first: a quarter of the bricks on the GPU ─
{
  const W = makeWorld();
  W.VV.init('webgl-canvas');
  const meta = serveDataset(W, 'D/g');
  let uploadsAtPicture = -1;
  await W.VV.loadBrickedVolumeStream('D/g', meta, null, null, {
    quality: '256x256', onFirstPicture: () => { uploadsAtPicture = W.gl.log.subImage.length; }
  });
  assert.equal(uploadsAtPicture, 4, 'fired once 25 % of the 16 bricks were uploaded');
  W.VV.dispose();
  console.log('first picture: OK');
}

// ── 8. context loss: budget halved, volumes freed, last load replayed ────────
{
  const W = makeWorld();
  W.SVR.resetGpuBudget();
  W.VV.init('webgl-canvas');
  const meta = serveDataset(W, 'D/h');
  await W.VV.loadBrickedVolumeStream('D/h', meta, null, null, { quality: '256x256' });
  let restored = null;
  W.VV.onContextRestored((info) => { restored = info; });
  const budgetBefore = W.SVR.vramBudget(W.renderer).bytes;
  const deletedBefore = W.gl.log.deleted;
  W.listeners.get('webglcontextlost').fn({ preventDefault() {} });
  assert.equal(W.SVR.vramBudget(W.renderer).bytes, budgetBefore / 2, 'the next allocation asks for half');
  assert.equal(W.VV.getCacheStats().volumes, 0, 'every cached volume released');
  assert.ok(W.gl.log.deleted > deletedBefore, 'their textures deleted');
  assert.equal(W.VV.getSamplingVolume(), null, 'nothing bound to the material');
  const fetchesBefore = W.fetches();
  W.listeners.get('webglcontextrestored').fn({});
  assert.ok(restored && restored.reloading === true && typeof restored.reload?.then === 'function', 'the page is told a reload runs');
  const again = await restored.reload;
  assert.equal(again.available, true, 'the view is reloaded');
  assert.ok(W.fetches() > fetchesBefore, 'from the network, not a dead cache');
  assert.equal(W.VV.getSamplingVolume().width, 256);
  // A driver that resets on every reload: the third loss in a row stops the replay.
  for (let i = 0; i < 2; i++) {
    W.listeners.get('webglcontextlost').fn({ preventDefault() {} });
    W.listeners.get('webglcontextrestored').fn({});
    if (restored.reload) await restored.reload;
  }
  assert.equal(restored.reloading, false, 'three losses in a row: no automatic reload loop');
  W.VV.dispose();
  W.SVR.resetGpuBudget();
  console.log('context loss recovery: OK');

  // A budget below even the coarsest level (an operator override, losses, a failed
  // allocation): with nothing on screen the coarsest level is still attempted.
  const W2 = makeWorld();
  W2.SVR.resetGpuBudget();
  W2.SVR.setVramBudget(1024);
  W2.VV.init('webgl-canvas');
  const meta2 = serveDataset(W2, 'D/h2');
  const tiny = await W2.VV.loadBrickedVolumeStream('D/h2', meta2, null, null, { quality: '256x256' });
  assert.equal(tiny.available, true, 'something is always shown');
  W2.VV.dispose();
  W2.SVR.setVramBudget(null);
  W2.SVR.resetGpuBudget();
  console.log('coarsest level over the budget: OK');
}

// ── 9. denoise on a dense, brick-streamed volume: read back, blur, upload ────
{
  const blur = { fail: false };
  const W = makeWorld({ blurWorker: makeBlurWorker(blur) });
  W.VV.init('webgl-canvas');
  const meta = serveDataset(W, 'D/i');
  await W.VV.loadBrickedVolumeStream('D/i', meta, null, null, { quality: '256x256' });
  assert.equal(W.VV.getCapabilities().denoise.available, true);
  const states = () => W.events.filter(e => e.type === 'volume-denoise-state').map(e => e.detail);
  const settle = async () => { for (let i = 0; i < 40; i++) await new Promise(r => setTimeout(r, 0)); };
  const uploadsBefore = W.gl.log.subImage.length;
  W.VV.updateChannel(1, { denoise_sigma: 2 });
  await settle();
  assert.equal(W.gl.log.readLayers, 64, 'the volume is read back once, one layer at a time');
  const after = W.gl.log.subImage.slice(uploadsBefore);
  assert.ok(after.length >= 1 && after.every(u => u.w === 256 && u.h === 256), 'uploaded back in whole-layer slabs');
  assert.equal(after.reduce((s, u) => s + u.d, 0), 64, 'every layer re-uploaded');
  // Layer 0: channel 0 untouched (10), channel 1 filtered (20 + 1).
  assert.deepEqual(after[0].first.slice(0, 4), [10, 21, 0, 0], 'only the filtered channel changes');
  const ok = states().pop();
  assert.equal(ok.available, true);
  assert.equal(ok.reason, null);
  assert.equal(ok.effectiveSigma, 2);
  assert.ok(W.VV.getCacheStats().cachedCpuBytes > 0, 'the raw channels are counted in the cache budget');

  // A failing worker: the raw channel comes back, the failure is reported.
  blur.fail = true;
  const before2 = W.gl.log.subImage.length;
  W.VV.updateChannel(1, { denoise_sigma: 3 });
  await settle();
  const restored = W.gl.log.subImage.slice(before2);
  assert.deepEqual(restored[0].first.slice(0, 4), [10, 20, 0, 0], 'the unfiltered channel is restored');
  assert.equal(states().pop().reason, 'error');
  assert.equal(W.gl.log.readLayers, 64, 'no second read-back');
  W.VV.dispose();
  console.log('denoise on a dense volume (read-back, filter, upload, failure): OK');
}

console.log('VolumeViewer streaming integration (dense, sparse, budget, holes, coarse-first, pick, denoise, context loss, dispose): OK');
