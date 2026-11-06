// A shared, cached read (a v5/v6 column index, a cut index, an XZ/YZ pack head, a plane
// header) runs under no caller's signal, so it carries its own deadline: a server that
// accepts the connection and never answers fails the read after `fetchStallMs` with a
// coded stall, the cache entry is dropped, and the next caller fetches again instead of
// waiting on the dead request for good.
//   • BrickLoader: the q30 index of a v6 tree hangs; batch A is cancelled by its caller,
//     batch B (waiting on the same index) fails with BRICKS_FETCH_STALL instead of
//     hanging, batch C fetches the index again and loads;
//   • CutStore: a cut index and an XZ pack head that hang fail with CUT_FETCH_STALL, and
//     the next read fetches them again;
//   • PlaneLoader: a plane header that hangs fails with PLANES_STALL and is fetched again;
//     on a host without Range, the whole pack a header needs is read under the caller's
//     signal, so cancelling the caller stops that download.
//
// Run: node tests/js/test_shared_fetch_stall.mjs
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { loadModule } from './harness.mjs';
import { buildTree, mockFetch as planeFetch, loadPlaneLoader, PlaneCodec } from './test_mig_reader_plane_loader.mjs';

const sha = (u8) => createHash('sha256').update(u8).digest('hex');
const tick = () => new Promise((r) => setTimeout(r, 0));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const abortErr = () => new DOMException('aborted', 'AbortError');
// A request that never answers: it settles only when its signal aborts (as a browser fetch).
const hang = (signal) => new Promise((_, reject) => {
  if (signal?.aborted) { reject(abortErr()); return; }
  signal?.addEventListener('abort', () => reject(abortErr()), { once: true });
});
const STALL_MS = 1000;   // the smallest deadline the readers accept

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

// ── BrickLoader: a column index that never answers ───────────────────────────
{
  const levels = [[2, 1, 1, 1]];
  const ll = lbix(levels, 2, [[new Map([[0, [0, 0, 100]]]), new Map()]]);
  const q30 = lbix(levels, 2, [[new Map([[0, [0, 0, 40]]]), new Map()]]);
  const files = { 'index/ll.bin': ll, 'index/q30.bin': q30 };
  const ref = (u8, url) => ({ url, bytes: u8.length, sha256: sha(u8) });
  const manifest = {
    schema: 'iribhm-bricks-v6', version: 6, formatVersion: 6, channels: 2, brickSize: 64, apron: 1,
    levels: [{ level: 0, target: 'native', dimensions: { x: 100, y: 50, z: 10 }, voxelSize: { x: 1, y: 1, z: 1 }, gridSize: { x: 2, y: 1, z: 1 }, brickCount: 1 }],
    columns: [
      { id: 'll', codec: 'webp-lossless', mosaic: 'grid66', maxError: 0 },
      { id: 'q30', codec: 'webp-lossy-dz', mosaic: 'grid80', quality: 30, maxError: null }
    ],
    index: { columns: { ll: ref(ll, 'index/ll.bin'), q30: ref(q30, 'index/q30.bin') }, cuts: [] },
    bytes: { 0: { ll: [100, 0], q30: [40, 0] } },
    timepoints: null, histograms: []
  };
  let q30Calls = 0;
  const fetchImpl = async (url, init = {}) => {
    const rel = String(url).split('/bricks/')[1].split('?')[0];
    if (rel === 'index/q30.bin' && ++q30Calls === 1) await hang(init.signal);
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
    fetch: fetchImpl
  });
  BL.configure({ fetchStallMs: STALL_MS });
  await BL.init('DATA_WEB/3d/S/bricks', manifest);
  // Channel 1 stores no brick: the q30 tasks need the index and no pack.
  const tasks = [{ lod: 0, channel: 1, bx: 0, by: 0, bz: 0, column: 'q30' }, { lod: 0, channel: 1, bx: 1, by: 0, bz: 0, column: 'q30' }];
  const ctrlA = new AbortController();
  const pA = BL.loadBrickTasks(tasks, { streamOnly: true, signal: ctrlA.signal });
  await tick();
  ctrlA.abort();
  const rA = await pA;
  assert.equal(rA.summary.cancelled, true, 'the cancelled batch resolves cancelled');
  const t0 = Date.now();
  await assert.rejects(BL.loadBrickTasks(tasks, { streamOnly: true }), (err) => err.code === 'BRICKS_FETCH_STALL',
    'a batch waiting on the dead index fails with a coded stall instead of hanging');
  assert.ok(Date.now() - t0 < STALL_MS + 1500, 'within the deadline');
  const rC = await BL.loadBrickTasks(tasks, { streamOnly: true });
  assert.equal(q30Calls, 2, 'the next batch fetches the index again');
  assert.equal(rC.summary.failed.length, 0);
  assert.equal(rC.summary.delivered + rC.summary.skipped.length, 2);
  console.log('BrickLoader: a hung shared index fails with BRICKS_FETCH_STALL and is fetched again: OK');
}

