// The admin Datasets tab must answer "is there something to save?" by COMPARING
// VALUES, not by counting events — and "continue without saving" must actually
// throw the edits away.
//
// Two bugs this locks down:
//   1. opening a dataset (then another) raised "Unsaved changes" although nothing
//      had been touched: the preview iframe mirrors the channels/exposure it was
//      pushed straight back to the panel, and every echo used to mark the draft
//      dirty;
//   2. answering "continue without saving" left the dirty flag standing, so every
//      later tab click asked the same question again, forever.
//
// tab-datasets.js is an ES module with DOM-bound imports; it is loaded here into a
// VM with its imports stripped, so the REAL fingerprint/collectForm/discard code
// runs — not a copy of it.
//
// Run: node tests/js/test_admin_dirty_detection.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT } from './harness.mjs';

const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');

// ── Load the tab module headlessly ─────────────────────────────
function stubEl() {
  return {
    value: '', textContent: '', innerHTML: '', checked: false, disabled: false,
    style: {}, className: '',
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    closest: () => stubEl(),
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {}, setAttribute() {}, getAttribute: () => null,
    removeAttribute() {}, remove() {}, focus() {}, insertBefore() {}, appendChild() {},
  };
}

function loadTab() {
  let src = read('js/pages/admin/tab-datasets.js')
    .replace(/^import\s[^;]*;/gm, '')
    .replace(/^export\s+(function|const|let|class)/gm, '$1');

  const unsaved = [];
  const sandbox = {
    console, setTimeout, clearTimeout, JSON, Math, Number, Array, Object, String, Boolean, Date,
    // ── stubs for what the module imports ──
    API_DATASETS: 'api/datasets.php',
    Utils: { DATASET_TYPES: ['3d', '2d', 'live', 'tracking'], datasetTypeLabel: (x) => x, datasetPage: () => 'viewer.html' },
    t: (_k, d) => d ?? '',
    escHtml: (v) => String(v ?? ''),
    apiFetch: async () => null,
    toast() {},
    el: () => stubEl(),
    deepClone: (v) => JSON.parse(JSON.stringify(v)),
    refreshIcons() {},
    setUnsaved: (on) => unsaved.push(!!on),
    setDirtyGuard() {},
    Upload: { subscribe() {} },
    window: { location: { origin: 'http://localhost' }, addEventListener() {} },
    document: { addEventListener() {} },
    confirm: () => true,
  };
  // The module's top-level bindings are in this script's scope, so the tail can
  // reach the internals the tests need to drive.
  src += `
;globalThis.__T = {
  fingerprint,
  mount(draft, original) {
    DOM = new Proxy({}, { get: (t, k) => (t[k] || (t[k] = stubEl())) });
    _draft = draft; _original = original;
    _current = { id: draft.id, path: draft.path, folderName: 'emb-1', hidden: !!draft.hidden };
    _isCalibratingOrientation = false; _formBound = false;
    populateForm();   // the real paint — what makes the form mirror the draft
    clearDirty();
    return DOM;
  },
  sync: () => syncDirty(),
  dirty: () => _dirty,
  draft: () => _draft,
  discard: (o) => discardChanges(o),
  calibrate: (v) => { _isCalibratingOrientation = v; },
};`;
  const ctx = vm.createContext({ ...sandbox, stubEl });
  vm.runInContext(src, ctx, { filename: 'tab-datasets.js' });
  return { T: ctx.__T, unsaved };
}

