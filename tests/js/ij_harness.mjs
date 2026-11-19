// Shared harness of the Advanced Studio tests (not a test: no `test_` prefix).
//
// boot(opts) builds, under Node and without a browser:
//   - a PAGE context: ij-core / ij-analysis / ij-proc-shared / every ij-proc-<pkg>.js, then ij-app.js and
//     every ij-cmds-<pkg>.js, in plugin.json's order, behind a stand-in for the chrome of ij-view.js;
//   - a WORKER context: the REAL ij-worker.js, importScripts reading WORKER_SCRIPTS from ij-app.js (the
//     mandatory four, then each package in its own try/catch), and the REAL engine on a shared memory
//     storage (so `reload()` can restore what the first boot stored);
//   - a synthetic volume behind `ctx.studio.source`.
//
// The shell stand-in validates every dialog spec with the REAL IJViewPure field schema (an unknown field
// type, a missing label, a choice without options fails the test) and answers it the way the view would:
// the raw control values go through IJViewPure.collectFields, the dialog's own validate() runs, then the
// values come back. Scripted values override the defaults (numbers are parsed from their text, as typed).
//
// A command that goes wrong cannot pass unnoticed:
//   - a dialog spec the real schema refuses, a key the dialog shows (label, units, option, validate() message)
//     that no lang file has, a dialog assertion (scripted values the dialog's own validate() refuses): the
//     failure is recorded (`t.failures`) and runCommand() REJECTS with it, although the app itself catches
//     the error and shows a message;
//   - an error dialog shown to the operator (`t.errors`): runCommand() fails unless `{ expectError: true }`;
//   - a Preview checkbox is exercised for real: the harness ticks it, WAITS for the engine's answer (a pixel
//     preview, a compute overlay or the "zoom in" note) and then unticks it; a preview that logs an error
//     (a wrong op name, bad params, an op that cannot preview) is a failure;
//   - the engine runs with verifyInputs: an op that writes into an array it was given fails with IJ_INTERNAL.
//
//   const t = await boot({ channels: 3 });
//   await t.open();                                   // mount + Z Project + first image shown
//   await t.runCommand('procSmooth', { radius: 2 });  // dialog values for the command's dialog(s)
//   t.docs(), t.pixels(docId, c), t.engine(cmd, args), t.reload(), t.close()
//
// Wave 3 helpers: t.view(docId) / t.layout() (the stand-in's per-document view and the layout), t.api(pkg) (the api a package
// receives), t.openPanel(id) / t.panel(id) (an extension panel and its element), t.settings (the preferences the app keeps in
// localStorage 'lumen3d.ij.prefs', in memory and kept across reload()), t.pickFile(files | null) (the answer of the next file
// picker: an array of File-like objects, null = cancelled), t.saved ([{ name, blob }] given to saveFile / a download).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT } from './harness.mjs';

export const DIR = path.join(ROOT, 'js', 'modules', 'studio', 'advanced-studio');
export const EN = JSON.parse(fs.readFileSync(path.join(DIR, 'lang', 'en.json'), 'utf8'));
// A wave-3 package's own strings, { en, fr, es, nl }, as its lang-parts/<pkg>.json held them before they were merged into lang/*.json:
// the key inventory of each package (tests/fixtures/ij-wave3/lang-keys.json) read out of the merged dictionaries, so the package tests keep
// checking exactly their own keys (parity, tokens, translations).
const LANG_KEYS = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'ij-wave3', 'lang-keys.json'), 'utf8'));
export function langPart(pkg) {
  const keys = LANG_KEYS[pkg];
  if (!keys) throw new Error('no lang key inventory for package ' + pkg);
  const out = {};
  for (const code of ['en', 'fr', 'es', 'nl']) {
    const dict = JSON.parse(fs.readFileSync(path.join(DIR, 'lang', code + '.json'), 'utf8'));
    const part = {};
    for (const key of keys) {
      const segs = key.split('.');
      const v = segs.reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), dict);
      if (v === undefined) continue;   // a missing translation shows up as a parity failure in the caller
      let node = part;
      for (let i = 0; i < segs.length - 1; i++) node = node[segs[i]] || (node[segs[i]] = {});
      node[segs[segs.length - 1]] = v;
    }
    out[code] = part;
  }
  return out;
}
export const PACKAGES = ['bg', 'filters', 'seg', 'multi', 'geom', 'roi', 'coloc', 'thr', 'enh', 'fft', 'sel', 'io', 'ov', 'ana', 'edit', 'fiji', 'lib'];
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export async function until(fn, what, ms = 8000) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('timeout: ' + what);
    await sleep(5);
  }
}
export const J = (x) => JSON.parse(JSON.stringify(x));

const readSrc = (f, over) => (over && over[f] !== undefined ? over[f] : fs.readFileSync(path.join(DIR, f), 'utf8'));


