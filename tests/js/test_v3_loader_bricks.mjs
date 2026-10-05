// BrickLoader reads v3 brick trees (DOCS/dataset-migrations/SPEC.md §13) beside v2:
//   • index.bin: magic, version, level/channel counts, grids, file length, sha256
//     against the manifest, pack numbers < packCount — a bad index never mounts and
//     leaves the previous mount in place;
//   • O(1) brick lookup; packs l{k}/c{c}/pNNNNN.bin carry ?v=<12 hex of the sha256>;
//   • the 9 × 8 mosaic of 66² slices un-tiles to the stored 66³ brick (worker), border
//     included; a brick the index does not hold is zeros 66³;
//   • regions in the 66³ frame, compose at 4 / 2 / 1 components, cropToVolume;
//   • getFormat / getLevelInfo / getDimensions;
//   • multi-range: one request per pack carrying every run, multipart parsed; a server
//     answering one range, coalescing, sending a broken multipart or ignoring Range
//     still delivers every brick exactly; multipart parsing on hand-made bodies;
//   • cancellation releases every source; v2 mounts still work after a v3 one.
//
// Run: node tests/js/test_v3_loader_bricks.mjs
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { loadModule } from './harness.mjs';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from './harness.mjs';
import {
  STRIDE, buildV3Tree, mockFetch, loadBrickLoader, rawWorker, mosaicOf, fakeImage, multipartBody
} from './test_v3_loader_fixtures.mjs';

const BASE = 'DATA_WEB/3d/v3demo/bricks';
const S3 = STRIDE ** 3;
const plain = (o) => JSON.parse(JSON.stringify(o));
const tick = () => new Promise((r) => setTimeout(r, 0));

// Level 0: 150 × 100 × 70 (grid 3 × 2 × 2), level 1: 75 × 50 × 70 (grid 2 × 1 × 2).
// Channel 0 is zero for x ≥ 128 (brick column 2 absent), channel 1 is zero for z ≥ 64
// at level 0 (the upper layer absent); values vary on every axis so a misplaced slice,
// row or border voxel shows.
const LEVELS = [
  { dims: { x: 150, y: 100, z: 70 }, voxelSize: { x: 0.5, y: 0.5, z: 2 } },
  { dims: { x: 75, y: 50, z: 70 }, voxelSize: { x: 1, y: 1, z: 2 } }
];
const value = (k, c, x, y, z) => {
  if (c === 0 && k === 0 && x >= 128) return 0;
  if (c === 1 && k === 0 && z >= 64) return 0;
  return 1 + ((x * 7 + y * 13 + z * 29 + c * 101 + k * 53) % 250);
};
const tree = buildV3Tree({ base: BASE, channels: 2, levels: LEVELS, value, perPack: 3 });

const sameBytes = (a, b, label) => {
  assert.equal(a.length, b.length, `${label}: length ${a.length} ≠ ${b.length}`);
  let diff = 0, first = -1;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) { if (first < 0) first = i; diff++; }
  assert.equal(diff, 0, `${label}: ${diff} bytes differ (first at ${first})`);
};
const expectedBrick = (k, c, bx, by, bz) => tree.stored(k, c, bx, by, bz) || new Uint8Array(S3);
const allTasks = (k, channels) => {
  const g = tree.manifest.levels[k].gridSize;
  const out = [];
  for (let bz = 0; bz < g.z; bz++) for (let by = 0; by < g.y; by++) for (let bx = 0; bx < g.x; bx++) {
    for (const c of channels) out.push({ bx, by, bz, channel: c, lod: k });
  }
  return out;
};
const rowsOf = async (BL, tasks, opts = {}) => {
  const rows = [];
  const res = await BL.loadBrickTasks(tasks, { streamOnly: true, ...opts, onBrickLoaded: (r) => rows.push(r) });
  return { rows, summary: res.summary };
};

