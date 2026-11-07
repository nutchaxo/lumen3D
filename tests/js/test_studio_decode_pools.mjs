// The Studio's two decode pools — PlaneLoader (plane tiles, slab maxima) and CutStore
// (XZ/YZ tiles, oblique cut bricks) — take their share of the cores in a Compare panel
// and do not outlive the work:
//   • configure({ workers }) caps the pool (1–4, never above the page's own default),
//     null gives the default back; a lower cap replaces an idle pool at once, a busy one
//     only once its work is answered (no accumulator, no job lost);
//   • the workers are terminated a few seconds after the last load / job, never while a
//     load still holds the pool between two of its messages; the next load respawns them
//     and reads the same pixels.
//
// Run: node tests/js/test_studio_decode_pools.mjs
import assert from 'node:assert/strict';
import { loadModule } from './harness.mjs';
import { VmWorker, buildTree, mockFetch, loadPlaneLoader, PlaneCodec } from './test_mig_reader_plane_loader.mjs';

/** setTimeout that holds the pools' idle timers (≥ 5 s) for the test to fire. */
// Holds the pools' idle teardown timers (IDLE_MS = 5 s); every other timer (a shared read's
// 30 s stall deadline, cleared when the read answers) runs for real.
function idleClock() {
  const held = new Map();
  let seq = 0;
  const st = (fn, ms, ...args) => {
    if (Number(ms) === 5000) { const id = `idle${++seq}`; held.set(id, fn); return id; }
    return setTimeout(fn, ms, ...args);
  };
  const ct = (id) => { if (held.has(id)) held.delete(id); else clearTimeout(id); };
  const fire = () => { const fns = [...held.values()]; held.clear(); fns.forEach(fn => fn()); };
  return { st, ct, fire, held };
}

// ── PlaneLoader ──────────────────────────────────────────────────────────────
{
  const live = new Set();
  let spawned = 0;
  class CountingWorker extends VmWorker {
    constructor(url) { super(url); spawned++; live.add(this); }
    terminate() { super.terminate(); live.delete(this); }
  }
  const DIMS = { x: 96, y: 80, z: 3 };
  const voxel = (x, y, z) => ((x * 7 + y * 13 + z * 29) & 255) || 1;
  const BASE = 'DATA_WEB/3d/pools/planes';
  const BRICKS = 'DATA_WEB/3d/pools/bricks/manifest.json';
  const tree0 = await buildTree({ base: BASE, dims: DIMS, channels: 1, voxel, bricksManifest: '{"schema":"iribhm-bricks-v2","levels":[]}' });
  tree0.files.set(BRICKS, tree0.bricksBytes);
  const clock = idleClock();
  const L = loadPlaneLoader(mockFetch(tree0.files), {
    Worker: CountingWorker, navigator: { hardwareConcurrency: 8 }, setTimeout: clock.st, clearTimeout: clock.ct
  });
  assert.equal(typeof L.configure, 'function', 'PlaneLoader.configure exists');
  const tree = await L.open(BASE, { dimensions: DIMS, channels: 1, sourceManifestUrl: BRICKS });
  const rect = { x0: 0, y0: 0, x1: DIMS.x, y1: DIMS.y };
  const check = (res, z) => {
    for (let y = 0; y < DIMS.y; y += 7) for (let x = 0; x < DIMS.x; x += 5) {
      assert.equal(res.data[0][y * DIMS.x + x], voxel(x, y, z), `plane ${z} (${x}, ${y})`);
    }
  };

  L.configure({ workers: 2 });
  check(await tree.loadRegion(1, [0], rect), 1);
  assert.equal(spawned, 2, 'a panel share of two workers spawns two');
  assert.equal(live.size, 2, 'kept between two loads');
  assert.equal(clock.held.size, 1, 'an idle timer is armed once nothing uses the pool');

  // A new load cancels the teardown at once (before its first await).
  const p = tree.loadRegion(2, [0], rect);
  assert.equal(clock.held.size, 0, 'a load in progress is never torn down');
  check(await p, 2);
  clock.fire();
  assert.equal(live.size, 0, 'idle: every worker is terminated');

  // The next load respawns the pool and reads the same pixels; a slab max too.
  const mip = await tree.loadRegionMax([0, 1, 2], [0], rect);
  assert.equal(spawned, 4, 'respawned on demand');
  for (let y = 0; y < DIMS.y; y += 9) for (let x = 0; x < DIMS.x; x += 11) {
    assert.equal(mip.data[0][y * DIMS.x + x], Math.max(voxel(x, y, 0), voxel(x, y, 1), voxel(x, y, 2)), `max (${x}, ${y})`);
  }
  assert.equal(clock.held.size, 1);

  // A lower cap on an idle pool replaces it at once.
  L.configure({ workers: 1 });
  assert.equal(live.size, 0, 'a pool above the new cap is dropped while idle');
  assert.equal(clock.held.size, 0);
  check(await tree.loadRegion(0, [0], rect), 0);
  assert.equal(live.size, 1, 'one worker under a cap of one');

  // A lower cap during a load waits for it: the load keeps its pool to the end.
  L.configure({ workers: null });
  clock.fire();
  assert.equal(live.size, 0);
  const busy = tree.loadRegion(1, [0], rect);
  L.configure({ workers: 1 });
  check(await busy, 1);
  assert.equal(spawned, 9, 'no cap: the page default of four (8 cores) was spawned for that load');
  assert.equal(live.size, 0, 'and replaced as soon as the load let go of it');
  check(await tree.loadRegion(2, [0], rect), 2);
  assert.equal(live.size, 1, 'the next load runs under the new cap');
  clock.fire();
  assert.equal(live.size, 0);
  L.configure({ workers: 9 });
  check(await tree.loadRegion(0, [0], rect), 0);
  assert.equal(live.size, 4, 'a cap never exceeds the page default (clamped to four, cores - 1)');
  L.dispose();
  assert.equal(live.size, 0);
  assert.equal(clock.held.size, 0, 'dispose drops the idle timer');
  console.log('PlaneLoader pool: capped, released when idle, respawned: OK');
}

