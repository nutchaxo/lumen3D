// Public navbar on phones: every page with the shared navbar carries one menu button
// that opens the folded links (css/layout.css, js/core/ui-actions.js `nav-menu`), and
// the Explorer's stage filter labels its "all" option with a stage key, not the type one.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT, loadModule } from './harness.mjs';

let failed = 0;
async function ok(name, fn) {
  try { await fn(); console.log('ok   ' + name); }
  catch (e) { failed++; console.log('FAIL ' + name + '\n     ' + (e && e.stack || e)); }
}
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');

const PAGES = ['index.html', 'explorer.html', 'about.html', 'page.html', 'legal.html', '404.html'];

await ok('every navbar page has one menu button wired to its links', () => {
  for (const page of PAGES) {
    const html = read(page);
    const nav = /<nav class="navbar"[\s\S]*?<\/nav>/.exec(html);
    assert.ok(nav, page + ': navbar');
    const buttons = nav[0].match(/<button[^>]*class="navbar-menu-btn"[^>]*>/g) || [];
    assert.equal(buttons.length, 1, page + ': one menu button');
    const b = buttons[0];
    assert.match(b, /type="button"/, page);
    assert.match(b, /data-action="nav-menu"/, page);
    assert.match(b, /aria-controls="navbar-links"/, page);
    assert.match(b, /aria-expanded="false"/, page);
    assert.match(b, /data-i18n-aria="nav\.menu"/, page);
    assert.match(b, /aria-label="[^"]+"/, page + ': a label before translation');
    assert.doesNotMatch(b, /\bon[a-z]+=/i, page + ': no inline handler (CSP)');
    assert.equal((html.match(/id="navbar-links"/g) || []).length, 1, page + ': one links container id');
    assert.match(nav[0], /<div class="navbar-links" id="navbar-links">/, page);
    assert.ok(nav[0].indexOf('navbar-menu-btn') < nav[0].indexOf('id="navbar-links"'),
      page + ': the button precedes the links it opens (keyboard order)');
    assert.match(html, /<script src="js\/core\/ui-actions\.js"><\/script>/, page + ': loads ui-actions.js');
  }
});

await ok('phone rules live in layout.css, not in the landing sheet alone', () => {
  const landing = read('css/landing.css');
  assert.doesNotMatch(landing, /\.navbar-links\s*\{[^}]*display:\s*none/, 'landing no longer hides the links with no way back');
  const layout = read('css/layout.css');
  const phone = layout.lastIndexOf('@media (max-width: 900px)');
  assert.ok(phone > layout.indexOf('.navbar {'), 'a phone block after the navbar rules');
  const block = layout.slice(phone);
  assert.match(block, /\.navbar-links\s*\{[^}]*display:\s*none/);
  assert.match(block, /\.navbar\.nav-open \.navbar-links\s*\{[^}]*display:\s*flex/);
  assert.match(block, /\.navbar-menu-btn\s*\{[^}]*display:\s*inline-flex/);
  assert.match(block, /overflow-y:\s*auto/, 'a long custom-page list scrolls inside the panel');
  assert.match(layout, /\.navbar-menu-btn\s*\{[^}]*display:\s*none/, 'hidden on desktop');
});

