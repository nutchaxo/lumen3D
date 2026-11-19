// Advanced Studio — ij-layout.js: the layout data model (IJLayoutPure), pure, no DOM.
// Every operation keeps the normalisation invariants; gridWithSource for 2..9 panes; drop zones; garbage in validate().
//
// Run: node tests/js/test_ij_layout_pure.mjs
import assert from 'node:assert/strict';
import { loadViewModules } from './ij_harness.mjs';

const { IJLayoutPure: L } = loadViewModules({});
const J = (x) => JSON.parse(JSON.stringify(x));
let n = 0;
const test = (name, fn) => { fn(); n++; console.log('  ok  ' + name); };

/** the invariants normalize() promises */
function check(lay, what = '') {
  const ids = [];
  const walk = (node) => {
    if (node.type === 'group') {
      assert.ok(node.tabs.length >= 1, what + ': group with a tab');
      assert.ok(node.tabs.includes(node.current), what + ': current is one of the tabs');
      ids.push(...node.tabs);
      return;
    }
    assert.ok(node.children.length >= 2, what + ': split has >= 2 children');
    assert.equal(node.sizes.length, node.children.length);
    assert.ok(Math.abs(node.sizes.reduce((a, b) => a + b, 0) - 1) < 1e-9, what + ': sizes sum to 1');
    for (const c of node.children) { assert.ok(!(c.type === 'split' && c.dir === node.dir), what + ': no same-direction nesting'); walk(c); }
  };
  if (lay.root) walk(lay.root);
  for (const f of lay.floating) ids.push(f.docId);
  for (const m of lay.minimized) ids.push(m.docId);
  assert.equal(new Set(ids).size, ids.length, what + ': a doc appears once: ' + ids.join(','));
  if (lay.active !== null) assert.ok(ids.includes(lay.active), what + ': active is a doc');
  if (lay.maximized) assert.ok(L.findNode(lay, lay.maximized), what + ': maximized exists');
  assert.deepEqual(J(L.order(lay)).sort((a, b) => a - b), ids.slice().sort((a, b) => a - b), what + ': order() lists every doc');
  return lay;
}
const build = (...docs) => docs.reduce((lay, d) => L.addTab(lay, d), L.empty());

test('addTab: the first doc makes the root group, the next ones tabs of the active group', () => {
  let lay = check(build(1, 2, 3));
  assert.equal(lay.root.type, 'group');
  assert.deepEqual(J(lay.root.tabs), [1, 2, 3]);
  assert.equal(lay.root.current, 3); assert.equal(lay.active, 3);
  lay = check(L.addTab(lay, 1));
  assert.deepEqual(J(lay.root.tabs), [2, 3, 1], 'an existing doc is moved, never duplicated');
});

test('split: a pane of its own on the chosen side, nested splits of the same direction merge', () => {
  let lay = build(1, 2);
  const g = lay.root.id;
  lay = check(L.split(lay, g, 'right', 2), 'split right');
  assert.equal(lay.root.type, 'split'); assert.equal(lay.root.dir, 'row');
  assert.deepEqual(J(lay.root.children.map((c) => c.tabs)), [[1], [2]]);
  lay = L.addTab(lay, 3, L.groupOf(lay, 1).id);
  lay = check(L.split(lay, L.groupOf(lay, 2).id, 'right', 3), 'merged row');
  assert.equal(lay.root.children.length, 3, 'three panes in ONE row split');
  assert.ok(lay.root.sizes.every((s) => Math.abs(s - 1 / 3) < 1e-9 || s > 0));
  lay = check(L.split(lay, L.groupOf(lay, 1).id, 'bottom', 3), 'column inside the row');
  assert.ok(lay.root.children.some((c) => c.type === 'split' && c.dir === 'col'));
  const same = L.split(build(1), L.empty().root, 'left', 1);
  assert.deepEqual(J(same), J(build(1)), 'a split around the only tab of its own group is a no-op');
});

