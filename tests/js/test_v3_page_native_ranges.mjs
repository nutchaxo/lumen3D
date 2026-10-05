// The Studio's native XZ / YZ cut of a v3 brick tree (DOCS/dataset-migrations/SPEC.md
// §13): 66³ bricks with a 1-voxel border, packs per (level, channel), a binary index,
// multi-range requests.
//
// viewer.js _renderNativeSliceForStudio runs as written (lifted with its helpers) over
// the REAL BrickLoader mounted on a synthetic v3 tree (test_v3_loader_fixtures.mjs:
// the §13.2 layout, a multipart-speaking mocked fetch, the REAL brick-decode-worker in
// a vm). Checked:
//   • every task asks for the interior voxels it needs in the stored 66³ frame (+1),
//     one voxel thick along the cut's normal (two on a voxel face);
//   • the packs are read with multi-range requests (one per pack, the bricks' runs as
//     parts), only the bricks the cut crosses, each once;
//   • the picture is the volume's, pixel for pixel (the shader emulated in float32
//     over a CPU stand-in of the plane texture), for XZ and YZ, on a voxel face too;
//   • the atlas path (oblique cut): an atlas whose slots hold 66³ (SVRManager reports
//     `apron`) is fed the stored boxes with their border, every border voxel being the
//     volume's (clamp-to-edge outside it); any other atlas the 64³ interiors; the
//     picture is the volume's either way;
//   • requests and bytes of an XZ and a YZ cut on the geometry of a real local dataset
//     (its v2 manifest, re-packed as §13.4 lays a v3 tree out), against the v2 tree.
//
// Run: node tests/js/test_v3_page_native_ranges.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { loadModule, ROOT } from './harness.mjs';
import { buildV3Tree, mockFetch, loadBrickLoader, parseRangeHeader } from './test_v3_loader_fixtures.mjs';

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

// ── The volume: 3 × 3 × 3 bricks, ragged at every far face, two channels ────────────
const DIMS = { x: 150, y: 140, z: 133 };
const PHYSICAL = { x: 150, y: 140, z: 266 };
const C = 2;
const BASE = 'DATA_WEB/3d/v3demo/bricks';
const ESS = new Set(['1_2_0', '2_0_2']);      // bricks with an all-zero interior (both channels)
const bOf = (v) => Math.floor(v / 64);
const value = (k, c, x, y, z) => {
  if (ESS.has(`${bOf(x)}_${bOf(y)}_${bOf(z)}`)) return 0;
  const h = ((x * 73856093) ^ (y * 19349663) ^ (z * 83492791) ^ ((c + 1) * 2654435761)) >>> 0;
  return 1 + (h % 255);
};
const tree = buildV3Tree({
  base: BASE, channels: C, perPack: 9,   // a pack = one brick layer of a channel (3 × 3)
  levels: [{ dims: DIMS, voxelSize: { x: 1, y: 1, z: 2 } }], value
});
const LUTS = [7, 0].map((floor) => {
  const lut = new Uint8Array(256);
  const scale = 255 / Math.max(1, 255 - floor);
  for (let i = 0; i < 256; i++) lut[i] = i <= floor ? 0 : Math.min(255, Math.round((i - floor) * scale));
  return lut;
});
const truthAt = (x, y, z, c) => LUTS[c][value(0, c, x, y, z)];

const f = Math.fround;
const fadd = (a, b) => f(f(a) + f(b));
const fmul = (a, b) => f(f(a) * f(b));

