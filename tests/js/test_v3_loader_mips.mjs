// PlaneLoader reads a format-3 mips/ tree (DOCS/dataset-migrations/SPEC.md §12): per
// brick layer l (planes [64·l, min(64·l + 64, Z))) the per-voxel maximum over its
// planes, packed like planes (lNNNNN.bin, magic LMIP, header z = l). Covered:
//   • manifest validation (schema, formatVersion 3, packPattern, layerDepth, layers =
//     ceil(Z/64), and everything the planes manifest checks) and the bricks sha256;
//   • a pack with the plane magic where a MIP is expected is refused;
//   • loadLayerMax = the max over the layer's planes, voxel for voxel (ragged last
//     layer, empty tiles, tile seams);
//   • planSlabMax(z0, z1): whole layers inside the slab, planes of the partial ends;
//   • loadSlabMax = planes.loadRegionMax over every plane of the slab = brute force,
//     for slabs that start/end mid-layer, cover exactly one layer, all of them, or none;
//     with compose (LUT after the max) too; it reads fewer packs than the planes path;
//   • abort rejects with AbortError.
//
// Run: node tests/js/test_v3_loader_mips.mjs
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { PlaneCodec, buildTree, mockFetch, loadPlaneLoader } from './test_mig_reader_plane_loader.mjs';

const DIMS = { x: 700, y: 530, z: 150 };   // tiles 2 × 2 (ragged), layers 64 + 64 + 22
const C = 2;
const LAYERS = Math.ceil(DIMS.z / 64);
const voxel = (x, y, z, c) => {
  // Channel 1 is black over the ragged corner tile (tx 1, ty 1) in every plane: empty MIP tiles.
  if (c === 1 && x >= 512 && y >= 512) return 0;
  // Sparse bright spots so the maximum is not the same plane everywhere.
  const h = ((x * 73856093) ^ (y * 19349663) ^ (z * 83492791) ^ (c * 2654435761)) >>> 0;
  return (h % 7 === 0) ? (h >>> 8) & 255 : (h >>> 16) & 31;
};
const BASE = 'DATA_WEB/3d/mipdemo';
const BRICKS = `${BASE}/bricks/manifest.json`;
const bricksManifest = '{"schema":"iribhm-bricks-v3","levels":[]}';
const planesTree = await buildTree({ base: `${BASE}/planes`, dims: DIMS, channels: C, voxel, bricksManifest });

const VOL = Array.from({ length: C }, (_, c) => Array.from({ length: DIMS.z }, (_, z) => {
  const plane = new Uint8Array(DIMS.x * DIMS.y);
  for (let y = 0; y < DIMS.y; y++) for (let x = 0; x < DIMS.x; x++) plane[y * DIMS.x + x] = voxel(x, y, z, c);
  return plane;
}));
const maxOver = (zs, c, r) => {
  const w = r.x1 - r.x0, h = r.y1 - r.y0;
  const out = new Uint8Array(w * h);
  for (const z of zs) {
    const plane = VOL[c][z];
    for (let y = 0; y < h; y++) {
      const row = (r.y0 + y) * DIMS.x + r.x0;
      for (let x = 0; x < w; x++) { const v = plane[row + x]; if (v > out[y * w + x]) out[y * w + x] = v; }
    }
  }
  return out;
};
const range = (a, b) => Array.from({ length: b - a }, (_, i) => a + i);
const layerPlanes = (l) => range(64 * l, Math.min(64 * l + 64, DIMS.z));

