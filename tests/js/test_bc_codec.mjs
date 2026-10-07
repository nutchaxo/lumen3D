// BC4 / BC5 block codec of the GPU-compressed display atlas (js/core/bc-codec.js):
//   • the block layout is the RGTC one (endpoints, 3-bit little-endian indices, the
//     8-level and the 6-level-plus-0-and-255 palettes) — decodeBlock reads hand-built
//     blocks as the Khronos spec defines them;
//   • uniform blocks, all-zero blocks and blocks of two values one of which is 0 or 255
//     are exact; an all-zero block is eight zero bytes (what new texture storage holds);
//   • every block's error stays within the mode's bound (max − min)/10, and the
//     least-squares refit never makes a block worse than its extremes would;
//   • encodeBox: planes per channel count, 4 × 4 blocks per z plane, edge padding by
//     clamping (never widening a block's range), byte layout of a BC5 block;
//   • a fluorescence-like volume (blobs on a background-subtracted zero floor, shot
//     noise) round-trips with a small error and keeps its zeros.
//
// Run: node tests/js/test_bc_codec.mjs
import assert from 'node:assert/strict';
import { loadModule } from './harness.mjs';

const BC = loadModule('js/core/bc-codec.js', 'BCCodec', { self: {} });

const block = (fn) => Uint8Array.from({ length: 16 }, (_, i) => fn(i));
const roundTrip = (vals) => {
  const out = new Uint8Array(8);
  const err = BC.encodeBlock(vals, out, 0);
  return { out, err, dec: BC.decodeBlock(out, 0, new Float64Array(16)) };
};
// The module runs in its own realm: compare its arrays by value.
const plain = (x) => JSON.parse(JSON.stringify(x));
const sse = (a, b) => a.reduce((s, v, i) => s + (v - b[i]) ** 2, 0);

// ── decodeBlock reads the RGTC layout ──────────────────────────────────────────
{
  // r0 > r1: 8 levels. Indices 0..7 on texels 0..7, then 7..0 on texels 8..15.
  const idx = [0, 1, 2, 3, 4, 5, 6, 7, 7, 6, 5, 4, 3, 2, 1, 0];
  let a = 0, b = 0;
  idx.forEach((k, i) => { if (i < 8) a |= k << (3 * i); else b |= k << (3 * (i - 8)); });
  const blk = Uint8Array.of(210, 70, a & 255, (a >> 8) & 255, (a >> 16) & 255, b & 255, (b >> 8) & 255, (b >> 16) & 255);
  const dec = BC.decodeBlock(blk, 0, new Float64Array(16));
  const pal8 = [210, 70, ...[2, 3, 4, 5, 6, 7].map(k => ((8 - k) * 210 + (k - 1) * 70) / 7)];
  idx.forEach((k, i) => assert.ok(Math.abs(dec[i] - pal8[k]) < 1e-9, `8-level palette, texel ${i}`));
  // r0 ≤ r1: 6 levels, index 6 = 0, index 7 = 255.
  blk[0] = 40; blk[1] = 140;
  const dec6 = BC.decodeBlock(blk, 0, new Float64Array(16));
  const pal6 = [40, 140, ...[2, 3, 4, 5].map(k => ((6 - k) * 40 + (k - 1) * 140) / 5), 0, 255];
  idx.forEach((k, i) => assert.ok(Math.abs(dec6[i] - pal6[k]) < 1e-9, `6-level palette, texel ${i}`));
  console.log('RGTC block layout: OK');
}

