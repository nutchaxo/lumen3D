// SliceCompositor (js/core/slice-compositor.js) colours the raw channel values of a
// slice exactly as the slice shader does (js/viewers/volume-slicer.js FRAG,
// channelValue / colorAt):
//   • the CPU path equals a reference written from the shader's formula, across gamma,
//     opacity, enabled / active / missing channel states, numChannels, a degenerate
//     window (min = max), the 0.005 visibility threshold and every colour format the
//     channel overrides accept (hex through three r147's THREE.Color, {r,g,b} in 0..255);
//   • the lookup-table path equals the per-pixel path to the bit;
//   • the GPU program's GLSL and the slicer's FRAG carry the same formula (a drift in
//     either breaks the "Studio colours = viewer colours" contract);
//   • histograms come in the shape VolumeViewer.getChannelHistograms() hands the channel
//     panel, leave out empty pixels and sample a large slice on a grid;
//   • compose() falls back to the CPU without WebGL2 and writes into the caller's canvas;
//   • a raw from another realm (a Compare panel's iframe) is accepted;
//   • a projected slab (raw.projected) is drawn opaque, black where nothing shows, as the
//     slicer's colour path draws a slab; with raw.coverage its channel 3 is the volume's
//     footprint (transparent outside it), never coloured nor histogrammed;
//   • one slab convention: the slicer's colour path projects the RAW values per channel
//     and colours the projection once (the Fiji order), so the slice on screen equals the
//     Studio's recolour of the raw path, for MIP and average.
//
// Run: node tests/js/test_slice_compositor.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { loadModule, ROOT } from './harness.mjs';

const require = createRequire(import.meta.url);
const THREE = require('../../js/vendor/three.min.js');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

const SC = loadModule('js/core/slice-compositor.js', 'SliceCompositor', { THREE });
assert.ok(SC && typeof SC.compose === 'function', 'SliceCompositor loads');

// Deterministic PRNG (mulberry32).
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── Reference: the slicer's FRAG, transcribed ─────────────────────────────────
//   float channelValue(raw, lo, hi, gamma, opacity) {
//     v = clamp((raw - lo) / max(hi - lo, 0.0001), 0, 1); if (gamma != 1) v = pow(v, gamma);
//     return v * opacity; }
//   c += channelValue(v.<i>, …) * color<i>   for en<i>==1 && numChannels > i
//   discard when length(c) < 0.005; else the target stores clamp(c)·255 rounded, alpha 1.
function refColour(color) {
  if (typeof color === 'string') { const c = new THREE.Color(color); return [c.r, c.g, c.b]; }
  if (color && typeof color === 'object') return [color.r / 255, color.g / 255, color.b / 255];
  return [1, 1, 1];
}
function refPixel(bytes, state, numChannels) {
  let r = 0; let g = 0; let b = 0;
  for (let i = 0; i < 4; i++) {
    const s = state[i];
    if (!s || i >= numChannels) continue;
    const on = (s.enabled !== undefined ? s.enabled : s.active) !== false;
    if (!on) continue;
    const lo = Number.isFinite(s.min) ? s.min : 0;
    const hi = Number.isFinite(s.max) ? s.max : 1;
    const gamma = Number.isFinite(s.gamma) ? s.gamma : 1;
    const opacity = Number.isFinite(s.opacity) ? s.opacity : 1;
    let v = Math.min(1, Math.max(0, (bytes[i] / 255 - lo) / Math.max(hi - lo, 0.0001)));
    if (gamma !== 1) v = Math.pow(v, gamma);
    v *= opacity;
    const col = refColour(s.color);
    r += v * col[0]; g += v * col[1]; b += v * col[2];
  }
  if (Math.hypot(r, g, b) < 0.005) return [0, 0, 0, 0];
  const q = (x) => Math.round(Math.min(1, Math.max(0, x)) * 255);
  return [q(r), q(g), q(b), 255];
}

