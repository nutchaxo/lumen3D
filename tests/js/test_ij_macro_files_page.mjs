// The page side of macro files (ij-cmds-macro.js, DOCS/studio-advanced/macros/FILES.md): the IndexedDB records of §3.4 and their
// round trip (stale snapshot roots after a reload), root naming, the Files section, the pause strip states and their gestures (no picker
// opens outside a click), the pre-run queue, the vfs.confirm / vfs.regrant replies, Dialog path fields and their grants, Download results
// (links or ZIP) and Discard, persist() once, the editor's Open / Save, text.open / window.text, and the lang keys of §12.
// The worker side is a scripted stand-in (api.call answers macro.scan / macro.vfs); IJMacroVFS is the real ij-macro-vfs.js when it is on
// disk, else a stand-in of its pure members (§4.1) kept in this file.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { loadMacroPage, lang, LANGS, lookup, tr, sleep, until, byClass, buttonByText, find, DIR } from './ij_macro_page_fakes.mjs';

if (!fs.existsSync(path.join(DIR, 'ij-cmds-macro.js'))) { console.log('SKIP ij-cmds-macro.js is absent'); process.exit(0); }

const J = (x) => (x === undefined ? x : JSON.parse(JSON.stringify(x)));
const deq = (a, b, m) => assert.deepEqual(J(a), J(b), m);
const done = (o) => Object.assign({ ok: true, aborted: false, exited: false, error: null, prefsWrites: {}, changedDocs: [], undo: { changed: [], dropped: [] } }, o || {});
const errs = [];
const quiet = Object.assign(Object.create(console), { error: (...a) => errs.push(a.map((x) => (x && x.name ? x.name + ': ' + x.message : String(x))).join(' ')) });

// ── IJMacroVFS: the real pure members when the file loads, else a stand-in following FILES.md §3.1, §3.3, §4.1 ──
const RESERVED = ['tmp', 'home', 'macros', 'luts', 'imagej', 'Downloads'];
const STAND_IN_VFS = {
  RESERVED,
  rootName(existing, folderName) {
    const taken = new Set(existing.concat(RESERVED).map((s) => s.toLowerCase()));
    let name = folderName, n = 2;
    while (taken.has(name.toLowerCase())) name = folderName + ' (' + (n++) + ')';
    return name;
  },
  aliasPrefixes(lit) {
    const out = [];
    const unc = lit.indexOf('//') === 0;
    const segs = lit.split('/').filter((s) => s !== '');
    const min = unc ? 2 : 1;
    for (let k = segs.length; k >= min; k--) out.push((unc ? '//' : (/^[A-Za-z]:$/.test(segs[0]) ? '' : '/')) + segs.slice(0, k).join('/') + '/');
    return out;
  },
  formatBytes(n) {
    if (n < 1000) return n + ' B';
    const u = ['KB', 'MB', 'GB', 'TB'];
    let v = n / 1000, i = 0;
    while (v >= 1000 && i < u.length - 1) { v /= 1000; i++; }
    return v.toFixed(1) + ' ' + u[i];
  },
  isMachinePath: (s) => /^[A-Za-z]:\//.test(s) || s.indexOf('//') === 0,
  normalizeSeparators: (s) => String(s).replace(/\\/g, '/')
};
let VFS_IMPL = STAND_IN_VFS;
{
  const file = path.join(DIR, 'ij-macro-vfs.js');
  if (fs.existsSync(file)) {
    try {
      const c = vm.createContext({ console, TextEncoder, TextDecoder, Uint8Array, setTimeout, clearTimeout });
      c.self = c;
      vm.runInContext(fs.readFileSync(file, 'utf8'), c, { filename: 'ij-macro-vfs.js' });
      const real = vm.runInContext('typeof IJMacroVFS !== "undefined" ? IJMacroVFS : null', c);
      if (real && typeof real.rootName === 'function' && typeof real.aliasPrefixes === 'function' && typeof real.formatBytes === 'function') VFS_IMPL = real;
      else console.log('SKIP the real IJMacroVFS: ij-macro-vfs.js does not expose rootName / aliasPrefixes / formatBytes yet');
    } catch (err) { console.log('SKIP the real IJMacroVFS: ij-macro-vfs.js does not load on its own (' + (err && err.name) + ')'); }
  } else console.log('SKIP the real IJMacroVFS: ij-macro-vfs.js is absent (stand-in used)');
}

// ── fakes: IndexedDB, File System Access handles and pickers, entries of a dropped folder ──
const domErr = (name) => Object.assign(new Error(name), { name });
function makeIDB() {
  const dbs = new Map();
  const later = (fn) => setImmediate(fn);
  function request(fn) {
    const req = { onsuccess: null, onerror: null, result: undefined, error: null };
    later(() => { try { req.result = fn(); if (req.onsuccess) req.onsuccess({ target: req }); } catch (e) { req.error = e; if (req.onerror) req.onerror({ target: req }); } });
    return req;
  }
  const api = {
    dbs,
    open(name, version) {
      const req = { onupgradeneeded: null, onsuccess: null, onerror: null, onblocked: null, result: null };
      later(() => {
        let rec = dbs.get(name);
        if (!rec) { rec = { version: 0, stores: new Map() }; dbs.set(name, rec); }
        const db = {
          get objectStoreNames() { return { contains: (n) => rec.stores.has(n), length: rec.stores.size }; },
          createObjectStore(n, o) { if (rec.stores.has(n)) throw domErr('ConstraintError'); rec.stores.set(n, { keyPath: o.keyPath, data: new Map() }); },
          transaction(names, mode) {
            const list = [].concat(names);
            return {
              objectStore(n) {
                if (list.indexOf(n) < 0) throw domErr('NotFoundError');
                const st = rec.stores.get(n);
                if (!st) throw domErr('NotFoundError');
                const rw = () => { if (mode !== 'readwrite') throw domErr('ReadOnlyError'); };
                return {
                  put: (v) => request(() => { rw(); st.data.set(v[st.keyPath], v); return v[st.keyPath]; }),
                  get: (k) => request(() => st.data.get(k)),
                  getAll: () => request(() => Array.from(st.data.values())),
                  delete: (k) => request(() => { rw(); st.data.delete(k); }),
                  clear: () => request(() => { rw(); st.data.clear(); })
                };
              }
            };
          }
        };
        req.result = db;
        if (rec.version < version) { rec.version = version; if (req.onupgradeneeded) req.onupgradeneeded({ target: req, oldVersion: 0, newVersion: version }); }
        if (req.onsuccess) req.onsuccess({ target: req });
      });
      return req;
    },
    store: (name) => { const rec = dbs.get('lumen3d-ij-macro'); return rec && rec.stores.get(name) ? Array.from(rec.stores.get(name).data.values()) : null; }
  };
  return api;
}

let handleSeq = 0;
// one user activation flag for every fake page (a handle stored by one page load is used by the next)
const ACT = { on: false };
function makeEnv() { return { get activation() { return ACT.on; }, set activation(v) { ACT.on = !!v; }, dir: [], open: [], save: [], calls: [], inputs: [], persist: 0, urls: [], scanCalls: [], vfsCalls: [], vfs: null, scan: null, picked: [], saved: [] }; }
function dirHandle(env, name, perm) {
  const h = {
    kind: 'directory', name, _id: ++handleSeq, perm: Object.assign({ read: 'granted', readwrite: 'granted' }, perm || {}), answer: 'granted', requests: [],
    async isSameEntry(o) { return !!o && o._id === h._id; },
    async queryPermission(o) { return h.perm[o.mode]; },
    requestPermission(o) {
      if (!env.activation) return Promise.reject(domErr('SecurityError'));
      h.requests.push(o.mode);
      h.perm[o.mode] = h.answer;
      return Promise.resolve(h.answer);
    }
  };
  return h;
}
const fileHandle = (name) => ({ kind: 'file', name, _id: ++handleSeq });
function installPickers(ctx, env) {
  const gate = (kind, o, list, wrap) => {
    env.calls.push([kind, o]);
    if (!env.activation) return Promise.reject(domErr('SecurityError'));
    const a = list.shift();
    if (a === 'abort' || a === undefined) return Promise.reject(domErr('AbortError'));
    if (a === 'refuseWrite') return Promise.reject(domErr('NotAllowedError'));
    return Promise.resolve(wrap ? wrap(a) : a);
  };
  ctx.showDirectoryPicker = (o) => gate('dir', o, env.dir);
  ctx.showOpenFilePicker = (o) => gate('open', o, env.open, (h) => [h]);
  ctx.showSaveFilePicker = (o) => gate('save', o, env.save);
}
/** A webkitGetAsEntry() tree: { 'a.txt': 'text', 'sub/': {}, 'sub/b.txt': 'x' }; readEntries hands batches of 2 (the walk must loop). */
function entryTree(folder, tree) {
  const dirs = new Map([['', []]]);
  const mk = (rel) => { if (!dirs.has(rel)) { dirs.set(rel, []); const parent = rel.slice(0, rel.slice(0, -1).lastIndexOf('/') + 1); mk(parent); dirs.get(parent).push(dirEntry(rel)); } };
  function dirEntry(rel) {
    const name = rel === '' ? folder : rel.slice(0, -1).split('/').pop();
    return { isDirectory: true, isFile: false, name, createReader() { const kids = dirs.get(rel).slice(); return { readEntries(ok) { setImmediate(() => ok(kids.splice(0, 2))); } }; } };
  }
  for (const rel of Object.keys(tree)) {
    if (rel.endsWith('/')) { mk(rel); continue; }
    const parent = rel.slice(0, rel.lastIndexOf('/') + 1);
    mk(parent);
    const f = new File([tree[rel]], rel.split('/').pop());
    dirs.get(parent).push({ isDirectory: false, isFile: true, name: f.name, file(ok) { setImmediate(() => ok(f)); } });
  }
  return dirEntry('');
}
const relFile = (folder, rel, text) => Object.assign(new File([text], rel.split('/').pop()), { webkitRelativePath: folder + '/' + rel });

