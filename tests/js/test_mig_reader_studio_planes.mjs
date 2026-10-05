// The Studio's native XY picture read from a format-2 planes/ tree is the picture the
// bricks give — pixel for pixel (DOCS/dataset-migrations/SPEC.md §8).
//
// viewer.js _renderNativeSliceForStudio runs as written (lifted from the source with
// every helper it calls), twice on the same synthetic volume: once on a format-1
// dataset (the bricks, composed and floor-LUT'ed as BrickLoader delivers them) and
// once on a format-2 dataset (the REAL PlaneLoader over a planes tree written with
// PlaneCodec, served by a Range-honouring mocked fetch, decoded by the REAL
// plane-decode-worker in a vm). Both fill a CPU stand-in of the plane texture
// (VolumeSlicer.createPlaneVolume); the shader is emulated in float32 over it (the
// PLANE_TEX rawAt of test_viewerpage_native_plane.mjs). Compared: the texture and its
// presence, layer by layer, and the final raw picture, against each other and
// against the volume itself. Covered: XY single planes (mid-voxel, on a voxel face —
// two layers across a brick seam), z-stack MIP slabs (whole stack, part of it rolled,
// −Z face), a channel switched off, ESS-dropped bricks (zero tiles), a live
// timepoint's planes/tNNN, the fall-back to the bricks on a missing pack or a stale
// planes tree, and the paths the planes never serve (XZ, a format-1 dataset).
//
// Run: node tests/js/test_mig_reader_studio_planes.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { loadModule, ROOT } from './harness.mjs';
import { PlaneCodec, buildTree, mockFetch, loadPlaneLoader } from './test_mig_reader_plane_loader.mjs';

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

// ── The synthetic volume ────────────────────────────────────────────────────────
const BS = 16;
const TILE = 32;                                     // a multiple of the brick size
const DIMS = { x: 70, y: 52, z: 41, brickSize: BS, channels: 4 };
const PHYSICAL = { x: 140, y: 104, z: 205 };
const grid = { nx: Math.ceil(DIMS.x / BS), ny: Math.ceil(DIMS.y / BS), nz: Math.ceil(DIMS.z / BS) };
const EMPTY = new Set(['1_1_1', '2_0_1', '0_3_0', '0_3_2', '4_3_0', '4_3_1', '4_3_2']);
const ACTIVE = [];
for (let bz = 0; bz < grid.nz; bz++) for (let by = 0; by < grid.ny; by++) for (let bx = 0; bx < grid.nx; bx++) {
  if (!EMPTY.has(`${bx}_${by}_${bz}`)) ACTIVE.push({ bx, by, bz });
}
const brickOf = (x, y, z) => `${Math.floor(x / BS)}_${Math.floor(y / BS)}_${Math.floor(z / BS)}`;
// Stored LOD0 values (what the brick decoder produces); an ESS-dropped brick is zeros.
const stored = (x, y, z, c) => (EMPTY.has(brickOf(x, y, z)) ? 0
  : ((x * 73856093) ^ (y * 19349663) ^ (z * 83492791) ^ (c * 2654435761)) >>> 0 & 255);
// Floor LUTs as VolumeViewer builds them (a different floor per channel).
const LUTS = [9, 0, 30, 4].map((floor) => {
  const lut = new Uint8Array(256);
  const scale = 255 / Math.max(1, 255 - floor);
  for (let i = 0; i < 256; i++) lut[i] = i <= floor ? 0 : Math.min(255, Math.round((i - floor) * scale));
  return lut;
});

const BRICKS_MANIFEST_TEXT = '{"schema":"iribhm-bricks-v2","dataset":"demo","levels":[{"level":0}]}';

const f = Math.fround;
const fadd = (a, b) => f(f(a) + f(b));
const fmul = (a, b) => f(f(a) * f(b));

