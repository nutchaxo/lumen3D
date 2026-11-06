// Keyboard access to the Z-stack browser's trim and 3D notch
// (js/modules/tools/zstack-browser):
//   • Shift+↑/↓ moves the upper trim (first kept slice), Alt+↑/↓ the lower one, each
//     clamped against the other edge and the stack, and both reach the volume's clip;
//   • plain arrows still move the cursor, Shift+Alt / Ctrl arrows are left alone;
//   • Enter / Space on the notch button (a click with detail 0) returns to 3D, a
//     pointer click (detail ≥ 1) is left to the drag code;
//   • the slider describes its keys (aria-description) in the four locales.
//
// Run: node tests/js/test_zstack_keyboard_trim.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { loadModule, ROOT } from './harness.mjs';

const elements = new Map();
const makeEl = (id) => {
  const classes = new Set();
  const el = {
    id, style: {}, attrs: {}, textContent: '', value: '', max: '', title: '', disabled: false,
    listeners: {},
    classList: {
      add: (c) => classes.add(c), remove: (c) => classes.delete(c),
      toggle: (c, on) => { if (on === undefined) { classes.has(c) ? classes.delete(c) : classes.add(c); } else { on ? classes.add(c) : classes.delete(c); } return classes.has(c); },
      contains: (c) => classes.has(c),
    },
    setAttribute: (k, v) => { el.attrs[k] = String(v); },
    addEventListener: (type, fn) => { (el.listeners[type] ||= []).push(fn); },
    querySelector: () => null,
    getContext: () => new Proxy({}, { get: () => () => {} }),
    getBoundingClientRect: () => ({ top: 0, height: 100 }),
    focus() {}, setPointerCapture() {},
    closest: () => null,
    width: 200, height: 280,
  };
  return el;
};
const $ = (id) => {
  if (!elements.has(id)) elements.set(id, makeEl(id));
  return elements.get(id);
};

let plugin = null;
loadModule('js/modules/tools/zstack-browser/index.js', 'ZNone', {
  PluginRegistry: { implement: (_id, obj) => { plugin = obj; } },
  document: { getElementById: $ },
  AbortController,
});
assert.ok(plugin, 'plugin captured');

const clips = [];
const ctx = {
  _state: { zstackActive: false, zstackCurrentSlice: 0, suppressZstackSync: false },
  iframe: { isIframe: () => false, postMessage() {}, panelIndex: () => 0 },
  viewer: {
    setClipRange_z: (lo, hi) => clips.push([lo, hi]),
    setView: () => ({ spinDeg: 0 }),
    setRotationLocked() {},
    resetClipping() {},
  },
  dataset: { getMeta: () => ({ dimensions: { z: 20, c: 1 }, voxel_size: { z: 1 } }) },
  ui: { scheduleResize() {}, openStudio() {} },
  i18n: { t: (k) => k, getLanguage: () => 'en', onLanguageChange: () => {} },
};
plugin.init(ctx);
plugin.activate();
assert.equal(plugin._mode, '3d');

