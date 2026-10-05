// The Studio's native pass, run as written in viewer.js (_upgradeStudioSliceToNative,
// _renderNativeSliceForStudio and their helpers, lifted from the source) against a
// scripted loader, slicer and Studio:
//   • its own loader batch: a group of its own, its AbortSignal, the bricks composed
//     (and floor-LUT'ed) in the decode workers, cropped to the volume, byte ranges;
//   • the plane path for axis-aligned cuts and z-stack slabs (no 3D atlas), the
//     atlas path for an oblique cut, and one level down when the atlas does not fit
//     the GPU (SVR_OVER_BUDGET), labelled so;
//   • a failed channel is retried alone and merged into the box kept; the bricks
//     never written are `missingChunks` = bricks − written, and such a picture is
//     'native-partial', never 'native';
//   • every progressive picture refills ONE raw buffer (version + 1), the four-channel
//     slab footprint is computed once for the native window and rides on each;
//   • every Studio call carries the document's token, a stale pass never clears the
//     next pass's progress, the slicer's shared resources are released by their owner;
//   • the preview: a raw picture of at most 2048 px framed on the geometric crop, its
//     crop scaled to the native frame for the pass.
//
// Run: node tests/js/test_viewerpage_studio_pass.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { loadModule, ROOT } from './harness.mjs';

const require = createRequire(import.meta.url);
const THREE = require('../../js/vendor/three.min.js');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const viewerSrc = read('js/pages/viewer.js');
const RealSlicer = loadModule('js/viewers/volume-slicer.js', 'VolumeSlicer', { THREE, window: {} });
const Ops = loadModule('js/workers/studio-plane-ops.js', 'StudioPlaneOps', {});

function lift(name) {
  const m = viewerSrc.match(new RegExp(`\\n  (?:async )?function ${name}\\([^\\n]*\\) \\{\\n[\\s\\S]*?\\n  \\}\\n`));
  assert.ok(m, `${name} must be defined at module level in viewer.js`);
  return m[0];
}

const BS = 16;
const PHYSICAL = { x: 140, y: 104, z: 205 };