/** The slice shader's RAW_OUTPUT main() in float32 (as test_viewerpage_native_plane.mjs). */
function renderRaw({ g, R, win, rawAt, reduced = false, fallbackChannels = [] }) {
  const out = new Uint8Array(win.w * win.h * 4);
  const E = g.extent;
  const steps = g.steps;
  const delta = f(g.delta);
  const projected = !(g.projMode === 0 || steps <= 1);
  const halfSlab = fmul(fmul(steps - 1, delta), 0.5);
  const inBox = (u) => u.x >= 0 && u.y >= 0 && u.z >= 0 && u.x <= 1 && u.y <= 1 && u.z <= 1;
  for (let j = 0; j < win.h; j++) {
    for (let i = 0; i < win.w; i++) {
      const uvx = f((win.x + i + 0.5) / R);
      const uvy = f((R - win.y - j - 0.5) / R);
      const pcx = fmul(fmul(uvx - 0.5, 2), E);
      const pcy = fmul(fmul(uvy - 0.5, 2), E);
      const base = {};
      for (const k of ['x', 'y', 'z']) base[k] = fadd(fadd(g.origin[k], fmul(pcx, g.right[k])), fmul(pcy, g.up[k]));
      let raw = [0, 0, 0, 0];
      let missing = false;
      let empty = false;
      if (!projected) {
        const uvw = { x: fadd(base.x, 0.5), y: fadd(base.y, 0.5), z: fadd(base.z, 0.5) };
        if (!inBox(uvw)) empty = true;
        else {
          const s = rawAt(uvw);
          raw = s.v;
          missing = !s.present;
        }
      } else {
        let hits = 0;
        for (let n = 0; n < steps; n++) {
          const t = fadd(-halfSlab, fmul(n, delta));
          const uvw = {};
          for (const k of ['x', 'y', 'z']) uvw[k] = fadd(fadd(base[k], fmul(t, g.step[k])), 0.5);
          if (!inBox(uvw)) continue;
          const s = rawAt(uvw);
          if (!s.present) missing = true;
          raw = raw.map((v, c) => Math.max(v, s.v[c]));
          hits++;
          if (reduced) break;
        }
        if (!hits) empty = true;
      }
      const o = (j * win.w + i) * 4;
      if (empty) continue;
      // A chunk still missing shows the preview: a sentinel here, never a voxel value pattern.
      if (missing) { out.set([1, 2, 3, 4], o); continue; }
      for (const c of fallbackChannels) raw[c] = 0xAB;
      out.set(raw, o);
    }
  }
  return out;
}

function cpuPlaneVolume(desc) {
  const axes = Ops.PLANE_AXES[desc.axis];
  const W = desc.dims[axes[0]], H = desc.dims[axes[1]], L = desc.layers;
  const bs = desc.brickSize;
  const cu = Math.ceil(W / bs), cv = Math.ceil(H / bs);
  const tex = new Uint8Array(W * H * L * 4);
  const presence = new Uint8Array(cu * cv * L);
  return {
    axis: desc.axis, width: W, height: H, layers: L, layerBase: desc.layerBase, reduced: desc.reduced,
    brickSize: bs, dims: desc.dims, texture: { tex }, presence: { presence }, bytes: W * H * L * 4, disposed: false,
    upload(u0, v0, w, h, layer, data) {
      if (u0 < 0 || v0 < 0 || u0 + w > W || v0 + h > H || layer < 0 || layer >= L || data.length < w * h * 4) return false;
      for (let r = 0; r < h; r++) tex.set(data.subarray(r * w * 4, (r + 1) * w * 4), ((layer * H + v0 + r) * W + u0) * 4);
      return true;
    },
    setPresent(bu, bv, layer, on = true) { presence[(layer * cv + bv) * cu + bu] = on ? 255 : 0; },
    flushErrors() { return []; },
    dispose() { this.disposed = true; }
  };
}

