// Unit tests for the core-singletons robustness batch:
//   BUG-015  i18n auto-detect allowlist dropped the shipped 'es' locale
//   BUG-016  I18n.t() threw on a non-leaf (object) key via value.replace()
//   BUG-045  Theme.init had a no-op `prefersDark ? 'dark' : 'dark'` ternary
//   EDGE-043 Utils.formatFileSize produced 'NaN undefined' on NaN/Inf/negative
//   DEAD-033 Utils.formatDate/formatStage had a duplicate unreachable guard
//   DEAD-034 Catalog.getTypes was exported but never called (dead surface)
//   EDGE-059 DisplayPresets.resolve masked invalid custom color + dropped 'transparent'
//
// Run: node tests/js/test_core_robustness.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadModule } from './harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// ── i18n: BUG-015 (auto-detect) + BUG-016 (non-string t) ──
function loadI18n(lang, saved, data) {
  const store = saved ? { 'iribhm-lang': saved } : {};
  return loadModule('js/core/i18n.js', 'I18n', {
    localStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = v; } },
    navigator: { language: lang },
    window: { location: { pathname: '/index.html' } },
    document: { documentElement: { setAttribute() {} }, querySelectorAll: () => [] },
    fetch: async () => ({ ok: true, status: 200, json: async () => data }),
    console,
  });
}

{
  const es = loadI18n('es-ES', null, { hi: 'hola' });
  await es.init();
  assert.equal(es.getLanguage(), 'es', 'BUG-015: es-ES browser auto-selects shipped es locale');

  const fr = loadI18n('fr-CA', null, { hi: 'bonjour' });
  await fr.init();
  assert.equal(fr.getLanguage(), 'fr', 'fr-CA browser -> fr');

  const de = loadI18n('de-DE', null, { hi: 'hallo' });
  await de.init();
  assert.equal(de.getLanguage(), 'en', 'unsupported browser lang -> en fallback');
}

{
  const m = loadI18n('en-US', null, { greeting: 'Hello {name}', nav: { home: 'Home' } });
  await m.init();
  assert.equal(m.t('greeting', { name: 'Bob' }), 'Hello Bob', 'leaf interpolation still works');
  assert.doesNotThrow(() => m.t('nav', { name: 'x' }), 'BUG-016: t() on object key must not throw');
  assert.equal(m.t('nav', { name: 'x' }), 'nav', 'BUG-016: t() on object key returns the key');
  assert.equal(m.t('nav'), 'nav', 'BUG-016: t() on object key without params returns the key');
}

// ── theme: BUG-045 (dead ternary) ──
{
  let applied = null;
  const T = loadModule('js/core/theme.js', 'Theme', {
    localStorage: { getItem: () => null, setItem() {} },
    window: { matchMedia: () => ({ matches: false, addEventListener() {} }) },
    document: { documentElement: { setAttribute: (k, v) => { applied = v; } }, querySelectorAll: () => [] },
    console,
  });
  T.init();
  assert.equal(T.get(), 'dark', 'BUG-045: no saved pref + light system -> dark default');
  assert.equal(applied, 'dark', 'data-theme attribute applied as dark');
  const src = readFileSync(path.join(ROOT, 'js/core/theme.js'), 'utf8');
  assert.ok(!/\?\s*'dark'\s*:\s*'dark'/.test(src), 'BUG-045: no-op dark:dark ternary removed');
}

// ── utils: EDGE-043 (formatFileSize) + DEAD-033 (duplicate guard) ──
{
  const U = loadModule('js/core/utils.js', 'Utils', {
    window: { location: { origin: 'http://x' } }, document: {}, requestAnimationFrame: () => {}, console,
  });
  assert.equal(U.formatFileSize(0), '0 B');
  assert.equal(U.formatFileSize(1536), '1.5 KB', 'normal size still formats');
  assert.equal(U.formatFileSize(NaN), '—', 'EDGE-043: NaN -> em dash, not "NaN undefined"');
  assert.equal(U.formatFileSize(Infinity), '—', 'EDGE-043: Infinity -> em dash');
  assert.equal(U.formatFileSize(-5), '—', 'EDGE-043: negative -> em dash');
  assert.equal(U.formatFileSize(2 ** 60), (2 ** 60 / Math.pow(1024, 4)).toFixed(1) + ' TB', 'EDGE-043: huge size clamps to TB');

  assert.equal(U.formatDate(''), '—', 'DEAD-033: empty date -> em dash');
  assert.equal(U.formatStage(''), '—', 'DEAD-033: empty stage -> em dash');
  assert.equal(U.formatStage('E75'), 'E7.5', 'normal stage still formats');

  const usrc = readFileSync(path.join(ROOT, 'js/core/utils.js'), 'utf8');
  assert.equal((usrc.match(/if \(!dateStr\) return/g) || []).length, 1, 'DEAD-033: single date guard');
  assert.equal((usrc.match(/if \(!stage\) return/g) || []).length, 1, 'DEAD-033: single stage guard');
}

// ── catalog: DEAD-034 (dead getTypes removed) ──
{
  const csrc = readFileSync(path.join(ROOT, 'js/core/catalog.js'), 'utf8');
  assert.ok(!/getTypes/.test(csrc), 'DEAD-034: Catalog.getTypes removed (definition + export)');
  const Catalog = loadModule('js/core/catalog.js', 'Catalog', { window: {}, document: {}, fetch: async () => ({}), console });
  assert.equal(typeof Catalog.getTypes, 'undefined', 'DEAD-034: getTypes not on the public API');
  assert.equal(typeof Catalog.getStages, 'function', 'sibling API intact');
}

// ── display-presets: EDGE-059 (custom transparent + invalid color) ──
{
  const DP = loadModule('js/core/display-presets.js', 'DisplayPresets', { console });
  assert.equal(DP.resolve('custom', 'transparent').color, 'transparent', 'EDGE-059: custom "transparent" honored');
  assert.equal(DP.resolve('custom', 'transparent').transparent, true, 'EDGE-059: custom transparent sets flag');
  assert.equal(DP.resolve('custom', '#fff').color, '#ffffff', '3-hex custom expands');
  assert.equal(DP.resolve('custom', 'garbage').color, '#1a1d27', 'EDGE-059: invalid custom -> documented default (not silent absurd value)');
  assert.equal(DP.resolve('dark').color, '#000000', 'preset resolves');
  assert.equal(DP.resolve('transparent').color, 'transparent', 'transparent preset resolves');
}

console.log('core robustness (BUG-015/016/045, EDGE-043/059, DEAD-033/034): OK');
