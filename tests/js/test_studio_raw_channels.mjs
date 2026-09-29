// The Studio's channel controls work on the slice's RAW values, at native resolution,
// through the preview → native progressive upgrade:
//   • VolumeSlicer.renderRawWithMaterial renders the RAW_OUTPUT variant of the slice
//     shader through a cached material (one program per source, no blending), reads the
//     window back and hands a top-down copy of it; the raw fallback is a DataTexture of
//     the exact bytes (nearest, no flip, no premultiply) placed like the colour fallback,
//     with a per-channel mask for the channels the native pass did not load;
//   • VolumeSlicer.recompose re-colours a raw slice without rendering;
//   • StudioEditor shows the raw composite (never the viewer's colour canvas), a channel
//     edit re-colours it in place (no re-crop: the geometry and annotations stay put),
//     a progressive refresh (imageOnly) and the final native result keep the DOCUMENT's
//     channel state, the histograms are the slice's own, edits are coalesced to one
//     draw per frame with the last state always drawn (even with animation frames
//     frozen), and closing drops every raw buffer;
//   • the Compare Studio re-colours a cell from its raw values on the figure's backdrop;
//   • the viewer wires it (preview raw, native raw with preview fallback and the
//     skipped channels, raw for the Compare Studio, none for a thumbnail) and both pages
//     load the compositor.
//
// Run: node tests/js/test_studio_raw_channels.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT } from './harness.mjs';

const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const plain = (o) => (o == null ? o : JSON.parse(JSON.stringify(o)));

// ── A browser-ish realm: fake canvases, fake timers, three.js, the three modules ──
let clock = 1000;
const timers = new Map();
let timerId = 0;
const rafs = [];
let getImageDataCalls = 0;

function makeCanvas(tag = 'canvas') {
  const log = [];
  const canvas = {
    tag, width: 0, height: 0, style: {}, dataset: {}, id: '', innerHTML: '', log, __pixels: null,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener() {}, removeEventListener() {}, appendChild() {}, remove() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
    parentElement: null,
    querySelector: () => null, querySelectorAll: () => [],
  };
  const state = { fillStyle: '#000' };
  const ctx = new Proxy(state, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (prop === 'createImageData') return (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) });
      if (prop === 'putImageData') return (img) => { canvas.__pixels = new Uint8ClampedArray(img.data); log.push(['putImageData']); };
      if (prop === 'getImageData') return (x, y, w, h) => { getImageDataCalls++; return { data: new Uint8ClampedArray(w * h * 4) }; };
      if (prop === 'drawImage') return (...a) => log.push(['drawImage', ...a]);
      if (prop === 'fillRect') return (...a) => log.push(['fillRect', target.fillStyle, ...a]);
      if (prop === 'clearRect') return (...a) => log.push(['clearRect', ...a]);
      if (prop === 'measureText') return (text) => ({ width: String(text).length * 10 });
      return () => {};
    },
    set(target, prop, value) { target[prop] = value; return true; },
  });
  canvas.getContext = (kind) => (kind === '2d' ? ctx : null); // no WebGL2: the compositor's CPU path
  return canvas;
}

