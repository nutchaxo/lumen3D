// Browser handler of migration m004-bricks-v3 (js/migrations/m004-bricks-v3.js), SPEC §13:
//   • levelPlan: X/Y halved (ceil), Z halved iff vz_k ≤ 1.5·vxy_{k+1}, levels while max(X,Y) > 128
//     — checked on a real lab geometry (3789² × 226, 0.430366 / 2.057106 µm) and edge cases;
//   • reducePlane: ⌊(S + ⌊n/2⌋)/n⌋ over the voxels that exist (n = 1, 2, 4, 8), against a
//     brute-force reference on odd sizes;
//   • mosaicBrick: 66³ with clamp-to-edge, 9 × 8 grid of 66² slices, empty slots 0, alpha 255;
//   • a whole synthetic dataset (3d and live; 2 channels; v2 raw-u8 bricks with garbage padding
//     past the volume edge, ESS-dropped bricks, a present brick whose voxels in the volume are
//     all zero; 300 × 200 × 70 at 0.5/0.5/2 µm = three levels, one without and one with Z
//     halving; partial super-blocks) is migrated unit by unit, level after level, level k+1
//     reading level k back through io.fetchStored. Every produced brick equals the reference
//     implementation written here voxel for voxel, and the set of kept bricks is exactly the
//     set whose 64³ interior holds a voxel ≥ 1;
//   • the unit blob layout { u32 count, count × { u32 bz, by, bx, length, bytes } } byte by byte;
//   • probe(): exact WebP round trip → available; a lossy encoder, or a browser that hands back
//     PNG for image/webp, or a lossy VP8 bitstream → unavailable with `no_webp_lossless_encode`.
//
// Run: node tests/js/test_v3_bmig_m004.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT } from './harness.mjs';

const read = (p) => readFileSync(path.join(ROOT, p), 'utf8');
const plain = (v) => JSON.parse(JSON.stringify(v));
const deq = (a, b, m) => assert.deepStrictEqual(plain(a), plain(b), m);
const BS = 64, SLAB = 66, COLS = 9, ROWS = 8, MW = 594, MH = 528;

// A minimal RIFF/WEBP file whose VP8L (or, `lossy`, VP8) chunk carries a picture id.
function fakeWebp(id, lossy, w = MW, h = MH) {
  const b = new Uint8Array(32);
  const dv = new DataView(b.buffer);
  b.set([0x52, 0x49, 0x46, 0x46], 0); dv.setUint32(4, 24, true); b.set([0x57, 0x45, 0x42, 0x50], 8);
  b.set(lossy ? [0x56, 0x50, 0x38, 0x20] : [0x56, 0x50, 0x38, 0x4C], 12); dv.setUint32(16, 12, true);
  // VP8L header: 14 bits width − 1, 14 bits height − 1, alpha hint, version 0.
  b[20] = 0x2F; dv.setUint32(21, ((w - 1) | ((h - 1) << 14)) >>> 0, true); dv.setUint32(25, id, true);
  return b;
}
const fakeWebpId = (u) => new DataView(u.buffer, u.byteOffset, u.byteLength).getUint32(25, true);

// ── Fake image stack: an encoded "webp" is 4 id bytes; the picture is kept aside ──
function imageStack(opts = {}) {
  const pictures = new Map();
  let nextId = 1;
  class FakeImageData { constructor(data, w, h) { this.data = data; this.width = w; this.height = h; } }
  function OffscreenCanvas(w, h) {
    this.width = w; this.height = h;
    let pixels = new Uint8ClampedArray(w * h * 4);
    const canvas = this;
    this.getContext = () => ({
      globalCompositeOperation: '',
      putImageData(img) { pixels = new Uint8ClampedArray(img.data); },
      drawImage(bmp) { pixels = new Uint8ClampedArray(bmp.pic.rgba); },
      getImageData(x, y, ww, hh) { assert.equal(x, 0); assert.equal(y, 0); return { data: pixels.slice(0, ww * hh * 4) }; },
    });
    this.convertToBlob = async (o) => {
      assert.equal(o.type, 'image/webp'); assert.equal(o.quality, 1);
      const id = nextId++;
      const rgba = new Uint8ClampedArray(pixels);
      if (opts.lossy) rgba[4 * 1000] ^= 1;
      pictures.set(id, { width: canvas.width, height: canvas.height, rgba });
      const sw = opts.wrongSize ? canvas.width - 1 : canvas.width;
      return new Blob([fakeWebp(id, !!opts.lossyChunk, sw, canvas.height)], { type: opts.png ? 'image/png' : 'image/webp' });
    };
  }
  return {
    pictures,
    sandbox: {
      OffscreenCanvas, ImageData: FakeImageData,
      createImageBitmap: async (blob, o) => {
        assert.equal(o.premultiplyAlpha, 'none'); assert.equal(o.colorSpaceConversion, 'none');
        const u = new Uint8Array(await blob.arrayBuffer());
        const pic = pictures.get(fakeWebpId(u));
        assert.ok(pic, 'unknown picture');
        return { width: pic.width, height: pic.height, pic, close() {} };
      },
    },
  };
}

