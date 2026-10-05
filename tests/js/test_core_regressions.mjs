// Regression tests for the core singletons hardened in the audit follow-up:
//   i18n runtime switch with inline plugin dictionaries, prototype-safe merges, memoised tokens,
//   ToolManager modifiers / key-less events, UrlState decompression cap, ColorBlind model,
//   ui-actions, PerfTelemetry.measure, Catalog in-flight dedupe + retry, Utils helpers,
//   CSV formula neutralisation, PluginTrust fetch policy, live-revocation retry.
//
// Run: node tests/js/test_core_regressions.mjs
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { loadModule, ROOT } from './harness.mjs';

let checks = 0;
const ok = async (label, fn) => {
  try { await fn(); } catch (err) { err.message = `${label}: ${err.message}`; throw err; }
  checks++;
};

// ── i18n: registerPluginLang must not hide the platform dictionary ──────────────
function makeI18n({ platform, tokens = null }) {
  const store = {};
  const fetched = [];
  const I18n = loadModule('js/core/i18n.js', 'I18n', {
    localStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = v; } },
    navigator: { language: 'en-US' },
    window: { location: { pathname: '/index.html' } },
    document: { documentElement: { setAttribute() {} }, querySelectorAll: () => [] },
    InstanceConfig: tokens ? { tokens: () => tokens, revision: () => 1 } : undefined,
    fetch: async (url) => {
      fetched.push(url);
      const miss = { ok: false, status: 404, json: async () => ({}) };
      if (url === 'api/languages.php') return { ok: true, status: 200, json: async () => ({ languages: ['en', 'fr', 'es'] }) };
      const m = url.match(/^\.\/lang\/([a-z]{2,3})\.json$/);
      if (m && platform[m[1]]) return { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(platform[m[1]])) };
      return miss;
    },
  });
  return { I18n, fetched, store };
}
const PLATFORM = { en: { app: { title: 'Platform' } }, fr: { app: { title: 'Plateforme' } }, es: { app: { title: 'Plataforma' } } };

await ok('S7-1 platform dictionary loads after inline plugin dictionaries', async () => {
  const { I18n, fetched } = makeI18n({ platform: PLATFORM });
  await I18n.init();
  I18n.registerPluginLang('demo', 'js/modules/tools/demo', { en: { hello: 'Hello' }, fr: { hello: 'Bonjour' } }, ['en', 'fr']);
  await I18n.setLanguage('fr');
  assert.ok(fetched.includes('./lang/fr.json'), 'lang/fr.json was fetched');
  assert.equal(I18n.t('app.title'), 'Plateforme', 'platform key is French');
  assert.equal(I18n.tp('demo', 'hello'), 'Bonjour', 'plugin key is French too');
});

await ok('S7-1 plugin dictionary registered BEFORE the platform file survives the merge', async () => {
  const { I18n } = makeI18n({ platform: PLATFORM });
  I18n.registerPluginLang('early', 'js/modules/tools/early', { en: { a: 'A' }, es: { a: 'AA' } }, ['en', 'es']);
  await I18n.init();
  await I18n.setLanguage('es');
  assert.equal(I18n.t('app.title'), 'Plataforma');
  assert.equal(I18n.tp('early', 'a'), 'AA');
});

await ok('S7-17 a __proto__ dictionary code or plugin id never reaches Object.prototype', async () => {
  const { I18n } = makeI18n({ platform: PLATFORM });
  const evil = JSON.parse('{"__proto__": {"polluted": "yes"}}');
  I18n.registerPluginLang('p', 'js/modules/tools/p', { en: { x: 'x' }, ...evil, constructor: { y: 1 } }, ['en']);
  I18n.registerPluginLang('__proto__', 'js/modules/tools/p', { en: { x: 'x' } });
  assert.equal({}.polluted, undefined);
  assert.equal({}.plugins, undefined);
});

