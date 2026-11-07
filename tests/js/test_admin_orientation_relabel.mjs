// Admin Datasets tab — switching the admin language while an orientation is being
// calibrated must not cancel the calibration behind the operator's back: the
// button keeps offering "Cancel", the preview is not told to stop, and Save still
// reads the pose back from the gizmo and writes it.
//
// Run: node tests/js/test_admin_orientation_relabel.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT } from './harness.mjs';

function stubEl() {
  const classes = new Set();
  return {
    value: '', textContent: '', innerHTML: '', checked: false, disabled: false,
    style: {}, className: '', dataset: {},
    classList: {
      add: (c) => classes.add(c), remove: (c) => classes.delete(c),
      toggle: (c, on) => { if (on === undefined ? !classes.has(c) : on) classes.add(c); else classes.delete(c); },
      contains: (c) => classes.has(c),
    },
    closest: () => stubEl(),
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {}, setAttribute() {}, getAttribute: () => null,
    removeAttribute() {}, remove() {}, focus() {}, insertBefore() {}, appendChild() {},
  };
}

const listeners = [];
const posted = [];
const saves = [];
const frameWindow = {
  postMessage(msg) {
    posted.push(msg.type);
    if (msg.type === 'GET_ORIENTATION') {
      setTimeout(() => listeners.slice().forEach((fn) => fn({
        source: frameWindow, origin: 'http://localhost',
        data: { type: 'ORIENTATION_RESULT', quaternion: [0, 0, 0.6, 0.8] },
      })), 0);
    }
  },
};

let src = readFileSync(path.join(ROOT, 'js/pages/admin/tab-datasets.js'), 'utf8')
  .replace(/^import\s[^;]*;/gm, '')
  .replace(/^export\s+(function|const|let|class)/gm, '$1');
const sandbox = {
  console, setTimeout, clearTimeout, JSON, Math, Number, Array, Object, String, Boolean, Date, Map, Set, Promise,
  API_DATASETS: 'api/datasets.php',
  Utils: { DATASET_TYPES: ['3d', '2d', 'live'], datasetTypeLabel: (x) => x, datasetPage: () => 'viewer.html' },
  t: (k, d) => `${k}`,
  escHtml: (v) => String(v ?? ''),
  apiFetch: async (url, opts) => {
    if (url.includes('action=save')) { saves.push(JSON.parse(opts.body)); return { ok: true }; }
    return null;
  },
  apiFetchStatus: async () => ({ ok: false, status: 0, data: null }),
  toast() {},
  el: () => stubEl(),
  deepClone: (v) => JSON.parse(JSON.stringify(v)),
  refreshIcons() {},
  setUnsaved() {}, registerDirtyGuard() {}, setDatasetOpener() {}, setOpenDatasetGetter() {}, bindTabSave() {},
  Upload: { subscribe() {} },
  moveToTrash: async () => true, openTrash() {}, fetchTrash: async () => [],
  window: {
    location: { origin: 'http://localhost' },
    addEventListener: (ev, fn) => { if (ev === 'message') listeners.push(fn); },
    removeEventListener: (ev, fn) => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); },
  },
  document: { addEventListener() {}, createElement: () => stubEl() },
  confirm: () => true,
};
src += `
;globalThis.__T = {
  open(meta) {
    DOM = new Proxy({}, { get: (t, k) => (t[k] || (t[k] = stubEl())) });
    DOM.previewFrame.contentWindow = globalThis.__frame;
    _current = { id: meta.id, path: meta.path, folderName: 'E85' };
    _draft = JSON.parse(JSON.stringify(meta));
    _original = JSON.parse(JSON.stringify(meta));
    populateForm();
    clearDirty();
  },
  startCalibration() { _isCalibratingOrientation = true; paintOrientationControls(true); syncDirty(); },
  relabel: () => DatasetsTab.relabel(),
  save: () => saveDatasetNow(),
  calibrating: () => _isCalibratingOrientation,
  dirty: () => _dirty,
  button: () => DOM.btnDefineOrientation,
  status: () => DOM.orientationStatus.textContent,
};`;
const ctx = vm.createContext({ ...sandbox, stubEl, __frame: frameWindow });
vm.runInContext(src, ctx, { filename: 'tab-datasets.js' });
const T = ctx.__T;

T.open({
  id: '3d/E85', path: '3d/E85', type: '3d', name: 'E85',
  dimensions: { x: 64, y: 64, z: 64, c: 1 }, voxel_size: { x: 1, y: 1, z: 1 }, exposure: 1,
  channels: [{ name: 'C1', color: '#00FF66', min: 0, max: 1, gamma: 1, active: true }],
  gallery: [],
});
assert.equal(T.button().innerHTML, 'admin.defineOrientation');
assert.equal(T.status(), 'admin.noOrientation');

T.startCalibration();
assert.equal(T.dirty(), true, 'a calibration in progress is an unsaved change');
T.relabel();   // the operator switches the admin language
assert.equal(T.calibrating(), true, 'the calibration survives the repaint');
assert.equal(T.button().innerHTML, 'admin.cancelOrientation', 'the button still offers to cancel');
assert.ok(T.button().classList.contains('adm-btn-accent') && !T.button().classList.contains('adm-btn-ghost'));
assert.equal(T.status(), 'admin.orientationAdjustHint');
assert.equal(T.dirty(), true);
assert.ok(!posted.includes('CALIBRATE_ORIENTATION_STOP'), 'the preview is not told to stop');

await T.save();
assert.ok(posted.includes('GET_ORIENTATION'), 'Save still asks the gizmo for the pose');
assert.equal(saves.length, 1);
assert.deepEqual(saves[0].orientation, [0, 0, 0.6, 0.8], 'and writes it');
assert.equal(T.calibrating(), false);
assert.equal(T.button().innerHTML, 'admin.defineOrientation');
assert.equal(T.status(), 'admin.orientationSet');
assert.equal(posted.at(-1), 'CALIBRATE_ORIENTATION_STOP', 'the calibration ends once the pose is saved');

// Without a calibration running, a relabel leaves the controls idle.
T.relabel();
assert.equal(T.calibrating(), false);
assert.equal(T.button().innerHTML, 'admin.defineOrientation');

console.log('admin orientation calibration survives a language switch: OK');
