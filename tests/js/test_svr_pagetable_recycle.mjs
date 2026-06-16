// Unit test for ELE-23 / BUG-002: writeBrick/writeRgbaBrick must UNCONDITIONALLY
// re-point the PageTable at the slot getSlot assigned. The old `alpha===0` guard
// skipped the re-point when a slot had been recycled by eviction, leaving the
// brick pointing at the wrong atlas slot (phantom brick / wrong voxels).
//
// Run: node tests/js/test_svr_pagetable_recycle.mjs
import assert from 'node:assert/strict';
import { loadModule } from './harness.mjs';

const SVRManager = loadModule('js/core/svr-manager.js', 'SVRManager', {
  THREE: { Vector3: function () {} }, window: {}, document: {},
});

function makeSvr() {
  const svr = new SVRManager();
  // Minimal state, bypassing init()'s atlas/GPU allocation.
  svr.channels = 1; svr.brickSize = 64;
  svr.slotsX = 2; svr.slotsY = 1; svr.slotsZ = 1;
  svr.slotsPerAtlas = 2; svr.atlasPages = 1; svr.maxSlots = 2;
  svr.ptNx = 3; svr.ptNy = 1; svr.ptNz = 1;
  svr.pageData = new Uint8Array(svr.ptNx * svr.ptNy * svr.ptNz * 4);
  svr.pageTable = { needsUpdate: false };
  svr.brickMap = new Map(); svr.slotQueue = []; svr.freeSlots = [0, 1];
  svr.slotToBrick = new Array(2).fill(null);
  // Isolate the PageTable logic from the atlas upload.
  svr._writeChannelToSlot = () => {};
  svr._extractSlotRegion = () => new Uint8Array(0);
  svr._uploadRgbaRegion = () => {};
  svr._compactRgbaBrickData = () => new Uint8Array(0);
  return svr;
}

// writeBrick re-points even when the entry already has a (stale) non-zero alpha
{
  const svr = makeSvr();
  const data = new Uint8Array(64 * 64 * 64);
  svr.writeBrick(0, 0, 0, 0, data, 64, 64, 64);
  const coord = svr._slotCoord(svr.getSlot(0, 0, 0));   // cache hit -> same slot
  // corrupt the PageTable entry with a stale, non-zero mapping
  svr.pageData[0] = 99; svr.pageData[1] = 99; svr.pageData[2] = 99; svr.pageData[3] = 99;
  svr.writeBrick(0, 0, 0, 0, data, 64, 64, 64);          // re-write same brick
  assert.equal(svr.pageData[0], coord.x, 'PT.x re-pointed');
  assert.equal(svr.pageData[1], coord.y, 'PT.y re-pointed');
  assert.equal(svr.pageData[2], coord.z, 'PT.z re-pointed');
  assert.equal(svr.pageData[3], coord.atlas + 1, 'PT.alpha re-pointed (not stale 99)');
}

// writeRgbaBrick likewise
{
  const svr = makeSvr();
  const data = new Uint8Array(64 * 64 * 64 * 4);
  svr.writeRgbaBrick(0, 0, 0, data, 64, 64, 64);
  const coord = svr._slotCoord(svr.getSlot(0, 0, 0));
  svr.pageData[3] = 99;
  svr.writeRgbaBrick(0, 0, 0, data, 64, 64, 64);
  assert.equal(svr.pageData[3], coord.atlas + 1, 'writeRgbaBrick re-points PT alpha (not stale 99)');
}

console.log('ELE-23 SVR PageTable unconditional re-point: OK');