/** The slice shader's RAW_OUTPUT main() in float32 (one plane). */
function renderRaw({ g, R, win, rawAt }) {
  const out = new Uint8Array(win.w * win.h * 4);
  const E = g.extent;
  const inBox = (u) => u.x >= 0 && u.y >= 0 && u.z >= 0 && u.x <= 1 && u.y <= 1 && u.z <= 1;
  for (let j = 0; j < win.h; j++) {
    for (let i = 0; i < win.w; i++) {
      const uvx = f((win.x + i + 0.5) / R);
      const uvy = f((R - win.y - j - 0.5) / R);
      const pcx = fmul(fmul(uvx - 0.5, 2), E);
      const pcy = fmul(fmul(uvy - 0.5, 2), E);
      const uvw = {};
      for (const k of ['x', 'y', 'z']) uvw[k] = fadd(fadd(fadd(g.origin[k], fmul(pcx, g.right[k])), fmul(pcy, g.up[k])), 0.5);
      if (!inBox(uvw)) continue;
      const s = rawAt(uvw);
      const o = (j * win.w + i) * 4;
      if (!s.present) { out.set([1, 2, 3, 4], o); continue; }
      out.set([s.v[0], s.v[1], 0, 0], o);
    }
  }
  return out;
}
const voxelOf = (uvw) => {
  const v = {};
  for (const k of ['x', 'y', 'z']) v[k] = Math.floor(Math.min(Math.max(fmul(uvw[k], DIMS[k]), 0), DIMS[k] - 1));
  return v;
};
const truthRawAt = (uvw) => {
  const v = voxelOf(uvw);
  return { present: true, v: [truthAt(v.x, v.y, v.z, 0), truthAt(v.x, v.y, v.z, 1)] };
};

function cpuPlaneVolume(desc) {
  const axes = Ops.PLANE_AXES[desc.axis];
  const W = desc.dims[axes[0]], H = desc.dims[axes[1]], L = desc.layers;
  const bs = desc.brickSize;
  const cu = Math.ceil(W / bs), cv = Math.ceil(H / bs);
  const tex = new Uint8Array(W * H * L * 4);
  const presence = new Uint8Array(cu * cv * L);
  return {
    axis: desc.axis, width: W, height: H, layers: L, layerBase: desc.layerBase, reduced: desc.reduced,
    brickSize: bs, dims: desc.dims, tex, presence, disposed: false,
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
  const k = plane.axis;
  const [U, V] = Ops.PLANE_AXES[k];
  const cu = Math.ceil(plane.width / plane.brickSize);
  const cv = Math.ceil(plane.height / plane.brickSize);
  return (uvw) => {
    const vox = voxelOf(uvw);
    const layer = vox[k] - plane.layerBase;
    if (layer < 0 || layer >= plane.layers) return { present: false, v: [0, 0] };
    const bu = Math.floor(vox[U] / plane.brickSize), bv = Math.floor(vox[V] / plane.brickSize);
    if (!(plane.presence[(layer * cv + bv) * cu + bu] > 127)) return { present: false, v: [0, 0] };
    const o = ((layer * plane.height + vox[V]) * plane.width + vox[U]) * 4;
    return { present: true, v: [plane.tex[o], plane.tex[o + 1]] };
  };
}

/** A CPU 3D atlas: keeps each written brick's interior, checks every border voxel. */
function makeSvrStub({ supportsApron, log }) {
  return class SVRManager {
    init(channels, dims, renderer, material, opts = {}) {
      this.store = new Map();
      this.empty = new Set();
      this.errors = [];
      this.apron = supportsApron && opts.apron === 1 ? 1 : undefined;
      log.inits.push({ opts, apron: this.apron });
      this.material = material;
      material.atlas = this;
    }
    pointEmptyBricks(isEmpty) {
      for (let bz = 0; bz < 3; bz++) for (let by = 0; by < 3; by++) for (let bx = 0; bx < 3; bx++) {
        if (isEmpty(bx, by, bz)) this.empty.add(`${bx}_${by}_${bz}`);
      }
    }
    writeRgbaBrickRegion(bx, by, bz, data, x0, y0, z0, w, h, d) {
      const a = this.apron || 0;
      log.writes.push({ bx, by, bz, box: { x0, y0, z0, w, h, d }, apron: a });
      let o = 0;
      let brick = this.store.get(`${bx}_${by}_${bz}`);
      if (!brick) this.store.set(`${bx}_${by}_${bz}`, brick = new Map());
      for (let z = z0; z < z0 + d; z++) for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++, o += 4) {
        // Stored voxel s of a brick is volume voxel 64·b − apron + s (clamped to the volume).
        const vx = 64 * bx - a + x, vy = 64 * by - a + y, vz = 64 * bz - a + z;
        const cx = Math.max(0, Math.min(DIMS.x - 1, vx)), cy = Math.max(0, Math.min(DIMS.y - 1, vy)), cz = Math.max(0, Math.min(DIMS.z - 1, vz));
        for (let c = 0; c < C; c++) {
          if (data[o + c] !== truthAt(cx, cy, cz, c)) log.bad.push({ bx, by, bz, x, y, z, c, got: data[o + c], want: truthAt(cx, cy, cz, c) });
        }
        const interior = vx >= 64 * bx && vx < 64 * bx + 64 && vy >= 64 * by && vy < 64 * by + 64 && vz >= 64 * bz && vz < 64 * bz + 64;
        if (interior) brick.set(`${vx}_${vy}_${vz}`, [data[o], data[o + 1]]);
        else log.border++;
      }
      return true;
    }
    flushUploadErrors() { return []; }
    dispose() {}
    rawAt(uvw) {
      const v = voxelOf(uvw);
      const key = `${bOf(v.x)}_${bOf(v.y)}_${bOf(v.z)}`;
      if (this.empty.has(key)) return { present: true, v: [0, 0] };
      const got = this.store.get(key)?.get(`${v.x}_${v.y}_${v.z}`);
      return got ? { present: true, v: got } : { present: false, v: [0, 0] };
    }
  };
}

