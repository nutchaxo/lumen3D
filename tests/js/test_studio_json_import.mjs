// Importing a Studio JSON into the open Studio (js/components/studio-editor.js):
//   • the file is applied to the figure that is OPEN: its geometry (size, Compare cell
//     layout, calibration) and every Compare cell's runtime fields (panel frame, raw
//     channel values, panel slice — never in a file) stay, by reference, so channel
//     edits keep recolouring after an import, and undo / redo keep the raw usable;
//   • the file's channel settings are applied where the file describes the open figure
//     (single slice of the same size and dataset; each Compare cell whose rectangle is
//     the open one's) and the picture is coloured with them at once;
//   • a file saved for another figure (size, dataset, cell layout) still brings its
//     annotations, with a warning, and leaves the mismatching cells as they are;
//   • a malformed file is refused before anything changes, and an import that fails
//     while it is applied puts the figure back (document, history, colours);
//   • values inside a layer are made safe (ids, colours, numbers, angles).
//
// The module runs for real in a vm; a hook is spliced in before its `return {` (the
// source file is not modified) to reach the closure's functions and state.
//
// Run: node tests/js/test_studio_json_import.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT } from './harness.mjs';

const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const SRC = read('js/components/studio-editor.js');
const plain = (o) => (o == null ? o : JSON.parse(JSON.stringify(o)));

