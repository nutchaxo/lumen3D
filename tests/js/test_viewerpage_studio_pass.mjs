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
//     crop scaled to the native frame for the pass;
//   • a timelapse: the pass runs on the preview's frame (put back on screen when another
//     one took its place), its pictures carry that frame, and a frame change while it
//     runs stops it with nothing more reaching the figure.
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

function makeEnv({ dims = { x: 70, y: 52, z: 41, brickSize: BS, channels: 4 }, levels = 2, fail = [], failAlways = [], overBudgetAtLod0 = false, numChannels = 4, live = false, loadFails = false, afterBrick = null, mountFails = false, slowLoads = false, v6 = false } = {}) {
  const calls = { batches: [], raws: [], partials: [], finals: [], progress: [], releaseForeign: 0, releaseHiPass: 0, svrInit: [], planes: [], emptyPointed: [], inits: [], status: [] };
  let page = null;
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
  // One brick tree per frame (a timelapse mounts one per timepoint), each its own
  // manifest object: BrickLoader serves the tree MOUNTED, VolumeViewer shows a tree
  // that can be another one (a cached frame is shown without a mount; the stream of
  // another frame mounts its own early).
  const trees = new Map();
  const treeOf = (t) => {
    if (!trees.has(t)) {
      const path = live ? `DATA_WEB/live/demo/bricks/t${String(t).padStart(3, '0')}` : 'DATA_WEB/3d/demo/bricks';
      trees.set(t, { path, manifest: { frame: t, levels: Array.from({ length: levels }, () => ({})) } });
    }
    return trees.get(t);
  };
  const start = live ? 12 : 0;
  const view = { mounted: treeOf(start), shown: start, displayCancels: 0 };
  const BrickLoader = {
    isReady: () => true,
    getDimensions: (lod) => (lod < levels ? dimsOf(lod) : null),
    getTransportEncoding: () => 'webp-lossless',
    getManifest: () => view.mounted.manifest,
    async init(path, manifest) {
      calls.inits.push(manifest.frame);
      await Promise.resolve();
      if (mountFails) throw Object.assign(new Error('index refused'), { code: 'BRICKS_INDEX_INVALID' });
      view.mounted = { path, manifest };
    },
    activeBricks: active,
    // Every brick of this synthetic volume is stored except (1, 1, 1) at LOD0 / LOD1.
    hasBrick: (bx, by, bz) => !(bx === 1 && by === 1 && bz === 1),
    estimateTaskBytes: (tasks) => tasks.length * 1000,
    taskBytes: () => 1000,
    async loadBrickTasks(tasks, opts) {
      // The loader's own guard: a batch planned on another tree than the mount is refused.
      if (opts.manifest && opts.manifest !== view.mounted.manifest) {
        calls.batches.push({ tasks, opts, frame: view.mounted.manifest.frame, refused: true });
        throw Object.assign(new Error('another tree is mounted'), { code: 'BRICKS_MOUNT_CHANGED', stale: true });
      }
      calls.batches.push({ tasks, opts, frame: view.mounted.manifest.frame });
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
        afterBrick?.(page);
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
  // The Studio document: open until closed (its X button), its picture's quality.
  const studio = { open: true, opened: [] };
  const StudioEditor = {
    isOpen: () => studio.open,
    open: (sr) => { studio.open = true; studio.opened.push(sr); return token; },
    getSliceQuality: () => (calls.finals.length ? calls.finals.at(-1).sr.quality : 'preview'),
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
    // view.shown === null: nothing on screen (a WebGL context lost, or restored without
    // its volume - VolumeViewer's active entry is gone).
    getDisplayedTree: () => (view.shown === null ? null : { ...treeOf(view.shown), timepoint: live ? view.shown : null }),
    // The frame of the volume on screen (VolumeViewer's active entry), which a first-visit
    // frame's coarse level makes the new frame before its load resolves.
    getDisplayedTimepoint: () => (live && view.shown !== null ? view.shown : null),
    getSamplingVolume: () => (view.shown === null ? null : { textures: [{}] }),
    getActiveLevel: () => (view.shown === null ? null : { level: 0, dims: { x: dims.x, y: dims.y, z: dims.z } }),
    // The display stream in flight stops: it lands nothing (see _startRequest).
    cancelDisplayLoad: () => { view.displayCancels++; },
  };
  const timeline = { paused: 0, frames: [] };
  const Timeline = live ? {
    pause: () => { timeline.paused++; },
    setFrame: (f, forceInteger, notify) => { timeline.frames.push([f, forceInteger, notify]); },
  } : undefined;
  const env = {
    zstackActive: false, live, loadFails, slowLoads, v6, view, loads: [], prefetch: { stops: 0, kicks: 0 },
    // slowLoads: every _loadTimepoint waits here until released (gates[i].release()).
    gates: [],
    // A frame put on screen: from the cache (no mount, the worst case) unless streamed.
    show: (t, { streamed = false } = {}) => { view.shown = t; if (streamed) view.mounted = treeOf(t); },
    // The WebGL context lost: VolumeViewer frees every volume, nothing is on screen.
    loseContext: () => { view.shown = null; },
    qualityStatus: [],
    mountTree: (t) => { view.mounted = treeOf(t); },
    status: (text) => calls.status.push(text),
  };
  const body = `
    let _nativeSliceAbort = null;
    let _nativePassSeq = 0;
    let _currentTimepoint = env.live ? 12 : 0;
    let _timepointGeneration = 0;
    let _tpPending = null;
    let _tpInFlight = false;
    let _tpTarget = null;
    let _activeLoadToken = 0;
    let _nativePassHolds = 0;
    const isLive = env.live;
    function _stopPrefetch() { env.prefetch.stops++; }
    function _kickPrefetch() { env.prefetch.kicks++; }
    // What _loadTimepointInner does once a frame is on screen (viewer.js); the volume of a
    // frame revisited comes from the cache, shown without mounting its tree.
    function _mount(t, streamed = false) {
      env.show(t, { streamed });
      if (_currentTimepoint !== t) _timepointGeneration++;
      _currentTimepoint = t;
    }
    async function _loadTimepoint(basePath, t) {
      env.loads.push(t);
      const token = ++_activeLoadToken;
      // A display load supersedes the display stream in flight (VolumeViewer cancels it).
      env.view.displayCancels++;
      if (env.slowLoads) await new Promise((release) => { env.gates.push({ t, release }); });
      // _loadTimepointInner: a load superseded by a later one resolves stale (undefined).
      if (token !== _activeLoadToken) return undefined;
      if (env.loadFails) return undefined;
      _mount(t);
      return { ok: true, token };
    }
    // A frame request of _requestTimepoint still streaming: its stream has mounted its
    // tree already; it lands later, and only if no load started after it (its token is
    // still the active one). coarse: a first visit (VolumeViewer coarseFirst, activation
    // not deferred) - the frame's coarsest level is ON SCREEN from its first picture,
    // while _currentTimepoint still names the previous frame. Landing with fails: the
    // load throws (_requestTimepoint puts the previous frame back from the cache).
    function _startRequest(t, { coarse = false } = {}) {
      const token = ++_activeLoadToken;
      const cancels = env.view.displayCancels;
      env.mountTree(t);
      if (coarse) env.show(t);
      _tpInFlight = true;
      const target = { frame: t, origin: 'user' };
      _tpTarget = target;
      return ({ fails = false } = {}) => {
        _tpInFlight = false;
        if (_tpTarget === target) _tpTarget = null;
        if (fails) { env.show(_currentTimepoint); return; }
        // A stream cancelled (by another display load, or VolumeViewer.cancelDisplayLoad)
        // swaps nothing in. One that was not swaps its frame in whatever the page thinks:
        // VolumeViewer activates it; the page only follows when its token is current.
        if (env.view.displayCancels !== cancels) return;
        if (token === _activeLoadToken) _mount(t);
        else env.show(t);
      };
    }
    let _brickManifest = null;
    let _planeWorker = null;
    let _planeWorkerFailed = false;
    let _planeJobSeq = 0;
    const _planeJobs = new Map();
    const STUDIO_PREVIEW_MAX = 2048;
    const STUDIO_CONFIRM_BYTES = 256 * 1024 * 1024;
    const datasetMeta = { dimensions: { c: 4 } };
    // Format 1 (no planes/): the bricks, as before.
    const _planeTrees = new Map();
    let _basePath = 'DATA_WEB/3d/demo';
    let _qualityMode = '1024x1024';
    function _qualityLabel(q) { return q; }
    function _setQualityStatus(text) { env.qualityStatus.push(text); }
    let _zstackActive = env.zstackActive;
    function _setSliceStatus(text) { env.status(text); }
    function _t(key, fallback) { return fallback; }
    function _currentChannelState() { return []; }
    function _copyCanvas(c) { return c; }
    function _showLoadingError() {}
    // openStudio / _ensureStudioNative (a page, not a Compare panel).
    const _isIframe = false;
    let _studioOpening = false;
    let _studioPreview = null;
    let _studioUpgradePromise = null;
    function getCurrentSliceResult() { return null; }
    function _zstackStudioSpec() { return null; }
    function _isV6BrickManifest() { return env.v6; }
    ${['_cancelNativeSlice', '_nativeSliceBricksForSpec', '_nativeStudioRenderSize', '_slicePixelSizeUm', '_sliceWindowForRect',
      '_needsCoverageMask', '_withCoverageMask', '_nativeSliceChannels', '_nativePassPlan', '_atlasNativeBackend', '_planeNativeBackend',
      '_renderNativeSliceForStudio', '_studioGeometry', '_studioCalibrated', '_planeWorkerInstance', '_planeJob', '_studioCoverageMask',
      '_reducePlaneTile', '_nativeLabel', '_scaleCropRect', '_tf', '_nativePassEstimate', '_confirmLargeNativePass',
      '_upgradeStudioSliceToNative', '_renderStudioPreviewSlice', '_planesBaseOnScreen', '_planesTreeOnScreen', '_planesServePass', '_cutTreeOnScreen', '_cutDepthOf',
      '_planesPassEstimate', '_nativeBrickFrame', '_nativeLoaderRegion', '_nativeInteriorRegion', '_mipsTreeOnScreen', '_mipsSlabOf', '_mipsSlabEstimate',
      '_frameLabel', '_displayedTimepoint', '_whenTimepointIdle', '_returnToStudioFrame', '_reportStudioFrameLost', '_mountTreeOnScreen',
      '_shownTimepoint', '_dropOtherFrameLoad', '_hasMountedVolume', '_holdStudioFrame', '_requestTimepoint', 'openStudio',
      '_ensureStudioNative'].map(lift).join('\n')}
    return {
      upgrade: _upgradeStudioSliceToNative,
      native: _renderNativeSliceForStudio,
      preview: _renderStudioPreviewSlice,
      plan: _nativePassPlan,
      abortOwner: () => _nativeSliceAbort,
      setAbortOwner: (c) => { _nativeSliceAbort = c; },
      mount: _mount,
      startRequest: _startRequest,
      queue: (t) => { _tpPending = { frame: t, origin: 'user', remount: false }; },
      pending: () => _tpPending,
      timepoint: () => _currentTimepoint,
      holds: () => _nativePassHolds,
      // The scrubber dragged by the operator (Timeline's callback).
      request: (t) => _requestTimepoint(_basePath, t),
      openStudio,
      ensureNative: _ensureStudioNative,
      target: () => _tpTarget,
    };
  `;
  page = new Function(
    'env', 'document', 'console', 'setTimeout', 'clearTimeout', 'performance', 'navigator', 'THREE', 'Worker', 'Dialog',
    'BrickLoader', 'SVRManager', 'VolumeSlicer', 'VolumeViewer', 'SliceCompositor', 'StudioEditor', 'StudioPlaneOps', 'DOMException', 'Utils', 'Timeline', body,
  )(
    env, { createElement: () => ({ getContext: () => null }), getElementById: () => null }, { warn() {}, log() {} },
    (fn) => { const id = ++timerId; timers.set(id, fn); return id; },
    (id) => { timers.delete(id); },
    { now: () => clock },
    { hardwareConcurrency: 8 },
    THREE, undefined, undefined,
    BrickLoader, SVRManager, VolumeSlicer, VolumeViewer, { isRaw: (r) => Boolean(r && r.data && r.width > 0) }, StudioEditor, Ops, globalThis.DOMException,
    { formatNumber: (v, d) => Number(v).toFixed(d) },
    Timeline,
  );
  return { page, calls, setToken: (t) => { token = t; }, dims, env, timeline, view, treeOf, flushTimers, studio };
}

// Runs a pass that waits on the page's timers (_whenTimepointIdle polls on setTimeout,
// the fake clock here): the timers are flushed between event-loop turns until it settles.
async function drive(promise, flushTimers, turns = 400) {
  let done = false;
  promise.then(() => { done = true; }, () => { done = true; });
  for (let i = 0; i < turns && !done; i++) {
    flushTimers();
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.ok(done, 'the pass settled');
  return promise;
}
async function turns(flushTimers, n = 20) {
  for (let i = 0; i < n; i++) { flushTimers(); await new Promise((resolve) => setImmediate(resolve)); }
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

// ── 7. A timelapse: the pass is bound to the preview's frame ───────────────────
{
  // Another frame landed after the preview (a load in flight when playback paused, or
  // the format-6 export pass run minutes later): the preview's frame is put back first.
  const { page, calls, env, timeline } = makeEnv({ live: true });
  const spec = { mode: 'xy', value: 0.37, slabThickness: 1, projection: 'single' };
  const preview = await page.preview(spec);
  assert.equal(preview.timepoint, 12, 'the preview names its frame');
  page.mount(17);
  await page.upgrade(preview, 7);
  assert.ok(timeline.paused >= 1, 'playback is paused for the pass');
  assert.deepEqual(env.loads, [12], 'the preview\'s frame is loaded again');
  assert.deepEqual(timeline.frames.at(-1), [12, true, false], 'the scrubber follows, silently');
  assert.equal(page.timepoint(), 12);
  assert.equal(calls.finals.length, 1);
  assert.equal(calls.finals[0].sr.timepoint, 12, 'the native picture carries the preview\'s frame');
  assert.ok(calls.partials.every(p => p.sr.timepoint === 12), 'and so does every progressive picture');
  console.log('timelapse: the preview\'s frame is put back before the pass: OK');
}
{
  // The frame cannot be put back: the figure keeps its preview and the operator is told.
  const { page, calls, env, timeline } = makeEnv({ live: true, loadFails: true });
  const spec = { mode: 'xy', value: 0.37, slabThickness: 1, projection: 'single' };
  const preview = await page.preview(spec);
  page.mount(40);
  await page.upgrade(preview, 7);
  assert.deepEqual(env.loads, [12]);
  assert.deepEqual(timeline.frames.at(-1), [40, true, false], 'the scrubber goes back to the frame on screen');
  assert.equal(calls.batches.length, 0, 'no brick of another frame is read');
  assert.equal(calls.finals.length + calls.partials.length, 0, 'nothing reaches the figure');
  assert.ok(calls.progress.some(p => /no longer on frame 012/.test(p.state?.label || '')), 'the Studio says why');
  console.log('timelapse: a frame that cannot be put back keeps the preview: OK');
}
{
  // Another frame takes the screen while the pass streams: it stops there.
  let moved = false;
  const { page, calls } = makeEnv({
    live: true,
    afterBrick: (p) => { if (!moved && calls.batches.length) { moved = true; p.mount(13); } },
  });
  const spec = { mode: 'xy', value: 0.37, slabThickness: 1, projection: 'single' };
  const preview = await page.preview(spec);
  await page.upgrade(preview, 7);
  assert.ok(moved, 'the frame moved during the pass');
  assert.equal(calls.finals.length, 0, 'no final picture of a mixed pass');
  assert.equal(calls.partials.length, 0, 'nor any progressive one after the change');
  assert.equal(calls.batches.length, 1, 'no retry batch on the new mount');
  assert.ok(calls.batches[0].opts.signal.aborted, 'the batch is cancelled');
  assert.ok(calls.progress.some(p => /no longer on frame 012/.test(p.state?.label || '')), 'the Studio says why');
  assert.ok(!calls.progress.some(p => /unavailable/.test(p.state?.label || '')), 'not reported as a failure');
  console.log('timelapse: a frame change mid-pass stops it: OK');
}
{
  // Playback stalled on frame 13, its load still streaming hidden behind frame 12 (a
  // revisit: activation deferred), when the Studio opened on frame 12: the pass drops
  // that load instead of being aborted when it lands, and does not load frame 12 (on
  // screen) a second time - an uncached native or degraded frame would be re-streamed
  // whole beside its own resident copy, possibly at a coarser level.
  let landed = false;
  let land = null;
  const { page, calls, env, timeline } = makeEnv({
    live: true,
    afterBrick: () => { if (!landed && land) { landed = true; land(); } },
  });
  const spec = { mode: 'xy', value: 0.37, slabThickness: 1, projection: 'single' };
  const preview = await page.preview(spec);
  land = page.startRequest(13);
  page.queue(14);
  await page.upgrade(preview, 7);
  assert.ok(landed, 'the superseded load settled during the pass');
  assert.deepEqual(env.loads, [], 'frame 12 is on screen: it is not loaded a second time');
  assert.equal(env.view.displayCancels, 1, 'the stream of frame 13 is cancelled, it never swaps in');
  assert.equal(env.view.shown, 12);
  assert.ok(env.qualityStatus.length >= 1 && !/Loading/.test(env.qualityStatus.at(-1)), 'the status line names the quality on screen again');
  assert.deepEqual(timeline.frames.at(-1), [12, true, false], 'the scrubber is back on the figure\'s frame');
  assert.equal(page.pending(), null, 'the frame queued behind it is dropped');
  assert.equal(page.timepoint(), 12, 'the stale load never took the screen');
  assert.equal(calls.finals.length, 1, 'the native picture reaches the figure');
  assert.equal(calls.finals[0].sr.timepoint, 12);
  assert.ok(!calls.progress.some(p => /no longer on frame/.test(p.state?.label || '')), 'no frame-lost notice');
  console.log('timelapse: a frame load in flight at open is superseded by the pass: OK');
}
{
  // The load in flight is the preview's own frame: nothing to reload, the pass runs.
  const { page, calls, env } = makeEnv({ live: true });
  const preview = await page.preview({ mode: 'xy', value: 0.37, slabThickness: 1, projection: 'single' });
  const land = page.startRequest(12);
  page.queue(12);
  await page.upgrade(preview, 7);
  land();
  assert.deepEqual(env.loads, [], 'nothing reloaded');
  assert.ok(page.pending(), 'a request of the same frame is left alone');
  assert.equal(calls.finals.length, 1);
}
{
  // The defect's case: playback stalled on frame 13, whose stream has already mounted
  // frame 13's tree, while frame 12 is on screen (shown without a mount, as a cached
  // frame is). That stream is dropped: the pass mounts the tree on screen itself,
  // holds the prefetch off, and names that tree to every batch (the retry included).
  let land = null;
  let landed = false;
  let heldDuringPass = null;
  const { page, calls, env, view, treeOf } = makeEnv({
    live: true,
    fail: ['0_0_0|1'],
    afterBrick: (p) => {
      if (heldDuringPass === null) heldDuringPass = p.holds();
      if (!landed && land) { landed = true; land(); }
    },
  });
  const spec = { mode: 'xy', value: 0.37, slabThickness: 1, projection: 'single' };
  const preview = await page.preview(spec);
  land = page.startRequest(13);
  assert.equal(view.mounted.manifest.frame, 13, 'the stalled stream mounted its own tree');
  await page.upgrade(preview, 7);
  assert.ok(landed, 'the superseded load settled during the pass');
  assert.equal(view.shown, 12, 'frame 12 stays on screen');
  assert.deepEqual(env.loads, [], 'frame 12, on screen, is not loaded again');
  assert.deepEqual(calls.inits, [12], 'the tree on screen is mounted for the pass');
  assert.equal(calls.batches.length, 2, 'a first batch and a retry');
  assert.ok(calls.batches.every(b => b.frame === 12 && !b.refused), 'every batch reads frame 12\'s bricks, never 13\'s');
  assert.ok(calls.batches.every(b => b.opts.manifest === treeOf(12).manifest), 'every batch names the tree it was planned on');
  assert.equal(calls.finals.length, 1);
  assert.equal(calls.finals[0].sr.timepoint, 12);
  assert.ok(env.prefetch.stops >= 1, 'the prefetch is stopped for the pass');
  assert.ok(heldDuringPass > 0, 'and held off while it runs');
  assert.equal(page.holds(), 0, 'released at the end');
  assert.ok(env.prefetch.kicks >= 1, 'and kicked again');
  console.log('timelapse: the frame on screen is mounted for the pass, every batch reads it: OK');
}
{
  // Another tree mounted under the pass while its frame stays on screen: the next batch
  // is refused by the loader instead of serving that tree's bricks under frame 12.
  let remounted = false;
  const { page, calls, env } = makeEnv({
    live: true,
    fail: ['0_0_0|1'],
    afterBrick: () => { if (!remounted) { remounted = true; env.mountTree(13); } },
  });
  const preview = await page.preview({ mode: 'xy', value: 0.37, slabThickness: 1, projection: 'single' });
  await page.upgrade(preview, 7);
  assert.ok(remounted);
  assert.equal(calls.batches.length, 2);
  assert.equal(calls.batches[0].frame, 12, 'the first batch kept the tree it started on');
  assert.ok(calls.batches[1].refused, 'the retry batch is refused on the other tree');
  assert.equal(calls.finals.length, 0, 'no final picture mixing two frames');
  assert.ok(calls.status.some(t => /unavailable/.test(t)), 'reported as a failure, the preview kept');
  assert.ok(!calls.progress.some(p => /no longer on frame/.test(p.state?.label || '')), 'the frame on screen did not change');
  assert.equal(page.holds(), 0, 'the hold is released');
  console.log('timelapse: a tree mounted under the pass fails the batch, never read: OK');
}
{
  // The tree on screen cannot be mounted (its index refused): no batch, the preview kept.
  const { page, calls, env } = makeEnv({ live: true, mountFails: true });
  const preview = await page.preview({ mode: 'xy', value: 0.37, slabThickness: 1, projection: 'single' });
  page.startRequest(13);
  await page.upgrade(preview, 7);
  assert.equal(calls.batches.length, 0, 'nothing read from the tree of another frame');
  assert.equal(calls.finals.length + calls.partials.length, 0);
  assert.ok(calls.status.some(t => /unavailable/.test(t)));
  assert.equal(page.holds(), 0);
  assert.ok(env.prefetch.kicks >= 1);
}
{
  // Playback stalled on first-visit frame 13: its coarse level is on screen (scrubber 13,
  // loader card gone) while _currentTimepoint still names 12. The preview is frame 13's
  // and says so; the pass waits for frame 13's own load to land and reads frame 13, so
  // the preview standing in for switched-off channels and missing chunks is that frame.
  const { page, calls, env, view, timeline, treeOf, flushTimers } = makeEnv({ live: true, fail: ['0_0_0|1'] });
  const land = page.startRequest(13, { coarse: true });
  const preview = await page.preview({ mode: 'xy', value: 0.37, slabThickness: 1, projection: 'single' });
  assert.equal(page.timepoint(), 12, 'the load of frame 13 has not resolved');
  assert.equal(preview.timepoint, 13, 'the preview names the frame on screen, not _currentTimepoint');
  const run = page.upgrade(preview, 7);
  await turns(flushTimers);
  assert.deepEqual(env.loads, [], 'frame 12 is not put back, frame 13 not started over');
  assert.equal(calls.batches.length, 0, 'nothing read before frame 13 has landed');
  assert.equal(view.shown, 13, 'frame 13 stays on screen');
  land();
  await drive(run, flushTimers);
  assert.equal(page.timepoint(), 13);
  assert.equal(view.shown, 13);
  assert.deepEqual(timeline.frames.at(-1), [13, true, false], 'the scrubber stays on the figure\'s frame');
  assert.ok(calls.batches.length >= 1 && calls.batches.every(b => b.frame === 13 && !b.refused), 'every batch reads frame 13\'s bricks');
  assert.ok(calls.batches.every(b => b.opts.manifest === treeOf(13).manifest));
  assert.equal(calls.finals.length, 1);
  assert.equal(calls.finals[0].sr.timepoint, 13, 'the native picture is the preview\'s frame');
  assert.ok(!calls.progress.some(p => /no longer on frame/.test(p.state?.label || '')), 'no frame-lost notice');
  console.log('timelapse: a first-visit frame\'s coarse level on screen labels the preview, the pass waits for it: OK');
}
{
  // The same, but frame 13's load fails while the pass waits: frame 12 comes back on
  // screen, and the figure (frame 13's preview) keeps its picture with the notice; the
  // failing frame is not loaded again, and no brick of frame 12 is read under its label.
  const { page, calls, env, view, timeline, flushTimers } = makeEnv({ live: true });
  const land = page.startRequest(13, { coarse: true });
  const preview = await page.preview({ mode: 'xy', value: 0.37, slabThickness: 1, projection: 'single' });
  const run = page.upgrade(preview, 7);
  await turns(flushTimers);
  land({ fails: true });
  await drive(run, flushTimers);
  assert.equal(view.shown, 12);
  assert.deepEqual(env.loads, [], 'not retried');
  assert.equal(calls.batches.length, 0, 'no brick of another frame is read');
  assert.equal(calls.finals.length + calls.partials.length, 0, 'nothing reaches the figure');
  assert.deepEqual(timeline.frames.at(-1), [12, true, false], 'the scrubber goes back to the frame on screen');
  assert.ok(calls.progress.some(p => /no longer on frame 013/.test(p.state?.label || '')), 'the Studio says why');
  console.log('timelapse: the figure\'s frame failing to land keeps the preview: OK');
}
{
  // A first-visit frame's coarse level takes the screen in the middle of the pass,
  // _currentTimepoint unchanged: the pass stops as a frame change, not as a failure.
  let moved = false;
  const { page, calls, env } = makeEnv({
    live: true,
    afterBrick: () => { if (!moved && calls.batches.length) { moved = true; env.show(14, { streamed: true }); } },
  });
  const preview = await page.preview({ mode: 'xy', value: 0.37, slabThickness: 1, projection: 'single' });
  await page.upgrade(preview, 7);
  assert.ok(moved);
  assert.equal(page.timepoint(), 12, '_currentTimepoint did not move');
  assert.equal(calls.finals.length, 0, 'no final picture of a mixed pass');
  assert.ok(calls.batches[0].opts.signal.aborted, 'the batch is cancelled');
  assert.ok(calls.progress.some(p => /no longer on frame 012/.test(p.state?.label || '')), 'the Studio says why');
  assert.ok(!calls.status.some(t => /unavailable/.test(t)), 'not reported as a failure');
  console.log('timelapse: another frame\'s coarse level on screen mid-pass stops it: OK');
}
{
  // Nothing on screen (the WebGL context lost, or restored without its volume: the
  // replay refused after repeated GPU resets) while the prefetch moved the mount on to
  // frame 15. The figure's frame is not taken from _currentTimepoint (12) nor its bricks
  // from the mount: frame 12 is put back on screen first, and only its tree is read.
  const { page, calls, env, view, treeOf } = makeEnv({ live: true });
  const preview = await page.preview({ mode: 'xy', value: 0.37, slabThickness: 1, projection: 'single' });
  assert.equal(preview.timepoint, 12);
  env.loseContext();
  env.mountTree(15);
  await page.upgrade(preview, 7);
  assert.deepEqual(env.loads, [12], 'frame 12 is loaded again, nothing being on screen');
  assert.equal(view.shown, 12);
  assert.deepEqual(calls.inits, [12], 'its tree is mounted for the pass, not the prefetch\'s');
  assert.ok(calls.batches.length >= 1 && calls.batches.every(b => b.frame === 12 && b.opts.manifest === treeOf(12).manifest), 'no brick of frame 15 is read');
  assert.equal(calls.finals.length, 1);
  assert.equal(calls.finals[0].sr.timepoint, 12);
  console.log('timelapse: nothing on screen, the figure\'s frame is put back before the pass: OK');
}
{
  // The same, and frame 12 cannot be put back: no batch, the preview kept with the notice.
  const { page, calls, env, view } = makeEnv({ live: true, loadFails: true });
  const preview = await page.preview({ mode: 'xy', value: 0.37, slabThickness: 1, projection: 'single' });
  env.loseContext();
  env.mountTree(15);
  await page.upgrade(preview, 7);
  assert.deepEqual(env.loads, [12]);
  assert.equal(view.shown, null);
  assert.deepEqual(calls.inits, [], 'nothing mounted');
  assert.equal(calls.batches.length, 0, 'no brick of frame 15 read under frame 12\'s label');
  assert.equal(calls.finals.length + calls.partials.length, 0, 'nothing reaches the figure');
  assert.ok(calls.progress.some(p => /no longer on frame 012/.test(p.state?.label || '')), 'the Studio says why');
  assert.ok(!calls.status.some(t => /Native slice ready/.test(t)));
  console.log('timelapse: nothing on screen and the frame not put back keeps the preview: OK');
}
{
  // The context is lost in the middle of the pass (the volume freed, the prefetch free to
  // mount further frames): the pass stops there, nothing more reaches the figure.
  let lost = false;
  const { page, calls, env } = makeEnv({
    live: true,
    afterBrick: () => { if (!lost && calls.batches.length) { lost = true; env.loseContext(); env.mountTree(15); } },
  });
  const preview = await page.preview({ mode: 'xy', value: 0.37, slabThickness: 1, projection: 'single' });
  await page.upgrade(preview, 7);
  assert.ok(lost);
  assert.equal(calls.batches.length, 1, 'no batch after the volume left the screen');
  assert.ok(calls.batches[0].opts.signal.aborted, 'the batch is cancelled');
  assert.equal(calls.finals.length, 0, 'no final picture');
  assert.ok(calls.progress.some(p => /no longer on frame 012/.test(p.state?.label || '')));
  console.log('timelapse: the volume leaving the screen mid-pass stops it: OK');
}
{
  // A volume without a time axis and nothing on screen: the mount is its only tree, but
  // nothing is shown to read from - native unavailable, the preview kept.
  const { page, calls, env } = makeEnv();
  const preview = await page.preview({ mode: 'xy', value: 0.37, slabThickness: 1, projection: 'single' });
  env.loseContext();
  await page.upgrade(preview, 7);
  assert.equal(calls.batches.length, 0);
  assert.equal(calls.finals.length, 0);
  assert.ok(calls.status.some(t => /unavailable/.test(t)), 'native unavailable');
}
{
  // The prefetch, which mounts the frames after the one on screen, stays off while a pass
  // holds the mount.
  const run = lift('_runPrefetch');
  assert.ok(/document\.hidden \|\| _nativePassHolds > 0\) return;/.test(run), '_runPrefetch does not start during a native pass');
  assert.equal((run.match(/_nativePassHolds > 0\) break;/g) || []).length, 2, 'and a running one stops before its next frame');
}
{
  // A volume without a time axis is not concerned.
  const { page, calls, env } = makeEnv();
  const preview = await page.preview({ mode: 'xy', value: 0.37, slabThickness: 1, projection: 'single' });
  page.mount(5);
  await page.upgrade(preview, 7);
  assert.deepEqual(env.loads, [], 'nothing reloaded');
  assert.equal(calls.finals.length, 1);
}
{
  // The figure's frame is streamed again (frame 13 landed behind the Studio) and the
  // operator closes the Studio and drags the scrubber to frame 20 meanwhile: that scrub
  // starts at once and supersedes the reload, which then leaves the scrubber alone - it
  // must not be put back on frame 13 while frame 20 lands on screen.
  const { page, calls, env, view, timeline, studio, flushTimers } = makeEnv({ live: true, slowLoads: true });
  const preview = await page.preview({ mode: 'xy', value: 0.37, slabThickness: 1, projection: 'single' });
  page.mount(13);
  const run = page.upgrade(preview, 7);
  await turns(flushTimers);
  assert.deepEqual(env.loads, [12], 'the figure\'s frame is streamed again');
  studio.open = false;
  const seen = timeline.frames.length;
  page.request(20);
  assert.deepEqual(env.loads, [12, 20], 'the scrub starts at once, superseding the reload');
  env.gates[0].release();
  await drive(run, flushTimers);
  assert.deepEqual(timeline.frames.slice(seen), [], 'the superseded reload leaves the scrubber on the operator\'s frame');
  env.gates[1].release();
  await turns(flushTimers);
  assert.equal(page.timepoint(), 20);
  assert.equal(view.shown, 20, 'frame 20 on screen, as the scrubber says');
  assert.equal(calls.batches.length, 0, 'the closed figure reads nothing');
  console.log('timelapse: a scrub superseding the figure\'s reload keeps the scrubber: OK');
}
{
  // Format 6 runs no pass at open: the Studio itself drops the load of frame 13 streaming
  // behind frame 12 (a revisit, activation deferred) and the frame queued behind it, so
  // frame 13 never lands under the figure and the lossless export pass reads frame 12 on
  // screen instead of streaming it a second time.
  const { page, calls, env, view, timeline, studio, flushTimers } = makeEnv({ live: true, v6: true });
  const land = page.startRequest(13);
  page.queue(14);
  await drive(page.openStudio(), flushTimers);
  assert.equal(studio.opened.length, 1, 'the Studio opened');
  assert.equal(studio.opened[0].timepoint, 12, 'on frame 12');
  assert.equal(calls.batches.length, 0, 'format 6: no pass at open');
  assert.equal(view.displayCancels, 1, 'the stream of frame 13 is cancelled at open');
  assert.equal(page.pending(), null, 'the frame queued behind it is dropped');
  assert.equal(page.target(), null, 'no frame request targets the dropped frame any more');
  assert.deepEqual(timeline.frames.at(-1), [12, true, false], 'the scrubber is on the figure\'s frame');
  land();
  assert.equal(view.shown, 12, 'frame 13 never lands under the figure');
  assert.equal(page.timepoint(), 12);
  assert.equal(await drive(page.ensureNative(), flushTimers), true, 'the export gets its lossless picture');
  assert.deepEqual(env.loads, [], 'frame 12, on screen, is not streamed again');
  assert.equal(view.displayCancels, 1, 'nothing more cancelled');
  assert.equal(calls.finals.length, 1);
  assert.equal(calls.finals[0].sr.timepoint, 12);
  console.log('format 6: the Studio drops another frame\'s load at open, the export reads the frame on screen: OK');
}
{
  // Other formats: the drop at open is the only one, the pass at open finds nothing to drop.
  const { page, calls, env, view, flushTimers } = makeEnv({ live: true });
  const land = page.startRequest(13);
  await drive(page.openStudio(), flushTimers);
  land();
  assert.equal(view.displayCancels, 1, 'one cancel, at open');
  assert.deepEqual(env.loads, []);
  assert.equal(calls.finals.length, 1);
  assert.equal(calls.finals[0].sr.timepoint, 12);
  // A first-visit frame's coarse level on screen is the figure's frame: its load is kept.
  const first = makeEnv({ live: true, v6: true });
  const landFirst = first.page.startRequest(13, { coarse: true });
  first.page.queue(14);
  await drive(first.page.openStudio(), first.flushTimers);
  assert.equal(first.studio.opened[0].timepoint, 13);
  assert.equal(first.view.displayCancels, 0, 'the figure\'s own frame keeps loading');
  assert.equal(first.page.pending(), null, 'the frame queued behind it is dropped');
  landFirst();
  assert.equal(first.page.timepoint(), 13);
  console.log('openStudio holds the figure\'s frame on every format: OK');
}
{
  // Opening the Studio pauses playback before the preview is rendered.
  const open = lift('openStudio');
  const pause = open.indexOf('Timeline.pause()');
  assert.ok(pause > 0 && pause < open.indexOf('_renderStudioPreviewSlice('), 'openStudio pauses the timeline before the preview');
  console.log('openStudio pauses playback first: OK');
}

console.log('Studio native pass (viewer.js): OK');
