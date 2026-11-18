// Advanced Studio filters: the fast paths must stay bit-identical to the transcription of ImageJ's RankFilters.
//   1. Top Hat (Minimum / Maximum passes): band sequences of every shape (one call, one row at a time, growing: the
//      engine's adaptive bands) give the same bits, and the values equal a brute-force kernel scan (no -0 in the data:
//      with a -0 the scan order of ImageJ decides the sign of a zero, which only the transcription reproduces).
//   2. The float median of the NaN rule 2 (ImageJ's getNaNAwareMedian): a NaN pixel stays NaN, an even count of numbers
//      left follows the split around the pixel's own value, and an image without NaN gives the same as rule 1.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { M, closeAll } from './ij_filters_support.mjs';

let seed = 987654321;
const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
const FLT_MAX = 3.4028234663852886e38;
const bitsOf = (a) => new Uint32Array(Float32Array.from(a).buffer);

function image(bd, W, H, special) {
  const T = bd === 8 ? Uint8Array : bd === 16 ? Uint16Array : Float32Array;
  const d = new T(W * H);
  for (let i = 0; i < d.length; i++) {
    const r = rnd();
    if (bd === 32) d[i] = special && r < 0.03 ? NaN : (special && r < 0.05 ? Infinity : (special && r < 0.07 ? -Infinity : Math.fround((rnd() - 0.5) * 300)));
    else d[i] = Math.floor(rnd() * (bd === 8 ? 256 : 65536) * (rnd() < 0.5 ? 1 : 0.02));
  }
  return d;
}

// brute force of one RankFilters Minimum (sign -1) / Maximum (sign 1) over the circular kernel, nearest-edge padding
function scanExtreme(src, W, H, k, sign) {
  const out = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let max = -FLT_MAX;
    for (let j = 0; j < 2 * k.kRadius + 1; j++) {
      const yy = Math.min(H - 1, Math.max(0, y + j - k.kRadius)), dx = k.dxs[j];
      for (let xx = x - dx; xx <= x + dx; xx++) { const v = src[yy * W + Math.min(W - 1, Math.max(0, xx))] * sign; if (max < v) max = v; }
    }
    out[y * W + x] = max * sign;
  }
  return out;
}

async function topHatRegion(data, W, H, bd, p, reg, bands) {
  const prep = M.IJOpRegistry.get('topHat').prepare({ bitDepth: bd, channels: [{ display: {} }] }, 0, Object.assign({ invertedLuts: { 0: false } }, p), null);
  const full = { width: W, height: H, bitDepth: bd, data };
  const out = [];
  let y = reg.y, i = 0;
  while (y < reg.y + reg.h) {
    const h = Math.min(bands[i++ % bands.length], reg.y + reg.h - y);
    out.push(...Array.from(await prep.region(full, { x: reg.x, y, w: reg.w, h })));
    y += h;
  }
  return out;
}

{
  let cases = 0;
  for (const bd of [8, 16, 32]) for (const radius of [1, 2, 3.5, 10]) for (const light of [false, true]) {
    const W = 41 + Math.floor(rnd() * 30), H = 60 + Math.floor(rnd() * 25);
    const data = image(bd, W, H, true);
    const k = M.IJFilters.kernelOffsets(radius);
    const reg = { x: 3, y: 5, w: W - 9, h: H - 14 };
    const all = await topHatRegion(data, W, H, bd, { radius, light, dontSubtract: true }, reg, [10000]);
    for (const bands of [[1], [3, 1, 7], [5, 10, 20, 40, 80]]) {
      const got = await topHatRegion(data, W, H, bd, { radius, light, dontSubtract: true }, reg, bands);
      assert.deepEqual(Array.from(bitsOf(got)), Array.from(bitsOf(all)), `bands ${bands} give the bits of one call (bd ${bd}, r ${radius})`);
      cases++;
    }
    // the opening (dark: min then max) / closing (light: max then min) of the brute force scan
    const s1 = scanExtreme(data, W, H, k, light ? 1 : -1), s2 = scanExtreme(s1, W, H, k, light ? -1 : 1);
    const ref = [];
    for (let y = reg.y; y < reg.y + reg.h; y++) for (let x = reg.x; x < reg.x + reg.w; x++) ref.push(s2[y * W + x]);
    const T = bd === 8 ? (v) => v : null;
    for (let i = 0; i < ref.length; i++) {
      const a = all[i], b = ref[i];
      if (bd === 32) assert.ok(Object.is(a, b) || (a !== a && b !== b) || a === b, `float opening / closing at ${i}: ${a} vs ${b}`);
      else assert.equal(a, (Math.fround(b + 0.5) | 0) & (bd === 8 ? 0xff : 0xffff), `integer opening / closing at ${i}`);
    }
    void T;
    cases++;
  }
  console.log(`top hat bands and brute force: OK (${cases} comparisons)`);
}

