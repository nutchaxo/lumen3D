// Browser handler of migration m003-layer-mips (js/migrations/m003-layer-mips.js), SPEC §12:
//   • a synthetic format-2 dataset (3d with a v2 bricks manifest, live with a v3 one whose
//     `timepoints` are { path, index } rows: the tree list comes from either), 560 × 520 × 66, 2 channels, real png-gray8 plane packs written
//     with PlaneCodec (edge tiles 48 × 8, all-zero tiles stored as length 0, a whole tile that is
//     zero in every plane of a layer, a partial last layer of 2 planes) is migrated unit by unit:
//     every layer-MIP tile decodes to EXACTLY the per-voxel max over the layer's planes;
//   • a MIP that is all zero sends no tile (count 0), the blob carries the layer index;
//   • range reads hit the `?v=`-stamped plane packs (FNV-1a of the planes manifest text, as
//     PlaneLoader), the header of a plane is read once per tree and reused by the next unit;
//   • PlaneCodec: the LMIP magic is written and read, and refused where LPLN is expected.
//
// Run: node tests/js/test_v3_bmig_m003.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT } from './harness.mjs';

const read = (p) => readFileSync(path.join(ROOT, p), 'utf8');
const plain = (v) => JSON.parse(JSON.stringify(v));

const ctx = vm.createContext({ console, setTimeout, clearTimeout, CompressionStream, DecompressionStream, Response, Blob });
vm.runInContext(read('js/core/plane-codec.js'), ctx, { filename: 'plane-codec.js' });
vm.runInContext(read('js/migrations/m003-layer-mips.js'), ctx, { filename: 'm003-layer-mips.js' });
vm.runInContext('globalThis.__PC = PlaneCodec;', ctx);
const H = ctx.LumenMigrationHandlers['m003-layer-mips'];
const PC = ctx.__PC;

// ── PlaneCodec: LMIP ──
{
  const entries = [{ offset: 40, length: 3 }, { offset: 0, length: 0 }];
  const h = PC.buildPackHeader({ channels: 1, tilesX: 2, tilesY: 1, z: 7, entries, magic: 'LMIP' });
  assert.equal(String.fromCharCode(...h.subarray(0, 4)), 'LMIP');
  const back = PC.parsePackHeader(h, 'LMIP');
  assert.equal(back.magic, 'LMIP'); assert.equal(back.z, 7);
  assert.deepEqual(plain(back.entries), entries);
  assert.equal(PC.parsePackHeader(h).magic, 'LMIP', 'either magic without an expectation');
  assert.throws(() => PC.parsePackHeader(h, 'LPLN'), /bad magic/);
  assert.throws(() => PC.buildPackHeader({ channels: 1, tilesX: 2, tilesY: 1, z: 0, entries, magic: 'XXXX' }), /magic/);
  const plane = PC.buildPackHeader({ channels: 1, tilesX: 2, tilesY: 1, z: 0, entries });
  assert.equal(String.fromCharCode(...plane.subarray(0, 4)), 'LPLN', 'default magic unchanged');
  assert.throws(() => PC.parsePackHeader(plane, 'LMIP'), /bad magic/);
}

const X = 560, Y = 520, Z = 66, C = 2, TS = 512;
const TX = Math.ceil(X / TS), TY = Math.ceil(Y / TS);