async function makePage({ supportsApron = false } = {}) {
  const fetchImpl = mockFetch(tree.files);
  const BrickLoader = loadBrickLoader(fetchImpl);
  await BrickLoader.init(BASE, tree.manifest);
  const log = { inits: [], writes: [], bad: [], border: 0, batches: [], planes: [] };
  const Loader = new Proxy(BrickLoader, {
    get(t, k) {
      if (k === 'loadBrickTasks') return (tasks, opts) => { log.batches.push(tasks); return t.loadBrickTasks(tasks, opts); };
      return t[k];
    }
  });
  const VolumeSlicer = {
    planeGeometry: RealSlicer.planeGeometry,
    samplingSpace: () => null,
    getPlaneExtentUnits: () => 1.5,
    getPlaneSpec: () => ({ mode: 'xy', value: 0.5 }),
    createPlaneVolume: (desc) => { const p = cpuPlaneVolume(desc); log.planes.push(p); return p; },
    renderWithMaterial: () => null,
    renderRawWithMaterial(mat, spec, size, opts = {}) {
      const g = Ops.plainGeometry(RealSlicer.planeGeometry(spec, PHYSICAL, null));
      const win = opts.window || { x: 0, y: 0, w: size, h: size };
      const rawAt = opts.plane ? planeRawAt(opts.plane) : (uvw) => mat.atlas.rawAt(uvw);
      return { data: renderRaw({ g, R: size, win, rawAt }), width: win.w, height: win.h, channels: 4, projected: false, coverage: false };
    },
    releaseForeign: () => {}
  };
  const material = { defines: {}, uniforms: { numChannels: { value: C } }, clone() { return { defines: {}, uniforms: {}, dispose() {} }; } };
  const VolumeViewer = {
    getRenderer: () => ({}),
    getMaterial: () => material,
    getPhysicalSize: () => PHYSICAL,
    getPhysicalCalibration: () => ({ calibrationStatus: 'exact' }),
    floorLutsFromManifest: (m, channels) => LUTS.slice(0, channels)
  };
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
    const STUDIO_CONFIRM_BYTES = 1 << 30;
    const datasetMeta = { formatVersion: 4, dimensions: { c: ${C} } };
    const _planeTrees = new Map();
    let _basePath = 'DATA_WEB/3d/v3demo';
    let _zstackActive = false;
    function _setSliceStatus() {}
    function _t(key, fallback) { return fallback; }
    function _currentChannelState() { return [{ enabled: true }, { enabled: true }]; }
    function _copyCanvas(c) { return c; }
    ${['_cancelNativeSlice', '_nativeSliceBricksForSpec', '_nativeStudioRenderSize', '_slicePixelSizeUm', '_sliceWindowForRect',
      '_needsCoverageMask', '_withCoverageMask', '_nativeSliceChannels', '_nativePassPlan', '_atlasNativeBackend', '_planeNativeBackend',
      '_renderNativeSliceForStudio', '_studioGeometry', '_studioCalibrated', '_planeWorkerInstance', '_planeJob', '_studioCoverageMask',
      '_reducePlaneTile', '_nativeLabel', '_scaleCropRect', '_tf', '_planesBaseOnScreen', '_planesTreeOnScreen', '_planesServePass',
      '_nativeBrickFrame', '_nativeLoaderRegion', '_nativeInteriorRegion', '_mipsTreeOnScreen', '_mipsSlabOf', '_mipsSlabEstimate'].map(lift).join('\n')}
    return { native: _renderNativeSliceForStudio };
  `;
  const warnings = [];
  const page = new Function(
    'document', 'console', 'performance', 'navigator', 'THREE', 'Worker',
    'BrickLoader', 'SVRManager', 'VolumeSlicer', 'VolumeViewer', 'SliceCompositor', 'StudioPlaneOps', 'DOMException',
    'PlaneLoader', 'PlaneCodec', body
  )(
    { createElement: () => ({ getContext: () => null }) },
    { warn: (...a) => warnings.push(a.map(String).join(' ')), log() {} },
    { now: () => Date.now() }, { hardwareConcurrency: 8 }, { UniformsUtils: null }, undefined,
    Loader, makeSvrStub({ supportsApron, log }), VolumeSlicer, VolumeViewer, { isRaw: (r) => Boolean(r && r.data && r.width > 0) }, Ops,
    globalThis.DOMException, undefined, undefined
  );
  return { page, log, fetchLog: fetchImpl.log, warnings, BrickLoader };
}

async function cut(spec, opts) {
  const env = await makePage(opts);
  const renderRes = Math.ceil(Math.max(DIMS.x, DIMS.y, DIMS.z) * 1.5);
  const rect = Ops.cropRect(Ops.plainGeometry(RealSlicer.planeGeometry(spec, PHYSICAL, null)), renderRes, null);
  const w = rect.x2 - rect.x + 1, h = rect.y2 - rect.y + 1;
  const fallback = { raw: { data: new Uint8Array(w * h * 4), width: w, height: h, channels: 4 }, rect: { ...rect, renderRes }, canvas: null };
  const sr = await env.page.native({ spec, renderRes, fallback });
  assert.ok(sr, 'a native picture');
  const g = Ops.plainGeometry(RealSlicer.planeGeometry(spec, PHYSICAL, null));
  const win = { x: rect.x, y: rect.y, w, h };
  const truth = renderRaw({ g, R: renderRes, win, rawAt: truthRawAt });
  let diff = 0;
  for (let i = 0; i < truth.length; i++) if (truth[i] !== sr.raw.data[i]) diff++;
  return { ...env, sr, diff, truth };
}

const packRequests = (log) => log.filter(e => /\/l\d+\/c\d+\/p\d+\.bin$/.test(e.path));

// ── XZ and YZ cuts: interior boxes, one voxel thick, multi-range, the volume's picture ─
for (const [label, spec, axis] of [
  ['XZ at y = 77.4', { mode: 'xz', value: 77.4 / DIMS.y, slabThickness: 1, projection: 'single' }, 'y'],
  ['YZ at x = 101.2', { mode: 'yz', value: 101.2 / DIMS.x, slabThickness: 1, projection: 'single' }, 'x'],
  ['XZ on the voxel face y = 64 (two layers across the brick seam)', { mode: 'xz', value: 64 / DIMS.y, slabThickness: 1, projection: 'single' }, 'y']
]) {
  const r = await cut(spec);
  assert.equal(r.sr.path, 'plane', `${label}: plane path (${r.warnings.join(' | ')})`);
  assert.equal(r.diff, 0, `${label}: the picture is the volume's (${r.diff} bytes differ)`);
  assert.equal(r.sr.missingChunks, 0);
  assert.equal(r.sr.quality, 'native');
  const tasks = r.log.batches.flat();
  assert.ok(tasks.length > 0);
  for (const t of tasks) {
    const box = t.region;
    assert.ok(box, `${label}: every task asks for a box`);
    const thick = box[`${axis}1`] - box[`${axis}0`];
    assert.ok(thick >= 1 && thick <= 2, `${label}: ${thick} voxels along the normal`);
    for (const k of ['x', 'y', 'z']) {
      assert.ok(box[`${k}0`] >= 1 && box[`${k}1`] <= 65, `${label}: an interior box of the 66³ frame (${k}: ${box[`${k}0`]}..${box[`${k}1`]})`);
    }
  }
  // Only the bricks the cut crosses, each (brick, channel) once, every stored one.
  const want = new Set();
  const t = spec.value * DIMS[axis];
  const layers = new Set([bOf(Math.floor(t - 4e-3)), bOf(Math.floor(t + 4e-3))]);
  for (let bz = 0; bz < 3; bz++) for (let bo = 0; bo < 3; bo++) for (const b of layers) {
    for (let c = 0; c < C; c++) {
      const key = axis === 'y' ? [bo, b, bz] : [b, bo, bz];
      if (tree.stored(0, c, ...key)) want.add(`${key.join('_')}/${c}`);
    }
  }
  const asked = new Set(tasks.map(t => `${t.bx}_${t.by}_${t.bz}/${t.channel}`));
  assert.equal(asked.size, tasks.length, `${label}: no task twice`);
  assert.deepEqual([...asked].sort(), [...want].sort(), `${label}: exactly the stored bricks the cut crosses`);
  // One request per pack the cut touches, its bricks' runs as the parts of a multi-range.
  const reqs = packRequests(r.fetchLog);
  const packs = new Set(reqs.map(q => q.path));
  // The host's first range request goes alone (it learns whether Range is honoured):
  // one run of one pack may travel apart from the others of its pack.
  assert.ok(reqs.length <= packs.size + 1, `${label}: one request per pack, plus the range probe (${reqs.length} for ${packs.size})`);
  // On the seam the cut needs two brick rows of a pack's three (≥ 60 % of it): the
  // loader fetches such a pack whole.
  if (!/seam/.test(label)) assert.ok(reqs.every(q => q.range), `${label}: every pack read with Range`);
  // A pack holds a brick layer (bz, by, bx order): an XZ cut reads one row of it (one
  // run), a YZ cut one brick of each row (separate runs, asked together).
  if (axis === 'x') assert.ok(reqs.filter(q => parseRangeHeader(q.range).length >= 3).length >= 4, `${label}: runs of one pack travel as one multi-range request`);
  const bytes = reqs.reduce((s, q) => s + (q.range ? parseRangeHeader(q.range).reduce((a, [x, y]) => a + y - x + 1, 0) : tree.files.get(q.path).length), 0);
  const need = [...want].reduce((s, key) => {
    const [b, c] = key.split('/');
    return s + r.BrickLoader.taskBytes({ lod: 0, channel: Number(c), bx: +b.split('_')[0], by: +b.split('_')[1], bz: +b.split('_')[2] });
  }, 0);
  assert.ok(bytes >= need && bytes <= need * (/seam/.test(label) ? 1.6 : 1.05), `${label}: ${bytes} bytes asked for ${need} bytes of bricks`);
  console.log(`${label}: ${tasks.length} tasks, ${reqs.length} requests, ${bytes} B: OK`);
}

