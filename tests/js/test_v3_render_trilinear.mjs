// Seamless trilinear sampling of a bordered (v3) brick atlas, proven on the CPU.
//
// The REAL SVRManager lays the atlas out (66³ slots, pages, page table) and uploads
// the bricks the loader delivers (stored 66³ frame, cut to the volume by cropToVolume);
// its texSubImage3D is redirected into JS arrays. A CPU emulator then samples that
// atlas exactly as the ray-marcher does (volume-viewer.js fetchVoxel → slotCoord):
//     cell = floor(clamp(pos, 0, dim − 1) / 64),  t = slot·66 + 1 + clamp(pos − 64·cell, 0, 64)
// followed by what LINEAR filtering with CLAMP_TO_EDGE does in hardware (texel i0 =
// floor(t − ½), weight t − ½ − i0 per axis). The result must equal trilinear
// interpolation of the WHOLE volume (clamp-to-edge) at every point whose brick is
// stored — across brick faces, edges and corners, at the volume's borders, and on
// atlases spread over several pages. The emulator's formula is the shader's (checked
// against the source text). Also covered: v2 64³ slots read the exact voxel (nearest),
// R8 / RG8 atlases (absent channels read 0), the atlas layout in multiples of 66, the
// LINEAR / NEAREST filter per format, budget accounting in bytes, region uploads in the
// 66 frame, and the zero slot for ESS-dropped bricks.
//
// Run: node tests/js/test_v3_render_trilinear.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { ROOT } from './harness.mjs';

const require = createRequire(import.meta.url);
const REAL_THREE = require('../../js/vendor/three.min.js');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');

function loadSVR() {
  const ctx = vm.createContext({
    console: { warn() {}, log() {}, error() {} }, setTimeout, clearTimeout, window: {}, navigator: {},
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} }, THREE: REAL_THREE
  });
  vm.runInContext(read('js/core/svr-manager.js') + '\n;globalThis.__SVR = SVRManager; globalThis.__ROI = SVRRoi;', ctx);
  return ctx.__SVR;
}
const SVRManager = loadSVR();

// A WebGL stub that accepts every allocation (the bookkeeping is what is tested).
function stubRenderer(max3D = 2048) {
  const gl = {
    NO_ERROR: 0, TEXTURE_3D: 1, TEXTURE_BINDING_3D: 2, LINEAR: 3, NEAREST: 4, R8: 5, RG8: 6, RGBA8: 7, RED: 8, RG: 9, RGBA: 10,
    UNSIGNED_BYTE: 11, CLAMP_TO_EDGE: 12, TEXTURE_MIN_FILTER: 13, TEXTURE_MAG_FILTER: 14, TEXTURE_WRAP_S: 15, TEXTURE_WRAP_T: 16, TEXTURE_WRAP_R: 17,
    filters: [],
    getError: () => 0, createTexture: () => ({}), deleteTexture() {}, bindTexture() {}, getParameter: () => null,
    texParameteri(t, p, v) { if (p === 13) gl.filters.push(v); }, texStorage3D() {}, isContextLost: () => false
  };
  const props = new Map();
  return { gl, capabilities: { max3DTextureSize: max3D }, getContext: () => gl, properties: { get: (o) => { if (!props.has(o)) props.set(o, {}); return props.get(o); } } };
}

// Deterministic pseudo-random voxels.
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

/** A volume of `channels` channels; brick columns listed in `empty` hold zeros only. */
function makeVolume(dims, channels, seed, empty = []) {
  const r = rng(seed);
  const n = dims.x * dims.y * dims.z;
  const ch = Array.from({ length: channels }, () => new Uint8Array(n));
  const isEmpty = (x, y, z) => empty.some(([bx, by, bz]) => Math.floor(x / 64) === bx && Math.floor(y / 64) === by && Math.floor(z / 64) === bz);
  for (let z = 0; z < dims.z; z++) for (let y = 0; y < dims.y; y++) for (let x = 0; x < dims.x; x++) {
    if (isEmpty(x, y, z)) continue;
    for (let c = 0; c < channels; c++) ch[c][(z * dims.y + y) * dims.x + x] = 1 + Math.floor(r() * 254);
  }
  return { dims, channels, ch };
}

