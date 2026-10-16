// A bricked dataset never requests slice-stack files (preview/slices/…, slices/…).
// It has none: every such URL is a 404, and a timelapse fired hundreds of them per
// timepoint (the adjacent-frame preloader fell back to the slice path whenever the
// brick manifest had not landed yet, e.g. while the "Open the saved view" prompt of a
// #state= link waited). On a shared host the burst gets the visitor's IP banned.
//   • VolumeSourceManager.hasSliceStack decides from the declared sources;
//   • viewer.js _scheduleAdjacentPreload: bricked + no manifest yet → nothing at all,
//     bricked + manifest → pack prefetch, slice-stack dataset → slice preload;
//   • viewer.js _loadVolumeForQuality: a failed brick stream is not retried as slices
//     on a bricked dataset, still is on a slice-stack one;
//   • VolumeViewer.preloadVolume / loadVolume refuse a bricked dataset outright.
//
// Run: node tests/js/test_bricked_no_slice_requests.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT, loadModule } from './harness.mjs';

const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const viewerSrc = read('js/pages/viewer.js');
const volumeSrc = read('js/viewers/volume-viewer.js');

function lift(src, name) {
  const m = src.match(new RegExp(`\\n  (?:async )?function ${name}\\([^\\n]*\\) \\{\\n[\\s\\S]*?\\n  \\}\\n`));
  assert.ok(m, `${name} must be defined at module level`);
  return m[0];
}

const VolumeSourceManager = loadModule('js/core/volume-source-manager.js', 'VolumeSourceManager', {});
const quiet = { ...console, warn: () => {} };

const BRICKED = {
  type: 'live',
  path: 'live/ds',
  dimensions: { x: 512, y: 512, z: 120, c: 2, t: 30 },
  volumeSources: [{ kind: 'bricks', available: true, multiscale: true, path: 'DATA_WEB/live/ds' }]
};
const SLICED = {
  type: 'live',
  path: 'live/old',
  dimensions: { x: 512, y: 512, z: 120, c: 2, t: 30 },
  volumeSources: [{ kind: 'webstack', available: true, path: 'DATA_WEB/live/old' }]
};

// ── 1. The rule ─────────────────────────────────────────────────────────────────
{
  assert.equal(VolumeSourceManager.hasSliceStack(BRICKED), false, 'bricks only: no slice stack');
  assert.equal(VolumeSourceManager.hasSliceStack(SLICED), true, 'a webstack source: slices');
  assert.equal(VolumeSourceManager.hasSliceStack({ path: 'live/legacy' }), true,
    'nothing declared: a legacy slice-stack dataset');
  assert.equal(VolumeSourceManager.hasSliceStack({
    volumeSources: [{ kind: 'webstack', available: false }, { kind: 'bricks' }]
  }), false, 'an unavailable webstack is no slice stack');
  assert.equal(VolumeSourceManager.hasSliceStack({
    volumeSources: [{ kind: 'bricks' }, { kind: 'webstack' }]
  }), true, 'both kinds: the slices exist');
  console.log('hasSliceStack follows the declared sources: OK');
}

// ── 2. The adjacent-frame preloader ─────────────────────────────────────────────
{
  const run = ({ meta, manifest }) => {
    const log = { slicePreloads: [], packPrefetches: [], idle: 0 };
    const ctx = vm.createContext({ console: quiet, env: { meta, manifest, log }, VolumeSourceManager });
    vm.runInContext(`
      let isLive = true, _isIframe = false, _qualityMode = '512x512';
      let _preloadTimer = null, _preloadIdle = false;
      let _preloadedTimepoints = new Set(), loadedTimepoints = new Set([0]);
      let datasetMeta = env.meta, _brickManifest = env.manifest;
      const window = { requestIdleCallback: (cb) => { env.log.idle++; cb(); return 1; } };
      const VolumeViewer = {
        preloadVolume: (base, meta, frame) => { env.log.slicePreloads.push(frame); return Promise.resolve({ successfulLoads: 0 }); }
      };
      const BrickLoader = {
        prefetchPacks: (url) => { env.log.packPrefetches.push(url); return Promise.resolve(); }
      };
      function _lodForQuality() { return 1; }
      function _v3TimepointManifest() { return null; }
      function _setQualityStatus() {}
      function _tf(k, f) { return f; }
      function _qualityLabel(q) { return q; }
      ${lift(viewerSrc, '_cancelAdjacentPreload')}
      ${lift(viewerSrc, '_hasSliceStack')}
      ${lift(viewerSrc, '_scheduleAdjacentPreload')}
      globalThis.schedule = _scheduleAdjacentPreload;
    `, ctx);
    ctx.schedule('DATA_WEB/live/ds', 0);
    return log;
  };

  // The #state= prompt case: the first frame is not in yet, the manifest is unknown.
  let log = run({ meta: BRICKED, manifest: null });
  assert.equal(log.slicePreloads.length, 0, 'a bricked dataset without its manifest preloads no slices');
  assert.equal(log.packPrefetches.length, 0, 'nor anything else');
  assert.equal(log.idle, 0, 'no warm-up is even scheduled');

  // Same with a manifest that has no per-timepoint rows (failed / unexpected shape).
  log = run({ meta: BRICKED, manifest: { levels: [] } });
  assert.equal(log.slicePreloads.length, 0, 'a manifest without timepoint rows preloads no slices');

  const rows = { t001: { path: 't001', brickTransport: { levels: [] } }, t002: { path: 't002', brickTransport: { levels: [] } } };
  log = run({ meta: BRICKED, manifest: { timepoints: rows } });
  assert.equal(log.slicePreloads.length, 0, 'with the manifest: still no slices');
  assert.deepEqual([...log.packPrefetches].sort(),
    ['DATA_WEB/live/ds/bricks/t001', 'DATA_WEB/live/ds/bricks/t002'], 'the adjacent frames\' packs are warmed');

  log = run({ meta: SLICED, manifest: null });
  assert.deepEqual([...log.slicePreloads].sort(), [1, 2], 'a slice-stack dataset still preloads its slices');
  console.log('adjacent-frame preload never builds slice URLs for a bricked dataset: OK');
}

