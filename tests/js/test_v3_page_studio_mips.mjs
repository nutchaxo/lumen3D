// The Studio's native z-stack MIP read from a format-3 mips/ tree (the per-channel
// maximum of each 64-plane brick layer, DOCS/dataset-migrations/SPEC.md §12) is the
// picture the planes give, which is the picture the bricks give — pixel for pixel.
//
// viewer.js _renderNativeSliceForStudio runs as written (lifted with every helper it
// calls) three times on one synthetic volume: a format-1 dataset (the bricks, composed
// and floor-LUT'ed as BrickLoader delivers them), a format-2 one (the REAL PlaneLoader
// over planes/) and a format-3 one (the REAL PlaneLoader over planes/ + mips/, through
// PlaneLoader.loadSlabMax), the trees written with PlaneCodec and served by a
// Range-honouring mocked fetch, decoded by the REAL plane-decode-worker in a vm. The
// three fill a CPU stand-in of the plane texture; the slice shader is emulated in
// float32 over it. Compared: the texture, its presence and the final raw picture,
// against each other and against the volume itself. Covered: the whole stack (every
// layer whole, the ragged last one included: no plane pack read), a slab with partial
// layers at both ends (layer MIPs + end planes), a slab inside one layer (no whole
// layer: the planes alone), a rolled slab, the −Z face with a channel off, a missing
// mips pack (→ every plane, same picture), a stale mips tree (→ the planes), the byte
// estimate and the large-figure dialog stated in layers.
//
// Run: node tests/js/test_v3_page_studio_mips.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
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

// ── The synthetic volume: three brick layers of planes (64 + 64 + 22) ─────────────
const BS = 16;
const TILE = 32;
const DIMS = { x: 70, y: 52, z: 150, brickSize: BS, channels: 4 };
const PHYSICAL = { x: 140, y: 104, z: 300 };
const LAYER = 64;
const LAYERS = Math.ceil(DIMS.z / LAYER);
const grid = { nx: Math.ceil(DIMS.x / BS), ny: Math.ceil(DIMS.y / BS), nz: Math.ceil(DIMS.z / BS) };
const EMPTY = new Set(['1_1_1', '2_0_5', '0_3_0', '0_3_7', '4_3_2', '4_3_8', '3_2_9']);
const ACTIVE = [];
for (let bz = 0; bz < grid.nz; bz++) for (let by = 0; by < grid.ny; by++) for (let bx = 0; bx < grid.nx; bx++) {
  if (!EMPTY.has(`${bx}_${by}_${bz}`)) ACTIVE.push({ bx, by, bz });
}
const brickOf = (x, y, z) => `${Math.floor(x / BS)}_${Math.floor(y / BS)}_${Math.floor(z / BS)}`;
// Sparse bright spots over a dim floor, so the maximum comes from different planes.
const stored = (x, y, z, c) => {
  if (EMPTY.has(brickOf(x, y, z))) return 0;
  const h = ((x * 73856093) ^ (y * 19349663) ^ (z * 83492791) ^ (c * 2654435761)) >>> 0;
  return (h % 11 === 0) ? (h >>> 8) & 255 : (h >>> 16) & 15;
};
const LUTS = [9, 0, 30, 4].map((floor) => {
  const lut = new Uint8Array(256);
  const scale = 255 / Math.max(1, 255 - floor);
  for (let i = 0; i < 256; i++) lut[i] = i <= floor ? 0 : Math.min(255, Math.round((i - floor) * scale));
  return lut;
});
const BRICKS_MANIFEST_TEXT = '{"schema":"iribhm-bricks-v2","dataset":"mipdemo","levels":[{"level":0}]}';

const f = Math.fround;
const fadd = (a, b) => f(f(a) + f(b));
const fmul = (a, b) => f(f(a) * f(b));

/** The slice shader's RAW_OUTPUT main() in float32 (as test_mig_reader_studio_planes.mjs). */
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
      let hits = 0;
      for (let n = 0; n < (projected ? steps : 1); n++) {
        const t = projected ? fadd(-halfSlab, fmul(n, delta)) : 0;
        const uvw = {};
        for (const k of ['x', 'y', 'z']) uvw[k] = fadd(fadd(base[k], fmul(t, g.step[k])), 0.5);
        if (!inBox(uvw)) continue;
        const s = rawAt(uvw);
        if (!s.present) missing = true;
        raw = raw.map((v, c) => Math.max(v, s.v[c]));
        hits++;
        if (reduced) break;
      }
      const o = (j * win.w + i) * 4;
      if (!hits) continue;
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