// ── CutStore: a cut index and an XZ pack head that never answer ──────────────
{
  const cutIx = lbix([[1, 1, 1, 0]], 1, [[new Map()]]);
  const W = 600, Z = 5;
  const row = new Uint8Array(W * Z);
  for (let i = 0; i < row.length; i++) row[i] = (i * 7) & 0xFF;
  const tiles = await Promise.all([0, 1].map(async ta => {
    const w = Math.min(512, W - ta * 512);
    const t = new Uint8Array(w * Z);
    for (let z = 0; z < Z; z++) t.set(row.subarray(z * W + ta * 512, z * W + ta * 512 + w), z * w);
    return PlaneCodec.encodePngGray(w, Z, t);
  }));
  const head = 20 + 12 * 2;
  const pack = new Uint8Array(head + tiles[0].length + tiles[1].length);
  const dv = new DataView(pack.buffer);
  pack.set([76, 80, 88, 90]);
  dv.setUint16(4, 1, true); dv.setUint16(6, 2, true); dv.setUint16(8, 1, true); dv.setUint32(12, 64, true); dv.setUint32(16, 1, true);
  let off = head, e = 20;
  for (const t of tiles) { dv.setBigUint64(e, BigInt(off), true); dv.setUint32(e + 8, t.length, true); e += 12; pack.set(t, off); off += t.length; }
  const manifest = {
    schema: 'iribhm-bricks-v5',
    levels: [{ level: 0, dimensions: { x: W, y: 300, z: Z } }],
    index: {
      columns: { ll: { url: 'index/ll.bin', sha256: 'a'.repeat(64) } },
      cuts: [{ url: 'cuts/l0/index.bin', bytes: cutIx.length, sha256: sha(cutIx) }]
    }
  };
  const calls = { index: 0, head: 0 };
  const fetchImpl = async (url, init = {}) => {
    const rel = String(url).split('/bricks/')[1].split('?')[0];
    if (rel === 'cuts/l0/index.bin') {
      if (++calls.index === 1) await hang(init.signal);
      return { ok: true, status: 200, headers: { get: () => '' }, arrayBuffer: async () => cutIx.slice().buffer };
    }
    const [a, b] = String(init.headers?.Range || 'bytes=0-0').slice(6).split('-').map(Number);
    if (a === 0 && b === 19 && ++calls.head === 1) await hang(init.signal);
    return { ok: true, status: 206, headers: { get: (h) => (h === 'Content-Range' ? `bytes ${a}-${b}/${pack.length}` : '') }, arrayBuffer: async () => pack.slice(a, b + 1).buffer };
  };
  const CS = loadModule('js/core/cut-store.js', 'CutStore', {
    fetch: fetchImpl, PlaneCodec, URL, Blob: globalThis.Blob, DOMException, OffscreenCanvas: undefined, createImageBitmap: undefined,
    AbortController: globalThis.AbortController
  });
  CS.configure({ fetchStallMs: STALL_MS });
  const tree = CS.open('DATA_WEB/3d/F/bricks', manifest);

  const ctrlA = new AbortController();
  const pA = tree.loadCutBricks(0, 0, 8, [{ cx: 0, cy: 0, cz: 0 }], { signal: ctrlA.signal });
  await tick();
  ctrlA.abort();
  await assert.rejects(pA, (err) => err.name === 'AbortError', 'the cancelled pass stops waiting');
  await assert.rejects(tree.loadCutBricks(0, 0, 8, [{ cx: 0, cy: 0, cz: 0 }]), (err) => err.code === 'CUT_FETCH_STALL',
    'a pass waiting on the dead cut index fails with a coded stall');
  assert.equal(await tree.loadCutBricks(0, 0, 8, [{ cx: 0, cy: 0, cz: 0 }]), 0, 'the next pass reads the index again');
  assert.equal(calls.index, 2);
  console.log('CutStore: a hung cut index fails with CUT_FETCH_STALL and is fetched again: OK');

  await assert.rejects(tree.orthRow('xz', 0, 0, 64), (err) => err.code === 'CUT_FETCH_STALL', 'a hung pack head fails with a coded stall');
  const got = await tree.orthRow('xz', 0, 0, 64);
  assert.deepEqual(Array.from(got.data), Array.from(row), 'the next row read fetches the head again');
  assert.equal(calls.head, 2);
  console.log('CutStore: a hung XZ pack head fails with CUT_FETCH_STALL and is fetched again: OK');
}