function randomRaw(w, h, seed, zeroFraction = 0.2) {
  const next = rng(seed);
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    if (next() < zeroFraction) continue;
    for (let c = 0; c < 4; c++) data[i * 4 + c] = Math.floor(next() * 256);
  }
  return { data, width: w, height: h, channels: 4 };
}

// ── 1. CPU path = the shader formula ──────────────────────────────────────────
{
  const raw = randomRaw(61, 37, 7);
  const cases = [
    { name: 'viewer defaults', n: 4, state: [
      { color: '#00FF00', min: 0, max: 1, gamma: 1, opacity: 0.7, enabled: true },
      { color: '#00AAFF', min: 0, max: 1, gamma: 1, opacity: 0.7, enabled: true },
      { color: '#FF00FF', min: 0, max: 1, gamma: 1, opacity: 0.7, enabled: true },
      { color: '#FF0000', min: 0, max: 1, gamma: 1, opacity: 0.7, enabled: true }] },
    { name: 'window + gamma + opacity', n: 3, state: [
      { color: '#ff8800', min: 0.1, max: 0.6, gamma: 0.45, opacity: 1, enabled: true },
      { color: '#0f0', min: 0.2, max: 0.25, gamma: 2.2, opacity: 0.05, enabled: true },
      { color: { r: 40, g: 200, b: 255 }, min: 0, max: 0.9, gamma: 5.5, opacity: 0.42, enabled: true },
      { color: '#ffffff', min: 0, max: 1, gamma: 1, opacity: 1, enabled: true }] }, // beyond numChannels: ignored
    { name: 'disabled / active:false / missing', n: 4, state: [
      { color: '#ff0000', min: 0, max: 1, gamma: 1, opacity: 1, enabled: false },
      { color: '#00ff00', min: 0, max: 1, gamma: 1, opacity: 1, active: false },
      undefined,
      { color: '#0000FF', min: 0.3, max: 0.3, gamma: 1, opacity: 1 }] }, // min = max: the 1e-4 guard; no `enabled` = on
    { name: 'inverted window, rgb() colour', n: 2, state: [
      { color: 'rgb(255, 128, 0)', min: 0.8, max: 0.2, gamma: 1.7, opacity: 0.9, enabled: true },
      { color: '#AbCdEf', min: 0.05, max: 0.95, gamma: 0.18, opacity: 0.7, enabled: true }] },
    { name: 'one channel', n: 1, state: [
      { color: '#00FF00', min: 0.02, max: 0.94, gamma: 1.3, opacity: 1, enabled: true },
      { color: '#FF00FF', min: 0, max: 1, gamma: 1, opacity: 1, enabled: true }] },
  ];
  for (const { name, n, state } of cases) {
    const lut = SC.composePixels({ ...raw, channels: n }, state);
    const direct = SC.composePixels({ ...raw, channels: n }, state, { lut: false });
    assert.equal(lut.length, raw.width * raw.height * 4, `${name}: one RGBA per pixel`);
    for (let i = 0; i < raw.width * raw.height; i++) {
      const want = refPixel(raw.data.subarray(i * 4, i * 4 + 4), state, n);
      const got = [lut[i * 4], lut[i * 4 + 1], lut[i * 4 + 2], lut[i * 4 + 3]];
      if (want.some((v, k) => v !== got[k])) assert.fail(`${name}: pixel ${i} = ${got}, the shader gives ${want}`);
      for (let k = 0; k < 4; k++) {
        if (lut[i * 4 + k] !== direct[i * 4 + k]) assert.fail(`${name}: LUT and direct differ at pixel ${i}`);
      }
    }
  }
  // numChannels from the raw (the volume's channel count), overridable per call.
  const two = [{ color: '#ff0000', enabled: true }, { color: '#00ff00', enabled: true }, { color: '#0000ff', enabled: true }];
  const px = { data: new Uint8Array([255, 255, 255, 255]), width: 1, height: 1, channels: 2 };
  assert.deepEqual([...SC.composePixels(px, two)], [255, 255, 0, 255], 'raw.channels = 2: the third channel is not coloured');
  assert.deepEqual([...SC.composePixels(px, two, { numChannels: 3 })], [255, 255, 255, 255], 'options.numChannels wins');
  console.log('CPU path = shader formula, LUT = direct: OK');
}

