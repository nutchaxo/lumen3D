/* The cell-tracking tools of a timelapse: the loader worker's packing and the
   analysis the plugins compute from it (inspector, charts, cell distance), run
   for real on a synthetic tracks.json — no DOM, no THREE, no browser.

   What is locked here:
     (a) tracks-load-worker.packTracks — per-frame tables (counts, slots), the
         per-cell tables (lineage as a CSR list, event flags, regions, life span)
         and cellFrameSlot, the one lookup every plugin relies on;
     (b) tracking-inspector — cellMetrics / neighborRows / lineage / findCell /
         velocityRows over a ctx.tracking façade built on those tables;
     (c) tracking-charts — the four series (population, velocity, neighbours,
         mitoses), per region, in timepoint order;
     (d) tracking-measure — a follow-cells measurement re-resolved at a frame
         where one cell is missing reports 'out-of-frame';
     (e) the plugin manifests: every tracking plugin is a `live`-only tool that
         hides itself without a tracking block, and the tool ids do not collide.

   Run: node tests/js/test_tracking_plugins.mjs */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT } from './harness.mjs';

let checks = 0;
// Values built inside another vm realm (the worker's, a plugin's) have foreign
// prototypes; deepEqual is strict about that, so compare their JSON shape.
const plain = (v) => JSON.parse(JSON.stringify(v));
const ok = (label, fn) => {
  try { fn(); } catch (err) { err.message = `${label} — ${err.message}`; throw err; }
  checks++;
};

// ── the worker, evaluated with a `self` stub so packTracks is reachable ──────
function loadWorker() {
  const ctx = { console, Math, Number, String, Object, Array, Map, Set, JSON, Error,
    Float32Array, Float64Array, Int16Array, Int32Array, Uint8Array, Uint16Array };
  ctx.self = { postMessage() {} };
  vm.createContext(ctx);
  vm.runInContext(readFileSync(path.join(ROOT, 'js/workers/tracks-load-worker.js'), 'utf8'), ctx, { filename: 'tracks-load-worker.js' });
  return ctx.self.packTracks;
}

// A plugin's implementation object, captured from PluginRegistry.implement().
function loadPlugin(id) {
  let impl = null;
  const ctx = { console, Math, Number, String, Object, Array, Map, Set, JSON, Error, Date, Promise,
    Float32Array, Float64Array, Int32Array, Uint8Array,
    PluginRegistry: { implement: (_id, obj) => { impl = obj; }, syncToolbarButton() {} },
    document: { createElement() { return { appendChild() {}, querySelector() { return null; }, style: {} }; }, head: { appendChild() {} } },
    window: {}, THREE: undefined };
  vm.createContext(ctx);
  vm.runInContext(readFileSync(path.join(ROOT, `js/modules/tools/${id}/index.js`), 'utf8'), ctx, { filename: `${id}/index.js` });
  assert.ok(impl, `${id} calls PluginRegistry.implement`);
  return impl;
}

// The same façade viewer.js builds (ctx.tracking), over the packed tables.
function makeFacade(data, opts = {}) {
  let frame = opts.frame ?? 0;
  let stabilized = opts.stabilized ?? true;
  let selected = -1;
  const options = { neighborThresholdUm: opts.neighborThresholdUm ?? 55 };
  const positionUm = (c, f, o = {}, out) => {
    const fr = Number.isFinite(f) ? (f | 0) : frame;
    if (c < 0 || c >= data.cellTotal || fr < 0 || fr >= data.frameCount) return null;
    const slot = data.cellFrameSlot[c * data.frameCount + fr];
    if (slot < 0) return null;
    const stab = typeof o.stabilized === 'boolean' ? o.stabilized : stabilized;
    const src = stab ? data.posStab : data.posRaw;
    const at = fr * data.maxN * 3 + slot * 3;
    const r = out || [0, 0, 0];
    r[0] = src[at]; r[1] = src[at + 1]; r[2] = src[at + 2];
    return r;
  };
  return {
    isAvailable: () => true, isLoaded: () => true, getData: () => data,
    getFrame: () => frame, setFrame: (f) => { frame = f; },
    isStabilized: () => stabilized,
    positionUm,
    cellsAt: (f) => {
      const fr = Number.isFinite(f) ? (f | 0) : frame;
      const n = data.counts[fr] || 0;
      return Array.from({ length: n }, (_, i) => data.cellIdx[fr * data.maxN + i]);
    },
    getOptions: () => ({ ...options }),
    setOptions: (p) => { Object.assign(options, p); },
    getSelected: () => selected, select: (c) => { selected = c; return c; },
    getStyle: () => ({ visible: true, showMitosis: true, showFusion: true }),
    getMeta: () => ({ tracksPath: 'tracks.json' }),
    on: () => () => {}
  };
}