function planeRawAt(plane) {
  const dim = plane.dims;
  const k = plane.axis;
  const [U, V] = Ops.PLANE_AXES[k];
  const cu = Math.ceil(plane.width / plane.brickSize);
  const cv = Math.ceil(plane.height / plane.brickSize);
  return (uvw) => {
    const vox = {};
    for (const a of ['x', 'y', 'z']) vox[a] = Math.floor(Math.min(Math.max(fmul(uvw[a], dim[a]), 0), dim[a] - 1));
    const layer = plane.reduced ? 0 : vox[k] - plane.layerBase;
    if (layer < 0 || layer >= plane.layers) return { present: false, v: [0, 0, 0, 0] };
    const bu = Math.floor(vox[U] / plane.brickSize), bv = Math.floor(vox[V] / plane.brickSize);
    if (!(plane.presence.presence[(layer * cv + bv) * cu + bu] > 127)) return { present: false, v: [0, 0, 0, 0] };
    const o = ((layer * plane.height + vox[V]) * plane.width + vox[U]) * 4;
    return { present: true, v: Array.from(plane.texture.tex.subarray(o, o + 4)) };
  };
}

// The volume itself (LUT'ed, every channel wanted): the truth of a picture.
const truthRawAt = (wanted) => (uvw) => {
  const v = {};
  for (const k of ['x', 'y', 'z']) v[k] = Math.floor(Math.min(Math.max(fmul(uvw[k], DIMS[k]), 0), DIMS[k] - 1));
  return { present: true, v: [0, 1, 2, 3].map(c => (wanted.includes(c) ? LUTS[c][stored(v.x, v.y, v.z, c)] : 0)) };
};

// ── The planes trees (3d at <ds>/planes, live at <ds>/planes/t002) ───────────────
const DS3 = 'DATA_WEB/3d/demo';
const DSL = 'DATA_WEB/live/demo';
const tree3 = await buildTree({ base: `${DS3}/planes`, dims: DIMS, channels: 4, tileSize: TILE, voxel: stored, bricksManifest: BRICKS_MANIFEST_TEXT });
// The live timepoint 2 holds other values, so reading another timepoint's planes would show.
const storedLive = (x, y, z, c) => (stored(x, y, z, c) ^ 0x5A) & (EMPTY.has(brickOf(x, y, z)) ? 0 : 255);
const treeL = await buildTree({ base: `${DSL}/planes/t002`, dims: DIMS, channels: 4, tileSize: TILE, voxel: storedLive, bricksManifest: BRICKS_MANIFEST_TEXT });
function filesFor(which) {
  const files = new Map(which === 'live' ? treeL.files : tree3.files);
  files.set(`${which === 'live' ? DSL : DS3}/bricks/manifest.json`, (which === 'live' ? treeL : tree3).bricksBytes);
  return files;
}

/**
 * The page under test on one dataset. format 1 or 2; `files` the served tree;
 * `live` a timelapse at timepoint 2; `disabled` channels switched off.
 */
