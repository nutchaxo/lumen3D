// Unit test for BUG-014: the gaussian-blur worker's 3-pass running box blur
// overran the row/column when the box radius r >= width/2 (resp. height/2),
// which a large sigma on a narrow (e.g. 64-wide or smaller) channel slice
// triggers. The fix clamps the effective radius per axis. We drive the worker's
// onmessage directly in a vm context (no browser) and assert it neither throws
// nor produces out-of-range / non-finite output.
//
// Run: node tests/js/test_gaussian_blur_bounds.mjs
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = readFileSync(path.join(ROOT, 'js/workers/gaussian-blur-worker.js'), 'utf8');

function runBlur({ width, height, depth, sigma, rawData }) {
  let result = null, error = null;
  const self = {
    _h: null,
    set onmessage(fn) { this._h = fn; },
    get onmessage() { return this._h; },
    postMessage(m) { if (m && m.type === 'result') result = m; if (m && m.type === 'error') error = m; },
  };
  const ctx = vm.createContext({ self, console, Uint8Array, Float32Array, Math, Array, ArrayBuffer });
  vm.runInContext(SRC, ctx, { filename: 'gaussian-blur-worker.js' });
  self._h({ data: { type: 'blur', width, height, depth, sigma, taskId: 1, rawData: rawData.buffer } });
  return { result, error };
}

function bounded(arr) {
  for (let i = 0; i < arr.length; i++) {
    if (!Number.isFinite(arr[i]) || arr[i] < 0 || arr[i] > 255) return false;
  }
  return true;
}

// ── BUG-014: very large sigma on a tiny slice (r >> w/2 and h==1) ──
{
  const raw = new Uint8Array([10, 200, 30, 240]); // w=4, h=1
  const { result, error } = runBlur({ width: 4, height: 1, depth: 1, sigma: 30, rawData: raw });
  assert.equal(error, null, 'BUG-014: huge sigma on a 4x1 slice must not error');
  assert.ok(result && result.blurredData, 'a result was produced');
  assert.equal(result.blurredData.length, 4, 'output length matches input');
  assert.ok(bounded(result.blurredData), 'BUG-014: every output byte is finite and within [0,255]');
}

// ── BUG-014: large sigma on a narrow 64-wide single-row strip (r >= w/2) ──
{
  const w = 64, h = 1;
  const raw = new Uint8Array(w * h);
  for (let i = 0; i < raw.length; i++) raw[i] = (i * 37) % 256;
  const { result, error } = runBlur({ width: w, height: h, depth: 1, sigma: 40, rawData: raw });
  assert.equal(error, null, 'BUG-014: sigma=40 on 64x1 must not error');
  assert.ok(bounded(result.blurredData), 'BUG-014: 64x1 large-radius output stays in [0,255]');
}

// ── Regression: a normal sigma on a normal slice still blurs and stays bounded ──
{
  const w = 8, h = 8;
  const raw = new Uint8Array(w * h);
  raw[w * 4 + 4] = 255; // single bright voxel
  const { result, error } = runBlur({ width: w, height: h, depth: 1, sigma: 1.5, rawData: raw });
  assert.equal(error, null, 'normal blur must not error');
  assert.ok(bounded(result.blurredData), 'normal blur output bounded');
  // the bright voxel must have spread to neighbours (center reduced, neighbour > 0)
  assert.ok(result.blurredData[w * 4 + 4] < 255, 'center voxel diffused');
  assert.ok(result.blurredData[w * 4 + 5] > 0, 'neighbour received energy');
}

// ── Structural: per-axis radius clamp present in both helpers ──
assert.ok(/r > \(\(w - 1\) >> 1\)/.test(SRC), 'BUG-014: horizontal radius clamped to row width');
assert.ok(/r > \(\(h - 1\) >> 1\)/.test(SRC), 'BUG-014: vertical radius clamped to column height');

console.log('BUG-014 gaussian blur radius bounds: OK');