function loadHandlers(stackOpts) {
  const stack = imageStack(stackOpts);
  const ctx = vm.createContext({ console, setTimeout, clearTimeout, CompressionStream, DecompressionStream, Response, Blob, ...stack.sandbox });
  vm.runInContext(read('js/core/plane-codec.js'), ctx, { filename: 'plane-codec.js' });
  vm.runInContext(read('js/migrations/m004-bricks-v3.js'), ctx, { filename: 'm004-bricks-v3.js' });
  vm.runInContext(read('js/migrations/m002-planes.js'), ctx, { filename: 'm002-planes.js' });
  return { H: ctx.LumenMigrationHandlers['m004-bricks-v3'], stack };
}

const { H, stack } = loadHandlers();
const I = H._internals;
assert.deepEqual(plain(H.requires), ['m002-planes']);

// ── 1. levels ──
{
  const L = I.levelPlan({ x: 3789, y: 3789, z: 226 }, { x: 0.430366, y: 0.430366, z: 2.057106 });
  deq(L.map((l) => [l.dimensions.x, l.dimensions.y, l.dimensions.z, l.halveZ]), [
    [3789, 3789, 226, false],
    [1895, 1895, 226, false],   // 2.057 > 1.5 · 0.8607
    [948, 948, 113, true],      // 2.057 ≤ 1.5 · 1.7215
    [474, 474, 57, true],
    [237, 237, 29, true],
    [119, 119, 15, true],
  ]);
  assert.deepEqual(plain(L[1].voxelSize), { x: 0.860732, y: 0.860732, z: 2.057106 });
  assert.equal(L[2].voxelSize.z, 2.057106 * 2);
  assert.deepEqual(plain(L[0].gridSize), { x: 60, y: 60, z: 4 });
  assert.equal(I.levelPlan({ x: 128, y: 100, z: 9 }, null).length, 1, 'max(X,Y) ≤ 128: level 0 only');
  // vxy is the COARSER XY size after the step (dataset_migrations.py:level_geometry, checked
  // there on the same geometry): 2.0 ≤ 1.5 · max(1.0, 1.6) halves Z at level 1 already.
  deq(I.levelPlan({ x: 1000, y: 700, z: 90 }, { x: 0.5, y: 0.8, z: 2.0 }).map((l) => [l.dimensions.x, l.dimensions.y, l.dimensions.z, l.halveZ]),
    [[1000, 700, 90, false], [500, 350, 45, true], [250, 175, 23, true], [125, 88, 12, true]]);
  assert.equal(I.voxelTriplet({ x: 1, y: 0, z: 1 }), null, 'a zero voxel size is not a voxel size');
  deq(I.levelPlan({ x: 129, y: 3, z: 1 }, null).map((l) => [l.dimensions.x, l.dimensions.y, l.dimensions.z]),
    [[129, 3, 1], [65, 2, 1]], 'one level beyond 128, Z of 1 stays 1, isotropic default halves Z');
}

