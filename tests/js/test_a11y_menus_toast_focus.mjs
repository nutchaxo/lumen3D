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

// ── Admin markup: announcers, named switches and controls ───────────────────
{
  const html = readFileSync(path.join(ROOT, 'admpan.html'), 'utf8');
  const tag = (id) => {
    const m = new RegExp(`<[a-z]+[^>]*\\bid="${id}"[^>]*>`, 's').exec(html);
    assert.ok(m, `#${id} exists`);
    return m[0];
  };
  assert.ok(!/aria-live/.test(tag('toast-container')), 'the visual toast stack is not itself a live region');
  assert.match(tag('toast-status'), /role="status"/);
  assert.match(tag('toast-status'), /aria-live="polite"/);
  assert.match(tag('toast-alert'), /role="alert"/);
  assert.match(tag('toast-alert'), /aria-live="assertive"/);
  assert.ok(!/aria-live/.test(tag('upload-dock')), 'the dock repaints numbers several times a second: not live');
  assert.match(tag('upload-dock'), /role="region"/);
  assert.match(tag('upload-dock-status'), /role="status"/);
  assert.match(tag('upload-dock-status'), /aria-live="polite"/);
  const vis = tag('f-visible');
  assert.match(vis, /aria-label="[^"]+"/, 'the visibility switch has a name');
  assert.match(vis, /data-i18n-aria="admin\.visibleInExplorer"/);
  assert.match(vis, /aria-describedby="vis-hint"/);
  const clear = tag('search-clear');
  assert.match(clear, /type="button"/);
  assert.match(clear, /data-i18n-aria="admin\.clearSearch"/);
  assert.match(clear, /aria-label="[^"]+"/);

  const css = readFileSync(path.join(ROOT, 'css/admin-shell.css'), 'utf8');
  assert.ok(/\.adm-switch input:focus-visible \+ \.adm-switch-track\s*\{[^}]*outline/.test(css), 'switch focus is drawn on the track');
  assert.ok(/\.adm-sr-only\s*\{/.test(css), 'screen-reader-only helper exists');
  assert.ok(/\.toast-close:focus-visible/.test(css), 'the close button shows its focus');

  const plugins = readFileSync(path.join(ROOT, 'js/pages/admin/tab-plugins.js'), 'utf8');
  assert.ok(/class="adm-plugin-toggle"[^>]*aria-label="\$\{escHtml\(t\('admin\.enablePlugin'/s.test(plugins), 'each plugin switch is named after its plugin');
  for (const f of ['js/pages/admin/tab-appearance.js', 'js/pages/admin/tab-pages.js']) {
    const src = readFileSync(path.join(ROOT, f), 'utf8');
    assert.ok(!/<iframe[^>]*title="(preview|editor)"/.test(src), `${f}: iframe titles are translated`);
  }
}

// ── Admin toast (js/pages/admin/shared.js) ──────────────────────────────────
{
  const { pathToFileURL } = await import('node:url');
  class AEl extends El {
    remove() { if (this.parent) { this.parent.children = this.parent.children.filter(c => c !== this); this.parent = null; } }
    get children() { return this._kids; }
    set children(v) { this._kids = v; }
    set innerHTML(h) {
      this._kids = []; this.html = h;
      const msg = /class="toast-msg" id="([^"]+)" aria-hidden="true">([^<]*)</.exec(h);
      if (msg) { const s = new AEl(this.doc, 'span'); s.className = 'toast-msg'; s.attrs.id = msg[1]; s.attrs['aria-hidden'] = 'true'; s.text = msg[2]; this.appendChild(s); }
      const btn = /<button type="button" class="toast-close" aria-describedby="([^"]+)" aria-label="([^"]*)">/.exec(h);
      if (btn) {
        const b = new AEl(this.doc, 'button'); b.className = 'toast-close';
        b.attrs['aria-describedby'] = btn[1]; b.attrs['aria-label'] = btn[2];
        this.appendChild(b);
      }
    }
    dispatch(t, ev = {}) { for (const fn of this.handlers[t] || []) fn(ev); }
  }
  const doc = new Doc();
  doc.createElement = (tag) => new AEl(doc, tag);
  doc.baseURI = 'http://h/admpan.html';
  const container = new AEl(doc, 'div'); doc.byId['toast-container'] = container; doc.body.appendChild(container);
  const status = new AEl(doc, 'div'); doc.byId['toast-status'] = status; doc.body.appendChild(status);
  const alert = new AEl(doc, 'div'); doc.byId['toast-alert'] = alert; doc.body.appendChild(alert);

  const timers = new Map();
  let seq = 0;
  const realSetTimeout = globalThis.setTimeout, realClearTimeout = globalThis.clearTimeout;
  const prevDoc = globalThis.document, prevWin = globalThis.window;
  globalThis.document = doc;
  globalThis.window = { location: { origin: 'http://h' }, addEventListener() {} };
  // shared.js binds I18n when it is first imported (here), for the dock section too.
  const DICT = { 'upl.srProgress': 'Import: {pct} % sent', 'upl.srRowError': '{name}: {error}' };
  globalThis.I18n = { t: (k, p = {}) => (k in DICT ? DICT[k].replace(/\{(\w+)\}/g, (_, n) => String(p[n])) : k) };
  globalThis.setTimeout = (fn, ms) => { const id = ++seq; timers.set(id, { fn, ms }); return id; };
  globalThis.clearTimeout = (id) => { timers.delete(id); };
  const fire = (id) => { const tm = timers.get(id); timers.delete(id); tm.fn(); };
  const lastTimer = () => [...timers.entries()].at(-1);
  try {
    const shared = await import(pathToFileURL(path.join(ROOT, 'js/pages/admin/shared.js')).href);

    assert.equal(shared.toastDuration('ok'), 3000, '3 s floor');
    assert.equal(shared.toastDuration('x'.repeat(80)), 4800, '60 ms a character');
    assert.equal(shared.toastDuration('x'.repeat(500)), 8000, 'capped at 8 s');
    assert.equal(shared.toastDuration('x'.repeat(500), 'warning'), 8000);
    assert.equal(shared.toastDuration('short', 'error'), Infinity, 'an error stays until dismissed');

    shared.toast('Saved');
    const ok = container.children.at(-1);
    assert.equal(status.children.length, 1, 'a success is spoken through the polite announcer');
    assert.equal(status.children[0].textContent, 'Saved');
    assert.equal(alert.children.length, 0);
    const close = ok.querySelector('.toast-close');
    assert.ok(close && close.getAttribute('aria-label'), 'the close button has a name');
    assert.equal(close.getAttribute('aria-describedby'), ok.querySelector('.toast-msg').getAttribute('id'));
    const [okTimer, okT] = lastTimer();
    assert.equal(okT.ms, 3000);

    // Hover pauses, leaving resumes with what was left.
    ok.dispatch('mouseenter');
    assert.ok(!timers.has(okTimer), 'hover pauses the timer');
    ok.dispatch('mouseleave');
    const [resumed, resumedT] = lastTimer();
    assert.ok(resumedT.ms >= 1000 && resumedT.ms <= 3000, 'resumes with the time left');
    // Focus inside also pauses it, and moving focus within the toast does not resume.
    ok.dispatch('focusin');
    assert.ok(!timers.has(resumed));
    ok.dispatch('focusout', { relatedTarget: close });
    assert.equal([...timers.values()].filter(v => v.ms !== 280).length, 0, 'focus still inside: still paused');
    ok.dispatch('focusout', { relatedTarget: null });
    fire(lastTimer()[0]);
    assert.ok(ok.classList.contains('dismissing'));
    assert.equal(status.children.length, 0, 'the spoken copy goes with its toast');

    shared.toast('Delete failed: the folder is in use', 'error');
    const err = container.children.at(-1);
    assert.equal(alert.children.length, 1, 'an error is spoken through the assertive announcer');
    assert.ok(![...timers.values()].some(v => v.ms === Infinity || (v.ms >= 3000 && v.ms <= 8000)), 'no auto-dismiss timer for an error');
    err.querySelector('.toast-close').click();
    assert.ok(err.classList.contains('dismissing'), 'the close button dismisses it');
    assert.equal(alert.children.length, 0);

    // A pile of sticky errors keeps only the newest five on screen.
    for (const tm of [...timers.keys()]) fire(tm);
    for (let i = 0; i < 7; i++) shared.toast(`failure ${i}`, 'error');
    const live = container.children.filter(c => !c.classList.contains('dismissing'));
    assert.equal(live.length, 5, 'oldest toasts leave first');
    assert.equal(alert.children.length, 5);
  } finally {
    globalThis.setTimeout = realSetTimeout; globalThis.clearTimeout = realClearTimeout;
    globalThis.document = prevDoc; globalThis.window = prevWin;
  }
}

