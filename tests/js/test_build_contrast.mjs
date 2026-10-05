// WCAG AA (4.5:1, normal text) for the tokens that carry most of the platform's
// small text: --text-muted on every surface of both themes, the filled primary
// button (white on --color-primary-strong), the light-theme brand green as text,
// and the light-theme dataset badges. Ratios are computed from the CSS itself.
//
// Run: node tests/js/test_build_contrast.mjs
import { readFileSync } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { ROOT } from './harness.mjs';

const css = (f) => readFileSync(path.join(ROOT, 'css', f), 'utf8').split(String.fromCharCode(13)).join('');
const themes = css('themes.css');
const variables = css('variables.css');
const components = css('components.css');

function block(src, selector) {
  const start = src.indexOf(selector);
  assert.ok(start >= 0, `selector not found: ${selector}`);
  return src.slice(start, src.indexOf('\n}', start));
}
const token = (css, name) => {
  const m = css.match(new RegExp(String.raw`${name}:\s*(#[0-9A-Fa-f]{6})`));
  assert.ok(m, `token ${name} not found`);
  return m[1];
};
const lin = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const lum = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => lin(parseInt(hex.slice(i, i + 2), 16) / 255));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a, b) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
const mixOver = (fg, alpha, bg) => '#' + [1, 3, 5].map((i) => {
  const v = Math.round(alpha * parseInt(fg.slice(i, i + 2), 16) + (1 - alpha) * parseInt(bg.slice(i, i + 2), 16));
  return v.toString(16).padStart(2, '0');
}).join('');
const AA = 4.5;
const check = (label, fg, bg) => assert.ok(ratio(fg, bg) >= AA, `${label}: ${fg} on ${bg} = ${ratio(fg, bg).toFixed(2)}:1 (< ${AA})`);

const dark = block(themes, ':root,\n[data-theme="dark"]');
const light = block(themes, '[data-theme="light"] {');

for (const [name, css] of [['dark', dark], ['light', light]]) {
  const muted = token(css, '--text-muted');
  for (const surface of ['--bg-body', '--bg-surface', '--bg-surface-2', '--bg-surface-3']) {
    if (name === 'dark' && surface === '--bg-surface-3') continue; // checked below with the elevated tones
    check(`${name} --text-muted on ${surface}`, muted, token(css, surface));
  }
  if (name === 'dark') {
    check('dark --text-muted on --bg-surface-3', muted, token(css, '--bg-surface-3'));
    check('dark --text-muted on --bg-elevated', muted, token(css, '--bg-elevated'));
  }
}

// Filled primary button.
const strong = token(variables, '--color-primary-strong');
const strongHover = token(variables, '--color-primary-strong-hover');
check('btn-primary', '#FFFFFF', strong);
check('btn-primary:hover', '#FFFFFF', strongHover);
// The strong pair follows the operator's --color-primary (config/theme.css overrides only that):
// 77 % / 64 % over black of the default green must land on the fixed fallbacks above.
const mixBlack = (hex, p) => '#' + [1, 3, 5].map((i) => Math.round(p * parseInt(hex.slice(i, i + 2), 16)).toString(16).padStart(2, '0')).join('');
assert.match(variables, /--color-primary-strong:\s*color-mix\(in srgb, var\(--color-primary\) 77%, #000\)/, 'strong primary derives from --color-primary');
check('btn-primary (derived)', '#FFFFFF', mixBlack(token(variables, '--color-primary'), 0.77));
check('btn-primary:hover (derived)', '#FFFFFF', mixBlack(token(variables, '--color-primary'), 0.64));
const btn = block(components, '.btn-primary {');
assert.ok(btn.includes('var(--color-primary-strong)') && /color:\s*#FFFFFF/i.test(btn), '.btn-primary uses the strong green with white text');

// Brand green as text on the light theme.
check('light --color-primary as text', token(light, '--color-primary'), token(light, '--bg-surface'));
check('light --color-primary as text on body', token(light, '--color-primary'), token(light, '--bg-body'));

// Light-theme badges: text over its own 10% tint on white.
for (const [kind, rgb] of [['3d', '#00B4E0'], ['2d', '#5B4BD6'], ['live', '#E68C14']]) {
  const bg = mixOver(rgb, 0.10, '#FFFFFF');
  check(`light badge-${kind}`, token(light, `--badge-${kind}-text`), bg);
}
// Admin filled buttons: white label on --adm-btn-fill (and its hover).
const admpan = css('admpan.css');
check('adm-btn fill', '#FFFFFF', token(admpan, '--adm-btn-fill'));
check('adm-btn fill:hover', '#FFFFFF', token(admpan, '--adm-btn-fill-hover'));
for (const sel of ['.adm-btn-primary {', '.adm-btn-accent {']) {
  assert.ok(block(admpan, sel).includes('var(--adm-btn-fill)'), `${sel} uses the AA button fill`);
}
console.log('contrast (WCAG AA) of muted text, primary button, light badges, admin buttons: OK');
