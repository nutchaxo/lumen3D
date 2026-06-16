// Structural test for LEAK-015 (+ ELE-30 dispose wiring): the permanent
// post-render hook installed by DecompositionPanel must be releasable, and the
// VolumeGrid GPU resources disposed, on page teardown (pagehide) — Rule 1.2.
// volume-viewer.js and decomposition-panel.js are not headless-loadable (they
// touch THREE / DOM at load), so this is structural + `node --check`.
//
// Run: node tests/js/test_leak015_teardown.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const vv = readFileSync(path.join(ROOT, 'js/viewers/volume-viewer.js'), 'utf8');
const dp = readFileSync(path.join(ROOT, 'js/components/decomposition-panel.js'), 'utf8');

// ── volume-viewer: setOnPostRender returns an idempotent unsubscribe ──
{
  const i = vv.indexOf('setOnPostRender:');
  assert.ok(i > 0, 'setOnPostRender present in public API');
  const block = vv.slice(i, i + 600);
  assert.ok(/_onPostRender = cb;/.test(block), 'still sets the hook');
  assert.ok(/return \(\) => \{[^}]*_onPostRender === cb[^}]*_onPostRender = null/.test(block.replace(/\n/g, ' ')),
    'returns an unsubscribe that only clears the slot if it still holds this cb');
}

// ── volume-viewer: _initVolumeGrid wires VolumeGrid.dispose() to pagehide ──
{
  const i = vv.indexOf('function _initVolumeGrid()');
  assert.ok(i > 0, '_initVolumeGrid present');
  const fn = vv.slice(i, i + 1000);
  assert.ok(fn.includes("addEventListener('pagehide'"), 'registers a pagehide teardown');
  assert.ok(fn.includes('VolumeGrid.dispose()'), 'pagehide teardown calls VolumeGrid.dispose()');
  assert.ok(fn.includes('_gridDisposeBound'), 'guards against double-binding the pagehide listener');
}

// ── decomposition-panel: init captures the unsubscribe + registers teardown ──
{
  assert.ok(/let _offPostRender = null;/.test(dp), '_offPostRender slot declared');
  assert.ok(/_offPostRender = VolumeViewer\.setOnPostRender\(/.test(dp),
    'init stores the unsubscribe returned by setOnPostRender');
  // the hook stays live across open/close (released only on teardown), so the
  // unsubscribe must NOT be called from _closePanel (that would break reopen).
  const close = dp.slice(dp.indexOf('function _closePanel'), dp.indexOf('function _closePanel') + 500);
  assert.ok(!close.includes('_offPostRender'), '_closePanel does NOT unsubscribe (reopen must still render)');

  const init = dp.slice(dp.indexOf('function init()'), dp.indexOf('function _closePanel'));
  assert.ok(init.includes("addEventListener('pagehide', dispose)"),
    'init registers pagehide -> dispose for teardown');
}

// ── decomposition-panel: dispose() releases hook + canvases + timer ──
{
  const i = dp.indexOf('function dispose()');
  assert.ok(i > 0, 'dispose() defined');
  const fn = dp.slice(i, i + 400);
  assert.ok(fn.includes('clearTimeout(_decompRenderTimer)'), 'dispose cancels the deferred render');
  assert.ok(/_offPostRender\(\);/.test(fn) && fn.includes('_offPostRender = null'),
    'dispose calls then clears the unsubscribe');
  assert.ok(/_canvases = \[\]/.test(fn), 'dispose drops the captured canvases');

  // public API must expose dispose
  const ret = dp.slice(dp.lastIndexOf('return {'), dp.length);
  assert.ok(/\bdispose\b/.test(ret), 'dispose exposed on the public API');
}

console.log('LEAK-015 teardown (post-render unsubscribe + VolumeGrid.dispose wiring): OK');