test('remove: neighbour becomes active, empty groups and one-child splits collapse', () => {
  let lay = L.split(build(1, 2), 'g1', 'right', 2);
  lay = check(L.remove(lay, 2), 'remove');
  assert.equal(lay.root.type, 'group');
  assert.equal(lay.active, 1);
  lay = check(L.remove(lay, 1), 'remove last');
  assert.equal(lay.root, null); assert.equal(lay.active, null);
  lay = build(1, 2, 3);
  lay = L.activate(lay, 2);
  lay = L.remove(lay, 2);
  assert.equal(lay.active, 3, 'the next tab takes over');
  assert.equal(L.neighbour(build(1, 2, 3), 3), 2, 'the last tab falls back to the previous one');
});

test('gridWithSource for 2..9 panes: every doc present, the grid replaces the source pane, near-square', () => {
  // [columns, rows] chosen by the fit-scale rule for a square image in 1000 x 700 px
  const expect = { 2: [2, 1], 3: [2, 2], 4: [2, 2], 5: [3, 2], 6: [3, 2], 7: [4, 2], 8: [4, 2], 9: [3, 3] };
  const shape = (lay) => {
    const rows = lay.root.type === 'split' && lay.root.dir === 'col' ? lay.root.children : [lay.root];
    return rows.map((r) => (r.type === 'split' ? r.children.length : 1));
  };
  for (let total = 2; total <= 9; total++) {
    const ids = Array.from({ length: total - 1 }, (_, i) => 10 + i);
    let lay = L.addTab(L.empty(), 1);
    lay = L.addTab(lay, 99);                                       // another tab in the source's pane
    lay = check(L.gridWithSource(lay, 1, ids, { aspect: 1, extentPx: { w: 1000, h: 700 } }), 'grid ' + total);
    for (const d of [1, 99, ...ids]) assert.ok(L.has(lay, d), `doc ${d} of ${total}`);
    assert.deepEqual(J(L.groupOf(lay, 1).tabs), [1, 99], 'the source keeps its other tabs in its pane');
    const s = shape(lay);
    assert.equal(s.length, expect[total][1], `${total} panes: ${s}`);
    assert.equal(Math.max(...s), expect[total][0], `${total} panes: ${s}`);
    assert.ok(s.every((c, i) => i === s.length - 1 || c === s[0]), 'only the last row is shorter');
    assert.equal(s.reduce((a, b) => a + b, 0), total);
  }
  assert.deepEqual(J(L.gridDims(5, 1, { w: 1000, h: 700 })).rows, 2);
  assert.equal(L.gridDims(4, 1, { w: 1000, h: 1000 }).cols, 2);
  assert.equal(L.gridDims(3, 3, { w: 1000, h: 700 }).rows, 3, 'a wide image makes rows');
  // a floating or minimised source is docked first
  let lay = L.float(build(1, 2), 2, { x: 10, y: 10, w: 300, h: 200 });
  lay = check(L.gridWithSource(lay, 2, [3], {}), 'floating source');
  assert.ok(L.groupOf(lay, 2) && L.groupOf(lay, 3));
});

test('move: centre joins as a tab, an edge splits; the only tab of a group cannot split itself', () => {
  let lay = L.split(build(1, 2, 3), 'g1', 'right', 3);
  const gOf = (d) => L.groupOf(lay, d).id;
  lay = check(L.move(lay, 2, gOf(3), 'center'), 'centre');
  assert.deepEqual(J(L.groupOf(lay, 3).tabs), [3, 2]);
  lay = check(L.move(lay, 2, gOf(1), 'bottom'), 'edge');
  assert.ok(lay.root.children.some((c) => c.type === 'split' && c.dir === 'col'));
  const before = J(lay);
  assert.deepEqual(J(L.move(lay, 3, gOf(3), 'left')), before, 'a lone tab dropped on its own edge: nothing');
  assert.deepEqual(J(L.move(lay, 99, gOf(3), 'center')), before, 'unknown doc: nothing');
});