const key = (k, mods = {}) => {
  const ev = { key: k, shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, prevented: false, ...mods };
  ev.preventDefault = () => { ev.prevented = true; };
  for (const fn of $('zstack-vslider').listeners.keydown || []) fn(ev);
  return ev;
};
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg}: ${a} vs ${b}`);

// ── upper trim: Shift+↓ trims one more slice from above ─────────────────────
let ev = key('ArrowDown', { shiftKey: true });
assert.ok(ev.prevented, 'Shift+↓ is consumed');
assert.equal(plugin._cropLo, 1);
assert.equal(plugin._cropHi, 19);
near(clips.at(-1)[0], 1 / 20, '3D clip follows the upper trim');
key('ArrowDown', { shiftKey: true });
key('ArrowDown', { shiftKey: true });
assert.equal(plugin._cropLo, 3);
key('ArrowUp', { shiftKey: true });
assert.equal(plugin._cropLo, 2, 'Shift+↑ gives a slice back');
for (let i = 0; i < 10; i += 1) key('ArrowUp', { shiftKey: true });
assert.equal(plugin._cropLo, 0, 'the upper trim stops at the first slice');
assert.equal(plugin._mode, '3d', 'trimming does not leave the 3D notch');

// ── lower trim: Alt+↑ trims one more slice from below ───────────────────────
key('ArrowUp', { altKey: true });
key('ArrowUp', { altKey: true });
assert.equal(plugin._cropHi, 17);
near(clips.at(-1)[1], 18 / 20, '3D clip follows the lower trim');
for (let i = 0; i < 10; i += 1) key('ArrowDown', { altKey: true });
assert.equal(plugin._cropHi, 19, 'the lower trim stops at the last slice');

// ── the two trims never cross ───────────────────────────────────────────────
for (let i = 0; i < 40; i += 1) key('ArrowDown', { shiftKey: true });
assert.equal(plugin._cropLo, 19, 'the upper trim stops on the lower one');
for (let i = 0; i < 40; i += 1) key('ArrowUp', { altKey: true });
assert.equal(plugin._cropHi, 19, 'the lower trim cannot pass the upper one');
assert.ok(plugin._cropLo <= plugin._cropHi);
for (let i = 0; i < 40; i += 1) key('ArrowUp', { shiftKey: true });
assert.equal(plugin._cropLo, 0);

// ── the cursor follows the kept range ───────────────────────────────────────
key('ArrowDown', { shiftKey: true });
key('ArrowDown', { shiftKey: true });
key('ArrowDown'); // into the track, on the first kept slice
assert.equal(plugin._mode, 'slice');
assert.equal(plugin._lo, 2, 'the cursor lands on the first kept slice');
key('ArrowDown', { shiftKey: true });
key('ArrowDown', { shiftKey: true });
assert.equal(plugin._lo, 4, 'a trim passing the cursor pushes it into the kept range');

// ── other modifier combinations are not the trims' ──────────────────────────
const before = [plugin._cropLo, plugin._cropHi];
ev = key('ArrowDown', { shiftKey: true, altKey: true });
assert.deepEqual([plugin._cropLo, plugin._cropHi], before, 'Shift+Alt moves no trim');
ev = key('ArrowDown', { shiftKey: true, ctrlKey: true });
assert.deepEqual([plugin._cropLo, plugin._cropHi], before, 'Ctrl+Shift moves no trim');
const cursor = plugin._lo;
key('ArrowDown');
assert.equal(plugin._lo, cursor + 1, 'a plain arrow still moves the cursor');

// ── the notch button: keyboard click returns to 3D, pointer click is the drag's ─
assert.equal(plugin._mode, 'slice');
const notchClick = (detail) => { for (const fn of $('zstack-notch').listeners.click || []) fn({ detail }); };
assert.ok(($('zstack-notch').listeners.click || []).length > 0, 'the notch has a click listener');
notchClick(1);
assert.equal(plugin._mode, 'slice', 'a pointer click is left to the drag code');
notchClick(0);
assert.equal(plugin._mode, '3d', 'Enter / Space on the notch shows every kept slice');

// ── the slider describes its keys, in every locale ──────────────────────────
assert.equal($('zstack-vslider').attrs['aria-description'], 'keysHelp');
for (const lang of ['en', 'fr', 'es', 'nl']) {
  const dict = JSON.parse(readFileSync(path.join(ROOT, `js/modules/tools/zstack-browser/lang/${lang}.json`), 'utf8'));
  assert.ok(typeof dict.keysHelp === 'string' && dict.keysHelp.length > 20, `${lang}: keysHelp`);
  assert.match(dict.trimAboveTitle, /↑\/↓/, `${lang}: the upper trim title names its keys`);
  assert.match(dict.trimBelowTitle, /Alt\+↑\/↓/, `${lang}: the lower trim title names its keys`);
}

console.log('test_zstack_keyboard_trim: OK');
