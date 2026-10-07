// brick-decode-worker TAKE with `encode: {format: 'bc', …}`: the brick assembled in the
// worker (channels decoded straight into it) comes back as the BC4 / BC5 blocks of
// bc-codec.js — the very blocks BCCodec.encodeBox gives for the raw assembly — with
// the box rounded up to whole blocks; a box that does not hold the assembly's voxels
// is an error, not a wrong upload; no assembly at all encodes the zero brick.
//
// Run: node tests/js/test_brick_decode_encode.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT } from './harness.mjs';

const WORKER = readFileSync(path.join(ROOT, 'js/core/brick-decode-worker.js'), 'utf8');
const CODEC = readFileSync(path.join(ROOT, 'js/core/bc-codec.js'), 'utf8');
const tick = () => new Promise((r) => setTimeout(r, 0));

// A v3 brick mosaic: 66 slices of 66² in a 9 × 8 grid (594 × 528); the grey value of
// mosaic pixel (px, py) for channel c is a pattern the test can recompute.
const value = (c, px, py) => (px * (3 + c) + py * (5 + 2 * c)) & 255;

function makeWorker() {
  const results = [];
  let channel = 0;
  const self = { onmessage: null, postMessage: (m) => results.push(m) };
  const sandbox = {
    self, console,
    performance: { now: () => 0 },
    Blob: function () {},
    createImageBitmap: async () => ({ width: 594, height: 528, close() {} }),
    OffscreenCanvas: function (w, h) {
      this.width = w; this.height = h;
      this.getContext = () => ({
        globalCompositeOperation: '',
        drawImage() {},
        getImageData: (x, y, ww, hh) => {
          const d = new Uint8ClampedArray(ww * hh * 4);
          for (let j = 0; j < hh; j++) for (let i = 0; i < ww; i++) d[(j * ww + i) * 4] = value(channel, x + i, y + j);
          return { data: d };
        },
      });
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(CODEC, sandbox, { filename: 'bc-codec.js' });
  vm.runInContext(WORKER, sandbox, { filename: 'brick-decode-worker.js' });
  return {
    results,
    BC: self.BCCodec,
    async decode(id, key, slot, components) {
      channel = slot;
      self.onmessage({ data: { type: 'DECODE', id, batch: 1, buffer: new ArrayBuffer(4), brickSize: 66,
        packing: { mode: 'grid', cols: 9 }, expect: { width: 594, height: 528 }, assemble: { key, slot, components } } });
      for (let i = 0; i < 20; i++) await tick();
    },
    async take(id, key, voxels, components, encode) {
      self.onmessage({ data: { type: 'TAKE', id, batch: 1, key, voxels, components, ...(encode ? { encode } : {}) } });
      for (let i = 0; i < 5; i++) await tick();
      return results.find(m => m.id === id);
    },
  };
}

const V = 66 * 66 * 66;

// Raw assembly from one worker, encoded assembly from another: the blocks must match.
{
  const raw = makeWorker();
  await raw.decode(1, 'k', 0, 2);
  await raw.decode(2, 'k', 1, 2);
  const plain = await raw.take(3, 'k', V, 2, null);
  assert.ok(plain.ok && plain.buffer, 'raw assembly');
  const expected = raw.BC.encodeBox(new Uint8Array(plain.buffer), 2, 66, 66, 66, 2);

  const w = makeWorker();
  await w.decode(1, 'k', 0, 2);
  await w.decode(2, 'k', 1, 2);
  const res = await w.take(3, 'k', V, 2, { format: 'bc', channels: 2, w: 66, h: 66, d: 66 });
  assert.ok(res.ok, res.message);
  assert.equal(res.buffer, undefined, 'no raw buffer next to the blocks');
  assert.deepEqual([res.encoded.width, res.encoded.height, res.encoded.depth], [68, 68, 66], 'box rounded up to whole blocks');
  assert.equal(res.encoded.planes.length, 1);
  assert.equal(res.encoded.planes[0].format, 'bc5');
  // (Byte comparison: the two arrays come from different realms.)
  assert.equal(Buffer.compare(Buffer.from(res.encoded.planes[0].buffer), Buffer.from(expected.planes[0].bytes.buffer)), 0,
    'the worker encodes exactly what BCCodec.encodeBox gives');
  console.log('worker-side encoding = encodeBox of the assembly: OK');
}

// No channel assembled: the zero brick, all-zero blocks.
{
  const w = makeWorker();
  const res = await w.take(9, 'missing', 64 * 64 * 64, 1, { format: 'bc', channels: 1, w: 64, h: 64, d: 64 });
  assert.ok(res.ok);
  const bytes = new Uint8Array(res.encoded.planes[0].buffer);
  assert.equal(bytes.length, 16 * 16 * 64 * 8);
  assert.ok(bytes.every(b => b === 0), 'zero voxels encode to zero blocks');
  console.log('empty assembly: OK');
}

// A box that does not describe the assembly is refused.
{
  const w = makeWorker();
  const res = await w.take(5, 'x', V, 2, { format: 'bc', channels: 2, w: 64, h: 66, d: 66 });
  assert.equal(res.ok, false);
  assert.match(res.message, /does not hold/);
  console.log('mismatched box refused: OK');
}

console.log('brick decode encode: OK');