// ── 2. The visibility threshold, on both sides of 0.005 ───────────────────────
{
  // One channel, white, window [0, 1], opacity k: rgb = (v·k, v·k, v·k), |rgb| = √3·v·k.
  // v = 1/255: |rgb| = √3·k/255 → the pixel shows iff k ≥ 0.005·255/√3 ≈ 0.7361.
  const kEdge = (0.005 * 255) / Math.sqrt(3);
  const one = { data: new Uint8Array([1, 0, 0, 0]), width: 1, height: 1, channels: 1 };
  const at = (k) => [...SC.composePixels(one, [{ color: '#ffffff', min: 0, max: 1, gamma: 1, opacity: k, enabled: true }])];
  assert.deepEqual(at(kEdge * 0.999), [0, 0, 0, 0], 'just below 0.005: transparent, as the shader discards');
  assert.deepEqual(at(kEdge * 1.001), [1, 1, 1, 255], 'just above: drawn');
  assert.deepEqual(at(0), [0, 0, 0, 0], 'opacity 0: nothing');
  console.log('0.005 threshold: OK');
}

// ── 3. Colours parse like THREE.Color (r147, legacy colour management) ─────────
{
  for (const hex of ['#00FF00', '#00aaff', '#FF00FF', '#123456', '#abc', '#FFF', '#7f7f7f']) {
    const c = new THREE.Color(hex);
    const got = SC.parseColor(hex);
    [c.r, c.g, c.b].forEach((v, k) => assert.ok(Math.abs(v - got[k]) < 1e-12, `${hex}[${k}]: ${got[k]} vs THREE ${v}`));
  }
  assert.deepEqual([...SC.parseColor({ r: 255, g: 0, b: 51 })], [1, 0, 0.2], '{r,g,b} in 0..255');
  assert.deepEqual([...SC.parseColor('rgb(0, 255, 0)')], [0, 1, 0], 'rgb()');
  const named = SC.parseColor('orange'); // through THREE.Color (present in this sandbox)
  const t = new THREE.Color('orange');
  assert.deepEqual([...named], [t.r, t.g, t.b], 'a CSS name through THREE.Color');
  assert.deepEqual([...SC.parseColor(undefined)], [1, 1, 1], 'no colour: white');
  console.log('colour parsing: OK');
}

// ── 4. The two GLSL copies of the formula agree with each other ───────────────
{
  const slicer = read('js/viewers/volume-slicer.js');
  const compositor = read('js/core/slice-compositor.js');
  const body = /float v = clamp\(\(raw - lo\) \/ max\(hi - lo, 0\.0001\), 0\.0, 1\.0\);\s*if \(gamma != 1\.0\) v = pow\(v, gamma\);\s*return v \* opacity;/;
  assert.ok(body.test(slicer), 'slicer FRAG channelValue as transcribed');
  assert.ok(body.test(compositor), 'compositor GLSL channelValue identical');
  assert.ok(/if \(length\(s\.rgb\) < 0\.005\) discard;/.test(slicer), 'slicer discards below 0.005');
  assert.ok(/const VISIBLE_MIN = 0\.005;/.test(compositor) && /if \(uAlphaMode == 0 && length\(c\) < \$\{VISIBLE_MIN\.toFixed\(3\)\}\)/.test(compositor), 'compositor uses the same threshold (one plane)');
  assert.ok(/if \(uAlphaMode == 2 && v\.a == 0\.0\) \{ outColor = vec4\(0\.0\); return; \}/.test(compositor), 'a coverage raw leaves the outside of the volume transparent');
  assert.ok(/gl\.uniform1i\(_loc\.alphaMode, _alphaMode\(raw, options\)\)/.test(compositor), 'the GPU path reads the same alpha mode as the CPU path');
  for (const [ch, comp] of [[0, 'r'], [1, 'g'], [2, 'b'], [3, 'a']]) {
    assert.ok(new RegExp(`en${ch}==1 && numChannels>${ch}\\) c \\+= channelValue\\(v\\.${comp},`).test(slicer), `slicer channel ${ch} reads v.${comp}`);
    assert.ok(new RegExp(`uNumChannels > ${ch}\\) c \\+= channelValue\\(v\\.${comp},`).test(compositor), `compositor channel ${ch} reads v.${comp}`);
  }
  // Rows: the raw is stored top row first, the framebuffer counts from the bottom.
  assert.ok(/texelFetch\(uRaw, ivec2\(p\.x, uHeight - 1 - p\.y\), 0\)/.test(compositor), 'compositor flips rows exactly (texelFetch, no filtering)');
  assert.ok(!/THREE\./.test(compositor.replace(/THREE\.Color/g, '')), 'no three.js dependency beyond the optional colour parser (compare.html has no THREE)');
  console.log('GLSL formula parity: OK');
}

