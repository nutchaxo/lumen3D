// Every var(--token) written WITHOUT a fallback must name a custom property that
// something defines. An undefined one makes the whole declaration invalid at
// computed-value time: the border becomes none, the background transparent
// (the Compare gutter, the Decompose "editing" highlight, the 2D figure modal).
//
// Definitions are gathered from every stylesheet, page and script of the
// platform (`--x:` in a rule or an inline style string, `setProperty('--x', …)`),
// never from config/theme.css: that sheet is the operator's compiled theme and a
// fresh install has none, so a token defined only there is undefined elsewhere.
//
// Run: node tests/js/test_css_tokens_defined.mjs
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from './harness.mjs';

function walk(rel, exts, out = []) {
  const abs = path.join(ROOT, rel);
  for (const name of readdirSync(abs)) {
    const childRel = path.posix.join(rel, name);
    if (childRel === 'js/vendor') continue;
    const st = statSync(path.join(abs, name));
    if (st.isDirectory()) walk(childRel, exts, out);
    else if (exts.some((e) => name.endsWith(e))) out.push(childRel);
  }
  return out;
}

const files = [
  ...walk('css', ['.css']),
  ...walk('js', ['.js']),
  ...readdirSync(ROOT).filter((n) => n.endsWith('.html')),
];

// Comments may quote a token as prose (`var(--x)`); they are not declarations.
function stripComments(src, isJs) {
  let s = src.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ''));
  if (isJs) s = s.replace(/^\s*\/\/.*$/gm, '');
  return s;
}

const sources = files.map((f) => ({ f, s: stripComments(readFileSync(path.join(ROOT, f), 'utf8'), f.endsWith('.js')) }));

const defined = new Set();
for (const { s } of sources) {
  for (const m of s.matchAll(/(--[\w-]+)\s*:/g)) defined.add(m[1]);
  for (const m of s.matchAll(/setProperty\(\s*['"`](--[\w-]+)/g)) defined.add(m[1]);
}

// The theme tokens the replacements below lean on must stay defined by the themes themselves.
{
  const themes = readFileSync(path.join(ROOT, 'css/themes.css'), 'utf8');
  const vars = readFileSync(path.join(ROOT, 'css/variables.css'), 'utf8');
  for (const tok of ['--border-default', '--bg-elevated', '--bg-surface']) {
    assert.ok(new RegExp(`${tok}\\s*:`).test(themes), `${tok} is defined by css/themes.css`);
  }
  assert.ok(/--color-primary\s*:/.test(vars), '--color-primary is defined by css/variables.css');
  assert.ok(/--color-error\s*:/.test(vars), '--color-error is defined by css/variables.css');
}

const missing = [];
for (const { f, s } of sources) {
  for (const m of s.matchAll(/var\(\s*(--[\w-]+)\s*\)/g)) {
    if (defined.has(m[1])) continue;
    const line = s.slice(0, m.index).split('\n').length;
    missing.push(`${f}:${line} ${m[1]}`);
  }
}
assert.deepEqual(missing, [], `var() without a fallback on an undefined token:\n  ${missing.join('\n  ')}`);

// The aliases that used to be written by hand are gone for good (no alias token either).
for (const tok of ['--border-light', '--border-color', '--bg-card', '--bg-panel', '--primary', '--primary-rgb']) {
  assert.ok(!defined.has(tok), `${tok} is not reintroduced as an alias`);
  const users = sources.filter(({ s }) => new RegExp(`var\\(\\s*${tok}\\s*[,)]`).test(s)).map(({ f }) => f);
  assert.deepEqual(users, [], `${tok} is not used any more (${users.join(', ')})`);
}

console.log(`OK test_css_tokens_defined (${files.length} files, ${defined.size} tokens defined)`);
