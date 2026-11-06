// Admin Statistics tab: the per-dataset table sorts from the keyboard. Each
// sortable header holds a real <button>, the current order is announced through
// aria-sort (the arrow glyph is hidden from assistive technology), and the
// rebuild that follows a sort puts the focus back on the header button that was
// pressed instead of dropping it to <body>.
//
// Run: node tests/js/test_admin_stats_sort_a11y.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT, escapeHtml } from './harness.mjs';

const body = { tagName: 'BODY' };

function fakeNode(tag, attrs, doc) {
  const listeners = {};
  const classes = String(attrs.class || '').split(/\s+/).filter(Boolean);
  const dataset = {};
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith('data-')) dataset[k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = v;
  }
  const node = {
    tagName: tag.toUpperCase(), attrs, listeners, dataset,
    id: attrs.id || '',
    classList: { contains: (c) => classes.includes(c) },
    getAttribute: (n) => (n in attrs ? attrs[n] : null),
    addEventListener: (ev, fn) => { (listeners[ev] ||= []).push(fn); },
    fire(ev) { (listeners[ev] || []).forEach((fn) => fn({ target: node })); },
    focus() { doc.activeElement = node; },
  };
  return node;
}

function parseTags(html, doc) {
  const nodes = [];
  const rx = /<(th|button)\b([^>]*)>/g;
  let m;
  while ((m = rx.exec(html))) {
    const attrs = {};
    const arx = /([a-zA-Z-]+)(?:="([^"]*)")?/g;
    let a;
    while ((a = arx.exec(m[2]))) attrs[a[1]] = a[2] ?? '';
    nodes.push(fakeNode(m[1], attrs, doc));
  }
  return nodes;
}

// The two selector shapes the module uses: `.cls`, `.cls[data-sort="k"]`, `#id`.
function matches(node, sel) {
  let m = /^#([\w-]+)$/.exec(sel);
  if (m) return node.id === m[1];
  m = /^\.([\w-]+)(?:\[data-sort="([^"]*)"\])?$/.exec(sel);
  if (!m) throw new Error('unsupported selector ' + sel);
  return node.classList.contains(m[1]) && (m[2] == null || node.dataset.sort === m[2]);
}

function setup(stats) {
  const src = readFileSync(path.join(ROOT, 'js/pages/admin/tab-stats.js'), 'utf8')
    .replace(/^import\s[^;]*;/gm, '')
    .replace(/^export\s+(function|const|let|class)/gm, '$1');

  const doc = { body, activeElement: body };
  let nodes = [];
  const root = {
    _html: '',
    set innerHTML(v) {
      this._html = v;
      if (nodes.includes(doc.activeElement)) doc.activeElement = body;
      nodes = parseTags(v, doc);
    },
    get innerHTML() { return this._html; },
    contains: (n) => nodes.includes(n),
    querySelector: (sel) => nodes.find((n) => matches(n, sel)) || null,
    querySelectorAll: (sel) => nodes.filter((n) => matches(n, sel)),
  };
  const sandbox = {
    console, document: doc,
    API_ADMIN: 'api/admin.php',
    t: (_k, d) => d,
    escHtml: escapeHtml,
    apiFetch: async () => stats,
    el: (id) => (id === 'stats-root' ? root : nodes.find((n) => n.id === id) || null),
    refreshIcons: () => {},
    toast: () => {},
  };
  vm.createContext(sandbox);
  vm.runInContext(src + '\n;globalThis.__T = { StatsTab };', sandbox, { filename: 'tab-stats.js' });
  return { tab: sandbox.__T.StatsTab, root, doc, nodes: () => nodes };
}

const STATS = {
  global: { visits: 3, views: 5, downloads: 2, since: '2026-01-01' },
  daily: {},
  datasets: [
    { id: '3d/a', name: 'Alpha', views: 1, downloads: 4 },
    { id: '3d/b', name: 'Beta', views: 3, downloads: 0 },
  ],
};

const env = setup(STATS);
// As the shell does on a first visit: mount() draws, activate() fetches.
env.tab.mount();
env.tab.activate();
await new Promise((r) => setImmediate(r));

const headerButtons = () => env.nodes().filter((n) => n.tagName === 'BUTTON' && n.classList.contains('adm-th-sort-btn'));
const headerCells = () => env.nodes().filter((n) => n.tagName === 'TH' && n.classList.contains('adm-th-sort'));
const sortOf = (k) => {
  const idx = headerButtons().findIndex((b) => b.dataset.sort === k);
  return headerCells()[idx].getAttribute('aria-sort');
};

// 1. Every sortable header is a native button (focusable, Enter/Space for free).
assert.deepEqual(headerButtons().map((b) => b.dataset.sort), ['name', 'views', 'downloads']);
for (const b of headerButtons()) assert.equal(b.getAttribute('type'), 'button');
assert.equal(headerCells().length, 3);
// The default order (views + downloads) is no visible column: nothing claims it.
for (const k of ['name', 'views', 'downloads']) assert.equal(sortOf(k), 'none');
assert.ok(!/<th[^>]*data-sort=/.test(env.root.innerHTML), 'the click target is the button, not the cell');

// 2. Activating a header sorts, announces the order, and keeps the focus on it.
let btn = headerButtons().find((b) => b.dataset.sort === 'views');
btn.focus();
btn.fire('click');
assert.equal(sortOf('views'), 'descending');
assert.equal(sortOf('name'), 'none');
assert.equal(env.doc.activeElement.dataset?.sort, 'views', 'focus restored on the pressed header');
assert.notEqual(env.doc.activeElement, btn, 'a fresh node after the rebuild');
assert.ok(/<span aria-hidden="true"> ▾<\/span>/.test(env.root.innerHTML), 'the arrow glyph is decorative');
assert.ok(env.root.innerHTML.indexOf('Beta') < env.root.innerHTML.indexOf('Alpha'), 'most viewed first');

// 3. Pressing it again flips the order.
env.doc.activeElement.fire('click');
assert.equal(sortOf('views'), 'ascending');
assert.equal(env.doc.activeElement.dataset?.sort, 'views');
assert.ok(env.root.innerHTML.indexOf('Alpha') < env.root.innerHTML.indexOf('Beta'));

// 4. Another column takes the order; the name sorts A → Z first.
btn = headerButtons().find((b) => b.dataset.sort === 'name');
btn.focus();
btn.fire('click');
assert.equal(sortOf('name'), 'ascending');
assert.equal(sortOf('views'), 'none');
assert.equal(env.doc.activeElement.dataset?.sort, 'name');

// 5. A rebuild with the focus outside the tab steals nothing.
env.doc.activeElement = body;
env.tab.relabel();
assert.equal(env.doc.activeElement, body);

// 6. The refresh button keeps its focus across the rebuild a reload causes.
const refresh = env.nodes().find((n) => n.id === 'stats-refresh');
refresh.focus();
env.tab.relabel();
assert.equal(env.doc.activeElement.id, 'stats-refresh');

console.log('test_admin_stats_sort_a11y: OK');
