// Format 5 on the reading side (DOCS/dataset-migrations/SPEC.md §14):
//   • BrickLoader validates a v5 tree manifest (columns, LUTs, every plane kept, one index
//     per column) and refuses a malformed one;
//   • a v5 mount reads `index/ll.bin` at init and another column's index on first use
//     (ensureColumns / loadBrickTasks), each column's packs stamped with its own index
//     sha256; taskBytes / brickLocation follow the task's column;
//   • a lossy-column brick decodes by its trailer byte: 0..12 = WebP lossy on the 80-px
//     pitch with the dead zone as a value LUT, 0xFE = the b4 image through b4's LUT,
//     0xFF = the ll image; anything else is refused; value LUT ∘ display LUT is one table;
//   • CutStore reads an XZ row as three ranges (header, the row's entries, its tiles) and
//     merges cut-brick runs into multi-range requests (multipart/byteranges answers);
//   • DataAccess converts µm ↔ voxels of any level and locates a native voxel's bytes.
//
// Run: node tests/js/test_format5_reader.mjs
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { loadModule } from './harness.mjs';

const plain = (o) => JSON.parse(JSON.stringify(o));
const sha = (u8) => createHash('sha256').update(u8).digest('hex');

// ── LBIX builder: levels [[gx, gy, gz, packCount]], entries[level][channel] = Map(i → [pack, off, len]) ──
function lbix(levels, channels, entries) {
  const head = 12 + 16 * levels.length;
  let total = head;
  for (const [gx, gy, gz] of levels) total += 10 * channels * gx * gy * gz;
  const u8 = new Uint8Array(total);
  const dv = new DataView(u8.buffer);
  u8.set([76, 66, 73, 88]);
  dv.setUint16(4, 1, true); dv.setUint16(6, levels.length, true); dv.setUint16(8, channels, true);
  levels.forEach(([gx, gy, gz, pc], k) => { dv.setUint32(12 + 16 * k, gx, true); dv.setUint32(16 + 16 * k, gy, true); dv.setUint32(20 + 16 * k, gz, true); dv.setUint32(24 + 16 * k, pc, true); });
  let at = head;
  levels.forEach(([gx, gy, gz], k) => {
    for (let c = 0; c < channels; c++) {
      const m = entries[k][c] || new Map();
      for (let i = 0; i < gx * gy * gz; i++) {
        const e = m.get(i);
        if (e) { dv.setUint16(at, e[0], true); dv.setUint32(at + 2, e[1], true); dv.setUint32(at + 6, e[2], true); }
        at += 10;
      }
    }
  });
  return u8;
}

const LUT_B2 = Array.from({ length: 256 }, (_, i) => (i === 0 ? 0 : Math.min(255, 1 + 5 * (i - 1) + 2)));
const LUT_B4 = Array.from({ length: 256 }, (_, i) => (i === 0 ? 0 : Math.min(255, 1 + 9 * (i - 1) + 4)));

function makeTree() {
  // Two levels (130×70×10 native, 64×35×10), one channel; ll stores bricks (0,0,0) and (1,0,0)
  // of level 0 and (0,0,0) of level 1; b2 the same bricks with other sizes.
  const levels = [[3, 2, 1, 1], [1, 1, 1, 1]];
  const ll = lbix(levels, 1, [[new Map([[0, [0, 0, 100]], [1, [0, 100, 50]]])], [new Map([[0, [0, 0, 30]]])]]);
  const b2 = lbix(levels, 1, [[new Map([[0, [0, 0, 70]], [1, [0, 70, 20]]])], [new Map([[0, [0, 0, 10]]])]]);
  const files = { 'index/ll.bin': ll, 'index/b2.bin': b2 };
  const cols = [
    { id: 'll', codec: 'webp-lossless', mosaic: 'grid66', maxError: 0 },
    { id: 'b2', codec: 'webp-lossless-lut', mosaic: 'grid66', maxError: 2, lut: LUT_B2 },
    { id: 'b4', codec: 'webp-lossless-lut', mosaic: 'grid66', maxError: 4, lut: LUT_B4 },
    { id: 'q80', codec: 'webp-lossy-dz', mosaic: 'grid80', quality: 80, maxError: null }
  ];
  const ref = (u8, url) => ({ url, bytes: u8.length, sha256: sha(u8) });
  const manifest = {
    schema: 'iribhm-bricks-v5', version: 5, formatVersion: 5, channels: 1, brickSize: 64, apron: 1,
    levels: [
      { level: 0, target: 'native', dimensions: { x: 130, y: 70, z: 10 }, voxelSize: { x: 0.5, y: 0.5, z: 2 }, gridSize: { x: 3, y: 2, z: 1 }, brickCount: 2 },
      { level: 1, target: 256, dimensions: { x: 64, y: 35, z: 10 }, voxelSize: { x: 0.5 * 130 / 64, y: 1, z: 2 }, gridSize: { x: 1, y: 1, z: 1 }, brickCount: 1 }
    ],
    columns: cols,
    index: { columns: { ll: ref(ll, 'index/ll.bin'), b2: ref(b2, 'index/b2.bin'), b4: ref(b2, 'index/b4.bin'), q80: ref(b2, 'index/q80.bin') }, cuts: [] },
    timepoints: null, histograms: []
  };
  files['index/b4.bin'] = b2;
  files['index/q80.bin'] = b2;
  return { manifest, files };
}