/** The mips tree, written as the m003 migration does: per layer, per tile, the max over planes. */
async function buildMips({ base, magic = 'LMIP', manifestPatch = {} }) {
  const files = new Map();
  const TS = 512, TX = Math.ceil(DIMS.x / TS), TY = Math.ceil(DIMS.y / TS);
  const headerBytes = PlaneCodec.headerBytes(C, TX, TY);
  for (let l = 0; l < LAYERS; l++) {
    const entries = [];
    const payloads = [];
    let offset = headerBytes;
    for (let c = 0; c < C; c++) for (let ty = 0; ty < TY; ty++) for (let tx = 0; tx < TX; tx++) {
      const r = { x0: tx * TS, y0: ty * TS, x1: Math.min(DIMS.x, tx * TS + TS), y1: Math.min(DIMS.y, ty * TS + TS) };
      const data = maxOver(layerPlanes(l), c, r);
      if (!data.some(v => v)) { entries.push({ offset: 0, length: 0 }); continue; }
      const png = await PlaneCodec.encodePngGray(r.x1 - r.x0, r.y1 - r.y0, data);
      entries.push({ offset, length: png.length });
      payloads.push(png);
      offset += png.length;
    }
    const header = PlaneCodec.buildPackHeader({ channels: C, tilesX: TX, tilesY: TY, z: l, entries });
    for (let i = 0; i < 4; i++) header[i] = magic.charCodeAt(i);
    const pack = new Uint8Array(offset);
    pack.set(header, 0);
    let o = headerBytes;
    for (const p of payloads) { pack.set(p, o); o += p.length; }
    files.set(`${base}/l${String(l).padStart(5, '0')}.bin`, pack);
  }
  const manifest = {
    schema: 'lumen-mips-v1', formatVersion: 3, level: 0,
    dimensions: { ...DIMS }, channels: C, tileSize: TS, tiles: { x: TX, y: TY },
    codec: 'png-gray8', packPattern: 'l{l}.bin', headerBytes, layers: LAYERS, layerDepth: 64,
    source: { manifestSha256: createHash('sha256').update(new TextEncoder().encode(bricksManifest)).digest('hex') },
    producer: 'migration-server', createdAt: '2026-10-05T00:00:00Z', ...manifestPatch
  };
  files.set(`${base}/manifest.json`, new TextEncoder().encode(JSON.stringify(manifest)));
  return { files, manifest };
}

const mipsTree = await buildMips({ base: `${BASE}/mips` });
const files = new Map([...planesTree.files, ...mipsTree.files, [BRICKS, planesTree.bricksBytes]]);
const openArgs = { dimensions: { ...DIMS }, channels: C, sourceManifestUrl: BRICKS };
const sameBytes = (a, b, label) => {
  assert.equal(a.length, b.length, `${label}: length`);
  let diff = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diff++;
  assert.equal(diff, 0, `${label}: ${diff} bytes differ`);
};

// ── planSlabMax ──────────────────────────────────────────────────────────────
{
  const L = loadPlaneLoader(mockFetch(new Map()));
  const plan = (a, b) => JSON.parse(JSON.stringify(L.planSlabMax(a, b, DIMS.z)));
  assert.deepEqual(plan(0, 150), { layers: [0, 1, 2], planes: [] }, 'whole volume: every layer, the ragged last one included');
  assert.deepEqual(plan(64, 128), { layers: [1], planes: [] }, 'exactly one layer');
  assert.deepEqual(plan(10, 140), { layers: [1], planes: [...range(10, 64), ...range(128, 140)] }, 'partial ends as planes');
  assert.deepEqual(plan(130, 150), { layers: [], planes: range(130, 150) }, 'inside the last layer, not from its start');
  assert.deepEqual(plan(128, 150), { layers: [2], planes: [] }, 'the ragged last layer, whole');
  assert.deepEqual(plan(128, 149), { layers: [], planes: range(128, 149) }, 'the last layer minus one plane');
  assert.deepEqual(plan(5, 6), { layers: [], planes: [5] }, 'one plane');
  assert.deepEqual(plan(0, 64), { layers: [0], planes: [] });
  assert.deepEqual(plan(-5, 400), { layers: [0, 1, 2], planes: [] }, 'clamped to the volume');
  assert.throws(() => L.planSlabMax(7, 7, DIMS.z), /empty slab/);
  console.log('planSlabMax: OK');
}