/**
 * Loads ij-view.js and ij-layout.js into ONE context (the shell needs IJRenderer / IJView / IJLayout as globals) and
 * returns { IJViewPure, IJWindows, IJShell, IJPlot, IJRenderer, IJView, IJLayout, IJLayoutPure, IJRenderSched }.
 */
export function loadViewModules(sandbox = {}) {
  const ctx = vm.createContext({ console, setTimeout, clearTimeout, ...sandbox });
  const src = readSrc('ij-view.js') + '\n' + readSrc('ij-layout.js')
    + '\n;globalThis.__M = { IJViewPure, IJWindows, IJShell, IJPlot, IJRenderer, IJView, IJLayout, IJLayoutPure, IJRenderSched };';
  vm.runInContext(src, ctx, { filename: 'ij-view.js+ij-layout.js' });
  return ctx.__M;
}

// ── a DOM good enough for the controller: every canvas context accepts any call ──
const anyCtx = () => new Proxy({}, { get: (t, k) => (k in t ? t[k] : (typeof k === 'string' ? () => undefined : undefined)), set: (t, k, v) => { t[k] = v; return true; } });
function fakeEl(tag) {
  const listeners = {};
  // children is read-only as in a real DOM (an HTMLCollection): code that assigns to it, or to its length, must fail here too
  let kids = [];
  const el = {
    tagName: String(tag).toUpperCase(), style: {}, className: '', textContent: '', hidden: false,
    get children() { return Object.freeze(kids.slice()); },
    get firstChild() { return kids[0] || null; },
    classList: { add() {}, remove() {}, contains: () => false, toggle() {} },
    appendChild(c) { if (c.parentNode && c.parentNode !== this && c.parentNode.removeChild) c.parentNode.removeChild(c); kids.push(c); c.parentNode = this; return c; },
    removeChild(c) { kids = kids.filter((x) => x !== c); if (c) c.parentNode = null; return c; },
    replaceChildren(...nodes) { for (const k of kids) k.parentNode = null; kids = []; for (const n of nodes) el.appendChild(n); },
    remove() { if (this.parentNode && this.parentNode.removeChild) this.parentNode.removeChild(this); },
    setAttribute() {}, removeAttribute() {}, addEventListener(t, f) { (listeners[t] = listeners[t] || []).push(f); },
    removeEventListener() {}, focus() {}, click() { el.clicked = true; }, select() {}, listeners,
    getContext: () => anyCtx(), toBlob(cb) { cb(new Blob([new Uint8Array(4)])); },
    clientWidth: 800, clientHeight: 600, scrollTop: 0, scrollHeight: 0
  };
  return el;
}

// ── the chrome stand-in: IJShell with a layout and one view stub per document ────────────────────────────
/**
 * makeShellStub({ fakeEl, answer, ask, status, previews, overlays }) -> { create(root, opts), shells }.
 * The stand-in records what the controller asks of ij-view.js / ij-layout.js: per-document view stubs (provider,
 * preview, overlay, threshold overlay, annotations, cursor mark, view, calls), the layout (adds with their
 * placement, order, active, removals, serialisation) and the shell-level recordings the older tests read
 * (`images`, `calls`, `activeRoi`, `displayState`, `rois`, `progress`, `warnings`, `menuRefreshes`).
 */
