// orientation-2d: the panel re-renders on every language switch; a click must
// still act once (a rotate 90° stays a quarter turn, Mirror toggles once) and
// the section title must follow the language.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT, escapeHtml } from './harness.mjs';

function fakeElement() {
  const listeners = {};
  return {
    listeners,
    hidden: false,
    value: '',
    textContent: '',
    _html: '',
    classList: { toggle() {} },
    set innerHTML(v) { this._html = String(v); this._children = {}; },
    get innerHTML() { return this._html; },
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    removeEventListener(type, fn) { listeners[type] = (listeners[type] || []).filter(f => f !== fn); },
    querySelector(sel) { return (this._children ||= {})[sel] ||= fakeElement(); },
    remove() {}
  };
}

function load() {
  let impl = null;
  const PluginRegistry = {
    implement(id, obj) { impl = obj; },
    syncToolbarButton() {}
  };
  const src = readFileSync(path.join(ROOT, 'js/modules/tools/orientation-2d/index.js'), 'utf8');
  const ctx = vm.createContext({
    console, PluginRegistry,
    Utils: { isTrustedMessageOrigin: () => false },
    window: { addEventListener() {}, removeEventListener() {}, parent: null }
  });
  vm.runInContext(src, ctx, { filename: 'orientation-2d/index.js' });
  return impl;
}

const plugin = load();
let lang = 'en';
const titles = [];
const body = fakeElement();
const section = fakeElement();
let orientation = { rotationDeg: 0, flipH: false };
let setCalls = 0;
plugin.init({
  i18n: { t: (k) => `${lang}:${k}` },
  ui: {
    escapeHtml,
    createIcons() {},
    addSidebarSection(def) {
      titles.push(def.title);
      return { root: section, section, body, setTitle(t) { titles.push(t); }, setHtml() {}, show() {}, hide() {}, remove() {} };
    }
  },
  viewer: {
    addOverlay: () => () => {},
    getOrientation: () => ({ ...orientation }),
    setOrientation(o) { setCalls++; orientation = { ...o }; },
    redraw() {}
  },
  dataset: { onChange: () => () => {} }
});

function click(action) {
  const target = { closest: (sel) => (sel === '[data-o2d]' ? { dataset: { o2d: action } } : null) };
  for (const fn of body.listeners.click || []) fn({ target });
}

for (const next of ['fr', 'es', 'nl']) {
  lang = next;
  plugin.onLanguageChange();
}

assert.equal((body.listeners.click || []).length, 1, 'one delegated click listener after three language switches');

click('right');
assert.equal(orientation.rotationDeg, 90, 'rotate right turns a quarter turn, not more');
assert.equal(setCalls, 1, 'one click applies one orientation');

click('flip');
assert.equal(orientation.flipH, true, 'Mirror toggles once');

click('left');
assert.equal(orientation.rotationDeg, 0, 'rotate left turns back a quarter turn');

assert.equal(titles[0], 'en:panel', 'section created with the page language');
assert.equal(titles.at(-1), 'nl:panel', 'section title follows the language switch');
assert.match(body.innerHTML, /nl:mirror/, 'panel body re-rendered in the new language');

console.log('test_orientation_2d_listeners: ok');