// ── Oblique cut: the atlas path, with and without 66³ slots ─────────────────────────
{
  const spec = { mode: 'oblique', yaw: 31, pitch: 22, roll: 0, value: 0.47, slabThickness: 1, projection: 'single' };
  const plain = await cut(spec, { supportsApron: false });
  assert.equal(plain.sr.path, 'atlas');
  assert.equal(plain.diff, 0, `oblique, 64³ atlas: the volume's picture (${plain.diff} bytes differ)`);
  assert.equal(plain.log.inits[0].opts.apron, 1, 'the atlas is told the tree has a border');
  assert.equal(plain.log.border, 0, 'a 64³ atlas receives interiors only');
  assert.ok(plain.log.writes.every(w => w.box.x0 >= 0 && w.box.x0 + w.box.w <= 64), 'interior boxes');
  assert.equal(plain.log.bad.length, 0, 'every written voxel is the volume\'s');
  const apron = await cut(spec, { supportsApron: true });
  assert.equal(apron.sr.path, 'atlas');
  assert.equal(apron.diff, 0, `oblique, 66³ atlas: the volume's picture (${apron.diff} bytes differ)`);
  assert.ok(apron.log.border > 0, 'a 66³ atlas receives the border voxels');
  assert.equal(apron.log.bad.length, 0, `every border voxel is the volume's, clamp-to-edge outside (${JSON.stringify(apron.log.bad.slice(0, 3))})`);
  assert.ok(apron.log.writes.some(w => w.box.x0 === 0 || w.box.y0 === 0 || w.box.z0 === 0), 'boxes start on the stored border');
  console.log('oblique cut through a v3 tree, 64³ and 66³ atlases: the volume\'s picture, borders exact: OK');
}