// ── Mosaic un-tiling in the worker, directly ──────────────────────────────────
{
  const brick = new Uint8Array(S3);
  for (let i = 0; i < S3; i++) brick[i] = (i * 31 + (i >> 7)) & 255;
  const w = rawWorker();
  const pack = { mode: 'grid', cols: 9, rows: 8, slice: 66 };
  w.send({ type: 'DECODE', id: 1, buffer: mosaicOf(brick).buffer, brickSize: 66, packing: pack, expect: { width: 594, height: 528 } });
  const box = { x0: 3, x1: 60, y0: 64, y1: 66, z0: 8, z1: 19 };   // crosses tile rows 0..2, the last rows of a slice
  w.send({ type: 'DECODE', id: 2, buffer: mosaicOf(brick).buffer, brickSize: 66, packing: pack, region: box, expect: { width: 594, height: 528 } });
  w.send({ type: 'DECODE', id: 3, buffer: fakeImage(512, 512, new Uint8Array(512 * 512)).buffer, brickSize: 66, packing: pack, expect: { width: 594, height: 528 } });
  for (let i = 0; i < 30 && w.results.length < 3; i++) await tick();
  const r1 = w.results.find(m => m.id === 1);
  assert.ok(r1 && r1.ok, 'whole 66³ brick decoded');
  sameBytes(new Uint8Array(r1.buffer), brick, 'un-mosaic 9 × 8 of 66²');
  const r2 = w.results.find(m => m.id === 2);
  const exp = [];
  for (let z = box.z0; z < box.z1; z++) for (let y = box.y0; y < box.y1; y++) for (let x = box.x0; x < box.x1; x++) exp.push(brick[(z * 66 + y) * 66 + x]);
  sameBytes(new Uint8Array(r2.buffer), Uint8Array.from(exp), 'un-mosaic of a box');
  const r3 = w.results.find(m => m.id === 3);
  assert.ok(r3 && r3.ok === false && /594×528/.test(r3.message), 'a picture of another size is refused');
  console.log('worker: 66³ mosaic un-tiling, box, size check: OK');
}

// ── Index parsing and validation ──────────────────────────────────────────────
{
  const BL = loadBrickLoader(mockFetch(tree.files));
  const idx = tree.files.get(`${BASE}/index.bin`);
  const parsed = BL._parseV3Index(idx, tree.manifest);
  assert.equal(parsed.levels.length, 2);
  assert.equal(parsed.levels[0].count, 10, 'level 0: the two slots (2, y, 1) are empty in both channels');
  const bad = (mutate, re, label) => {
    const b = idx.slice();
    mutate(b, new DataView(b.buffer));
    assert.throws(() => BL._parseV3Index(b, tree.manifest), re, label);
  };
  bad((b) => { b[0] = 0x58; }, /bad magic/, 'magic');
  bad((b, dv) => dv.setUint16(4, 2, true), /version 2/, 'version');
  bad((b, dv) => dv.setUint16(8, 3, true), /channels/, 'channel count');
  bad((b, dv) => dv.setUint32(12, 4, true), /grid/, 'grid ≠ manifest');
  bad((b, dv) => {
    const e = 12 + 32;   // level 0, channel 0, brick (0,0,0): stored
    dv.setUint16(e, 60000, true);
  }, /packCount/, 'pack number ≥ packCount');
  assert.throws(() => BL._parseV3Index(idx.subarray(0, idx.length - 1), tree.manifest), /bytes/, 'short file');

  // Manifest checks (synchronous, before any state changes).
  const m = (patch) => ({ ...plain(tree.manifest), ...patch });
  assert.throws(() => BL.init(BASE, m({ apron: 0 })), /apron/);
  assert.throws(() => BL.init(BASE, m({ brickPacking: { mode: 'grid', cols: 8, rows: 8, slice: 66 } })), /brickPacking/);
  assert.throws(() => BL.init(BASE, m({ index: { url: '../x.bin', bytes: 1, sha256: '0'.repeat(64) } })), /index.url/);
  const lv = plain(tree.manifest.levels);
  lv[0].gridSize.x = 9;
  assert.throws(() => BL.init(BASE, m({ levels: lv })), /gridSize/);

  // A wrong sha256 rejects the init and mounts nothing.
  await assert.rejects(BL.init(BASE, m({ index: { ...tree.manifest.index, sha256: 'f'.repeat(64) } })), /sha256/);
  assert.equal(BL.isReady(), false, 'nothing mounted after a rejected index');
  await assert.rejects(BL.init(BASE, m({ index: { ...tree.manifest.index, bytes: tree.manifest.index.bytes + 1 } })), /index.bytes/);
  console.log('index.bin validation: OK');
}