// ── exact cases ────────────────────────────────────────────────────────────────
{
  const z = roundTrip(block(() => 0));
  assert.deepEqual([...z.out], [0, 0, 0, 0, 0, 0, 0, 0], 'an all-zero block is eight zero bytes');
  assert.equal(z.err, 0);
  for (const v of [1, 77, 254, 255]) {
    const u = roundTrip(block(() => v));
    assert.ok(u.dec.every(d => d === v), `uniform ${v} is exact`);
  }
  const zs = roundTrip(block(i => (i % 3 ? 0 : 180)));
  assert.ok(zs.dec.every((d, i) => d === (i % 3 ? 0 : 180)), 'zeros beside one value: exact');
  const fs = roundTrip(block(i => (i % 2 ? 255 : 0)));
  assert.ok(fs.dec.every((d, i) => d === (i % 2 ? 255 : 0)), '0 and 255: exact');
  // Zeros beside a narrow signal range: mode 6 keeps every zero a zero.
  const narrow = block(i => (i < 6 ? 0 : 200 + (i % 7)));
  const n = roundTrip(narrow);
  for (let i = 0; i < 6; i++) assert.equal(n.dec[i], 0, `zero texel ${i} stays 0`);
  assert.ok(n.err <= 6 * 1, 'the signal of a narrow block is within a level');
  console.log('exact blocks: OK');
}

// ── error bounds on random blocks ─────────────────────────────────────────────
{
  let seed = 12345;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let trial = 0; trial < 20000; trial++) {
    const kind = trial % 4;
    const lo = Math.floor(rnd() * 200), span = Math.floor(rnd() * 56) + 1;
    const vals = block(() => {
      const r = rnd();
      if (kind === 1 && r < 0.4) return 0;             // background-subtracted floor
      if (kind === 2 && r < 0.1) return 255;           // saturated voxels
      if (kind === 3) return Math.floor(rnd() * 256);  // anything
      return Math.min(255, lo + Math.floor(r * span));
    });
    const { dec, err } = roundTrip(vals);
    assert.ok(Math.abs(err - sse(dec, vals)) < 1e-6, 'encodeBlock returns the real squared error');
    let mn = 255, mx = 0;
    for (const v of vals) { mn = Math.min(mn, v); mx = Math.max(mx, v); }
    // Mode 8 with its extremes alone guarantees (max − min)/14 per texel; the encoder
    // keeps the better of two candidates and refits only when the error drops.
    const bound8 = (mx - mn) / 14 + 1e-9;
    assert.ok(err <= 16 * bound8 * bound8 + 1e-6, `trial ${trial}: squared error within the 8-level bound`);
    for (let i = 0; i < 16; i++) assert.ok(Math.abs(dec[i] - vals[i]) <= (mx - mn) / 2 + 1e-9, `trial ${trial}: texel ${i} within half the range`);
  }
  console.log('error bounds (20 000 random blocks): OK');
}