function makeLoader(files) {
  const requests = [];
  const fetchImpl = async (url) => {
    const rel = String(url).split('/bricks/')[1].split('?')[0];
    requests.push(String(url).split('/bricks/')[1]);
    const u8 = files[rel];
    if (!u8) return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
    return { ok: true, status: 200, arrayBuffer: async () => u8.slice().buffer };
  };
  const BL = loadModule('js/core/brick-loader.js', 'BrickLoader', {
    document: { createElement: () => ({ getContext: () => ({}) }) },
    navigator: { hardwareConcurrency: 2 },
    performance: { now: () => Date.now() },
    window: {},
    crypto: globalThis.crypto,
    AbortController: globalThis.AbortController,
    DOMException: globalThis.DOMException,
    fetch: fetchImpl,
  });
  return { BL, requests };
}

// ── T1: validation ───────────────────────────────────────────────────────────
{
  const { manifest, files } = makeTree();
  const { BL } = makeLoader(files);
  BL._validateManifest(manifest);
  const bad = (mut, why) => {
    const m = JSON.parse(JSON.stringify(manifest));
    mut(m);
    assert.throws(() => BL._validateManifest(m), undefined, why);
  };
  bad(m => { m.columns = m.columns.filter(c => c.id !== 'll'); delete m.index.columns.ll; }, 'no lossless column');
  bad(m => { m.columns[1].lut = m.columns[1].lut.slice(1); }, 'a LUT of 255 entries');
  bad(m => { m.columns[1].codec = 'avif'; }, 'an unknown codec');
  bad(m => { m.levels[1].dimensions.z = 5; }, 'a level that dropped planes');
  bad(m => { m.levels[1].target = 300; m.levels[1].target = 'big'; }, 'a target that is neither native nor a number');
  bad(m => { delete m.index.columns.b2; }, 'a column without its index');
  bad(m => { m.index = { url: 'index.bin' }; }, 'a dataset manifest of a timelapse mounted as a tree');
  console.log('v5 manifest validation: OK');
}

// ── T2: mount, lazy column index, per-column pack urls ─────────────────────────
{
  const { manifest, files } = makeTree();
  const { BL, requests } = makeLoader(files);
  await BL.init('DATA_WEB/3d/F/bricks', manifest);
  assert.deepEqual(requests, [`index/ll.bin?v=${sha(files['index/ll.bin']).slice(0, 12)}`], 'only the ll index at mount');
  const fmt = BL.getFormat();
  assert.equal(fmt.version, 5);
  assert.equal(fmt.brickStride, 66);
  assert.deepEqual(plain(fmt.columns.map(c => c.id)), ['ll', 'b2', 'b4', 'q80']);
  assert.equal(BL.getLevelInfo(1).target, 256);
  assert.equal(BL.taskBytes({ lod: 0, channel: 0, bx: 1, by: 0, bz: 0 }), 50, 'll is the default column');
  assert.equal(BL.taskBytes({ lod: 0, channel: 0, bx: 1, by: 0, bz: 0, column: 'b2' }), 0, 'b2 unknown before its index');
  await BL.ensureColumns(['b2']);
  assert.equal(BL.taskBytes({ lod: 0, channel: 0, bx: 1, by: 0, bz: 0, column: 'b2' }), 20);
  const loc = BL.brickLocation({ lod: 0, channel: 0, bx: 1, by: 0, bz: 0, column: 'b2' });
  assert.equal(loc.url, `l0/b2/c0/p00000.bin?v=${sha(files['index/b2.bin']).slice(0, 12)}`, 'pack path and stamp of the column');
  assert.equal(BL.brickLocation({ lod: 1, channel: 0, bx: 0, by: 0, bz: 0 }).url, `l1/ll/c0/p00000.bin?v=${sha(files['index/ll.bin']).slice(0, 12)}`);
  await assert.rejects(BL.ensureColumns(['zz']), /does not exist/, 'an unknown column is refused');
  console.log('v5 mount and columns: OK');
}

