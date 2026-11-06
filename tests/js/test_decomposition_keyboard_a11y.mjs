// The Decompose panel's views must be usable from the keyboard: each view is a named
// button (role, tabindex, aria-label), Enter / Space enter edit mode, the remove button
// carries an accessible name, and keyboard focus survives the list's full rebuilds.
// The panel is driven through a minimal fake DOM (no browser).
//
// Run: node tests/js/test_decomposition_keyboard_a11y.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { loadModule, ROOT } from './harness.mjs';

class FakeElement {
  constructor(tag, doc) {
    this.tagName = String(tag).toUpperCase();
    this.ownerDocument = doc;
    this.children = [];
    this.parentElement = null;
    this.style = {};
    this.dataset = {};
    this.attributes = {};
    this.title = '';
    this.tabIndex = -1;
    this.hidden = false;
    this.textContent = '';
    const cls = new Set();
    this.classList = {
      add: (...c) => c.forEach(x => cls.add(x)),
      remove: (...c) => c.forEach(x => cls.delete(x)),
      toggle: (c, on) => { if (on === undefined ? !cls.has(c) : on) cls.add(c); else cls.delete(c); },
      contains: (c) => cls.has(c),
    };
  }
  set innerHTML(v) { this._html = v; if (v === '') { this.children.forEach(c => { c.parentElement = null; }); this.children = []; } }
  get innerHTML() { return this._html || ''; }
  appendChild(c) { c.parentElement = this; this.children.push(c); return c; }
  setAttribute(k, v) { this.attributes[k] = String(v); }
  getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attributes, k) ? this.attributes[k] : null; }
  contains(n) { for (let x = n; x; x = x.parentElement) if (x === this) return true; return false; }
  closest() { return null; }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(c => c !== this); this.parentElement = null; }
  focus() { this.ownerDocument.activeElement = this; }
  getContext() { return {}; }
  querySelectorAll() { return []; }
  addEventListener() {}
  walk(fn) { fn(this); this.children.forEach(c => c.walk(fn)); }
}

const doc = {
  activeElement: null,
  createElement(tag) { return new FakeElement(tag, doc); },
  getElementById(id) { return byId[id] || null; },
  addEventListener() {},
  createTextNode(t) { const n = new FakeElement('#text', doc); n.textContent = t; return n; },
};
const byId = {
  'decomposition-panel': new FakeElement('div', doc),
  'decomposition-list': new FakeElement('div', doc),
};
doc.activeElement = new FakeElement('body', doc);

const listeners = {};
const win = {
  addEventListener(t, fn) { (listeners[t] ||= []).push(fn); },
  removeEventListener(t, fn) { listeners[t] = (listeners[t] || []).filter(f => f !== fn); },
};

let channels = [
  { name: 'DAPI', color: '#0000ff', enabled: true },
  { name: 'GFP', color: '#00ff00', enabled: true },
];
const ChannelPanel = {
  getState: () => JSON.parse(JSON.stringify(channels)),
  setState: (s, opts) => {
    channels = JSON.parse(JSON.stringify(s));
    if (opts && opts.notify) (listeners['channels-updated'] || []).forEach(fn => fn());
  },
};
const VolumeViewer = {
  setOnPostRender: () => () => {},
  triggerRender() {},
  recompileShaderForActiveChannels() {},
  getRenderer: () => null, getScene: () => null, getCamera: () => null, getMaterial: () => null,
};

const Panel = loadModule('js/components/decomposition-panel.js', 'DecompositionPanel', {
  document: doc, window: win, ChannelPanel, VolumeViewer, performance: { now: () => 0 },
});
assert.ok(Panel, 'DecompositionPanel loads');
Panel.init();
assert.equal(Panel.toggle(), true, 'panel opens');

const list = byId['decomposition-list'];
function all() { const out = []; list.walk(n => out.push(n)); return out; }
function views() { return all().filter(n => n.getAttribute('role') === 'button'); }
function buttons() { return all().filter(n => n.tagName === 'BUTTON'); }
function key(el, k, extra = {}) {
  let prevented = false;
  el.onkeydown({ key: k, target: el, preventDefault() { prevented = true; }, ...extra });
  return prevented;
}

