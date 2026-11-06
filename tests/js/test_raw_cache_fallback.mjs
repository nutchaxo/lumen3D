// The maximum-projection maxima cache falls back to the classic single pass when its
// programs fail on the GPU. The real volume-viewer.js runs in a vm with a recording
// renderer stub; three r147 records a failed compile/link as
// properties.get(material).currentProgram.diagnostics.runnable === false (no callback), so
// the stub writes that for the RAW_OUT or RAW_READ material it is asked to draw.
//   • a failure of either program: the cache is disposed, marked unsupported, one warning,
//     and the same frame is drawn again with the volume's own material;
//   • later frames never touch the cache again;
//   • programs that build: the two-pass path stays on.
//
// Run: node tests/js/test_raw_cache_fallback.mjs
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

function makeWorld({ files, failVariant }) {
  const gl = {
    NO_ERROR: 0, CONTEXT_LOST_WEBGL: 0x9242, TEXTURE_3D: 0x806f, TEXTURE_BINDING_3D: 0x806a,
    R8: 0x8229, RG8: 0x822b, RGBA8: 0x8058, RED: 0x1903, RG: 0x8227, RGBA: 0x1908, UNSIGNED_BYTE: 0x1401,
    LINEAR: 0x2601, NEAREST: 0x2600, CLAMP_TO_EDGE: 0x812f, TEXTURE_MIN_FILTER: 0x2801, TEXTURE_MAG_FILTER: 0x2800,
    TEXTURE_WRAP_S: 0x2802, TEXTURE_WRAP_T: 0x2803, TEXTURE_WRAP_R: 0x8072, PIXEL_UNPACK_BUFFER: 0x88ec,
    UNPACK_ALIGNMENT: 0x0cf5, UNPACK_ROW_LENGTH: 0x0cf2, UNPACK_IMAGE_HEIGHT: 0x806e, UNPACK_SKIP_PIXELS: 0x0cf4,
    UNPACK_SKIP_ROWS: 0x0cf3, UNPACK_SKIP_IMAGES: 0x806d, UNPACK_FLIP_Y_WEBGL: 0x9240, UNPACK_PREMULTIPLY_ALPHA_WEBGL: 0x9241, RENDERER: 0x1f01,
    getError: () => 0, getExtension: () => null, getParameter: (p) => (p === 0x1f01 ? 'Test GPU' : null), isContextLost: () => false,
    createTexture: () => ({}), deleteTexture() {}, bindTexture() {}, pixelStorei() {}, bindBuffer() {},
    texParameteri() {}, texStorage3D() {}, texImage3D() {}, texSubImage3D() {}
  };
  const canvas = {
    style: {}, clientWidth: 800, clientHeight: 600, parentElement: { clientWidth: 800, clientHeight: 600, style: {} },
    addEventListener() {}, getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 })
  };
  const props = new WeakMap();
  const draws = [];
  let target = null;
  const renderer = {
    domElement: canvas,
    capabilities: { max3DTextureSize: 2048, isWebGL2: true, maxTextureSize: 4096 },
    extensions: { has: (n) => n === 'EXT_color_buffer_float', get: () => ({}) },
    properties: { get(o) { let p = props.get(o); if (!p) { p = {}; props.set(o, p); } return p; }, remove(o) { props.delete(o); } },
    state: { bindTexture() {}, bindFramebuffer() {} },
    getContext: () => gl,
    setSize() {}, setPixelRatio(r) { this._pr = r; }, getPixelRatio() { return this._pr || 1; },
    setClearColor() {}, getClearColor(c) { return c; }, getClearAlpha() { return 1; },
    getSize(v) { return v.set(800, 600); }, getDrawingBufferSize(v) { return v.set(800, 600); },
    getRenderTarget() { return target; }, setRenderTarget(t) { target = t; }, clear() {}, dispose() {},
    render(scene) {
      // The volume mesh of the scene (a ShaderMaterial carrying the volume's uniforms).
      let mat = null;
      scene.traverse((o) => { if (!mat && o.material?.uniforms?.renderMode) mat = o.material; });
      const variant = mat?.defines?.RAW_OUT ? 'RAW_OUT' : mat?.defines?.RAW_READ ? 'RAW_READ' : 'classic';
      draws.push(variant);
      if (variant === failVariant) this.properties.get(mat).currentProgram = { diagnostics: { runnable: false } };
      else if (mat) this.properties.get(mat).currentProgram = { diagnostics: undefined };
    }
  };
  const THREE = Object.assign({}, REAL_THREE, { WebGLRenderer: function WebGLRenderer() { return renderer; } });
  const warnings = [];
  const ctx = vm.createContext({
    console: { log() {}, debug() {}, warn: (...a) => warnings.push(a.join(' ')), error() {}, info() {} },
    setTimeout, clearTimeout, Promise, URL, Map, Set, WeakMap, Uint8Array, Float64Array, Int32Array, ArrayBuffer, DataView, TextDecoder,
    AbortController, DOMException, CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
    MessageChannel, Blob, Response, crypto: webcrypto,
    THREE, window: { devicePixelRatio: 1, addEventListener() {}, dispatchEvent() { return true; }, location: { search: '' } },
    fetch: mockFetch(files, { mode: 'multipart' }), Worker: VmBrickWorker,
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
  return { VV: ctx.__VV, SVR: ctx.__SVR, draws, warnings };
}

const value = (k, c, x, y, z) => 1 + ((x * 7 + y * 13 + z * 29 + c * 101 + k * 53) % 250);
const levels = [{ dims: { x: 150, y: 100, z: 70 }, voxelSize: { x: 1, y: 1, z: 1 } }];
const tree = buildV3Tree({ base: 'D/f/bricks', channels: 1, levels, value, perPack: 3 });
const meta = { id: 'D/f', type: '3d', dimensions: { ...levels[0].dims, c: 1 }, voxel_size: { x: 1, y: 1, z: 1 } };

async function scenario(failVariant) {
  const W = makeWorld({ files: tree.files, failVariant });
  W.SVR.setVramBudget(2048 * MiB);
  W.VV.init('webgl-canvas');
  const res = await W.VV.loadBrickedVolumeStream('D/f', meta, null, null, { quality: 'native' });
  assert.equal(res.available, true, res.reason);
  W.VV.setRenderMode(1);
  W.draws.length = 0;
  assert.equal(W.VV.renderNow(), true);
  const first = W.draws.slice();
  W.draws.length = 0;
  W.VV.renderNow();
  const second = W.draws.slice();
  const stats = W.VV.getRawCacheStats();
  const warns = W.warnings.filter((w) => /maximum-projection cache failed/.test(w));
  W.VV.dispose();
  return { first, second, stats, warns };
}

{
  const ok = await scenario(null);
  assert.deepEqual(ok.first, ['RAW_OUT', 'RAW_READ'], 'march then recolour');
  assert.deepEqual(ok.second, ['RAW_READ'], 'an unchanged view is only recoloured');
  assert.equal(ok.stats.unsupported, false);
  assert.equal(ok.warns.length, 0);
  console.log('maxima cache programs that build: two-pass path kept: OK');
}
for (const variant of ['RAW_OUT', 'RAW_READ']) {
  const r = await scenario(variant);
  const expected = variant === 'RAW_OUT' ? ['RAW_OUT', 'classic'] : ['RAW_OUT', 'RAW_READ', 'classic'];
  assert.deepEqual(r.first, expected, `${variant} fails: the same frame is drawn again by the classic pass`);
  assert.deepEqual(r.second, ['classic'], 'later frames go straight to the classic pass');
  assert.equal(r.stats.unsupported, true);
  assert.equal(r.warns.length, 1, 'one warning');
  console.log(`${variant} program failure: classic single pass, one warning: OK`);
}
console.log('raw cache fallback: OK');
