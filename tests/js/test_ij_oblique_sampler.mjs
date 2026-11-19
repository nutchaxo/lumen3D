// IJOblique (ij-proc-lib.js): the brick-by-brick accumulation of an oblique cut equals the direct
// evaluation of every (px, py, s) of the slicer's mapping, whatever the brick sizes, the delivery order,
// the projection; ESS bricks (never delivered) are zero voxels and bias nothing; failed bricks are `missing`.
//
// Run: node tests/js/test_ij_oblique_sampler.mjs
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FILE = 'js/modules/studio/advanced-studio/ij-proc-lib.js';
vm.runInThisContext(readFileSync(path.join(ROOT, FILE), 'utf8'), { filename: FILE });
const { IJOblique } = globalThis;

let passed = 0;
function test(name, fn) { fn(); passed++; }

function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

const DIMS = { x: 61, y: 47, z: 33 };
const value = (x, y, z) => ((x * 7 + y * 13 + z * 29 + ((x ^ y) * 3)) % 250) + 1;

// A plane through the volume in texture space: a / b one pixel along the frame, c one slab sample.
function makeG(rand, { width = 40, height = 30, steps = 1, projMode = null, dims = DIMS } = {}) {
  const yaw = rand() * 360, pitch = (rand() - 0.5) * 140, roll = rand() * 360;
  const rad = Math.PI / 180;
  const rz = (v, t) => [v[0] * Math.cos(t) - v[1] * Math.sin(t), v[0] * Math.sin(t) + v[1] * Math.cos(t), v[2]];
  const rx = (v, t) => [v[0], v[1] * Math.cos(t) - v[2] * Math.sin(t), v[1] * Math.sin(t) + v[2] * Math.cos(t)];
  const turn = (v) => rz(rx(rz(v, yaw * rad), pitch * rad), roll * rad);
  const r = turn([1, 0, 0]), u = turn([0, 1, 0]), n = turn([0, 0, 1]);
  const dl = [dims.x, dims.y, dims.z];
  const px = 0.9 + rand() * 0.6;                       // voxels per output pixel
  const a = r.map((v, k) => (v * px) / dl[k]);
  const b = u.map((v, k) => (-v * px) / dl[k]);
  const c = n.map((v, k) => (v * (0.8 + rand() * 0.8)) / dl[k]);
  const ctr = [0.3 + rand() * 0.4, 0.3 + rand() * 0.4, 0.3 + rand() * 0.4];
  const o = ctr.map((v, k) => v - (width / 2) * a[k] - (height / 2) * b[k]);
  return { dims, width, height, o, a, b, c, steps, projected: steps > 1 && !!projMode, projMode };
}

// Bricks: boxes of the given size tiling the volume, minus the ones an "ESS" set drops.
function tile(dims, [bx, by, bz]) {
  const out = [];
  for (let z = 0; z < dims.z; z += bz) for (let y = 0; y < dims.y; y += by) for (let x = 0; x < dims.x; x += bx) {
    out.push({ x0: x, y0: y, z0: z, x1: Math.min(dims.x, x + bx), y1: Math.min(dims.y, y + by), z1: Math.min(dims.z, z + bz) });
  }
  return out;
}
function brickData(box, vol) {
  const w = box.x1 - box.x0, h = box.y1 - box.y0, d = box.z1 - box.z0, out = new Uint8Array(w * h * d);
  for (let z = 0; z < d; z++) for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[(z * h + y) * w + x] = vol(box.x0 + x, box.y0 + y, box.z0 + z);
  return out;
}
const inBox = (b, x, y, z) => x >= b.x0 && x < b.x1 && y >= b.y0 && y < b.y1 && z >= b.z0 && z < b.z1;

function shuffled(list, rand) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

function runCase(seed, sizes, G, { drop = 0 } = {}) {
  const rand = rng(seed);
  const boxes = tile(G.dims, sizes);
  const empty = new Set(shuffled(boxes.map((_, i) => i), rand).slice(0, Math.floor(boxes.length * drop)));
  const absent = boxes.filter((_, i) => empty.has(i));
  const vol = (x, y, z) => (absent.some((b) => inBox(b, x, y, z)) ? 0 : value(x, y, z));
  const acc = IJOblique.create(G, { channel: 0, outBitDepth: 8 });
  for (const i of shuffled(boxes.map((_, k) => k), rand)) {
    if (empty.has(i)) continue;
    acc.add({ channel: 0, box: boxes[i], data: brickData(boxes[i], vol) });
  }
  return { got: acc.finish(), want: IJOblique.reference(G, vol), acc, vol };
}

test('single plane: brick by brick equals the direct evaluation (64³, 66³ stripped, 32×32×bz, odd sizes)', () => {
  for (const [seed, sizes] of [[1, [16, 16, 16]], [2, [32, 32, 8]], [3, [64, 64, 64]], [4, [13, 17, 11]], [5, [66 - 2, 66 - 2, 66 - 2]]]) {
    const G = makeG(rng(seed * 101), {});
    const { got, want } = runCase(seed, sizes, G);
    assert.deepEqual(Array.from(got), Array.from(want), `seed ${seed} sizes ${sizes}`);
    assert.ok(got.some((v) => v > 0) && got.some((v) => v === 0), 'the cut leaves the volume somewhere');
  }
});