// ── Import dock announcements (js/pages/admin/upload-dock.js) ───────────────
{
  const { pathToFileURL } = await import('node:url');
  const prevDoc = globalThis.document, prevWin = globalThis.window;
  globalThis.document = { baseURI: 'http://h/admpan.html', getElementById: () => null, addEventListener() {}, title: '' };
  globalThis.window = { location: { origin: 'http://h' }, addEventListener() {} };
  try {
    const dock = await import(pathToFileURL(path.join(ROOT, 'js/pages/admin/upload-dock.js')).href);
    const ds = (state, error = null) => [{ key: '3d/e85', name: 'E85', state, error }];
    const st = (phase, datasets = ds('uploading')) => ({ phase, datasets, failed: [], network: 'online', error: null });

    assert.deepEqual(dock.announcements(st('uploading'), 4, true, false), [], 'the first render only records');
    assert.deepEqual(dock.announcements(st('uploading'), 7, true, false), [], 'bytes moving inside a step: silent');
    assert.deepEqual(dock.announcements(st('uploading'), 12.4, true, false), ['Import: 10 % sent']);
    assert.deepEqual(dock.announcements(st('uploading'), 19, true, false), []);
    assert.deepEqual(dock.announcements(st('uploading'), 41, true, false), ['Import: 40 % sent'], 'one sentence per emit, the step reached');
    const paused = dock.announcements(st('paused'), 41, false, true);
    assert.equal(paused.length, 1, 'pausing is announced once');
    assert.deepEqual(dock.announcements(st('paused'), 41, false, true), [], 'and not again while it stays paused');
    const editable = dock.announcements(st('uploading', ds('editable')), 48, true, false);
    assert.equal(editable.length, 2, 'resuming + the dataset turning editable');
    assert.deepEqual(dock.announcements(st('uploading', ds('editable')), 52, true, false), ['Import: 50 % sent']);
    assert.ok(editable.some(m => m.startsWith('E85 — ')));
    const failed = dock.announcements(st('uploading', ds('editable', 'disk full')), 53, true, false);
    assert.deepEqual(failed, ['E85: disk full'], 'a dataset error is announced with its name');
  } finally {
    globalThis.document = prevDoc; globalThis.window = prevWin;
  }
}

console.log('a11y menus / toast / focus trap / anchors / admin toast + dock announcements: OK');