await ok('S7-16 tokens are substituted by one pass; call params win; unknown tokens stay literal', async () => {
  const { I18n } = makeI18n({ platform: { en: { s: '{brand}: {count} {unknown} {a.b}' } }, tokens: { brand: 'Lab', count: 'tok' } });
  await I18n.init();
  assert.equal(I18n.t('s', { count: 5 }), 'Lab: 5 {unknown} {a.b}');
  assert.equal(I18n.t('s', { brand: '$&' }), '$&: tok {unknown} {a.b}', 'replacement is literal, no $-patterns');
});

await ok('S7-18 i18n works with blocked localStorage', async () => {
  const blocked = { getItem() { throw new Error('SecurityError'); }, setItem() { throw new Error('SecurityError'); } };
  const I18n = loadModule('js/core/i18n.js', 'I18n', {
    localStorage: blocked, navigator: { language: 'fr-FR' }, window: { location: { pathname: '/' } },
    document: { documentElement: { setAttribute() {} }, querySelectorAll: () => [] },
    fetch: async (url) => (url === 'api/languages.php'
      ? { ok: true, json: async () => ['en', 'fr'] }
      : /lang\/(en|fr)\.json$/.test(url) ? { ok: true, json: async () => ({ k: 'v' }) } : { ok: false, json: async () => ({}) }),
  });
  await I18n.init();
  assert.equal(I18n.getLanguage(), 'fr');
});

// ── InstanceConfig: a __proto__ key in config/instance.json is dropped ──────────
await ok('S7-17 InstanceConfig merge ignores __proto__', async () => {
  const IC = loadModule('js/core/instance-config.js', 'InstanceConfig', {
    window: {}, document: { documentElement: {} },
    fetch: async () => ({ ok: true, json: async () => JSON.parse('{"__proto__":{"polluted":1},"brand":{"name":"X"}}') }),
  });
  await IC.load();
  assert.equal({}.polluted, undefined);
  assert.equal(IC.get('brand.name'), 'X');
  assert.ok(IC.revision() >= 1);
});

// ── ToolManager ─────────────────────────────────────────────────────────────────
await ok('S7-8 shortcuts ignore chords, repeats, editable targets, key-less events and open dialogs', async () => {
  let handler = null;
  let dialogOpen = false;
  const doc = {
    addEventListener: (t, h) => { if (t === 'keydown') handler = h; },
    querySelectorAll: () => [],
    querySelector: sel => (/data-tool="(cut|navigate|measure)"/.test(sel) ? { disabled: false, classList: { toggle() {} } } : null),
    body: { dataset: {} },
  };
  const changes = [];
  const TM = loadModule('js/core/tool-manager.js', 'ToolManager', { document: doc, Dialog: { isOpen: () => dialogOpen } });
  TM.init({ onChange: t => changes.push(t) });
  const key = (o) => handler({ target: { tagName: 'BODY' }, ...o });
  key({ key: 'c', ctrlKey: true }); key({ key: 'c', metaKey: true }); key({ key: 'c', altKey: true });
  key({ key: 'c', repeat: true });
  key({ key: undefined }); key({});
  handler({ key: 'c', target: { tagName: 'DIV', isContentEditable: true } });
  handler({ key: 'c', target: { tagName: 'INPUT' } });
  dialogOpen = true; key({ key: 'c' }); dialogOpen = false;
  key({ key: 'toString' }); key({ key: '__proto__' });
  assert.deepEqual(changes, [], 'none of those changed the tool');
  key({ key: 'C' });
  assert.deepEqual(changes, ['cut'], 'a plain key still selects its tool');
});

