// A shared, cached read (a v5/v6 column index, a plane pack header, an XZ/YZ pack head,
// a whole pack sent by a host without Range) belongs to no caller: when the caller that
// started it is cancelled, the others still get their answer.
//   • BrickLoader: batch A starts the q30 index of a v6 tree under its signal, batch B
//     (no signal) waits on the same index; A is aborted while the index is in flight:
//     A resolves with a cancelled summary (it never rejects on cancellation) and B
//     loads; the index is fetched once, under no caller's signal (its own deadline's);
//   • PlaneLoader: two header() callers of one plane, the first one aborted: the second
//     gets the header;
//   • CutStore: two orthRow() callers of one pack, the first aborted: the second reads
//     its row; on a host without Range, a reader waiting on another caller's whole-pack
//     body that gets cancelled reads the pack itself.
//
// Run: node tests/js/test_shared_fetch_cancel.mjs
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { loadModule } from './harness.mjs';
import { buildTree, mockFetch as planeFetch, loadPlaneLoader, PlaneCodec } from './test_mig_reader_plane_loader.mjs';

const sha = (u8) => createHash('sha256').update(u8).digest('hex');
const tick = () => new Promise((r) => setTimeout(r, 0));
const abortErr = () => new DOMException('aborted', 'AbortError');

/** Waits until `gate.open` (immediately when already open); rejects when `signal` aborts first. */
function waitGate(gate, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(abortErr()); return; }
    if (gate.open) { resolve(); return; }
    gate.waiters.push(resolve);
    signal?.addEventListener('abort', () => reject(abortErr()), { once: true });
  });
}
const newGate = () => ({ open: false, waiters: [] });
const openGate = (g) => { g.open = true; g.waiters.splice(0).forEach(r => r()); };

// ── BrickLoader: a column index shared by two batches ─────────────────────────
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

{
  // Level 0 of channel 1 holds no brick in either column: its tasks need no pack.
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
  const q30Gate = newGate();
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const rel = String(url).split('/bricks/')[1].split('?')[0];
    calls.push({ rel, signal: init.signal || null });
    if (rel === 'index/q30.bin') await waitGate(q30Gate, init.signal);
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
  await BL.init('DATA_WEB/3d/S/bricks', manifest);
  const tasks = [{ lod: 0, channel: 1, bx: 0, by: 0, bz: 0, column: 'q30' }, { lod: 0, channel: 1, bx: 1, by: 0, bz: 0, column: 'q30' }];
  const ctrlA = new AbortController();
  let completedA = null;
  const pA = BL.loadBrickTasks(tasks, { streamOnly: true, signal: ctrlA.signal, onComplete: (s) => { completedA = s; } });
  const pB = BL.loadBrickTasks(tasks, { streamOnly: true });
  await tick();
  ctrlA.abort();
  await tick();
  openGate(q30Gate);
  const [rA, rB] = await Promise.allSettled([pA, pB]);
  assert.equal(rA.status, 'fulfilled', `batch A resolves on its own cancellation (${rA.reason})`);
  assert.equal(rA.value.summary.cancelled, true);
  assert.equal(rA.value.summary.reason, 'signal');
  assert.equal(rA.value.summary.skipped.length, 2, 'every task of A skipped');
  assert.equal(rA.value.summary.delivered, 0);
  assert.equal(completedA, rA.value.summary, 'onComplete called with the cancelled summary');
  assert.equal(rB.status, 'fulfilled', `batch B is not failed by A's cancellation (${rB.reason})`);
  assert.equal(rB.value.summary.cancelled, false);
  assert.equal(rB.value.summary.failed.length, 0);
  assert.equal(rB.value.summary.delivered + rB.value.summary.skipped.length, 2);
  const q30Calls = calls.filter(c => c.rel === 'index/q30.bin');
  assert.equal(q30Calls.length, 1, 'the q30 index fetched once');
  assert.ok(q30Calls[0].signal && q30Calls[0].signal !== ctrlA.signal && !q30Calls[0].signal.aborted,
    'under no caller\'s signal (its own deadline\'s, not aborted by A)');
  console.log('BrickLoader: a column index shared by two batches survives the first one\'s cancellation: OK');

  // A batch whose own signal aborts during an index load that then fails for another
  // reason is still a cancellation, not an error; an index error without a cancellation
  // still rejects.
  const brokenFiles = { ...files, 'index/q30.bin': new Uint8Array(3) };
  const BL2 = loadModule('js/core/brick-loader.js', 'BrickLoader', {
    document: { createElement: () => ({ getContext: () => ({}) }) },
    navigator: { hardwareConcurrency: 2 }, performance: { now: () => Date.now() }, window: {},
    crypto: globalThis.crypto, AbortController: globalThis.AbortController, DOMException: globalThis.DOMException,
    fetch: async (url) => {
      const u8 = brokenFiles[String(url).split('/bricks/')[1].split('?')[0]];
      return { ok: true, status: 200, arrayBuffer: async () => u8.slice().buffer };
    }
  });
  await BL2.init('DATA_WEB/3d/S2/bricks', manifest);
  await assert.rejects(BL2.loadBrickTasks(tasks, { streamOnly: true }), /index/, 'a bad index still rejects a live batch');
  const ctrlC = new AbortController();
  ctrlC.abort();
  const rC = await BL2.loadBrickTasks(tasks, { streamOnly: true, signal: ctrlC.signal });
  assert.equal(rC.summary.cancelled, true, 'an already-aborted batch resolves cancelled');
  console.log('BrickLoader: cancellation vs index error: OK');
}

