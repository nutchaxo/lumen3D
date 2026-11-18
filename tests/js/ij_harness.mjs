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
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT } from './harness.mjs';

export const DIR = path.join(ROOT, 'js', 'modules', 'studio', 'advanced-studio');
export const EN = JSON.parse(fs.readFileSync(path.join(DIR, 'lang', 'en.json'), 'utf8'));
// The English of the packages while their lang-parts/<pkg>.json exist (merged into the dictionary at W3).
{
  const parts = path.join(DIR, 'lang-parts');
  const merge = (dst, src) => { for (const k of Object.keys(src)) { if (src[k] && typeof src[k] === 'object') { if (!dst[k] || typeof dst[k] !== 'object') dst[k] = {}; merge(dst[k], src[k]); } else if (dst[k] === undefined) dst[k] = src[k]; } };
  if (fs.existsSync(parts)) for (const f of fs.readdirSync(parts).filter((x) => x.endsWith('.json')).sort()) { const j = JSON.parse(fs.readFileSync(path.join(parts, f), 'utf8')); if (j.en) merge(EN, j.en); }
}
export const PACKAGES = ['bg', 'filters', 'seg', 'multi', 'geom', 'roi', 'coloc'];
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

// ── a DOM good enough for the controller: every canvas context accepts any call ──
const anyCtx = () => new Proxy({}, { get: (t, k) => (k in t ? t[k] : (typeof k === 'string' ? () => undefined : undefined)), set: (t, k, v) => { t[k] = v; return true; } });
function fakeEl(tag) {
  const listeners = {};
  const el = {
    tagName: String(tag).toUpperCase(), children: [], style: {}, className: '', textContent: '', hidden: false,
    classList: { add() {}, remove() {}, contains: () => false, toggle() {} },
    appendChild(c) { this.children.push(c); c.parentNode = this; return c; },
    remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((x) => x !== this); },
    setAttribute() {}, removeAttribute() {}, addEventListener(t, f) { (listeners[t] = listeners[t] || []).push(f); },
    removeEventListener() {}, focus() {}, click() { el.clicked = true; }, select() {}, listeners,
    getContext: () => anyCtx(), toBlob(cb) { cb(new Blob([new Uint8Array(4)])); },
    clientWidth: 800, clientHeight: 600, scrollTop: 0, scrollHeight: 0
  };
  return el;
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
  page.localStorage = { getItem: () => null, setItem() {} };
  page.URL = { createObjectURL(b) { log.download = b; return 'blob:fake'; }, revokeObjectURL() {} };
  page.document = Object.assign(fakeEl('document'), { createElement: (tag) => fakeEl(tag), body: fakeEl('body'), visibilityState: 'visible', addEventListener() {}, removeEventListener() {} });
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

  // ---------------- the worker: the real ij-worker.js over a context that loads scripts on importScripts
  const workers = [];
  const workerStorage = { shared: store };
  function makeWorkerContext(fw) {
    const w = { console, setTimeout, clearTimeout, MessageChannel, performance, TextEncoder, TextDecoder, Blob, queueMicrotask, navigator: {} };
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
  const shells = [];
  page.IJShell = {
    create(root, opts2) {
      const calls = [];
      const display = {
        setTileProvider(f) { display.provider = f; }, invalidate(c) { calls.push(['invalidate', c]); }, setPreview(p) { display.preview = p; log.previews.push(p); },
        setThresholdOverlay(t2) { display.thr = t2; }, setOverlay(items) { display.overlay = items; log.overlays.push(items); },
        setDisplay() {}, zoomAt() {}, fit() { calls.push(['fit']); }, view100() {}, zoomToRect() {},
        getView: () => ({ zoom: 1, ox: 0, oy: 0, level: 0, viewportWidth: 800, viewportHeight: 600 }), resize() {}, renderToCanvas: async () => null
      };
      const floats = new Map();
      const shell = {
        opts: opts2, calls, display, stage: fakeEl('div'), images: [], status: log.status, progress: [], warnings: [], menuRefreshes: 0, rois: [], infoUpdates: [],
        windows: {
          dialog: async (spec) => { try { return await answer(spec); } catch (err) { log.failures.push(err); throw err; } }, confirm: async (s) => page.Dialog.ask(s), hasModal: () => false, closeAll() {},
          floating(spec) { const w = { id: spec.id, spec, focus() {}, close() { floats.delete(spec.id); if (spec.onClose) spec.onClose(); } }; floats.set(spec.id, w); return w; }, floats
        },
        setImage(i) { shell.images.push(i); }, clearImage() { shell.images.push(null); }, updateInfo(i) { shell.infoUpdates.push(i); }, setDisplayState(s) { shell.displayState = s; },
        setActiveRoi(r) { shell.activeRoi = r; }, setRois(r) { shell.rois.push(r); }, setStatus(x) { log.status.push(x); },
        setProgress(p) { shell.progress.push(p); }, setWarning(w) { shell.warnings.push(w); }, setLineWidth() {}, setTool() {},
        refreshMenus() { shell.menuRefreshes++; }, destroy() { shell.destroyed = true; }
      };
      shells.push(shell);
      return shell;
    }
  };
  page.IJDisplay = {};
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
     * when the app showed an error dialog — unless `o.expectError` (then it returns the error list, >= 1).
     */
    async runCommand(id, values, o) {
      const c = t.cmd(id);
      assert.ok(c, 'command ' + id);
      assert.ok(!(c.pkg && IJApp && t.failedPackages().has(c.pkg)), id + ': its package failed to load');
      assert.ok(c.enabled(t.shell.opts.getState()), id + ' is enabled');
      const f0 = log.failures.length, e0 = log.errors.length;
      if (values !== undefined) for (const v of (Array.isArray(values) ? values : [values])) script.dialogs.push(v);
      await t.shell.opts.onCommand(c, { source: 'menu' });
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