function makeEnv({ dims = { x: 70, y: 52, z: 41, brickSize: BS, channels: 4 }, levels = 2, fail = [], failAlways = [], overBudgetAtLod0 = false, numChannels = 4 } = {}) {
  const calls = { batches: [], raws: [], partials: [], finals: [], progress: [], releaseForeign: 0, releaseHiPass: 0, svrInit: [], planes: [], emptyPointed: [] };
  const grid = (d) => ({ nx: Math.ceil(d.x / BS), ny: Math.ceil(d.y / BS), nz: Math.ceil(d.z / BS) });
  const dimsOf = (lod) => (lod === 0 ? dims : { x: Math.ceil(dims.x / 2), y: Math.ceil(dims.y / 2), z: Math.ceil(dims.z / 2), brickSize: BS, channels: dims.channels });
  const active = (lod) => {
    const g = grid(dimsOf(lod));
    const out = [];
    for (let bz = 0; bz < g.nz; bz++) for (let by = 0; by < g.ny; by++) for (let bx = 0; bx < g.nx; bx++) out.push({ bx, by, bz });
    return out;
  };
  // Timers on a fake clock: the progressive refresh fires between bricks.
  let clock = 1000;
  const timers = new Map();
  let timerId = 0;
  const flushTimers = () => { const list = [...timers.values()]; timers.clear(); list.forEach(fn => fn()); };
  const failOnce = new Set(fail);   // 'bx_by_bz|channel', failing on the first attempt only
  const failForever = new Set(failAlways);
  const BrickLoader = {
    isReady: () => true,
    getDimensions: (lod) => (lod < levels ? dimsOf(lod) : null),
    getTransportEncoding: () => 'webp-lossless',
    getManifest: () => ({ levels: Array.from({ length: levels }, () => ({})) }),
    activeBricks: active,
    // Every brick of this synthetic volume is stored except (1, 1, 1) at LOD0 / LOD1.
    hasBrick: (bx, by, bz) => !(bx === 1 && by === 1 && bz === 1),
    estimateTaskBytes: (tasks) => tasks.length * 1000,
    taskBytes: () => 1000,
    async loadBrickTasks(tasks, opts) {
      calls.batches.push({ tasks, opts });
      const summary = { batchId: calls.batches.length, total: tasks.length, delivered: 0, failed: [], skipped: [], cancelled: false, reason: null };
      const byBrick = new Map();
      for (const t of tasks) {
        const k = `${t.bx}_${t.by}_${t.bz}`;
        if (!byBrick.has(k)) byBrick.set(k, []);
        byBrick.get(k).push(t);
      }
      for (const [k, list] of byBrick) {
        if (opts.signal?.aborted) { summary.cancelled = true; summary.reason = 'signal'; break; }
        const t0 = list[0];
        const d = dimsOf(t0.lod);
        const bw = Math.min(BS, d.x - t0.bx * BS), bh = Math.min(BS, d.y - t0.by * BS), bd = Math.min(BS, d.z - t0.bz * BS);
        const r = t0.region || { x0: 0, x1: BS, y0: 0, y1: BS, z0: 0, z1: BS };
        const box = { x0: r.x0, x1: Math.min(r.x1, bw), y0: r.y0, y1: Math.min(r.y1, bh), z0: r.z0, z1: Math.min(r.z1, bd) };
        const voxels = (box.x1 - box.x0) * (box.y1 - box.y0) * (box.z1 - box.z0);
        const data = new Uint8Array(voxels * 4);
        const got = [];
        const failed = [];
        for (const t of list) {
          const fk = `${k}|${t.channel}`;
          if (failOnce.has(fk) || failForever.has(fk)) {
            failOnce.delete(fk);
            failed.push(t.channel);
            summary.failed.push({ bx: t.bx, by: t.by, bz: t.bz, channel: t.channel, lod: t.lod, error: new Error('HTTP 503') });
            continue;
          }
          got.push(t.channel);
          for (let i = 0; i < voxels; i++) data[i * 4 + t.channel] = 10 + t.channel;
        }
        summary.delivered += got.length;
        const full = box.x0 === 0 && box.y0 === 0 && box.z0 === 0 && box.x1 === BS && box.y1 === BS && box.z1 === BS;
        if (got.length) {
          opts.onBrickLoaded({ bx: t0.bx, by: t0.by, bz: t0.bz, lod: t0.lod, channel: 'rgba', composed: true, components: 4, data, region: full ? null : box, channels: got, failedChannels: failed });
        }
        opts.onProgress?.(summary.delivered / tasks.length);
        clock += 3000;
        flushTimers();
        await Promise.resolve();
      }
      const out = new Map();
      out.summary = summary;
      return out;
    }
  };
  const cpuPlane = (desc) => {
    const axes = Ops.PLANE_AXES[desc.axis];
    const W = desc.dims[axes[0]], H = desc.dims[axes[1]], L = desc.layers;
    const plane = {
      axis: desc.axis, width: W, height: H, layers: L, layerBase: desc.layerBase, reduced: desc.reduced, brickSize: desc.brickSize,
      dims: desc.dims, texture: { isPlane: true }, presence: {}, uploads: 0, disposed: false,
      upload(u0, v0, w, h, layer, data) {
        if (u0 < 0 || v0 < 0 || u0 + w > W || v0 + h > H || layer < 0 || layer >= L || data.length < w * h * 4) return false;
        plane.uploads++;
        return true;
      },
      setPresent() {}, flushErrors: () => [], dispose() { plane.disposed = true; }
    };
    calls.planes.push({ desc, plane });
    return plane;
  };
  const material = {
    defines: { ENABLE_SVR: 1 },
    uniforms: { numChannels: { value: numChannels }, svrAtlas0: { value: {} } },
    clone() { return { defines: {}, uniforms: {}, dispose() {} }; }
  };
  const VolumeSlicer = {
    planeGeometry: RealSlicer.planeGeometry,
    samplingSpace: () => null,
    getPlaneExtentUnits: () => 1.5,
    getPlaneSpec: () => ({ mode: 'xy', value: 0.5 }),
    isVisible: () => true,
    createPlaneVolume: cpuPlane,
    renderWithMaterial: () => null,
    renderRawWithMaterial(mat, spec, size, opts = {}) {
      calls.raws.push({ mat, spec, size, opts });
      const win = opts.window || { x: 0, y: 0, w: size, h: size };
      const g = RealSlicer.planeGeometry(spec, PHYSICAL, null);
      const projected = g.projected;
      const n = Number(mat?.uniforms?.numChannels?.value) || 4;
      if (opts.out && opts.out.width === win.w && opts.out.height === win.h) {
        opts.out.version = (opts.out.version || 0) + 1;
        return opts.out;
      }
      return { data: new Uint8Array(win.w * win.h * 4), width: win.w, height: win.h, channels: Math.min(4, n), projected, coverage: projected && n < 4 };
    },
    releaseForeign: () => { calls.releaseForeign++; },
    releaseHiPass: () => { calls.releaseHiPass++; },
  };
  class SVRManager {
    init(channels, d, renderer, mat, opts) {
      calls.svrInit.push({ d, opts });
      this._d = d;
      if (overBudgetAtLod0 && d === dims) throw Object.assign(new Error('over budget'), { code: 'SVR_OVER_BUDGET' });
    }
    writeRgbaBrickRegion() { return true; }
    pointEmptyBricks(isEmpty) {
      const g = { nx: Math.ceil(this._d.x / BS), ny: Math.ceil(this._d.y / BS), nz: Math.ceil(this._d.z / BS) };
      const empty = [];
      for (let bz = 0; bz < g.nz; bz++) for (let by = 0; by < g.ny; by++) for (let bx = 0; bx < g.nx; bx++) if (isEmpty(bx, by, bz)) empty.push(`${bx}_${by}_${bz}`);
      calls.emptyPointed.push(empty);
      return empty.length;
    }
    flushUploadErrors() { return []; }
    dispose() {}
  }
  let token = 7;
  const StudioEditor = {
    isOpen: () => true,
    documentToken: () => token,
    setLoadProgress: (state, options) => calls.progress.push({ state, options }),
    setSliceResult: (sr, options = {}) => (options.imageOnly ? calls.partials : calls.finals).push({ sr, options }),
  };
  const VolumeViewer = {
    getRenderer: () => ({ capabilities: { max3DTextureSize: 2048 } }),
    getMaterial: () => material,
    getPhysicalSize: () => PHYSICAL,
    getPhysicalCalibration: () => ({ calibrationStatus: 'exact' }),
    floorLutsFromManifest: () => [],
  };
  const env = { zstackActive: false };
  const body = `
    let _nativeSliceAbort = null;
    let _nativePassSeq = 0;
    let _currentTimepoint = 0;
    let _brickManifest = null;
    let _planeWorker = null;
    let _planeWorkerFailed = false;
    let _planeJobSeq = 0;
    const _planeJobs = new Map();
    const STUDIO_PREVIEW_MAX = 2048;
    const STUDIO_CONFIRM_BYTES = 256 * 1024 * 1024;
    const datasetMeta = { dimensions: { c: 4 } };
    let _zstackActive = env.zstackActive;
    function _setSliceStatus() {}
    function _t(key, fallback) { return fallback; }
    function _currentChannelState() { return []; }
    function _copyCanvas(c) { return c; }
    ${['_cancelNativeSlice', '_nativeSliceBricksForSpec', '_nativeStudioRenderSize', '_slicePixelSizeUm', '_sliceWindowForRect',
      '_needsCoverageMask', '_withCoverageMask', '_nativeSliceChannels', '_nativePassPlan', '_atlasNativeBackend', '_planeNativeBackend',
      '_renderNativeSliceForStudio', '_studioGeometry', '_studioCalibrated', '_planeWorkerInstance', '_planeJob', '_studioCoverageMask',
      '_reducePlaneTile', '_nativeLabel', '_scaleCropRect', '_tf', '_nativePassEstimate', '_confirmLargeNativePass',
      '_upgradeStudioSliceToNative', '_renderStudioPreviewSlice'].map(lift).join('\n')}
    return {
      upgrade: _upgradeStudioSliceToNative,
      native: _renderNativeSliceForStudio,
      preview: _renderStudioPreviewSlice,
      plan: _nativePassPlan,
      abortOwner: () => _nativeSliceAbort,
      setAbortOwner: (c) => { _nativeSliceAbort = c; },
    };
  `;
  const page = new Function(
    'env', 'document', 'console', 'setTimeout', 'clearTimeout', 'performance', 'navigator', 'THREE', 'Worker', 'Dialog',
    'BrickLoader', 'SVRManager', 'VolumeSlicer', 'VolumeViewer', 'SliceCompositor', 'StudioEditor', 'StudioPlaneOps', 'DOMException', body,
  )(
    env, { createElement: () => ({ getContext: () => null }) }, { warn() {}, log() {} },
    (fn) => { const id = ++timerId; timers.set(id, fn); return id; },
    (id) => { timers.delete(id); },
    { now: () => clock },
    { hardwareConcurrency: 8 },
    THREE, undefined, undefined,
    BrickLoader, SVRManager, VolumeSlicer, VolumeViewer, { isRaw: (r) => Boolean(r && r.data && r.width > 0) }, StudioEditor, Ops, globalThis.DOMException,
  );
  return { page, calls, setToken: (t) => { token = t; }, dims };
}

