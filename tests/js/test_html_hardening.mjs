// Structural tests for the HTML hardening batch (HTML pages + deepzoom-viewer.js):
//   SEC-022  admin target="_blank" link missing rel="noopener" (reverse tabnabbing)
//   SEC-020  DeepZoom manifest basePath concatenated into tile URLs without validation
//   DEAD-024 widgets.html used a non-existent CSS var --bg-default
//   DEAD-008 index.html loaded an unused three.module.js (ESM, no window.THREE)
//   BUG-058  deepzoom.html had data-i18n attrs but never loaded i18n.js
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

// SEC-020
{
  const s = read('js/components/deepzoom-viewer.js');
  assert.ok(/refusing unsafe manifest basePath/.test(s), 'SEC-020: basePath validated before tile URL build');
  assert.ok(/\.split\(\/\[\\\\\/\]\/\)\.includes\('\.\.'\)/.test(s), 'SEC-020: rejects ".." path segments');
}

// BUG-058
{
  const s = read('deepzoom.html');
  assert.ok(/js\/core\/i18n\.js/.test(s), 'BUG-058: deepzoom.html loads i18n.js');
  assert.ok(/I18n\.init\(\)/.test(s), 'BUG-058: deepzoom.html initializes i18n to translate data-i18n labels');
}

// BUG-059
for (const f of ['about.html', 'compare.html', 'explorer.html']) {
  const s = read(f);
  assert.ok(!/onclick="Theme\.toggle\(\)"/.test(s) && !/onclick="ColorBlind\.openModal\(\)"/.test(s),
    `BUG-059: ${f} has no unguarded inline Theme/ColorBlind handler`);
  assert.ok(/onclick="window\.Theme && Theme\.toggle\(\)"/.test(s) && /onclick="window\.ColorBlind && ColorBlind\.openModal\(\)"/.test(s),
    `BUG-059: ${f} guards the inline handlers with a window presence check`);
}

console.log('HTML hardening (SEC-022/020, DEAD-024/008, BUG-058/059): OK');
