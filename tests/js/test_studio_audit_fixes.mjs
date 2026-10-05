// Studio and compositor fixes (js/components/studio-editor.js, js/core/slice-compositor.js):
//   • a document token scopes the native pass: a pass left over from a closed document
//     can neither clear the next one's progress bar and cancel hook nor draw into it,
//     and a late refresh never re-opens a closed Studio;
//   • close() gives back the native-size canvas, the history, the cells' frames and
//     slices, and the pointer state of a gesture cut short;
//   • the wheel zooms about the cursor (rotation included);
//   • pointer streams draw once per animation frame, hovering draws only when the lit
//     handle changes, and the minimap thumbnail is made once per picture;
//   • a Compare figure's cell buttons are built once and only moved by pan / zoom;
//   • a channel edit is a history step (a drag coalesced into one), a plain click on a
//     layer leaves history and redo alone;
//   • snapping applies one correction per axis; tool letters ignore Ctrl / Meta / Alt;
//   • a slice without raw values keeps its frame when re-coloured (one crop window);
//   • a calibration is normalised, a result of another size re-scales the layers;
//   • JSON import limits, PNG export size guard and a null blob reported;
//   • SliceCompositor: a slot is refilled with texSubImage2D, the GL canvas only grows
//     (source rect read back), the CPU path reuses its ImageData.
//
// The module runs for real in a vm; a hook is spliced in before its `return {` (the
// source file is not modified) to reach the closure's functions and state.
//
// Run: node tests/js/test_studio_audit_fixes.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { loadModule, ROOT } from './harness.mjs';

