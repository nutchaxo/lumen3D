// The Studio's native picture of an axis-aligned plane, read from a 2D array texture
// of exactly the voxel planes it samples (no 3D atlas), is the picture the atlas path
// gives — pixel for pixel.
//
// Both paths go through the same slice shader; only rawAt() differs (FRAG: PLANE_TEX
// versus ENABLE_SVR). The shader is emulated here in float32 (Math.fround on every
// operation of the texture coordinate, as the GPU computes it), once with the atlas
// lookup (getAtlasLookup over the bricks a 3D atlas would hold, a sentinel outside
// the voxel box each brick was given — a read there would be a hole in the real
// atlas) and once with the plane lookup over a plane texture built by the REAL page
// code: StudioPlaneOps (planner, extraction, MIP reduction, placement) and
// viewer.js _planeNativeBackend (lifted from the source), fed composed brick rows as
// the loader delivers them (cropped to the volume, z-major RGBA). Covered:
//   • XY / XZ / YZ single planes, anisotropic voxels, an empty (ESS) brick, a brick
//     that never arrives (the preview raw stands in for it), partial edge bricks;
//   • an ESS-dropped brick is zero voxels on both paths (the atlas points it at a
//     slot of zeros, the plane marks its column present): the preview never stands
//     in for it — a whole-stack MIP over columns with one, two or all of their bricks
//     dropped equals the MIP of the true volume, pixel for pixel;
//   • a plane exactly on a voxel face (the GPU's float32 product may floor either
//     way: two candidate planes are kept and the shader picks its own);
//   • z-stack MIP slabs (+Z face, −Z face, in-plane roll, part of the stack), whose
//     plane holds the per-channel maximum over the slab's slices;
//   • what the plane path refuses (oblique, average, a slab sample on a voxel face)
//     goes to the atlas path;
//   • the geometric crop holds every pixel the plane shows, and the slab footprint
//     is the shader's hits > 0;
//   • _nativeSliceBricksForSpec adds the neighbour voxel only near a voxel face.
//
// Run: node tests/js/test_viewerpage_native_plane.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { loadModule, ROOT } from './harness.mjs';

const require = createRequire(import.meta.url);
const THREE = require('../../js/vendor/three.min.js');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const viewerSrc = read('js/pages/viewer.js');
const slicerSrc = read('js/viewers/volume-slicer.js');

const VolumeSlicer = loadModule('js/viewers/volume-slicer.js', 'VolumeSlicer', { THREE, window: {} });
const Ops = loadModule('js/workers/studio-plane-ops.js', 'StudioPlaneOps', {});
assert.ok(VolumeSlicer?.planeGeometry && Ops?.planePlan, 'modules load');

function lift(src, name) {
  const m = src.match(new RegExp(`\\n  function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n  \\}\\n`));
  assert.ok(m, `${name} must be defined at module level in viewer.js`);
  return m[0];
}