// ── a synthetic series: 3 timepoints, 4 cells, one division, one gap ─────────
// Cell 1 divides after t=2 into 3 and 4; cell 2 skips t=2 (a gap in its track).
// Stabilised == raw + (10, 0, 0) so the two frames of reference are tellable.
const doc = {
  schema: 'iribhm-tracks-v1',
  timepoints: [1, 2, 3],
  cells: {
    '1': { id: '1', track_id: 1000000001, region: 'Endothelial Zone', color: '#2ecc71', parent: '', daughters: ['3', '4'],
      positions: { '1': [10, 0, 0], '2': [20, 0, 0] }, raw_positions: { '1': [0, 0, 0], '2': [10, 0, 0] } },
    '2': { id: '2', track_id: 1000000002, region: 'Blood Band', color: '#3498db', parent: '', daughters: [],
      positions: { '1': [40, 0, 0], '3': [46, 8, 0] }, raw_positions: { '1': [30, 0, 0], '3': [36, 8, 0] } },
    '3': { id: '3', track_id: 1000000003, region: 'Endothelial Zone', color: '#2ecc71', parent: '1', daughters: [],
      positions: { '3': [25, 5, 0] }, raw_positions: { '3': [15, 5, 0] } },
    '4': { id: '4', track_id: 1000000004, region: 'Endothelial Zone', color: '#2ecc71', parent: '1', daughters: [], is_fusion: true,
      positions: { '3': [15, -5, 0] }, raw_positions: { '3': [5, -5, 0] } }
  }
};

const packTracks = loadWorker();
const data = packTracks(doc);

// ── (a) packing ──────────────────────────────────────────────────────────────
ok('frame tables', () => {
  assert.equal(data.frameCount, 3);
  assert.equal(data.cellTotal, 4);
  assert.deepEqual(Array.from(data.counts), [2, 1, 3], 'cells present per frame');
  assert.equal(data.maxN, 3);
  assert.deepEqual(Array.from(data.timepoints), [1, 2, 3]);
  assert.equal(data.hasRaw, true);
});

ok('per-cell tables', () => {
  assert.deepEqual(plain(data.ids), ['1', '2', '3', '4']);
  assert.deepEqual(plain(data.trackIds), [1000000001, 1000000002, 1000000003, 1000000004]);
  assert.deepEqual(plain(data.regionNames), ['Endothelial Zone', 'Blood Band']);
  assert.deepEqual(plain(data.regionColors), ['#2ecc71', '#3498db']);
  assert.deepEqual(Array.from(data.regionIdx), [0, 1, 0, 0]);
  assert.deepEqual(Array.from(data.firstFrame), [0, 0, 2, 2]);
  assert.deepEqual(Array.from(data.lastFrame), [1, 2, 2, 2]);
});

ok('lineage as a CSR list, symmetric', () => {
  assert.deepEqual(Array.from(data.parent), [-1, -1, 0, 0]);
  assert.deepEqual(Array.from(data.daughterStart), [0, 2, 2, 2, 2]);
  assert.deepEqual(Array.from(data.daughterIdx), [2, 3]);
  // bit 0 = mitosis (declared OR implied by daughters), bit 1 = fusion
  assert.deepEqual(Array.from(data.flags), [1, 0, 0, 2]);
});

ok('cellFrameSlot: one read per (cell, frame)', () => {
  const slot = (c, f) => data.cellFrameSlot[c * data.frameCount + f];
  assert.equal(slot(1, 1), -1, 'the gap in cell 2 is an absence, not a stale slot');
  assert.ok(slot(0, 0) >= 0 && slot(0, 1) >= 0 && slot(0, 2) === -1);
  // The slot indexes the frame-major position tables.
  const s = slot(1, 2);
  const o = 2 * data.maxN * 3 + s * 3;
  assert.deepEqual([data.posStab[o], data.posStab[o + 1], data.posStab[o + 2]], [46, 8, 0]);
  assert.deepEqual([data.posRaw[o], data.posRaw[o + 1], data.posRaw[o + 2]], [36, 8, 0]);
  assert.equal(data.cellIdx[2 * data.maxN + s], 1);
});