// ── CutStore ─────────────────────────────────────────────────────────────────
{
  const live = new Set();
  let spawned = 0;
  /** Speaks cut-decode-worker.js's protocol: { op, id, bytes } → { id, width, height, data }. */
  class CutWorker {
    constructor(url) {
      assert.match(url, /^js\/workers\/cut-decode-worker\.js/);
      this.onmessage = null;
      this.onerror = null;
      this.queue = [];
      spawned++;
      live.add(this);
    }
    postMessage(msg) {
      if (!live.has(this)) return;
      this.queue.push(msg);
    }
    /** Answer every job received so far (the test decides when work completes). */
    flush() {
      const q = this.queue.splice(0);
      for (const msg of q) {
        const bytes = new Uint8Array(msg.bytes);
        const data = new Uint8Array(msg.bz * 32 * 32).fill(bytes[0]);
        this.onmessage && this.onmessage({ data: { id: msg.id, data: data.buffer } });
      }
    }
    terminate() { live.delete(this); }
  }
  const all = [];
  class TrackedCutWorker extends CutWorker { constructor(url) { super(url); all.push(this); } }
  const flushAll = async () => { all.forEach(w => w.flush()); await new Promise(r => setTimeout(r, 0)); };
  const clock = idleClock();
  const CS = loadModule('js/core/cut-store.js', 'CutStore', {
    Worker: TrackedCutWorker, document: { querySelector: () => null }, navigator: { hardwareConcurrency: 8 },
    setTimeout: clock.st, clearTimeout: clock.ct, PlaneCodec
  });
  assert.equal(typeof CS.configure, 'function', 'CutStore.configure exists');

  CS.configure({ workers: 2 });
  const jobs = [5, 6, 7].map(v => CS.decodeCutBrick(new Uint8Array([v, 1, 2]), 2));
  assert.equal(spawned, 2, 'a share of two cut decoders');
  assert.equal(clock.held.size, 0, 'no teardown while jobs wait');
  await flushAll();
  const out = await Promise.all(jobs);
  assert.deepEqual(out.map(o => [o.length, o[0]]), [[2048, 5], [2048, 6], [2048, 7]], 'every job answered by the pool');
  assert.equal(clock.held.size, 1, 'idle timer armed once the last job is answered');
  assert.equal(live.size, 2);
  clock.fire();
  assert.equal(live.size, 0, 'idle: the cut decoders are terminated');

  // A lower cap while jobs are in flight: the old workers answer, then go.
  const a = CS.decodeCutBrick(new Uint8Array([9]), 1);
  const b = CS.decodeCutBrick(new Uint8Array([10]), 1);
  assert.equal(spawned, 4, 'respawned on demand');
  CS.configure({ workers: 1 });
  assert.equal(live.size, 2, 'a busy worker is not killed with its job');
  const c = CS.decodeCutBrick(new Uint8Array([11]), 1);
  assert.equal(spawned, 5, 'new jobs go to a pool under the new cap');
  await flushAll();
  assert.deepEqual([(await a)[0], (await b)[0], (await c)[0]], [9, 10, 11], 'no job lost across the swap');
  assert.equal(live.size, 1, 'the retired workers left once they had answered');
  clock.fire();
  assert.equal(live.size, 0);

  // A cap above the default is clamped; null gives the default (min(4, cores - 1)) back.
  CS.configure({ workers: null });
  const many = Array.from({ length: 6 }, (_, i) => CS.decodeCutBrick(new Uint8Array([i]), 1));
  assert.equal(live.size, 4, 'the page default of four');
  await flushAll();
  await Promise.all(many);
  clock.fire();
  assert.equal(live.size, 0);
  console.log('CutStore pool: capped, retired after answering, released when idle: OK');
}

console.log('test_studio_decode_pools: ok');
