// Presentation mode hides the header that holds its own toggle, so the plugin must
// give a way out while it is on:
//   • entering mounts a floating exit button on the canvas (labelled through the
//     plugin's dictionary) and listens for Escape; leaving removes both;
//   • Escape leaves the mode, except while a modal or the Studio is open, inside a
//     text field, or when another handler already consumed the key;
//   • the exit button leaves the mode; a restored state (setState) gets the same
//     controls; dispose() leaves nothing behind;
//   • every locale of the plugin carries the new key.
//
// Run: node tests/js/test_presentation_mode_exit.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT } from './harness.mjs';

const PLUGIN_DIR = path.join(ROOT, 'js/modules/tools/presentation-mode');
const SRC = readFileSync(path.join(PLUGIN_DIR, 'index.js'), 'utf8');

function classList() {
  const set = new Set();
  return {
    add: (c) => set.add(c),
    remove: (c) => set.delete(c),
    toggle: (c, on) => { const want = on === undefined ? !set.has(c) : !!on; if (want) set.add(c); else set.delete(c); return want; },
    contains: (c) => set.has(c)
  };
}

function makeEl(tag) {
  const el = {
    tagName: tag.toUpperCase(), children: [], parent: null, attrs: {}, listeners: {},
    className: '', textContent: '', title: '', type: '',
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return this.attrs[k] ?? null; },
    append(...nodes) { nodes.forEach(n => this.appendChild(n)); },
    appendChild(n) { n.parent = this; this.children.push(n); return n; },
    remove() { if (this.parent) { this.parent.children = this.parent.children.filter(c => c !== this); this.parent = null; } },
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
    click() { (this.listeners.click || []).forEach(fn => fn({ target: this })); },
    focus() { doc.activeElement = this; },
    querySelector(sel) {
      const cls = sel.startsWith('.') ? sel.slice(1) : null;
      const walk = (n) => { for (const c of n.children) { if (cls && c.className === cls) return c; const f = walk(c); if (f) return f; } return null; };
      return walk(this);
    },
    closest() { return null; }
  };
  return el;
}

const canvasHost = makeEl('div');
const toolbarBtn = makeEl('button');
const docListeners = {};
const doc = {
  activeElement: null,
  body: Object.assign(makeEl('body'), { classList: classList() }),
  createElement: makeEl,
  querySelector(sel) {
    if (sel === '.viewer-canvas-container') return canvasHost;
    if (sel === '[data-plugin-id="presentation-mode"]') return toolbarBtn;
    return null;
  },
  addEventListener(type, fn) { (docListeners[type] ||= []).push(fn); },
  removeEventListener(type, fn) { docListeners[type] = (docListeners[type] || []).filter(f => f !== fn); }
};

function keydown(key, { target = doc.body, defaultPrevented = false } = {}) {
  const e = { key, target, defaultPrevented, preventDefault() { this.defaultPrevented = true; } };
  (docListeners.keydown || []).slice().forEach(fn => fn(e));
  return e;
}

let impl = null;
const syncs = [];
let studioOpen = false;
const sandbox = {
  document: doc,
  window: { lucide: { createIcons() {} } },
  PluginRegistry: {
    implement: (id, obj) => { assert.equal(id, 'presentation-mode'); impl = obj; },
    syncToolbarButton: (id, r) => syncs.push(r.active)
  },
  StudioEditor: { isOpen: () => studioOpen },
  console
};
vm.createContext(sandbox);
vm.runInContext(SRC, sandbox, { filename: 'presentation-mode/index.js' });
assert.ok(impl, 'the plugin registers itself');

let resizes = 0;
const ctx = {
  ui: { scheduleResize: () => { resizes++; } },
  i18n: { t: (k) => (k === 'exit' ? 'Exit presentation mode' : k), onLanguageChange: () => () => {} }
};
impl.init(ctx);

const exitBtn = () => canvasHost.children.find(c => c.className === 'presentation-exit-btn') || null;
const active = () => doc.body.classList.contains('presentation-mode');

// Entering mounts the exit button, focused and labelled.
assert.equal(impl.activate().active, true);
assert.equal(active(), true);
assert.ok(exitBtn(), 'an exit button is mounted on the canvas');
assert.equal(exitBtn().getAttribute('aria-label'), 'Exit presentation mode');
assert.equal(exitBtn().querySelector('.presentation-exit-label').textContent, 'Exit presentation mode');
assert.equal(doc.activeElement, exitBtn(), 'focus moves to the exit button (the toolbar button is hidden)');

// Escape is left to what owns it.
assert.equal(keydown('Escape', { defaultPrevented: true }).defaultPrevented, true);
assert.equal(active(), true, 'a consumed Escape does not leave the mode');
doc.body.classList.add('modal-open');
keydown('Escape');
assert.equal(active(), true, 'Escape closes the modal first');
doc.body.classList.remove('modal-open');
studioOpen = true;
keydown('Escape');
assert.equal(active(), true, 'Escape belongs to the Studio while it is open');
studioOpen = false;
const field = Object.assign(makeEl('input'), { closest: () => ({}) });
keydown('Escape', { target: field });
assert.equal(active(), true, 'Escape in a text field is the field\'s');
keydown('Enter');
assert.equal(active(), true);

// Escape leaves the mode and removes the controls.
const e = keydown('Escape');
assert.equal(e.defaultPrevented, true);
assert.equal(active(), false);
assert.equal(exitBtn(), null, 'the exit button is removed');
assert.equal((docListeners.keydown || []).length, 0, 'the Escape listener is removed');
assert.equal(syncs.at(-1), false, 'the toolbar button is told the mode is off');
assert.equal(doc.activeElement, toolbarBtn, 'focus returns to the toolbar toggle');

// A restored state gets the same way out; the button leaves the mode.
impl.setState({ presentationMode: true });
assert.equal(active(), true);
assert.equal(syncs.at(-1), true);
assert.ok(exitBtn());
exitBtn().click();
assert.equal(active(), false);
assert.equal(exitBtn(), null);
assert.equal(impl.getState().presentationMode, false);

// reset() and dispose() leave nothing behind.
impl.setState({ presentationMode: true });
impl.reset();
assert.equal(active(), false);
impl.setState({ presentationMode: true });
impl.dispose();
assert.equal(active(), false);
assert.equal(exitBtn(), null);
assert.equal((docListeners.keydown || []).length, 0);
assert.ok(resizes > 0);

// The key exists in every shipped locale.
const meta = JSON.parse(readFileSync(path.join(PLUGIN_DIR, 'plugin.json'), 'utf8'));
for (const code of meta.i18nLanguages) {
  const dict = JSON.parse(readFileSync(path.join(PLUGIN_DIR, 'lang', `${code}.json`), 'utf8'));
  assert.equal(typeof dict.exit, 'string', `lang/${code}.json carries "exit"`);
  assert.ok(dict.exit.trim().length > 0);
}

console.log('test_presentation_mode_exit: ok');