export function makeShellStub({ fakeEl, answer, ask, status = [], previews = [], overlays = [] }) {
  const shells = [];
  const create = (root, opts) => {
    const calls = [];
    const floats = new Map();
    const views = new Map();
    const order = [];
    const lay = { adds: [], removed: [], activations: [], restored: [], minimized: [], floated: [], cleared: 0, tabInfo: new Map(), onChange: [], onActivate: [], onClose: [], active: null };
    const fire = (kind) => { for (const f of lay.onChange) f(kind); if (opts.onLayoutChange) opts.onLayoutChange(kind); };
    const activateTo = (docId) => {
      const changed = lay.active !== docId;
      lay.active = docId;
      if (changed) { lay.activations.push(docId); for (const f of lay.onActivate) f(docId); if (opts.onActivate) opts.onActivate(docId); }
    };
    const makeView = (docId) => {
      const v = {
        docId, images: [], provider: null, preview: null, overlay: null, thr: null, annotations: null, cursorMark: null, roi: null, rois: null,
        display: null, viewState: { zoom: 1, ox: 0, oy: 0 }, visible: true, fits: 0, invalidations: [], interpolate: false,
        setTileProvider(f) { v.provider = f; }, invalidate(c) { calls.push(['invalidate', c, docId]); v.invalidations.push(c); },
        setPreview(p) { v.preview = p; previews.push(p); }, setThresholdOverlay(t) { v.thr = t; }, setOverlay(items) { v.overlay = items; overlays.push(items); },
        setAnnotations(items, vis) { v.annotations = { items, visible: vis !== false }; }, setCursorMark(x, y) { v.cursorMark = x === null || x === undefined ? null : { x, y }; },
        setDisplayState(s) { v.display = s; }, setDisplay(s) { v.display = s; }, setInterpolate(b) { v.interpolate = !!b; }, setVisible(b) { v.visible = !!b; }, _visible: () => v.visible,
        zoomAt() {}, fit() { v.fits++; calls.push(['fit', docId]); }, view100() {}, zoomToRect() {}, pan() {},
        getView: () => Object.assign({ level: 0, viewportWidth: 800, viewportHeight: 600 }, v.viewState),
        setView(s, how) {
          // like the real view: a clamp may change what was asked, and a view put there by Synchronize Windows is reported with user:false
          const c = v.clamp ? v.clamp({ zoom: s.zoom, ox: s.ox, oy: s.oy }) : { zoom: s.zoom, ox: s.ox, oy: s.oy };
          v.viewState = c; v.viewSets = (v.viewSets || 0) + 1;
          for (const f of v.listeners) f(Object.assign({ docId }, v.viewState, { user: !(how && typeof how === 'object' && how.source === 'sync') }));
        },
        listeners: [], onViewChange(f) { v.listeners.push(f); return () => { v.listeners = v.listeners.filter((x) => x !== f); }; },
        visibleRect: () => ({ x0: 0, y0: 0, x1: v.images.length ? v.images[v.images.length - 1].width : 0, y1: v.images.length ? v.images[v.images.length - 1].height : 0 }),
        focus() {}, resize() {}, renderToCanvas: async () => null, destroy() { v.destroyed = true; }
      };
      return v;
    };
    const layout = {
      el: fakeEl('div'),
      add(docId, o) {
        const place = o || {};
        if (!views.has(docId)) views.set(docId, makeView(docId));
        if (!order.includes(docId)) order.push(docId);
        for (const d of place.docIds || []) { if (!views.has(d)) views.set(d, makeView(d)); if (!order.includes(d)) order.push(d); }
        lay.adds.push({ docId, placement: place.placement || 'tab', anchor: place.anchor, docIds: place.docIds });
        activateTo(docId);
        fire('add');
      },
      remove(docId) {
        const i = order.indexOf(docId);
        const next = layout.neighbour(docId);
        if (i >= 0) order.splice(i, 1);
        const v = views.get(docId); if (v) v.destroyed = true;
        views.delete(docId); lay.removed.push(docId);
        if (lay.active === docId) { lay.active = null; if (next !== null && views.has(next)) activateTo(next); }
        fire('remove');
      },
      activate(docId) { if (views.has(docId)) activateTo(docId); },
      view: (docId) => views.get(docId) || null,
      views: () => Array.from(views.values()),
      order: () => order.slice(),
      has: (docId) => views.has(docId),
      active: () => lay.active,
      neighbour(docId) { const i = order.indexOf(docId); if (order.length < 2) return null; return order[i + 1 < order.length ? i + 1 : i - 1]; },
      serialize: () => ({ v: 1, order: order.slice(), active: lay.active }),
      restoreFrom(json, ids) { lay.restored.push({ json, ids: ids.slice() }); for (const d of ids) { if (!views.has(d)) views.set(d, makeView(d)); if (!order.includes(d)) order.push(d); } fire('restore-from'); },
      clear() { for (const v of views.values()) v.destroyed = true; views.clear(); order.length = 0; lay.cleared++; lay.active = null; fire('clear'); },
      tile() { fire('arrange'); }, cascade() { fire('arrange'); }, showAll() { fire('restore'); }, putBehind() { fire('activate'); },
      minimize(d) { lay.minimized.push(d); fire('minimize'); }, restore() { fire('restore'); }, float(d, r) { lay.floated.push({ docId: d, rect: r }); fire('float'); },
      dock() { fire('dock'); }, maximize() { fire('arrange'); }, toggleMaximize() { fire('arrange'); },
      setTabInfo(docId, o) { lay.tabInfo.set(docId, Object.assign(lay.tabInfo.get(docId) || {}, o)); },
      onChange(f) { lay.onChange.push(f); return () => {}; }, onActivate(f) { lay.onActivate.push(f); return () => {}; }, onClose(f) { lay.onClose.push(f); return () => {}; },
      extent: () => ({ w: 1000, h: 700 })
    };
    const activeView = () => (lay.active !== null ? views.get(lay.active) || null : null);
    const windowsList = () => Array.from(floats.values()).map((w) => ({ id: w.id, title: w.spec.title, win: w }));
    const shell = {
      opts, calls, layout, lay, views, workspace: fakeEl('div'), renderer: {}, images: [], status, progress: [], warnings: [], menuRefreshes: 0, rois: [], infoUpdates: [],
      get activeRoi() { const v = activeView(); return v ? v.roi : undefined; },
      set activeRoi(r) { const v = activeView(); if (v) v.roi = r; },
      get displayState() { const v = activeView(); return v ? v.display : undefined; },
      view: (docId) => views.get(docId) || null,
      activeView, activeDocId: () => lay.active,
      windows: {
        dialog: async (spec) => answer(spec), confirm: async (s) => (ask ? ask(s) : undefined), hasModal: () => false, closeAll() { shell.closedAll = true; },
        floating(spec) { const w = { id: spec.id, spec, focus() {}, close() { floats.delete(spec.id); if (spec.onClose) spec.onClose(); } }; floats.set(spec.id, w); return w; },
        list: windowsList, floats
      },
      setImage(i, o) {
        if (!i) return;
        if (!views.has(i.docId)) layout.add(i.docId, o);
        views.get(i.docId).images.push(i);
        shell.images.push(i);
        layout.setTabInfo(i.docId, { name: i.name || '' });
      },
      removeImage(docId) { layout.remove(docId); },
      clearImage(docId) { if (docId === undefined || docId === null) { layout.clear(); shell.images.push(null); } else layout.remove(docId); },
      updateInfo(i) { shell.infoUpdates.push(i); },
      setDisplayState(s, docId) { const v = docId !== undefined && docId !== null ? views.get(docId) : activeView(); if (v) v.display = s; },
      setActiveRoi(r, docId) { const v = docId !== undefined && docId !== null ? views.get(docId) : activeView(); if (v) v.roi = r; },
      setRois(r, docId) { shell.rois.push(r); const v = docId !== undefined && docId !== null ? views.get(docId) : activeView(); if (v) v.rois = r; },
      setStatus(x) { status.push(x); },
      setProgress(p) { shell.progress.push(p); }, setWarning(w) { shell.warnings.push(w); }, setLineWidth() {}, setTool() {}, setTitle() {}, setTabInfo: (d, o) => layout.setTabInfo(d, o),
      refreshMenus() { shell.menuRefreshes++; }, destroy() { shell.destroyed = true; },
      /** what the operator does with the tabs */
      clickTab(docId) { layout.activate(docId); },
      clickClose(docId) { return opts.onCloseImage ? opts.onCloseImage(docId) : layout.remove(docId); }
    };
    shells.push(shell);
    return shell;
  };
  return { create, shells };
}

