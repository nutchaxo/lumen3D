// Regression: the sliding paraboloid's early-skip estimate must send non-finite / backward-jump candidates to the
// exact float path, so these 32-bit images give ImageJ 1.54p's values (the unoptimised port's, recorded here).
// Run: node tests/js/test_ij_bg_regress.mjs
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
const opt = { radius: 1, invert: false, presmooth: false, sliding: true, correctCorners: false };
const run = async (w, h, a) => Array.from(await IJBg.background(new Float32Array(a), w, h, opt, null));
const F = (x) => Math.fround(x);

// (a) v2 - v1 < -FLOAT_MAX: the float difference is -Infinity
const A = [3.4e38, 0, -2e38];
assert.deepEqual(await run(3, 3, [...A, ...A, ...A]),
  [F(3.4e38), -Infinity, F(-2e38), F(3.4e38), -Infinity, F(-2e38), F(3.4e38), -Infinity, F(-2e38)]);
// (b) a backward nextPoint jump after the i2 <= i1 fallback
const r = await run(5, 1, [0, -Infinity, -5, -0, 0]);
assert.deepEqual(r.map((v) => (Object.is(v, -0) ? 0 : v)), [0, -Infinity, -5, 0, 0]);
console.log('test_ij_bg_regress OK');