test('resize / equalize: pixel minimum and normalised fractions', () => {
  let lay = L.split(build(1, 2), 'g1', 'right', 2);
  const id = lay.root.id;
  lay = L.resize(lay, id, 0, 0.3);
  assert.ok(Math.abs(lay.root.sizes[0] - 0.8) < 1e-9 && Math.abs(lay.root.sizes[1] - 0.2) < 1e-9);
  lay = L.resize(lay, id, 0, 5, 0.1);
  assert.ok(Math.abs(lay.root.sizes[1] - 0.1) < 1e-9, 'never below the minimum');
  lay = L.equalize(lay, id);
  assert.deepEqual(J(lay.root.sizes), [0.5, 0.5]);
  assert.equal(L.minFraction(1000, 'row'), 0.16); assert.equal(L.minFraction(600, 'col'), 0.2); assert.equal(L.minFraction(100, 'row'), 0.5);
  // normalize with an extent clamps the fractions to 160 x 120 px
  const skew = J(lay); skew.root.sizes = [0.97, 0.03];
  const fixed = L.normalize(skew, { w: 1000, h: 700 });
  assert.ok(fixed.root.sizes[1] >= 0.16 - 1e-9, 'a 160 px pane at least: ' + fixed.root.sizes);
  const tiny = L.normalize(skew, { w: 200, h: 700 });
  assert.deepEqual(J(tiny.root.sizes), [0.5, 0.5], 'no room for two panes of the minimum: equal');
});

test('float / dock / minimize / restore', () => {
  let lay = L.split(build(1, 2, 3), 'g1', 'right', 3);
  lay = check(L.float(lay, 2, { x: 5.4, y: 7, w: 10, h: 10 }), 'float');
  assert.deepEqual(J(lay.floating), [{ docId: 2, x: 5, y: 7, w: L.MIN_W, h: L.MIN_H }], 'rect clamped to the minimum size');
  assert.equal(lay.active, 2);
  lay = check(L.float(lay, 1, { x: 50, y: 50, w: 300, h: 200 }), 'second float');
  lay = L.activate(lay, 2);
  assert.deepEqual(J(lay.floating.map((f) => f.docId)), [1, 2], 'z-order = array order, the activated one on top');
  const g = L.groupOf(lay, 3).id;
  lay = check(L.dock(lay, 2, g, 'center'), 'dock');
  assert.deepEqual(J(L.groupOf(lay, 3).tabs), [3, 2]);
  lay = check(L.minimize(lay, 3), 'minimize');
  assert.deepEqual(J(lay.minimized), [{ docId: 3, from: g }]);
  assert.notEqual(lay.active, 3);
  lay = check(L.restore(lay, 3), 'restore to the group it came from');
  assert.equal(L.groupOf(lay, 3).id, g); assert.equal(lay.minimized.length, 0); assert.equal(lay.active, 3);
  let m = L.minimize(L.float(build(1, 2), 2, { x: 0, y: 0, w: 300, h: 200 }), 2);
  assert.equal(m.minimized[0].from, null);
  m = check(L.restore(m, 2), 'restore a floating one that was minimised');
  assert.ok(L.groupOf(m, 2), 'comes back as a tab');
  const gone = L.minimize(L.split(build(1, 2), 'g1', 'right', 2), 2);
  const back = check(L.restore(gone, 2), 'its group is gone');
  assert.ok(L.groupOf(back, 2));
  assert.equal(L.activate(L.minimize(build(1, 2), 1), 1).minimized.length, 0, 'activating a minimised doc restores it');
});

