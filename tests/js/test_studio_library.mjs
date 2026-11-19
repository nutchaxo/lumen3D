// ctx.studio.library (viewer.js): list / describe / openPlanes / openOblique / tiffIndex / preview / release,
// against a scripted loader, plane loader, cut store and catalog over one synthetic volume:
//   - list: types, fields, hidden datasets absent;
//   - describe per format (1, 2, 4, 5, 6) mounted and not, a timelapse's frames, a photograph, the TIFFs listing;
//   - openPlanes: level mapping outward, the backend of each case of the PLAN §3.1 table, readBlock shapes,
//     LIBRARY_SOURCE_LOST / LIBRARY_RELEASED, every refusal with its `needsViewer`;
//   - openOblique: G = the slicer's own mapping (sample points), the bricks it asks for = _cutBricksForSpec /
//     _nativeSliceBricksForSpec with the options argument (mounted, a non-displayed timepoint through
//     withMount, another dataset), the 1-voxel border stripped, `empty` (ESS) vs `failed`, backpressure,
//     a CutStore opened per run, and the picture IJOblique accumulates from the delivered bricks = the direct
//     evaluation of the slicer's mapping on the synthetic volume;
//   - tiffIndex: the .php fallback, the absolute percent-encoded url, LIBRARY_TIFF_INDEX;
//   - release idempotent. The figure path (_studioSourceOpen over the shared reader) is proved byte-identical by
//     tests/js/test_studio_source_describe.mjs.
//
// Run: node tests/js/test_studio_library.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { loadModule, ROOT } from './harness.mjs';

const require = createRequire(import.meta.url);
const THREE = require('../../js/vendor/three.min.js');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const viewerSrc = read('js/pages/viewer.js');
const Slicer = loadModule('js/viewers/volume-slicer.js', 'VolumeSlicer', { THREE, window: {} });
const Ops = loadModule('js/workers/studio-plane-ops.js', 'StudioPlaneOps', {});
vm.runInThisContext(read('js/modules/studio/advanced-studio/ij-proc-lib.js'), { filename: 'ij-proc-lib.js' });
const { IJOblique } = globalThis;

function lift(name) {
  const m = viewerSrc.match(new RegExp(`\\n  (?:async )?function ${name}\\([^\\n]*\\) \\{\\n[\\s\\S]*?\\n  \\}\\n`));
  assert.ok(m, `${name} must be defined at module level in viewer.js`);
  return m[0];
}
const stateBlock = (viewerSrc.match(/\n {2}const _LIB_TYPES[\s\S]*?\n {2}let _libApi = null;\n/) || [])[0];
assert.ok(stateBlock, 'the library state block must precede its functions');

const PHYSICAL = { x: 140, y: 104, z: 205 };
const DIMS0 = { x: 70, y: 52, z: 41 };
const dimsOf = (k) => (k === 0 ? DIMS0 : { x: Math.ceil(DIMS0.x / 2), y: Math.ceil(DIMS0.y / 2), z: Math.ceil(DIMS0.z / 2) });
const LEVELS = 2;
const CHANNELS = 3;
const vox = (level, c, t, x, y, z) => ((x * 7 + y * 13 + z * 29 + c * 5 + level * 3 + t * 11) % 250) + 1;
// The packer dropped the brick (1, 0, 0) of level 0 (x ≥ 64): zero voxels, not stored.
const absent = (level, x) => level === 0 && x >= 64;
const volume = (level, c, t) => (x, y, z) => {
  const d = dimsOf(level);
  if (x < 0 || y < 0 || z < 0 || x >= d.x || y >= d.y || z >= d.z || absent(level, x)) return 0;
  return vox(level, c, t, x, y, z);
};

function schemaOf(format) { return format >= 6 ? 'iribhm-bricks-v6' : format === 5 ? 'iribhm-bricks-v5' : format >= 3 ? 'iribhm-bricks-v3' : 'iribhm-bricks-v2'; }

let packingMode = 'grid';          // a v2 tree's brickPacking.mode: 'vertical' makes BrickLoader ignore `region`
function treeManifest(format, t = 0) {
  const m = {
    schema: schemaOf(format), brickSize: 64, channels: CHANNELS, frame: t,
    levels: Array.from({ length: LEVELS }, (_, k) => ({ level: k, dimensions: dimsOf(k) }))
  };
  if (format < 3) m.brickPacking = { mode: packingMode };
  if (format >= 5) {
    m.index = { columns: { ll: { sha256: `${'cd'.repeat(30)}${String(t).padStart(4, '0')}` } } };
    m.stores = { cuts: { levels: Array.from({ length: LEVELS }, (_, k) => ({ level: k, brickZ: 8 })) } };
  }
  return m;
}

