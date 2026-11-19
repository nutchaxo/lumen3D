// The Studio's data source (viewer.js: ctx.studio.source.describe / open, lifted from the
// source) against a scripted loader, slicer and Studio:
//   describe():
//     - the figure's planes at EVERY level, computed from each level's own dimensions:
//       a single plane is exactly one index floor(t·dim), a slab (MIP or average, the
//       Z-stack browser's included) is a contiguous ascending run, never derived from a
//       format number;
//     - an oblique plane needs an axis plane, a stabilised (warped) timelapse, a Compare
//       figure, an embedded panel and a closed Studio are not supported, nothing on
//       screen is "no dataset" — each with its translated reason key;
//     - XZ and YZ planes: image axes, the figure's roll and face, voxel size per level,
//       the tree key (stable per tree, different per timepoint), channels and frame.
//   open():
//     - the frame is held like the native pass holds it (timeline paused, another frame's
//       load dropped or the frame put back, prefetch off, hold counter), the tree pinned
//       ONCE, every block read from that pin through DataAccess.readRegion({ handle });
//     - readBlock returns [plane][row][column] for the three axes, planes/ and the cut
//       store when present (a backend that fails is dropped, the bricks answer), the
//       block bounds are validated;
//     - a frame that left the screen (before, between or DURING a read) throws
//       STUDIO_FRAME_LOST; release() is idempotent and gives the holds back.
//
// Run: node tests/js/test_studio_source_describe.mjs
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
const f = (x, y, z, c) => (x * 3 + y * 5 + z * 7 + c * 11 + 1) % 251;

