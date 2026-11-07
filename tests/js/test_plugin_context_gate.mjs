// Unit tests for the hosting-context gate in js/core/plugin-registry.js
// (loadModules) and the toolbar-state wire a hosted page needs.
//
// A page hosts its plugins in one of two contexts (plugin.json `contexts`):
//   - 'page'  → the standalone viewer / 2D page, with its own toolbar;
//   - 'panel' → that page embedded chrome-less (a Compare panel, a split-view
//                pane, the admin preview), driven from outside by postMessage.
// A plugin declaring nothing predates the field: a page takes it, a panel never
// does — an embedded page must not run a nested split view, a fullscreen
// request or a modal it cannot show. A host passing no context is unfiltered.
//
// Run: node tests/js/test_plugin_context_gate.mjs
import assert from 'node:assert/strict';
import { loadModule } from './harness.mjs';

const PLUGINS = {
  'tools/both':      { id: 'both',      name: 'Both',      placement: 'tools', contexts: ['page', 'panel'] },
  'tools/page-only': { id: 'page-only', name: 'Page only', placement: 'tools', contexts: ['page'] },
  'tools/panel-only':{ id: 'panel-only',name: 'Panel only',placement: 'tools', contexts: ['panel'] },
  'tools/undeclared':{ id: 'undeclared',name: 'Undeclared',placement: 'tools' },
  'tools/compare-host':{ id: 'compare-host', name: 'Compare host', placement: 'tools', contexts: ['page', 'panel', 'compare'] },
  'tools/bogus':     { id: 'bogus',     name: 'Bogus',     placement: 'tools', contexts: ['kiosk'] },
};
const ALL = Object.keys(PLUGINS);

function freshRegistry(extra = {}) {
  const document = {
    createElement: () => ({ dataset: {}, setAttribute() {}, onload: null, onerror: null }),
    querySelector: () => null,
    querySelectorAll: () => [],
    body: { appendChild: el => queueMicrotask(() => el.onload && el.onload()) },
    ...extra,
  };
  const warnings = [];
  return {
    warnings,
    PR: loadModule('js/core/plugin-registry.js', 'PluginRegistry', {
      document,
      window: {},
      console: { ...console, warn: (...a) => warnings.push(a.join(' ')), info() {} },
      I18n: { t: k => k, translateDOM() {} },
      queueMicrotask,
      PluginTrust: { evaluate: async () => ({ tier: 'dev', hash: 'stub', bytes: '' }) },
      URL: { createObjectURL: () => 'blob:stub', revokeObjectURL() {} },
      Blob: class { constructor() {} },
      fetch: async (url) => {
        const m = String(url).match(/js\/modules\/(.+)\/plugin\.json$/);
        if (m && PLUGINS[m[1]]) return { ok: true, status: 200, json: async () => PLUGINS[m[1]] };
        return { ok: false, status: 404 };
      },
    }),
  };
}

async function loadedIds(opts) {
  const { PR } = freshRegistry();
  await PR.loadModules('js/modules', ALL, opts);
  return Array.from(PR.listByPlacement('tools'), p => p.id).sort();
}

// The vocabulary is closed and exported for the pages.
{
  const { PR } = freshRegistry();
  assert.deepEqual(Array.from(PR.CONTEXTS), ['page', 'panel', 'compare'], 'three hosting contexts');
}

// No context: unfiltered, exactly as before the field existed.
assert.deepEqual(await loadedIds(undefined),
  ['bogus', 'both', 'compare-host', 'page-only', 'panel-only', 'undeclared'], 'no context → unfiltered');

// A page keeps what declares 'page' and what declares nothing.
assert.deepEqual(await loadedIds({ context: 'page' }),
  ['both', 'compare-host', 'page-only', 'undeclared'], 'page context');

// A panel keeps ONLY what declared it copes with being driven from outside.
assert.deepEqual(await loadedIds({ context: 'panel' }),
  ['both', 'compare-host', 'panel-only'], 'panel context is default-deny');

// The Compare page itself hosts a plugin only when it declared 'compare'.
assert.deepEqual(await loadedIds({ context: 'compare' }),
  ['compare-host'], 'compare context is default-deny');

// Left out is not quarantined; an unknown context name is warned about.
{
  const { PR, warnings } = freshRegistry();
  await PR.loadModules('js/modules', ALL, { context: 'panel' });
  assert.equal(PR.getQuarantined().length, 0, 'left-out plugins are not quarantined');
  assert.ok(warnings.some(w => w.includes('"tools/bogus"') && w.includes('kiosk')), 'unknown context warned');
}

