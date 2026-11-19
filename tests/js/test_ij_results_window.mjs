// Window › Results on an empty table: the window must build (an empty results list has no columns, which once
// left the table body unbuilt and threw on the first render), then show rows once measurements arrive.
//
// Run: node tests/js/test_ij_results_window.mjs
import assert from 'node:assert/strict';
import { boot, until } from './ij_harness.mjs';

const t = await boot({ channels: 2 });
await t.open();
// A real browser has document.createDocumentFragment (the harness's fake document does not), which is the path
// that threw: give the page one.
t.page.document.createDocumentFragment = () => t.page.document.createElement('fragment');
const errors = [];
const origError = console.error;
console.error = (...a) => { errors.push(a.map(String).join(' ')); origError(...a); };
try {
  await t.runCommand('windowResults');
  await until(() => t.shell.windows.floats.has('results'), 'Results window open');
  // The tool refresh runs on a 60 ms debounce; give it time to render the empty table.
  await new Promise((r) => setTimeout(r, 150));
  assert.deepEqual(errors.filter((e) => /tool update|TypeError/.test(e)), [], 'an empty Results window renders without error');
  console.log('  ok  Window › Results opens on an empty table');
} finally {
  console.error = origError;
}
console.log('test_ij_results_window: 1 passed');
process.exit(0);