// ── 1. The preview: raw, ≤ 2048 px, geometric crop; native pass on the plane path ─
{
  const { page, calls } = makeEnv();
  const spec = { mode: 'xy', value: 0.37, slabThickness: 1, projection: 'single' };
  const preview = await page.preview(spec);
  assert.ok(preview && preview.raw && !preview.canvas, 'the preview is raw values alone (the Studio colours them)');
  assert.equal(preview.renderRes, Math.min(2048, Math.max(512, Math.ceil(70 * 1.5))), 'at most STUDIO_PREVIEW_MAX, here the native frame itself');
  assert.equal(preview.nativeRes, Math.max(512, Math.ceil(70 * 1.5)));
  const g = Ops.plainGeometry(RealSlicer.planeGeometry(spec, PHYSICAL, null));
  assert.deepEqual({ ...preview.cropRect }, { ...Ops.cropRect(g, preview.renderRes, null) }, 'the crop is the geometric footprint');
  assert.deepEqual({ ...calls.raws[0].opts.window }, { x: preview.cropRect.x, y: preview.cropRect.y, w: preview.raw.width, h: preview.raw.height }, 'one raw render of the crop window');
  assert.ok(calls.releaseHiPass >= 1, 'the tile pass is given back after the preview');
  assert.equal(preview.calibrated, true);

  calls.raws.length = 0;
  await page.upgrade(preview, 7);
  const batch = calls.batches[0];
  assert.ok(/^studio-native-\d+$/.test(batch.opts.group), 'a loader group of its own');
  assert.ok(batch.opts.signal && typeof batch.opts.signal.aborted === 'boolean', 'its own AbortSignal');
  assert.equal(batch.opts.compose.components, 4, 'composed in the decode workers');
  assert.equal(batch.opts.compose.cropToVolume, true, 'cut to the volume');
  assert.equal(batch.opts.byteRanges, true);
  assert.equal(calls.svrInit.length, 0, 'an XY cut: no 3D atlas at all');
  assert.equal(calls.planes.length, 1, 'one plane texture');
  assert.equal(calls.planes[0].desc.axis, 'z');
  assert.ok(calls.planes[0].plane.disposed, 'disposed at the end of the pass');
  assert.ok(calls.raws.every(r => r.opts.plane === calls.planes[0].plane), 'every picture read from the plane');
  assert.equal(calls.finals.length, 1);
  const final = calls.finals[0].sr;
  assert.equal(final.quality, 'native', 'all bricks in: native');
  assert.equal(final.missingChunks, 0);
  assert.equal(final.path, 'plane');
  assert.equal(calls.finals[0].options.token, 7, 'the final picture names its document');
  assert.ok(calls.partials.length >= 1, 'progressive pictures');
  const raws = new Set([...calls.partials.map(p => p.sr.raw), final.raw]);
  assert.equal(raws.size, 1, 'one raw buffer refilled for every picture of the pass');
  assert.ok(final.raw.version >= 1, 'refills bump the version (SliceCompositor re-uploads)');
  assert.ok(calls.partials.every(p => p.options.token === 7 && p.options.imageOnly), 'partials are scoped to the document');
  assert.ok(calls.progress.every(p => p.options?.token === 7), 'every progress update names its document');
  assert.equal(calls.progress.at(-1).state, null, 'the progress bar is cleared at the end');
  // The native frame and the preview frame are the same size here: the crop is the preview's.
  assert.deepEqual({ ...final.cropRect }, { ...preview.cropRect });
  assert.equal(page.abortOwner(), null, 'the pass let go of the cancel slot');
  assert.ok(calls.releaseForeign >= 1, 'the owner released the shared slicer resources');
  console.log('preview + plane-path native pass (own batch, one raw buffer, token): OK');
}