const clampI = (v, n) => Math.max(0, Math.min(n - 1, v));
const voxel = (vol, c, x, y, z) => vol.ch[c][(clampI(z, vol.dims.z) * vol.dims.y + clampI(y, vol.dims.y)) * vol.dims.x + clampI(x, vol.dims.x)];

/** Trilinear interpolation of the whole volume at continuous position p (voxel i spans [i, i+1]). */
function trilinearVolume(vol, c, p) {
  const b = [p.x - 0.5, p.y - 0.5, p.z - 0.5];
  const i0 = b.map(Math.floor);
  const f = b.map((v, k) => v - i0[k]);
  let acc = 0;
  for (let dz = 0; dz < 2; dz++) for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
    const w = (dx ? f[0] : 1 - f[0]) * (dy ? f[1] : 1 - f[1]) * (dz ? f[2] : 1 - f[2]);
    acc += w * voxel(vol, c, i0[0] + dx, i0[1] + dy, i0[2] + dz);
  }
  return acc;
}

/** The stored brick of SPEC §13.2: 66³, voxels [64·b − 1, 64·b + 65) clamp-to-edge, every channel interleaved. */
function storedBrick(vol, bx, by, bz, comps) {
  const S = 66;
  const out = new Uint8Array(S * S * S * comps);
  for (let sz = 0; sz < S; sz++) for (let sy = 0; sy < S; sy++) for (let sx = 0; sx < S; sx++) {
    for (let c = 0; c < vol.channels; c++) {
      out[((sz * S + sy) * S + sx) * comps + c] = voxel(vol, c, bx * 64 - 1 + sx, by * 64 - 1 + sy, bz * 64 - 1 + sz);
    }
  }
  return out;
}

/** BrickLoader's cropToVolume on a v3 brick: stored voxels whose volume coordinate is in [−1, dim]. */
function cropToVolume(data, vol, bx, by, bz, comps) {
  const S = 66;
  const bw = Math.min(S, vol.dims.x - bx * 64 + 2);
  const bh = Math.min(S, vol.dims.y - by * 64 + 2);
  const bd = Math.min(S, vol.dims.z - bz * 64 + 2);
  if (bw === S && bh === S && bd === S) return { data, bw, bh, bd };
  const out = new Uint8Array(bw * bh * bd * comps);
  let o = 0;
  for (let z = 0; z < bd; z++) for (let y = 0; y < bh; y++) {
    const src = ((z * S + y) * S) * comps;
    out.set(data.subarray(src, src + bw * comps), o);
    o += bw * comps;
  }
  return { data: out, bw, bh, bd };
}

function materialStub() {
  const u = () => ({ value: null });
  const uniforms = {};
  for (const k of ['pageTable', 'atlasDim', 'volumeDim', 'ptDim', 'ptScale', 'brickSize', 'svrPageCount', 'slotStride', 'brickApron', 'svrComponents']) uniforms[k] = u();
  for (let i = 0; i < 8; i++) uniforms['svrAtlas' + i] = u();
  return { defines: {}, uniforms };
}

/** An SVRManager whose texSubImage3D writes into JS pages (headless otherwise). */
function atlasFor(vol, { apron, components, max3D = 2048, bricks }) {
  const svr = new SVRManager();
  const fakeRenderer = stubRenderer(max3D);
  const dims = { x: vol.dims.x, y: vol.dims.y, z: vol.dims.z, brickStride: apron ? 66 : 64, apron };
  svr.init(vol.channels, dims, fakeRenderer, materialStub(), { targetSlots: Math.max(2, bricks.length), components, budgetBytes: 4 * 1024 ** 3 });
  const pages = svr.atlases.map(() => new Uint8Array(svr.atlasDim * svr.atlasDim * svr.atlasDepth * components));
  svr.renderer = null;   // headless bookkeeping from here on: uploads go to `pages`
  svr._uploadRgbaRegion = (page, sx, sy, sz, w, h, d, data) => {
    assert.ok(sx >= 0 && sy >= 0 && sz >= 0 && sx + w <= svr.atlasDim && sy + h <= svr.atlasDim && sz + d <= svr.atlasDepth, 'upload inside the page');
    for (let z = 0; z < d; z++) for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      for (let c = 0; c < components; c++) {
        pages[page][(((sz + z) * svr.atlasDim + (sy + y)) * svr.atlasDim + (sx + x)) * components + c] = data[((z * h + y) * w + x) * components + c];
      }
    }
    return true;
  };
  return { svr, pages };
}