// ── Mount, format queries, per-channel delivery ───────────────────────────────
{
  const fetchImpl = mockFetch(tree.files);
  const BL = loadBrickLoader(fetchImpl);
  const p = BL.init(BASE, tree.manifest);
  assert.equal(BL.getFormat(), null, 'not mounted until the index has landed');
  await p;
  const f = plain(BL.getFormat());
  assert.equal(f.version, 3); assert.equal(f.apron, 1); assert.equal(f.brickStride, 66); assert.equal(f.brickSize, 64);
  assert.deepEqual(f.levels[0].grid, { x: 3, y: 2, z: 2 });
  assert.deepEqual(f.levels[1].dims, { x: 75, y: 50, z: 70 });
  assert.deepEqual(f.levels[1].voxelSize, { x: 1, y: 1, z: 2 });
  assert.equal(plain(BL.getLevelInfo(0)).packCount, tree.packCounts[0]);
  assert.equal(BL.getLevelInfo(5), null);
  const d = plain(BL.getDimensions(0));
  assert.equal(d.brickStride, 66); assert.equal(d.brickSize, 64); assert.equal(d.channels, 2);
  assert.equal(BL.hasBrick(2, 1, 0, 0), true, 'occupancy = union over channels');
  assert.equal(BL.hasBrick(2, 1, 1, 0), false, 'a slot no channel stores');
  assert.equal(BL.activeBrickCount(1), 4);
  const idxReq = fetchImpl.log.find(q => q.path.endsWith('index.bin'));
  assert.equal(idxReq.query, `v=${tree.manifest.index.sha256.slice(0, 12)}`, 'index url stamped');

  const tasks = [...allTasks(0, [0, 1]), ...allTasks(1, [0, 1])];
  const { rows, summary } = await rowsOf(BL, tasks);
  assert.equal(summary.delivered, tasks.length); assert.equal(summary.failed.length, 0);
  for (const r of rows) sameBytes(r.data, expectedBrick(r.lod, r.channel, r.bx, r.by, r.bz), `brick l${r.lod} c${r.channel} ${r.bx},${r.by},${r.bz}`);
  assert.ok(rows.some(r => !tree.stored(r.lod, r.channel, r.bx, r.by, r.bz)), 'absent bricks were asked (zeros)');
  for (const q of fetchImpl.log.filter(q => q.path.includes('/l'))) {
    assert.match(q.path, /\/l\d\/c\d\/p\d{5}\.bin$/, 'pack path l{k}/c{c}/pNNNNN.bin');
    assert.equal(q.query, `v=${tree.manifest.index.sha256.slice(0, 12)}`, 'pack url stamped');
  }
  assert.equal(BL.taskBytes({ lod: 0, channel: 0, bx: 0, by: 0, bz: 0 }), tree.entries[0][0][0].length);
  assert.equal(BL.taskBytes({ lod: 0, channel: 0, bx: 2, by: 0, bz: 0 }), 0, 'absent brick: 0 bytes');

  // Regions in the 66³ frame.
  const box = { x0: 0, x1: 2, y0: 10, y1: 66, z0: 63, z1: 66 };
  const one = await rowsOf(BL, [{ bx: 1, by: 1, bz: 0, channel: 0, lod: 0, region: box }]);
  const b = expectedBrick(0, 0, 1, 1, 0);
  const exp = [];
  for (let z = box.z0; z < box.z1; z++) for (let y = box.y0; y < box.y1; y++) for (let x = box.x0; x < box.x1; x++) exp.push(b[(z * 66 + y) * 66 + x]);
  sameBytes(one.rows[0].data, Uint8Array.from(exp), 'region of a v3 brick');

  // An unknown channel is refused, not zero-filled.
  const bad = await rowsOf(BL, [{ bx: 0, by: 0, bz: 0, channel: 2, lod: 0 }]);
  assert.equal(bad.summary.failed.length, 1, 'channel 2 of a 2-channel tree fails');
  console.log('v3 mount, format queries, per-channel bricks with apron, absent = zeros, regions: OK');

  // ── compose: 4, 2 and 1 components, LUT, cropToVolume ─────────────────────────
  const lut = new Uint8Array(256).map((_, i) => 255 - i);
  for (const components of [4, 2, 1]) {
    const channels = components === 1 ? [0] : [0, 1];
    const t = allTasks(0, channels);
    const got = await rowsOf(BL, t, { compose: { components, channels: channels.length, luts: [null, lut] } });
    assert.equal(got.rows.length, 12, `${components}: one row per brick`);
    for (const r of got.rows) {
      assert.equal(r.components, components);
      assert.equal(r.data.length, S3 * components);
      for (const c of channels) {
        const e = expectedBrick(0, c, r.bx, r.by, r.bz);
        // A brick the index does not hold is left at zero, LUT or not (as in v2).
        const held = Boolean(tree.stored(0, c, r.bx, r.by, r.bz));
        let diff = 0;
        for (let i = 0; i < S3; i++) {
          const want = c === 1 && held ? lut[e[i]] : e[i];
          if (r.data[i * components + c] !== want) diff++;
        }
        assert.equal(diff, 0, `compose ${components}: channel ${c} of ${r.bx},${r.by},${r.bz}`);
      }
      for (let c = channels.length; c < components; c++) {
        for (let i = 0; i < S3; i += 997) assert.equal(r.data[i * components + c], 0, 'unused component is zero');
      }
    }
  }
  // cropToVolume: stored voxels whose volume coordinate is in [−1, dim].
  const crop = await rowsOf(BL, [{ bx: 2, by: 1, bz: 0, channel: 1, lod: 0 }, { bx: 2, by: 1, bz: 0, channel: 0, lod: 0 }],
    { compose: { components: 2, channels: 2, cropToVolume: true } });
  const r = crop.rows[0];
  // x: 150 − 128 + 2 = 24, y: 100 − 64 + 2 = 38, z: the whole 66
  assert.deepEqual(plain(r.region), { x0: 0, x1: 24, y0: 0, y1: 38, z0: 0, z1: 66 });
  assert.equal(r.data.length, 24 * 38 * 66 * 2);
  const e0 = expectedBrick(0, 0, 2, 1, 0), e1 = expectedBrick(0, 1, 2, 1, 0);
  assert.ok(e1.some(v => v), 'channel 1 holds data there');
  let diff = 0;
  for (let z = 0; z < 66; z++) for (let y = 0; y < 38; y++) for (let x = 0; x < 24; x++) {
    const i = (z * 38 + y) * 24 + x, s = (z * 66 + y) * 66 + x;
    if (r.data[i * 2] !== e0[s] || r.data[i * 2 + 1] !== e1[s]) diff++;
  }
  assert.equal(diff, 0, 'cropped composed brick');
  console.log('v3 compose (4/2/1 components, LUT, cropToVolume): OK');

  // ── v2 after v3: a dataset switch back to a v2 tree still works ─────────────
  const BRICK = 64 ** 3;
  const pack = new Uint8Array(BRICK).fill(42);
  const v2files = new Map([['DATA_WEB/3d/old/bricks/lod0/c0/pack_00.bin', pack]]);
  const BL2 = loadBrickLoader(mockFetch(new Map([...tree.files, ...v2files])));
  await BL2.init(BASE, tree.manifest);
  const ret = BL2.init('DATA_WEB/3d/old/bricks', {
    levels: [{ level: 0, dimensions: { x: 64, y: 64, z: 64 }, brickSize: 64, chunks: [{ id: '0_0_0' }] }],
    channels: 1,
    brickTransport: { encoding: 'raw-u8', mode: 'packs', brickToPack: { 'lod0/c0/x000_y000_z000.webp': { url: 'lod0/c0/pack_00.bin', offset: 0, length: BRICK } } }
  });
  assert.equal(typeof ret?.then, 'function', 'init returns a promise for v2 too');
  assert.equal(plain(BL2.getFormat()).version, 2, 'v2 mounted synchronously');
  assert.equal(plain(BL2.getFormat()).brickStride, 64);
  const v2rows = await rowsOf(BL2, [{ bx: 0, by: 0, bz: 0, channel: 0, lod: 0 }]);
  assert.equal(v2rows.rows[0].data.length, BRICK); assert.equal(v2rows.rows[0].data[123], 42);
  console.log('v2 tree after a v3 tree: OK');
}

