// The render loop survives a frame that throws. The real volume-viewer.js runs in a vm
// context against the real three.js, with a stub WebGLRenderer and a setTimeout
// requestAnimationFrame. A throw inside a frame used to leave `animationId` set with no
// requestAnimationFrame pending: _scheduleFrame then never woke the loop and the viewer
// froze for good.
//   • the first failure is logged, a repeat of the same error is throttled (every 100th);
//   • the loop re-arms after a failed frame and draws again once the fault is gone;
//   • a fault that never clears lets the loop go back to sleep instead of spinning.
//
// Run: node tests/js/test_render_loop_resilience.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT } from './harness.mjs';

const require = createRequire(import.meta.url);
const REAL_THREE = require('../../js/vendor/three.min.js');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function makeWorld(viewerSource = read('js/viewers/volume-viewer.js')) {
  const gl = {
    NO_ERROR: 0, RENDERER: 0x1f01,
    getError: () => 0, getExtension: () => null, getParameter: (p) => (p === 0x1f01 ? 'Test GPU' : null),
    isContextLost: () => false,
  };
  const canvas = {
    style: {}, clientWidth: 800, clientHeight: 600,
    parentElement: { clientWidth: 800, clientHeight: 600, style: {} },
    addEventListener() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
  };
  const stats = { renders: 0, fail: null };
  let renderTarget = null;
  const renderer = {
    domElement: canvas,
    capabilities: { max3DTextureSize: 256, isWebGL2: true, maxTextureSize: 4096 },
    properties: { get: () => ({}), remove() {} },
    state: { bindTexture() {}, bindFramebuffer() {} },
    getContext: () => gl,
    setSize() {}, setPixelRatio(r) { this._pr = r; }, getPixelRatio() { return this._pr || 1; },
    setClearColor() {}, getClearColor(c) { return c; }, getClearAlpha() { return 1; },
    getSize(v) { return v.set(800, 600); },
    getRenderTarget() { return renderTarget; }, setRenderTarget(t) { renderTarget = t; },
    clear() {}, dispose() {},
    render() {
      stats.renders++;
      if (stats.fail) throw new Error(stats.fail);
    },
  };
  const THREE = Object.assign({}, REAL_THREE, { WebGLRenderer: function WebGLRenderer() { return renderer; } });
  const errors = [];
  const ctx = vm.createContext({
    console: { log() {}, warn() {}, error: (...a) => errors.push(a), info() {} },
    setTimeout, clearTimeout, Promise, URL, Map, Set, WeakMap, Uint8Array, Float64Array, Int32Array, ArrayBuffer,
    AbortController, DOMException, CustomEvent, MessageChannel,
    THREE, window: { devicePixelRatio: 1, addEventListener() {}, dispatchEvent: () => true },
    performance: { now: () => Date.now() },
    navigator: { hardwareConcurrency: 1, deviceMemory: 8 },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    requestAnimationFrame: (cb) => setTimeout(() => cb(Date.now()), 0),
    cancelAnimationFrame: (id) => clearTimeout(id),
    document: {
      getElementById: (id) => (id === 'webgl-canvas' ? canvas : null),
      createElement: () => ({ getContext: () => ({}) }),
    },
  });
  vm.runInContext(read('js/core/svr-manager.js'), ctx, { filename: 'svr-manager.js' });
  vm.runInContext(viewerSource + '\n;globalThis.__VV = VolumeViewer;', ctx, { filename: 'volume-viewer.js' });
  return { VV: ctx.__VV, stats, errors };
}

// LUMEN_TEST_VIEWER_SOURCE: a file to run instead of the working copy (to see the test fail on an old build).
const W = makeWorld(process.env.LUMEN_TEST_VIEWER_SOURCE ? readFileSync(process.env.LUMEN_TEST_VIEWER_SOURCE, 'utf8') : undefined);
W.VV.init('webgl-canvas');
// Let the loop go back to sleep (IDLE_SLEEP_FRAMES idle frames): only then does a wake-up
// prove anything about re-arming.
async function settle() {
  let last = -1;
  for (let i = 0; i < 100 && W.stats.renders !== last; i++) { last = W.stats.renders; await sleep(100); }
  await sleep(100);
}
await settle();
assert.ok(W.stats.renders >= 1, 'the loop draws the first frame');

// A frame that throws: logged once, the loop keeps running.
W.stats.fail = 'frame boom';
W.stats.renders = 0;
W.VV.setMeasurements([]);
await sleep(80);
assert.ok(W.stats.renders > 3, `the loop re-arms after a failed frame (${W.stats.renders} attempts)`);
assert.equal(W.errors.length, 1, 'a repeated identical error is logged once, not every frame');
assert.match(String(W.errors[0][0]), /Frame failed/);

// The fault clears: the next wake draws again (the loop was not left dead).
await settle();   // the failing loop gives up after its idle budget
W.stats.fail = null;
W.stats.renders = 0;
W.VV.setMeasurements([]);
await sleep(80);
assert.ok(W.stats.renders >= 1, 'the viewer draws again once the fault is gone');

// A different error is reported at once.
await settle();
W.stats.fail = 'another boom';
W.VV.setMeasurements([]);
await sleep(40);
assert.ok(W.errors.length >= 2, 'a different error is logged immediately');
console.log('render loop survives a throwing frame: OK');
