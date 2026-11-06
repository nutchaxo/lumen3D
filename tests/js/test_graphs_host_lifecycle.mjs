// Graphs plugin — what it keeps and what it says: a closed page panel lets its
// tables and plot go; a Compare panel's own refusal (NOT_READY, SUPERSEDED…) reaches
// the drawer through the transport error; a language switch rebuilds a panel's
// tables and makes the drawer ask the panels again once they speak the new language.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT } from './harness.mjs';

const DIR = path.join(ROOT, 'js/modules/tools/graphs');
const t = (k, p) => (p ? `${k}:${JSON.stringify(p)}` : k);
const tick = () => new Promise(r => setTimeout(r, 0));
const settle = async (n = 12) => { for (let i = 0; i < n; i++) await tick(); };
const wait = (ms) => new Promise(r => setTimeout(r, ms));

function loadPlugin(extra = {}) {
  let impl = null;
  const ctx = {
    console, Math, Number, String, Object, Array, Map, Set, WeakMap, JSON, Error, Date, Promise, Symbol, RegExp,
    ArrayBuffer, Float32Array, Float64Array, Int32Array, Int16Array, Uint8Array, Uint8ClampedArray, Uint16Array, Uint32Array,
    AbortController, structuredClone, setTimeout, clearTimeout, setInterval, clearInterval,
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

function volume() {
  const n = 24;
  const A = new Uint8Array(n), B = new Uint8Array(n);
  for (let i = 0; i < n; i++) { const k = Math.floor(i / 8); A[i] = k * 10; B[i] = 255 - A[i]; }
  return [A, B];
}

function voxelCtx(reads, lang = 'en') {
  const dims = { x: 4, y: 2, z: 3 };
  return {
    i18n: { getLanguage: () => lang },
    dataset: { getMeta: () => ({ type: '3d', name: 'E', dimensions: { c: 2 }, channels: [{ name: 'DAPI' }, { name: 'GFP' }] }), getId: () => '3d/E' },
    data: {
      info: () => ({ channels: 2 }),
      levels: () => [{ level: 0, dims, voxelSize: { x: 2, y: 2, z: 2 } }],
      readRegion: (box, chans, o) => { reads.push({ box, opts: o }); return Promise.resolve({ dims, data: volume() }); }
    }
  };
}

function fakeRoot() {
  const boxes = {
    '[data-g="controls"]': { innerHTML: '' }, '[data-g="status"]': { textContent: '', style: {} },
    '[data-g="notes"]': { innerHTML: '' }, '[data-g="plot"]': { id: 'plot' }
  };
  return { boxes, innerHTML: '', querySelector: (sel) => boxes[sel] || null, addEventListener() {}, removeEventListener() {} };
}

// 1. A closed page panel drops its table (aborting nothing else) and its plot; reopening reads again.
{
  const purged = [];
  const Plotly = { react: async () => {}, purge: (gd) => purged.push(gd) };
  const { G, ctx } = loadPlugin();
  ctx.window.Plotly = Plotly;
  ctx.Plotly = Plotly;
  const reads = [];
  const provider = G.createProvider(voxelCtx(reads), t);
  assert.equal(provider.describe().lang, 'en', 'a description names the language of its labels');
  const root = fakeRoot();
  const ui = G.createUI(root, {
    t, multi: false, describe: () => provider.describe(),
    compute: (table, spec) => provider.compute(table, spec).then(r => Object.assign(r, { datasets: 1 })),
    cursor: () => null
  });
  const self = Object.assign(Object.create(G), {
    _ctx: { ui: {} }, _t: t, _mode: 'page', _open: false, _pollTimer: null,
    _panel: { toggle() {}, root }, _ui: ui, _provider: provider
  });
  self._setOpen(true);
  await settle();
  assert.equal(reads.length, 1, 'the level was read for the first plot');
  assert.equal(ui.getPlot(), root.boxes['[data-g="plot"]'], 'drawn');
  assert.ok(ui.getLast(), 'with its result kept for the CSV export');
  self._setOpen(false);
  assert.equal(reads[0].opts.signal.aborted, true, 'closing drops the table');
  assert.deepEqual(purged, [root.boxes['[data-g="plot"]']], 'and purges the plot');
  assert.equal(ui.getPlot(), null);
  assert.equal(ui.getLast(), null);
  self._setOpen(true);
  await settle();
  assert.equal(reads.length, 2, 'reopening reads the level again');
  assert.ok(ui.getPlot(), 'and draws');
  // A language switch on the page rebuilds the markup without leaving the old plot alive.
  self._relabel();
  assert.equal(purged.length, 2, 'the replaced plot is purged');
  await settle();
  self._setOpen(false);
}

// 2. A Compare panel rebuilds its tables on a language switch (labels are baked into them).
{
  const { G } = loadPlugin();
  let resets = 0;
  const self = Object.assign(Object.create(G), { _mode: 'panel', _panel: null, _provider: { reset: () => { resets++; } } });
  self.onLanguageChange();
  assert.equal(resets, 1);
}

// 3. The Compare drawer: a panel's own code is shown, a superseded round stays quiet,
//    and a language switch asks the panels again until they answer in it.
{
  const { G } = loadPlugin();
  const desc = (lang) => {
    const d = JSON.parse(JSON.stringify(G.createProvider(voxelCtx([], lang), t).describe()));
    d.lang = lang;
    return d;
  };
  let hostLang = 'en', panelLang = 'en', computeCode = 'NOT_READY';
  const asked = [];
  const listeners = [];
  const root = fakeRoot();
  let drawerDef = null;
  const hostCtx = {
    context: 'compare',
    i18n: { t, getLanguage: () => hostLang },
    panels: {
      list: () => [{ index: 0, id: '3d/E', name: 'E', ready: true, failed: false }],
      onChange: (fn) => { listeners.push(fn); return () => {}; },
      request: async (index, type, payload) => {
        asked.push(payload.op);
        if (payload.op === 'describe') return { ok: true, description: desc(panelLang) };
        // What ComparePanelRpc.settle makes of an ok:false answer.
        throw Object.assign(new Error(computeCode), { code: 'COMPARE_PANEL_ERROR', panelCode: computeCode });
      }
    },
    ui: {
      addDrawer: (def) => {
        drawerDef = def;
        return { el: root, open: () => def.onToggle(true), close: () => def.onToggle(false), setTitle() {}, remove() {} };
      }
    }
  };
  const self = Object.assign(Object.create(G), { _t: t, _mode: 'compare', _open: false, _ctx: hostCtx });
  G._initHost.call(self, hostCtx);
  assert.ok(drawerDef && self._host);
  const status = () => root.boxes['[data-g="status"]'].textContent;

  self._host.setOpen(true);
  await settle();
  assert.equal(status(), 'err_notReady', 'a panel still loading says so, not a generic failure');

  computeCode = 'NO_TABLE';
  self._host.ui.redraw();
  await settle();
  assert.equal(status(), 'err_noData');

  computeCode = 'SUPERSEDED';
  self._host.ui.redraw();
  await settle();
  assert.equal(status(), 'computing', 'a superseded round leaves the drawer to the round that replaced it');

  const describes = () => asked.filter(op => op === 'describe').length;
  const before = describes();
  self._host.ui.redraw();
  await settle();
  assert.equal(describes(), before, 'same panel, same language: not asked again');

  hostLang = 'fr';                         // the host switches first
  self._host.relabel();
  await settle();
  assert.ok(describes() > before, 'asked again after the switch (and on each round while the panel answers in the old language)');
  const stillOld = describes();
  panelLang = 'fr';                        // the panel follows and describes itself again
  listeners.forEach(fn => fn());
  await wait(450);
  await settle();
  assert.ok(describes() > stillOld, 'asked once more when the panel re-describes itself');
  const settled = describes();
  self._host.ui.redraw();
  await settle();
  assert.equal(describes(), settled, 'and no more once it answers in the new language');
  self._host.dispose();
}

// 4. A query waiting behind a running read does not start once the panel closes or the
//    plugin goes: closing aborts the read in flight, and the waiting one is cancelled
//    with it instead of reading the whole level again for a panel nobody sees.
{
  const { G, ctx } = loadPlugin();
  const Plotly = { react: async () => {}, purge() {} };
  ctx.window.Plotly = Plotly;
  ctx.Plotly = Plotly;
  const heldCtx = (reads) => {
    const base = voxelCtx([]);
    base.data.readRegion = (box, chans, o) => new Promise((resolve, reject) => {
      const r = { aborted: false, release: () => resolve({ dims: { x: 4, y: 2, z: 3 }, data: volume() }) };
      reads.push(r);
      o.signal?.addEventListener('abort', () => { r.aborted = true; reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); });
    });
    return base;
  };
  const mount = (reads) => {
    const root = fakeRoot();
    const pageCtx = {
      ...heldCtx(reads),
      i18n: { t, getLanguage: () => 'en' },
      ui: { addCanvasPanel: (def) => { def.bind(root); return { root, toggle() {}, remove() {} }; } }
    };
    const self = Object.assign(Object.create(G), { _unsubs: [] });
    self.init(pageCtx);
    assert.equal(self._mode, 'page');
    return self;
  };

  for (const end of ['close', 'dispose']) {
    const reads = [];
    const self = mount(reads);
    self._setOpen(true);
    await settle();
    assert.equal(reads.length, 1, `${end}: the first draw reads the level`);
    self._ui.redraw();                     // a control moved while the read runs: this draw waits
    await settle();
    assert.equal(reads.length, 1, `${end}: the second draw waits for the first`);
    if (end === 'close') self._setOpen(false); else self.dispose();
    await settle();
    assert.equal(reads[0].aborted, true, `${end}: the read in flight is aborted`);
    assert.equal(reads.length, 1, `${end}: the waiting draw does not start a new read`);
  }
}

// 5. Restoring a workspace saved with Graphs closed reads nothing and holds nothing:
//    the choices are kept and the reopen draws them (a page that never described its
//    tables yet keeps them too). A Compare drawer restored closed asks no panel.
{
  const { G, ctx } = loadPlugin();
  const Plotly = { react: async () => {}, purge() {} };
  ctx.window.Plotly = Plotly;
  ctx.Plotly = Plotly;
  const mount = (reads) => {
    const root = fakeRoot();
    const pageCtx = {
      ...voxelCtx(reads),
      i18n: { t, getLanguage: () => 'en' },
      ui: { addCanvasPanel: (def) => { def.bind(root); return { root, toggle() {}, remove() {} }; } }
    };
    const self = Object.assign(Object.create(G), { _unsubs: [] });
    self.init(pageCtx);
    return self;
  };

  const reads = [];
  const self = mount(reads);
  self._setOpen(true);
  await settle();
  assert.equal(reads.length, 1, 'the open panel read the level');
  const saved = JSON.parse(JSON.stringify(self.getState()));
  saved.open = false;
  saved.ui.spec.agg = saved.ui.spec.agg === 'max' ? 'min' : 'max';
  self._setOpen(false);
  await settle();
  self.setState(saved);
  await settle();
  assert.equal(self._open, false);
  assert.equal(reads.length, 1, 'a closed-panel workspace reads nothing');
  assert.equal(self._ui.getLast(), null, 'and holds no result');
  self._setOpen(true);
  await settle();
  assert.equal(reads.length, 2, 'reopening reads the level once');
  assert.equal(self._ui.getState().spec.agg, saved.ui.spec.agg, 'with the restored choices');
  self.dispose();

  // Never opened: the tables were never described, the restored choices wait for it.
  const reads2 = [];
  const fresh = mount(reads2);
  saved.ui.spec.bins = 17;
  saved.ui.preset = null;
  fresh.setState(saved);
  await settle();
  assert.equal(reads2.length, 0, 'a never-opened panel restored closed reads nothing');
  // The URL sync / Save state read the workspace before the first open: the waiting
  // choices are what it carries, and a page restored from it keeps them again.
  const resaved = JSON.parse(JSON.stringify(fresh.getState()));
  assert.equal(JSON.stringify(resaved.ui), JSON.stringify(saved.ui), 'getState carries the restored, still undescribed choices');
  const reads4 = [];
  const reloaded = mount(reads4);
  reloaded.setState(resaved);
  await settle();
  assert.equal(JSON.stringify(reloaded.getState().ui), JSON.stringify(saved.ui), 'a second round trip keeps them');
  reloaded._setOpen(true);
  await settle();
  assert.equal(reads4.length, 1);
  assert.equal(reloaded._ui.getState().table, saved.ui.table);
  assert.equal(reloaded._ui.getState().spec.agg, saved.ui.spec.agg, 'agg kept through the re-save');
  assert.equal(reloaded._ui.getState().spec.bins, 17, 'bins kept through the re-save');
  reloaded.dispose();
  fresh._setOpen(true);
  await settle();
  assert.equal(reads2.length, 1);
  assert.equal(fresh._ui.getState().table, saved.ui.table);
  assert.equal(fresh._ui.getState().spec.agg, saved.ui.spec.agg, 'the choices survive until the first description');
  fresh.dispose();

  // An open-panel workspace still draws at once.
  const reads3 = [];
  const opened = mount(reads3);
  opened.setState({ ...saved, open: true });
  await settle();
  assert.equal(reads3.length, 1, 'an open-panel workspace draws');
  assert.equal(opened._ui.getState().spec.agg, saved.ui.spec.agg);
  opened.dispose();

  // Compare host: restored closed, no panel is asked to compute.
  const asked = [];
  const root = fakeRoot();
  const hostCtx = {
    context: 'compare',
    i18n: { t, getLanguage: () => 'en' },
    panels: {
      list: () => [{ index: 0, id: '3d/E', name: 'E', ready: true, failed: false }],
      onChange: () => () => {},
      request: async (index, type, payload) => {
        asked.push(payload.op);
        if (payload.op === 'describe') return { ok: true, description: G.createProvider(voxelCtx([]), t).describe() };
        return { ok: false, code: 'NO_DATA' };
      }
    },
    ui: { addDrawer: (def) => ({ el: root, open: () => def.onToggle(true), close: () => def.onToggle(false), setTitle() {}, remove() {} }) }
  };
  const host = Object.assign(Object.create(G), { _t: t, _mode: 'compare', _open: false, _ctx: hostCtx });
  G._initHost.call(host, hostCtx);
  host.setState({ open: false, ui: saved.ui });
  await settle();
  assert.equal(asked.filter(op => op === 'compute').length, 0, 'a closed drawer asks no panel to compute');
  host._host.dispose();
}

console.log('graphs host lifecycle: ok');