function makePage({ format = 2, files = filesFor('3d'), live = false, disabled = [], zstack = false, confirmBytes = 256 * 1024 * 1024, Dialog } = {}) {
  const value = live ? storedLive : stored;
  const calls = { batches: [], planes: [], raws: [], progress: [] };
  const fetchImpl = mockFetch(files);
  const PlaneLoader = loadPlaneLoader(fetchImpl);
  const BrickLoader = {
    isReady: () => true,
    getDimensions: (lod) => (lod === 0 ? DIMS : null),
    getTransportEncoding: () => 'webp-lossless',
    getManifest: () => ({ levels: [{}] }),
    activeBricks: () => ACTIVE,
    hasBrick: (bx, by, bz) => !EMPTY.has(`${bx}_${by}_${bz}`),
    estimateTaskBytes: (tasks) => tasks.length * 5000,
    taskBytes: () => 5000,
    // As the real loader composes: the task's box cut to the volume, channels at
    // their component, floor LUT applied, z-major RGBA.
    async loadBrickTasks(tasks, opts) {
      calls.batches.push({ tasks, opts });
      const summary = { total: tasks.length, delivered: 0, failed: [], skipped: [], cancelled: false, reason: null };
      const byBrick = new Map();
      for (const t of tasks) {
        const k = `${t.bx}_${t.by}_${t.bz}`;
        if (!byBrick.has(k)) byBrick.set(k, []);
        byBrick.get(k).push(t);
      }
      for (const [, list] of byBrick) {
        const t0 = list[0];
        const bw = Math.min(BS, DIMS.x - t0.bx * BS), bh = Math.min(BS, DIMS.y - t0.by * BS), bd = Math.min(BS, DIMS.z - t0.bz * BS);
        const r = t0.region || { x0: 0, x1: BS, y0: 0, y1: BS, z0: 0, z1: BS };
        const box = { x0: r.x0, x1: Math.min(r.x1, bw), y0: r.y0, y1: Math.min(r.y1, bh), z0: r.z0, z1: Math.min(r.z1, bd) };
        const rw = box.x1 - box.x0, rh = box.y1 - box.y0, rd = box.z1 - box.z0;
        const data = new Uint8Array(rw * rh * rd * 4);
        const luts = opts.compose?.luts || [];
        for (const t of list) {
          let o = 0;
          for (let z = box.z0; z < box.z1; z++) for (let y = box.y0; y < box.y1; y++) for (let x = box.x0; x < box.x1; x++, o++) {
            const v = value(t.bx * BS + x, t.by * BS + y, t.bz * BS + z, t.channel);
            data[o * 4 + t.channel] = luts[t.channel] ? luts[t.channel][v] : v;
          }
        }
        summary.delivered += list.length;
        const full = box.x0 === 0 && box.y0 === 0 && box.z0 === 0 && box.x1 === BS && box.y1 === BS && box.z1 === BS;
        opts.onBrickLoaded({ bx: t0.bx, by: t0.by, bz: t0.bz, lod: 0, channel: 'rgba', composed: true, components: 4, data, region: full ? null : box, channels: list.map(t => t.channel), failedChannels: [] });
        opts.onProgress?.(summary.delivered / tasks.length);
        await Promise.resolve();
      }
      const out = new Map();
      out.summary = summary;
      return out;
    }
  };
  const VolumeSlicer = {
    planeGeometry: RealSlicer.planeGeometry,
    samplingSpace: () => null,
    getPlaneExtentUnits: () => 1.5,
    getPlaneSpec: () => ({ mode: 'xy', value: 0.5 }),
    createPlaneVolume: (desc) => {
      const plane = cpuPlaneVolume(desc);
      calls.planes.push(plane);
      return plane;
    },
    renderWithMaterial: () => null,
    renderRawWithMaterial(mat, spec, size, opts = {}) {
      const g = Ops.plainGeometry(RealSlicer.planeGeometry(spec, PHYSICAL, null));
      const win = opts.window || { x: 0, y: 0, w: size, h: size };
      const plane = opts.plane;
      const data = renderRaw({ g, R: size, win, rawAt: planeRawAt(plane), reduced: plane.reduced, fallbackChannels: opts.fallbackChannels || [] });
      const raw = { data, width: win.w, height: win.h, channels: 4, projected: g.projected, coverage: false };
      calls.raws.push(raw);
      return raw;
    },
    releaseForeign: () => {}
  };
  class SVRManager {
    init() { throw new Error('no 3D atlas in this test'); }
    dispose() {}
  }
  const VolumeViewer = {
    getRenderer: () => ({}),
    getMaterial: () => ({ defines: {}, uniforms: { numChannels: { value: 4 } } }),
    getPhysicalSize: () => PHYSICAL,
    getPhysicalCalibration: () => ({ calibrationStatus: 'exact' }),
    floorLutsFromManifest: (manifest, channels) => LUTS.slice(0, channels)
  };
  const channelState = [0, 1, 2, 3].map(c => ({ enabled: !disabled.includes(c) }));
  const body = `
    let _nativeSliceAbort = null;
    let _nativePassSeq = 0;
    let _currentTimepoint = env.live ? 2 : 0;
    let _brickManifest = env.live ? { timepoints: { t000: { path: 't000' }, t001: { path: 't001' }, t002: { path: 't002' } } } : null;
    let _planeWorker = null;
    let _planeWorkerFailed = false;
    let _planeJobSeq = 0;
    const _planeJobs = new Map();
    const STUDIO_PREVIEW_MAX = 2048;
    const STUDIO_CONFIRM_BYTES = env.confirmBytes;
    const datasetMeta = { formatVersion: env.format, dimensions: { c: 4 } };
    const _planeTrees = new Map();
    let _basePath = env.live ? '${DSL}' : '${DS3}';
    let _zstackActive = env.zstack;
    function _setSliceStatus() {}
    function _t(key, fallback) { return fallback; }
    function _currentChannelState() { return env.channelState; }
    function _copyCanvas(c) { return c; }
    ${['_cancelNativeSlice', '_nativeSliceBricksForSpec', '_nativeStudioRenderSize', '_slicePixelSizeUm', '_sliceWindowForRect',
      '_needsCoverageMask', '_withCoverageMask', '_nativeSliceChannels', '_nativePassPlan', '_atlasNativeBackend', '_planeNativeBackend',
      '_renderNativeSliceForStudio', '_studioGeometry', '_studioCalibrated', '_planeWorkerInstance', '_planeJob', '_studioCoverageMask',
      '_reducePlaneTile', '_nativeLabel', '_scaleCropRect', '_tf', '_planesBaseOnScreen', '_planesTreeOnScreen', '_planesServePass',
      '_planesPassEstimate', '_nativePassEstimate', '_confirmLargeNativePass'].map(lift).join('\n')}
    return { native: _renderNativeSliceForStudio, planesEstimate: _planesPassEstimate, bricksEstimate: _nativePassEstimate, confirm: _confirmLargeNativePass };
  `;
  const warnings = [];
  const page = new Function(
    'env', 'document', 'console', 'performance', 'navigator', 'THREE', 'Worker',
    'BrickLoader', 'SVRManager', 'VolumeSlicer', 'VolumeViewer', 'SliceCompositor', 'StudioPlaneOps', 'DOMException',
    'PlaneLoader', 'PlaneCodec', 'Dialog', body
  )(
    { format, live, channelState, zstack, confirmBytes }, { createElement: () => ({ getContext: () => null }) },
    { warn: (...a) => warnings.push(a.map(String).join(' ')), log() {} },
    { now: () => Date.now() }, { hardwareConcurrency: 8 }, THREE, undefined,
    BrickLoader, SVRManager, VolumeSlicer, VolumeViewer, { isRaw: (r) => Boolean(r && r.data && r.width > 0) }, Ops, globalThis.DOMException,
    PlaneLoader, PlaneCodec, Dialog
  );
  return { page, calls, fetchLog: fetchImpl.log, warnings };
}

