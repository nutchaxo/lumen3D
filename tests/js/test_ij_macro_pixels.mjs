// The image-model built-ins of the Advanced Studio macros (js/modules/studio/advanced-studio/ij-proc-macro.js) against ImageJ 1.54p:
// every case of tests/fixtures/ij-macro/runtime/<group>/<case>.ijm is run through the REAL worker runtime (engine + language + package
// `macro`, a scripted page) and must print exactly what the real jar printed (tests/fixtures/ij-macro/runtime-golden.json, written by
// tools/ij_fixtures/macro/run_runtime.sh): pixel reads and writes with ImageJ's clamping / rounding / wrapping per bit depth, RGB packing
// (alpha included), interpolation, getStatistics / getRawStatistics / getHistogram, fills and draws (line widths, ovals, flood fill),
// changeValues, colours through the LUT, ranges, stacks and labels, newImage fills, Results, selections, thresholds, calibration.
// An error case must stop with ImageJ's message on ImageJ's line.
//
// Run: node tests/js/test_ij_macro_pixels.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './harness.mjs';
import { rt } from './ij_macro_rt_support.mjs';

const FIX = path.join(ROOT, 'tests', 'fixtures', 'ij-macro');
const GOLDEN = path.join(FIX, 'runtime-golden.json');
if (!fs.existsSync(GOLDEN)) { console.log('SKIP test_ij_macro_pixels: tests/fixtures/ij-macro/runtime-golden.json is absent'); process.exit(0); }
const golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
const only = process.argv[2] || null;

let failures = 0, passed = 0;
const t = await rt();
for (const key of Object.keys(golden).sort()) {
  if (only && key.indexOf(only) < 0) continue;
  const src = fs.readFileSync(path.join(FIX, 'runtime', key + '.ijm'), 'utf8');
  // every case starts on an empty page: close what the previous one left
  for (const im of t.page.images.slice()) { try { await t.ok('doc.close', { docId: im.docId, discard: true }); } catch (_) { /* gone */ } }
  t.page.images = []; t.page.current = null; t.page.selections = {}; t.page.thresholds = {};
  t.page.tables = { Results: { name: 'Results', size: 0, headings: [], columns: {}, labels: null, rev: 1 } };
  t.page.log.length = 0;
  const r = await t.run(src);
  const g = golden[key];
  try {
    assert.ok(r.result, key + ': macro.run failed ' + JSON.stringify(r.error));
    assert.deepEqual(r.log, g.log, key + ': log');
    if (g.error) {
      assert.ok(r.result.error, key + ': ImageJ stopped with "' + g.error.message + '"');
      assert.equal(r.result.error.message, g.error.message, key + ': error text');
      assert.equal(r.result.error.line, g.error.line, key + ': error line');
    } else assert.equal(r.result.error, null, key + ': unexpected error ' + JSON.stringify(r.result.error));
    passed++;
  } catch (err) {
    failures++;
    console.log('FAIL ' + err.message);
    if (err.actual !== undefined && Array.isArray(err.actual)) {
      const a = err.actual, e = err.expected;
      for (let i = 0; i < Math.max(a.length, e.length); i++) if (a[i] !== e[i]) console.log('   line ' + i + ': got ' + JSON.stringify(a[i]) + ' want ' + JSON.stringify(e[i]));
    }
  }
}
t.close();
console.log(passed + ' passed, ' + failures + ' failed');
if (failures) process.exit(1);
console.log('test_ij_macro_pixels: ok');
