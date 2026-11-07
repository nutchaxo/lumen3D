// Graphs plugin — the data provider: tables computed in the engine worker (same
// numbers as on the page, columns handed over, fallback to the page when the worker
// dies), reads aborted when the state they were for is gone, a playing timelapse
// followed only once it rests, and a Compare panel that keeps one query in flight.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT } from './harness.mjs';

const DIR = path.join(ROOT, 'js/modules/tools/graphs');
const SHARED = {
  console, Math, Number, String, Object, Array, Map, Set, WeakMap, JSON, Error, Date, Promise, Symbol, RegExp,
  ArrayBuffer, Float32Array, Float64Array, Int32Array, Int16Array, Uint8Array, Uint8ClampedArray, Uint16Array, Uint32Array,
  setTimeout, clearTimeout
};
const t = (k, p) => (p ? `${k}:${JSON.stringify(p)}` : k);
const deepEqual = (a, b, m) => assert.equal(JSON.stringify(a), JSON.stringify(b), m);
const tick = () => new Promise(r => setTimeout(r, 0));

/** engine-worker.js in a context of its own, as a dedicated worker runs it. */
function startWorker(post) {
  const ctx = { ...SHARED, postMessage: post };
  ctx.self = ctx;
  ctx.importScripts = (file) => vm.runInContext(readFileSync(path.join(DIR, file), 'utf8'), ctx, { filename: `graphs/${file}` });
  vm.createContext(ctx);
  vm.runInContext(readFileSync(path.join(DIR, 'engine-worker.js'), 'utf8'), ctx, { filename: 'graphs/engine-worker.js' });
  assert.equal(typeof ctx.GraphsEngine?.compute, 'function', 'index.js gives the worker its engine alone');
  return ctx;
}

/** A Worker that runs engine-worker.js: messages are structured clones, delivered later. */
function workerClass(log, opts = {}) {
  return class FakeWorker {
    constructor(url) {
      log.created.push(url);
      this.ctx = startWorker((m) => setTimeout(() => this.onmessage && this.onmessage({ data: structuredClone(m) }), 0));
    }
    postMessage(msg, transfer) {
      const data = structuredClone(msg, { transfer: transfer || [] });
      log.ops.push(data.op);
      setTimeout(() => {
        if (opts.dieOn === data.op) { this.onerror && this.onerror({ message: 'worker crashed' }); return; }
        this.ctx.onmessage({ data });
      }, 0);
    }
    terminate() { log.terminated++; }
  };
}

function loadPlugin(extra = {}) {
  let impl = null;
  const ctx = {
    ...SHARED, AbortController, structuredClone,
    PluginRegistry: { implement: (_id, obj) => { impl = obj; }, syncToolbarButton() {}, getModule: () => ({ meta: { _path: 'js/modules/tools/graphs' } }) },
    window: {}, document: { documentElement: { getAttribute: () => null } },
    Utils: { trustedTargetOrigin: () => 'http://x', isTrustedMessageOrigin: () => true },
    ...extra
  };
  vm.createContext(ctx);
  vm.runInContext(readFileSync(path.join(DIR, 'index.js'), 'utf8'), ctx, { filename: 'graphs/index.js' });
  assert.ok(impl);
  return { G: impl, ctx };
}

// A 4 x 2 x 3 two-channel volume (x fastest).
function volume() {
  const n = 24;
  const A = new Uint8Array(n), B = new Uint8Array(n);
  for (let i = 0; i < n; i++) { const k = Math.floor(i / 8); A[i] = k * 10 + (i % 8 === 0 ? 2 : 0); B[i] = 255 - A[i]; }
  return [A, B];
}

function voxelCtx(reads, opts = {}) {
  const dims = { x: 4, y: 2, z: 3 };
  return {
    dataset: { getMeta: () => ({ type: '3d', name: 'E', dimensions: { c: 2 }, channels: [{ name: 'DAPI' }, { name: 'GFP' }] }), getId: () => '3d/E' },
    data: {
      info: () => ({ channels: 2 }),
      levels: () => [{ level: 0, dims, voxelSize: { x: 2, y: 2, z: 2 } }],
      readRegion: (box, chans, o) => {
        const call = { box, opts: o };
        reads.push(call);
        if (opts.hold) return new Promise((resolve, reject) => {
          call.release = () => resolve({ dims, data: volume() });
          o.signal?.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { name: 'AbortError' })));
        });
        const data = volume();
        call.data = data;
        return Promise.resolve({ dims, data });
      }
    }
  };
}