// ── A browser-ish realm ───────────────────────────────────────────────────────
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
  'studio-channels': makeCanvas('studio-channels'),
};
const downloads = [];
const toasts = [];
const warnings = [];
class FakeBlob {
  constructor(parts, options) { this.parts = parts; this.type = options?.type; }
}
// The file dialog: readAsText hands the file's text over at once.
class FakeFileReader {
  readAsText(file) {
    if (file.unreadable) { this.onerror?.(); return; }
    this.result = file.text;
    this.onload?.();
  }
}
// The compositor, reduced to what the Studio asks of it; every colouring is recorded
// with a copy of the channel state it was given.
const composeCalls = [];
const SliceCompositor = {
  isRaw: (raw) => Boolean(raw && ArrayBuffer.isView(raw.data) && raw.data.length >= raw.width * raw.height * 4),
  compose(raw, state, options) {
    composeCalls.push({ raw, state: plain(state) });
    const target = options?.target || makeCanvas('compose');
    target.width = raw.width;
    target.height = raw.height;
    return target;
  },
  histograms: () => [],
  release() {},
};
// The channel panel: what it was last seeded with, and the operator's edits through
// its change callback. `failNextInit` makes the next seeding throw.
const channelPanel = { inits: [], callback: null, failNextInit: false };
let clock = 0;
const sandbox = {
  console: { ...console, warn: (...a) => warnings.push(a.map(String).join(' ')) },
  encodeURIComponent, Math, JSON, Date, ArrayBuffer, Uint8Array, Set,
  setTimeout: () => 0, clearTimeout() {},
  requestAnimationFrame: () => 0, cancelAnimationFrame() {},
  // Every edit comes after a quiet spell: it is drawn at once.
  performance: { now: () => (clock += 100) },
  Blob: FakeBlob,
  FileReader: FakeFileReader,
  SliceCompositor,
  createChannelPanel: () => ({
    init(id, meta, cb) {
      if (channelPanel.failNextInit) {
        channelPanel.failNextInit = false;
        throw new Error('channel panel failure');
      }
      channelPanel.inits.push(plain(meta.channels));
      channelPanel.callback = cb;
      meta.channels.forEach((c, i) => cb(i, { ...c })); // the seeding replay (ignored)
    },
    setState() {},
    setHistograms() {},
  }),
  // Translated strings come back as «key»: a toast names the key it shows.
  I18n: { t: (k) => `«${k}»`, translateDOM() {} },
  ExportManager: { downloadBlob: (blob, name) => downloads.push({ blob, name }), toast: (t) => toasts.push(t) },
  document: {
    getElementById: (id) => elements[id] || null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    createElement: () => makeCanvas('created'),
    body: { appendChild() {} },
  },
  window: { innerWidth: 800, innerHeight: 600, addEventListener() {} },
};
const RETURN_RE = /\n  return \{\n    init,/;
assert.ok(RETURN_RE.test(SRC), 'studio-editor.js still ends its IIFE with `return { init, …`');
const FNS = ['_importJson', '_exportJson', '_exportPng', '_pushHistory', '_undo', '_redo', '_renderChannels', '_migrateDocument'];
const HOOK = `
  globalThis.__studio = {
    get doc() { return _doc; },
    get history() { return _history; },
    get future() { return _future; },
    get sliceImage() { return _sliceImage; },
    get sliceResult() { return _sliceResult; },
    setActivePanel(i) { _activeStudioPanelIndex = i; },
    fns: { ${FNS.join(', ')} }
  };`;
const ctx = vm.createContext(sandbox);
vm.runInContext(SRC.replace(RETURN_RE, (m) => `\n${HOOK}${m}`) + '\n;globalThis.__SE = StudioEditor;', ctx, { filename: 'studio-editor.js' });
const { __SE: Studio, __studio: S } = ctx;
const F = S.fns;
Studio.init();

const OTHER_FIGURE = '«studio.importOtherFigure»';
const INVALID = '«toast.invalidStudioJson»';

// A raw buffer that must never be serialised (a JSON copy throws at once).
function guardedRaw(w, h, channels = 2) {
  const data = new Uint8Array(w * h * 4);
  Object.defineProperty(data, 'toJSON', { value: () => { throw new Error('raw bytes serialised'); } });
  return { data, width: w, height: h, channels };
}
function panelFrame() {
  const frame = { contentWindow: null };
  frame.self = frame;
  Object.defineProperty(frame, 'toJSON', { value: () => { throw new Error('iframe serialised'); } });
  return frame;
}
const stateA = [
  { name: 'GFP', color: '#00FF00', min: 0, max: 1, gamma: 1, opacity: 1, enabled: true },
  { name: 'DAPI', color: '#0000FF', min: 0, max: 1, gamma: 1, opacity: 1, enabled: true },
];
const CELLS = [{ x: 50, y: 50, w: 1024, h: 1024 }, { x: 1100, y: 50, w: 1024, h: 1024 }];

function openCompare(cells = CELLS, name = 'a vs b') {
  const figure = makeCanvas('figure'); figure.width = 2200; figure.height = 1200;
  const frame = panelFrame();
  const raws = cells.map((_, i) => guardedRaw(512 + i * 8, 512));
  Studio.open({
    canvas: figure, width: 2200, height: 1200, source: 'compare', layoutBackground: '#000000',
    pixelSizeUm: { x: 0.25, y: 0.25 }, channelState: [...plain(stateA), ...plain(stateA)], dataset: { name },
    layoutMaps: cells.map((cell, i) => ({
      ...cell, pixelSizeUm: { x: 0.25 * (i + 1), y: 0.25 * (i + 1) }, channelState: plain(stateA),
      raw: raws[i], iframe: frame, sliceResult: { canvas: makeCanvas('panel'), raw: raws[i] },
    })),
  });
  return { raws, frame, figure };
}
function openSingle({ width = 300, height = 200, id = '3d/em1', planeSpec = { mode: 'xy' }, timepoint, withRaw = true } = {}) {
  const raw = withRaw ? guardedRaw(width, height) : null;
  const canvas = makeCanvas('viewer');
  canvas.width = width;
  canvas.height = height;
  Studio.open({
    canvas, raw, width, height, source: withRaw ? 'studio-preview' : 'gpu-slicer', planeSpec, timepoint,
    pixelSizeUm: { x: 0.5, y: 0.5 }, channelState: plain(stateA),
    dataset: id ? { id, path: id, name: id.split('/')[1] } : { name: 'unnamed slice' },
  });
  return { raw, canvas };
}
// The operator edits channel `idx` of the active cell (or of the single slice).
function editChannel(idx, patch) {
  F._renderChannels();
  const current = S.doc.layoutMaps.length
    ? S.doc.layoutMaps[Math.min(S.doc.layoutMaps.length - 1, activePanel)].channelState[idx]
    : S.doc.channelState[idx];
  channelPanel.callback(idx, { ...current, ...patch });
}
let activePanel = 0;
function setActivePanel(i) { activePanel = i; S.setActivePanel(i); }
function exportText() {
  downloads.length = 0;
  F._exportJson();
  assert.equal(downloads.length, 1, 'one JSON file');
  return downloads[0].blob.parts.join('');
}
function importText(text) {
  const input = { files: [{ text }], value: 'C:\\fakepath\\figure_studio.json' };
  F._importJson({ target: input });
  assert.equal(input.value, '', 'the file input is reset, so the same file can be picked again');
}
// Identity checks on objects holding megabytes of raw values: assert.equal would
// describe them in its failure message, which takes minutes for a typed array.
const same = (actual, expected, message) => assert.ok(actual === expected, message || 'not the same object');
const composedWith = (raw, pick) => composeCalls.some(c => c.raw === raw && pick(c.state));

// ── Compare: save, reopen, import → the same cells, recoloured, still editable ─
let compareJson;
{
  openCompare();
  setActivePanel(0);
  editChannel(1, { enabled: false });
  setActivePanel(1);
  editChannel(0, { color: '#FFFF00', max: 0.5 });
  S.doc.layers.push({ id: 'rect1', type: 'rectangle', rotation: 12, x: 100, y: 120, w: 200, h: 90, visible: true, locked: false, style: { stroke: '#ff4d4f', strokeWidth: 2, opacity: 1 } });
  S.doc.layers.push({ id: 'dist1', type: 'distance', rotation: 0, x1: 1200, y1: 300, x2: 1300, y2: 300, visible: true, locked: false, style: { stroke: '#ffffff', strokeWidth: 2, fontSize: 14 } });
  F._pushHistory('Add layers');
  compareJson = exportText();
  Studio.close();

  // The Studio opened again on the same figure, in the viewer's colours, with new buffers.
  const { raws, frame } = openCompare();
  assert.ok(S.doc.layoutMaps[0].channelState[1].enabled, 'reopened in the viewer\'s colours');
  setActivePanel(0);
  composeCalls.length = 0;
  toasts.length = 0;
  channelPanel.inits.length = 0;
  importText(compareJson);
  assert.deepEqual(toasts, [], 'the file is this figure\'s: no warning');

  S.doc.layoutMaps.forEach((cell, i) => {
    same(cell.raw, raws[i], `cell ${i}: the open figure's raw values, by reference`);
    assert.ok(SliceCompositor.isRaw(cell.raw), `cell ${i}: still a typed raw slice`);
    same(cell.iframe, frame, `cell ${i}: its panel frame`);
    same(cell.sliceResult.raw, raws[i], `cell ${i}: its panel slice`);
    assert.equal(cell.x, CELLS[i].x, `cell ${i}: the open geometry`);
  });
  assert.equal(S.doc.layoutMaps[0].channelState[1].enabled, false, 'cell 0: the file\'s channel settings');
  assert.equal(S.doc.layoutMaps[1].channelState[0].color, '#FFFF00', 'cell 1: the file\'s colour');
  assert.equal(S.doc.layoutMaps[1].channelState[0].max, 0.5, 'cell 1: the file\'s window');
  assert.ok(composedWith(raws[0], s => s[1].enabled === false), 'cell 0 recoloured with the imported settings');
  assert.ok(composedWith(raws[1], s => s[0].color === '#FFFF00' && s[0].max === 0.5), 'cell 1 recoloured with the imported settings');
  assert.equal(channelPanel.inits.at(-1)[1].enabled, false, 'the channel panel shows the imported settings of the active cell');
  assert.deepEqual(plain(S.doc.layers.map(l => [l.id, l.type, l.rotation])), [['rect1', 'rectangle', 12], ['dist1', 'distance', 0]], 'the layers');
  assert.equal(S.doc.layers[1].text, `${(100 * 0.5).toFixed(2)} um`, 'the distance read with its cell\'s calibration');
  assert.deepEqual(plain(S.history.map(h => h.label)), ['Open Studio', 'Import JSON'], 'the import is one more step of the history');
  assert.equal(S.future.length, 0);
  same(S.history[1].doc.layoutMaps[0].raw, raws[0], 'the history entry keeps the raw by reference');
  assert.notEqual(S.history[1].doc, S.doc, 'the history holds a copy');

  // Undo returns to the figure before the import — its layers AND its colours — and
  // redo brings the import back.
  composeCalls.length = 0;
  F._undo();
  assert.equal(S.doc.layers.length, 0, 'undo: the layers before the import');
  assert.equal(S.doc.layoutMaps[0].channelState[1].enabled, true, 'undo: the channels before the import');
  assert.ok(composedWith(raws[0], s => s[1].enabled === true), 'undo: cell 0 recoloured with the channels before the import');
  assert.ok(composedWith(raws[1], s => s[0].color === stateA[0].color), 'undo: cell 1 too');
  S.doc.layoutMaps.forEach((cell, i) => same(cell.raw, raws[i], `undo: cell ${i} keeps its raw`));
  composeCalls.length = 0;
  F._redo();
  assert.equal(S.doc.layers.length, 2, 'redo: the imported layers');
  assert.ok(composedWith(raws[0], s => s[1].enabled === false) && composedWith(raws[1], s => s[0].color === '#FFFF00'), 'redo: the imported colours again');
  // Importing the same file again changes no channel: nothing is recoloured.
  composeCalls.length = 0;
  toasts.length = 0;
  importText(compareJson);
  assert.deepEqual(toasts, [], 'the same file again: no warning');
  assert.equal(composeCalls.length, 0, 'no cell recoloured when its channels do not change');

  // A channel edit after the import recolours from the raw values.
  composeCalls.length = 0;
  setActivePanel(1);
  editChannel(1, { enabled: false });
  assert.ok(composedWith(raws[1], s => s[1].enabled === false && s[0].color === '#FFFF00'), 'a channel toggle after the import recolours cell 1');

  // Undo / redo afterwards keep the raw values usable.
  S.doc.layers.push({ id: 'line1', type: 'line', rotation: 0, x1: 0, y1: 0, x2: 10, y2: 10, visible: true, locked: false, style: {} });
  F._pushHistory('Add line');
  F._undo();
  assert.equal(S.doc.layers.length, 2, 'undo');
  assert.doesNotThrow(() => F._redo(), 'redo never serialises a raw buffer');
  assert.equal(S.doc.layers.length, 3, 'redo');
  S.doc.layoutMaps.forEach((cell, i) => same(cell.raw, raws[i], `after undo / redo cell ${i} keeps its raw`));
  composeCalls.length = 0;
  F._exportPng();
  assert.ok(composedWith(raws[0], () => true) && composedWith(raws[1], () => true), 'the export still colours every cell from its raw values');
  const again = exportText();
  assert.ok(again.length < 20000 && !/"raw"/.test(again), 'the imported document saves without its runtime fields');
  Studio.close();
  console.log('Compare JSON round trip (runtime re-attached, recoloured, editable): OK');
}

// ── Compare: a moved cell and a missing createdAt ─────────────────────────────
{
  const moved = [CELLS[0], { ...CELLS[1], x: 1200 }];
  const { raws } = openCompare(moved);
  setActivePanel(0);
  const file = JSON.parse(compareJson);
  delete file.createdAt;
  composeCalls.length = 0;
  toasts.length = 0;
  importText(JSON.stringify(file));
  assert.deepEqual(toasts, [OTHER_FIGURE], 'a moved cell: the file was saved for another figure');
  assert.equal(S.doc.layoutMaps[1].x, 1200, 'the moved cell keeps the open geometry');
  same(S.doc.layoutMaps[1].raw, raws[1], '… and its own runtime');
  assert.equal(S.doc.layoutMaps[1].channelState[0].color, stateA[0].color, '… and its own channels');
  assert.ok(!composedWith(raws[1], s => s[0].color === '#FFFF00'), 'the moved cell is not recoloured with the file\'s settings');
  assert.equal(S.doc.layoutMaps[0].channelState[1].enabled, false, 'the matching cell takes the file\'s settings');
  assert.ok(composedWith(raws[0], s => s[1].enabled === false), '… and is recoloured');
  assert.equal(S.doc.layers.length, 2, 'the layers are imported');
  assert.ok(S.doc.createdAt, 'a document always has a creation date (it is how _clone recognises one)');
  assert.doesNotThrow(() => F._pushHistory('Edit'), 'history copies never serialise the raw values');
  same(S.history.at(-1).doc.layoutMaps[0].raw, raws[0]);
  Studio.close();

  // Three cells open, two in the file.
  const three = [...CELLS, { x: 50, y: 1100, w: 500, h: 90 }];
  const opened = openCompare(three);
  composeCalls.length = 0;
  toasts.length = 0;
  importText(compareJson);
  assert.deepEqual(toasts, [OTHER_FIGURE], 'another cell count: warning');
  assert.equal(S.doc.layoutMaps.length, 3, 'the open layout stays');
  S.doc.layoutMaps.forEach((cell, i) => {
    same(cell.raw, opened.raws[i], `cell ${i}: its own raw`);
    assert.equal(cell.x, three[i].x, `cell ${i}: its own geometry`);
    assert.deepEqual(plain(cell.channelState), plain(stateA), `cell ${i}: its own channels`);
  });
  assert.equal(composeCalls.length, 0, 'nothing recoloured');
  assert.deepEqual(plain(S.doc.layers.map(l => l.id)), ['rect1', 'dist1'], 'the layers are imported');
  Studio.close();

  // A single-slice file into a Compare figure.
  openCompare();
  toasts.length = 0;
  importText(JSON.stringify({ version: 2, createdAt: 'x', sourceSlice: { width: 2200, height: 1200 }, layoutMaps: [], channelState: [{ enabled: false }], layers: [] }));
  assert.deepEqual(toasts, [OTHER_FIGURE], 'a single slice\'s file is not a Compare figure\'s');
  assert.ok(S.doc.layoutMaps.every(c => c.channelState[0].enabled !== false), 'no channel applied');
  Studio.close();
  console.log('Compare JSON saved for another figure: warned, layers imported, open cells untouched: OK');
}

// ── Single slice ──────────────────────────────────────────────────────────────
let singleJson;
{
  openSingle();
  editChannel(0, { color: '#123456', gamma: 1.5 });
  S.doc.layers.push({ id: 'd', type: 'distance', rotation: 0, x1: 10, y1: 10, x2: 110, y2: 10, visible: true, locked: false, style: {} });
  F._pushHistory('Add distance');
  singleJson = exportText();
  Studio.close();

  const { raw } = openSingle();
  composeCalls.length = 0;
  toasts.length = 0;
  importText(singleJson);
  assert.deepEqual(toasts, [], 'the same figure: no warning');
  assert.equal(S.doc.channelState[0].color, '#123456', 'the file\'s channel settings');
  assert.equal(S.doc.channelState[0].gamma, 1.5);
  assert.ok(composedWith(raw, s => s[0].color === '#123456'), 'the picture is recoloured from the raw values');
  same(S.sliceResult.raw, raw, 'the slice keeps its raw values');
  assert.equal(S.sliceImage.width, 300, 'same frame');
  assert.equal(S.doc.sourceSlice.width, 300);
  assert.equal(S.doc.layers[0].text, '50.00 um', 'the distance read with the open calibration');
  assert.deepEqual(plain(S.history.map(h => h.label)), ['Open Studio', 'Import JSON']);
  // Undo: the 30 annotations of a wrong file are not the end of the figure.
  composeCalls.length = 0;
  F._undo();
  assert.equal(S.doc.layers.length, 0, 'undo: the figure before the import');
  assert.equal(S.doc.channelState[0].color, stateA[0].color, 'undo: its channels');
  assert.ok(composedWith(raw, s => s[0].color === stateA[0].color), 'undo: the picture takes its colours back, from the raw values');
  same(S.sliceResult.raw, raw);
  assert.equal(S.sliceImage.width, 300, 'undo: same frame');
  F._redo();
  assert.equal(S.doc.channelState[0].color, '#123456', 'redo: the imported channels');
  composeCalls.length = 0;
  editChannel(1, { enabled: false });
  assert.ok(composedWith(raw, s => s[1].enabled === false && s[0].color === '#123456'), 'a channel edit after the import recolours');
  Studio.close();

  // Same size, another dataset.
  openSingle({ id: '3d/em2' });
  composeCalls.length = 0;
  toasts.length = 0;
  importText(singleJson);
  assert.deepEqual(toasts, [OTHER_FIGURE], 'another dataset: warning');
  assert.equal(S.doc.channelState[0].color, stateA[0].color, 'the open channels stay');
  assert.equal(composeCalls.length, 0, 'nothing recoloured');
  assert.equal(S.doc.layers.length, 1, 'the layers are imported');
  Studio.close();

  // Same dataset, another size (1 px off is the same figure, 20 px is not).
  openSingle({ width: 301 });
  toasts.length = 0;
  importText(singleJson);
  assert.deepEqual(toasts, [], 'a pixel off: the same figure');
  assert.equal(S.doc.sourceSlice.width, 301, 'the open size is kept');
  Studio.close();
  openSingle({ width: 320 });
  toasts.length = 0;
  importText(singleJson);
  assert.deepEqual(toasts, [OTHER_FIGURE], 'another size: warning');
  assert.equal(S.doc.channelState[0].color, stateA[0].color, 'the open channels stay');
  assert.equal(S.doc.layers.length, 1, 'the layers are imported');
  Studio.close();

  // Channel entries missing or partial: merged over the open ones.
  openSingle();
  toasts.length = 0;
  const partial = JSON.parse(singleJson);
  partial.channelState = [null];
  importText(JSON.stringify(partial));
  assert.deepEqual(toasts, [], 'missing channel entries are not an error');
  assert.deepEqual(plain(S.doc.channelState), plain(stateA), 'a channel the file does not describe keeps its settings');
  partial.channelState = [{ enabled: false, color: 'url(javascript:x)', max: 'wide' }];
  importText(JSON.stringify(partial));
  assert.equal(S.doc.channelState[0].enabled, false, 'a partial entry applies what it gives');
  assert.equal(S.doc.channelState[0].color, stateA[0].color, '… an unreadable colour is ignored');
  assert.equal(S.doc.channelState[0].max, 1, '… an unreadable number is ignored');
  assert.equal(S.doc.channelState.length, 2, 'the open figure decides how many channels there are');
  Studio.close();
  console.log('single slice JSON import (same figure, another dataset / size, partial channels): OK');
}

// ── Malformed files: refused before anything changes ──────────────────────────
{
  openSingle();
  S.doc.layers.push({ id: 'keep', type: 'rectangle', rotation: 0, x: 1, y: 1, w: 5, h: 5, style: {} });
  F._pushHistory('Add rectangle');
  const docBefore = S.doc;
  const historyBefore = S.history;
  const imageBefore = S.sliceImage;
  const base = JSON.parse(singleJson);
  const cases = {
    'not JSON': '{ layers: [',
    'a number': '42',
    'null': 'null',
    'no layers': JSON.stringify({ version: 2, createdAt: 'x' }),
    'layoutMaps not a list': JSON.stringify({ ...base, layoutMaps: {} }),
    'channelState not a list': JSON.stringify({ ...base, channelState: 'red' }),
    'guides not a list': JSON.stringify({ ...base, guides: 3 }),
    'sourceSlice not an object': JSON.stringify({ ...base, sourceSlice: [300, 200] }),
    'a null layer': JSON.stringify({ ...base, layers: [null] }),
    'a layer without a type': JSON.stringify({ ...base, layers: [{ x: 1 }] }),
    'a layer with a numeric type': JSON.stringify({ ...base, layers: [{ type: 5 }] }),
    'an unreadable guide': JSON.stringify({ ...base, guides: [{ axis: 'z', value: 1 }] }),
    'a cell that is not an object': JSON.stringify({ ...base, layoutMaps: [7] }),
    'a cell channelState not a list': JSON.stringify({ ...base, layoutMaps: [{ x: 0, y: 0, w: 1, h: 1, channelState: 'x' }] }),
  };
  for (const [label, text] of Object.entries(cases)) {
    toasts.length = 0;
    composeCalls.length = 0;
    assert.doesNotThrow(() => importText(text), `${label}: never throws`);
    assert.deepEqual(toasts, [INVALID], `${label}: refused with a toast`);
    same(S.doc, docBefore, `${label}: the open document is kept`);
    same(S.history, historyBefore, `${label}: … and its history`);
    same(S.sliceImage, imageBefore, `${label}: … and its picture`);
    assert.equal(composeCalls.length, 0, `${label}: nothing recoloured`);
  }
  assert.deepEqual(plain(S.doc.layers.map(l => l.id)), ['keep']);

  // An unreadable file.
  toasts.length = 0;
  F._importJson({ target: { files: [{ unreadable: true }], value: 'x' } });
  assert.deepEqual(toasts, [INVALID], 'a file that cannot be read: toast');
  same(S.doc, docBefore);

  // Applying fails half-way (the channel panel throws): everything is put back,
  // including the picture's colours.
  toasts.length = 0;
  composeCalls.length = 0;
  channelPanel.failNextInit = true;
  importText(singleJson);
  assert.deepEqual(toasts, [INVALID], 'a failed import: toast');
  same(S.doc, docBefore, 'the document before the import');
  same(S.history, historyBefore, '… its history');
  assert.deepEqual(plain(S.doc.layers.map(l => l.id)), ['keep'], '… its layers');
  assert.ok(composeCalls.length >= 2, 'the picture was recoloured, then recoloured back');
  assert.equal(composeCalls.at(-1).state[0].color, stateA[0].color, 'the picture shows the kept document\'s colours again');
  assert.equal(S.doc.channelState[0].color, stateA[0].color);
  Studio.close();
  console.log('malformed / failing imports keep the open document: OK');
}

// ── Values inside a layer are made safe; old files still import ───────────────
{
  openSingle();
  toasts.length = 0;
  const hostile = JSON.parse(singleJson);
  hostile.groups = [{ id: 'g1', name: 'Group 1' }];
  hostile.layers = [
    { id: '"><img src=x>', type: 'rectangle', x: 'abc', y: 5, w: 10, h: 10, style: { stroke: 'red" onmouseover="x', opacity: 7, strokeWidth: 'wide', dash: '"><b>' } },
    { id: 'dup', type: 'line', x1: null, y1: 0, x2: 4, y2: 4, groupId: 'g1', style: 'bold' },
    { id: 'dup', type: 'text', text: 42, rotation: 370, groupId: 'nope', unit: 'furlong', visible: 'no' },
    { id: 7, type: 'scalebar', x1: 10, y1: 150, x2: 0, y2: 150, value: -3, unit: 'µm', rotation: 0, style: { startCap: 'bar', endCap: 'spike' } },
    { id: 'future', type: 'polygon', points: [{ x: 1, y: 2 }, { x: 'a', y: 3 }, null] },
  ];
  importText(JSON.stringify(hostile));
  assert.deepEqual(toasts, [], 'a readable file with odd values imports');
  const [rect, line, text, bar, poly] = S.doc.layers;
  assert.equal(S.doc.layers.length, 4, 'a layer of a kind the Studio does not draw is left out');
  assert.equal(poly, undefined);
  const ids = S.doc.layers.map(l => l.id);
  assert.ok(ids.every(id => /^[A-Za-z0-9_.:-]+$/.test(id)), `ids are plain tokens: ${ids}`);
  assert.equal(new Set(ids).size, ids.length, 'ids are unique');
  assert.equal(line.id, 'dup', 'the first of two equal ids is kept');
  assert.equal(bar.id, '7', 'a numeric id becomes the string the layer list compares');
  assert.equal(rect.x, 0, 'a coordinate that is not a number → 0');
  assert.equal(rect.style.stroke, undefined, 'an unsafe colour is dropped');
  assert.equal(rect.style.opacity, 1, 'opacity clamped');
  assert.equal(rect.style.strokeWidth, undefined, 'an unreadable width is dropped');
  assert.equal(rect.style.dash, undefined, 'an unknown style value with markup is dropped');
  assert.equal(line.x1, 0);
  assert.deepEqual(plain(line.style), {}, 'a style that is not an object');
  assert.equal(line.groupId, 'g1', 'a known group is kept');
  assert.equal(text.groupId, null, 'an unknown group is dropped');
  assert.equal(text.text, '42');
  assert.equal(text.rotation, 10, 'angle normalised');
  assert.equal(text.unit, undefined, 'an unknown unit is dropped');
  assert.equal(text.visible, true);
  assert.equal(bar.unit, 'um', 'µm is spelled um');
  assert.equal(bar.value, undefined, 'a non-positive scale bar value is dropped (the default applies)');
  assert.equal(bar.style.startCap, 'bar');
  assert.equal(bar.style.endCap, undefined, 'an unknown cap is dropped');
  assert.equal(bar.x2, 10 + 100 / 0.5, 'the scale bar end is re-derived from its value and the open calibration');
  assert.equal(line.x2, 4, 'given coordinates kept');
  assert.ok(['x', 'y', 'w', 'h'].every(k => Number.isFinite(text[k])), 'a coordinate the layer is drawn from and the file left out is a number (0), never NaN');
  Studio.close();

  // The first Studio files: a bare list of layers.
  openSingle();
  toasts.length = 0;
  importText(JSON.stringify([{ type: 'rectangle', x: 1, y: 2, w: 3, h: 4, color: '#ff0000' }]));
  assert.deepEqual(toasts, [], 'a legacy list imports without a warning');
  assert.equal(S.doc.layers.length, 1);
  assert.equal(S.doc.layers[0].style.stroke, '#ff0000', 'its colour is migrated');
  assert.deepEqual(plain(S.doc.channelState), plain(stateA), 'it carries no channels: the open ones stay');
  Studio.close();

  // The layer rotation test's contract: _migrateDocument returns the checked layers.
  openSingle();
  const migrated = F._migrateDocument({ version: 2, layers: [{ id: 'a', type: 'text', rotation: 190, x: 0, y: 0, text: 'x' }] });
  assert.equal(migrated.layers[0].rotation, -170);
  Studio.close();

  // A v1.0.0 cap: 'flat' is the bar cap's first name (the renderer still draws it).
  openSingle();
  importText(JSON.stringify([{ type: 'line', x1: 0, y1: 0, x2: 10, y2: 0, startCap: 'flat', endCaps: 'flat' }]));
  assert.equal(S.doc.layers[0].style.startCap, 'bar', 'a flat start cap is a bar');
  assert.equal(S.doc.layers[0].style.endCap, 'bar', 'a flat end cap is a bar');
  importText(JSON.stringify({ ...JSON.parse(singleJson), layers: [{ id: 'l', type: 'arrow', x1: 0, y1: 0, x2: 5, y2: 5, style: { endCap: 'flat' } }] }));
  assert.equal(S.doc.layers[0].style.endCap, 'bar', 'in a v2 file too');
  Studio.close();
  console.log('layer values made safe, legacy files import: OK');
}

// ── Compare: another pair of datasets with the same cells; channel names ───────
{
  openCompare(CELLS, 'Em1 vs Em2');
  setActivePanel(0);
  editChannel(0, { name: 'Tomato', color: '#FF00FF', max: 0.2 });
  S.doc.layers.push({ id: 'r', type: 'rectangle', rotation: 0, x: 60, y: 60, w: 10, h: 10, visible: true, locked: false, style: {} });
  F._pushHistory('Add rectangle');
  const em12 = exportText();
  Studio.close();

  for (const name of ['Em3 vs Em4', 'Em2 vs Em1']) {
    const { raws } = openCompare(CELLS, name);
    composeCalls.length = 0;
    toasts.length = 0;
    importText(em12);
    assert.deepEqual(toasts, [OTHER_FIGURE], `${name}: another figure, although every cell has the same rectangle`);
    assert.deepEqual(plain(S.doc.layoutMaps[0].channelState), plain(stateA), `${name}: its channels stay (name, colour, window)`);
    assert.ok(!composeCalls.some(c => c.raw === raws[0]), `${name}: nothing recoloured`);
    assert.deepEqual(plain(S.doc.layers.map(l => l.id)), ['r'], `${name}: the layers are imported`);
    Studio.close();
  }

  // The same pair: the settings and the channel names come with the file.
  openCompare(CELLS, 'Em1 vs Em2');
  toasts.length = 0;
  importText(em12);
  assert.deepEqual(toasts, [], 'the same pair: no warning');
  assert.equal(S.doc.layoutMaps[0].channelState[0].color, '#FF00FF');
  assert.equal(S.doc.layoutMaps[0].channelState[0].name, 'Tomato', 'the same datasets: the channel name too');
  Studio.close();
  // A figure that names nothing makes no claim: settings apply, a name does not.
  openCompare(CELLS, null);
  toasts.length = 0;
  importText(em12);
  assert.deepEqual(toasts, [], 'no name to compare: no warning');
  assert.equal(S.doc.layoutMaps[0].channelState[0].color, '#FF00FF', 'the settings apply');
  assert.equal(S.doc.layoutMaps[0].channelState[0].name, 'GFP', 'the name is not taken on an unconfirmed identity');
  Studio.close();
  // A single slice: a file that names no dataset brings its settings, not its names.
  openSingle();
  editChannel(0, { name: 'Renamed', color: '#ABCDEF' });
  const named = JSON.parse(exportText());
  Studio.close();
  openSingle();
  importText(JSON.stringify(named));
  assert.equal(S.doc.channelState[0].name, 'Renamed', 'the same dataset id: the name follows');
  Studio.close();
  openSingle();
  importText(JSON.stringify({ ...named, dataset: null }));
  assert.equal(S.doc.channelState[0].color, '#ABCDEF', 'no dataset in the file: the settings apply');
  assert.equal(S.doc.channelState[0].name, 'GFP', '… but not the name');
  Studio.close();
  console.log('figure identity (Compare pair by name, channel names only on a confirmed identity): OK');
}

// ── Plane and timepoint are part of the figure ────────────────────────────────
{
  const slab = (value) => ({ mode: 'oblique', axis: 'z', value, yaw: 0, pitch: 0, roll: 20, slabThickness: 5, projection: 'mip' });
  openSingle({ planeSpec: slab(40 / 58), timepoint: 5 });
  editChannel(0, { color: '#FF0000' });
  S.doc.layers.push({ id: 'cell', type: 'text', rotation: 0, x: 10, y: 10, text: 'a cell', visible: true, locked: false, style: {} });
  F._pushHistory('Add text');
  const saved = exportText();
  Studio.close();
  const cases = [
    ['another z-stack slice', { planeSpec: slab(10 / 58), timepoint: 5 }, [OTHER_FIGURE]],
    ['another timepoint', { planeSpec: slab(40 / 58), timepoint: 12 }, [OTHER_FIGURE]],
    ['another turn', { planeSpec: { ...slab(40 / 58), roll: 25 }, timepoint: 5 }, [OTHER_FIGURE]],
    ['the same slice (roll a turn apart)', { planeSpec: { ...slab(40 / 58), roll: 380 }, timepoint: 5 }, []],
    ['a timepoint the file does not know', { planeSpec: slab(40 / 58) }, []],
  ];
  for (const [label, options, expected] of cases) {
    openSingle(options);
    toasts.length = 0;
    composeCalls.length = 0;
    importText(saved);
    assert.deepEqual(toasts, expected, `${label}: ${expected.length ? 'warning' : 'no warning'}`);
    assert.equal(S.doc.channelState[0].color, expected.length ? stateA[0].color : '#FF0000', `${label}: channels ${expected.length ? 'kept' : 'applied'}`);
    assert.deepEqual(plain(S.doc.layers.map(l => l.id)), ['cell'], `${label}: the layers are imported`);
    Studio.close();
  }
  console.log('figure match includes the plane and the timepoint: OK');
}

// ── A single slice without raw values cannot take the file's colours ──────────
{
  const { canvas } = openSingle({ withRaw: false });
  const imageBefore = S.sliceImage;
  same(imageBefore, canvas, 'the viewer\'s picture is shown');
  composeCalls.length = 0;
  toasts.length = 0;
  importText(singleJson);
  assert.deepEqual(toasts, ['«studio.importChannelsKept»'], 'the operator is told the channels were kept');
  assert.deepEqual(plain(S.doc.channelState), plain(stateA), 'the channel panel keeps showing the picture\'s channels');
  same(S.sliceImage, imageBefore, 'the picture is left as it is');
  assert.equal(S.doc.sourceSlice.width, 300, 'same frame');
  assert.equal(S.doc.layers.length, 1, 'the layers are imported');
  assert.equal(composeCalls.length, 0);
  Studio.close();
  console.log('single slice without raw values: channels kept, with a toast: OK');
}

// ── A failed Compare import leaves a picture it never drew on exactly as it was ─
{
  // Cells without raw values: a recolour re-renders the cell through the page's own
  // slicer (a Compare panel's document is never reached into: the frame below has
  // nothing the Studio may call).
  const renders = [];
  const panelSlicer = {
    recompose(sr, state) {
      renders.push(plain(state));
      const c = makeCanvas('panel-render');
      c.width = 256;
      c.height = 256;
      return { ...sr, canvas: c, width: 256, height: 256 };
    },
  };
  const frame = { contentWindow: null };
  ctx.VolumeSlicer = panelSlicer;
  Object.defineProperty(frame, 'toJSON', { value: () => { throw new Error('iframe serialised'); } });
  const openPlain = () => {
    const figure = makeCanvas('figure'); figure.width = 2200; figure.height = 1200;
    Studio.open({
      canvas: figure, width: 2200, height: 1200, source: 'compare', layoutBackground: '#000000',
      pixelSizeUm: { x: 0.25, y: 0.25 }, channelState: [...plain(stateA), ...plain(stateA)], dataset: { name: 'p vs q' },
      layoutMaps: CELLS.map(cell => ({ ...cell, channelState: plain(stateA), iframe: frame, sliceResult: { canvas: makeCanvas('panel'), renderRes: 1536, width: 1024 } })),
    });
    return figure;
  };
  openPlain();
  const file = JSON.parse(exportText());
  file.layoutMaps[0].channelState[0].color = '#FF0000';
  Studio.close();

  // Its own file, unchanged: no panel render at all.
  openPlain();
  renders.length = 0;
  importText(exportText());
  assert.equal(renders.length, 0, 'an import that changes no channel renders no cell');
  Studio.close();

  const figure = openPlain();
  same(S.sliceImage, figure, 'the Studio shows the figure compare.js handed over');
  renders.length = 0;
  toasts.length = 0;
  channelPanel.failNextInit = true;
  importText(JSON.stringify(file));
  assert.deepEqual(toasts, [INVALID], 'the import failed');
  assert.equal(renders.length, 1, 'only the changed cell was rendered, once, by the import — the restore renders nothing');
  same(S.sliceImage, figure, 'the untouched original figure is shown again, not a re-rendered copy');
  assert.equal(S.doc.layoutMaps[0].channelState[0].color, stateA[0].color);
  Studio.close();
  delete ctx.VolumeSlicer;
  console.log('failed Compare import: the original figure is restored as is, unchanged cells never re-rendered: OK');
}

// ── Channel numbers are brought into the ranges the channel panel keeps ────────
{
  openSingle();
  toasts.length = 0;
  const base = JSON.parse(singleJson);
  importText(JSON.stringify({ ...base, channelState: [{ ...stateA[0], gamma: 0, opacity: 0, min: 0.8, max: 0.3 }, { ...stateA[1], gamma: 9 }] }));
  assert.deepEqual(toasts, [], 'a readable file');
  const [a, b] = S.doc.channelState;
  assert.equal(a.min, 0.8, 'min kept');
  assert.ok(Math.abs(a.max - 0.81) < 1e-12, `max above min (${a.max})`);
  assert.equal(a.opacity, 0.05, 'opacity at least 0.05');
  assert.equal(a.gamma, 0.18, 'a gamma of 0 (pow(0, 0) = 1: the whole picture in the channel colour) is clamped');
  assert.equal(b.gamma, 5.5, 'a gamma above the panel\'s range is clamped');
  const used = composeCalls.at(-1).state;
  assert.equal(used[0].gamma, 0.18, 'the picture is coloured with the clamped values');
  assert.equal(used[0].opacity, 0.05);
  // A midtone decides the gamma, as in the panel.
  importText(JSON.stringify({ ...base, channelState: [{ ...stateA[0], min: 0, max: 1, midtone: 0.7, gamma: 3 }] }));
  const c = S.doc.channelState[0];
  assert.equal(c.midtone, 0.7);
  assert.ok(Math.abs(c.gamma - Math.log(0.5) / Math.log(0.7)) < 1e-12, `gamma from the midtone (${c.gamma})`);
  // A consistent pair is kept exactly as the file wrote it.
  const g = Math.log(0.5) / Math.log(0.6);
  importText(JSON.stringify({ ...base, channelState: [{ ...stateA[0], min: 0, max: 1, midtone: 0.6, gamma: g }] }));
  assert.equal(S.doc.channelState[0].gamma, g);
  Studio.close();
  console.log('imported channel numbers clamped like the channel panel: OK');
}

assert.ok(!warnings.some(w => /raw bytes serialised|iframe serialised|canvas .* serialised/.test(w)), `nothing was serialised: ${warnings.join(' | ')}`);
console.log('Studio JSON import: OK');