// ── Multi-range requests ──────────────────────────────────────────────────────
// A tree whose packs hold six bricks: level 0 channel 1 stores the six bricks of the
// lower layer in ONE pack, (bz, by, bx) order. Asking bricks #0, #2 and #4 of it is
// three separated runs (50 % of the pack, below the whole-pack threshold): the first
// run is the host's range probe and goes alone, the other two leave together in one
// multi-range request.
const RBASE = 'DATA_WEB/3d/v3ranges/bricks';
const rtree = buildV3Tree({ base: RBASE, channels: 2, levels: LEVELS, value, perPack: 6 });
const PACK = `${RBASE}/l0/c1/p00000.bin`;
const rtasks = [{ bx: 0, by: 0, bz: 0 }, { bx: 2, by: 0, bz: 0 }, { bx: 1, by: 1, bz: 0 }].map(t => ({ ...t, channel: 1, lod: 0 }));
const rexpected = (r) => rtree.stored(0, 1, r.bx, r.by, r.bz);
const outcomes = {
  multipart: (reqs) => {
    assert.equal(reqs.length, 2, 'probe + one multi-range request');
    assert.ok(!reqs[0].range.includes(','), 'the probe asks one range');
    assert.equal(reqs[1].range.split(',').length, 2, 'the two other runs in one request');
  },
  first: (reqs) => {
    assert.equal(reqs.length, 3, 'probe, the multi-range request served its first range only, the second asked again');
    assert.ok(!reqs[2].range.includes(','));
  },
  coalesce: (reqs) => assert.equal(reqs.length, 2, 'one part covering both runs serves both'),
  malformed: (reqs) => {
    assert.equal(reqs.length, 4, 'probe, broken multipart, then each run alone');
    assert.ok(!reqs[2].range.includes(',') && !reqs[3].range.includes(','));
  },
  ignore: (reqs) => assert.equal(reqs.length, 1, 'the 200 answer to the probe is the whole pack, every run read from it')
};
for (const mode of Object.keys(outcomes)) {
  const fetchImpl = mockFetch(rtree.files, { mode });
  const BL = loadBrickLoader(fetchImpl);
  await BL.init(RBASE, rtree.manifest);
  fetchImpl.log.length = 0;
  const got = await rowsOf(BL, rtasks, { byteRanges: true });
  assert.equal(got.summary.delivered, rtasks.length, `${mode}: every brick delivered`);
  for (const r of got.rows) sameBytes(r.data, rexpected(r), `${mode}: brick ${r.bx},${r.by},${r.bz}`);
  const reqs = fetchImpl.log.filter(q => q.path === PACK);
  assert.equal(fetchImpl.log.length, reqs.length, `${mode}: only that pack was asked`);
  outcomes[mode](reqs);
  const stats = BL.getCacheStats();
  assert.equal(stats.packBytes + stats.rangeBytes + stats.pendingSources, 0, `${mode}: every source released after the batch`);
  console.log(`multi-range, server answering "${mode}": OK`);
}

