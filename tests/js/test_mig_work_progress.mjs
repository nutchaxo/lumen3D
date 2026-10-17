// "Data updates" progress (js/pages/admin/migration-runner.js workProgress): units with no data
// under them are done from the plan on, so the server's `done` starts at `empty`; the bar and
// the counts leave them out and start at 0. The tab shows them apart (dupd.emptyDone), in every
// locale, and keeps the dataset's size on its row while a job exists (dupd.mbLeft).
//
// Run: node tests/js/test_mig_work_progress.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from './harness.mjs';

const M = await import(pathToFileURL(path.join(ROOT, 'js/pages/admin/migration-runner.js')).href);
const { workProgress } = M;

assert.deepEqual(workProgress({ total: 400, empty: 120, done: 120 }), { done: 0, total: 280, empty: 120, pct: 0 });
assert.deepEqual(workProgress({ total: 400, empty: 120, done: 260 }), { done: 140, total: 280, empty: 120, pct: 50 });
assert.deepEqual(workProgress({ total: 400, empty: 120, done: 400 }), { done: 280, total: 280, empty: 120, pct: 100 });
assert.deepEqual(workProgress({ total: 10, done: 4 }), { done: 4, total: 10, empty: 0, pct: 40 });
// Every unit empty: nothing to do, done.
assert.deepEqual(workProgress({ total: 5, empty: 5, done: 5 }), { done: 0, total: 0, empty: 5, pct: 100 });
// Nothing planned yet; inconsistent counts never go negative or past the end.
assert.deepEqual(workProgress({}), { done: 0, total: 0, empty: 0, pct: 0 });
assert.deepEqual(workProgress({ total: 10, empty: 3, done: 1 }), { done: 0, total: 7, empty: 3, pct: 0 });
assert.deepEqual(workProgress({ total: 10, empty: 3, done: 12 }), { done: 7, total: 7, empty: 3, pct: 100 });

for (const code of ['en', 'fr', 'es', 'nl']) {
  const d = JSON.parse(readFileSync(path.join(ROOT, 'lang', code + '.json'), 'utf8')).dupd;
  assert.match(d.emptyDone, /\{n\}/, code + ' dupd.emptyDone');
  assert.match(d.mbLeft, /\{mb\}/, code + ' dupd.mbLeft');
}
const tab = readFileSync(path.join(ROOT, 'js/pages/admin/tab-dataset-updates.js'), 'utf8');
assert.ok(!/p\.total \? \(100 \* p\.done\)/.test(tab) && !/j\.total \? \(100 \*/.test(tab), 'every bar goes through workProgress');

console.log('migration work progress: OK');
