// Structural tests for the HTML hardening batch:
//   SEC-022  admin target="_blank" link missing rel="noopener" (reverse tabnabbing)
//   DEAD-024 widgets.html used a non-existent CSS var --bg-default
//   DEAD-008 index.html loaded an unused three.module.js (ESM, no window.THREE)
//   BUG-059  about/compare/explorer inline onclick handlers lacked a presence guard
//
// Run: node tests/js/test_html_hardening.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');

// SEC-022
{
  const s = read('admpan.html');
  assert.ok(/target="_blank" rel="noopener"/.test(s), 'SEC-022: admin _blank link has rel="noopener"');
}

// DEAD-024
{
  const s = read('widgets.html');
  assert.ok(!/var\(--bg-default\)/.test(s), 'DEAD-024: non-existent --bg-default removed');
  assert.ok(/var\(--bg-body\)/.test(s), 'DEAD-024: uses the real --bg-body token');
}

// DEAD-008
{
  const s = read('index.html');
  assert.ok(!/<script[^>]*three\.module\.js/.test(s), 'DEAD-008: unused three.module.js <script> removed');
}

// BUG-059
for (const f of ['about.html', 'compare.html', 'explorer.html']) {
  const s = read(f);
  assert.ok(!/onclick="Theme\.toggle\(\)"/.test(s) && !/onclick="ColorBlind\.openModal\(\)"/.test(s),
    `BUG-059: ${f} has no unguarded inline Theme/ColorBlind handler`);
  assert.ok(/onclick="window\.Theme && Theme\.toggle\(\)"/.test(s) && /onclick="window\.ColorBlind && ColorBlind\.openModal\(\)"/.test(s),
    `BUG-059: ${f} guards the inline handlers with a window presence check`);
}

console.log('HTML hardening (SEC-022, DEAD-024/008, BUG-059): OK');