const elements = {
  'studio-layout': makeCanvas('studio-layout'),
  'studio-canvas': makeCanvas('studio-canvas'),
  'studio-channels': makeCanvas('studio-channels'),
};
const panelCalls = { init: [], histograms: [], setState: [] };
let channelCallback = null;
const sandbox = {
  console, encodeURIComponent, Math, JSON, Date,
  setTimeout: (fn, ms) => { const id = ++timerId; timers.set(id, fn); return id; },
  clearTimeout: (id) => { timers.delete(id); },
  requestAnimationFrame: (fn) => { rafs.push(fn); return rafs.length; },
  cancelAnimationFrame: () => {},
  performance: { now: () => clock },
  ExportManager: {},
  createChannelPanel: () => ({
    init(id, meta, cb) {
      panelCalls.init.push(plain(meta.channels));
      channelCallback = cb;
      meta.channels.forEach((c, i) => cb(i, { ...c })); // the seeding replay (ignored)
    },
    setState(state) { panelCalls.setState.push(plain(state)); },
    setHistograms(h) { panelCalls.histograms.push(h); },
  }),
  document: {
    getElementById: (id) => elements[id] || null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    createElement: () => makeCanvas('created'),
    body: { appendChild() {} },
  },
  window: { innerWidth: 800, innerHeight: 600, addEventListener() {} },
};
const ctx = vm.createContext(sandbox);
vm.runInContext(readFileSync(path.join(ROOT, 'js/vendor/three.min.js'), 'utf8'), ctx, { filename: 'three.min.js' });
vm.runInContext(read('js/core/slice-compositor.js') + '\n;globalThis.__SC = SliceCompositor;', ctx, { filename: 'slice-compositor.js' });
vm.runInContext(read('js/viewers/volume-slicer.js') + '\n;globalThis.__VS = VolumeSlicer;', ctx, { filename: 'volume-slicer.js' });
const STUDIO = read('js/components/studio-editor.js');
const RETURN_RE = /\n  return \{\n    init,/;
assert.ok(RETURN_RE.test(STUDIO), 'studio-editor.js still ends its IIFE with `return { init, …`');
const HOOK = `
  globalThis.__studio = {
    get doc() { return _doc; },
    get sliceResult() { return _sliceResult; },
    get sliceImage() { return _sliceImage; },
    get history() { return _history; },
  };`;
vm.runInContext(STUDIO.replace(RETURN_RE, (m) => `\n${HOOK}${m}`) + '\n;globalThis.__SE = StudioEditor;', ctx, { filename: 'studio-editor.js' });
const { THREE, __SC: SC, __VS: VolumeSlicer, __SE: Studio, __studio: S } = ctx;

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
function randomRaw(w, h, channels, seed) {
  const next = rng(seed);
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    if (next() < 0.25) continue;
    for (let c = 0; c < channels; c++) data[i * 4 + c] = Math.floor(next() * 256);
  }
  return { data, width: w, height: h, channels };
}
const same = (a, b, msg) => {
  assert.ok(a && b && a.length === b.length, `${msg}: sizes`);
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) assert.fail(`${msg}: byte ${i} = ${a[i]}, expected ${b[i]}`);
};
const runTimers = () => { const list = [...timers.values()]; timers.clear(); list.forEach(fn => fn()); };

