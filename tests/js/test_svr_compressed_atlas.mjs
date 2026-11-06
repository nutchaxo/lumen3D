// The GPU-compressed display atlas (SVRManager, compression 'bc'):
//   • compressionSupport: a hardware GPU with EXT_texture_compression_rgtc; a software
//     renderer is refused unless allowSoftwareCompression; no RGTC, no compression; the
//     extension is enabled again on every call (a restored context lost it);
//   • pages are TEXTURE_2D_ARRAY storage of the RGTC format of each plane (BC4 for one
//     channel, BC5 for two, BC5 + BC4 / BC5 + BC5 beyond, four pages at most), on a
//     slot pitch rounded up to whole blocks (68 for a bordered 66³ brick);
//   • writeEncodedBrick uploads each plane at the slot origin (offsets multiples of 4),
//     refuses blocks that do not match the atlas; writeRgbaBrick encodes on the spot;
//     writeRgbaBrickRegion is refused;
//   • updateUniforms publishes SVR_ARRAY (+ SVR_ARRAY_PAIRS) and the pitch as slotStride,
//     binds the second plane's pages to svrAtlas4..7; an uncompressed atlas on the same
//     material takes the defines back off; clearAtlasDefines removes them all;
//   • planAtlas counts texelBytes (0.5 per channel) instead of components.
//
// Run: node tests/js/test_svr_compressed_atlas.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT } from './harness.mjs';

const BC4 = 0x8DBB, BC5 = 0x8DBD;

function memoryStorage(store = new Map()) {
  return {
    store,
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
  };
}

function load(storage = memoryStorage()) {
  const ctx = vm.createContext({
    console: { warn() {}, log() {}, error() {} }, setTimeout, clearTimeout, window: {}, self: {},
    navigator: { deviceMemory: 8 },
    localStorage: storage,
  });
  vm.runInContext(readFileSync(path.join(ROOT, 'js/vendor/three.min.js'), 'utf8'), ctx);
  vm.runInContext(readFileSync(path.join(ROOT, 'js/core/bc-codec.js'), 'utf8'), ctx);
  vm.runInContext(readFileSync(path.join(ROOT, 'js/core/svr-manager.js'), 'utf8') + '\n;globalThis.__SVR = SVRManager; globalThis.__BC = BCCodec;', ctx);
  return { S: ctx.__SVR, BC: ctx.__BC, THREE: ctx.THREE, storage };
}

function fakeRenderer(name = 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)', { rgtc = true } = {}) {
  const calls = [];
  let rgtcEnabled = 0;
  let nextTex = 1;
  const gl = {
    TEXTURE_3D: 0x806F, TEXTURE_2D_ARRAY: 0x8C1A, TEXTURE_BINDING_3D: 0x806A, TEXTURE_BINDING_2D_ARRAY: 0x8C1D,
    TEXTURE_MIN_FILTER: 0x2801, TEXTURE_MAG_FILTER: 0x2800, TEXTURE_WRAP_S: 0x2802, TEXTURE_WRAP_T: 0x2803, TEXTURE_WRAP_R: 0x8072,
    LINEAR: 0x2601, NEAREST: 0x2600, CLAMP_TO_EDGE: 0x812F, NO_ERROR: 0, PIXEL_UNPACK_BUFFER: 0x88EC,
    MAX_ARRAY_TEXTURE_LAYERS: 0x88FF, R8: 0x8229, RG8: 0x822B, RGBA8: 0x8058, RED: 0x1903, RG: 0x8227, RGBA: 0x1908,
    UNSIGNED_BYTE: 0x1401, UNPACK_ALIGNMENT: 0x0CF5,
    getExtension(n) {
      if (n === 'WEBGL_debug_renderer_info') return { UNMASKED_RENDERER_WEBGL: 7 };
      if (n === 'EXT_texture_compression_rgtc' && rgtc) { rgtcEnabled++; return { COMPRESSED_RED_RGTC1_EXT: BC4, COMPRESSED_RED_GREEN_RGTC2_EXT: BC5 }; }
      return null;
    },
    getParameter(p) { return p === 7 ? name : p === 0x88FF ? 2048 : null; },
    getError() { return 0; },
    createTexture() { return { id: nextTex++ }; },
    deleteTexture(t) { calls.push(['deleteTexture', t.id]); },
    bindTexture(target, t) { calls.push(['bindTexture', target, t && t.id]); },
    texParameteri() {}, bindBuffer() {}, pixelStorei() {},
    texStorage3D(target, levels, fmt, w, h, d) { calls.push(['texStorage3D', target, fmt, w, h, d]); },
    texSubImage3D(target, level, x, y, z, w, h, d) { calls.push(['texSubImage3D', target, x, y, z, w, h, d]); },
    compressedTexSubImage3D(target, level, x, y, z, w, h, d, fmt, bytes) { calls.push(['compressedTexSubImage3D', target, x, y, z, w, h, d, fmt, bytes.length]); },
  };
  const props = new Map();
  return {
    calls, gl, enabled: () => rgtcEnabled,
    renderer: {
      getContext: () => gl,
      capabilities: { max3DTextureSize: 2048, maxTextureSize: 16384 },
      properties: { get: (o) => { if (!props.has(o)) props.set(o, {}); return props.get(o); } },
      state: { bindTexture: (t, tex) => gl.bindTexture(t, tex) },
    },
  };
}

