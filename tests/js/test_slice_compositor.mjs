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
  const gpu = compositor.slice(compositor.indexOf('function _composeGpu('), compositor.indexOf('function compose('));
  assert.ok(/const alphaMode = _alphaMode\(raw, options\);/.test(gpu) && /gl\.uniform1i\(_loc\.alphaMode, alphaMode\)/.test(gpu), 'the GPU path reads the same alpha mode as the CPU path');
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

// ── 10. Four-channel slabs: the footprint comes as raw.coverageMask ────────────
// A four-channel volume has no spare channel for the footprint; the viewer hands the
// colour picture's alpha as a w·h byte mask. Off the mask: (0,0,0,0) whatever the
// channels hold; on it: the slab colour, opaque black where nothing shows.
function footprintMask(w, h, seed) {
  // A turned square (a rotated z-stack slab inside its bounding crop) plus the crop's
  // padding: 0 there, 255 inside.
  const mask = new Uint8Array(w * h);
  const cx = (w - 1) / 2; const cy = (h - 1) / 2;
  const a = 0.6 + (seed % 5) * 0.1;
  const half = Math.min(w, h) * 0.34;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const u = (x - cx) * Math.cos(a) + (y - cy) * Math.sin(a);
      const v = -(x - cx) * Math.sin(a) + (y - cy) * Math.cos(a);
      if (Math.abs(u) <= half && Math.abs(v) <= half) mask[y * w + x] = 255;
    }
  }
  return mask;
}
const SLAB_STATE = [
  { color: '#00FF00', min: 0.05, max: 0.6, gamma: 1.3, opacity: 0.8, enabled: true },
  { color: '#FF00FF', min: 0, max: 1, gamma: 1, opacity: 0.7, enabled: true },
  { color: '#0088FF', min: 0.2, max: 0.9, gamma: 0.6, opacity: 1, enabled: true },
  { color: '#FFFFFF', min: 0.1, max: 1, gamma: 1, opacity: 1, enabled: true },
];
{
  const w = 29; const h = 21;
  const mask = footprintMask(w, h, 3);
  const raw = { ...randomRaw(w, h, 11, 0.35), channels: 4, projected: true, coverage: false, coverageMask: mask };
  // Signal off the footprint must not show (the colour path discarded those pixels).
  raw.data.set([250, 250, 250, 250], 0);
  assert.equal(mask[0], 0, 'the corner is off the footprint');
  const out = SC.composePixels(raw, SLAB_STATE);
  assert.deepEqual([...SC.composePixels(raw, SLAB_STATE, { lut: false })], [...out], 'LUT = direct with a mask');
  let on = 0; let off = 0; let blackOn = 0;
  for (let i = 0; i < w * h; i++) {
    const got = [...out.subarray(i * 4, i * 4 + 4)];
    if (mask[i] === 0) {
      assert.deepEqual(got, [0, 0, 0, 0], `pixel ${i}: off the footprint, transparent`);
      off++;
    } else {
      const px = raw.data.subarray(i * 4, i * 4 + 4);
      const want = refSlabPixel(px, SLAB_STATE, 4);
      if (want.some((v, k) => v !== got[k])) assert.fail(`masked slab pixel ${i} = ${got}, the slab shader gives ${want}`);
      if (!px[0] && !px[1] && !px[2] && !px[3]) { assert.deepEqual(got, [0, 0, 0, 255], 'on the footprint with no signal: opaque black'); blackOn++; }
      on++;
    }
  }
  assert.ok(on > 0 && off > 0 && blackOn > 0, `the sample has both sides and empty pixels on the footprint (${on}/${off}/${blackOn})`);
  // Every channel is coloured (the mask is not a channel): channel 3 shows.
  const white = { data: new Uint8Array([0, 0, 0, 255]), width: 1, height: 1, channels: 4, projected: true, coverageMask: new Uint8Array([255]) };
  assert.deepEqual([...SC.composePixels(white, SLAB_STATE)], [255, 255, 255, 255], 'channel 3 of a masked raw is data');

  // Without a mask (or a mask of another frame, or options.coverageMask: null) the
  // slab is opaque over its whole crop, as before.
  const opaque = SC.composePixels({ ...raw, coverageMask: undefined }, SLAB_STATE);
  for (let i = 0; i < w * h; i++) assert.equal(opaque[i * 4 + 3], 255, 'no mask: opaque everywhere');
  assert.deepEqual([...SC.composePixels({ ...raw, coverageMask: new Uint8Array(w * h + 1) }, SLAB_STATE)], [...opaque], 'a mask of another size is ignored');
  assert.deepEqual([...SC.composePixels({ ...raw, coverageMask: new Uint16Array(w * h) }, SLAB_STATE)], [...opaque], 'a mask that is not bytes is ignored');
  assert.deepEqual([...SC.composePixels(raw, SLAB_STATE, { coverageMask: null })], [...opaque], 'options.coverageMask: null ignores it');
  assert.deepEqual([...SC.composePixels({ ...raw, coverageMask: undefined }, SLAB_STATE, { coverageMask: mask })], [...out], 'options.coverageMask supplies it');
  assert.ok(SC.isCoverageMask(mask, w, h) && !SC.isCoverageMask(mask, w, h + 1) && !SC.isCoverageMask(null, w, h), 'isCoverageMask: exactly w·h bytes');

  // One plane keeps the 0.005 threshold: the mask is a slab's, never read there.
  const plane = SC.composePixels({ ...raw, projected: false }, SLAB_STATE);
  for (let i = 0; i < w * h; i++) {
    const want = refPixel(raw.data.subarray(i * 4, i * 4 + 4), SLAB_STATE, 4);
    const got = [...plane.subarray(i * 4, i * 4 + 4)];
    if (want.some((v, k) => v !== got[k])) assert.fail(`single plane with a stray mask, pixel ${i} = ${got}, the shader gives ${want}`);
  }
  // A coverage raw (fewer than four channels) keeps its channel-3 footprint: the mask
  // is not consulted, the footprint byte decides.
  const raw3 = { ...randomRaw(w, h, 21, 0.3), channels: 3, projected: true, coverage: true, coverageMask: new Uint8Array(w * h) };
  for (let i = 0; i < w * h; i++) raw3.data[i * 4 + 3] = mask[i];
  const out3 = SC.composePixels(raw3, SLAB_STATE);
  for (let i = 0; i < w * h; i++) {
    const got = [...out3.subarray(i * 4, i * 4 + 4)];
    if (mask[i] === 0) assert.deepEqual(got, [0, 0, 0, 0], 'coverage raw: off the footprint byte, transparent');
    else {
      const want = refSlabPixel(raw3.data.subarray(i * 4, i * 4 + 4), SLAB_STATE, 3);
      if (want.some((v, k) => v !== got[k])) assert.fail(`coverage raw pixel ${i} = ${got}, expected ${want} (the all-zero mask must be ignored)`);
    }
  }

  // Histograms: pixels off the mask are left out even when their channels are not 0.
  const hist = SC.histograms(raw, 256);
  assert.equal(hist.length, 4, 'four channels histogrammed');
  let expected = 0;
  let expectedAll = 0;
  for (let i = 0; i < w * h; i++) {
    const any = raw.data[i * 4] | raw.data[i * 4 + 1] | raw.data[i * 4 + 2] | raw.data[i * 4 + 3];
    if (any) expectedAll++;
    if (any && mask[i]) expected++;
  }
  assert.ok(expected < expectedAll, 'the sample holds signal off the footprint');
  assert.equal(hist[0].total, expected, 'only the footprint is counted');
  assert.equal(SC.histograms({ ...raw, coverageMask: undefined }, 256)[0].total, expectedAll, 'without the mask every non-empty pixel counts');

  // A Compare panel's mask comes from the panel's iframe: another realm.
  const foreignMask = vm.runInNewContext(`new Uint8Array(${w * h})`);
  foreignMask.set(mask);
  assert.ok(!(foreignMask instanceof Uint8Array), 'the mask really is from another realm');
  assert.deepEqual([...SC.composePixels({ ...raw, coverageMask: foreignMask }, SLAB_STATE)], [...out], 'a cross-realm mask is honoured');
  console.log('four-channel slabs, coverage mask (CPU): OK');
}

