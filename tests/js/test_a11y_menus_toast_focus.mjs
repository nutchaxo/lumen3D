// Accessibility of the shared chrome: the language menu (aria state, Escape, closes on a
// pick, highlight refreshed after an async switch), the focus trap used by modals, the
// toast live region and its duration, the About template's #contact anchor, and the
// explorer cards (no interactive control inside the link).
//
// There is no DOM in Node: a small element model implements the surface these modules touch.
//
// Run: node tests/js/test_a11y_menus_toast_focus.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { loadModule, ROOT } from './harness.mjs';

// ── minimal DOM ──────────────────────────────────────────────────────────────
class Doc {
  constructor() { this.listeners = {}; this.activeElement = null; this.byId = {}; this.body = new El(this, 'body'); }
  createElement(tag) { return new El(this, tag); }
  createTextNode(t) { const n = new El(this, '#text'); n.text = t; return n; }
  getElementById(id) { return this.byId[id] || null; }
  querySelector(sel) { return this.body.find(sel)[0] || null; }
  querySelectorAll(sel) { return this.body.find(sel); }
  addEventListener(t, fn, cap) { (this.listeners[t] ||= []).push({ fn, cap: !!cap }); }
  removeEventListener(t, fn) { this.listeners[t] = (this.listeners[t] || []).filter(l => l.fn !== fn); }
  fire(t, ev) {
    const out = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {}, ...ev };
    for (const l of [...(this.listeners[t] || [])]) l.fn(out);
    return out;
  }
}
class El {
  constructor(doc, tag) {
    this.doc = doc; this.tagName = tag.toUpperCase(); this.children = []; this.parent = null;
    this.attrs = {}; this.dataset = {}; this.classes = new Set(); this.text = ''; this.handlers = {};
    this.disabled = false; this.visible = true;
  }
  get isConnected() { let n = this; while (n.parent) n = n.parent; return n === this.doc.body; }
  get className() { return [...this.classes].join(' '); }
  set className(v) { this.classes = new Set(String(v).split(/\s+/).filter(Boolean)); }
  get classList() {
    const s = this.classes;
    return {
      add: (...c) => c.forEach(x => s.add(x)),
      remove: (...c) => c.forEach(x => s.delete(x)),
      contains: (c) => s.has(c),
      toggle: (c, on) => { const want = on ?? !s.has(c); if (want) s.add(c); else s.delete(c); return want; },
    };
  }
  set textContent(v) { this.children = []; this.text = String(v); }
  get textContent() { return this.text + this.children.map(c => c.textContent).join(''); }
  setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'class') this.className = v; }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  hasAttribute(k) { return k in this.attrs; }
  removeAttribute(k) { delete this.attrs[k]; }
  appendChild(c) { c.parent = this; this.children.push(c); return c; }
  addEventListener(t, fn) { (this.handlers[t] ||= []).push(fn); }
  click() { for (const fn of this.handlers.click || []) fn({ target: this }); }
  contains(n) { for (let x = n; x; x = x.parent) if (x === this) return true; return false; }
  focus() { this.doc.activeElement = this; }
  getClientRects() { return this.visible ? [{}] : []; }
  all() { return this.children.flatMap(c => [c, ...c.all()]); }
  matches(sel) {
    return sel.split(',').some((part) => {
      part = part.trim();
      if (part.startsWith('.')) return this.classes.has(part.slice(1));
      if (part === 'button:not([disabled])') return this.tagName === 'BUTTON' && !this.disabled;
      if (part === 'input:not([disabled]):not([type="hidden"])') return this.tagName === 'INPUT' && !this.disabled;
      return this.tagName === part.toUpperCase();
    });
  }
  find(sel) { return this.all().filter(n => n.matches(sel)); }
  querySelector(sel) { return this.find(sel)[0] || null; }
  querySelectorAll(sel) { return this.find(sel); }
}
const FOCUSABLE_TAGS = 'button:not([disabled]), input:not([disabled]):not([type="hidden"])';
// The trap's selector list is the module's own; the model only needs buttons and inputs.
class TrapEl extends El { find(sel) { return sel.includes('a[href]') ? this.all().filter(n => n.matches(FOCUSABLE_TAGS)) : super.find(sel); } }