// ── 5. Histograms in VolumeViewer.getChannelHistograms() shape ────────────────
{
  const w = 4; const h = 2;
  const data = new Uint8Array(w * h * 4);
  // Pixel 0 empty; pixel 1 = (255, 0, 128, 7); pixels 2..7 = (10, 20, 0, 0).
  data.set([255, 0, 128, 7], 4);
  for (let i = 2; i < 8; i++) data.set([10, 20, 0, 0], i * 4);
  const raw = { data, width: w, height: h, channels: 3 };
  const hist = SC.histograms(raw, 256);
  assert.equal(hist.length, 3, 'one histogram per channel of the volume');
  for (const hh of hist) {
    assert.deepEqual(Object.keys(hh).sort(), ['bins', 'counts', 'max', 'total']);
    assert.equal(hh.bins, 256); assert.equal(hh.counts.length, 256); assert.ok(Array.isArray(hh.counts));
    assert.equal(hh.total, 7, 'the empty pixel is left out');
  }
  assert.equal(hist[0].counts[255], 1); assert.equal(hist[0].counts[10], 6); assert.equal(hist[0].max, 6);
  assert.equal(hist[1].counts[0], 1, 'a zero in one channel of a non-empty pixel still counts'); assert.equal(hist[1].counts[20], 6);
  assert.equal(hist[2].counts[128], 1); assert.equal(hist[2].counts[0], 6);
  const coarse = SC.histograms(raw, 64);
  assert.equal(coarse[0].counts.length, 64); assert.equal(coarse[0].counts[63], 1); assert.equal(coarse[0].counts[2], 6);
  // Cached per raw, but every call hands out its own copy (the panel may mutate it).
  const again = SC.histograms(raw, 256);
  again[0].counts[10] = -1;
  assert.equal(SC.histograms(raw, 256)[0].counts[10], 6, 'callers get copies');
  // The histogram plugin's Auto reads `total` and `counts`: a plausible range comes back.
  assert.equal(SC.histograms(null).length, 0, 'no raw: no histograms, no throw');

  // A large slice is read on a grid of rows and columns: ~4 Mpx at most.
  const big = { data: new Uint8Array(2100 * 2100 * 4).fill(200), width: 2100, height: 2100, channels: 1 };
  const bh = SC.histograms(big, 256);
  assert.equal(bh[0].total, 1050 * 1050, 'every other row and column of a 4.4 Mpx slice');
  assert.equal(bh[0].counts[200], 1050 * 1050);
  console.log('histograms: OK');
}