function makeEnv({ format = 5, mountedId = '3d/mount', live = false, shownTimepoint = 0, badManifestFor = null, failBrick = null, failCut = null, tiffIndexMode = 'ok' } = {}) {
  const log = {
    pins: [], withMountCalls: 0, brickBatches: [], cutOpens: 0, cutCalls: [], planeOpens: [], fetches: [], reads: [],
    maxBatch: 0
  };
  const catalog = [
    { id: '3d/mount', type: '3d', name: 'Mounted', stage: 'E8.5', embryo: 'Em1', formatVersion: format, dimensions: { ...DIMS0, c: CHANNELS, t: 1 }, physicalSizeUm: PHYSICAL, channels: [{ name: 'DAPI', color: '#00AAFF', min: 0, max: 1 }, { name: 'GFP', color: '#00FF00', min: 10, max: 200 }, { name: 'Cy5', color: '#FF00FF' }] },
    { id: '3d/other6', type: '3d', name: 'Other six', formatVersion: 6, dimensions: { ...DIMS0, c: CHANNELS, t: 1 }, physicalSizeUm: PHYSICAL, channels: [{ name: 'A' }, { name: 'B' }, { name: 'C' }] },
    { id: '3d/other5', type: '3d', name: 'Other five', formatVersion: 5, dimensions: { ...DIMS0, c: CHANNELS, t: 1 }, physicalSizeUm: PHYSICAL, channels: [{ name: 'A' }, { name: 'B' }, { name: 'C' }] },
    { id: '3d/other2', type: '3d', name: 'Other two', formatVersion: 2, dimensions: { ...DIMS0, c: CHANNELS, t: 1 }, physicalSizeUm: PHYSICAL, channels: [{ name: 'A' }, { name: 'B' }, { name: 'C' }] },
    { id: '3d/other1', type: '3d', name: 'Other one', formatVersion: 1, dimensions: { ...DIMS0, c: CHANNELS, t: 1 }, physicalSizeUm: PHYSICAL, channels: [{ name: 'A' }, { name: 'B' }, { name: 'C' }] },
    { id: '3d/badmanifest', type: '3d', name: 'Bad', formatVersion: 4, dimensions: { ...DIMS0, c: CHANNELS, t: 1 }, physicalSizeUm: PHYSICAL },
    { id: '3d/hiddenone', type: '3d', name: 'Hidden', hidden: true, formatVersion: 6 },
    { id: 'tracking/odd', type: 'tracking', name: 'Not a library type' },
    { id: 'live/tl', type: 'live', name: 'Timelapse', formatVersion: format, dimensions: { ...DIMS0, c: CHANNELS, t: 3 }, physicalSizeUm: PHYSICAL, channels: [{ name: 'A' }, { name: 'B' }, { name: 'C' }] },
    { id: 'live/tl6', type: 'live', name: 'Timelapse six', formatVersion: 6, dimensions: { ...DIMS0, c: CHANNELS, t: 10 }, physicalSizeUm: PHYSICAL, channels: [{ name: 'A' }, { name: 'B' }, { name: 'C' }] },
    { id: '2d/photo', type: '2d', name: 'Photo', dimensions: { x: 1920, y: 1440, z: 1, c: 3 }, pixelSizeUm: { x: 2.79, y: 2.79 }, physicalSizeUm: { x: 5363, y: 4022 }, image: { native: 'image.webp', width: 1920, height: 1440, preview: 'preview.webp' } }
  ];
  const rootOf = (fmt) => ({ ...treeManifest(fmt), timepoints: Array.from({ length: 10 }, (_, t) => t).map((t) => ({ path: `t${String(t).padStart(3, '0')}`, t })) });
  const selectBrickManifest = (root, tp) => {
    if (!root.timepoints) return { available: true, manifest: root, subPath: '', histograms: [] };
    const row = root.timepoints[tp];
    if (!row) return { available: false, code: 'TIMEPOINT_MISSING' };
    return { available: true, manifest: { ...treeManifest(root.schema === 'iribhm-bricks-v6' ? 6 : root.schema === 'iribhm-bricks-v5' ? 5 : 2, tp), timepoints: null }, subPath: row.path };
  };
  const mounted = { path: live ? 'DATA_WEB/live/tl/bricks/t000' : 'DATA_WEB/3d/mount/bricks', manifest: treeManifest(format, 0), handle: null };
  const handles = [];
  let current = null;
  const BrickLoader = {
    isReady: () => true,
    getBasePath: () => mounted.path,
    getManifest: () => mounted.manifest,
    validateManifest: (m) => { if (m.bad) throw new Error('refused'); },
    async pinTree(p, manifest) {
      let h = handles.find(x => x.path === p && x.alive);
      if (!h) { h = { path: p, manifest, alive: true, t: Number(manifest.frame) || 0 }; handles.push(h); }
      log.pins.push(p);
      return h;
    },
    withMount(h, fn) {
      if (!h || !h.alive) throw Object.assign(new Error('gone'), { code: 'BRICKS_MOUNT_CHANGED' });
      log.withMountCalls++;
      const was = current;
      current = h;
      try { return fn(); } finally { current = was; }
    },
    getDimensions: (k) => (k < LEVELS ? { ...dimsOf(k), brickSize: 64, channels: CHANNELS } : null),
    getFormat: () => ({ version: format >= 3 ? 3 : 2, apron: format >= 3 ? 1 : 0, brickSize: 64 }),
    activeBricks(lod) {
      const d = dimsOf(lod), out = [];
      for (let bz = 0; bz * 64 < d.z; bz++) for (let by = 0; by * 64 < d.y; by++) for (let bx = 0; bx * 64 < d.x; bx++) {
        if (absent(lod, bx * 64)) continue;
        out.push({ bx, by, bz });
      }
      out.handle = current && current.path;
      log.activeFor = current ? current.path : '(mounted)';
      return out;
    },
    taskBytes: () => 1000,
    estimateTaskBytes: (tasks) => tasks.length * 1000,
    async loadBrickTasks(tasks, o) {
      log.brickBatches.push({ n: tasks.length, mount: o.mount && o.mount.path, group: o.group, byteRanges: o.byteRanges, cancelPrevious: o.cancelPrevious });
      log.maxBatch = Math.max(log.maxBatch, tasks.length);
      await Promise.resolve();
      if (o.signal?.aborted) return { summary: { cancelled: true, failed: [] } };
      const failed = [];
      const apron = BrickLoader.getFormat().apron;
      const h = o.mount;
      for (const t of tasks) {
        if (failBrick && failBrick.bx === t.bx && failBrick.by === t.by && failBrick.bz === t.bz) { failed.push({ bx: t.bx, by: t.by, bz: t.bz, channel: t.channel, lod: t.lod, error: new Error('x') }); continue; }
        const r = t.region || { x0: apron, x1: apron + 64, y0: apron, y1: apron + 64, z0: apron, z1: apron + 64 };
        const vol = volume(t.lod, t.channel, h ? h.t : 0);
        const w = r.x1 - r.x0, hh = r.y1 - r.y0, d = r.z1 - r.z0;
        const data = new Uint8Array(w * hh * d);
        for (let z = 0; z < d; z++) for (let y = 0; y < hh; y++) for (let x = 0; x < w; x++) {
          data[(z * hh + y) * w + x] = vol(t.bx * 64 + r.x0 - apron + x, t.by * 64 + r.y0 - apron + y, t.bz * 64 + r.z0 - apron + z);
        }
        o.onBrickLoaded?.({ bx: t.bx, by: t.by, bz: t.bz, channel: t.channel, lod: t.lod, data, region: r });
      }
      return { summary: { cancelled: false, failed } };
    }
  };
  const DataAccess = {
    async readRegion(box, chans, o = {}) {
      log.reads.push({ box: { ...box }, chans: [...chans], level: o.level, handle: o.handle && o.handle.path });
      await Promise.resolve();
      if (o.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      const t = o.handle ? o.handle.t : 0;
      const w = box.x1 - box.x0, h = box.y1 - box.y0, d = box.z1 - box.z0;
      return { dims: { x: w, y: h, z: d }, data: chans.map((c) => { const vol = volume(o.level || 0, c, t); const out = new Uint8Array(w * h * d); for (let z = 0; z < d; z++) for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[(z * h + y) * w + x] = vol(box.x0 + x, box.y0 + y, box.z0 + z); return out; }) };
    }
  };
  const CutStore = {
    open(base, manifest) {
      log.cutOpens++;
      const t = Number(manifest.frame) || 0;
      return {
        base, manifest,
        async loadCutBricks(level, c, bz, list, o = {}) {
          log.cutCalls.push({ level, c, bz, keys: list.map(b => `${b.cx}_${b.cy}_${b.cz}`), base });
          await Promise.resolve();
          if (o.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
          if (failCut && list.some(b => `${b.cx}_${b.cy}_${b.cz}` === failCut)) throw new Error('cut read failed');
          const vol = volume(level, c, t), d = dimsOf(level);
          for (const b of list) {
            const x0 = b.cx * 32, y0 = b.cy * 32, z0 = b.cz * bz;
            if (absent(level, x0)) continue;                       // not stored: never reported
            const data = new Uint8Array(bz * 32 * 32);
            for (let z = 0; z < bz; z++) for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) data[(z * 32 + y) * 32 + x] = vol(x0 + x, y0 + y, z0 + z);
            o.onBrick?.({ cx: b.cx, cy: b.cy, cz: b.cz, data });
          }
          return list.length;
        }
      };
    }
  };
  const PlaneLoader = {
    async open(base, options) {
      log.planeOpens.push({ base, options });
      const t = (/t(\d{3})$/.exec(base) || [0, 0])[1] | 0;
      return {
        dimensions: { ...DIMS0 }, tileSize: 32,
        async loadRegion(z, chans, rect) {
          const w = rect.x1 - rect.x0, h = rect.y1 - rect.y0;
          return { width: w, height: h, channels: chans, data: chans.map((c) => { const vol = volume(0, c, Number(t)); const o = new Uint8Array(w * h); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) o[y * w + x] = vol(rect.x0 + x, rect.y0 + y, z); return o; }) };
        },
        async estimate() { return { bytes: 777 }; }
      };
    }
  };
  const VolumeViewer = {
    getPhysicalSize: () => PHYSICAL,
    getMaterial: () => ({}),
    getDisplayedTree: () => (live ? { path: mounted.path, manifest: mounted.manifest } : { path: mounted.path, manifest: mounted.manifest }),
    getDisplayedTimepoint: () => (live ? shownTimepoint : null),
    selectBrickManifest
  };
  const VolumeSlicer = {
    planeGeometry: Slicer.planeGeometry,
    samplingSpace: () => null,
    getPlaneExtentUnits: () => 1.5,
    renderWithMaterial: (material, spec, size) => ({ size, spec })
  };
  const Catalog = { getAll: () => catalog.filter(d => !d.hidden), getById: (id) => catalog.find(d => d.id === id) || null };
  const Utils = { datasetUrl: (d) => `${d.type === '2d' ? '2d' : 'viewer'}.html?id=${encodeURIComponent(d.id)}` };
  const respond = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => (typeof body === 'string' ? JSON.parse(body) : body) });
  const fetchImpl = async (url) => {
    log.fetches.push(String(url));
    const u = String(url);
    let m;
    if ((m = /^DATA_WEB\/([^/]+\/[^/]+)\/bricks\/manifest\.json$/.exec(u))) {
      if (m[1] === badManifestFor) return respond({ ...treeManifest(4), bad: true });
      if (m[1] === '3d/missing') return respond('', 404);
      const rec = catalog.find(d => d.id === m[1]);
      return respond(rec && rec.type === 'live' ? rootOf(rec.formatVersion) : treeManifest(rec ? rec.formatVersion : 4));
    }
    if (u.startsWith('api/downloads')) {
      if (!u.startsWith('api/downloads.php')) return respond({}, 404);       // the extensionless route does not exist here
      const ds = decodeURIComponent(/dataset=([^&]*)/.exec(u)[1]);
      if (ds === '3d/mount') return respond({ available: true, entries: [{ name: 'sub', kind: 'dir' }, { name: 'My Stack.tif', kind: 'file', sizeBytes: 5000, href: 'DATA_WEB/3d/mount/download/My Stack.tif' }, { name: 'notes.txt', kind: 'file', sizeBytes: 3 }, { name: 'stack (1).tif', kind: 'file', sizeBytes: 4 }, { name: 'é.tif', kind: 'file', sizeBytes: 4 }, { name: 'raw.TIFF', kind: 'file', sizeBytes: 9, href: 'DATA_WEB/3d/mount/download/raw.TIFF' }] });
      return respond({ available: false, entries: [] });
    }
    if (u.startsWith('api/tiff-index')) {
      const php = u.startsWith('api/tiff-index.php');
      if (tiffIndexMode === 'ok-php' && !php) return respond({ error: 'not_found' }, 404);
      if (tiffIndexMode === 'html403' && !php) return { ok: false, status: 403, json: async () => { throw new Error('not json'); } };
      if (tiffIndexMode === 'missing') return respond({ error: 'not_found' }, 404);
      if (tiffIndexMode === '422') return respond({ error: 'malformed' }, 422);
      if (tiffIndexMode === 'badschema') return respond({ v: 1 });
      return respond({ v: 1, dataset: '3d/mount', file: 'My Stack.tif', url: 'DATA_WEB/3d/mount/download/My Stack.tif', pages: 3, width: 8, height: 8, strips: { perPage: 1, offsets: 'AA==', byteCounts: 'AA==' } });
    }
    return respond({}, 404);
  };

  const body = `
    let datasetMeta = env.mountedId ? Catalog.getById(env.mountedId) : null;
    let _basePath = env.mountedId ? 'DATA_WEB/' + env.mountedId : '';
    let _brickManifest = env.live ? env.root : mountedManifest;
    const _isIframe = false;
    let _currentTimepoint = 0;
    function _currentChannelState() { return [{ name: 'DAPI', color: '#00aaff', min: 0, max: 255 }]; }
    ${stateBlock}
    ${['_fnv1a', '_studioTreeKey', '_linkSignals', '_studioBrickBytes', '_makeStudioReader', '_shownTimepoint', '_cutDepthOf',
      '_nativeSliceBricksForSpec', '_cutBricksForSpec', '_nativeStudioRenderSize',
      '_libError', '_libAbortError', '_libWait', '_libAcquire', '_libRecord', '_libMounted', '_libFormat', '_libTimepointCount', '_libTimepoint',
      '_libPhysical', '_libFrameName', '_libLoadTree', '_libTreeDrop', '_libTree', '_libLevels', '_libCapabilities', '_libTiffs', '_libList', '_libDescribe',
      '_libPlanesTree', '_libMapPlanes', '_libCutPlaneReader', '_libOpenPlanes', '_libSlicerSpec', '_libGeometry', '_libAllBricks', '_libOpenOblique',
      '_libTiffIndex', '_libPreview', '_libRelease', '_libraryFacade'].map(lift).join('\n')}
    const _studioTreeSignatures = new WeakMap();
    return { library: _libraryFacade(), geometry: _libGeometry, slicerSpec: _libSlicerSpec, bricksFor: _nativeSliceBricksForSpec, cutsFor: _cutBricksForSpec,
      renderSize: _nativeStudioRenderSize, state: { trees: _libTrees, planes: _libPlanes, sessions: _libSessions } };
  `;
  const env = { mountedId, live, root: live ? rootOf(format) : null };
  const page = new Function(
    'env', 'mountedManifest', 'document', 'console', 'setTimeout', 'clearTimeout', 'fetch', 'createImageBitmap', 'DOMException',
    'Catalog', 'Utils', 'BrickLoader', 'DataAccess', 'CutStore', 'PlaneLoader', 'PlaneCodec', 'VolumeViewer', 'VolumeSlicer', 'StudioPlaneOps',
    body,
  )(
    env, mounted.manifest, { baseURI: 'http://localhost:8080/viewer.html' }, { warn() {}, log() {}, error() {} }, (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; }, clearTimeout, fetchImpl,
    async (canvas) => ({ bitmap: true, canvas }), globalThis.DOMException,
    Catalog, Utils, BrickLoader, DataAccess, CutStore, PlaneLoader, {}, VolumeViewer, VolumeSlicer, Ops,
  );
  return { page, log, handles, mounted, BrickLoader, VolumeSlicer, catalog };
}

