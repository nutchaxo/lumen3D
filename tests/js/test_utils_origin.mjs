// Unit test for ELE-01 / SEC-003: Utils.isTrustedMessageOrigin gates postMessage
// handlers to same-origin events (cross-panel sync is strictly same-origin).
//
// Run: node tests/js/test_utils_origin.mjs
import assert from 'node:assert/strict';
import { loadModule } from './harness.mjs';

function load(originHere) {
  return loadModule('js/core/utils.js', 'Utils', {
    window: { location: { origin: originHere } },
    document: {},
    requestAnimationFrame: () => {},
  });
}

const U = load('https://lab.example');
assert.equal(typeof U.isTrustedMessageOrigin, 'function', 'helper must be exported');
assert.equal(U.isTrustedMessageOrigin({ origin: 'https://lab.example' }), true, 'same origin trusted');
assert.equal(U.isTrustedMessageOrigin({ origin: 'https://evil.example' }), false, 'cross origin rejected');
assert.equal(U.isTrustedMessageOrigin({ origin: 'https://lab.example.evil.com' }), false, 'lookalike rejected');
assert.equal(U.isTrustedMessageOrigin({ origin: '' }), false, 'empty origin rejected');
assert.equal(U.isTrustedMessageOrigin(null), false, 'null event rejected');
assert.equal(U.isTrustedMessageOrigin(undefined), false, 'undefined event rejected');

console.log('ELE-01 isTrustedMessageOrigin: OK');