function setup(o = {}) {
  const t = loadMacroPage(Object.assign({ console: quiet }, o.page || {}));
  const env = makeEnv();
  const ctx = t.ctx;
  ctx.IJMacroVFS = VFS_IMPL;
  if (o.idb !== null) ctx.indexedDB = o.idb || makeIDB();
  ctx.navigator = { storage: { estimate: async () => ({ usage: 1500, quota: 2000000 }), persist: async () => { env.persist++; return true; } } };
  ctx.URL = { createObjectURL: (f) => { env.urls.push(f); return 'blob:fake/' + env.urls.length; }, revokeObjectURL: () => {} };
  ctx.Blob = Blob;
  // the page revokes a download link after a minute: such a timer must not keep the test alive
  ctx.setTimeout = (fn, ms, ...a) => { const h = setTimeout(fn, ms, ...a); if (ms > 5000 && h && h.unref) h.unref(); return h; };
  if (o.fsa !== false) installPickers(ctx, env);
  const create = ctx.document.createElement;
  ctx.document.createElement = (tag) => {
    const n = create(tag);
    if (String(tag).toLowerCase() === 'input') { env.inputs.push(n); const click = n.click; n.click = () => { n.clickedWithActivation = env.activation; click(); }; }
    return n;
  };
  t.api.pickFile = (opt) => { env.picked.push({ opt, activation: env.activation }); return Promise.resolve(o.pickFile ? o.pickFile(opt) : null); };
  t.api.saveFile = async (name, mime, ext, descKey, produce) => { env.saved.push({ name, mime, ext, descKey, activation: env.activation, blob: await produce() }); return true; };
  const orig = t.api.call;
  t.api.call = async (cmd, args, opt) => {
    if (cmd === 'macro.scan') { env.scanCalls.push(args); return env.scan ? env.scan(args) : { folders: [], files: [], machinePaths: [] }; }
    if (cmd === 'macro.vfs') {
      env.vfsCalls.push([args.op, args, opt]);
      if (env.vfs) return env.vfs(args, opt);
      return args.op === 'changes' ? { rootId: args.rootId, files: [], deleted: [], renamed: [], dirs: [], bytes: 0 } : {};
    }
    return orig(cmd, args, opt);
  };
  const gesture = (fn) => { env.activation = true; try { return fn(); } finally { env.activation = false; } };
  const F = () => t.page._internals.files;
  const V = () => F().state();
  const editor = () => t.panel('macroEditor');
  const filesBody = () => byClass(editor().el, 'ij-mac-files-body')[0];
  const strip = () => editor().inst._state().pause;
  const keyedEl = (k) => find(editor().el, (n) => n.getAttribute && n.getAttribute('data-fkey') === k)[0];
  const btn = (text, rootEl) => buttonByText(rootEl || editor().el, text);
  return { t, env, ctx, gesture, F, V, editor, filesBody, strip, keyedEl, btn };
}
async function openEditor(s) {
  await s.t.api.openPanel('macroEditor', { focus: true });
  await s.F().ensureLoaded();
  await sleep(5);
}

