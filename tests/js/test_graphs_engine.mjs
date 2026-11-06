// Graphs plugin — the query engine, the table builders and the Compare merge,
// against tables whose answers are worked out by hand.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT } from './harness.mjs';

function loadPlugin() {
  let impl = null;
  const ctx = {
    console, Math, Number, String, Object, Array, Map, Set, JSON, Error, Date, Promise, Symbol, RegExp,
    Float32Array, Float64Array, Int32Array, Int16Array, Uint8Array, Uint8ClampedArray, Uint16Array, Uint32Array,
    PluginRegistry: { implement: (_id, obj) => { impl = obj; }, syncToolbarButton() {} },
    window: {}, document: {}, Utils: { trustedTargetOrigin: () => 'http://x', isTrustedMessageOrigin: () => true }
  };
  vm.createContext(ctx);
  vm.runInContext(readFileSync(path.join(ROOT, 'js/modules/tools/graphs/index.js'), 'utf8'), ctx, { filename: 'graphs/index.js' });
  assert.ok(impl, 'graphs calls PluginRegistry.implement');
  return impl;
}

const G = loadPlugin();
const { Engine } = G;
// Arrays made inside the vm context have another prototype: compare their JSON.
const deepEqual = (a, b, m) => assert.equal(JSON.stringify(a), JSON.stringify(b), m);
const t = (k, p) => (p ? `${k}:${JSON.stringify(p)}` : k);

// A 4 x 2 x 3 voxel volume (x fastest), two channels: A = 10 per slice (+2 on one voxel), B = 255 - A.
function voxelTable() {
  const dx = 4, dy = 2, dz = 3, n = dx * dy * dz;
  const A = new Uint8Array(n), B = new Uint8Array(n);
  const z = new Float32Array(n), zr = new Float32Array(n);
  let i = 0;
  for (let k = 0; k < dz; k++) for (let j = 0; j < dy; j++) for (let x = 0; x < dx; x++) {
    A[i] = k * 10 + (x === 0 && j === 0 ? 2 : 0);
    B[i] = 255 - A[i];
    z[i] = (k + 0.5) * 2;
    zr[i] = ((k + 0.5) / dz) * 100;
    i++;
  }
  return {
    id: 'voxels', n, unitSize: 8, measureUnit: 'µm³',
    cols: { a: A, b: B }, lazy: { z: () => z, zr: () => zr },
    defaults: { x: 'zr', y: ['@int'], agg: 'mean' },
    vars: [
      { id: 'z', label: 'Z', unit: 'µm', kind: 'num', dom: [1, 5], step: 2 },
      { id: 'zr', label: 'Z %', unit: '%', kind: 'num', dom: [100 / 6, 100 - 100 / 6], step: 100 / 3 },
      { id: 'a', label: 'A', kind: 'num', dom: [0, 255], step: 1, bins: 64, intensity: true, ch: true, color: '#00FF00' },
      { id: 'b', label: 'B', kind: 'num', dom: [0, 255], step: 1, bins: 64, intensity: true, ch: true, color: '#0000ff' }
    ]
  };
}

// 1. Mean of a channel along Z: one bin per slice, values worked out by hand.
{
  const r = Engine.compute(voxelTable(), { x: 'z', y: ['a'], agg: 'mean' });
  assert.equal(r.kind, 'xy');
  const s = r.series[0];
  deepEqual(s.x, [1, 3, 5]);
  deepEqual(s.y.map(v => +v.toFixed(6)), [0.25, 10.25, 20.25]);   // seven voxels at k*10, one at k*10+2
  deepEqual(s.n, [8, 8, 8]);
}

// 2. @int expands to every channel, in table order, with the channel's own colour.
{
  const r = Engine.compute(voxelTable(), { x: 'zr', y: ['@int'], agg: 'max' });
  deepEqual(r.series.map(s => s.label), ['A', 'B']);
  assert.equal(r.series[0].color, '#00FF00');
  deepEqual(r.series[0].y, [2, 12, 22]);
  deepEqual(r.series[1].y, [255, 245, 235]);
}

