/* Measurement colours and the measure-distance Clear button.

   Locked here:
     (a) MeasurementStore keeps a hex colour (#rgb … #rrggbbaa) and replaces anything
         else with the default, through setAll, add and update — a colour from a
         shared #state= link cannot carry a second CSS declaration into a style="";
     (b) measure-distance renders a hex colour only, even when handed a hostile one
         (an older core's store does not validate);
     (c) measure-distance binds the Clear button the page actually has (the volume
         viewer's btn-clear-volume-measure, the 2D page's btn-measure-clear), and a
         click drops the pending first pick, so the next click starts a new pair;
     (d) a measurement committed after the page cleared the store behind the plugin
         is numbered and coloured from the store, not from a stale local list.

   Run: node tests/js/test_measurement_store_color.mjs */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT, loadModule, escapeHtml } from './harness.mjs';

let checks = 0;
const ok = (label, fn) => {
  try { fn(); } catch (err) { err.message = `${label} — ${err.message}`; throw err; }
  checks++;
};

// ── (a) the store ────────────────────────────────────────────────────────────
const Store = loadModule('js/core/measurement-store.js', 'MeasurementStore');
const HOSTILE = '#f00;position:fixed;inset:0;z-index:2147483647';

ok('setAll replaces a hostile colour', () => {
  const rows = Store.setAll('3d/a', 'viewer', [
    { id: 'm1', color: HOSTILE },
    { id: 'm2', color: '#00FFFF' },
    { id: 'm3', color: '#abc' },
    { id: 'm4', color: '#11223344' },
    { id: 'm5', color: 'red' },
    { id: 'm6', color: 'url(data:image/svg+xml,x)' },
    { id: 'm7', color: { toString: () => '#fff' } },
    { id: 'm8' }
  ]);
  assert.deepEqual(Array.from(rows, r => r.color),
    ['#ff4d4f', '#00FFFF', '#abc', '#11223344', '#ff4d4f', '#ff4d4f', '#fff', '#ff4d4f']);
});

ok('add replaces a hostile colour', () => {
  const row = Store.add('3d/a', 'viewer', { id: 'm9', color: '#f00;position:fixed' });
  assert.equal(row.color, '#ff4d4f');
});

ok('update replaces a hostile colour and keeps a hex one', () => {
  assert.equal(Store.update('3d/a', 'viewer', 'm2', { color: '#f00" onmouseover="x' }).color, '#ff4d4f');
  assert.equal(Store.update('3d/a', 'viewer', 'm2', { color: '#FF1493' }).color, '#FF1493');
  assert.equal(Store.update('3d/a', 'viewer', 'm2', { label: 'kept' }).color, '#FF1493');
});

// ── measure-distance in a vm, with the DOM nodes it reaches ─────────────────
function fakeNode(id) {
  const listeners = {};
  return {
    id, innerHTML: '',
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    removeEventListener(type, fn) { listeners[type] = (listeners[type] || []).filter(f => f !== fn); },
    fire(type) { for (const fn of listeners[type] || []) fn({ type, target: this }); },
    count(type) { return (listeners[type] || []).length; }
  };
}

function mountPlugin(clearId, datasetId) {
  const nodes = {
    'volume-measure-list': fakeNode('volume-measure-list'),
    'volume-measure-status': fakeNode('volume-measure-status'),
    [clearId]: fakeNode(clearId)
  };
  let impl = null;
  const sandbox = {
    console, Math, Number, String, Object, Array, JSON,
    PluginRegistry: { implement: (_id, obj) => { impl = obj; } },
    document: { getElementById: id => nodes[id] || null, createElement: () => ({}) },
    window: { innerWidth: 1000 },
    requestAnimationFrame: () => 0
  };
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(path.join(ROOT, 'js/modules/tools/measure-distance/index.js'), 'utf8'),
    sandbox, { filename: 'measure-distance/index.js' });
  assert.ok(impl, 'measure-distance registers');
  let pickHandler = null;
  const ctx = {
    _state: { currentTimepoint: 0 },
    i18n: { t: (k, p) => (p && p.n != null ? `${k} ${p.n}` : k) },
    ui: { escapeHtml, createIcons() {} },
    viewer: {
      onMeasurePoint: fn => { pickHandler = fn; },
      setMeasurements() {},
      getPhysicalCalibration: () => ({ calibrationStatus: 'ok' })
    },
    measurements: {
      list: scope => Store.list(datasetId, scope),
      add: (scope, data) => Store.add(datasetId, scope, data),
      update: (scope, id, patch) => Store.update(datasetId, scope, id, patch),
      remove: (scope, id) => Store.remove(datasetId, scope, id),
      clear: scope => Store.clear(datasetId, scope),
      setAll: (scope, arr) => Store.setAll(datasetId, scope, arr)
    }
  };
  impl.init(ctx);
  const pick = (x) => pickHandler({ normalized: { x: 0, y: 0, z: 0 }, physicalUm: { x, y: 0, z: 0 } });
  return { impl, nodes, pick };
}

// ── (b) the plugin's own guard ───────────────────────────────────────────────
ok('a hostile colour never reaches the list markup', () => {
  const { impl, nodes } = mountPlugin('btn-clear-volume-measure', '3d/b');
  impl._measurements = [{ id: 'x', label: 'A', distance: 1, visible: true, color: HOSTILE }];
  impl._render();
  const html = nodes['volume-measure-list'].innerHTML;
  assert.ok(!html.includes('position:fixed'), 'no injected declaration');
  assert.ok(html.includes('background:#ff4d4f;'), 'default colour drawn');
  impl.dispose();
});

// ── (c) the Clear button of each page ────────────────────────────────────────
for (const clearId of ['btn-clear-volume-measure', 'btn-measure-clear']) {
  ok(`Clear (${clearId}) drops the pending first pick`, () => {
    const ds = `3d/${clearId}`;
    const { impl, nodes, pick } = mountPlugin(clearId, ds);
    assert.equal(nodes[clearId].count('click'), 1, 'clear button bound');
    pick(0); pick(10);                        // one committed measurement
    assert.equal(Store.list(ds, 'viewer').length, 1);
    pick(100);                                // a pending first point A
    assert.equal(impl._draft.length, 1);
    nodes[clearId].fire('click');
    assert.equal(impl._draft.length, 0, 'pending pick dropped');
    assert.equal(Store.list(ds, 'viewer').length, 0, 'store cleared');
    pick(200);                                // B is a new first point, not paired with A
    assert.equal(Store.list(ds, 'viewer').length, 0, 'no distance from the cleared point');
    pick(203);
    const rows = Store.list(ds, 'viewer');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].distance, 3);
    assert.equal(rows[0].label, 'measureN 1');
    impl.dispose();
    assert.equal(nodes[clearId].count('click'), 0, 'listener removed on dispose');
  });
}

// ── (d) store cleared behind the plugin ──────────────────────────────────────
ok('numbering and colour follow the store after an external clear', () => {
  const ds = '3d/external';
  const { impl, pick } = mountPlugin('btn-clear-volume-measure', ds);
  pick(0); pick(1); pick(0); pick(2);
  assert.equal(Store.list(ds, 'viewer').length, 2);
  Store.clear(ds, 'viewer');                  // the page's own Clear handler
  impl._draft = [];
  pick(0); pick(5);
  const rows = Store.list(ds, 'viewer');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].label, 'measureN 1');
  assert.equal(rows[0].color, impl.COLORS[0]);
  impl.dispose();
});

console.log(`test_measurement_store_color: ${checks} checks passed`);
