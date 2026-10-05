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

// ── Case 2: the smallest atlas holding the target FAILS. The cascade never goes up
// (a larger texture after a refusal only makes the next failure likelier): init
// throws SVR_ALLOC_FAILED for the caller to choose a coarser level, and the session
// remembers the refused size. ──
{
  const svr = makeSvr();
  const sizes = [];
  svr._initAtlasTexture = () => { sizes.push(svr.maxSlots); throw new Error('simulated GPU OOM'); };
  assert.throws(() => svr.init(1, { x: 64, y: 64, z: 64 }, makeRenderer(), { uniforms: {} }, { targetSlots: 200 }),
    (err) => err.code === 'SVR_ALLOC_FAILED', 'targeted failure throws for a coarser level');
  assert.deepEqual(sizes, [208], 'one attempt, at the smallest layout (13 layers of 16 slots), never a larger one');
  assert.ok(SVRManager.vramBudget(makeRenderer()).bytes < 208 * 1024 * 1024, 'the refused size caps the session budget');
}

// ── Case 2b: a failure on a LOST context says nothing about that size: no cap is
// recorded (it would outlive the restored context and refuse even the coarsest level).
{
  SVRManager.resetGpuBudget();
  const svr = makeSvr();
  svr._initAtlasTexture = () => { throw new Error('context lost'); };
  const lost = { capabilities: { max3DTextureSize: 2048 }, getContext: () => ({ NO_ERROR: 0, getError: () => 0, isContextLost: () => true }) };
  assert.throws(() => svr.init(1, { x: 64, y: 64, z: 64 }, lost, { uniforms: {} }, { targetSlots: 200 }),
    (err) => err.code === 'SVR_ALLOC_FAILED');
  assert.equal(SVRManager._failedAllocBytes, Infinity, 'no session cap from a lost context');
  SVRManager.resetGpuBudget();
}

// ── Case 3: untargeted init halves on refusal (down only), slotToBrick sized on the
// FINAL maxSlots. ──
{
  SVRManager.resetGpuBudget();
  const svr = makeSvr();
  const tried = [];
  svr._initAtlasTexture = () => { tried.push(svr.maxSlots); if (tried.length === 1) throw new Error('simulated GPU OOM'); };
  svr.init(1, { x: 64, y: 64, z: 64 }, makeRenderer(), { uniforms: {} }, {});
  assert.ok(tried.length >= 2 && tried[1] < tried[0], `second attempt smaller (${tried.join(' -> ')})`);
  assert.equal(svr.slotToBrick.length, svr.maxSlots, 'slotToBrick sized on FINAL maxSlots');
  assert.equal(svr.freeSlots.length, svr.maxSlots, 'freeSlots sized on FINAL maxSlots');
  assert.strictEqual(svr.slotToBrick[svr.maxSlots - 1], null, 'highest slot index is an initialized null');
}

// ── Case 4: a target over the VRAM budget is refused BEFORE any allocation. ──
{
  SVRManager.resetGpuBudget();
  const svr = makeSvr();
  let calls = 0;
  svr._initAtlasTexture = () => { calls++; };
  assert.throws(() => svr.init(1, { x: 64, y: 64, z: 64 }, makeRenderer(), { uniforms: {} }, { targetSlots: 3000, budgetBytes: 1024 * 1024 * 1024 }),
    (err) => err.code === 'SVR_OVER_BUDGET', '3000 slots (3 GiB) refused under a 1 GiB budget');
  assert.equal(calls, 0, 'nothing allocated');
}

console.log('SVR atlas sizing (down-only cascade, final maxSlots, budget refusal): OK');
