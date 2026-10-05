// SVRManager VRAM budget and atlas layout:
//   • the GPU class comes from the unmasked renderer string; the budget follows it and
//     navigator.deviceMemory, halves after a noted context loss, honours an override;
//   • planAtlas wastes less than one 64-voxel layer per page (was up to 47 %);
//   • maxSlotsForBudget / estimateMaxSlots tell the viewer the ceiling BEFORE allocating;
//   • gl.getError() is read once per window of uploads, not per brick; a failed window
//     clears its page-table entries and reports them; FLIP_Y/PREMULTIPLY reset per upload.
//
// Run: node tests/js/test_stream_svr_budget.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT } from './harness.mjs';

const MiB = 1024 * 1024, GiB = 1024 * MiB;

function load({ deviceMemory = null, storage = new Map() } = {}) {
  const ctx = vm.createContext({
    console: { warn() {}, log() {}, error() {} }, setTimeout, clearTimeout, window: {},
    navigator: deviceMemory === null ? {} : { deviceMemory },
    localStorage: { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, String(v)), removeItem: (k) => storage.delete(k) },
  });
  vm.runInContext(readFileSync(path.join(ROOT, 'js/vendor/three.min.js'), 'utf8'), ctx);
  vm.runInContext(readFileSync(path.join(ROOT, 'js/core/svr-manager.js'), 'utf8') + '\n;globalThis.__SVR = SVRManager;', ctx);
  return ctx.__SVR;
}

function rendererNamed(name, max3D = 2048) {
  const gl = { getExtension: () => ({ UNMASKED_RENDERER_WEBGL: 7 }), getParameter: (p) => (p === 7 ? name : null) };
  return { getContext: () => gl, capabilities: { max3DTextureSize: max3D } };
}

// ── GPU class and budget ─────────────────────────────────────────────────────────
{
  const S = load({ deviceMemory: 8 });
  const cases = [
    ['ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)', 'discrete', 4 * GiB],
    ['ANGLE (AMD, AMD Radeon RX 6700 XT Direct3D11 vs_5_0 ps_5_0, D3D11)', 'discrete', 4 * GiB],
    ['ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)', 'integrated', 2 * GiB],
    ['ANGLE (AMD, AMD Radeon(TM) Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)', 'integrated', 2 * GiB],
    ['Apple M2', 'integrated', 2 * GiB],
    ['ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)', 'software', 256 * MiB],
    ['', 'unknown', 2 * GiB],
  ];
  for (const [name, cls, bytes] of cases) {
    const b = S.vramBudget(rendererNamed(name));
    assert.equal(b.gpuClass, cls, `${name || '(masked)'} -> ${cls}`);
    assert.equal(b.bytes, bytes, `${cls} budget`);
  }
  const low = load({ deviceMemory: 4 });
  assert.equal(low.vramBudget(rendererNamed('Intel(R) Iris(R) Xe Graphics')).bytes, GiB, '4 GB laptop iGPU: 1 GiB');
  assert.equal(low.vramBudget(rendererNamed('NVIDIA GeForce GTX 1650')).bytes, 3 * GiB, '4 GB machine dGPU: 3 GiB');
}

// ── Context loss halves the budget (persisted), override replaces the heuristic ──
{
  const storage = new Map();
  const S = load({ deviceMemory: 8, storage });
  const r = rendererNamed('NVIDIA GeForce RTX 3060');
  S.noteContextLost();
  assert.equal(S.vramBudget(r).bytes, 2 * GiB, 'one loss: half');
  const again = load({ deviceMemory: 8, storage });
  assert.equal(again.vramBudget(r).bytes, 2 * GiB, 'remembered by the next page load');
  again.resetGpuBudget();
  assert.equal(again.vramBudget(r).bytes, 4 * GiB, 'reset');
  storage.set('lumen3d.vramBudgetMB', '6144');
  const big = load({ deviceMemory: 8, storage });
  assert.equal(big.vramBudget(r).bytes, 6 * GiB, 'operator override');
  assert.equal(big.vramBudget(r).source, 'override');
}

