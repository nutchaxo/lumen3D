// Unit test for BUG-035 / STREAMING-21: SVRManager.init() must size slotToBrick on
// the FINAL maxSlots fixed by the atlas cascade, not the provisional
// _selectAtlasConfig pick. When a smaller target atlas fails GPU allocation the
// cascade falls back to a LARGER atlas (maxSlots grows); a slotToBrick sized on the
// initial pick is then too short -> eviction reads undefined oldKey -> the stale
// PageTable entry is never cleared -> the slot points at the wrong brick (corrupted
// voxels) under VRAM pressure.
//
// Run: node tests/js/test_svr_slottobrick_sizing.mjs
import assert from 'node:assert/strict';
import { loadModule } from './harness.mjs';

// Texture stub: records nothing, just satisfies property assignments + dispose().
function Texture3D(data, w, h, d) {
  this.data = data; this.image = { width: w, height: h, depth: d };
  this.dispose = () => {};
}

const SVRManager = loadModule('js/core/svr-manager.js', 'SVRManager', {
  THREE: {
    Vector3: function () {},
    Data3DTexture: Texture3D,
    RGBAFormat: 'rgba', UnsignedByteType: 'u8', NearestFilter: 'nearest',
  },
  window: {}, document: {}, console: { warn() {}, log() {}, error() {} },
});

function makeRenderer(max3D = 2048) {
  // GL stub: init() drains GL errors (while gl.getError() !== gl.NO_ERROR), so the
  // mock context must expose both — otherwise the drain loop throws/never exits.
  return {
    capabilities: { max3DTextureSize: max3D },
    getContext: () => ({ NO_ERROR: 0, getError: () => 0 }),
  };
}

// Build an SVR whose GPU side is fully stubbed (no real WebGL), so init() exercises
// only the config cascade + slot bookkeeping we care about.
function makeSvr() {
  const svr = new SVRManager();
  svr._releaseGpuResources = () => {};
  svr.updateUniforms = () => {};
  svr._disposeAtlasTexture = () => {};
  return svr;
}

// ── Case 1: normal init — every config succeeds, no cascade-up. ──
{
  const svr = makeSvr();
  svr._initAtlasTexture = () => {};                 // alloc always succeeds
  svr.init(1, { x: 64, y: 64, z: 64 }, makeRenderer(), { uniforms: {} }, { targetSlots: 2 });
  assert.equal(svr.slotToBrick.length, svr.maxSlots, 'slotToBrick == maxSlots (normal)');
  assert.equal(svr.freeSlots.length, svr.maxSlots, 'freeSlots == maxSlots (normal)');
  assert.ok(svr.slotToBrick.every(x => x === null), 'slotToBrick fully null (normal)');
}

// ── Case 2: cascade-up — the smallest target atlas FAILS GPU allocation, forcing
// the cascade to a larger atlas. maxSlots must grow AND slotToBrick must track it. ──
{
  const svr = makeSvr();
  // Capture the provisional maxSlots that _selectAtlasConfig picks (smallest config),
  // before any allocation, to prove the cascade actually grew it.
  let provisional = null;
  let failFirst = true;
  svr._initAtlasTexture = () => {
    if (failFirst) { failFirst = false; throw new Error('simulated GPU OOM on smallest atlas'); }
  };
  // Hook _applyAtlasConfig to record the very first (provisional) maxSlots.
  const realApply = svr._applyAtlasConfig.bind(svr);
  svr._applyAtlasConfig = (cfg) => { realApply(cfg); if (provisional === null) provisional = svr.maxSlots; };

  svr.init(1, { x: 64, y: 64, z: 64 }, makeRenderer(), { uniforms: {} }, { targetSlots: 2 });

  assert.ok(svr.maxSlots > provisional,
    `cascade grew maxSlots (${provisional} -> ${svr.maxSlots}) after the smallest atlas failed`);
  // The core invariant the fix restores: slotToBrick sized on the FINAL maxSlots.
  assert.equal(svr.slotToBrick.length, svr.maxSlots,
    'slotToBrick sized on FINAL maxSlots (not the provisional pick)');
  assert.equal(svr.freeSlots.length, svr.maxSlots, 'freeSlots sized on FINAL maxSlots');
  assert.ok(svr.slotToBrick.every(x => x === null), 'slotToBrick fully null-initialized');

  // Regression guard: with the bug, slotToBrick would be `provisional`-long, so a
  // slotIndex in the grown range would read undefined at eviction. Verify the tail
  // slot is a real, addressable null entry (not undefined).
  const tail = svr.maxSlots - 1;
  assert.strictEqual(svr.slotToBrick[tail], null,
    'highest slot index is an initialized null (would be undefined if undersized)');
}

console.log('BUG-035/STREAMING-21 slotToBrick sizing on final maxSlots: OK');
