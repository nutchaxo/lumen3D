// Keyboard / screen-reader state of the Compare and Explorer toggles, and the
// Compare page's automatic layout at phone width. Source-level checks: the two
// pages need a DOM, frames and the whole platform to boot.
//
//   • Every toggle that shows its state with a class also says it in aria-pressed
//     (Compare type chips, tool chips, panel settings buttons; Explorer grid/list).
//   • Closing a drawer or a panel that holds the focus hands it to a neighbour
//     instead of dropping it on <body>; rebuilt type chips give it back.
//   • Below 720 px the automatic layout stacks the panels in one scrolling column;
//     the operator's Columns / Rows / Grid layouts (layout-custom) are left alone.
//
// Run: node tests/js/test_compare_toggle_a11y_layout.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from './harness.mjs';

const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const compareJs = read('js/pages/compare.js');
const compareHtml = read('compare.html');
const explorerJs = read('js/pages/explorer.js');
const explorerHtml = read('explorer.html');

function fnBody(src, signature) {
  const start = src.indexOf(signature);
  assert.ok(start >= 0, `${signature} found`);
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`unbalanced ${signature}`);
}

// ── Compare: toggles expose their state ──
{
  const chips = fnBody(compareJs, 'function _renderModalTypeChips()');
  assert.match(chips, /aria-pressed="\$\{on\}"/, 'type chips carry aria-pressed');
  const sync = fnBody(compareJs, 'function _syncToolChips()');
  assert.match(sync, /setAttribute\('aria-pressed'/, 'tool chips carry aria-pressed');
  const setter = fnBody(compareJs, 'function _setSettingsButton(');
  assert.match(setter, /classList\.toggle\('active', on\)/);
  assert.match(setter, /setAttribute\('aria-pressed', String\(on\)\)/);
  assert.match(fnBody(compareJs, 'function _toggleSidebar('), /_setSettingsButton\(btn, next\)/, 'sidebar toggle goes through the setter');
  assert.match(compareJs, /case 'SIDEBAR_CLOSED': \{\n\s*_setSettingsButton\(/, 'a sidebar closed from the panel updates aria-pressed too');
  assert.ok(!/btn-settings'\);\n\s*if \(btn\) btn\.classList\.(remove|toggle)\('active'/.test(compareJs), 'no settings button flips its class alone');
  assert.match(compareJs, /class="[^"]*btn-settings"[^>]*aria-pressed="false"/, 'settings button starts unpressed');
  assert.match(compareJs, /class="[^"]*btn-settings"[^>]*data-i18n-aria="js\.toggleSettings"/, 'settings button has a translated name');
  assert.match(compareJs, /class="[^"]*btn-close-panel"[^>]*data-i18n-aria="js\.closePanel"/, 'close button has a translated name');
}

// ── Compare: focus is never dropped on <body> ──
{
  const remove = fnBody(compareJs, 'function _removePanel(');
  const hadFocus = remove.indexOf('panel.el.contains(document.activeElement)');
  const detach = remove.indexOf('panel.el?.remove()');
  assert.ok(hadFocus >= 0 && detach > hadFocus, 'focus is read before the panel leaves the DOM');
  assert.match(remove, /\.btn-close-panel'\) \|\| document\.getElementById\('btn-add-dataset'\)/, 'focus goes to a neighbour panel, else the add button');
  assert.ok(remove.indexOf('target?.focus()') > remove.indexOf('_updateLayout()'), 'focus moves after the add button is re-enabled');

  const drawer = compareJs.slice(compareJs.indexOf('addDrawer: (def = {}) =>'));
  const set = drawer.slice(drawer.indexOf('const set = (on) =>'), drawer.indexOf("btn.addEventListener('click'"));
  const check = set.indexOf('el.contains(document.activeElement)');
  const hide = set.indexOf("el.classList.toggle('open', on)");
  assert.ok(check >= 0 && check < hide, 'the drawer checks the focus before hiding itself');
  assert.match(set, /if \(focusBack\) btn\.focus\(\)/, 'the focus returns to the drawer button');

  const chipClick = compareJs.slice(compareJs.indexOf("getElementById('modal-type-chips')?.addEventListener"));
  assert.match(chipClick.slice(0, 600), /_modalTypeChip\(_modalFilter\.type\)\?\.focus\(\)/, 'a rebuilt chip row gives the focus back');
}

// ── Compare: phone-width layout ──
{
  const media = compareHtml.match(/@media \(max-width: 720px\) \{([\s\S]*?)\n    \}/);
  assert.ok(media, 'compare.html has the narrow-layout media rule');
  const rule = media[1];
  for (const n of [2, 3, 4]) {
    assert.ok(rule.includes(`.compare-grid:not(.layout-custom).layout-${n}`), `layout-${n} stacks in auto mode only`);
  }
  assert.match(rule, /grid-template-columns: minmax\(0, 1fr\)/, 'one column');
  assert.match(rule, /grid-template-rows: none/, 'the fixed two-row template is dropped');
  assert.match(rule, /grid-auto-rows: minmax\(60vh, 1fr\)/, 'each panel tall enough to work in');
  assert.match(rule, /overflow-y: auto/, 'the column scrolls');
  assert.match(rule, /\.layout-3 > \.compare-panel\[data-first\] \{ grid-column: auto; \}/, 'the spanning first panel adds no implicit column');
  assert.ok(!/\.layout-custom[^,{]*\{/.test(rule.replace(/:not\(\.layout-custom\)/g, '')), 'no rule targets the custom layouts');
  assert.match(compareJs, /const NARROW_LAYOUT_QUERY = '\(max-width: 720px\)'/, 'the script watches the same breakpoint');
  assert.match(fnBody(compareJs, 'function _watchNarrowLayout()'), /_notifyFramesResize/, 'crossing it re-measures the panels');
  assert.match(fnBody(compareJs, 'async function init()'), /_watchNarrowLayout\(\)/, 'the watcher is installed at boot');
}

// ── Explorer: grid / list toggles ──
{
  assert.match(explorerHtml, /id="btn-view-grid" aria-pressed="true"/, 'grid starts pressed (the default view)');
  assert.match(explorerHtml, /id="btn-view-list" aria-pressed="false"/);
  assert.match(explorerJs, /let _currentView = 'grid'/, 'markup matches the default view');
  assert.match(explorerJs, /btn\.setAttribute\('aria-pressed', String\(v === view\)\)/, 'clicks update aria-pressed');
}

console.log('test_compare_toggle_a11y_layout: OK');
