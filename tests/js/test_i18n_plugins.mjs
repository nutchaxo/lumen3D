// Unit tests for the plugin i18n + dynamic language system (js/core/i18n.js).
//
// Covers the contract the platform promises:
//   • Language discovery is dynamic (endpoint → manifest → embedded default).
//   • The switcher offers exactly the PLATFORM's locales (getAvailableLanguages).
//   • A platform locale a plugin does NOT ship falls back to the plugin's English.
//   • A locale a plugin ships but the platform lacks is never selectable.
//   • Plugin-scoped t() (forPlugin / tp) resolves plugins.<id>.<key> with params.
//
// Run: node tests/js/test_i18n_plugins.mjs
import assert from 'node:assert/strict';
import { loadModule } from './harness.mjs';

// Build an I18n instance with a URL-routing fetch mock.
//   languages : payload returned for the discovery endpoint (or null → 404)
//   platform  : { code: dict }   platform lang files
//   plugins   : { 'path/lang/code.json' : dict }  plugin lang files (by URL suffix)
function makeI18n({ languages, platform, plugins = {}, saved = null, browser = 'en-US' }) {
  const store = saved ? { 'iribhm-lang': saved } : {};
  const fetchMock = async (url) => {
    const miss = { ok: false, status: 404, json: async () => ({}) };
    if (url === 'api/languages' || url === 'api/languages.php') {
      if (!languages) return miss;
      return { ok: true, status: 200, json: async () => ({ languages }) };
    }
    if (url.endsWith('lang/manifest.json')) return miss; // force endpoint or default
    // platform: './lang/<code>.json'
    const pm = url.match(/^\.\/lang\/([a-z]{2,3})\.json$/);
    if (pm) {
      const d = platform[pm[1]];
      return d ? { ok: true, status: 200, json: async () => d } : miss;
    }
    // plugin: 'js/modules/.../lang/<code>.json'
    for (const suffix of Object.keys(plugins)) {
      if (url.endsWith(suffix)) return { ok: true, status: 200, json: async () => plugins[suffix] };
    }
    return miss;
  };
  return loadModule('js/core/i18n.js', 'I18n', {
    localStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = v; } },
    navigator: { language: browser },
    window: { location: { pathname: '/index.html' } },
    document: { documentElement: { setAttribute() {} }, querySelectorAll: () => [] },
    fetch: fetchMock,
    console,
  });
}

const PLATFORM = {
  en: { app: { title: 'Platform' } },
  fr: { app: { title: 'Plateforme' } },
  es: { app: { title: 'Plataforma' } },
  zh: { app: { title: '平台' } },
};
// Plugin "demo" ships en + fr ONLY (no es, no zh).
const PLUGIN = {
  'js/modules/tools/demo/lang/en.json': { hello: 'Hello', greet: 'Hi {name}' },
  'js/modules/tools/demo/lang/fr.json': { hello: 'Bonjour', greet: 'Salut {name}' },
};

// ── 1. Dynamic discovery from the endpoint drives the switcher ──
{
  const I = makeI18n({ languages: ['en', 'fr', 'es', 'zh'], platform: PLATFORM, plugins: PLUGIN });
  await I.init();
  const codes = I.getAvailableLanguages().map(l => l.code);
  assert.equal(JSON.stringify(codes), JSON.stringify(['en', 'fr', 'es', 'zh']), 'switcher offers exactly the discovered platform locales');
  const zh = I.getAvailableLanguages().find(l => l.code === 'zh');
  assert.equal(zh.native, '中文', 'known locale gets native display name');
  assert.ok(I.isAvailable('zh'), 'zh is available');
  assert.ok(!I.isAvailable('de'), 'de (not shipped) is not available');
}

// ── 2. Discovery fallback to the embedded default when no source resolves ──
{
  const I = makeI18n({ languages: null, platform: PLATFORM, plugins: PLUGIN });
  await I.init();
  assert.equal(JSON.stringify(I.getAvailableLanguages().map(l => l.code)), JSON.stringify(['en', 'fr', 'es']),
    'no endpoint/manifest → embedded default [en,fr,es]');
}

// ── 3. Plugin-scoped lookup + the per-locale English fallback ──
{
  const I = makeI18n({ languages: ['en', 'fr', 'es', 'zh'], platform: PLATFORM, plugins: PLUGIN });
  await I.init();
  await I.loadPluginLang('demo', 'js/modules/tools/demo', ['en', 'fr']);

  // current locale = en
  assert.equal(I.tp('demo', 'hello'), 'Hello', 'en: plugin key resolves');
  assert.equal(I.forPlugin('demo').t('greet', { name: 'Bob' }), 'Hi Bob', 'forPlugin t() interpolates params');

  // switch to fr (shipped by the plugin)
  await I.setLanguage('fr');
  assert.equal(I.getLanguage(), 'fr');
  assert.equal(I.tp('demo', 'hello'), 'Bonjour', 'fr: plugin ships fr → French string');

  // switch to zh (NOT shipped by the plugin) → must fall back to the plugin's English
  await I.setLanguage('zh');
  assert.equal(I.getLanguage(), 'zh');
  assert.equal(I.t('app.title'), '平台', 'platform itself is in Chinese');
  assert.equal(I.tp('demo', 'hello'), 'Hello',
    'zh: plugin lacks zh → falls back to the plugin English, NOT the raw key');
}

// ── 4. A locale the platform does not ship is never selectable ──
{
  // Plugin also ships a 'de' file, but the platform has no de.json.
  const pluginWithDe = {
    ...PLUGIN,
    'js/modules/tools/demo/lang/de.json': { hello: 'Hallo' },
  };
  const I = makeI18n({ languages: ['en', 'fr', 'es', 'zh'], platform: PLATFORM, plugins: pluginWithDe });
  await I.init();
  await I.loadPluginLang('demo', 'js/modules/tools/demo', ['en', 'fr', 'de']);

  assert.ok(!I.getAvailableLanguages().some(l => l.code === 'de'),
    'plugin-only locale de is not offered in the switcher');
  await I.setLanguage('de');
  assert.notEqual(I.getLanguage(), 'de', 'setLanguage(de) is ignored — not a platform locale');
}

// ── 5. Missing plugin key returns the namespaced key (not a throw) ──
{
  const I = makeI18n({ languages: ['en', 'fr'], platform: PLATFORM, plugins: PLUGIN });
  await I.init();
  await I.loadPluginLang('demo', 'js/modules/tools/demo', ['en', 'fr']);
  assert.equal(I.tp('demo', 'nope'), 'plugins.demo.nope', 'unknown plugin key returns its key path');
}

console.log('i18n plugins + dynamic languages (fallback + discovery + scoping): OK');
