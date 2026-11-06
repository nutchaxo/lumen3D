// Admin Plugins and Statistics tabs: the first visit sends each request once.
// The shell runs mount() then activate() on a tab's first visit, so only
// activate() may fetch. A load asked for while one is in flight (an approval, a
// refresh click) is coalesced into exactly one follow-up request, never dropped
// and never run in parallel; the plugin catalog check is never doubled either.
//
// Run: node tests/js/test_admin_tab_single_load.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT } from './harness.mjs';

function fakeNode() {
  return {
    innerHTML: '',
    addEventListener() {},
    querySelector: () => null,
    querySelectorAll: () => [],
    contains: () => false,
    focus() {},
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

const tick = () => new Promise((r) => setImmediate(r));

function loadTab(file, exportName, extra) {
  const src = readFileSync(path.join(ROOT, file), 'utf8')
    .replace(/^import\s[^;]*;/gm, '')
    .replace(/^export\s+(function|const|let|class)/gm, '$1');
  const nodes = new Map();
  const calls = { api: [], catalog: 0 };
  const pending = [];
  const sandbox = {
    console,
    document: { activeElement: null, body: {} },
    location: { hash: '' },
    API_ADMIN: 'api/admin.php',
    t: (_k, d) => d,
    escHtml: (s) => String(s),
    toast() {},
    refreshIcons() {},
    el: (id) => { if (!nodes.has(id)) nodes.set(id, fakeNode()); return nodes.get(id); },
    apiFetch: (url) => {
      calls.api.push(url);
      const d = deferred();
      pending.push(d);
      return d.promise;
    },
    ...extra(calls),
  };
  vm.createContext(sandbox);
  vm.runInContext(`${src}\nthis.__tab = ${exportName};`, sandbox, { filename: file });
  return { tab: sandbox.__tab, calls, pending, root: () => nodes.get(file.includes('plugins') ? 'plugins-root' : 'stats-root') };
}

async function settle(pending, answer) {
  for (let i = 0; i < 20; i++) {
    while (pending.length) pending.shift().resolve(answer);
    await tick();
  }
}

// ── Plugins ────────────────────────────────────────────────────
{
  const { tab, calls, pending, root } = loadTab('js/pages/admin/tab-plugins.js', 'PluginsTab', (c) => ({
    apiFetchStatus: async () => ({ ok: true, data: { ok: true } }),
    askPassword: async () => null,
    throttleText: () => '',
    fetchPluginUpdates: async () => { c.catalog++; await tick(); return { byPath: {} }; },
    runPluginUpdates: async () => ({}),
  }));

  tab.mount();
  assert.equal(calls.api.length, 0, 'mount() must not fetch: the shell calls activate() right after');
  assert.match(root().innerHTML, /spinner/, 'mount() draws the loading state');
  tab.activate();
  await tick();
  assert.equal(calls.api.length, 1, 'first visit lists the plugins once');
  await settle(pending, { plugins: [] });
  assert.equal(calls.catalog, 1, 'first visit checks the catalog once');
  assert.match(root().innerHTML, /plugins-goto-catalog/, 'the loaded (empty) list is drawn');

  // A second activation while a load runs: one follow-up request, after the first.
  calls.api.length = 0; calls.catalog = 0;
  tab.activate();
  tab.activate();
  tab.activate();
  await tick();
  assert.equal(calls.api.length, 1, 'requests are not run in parallel');
  await settle(pending, { plugins: [] });
  assert.equal(calls.api.length, 2, 'loads asked for in flight coalesce into one follow-up');
  assert.equal(calls.catalog, 1, 'the catalog is checked once per load sequence');
}

// ── Statistics ─────────────────────────────────────────────────
{
  const { tab, calls, pending, root } = loadTab('js/pages/admin/tab-stats.js', 'StatsTab', () => ({}));
  const stats = { global: { visits: 3, views: 2, downloads: 1 }, daily: {}, datasets: [] };

  tab.mount();
  assert.equal(calls.api.length, 0, 'mount() must not fetch');
  assert.match(root().innerHTML, /spinner/, 'mount() draws the loading state');
  tab.activate();
  await tick();
  assert.equal(calls.api.length, 1, 'first visit reads the statistics once');
  await settle(pending, stats);
  assert.doesNotMatch(root().innerHTML, /spinner/, 'the figures are drawn');

  calls.api.length = 0;
  tab.activate();
  tab.activate();
  await tick();
  assert.equal(calls.api.length, 1, 'a refresh during a load does not run in parallel');
  await settle(pending, stats);
  assert.equal(calls.api.length, 2, 'it is read once more after the running request');
}

console.log('test_admin_tab_single_load: OK');
