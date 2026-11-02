// View-dependent residency (js/core/view-residency.js). The four defects of the former
// zoom-detail ROI are requirements here, each with its test:
//   1. it located the looked-at zone badly   → the planned set contains every brick a ray
//      of the real projection crosses, and (almost) none outside the view;
//   2. it loaded more voxels than pixels     → no brick is finer than the screen needs
//      (coarsest enough level), at every zoom, with a counter of voxels per pixel;
//   3. it downloaded the zone again          → nothing is asked twice while held or
//      pending; a zoom out-and-in re-asks nothing when the slots hold both views;
//   4. it fetched finer levels than chosen   → with a ceiling (512 chosen) no brick of a
//      finer level is ever planned or requested, at any zoom.
// Plus: no hole while finer bricks are pending, hysteresis against flapping, the slot
// budget of a 5735² dataset.
//
// Run: node tests/js/test_view_residency.mjs
import assert from 'node:assert/strict';
import { loadModule } from './harness.mjs';

const VR = loadModule('js/core/view-residency.js', 'ViewResidency', { self: {} });

// ── 4×4 matrices, column-major like THREE.Matrix4.elements ──────────────────────
const mul = (a, b) => { const o = new Array(16).fill(0); for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k]; return o; };
const translate = (x, y, z) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
const scale = (x, y, z) => [x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0, 0, 0, 0, 1];
const rotY = (a) => { const c = Math.cos(a), s = Math.sin(a); return [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1]; };
const perspective = (fovY, aspect, near, far) => { const f = 1 / Math.tan(fovY / 2); const nf = 1 / (near - far); return [f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0]; };

const FOV = 45 * Math.PI / 180, W = 1280, H = 793;

function makeView({ world, distance, zoom = 1, yaw = 0, pan = [0, 0], clip = null }) {
  const proj = perspective(FOV, W / H, 0.1, 100);
  // The camera sits `distance / zoom` from the volume's centre (a dolly zoom).
  const view = mul(translate(pan[0], pan[1], -distance / zoom), rotY(yaw));
  const texToObj = mul(scale(world.x, world.y, world.z), mul(translate(-0.5, -0.5, -0.5), scale(1, 1, 1)));
  // object = (tex − ½) · world
  const toObj = mul(translate(0, 0, 0), mul(scale(world.x, world.y, world.z), translate(-0.5, -0.5, -0.5)));
  const texToView = mul(view, toObj);
  return { texToClip: mul(proj, texToView), texToView, volumeWorld: world, fovY: FOV, viewportHeight: H, clip, view, proj, toObj };
}

// A volume like F6TEST-E85: 1946² × 72 voxels of 1.277 × 1.277 × 5.536 µm.
function f6(has = () => true) {
  const dims = [1946, 1024, 512, 256].map((x) => ({ x, y: x, z: 72 }));
  return { levels: VR.makeLevels(dims, has), world: { x: 1, y: 1, z: 72 * 5.536 / (1946 * 1.277) }, dims };
}
// A 5735² × 200 dataset, levels at 256·2^k below native.
function e95(has = () => true) {
  const dims = [5735, 4096, 2048, 1024, 512, 256].map((x) => ({ x, y: x, z: 200 }));
  return { levels: VR.makeLevels(dims, has), world: { x: 1, y: 1, z: 200 * 2.2 / (5735 * 0.9) }, dims };
}

const boxCorners = (bb, m) => { const cs = []; for (let i = 0; i < 8; i++) { const p = [i & 1 ? bb.hi[0] : bb.lo[0], i & 2 ? bb.hi[1] : bb.lo[1], i & 4 ? bb.hi[2] : bb.lo[2]]; cs.push([0, 1, 2, 3].map((r) => +(m[r] * p[0] + m[4 + r] * p[1] + m[8 + r] * p[2] + m[12 + r]).toFixed(2))); } return cs; };
const covers = (lvl, b, pt) => {
  const box = VR.brickBox(lvl, b.bx, b.by, b.bz);
  return [0, 1, 2].every((k) => pt[k] >= box.lo[k] - 1e-9 && pt[k] <= box.hi[k] + 1e-9);
};