// Composes with the data-type gate: both must accept.
{
  const { PR } = freshRegistry();
  PLUGINS['tools/both'].dataTypes = ['2d'];
  await PR.loadModules('js/modules', ALL, { context: 'panel', dataType: '3d', allowUndeclaredDataTypes: true });
  assert.deepEqual(Array.from(PR.listByPlacement('tools'), p => p.id).sort(), ['compare-host', 'panel-only'],
    'a panel-capable plugin of another data type stays out; an undeclared one the host opts in stays');
  delete PLUGINS['tools/both'].dataTypes;
}

// The toolbar-state wire: syncToolbarButton informs listeners even when the
// button is not in this document (a host draws it elsewhere), and the
// unsubscribe works.
{
  const { PR } = freshRegistry();
  const seen = [];
  const off = PR.onToolbarState(s => seen.push(s));
  PR.syncToolbarButton('both', { active: true });
  PR.syncToolbarButton('both', { icon: 'eye' });
  PR.syncToolbarButton('both', {});
  // JSON: the payloads are built in the registry's vm realm (prototype-strict
  // deepEqual would reject them for that alone).
  assert.equal(JSON.stringify(seen), JSON.stringify([
    { id: 'both', active: true, icon: null },
    { id: 'both', icon: 'eye' },
  ]), 'listeners hear active/icon changes only');
  off();
  PR.syncToolbarButton('both', { active: false });
  assert.equal(seen.length, 2, 'unsubscribed');
}

// describeToolbar: tools and toggles in order, hidden (requires) buttons left
// out, active state read from the button, actions never listed.
{
  const buttons = {
    '[data-plugin-generated][data-tool="measure"]': { title: 'Measure', style: {}, classList: { contains: () => false }, querySelector: () => null },
    '[data-plugin-id="grid"]': { title: 'Grid', style: {}, classList: { contains: c => c === 'btn-solid' }, querySelector: () => ({ getAttribute: () => 'grid-3x3' }) },
    '[data-plugin-id="hiddenone"]': { title: 'Hidden', style: { display: 'none' }, classList: { contains: () => false }, querySelector: () => null },
  };
  const { PR } = freshRegistry({ querySelector: (sel) => buttons[sel] || null });
  const metas = {
    'tools/measure':   { id: 'measure',   placement: 'tools', subtype: 'tool',   tool: 'measure', shortcut: 'm', icon: 'ruler', order: 20 },
    'tools/grid':      { id: 'grid',      placement: 'tools', subtype: 'toggle', icon: 'grid', order: 10 },
    'tools/hiddenone': { id: 'hiddenone', placement: 'tools', subtype: 'toggle', icon: 'x', order: 5, requires: ['bricks'] },
    'tools/shot':      { id: 'shot',      placement: 'tools', subtype: 'action', icon: 'camera', order: 1 },
  };
  Object.assign(PLUGINS, metas);
  await PR.loadModules('js/modules', Object.keys(metas), {});
  for (const id of ['measure', 'grid', 'hiddenone', 'shot']) PR.implement(id, { init() {} });
  const d = PR.describeToolbar();
  assert.deepEqual(Array.from(d.tools, t => [t.tool, t.shortcut, t.title, t.order]), [['measure', 'm', 'Measure', 20]], 'tools listed with shortcut');
  assert.deepEqual(Array.from(d.toggles, t => [t.id, t.active, t.icon, t.title]), [['grid', true, 'grid-3x3', 'Grid']],
    'toggles carry the live state; hidden and action buttons are left out');
}

// Boot traffic. A registry whose fetches are logged and whose trust pass hands
// back the plugin's lang/ bytes, as PluginTrust.evaluate does.
function trafficRegistry({ list = null, langFiles = {}, i18nInline = null, langs = undefined, release = null } = {}) {
  const requests = [];
  const i18nCalls = [];
  const evaluated = [];
  const meta = { id: 'speaker', name: 'Speaker', placement: 'tools', contexts: ['page'] };
  if (langs) meta.i18nLanguages = langs;
  if (i18nInline) meta.i18n = i18nInline;
  const enc = new TextEncoder();
  const files = { 'index.js': enc.encode(''), 'plugin.json': enc.encode(JSON.stringify(meta)) };
  for (const [code, text] of Object.entries(langFiles)) files[`lang/${code}.json`] = enc.encode(text);
  const PR = loadModule('js/core/plugin-registry.js', 'PluginRegistry', {
    document: {
      createElement: () => ({ dataset: {}, setAttribute() {}, onload: null, onerror: null }),
      querySelector: () => null,
      querySelectorAll: () => [],
      body: { appendChild: el => queueMicrotask(() => el.onload && el.onload()) },
    },
    window: {},
    console: { ...console, warn() {}, info() {}, debug() {} },
    I18n: {
      t: k => k, translateDOM() {},
      registerPluginLang: (id, path, dicts, l) => i18nCalls.push(['register', id, JSON.parse(JSON.stringify(dicts)), l]),
      loadPluginLang: async (id, path, l) => { i18nCalls.push(['load', id, l]); },
    },
    queueMicrotask,
    TextDecoder,
    PluginTrust: {
      evaluate: async (m, vouch, base, modPath, manifest) => {
        evaluated.push({ vouch, manifest });
        return { tier: vouch ? vouch.tier : 'bundled', hash: 'h', bytes: files['index.js'], files };
      },
    },
    URL: { createObjectURL: () => 'blob:stub', revokeObjectURL() {} },
    Blob: class { constructor() {} },
    fetch: async (url, init) => {
      requests.push([String(url), init && init.cache]);
      if (url === 'api/plugins.php' && list) return { ok: true, status: 200, json: async () => ({ plugins: list }) };
      if (url === 'version.json' && release) return { ok: true, status: 200, json: async () => release };
      if (/js\/modules\/tools\/speaker\/plugin\.json$/.test(String(url))) return { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(meta)) };
      return { ok: false, status: 404 };
    },
  });
  return { PR, requests, i18nCalls, evaluated, meta };
}