// The shader's address math (volume-viewer.js slotCoord) — the emulator below must be it.
{
  const vv = read('js/viewers/volume-viewer.js').replace(/\r\n/g, '\n');
  assert.ok(/vec3 local = clamp\(pos - cell \* brickSize, vec3\(0\.0\), vec3\(brickSize\)\);\n\s*return \(slot \* stride \+ vec3\(apron\) \+ local\) \/ atlasSize;/.test(vv), 'shader slotCoord (bordered) as emulated');
  assert.ok(/vec3 vox = clamp\(uvw \* dim, vec3\(0\.0\), dim - vec3\(1\.0\)\);\n\s*return floor\(vox \/ brickSize\);/.test(vv), 'shader brickCellIn as emulated');
}

/** fetchVoxel of the shader on the emulated atlas: { present, value[c] } at continuous position pos. */
function sampleAtlas({ svr, pages }, dims, pos, { linear }) {
  const comps = svr.components;
  const cell = ['x', 'y', 'z'].map(a => Math.floor(Math.max(0, Math.min(dims[a] - 1, pos[a])) / 64));
  const pt = ((cell[2] * svr.ptNy + cell[1]) * svr.ptNx + cell[0]) * 4;
  const page = svr.pageData[pt + 3] - 1;
  if (page < 0) return { present: false, value: [0, 0, 0, 0] };
  const slot = [svr.pageData[pt], svr.pageData[pt + 1], svr.pageData[pt + 2]];
  const stride = svr.slotStride;
  const A = [svr.atlasDim, svr.atlasDim, svr.atlasDepth];
  const texel = (ix, iy, iz) => {
    const x = clampI(ix, A[0]), y = clampI(iy, A[1]), z = clampI(iz, A[2]);
    const o = ((z * A[1] + y) * A[0] + x) * comps;
    return Array.from({ length: 4 }, (_, c) => (c < comps ? pages[page][o + c] : (c === 3 ? 255 : 0)));
  };
  let raw;
  if (linear) {
    const t = ['x', 'y', 'z'].map((a, k) => slot[k] * stride + svr.apron + Math.max(0, Math.min(64, pos[a] - cell[k] * 64)));
    const b = t.map(v => v - 0.5);
    const i0 = b.map(Math.floor);
    const f = b.map((v, k) => v - i0[k]);
    raw = [0, 0, 0, 0];
    for (let dz = 0; dz < 2; dz++) for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
      const w = (dx ? f[0] : 1 - f[0]) * (dy ? f[1] : 1 - f[1]) * (dz ? f[2] : 1 - f[2]);
      const tx = texel(i0[0] + dx, i0[1] + dy, i0[2] + dz);
      for (let c = 0; c < 4; c++) raw[c] += w * tx[c];
    }
  } else {
    const local = ['x', 'y', 'z'].map((a, k) => {
      const p = Math.max(0, Math.min(dims[a] - 1, pos[a]));
      const extent = Math.min(64, dims[a] - cell[k] * 64);
      return Math.max(0, Math.min(extent - 1, Math.floor(p - cell[k] * 64)));
    });
    raw = texel(slot[0] * stride + local[0], slot[1] * stride + local[1], slot[2] * stride + local[2]);
  }
  // keepComponents: an R8 / RG8 atlas's alpha of 1 never reads as channel 3.
  const value = raw.map((v, c) => (c < comps ? v : 0));
  return { present: true, value };
}

function samplePoints(dims, r, count) {
  const pts = [];
  const axes = ['x', 'y', 'z'];
  // Brick faces, ± a hair and ± half a voxel, and the volume's own borders.
  const special = (n) => {
    const s = [0, 0.25, 0.5, 0.75, n - 0.5, n - 0.25, n];
    for (let k = 64; k < n; k += 64) s.push(k - 1, k - 0.5, k - 0.25, k - 1e-6, k, k + 1e-6, k + 0.25, k + 0.5, k + 1);
    return s;
  };
  const sp = axes.map(a => special(dims[a]));
  for (let i = 0; i < count; i++) {
    const p = {};
    axes.forEach((a, k) => {
      p[a] = r() < 0.6 ? sp[k][Math.floor(r() * sp[k].length)] : r() * dims[a];
    });
    pts.push(p);
  }
  return pts;
}