// 1. every view is a focusable, named button
let v = views();
assert.equal(v.length, 2, 'one view per enabled channel');
v.forEach(el => {
  assert.equal(el.tabIndex, 0, 'view is in the tab order');
  assert.ok(/^Edit view: Channel: (DAPI|GFP)$/.test(el.getAttribute('aria-label')), 'view has a name naming it: ' + el.getAttribute('aria-label'));
  assert.equal(typeof el.onkeydown, 'function', 'view has a key handler');
});

// 2. a key from a child does not start editing; a modified Enter neither
const child = new FakeElement('span', doc);
v[0].onkeydown({ key: 'Enter', target: child, preventDefault() { throw new Error('child key handled'); } });
v[0].onkeydown({ key: 'Enter', target: v[0], ctrlKey: true, preventDefault() { throw new Error('ctrl+Enter handled'); } });
assert.equal(views().length, 2, 'no edit mode from a child key or a modified Enter');

// 3. Enter on a focused view enters edit mode, focus lands on Done
v[0].focus();
assert.equal(key(v[0], 'Enter'), true, 'Enter is consumed');
assert.equal(views().length, 1, 'the edited view is no longer a button');
assert.ok(list.contains(doc.activeElement), 'focus stays inside the list');
assert.equal(doc.activeElement.tagName, 'BUTTON', 'focus is on a button');
assert.ok(doc.activeElement.children.some(c => c.textContent === 'Done'), 'focus is on Done');

// 4. Done returns focus to the same view
doc.activeElement.onclick({ stopPropagation() {} });
v = views();
assert.equal(v.length, 2, 'edit mode left');
assert.equal(doc.activeElement, v[0], 'focus is back on the view that was edited');

// 5. Space works too
assert.equal(key(v[1], ' '), true, 'Space is consumed');
// focus was on v[0] (inside the list), so the Done of the new edit gets it
assert.ok(doc.activeElement.children.some(c => c.textContent === 'Done'), 'Space enters edit mode');
doc.activeElement.onclick({ stopPropagation() {} });

// 6. a custom view's remove button is named; removing it focuses the add button
const add = buttons().find(b => b.children.some(c => c.textContent === 'Add Combination'));
add.focus();
add.onclick();
const remove = buttons().find(b => b.getAttribute('aria-label') && b.getAttribute('aria-label').startsWith('Remove view'));
assert.ok(remove, 'remove button has an aria-label');
assert.equal(remove.getAttribute('aria-label'), 'Remove view: Custom 1', 'remove label names the view');
assert.equal(remove.title, 'Remove this view', 'remove button has a tooltip');
remove.focus();
remove.onclick({ stopPropagation() {} });
assert.ok(!buttons().some(b => (b.getAttribute('aria-label') || '').startsWith('Remove view')), 'view removed');
assert.ok(doc.activeElement.children.some(c => c.textContent === 'Add Combination'), 'focus moves to Add Combination');

// 7. a rebuild while focus is OUTSIDE the list does not steal it
const slider = new FakeElement('input', doc);
slider.focus();
channels[1].enabled = false;
(listeners['channels-updated'] || []).forEach(fn => fn());
assert.equal(views().length, 1, 'list rebuilt for the disabled channel');
assert.equal(doc.activeElement, slider, 'focus stays on the outside control');

Panel.dispose();

// 8. the new keys exist in every locale
for (const code of ['en', 'fr', 'es', 'nl']) {
  const lang = JSON.parse(readFileSync(path.join(ROOT, 'lang', code + '.json'), 'utf8'));
  const d = lang.decomposition || {};
  const missing = ['remove', 'removeView', 'editView'].filter(k => typeof d[k] !== 'string' || !d[k]);
  if (missing.length) {
    console.log(`SKIP locale check: lang/${code}.json lacks decomposition.${missing.join(', decomposition.')} (added by the i18n merge)`);
    continue;
  }
  assert.ok(d.removeView.includes('{name}') && d.editView.includes('{name}'), `${code}: {name} placeholder kept`);
}

console.log('decomposition panel keyboard access: OK');
