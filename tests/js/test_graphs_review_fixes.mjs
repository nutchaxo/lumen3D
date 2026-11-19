// Graphs plugin — what the adversarial review of web 1.82 found and what was added after it:
// edge planes in floor-mode bins, flat counts per bin, normalisation by a non-positive base,
// textbook Manders, CSV formulas, exact neighbour counts, trajectories with frame gaps, the
// MSD sample, strict variable checks for Compare, unaliased scatter, escaped Plotly text,
// a marker per series, the line-profile table and the panel's release / key operations.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT } from './harness.mjs';

function loadPlugin(win = {}) {
  let impl = null;
  const ctx = {
    console, Math, Number, String, Object, Array, Map, Set, JSON, Error, Date, Promise, Symbol, RegExp, Intl,
    Float32Array, Float64Array, Int32Array, Int16Array, Uint8Array, Uint8ClampedArray, Uint16Array, Uint32Array,
    AbortController, setTimeout, clearTimeout, Blob, atob,
    PluginRegistry: { implement: (_id, obj) => { impl = obj; }, syncToolbarButton() {} },
    window: win, document: { documentElement: { getAttribute: () => null } },
    Utils: { trustedTargetOrigin: () => 'http://x', isTrustedMessageOrigin: () => true }
  };
  vm.createContext(ctx);
  vm.runInContext(readFileSync(path.join(ROOT, 'js/modules/tools/graphs/index.js'), 'utf8'), ctx, { filename: 'graphs/index.js' });
  assert.ok(impl);
  return impl;
}

const G = loadPlugin();
const { Engine } = G;
const same = (a, b, m) => assert.equal(JSON.stringify(a), JSON.stringify(b), m);
const t = (k, p) => (p ? `${k}:${JSON.stringify(p)}` : k);
const near = (a, b, eps, m) => assert.ok(Math.abs(a - b) <= eps, `${m || ''} ${a} vs ${b}`);

// ── 1. Floor-mode bins keep the first and the last plane ─────────────────────────────────
{
  const axisTable = (dim, size, rel) => {
    const scale = rel ? 100 / dim : size;
    const dom = rel ? [50 / dim, 100 - 50 / dim] : [0.5 * size, (dim - 0.5) * size];
    return {
      id: 'v', n: dim, cols: {}, lazy: { a: { fill: 'axis', dims: [dim, 1, 1], axis: 0, scale } },
      vars: [{ id: 'a', label: 'a', kind: 'num', dom, ...(rel ? { bins: 50 } : {}) }],
      defaults: { x: 'a' }
    };
  };
  // Dimensions the review measured losing a plane (512 px at 0.7 µm, 401 / 500 / 768 relative...).
  const cases = [[512, 0.7, false, 0], [1000, 0.325, false, 0], [2048, 0.21, false, 0], [777, 0.13, false, 0],
    [401, 0, true, 50], [500, 0, true, 50], [768, 0, true, 50], [72, 0, true, 50], [5735, 0, true, 50]];
  for (const [dim, size, rel, bins] of cases) {
    const r = Engine.compute(axisTable(dim, size, rel), { x: 'a', agg: 'count', bins });
    const total = r.series[0].y.reduce((a, b) => a + b, 0);
    assert.equal(total, dim, `every plane is counted (dim ${dim}, rel ${rel}, bins ${bins}): ${total}`);
  }
}

// ── 2. Grouped steps: every bin holds as many planes as the others ───────────────────────
{
  const dz = 300, n = dz;
  const tb = {
    id: 'v', n, cols: { c: new Uint8Array(n).fill(200) },
    lazy: { zr: { fill: 'axis', dims: [dz, 1, 1], axis: 0, scale: 100 / dz } },
    vars: [{ id: 'zr', label: 'z', kind: 'num', dom: [50 / dz, 100 - 50 / dz], step: 100 / dz, bins: 50 },
      { id: 'c', label: 'c', kind: 'num', dom: [0, 255], step: 1, intensity: true, ch: true }],
    unitSize: 1, measureUnit: 'µm³', defaults: { x: 'zr' }
  };
  const r = Engine.compute(tb, { x: 'zr', y: ['c'], agg: 'measure', bins: 50 });
  const y = r.series[0].y;
  assert.equal(new Set(y).size, 1, `a flat signal volume per bin, not a sawtooth: ${[...new Set(y)]}`);
  assert.equal(y.reduce((a, b) => a + b, 0), n, 'nothing lost');
  assert.equal(r.series[0].x.length, y.length);
  // an intensity histogram of a uniform byte column: all bins alike but the last, which is short
  const m = 256 * 100;
  const hist = { id: 'h', n: m, cols: { c: Uint8Array.from({ length: m }, (_, i) => i % 256) }, lazy: {},
    vars: [{ id: 'c', label: 'c', kind: 'num', dom: [0, 255], step: 1, bins: 64, intensity: true, ch: true }], defaults: { x: 'c' } };
  const h = Engine.compute(hist, { x: 'c', agg: 'count', bins: 50 }).series[0].y;
  assert.equal(new Set(h.slice(0, -1)).size, 1, 'bins of equal width hold equal counts');
  assert.equal(h.reduce((a, b) => a + b, 0), m);
}