// The bricks a ray of the real projection crosses: a dense march of every 8th pixel in
// both directions through the volume's box in texture space, recorded at `lod`.
function referenceBricks(v, lvl, lod, stepsPerBrick = 4) {
  const hit = new Set();
  const inv = (m) => { // inverse of an affine·projective matrix via cofactors is overkill: use unprojection by two points
    return null;
  };
  void inv;
  const W2 = v.volumeWorld;
  const lo = [-W2.x / 2, -W2.y / 2, -W2.z / 2], hi = [W2.x / 2, W2.y / 2, W2.z / 2];
  const viewInv = invertAffine(v.view);
  const aspect = W / H, t = Math.tan(FOV / 2);
  for (let py = 4; py < H; py += 8) {
    for (let px = 4; px < W; px += 8) {
      const ndc = [(px / W) * 2 - 1, 1 - (py / H) * 2];
      const dirV = [ndc[0] * t * aspect, ndc[1] * t, -1];
      const o = applyAff(viewInv, [0, 0, 0]);
      const d = sub(applyAff(viewInv, dirV), o);
      let t0 = -Infinity, t1 = Infinity;
      for (let k = 0; k < 3; k++) {
        if (Math.abs(d[k]) < 1e-12) { if (o[k] < lo[k] || o[k] > hi[k]) { t0 = Infinity; } continue; }
        const a = (lo[k] - o[k]) / d[k], b = (hi[k] - o[k]) / d[k];
        t0 = Math.max(t0, Math.min(a, b)); t1 = Math.min(t1, Math.max(a, b));
      }
      if (!(t0 < t1)) continue;
      t0 = Math.max(t0, 0.1);   // the camera's near plane: depth along the view axis is the ray parameter here
      const len = Math.hypot(d[0], d[1], d[2]);
      const step = Math.min(lvl.dims.x ? W2.x / lvl.dims.x : 1, 1e9) * 64 / stepsPerBrick / len;
      for (let s = t0; s <= t1; s += step) {
        const p = [o[0] + s * d[0], o[1] + s * d[1], o[2] + s * d[2]];
        const tex = [p[0] / W2.x + 0.5, p[1] / W2.y + 0.5, p[2] / W2.z + 0.5];
        if (tex.some((x) => x < 0 || x >= 1)) continue;
        hit.add(VR.key(lod, Math.floor(tex[0] * lvl.dims.x / 64), Math.floor(tex[1] * lvl.dims.y / 64), Math.floor(tex[2] * lvl.dims.z / 64)));
      }
    }
  }
  return hit;
}
function invertAffine(m) {
  // view = T · R (column-major): inverse = Rᵀ with translation −Rᵀ·t.
  const t = [m[12], m[13], m[14]];
  const nt = [-(m[0] * t[0] + m[1] * t[1] + m[2] * t[2]), -(m[4] * t[0] + m[5] * t[1] + m[6] * t[2]), -(m[8] * t[0] + m[9] * t[1] + m[10] * t[2])];
  return [m[0], m[4], m[8], 0, m[1], m[5], m[9], 0, m[2], m[6], m[10], 0, nt[0], nt[1], nt[2], 1];
}
const applyAff = (m, p) => [m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12], m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13], m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

function runPlan(ds, v, { ceilingLod = 0, baseLod = ds.levels.length - 1, vpp = 1.5, shownAt } = {}) {
  return VR.plan({ levels: ds.levels, ceilingLod, baseLod, ...v, voxelsPerPixel: vpp, shownAt });
}