const SPECS = [
  { x: 'z', y: ['ch_gfp'], agg: 'mean' },
  { x: 'zr', y: ['@int'], agg: 'median' },
  { x: '@int', agg: 'count', yScale: 'log' },
  { x: 'ch_dapi', y: ['ch_gfp'], agg: 'density', threshold: 0 },
  { x: 'xr', y: ['ch_dapi'], agg: 'fraction', threshold: 5 }
];

// 1. The worker gives the page's numbers; the read volume is handed over, not copied.
{
  const log = { created: [], ops: [], terminated: 0 };
  const { G } = loadPlugin({ Worker: workerClass(log) });
  const inPage = G.createProvider(voxelCtx([]), t);
  const reads = [];
  const runner = G.createWorkerRunner('js/modules/tools/graphs/engine-worker.js');
  const remote = G.createProvider(voxelCtx(reads), t, { runner });
  for (const spec of SPECS) {
    const a = await inPage.compute('voxels', spec);
    const b = await remote.compute('voxels', spec);
    deepEqual({ ...b, info: null }, { ...a, info: null }, JSON.stringify(spec));
    assert.ok(b.info && b.info.voxelSize, 'the scan info stays on the page');
  }
  assert.equal(reads.length, 1, 'one read for every query');
  assert.ok(reads[0].data.every(c => c.byteLength === 0), 'the channels were handed to the worker');
  deepEqual(log.created, ['js/modules/tools/graphs/engine-worker.js']);
  assert.equal(log.ops.filter(o => o === 'load').length, 1, 'the table crosses once');
  assert.equal(log.ops.filter(o => o === 'compute').length, SPECS.length, 'then one spec per query');
  remote.dispose();
  assert.equal(log.terminated, 1);
  await assert.rejects(runner.compute('x', {}), (e) => e.code === 'DISPOSED');
}

// 2. A lazy column the page computes (neighbours of tracked cells) is posted when a query needs it.
{
  const pos = { 0: [[0, 0, 0], [1, 0, 0], [2, 0, 0]], 1: [[0, 1, 0], [1, 1, 0], [9, 9, 9]] };
  const data = {
    frameCount: 3, cellTotal: 2, regionNames: ['A'], regionColors: ['#ff0000'], regionIdx: Int16Array.from([0, 0]),
    firstFrame: Int32Array.from([0, 0]), lastFrame: Int32Array.from([2, 2]), flags: Uint8Array.from([0, 0]),
    daughterStart: Uint32Array.from([0, 0, 0]), daughterIdx: new Uint32Array(0)
  };
  const mk = () => ({
    dataset: { getMeta: () => ({ type: 'live', name: 'L', dimensions: { t: 3, c: 1 }, timeline: { intervalMinutes: 1 }, tracking: { regions: [{ name: 'A', color: '#ff0000' }] } }), getId: () => 'live/L' },
    tracking: {
      isAvailable: () => true, isLoaded: () => true, isStabilized: () => false, whenLoaded: async () => data, getData: () => data,
      getOptions: () => ({ neighborThresholdUm: 1.5 }),
      positionUm: (c, f, o, out) => { const p = pos[c][f]; out[0] = p[0]; out[1] = p[1]; out[2] = p[2]; return out; }
    }
  });
  const log = { created: [], ops: [], terminated: 0 };
  const { G } = loadPlugin({ Worker: workerClass(log) });
  const spec = { x: 't', y: ['neighbors'], agg: 'mean' };
  const a = await G.createProvider(mk(), t).compute('obs', spec);
  const { G: G2 } = loadPlugin({ Worker: workerClass(log) });
  const b = await G2.createProvider(mk(), t, { runner: G2.createWorkerRunner('w.js') }).compute('obs', spec);
  deepEqual(b.series, a.series);
  deepEqual(a.series[0].y, [1, 1, 0]);
  assert.ok(log.ops.includes('column'), 'the neighbour column was sent');
}

