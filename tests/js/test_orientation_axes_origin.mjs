// Unit test for ELE-04 / SEC-006: orientation-axes._onMessage must (a) ignore
// messages from a foreign origin and (b) reply to e.origin, not '*'.
//
// Run: node tests/js/test_orientation_axes_origin.mjs
import assert from 'node:assert/strict';
import { loadModule } from './harness.mjs';

const ORIGIN = 'https://lab.example';
const Utils = loadModule('js/core/utils.js', 'Utils', {
  window: { location: { origin: ORIGIN } }, document: {}, requestAnimationFrame: () => {},
});

let plugin = null;
function BoxGeometry() {}
const THREE = { Vector3: function () {}, Quaternion: function () {}, BoxGeometry };
const PluginRegistry = { implement: (_id, obj) => { plugin = obj; } };

loadModule('js/modules/tools/orientation-axes/index.js', 'OrientationAxesNone', {
  PluginRegistry, THREE, Utils,
  window: { location: { origin: ORIGIN }, addEventListener() {} },
});

assert.ok(plugin && typeof plugin._onMessage === 'function', 'plugin._onMessage must be captured');
plugin._visible = true;       // skip activate()
plugin.activate = () => {};

// (a) origin guard on CALIBRATE_ORIENTATION_START
plugin._calibrationMode = false;
plugin._onMessage({ origin: 'https://evil.example', data: { type: 'CALIBRATE_ORIENTATION_START' } });
assert.equal(plugin._calibrationMode, false, 'cross-origin calibrate must be ignored');
plugin._onMessage({ origin: ORIGIN, data: { type: 'CALIBRATE_ORIENTATION_START' } });
assert.equal(plugin._calibrationMode, true, 'same-origin calibrate accepted');

// (b) GET_ORIENTATION reply must target e.origin (not '*') and only same-origin
const cube = { type: 'Mesh', geometry: new BoxGeometry(), quaternion: { x: 1, y: 2, z: 3, w: 4 } };
plugin._ctx = { viewer: { getScene: () => ({ children: [cube] }) } };

let reply = null;
const source = { postMessage: (msg, target) => { reply = { msg, target }; } };
plugin._onMessage({ origin: 'https://evil.example', data: { type: 'GET_ORIENTATION' }, source });
assert.equal(reply, null, 'cross-origin GET_ORIENTATION must not reply');

plugin._onMessage({ origin: ORIGIN, data: { type: 'GET_ORIENTATION' }, source });
assert.ok(reply, 'same-origin GET_ORIENTATION must reply');
assert.equal(reply.target, ORIGIN, 'reply target must be the requester origin');
assert.notEqual(reply.target, '*', 'reply must not use wildcard target');
assert.equal(reply.msg.type, 'ORIENTATION_RESULT');

console.log('ELE-04 orientation-axes origin guard + targeted reply: OK');