// ── T3: trailer byte and LUT chaining ─────────────────────────────────────────
{
  const { manifest, files } = makeTree();
  const { BL } = makeLoader(files);
  await BL.init('DATA_WEB/3d/F/bricks', manifest);
  // The mount is internal: _v5Payload takes it; build the same shape through a load of
  // getFormat-equivalent data: call through a fake mount object mirroring _makeMountV5.
  const mount = {
    packing: { mode: 'grid', cols: 9, rows: 8, slice: 66 },
    b4Lut: Uint8Array.from(LUT_B4),
    columns: new Map(manifest.columns.map(spec => [spec.id, { spec, lut: spec.lut ? Uint8Array.from(spec.lut) : null }]))
  };
  const img = (tag) => { const u = new Uint8Array([1, 2, 3, 4, tag]); return u.buffer; };
  const lossy = BL._v5Payload(mount, { column: 'q80', rel: 'x' }, img(5));
  assert.equal(new Uint8Array(lossy.bytes).length, 4, 'the trailer byte is stripped');
  assert.equal(lossy.packing.pitch, 80);
  assert.equal(lossy.packing.origin, 7);
  assert.deepEqual(plain(lossy.expect), { width: 720, height: 640 });
  assert.equal(lossy.valueLut[5], 0, 'dead zone: τ itself goes to 0');
  assert.equal(lossy.valueLut[6], 6, 'above τ: unchanged');
  assert.equal(BL._v5Payload(mount, { column: 'q80', rel: 'x' }, img(0)).valueLut, null, 'τ = 0: no LUT');
  const fb4 = BL._v5Payload(mount, { column: 'q80', rel: 'x' }, img(0xFE));
  assert.deepEqual(plain(fb4.expect), { width: 594, height: 528 });
  assert.equal(fb4.packing.pitch, undefined, 'a b4 fallback is a 66-pitch mosaic');
  assert.equal(fb4.valueLut[3], LUT_B4[3], 'decoded through b4\'s LUT');
  const fll = BL._v5Payload(mount, { column: 'q80', rel: 'x' }, img(0xFF));
  assert.equal(fll.valueLut, null, 'an ll fallback is the stored value');
  assert.throws(() => BL._v5Payload(mount, { column: 'q80', rel: 'x' }, img(40)), /neither a dead zone nor a fallback/);
  const b2 = BL._v5Payload(mount, { column: 'b2', rel: 'x' }, img(9));
  assert.equal(new Uint8Array(b2.bytes).length, 5, 'a lossless-LUT brick keeps every byte');
  assert.equal(b2.valueLut[2], LUT_B2[2]);
  const display = Uint8Array.from({ length: 256 }, (_, v) => 255 - v);
  const chained = BL._chainLuts(b2.valueLut, display);
  for (const v of [0, 1, 2, 50, 255]) assert.equal(chained[v], 255 - LUT_B2[v], 'value LUT first, then the display LUT');
  assert.equal(BL._chainLuts(null, display), display);
  console.log('v5 trailer and LUTs: OK');
}