// ── encodeBox: planes, padding, layout ────────────────────────────────────────
{
  assert.deepEqual(plain(BC.planesFor(1).map(p => [p.format, p.channels.join()])), [['bc4', '0']]);
  assert.deepEqual(plain(BC.planesFor(2).map(p => [p.format, p.channels.join()])), [['bc5', '0,1']]);
  assert.deepEqual(plain(BC.planesFor(3).map(p => [p.format, p.channels.join()])), [['bc5', '0,1'], ['bc4', '2']]);
  assert.deepEqual(plain(BC.planesFor(4).map(p => [p.format, p.channels.join()])), [['bc5', '0,1'], ['bc5', '2,3']]);
  assert.equal(BC.texelBytesFor(1), 0.5);
  assert.equal(BC.texelBytesFor(3), 1.5);
  assert.equal(BC.texelBytesFor(4), 2);

  // 6 × 5 × 2 box of RGBA (3 channels): padded to 8 × 8, two planes.
  const w = 6, h = 5, d = 2, comps = 4;
  const data = new Uint8Array(w * h * d * comps);
  for (let z = 0; z < d; z++) for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = ((z * h + y) * w + x) * comps;
    data[i] = 10 * x + y; data[i + 1] = 200 - 7 * y; data[i + 2] = z ? 0 : 99; data[i + 3] = 0;
  }
  const enc = BC.encodeBox(data, comps, w, h, d, 3);
  assert.equal(enc.width, 8); assert.equal(enc.height, 8); assert.equal(enc.depth, 2);
  assert.equal(enc.planes.length, 2);
  assert.equal(enc.planes[0].format, 'bc5');
  assert.equal(enc.planes[0].bytes.length, 2 * 2 * 2 * 16, 'BC5: 16 bytes per block');
  assert.equal(enc.planes[1].bytes.length, 2 * 2 * 2 * 8, 'BC4: 8 bytes per block');
  // The first BC5 block = BC4 of channel 0 over the block's 16 texels, then channel 1.
  const c0 = new Uint8Array(8), c1 = new Uint8Array(8);
  BC.encodeBlock(block(i => data[(((i >> 2) * w) + (i & 3)) * comps]), c0, 0);
  BC.encodeBlock(block(i => data[(((i >> 2) * w) + (i & 3)) * comps + 1]), c1, 0);
  assert.deepEqual([...enc.planes[0].bytes.subarray(0, 8)], [...c0], 'BC5 block: red half first');
  assert.deepEqual([...enc.planes[0].bytes.subarray(8, 16)], [...c1], 'BC5 block: green half second');
  // Padding repeats the last column / row: the block at (1, 1) of plane z = 0 holds
  // texels x 4..5 (6, 7 clamped to 5) and rows 4 (5..7 clamped to 4).
  const pad = new Uint8Array(8);
  BC.encodeBlock(block(i => data[((4 * w) + Math.min(5, 4 + (i & 3))) * comps]), pad, 0);
  const o = ((0 * 2 + 1) * 2 + 1) * 16;
  assert.deepEqual([...enc.planes[0].bytes.subarray(o, o + 8)], [...pad], 'edge padding clamps');
  const dec = BC.decodeBox(enc, comps, w, h, d);
  for (let i = 0; i < w * h * d; i++) {
    assert.ok(Math.abs(dec[i * comps] - data[i * comps]) <= 3, 'channel 0 round-trips');
    assert.equal(dec[i * comps + 2], data[i * comps + 2], 'channel 2 (uniform per plane) is exact');
    assert.equal(dec[i * comps + 3], 0, 'channel 3 absent: 0');
  }
  assert.throws(() => BC.encodeBox(new Uint8Array(10), 1, 4, 4, 4, 1), /bytes/, 'a short buffer is refused');
  console.log('encodeBox layout: OK');
}

// ── a fluorescence-like volume ────────────────────────────────────────────────
{
  const W = 64, H = 64, D = 16;
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const blobs = Array.from({ length: 25 }, () => ({ x: rnd() * W, y: rnd() * H, z: rnd() * D, r: 3 + rnd() * 5, a: 60 + rnd() * 190 }));
  const data = new Uint8Array(W * H * D);
  for (let z = 0; z < D; z++) for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let v = 0;
    for (const b of blobs) {
      const d2 = ((x - b.x) ** 2 + (y - b.y) ** 2 + ((z - b.z) * 2) ** 2) / (b.r * b.r);
      if (d2 < 9) v += b.a * Math.exp(-d2);
    }
    v += (rnd() - 0.5) * 12;
    data[(z * H + y) * W + x] = v < 8 ? 0 : Math.min(255, Math.round(v));
  }
  const dec = BC.decodeBox(BC.encodeBox(data, 1, W, H, D, 1), 1, W, H, D);
  let se = 0, zeros = 0, kept = 0, sig = 0, sigSe = 0;
  for (let i = 0; i < data.length; i++) {
    const e = dec[i] - data[i];
    se += e * e;
    if (data[i] === 0) { zeros++; if (dec[i] === 0) kept++; } else { sig++; sigSe += e * e; }
  }
  const rmseSignal = Math.sqrt(sigSe / sig);
  assert.ok(rmseSignal < 2.5, `signal RMSE ${rmseSignal.toFixed(2)} levels (< 2.5)`);
  assert.ok(kept / zeros > 0.995, `${kept} of ${zeros} background zeros stay exactly 0`);
  console.log(`fluorescence-like volume: signal RMSE ${rmseSignal.toFixed(2)}, zeros kept ${(100 * kept / zeros).toFixed(2)} %: OK`);
}

console.log('bc codec: OK');