// The parts cap: 70 runs of one pack leave as two requests (64 + 6) after the probe.
{
  const BIGBASE = 'DATA_WEB/3d/v3many/bricks';
  // 141 bricks of one channel in one pack (grid 141 × 1 × 1), every other one asked.
  const big = buildV3Tree({ base: BIGBASE, channels: 1, levels: [{ dims: { x: 141 * 64, y: 64, z: 64 }, voxelSize: { x: 1, y: 1, z: 1 } }], value: (k, c, x, y, z) => ((x >> 6) * 3 + y + z) % 255 + 1, perPack: 141 });
  const fetchImpl = mockFetch(big.files);
  const BL = loadBrickLoader(fetchImpl);
  await BL.init(BIGBASE, big.manifest);
  fetchImpl.log.length = 0;
  const tasks = [];
  for (let i = 0; i < 71; i++) tasks.push({ bx: 2 * i, by: 0, bz: 0, channel: 0, lod: 0, region: { x0: 0, x1: 66, y0: 0, y1: 1, z0: 0, z1: 1 } });
  const got = await rowsOf(BL, tasks, { byteRanges: true, concurrency: 96 });
  assert.equal(got.summary.delivered, 71);
  for (const r of got.rows) assert.equal(r.data[1], big.stored(0, 0, r.bx, 0, 0)[1], `brick ${r.bx}`);
  const counts = fetchImpl.log.map(q => q.range.split(',').length);
  assert.deepEqual(counts, [1, 64, 6], `requests carry ${JSON.stringify(counts)} ranges`);
  assert.ok(fetchImpl.log.every(q => q.range.length < 8200), 'Range header within ~8 KB');
  console.log('multi-range caps (64 parts per request): OK');
}