// ── PlaneLoader: a header that never answers; a whole pack under the caller ──
{
  const BASE = 'DATA_WEB/3d/st/planes';
  const BRICKS = 'DATA_WEB/3d/st/bricks/manifest.json';
  const DIMS = { x: 600, y: 300, z: 2 };
  const built = await buildTree({ base: BASE, dims: DIMS, channels: 1, voxel: (x, y, z) => (x + y + z) & 255, bricksManifest: '{"schema":"iribhm-bricks-v2","levels":[]}' });
  built.files.set(BRICKS, built.bricksBytes);

  {
    const inner = planeFetch(built.files);
    let packCalls = 0;
    const fetchImpl = async (url, init = {}) => {
      if (String(url).includes('/z00000.bin') && ++packCalls === 1) await hang(init.signal);
      return inner(url, init);
    };
    const L = loadPlaneLoader(fetchImpl);
    L.configure({ fetchStallMs: STALL_MS });
    const tree = await L.open(BASE, { dimensions: DIMS, channels: 1, sourceManifestUrl: BRICKS });
    const ctrlA = new AbortController();
    const hA = tree.header(0, { signal: ctrlA.signal });
    await tick();
    ctrlA.abort();
    await assert.rejects(hA, (err) => err.name === 'AbortError');
    await assert.rejects(tree.header(0, {}), (err) => err.code === 'PLANES_STALL', 'a caller waiting on the dead header fails with a coded stall');
    const h = await tree.header(0, {});
    assert.ok(h.offsets.length > 0, 'the next caller reads the header again');
    assert.equal(packCalls, 2);
    console.log('PlaneLoader: a hung shared header fails with PLANES_STALL and is fetched again: OK');
  }

  {
    const inner = planeFetch(built.files, { ignoreRange: true });
    const wholeSignals = [];
    const fetchImpl = async (url, init = {}) => {
      if (String(url).includes('/z00000.bin') && !init.headers?.Range) {
        wholeSignals.push(init.signal || null);
        await hang(init.signal);
      }
      return inner(url, init);
    };
    const L = loadPlaneLoader(fetchImpl);
    const tree = await L.open(BASE, { dimensions: DIMS, channels: 1, sourceManifestUrl: BRICKS });
    const ctrlA = new AbortController();
    const hA = tree.header(0, { signal: ctrlA.signal });
    for (let i = 0; i < 5 && !wholeSignals.length; i++) await sleep(5);
    assert.equal(wholeSignals.length, 1, 'without Range the header comes out of a whole-pack read');
    assert.equal(wholeSignals[0], ctrlA.signal, 'that download is under the caller\'s signal');
    ctrlA.abort();
    await assert.rejects(hA, (err) => err.name === 'AbortError');
    assert.equal(wholeSignals[0].aborted, true, 'cancelling the caller stops the whole-pack download');
    console.log('PlaneLoader: without Range, a header\'s whole-pack read is cancelled with its caller: OK');
  }
}

console.log('test_shared_fetch_stall: all OK');
