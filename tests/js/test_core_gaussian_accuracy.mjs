// The gaussian-blur worker must realise the requested sigma: the variance of the composed
// kernel (box passes + exact residual pass) is measured on an impulse and compared with sigma^2.
// The previous 3-box scheme was a no-op below sigma ~0.58 and about 9 % short at sigma = 2.
//
// Run: node tests/js/test_core_gaussian_accuracy.mjs
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = readFileSync(path.join(ROOT, 'js/workers/gaussian-blur-worker.js'), 'utf8');
const self = { postMessage() {}, set onmessage(_) {} };
const ctx = vm.createContext({ self, console, Float32Array, Uint8Array, Math, Array });
vm.runInContext(SRC, ctx);

// Variance of the 1-D kernel the plan produces: impulse in the middle of a long row, H passes only.
const measure = vm.runInContext(`(function (sigma) {
  const w = 801, h = 1;
  let a = new Float32Array(w), b = new Float32Array(w);
  a[400] = 1;
  const plan = _planKernel(sigma);
  for (const r of plan.boxRadii) { _boxBlurH(a, b, w, h, r); const t = a; a = b; b = t; }
  if (plan.gauss) { _gaussBlurH(a, b, w, h, plan.gauss); a = b; }
  let m0 = 0, m1 = 0, m2 = 0;
  for (let i = 0; i < w; i++) { m0 += a[i]; m1 += a[i] * i; m2 += a[i] * i * i; }
  const mean = m1 / m0;
  return { mass: m0, variance: m2 / m0 - mean * mean, plan: plan.effectiveSigma, boxes: plan.boxRadii.length };
})`, ctx);

for (const sigma of [1, 1.5, 1.7, 1.8, 2, 2.5, 3, 4, 5]) {
  const r = measure(sigma);
  assert.ok(Math.abs(r.mass - 1) < 1e-4, `sigma ${sigma}: mass conserved (${r.mass})`);
  const rel = Math.abs(r.variance - sigma * sigma) / (sigma * sigma);
  // The sampled kernel truncated at 3 sigma loses a hair of variance; 3 % is far inside the old error.
  assert.ok(rel < 0.03, `sigma ${sigma}: measured variance ${r.variance.toFixed(3)} vs ${(sigma * sigma).toFixed(3)} (${(rel * 100).toFixed(1)} %)`);
  assert.ok(Math.abs(r.plan - sigma) < 1e-6, `sigma ${sigma}: planned effective sigma ${r.plan}`);
  assert.equal(r.boxes, sigma < 1.8 ? 0 : 3, `sigma ${sigma}: box passes only where they can reach the variance`);
}

// A small sigma now does something (it was the identity below ~0.58).
{
  const row = new Float32Array(9); row[4] = 100;
  const out = new Float32Array(9);
  const k = vm.runInContext('_gaussianKernel(0.6)', ctx);
  vm.runInContext('_gaussBlurH', ctx)(row, out, 9, 1, k);
  assert.ok(out[4] < 100 && out[3] > 0 && out[5] > 0, 'sigma 0.6 spreads the impulse');
}

// Every result and error message carries the chunk index the host needs.
{
  const msgs = [];
  const self2 = { _h: null, set onmessage(f) { this._h = f; }, postMessage(m) { msgs.push(m); } };
  const c2 = vm.createContext({ self: self2, console, Float32Array, Uint8Array, Math, Array, ArrayBuffer });
  vm.runInContext(SRC, c2);
  self2._h({ data: { type: 'blur', width: 2, height: 2, depth: 1, sigma: 0, taskId: 7, chunkIndex: 3, rawData: new Uint8Array(4).buffer } });
  self2._h({ data: { type: 'blur', width: 2, height: 2, depth: 1, sigma: 2, taskId: 8, chunkIndex: 5, rawData: Symbol('bad') } });
  const ok = msgs.find(m => m.type === 'result');
  const err = msgs.find(m => m.type === 'error');
  assert.equal(ok.chunkIndex, 3, 'sigma 0 branch reports its chunk');
  assert.equal(err.chunkIndex, 5, 'error reports its chunk');
}

console.log('gaussian worker accuracy (effective sigma, small sigma, chunk index): OK');