const code = async (fn) => { try { await fn(); } catch (e) { return e; } return null; };
const ids = (list) => list.map(d => d.id);

// ── list ─────────────────────────────────────────────────────────────────────────
{
  const { page } = makeEnv({ format: 6 });
  const rows = page.library.list();
  assert.deepEqual(ids(rows), ['3d/mount', '3d/other6', '3d/other5', '3d/other2', '3d/other1', '3d/badmanifest', 'live/tl', 'live/tl6', '2d/photo'], 'hidden datasets and foreign types are absent');
  const m = rows.find(r => r.id === '3d/mount');
  assert.deepEqual({ ...m, channels: undefined }, {
    id: '3d/mount', name: 'Mounted', type: '3d', stage: 'E8.5', embryo: 'Em1', formatVersion: 6, dims: { x: 70, y: 52, z: 41 }, channels: undefined,
    physicalUm: { x: 140, y: 104, z: 205 }, thumbnail: 'DATA_WEB/3d/mount/thumbnail.webp', timepoints: null, mounted: true
  });
  assert.deepEqual(m.channels.map(c => c.name), ['DAPI', 'GFP', 'Cy5']);
  assert.equal(rows.find(r => r.id === '3d/other6').mounted, false);
  assert.equal(rows.find(r => r.id === 'live/tl').timepoints, 3);
  assert.equal(rows.find(r => r.id === '2d/photo').formatVersion, 1);
  console.log('list: OK');
}