// ── 1. the planned set is the visible set ───────────────────────────────────────
{
  const ds = f6();
  const D = 2.4;
  for (const [zoom, yaw, pan] of [[1, 0, [0, 0]], [3, 0.4, [0.05, -0.03]], [6, 0.9, [0.1, 0.02]], [1.5, 1.5, [0, 0]]]) {
    const v = makeView({ world: ds.world, distance: D, zoom, yaw, pan });
    const { bricks } = runPlan(ds, v);
    // Every sample point of a ray lies in a planned brick of ANY level (the level shown there).
    const planned = bricks.map((b) => ({ ...b, lvl: ds.levels[b.lod] }));
    const fine = referenceBricks(v, ds.levels[0], 0, 3);
    let missing = 0;
    for (const k of fine) {
      const [lod, bx, by, bz] = k.split(':').map(Number);
      const lvl = ds.levels[0];
      const bb = VR.brickBox(lvl, bx, by, bz);
      const centre = [0, 1, 2].map((i) => (bb.lo[i] + bb.hi[i]) / 2);
      if (!planned.some((b) => covers(b.lvl, b, centre))) { missing++; if (process.env.DBG && missing < 2) console.log('NEAR', JSON.stringify(planned.filter((b) => { const bb2 = VR.brickBox(b.lvl, b.bx, b.by, b.bz); return bb2.lo[0] < 0.1 && bb2.hi[1] > 0.8 && bb2.hi[2] > 0.8; }).map((b) => [b.lod, b.bx, b.by, b.bz]))), console.log('missing', k, centre.map((x) => x.toFixed(3)), 'clip', JSON.stringify(boxCorners(VR.brickBox(lvl, bx, by, bz), v.texToClip))); }
    }
    assert.equal(missing, 0, `zoom ${zoom} yaw ${yaw}: ${missing} of ${fine.size} crossed bricks have no planned brick over them`);
    // And what is planned is on screen: at most 12 % of the planned bricks are crossed by no ray.
    const crossedAtAnyLevel = (b) => {
      const lvl = ds.levels[b.lod];
      const box = VR.brickBox(lvl, b.bx, b.by, b.bz);
      for (const k of fine) {
        const [, x, y, z] = k.split(':').map(Number);
        const fb = VR.brickBox(ds.levels[0], x, y, z);
        const c = [0, 1, 2].map((i) => (fb.lo[i] + fb.hi[i]) / 2);
        if ([0, 1, 2].every((i) => c[i] >= box.lo[i] && c[i] <= box.hi[i])) return true;
      }
      return false;
    };
    const extra = planned.filter((b) => !crossedAtAnyLevel(b)).length;
    assert.ok(extra <= Math.max(2, planned.length * 0.12), `zoom ${zoom}: ${extra} of ${planned.length} planned bricks are outside every ray`);
    const nativeBricks = ds.levels[0].nx * ds.levels[0].ny * ds.levels[0].nz;
    if (process.env.DBG) console.log('zoom', zoom, 'yaw', yaw, 'planned', planned.length, 'of native', nativeBricks);
    if (zoom >= 6) assert.ok(planned.length < nativeBricks * 0.6, `a deep zoom plans a fraction of the volume (${planned.length} of ${nativeBricks})`);
  }
  console.log('1. planned set = bricks the rays cross: OK');
}

// ── 2. never finer than the screen can show ─────────────────────────────────────
{
  const ds = f6();
  const vpp = 1.5;
  const lines = [];
  for (const zoom of [0.6, 1, 2, 4, 8, 16, 32]) {
    const v = makeView({ world: ds.world, distance: 2.4, zoom });
    const { bricks, stats } = runPlan(ds, v, { vpp });
    let worst = 0;
    for (const b of bricks) {
      const lvl = ds.levels[b.lod];
      const fp = (2 * b.depth * Math.tan(FOV / 2)) / H;
      const vox = Math.max(v.volumeWorld.x / lvl.dims.x, v.volumeWorld.y / lvl.dims.y);
      worst = Math.max(worst, fp / vox);   // voxels per pixel along an axis
      if (b.lod > 0) {
        // not the finest: it is enough here (≥ vpp voxels per pixel) ...
        assert.ok(fp / vox >= vpp - 1e-9, `lod ${b.lod} at zoom ${zoom}: ${fp / vox} voxels/pixel < ${vpp}`);
      }
      if (b.lod < 3) {
        // ... and the next coarser level is NOT enough (otherwise it would have been chosen)
        const up = ds.levels[b.lod + 1];
        const voxUp = Math.max(v.volumeWorld.x / up.dims.x, v.volumeWorld.y / up.dims.y);
        // the brick was reached because its parent was too coarse at the PARENT's centre depth
        assert.ok(fp / voxUp < vpp * 1.6 || b.lod === 0, `lod ${b.lod}: a coarser level would have done (${fp / voxUp} voxels/pixel)`);
      }
    }
    const voxels = bricks.length * 64 ** 3;
    lines.push(`zoom ${String(zoom).padStart(4)}: ${String(bricks.length).padStart(4)} bricks ${JSON.stringify(stats.byLod)} ${(voxels / (W * H)).toFixed(1)} resident voxels per pixel, ≤ ${worst.toFixed(2)} voxels/pixel/axis`);
  }
  console.log('2. never finer than needed (counter):\n   ' + lines.join('\n   '));
}