test('slab: max and mean, random specs, orders and brick sizes', () => {
  let n = 0;
  for (let seed = 10; seed < 22; seed++) {
    for (const projMode of ['max', 'mean']) {
      const G = makeG(rng(seed * 977), { steps: 2 + (seed % 7), projMode, width: 28, height: 22 });
      const { got, want } = runCase(seed, [[16, 16, 16], [32, 32, 8], [11, 9, 7]][seed % 3], G, { drop: 0 });
      assert.deepEqual(Array.from(got), Array.from(want), `${projMode} seed ${seed}`);
      n++;
    }
  }
  assert.ok(n >= 24);
});

test('ESS bricks absent: zero voxels, the mean stays unbiased (K comes from the geometry)', () => {
  for (let seed = 30; seed < 36; seed++) {
    const G = makeG(rng(seed * 31), { steps: 6, projMode: 'mean', width: 30, height: 20 });
    const { got, want, acc } = runCase(seed, [16, 16, 16], G, { drop: 0.4 });
    assert.deepEqual(Array.from(got), Array.from(want), `seed ${seed}`);
    assert.equal(acc.missing([]).count, 0, 'nothing delivered-and-failed: no missing pixel');
  }
  // a brick-less mean is lower than the full one exactly where bricks were dropped, never higher
  const G = makeG(rng(99), { steps: 5, projMode: 'mean', width: 30, height: 20 });
  const full = runCase(7, [16, 16, 16], G, { drop: 0 }).got, part = runCase(7, [16, 16, 16], G, { drop: 0.5 }).got;
  assert.ok(Array.from(part).every((v, i) => v <= full[i] + 0), 'a dropped brick can only lower a mean');
});

test('failed bricks: missing() lists only the pixels with a sample in them', () => {
  const G = makeG(rng(5), { steps: 4, projMode: 'max', width: 30, height: 20 });
  const boxes = tile(G.dims, [16, 16, 16]);
  const failed = [boxes[2], boxes[7]];
  const acc = IJOblique.create(G, { channel: 0 });
  const m = acc.missing(failed);
  // direct: a pixel is missing iff one of its in-volume samples reads a voxel of a failed box
  const want = new Uint8Array(G.width * G.height);
  const h = (G.steps - 1) / 2;
  for (let py = 0; py < G.height; py++) for (let px = 0; px < G.width; px++) {
    for (let s = 0; s < G.steps; s++) {
      const t = [0, 1, 2].map((k) => G.o[k] + (px + 0.5) * G.a[k] + (py + 0.5) * G.b[k] + (s - h) * G.c[k]);
      if (!t.every((v) => v >= 0 && v <= 1)) continue;
      const vx = [t[0] * G.dims.x, t[1] * G.dims.y, t[2] * G.dims.z].map((v, k) => Math.min([G.dims.x, G.dims.y, G.dims.z][k] - 1, Math.floor(v)));
      if (failed.some((b) => inBox(b, vx[0], vx[1], vx[2]))) want[py * G.width + px] = 1;
    }
  }
  assert.deepEqual(Array.from(m.mask), Array.from(want));
  assert.equal(m.count, want.reduce((a, b) => a + b, 0));
  assert.ok(m.count > 0 && m.count < want.length);
});

test('the mean is rounded half up, and a tie stays a tie', () => {
  // a slab of two samples through one column of voxels holding 10 and 13 → 11.5 → 12
  const G = { dims: { x: 4, y: 4, z: 4 }, width: 1, height: 1, o: [0.375, 0.375, 0.125], a: [0, 0, 0], b: [0, 0, 0], c: [0, 0, 0.25], steps: 2, projected: true, projMode: 'mean' };
  const vol = (x, y, z) => (x === 1 && y === 1 ? (z === 0 ? 10 : z === 1 ? 13 : 0) : 0);
  const acc = IJOblique.create(G, { channel: 0 });
  acc.add({ channel: 0, box: { x0: 0, y0: 0, z0: 0, x1: 4, y1: 4, z1: 4 }, data: brickData({ x0: 0, y0: 0, z0: 0, x1: 4, y1: 4, z1: 4 }, vol) });
  // samples at z = 0.125 − 0.125 = 0 → voxel 0, and 0.125 + 0.125 = 0.25 → voxel 1
  assert.equal(acc.finish()[0], 12);
  assert.deepEqual(Array.from(IJOblique.reference(G, vol)), [12]);
});

