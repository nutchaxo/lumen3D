// Unit test for ELE-03 / SEC-005: compare.js _handleIframeMessage must reject
// messages whose origin is not this page's own origin. We prove the origin
// guard runs *before* event.data is read, using a getter spy on `data`.
//
// Run: node tests/js/test_compare_origin.mjs
import assert from 'node:assert/strict';
import { loadModule } from './harness.mjs';

const ORIGIN = 'https://lab.example';

// Real Utils (so isTrustedMessageOrigin closes over a window with our origin).
const Utils = loadModule('js/core/utils.js', 'Utils', {
  window: { location: { origin: ORIGIN } }, document: {}, requestAnimationFrame: () => {},
});

const docStub = {
  addEventListener() {}, querySelector: () => null, getElementById: () => null,
  createElement: () => ({ classList: { add() {}, remove() {} }, style: {}, appendChild() {} }),
  body: { appendChild() {} },
};
const CompareApp = loadModule('js/pages/compare.js', 'CompareApp', {
  window: { location: { origin: ORIGIN }, addEventListener() {}, postMessage() {} },
  document: docStub, Utils, requestAnimationFrame: () => {}, setTimeout,
});

assert.ok(CompareApp && typeof CompareApp._handleIframeMessage === 'function',
  'CompareApp._handleIframeMessage must be exposed');

function spyEvent(origin) {
  const state = { read: false };
  const event = {
    origin,
    get data() { state.read = true; return { type: 'X-TEST', sourceIndex: 1 }; },
  };
  return { event, state };
}

const cross = spyEvent('https://evil.example');
CompareApp._handleIframeMessage(cross.event);
assert.equal(cross.state.read, false, 'cross-origin message must be ignored before reading data');

const same = spyEvent(ORIGIN);
CompareApp._handleIframeMessage(same.event);
assert.equal(same.state.read, true, 'same-origin message proceeds to read data');

console.log('ELE-03 compare _handleIframeMessage origin guard: OK');