// ── 3. Normalising by a non-positive base leaves the series alone ────────────────────────
{
  const tb = { id: 'x', n: 4, cols: { v: Float32Array.from([-4, -2, -1, -3]), k: Uint8Array.from([0, 1, 2, 3]) }, lazy: {},
    vars: [{ id: 'k', label: 'k', kind: 'num', dom: [0, 3], step: 1 }, { id: 'v', label: 'v', kind: 'num' }], defaults: { x: 'k' } };
  const raw = Engine.compute(tb, { x: 'k', y: ['v'], agg: 'mean', normalize: 'none' }).series[0].y;
  same(Engine.compute(tb, { x: 'k', y: ['v'], agg: 'mean', normalize: 'max' }).series[0].y, raw, "'max' of all-negative values: unchanged, not sign-flipped");
  same(Engine.compute(tb, { x: 'k', y: ['v'], agg: 'mean', normalize: 'first' }).series[0].y, raw, "'first' negative: unchanged");
}

// ── 4. Manders: textbook denominators; Pearson stays on the signal mask ──────────────────
{
  const a = Uint8Array.from([10, 20, 3, 2]), b = Uint8Array.from([0, 20, 30, 0]);
  const tb = { id: 'c', n: 4, cols: { a, b }, lazy: {},
    vars: [{ id: 'a', label: 'a', kind: 'num', dom: [0, 255], intensity: true, ch: true }, { id: 'b', label: 'b', kind: 'num', dom: [0, 255], intensity: true, ch: true }], defaults: { x: 'a' } };
  const s = Engine.compute(tb, { x: 'a', y: ['b'], agg: 'density', threshold: 5, bins: 8 }).heat.stats;
  near(s.m1, 23 / 35, 1e-12, 'M1 = Σ a where b > thr / Σ a');
  near(s.m2, 20 / 50, 1e-12, 'M2 = Σ b where a > thr / Σ b');
}

// ── 5. CSV: a text cell a spreadsheet would run as a formula is neutralised ──────────────
{
  const res = { x: { label: 'X' }, series: [{ ds: { name: '=HYPERLINK("http://e","x")' }, label: '+cmd|calc', x: ['@a'], y: [-3], sd: null, n: null }] };
  const lines = Engine.toCsv(res).trim().split('\n');
  assert.ok(lines[1].startsWith(`"'=HYPERLINK(""http://e"",""x"")",'+cmd|calc,'@a,-3`), lines[1]);
  assert.equal(lines[0], 'dataset,series,X,y,sd,n', 'the header is escaped like any cell');
}

// ── 6. Neighbours: exact counts, no hash collision ───────────────────────────────────────
{
  const brute = (x, y, z, r) => x.map((_, i) => { let c = 0; for (let j = 0; j < x.length; j++) { if (j !== i && (x[i] - x[j]) ** 2 + (y[i] - y[j]) ** 2 + (z[i] - z[j]) ** 2 <= r * r) c++; } return c; });
  const run = (x, y, z, frame, r) => {
    const N = x.length, F = Math.max(...frame) + 1;
    const tr = { N, F, obs: { cols: { frame: Uint16Array.from(frame), x: Float32Array.from(x), y: Float32Array.from(y), z: Float32Array.from(z) } } };
    return Array.from(G.neighbourColumn({ tracking: { getOptions: () => ({ neighborThresholdUm: r }) } }, tr));
  };
  // the review's collision: two cells 0.3 µm apart must see each other once
  same(run([20.0, 19.9], [9.9, 10.1], [9.9, 10.1], [0, 0], 10), [1, 1]);
  // random cells over several frames, small and large radii, against brute force
  let seed = 12345;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
  for (const r of [20, 55, 150]) {
    const N = 600, x = [], y = [], z = [], frame = [];
    for (let i = 0; i < N; i++) { x.push(rnd() * 400); y.push(rnd() * 400); z.push(rnd() * 200 - 20); frame.push(i % 3); }
    const got = run(x, y, z, frame, r);
    for (let f = 0; f < 3; f++) {
      const idx = frame.map((q, i) => (q === f ? i : -1)).filter(i => i >= 0);
      const want = brute(idx.map(i => x[i]), idx.map(i => y[i]), idx.map(i => z[i]), r);
      same(idx.map(i => got[i]), want, `radius ${r}, frame ${f}`);
    }
  }
}