// 3. A worker that dies: the query is computed again on the page, from a fresh read.
{
  const log = { created: [], ops: [], terminated: 0 };
  const { G } = loadPlugin({ Worker: workerClass(log, { dieOn: 'compute' }) });
  const reads = [];
  const runner = G.createWorkerRunner('w.js');
  const provider = G.createProvider(voxelCtx(reads), t, { runner });
  const r = await provider.compute('voxels', SPECS[0]);
  deepEqual(r.series[0].y.map(v => +v.toFixed(6)), [254.75, 244.75, 234.75]);
  assert.equal(runner.available, false);
  assert.equal(reads.length, 2, 'the handed-over volume is read again');
  assert.equal(log.terminated, 1);
  await provider.compute('voxels', SPECS[1]);
  assert.equal(reads.length, 2, 'and kept on the page afterwards');
  // No Worker at all: the page computes, as it always could.
  const { G: G3 } = loadPlugin();
  assert.equal(G3.createWorkerRunner('w.js').available, false);
  assert.equal(G3.createWorkerRunner(null).available, false);
}

// 4. A read for a timepoint the viewer has left is aborted; a stable state is read once.
{
  const brickLoader = { base: 'bricks/t000/', getBasePath() { return this.base; } };
  const { G } = loadPlugin({ BrickLoader: brickLoader });
  const reads = [];
  const provider = G.createProvider(voxelCtx(reads, { hold: true }), t);
  const first = provider.compute('voxels', SPECS[0]);
  await tick();
  assert.equal(reads.length, 1);
  assert.equal(provider.currentKey('voxels'), '3d/E|bricks/t000', 'no tree on screen reported: the mounted tree');
  assert.equal(provider.stale('voxels'), false);
  brickLoader.base = 'bricks/t001/';            // the timelapse moves on
  assert.equal(provider.stale('voxels'), true);
  provider.touch('voxels');
  assert.equal(reads[0].opts.signal.aborted, true, 'the previous read is aborted at once');
  await assert.rejects(first, (e) => e.name === 'AbortError');
  assert.equal(reads.length, 2);
  reads[1].release();
  const r = await provider.compute('voxels', SPECS[0]);
  assert.equal(r.series[0].x.length, 3);
  await provider.compute('voxels', SPECS[1]);
  assert.equal(reads.length, 2, 'same timepoint: no new read');
  provider.reset();
  assert.equal(reads[1].opts.signal.aborted, true, 'a reset drops the table');
}

// 4b. The voxel table follows the tree ON SCREEN (what ctx.data reads), not the tree
//     BrickLoader has mounted: a timelapse prefetch mounts later frames without changing
//     the frame shown, and a cached frame is shown without a mount.
{
  const brickLoader = { base: 'DATA_WEB/live/L/bricks/t000/', getBasePath() { return this.base; } };
  const { G } = loadPlugin({ BrickLoader: brickLoader });
  const reads = [];
  const vctx = voxelCtx(reads);
  let shown = 'DATA_WEB/live/L/bricks/t000';
  vctx.data.displayedTree = () => ({ path: shown, manifest: {} });
  const provider = G.createProvider(vctx, t);
  await provider.compute('voxels', SPECS[0]);
  assert.equal(reads.length, 1);
  assert.equal(provider.currentKey('voxels'), '3d/E|DATA_WEB/live/L/bricks/t000');
  // The prefetch mounts t001..t003: the frame on screen is still t000.
  for (const k of ['t001', 't002', 't003']) {
    brickLoader.base = `DATA_WEB/live/L/bricks/${k}/`;
    assert.equal(provider.stale('voxels'), false, `prefetch mount ${k}: the table is still the one on screen`);
  }
  await provider.compute('voxels', SPECS[1]);
  assert.equal(reads.length, 1, 'a prefetch mount re-reads nothing');
  // Scrub to the cached frame t002: no mount, the mounted tree stays t003.
  shown = 'DATA_WEB/live/L/bricks/t002';
  assert.equal(provider.stale('voxels'), true, 'a cached frame shown without a mount makes the table stale');
  assert.equal(provider.currentKey('voxels'), '3d/E|DATA_WEB/live/L/bricks/t002');
  await provider.compute('voxels', SPECS[0]);
  assert.equal(reads.length, 2, 'the frame on screen is read');
  assert.equal(provider.stale('voxels'), false);
  // ctx.data names no tree on screen (throws, or no path): no key, never the mounted
  // tree (a prefetched frame); the table built for the last frame shown stays.
  vctx.data.displayedTree = () => { throw new Error('no dataset'); };
  assert.equal(provider.currentKey('voxels'), null);
  assert.equal(provider.stale('voxels'), false);
  vctx.data.displayedTree = () => ({ path: null, manifest: null });
  assert.equal(provider.currentKey('voxels'), null);
  assert.equal(provider.stale('voxels'), false);
  await provider.compute('voxels', SPECS[1]);
  assert.equal(reads.length, 2, 'nothing on screen: the last table is kept, nothing is read');
  provider.dispose();
  // A host whose ctx.data cannot say at all (no displayedTree): the mounted tree.
  const legacy = voxelCtx([]);
  const p2 = G.createProvider(legacy, t);
  assert.equal(p2.currentKey('voxels'), '3d/E|DATA_WEB/live/L/bricks/t003');
  p2.dispose();
}