// ── Behaviour of the nav-menu action against a minimal DOM ─────────────────────
class El {
  constructor(tag, { cls = [], attrs = {} } = {}) {
    this.tag = tag; this.parent = null; this.children = []; this.attrs = { ...attrs };
    this._cls = new Set(cls); this.focused = 0;
    const self = this;
    this.classList = {
      contains: (c) => self._cls.has(c),
      toggle: (c, on) => { if (on === undefined) on = !self._cls.has(c); if (on) self._cls.add(c); else self._cls.delete(c); return on; },
      add: (c) => self._cls.add(c), remove: (c) => self._cls.delete(c),
    };
  }
  append(...kids) { for (const k of kids) { k.parent = this; this.children.push(k); } return this; }
  getAttribute(n) { return Object.prototype.hasOwnProperty.call(this.attrs, n) ? this.attrs[n] : null; }
  setAttribute(n, v) { this.attrs[n] = String(v); }
  focus() { this.focused++; }
  contains(o) { for (let n = o; n; n = n.parent) if (n === this) return true; return false; }
  _matchCompound(sel) {
    const m = /^([a-z]+)?((?:\.[\w-]+)*)((?:\[[\w-]+(?:="[^"]*")?\])*)$/.exec(sel);
    if (!m) throw new Error('selector not supported by the test DOM: ' + sel);
    if (m[1] && m[1] !== this.tag) return false;
    for (const c of (m[2].match(/\.[\w-]+/g) || [])) if (!this._cls.has(c.slice(1))) return false;
    for (const a of (m[3].match(/\[[^\]]+\]/g) || [])) {
      const [, name, val] = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(a);
      const have = this.getAttribute(name);
      if (have === null || (val !== undefined && have !== val)) return false;
    }
    return true;
  }
  matches(sel) {
    const parts = sel.trim().split(/\s+/);
    if (!this._matchCompound(parts[parts.length - 1])) return false;
    let i = parts.length - 2;
    for (let n = this.parent; n && i >= 0; n = n.parent) if (n._matchCompound(parts[i])) i--;
    return i < 0;
  }
  closest(sel) { for (let n = this; n; n = n.parent) if (n.matches(sel)) return n; return null; }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  querySelectorAll(sel) {
    const out = [];
    const walk = (n) => { for (const k of n.children) { if (k.matches(sel)) out.push(k); walk(k); } };
    walk(this);
    return out;
  }
}

function setup({ page = 'home' } = {}) {
  const root = new El('html');
  const body = new El('body', { attrs: { 'data-page': page } });
  const nav = new El('nav', { cls: ['navbar'] });
  const btn = new El('button', { cls: ['navbar-menu-btn'], attrs: { 'data-action': 'nav-menu', 'aria-expanded': 'false' } });
  const icon = new El('span', { cls: ['navbar-menu-icon'] });
  const links = new El('div', { cls: ['navbar-links'] });
  const link = new El('a', { cls: ['navbar-link'] });
  const theme = new El('button', { attrs: { 'data-action': 'theme-toggle' } });
  const outside = new El('p');
  btn.append(icon); links.append(link); nav.append(btn, links, theme); body.append(nav, outside); root.append(body);
  const handlers = {}; const beacons = []; const mqListeners = [];
  const document = {
    readyState: 'complete', body,
    addEventListener: (t, h) => { handlers[t] = h; },
    querySelectorAll: (s) => root.querySelectorAll(s),
    getElementById: () => null,
  };
  const window = {
    addEventListener() {},
    matchMedia: () => ({ matches: true, addEventListener: (t, h) => mqListeners.push(h) }),
  };
  window.top = window; window.self = window;
  let themeToggles = 0;
  const store = new Map();
  loadModule('js/core/ui-actions.js', 'UIActions', {
    document, window,
    Theme: { toggle: () => { themeToggles++; } },
    sessionStorage: { getItem: (k) => store.get(k) || null, setItem: (k, v) => store.set(k, v) },
    navigator: { sendBeacon: (u) => { beacons.push(u); return true; } },
  });
  const click = (target) => handlers.click({ target });
  const key = (k) => handlers.keydown({ key: k });
  return { nav, btn, icon, link, theme, outside, click, key, beacons, mqListeners, themeToggles: () => themeToggles };
}

await ok('the button opens and closes the panel and keeps aria-expanded in step', () => {
  const t = setup();
  t.click(t.icon);
  assert.ok(t.nav.classList.contains('nav-open'), 'a click on the icon inside the button opens');
  assert.equal(t.btn.getAttribute('aria-expanded'), 'true');
  t.click(t.btn);
  assert.ok(!t.nav.classList.contains('nav-open'), 'a second click closes');
  assert.equal(t.btn.getAttribute('aria-expanded'), 'false');
});

await ok('an outside click, a link click and Escape close it', () => {
  const t = setup();
  t.click(t.btn); t.click(t.outside);
  assert.ok(!t.nav.classList.contains('nav-open'), 'outside click');
  assert.equal(t.btn.getAttribute('aria-expanded'), 'false');

  t.click(t.btn); t.click(t.link);
  assert.ok(!t.nav.classList.contains('nav-open'), 'link click');

  t.click(t.btn); t.click(t.theme);
  assert.ok(t.nav.classList.contains('nav-open'), 'a control of the bar leaves it open');
  assert.equal(t.themeToggles(), 1, 'and still runs its own action');

  const before = t.btn.focused;
  t.key('Enter');
  assert.ok(t.nav.classList.contains('nav-open'), 'another key does nothing');
  t.key('Escape');
  assert.ok(!t.nav.classList.contains('nav-open'), 'Escape');
  assert.equal(t.btn.focused, before + 1, 'focus goes back to the button');
  t.key('Escape');
  assert.equal(t.btn.focused, before + 1, 'Escape on a closed menu does not steal focus');
});

await ok('leaving the phone breakpoint drops the open state', () => {
  const t = setup();
  t.click(t.btn);
  assert.equal(t.mqListeners.length, 1);
  t.mqListeners[0]({ matches: false });
  assert.ok(!t.nav.classList.contains('nav-open'));
  assert.equal(t.btn.getAttribute('aria-expanded'), 'false');
});

await ok('a public page counts a visit; the 404 page does not', () => {
  assert.equal(setup({ page: 'home' }).beacons.length, 1);
  assert.equal(setup({ page: 'notfound' }).beacons.length, 0);
});

// ── Explorer stage filter ──────────────────────────────────────────────────────
await ok('the stage filter "all" option uses the stage key', () => {
  const html = read('explorer.html');
  const group = /<div class="filter-group" id="filter-stage-group">[\s\S]*?<\/label>/.exec(html);
  assert.ok(group, 'stage group');
  assert.match(group[0], /value="all"[\s\S]*?data-i18n="explorer\.allStages"/);
  assert.doesNotMatch(group[0], /explorer\.allTypes/);
});

await ok('translation keys are present in every locale (or in none yet)', () => {
  const langs = ['en', 'fr', 'es', 'nl'].map((l) => [l, JSON.parse(read(`lang/${l}.json`))]);
  for (const [section, key] of [['nav', 'menu'], ['explorer', 'allStages']]) {
    const have = langs.filter(([, d]) => d[section] && typeof d[section][key] === 'string' && d[section][key]);
    if (have.length === 0) { console.log(`SKIP ${section}.${key}: not in the locale files yet`); continue; }
    assert.equal(have.length, 4, `${section}.${key} in all four locales`);
  }
});

if (failed) { console.log(`${failed} failed`); process.exit(1); }