// ── describe per format ───────────────────────────────────────────────────────────
for (const [format, zBackend, obliqueBackend] of [[1, 'bricks', 'bricks'], [2, 'planes', 'bricks'], [4, 'planes', 'bricks'], [5, 'planes', 'cuts'], [6, 'planes', 'cuts']]) {
  const { page, log } = makeEnv({ format });
  const d = await page.library.describe('3d/mount');
  assert.equal(d.mounted, true);
  assert.equal(d.formatVersion, format);
  assert.equal(d.z.available, true);
  assert.equal(d.z.backend, zBackend, `format ${format} z`);
  assert.deepEqual(d.z.levels, [0, 1]);
  assert.equal(d.oblique.backend, obliqueBackend, `format ${format} oblique`);
  assert.deepEqual(d.levels.map(l => [l.level, l.dims.x, l.width, l.height]), [[0, 70, 70, 52], [1, 35, 35, 26]]);
  assert.equal(d.levels[1].voxelUm.z, PHYSICAL.z / 21);
  assert.deepEqual(d.physicalUm, { ...PHYSICAL, calibrated: true });
  assert.match(d.treeKey, /^[0-9a-f]{8}-/);
  assert.deepEqual(d.channels.map(c => [c.name, c.window.min, c.window.max]), [['DAPI', 0, 255], ['GFP', 10, 200], ['Cy5', 0, 255]], 'fractions of the catalog become the 0..255 display window');
  assert.equal(d.channels[0].color, '#00AAFF');
  assert.deepEqual(d.tiffs, [{ file: 'My Stack.tif', url: 'DATA_WEB/3d/mount/download/My Stack.tif', sizeBytes: 5000 }, { file: 'raw.TIFF', url: 'DATA_WEB/3d/mount/download/raw.TIFF', sizeBytes: 9 }], 'tif / tiff files of the root only whose name the index endpoint accepts, through the .php fallback');
  assert.equal(d.photo, null);
  assert.equal(log.pins.length, 1, 'one pin of the mounted tree');
}
{
  const { page } = makeEnv({ format: 6 });
  const o6 = await page.library.describe('3d/other6');
  assert.equal(o6.mounted, false);
  assert.equal(o6.z.backend, 'planes'); assert.deepEqual(o6.z.levels, [0, 1]);
  assert.equal(o6.oblique.backend, 'cuts'); assert.deepEqual(o6.oblique.levels, [0, 1]);
  const o2 = await page.library.describe('3d/other2');
  assert.deepEqual([o2.z.available, o2.z.levels, o2.z.backend], [true, [0], 'planes']);
  assert.deepEqual([o2.oblique.available, o2.oblique.backend, o2.oblique.reasonCode], [false, 'none', 'LIBRARY_OBLIQUE_UNSUPPORTED']);
  const o1 = await page.library.describe('3d/other1');
  assert.deepEqual([o1.z.available, o1.z.reasonCode, o1.oblique.available], [false, 'LIBRARY_FORMAT_UNSUPPORTED', false]);
  const photo = await page.library.describe('2d/photo');
  assert.deepEqual(photo.photo, { imageUrl: 'DATA_WEB/2d/photo/image.webp', previewUrl: 'DATA_WEB/2d/photo/preview.webp', width: 1920, height: 1440, pixelSizeUm: { x: 2.79, y: 2.79 } });
  assert.equal(photo.z.available, false); assert.equal(photo.oblique.available, false);
  assert.deepEqual(photo.levels, []);
  console.log('describe: formats 1, 2, 4, 5, 6, mounted and not, photograph, TIFFs: OK');
}

// ── a timelapse: each frame its own tree ───────────────────────────────────────────
{
  const { page, log } = makeEnv({ format: 5, mountedId: 'live/tl', live: true });
  const a = await page.library.describe('live/tl', { timepoint: 0 });
  const b = await page.library.describe('live/tl', { timepoint: 2 });
  assert.notEqual(a.treeKey, b.treeKey, 'a frame\'s tree key is its own');
  assert.equal(a.timepoints, 3);
  assert.deepEqual(log.pins, ['DATA_WEB/live/tl/bricks/t000', 'DATA_WEB/live/tl/bricks/t002'], 'one pin per frame, none for the screen');
  assert.equal((await page.library.describe('live/tl')).timepoint, 0, 'describe defaults to the first frame');
  const err = await code(() => page.library.openPlanes('live/tl', { first: 0, last: 3 }));
  assert.equal(err.code, 'LIBRARY_TIMEPOINT');
  assert.equal((await code(() => page.library.openPlanes('live/tl', { first: 0, last: 3, timepoint: 3 }))).code, 'LIBRARY_TIMEPOINT');
  assert.equal((await code(() => page.library.openOblique('live/tl', { spec: { depth: 0.5 } }))).code, 'LIBRARY_TIMEPOINT');
  assert.equal(page.library.list().find(r => r.id === 'live/tl').mounted, true);
  const other = makeEnv({ format: 6, mountedId: null });
  const o = await other.page.library.describe('live/tl6', { timepoint: 1 });
  assert.equal(o.timepoint, 1);
  assert.ok(other.log.fetches.some(u => u === 'DATA_WEB/live/tl6/bricks/manifest.json'));
  assert.equal(other.log.pins.length, 0, 'another dataset is never pinned or mounted');
  console.log('describe: timelapse frames: OK');
}

// ── openPlanes: level mapping, backends, shapes ────────────────────────────────────
{
  const { page, log } = makeEnv({ format: 6 });
  const s0 = await page.library.openPlanes('3d/mount', { first: 5, last: 9 });
  assert.deepEqual(s0.indices, [5, 6, 7, 8, 9]);
  assert.equal(s0.level, 0); assert.equal(s0.depth, 5);
  assert.equal(s0.width, 70); assert.equal(s0.height, 52);
  assert.deepEqual(s0.calibration, { pixelWidth: PHYSICAL.x / 70, pixelHeight: PHYSICAL.y / 52, unit: 'µm' });
  assert.equal(s0.backend(), 'planes');
  assert.equal(s0.estimateBytes(), 777);
  assert.ok(Number.isInteger(s0.bandRows) && s0.zChunk >= 1);
  const blk = await s0.readBlock({ y0: 3, y1: 7, z0: 1, z1: 3, channels: [2, 0] });
  assert.deepEqual([blk.width, blk.rows, blk.depth, blk.data.length], [70, 4, 2, 2]);
  const vol2 = volume(0, 2, 0);
  assert.equal(blk.data[0][(1 * 4 + 2) * 70 + 9], vol2(9, 3 + 2, 5 + 1 + 1), '[plane][row][column], channel order as asked');
  assert.equal(blk.data[0].length, 70 * 4 * 2);
  s0.release();
  // level 1: every level-1 plane the level-0 range covers, outward
  const s1 = await page.library.openPlanes('3d/mount', { first: 5, last: 9, level: 1 });
  assert.deepEqual(s1.indices, [2, 3, 4, 5], 'level-0 planes [5, 10) cover [2.56, 5.12) of level 1: floor 2 .. ⌈5.12⌉ − 1 = 5, never a dropped plane');
  assert.equal(s1.backend(), 'bricks', 'mounted level ≥ 1: the pinned bricks');
  const b1 = await s1.readBlock({ y0: 0, y1: 2, z0: 0, z1: 3, channels: [1] });
  assert.equal(b1.data[0][(2 * 2 + 1) * 35 + 4], volume(1, 1, 0)(4, 1, 4));
  assert.equal(log.reads.at(-1).handle, 'DATA_WEB/3d/mount/bricks', 'every block reads the pin');
  assert.equal(log.reads.at(-1).level, 1);
  // bounds, channels
  assert.equal((await code(() => s1.readBlock({ y0: 0, y1: 99, z0: 0, z1: 1 }))).name, 'RangeError');
  assert.equal((await code(() => s1.readBlock({ y0: 0, y1: 1, z0: 0, z1: 1, channels: [7] }))).name, 'RangeError');
  // refusals
  const bad = async (opts) => (await code(() => page.library.openPlanes('3d/mount', opts)));
  assert.equal((await bad({ first: 0, last: 99 })).code, 'LIBRARY_BAD_ARGS');
  assert.equal((await bad({ first: 5, last: 2 })).code, 'LIBRARY_BAD_ARGS');
  assert.equal((await bad({ first: 0, last: 1, axis: 'x' })).code, 'LIBRARY_BAD_ARGS');
  assert.equal((await bad({ first: 0, last: 1, level: 5 })).code, 'LIBRARY_LEVEL_UNSUPPORTED');
  assert.equal((await code(() => page.library.openPlanes('nope/none', { first: 0, last: 1 }))).code, 'LIBRARY_UNKNOWN');
  assert.equal((await code(() => page.library.openPlanes('3d/hiddenone', { first: 0, last: 1 }))).code, 'LIBRARY_UNKNOWN');
  const photo = await code(() => page.library.openPlanes('2d/photo', { first: 0, last: 0 }));
  assert.equal(photo.code, 'LIBRARY_FORMAT_UNSUPPORTED'); assert.equal(photo.needsViewer, false);
  console.log('openPlanes: mapping, shapes, mounted bricks at level 1, refusals: OK');
}