function material(THREE) {
  const u = {};
  for (let i = 0; i < 8; i++) u['svrAtlas' + i] = { value: null };
  for (const k of ['pageTable', 'slotStride', 'brickApron', 'svrComponents', 'svrPageCount', 'brickSize']) u[k] = { value: null };
  for (const k of ['atlasDim', 'volumeDim', 'ptDim', 'ptScale']) u[k] = { value: new THREE.Vector3() };
  return { defines: {}, uniforms: u, needsUpdate: false };
}

const dims = { x: 300, y: 260, z: 140, apron: 1, brickStride: 66 };

// ── support ────────────────────────────────────────────────────────────────────
{
  const { S } = load();
  const hw = fakeRenderer();
  const sup = S.compressionSupport(hw.renderer);
  assert.equal(sup.bc, true, 'a hardware GPU with RGTC supports it');
  assert.equal(sup.formats.bc5, BC5);
  const before = hw.enabled();
  S.compressionSupport(hw.renderer);
  assert.equal(hw.enabled(), before + 1, 'the cached answer still enables the extension again (context restore)');
  assert.equal(S.compressionSupport(fakeRenderer('ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)').renderer).reason,
    'software-renderer', 'a software renderer is refused');
  assert.equal(S.compressionSupport(fakeRenderer('NVIDIA GeForce GTX 1650', { rgtc: false }).renderer).reason, 'no-rgtc');
  S.allowSoftwareCompression = true;
  assert.equal(S.compressionSupport(fakeRenderer('SwiftShader Device').renderer).bc, true, 'the test override lifts the software refusal');
  S.allowSoftwareCompression = false;
  console.log('compression support: OK');
}

// ── mobile GPUs ────────────────────────────────────────────────────────────────
{
  const { S, THREE } = load();
  const adreno = fakeRenderer('ANGLE (Qualcomm, Adreno (TM) 740, OpenGL ES 3.2 V@0676.76.1)');
  assert.equal(S.compressionSupport(adreno.renderer).reason, 'mobile-gpu', 'an Adreno GPU never gets RGTC atlases');
  assert.equal(S.compressionSupport(fakeRenderer('Mali-G710').renderer).bc, false);
  console.log('mobile GPUs: OK');
}

