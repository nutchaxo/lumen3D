/* Plugin hardening: the numerical cores of the tracking tools and a few edge
   cases, run for real in a vm with a minimal THREE stand-in — no DOM, no GPU.

   Locked here:
     (a) tracking-surface — the cut section is the ACTUAL contour of the mesh/plane
         intersection (a U-shaped section is not filled across its notch, a ring
         keeps its hole), the grid-bucketed kernel density and nearest-region search
         equal the brute-force definitions, and the in-place smoothing equals a
         plain two-pass Laplacian;
     (b) tracking-charts — the neighbours series from the grid equals the O(n^2)
         definition, and a series is computed once per (metric, frame, radius);
     (c) tracking-inspector — a CSV text cell that opens with = + - @ is neutralised;
     (d) histogram — an all-zero histogram paints nothing (no NaN points);
     (e) slice-inspector — a plane position of exactly 0 stays 0;
     (f) gaussian-filter — a hostile colour never reaches the markup.

   Run: node tests/js/test_plugins_audit_fixes.mjs */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT } from './harness.mjs';

let checks = 0;
const ok = (label, fn) => {
  try { fn(); } catch (err) { err.message = `${label} — ${err.message}`; throw err; }
  checks++;
};

class Color {
  constructor(hex = 0) {
    if (typeof hex === 'string') hex = parseInt(hex.replace('#', ''), 16);
    this.r = ((hex >> 16) & 255) / 255; this.g = ((hex >> 8) & 255) / 255; this.b = (hex & 255) / 255;
  }
}
const THREE_STUB = { Color };

function loadPlugin(id, extra = {}) {
  let impl = null;
  const sandbox = {
    console, Math, Number, String, Object, Array, Map, Set, WeakMap, JSON, Error, Date, Promise, Boolean, isFinite,
    Float32Array, Float64Array, Int32Array, Uint8Array, Uint32Array, Int16Array,
    PluginRegistry: { implement: (_id, obj) => { impl = obj; }, syncToolbarButton() {} },
    THREE: THREE_STUB, window: {}, document: { createElement: () => ({}) }, ...extra
  };
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(path.join(ROOT, `js/modules/${id}/index.js`), 'utf8'), sandbox, { filename: `${id}/index.js` });
  assert.ok(impl, `${id} registers`);
  return impl;
}

// Small deterministic generator, so a failure is reproducible.
let seed = 12345;
const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };

// ── (a) tracking-surface ─────────────────────────────────────────────────────
const surface = loadPlugin('tools/tracking-surface');

const polyArea = (l) => {
  let a = 0;
  for (let i = 0; i < l.length; i++) { const p = l[i], q = l[(i + 1) % l.length]; a += p.x * q.y - q.x * p.y; }
  return Math.abs(a) / 2;
};
// Segments (flat x0,y0,x1,y1) of a closed polygon given as [x,y] pairs.
const segmentsOf = (pts) => pts.flatMap((p, i) => { const q = pts[(i + 1) % pts.length]; return [p[0], p[1], q[0], q[1]]; });

ok('a square section is one closed contour of the right area', () => {
  const loops = surface._assembleLoops(segmentsOf([[0, 0], [10, 0], [10, 10], [0, 10]]));
  assert.equal(loops.length, 1);
  assert.equal(loops[0].length, 4);
  assert.equal(polyArea(loops[0]), 100);
});

ok('segments given out of order and reversed still chain into one contour', () => {
  const sq = [[0, 0], [10, 0], [10, 10], [0, 10]];
  const segs = segmentsOf(sq);
  const shuffled = [];
  const order = [2, 0, 3, 1];
  order.forEach((k, n) => {
    const s = segs.slice(k * 4, k * 4 + 4);
    shuffled.push(...(n % 2 ? [s[2], s[3], s[0], s[1]] : s));
  });
  const loops = surface._assembleLoops(shuffled);
  assert.equal(loops.length, 1);
  assert.equal(polyArea(loops[0]), 100);
});

