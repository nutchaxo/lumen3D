// The Studio's upgrade climbs the brick levels: every level finer than the one the
// preview came from, coarse to fine, ending at LOD0 — a coarser stage kept only when
// it costs no more than STUDIO_STAGE_BYTES_RATIO of the next finer kept one. Run
// from the viewer source (js/pages/viewer.js _studioStages) with a stub loader.
//
// Run: node tests/js/test_studio_lod_ladder.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT } from './harness.mjs';

const ctx = vm.createContext({ console, setTimeout, clearTimeout, window: {} });
vm.runInContext(readFileSync(path.join(ROOT, 'js/vendor/three.min.js'), 'utf8'), ctx, { filename: 'three.min.js' });
vm.runInContext(readFileSync(path.join(ROOT, 'js/viewers/volume-slicer.js'), 'utf8') + '\n;globalThis.__VS = VolumeSlicer;', ctx, { filename: 'volume-slicer.js' });
const VolumeSlicer = ctx.__VS;
const THREE = ctx.THREE;
// Arrays built inside a vm realm carry that realm's prototypes: compare them as plain data.
const plain = (o) => JSON.parse(JSON.stringify(o));

const viewerSrc = readFileSync(path.join(ROOT, 'js/pages/viewer.js'), 'utf8');
function fn(name, endMarker) {
  const start = viewerSrc.indexOf(`  function ${name}(`);
  assert.ok(start > 0, `${name} found`);
  const end = viewerSrc.indexOf(endMarker, start);
  assert.ok(end > start, `${name} end found`);
  return viewerSrc.slice(start, end);
}
const ratio = viewerSrc.match(/const STUDIO_STAGE_BYTES_RATIO = ([\d.]+);/);
assert.ok(ratio, 'STUDIO_STAGE_BYTES_RATIO declared');
const src = [
  `const STUDIO_STAGE_BYTES_RATIO = ${ratio[1]};`,
  fn('_nativeSliceBricksForSpec', '\n  function _nativeStudioRenderSize('),
  fn('_nativeSliceChannels', '\n  /**'),
  fn('_studioStages', '\n  function _stageLabel('),
].join('\n');

// A pyramid: LOD0 4096² × 128, LOD1 2048², LOD2 1024², LOD3 512² (z never downsampled),
// every logical brick active, one channel; a LOD0 tile costs 100 KB, a coarser level's
// tile the same (as real WebP tiles roughly do).
function world({ bytesPerTile = { 0: 100e3, 1: 100e3, 2: 100e3, 3: 100e3 }, channels = 1 } = {}) {
  const levels = [4096, 2048, 1024, 512].map((n) => ({ dimensions: { x: n, y: n, z: 128 }, brickSize: 64 }));
  const dimsOf = (lod) => ({ ...levels[lod].dimensions, brickSize: 64, channels, lod });
  const bricksOf = (lod) => {
    const d = dimsOf(lod); const out = [];
    for (let bz = 0; bz < Math.ceil(d.z / 64); bz++) for (let by = 0; by < Math.ceil(d.y / 64); by++) for (let bx = 0; bx < Math.ceil(d.x / 64); bx++) out.push({ bx, by, bz });
    return out;
  };
  const c = vm.createContext({
    console, THREE, VolumeSlicer,
    BrickLoader: {
      getDimensions: dimsOf,
      activeBricks: bricksOf,
      taskBytes: (t) => bytesPerTile[t.lod] || 0,
      getTransportEncoding: () => 'webp-lossless',
    },
    VolumeViewer: { getPhysicalSize: () => ({ x: 1000, y: 1000, z: 400 }) },
    datasetMeta: { dimensions: { c: channels } },
    _currentChannelState: () => [],
    ChannelPanel: { getState: () => [] },
    _channelState: [],
  });
  vm.runInContext(src + '\n;globalThis.__stages = _studioStages;', c, { filename: 'viewer.js#_studioStages' });
  return { stages: c.__stages, levels };
}

// A quarter of the depth: voxel 32 of 128, one brick layer with its slack; 0.5 would sit on
// the layer boundary (voxel 64) and pull the layer below in as well.
const xy = { mode: 'xy', value: 0.25, slabThickness: 1, projection: 'single' };

{
  // T1: preview at LOD3 (512): three stages 1024 → 2048 → native, each a layer of
  // the plane at that level (16×16, 32×32, 64×64 bricks).
  const { stages, levels } = world();
  const ladder = stages(xy, 3, levels);
  assert.deepEqual(plain(ladder.map((s) => s.lod)), [2, 1, 0], 'coarse to fine, native last');
  assert.deepEqual(plain(ladder.map((s) => s.bricks)), [256, 1024, 4096], 'one brick layer of the plane per level');
  assert.deepEqual(plain(ladder.map((s) => s.bytes)), [256 * 100e3, 1024 * 100e3, 4096 * 100e3]);
  for (const s of ladder) assert.equal(s.dims.x, levels[s.lod].dimensions.x, 'stage carries its dims');
  console.log('ladder from 512: OK');
}

{
  // T2: preview already at 2048 (LOD1): only native remains.
  const { stages, levels } = world();
  assert.deepEqual(plain(stages(xy, 1, levels).map((s) => s.lod)), [0]);
  // preview at native: the native pass still runs (the atlas may hold part of the level).
  assert.deepEqual(plain(stages(xy, 0, levels).map((s) => s.lod)), [0]);
  console.log('ladder from 2048 / native: OK');
}

{
  // T3: a coarser stage that is not cheap enough (> 30 % of the next finer kept
  // stage) is skipped, and the comparison then runs against the last KEPT stage.
  const { stages, levels } = world({ bytesPerTile: { 0: 100e3, 1: 100e3, 2: 900e3, 3: 100e3 } });
  const ladder = stages(xy, 3, levels);
  // LOD2 would cost 256 × 900 KB = 230 MB against LOD1's 102 MB: skipped; LOD1 (102 MB)
  // against native (410 MB) is 25 %: kept.
  assert.deepEqual(plain(ladder.map((s) => s.lod)), [1, 0], 'expensive intermediate level skipped');
  const { stages: s2 } = world({ bytesPerTile: { 0: 100e3, 1: 900e3, 2: 20e3, 3: 100e3 } });
  // LOD1 at 922 MB is more than native: skipped; LOD2 (5 MB) against native (410 MB): kept.
  assert.deepEqual(plain(s2(xy, 3, levels).map((s) => s.lod)), [2, 0], 'a cheap level two steps down is still kept');
  console.log('ladder ratio rule: OK');
}

{
  // T4: a plane outside a coarser level's bricks contributes no stage, native always does.
  const { stages, levels } = world();
  const c = vm.createContext({
    console, THREE, VolumeSlicer,
    BrickLoader: { getDimensions: (lod) => ({ ...levels[lod].dimensions, brickSize: 64, channels: 1, lod }), activeBricks: (lod) => (lod === 0 ? [{ bx: 0, by: 0, bz: 0 }] : []), taskBytes: () => 100e3, getTransportEncoding: () => 'webp-lossless' },
    VolumeViewer: { getPhysicalSize: () => null }, datasetMeta: {}, _currentChannelState: () => [], ChannelPanel: { getState: () => [] }, _channelState: [],
  });
  vm.runInContext(src + '\n;globalThis.__stages = _studioStages;', c);
  assert.deepEqual(plain(c.__stages(xy, 3, levels).map((s) => [s.lod, s.bricks])), [[0, 1]], 'empty coarse levels drop out, native stays');
  console.log('ladder with empty levels: OK');
}

console.log('studio LOD ladder: OK');