function makeEnv({
  dims = { x: 70, y: 52, z: 41, brickSize: BS, channels: 3 }, levels = 2, live = false, spec = { mode: 'xy', value: 0.37, slabThickness: 1, projection: 'single' },
  studioOpen = true, iframe = false, warped = false, shown = true, planes = false, planesFail = false, cut = false, cutFail = false, formatVersion = 1,
  loadFails = false, layoutMaps = [], zstack = null, channelState = null,
} = {}) {
  const calls = { reads: [], pins: 0, planeLoads: [], cutRows: [], progress: [], prefetch: { stops: 0, kicks: 0 }, warns: [], inits: [] };
  const dimsOf = (lod) => (lod === 0 ? dims : { x: Math.ceil(dims.x / 2), y: Math.ceil(dims.y / 2), z: Math.ceil(dims.z / 2), brickSize: BS, channels: dims.channels });
  const trees = new Map();
  const treeOf = (t) => {
    if (!trees.has(t)) {
      const p = live ? `DATA_WEB/live/demo/bricks/t${String(t).padStart(3, '0')}` : 'DATA_WEB/3d/demo/bricks';
      const manifest = { schema: cut ? 'iribhm-bricks-v5' : 'iribhm-bricks-v2', frame: t, channels: dims.channels, levels: Array.from({ length: levels }, (_, k) => ({ dimensions: dimsOf(k) })) };
      if (cut) manifest.index = { columns: { ll: { sha256: `${'ab'.repeat(30)}${String(t).padStart(4, '0')}` } } };
      trees.set(t, { path: p, manifest });
    }
    return trees.get(t);
  };
  const start = live ? 12 : 0;
  const view = { mounted: treeOf(start), shown: shown ? start : null, displayCancels: 0 };
  const handle = { handle: 'pinned' };
  const BrickLoader = {
    isReady: () => true,
    getDimensions: (lod) => (lod < levels ? dimsOf(lod) : null),
    getManifest: () => view.mounted.manifest,
    getBasePath: () => view.mounted.path,
    async init(p, manifest) { calls.inits.push(manifest.frame); await Promise.resolve(); view.mounted = { path: p, manifest }; },
    hasBrick: (bx, by, bz) => !(bx === 1 && by === 1 && bz === 1),
    taskBytes: () => 1000,
    withMount: (h, fn) => { assert.equal(h, handle); return fn(); },
    activeBricks: () => [],
  };
  const DataAccess = {
    voxelSize: (k) => ({ x: PHYSICAL.x / dimsOf(k).x, y: PHYSICAL.y / dimsOf(k).y, z: PHYSICAL.z / dimsOf(k).z }),
    async pinDisplayed() { calls.pins++; return handle; },
    async readRegion(box, chans, opts = {}) {
      calls.reads.push({ box: { ...box }, chans: [...chans], opts });
      await Promise.resolve();
      if (opts.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      env.duringRead?.();
      const w = box.x1 - box.x0, h = box.y1 - box.y0, d = box.z1 - box.z0;
      const data = chans.map((c) => {
        const out = new Uint8Array(w * h * d);
        for (let z = 0; z < d; z++) for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[(z * h + y) * w + x] = f(box.x0 + x, box.y0 + y, box.z0 + z, c);
        return out;
      });
      return { dims: { x: w, y: h, z: d }, data };
    },
  };
  const VolumeSlicer = {
    planeGeometry: RealSlicer.planeGeometry,
    samplingSpace: () => (warped ? { warped: true } : null),
    getPlaneSpec: () => ({ mode: 'xy', value: 0.5 }),
  };
  // A warped sampling space is out of the unit's scope: the geometry reports it as warped.
  const planeGeometry = (s, p, space) => {
    const g = RealSlicer.planeGeometry(s, p, null);
    return space ? { ...g, warped: true } : g;
  };
  VolumeSlicer.planeGeometry = planeGeometry;
  const VolumeViewer = {
    getMaterial: () => ({}),
    getPhysicalSize: () => PHYSICAL,
    getDisplayedTree: () => (view.shown === null ? null : treeOf(view.shown)),
    getDisplayedTimepoint: () => (live && view.shown !== null ? view.shown : null),
    getSamplingVolume: () => (view.shown === null ? null : { textures: [{}] }),
    getActiveLevel: () => (view.shown === null ? null : { level: 1, dims: dimsOf(1) }),
    cancelDisplayLoad: () => { view.displayCancels++; },
  };
  const studio = { open: studioOpen, token: 5 };
  const StudioEditor = {
    isOpen: () => studio.open,
    documentToken: () => studio.token,
    getDocument: () => (studio.open ? { planeSpec: spec, timepoint: live ? 12 : null, dataset: { id: '3d/demo', name: 'Demo' }, layoutMaps } : null),
    setLoadProgress: (state, options) => calls.progress.push({ state, options }),
  };
  const timeline = { paused: 0, frames: [] };
  const Timeline = live ? { pause: () => { timeline.paused++; }, setFrame: (fr, a, b) => { timeline.frames.push([fr, a, b]); } } : undefined;
  const planeTree = () => ({
    dimensions: { x: dims.x, y: dims.y, z: dims.z },
    tileSize: 32,
    async loadRegion(z, chans, rect, opts) {
      calls.planeLoads.push({ z, chans: [...chans], rect: { ...rect }, opts });
      if (planesFail) throw new Error('plane tile unreadable');
      const w = rect.x1 - rect.x0, h = rect.y1 - rect.y0;
      return { width: w, height: h, channels: chans, data: chans.map((c) => { const o = new Uint8Array(w * h); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) o[y * w + x] = f(rect.x0 + x, rect.y0 + y, z, c); return o; }) };
    },
    async estimate() { return { bytes: 4321, tiles: 3, exact: false }; },
  });
  const PlaneLoader = { open: async () => planeTree() };
  const CutStore = {
    open: () => ({
      async orthRow(kind, level, c, row) {
        calls.cutRows.push({ kind, level, c, row });
        if (cutFail) throw new Error('cut row unreadable');
        const d = dimsOf(level);
        const width = kind === 'xz' ? d.x : d.y, height = d.z;
        const o = new Uint8Array(width * height);
        for (let z = 0; z < height; z++) for (let i = 0; i < width; i++) o[z * width + i] = kind === 'xz' ? f(i, row, z, c) : f(row, i, z, c);
        return { width, height, data: o };
      },
    }),
  };
  const env = {
    live, iframe, zstack, formatVersion, duringRead: null, view, loads: [], gates: [], loadFails,
    channelState: channelState || [{ name: 'DAPI', color: '#0000ff', min: 3, max: 200 }, { name: 'GFP', color: '#00ff00', min: 0, max: 255 }],
    prefetch: calls.prefetch,
    show: (t, { streamed = false } = {}) => { view.shown = t; if (streamed) view.mounted = treeOf(t); },
    mountTree: (t) => { view.mounted = treeOf(t); },
  };
  const body = `
    let _currentTimepoint = env.live ? 12 : 0;
    let _timepointGeneration = 0;
    let _tpPending = null;
    let _tpInFlight = false;
    let _tpTarget = null;
    let _activeLoadToken = 0;
    let _nativePassHolds = 0;
    const isLive = env.live;
    const _isIframe = env.iframe;
    const _zstackActive = Boolean(env.zstack);
    function _zstackStudioSpec() { return env.zstack; }
    function _stopPrefetch() { env.prefetch.stops++; }
    function _kickPrefetch() { env.prefetch.kicks++; }
    function _mount(t) {
      env.show(t);
      if (_currentTimepoint !== t) _timepointGeneration++;
      _currentTimepoint = t;
    }
    async function _loadTimepoint(basePath, t) {
      env.loads.push(t);
      const token = ++_activeLoadToken;
      env.view.displayCancels++;
      if (token !== _activeLoadToken) return undefined;
      if (env.loadFails) return undefined;
      _mount(t);
      return { ok: true, token };
    }
    let _brickManifest = null;
    const _planeTrees = new Map();
    const _cutTrees = new Map();
    let _basePath = 'DATA_WEB/3d/demo';
    let _qualityMode = '1024x1024';
    function _qualityLabel(q) { return q; }
    function _setQualityStatus() {}
    function _t(key, fallback) { return fallback; }
    function _currentChannelState() { return env.channelState; }
    const datasetMeta = { id: '3d/demo', name: 'Demo', formatVersion: env.formatVersion, dimensions: { c: 3 } };
    const _studioTreeSignatures = new WeakMap();
    ${['_studioError', '_fnv1a', '_studioTreeKey', '_studioFigureIndices', '_studioLevelVoxelUm', '_studioGeometry', '_studioSourceDescribe',
      '_linkSignals', '_studioBrickBytes', '_studioRegionToBlock', '_studioSourceOpen', '_makeStudioReader', '_studioFacade',
      '_planesBaseOnScreen', '_planesTreeOnScreen', '_cutTreeOnScreen', '_brickTreeBaseOnScreen',
      '_frameLabel', '_tf', '_displayedTimepoint', '_shownTimepoint', '_hasMountedVolume', '_whenTimepointIdle',
      '_dropOtherFrameLoad', '_holdStudioFrame', '_returnToStudioFrame', '_mountTreeOnScreen'].map(lift).join('\n')}
    return {
      describe: _studioSourceDescribe,
      open: _studioSourceOpen,
      facade: _studioFacade,
      indices: _studioFigureIndices,
      toBlock: _studioRegionToBlock,
      mount: _mount,
      holds: () => _nativePassHolds,
      timepoint: () => _currentTimepoint,
    };
  `;
  const page = new Function(
    'env', 'document', 'console', 'setTimeout', 'clearTimeout', 'performance', 'THREE',
    'BrickLoader', 'VolumeSlicer', 'VolumeViewer', 'StudioEditor', 'StudioPlaneOps', 'DOMException', 'DataAccess',
    'PlaneLoader', 'PlaneCodec', 'CutStore', 'Timeline', body,
  )(
    env, { getElementById: () => null }, { warn: (...a) => calls.warns.push(a.join(' ')), log() {}, error() {} },
    setTimeout, clearTimeout, { now: () => Date.now() }, THREE,
    BrickLoader, VolumeSlicer, VolumeViewer, StudioEditor, Ops, globalThis.DOMException, DataAccess,
    planes ? PlaneLoader : undefined, planes ? {} : undefined, cut ? CutStore : undefined, Timeline,
  );
  return { page, calls, env, view, studio, timeline, treeOf, dimsOf, handle, dims };
}