// A host whose multipart answer could not be used is asked one range per request from then on.
{
  const fetchImpl = mockFetch(rtree.files, { mode: 'malformed' });
  const BL = loadBrickLoader(fetchImpl);
  await BL.init(RBASE, rtree.manifest);
  await rowsOf(BL, rtasks, { byteRanges: true });
  fetchImpl.log.length = 0;
  const more = [{ bx: 1, by: 0, bz: 0 }, { bx: 0, by: 1, bz: 0 }, { bx: 2, by: 1, bz: 0 }].map(t => ({ ...t, channel: 1, lod: 0 }));
  const got = await rowsOf(BL, more, { byteRanges: true });
  assert.equal(got.summary.delivered, 3);
  assert.ok(fetchImpl.log.every(q => !q.range || !q.range.includes(',')), 'no more multi-range requests to that host');
  console.log('multi-range: a host with a broken multipart answer is not asked again: OK');
}

// A host answering a multi-range request with the whole pack (a range-count cap): the
// pack is used, multi-range requests stop, single ranges stay planned on that host.
{
  const fetchImpl = mockFetch(rtree.files, { mode: 'multi200' });
  const BL = loadBrickLoader(fetchImpl);
  await BL.init(RBASE, rtree.manifest);
  fetchImpl.log.length = 0;
  const got = await rowsOf(BL, rtasks, { byteRanges: true });
  assert.equal(got.summary.delivered, 3);
  for (const r of got.rows) sameBytes(r.data, rexpected(r), `multi200: brick ${r.bx},${r.by},${r.bz}`);
  assert.equal(fetchImpl.log.length, 2, 'probe + the multi-range request answered whole');
  fetchImpl.log.length = 0;
  // One brick of another pack (level 0 channel 0, a sixth of it): still a single range.
  const g = await rowsOf(BL, [{ bx: 0, by: 0, bz: 0, channel: 0, lod: 0 }], { byteRanges: true });
  assert.equal(g.summary.delivered, 1);
  assert.ok(fetchImpl.log.length >= 1 && fetchImpl.log.every(q => !q.range || !q.range.includes(',')), 'no multi-range request any more');
  assert.ok(fetchImpl.log.some(q => q.range), "single ranges still asked of that host");
  console.log('multi-range answered 200: single ranges kept for the host: OK');
}

// configure({ multiRange: 'off' }) on a v3 tree: one range per request.
{
  const fetchImpl = mockFetch(rtree.files);
  const BL = loadBrickLoader(fetchImpl);
  BL.configure({ multiRange: 'off' });
  await BL.init(RBASE, rtree.manifest);
  fetchImpl.log.length = 0;
  const got = await rowsOf(BL, rtasks, { byteRanges: true });
  assert.equal(got.summary.delivered, 3);
  for (const r of got.rows) sameBytes(r.data, rexpected(r), `off: brick ${r.bx},${r.by},${r.bz}`);
  // Without multi-range the v2 planning applies: runs merged across gaps up to 512 KB,
  // here into one run covering 5/6 of the pack, so the pack is fetched whole.
  assert.equal(fetchImpl.log.length, 1, 'one request');
  assert.equal(fetchImpl.log[0].range, null, 'the whole pack');
  console.log('multi-range off: OK');
}