// ── 7. A trajectory with missing frames: the path counts the jump, the speed does not ────
{
  const F = 8;
  const pos = { 0: [null, [0, 0, 0], [1, 0, 0], null, null, [10, 0, 0], [10, 1, 0], null] };
  const data = {
    frameCount: F, cellTotal: 1, timepoints: Float64Array.from({ length: F }, (_, i) => i),
    regionNames: ['A'], regionColors: ['#ff0000'], regionIdx: Int16Array.from([0]),
    firstFrame: Int32Array.from([1]), lastFrame: Int32Array.from([6]),
    flags: Uint8Array.from([0]), daughterStart: Uint32Array.from([0, 0]), daughterIdx: Uint32Array.from([])
  };
  const ctx = {
    dataset: { getMeta: () => ({ type: 'live', dimensions: { t: F }, timeline: { intervalMinutes: 10 } }), getId: () => 'live/G' },
    tracking: { isStabilized: () => true, getData: () => data,
      positionUm: (c, f, o, out) => { const p = pos[c][f]; if (!p) return null; out[0] = p[0]; out[1] = p[1]; out[2] = p[2]; return out; } }
  };
  const tr = G.buildTracking(ctx, t);
  const c = tr.cells.cols;
  near(c.path[0], 1 + 9 + 1, 1e-4, 'path counts the straight jump over the gap');
  assert.ok(c.straight[0] <= 1 && c.straight[0] > 0.9, `net / path ≤ 1: ${c.straight[0]}`);
  near(c.meanSpeed[0], 2 / (2 * 10), 1e-6, 'speed only from consecutive frames');
  near(c.lifetime[0], 60, 1e-6);
  // time as a share of the acquisition, per row and for the division time column
  same(Array.from(tr.obs.cols.tr).map(v => +v.toFixed(3)), [1, 2, 5, 6].map(f => +((f / 7) * 100).toFixed(3)));
}

// ── 8. MSD: past the budget a sample of the cells, every lag kept ────────────────────────
{
  const NC = 7000, L = 100, F = 200, N = NC * L;
  const frame = new Uint16Array(N), x = new Float32Array(N), y = new Float32Array(N), z = new Float32Array(N), region = new Int16Array(N);
  for (let c = 0; c < NC; c++) for (let k = 0; k < L; k++) { frame[c * L + k] = k; x[c * L + k] = k; }
  const rowStart = Uint32Array.from({ length: NC + 1 }, (_, i) => i * L);
  const m = G.msdRows({ NC, F, dt: 2, rowStart, obs: { cols: { frame, x, y, z, region } } });
  assert.equal(m.sampled, true, 'the budget is exceeded: sampled');
  let maxLag = 0;
  for (let i = 0; i < m.n; i++) if (m.lag[i] > maxLag) maxLag = m.lag[i];
  assert.equal(maxLag, 99 * 2, 'the longest lag survives (no truncation of the lags)');
  near(m.msd[0], 1, 1e-6, 'lag 1 of a 1 µm / frame walk');
  const small = G.msdRows({ NC: 2, F: 10, dt: 1, rowStart: Uint32Array.from([0, 5, 10]), obs: { cols: { frame: Uint16Array.from([0, 1, 2, 3, 4, 0, 1, 2, 3, 4]), x: new Float32Array(10), y: new Float32Array(10), z: new Float32Array(10), region: new Int16Array(10) } } });
  assert.equal(small.sampled, false);
}