// 3. Median and the 95th percentile on a byte column (nearest rank, lower median).
{
  const r = Engine.compute(voxelTable(), { x: 'z', y: ['a'], agg: 'median' });
  deepEqual(r.series[0].y, [0, 10, 20]);
  // sorted per slice: seven x base, one x base + 2 -> rank floor(0.95*7) = 6 is still base.
  const p = Engine.compute(voxelTable(), { x: 'z', y: ['a'], agg: 'p95' });
  deepEqual(p.series[0].y, [0, 10, 20]);
}

// 4. The SD and the band are the population SD of the bin.
{
  const r = Engine.compute(voxelTable(), { x: 'z', y: ['a'], agg: 'mean', band: true });
  assert.ok(Math.abs(r.series[0].sd[0] - Math.sqrt(0.4375)) < 1e-9);       // 0 x7, 2 x1: E[v^2] = 0.5, mean 0.25
  const sd = Engine.compute(voxelTable(), { x: 'z', y: ['a'], agg: 'std' });
  assert.ok(Math.abs(sd.series[0].y[0] - Math.sqrt(0.4375)) < 1e-9);
}

// 5. Signal volume: voxels above the threshold x the voxel volume; share in %.
{
  const m = Engine.compute(voxelTable(), { x: 'z', y: ['a'], agg: 'measure', threshold: 5 });
  deepEqual(m.series[0].y, [0, 64, 64]);
  assert.equal(m.y.unit, 'µm³');
  const f = Engine.compute(voxelTable(), { x: 'z', y: ['a'], agg: 'fraction', threshold: 5 });
  deepEqual(f.series[0].y, [0, 100, 100]);
  const any = Engine.compute(voxelTable(), { x: 'z', y: ['a'], agg: 'fraction', threshold: 0 });
  deepEqual(any.series[0].y, [12.5, 100, 100]);
}

// 6. Signal-only mean drops the background voxels from the average.
{
  const all = Engine.compute(voxelTable(), { x: 'z', y: ['a'], agg: 'mean' }).series[0].y[0];
  const sig = Engine.compute(voxelTable(), { x: 'z', y: ['a'], agg: 'mean', signalOnly: true, threshold: 0 }).series[0].y[0];
  assert.equal(all, 0.25);
  assert.equal(sig, 2);
}

// 7. Histogram of every channel: counts add up to the rows, one series per channel.
{
  const h = Engine.compute(voxelTable(), { x: '@int', agg: 'count', bins: 64 });
  assert.equal(h.x.id, '@int');
  deepEqual(h.series.map(s => s.label), ['A', 'B']);
  for (const s of h.series) assert.equal(s.y.reduce((a, b) => a + b, 0), 24);
  const sum = Engine.compute(voxelTable(), { x: '@int', agg: 'count', normalize: 'sum', bins: 64 });
  assert.ok(Math.abs(sum.series[0].y.reduce((a, b) => a + b, 0) - 1) < 1e-12);
}

// 8. Normalisation to the maximum / the first value; the SD follows.
{
  const r = Engine.compute(voxelTable(), { x: 'z', y: ['a'], agg: 'mean', normalize: 'max', band: true });
  assert.equal(Math.max(...r.series[0].y), 1);
  assert.ok(r.series[0].sd[0] < 0.1);
  const first = Engine.compute(voxelTable(), { x: 'z', y: ['b'], agg: 'mean', normalize: 'first' });
  assert.equal(first.series[0].y[0], 1);
}

// 9. Summary: one value per series.
{
  const r = Engine.compute(voxelTable(), { x: Engine.ALL, y: ['@int'], agg: 'mean' });
  assert.equal(r.kind, 'bar');
  deepEqual(r.series.map(s => s.y.length), [1, 1]);
  assert.ok(Math.abs(r.series[0].y[0] - (0.25 + 10.25 + 20.25) / 3) < 1e-9);
}

