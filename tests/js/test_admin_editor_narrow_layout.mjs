// Admin Appearance tab and page editor on a phone: the side controls and the
// live preview / page canvas share the width through stylesheet classes (no
// fixed-width inline layout a media query cannot override), and below 760 px the
// controls stack above the preview so it keeps the full width.
//
// Run: node tests/js/test_admin_editor_narrow_layout.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from './harness.mjs';

const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');
const appearance = read('js/pages/admin/tab-appearance.js');
const pages = read('js/pages/admin/tab-pages.js');
const css = read('css/admin-shell.css');

// Markup: classes, no fixed column widths inline.
assert.ok(appearance.includes('<div class="adm-appearance-grid">'), 'Appearance grid uses its class');
assert.ok(!/grid-template-columns:\s*320px/.test(appearance), 'no inline 320px column');
assert.ok(/<div class="pe-body">\s*<div id="pages-side"><\/div>/.test(pages), 'page editor body row + sidebar carry no inline sizing');
assert.ok(!/flex:\s*0 0 340px/.test(pages), 'no inline 340px sidebar');
assert.ok(/id="pages-frame-wrap" style="[^"]*min-width:0/.test(pages), 'the canvas may still shrink below its content');

// Rules outside a media query.
function rule(text, selector) {
  const rx = new RegExp(selector.replace(/[.#]/g, (c) => '\\' + c) + '\\s*\\{([^}]*)\\}');
  const m = rx.exec(text);
  assert.ok(m, 'rule not found: ' + selector);
  return m[1].replace(/\s+/g, ' ');
}
const narrowStart = css.indexOf('@media (max-width: 760px)');
assert.ok(narrowStart > 0, 'the 760 px breakpoint exists');
let depth = 0, end = css.indexOf('{', narrowStart);
for (let i = end; i < css.length; i++) {
  if (css[i] === '{') depth++;
  else if (css[i] === '}' && --depth === 0) { end = i; break; }
}
const narrow = css.slice(narrowStart, end + 1);
const wide = css.slice(0, narrowStart);

assert.match(rule(wide, '.adm-appearance-grid'), /grid-template-columns: minmax\(0, 320px\) minmax\(0, 1fr\)/);
assert.match(rule(wide, '.pe-body'), /flex: 1; display: flex; min-height: 0/);
assert.match(rule(wide, '#pages-side'), /flex: 0 0 340px; width: 340px/);

// Phone: one column, the editor sidebar on top with a bounded height.
assert.match(rule(narrow, '.adm-appearance-grid'), /grid-template-columns: minmax\(0, 1fr\)/);
assert.match(rule(narrow, '.pe-body'), /flex-direction: column/);
const side = rule(narrow, '#pages-side');
assert.match(side, /flex: 0 0 auto/);
assert.match(side, /width: auto/);
assert.match(side, /max-height: 40vh/);
assert.match(side, /border-right: none/);

console.log('test_admin_editor_narrow_layout: OK');