// ── Requests on a real dataset's geometry: v2 tree vs the same bricks as a v3 tree ───
{
  const Loader = loadBrickLoader(mockFetch(new Map()));
  const candidates = [];
  const root = path.join(ROOT, 'DATA_WEB', '3d');
  if (existsSync(root)) {
    for (const name of readdirSync(root)) {
      const m = path.join(root, name, 'bricks', 'manifest.json');
      if (existsSync(m)) candidates.push({ name, file: m, size: statSync(m).size });
    }
  }
  const pick = candidates.sort((a, b) => b.size - a.size)[0];
  let geometry;
  if (pick) {
    const m = JSON.parse(readFileSync(pick.file, 'utf8'));
    if (m.schema === 'iribhm-bricks-v2' && m.brickTransport?.brickToPack) {
      const d = m.levels[0].dimensions;
      const sizes = new Map();      // `${c}/${bx}_${by}_${bz}` → v2 bytes
      for (const [key, e] of Object.entries(m.brickTransport.brickToPack)) {
        const k = /^lod0\/c(\d+)\/x(\d+)_y(\d+)_z(\d+)\.webp$/.exec(key);
        if (k) sizes.set(`${k[1]}/${+k[2]}_${+k[3]}_${+k[4]}`, { ...e });
      }
      geometry = { label: `${pick.name} (${d.x}×${d.y}×${d.z}, ${m.channels} channels)`, dims: d, channels: m.channels, v2: sizes, voxel: m.voxelSize };
    }
  }
  if (!geometry) {
    // No local dataset: the reference geometry, dense.
    const d = { x: 5735, y: 5735, z: 172 };
    const v2 = new Map();
    const g = { x: Math.ceil(d.x / 64), y: Math.ceil(d.y / 64), z: Math.ceil(d.z / 64) };
    let off = new Map();
    for (let c = 0; c < 4; c++) for (let bz = 0; bz < g.z; bz++) for (let by = 0; by < g.y; by++) for (let bx = 0; bx < g.x; bx++) {
      const i = ((bz * g.y + by) * g.x + bx);
      const url = `lod0/c${c}/pack_${String(Math.floor(i / 128)).padStart(2, '0')}.bin`;
      const length = 4000 + ((i * 7919) % 30000);
      const o = off.get(url) || 0;
      v2.set(`${c}/${bx}_${by}_${bz}`, { url, offset: o, length });
      off.set(url, o + length);
    }
    geometry = { label: `synthetic ${d.x}×${d.y}×${d.z}, 4 channels`, dims: d, channels: 4, v2, voxel: { x: 1, y: 1, z: 3 } };
  }
  const { dims, channels } = geometry;
  const grid = { x: Math.ceil(dims.x / 64), y: Math.ceil(dims.y / 64), z: Math.ceil(dims.z / 64) };
  // v2 mount: its own pack index.
  const v2Sizes = new Map();
  for (const e of geometry.v2.values()) v2Sizes.set(e.url, Math.max(v2Sizes.get(e.url) || 0, e.offset + e.length));
  const v2Mount = {
    hasPackIndex: true, packSizes: v2Sizes,
    lookup: (lod, c, bx, by, bz) => geometry.v2.get(`${c}/${bx}_${by}_${bz}`) || null
  };
  // v3 mount: the same bricks, 66³ (≈ (66/64)³ of their v2 bytes), packed as §13.4:
  // per channel in (bz, by, bx) order, at most 64 bricks or 16 MiB a pack.
  const V3_GROWTH = (66 / 64) ** 3;
  const v3 = new Map();
  const v3Sizes = new Map();
  for (let c = 0; c < channels; c++) {
    let pack = 0, count = 0, offset = 0;
    for (let bz = 0; bz < grid.z; bz++) for (let by = 0; by < grid.y; by++) for (let bx = 0; bx < grid.x; bx++) {
      const e = geometry.v2.get(`${c}/${bx}_${by}_${bz}`);
      if (!e) continue;
      const length = Math.ceil(e.length * V3_GROWTH);
      if (count >= 64 || offset + length > 16 * 1024 * 1024) { pack++; count = 0; offset = 0; }
      const url = `l0/c${c}/p${String(pack).padStart(5, '0')}.bin`;
      v3.set(`${c}/${bx}_${by}_${bz}`, { url, offset, length });
      offset += length;
      count++;
      v3Sizes.set(url, offset);
    }
  }
  const v3Mount = { hasPackIndex: true, packSizes: v3Sizes, lookup: (lod, c, bx, by, bz) => v3.get(`${c}/${bx}_${by}_${bz}`) || null };

  /** Requests and bytes of `tasks` on a mount: whole packs, runs (one request each), or multi-range (≤ 64 parts / 8000-byte header per request). */
  const cost = (mount, tasks, multi) => {
    const plan = Loader._planRanges(tasks, mount, multi) || new Map();
    const packs = new Set();
    for (const t of tasks) { const p = mount.lookup(0, t.channel, t.bx, t.by, t.bz); if (p) packs.add(p.url); }
    let requests = 0, bytes = 0;
    for (const url of packs) {
      const runs = plan.get(url);
      if (!runs) { requests++; bytes += mount.packSizes.get(url); continue; }
      bytes += runs.reduce((s, r) => s + r.end - r.start, 0);
      if (!multi) { requests += runs.length; continue; }
      let parts = 0, header = 6;
      requests++;
      for (const r of runs) {
        const part = String(r.start).length + String(r.end - 1).length + 3;
        if (parts && (parts >= 64 || header + part > 8000)) { requests++; parts = 0; header = 6; }
        parts++; header += part;
      }
    }
    return { requests, bytes, packs: packs.size };
  };
  const tasksFor = (axis, v) => {
    const out = [];
    const b = Math.floor(v / 64);
    for (let c = 0; c < channels; c++) for (let bz = 0; bz < grid.z; bz++) for (let bo = 0; bo < (axis === 'y' ? grid.x : grid.y); bo++) {
      const [bx, by] = axis === 'y' ? [bo, b] : [b, bo];
      if (geometry.v2.has(`${c}/${bx}_${by}_${bz}`)) out.push({ lod: 0, channel: c, bx, by, bz });
    }
    return out;
  };
  const MB = (n) => `${(n / 1e6).toFixed(1)} MB`;
  const need = (tasks, mount) => tasks.reduce((s, t) => s + (mount.lookup(0, t.channel, t.bx, t.by, t.bz)?.length || 0), 0);
  const lines = [];
  for (const [label, axis] of [['XZ', 'y'], ['YZ', 'x']]) {
    const tasks = tasksFor(axis, Math.floor(dims[axis] / 2));
    const a = cost(v2Mount, tasks, false);
    const b = cost(v3Mount, tasks, true);
    lines.push(`  ${label} cut (${tasks.length} brick tasks, ${MB(need(tasks, v2Mount))} of v2 bricks): v2 ${a.requests} requests / ${MB(a.bytes)} over ${a.packs} packs → v3 ${b.requests} requests / ${MB(b.bytes)} over ${b.packs} packs`);
    // A v3 pack holds a row of at most 64 bricks: a cut touches more (smaller) packs,
    // but asks each of them once, for the bricks it needs (66³ ≈ 1.1 × a 64³ brick).
    assert.ok(b.requests <= b.packs, `${label}: one multi-range request per v3 pack (${b.requests} for ${b.packs})`);
    // A pack whose needed runs cover ≥ 60 % of it is fetched whole (the loader's rule,
    // the same for both trees).
    assert.ok(b.bytes <= need(tasks, v3Mount) / 0.6, `${label}: the v3 tree reads about the bricks it needs (${b.bytes})`);
    assert.ok(b.bytes <= a.bytes * 1.25, `${label}: no more than the v2 tree, the border included (${b.bytes} vs ${a.bytes})`);
  }
  console.log(`native XZ / YZ cut, ${geometry.label}:\n${lines.join('\n')}`);
}

console.log('Studio native XZ / YZ on a v3 tree: interior boxes, multi-range, exact picture: OK');