const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const idx = (info, level = 0) => info.levels.find(l => l.level === level).indices;

// ── 1. describe: a single plane is exactly one index per level ──────────────────
{
  const { page } = makeEnv({ spec: { mode: 'xy', value: 0.37, slabThickness: 1, projection: 'single' } });
  const info = page.describe();
  assert.equal(info.available, true);
  assert.equal(info.axis, 'z');
  assert.equal(info.uAxis, 'x');
  assert.equal(info.vAxis, 'y');
  assert.deepEqual(info.levels.map(l => l.level), [0, 1]);
  assert.deepEqual(idx(info, 0), [Math.floor(0.37 * 41)], 'level 0: floor(t·dim)');
  assert.deepEqual(idx(info, 1), [Math.floor(0.37 * 21)], 'level 1 from ITS OWN z dimension, not level 0\'s index');
  assert.equal(info.levels[0].width, 70);
  assert.equal(info.levels[0].height, 52);
  assert.equal(info.levels[1].width, 35);
  assert.equal(info.levels[1].height, 26);
  assert.deepEqual({ ...info.levels[1].dims }, { x: 35, y: 26, z: 21 });
  assert.equal(info.levels[0].voxelUm.x, PHYSICAL.x / 70);
  assert.equal(info.levels[1].voxelUm.z, PHYSICAL.z / 21, 'voxel size per level');
  assert.equal(info.figureProjection, 'single');
  assert.equal(info.displayedLevel, 1);
  assert.equal(info.timepoint, null, 'a static volume has no frame');
  assert.equal(info.datasetId, '3d/demo');
  assert.equal(info.formatVersion, 1);
  assert.equal(info.orientation.back, false);
  assert.equal(info.orientation.rollDeg, 0);
  assert.deepEqual(info.channels.map(c => c.name), ['DAPI', 'GFP', 'Channel 3']);
  assert.deepEqual({ ...info.channels[0].window }, { min: 3, max: 200 });
  assert.equal(info.channels[0].color, '#0000ff');
  assert.match(info.treeKey, /^[0-9a-f]{8}-/);
  // A single plane on a slab spec whose projection is 'single' stays one plane whatever its thickness.
  const thick = makeEnv({ spec: { mode: 'xy', value: 0.37, slabThickness: 9, projection: 'single' } }).page.describe();
  assert.deepEqual(idx(thick, 0), [Math.floor(0.37 * 41)]);
  console.log('describe: single plane = one index per level, own dimensions: OK');
}

