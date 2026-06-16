// Structural test for ELE-27 / PERF-001: the decomposition panel must NOT render
// N+1 ray-marches synchronously in the post-render hot loop; it debounces to the
// camera-stable state. decomposition-panel.js registers a DOMContentLoaded
// listener at load -> not headless-loadable, so this is structural + `node --check`.
//
// Run: node tests/js/test_decomp_debounce.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const src = readFileSync(path.join(ROOT, 'js/components/decomposition-panel.js'), 'utf8');

assert.ok(/function _scheduleDecompRender\(\)/.test(src), '_scheduleDecompRender defined');
assert.ok(/function _flushDecompRender\(\)/.test(src), '_flushDecompRender defined');

// the post-render hook must schedule (debounce), not render synchronously
const hookStart = src.indexOf('setOnPostRender(');
const hook = src.slice(hookStart, hookStart + 200);
assert.ok(hook.includes('_scheduleDecompRender'), 'post-render hook schedules a debounced render');
assert.ok(!hook.includes('_renderDecompositions('), 'post-render hook no longer renders synchronously');

// debounce (re)arms a single timer
const sStart = src.indexOf('function _scheduleDecompRender');
const sBody = src.slice(sStart, sStart + 300);
assert.ok(sBody.indexOf('clearTimeout') < sBody.indexOf('setTimeout'), 'schedule clears then re-arms the timer');

// close cancels any in-flight debounced render (no post-close render)
const cStart = src.indexOf('function _closePanel');
const cBody = src.slice(cStart, cStart + 300);
assert.ok(cBody.includes('clearTimeout(_decompRenderTimer)'), 'close cancels the pending render');

// the actual render path is unchanged + canvas resize is size-guarded
const rStart = src.indexOf('function _renderDecompositions');
const rBody = src.slice(rStart, rStart + 2600);
assert.ok(rBody.includes('renderer.render(scene, camera)'), 'render loop preserved');
assert.ok(rBody.includes('renderer.setSize(origWidth, origHeight, false)'), 'main-view restore preserved');
assert.ok(src.includes('if (view.canvas.width !== w || view.canvas.height !== h)'), 'canvas resize is size-guarded');

console.log('ELE-27 decomposition-panel debounce: OK');