async function run(opts, spec) {
  const env = makePage(opts);
  const progress = [];
  const renderRes = Math.ceil(Math.max(DIMS.x, DIMS.y) * 1.5);
  // The Studio preview stands in for missing chunks (and lets a MIP slab take the
  // reduced plane path); the emulator shows a sentinel where it would.
  const rect = Ops.cropRect(Ops.plainGeometry(RealSlicer.planeGeometry(spec, PHYSICAL, null)), renderRes, null);
  const w = rect.x2 - rect.x + 1, h = rect.y2 - rect.y + 1;
  const fallback = { raw: { data: new Uint8Array(w * h * 4), width: w, height: h, channels: 4 }, rect: { ...rect, renderRes }, canvas: null };
  const sr = await env.page.native({ spec, renderRes, fallback, onProgress: (p) => progress.push(p) });
  assert.ok(sr, 'a native picture');
  return { ...env, sr, progress };
}

const sameBytes = (a, b) => {
  if (a.length !== b.length) return Infinity;
  let d = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++;
  return d;
};

/** The planes pass and the bricks pass of `spec`: same texture, same picture, the truth. */
async function compare(label, spec, { disabled = [], live = false } = {}) {
  const files = filesFor(live ? 'live' : '3d');
  const bricks = await run({ format: 1, files, live, disabled }, spec);
  const planes = await run({ format: 2, files, live, disabled }, spec);
  assert.equal(bricks.sr.path, 'plane', `${label}: format 1 reads the bricks`);
  assert.equal(planes.sr.path, 'planes', `${label}: format 2 reads planes/ (${planes.warnings.join(' | ')})`);
  assert.equal(planes.calls.batches.length, 0, `${label}: no brick fetched by the planes pass`);
  assert.ok(!bricks.fetchLog.some(e => e.path.endsWith('.bin')), `${label}: format 1 never touches planes/`);
  assert.equal(planes.sr.quality, 'native');
  assert.equal(planes.sr.missingChunks, 0);
  // The texture the shader reads, and which of its columns are present.
  const pt = planes.calls.planes[0], bt = bricks.calls.planes[0];
  assert.equal(pt.layers, bt.layers, `${label}: layers`);
  assert.equal(pt.layerBase, bt.layerBase);
  assert.equal(sameBytes(pt.presence.presence, bt.presence.presence), 0, `${label}: presence`);
  const texDiff = sameBytes(pt.texture.tex, bt.texture.tex);
  assert.equal(texDiff, 0, `${label}: plane texture, ${texDiff} bytes differ`);
  assert.ok(pt.disposed && bt.disposed, `${label}: textures released`);
  // The picture.
  const pr = planes.sr.raw, br = bricks.sr.raw;
  assert.deepEqual([pr.width, pr.height], [br.width, br.height]);
  assert.deepEqual({ ...planes.sr.cropRect }, { ...bricks.sr.cropRect });
  const picDiff = sameBytes(pr.data, br.data);
  assert.equal(picDiff, 0, `${label}: final picture, ${picDiff} bytes differ`);
  // Against the volume itself.
  const g = Ops.plainGeometry(RealSlicer.planeGeometry(spec, PHYSICAL, null));
  const R = planes.sr.renderRes;
  const rect = planes.sr.cropRect;
  const win = { x: rect.x, y: rect.y, w: rect.x2 - rect.x + 1, h: rect.y2 - rect.y + 1 };
  const wanted = [0, 1, 2, 3].filter(c => !disabled.includes(c));
  const truthVol = live
    ? (uvw) => {
      const v = {};
      for (const k of ['x', 'y', 'z']) v[k] = Math.floor(Math.min(Math.max(fmul(uvw[k], DIMS[k]), 0), DIMS[k] - 1));
      return { present: true, v: [0, 1, 2, 3].map(c => (wanted.includes(c) ? LUTS[c][storedLive(v.x, v.y, v.z, c)] : 0)) };
    }
    : truthRawAt(wanted);
  const truth = renderRaw({ g, R, win, rawAt: truthVol, fallbackChannels: disabled });
  const truthDiff = sameBytes(truth, pr.data);
  assert.equal(truthDiff, 0, `${label}: the picture is the volume's (${truthDiff} bytes differ)`);
  let shown = 0;
  for (let i = 0; i < pr.data.length; i += 4) if (pr.data[i] || pr.data[i + 2]) shown++;
  assert.ok(shown > win.w * win.h * 0.2, `${label}: not an empty picture`);
  // Progress: tiles as chunks, bytes from the planes, ending at 100 %.
  const last = planes.progress.at(-1);
  assert.ok(last.totalChunks > 0 && last.bytesTotal > 0, `${label}: progress counts tiles and bytes`);
  assert.equal(last.percent, 100);
  assert.equal(planes.sr.bytesTotal, planes.fetchLog.filter(e => e.path.endsWith('.bin')).reduce((s, e) => s + e.bytes, 0), `${label}: bytesTotal = the bytes fetched`);
  return { planes, bricks };
}

