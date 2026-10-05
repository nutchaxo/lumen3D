// Full key + placeholder parity of lang/{en,fr,es,nl}.json against en.json.
// (test_compare_protocol.mjs only covers compare.*, test_plugin_lang.mjs the plugins.)
//
// A "placeholder" is a {token}. Tokens are compared case-insensitively because the
// instance tokens come in capitalised variants per locale ({SpecimenPlural} /
// {specimenPlural}) and resolve to the same value. PLACEHOLDER_EXEMPT lists the keys
// whose braces are a literal example the reader types, which is translated on purpose.
//
// Run: node tests/js/test_build_lang_parity.mjs
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from './harness.mjs';

const LANG_DIR = path.join(ROOT, 'lang');
const PLACEHOLDER_EXEMPT = new Set(['pages.vr.hint']);
const PLACEHOLDER_RE = /\{[A-Za-z0-9_.]+\}/g;

function flatten(obj, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(obj)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, `${prefix}${k}.`, out);
    else out[`${prefix}${k}`] = v;
  }
  return out;
}
const tokens = (s) => (typeof s === 'string' ? (s.match(PLACEHOLDER_RE) || []).map((t) => t.toLowerCase()).sort() : []);

const codes = readdirSync(LANG_DIR).filter((f) => /^[a-z]{2,3}\.json$/.test(f)).map((f) => f.slice(0, -5));
const must = ['en', 'fr', 'es', 'nl'];
const failures = [];
for (const c of must) if (!codes.includes(c)) failures.push(`lang/${c}.json is missing`);

const load = (c) => flatten(JSON.parse(readFileSync(path.join(LANG_DIR, `${c}.json`), 'utf8')));
const en = load('en');

for (const c of codes.filter((x) => x !== 'en')) {
  const tr = load(c);
  const missing = Object.keys(en).filter((k) => !(k in tr));
  const extra = Object.keys(tr).filter((k) => !(k in en));
  if (missing.length) failures.push(`${c}.json is missing ${missing.length} key(s) present in en.json:\n    ${missing.join('\n    ')}`);
  if (extra.length) failures.push(`${c}.json has ${extra.length} key(s) absent from en.json:\n    ${extra.join('\n    ')}`);
  const empty = Object.keys(tr).filter((k) => typeof tr[k] === 'string' && tr[k].trim() === '' && String(en[k] || '').trim() !== '');
  if (empty.length) failures.push(`${c}.json has empty value(s) where en.json has text:\n    ${empty.join('\n    ')}`);
  const drift = Object.keys(en).filter((k) => k in tr && !PLACEHOLDER_EXEMPT.has(k)
    && tokens(en[k]).join('|') !== tokens(tr[k]).join('|'));
  if (drift.length) {
    failures.push(`${c}.json changes the {placeholders} of ${drift.length} key(s):\n    ` +
      drift.map((k) => `${k}: en ${JSON.stringify(tokens(en[k]))} vs ${c} ${JSON.stringify(tokens(tr[k]))}`).join('\n    '));
  }
}

if (failures.length) {
  console.error('i18n parity FAILED:\n  ' + failures.join('\n  '));
  process.exit(1);
}
console.log(`i18n parity (${codes.join(', ')}; ${Object.keys(en).length} keys): OK`);