ok('a lineage reference by track_id resolves too', () => {
  const alt = packTracks({ timepoints: [1], cells: {
    a: { id: 'a', track_id: 77, positions: { '1': [0, 0, 0] }, daughters: [88] },
    b: { id: 'b', track_id: 88, positions: { '1': [1, 0, 0] } }
  } });
  assert.deepEqual(Array.from(alt.parent), [-1, 0]);
  assert.deepEqual(Array.from(alt.daughterIdx), [1]);
  assert.equal(alt.hasRaw, false, 'no raw_positions anywhere');
});

ok('malformed documents are refused', () => {
  assert.throws(() => packTracks({}), /missing "cells"/);
  assert.throws(() => packTracks({ cells: {} }), /missing "timepoints"/);
});

// ── (b) the inspector's analysis ─────────────────────────────────────────────
{
  const inspector = loadPlugin('tracking-inspector');
  inspector._T = makeFacade(data, { frame: 2, stabilized: true });
  inspector._ctx = { i18n: { t: k => k }, ui: { escapeHtml: s => String(s) }, dataset: { getMeta: () => ({}), getId: () => 'live/x' } };

  ok('cellMetrics', () => {
    const m = inspector.cellMetrics(0);
    assert.equal(m.id, '1');
    assert.equal(m.trackId, 1000000001);
    assert.equal(m.region, 'Endothelial Zone');
    assert.equal(m.frames, 2);
    assert.equal(m.pathLength, 10, 'one step of 10 um (stabilised frame)');
    assert.equal(m.displacement, 10);
    assert.equal(m.straightness, 1);
    assert.equal(m.meanSpeed, 10, '10 um over one timepoint unit');
    assert.equal(m.isMitosis, true);
    assert.equal(m.isFusion, false);
    // The metrics follow the frame of reference on screen.
    inspector._T = makeFacade(data, { frame: 2, stabilized: false });
    assert.equal(inspector.cellMetrics(0).pathLength, 10, 'raw positions differ by a constant offset only');
    inspector._T = makeFacade(data, { frame: 2, stabilized: true });
  });

  ok('neighborRows at a frame', () => {
    // At t=3 (frame 2): cell 2 at (46,8), cell 3 at (25,5), cell 4 at (15,-5).
    const rows = inspector.neighborRows(2, 2, 16);
    assert.deepEqual(plain(rows.map(r => r.id)), ['4', '2'], 'nearest first, within 55 um');
    assert.ok(Math.abs(rows[0].distance - Math.hypot(10, 10)) < 1e-9);
    inspector._T.setOptions({ neighborThresholdUm: 12 });
    assert.deepEqual(plain(inspector.neighborRows(2, 2, 16).map(r => r.id)), [], 'radius applies');
    inspector._T.setOptions({ neighborThresholdUm: 55 });
  });

  ok('lineage', () => {
    const l = inspector.lineage(2);
    assert.equal(l.parent.id, '1');
    assert.deepEqual(plain(l.daughters), []);
    const p = inspector.lineage(0);
    assert.equal(p.parent, null);
    assert.deepEqual(plain(p.daughters.map(d => d.id)), ['3', '4']);
    assert.equal(p.metrics.trackId, 1000000001);
  });

  ok('findCell by key, id or track id', () => {
    assert.equal(inspector.findCell('2'), 1);
    assert.equal(inspector.findCell('1000000003'), 2);
    assert.equal(inspector.findCell(' 4 '), 3);
    assert.equal(inspector.findCell('nope'), -1);
    assert.equal(inspector.findCell(''), -1);
  });

  ok('velocityRows', () => {
    // Between t=1 and t=2 only cell 1 exists on both frames.
    const rows = inspector.velocityRows(0);
    assert.deepEqual(plain(rows.map(r => r.index)), [0]);
    assert.equal(rows[0].speed, 10);
    assert.deepEqual(plain([rows[0].dx, rows[0].dy, rows[0].dz]), [10, 0, 0]);
  });

  ok('trackCsv carries both frames of reference', () => {
    const csv = inspector.trackCsv(0);
    const lines = csv.split('\n');
    assert.equal(lines[0], '"timepoint","x","y","z","raw_x","raw_y","raw_z"');
    assert.equal(lines[1], '"1","10","0","0","0","0","0"');
    assert.equal(lines.length, 3);
  });
}