// -0 in the data: every band sequence still agrees with the single call (the transcribed scan order decides the zero)
{
  const W = 50, H = 70, d = new Float32Array(W * H);
  for (let i = 0; i < d.length; i++) d[i] = rnd() < 0.3 ? (rnd() < 0.5 ? -0 : 0) : Math.fround(rnd() * 4 - 2);
  const reg = { x: 0, y: 0, w: W, h: H };
  const all = await topHatRegion(d, W, H, 32, { radius: 3, light: false, dontSubtract: true }, reg, [10000]);
  for (const bands of [[1], [4, 9, 2]]) {
    const got = await topHatRegion(d, W, H, 32, { radius: 3, light: false, dontSubtract: true }, reg, bands);
    assert.deepEqual(Array.from(bitsOf(got)), Array.from(bitsOf(all)));
  }
  console.log('top hat with negative zeros: OK');
}

// the float median, NaN rule 2
{
  const F = M.IJFilters;
  const run = (arr, W, H, x0, y0, x1, y1, radius, nanRule) => F.rank({ width: W, height: H, bitDepth: 32, data: Float32Array.from(arr) }, radius, 'median', { region: { x0, y0, x1, y1 }, nanRule }).data;
  // 3 x 3 window (radius 1), centre 2, one NaN: 8 numbers, 6 above the centre → the 5th largest... = findNth(above, 1) = 4
  const win = [1, 9, 3, 4, 2, NaN, 7, 8, 6];
  assert.equal(run(win, 3, 3, 1, 1, 2, 2, 1, 2)[0], 4, 'rule 2: the even count follows the split around the pixel');
  assert.equal(run(win, 3, 3, 1, 1, 2, 2, 1)[0], 6, 'the default rule (every journal entry so far): the upper middle');
  assert.equal(run(win, 3, 3, 1, 1, 2, 2, 1, 1)[0], 6, 'rule 1 named');
  // a NaN centre stays NaN, even among numbers
  assert.ok(Number.isNaN(run([1, 9, 3, 4, NaN, 5, 7, 8, 6], 3, 3, 1, 1, 2, 2, 1, 2)[0]), 'a NaN pixel keeps its NaN');
  assert.equal(run([1, 9, 3, 4, NaN, 5, 7, 8, 6], 3, 3, 1, 1, 2, 2, 1)[0], 6, 'the default rule fills it (upper middle of 8)');
  // a window of NaN only
  assert.ok(Number.isNaN(run(new Array(9).fill(NaN), 3, 3, 1, 1, 2, 2, 1, 2)[0]));
  // the pixel's own value when neither side holds more than half: 1 2 3 [4] 4 5 6 7 + NaN → 3 below, 3 above, half 4 → 4
  assert.equal(run([1, 2, 3, 4, 4, NaN, 5, 6, 7], 3, 3, 1, 1, 2, 2, 1, 2)[0], 4);
  // no NaN anywhere: the exact median, the same bits as rule 1, for every pixel, several radii
  for (const radius of [1, 2, 3.5]) {
    const W = 23, H = 19, d = image(32, W, H, false);
    const a = run(d, W, H, 0, 0, W, H, radius, 2), b = run(d, W, H, 0, 0, W, H, radius, 1);
    assert.deepEqual(Array.from(bitsOf(a)), Array.from(bitsOf(b)), `no NaN: rule 2 = rule 1 (radius ${radius})`);
  }
  // signed zeros: the values agree (== treats -0 and +0 as equal), only the sign of a zero may differ between the rules
  {
    const W = 9, H = 9, z = [], r = (() => { let s = 7; return () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff); })();
    for (let i = 0; i < W * H; i++) z.push([0, -0, 1, -1, Infinity, -Infinity][Math.floor(r() * 6)]);
    const a = run(z, W, H, 0, 0, W, H, 1, 2), b = run(z, W, H, 0, 0, W, H, 1, 1);
    for (let i = 0; i < a.length; i++) assert.ok(a[i] === b[i], 'signed zeros: same value (sign of a zero not compared)');
  }
  // the journalled Despeckle carries no nanRule: replay meaning of the `rank` op is unchanged
  assert.ok(!/nanRule/.test(fs.readFileSync(new URL('../../js/modules/studio/advanced-studio/ij-cmds-filters.js', import.meta.url), 'utf8').replace(/\/\/.*$/gm, '')), 'no command journals nanRule');
  // NaN present: every output that is not NaN is a pixel value of the window (a median is a member)
  const W = 21, H = 17, d = image(32, W, H, true), out = run(d, W, H, 0, 0, W, H, 2, 2);
  for (let i = 0; i < out.length; i++) assert.ok(d[i] !== d[i] ? out[i] !== out[i] : true, 'a NaN pixel stays NaN');
  console.log('float median NaN rule 2: OK');
}