// ── 1. VolumeSlicer.renderRawWithMaterial ─────────────────────────────────────
const renders = [];
const renderer = {
  autoClear: true,
  _target: null,
  getRenderTarget() { return this._target; },
  setRenderTarget(t) { this._target = t; },
  getViewport(v) { return v.set(0, 0, 800, 600); },
  setViewport() {},
  getPixelRatio: () => 1,
  clear() {},
  render(scene) {
    const m = scene.children[0].material;
    renders.push({
      material: m, target: this._target, defines: { ...m.defines }, blending: m.blending,
      uvWindow: m.uniforms.uvWindow.value.toArray(), normal: m.uniforms.sliceNormal.value.toArray(),
      fallbackTex: m.uniforms.fallbackTex?.value || null, fallbackRect: m.uniforms.fallbackRect.value.toArray(),
      fallbackChannels: m.uniforms.fallbackChannels?.value.toArray() || null,
    });
  },
  // GL rows from the bottom: byte 0 = the GL row, byte 1 = the column.
  readRenderTargetPixels(target, x, y, w, h, buf) {
    for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) {
      const o = (r * w + c) * 4;
      buf[o] = r & 255; buf[o + 1] = c & 255; buf[o + 2] = 7; buf[o + 3] = 9;
    }
  },
};
const volumeMaterial = {
  defines: { ENABLE_SVR: 1 },
  uniforms: { svrAtlas0: { value: { fakeAtlas: true } }, numChannels: { value: 3 } },
};
{
  assert.ok(VolumeSlicer.init({ renderer, material: volumeMaterial }), 'slicer initialises on the fake renderer');
  VolumeSlicer.setPlaneSpec({ mode: 'xy', value: 0.3 });
  const before = plain(VolumeSlicer.getPlaneSpec());

  const raw = VolumeSlicer.renderRawWithMaterial(volumeMaterial, { mode: 'xz', value: 0.5 }, 100, { window: { x: 10, y: 20, w: 30, h: 40 } });
  assert.ok(raw && raw.width === 30 && raw.height === 40 && raw.channels === 3, 'window size, channel count from numChannels');
  assert.equal(raw.data.length, 30 * 40 * 4);
  for (let y = 0; y < 40; y += 13) for (let x = 0; x < 30; x += 7) {
    assert.equal(raw.data[(y * 30 + x) * 4], 39 - y, `row ${y} is GL row ${39 - y} (top-down copy)`);
    assert.equal(raw.data[(y * 30 + x) * 4 + 1], x, 'columns untouched');
  }
  assert.equal(raw.projected, false, 'one plane: not a projected slab');
  assert.equal(raw.coverage, false, 'one plane: no coverage channel');
  const r0 = renders.at(-1);
  assert.equal(r0.defines.RAW_OUTPUT, 1, 'the RAW_OUTPUT variant');
  assert.equal(r0.defines.ENABLE_SVR, 1, 'the source material\'s SVR define');
  assert.ok(!('FALLBACK_TEX' in r0.defines), 'no fallback asked, no fallback define');
  assert.equal(r0.blending, THREE.NoBlending, 'no blending: raw bytes land untouched');
  assert.deepEqual([...r0.uvWindow].map(v => +v.toFixed(12)), [0.1, 0.4, 0.3, 0.4], 'the window, in GL orientation');
  assert.deepEqual([...r0.normal].map(v => Math.round(v) + 0), [0, 1, 0], 'the handed spec (xz) was rendered');
  assert.deepEqual(plain(VolumeSlicer.getPlaneSpec()), before, 'the inspector plane is left alone');

  // Same source again: the same material (one shader compile per pass).
  VolumeSlicer.renderRawWithMaterial(volumeMaterial, { mode: 'xz', value: 0.5 }, 100, { window: { x: 10, y: 20, w: 30, h: 40 } });
  assert.equal(renders.at(-1).material, r0.material, 'the raw material is cached per source');
  assert.notEqual(renders.at(-1).target, r0.target, 'without keepTarget the target is released after each render');
  VolumeSlicer.renderRawWithMaterial(volumeMaterial, { mode: 'xz' }, 100, { keepTarget: true });
  const kept = renders.at(-1).target;
  VolumeSlicer.renderRawWithMaterial(volumeMaterial, { mode: 'xz' }, 100, { keepTarget: true });
  assert.equal(renders.at(-1).target, kept, 'keepTarget: one target for the whole pass');

  // The raw fallback: exact bytes, nearest, no flip, placed like the colour fallback.
  const fb = { data: new Uint8Array(30 * 40 * 4).fill(3), width: 30, height: 40, channels: 3 };
  const rect = { x: 10, y: 20, x2: 39, y2: 59, renderRes: 100 };
  VolumeSlicer.renderRawWithMaterial(volumeMaterial, { mode: 'xy' }, 100, {
    window: { x: 10, y: 20, w: 30, h: 40 }, fallbackRaw: { raw: fb, rect }, fallbackChannels: [1, 3]
  });
  const r1 = renders.at(-1);
  assert.equal(r1.defines.FALLBACK_TEX, 1, 'fallback define');
  assert.notEqual(r1.material, r0.material, 'the fallback variant is its own program');
  const tex = r1.fallbackTex;
  assert.ok(tex && tex.isDataTexture, 'a DataTexture, never a (premultiplying) canvas');
  assert.equal(tex.image.data, fb.data, 'the preview raw bytes themselves');
  assert.equal(tex.minFilter, THREE.NearestFilter); assert.equal(tex.magFilter, THREE.NearestFilter);
  assert.equal(tex.flipY, false); assert.equal(tex.generateMipmaps, false); assert.equal(tex.premultiplyAlpha, false);
  assert.equal(tex.format, THREE.RGBAFormat); assert.equal(tex.type, THREE.UnsignedByteType);
  assert.deepEqual([...r1.fallbackRect].map(v => +v.toFixed(12)), [0.1, 0.4, 0.3, 0.4], 'the fallback covers exactly the window');
  assert.deepEqual([...r1.fallbackChannels], [0, 1, 0, 1], 'channels 1 and 3 always from the preview');
  VolumeSlicer.renderRawWithMaterial(volumeMaterial, { mode: 'xy' }, 100, { fallbackRaw: { raw: fb, rect } });
  assert.equal(renders.at(-1).fallbackTex, tex, 'the same fallback bytes: the same texture');
  assert.deepEqual([...renders.at(-1).fallbackChannels], [0, 0, 0, 0], 'no mask asked: none');

  VolumeSlicer.releaseForeign();
  VolumeSlicer.renderRawWithMaterial(volumeMaterial, { mode: 'xy' }, 100, {});
  assert.notEqual(renders.at(-1).material, r0.material, 'releaseForeign drops the cached raw material');
  assert.equal(VolumeSlicer.renderRawWithMaterial(null, {}, 100), null, 'no material: null');

  // A slab's raw says so (the shader's own test: projMode ≠ 0 and more than one
  // sample), whichever page renders it — the z-stack MIP, an inspector average — so
  // SliceCompositor draws it opaque as the colour path draws a slab.
  const mip = VolumeSlicer.renderRawWithMaterial(volumeMaterial, { mode: 'xy', slabThickness: 9, slabStepNorm: 0.01, projection: 'mip' }, 64);
  assert.equal(mip.projected, true, 'a MIP slab is projected');
  assert.equal(mip.coverage, true, 'three channels: channel 3 carries the coverage');
  const avg = VolumeSlicer.renderRawWithMaterial(volumeMaterial, { mode: 'oblique', yaw: 30, slabThickness: 4, projection: 'average' }, 64);
  assert.equal(avg.projected, true, 'an average slab is projected');
  const thin = VolumeSlicer.renderRawWithMaterial(volumeMaterial, { mode: 'xy', slabThickness: 1, projection: 'mip' }, 64);
  assert.equal(thin.projected, false, 'one sample is one plane, whatever the projection');
  const single = VolumeSlicer.renderRawWithMaterial(volumeMaterial, { mode: 'xy', slabThickness: 9, projection: 'single' }, 64);
  assert.equal(single.projected, false, "'single' is never projected");
  const four = { defines: { ENABLE_SVR: 1 }, uniforms: { svrAtlas0: { value: { fakeAtlas: true } }, numChannels: { value: 4 } } };
  const mip4 = VolumeSlicer.renderRawWithMaterial(four, { mode: 'xy', slabThickness: 9, projection: 'mip' }, 64);
  assert.equal(mip4.projected, true);
  assert.equal(mip4.coverage, false, 'four channels: no spare channel, the whole slab frame is opaque');
  assert.equal(mip4.channels, 4);
  VolumeSlicer.releaseForeign();

  // The shader: the raw branch reads texels, projects per channel, and uses the raw fallback.
  const frag = read('js/viewers/volume-slicer.js');
  // rawAt and the slab projection are shared by both variants (the colour path projects
  // the raw values too, then colours them: test_slice_compositor.mjs §8).
  const rawAtAt = frag.indexOf('vec4 rawAt(vec3 uvw, out bool present)');
  assert.ok(rawAtAt > 0 && rawAtAt < frag.indexOf('#ifdef RAW_OUTPUT'), 'rawAt, outside the RAW_OUTPUT variant');
  assert.ok(/vec4 projectSlab\(vec3 base, out int hits, out bool missing\)/.test(frag), 'one slab projection');
  assert.ok(/if \(projMode == 1\) raw = max\(raw, s\);\s*else raw \+= s;/.test(frag), 'per-channel MIP / sum');
  assert.ok(/if \(hits > 0 && projMode == 2\) raw \/= float\(hits\);/.test(frag), 'per-channel mean');
  assert.ok(/raw = projectSlab\(base, hits, missing\);\s*if \(hits == 0\) \{ fragColor = vec4\(0\.0\); return; \}\s*if \(numChannels < 4\) raw\.a = 1\.0;/.test(frag),
    'the raw slab: the projection, transparent off the volume, the coverage in the unused channel 3');
  assert.ok(/texelFetch\(fallbackTex, ivec2\(p\.x, size\.y - 1 - p\.y\), 0\)/.test(frag), 'raw fallback read exactly, rows flipped');
  assert.ok(/if \(missing\) \{ fragColor = covered \? f : vec4\(0\.0\); return; \}/.test(frag), 'a missing brick shows the fallback, as the colour path');
  assert.ok(/if \(covered\) raw = mix\(raw, f, fallbackChannels\);/.test(frag), 'skipped channels from the fallback');
  assert.ok(/precision highp sampler2D;/.test(frag), 'the fallback is sampled at highp');
  console.log('VolumeSlicer.renderRawWithMaterial: OK');
}