test('single plane: outside the volume is 0, t = 1 reads the last voxel, coverage follows the geometry', () => {
  const dims = { x: 8, y: 8, z: 8 };
  // an XY plane at z = 1 exactly (t_z = 1 → voxel 7), 12 × 12 pixels of a voxel, overhanging the volume
  const G = { dims, width: 12, height: 12, o: [-2 / 8, -2 / 8, 1], a: [1 / 8, 0, 0], b: [0, 1 / 8, 0], c: [0, 0, 1 / 8], steps: 1, projected: false, projMode: null };
  const vol = (x, y, z) => 1 + z;
  const acc = IJOblique.create(G, { channel: 0 });
  acc.add({ channel: 0, box: { x0: 0, y0: 0, z0: 0, x1: 8, y1: 8, z1: 8 }, data: brickData({ x0: 0, y0: 0, z0: 0, x1: 8, y1: 8, z1: 8 }, vol) });
  const out = acc.finish(), cov = acc.coverage();
  const at = (x, y) => out[y * 12 + x];
  assert.equal(at(6, 6), 8, 'z = 1 reads voxel 7');
  assert.equal(at(0, 0), 0, 'outside the volume: no sample');
  assert.equal(cov[6 * 12 + 6], 1); assert.equal(cov[0], 0);
  assert.deepEqual(Array.from(out), Array.from(IJOblique.reference(G, vol)));
});

test('voxel-boundary planes (t·dim lands on integers) agree with the reference to the last bit', () => {
  const dims = { x: 70, y: 52, z: 41 };
  const G = { dims, width: 70, height: 52, o: [-0.5 / 70, -0.5 / 52, 20 / 41], a: [1 / 70, 0, 0], b: [0, 1 / 52, 0], c: [0, 0, 1 / 41], steps: 1, projected: false, projMode: null };
  const { got, want } = runCase(3, [16, 16, 16], G);
  assert.deepEqual(Array.from(got), Array.from(want));
});

test('bad input is refused with a code', () => {
  const G = makeG(rng(1), {});
  const acc = IJOblique.create(G, { channel: 0 });
  const code = (fn) => { try { fn(); } catch (e) { return e.code; } return null; };
  assert.equal(code(() => acc.add({ channel: 0, box: { x0: 0, y0: 0, z0: 0, x1: 4, y1: 4, z1: 4 }, data: new Uint8Array(3) })), 'IJ_LIB_BAD_ARGS');
  assert.equal(code(() => acc.add({ channel: 0, box: { x0: 0, y0: 0, z0: 0, x1: 99, y1: 4, z1: 4 }, data: new Uint8Array(99 * 16) })), 'IJ_LIB_BAD_ARGS');
  assert.equal(code(() => IJOblique.create({ ...G, a: [1, 2] }, {})), 'IJ_LIB_BAD_ARGS');
  assert.equal(code(() => IJOblique.create(G, { outBitDepth: 16 })), 'IJ_LIB_BAD_ARGS');
  assert.equal(acc.add({ channel: 1, box: { x0: 0, y0: 0, z0: 0, x1: 1, y1: 1, z1: 1 }, data: new Uint8Array(1) }), false, 'another channel is not this accumulator\'s');
  const slab = IJOblique.estimateBytes({ ...makeG(rng(1), { steps: 3, projMode: 'mean' }) }, { channels: 4 });
  const flat = IJOblique.estimateBytes(G, { channels: 4 });
  const px = G.width * G.height;
  assert.ok(slab > flat && flat === px * 2 + px * 3 + G.width * 10, 'accumulator + mask of one channel, one 8-bit plane per further channel');
});

test('cost follows the samples, not bricks x rows x steps (2048� plane, 1024 bricks; tilted slab; a quarter-turn frame)', () => {
  const dims = { x: 2048, y: 2048, z: 64 };
  const mk = (a, b, c, steps, projMode) => ({ dims, width: 2048, height: 2048, o: [0, 0, 0.5], a, b, c, steps, projected: steps > 1, projMode });
  const lay = (G, label, limit) => {
    const t0 = Date.now();
    const acc = IJOblique.create(G, { channel: 0 });
    let hits = 0;
    for (const box of tile(dims, [64, 64, 64])) {
      const data = new Uint8Array((box.x1 - box.x0) * (box.y1 - box.y0) * (box.z1 - box.z0)).fill(7);
      acc.add({ channel: 0, box, data });
      hits++;
    }
    const out = acc.finish();
    const ms = Date.now() - t0;
    assert.ok(hits === 32 * 32 * 1 && out.length === 2048 * 2048);
    assert.ok(ms < limit, `${label}: ${ms} ms (limit ${limit})`);
    return out;
  };
  // XY plane: a / b one voxel per pixel
  const single = lay(mk([1 / 2048, 0, 0], [0, 1 / 2048, 0], [0, 0, 1 / 64], 1, null), 'single plane', 2500);
  assert.equal(single[1000 * 2048 + 1000], 7);
  // a tiny but non-zero axis component (cos 90�) in an XZ-like frame: the old linear trims walked W per row
  const tiny = 6.123233995736766e-17;
  lay(mk([1 / 2048, tiny, 0], [tiny, 1 / 2048, 0], [0, 0, 1 / 64], 1, null), 'cos 90�', 2500);
  // a 16-step mean slab
  const mean = lay(mk([1 / 2048, 0, 0], [0, 1 / 2048, 0], [0, 0, 1 / 256], 16, 'mean'), '16-step slab', 6000);
  assert.equal(mean[1000 * 2048 + 1000], 7, 'the mean of seven-valued samples');
});

console.log(`test_ij_oblique_sampler: ${passed} groups passed`);