// ── openPlanes: the table of other datasets ─────────────────────────────────────────
{
  const { page, log } = makeEnv({ format: 6, mountedId: null });
  const s = await page.library.openPlanes('3d/other6', { first: 2, last: 4 });
  assert.equal(s.backend(), 'planes');
  assert.equal(log.planeOpens[0].base, 'DATA_WEB/3d/other6/planes');
  assert.deepEqual(log.planeOpens[0].options.dimensions, DIMS0);
  assert.equal(log.planeOpens[0].options.sourceManifestUrl, 'DATA_WEB/3d/other6/bricks/manifest.json');
  const b = await s.readBlock({ y0: 0, y1: 2, z0: 0, z1: 3, channels: [0] });
  assert.equal(b.data[0][70 + 3], volume(0, 0, 0)(3, 1, 2));
  await s.readBlock({ y0: 0, y1: 2, z0: 0, z1: 3, channels: [0] });
  assert.equal(log.planeOpens.length, 1, 'a planes tree is opened once per (dataset, frame) and kept');
  // level ≥ 1 of a format 5/6 tree: the cut bricks of the planes' layers
  const lv = await page.library.openPlanes('3d/other6', { first: 8, last: 12, level: 1 });
  assert.equal(lv.backend(), 'cuts');
  const cut = await lv.readBlock({ y0: 4, y1: 9, z0: 0, z1: lv.depth, channels: [1] });
  const v1 = volume(1, 1, 0);
  for (const [i, z] of lv.indices.entries()) for (const [r, y] of [[0, 4], [3, 7]]) assert.equal(cut.data[0][(i * 5 + r) * 35 + 30], v1(30, y, z), `plane ${z} row ${y}`);
  assert.ok(log.cutCalls.length > 0 && log.cutCalls.every(c => c.level === 1 && c.bz === 8));
  assert.ok(log.cutCalls.length <= Math.ceil(lv.depth / 8) + 1, `${log.cutCalls.length} cut calls for ${lv.depth} planes of one channel`);
  // every plane of a layer comes out of the SAME cut bricks: one call per (layer, channel) of a block, not per plane
  const wide = await page.library.openPlanes('3d/other6', { first: 0, last: 40, level: 1 });
  assert.equal(wide.backend(), 'cuts');
  assert.equal(wide.bandRows, 64, 'a band covers the whole level');
  log.cutCalls.length = 0;
  const wb = await wide.readBlock({ y0: 0, y1: wide.height, z0: 0, z1: wide.depth, channels: [0, 1, 2] });
  assert.ok(log.cutCalls.length <= (Math.ceil(wide.depth / 8) + 1) * 3, `${log.cutCalls.length} cut calls for ${wide.depth} planes × 3 channels`);
  const vw = volume(1, 2, 0);
  for (const [i, z] of wide.indices.entries()) assert.equal(wb.data[2][(i * wide.height + 9) * wide.width + 11], vw(11, 9, z), `plane ${z}`);
  assert.equal((await page.library.describe('3d/other6')).z.backends[1], 'cuts');
  assert.equal((await page.library.describe('3d/other6')).z.backends[0], 'planes');
  // formats 2–4: level 0 only, otherwise "open it in the viewer"
  const s2 = await page.library.openPlanes('3d/other2', { first: 0, last: 1 });
  assert.equal(s2.backend(), 'planes');
  const lvl = await code(() => page.library.openPlanes('3d/other2', { first: 0, last: 1, level: 1 }));
  assert.deepEqual([lvl.code, lvl.needsViewer, lvl.datasetId], ['LIBRARY_LEVEL_UNSUPPORTED', true, '3d/other2']);
  const f1 = await code(() => page.library.openPlanes('3d/other1', { first: 0, last: 1 }));
  assert.deepEqual([f1.code, f1.needsViewer], ['LIBRARY_FORMAT_UNSUPPORTED', true]);
  // a manifest that is not valid is never read
  const bm = makeEnv({ format: 6, mountedId: null, badManifestFor: '3d/badmanifest' });
  const err = await code(() => bm.page.library.describe('3d/badmanifest'));
  assert.equal(err.code, 'LIBRARY_BAD_MANIFEST');
  assert.equal(bm.log.planeOpens.length, 0);
  // a failed planes tree falls to the cut bricks on a format 6 tree
  console.log('openPlanes: other datasets per the table: OK');
}

// ── a pinned mount that is gone, release ────────────────────────────────────────────
{
  const { page, handles } = makeEnv({ format: 5 });
  const s = await page.library.openPlanes('3d/mount', { first: 0, last: 2 });
  s.assertFrame();
  handles[0].alive = false;
  assert.throws(() => s.assertFrame(), (e) => e.code === 'LIBRARY_SOURCE_LOST' && e.datasetId === '3d/mount');
  const lost = await code(() => s.readBlock({ y0: 0, y1: 1, z0: 0, z1: 1 }));
  assert.equal(lost.code, 'LIBRARY_SOURCE_LOST');
  const t = makeEnv({ format: 5 });
  const s2 = await t.page.library.openPlanes('3d/mount', { first: 0, last: 2 });
  s2.release(); s2.release();
  assert.equal((await code(() => s2.readBlock({ y0: 0, y1: 1, z0: 0, z1: 1 }))).code, 'LIBRARY_RELEASED');
  assert.throws(() => s2.assertFrame(), (e) => e.code === 'LIBRARY_RELEASED');
  const s3 = await t.page.library.openPlanes('3d/mount', { first: 0, last: 2 });
  t.page.library.release('3d/mount');
  t.page.library.release('3d/mount');
  assert.equal((await code(() => s3.readBlock({ y0: 0, y1: 1, z0: 0, z1: 1 }))).code, 'LIBRARY_RELEASED', 'release(id) ends the dataset\'s sessions');
  assert.equal(t.page.state.trees.size, 0);
  assert.equal(t.page.state.sessions.size, 0);
  const ac = new AbortController();
  const s4 = await t.page.library.openPlanes('3d/mount', { first: 0, last: 2, signal: ac.signal });
  ac.abort();
  assert.equal((await code(() => s4.readBlock({ y0: 0, y1: 1, z0: 0, z1: 1 }))).code, 'LIBRARY_RELEASED');
  const pre = new AbortController(); pre.abort();
  assert.equal((await code(() => t.page.library.describe('3d/mount', { signal: pre.signal }))).name, 'AbortError');
  console.log('openPlanes: source lost, release idempotent, abort: OK');
}