test('tile / cascade / putBehind / maximize', () => {
  let lay = L.float(L.minimize(build(1, 2, 3, 4), 4), 3, { x: 1, y: 1, w: 300, h: 200 });
  lay = check(L.tile(lay, [1, 2, 3, 4]), 'tile');
  assert.equal(lay.floating.length, 0); assert.equal(lay.minimized.length, 0);
  assert.equal(L.groups(lay).length, 4);
  assert.equal(lay.root.type, 'split'); assert.equal(lay.root.dir, 'col');
  const keepHidden = check(L.tile(build(1, 2, 3), [1, 2]), 'tile leaves a hidden doc');
  assert.ok(L.has(keepHidden, 3));
  lay = check(L.cascade(build(1, 2, 3), { x: 24, y: 24, w: 900, h: 600 }), 'cascade');
  assert.equal(lay.root, null); assert.equal(lay.floating.length, 3);
  assert.equal(lay.floating[1].x - lay.floating[0].x, 28); assert.equal(lay.floating[1].y - lay.floating[0].y, 28);
  let t = build(1, 2, 3);
  t = L.putBehind(t);
  assert.equal(t.active, 1, 'Put Behind: the next tab of the active group (wrapping)');
  t = check(L.split(build(1, 2), 'g1', 'right', 2));
  t = L.activate(t, 1);
  assert.equal(L.putBehind(t).active, 2, 'one tab per group: the next view in order');
  const mx = L.maximize(t, L.groupOf(t, 1).id);
  assert.equal(mx.maximized, L.groupOf(t, 1).id);
  assert.equal(L.maximize(mx, null).maximized, null);
  assert.equal(L.normalize(L.remove(mx, 1)).maximized, null, 'a maximised group that is gone is repaired');
});

test('dropZoneAt: 25 % edges, centre otherwise, null outside', () => {
  const r = { x: 100, y: 50, w: 400, h: 200 };
  assert.equal(L.dropZoneAt(r, 110, 150), 'left');
  assert.equal(L.dropZoneAt(r, 490, 150), 'right');
  assert.equal(L.dropZoneAt(r, 300, 55), 'top');
  assert.equal(L.dropZoneAt(r, 300, 245), 'bottom');
  assert.equal(L.dropZoneAt(r, 300, 150), 'center');
  assert.equal(L.dropZoneAt(r, 199, 150), 'left');
  assert.equal(L.dropZoneAt(r, 201, 150), 'center');
  assert.equal(L.dropZoneAt(r, 99, 150), null);
  assert.equal(L.dropZoneAt({ x: 0, y: 0, w: 0, h: 10 }, 0, 0), null);
  assert.equal(L.dropZoneAt(r, 110, 55), 'left', 'a corner: the nearest edge');
});

test('serialize / validate: round trip, unknown ids dropped, missing docs appended, garbage never throws', () => {
  let lay = L.float(L.split(build(1, 2, 3), 'g1', 'right', 3), 2, { x: 4, y: 4, w: 300, h: 200 });
  lay = L.minimize(lay, 1);
  const back = L.validate(L.serialize(lay), [1, 2, 3]);
  assert.deepEqual(J(back), J(L.normalize(lay)), 'a round trip is the identity');
  const dropped = check(L.validate(L.serialize(lay), [1, 3]), 'unknown id');
  assert.ok(!L.has(dropped, 2));
  const appended = check(L.validate(L.serialize(lay), [1, 2, 3, 4, 5]), 'missing docs');
  assert.ok(L.has(appended, 4) && L.has(appended, 5));
  for (const junk of [null, undefined, 5, 'x', [], {}, { root: 7 }, { root: { type: 'split' } }, { root: { type: 'group', tabs: 'a' } },
    { root: { type: 'split', dir: 'row', children: [null, { type: 'group', tabs: [1, 1, 'x'], current: 9 }], sizes: [NaN, 'a'] } },
    { floating: [{ docId: 1, x: 'a' }, null, { docId: 1 }], minimized: [{ docId: 'q' }, { docId: 1 }], active: 99, maximized: 5, seq: -4 }]) {
    const v = L.validate(junk, [1, 2]);
    check(v, 'junk ' + JSON.stringify(junk));
    assert.ok(L.has(v, 1) && L.has(v, 2), 'every known doc is somewhere');
  }
  // a deeply nested document does not blow the stack
  let deep = { type: 'group', tabs: [1], current: 1 };
  for (let i = 0; i < 5000; i++) deep = { type: 'split', dir: i % 2 ? 'row' : 'col', sizes: [0.5, 0.5], children: [deep, { type: 'group', tabs: [2], current: 2 }] };
  check(L.validate({ root: deep }, [1, 2]), 'deep');
  // duplicated ids inside the data are repaired
  const dup = L.validate({ root: { type: 'split', dir: 'row', sizes: [0.5, 0.5], id: 's1', children: [{ type: 'group', id: 'g1', tabs: [1], current: 1 }, { type: 'group', id: 'g1', tabs: [2], current: 2 }] }, seq: 1 }, [1, 2]);
  const gids = L.groups(dup).map((g) => g.id);
  assert.equal(new Set(gids).size, gids.length, 'unique group ids');
});

