// Subtract Background (sliding paraboloid): a cancel check must run at least every 32 rows, presmooth included, and the
// progress must be monotone and reach the passes. Values are pinned by test_ij_bg_parabola / test_ij_bg_fixtures.
// Run: node tests/js/test_ij_bg_cancel.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT } from './harness.mjs';

const DIR = path.join(ROOT, 'js', 'modules', 'studio', 'advanced-studio');
const s = { console, setTimeout, clearTimeout, MessageChannel, performance, TextEncoder, TextDecoder };
s.self = s; vm.createContext(s);
for (const f of ['ij-core.js', 'ij-analysis.js', 'ij-proc-shared.js', 'ij-engine.js', 'ij-proc-bg.js']) vm.runInContext(fs.readFileSync(path.join(DIR, f), 'utf8'), s, { filename: f });
const { IJBg } = s;

const w = 400, h = 300;
const data = new Float32Array(w * h);
for (let i = 0; i < data.length; i++) data[i] = (i * 2654435761 >>> 24) & 255;

for (const presmooth of [true, false]) {
  let checks = 0, ticks = [];
  const hooks = { check() { checks++; }, tick: async (f) => { ticks.push(f); } };
  await IJBg.background(data, w, h, { radius: 20, invert: false, presmooth, sliding: true, correctCorners: true }, hooks);
  // presmooth: 2 filters x 2 passes x ceil(300/32) = 40 checks, plus one before the corners and the passes' own.
  assert.ok(checks >= (presmooth ? 40 : 0) + 9, 'cancel checks: ' + checks);
  for (let i = 1; i < ticks.length; i++) assert.ok(ticks[i] >= ticks[i - 1] - 1e-12, 'progress monotone');
  assert.ok(ticks.every((f) => f >= 0 && f <= 1));
}
// A cancel thrown inside the 3x3 filters stops the run before the passes.
let n = 0;
await assert.rejects(IJBg.background(data, w, h, { radius: 20, invert: false, presmooth: true, sliding: true, correctCorners: true },
  { check() { if (++n === 3) throw Object.assign(new Error('c'), { code: 'CANCELLED' }); }, tick: async () => {} }), /c/);
assert.equal(n, 3);
console.log('ok test_ij_bg_cancel');