// ── 9. Compare: a panel that lacks a variable refuses instead of answering something else ─
{
  const tb = { vars: [{ id: 'zr' }, { id: 'ch_dapi' }, { id: 'region', kind: 'cat' }] };
  assert.doesNotThrow(() => Engine.checkSpec(tb, { x: 'zr', y: ['ch_dapi', '@int', '@int[1]'], group: 'region' }));
  assert.doesNotThrow(() => Engine.checkSpec(tb, { x: '@int', y: [] }));
  assert.throws(() => Engine.checkSpec(tb, { x: 'zr', y: ['ch_gfp'] }), (e) => e.code === 'NO_VARIABLE');
  assert.throws(() => Engine.checkSpec(tb, { x: 'ch_gfp', y: ['ch_dapi'] }), (e) => e.code === 'NO_VARIABLE');
  assert.throws(() => Engine.checkSpec(tb, { x: 'zr', group: 'line' }), (e) => e.code === 'NO_VARIABLE');
}

// ── 10. A scatter is not a stride through the rows ───────────────────────────────────────
{
  const n = 60000;
  const tb = { id: 'p', n, cols: { a: Float32Array.from({ length: n }, (_, i) => i % 3), b: new Float32Array(n) }, lazy: {},
    vars: [{ id: 'a', label: 'a', kind: 'num' }, { id: 'b', label: 'b', kind: 'num' }], defaults: { x: 'a' } };
  const r = Engine.compute(tb, { x: 'a', y: ['b'], agg: 'points' });
  const xs = new Set(r.series[0].x);
  assert.equal(xs.size, 3, 'a layout that repeats every 3 rows is not aliased by a stride of 3');
  assert.ok(r.series[0].x.length > 15000 && r.series[0].x.length <= 25000, `about the budget: ${r.series[0].x.length}`);
}

// ── 11. The plot: escaped text, a marker per series, the language's separators ───────────
{
  const evil = '<img src=x onerror=alert(1)>';
  const res = { kind: 'xy', x: { id: 'a', label: evil, unit: '', cat: false }, y: { agg: 'mean', label: evil, unit: '' }, spec: {},
    series: [{ label: evil, x: [1, 2], y: [1, 2], color: null }, { label: 'b', x: [1, 2], y: [2, 3], color: null }] };
  const plot = G.buildPlot(res, { t, dark: false, separators: ', ' });
  for (const d of plot.data) assert.ok(!/[<>]/.test(d.name), `name has no markup: ${d.name}`);
  assert.ok(!/[<>]/.test(plot.layout.xaxis.title.text) && !/[<>]/.test(plot.layout.yaxis.title.text), 'titles are escaped');
  assert.notEqual(plot.data[0].marker.symbol, plot.data[1].marker.symbol, 'two series on one dataset differ by marker');
  assert.equal(plot.layout.separators, ', ');
  const bar = G.buildPlot({ kind: 'bar', x: { id: 'r', label: 'r', cat: true }, y: { agg: 'count' }, spec: {}, series: [{ label: 's', x: [evil], y: [1], color: null }] }, { t });
  assert.ok(!/[<>]/.test(bar.data[0].x[0]), 'category labels are escaped');
  const heat = G.buildPlot({ kind: 'heat', x: {}, y: {}, spec: {}, heat: { x: [1], y: [1], z: [[1]], xLabel: evil, yLabel: evil, xUnit: '', yUnit: '', stats: { n: 1, pearson: 0.5, both: true, m1: 0.25, m2: 0.75 } } }, { t, nf: (v, d) => v.toFixed(d).replace('.', ',') });
  assert.ok(heat.layout.annotations[0].text.includes('r = 0,500'), heat.layout.annotations[0].text);
  assert.ok(!/[<>]/.test(heat.data[0].hovertemplate.replace(/<br>|<extra>|<\/extra>/g, '')), 'hover labels are escaped');
}

// ── 12. A data: URL becomes a Blob without fetch() (the CSP refuses that fetch) ──────────
{
  assert.equal(typeof G.dataUrlToBlob, 'function');
  const blob = G.dataUrlToBlob('data:image/png;base64,iVBORw0KGgo=');
  assert.equal(blob.type, 'image/png');
  assert.equal(blob.size, 8);
  assert.equal(G.separatorsFor('fr').length, 2);
  assert.equal(G.separatorsFor('en'), '.,');
}

