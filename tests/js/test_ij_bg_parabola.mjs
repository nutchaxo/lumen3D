// The sliding paraboloid's fast line (candidate lists, branch-free candidate scan, reciprocal division) must give
// ImageJ 1.54p's values bit for bit. The expected hashes were produced by the plain port of
// BackgroundSubtracter.lineSlideParabola / filter1D (the code before the performance pass), over images that exercise
// every pass (rows, columns, four diagonals), the corner correction, NaN / infinite data (the i2 <= i1 fallback),
// subnormal values (the division path) and 1 x N / N x 1 / tiny shapes.
// Run: node tests/js/test_ij_bg_parabola.mjs
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
const F = Math.fround;
const hooks = { check() {}, tick: async () => {} };

let seed = 12345;
const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
function image(kind, w, h) {
  const a = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    switch (kind) {
      case 'noise8': a[i] = Math.floor(rnd() * 256); break;
      case 'noise16': a[i] = Math.floor(rnd() * 65536); break;
      case 'float': a[i] = F((rnd() - 0.5) * 1000); break;
      case 'special': { const sp = [NaN, Infinity, -Infinity, 0, -0, 3.4e38, -3.4e38, 1e-40, 5]; a[i] = rnd() < 0.1 ? sp[Math.floor(rnd() * sp.length)] : F(rnd() * 100); } break;
      case 'tiny': a[i] = rnd() < 0.5 ? F(rnd() * 1e-38) : F(rnd() * 1e-30); break;
      case 'checker': a[i] = ((x + y) & 1) ? 255 : 0; break;
      case 'blob': { const dx = x - w / 2, dy = y - h / 2; a[i] = dx * dx + dy * dy < (Math.min(w, h) * 0.3) ** 2 ? 200 : 10; } break;
      case 'smooth': a[i] = Math.round(20 + 40 * Math.exp(-4 * (((x - w / 2) / w) ** 2 + ((y - h / 2) / h) ** 2)) + rnd() * 3); break;
      case 'ramp': a[i] = x * 3 + y * 2; break;
      default: a[i] = 0;
    }
  }
  return a;
}
function hash(a) { // FNV-1a over the 32-bit patterns, every NaN as one pattern
  const u = new Uint32Array(a.buffer, a.byteOffset, a.length);
  let h = 0x811c9dc5;
  for (let i = 0; i < u.length; i++) { const v = a[i] !== a[i] ? 0x7fc00000 : u[i]; h = Math.imul(h ^ v, 0x01000193) >>> 0; }
  return h.toString(16);
}
const cases = [];
for (const [w, h] of [[1, 9], [9, 1], [3, 3], [4, 5], [17, 23], [64, 41], [130, 77]])
  for (const kind of ['noise8', 'noise16', 'float', 'special', 'tiny', 'checker', 'blob', 'smooth', 'ramp'])
    for (const [radius, invert, presmooth, cc] of [[1, false, false, true], [5, true, true, true], [50, false, true, false], [2.5, false, false, false]])
      cases.push({ w, h, kind, opt: { radius, invert, presmooth, sliding: true, correctCorners: cc } });
const out = [];
for (const c of cases) {
  const r = await IJBg.background(image(c.kind, c.w, c.h), c.w, c.h, c.opt, hooks);
  out.push(hash(r));
}
let all = 0x811c9dc5;
for (const h of out) for (let i = 0; i < h.length; i++) all = Math.imul(all ^ h.charCodeAt(i), 0x01000193) >>> 0;
const EXPECTED = '6500fa7a';
console.log('cases', cases.length, 'digest', all.toString(16));
assert.equal(all.toString(16), EXPECTED);
console.log('test_ij_bg_parabola OK');