ok('a U-shaped section keeps its notch: the region area is the U, not its convex hull', () => {
  // A 30 x 30 block with a 10-wide, 20-deep notch cut from the top.
  const U = [[0, 0], [30, 0], [30, 30], [20, 30], [20, 10], [10, 10], [10, 30], [0, 30]];
  const regions = surface._nestLoops(surface._assembleLoops(segmentsOf(U)));
  assert.equal(regions.length, 1);
  assert.equal(regions[0].holes.length, 0);
  assert.equal(polyArea(regions[0].outer), 900 - 200, 'U area = 30*30 - 10*20');
  assert.ok(polyArea(regions[0].outer) < 900, 'smaller than the convex hull (the full block)');
});

ok('a ring keeps its hole, and an island inside the hole is filled again (even-odd)', () => {
  const outer = [[0, 0], [100, 0], [100, 100], [0, 100]];
  const hole = [[20, 20], [80, 20], [80, 80], [20, 80]];
  const island = [[40, 40], [60, 40], [60, 60], [40, 60]];
  const regions = surface._nestLoops(surface._assembleLoops([outer, hole, island].flatMap(segmentsOf)));
  assert.equal(regions.length, 2, 'the ring and the island are two regions');
  const ring = regions.find(r => polyArea(r.outer) === 10000);
  const core = regions.find(r => polyArea(r.outer) === 400);
  assert.ok(ring && core);
  assert.equal(ring.holes.length, 1);
  assert.equal(polyArea(ring.holes[0]), 3600);
  assert.equal(core.holes.length, 0);
});

ok('two separate lobes stay two regions', () => {
  const a = [[0, 0], [10, 0], [10, 10], [0, 10]];
  const b = [[50, 0], [60, 0], [60, 10], [50, 10]];
  const regions = surface._nestLoops(surface._assembleLoops([a, b].flatMap(segmentsOf)));
  assert.equal(regions.length, 2);
});

ok('a degenerate or duplicated segment never makes a loop', () => {
  const segs = [0, 0, 0, 0, 1, 1, 2, 2, 1, 1, 2, 2];
  assert.equal(surface._assembleLoops(segs).length, 0);
});

// Mesh data for the colouring kernels: umPos only, plus the adjacency of a strip.
function meshData(count) {
  const umPos = new Float32Array(count * 3);
  for (let i = 0; i < count * 3; i++) umPos[i] = rand() * 300;
  return { count, umPos, values: new Float32Array(count), raw: new Float32Array(count * 3), tmp: new Float32Array(count * 3) };
}
function cellRows(n) {
  const pos = new Float32Array(n * 3);
  for (let i = 0; i < n * 3; i++) pos[i] = rand() * 300;
  const region = new Int32Array(n);
  for (let i = 0; i < n; i++) region[i] = i % 3;
  return { n, pos, region };
}

ok('grid kernel density equals the brute-force Gaussian sum', () => {
  const rows = cellRows(400), d = meshData(300), sigma = 20;
  const radius = Math.max(18, sigma * 2.8);
  surface._kernelDensity(d, rows, surface._buildGrid(rows, radius), sigma);
  for (let i = 0; i < d.count; i++) {
    let want = 0;
    for (let j = 0; j < rows.n; j++) {
      const dSq = (d.umPos[i * 3] - rows.pos[j * 3]) ** 2 + (d.umPos[i * 3 + 1] - rows.pos[j * 3 + 1]) ** 2 + (d.umPos[i * 3 + 2] - rows.pos[j * 3 + 2]) ** 2;
      if (dSq <= radius * radius) want += Math.exp(-dSq / (2 * sigma * sigma));
    }
    assert.ok(Math.abs(d.values[i] - want) < 1e-4 * Math.max(1, want), `vertex ${i}: ${d.values[i]} vs ${want}`);
  }
});

ok('grid nearest-region search equals the brute-force nearest cell', () => {
  const rows = cellRows(60), d = meshData(400);
  surface._T = { getData: () => ({ regionColors: ['#ff0000', '#00ff00', '#0000ff'] }) };
  surface._regionColors(d, rows, surface._buildGrid(rows, 40));
  const palette = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let i = 0; i < d.count; i++) {
    let best = Infinity, region = -1;
    for (let j = 0; j < rows.n; j++) {
      const dSq = (d.umPos[i * 3] - rows.pos[j * 3]) ** 2 + (d.umPos[i * 3 + 1] - rows.pos[j * 3 + 1]) ** 2 + (d.umPos[i * 3 + 2] - rows.pos[j * 3 + 2]) ** 2;
      if (dSq < best) { best = dSq; region = rows.region[j]; }
    }
    assert.deepEqual([d.raw[i * 3], d.raw[i * 3 + 1], d.raw[i * 3 + 2]], palette[region], `vertex ${i}`);
  }
});

