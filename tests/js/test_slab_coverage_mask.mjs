// A projected slab (MIP / average) of a FOUR-channel volume carries its footprint on the
// volume as raw.coverageMask, so the Studio keeps the pixels off the volume transparent
// (the 10 px crop padding, the corners of a turned z-stack slab) instead of drawing an
// opaque black frame on the light Compare backdrop. Three channels or fewer keep the
// footprint in channel 3 (raw.coverage) and get no mask; one plane gets none.
//   • viewer.js _sliceCoverageMask: the alpha of the colour picture, 255 / 0, read in
//     bands of rows (exact at band boundaries, threshold 128), null on a size mismatch
//     or an unreadable canvas;
//   • _studioRawFor + getCurrentSliceResult (z-stack and inspector branches), lifted
//     from viewer.js and run over a synthetic turned slab: the mask is the colour
//     picture's crop, pixel for pixel, and the recoloured raw is transparent exactly
//     where the colour picture is (the Studio preview and the native pass compute the
//     footprint from the geometry: test_viewerpage_studio_pass / _native_plane);
//   • the Studio never serialises it: it lives inside `raw`, which the document strips.
//
// Run: node tests/js/test_slab_coverage_mask.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { loadModule, ROOT } from './harness.mjs';

const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const viewerSrc = read('js/pages/viewer.js');

function lift(name) {
  const m = viewerSrc.match(new RegExp(`\\n  (?:async )?function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n  \\}\\n`));
  assert.ok(m, `${name} must be defined at module level in viewer.js`);
  return m[0];
}

const SC = loadModule('js/core/slice-compositor.js', 'SliceCompositor', {});

// ── A 2D canvas with real pixels (no blending needed: every copy lands on a fresh canvas) ──
function makeCanvas(w = 0, h = 0) {
  let W = w;
  let H = h;
  let px = new Uint8ClampedArray(W * H * 4);
  const c = {
    get width() { return W; },
    set width(v) { W = v; px = new Uint8ClampedArray(W * H * 4); },
    get height() { return H; },
    set height(v) { H = v; px = new Uint8ClampedArray(W * H * 4); },
    get pixels() { return px; },
    reads: [],
    failRead: false,
  };
  const ctx = {
    getImageData(x, y, w2, h2) {
      c.reads.push([x, y, w2, h2]);
      if (c.failRead) throw new Error('The canvas has been tainted');
      const out = new Uint8ClampedArray(w2 * h2 * 4);
      for (let r = 0; r < h2; r++) {
        const sy = y + r;
        if (sy < 0 || sy >= H) continue;
        for (let q = 0; q < w2; q++) {
          const sx = x + q;
          if (sx < 0 || sx >= W) continue;
          out.set(px.subarray((sy * W + sx) * 4, (sy * W + sx) * 4 + 4), (r * w2 + q) * 4);
        }
      }
      return { width: w2, height: h2, data: out };
    },
    putImageData(img, dx = 0, dy = 0) {
      for (let r = 0; r < img.height; r++) {
        for (let q = 0; q < img.width; q++) {
          const tx = dx + q; const ty = dy + r;
          if (tx < 0 || ty < 0 || tx >= W || ty >= H) continue;
          px.set(img.data.subarray((r * img.width + q) * 4, (r * img.width + q) * 4 + 4), (ty * W + tx) * 4);
        }
      }
    },
    createImageData: (w2, h2) => ({ width: w2, height: h2, data: new Uint8ClampedArray(w2 * h2 * 4) }),
    drawImage(src, ...a) {
      let sx = 0; let sy = 0; let sw = src.width; let sh = src.height; let dx; let dy;
      if (a.length === 2) [dx, dy] = a;
      else if (a.length === 8) {
        [sx, sy, sw, sh, dx, dy] = a;
        assert.ok(a[6] === sw && a[7] === sh, 'no scaling in these copies');
      } else assert.fail(`drawImage with ${a.length + 1} arguments`);
      const img = src.getContext('2d').getImageData(sx, sy, sw, sh);
      src.reads.pop(); // a copy, not a readback of the caller's
      ctx.putImageData(img, dx, dy);
    },
  };
  c.getContext = (kind) => (kind === '2d' ? ctx : null);
  return c;
}
const documentStub = { createElement: () => makeCanvas() };