// ── 2. reduction arithmetic ──
function refReduce(src, X, Y, Z, halveZ) {
  const nx = Math.ceil(X / 2), ny = Math.ceil(Y / 2), nz = halveZ ? Math.ceil(Z / 2) : Z;
  const out = new Uint8Array(nx * ny * nz);
  for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    let s = 0, n = 0;
    const zs = halveZ ? [2 * z, 2 * z + 1] : [z];
    for (const zz of zs) for (const yy of [2 * y, 2 * y + 1]) for (const xx of [2 * x, 2 * x + 1]) {
      if (zz < Z && yy < Y && xx < X) { s += src[(zz * Y + yy) * X + xx]; n++; }
    }
    out[(z * ny + y) * nx + x] = Math.floor((s + Math.floor(n / 2)) / n);
  }
  return { out, nx, ny, nz };
}
{
  // rounding half up: (S + ⌊n/2⌋) // n
  const p0 = new Uint8Array([1, 2, 0, 0]), p1 = new Uint8Array([0, 0, 1, 1]);
  assert.deepEqual([...I.reducePlane(p0, null, 2, 2, 1, 1)], [Math.floor((3 + 2) / 4)]);
  assert.deepEqual([...I.reducePlane(new Uint8Array([1, 2]), null, 2, 1, 1, 1)], [2], '(3 + 1) // 2');
  assert.deepEqual([...I.reducePlane(new Uint8Array([0, 0, 0, 1]), null, 2, 2, 1, 1)], [0], '(1 + 2) // 4');
  assert.deepEqual([...I.reducePlane(new Uint8Array([0, 0, 1, 1]), null, 2, 2, 1, 1)], [1], '(2 + 2) // 4');
  assert.deepEqual([...I.reducePlane(p0, p1, 2, 2, 1, 1)], [Math.floor((5 + 4) / 8)]);
  assert.deepEqual([...I.reducePlane(new Uint8Array([255, 255, 255, 255]), new Uint8Array([255, 255, 255, 255]), 2, 2, 1, 1)], [255]);
  let seed = 7;
  const rnd = () => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed >>> 24; };
  for (const [X, Y, Z, hz] of [[7, 5, 3, true], [6, 9, 4, true], [5, 5, 3, false], [1, 1, 1, true], [8, 3, 2, true]]) {
    const src = new Uint8Array(X * Y * Z).map(() => rnd());
    const ref = refReduce(src, X, Y, Z, hz);
    for (let z = 0; z < ref.nz; z++) {
      const s0 = hz ? 2 * z : z;
      const p0 = src.subarray(s0 * X * Y, (s0 + 1) * X * Y);
      const p1 = hz && s0 + 1 < Z ? src.subarray((s0 + 1) * X * Y, (s0 + 2) * X * Y) : null;
      assert.deepEqual([...I.reducePlane(p0, p1, X, Y, ref.nx, ref.ny)], [...ref.out.subarray(z * ref.nx * ref.ny, (z + 1) * ref.nx * ref.ny)], `${X}×${Y}×${Z} ${hz}`);
    }
  }
}

// ── reference v3 brick: 66³ with clamp, independent of the handler ──
function refBrick66(vol, dims, bx, by, bz) {
  const out = new Uint8Array(SLAB ** 3);
  const cl = (v, n) => Math.min(n - 1, Math.max(0, v));
  let kept = false;
  for (let l = 0; l < SLAB; l++) for (let j = 0; j < SLAB; j++) for (let i = 0; i < SLAB; i++) {
    const v = vol[(cl(bz * BS - 1 + l, dims.z) * dims.y + cl(by * BS - 1 + j, dims.y)) * dims.x + cl(bx * BS - 1 + i, dims.x)];
    out[(l * SLAB + j) * SLAB + i] = v;
    if (v && l >= 1 && l <= 64 && j >= 1 && j <= 64 && i >= 1 && i <= 64) kept = true;
  }
  return { data: out, kept };
}
function mosaicToBrick(rgba) {
  const out = new Uint8Array(SLAB ** 3);
  for (let l = 0; l < SLAB; l++) for (let j = 0; j < SLAB; j++) for (let i = 0; i < SLAB; i++) {
    const p = ((Math.floor(l / COLS) * SLAB + j) * MW + (l % COLS) * SLAB + i) * 4;
    assert.equal(rgba[p], rgba[p + 1]); assert.equal(rgba[p], rgba[p + 2]); assert.equal(rgba[p + 3], 255);
    out[(l * SLAB + j) * SLAB + i] = rgba[p];
  }
  // the 6 empty slots of the last row
  for (let s = SLAB; s < COLS * ROWS; s++) {
    for (let j = 0; j < SLAB; j++) for (let i = 0; i < SLAB; i++) {
      const p = ((Math.floor(s / COLS) * SLAB + j) * MW + (s % COLS) * SLAB + i) * 4;
      assert.equal(rgba[p], 0, 'empty slot is 0'); assert.equal(rgba[p + 3], 255);
    }
  }
  return out;
}

