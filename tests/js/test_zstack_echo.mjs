// Unit test for ELE-14 / RACE-005: the slice applied by applyState must NOT
// re-broadcast SYNC_ZSTACK_SLICE (echo loop). The receiver raises
// suppressZstackSync around the call; applyState re-arms the guard itself so a
// caller without one (or a deferred apply) cannot ping-pong with the sibling.
//
// Run: node tests/js/test_zstack_echo.mjs
import assert from 'node:assert/strict';
import { loadModule } from './harness.mjs';

let plugin = null;
const timers = [];
const broadcasts = [];

const elStub = () => ({
  classList: { toggle() {}, add() {}, remove() {}, contains() { return false; } }, style: {}, value: 0, textContent: '',
  getContext: () => ({ clearRect() {}, fillRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, fillText() {}, arc() {}, fill() {}, save() {}, restore() {} }),
  addEventListener() {}, setAttribute() {}, querySelector() { return null; }, width: 100, height: 100,
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
  viewer: { setClipRange_z() {}, setView() {}, setRotationLocked() {}, resetClipping() {} },
  // Per-plugin i18n façade is part of the ctx contract (PluginRegistry.initAll).
  i18n: { t: (k, p) => k, getLanguage: () => 'en', onLanguageChange: () => {} },
};
plugin._ctx = ctx;
plugin._getDims = () => ({ z: 100, vz: 1 });
plugin._drawDiagram = () => {};
plugin._show = () => {};

// --- echo scenario ---
// receiver raises suppress, then applyState applies the sibling's slice
ctx._state.suppressZstackSync = true;
plugin.applyState(true, 12);
// receiver clears the flag synchronously afterwards
ctx._state.suppressZstackSync = false;
// any deferred work must stay silent too
timers.forEach((fn) => fn());
assert.equal(broadcasts.length, 0, 'applied slice must NOT re-broadcast (echo guard re-armed)');
assert.equal(ctx._state.suppressZstackSync, false, 'prev suppress flag restored');
assert.equal(ctx._state.zstackCurrentSlice, 12, 'the sibling slice was applied');

// --- nominal scenario: a genuine local slice change broadcasts once ---
broadcasts.length = 0;
plugin._goToSlice(20);
assert.equal(broadcasts.length, 1, 'a genuine local slice change broadcasts exactly once');

console.log('ELE-14 zstack SYNC_ZSTACK_SLICE echo guard: OK');