// ── 1. v3: seamless trilinear across bricks, one channel, R8, several pages ──
for (const scenario of [
  { name: 'R8, 1 channel, one page', channels: 1, components: 1, max3D: 2048, dims: { x: 150, y: 100, z: 70 } },
  { name: 'RG8, 2 channels, pages of 264³ (several pages)', channels: 2, components: 2, max3D: 264, dims: { x: 260, y: 260, z: 130 } },
  { name: 'RGBA8, 3 channels', channels: 3, components: 4, max3D: 2048, dims: { x: 129, y: 65, z: 64 } }
]) {
  const vol = makeVolume(scenario.dims, scenario.channels, 7 + scenario.channels);
  const g = ['x', 'y', 'z'].map(a => Math.ceil(scenario.dims[a] / 64));
  const bricks = [];
  for (let bz = 0; bz < g[2]; bz++) for (let by = 0; by < g[1]; by++) for (let bx = 0; bx < g[0]; bx++) bricks.push([bx, by, bz]);
  const at = atlasFor(vol, { apron: 1, components: scenario.components, max3D: scenario.max3D, bricks });
  assert.equal(at.svr.slotStride, 66);
  assert.equal(at.svr.atlasDim % 66, 0, 'page side is a multiple of 66');
  assert.equal(at.svr.atlasDepth % 66, 0, 'page depth is a multiple of 66');
  assert.ok(at.svr.atlases.every(t => t.minFilter === REAL_THREE.LinearFilter && t.magFilter === REAL_THREE.LinearFilter), 'bordered atlas: LINEAR');
  assert.equal(at.svr.atlasBytes, at.svr.maxSlots * 66 ** 3 * scenario.components, 'budget accounted in bytes of 66³ slots');
  if (scenario.max3D === 264) assert.ok(at.svr.atlases.length > 1, 'spread over several pages');
  for (const [bx, by, bz] of bricks) {
    const full = storedBrick(vol, bx, by, bz, scenario.components);
    const { data, bw, bh, bd } = cropToVolume(full, vol, bx, by, bz, scenario.components);
    assert.equal(at.svr.writeRgbaBrick(bx, by, bz, data, bw, bh, bd), true);
  }
  const r = rng(99);
  let worst = 0;
  const pts = samplePoints(scenario.dims, r, 6000);
  for (const p of pts) {
    const s = sampleAtlas(at, scenario.dims, p, { linear: true });
    assert.ok(s.present);
    for (let c = 0; c < 4; c++) {
      const ref = c < scenario.channels ? trilinearVolume(vol, c, p) : 0;
      worst = Math.max(worst, Math.abs(s.value[c] - ref));
    }
  }
  assert.ok(worst < 1e-9, `${scenario.name}: atlas trilinear = volume trilinear (worst ${worst})`);
  console.log(`v3 ${scenario.name}: ${pts.length} points, |atlas − volume| ≤ ${worst.toExponential(1)}: OK`);
}

// ── 2. v3 with ESS-dropped bricks: exact wherever a brick is stored ───────────
{
  const dims = { x: 192, y: 128, z: 70 };
  const empty = [[1, 0, 0], [2, 1, 1]];
  const vol = makeVolume(dims, 1, 3, empty);
  const bricks = [];
  for (let bz = 0; bz < 2; bz++) for (let by = 0; by < 2; by++) for (let bx = 0; bx < 3; bx++) {
    if (!empty.some(([x, y, z]) => x === bx && y === by && z === bz)) bricks.push([bx, by, bz]);
  }
  const at = atlasFor(vol, { apron: 1, components: 1, bricks });
  for (const [bx, by, bz] of bricks) {
    const { data, bw, bh, bd } = cropToVolume(storedBrick(vol, bx, by, bz, 1), vol, bx, by, bz, 1);
    at.svr.writeRgbaBrick(bx, by, bz, data, bw, bh, bd);
  }
  const r = rng(5);
  let present = 0, absent = 0, worst = 0;
  for (const p of samplePoints(dims, r, 8000)) {
    const s = sampleAtlas(at, dims, p, { linear: true });
    const ref = trilinearVolume(vol, 0, p);
    if (s.present) {
      present++;
      worst = Math.max(worst, Math.abs(s.value[0] - ref));
    } else {
      absent++;
      // Inside a dropped brick the march skips (reads 0). The volume's own trilinear
      // is non-zero there only within half a voxel of a stored neighbour's face.
      if (ref > 0) {
        const cell = ['x', 'y', 'z'].map(a => Math.floor(Math.min(dims[a] - 1, p[a]) / 64));
        const nearFace = ['x', 'y', 'z'].some((a, k) => {
          const lo = cell[k] * 64, hi = Math.min(dims[a], lo + 64);
          return p[a] - lo < 0.5 || hi - p[a] < 0.5;
        });
        assert.ok(nearFace, 'a dropped brick differs from the volume only in the half-voxel band at its faces');
      }
    }
  }
  assert.ok(present > 0 && absent > 0);
  assert.ok(worst < 1e-9, `stored bricks exact next to dropped ones (worst ${worst})`);
  console.log(`v3 with ESS-dropped bricks: ${present} stored-brick points exact, ${absent} skipped points only differ in the half-voxel band: OK`);
}