// ── 3. mosaicBrick on a box against the reference ──
{
  const dims = { x: 70, y: 66, z: 5 };
  const vol = new Uint8Array(dims.x * dims.y * dims.z).map((_, i) => (i * 31 + 7) & 0xFF);
  // box of brick (1, 0, 0): x [63, 70) y [0, 66) z [0, 5)
  const box = { x0: 63, x1: 70, y0: 0, y1: 66, z0: 0, z1: 5 };
  const D = new Uint8Array((box.x1 - box.x0) * (box.y1 - box.y0) * (box.z1 - box.z0));
  for (let z = 0; z < 5; z++) for (let y = 0; y < 66; y++) for (let x = 63; x < 70; x++) D[(z * 66 + y) * 7 + (x - 63)] = vol[(z * 66 + y) * 70 + x];
  for (const [bx, by] of [[1, 0], [1, 1]]) {
    const m = I.mosaicBrick(D, box, dims, bx, by, 0);
    assert.equal(m.rgba.length, MW * MH * 4);
    const ref = refBrick66(vol, dims, bx, by, 0);
    assert.deepEqual(mosaicToBrick(m.rgba), ref.data, `brick ${bx},${by}`);
    assert.equal(m.kept, ref.kept);
  }
}

// ── 4. a whole synthetic dataset ──
function hash(x, y, z, c) {
  let h = Math.imul(x + 1, 73856093) ^ Math.imul(y + 1, 19349663) ^ Math.imul(z + 1, 83492791) ^ Math.imul(c + 1, 2654435761);
  h = Math.imul(h ^ (h >>> 13), 0x5bd1e995);
  return (h ^ (h >>> 15)) >>> 0;
}
// ESS-dropped v2 bricks (absent from the manifest): a pattern, plus the whole last brick column
// of channel 1 (an empty level-0 super-block whose neighbours carry signal into its aprons).
const dropped = (bx, by, bz, c, t) => (bx + by * 3 + bz * 5 + c + t) % 4 === 1 || (bx === 4 && c === 1);
function makeVolume(dims, c, t) {
  const vol = new Uint8Array(dims.x * dims.y * dims.z);
  for (let z = 0; z < dims.z; z++) for (let y = 0; y < dims.y; y++) for (let x = 0; x < dims.x; x++) {
    const bx = x >> 6, by = y >> 6, bz = z >> 6;
    if (dropped(bx, by, bz, c, t)) continue;
    if (bx === 1 && by === 1 && bz === 0) continue;   // present in the manifest, zero inside the volume
    const h = hash(x, y, z, c + 4 * t);
    vol[(z * dims.y + y) * dims.x + x] = (h % 5 === 0) ? (h >>> 8) & 0xFF : ((x + y + z) % 37 === 0 ? 255 : 0);
  }
  return vol;
}
function v2Tree(dims, channels, t) {
  const brickToPack = {};
  const vols = [];
  const parts = [];
  let off = 0;
  const g = { x: Math.ceil(dims.x / BS), y: Math.ceil(dims.y / BS), z: Math.ceil(dims.z / BS) };
  for (let c = 0; c < channels; c++) {
    const vol = makeVolume(dims, c, t);
    vols.push(vol);
    for (let bz = 0; bz < g.z; bz++) for (let by = 0; by < g.y; by++) for (let bx = 0; bx < g.x; bx++) {
      if (dropped(bx, by, bz, c, t)) continue;
      const b = new Uint8Array(BS ** 3);
      for (let z = 0; z < BS; z++) for (let y = 0; y < BS; y++) for (let x = 0; x < BS; x++) {
        const gx = bx * BS + x, gy = by * BS + y, gz = bz * BS + z;
        // past the volume edge: garbage the migration must never read
        b[(z * BS + y) * BS + x] = gx < dims.x && gy < dims.y && gz < dims.z ? vol[(gz * dims.y + gy) * dims.x + gx] : 0xA5;
      }
      const rel = `lod0/c${c}/x${String(bx).padStart(3, '0')}_y${String(by).padStart(3, '0')}_z${String(bz).padStart(3, '0')}.webp`;
      brickToPack[rel] = { url: `lod0/c${c}/pack.bin`, offset: off, length: b.length };
      parts.push({ url: `lod0/c${c}/pack.bin`, b });
      off += b.length;
    }
  }
  const packs = new Map();
  let o = 0;
  for (const p of parts) {
    if (!packs.has(p.url)) packs.set(p.url, { start: o, chunks: [] });
    packs.get(p.url).chunks.push({ o, b: p.b });
    o += p.b.length;
  }
  // one global offset space per pack url: rebuild each pack as a sparse buffer
  const files = new Map();
  for (const [url, pk] of packs) {
    const end = pk.chunks[pk.chunks.length - 1].o + BS ** 3;
    const buf = new Uint8Array(end);
    for (const ch of pk.chunks) buf.set(ch.b, ch.o);
    files.set(url, buf);
  }
  return { brickToPack, files, vols };
}