// ── 2. VolumeSlicer.recompose / computeChannelHistograms on a raw slice ───────
{
  const raw = randomRaw(12, 9, 2, 11);
  const state = [{ color: '#00FF00', min: 0.1, max: 0.7, gamma: 1.4, opacity: 0.8, enabled: true },
    { color: '#FF00FF', min: 0, max: 1, gamma: 1, opacity: 0.7, enabled: true }];
  const n = renders.length;
  const out = VolumeSlicer.recompose({ raw, width: 12, height: 9, source: 'native-slicer', renderRes: 64 }, state);
  assert.equal(renders.length, n, 'no render: the raw values are re-coloured');
  assert.equal(out.width, 12); assert.equal(out.height, 9); assert.equal(out.renderRes, 64, 'the rest of the slice kept');
  same(out.canvas.__pixels, SC.composePixels(raw, state), 'recompose = the compositor');
  assert.equal(VolumeSlicer.computeChannelHistograms({ raw }, 256).length, 2, 'histograms of a raw picture');
  assert.equal(VolumeSlicer.computeChannelHistograms({ raw: raw.data, width: 12, height: 9 }, 64)[0].bins, 64, 'or of its bytes');
  assert.equal(VolumeSlicer.computeChannelHistograms(null).length, 0, 'nothing: empty, no TypeError');
  console.log('VolumeSlicer.recompose (raw): OK');
}