// ── 6. compose(): CPU fallback into the caller's canvas ───────────────────────
{
  const puts = [];
  function fakeCanvas() {
    const c = {
      width: 0, height: 0,
      getContext(kind) {
        if (kind !== '2d') return null; // no WebGL2 here
        return {
          createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
          putImageData: (img) => puts.push({ canvas: c, data: img.data }),
          clearRect() {}, drawImage() {},
        };
      },
    };
    return c;
  }
  const SC2 = loadModule('js/core/slice-compositor.js', 'SliceCompositor', { THREE, document: { createElement: () => fakeCanvas() } });
  const raw = randomRaw(9, 5, 3);
  const state = [{ color: '#00FF00', min: 0.1, max: 0.8, gamma: 0.7, opacity: 0.9, enabled: true }];
  const target = fakeCanvas();
  const out = SC2.compose({ ...raw, channels: 1 }, state, { target });
  assert.equal(out, target, 'drawn into the canvas the caller keeps');
  assert.equal(target.width, 9); assert.equal(target.height, 5);
  assert.deepEqual([...puts.at(-1).data], [...SC2.composePixels({ ...raw, channels: 1 }, state)], 'CPU path: the composed bytes');
  const fresh = SC2.compose({ ...raw, channels: 1 }, state);
  assert.ok(fresh && fresh !== target && fresh.width === 9, 'without a target: a new canvas');
  assert.equal(SC2.compose({ data: new Uint8Array(3), width: 2, height: 2 }, state), null, 'a short buffer is refused');
  assert.equal(SC2.compose(null, state), null, 'no raw: null');
  SC2.release(); SC2.release(raw);
  assert.equal(SC2.textureBytes(), 0);
  // No document (a worker, node): nothing to draw into.
  assert.equal(SC.compose(raw, state), null, 'no document: null, no throw');
  console.log('compose CPU fallback: OK');
}

// ── 7. Raw buffers from another realm (a Compare panel's iframe) ──────────────
{
  const foreign = vm.runInNewContext('new Uint8Array(16)');
  assert.ok(!(foreign instanceof Uint8Array), 'the buffer really is from another realm');
  const raw = { data: foreign, width: 2, height: 2, channels: 1 };
  assert.ok(SC.isRaw(raw), 'accepted');
  assert.ok(!SC.isRaw({ data: new Float32Array(16), width: 2, height: 2 }), 'not bytes: refused');
  assert.ok(!SC.isRaw({ data: new Uint8Array(16), width: 2.5, height: 2 }), 'non-integer size: refused');
  assert.ok(!SC.isRaw({ data: new Uint8Array(15), width: 2, height: 2 }), 'short: refused');
  assert.equal(SC.histograms(raw).length, 1);
  console.log('cross-realm raw: OK');
}