// ── UrlState ────────────────────────────────────────────────────────────────────
function loadUrlState(hash = '') {
  return loadModule('js/core/url-state.js', 'UrlState', {
    window: { location: { hash, pathname: '/v.html', search: '' }, history: { replaceState() {} } },
    Blob, Response, CompressionStream, DecompressionStream, TextDecoder, atob, btoa, performance,
    setInterval, clearInterval,
  });
}
const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
await ok('S7-3 a normal state round-trips', async () => {
  const US = loadUrlState();
  const enc = await US.encodeState({ a: [1, 2, 3], b: 'é' });
  assert.equal(JSON.stringify(await US.decodeState('#state=' + enc)), JSON.stringify({ a: [1, 2, 3], b: 'é' }));
});
await ok('S7-3 a decompression bomb is refused, not inflated', async () => {
  const US = loadUrlState();
  const json = Buffer.from('"' + 'a'.repeat(64 * 1024 * 1024) + '"');           // 64 MiB of text
  const bomb = zlib.deflateRawSync(json);
  assert.ok(bomb.length < 200 * 1024, 'the bomb is small on the wire (' + bomb.length + ' bytes)');
  const origWarn = console.warn; console.warn = () => {};
  const t0 = Date.now();
  try { assert.equal(await US.decodeState('#state=' + b64url(bomb)), null); } finally { console.warn = origWarn; }
  assert.ok(Date.now() - t0 < 5000, 'aborted early');
});
await ok('S7-3 an absurdly long hash is refused before decoding', async () => {
  const US = loadUrlState();
  const origWarn = console.warn; console.warn = () => {};
  try { assert.equal(await US.decodeState('#state=' + 'A'.repeat(3 * 1024 * 1024)), null); } finally { console.warn = origWarn; }
});

// ── ColorBlind ──────────────────────────────────────────────────────────────────
function loadColorBlind() {
  const created = [];
  const root = { style: {} };
  const doc = {
    readyState: 'complete', currentScript: null,
    documentElement: root,
    body: { style: {}, appendChild: el => created.push(el) },
    head: { appendChild() {} },
    createElement: () => ({ style: {}, classList: { add() {}, remove() {} }, appendChild() {}, append() {}, addEventListener() {}, dataset: {} }),
    getElementById: () => null,
    addEventListener() {},
  };
  const store = {};
  const CB = loadModule('js/core/colorblind.js', 'ColorBlind', {
    document: doc, window: { addEventListener() {} },
    localStorage: { getItem: k => store[k] ?? null, setItem: (k, v) => { store[k] = v; } },
  });
  return { CB, root, svg: created[0].innerHTML, doc };
}
await ok('S7-5/S7-6 documented matrices, rows sum to 1, luminance for achromatopsia, filter on <html>', async () => {
  const { CB, root, svg, doc } = loadColorBlind();
  const filters = {};
  for (const m of svg.matchAll(/<filter id="cb-([a-z]+)" color-interpolation-filters="linearRGB"><feColorMatrix type="matrix" values="([^"]+)"/g)) {
    filters[m[1]] = m[2].trim().split(/\s+/).map(Number);
  }
  assert.deepEqual(Object.keys(filters).sort(), ['achromatomaly', 'achromatopsia', 'deuteranomaly', 'deuteranopia', 'protanomaly', 'protanopia', 'tritanomaly', 'tritanopia']);
  for (const [id, v] of Object.entries(filters)) {
    assert.equal(v.length, 20, id + ' is a 4x5 matrix');
    for (let r = 0; r < 3; r++) {
      const sum = v[r * 5] + v[r * 5 + 1] + v[r * 5 + 2];
      assert.ok(Math.abs(sum - 1) < 2e-5, `${id} row ${r} preserves grey (sum ${sum})`);
      assert.equal(v[r * 5 + 3], 0); assert.equal(v[r * 5 + 4], 0);
    }
    assert.deepEqual(v.slice(15), [0, 0, 0, 1, 0], id + ' leaves alpha alone');
  }
  const lum = [0.2126, 0.7152, 0.0722];
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) {
    assert.ok(Math.abs(filters.achromatopsia[r * 5 + c] - lum[c]) < 1e-9, 'achromatopsia row = Rec.709 luminance');
  }
  assert.ok(Math.abs(filters.protanopia[0] - 0.152286) < 1e-9 && Math.abs(filters.deuteranopia[0] - 0.367322) < 1e-9, 'Machado severity-1 coefficients');
  CB.set('protanopia');
  assert.equal(root.style.filter, 'url(#cb-protanopia)', 'filter is on the root element, not <body>');
  assert.equal(doc.body.style.filter, undefined);
  CB.set('constructor');
  assert.equal(CB.get(), 'protanopia', 'unknown / inherited names are rejected');
  CB.set('none');
  assert.equal(root.style.filter, '');
});