// ── openOblique ─────────────────────────────────────────────────────────────────────
const SPECS = [
  { yaw: 25, pitch: -18, roll: 7, depth: 0.55, thickness: 1, projection: 'single' },
  { yaw: -40, pitch: 33, roll: 90, depth: 0.45, thickness: 5, projection: 'mean' },
  { yaw: 10, pitch: 5, roll: 0, depth: 0.5, thickness: 4, projection: 'max' },
  { yaw: 0, pitch: 0, roll: 0, depth: 0.3, thickness: 1, projection: 'single' }
];

async function picture(session, c, pageEnv, opts = {}) {
  const acc = IJOblique.create(session.geometry, { channel: c, outBitDepth: 8 });
  const seen = [];
  const res = await session.run({ channels: [c], onBrick: async (b) => { seen.push(b); acc.add(b); if (opts.delay) await new Promise(r => setTimeout(r, opts.delay)); }, signal: opts.signal });
  return { acc, seen, res };
}

for (const scenario of [
  { name: 'mounted format 5 (cut bricks)', env: { format: 5 }, id: '3d/mount', level: 0, t: 0 },
  { name: 'mounted format 6, level 1', env: { format: 6 }, id: '3d/mount', level: 1, t: 0 },
  { name: 'mounted format 4 (v3 bricks, 1-voxel border)', env: { format: 4 }, id: '3d/mount', level: 0, t: 0 },
  { name: 'mounted format 2 (v2 bricks)', env: { format: 2 }, id: '3d/mount', level: 1, t: 0 },
  { name: 'mounted timelapse, a frame that is not displayed', env: { format: 5, mountedId: 'live/tl', live: true, shownTimepoint: 0 }, id: 'live/tl', level: 0, t: 2 },
  { name: 'another dataset (format 6)', env: { format: 6, mountedId: null }, id: '3d/other6', level: 0, t: 0 },
  { name: 'another timelapse (format 6), frame 1', env: { format: 6, mountedId: null }, id: 'live/tl6', level: 1, t: 1 }
]) {
  for (const [si, spec] of SPECS.entries()) {
    if (scenario.level === 1 && si > 1) continue;
    const E = makeEnv(scenario.env);
    const opts = { spec, level: scenario.level };
    if (scenario.id.startsWith('live')) opts.timepoint = scenario.t;
    const session = await E.page.library.openOblique(scenario.id, opts);
    assert.equal(session.level, scenario.level);
    assert.equal(session.channels, CHANNELS);
    assert.ok(session.width > 0 && session.height > 0 && session.geometry.width === session.width);
    assert.ok(session.estimateBytes() > 0);
    const dims = dimsOf(scenario.level);
    assert.deepEqual(session.geometry.dims, dims);
    const volFor = (c) => volume(scenario.level, c, scenario.t);
    const packs = [];
    for (let c = 0; c < CHANNELS; c++) {
      const { acc, seen, res } = await picture(session, c, E);
      const want = IJOblique.reference(session.geometry, volFor(c));
      assert.deepEqual(Array.from(acc.finish()), Array.from(want), `${scenario.name} spec ${si} channel ${c}`);
      assert.equal(res.failed.length, 0);
      assert.ok(res.delivered === seen.length && seen.every(b => b.channel === c));
      assert.ok(res.delivered > 0);
      // every delivered brick is cut to its box (border stripped): x fastest, then y, then z
      for (const b of seen.slice(0, 6)) {
        const w = b.box.x1 - b.box.x0, h = b.box.y1 - b.box.y0, d = b.box.z1 - b.box.z0;
        assert.equal(b.data.length, w * h * d, 'the data fills exactly its box');
        const v = volFor(c);
        assert.equal(b.data[((d - 1) * h + (h - 1)) * w + (w - 1)], v(b.box.x1 - 1, b.box.y1 - 1, b.box.z1 - 1));
        assert.equal(b.data[0], v(b.box.x0, b.box.y0, b.box.z0));
      }
      packs.push(res);
    }
    // absent (ESS) bricks are reported `empty`, never `failed`
    if (scenario.level === 0 && packs[0].empty.length) assert.ok(packs[0].empty.every(b => b.x0 >= 64));
    if (scenario.env.format >= 5 || scenario.env.mountedId === null) assert.ok(E.log.cutOpens >= CHANNELS, 'a CutStore per run');
    if (scenario.env.mountedId === 'live/tl') {
      assert.ok(E.log.pins.includes('DATA_WEB/live/tl/bricks/t002'), 'the frame\'s own tree is pinned');
      assert.equal(E.log.cutCalls[0].base, 'DATA_WEB/live/tl/bricks/t002');
    }
    if (scenario.env.mountedId === null) assert.equal(E.log.pins.length, 0);
  }
  console.log(`openOblique: ${scenario.name}: OK`);
}

// G is the slicer's own mapping, and the bricks asked for are the native pass's
{
  const E = makeEnv({ format: 5 });
  for (const spec of SPECS) {
    const session = await E.page.library.openOblique('3d/mount', { spec, level: 0 });
    const G = session.geometry;
    const slicerSpec = E.page.slicerSpec(spec, { id: '3d/mount' });
    const raw = Slicer.planeGeometry(slicerSpec, PHYSICAL, null);
    const R = E.page.renderSize(slicerSpec, DIMS0, 2 * raw.extent);
    const crop = Ops.cropRect(Ops.plainGeometry(raw), R, null);
    assert.equal(G.width, crop.x2 - crop.x + 1);
    assert.equal(G.height, crop.y2 - crop.y + 1);
    // the shader: pc = ((X + ½)/R − ½, ½ − (Y + ½)/R)·2E, t = origin + ½ + pc.x·right + pc.y·up + (s − (N−1)/2)·δ·step
    for (const [px, py, s] of [[0, 0, 0], [G.width - 1, 0, 0], [3, G.height - 1, G.steps - 1], [Math.floor(G.width / 2), Math.floor(G.height / 2), Math.floor(G.steps / 2)]]) {
      const X = crop.x + px, Y = crop.y + py;
      const pcx = ((X + 0.5) / R - 0.5) * 2 * raw.extent, pcy = (0.5 - (Y + 0.5) / R) * 2 * raw.extent;
      for (const [k, key] of [[0, 'x'], [1, 'y'], [2, 'z']]) {
        const want = raw.origin[key] + 0.5 + pcx * raw.right[key] + pcy * raw.up[key] + (s - (raw.steps - 1) / 2) * raw.delta * raw.step[key];
        const got = G.o[k] + (px + 0.5) * G.a[k] + (py + 0.5) * G.b[k] + (s - (G.steps - 1) / 2) * G.c[k];
        assert.ok(Math.abs(got - want) < 1e-9, `t_${key} at (${px}, ${py}, ${s}): ${got} vs ${want}`);
      }
    }
    assert.equal(G.projected, spec.projection !== 'single');
    assert.equal(G.projMode, spec.projection === 'single' ? null : spec.projection);
    assert.ok(Math.abs(session.pixelUm.x - (2 * raw.extent * Math.max(PHYSICAL.x, PHYSICAL.y, PHYSICAL.z)) / R) < 1e-12);
    // the cut bricks it reads = _cutBricksForSpec over _nativeSliceBricksForSpec, both with the options argument
    const bricks = E.page.bricksFor(slicerSpec, DIMS0, 0, { physical: PHYSICAL, space: null, activeBricks: E.BrickLoader.activeBricks(0) });
    const wantKeys = new Set(E.page.cutsFor(slicerSpec, DIMS0, bricks, 8, { physical: PHYSICAL, space: null }).map(b => `${b.cx}_${b.cy}_${b.cz}`));
    E.log.cutCalls.length = 0;
    await session.run({ channels: [1], onBrick: async () => {} });
    const asked = new Set(E.log.cutCalls.flatMap(c => c.keys));
    assert.deepEqual([...asked].sort(), [...wantKeys].sort());
    assert.ok(E.log.cutCalls.every(c => c.c === 1));
    assert.equal(E.log.cutCalls.length, 1, 'whole 8³ records per call: this plane is one call, not one per 64 cut bricks');
  }
  // another dataset: EVERY brick of the slab box is a candidate (the store skips what it does not hold)
  const O = makeEnv({ format: 6, mountedId: null });
  const so = await O.page.library.openOblique('3d/other6', { spec: SPECS[1], level: 0 });
  const bricksAll = O.page.bricksFor(O.page.slicerSpec(SPECS[1], {}), DIMS0, 0, { physical: PHYSICAL, space: null, activeBricks: [{ bx: 0, by: 0, bz: 0 }, { bx: 1, by: 0, bz: 0 }] });
  assert.equal(bricksAll.length, 2, 'the absent brick (1, 0, 0) is a candidate when the tree is not mounted');
  await so.run({ channels: [0], onBrick: async () => {} });
  assert.ok(O.log.cutCalls.flatMap(c => c.keys).some(k => Number(k.split('_')[0]) >= 2), 'cut bricks of the absent brick were asked for');
  // the figure path's defaults are untouched: no options argument reads the mounted state
  const mountedBricks = O.BrickLoader.activeBricks(0);
  assert.deepEqual(O.page.bricksFor(O.page.slicerSpec(SPECS[0], {}), DIMS0, 0),
    O.page.bricksFor(O.page.slicerSpec(SPECS[0], {}), DIMS0, 0, { activeBricks: mountedBricks }), 'without the options argument the mounted bricks and physical size are read');
  console.log('openOblique: G = the slicer\'s mapping; bricks = the native pass\'s: OK');
}

