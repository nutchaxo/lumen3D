/* Headless validation of the PluginSandbox RPC broker security logic (Node).
   Cannot exercise a real iframe, but drives the host message handler with
   synthetic frames to assert the invariants that don't need a browser:
     INV-7  auth by window identity (event.source), origin==='null'
     INV-9  forbidden capability rejected
     INV-10 rate limiting
     INV-11 ui.download gesture gate
     INV-12 namespace discriminant (ignores SYNC_*) */
'use strict';
const path = require('path');
const assert = require('assert');

let messageHandler = null;
const posted = [];        // envelopes the host sent to frames
let lastFrame = null;
function makeFrame() {
  const win = { postMessage: (env) => posted.push(env) };
  const f = { setAttribute() {}, style: {}, srcdoc: '', contentWindow: win, remove() {} };
  lastFrame = f;
  return f;
}
if (typeof crypto === 'undefined') { global.crypto = require('crypto').webcrypto; }
if (typeof performance === 'undefined') { global.performance = { now: () => Date.now() }; }
if (typeof atob === 'undefined') { global.atob = (b) => Buffer.from(b, 'base64').toString('binary'); }
if (typeof btoa === 'undefined') { global.btoa = (s) => Buffer.from(s, 'binary').toString('base64'); }
global.TextEncoder = require('util').TextEncoder;
global.FileReader = class { readAsDataURL() { this.onload && this.onload({ target: this }); this.result = 'data:;base64,'; } };
global.document = {
  createElement: (tag) => tag === 'iframe' ? makeFrame()
    : { style: {}, setAttribute() {}, appendChild() {}, remove() {}, click() {}, href: '' },
  body: { appendChild() {} }, querySelector: () => null,
};
global.window = {
  addEventListener: (t, h) => { if (t === 'message') messageHandler = h; },
  removeEventListener: () => {},
};
global.setInterval = () => 0; global.clearInterval = () => {};
global.setTimeout = (fn) => 0; global.clearTimeout = () => {};

const PluginSandbox = require(path.join(__dirname, '..', 'js', 'core', 'plugin-sandbox.js'));

let toasts = [];
PluginSandbox.bindContext({
  ui: { toast: (m) => toasts.push(m), downloadBlob: () => {} },
  getCanvasBlob: async () => null,
  viewer: { setRenderMode() {}, renderModes: () => ['fluorescence'] },
  channels: { getState: () => [] },
  dataset: { meta: () => ({ id: 'x', name: 'demo' }) },
});

const E = (source, data, origin) => ({ source, data, origin: origin === undefined ? 'null' : origin });

(async () => {
  const meta = { id: 'p1', name: 'P1', placement: 'tools', subtype: 'action', i18n: {} };
  const caps = ['ui.toast', 'ui.download', 'viewer.getInfo'];
  const spawnP = PluginSandbox.spawn(meta, 'hash', caps, 'LumenPlugin.register({});');

  // The frame was created synchronously; extract the per-frame token the host minted
  // (embedded as the bootstrap IIFE's first arg in the srcdoc).
  assert(lastFrame, 'iframe created');
  const win = lastFrame.contentWindow;
  const m = /\)\("([0-9a-f]+)","p1"\);/.exec(lastFrame.srcdoc);
  assert(m, 'token extracted from srcdoc');
  const token = m[1];
  const mk = (over) => Object.assign({ ns: 'lumen-plugin', v: 1, dir: 'req', id: 1, plugin: 'p1',
                                       token, type: 'ui.toast', payload: { message: 'hi' } }, over || {});

  // Handshake: ready → host sends init; init-done → spawn resolves.
  messageHandler(E(win, { ns: 'lumen-plugin', v: 1, dir: 'sys', id: 1, plugin: 'p1', token, type: 'ready', payload: {} }));
  messageHandler(E(win, { ns: 'lumen-plugin', v: 1, dir: 'sys', id: 2, plugin: 'p1', token, type: 'init-done' }));
  await spawnP;

  let fails = 0;
  const check = (name, cond) => { console.log((cond ? '  ok   ' : '  FAIL ') + name); if (!cond) fails++; };

  toasts = [];
  messageHandler(E(win, { type: 'SYNC_CAMERA' }));          // no ns → ignored
  messageHandler(E(win, mk()));                             // valid toast
  check('INV-12 non-namespaced ignored; valid toast delivered', toasts.length === 1);

  toasts = [];
  messageHandler(E({ postMessage() {} }, mk()));            // unknown source
  check('INV-7 unknown source window ignored', toasts.length === 0);

  toasts = [];
  messageHandler(E(win, mk(), 'https://evil.example'));     // wrong origin
  check('INV-7 non-null origin rejected', toasts.length === 0);

  toasts = [];
  messageHandler(E(win, mk({ token: 'wrong' })));           // token mismatch
  check('token mismatch rejected', toasts.length === 0);

  posted.length = 0;
  messageHandler(E(win, mk({ type: 'channels.getState', payload: {} })));  // not granted
  check('INV-9 forbidden capability rejected', posted.some(p => p.dir === 'res' && p.error && p.error.code === 'forbidden'));

  posted.length = 0;
  messageHandler(E(win, mk({ type: 'ui.download', payload: { filename: 'x.png', mime: 'image/png', dataB64: btoa('abc') } })));
  check('INV-11 download without gesture refused', posted.some(p => p.dir === 'res' && p.error && p.error.code === 'no-gesture'));

  posted.length = 0;
  for (let i = 0; i < 80; i++) messageHandler(E(win, mk({ id: 100 + i })));
  check('INV-10 rate limiting engages under flood', posted.some(p => p.dir === 'res' && p.error && p.error.code === 'busy'));

  if (fails) { console.log(`\n${fails} SANDBOX BROKER CHECKS FAILED`); process.exit(1); }
  console.log('\nALL SANDBOX BROKER CHECKS PASSED (js)');
})().catch(e => { console.error(e); process.exit(1); });