// ── The trees: planes/ (format 2) and mips/ (format 3) ──────────────────────────────
const DS = 'DATA_WEB/3d/mipdemo';
const planes = await buildTree({ base: `${DS}/planes`, dims: DIMS, channels: 4, tileSize: TILE, voxel: stored, bricksManifest: BRICKS_MANIFEST_TEXT });

/** mips/ as the m003 migration writes it: per layer, per tile, the max over its planes. */
async function buildMips({ base, bricksManifest = BRICKS_MANIFEST_TEXT }) {
  const files = new Map();
  const TX = Math.ceil(DIMS.x / TILE), TY = Math.ceil(DIMS.y / TILE);
  const headerBytes = PlaneCodec.headerBytes(4, TX, TY);
  for (let l = 0; l < LAYERS; l++) {
    const entries = [];
    const payloads = [];
    let offset = headerBytes;
    for (let c = 0; c < 4; c++) for (let ty = 0; ty < TY; ty++) for (let tx = 0; tx < TX; tx++) {
      const w = Math.min(TILE, DIMS.x - tx * TILE), h = Math.min(TILE, DIMS.y - ty * TILE);
      const data = new Uint8Array(w * h);
      for (let z = l * LAYER; z < Math.min(l * LAYER + LAYER, DIMS.z); z++) {
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
          const v = stored(tx * TILE + x, ty * TILE + y, z, c);
          if (v > data[y * w + x]) data[y * w + x] = v;
        }
      }
      if (!data.some(v => v)) { entries.push({ offset: 0, length: 0 }); continue; }
      const png = await PlaneCodec.encodePngGray(w, h, data);
      entries.push({ offset, length: png.length });
      payloads.push(png);
      offset += png.length;
    }
    const header = PlaneCodec.buildPackHeader({ channels: 4, tilesX: TX, tilesY: TY, z: l, entries });
    header.set([0x4C, 0x4D, 0x49, 0x50], 0);   // "LMIP"
    const pack = new Uint8Array(offset);
    pack.set(header, 0);
    let o = headerBytes;
    for (const p of payloads) { pack.set(p, o); o += p.length; }
    files.set(`${base}/l${String(l).padStart(5, '0')}.bin`, pack);
  }
  const manifest = {
    schema: 'lumen-mips-v1', formatVersion: 3, level: 0, dimensions: { x: DIMS.x, y: DIMS.y, z: DIMS.z }, channels: 4,
    tileSize: TILE, tiles: { x: TX, y: TY }, codec: 'png-gray8', packPattern: 'l{l}.bin', headerBytes,
    layers: LAYERS, layerDepth: LAYER,
    source: { manifestSha256: createHash('sha256').update(new TextEncoder().encode(bricksManifest)).digest('hex') },
    producer: 'migration-browser', createdAt: '2026-10-05T00:00:00Z'
  };
  files.set(`${base}/manifest.json`, new TextEncoder().encode(JSON.stringify(manifest)));
  return { files };
}
const mips = await buildMips({ base: `${DS}/mips` });

function filesFor({ withMips = true } = {}) {
  const files = new Map(planes.files);
  if (withMips) for (const [k, v] of mips.files) files.set(k, v);
  files.set(`${DS}/bricks/manifest.json`, planes.bricksBytes);
  return files;
}