// ── 13. Intensity along a measurement line ───────────────────────────────────────────────
{
  const dims = { x: 8, y: 4, z: 4 };
  const vs = { x: 2, y: 2, z: 2 };
  const reads = [];
  const lines = [
    { id: 'm1', label: 'Measure 1', color: '#ff4d4f', visible: true, points: [{ physicalUm: { x: 3, y: 5, z: 5 } }, { physicalUm: { x: 13, y: 5, z: 5 } }] },
    { id: 'm2', label: 'Hidden', color: '#00ff00', visible: false, points: [{ physicalUm: { x: 1, y: 1, z: 1 } }, { physicalUm: { x: 5, y: 1, z: 1 } }] },
    { id: 'm3', label: 'Not a line', points: [{ physicalUm: { x: 1, y: 1, z: 1 } }] }
  ];
  const ctx = {
    dataset: { getMeta: () => ({ type: '3d', name: 'L', dimensions: { c: 2 }, channels: [{ name: 'A', color: '#00AAFF' }, { name: 'B', color: '#00FF00' }] }), getId: () => '3d/L' },
    measurements: { list: () => lines },
    data: {
      info: () => ({ channels: 2 }),
      levels: () => [{ level: 0, dims, voxelSize: vs }],
      displayedTree: () => ({ path: 'DATA_WEB/3d/L/bricks', manifest: {} }),
      readRegion: async (box, chans) => {
        reads.push(box);
        const w = box.x1 - box.x0, h = box.y1 - box.y0, d = box.z1 - box.z0;
        const a = new Float32Array(w * h * d), b = new Float32Array(w * h * d).fill(255);
        for (let z = 0; z < d; z++) for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) a[(z * h + y) * w + x] = (box.x0 + x) * 10;
        return { dims: { x: w, y: h, z: d }, data: [a, b] };
      }
    }
  };
  const provider = G.createProvider(ctx, t);
  const d = provider.describe();
  same(d.tables.map(x => x.id), ['voxels', 'line']);
  const lineTable = d.tables.find(x => x.id === 'line');
  same(lineTable.vars.find(v => v.id === 'line').cats.names, ['Measure 1'], 'only a visible two-point measurement is a line');
  const r = await provider.compute('line', { x: 'd', y: ['ch_a'], agg: 'mean', group: 'line' });
  assert.equal(r.series.length, 1);
  same(r.series[0].x, [0, 2, 4, 6, 8, 10], 'one sample per voxel step along the 10 µm line');
  // voxel centres at 1, 3, 5 ... µm: the line starts at 3 µm = the centre of voxel 1 (value 10)
  same(r.series[0].y, [10, 20, 30, 40, 50, 60]);
  assert.equal(r.series[0].color, '#ff4d4f', "the measurement's own colour");
  // halfway between two centres the value is the trilinear one
  const half = await provider.compute('line', { x: 'dr', y: ['ch_a'], agg: 'mean', bins: 2 });
  assert.ok(half.series[0].y.every(v => v > 10 && v < 60));
  assert.equal(reads.length, 1, 'the lines are read once for a state');
  assert.ok((reads[0].x1 - reads[0].x0) <= dims.x && (reads[0].y1 - reads[0].y0) <= dims.y, 'only the box around the lines');
  assert.match(r.info.lines + '', /1/);
  // measurements come and go: the description follows
  const before = provider.schemaSig();
  lines.length = 0;
  assert.notEqual(provider.schemaSig(), before);
  same(provider.describe().tables.map(x => x.id), ['voxels']);
}

