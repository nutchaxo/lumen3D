// Stacks and RGB, the sweep of every operation (DOCS/studio-advanced/stacks/SWEEP.md, agent F):
//   * every operation the packages of the sweep and the engine's own define says `stack` AND `rgb` in its definition (not left to the registry's defaults);
//   * the registry values are the ones SWEEP.md tabulates (the table is the contract with ImageJ's flags: DOES_STACKS / IJ.setupDialog / DOES_RGB);
//   * every operation of a package that is not part of the sweep (multi, edit, io, lib, stk) is listed with the value it has.
//
// Run: node tests/js/test_ij_stk_sweep_registry.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { DIR, PKGS } from './ij_sweep_lib.mjs';
import { ROOT } from './harness.mjs';

const sandbox = { console, setTimeout, clearTimeout, MessageChannel, performance, TextEncoder, TextDecoder };
sandbox.self = sandbox;
vm.createContext(sandbox);
const load = (f) => vm.runInContext(fs.readFileSync(path.join(DIR, f), 'utf8'), sandbox, { filename: f });
for (const f of ['ij-core.js', 'ij-analysis.js', 'ij-proc-shared.js']) load(f);
const R = sandbox.IJOpRegistry;
const explicit = new Map(), pkgOf = new Map();
const origDefine = R.define;
let current = 'engine';
R.define = function (name, spec) {
  explicit.set(name, { stack: Object.prototype.hasOwnProperty.call(spec, 'stack'), rgb: Object.prototype.hasOwnProperty.call(spec, 'rgb') });
  pkgOf.set(name, current);
  return origDefine.call(R, name, spec);
};
for (const p of PKGS) { const f = 'ij-proc-' + p + '.js'; if (fs.existsSync(path.join(DIR, f))) { current = p; load(f); } }
current = 'engine';
load('ij-engine.js');

const SWEPT = new Set(['bg', 'filters', 'seg', 'geom', 'roi', 'coloc', 'thr', 'enh', 'fft', 'sel', 'ov', 'ana', 'fiji', 'engine']);
const ops = Array.from(R.list());
let passed = 0;
const test = (name, fn) => { try { fn(); passed++; console.log('  ok  ' + name); } catch (e) { console.error('FAIL ' + name); throw e; } };

test('every operation was seen by the recorder', () => {
  const unseen = ops.filter((n) => !explicit.has(n));
  assert.deepEqual(unseen, [], 'defined without going through IJOpRegistry.define: ' + unseen.join(', '));
});

test('the operations of the swept packages and the engine write `stack` and `rgb` themselves', () => {
  const missing = [];
  for (const n of ops) {
    if (!SWEPT.has(pkgOf.get(n))) continue;
    const e = explicit.get(n);
    if (!e.stack || !e.rgb) missing.push(n + '(' + pkgOf.get(n) + (e.stack ? '' : ' stack') + (e.rgb ? '' : ' rgb') + ')');
  }
  assert.deepEqual(missing, [], 'left to the defaults: ' + missing.join(', '));
});

// ── SWEEP.md ──
const doc = fs.readFileSync(path.join(ROOT, 'DOCS', 'studio-advanced', 'stacks', 'SWEEP.md'), 'utf8');
const rows = new Map();
for (const line of doc.split('\n')) {
  const m = /^\| `(\w+)` \| (\w+) \| (\w+) \| `(\w+)` \| `(\w+)` \|/.exec(line);
  if (m) rows.set(m[1], { pkg: m[2], kind: m[3], stack: m[4], rgb: m[5] });
}

test('SWEEP.md lists the operations, with the kind, stack and rgb the registry has', () => {
  assert.ok(rows.size > 80, 'the table was read (' + rows.size + ' rows)');
  const wrong = [], absent = [];
  for (const n of ops) {
    const row = rows.get(n), sp = R.get(n);
    if (!row) { if (SWEPT.has(pkgOf.get(n))) absent.push(n); continue; }
    const rgb = sp.rgb === false ? 'false' : sp.rgb;
    if (row.kind !== sp.kind || row.stack !== sp.stack || row.rgb !== rgb) wrong.push(`${n}: SWEEP.md ${row.kind}/${row.stack}/${row.rgb}, registry ${sp.kind}/${sp.stack}/${rgb}`);
  }
  assert.deepEqual(absent, [], 'not in SWEEP.md: ' + absent.join(', '));
  assert.deepEqual(wrong, [], wrong.join('\n'));
});

test('the values follow ImageJ: grey / binary-only operations refuse RGB, filters work per colour, measurements read the luminance', () => {
  const rgbOf = (n) => R.get(n).rgb;
  for (const n of ['edm', 'watershed', 'voronoi', 'ultimatePoints', 'skeletonize', 'segOutline', 'binary', 'binaryMedian', 'saltAndPepper', 'autoThreshold', 'autoLocalThreshold', 'coloc', 'analyzeSkeleton', 'fractalBoxCount']) assert.equal(rgbOf(n), false, n);
  for (const n of ['invert', 'math', 'math2', 'gaussian', 'rank', 'unsharpMask', 'convolve', 'filter3x3', 'rotate', 'translate', 'scaleInPlace', 'scaleNew', 'resize', 'bin', 'canvasSize', 'flipH', 'flipV', 'crop', 'rotate90', 'addNoise']) assert.equal(rgbOf(n), 'each', n);
  for (const n of ['findMaxima', 'fft', 'createMask', 'wand', 'saturatedRange']) assert.equal(rgbOf(n), 'gray', n);
  for (const n of ['invert', 'math', 'gaussian', 'rank', 'rotate', 'translate', 'binary', 'edm', 'unsharpMask', 'subtractBackground', 'flipH', 'scaleInPlace']) assert.equal(R.get(n).stack, 'ask', n);
  for (const n of ['crop', 'rotate90', 'canvasSize', 'rotateEnlarge', 'resize', 'convert']) assert.equal(R.get(n).stack, 'all', n);
  for (const n of ['bin', 'stackToMask', 'stackToMaskNew', 'particleImage', 'scaleNew', 'imageCalculator']) assert.equal(R.get(n).stack, 'whole', n);
  for (const n of ['findMaxima', 'fft', 'coloc', 'directionality']) assert.equal(R.get(n).stack, 'plane', n);
});

console.log('ij stk sweep registry: ' + passed + ' groups passed, ' + ops.length + ' operations (' + rows.size + ' in SWEEP.md)');