// 4c. A WebGL context loss on a timelapse: the viewer releases its volumes (no tree on
//     screen) while the prefetch has left BrickLoader on a later frame. The REAL
//     DataAccess over a fake viewer and loader: the follow loop neither marks the table
//     stale nor reads; a draw without a table is refused NOT_READY with no read of the
//     prefetched frame; once frame t000 is back on screen the follow redraws it.
{
  const reads = [];
  const ROOT_URL = 'DATA_WEB/live/L/bricks';
  const manifests = { t000: { m: 0 }, t003: { m: 3 } };
  const loader = {
    base: `${ROOT_URL}/t000`, isReady: () => true,
    getBasePath() { return this.base; }, getManifest() { return manifests[this.base.slice(-4)]; },
    getLevelInfo: (k) => (k === 0 ? { dims: { x: 4, y: 2, z: 3 }, voxelSize: { x: 2, y: 2, z: 2 } } : null),
    getFormat: () => ({ version: 3, channels: 2, apron: 0 }),
    async pinTree(p) { return { path: p }; },
    withMount: (_h, fn) => fn(),
    hasBrick: () => true,
    async loadBrickTasks(tasks, opts) {
      reads.push(opts.mount.path);
      const dims = { x: 4, y: 2, z: 3 };
      const [A, B] = volume();
      for (const tk of tasks) {
        const src = tk.channel === 0 ? A : B;
        opts.onBrickLoaded({ bx: tk.bx, by: tk.by, bz: tk.bz, channel: tk.channel, data: src.slice(0, dims.x * dims.y * dims.z) });
      }
      return { summary: { failed: [], cancelled: false } };
    }
  };
  const viewer = { shown: { path: `${ROOT_URL}/t000`, manifest: manifests.t000 }, getDisplayedTree() { return this.shown; } };
  const harnessMod = await import('./harness.mjs');
  const DA = harnessMod.loadModule('js/core/data-access.js', 'DataAccess', { BrickLoader: loader, VolumeViewer: viewer });
  const { G } = loadPlugin({ BrickLoader: loader });
  const vctx = voxelCtx([]);
  vctx.data = DA;
  const provider = G.createProvider(vctx, t);
  await provider.compute('voxels', SPECS[0]);
  deepEqual(reads, [`${ROOT_URL}/t000`], 'frame 0 read');
  // The prefetch mounts t003; the context is lost: the viewer shows no tree.
  loader.base = `${ROOT_URL}/t003`;
  viewer.shown = null;
  assert.equal(DA.displayedTree().path, null, 'DataAccess does not take the mounted frame for the one on screen');
  let redraws = 0;
  const self = Object.assign(Object.create(G), { _open: true, _lastKey: null, _ui: { getTable: () => 'voxels', redraw: () => { redraws++; } }, _provider: provider });
  for (let i = 0; i < 4; i++) self._follow();
  assert.equal(redraws, 0, 'no redraw during the loss');
  assert.equal(provider.stale('voxels'), false);
  await provider.compute('voxels', SPECS[1]);
  deepEqual(reads, [`${ROOT_URL}/t000`], 'a draw during the loss keeps the frame-0 table, reads nothing');
  // A provider with no table yet: refused NOT_READY, the prefetched frame is not read.
  const fresh = G.createProvider(vctx, t);
  await assert.rejects(fresh.compute('voxels', SPECS[0]), (e) => e.code === 'NOT_READY');
  deepEqual(reads, [`${ROOT_URL}/t000`], 'no read of t003');
  await assert.rejects(DA.readRegion({ x0: 0, x1: 1, y0: 0, y1: 1, z0: 0, z1: 1 }, [0]), (e) => e.code === 'NO_DATASET');
  // The context is back on frame 0: the kept table is current, the refused one redraws.
  viewer.shown = { path: `${ROOT_URL}/t000`, manifest: manifests.t000 };
  assert.equal(provider.stale('voxels'), false, 'frame 0 again: the kept table is current');
  assert.equal(fresh.stale('voxels'), true, 'the refused table is due once a tree is on screen');
  const self2 = Object.assign(Object.create(G), { _open: true, _lastKey: null, _ui: { getTable: () => 'voxels', redraw: () => { redraws++; } }, _provider: fresh });
  self2._follow(); self2._follow();
  assert.equal(redraws, 1, 'one redraw once the frame has held for a tick');
  await fresh.compute('voxels', SPECS[0]);
  deepEqual(reads, [`${ROOT_URL}/t000`, `${ROOT_URL}/t000`]);
  assert.equal(fresh.stale('voxels'), false);
  provider.dispose(); fresh.dispose();
}

