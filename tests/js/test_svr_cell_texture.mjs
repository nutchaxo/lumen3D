// The fine empty-space texture of SVRManager (option cellSkip, js/core/cell-max.js):
//   • one RGBA8 NEAREST 3D texel per 8³ cell (ptN · 8 per axis), allocated through the
//     same manual GL path as the atlas pages and counted in atlasBytes (live budget);
//   • every brick writer lands its cells (or 255 when it has none) in the same call, at
//     (bx, by, bz) · 8, so voxels and maxima never disagree;
//   • updateUniforms publishes CELL_SKIP + cellMap + cellDim together; clearAtlasDefines
//     and dispose take them away; without the option, nothing is allocated;
//   • a GPU that refuses the texture leaves a working manager without it.
//
// Run: node tests/js/test_svr_cell_texture.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT } from './harness.mjs';

function load() {
  const ctx = vm.createContext({
    console: { warn() {}, log() {}, error() {} }, setTimeout, clearTimeout, window: {}, self: {},
    navigator: { deviceMemory: 8 },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  });
  for (const f of ['js/vendor/three.min.js', 'js/core/bc-codec.js', 'js/core/cell-max.js']) vm.runInContext(readFileSync(path.join(ROOT, f), 'utf8'), ctx);
  vm.runInContext(readFileSync(path.join(ROOT, 'js/core/svr-manager.js'), 'utf8') + '\n;globalThis.__SVR = SVRManager;', ctx);
  return { S: ctx.__SVR, THREE: ctx.THREE, ctx };
}

