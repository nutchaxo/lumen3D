// Admin Datasets tab — the gallery's server answers must never overwrite what the
// operator is editing, nor land in another dataset.
//
//   1. an upload or a delete answers with the gallery STORED on disk; folding it in
//      keeps the unsaved captions and order of the draft (and keeps them dirty),
//      appends the new file, and drops the deleted one;
//   2. a batch of images dropped on dataset A stops when the operator opens B: no
//      request carries B's id, and A's answer is not written into B's editor.
//
// tab-datasets.js is loaded into a VM with its imports stripped, so the real
// mergeGallery / commitGallery / uploadGalleryFiles / selectDataset run.
//
// Run: node tests/js/test_admin_gallery_merge.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT } from './harness.mjs';

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

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

function loadTab() {
  let src = readFileSync(path.join(ROOT, 'js/pages/admin/tab-datasets.js'), 'utf8')
    .replace(/^import\s[^;]*;/gm, '')
    .replace(/^export\s+(function|const|let|class)/gm, '$1');

  const io = { requests: [], pending: [], toasts: [], metas: {} };
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
      io.requests.push(url);
      const m = /action=get&id=([^&]+)/.exec(url);
      return m ? JSON.parse(JSON.stringify(io.metas[decodeURIComponent(m[1])] || null)) : null;
    },
    apiFetchStatus: (url) => {
      io.requests.push(url);
      const d = deferred();
      io.pending.push(d);
      return d.promise;
    },
    toast: (msg, kind) => io.toasts.push({ msg, kind }),
    el: () => stubEl(),
    deepClone: (v) => JSON.parse(JSON.stringify(v)),
    refreshIcons() {},
    setUnsaved() {}, registerDirtyGuard() {}, setDatasetOpener() {}, setOpenDatasetGetter() {}, bindTabSave() {},
    Upload: { subscribe() {} },
    moveToTrash: async () => true, openTrash() {}, fetchTrash: async () => [],
    window: { location: { origin: 'http://localhost' }, addEventListener() {} },
    document: { addEventListener() {} },
    confirm: () => true,
  };
  src += `
;globalThis.__T = {
  mergeGallery, commitGallery, uploadGalleryFiles, selectDataset, closeEditor,
  setList(list) { _datasets = list; _loaded = true; },
  open(meta) {
    DOM = new Proxy({}, { get: (t, k) => (t[k] || (t[k] = stubEl())) });
    _current = { id: meta.id, path: meta.path };
    _draft = JSON.parse(JSON.stringify(meta));
    _original = JSON.parse(JSON.stringify(meta));
    _formBound = false;
    clearDirty();
  },
  draft: () => _draft, original: () => _original, current: () => _current, dirty: () => _dirty,
};`;
  const ctx = vm.createContext({ ...sandbox, stubEl });
  vm.runInContext(src, ctx, { filename: 'tab-datasets.js' });
  return { T: ctx.__T, io };
}

const plain = (v) => JSON.parse(JSON.stringify(v));
const files = (draft) => plain(draft.gallery.map((g) => g.file));

const META = (id, gallery) => ({
  id, path: id, type: '3d', name: id,
  dimensions: { x: 64, y: 64, z: 64, c: 1 },
  voxel_size: { x: 1, y: 1, z: 1 }, exposure: 1,
  channels: [{ name: 'C1', color: '#00FF66', min: 0, max: 1, gamma: 1, active: true }],
  gallery,
});

// ── 1. Pure merge ─────────────────────────────────────────────
{
  const { T } = loadTab();
  const draft = [{ file: 'b.webp', caption: 'edited B' }, { file: 'a.webp', caption: 'edited A', title: 'T' }];
  const base = [{ file: 'a.webp', caption: 'stored A' }, { file: 'b.webp', caption: 'stored B' }];
  const server = [
    { file: 'a.webp', caption: 'stored A', thumb: 'thumbs/a.webp' },
    { file: 'b.webp', caption: 'stored B', thumb: 'thumbs/b.webp' },
    { file: 'c.webp', caption: '', thumb: 'thumbs/c.webp' },
  ];
  const m = plain(T.mergeGallery(draft, base, server));
  assert.deepEqual(m.draft, [
    { file: 'b.webp', caption: 'edited B', thumb: 'thumbs/b.webp' },
    { file: 'a.webp', caption: 'edited A', title: 'T', thumb: 'thumbs/a.webp' },
    { file: 'c.webp', caption: '', thumb: 'thumbs/c.webp' },
  ], 'draft order and captions kept, server thumb taken, new file appended');
  assert.deepEqual(m.base.map((g) => [g.file, g.caption]),
    [['a.webp', 'stored A'], ['b.webp', 'stored B'], ['c.webp', '']], 'baseline keeps its own order and captions');

  const del = plain(T.mergeGallery(draft, base, [server[0]]));
  assert.deepEqual(del.draft.map((g) => g.file), ['a.webp'], 'a file the server no longer has leaves the draft');
  assert.deepEqual(del.base.map((g) => g.file), ['a.webp'], 'and the baseline');
  assert.deepEqual(plain(T.mergeGallery(null, undefined, null)), { draft: [], base: [] });
}