test('every operation returns a NEW layout and leaves its argument alone', () => {
  const base = L.float(L.split(build(1, 2, 3), 'g1', 'right', 3), 2, { x: 4, y: 4, w: 300, h: 200 });
  const frozen = JSON.stringify(base);
  const ops = [() => L.addTab(base, 9), () => L.split(base, L.groups(base)[0].id, 'top', 9), () => L.remove(base, 1), () => L.move(base, 1, L.groups(base)[1].id, 'center'),
    () => L.resize(base, base.root.id, 0, 0.1), () => L.equalize(base, base.root.id), () => L.float(base, 1, {}), () => L.minimize(base, 1), () => L.tile(base, [1, 2, 3]),
    () => L.cascade(base, { x: 0, y: 0, w: 800, h: 600 }), () => L.putBehind(base), () => L.activate(base, 1), () => L.maximize(base, L.groups(base)[0].id), () => L.normalize(base)];
  for (const op of ops) { const out = op(); assert.notEqual(out, base); assert.equal(JSON.stringify(base), frozen); }
});

test('document ids are strings in the engine: every operation accepts them', () => {
  const ids = ['dia1', 'dib2', 'dic3', 'did4', 'die5'];
  let lay = ids.slice(0, 2).reduce((l, d) => L.addTab(l, d), L.empty());
  lay = L.gridWithSource(lay, 'dia1', ids.slice(2), { aspect: 1, extentPx: { w: 1000, h: 700 } });
  for (const d of ids) assert.ok(L.has(lay, d), d);
  assert.deepEqual(J(L.order(lay)).slice().sort(), ids.slice().sort());
  const back = L.validate(L.serialize(L.minimize(L.float(lay, 'dic3', { x: 1, y: 1, w: 300, h: 200 }), 'did4')), ids);
  for (const d of ids) assert.ok(L.has(back, d), 'validate keeps ' + d);
  assert.equal(L.validate(L.serialize(lay), ['dia1']).root.tabs.length, 1, 'unknown string ids are dropped');
  assert.equal(L.remove(lay, 'dia1').active !== 'dia1', true);
});

test('restore puts a lone pane back where it was (its group was gone)', () => {
  // 2×2 grid: source + three views; minimise the bottom-right one, then restore it.
  let lay = L.gridWithSource(build(1), 1, [2, 3, 4], { aspect: 1, extentPx: { w: 1000, h: 800 } });
  const before = J(L.serialize(lay).root);
  const g4 = L.groupOf(lay, 4).id;
  let m = check(L.minimize(lay, 4), 'minimise bottom-right');
  assert.equal(m.minimized[0].from, g4);
  assert.ok(m.minimized[0].near !== undefined && ['left', 'right', 'top', 'bottom'].includes(m.minimized[0].side));
  const r = check(L.restore(m, 4), 'restore');
  assert.equal(L.groupOf(r, 4).tabs.length, 1, 'its own pane, not a tab of another one');
  const shape = (n) => n.type === 'group' ? n.tabs.join(',') : n.dir + '(' + n.children.map(shape).join(' ') + ')';
  assert.equal(shape(r.root), shape(before), 'same arrangement as before minimising');
  // first child of its split: comes back on the left / top
  const l2 = L.split(build(1), L.groupOf(build(1), 1).id, 'left', 2);
  const back = check(L.restore(L.minimize(l2, 2), 2), 'left pane');
  assert.equal(shape(back.root), shape(l2.root));
  // survives serialize/validate
  const v = L.validate(L.serialize(m), [1, 2, 3, 4]);
  assert.equal(shape(check(L.restore(v, 4), 'after validate').root), shape(before));
});

console.log(`ij layout pure: ${n} groups ok`);
