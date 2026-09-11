// Unit tests for the Z-stack browser's state model (js/modules/tools/zstack-browser):
//   • opening lands on the 3D notch: every kept slice, rotation free, no slice index;
//   • the cursor shows [lo, lo+thickness) and locks the view top-down once;
//   • the trim handles bound both the 3D view and where the cursor can go;
//   • the notch is one stop above the first kept slice for prev/next;
//   • SYNC_ZSTACK_SLICE carries mode/cursor/thickness/trim and is mirrored by
//     depth fraction when the sibling stack has another slice count;
//   • workspace state round-trips, and a pre-1.51 state (slice only) still restores;
//   • pointer drags on the custom slider (handles, grips, cursor, notch);
//   • the ray-marcher confines the march to the clip box (structural).
//
// Run: node tests/js/test_zstack_slab.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { loadModule, ROOT } from './harness.mjs';

// ── minimal DOM: one element per id, recording style/class/attributes ─────────
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
    closest: (sel) => (sel.slice(1).split(',').some((c) => classes.has(c.trim().replace(/^\./, ''))) ? el : null),
    width: 200, height: 280,
  };
  return el;
};
const classFor = {
  'zstack-notch': 'zs-notch', 'zstack-track': 'zs-track', 'zstack-cursor': 'zs-cursor',
  'zstack-handle-top': 'zs-handle-top', 'zstack-handle-bottom': 'zs-handle-bottom',
};
const $ = (id) => {
  if (!elements.has(id)) {
    const el = makeEl(id);
    if (classFor[id]) el.classList.add(classFor[id]);
    elements.set(id, el);
  }
  return elements.get(id);
};
const gripTop = makeEl('grip-top'); gripTop.classList.add('zs-grip-top');
const gripBottom = makeEl('grip-bottom'); gripBottom.classList.add('zs-grip-bottom');

let plugin = null;
loadModule('js/modules/tools/zstack-browser/index.js', 'ZNone', {
  PluginRegistry: { implement: (_id, obj) => { plugin = obj; } },
  document: { getElementById: $ },
  AbortController,
});
assert.ok(plugin, 'plugin captured');

