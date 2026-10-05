// Figure panel builder: bounded decoding, one missing photograph does not fail the
// figure, an uncalibrated photograph takes no part in the physical scale, and the
// split-view / orientation plugins' message guards.
//
// Run: node tests/js/test_pages_figure_panel.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT } from './harness.mjs';

const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');

function loadPlugin(rel, extra = {}) {
  let plugin = null;
  const ctx2d = new Proxy({}, { get: (t, k) => (k in t ? t[k] : () => ({ width: 10 })), set: (t, k, v) => { t[k] = v; return true; } });
  const sandbox = {
    console, Math, Number, Object, Promise, Map, Set, Array, JSON, String, setTimeout, clearTimeout,
    PluginRegistry: { implement: (id, obj) => { plugin = obj; }, syncToolbarButton() {} },
    Utils: { formatStage: (s) => String(s), isTrustedMessageOrigin: () => true, trustedTargetOrigin: () => 'https://lab.example', datasetPage: () => '2d.html' },
    document: { createElement: () => ({ width: 0, height: 0, getContext: () => ctx2d, style: {}, classList: { add() {} }, appendChild() {}, append() {} }) },
    window: { addEventListener() {}, removeEventListener() {}, parent: {} },
    requestAnimationFrame: (fn) => { fn(); return 1; }, cancelAnimationFrame() {},
    ...extra
  };
  vm.runInContext(read(rel), vm.createContext(sandbox), { filename: rel });
  return plugin;
}

const ds = (id, px, w = 4000, h = 3000) => ({ id, name: id, stage: 'E8', pixelSizeUm: px === null ? null : { x: px, y: px }, image: { width: w, height: h } });

// ── layout: physical scale only among calibrated photographs ──
{
  const fp = loadPlugin('js/modules/tools/figure-panel/index.js');
  fp._options = { columns: 'auto', scale: 'physical', label: 'none', background: 'dark', bar: 'auto' };
  const sets = [ds('a', 2), ds('b', null), ds('c', 4)];
  const boxes = sets.map(d => fp._orientedBox(d, { w: 4000, h: 3000 }));
  const lay = fp._layout(sets, boxes);
  assert.equal(lay.shared, true);
  assert.equal(lay.factors[0], 0.5, 'px 2 against the coarsest 4: half size');
  assert.equal(lay.factors[2], 1);
  assert.ok(lay.factors[1] > 0 && lay.factors[1] <= 1, 'the uncalibrated one is fitted into the cell, not scaled by a made-up 1 um/px');
  assert.equal(fp._pixelSize(ds('x', null)), null);
  assert.equal(fp._pixelSize({ pixelSizeUm: { x: '3.5' } }), 3.5);
  assert.equal(fp._pixelSize({ pixelSizeUm: { x: 0 } }), null);

  const none = fp._layout([ds('a', null), ds('b', null)], [boxes[0], boxes[0]]);
  assert.equal(none.shared, false, 'nothing calibrated: no shared bar');
}

// ── compose: bounded concurrency, a missing photograph is a blank cell ──
{
  const fp = loadPlugin('js/modules/tools/figure-panel/index.js', {
    Image: class {}
  });
  fp._modal = { querySelector: () => null };
  fp._ctx = { i18n: { t: (k) => k } };
  fp._options = { columns: 'auto', scale: 'physical', label: 'name', background: 'dark', bar: 'auto' };
  fp._token = 1;
  let inFlight = 0, peak = 0;
  fp._loadImage = async (d) => {
    inFlight++; peak = Math.max(peak, inFlight);
    await new Promise(r => setImmediate(r));
    inFlight--;
    if (d.id === 'missing') throw new Error('404');
    return { naturalWidth: 4000, naturalHeight: 3000 };
  };
  const sets = Array.from({ length: 12 }, (_, i) => ds(i === 5 ? 'missing' : `p${i}`, i === 3 ? null : 3));
  const sizes = sets.map(() => ({ w: 4000, h: 3000 }));
  const res = await fp._compose(sets, sizes, 1);
  assert.ok(peak <= fp.DECODE_CONCURRENCY, `at most ${fp.DECODE_CONCURRENCY} photographs are decoded at once (saw ${peak})`);
  assert.equal(res.failed, 1, 'the missing photograph is counted, not fatal');
  assert.equal(res.layoutMaps.length, 12);
  assert.equal(res.layoutMaps[3].calibrated, false);
  assert.equal(res.layoutMaps[0].calibrated, true);
  assert.ok(res.layoutMaps.every(m => !('_cell' in m) && !('_f' in m)), 'no working fields leak into the Studio');
  assert.ok(res.canvas.width * res.canvas.height <= fp.MAX_CANVAS_PIXELS * 1.01, 'the figure canvas stays allocatable');

  // A superseded render stops drawing.
  fp._token = 2;
  assert.equal(await fp._compose(sets.slice(0, 3), sizes.slice(0, 3), 1), null);
}