// ── 1. _sliceCoverageMask: bands, threshold, refusals ─────────────────────────
{
  const fns = new Function('document', 'console', `${lift('_sliceCoverageMask')}; return _sliceCoverageMask;`);
  const warnings = [];
  const mask = fns(documentStub, { warn: (...a) => warnings.push(a) });
  const W = 4096; const H = 2100; // 1024 rows a band (4 Mpx): bands of 1024, 1024 and 52 rows
  const canvas = makeCanvas(W, H);
  const alphaAt = (x, y) => ((x * 7 + y * 13) % 5 === 0 ? 255 : (x + y) % 11 === 0 ? 128 : (x + y) % 13 === 0 ? 127 : 0);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) canvas.pixels[(y * W + x) * 4 + 3] = alphaAt(x, y);
  const m = mask(canvas, W, H);
  assert.ok(m instanceof Uint8Array && m.length === W * H, 'one byte per pixel');
  assert.deepEqual(canvas.reads, [[0, 0, W, 1024], [0, 1024, W, 1024], [0, 2048, W, 52]], 'read in bands of 4 Mpx');
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const want = alphaAt(x, y) >= 128 ? 255 : 0;
      if (m[y * W + x] !== want) assert.fail(`mask(${x}, ${y}) = ${m[y * W + x]}, alpha ${alphaAt(x, y)} gives ${want}`);
    }
  }
  assert.equal(mask(canvas, W, H - 1), null, 'another size: null (the colour picture is not this crop)');
  assert.equal(mask(null, W, H), null, 'no canvas: null');
  const tainted = makeCanvas(4, 3);
  tainted.failRead = true;
  assert.equal(mask(tainted, 4, 3), null, 'an unreadable canvas: null');
  assert.equal(warnings.length, 1, 'and a warning');
  console.log('_sliceCoverageMask (bands, threshold, refusals): OK');
}

// ── A synthetic slab: a turned square on a 120 px frame, four channels ─────────
const RES = 120;
const ANGLE = (25 * Math.PI) / 180;
const inside = (x, y) => {
  const dx = x - 61; const dy = y - 57;
  const u = dx * Math.cos(ANGLE) + dy * Math.sin(ANGLE);
  const v = -dx * Math.sin(ANGLE) + dy * Math.cos(ANGLE);
  return Math.abs(u) <= 30 && Math.abs(v) <= 30;
};
// The crop around that footprint: its bounding box, padded by 10 px.
const FOOTPRINT_RECT = (() => {
  let minX = RES; let minY = RES; let maxX = 0; let maxY = 0;
  for (let y = 0; y < RES; y++) {
    for (let x = 0; x < RES; x++) {
      if (!inside(x, y)) continue;
      minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
    }
  }
  return { x: Math.max(0, minX - 10), y: Math.max(0, minY - 10), x2: Math.min(RES - 1, maxX + 10), y2: Math.min(RES - 1, maxY + 10) };
})();
const FOOTPRINT_CROP = { x: FOOTPRINT_RECT.x, y: FOOTPRINT_RECT.y };
// Raw channel values on the frame: 0 off the volume (the shader's hits == 0), some
// all-zero pixels on it (the slab shows nothing there: opaque black in the picture).
const rawFrameAt = (x, y, c) => (!inside(x, y) || (x + 2 * y) % 7 === 0 ? 0 : (x * 31 + y * 17 + c * 53) % 256);
const STATE = [
  { color: '#00FF00', min: 0, max: 1, gamma: 1, opacity: 1, enabled: true },
  { color: '#FF00FF', min: 0.1, max: 0.9, gamma: 1, opacity: 0.8, enabled: true },
  { color: '#0088FF', min: 0, max: 1, gamma: 0.7, opacity: 1, enabled: true },
  { color: '#FFFFFF', min: 0.2, max: 1, gamma: 1, opacity: 0.5, enabled: true },
];

