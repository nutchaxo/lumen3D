// Structural test for ELE-15 / RACE-006: admpan.selectDataset must ignore a
// get() response that arrives after a newer selection (generation token).
// admpan.js is a vanilla ES module with no exports and registers listeners at
// load, so it cannot run headless without a browser; the invariant is locked
// structurally. (Plus `node --check`.)
//
// Run: node tests/js/test_admpan_selectdataset_guard.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const src = readFileSync(path.join(ROOT, 'js/pages/admpan.js'), 'utf8');

assert.ok(/let _selectGen = 0;/.test(src), '_selectGen token declared at module scope');

const start = src.indexOf('async function selectDataset');
assert.ok(start > 0, 'selectDataset found');
const end = src.indexOf('\nasync function ', start + 1);
const fn = src.slice(start, end > 0 ? end : start + 2000);

// token captured before mutating _current
const capture = fn.indexOf('const myGen = ++_selectGen;');
const currentAssign = fn.indexOf('_current = _datasets.find');
assert.ok(capture > 0, 'myGen captured from ++_selectGen');
assert.ok(capture < currentAssign, 'token captured before _current is reassigned');

// stale response dropped after the await, before using meta
const awaitIdx = fn.indexOf('await apiFetch(`${API_DATASETS}?action=get');
const guard = fn.indexOf('if (myGen !== _selectGen) return;');
const useMeta = fn.indexOf('if (!meta)');
assert.ok(awaitIdx > 0 && guard > awaitIdx, 'staleness guard runs after the get() await');
assert.ok(guard < useMeta, 'staleness guard runs before the response is used');

console.log('ELE-15 admpan selectDataset generation guard: OK');
