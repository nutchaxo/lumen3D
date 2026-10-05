// The 2D viewer's per-pixel maths (js/workers/pixel-ops-2d.js) and the worker that
// runs it off the main thread (js/workers/pixel-2d-worker.js).
//
// The arithmetic moved out of Viewer2D unchanged: a reference copy of the old inline
// loops checks it byte for byte on a noisy synthetic photograph. The worker is driven
// through a faked OffscreenCanvas / importScripts to check its message contract.
//
// Run: node tests/js/test_pages_pixel_ops.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { loadModule, ROOT } from './harness.mjs';

const Ops = loadModule('js/workers/pixel-ops-2d.js', 'PixelOps2D');
assert.ok(Ops, 'PixelOps2D loads without a DOM');

// ── a deterministic "photograph": a yellow tissue with a vignette and a blue stain ──
function photo(w, h, seed = 7) {
  let x = seed;
  const rnd = () => ((x = (x * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let xx = 0; xx < w; xx++) {
      const i = (y * w + xx) * 4;
      const vignette = 1 - 0.4 * Math.hypot(xx / w - 0.5, y / h - 0.5);
      const stained = Math.hypot(xx / w - 0.5, y / h - 0.5) < 0.15;
      const noise = (rnd() - 0.5) * 12;
      d[i] = (stained ? 60 : 200) * vignette + noise;
      d[i + 1] = (stained ? 90 : 170) * vignette + noise;
      d[i + 2] = (stained ? 200 : 90) * vignette + noise;
      d[i + 3] = 255;
    }
  }
  return d;
}

// Reference: the loops as they were inline in Viewer2D before the extraction.
function referenceLuts(a) {
  const unit = v => (v < 0 ? 0 : v > 1 ? 1 : v);
  const k = 1 + a.contrast / 100, br = a.brightness / 100, g = 1 / Math.max(0.1, a.gamma);
  const build = (wb) => {
    const lut = new Uint8ClampedArray(256);
    for (let v = 0; v < 256; v++) lut[v] = Math.round(Math.pow(unit(((v / 255) * wb - 0.5) * k + 0.5 + br), g) * 255);
    return lut;
  };
  return { r: build(a.wbRed), g: build(1), b: build(a.wbBlue) };
}

const W = 96, H = 64;
const sampleOf = (src) => (sw, sh) => {
  // Box average to sw x sh: the same contract as drawImage(img, 0, 0, sw, sh).
  const out = new Uint8ClampedArray(sw * sh * 4);
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      const sx = Math.min(W - 1, Math.floor(x * W / sw)), sy = Math.min(H - 1, Math.floor(y * H / sh));
      for (let c = 0; c < 4; c++) out[(y * sw + x) * 4 + c] = src[(sy * W + sx) * 4 + c];
    }
  }
  return out;
};

// ── adjustments: the defaults are the identity, the curve matches the formula ──
{
  const src = photo(W, H);
  const frame = Uint8ClampedArray.from(src);
  Ops.run({ kind: 'adjust', adjust: { brightness: 0, contrast: 0, gamma: 1, wbRed: 1, wbBlue: 1, flatten: false } }, frame, W, H, sampleOf(src), {});
  assert.deepEqual(Array.from(frame), Array.from(src), 'default adjustments leave every byte alone');

  const adjust = { brightness: 12, contrast: 30, gamma: 1.4, wbRed: 1.1, wbBlue: 0.9, flatten: false };
  const out = Uint8ClampedArray.from(src);
  Ops.run({ kind: 'adjust', adjust }, out, W, H, sampleOf(src), {});
  const lut = referenceLuts(adjust);
  for (let i = 0; i < src.length; i += 4) {
    assert.equal(out[i], lut.r[src[i]]);
    assert.equal(out[i + 1], lut.g[src[i + 1]]);
    assert.equal(out[i + 2], lut.b[src[i + 2]]);
    assert.equal(out[i + 3], 255, 'alpha is untouched');
  }
}