// ── 2. describe: MIP and average slabs, the Z-stack browser's spec ──────────────
{
  const z = 41;
  const slab = (projection) => ({ mode: 'oblique', axis: 'z', value: (5 + 21 / 2) / z, yaw: 0, pitch: 0, roll: 0, slabThickness: 21, slabStepNorm: 1 / z, projection });
  const mip = makeEnv({ spec: slab('mip') }).page.describe();
  assert.deepEqual(idx(mip, 0), range(5, 25), 'a Z-stack slab: its 21 slices, contiguous');
  // Level 1 halves z (21 planes): the samples (5.5..25.5)/41 · 21 land on 2..13.
  assert.deepEqual(idx(mip, 1), range(Math.floor(5.5 / 41 * 21), Math.floor(25.5 / 41 * 21)));
  assert.equal(mip.figureProjection, 'max');
  const avg = makeEnv({ spec: slab('average') }).page.describe();
  assert.deepEqual(idx(avg, 0), idx(mip, 0), 'an average slab covers the planes of its MIP');
  assert.deepEqual(idx(avg, 1), idx(mip, 1));
  assert.equal(avg.figureProjection, 'mean');
  // The −Z face (yaw 180, value 1 − c): the same slices, the face recorded.
  const back = makeEnv({ spec: { ...slab('mip'), value: 1 - (5 + 21 / 2) / z, yaw: 180 } }).page.describe();
  assert.equal(back.available, true);
  assert.deepEqual(idx(back, 0), range(5, 25), 'both faces read the same slices');
  assert.equal(back.orientation.back, true);
  // A roll of the figure is reported.
  const rolled = makeEnv({ spec: { ...slab('mip'), roll: 33 } }).page.describe();
  assert.ok(Math.abs(rolled.orientation.rollDeg - 33) < 1e-6, `roll ${rolled.orientation.rollDeg}`);
  assert.deepEqual(idx(rolled, 0), range(5, 25), 'a roll does not change the planes');
  // A single slice from the browser is one plane.
  const one = makeEnv({ spec: { mode: 'oblique', axis: 'z', value: (7 + 0.5) / z, yaw: 0, pitch: 0, roll: 0, slabThickness: 1, slabStepNorm: 1 / z, projection: 'single' } }).page.describe();
  assert.deepEqual(idx(one, 0), [7]);
  // The figure's own spec is kept in the document: the browser may have moved since.
  const zs = makeEnv({ spec: { mode: 'oblique', axis: 'z', value: 0.5, yaw: 0, pitch: 0, roll: 0, slabThickness: 1, projection: 'single' },
    zstack: slab('mip') }).page.describe();
  assert.deepEqual(idx(zs, 0), [Math.floor(0.5 * 41)], 'the document\'s plane wins over the browser\'s current range');
  // A document without a plane (the viewer built it from the slicer) falls back to the browser's slab.
  const fallback = makeEnv({ spec: {}, zstack: slab('mip') }).page.describe();
  assert.deepEqual(idx(fallback, 0), range(5, 25));
  console.log('describe: MIP / average slabs, faces, roll, Z-stack range: OK');
}

// ── 3. describe: the pure index arithmetic ──────────────────────────────────────
{
  const { page } = makeEnv();
  const geomOf = (spec) => Ops.plainGeometry(RealSlicer.planeGeometry(spec, PHYSICAL, null));
  // A slab reaching beyond the volume keeps the samples inside it.
  const edge = geomOf({ mode: 'xy', value: 0.95, slabThickness: 21, slabStepNorm: 1 / 41, projection: 'mip' });
  const inside = page.indices(edge, 'z', 41);
  assert.equal(inside.at(-1), 40);
  assert.ok(inside.length < 21, 'samples outside the box are dropped');
  assert.deepEqual(inside, range(inside[0], 40), 'still contiguous');
  // A single plane at the very end clamps like the shader.
  assert.deepEqual(page.indices(geomOf({ mode: 'xy', value: 1, slabThickness: 1, projection: 'single' }), 'z', 41), [40]);
  assert.deepEqual(page.indices(geomOf({ mode: 'xy', value: 0, slabThickness: 1, projection: 'single' }), 'z', 41), [0]);
  // A slab entirely outside the volume: nothing.
  const none = { ...edge, center: { x: 0.5, y: 0.5, z: 3 } };
  assert.deepEqual(page.indices(none, 'z', 41), []);
  console.log('describe: index arithmetic at the edges: OK');
}

// ── 4. describe: XZ and YZ planes ──────────────────────────────────────────────
{
  const xz = makeEnv({ spec: { mode: 'xz', value: 0.5, slabThickness: 1, projection: 'single' } }).page.describe();
  assert.equal(xz.axis, 'y');
  assert.equal(xz.uAxis, 'x');
  assert.equal(xz.vAxis, 'z');
  assert.deepEqual(idx(xz, 0), [26], 'floor(0.5 · 52)');
  assert.deepEqual(idx(xz, 1), [13], 'floor(0.5 · 26) at level 1');
  assert.equal(xz.levels[0].width, 70);
  assert.equal(xz.levels[0].height, 41);
  const yz = makeEnv({ spec: { mode: 'yz', value: 0.25, slabThickness: 1, projection: 'single' } }).page.describe();
  assert.equal(yz.axis, 'x');
  assert.equal(yz.uAxis, 'y');
  assert.equal(yz.vAxis, 'z');
  assert.deepEqual(idx(yz, 0), [Math.floor(0.25 * 70)]);
  assert.equal(yz.levels[0].width, 52);
  assert.equal(yz.levels[0].height, 41);
  console.log('describe: XZ / YZ axes, sizes, indices: OK');
}