// ── when a context loss is laid on the compression, and for how long ───────────
{
  const HOUR = 3600 * 1000;
  // A loss long after the compressed atlas was allocated (a driver reset, a GPU process
  // restart) does not condemn the compression on its own.
  {
    const { S, THREE, storage } = load();
    const hw = fakeRenderer();
    const m = new S();
    m.init(2, dims, hw.renderer, material(THREE), { targetSlots: 8, components: 2, apron: 1, compression: 'bc' });
    assert.equal(m.compressed, true);
    assert.ok(S._lastCompressedAllocAt > 0, 'the compressed allocation is time-stamped');
    S._lastCompressedAllocAt = Date.now() - HOUR;
    S.noteContextLost();
    assert.equal(S.compressionFailedBefore(), false, 'one loss with compression alive is not enough');
    assert.equal(JSON.parse(storage.getItem('lumen3d.gpuCompressedLosses')).length, 1);
    // The second such loss within the week is.
    S.noteContextLost();
    assert.equal(S.compressionFailedBefore(), true, 'a second loss with compression alive marks it');
    assert.equal(S.compressionSupport(fakeRenderer('NVIDIA GeForce RTX 4070').renderer).reason, 'failed-before');
    m.dispose();
    // Another page of the same profile (same storage) inherits the mark...
    const other = load(storage);
    assert.equal(other.S.compressionFailedBefore(), true, 'the mark is kept on the browser profile');
    // ...and resetGpuBudget clears it, the session flag included.
    S.resetGpuBudget();
    assert.equal(S.compressionFailedBefore(), false, 'resetGpuBudget clears the compression mark');
    assert.equal(storage.getItem('lumen3d.gpuCompressionFailed'), null);
    assert.equal(storage.getItem('lumen3d.gpuCompressedLosses'), null);
    assert.equal(S.compressionSupport(fakeRenderer('NVIDIA GeForce RTX 4070').renderer).bc, true);
  }
  // A loss right after a compressed allocation is laid on it at once.
  {
    const { S, THREE } = load();
    const m = new S();
    m.init(2, dims, fakeRenderer().renderer, material(THREE), { targetSlots: 8, components: 2, apron: 1, compression: 'bc' });
    S.noteContextLost();
    assert.equal(S.compressionFailedBefore(), true, 'a loss moments after the compressed allocation marks it');
    m.dispose();
  }
  // Two losses more than a week apart never meet inside the memory window.
  {
    const { S, THREE, storage } = load();
    storage.setItem('lumen3d.gpuCompressedLosses', JSON.stringify([Date.now() - 8 * 24 * HOUR]));
    const m = new S();
    m.init(2, dims, fakeRenderer().renderer, material(THREE), { targetSlots: 8, components: 2, apron: 1, compression: 'bc' });
    S._lastCompressedAllocAt = Date.now() - HOUR;
    S.noteContextLost();
    assert.equal(S.compressionFailedBefore(), false, 'a compressed loss older than the window is forgotten');
    m.dispose();
  }
  // A loss with no compressed atlas alive and none allocated lately records nothing.
  {
    const { S, storage } = load();
    S.noteContextLost();
    S.noteContextLost();
    assert.equal(S.compressionFailedBefore(), false);
    assert.equal(storage.getItem('lumen3d.gpuCompressedLosses'), null);
  }
  // The mark expires: one older than CONTEXT_LOSS_MEMORY_MS is ignored, a recent one is not,
  // and the bare number written by earlier versions reads as one stamp.
  {
    const { S, storage } = load();
    storage.setItem('lumen3d.gpuCompressionFailed', String(Date.now() - S.CONTEXT_LOSS_MEMORY_MS - HOUR));
    assert.equal(S.compressionFailedBefore(), false, 'a stale mark (bare number) has expired');
    assert.equal(S.compressionSupport(fakeRenderer().renderer).bc, true, 'compression comes back after the window');
    storage.setItem('lumen3d.gpuCompressionFailed', String(Date.now() - HOUR));
    assert.equal(S.compressionFailedBefore(), true, 'a recent mark (bare number) still applies');
    storage.setItem('lumen3d.gpuCompressionFailed', JSON.stringify([Date.now() - S.CONTEXT_LOSS_MEMORY_MS - HOUR]));
    assert.equal(S.compressionFailedBefore(), false, 'a stale mark (list) has expired');
  }
  // An RGTC page the driver refuses for anything but memory: marked, and the atlas is refused
  // as SVR_BAD_FORMAT so the caller streams the same level uncompressed.
  {
    const { S, THREE } = load();
    const hw = fakeRenderer();
    assert.equal(S.compressionSupport(hw.renderer).bc, true, 'the 4 x 4 probe passes');
    let pending = 0;
    hw.gl.texStorage3D = (target, levels, fmt, w) => { if (w > 4) pending = 0x0500; };
    hw.gl.getError = () => { const e = pending; pending = 0; return e; };
    const m = new S();
    assert.throws(
      () => m.init(2, dims, hw.renderer, material(THREE), { targetSlots: 8, components: 2, apron: 1, compression: 'bc' }),
      (err) => err.code === 'SVR_BAD_FORMAT');
    assert.equal(S.compressionFailedBefore(), true, 'an RGTC page refused with INVALID_ENUM marks the compression');
    assert.equal(S._liveCompressed.size, 0, 'the refused atlas is not counted as a live compressed one');
    assert.equal(S._failedAllocBytes, Infinity, 'a format refusal does not cap the budget');
    m.dispose();
  }
  // Out of memory is a size problem, not a format one: the usual coarser-level path.
  {
    const { S, THREE } = load();
    const hw = fakeRenderer();
    assert.equal(S.compressionSupport(hw.renderer).bc, true);
    let pending = 0;
    hw.gl.texStorage3D = (target, levels, fmt, w) => { if (w > 4) pending = 0x0505; };
    hw.gl.getError = () => { const e = pending; pending = 0; return e; };
    const m = new S();
    assert.throws(
      () => m.init(2, dims, hw.renderer, material(THREE), { targetSlots: 8, components: 2, apron: 1, compression: 'bc' }),
      (err) => err.code === 'SVR_ALLOC_FAILED');
    assert.equal(S.compressionFailedBefore(), false, 'OUT_OF_MEMORY does not mark the compression');
    m.dispose();
  }
  console.log('failed compression: OK');
}

