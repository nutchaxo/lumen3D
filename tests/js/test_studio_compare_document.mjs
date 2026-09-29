// The Studio document around its Compare cells' runtime fields
// (js/components/studio-editor.js):
//   • a Compare cell carries its panel frame, its raw channel values (w·h·4 bytes) and
//     the panel slice; undo / redo keep them by reference — redo never JSON-copies a
//     history entry — so channel edits still reach the raw values afterwards;
//   • the JSON export writes the document without them (a typed array stringifies one
//     key per byte: hundreds of MB, then a RangeError) and leaves the open document
//     untouched;
//   • closing (and opening a new document) gives back the backing store of the Studio's
//     own canvases: the Compare cell scratch, the slice canvas when it is not the
//     picture on screen, the Compare figure copy on close;
//   • the PNG export uses the picture the Studio holds (no call to a slicer entry point
//     that does not exist) and stamps a z-stack slab (oblique spec, axis 'z', pitch 0)
//     as XY, a genuine oblique cut as OBLIQUE;
//   • the properties of a selected layer are translated like the empty panel.
//
// The module runs for real in a vm; a hook is spliced in before its `return {` (the
// source file is not modified) to reach the closure's functions and state.
//
// Run: node tests/js/test_studio_compare_document.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT } from './harness.mjs';

const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const SRC = read('js/components/studio-editor.js');

// ── A browser-ish realm ───────────────────────────────────────────────────────
const created = [];
function makeCanvas(tag = 'canvas') {
  const log = [];
  const canvas = {
    tag, width: 0, height: 0, style: {}, dataset: {}, id: '', innerHTML: '', log,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener() {}, removeEventListener() {}, appendChild() {}, remove() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
    parentElement: null,
    querySelector: () => null, querySelectorAll: () => [],
    toBlob(cb) { cb({ fakeBlob: true, from: canvas }); },
    // A canvas is a host object: it never goes through JSON.
    toJSON() { throw new Error(`canvas ${tag} serialised`); },
  };
  const ctx = new Proxy({}, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (prop === 'measureText') return (text) => ({ width: String(text).length * 10 });
      if (prop === 'getImageData') return (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4) });
      return (...a) => log.push([prop, ...a]);
    },
    set(target, prop, value) { target[prop] = value; return true; },
  });
  canvas.getContext = (kind) => (kind === '2d' ? ctx : null);
  return canvas;
}