function fakeRenderer({ refuseCells = false } = {}) {
  const calls = [];
  let nextTex = 1;
  const gl = {
    TEXTURE_3D: 0x806F, TEXTURE_BINDING_3D: 0x806A, TEXTURE_MIN_FILTER: 0x2801, TEXTURE_MAG_FILTER: 0x2800,
    TEXTURE_WRAP_S: 0x2802, TEXTURE_WRAP_T: 0x2803, TEXTURE_WRAP_R: 0x8072, LINEAR: 0x2601, NEAREST: 0x2600,
    CLAMP_TO_EDGE: 0x812F, NO_ERROR: 0, PIXEL_UNPACK_BUFFER: 0x88EC, MAX_3D_TEXTURE_SIZE: 0x8073,
    R8: 0x8229, RG8: 0x822B, RGBA8: 0x8058, RED: 0x1903, RG: 0x8227, RGBA: 0x1908, UNSIGNED_BYTE: 0x1401,
    UNPACK_ALIGNMENT: 0x0CF5,
    getExtension: () => null,
    getParameter(p) { return p === 0x8073 ? 2048 : null; },
    _err: 0,
    getError() { const e = this._err; this._err = 0; return e; },
    createTexture() { return { id: nextTex++ }; },
    deleteTexture(t) { calls.push(['deleteTexture', t.id]); },
    bindTexture(target, t) { calls.push(['bindTexture', target, t && t.id]); },
    texParameteri() {}, bindBuffer() {}, pixelStorei() {},
    texStorage3D(target, levels, fmt, w, h, d) {
      calls.push(['texStorage3D', target, fmt, w, h, d]);
      // The cell grid (24 × 24 × 16) is the only texture of that width.
      if (refuseCells && fmt === this.RGBA8 && w === 24 && h === 24) this._err = 0x0505;
    },
    texSubImage3D(target, level, x, y, z, w, h, d, format, type, data) { calls.push(['texSubImage3D', target, x, y, z, w, h, d, data && data.length]); },
  };
  const props = new Map();
  return {
    calls, gl,
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
  for (const k of ['pageTable', 'slotStride', 'brickApron', 'svrComponents', 'svrPageCount', 'brickSize', 'cellMap']) u[k] = { value: null };
  for (const k of ['atlasDim', 'volumeDim', 'ptDim', 'ptScale', 'cellDim']) u[k] = { value: new THREE.Vector3() };
  return { defines: {}, uniforms: u, needsUpdate: false };
}

const dims = { x: 150, y: 130, z: 70, apron: 1, brickStride: 66 };   // 3 × 3 × 2 bricks → 24 × 24 × 16 cells
const CELLS = 24 * 24 * 16;

// ── allocation, budget, uniforms ──────────────────────────────────────────────
{
  const { S, THREE } = load();
  assert.equal(S.cellBytes(dims), CELLS * 4, 'one RGBA8 texel per 8³ cell of the page-table grid');
  const hw = fakeRenderer();
  const mat = material(THREE);
  const m = new S();
  m.init(3, dims, hw.renderer, mat, { targetSlots: 8, components: 4, apron: 1, cellSkip: true });
  assert.ok(m.cellMap, 'cell texture allocated');
  assert.deepEqual({ ...m.cellDim }, { x: 24, y: 24, z: 16 });
  assert.ok(hw.calls.some(c => c[0] === 'texStorage3D' && c[1] === hw.gl.TEXTURE_3D && c[2] === hw.gl.RGBA8 && c[3] === 24 && c[4] === 24 && c[5] === 16), 'RGBA8 storage of the cell grid');
  const planned = m.atlasBytes - CELLS * 4;
  assert.ok(planned > 0 && m.cellBytes === CELLS * 4, 'the cell texture is part of atlasBytes (the live budget)');
  assert.equal(mat.defines.CELL_SKIP, 1);
  assert.equal(mat.uniforms.cellMap.value, m.cellMap);
  assert.deepEqual([mat.uniforms.cellDim.value.x, mat.uniforms.cellDim.value.y, mat.uniforms.cellDim.value.z], [24, 24, 16]);

  // every writer lands cells at the brick's cell origin, 8³ texels
  const cells = new Uint8Array(8 * 8 * 8 * 4).fill(7);
  const edge = 66, rgba = new Uint8Array(edge ** 3 * 4);
  hw.calls.length = 0;
  assert.ok(m.writeRgbaBrick(1, 2, 0, rgba, edge, edge, edge, cells));
  const w1 = hw.calls.filter(c => c[0] === 'texSubImage3D' && c[5] === 8 && c[6] === 8 && c[7] === 8);
  assert.equal(w1.length, 1);
  assert.deepEqual(w1[0].slice(2, 5), [8, 16, 0], 'brick (1,2,0) → cells at (8,16,0)');
  assert.equal(w1[0][8], 8 * 8 * 8 * 4);
  // without cells: 255 everywhere (nothing skipped by cell)
  hw.calls.length = 0;
  let seen = null;
  const origSub = hw.gl.texSubImage3D;
  hw.gl.texSubImage3D = function (...a) { if (a[5] === 8) seen = a[10]; return origSub.apply(this, a); };
  assert.ok(m.writeRgbaBrick(2, 1, 1, rgba, edge, edge, edge));
  assert.ok(seen && seen.every(v => v === 255), 'a brick delivered without maxima is never skipped by cell');
  // a stale/wrong-size array is not trusted
  seen = null;
  m.writeRgbaBrick(0, 0, 0, rgba, edge, edge, edge, new Uint8Array(10));
  assert.ok(seen.every(v => v === 255));

  S.clearAtlasDefines(mat);
  assert.equal(mat.defines.CELL_SKIP, undefined, 'clearAtlasDefines removes CELL_SKIP');
  hw.calls.length = 0;
  m.dispose();
  assert.ok(hw.calls.some(c => c[0] === 'deleteTexture'), 'the GL texture is deleted');
  assert.equal(m.cellMap, null);
  console.log('cell texture: allocation, writers, uniforms, disposal: OK');
}

// ── off by default; refused by the GPU → manager without cells ───────────────
{
  const { S, THREE } = load();
  const hw = fakeRenderer();
  const m = new S();
  m.init(3, dims, hw.renderer, material(THREE), { targetSlots: 8, components: 4, apron: 1 });
  assert.equal(m.cellMap, null, 'no cell texture unless asked');
  assert.equal(m.cellBytes, 0);
  hw.calls.length = 0;
  m.writeRgbaBrick(0, 0, 0, new Uint8Array(66 ** 3 * 4), 66, 66, 66, new Uint8Array(2048));
  assert.ok(!hw.calls.some(c => c[0] === 'texSubImage3D' && c[5] === 8), 'nothing written without the texture');

  const bad = fakeRenderer({ refuseCells: true });
  const mat = material(THREE);
  const m2 = new S();
  m2.init(3, dims, bad.renderer, mat, { targetSlots: 8, components: 4, apron: 1, cellSkip: true });
  assert.equal(m2.cellMap, null, 'a refused allocation leaves the manager without cells');
  assert.ok(m2.isUsable());
  assert.equal(mat.defines.CELL_SKIP, undefined);
  assert.ok(m2.writeRgbaBrick(0, 0, 0, new Uint8Array(66 ** 3 * 4), 66, 66, 66));
  console.log('cell texture off / refused: OK');
}

console.log('svr cell texture: OK');