// ── 2. A failed channel is retried alone; what never arrives is counted, not labelled native ──
{
  const { page, calls } = makeEnv({ fail: ['1_1_0|2', '0_0_0|1'] });
  const spec = { mode: 'xy', value: 0.37, slabThickness: 1, projection: 'single' };
  const preview = await page.preview(spec);
  await page.upgrade(preview, 7);
  assert.equal(calls.batches.length, 2, 'one retry batch');
  const retry = calls.batches[1].tasks.map(t => `${t.bx}_${t.by}_${t.bz}|${t.channel}`).sort();
  assert.deepEqual(retry, ['0_0_0|1', '1_1_0|2'], 'only the failed (brick, channel) pairs are asked again');
  assert.notEqual(calls.batches[1].opts.group, calls.batches[0].opts.group, 'its own group');
  assert.equal(calls.finals[0].sr.missingChunks, 0, 'both bricks completed by the retry');
  assert.equal(calls.finals[0].sr.quality, 'native');
  console.log('failed channels retried alone, merged into the kept box: OK');
}
{
  // Every attempt of one brick's channels fails: it never makes it.
  const lost = '2_1_0';
  const { page, calls } = makeEnv({ failAlways: [0, 1, 2, 3].map(c => `${lost}|${c}`) });
  const spec = { mode: 'xy', value: 0.37, slabThickness: 1, projection: 'single' };
  const preview = await page.preview(spec);
  await page.upgrade(preview, 7);
  const final = calls.finals[0].sr;
  const bricks = new Set(calls.batches[0].tasks.map(t => `${t.bx}_${t.by}_${t.bz}`)).size;
  assert.equal(final.totalChunks, bricks);
  assert.equal(final.missingChunks, 1, 'missing = bricks − written');
  assert.equal(final.nativeChunks, bricks - 1);
  assert.equal(final.quality, 'native-partial', 'a picture with preview patches is never labelled native');
  assert.ok(calls.progress.some(p => /could not be loaded/.test(p.state?.label || '')), 'the operator is told');
}
console.log('missing chunks: bricks − written: OK');

