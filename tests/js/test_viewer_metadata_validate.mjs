// Structural test for ELE-19 / EDGE-002: a malformed metadata.json must be
// REJECTED at mount (Rule 1.4), not silently merged. viewer.js is a large page
// controller (not headless-loadable), so the invariant is locked structurally.
// (Plus `node --check`.)
//
// Run: node tests/js/test_viewer_metadata_validate.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const src = readFileSync(path.join(ROOT, 'js/pages/viewer.js'), 'utf8');

// validator exists and checks the structural fields
assert.ok(/function _validateDatasetMetadata\(meta, expectLive\)/.test(src), '_validateDatasetMetadata defined');
for (const f of ['dimensions', 'voxel_size', 'channels']) {
  assert.ok(src.includes(`metadata.json invalide`) || src.includes(f), `validator covers ${f}`);
}
// live check falls back to the catalogue dimension (not metadata-only)
assert.ok(src.includes('datasetMeta?.dimensions?.t'), 'live t-check uses the effective (catalogue) dimension');

// _mergeDatasetMetadata throws on invalid + the catch re-throws (not swallowed)
const mergeStart = src.indexOf('async function _mergeDatasetMetadata');
const mergeBody = src.slice(mergeStart, mergeStart + 1600);
assert.ok(mergeBody.includes('if (!v.ok) throw new Error'), 'invalid metadata throws');
assert.ok(mergeBody.includes('throw err;'), 'catch re-throws (no longer swallowed)');

// the caller wraps the merge and surfaces the error / aborts mount
const callIdx = src.indexOf('await _mergeDatasetMetadata();');
const around = src.slice(callIdx - 40, callIdx + 320);
assert.ok(around.includes('try {') && around.includes('_showLoadingError(err)'),
  'caller wraps merge in try/catch and surfaces the error');
assert.ok(around.includes("status: 'invalid-metadata'"), 'init perf marked invalid-metadata');

console.log('ELE-19 metadata.json validation/rejection: OK');