// ── multipart/byteranges parser on hand-made bodies ───────────────────────────
{
  const BL = loadBrickLoader(mockFetch(new Map()));
  const file = new Uint8Array(300).map((_, i) => (i * 7) & 255);
  // A payload that contains the boundary itself: the parser cuts by Content-Range length.
  const bnd = 'XyZ';
  file.set(new TextEncoder().encode('\r\n--XyZ\r\n'), 20);
  const { body, contentType } = multipartBody([[10, 40], [100, 120], [299, 299]], file, bnd);
  const parts = BL._parseMultipartByteranges(body, contentType);
  assert.equal(parts.length, 3);
  assert.deepEqual(plain(parts.map(p => [p.start, p.end])), [[10, 41], [100, 121], [299, 300]]);
  sameBytes(parts[0].bytes, file.subarray(10, 41), 'part with the boundary inside its bytes');
  sameBytes(parts[2].bytes, file.subarray(299, 300), 'one-byte part');
  // LF-only line breaks, quoted boundary, no leading line break.
  const lf = new TextEncoder().encode('--"q"\nContent-Range: bytes 0-2/300\n\nabc\n--"q"--\n'.replace(/"q"/g, 'q'));
  const p2 = BL._parseMultipartByteranges(lf, 'multipart/byteranges; boundary="q"');
  assert.equal(new TextDecoder().decode(p2[0].bytes), 'abc');
  const bad = (text, ct, re, label) => assert.throws(() => BL._parseMultipartByteranges(new TextEncoder().encode(text), ct), re, label);
  bad('--q\r\nContent-Type: x\r\n\r\nabc\r\n--q--', 'multipart/byteranges; boundary=q', /without a Content-Range/, 'no Content-Range');
  bad('--q\r\nContent-Range: bytes 0-49/300\r\n\r\nabc\r\n--q--', 'multipart/byteranges; boundary=q', /shorter/, 'short part');
  bad('--q\r\nContent-Range: bytes 0-2/300\r\n\r\nabcdef\r\n--q--', 'multipart/byteranges; boundary=q', /delimiter expected/, 'part longer than announced');
  bad('--q\r\nContent-Range: bytes 5-2/300\r\n\r\nabc\r\n--q--', 'multipart/byteranges; boundary=q', /malformed Content-Range/, 'inverted range');
  bad('abc', 'multipart/byteranges', /boundary/, 'no boundary parameter');
  bad('nothing here', 'multipart/byteranges; boundary=q', /without a delimiter/, 'no delimiter');
  assert.deepEqual(plain(BL._parseContentRange('bytes 3-9/100')), { start: 3, end: 10 });
  assert.equal(BL._parseContentRange('bytes 3-100/100'), null, 'last byte past the length');
  console.log('multipart/byteranges parser (well-formed and malformed bodies): OK');
}

// ── Cancellation: a slow server, an aborted batch, every source released ─────
{
  const fetchImpl = mockFetch(tree.files, { delay: 30 });
  const BL = loadBrickLoader(fetchImpl);
  await BL.init(BASE, tree.manifest);
  const ac = new AbortController();
  const tasks = allTasks(0, [0, 1]);
  const pending = BL.loadBrickTasks(tasks, { signal: ac.signal, streamOnly: true, byteRanges: true });
  setTimeout(() => ac.abort(), 5);
  const res = await pending;
  assert.equal(res.summary.cancelled, true);
  assert.equal(res.summary.delivered + res.summary.failed.length + res.summary.skipped.length, tasks.length, 'every task accounted for');
  await new Promise(r => setTimeout(r, 80));
  const stats = BL.getCacheStats();
  assert.equal(stats.packBytes + stats.rangeBytes, 0, 'nothing held after the cancelled batch');
  assert.equal(stats.liveBatches, 0);
  console.log('v3 cancellation releases every source: OK');
}

// ── A batch started before the index landed waits for the v3 mount ───────────
{
  const fetchImpl = mockFetch(tree.files, { delay: 15 });
  const BL = loadBrickLoader(fetchImpl);
  BL.init(BASE, tree.manifest);
  const got = await rowsOf(BL, [{ bx: 1, by: 0, bz: 0, channel: 0, lod: 1 }]);
  assert.equal(got.summary.delivered, 1);
  sameBytes(got.rows[0].data, expectedBrick(1, 0, 1, 0, 0), 'brick of the pending mount');
  console.log('loadBrickTasks waits for a pending v3 init: OK');
}

