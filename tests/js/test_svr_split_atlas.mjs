// The split display atlas (SVRManager, split: true): an uncompressed atlas of three channels
// is laid out as an RG8 and an R8 3D texture per page instead of one RGBA8, so the unused
// fourth byte costs no VRAM — what a GPU without RGTC (or a software renderer, a mobile GPU,
// compression switched off) falls back to:
//   • pages: two textures per page (svrAtlas0..3 RG8, svrAtlas4..7 R8), at most four pages,
//     3 bytes per voxel, SVR_SPLIT defined and removed again by the next atlas;
//   • writers keep passing RGBA voxels (components 4); the upload drops byte 3;
//   • one, two and four channels, a compressed atlas is not split;
//   • sub-box and block uploads are refused; a budget that refuses the RGBA layout accepts it.
//
// Run: node tests/js/test_svr_split_atlas.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT } from './harness.mjs';

const BC4 = 0x8DBB, BC5 = 0x8DBD;

function load() {
  const ctx = vm.createContext({
    console: { warn() {}, log() {}, error() {} }, setTimeout, clearTimeout, window: {}, self: {},
    navigator: { deviceMemory: 8 },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  });
  vm.runInContext(readFileSync(path.join(ROOT, 'js/vendor/three.min.js'), 'utf8'), ctx);
  vm.runInContext(readFileSync(path.join(ROOT, 'js/core/bc-codec.js'), 'utf8'), ctx);
  vm.runInContext(readFileSync(path.join(ROOT, 'js/core/svr-manager.js'), 'utf8') + '\n;globalThis.__SVR = SVRManager; globalThis.__BC = BCCodec;', ctx);
  return { S: ctx.__SVR, BC: ctx.__BC, THREE: ctx.THREE };
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
    texSubImage3D(target, level, x, y, z, w, h, d, fmt, type, data) { calls.push(['texSubImage3D', target, x, y, z, w, h, d, fmt, data.length, data]); },
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



// ── three channels, bordered bricks: RG8 + R8 pages ──────────────────────────
{
  const { S, THREE } = load();
  const hw = fakeRenderer('Intel(R) UHD Graphics', { rgtc: false });
  const mat = material(THREE);
  const m = new S();
  m.init(3, dims, hw.renderer, mat, { targetSlots: 40, components: 4, apron: 1, split: true });
  assert.equal(m.split, true);
  assert.equal(m.compressed, false);
  assert.equal(m.components, 4, 'writers keep passing RGBA voxels');
  assert.equal(m.pageLimit, 4, 'two textures a page: four pages at most (eight samplers)');
  assert.equal(m.planes.length, 2);
  const stores = hw.calls.filter(c => c[0] === 'texStorage3D');
  assert.ok(stores.length >= 2 && stores.length % 2 === 0, 'one RG8 and one R8 texture per page');
  assert.ok(stores.every(c => c[1] === hw.gl.TEXTURE_3D), 'ordinary 3D pages');
  assert.deepEqual([...new Set(stores.map(c => c[2]))].sort(), [hw.gl.R8, hw.gl.RG8].sort());
  assert.equal(m.atlasBytes, m.maxSlots * 66 ** 3 * 3, 'three bytes a voxel, not four');
  assert.equal(S.planAtlas(40, { components: 3, brickSize: 66 }).bytes * 4, S.planAtlas(40, { components: 4, brickSize: 66 }).bytes * 3);
  assert.equal(mat.defines.SVR_SPLIT, 1);
  assert.ok(!('SVR_ARRAY' in mat.defines) && !('SVR_COMPONENTS' in mat.defines));
  assert.equal(mat.uniforms.slotStride.value, 66, 'no block pitch: slots step by the stored edge');
  for (let i = 0; i < 4; i++) {
    assert.equal(mat.uniforms['svrAtlas' + i].value, m.planeAtlases[0][i] || m.planeAtlases[0][0], `svrAtlas${i}: RG8`);
    assert.equal(mat.uniforms['svrAtlas' + (4 + i)].value, m.planeAtlases[1][i] || m.planeAtlases[1][0], `svrAtlas${4 + i}: R8`);
  }
  assert.equal(mat.uniforms.svrPageCount.value, m.atlasPages);

  // A whole brick: R, G in the first texture, B in the second, the fourth byte dropped.
  const n = 66 ** 3;
  const rgba = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) { rgba[i * 4] = i & 255; rgba[i * 4 + 1] = (i * 3) & 255; rgba[i * 4 + 2] = (i * 5) & 255; rgba[i * 4 + 3] = 255; }
  hw.calls.length = 0;
  assert.equal(m.writeRgbaBrick(2, 1, 0, rgba, 66, 66, 66), true);
  const up = hw.calls.filter(c => c[0] === 'texSubImage3D');
  assert.equal(up.length, 2, 'one upload per texture');
  assert.deepEqual([up[0][8], up[0][9]], [hw.gl.RG, n * 2]);
  assert.deepEqual([up[1][8], up[1][9]], [hw.gl.RED, n]);
  const rg = up[0][10], b = up[1][10];
  for (const i of [0, 1, 777, n - 1]) {
    assert.equal(rg[i * 2], rgba[i * 4]);
    assert.equal(rg[i * 2 + 1], rgba[i * 4 + 1]);
    assert.equal(b[i], rgba[i * 4 + 2]);
  }
  assert.deepEqual(up[0].slice(2, 5), up[1].slice(2, 5), 'both textures take the brick at the same slot origin');
  assert.ok(m.has(2, 1, 0), 'the page table points at the brick');

  // One channel written alone keeps the other two from the CPU copy of the slot.
  hw.calls.length = 0;
  assert.equal(m.writeBrick(2, 0, 1, 0, new Uint8Array(n).fill(9), 66, 66, 66), true);
  const one = hw.calls.filter(c => c[0] === 'texSubImage3D');
  assert.equal(one.length, 2);
  assert.ok(one[1][10].every(v => v === 9), 'channel 2 lands in the R8 texture');

  assert.equal(m.writeRgbaBrickRegion(0, 1, 1, new Uint8Array(8), 0, 0, 0, 2, 2, 1), false, 'sub-box uploads are refused');
  assert.equal(m.writeEncodedBrick(0, 0, 0, { width: 68, height: 68, depth: 66, planes: [] }), false, 'blocks are for compressed atlases');

  // Another atlas on the same material takes the define back off.
  const plain = new S();
  plain.init(3, dims, hw.renderer, mat, { targetSlots: 40, components: 4, apron: 1 });
  assert.equal(plain.split, false, 'split is opt-in');
  assert.ok(!('SVR_SPLIT' in mat.defines), 'an RGBA atlas clears SVR_SPLIT');
  m.dispose();
  assert.ok(hw.calls.some(c => c[0] === 'deleteTexture'), 'dispose deletes the pages');
  console.log('three-channel split atlas: OK');
}