// ── 2. commitGallery keeps pending edits dirty, a bare add is not dirty ──
{
  const { T } = loadTab();
  T.open(META('3d/a', [{ file: 'a.webp', caption: 'one' }, { file: 'b.webp', caption: 'two' }]));
  T.commitGallery([{ file: 'a.webp', caption: 'one' }, { file: 'b.webp', caption: 'two' }, { file: 'c.webp', caption: '' }]);
  assert.deepEqual(files(T.draft()), ['a.webp', 'b.webp', 'c.webp']);
  assert.equal(T.dirty(), false, 'an upload alone is never an unsaved change');

  T.draft().gallery = [T.draft().gallery[1], T.draft().gallery[0], T.draft().gallery[2]];
  T.draft().gallery[0].caption = 'two — edited';
  T.commitGallery([{ file: 'a.webp', caption: 'one' }, { file: 'b.webp', caption: 'two' },
    { file: 'c.webp', caption: '' }, { file: 'd.webp', caption: '' }]);
  assert.deepEqual(files(T.draft()), ['b.webp', 'a.webp', 'c.webp', 'd.webp'], 'the reorder survives the upload');
  assert.equal(T.draft().gallery[0].caption, 'two — edited', 'the caption survives the upload');
  assert.equal(T.dirty(), true, 'and is still reported as unsaved');
  assert.deepEqual(files(T.original()), ['a.webp', 'b.webp', 'c.webp', 'd.webp']);

  T.commitGallery([{ file: 'a.webp', caption: 'one' }, { file: 'c.webp', caption: '' }, { file: 'd.webp', caption: '' }]);
  assert.deepEqual(files(T.draft()), ['a.webp', 'c.webp', 'd.webp'], 'a delete removes the file and keeps the rest of the order');
}

// ── 3. Opening another dataset mid-upload stops the batch ───────
{
  const { T, io } = loadTab();
  const A = META('3d/a', []);
  const B = META('3d/b', [{ file: 'b-own.webp', caption: 'B caption' }]);
  io.metas['3d/a'] = A; io.metas['3d/b'] = B;
  T.setList([{ id: '3d/a', path: '3d/a' }, { id: '3d/b', path: '3d/b' }]);
  T.open(A);

  const pics = ['1', '2', '3', '4'].map((n) => ({ name: `${n}.png`, type: 'image/png', size: 10 }));
  const run = T.uploadGalleryFiles(pics);
  await Promise.resolve();
  assert.equal(io.pending.length, 1, 'one image in flight at a time');
  io.pending[0].resolve({ ok: true, status: 200, data: { ok: true, gallery: [{ file: '1.png', caption: '' }] } });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(io.pending.length, 2, 'the second image is on its way');

  await T.selectDataset('3d/b');   // the operator opens B while image 2 uploads
  assert.equal(T.current().id, '3d/b');
  io.pending[1].resolve({ ok: true, status: 200, data: { ok: true, gallery: [{ file: '1.png' }, { file: '2.png' }] } });
  await run;

  const adds = io.requests.filter((u) => u.includes('gallery_add'));
  assert.equal(adds.length, 2, 'images 3 and 4 were never sent');
  assert.ok(adds.every((u) => u.includes('id=3d%2Fa')), 'no request carried the other dataset\'s id');
  assert.deepEqual(files(T.draft()), ['b-own.webp'], 'A\'s answer is not written into B\'s draft');
  assert.deepEqual(files(T.original()), ['b-own.webp'], 'nor into B\'s baseline');
  assert.ok(io.toasts.some((x) => x.kind === 'error' && /2/.test(x.msg)), 'the operator is told two images were not sent');
}

// ── 4. Closing the editor also stops it ─────────────────────────
{
  const { T, io } = loadTab();
  T.setList([{ id: '3d/a', path: '3d/a' }]);
  T.open(META('3d/a', []));
  const run = T.uploadGalleryFiles([{ name: '1.png', type: 'image/png', size: 1 }, { name: '2.png', type: 'image/png', size: 1 }]);
  await Promise.resolve();
  T.closeEditor();
  io.pending[0].resolve({ ok: true, status: 200, data: { ok: true, gallery: [{ file: '1.png' }] } });
  await run;
  assert.equal(io.requests.filter((u) => u.includes('gallery_add')).length, 1);
  assert.equal(T.draft(), null, 'nothing is resurrected in a closed editor');
}

console.log('admin gallery merge + upload selection guard: OK');