// ── T4: CutStore — an XZ row in three ranges, cut-brick runs in multi-range requests ──
{
  const PlaneCodec = loadModule('js/core/plane-codec.js', 'PlaneCodec', { CompressionStream: globalThis.CompressionStream, DecompressionStream: globalThis.DecompressionStream, Blob: globalThis.Blob, Response: globalThis.Response });
  // One xz pack of 3 rows (first 64) of a 600 × 5 (x × z) level: tiles 2 (along x) × 1 (z).
  const W = 600, Z = 5;
  const rows = [0, 1, 2].map(r => { const a = new Uint8Array(W * Z); for (let i = 0; i < a.length; i++) a[i] = (i * 7 + r * 31) & 0xFF; return a; });
  rows[1].fill(0);
  const tilesOf = (img) => Promise.all([0, 1].map(async ta => {
    const w = Math.min(512, W - ta * 512);
    const t = new Uint8Array(w * Z);
    for (let z = 0; z < Z; z++) t.set(img.subarray(z * W + ta * 512, z * W + ta * 512 + w), z * w);
    return t.some(v => v) ? await PlaneCodec.encodePngGray(w, Z, t) : new Uint8Array(0);
  }));
  const allTiles = await Promise.all(rows.map(tilesOf));
  const head = 20 + 12 * 3 * 2;
  const total = head + allTiles.flat().reduce((s, t) => s + t.length, 0);
  const pack = new Uint8Array(total);
  const dv = new DataView(pack.buffer);
  pack.set([76, 80, 88, 90]);
  dv.setUint16(4, 1, true); dv.setUint16(6, 2, true); dv.setUint16(8, 1, true); dv.setUint32(12, 64, true); dv.setUint32(16, 3, true);
  let off = head, e = 20;
  for (const ts of allTiles) for (const t of ts) {
    dv.setBigUint64(e, BigInt(t.length ? off : 0), true); dv.setUint32(e + 8, t.length, true); e += 12;
    pack.set(t, off); off += t.length;
  }
  const requests = [];
  const files = { 'xz/l0/c0/b00001.bin': pack };
  const fetchImpl = async (url, init = {}) => {
    const rel = String(url).split('/bricks/')[1].split('?')[0];
    const range = init.headers?.Range;
    requests.push(range || 'whole');
    const u8 = files[rel];
    if (!range) return { ok: true, status: 200, headers: { get: () => '' }, arrayBuffer: async () => u8.slice().buffer };
    const parts = range.slice(6).split(',').map(p => p.split('-').map(Number));
    if (parts.length === 1) return { ok: true, status: 206, headers: { get: (h) => (h === 'Content-Range' ? `bytes ${parts[0][0]}-${parts[0][1]}/${u8.length}` : '') }, arrayBuffer: async () => u8.slice(parts[0][0], parts[0][1] + 1).buffer };
    const enc = new TextEncoder();
    const chunks = [];
    for (const [a, b] of parts) {
      chunks.push(enc.encode(`\r\n--B\r\nContent-Type: application/octet-stream\r\nContent-Range: bytes ${a}-${b}/${u8.length}\r\n\r\n`));
      chunks.push(u8.slice(a, b + 1));
    }
    chunks.push(enc.encode('\r\n--B--\r\n'));
    const body = new Uint8Array(chunks.reduce((s, c) => s + c.length, 0));
    let at = 0;
    for (const c of chunks) { body.set(c, at); at += c.length; }
    return { ok: true, status: 206, headers: { get: (h) => (h === 'Content-Type' ? 'multipart/byteranges; boundary=B' : '') }, arrayBuffer: async () => body.buffer };
  };
  const { BL } = makeLoader({});
  const CS = loadModule('js/core/cut-store.js', 'CutStore', {
    fetch: fetchImpl, PlaneCodec, BrickLoader: BL, URL, Blob: globalThis.Blob, OffscreenCanvas: undefined, createImageBitmap: undefined
  });
  const tree = CS.open('DATA_WEB/3d/F/bricks', {
    schema: 'iribhm-bricks-v5',
    levels: [{ level: 0, dimensions: { x: W, y: 300, z: Z } }],
    index: { columns: { ll: { url: 'index/ll.bin', sha256: 'a'.repeat(64) } }, cuts: [] }
  });
  for (const r of [0, 1, 2]) {
    requests.length = 0;
    const got = await tree.orthRow('xz', 0, 0, 64 + r);
    assert.equal(got.width, W);
    assert.equal(got.height, Z);
    assert.deepEqual(Array.from(got.data), Array.from(rows[r]), `row ${r} decoded`);
    assert.ok(requests.length <= 3, `row ${r}: at most three range reads (${requests.length})`);
  }
  const runs = await tree.readRuns('xz/l0/c0/b00001.bin', [{ start: 0, end: 4 }, { start: 100, end: 120 }, { start: 200, end: 210 }]);
  assert.deepEqual(Array.from(runs.get(100)), Array.from(pack.subarray(100, 120)), 'a multipart answer sliced per run');
  assert.equal(requests[requests.length - 1].split(',').length, 3, 'three runs, one request');
  console.log('CutStore xz row and multi-range runs: OK');

  // The same rows decoded through the worker pool (js/workers/cut-decode-worker.js, which
  // loads plane-codec.js and cut-store.js itself), run here in a vm behind a Worker stand-in.
  const { readFileSync } = await import('node:fs');
  const vmMod = await import('node:vm');
  const pathMod = await import('node:path');
  const root = pathMod.resolve(pathMod.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', '..');
  let handled = 0;
  class FakeWorker {
    constructor() {
      const ctx = vmMod.createContext({ console, URL, Blob: globalThis.Blob, Response: globalThis.Response,
        DecompressionStream: globalThis.DecompressionStream, CompressionStream: globalThis.CompressionStream, BigInt,
        location: { href: 'http://x/js/workers/cut-decode-worker.js' } });
      ctx.self = ctx;
      ctx.importScripts = (...files) => { for (const f of files) vmMod.runInContext(readFileSync(pathMod.join(root, 'js', f.replace(/^\.\.\//, '').split('?')[0]), 'utf8') + '\n;globalThis.PlaneCodec = typeof PlaneCodec !== "undefined" ? PlaneCodec : globalThis.PlaneCodec; globalThis.CutStore = typeof CutStore !== "undefined" ? CutStore : globalThis.CutStore;', ctx); };
      ctx.postMessage = (m) => setTimeout(() => this.onmessage?.({ data: m }), 0);
      vmMod.runInContext(readFileSync(pathMod.join(root, 'js/workers/cut-decode-worker.js'), 'utf8'), ctx);
      this._ctx = ctx;
    }
    postMessage(m) { handled++; setTimeout(() => this._ctx.onmessage({ data: m }), 0); }
  }
  const CSW = loadModule('js/core/cut-store.js', 'CutStore', {
    fetch: fetchImpl, PlaneCodec, BrickLoader: BL, URL, Blob: globalThis.Blob, OffscreenCanvas: undefined, createImageBitmap: undefined,
    Worker: FakeWorker, document: { querySelector: () => null }, navigator: { hardwareConcurrency: 4 }
  });
  const treeW = CSW.open('DATA_WEB/3d/F/bricks', {
    schema: 'iribhm-bricks-v5',
    levels: [{ level: 0, dimensions: { x: W, y: 300, z: Z } }],
    index: { columns: { ll: { url: 'index/ll.bin', sha256: 'a'.repeat(64) } }, cuts: [] }
  });
  for (const r of [0, 2]) {
    const got = await treeW.orthRow('xz', 0, 0, 64 + r);
    assert.deepEqual(Array.from(got.data), Array.from(rows[r]), `row ${r} decoded in the worker pool`);
  }
  assert.ok(handled >= 3, `the pool decoded the tiles (${handled} jobs)`);
  console.log('CutStore decode pool: OK');
}

// ── T5: DataAccess frames and locate ──────────────────────────────────────────
{
  const levels = {
    0: { level: 0, dims: { x: 130, y: 70, z: 10 }, voxelSize: { x: 0.5, y: 0.5, z: 2 } },
    1: { level: 1, dims: { x: 64, y: 35, z: 10 }, voxelSize: null }
  };
  const BrickLoader = {
    isReady: () => true,
    getLevelInfo: (k) => levels[k] || null,
    getFormat: () => ({ version: 5, channels: 1, apron: 1, columns: [{ id: 'll' }] }),
    brickLocation: (t) => (t.bx === 1 && t.column === 'll' ? { url: 'l0/ll/c0/p00000.bin?v=abc', offset: 100, length: 50 } : null)
  };
  const DA = loadModule('js/core/data-access.js', 'DataAccess', { BrickLoader, VolumeViewer: {} });
  const v1 = DA.voxelSize(1);
  assert.ok(Math.abs(v1.x - 0.5 * 130 / 64) < 1e-12 && Math.abs(v1.y - 0.5 * 70 / 35) < 1e-12 && v1.z === 2, 'level voxel from level 0 and the dimensions');
  const um = DA.toUm({ x: 100, y: 20, z: 3 });
  assert.deepEqual(plain(um), { x: 50, y: 10, z: 6 });
  const back = DA.toVoxel(um, { level: 1 });
  assert.ok(Math.abs(back.x - 50 / v1.x) < 1e-9 && Math.abs(back.z - 3) < 1e-12);
  const loc = DA.locate({ x: 100.7, y: 20, z: 3 });
  assert.deepEqual(plain(loc.brick), { bx: 1, by: 0, bz: 0 });
  assert.deepEqual(plain(loc.inBrick), { x: 36, y: 20, z: 3 });
  assert.deepEqual(plain(loc.pack), { url: 'l0/ll/c0/p00000.bin', offset: 100, length: 50 });
  assert.equal(loc.plane.url, 'planes/z00003.bin');
  assert.throws(() => DA.locate({ x: 200, y: 0, z: 0 }), /outside/);
  assert.equal(DA.locate({ x: 5, y: 5, z: 0 }).pack, null, 'a brick of zeros has no bytes');
  console.log('DataAccess frames and locate: OK');
}