// ── the synthetic volume ──
export function makeVolume(o = {}) {
  const W = o.width || 40, H = o.height || 30, D = o.depth || 5, CH = o.channels || 2;
  const value = (c, z, y, x) => ((x * 3 + y * 5 + z * 17 + c * 40 + ((x * y) % 11) * 9 + ((x ^ y) % 7) * 13) % 251) + 1;
  const names = ['DAPI', 'GFP', 'RFP', 'Cy5'];
  const colors = ['#4488ff', '#44ff44', '#ff4444', '#ff44ff'];
  const log = {};
  const desc = {
    available: true, datasetId: '3d/HARNESS', datasetName: 'HARNESS', formatVersion: 4, treeKey: 'tree1', timepoint: null,
    channels: Array.from({ length: CH }, (_, i) => ({ index: i, name: names[i], color: colors[i] })),
    axis: 'z', uAxis: 'x', vAxis: 'y', displayedLevel: 0, figureProjection: 'max', orientation: { rollDeg: 0, back: false },
    levels: [{ level: 0, dims: { x: W, y: H, z: D }, voxelUm: { x: 0.5, y: 0.5, z: 2 }, width: W, height: H, indices: Array.from({ length: D }, (_, i) => i) }]
  };
  const source = {
    describe: () => desc,
    async open({ level }) {
      const s = {
        level, width: W, height: H, depth: D, bandRows: 16, zChunk: 2, estimateBytes: () => W * H * D * CH, assertFrame() {},
        release() { log.released = (log.released || 0) + 1; },
        async readBlock({ y0, y1, z0, z1, channels }) {
          const rows = y1 - y0, depth = z1 - z0;
          const data = channels.map((c) => {
            const a = new Uint8Array(depth * rows * W);
            for (let z = 0; z < depth; z++) for (let y = 0; y < rows; y++) for (let x = 0; x < W; x++) a[(z * rows + y) * W + x] = value(c, z0 + z, y0 + y, x);
            return a;
          });
          return { width: W, rows, depth, data };
        }
      };
      return s;
    }
  };
  return { W, H, D, CH, value, desc, source, log };
}

