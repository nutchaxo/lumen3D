// Skeletonize checks for cancellation at least every 0x4000 entries of each list walk (no ~160 ms gap on a noisy mask),
// ticks stay monotonic, and the result is unchanged by the checks (with and without a controller).
// Run: node tests/js/test_ij_seg_skeleton_ticks.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { DIR } from './ij_harness.mjs';

const sandbox = { console, setTimeout, clearTimeout };
sandbox.self = sandbox;
vm.createContext(sandbox);
for (const f of ['ij-core.js', 'ij-analysis.js', 'ij-proc-shared.js', 'ij-proc-seg.js']) vm.runInContext(fs.readFileSync(path.join(DIR, f), 'utf8'), sandbox, { filename: f });
const { IJSeg } = sandbox;

function noise(w, h, p, seed) {
  let s = seed >>> 0; const m = new Uint8Array(w * h);
  for (let i = 0; i < m.length; i++) { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; m[i] = (s >>> 8) / 16777216 < p ? 255 : 0; }
  return m;
}
for (const [p, name] of [[0.8, 'rand80'], [0.5, 'rand50']]) {
  const w = 700, h = 700, mask = noise(w, h, p, 7);
  let ticks = 0, last = -1, mono = true;
  const out = await IJSeg.skeletonize(mask, w, h, 255, { tick: async (f) => { ticks++; if (f < last) mono = false; last = f; }, check() {} });
  const plain = await IJSeg.skeletonize(mask, w, h, 255, null);
  assert.deepEqual(Buffer.from(out), Buffer.from(plain), name + ': ticks do not change the result');
  let fg = 0, kept = 0;
  for (let i = 0; i < mask.length; i++) { if (mask[i]) fg++; if (out[i]) kept++; }
  const removed = fg - kept;
  // the apply loop alone visits every removal once: one tick per 0x4000 of them, on top of the scans
  assert.ok(ticks >= Math.floor(removed / 0x4000), `${name}: ${ticks} ticks for ${removed} removals`);
  assert.ok(mono, name + ': progress is monotonic');
  console.log(`  ok  ${name}: ${ticks} ticks, ${removed} removals`);
}
console.log('test_ij_seg_skeleton_ticks: ok');