// ── 3. The single-slice Studio ─────────────────────────────────────────────────
const viewerState = [
  { idx: 0, name: 'A', color: '#00FF00', min: 0, max: 1, midtone: 0.5, gamma: 1, opacity: 0.7, enabled: true },
  { idx: 1, name: 'B', color: '#FF00FF', min: 0, max: 1, midtone: 0.5, gamma: 1, opacity: 0.7, enabled: false },
];
{
  Studio.init();
  const W = 40; const H = 30;
  const raw1 = randomRaw(W, H, 2, 1);
  const colour = makeCanvas('viewer-colour'); colour.width = W; colour.height = H;
  Studio.open({
    canvas: colour, raw: raw1, width: W, height: H, renderRes: 200, cropRect: { x: 5, y: 6, x2: 44, y2: 35, renderRes: 200 },
    source: 'studio-preview', quality: 'preview', planeSpec: { mode: 'xy', value: 0.5 }, pixelSizeUm: { x: 2, y: 2 },
    channelState: viewerState,
  });
  assert.notEqual(S.sliceImage, colour, 'the Studio shows the raw composite, not the viewer canvas');
  same(S.sliceImage.__pixels, SC.composePixels(raw1, viewerState), 'opening picture = raw coloured with the slice\'s own state');
  assert.deepEqual(plain(S.doc.channelState), plain(viewerState), 'the slice seeds the document');
  const hist = panelCalls.histograms.at(-1);
  assert.equal(hist.length, 2); assert.equal(hist[0].bins, 256); assert.ok(hist[0].total > 0, 'the slice\'s own histograms');
  assert.ok(typeof channelCallback === 'function', 'the channel panel is wired');

  // An edit (a click after a quiet spell): drawn at once, in place, no re-crop.
  const reads = getImageDataCalls;
  const image = S.sliceImage;
  clock += 100;
  channelCallback(1, { ...viewerState[1], enabled: true, color: '#00AAFF', max: 0.5 });
  const edited = [viewerState[0], { ...viewerState[1], enabled: true, color: '#00AAFF', max: 0.5 }];
  same(S.sliceImage.__pixels, SC.composePixels(raw1, edited), 'the edit is drawn from the raw values');
  assert.equal(S.sliceImage, image, 'the same canvas, re-coloured in place');
  assert.equal(getImageDataCalls, reads, 'no pixel scan: nothing is re-cropped');
  assert.deepEqual([S.doc.sourceSlice.width, S.doc.sourceSlice.height], [W, H], 'the geometry is untouched');

  // A drag: coalesced into one trailing draw, the last state drawn even though
  // animation frames never run (a hidden page) — the timer backstop fires.
  const stateAfterClick = new Uint8ClampedArray(S.sliceImage.__pixels);
  channelCallback(0, { ...viewerState[0], max: 0.4 });
  channelCallback(0, { ...viewerState[0], max: 0.3 });
  same(S.sliceImage.__pixels, stateAfterClick, 'inside a frame: not drawn yet');
  assert.equal(timers.size, 1, 'one trailing draw scheduled');
  runTimers();
  const dragged = [{ ...viewerState[0], max: 0.3 }, edited[1]];
  same(S.sliceImage.__pixels, SC.composePixels(raw1, dragged), 'the last state of the drag is drawn');

  // A progressive refresh of the native pass: raw only, the viewer's channel state on
  // it — the document's edits win, the frame stays.
  const raw2 = randomRaw(W, H, 2, 2);
  Studio.setSliceResult({ canvas: null, raw: raw2, width: W, height: H, source: 'native-slicer', quality: 'native', channelState: viewerState, planeSpec: { mode: 'xy', value: 0.5 }, partial: true }, { imageOnly: true });
  same(S.sliceImage.__pixels, SC.composePixels(raw2, dragged), 'refresh coloured with the document state');
  assert.deepEqual(plain(S.doc.channelState), plain(dragged), 'the document state is not reverted');
  assert.equal(S.sliceResult.raw, raw2, 'the new raw is kept for the next edit');
  clock += 100;
  channelCallback(0, { ...viewerState[0], max: 0.2 });
  const again = [{ ...viewerState[0], max: 0.2 }, edited[1]];
  same(S.sliceImage.__pixels, SC.composePixels(raw2, again), 'an edit after a refresh re-colours the refreshed values');

  // The final native result (not imageOnly): the document state still wins, the panel
  // is rebuilt on it with the new slice's histograms.
  const raw3 = randomRaw(W, H, 2, 3);
  let nonEmpty = 0;
  for (let i = 0; i < W * H; i++) if (raw3.data[i * 4] || raw3.data[i * 4 + 1]) nonEmpty++;
  Studio.setSliceResult({ canvas: null, raw: raw3, width: W, height: H, source: 'native-slicer', quality: 'native', channelState: viewerState, planeSpec: { mode: 'xy', value: 0.5 }, pixelSizeUm: { x: 2, y: 2 }, missingChunks: 0 });
  same(S.sliceImage.__pixels, SC.composePixels(raw3, again), 'final picture coloured with the document state');
  assert.deepEqual(plain(S.doc.channelState), plain(again), 'still the operator\'s state');
  assert.deepEqual(panelCalls.init.at(-1), plain(again), 'the channel panel is rebuilt on the document state');
  assert.equal(panelCalls.histograms.at(-1)[0].total, nonEmpty, 'histograms of the native slice');
  assert.equal(S.sliceResult.source, 'native-slicer');

  Studio.setSliceResult({ canvas: null, raw: null, width: W, height: H }, { imageOnly: true });
  assert.equal(S.sliceResult.raw, raw3, 'a result with neither picture nor raw is ignored');

  // Closing drops the raw values.
  Studio.close();
  assert.equal(S.sliceResult.raw, null, 'raw released on close');
  console.log('single-slice Studio on raw values: OK');
}