// ── The shader the emulator follows (checked, so a change there fails here) ─────
{
  const frag = slicerSrc.slice(slicerSrc.indexOf('const FRAG = `'), slicerSrc.indexOf('`;', slicerSrc.indexOf('const FRAG = `')));
  assert.ok(frag.includes('vec3 voxel = floor(clamp(uvw * planeDim, vec3(0.0), planeDim - vec3(1.0)));'), 'PLANE_TEX: the voxel, as getAtlasLookup floors it');
  assert.ok(frag.includes('vec3 brick = floor(voxel / planeBrickSize);'), 'PLANE_TEX: the brick column');
  assert.ok(frag.includes('int layer = planeReduced == 1 ? 0 : int(along) - planeLayerBase;'), 'PLANE_TEX: the layer along the normal');
  assert.ok(/present = layer >= 0 && layer < planeLayers\s*&& texelFetch\(planePresence, ivec3\(column, layer\), 0\)\.r > 0\.5;/.test(frag), 'PLANE_TEX: presence per column and layer');
  assert.ok(/if \(planeAxis == 2\) \{ texel = ivec2\(voxel\.xy\); column = ivec2\(brick\.xy\); along = voxel\.z; \}/.test(frag), 'axis z: u = x, v = y');
  assert.ok(/else if \(planeAxis == 1\) \{ texel = ivec2\(voxel\.xz\); column = ivec2\(brick\.xz\); along = voxel\.y; \}/.test(frag), 'axis y: u = x, v = z');
  assert.ok(/else \{ texel = ivec2\(voxel\.yz\); column = ivec2\(brick\.yz\); along = voxel\.x; \}/.test(frag), 'axis x: u = y, v = z');
  assert.ok(/hits\+\+;\s*#ifdef PLANE_TEX[\s\S]*?if \(planeReduced == 1\) break;\s*#endif/.test(frag), 'a reduced plane stops at the first sample in the box');
  assert.ok(frag.includes('vec2 uv = uvWindow.xy + vec2(vUv.x, flipY > 0.5 ? 1.0 - vUv.y : vUv.y) * uvWindow.zw;'), 'tiles drawn upside down');
  console.log('slice shader PLANE_TEX variant (as emulated): OK');
}

// ── A synthetic volume ─────────────────────────────────────────────────────────
const BS = 16;
const DIMS = { x: 70, y: 52, z: 41, brickSize: BS, channels: 4 };
const PHYSICAL = { x: 140, y: 104, z: 205 };       // anisotropic, z the longest
const grid = { nx: Math.ceil(DIMS.x / BS), ny: Math.ceil(DIMS.y / BS), nz: Math.ceil(DIMS.z / BS) };
const keyOf = (b) => `${b.bx}_${b.by}_${b.bz}`;
// ESS-dropped bricks: (1,1,1) and (2,0,1) alone in their column, two of the three
// bricks of column (0,3), the whole of column (4,3).
const EMPTY = new Set(['1_1_1', '2_0_1', '0_3_0', '0_3_2', '4_3_0', '4_3_1', '4_3_2']);
const ACTIVE = [];
for (let bz = 0; bz < grid.nz; bz++) for (let by = 0; by < grid.ny; by++) for (let bx = 0; bx < grid.nx; bx++) {
  if (!EMPTY.has(`${bx}_${by}_${bz}`)) ACTIVE.push({ bx, by, bz });
}
const voxel = (x, y, z, c) => ((x * 73856093) ^ (y * 19349663) ^ (z * 83492791) ^ (c * 2654435761)) >>> 0 & 255;

const f = Math.fround;
const fadd = (a, b) => f(f(a) + f(b));
const fmul = (a, b) => f(f(a) * f(b));

/**
 * The slice shader's RAW_OUTPUT main() with FALLBACK_TEX, float32, over the window
 * `win` of a R² frame (canvas rows), `rawAt(uvw) → {present, v: [4]}`.
 */
function renderRaw({ g, R, win, rawAt, reduced = false, numChannels = 4, fallback = null }) {
  const out = new Uint8Array(win.w * win.h * 4);
  const E = g.extent;
  const steps = g.steps;
  const delta = f(g.delta);
  const projected = !(g.projMode === 0 || steps <= 1);
  const halfSlab = fmul(fmul(steps - 1, delta), 0.5);
  const inBox = (u) => u.x >= 0 && u.y >= 0 && u.z >= 0 && u.x <= 1 && u.y <= 1 && u.z <= 1;
  for (let j = 0; j < win.h; j++) {
    for (let i = 0; i < win.w; i++) {
      // A tile drawn flipped: window row j sits at GL frame row R − 1 − (win.y + j).
      const uvx = f((win.x + i + 0.5) / R);
      const uvy = f((R - win.y - j - 0.5) / R);
      const pcx = fmul(fmul(uvx - 0.5, 2), E);
      const pcy = fmul(fmul(uvy - 0.5, 2), E);
      const base = {};
      for (const k of ['x', 'y', 'z']) base[k] = fadd(fadd(g.origin[k], fmul(pcx, g.right[k])), fmul(pcy, g.up[k]));
      let raw = [0, 0, 0, 0];
      let missing = false;
      let empty = false;
      if (!projected) {
        const uvw = { x: fadd(base.x, 0.5), y: fadd(base.y, 0.5), z: fadd(base.z, 0.5) };
        if (!inBox(uvw)) empty = true;
        else {
          const s = rawAt(uvw);
          raw = s.v;
          missing = !s.present;
        }
      } else {
        let hits = 0;
        for (let n = 0; n < steps; n++) {
          const t = fadd(-halfSlab, fmul(n, delta));
          const uvw = {};
          for (const k of ['x', 'y', 'z']) uvw[k] = fadd(fadd(base[k], fmul(t, g.step[k])), 0.5);
          if (!inBox(uvw)) continue;
          const s = rawAt(uvw);
          if (!s.present) missing = true;
          raw = raw.map((v, c) => Math.max(v, s.v[c]));
          hits++;
          if (reduced) break;
        }
        if (!hits) empty = true;
        else if (numChannels < 4) raw[3] = 255;
      }
      const o = (j * win.w + i) * 4;
      if (empty) continue;
      if (missing) {
        const fb = fallback ? fallback(win.x + i, win.y + j) : null;
        if (fb) out.set(fb, o);
        continue;
      }
      out.set(raw, o);
    }
  }
  return out;
}

/**
 * getAtlasLookup over the bricks of a 3D atlas: `held` key → voxel box written. An
 * ESS-dropped brick's page entry points at the slot of zeros (SVRManager.
 * pointEmptyBricks, called by viewer.js _atlasNativeBackend).
 */
let outsideReads = 0;
function atlasRawAt(held) {
  const dim = { x: DIMS.x, y: DIMS.y, z: DIMS.z };
  return (uvw) => {
    const lp = {};
    for (const k of ['x', 'y', 'z']) lp[k] = Math.min(Math.max(fmul(uvw[k], dim[k]), 0), dim[k] - 1);
    const b = { bx: Math.floor(lp.x / BS), by: Math.floor(lp.y / BS), bz: Math.floor(lp.z / BS) };
    if (EMPTY.has(keyOf(b))) return { present: true, v: [0, 0, 0, 0] };
    const box = held.get(keyOf(b));
    if (!box) return { present: false, v: [0, 0, 0, 0] };
    const vx = Math.floor(lp.x), vy = Math.floor(lp.y), vz = Math.floor(lp.z);
    const lx = vx - b.bx * BS, ly = vy - b.by * BS, lz = vz - b.bz * BS;
    // The real atlas holds only the uploaded box: anything else is undefined memory.
    if (box && (lx < box.x0 || lx >= box.x1 || ly < box.y0 || ly >= box.y1 || lz < box.z0 || lz >= box.z1)) {
      outsideReads++;
      return { present: true, v: [0xEE, 0xEE, 0xEE, 0xEE] };
    }
    return { present: true, v: [0, 1, 2, 3].map(c => voxel(vx, vy, vz, c)) };
  };
}

/**
 * A CPU stand-in for VolumeSlicer.createPlaneVolume (same arguments, same handle).
 * Zero-initialised, as WebGL initialises texStorage3D storage.
 */
function cpuPlaneVolume(desc) {
  const axes = Ops.PLANE_AXES[desc.axis];
  const W = desc.dims[axes[0]], H = desc.dims[axes[1]], L = desc.layers;
  const bs = desc.brickSize;
  const cu = Math.ceil(W / bs), cv = Math.ceil(H / bs);
  const tex = new Uint8Array(W * H * L * 4);
  const presence = new Uint8Array(cu * cv * L);
  return {
    axis: desc.axis, width: W, height: H, layers: L, layerBase: desc.layerBase, reduced: desc.reduced,
    brickSize: bs, dims: desc.dims, texture: { tex }, presence: { presence }, bytes: W * H * L * 4,
    upload(u0, v0, w, h, layer, data) {
      if (u0 < 0 || v0 < 0 || u0 + w > W || v0 + h > H || layer < 0 || layer >= L || data.length < w * h * 4) return false;
      for (let r = 0; r < h; r++) tex.set(data.subarray(r * w * 4, (r + 1) * w * 4), ((layer * H + v0 + r) * W + u0) * 4);
      return true;
    },
    setPresent(bu, bv, layer, on = true) { presence[(layer * cv + bv) * cu + bu] = on ? 255 : 0; },
    flushErrors() { return []; },
    dispose() {}
  };
}

/** The PLANE_TEX rawAt over a cpuPlaneVolume. */
function planeRawAt(plane) {
  const dim = plane.dims;
  const k = plane.axis;
  const [U, V] = Ops.PLANE_AXES[k];
  const cu = Math.ceil(plane.width / plane.brickSize), cv = Math.ceil(plane.height / plane.brickSize);
  return (uvw) => {
    const vox = {};
    for (const a of ['x', 'y', 'z']) vox[a] = Math.floor(Math.min(Math.max(fmul(uvw[a], dim[a]), 0), dim[a] - 1));
    const layer = plane.reduced ? 0 : vox[k] - plane.layerBase;
    if (layer < 0 || layer >= plane.layers) return { present: false, v: [0, 0, 0, 0] };
    const bu = Math.floor(vox[U] / plane.brickSize), bv = Math.floor(vox[V] / plane.brickSize);
    if (!(plane.presence.presence[(layer * cv + bv) * cu + bu] > 127)) return { present: false, v: [0, 0, 0, 0] };
    const o = ((layer * plane.height + vox[V]) * plane.width + vox[U]) * 4;
    return { present: true, v: Array.from(plane.texture.tex.subarray(o, o + 4)) };
  };
}

/** A composed brick row as the loader delivers it (compose, cropToVolume). */
function composedRow(b, region) {
  const bw = Math.min(BS, DIMS.x - b.bx * BS), bh = Math.min(BS, DIMS.y - b.by * BS), bd = Math.min(BS, DIMS.z - b.bz * BS);
  const r = region || { x0: 0, x1: BS, y0: 0, y1: BS, z0: 0, z1: BS };
  const box = { x0: r.x0, x1: Math.min(r.x1, bw), y0: r.y0, y1: Math.min(r.y1, bh), z0: r.z0, z1: Math.min(r.z1, bd) };
  const full = box.x0 === 0 && box.y0 === 0 && box.z0 === 0 && box.x1 === BS && box.y1 === BS && box.z1 === BS;
  const rw = box.x1 - box.x0, rh = box.y1 - box.y0, rd = box.z1 - box.z0;
  const data = new Uint8Array(rw * rh * rd * 4);
  let o = 0;
  for (let z = box.z0; z < box.z1; z++) for (let y = box.y0; y < box.y1; y++) for (let x = box.x0; x < box.x1; x++) {
    for (let c = 0; c < 4; c++) data[o++] = voxel(b.bx * BS + x, b.by * BS + y, b.bz * BS + z, c);
  }
  return { bx: b.bx, by: b.by, bz: b.bz, data, region: full ? null : box, box };
}

// The page code under test: the plane backend and the atlas brick picker.
const page = new Function('VolumeSlicer', 'VolumeViewer', 'StudioPlaneOps', 'BrickLoader', 'THREE', `
  const _reducePlaneTile = (data, box, axis, keep) => Promise.resolve(StudioPlaneOps.reduceMax(data, box, axis, keep));
  ${lift(viewerSrc, '_planeNativeBackend')}
  ${lift(viewerSrc, '_nativeSliceBricksForSpec')}
  return { _planeNativeBackend, _nativeSliceBricksForSpec };
`)(
  { createPlaneVolume: cpuPlaneVolume, planeGeometry: VolumeSlicer.planeGeometry, samplingSpace: () => null },
  { getMaterial: () => ({ uniforms: { numChannels: { value: 4 } } }), getPhysicalSize: () => PHYSICAL },
  Ops,
  { activeBricks: () => ACTIVE },
  THREE
);

const geometryOf = (spec) => Ops.plainGeometry(VolumeSlicer.planeGeometry(spec, PHYSICAL, null));
const renderResFor = (spec) => {
  let maxDim = Math.max(DIMS.x, DIMS.y);
  if (spec.mode === 'xz') maxDim = Math.max(DIMS.x, DIMS.z);
  else if (spec.mode === 'yz') maxDim = Math.max(DIMS.y, DIMS.z);
  return Math.ceil(maxDim * 1.5);
};
// The volume itself, every voxel known: an ESS-dropped brick is zeros.
const truthRawAt = (uvw) => {
  const v = {};
  for (const k of ['x', 'y', 'z']) v[k] = Math.floor(Math.min(Math.max(fmul(uvw[k], DIMS[k]), 0), DIMS[k] - 1));
  const b = { bx: Math.floor(v.x / BS), by: Math.floor(v.y / BS), bz: Math.floor(v.z / BS) };
  if (EMPTY.has(keyOf(b))) return { present: true, v: [0, 0, 0, 0] };
  return { present: true, v: [0, 1, 2, 3].map(c => voxel(v.x, v.y, v.z, c)) };
};
// The preview raw standing in for a chunk that never arrived.
const fallbackOf = () => (x, y) => [x & 255, y & 255, 77, 200];

async function compare(label, spec, { failKey = null, expectPath = 'plane', expectLayers = null } = {}) {
  const g = geometryOf(spec);
  const R = renderResFor(spec);
  const rect = Ops.cropRect(g, R, null);
  assert.ok(rect, `${label}: the plane crosses the volume`);
  const win = { x: rect.x, y: rect.y, w: rect.x2 - rect.x + 1, h: rect.y2 - rect.y + 1 };
  const plan = Ops.planePlan(g, DIMS, ACTIVE, BS);
  if (expectPath !== 'plane') {
    assert.equal(plan, null, `${label}: the plane path refuses it (the atlas path renders it)`);
    return;
  }
  assert.ok(plan && !plan.empty, `${label}: a plane plan`);
  if (expectLayers) assert.deepEqual([...plan.voxels], expectLayers, `${label}: voxel planes along ${plan.axis}`);

  // Atlas path: the bricks the picker gives, each holding its region, one failing.
  const picked = page._nativeSliceBricksForSpec(spec, DIMS, 0);
  const held = new Map();
  for (const b of picked) {
    if (keyOf(b) === failKey) continue;
    held.set(keyOf(b), composedRow(b, b.region).box);
  }
  // Plane path: the backend fed the rows of the plan's bricks, the same one failing.
  const backend = page._planeNativeBackend(plan, DIMS, 4);
  let written = 0;
  for (const b of plan.bricks) {
    if (keyOf(b) === failKey) continue;
    const row = composedRow(b, b.region);
    written += Number(await backend.write(b, row.data, row.region)) || 0;
  }
  const fb = fallbackOf();
  outsideReads = 0;
  const atlas = renderRaw({ g, R, win, rawAt: atlasRawAt(held), fallback: fb });
  const plane = renderRaw({ g, R, win, rawAt: planeRawAt(backend.plane), reduced: plan.reduced, fallback: fb });
  let diff = 0, shown = 0;
  const sentinel = outsideReads;
  for (let i = 0; i < atlas.length; i += 4) {
    if (atlas[i] !== plane[i] || atlas[i + 1] !== plane[i + 1] || atlas[i + 2] !== plane[i + 2] || atlas[i + 3] !== plane[i + 3]) diff++;
    if (plane[i + 3] || plane[i]) shown++;
  }
  assert.equal(sentinel, 0, `${label}: the atlas path never read outside the box it was given`);
  assert.ok(shown > win.w * win.h * 0.2, `${label}: the picture is not empty (${shown} px)`);
  assert.equal(diff, 0, `${label}: plane path = atlas path (${diff} pixels differ of ${win.w * win.h})`);
  if (!failKey) {
    // Every brick in: the picture of the true volume (ESS-dropped bricks are zeros),
    // never the preview.
    const truth = renderRaw({ g, R, win, rawAt: truthRawAt, fallback: fb });
    let off = 0;
    for (let i = 0; i < truth.length; i++) if (truth[i] !== plane[i]) off++;
    assert.equal(off, 0, `${label}: the native picture is the true volume's (${off} bytes differ)`);
  }
  const missingBricks = plan.bricks.length - written;
  return { plan, missingBricks, win, R, g };
}

// ── Single planes ─────────────────────────────────────────────────────────────
{
  const r1 = await compare('XY 0.37', { mode: 'xy', value: 0.37, slabThickness: 1, projection: 'single' }, { failKey: '2_1_0', expectLayers: [15] });
  assert.equal(r1.plan.layers, 1);
  assert.equal(r1.missingBricks, 1, 'the brick that never arrived is counted missing');
  // c·dim = 0.5·41 = 20.5: floor 20, far from a face.
  await compare('XY 0.5', { mode: 'xy', value: 0.5, slabThickness: 1, projection: 'single' }, { expectLayers: [20] });
  // On a voxel face: value·41 = 16 exactly — both candidate planes, the shader takes its own.
  const face = await compare('XY on a voxel face', { mode: 'xy', value: 16 / 41, slabThickness: 1, projection: 'single' }, { expectLayers: [15, 16] });
  assert.equal(face.plan.layers, 2);
  assert.ok(face.plan.bricks.some(b => b.bz === 0) && face.plan.bricks.some(b => b.bz === 1), 'the two planes straddle a brick layer');
  await compare('XZ 0.62', { mode: 'xz', value: 0.62, slabThickness: 1, projection: 'single' }, { failKey: '0_2_1' });
  await compare('YZ 0.41', { mode: 'yz', value: 0.41, slabThickness: 1, projection: 'single' }, { failKey: '1_1_2' });
  await compare('YZ through an empty brick', { mode: 'yz', value: 0.2, slabThickness: 1, projection: 'single' });
  console.log('axis-aligned single planes (XY / XZ / YZ, voxel face, empty and missing bricks): OK');
}

// ── Z-stack MIP slabs ─────────────────────────────────────────────────────────
// The spec viewer.js _zstackStudioSpec builds: slices lo..hi, one sample per slice
// at the voxel centres, the plane at the slab centre (1 − c on the −Z face).
function zstackSpec(lo, hi, { back = false, roll = 0 } = {}) {
  const z = DIMS.z;
  const n = hi - lo + 1;
  const c = (lo + n / 2) / z;
  return {
    mode: 'oblique', axis: 'z', value: back ? 1 - c : c, yaw: back ? 180 : 0, pitch: 0, roll,
    slabThickness: n, slabStepNorm: 1 / z, projection: n > 1 ? 'mip' : 'single'
  };
}
{
  const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
  const all = await compare('z-stack, whole stack', zstackSpec(0, DIMS.z - 1), { expectLayers: range(0, DIMS.z - 1) });
  assert.equal(all.plan.reduced, true, 'a MIP slab is one reduced plane');
  assert.equal(all.plan.layers, 1);
  // A column with ESS-dropped bricks is the maximum of its other bricks, a column with
  // none left is zeros: fetched accordingly, and never the preview (compare(): truth).
  const col = (bx, by) => [...all.plan.bricks].filter(b => b.bx === bx && b.by === by).map(b => b.bz).sort();
  assert.deepEqual(col(1, 1), [0, 2], 'column (1,1): its two stored bricks');
  assert.deepEqual(col(0, 3), [1], 'column (0,3): its one stored brick');
  assert.deepEqual(col(4, 3), [], 'column (4,3): nothing to fetch');
  assert.equal(all.plan.columns.get('1_1').need, 2);
  assert.ok(!all.plan.columns.has('4_3'), 'an all-empty column awaits nothing');
  await compare('z-stack, slices 9..30, rolled 37°', zstackSpec(9, 30, { roll: 37 }), { failKey: '3_2_1', expectLayers: range(9, 30) });
  await compare('z-stack, −Z face, rolled 120°', zstackSpec(3, 22, { back: true, roll: 120 }), { expectLayers: range(3, 22) });
  await compare('z-stack, one slice', zstackSpec(17, 17, { roll: 15 }), { expectLayers: [17] });
  console.log('z-stack MIP slabs (+Z / −Z face, roll, missing brick, empty brick): OK');
}

// ── Refused by the plane path ─────────────────────────────────────────────────
{
  await compare('oblique', { mode: 'oblique', value: 0.5, yaw: 25, pitch: 15, roll: 0, slabThickness: 1, projection: 'single' }, { expectPath: 'atlas' });
  await compare('average slab', { mode: 'xy', value: 0.5, slabThickness: 5, slabStepNorm: 1 / DIMS.z, projection: 'average' }, { expectPath: 'atlas' });
  // A slab whose samples fall on voxel faces (spacing of exactly one voxel, from a face).
  await compare('MIP sample on a voxel face', { mode: 'xy', value: 20 / DIMS.z, slabThickness: 3, slabStepNorm: 1 / DIMS.z, projection: 'mip' }, { expectPath: 'atlas' });
  // The inspector's default slab spacing (1/256 of the longest axis): exact when no sample sits on a face.
  const insp = { mode: 'xy', value: 0.55, slabThickness: 7, projection: 'mip' };
  const plan = Ops.planePlan(geometryOf(insp), DIMS, ACTIVE, BS);
  if (plan) await compare('inspector MIP slab', insp, {});
  console.log('oblique / average / face-straddling slabs keep the atlas path: OK');
}

// ── Crop and footprint from the geometry ────────────────────────────────────────
{
  const cases = [
    { mode: 'xy', value: 0.37, slabThickness: 1, projection: 'single' },
    { mode: 'xz', value: 0.62, slabThickness: 1, projection: 'single' },
    { mode: 'oblique', value: 0.45, yaw: 30, pitch: 20, roll: 10, slabThickness: 1, projection: 'single' },
    zstackSpec(5, 25, { roll: 33 }),
    { mode: 'oblique', value: 0.5, yaw: 15, pitch: 35, roll: 0, slabThickness: 9, slabStepNorm: 0.02, projection: 'mip' }
  ];
  for (const spec of cases) {
    const g = geometryOf(spec);
    const R = renderResFor(spec) + 7;
    const rect = Ops.cropRect(g, R, null);
    // Every pixel whose plane point (or slab sample) lies in the box, by brute force.
    const all = { x: 0, y: 0, w: R, h: R };
    const inside = renderRaw({ g, R, win: all, rawAt: () => ({ present: true, v: [1, 1, 1, 1] }) });
    let minX = R, minY = R, maxX = -1, maxY = -1;
    for (let y = 0; y < R; y++) for (let x = 0; x < R; x++) {
      if (inside[(y * R + x) * 4 + 3]) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
    }
    assert.ok(maxX >= 0, `${spec.mode}: the plane shows something`);
    assert.ok(rect.x <= minX && rect.y <= minY && rect.x2 >= maxX && rect.y2 >= maxY, `${spec.mode}: the crop holds every pixel shown`);
    for (const [a, b] of [[minX - rect.x, 'left'], [minY - rect.y, 'top'], [rect.x2 - maxX, 'right'], [rect.y2 - maxY, 'bottom']]) {
      assert.ok(a <= 12, `${spec.mode}: ${b} margin ${a} ≤ the 10 px padding (+ rounding)`);
    }
    if (g.projected) {
      const win = { x: rect.x, y: rect.y, w: rect.x2 - rect.x + 1, h: rect.y2 - rect.y + 1 };
      const mask = Ops.coverageMask(g, R, win, null);
      let differ = 0;
      for (let i = 0; i < win.w * win.h; i++) {
        const hit = inside[((win.y + Math.floor(i / win.w)) * R + win.x + (i % win.w)) * 4 + 3] > 0;
        if ((mask[i] > 0) !== hit) differ++;
      }
      // float32 shader against float64 footprint: at most a pixel on the odd boundary.
      assert.ok(differ <= Math.ceil((win.w + win.h) * 0.01), `${spec.mode}: footprint = the shader's hits > 0 (${differ} boundary pixels)`);
    }
  }
  console.log('geometric crop and slab footprint: OK');
}

// ── The atlas picker's slack ────────────────────────────────────────────────────
{
  const pick = (spec) => page._nativeSliceBricksForSpec(spec, DIMS, 0);
  const at = (value) => pick({ mode: 'xy', value, slabThickness: 1, projection: 'single' });
  const zRange = (bricks) => {
    let lo = Infinity, hi = -Infinity;
    for (const b of bricks) { lo = Math.min(lo, b.bz * BS + b.region.z0); hi = Math.max(hi, b.bz * BS + b.region.z1 - 1); }
    return [lo, hi];
  };
  assert.deepEqual(zRange(at(20.5 / 41)), [20, 20], 'mid-voxel: the voxel alone');
  assert.deepEqual(zRange(at(16 / 41)), [15, 16], 'on a voxel face: the voxel and the one below');
  assert.ok(at(20.5 / 41).every(b => b.bz === 1), 'one brick layer, not two');
  console.log('_nativeSliceBricksForSpec slack only near a voxel face: OK');
}

console.log('Studio native plane path = atlas path: OK');