async function migrate({ live }) {
  const dims = { x: 300, y: 200, z: 70 };
  const voxel = { x: 0.5, y: 0.5, z: 2 };
  const C = 2;
  const tps = live ? [0, 1] : [0];
  const trees = tps.map((t) => v2Tree(dims, C, t));
  const levelsMeta = [{ level: 0, dimensions: dims }];
  const manifest = live
    ? { schema: 'iribhm-bricks-v2', version: 2, channels: C, brickSize: 64, brickPacking: { mode: 'grid', cols: 8, rows: 8 }, voxelSize: voxel, levels: levelsMeta,
      timepoints: Object.fromEntries(tps.map((t, i) => [`t00${t}`, { path: `t00${t}`, levels: levelsMeta, channels: C, brickTransport: { mode: 'packs', encoding: 'raw-u8', brickToPack: trees[i].brickToPack } }])) }
    : { schema: 'iribhm-bricks-v2', version: 2, channels: C, brickSize: 64, brickPacking: { mode: 'grid', cols: 8, rows: 8 }, voxelSize: voxel, levels: levelsMeta,
      brickTransport: { mode: 'packs', encoding: 'raw-u8', brickToPack: trees[0].brickToPack } };
  const base = 'http://h/DATA_WEB/x/ds/';
  let manifestFetches = 0;
  const fetchJson = async (url) => {
    if (url === base + 'metadata.json') return { type: live ? 'live' : '3d' };
    if (url === base + 'bricks/manifest.json') { manifestFetches++; return manifest; }
    throw new Error('404 ' + url);
  };
  const state = await H.prepare({ datasetBase: base, fetchJson });
  assert.equal(manifestFetches, 1, 'the bricks manifest is read once');
  assert.equal(state.trees.length, tps.length);
  const L = state.trees[0].levels;
  deq(L.map((l) => [l.dimensions.x, l.dimensions.y, l.dimensions.z, l.halveZ]), [[300, 200, 70, false], [150, 100, 70, false], [75, 50, 35, true]]);

  const units = H.listUnits(state);
  // level-major: no level-1 unit before the last level-0 one
  const lv = units.map((u) => u.level);
  deq(lv, [...lv].sort((a, b) => a - b), 'units ordered by level');
  assert.ok(units.every((u) => /^t\d+\.k\d\.c\d\.z\d+\.y\d+\.x\d+$/.test(u.key)));
  deq(H.listUnits(state, { sample: true }).map((u) => u.level), units.filter((u) => u.level === 0).map(() => 0));

  const store = new Map();   // `t|k|c|bz,by,bx` → bytes
  const io = {
    fetchRange: async (url, s, e) => {
      const m = /^http:\/\/h\/DATA_WEB\/x\/ds\/bricks\/(?:t00(\d)\/)?(lod0\/c\d\/pack\.bin)\?v=[0-9a-z]+$/.exec(url);
      assert.ok(m, 'v2 pack url ' + url);
      const f = trees[m[1] ? tps.indexOf(+m[1]) : 0].files.get(m[2]);
      return f.slice(s, e);
    },
    fetchStored: async (req) => {
      const out = [];
      for (const [bz, by, bx] of req.bricks) {
        const b = store.get(`${req.t}|${req.level}|${req.channel}|${bz},${by},${bx}`);
        if (b) out.push({ bz, by, bx, b });
      }
      // independent writer of the brick blob layout
      const total = 4 + out.reduce((s, x) => s + 16 + x.b.length, 0);
      const blob = new Uint8Array(total);
      const dv = new DataView(blob.buffer);
      dv.setUint32(0, out.length, true);
      let o = 4;
      for (const x of out) { dv.setUint32(o, x.bz, true); dv.setUint32(o + 4, x.by, true); dv.setUint32(o + 8, x.bx, true); dv.setUint32(o + 12, x.b.length, true); blob.set(x.b, o + 16); o += 16 + x.b.length; }
      return blob;
    },
  };
  let empty = 0;
  for (const u of units) {
    const work = await H.planUnitWork(u.key, state);
    const res = await H.runUnit(work, state, io);
    // independent reader of the brick blob
    const dv = new DataView(res.body.buffer, res.body.byteOffset, res.body.byteLength);
    const n = dv.getUint32(0, true);
    let o = 4;
    for (let i = 0; i < n; i++) {
      const bz = dv.getUint32(o, true), by = dv.getUint32(o + 4, true), bx = dv.getUint32(o + 8, true), len = dv.getUint32(o + 12, true);
      const p = work.unit;
      assert.ok(bz >= 4 * p.BZ && bz < 4 * p.BZ + 4 && by >= 4 * p.BY && by < 4 * p.BY + 4 && bx >= 4 * p.BX && bx < 4 * p.BX + 4, 'brick inside its super-block');
      store.set(`${p.t}|${p.k}|${p.c}|${bz},${by},${bx}`, res.body.slice(o + 16, o + 16 + len));
      o += 16 + len;
    }
    assert.equal(o, res.body.length, 'no trailing bytes');
    assert.equal(res.tiles, n);
    if (u.empty) { assert.equal(n, 0, 'an empty unit keeps nothing'); assert.equal(res.bytesIn, 0); empty++; }
  }
  assert.ok(empty > 0, 'some level-0 units are empty');

  // reference pyramid and bricks
  let checked = 0, keptCount = 0;
  for (let ti = 0; ti < tps.length; ti++) {
    for (let c = 0; c < C; c++) {
      let vol = trees[ti].vols[c];
      let d = { ...dims };
      for (let k = 0; k < L.length; k++) {
        if (k > 0) {
          const r = refReduce(vol, d.x, d.y, d.z, L[k].halveZ);
          vol = r.out; d = { x: r.nx, y: r.ny, z: r.nz };
        }
        assert.deepEqual(d, plain(L[k].dimensions));
        const g = L[k].gridSize;
        for (let bz = 0; bz < g.z; bz++) for (let by = 0; by < g.y; by++) for (let bx = 0; bx < g.x; bx++) {
          const ref = refBrick66(vol, d, bx, by, bz);
          const got = store.get(`${tps[ti]}|${k}|${c}|${bz},${by},${bx}`);
          assert.equal(!!got, ref.kept, `kept t${tps[ti]} k${k} c${c} ${bz},${by},${bx}`);
          if (got) {
            assert.ok(I.isLosslessWebp(got), 'a VP8L file');
            const pic = stack.pictures.get(fakeWebpId(got));
            assert.equal(pic.width, MW); assert.equal(pic.height, MH);
            assert.deepEqual(mosaicToBrick(pic.rgba), ref.data, `voxels t${tps[ti]} k${k} c${c} ${bz},${by},${bx}`);
            keptCount++;
          }
          checked++;
        }
      }
    }
  }
  assert.ok(keptCount > 10 && keptCount < checked, `${keptCount}/${checked} bricks kept`);
  // the present-but-zero v2 brick (1,1,0) is dropped at level 0 in channel 0 of t0
  assert.ok(trees[0].brickToPack['lod0/c0/x001_y001_z000.webp'], 'present in the v2 manifest');
  assert.ok(!store.has('0|0|0|0,1,1'));
  return { checked, keptCount };
}

