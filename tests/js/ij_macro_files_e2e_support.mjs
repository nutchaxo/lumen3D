// Shared support of the macro FILE end-to-end tests (not a test: no `test_` prefix).
//
// fileBoot(o) boots the whole Advanced Studio under Node (tests/js/ij_harness.mjs boot({ fs })): the real page controller (ij-app.js +
// ij-cmds-*.js, the Macro Editor of ij-cmds-macro.js), the real worker (engine, packages, ij-macro-lang.js, ij-macro-vfs.js,
// ij-proc-macro.js) and the file system fakes of ij_macro_fs_fakes.mjs (a user folder handle, OPFS, IndexedDB, the pickers). Folders are
// granted the way a user does it: the Files section's buttons clicked inside a gesture, the picker answering with a fake folder.
//
//   const t = await fileBoot();                          // Chromium (File System Access); fileBoot({ fsa: false }) = Firefox / Safari
//   const disk = makeFakeDisk({ 'a.tif': bytes }, { name: 'Data' });
//   const root = await t.grantFolder(disk, { mode: 'allow' });   // → the page's root record (name 'Data')
//   const r = await t.runMacro('print(File.exists("/Data/a.tif"));');
//   t.net → the network calls the spies caught (none expected)
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { boot, until, sleep } from './ij_harness.mjs';
import * as fx from './ij_macro_fs_fakes.mjs';

export { fx };
export const sha = (u8) => createHash('sha256').update(u8).digest('hex');

function* walk(e) {
  if (!e) return;
  yield e;
  for (const k of e.children || []) yield* walk(k);
}
const fire = (e, type, extra) => {
  for (const f of ((e.listeners && e.listeners[type]) || []).slice()) f(Object.assign({ target: e, currentTarget: e, type, preventDefault() {}, stopPropagation() {} }, extra || {}));
};

/** The pixel digest of FILES.md §15.3: "w,h,c,z,t,bitDepth\n" then every plane in ImageJ stack order (c fastest, then z, then t). */
export function pixelDigest(w, h, nC, nZ, nT, bitDepth, planeOf) {
  const hsh = createHash('sha256');
  hsh.update(w + ',' + h + ',' + nC + ',' + nZ + ',' + nT + ',' + bitDepth + '\n');
  for (let t = 0; t < nT; t++) for (let z = 0; z < nZ; z++) for (let c = 0; c < nC; c++) {
    const p = planeOf(c, z, t);
    if (bitDepth === 24) {
      const out = new Uint8Array(w * h * 3);
      for (let i = 0; i < w * h; i++) { out[i * 3] = p[0][i]; out[i * 3 + 1] = p[1][i]; out[i * 3 + 2] = p[2][i]; }
      hsh.update(out);
    } else hsh.update(new Uint8Array(p.buffer, p.byteOffset, p.byteLength));
  }
  return hsh.digest('hex');
}