// ── 3. v2: 64³ slots, nearest, the exact voxel ────────────────────────────────
{
  const dims = { x: 150, y: 100, z: 70 };
  const vol = makeVolume(dims, 2, 11);
  const bricks = [];
  for (let bz = 0; bz < 2; bz++) for (let by = 0; by < 2; by++) for (let bx = 0; bx < 3; bx++) bricks.push([bx, by, bz]);
  const at = atlasFor(vol, { apron: 0, components: 2, bricks });
  assert.equal(at.svr.slotStride, 64);
  assert.ok(at.svr.atlases.every(t => t.minFilter === REAL_THREE.NearestFilter), 'v2 atlas keeps NEAREST');
  assert.ok([256, 512, 1024].includes(at.svr.atlasDim), 'v2 pages keep their 256/512/1024 sides');
  for (const [bx, by, bz] of bricks) {
    // cropToVolume on a v2 brick: the voxels inside the volume.
    const bw = Math.min(64, dims.x - bx * 64), bh = Math.min(64, dims.y - by * 64), bd = Math.min(64, dims.z - bz * 64);
    const data = new Uint8Array(bw * bh * bd * 2);
    for (let z = 0; z < bd; z++) for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
      for (let c = 0; c < 2; c++) data[((z * bh + y) * bw + x) * 2 + c] = voxel(vol, c, bx * 64 + x, by * 64 + y, bz * 64 + z);
    }
    at.svr.writeRgbaBrick(bx, by, bz, data, bw, bh, bd);
  }
  const r = rng(13);
  for (const p of samplePoints(dims, r, 4000)) {
    const s = sampleAtlas(at, dims, p, { linear: false });
    const q = ['x', 'y', 'z'].map(a => Math.floor(Math.max(0, Math.min(dims[a] - 1, p[a]))));
    assert.deepEqual(s.value, [voxel(vol, 0, ...q), voxel(vol, 1, ...q), 0, 0]);
  }
  console.log('v2 (64³ slots, nearest, RG8): the exact voxel, absent channels 0: OK');
}