// ── 14. The panel side of Compare: describe, key, a strict compute, release ──────────────
{
  const handlers = [];
  const posted = [];
  const win = { addEventListener: (type, fn) => { if (type === 'message') handlers.push(fn); }, removeEventListener() {} };
  win.parent = { postMessage: (msg) => posted.push(msg) };
  const P = loadPlugin(win);
  const dims = { x: 4, y: 2, z: 3 };
  let reads = 0;
  const ctx = {
    context: undefined,
    i18n: { t: (k) => k, getLanguage: () => 'en', onLanguageChange: () => () => {} },
    iframe: { isIframe: () => true, panelIndex: () => 2 },
    dataset: { getMeta: () => ({ type: '3d', name: 'P', dimensions: { c: 2 }, channels: [{ name: 'A' }, { name: 'B' }] }), getId: () => '3d/P' },
    data: {
      info: () => ({ channels: 2 }),
      levels: () => [{ level: 0, dims, voxelSize: { x: 1, y: 1, z: 1 } }],
      displayedTree: () => ({ path: 'p/bricks', manifest: {} }),
      readRegion: async () => { reads++; const n = 24; return { dims, data: [new Uint8Array(n).fill(7), new Uint8Array(n).fill(9)] }; }
    }
  };
  P.init(ctx);
  assert.equal(handlers.length, 1, 'the panel listens for the host');
  const ask = async (msg) => {
    const before = posted.length;
    handlers[0]({ source: win.parent, origin: 'http://x', data: { type: 'REQUEST_GRAPH_DATA', requestId: msg.op + posted.length, ...msg } });
    for (let i = 0; i < 40 && posted.length === before; i++) await new Promise(r => setTimeout(r, 5));
    return posted[posted.length - 1];
  };
  const desc = await ask({ op: 'describe' });
  assert.equal(desc.ok, true);
  assert.equal(desc.sourceIndex, 2);
  same(desc.description.tables.map(x => x.id), ['voxels']);

  const missing = await ask({ op: 'compute', table: 'voxels', spec: { x: 'zr', y: ['ch_gfp'], agg: 'mean' } });
  assert.equal(missing.ok, false);
  assert.equal(missing.code, 'NO_VARIABLE', 'a panel without the variable refuses');
  assert.equal(reads, 0, 'and reads nothing');

  const ok = await ask({ op: 'compute', table: 'voxels', spec: { x: 'zr', y: ['ch_a'], agg: 'mean' } });
  assert.equal(ok.ok, true);
  assert.equal(ok.result.series[0].label, 'A');
  assert.ok(typeof ok.key === 'string' && ok.key.includes('p/bricks'), `the answer names the state it was computed for: ${ok.key}`);
  const key = await ask({ op: 'key', table: 'voxels' });
  assert.equal(key.key, ok.key);
  assert.equal(reads, 1);

  const rel = await ask({ op: 'release' });
  assert.equal(rel.ok, true);
  await ask({ op: 'compute', table: 'voxels', spec: { x: 'zr', y: ['ch_a'], agg: 'mean' } });
  assert.equal(reads, 2, 'a released panel reads its table again');
  const foreign = await ask({ op: 'compute', table: 'voxels', spec: null });
  assert.ok(foreign, 'a malformed spec is answered, not thrown');
}

console.log('graphs review fixes: ok');

// ── 15. Several channels and a group: the colour is the channel's, the group is a dash ───
{
  const tb = {
    id: 'g', n: 4, cols: { a: Float32Array.from([1, 2, 3, 4]), b: Float32Array.from([4, 3, 2, 1]), k: Uint8Array.from([0, 1, 0, 1]), grp: Uint8Array.from([0, 0, 1, 1]) }, lazy: {},
    vars: [
      { id: 'k', label: 'k', kind: 'num', dom: [0, 1], step: 1 },
      { id: 'a', label: 'A', kind: 'num', color: '#2a78d6' }, { id: 'b', label: 'B', kind: 'num', color: '#eb6834' },
      { id: 'grp', label: 'Line', kind: 'cat', cats: { names: ['one', 'two'], colors: ['#ff4d4f', '#ff4d4f'] } }
    ], defaults: { x: 'k' }
  };
  const r = Engine.compute(tb, { x: 'k', y: ['a', 'b'], agg: 'mean', group: 'grp' });
  assert.equal(r.series.length, 4);
  assert.equal(new Set(r.series.map(s => s.color)).size, 2, 'colour = the channel, not the (identical) group colour');
  const plot = G.buildPlot(r, { t, dark: false });
  const lines = plot.data.filter(d => d.line);
  assert.equal(new Set(lines.map(d => d.line.dash)).size, 2, 'the two groups of a channel differ by dash');
  // one Y and a group keeps the group colour
  const one = Engine.compute(tb, { x: 'k', y: ['a'], agg: 'mean', group: 'grp' });
  assert.equal(one.series[0].color, '#ff4d4f');
}
console.log('graphs review fixes (colours): ok');