// ── two channels, bordered bricks ─────────────────────────────────────────────
{
  const { S, BC, THREE } = load();
  const hw = fakeRenderer();
  const mat = material(THREE);
  const m = new S();
  m.init(2, dims, hw.renderer, mat, { targetSlots: 40, components: 2, apron: 1, compression: 'bc' });
  assert.equal(m.compressed, true);
  assert.equal(m.slotStride, 66, 'the data stride is the stored brick edge');
  assert.equal(m.slotPitch, 68, 'the pitch rounds it up to whole 4 × 4 blocks');
  const stores = hw.calls.filter(c => c[0] === 'texStorage3D' && c[3] > 4);   // not the 4 × 4 support probe
  assert.ok(stores.length >= 1 && stores.every(c => c[1] === hw.gl.TEXTURE_2D_ARRAY && c[2] === BC5), 'pages: BC5 2D arrays');
  assert.ok(stores.every(c => c[3] % 68 === 0 && c[5] % 68 === 0), 'page sides and depth in whole slots of 68');
  assert.equal(m.atlasBytes, m.maxSlots * 68 ** 3 * 1, 'BC5: one byte per texel');
  assert.equal(mat.defines.SVR_ARRAY, 1);
  assert.equal(mat.defines.SVR_COMPONENTS, 2);
  assert.ok(!('SVR_ARRAY_PAIRS' in mat.defines));
  assert.equal(mat.uniforms.slotStride.value, 68, 'the shader steps slots by the pitch');
  assert.ok(mat.uniforms.svrAtlas0.value?.isDataArrayTexture, 'svrAtlas0 is a 2D array texture');

  // A brick in blocks, from the codec the decode worker runs.
  const brick = new Uint8Array(66 * 66 * 66 * 2).map((_, i) => (i * 7) & 255);
  const enc = BC.encodeBox(brick, 2, 66, 66, 66, 2);
  hw.calls.length = 0;
  assert.equal(m.writeEncodedBrick(2, 1, 0, enc), true);
  const up = hw.calls.filter(c => c[0] === 'compressedTexSubImage3D');
  assert.equal(up.length, 1, 'one upload per plane');
  const [, target, x, y, z, w, h, d, fmt, len] = up[0];
  assert.equal(target, hw.gl.TEXTURE_2D_ARRAY);
  assert.ok(x % 68 === 0 && y % 68 === 0 && z % 68 === 0, 'the slot origin is block-aligned');
  assert.deepEqual([w, h, d, fmt, len], [68, 68, 66, BC5, 17 * 17 * 66 * 16]);
  assert.ok(m.has(2, 1, 0), 'the page table points at the brick');

  assert.equal(m.writeEncodedBrick(0, 0, 0, { ...enc, planes: [] }), false, 'a plane count that does not match is refused');
  assert.equal(m.writeEncodedBrick(0, 0, 0, { ...enc, width: 72 }), false, 'a box wider than the slot is refused');
  assert.equal(m.has(0, 0, 0), false);

  hw.calls.length = 0;
  assert.equal(m.writeRgbaBrick(1, 1, 1, brick, 66, 66, 66), true, 'raw voxels are encoded on the spot');
  assert.equal(hw.calls.filter(c => c[0] === 'compressedTexSubImage3D').length, 1);
  assert.equal(hw.calls.filter(c => c[0] === 'texSubImage3D').length, 0, 'never an uncompressed upload into a compressed page');
  assert.equal(m.writeRgbaBrickRegion(0, 1, 1, new Uint8Array(8), 0, 0, 0, 2, 2, 1), false, 'sub-box uploads are refused');

  // The same material then holds an uncompressed atlas: the defines go.
  const plain = new S();
  plain.init(2, dims, hw.renderer, mat, { targetSlots: 40, components: 2, apron: 1 });
  assert.ok(!('SVR_ARRAY' in mat.defines) && !('SVR_ARRAY_PAIRS' in mat.defines), 'an uncompressed atlas clears SVR_ARRAY');
  assert.equal(mat.uniforms.slotStride.value, 66);
  S.clearAtlasDefines(mat);
  assert.deepEqual(Object.keys(mat.defines), [], 'clearAtlasDefines leaves no atlas define');
  m.dispose();
  assert.ok(hw.calls.some(c => c[0] === 'deleteTexture'), 'dispose deletes the pages');
  console.log('two-channel compressed atlas: OK');
}