const calls = [];
const broadcasts = [];
let meta = { dimensions: { z: 100, c: 2 }, voxel_size: { z: 2 } };
const ctx = {
  _state: { zstackActive: false, zstackCurrentSlice: 0, suppressZstackSync: false },
  iframe: { isIframe: () => true, postMessage: (m) => broadcasts.push(m), panelIndex: () => 0 },
  viewer: {
    setClipRange_z: (lo, hi) => calls.push(['clip', lo, hi]),
    setView: (v) => calls.push(['view', v]),
    setRotationLocked: (v) => calls.push(['lock', v]),
    resetClipping: () => calls.push(['resetClip']),
  },
  dataset: { getMeta: () => meta },
  ui: { scheduleResize() {}, openStudio() {} },
  i18n: { t: (k, p) => `${k}${p ? ':' + JSON.stringify(p) : ''}`, getLanguage: () => 'en', onLanguageChange: () => {} },
};
plugin.init(ctx);
const lastClip = () => calls.filter((c) => c[0] === 'clip').at(-1);
const count = (kind) => calls.filter((c) => c[0] === kind).length;
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg}: ${a} vs ${b}`);

// ── 1. opening lands on the 3D notch ──────────────────────────────────────────
plugin.activate();
assert.equal(ctx._state.zstackActive, true);
assert.equal(plugin._mode, '3d', 'opens in 3D mode');
assert.equal(ctx._state.zstackCurrentSlice, -1, 'no slice index in 3D mode');
near(lastClip()[1], 0, '3D clip lo'); near(lastClip()[2], 1, '3D clip hi');
assert.equal(count('view'), 0, '3D mode does not force the XY view');
assert.equal(count('lock'), 0, '3D mode leaves rotation free');
assert.ok($('zstack-vslider').classList.contains('zs-mode-3d'), 'slider carries the 3D class');
assert.equal($('zstack-slice-label').textContent, 'notch', 'readout shows the notch label');
assert.equal(broadcasts.at(-1).mode, '3d', 'opening broadcasts the 3D mode');
assert.ok($('btn-zstack-prev').disabled && !$('btn-zstack-next').disabled, 'only "next" leaves the notch');

// ── 2. the cursor shows [lo, lo+thickness) and locks the view once ────────────
plugin._goToSlice(12);
assert.equal(plugin._mode, 'slice');
assert.equal(ctx._state.zstackCurrentSlice, 12);
near(lastClip()[1], 12 / 100, 'slice clip lo'); near(lastClip()[2], 13 / 100, 'slice clip hi (one slice)');
assert.deepEqual(calls.filter((c) => c[0] === 'view'), [['view', 'xy']], 'entering slice mode sets the XY view');
assert.equal(count('lock'), 1);
assert.equal($('zstack-cursor').style.top, '12.0000%');
assert.equal($('zstack-cursor').style.height, '1.0000%');
assert.equal($('zstack-slice-label').textContent, '13 / 100', '1-based readout');
plugin._goToSlice(13);
assert.equal(count('view'), 1, 'moving the cursor does not re-snap the view');

plugin._setThickness(5);
assert.equal(plugin._lo, 13, 'thickness grows from the cursor top edge');
near(lastClip()[1], 13 / 100, 'slab lo'); near(lastClip()[2], 18 / 100, 'slab hi');
assert.equal(ctx._state.zstackCurrentSlice, 15, 'centre of a 5-slice slab');
assert.equal($('zstack-slice-label').textContent, '14–18 / 100');
assert.equal($('zstack-thickness-um').textContent, '10.00 µm');
plugin._goToSlice(15);
assert.equal(plugin._lo, 13, 'goToSlice centres the slab: round trip is stable');

// ── 3. the trim handles bound the 3D view and the cursor ──────────────────────
plugin.applySync({ sliceTotal: 100, mode: '3d', crop: [10, 49], thickness: 5 });
assert.equal(plugin._mode, '3d');
near(lastClip()[1], 0.10, 'trimmed 3D clip lo'); near(lastClip()[2], 0.50, 'trimmed 3D clip hi');
assert.equal(count('lock'), 2, 'back to 3D releases the rotation lock');
assert.deepEqual(calls.filter((c) => c[0] === 'lock').at(-1), ['lock', false]);
assert.equal($('zstack-mask-top').style.height, '10.0000%');
assert.equal($('zstack-mask-bottom').style.height, '50.0000%');
assert.equal($('zstack-handle-bottom').style.top, '50.0000%');
assert.ok(!$('zstack-crop-row').classList.contains('zs-full'), 'trim reset button shown');
assert.equal(plugin.getStudioSliceIndex(), 29, 'Studio takes the middle of the kept range in 3D');

plugin._setCursor(0);
assert.equal(plugin._lo, 10, 'cursor cannot enter the trimmed slices above');
plugin._setCursor(500);
assert.equal(plugin._lo, 45, 'cursor cannot enter the trimmed slices below (45..49)');
plugin._setThickness(999);
assert.equal(plugin._thickness, 40, 'thickness capped to the kept range');
assert.equal(plugin._lo, 10);
plugin._setThickness(1);
plugin._setCursor(30);
plugin.applySync({ sliceTotal: 100, mode: 'slice', cursor: 30, thickness: 1, crop: [35, 49] });
assert.equal(plugin._lo, 35, 'moving the top trim below the cursor pushes the cursor down');

// ── 4. the notch is one stop above the first kept slice ───────────────────────
plugin._setCursor(35);
plugin._nudge(-1);
assert.equal(plugin._mode, '3d', 'prev from the first kept slice parks in the notch');
plugin._nudge(-1);
assert.equal(plugin._mode, '3d', 'prev in the notch stays there');
plugin._nudge(1);
assert.equal(plugin._mode, 'slice');
assert.equal(plugin._lo, 35, 'next from the notch lands on the first kept slice');
plugin._nudge(1);
assert.equal(plugin._lo, 36);
plugin._resetCrop();
assert.equal(plugin._cropLo, 0); assert.equal(plugin._cropHi, 99);
assert.ok($('zstack-crop-row').classList.contains('zs-full'));

// ── 5. sync payload + mirroring by depth fraction ─────────────────────────────
broadcasts.length = 0;
plugin._setThickness(4);
plugin._setCursor(20);
const msg = broadcasts.at(-1);
assert.equal(msg.type, 'SYNC_ZSTACK_SLICE');
// Arrays built inside the vm realm have another Array.prototype: copy before comparing.
assert.deepEqual(
  { mode: msg.mode, cursor: msg.cursor, thickness: msg.thickness, crop: [...msg.crop], sliceIndex: msg.sliceIndex, sliceTotal: msg.sliceTotal },
  { mode: 'slice', cursor: 20, thickness: 4, crop: [0, 99], sliceIndex: 21, sliceTotal: 100 }
);
near(msg.lo, 0.20, 'sync lo'); near(msg.hi, 0.24, 'sync hi');
ctx._state.suppressZstackSync = true;
broadcasts.length = 0;
plugin.applySync({ sliceTotal: 200, mode: 'slice', cursor: 100, thickness: 8, crop: [20, 179], sliceIndex: 103 });
ctx._state.suppressZstackSync = false;
assert.equal(broadcasts.length, 0, 'a mirrored sync is silent');
assert.equal(plugin._lo, 50, 'cursor mapped by depth fraction (100/200 → 50/100)');
assert.equal(plugin._thickness, 4, 'thickness mapped by depth fraction');
assert.deepEqual([plugin._cropLo, plugin._cropHi], [10, 90], 'trim mapped by depth fraction');
plugin.applySync({ sliceTotal: 100, sliceIndex: 40 });
assert.equal(plugin._mode, 'slice');
assert.equal(ctx._state.zstackCurrentSlice, 40, 'a pre-1.51 payload (slice only) centres the cursor on it');

// ── 6. workspace state round trip + pre-1.51 state ────────────────────────────
plugin.applySync({ sliceTotal: 100, mode: 'slice', cursor: 33, thickness: 3, crop: [5, 80] });
const saved = plugin.getState();
const plain = (s) => JSON.parse(JSON.stringify(s));
assert.deepEqual(plain(saved), { zstackActive: true, zstackSlice: 34, mode: 'slice', cursor: 33, thickness: 3, crop: [5, 80] });
plugin.reset();
assert.equal(ctx._state.zstackActive, false);
assert.equal(plugin._mode, '3d'); assert.equal(plugin._thickness, 1);
assert.deepEqual(calls.at(-1), ['resetClip'], 'closing resets the clip');
plugin.setState(saved);
assert.equal(ctx._state.zstackActive, true);
assert.deepEqual(plugin.getState(), saved, 'state round-trips');
plugin.setState({ zstackActive: true, zstackSlice: 7 });
assert.equal(plugin._mode, 'slice');
assert.equal(ctx._state.zstackCurrentSlice, 7, 'legacy state restores slice mode on its slice');
assert.equal(plugin._thickness, 1);
plugin.setState({ zstackActive: true, zstackSlice: -1 });
assert.equal(plugin._mode, '3d', 'legacy 3D marker (-1) restores the notch');
assert.equal(plugin.isSliceMode(), false);

// ── 7. pointer drags on the custom slider ────────────────────────────────────
const down = (target, clientY) => plugin._startDrag({ button: 0, target, clientY, pointerId: 1, preventDefault() {} });
const move = (clientY) => plugin._dragTo({ clientY });
plugin._resetFields(); plugin._apply();
down($('zstack-handle-top'), 0); move(20); plugin._endDrag();
assert.equal(plugin._cropLo, 20, 'top handle at y=20% trims 20 slices above');
down($('zstack-handle-bottom'), 100); move(70); plugin._endDrag();
assert.equal(plugin._cropHi, 69, 'bottom handle at y=70% trims 30 slices below');
down($('zstack-track'), 40.5); plugin._endDrag();
assert.equal(plugin._mode, 'slice'); assert.equal(plugin._lo, 40, 'click on the track puts the cursor under the pointer');
down(gripBottom, 41); move(46); plugin._endDrag();
assert.equal(plugin._thickness, 6, 'dragging the bottom grip thickens the bar downwards');
assert.equal(plugin._lo, 40);
down(gripTop, 40); move(38); plugin._endDrag();
assert.equal(plugin._lo, 38); assert.equal(plugin._thickness, 8, 'dragging the top grip thickens the bar upwards');
down($('zstack-cursor'), 42.5); move(52.5);
assert.equal(plugin._lo, 48, 'dragging the bar moves it by the pointer travel');
move(-20);
assert.equal(plugin._mode, '3d', 'dragging the bar above the track parks it in the notch');
move(60.5);
assert.equal(plugin._mode, 'slice'); assert.equal(plugin._lo, 56, 'dragging back down resumes slice mode, keeping the grab offset (60 - 4)');
plugin._endDrag();
down($('zstack-notch'), -5);
assert.equal(plugin._mode, '3d', 'the notch is a click stop');
move(30.5); plugin._endDrag();
assert.equal(plugin._mode, 'slice', 'dragging down from the notch enters the track');
assert.equal(plugin._lo, 30 - Math.floor((plugin._thickness - 1) / 2));
plugin._onKey({ key: 'Home', preventDefault() {} });
assert.equal(plugin._mode, '3d', 'Home parks in the notch');
plugin._onKey({ key: 'End', preventDefault() {} });
assert.equal(plugin._lo + plugin._thickness - 1, plugin._cropHi, 'End puts the bar on the last kept slice');

// ── 8. a smaller stack: everything clamps to the new depth ───────────────────
meta = { dimensions: { z: 30, c: 1 }, voxel_size: { z: 1 } };
plugin.setState({ zstackActive: true, mode: 'slice', cursor: 80, thickness: 10, crop: [20, 90] });
assert.deepEqual([plugin._cropLo, plugin._cropHi, plugin._lo, plugin._thickness], [20, 29, 20, 10]);

// ── 9. the ray-marcher confines the march to the clip box ─────────────────────
const shader = readFileSync(path.join(ROOT, 'js/viewers/volume-viewer.js'), 'utf8');
assert.ok(/vec2 hitClipBox\(vec3 orig, vec3 dir\)/.test(shader), 'hitClipBox declared');
assert.ok(/vec2 clipT = hitClipBox\(vOrigin, rayDir\);\s*bounds\.x = max\(bounds\.x, clipT\.x\);\s*bounds\.y = min\(bounds\.y, clipT\.y\);/.test(shader), 'ray bounds intersected with the clip box');
assert.ok(/float slabGain = max\(1\.0, 1\.0 \/ \(rayLength \* max\(absorption, 1\.0 \/ fullLength\)\)\);/.test(shader), 'slab normalisation formula');
assert.ok(/emissionGain \* exposure \* delta \* slabGain/.test(shader), 'natural-fluorescence emission uses the slab gain');
assert.ok(/accumAlpha \+= localAlpha \* 0\.05 \* dvrW;/.test(shader), 'structure DVR uses the per-sample weight');

// ── 10. the Studio gets the slab on screen, not a single plane ───────────────
meta = { dimensions: { z: 100, c: 2 }, voxel_size: { z: 2 } };
plugin.reset(); plugin.activate();
plugin.applySync({ sliceTotal: 100, mode: 'slice', cursor: 40, thickness: 5, crop: [10, 89] });
assert.deepEqual(plain(plugin.getStudioSliceRange()), { lo: 40, hi: 44 }, 'slice mode: the cursor bar');
assert.equal(plugin.getStudioSliceIndex(), 42, 'and its centre');
plugin._enter3d();
assert.deepEqual(plain(plugin.getStudioSliceRange()), { lo: 10, hi: 89 }, '3D mode: the whole kept range');
const viewerSrc = readFileSync(path.join(ROOT, 'js/pages/viewer.js'), 'utf8');
assert.ok(/function _zstackStudioSpec\(\)/.test(viewerSrc), 'viewer builds the Studio plane from the browser');
assert.ok(/getStudioSliceRange/.test(viewerSrc), 'viewer asks the browser for the slice range');
assert.ok(/value: \(lo \+ n \/ 2\) \/ z,/.test(viewerSrc), 'plane centred on the slab');
assert.ok(/slabThickness: n,\s*slabStepNorm: 1 \/ z,\s*projection: n > 1 \? 'mip' : 'single'/.test(viewerSrc), 'one sample per slice, MIP when thicker than one slice');
assert.ok(/_renderStudioPreviewSlice\(_zstackStudioSpec\(\)\)/.test(viewerSrc), 'Studio opens on that plane (then upgrades to native)');
assert.ok(/const spec = options\.spec \|\| VolumeSlicer\.getPlaneSpec\(\);/.test(viewerSrc), 'native pass renders the same plane');
assert.ok(/bricks = BrickLoader\.bricksForRegion\(min, max, 0\);/.test(viewerSrc), 'native pass loads every brick of a projected slab');
const slicerSrc = readFileSync(path.join(ROOT, 'js/viewers/volume-slicer.js'), 'utf8');
assert.ok(/const MAX_SLAB_STEPS = 1024;/.test(slicerSrc) && /for \(int i = 0; i < 1024; i\+\+\)/.test(slicerSrc), 'slicer slab can span a whole stack');
assert.ok(/delta = stepNorm \/ \(normal\.length\(\) \|\| 1\);/.test(slicerSrc), 'slicer honours a requested sample spacing');
assert.ok(!/Math\.min\(64, /.test(slicerSrc), 'no stale 64-step cap left in the slicer');

console.log('zstack-browser slab/notch/trim model + clip-box ray march + Studio slab: OK');