/** The page under test: `format` 1 (bricks), 2 (planes/), 3 (planes/ + mips/). */
function makePage({ format, files = filesFor(), disabled = [], zstack = false, confirmBytes = 1 << 30, Dialog } = {}) {
  const calls = { batches: [], planes: [] };
  const fetchImpl = mockFetch(files);
  const PlaneLoader = loadPlaneLoader(fetchImpl);
  const BrickLoader = {
    isReady: () => true,
    getDimensions: (lod) => (lod === 0 ? DIMS : null),
    getFormat: () => ({ version: 2, apron: 0, brickStride: 64, brickSize: 64, channels: 4, levels: [] }),
    getTransportEncoding: () => 'webp-lossless',
    getManifest: () => ({ levels: [{}] }),
    activeBricks: () => ACTIVE,
    hasBrick: (bx, by, bz) => !EMPTY.has(`${bx}_${by}_${bz}`),
    estimateTaskBytes: (tasks) => tasks.length * 5000,
    taskBytes: () => 5000,
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
            const v = stored(t.bx * BS + x, t.by * BS + y, t.bz * BS + z, t.channel);
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
      return { data, width: win.w, height: win.h, channels: 4, projected: g.projected, coverage: false };
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
    let _currentTimepoint = 0;
    let _brickManifest = null;
    let _planeWorker = null;
    let _planeWorkerFailed = false;
    let _planeJobSeq = 0;
    const _planeJobs = new Map();
    const STUDIO_PREVIEW_MAX = 2048;
    const STUDIO_CONFIRM_BYTES = env.confirmBytes;
    const datasetMeta = { formatVersion: env.format, dimensions: { c: 4 } };
    const _planeTrees = new Map();
    let _basePath = '${DS}';
    let _zstackActive = env.zstack;
    function _setSliceStatus() {}
    function _t(key, fallback) { return fallback; }
    function _currentChannelState() { return env.channelState; }
    function _copyCanvas(c) { return c; }
    ${['_cancelNativeSlice', '_nativeSliceBricksForSpec', '_nativeStudioRenderSize', '_slicePixelSizeUm', '_sliceWindowForRect',
      '_needsCoverageMask', '_withCoverageMask', '_nativeSliceChannels', '_nativePassPlan', '_atlasNativeBackend', '_planeNativeBackend',
      '_renderNativeSliceForStudio', '_studioGeometry', '_studioCalibrated', '_planeWorkerInstance', '_planeJob', '_studioCoverageMask',
      '_reducePlaneTile', '_nativeLabel', '_scaleCropRect', '_tf', '_planesBaseOnScreen', '_planesTreeOnScreen', '_planesServePass',
      '_planesPassEstimate', '_nativePassEstimate', '_confirmLargeNativePass', '_nativeBrickFrame', '_nativeLoaderRegion',
      '_nativeInteriorRegion', '_mipsTreeOnScreen', '_mipsSlabOf', '_mipsSlabEstimate'].map(lift).join('\n')}
    return { native: _renderNativeSliceForStudio, planesEstimate: _planesPassEstimate, confirm: _confirmLargeNativePass };
  `;
  const warnings = [];
  const page = new Function(
    'env', 'document', 'console', 'performance', 'navigator', 'THREE', 'Worker',
    'BrickLoader', 'SVRManager', 'VolumeSlicer', 'VolumeViewer', 'SliceCompositor', 'StudioPlaneOps', 'DOMException',
    'PlaneLoader', 'PlaneCodec', 'Dialog', body
  )(
    { format, channelState, zstack, confirmBytes }, { createElement: () => ({ getContext: () => null }) },
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
  const renderRes = Math.ceil(Math.max(DIMS.x, DIMS.y, DIMS.z) * 1.5);
  const rect = Ops.cropRect(Ops.plainGeometry(RealSlicer.planeGeometry(spec, PHYSICAL, null)), renderRes, null);
  const w = rect.x2 - rect.x + 1, h = rect.y2 - rect.y + 1;
  const fallback = { raw: { data: new Uint8Array(w * h * 4), width: w, height: h, channels: 4 }, rect: { ...rect, renderRes }, canvas: null };
  const sr = await env.page.native({ spec, renderRes, fallback, onProgress: (p) => progress.push(p) });
  assert.ok(sr, 'a native picture');
  return { ...env, sr, progress };
}

const diffBytes = (a, b) => {
  if (a.length !== b.length) return Infinity;
  let d = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++;
  return d;
};
const packsRead = (log, kind) => [...new Set(log.filter(e => e.path.endsWith('.bin') && e.path.includes(`/${kind}/`)).map(e => e.path))];

function zstackSpec(lo, hi, { back = false, roll = 0 } = {}) {
  const n = hi - lo + 1;
  const c = (lo + n / 2) / DIMS.z;
  return { mode: 'oblique', axis: 'z', value: back ? 1 - c : c, yaw: back ? 180 : 0, pitch: 0, roll, slabThickness: n, slabStepNorm: 1 / DIMS.z, projection: n > 1 ? 'mip' : 'single' };
}

/** One slab through the three sources: same texture, same picture, the volume's. */
async function compare3(label, spec, { disabled = [], expectMips = true } = {}) {
  const bricks = await run({ format: 1, disabled }, spec);
  const viaPlanes = await run({ format: 2, disabled }, spec);
  const viaMips = await run({ format: 3, disabled }, spec);
  assert.equal(bricks.sr.path, 'plane', `${label}: format 1 reads the bricks`);
  assert.equal(viaPlanes.sr.path, 'planes', `${label}: format 2 reads planes/`);
  assert.equal(viaMips.sr.path, expectMips ? 'mips' : 'planes', `${label}: format 3 (${viaMips.warnings.join(' | ')})`);
  assert.equal(viaMips.calls.batches.length, 0, `${label}: no brick fetched`);
  assert.equal(viaMips.sr.quality, 'native');
  for (const [name, r] of [['planes', viaPlanes], ['mips', viaMips]]) {
    const t = r.calls.planes[0], b = bricks.calls.planes[0];
    assert.equal(t.layers, b.layers, `${label} ${name}: layers`);
    assert.equal(diffBytes(t.presence.presence, b.presence.presence), 0, `${label} ${name}: presence`);
    const td = diffBytes(t.texture.tex, b.texture.tex);
    assert.equal(td, 0, `${label} ${name}: plane texture, ${td} bytes differ from the bricks'`);
    const pd = diffBytes(r.sr.raw.data, bricks.sr.raw.data);
    assert.equal(pd, 0, `${label} ${name}: final picture, ${pd} bytes differ from the bricks'`);
    assert.ok(t.disposed, `${label} ${name}: texture released`);
  }
  // Against the volume itself.
  const g = Ops.plainGeometry(RealSlicer.planeGeometry(spec, PHYSICAL, null));
  const rect = viaMips.sr.cropRect;
  const win = { x: rect.x, y: rect.y, w: rect.x2 - rect.x + 1, h: rect.y2 - rect.y + 1 };
  const wanted = [0, 1, 2, 3].filter(c => !disabled.includes(c));
  const truthVol = (uvw) => {
    const v = {};
    for (const k of ['x', 'y', 'z']) v[k] = Math.floor(Math.min(Math.max(fmul(uvw[k], DIMS[k]), 0), DIMS[k] - 1));
    return { present: true, v: [0, 1, 2, 3].map(c => (wanted.includes(c) ? LUTS[c][stored(v.x, v.y, v.z, c)] : 0)) };
  };
  const truth = renderRaw({ g, R: viaMips.sr.renderRes, win, rawAt: truthVol, fallbackChannels: disabled });
  const tdiff = diffBytes(truth, viaMips.sr.raw.data);
  assert.equal(tdiff, 0, `${label}: the picture is the volume's (${tdiff} bytes differ)`);
  let lit = 0;
  for (let i = 0; i < truth.length; i += 4) if (truth[i] || truth[i + 2]) lit++;
  assert.ok(lit > win.w * win.h * 0.2, `${label}: not an empty picture`);
  // Progress ends at 100 % and bytesTotal = what was fetched.
  const last = viaMips.progress.at(-1);
  assert.equal(last.percent, 100);
  assert.equal(viaMips.sr.bytesTotal, viaMips.fetchLog.filter(e => e.path.endsWith('.bin')).reduce((s, e) => s + e.bytes, 0), `${label}: bytesTotal = the bytes fetched`);
  return { bricks, viaPlanes, viaMips };
}

