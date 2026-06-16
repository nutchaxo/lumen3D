// Unit test for ELE-14 / RACE-005: the deferred _goToSlice scheduled by
// applyState must NOT re-broadcast SYNC_ZSTACK_SLICE (echo loop). The receiver
// clears suppressZstackSync synchronously before the 80ms timer fires, so the
// deferred callback re-arms the guard itself.
//
// Run: node tests/js/test_zstack_echo.mjs
import assert from 'node:assert/strict';
import { loadModule } from './harness.mjs';

let plugin = null;
const timers = [];
const broadcasts = [];

const elStub = () => ({
  classList: { toggle() {}, add() {}, remove() {} }, style: {}, value: 0, textContent: '',
  getContext: () => ({ clearRect() {}, fillRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, fillText() {}, arc() {}, fill() {}, save() {}, restore() {} }),
  addEventListener() {}, width: 100, height: 100,
});

loadModule('js/modules/tools/zstack-browser/index.js', 'ZNone', {
  PluginRegistry: { implement: (_id, obj) => { plugin = obj; } },
  document: { getElementById: () => elStub(), createElement: () => elStub() },
  setTimeout: (fn) => { timers.push(fn); return timers.length; },
});

assert.ok(plugin && typeof plugin.applyState === 'function', 'zstack-browser plugin captured');

const ctx = {
  _state: { zstackActive: false, zstackCurrentSlice: 0, suppressZstackSync: false },
  iframe: { isIframe: () => true, postMessage: (m) => broadcasts.push(m), panelIndex: () => 0 },
  viewer: { setClipRange_z() {} },
};
plugin._ctx = ctx;
plugin._getDims = () => ({ z: 100, vz: 1 });
plugin._drawDiagram = () => {};
plugin._show = () => {};

// --- echo scenario ---
// receiver sets suppress=true, then applyState schedules the deferred goToSlice
ctx._state.suppressZstackSync = true;
plugin.applyState(true, 12);
// receiver clears the flag synchronously (well before the 80ms timer)
ctx._state.suppressZstackSync = false;
// fire the deferred timer
timers.forEach((fn) => fn());
assert.equal(broadcasts.length, 0, 'deferred goToSlice must NOT re-broadcast (echo guard re-armed)');
assert.equal(ctx._state.suppressZstackSync, false, 'prev suppress flag restored');

// --- nominal scenario: a genuine local slice change broadcasts once ---
broadcasts.length = 0;
plugin._goToSlice(20);
assert.equal(broadcasts.length, 1, 'a genuine local slice change broadcasts exactly once');

console.log('ELE-14 zstack SYNC_ZSTACK_SLICE echo guard: OK');