// ── 3. z-stack slab: a reduced plane; four channels get one footprint for every picture ──
{
  const { page, calls } = makeEnv({ numChannels: 4 });
  const z = 41;
  const spec = { mode: 'oblique', axis: 'z', value: (5 + 21 / 2) / z, yaw: 0, pitch: 0, roll: 33, slabThickness: 21, slabStepNorm: 1 / z, projection: 'mip' };
  const preview = await page.preview(spec);
  assert.ok(ArrayBuffer.isView(preview.raw.coverageMask), 'four-channel slab preview: a footprint');
  assert.equal(preview.raw.coverageMask.length, preview.raw.width * preview.raw.height);
  await page.upgrade(preview, 7);
  assert.equal(calls.planes[0].desc.reduced, true, 'a MIP slab is one reduced plane');
  const masks = new Set([...calls.partials.map(p => p.sr.raw.coverageMask), calls.finals[0].sr.raw.coverageMask]);
  assert.equal(masks.size, 1, 'one footprint, computed once, on every native picture');
  const mask = [...masks][0];
  assert.ok(ArrayBuffer.isView(mask) && mask.length === calls.finals[0].sr.raw.width * calls.finals[0].sr.raw.height, 'the native window\'s footprint');
  assert.equal(calls.finals[0].sr.quality, 'native');

  const three = makeEnv({ numChannels: 3 });
  const p3 = await three.page.preview(spec);
  assert.equal(p3.raw.coverageMask, undefined, 'three channels: channel 3 is the footprint, no mask');
  await three.page.upgrade(p3, 7);
  assert.ok([...three.calls.partials, ...three.calls.finals].every(p => p.sr.raw.coverageMask === undefined), 'no mask on the native pictures either');
  console.log('z-stack MIP slab: reduced plane, footprint once: OK');
}

