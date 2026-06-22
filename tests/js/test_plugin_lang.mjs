// Structural test for the per-plugin i18n folders.
//
// Guarantees the drop-in plugin-translation contract stays honest:
//   • Every plugin with a lang/ folder ships en.json (the mandatory fallback).
//   • plugin.json i18nLanguages exactly matches the lang/<code>.json files present.
//   • Every locale file in a plugin has the SAME key set as that plugin's en.json
//     (so a translated locale can never silently drop a string).
//   • Toolbar plugins (placement=tools) reference an i18nTitle that resolves in
//     their own en.json (plugin-local) OR in the platform lang/en.json (legacy).
//
// Run: node tests/js/test_plugin_lang.mjs
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from './harness.mjs';

const MOD = path.join(ROOT, 'js', 'modules');
const PLACEMENTS = ['tools', 'channels', 'shaders'];
const LANG_RE = /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/;

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const leafKeys = (o, prefix = '', out = new Set()) => {
  for (const k of Object.keys(o)) {
    const v = o[k], kp = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) leafKeys(v, kp, out);
    else out.add(kp);
  }
  return out;
};

const platformEn = readJson(path.join(ROOT, 'lang', 'en.json'));
const resolve = (o, k) => k.split('.').reduce((a, c) => (a && a[c] !== undefined ? a[c] : undefined), o);

let plugins = 0;
for (const placement of PLACEMENTS) {
  const base = path.join(MOD, placement);
  if (!existsSync(base)) continue;
  for (const id of readdirSync(base)) {
    const dir = path.join(base, id);
    if (!statSync(dir).isDirectory()) continue;
    const pjPath = path.join(dir, 'plugin.json');
    if (!existsSync(pjPath)) continue;
    const langDir = path.join(dir, 'lang');
    if (!existsSync(langDir)) continue; // a plugin with no strings needs no lang folder
    plugins++;

    const pj = readJson(pjPath);
    const files = readdirSync(langDir).filter(f => f.endsWith('.json'));
    const shipped = files.map(f => f.replace(/\.json$/, '')).filter(c => LANG_RE.test(c)).sort();

    assert.ok(shipped.includes('en'), `${placement}/${id}: must ship en.json (the fallback locale)`);

    // plugin.json i18nLanguages must match the files actually present.
    assert.deepEqual([...(pj.i18nLanguages || [])].sort(), shipped,
      `${placement}/${id}: plugin.json i18nLanguages must match the lang/ files (${shipped.join(',')})`);

    // Per-plugin key parity against en.json.
    const enKeys = leafKeys(readJson(path.join(langDir, 'en.json')));
    for (const code of shipped) {
      if (code === 'en') continue;
      const keys = leafKeys(readJson(path.join(langDir, `${code}.json`)));
      const missing = [...enKeys].filter(k => !keys.has(k));
      const extra = [...keys].filter(k => !enKeys.has(k));
      assert.equal(missing.length, 0, `${placement}/${id}/${code}.json missing keys: ${missing.join(', ')}`);
      assert.equal(extra.length, 0, `${placement}/${id}/${code}.json extra keys: ${extra.join(', ')}`);
    }

    // Toolbar title must resolve somewhere (plugin-local first, else platform).
    if (placement === 'tools' && pj.i18nTitle) {
      const local = resolve(readJson(path.join(langDir, 'en.json')), pj.i18nTitle);
      const platform = resolve(platformEn, pj.i18nTitle);
      assert.ok(local !== undefined || platform !== undefined,
        `${placement}/${id}: i18nTitle "${pj.i18nTitle}" resolves in neither the plugin nor the platform en.json`);
    }
  }
}

assert.ok(plugins >= 15, `expected most plugins to ship a lang/ folder (found ${plugins})`);
console.log(`plugin i18n folders (parity + i18nLanguages + title resolution): OK (${plugins} plugins)`);