// ── ui-actions ──────────────────────────────────────────────────────────────────
await ok('S7-7 lang-dropdown falls back to Utils; __proto__ action is ignored', async () => {
  let click = null; const toggled = [];
  const ctx = { document: { addEventListener: (t, h) => { if (t === 'click') click = h; } },
    window: { addEventListener() {} }, Utils: { toggleDropdown: id => toggled.push(id) } };
  loadModule('js/core/ui-actions.js', 'UIActions', ctx);
  const el = (a) => ({ target: { closest: () => ({ getAttribute: () => a }) } });
  click(el('lang-dropdown'));
  click(el('__proto__')); click(el('constructor')); click(el('toString'));
  assert.deepEqual(toggled, ['lang-dropdown']);
});

// ── PerfTelemetry ───────────────────────────────────────────────────────────────
await ok('S7-14 measure() always closes the span; the open set is bounded', async () => {
  const PT = loadModule('js/core/perf-telemetry.js', 'PerfTelemetry', { window: {} });
  assert.throws(() => PT.measure('a', {}, () => { throw new Error('boom'); }), /boom/);
  await assert.rejects(PT.measure('b', {}, async () => { throw new Error('async boom'); }), /async boom/);
  assert.equal(await PT.measure('c', {}, async () => 5), 5);
  assert.equal(PT.measure('d', {}, () => 6), 6);
  assert.equal(PT.getSummary().activeSpans, 0, 'no span left open');
  for (let i = 0; i < 2000; i++) PT.start('leak');
  assert.ok(PT.getSummary().activeSpans <= 500, 'orphans are capped');
  const live = { big: true };
  PT.event('x', { list: [live, 1] });
  assert.equal(typeof PT.getSummary().lastEvents.at(-1).meta.list[0], 'string', 'arrays do not pin live objects');
});

// ── Catalog ─────────────────────────────────────────────────────────────────────
await ok('S7-20 one request for concurrent loads; a failure is retried; search tolerates odd fields', async () => {
  let calls = 0; let fail = true;
  const Catalog = loadModule('js/core/catalog.js', 'Catalog', {
    fetch: async () => {
      calls++;
      if (fail) throw new Error('offline');
      return { ok: true, json: async () => [{ id: '3d/a', type: '3d', name: 'Alpha', regions: [{ name: 'Heart' }, 7], markers: [42] }] };
    },
  });
  const origWarn = console.warn; console.warn = () => {};
  try {
    await Promise.all([Catalog.load(), Catalog.load(), Catalog.load()]);
  } finally { console.warn = origWarn; }
  assert.equal(calls, 1, 'concurrent callers share one request');
  assert.ok(Catalog.getLoadError(), 'the failure is reported');
  fail = false;
  await Catalog.load();
  assert.equal(calls, 2, 'the next call retries');
  assert.equal(Catalog.getLoadError(), null);
  assert.equal(Catalog.filter({ search: 'heart' }).length, 1, 'object regions are searched by name');
  assert.equal(Catalog.filter({ search: '42' }).length, 1, 'numeric markers do not throw');
});