// ── PlaneLoader: one plane header, two callers ────────────────────────────────
{
  const BASE = 'DATA_WEB/3d/pl/planes';
  const BRICKS = 'DATA_WEB/3d/pl/bricks/manifest.json';
  const DIMS = { x: 600, y: 300, z: 2 };
  const built = await buildTree({ base: BASE, dims: DIMS, channels: 1, voxel: (x, y, z) => (x + y + z) & 255, bricksManifest: '{"schema":"iribhm-bricks-v2","levels":[]}' });
  built.files.set(BRICKS, built.bricksBytes);
  for (const ignoreRange of [false, true]) {
    const inner = planeFetch(built.files, { ignoreRange });
    const gate = newGate();
    const packCalls = [];
    const fetchImpl = async (url, init = {}) => {
      if (String(url).includes('/z00000.bin')) {
        packCalls.push(init.signal || null);
        await waitGate(gate, init.signal);
      }
      return inner(url, init);
    };
    const L = loadPlaneLoader(fetchImpl);
    const tree = await L.open(BASE, { dimensions: DIMS, channels: 1, sourceManifestUrl: BRICKS });
    const ctrlA = new AbortController();
    const hA = tree.header(0, { signal: ctrlA.signal });
    const hB = tree.header(0, {});
    const settled = Promise.allSettled([hA, hB]);
    await tick();
    ctrlA.abort();
    await tick();
    openGate(gate);
    const [rA, rB] = await settled;
    assert.equal(rA.status, 'rejected', 'the aborted caller stops waiting');
    assert.equal(rA.reason.name, 'AbortError');
    assert.equal(rB.status, 'fulfilled', `the other caller gets the header (${ignoreRange ? 'host without Range' : 'ranges'}): ${rB.reason}`);
    assert.ok(rB.value.offsets.length > 0);
    // The shared header read runs under its own deadline's signal, never a caller's. A host
    // without Range answers it with the whole pack: that body is dropped and the caller
    // still waiting reads the pack whole under its own (absent) signal.
    assert.equal(packCalls.length, ignoreRange ? 2 : 1, 'one read of the header (+ the whole pack without Range)');
    assert.ok(packCalls[0] && packCalls[0] !== ctrlA.signal, 'the shared read is under no caller\'s signal');
    if (ignoreRange) assert.equal(packCalls[1], null, 'the whole pack is read under the live caller\'s signal');
    const region = await tree.loadRegion(0, [0], { x0: 0, y0: 0, x1: 4, y1: 2 });
    assert.ok(region, 'the plane still loads after the cancelled caller');
  }
  console.log('PlaneLoader: a plane header shared by two callers survives the first one\'s cancellation: OK');
}

