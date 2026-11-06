// Admin — publishing or discarding the import open in the Datasets editor.
//
//   1. once the list reloads without the open `staging:<type>/<folder>` row, the
//      editor follows the published `<type>/<folder>` (form + preview reloaded from
//      DATA_WEB), or closes when the import was discarded — it never stays bound
//      to an id every save would be refused for;
//   2. the floating dock asks before publishing/discarding that import while the
//      editor holds unsaved edits of it, and drops them only on "continue".
//
// Run: node tests/js/test_admin_staging_publish_editor.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';
import { ROOT } from './harness.mjs';

function stubEl() {
  return {
    value: '', textContent: '', innerHTML: '', checked: false, disabled: false,
    style: {}, className: '', src: '', dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    closest: () => stubEl(),
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {}, setAttribute() {}, getAttribute: () => null,
    removeAttribute() {}, remove() {}, focus() {}, insertBefore() {}, appendChild() {},
  };
}

const META = (id, extra = {}) => ({
  id, path: id, type: '3d', name: 'E85',
  dimensions: { x: 64, y: 64, z: 64, c: 1 },
  voxel_size: { x: 1, y: 1, z: 1 }, exposure: 1,
  channels: [{ name: 'C1', color: '#00FF66', min: 0, max: 1, gamma: 1, active: true }],
  gallery: [],
  ...extra,
});