// ── flatten: a vignetted flat field comes out flatter, and the maps are cached per image ──
{
  const w = 128, h = 128;
  const src = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const v = 220 * (1 - 0.45 * Math.hypot(x / w - 0.5, y / h - 0.5) * 2);
    const i = (y * w + x) * 4;
    src[i] = v; src[i + 1] = v; src[i + 2] = v; src[i + 3] = 255;
  }
  const spread = (d) => {
    const centre = d[(h / 2 * w + w / 2) * 4], corner = d[0];
    return Math.abs(centre - corner);
  };
  const flatSample = (sw, sh) => {
    const out = new Uint8ClampedArray(sw * sh * 4);
    for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
      const i = (Math.floor(y * h / sh) * w + Math.floor(x * w / sw)) * 4, o = (y * sw + x) * 4;
      out[o] = src[i]; out[o + 1] = src[i + 1]; out[o + 2] = src[i + 2]; out[o + 3] = 255;
    }
    return out;
  };
  let sampled = 0;
  const counting = (sw, sh) => { sampled++; return flatSample(sw, sh); };
  const cache = {};
  const flat = Uint8ClampedArray.from(src);
  const job = { kind: 'adjust', adjust: { brightness: 0, contrast: 0, gamma: 1, wbRed: 1, wbBlue: 1, flatten: true } };
  Ops.run(job, flat, w, h, counting, cache);
  assert.ok(spread(flat) < spread(src) * 0.5, `flatten levels the vignette (${spread(src)} -> ${spread(flat)})`);
  const again = Uint8ClampedArray.from(src);
  Ops.run({ kind: 'adjust', adjust: { ...job.adjust, gamma: 1.5 } }, again, w, h, counting, cache);
  assert.equal(sampled, 1, 'a second job on the same image reuses the illumination map');
}

// ── isolation: stain in yellow tissue lights up cyan, bare background stays grey ──
{
  const src = photo(W, H);
  const frame = Uint8ClampedArray.from(src);
  Ops.run({ kind: 'isolate' }, frame, W, H, sampleOf(src), {});
  const at = (x, y) => (y * W + x) * 4;
  const core = at(W / 2, H / 2), tissue = at(4, 4);
  assert.ok(frame[core + 2] > frame[core] + 100, 'the stained core is cyan/blue');
  assert.ok(Math.abs(frame[tissue + 2] - frame[tissue]) < 8, 'unstained tissue is neutral grey');
  assert.ok(frame[tissue] < src[tissue], 'the specimen is dimmed');
}

// ── the worker: message in, processed bitmap out, errors reported not thrown ──
{
  class FakeOffscreen {
    constructor(w, h) { this.width = w; this.height = h; this.data = new Uint8ClampedArray(w * h * 4); }
    getContext() {
      const self = this;
      return {
        drawImage(src, sx, sy, sw, sh) {
          if (src.data && sw === undefined) self.data.set(src.data.subarray(0, self.data.length));
          else if (src.data) {
            // downscale sample
            for (let y = 0; y < self.height; y++) for (let x = 0; x < self.width; x++) {
              const si = (Math.floor(y * src.height / self.height) * src.width + Math.floor(x * src.width / self.width)) * 4;
              self.data.set(src.data.subarray(si, si + 4), (y * self.width + x) * 4);
            }
          }
        },
        getImageData() { return { data: Uint8ClampedArray.from(self.data), width: self.width, height: self.height }; },
        putImageData(frame) { self.data.set(frame.data); }
      };
    }
    transferToImageBitmap() { return { width: this.width, height: this.height, data: this.data, close() {} }; }
  }
  const posted = [];
  const sandbox = {
    console, OffscreenCanvas: FakeOffscreen, String,
    importScripts: () => vm.runInContext(readFileSync(path.join(ROOT, 'js/workers/pixel-ops-2d.js'), 'utf8'), ctx),
    postMessage: (msg, transfer) => posted.push({ msg, transfer })
  };
  sandbox.self = sandbox;
  const ctx = vm.createContext(sandbox);
  vm.runInContext(readFileSync(path.join(ROOT, 'js/workers/pixel-2d-worker.js'), 'utf8'), ctx);

  const src = photo(8, 8);
  const closed = [];
  const bitmap = { width: 8, height: 8, data: Uint8ClampedArray.from(src), close() { closed.push(1); } };
  const adjust = { brightness: 10, contrast: 0, gamma: 1, wbRed: 1, wbBlue: 1, flatten: false };
  sandbox.onmessage({ data: { id: 5, imageId: 1, job: { kind: 'adjust', adjust }, bitmap } });
  assert.equal(posted.length, 1);
  assert.equal(posted[0].msg.id, 5);
  assert.equal(posted[0].transfer[0], posted[0].msg.bitmap, 'the result bitmap is transferred');
  assert.equal(closed.length, 1, 'the input bitmap is released');
  const lut = referenceLuts(adjust);
  assert.equal(posted[0].msg.bitmap.data[0], lut.r[src[0]], 'the worker applies the look-up');

  sandbox.onmessage({ data: { id: 6, imageId: 1, job: { kind: 'nope' }, bitmap: { width: 8, height: 8, data: Uint8ClampedArray.from(src), close() {} } } });
  assert.ok(posted[1].msg.error || posted[1].msg.bitmap, 'an unknown job answers, it does not hang');
}

console.log('2D pixel ops + worker: OK');
