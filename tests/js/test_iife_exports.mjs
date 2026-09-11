/* Loads the classic-script singletons that can be evaluated without a real DOM
   and checks that every member of the object each IIFE returns resolves to a
   function. `node --check` only parses: a helper deleted by a bad edit leaves
   the file syntactically valid, and the ReferenceError only fires when the
   IIFE runs in the browser — at which point the whole page is dead
   (the 2D viewer, v1.49.0). Run: node tests/js/test_iife_exports.mjs */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const FILES = [
  ['js/viewers/2d-viewer.js', 'Viewer2D'],
  ['js/pages/2d.js', 'App2D'],
  ['js/core/measurement-store.js', 'MeasurementStore'],
  ['js/core/compat.js', 'Compat'],
];

const stubDocument = { addEventListener() {}, createElement() { return { getContext() { return {}; }, style: {} }; }, getElementById() { return null; }, querySelector() { return null; } };

let failures = 0;
for (const [path, name] of FILES) {
  const ctx = {
    document: stubDocument, console, requestAnimationFrame() {}, cancelAnimationFrame() {},
    ResizeObserver: class {}, Image: class {}, localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    fetch() { return Promise.reject(new Error('no network')); }, crypto: {}, performance: { now() { return 0; } },
    setTimeout, clearTimeout, Math, Number, Float32Array, Float64Array, Uint8ClampedArray, Array, Object, Boolean, String, JSON, Date, Promise, Map, Set, Error, TypeError, RegExp,
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  try {
    vm.runInContext(readFileSync(path, 'utf8') + `\nthis.__exported = ${name};`, ctx, { filename: path });
    const obj = ctx.__exported;
    const bad = Object.entries(obj).filter(([, v]) => v === undefined).map(([k]) => k);
    if (bad.length) { failures++; console.log(`  FAIL ${path}: undefined exports ${bad.join(', ')}`); }
    else console.log(`  ok   ${path}: ${Object.keys(obj).length} exports resolve`);
  } catch (err) {
    failures++;
    console.log(`  FAIL ${path}: ${err.message}`);
  }
}
console.log(failures ? `${failures} FAILURE(S)` : 'ALL PASS');
process.exit(failures ? 1 : 0);