// 10. Co-localisation: anti-correlated channels give r = -1; X = Y is refused.
{
  const tb = voxelTable();
  const d = Engine.compute(tb, { x: 'a', y: ['b'], agg: 'density', threshold: 0, bins: 16 });
  assert.equal(d.kind, 'heat');
  assert.ok(Math.abs(d.heat.stats.pearson + 1) < 1e-12, `pearson ${d.heat.stats.pearson}`);
  assert.equal(d.heat.z.reduce((a, row) => a + row.reduce((b, c) => b + c, 0), 0), 24);
  const same = Engine.compute(tb, { x: 'a', y: ['a'], agg: 'density' });
  assert.notEqual(same.spec.y[0], 'a');
}

// 11. A choice that means nothing becomes the nearest one that does.
{
  const tb = voxelTable();
  const s1 = Engine.normalizeSpec(tb, { x: 'nope', y: ['nope'], agg: 'wat' });
  assert.equal(s1.x, 'zr');
  assert.equal(s1.agg, 'mean');
  deepEqual(s1.y, ['a', 'b']);
  assert.equal(Engine.normalizeSpec(tb, { x: '@int', agg: 'mean' }).agg, 'count');
  assert.throws(() => Engine.compute({ ...tb, n: 0 }, {}), (e) => e.code === 'NO_DATA');
}

// Cells: a categorical X, a grouping, raw points.
function cellTable() {
  return {
    id: 'cells', n: 6,
    cols: {
      region: Int16Array.from([0, 0, 0, 1, 1, 1]), meanSpeed: Float32Array.from([1, 2, 3, 10, 20, NaN]),
      straight: Float32Array.from([0.1, 0.2, 0.3, 0.9, 0.8, 0.7]), mitosis: Uint8Array.from([0, 1, 0, 0, 0, 1])
    },
    vars: [
      { id: 'meanSpeed', label: 'Mean speed', unit: 'µm/min', kind: 'num' },
      { id: 'straight', label: 'Straightness', unit: '', kind: 'num' },
      { id: 'region', label: 'Region', kind: 'cat', cats: { names: ['Red', 'Blue'], colors: ['#ff0000', '#0000ff'] } },
      { id: 'mitosis', label: 'Divides', kind: 'cat', cats: { names: ['No', 'Yes'], colors: null } }
    ]
  };
}
{
  const r = Engine.compute(cellTable(), { x: 'region', y: ['meanSpeed'], agg: 'mean', band: true });
  assert.equal(r.kind, 'bar');
  deepEqual(r.series[0].x, ['Red', 'Blue']);
  deepEqual(r.series[0].y, [2, 15]);                               // NaN is not a value
  deepEqual(Engine.compute(cellTable(), { x: 'region', agg: 'count' }).series[0].y, [3, 3]);
  const g = Engine.compute(cellTable(), { x: 'mitosis', y: ['meanSpeed'], agg: 'mean', group: 'region' });
  deepEqual(g.series.map(s => s.label), ['Red', 'Blue'], 'one Y + a group: the legend names the group');
  assert.equal(g.series[0].color, '#ff0000');
  const pts = Engine.compute(cellTable(), { x: 'meanSpeed', y: ['straight'], agg: 'points', group: 'region' });
  assert.equal(pts.kind, 'points');
  deepEqual(pts.series.map(s => s.x.length), [3, 2]);              // the NaN row is dropped
  const t2 = cellTable();
  t2.cols.region = Int16Array.from([0, 0, 0, 0, 0, 0]);
  assert.equal(Engine.compute(t2, { x: 'mitosis', y: ['meanSpeed'], agg: 'mean', group: 'region' }).series.length, 1, 'an empty group is not drawn');
}

// 12. The CSV carries every plotted number.
{
  const lines = Engine.toCsv(Engine.compute(voxelTable(), { x: 'z', y: ['a'], agg: 'mean' })).trim().split('\n');
  assert.equal(lines[0], 'dataset,series,Z,y,sd,n');
  assert.equal(lines.length, 4);
  assert.ok(lines[1].startsWith(',A,1,0.25'));
}

