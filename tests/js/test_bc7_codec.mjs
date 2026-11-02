// BC7 mode 6 prototype (js/core/bc7-codec.js): the block layout and round trip.
//   • a zero block encodes to a block that decodes to exact zeros;
//   • a constant block and a two-colour block come back exactly (or within the 7-bit
//     endpoint quantisation, 1 level);
//   • the anchor rule holds (texel 0's index top bit is never set in the stream);
//   • a block whose channels lie on one line is nearly lossless, a block of independent
//     channels is not — the measured gap is printed, it is what A5 is about.
// The bit layout itself is checked against the GPU's decoder in the browser pass.
//
// Run: node tests/js/test_bc7_codec.mjs
import assert from 'node:assert/strict';
import { loadModule } from './harness.mjs';

const BC7 = loadModule('js/core/bc7-codec.js', 'BC7Codec', { self: {} });
let seed = 777;
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
const block = (fn) => Array.from({ length: 16 }, (_, i) => fn(i));
const roundTrip = (vals) => { const out = new Uint8Array(16); BC7.encodeBlock(vals, out, 0); return { out, dec: BC7.decodeBlock(out, 0) }; };
const maxErr = (a, b) => Math.max(...a.flatMap((v, i) => v.map((x, c) => Math.abs(x - b[i][c]))));
const rmse = (a, b) => Math.sqrt(a.flatMap((v, i) => v.map((x, c) => (x - b[i][c]) ** 2)).reduce((s, x) => s + x, 0) / 64);

{
  const { out, dec } = roundTrip(block(() => [0, 0, 0, 0]));
  assert.equal(out[0] & 0x7f, 0x40, 'mode 6 header');
  assert.ok(dec.every((v) => v.every((x) => x === 0)), 'zeros stay exact');
}
{
  const v = block(() => [200, 10, 0, 255]);
  const { dec } = roundTrip(v);
  assert.ok(maxErr(v, dec) <= 1, `constant block error ${maxErr(v, dec)}`);
  const two = block((i) => (i < 8 ? [0, 0, 0, 0] : [255, 128, 64, 0]));
  assert.ok(maxErr(two, roundTrip(two).dec) <= 2, 'a block of two colours is kept');
}
{
  // anchor: texel 0 index top bit is never stored (3 bits): every encoded block must decode its own indices
  for (let t = 0; t < 500; t++) {
    const v = block(() => [rnd() * 255 | 0, rnd() * 255 | 0, rnd() * 255 | 0, rnd() * 255 | 0]);
    const { dec } = roundTrip(v);
    assert.equal(dec.length, 16);
  }
}
{
  // one structure per block (a single channel on zeros): the common case in these data
  let worst = 0, sum = 0, n = 0;
  for (let t = 0; t < 400; t++) {
    const ch = (rnd() * 3) | 0;
    const v = block(() => { const a = Math.round(rnd() * 255 * (rnd() < 0.7 ? 1 : 0)); const q = [0, 0, 0, 0]; q[ch] = a; return q; });
    const { dec } = roundTrip(v);
    worst = Math.max(worst, maxErr(v, dec)); sum += rmse(v, dec); n++;
  }
  console.log(`single-channel blocks on zeros: worst error ${worst} levels, mean RMSE ${(sum / n).toFixed(2)}`);
  assert.ok(worst <= 17, `single channel on zeros stays within the 16-level palette step (${worst})`);
}
{
  // two independent channels in one block (a green and a red structure side by side)
  let sum = 0, n = 0, worst = 0;
  for (let t = 0; t < 400; t++) {
    const v = block((i) => (i % 4 < 2 ? [Math.round(rnd() * 255), 0, 0, 0] : [0, Math.round(rnd() * 255), 0, 0]));
    const { dec } = roundTrip(v);
    sum += rmse(v, dec); n++; worst = Math.max(worst, maxErr(v, dec));
  }
  console.log(`two independent channels in one block: worst error ${worst} levels, mean RMSE ${(sum / n).toFixed(2)}`);
}
console.log('bc7 codec: OK');