// A server-vouched batch never reads the release manifest: version.json holds one
// hash per shipped file and is only the trust source of a vouch-less static host.
{
  const t = trafficRegistry({ list: [{ path: 'tools/speaker', id: 'speaker', name: 'Speaker', placement: 'tools', trust: { tier: 'dev', hash: 'h' } }] });
  const paths = await t.PR.discover('js/modules');
  await t.PR.loadModules('js/modules', paths, { context: 'page' });
  assert.equal(t.requests.filter(([u]) => u === 'version.json').length, 0, 'vouched plugins: no version.json request');
  assert.equal(t.evaluated.length, 1);
  assert.equal(t.evaluated[0].manifest, null, 'a vouched plugin is evaluated without the manifest');
}

// A vouch-less (static host) batch reads it ONCE, revalidated, for all its plugins.
{
  const t = trafficRegistry({ release: { web: '9.9.9', files: { 'js/modules/tools/speaker/index.js': 'x' } } });
  await t.PR.loadModules('js/modules', ['tools/speaker', 'tools/speaker'], {});
  const reads = t.requests.filter(([u]) => u === 'version.json');
  assert.equal(reads.length, 1, 'one version.json read per batch');
  assert.equal(reads[0][1], 'no-cache', 'revalidated, not re-downloaded');
  assert.ok(t.evaluated.every(e => e.manifest && e.manifest['js/modules/tools/speaker/index.js'] === 'x'),
    'every vouch-less plugin gets the files map');
}

// Translations come from the bytes the trust pass already verified: no second
// fetch of lang/<code>.json (PHP hosts inline nothing).
{
  const t = trafficRegistry({
    langFiles: { en: '{"title":"Speak"}', fr: '﻿{"title":"Parler"}', es: '{broken', nl: '{"title":"Spreek"}' },
    langs: ['en', 'fr', 'es'],
  });
  await t.PR.loadModules('js/modules', ['tools/speaker'], {});
  assert.equal(t.i18nCalls.length, 1);
  const [kind, id, dicts, l] = t.i18nCalls[0];
  assert.equal(kind, 'register', 'registered from the verified bytes, not fetched again');
  assert.equal(id, 'speaker');
  assert.deepEqual(dicts, { en: { title: 'Speak' }, fr: { title: 'Parler' } },
    'BOM stripped; unparsable and undeclared locales left out');
  assert.deepEqual(Array.from(l), ['en', 'fr', 'es'], 'the declared locales travel with it');
  assert.equal(t.requests.filter(([u]) => /\/lang\//.test(u)).length, 0, 'no lang/ request');
}

// No English among the verified bytes → the per-locale fetch stays the fallback.
{
  const t = trafficRegistry({ langFiles: { fr: '{"title":"Parler"}' } });
  await t.PR.loadModules('js/modules', ['tools/speaker'], {});
  assert.deepEqual(t.i18nCalls.map(c => c[0]), ['load'], 'no English dictionary → loadPluginLang');
}

// Dictionaries inlined by the discovery endpoint still win.
{
  const t = trafficRegistry({ i18nInline: { en: { title: 'Inline' } }, langFiles: { en: '{"title":"File"}' } });
  await t.PR.loadModules('js/modules', ['tools/speaker'], {});
  assert.equal(t.i18nCalls[0][0], 'register');
  assert.deepEqual(t.i18nCalls[0][2], { en: { title: 'Inline' } }, 'inline dictionaries first');
}

console.log('OK  hosting-context gate + toolbar wire + boot traffic: 14 checks');