// ── XY single planes ────────────────────────────────────────────────────────────
{
  const r = await compare('XY 0.37', { mode: 'xy', value: 0.37, slabThickness: 1, projection: 'single' });
  const packs = r.planes.fetchLog.filter(e => e.path.endsWith('.bin')).map(e => e.path);
  assert.deepEqual([...new Set(packs)], [`${DS3}/planes/z00015.bin`], 'one plane: its pack alone');
  assert.ok(r.planes.fetchLog.every(e => !e.path.endsWith('.bin') || e.range), 'Range requests only');
  await compare('XY on a voxel face (two layers across a brick seam)', { mode: 'xy', value: 16 / 41, slabThickness: 1, projection: 'single' });
  await compare('XY through ESS-dropped bricks', { mode: 'xy', value: 20.5 / 41, slabThickness: 1, projection: 'single' });
  await compare('XY, channel 1 off', { mode: 'xy', value: 0.6, slabThickness: 1, projection: 'single' }, { disabled: [1] });
  console.log('XY single planes: planes/ = bricks = the volume: OK');
}

// ── Z-stack MIP slabs ─────────────────────────────────────────────────────────
function zstackSpec(lo, hi, { back = false, roll = 0 } = {}) {
  const n = hi - lo + 1;
  const c = (lo + n / 2) / DIMS.z;
  return { mode: 'oblique', axis: 'z', value: back ? 1 - c : c, yaw: back ? 180 : 0, pitch: 0, roll, slabThickness: n, slabStepNorm: 1 / DIMS.z, projection: n > 1 ? 'mip' : 'single' };
}
{
  const all = await compare('z-stack, whole stack', zstackSpec(0, DIMS.z - 1));
  const packs = new Set(all.planes.fetchLog.filter(e => e.path.endsWith('.bin')).map(e => e.path));
  assert.equal(packs.size, DIMS.z, 'one pack per slice of the slab');
  await compare('z-stack, slices 9..30 rolled 37°', zstackSpec(9, 30, { roll: 37 }));
  await compare('z-stack, −Z face rolled 120°', zstackSpec(3, 22, { back: true, roll: 120 }), { disabled: [3] });
  console.log('z-stack MIP slabs: planes/ = bricks = the volume: OK');
}