// ── 5. describe: refusals, each with its reason ────────────────────────────────
{
  const reason = (opts) => makeEnv(opts).page.describe();
  assert.deepEqual({ ...reason({ spec: { mode: 'oblique', value: 0.5, yaw: 30, pitch: 20, roll: 0, slabThickness: 1, projection: 'single' } }) },
    { available: false, reasonKey: 'studioAdvanced.needAxisPlane' });
  assert.deepEqual({ ...reason({ warped: true }) }, { available: false, reasonKey: 'studioAdvanced.notSupported' }, 'a stabilised timelapse');
  assert.deepEqual({ ...reason({ layoutMaps: [{}] }) }, { available: false, reasonKey: 'studioAdvanced.notSupported' }, 'a Compare figure');
  assert.deepEqual({ ...reason({ iframe: true }) }, { available: false, reasonKey: 'studioAdvanced.notSupported' }, 'an embedded panel');
  assert.deepEqual({ ...reason({ studioOpen: false }) }, { available: false, reasonKey: 'studioAdvanced.notSupported' }, 'no figure open');
  assert.deepEqual({ ...reason({ shown: false }) }, { available: false, reasonKey: 'studioAdvanced.noDataset' }, 'nothing on screen');
  console.log('describe: refusals and their reason keys: OK');
}

// ── 6. describe: a timelapse, tree keys ────────────────────────────────────────
{
  const { page, view, treeOf } = makeEnv({ live: true, cut: true, formatVersion: 5 });
  const a = page.describe();
  assert.equal(a.timepoint, 12);
  assert.equal(a.formatVersion, 5);
  assert.equal(a.treeKey, page.describe().treeKey, 'stable for one tree');
  view.shown = 13;
  const b = page.describe();
  assert.notEqual(b.treeKey, a.treeKey, 'another timepoint is another tree');
  assert.equal(b.available, true);
  assert.ok(treeOf(12).manifest !== treeOf(13).manifest);
  console.log('describe: timelapse frame and tree key: OK');
}

// ── 7. open (bricks): [plane][row][column] for each axis, one pin ───────────────
async function blockCheck(spec, level, axis, expectAt) {
  const { page, calls, handle } = makeEnv({ spec });
  const session = await page.open({ level });
  assert.equal(session.level, level);
  assert.equal(session.backend(), 'bricks');
  assert.equal(session.bandRows, 64);
  assert.equal(session.zChunk, 64);
  const info = page.describe().levels.find(l => l.level === level);
  assert.equal(session.width, info.width);
  assert.equal(session.height, info.height);
  assert.equal(session.depth, info.indices.length);
  const rows = Math.min(5, session.height - 2);
  const y0 = 2;
  const block = await session.readBlock({ y0, y1: y0 + rows, z0: 0, z1: session.depth, channels: [2, 0] });
  assert.equal(block.width, session.width);
  assert.equal(block.rows, rows);
  assert.equal(block.depth, session.depth);
  assert.equal(block.data.length, 2);
  [2, 0].forEach((c, k) => {
    assert.equal(block.data[k].length, session.width * rows * session.depth);
    for (let d = 0; d < session.depth; d++) for (let r = 0; r < rows; r++) for (let col = 0; col < session.width; col++) {
      const got = block.data[k][(d * rows + r) * session.width + col];
      const want = expectAt(col, y0 + r, info.indices[d], c);
      assert.equal(got, want, `axis ${axis} level ${level} plane ${d} row ${r} col ${col} channel ${c}`);
    }
  });
  // A second block reuses the one pin and hands it to DataAccess.
  await session.readBlock({ y0: 0, y1: 1, z0: 0, z1: 1 });
  assert.equal(calls.pins, 1, 'the tree is pinned once for the whole session');
  assert.ok(calls.reads.length === 2 && calls.reads.every(r => r.opts.handle === handle && r.opts.level === level), 'every read names the pin and the level');
  assert.deepEqual(calls.reads[1].chans, [0, 1, 2], 'no channel list = every channel');
  session.release();
  return calls;
}
{
  const z = 41;
  // axis z (a Z-stack slab at level 0 and level 1)
  const slab = { mode: 'oblique', axis: 'z', value: (5 + 21 / 2) / z, yaw: 0, pitch: 0, roll: 0, slabThickness: 21, slabStepNorm: 1 / z, projection: 'mip' };
  const c0 = await blockCheck(slab, 0, 'z', (x, y, zi, c) => f(x, y, zi, c));
  assert.deepEqual({ ...c0.reads[0].box }, { x0: 0, x1: 70, y0: 2, y1: 7, z0: 5, z1: 26 }, 'one contiguous box over the slab');
  await blockCheck(slab, 1, 'z', (x, y, zi, c) => f(x, y, zi, c));
  // axis y: image columns x, rows z
  const xz = await blockCheck({ mode: 'xz', value: 0.5, slabThickness: 1, projection: 'single' }, 0, 'y', (x, zrow, yi, c) => f(x, yi, zrow, c));
  assert.deepEqual({ ...xz.reads[0].box }, { x0: 0, x1: 70, y0: 26, y1: 27, z0: 2, z1: 7 });
  await blockCheck({ mode: 'xz', value: 0.5, slabThickness: 1, projection: 'single' }, 1, 'y', (x, zrow, yi, c) => f(x, yi, zrow, c));
  // axis x: image columns y, rows z; a MIP slab across x
  const yz = { mode: 'yz', value: 0.5, slabThickness: 7, slabStepNorm: 1 / 70, projection: 'mip' };
  await blockCheck(yz, 0, 'x', (y, zrow, xi, c) => f(xi, y, zrow, c));
  console.log('open: bricks backend, block layout for z / y / x, one pin: OK');
}