// ── 4. A slice without raw values keeps the legacy behaviour ──────────────────
{
  const colour = makeCanvas('legacy'); colour.width = 20; colour.height = 10;
  Studio.open({ canvas: colour, width: 20, height: 10, source: 'studio-preview', channelState: viewerState, planeSpec: {} });
  assert.equal(S.sliceImage, colour, 'no raw: the picture as rendered');
  Studio.close();
  console.log('legacy slice: OK');
}

// ── 5. The Compare Studio ──────────────────────────────────────────────────────
{
  const fig = makeCanvas('figure'); fig.width = 200; fig.height = 120;
  const other = makeCanvas('panel-2'); other.width = 50; other.height = 40;
  const rawP = randomRaw(50, 40, 2, 5);
  const stateP = [{ color: '#FF0000', min: 0, max: 1, gamma: 1, opacity: 1, enabled: true },
    { color: '#00FF00', min: 0.1, max: 0.9, gamma: 0.8, opacity: 0.7, enabled: true }];
  Studio.open({
    canvas: fig, width: 200, height: 120, source: 'compare', layoutBackground: '#ffffff',
    pixelSizeUm: { x: 1, y: 1 }, channelState: stateP, dataset: { name: 'a vs b' },
    layoutMaps: [
      { x: 10, y: 20, w: 100, h: 80, pixelSizeUm: { x: 1, y: 1 }, channelState: stateP, raw: rawP, sourceWidth: 50, sourceHeight: 40, sliceResult: { canvas: other, raw: rawP, source: 'gpu-slicer' } },
      { x: 120, y: 20, w: 50, h: 40, pixelSizeUm: { x: 1, y: 1 }, channelState: [{ color: '#fff', enabled: true }], sliceResult: { canvas: other, source: '3d' } },
    ],
  });
  const figure = S.sliceImage;
  assert.notEqual(figure, fig, 'the figure is copied before a cell is redrawn on it');
  const cellDraws = (canvas) => canvas.log.filter(e => e[0] === 'drawImage' && e[2] === 10 && e[3] === 20 && e[4] === 100 && e[5] === 80);
  const fills = figure.log.filter(e => e[0] === 'fillRect' && e[2] === 10 && e[3] === 20);
  assert.equal(fills.length, 1, 'the cell is laid back on the figure backdrop');
  assert.equal(fills[0][1], '#ffffff', 'the backdrop compare.js composed on');
  assert.equal(cellDraws(figure).length, 1, 'cell 1 coloured from its raw values at open');
  same(cellDraws(figure)[0][1].__pixels, SC.composePixels(rawP, stateP), 'cell 1 = raw coloured with the panel state');
  assert.equal(figure.log.filter(e => e[0] === 'drawImage' && e[2] === 120).length, 0, 'a cell without raw values is left as composed');
  assert.equal(panelCalls.histograms.at(-1)[0].bins, 256, 'the active cell\'s own histograms');

  clock += 100;
  channelCallback(1, { ...stateP[1], enabled: false });
  assert.equal(S.sliceImage, figure, 'redrawn in place (no figure copy per edit)');
  assert.equal(cellDraws(figure).length, 2, 'the edited cell is redrawn');
  same(cellDraws(figure)[1][1].__pixels, SC.composePixels(rawP, [stateP[0], { ...stateP[1], enabled: false }]), 'with the edit');
  assert.equal(S.doc.layoutMaps[0].channelState[1].enabled, false, 'the cell state holds the edit');

  Studio.close();
  assert.equal(S.doc.layoutMaps[0].raw, null, 'the cells\' raw values are released on close');
  assert.equal(S.doc.layoutMaps[0].sliceResult.raw, null, 'including the ones held by the panel slice');
  assert.ok(S.history.every(h => (h.doc.layoutMaps || []).every(m => !m.raw)), 'and by the undo history');
  console.log('Compare Studio on raw values: OK');
}