// ── A live timepoint reads planes/tNNN of the timepoint on screen ────────────────
{
  const r = await compare('live t002, XY', { mode: 'xy', value: 0.37, slabThickness: 1, projection: 'single' }, { live: true });
  assert.ok(r.planes.fetchLog.some(e => e.path === `${DSL}/planes/t002/manifest.json`));
  assert.ok(r.planes.fetchLog.filter(e => e.path.endsWith('.bin')).every(e => e.path.startsWith(`${DSL}/planes/t002/`)));
  console.log('live: planes/tNNN of the timepoint on screen: OK');
}

// ── Falls back to the bricks ─────────────────────────────────────────────────────
{
  const spec = { mode: 'xy', value: 0.37, slabThickness: 1, projection: 'single' };
  const reference = await run({ format: 1 }, spec);
  // A pack missing on the host: the planes pass fails, the bricks take over.
  const files = filesFor('3d');
  files.delete(`${DS3}/planes/z00015.bin`);
  const lost = await run({ format: 2, files }, spec);
  assert.equal(lost.sr.path, 'plane', 'a missing pack: the bricks');
  assert.ok(lost.warnings.some(w => /reading the bricks/.test(w)), 'logged');
  assert.equal(sameBytes(lost.sr.raw.data, reference.sr.raw.data), 0, 'the same picture');
  assert.equal(lost.calls.planes.length, 2, 'a fresh plane texture for the bricks');
  assert.ok(lost.calls.planes.every(p => p.disposed));
  // Planes cut from another bricks manifest (the dataset re-processed since).
  const stale = filesFor('3d');
  stale.set(`${DS3}/bricks/manifest.json`, new TextEncoder().encode(BRICKS_MANIFEST_TEXT.replace('demo', 'demo2')));
  const s = await run({ format: 2, files: stale }, spec);
  assert.equal(s.sr.path, 'plane', 'stale planes/: the bricks');
  assert.ok(!s.fetchLog.some(e => e.path.endsWith('.bin')), 'no pack of a stale tree is read');
  assert.ok(s.warnings.some(w => /not usable/.test(w)));
  // A corrupt tile: a decode error, never wrong pixels.
  const corrupt = filesFor('3d');
  const pack = corrupt.get(`${DS3}/planes/z00015.bin`).slice();
  const h = PlaneCodec.parsePackHeader(pack.subarray(0, PlaneCodec.headerBytes(4, 3, 2)));
  const e = h.entries.find(x => x.length > 0);
  pack[e.offset + 20] ^= 0x55;
  corrupt.set(`${DS3}/planes/z00015.bin`, pack);
  const c = await run({ format: 2, files: corrupt }, spec);
  assert.equal(c.sr.path, 'plane', 'a corrupt tile: the bricks');
  assert.equal(sameBytes(c.sr.raw.data, reference.sr.raw.data), 0);
  console.log('missing pack / stale tree / corrupt tile → the bricks, same picture: OK');
}