// A volume as the editor receives it, already normalised by selectDataset().
const META = () => ({
  id: '3d/emb-1', path: '3d/emb-1', type: '3d', name: 'Embryon 1',
  stage: 'E8.5', embryo: 'Em1', description: null, hidden: false,
  dimensions: { x: 512, y: 512, z: 300, c: 2 },
  voxel_size: { x: 0.52, y: 0.52, z: 2 },
  exposure: 1.0,
  channels: [
    { name: 'DAPI', color: '#2F6BFF', min: 0, max: 1, gamma: 1, active: true },
    { name: 'GFP', color: '#00FF66', min: 0.1, max: 0.9, gamma: 1.4, active: true },
  ],
  orientationAxes: { labels: { P: 'Queue', A: 'Tête' }, hidden: ['D'] },
  gallery: [{ file: 'fig1.webp', caption: 'Vue ventrale' }],
});

const { T } = loadTab();

// ── 1. Opening a dataset is not an edit ────────────────────────
{
  const meta = META();
  T.mount(structuredClone(meta), structuredClone(meta));
  T.sync();
  assert.equal(T.dirty(), false, 'a freshly opened dataset has nothing to save');
}

// ── 2. The preview echoing back what we pushed it is not an edit ──
{
  const meta = META();
  const draft = structuredClone(meta);
  T.mount(draft, structuredClone(meta));
  // What the SYNC_CHANNELS / SYNC_EXPOSURE handlers write when the iframe mirrors
  // the state the panel itself pushed on mount.
  draft.channels.forEach((ch, i) => {
    ch.active = meta.channels[i].active; ch.color = meta.channels[i].color;
    ch.min = meta.channels[i].min; ch.max = meta.channels[i].max;
    ch.gamma = meta.channels[i].gamma; ch.name = meta.channels[i].name;
  });
  draft.exposure = 1.0;
  T.sync();
  assert.equal(T.dirty(), false, 'an echo of our own state must not raise "unsaved changes"');
}

// ── 3. A real change IS detected ───────────────────────────────
{
  const meta = META();
  const draft = structuredClone(meta);
  T.mount(draft, structuredClone(meta));
  draft.channels[1].gamma = 2.2;                     // operator moved a gamma slider
  T.sync();
  assert.equal(T.dirty(), true, 'a changed gamma is an unsaved change');

  draft.channels[1].gamma = 1.4;                     // and back again
  T.sync();
  assert.equal(T.dirty(), false, 'reverting a value clears the unsaved state');
}

// ── 4. The form fields are part of the comparison ──────────────
{
  const meta = META();
  const DOM = T.mount(structuredClone(meta), structuredClone(meta));
  // mount() ran the real populateForm(): the fields already mirror the draft, and
  // reading them back must produce the same metadata.
  T.sync();
  assert.equal(T.dirty(), false, 'the untouched form is not a change');
  assert.equal(DOM.fName.value, meta.name, 'populateForm painted the name');

  DOM.fStage.value = 'E9.5';
  T.sync();
  assert.equal(T.dirty(), true, 'a retyped stage is an unsaved change');
  assert.equal(T.draft().stage, 'E9.5', 'the typed value reached the draft');
  assert.equal(T.draft().stageNumeric, 9.5, 'stageNumeric is re-derived from it');
}

// ── 5. Values the UI cannot represent are not phantom edits ────
{
  // Exposure round-trips through a 20..500 integer slider: a metadata value outside
  // that range comes back clamped and must not read as an operator edit.
  const meta = META(); meta.exposure = 0.05;
  T.mount(structuredClone(meta), structuredClone(meta));   // the slider clamps to 20 → 0.2×
  T.sync();
  assert.equal(T.dirty(), false, 'a clamped exposure is not an edit');
}
{
  // Axis labels: the file keeps its own key order, writeOrientationCfg rebuilds a
  // canonical one. Same labels, different key order — not an edit.
  const meta = META();
  const draft = structuredClone(meta);
  draft.orientationAxes = { labels: { A: 'Tête', P: 'Queue' }, hidden: ['D'] };
  T.mount(draft, structuredClone(meta));
  T.sync();
  assert.equal(T.dirty(), false, 'axis-label key order is not an edit');

  draft.orientationAxes.labels.A = 'Rostral';
  T.sync();
  assert.equal(T.dirty(), true, 'a renamed axis IS an edit');
}
{
  // An absent block and an explicitly-empty one mean the same thing.
  const meta = META(); delete meta.orientationAxes; delete meta.gallery;
  const draft = structuredClone(meta); draft.orientationAxes = null; draft.gallery = [];
  T.mount(draft, structuredClone(meta));
  T.sync();
  assert.equal(T.dirty(), false, 'an empty orientation block is not an edit');
}