const r3 = await migrate({ live: false });
const rl = await migrate({ live: true });

// ── 5. blob layout, byte by byte ──
{
  const blob = I.buildBrickBlob([{ bz: 1, by: 2, bx: 3, bytes: new Uint8Array([9, 8, 7]) }, { bz: 0x01020304, by: 0, bx: 5, bytes: new Uint8Array(0) }]);
  assert.deepEqual([...blob], [
    2, 0, 0, 0,
    1, 0, 0, 0, 2, 0, 0, 0, 3, 0, 0, 0, 3, 0, 0, 0, 9, 8, 7,
    4, 3, 2, 1, 0, 0, 0, 0, 5, 0, 0, 0, 0, 0, 0, 0,
  ]);
  const back = I.parseBrickBlob(blob);
  deq(back.map((b) => [b.bz, b.by, b.bx, [...b.bytes]]), [[1, 2, 3, [9, 8, 7]], [0x01020304, 0, 5, []]]);
  assert.throws(() => I.parseBrickBlob(blob.subarray(0, blob.length - 1)), /truncated/);
  assert.throws(() => I.parseBrickBlob(new Uint8Array([...blob, 0])), /trailing/);
}

// ── 6. capability probe ──
{
  assert.deepEqual(plain(await H.probe()), { available: true, reasons: [] });
  const lossy = loadHandlers({ lossy: true }).H;
  assert.deepEqual(plain(await lossy.probe()), { available: false, reasons: ['no_webp_lossless_encode'] });
  const vp8 = loadHandlers({ lossyChunk: true }).H;
  assert.deepEqual(plain(await vp8.probe()), { available: false, reasons: ['no_webp_lossless_encode'] }, 'a lossy VP8 bitstream');
  const png = loadHandlers({ png: true }).H;
  assert.deepEqual(plain(await png.probe()), { available: false, reasons: ['no_webp_lossless_encode'] });
  const wrong = loadHandlers({ wrongSize: true }).H;
  assert.deepEqual(plain(await wrong.probe()), { available: false, reasons: ['no_webp_lossless_encode'] }, 'a VP8L of another size');
  // The RIFF walk refuses what the server refuses (dataset_migrations.py:webp_lossless_size).
  const good = fakeWebp(1, false);
  deq(I.losslessWebpSize(good), { width: MW, height: MH });
  const v1 = good.slice(); v1[24] |= 0x20;   // VP8L version bits ≠ 0
  assert.equal(I.losslessWebpSize(v1), null, 'an unknown VP8L version');
  const odd = good.slice(); new DataView(odd.buffer).setUint32(4, 23, true);
  assert.equal(I.losslessWebpSize(odd), null, 'a RIFF size that does not match the file');
  // A VP8X after the image chunk (only allowed first).
  const late = new Uint8Array(good.length + 18);
  late.set(good);
  new DataView(late.buffer).setUint32(4, late.length - 8, true);
  late.set([0x56, 0x50, 0x38, 0x58], good.length); new DataView(late.buffer).setUint32(good.length + 4, 10, true);
  assert.equal(I.losslessWebpSize(late), null, 'a misplaced VP8X');
  const bare = vm.createContext({ console });
  vm.runInContext(read('js/migrations/m004-bricks-v3.js'), bare);
  assert.deepEqual(plain(await bare.LumenMigrationHandlers['m004-bricks-v3'].probe()), { available: false, reasons: ['no_webp_lossless_encode'] }, 'no OffscreenCanvas');
}

console.log(`m004-bricks-v3 handler: OK (3d ${r3.keptCount}/${r3.checked}, live ${rl.keptCount}/${rl.checked} bricks)`);