// ── 16. What a Compare round sends: shared channels by id, or each panel's own ───────────
{
  const mk = (total, chans) => ({ total, vars: [{ id: 'zr' }, ...chans.map(([id, n]) => ({ id, ch: true, haveCount: n }))] });
  // two datasets sharing DAPI only
  const shared = mk(2, [['ch_dapi', 2], ['ch_gfp', 1], ['ch_rfp', 1]]);
  let r = G.specForPanels({ x: 'zr', y: ['@int'], agg: 'mean' }, shared);
  same(r.sent.y, ['ch_dapi'], 'every channel = the shared ones');
  assert.equal(r.unresolved, false);
  r = G.specForPanels({ x: '@int', y: [], agg: 'count' }, shared);
  same(r.sent.only, ['ch_dapi']);
  assert.equal(r.sent.x, '@int');
  // no channel in common: the token stays, every panel takes its own channels (never a union they lack)
  const none = mk(3, [['ch_a', 1], ['ch_b', 1], ['ch_c', 1]]);
  r = G.specForPanels({ x: 'zr', y: ['@int'], agg: 'mean' }, none);
  same(r.sent.y, ['@int'], 'the token is kept');
  assert.equal(r.sent.only, null);
  r = G.specForPanels({ x: '@int[0]', y: ['@int[1]'], agg: 'density' }, none);
  assert.equal(r.unresolved, true, 'a co-localisation needs two shared channels');
  r = G.specForPanels({ x: '@int[0]', y: ['@int[1]'], agg: 'density' }, mk(2, [['ch_dapi', 2], ['ch_gfp', 2]]));
  assert.equal(r.sent.x, 'ch_dapi'); same(r.sent.y, ['ch_gfp']);
  assert.equal(r.unresolved, false);
  // a lone dataset: all of its channels
  same(G.sharedChannels(mk(1, [['ch_a', 1], ['ch_b', 1]])), ['ch_a', 'ch_b']);
  // what the chips show when nothing is shared: all of them (each dataset draws its own)
  same(G.commonChannels(none), ['ch_a', 'ch_b', 'ch_c']);
}
console.log('graphs review fixes (compare spec): ok');

// ── 17. A state restored before the tables are described survives the description ────────
{
  const boxes = {
    '[data-g="controls"]': { innerHTML: '' }, '[data-g="status"]': { textContent: '', style: {} },
    '[data-g="notes"]': { innerHTML: '' }, '[data-g="plot"]': { id: 'plot' }
  };
  const root = { querySelector: (sel) => boxes[sel] || null, contains: () => false, addEventListener() {}, removeEventListener() {} };
  const tables = [];
  const description = { tables: [{ id: 'voxels', label: 'Volume', defaults: { x: 'zr', y: ['@int'], agg: 'mean' }, presets: [{ id: 'zProfile', spec: { x: 'zr', y: ['@int'], agg: 'mean' } }],
    vars: [{ id: 'zr', label: 'Z', unit: '', kind: 'num' }, { id: 'ch_a', label: 'A', kind: 'num', ch: true, intensity: true }] }] };
  const ui = G.createUI(root, { t, multi: false, describe: () => ({ tables }), compute: () => new Promise(() => {}), cursor: () => null });
  // the Compare restore: setState first (draw: true — the drawer is open), the description a moment later
  ui.setState({ table: 'voxels', spec: { x: 'zr', y: ['ch_a'], agg: 'measure', threshold: 12 }, preset: null }, { draw: true });
  assert.equal(ui.getState().spec.agg, 'measure', 'kept while waiting');
  // the panels are still loading: a description without any table must not eat the saved choices
  ui.refreshDescription();
  assert.equal(ui.getState().spec.agg, 'measure', 'kept through an empty description');
  tables.push(...description.tables);
  ui.refreshDescription();
  const st = ui.getState();
  assert.equal(st.table, 'voxels');
  assert.equal(st.spec.agg, 'measure', 'not replaced by the first preset');
  assert.equal(st.spec.threshold, 12);
  same(st.spec.y, ['ch_a']);
  // a variable the description does not have is dropped (the dataset that had it is gone)
  ui.setState({ table: 'voxels', spec: { x: 'ch_gone', y: ['ch_gone', 'ch_a'], group: 'nope', agg: 'mean' } });
  const s2 = ui.getState().spec;
  assert.equal(s2.x, 'zr', 'an unknown X falls back to the table default');
  same(s2.y, ['ch_a']);
  assert.equal(s2.group, null);
  ui.destroy();
}
console.log('graphs review fixes (restore): ok');