// ── 8. Projected slabs: opaque, as the slicer's colour path writes a slab ──────
function refSlabPixel(bytes, state, numChannels) {
  // The colour path's slab output: vec4(composeRaw(p), 1.0), no 0.005 cut-off.
  const withThreshold = refPixel(bytes, state, numChannels);
  if (withThreshold[3] === 255) return withThreshold;
  let r = 0; let g = 0; let b = 0;
  for (let i = 0; i < Math.min(4, numChannels); i++) {
    const s = state[i];
    if (!s || ((s.enabled !== undefined ? s.enabled : s.active) === false)) continue;
    let v = Math.min(1, Math.max(0, (bytes[i] / 255 - (s.min ?? 0)) / Math.max((s.max ?? 1) - (s.min ?? 0), 0.0001)));
    if ((s.gamma ?? 1) !== 1) v = Math.pow(v, s.gamma);
    v *= s.opacity ?? 1;
    const col = refColour(s.color);
    r += v * col[0]; g += v * col[1]; b += v * col[2];
  }
  const q = (x) => Math.round(Math.min(1, Math.max(0, x)) * 255);
  return [q(r), q(g), q(b), 255];
}
{
  const state = [
    { color: '#00FF00', min: 0.05, max: 0.6, gamma: 1.3, opacity: 0.8, enabled: true },
    { color: '#FF00FF', min: 0, max: 1, gamma: 1, opacity: 0.7, enabled: true },
    { color: '#0088FF', min: 0.2, max: 0.9, gamma: 0.6, opacity: 1, enabled: true },
    { color: '#FFFFFF', min: 0, max: 1, gamma: 1, opacity: 1, enabled: true },
  ];
  // Four channels: no spare channel, every pixel opaque (black where nothing shows).
  const raw4 = { ...randomRaw(23, 17, 5, 0.4), channels: 4, projected: true };
  const out4 = SC.composePixels(raw4, state);
  assert.deepEqual([...SC.composePixels(raw4, state, { lut: false })], [...out4], 'LUT = direct for a slab too');
  let blacks = 0;
  for (let i = 0; i < raw4.width * raw4.height; i++) {
    const px = raw4.data.subarray(i * 4, i * 4 + 4);
    const want = refSlabPixel(px, state, 4);
    const got = [...out4.subarray(i * 4, i * 4 + 4)];
    if (want.some((v, k) => v !== got[k])) assert.fail(`projected pixel ${i} = ${got}, the slab shader gives ${want}`);
    if (!px[0] && !px[1] && !px[2] && !px[3]) { assert.deepEqual(got, [0, 0, 0, 255], 'no signal: opaque black'); blacks++; }
  }
  assert.ok(blacks > 0, 'the sample holds empty pixels');
  // The same raw without the flag keeps the single-plane threshold.
  const plane = SC.composePixels({ ...raw4, projected: false }, state);
  const emptyAt = [...Array(raw4.width * raw4.height).keys()].find((i) => !raw4.data[i * 4] && !raw4.data[i * 4 + 1] && !raw4.data[i * 4 + 2] && !raw4.data[i * 4 + 3]);
  assert.deepEqual([...plane.subarray(emptyAt * 4, emptyAt * 4 + 4)], [0, 0, 0, 0], 'one plane: transparent where nothing shows');
  assert.deepEqual([...SC.composePixels({ ...raw4 }, state, { projected: false })], [...plane], 'options.projected overrides the raw');

  // Fewer channels: channel 3 is the volume's footprint, not data.
  const raw3 = { ...randomRaw(19, 13, 9, 0.3), channels: 3, projected: true, coverage: true };
  for (let i = 0; i < raw3.width * raw3.height; i++) raw3.data[i * 4 + 3] = (i % 5 === 0) ? 0 : 255;
  // Signal in the channels even off the footprint: it stays transparent there.
  raw3.data.set([200, 200, 200, 0], 0);
  const out3 = SC.composePixels(raw3, state, { numChannels: 4 }); // a caller asking for 4 cannot colour the footprint
  for (let i = 0; i < raw3.width * raw3.height; i++) {
    const got = [...out3.subarray(i * 4, i * 4 + 4)];
    if (i % 5 === 0) {
      assert.deepEqual(got, [0, 0, 0, 0], `pixel ${i}: off the volume, transparent (the colour path discards it)`);
    } else {
      const want = refSlabPixel(raw3.data.subarray(i * 4, i * 4 + 4), state, 3);
      if (want.some((v, k) => v !== got[k])) assert.fail(`coverage pixel ${i} = ${got}, the slab shader gives ${want}`);
    }
  }
  const hist = SC.histograms(raw3, 256);
  assert.equal(hist.length, 3, 'the footprint is not a channel of the histograms');
  const footprintOnly = { data: new Uint8Array([0, 0, 0, 255, 9, 0, 0, 255]), width: 2, height: 1, channels: 3, projected: true, coverage: true };
  assert.equal(SC.histograms(footprintOnly, 256)[0].total, 1, 'a pixel with the footprint alone counts as empty');
  console.log('projected slabs (opaque, coverage footprint): OK');
}

