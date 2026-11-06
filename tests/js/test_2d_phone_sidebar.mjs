// The photograph page folds its 320 px sidebar on a phone-sized viewport (≤ 700 px,
// the volume viewer's threshold) so the picture is not drawn into a ~55 px strip; a
// wider window keeps it open, and a Compare pane keeps its own fold (silent, before
// the photograph loads). The boot block of 2d.js is run as written, with stubs.
//
// Run: node tests/js/test_2d_phone_sidebar.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT } from './harness.mjs';

const src = readFileSync(path.join(ROOT, 'js/pages/2d.js'), 'utf8').replace(/\r/g, '');
const start = src.indexOf('    _bindControls();\n    if (_panelIndex !== null) {');
assert.ok(start > 0, '2d.js binds its controls right before the sidebar fold');
const end = src.indexOf('    // A host must not be told', start);
assert.ok(end > start, 'the fold comes before the photograph opens');
const block = src.slice(src.indexOf('\n', start) + 1, end);

function run({ width, panelIndex = null, matchMedia = true, headless = false }) {
  const calls = [];
  const sandbox = {
    window: {},
    _panelIndex: panelIndex,
    _headless: headless,
    _suppressSidebarSync: false,
    _setSidebarHidden: (hidden) => calls.push({ hidden, suppressed: sandbox._suppressSidebarSync }),
    _bindPaneNav: () => calls.push({ paneNav: true }),
  };
  if (matchMedia) {
    sandbox.window.matchMedia = (q) => {
      const m = /\(max-width:\s*(\d+)px\)/.exec(q);
      assert.ok(m, `a max-width query: ${q}`);
      return { matches: width <= Number(m[1]) };
    };
  }
  vm.runInContext(block, vm.createContext(sandbox));
  return calls;
}

// A phone opens with the photograph on screen.
assert.deepEqual(run({ width: 375 }), [{ hidden: true, suppressed: false }], 'a 375 px phone folds the sidebar');
assert.deepEqual(run({ width: 700 }), [{ hidden: true, suppressed: false }], 'the threshold is inclusive, as in the viewer');
// A tablet or a desktop is wide enough for both.
assert.deepEqual(run({ width: 768 }), [], 'a tablet keeps the sidebar open');
assert.deepEqual(run({ width: 1440 }), [], 'a desktop keeps the sidebar open');
// A Compare pane folds silently whatever its width, and only once.
const pane = run({ width: 375, panelIndex: '1' });
assert.deepEqual(pane, [{ hidden: true, suppressed: true }, { paneNav: true }], 'a pane folds silently and binds its nav, once');
assert.deepEqual(run({ width: 1440, panelIndex: '0' }).filter((c) => 'hidden' in c).length, 1);
// The admin preview (hideHeader=true, no panelIndex) is a narrow iframe on a laptop
// (~552 px at a 1440 px window): its header and hamburger are hidden and nothing else
// reopens the sidebar, so it must never fold there.
assert.deepEqual(run({ width: 552, headless: true }), [], 'a headless admin preview keeps its sidebar open');
assert.deepEqual(run({ width: 375, headless: true }), [], 'even at phone width, headless never folds');
// A headless Compare pane still folds as a pane (its host owns TOGGLE_SIDEBAR).
assert.deepEqual(run({ width: 552, headless: true, panelIndex: '0' }).filter((c) => 'hidden' in c),
  [{ hidden: true, suppressed: true }], 'a headless pane keeps its silent fold');
// The reason: headless hides the header, the only place the hamburger lives.
const css = readFileSync(path.join(ROOT, 'css/2d.css'), 'utf8');
assert.ok(/body\.p2d-headless\s+\.viewer-header\s*\{\s*display:\s*none/.test(css), 'headless hides the header');
// A browser without matchMedia (old embed) leaves the layout alone.
assert.deepEqual(run({ width: 375, matchMedia: false }), [], 'no matchMedia, no fold');

// viewer.js uses the same threshold, so a phone sees both pages the same way.
const viewer = readFileSync(path.join(ROOT, 'js/pages/viewer.js'), 'utf8');
assert.ok(viewer.includes("matchMedia('(max-width: 700px)')"), 'the volume viewer folds at 700 px too');
assert.ok(block.includes("matchMedia('(max-width: 700px)')"), 'the photograph page uses the same query');

console.log('2d phone sidebar fold: OK');