// ── 3. The display load's fallback ──────────────────────────────────────────────
{
  const run = async (meta) => {
    const log = { sliceLoads: 0 };
    const ctx = vm.createContext({ console: quiet, env: { log }, VolumeSourceManager });
    vm.runInContext(`
      let _qualityMode = '512x512';
      const VolumeViewer = {
        setQualityTarget() {},
        loadBrickedVolumeStream: async () => ({ available: false, reason: 'budget' }),
        loadVolume: async () => { env.log.sliceLoads++; return { available: true }; }
      };
      ${lift(viewerSrc, '_hasSliceStack')}
      ${lift(viewerSrc, '_loadVolumeForQuality')}
      globalThis.load = _loadVolumeForQuality;
    `, ctx);
    const result = await ctx.load('DATA_WEB/live/ds', meta, 0, '512x512', null);
    return { result, log };
  };

  let { result, log } = await run(BRICKED);
  assert.equal(log.sliceLoads, 0, 'a failed brick stream is not retried as slices on a bricked dataset');
  assert.equal(result.available, false, 'the stream\'s own failure is returned');
  assert.equal(result.reason, 'budget');

  ({ result, log } = await run(SLICED));
  assert.equal(log.sliceLoads, 1, 'a slice-stack dataset still falls back to its slices');
  console.log('display load: no slice fallback on a bricked dataset: OK');
}

// ── 4. VolumeViewer refuses outright ────────────────────────────────────────────
{
  const run = async (meta) => {
    const log = { fetched: [], loads: 0 };
    const ctx = vm.createContext({ console: quiet, env: { log }, VolumeSourceManager });
    vm.runInContext(`
      const PRELOAD_IMAGE_LOADS = 4;
      const _sliceLoads = new Set();
      let _lastDisplayRequest = null;
      function _resolveQuality() { return { directory: 'preview/slices', maxDepthSamples: 4 }; }
      function _buildSampleIndices(n, k) { return Array.from({ length: Math.min(n, k) }, (_, i) => i); }
      function _sliceStamp() { return ''; }
      function _sliceUrl(base, q, live, t, z, c) { return base + '/' + q.directory + '/t' + t + '_z' + z + '_c' + c + '.webp'; }
      function _sampleArray(a) { return a; }
      async function _runLimited(items, n, fn) { for (const it of items) await fn(it); }
      async function _prefetchSliceFile(url) { env.log.fetched.push(url); }
      async function _loadSliceVolume() { env.log.loads++; return { available: true }; }
      ${lift(volumeSrc, '_hasSliceStack')}
      ${lift(volumeSrc, 'loadVolume')}
      ${lift(volumeSrc, 'preloadVolume')}
      globalThis.api = { loadVolume, preloadVolume };
    `, ctx);
    const pre = await ctx.api.preloadVolume('DATA_WEB/live/ds', meta, 1, { quality: '256x256' });
    const load = await ctx.api.loadVolume('DATA_WEB/live/ds', meta, 1, null, { quality: '256x256' });
    return { pre, load, log };
  };

  let { pre, load, log } = await run(BRICKED);
  assert.equal(log.fetched.length, 0, 'preloadVolume requests no slice of a bricked dataset');
  assert.equal(pre.requested, 0);
  assert.equal(log.loads, 0, 'loadVolume reads no slice of a bricked dataset');
  assert.equal(load.available, false);
  assert.equal(load.reason, 'no-slice-stack');

  ({ pre, load, log } = await run(SLICED));
  assert.equal(log.fetched.length, 8, 'a slice-stack dataset is preloaded (4 planes × 2 channels)');
  assert.ok(log.fetched.every(u => u.includes('/preview/slices/')));
  assert.equal(log.loads, 1, 'and loaded');
  console.log('VolumeViewer slice loaders refuse a bricked dataset: OK');
}