// ── 4. the ceiling is absolute ──────────────────────────────────────────────────
{
  const ds = f6();
  for (const ceiling of [1, 2, 3]) {
    for (const zoom of [1, 2, 4, 8, 16, 64]) {
      const v = makeView({ world: ds.world, distance: 2.4, zoom });
      const { bricks } = runPlan(ds, v, { ceilingLod: ceiling });
      for (const b of bricks) assert.ok(b.lod >= ceiling, `ceiling ${ceiling}: planned lod ${b.lod} at zoom ${zoom}`);
    }
  }
  // At a deep zoom the ceiling level IS reached (nothing is lost below the chosen quality).
  const deep = runPlan(ds, makeView({ world: ds.world, distance: 2.4, zoom: 64 }), { ceilingLod: 2 });
  assert.ok(deep.bricks.every((b) => b.lod === 2), 'deep zoom stops at the chosen level');
  console.log('4. ceiling is absolute (512 chosen ⇒ never 1024 or native): OK');
}

// ── scheduler: no duplicate request, ceiling at the network, no hole ───────────
function simulate(ds, { ceilingLod, slots, views, arrivalsPerStep = 4, byteCacheHoldsAll = true }) {
  const asked = [];
  const queue = [];
  const sched = new VR.Scheduler({
    levels: ds.levels, baseLod: ds.levels.length - 1, ceilingLod, maxSlots: slots,
    request: (list) => { for (const b of list) { asked.push(b); queue.push(b); } },
    evict: () => {}
  });
  const holes = [];
  sched.seedBase();
  while (queue.length) sched.arrived(queue.shift());
  for (const v of views) {
    sched.update(v);
    // bricks land a few at a time: between two updates the view is partly loaded
    for (let i = 0; i < arrivalsPerStep && queue.length; i++) sched.arrived(queue.shift());
    // invariant: every point of the volume is under a resident brick (the base level never leaves)
    for (const pt of [[0.1, 0.1, 0.5], [0.5, 0.5, 0.5], [0.9, 0.2, 0.1], [0.3, 0.8, 0.9]]) {
      if (sched._shownAt(pt) === undefined) holes.push(pt);
    }
    while (queue.length) sched.arrived(queue.shift());
  }
  return { sched, asked, holes };
}

{
  const ds = f6();
  const zoomPath = [1, 2, 4, 1, 2, 4, 1, 4, 1];
  const views = zoomPath.map((zoom) => makeView({ world: ds.world, distance: 2.4, zoom }));

  // 3. a generous slot budget: the out-and-in zoom asks nothing it already holds
  const big = simulate(ds, { ceilingLod: 0, slots: 4000, views });
  const keys = big.asked.map((b) => VR.key(b.lod, b.bx, b.by, b.bz));
  assert.equal(new Set(keys).size, keys.length, 'no brick is requested twice while the slots hold both views');
  assert.equal(big.sched.stats().duplicateWhileHeld, 0);
  assert.deepEqual(big.holes, [], 'never a hole, also while finer bricks are in flight');

  // tight budget: evictions happen, and a brick is asked again only after it was evicted
  const tight = simulate(ds, { ceilingLod: 0, slots: 700, views });
  const seen = new Map();
  for (const b of tight.asked) { const k = VR.key(b.lod, b.bx, b.by, b.bz); seen.set(k, (seen.get(k) || 0) + 1); }
  const repeats = [...seen.values()].reduce((a, n) => a + (n - 1), 0);
  assert.equal(tight.sched.stats().rerequestsAfterEvict, repeats, 'every repeat follows an eviction');
  assert.ok(tight.sched.resident.size <= 700, 'the slot budget holds');
  assert.deepEqual(tight.holes, [], 'no hole under a tight budget either');
  assert.ok(tight.sched.stats().evictions > 0);

  // 4 at the network: with 512 chosen nothing finer is ever asked, at any zoom
  const capped = simulate(ds, { ceilingLod: 2, slots: 4000, views: [1, 4, 16, 64, 4, 1].map((zoom) => makeView({ world: ds.world, distance: 2.4, zoom })) });
  assert.ok(capped.asked.every((b) => b.lod >= 2), 'no request to level 1024 or native with 512 chosen');
  const capped1024 = simulate(ds, { ceilingLod: 1, slots: 4000, views: [1, 16, 64].map((zoom) => makeView({ world: ds.world, distance: 2.4, zoom })) });
  assert.ok(capped1024.asked.every((b) => b.lod >= 1), 'no request to the native level with 1024 chosen');
  console.log(`3/4. scheduler: no duplicate (${keys.length} requests over ${zoomPath.length} views), ${repeats} repeats after eviction under a 700-slot budget, no hole, ceiling respected at the network: OK`);
}