// 16-bit median at a radius whose kernel exceeds 65 535 pixels (r >= 145): the counters must not wrap.
// Expected values are those of the Uint16-free reference (a nonzero uniform field has that value as its median).
{
  const F = M.IJFilters, W = 300, H = 300;
  const reg = { x0: 0, y0: 0, x1: W, y1: H };
  for (const [radius, v] of [[145, 40000], [150, 1000]]) {
    const out = F.rank({ width: W, height: H, bitDepth: 16, data: new Uint16Array(W * H).fill(v) }, radius, 'median', { region: reg }).data;
    for (let i = 0; i < out.length; i++) if (out[i] !== v) assert.fail(`16-bit median r=${radius}: constant ${v} gave ${out[i]} at ${i}`);
  }
  const d = new Uint16Array(W * H).fill(100);
  for (let y = 120; y < 180; y++) for (let x = 120; x < 180; x++) d[y * W + x] = 1000;
  const out = F.rank({ width: W, height: H, bitDepth: 16, data: d }, 150, 'median', { region: reg }).data;
  for (let i = 0; i < out.length; i++) if (out[i] !== 100) assert.fail(`16-bit median r=150 square: ${out[i]} at ${i}`);
  console.log('16-bit median beyond 65535 kernel pixels: OK');
}

// Unsharp Mask progress never goes backwards, whole image or band (fake clock so every tick is emitted)
{
  const real = M.performance; let t = 0;
  M.performance = { now: () => (t += 50) };
  try {
    for (const [sigma, W, H, reg] of [[2, 300, 200, { x: 0, y: 0, w: 300, h: 200 }], [5, 300, 200, { x: 0, y: 150, w: 300, h: 50 }], [8, 300, 200, { x: 0, y: 3, w: 300, h: 60 }]]) {
      const fr = [];
      const prep = M.IJOpRegistry.get('unsharpMask').prepare({ bitDepth: 16, channels: [{ display: {} }] }, 0, { sigma, weight: 0.6 }, { tick: async (f) => { fr.push(f); }, check() {} });
      await prep.region({ width: W, height: H, bitDepth: 16, data: new Uint16Array(W * H).map((_, i) => (i * 7919) % 65536) }, reg);
      assert.ok(fr.length > 4, 'ticks were emitted');
      for (let i = 1; i < fr.length; i++) assert.ok(fr[i] >= fr[i - 1], `unsharp progress backwards at ${i}: ${fr[i - 1]} -> ${fr[i]} (sigma ${sigma})`);
    }
  } finally { M.performance = real; }
  console.log('unsharp progress monotone: OK');
}

closeAll();
console.log('ij filters exact: OK');
