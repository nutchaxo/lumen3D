// Unit tests for js/core/panel-resources.js (PanelResources) and for how the Compare host
// and the viewer page use it.
//
// A Compare panel is a whole page: its own VRAM budget, decode workers, pack caches and
// HTTP slots. PanelResources divides ONE machine budget between the panels — pure, so the
// numbers are pinned here, and the wiring is checked on the sources (the pages touch the
// DOM at load).
//
// Run: node tests/js/test_panel_resources.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadModule } from './harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r/g, '');
const MiB = 1024 * 1024;
const GiB = 1024 * MiB;
const PR = loadModule('js/core/panel-resources.js', 'PanelResources');

// ── totalBudget: what the panels may hold together ──
assert.equal(PR.totalBudget([]), PR.GPU_FALLBACK, 'no report → the fixed fallback');
assert.equal(PR.totalBudget(undefined), PR.GPU_FALLBACK);
assert.equal(PR.totalBudget([NaN, 0, -5]), PR.GPU_FALLBACK, 'unusable reports are ignored');
assert.equal(PR.totalBudget([4 * GiB]), Math.floor(4 * GiB * PR.GPU_SHARE), '70 % of what a lone page would allow itself');
assert.equal(PR.totalBudget([4 * GiB, 2 * GiB]), Math.floor(2 * GiB * PR.GPU_SHARE), 'the smallest report wins (one card, the cautious reading)');
assert.equal(PR.totalBudget([64 * GiB]), 6 * GiB, 'capped');
assert.equal(PR.totalBudget([256 * MiB]), 192 * MiB, 'a software renderer keeps a floor, not a gigabyte it does not have');
assert.ok(PR.totalBudget([256 * MiB]) < 1 * GiB);

// ── vramShares ──
{
  const total = 3 * GiB;
  const shares = PR.vramShares([{ key: 'a', bytes: 600 * MiB }, { key: 'b', bytes: 300 * MiB }, { key: 'c', bytes: 100 * MiB }], total);
  let sum = 0;
  for (const [, v] of shares) sum += v;
  assert.ok(sum <= total + 3, `the shares never exceed the total (${sum} <= ${total})`);
  assert.ok(sum >= total - 3, 'and use all of it when the plan fits');
  assert.ok(shares.get('a') >= 600 * MiB * PR.HEADROOM, 'a panel gets its atlas plus the page headroom');
  assert.ok(shares.get('a') > shares.get('b') && shares.get('b') > shares.get('c'), 'bigger atlas, bigger share');
  // The spare is divided evenly: the difference between two shares is the difference of their needs.
  const d = shares.get('a') - shares.get('b');
  assert.ok(Math.abs(d - 300 * MiB * PR.HEADROOM) < 4, 'the spare is split evenly');
}
{
  // A plan that does not fit (manual native on four panels) is squeezed, never starved.
  const total = 1 * GiB;
  const shares = PR.vramShares([1, 2, 3, 4].map(k => ({ key: k, bytes: 900 * MiB })), total);
  let sum = 0;
  for (const [, v] of shares) { sum += v; assert.ok(v >= 128 * MiB, 'every panel keeps a minimum'); }
  assert.ok(sum <= 4 * 128 * MiB + total, 'squeezed to the total (plus the minimum floors)');
  assert.ok(new Set(shares.values()).size === 1, 'equal needs, equal shares');
}
assert.equal(PR.vramShares([], GiB).size, 0, 'no panel, no share');
{
  const s = PR.vramShares([{ key: 'x', bytes: undefined }, { key: 'y', bytes: -4 }], 2 * GiB);
  assert.ok(s.get('x') >= 128 * MiB && s.get('y') >= 128 * MiB, 'a missing price is read as zero, not NaN');
}

