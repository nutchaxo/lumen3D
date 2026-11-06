// Keyboard access to the Studio's layer list (js/components/studio-editor.js):
//   • each row is focusable (tabindex 0), a list item named after its layer, and the
//     selected one carries aria-current;
//   • Enter / Space on a row selects its layer, out of the page's own key handler
//     (Space there would start a pan), and the row keeps the focus across the rebuild;
//   • ↑ / ↓ / Home / End move the focus between rows without selecting;
//   • keys on the eye / lock buttons are left to the buttons;
//   • a row focused by a mouse press (not :focus-visible) lets Space through to the pan
//     and is not re-focused after the rebuild;
//   • Delete on a focused row removes the selected layer and the focus moves to the row
//     now in its place;
//   • the three pages label the list (role="list" + aria-labelledby).
//
// The module runs for real in a vm; a hook spliced in before its `return {` reaches
// the closure (the source file is not modified).
//
// Run: node tests/js/test_studio_layer_list_keyboard.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT } from './harness.mjs';

const SRC = readFileSync(path.join(ROOT, 'js/components/studio-editor.js'), 'utf8').replace(/\r/g, '');
const RETURN_RE = /\n  return \{\n    init,/;
assert.ok(RETURN_RE.test(SRC), 'studio-editor.js still ends its IIFE with `return { init, …`');
const HOOK = `
  globalThis.__studio = {
    setup(container, doc, selectedId) {
      _layersContainer = container; _doc = doc; _selectedId = selectedId; _isOpen = true;
      _renderAll = () => { globalThis.__renders = (globalThis.__renders || 0) + 1; _renderLayers(); };
    },
    get selectedId() { return _selectedId; },
    get doc() { return _doc; },
    renderLayers: () => _renderLayers(),
    onKeyDown: (e) => _onKeyDown(e),
  };`;
const instrumented = SRC.replace(RETURN_RE, (m) => `\n${HOOK}${m}`);

// ── a fake DOM for the list: every innerHTML write makes NEW row / button objects ─
const doc = { activeElement: null };
let focusVisible = true;
let rows = [];
const container = {
  rows: () => rows,
  contains: (el) => rows.some(row => row === el || row.buttons.includes(el)),
  querySelectorAll: (sel) => (sel === '.studio-layer-item' ? rows.slice() : []),
  set innerHTML(html) {
    this.html = html;
    rows = [];
    const re = /<div class="studio-layer-item[^"]*"([^>]*)>([\s\S]*?)<\/div>/g;
    let m;
    while ((m = re.exec(html))) {
      const attrs = {};
      for (const a of m[1].matchAll(/([\w-]+)(?:="([^"]*)")?/g)) attrs[a[1]] = a[2] ?? '';
      rows.push(makeRow(attrs, m[2]));
    }
  },
  get innerHTML() { return this.html; },
};
function makeRow(attrs, inner) {
  const row = {
    attrs, listeners: {}, buttons: [],
    dataset: { layerId: attrs['data-layer-id'] },
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
    focus() { doc.activeElement = row; },
    matches: (sel) => (sel === ':focus-visible' ? focusVisible : false),
    closest: (sel) => (sel === '.studio-layer-item' ? row : null),
    querySelector: (sel) => row.buttons.find(b => sel === `[data-layer-action="${b.dataset.layerAction}"]`) || null,
    classList: { add() {}, remove() {} },
  };
  for (const a of inner.matchAll(/data-layer-action="([^"]+)"/g)) {
    const button = {
      dataset: { layerAction: a[1] },
      focus() { doc.activeElement = button; },
      matches: (sel) => (sel === ':focus-visible' ? focusVisible : false),
      closest: (sel) => (sel === '.studio-layer-item' ? row : sel === '[data-layer-action]' ? button : null),
    };
    row.buttons.push(button);
  }
  return row;
}
function keydown(target, key, extra = {}) {
  const row = target.closest('.studio-layer-item');
  const ev = {
    key, target, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false,
    prevented: false, stopped: false,
    preventDefault() { this.prevented = true; },
    stopPropagation() { this.stopped = true; },
    ...extra,
  };
  for (const fn of row.listeners.keydown || []) fn(ev);
  if (!ev.stopped) S.onKeyDown(ev); // the page's window listener, if it reaches it
  return ev;
}

const sandbox = {
  console, setTimeout, clearTimeout,
  requestAnimationFrame: (fn) => setTimeout(fn, 0),
  document: {
    getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
    addEventListener() {}, createElement: () => ({ style: {} }), body: { appendChild() {} },
    get activeElement() { return doc.activeElement; },
  },
  window: { innerWidth: 800, innerHeight: 600, addEventListener() {} },
};
vm.createContext(sandbox);
vm.runInContext(instrumented, sandbox, { filename: 'studio-editor.js' });
const S = sandbox.__studio;

