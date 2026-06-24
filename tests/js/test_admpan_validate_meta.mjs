// Structural test for ELE-22 / EDGE-005: admpan.selectDataset must reject a
// malformed dataset (Rule 1.4) before mounting it into the editor. admpan.js is
// a vanilla ES module (no exports, registers listeners at load), so the invariant
// is locked structurally. (Plus `node --check`.)
//
// Run: node tests/js/test_admpan_validate_meta.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// v1.4.0: the dataset editor moved out of admpan.js into the admin SPA tab module.
const src = readFileSync(path.join(ROOT, 'js/pages/admin/tab-datasets.js'), 'utf8');

// validator exists and checks the key structural fields
assert.ok(/function validateDatasetMeta\(meta\)/.test(src), 'validateDatasetMeta defined');
for (const field of ['meta.id', 'meta.type', 'meta.dimensions', 'meta.channels']) {
  assert.ok(src.includes(field), `validator references ${field}`);
}

const start = src.indexOf('async function selectDataset');
const end = src.indexOf('\nasync function ', start + 1);
const fn = src.slice(start, end > 0 ? end : start + 2500);

const staleness = fn.indexOf('if (myGen !== _selectGen) return;'); // ELE-15 guard (must stay first)
const notMeta = fn.indexOf('if (!meta)');
const validateCall = fn.indexOf('validateDatasetMeta(meta)');
const useMeta = fn.indexOf('normaliseChannels(meta.channels');

assert.ok(staleness > 0 && staleness < validateCall, 'ELE-15 staleness guard still precedes validation');
assert.ok(notMeta > 0 && notMeta < validateCall, 'null-response check precedes validation');
assert.ok(validateCall > 0 && validateCall < useMeta, 'validation runs before the dataset is used (no partial mount)');

// a reject path (return) sits between the validation and first use
const rejectReturn = fn.indexOf('return;', validateCall);
assert.ok(rejectReturn > 0 && rejectReturn < useMeta, 'malformed dataset returns before mounting');

console.log('ELE-22 admpan dataset validation: OK');