// ── loaderSettings ──
{
  const one = PR.loaderSettings(1, 22);
  assert.deepEqual({ ...one }, { decodeWorkers: 8, studioWorkers: 4, concurrentLoads: 24, maxConcurrency: null, packFetchSlots: 4, packCacheBytes: 192 * MiB, rangeCacheBytes: 64 * MiB, prefetchCacheBytes: 32 * MiB },
    'a lone panel keeps the defaults of a lone viewer, and no cap on its batches');
  const four = PR.loaderSettings(4, 8);
  assert.equal(four.decodeWorkers, 1, '7 helper cores over 4 panels: one worker each, never zero');
  assert.equal(four.packFetchSlots, 1, 'four panels share the four pack bodies a host allows: one each');
  assert.equal(four.packCacheBytes, 48 * MiB);
  assert.ok(four.concurrentLoads >= 6, 'a floor keeps a panel able to stream');
  assert.equal(four.maxConcurrency, four.concurrentLoads, 'several panels: the share caps every batch (a volume load asks for 32 of its own)');
  assert.equal(PR.loaderSettings(2, 8).maxConcurrency, 12);
  let last = Infinity;
  for (const n of [1, 2, 3, 4]) {
    const s = PR.loaderSettings(n, 22);
    assert.ok(s.decodeWorkers * n <= 21 || s.decodeWorkers === 1, `${n} panels do not over-subscribe the cores`);
    assert.ok(s.packCacheBytes <= last, 'caches shrink as panels join');
    last = s.packCacheBytes;
  }
  // The defaults divided are the loader's own, not copies: a retune reaches the panels.
  const BL = loadModule('js/core/brick-loader.js', 'BrickLoader', {
    document: { createElement: () => ({ getContext: () => ({}) }) },
    navigator: { hardwareConcurrency: 4 }, performance: { now: () => Date.now() }, window: {},
  });
  assert.deepEqual({ ...PR.loaderSettings(1, 22, BL.DEFAULTS) }, { ...one }, 'BrickLoader.DEFAULTS give the figures pinned above');
  for (const key of Object.keys(PR.LOADER_DEFAULTS)) assert.equal(PR.LOADER_DEFAULTS[key], BL.DEFAULTS[key], `the host-side fallback ${key} matches the loader`);
  const retuned = { concurrentLoads: 40, packFetchSlots: 3, packCacheBytes: 256 * MiB, rangeCacheBytes: 96 * MiB, prefetchCacheBytes: 16 * MiB };
  const lone = PR.loaderSettings(1, 22, retuned);
  assert.equal(lone.packFetchSlots, 3, 'a lone panel takes the retuned slots, not the old 4');
  assert.equal(lone.packCacheBytes, 256 * MiB);
  assert.equal(lone.concurrentLoads, 40);
  assert.equal(lone.prefetchCacheBytes, 16 * MiB);
  const pair = PR.loaderSettings(2, 22, retuned);
  assert.equal(pair.packCacheBytes, 128 * MiB, 'divided from the retuned figure');
  assert.equal(pair.concurrentLoads, 20);
  assert.equal(pair.packFetchSlots, 1);
  const small = PR.loaderSettings(1, 22, { packCacheBytes: 32 * MiB, concurrentLoads: 4 });
  assert.equal(small.packCacheBytes, 32 * MiB, 'a floor never lifts a panel above what a lone page holds');
  assert.equal(small.concurrentLoads, 4);
  assert.equal(small.rangeCacheBytes, 64 * MiB, 'a missing key falls back to the shipped default');
  assert.equal(PR.loaderSettings(0, 0).decodeWorkers, 3, 'nonsense in: one panel, an assumed four cores — a working pool out');
  assert.equal(PR.loaderSettings('3', '12').decodeWorkers, 3);
  // The Studio's plane and cut decode pools (four workers each in a lone page) are divided too.
  assert.equal(four.studioWorkers, 1, 'four panels on 8 cores: one Studio decoder per pool each');
  for (const n of [1, 2, 3, 4]) {
    const s = PR.loaderSettings(n, 8);
    assert.ok(s.studioWorkers >= 1 && s.studioWorkers <= 4);
    assert.ok(s.studioWorkers * n <= 7 || s.studioWorkers === 1, `${n} panels: the Studio pools do not over-subscribe the cores`);
  }
}

// ── the wiring, on the sources ──
const compare = read('js/pages/compare.js');
const viewer = read('js/pages/viewer.js');
const compareHtml = read('compare.html');
const viewerHtml = read('viewer.html');
assert.ok(compareHtml.includes('js/core/panel-resources.js'), 'compare.html loads the module');
assert.ok(compareHtml.indexOf('panel-resources.js') < compareHtml.indexOf('js/pages/compare.js'), '… before compare.js');
assert.ok(viewerHtml.includes('js/core/panel-resources.js'), 'viewer.html loads it too (the panel sizes itself at boot)');
assert.ok(viewerHtml.indexOf('panel-resources.js') < viewerHtml.indexOf('js/pages/viewer.js'), '… before viewer.js');