// ── Manifest validation ─────────────────────────────────────────────────────
{
  const L = loadPlaneLoader(mockFetch(files));
  const mips = await L.openMips(`${BASE}/mips`, openArgs);
  assert.equal(mips.kind, 'mips'); assert.equal(mips.layers, 3); assert.equal(mips.layerDepth, 64);
  const variants = [
    [{ layers: 2 }, /layers/],
    [{ layerDepth: 32 }, /layerDepth/],
    [{ schema: 'lumen-planes-v1' }, /schema/],
    [{ formatVersion: 2 }, /formatVersion/],
    [{ packPattern: 'z{z}.bin' }, /packPattern/],
    [{ headerBytes: 16 }, /headerBytes/]
  ];
  for (const [patch, re] of variants) {
    const bad = await buildMips({ base: `${BASE}/badmips`, manifestPatch: patch });
    const LL = loadPlaneLoader(mockFetch(new Map([...files, ...bad.files])));
    await assert.rejects(LL.openMips(`${BASE}/badmips`, openArgs), (e) => e.code === 'MIPS_INVALID' && re.test(e.message), JSON.stringify(patch));
  }
  // A planes manifest is not a mips manifest, nor the reverse.
  await assert.rejects(L.openMips(`${BASE}/planes`, openArgs), (e) => e.code === 'MIPS_INVALID');
  await assert.rejects(L.open(`${BASE}/mips`, openArgs), (e) => e.code === 'PLANES_INVALID');
  // Cut from another bricks manifest.
  const stale = new Map(files);
  stale.set(BRICKS, new TextEncoder().encode('{"schema":"iribhm-bricks-v3","levels":[1]}'));
  await assert.rejects(loadPlaneLoader(mockFetch(stale)).openMips(`${BASE}/mips`, openArgs), (e) => e.code === 'PLANES_STALE');
  // A plane pack where a MIP pack is expected.
  const wrongMagic = await buildMips({ base: `${BASE}/lpln`, magic: 'LPLN' });
  const LW = loadPlaneLoader(mockFetch(new Map([...files, ...wrongMagic.files])));
  const mw = await LW.openMips(`${BASE}/lpln`, openArgs);
  await assert.rejects(mw.loadLayerMax(0, [0], { x0: 0, y0: 0, x1: 10, y1: 10 }), /magic is not LMIP/);
  // The mips pack URLs carry the manifest stamp, layer indices are range-checked.
  const fetchImpl = mockFetch(files);
  const L2 = loadPlaneLoader(fetchImpl);
  const m2 = await L2.openMips(`${BASE}/mips`, openArgs);
  await m2.loadLayerMax(2, [0], { x0: 0, y0: 0, x1: 4, y1: 4 });
  assert.ok(fetchImpl.log.some(q => q.path === `${BASE}/mips/l00002.bin` && q.query === `v=${m2.stamp}`), 'lNNNNN.bin?v=stamp');
  await assert.rejects(m2.loadLayerMax(3, [0], { x0: 0, y0: 0, x1: 4, y1: 4 }), /layer 3 outside 0..2/);
  console.log('mips manifest validation, magic, stamp, range: OK');
}

