// Rotation of Studio annotation layers (js/components/studio-editor.js).
//   • pure geometry: angle normalisation, point about a centre (and its inverse, the
//     hit-test transform), bounds of a turned box, resize of a turned box that keeps the
//     opposite anchor fixed in image space, text regrowth from the turned corner,
//     µm per px along a direction with anisotropic pixels, the ruler turn;
//   • the layers themselves: box layers only record the angle (drawn T(c)·R(θ)·T(−c)),
//     point layers have it baked into their points from a snapshot (no drift), a
//     distance keeps its measured µm and a scale bar measures exactly its value along a
//     turned direction with anisotropic pixels, including after value edits and handle
//     drags; bounds / hit-test / handles follow the turned box;
//   • wiring: the rotate handle (Shift snaps to 15° and does not pan), one history step
//     per gesture, [ / ] with key-repeat coalescing, locked layers refuse, JSON import
//     normalises (an old document has no rotation), Escape cancels a drag, and init()
//     called twice binds the events once.
//
// The module runs for real in a vm; a hook is spliced in before its `return {` (the
// source file is not modified) to reach the closure's functions and state.
//
// Run: node tests/js/test_studio_layer_rotation.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT } from './harness.mjs';

const SRC = readFileSync(path.join(ROOT, 'js/components/studio-editor.js'), 'utf8').replace(/\r/g, '');
const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg || ''}: ${a} vs ${b}`);
const DEG = Math.PI / 180;

// ── Load the module with a hook on its closure ────────────────────────────────
const FNS = [
  '_normalizeRotationDeg', '_snapRotationDeg', '_unitFromDeg', '_rotateVec', '_rotatePointAbout', '_boxCentre',
  '_centroid', '_rotatedBoxCorners', '_rotatedBoxAabb', '_resizeRotatedBox', '_regrowRotatedBox',
  '_umPerPixelAlong', '_rotateRuler', '_rotateLayerFromSnapshot', '_linePoints', '_setScaleBarEnd',
  '_lineLengthUm', '_angleDegrees', '_layerBounds', '_layerBox', '_layerContains', '_handlesForLayer',
  '_applyHandle', '_hitTest', '_rotationHandle', '_drawLayer', '_measureTextLayer', '_migrateDocument',
  '_migrateLayer', '_onKeyDown', '_onKeyUp', '_onPointerDown', '_onPointerMove', '_onPointerUp',
  '_resizeCursor', '_undo', '_measurementLabel', '_renderProperties', '_layerPixelSize',
  '_layerRotationDeg', '_lengthInPixels', 'init'
];
const RETURN_RE = /\n  return \{\n    init,/;
assert.ok(RETURN_RE.test(SRC), 'studio-editor.js still ends its IIFE with `return { init, …`');
const HOOK = `
  globalThis.__studio = {
    get doc() { return _doc; },
    set doc(value) { _doc = value; },
    get history() { return _history; },
    set history(value) { _history = value; },
    get drawing() { return _drawing; },
    setState(s) {
      if ('selectedId' in s) _selectedId = s.selectedId;
      if ('isOpen' in s) _isOpen = s.isOpen;
      if ('sliceImage' in s) _sliceImage = s.sliceImage;
      if ('activeTool' in s) _activeTool = s.activeTool;
    },
    fns: { ${FNS.join(', ')} }
  };`;
const instrumented = SRC.replace(RETURN_RE, (m) => `\n${HOOK}${m}`);

const listeners = { window: {}, canvas: {} };
const makeCtx = (log) => new Proxy({}, {
  get(target, prop) {
    if (prop in target) return target[prop];
    if (prop === 'measureText') return (text) => ({ width: String(text).length * 10 });
    return (...args) => { if (log) log.push([prop, ...args]); };
  }
});
function fakeElement(id, bucket) {
  return {
    id, style: {}, dataset: {}, title: '', width: 0, height: 0, parentElement: null,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener(type, fn) { if (bucket) (bucket[type] ||= []).push(fn); },
    removeEventListener() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
    getContext: () => makeCtx(null),
    querySelector: () => null,
    querySelectorAll: () => [],
  };
}
const elements = {
  'studio-layout': fakeElement('studio-layout'),
  'studio-canvas': fakeElement('studio-canvas', listeners.canvas),
  'studio-command-palette': fakeElement('studio-command-palette'),
};
// The properties panel, as far as the rotation controls go: every write of its HTML
// makes NEW slider / field / reset elements (as the DOM does, which is what loses the
// keyboard focus), readable by id with the value the markup gave them.
function fakeInput(id, value) {
  const el = {
    id, value: String(value ?? ''), listeners: {},
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
    fire(type) { (this.listeners[type] || []).forEach(fn => fn({ target: el })); },
  };
  return el;
}
const props = fakeElement('studio-properties');
const readout = { textContent: '' };
let propsHtml = '';
props.renders = 0;
Object.defineProperty(props, 'innerHTML', {
  get: () => propsHtml,
  set(html) {
    propsHtml = html;
    props.renders++;
    for (const id of ['prop-rotation', 'prop-rotation-num', 'prop-rotation-reset']) {
      const m = html.match(new RegExp(`id="${id}"(?:[^>]*?value="([^"]*)")?`));
      if (m) elements[id] = fakeInput(id, m[1]);
      else delete elements[id];
    }
    const r = html.match(/class="studio-measurement-readout">([^<]*)</);
    readout.textContent = r ? r[1] : '';
  },
});
props.querySelector = (sel) => {
  if (sel === '.studio-measurement-readout') return propsHtml.includes('studio-measurement-readout') ? readout : null;
  if (sel === '.studio-rotation-prop') {
    const m = propsHtml.match(/class="studio-rotation-prop[^"]*" data-layer-id="([^"]*)"/);
    return m ? { getAttribute: (name) => (name === 'data-layer-id' ? m[1] : null) } : null;
  }
  return null;
};
elements['studio-properties'] = props;
const sandbox = {
  console, setTimeout, clearTimeout, encodeURIComponent,
  requestAnimationFrame: (fn) => setTimeout(fn, 0),
  ExportManager: {},
  document: {
    getElementById: (id) => elements[id] || null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    createElement: () => fakeElement('created'),
    body: { appendChild() {} },
  },
  window: {
    innerWidth: 800, innerHeight: 600,
    addEventListener(type, fn) { (listeners.window[type] ||= []).push(fn); },
  },
};
const ctx = vm.createContext(sandbox);
vm.runInContext(instrumented, ctx, { filename: 'studio-editor.js' });
const S = ctx.__studio;
const F = S.fns;
const DOC_VERSION = Number(SRC.match(/const DOC_VERSION = (\d+);/)[1]);

function makeDoc(px = { x: 1, y: 1 }, layers = []) {
  return {
    version: DOC_VERSION, createdAt: 't', updatedAt: 't',
    sourceSlice: { width: 800, height: 600 },
    calibration: { pixelSizeUm: px, spanUm: null, physicalSizeUm: null },
    layoutMaps: [], channelState: [], guides: [], groups: [], layers,
    viewport: { zoom: 1, panX: 400, panY: 300, rotation: 0 },
  };
}
const clone = (v) => JSON.parse(JSON.stringify(v));

// ── init() twice binds once (compare.js calls it on top of DOMContentLoaded) ──
{
  F.init();
  F.init();
  assert.equal((listeners.window.keydown || []).length, 1, 'one keydown listener after two init() calls');
  assert.equal((listeners.canvas.pointerdown || []).length, 1, 'one pointerdown listener after two init() calls');
  console.log('init() is idempotent: OK');
}

// ── Pure geometry ─────────────────────────────────────────────────────────────
{
  assert.equal(F._normalizeRotationDeg(190), -170);
  assert.equal(F._normalizeRotationDeg(-190), 170);
  assert.equal(F._normalizeRotationDeg(-180), 180, '(−180, 180]: −180 is spelled 180');
  assert.equal(F._normalizeRotationDeg(540), 180);
  assert.equal(F._normalizeRotationDeg(-720), 0);
  assert.ok(Object.is(F._normalizeRotationDeg(-0), 0), 'no −0 in a saved document');
  assert.equal(F._normalizeRotationDeg('30'), 30);
  for (const junk of [undefined, null, NaN, Infinity, 'abc', {}]) assert.equal(F._normalizeRotationDeg(junk), 0, `junk ${junk}`);
  assert.equal(F._snapRotationDeg(22.4, 15), 15);
  assert.equal(F._snapRotationDeg(22.6, 15), 30);
  assert.equal(F._snapRotationDeg(-172, 15), -165);
  assert.equal(F._snapRotationDeg(-175, 15), 180, 'snapping onto −180 spells it 180');
  const exact = [[0, 1, 0], [90, 0, 1], [180, -1, 0], [-90, 0, -1], [270, 0, -1]];
  for (const [deg, x, y] of exact) {
    const u = F._unitFromDeg(deg);
    assert.ok(u.x === x && u.y === y, `unit at ${deg}° is exact (${u.x}, ${u.y})`);
  }

  // Image y points down: +90° takes +x to +y, i.e. clockwise on screen (ctx.rotate).
  const p = F._rotatePointAbout({ x: 11, y: 5 }, { x: 10, y: 5 }, 90 * DEG);
  near(p.x, 10, 1e-12, 'rotate x'); near(p.y, 6, 1e-12, 'rotate y');
  // The hit-test transform is the inverse turn: there and back is the identity.
  for (const deg of [17, -123, 179.9]) {
    const q = { x: 3.7, y: -8.1 }, c = { x: 40, y: 12 };
    const back = F._rotatePointAbout(F._rotatePointAbout(q, c, deg * DEG), c, -deg * DEG);
    near(back.x, q.x, 1e-9, 'inverse x'); near(back.y, q.y, 1e-9, 'inverse y');
  }

  // Bounds of a turned box = extent of its turned corners (closed form checked against them).
  const box = { x: 100, y: 40, w: 200, h: 60 };
  for (const deg of [0, 30, 90, -135, 180]) {
    const aabb = F._rotatedBoxAabb(box, deg * DEG);
    const corners = F._rotatedBoxCorners(box, deg * DEG);
    const xs = corners.map(c => c.x), ys = corners.map(c => c.y);
    near(aabb.x, Math.min(...xs), 1e-9, `aabb x at ${deg}`);
    near(aabb.y, Math.min(...ys), 1e-9, `aabb y at ${deg}`);
    near(aabb.x + aabb.w, Math.max(...xs), 1e-9, `aabb right at ${deg}`);
    near(aabb.y + aabb.h, Math.max(...ys), 1e-9, `aabb bottom at ${deg}`);
  }
  const quarter = F._rotatedBoxAabb(box, 90 * DEG);
  near(quarter.w, 60, 1e-9, 'a quarter turn swaps w'); near(quarter.h, 200, 1e-9, '… and h');
  const unturned = F._rotatedBoxAabb(box, 0);
  assert.ok(unturned.x === 100 && unturned.y === 40 && unturned.w === 200 && unturned.h === 60, 'θ = 0 leaves the box exact');

  // Resize of a turned box: the corner opposite the dragged one stays put in image
  // space, and the dragged corner lands on the pointer.
  const rad = 30 * DEG;
  const cornersOf = (b) => Object.fromEntries(F._rotatedBoxCorners(b, rad).map(c => [c.id, c]));
  const opposite = { se: 'nw', nw: 'se', ne: 'sw', sw: 'ne' };
  for (const handle of ['se', 'nw', 'ne', 'sw']) {
    const before = cornersOf(box);
    const pointer = { x: before[handle].x + 23.5, y: before[handle].y - 11.25 };
    const after = cornersOf(F._resizeRotatedBox(box, rad, handle, pointer));
    near(after[opposite[handle]].x, before[opposite[handle]].x, 1e-9, `${handle}: anchor x fixed`);
    near(after[opposite[handle]].y, before[opposite[handle]].y, 1e-9, `${handle}: anchor y fixed`);
    near(after[handle].x, pointer.x, 1e-9, `${handle}: dragged corner on the pointer (x)`);
    near(after[handle].y, pointer.y, 1e-9, `${handle}: dragged corner on the pointer (y)`);
  }
  // Dragging across the anchor flips the box instead of giving it a negative size.
  const flipped = F._resizeRotatedBox(box, rad, 'se', cornersOf(box).nw);
  assert.ok(flipped.w >= 0 && flipped.h >= 0, 'no negative size');
  // An edge handle drives one axis only; the opposite edge's midpoint stays.
  const edge = F._resizeRotatedBox(box, rad, 'e', { x: 500, y: 90 });
  near(edge.h, box.h, 1e-9, 'edge handle keeps the other size');
  const midW = (b) => F._rotatePointAbout({ x: b.x, y: b.y + b.h / 2 }, F._boxCentre(b), rad);
  near(midW(edge).x, midW(box).x, 1e-9, 'west edge midpoint x'); near(midW(edge).y, midW(box).y, 1e-9, 'west edge midpoint y');
  // Unturned, the resize is the historical min/abs rule.
  for (const [handle, pt] of [['se', { x: 350, y: 130 }], ['nw', { x: 50, y: 10 }], ['ne', { x: 90, y: 200 }], ['sw', { x: 400, y: -20 }]]) {
    const b = F._resizeRotatedBox(box, 0, handle, pt);
    const left = handle.includes('w') ? pt.x : box.x;
    const right = handle.includes('e') ? pt.x : box.x + box.w;
    const top = handle.includes('n') ? pt.y : box.y;
    const bottom = handle.includes('s') ? pt.y : box.y + box.h;
    near(b.x, Math.min(left, right), 1e-9, `${handle} x`); near(b.y, Math.min(top, bottom), 1e-9, `${handle} y`);
    near(b.w, Math.abs(right - left), 1e-9, `${handle} w`); near(b.h, Math.abs(bottom - top), 1e-9, `${handle} h`);
  }

  // Text re-measured on a turned box grows from its turned top-left corner.
  const grown = F._regrowRotatedBox(box, rad, 320, 60);
  const nw0 = cornersOf(box).nw, nw1 = cornersOf(grown).nw;
  near(nw1.x, nw0.x, 1e-9, 'regrow keeps nw x'); near(nw1.y, nw0.y, 1e-9, 'regrow keeps nw y');

  // µm per px along a direction: psx horizontally, psy vertically, hypot in between.
  const px = { x: 0.5, y: 2 };
  near(F._umPerPixelAlong(1, 0, px), 0.5, 0, 'horizontal reads psx exactly');
  near(F._umPerPixelAlong(0, 1, px), 2, 0, 'vertical reads psy exactly');
  near(F._umPerPixelAlong(Math.SQRT1_2, Math.SQRT1_2, px), Math.hypot(0.5, 2) * Math.SQRT1_2, 1e-12, 'diagonal');
  near(F._umPerPixelAlong(0, 1, { x: 0.7 }), 0.7, 1e-12, 'a missing psy means square pixels');

  // The ruler turn keeps the physical length and the midpoint.
  const lengthUm = (s) => Math.hypot((s.x2 - s.x1) * px.x, (s.y2 - s.y1) * px.y);
  const ruler = { x1: 10, y1: 10, x2: 110, y2: 10 };
  near(lengthUm(ruler), 50, 1e-12, 'ruler before');
  for (const deg of [90, 33, -71, 180]) {
    const r = F._rotateRuler({ x: ruler.x1, y: ruler.y1 }, { x: ruler.x2, y: ruler.y2 }, deg * DEG, px);
    near(lengthUm(r), 50, 1e-9, `ruler keeps 50 µm at ${deg}°`);
    near((r.x1 + r.x2) / 2, 60, 1e-9, 'midpoint x'); near((r.y1 + r.y2) / 2, 10, 1e-9, 'midpoint y');
    near(Math.atan2(r.y2 - r.y1, r.x2 - r.x1) / DEG, F._normalizeRotationDeg(deg), 1e-9, `direction turned by ${deg}°`);
  }
  const vertical = F._rotateRuler({ x: 10, y: 10 }, { x: 110, y: 10 }, 90 * DEG, px);
  near(Math.hypot(vertical.x2 - vertical.x1, vertical.y2 - vertical.y1), 25, 1e-9, '50 µm at 2 µm/px = 25 px');
  console.log('pure rotation geometry: OK');
}

// ── Point layers: baked, from a snapshot, measurements intact ─────────────────
{
  const px = { x: 0.5, y: 2 };
  S.doc = makeDoc(px);

  // Distance: keeps its µm, its label, its midpoint; previews from one snapshot never drift.
  const distance = { id: 'd', type: 'distance', rotation: 0, x1: 10, y1: 10, x2: 110, y2: 10, style: {} };
  const snap = clone(distance);
  const label0 = F._measurementLabel(distance);
  F._rotateLayerFromSnapshot(distance, snap, 37);
  const first = clone(distance);
  F._rotateLayerFromSnapshot(distance, snap, 80);
  F._rotateLayerFromSnapshot(distance, snap, 37);
  for (const k of ['x1', 'y1', 'x2', 'y2']) assert.equal(distance[k], first[k], `no drift on ${k}`);
  F._rotateLayerFromSnapshot(distance, snap, 0);
  for (const k of ['x1', 'y1', 'x2', 'y2']) assert.equal(distance[k], snap[k], `back at the start: ${k} bit for bit`);
  F._rotateLayerFromSnapshot(distance, snap, 37);
  assert.equal(distance.rotation, 37);
  near(F._lineLengthUm(distance), 50, 1e-9, 'distance keeps its measured length (anisotropic)');
  assert.equal(distance.text, label0, 'label unchanged');
  near((distance.x1 + distance.x2) / 2, 60, 1e-9, 'distance midpoint');

  // Scale bar: born horizontal — the historical x2 = x1 + value/psx — and its turned
  // pixel length measures exactly its value: L·hypot(ux·psx, uy·psy) = value.
  const bar = { id: 's', type: 'scalebar', rotation: 0, x1: 100, y1: 100, value: 100, unit: 'um', style: {} };
  F._setScaleBarEnd(bar);
  assert.ok(bar.x2 === 300 && bar.y2 === 100, `horizontal bar unchanged: (${bar.x2}, ${bar.y2})`);
  const barSnap = clone(bar);
  F._rotateLayerFromSnapshot(bar, barSnap, 90);
  let p = F._linePoints(bar);
  near(p.x1, 200, 1e-9, 'vertical bar centred x'); near(p.x2, 200, 1e-9, 'vertical bar x2');
  near(p.y2 - p.y1, 50, 1e-9, '100 µm at 2 µm/px = 50 px'); near((p.y1 + p.y2) / 2, 100, 1e-9, 'centre kept');
  near(F._lineLengthUm(bar), 100, 1e-9, 'vertical bar measures its value');
  for (const deg of [30, -45, 150]) {
    F._rotateLayerFromSnapshot(bar, barSnap, deg);
    near(F._lineLengthUm(bar), 100, 1e-9, `bar at ${deg}° measures its value`);
    p = F._linePoints(bar);
    near(Math.atan2(p.y2 - p.y1, p.x2 - p.x1) / DEG, deg, 1e-9, `bar direction ${deg}°`);
    near(bar.x2, p.x2, 1e-9, 'stored far end follows'); near(bar.y2, p.y2, 1e-9, 'stored far end follows (y)');
  }
  // A value edit keeps the direction and still measures exactly.
  F._rotateLayerFromSnapshot(bar, barSnap, 30);
  bar.value = 250;
  F._setScaleBarEnd(bar);
  p = F._linePoints(bar);
  near(Math.atan2(p.y2 - p.y1, p.x2 - p.x1) / DEG, 30, 1e-9, 'value edit keeps the direction');
  near(F._lineLengthUm(bar), 250, 1e-9, 'value edit measures exactly');
  // A handle drag on a turned bar projects the pointer on the bar's axis.
  F._rotateLayerFromSnapshot(bar, clone(bar), 90);
  const orig = clone(bar);
  F._applyHandle(bar, 'p2', { x: bar.x1 + 7, y: bar.y1 + 100 }, orig);
  p = F._linePoints(bar);
  near(p.x2 - p.x1, 0, 1e-9, 'dragging p2 keeps a vertical bar vertical');
  assert.equal(bar.value, 200, '100 px × 2 µm/px = 200 µm');
  near(F._lineLengthUm(bar), 200, 1e-9, 'dragged bar measures its value');
  const farEnd = { x: p.x2, y: p.y2 };
  F._applyHandle(bar, 'p1', { x: p.x1 - 3, y: p.y2 - 150 }, clone(bar));
  p = F._linePoints(bar);
  near(p.x1, farEnd.x, 1e-9, 'p1 drag stays on the axis');
  assert.equal(bar.value, 300, '150 px × 2 µm/px');
  // The historical horizontal drag is untouched.
  const flat = { id: 'f', type: 'scalebar', rotation: 0, x1: 100, y1: 100, value: 100, unit: 'um', style: {} };
  F._setScaleBarEnd(flat);
  F._applyHandle(flat, 'p2', { x: 180, y: 140 }, clone(flat));
  assert.ok(flat.x1 === 100 && flat.y1 === 100 && flat.y2 === 100 && flat.value === 40 && flat.x2 === 180, 'horizontal p2 drag as before');

  // Line / arrow / angle: rigid turn about the centroid; +θ then back is the identity.
  S.doc = makeDoc({ x: 1, y: 1 });
  const angle = { id: 'a', type: 'angle', rotation: 0, x1: 50, y1: 50, x2: 150, y2: 50, x3: 50, y3: 120, style: {} };
  const a0 = clone(angle);
  const measured = F._angleDegrees(angle);
  F._rotateLayerFromSnapshot(angle, a0, 64);
  near(F._angleDegrees(angle), measured, 1e-9, 'square pixels: the angle reads the same');
  near((angle.x1 + angle.x2 + angle.x3) / 3, (a0.x1 + a0.x2 + a0.x3) / 3, 1e-9, 'centroid kept');
  F._rotateLayerFromSnapshot(angle, clone(angle), 0);
  for (const k of ['x1', 'y1', 'x2', 'y2', 'x3', 'y3']) near(angle[k], a0[k], 1e-9, `angle back to ${k}`);
  const line = { id: 'l', type: 'arrow', rotation: 0, x1: 0, y1: 0, x2: 40, y2: 30, style: {} };
  F._rotateLayerFromSnapshot(line, clone(line), -90);
  near(Math.hypot(line.x2 - line.x1, line.y2 - line.y1), 50, 1e-9, 'an arrow turns rigidly');
  near((line.x1 + line.x2) / 2, 20, 1e-9, 'about its midpoint');

  // Box layers only record the angle.
  const rect = { id: 'r', type: 'rectangle', rotation: 0, x: 300, y: 250, w: 200, h: 100, style: {} };
  F._rotateLayerFromSnapshot(rect, clone(rect), 400);
  assert.ok(rect.rotation === 40 && rect.x === 300 && rect.y === 250 && rect.w === 200 && rect.h === 100, 'box: angle only, normalised');
  console.log('point layers baked / box layers recorded: OK');
}

// ── Turned box: bounds, hit-test, handles, drawing, text ──────────────────────
{
  S.doc = makeDoc();
  const rect = { id: 'r', type: 'rectangle', rotation: 90, x: 300, y: 250, w: 200, h: 100, style: {}, visible: true };
  S.doc.layers.push(rect);
  const b = F._layerBounds(rect);
  near(b.x, 350, 1e-9, 'bounds x'); near(b.y, 200, 1e-9, 'bounds y'); near(b.w, 100, 1e-9, 'bounds w'); near(b.h, 200, 1e-9, 'bounds h');
  assert.ok(F._layerContains(rect, { x: 400, y: 220 }), 'inside the turned box, outside the unturned one: hit');
  assert.ok(!F._layerContains(rect, { x: 320, y: 300 }), 'inside the unturned box, outside the turned one: miss');
  const handles = Object.fromEntries(F._handlesForLayer(rect).map(h => [h.id, h]));
  near(handles.nw.x, 450, 1e-9, 'nw handle turned x'); near(handles.nw.y, 200, 1e-9, 'nw handle turned y');
  S.setState({ selectedId: 'r', activeTool: 'select' });
  const knob = F._rotationHandle(rect);
  near(knob.x, 400 + 50 + 28, 1e-9, 'knob beyond the turned top edge (x)'); near(knob.y, 300, 1e-9, 'knob (y)');
  assert.equal(F._hitTest({ x: knob.x, y: knob.y }).handle, 'rotate', 'the knob is hit first');
  rect.locked = true;
  assert.notEqual(F._hitTest({ x: knob.x, y: knob.y })?.handle, 'rotate', 'a locked layer has no rotate handle');
  rect.locked = false;
  assert.equal(F._resizeCursor(rect, 'se'), 'nesw-resize', 'a quarter turn swaps the diagonal cursors');
  assert.equal(F._resizeCursor({ ...rect, rotation: 0 }, 'se'), 'nwse-resize');

  // Drawn as T(c)·R(θ)·T(−c) then the unturned rectangle.
  const log = [];
  F._drawLayer(makeCtx(log), { ...rect, rotation: 30 }, 1);
  const names = log.map(e => e[0]);
  const t = names.indexOf('translate');
  assert.deepEqual(names.slice(t, t + 3), ['translate', 'rotate', 'translate'], 'translate / rotate / translate');
  assert.deepEqual([log[t][1], log[t][2]], [400, 300], 'about the box centre');
  near(log[t + 1][1], 30 * DEG, 1e-12, 'by the layer angle');
  assert.ok(names.indexOf('strokeRect') > t + 2, 'the rectangle is stroked inside the turn');
  const plainLog = [];
  F._drawLayer(makeCtx(plainLog), { ...rect, rotation: 0 }, 1);
  assert.ok(!plainLog.some(e => e[0] === 'rotate'), 'an unturned layer draws as before');

  // Text: measured before the turn; new words grow from the turned top-left corner.
  const text = { id: 't', type: 'text', rotation: 30, x: 100, y: 100, w: 30, h: 18, text: 'abc', style: { fontSize: 18 } };
  const nwOf = (l) => F._rotatedBoxCorners(F._layerBox(l), 30 * DEG).find(c => c.id === 'nw');
  const nwBefore = nwOf(text);
  text.text = 'abcdefgh';
  F._measureTextLayer(makeCtx(null), text);
  assert.equal(text.w, 80, 'box re-measured');
  const nwAfter = nwOf(text);
  near(nwAfter.x, nwBefore.x, 1e-9, 'first glyph stays (x)'); near(nwAfter.y, nwBefore.y, 1e-9, 'first glyph stays (y)');
  const textLog = [];
  F._drawLayer(makeCtx(textLog), text, 1);
  const tt = textLog.findIndex(e => e[0] === 'translate');
  near(textLog[tt][1], text.x + text.w / 2, 1e-9, 'text turns about its measured centre');
  console.log('turned box bounds / hit-test / handles / drawing / text: OK');
}

// ── Canvas gesture: rotate handle, Shift snaps (and does not pan), one history step ──
{
  S.doc = makeDoc();
  const rect = { id: 'r', type: 'rectangle', rotation: 0, x: 300, y: 250, w: 200, h: 100, style: {}, visible: true, locked: false };
  S.doc.layers.push(rect);
  S.setState({ sliceImage: { width: 800, height: 600 }, selectedId: 'r', activeTool: 'select', isOpen: true });
  S.history = [{ label: 'Open Studio', doc: clone(S.doc) }];
  const ev = (x, y, extra = {}) => ({ clientX: x, clientY: y, pointerId: 1, pointerType: 'mouse', button: 0, shiftKey: false, altKey: false, ...extra });
  // Knob: 28 px above the top-centre (400, 250); the view is the identity here.
  F._onPointerDown(ev(400, 222, { shiftKey: true }));
  assert.equal(S.drawing?.mode, 'rotate', 'Shift+press on the knob rotates, it does not pan');
  F._onPointerMove(ev(480, 250, { shiftKey: true }));
  assert.equal(S.doc.layers[0].rotation, 60, 'Shift snaps 58° to 60°');
  F._onPointerMove(ev(480, 250));
  assert.equal(S.doc.layers[0].rotation, 58, 'free drag, 0.1° resolution');
  F._onPointerUp(ev(480, 250));
  assert.equal(S.history.length, 2, 'one history step per drag');
  assert.equal(S.history[1].label, 'Rotate layer');
  assert.equal(S.history[1].doc.layers[0].rotation, 58, 'the step holds the angle');
  // Escape mid-drag puts the layer back.
  const knob = F._rotationHandle(S.doc.layers[0]);
  F._onPointerDown(ev(knob.x, knob.y));
  F._onPointerMove(ev(100, 500));
  assert.notEqual(S.doc.layers[0].rotation, 58);
  F._onKeyUp({ key: 'Escape' });
  assert.equal(S.doc.layers[0].rotation, 58, 'Escape cancels the drag');
  F._onPointerUp(ev(100, 500));
  assert.equal(S.history.length, 2, 'a cancelled drag leaves no history');
  F._undo();
  assert.equal(S.doc.layers[0].rotation, 0, 'undo restores the unturned layer');
  console.log('rotate handle gesture: OK');
}

// ── Keyboard: [ / ] ───────────────────────────────────────────────────────────
{
  S.doc = makeDoc();
  const line = { id: 'l', type: 'line', rotation: 0, x1: 100, y1: 100, x2: 200, y2: 100, style: {}, visible: true, locked: false };
  S.doc.layers.push(line);
  S.setState({ selectedId: 'l', activeTool: 'select', isOpen: true });
  S.history = [{ label: 'Open Studio', doc: clone(S.doc) }];
  const key = (k, extra = {}) => {
    let prevented = false;
    F._onKeyDown({ key: k, target: { matches: () => false }, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, repeat: false, preventDefault: () => { prevented = true; }, ...extra });
    return prevented;
  };
  const current = () => S.doc.layers.find(l => l.id === 'l');
  assert.ok(key(']'), '] is consumed');
  assert.equal(current().rotation, 15);
  key(']', { repeat: true });
  key(']', { repeat: true });
  assert.equal(current().rotation, 45);
  assert.equal(S.history.length, 2, 'a held key is one history step');
  key('[', { shiftKey: true });
  assert.equal(current().rotation, 44, 'Shift+[ turns by 1°');
  key('}');
  assert.equal(current().rotation, 45, "'}' (Shift+] on most layouts) turns by 1°");
  key('[', { ctrlKey: true });
  assert.equal(current().rotation, 45, 'Ctrl+[ is left to the browser');
  key('[', { ctrlKey: true, altKey: true });
  assert.equal(current().rotation, 30, 'AltGr+[ (AZERTY) rotates');
  near(Math.hypot(current().x2 - current().x1, current().y2 - current().y1), 100, 1e-9, 'the line keeps its length');
  current().locked = true;
  assert.ok(!key(']'), 'a locked layer is not turned (and the key is not consumed)');
  assert.equal(current().rotation, 30);
  current().locked = false;
  const inField = { key: ']', target: { matches: () => true }, preventDefault() {} };
  F._onKeyDown(inField);
  assert.equal(current().rotation, 30, 'typing ] in a field does not rotate');
  S.setState({ selectedId: null });
  assert.ok(!key(']'), 'nothing selected: nothing to turn');
  console.log('[ / ] keyboard rotation: OK');
}

// ── JSON import ───────────────────────────────────────────────────────────────
{
  S.doc = makeDoc();
  const imported = F._migrateDocument({
    version: DOC_VERSION,
    layers: [
      { id: 'a', type: 'rectangle', x: 0, y: 0, w: 10, h: 10 },
      { id: 'b', type: 'line', rotation: 'abc', x1: 0, y1: 0, x2: 1, y2: 1 },
      { id: 'c', type: 'text', rotation: 190, x: 0, y: 0, text: 'x' },
    ],
  });
  assert.deepEqual(imported.layers.map(l => l.rotation), [0, 0, -170], 'current documents: rotation normalised, absent = 0');
  const legacy = F._migrateLayer({ type: 'rectangle', x: 1, y: 2, w: 3, h: 4 });
  assert.equal(legacy.rotation, 0, 'a legacy layer has no rotation');
  assert.equal(F._migrateLayer({ type: 'ellipse', rotation: -540 }).rotation, 180);
  console.log('JSON import normalises rotation: OK');
}

// ── [ / ] wait for a pointer gesture to end ───────────────────────────────────
{
  S.doc = makeDoc();
  const line = { id: 'l', type: 'line', rotation: 0, x1: 100, y1: 100, x2: 200, y2: 100, style: {}, visible: true, locked: false };
  S.doc.layers.push(line);
  S.setState({ sliceImage: { width: 800, height: 600 }, selectedId: 'l', activeTool: 'select', isOpen: true });
  S.history = [{ label: 'Open Studio', doc: clone(S.doc) }];
  const ev = (x, y, extra = {}) => ({ clientX: x, clientY: y, pointerId: 1, pointerType: 'mouse', button: 0, shiftKey: false, altKey: false, ...extra });
  const key = (k) => F._onKeyDown({ key: k, target: { matches: () => false }, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, repeat: false, preventDefault() {} });
  const current = () => S.doc.layers.find(l => l.id === 'l');

  // A move drag: the key is ignored, the move keeps following the pointer.
  F._onPointerDown(ev(150, 100));
  assert.equal(S.drawing?.mode, 'move', 'pressing on the line starts a move');
  key(']');
  assert.equal(current().rotation, 0, '] during a move drag does not turn the layer');
  assert.equal(S.history.length, 1, '… and leaves no history step mid-gesture');
  F._onPointerMove(ev(160, 110));
  assert.ok(current().x1 === 110 && current().y1 === 110 && current().x2 === 210 && current().y2 === 110, 'the move is the pointer\'s, untouched');
  F._onPointerUp(ev(160, 110));
  assert.equal(S.history.length, 2, 'the move is one step');
  key(']');
  assert.equal(current().rotation, 15, 'after the gesture the key turns again');

  // A handle drag and a rotate drag: same.
  const rect = { id: 'r', type: 'rectangle', rotation: 30, x: 300, y: 250, w: 200, h: 100, style: {}, visible: true, locked: false };
  S.doc.layers.push(rect);
  S.setState({ selectedId: 'r' });
  const turnedRect = () => S.doc.layers.find(l => l.id === 'r');
  const se = F._handlesForLayer(rect).find(h => h.id === 'se');
  F._onPointerDown(ev(se.x, se.y));
  assert.equal(S.drawing?.mode, 'handle', 'pressing on the se handle starts a resize');
  key('[');
  assert.equal(turnedRect().rotation, 30, '[ during a resize does not turn the box');
  F._onPointerMove(ev(se.x + 20, se.y + 10));
  const moved = F._rotatedBoxCorners(F._layerBox(turnedRect()), 30 * DEG).find(c => c.id === 'se');
  near(moved.x, se.x + 20, 1e-9, 'the dragged corner stays under the pointer (x)');
  near(moved.y, se.y + 10, 1e-9, 'the dragged corner stays under the pointer (y)');
  F._onPointerUp(ev(se.x + 20, se.y + 10));
  const knob = F._rotationHandle(turnedRect());
  F._onPointerDown(ev(knob.x, knob.y));
  assert.equal(S.drawing?.mode, 'rotate');
  const steps = S.history.length;
  key(']');
  assert.equal(S.history.length, steps, '] during a rotate drag leaves no orphan history step');
  F._onKeyUp({ key: 'Escape' });
  assert.equal(turnedRect().rotation, 30, 'Escape still restores the layer the drag found');
  console.log('[ / ] ignored during a pointer gesture: OK');
}

// ── Rotation controls: commit in place, empty field, the −180 end ─────────────
{
  S.doc = makeDoc();
  const rect = { id: 'r', type: 'rectangle', rotation: 0, x: 300, y: 250, w: 200, h: 100, style: {}, visible: true, locked: false };
  const line = { id: 'l', type: 'line', rotation: 0, x1: 100, y1: 100, x2: 200, y2: 140, style: {}, visible: true, locked: false };
  S.doc.layers.push(rect, line);
  S.setState({ selectedId: 'r', activeTool: 'select', isOpen: true });
  S.history = [{ label: 'Open Studio', doc: clone(S.doc) }];
  F._renderProperties();
  const slider = elements['prop-rotation'];
  const field = elements['prop-rotation-num'];
  const reset = elements['prop-rotation-reset'];
  assert.ok(slider && field && reset, 'the rotation controls are rendered');
  const renders = props.renders;
  const sameControls = (msg) => {
    assert.equal(elements['prop-rotation'], slider, `${msg}: the slider is not rebuilt (keeps the focus)`);
    assert.equal(elements['prop-rotation-num'], field, `${msg}: the field is not rebuilt`);
    assert.equal(props.renders, renders, `${msg}: the panel is not re-rendered`);
  };

  // Keyboard arrows on the slider: 'input' + 'change' per step, step after step.
  for (const deg of [1, 2, 3]) {
    slider.value = String(deg);
    slider.fire('input');
    slider.fire('change');
    assert.equal(rect.rotation, deg, `arrow step to ${deg}°`);
    assert.equal(field.value, String(deg), 'the field follows');
    sameControls(`step ${deg}`);
  }
  assert.equal(S.history.length, 4, 'one history step per committed step');

  // Reset from the keyboard: turned back, focus kept.
  reset.fire('click');
  assert.equal(rect.rotation, 0, 'reset');
  assert.ok(slider.value === '0' && field.value === '0', 'controls rewritten');
  sameControls('reset');

  // The −180 end: the angle is spelled 180, the thumb stays where it was put.
  slider.value = '-180';
  slider.fire('input');
  assert.equal(rect.rotation, 180, '−180 is stored as 180');
  assert.equal(slider.value, '-180', 'the dragged slider is not thrown to the other end');
  assert.equal(field.value, '180', 'the field shows the stored angle');
  slider.fire('change');
  assert.equal(slider.value, '-180', 'nor on commit');
  sameControls('−180');

  // An emptied field: the typed preview is undone, no history step.
  const before = S.history.length;
  field.value = '4';
  field.fire('input');
  assert.equal(rect.rotation, 4, 'typing previews');
  field.value = '';
  field.fire('input');
  assert.equal(rect.rotation, 4, 'an empty field while typing leaves the preview');
  field.fire('change');
  assert.equal(rect.rotation, 180, 'committing an empty field puts the layer back');
  assert.ok(field.value === '180' && slider.value === '180', 'field and slider rewritten to the angle the layer has');
  assert.equal(S.history.length, before, 'no history step');
  field.value = '-';
  field.fire('change');
  assert.equal(rect.rotation, 180, 'a lone "-" commits nothing either');
  assert.equal(field.value, '180');
  // The next edit starts from a fresh snapshot, not the abandoned one.
  field.value = '90';
  field.fire('input');
  field.fire('change');
  assert.equal(rect.rotation, 90);
  assert.equal(S.history.length, before + 1, 'a real edit after it is one step');
  F._undo();
  assert.equal(S.doc.layers.find(l => l.id === 'r').rotation, 180, 'undo goes back to the committed 180, not to the abandoned 4');

  // A point layer comes back bit for bit from an emptied field.
  S.setState({ selectedId: 'l' });
  F._renderProperties();
  const lineField = elements['prop-rotation-num'];
  const liveLine = S.doc.layers.find(l => l.id === 'l');
  const saved = clone(liveLine);
  lineField.value = '33';
  lineField.fire('input');
  assert.notEqual(liveLine.x1, saved.x1, 'the preview turned the points');
  lineField.value = '';
  lineField.fire('change');
  for (const k of ['x1', 'y1', 'x2', 'y2', 'rotation']) assert.equal(liveLine[k], saved[k], `restored ${k}`);

  // [ / ] update the controls in place too.
  const lineSlider = elements['prop-rotation'];
  const r0 = props.renders;
  F._onKeyDown({ key: ']', target: { matches: () => false }, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, repeat: false, preventDefault() {} });
  assert.equal(liveLine.rotation, 15);
  assert.equal(elements['prop-rotation'], lineSlider, '] keeps the controls');
  assert.equal(props.renders, r0, '… without re-rendering the panel');
  assert.ok(lineSlider.value === '15' && elements['prop-rotation-num'].value === '15', '… and writes the angle into them');
  console.log('rotation controls commit in place / empty field / −180: OK');
}

// ── An angle keeps its value with anisotropic pixels ──────────────────────────
{
  const px = { x: 1, y: 2 };
  S.doc = makeDoc(px);
  // Vertex (100, 100), arms along +x and +y in pixels: 100 µm and 100 µm, at 90°.
  const angle = { id: 'a', type: 'angle', rotation: 0, x1: 100, y1: 100, x2: 200, y2: 100, x3: 100, y3: 150, style: {} };
  const a0 = clone(angle);
  const armUm = (l, n) => Math.hypot((l[`x${n}`] - l.x1) * px.x, (l[`y${n}`] - l.y1) * px.y);
  near(F._angleDegrees(angle), 90, 1e-12, 'before');
  for (const deg of [45, 137, -90, 180]) {
    F._rotateLayerFromSnapshot(angle, a0, deg);
    near(F._angleDegrees(angle), 90, 1e-9, `the angle still reads 90° after ${deg}°`);
    near(armUm(angle, 2), 100, 1e-9, `arm 1 keeps its µm at ${deg}°`);
    near(armUm(angle, 3), 100, 1e-9, `arm 2 keeps its µm at ${deg}°`);
    near((angle.x1 + angle.x2 + angle.x3) / 3, (a0.x1 + a0.x2 + a0.x3) / 3, 1e-9, 'centroid kept (x)');
    near((angle.y1 + angle.y2 + angle.y3) / 3, (a0.y1 + a0.y2 + a0.y3) / 3, 1e-9, 'centroid kept (y)');
    assert.equal(angle.text, '90.0 deg', 'the label');
  }
  // The arm direction turned by the angle asked, measured in µm space.
  F._rotateLayerFromSnapshot(angle, a0, 30);
  near(Math.atan2((angle.y2 - angle.y1) * px.y, (angle.x2 - angle.x1) * px.x) / DEG, 30, 1e-9, 'turned by 30° in µm space');
  // There and back from a turned snapshot is the identity.
  F._rotateLayerFromSnapshot(angle, clone(angle), 0);
  for (const k of ['x1', 'y1', 'x2', 'y2', 'x3', 'y3']) near(angle[k], a0[k], 1e-9, `angle back to ${k}`);
  console.log('angle turned in µm space: OK');
}

// ── Compare figure: a turned layer keeps the calibration of its own cell ──────
{
  S.doc = makeDoc({ x: 0.25, y: 0.25 });
  // Cell A calibrates the document (0.25 µm/px), cell B is 0.5 µm/px.
  S.doc.layoutMaps = [
    { x: 50, y: 50, w: 800, h: 600, pixelSizeUm: { x: 0.25, y: 0.25 } },
    { x: 870, y: 50, w: 800, h: 600, pixelSizeUm: { x: 0.5, y: 0.5 } },
  ];
  const B = S.doc.layoutMaps[1].pixelSizeUm;
  // A 100 µm bar in B, 30 px above B's bottom edge.
  const bar = { id: 's', type: 'scalebar', rotation: 0, x1: 1000, y1: 620, value: 100, unit: 'um', style: {} };
  F._setScaleBarEnd(bar);
  assert.ok(bar.x2 === 1200 && bar.y2 === 620, 'laid with B\'s calibration: 200 px');
  const snap = clone(bar);
  F._rotateLayerFromSnapshot(bar, snap, -90);
  assert.ok(bar.y1 > 650, 'the turn carries x1 below cell B (the failure case)');
  let p = F._linePoints(bar);
  near(p.y1 - p.y2, 200, 1e-9, 'still 200 px: B\'s 0.5 µm/px');
  near((p.y1 + p.y2) / 2, 620, 1e-9, 'about its middle');
  near(F._lineLengthUm(bar), 100, 1e-9, 'measures 100 µm in B');
  assert.equal(bar.text, '100 um');
  assert.equal(F._layerPixelSize(bar), B, 'calibrated by B, not the document\'s (A)');
  F._rotateLayerFromSnapshot(bar, snap, 0);
  assert.ok(bar.x1 === 1000 && bar.y1 === 620 && bar.x2 === 1200 && bar.y2 === 620, 'back at 0° exactly');

  // A distance at the same spot keeps its 100.00 µm.
  const ruler = { id: 'd', type: 'distance', rotation: 0, x1: 1000, y1: 620, x2: 1200, y2: 620, style: {} };
  assert.equal(F._measurementLabel(ruler), '100.00 um');
  F._rotateLayerFromSnapshot(ruler, clone(ruler), -90);
  assert.ok(ruler.y1 > 650 || ruler.y2 > 650, 'one end leaves B');
  assert.equal(ruler.text, '100.00 um', 'the turned ruler still reads 100.00 µm');
  near(F._lineLengthUm(ruler), 100, 1e-9);

  // An angle near B's edge: its centroid stays in B, so does its calibration.
  const angle = { id: 'a', type: 'angle', rotation: 0, x1: 1000, y1: 640, x2: 1100, y2: 640, x3: 1000, y3: 600, style: {} };
  const measured = F._angleDegrees(angle);
  F._rotateLayerFromSnapshot(angle, clone(angle), 150);
  assert.equal(F._layerPixelSize(angle), B, 'the angle is still calibrated by B');
  near(F._angleDegrees(angle), measured, 1e-9, 'and reads the same angle');

  // A bar drafted near A's right edge: with A's 0.25 µm/px its middle falls in B, with
  // B's 0.5 µm/px it falls in A — no cell is self-consistent. The start point's cell
  // decides, so rewriting the far end (every value edit, every turn) never flips it.
  const edge = { id: 'e', type: 'scalebar', rotation: 0, x1: 700, y1: 300, x2: 700, y2: 300, value: 100, unit: 'um', style: {} };
  const drawn = [];
  for (let i = 0; i < 6; i++) {
    F._setScaleBarEnd(edge);
    const q = F._linePoints(edge);
    drawn.push(q.x2 - q.x1);
    near(edge.x2, q.x2, 1e-9, 'the stored end is the drawn end');
  }
  assert.ok(drawn.every(v => Math.abs(v - 400) < 1e-9), `stable 400 px (A under the start), got ${drawn.join(', ')}`);
  for (let i = 0; i < 4; i++) {
    F._rotateLayerFromSnapshot(edge, clone(edge), F._layerRotationDeg(edge) + 90);
    const q = F._linePoints(edge);
    near(Math.hypot(q.x2 - q.x1, q.y2 - q.y1), F._lengthInPixels('um', 100, F._umPerPixelAlong(Math.cos(0), 0, F._layerPixelSize(edge))), 1e-6, 'drawn length follows the chosen cell');
    near(edge.x2, q.x2, 1e-6, 'stored end = drawn end after a turn');
    near(edge.y2, q.y2, 1e-6);
  }
  // Both cells self-consistent: the one the stored middle is in keeps the bar.
  const both = { id: 'b', type: 'scalebar', rotation: 0, x1: 845, y1: 300, x2: 845, y2: 300, value: 10, unit: 'um', style: {} };
  F._setScaleBarEnd(both);
  const firstCell = F._layerPixelSize(both);
  for (let i = 0; i < 4; i++) { F._setScaleBarEnd(both); assert.equal(F._layerPixelSize(both), firstCell, 'no flip between two self-consistent cells'); }

  // A middle in the gutter between the cells takes the nearest cell.
  assert.equal(F._layerPixelSize({ type: 'distance', x1: 840, y1: 300, x2: 884, y2: 300 }), B, 'middle at x = 862: B is nearer');
  assert.equal(F._layerPixelSize({ type: 'distance', x1: 830, y1: 300, x2: 880, y2: 300 }), S.doc.layoutMaps[0].pixelSizeUm, 'middle at x = 855: A is nearer');
  // A layer wholly inside a cell: that cell, as before.
  assert.equal(F._layerPixelSize({ type: 'distance', x1: 100, y1: 100, x2: 300, y2: 100 }), S.doc.layoutMaps[0].pixelSizeUm);
  // A single slice: the document's calibration, whatever the points.
  S.doc = makeDoc({ x: 0.7, y: 0.9 });
  assert.equal(F._layerPixelSize({ type: 'distance', x1: -5000, y1: 0, x2: 9000, y2: 4 }), S.doc.calibration.pixelSizeUm, 'single slice: one calibration');
  console.log('Compare cell calibration stable under a turn: OK');
}

// ── Structural: controls, export path, i18n fallbacks ─────────────────────────
{
  assert.ok(/id="prop-rotation"[^>]*min="-180" max="180" step="1"/.test(SRC), 'slider −180..180 step 1');
  assert.ok(/id="prop-rotation-num"/.test(SRC) && /id="prop-rotation-reset"/.test(SRC), 'degree field + reset');
  assert.ok(/slider\.addEventListener\('change', \(\) => apply\(slider\.value, true/.test(SRC), "slider commits on 'change'");
  assert.ok(/slider\.addEventListener\('input', \(\) => apply\(slider\.value, false/.test(SRC), "slider previews on 'input'");
  for (const k of ['studio.propRotation', 'studio.resetRotation', 'studio.rotateHandleHint', 'studio.rotationLocked']) {
    assert.ok(SRC.includes(`'${k}'`), `${k} has an English fallback in code`);
  }
  const compose = SRC.slice(SRC.indexOf('function _composeExportCanvas'), SRC.indexOf('function _drawExportStamp'));
  assert.ok(/_drawLayer\(ctx, layer/.test(compose), 'the PNG export draws layers through _drawLayer (rotation included)');
  assert.ok(!/TOOL_KEYS = \{[^}]*['"][\[\]{}]['"]/.test(SRC), 'no tool shortcut on [ ] { }');
  console.log('structure: OK');
}

console.log('Studio layer rotation: ALL PASS');