// The plot: colours follow the entity.
{
  const r = Engine.compute(voxelTable(), { x: 'z', y: ['@int'], agg: 'mean' });
  const light = G.buildPlot(r, { t, dark: false });
  assert.equal(light.data.length, 2);
  assert.ok(light.layout.showlegend, 'two series -> a legend');
  assert.notEqual(light.data[0].line.color, '#00FF00', '#00FF00 on a white page is pulled toward black');
  assert.equal(G.buildPlot(r, { t, dark: true }).data[0].line.color.toLowerCase(), '#00ff00');
  assert.equal(G.buildPlot(Engine.compute(voxelTable(), { x: 'z', y: ['a'], agg: 'mean' }), { t }).layout.showlegend, false, 'one series -> no legend box');
  const log = G.buildPlot(Engine.compute(voxelTable(), { x: 'z', y: ['a'], agg: 'mean', yScale: 'log' }), { t });
  assert.equal(log.layout.yaxis.type, 'log');
  assert.ok(log.data[0].y.every(v => v === null || v > 0));
}

// Compare: two datasets, one query, one colour each.
{
  const spec = { x: 'z', y: ['a', 'b'], agg: 'mean' };
  const a = JSON.parse(JSON.stringify(Engine.compute(voxelTable(), spec)));
  const b = JSON.parse(JSON.stringify(Engine.compute(voxelTable(), spec)));
  const merged = G.mergeResults([{ p: { index: 0, name: 'Embryo 1' }, res: a }, { p: { index: 3, name: 'Embryo 2' }, res: b }], ['Embryo 3'], (i) => (i === 0 ? 0 : 1), t);
  assert.equal(merged.datasets, 2);
  deepEqual(merged.series.map(s => s.label), ['Embryo 1 · A', 'Embryo 1 · B', 'Embryo 2 · A', 'Embryo 2 · B']);
  assert.ok(merged.extraNotes.some(n => n.includes('Embryo 3')), 'a panel that did not answer is named');
  assert.ok(merged.extraNotes.some(n => n.includes('note_rangesDiffer')), 'a µm axis warns that extents differ');
  const byDataset = G.buildPlot(merged, { t, dark: false, multi: true, colorBy: 'dataset' });
  assert.equal(new Set(byDataset.data.map(d => d.line.color)).size, 2, 'one colour per dataset');
  deepEqual(byDataset.data.map(d => d.line.dash), ['solid', 'dash', 'solid', 'dash'], 'channels told apart by dash');
  assert.notEqual(byDataset.data[0].marker.symbol, byDataset.data[1].marker.symbol);
  const bySeries = G.buildPlot(merged, { t, dark: false, multi: true, colorBy: 'series' });
  assert.equal(new Set(bySeries.data.map(d => d.line.color)).size, 2, 'one colour per channel');
  deepEqual(bySeries.data.map(d => d.line.dash), ['solid', 'solid', 'dash', 'dash'], 'datasets told apart by dash');
  // one series per dataset -> the legend names the dataset alone
  const one = G.mergeResults([{ p: { index: 0, name: 'E1' }, res: JSON.parse(JSON.stringify(Engine.compute(voxelTable(), { x: 'zr', y: ['a'], agg: 'mean' }))) },
    { p: { index: 1, name: 'E2' }, res: JSON.parse(JSON.stringify(Engine.compute(voxelTable(), { x: 'zr', y: ['a'], agg: 'mean' }))) }], [], (i) => i, t);
  deepEqual(one.series.map(s => s.label), ['E1', 'E2']);
  // density maps keep one map per dataset
  const heat = G.mergeResults([0, 1].map(i => ({ p: { index: i, name: `E${i}` }, res: JSON.parse(JSON.stringify(Engine.compute(voxelTable(), { x: 'a', y: ['b'], agg: 'density' }))) })), [], (i) => i, t);
  assert.equal(heat.heats.length, 2);
  assert.equal(G.buildPlot(heat, { t, multi: true }).data.filter(d => d.type === 'heatmap').length, 2);
}