// ── Utils: language menu ─────────────────────────────────────────────────────
function makeUtils() {
  const doc = new Doc();
  let lang = 'en';
  const I18n = {
    getAvailableLanguages: () => [{ code: 'en', flag: 'E', native: 'English' }, { code: 'fr', flag: 'F', native: 'Francais' }],
    getLanguage: () => lang,
  };
  const dropdown = doc.createElement('div'); dropdown.className = 'dropdown'; doc.byId['lang-dropdown'] = dropdown;
  const trigger = doc.createElement('button'); trigger.setAttribute('data-action', 'lang-dropdown');
  const menu = doc.createElement('div'); menu.className = 'dropdown-menu';
  dropdown.appendChild(trigger); dropdown.appendChild(menu); doc.body.appendChild(dropdown);
  const Utils = loadModule('js/core/utils.js', 'Utils', {
    window: { location: { origin: 'http://x' } }, document: doc, I18n, requestAnimationFrame: () => {},
  });
  return { doc, Utils, dropdown, trigger, menu, setLang: (l) => { lang = l; } };
}
const tick = () => new Promise(r => setTimeout(r, 5));

{
  const { doc, Utils, dropdown, trigger, menu, setLang } = makeUtils();
  let switched = null;
  const onSwitch = (code) => new Promise((resolve) => setTimeout(() => { setLang(code); switched = code; resolve(); }, 10));
  Utils.populateLanguageMenu(onSwitch);

  assert.equal(trigger.getAttribute('aria-haspopup'), 'true', 'trigger announces a popup');
  assert.equal(trigger.getAttribute('aria-expanded'), 'false');
  const items = menu.find('.dropdown-item');
  assert.equal(items.length, 2);
  assert.ok(items[0].classList.contains('active') && items[0].getAttribute('aria-current') === 'true', 'active locale marked');

  Utils.toggleDropdown('lang-dropdown');
  await tick();
  assert.ok(dropdown.classList.contains('open'));
  assert.equal(trigger.getAttribute('aria-expanded'), 'true');

  // Escape closes it and returns focus to the trigger.
  doc.activeElement = items[1];
  const esc = doc.fire('keydown', { key: 'Escape' });
  assert.ok(!dropdown.classList.contains('open'), 'Escape closes the menu');
  assert.equal(trigger.getAttribute('aria-expanded'), 'false');
  assert.equal(doc.activeElement, trigger, 'focus goes back to the trigger');
  assert.ok(esc.defaultPrevented);
  assert.equal((doc.listeners.keydown || []).length, 0, 'the Escape listener is gone');
  assert.equal((doc.listeners.click || []).length, 0, 'no outside-click listener left behind');

  // Open again, outside click closes and unhooks.
  Utils.toggleDropdown('lang-dropdown'); await tick();
  assert.ok(dropdown.classList.contains('open'));
  doc.fire('click', { target: doc.body });
  assert.ok(!dropdown.classList.contains('open'), 'outside click closes');
  assert.equal((doc.listeners.keydown || []).length, 0);

  // Picking closes at once; the highlight follows once the (async) switch settles.
  Utils.toggleDropdown('lang-dropdown'); await tick();
  items[1].click();
  assert.ok(!dropdown.classList.contains('open'), 'a pick closes the menu');
  assert.ok(items[0].classList.contains('active'), 'still the old language until the switch settles');
  await new Promise(r => setTimeout(r, 30));
  assert.equal(switched, 'fr');
  assert.ok(items[1].classList.contains('active') && !items[0].classList.contains('active'), 'highlight refreshed');
  assert.equal(items[0].getAttribute('aria-current'), null);
  assert.equal((doc.listeners.keydown || []).length, 0);
}

// An unrelated dropdown (admin) keeps its own ARIA: only the data-action trigger is synced.
{
  const { doc, Utils } = makeUtils();
  const dd = doc.createElement('div'); dd.className = 'dropdown'; doc.byId['other'] = dd;
  const b = doc.createElement('button'); dd.appendChild(b); doc.body.appendChild(dd);
  Utils.toggleDropdown('other'); await tick();
  assert.ok(dd.classList.contains('open'));
  assert.equal(b.getAttribute('aria-expanded'), null);
  Utils.closeDropdowns();
  assert.ok(!dd.classList.contains('open'));
}