// ── 8. open: block bounds, channels, estimate, errors ──────────────────────────
{
  const { page } = makeEnv();
  await assert.rejects(page.open({ level: 5 }), (err) => err.code === 'NO_LEVEL');
  const session = await page.open({ level: 0 });
  await assert.rejects(session.readBlock({ y0: 0, y1: 0, z0: 0, z1: 1 }), RangeError);
  await assert.rejects(session.readBlock({ y0: 0, y1: 53, z0: 0, z1: 1 }), RangeError);
  await assert.rejects(session.readBlock({ y0: 0, y1: 1, z0: 0, z1: 2 }), RangeError);
  await assert.rejects(session.readBlock({ y0: 0, y1: 1, z0: 0, z1: 1, channels: [3] }), RangeError);
  await assert.rejects(session.readBlock({ y0: 0.5, y1: 1, z0: 0, z1: 1 }), RangeError);
  session.release();
  await assert.rejects(session.readBlock({ y0: 0, y1: 1, z0: 0, z1: 1 }), (err) => err.code === 'STUDIO_SESSION_RELEASED');
  const closed = makeEnv({ studioOpen: false });
  await assert.rejects(closed.page.open({}), (err) => err.code === 'STUDIO_NOT_SUPPORTED');
  const nothing = makeEnv({ shown: false });
  await assert.rejects(nothing.page.open({}), (err) => err.code === 'NO_DATASET');
  console.log('open: bounds, released session, refusals: OK');
}
{
  // estimateBytes: the compressed bytes of the bricks holding the planes (1000 each in the fake).
  const { page } = makeEnv({ spec: { mode: 'xy', value: 0.37, slabThickness: 1, projection: 'single' } });
  const session = await page.open({ level: 0 });
  const bricks = Math.ceil(70 / BS) * Math.ceil(52 / BS) - 1; // one layer of bricks, (1,1,1) is not stored but (1,1,0) is
  const layerBricks = Math.ceil(70 / BS) * Math.ceil(52 / BS);
  assert.equal(session.estimateBytes(), layerBricks * 3 * 1000, 'one brick layer, three channels');
  assert.ok(bricks < layerBricks);
  session.release();
}