// ── the decoded-photograph cache is bounded and emptied on close ──
{
  const fp = loadPlugin('js/modules/tools/figure-panel/index.js');
  fp._modal = { querySelector: () => null };
  fp._images = new Map();
  for (let i = 0; i < 6; i++) fp._images.set(`p${i}`, { promise: Promise.resolve(), pixels: 20e6 });
  fp._evict();
  const kept = [...fp._images.values()].reduce((s, e) => s + e.pixels, 0);
  assert.ok(kept <= fp.MAX_CACHED_PIXELS, `cache within budget (${kept / 1e6} MP)`);
  assert.ok(fp._images.has('p5') && !fp._images.has('p0'), 'the oldest go first');
  fp._releaseImages();
  assert.equal(fp._images.size, 0);
}

// ── source checks ──
{
  const orient = loadPlugin('js/modules/tools/orientation-2d/index.js');
  const replies = [];
  orient._ctx = { viewer: { getOrientation: () => ({ rotationDeg: 0, flipH: false }) } };
  const parent = {};
  const ctxWin = { parent };
  const o2 = loadPlugin('js/modules/tools/orientation-2d/index.js', { window: { ...ctxWin, addEventListener() {}, removeEventListener() {} } });
  o2._ctx = orient._ctx;
  o2._handleMessage({ origin: 'x', source: { postMessage: (m) => replies.push(m) }, data: { type: 'GET_ORIENTATION' } });
  assert.equal(replies.length, 0, 'another same-origin frame gets no answer');
  o2._handleMessage({ origin: 'x', source: Object.assign(parent, { postMessage: (m) => replies.push(m) }), data: { type: 'GET_ORIENTATION' } });
  assert.equal(replies.length, 1, 'the embedding page does');

  const sv = loadPlugin('js/modules/tools/split-view/index.js');
  const posts = [];
  const win = { postMessage: (m) => posts.push(m) };
  sv._frame = { contentWindow: win };
  sv._link = true;
  sv._ctx = { viewer: { getPhysicalView: () => ({ umPerCss: 1, centerUm: { x: 0, y: 0 } }), setPhysicalView() {} } };
  sv._handleMessage({ origin: 'x', source: win, data: { type: 'PANEL_READY' } });
  assert.equal(posts.length, 1, 'the pane announcing itself gets the first linked view');
  assert.equal(posts[0].type, 'WM_SET_PHYSICAL_VIEW');
  sv._handleMessage({ origin: 'x', source: win, data: { type: 'PANEL_DATASET' } });
  assert.equal(posts.length, 2, 'and again after a different photograph is put in the pane');
  sv._ctx.viewer.getPhysicalView = () => null;
  sv._handleMessage({ origin: 'x', source: win, data: { type: 'PANEL_READY' } });
  assert.equal(posts.length, 2, 'an uncalibrated photograph pushes nothing');
  sv._handleMessage({ origin: 'x', source: {}, data: { type: 'PANEL_READY' } });
  assert.equal(posts.length, 2, 'a message from another frame is ignored');
}

// ── plugin metadata moved with the code ──
for (const id of ['figure-panel', 'split-view', 'calibrated-grid', 'orientation-2d']) {
  const meta = JSON.parse(read(`js/modules/tools/${id}/plugin.json`));
  assert.match(meta.version, /^\d+\.\d+\.\d+$/);
}

console.log('figure panel + 2D plugins: OK');