// ── CutStore: an XZ pack head, and a whole pack, shared by two callers ─────────
{
  const W = 600, Z = 5;
  const row = new Uint8Array(W * Z);
  for (let i = 0; i < row.length; i++) row[i] = (i * 7) & 0xFF;
  const tiles = await Promise.all([0, 1].map(async ta => {
    const w = Math.min(512, W - ta * 512);
    const t = new Uint8Array(w * Z);
    for (let z = 0; z < Z; z++) t.set(row.subarray(z * W + ta * 512, z * W + ta * 512 + w), z * w);
    return PlaneCodec.encodePngGray(w, Z, t);
  }));
  const head = 20 + 12 * 1 * 2;
  const pack = new Uint8Array(head + tiles[0].length + tiles[1].length);
  const dv = new DataView(pack.buffer);
  pack.set([76, 80, 88, 90]);
  dv.setUint16(4, 1, true); dv.setUint16(6, 2, true); dv.setUint16(8, 1, true); dv.setUint32(12, 64, true); dv.setUint32(16, 1, true);
  let off = head, e = 20;
  for (const t of tiles) { dv.setBigUint64(e, BigInt(off), true); dv.setUint32(e + 8, t.length, true); e += 12; pack.set(t, off); off += t.length; }
  const REL = 'xz/l0/c0/b00001.bin';
  const manifest = {
    schema: 'iribhm-bricks-v5',
    levels: [{ level: 0, dimensions: { x: W, y: 300, z: Z } }],
    index: { columns: { ll: { url: 'index/ll.bin', sha256: 'a'.repeat(64) } }, cuts: [] }
  };
  const makeStore = (fetchImpl) => loadModule('js/core/cut-store.js', 'CutStore', {
    fetch: fetchImpl, PlaneCodec, URL, Blob: globalThis.Blob, DOMException, OffscreenCanvas: undefined, createImageBitmap: undefined,
    AbortController: globalThis.AbortController
  }).open('DATA_WEB/3d/F/bricks', manifest);

  // Ranges: the 20-byte head read once, under no caller's signal.
  {
    const gate = newGate();
    const headCalls = [];
    const fetchImpl = async (url, init = {}) => {
      const range = init.headers?.Range;
      const [a, b] = range.slice(6).split('-').map(Number);
      if (a === 0 && b === 19) { headCalls.push(init.signal || null); await waitGate(gate, init.signal); }
      return { ok: true, status: 206, headers: { get: (h) => (h === 'Content-Range' ? `bytes ${a}-${b}/${pack.length}` : '') }, arrayBuffer: async () => pack.slice(a, b + 1).buffer };
    };
    const tree = makeStore(fetchImpl);
    const ctrlA = new AbortController();
    const rA = tree.orthRow('xz', 0, 0, 64, { signal: ctrlA.signal });
    const rB = tree.orthRow('xz', 0, 0, 64, {});
    const settled = Promise.allSettled([rA, rB]);
    await tick();
    ctrlA.abort();
    await tick();
    openGate(gate);
    const [sA, sB] = await settled;
    assert.equal(sA.status, 'rejected', 'the aborted row read stops');
    assert.equal(sB.status, 'fulfilled', `the other row read completes: ${sB.reason}`);
    assert.deepEqual(Array.from(sB.value.data), Array.from(row), 'its row decoded');
    assert.equal(headCalls.length, 1, 'the head read once');
    assert.ok(headCalls[0] && headCalls[0] !== ctrlA.signal && !headCalls[0].aborted, 'under no caller\'s signal (its own deadline\'s)');
    console.log('CutStore: an XZ pack head shared by two row reads survives the first one\'s cancellation: OK');
  }

  // A host without Range: the first reader's whole-pack body is cancelled with it; the
  // reader waiting on that body reads the pack itself.
  {
    const gate = newGate();
    let wholeReads = 0;
    const fetchImpl = async (url, init = {}) => {
      wholeReads++;
      const first = wholeReads === 1;
      const signal = init.signal;
      return {
        ok: true, status: 200, headers: { get: () => '' },
        arrayBuffer: async () => {
          if (first) await waitGate(gate, signal);
          return pack.slice().buffer;
        }
      };
    };
    const tree = makeStore(fetchImpl);
    const ctrlA = new AbortController();
    const rA = tree.readRange(REL, 0, 20, ctrlA.signal);
    for (let i = 0; i < 3; i++) await tick();
    const rB = tree.readRange(REL, 20, 44);
    await tick();
    ctrlA.abort();
    const [sA, sB] = await Promise.allSettled([rA, rB]);
    assert.equal(sA.status, 'rejected', 'the cancelled reader stops');
    assert.equal(sB.status, 'fulfilled', `the waiting reader reads the pack itself: ${sB.reason}`);
    assert.deepEqual(Array.from(sB.value), Array.from(pack.subarray(20, 44)));
    assert.equal(wholeReads, 2, 'one more whole read, for the reader still alive');
    const again = await tree.readRange(REL, 0, 4);
    assert.deepEqual(Array.from(again), [76, 80, 88, 90], 'the pack is cached once read whole');
    assert.equal(wholeReads, 2, 'served from the cached body');
    console.log('CutStore: a whole pack cancelled by its first reader is read again by the next: OK');
  }
}

console.log('test_shared_fetch_cancel: all OK');
