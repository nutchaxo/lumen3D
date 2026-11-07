// A control that paints white text on a filled primary background must use the
// --color-primary-strong pair (computed for white at >= 4.5:1), never the brand
// --color-primary (3.19:1 under white in the default dark theme).
//
// Run: node tests/js/test_white_on_primary_contrast.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');

function luminance(hex) {
  const n = parseInt(hex.slice(1), 16);
  const lin = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
}
const contrastWithWhite = (hex) => 1.05 / (luminance(hex) + 0.05);

// Rule blocks of a stylesheet (or of the <style> elements of a page), comments removed.
function ruleBlocks(text) {
  const css = text.replace(/\/\*[\s\S]*?\*\//g, '');
  const out = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(css))) out.push({ selector: m[1].trim(), body: m[2] });
  return out;
}

const WHITE = /(^|;)\s*color:\s*(#fff\b|#ffffff\b|white\b|var\(--color-on-primary)/i;
const BRAND_FILL = /background(-color)?:\s*var\(--color-primary(-hover)?\b(?!-)/;

const offenders = [];
for (const file of ['css/tools.css', 'compare.html']) {
  for (const { selector, body } of ruleBlocks(read(file))) {
    if (WHITE.test(body) && BRAND_FILL.test(body)) offenders.push(`${file}: ${selector}`);
  }
  assert.ok(!/--color-on-primary/.test(read(file)), `${file} must not rely on the undefined --color-on-primary`);
}
assert.deepEqual(offenders, [], `white text on the brand primary fill:\n${offenders.join('\n')}`);

// The rules this test was written for really use the strong pair.
{
  const tools = read('css/tools.css');
  assert.match(tools, /\.graphs-body \.btn\.active \{\s*background: var\(--color-primary-strong\);/);
  assert.match(tools, /\.tool-chip\.active,\s*\.btn\.active \{\s*background: var\(--color-primary-strong\);/);
  const compare = read('compare.html');
  assert.match(compare, /\.panel-tool-btn\.btn-solid:hover \{\s*background: var\(--color-primary-strong-hover\);/);
  assert.match(compare, /\.panel-actions \.btn-settings\.active \{\s*background: var\(--color-primary-strong\);/);
}

// The fixed default pair meets AA under white; the brand green alone does not.
{
  const vars = read('css/variables.css');
  const strong = vars.match(/--color-primary-strong:\s*(#[0-9A-Fa-f]{6})/)[1];
  const strongHover = vars.match(/--color-primary-strong-hover:\s*(#[0-9A-Fa-f]{6})/)[1];
  const brand = vars.match(/--color-primary:\s*(#[0-9A-Fa-f]{6})/)[1];
  assert.ok(contrastWithWhite(strong) >= 4.5, `strong ${strong} = ${contrastWithWhite(strong).toFixed(2)}:1`);
  assert.ok(contrastWithWhite(strongHover) >= 4.5, `strong hover ${strongHover}`);
  assert.ok(contrastWithWhite(brand) < 4.5, 'the brand green is the case the strong pair exists for');
}

console.log('ok - white text on a primary fill uses --color-primary-strong (tools.css, compare.html)');