// ── What the planes never serve ──────────────────────────────────────────────────
{
  const xz = await run({ format: 2 }, { mode: 'xz', value: 0.62, slabThickness: 1, projection: 'single' });
  assert.equal(xz.sr.path, 'plane');
  assert.equal(xz.fetchLog.length, 0, 'an XZ cut does not even open planes/');
  console.log('XZ keeps the bricks: OK');
}

// ── The byte estimate of a slab reads the planes ─────────────────────────────────
{
  const { page } = makePage({ format: 2 });
  const spec = zstackSpec(0, DIMS.z - 1);
  const est = await page.planesEstimate(spec);
  const all = [...tree3.files].filter(([k]) => k.endsWith('.bin')).reduce((s, [, v]) => s + v.length, 0);
  assert.ok(est && est.bytes > 0 && Math.abs(est.bytes - all) / all < 0.25, `the planes estimate (${est && est.bytes}) is about the packs' size (${all})`);
  assert.equal(est.planes, DIMS.z, "every plane of the slab");
  assert.ok(est.planes >= 1 && est.tiles >= 1, 'the dialog can state the planes and tiles it reads');
  const none = makePage({ format: 1 });
  assert.equal(await none.page.planesEstimate(spec), null, 'format 1: no planes estimate');
  console.log('planes byte estimate: OK');
}

// ── The large-slab confirmation states what is actually read ─────────────────────
{
  const spec = zstackSpec(0, DIMS.z - 1);
  const ask = async (format) => {
    const asked = [];
    const Dialog = { ask: async (o) => { asked.push(o); return 'keep'; } };
    const { page } = makePage({ format, zstack: true, confirmBytes: 1, Dialog });
    assert.equal(await page.confirm(spec), null, 'keep the preview');
    assert.equal(asked.length, 1);
    return asked[0];
  };
  const viaPlanes = await ask(2);
  assert.match(viaPlanes.message, new RegExp(`reads ${DIMS.z} stored planes, about \\d+ MB \\(\\d+ image tiles\\)`), viaPlanes.message);
  assert.doesNotMatch(viaPlanes.message, /brick/, 'a planes read is not described in bricks');
  const viaBricks = await ask(1);
  assert.match(viaBricks.message, /every brick of them, about \d+ MB \(\d+ bricks\)/, viaBricks.message);
  console.log('large-slab confirmation: planes or bricks, as read: OK');
}

console.log('Studio native XY via planes/ = via bricks: OK');