// ── 11. The GPU path with a mask, run through an emulated WebGL2 context ────────
// The context records every texture, unit and uniform; drawArrays runs a line-by-line
// transcription of the compositor's FRAG (checked against the source below) on the
// textures actually bound to the units its samplers name. So: the mask reaches the
// shader as an R8 texture of its exact bytes on unit 1, rows flip the same way as the
// raw, one upload serves every raw of the frame, and release() frees it only once no
// cached raw uses it.
{
  const compositorSrc = read('js/core/slice-compositor.js');
  const frag = compositorSrc.slice(compositorSrc.indexOf('const FRAG = `'), compositorSrc.indexOf('function _compile('));
  // The lines the emulation below transcribes.
  assert.ok(/uniform sampler2D uMask;/.test(frag), 'FRAG declares the mask sampler');
  assert.ok(/ivec2 p = ivec2\(gl_FragCoord\.xy\);\s*vec4 v = texelFetch\(uRaw, ivec2\(p\.x, uHeight - 1 - p\.y\), 0\);/.test(frag), 'raw texel, rows flipped');
  assert.ok(/if \(uAlphaMode == 2 && v\.a == 0\.0\) \{ outColor = vec4\(0\.0\); return; \}\s*if \(uAlphaMode == 3 && texelFetch\(uMask, ivec2\(p\.x, uHeight - 1 - p\.y\), 0\)\.r == 0\.0\) \{ outColor = vec4\(0\.0\); return; \}/.test(frag),
    'mode 3: the mask texel at the same row flip as the raw; 0 → transparent');
  assert.ok(/if \(uAlphaMode == 0 && length\(c\) < \$\{VISIBLE_MIN\.toFixed\(3\)\}\) \{ outColor = vec4\(0\.0\); return; \}\s*outColor = vec4\(clamp\(c, 0\.0, 1\.0\), 1\.0\);/.test(frag), 'threshold only for one plane, opaque otherwise');
  const gpuSrc = compositorSrc.slice(compositorSrc.indexOf('function _composeGpu('), compositorSrc.indexOf('function compose('));
  assert.ok(/_maskTextureFor\(gl, mask, w, h, options\?\.slot \|\| raw\.data\)/.test(gpuSrc) && /_textureFor\(gl, raw, mask, options\?\.slot \|\| null\)/.test(gpuSrc), 'each upload keeps the other texture of the compose from eviction');
  assert.ok(/if \(k === keep \|\| entry\.kind !== kind\) continue;/.test(compositorSrc), 'the eviction loop skips the kept texture (and every texture of the other kind)');
  assert.ok(/gl\.texImage2D\(gl\.TEXTURE_2D, 0, internalFormat, w, h, 0, format, gl\.UNSIGNED_BYTE, data\)/.test(compositorSrc) && /gl\.R8, gl\.RED/.test(compositorSrc), 'the mask is an R8 / RED texture');

  const E = {
    TEXTURE_2D: 0x0DE1, TEXTURE0: 0x84C0, TEXTURE1: 0x84C1, RGBA8: 0x8058, RGBA: 0x1908, R8: 0x8229, RED: 0x1903,
    UNSIGNED_BYTE: 0x1401, NO_ERROR: 0, MAX_TEXTURE_SIZE: 0x0D33, VERTEX_SHADER: 0x8B31, FRAGMENT_SHADER: 0x8B30,
    COMPILE_STATUS: 0x8B81, LINK_STATUS: 0x8B82, UNPACK_ALIGNMENT: 0x0CF5, UNPACK_FLIP_Y_WEBGL: 0x9240,
    UNPACK_PREMULTIPLY_ALPHA_WEBGL: 0x9241, UNPACK_COLORSPACE_CONVERSION_WEBGL: 0x9243, NONE: 0,
    TEXTURE_MIN_FILTER: 0x2801, TEXTURE_MAG_FILTER: 0x2800, NEAREST: 0x2600, TEXTURE_WRAP_S: 0x2802,
    TEXTURE_WRAP_T: 0x2803, CLAMP_TO_EDGE: 0x812F, BLEND: 0x0BE2, DEPTH_TEST: 0x0B71, SCISSOR_TEST: 0x0C11, TRIANGLES: 4,
  };
  const f32 = (x) => Math.fround(x);
  const units = [];
  let active = 0;
  const uniforms = {};
  const log = { uploads: [], deleted: [], draws: 0, puts: 0 };
  let glCanvas = null;
  const gl = {
    ...E,
    get drawingBufferWidth() { return glCanvas.width; },
    get drawingBufferHeight() { return glCanvas.height; },
    isContextLost: () => false,
    getParameter: (p) => (p === E.MAX_TEXTURE_SIZE ? 16384 : 0),
    createShader: () => ({}), shaderSource() {}, compileShader() {}, getShaderParameter: () => true, getShaderInfoLog: () => '', deleteShader() {},
    createProgram: () => ({}), attachShader() {}, linkProgram() {}, getProgramParameter: () => true, getProgramInfoLog: () => '', deleteProgram() {},
    createVertexArray: () => ({}), bindVertexArray() {},
    getUniformLocation: (_p, name) => name,
    createTexture: () => ({ deleted: false }),
    activeTexture(u) { active = u - E.TEXTURE0; },
    bindTexture(_t, tex) { units[active] = tex; },
    pixelStorei() {}, texParameteri() {},
    texImage2D(_t, _l, internal, w, h, _b, format, type, data) {
      const tex = units[active];
      Object.assign(tex, { internal, format, type, w, h, data: Uint8Array.from(data) });
      log.uploads.push(tex);
    },
    getError: () => E.NO_ERROR,
    deleteTexture(tex) { tex.deleted = true; log.deleted.push(tex); },
    viewport() {}, disable() {}, useProgram() {},
    uniform1i(loc, v) { uniforms[loc] = v; },
    uniform3fv(loc, v) { uniforms[loc] = Array.from(v, f32); },
    uniform4fv(loc, v) { uniforms[loc] = Array.from(v, f32); },
    drawArrays() { log.draws++; runFrag(); },
  };
  // The compositor's FRAG, transcribed (float32 uniforms, as the GPU holds them).
  function runFrag() {
    const W = glCanvas.width; const H = glCanvas.height;
    const rawTex = units[uniforms.uRaw];
    const maskTex = units[uniforms.uMask];
    assert.ok(rawTex && !rawTex.deleted && rawTex.internal === E.RGBA8 && rawTex.format === E.RGBA, 'uRaw names a live RGBA8 texture');
    const out = new Uint8ClampedArray(W * H * 4);
    for (let yb = 0; yb < H; yb++) {
      for (let x = 0; x < W; x++) {
        const ty = uniforms.uHeight - 1 - yb;
        const t = (ty * rawTex.w + x) * 4;
        const v = [0, 1, 2, 3].map((c) => rawTex.data[t + c] / 255);
        let px = [0, 0, 0, 0];
        let hidden = uniforms.uAlphaMode === 2 && v[3] === 0;
        if (!hidden && uniforms.uAlphaMode === 3) {
          assert.ok(maskTex && !maskTex.deleted && maskTex.internal === E.R8 && maskTex.format === E.RED, 'uMask names a live R8 texture in mode 3');
          hidden = maskTex.data[ty * maskTex.w + x] / 255 === 0;
        }
        if (!hidden) {
          const c = [0, 0, 0];
          for (let i = 0; i < 4; i++) {
            if (!(uniforms.uEnabled[i] > 0.5 && uniforms.uNumChannels > i)) continue;
            let k = Math.min(1, Math.max(0, (v[i] - uniforms.uMin[i]) / Math.max(uniforms.uMax[i] - uniforms.uMin[i], 0.0001)));
            if (uniforms.uGamma[i] !== 1) k = Math.pow(k, uniforms.uGamma[i]);
            k *= uniforms.uOpacity[i];
            for (let j = 0; j < 3; j++) c[j] += k * uniforms.uColor[i * 3 + j];
          }
          if (uniforms.uAlphaMode === 0 && Math.hypot(...c) < 0.005) hidden = true;
          else px = [...c.map((q) => Math.round(Math.min(1, Math.max(0, q)) * 255)), 255];
        }
        // Framebuffer row yb is canvas row H − 1 − yb once drawImage'd.
        out.set(px, ((H - 1 - yb) * W + x) * 4);
      }
    }
    glCanvas.pixels = out;
  }
  function canvas2d() {
    const c = { width: 0, height: 0, pixels: null, addEventListener() {} };
    const ctx = {
      clearRect() { c.pixels = new Uint8ClampedArray(c.width * c.height * 4); },
      drawImage(src) { c.pixels = new Uint8ClampedArray(src.pixels); },
      createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
      putImageData(img) { log.puts++; c.pixels = new Uint8ClampedArray(img.data); },
    };
    c.getContext = (kind) => {
      if (kind === 'webgl2') { glCanvas = c; return gl; }
      return kind === '2d' ? ctx : null;
    };
    return c;
  }
  const SCG = loadModule('js/core/slice-compositor.js', 'SliceCompositor', { THREE, document: { createElement: () => canvas2d() } });

  const w = 13; const h = 9;
  const mask = footprintMask(w, h, 1);
  const rawA = { ...randomRaw(w, h, 31, 0.35), channels: 4, projected: true, coverage: false, coverageMask: mask };
  rawA.data.set([240, 240, 240, 240], 0);
  const target = canvas2d();
  const drawn = SCG.compose(rawA, SLAB_STATE, { target });
  assert.equal(drawn, target, 'drawn into the caller\'s canvas');
  assert.equal(log.draws, 1, 'the GPU path drew');
  assert.equal(log.puts, 0, 'no CPU fallback');
  assert.equal(uniforms.uAlphaMode, 3, 'mode 3: coverage mask');
  assert.equal(uniforms.uRaw, 0, 'the raw on unit 0');
  assert.equal(uniforms.uMask, 1, 'the mask on unit 1');
  const maskTex = units[1];
  assert.ok(maskTex && maskTex.internal === E.R8 && maskTex.format === E.RED && maskTex.type === E.UNSIGNED_BYTE && maskTex.w === w && maskTex.h === h, 'R8 texture of w × h');
  assert.deepEqual([...maskTex.data], [...mask], 'the mask bytes as they are (rows top-down, flipped at the fetch like the raw)');
  const cpu = SC.composePixels(rawA, SLAB_STATE);
  for (let i = 0; i < w * h; i++) {
    assert.equal(target.pixels[i * 4 + 3], cpu[i * 4 + 3], `GPU alpha = CPU alpha at pixel ${i}`);
    assert.equal(target.pixels[i * 4 + 3], mask[i] ? 255 : 0, `GPU alpha follows the mask at pixel ${i}`);
    for (let k = 0; k < 3; k++) {
      assert.ok(Math.abs(target.pixels[i * 4 + k] - cpu[i * 4 + k]) <= 1, `GPU colour within one unit of the CPU at pixel ${i}`);
    }
  }
  const bytesA = w * h * 4 + w * h;
  assert.equal(SCG.textureBytes(), bytesA, 'raw RGBA8 + mask R8 held');

  // A native refresh: new raw values, the same frame and mask → the mask is not re-uploaded.
  const uploadsBefore = log.uploads.length;
  const rawB = { ...randomRaw(w, h, 32, 0.35), channels: 4, projected: true, coverage: false, coverageMask: mask };
  SCG.compose(rawB, SLAB_STATE, { target });
  assert.equal(log.uploads.length, uploadsBefore + 1, 'one upload: the new raw alone');
  assert.equal(units[1], maskTex, 'the cached mask texture is bound again');
  // The Studio releases the previous picture after colouring the new one.
  SCG.release(rawA);
  assert.ok(!maskTex.deleted, 'the mask survives the release of a raw while another cached raw uses it');
  assert.equal(SCG.textureBytes(), bytesA, 'raw B + the mask');
  SCG.release(rawB);
  assert.ok(maskTex.deleted, 'released with the last raw that used it');
  assert.equal(SCG.textureBytes(), 0, 'nothing held');

  // No mask: uMask shares the raw's unit; a single plane keeps the threshold.
  const plane = { ...randomRaw(w, h, 33, 0.35), channels: 4 };
  SCG.compose(plane, SLAB_STATE, { target });
  assert.equal(uniforms.uAlphaMode, 0, 'one plane: threshold');
  assert.equal(uniforms.uMask, 0, 'uMask on the raw\'s unit, no unit left empty');
  const cpuPlane = SC.composePixels(plane, SLAB_STATE);
  for (let i = 0; i < w * h; i++) assert.equal(target.pixels[i * 4 + 3], cpuPlane[i * 4 + 3], `one plane: GPU alpha = CPU alpha at ${i}`);
  // A coverage raw ignores a mask it happens to carry: no R8 upload.
  const uploads3 = log.uploads.length;
  const raw3 = { ...randomRaw(w, h, 34, 0.3), channels: 3, projected: true, coverage: true, coverageMask: mask };
  SCG.compose(raw3, SLAB_STATE, { target });
  assert.equal(uniforms.uAlphaMode, 2, 'channel-3 coverage');
  assert.equal(log.uploads.length, uploads3 + 1, 'the raw alone is uploaded');
  assert.ok(log.uploads.at(-1).internal === E.RGBA8, 'no mask texture');
  const cpu3 = SC.composePixels(raw3, SLAB_STATE);
  for (let i = 0; i < w * h; i++) assert.equal(target.pixels[i * 4 + 3], cpu3[i * 4 + 3], `coverage raw: GPU alpha = CPU alpha at ${i}`);
  SCG.release();
  assert.equal(SCG.textureBytes(), 0, 'release() frees every texture, masks included');
  console.log('four-channel slabs, coverage mask (GPU path, emulated context): OK');
}