// ── lang keys of FILES.md §12 (four languages, same keys, same {tokens}; the binding English texts) ──
{
  const EN = {
    'err.macFolderNotGranted': 'Folder not granted: {path} — choose it in the Files section of the Macro Editor.',
    'err.macFolderStale': 'The folder {name} must be chosen again in the Files section: this browser forgets folders between visits.',
    'err.macReadOnly': '{path}: this folder is read-only for macros (change its mode in the Files section).',
    'err.macWriteRefused': 'Writing refused: {path}',
    'err.macRootDelete': '{path} is a folder you granted: a macro cannot delete it.',
    'err.macPermission': 'No permission to use {name}: allow it again in the Files section.',
    'err.macQuota': 'Not enough browser storage: {written} written, {free} free',
    'err.macNoStorage': 'This browser gives the page no storage (a private window?): the macro cannot write {path}.',
    'err.macFileGone': '{path} can no longer be read: it changed after the folder was chosen. Choose the folder again.',
    'err.macFileBusy': '{path} is in use by another tab of the Studio.',
    'err.macFileTooLarge': '{path} is too large to be read in the browser.',
    'err.macSaveFormat': '{format} files cannot be written in the browser.',
    'err.macReasonSequence': 'image sequences are not available yet: open the files with open() in a loop, then use Image › Stacks › Images to Stack.',
    'dlg.mac.files.readme': 'Results of macros run in the Lumen3D Advanced Studio on the folder {name}.\nUnzip this archive where the folder {name} is: every file goes to its place.',
    'dlg.mac.files.readmeManual': 'A ZIP archive cannot delete or rename files. Do it by hand:',
    'dlg.mac.files.readmeDelete': 'delete  {path}',
    'dlg.mac.files.readmeRename': 'rename  {from}  ->  {to}',
    'err.macFileDirect': '"{command}" needs a file chosen by hand: it cannot run from a macro.',
    'err.macZipQuota': 'Not enough browser storage to build the archive: discard other results or download the files one by one.',
    'err.macWorkspaceBusy': 'The browser workspace is in use by another tab of the Studio.',
    'err.macNoStorageUi': 'This browser gives the page no storage (a private window?).',
    'err.ioTableInvalid': 'This is not a tab or comma delimited text file.',
    'err.ioTableEmpty': 'The table is empty or invalid.',
    'op.macZip': 'Building the archive',
    'dlg.mac.open': 'Open...', 'dlg.mac.save': 'Save...', 'dlg.mac.ijmFiles': 'ImageJ macros', 'dlg.mac.paused': 'Waiting for you…',
    'dlg.mac.files.title': 'Files', 'dlg.mac.files.addFolder': 'Add folder...', 'dlg.mac.files.drop': 'or drop a folder here',
    'dlg.mac.files.empty': 'No folder yet. Macros can only use the folders you add here.',
    'dlg.mac.files.blockedHint': 'Chrome refuses some folders (a drive root, your user profile, system folders): choose a sub-folder.',
    'dlg.mac.files.browserNote': 'In this browser the folder is read as a copy: what macros write stays in the browser and comes back as a download, and folders must be chosen again at each visit.',
    'dlg.mac.files.mode': 'Mode', 'dlg.mac.files.modeReadonly': 'Read-only', 'dlg.mac.files.modeAsk': 'Ask', 'dlg.mac.files.modeAllow': 'Allow',
    'dlg.mac.files.target': 'Write', 'dlg.mac.files.targetInplace': 'In the folder', 'dlg.mac.files.targetOverlay': 'Browser workspace',
    'dlg.mac.files.kindFolder': 'Folder', 'dlg.mac.files.kindFiles': 'Files', 'dlg.mac.files.kindDownloads': 'Downloads',
    'dlg.mac.files.stateReady': 'Ready', 'dlg.mac.files.statePrompt': 'Needs your permission', 'dlg.mac.files.stateStale': 'Choose again',
    'dlg.mac.files.regrant': 'Allow again...', 'dlg.mac.files.rechoose': 'Choose again...', 'dlg.mac.files.remove': 'Remove', 'dlg.mac.files.chooseReadOnly': 'Choose read-only...',
    'dlg.mac.files.writeRefused': 'Writing was refused for this folder: macros will read it and write to the browser workspace.',
    'dlg.mac.files.aliases': 'Paths written in macros', 'dlg.mac.files.aliasRow': '{literal} → {name}', 'dlg.mac.files.aliasChoose': 'Choose the folder for {literal}...', 'dlg.mac.files.aliasLevel': 'Use for',
    'dlg.mac.files.queue': 'This macro asks for {folders} folders and {files} files', 'dlg.mac.files.queuePick': 'Choose: {prompt}', 'dlg.mac.files.queueReady': '{n} ready', 'dlg.mac.files.queueClear': 'Clear',
    'dlg.mac.files.changes': '{n} changed files', 'dlg.mac.files.download': 'Download results', 'dlg.mac.files.downloadLink': 'Download {name}', 'dlg.mac.files.discard': 'Discard changes',
    'dlg.mac.files.discardConfirm': 'Discard the {n} changes made to {name}? They exist only in this browser.',
    'dlg.mac.files.storage': 'Browser storage: {used} used of {quota}',
    'dlg.mac.pause.choose': 'Choose...', 'dlg.mac.pause.save': 'Save', 'dlg.mac.pause.saveName': 'File name:',
    'dlg.mac.pause.confirmOverwrite': 'The macro wants to replace {path}.', 'dlg.mac.pause.confirmDelete': 'The macro wants to delete {path}.',
    'dlg.mac.pause.confirmRename': 'The macro wants to rename {path} to {to}.', 'dlg.mac.pause.confirmMkdir': 'The macro wants to create {path}, which already exists.',
    'dlg.mac.pause.allowRun': 'Allow for this run', 'dlg.mac.pause.refuse': 'Refuse (macro error)', 'dlg.mac.pause.abort': 'Abort',
    'dlg.mac.pause.regrant': '{name} needs your permission again.', 'dlg.mac.pause.allow': 'Allow'
  };
  const tokens = (s) => (String(s).match(/\{\w+\}/g) || []).sort().join(',');
  for (const k of Object.keys(EN).concat(['cmd.fileImportResults'])) {
    for (const code of LANGS) {
      const v = lookup(lang[code], k);
      assert.equal(typeof v, 'string', code + ': ' + k);
      assert.ok(v.trim().length > 0, code + ': ' + k + ' is not empty');
      assert.equal(tokens(v), tokens(lookup(lang.en, k)), code + ': tokens of ' + k);
    }
  }
  for (const k of Object.keys(EN)) assert.equal(lookup(lang.en, k), EN[k], 'binding English text of ' + k);
  for (const code of ['fr', 'es', 'nl']) {
    // real translations, not copies of the English (names that are the same word in both languages excepted)
    const same = Object.keys(EN).filter((k) => lookup(lang[code], k) === EN[k] && !/\{literal\} → \{name\}|^Mode$|^Downloads$/.test(EN[k]));
    assert.deepEqual(same, [], code + ': untranslated keys');
  }
  const sub = (code, k) => Object.keys(lang[code].dlg.mac[k]).sort().join(',');
  for (const code of LANGS) { assert.equal(sub(code, 'files'), sub('en', 'files'), code + ': dlg.mac.files'); assert.equal(sub(code, 'pause'), sub('en', 'pause'), code + ': dlg.mac.pause'); }
  for (const code of LANGS) assert.equal(lookup(lang[code], 'err.macFileLater'), undefined, code + ': err.macFileLater retired (§12.3)');
  // the README texts reach the worker translated with every macro.vfs request
  const css = fs.readFileSync(path.join(DIR, 'ij-style.css'), 'utf8');
  for (const cls of ['ij-mac-pause', 'ij-mac-files', 'ij-mac-files-toggle', 'ij-mac-files-drop-over']) assert.ok(css.includes('.' + cls), 'ij-style.css: .' + cls);
  // new rules: theme tokens only (no literal colours) in the .ij-mac-files / .ij-mac-pause block
  const block = css.slice(css.indexOf('Macro files (FILES.md)'));
  assert.ok(block.length > 100, 'the files block of ij-style.css');
  assert.ok(!/#[0-9a-fA-F]{3,8}\b|rgba?\(/.test(block), 'the files rules use theme tokens, never literal colours');
}

// ── pure helpers ──
{
  const s = setup();
  const P = s.F();
  assert.equal(P.suggestedName('log', '.txt'), 'log.txt');
  assert.equal(P.suggestedName('log.txt', '.txt'), 'log.txt');
  assert.equal(P.suggestedName('Untitled', ''), 'Untitled');
  assert.equal(P.cleanFileName('  a/b\\c.txt '), 'a_b_c.txt');
  assert.equal(P.cleanFileName('..'), '');
  assert.equal(P.cleanFileName('   '), '');
  const snap = P.snapshotOfFiles([relFile('imgs', 'a.tif', 'A'), relFile('imgs', 'sub/deep/b.txt', 'B'), relFile('imgs', 'sub/c.txt', 'C')]);
  deq({ folderName: snap.folderName, rels: snap.snapshot.rels, dirs: snap.snapshot.dirs }, { folderName: 'imgs', rels: ['a.tif', 'sub/deep/b.txt', 'sub/c.txt'], dirs: ['sub/', 'sub/deep/'] });
  assert.equal(snap.snapshot.files.length, 3);
  assert.equal(P.snapshotOfFiles([new File(['x'], 'loose.txt')]), null, 'a file without a folder is no folder snapshot');
  const walked = await P.snapshotOfEntry(entryTree('drop', { 'a.txt': 'A', 'e/': {}, 'sub/b.txt': 'B', 'sub/c.txt': 'C', 'sub/d.txt': 'D' }));
  deq({ folderName: walked.folderName, rels: walked.snapshot.rels.slice().sort(), dirs: walked.snapshot.dirs.slice().sort() },
    { folderName: 'drop', rels: ['a.txt', 'sub/b.txt', 'sub/c.txt', 'sub/d.txt'], dirs: ['e/', 'sub/'] }, 'every batch of readEntries, empty folders included');
}

// ── Chromium: grants on a click only, names, the IndexedDB records, permissions after a reload ──
const idb = makeIDB();
let grantedId = null;
{
  const s = setup({ idb });
  await openEditor(s);
  const body = s.filesBody();
  assert.ok(body && !body.hidden, 'the Files section is open by default');
  assert.ok(find(body, (n) => n.textContent === tr('dlg.mac.files.empty')).length, 'no folder yet');
  assert.ok(find(body, (n) => n.textContent === tr('dlg.mac.files.blockedHint')).length, 'the Chromium hint on blocked folders');
  assert.equal(find(body, (n) => n.textContent === tr('dlg.mac.files.browserNote')).length, 0, 'no copy note where folders are written in place');
  // a click without user activation: the browser refuses the picker, nothing is granted
  const h1 = dirHandle(s.env, 'data');
  s.env.dir.push(h1);
  s.btn(tr('dlg.mac.files.addFolder')).click();
  await sleep(10);
  assert.equal(s.V().roots.length, 0, 'no grant without a gesture');
  assert.ok(errs.some((e) => e.includes('SecurityError')), 'the refusal is logged, not shown');
  // with the click's activation: the picker is called synchronously inside the handler, readwrite
  s.gesture(() => s.btn(tr('dlg.mac.files.addFolder')).click());
  await until(() => s.V().roots.length === 1, 'root granted');
  deq(s.env.calls.filter((c) => c[0] === 'dir').pop()[1], { mode: 'readwrite' });
  const r1 = s.V().roots[0];
  deq({ name: r1.name, kind: r1.kind, target: r1.target, mode: r1.mode, folderName: r1.folderName }, { name: 'data', kind: 'fsa', target: 'inplace', mode: 'ask', folderName: 'data' });
  assert.ok(/^[0-9a-f]{16}$/.test(r1.id));
  grantedId = r1.id;
  // another folder with the same name, the same folder again, a reserved name
  const h2 = dirHandle(s.env, 'data');
  s.env.dir.push(h2, h1, dirHandle(s.env, 'tmp'));
  s.gesture(() => s.btn(tr('dlg.mac.files.addFolder')).click());
  await until(() => s.V().roots.length === 2, 'second root');
  s.gesture(() => s.btn(tr('dlg.mac.files.addFolder')).click());
  await sleep(20);
  assert.equal(s.V().roots.length, 2, 'the same folder keeps its root (isSameEntry)');
  s.gesture(() => s.btn(tr('dlg.mac.files.addFolder')).click());
  await until(() => s.V().roots.length === 3, 'third root');
  deq(s.V().roots.map((r) => r.name), ['data', 'data (2)', 'tmp (2)']);
  // Choose read-only…: mode 'read', writes to the browser workspace
  const h4 = dirHandle(s.env, 'ro');
  s.env.dir.push(h4);
  s.gesture(() => s.btn(tr('dlg.mac.files.chooseReadOnly')).click());
  await until(() => s.V().roots.length === 4, 'read-only root');
  deq(s.env.calls.filter((c) => c[0] === 'dir').pop()[1], { mode: 'read' });
  const r4 = s.V().roots[3];
  deq({ target: r4.target, writeRefused: r4.writeRefused }, { target: 'overlay', writeRefused: true });
  assert.equal(s.F().grantOf(r4).target, 'overlay');
  // write permission refused at the picker: the section explains, nothing granted
  s.env.dir.push('refuseWrite');
  s.gesture(() => s.btn(tr('dlg.mac.files.addFolder')).click());
  await until(() => s.V().writeRefusedNote, 'writeRefused note');
  assert.ok(find(s.filesBody(), (n) => n.textContent === tr('dlg.mac.files.writeRefused')).length);
  // the rows: name, kind, state, mode select; the mode is stored
  const body2 = s.filesBody();
  assert.ok(find(body2, (n) => n.textContent === '/data (2)/').length);
  const sel = s.keyedEl('mode:' + grantedId);
  deq(sel.children.map((o) => o.textContent), [tr('dlg.mac.files.modeReadonly'), tr('dlg.mac.files.modeAsk'), tr('dlg.mac.files.modeAllow')]);
  sel.value = 'allow';
  sel.dispatch('change');
  await until(() => (idb.store('roots') || []).some((x) => x.id === grantedId && x.mode === 'allow'), 'mode stored');
  const tsel = s.keyedEl('target:' + grantedId);
  assert.ok(tsel, 'a folder written in place offers the browser workspace instead');
  // the records of §3.4: v 1, the handle, never a snapshot or a File
  const recs = idb.store('roots');
  assert.equal(recs.length, 4);
  for (const x of recs) {
    deq(Object.keys(x).filter((k) => ['v', 'id', 'name', 'kind', 'target', 'mode', 'folderName', 'createdAt', 'lastUsedAt', 'handle', 'entries', 'writeRefused'].indexOf(k) < 0), [], 'only the fields of §3.4');
    assert.equal(x.v, 1);
    assert.equal(x.kind, 'fsa');
    assert.ok(x.handle && x.handle.kind === 'directory');
  }
  // every store of version 1 exists, with its keyPath
  const rec = idb.dbs.get('lumen3d-ij-macro');
  assert.equal(rec.version, 1);
  deq(Array.from(rec.stores.entries()).map(([n, st]) => [n, st.keyPath]).sort(), [['aliases', 'literal'], ['macros', 'id'], ['params', 'id'], ['roots', 'id'], ['settings', 'key']]);
  // the storage estimate is shown
  await until(() => find(s.filesBody(), (n) => n.textContent === tr('dlg.mac.files.storage', { used: VFS_IMPL.formatBytes(1500), quota: VFS_IMPL.formatBytes(2000000) })).length, 'storage estimate');
  // remove: the record goes
  s.btn(tr('dlg.mac.files.remove'), s.keyedEl('remove:' + s.V().roots[2].id).parentNode).click();
  await until(() => s.V().roots.length === 3 && idb.store('roots').length === 3, 'removed, record included');
  // the readwrite permission is forgotten by the next visit
  h1.perm.readwrite = 'prompt';
}
{
  // a reload: the grants come back from IndexedDB; a folder whose permission lapsed asks for a click
  const s = setup({ idb });
  await openEditor(s);
  deq(s.V().roots.map((r) => [r.name, r.mode]), [['data', 'allow'], ['data (2)', 'ask'], ['ro', 'ask']]);
  const r = s.V().roots[0];
  const h1 = r.handle;
  assert.ok(find(s.filesBody(), (n) => n.textContent === tr('dlg.mac.files.statePrompt')).length, 'state: needs permission');
  const regrant = s.keyedEl('regrant:' + r.id);
  assert.ok(regrant, 'Allow again…');
  h1.answer = 'granted';
  regrant.click();
  await sleep(10);
  deq(h1.requests, [], 'no permission request without a gesture');
  s.gesture(() => s.keyedEl('regrant:' + r.id).click());
  await until(() => !s.keyedEl('regrant:' + r.id), 'permission granted');
  deq(h1.requests, ['readwrite'], 'a folder written in place asks for readwrite');
}

// ── a run carries the grants, aliases, mount id and queue (§5.1); its needs and changed roots come back ──
{
  const s = setup({ idb });
  await openEditor(s);
  const p = s.t.page.run('open("C:\\\\data\\\\run1\\\\a.tif");');
  await until(() => s.t.lane, 'run');
  const a = s.t.startArgs();
  assert.ok(a.vfs, 'args.vfs');
  assert.ok(/^[0-9a-f]{16}$/.test(a.vfs.mountId), 'mountId: 16 hex');
  deq(a.vfs.queue, { folders: 0, files: 0 });
  deq(a.vfs.roots.map((g) => g.name), ['data', 'data (2)', 'ro', 'Downloads']);
  const dl = a.vfs.roots[3];
  deq(dl, { id: 'downloads', name: 'Downloads', kind: 'downloads', target: 'overlay', mode: 'allow', folderName: 'Downloads' });
  assert.ok(a.vfs.roots[0].handle && a.vfs.roots[0].handle.kind === 'directory', 'the handle travels by structured clone');
  deq(a.vfs.aliases, []);
  const mount = a.vfs.mountId;
  s.t.finish(done({ ok: false, error: { message: 'Folder not granted: C:/data/run1/', line: 1, dialogText: 'x', silent: false },
    vfs: { needs: [{ kind: 'alias', literal: 'C:/data/run1/', prefixes: ['C:/data/run1/', 'C:/data/', 'C:/'] }], changedRoots: [] } }));
  await p;
  // the Files section offers the folder, at the level the user picks
  const choose = await until(() => s.keyedEl('need:C:/data/run1/'), 'need row');
  assert.equal(choose.textContent, tr('dlg.mac.files.aliasChoose', { literal: 'C:/data/run1/' }));
  const lvl = s.keyedEl('need-lvl:C:/data/run1/');
  deq(lvl.children.map((o) => o.value), ['C:/data/run1/', 'C:/data/', 'C:/']);
  lvl.value = 'C:/data/';
  lvl.dispatch('change');
  const hd = dirHandle(s.env, 'data');
  s.env.dir.push(hd);
  s.gesture(() => s.keyedEl('need:C:/data/run1/').click());
  await until(() => s.V().aliases.length === 1, 'alias set');
  const al = s.V().aliases[0];
  const root = s.V().roots.find((r) => r.id === al.rootId);
  deq({ literal: al.literal, ci: al.ci, root: root.name }, { literal: 'C:/data/', ci: true, root: 'data (3)' });
  deq(idb.store('aliases').map((x) => [x.literal, x.rootId, x.ci]), [['C:/data/', al.rootId, true]], 'the alias is stored');
  await until(() => !s.keyedEl('need:C:/data/run1/'), 'the need is covered');
  assert.ok(find(s.filesBody(), (n) => n.textContent === tr('dlg.mac.files.aliasRow', { literal: 'C:/data/', name: '/data (3)/' })).length, 'alias row');
  // the next run sends it; the mount id is the same for every run of this page
  const p2 = s.t.page.run('x');
  await until(() => s.t.lane, 'run 2');
  deq(s.t.startArgs().vfs.aliases.map((x) => [x.literal, x.rootId, x.ci]), [['C:/data/', al.rootId, true]]);
  assert.equal(s.t.startArgs().vfs.mountId, mount);
  s.t.finish(done());
  await p2;
  // removing the alias
  s.keyedEl('alias-rm:C:/data/').click();
  await until(() => !s.V().aliases.length && !(idb.store('aliases') || []).length, 'alias removed');
}

// ── the pre-run scan and the queue (§6.1, §6.2); vfs.pick from the queue, or by pausing the run (§6.3) ──
{
  const s = setup({ idb: makeIDB() });
  s.env.scan = (args) => ({ folders: /getDirectory/.test(args.source) ? [{ prompt: 'Choose a Directory', line: 1 }, { prompt: 'Output', line: 2 }] : [], files: [{ prompt: 'Pick', line: 3 }], machinePaths: [] });
  await openEditor(s);
  const st = s.editor().inst._state();
  st.ta.value = 'dir = getDirectory("Choose a Directory");\nout = getDirectory("Output");\nf = File.openDialog("Pick");';
  st.ta.dispatch('input');
  await until(() => find(s.filesBody(), (n) => n.textContent === tr('dlg.mac.files.queue', { folders: 2, files: 1 })).length, 'queue line', 2000);
  assert.equal(s.env.scanCalls.pop().source, st.ta.value, 'the scan reads the editor text');
  const q0 = s.keyedEl('q:directory:0'), q1 = s.keyedEl('q:directory:1');
  assert.equal(q0.textContent, tr('dlg.mac.files.queuePick', { prompt: 'Choose a Directory' }));
  assert.equal(q0.disabled, false); assert.equal(q1.disabled, true, 'one answer at a time, in order');
  s.env.dir.push(dirHandle(s.env, 'in'));
  s.gesture(() => s.keyedEl('q:directory:0').click());
  await until(() => s.V().queue.folders.length === 1, 'queued');
  assert.equal(s.keyedEl('q:directory:0').disabled, true);
  assert.equal(s.keyedEl('q:directory:1').disabled, false);
  assert.ok(find(s.filesBody(), (n) => n.textContent === tr('dlg.mac.files.queueReady', { n: 1 })).length);
  // a run takes the queued answer without any UI
  const p = s.t.page.run(st.ta.value);
  await until(() => s.t.lane, 'run');
  deq(s.t.startArgs().vfs.queue, { folders: 1, files: 0 });
  let r = await s.t.rpc('vfs.pick', { kind: 'directory', prompt: 'Choose a Directory', source: 'getDirectory' });
  assert.equal(r.ok, true);
  assert.equal(r.result.vpath, '/in/');
  assert.equal(r.result.grant.name, 'in');
  assert.ok(r.mirror, 'a reply carries the mirror');
  assert.ok(!s.t.log.calls.some((c) => c[0] === 'macro.pause'), 'no pause for a queued answer');
  // beyond the queue: the run pauses with the prompt, the editor reads "Waiting for you…"
  const pr = s.t.rpc('vfs.pick', { kind: 'directory', prompt: 'Output', source: 'getDirectory' });
  await until(() => s.strip() && !s.strip().hidden, 'pause strip');
  assert.equal(s.t.lane.paused, 1, 'the lane waits for the operator');
  assert.equal(s.editor().inst._state().status.textContent, tr('dlg.mac.paused'));
  assert.equal(byClass(s.strip(), 'ij-mac-pause-text')[0].textContent, 'Output', 'the prompt verbatim');
  assert.equal(byClass(s.strip(), 'ij-mac-pause-hint')[0].textContent, tr('dlg.mac.files.blockedHint'));
  const chooseBtn = s.btn(tr('dlg.mac.pause.choose'), s.strip());
  assert.ok(chooseBtn.focused > 0, 'the strip takes the keyboard focus');
  s.env.dir.push(dirHandle(s.env, 'out'));
  chooseBtn.click();
  await sleep(15);
  assert.equal(s.t.lane.paused, 1, 'without a gesture the picker is refused and the strip stays');
  s.gesture(() => s.btn(tr('dlg.mac.pause.choose'), s.strip()).click());
  r = await pr;
  assert.equal(r.result.vpath, '/out/');
  assert.equal(s.t.lane.paused, 0, 'resumed');
  assert.equal(s.strip().hidden, true);
  // Cancel = { cancelled: true } (the worker aborts the macro)
  const pr2 = s.t.rpc('vfs.pick', { kind: 'file', prompt: 'Pick', source: 'openDialog' });
  await until(() => !s.strip().hidden, 'strip 2');
  assert.equal(byClass(s.strip(), 'ij-mac-pause-hint').length, 0, 'the blocked-folder hint is for folders only');
  s.btn(tr('dlg.cancel'), s.strip()).click();
  deq((await pr2).result, { cancelled: true });
  // a file: the open picker, the Files root
  const pr3 = s.t.rpc('vfs.pick', { kind: 'file', prompt: 'Pick', source: 'openDialog' });
  await until(() => !s.strip().hidden, 'strip 3');
  s.env.open.push(fileHandle('a.tif'));
  s.gesture(() => s.btn(tr('dlg.mac.pause.choose'), s.strip()).click());
  r = await pr3;
  assert.equal(r.result.vpath, '/Files/a.tif');
  deq(r.result.grant.entries.map((e) => [e.name, e.writable]), [['a.tif', false]]);
  assert.equal(r.result.grant.kind, 'files');
  // save: the save picker with ImageJ's default name, a writable entry
  const pr4 = s.t.rpc('vfs.pick', { kind: 'save', prompt: 'Save String...', defaultName: 'log', ext: '.txt', source: 'saveString' });
  await until(() => !s.strip().hidden, 'strip 4');
  s.env.save.push(fileHandle('log.txt'));
  s.gesture(() => s.btn(tr('dlg.mac.pause.choose'), s.strip()).click());
  r = await pr4;
  deq(s.env.calls.filter((c) => c[0] === 'save').pop()[1], { suggestedName: 'log.txt' });
  assert.equal(r.result.vpath, '/Files/log.txt');
  deq(r.result.grant.entries.map((e) => [e.name, e.writable]), [['a.tif', false], ['log.txt', true]]);
  // write permission refused: the strip offers to read the folder only
  const pr5 = s.t.rpc('vfs.pick', { kind: 'directory', prompt: 'Where?', source: 'getDirectory' });
  await until(() => !s.strip().hidden, 'strip 5');
  s.env.dir.push('refuseWrite');
  s.gesture(() => s.btn(tr('dlg.mac.pause.choose'), s.strip()).click());
  await until(() => s.btn(tr('dlg.mac.files.chooseReadOnly'), s.strip()) && byClass(s.strip(), 'ij-mac-pause-hint')[0].textContent === tr('dlg.mac.files.writeRefused'), 'pickReadOnly');
  s.env.dir.push(dirHandle(s.env, 'readonly'));
  s.gesture(() => s.btn(tr('dlg.mac.files.chooseReadOnly'), s.strip()).click());
  r = await pr5;
  deq(s.env.calls.filter((c) => c[0] === 'dir').pop()[1], { mode: 'read' });
  deq({ vpath: r.result.vpath, target: r.result.grant.target, writeRefused: r.result.grant.writeRefused }, { vpath: '/readonly/', target: 'overlay', writeRefused: true });
  // an abort closes the strip; the request gets no reply
  const n = s.t.log.replies.length;
  s.t.emit('ext:macro.rpc', { runId: s.t.lane.runId, reqId: 900, method: 'vfs.pick', args: { kind: 'directory', prompt: 'Again', source: 'getDirectory' }, writes: [] });
  await until(() => !s.strip().hidden, 'strip 6');
  s.t.macro.abort();
  await until(() => s.strip().hidden, 'strip closed by the abort');
  s.t.finish(done({ ok: false, aborted: true }));
  await p;
  await sleep(10);
  assert.equal(s.t.log.replies.length, n, 'no reply once the run is gone');
  // Clear empties the answers
  s.env.dir.push(dirHandle(s.env, 'x'));
  s.gesture(() => s.keyedEl('q:directory:0').click());
  await until(() => s.V().queue.folders.length === 1, 'queued again');
  s.keyedEl('q-clear').click();
  assert.equal(s.V().queue.folders.length, 0);
}

// ── vfs.confirm, vfs.regrant (§6.4) ──
{
  const s = setup({ idb: makeIDB() });
  await openEditor(s);
  const h = dirHandle(s.env, 'data', { readwrite: 'prompt' });
  s.env.dir.push(h);
  s.gesture(() => s.btn(tr('dlg.mac.files.addFolder')).click());
  await until(() => s.V().roots.length === 1, 'root');
  const rid = s.V().roots[0].id;
  const p = s.t.page.run('x');
  await until(() => s.t.lane, 'run');
  for (const [action, choice, label] of [['overwrite', 'allow', 'dlg.mac.pause.allowRun'], ['delete', 'refuse', 'dlg.mac.pause.refuse'], ['rename', 'abort', 'dlg.mac.pause.abort']]) {
    const pr = s.t.rpc('vfs.confirm', { rootId: rid, root: 'data', action, path: '/data/out/a.tif', to: '/data/out/b.tif' });
    await until(() => !s.strip().hidden, 'confirm strip');
    const key = { overwrite: 'dlg.mac.pause.confirmOverwrite', delete: 'dlg.mac.pause.confirmDelete', rename: 'dlg.mac.pause.confirmRename' }[action];
    assert.equal(byClass(s.strip(), 'ij-mac-pause-text')[0].textContent, tr(key, { path: '/data/out/a.tif', to: '/data/out/b.tif' }));
    deq(byClass(s.strip(), 'ij-btn').map((b) => b.textContent), [tr('dlg.mac.pause.allowRun'), tr('dlg.mac.pause.refuse'), tr('dlg.mac.pause.abort')]);
    s.btn(tr(label), s.strip()).click();
    deq((await pr).result, { choice });
  }
  const prm = s.t.rpc('vfs.confirm', { rootId: rid, root: 'data', action: 'mkdir', path: '/data/out/' });
  await until(() => !s.strip().hidden, 'mkdir strip');
  assert.equal(byClass(s.strip(), 'ij-mac-pause-text')[0].textContent, tr('dlg.mac.pause.confirmMkdir', { path: '/data/out/' }));
  s.btn(tr('dlg.mac.pause.allowRun'), s.strip()).click();
  deq((await prm).result, { choice: 'allow' });
  // regrant: Allow asks the browser inside the click
  const pg = s.t.rpc('vfs.regrant', { rootId: rid, root: 'data', mode: 'readwrite' });
  await until(() => !s.strip().hidden, 'regrant strip');
  assert.equal(byClass(s.strip(), 'ij-mac-pause-text')[0].textContent, tr('dlg.mac.pause.regrant', { name: 'data' }));
  s.btn(tr('dlg.mac.pause.allow'), s.strip()).click();
  await sleep(10);
  assert.equal(s.strip().hidden, false, 'no gesture, no request: the strip stays');
  s.gesture(() => s.btn(tr('dlg.mac.pause.allow'), s.strip()).click());
  let r = await pg;
  assert.equal(r.result.ok, true);
  assert.equal(r.result.grant.id, rid);
  deq(h.requests, ['readwrite']);
  const pg2 = s.t.rpc('vfs.regrant', { rootId: rid, root: 'data', mode: 'read' });
  await until(() => !s.strip().hidden, 'regrant strip 2');
  s.btn(tr('dlg.cancel'), s.strip()).click();
  deq((await pg2).result, { ok: false });
  deq((await s.t.rpc('vfs.regrant', { rootId: 'ffffffffffffffff', root: 'gone', mode: 'read' })).result, { ok: false }, 'an unknown root: no question');
  // an abort while a question is open answers nothing
  s.t.emit('ext:macro.rpc', { runId: s.t.lane.runId, reqId: 901, method: 'vfs.confirm', args: { rootId: rid, root: 'data', action: 'delete', path: '/data/x' }, writes: [] });
  await until(() => !s.strip().hidden, 'confirm before abort');
  const before = s.t.log.replies.length;
  s.t.finish(done({ ok: false, aborted: true }));
  await p;
  await sleep(10);
  assert.equal(s.strip().hidden, true);
  assert.equal(s.t.log.replies.length, before);
}

// ── Dialog.addDirectory / addFile fields (§6.6): queued answers prefill, Browse… picks inside its click, grants in the reply ──
{
  const specs = [];
  let answer = null;
  const s = setup({ idb: makeIDB(), page: { dialog: (spec) => { specs.push(spec); return answer ? answer(spec) : {}; } } });
  await openEditor(s);
  s.env.scan = () => ({ folders: [{ prompt: 'Input', line: 1 }], files: [], machinePaths: [] });
  const st = s.editor().inst._state();
  st.ta.value = 'Dialog.create("D"); Dialog.addDirectory("Input", "");';
  st.ta.dispatch('input');
  const q = await until(() => s.keyedEl('q:directory:0'), 'queue', 2000);
  s.env.dir.push(dirHandle(s.env, 'in'));
  s.gesture(() => q.click());
  await until(() => s.V().queue.folders.length === 1, 'queued');
  const p = s.t.page.run(st.ta.value);
  await until(() => s.t.lane, 'run');
  let browsed = null;
  answer = async (spec) => {
    const d = spec.fields.find((f) => f.id === 'd'), f = spec.fields.find((x) => x.id === 'f'), g = spec.fields.find((x) => x.id === 'g');
    deq({ type: d.type, value: d.value, pathKind: d.pathKind, label: d.label }, { type: 'path', value: '/in/', pathKind: 'directory', label: 'Input' });
    assert.equal(g.value, '/keep/', 'a default path is kept');
    assert.equal(typeof f.browse, 'function');
    s.env.open.push(fileHandle('x.tif'));
    browsed = await s.gesture(() => f.browse());
    // a cancelled Browse leaves the field alone
    s.env.open.push('abort');
    assert.equal(await s.gesture(() => f.browse()), null);
    return { d: d.value, f: browsed, g: g.value };
  };
  const r = await s.t.rpc('dialog.show', { title: 'D', fields: [{ id: 'd', type: 'path', label: 'Input', value: '', pathKind: 'directory' },
    { id: 'f', type: 'path', label: 'File', value: '', pathKind: 'file' }, { id: 'g', type: 'path', label: 'Out', value: '/keep/', pathKind: 'directory' }] });
  assert.equal(browsed, '/Files/x.tif');
  deq(r.result.values, { d: '/in/', f: '/Files/x.tif', g: '/keep/' });
  deq(r.result.grants.map((g) => g.name).sort(), ['Files', 'in'], 'the grants of the queued answer and of Browse…');
  assert.equal(s.V().queue.folders.length, 0, 'the queued answer was used');
  // a dialog without path fields replies as before
  answer = () => ({ a: true });
  deq((await s.t.rpc('dialog.show', { title: 'E', fields: [{ id: 'a', type: 'check', label: 'x', value: false }] })).result, { values: { a: true } });
  s.t.finish(done());
  await p;
  // the pure mapping without the page's builder
  const pf = s.t.page._internals.viewFields([{ id: 'p', type: 'path', label: 'L', value: null, pathKind: 'file' }]);
  deq(pf, [{ type: 'path', id: 'p', label: 'L', value: '', pathKind: 'file' }]);
}

// ── Firefox / Safari: webkitdirectory, a dropped folder, the copy note; stale after a reload, chosen again; save to /Downloads/ ──
{
  const idbF = makeIDB();
  let snapId = null;
  {
    const s = setup({ idb: idbF, fsa: false });
    await openEditor(s);
    assert.ok(find(s.filesBody(), (n) => n.textContent === tr('dlg.mac.files.browserNote')).length, 'the copy note');
    assert.equal(s.btn(tr('dlg.mac.files.chooseReadOnly')), undefined, 'no read-only choice where every folder is read as a copy');
    s.env.inputs.length = 0;
    s.gesture(() => s.btn(tr('dlg.mac.files.addFolder')).click());
    const input = s.env.inputs[s.env.inputs.length - 1];
    assert.ok(input && input.webkitdirectory === true && input.type === 'file', '<input type=file webkitdirectory>');
    assert.equal(input.clickedWithActivation, true, 'the input is clicked inside the gesture');
    input.files = [relFile('imgs', 'a.tif', 'A'), relFile('imgs', 'sub/b.txt', 'B')];
    input.dispatch('change');
    await until(() => s.V().roots.length === 1, 'snapshot root');
    const r = s.V().roots[0];
    snapId = r.id;
    deq({ name: r.name, kind: r.kind, target: r.target, rels: r.snapshot.rels, dirs: r.snapshot.dirs }, { name: 'imgs', kind: 'snapshot', target: 'overlay', rels: ['a.tif', 'sub/b.txt'], dirs: ['sub/'] });
    const g = s.F().grantOf(r);
    deq({ kind: g.kind, target: g.target, rels: g.snapshot.rels, n: g.snapshot.files.length }, { kind: 'snapshot', target: 'overlay', rels: ['a.tif', 'sub/b.txt'], n: 2 });
    assert.ok(find(s.filesBody(), (n) => n.textContent === tr('dlg.mac.files.targetOverlay')).length, 'writes go to the browser workspace');
    // a folder dropped on the zone, walked through webkitGetAsEntry
    const zone = byClass(s.filesBody(), 'ij-mac-files-drop')[0];
    assert.equal(zone.textContent, tr('dlg.mac.files.drop'));
    const ev = zone.dispatch('dragover', { dataTransfer: {} });
    assert.ok(ev.defaultPrevented);
    assert.ok(String(zone.className).includes('ij-mac-files-drop-over'));
    const entry = entryTree('dropped', { 'c.txt': 'C', 'd/e.txt': 'E' });
    zone.dispatch('drop', { dataTransfer: { items: [{ kind: 'file', webkitGetAsEntry: () => entry }, { kind: 'string' }] } });
    await until(() => s.V().roots.length === 2, 'dropped root');
    const d = s.V().roots[1];
    deq({ name: d.name, kind: d.kind, rels: d.snapshot.rels.slice().sort(), dirs: d.snapshot.dirs }, { name: 'dropped', kind: 'snapshot', rels: ['c.txt', 'd/e.txt'], dirs: ['d/'] });
    // a loose file dropped: the Files root
    zone.dispatch('drop', { dataTransfer: { items: [{ kind: 'file', webkitGetAsEntry: () => null, getAsFile: () => new File(['z'], 'z.csv') }] } });
    await until(() => s.V().roots.length === 3, 'Files root');
    deq({ name: s.V().roots[2].name, kind: s.V().roots[2].kind, rels: s.V().roots[2].snapshot.rels }, { name: 'Files', kind: 'files', rels: ['z.csv'] });
    // the records hold no File (the folder is not copied into the browser)
    for (const x of idbF.store('roots')) { assert.equal(x.snapshot, undefined); assert.equal(x.handle, undefined); assert.equal(x.entries, undefined); }
    // save without a save picker: a name field, the file goes to /Downloads/
    const p = s.t.page.run('x');
    await until(() => s.t.lane, 'run');
    const pr = s.t.rpc('vfs.pick', { kind: 'save', prompt: 'Save String...', defaultName: 'Untitled', ext: '.txt', source: 'saveString' });
    await until(() => !s.strip().hidden, 'save strip');
    const field = byClass(s.strip(), 'ij-mac-pause-input')[0];
    assert.equal(field.value, 'Untitled.txt');
    assert.ok(field.focused > 0, 'the name field has the focus');
    field.value = 'notes/1.txt';
    s.btn(tr('dlg.mac.pause.save'), s.strip()).click();
    const r1 = await pr;
    deq({ vpath: r1.result.vpath, grant: r1.result.grant.id }, { vpath: '/Downloads/notes_1.txt', grant: 'downloads' });
    // a file without an open picker: <input type=file>
    const pr2 = s.t.rpc('vfs.pick', { kind: 'file', prompt: 'Open', source: 'open' });
    await until(() => !s.strip().hidden, 'file strip');
    s.env.inputs.length = 0;
    s.gesture(() => s.btn(tr('dlg.mac.pause.choose'), s.strip()).click());
    const fin = s.env.inputs[0];
    assert.equal(fin.webkitdirectory, undefined);
    assert.equal(fin.clickedWithActivation, true);
    fin.files = [new File(['q'], 'q.tif')];
    fin.dispatch('change');
    const r2 = await pr2;
    assert.equal(r2.result.vpath, '/Files/q.tif');
    deq(r2.result.grant.snapshot.rels, ['z.csv', 'q.tif']);
    // a folder picker cancelled (no 'change'): the strip stays usable, Cancel answers
    const pr3 = s.t.rpc('vfs.pick', { kind: 'directory', prompt: 'Dir', source: 'getDirectory' });
    await until(() => !s.strip().hidden, 'dir strip');
    s.gesture(() => s.btn(tr('dlg.mac.pause.choose'), s.strip()).click());
    s.env.inputs[s.env.inputs.length - 1].dispatch('cancel');
    await sleep(5);
    assert.equal(s.strip().hidden, false);
    s.btn(tr('dlg.cancel'), s.strip()).click();
    deq((await pr3).result, { cancelled: true });
    s.t.finish(done());
    await p;
  }
  {
    // reload: snapshot roots come back stale with their id, name and mode; "Choose again…" refills the same root
    const s = setup({ idb: idbF, fsa: false });
    await openEditor(s);
    const r = s.V().roots.find((x) => x.id === snapId);
    assert.ok(r, 'same id after a reload');
    assert.equal(r.snapshot, null, 'stale');
    assert.equal(s.F().grantOf(r).snapshot, null, 'a stale root is sent with snapshot null');
    assert.ok(find(s.filesBody(), (n) => n.textContent === tr('dlg.mac.files.stateStale')).length);
    s.env.inputs.length = 0;
    s.gesture(() => s.keyedEl('rechoose:' + snapId).click());
    const input = s.env.inputs[0];
    assert.equal(input.webkitdirectory, true);
    input.files = [relFile('imgs', 'a.tif', 'A2'), relFile('imgs', 'new.txt', 'N')];
    input.dispatch('change');
    await until(() => r.snapshot && r.snapshot.rels.length === 2, 'refilled');
    deq(r.snapshot.rels, ['a.tif', 'new.txt']);
    // Add folder of a folder with the name AND the files of a stale root takes that root back (workspace and aliases kept);
    // another folder of the same name is a root of its own (its files are not the base the workspace was made over)
    const stale = s.V().roots.find((x) => x.name === 'dropped');
    s.gesture(() => s.btn(tr('dlg.mac.files.addFolder')).click());
    let in2 = s.env.inputs[s.env.inputs.length - 1];
    in2.files = [relFile('dropped', 'c.txt', 'C')];
    in2.dispatch('change');
    await until(() => s.V().roots.length === 4, 'another folder of that name');
    assert.equal(stale.snapshot, null, 'the stale root is not given another folder');
    assert.equal(s.V().roots[3].name, 'dropped (2)');
    s.gesture(() => s.btn(tr('dlg.mac.files.addFolder')).click());
    in2 = s.env.inputs[s.env.inputs.length - 1];
    in2.files = [relFile('dropped', 'd/e.txt', 'E2'), relFile('dropped', 'c.txt', 'C2')];
    in2.dispatch('change');
    await until(() => stale.snapshot, 'stale root reused');
    assert.equal(s.V().roots.length, 4, 'the same folder takes its root back');
  }
}

// ── Download results (§11.1): links for ≤ 3 files, one ZIP otherwise; Discard after a download; persist() once (§5.3) ──
{
  const s = setup({ idb: makeIDB(), fsa: false });
  await openEditor(s);
  s.gesture(() => s.btn(tr('dlg.mac.files.addFolder')).click());
  const input = s.env.inputs[s.env.inputs.length - 1];
  input.files = [relFile('imgs', 'a.tif', 'A')];
  input.dispatch('change');
  await until(() => s.V().roots.length === 1, 'root');
  const rid = s.V().roots[0].id;
  const blobs = { a: new Blob(['A']), b: new Blob(['B']), zip: new Blob(['PK']) };
  let changes = { files: [{ rel: 'out/a.txt', size: 1, mtime: 1, kind: 'new' }, { rel: 'out/b.txt', size: 1, mtime: 1, kind: 'new' }], deleted: [], renamed: [] };
  let delivery = { kind: 'files', files: [{ name: 'a.txt', file: blobs.a }, { name: 'b.txt', file: blobs.b }] };
  s.env.vfs = (args) => {
    if (args.op === 'changes') return Object.assign({ rootId: args.rootId, dirs: [], bytes: 2 }, args.rootId === rid ? changes : { files: [], deleted: [], renamed: [] });
    if (args.op === 'deliver') return delivery;
    if (args.op === 'discard') return {};
    return {};
  };
  const p = s.t.page.run('x');
  await until(() => s.t.lane, 'run');
  // the worker's events: the first write asks the browser to keep the storage, once
  s.t.emit('ext:macro.vfs', { event: 'macro.vfs', runId: s.t.lane.runId, type: 'firstOverlayWrite', rootId: rid });
  s.t.emit('ext:macro.vfs', { event: 'macro.vfs', runId: s.t.lane.runId, type: 'firstOverlayWrite', rootId: 'downloads' });
  s.t.emit('ext:macro.vfs', { event: 'macro.vfs', runId: 'other', type: 'changed', rootId: rid });
  s.t.emit('ext:macro.vfs', { event: 'macro.vfs', runId: s.t.lane.runId, type: 'changed', rootId: rid });
  await sleep(10);
  assert.equal(s.env.persist, 1, 'persist() once per page session');
  assert.ok(s.V().dirty.has(rid));
  s.t.finish(done({ vfs: { needs: [], changedRoots: [rid] } }));
  await p;
  const dlBtn = await until(() => s.keyedEl('deliver:' + rid), 'Download results');
  assert.equal(dlBtn.textContent, tr('dlg.mac.files.download'));
  assert.ok(find(s.filesBody(), (n) => n.textContent === tr('dlg.mac.files.changes', { n: 2 })).length, '2 changed files');
  const ch = s.env.vfsCalls.filter((c) => c[0] === 'changes' && c[1].rootId === rid).pop()[1];
  assert.equal(ch.mountId, s.V().mountId);
  for (const k of ['dlg.mac.files.readme', 'dlg.mac.files.readmeManual', 'dlg.mac.files.readmeDelete', 'dlg.mac.files.readmeRename']) assert.equal(ch.texts[k], tr(k), 'README text ' + k);
  assert.ok(ch.roots.some((g) => g.id === rid) && ch.roots.some((g) => g.id === 'downloads'));
  dlBtn.click();
  await until(() => s.keyedEl('link:' + rid + ':1'), 'two links');
  const del = s.env.vfsCalls.filter((c) => c[0] === 'deliver').pop();
  deq(del[2], { labelKey: 'op.macZip' }, 'the progress step of the archive');
  const l0 = s.keyedEl('link:' + rid + ':0');
  assert.equal(l0.textContent, tr('dlg.mac.files.downloadLink', { name: 'a.txt' }));
  const anchors = [];
  const create = s.ctx.document.createElement;
  s.ctx.document.createElement = (tag) => { const n = create(tag); if (tag === 'a') anchors.push(n); return n; };
  l0.click();
  assert.equal(s.env.urls[0], blobs.a, 'one object URL per click');
  assert.equal(anchors.length, 1);
  assert.equal(anchors[0].download, 'a.txt');
  assert.equal(anchors[0].parentNode, null, 'the link is gone after its click');
  s.keyedEl('link:' + rid + ':1').click();
  assert.equal(s.env.urls[1], blobs.b);
  // a ZIP: one link
  changes = { files: changes.files.concat([{ rel: 'c', size: 1, mtime: 1, kind: 'new' }]), deleted: ['old.txt'], renamed: [] };
  delivery = { kind: 'zip', name: 'imgs-results.zip', file: blobs.zip, entries: 4, bytes: 99, zip64: false };
  s.V().changes.delete(rid);
  await s.F().refreshChanges(s.t.api, [rid]);
  await until(() => find(s.filesBody(), (n) => n.textContent === tr('dlg.mac.files.changes', { n: 4 })).length, '4 changes');
  s.keyedEl('deliver:' + rid).click();
  await until(() => s.keyedEl('link:' + rid + ':0') && s.keyedEl('link:' + rid + ':0').textContent === tr('dlg.mac.files.downloadLink', { name: 'imgs-results.zip' }), 'zip link');
  assert.equal(s.keyedEl('link:' + rid + ':1'), undefined);
  // Discard (after a download): confirmed, then macro.vfs discard
  const disc = s.keyedEl('discard:' + rid);
  assert.equal(disc.textContent, tr('dlg.mac.files.discard'));
  disc.click();
  await until(() => s.env.vfsCalls.some((c) => c[0] === 'discard'), 'discard sent');
  const dlg = s.t.log.dialogs.pop();
  assert.equal(dlg.fields.map((f) => f.label).join('\n'), tr('dlg.mac.files.discardConfirm', { n: 4, name: '/imgs/' }));
  await until(() => !s.keyedEl('deliver:' + rid), 'changes gone');
  // the buttons are off while a macro runs
  changes = { files: [{ rel: 'z', size: 1, mtime: 1, kind: 'new' }], deleted: [], renamed: [] };
  await s.F().refreshChanges(s.t.api, [rid]);
  const p2 = s.t.page.run('y');
  await until(() => s.t.lane, 'run 2');
  await until(() => s.keyedEl('deliver:' + rid) && s.keyedEl('deliver:' + rid).disabled, 'disabled while running');
  assert.equal(s.keyedEl('remove:' + rid).disabled, true);
  s.t.finish(done());
  await p2;
}

// ── text.open (F20) and window.text ──
{
  const s = setup({ idb: makeIDB() });
  s.ctx.IJTextIo = { tableText: (table, o) => table.headings.join(o.sep) + '\n' + table.columns.v.join('\n') + '\n' };
  const p = s.t.page.run('x');
  await until(() => s.t.lane, 'run');
  deq((await s.t.rpc('text.open', { title: 'notes.txt', text: 'line 1\nline 2' })).result, {});
  await until(() => s.t.panel('macroText'), 'text window');
  await sleep(150);
  const tw = s.t.panel('macroText').inst._state();
  deq(tw.tabs.children.map((b) => b.textContent), ['notes.txt']);
  assert.equal(tw.pre.textContent, 'line 1\nline 2');
  assert.equal(s.t.panel('macroEditor'), null, 'never the Macro Editor');
  // opened again: replaced, not appended
  await s.t.rpc('text.open', { title: 'notes.txt', text: 'new' });
  await sleep(150);
  assert.equal(s.t.panel('macroText').inst._state().pre.textContent, 'new');
  deq((await s.t.rpc('window.text', { title: 'notes.txt' })).result, { found: true, text: 'new\n' });
  await s.t.rpc('window.print', { title: 'Report', text: 'a' });
  await s.t.rpc('window.print', { title: 'Report', text: 'b' });
  deq((await s.t.rpc('window.text', { title: 'Report' })).result, { found: true, text: 'a\nb\n' });
  deq((await s.t.rpc('window.text', { title: 'Nope' })).result, { found: false, text: '' });
  s.t.tables.set('T', { name: 'T', size: 2, headings: ['v'], columns: { v: [1, 2] }, labels: null, rev: 1 });
  deq((await s.t.rpc('window.text', { title: 'T' })).result, { found: true, text: 'v\n1\n2\n' });
  s.t.emit('ext:macro.log', { runId: s.t.lane.runId, lines: ['l1', 'l2'] });
  deq((await s.t.rpc('window.text', { title: 'Log' })).result, { found: true, text: 'l1\nl2\n' });
  s.t.finish(done());
  await p;
}

// ── the editor's Open / Save (§11.1, PLAN §11.1 via pickFile / saveFile, inside the click) ──
{
  const s = setup({ idb: makeIDB(), pickFile: () => [{ name: 'batch.ijm', text: async () => 'print("from file");\n' }] });
  await openEditor(s);
  const st = s.editor().inst._state();
  assert.equal(st.openBtn.textContent, tr('dlg.mac.open'));
  assert.equal(st.saveBtn.textContent, tr('dlg.mac.save'));
  s.gesture(() => st.openBtn.click());
  deq(s.env.picked.map((x) => [x.opt.accept, x.activation]), [['.ijm,.txt', true]], 'pickFile inside the click');
  await until(() => st.ta.value === 'print("from file");\n', 'text loaded');
  await until(() => s.t.settings.get('mac.editorText') === 'print("from file");\n', 'kept');
  s.gesture(() => st.saveBtn.click());
  await until(() => s.env.saved.length === 1, 'saved');
  const sv = s.env.saved[0];
  deq({ name: sv.name, mime: sv.mime, ext: sv.ext, descKey: sv.descKey, activation: sv.activation }, { name: 'batch.ijm', mime: 'text/plain', ext: '.ijm', descKey: 'dlg.mac.ijmFiles', activation: true });
  assert.equal(await sv.blob.text(), 'print("from file");\n');
}

// ── without IndexedDB the grants live in memory for the page session ──
{
  const s = setup({ idb: null });
  await openEditor(s);
  s.env.dir.push(dirHandle(s.env, 'mem'));
  s.gesture(() => s.btn(tr('dlg.mac.files.addFolder')).click());
  await until(() => s.V().roots.length === 1, 'memory root');
  const p = s.t.page.run('x');
  await until(() => s.t.lane, 'run');
  deq(s.t.startArgs().vfs.roots.map((g) => g.name), ['mem', 'Downloads']);
  s.t.finish(done());
  await p;
}

// ── the shared fakes of the VFS builder (tests/js/ij_macro_fs_fakes.mjs): a disk handle granted, stored, read back after a reload ──
{
  let fx = null;
  try { fx = await import('./ij_macro_fs_fakes.mjs'); } catch (_) { fx = null; }
  if (!fx || typeof fx.makeFakeIndexedDB !== 'function' || typeof fx.makePickers !== 'function' || typeof fx.makeFakeDisk !== 'function') {
    console.log('SKIP shared fs fakes: tests/js/ij_macro_fs_fakes.mjs is absent or incomplete');
  } else {
    const sidb = fx.makeFakeIndexedDB();
    const disk = fx.makeFakeDisk({ 'a.tif': 'x', 'sub/': {} }, { name: 'shared' });
    const s = setup({ idb: sidb, fsa: false });
    fx.makePickers({ directory: [disk.dir()] }).install(s.ctx);
    await openEditor(s);
    s.btn(tr('dlg.mac.files.addFolder')).click();
    await sleep(10);
    assert.equal(s.V().roots.length, 0, 'the shared pickers refuse a click without activation too');
    s.ctx.__activation = true;
    try { s.btn(tr('dlg.mac.files.addFolder')).click(); } finally { s.ctx.__activation = false; }
    await until(() => s.V().roots.length === 1, 'granted with the shared fakes');
    const id = s.V().roots[0].id;
    assert.equal(s.V().perm.get(id), 'granted');
    await sleep(20);
    const s2 = setup({ idb: sidb, fsa: false });
    fx.makePickers({}).install(s2.ctx);
    await openEditor(s2);
    deq(s2.V().roots.map((r) => [r.id, r.kind, r.target]), [[id, 'fsa', 'inplace']], 'read back from the shared IndexedDB fake');
    assert.equal(typeof s2.V().roots[0].handle.getFileHandle, 'function', 'the stored handle is the disk handle');
  }
}

// ── the source rules for this file: no picker or network API outside the rules ──
{
  const src = fs.readFileSync(path.join(DIR, 'ij-cmds-macro.js'), 'utf8');
  for (const bad of ['fetch', 'XMLHttpRequest', 'sendBeacon', 'WebSocket', 'EventSource', 'importScripts', 'new Worker', 'window.open', 'E.fetch']) assert.ok(!src.includes(bad), 'ij-cmds-macro.js must not contain ' + bad);
  assert.ok(!/\blocation\b/.test(src), 'no location');
  assert.ok(!/lumen3d-ij'/.test(src), 'the engine database is never opened here');
}

console.log('test_ij_macro_files_page: ok');