// ── 9. One slab convention: the slicer's colour path = the raw path coloured ───
{
  const slicer = read('js/viewers/volume-slicer.js');
  const main = slicer.slice(slicer.indexOf('void main() {'));
  const colourPath = main.slice(main.indexOf('#else'), main.lastIndexOf('#endif'));
  // The colour slab: the raw per-channel projection first, rounded to the byte the raw
  // target stores, then the channel window / colour once — never a projection of colours.
  assert.ok(/vec4 p = projectSlab\(base, hits, missing\);/.test(colourPath), 'the colour path projects the raw values');
  assert.ok(/p = floor\(p \* 255\.0 \+ 0\.5\) \/ 255\.0;/.test(colourPath), 'rounded as the RGBA8 raw target rounds');
  assert.ok(/fragColor = vec4\(composeRaw\(p\), 1\.0\);/.test(colourPath), 'then coloured once, opaque');
  assert.ok(colourPath.indexOf('projectSlab(') < colourPath.indexOf('composeRaw(p)'), 'projection before colour');
  assert.ok(!/acc = max\(acc, s\.rgb\)|acc \+= s\.rgb/.test(slicer), 'no projection of composed colours left');
  assert.ok(/if \(hits == 0\) discard;/.test(colourPath) && /if \(fallbackColor\(uv, f\)\) \{ fragColor = f; return; \}/.test(colourPath),
    'off the volume transparent, missing bricks from the fallback, as before');
  assert.ok(/vec4 colorAt\(vec3 uvw\) \{\s*bool present;\s*vec4 v = rawAt\(uvw, present\);\s*if \(!present\) return vec4\(0\.0\);\s*return vec4\(composeRaw\(v\), 1\.0\);/.test(slicer),
    'one plane: the same texel, the same colour math as before');

  // Numerically, transcribed from the two GLSL paths: colour(project(s)) rounded like the
  // raw target = SliceCompositor on the raw path's bytes.
  const project = (samples, mode) => [0, 1, 2, 3].map((c) => {
    const vals = samples.map((s) => s[c] / 255);
    return mode === 'mip' ? Math.max(...vals) : vals.reduce((a, v) => a + v, 0) / vals.length;
  });
  const next = rng(99);
  const states = [
    [{ color: '#ffffff', min: 0, max: 0.5, gamma: 1, opacity: 1, enabled: true }],
    [{ color: '#00FF00', min: 0.1, max: 0.7, gamma: 0.8, opacity: 0.9, enabled: true },
      { color: '#FFFFFF', min: 0, max: 1, gamma: 1.4, opacity: 0.6, enabled: true }],
  ];
  for (const mode of ['mip', 'average']) {
    for (const [si, state] of states.entries()) {
      for (let trial = 0; trial < 200; trial++) {
        const n = 1 + Math.floor(next() * 12);
        const samples = Array.from({ length: n }, () => [0, 1, 2, 3].map(() => (next() < 0.3 ? 0 : Math.floor(next() * 256))));
        const p = project(samples, mode);
        const bytes = p.map((v) => Math.round(v * 255)); // the raw target (and the colour path's rounding)
        const colourPath = refSlabPixel(bytes, state, state.length);
        const rawPath = [...SC.composePixels({ data: new Uint8Array(bytes), width: 1, height: 1, channels: state.length, projected: true }, state)];
        assert.deepEqual(rawPath, colourPath, `${mode}, state ${si}: the Studio recolour equals the slice on screen`);
      }
    }
  }
  // The review's example: samples 0 and 255, window [0, 0.5], average. Projection first:
  // mean 0.5 → the window's top → 255. (Colouring first gave (0 + 1)/2 → 128.)
  const example = project([[0, 0, 0, 0], [255, 0, 0, 0]], 'average');
  const exampleBytes = example.map((v) => Math.round(v * 255));
  assert.deepEqual([...SC.composePixels({ data: new Uint8Array(exampleBytes), width: 1, height: 1, channels: 1, projected: true }, states[0])],
    [255, 255, 255, 255], 'average intensity, then the window');
  console.log('one slab convention (raw projection, then colour): OK');
}

console.log('slice compositor: OK');