// ── failed vs empty, backpressure, retries ─────────────────────────────────────────
{
  // bricks path: a failed brick is listed, a brick the packer dropped is `empty`
  const E = makeEnv({ format: 4, failBrick: { bx: 0, by: 0, bz: 0 } });
  const s = await E.page.library.openOblique('3d/mount', { spec: { yaw: 0, pitch: 0, roll: 0, depth: 0.5, thickness: 1, projection: 'single' }, level: 0 });
  const res = await s.run({ channels: [0], onBrick: async () => {} });
  assert.ok(res.failed.length === 1 && res.failed[0].channel === 0 && res.failed[0].x0 === 0 && res.failed[0].x1 === 64, JSON.stringify(res.failed));
  assert.equal(res.empty.length, 0, 'the dropped brick is not a candidate on a mounted tree (activeBricks omits it)');
  // cut path: a cut read that throws twice fails its chunk's undelivered bricks
  const F = makeEnv({ format: 5, failCut: '0_0_1' });
  const sf = await F.page.library.openOblique('3d/mount', { spec: SPECS[3], level: 0 });
  const rf = await sf.run({ channels: [2], onBrick: async () => {} });
  assert.ok(rf.failed.length > 0 && rf.failed.every(b => b.channel === 2));
  assert.ok(F.log.cutCalls.filter(c => c.keys.includes('0_0_1')).length >= 2, 'a failed cut read is tried twice');
  // empty: cut bricks of the dropped brick on another dataset
  const O = makeEnv({ format: 6, mountedId: null });
  const so = await O.page.library.openOblique('3d/other6', { spec: SPECS[3], level: 0 });
  const ro = await so.run({ channels: [0], onBrick: async () => {} });
  assert.ok(ro.empty.length > 0 && ro.empty.every(b => b.x0 >= 64 && b.channel === 0), 'ESS cut bricks are empty, not failed');
  assert.equal(ro.failed.length, 0);
  // backpressure: bricks of one channel are asked ≤ 8 at a time and handed over one at a time
  const B = makeEnv({ format: 2 });
  const sb = await B.page.library.openOblique('3d/mount', { spec: { yaw: 0, pitch: 40, roll: 0, depth: 0.5, thickness: 1, projection: 'single' }, level: 0 });
  let open = 0, peak = 0, total = 0;
  const rb = await sb.run({ channels: [0, 1], onBrick: async () => { open++; peak = Math.max(peak, open); total++; await new Promise(r => setTimeout(r, 1)); open--; } });
  assert.equal(peak, 1, 'run awaits each onBrick');
  assert.ok(B.log.maxBatch <= 64, `a batch of ${B.log.maxBatch} bricks`);
  assert.ok(B.log.brickBatches.length <= 2 * 2, `${B.log.brickBatches.length} batches for ${total} bricks over 2 channels (one 4×4×4 pack each)`);
  assert.ok(B.log.brickBatches.every(b => b.mount === 'DATA_WEB/3d/mount/bricks' && b.group === 'studio-library' && b.cancelPrevious === false && b.byteRanges === true));
  assert.equal(rb.delivered, total);
  // an abort ends the run with AbortError and frees the gate for the next run
  const ac = new AbortController();
  const C = makeEnv({ format: 5 });
  const sc = await C.page.library.openOblique('3d/mount', { spec: SPECS[1], level: 0 });
  const err = await code(() => sc.run({ channels: [0], signal: ac.signal, onBrick: async () => { ac.abort(); } }));
  assert.equal(err.name, 'AbortError');
  const again = await sc.run({ channels: [0], onBrick: async () => {} });
  assert.ok(again.delivered > 0, 'the library\'s read stream was given back');
  // the library runs one read stream at a time
  let live = 0, maxLive = 0;
  const slow = async () => { live++; maxLive = Math.max(maxLive, live); await new Promise(r => setTimeout(r, 2)); live--; };
  const s1 = await C.page.library.openOblique('3d/mount', { spec: SPECS[3], level: 0 });
  const s2 = await C.page.library.openOblique('3d/mount', { spec: SPECS[2], level: 0 });
  await Promise.all([s1.run({ channels: [0], onBrick: slow }), s2.run({ channels: [0], onBrick: slow })]);
  assert.equal(maxLive, 1);
  // bad requests
  assert.equal((await code(() => C.page.library.openOblique('3d/mount', { spec: { depth: 3 } }))).code, 'LIBRARY_BAD_ARGS');
  assert.equal((await code(() => s1.run({ channels: [9], onBrick: slow }))).code, 'LIBRARY_BAD_ARGS');
  assert.equal((await code(() => s1.run({ channels: [0] }))).code, 'LIBRARY_BAD_ARGS');
  s1.release();
  assert.equal((await code(() => s1.run({ channels: [0], onBrick: slow }))).code, 'LIBRARY_RELEASED');
  const miss = await code(() => C.page.library.openOblique('3d/mount', { spec: { yaw: 0, pitch: 0, roll: 0, depth: 0, thickness: 1, projection: 'single' }, level: 0 }));
  assert.equal(miss, null, 'a plane at the volume\'s face still meets it');
  console.log('openOblique: failed vs empty, backpressure, gate, aborts: OK');
}