// ── what is not split ─────────────────────────────────────────────────────────
{
  const { S, THREE } = load();
  const hw = fakeRenderer();
  for (const [channels, components] of [[1, 1], [2, 2], [4, 4]]) {
    const m = new S();
    m.init(channels, dims, hw.renderer, material(THREE), { targetSlots: 20, components, apron: 1, split: true });
    assert.equal(m.split, false, `${channels} channel(s) keep one texture`);
    m.dispose();
  }
  const c = new S();
  c.init(3, dims, hw.renderer, material(THREE), { targetSlots: 20, components: 4, apron: 1, split: true, compression: 'bc' });
  assert.equal(c.split, false, 'a compressed atlas is not split');
  assert.equal(c.compressed, true);
  assert.equal(S.canSplit(3), true);
  assert.equal(S.canSplit(4), false);
  c.dispose();
  console.log('split only for three channels: OK');
}

// ── over the budget ───────────────────────────────────────────────────────────
{
  const { S, THREE } = load();
  const hw = fakeRenderer();
  const m = new S();
  const need = S.planAtlas(300, { components: 3, brickSize: 66 }).bytes;
  const rgba = S.planAtlas(300, { components: 4, brickSize: 66 }).bytes;
  assert.ok(need < rgba);
  assert.doesNotThrow(() => m.init(3, dims, hw.renderer, material(THREE), { targetSlots: 300, components: 4, apron: 1, split: true, budgetBytes: need + 1 }));
  assert.equal(m.atlasBytes, need);
  m.dispose();
  const r = new S();
  assert.throws(() => r.init(3, dims, hw.renderer, material(THREE), { targetSlots: 300, components: 4, apron: 1, budgetBytes: need + 1 }),
    (e) => e.code === 'SVR_OVER_BUDGET', 'the same budget refuses the RGBA layout');
  console.log('split fits where RGBA does not: OK');
}
