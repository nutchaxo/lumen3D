// A page embedded as a pane (Compare panel, split-view pane: `hideHeader=true&panelIndex=N`)
// is folded from the first paint by the `panel-boot` class that theme-boot.js puts on
// <html>. Its CSS rule outranks the bare sidebar, so every page reached that way must drop
// the class once its own `sidebar-hidden` carries the fold, or the sidebar can never be
// opened again (the 2d photograph pane of 1.81.0).
//
// Run: node tests/js/test_panel_boot.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT } from './harness.mjs';

const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r/g, '');

function classList(initial = []) {
  const set = new Set(initial);
  return {
    add: (c) => set.add(c),
    remove: (c) => set.delete(c),
    toggle: (c, on) => { const want = on === undefined ? !set.has(c) : Boolean(on); if (want) set.add(c); else set.delete(c); return want; },
    contains: (c) => set.has(c),
  };
}

// ── theme-boot.js sets the class for a pane, not for the admin preview ──
function bootClasses(search) {
  const html = { classList: classList(), setAttribute() {} };
  const ctx = vm.createContext({
    document: { documentElement: html, currentScript: null },
    window: { location: { search } },
    localStorage: { getItem: () => null },
    URLSearchParams,
  });
  vm.runInContext(read('js/core/theme-boot.js'), ctx);
  return html.classList;
}
assert.ok(bootClasses('?id=2d/a&hideHeader=true&panelIndex=1').contains('panel-boot'), 'a pane boots folded');
assert.ok(!bootClasses('?id=2d/a&hideHeader=true&panelIndex=1&mode=admin').contains('panel-boot'), 'the admin preview does not');
assert.ok(!bootClasses('?id=2d/a').contains('panel-boot'), 'a page of its own does not');

// ── the CSS couples the fold to the class, so the hand-off is required ──
const css = read('css/viewer.css');
assert.ok(/\.viewer-sidebar\.sidebar-hidden,\s*\nhtml\.panel-boot \.viewer-sidebar\s*\{[^}]*pointer-events:\s*none/.test(css),
  'viewer.css folds the sidebar under html.panel-boot as under sidebar-hidden');
for (const page of ['viewer.html', '2d.html']) {
  const html = read(page);
  assert.ok(html.includes('css/viewer.css') && html.includes('js/core/theme-boot.js'), `${page} carries both the rule and the boot script`);
}

// ── 2d.js: _setSidebarHidden hands the fold over, in either direction ──
{
  const src = read('js/pages/2d.js');
  const at = src.indexOf('  function _setSidebarHidden(hidden) {');
  assert.ok(at > 0, '2d.js has _setSidebarHidden');
  const end = src.indexOf('\n  }\n', at);
  const fn = src.slice(at, end + 4);
  const html = { classList: classList(['panel-boot']) };
  const sidebar = { classList: classList() };
  const hamburger = { hidden: true };
  const posted = [];
  const ctx = vm.createContext({
    document: { documentElement: html },
    $: (id) => (id === 'viewer-sidebar' ? sidebar : id === 'btn-hamburger' ? hamburger : null),
    _panelIndex: '1', _meta: { id: '2d/a' }, _suppressSidebarSync: true,
    _postToHost: (m) => posted.push(m),
  });
  vm.runInContext(fn + '\nglobalThis.__set = _setSidebarHidden;', ctx);
  ctx.__set(true);                              // the boot-time fold of a pane
  assert.ok(sidebar.classList.contains('sidebar-hidden'), 'the pane folds with its own class');
  assert.ok(!html.classList.contains('panel-boot'), 'and drops the boot fold');
  assert.equal(posted.length, 0, 'the boot fold is not news to the host');
  ctx.__set(false);                             // the host's settings button (TOGGLE_SIDEBAR)
  assert.ok(!sidebar.classList.contains('sidebar-hidden') && !html.classList.contains('panel-boot'), 'nothing keeps the sidebar folded once opened');
  assert.equal(hamburger.hidden, true);

  // The boot fold is applied in the pane block, before the photograph loads.
  const block = src.slice(src.indexOf('    if (_panelIndex !== null) {\n      _suppressSidebarSync = true;'));
  assert.ok(block.indexOf('_setSidebarHidden(true);') > 0 && block.indexOf('_setSidebarHidden(true);') < block.indexOf('_openDataset('), '2d.js folds the pane before the photograph opens');
}

// ── viewer.js does the same hand-off in its iframe branch ──
{
  const src = read('js/pages/viewer.js');
  const at = src.indexOf("classList.add('sidebar-hidden');");
  const removed = src.indexOf("document.documentElement.classList.remove('panel-boot');");
  assert.ok(at > 0 && removed > at && removed - at < 400, 'viewer.js drops panel-boot right after folding with sidebar-hidden');
}

console.log('panel boot hand-off: OK');