// ── 6. A pending calibration counts, cancelling it releases ────
{
  const meta = META();
  T.mount(structuredClone(meta), structuredClone(meta));
  T.calibrate(true);
  T.sync();
  assert.equal(T.dirty(), true, 'a calibration in progress has a pose to save');
  T.calibrate(false);
  T.sync();
  assert.equal(T.dirty(), false, 'cancelling the calibration leaves nothing pending');
}

// ── 7. "Continue without saving" FORGETS the edits ─────────────
{
  const meta = META();
  const draft = structuredClone(meta);
  const DOM = T.mount(draft, structuredClone(meta));
  DOM.fName.value = 'Renommé';
  draft.channels[0].color = '#ff0000';
  T.calibrate(true);
  T.sync();
  assert.equal(T.dirty(), true, 'precondition: there is something to discard');

  T.discard({ repaint: false });
  assert.equal(T.dirty(), false, 'discarding clears the unsaved state');
  assert.deepEqual(T.draft().channels, META().channels, 'the draft is back to the saved metadata');
  assert.equal(T.draft().name, META().name, 'the abandoned rename is gone');

  // The regression: the flag used to come straight back on the next evaluation,
  // re-asking the question at every single tab click.
  T.sync();
  assert.equal(T.dirty(), false, 'the discarded edits do not come back');
}

// ── 8. The wiring that carries the answer ──────────────────────
{
  const bus = read('js/pages/admin/bus.js');
  assert.match(bus, /export function setDirtyGuard\(fn, discard\)/, 'the guard carries a discard handler');
  assert.match(bus, /export function discardDirty\(\)/, 'bus exposes discardDirty');

  const shell = read('js/pages/admin/shell.js');
  const guard = shell.slice(shell.indexOf('function switchTab'), shell.indexOf('function switchTab') + 900);
  const ask = guard.indexOf("confirm(t('admin.confirmDiscard'");
  const drop = guard.indexOf('discardDirty();');
  assert.ok(ask > 0 && drop > ask, 'the shell drops the edits once the operator confirms');

  const tab = read('js/pages/admin/tab-datasets.js');
  assert.match(tab, /setDirtyGuard\(\(\) => _dirty, \(\) => discardChanges\(\)\)/, 'the Datasets tab registers both');
}

// ── 9. The preview must not echo the state it was handed ───────
{
  const viewer = read('js/pages/viewer.js');
  assert.match(viewer, /if \(_isIframe && _isInitialized && !_suppressChannelSync\)/,
    'the SYNC_CHANNELS emitter is gated by the suppression flag');
  const restore = viewer.slice(viewer.indexOf('if (Array.isArray(viewerState.channels))'),
    viewer.indexOf('if (Array.isArray(viewerState.channels))') + 800);
  assert.ok(/_suppressChannelSync = true;[\s\S]*ChannelPanel\.setState/.test(restore),
    'a bulk channel restore is applied with the wire silenced');
  assert.ok(/finally \{ _suppressChannelSync = false; \}/.test(restore),
    'the flag is released even if setState throws');

  const exposure = viewer.slice(viewer.indexOf('function _syncExposureFromUi'),
    viewer.indexOf('function _syncExposureFromUi') + 800);
  assert.ok(/if \(_isIframe && _isInitialized\)/.test(exposure),
    'seeding the exposure slider at boot is not broadcast as an edit');
}

console.log('admin dirty detection (value-based · echo-proof · discard honoured): OK');