// The host: the number of volume panels rides on the address, and the shares go out on every change.
assert.ok(/params\.set\('panels'/.test(compare), 'the panel is told how many volume panels share the machine at boot');
assert.ok(/type: 'PANEL_RESOURCES'/.test(compare), 'and again by message when the count or the plan moves');
assert.ok(!/PanelResources\.loaderSettings\(/.test(compare) && !/PANEL_RESOURCES', panels: count, loader/.test(compare),
  'the host sends the count only: the loader is divided in the panel, where its defaults live');
for (const where of ['function _addPanel', 'function _removePanel', 'function _onPanelReady', 'function _drainQualityQueue', 'function _finishQuality']) {
  const at = compare.indexOf(where);
  assert.ok(at > 0, `${where} exists`);
  const body = compare.slice(at, compare.indexOf('\n  }\n', at));
  assert.ok(body.includes('_postResources()'), `${where} re-divides the machine`);
}
assert.ok(/Promise\.resolve\(\)\.then\(_drainLoadQueue\)/.test(compare), 'a burst of additions is queued before the first page starts');
assert.ok(!/SHARED_ATLAS_BUDGET_BYTES,/.test(compare), 'the quality plan no longer spends a constant');

// Under the Studio the panels are display:none, so their pages get no animation frame and
// a volume streaming in one waits: no deadline may run out, no quality step may start there.
assert.ok(compare.includes('function _setDeadline') && /if \(_layoutHidden\) \{ const again = arm\(\)/.test(compare), 'a deadline starts over while the Studio covers the panels');
assert.ok(/_setDeadline\(panel, QUALITY_TIMEOUT_MS/.test(compare) && /_setDeadline\(panel, PANEL_READY_TIMEOUT_MS/.test(compare), 'both the quality step and the load use it');
assert.ok(/!_qualityBusy && _qualityQueue\.length && !_layoutHidden/.test(compare), 'no quality step is ordered under the Studio');
assert.ok(compare.includes("attributeFilter: ['class']") && compare.includes('_notifyFramesResize(); _scheduleQuality();'), 'and the staging resumes when the panels are shown again');

// The page: applies it at boot and on message, reports what it would allow itself, never past it.
assert.ok(viewer.includes("_applyPanelResources({ panels: Number(params.get('panels')) || 1 })"), 'viewer.js sizes itself from ?panels= before its first brick');
assert.ok(viewer.includes("data.type === 'PANEL_RESOURCES'"), 'viewer.js receives PANEL_RESOURCES');
assert.ok(viewer.includes('BrickLoader.DEFAULTS'), "the panel divides its own loader's defaults");
assert.ok(viewer.includes('gpuBudgetBytes: _naturalGpuBudgetBytes()'), 'PANEL_READY reports the page\'s own budget');
assert.ok(viewer.includes('SVRManager.setVramCap(vram)'), "a share caps the page's own budget (never above what it would give itself alone)");
assert.ok(!/SVRManager\.setVramBudget\(/.test(viewer), "a share is not an override: a context loss must still lower a panel's budget");
assert.ok(viewer.includes('SVRManager.vramBudget(VolumeViewer.getRenderer(), { uncapped: true })'), "the budget reported to the host is the page's own, the share left out");
assert.ok(viewer.includes('VolumeViewer.trimCache?.()'), 'a smaller share evicts at once');
assert.ok(viewer.includes('CutStore.configure({ workers: studioWorkers })') && viewer.includes('PlaneLoader.configure({ workers: studioWorkers })'),
  'the share of the cores reaches the Studio decode pools');
assert.ok(/if \(!VolumeViewer\.getRenderer\?\.\(\)\) return null;/.test(viewer), 'the natural budget is not read before the renderer exists (the unknown-card figure would stick)');
assert.ok(read('js/viewers/volume-viewer.js').includes('trimCache: () => _trimVolumeCache(null)'), 'VolumeViewer exposes trimCache');

// A panel's prefetch stays off, and its trust watch is not started without a sandboxed plugin.
assert.ok(/!isLive \|\| _isIframe/.test(viewer), 'no background prefetch in a panel');
assert.ok(read('js/core/plugin-registry.js').includes('![..._modules.keys()].some(sandboxed)'), 'the trust poll needs a sandboxed plugin to be worth a request');

console.log('panel resources: OK');