function makeEnv({ channels = 4, projection = 'mip', slabThickness = 9, zstackActive = true } = {}) {
  const projected = projection !== 'single' && slabThickness > 1;
  const calls = { raw: [], colour: [], partials: [], finals: [], progress: 0 };
  // The colour picture of the frame: the slicer's colour path for this plane.
  const colourFrame = (window = null) => {
    const win = window || { x: 0, y: 0, w: RES, h: RES };
    const canvas = makeCanvas(win.w, win.h);
    for (let y = 0; y < win.h; y++) {
      for (let x = 0; x < win.w; x++) {
        const fx = x + win.x; const fy = y + win.y;
        if (!inside(fx, fy)) continue; // discarded: cleared alpha 0
        const r = rawFrameAt(fx, fy, 0); const g = rawFrameAt(fx, fy, 1);
        if (!projected && !r && !g) continue; // one plane: below 0.005, discarded
        canvas.pixels.set([r, g, 0, 255], (y * win.w + x) * 4);
      }
    }
    return canvas;
  };
  const rawFrame = (window, level = 'preview') => {
    const win = window || { x: 0, y: 0, w: RES, h: RES };
    const data = new Uint8Array(win.w * win.h * 4);
    for (let y = 0; y < win.h; y++) {
      for (let x = 0; x < win.w; x++) {
        for (let c = 0; c < 4; c++) {
          let v = c < channels ? rawFrameAt(x + win.x, y + win.y, c) : 0;
          if (level === 'native' && v) v = Math.min(255, v + 1); // native values differ from the preview's
          data[(y * win.w + x) * 4 + c] = v;
        }
        if (projected && channels < 4 && inside(x + win.x, y + win.y)) data[(y * win.w + x) * 4 + 3] = 255;
      }
    }
    return { data, width: win.w, height: win.h, channels, projected, coverage: projected && channels < 4 };
  };
  const spec = { mode: 'oblique', axis: 'z', value: 0.5, yaw: 0, pitch: 0, roll: 25, slabThickness, slabStepNorm: 0.01, projection };
  const material = { defines: {}, uniforms: {}, clone() { return { defines: {}, uniforms: {}, dispose() {} }; } };
  const VolumeSlicer = {
    isVisible: () => true,
    getPlaneSpec: () => spec,
    renderWithMaterial: (mat, s, size, _state, options = {}) => {
      calls.colour.push(['material', size, options?.window || null]);
      return colourFrame(options?.window || null);
    },
    renderRawWithMaterial: (mat, s, size, options = {}) => {
      assert.equal(size, RES, 'raw at the colour picture\'s frame size');
      calls.raw.push({ window: options.window });
      return rawFrame(options.window, 'preview');
    },
    getPlaneExtentUnits: () => 1.5,
    releaseHiPass() {},
  };
  const VolumeViewer = {
    getMaterial: () => material,
    getRenderer: () => ({}),
    getPhysicalSize: () => ({ x: 400, y: 400, z: 120 }),
  };
  // The crop: the footprint's bounding box padded by 10 px (StudioPlaneOps.cropRect
  // computes it from the plane's geometry; here the footprint is the turned square).
  const StudioPlaneOps = { cropRect: () => ({ ...FOOTPRINT_RECT, renderRes: RES }) };
  const body = `
    let _currentTimepoint = 0;
    let _zstackActive = env.zstackActive;
    const datasetMeta = { dimensions: { x: 80, y: 80, z: 40, c: env.channels } };
    function _currentChannelState() { return env.state; }
    function _slicePixelSizeUm() { return { x: 1, y: 1 }; }
    function _zstackGetDims() { return { z: 40 }; }
    function _zstackStudioSpec() { return env.spec; }
    function _studioGeometry() { return { geom: {}, warp: null }; }
    function _studioCalibrated() { return true; }
    ${lift('_copyCanvas')}
    ${lift('_sliceWindowForRect')}
    ${lift('_studioRawFor')}
    ${lift('_needsCoverageMask')}
    ${lift('_withCoverageMask')}
    ${lift('_sliceCoverageMask')}
    ${lift('_captureRenderRes')}
    ${lift('getCurrentSliceResult')}
    return { getCurrentSliceResult };
  `;
  const page = new Function(
    'env', 'document', 'console', 'VolumeSlicer', 'VolumeViewer', 'SliceCompositor', 'StudioPlaneOps', body,
  )(
    { channels, state: STATE, spec, zstackActive },
    documentStub,
    { warn() {}, log() {} },
    VolumeSlicer, VolumeViewer, SC, StudioPlaneOps,
  );
  return { page, calls, spec, projected };
}

// The mask of a result must be the colour picture's footprint over its crop, pixel for pixel.
function assertMaskFollowsCrop(raw, cropRect, label) {
  const x0 = Math.round(cropRect.x); const y0 = Math.round(cropRect.y);
  assert.ok(raw.coverageMask instanceof Uint8Array, `${label}: a coverage mask`);
  assert.equal(raw.coverageMask.length, raw.width * raw.height, `${label}: w·h bytes`);
  for (let y = 0; y < raw.height; y++) {
    for (let x = 0; x < raw.width; x++) {
      const want = inside(x + x0, y + y0) ? 255 : 0;
      if (raw.coverageMask[y * raw.width + x] !== want) assert.fail(`${label}: mask(${x}, ${y}) = ${raw.coverageMask[y * raw.width + x]}, the footprint gives ${want}`);
    }
  }
}