// ── Exactness: layer MIPs and slab MIPs vs planes ────────────────────────────
{
  const fetchImpl = mockFetch(files);
  const L = loadPlaneLoader(fetchImpl);
  const planes = await L.open(`${BASE}/planes`, openArgs);
  const mips = await L.openMips(`${BASE}/mips`, openArgs);
  const rects = [
    { x0: 0, y0: 0, x1: 700, y1: 530 },            // everything, both tile seams, ragged tiles
    { x0: 505, y0: 500, x1: 530, y1: 530 },        // across both seams, into the empty channel-1 tile
    { x0: 600, y0: 520, x1: 700, y1: 530 }         // inside the ragged corner tile
  ];
  for (let l = 0; l < LAYERS; l++) {
    const got = await mips.loadLayerMax(l, [0, 1], rects[0]);
    for (const c of [0, 1]) sameBytes(got.data[c], maxOver(layerPlanes(l), c, rects[0]), `layer ${l} channel ${c}`);
  }
  const slabs = [[0, 150], [10, 140], [64, 128], [130, 150], [128, 150], [63, 65], [5, 6]];
  for (const [a, b] of slabs) {
    // The whole frame for two slabs (decoding up to 150 full planes is the slow part), the seams for all.
    for (const r of (a === 10 || a === 0) ? rects : rects.slice(1)) {
      const viaMips = await L.loadSlabMax(planes, mips, a, b, [1, 0], r);
      const viaPlanes = await planes.loadRegionMax(range(a, b), [1, 0], r);
      for (const [i, c] of [[0, 1], [1, 0]]) {
        const want = maxOver(range(a, b), c, r);
        sameBytes(viaMips.data[i], want, `slab [${a},${b}) ${JSON.stringify(r)} channel ${c}, via mips`);
        sameBytes(viaPlanes.data[i], want, `slab [${a},${b}) channel ${c}, via planes`);
      }
    }
  }
  // Without a mips tree loadSlabMax reads every plane — same pixels.
  const noMips = await L.loadSlabMax(planes, null, 10, 140, [0], rects[1]);
  sameBytes(noMips.data[0], maxOver(range(10, 140), 0, rects[1]), 'slab without mips');
  // compose: LUT applied after the maximum, interleaved like a composed brick row.
  const lut = new Uint8Array(256).map((_, v) => (v < 10 ? 0 : Math.min(255, Math.round((v - 10) * 255 / 245))));
  const r = rects[1];
  const comp = await L.loadSlabMax(planes, mips, 0, 150, [0, 1], r, { compose: { components: 4, slots: [2, 0], luts: [lut, null] } });
  const w = r.x1 - r.x0, h = r.y1 - r.y0;
  const m0 = maxOver(range(0, 150), 0, r), m1 = maxOver(range(0, 150), 1, r);
  let diff = 0;
  for (let i = 0; i < w * h; i++) {
    if (comp.rgba[i * 4 + 2] !== lut[m0[i]] || comp.rgba[i * 4] !== m1[i] || comp.rgba[i * 4 + 1] || comp.rgba[i * 4 + 3]) diff++;
  }
  assert.equal(diff, 0, 'composed slab MIP');
  // Fewer packs: a whole-stack MIP reads 3 layer packs instead of 150 plane packs.
  fetchImpl.log.length = 0;
  let packs = 0;
  await L.loadSlabMax(planes, mips, 0, 150, [0], rects[2], { onPlane: (done, total) => { packs = total; } });
  assert.equal(packs, 3, 'three layer MIPs for the whole stack');
  assert.ok(fetchImpl.log.every(q => q.path.includes('/mips/')), 'no plane pack read');
  // Mismatched trees are refused.
  const other = await buildTree({ base: `${BASE}/planes2`, dims: { x: 700, y: 530, z: 149 }, channels: C, voxel, bricksManifest });
  const L3 = loadPlaneLoader(mockFetch(new Map([...files, ...other.files])));
  const p2 = await L3.open(`${BASE}/planes2`, { dimensions: { x: 700, y: 530, z: 149 }, channels: C });
  const mm = await L3.openMips(`${BASE}/mips`, openArgs);
  await assert.rejects(L3.loadSlabMax(p2, mm, 0, 10, [0], rects[2]), (e) => e.code === 'MIPS_INVALID');
  console.log('layer MIPs and slab MIPs = the maximum over planes, pixel for pixel: OK');
}

// ── Abort ─────────────────────────────────────────────────────────────────────
{
  const L = loadPlaneLoader(mockFetch(files, { delay: 20 }));
  const planes = await L.open(`${BASE}/planes`, openArgs);
  const mips = await L.openMips(`${BASE}/mips`, openArgs);
  const ac = new AbortController();
  const p = L.loadSlabMax(planes, mips, 10, 140, [0, 1], { x0: 0, y0: 0, x1: 700, y1: 530 }, { signal: ac.signal });
  setTimeout(() => ac.abort(), 5);
  await assert.rejects(p, (e) => e.name === 'AbortError');
  ac.abort();
  await assert.rejects(L.loadSlabMax(planes, mips, 0, 150, [0], { x0: 0, y0: 0, x1: 4, y1: 4 }, { signal: ac.signal }), (e) => e.name === 'AbortError');
  L.dispose();
  console.log('abort: OK');
}

console.log('PlaneLoader mips: OK');
process.exit(0);