// ── four channels: two planes per page ────────────────────────────────────────
{
  const { S, BC, THREE } = load();
  const hw = fakeRenderer();
  const mat = material(THREE);
  const m = new S();
  m.init(4, dims, hw.renderer, mat, { targetSlots: 40, components: 4, apron: 1, compression: 'bc' });
  assert.equal(m.planes.length, 2);
  assert.equal(m.pageLimit, 4, 'two textures a page: four pages at most (eight samplers)');
  assert.equal(mat.defines.SVR_ARRAY_PAIRS, 1);
  const half = m.atlasPages;
  for (let i = 0; i < 4; i++) {
    assert.equal(mat.uniforms['svrAtlas' + i].value, m.planeAtlases[0][i] || m.planeAtlases[0][0], `svrAtlas${i}: plane 0`);
    assert.equal(mat.uniforms['svrAtlas' + (4 + i)].value, m.planeAtlases[1][i] || m.planeAtlases[1][0], `svrAtlas${4 + i}: plane 1`);
  }
  assert.ok(half >= 1);
  const brick = new Uint8Array(66 * 66 * 66 * 4).map((_, i) => (i * 13) & 255);
  hw.calls.length = 0;
  assert.equal(m.writeEncodedBrick(0, 0, 0, BC.encodeBox(brick, 4, 66, 66, 66, 4)), true);
  assert.deepEqual(hw.calls.filter(c => c[0] === 'compressedTexSubImage3D').map(c => c[8]), [BC5, BC5], 'BC5 + BC5');
  const three = new S();
  three.init(3, dims, hw.renderer, material(THREE), { targetSlots: 40, components: 4, apron: 1, compression: 'bc' });
  assert.deepEqual(three.planes.map(p => p.format).join(), 'bc5,bc4', 'three channels: BC5 + BC4');
  assert.equal(three.texelBytes, 1.5);
  console.log('four-channel compressed atlas: OK');
}

// ── planning ───────────────────────────────────────────────────────────────────
{
  const { S } = load();
  const p = S.planAtlas(100, { max3D: 2048, brickSize: 68, texelBytes: 0.5 });
  assert.equal(p.bytes, p.slots * 68 ** 3 * 0.5);
  const q = S.planAtlas(100, { max3D: 2048, brickSize: 66, components: 1 });
  assert.ok(p.bytes < q.bytes, 'a BC4 atlas is smaller than the R8 one for the same bricks');
  assert.equal(S.pitchFor(66, true), 68);
  assert.equal(S.pitchFor(64, true), 64);
  assert.equal(S.pitchFor(66, false), 66);
  console.log('planning: OK');
}

console.log('svr compressed atlas: OK');