ok('in-place smoothing equals a plain two-pass Laplacian and writes into the output', () => {
  // A path graph 0-1-2-3-4 (each edge listed from both ends) and one isolated vertex.
  const edges = [[0, 1], [1, 2], [2, 3], [3, 4]];
  const n = 6;
  const nb = Array.from({ length: n }, () => []);
  edges.forEach(([a, b]) => { nb[a].push(b); nb[b].push(a); });
  const adjStart = new Uint32Array(n + 1);
  nb.forEach((l, i) => { adjStart[i + 1] = adjStart[i] + l.length; });
  const adjList = Uint32Array.from(nb.flat());
  const d = { count: n, adjStart, adjList, tmp: new Float32Array(n * 3) };
  const src = new Float32Array(n * 3);
  for (let i = 0; i < n * 3; i++) src[i] = rand();
  const out = new Float32Array(n * 3);
  surface._smooth(d, src, out);
  let cur = Array.from(src);
  for (let it = 0; it < 2; it++) {
    const next = cur.slice();
    for (let i = 0; i < n; i++) {
      if (!nb[i].length) continue;
      for (let k = 0; k < 3; k++) {
        const mean = (cur[i * 3 + k] + nb[i].reduce((s, j) => s + cur[j * 3 + k], 0)) / (nb[i].length + 1);
        next[i * 3 + k] = cur[i * 3 + k] * 0.5 + mean * 0.5;
      }
    }
    cur = next;
  }
  for (let i = 0; i < n * 3; i++) assert.ok(Math.abs(out[i] - cur[i]) < 1e-6, `component ${i}`);
});

// ── (b) tracking-charts ──────────────────────────────────────────────────────
const charts = loadPlugin('tools/tracking-charts');

function chartFacade(frames, perFrame, radius) {
  const pts = Array.from({ length: frames }, () => Array.from({ length: perFrame }, () => [rand() * 200, rand() * 200, rand() * 200]));
  const data = {
    frameCount: frames, regionNames: ['A', 'B'], regionColors: ['#111111', '#222222'], timepoints: Array.from({ length: frames }, (_, i) => i),
    regionIdx: Int32Array.from({ length: perFrame }, (_, i) => i % 2), cellTotal: perFrame
  };
  let calls = 0;
  const T = {
    getData: () => data, getOptions: () => ({ neighborThresholdUm: radius }), isStabilized: () => true,
    cellsAt: () => Array.from({ length: perFrame }, (_, i) => i),
    positionUm: (c, f, o, out) => { const r = out || [0, 0, 0]; const p = pts[f][c]; r[0] = p[0]; r[1] = p[1]; r[2] = p[2]; return r; },
    counter: () => calls, bump: () => { calls++; }
  };
  return { T, pts, data };
}

ok('neighbour series from the grid equals the all-pairs definition', () => {
  const radius = 45;
  const { T, pts, data } = chartFacade(5, 120, radius);
  charts._T = T;
  const got = charts.series('neighbors', data, { neighborThresholdUm: radius });
  for (const row of got) {
    const r = row.region === 'A' ? 0 : 1;
    row.y.forEach((value, f) => {
      let sum = 0, n = 0;
      for (let i = 0; i < pts[f].length; i++) {
        if (i % 2 !== r) continue;
        let count = 0;
        for (let j = 0; j < pts[f].length; j++) {
          if (i === j) continue;
          if (Math.hypot(...pts[f][i].map((v, k) => v - pts[f][j][k])) <= radius) count++;
        }
        sum += count; n++;
      }
      assert.ok(Math.abs(value - sum / n) < 1e-9, `region ${row.region}, frame ${f}: ${value} vs ${sum / n}`);
    });
  }
});