// ── The whole stack: every layer whole (the ragged last one too), no plane read ────
{
  const r = await compare3('whole stack', zstackSpec(0, DIMS.z - 1));
  assert.deepEqual(packsRead(r.viaMips.fetchLog, 'mips').sort(), [0, 1, 2].map(l => `${DS}/mips/l${String(l).padStart(5, '0')}.bin`));
  assert.equal(packsRead(r.viaMips.fetchLog, 'planes').length, 0, 'no plane pack of the slab is read');
  assert.equal(packsRead(r.viaPlanes.fetchLog, 'planes').length, DIMS.z, 'format 2: one pack per slice');
  const mipBytes = r.viaMips.sr.bytesTotal, planeBytes = r.viaPlanes.sr.bytesTotal;
  assert.ok(mipBytes * 10 < planeBytes, `layer MIPs read far fewer bytes (${mipBytes} vs ${planeBytes})`);
  console.log(`whole stack: mips = planes = bricks = the volume (${mipBytes} B via mips/, ${planeBytes} B via planes/): OK`);
}

// ── Partial layers at both ends: layer MIPs + the end planes ───────────────────────
{
  const r = await compare3('slab 10..139', zstackSpec(10, 139));
  assert.deepEqual(packsRead(r.viaMips.fetchLog, 'mips'), [`${DS}/mips/l00001.bin`], 'the one whole layer');
  const planesRead = packsRead(r.viaMips.fetchLog, 'planes').map(p => Number(/z(\d+)\.bin$/.exec(p)[1])).sort((a, b) => a - b);
  const expect = [...Array.from({ length: 54 }, (_, i) => 10 + i), ...Array.from({ length: 12 }, (_, i) => 128 + i)];
  assert.deepEqual(planesRead, expect, 'the planes of the partial layers, and only them');
  await compare3('slab 20..148 rolled 37°', zstackSpec(20, 148, { roll: 37 }));
  await compare3('−Z face, slab 0..127, channel 3 off', zstackSpec(0, 127, { back: true, roll: 120 }), { disabled: [3] });
  console.log('partial layers: layer MIPs + end planes = planes = bricks: OK');
}