export async function fileBoot(o = {}) {
  const opfs = fx.makeFakeOpfs(o.opfs || {});
  const idb = fx.makeFakeIndexedDB();
  const fsa = o.fsa !== false;
  const pickers = fsa ? fx.makePickers() : null;
  const t = await boot(Object.assign({ channels: 1, immediateMessages: true, fs: { opfs, idb, pickers } }, o.boot || {}));
  await t.open();
  if (t.failedPackages().has('macro')) throw new Error('package macro did not load');
  // no network: every network API of both realms is a spy that records and throws
  const net = [];
  const spy = (g, where) => {
    for (const k of ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'importScripts']) {
      const prev = g[k];
      g[k] = function (...a) {
        // the worker's own package loader runs importScripts before any macro: only calls made while a macro runs count
        if (k === 'importScripts' && !t.macroRunning) return prev.apply(this, a);
        net.push(where + ':' + k);
        throw new Error(k + ' is forbidden');
      };
    }
    if (g.navigator) g.navigator.sendBeacon = () => { net.push(where + ':sendBeacon'); return false; };
  };
  for (const w of t.workers) spy(w.far, 'worker');
  spy(t.page, 'page');
  const P = vm.runInContext('IJMacroPage', t.page);
  const F = P._internals.files;
  await F.ensureLoaded();
  t.openPanel('macroEditor');
  await until(() => t.panel('macroEditor'), 'the Macro Editor panel');

  const editorRoot = () => t.panel('macroEditor');
  const all = () => Array.from(walk(editorRoot()));
  const findButton = (text) => all().find((e) => e.tagName === 'BUTTON' && !e.disabled && (typeof text === 'function' ? text(e.textContent) : e.textContent === text)) || null;
  const tr = (k, p) => t.ctx.i18n.t(k, p);
  const runMacroRaw = t.runMacro;
  Object.assign(t, {
    opfs, idb, pickers, net, P, F, tr, findButton,
    state: () => F.state(),
    /** Every element of the editor whose text is `text` (buttons, notes, rows). */
    texts: () => all().map((e) => e.textContent).filter((s) => typeof s === 'string' && s !== ''),
    /** Clicks the editor button labelled `text` (a function = a test on the label); `gesture` = with user activation. */
    async click(text, { gesture = true, wait = 4000 } = {}) {
      const b = await until(() => findButton(text), 'the button ' + (typeof text === 'function' ? '(test)' : JSON.stringify(text)), wait);
      if (gesture) t.gesture(() => fire(b, 'click')); else fire(b, 'click');
      return b;
    },
    /** Grants a fake folder through "Add folder..." (Chromium: the directory picker answers with the disk; else <input webkitdirectory>). */
    async grantFolder(disk, { mode = 'ask', readOnly = false } = {}) {
      const before = new Set(F.state().roots.map((r) => r.id));
      if (fsa) pickers.push('directory', disk.dir());
      else t.pickFile(fx.makeSnapshot(disk._folderName, disk._tree).files);
      await t.click(readOnly ? tr('dlg.mac.files.chooseReadOnly') : tr('dlg.mac.files.addFolder'));
      const r = await until(() => F.state().roots.find((x) => !before.has(x.id)) || null, 'the new root');
      if (r.mode !== mode) await t.setMode(r, mode);
      return r;
    },
    /** The root's mode select (Read-only / Ask / Allow), changed as the user does it. */
    async setMode(r, mode) {
      const sel = await until(() => all().find((e) => e.tagName === 'SELECT' && Array.from(walk(e)).some((x) => x.tagName === 'OPTION' && x.value === 'readonly')
        && e.parentNode && e.parentNode.parentNode && Array.from(walk(e.parentNode.parentNode.parentNode)).some((x) => x.textContent === '/' + r.name + '/')), 'the mode select of ' + r.name);
      sel.value = mode;
      fire(sel, 'change');
      await until(() => r.mode === mode, 'mode ' + mode);
      await sleep(0);
    },
    /** The pause strip's state while a run waits for the user (null when none). */
    pause: () => F.state().pause,
    async waitPause(state, ms = 8000) { return until(() => { const p = F.state().pause; return p && (!state || p.state === state) ? p : null; }, 'a pause strip' + (state ? ' (' + state + ')' : ''), ms); },
    /** A run through the page; while it runs, importScripts counts as network. */
    async runMacro(source, mo) {
      t.macroRunning = true;
      try { return await runMacroRaw(source, mo); } finally { t.macroRunning = false; }
    },
    /** A fresh mount (the Studio opened again): new /tmp/, new dialog statics (FILES.md F13, F14). */
    newMount() { F.state().mountId = Array.from({ length: 16 }, () => Math.floor(Math.random() * 16).toString(16)).join(''); },
    /** The images the page shows (+ hidden batch images), in opening order, with the engine's planes. */
    async openImages() {
      const m = await t.api('macro').macro.mirror();
      const out = [];
      for (const im of m.images || []) {
        const d = t.worker.engine.inspectDoc(im.docId);
        if (!d) continue;
        const info = await t.engine('doc.info', { docId: im.docId });
        const inf = info.info || info;
        const rgb = !!inf.rgb;
        const bd = rgb ? 24 : inf.bitDepthIJ || inf.bitDepth;
        const nC = rgb ? 1 : d.channels.length;
        out.push({
          docId: im.docId, title: im.title, file: inf.file || null,
          pixels: { w: inf.width, h: inf.height, c: nC, z: d.nZ, t: d.nT, bitDepth: bd,
            sha256: pixelDigest(inf.width, inf.height, nC, d.nZ, d.nT, bd, (c, z, tt) => (rgb ? d.channels.map((ch) => ch.planes[tt * d.nZ + z]) : d.channels[c].planes[tt * d.nZ + z])) }
        });
      }
      return out;
    }
  });
  return t;
}

/** A fake folder that also remembers its tree (what a webkitdirectory input of the same folder would list). */
export function folder(name, tree, opts = {}) {
  const disk = fx.makeFakeDisk(tree, Object.assign({ name }, opts));
  disk._folderName = name;
  disk._tree = tree;
  return disk;
}

/** The message boxes the page showed since index `from` of t.log.dialogSpecs: { title, text } (ImageJ's showMessage / IJ.error). */
export function messageBoxes(t, from = 0) {
  return t.log.dialogSpecs.slice(from)
    .filter((s) => Array.isArray(s.fields) && s.fields.length && s.fields.every((f) => f.type === 'message' && /^m:\d+$/.test(f.id)))
    .map((s) => ({ title: s.title, text: s.fields.map((f) => (f.label === '\u00a0' ? '' : f.label)).join('\n') }));
}