// The recoloured raw: transparent exactly off the footprint, opaque black where the slab
// shows nothing — the colour picture's own alpha.
function assertRecolourKeepsOutsideTransparent(raw, colourCanvas, label) {
  const out = SC.composePixels(raw, STATE);
  let blackInside = 0; let transparent = 0;
  for (let i = 0; i < raw.width * raw.height; i++) {
    assert.equal(out[i * 4 + 3], colourCanvas.pixels[i * 4 + 3], `${label}: recoloured alpha = colour picture alpha at ${i}`);
    if (out[i * 4 + 3] === 0) transparent++;
    else if (!out[i * 4] && !out[i * 4 + 1] && !out[i * 4 + 2]) blackInside++;
  }
  assert.ok(transparent > 0 && blackInside > 0, `${label}: the crop holds both transparent padding and opaque black slab (${transparent}/${blackInside})`);
  // The 10 px padding row at the top of the crop: all transparent.
  for (let x = 0; x < raw.width; x++) assert.equal(out[x * 4 + 3], 0, `${label}: padding row transparent at ${x}`);
}

// ── 4. getCurrentSliceResult (the Compare Studio's slice): z-stack and inspector ──
{
  const zstack = makeEnv({ channels: 4, projection: 'mip', slabThickness: 9 });
  const zs = zstack.page.getCurrentSliceResult();
  assert.equal(zs.source, 'zstack');
  assertMaskFollowsCrop(zs.raw, FOOTPRINT_CROP, 'z-stack result');
  assertRecolourKeepsOutsideTransparent(zs.raw, zs.canvas, 'z-stack result');
  const thumb = zstack.page.getCurrentSliceResult({ raw: false, maxRes: 1024 });
  assert.equal(thumb.raw, null, 'a thumbnail: no raw, so no mask and no readback');
  assert.equal(thumb.canvas.reads.length, 0, 'the thumbnail\'s colour picture is not read back');

  // The inspector's own slab (an average), the z-stack browser closed.
  const inspector = makeEnv({ channels: 4, projection: 'average', slabThickness: 5, zstackActive: false });
  const sr = inspector.page.getCurrentSliceResult();
  assert.equal(sr.source, 'gpu-slicer');
  assert.equal(inspector.calls.colour[0][0], 'material', 'the inspector plane rendered in colour first');
  assert.deepEqual({ ...inspector.calls.colour[0][2] }, { x: FOOTPRINT_RECT.x, y: FOOTPRINT_RECT.y, w: FOOTPRINT_RECT.x2 - FOOTPRINT_RECT.x + 1, h: FOOTPRINT_RECT.y2 - FOOTPRINT_RECT.y + 1 }, 'the crop window alone is rendered');
  assertMaskFollowsCrop(sr.raw, FOOTPRINT_CROP, 'inspector result');
  assertRecolourKeepsOutsideTransparent(sr.raw, sr.canvas, 'inspector result');
  console.log('getCurrentSliceResult (z-stack MIP, inspector average): mask follows the crop: OK');
}

// ── 6. Never serialised, released with the raw ─────────────────────────────────
{
  const studio = read('js/components/studio-editor.js');
  assert.ok(/const LAYOUT_RUNTIME_KEYS = \[[^\]]*'raw'[^\]]*\];/.test(studio), 'a Compare cell\'s raw (and so its mask) never goes through JSON');
  assert.ok(!/coverageMask/.test(studio), 'the Studio never holds the mask outside its raw');
  assert.ok(/map\.raw = null;/.test(studio) && /SliceCompositor\.release\(\);/.test(studio), '_releaseRaw drops every raw (with its mask) and every texture');
  const compositor = read('js/core/slice-compositor.js');
  const release = compositor.slice(compositor.indexOf('function release('), compositor.indexOf('return {\n    isRaw'));
  assert.ok(/raw\.coverageMask/.test(release), 'release(raw) frees the mask texture too');
  console.log('mask lifetime (never serialised, released with the raw): OK');
}

console.log('slab coverage mask (four-channel slabs keep their outside transparent): OK');
