/* Conformance run of js/core/compat.js against the shared vector (node).
   Twin of tests/test_compat.py — both must pass identically. */
'use strict';
const fs = require('fs');
const path = require('path');

const Compat = require(path.join(__dirname, '..', 'js', 'core', 'compat.js'));
const vector = JSON.parse(fs.readFileSync(path.join(__dirname, 'compat-vector.json'), 'utf-8'));

let failed = 0;
for (const c of vector.cases) {
  const { ok, reason } = Compat.satisfies(c.platform, c.decl);
  if (ok !== c.expect) {
    failed++;
    console.log(`  FAIL platform=${JSON.stringify(c.platform)} decl=${JSON.stringify(c.decl)}` +
      ` → ${ok} (expected ${c.expect}) [${c.why}] reason=${reason}`);
  }
}
if (failed) {
  console.log(`${failed}/${vector.cases.length} CASES FAILED`);
  process.exit(1);
}
console.log(`ALL ${vector.cases.length} COMPAT CASES PASSED (js)`);