// ── 4. Oblique: atlas path, one level down when it does not fit ────────────────
{
  const { page, calls } = makeEnv({ overBudgetAtLod0: true });
  const spec = { mode: 'oblique', value: 0.45, yaw: 30, pitch: 20, roll: 0, slabThickness: 1, projection: 'single' };
  const preview = await page.preview(spec);
  await page.upgrade(preview, 7);
  assert.equal(calls.planes.length, 0, 'an oblique cut: no plane texture');
  assert.equal(calls.svrInit.length, 2, 'the atlas at LOD0, refused, then LOD1');
  assert.equal(calls.finals.length, 1);
  assert.equal(calls.finals[0].sr.lod, 1);
  assert.equal(calls.finals[0].sr.quality, 'lod1', 'labelled with the level it is');
  assert.ok(calls.progress.some(p => /GPU memory/.test(p.state?.label || '')), 'the progress label says why');
  // The atlas holds one slot to spare, where every brick the level does not store points.
  const lod1 = calls.svrInit[1];
  assert.ok(lod1.opts.targetSlots >= 2, 'one slot more than the bricks: the zero slot');
  assert.deepEqual(calls.emptyPointed.at(-1), ['1_1_1'], 'the ESS-dropped brick reads zeros, not "no brick"');
  console.log('oblique: atlas path, SVR_OVER_BUDGET → LOD1: OK');
}

// ── 5. A stale pass: a superseded owner neither clears nor releases ─────────────
{
  const { page, calls } = makeEnv();
  const spec = { mode: 'xy', value: 0.37, slabThickness: 1, projection: 'single' };
  const preview = await page.preview(spec);
  const run = page.upgrade(preview, 7);
  // Another pass takes the slot while this one streams.
  for (let i = 0; i < 1000 && !calls.batches.length; i++) await Promise.resolve();
  assert.ok(calls.batches.length, 'the pass is streaming');
  const other = new AbortController();
  page.setAbortOwner(other);
  const releasesBefore = calls.releaseForeign;
  await run;
  assert.equal(page.abortOwner(), other, 'the newer pass keeps its cancel slot');
  assert.equal(calls.releaseForeign, releasesBefore, 'and the shared slicer resources it uses');
  assert.ok(calls.progress.every(p => p.options?.token === 7), 'the old pass only ever spoke to its own document');
  console.log('stale pass: token-scoped, the newer owner untouched: OK');
}

// ── 6. Crop scaled to the native frame ─────────────────────────────────────────
{
  const scale = new Function(`${lift('_scaleCropRect')}; return _scaleCropRect;`)();
  const r = scale({ x: 10, y: 20, x2: 99, y2: 109, renderRes: 200 }, 600);
  assert.deepEqual(r, { x: 30, y: 60, x2: 299, y2: 329, renderRes: 600 }, 'every bound × 3, outward');
  assert.deepEqual(scale({ x: 0, y: 0, x2: 199, y2: 199, renderRes: 200 }, 300), { x: 0, y: 0, x2: 299, y2: 299, renderRes: 300 });
  assert.equal(scale(null, 300), null);
  console.log('_scaleCropRect: OK');
}

console.log('Studio native pass (viewer.js): OK');