// ── (c) the charts' series ───────────────────────────────────────────────────
{
  const charts = loadPlugin('tracking-charts');
  charts._T = makeFacade(data, { frame: 0, stabilized: true });
  charts._ctx = { i18n: { t: k => k }, ui: { escapeHtml: s => String(s) } };

  ok('population per region', () => {
    const s = plain(charts.series('population'));
    const byRegion = Object.fromEntries(s.map(r => [r.region, r.y]));
    assert.deepEqual(byRegion['Endothelial Zone'], [1, 1, 2]);
    assert.deepEqual(byRegion['Blood Band'], [1, 0, 1]);
    assert.deepEqual(s[0].x, [1, 2, 3]);
    assert.equal(s[0].color, '#2ecc71');
  });

  ok('velocity: mean step speed per region, only where a previous frame exists', () => {
    const s = plain(charts.series('velocity'));
    const ez = s.find(r => r.region === 'Endothelial Zone');
    assert.deepEqual(ez.y, [0, 10, 0], 'cell 1 moved 10 um between t=1 and t=2');
    assert.equal(s.find(r => r.region === 'Blood Band'), undefined, 'a gap never counts as a step');
  });

  ok('neighbours: mean count within the shared radius', () => {
    const s = plain(charts.series('neighbors'));
    const ez = s.find(r => r.region === 'Endothelial Zone');
    // t=1: cell 1 (10,0) and cell 2 (40,0) are 30 apart -> 1 neighbour each.
    // t=3: 3 (25,5) & 4 (15,-5) are 14 apart, 2 (46,8) is 21 from 3 and 33 from 4.
    assert.deepEqual(ez.y, [1, 0, 2]);
    assert.deepEqual(s.find(r => r.region === 'Blood Band').y, [1, 0, 2]);
    assert.deepEqual(plain(charts.series('neighbors', data, { neighborThresholdUm: 1 })), [], 'a tiny radius finds nobody');
  });

  ok('mitoses land where the daughters start', () => {
    const s = plain(charts.series('mitoses'));
    assert.deepEqual(s.map(r => [r.region, r.y]), [['Endothelial Zone', [0, 0, 1]]]);
  });
}

// ── (d) a follow-cells measurement at a frame where a cell is missing ────────
{
  const measure = loadPlugin('tracking-measure');
  measure._T = makeFacade(data, { frame: 1, stabilized: true });
  const row = { id: 'm1', mode: 'follow-cells', cells: ['1', '2'], points: [[10, 0, 0], [40, 0, 0]], distance: 30 };
  ok('follow-cells resolves per frame', () => {
    assert.equal(measure.resolve(row).status, 'out-of-frame', 'cell 2 has no position at t=2');
    measure._T.setFrame(0);
    const r = measure.resolve(row);
    assert.equal(r.status, 'ok');
    assert.equal(r.distance, 30);
    assert.equal(measure.resolve({ ...row, mode: 'snapshot' }).distance, 30, 'a snapshot keeps its own numbers');
  });
}

// ── (e) manifests ────────────────────────────────────────────────────────────
ok('tracking plugin manifests', () => {
  const base = path.join(ROOT, 'js/modules/tools');
  const ids = readdirSync(base).filter(n => n.startsWith('tracking-'));
  assert.deepEqual(ids.sort(), ['tracking-charts', 'tracking-inspector', 'tracking-measure', 'tracking-surface', 'tracking-trails']);
  const tools = new Set();
  for (const id of ids) {
    const meta = JSON.parse(readFileSync(path.join(base, id, 'plugin.json'), 'utf8'));
    assert.equal(meta.id, id);
    assert.deepEqual(meta.dataTypes, ['live'], `${id} is a timelapse tool`);
    assert.deepEqual(meta.requires, ['tracking'], `${id} hides itself without a tracking block`);
    assert.ok(/>=1\.53\.0/.test(meta.platformCompat), `${id} needs the ctx.tracking façade`);
    if (meta.subtype === 'tool') {
      assert.ok(meta.tool && !tools.has(meta.tool) && meta.tool !== 'measure', `${id} tool id ${meta.tool} is unique`);
      tools.add(meta.tool);
    }
  }
  // The façade and the hooks the plugins rely on exist on the host side.
  const viewer = readFileSync(path.join(ROOT, 'js/pages/viewer.js'), 'utf8');
  for (const needle of ['tracking: _trackingFacade()', 'addSidebarSection:', 'addCanvasPanel:', 'getGraph: _getPluginGraph', "PluginRegistry.collect('getExports')"]) {
    assert.ok(viewer.includes(needle), `viewer.js provides ${needle}`);
  }
  const registry = readFileSync(path.join(ROOT, 'js/core/plugin-registry.js'), 'utf8');
  assert.ok(/function collect\(hook\)/.test(registry) && /kind === 'tracking'/.test(registry), 'PluginRegistry.collect + requires:tracking');
});

console.log('OK  tracking plugins: %d checks', checks);