// ── Layout waste and ceilings ────────────────────────────────────────────────────
{
  const S = load({ deviceMemory: 8 });
  // Active brick counts from the audit (E825 native 543, E95-1 @1024 279, Em1 @1024 658,
  // E85-2 native 3212, E95-1 native 6636 with an 8 GiB override).
  for (const n of [1, 8, 279, 295, 543, 658, 3212]) {
    const p = S.planAtlas(n, { max3D: 2048 });
    assert.ok(p.slots >= n, `${n} fit`);
    assert.ok(p.slots - n < 64 * p.pages, `${n}: waste ${p.slots - n} slots < one layer per page`);
    assert.ok(p.bytes / p.pages <= 512 * MiB, 'pages of at most 512 MiB');
    assert.ok(p.pages <= 8);
  }
  assert.equal(S.planAtlas(5000, { max3D: 2048 }), null, '5000 RGBA slots do not fit in 8 pages of 512 MiB');
  assert.ok(S.planAtlas(6636, { max3D: 2048, maxPageBytes: GiB }).slots >= 6636, 'with 1 GiB pages (budget > 4 GiB) they do');
  assert.ok(S.planAtlas(3000, { max3D: 2048, components: 1 }).bytes < (3000 + 128) * 262144, 'R8 slots are a quarter');

  const r = rendererNamed('NVIDIA GeForce RTX 3060');
  assert.equal(S.estimateMaxSlots(r), 4096, 'discrete 4 GiB: 4096 RGBA slots');
  assert.equal(S.estimateMaxSlots(rendererNamed('Intel(R) UHD Graphics 620')), 2048, 'iGPU 2 GiB: 2048 slots');
  assert.equal(S.maxSlotsForBudget(r, { components: 2 }), 8192, 'RG8 doubles the count');
}

// ── One getError per window of uploads ───────────────────────────────────────────
{
  const S = load({ deviceMemory: 8 });
  let getErrors = 0, nextError = 0;
  const storeCalls = [];
  const GL = {
    NO_ERROR: 0, TEXTURE_3D: 1, RGBA8: 16, RGBA: 17, UNSIGNED_BYTE: 18, UNPACK_FLIP_Y_WEBGL: 30, UNPACK_PREMULTIPLY_ALPHA_WEBGL: 31,
    createTexture: () => ({}), bindTexture() {}, texParameteri() {}, bindBuffer() {}, deleteTexture() {},
    pixelStorei: (p, v) => storeCalls.push([p, v]),
    texStorage3D() {}, getParameter: () => null,
    getError: () => { getErrors++; const e = nextError; nextError = 0; return e; },
    texSubImage3D() {},
  };
  const props = new Map();
  const renderer = { getContext: () => GL, capabilities: { max3DTextureSize: 2048 }, properties: { get: (o) => { if (!props.has(o)) props.set(o, {}); return props.get(o); } } };
  const u = () => ({ value: null });
  const material = { defines: {}, uniforms: { pageTable: u(), atlasDim: u(), volumeDim: u(), ptDim: u(), ptScale: u(), brickSize: u(), svrPageCount: u(), svrAtlas0: u() } };
  const svr = new S();
  svr.init(4, { x: 64 * 10, y: 64 * 10, z: 64 }, renderer, material, { targetSlots: 100 });
  const brick = new Uint8Array(64 * 64 * 64 * 4);
  getErrors = 0;
  for (let i = 0; i < 64; i++) assert.equal(svr.writeRgbaBrick(i % 10, Math.floor(i / 10), 0, brick, 64, 64, 64), true);
  assert.equal(getErrors, 2, '64 uploads, two error reads (window of 32)');
  assert.ok(storeCalls.some(([p, v]) => p === 30 && v === false), 'FLIP_Y reset before upload');
  assert.ok(storeCalls.some(([p, v]) => p === 31 && v === false), 'PREMULTIPLY reset before upload');
  nextError = 1282;
  for (let i = 64; i < 70; i++) svr.writeRgbaBrick(i % 10, Math.floor(i / 10), 0, brick, 64, 64, 64);
  const reported = [];
  svr.onUploadError = (keys) => reported.push(...keys);
  const failed = svr.flushUploadErrors();
  assert.equal(failed.length, 6, 'the six bricks of the failed window');
  assert.deepEqual(reported, Array.from(failed), 'onUploadError told');
  const pt = (bx, by) => (by * svr.ptNx + bx) * 4 + 3;
  assert.equal(svr.pageData[pt(4, 6)], 0, 'failed brick cleared in the page table');
  assert.notEqual(svr.pageData[pt(3, 6)], 0, 'a brick of an earlier, clean window stays');
  // Edge brick: a cut (bw × bh × bd) upload is passed as is, a whole brick compacted.
  assert.equal(svr.writeRgbaBrick(9, 9, 0, new Uint8Array(20 * 64 * 64 * 4), 20, 64, 64), true, 'pre-cut edge brick accepted');
  assert.equal(svr.writeRgbaBrick(8, 9, 0, null, 64, 64, 64), false, 'no data refused');
  const live = S.liveAtlasBytes();
  assert.equal(live, svr.atlasBytes, 'the atlas is counted live');
  svr.dispose();
  assert.equal(S.liveAtlasBytes(), 0, 'and released on dispose');
}

console.log('SVR budget, layout and batched upload checks: OK');