// 5. Following a timelapse: redraw only once the table's state has held for a tick.
{
  const { G } = loadPlugin();
  let key = 'k0', isStale = false, redraws = 0;
  const self = Object.assign(Object.create(G), {
    _open: true, _lastKey: null,
    _ui: { getTable: () => 'voxels', redraw: () => { redraws++; } },
    _provider: { currentKey: () => key, stale: () => isStale }
  });
  self._follow();
  key = 'k1'; isStale = true; self._follow();
  key = 'k2'; self._follow();
  key = 'k3'; self._follow();
  assert.equal(redraws, 0, 'playing: every tick shows another timepoint, nothing is read');
  self._follow();
  assert.equal(redraws, 1, 'paused for a tick: one redraw');
  isStale = false; self._follow();
  assert.equal(redraws, 1, 'up to date: nothing');
}

// 6. A Compare panel keeps one query in flight: a request replaced while it waits is
//    answered SUPERSEDED, the running one and the newest are answered.
{
  const replies = [];
  const handlers = [];
  const host = { postMessage: (m) => replies.push(m) };
  const { G, ctx } = loadPlugin();
  ctx.window.parent = host;
  ctx.window.addEventListener = (type, fn) => { if (type === 'message') handlers.push(fn); };
  const gates = [];
  const computed = [];
  const self = Object.assign(Object.create(G), {
    _t: t,
    _provider: {
      touch() {},
      compute: (table, spec) => { computed.push(spec.n); return new Promise(r => gates.push(() => r({ kind: 'xy', series: [], info: null, n: spec.n }))); },
      describe: () => ({ tables: [] })
    }
  });
  G._bindPanel.call(self, { iframe: { panelIndex: () => 2 } });
  const send = (id, n) => handlers.forEach(h => h({ source: host, data: { type: 'REQUEST_GRAPH_DATA', requestId: id, op: 'compute', table: 'voxels', spec: { n } } }));
  send('r1', 1); send('r2', 2); send('r3', 3);
  await tick();
  deepEqual(computed, [1], 'one query at a time on the shared thread');
  const r2 = replies.find(m => m.requestId === 'r2');
  assert.ok(r2 && r2.ok === false && r2.code === 'SUPERSEDED', 'the replaced request is answered at once');
  gates.shift()();
  await tick(); await tick();
  deepEqual(computed, [1, 3]);
  gates.shift()();
  await tick(); await tick();
  deepEqual(replies.map(m => [m.requestId, m.ok]), [['r2', false], ['r1', true], ['r3', true]]);
  assert.ok(replies.every(m => m.type === 'GRAPH_DATA' && m.sourceIndex === 2));
}

console.log('graphs provider: ok');