function hash(x, y, z, c) {
  let h = Math.imul(x + 1, 73856093) ^ Math.imul(y + 1, 19349663) ^ Math.imul(z + 1, 83492791) ^ Math.imul(c + 7, 2654435761);
  h = Math.imul(h ^ (h >>> 13), 0x5bd1e995);
  return (h ^ (h >>> 15)) >>> 0;
}
function voxelOf(x, y, z, c, t) {
  if (x >= TS && y >= TS) return 0;                       // corner tile: zero everywhere
  if (c === 1 && z >= 64) return 0;                       // channel 1, last layer: nothing
  if (z % 9 === 4 && x < TS) return 0;                    // some all-zero tiles in a layer
  const h = hash(x, y, z, c + 3 * t);
  return h % 11 === 0 ? (h >>> 9) & 0xFF : 0;
}
const _vols = new Map();
function volume(c, t) {
  const k = `${t}|${c}`;
  if (!_vols.has(k)) {
    const v = new Uint8Array(X * Y * Z);
    for (let z = 0, i = 0; z < Z; z++) for (let y = 0; y < Y; y++) for (let x = 0; x < X; x++, i++) v[i] = voxelOf(x, y, z, c, t);
    _vols.set(k, v);
  }
  return _vols.get(k);
}
const voxel = (x, y, z, c, t) => volume(c, t)[(z * Y + y) * X + x];

async function buildTree(t) {
  const manifestObj = {
    schema: 'lumen-planes-v1', formatVersion: 2, level: 0, dimensions: { x: X, y: Y, z: Z }, channels: C,
    tileSize: TS, tiles: { x: TX, y: TY }, codec: 'png-gray8', packPattern: 'z{z}.bin',
    headerBytes: PC.headerBytes(C, TX, TY), source: { manifestSha256: 'a'.repeat(64) }, producer: 'pipeline', createdAt: `2026-10-0${t + 1}T00:00:00Z`,
  };
  const text = JSON.stringify(manifestObj);
  const packs = new Map();
  for (let z = 0; z < Z; z++) {
    const entries = [];
    const payloads = [];
    let off = PC.headerBytes(C, TX, TY);
    for (let c = 0; c < C; c++) for (let ty = 0; ty < TY; ty++) for (let tx = 0; tx < TX; tx++) {
      const w = Math.min(TS, X - tx * TS), h = Math.min(TS, Y - ty * TS);
      const px = new Uint8Array(w * h);
      let any = false;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const v = voxel(tx * TS + x, ty * TS + y, z, c, t);
        px[y * w + x] = v; if (v) any = true;
      }
      if (!any) { entries.push({ offset: 0, length: 0 }); continue; }
      const png = await PC.encodePngGray(w, h, px);
      entries.push({ offset: off, length: png.length });
      payloads.push(png); off += png.length;
    }
    const head = PC.buildPackHeader({ channels: C, tilesX: TX, tilesY: TY, z, entries });
    const buf = new Uint8Array(off);
    buf.set(head, 0);
    let o = head.length;
    for (const p of payloads) { buf.set(p, o); o += p.length; }
    packs.set(z, buf);
  }
  return { text, packs, stamp: H._internals.fnv1a(text) };
}