ok('a series is computed once per metric, frame of reference and radius', () => {
  const { T } = chartFacade(3, 20, 55);
  charts._T = T;
  charts._cache = null;
  let computed = 0;
  const original = charts.series.bind(charts);
  charts.series = (...a) => { computed++; return original(...a); };
  charts._cachedSeries('neighbors');
  charts._cachedSeries('neighbors');
  assert.equal(computed, 1, 'second call served from the cache');
  T.getOptions = () => ({ neighborThresholdUm: 85 });
  charts._cachedSeries('neighbors');
  assert.equal(computed, 2, 'a new radius is a new series');
  T.isStabilized = () => false;
  charts._cachedSeries('neighbors');
  charts._cachedSeries('neighbors');
  assert.equal(computed, 3, 'the other frame of reference is another series');
  charts.series = original;
});

// ── (c) tracking-inspector CSV ───────────────────────────────────────────────
const inspector = loadPlugin('tools/tracking-inspector');
ok('a CSV text cell that starts a formula is made plain text; numbers are untouched', () => {
  const csv = inspector._csv([['=cmd()', '+1', '-x', '@sum', 'plain', -3.5, 7]]);
  assert.equal(csv, `"'=cmd()","'+1","'-x","'@sum","plain","-3.5","7"`);
});

// ── (d) histogram ────────────────────────────────────────────────────────────
const histogram = loadPlugin('channels/histogram');
ok('an all-zero histogram paints nothing', () => {
  const node = { innerHTML: 'stale' };
  const container = { querySelector: (sel) => (sel.startsWith('#ch-hist') ? node : { style: {} }) };
  histogram._renderHistogram(0, { enabled: true, color: '#fff' }, container, () => [{ counts: new Array(256).fill(0), total: 0 }]);
  assert.equal(node.innerHTML, '');
  assert.ok(!/NaN/.test(node.innerHTML));
});

// ── (e) slice-inspector ──────────────────────────────────────────────────────
const sliceInspector = loadPlugin('tools/slice-inspector');
ok('a plane position of 0 stays 0 after a sync', () => {
  const els = {};
  const document = { getElementById: (id) => (els[id] || (els[id] = { value: '', textContent: '' })) };
  const plugin = loadPlugin('tools/slice-inspector', { document });
  plugin._ctx = { slicer: { getPlaneSpec: () => ({ value: 0, yaw: 0, pitch: 0, roll: 0, slabThickness: 1 }) } };
  plugin._syncSlidersFromSpec();
  assert.equal(els['slicer-position'].value, 0);
  assert.equal(els['slicer-val-pos'].textContent, '0.00');
  plugin._ctx = { slicer: { getPlaneSpec: () => ({}) } };
  plugin._syncSlidersFromSpec();
  assert.equal(els['slicer-position'].value, 50, 'a missing value is the middle');
});
void sliceInspector;

// ── (f) gaussian-filter ──────────────────────────────────────────────────────
const gaussian = loadPlugin('channels/gaussian-filter');
ok('a hostile channel colour never reaches the markup', () => {
  const html = gaussian.getChannelUI({ idx: 0, color: '#fff;"><img src=x onerror=alert(1)>', denoise_sigma: 'x"y' });
  assert.ok(!html.includes('<img'), 'no injected element');
  assert.ok(!html.includes('onerror'));
  assert.ok(html.includes('value="0"'));
  const good = gaussian.getChannelUI({ idx: 1, color: '#00ffaa', denoise_sigma: 1.5 });
  assert.ok(good.includes('accent-color: #00ffaa'));
  assert.ok(good.includes('value="1.5"'));
});

// ── manifests ────────────────────────────────────────────────────────────────
ok('plugin versions are valid semver', () => {
  for (const id of ['tools/tracking-surface', 'tools/tracking-charts', 'tools/tracking-trails', 'tools/tracking-inspector',
    'tools/tracking-measure', 'tools/chunk-debug', 'tools/slice-inspector', 'tools/measure-distance', 'tools/orientation-axes',
    'tools/zstack-browser', 'tools/screenshot', 'channels/histogram', 'channels/gaussian-filter']) {
    const meta = JSON.parse(readFileSync(path.join(ROOT, `js/modules/${id}/plugin.json`), 'utf8'));
    assert.match(meta.version, /^\d+\.\d+\.\d+$/, id);
  }
});

console.log(`test_plugins_audit_fixes: ${checks} checks passed`);
