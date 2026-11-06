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
  assert.deepEqual({ ...one }, { decodeWorkers: 8, concurrentLoads: 24, packFetchSlots: 4, packCacheBytes: 192 * MiB, rangeCacheBytes: 64 * MiB, prefetchCacheBytes: 32 * MiB },
    'a lone panel keeps the defaults of a lone viewer');
  const four = PR.loaderSettings(4, 8);
  assert.equal(four.decodeWorkers, 1, '7 helper cores over 4 panels: one worker each, never zero');
  assert.equal(four.packFetchSlots, 1, 'four panels share the four pack bodies a host allows: one each');
  assert.equal(four.packCacheBytes, 48 * MiB);
  assert.ok(four.concurrentLoads >= 6, 'a floor keeps a panel able to stream');
  let last = Infinity;
  for (const n of [1, 2, 3, 4]) {
    const s = PR.loaderSettings(n, 22);
    assert.ok(s.decodeWorkers * n <= 21 || s.decodeWorkers === 1, `${n} panels do not over-subscribe the cores`);
    assert.ok(s.packCacheBytes <= last, 'caches shrink as panels join');
    last = s.packCacheBytes;
  }
  assert.equal(PR.loaderSettings(0, 0).decodeWorkers, 3, 'nonsense in: one panel, an assumed four cores — a working pool out');
  assert.equal(PR.loaderSettings('3', '12').decodeWorkers, 3);
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
assert.ok(viewer.includes('gpuBudgetBytes: _naturalGpuBudgetBytes()'), 'PANEL_READY reports the page\'s own budget');
assert.ok(/Math\.min\(vram, natural\)/.test(viewer), 'a share is never above what the page would give itself alone');
assert.ok(viewer.includes('VolumeViewer.trimCache?.()'), 'a smaller share evicts at once');
assert.ok(/if \(!VolumeViewer\.getRenderer\?\.\(\)\) return null;/.test(viewer), 'the natural budget is not read before the renderer exists (the unknown-card figure would stick)');
assert.ok(read('js/viewers/volume-viewer.js').includes('trimCache: () => _trimVolumeCache(null)'), 'VolumeViewer exposes trimCache');

// A panel's prefetch stays off, and its trust watch is not started without a sandboxed plugin.
assert.ok(/!isLive \|\| _isIframe/.test(viewer), 'no background prefetch in a panel');
assert.ok(read('js/core/plugin-registry.js').includes('![..._modules.keys()].some(sandboxed)'), 'the trust poll needs a sandboxed plugin to be worth a request');

console.log('panel resources: OK');