async function run({ live, batched = false }) {
  const tps = live ? [0, 3] : [0];
  const trees = new Map();
  for (const t of tps) trees.set(t, await buildTree(t));
  const base = 'http://h/DATA_WEB/x/ds/';
  const bricks = live
    ? { schema: 'iribhm-bricks-v3', version: 3, timepoints: tps.map((t) => ({ path: `t${String(t).padStart(3, '0')}`, index: { url: 'index.bin', bytes: 1, sha256: '0'.repeat(64) } })) }
    : { schema: 'iribhm-bricks-v2', version: 2, timepoints: null, levels: [] };
  const ranges = [];
  const planesBase = (t) => (live ? `${base}planes/t${String(t).padStart(3, '0')}/` : `${base}planes/`);
  const ctxIo = {
    datasetBase: base,
    fetchJson: async (url) => {
      if (url === base + 'metadata.json') return {};
      if (url === base + 'bricks/manifest.json') return bricks;
      throw new Error('404 ' + url);
    },
    fetchText: async (url) => {
      for (const t of tps) if (url === planesBase(t) + 'manifest.json') return trees.get(t).text;
      throw new Error('404 ' + url);
    },
  };
  const state = await H.prepare(ctxIo);
  assert.deepEqual(plain(state.trees.map((tr) => tr.t)), tps);
  const io = {
    fetchRange: async (url, s, e) => {
      const m = /^(.*)z(\d{5})\.bin\?v=([0-9a-z]+)$/.exec(url);
      assert.ok(m, url);
      const t = tps.find((tt) => planesBase(tt) === m[1]);
      assert.ok(t !== undefined, 'tree of ' + url);
      assert.equal(m[3], trees.get(t).stamp, 'pack stamp = FNV-1a of the manifest text');
      ranges.push([t, +m[2], s, e]);
      const f = trees.get(t).packs.get(+m[2]);
      assert.ok(e <= f.length);
      return f.slice(s, e);
    },
  };
  // The worker's batched read: every run of a call in one request.
  let batches = 0;
  if (batched) io.fetchRanges = async (list) => { batches++; return Promise.all(list.map((r) => io.fetchRange(r.url, r.start, r.end))); };
  const units = H.listUnits(state);
  assert.equal(units.length, tps.length * Math.ceil(Z / 64) * C * TY * TX);
  let zeroUnits = 0;
  for (const u of units) {
    const work = H.planUnitWork(u.key, state);
    const before = ranges.length;
    const batchesBefore = batches;
    const res = await H.runUnit(work, state, io);
    if (batched) assert.ok(batches - batchesBefore <= 2, `one read for the missing headers, one for the tiles (${u.key})`);
    const { t, l, c, ty, tx } = work.unit;
    const blob = PC.parseUnitBlob(res.body);
    const w = Math.min(TS, X - tx * TS), h = Math.min(TS, Y - ty * TS);
    const exp = new Uint8Array(w * h);
    for (let z = 64 * l; z < Math.min(64 * l + 64, Z); z++) {
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const v = voxel(tx * TS + x, ty * TS + y, z, c, t);
        if (v > exp[y * w + x]) exp[y * w + x] = v;
      }
    }
    if (exp.every((v) => v === 0)) {
      assert.equal(blob.length, 0, `all-zero MIP sends nothing (${u.key})`);
      zeroUnits++;
    } else {
      assert.equal(blob.length, 1);
      assert.equal(blob[0].z, l, 'the entry carries the layer index');
      const hdr = PC.readPngHeader(blob[0].png);
      assert.deepEqual([hdr.width, hdr.height, hdr.bitDepth, hdr.colorType], [w, h, 8, 0]);
      const d = await PC.decodePngGray(blob[0].png);
      assert.ok(Buffer.from(d.data).equals(Buffer.from(exp)), `MIP pixels of ${u.key}`);
      // filter None on every row: the inflated rows start with 0
      assert.equal(res.tiles, 1);
    }
    // header reads: only for planes whose header this tree had not read yet
    const headerReads = ranges.slice(before).filter((r) => r[2] === 0).length;
    if (u.key !== units[0].key && c + ty + tx > 0) assert.equal(headerReads, 0, `headers cached (${u.key})`);
  }
  assert.ok(zeroUnits >= tps.length * 2, `zero MIPs (${zeroUnits})`);
  // every header fetched exactly once per tree and plane
  const heads = ranges.filter((r) => r[2] === 0).map((r) => `${r[0]}:${r[1]}`);
  assert.equal(new Set(heads).size, heads.length, 'one header read per plane');
  assert.equal(heads.length, tps.length * Z);
  return units.length;
}

const n3 = await run({ live: false });
const nl = await run({ live: true });
await run({ live: false, batched: true });
await run({ live: true, batched: true });

// unit keys
assert.equal(H._internals.unitKey(2, 1, 0, 3, 4), 't2.l1.c0.y3.x4');
assert.deepEqual(plain(H._internals.parseUnitKey('t2.l1.c0.y3.x4')), { t: 2, l: 1, c: 0, ty: 3, tx: 4 });
assert.throws(() => H._internals.parseUnitKey('t0.z1.c0.y0.x0'), /bad unit key/);
assert.deepEqual(plain(await H.probe()), { available: true, reasons: [] });
assert.equal(H.slotsPerWorker, 2);

console.log(`m003-layer-mips handler: OK (${n3} + ${nl} units)`);