const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const SRC = read('js/components/studio-editor.js');
const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg}: ${a} vs ${b}`);

// ── A browser-ish realm with controllable frames and timers ──────────────────
let clock = 1000;
const timers = new Map();
let timerId = 0;
const rafs = new Map();
let rafId = 0;
const runRafs = () => { const list = [...rafs.values()]; rafs.clear(); list.forEach(fn => fn(0)); };
const runTimers = () => { const list = [...timers.values()]; timers.clear(); list.forEach(fn => fn()); };

const created = [];
let blobIsNull = false;
let getImageDataCalls = 0;
function makeEl(tag = 'el') {
  const log = [];
  const listeners = {};
  const stubs = {};
  const el = {
    tag, width: 0, height: 0, style: {}, dataset: {}, id: '', title: '', innerHTML: '', textContent: '', value: '',
    log, listeners, parentElement: null, children: [], removed: false, __alphaBox: null,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    removeEventListener() {},
    fire(type, event = {}) { (listeners[type] || []).forEach(fn => fn({ target: el, ...event })); },
    appendChild(child) { child.parentElement = el; el.children.push(child); },
    remove() { el.removed = true; if (el.parentElement) el.parentElement.children = el.parentElement.children.filter(c => c !== el); el.parentElement = null; },
    setAttribute() {}, focus() {}, select() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
    querySelector: (sel) => (stubs[sel] ||= makeEl(`stub ${sel}`)),
    querySelectorAll: () => [],
    toBlob(cb) { cb(blobIsNull ? null : { fakeBlob: true }); },
  };
  const ctx = new Proxy({}, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (prop === 'measureText') return (text) => ({ width: String(text).length * 10 });
      if (prop === 'getImageData') return (x, y, w, h) => {
        getImageDataCalls++;
        const data = new Uint8ClampedArray(w * h * 4);
        const b = el.__alphaBox;
        if (b) for (let yy = b.y0; yy <= b.y1; yy++) for (let xx = b.x0; xx <= b.x1; xx++) data[(yy * w + xx) * 4 + 3] = 255;
        return { data };
      };
      return (...a) => log.push([prop, ...a]);
    },
    set(target, prop, value) { target[prop] = value; return true; },
  });
  el.getContext = (kind) => (kind === '2d' ? ctx : null);
  return el;
}

const elements = {
  'studio-layout': makeEl('studio-layout'),
  'studio-canvas': makeEl('studio-canvas'),
  'studio-workspace': makeEl('studio-workspace'),
  'studio-channels': makeEl('studio-channels'),
  'studio-properties': makeEl('studio-properties'),
};
const composeCalls = [];
const SliceCompositor = {
  isRaw: (raw) => Boolean(raw && ArrayBuffer.isView(raw.data) && raw.data.length >= raw.width * raw.height * 4),
  compose(raw, state, options) {
    composeCalls.push({ raw, state: JSON.parse(JSON.stringify(state)), options });
    const target = options?.target || makeEl('compose');
    target.width = raw.width;
    target.height = raw.height;
    return target;
  },
  histograms: () => [],
  release() {},
};
const recomposeCalls = [];
const VolumeSlicer = {
  // A slice without raw values re-rendered: the whole frame at `width`, whose visible
  // box shrinks when channel 0's max is lowered (what moved a re-found crop).
  recompose(sliceResult, state) {
    recomposeCalls.push({ width: sliceResult.width, state });
    const c = makeEl('recomposed');
    c.width = sliceResult.width;
    c.height = sliceResult.width;
    const m = Number(state?.[0]?.max ?? 1);
    c.__alphaBox = m < 0.6 ? { x0: 70, y0: 80, x1: 90, y1: 100 } : { x0: 60, y0: 70, x1: 99, y1: 99 };
    return { ...sliceResult, canvas: c, width: c.width, height: c.height };
  },
};
const toasts = [];
const downloads = [];
const panel = { inits: 0, callback: null };
const sandbox = {
  console, encodeURIComponent, Math, JSON, Date, ArrayBuffer, Uint8Array, Uint8ClampedArray, WeakRef,
  setTimeout: (fn) => { const id = ++timerId; timers.set(id, fn); return id; },
  clearTimeout: (id) => { timers.delete(id); },
  requestAnimationFrame: (fn) => { const id = ++rafId; rafs.set(id, fn); return id; },
  cancelAnimationFrame: (id) => { rafs.delete(id); },
  performance: { now: () => clock },
  SliceCompositor,
  VolumeSlicer,
  I18n: { t: (k) => k, translateDOM() {} },
  ExportManager: { downloadBlob: (blob, name) => downloads.push({ blob, name }), toast: (t) => toasts.push(t) },
  createChannelPanel: () => ({
    init(id, meta, cb) { panel.inits++; panel.callback = cb; },
    setState() {}, setHistograms() {},
  }),
  document: {
    getElementById: (id) => elements[id] || null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    createElement: (tag) => { const el = makeEl(tag); created.push(el); return el; },
    body: { appendChild() {} },
  },
  window: { innerWidth: 800, innerHeight: 600, addEventListener() {} },
};

const RETURN_RE = /\n  return \{\n    init,/;
assert.ok(RETURN_RE.test(SRC), 'studio-editor.js still ends its IIFE with `return { init, …`');
const FNS = ['_onWheel', '_onPointerDown', '_onPointerMove', '_onPointerUp', '_onKeyDown', '_screenToImage', '_imageToScreen',
  '_pushHistory', '_undo', '_redo', '_applySnapping', '_importDocumentText', '_importJson', '_exportPng', '_lineLengthUm',
  '_measurementLabel'];
const HOOK = `
  globalThis.__studio = {
    get doc() { return _doc; },
    get history() { return _history; },
    get future() { return _future; },
    get sliceImage() { return _sliceImage; },
    get sliceResult() { return _sliceResult; },
    get progressOnCancel() { return _progressOnCancel; },
    get activeTool() { return _activeTool; },
    get touchCount() { return _touchPointers.size; },
    get drawing() { return _drawing; },
    get isPanning() { return _isPanning; },
    get menuButtons() { return _compareMenuButtons; },
    setState(s) { if ('selectedId' in s) _selectedId = s.selectedId; if ('activeTool' in s) _activeTool = s.activeTool; },
    fns: { ${FNS.join(', ')} }
  };`;
const ctx = vm.createContext(sandbox);
vm.runInContext(SRC.replace(RETURN_RE, (m) => `\n${HOOK}${m}`) + '\n;globalThis.__SE = StudioEditor;', ctx, { filename: 'studio-editor.js' });
const { __SE: Studio, __studio: S } = ctx;
const F = S.fns;
Studio.init();

const canvas = elements['studio-canvas'];
const pictureDraws = () => canvas.log.filter(e => e[0] === 'drawImage' && e[1] === S.sliceImage).length;
const state = [{ color: '#ff0000', min: 0, max: 1, gamma: 1, opacity: 1, enabled: true }];
const mkRaw = (w, h) => ({ data: new Uint8Array(w * h * 4), width: w, height: h, channels: 1 });
const openSingle = (w = 200, h = 100, extra = {}) => Studio.open({
  canvas: makeEl('viewer'), raw: mkRaw(w, h), width: w, height: h, source: 'studio-preview',
  planeSpec: { mode: 'xy' }, pixelSizeUm: { x: 2, y: 2 }, channelState: state, ...extra,
});
const ev = (x, y, more = {}) => ({ clientX: x, clientY: y, pointerId: 1, pointerType: 'mouse', button: 0, preventDefault() {}, ...more });

// ── Document token: a stale native pass is not heard ─────────────────────────
{
  const t1 = openSingle();
  assert.ok(Number.isInteger(t1) && t1 === Studio.documentToken(), 'open() returns the document token');
  const cancels = [];
  Studio.setLoadProgress({ percent: 10, label: 'A', onCancel: () => cancels.push('A') }, { token: t1 });
  Studio.close();
  assert.deepEqual(cancels, ['A'], 'closing cancels the pass of the open document');
  const t2 = openSingle();
  assert.notEqual(t2, t1, 'a new document, a new token');
  const onCancelB = () => cancels.push('B');
  Studio.setLoadProgress({ percent: 5, label: 'B', onCancel: onCancelB }, { token: t2 });
  Studio.setLoadProgress(null, { token: t1 });
  assert.equal(S.progressOnCancel, onCancelB, 'the finished pass A cannot clear pass B\'s cancel hook');
  const shown = S.sliceResult.raw;
  Studio.setSliceResult({ raw: mkRaw(200, 100), width: 200, height: 100 }, { imageOnly: true, token: t1 });
  assert.equal(S.sliceResult.raw, shown, 'nor draw its picture into the new document');
  Studio.setSliceResult({ raw: mkRaw(200, 100), width: 200, height: 100 }, { imageOnly: true, token: t2 });
  assert.notEqual(S.sliceResult.raw, shown, 'the pass of the open document is heard');
  Studio.close();
  assert.deepEqual(cancels, ['A', 'B']);
  Studio.setSliceResult({ raw: mkRaw(200, 100), width: 200, height: 100 }, { imageOnly: true });
  assert.equal(Studio.isOpen(), false, 'a late refresh never re-opens a closed Studio');
  Studio.setSliceResult({ raw: mkRaw(200, 100), width: 200, height: 100 }, { reopen: true });
  assert.equal(Studio.isOpen(), true, '… unless asked to');
  Studio.close();
  console.log('document token scopes progress, cancel hook and refreshes: OK');
}

// ── close() drops the pointer state of a gesture cut short ───────────────────
{
  openSingle();
  F._onPointerDown(ev(100, 100, { pointerType: 'touch', pointerId: 7 }));
  assert.equal(S.touchCount, 1);
  Studio.close();
  assert.equal(S.touchCount, 0, 'no ghost finger survives a close');
  openSingle();
  F._onPointerDown(ev(400, 300, { button: 1 }));
  assert.equal(S.isPanning, true);
  openSingle();
  assert.equal(S.isPanning, false, 'a new document starts with no gesture');
  Studio.close();
  console.log('pointer state reset on open / close: OK');
}

// ── Wheel zoom about the cursor, the view turned or not ──────────────────────
{
  openSingle();
  for (const rotation of [0, 0.7, -2.1]) {
    Object.assign(S.doc.viewport, { zoom: 1.3, panX: 410, panY: 290, rotation });
    for (const deltaY of [-1, 1, -1]) {
      const before = F._screenToImage({ x: 250, y: 180 });
      F._onWheel({ preventDefault() {}, clientX: 250, clientY: 180, deltaY });
      const after = F._screenToImage({ x: 250, y: 180 });
      near(after.x, before.x, 1e-9, `rotation ${rotation}: the image point under the cursor stays (x)`);
      near(after.y, before.y, 1e-9, `rotation ${rotation}: the image point under the cursor stays (y)`);
    }
  }
  Studio.close();
  console.log('wheel zoom anchored at the cursor: OK');
}

// ── One draw per frame; hovering draws only when the lit handle changes ──────
{
  openSingle();
  runRafs(); runTimers();
  const d0 = pictureDraws();
  for (let i = 0; i < 10; i++) F._onPointerMove(ev(20 + i, 20));
  assert.equal(pictureDraws(), d0, 'hovering empty space draws nothing');
  assert.equal(rafs.size, 0, '… and asks for no frame');
  F._onPointerDown(ev(400, 300, { button: 1 }));
  const pan0 = S.doc.viewport.panX;
  for (let i = 1; i <= 25; i++) F._onPointerMove(ev(400 + i, 300));
  assert.equal(S.doc.viewport.panX, pan0 + 25, 'every move updates the view');
  assert.equal(pictureDraws(), d0, 'no draw inside the frame');
  assert.equal(rafs.size, 1, 'one frame asked for 25 moves');
  runRafs();
  assert.equal(pictureDraws(), d0 + 1, 'one draw for the frame');
  assert.equal(timers.size, 0, 'the backstop timer is cancelled by the frame');
  F._onPointerMove(ev(450, 300));
  runTimers();
  assert.equal(pictureDraws(), d0 + 2, 'the backstop timer draws when frames do not run (hidden page)');
  F._onPointerUp(ev(450, 300));
  rafs.clear();
  Studio.close();
  console.log('pointer streams coalesced: OK');
}

// ── Minimap thumbnail made once per picture ───────────────────────────────────
{
  openSingle();
  const minimap = elements['studio-workspace'].children.find(c => c.id === 'studio-minimap');
  assert.ok(minimap, 'the minimap exists');
  const thumbDraws = () => created.filter(c => c.tag === 'canvas').reduce((n, c) => n + c.log.filter(e => e[0] === 'drawImage' && e[1] === S.sliceImage).length, 0);
  const t0 = thumbDraws();
  F._onPointerDown(ev(400, 300, { button: 1 }));
  for (let i = 0; i < 5; i++) { F._onPointerMove(ev(400 + i, 300)); runRafs(); }
  F._onPointerUp(ev(405, 300));
  assert.equal(thumbDraws(), t0, 'panning never resamples the picture into the minimap again');
  assert.ok(minimap.log.filter(e => e[0] === 'drawImage').every(e => e[1] !== S.sliceImage), 'the minimap draws the thumbnail, never the full picture');
  Studio.close();
  console.log('minimap thumbnail cached: OK');
}

// ── A plain click leaves history and redo alone; a drag is one step ──────────
{
  openSingle();
  S.doc.layers.push({ id: 'r1', type: 'rectangle', rotation: 0, x: 50, y: 30, w: 40, h: 20, style: {}, visible: true, locked: false });
  F._pushHistory('Add rectangle');
  S.doc.layers[0].x = 60;
  F._pushHistory('Edit layer');
  F._undo();
  assert.equal(S.future.length, 1, 'one step to redo');
  const len = S.history.length;
  const c = F._imageToScreen({ x: 70, y: 40 });
  F._onPointerDown(ev(c.x, c.y));
  F._onPointerUp(ev(c.x, c.y));
  assert.equal(S.history.length, len, 'a click selects: no history step');
  assert.equal(S.future.length, 1, '… and the redo stack is kept');
  F._onPointerDown(ev(c.x, c.y));
  F._onPointerMove(ev(c.x + 30, c.y));
  F._onPointerUp(ev(c.x + 30, c.y));
  assert.equal(S.history.length, len + 1, 'a drag is one step');
  assert.equal(S.future.length, 0);
  Studio.close();
  console.log('plain click is not an edit: OK');
}

// ── Channel edits are history steps ───────────────────────────────────────────
{
  openSingle();
  const channels = () => S.doc.channelState[0].max;
  const base = S.history.length;
  clock += 100;
  panel.callback(0, { ...state[0], max: 0.5 });
  clock += 16;
  panel.callback(0, { ...state[0], max: 0.4 });
  assert.equal(S.history.length, base + 1, 'a drag of one control is one step');
  assert.equal(S.history.at(-1).label, 'Edit channels');
  assert.equal(S.history.at(-1).doc.channelState[0].max, 0.4, 'the step holds the last value of the drag');
  elements['studio-channels'].fire('change');
  clock += 100;
  panel.callback(0, { ...state[0], max: 0.3 });
  assert.equal(S.history.length, base + 2, 'a new gesture after the control released is a new step');
  S.doc.layers.push({ id: 'r2', type: 'rectangle', rotation: 0, x: 5, y: 5, w: 10, h: 10, style: {}, visible: true, locked: false });
  F._pushHistory('Add rectangle');
  composeCalls.length = 0;
  F._undo();
  assert.equal(S.doc.layers.length, 0, 'undo takes the rectangle back');
  assert.equal(channels(), 0.3, '… and leaves the channels set before it');
  assert.equal(composeCalls.length, 0, 'no recolour: the channels did not change');
  F._undo();
  assert.equal(channels(), 0.4, 'the next undo takes back the channel edit');
  assert.equal(composeCalls.at(-1).state[0].max, 0.4, 'and the picture is recoloured with it');
  F._undo();
  assert.equal(channels(), 1, 'back to the opening channels');
  F._redo(); F._redo(); F._redo();
  assert.equal(S.doc.layers.length, 1);
  assert.equal(channels(), 0.3);
  // A pause ends a run too.
  const n = S.history.length;
  clock += 100;
  panel.callback(0, { ...state[0], max: 0.2 });
  clock += 5000;
  panel.callback(0, { ...state[0], max: 0.1 });
  assert.equal(S.history.length, n + 2, 'a pause longer than a drag frame starts a new step');
  Studio.close();
  console.log('channel edits in the history: OK');
}

// ── Snapping: one correction per axis, to the nearest guide ──────────────────
{
  openSingle(200, 100);
  S.doc.guides = [{ axis: 'x', value: 103 }];
  const layer = { id: 's', type: 'rectangle', rotation: 0, x: 91, y: 10, w: 20, h: 10, style: {} };
  S.doc.layers.push(layer);
  Object.assign(S.doc.viewport, { zoom: 1 });
  F._applySnapping(layer);
  assert.equal(layer.x + layer.w / 2, 100, 'centre line (1 px away) wins over the guide (2 px away): one correction, no overshoot');
  Studio.close();
  console.log('snapping: OK');
}

// ── Tool letters ignore modifier keys ────────────────────────────────────────
{
  openSingle();
  const key = (k, more = {}) => F._onKeyDown({ key: k, target: { matches: () => false }, preventDefault() {}, ...more });
  key('r', { ctrlKey: true });
  key('d', { metaKey: true });
  key('l', { altKey: true });
  assert.equal(S.activeTool, 'select', 'Ctrl+R, Cmd+D, Alt+L leave the tool alone');
  key('r');
  assert.equal(S.activeTool, 'rectangle', 'R alone picks the rectangle');
  Studio.close();
  console.log('tool shortcuts and modifiers: OK');
}

// ── Calibration normalised; a result of another size re-scales the layers ────
{
  openSingle(200, 100, { pixelSizeUm: { x: 2 } });
  assert.deepEqual({ ...S.doc.calibration.pixelSizeUm }, { x: 2, y: 2 }, 'a missing y is the x (square pixels)');
  const dist = { id: 'd', type: 'distance', rotation: 0, x1: 20, y1: 10, x2: 120, y2: 10, style: {} };
  S.doc.layers.push(dist);
  near(F._lineLengthUm(dist), 200, 1e-9, '100 px at 2 µm');
  S.doc.guides.push({ axis: 'x', value: 50 });
  Studio.setSliceResult({ raw: mkRaw(400, 200), width: 400, height: 200, source: 'native-slicer', pixelSizeUm: { x: 1, y: NaN } });
  assert.deepEqual([dist.x1, dist.x2, dist.y1], [40, 240, 20], 'the layer follows its structure into the larger frame');
  assert.equal(S.doc.guides[0].value, 100, 'and the guide');
  near(F._lineLengthUm(dist), 200, 1e-9, 'the same 200 µm, measured with the new calibration');
  assert.ok(/^200\.00 um$/.test(F._measurementLabel(dist)), 'never NaN µm');
  Studio.close();
  console.log('calibration and re-scaled geometry: OK');
}

// ── A slice without raw values keeps its frame when re-coloured ──────────────
{
  const colour = makeEl('legacy'); colour.width = 60; colour.height = 50;
  Studio.open({ canvas: colour, width: 60, height: 50, renderRes: 200, source: 'gpu-slicer', channelState: state, planeSpec: { mode: 'xy' }, pixelSizeUm: { x: 1, y: 1 } });
  assert.equal(S.sliceImage, colour, 'opening shows the slice as rendered (its own colours, no re-render)');
  assert.equal(recomposeCalls.length, 0);
  clock += 100;
  getImageDataCalls = 0;
  panel.callback(0, { ...state[0], max: 0.9 });
  assert.ok(recomposeCalls.every(c => c.width === 200), 'rendered at the frame the slice was cut from');
  assert.equal(S.doc.sourceSlice.width, 60, 'the picture keeps its size');
  assert.equal(S.doc.sourceSlice.height, 50);
  assert.equal(S.sliceImage.width, 60);
  const copy = S.sliceImage.log.find(e => e[0] === 'drawImage');
  assert.deepEqual(copy.slice(2), [50, 60, 60, 50, 0, 0, 60, 50], 'cut at the window the viewer cropped (content box − 10 px)');
  const scans = getImageDataCalls;
  clock += 100;
  panel.callback(0, { ...state[0], max: 0.3 });
  assert.equal(getImageDataCalls, scans, 'a further edit scans nothing');
  const copy2 = S.sliceImage.log.find(e => e[0] === 'drawImage');
  assert.deepEqual(copy2.slice(2, 4), [50, 60], 'the same window though less is visible now');
  assert.equal(S.sliceImage.width, 60);
  Studio.close();

  // With the slice's own cropRect: no scan at all.
  recomposeCalls.length = 0;
  getImageDataCalls = 0;
  Studio.open({ canvas: colour, width: 60, height: 50, renderRes: 400, cropRect: { x: 7, y: 9, x2: 66, y2: 58, renderRes: 200 }, source: 'zstack', channelState: state, planeSpec: { mode: 'xy' } });
  clock += 100;
  panel.callback(0, { ...state[0], max: 0.8 });
  assert.equal(getImageDataCalls, 0, 'the slice\'s crop window is used as it is');
  assert.deepEqual(S.sliceImage.log.find(e => e[0] === 'drawImage').slice(2, 4), [14, 18], 'scaled to the render size');
  Studio.close();
  console.log('slice without raw values keeps its frame: OK');
}

// ── Compare cell buttons built once, moved by the view ───────────────────────
{
  const fig = makeEl('figure'); fig.width = 400; fig.height = 200;
  Studio.open({
    canvas: fig, width: 400, height: 200, source: 'compare', pixelSizeUm: { x: 1, y: 1 }, channelState: state,
    layoutMaps: [
      { x: 0, y: 0, w: 190, h: 200, pixelSizeUm: { x: 1, y: 1 }, channelState: state },
      { x: 210, y: 0, w: 190, h: 200, pixelSizeUm: { x: 1, y: 1 }, channelState: state },
    ],
  });
  const buttons = S.menuButtons.slice();
  assert.equal(buttons.length, 2, 'one button per cell');
  const madeButtons = () => created.filter(c => c.tag === 'button').length;
  const made = madeButtons();
  const left0 = buttons[1].style.left;
  for (let i = 0; i < 5; i++) { F._onWheel({ preventDefault() {}, clientX: 300, clientY: 200, deltaY: -1 }); runRafs(); }
  assert.equal(madeButtons(), made, 'zooming builds no button');
  assert.deepEqual(S.menuButtons, buttons, 'the same buttons');
  assert.notEqual(buttons[1].style.left, left0, 'moved with the view');
  buttons[1].fire('click', { stopPropagation() {} });
  assert.equal(buttons[1].style.color, '#fff', 'the active cell is marked');
  Studio.close();
  assert.ok(buttons.every(b => b.removed), 'removed on close');
  console.log('Compare cell buttons: OK');
}

// ── JSON import limits ────────────────────────────────────────────────────────
{
  openSingle();
  toasts.length = 0;
  const many = { version: 2, layers: Array.from({ length: 2001 }, (_, i) => ({ id: `l${i}`, type: 'line', x1: 0, y1: 0, x2: 1, y2: 1 })) };
  assert.equal(F._importDocumentText(JSON.stringify(many)), false, 'too many layers: refused');
  assert.equal(toasts.length, 1);
  const long = { version: 2, layers: [{ id: 't', type: 'text', x: 1, y: 1, text: 'x'.repeat(50000), name: 'n'.repeat(3000) }] };
  assert.equal(F._importDocumentText(JSON.stringify(long)), true);
  assert.equal(S.doc.layers[0].text.length, 2000, 'a label is cut to 2000 characters');
  assert.equal(S.doc.layers[0].name.length, 2000);
  assert.equal(F._importDocumentText('x'.repeat(5 * 1024 * 1024 + 1)), false, 'text over 5 MB: refused before parsing');
  toasts.length = 0;
  const input = { files: [{ size: 6 * 1024 * 1024 }], value: 'chosen' };
  assert.doesNotThrow(() => F._importJson({ target: input }), 'an oversized file is refused before it is read');
  assert.equal(input.value, '');
  assert.deepEqual(toasts, ['This file is too large to be a Studio file (over 5 MB).']);
  Studio.close();
  console.log('JSON import limits: OK');
}

// ── PNG export: size guard, null blob reported, canvas given back ────────────
{
  Studio.open({ canvas: makeEl('v'), raw: mkRaw(20000, 4), width: 20000, height: 4, source: 'studio-preview', planeSpec: {}, pixelSizeUm: { x: 1, y: 1 }, channelState: state });
  toasts.length = 0; downloads.length = 0;
  F._exportPng();
  assert.equal(downloads.length, 0, 'a figure wider than 16384 px is not attempted');
  assert.equal(toasts[0], 'This figure is too large to export as one PNG (20000 × 4 px).');
  Studio.close();

  openSingle();
  toasts.length = 0; downloads.length = 0; created.length = 0;
  blobIsNull = true;
  F._exportPng();
  blobIsNull = false;
  assert.equal(downloads.length, 0);
  assert.ok(toasts.includes('The PNG could not be written (the browser refused a canvas this large).'), 'a null blob is reported');
  const exportCanvas = created.find(c => c.log.some(e => e[0] === 'drawImage'));
  assert.equal(exportCanvas.width, 0, 'the export canvas is given back');
  created.length = 0;
  F._exportPng();
  assert.equal(downloads.length, 1, 'a normal export downloads');
  assert.equal(created.find(c => c.log.some(e => e[0] === 'drawImage')).width, 0, 'and gives its canvas back');
  Studio.close();
  console.log('PNG export guard: OK');
}

// ── SliceCompositor: slot refill, grow-only canvas, CPU ImageData reuse ──────
{
  const E = {
    TEXTURE_2D: 1, TEXTURE0: 0x84C0, TEXTURE1: 0x84C1, RGBA8: 2, RGBA: 3, R8: 4, RED: 5, UNSIGNED_BYTE: 6, NO_ERROR: 0,
    MAX_TEXTURE_SIZE: 7, VERTEX_SHADER: 8, FRAGMENT_SHADER: 9, COMPILE_STATUS: 10, LINK_STATUS: 11, UNPACK_ALIGNMENT: 12,
    UNPACK_FLIP_Y_WEBGL: 13, UNPACK_PREMULTIPLY_ALPHA_WEBGL: 14, UNPACK_COLORSPACE_CONVERSION_WEBGL: 15, NONE: 0,
    TEXTURE_MIN_FILTER: 16, TEXTURE_MAG_FILTER: 17, NEAREST: 18, TEXTURE_WRAP_S: 19, TEXTURE_WRAP_T: 20, CLAMP_TO_EDGE: 21,
    BLEND: 22, DEPTH_TEST: 23, SCISSOR_TEST: 24, TRIANGLES: 4,
  };
  const log = { uploads: [], subs: [], deleted: [], draws: [] };
  let glCanvas = null;
  let bound = null;
  const gl = {
    ...E,
    get drawingBufferWidth() { return glCanvas.width; },
    get drawingBufferHeight() { return glCanvas.height; },
    isContextLost: () => false,
    getParameter: () => 16384,
    createShader: () => ({}), shaderSource() {}, compileShader() {}, getShaderParameter: () => true, getShaderInfoLog: () => '', deleteShader() {},
    createProgram: () => ({}), attachShader() {}, linkProgram() {}, getProgramParameter: () => true, getProgramInfoLog: () => '', deleteProgram() {},
    createVertexArray: () => ({}), bindVertexArray() {}, getUniformLocation: (_p, n) => n,
    createTexture: () => ({ id: log.uploads.length }), activeTexture() {}, bindTexture(_t, tex) { bound = tex; }, pixelStorei() {}, texParameteri() {},
    texImage2D(_t, _l, internal, w, h, _b, _f, _ty, data) { log.uploads.push({ tex: bound, w, h, data }); },
    texSubImage2D(_t, _l, x, y, w, h, _f, _ty, data) { log.subs.push({ tex: bound, x, y, w, h, data }); },
    getError: () => 0, deleteTexture(t) { log.deleted.push(t); }, viewport() {}, disable() {}, useProgram() {},
    uniform1i() {}, uniform3fv() {}, uniform4fv() {}, drawArrays() {},
  };
  const mk = () => {
    const c = { width: 0, height: 0, addEventListener() {} };
    const ctx2d = { clearRect() {}, drawImage(...a) { log.draws.push(a); }, createImageData: () => { throw new Error('CPU path'); }, putImageData() {} };
    c.getContext = (k) => (k === 'webgl2' ? (glCanvas = c, gl) : k === '2d' ? ctx2d : null);
    return c;
  };
  const SC = loadModule('js/core/slice-compositor.js', 'SliceCompositor', { document: { createElement: mk } });
  const st = [{ enabled: true, color: '#ffffff', min: 0, max: 1, gamma: 1, opacity: 1 }];
  const slot = {};
  const target = mk();
  const rawA = { data: new Uint8Array(10 * 8 * 4).fill(1), width: 10, height: 8, channels: 1 };
  const rawB = { data: new Uint8Array(10 * 8 * 4).fill(2), width: 10, height: 8, channels: 1 };
  SC.compose(rawA, st, { target, slot });
  assert.equal(log.uploads.length, 1, 'first picture: one texture');
  const tex = log.uploads[0].tex;
  SC.compose(rawB, st, { target, slot });
  assert.equal(log.uploads.length, 1, 'a refresh of the same size allocates no texture');
  assert.equal(log.subs.length, 1, '… it is written into the slot\'s texture');
  assert.equal(log.subs[0].tex, tex);
  assert.equal(log.subs[0].data, rawB.data, 'with the new values');
  assert.equal(SC.textureBytes(), 10 * 8 * 4, 'one texture held');
  SC.compose(rawB, st, { target, slot });
  assert.equal(log.subs.length, 1, 'the same raw again: nothing uploaded');
  rawB.version = 2;
  SC.compose(rawB, st, { target, slot });
  assert.equal(log.subs.length, 2, 'a buffer refilled in place (new version) is uploaded again');
  SC.release(rawA);
  assert.equal(log.deleted.length, 0, 'releasing the previous raw keeps the slot (it holds the new one)');
  SC.release(rawB);
  assert.deepEqual(log.deleted, [tex], 'releasing the raw the slot holds frees it');
  assert.equal(SC.textureBytes(), 0);

  // The GL canvas only grows; a smaller picture is read from its bottom rows.
  log.draws.length = 0;
  SC.compose({ data: new Uint8Array(20 * 10 * 4), width: 20, height: 10, channels: 1 }, st, { target });
  SC.compose({ data: new Uint8Array(12 * 6 * 4), width: 12, height: 6, channels: 1 }, st, { target });
  assert.deepEqual([glCanvas.width, glCanvas.height], [20, 10], 'no reallocation for the smaller cell');
  assert.equal(log.draws[0].length, 3, 'same size: the whole buffer');
  assert.deepEqual(log.draws[1].slice(1), [0, 4, 12, 6, 0, 0, 12, 6], 'the viewport\'s rows (bottom-left in GL) read back');
  SC.release();
  assert.deepEqual([glCanvas.width, glCanvas.height], [1, 1], 'release() gives the buffer back');

  // CPU path: one ImageData per target canvas.
  let images = 0;
  const cpuTarget = { width: 0, height: 0 };
  const cpuCtx = { createImageData: (w, h) => { images++; return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }; }, putImageData() {} };
  cpuTarget.getContext = () => cpuCtx;
  const SCC = loadModule('js/core/slice-compositor.js', 'SliceCompositor', { document: { createElement: () => ({ getContext: () => null }) } });
  const raw = { data: new Uint8Array(6 * 5 * 4), width: 6, height: 5, channels: 1 };
  SCC.compose(raw, st, { target: cpuTarget });
  SCC.compose(raw, [{ ...st[0], max: 0.5 }], { target: cpuTarget });
  assert.equal(images, 1, 'a recolour of the same picture reuses its ImageData');
  SCC.compose({ data: new Uint8Array(7 * 5 * 4), width: 7, height: 5, channels: 1 }, st, { target: cpuTarget });
  assert.equal(images, 2, 'another size gets its own');
  console.log('SliceCompositor slot refill, grow-only canvas, CPU reuse: OK');
}

console.log('Studio audit fixes: OK');
