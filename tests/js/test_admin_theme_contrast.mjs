// Admin panel colour tokens: every token used as a TEXT colour reaches WCAG AA
// (4.5:1) on every admin background, in the dark theme (admpan.css :root) and in
// the light theme (admin-shell.css [data-theme="light"]). The status colours are
// split in two: --adm-success/-warning/-danger stay the bright fills (badges with
// fixed dark label text), --adm-*-text is what a `color:` rule uses, and the
// light theme darkens only the latter.
//
// Run: node tests/js/test_admin_theme_contrast.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from './harness.mjs';

const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');

function block(css, selectorRx) {
  const m = selectorRx.exec(css);
  assert.ok(m, 'block not found: ' + selectorRx);
  const start = css.indexOf('{', m.index) + 1;
  return css.slice(start, css.indexOf('}', start));
}

function tokens(text) {
  const out = {};
  for (const m of text.matchAll(/(--adm-[\w-]+)\s*:\s*(#[0-9a-fA-F]{6})\s*;/g)) out[m[1]] = m[2].toLowerCase();
  return out;
}

function luminance(hex) {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
function contrast(a, b) {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

const admpan = read('css/admpan.css');
const shell = read('css/admin-shell.css');
const dark = tokens(block(admpan, /:root\s*\{/));
const lightBlock = tokens(block(shell, /^\[data-theme="light"\]\s*\{\s*--adm-bg:/m));
assert.ok(lightBlock['--adm-text'] && lightBlock['--adm-bg'], 'the light theme token block was found');
const light = { ...dark, ...lightBlock };

const BACKGROUNDS = ['--adm-bg', '--adm-surface', '--adm-card', '--adm-card-hover'];
const TEXT = ['--adm-text', '--adm-text-sec', '--adm-text-muted', '--adm-success-text', '--adm-warning-text', '--adm-danger-text'];

for (const [name, theme] of [['dark', dark], ['light', light]]) {
  for (const fg of TEXT) {
    assert.ok(theme[fg], `${name}: ${fg} is defined`);
    for (const bg of BACKGROUNDS) {
      const r = contrast(theme[fg], theme[bg]);
      assert.ok(r >= 4.5, `${name}: ${fg} ${theme[fg]} on ${bg} ${theme[bg]} = ${r.toFixed(2)}:1 < 4.5`);
    }
  }
  // Muted stays the dimmer of the two secondary text levels.
  assert.ok(contrast(theme['--adm-text-muted'], theme['--adm-card']) < contrast(theme['--adm-text-sec'], theme['--adm-card']),
    `${name}: muted text is dimmer than secondary text`);
}

// The fills are not re-coloured by the light theme: their fixed dark label text
// (.dupd-race-badge #06281b, .dock-bubble-badge #1a1a2e) keeps its contrast.
for (const fill of ['--adm-success', '--adm-warning', '--adm-danger']) {
  assert.ok(!(fill in lightBlock), `light theme leaves the ${fill} fill alone`);
}
assert.ok(contrast('#06281b', dark['--adm-success']) >= 4.5);
assert.ok(contrast('#1a1a2e', dark['--adm-warning']) >= 4.5);

// No admin stylesheet paints text with a fill token.
for (const rel of ['css/admpan.css', 'css/admin-shell.css', 'css/admin-updates.css', 'css/admin-upload.css']) {
  const css = read(rel);
  const bad = [...css.matchAll(/(?<![-\w])color:\s*var\(--adm-(success|warning|danger)\s*[,)]/g)].map((m) => m[0]);
  assert.deepEqual(bad, [], `${rel}: text colour must use the --adm-*-text tokens`);
}

console.log('test_admin_theme_contrast: OK');