// ── 9. open: planes and the cut store, with fallback ───────────────────────────
{
  const spec = { mode: 'oblique', axis: 'z', value: (5 + 3 / 2) / 41, yaw: 0, pitch: 0, roll: 0, slabThickness: 3, slabStepNorm: 1 / 41, projection: 'mip' };
  const { page, calls } = makeEnv({ spec, planes: true, formatVersion: 2 });
  const session = await page.open({ level: 0 });
  assert.equal(session.backend(), 'planes');
  assert.equal(session.bandRows, 64, 'tile rows (32) rounded to a multiple of 64');
  assert.equal(session.zChunk, 8);
  assert.equal(session.estimateBytes(), 4321, 'the planes\' own estimate');
  const block = await session.readBlock({ y0: 4, y1: 9, z0: 0, z1: 3, channels: [1] });
  for (let d = 0; d < 3; d++) for (let r = 0; r < 5; r++) for (let col = 0; col < 70; col++) {
    assert.equal(block.data[0][(d * 5 + r) * 70 + col], f(col, 4 + r, 5 + d, 1));
  }
  assert.deepEqual(calls.planeLoads.map(p => p.z).sort((a, b) => a - b), [5, 6, 7]);
  assert.deepEqual({ ...calls.planeLoads[0].rect }, { x0: 0, y0: 4, x1: 70, y1: 9 });
  assert.equal(calls.reads.length, 0, 'no brick read');
  session.release();
  // Level 1 has no planes/: the bricks.
  const lower = await page.open({ level: 1 });
  assert.equal(lower.backend(), 'bricks');
  lower.release();
  console.log('open: planes backend: OK');
}
{
  const spec = { mode: 'oblique', axis: 'z', value: 0.5, yaw: 0, pitch: 0, roll: 0, slabThickness: 1, projection: 'single' };
  const { page, calls } = makeEnv({ spec, planes: true, planesFail: true, formatVersion: 2 });
  const session = await page.open({ level: 0 });
  assert.equal(session.backend(), 'planes');
  const block = await session.readBlock({ y0: 0, y1: 2, z0: 0, z1: 1, channels: [0] });
  assert.equal(block.data[0][1], f(1, 0, 20, 0), 'the bricks answered');
  assert.equal(session.backend(), 'bricks', 'a failing planes tree is dropped for the session');
  assert.ok(calls.warns.some(w => /planes tree failed/.test(w)));
  const n = calls.planeLoads.length;
  await session.readBlock({ y0: 0, y1: 2, z0: 0, z1: 1 });
  assert.equal(calls.planeLoads.length, n, 'not tried again');
  session.release();
  console.log('open: a failing planes tree falls back to the bricks: OK');
}
{
  const { page, calls } = makeEnv({ spec: { mode: 'xz', value: 0.5, slabThickness: 3, slabStepNorm: 1 / 52, projection: 'mip' }, cut: true, formatVersion: 5 });
  const session = await page.open({ level: 1 });
  assert.equal(session.backend(), 'xz');
  assert.equal(session.bandRows, 64);
  assert.equal(session.zChunk, 8);
  const info = page.describe().levels.find(l => l.level === 1);
  const block = await session.readBlock({ y0: 3, y1: 8, z0: 0, z1: session.depth, channels: [0, 2] });
  [0, 2].forEach((c, k) => {
    for (let d = 0; d < session.depth; d++) for (let r = 0; r < 5; r++) for (let col = 0; col < session.width; col++) {
      assert.equal(block.data[k][(d * 5 + r) * session.width + col], f(col, info.indices[d], 3 + r, c));
    }
  });
  assert.ok(calls.cutRows.every(r => r.kind === 'xz' && r.level === 1));
  assert.deepEqual([...new Set(calls.cutRows.map(r => r.row))].sort((a, b) => a - b), info.indices, 'one cut row per plane and channel');
  assert.equal(calls.reads.length, 0);
  session.release();
  const yz = makeEnv({ spec: { mode: 'yz', value: 0.5, slabThickness: 1, projection: 'single' }, cut: true, cutFail: true, formatVersion: 5 });
  const s2 = await yz.page.open({ level: 0 });
  assert.equal(s2.backend(), 'yz');
  const b2 = await s2.readBlock({ y0: 0, y1: 3, z0: 0, z1: 1, channels: [1] });
  assert.equal(b2.data[0][2], f(35, 2, 0, 1), 'the bricks answered');
  assert.equal(s2.backend(), 'bricks');
  s2.release();
  console.log('open: cut store (XZ / YZ rows) and its fallback: OK');
}

// ── 10. open: the figure's frame is held, a lost frame throws ──────────────────
{
  const { page, calls, env, timeline, view, treeOf } = makeEnv({ live: true });
  const session = await page.open({ level: 0 });
  assert.ok(timeline.paused >= 1, 'playback is paused');
  assert.ok(calls.prefetch.stops >= 1, 'the prefetch is stopped');
  assert.equal(page.holds(), 1, 'one hold');
  assert.deepEqual(calls.inits, [12], 'the tree on screen is mounted');
  assert.equal(calls.pins, 1);
  session.assertFrame();
  await session.readBlock({ y0: 0, y1: 1, z0: 0, z1: 1 });
  // Another frame takes the screen.
  view.shown = 13;
  assert.throws(() => session.assertFrame(), (err) => err.code === 'STUDIO_FRAME_LOST');
  await assert.rejects(session.readBlock({ y0: 0, y1: 1, z0: 0, z1: 1 }), (err) => err.code === 'STUDIO_FRAME_LOST');
  view.shown = 12;
  session.assertFrame();
  // ... and DURING a read: the block is refused, never returned.
  env.duringRead = () => { view.shown = 14; };
  await assert.rejects(session.readBlock({ y0: 0, y1: 1, z0: 0, z1: 1 }), (err) => err.code === 'STUDIO_FRAME_LOST');
  env.duringRead = null;
  view.shown = 12;
  // The Studio document replaced by another: the figure left.
  session.release();
  session.release();
  assert.equal(page.holds(), 0, 'released once');
  assert.equal(calls.prefetch.kicks, 1, 'the prefetch is kicked again once');
  assert.throws(() => session.assertFrame(), (err) => err.code === 'STUDIO_FRAME_LOST', 'a released session is not a frame');
  assert.ok(treeOf(12));
  console.log('open: frame held, frame lost before / during a read, release idempotent: OK');
}
{
  // The figure's frame is not the one on screen: put back first; when it cannot be, the open is refused.
  const back = makeEnv({ live: true });
  back.page.mount(17);
  back.view.shown = 17;
  // describe reads the document's frame (12) — the screen shows 17.
  const session = await back.page.open({ level: 0 });
  assert.deepEqual(back.env.loads, [12], 'frame 12 is loaded again');
  assert.deepEqual(back.timeline.frames.at(-1), [12, true, false]);
  assert.equal(back.page.timepoint(), 12);
  session.release();
  const lost = makeEnv({ live: true, loadFails: true });
  lost.page.mount(17);
  await assert.rejects(lost.page.open({ level: 0 }), (err) => err.code === 'STUDIO_FRAME_LOST');
  assert.equal(lost.page.holds(), 0, 'nothing held after a refused open');
  console.log('open: the figure\'s frame is put back, or the open is refused: OK');
}
{
  // The Studio closes and another document opens while a session lives: the figure left.
  const { page, studio } = makeEnv();
  const session = await page.open({ level: 0 });
  studio.token = 6;
  assert.throws(() => session.assertFrame(), (err) => err.code === 'STUDIO_FRAME_LOST');
  session.release();
  const second = makeEnv();
  const s2 = await second.page.open({ level: 0 });
  second.studio.open = false;
  assert.throws(() => s2.assertFrame(), (err) => err.code === 'STUDIO_FRAME_LOST');
  s2.release();
  console.log('open: a closed or replaced Studio document ends the session\'s frame: OK');
}