// ── 4. layout, budget and region uploads in the bordered frame ───────────────
{
  const MiB = 1024 * 1024;
  const p = SVRManager.planAtlas(100, { max3D: 2048, components: 4, brickSize: 66 });
  assert.equal(p.dim % 66, 0);
  assert.equal(p.depth % 66, 0);
  assert.ok(p.slots >= 100 && p.bytes === p.slots * 66 ** 3 * 4, 'bytes are slots × 66³ × components');
  const p64 = SVRManager.planAtlas(100, { max3D: 2048, components: 4 });
  assert.deepEqual([p64.dim, p64.bytes % (64 ** 3 * 4)], [256, 0], 'v2 layout unchanged');
  assert.equal(SVRManager.planAtlas(5000, { max3D: 2048, brickSize: 66, maxPages: 4 }), null, 'a detail atlas never takes more than its pages');
  const within = SVRManager.planAtlasWithin(64 * MiB, { max3D: 2048, components: 1, brickSize: 66 });
  assert.ok(within.bytes <= 64 * MiB && SVRManager.planAtlas(within.slots + 1, { max3D: 2048, components: 1, brickSize: 66 }).bytes > 64 * MiB,
    'planAtlasWithin: the largest layout under the byte limit');
  assert.equal(SVRManager.componentsForChannels(1), 1);
  assert.equal(SVRManager.componentsForChannels(2), 2);
  assert.equal(SVRManager.componentsForChannels(3), 4);
  assert.equal(SVRManager.maxSlotsForBudget(null, { components: 1, budgetBytes: 66 ** 3 * 10, brickSize: 66 }), 10, 'slot ceiling counted in 66³ R8 slots');
  // A stride that contradicts the apron is refused rather than laid out scrambled.
  assert.throws(() => new SVRManager().init(1, { x: 64, y: 64, z: 64, brickStride: 66, apron: 0 }, null, { defines: {}, uniforms: {} }, {}), /stride/);

  // Region upload (the Studio's throwaway atlas): coordinates in the 66 frame.
  const vol = makeVolume({ x: 64, y: 64, z: 64 }, 1, 1);
  const at = atlasFor(vol, { apron: 1, components: 1, bricks: [[0, 0, 0]] });
  assert.equal(at.svr.writeRgbaBrickRegion(0, 0, 0, new Uint8Array(66 * 66), 0, 0, 65, 66, 66, 1), true, 'the last stored plane (border) fits');
  assert.equal(at.svr.writeRgbaBrickRegion(0, 0, 0, new Uint8Array(66 * 66), 0, 0, 66, 66, 66, 1), false, 'past the stored 66 refused');
  // ESS-dropped bricks point at one shared slot of 66³ zeros.
  const uploads = [];
  const z = atlasFor(makeVolume({ x: 128, y: 64, z: 64 }, 1, 2), { apron: 1, components: 1, bricks: [[0, 0, 0], [1, 0, 0]] });
  z.svr._uploadRgbaRegion = (pg, sx, sy, sz, w, h, d, data) => { uploads.push({ w, h, d, n: data.length }); return true; };
  assert.equal(z.svr.pointEmptyBricks((bx) => bx === 1), 1);
  assert.deepEqual(uploads[0], { w: 66, h: 66, d: 66, n: 66 ** 3 }, 'the zero slot is a whole 66³');
  console.log('layout in multiples of 66, bytes, planAtlasWithin, region and zero-slot uploads: OK');
}

// ── 5. what the shader is told: stride, border, components, filter ───────────
{
  const u = () => ({ value: null });
  const material = { defines: {}, uniforms: { pageTable: u(), atlasDim: u(), volumeDim: u(), ptDim: u(), ptScale: u(), brickSize: u(), svrPageCount: u(), svrAtlas0: u(), slotStride: u(), brickApron: u(), svrComponents: u() } };
  const svr = new SVRManager();
  const rr = stubRenderer();
  svr.init(2, { x: 130, y: 70, z: 64, brickStride: 66, apron: 1 }, rr, material, { targetSlots: 6, components: 2, budgetBytes: 1024 ** 3 });
  assert.equal(material.defines.ENABLE_SVR, 1);
  assert.equal(material.defines.SVR_COMPONENTS, 2, 'RG8 atlas: SVR_COMPONENTS 2');
  assert.equal(material.uniforms.slotStride.value, 66);
  assert.equal(material.uniforms.brickApron.value, 1);
  assert.equal(material.uniforms.svrComponents.value, 2);
  assert.equal(material.uniforms.brickSize.value, 64, 'cells stay 64³ interiors');
  assert.ok(rr.gl.filters.length && rr.gl.filters.every(f => f === rr.gl.LINEAR), 'the GL texture of a bordered atlas filters LINEAR');
  const m4 = { defines: { SVR_COMPONENTS: 1 }, uniforms: { ...material.uniforms } };
  const r4 = stubRenderer();
  new SVRManager().init(4, { x: 64, y: 64, z: 64 }, r4, m4, { targetSlots: 2, budgetBytes: 1024 ** 3 });
  assert.ok(!('SVR_COMPONENTS' in m4.defines), 'an RGBA8 atlas removes the define');
  assert.equal(m4.uniforms.slotStride.value, 64);
  assert.ok(r4.gl.filters.every(f => f === r4.gl.NEAREST), 'a v2 atlas filters NEAREST');
  console.log('uniforms and defines published per atlas format: OK');
}