function loadTab() {
  let src = readFileSync(path.join(ROOT, 'js/pages/admin/tab-datasets.js'), 'utf8')
    .replace(/^import\s[^;]*;/gm, '')
    .replace(/^export\s+(function|const|let|class)/gm, '$1');
  const io = { list: [], metas: {}, gets: [] };
  const sandbox = {
    console, setTimeout, clearTimeout, JSON, Math, Number, Array, Object, String, Boolean, Date, Map, Set, Promise,
    API_DATASETS: 'api/datasets.php',
    Utils: {
      DATASET_TYPES: ['3d', '2d', 'live'], isDatasetType: (x) => ['3d', '2d', 'live'].includes(x),
      datasetTypeLabel: (x) => x, datasetPage: () => 'viewer.html',
    },
    t: (_k, d) => d ?? '',
    escHtml: (v) => String(v ?? ''),
    apiFetch: async (url) => {
      if (url.includes('action=list')) return { datasets: JSON.parse(JSON.stringify(io.list)) };
      const m = /action=get&id=([^&]+)/.exec(url);
      if (m) { const id = decodeURIComponent(m[1]); io.gets.push(id); return JSON.parse(JSON.stringify(io.metas[id] || null)); }
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
    window: { location: { origin: 'http://localhost' }, addEventListener() {} },
    document: { addEventListener() {}, createElement: () => stubEl() },
    confirm: () => true,
  };
  src += `
;globalThis.__T = {
  loadDatasets, selectDataset,
  init() {
    DOM = new Proxy({}, { get: (t, k) => (t[k] || (t[k] = stubEl())) });
    _loaded = true;
  },
  current: () => _current, draft: () => _draft, dirty: () => _dirty,
  frameSrc: () => DOM.previewFrame.src,
  setDirty: () => { _dirty = true; },
};`;
  const ctx = vm.createContext({ ...sandbox, stubEl });
  vm.runInContext(src, ctx, { filename: 'tab-datasets.js' });
  return { T: ctx.__T, io };
}

const settle = () => new Promise((r) => setTimeout(r, 0));
const STAGED = { id: 'staging:3d/E85', path: 'staging:3d/E85', staging: true, stagingState: 'staged', folderName: 'E85' };
const PUBLISHED = { id: '3d/E85', path: '3d/E85', folderName: 'E85', hidden: true };
const OTHER = { id: '3d/E95', path: '3d/E95', folderName: 'E95' };

// ── 1. Published: the editor follows the published dataset ─────
{
  const { T, io } = loadTab();
  T.init();
  io.list = [STAGED, OTHER];
  io.metas['staging:3d/E85'] = META('staging:3d/E85', { staging: true, stagingState: 'staged' });
  io.metas['3d/E85'] = META('3d/E85', { name: 'E85 published' });
  await T.loadDatasets();
  await T.selectDataset('staging:3d/E85');
  assert.equal(T.current().id, 'staging:3d/E85');

  io.list = [PUBLISHED, OTHER];   // the dock published it
  await T.loadDatasets();
  await settle();
  assert.equal(T.current()?.id, '3d/E85', 'the editor now addresses the published dataset');
  assert.equal(io.gets.at(-1), '3d/E85', 'its metadata was re-read from DATA_WEB');
  assert.equal(T.draft().name, 'E85 published');
  assert.match(T.frameSrc(), /path=3d%2FE85/, 'the preview streams the published copy, not the staging proxy');
  assert.equal(T.dirty(), false);
}

// ── 2. Discarded: the editor closes ─────────────────────────────
{
  const { T, io } = loadTab();
  T.init();
  io.list = [STAGED, OTHER];
  io.metas['staging:3d/E85'] = META('staging:3d/E85', { staging: true, stagingState: 'staged' });
  await T.loadDatasets();
  await T.selectDataset('staging:3d/E85');
  T.setDirty();

  io.list = [OTHER];
  await T.loadDatasets();
  await settle();
  assert.equal(T.current(), null, 'nothing left to edit');
  assert.equal(T.draft(), null);
  assert.equal(T.dirty(), false, 'the edits of a dataset that no longer exists are not pending');
  assert.equal(T.frameSrc(), 'about:blank', 'the preview stops streaming');
}

// ── 3. A published dataset open in the editor is left alone ─────
{
  const { T, io } = loadTab();
  T.init();
  io.list = [PUBLISHED, OTHER];
  io.metas['3d/E85'] = META('3d/E85');
  await T.loadDatasets();
  await T.selectDataset('3d/E85');
  const gets = io.gets.length;
  await T.loadDatasets();
  await settle();
  assert.equal(T.current().id, '3d/E85');
  assert.equal(io.gets.length, gets, 'a list reload does not re-open a published dataset');
}

// ── 4. The dock asks before taking the open import away ─────────
{
  const prevDoc = globalThis.document, prevWin = globalThis.window, prevConfirm = globalThis.confirm;
  globalThis.document = { baseURI: 'http://h/admpan.html', getElementById: () => null, addEventListener() {}, title: '' };
  globalThis.window = { location: { origin: 'http://h' }, addEventListener() {} };
  try {
    const bus = await import(pathToFileURL(path.join(ROOT, 'js/pages/admin/bus.js')).href);
    const dock = await import(pathToFileURL(path.join(ROOT, 'js/pages/admin/upload-dock.js')).href);
    let dirty = true, discarded = 0, asked = 0, answer = false;
    globalThis.confirm = () => { asked++; return answer; };
    bus.registerDirtyGuard('datasets', () => dirty, () => { dirty = false; discarded++; });

    assert.equal(bus.openDatasetId(), null, 'nothing open before the Datasets tab registers');
    assert.equal(dock.releaseOpenEditor('3d/E85'), true, 'no editor: nothing to ask');
    assert.equal(asked, 0);

    let open = 'staging:3d/E85';
    bus.setOpenDatasetGetter(() => open);
    assert.equal(dock.releaseOpenEditor('3d/E85'), false, 'Cancel keeps the edits and stops the publish');
    assert.equal(asked, 1);
    assert.equal(discarded, 0);
    assert.equal(dirty, true);

    answer = true;
    assert.equal(dock.releaseOpenEditor('3d/E85'), true);
    assert.equal(discarded, 1, 'continue drops the pending edits for real');
    assert.equal(dirty, false);

    assert.equal(dock.releaseOpenEditor('3d/E85'), true, 'a clean editor is not asked about');
    assert.equal(asked, 2);
    dirty = true;
    assert.equal(dock.releaseOpenEditor('3d/E95'), true, 'another import does not touch the open one');
    assert.equal(asked, 2);
    open = '3d/E85';
    assert.equal(dock.releaseOpenEditor('3d/E85'), true, 'a published dataset of the same name is not the import');
    assert.equal(asked, 2);
  } finally {
    globalThis.document = prevDoc; globalThis.window = prevWin; globalThis.confirm = prevConfirm;
  }
}

console.log('admin staging publish/discard keeps the editor honest: OK');