// ── Utils ───────────────────────────────────────────────────────────────────────
await ok('S7-28 stage / date / throttle', async () => {
  const Utils = loadModule('js/core/utils.js', 'Utils', { document: {}, window: {}, I18n: { getLanguage: () => 'en' }, InstanceConfig: undefined });
  const cases = { E75: 'E7.5', E775: 'E7.75', E7: 'E7', E10: 'E10', E105: 'E10.5', E18: 'E18', E85: 'E8.5', 'E8.5': 'E8.5' };
  for (const [i, o] of Object.entries(cases)) assert.equal(Utils.formatStage(i), o, i);
  assert.equal(Utils.formatDate('18112025'), '18/11/2025', 'DDMMYYYY');
  assert.equal(Utils.formatDate('20251118'), '18/11/2025', 'YYYYMMDD');
  const calls = [];
  const th = Utils.throttle(v => calls.push(v), 30);
  th(1); th(2); th(3);
  assert.deepEqual(calls, [1]);
  await new Promise(r => setTimeout(r, 90));
  assert.deepEqual(calls, [1, 3], 'the last call inside the window is delivered');
});

// ── CSV formula neutralisation ──────────────────────────────────────────────────
await ok('S7-25 CSV cells beginning with = + - @ are neutralised, numbers untouched', async () => {
  const MS = loadModule('js/core/measurement-store.js', 'MeasurementStore', { Utils: { uid: () => 'u' }, window: {} });
  const csv = MS.toCsv([{ id: '1', label: '=HYPERLINK("x")', distance: -3.5, points: [[-1, 2, 3]], unit: 'um' }]);
  assert.ok(csv.includes('"\'=HYPERLINK(""x"")"'), 'text formula neutralised: ' + csv);
  assert.ok(csv.includes('"-3.5"'), 'negative number kept as a number');
});

// ── PluginTrust: fetch policy keeps INV-2 ───────────────────────────────────────
await ok('S7-4 executable files are fetched no-store, .json files revalidated, all in parallel', async () => {
  const seen = []; let inFlight = 0; let maxInFlight = 0;
  const fetchStub = async (url, opts) => {
    seen.push([url, opts.cache]); inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise(r => setTimeout(r, 10)); inFlight--;
    return { ok: true, arrayBuffer: async () => new TextEncoder().encode('body:' + url).buffer };
  };
  const PT2 = loadModule('js/core/plugin-trust.js', 'PluginTrust', { crypto: globalThis.crypto, TextEncoder, fetch: fetchStub });
  const files = ['index.js', 'plugin.json', 'lang/en.json', 'lang/fr.json', 'worker.js'];
  const h = await PT2.hashPluginFiles('js/modules', 'tools/x', files);
  assert.ok(h && h.hash, 'composite hash computed');
  const mode = Object.fromEntries(seen.map(([u, c]) => [u.split('/tools/x/')[1], c]));
  assert.equal(mode['index.js'], 'no-store'); assert.equal(mode['worker.js'], 'no-store');
  assert.equal(mode['plugin.json'], 'no-cache'); assert.equal(mode['lang/en.json'], 'no-cache');
  assert.ok(maxInFlight > 1, 'files of one plugin are fetched concurrently');
  // The hash is the canonical composite of the real bytes.
  const fh = {};
  for (const f of files) fh[f] = await PT2.fileHash(new TextEncoder().encode('body:js/modules/tools/x/' + f));
  assert.equal(h.hash, await PT2.pluginHash(fh));
  assert.equal(h.bytes['index.js'].constructor.name, 'Uint8Array');
});