// ── hysteresis: a zoom hovering on a boundary does not flip bricks back and forth ─
{
  const ds = f6();
  const probes = [[0.5, 0.5, 0.5], [0.3, 0.6, 0.4], [0.7, 0.4, 0.6]];
  const levelAt = (bricks, pt) => {
    const hits = bricks.filter((b) => covers(ds.levels[b.lod], b, pt)).map((b) => b.lod);
    return hits.length ? Math.min(...hits) : undefined;
  };
  const indexShown = (bricks) => {
    const set = new Set(bricks.map((b) => VR.key(b.lod, b.bx, b.by, b.bz)));
    return (pt) => {
      for (let lod = 0; lod < ds.levels.length; lod++) {
        const L = ds.levels[lod];
        if (set.has(VR.key(lod, Math.min(L.nx - 1, Math.floor(pt[0] * L.dims.x / 64)), Math.min(L.ny - 1, Math.floor(pt[1] * L.dims.y / 64)), Math.min(L.nz - 1, Math.floor(pt[2] * L.dims.z / 64))))) return lod;
      }
      return undefined;
    };
  };
  const probeLevel = (zoom) => levelAt(runPlan(ds, makeView({ world: ds.world, distance: 2.4, zoom })).bricks, probes[0]);
  let lo = 1, hi = 3;                       // level 1 at lo, level 0 at hi: bisect the boundary
  assert.ok(probeLevel(lo) > probeLevel(hi), 'the probe goes finer between zoom 1 and 3');
  for (let i = 0; i < 30; i++) { const mid = (lo + hi) / 2; if (probeLevel(mid) > probeLevel(hi)) lo = mid; else hi = mid; }
  const boundary = (lo + hi) / 2;
  function flipsByPlan(hysteresis) {
    let prev = [];
    let count = 0;
    const last = new Map();
    for (let i = 0; i < 60; i++) {
      const zoom = boundary * (1 + 0.03 * Math.sin(i * 1.3));
      const { bricks } = VR.plan({ levels: ds.levels, ceilingLod: 0, baseLod: 3, ...makeView({ world: ds.world, distance: 2.4, zoom }), voxelsPerPixel: 1.5, hysteresis,
        shownAt: indexShown(prev) });
      for (const pt of probes) {
        const lod = levelAt(bricks, pt);
        const k = pt.join(',');
        if (last.has(k) && last.get(k) !== lod) count++;
        last.set(k, lod);
      }
      prev = bricks;
    }
    return count;
  }
  const without = flipsByPlan(1.0);      // factor 1 = no margin
  const withH = flipsByPlan(VR.HYSTERESIS);
  assert.ok(withH < without, `hysteresis must cut the flips (${withH} vs ${without} without)`);
  assert.ok(withH <= 3, `with hysteresis the probes change level ${withH} times`);
  console.log(`hysteresis: probes change level ${withH} times over 60 views hovering on a boundary (${without} without): OK`);
}

// ── the 5735² dataset: resident bricks against the whole native level ───────────
{
  const ds = e95();
  const slotBytes = 68 ** 3 * 1.5;   // BC5 + BC4, 3 channels, slot pitch 68
  const full = ds.levels[0].nx * ds.levels[0].ny * ds.levels[0].nz;
  const lines = [];
  for (const zoom of [1, 2, 4, 8]) {
    const v = makeView({ world: ds.world, distance: 2.4, zoom });
    const { bricks } = runPlan(ds, v, { ceilingLod: 0 });
    const base = ds.levels[5].nx * ds.levels[5].ny * ds.levels[5].nz;
    lines.push(`zoom ×${zoom}: ${bricks.length} bricks (+${base} base) = ${((bricks.length + base) * slotBytes / 2 ** 30).toFixed(2)} GiB BC, the whole native level is ${(full * slotBytes / 2 ** 30).toFixed(2)} GiB`);
    if (zoom === 1) assert.ok((bricks.length + base) * slotBytes < 1.4 * 2 ** 30, 'a native-quality 5735² view fits about 1 GiB');
  }
  console.log('5735² x 3 channels, native chosen:\n   ' + lines.join('\n   '));
}

console.log('view residency: OK');
