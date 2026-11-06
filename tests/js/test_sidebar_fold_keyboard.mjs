// A folded viewer / 2D sidebar must leave the Tab order: opacity 0 and a zero width
// keep its controls focusable (invisible focus, keys changing channels or quality).
// The folded rule sets visibility:hidden, delayed to the end of the width slide when
// folding and immediate when opening; the instant-fold contexts (Compare panel boot,
// headless 2D pane) keep `transition: none`. 2d.html loads the same stylesheet.
//
// Run: node tests/js/test_sidebar_fold_keyboard.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from './harness.mjs';

const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');
const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');

function rules(css) {
  const out = [];
  const rx = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = rx.exec(stripComments(css)))) {
    out.push({
      selectors: m[1].split(',').map((s) => s.trim().replace(/\s+/g, ' ')),
      body: m[2],
    });
  }
  return out;
}

function decl(body, prop) {
  const rx = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`, 'g');
  let m, last = null;
  while ((m = rx.exec(body))) last = m[1].trim().replace(/\s+/g, ' ');
  return last;
}

const viewerCss = rules(read('css/viewer.css'));
const find = (sel) => viewerCss.filter((r) => r.selectors.includes(sel));

const base = find('.viewer-sidebar').find((r) => decl(r.body, 'width') === '320px');
assert.ok(base, 'base .viewer-sidebar rule found');
assert.equal(decl(base.body, 'visibility'), 'visible', 'open sidebar is visible');
assert.match(decl(base.body, 'transition'), /visibility 0s linear 0s/,
  'opening shows the controls at once');

const folded = find('.viewer-sidebar.sidebar-hidden');
assert.equal(folded.length, 1, 'one folded rule');
assert.ok(folded[0].selectors.includes('html.panel-boot .viewer-sidebar'),
  'the Compare panel boot state shares the folded rule');
assert.equal(decl(folded[0].body, 'visibility'), 'hidden',
  'folded sidebar leaves the Tab order');
assert.equal(decl(folded[0].body, 'pointer-events'), 'none');
const foldTransition = decl(folded[0].body, 'transition');
assert.match(foldTransition, /visibility 0s linear 0\.25s/,
  'visibility flips once the 0.25 s width slide has finished');
assert.match(foldTransition, /width 0\.25s/, 'the width slide is kept');

const boot = find('html.panel-boot .viewer-sidebar').filter((r) => r.selectors.length === 1);
assert.ok(boot.some((r) => decl(r.body, 'transition') === 'none'),
  'a Compare panel folds without any transition');

const css2d = rules(read('css/2d.css'));
assert.ok(css2d.some((r) => r.selectors.includes('body.p2d-headless .viewer-sidebar')
  && decl(r.body, 'transition') === 'none'), 'headless 2D pane folds instantly');

const html2d = read('2d.html');
assert.match(html2d, /<link rel="stylesheet" href="css\/viewer\.css/,
  '2d.html loads viewer.css, so the photograph page gets the same rule');

console.log('ok - folded sidebar leaves the Tab order (viewer and 2D)');