// ── PluginRegistry: a failed second request must not consume the revocation ─────
await ok('S7-2 live revocation is retried after a failed vouched-set request', async () => {
  let intervalFn = null;
  let health = { trustEpoch: 1 };
  let pluginsMode = 'ok';
  const killed = [];
  const meta = { id: 'sbx', name: 'Sbx', placement: 'tools', subtype: 'action', path: 'tools/sbx', trust: { tier: 'sandboxed', hash: 'h', files: [] } };
  const doc = { createElement: () => ({ style: {}, classList: { add() {}, remove() {}, toggle() {} }, dataset: {}, setAttribute() {}, appendChild() {} }),
    querySelector: () => null, querySelectorAll: () => [], getElementById: () => null, addEventListener() {}, body: { appendChild() {} } };
  const PR = loadModule('js/core/plugin-registry.js', 'PluginRegistry', {
    document: doc, window: {}, TextDecoder, I18n: { t: k => k, translateDOM() {} }, CSS: { escape: s => s },
    setInterval: fn => { intervalFn = fn; return 1; }, clearInterval() {},
    PluginTrust: { evaluate: async () => ({ tier: 'sandboxed', hash: 'h', caps: [], bytes: new Uint8Array() }) },
    PluginSandbox: { spawn: async () => ({ init() {}, activate() {}, deactivate() {} }), isSandboxed: () => true, kill: (id, why) => killed.push([id, why]) },
    fetch: async (url) => {
      if (url === 'api/plugins') {
        if (pluginsMode === 'fail') throw new Error('network');
        return { ok: true, json: async () => ({ trustEpoch: pluginsMode === 'ok-initial' ? 1 : 2, plugins: pluginsMode === 'ok-initial' ? [meta] : [] }) };
      }
      if (url === 'api/health') return { ok: true, json: async () => health };
      return { ok: false, status: 404, json: async () => ({}) };
    },
  });
  pluginsMode = 'ok-initial';
  const paths = await PR.discover('js/modules');
  await PR.loadModules('js/modules', paths);
  assert.ok(PR.getModule('sbx'), 'sandboxed plugin registered');
  PR.startTrustWatch(10);
  assert.ok(intervalFn, 'watcher started');
  health = { trustEpoch: 2 };
  pluginsMode = 'fail';
  await intervalFn();
  assert.deepEqual(killed, [], 'nothing torn down while the vouched set is unknown');
  pluginsMode = 'ok';
  await intervalFn();
  assert.deepEqual(killed, [['sbx', 'revoked']], 'the next poll retries and applies the revocation');
});

console.log(`core regressions: OK (${checks} checks)`);

// ── ChannelPanel: strict colours, no inline handlers ────────────────────────────
await ok('S7-9/S7-30 channel colours are validated; the markup carries no inline handlers', async () => {
  let html = '';
  const container = {
    set innerHTML(v) { html = v; }, get innerHTML() { return html; },
    querySelector: () => null, querySelectorAll: () => [], addEventListener() {},
  };
  const win = { addEventListener() {} };
  const doc = { getElementById: () => container, addEventListener() {}, querySelectorAll: () => [] };
  const factory = loadModule('js/components/channel-panel.js', 'createChannelPanel', {
    window: win, document: doc, Utils: { escapeHtml: s => String(s) }, ChannelPanel: undefined,
  });
  // the module assigns window.createChannelPanel
  const mk = win.createChannelPanel || factory;
  const panel = mk();
  panel.init('c', { dimensions: { c: 2 }, channels: [{ name: 'A', color: 'red;position:fixed;inset:0' }, { name: 'B', color: '#abc' }] }, () => {});
  assert.ok(!/position:fixed/.test(html), 'a CSS declaration smuggled through a colour never reaches the markup');
  assert.ok(!/ on(mouseover|mouseout|focus|blur)=/.test(html), 'no inline event-handler attributes');
  panel.setState([{ color: '#112233;x:y', opacity: 'abc' }, { color: '#0f0', opacity: '0.5' }], { notify: false });
  const st = panel.getState();
  assert.ok(/^#[0-9a-f]{6}$/i.test(st[0].color) && /^#[0-9a-f]{6}$/i.test(st[1].color), 'colours stay 6-digit hex');
  assert.equal(st[1].color, '#00ff00');
  assert.ok(Number.isFinite(st[0].opacity), 'a non-numeric opacity never becomes NaN');
});

console.log('core regressions (channel panel): OK');
