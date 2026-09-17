// The Studio's native pass picks its LOD0 bricks in the very texture-space geometry
// the slicer samples:
//   • VolumeSlicer.planeGeometry: the physical anisotropy tilts an oblique plane's
//     texture-space normal (n_tex ∝ S⁻¹·n) while an axis-aligned plane keeps its own;
//     a slab of n samples spaced 1/z spans ±(n−1)/(2z) along that normal and lands on
//     the intended slices; a 'single' projection has no thickness;
//   • viewer.js _nativeSliceBricksForSpec (run from the page source): an axis-aligned
//     cut keeps the brick layer the shader reads — floor(value·dim), where the old
//     round(value·(dim−1)) picked the layer below at a brick boundary and rendered a
//     black slice — and asks for three voxel planes of each brick; a Z-stack slab asks
//     for its slices plus one each side; an oblique cut on an anisotropic volume keeps
//     every brick the tilted plane really crosses (the untilted normal misses some:
//     the black bands), as whole bricks.
//
// Run: node tests/js/test_native_slice_geometry.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT } from './harness.mjs';

const ctx = vm.createContext({ console, setTimeout, clearTimeout, window: {} });
vm.runInContext(readFileSync(path.join(ROOT, 'js/vendor/three.min.js'), 'utf8'), ctx, { filename: 'three.min.js' });
vm.runInContext(readFileSync(path.join(ROOT, 'js/viewers/volume-slicer.js'), 'utf8') + '\n;globalThis.__VS = VolumeSlicer;', ctx, { filename: 'volume-slicer.js' });
const VolumeSlicer = ctx.__VS;
const THREE = ctx.THREE;
// Objects made inside a vm realm carry that realm's prototypes: compare them as plain data.
const plain = (o) => (o == null ? o : JSON.parse(JSON.stringify(o)));
const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg || ''}: ${a} vs ${b}`);

// ── planeGeometry ──────────────────────────────────────────────────────────────
{
  // T1: an XY plane on an anisotropic volume — normal untouched, quad scaled by maxP/p.
  const g = VolumeSlicer.planeGeometry({ mode: 'xy', value: 0.3, slabThickness: 1, projection: 'single' }, { x: 100, y: 100, z: 300 });
  near(g.normal.x, 0, 1e-12, 'nx'); near(g.normal.y, 0, 1e-12, 'ny'); near(g.normal.z, 1, 1e-12, 'nz');
  near(g.center.z, 0.3, 1e-12, 'centre'); near(g.halfThickness, 0, 0, 'single plane has no thickness');
  near(g.right.x, 3, 1e-12, 'right scaled'); near(g.up.y, 3, 1e-12, 'up scaled'); near(g.step.z, 1, 1e-12, 'step');
  assert.equal(g.steps, 1); assert.equal(g.projMode, 0); assert.equal(g.projected, false);

  // T2: a Z-stack slab of 5 slices spaced 1/232 spans ±2/232 whatever the anisotropy,
  // and the shader's samples land on slices 100..104.
  const z = 232;
  const slab = VolumeSlicer.planeGeometry({ mode: 'xy', value: (100 + 5 / 2) / z, slabThickness: 5, slabStepNorm: 1 / z, projection: 'mip' }, { x: 1137, y: 1137, z: 696 });
  near(slab.halfThickness, 2 / z, 1e-12, 'slab half-thickness');
  assert.equal(slab.projected, true); assert.equal(slab.steps, 5); assert.equal(slab.projMode, 1);
  const halfSlab = (slab.steps - 1) * slab.delta * 0.5;
  for (let i = 0; i < 5; i++) {
    const zz = slab.center.z + (-halfSlab + i * slab.delta) * slab.step.z;
    assert.equal(Math.floor(zz * z), 100 + i, `sample ${i} lands on slice ${100 + i}`);
  }

  // T3: 'single' ignores the slab thickness (the shader samples one plane then).
  const single = VolumeSlicer.planeGeometry({ mode: 'xy', value: 0.5, slabThickness: 9, projection: 'single' }, { x: 1, y: 1, z: 1 });
  near(single.halfThickness, 0, 0, 'single + thickness'); assert.equal(single.projected, false);

  // T4: an oblique plane — the texture normal is perpendicular to the sampled quad, and
  // it differs from the physical normal as soon as the voxels are anisotropic.
  const spec = { mode: 'oblique', value: 0.5, yaw: 30, pitch: 20, roll: 0, slabThickness: 1, projection: 'single' };
  const aniso = VolumeSlicer.planeGeometry(spec, { x: 1137, y: 1137, z: 696 });
  near(aniso.normal.dot(aniso.right), 0, 1e-9, 'normal ⟂ right');
  near(aniso.normal.dot(aniso.up), 0, 1e-9, 'normal ⟂ up');
  near(aniso.normal.length(), 1, 1e-9, 'unit normal');
  const iso = VolumeSlicer.planeGeometry(spec, { x: 1, y: 1, z: 1 });
  near(iso.normal.dot(iso.step.clone().normalize()), 1, 1e-9, 'isotropic: the step runs along the normal');
  assert.ok(1 - aniso.normal.dot(iso.normal) > 0.01, 'anisotropy tilts the texture-space normal');

  // T5: no usable physical size counts as isotropic (EDGE-035: zero / negative / null axes).
  const bare = VolumeSlicer.planeGeometry({ mode: 'xz', value: 0.25 }, { x: 0, y: -3, z: null });
  near(bare.normal.y, 1, 1e-12, 'xz normal'); near(bare.center.y, 0.25, 1e-12, 'xz centre');
  near(bare.right.x, 1, 1e-12, 'unscaled right'); near(bare.up.z, 1, 1e-12, 'unscaled up');
  assert.ok(Number.isFinite(bare.delta));
  console.log('VolumeSlicer.planeGeometry: OK');
}

// ── _nativeSliceBricksForSpec, run from the viewer source ──────────────────────
const viewerSrc = readFileSync(path.join(ROOT, 'js/pages/viewer.js'), 'utf8');
const fnStart = viewerSrc.indexOf('  function _nativeSliceBricksForSpec(');
const fnEnd = viewerSrc.indexOf('\n  function _nativeStudioRenderSize(', fnStart);
assert.ok(fnStart > 0 && fnEnd > fnStart, '_nativeSliceBricksForSpec found in viewer.js');
const fnSrc = viewerSrc.slice(fnStart, fnEnd);
assert.ok(!/bricksForSlab|bricksForRegion|_slabStepNorm|_brickIntersectsSlicePlane/.test(fnSrc), 'the old brick picker is gone');

function allBricks(dims, bs = 64) {
  const out = [];
  for (let bz = 0; bz < Math.ceil(dims.z / bs); bz++)
    for (let by = 0; by < Math.ceil(dims.y / bs); by++)
      for (let bx = 0; bx < Math.ceil(dims.x / bs); bx++) out.push({ bx, by, bz });
  return out;
}
function selector(physical, bricks) {
  const c = vm.createContext({ console, THREE, VolumeSlicer, BrickLoader: { activeBricks: () => bricks }, VolumeViewer: { getPhysicalSize: () => physical } });
  vm.runInContext(fnSrc + '\n;globalThis.__fn = _nativeSliceBricksForSpec;', c, { filename: 'viewer.js#_nativeSliceBricksForSpec' });
  return c.__fn;
}
const key = (b) => `${b.bx}_${b.by}_${b.bz}`;

{
  const dims = { x: 2048, y: 2048, z: 100, brickSize: 64, channels: 1 };
  const pick = selector({ x: 614, y: 614, z: 300 }, allBricks(dims));

  // T6: an XY cut at 0.64 of a 100-deep volume: the shader reads voxel 64 (brick layer
  // 1). The old picker took round(0.64 × 99) = 63 (layer 0) and the slice rendered black.
  const cut = pick({ mode: 'xy', value: 0.64, slabThickness: 1, projection: 'single' }, dims);
  const layer1 = cut.filter((b) => b.bz === 1);
  assert.equal(layer1.length, 32 * 32, 'every brick of the layer the shader reads');
  for (const b of layer1) assert.deepEqual(plain(b.region), { x0: 0, x1: 64, y0: 0, y1: 64, z0: 0, z1: 2 }, 'voxel 64 plus one of slack above');
  for (const b of cut.filter((b) => b.bz === 0)) assert.deepEqual(plain(b.region), { x0: 0, x1: 64, y0: 0, y1: 64, z0: 63, z1: 64 }, 'one plane of slack below');

  // T7: mid-depth, a single layer and three planes of it.
  const mid = pick({ mode: 'xy', value: 0.5, slabThickness: 1, projection: 'single' }, dims);
  assert.equal(mid.length, 32 * 32, 'one layer');
  for (const b of mid) { assert.equal(b.bz, 0); assert.deepEqual(plain(b.region), { x0: 0, x1: 64, y0: 0, y1: 64, z0: 49, z1: 52 }); }

  // T8: an XZ cut at 0.75 of a 2048-wide volume reads voxel row 1536 = brick row 24;
  // the old picker (round(0.75 × 2047) = 1535) stopped at row 23.
  const xz = pick({ mode: 'xz', value: 0.75, slabThickness: 1, projection: 'single' }, dims);
  const row24 = xz.filter((b) => b.by === 24);
  assert.equal(row24.length, 32 * 2, 'the brick row the shader reads, at every x and z');
  for (const b of row24) assert.deepEqual(plain(b.region), { x0: 0, x1: 64, y0: 0, y1: 2, z0: 0, z1: b.bz === 1 ? 36 : 64 }, 'row 1536 plus one of slack, whole x/z extent, partial last z layer');
  assert.ok(xz.every((b) => b.by === 23 || b.by === 24), 'nothing beyond the row and its slack');
  assert.ok(xz.filter((b) => b.by === 23).every((b) => b.region.y0 === 63 && b.region.y1 === 64), 'one row of slack below');

  // T9: a Z-stack slab of slices 60..64 asks for those plus one plane each side.
  const z = dims.z;
  const slab = pick({ mode: 'xy', value: (60 + 5 / 2) / z, slabThickness: 5, slabStepNorm: 1 / z, projection: 'mip' }, dims);
  assert.equal(slab.length, 2 * 32 * 32, 'both layers: the slab straddles the brick boundary at 64');
  for (const b of slab) {
    if (b.bz === 0) assert.deepEqual(plain(b.region), { x0: 0, x1: 64, y0: 0, y1: 64, z0: 59, z1: 64 }, 'slices 59..63 of layer 0');
    else assert.deepEqual(plain(b.region), { x0: 0, x1: 64, y0: 0, y1: 64, z0: 0, z1: 2 }, 'slices 64..65 of layer 1');
  }

  // T10: an empty plane spec still selects the middle plane, and an empty brick set gives nothing.
  assert.equal(pick({}, dims).length, 32 * 32, 'defaults to value 0.5, xy');
  assert.equal(selector(null, [])({ mode: 'xy', value: 0.5 }, dims).length, 0, 'no active bricks -> nothing');
  console.log('_nativeSliceBricksForSpec, axis-aligned: OK');
}

{
  // T11: an oblique cut on an anisotropic volume. Sample the quad exactly as the shader
  // does and collect the bricks the samples fall in: every one of them must be picked.
  const dims = { x: 3789, y: 3789, z: 232, brickSize: 64, channels: 4 };
  const physical = { x: 1137, y: 1137, z: 696 };
  const pick = selector(physical, allBricks(dims));
  const spec = { mode: 'oblique', value: 0.5, yaw: 30, pitch: 20, roll: 0, slabThickness: 1, projection: 'single' };
  const picked = new Set(pick(spec, dims).map(key));
  assert.ok(picked.size > 0);
  for (const b of pick(spec, dims)) assert.equal(b.region, null, 'an oblique cut takes whole bricks');

  const g = VolumeSlicer.planeGeometry(spec, physical);
  const extent = VolumeSlicer.getPlaneExtentUnits ? VolumeSlicer.getPlaneExtentUnits() / 2 : 0.75;
  const sampled = new Set();
  const step = 0.004;
  for (let py = -extent; py <= extent; py += step) {
    for (let px = -extent; px <= extent; px += step) {
      const u = g.center.x + px * g.right.x + py * g.up.x;
      const v = g.center.y + px * g.right.y + py * g.up.y;
      const w = g.center.z + px * g.right.z + py * g.up.z;
      if (u < 0 || u > 1 || v < 0 || v > 1 || w < 0 || w > 1) continue;
      const vx = Math.min(dims.x - 1, Math.floor(u * dims.x));
      const vy = Math.min(dims.y - 1, Math.floor(v * dims.y));
      const vz = Math.min(dims.z - 1, Math.floor(w * dims.z));
      sampled.add(`${Math.floor(vx / 64)}_${Math.floor(vy / 64)}_${Math.floor(vz / 64)}`);
    }
  }
  assert.ok(sampled.size > 100, `the quad crosses many bricks (${sampled.size})`);
  const missed = [...sampled].filter((k) => !picked.has(k));
  assert.deepEqual(missed, [], 'every brick the shader samples is loaded');

  // The untilted test (the plane's physical normal, as before) misses some of them —
  // those were the black bands.
  const iso = VolumeSlicer.planeGeometry(spec, { x: 1, y: 1, z: 1 });
  const missedBefore = [...sampled].filter((k) => {
    const [bx, by, bz] = k.split('_').map(Number);
    const min = new THREE.Vector3(bx * 64 / dims.x, by * 64 / dims.y, bz * 64 / dims.z);
    const max = new THREE.Vector3(Math.min(dims.x, (bx + 1) * 64) / dims.x, Math.min(dims.y, (by + 1) * 64) / dims.y, Math.min(dims.z, (bz + 1) * 64) / dims.z);
    const centre = min.clone().add(max).multiplyScalar(0.5);
    const half = max.clone().sub(min).multiplyScalar(0.5);
    const n = iso.normal;
    const dist = Math.abs(n.dot(centre.sub(g.center)));
    const radius = Math.abs(n.x) * half.x + Math.abs(n.y) * half.y + Math.abs(n.z) * half.z;
    return dist > radius + 2 / 232;
  });
  assert.ok(missedBefore.length > 0, `the untilted normal misses bricks the plane crosses (${missedBefore.length})`);
  console.log(`_nativeSliceBricksForSpec, oblique: OK (${sampled.size} bricks crossed, ${missedBefore.length} missed by the old test)`);
}

console.log('native slice geometry: OK');