// ── Tasks planned on one tree never run on another mounted meanwhile ──────────
{
  const fetchImpl = mockFetch(new Map([...tree.files, ...rtree.files]), { delay: 15 });
  const BL = loadBrickLoader(fetchImpl);
  await BL.init(BASE, tree.manifest);
  // A same-dataset-agnostic remount is pending (another tree's index in flight).
  const pendingOther = BL.init(RBASE, rtree.manifest);
  await assert.rejects(
    BL.loadBrickTasks([{ bx: 0, by: 0, bz: 0, channel: 0, lod: 0 }], { streamOnly: true, manifest: tree.manifest }),
    (err) => err.code === 'BRICKS_MOUNT_CHANGED',
    'a batch naming its tree refuses the tree mounted while it waited');
  await pendingOther;
  const ok = await rowsOf(BL, [{ bx: 0, by: 0, bz: 0, channel: 1, lod: 0 }], { manifest: rtree.manifest });
  assert.equal(ok.summary.delivered, 1, 'the mounted tree named: delivered');
  // brickLocation names the pack of a brick, null for an absent one.
  const loc = plain(BL.brickLocation({ bx: 0, by: 0, bz: 0, channel: 1, lod: 0 }));
  assert.match(loc.url, /^l0\/c1\/p\d{5}\.bin$/);
  assert.equal(loc.length, BL.taskBytes({ bx: 0, by: 0, bz: 0, channel: 1, lod: 0 }));
  assert.equal(BL.brickLocation({ bx: 2, by: 1, bz: 1, channel: 0, lod: 0 }), null);
  console.log('loadBrickTasks({ manifest }) refuses a tree mounted meanwhile; brickLocation: OK');
}

// A cached index is reused only for a manifest describing the same grids.
{
  const BL = loadBrickLoader(mockFetch(tree.files));
  await BL.init(BASE, tree.manifest);
  const other = plain(tree.manifest);
  other.levels[1].dimensions.x = 200;
  other.levels[1].gridSize.x = 4;
  await assert.rejects(BL.init('DATA_WEB/3d/v3demo/bricks/', other), /does not match/, 'same index url + sha, other grids: refused');
  console.log('cached index checked against the grids: OK');
}

// ── prefetchPacks of a v3 tree ───────────────────────────────────────────────
{
  const fetchImpl = mockFetch(tree.files);
  const BL = loadBrickLoader(fetchImpl);
  await BL.init(BASE, tree.manifest);
  BL.configure({ prefetchCacheBytes: 64 * 1024 * 1024 });
  const n = await BL.prefetchPacks(BASE, tree.manifest, 0, 0, 2);
  assert.equal(n, 2, 'two packs warmed');
  assert.equal(BL.getCacheStats().packEntries, 2);
  console.log('prefetchPacks (v3): OK');
}

// ── SHA-256 without crypto.subtle: PlaneLoader's JS digest ────────────────────
{
  const PlaneCodec = loadModule('js/core/plane-codec.js', 'PlaneCodec', { Blob, CompressionStream, DecompressionStream, Response, TextEncoder, TextDecoder });
  const PL = loadModule('js/core/plane-loader.js', 'PlaneLoader', { PlaneCodec, crypto: undefined, Response, DOMException, navigator: { hardwareConcurrency: 2 } });
  const BL = loadBrickLoader(mockFetch(tree.files), { crypto: undefined, PlaneLoader: PL });
  await BL.init(BASE, tree.manifest);
  assert.equal(plain(BL.getFormat()).version, 3, 'index verified by the JS SHA-256');
  const BL0 = loadBrickLoader(mockFetch(tree.files), { crypto: undefined });
  await assert.rejects(BL0.init(BASE, tree.manifest), /SHA-256/, 'no digest at all: refused, not trusted');
  console.log('index sha256 through the JS fallback: OK');
}

// The loader's v2 constants are untouched.
{
  const src = readFileSync(path.join(ROOT, 'js/core/brick-loader.js'), 'utf8');
  assert.ok(/const BRICK_SIZE = 64;/.test(src));
  assert.equal(createHash('sha256').update(tree.files.get(`${BASE}/index.bin`)).digest('hex'), tree.manifest.index.sha256);
}

console.log('BrickLoader v3: OK');