// ── A slab inside one layer has no whole layer: the planes alone ─────────────────────
{
  const r = await compare3('slab 70..100', zstackSpec(70, 100), { expectMips: false });
  assert.equal(r.viaMips.fetchLog.filter(e => e.path.includes('/mips/')).length, 0, 'mips/ not even opened');
  console.log('no whole layer: planes/: OK');
}

// ── Fallbacks: a missing mips pack → every plane; a stale mips tree → the planes ────
{
  const spec = zstackSpec(0, DIMS.z - 1);
  const reference = await run({ format: 1 }, spec);
  const lost = filesFor();
  lost.delete(`${DS}/mips/l00001.bin`);
  const a = await run({ format: 3, files: lost }, spec);
  assert.equal(a.sr.path, 'planes', 'a missing layer MIP: every plane');
  assert.ok(a.warnings.some(w => /mips\/ failed/.test(w)), 'logged');
  assert.equal(diffBytes(a.sr.raw.data, reference.sr.raw.data), 0, 'the same picture');
  assert.equal(a.calls.planes.length, 2, 'a fresh plane texture for the planes');
  assert.ok(a.calls.planes.every(p => p.disposed));
  const stale = filesFor({ withMips: false });
  const other = await buildMips({ base: `${DS}/mips`, bricksManifest: BRICKS_MANIFEST_TEXT.replace('mipdemo', 'other') });
  for (const [k, v] of other.files) stale.set(k, v);
  const b = await run({ format: 3, files: stale }, spec);
  assert.equal(b.sr.path, 'planes', 'a stale mips/: the planes');
  assert.ok(!b.fetchLog.some(e => e.path.includes('/mips/l')), 'no pack of a stale mips tree is read');
  assert.equal(diffBytes(b.sr.raw.data, reference.sr.raw.data), 0);
  const v2 = await run({ format: 2 }, spec);
  assert.ok(!v2.fetchLog.some(e => e.path.includes('/mips/')), 'format 2: mips/ never asked for');
  console.log('missing pack / stale mips → planes, same picture: OK');
}

// ── The large-figure estimate and dialog state the layer MIPs ───────────────────────
{
  const spec = zstackSpec(0, DIMS.z - 1);
  const { page } = makePage({ format: 3 });
  const est = await page.planesEstimate(spec);
  const mipPacks = [...mips.files].filter(([k]) => k.endsWith('.bin')).reduce((s, [, v]) => s + v.length, 0);
  assert.equal(est.layers, 3);
  assert.equal(est.planes, 0);
  assert.ok(Math.abs(est.bytes - mipPacks) / mipPacks < 0.05, `the estimate (${est.bytes}) is the mips packs' size (${mipPacks})`);
  const asked = [];
  const Dialog = { ask: async (o) => { asked.push(o); return 'keep'; } };
  const d = makePage({ format: 3, zstack: true, confirmBytes: 1, Dialog });
  assert.equal(await d.page.confirm(spec), null);
  assert.match(asked[0].message, /reads 3 stored layer projections and 0 stored planes, about \d+ MB \(\d+ image tiles\)/, asked[0].message);
  const two = await makePage({ format: 2 }).page.planesEstimate(spec);
  assert.ok(two.bytes > est.bytes * 10, 'format 2 would read every plane');
  console.log('estimate + dialog through mips/: OK');
}

console.log('Studio native z-stack MIP via mips/ = via planes/ = via bricks: OK');