// ── openOblique refusals ────────────────────────────────────────────────────────────
{
  const E = makeEnv({ format: 6, mountedId: null });
  const spec = SPECS[0];
  const o2 = await code(() => E.page.library.openOblique('3d/other2', { spec }));
  assert.deepEqual([o2.code, o2.needsViewer, o2.datasetId], ['LIBRARY_OBLIQUE_UNSUPPORTED', true, '3d/other2']);
  const o1 = await code(() => E.page.library.openOblique('3d/other1', { spec }));
  assert.deepEqual([o1.code, o1.needsViewer], ['LIBRARY_OBLIQUE_UNSUPPORTED', true]);
  const ph = await code(() => E.page.library.openOblique('2d/photo', { spec }));
  assert.equal(ph.code, 'LIBRARY_OBLIQUE_UNSUPPORTED');
  assert.equal((await code(() => E.page.library.openOblique('3d/other6', { spec, level: 9 }))).code, 'LIBRARY_LEVEL_UNSUPPORTED');
  assert.equal((await code(() => E.page.library.openOblique('3d/missing', { spec }))).code, 'LIBRARY_UNKNOWN');
  const mf = makeEnv({ format: 6, mountedId: null });
  mf.catalog.push({ id: '3d/missing', type: '3d', name: 'Missing manifest', formatVersion: 6, dimensions: { ...DIMS0, c: 3, t: 1 } });
  const gone = await code(() => mf.page.library.openOblique('3d/missing', { spec }));
  assert.equal(gone.code, 'LIBRARY_BAD_MANIFEST');
  console.log('openOblique: refusals and needsViewer: OK');
}

// ── tiffIndex ───────────────────────────────────────────────────────────────────────
{
  const ok = makeEnv({ format: 5, tiffIndexMode: 'ok' });
  const doc = await ok.page.library.tiffIndex('3d/mount', 'My Stack.tif');
  assert.equal(doc.url, 'http://localhost:8080/DATA_WEB/3d/mount/download/My%20Stack.tif', 'absolute, each segment percent-encoded');
  assert.equal(doc.urlRelative, 'DATA_WEB/3d/mount/download/My Stack.tif');
  assert.deepEqual(ok.log.fetches.filter(u => u.startsWith('api/tiff-index')), ['api/tiff-index?dataset=3d%2Fmount&file=My%20Stack.tif']);
  const php = makeEnv({ format: 5, tiffIndexMode: 'ok-php' });
  const d2 = await php.page.library.tiffIndex('3d/mount', 'My Stack.tif');
  assert.equal(d2.pages, 3);
  assert.deepEqual(php.log.fetches.filter(u => u.startsWith('api/tiff-index')).map(u => u.split('?')[0]), ['api/tiff-index', 'api/tiff-index.php'], 'the .php route answers when the extensionless one is a 404');
  const h403 = makeEnv({ format: 5, tiffIndexMode: 'html403' });
  assert.equal((await h403.page.library.tiffIndex('3d/mount', 'My Stack.tif')).pages, 3, 'an HTML 403 of the extensionless route falls to the .php route');
  assert.deepEqual(h403.log.fetches.filter(u => u.startsWith('api/tiff-index')).map(u => u.split('?')[0]), ['api/tiff-index', 'api/tiff-index.php']);
  const miss = await code(() => makeEnv({ format: 5, tiffIndexMode: 'missing' }).page.library.tiffIndex('3d/mount', 'x.tif'));
  assert.deepEqual([miss.code, miss.status, miss.serverCode, miss.datasetId], ['LIBRARY_TIFF_INDEX', 404, 'not_found', '3d/mount']);
  const bad = await code(() => makeEnv({ format: 5, tiffIndexMode: '422' }).page.library.tiffIndex('3d/mount', 'x.tif'));
  assert.deepEqual([bad.code, bad.status, bad.serverCode], ['LIBRARY_TIFF_INDEX', 422, 'malformed']);
  const schema = await code(() => makeEnv({ format: 5, tiffIndexMode: 'badschema' }).page.library.tiffIndex('3d/mount', 'x.tif'));
  assert.equal(schema.code, 'LIBRARY_TIFF_INDEX');
  assert.equal((await code(() => ok.page.library.tiffIndex('nope', 'x.tif'))).code, 'LIBRARY_UNKNOWN');
  console.log('tiffIndex: OK');
}

// ── preview, viewerUrl ──────────────────────────────────────────────────────────────
{
  const E = makeEnv({ format: 5 });
  const bmp = await E.page.library.preview('3d/mount', { z: 10 }, { size: 256 });
  assert.equal(bmp.bitmap, true);
  assert.equal(bmp.canvas.size, 256);
  assert.equal(bmp.canvas.spec.mode, 'xy');
  assert.ok(Math.abs(bmp.canvas.spec.value - 10.5 / 41) < 1e-12);
  const ob = await E.page.library.preview('3d/mount', { spec: SPECS[1] }, {});
  assert.equal(ob.canvas.spec.mode, 'oblique');
  assert.equal(await E.page.library.preview('3d/other6', { z: 1 }, {}), null, 'another dataset has no cheap preview');
  assert.equal(await E.page.library.preview('3d/mount', { z: 99 }, {}), null);
  const live = makeEnv({ format: 5, mountedId: 'live/tl', live: true, shownTimepoint: 0 });
  assert.equal(await live.page.library.preview('live/tl', { z: 1 }, { timepoint: 2 }), null, 'a frame that is not on screen');
  assert.ok(await live.page.library.preview('live/tl', { z: 1 }, { timepoint: 0 }));
  assert.equal(E.page.library.viewerUrl('3d/mount'), 'viewer.html?id=3d%2Fmount');
  assert.equal(E.page.library.viewerUrl('2d/photo'), '2d.html?id=2d%2Fphoto');
  assert.equal((() => { try { E.page.library.viewerUrl('x/y'); } catch (e) { return e.code; } })(), 'LIBRARY_UNKNOWN');
  console.log('preview, viewerUrl: OK');
}

// ── the tree cache: ≤ 4 frames per dataset, a stale pin is rebuilt once ──────────────
{
  const E = makeEnv({ format: 6, mountedId: null });
  for (let t = 0; t < 10; t++) await E.page.library.describe('live/tl6', { timepoint: t });
  const kept = [...E.page.state.trees.keys()].filter(k => k.startsWith('live/tl6|'));
  assert.equal(kept.length, 4, 'at most 4 trees are retained per dataset');
  assert.deepEqual(kept, ['live/tl6|6', 'live/tl6|7', 'live/tl6|8', 'live/tl6|9'], 'the least recently used went first');
  E.page.library.release('live/tl6');
  assert.equal([...E.page.state.trees.keys()].filter(k => k.startsWith('live/tl6|')).length, 0);
  // an entry of a mounted dataset whose pin died is read again, once
  const M = makeEnv({ format: 5 });
  await M.page.library.describe('3d/mount');
  M.handles[0].alive = false;
  const again = await M.page.library.describe('3d/mount');
  assert.equal(again.mounted, true);
  assert.equal(M.log.pins.length, 2, 'the tree was pinned again');
  console.log('tree cache: OK');
}

// ── a v2 'vertical' tree hands back whole bricks: cropped here, never reported failed ──
{
  packingMode = 'vertical';
  try {
    const E = makeEnv({ format: 2 });
    const s = await E.page.library.openOblique('3d/mount', { spec: { yaw: 0, pitch: 40, roll: 0, depth: 0.5, thickness: 1, projection: 'single' }, level: 0 });
    const seen = [];
    const res = await s.run({ channels: [0], onBrick: async (b) => { seen.push(b); } });
    assert.equal(res.failed.length, 0, JSON.stringify(res.failed));
    assert.ok(seen.length > 0 && seen.every(b => b.data.length === (b.box.x1 - b.box.x0) * (b.box.y1 - b.box.y0) * (b.box.z1 - b.box.z0)));
    const v = volume(0, 0, 0);
    for (const b of seen) assert.equal(b.data[0], v(b.box.x0, b.box.y0, b.box.z0));
    assert.ok(E.log.brickBatches.length > 0);
  } finally { packingMode = 'grid'; }
  console.log('v2 vertical packing: OK');
}

console.log('Studio library (viewer.js): OK');
