// Unit test for ELE-25 / BUG-004: when a grid-packed brick omits `packing.cols`,
// the decode worker must derive the real mosaic width (8x8 for bs=64), not the
// magic default 16 (which silently mis-placed every Z slice).
//
// Run: node tests/js/test_brick_decode_cols.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = readFileSync(path.join(ROOT, 'js/core/brick-decode-worker.js'), 'utf8');
const tick = () => new Promise((r) => setTimeout(r, 0));

// 512x512 RGBA mosaic where R at pixel (px,py) = (tileRow*8 + tileCol) & 0xFF,
// tileCol = floor(px/64), tileRow = floor(py/64). So an 8-wide mosaic encodes
// the tile (== Z slice) index in the red channel.
function makeWorker() {
  const results = [];
  let pending = null;
  const self = { onmessage: null, postMessage: (m) => results.push(m) };
  const sandbox = {
    self, console,
    performance: { now: () => 0 },
    Blob: function () {},
    createImageBitmap: () => new Promise((res) => { pending = res; }),
    OffscreenCanvas: function (w, h) {
      this.width = w; this.height = h;
      this.getContext = () => ({
        globalCompositeOperation: '', drawImage() {},
        getImageData: (x, y, ww, hh) => {
          const data = new Uint8ClampedArray(ww * hh * 4);
          for (let py = 0; py < hh; py++) {
            for (let px = 0; px < ww; px++) {
              const tileCol = Math.floor(px / 64);
              const tileRow = Math.floor(py / 64);
              data[(py * ww + px) * 4] = (tileRow * 8 + tileCol) & 0xFF;
            }
          }
          return { data };
        },
      });
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: 'brick-decode-worker.js' });
  return {
    send: (m) => self.onmessage({ data: m }),
    resolveBmp: () => pending && pending({ width: 512, height: 512 }),
    results,
  };
}

const w = makeWorker();
w.send({ type: 'DECODE', id: 1, buffer: new ArrayBuffer(0), brickSize: 64, packing: { mode: 'grid' } }); // no cols -> derive 8
await tick();
w.resolveBmp();
await tick(); await tick();

const r = w.results.find((m) => m.type === 'DECODE_RESULT' && m.id === 1);
assert.ok(r && r.ok, 'decode succeeded');
const buf = new Uint8Array(r.buffer);
// With the correct derived cols=8, Z-slice 8 maps to mosaic tile (col0,row1) => R=8.
// With the old default 16, that voxel resolves to an out-of-row tile => 0.
assert.equal(buf[8 * 64 * 64], 8, 'derived cols=8 places Z-slice 8 at the correct tile');
assert.equal(buf[0], 0, 'Z=0 -> tile (0,0)');
assert.equal(buf[1 * 64 * 64], 1, 'Z=1 -> tile (1,0)');

console.log('ELE-25 decode-worker grid cols default: OK');
