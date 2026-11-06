// Boot latency of the translations and the pages that wait on them.
//
//   • I18n.init() asks for the English file (and the saved locale) while the
//     language discovery is still in flight, instead of after it.
//   • Concurrent loadLanguage() calls for one locale share one request; a
//     failed request is not remembered, so the next call tries again.
//   • A speculative file the discovery then rules out is never applied.
//   • landing.js, 2d.js and compare.js start Catalog.load() before they wait
//     on the instance config and the translations.
//
// Run: node tests/js/test_i18n_boot_parallel.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { loadModule, ROOT } from './harness.mjs';

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

// languages: the discovery answer; held until `release()` when `holdDiscovery`.
function makeI18n({ languages, platform, saved = null, browser = 'en-US', holdDiscovery = false, failOnce = [] }) {
  const store = saved ? { 'iribhm-lang': saved } : {};
  const calls = [];
  const gate = deferred();
  if (!holdDiscovery) gate.resolve();
  const failures = new Set(failOnce);
  const miss = { ok: false, status: 404, json: async () => ({}) };
  const fetchMock = async (url) => {
    calls.push(url);
    if (url === 'api/languages.php' || url === 'api/languages') {
      await gate.promise;
      return { ok: true, status: 200, json: async () => ({ languages }) };
    }
    if (url.endsWith('lang/manifest.json')) return miss;
    const m = url.match(/^\.\/lang\/([a-z]{2,3})\.json$/);
    if (m) {
      if (failures.has(m[1])) { failures.delete(m[1]); return { ok: false, status: 503, json: async () => ({}) }; }
      const d = platform[m[1]];
      return d ? { ok: true, status: 200, json: async () => structuredClone(d) } : miss;
    }
    return miss;
  };
  const attrs = {};
  const I18n = loadModule('js/core/i18n.js', 'I18n', {
    localStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = v; } },
    navigator: { language: browser },
    window: { location: { pathname: '/index.html' } },
    document: { documentElement: { setAttribute(k, v) { attrs[k] = v; } }, querySelectorAll: () => [] },
    fetch: fetchMock,
    console: { ...console, warn() {} },
  });
  return { I18n, calls, release: () => gate.resolve(), attrs };
}

const PLATFORM = {
  en: { app: { title: 'Platform' } },
  fr: { app: { title: 'Plateforme' } },
  es: { app: { title: 'Plataforma' } },
};
const count = (calls, url) => calls.filter(u => u === url).length;

// ── 1. The English file and the saved locale do not wait for the discovery ──
{
  const { I18n, calls, release } = makeI18n({ languages: ['en', 'fr', 'es'], platform: PLATFORM, saved: 'fr', holdDiscovery: true });
  const booting = I18n.init();
  await flush();
  assert.ok(calls.includes('./lang/en.json'), 'en.json requested while the discovery is pending');
  assert.ok(calls.includes('./lang/fr.json'), 'the saved locale is requested while the discovery is pending');
  release();
  await booting;
  assert.equal(I18n.getLanguage(), 'fr');
  assert.equal(I18n.t('app.title'), 'Plateforme');
  assert.equal(count(calls, './lang/en.json'), 1, 'en.json fetched once');
  assert.equal(count(calls, './lang/fr.json'), 1, 'fr.json fetched once although init asked for it twice');
}

// ── 2. First visit: a browser language among the shipped locales is fetched early too ──
{
  const { I18n, calls, release } = makeI18n({ languages: ['en', 'fr', 'es'], platform: PLATFORM, browser: 'es-ES', holdDiscovery: true });
  const booting = I18n.init();
  await flush();
  assert.ok(calls.includes('./lang/es.json'), 'browser language requested beside the discovery');
  release();
  await booting;
  assert.equal(I18n.getLanguage(), 'es');
  assert.equal(count(calls, './lang/es.json'), 1);
}

// ── 3. A guess the discovery rules out is never applied ──
{
  const { I18n, attrs } = makeI18n({ languages: ['en', 'es'], platform: PLATFORM, saved: 'fr' });
  await I18n.init();
  assert.equal(I18n.getLanguage(), 'en', 'a saved locale the host no longer offers falls back to English');
  assert.equal(I18n.t('app.title'), 'Platform');
  assert.equal(attrs.lang, 'en');
}

// ── 4. Concurrent loads share one request; a failure is retried by the next call ──
{
  const { I18n, calls } = makeI18n({ languages: ['en', 'fr'], platform: PLATFORM, failOnce: ['fr'] });
  const [a, b] = await Promise.all([I18n.loadLanguage('fr'), I18n.loadLanguage('fr')]);
  assert.equal(a, null, 'the failed request resolves to null');
  assert.equal(b, null);
  assert.equal(count(calls, './lang/fr.json'), 1, 'two concurrent calls, one request');
  const again = await I18n.loadLanguage('fr');
  assert.equal(again && again.app.title, 'Plateforme', 'a failure is not cached');
  assert.equal(count(calls, './lang/fr.json'), 2);
  await I18n.loadLanguage('fr');
  assert.equal(count(calls, './lang/fr.json'), 2, 'a loaded file is served from memory');
}

// ── 5. A saved locale whose file fails is not applied ──
{
  const { I18n } = makeI18n({ languages: ['en', 'fr'], platform: { en: PLATFORM.en }, saved: 'fr' });
  await I18n.init();
  assert.equal(I18n.getLanguage(), 'en');
}

// ── 6. The pages start the catalog before waiting on config and translations ──
{
  const pages = [
    ['js/pages/landing.js', 'DOMContentLoaded'],
    ['js/pages/2d.js', 'async function _init()'],
    ['js/pages/compare.js', 'async function init()'],
  ];
  for (const [rel, anchor] of pages) {
    const src = readFileSync(path.join(ROOT, rel), 'utf8');
    const start = src.indexOf(anchor);
    assert.ok(start >= 0, `${rel}: boot function found`);
    const body = src.slice(start, start + 2000);
    const catalog = body.indexOf('Catalog.load()');
    const config = body.indexOf('await InstanceConfig.load()');
    const i18n = body.indexOf('await I18n.init()');
    assert.ok(catalog >= 0 && config >= 0 && i18n >= 0, `${rel}: boot calls found`);
    assert.ok(catalog < config && catalog < i18n, `${rel}: Catalog.load() starts before the config and translations are awaited`);
    assert.ok(!/await Catalog\.load\(\)/.test(body.slice(0, Math.max(config, i18n))), `${rel}: the catalog is not awaited before them`);
  }
}

console.log('test_i18n_boot_parallel: OK');