// Compare: names that differ in one token are shortened to it; channels line up by name.
{
  deepEqual(G.shortNames(['Egfl7eGFP-E8-Em3-18112025-4avg', 'Egfl7eGFP-E8-Em6-18112025-4avg']), ['Em3', 'Em6']);
  deepEqual(G.shortNames(['One', 'Two']), ['One', 'Two'], 'nothing in common: unchanged');
  deepEqual(G.shortNames(['A-x', 'A-x']), ['A-x', 'A-x'], 'identical names are not collapsed');
  deepEqual(G.shortNames(['Solo-1']), ['Solo-1']);
  const tb = { total: 3, vars: [
    { id: 'ch_dapi', ch: true, haveCount: 3 }, { id: 'ch_gfp', ch: true, haveCount: 2 }, { id: 'z', haveCount: 3 }] };
  deepEqual(G.commonChannels(tb), ['ch_dapi'], 'only the channels every dataset has');
  deepEqual(G.commonChannels({ total: 2, vars: [{ id: 'a', ch: true, haveCount: 1 }, { id: 'b', ch: true, haveCount: 1 }] }), ['a', 'b'], 'none shared: all of them');
  deepEqual(G.commonChannels({ total: 1, vars: [{ id: 'a', ch: true }] }), ['a']);
  // "every channel" as X, restricted to the shared ones
  const h = Engine.compute(voxelTable(), { x: '@int', agg: 'count', only: ['b'] });
  deepEqual(h.series.map(s => s.label), ['B']);
}

// The voxel source reads through ctx.data, once per mount.
{
  const calls = [];
  const dims = { x: 4, y: 2, z: 3 };
  const tb0 = voxelTable();
  const ctx = {
    dataset: { getMeta: () => ({ type: '3d', name: 'E', dimensions: { c: 2 }, channels: [{ name: 'DAPI', color: '#00AAFF' }, { name: 'GFP', color: '#00FF00' }] }), getId: () => '3d/E' },
    data: {
      info: () => ({ channels: 2 }),
      levels: () => [{ level: 0, dims, voxelSize: { x: 2, y: 2, z: 2 } }, { level: 1, dims: { x: 2, y: 1, z: 3 }, voxelSize: { x: 4, y: 4, z: 2 } }],
      readRegion: async (box, chans, opts) => { calls.push({ box, chans, opts }); return { dims, data: [tb0.cols.a, tb0.cols.b] }; }
    }
  };
  const provider = G.createProvider(ctx, t);
  const d = provider.describe();
  deepEqual(d.tables.map(x => x.id), ['voxels']);
  const ids = d.tables[0].vars.map(v => v.id);
  assert.ok(ids.includes('ch_dapi') && ids.includes('ch_gfp'), `channel ids are slugs of their names: ${ids}`);
  const r = await provider.compute('voxels', { x: 'z', y: ['ch_gfp'], agg: 'mean' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].opts.level, 0, 'a volume small enough is read at the native level');
  deepEqual(calls[0].box, { x0: 0, x1: 4, y0: 0, y1: 2, z0: 0, z1: 3 });
  assert.equal(r.series[0].label, 'GFP');
  assert.equal(r.series[0].x.length, 3);
  assert.ok(r.info.voxelSize);
  await provider.compute('voxels', { x: 'ch_dapi', agg: 'count' });
  assert.equal(calls.length, 1, 'the scan is cached');
  const bad = G.createProvider({ ...ctx, data: { info() { throw new Error('x'); }, levels: () => [] } }, t);
  await assert.rejects(() => bad.compute('voxels', {}), (e) => e.code === 'NOT_READY');
}