// ── 6. The viewer and the pages wire it ───────────────────────────────────────
{
  const v = read('js/pages/viewer.js');
  const preview = v.slice(v.indexOf('function _renderStudioPreviewSlice('), v.indexOf('function _nativeLabel('));
  assert.ok(/raw: _studioRawFor\(spec, renderRes, cropRect\)/.test(preview), 'the preview carries its raw values (same crop)');
  const rawFor = v.slice(v.indexOf('function _studioRawFor('), v.indexOf('function _studioRawFor(') + 900);
  assert.ok(/_sliceWindowForRect\(cropRect, renderRes\)/.test(rawFor) && /renderRawWithMaterial\(material, spec, renderRes, \{ window: win \}\)/.test(rawFor), 'raw window = the colour crop');
  const upgrade = v.slice(v.indexOf('async function _upgradeStudioSliceToNative('), v.indexOf('function _drawScaleBar('));
  assert.ok(/fallback: \{ canvas: preview\.canvas, raw: preview\.raw \|\| null \}/.test(upgrade), 'the native pass gets the preview raw');
  const native = v.slice(v.indexOf('async function _renderNativeSliceForStudio('), v.indexOf('function _setSliceStatus('));
  assert.ok(/renderRawWithMaterial\(tempMaterial, spec, renderRes, \{\s*window: sliceWindow, fallbackRaw: rawFallback, fallbackChannels: previewOnlyChannels, keepTarget: true/.test(native), 'native refreshes are raw, with the preview as fallback');
  assert.ok(/filter\(c => !wantedChannels\.includes\(c\)\)/.test(native), 'channels not downloaded come from the preview');
  assert.ok(/VolumeSlicer\.releaseForeign\?\.\(\);/.test(native), 'the throwaway material and target are released at the end');
  const current = v.slice(v.indexOf('function getCurrentSliceResult('), v.indexOf('function getCurrentSliceResult(') + 4000);
  assert.equal((current.match(/raw: withRaw \? _studioRawFor\(spec, renderRes, cropRect\) : null/g) || []).length, 2, 'the Compare Studio gets raw values (z-stack and slice)');
  assert.ok(/getCurrentSliceResult\(\{ raw: false \}\)/.test(v), 'a thumbnail skips the raw render');

  const viewerHtml = read('viewer.html');
  const compareHtml = read('compare.html');
  const order = (html, before, after) => html.indexOf(before) > 0 && html.indexOf(before) < html.indexOf(after);
  assert.ok(order(viewerHtml, 'js/core/slice-compositor.js', 'js/viewers/volume-slicer.js'), 'viewer.html loads the compositor before the slicer');
  assert.ok(order(compareHtml, 'js/core/slice-compositor.js', 'js/components/studio-editor.js'), 'compare.html loads the compositor before the Studio');
  assert.ok(/layoutBackground: backdrop,/.test(read('js/pages/compare.js')), 'compare.js hands the Studio its backdrop');
  console.log('viewer / page wiring: OK');
}

console.log('Studio channels on raw slice values: OK');