// ── 12. Texture budgets: masks are counted apart from the raws ─────────────────
// A Compare Studio of four 4-channel z-stack MIP cells whose raws alone fit the 256 MiB
// raw budget: charged to the same budget, their masks (a quarter of a raw each) pushed
// the set over it, and every all-cell recolour evicted the next cell's raw to upload the
// current one — each raw re-uploaded on every pass, in a cycle. With the masks' own
// budget (a quarter of the raws') the second pass uploads nothing.
{
  const E = {
    TEXTURE_2D: 1, TEXTURE0: 0x84C0, TEXTURE1: 0x84C1, RGBA8: 2, RGBA: 3, R8: 4, RED: 5, UNSIGNED_BYTE: 6, NO_ERROR: 0,
    MAX_TEXTURE_SIZE: 7, VERTEX_SHADER: 8, FRAGMENT_SHADER: 9, COMPILE_STATUS: 10, LINK_STATUS: 11, UNPACK_ALIGNMENT: 12,
    UNPACK_FLIP_Y_WEBGL: 13, UNPACK_PREMULTIPLY_ALPHA_WEBGL: 14, UNPACK_COLORSPACE_CONVERSION_WEBGL: 15, NONE: 0,
    TEXTURE_MIN_FILTER: 16, TEXTURE_MAG_FILTER: 17, NEAREST: 18, TEXTURE_WRAP_S: 19, TEXTURE_WRAP_T: 20, CLAMP_TO_EDGE: 21,
    BLEND: 22, DEPTH_TEST: 23, SCISSOR_TEST: 24, TRIANGLES: 4,
  };
  const uploads = [];
  const deleted = [];
  let glCanvas = null;
  const gl = {
    ...E,
    get drawingBufferWidth() { return glCanvas.width; },
    get drawingBufferHeight() { return glCanvas.height; },
    isContextLost: () => false,
    getParameter: () => 16384,
    createShader: () => ({}), shaderSource() {}, compileShader() {}, getShaderParameter: () => true, getShaderInfoLog: () => '', deleteShader() {},
    createProgram: () => ({}), attachShader() {}, linkProgram() {}, getProgramParameter: () => true, getProgramInfoLog: () => '', deleteProgram() {},
    createVertexArray: () => ({}), bindVertexArray() {}, getUniformLocation: (_p, n) => n,
    createTexture: () => ({}), activeTexture() {}, bindTexture() {}, pixelStorei() {}, texParameteri() {},
    texImage2D(_t, _l, internal, w, h, _b, _f, _ty, data) { uploads.push({ internal, bytes: data.length }); },
    getError: () => 0, deleteTexture(t) { deleted.push(t); }, viewport() {}, disable() {}, useProgram() {},
    uniform1i() {}, uniform3fv() {}, uniform4fv() {}, drawArrays() {},
  };
  const canvas = () => {
    const c = { width: 0, height: 0, addEventListener() {} };
    const ctx = { clearRect() {}, drawImage() {}, createImageData: () => ({}), putImageData() { throw new Error('CPU fallback'); } };
    c.getContext = (k) => (k === 'webgl2' ? (glCanvas = c, gl) : k === '2d' ? ctx : null);
    return c;
  };
  const SCB = loadModule('js/core/slice-compositor.js', 'SliceCompositor', { document: { createElement: canvas } });
  const BUDGET = 256 * 1024 * 1024;
  // 3700² cells: four raws (4 B/px) fit the raw budget, raws + masks (5 B/px) do not.
  const side = 3700;
  const n = side * side;
  assert.ok(4 * 4 * n <= BUDGET && 4 * 5 * n > BUDGET, 'the case: raws alone fit, raws and masks together would not');
  const cells = [0, 1, 2, 3].map(() => ({
    data: new Uint8Array(n * 4), width: side, height: side, channels: 4, projected: true, coverage: false,
    coverageMask: new Uint8Array(n).fill(255),
  }));
  const state = [0, 1, 2, 3].map(() => ({ enabled: true, color: '#ffffff', min: 0, max: 1, gamma: 1, opacity: 1 }));
  const target = canvas();
  for (const c of cells) assert.equal(SCB.compose(c, state, { target }), target, 'drawn on the GPU');
  assert.equal(uploads.length, 8, 'the opening uploads four raws and four masks');
  assert.equal(uploads.filter((u) => u.internal === E.R8).length, 4, 'four of them R8 masks');
  assert.equal(deleted.length, 0, 'nothing evicted');
  assert.equal(SCB.textureBytes(), 4 * 5 * n, 'every raw and mask held');
  for (let pass = 0; pass < 3; pass++) for (const c of cells) SCB.compose(c, state, { target });
  assert.equal(uploads.length, 8, 'three all-cell recolours upload nothing (the masks evict no raw)');
  assert.equal(deleted.length, 0, 'and evict nothing');

  // Each kind stays within its own budget: a fifth raw evicts the oldest raw, never a
  // mask; masks beyond a quarter of the raw budget evict the oldest mask, never a raw.
  const fifth = { ...cells[0], data: new Uint8Array(n * 4), coverageMask: cells[0].coverageMask };
  SCB.compose(fifth, state, { target });
  assert.equal(uploads.length, 9, 'the fifth raw is uploaded, its (shared) mask is cached');
  assert.equal(deleted.length, 1, 'one texture evicted to make room');
  assert.equal(SCB.textureBytes(), 4 * 5 * n, 'four raws and four masks held again');
  SCB.compose(cells[1], state, { target });
  assert.equal(uploads.length, 9, 'cell 1 is still cached: the evicted texture was the oldest raw, cell 0\'s');
  SCB.compose(cells[0], state, { target });
  assert.equal(uploads.length, 10, 'cell 0\'s raw comes back; its mask never left');
  assert.ok(uploads.at(-1).internal === E.RGBA8, 'a raw upload alone');
  SCB.release();
  assert.equal(SCB.textureBytes(), 0);
  console.log('texture budgets (masks counted apart, no recolour thrash): OK');
}

console.log('slice compositor: OK');