// Tracking tables: speed, population, division time, neighbours, MSD.
{
  // cell 0: straight, 1 um/frame in X, frames 0-3 (divides: its daughter is cell 2);
  // cell 1: zig-zag in Y, frames 0-4; cell 2: frames 2-4. dt = 2 min.
  const F = 5, NC = 3;
  const pos = {
    0: [[0, 0, 0], [1, 0, 0], [2, 0, 0], [3, 0, 0], null],
    1: [[0, 5, 0], [0, 6, 0], [0, 5, 0], [0, 6, 0], [0, 5, 0]],
    2: [null, null, [3, 1, 0], [4, 1, 0], [5, 1, 0]]
  };
  const data = {
    frameCount: F, cellTotal: NC, timepoints: Float64Array.from([1, 2, 3, 4, 5]),
    regionNames: ['A', 'B'], regionColors: ['#ff0000', '#0000ff'], regionIdx: Int16Array.from([0, 1, 0]),
    firstFrame: Int32Array.from([0, 0, 2]), lastFrame: Int32Array.from([3, 4, 4]),
    flags: Uint8Array.from([1, 0, 0]), daughterStart: Uint32Array.from([0, 1, 1, 1]), daughterIdx: Uint32Array.from([2])
  };
  const ctx = {
    dataset: { getMeta: () => ({ type: 'live', name: 'L', dimensions: { t: 5, c: 1 }, timeline: { intervalMinutes: 2 }, tracking: { tracksPath: 't.json', regions: [{ name: 'A', color: '#ff0000' }, { name: 'B', color: '#0000ff' }] } }), getId: () => 'live/L' },
    tracking: {
      isAvailable: () => true, isLoaded: () => true, isStabilized: () => true, whenLoaded: async () => data, getData: () => data,
      getOptions: () => ({ neighborThresholdUm: 2.5 }),
      positionUm: (c, f, o, out) => { const p = pos[c][f]; if (!p) return null; out[0] = p[0]; out[1] = p[1]; out[2] = p[2]; return out; }
    },
    _state: { currentTimepoint: 3 }
  };
  const provider = G.createProvider(ctx, t);
  deepEqual(provider.describe().tables.map(x => x.id), ['obs', 'cells', 'msd']);
  assert.equal(provider.describe().cursor.value, 6, 'frame 3 x 2 min');

  // each step is 1 um in 2 min
  const sp = await provider.compute('obs', { x: 't', y: ['speed'], agg: 'mean' });
  assert.ok(sp.series[0].y.filter(v => v !== null).every(v => Math.abs(v - 0.5) < 1e-6));
  const pop = await provider.compute('obs', { x: 't', agg: 'count', group: 'region' });
  deepEqual(pop.series.map(s => s.label), ['A', 'B']);
  deepEqual(pop.series[0].y, [1, 1, 2, 2, 1]);
  deepEqual(pop.series[1].y, [1, 1, 1, 1, 1]);
  deepEqual(pop.series[0].x, [0, 2, 4, 6, 8], 'time in minutes');

  const cells = await provider.compute('cells', { x: 'region', y: ['straight'], agg: 'mean' });
  assert.ok(Math.abs(cells.series[0].y[0] - 1) < 1e-6, 'region A is straight');
  assert.ok(Math.abs(cells.series[0].y[1]) < 1e-6, 'the zig-zag ends where it began');
  const div = await provider.compute('cells', { x: 'divT', agg: 'count' });
  assert.equal(div.series[0].y.reduce((a, b) => a + b, 0), 1);
  assert.equal(div.series[0].x[div.series[0].y.findIndex(v => v === 1)], 4, 'divides at frame 2 -> 4 min');

  // at frame 2, cell 0 (2,0,0) and cell 2 (3,1,0) are sqrt(2) apart: neighbours within 2.5 um
  const nb = await provider.compute('obs', { x: 't', y: ['neighbors'], agg: 'max' });
  assert.equal(Math.max(...nb.series[0].y.filter(v => v !== null)), 1);

  // a straight walk of 1 um/frame: MSD(L) = L^2 um^2, lag in minutes
  const rows = G.msdRows(G.buildTracking(ctx, t));
  const c0 = [...rows.cell].map((c, i) => [c, rows.lag[i], rows.msd[i]]).filter(r => r[0] === 0);
  deepEqual(c0.map(r => [r[1], +r[2].toFixed(6)]), [[2, 1], [4, 4]]);
  const msd = await provider.compute('msd', { x: 'lag', y: ['msd'], agg: 'mean', group: 'region' });
  assert.ok(msd.series.length >= 1);
}

console.log('graphs engine: ok');