export async function boot(opts = {}) {
  const o = Object.assign({ storage: null, workerSources: {}, pageSources: {}, brokenPackages: [], budgetBytes: 0 }, opts);
  // localStorage of the page, kept across reload() (the options are handed on)
  if (!o.localStore) o.localStore = new Map();
  const saved = [], picks = { next: undefined };
  const vol = makeVolume(o.volume || { channels: o.channels || 2 });
  const log = { msgs: [], events: [], dialogSpecs: [], status: [], notes: [], previews: [], overlays: [], workerErrors: [], failures: [], errors: [] };
  const store = o.storage || null;

  // ---------------- the page
  // A preview / compute-preview failure is only logged by the app: the harness turns it into a failure.
  const pageConsole = Object.assign(Object.create(console), {
    error(...a) {
      if (typeof a[0] === 'string' && /^\[advanced-studio\] (compute preview|preview)/.test(a[0])) log.failures.push(new Error(a.map(String).join(' ')));
      console.error(...a);
    }
  });
  const page = { console: pageConsole, setTimeout, clearTimeout, MessageChannel, performance, TextEncoder, TextDecoder, AbortController, Blob, queueMicrotask };
  page.self = page;
  page.navigator = { storage: { persist: async () => true, estimate: async () => ({ quota: 1e12, usage: 0 }) } };
  page.localStorage = { getItem: (k) => (o.localStore.has(k) ? o.localStore.get(k) : null), setItem(k, v) { o.localStore.set(k, String(v)); }, removeItem(k) { o.localStore.delete(k); } };
  let lastBlob = null;
  page.URL = { createObjectURL(b) { log.download = b; lastBlob = b; return 'blob:fake'; }, revokeObjectURL() {} };
  const fire = (el, type) => { for (const f of (el.listeners[type] || []).slice()) f({ target: el, type }); };
  page.document = Object.assign(fakeEl('document'), {
    createElement: (tag) => {
      const e = fakeEl(tag);
      // a file input answers with what t.pickFile scripted; a download anchor records what it was given
      if (tag === 'input') e.click = () => { e.clicked = true; const f = picks.next; picks.next = undefined; setTimeout(() => { if (f === undefined || f === null) fire(e, 'cancel'); else { e.files = f; fire(e, 'change'); } }, 0); };
      if (tag === 'a') e.click = () => { e.clicked = true; saved.push({ name: e.download, blob: lastBlob }); };
      return e;
    },
    body: fakeEl('body'), visibilityState: 'visible', addEventListener() {}, removeEventListener() {}
  });
  page.getComputedStyle = () => ({ getPropertyValue: () => '' });
  page.requestAnimationFrame = (f) => setTimeout(f, 0);
  vm.createContext(page);
  const runPage = (f) => vm.runInContext(readSrc(f, o.pageSources), page, { filename: f });
  for (const f of ['ij-core.js', 'ij-analysis.js', 'ij-proc-shared.js', ...PACKAGES.map((p) => `ij-proc-${p}.js`)]) runPage(f);

  // The view's pure helpers and the plot module, from the real file (its own context: no DOM is touched at load).
  const viewCtx = vm.createContext({ console, setTimeout, clearTimeout });
  vm.runInContext(readSrc('ij-view.js', o.pageSources) + '\n;globalThis.__P = IJViewPure; globalThis.__PL = IJPlot;', viewCtx, { filename: 'ij-view.js' });
  const IJViewPure = viewCtx.__P;
  page.IJPlot = viewCtx.__PL;
  // ij-layout.js: the pure layout model and the render scheduler (no DOM is touched at load either)
  vm.runInContext(readSrc('ij-layout.js', o.pageSources) + '\n;globalThis.__LP = IJLayoutPure; globalThis.__RS = IJRenderSched;', viewCtx, { filename: 'ij-layout.js' });
  page.IJLayoutPure = viewCtx.__LP;
  page.IJRenderSched = viewCtx.__RS;

  // ---------------- the worker: the real ij-worker.js over a context that loads scripts on importScripts
  const workers = [];
  const workerStorage = { shared: store };
  function makeWorkerContext(fw) {
    const w = { console, setTimeout, clearTimeout, MessageChannel, performance, TextEncoder, TextDecoder, Blob, queueMicrotask, navigator: {}, DecompressionStream: globalThis.DecompressionStream };
    w.self = w;
    w.onmessage = null;
    w.postMessage = (m) => { if (!fw.dead) setTimeout(() => { if (!fw.dead && fw.onmessage) fw.onmessage({ data: m }); }, 0); };
    vm.createContext(w);
    w.importScripts = (...urls) => {
      for (const u of urls) {
        const file = String(u).replace(/^blob:/, '');
        if (o.brokenPackages.includes(file)) throw new Error('simulated load failure of ' + file);
        vm.runInContext(readSrc(file, o.workerSources), w, { filename: file });
        if (file === 'ij-engine.js') {
          // tests: one engine on a shared memory storage, no idle snapshot, deterministic bands
          const realStart = w.IJEngine.start;
          w.IJEngine.start = (self2, so) => {
            const eng = realStart(self2, Object.assign({}, so, {
              storage: workerStorage.shared || 'memory', idleMs: 3600000, bandPixels: 1 << 20, adaptive: false, verifyInputs: true,
              budgetBytes: o.budgetBytes || so.budgetBytes
            }));
            fw.engine = eng;
            return eng;
          };
        }
      }
    };
    vm.runInContext(readSrc('ij-worker.js', o.workerSources), w, { filename: 'ij-worker.js' });
    return w;
  }
  page.Worker = class FakeWorker {
    constructor(url) {
      this.url = url; this.dead = false; this.onmessage = null; this.onerror = null; this.engine = null;
      this.far = makeWorkerContext(this);
      workers.push(this);
    }
    postMessage(m) {
      if (this.dead) return;
      log.msgs.push(m);
      if (m && m.cmd && log.intercept) {
        const r = log.intercept(m);
        if (r !== undefined) {
          const data = r && r.__error ? { id: m.id, ok: false, error: { code: r.__error, message: r.__error } } : { id: m.id, ok: true, result: r };
          setTimeout(() => this.onmessage && this.onmessage({ data }), 0);
          return;
        }
      }
      setTimeout(() => { if (!this.dead && this.far.onmessage) this.far.onmessage({ data: m }); }, 0);
    }
    terminate() { this.dead = true; }
    crash() { this.dead = true; if (this.onerror) this.onerror({ message: 'boom', preventDefault() {} }); }
  };

  // ---------------- dialogs: scripted values over the defaults, validated by the real field schema
  const script = { dialogs: [], asks: [], nextAsk: null };
  page.Dialog = { ask: async (cfg) => { script.asks.push(cfg); if (cfg && cfg.title === EN.err.title) log.errors.push({ message: cfg.message }); const n = script.nextAsk; if (n) { script.nextAsk = null; return n; } const op = (cfg.options || []).find((x) => x.primary) || cfg.options[0]; return op.id; }, isOpen: () => false };

  const lookupKey = (k) => String(k).split('.').reduce((a, c) => (a && a[c] !== undefined ? a[c] : undefined), EN);
  function keyProblems(spec) {
    const out = [];
    const need = (k, where) => { if (typeof k === 'string' && k && typeof lookupKey(k) !== 'string') out.push(where + ' key ' + k + ' is in no lang file'); };
    for (const f of spec.fields || []) {
      need(f.labelKey, 'field ' + f.id); need(f.unitsKey, 'field ' + f.id + ' units');
      for (const op of f.options || []) if (op && typeof op === 'object') need(op.labelKey, 'option of ' + f.id);
    }
    return out;
  }

  async function answer(spec) {
    log.dialogSpecs.push(spec);
    const problems = IJViewPure.fieldProblems(spec.fields || []).concat(keyProblems(spec));
    assert.equal(problems.length, 0, 'dialog "' + (spec.title || '') + '": ' + problems.join('; '));
    const next = script.dialogs.shift();
    if (next === null) return null; // the operator cancels
    if (typeof next === 'function') return next(spec);
    const raw = {};
    for (const f of spec.fields || []) {
      if (f.type === 'message') continue;
      raw[f.id] = f.type === 'check' ? !!f.value : (f.value === undefined || f.value === null ? '' : String(f.value));
    }
    const over = next || {};
    for (const k of Object.keys(over)) {
      const f = (spec.fields || []).find((x) => x.id === k);
      assert.ok(f, `dialog "${spec.title}": scripted value for a field it does not have (${k})`);
      raw[k] = f.type === 'check' ? !!over[k] : String(over[k]);
    }
    // enabledIf / visibleIf and the cross-field validate, as the view does
    const hidden = new Set();
    for (let pass = 0; pass < 2; pass++) {
      const r0 = IJViewPure.collectFields(spec.fields, raw, { hidden });
      for (const f of spec.fields) if (f.visibleIf) { if (f.visibleIf(r0.values)) hidden.delete(f.id); else hidden.add(f.id); }
    }
    const r = IJViewPure.collectFields(spec.fields, raw, { hidden });
    assert.ok(r.ok, `dialog "${spec.title}" refuses the values: ${JSON.stringify(r.errors)}`);
    if (typeof spec.validate === 'function') {
      const v = spec.validate(r.values);
      for (const k of Object.keys(v || {})) assert.equal(typeof lookupKey(v[k]), 'string', `dialog "${spec.title}": validate() message key ${v[k]} is in no lang file`);
      assert.ok(!v || !Object.keys(v).length, `dialog "${spec.title}" validate(): ${JSON.stringify(v)}`);
    }
    if (spec.preview && typeof spec.preview.onChange === 'function' && o.firePreview !== false) {
      const ctl = { note(text) { log.notes.push(text); } };
      const before = { p: log.previews.length, o: log.overlays.length, n: log.notes.length, f: log.failures.length };
      spec.preview.onChange(r.values, ctl);
      // The pixel preview is debounced (90 ms) and answered by the engine; a compute preview by an overlay; a
      // preview that cannot be drawn by a note. Nothing within the wait = the preview never ran.
      await until(() => log.previews.length > before.p || log.overlays.length > before.o || log.notes.length > before.n || log.failures.length > before.f,
        'the preview of "' + (spec.title || '') + '" produced nothing', o.previewWaitMs || 3000);
      assert.equal(log.failures.length, before.f, 'the preview of "' + (spec.title || '') + '" failed: ' + (log.failures[before.f] && log.failures[before.f].message));
      spec.preview.onChange(null, ctl);
    }
    return r.values;
  }

  // ---------------- the chrome stand-in
  const stub = makeShellStub({
    fakeEl,
    answer: async (spec) => { try { return await answer(spec); } catch (err) { log.failures.push(err); throw err; } },
    ask: (s) => page.Dialog.ask(s),
    status: log.status, previews: log.previews, overlays: log.overlays
  });
  const shells = stub.shells;
  page.IJShell = { create: stub.create };

  runPage('ij-app.js');
  vm.runInContext('globalThis.__IJApp = IJApp;', page);
  for (const p of PACKAGES) runPage(`ij-cmds-${p}.js`);
  const IJApp = page.__IJApp;

  const interp = (s, p) => String(s).replace(/\{(\w+)\}/g, (m, k) => (p && p[k] !== undefined ? p[k] : m));
  const lookup = (k) => k.split('.').reduce((a, c) => (a && a[c] !== undefined ? a[c] : undefined), EN);
  const ctx = {
    i18n: { t: (k, p) => { const v = lookup(k); return typeof v === 'string' ? interp(v, p) : k; } },
    plugin: { assetUrl: (r) => 'asset/' + r, fileUrl: (r) => 'blob:' + r },
    studio: { source: vol.source, getDocument: () => null }
  };
  const root = fakeEl('div'); root.classList = { add() {}, remove() {}, contains: () => false };
  const api = { exits: 0, closes: 0, async exit() { api.exits++; return true; }, async close() { api.closes++; return true; }, getDocument: () => null, token: () => 1 };

  let seq = 900000;
  const t = {
    IJApp, IJViewPure, vol, log, script, shells, workers, ctx, api, root, page, store: workerStorage,
    /** Error dialogs shown to the operator so far, and the dialog / preview failures the app itself swallowed. */
    get errors() { return log.errors; },
    get failures() { return log.failures; },
    get shell() { return shells[shells.length - 1]; },
    get worker() { return workers[workers.length - 1]; },
    /** A request straight to the engine, bypassing the page. */
    engine(cmd, args, wk) {
      const w = wk || t.worker;
      if (!w.__pending) {
        // one interceptor per worker: answers are routed by request id, so requests may overlap
        w.__pending = new Map();
        const orig = w.far.postMessage;
        w.far.postMessage = (m) => {
          const p = m && m.id !== undefined && !m.event ? w.__pending.get(m.id) : null;
          if (p) { w.__pending.delete(m.id); if (m.ok) p.resolve(m.result); else p.reject(Object.assign(new Error('engine ' + p.cmd + ': ' + (m.error && m.error.code)), m.error || {}, { message: 'engine ' + p.cmd + ': ' + (m.error && m.error.code) })); } else orig.call(w.far, m);
        };
      }
      return new Promise((resolve, reject) => {
        const id = ++seq;
        w.__pending.set(id, { resolve, reject, cmd });
        w.far.onmessage({ data: { id, cmd, args: args || {} } });
      });
    },
    cmd: (id) => t.shell.opts.commands.find((c) => c.id === id),
    isEnabled: (id) => t.cmd(id).enabled(t.shell.opts.getState()),
    /**
     * Runs a menu command; `values` = the scripted answers of its dialog(s) (an object, or an array of them).
     * Rejects with the recorded failure when a dialog spec / key / assertion / preview failed inside it, and
     * when the app showed an error dialog — unless `o.expectError` (then it returns the error list, >= 1). `o.mods` = { alt, shift } held.
     */
    async runCommand(id, values, o) {
      const c = t.cmd(id);
      assert.ok(c, 'command ' + id);
      assert.ok(!(c.pkg && IJApp && t.failedPackages().has(c.pkg)), id + ': its package failed to load');
      assert.ok(c.enabled(t.shell.opts.getState()), id + ' is enabled');
      const f0 = log.failures.length, e0 = log.errors.length;
      if (values !== undefined) for (const v of (Array.isArray(values) ? values : [values])) script.dialogs.push(v);
      // o.mods = the keys held at the click ({ alt, shift }), as the menu / the shortcut hand them over; o.source = 'menu' | 'key'
      await t.shell.opts.onCommand(c, Object.assign({ source: (o && o.source) || 'menu' }, (o && o.mods) || {}));
      script.dialogs.length = 0;
      if (log.failures.length > f0) throw log.failures[f0];
      const errs = log.errors.slice(e0);
      if (o && o.expectError) assert.ok(errs.length > 0, id + ' was expected to report an error');
      else assert.equal(errs.length, 0, id + ' reported an error to the operator: ' + errs.map((e) => e.message).join(' | '));
      return errs;
    },
    failedPackages: () => { const set = new Set(); for (const m of log.events) if (m.event === 'packageFailed') set.add(m.pkg); return set; },
    async open(zp) {
      script.dialogs.push(zp || { method: 'max', start: 1, stop: vol.D, level: 0 });
      IJApp.mount(root, { ctx, api });
      const sh = await until(() => shells[shells.length - 1], 'shell');
      await until(() => sh.images.filter(Boolean).some((i) => i.docId !== -1 && i.name), 'first image shown');
      return sh;
    },
    async docs() { return (await t.engine('doc.list')).docs; },
    async pixels(docId, c) { const r = await t.engine('doc.tile', { docId, channel: c || 0, level: 0, tx: 0, ty: 0 }); return r.data.slice(); },
    activeId: () => t.IJApp && t.shell && t.shell.images.filter(Boolean).pop().docId,
    view: (docId) => t.shell.view(docId),
    layout: () => t.shell.layout,
    api: (pkg) => IJApp.apiFor(pkg),
    openPanel: (id, o2) => IJApp.apiFor(null).openPanel(id, o2),
    panel: (id) => { const w = t.shell.windows.floats.get(id); return w ? w.spec.content : null; },
    saved,
    pickFile: (files) => { picks.next = files; },
    settings: {
      all: () => { const raw = o.localStore.get('lumen3d.ij.prefs'); return raw ? JSON.parse(raw) : {}; },
      get(k) { return this.all()[k]; },
      set(k, v) { const a = this.all(); a[k] = v; o.localStore.set('lumen3d.ij.prefs', JSON.stringify(a)); }
    },
    /** A worker + engine without mounting the app (tests that talk to the engine only). */
    async spawn() {
      const w = new page.Worker('asset/ij-worker.js');
      w.onmessage = () => {};
      const before = log.events.filter((e) => e.event === 'ready').length;
      w.postMessage({ init: Object.assign(IJApp.workerInit(ctx.plugin), { budgetBytes: o.budgetBytes || (1 << 30) }) });
      await until(() => log.events.filter((e) => e.event === 'ready').length > before || log.events.some((e) => e.event === 'initError'), 'engine ready');
      return w;
    },
    async flush() { return t.engine('flush'); },
    /** Stops this boot (the stored sessions stay) and boots a new page on the same storage. */
    async reload(more) {
      if (!(more && more.flush === false)) await t.flush().catch(() => {});
      const next = Object.assign({}, o, more || {}, { storage: workerStorage.shared || null });
      t.close();
      return boot(next);
    },
    close() { try { IJApp.release(); } catch (_) { /* gone */ } for (const w of workers) { w.dead = true; if (w.engine) w.engine.dispose(); } }
  };
  // events the worker posts (the page's own handler runs first, this log is for the tests)
  const origPost = page.Worker.prototype.postMessage;
  void origPost;
  const wrapOnMessage = (w) => {
    let h = w.onmessage;
    Object.defineProperty(w, 'onmessage', { get: () => h, set: (fn) => { h = fn ? (ev) => { if (ev && ev.data && ev.data.event) log.events.push(ev.data); return fn(ev); } : fn; }, configurable: true });
  };
  const RealWorker = page.Worker;
  page.Worker = class extends RealWorker { constructor(url) { super(url); wrapOnMessage(this); } };

  // A shared memory storage: the first boot creates it through the engine's own factory, reload() reuses it.
  if (!workerStorage.shared) {
    const probe = vm.createContext({ console, setTimeout, clearTimeout, MessageChannel, performance, TextEncoder, TextDecoder, Blob, queueMicrotask, navigator: {} });
    probe.self = probe;
    for (const f of ['ij-core.js', 'ij-analysis.js', 'ij-proc-shared.js', 'ij-engine.js']) vm.runInContext(readSrc(f, o.workerSources), probe, { filename: f });
    workerStorage.shared = probe.IJEngine.createMemoryStorage();
  }
  return t;
}