// ── Utils.trapFocus ──────────────────────────────────────────────────────────
{
  const doc = new Doc();
  const Utils = loadModule('js/core/utils.js', 'Utils', { window: { location: { origin: 'http://x' } }, document: doc, requestAnimationFrame: () => {} });
  const opener = doc.createElement('button'); doc.body.appendChild(opener); opener.focus();
  const modal = new TrapEl(doc, 'div'); doc.body.appendChild(modal);
  const a = doc.createElement('button'); const input = doc.createElement('input'); const z = doc.createElement('button');
  const hidden = doc.createElement('button'); hidden.visible = false;
  [a, hidden, input, z].forEach(n => modal.appendChild(n));

  const release = Utils.trapFocus(modal, { initialFocus: input });
  assert.equal(doc.activeElement, input, 'focus moves in (initialFocus)');
  doc.activeElement = z;
  let ev = doc.fire('keydown', { key: 'Tab', shiftKey: false });
  assert.ok(ev.defaultPrevented); assert.equal(doc.activeElement, a, 'Tab on the last control wraps to the first (hidden skipped)');
  ev = doc.fire('keydown', { key: 'Tab', shiftKey: true });
  assert.equal(doc.activeElement, z, 'Shift+Tab on the first control wraps to the last');
  doc.activeElement = opener;
  doc.fire('keydown', { key: 'Tab' });
  assert.equal(doc.activeElement, a, 'focus that escaped is pulled back');
  ev = doc.fire('keydown', { key: 'Tab' });
  assert.equal(ev.defaultPrevented, false, 'Tab inside the ring is left to the browser');
  release();
  assert.equal(doc.activeElement, opener, 'release restores the opener');
  assert.equal((doc.listeners.keydown || []).length, 0);
  release();   // idempotent
}

// ── Toast ────────────────────────────────────────────────────────────────────
{
  const doc = new Doc();
  const timers = [];
  const EM = loadModule('js/core/export-manager.js', 'ExportManager', {
    document: doc, window: {}, setTimeout: (fn, ms) => { timers.push(ms); return timers.length; }, clearTimeout() {},
  });
  EM.toast('short');
  const node = doc.querySelector('.app-toast');
  assert.equal(node.getAttribute('role'), 'status');
  assert.equal(node.getAttribute('aria-live'), 'polite');
  assert.equal(node.getAttribute('aria-atomic'), 'true');
  assert.equal(timers.at(-1), 1800, 'a short message keeps the 1.8 s floor');
  EM.toast('x'.repeat(80));
  assert.equal(timers.at(-1), 4800, '60 ms a character');
  EM.toast('x'.repeat(500));
  assert.equal(timers.at(-1), 8000, 'capped at 8 s');
  EM.toast('failed', { error: true });
  assert.equal(node.getAttribute('role'), 'alert');
  assert.equal(node.getAttribute('aria-live'), 'assertive');
  EM.toast('fine again');
  assert.equal(node.getAttribute('role'), 'status');
  assert.equal(doc.body.children.filter(c => c.classList.contains('app-toast')).length, 1, 'one node serves every message');
}

// ── About template: the footer links about.html#contact ─────────────────────
{
  const PT = loadModule('js/core/page-templates.js', 'PageTemplates', { window: {}, document: {} });
  const sections = PT.build('about');
  const widgets = sections.flatMap(s => s.columns.flatMap(c => c.widgets));
  const anchors = widgets.filter(w => w.type === 'html' && /id="contact"/.test(w.props.html));
  assert.equal(anchors.length, 1, 'exactly one #contact anchor');
  const owner = sections.find(s => s.columns.some(c => c.widgets.includes(anchors[0])));
  assert.ok(owner.columns.some(c => c.widgets.some(w => JSON.stringify(w).includes('Get in touch'))), 'the anchor sits in the Contact section');
  const footerLink = readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  assert.ok(footerLink.includes('about.html#contact'), 'index.html still links #contact');
}

// ── Explorer cards: one link, sibling real buttons ──────────────────────────
{
  const src = readFileSync(path.join(ROOT, 'js/pages/explorer.js'), 'utf8');
  assert.ok(!/role="button"/.test(src), 'no span posing as a button');
  assert.ok(!/<a href="\$\{_datasetUrl/.test(src), 'the card itself is not a link wrapping controls');
  assert.equal((src.match(/<button type="button" class="btn btn-outline btn-sm" data-(download|compare)-id/g) || []).length, 3);
}

// ── Missing custom page: a message, not a silent redirect ───────────────────
{
  const src = readFileSync(path.join(ROOT, 'js/pages/page-view.js'), 'utf8');
  assert.ok(/function showMissing/.test(src) && /pages\.missing/.test(src) && /pages\.backHome/.test(src));
  assert.equal((src.match(/location\.replace\('index\.html'\)/g) || []).length, 1, 'only a missing slug parameter still redirects');
}

// ── Landing hero honours prefers-reduced-motion ─────────────────────────────
{
  const src = readFileSync(path.join(ROOT, 'js/pages/landing.js'), 'utf8');
  assert.ok(/prefers-reduced-motion: reduce/.test(src) && /motionQuery\.matches\) draw\(\)/.test(src));
}

console.log('a11y menus / toast / focus trap / anchors: OK');