// ── 11. open: abort ────────────────────────────────────────────────────────────
{
  const aborted = new AbortController();
  aborted.abort();
  const early = makeEnv();
  await assert.rejects(early.page.open({ level: 0, signal: aborted.signal }), (err) => err.name === 'AbortError');
  assert.equal(early.page.holds(), 0);

  const ctl = new AbortController();
  const { page, calls } = makeEnv({ live: true });
  const session = await page.open({ level: 0, signal: ctl.signal });
  assert.equal(page.holds(), 1);
  ctl.abort();
  assert.equal(page.holds(), 0, 'aborting the signal releases the session');
  assert.equal(calls.prefetch.kicks, 1);
  await assert.rejects(session.readBlock({ y0: 0, y1: 1, z0: 0, z1: 1 }), (err) => err.code === 'STUDIO_SESSION_RELEASED');

  // A block signal aborts one read, not the session.
  const two = makeEnv();
  const s = await two.page.open({ level: 0 });
  const block = new AbortController();
  block.abort();
  await assert.rejects(s.readBlock({ y0: 0, y1: 1, z0: 0, z1: 1, signal: block.signal }), (err) => err.name === 'AbortError');
  await s.readBlock({ y0: 0, y1: 1, z0: 0, z1: 1 });
  s.release();
  console.log('open: abort signals: OK');
}

// ── 12. the facade ctx.studio ──────────────────────────────────────────────────
{
  const { page } = makeEnv();
  const ctxStudio = page.facade();
  assert.deepEqual(Object.keys(ctxStudio).sort(), ['getDocument', 'getSliceRaw', 'isOpen', 'library', 'registerMode', 'source']);
  assert.deepEqual(Object.keys(ctxStudio.source).sort(), ['describe', 'open']);
  assert.equal(ctxStudio.isOpen(), true);
  assert.equal(ctxStudio.getDocument().dataset.id, '3d/demo');
  assert.equal(ctxStudio.source.describe().available, true);
  const session = await ctxStudio.source.open({ level: 0 });
  assert.equal(typeof session.readBlock, 'function');
  session.release();
  // registerMode is wired to the real thing at the call site.
  assert.match(viewerSrc, /studio: _studioFacade\(\)/, 'ctx.studio is in the context handed to initAll');
  assert.match(viewerSrc, /registerMode: \(mode\) => \(none \? \(\) => \{\} : StudioEditor\.registerMode\(mode\)\)/);
  console.log('ctx.studio facade: OK');
}

// ── 13. the pure block reorder ─────────────────────────────────────────────────
{
  const { page } = makeEnv();
  // axis y: D = 2 planes, R = 3 rows, W = 4 columns; src is [row][plane][col].
  const W = 4, R = 3, D = 2;
  const src = new Uint8Array(W * R * D);
  for (let r = 0; r < R; r++) for (let d = 0; d < D; d++) for (let c = 0; c < W; c++) src[(r * D + d) * W + c] = 100 * d + 10 * r + c;
  const out = page.toBlock(src, 'y', W, R, D);
  for (let d = 0; d < D; d++) for (let r = 0; r < R; r++) for (let c = 0; c < W; c++) assert.equal(out[(d * R + r) * W + c], 100 * d + 10 * r + c);
  // axis x: src is [row][col][plane].
  const srcX = new Uint8Array(W * R * D);
  for (let r = 0; r < R; r++) for (let c = 0; c < W; c++) for (let d = 0; d < D; d++) srcX[(r * W + c) * D + d] = 100 * d + 10 * r + c;
  const outX = page.toBlock(srcX, 'x', W, R, D);
  for (let d = 0; d < D; d++) for (let r = 0; r < R; r++) for (let c = 0; c < W; c++) assert.equal(outX[(d * R + r) * W + c], 100 * d + 10 * r + c);
  assert.equal(page.toBlock(src, 'z', W, R, D), src, 'axis z is already in block order');
  console.log('block reorder for y / x: OK');
}

console.log('Studio source describe / open (viewer.js): OK');