const props = makeCanvas('studio-properties');
let propsHtml = '';
Object.defineProperty(props, 'innerHTML', { get: () => propsHtml, set: (v) => { propsHtml = v; } });
const elements = {
  'studio-layout': makeCanvas('studio-layout'),
  'studio-canvas': makeCanvas('studio-canvas'),
  'studio-properties': props,
};
const downloads = [];
const warnings = [];
let translateCalls = 0;
class FakeBlob {
  constructor(parts, options) { this.parts = parts; this.type = options?.type; }
}
// The compositor, reduced to what the Studio asks of it: a raw slice is recognised the
// way SliceCompositor.isRaw does (a byte view at least w·h·4 long), and colouring one
// sizes the target to it.
const composeCalls = [];
const SliceCompositor = {
  isRaw: (raw) => Boolean(raw && ArrayBuffer.isView(raw.data) && raw.data.length >= raw.width * raw.height * 4),
  compose(raw, state, options) {
    composeCalls.push({ raw, state });
    const target = options?.target || makeCanvas('compose');
    target.width = raw.width;
    target.height = raw.height;
    return target;
  },
  histograms: () => [],
  release() {},
};
const sandbox = {
  console: { ...console, warn: (...a) => warnings.push(a.map(String).join(' ')) },
  encodeURIComponent, Math, JSON, Date, ArrayBuffer, Uint8Array,
  setTimeout: () => 0, clearTimeout() {},
  requestAnimationFrame: () => 0, cancelAnimationFrame() {},
  performance: { now: () => 0 },
  Blob: FakeBlob,
  SliceCompositor,
  I18n: { t: (k) => k, translateDOM: () => { translateCalls++; } },
  ExportManager: { downloadBlob: (blob, name) => downloads.push({ blob, name }), toast() {} },
  document: {
    getElementById: (id) => elements[id] || null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    createElement: () => { const c = makeCanvas('created'); created.push(c); return c; },
    body: { appendChild() {} },
  },
  window: { innerWidth: 800, innerHeight: 600, addEventListener() {} },
};
const RETURN_RE = /\n  return \{\n    init,/;
assert.ok(RETURN_RE.test(SRC), 'studio-editor.js still ends its IIFE with `return { init, …`');
const FNS = ['_undo', '_redo', '_pushHistory', '_exportJson', '_exportPng', '_clone', '_planeLabel', '_renderProperties'];
const HOOK = `
  globalThis.__studio = {
    get doc() { return _doc; },
    get history() { return _history; },
    get future() { return _future; },
    get sliceImage() { return _sliceImage; },
    get sliceResult() { return _sliceResult; },
    setState(s) { if ('selectedId' in s) _selectedId = s.selectedId; },
    fns: { ${FNS.join(', ')} }
  };`;
const ctx = vm.createContext(sandbox);
vm.runInContext(SRC.replace(RETURN_RE, (m) => `\n${HOOK}${m}`) + '\n;globalThis.__SE = StudioEditor;', ctx, { filename: 'studio-editor.js' });
const { __SE: Studio, __studio: S } = ctx;
const F = S.fns;
Studio.init();

// A raw buffer that must never be serialised: a real byte view (the size of a 1024²
// cell) whose toJSON throws, so a JSON copy fails at once instead of after seconds.
function guardedRaw(w, h) {
  const data = new Uint8Array(w * h * 4);
  data[0] = 7;
  Object.defineProperty(data, 'toJSON', { value: () => { throw new Error('raw bytes serialised'); } });
  return { data, width: w, height: h, channels: 2 };
}
const frame = { contentWindow: null };
frame.self = frame; // a window-like object: circular, JSON cannot write it
Object.defineProperty(frame, 'toJSON', { value: () => { throw new Error('iframe serialised'); } });

const stateA = [{ color: '#FF0000', min: 0, max: 1, gamma: 1, opacity: 1, enabled: true },
  { color: '#00FF00', min: 0, max: 1, gamma: 1, opacity: 1, enabled: true }];
function openCompare() {
  const figure = makeCanvas('figure'); figure.width = 2200; figure.height = 1200;
  const rawA = guardedRaw(1024, 1024);
  const rawB = guardedRaw(512, 512);
  const panel = makeCanvas('panel');
  Studio.open({
    canvas: figure, width: 2200, height: 1200, source: 'compare', layoutBackground: '#000000',
    pixelSizeUm: { x: 0.25, y: 0.25 }, channelState: stateA, dataset: { name: 'a vs b' },
    layoutMaps: [
      { x: 50, y: 50, w: 1024, h: 1024, pixelSizeUm: { x: 0.25, y: 0.25 }, channelState: stateA, raw: rawA, iframe: frame, sliceResult: { canvas: panel, raw: rawA } },
      { x: 1100, y: 50, w: 1024, h: 1024, pixelSizeUm: { x: 0.5, y: 0.5 }, channelState: stateA, raw: rawB, iframe: frame, sliceResult: { canvas: panel, raw: rawB } },
    ],
  });
  return { figure, rawA, rawB };
}

// ── Undo / redo keep the raw buffers, by reference, usable ────────────────────
{
  const { rawA, rawB } = openCompare();
  assert.equal(S.history.length, 1, 'the open is one step');
  assert.equal(S.doc.layoutMaps[0].raw, rawA, 'the document holds the cell raw by reference');
  S.doc.layers.push({ id: 'r', type: 'rectangle', rotation: 0, x: 10, y: 10, w: 50, h: 40, style: {} });
  F._pushHistory('Add rectangle');
  S.doc.layers[0].rotation = 30;
  F._pushHistory('Rotate layer');
  for (let round = 0; round < 3; round++) {
    F._undo();
    assert.equal(S.doc.layers[0].rotation, 0, `undo ${round}: the step before`);
    const t0 = Date.now();
    assert.doesNotThrow(() => F._redo(), `redo ${round} never serialises a raw buffer`);
    assert.ok(Date.now() - t0 < 500, 'redo is a reference copy, not a multi-second stringify');
    assert.equal(S.doc.layers[0].rotation, 30, `redo ${round}: the step after`);
  }
  assert.equal(S.future.length, 0, 'nothing left to redo');
  for (const entry of S.history) {
    assert.equal(entry.doc.layoutMaps[0].raw, rawA, `history "${entry.label}" keeps cell 1's raw by reference`);
    assert.equal(entry.doc.layoutMaps[1].raw, rawB, `history "${entry.label}" keeps cell 2's raw by reference`);
    assert.equal(entry.doc.layoutMaps[0].iframe, frame, 'and the panel frame');
    assert.equal(entry.doc.layoutMaps[0].sliceResult.raw, rawA, 'and the panel slice');
  }
  assert.ok(ArrayBuffer.isView(S.doc.layoutMaps[0].raw.data), 'after undo / redo the cell raw is still a typed array');
  assert.ok(SliceCompositor.isRaw(S.doc.layoutMaps[1].raw), '… the compositor still accepts it (channel edits recolour)');
  assert.notEqual(S.history.at(-1).doc, S.doc, 'the document is a copy of the history entry, not the entry itself');
  assert.notEqual(S.history.at(-1).doc.layoutMaps[0], S.doc.layoutMaps[0], '… cell by cell');

  // A history entry handed to _clone goes through the document-aware branch.
  const entry = F._clone({ label: 'x', layerId: 'r', doc: S.doc });
  assert.equal(entry.label, 'x'); assert.equal(entry.layerId, 'r');
  assert.equal(entry.doc.layoutMaps[0].raw, rawA, '_clone of a {label, doc} entry keeps the raw by reference');
  assert.notEqual(entry.doc.layers, S.doc.layers, '… and copies the rest');

  // The channel edit after undo / redo reaches the raw values of the active cell.
  composeCalls.length = 0;
  F._exportPng();
  assert.ok(composeCalls.some(c => c.raw === rawA) && composeCalls.some(c => c.raw === rawB), 'after undo / redo every cell is still coloured from its raw values');
  console.log('undo / redo keep the Compare cells\' raw buffers: OK');

  // ── The JSON export writes the document without the runtime fields ──────────
  downloads.length = 0;
  assert.doesNotThrow(() => F._exportJson(), 'export JSON never serialises a raw buffer, a frame or a canvas');
  assert.equal(downloads.length, 1, 'one file');
  const text = downloads[0].blob.parts.join('');
  assert.ok(text.length < 20000, `a small file (${text.length} chars), not hundreds of MB`);
  const saved = JSON.parse(text);
  assert.equal(saved.layoutMaps.length, 2);
  for (const cell of saved.layoutMaps) {
    for (const key of ['raw', 'iframe', 'sliceResult']) assert.ok(!(key in cell), `the file has no cell ${key}`);
    assert.ok(Number.isFinite(cell.x) && cell.pixelSizeUm && Array.isArray(cell.channelState), 'the cell geometry, calibration and channels are kept');
  }
  assert.equal(saved.layers[0].rotation, 30, 'the layers are written');
  assert.equal(S.doc.layoutMaps[0].raw, rawA, 'the open document keeps its raw values');
  assert.equal(S.doc.layoutMaps[0].iframe, frame, '… and its frames');
  assert.equal(Studio.getDocument().layoutMaps[0].raw, rawA, 'getDocument shares the raw by reference (no copy)');
  console.log('JSON export without the runtime fields: OK');
}

// ── Canvases given back on close and on a new document ────────────────────────
{
  // Compare: the cell scratch (sized to the last cell coloured) and the figure copy.
  const scratch = created.find(c => c.width === 512 && c.height === 512);
  assert.ok(scratch, 'the cell scratch canvas was sized to the last cell coloured');
  const figureCopy = S.sliceImage;
  assert.ok(figureCopy.width === 2200 && figureCopy.tag === 'created', 'the figure the cells are laid on is the Studio\'s copy');
  Studio.close();
  assert.equal(scratch.width, 0, 'close: the cell scratch backing store is given back');
  assert.equal(scratch.height, 0);
  assert.equal(figureCopy.width, 0, 'close: the Compare figure copy is given back');
  assert.equal(S.sliceImage, S.sliceResult.canvas, '… the Studio points at the figure it was handed');

  // A single raw slice: its canvas is the picture on screen, kept on close.
  const raw = guardedRaw(300, 200);
  Studio.open({ canvas: makeCanvas('viewer'), raw, width: 300, height: 200, source: 'studio-preview', planeSpec: { mode: 'xy' }, pixelSizeUm: { x: 1, y: 1 }, channelState: stateA });
  const sliceCanvas = S.sliceImage;
  assert.ok(sliceCanvas.width === 300 && sliceCanvas.tag === 'created', 'the single slice is coloured into the Studio\'s canvas');
  Studio.close();
  assert.equal(sliceCanvas.width, 300, 'close: the slice canvas on screen is not shrunk under the picture');

  // A Compare document opened after it: the slice canvas is no longer shown, it goes.
  openCompare();
  assert.notEqual(S.sliceImage, sliceCanvas);
  assert.equal(sliceCanvas.width, 0, 'a new document gives back the previous slice canvas');
  Studio.close();
  console.log('scratch canvases released: OK');
}

// ── PNG export: the picture held, stamped with the plane it was cut in ────────
{
  const raw = guardedRaw(40, 30);
  const zstack = { mode: 'oblique', axis: 'z', value: 0.5, yaw: 180, pitch: 0, roll: 37, slabThickness: 5, slabStepNorm: 0.01, projection: 'mip' };
  Studio.open({ canvas: makeCanvas('viewer'), raw, width: 40, height: 30, source: 'studio-preview', planeSpec: zstack, pixelSizeUm: { x: 2, y: 2 }, channelState: stateA });
  warnings.length = 0;
  downloads.length = 0;
  created.length = 0;
  F._exportPng();
  assert.equal(downloads.length, 1, 'one PNG');
  assert.ok(downloads[0].name.endsWith('_studio.png'));
  assert.deepEqual(warnings, [], 'no warning: nothing calls a slicer entry point that does not exist');
  const exportCanvas = created[0];
  const drawn = exportCanvas.log.find(e => e[0] === 'drawImage');
  assert.equal(drawn[1], S.sliceImage, 'the export draws the picture the Studio shows');
  const stamp = exportCanvas.log.filter(e => e[0] === 'fillText').map(e => e[1]).join(' ');
  assert.ok(/\| XY mip \|/.test(stamp), `a z-stack slab is stamped XY: "${stamp}"`);
  assert.ok(!/OBLIQUE/.test(stamp), 'never OBLIQUE');
  Studio.close();

  assert.equal(F._planeLabel({ ...zstack, yaw: 0, roll: 0, projection: 'single' }), 'XY single', 'front face, one slice');
  assert.equal(F._planeLabel({ mode: 'oblique', value: 0.4, yaw: 30, pitch: 20, roll: 10, projection: 'single' }), 'OBLIQUE single', 'an inspector cut stays OBLIQUE');
  assert.equal(F._planeLabel({ mode: 'oblique', axis: 'z', yaw: 0, pitch: 12, projection: 'mip' }), 'OBLIQUE mip', 'a tilted plane is oblique whatever its axis says');
  assert.equal(F._planeLabel({ mode: 'oblique', axis: 'oblique', yaw: 0, pitch: 0 }), 'OBLIQUE single', 'the viewer\'s own oblique plane (axis "oblique") stays OBLIQUE');
  assert.equal(F._planeLabel({ mode: 'xz', projection: 'average' }), 'XZ average');
  assert.equal(F._planeLabel({}), 'XY single', 'no spec: the historical default');
  assert.ok(!/renderNative/.test(SRC), 'no call to VolumeSlicer.renderNative (it does not exist)');

  // The label rule rests on what viewer.js hands over for a z-stack figure.
  const viewer = read('js/pages/viewer.js');
  const spec = viewer.slice(viewer.indexOf('function _zstackStudioSpec('), viewer.indexOf('function _zstackStudioSpec(') + 2000);
  assert.ok(/mode: 'oblique',\s*axis: 'z',/.test(spec) && /pitch: 0,/.test(spec), 'viewer.js: the z-stack spec is oblique, axis z, pitch 0');
  console.log('PNG export stamp: OK');
}

// ── A selected layer's properties are translated ──────────────────────────────
{
  const raw = guardedRaw(40, 30);
  Studio.open({ canvas: makeCanvas('viewer'), raw, width: 40, height: 30, source: 'studio-preview', planeSpec: { mode: 'xy' }, pixelSizeUm: { x: 1, y: 1 }, channelState: stateA });
  S.doc.layers.push({ id: 'l1', type: 'line', rotation: 0, x1: 1, y1: 1, x2: 20, y2: 1, style: { stroke: '#fff', strokeWidth: 2 } });
  S.setState({ selectedId: 'l1' });
  const before = translateCalls;
  F._renderProperties();
  assert.ok(/data-i18n="studio.propName"/.test(propsHtml), 'the layer properties are rendered');
  assert.equal(translateCalls, before + 1, 'and translated (data-i18n labels no longer stay English)');
  Studio.close();
  console.log('selected layer properties translated: OK');
}

console.log('Studio Compare document (history, JSON, canvases, stamp): OK');