const layer = (id, name) => ({ id, type: 'rectangle', name, visible: true, locked: false, style: {}, x: 0, y: 0, w: 10, h: 10 });
const studioDoc = { layers: [layer('a', 'First <b>'), layer('b', 'Second'), layer('c', 'Third')], guides: [] };
S.setup(container, studioDoc, 'b');
S.renderLayers();

// ── markup: focusable, named list items, the selection marked ───────────────
assert.equal(rows.length, 3);
assert.deepEqual(rows.map(r => r.dataset.layerId), ['c', 'b', 'a'], 'top layer first');
for (const row of rows) {
  assert.equal(row.attrs.tabindex, '0', 'a row is focusable');
  assert.equal(row.attrs.role, 'listitem');
}
assert.equal(rows[1].attrs['aria-current'], 'true', 'the selected layer is marked');
assert.equal(rows[0].attrs['aria-current'], undefined, 'only the selected layer is marked');
assert.equal(rows[2].attrs['aria-label'], 'First &lt;b&gt;', 'the row is named after its layer, escaped');

// ── arrows move the focus, they do not select ───────────────────────────────
rows[1].focus();
let ev = keydown(rows[1], 'ArrowDown');
assert.ok(ev.prevented && ev.stopped);
assert.equal(doc.activeElement, rows[2]);
keydown(rows[2], 'ArrowDown');
assert.equal(doc.activeElement, rows[2], 'the last row stays focused');
keydown(rows[2], 'Home');
assert.equal(doc.activeElement, rows[0]);
keydown(rows[0], 'ArrowUp');
assert.equal(doc.activeElement, rows[0], 'the first row stays focused');
keydown(rows[0], 'End');
assert.equal(doc.activeElement, rows[2]);
assert.equal(S.selectedId, 'b', 'moving the focus selects nothing');

// ── Enter selects and keeps the focus on the rebuilt row ────────────────────
ev = keydown(rows[2], 'Enter');
assert.ok(ev.prevented && ev.stopped, 'Enter is kept from the page handler');
assert.equal(S.selectedId, 'a');
assert.equal(rows[2].attrs['aria-current'], 'true');
assert.equal(doc.activeElement, rows[2], 'the NEW row of the selected layer has the focus');

// ── Space selects without starting a pan ────────────────────────────────────
rows[0].focus();
ev = keydown(rows[0], ' ');
assert.ok(ev.stopped, 'Space on a keyboard-focused row never reaches the pan');
assert.equal(S.selectedId, 'c');
assert.equal(doc.activeElement, rows[0]);

// ── keys on the row's buttons are the buttons' ──────────────────────────────
const eye = rows[1].buttons.find(b => b.dataset.layerAction === 'visible');
eye.focus();
ev = keydown(eye, 'Enter');
assert.equal(ev.stopped, false, 'Enter on the eye button is left to the button');
assert.equal(S.selectedId, 'c', 'Enter on a button selects nothing');

// ── a rebuild keeps the focus on the same button ────────────────────────────
S.renderLayers();
assert.equal(doc.activeElement?.dataset?.layerAction, 'visible');
assert.equal(doc.activeElement, rows[1].buttons.find(b => b.dataset.layerAction === 'visible'));

// ── a mouse-focused row: Space pans, no focus restored ──────────────────────
focusVisible = false;
rows[1].focus();
ev = keydown(rows[1], ' ');
assert.equal(ev.stopped, false, 'Space on a mouse-focused row reaches the pan');
assert.equal(S.selectedId, 'c', 'and selects nothing');
S.renderLayers();
assert.notEqual(doc.activeElement, rows[1], 'a mouse-focused row is not re-focused after the rebuild');
focusVisible = true;

// ── Delete on a focused row: the selection goes, the focus moves to its place ─
S.setup(container, studioDoc, 'b');
S.renderLayers();
rows[1].focus();
keydown(rows[1], 'Delete');
assert.deepEqual(S.doc.layers.map(l => l.id), ['a', 'c'], 'the selected layer is deleted');
assert.equal(rows.length, 2);
assert.equal(doc.activeElement, rows[1], 'the row now in its place has the focus');
assert.equal(rows[1].dataset.layerId, 'a');

// ── the pages label the list ────────────────────────────────────────────────
for (const page of ['viewer.html', '2d.html', 'compare.html']) {
  const html = readFileSync(path.join(ROOT, page), 'utf8');
  assert.match(html, /id="studio-layers-list" role="list" aria-labelledby="studio-layers-title"/, `${page}: list role + label`);
  assert.match(html, /class="panel-title" id="studio-layers-title"/, `${page}: the label element exists`);
}

console.log('test_studio_layer_list_keyboard: OK');
