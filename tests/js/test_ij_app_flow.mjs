// The Advanced Studio controller (ij-app.js) driven end to end under Node: the REAL engine
// (ij-engine.js over ij-core.js / ij-analysis.js) behind a fake Worker, a synthetic volume behind
// the `ctx.studio.source` contract, and a recording stand-in for the chrome of ij-view.js.
//
// Covers: mount → Z Project dialog → streamed load (bands × z-chunks, transferred blocks) →
// the projected pixels; commands through the shell's onCommand (Invert, Undo, Gaussian blur with
// its dialog, Measure → Results, Convert to Mask → a new image, Window menu entries);
// Save as TIFF (download path) → clean; leaving with unsaved work (Keep) and the Simple-view
// round trip; cancel of a load; a worker crash offering recovery.
//
// Run: node tests/js/test_ij_app_flow.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT } from './harness.mjs';

const DIR = path.join(ROOT, 'js', 'modules', 'studio', 'advanced-studio');
const EN = JSON.parse(fs.readFileSync(path.join(DIR, 'lang', 'en.json'), 'utf8'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, what, ms = 8000) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('timeout: ' + what);
    await sleep(5);
  }
}

// ── a minimal DOM ──────────────────────────────────────────────────────────────────────────────
function fakeEl(tag) {
  const listeners = {};
  const el = {
    tagName: String(tag).toUpperCase(), children: [], style: {}, className: '', textContent: '', hidden: false,
    classList: { add() {}, remove() {}, contains: () => false, toggle() {} },
    appendChild(c) { this.children.push(c); c.parentNode = this; return c; },
    remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((x) => x !== this); },
    setAttribute() {}, removeAttribute() {}, addEventListener(t, f) { (listeners[t] = listeners[t] || []).push(f); },
    removeEventListener() {}, focus() {}, click() { el.clicked = true; }, select() {},
    getContext: () => ({ clearRect() {}, fillRect() {}, strokeRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, fillText() {}, set fillStyle(v) {}, set strokeStyle(v) {}, set lineWidth(v) {}, set font(v) {} }),
    clientWidth: 800, clientHeight: 600, scrollTop: 0, scrollHeight: 0
  };
  return el;
}

// ── a synthetic volume behind ctx.studio.source ─────────────────────────────────────────────────
const W = 40, H = 30, D = 5, CH = 2;
const value = (c, z, y, x) => ((x * 3 + y * 5 + z * 17 + c * 40 + ((x * y) % 11) * 9 + ((x ^ y) % 7) * 13) % 251) + 1;
const refMax = (c, y, x) => { let m = 0; for (let z = 0; z < D; z++) m = Math.max(m, value(c, z, y, x)); return m; };
const refSum = (c, y, x) => { let s = 0; for (let z = 0; z < D; z++) s += value(c, z, y, x); return s; };

function makeSource(log) {
  const desc = {
    available: true, datasetId: '3d/FLOW', datasetName: 'FLOW', formatVersion: 4, treeKey: 'tree1', timepoint: null,
    channels: [{ index: 0, name: 'DAPI', color: '#4488ff' }, { index: 1, name: 'GFP', color: '#44ff44' }],
    axis: 'z', uAxis: 'x', vAxis: 'y', displayedLevel: 0, figureProjection: 'max', orientation: { rollDeg: 0, back: false },
    levels: [{ level: 0, dims: { x: W, y: H, z: D }, voxelUm: { x: 0.5, y: 0.5, z: 2 }, width: W, height: H, indices: [0, 1, 2, 3, 4] }]
  };
  const source = {
    describe: () => desc,
    async open({ level, signal }) {
      log.opened = (log.opened || 0) + 1;
      const s = {
        level, width: W, height: H, depth: D, bandRows: 16, zChunk: 2,
        estimateBytes: () => W * H * D * CH,
        assertFrame() { if (log.frameLost) throw Object.assign(new Error('frame'), { code: 'STUDIO_FRAME_LOST' }); },
        released: 0, release() { this.released++; log.released = (log.released || 0) + 1; },
        async readBlock({ y0, y1, z0, z1, channels, signal: sg }) {
          if (log.slow) await sleep(log.slow);
          if (sg && sg.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
          log.blocks = (log.blocks || 0) + 1;
          const rows = y1 - y0, depth = z1 - z0;
          const data = channels.map((c) => {
            const a = new Uint8Array(depth * rows * W);
            for (let z = 0; z < depth; z++) for (let y = 0; y < rows; y++) for (let x = 0; x < W; x++) a[(z * rows + y) * W + x] = value(c, z0 + z, y0 + y, x);
            return a;
          });
          return { width: W, rows, depth, data };
        }
      };
      log.session = s;
      return s;
    }
  };
  return { desc, source };
}

// ── the sandbox: real pure modules + engine + controller ────────────────────────────────────────
function boot() {
  const log = {};
  const sandbox = { console, setTimeout, clearTimeout, MessageChannel, performance, TextEncoder, TextDecoder, AbortController, Blob, queueMicrotask };
  sandbox.self = sandbox;
  sandbox.navigator = { storage: { persist: async () => true, estimate: async () => ({ quota: 1e12, usage: 0 }) } };
  sandbox.localStorage = { getItem: () => null, setItem() {} };
  sandbox.URL = { createObjectURL(b) { log.download = b; return 'blob:fake'; }, revokeObjectURL() {} };
  sandbox.document = Object.assign(fakeEl('document'), {
    createElement: fakeEl, body: fakeEl('body'), visibilityState: 'visible', addEventListener() {}, removeEventListener() {}
  });
  sandbox.getComputedStyle = () => ({ getPropertyValue: () => '' });
  sandbox.requestAnimationFrame = (f) => setTimeout(f, 0);
  vm.createContext(sandbox);
  for (const f of ['ij-core.js', 'ij-analysis.js', 'ij-engine.js']) vm.runInContext(fs.readFileSync(path.join(DIR, f), 'utf8'), sandbox, { filename: f });

  // A Worker whose far side is the real engine.
  const workers = [];
  sandbox.Worker = class FakeWorker {
    constructor(url) {
      this.url = url; this.dead = false; this.onmessage = null; this.onerror = null;
      const self = this;
      this.far = { onmessage: null, navigator: {}, postMessage(m) { if (!self.dead) setTimeout(() => self.onmessage && self.onmessage({ data: m }), 0); } };
      this.inited = false; this.engine = null;
      workers.push(this);
    }
    postMessage(m) {
      if (this.dead) return;
      if (m && m.init) {
        log.init = m.init;
        this.engine = sandbox.IJEngine.start(this.far, { storage: 'memory', idleMs: 3600000, bandPixels: 1 << 20, budgetBytes: m.init.budgetBytes });
        return;
      }
      setTimeout(() => { if (!this.dead && this.far.onmessage) this.far.onmessage({ data: m }); }, 0);
    }
    terminate() { this.dead = true; }
    crash() { this.dead = true; if (this.onerror) this.onerror({ message: 'boom', preventDefault() {} }); }
  };

  // Dialogs: scripted answers keyed by what the dialog asks for.
  const script = { dialogs: [], asks: [] };
  log.dialogSpecs = [];
  const answer = (spec) => {
    log.dialogSpecs.push(spec);
    const next = script.dialogs.shift();
    if (typeof next === 'function') return next(spec);
    if (next !== undefined) return next;
    const v = {};
    for (const f of spec.fields || []) if (f.type !== 'message') v[f.id] = f.value;
    return v;
  };
  sandbox.Dialog = { ask: async (cfg) => { script.asks.push(cfg); const n = script.nextAsk; if (n) { script.nextAsk = null; return n; } const o = (cfg.options || []).find((x) => x.primary) || cfg.options[0]; return o.id; }, isOpen: () => false };

  // The chrome of ij-view.js, recorded.
  const shells = [];
  sandbox.IJShell = {
    create(root, opts) {
      const calls = [];
      const display = {
        setTileProvider(f) { display.provider = f; }, invalidate(c) { calls.push(['invalidate', c]); }, setPreview(p) { display.preview = p; },
        setThresholdOverlay(t) { display.overlay = t; }, setDisplay() {}, zoomAt() {}, fit() { calls.push(['fit']); }, view100() {}, zoomToRect() {},
        getView: () => ({ zoom: 1, ox: 0, oy: 0, level: 0, viewportWidth: 800, viewportHeight: 600 }), resize() {}, renderToCanvas: async () => null
      };
      const floats = new Map();
      const shell = {
        opts, calls, display, stage: fakeEl('div'), images: [], status: [], progress: [], warnings: [], menuRefreshes: 0, rois: [],
        windows: {
          dialog: async (spec) => answer(spec), confirm: async (s) => sandbox.Dialog.ask(s),
          floating(spec) { const w = { id: spec.id, spec, focus() {}, close() { floats.delete(spec.id); if (spec.onClose) spec.onClose(); } }; floats.set(spec.id, w); return w; }, floats
        },
        setImage(i) { shell.images.push(i); }, clearImage() { shell.images.push(null); }, setDisplayState(s) { shell.displayState = s; },
        setActiveRoi(r) { shell.activeRoi = r; }, setRois(r) { shell.rois.push(r); }, setStatus(t) { shell.status.push(t); },
        setProgress(p) { shell.progress.push(p); }, setWarning(w) { shell.warnings.push(w); }, setLineWidth() {}, setTool() {},
        refreshMenus() { shell.menuRefreshes++; }, destroy() { shell.destroyed = true; }
      };
      shells.push(shell);
      return shell;
    }
  };
  sandbox.IJDisplay = {};
  vm.runInContext(fs.readFileSync(path.join(DIR, 'ij-app.js'), 'utf8') + '\n;globalThis.__IJApp = IJApp;', sandbox, { filename: 'ij-app.js' });

  // Plugin ctx.
  const { desc, source } = makeSource(log);
  const interp = (s, p) => String(s).replace(/\{(\w+)\}/g, (m, k) => (p && p[k] !== undefined ? p[k] : m));
  const lookup = (k) => k.split('.').reduce((a, c) => (a && a[c] !== undefined ? a[c] : undefined), EN);
  const ctx = {
    i18n: { t: (k, p) => { const v = lookup(k); return typeof v === 'string' ? interp(v, p) : k; } },
    plugin: { assetUrl: (r) => 'asset/' + r, fileUrl: (r) => 'blob:' + r },
    studio: { source, getDocument: () => null }
  };
  const root = fakeEl('div'); root.classList = { add() {}, remove() {}, contains: () => false };
  const api = { exits: 0, closes: 0, async exit() { api.exits++; return true; }, async close() { api.closes++; return true; }, getDocument: () => null, token: () => 1 };
  return { sandbox, IJApp: sandbox.__IJApp, log, script, shells, workers, ctx, api, root, desc };
}

const cmdOf = (shell, id) => shell.opts.commands.find((c) => c.id === id);
const run = async (shell, id) => { const c = cmdOf(shell, id); assert.ok(c, 'command ' + id); assert.ok(c.enabled(shell.opts.getState()), id + ' is enabled'); await shell.opts.onCommand(c, { source: 'menu' }); };
const pix = async (shell, x, y) => (await shell.opts.readPixel(x, y));
const J = (x) => JSON.parse(JSON.stringify(x));

// ═════════════ 1. Z Project (Sum, 16-bit) → pixels → commands ═════════════
{
  const t = boot();
  t.script.dialogs.push((spec) => { assert.ok(spec.fields.some((f) => f.id === 'method'), 'the first dialog is Z Project'); return { method: 'sum', start: 1, stop: D, level: 0 }; });
  t.IJApp.mount(t.root, { ctx: t.ctx, api: t.api });
  await until(() => t.shells[0] && t.shells[0].images.find((i) => i && i.name), 'projection loaded');
  const sh = t.shells[0];
  assert.deepEqual(J(t.log.init.scripts), ['blob:ij-core.js', 'blob:ij-analysis.js', 'blob:ij-engine.js'], 'worker init carries the verified script URLs');
  assert.ok(t.log.init.budgetBytes >= 512 * 1048576 && t.log.init.budgetBytes <= 2 * 1024 * 1048576, 'budget within [512 MiB, 2 GiB]');
  assert.equal(t.workers[0].url, 'asset/ij-worker.js');
  await until(() => sh.images.filter(Boolean).some((i) => i.docId !== -1 && i.bitDepth === 16), 'doc shown');
  const img = sh.images.filter(Boolean).pop();
  assert.equal(img.bitDepth, 16, 'Sum of 5 slices is 16-bit');
  assert.equal(img.width, W); assert.equal(img.height, H);
  assert.equal(img.channels.length, CH);
  assert.equal(img.calibration.pixelWidth, 0.5);
  assert.ok(/FLOW/.test(img.name), 'the name carries the dataset');
  assert.ok(t.log.blocks >= Math.ceil(H / 16) * Math.ceil(D / 2), 'every band × z-chunk was read');
  assert.ok(t.log.session.released >= 1, 'the read session is released');
  assert.ok(sh.progress.some((p) => p && Number.isFinite(p.fraction) && p.cancellable), 'progress with a fraction and Cancel');
  assert.ok(sh.progress.some((p) => p && /Loading \d+ %/.test(p.label || '')), 'honest loading label');
  assert.equal(sh.progress[sh.progress.length - 1], null, 'progress is cleared');

  // The projected values equal the reference sum, per channel.
  for (const [x, y] of [[0, 0], [7, 3], [39, 29], [20, 15]]) {
    const v = await pix(sh, x, y);
    assert.deepEqual(J(v), [refSum(0, y, x), refSum(1, y, x)], `pixel ${x},${y}`);
  }
  // Provenance and the session key reach the engine.
  assert.equal(img.provenance.datasetId, '3d/FLOW');
  assert.equal(img.provenance.method, 'sum');
  assert.ok(String(img.provenance.sessionKey).startsWith('3d/FLOW|tree1||z|0-4|0|sum'), 'session key: ' + img.provenance.sessionKey);

  // Invert → Undo (Ctrl+Z is the shell's job; the command is what we run).
  const before = J(await pix(sh, 7, 3));
  await run(sh, 'editInvert');
  const inv = J(await pix(sh, 7, 3));
  assert.deepEqual(inv, [65535 - before[0], before[1]], '16-bit invert of the active channel only (ImageJ composite behaviour)');
  assert.ok(sh.calls.some((c) => c[0] === 'invalidate'), 'the display drops its tiles');
  assert.equal(cmdOf(sh, 'editUndo').enabled(sh.opts.getState()), true);
  assert.equal(cmdOf(sh, 'fileRevert').enabled(sh.opts.getState()), true, 'a changed image can be reverted');
  await run(sh, 'editUndo');
  assert.deepEqual(J(await pix(sh, 7, 3)), before, 'undo restores the pixels');
  assert.equal(cmdOf(sh, 'editRedo').enabled(sh.opts.getState()), true);

  // A selection from the shell restricts the next op; Gaussian through its dialog.
  const roi = { type: 'rect', x: 5, y: 5, w: 10, h: 10 };
  sh.opts.onRoi(roi, { final: true });
  assert.equal(cmdOf(sh, 'imageCrop').enabled(sh.opts.getState()), true);
  assert.equal(cmdOf(sh, 'editMakeInverse').enabled(sh.opts.getState()), true);
  const inside = J(await pix(sh, 8, 8)), outside = J(await pix(sh, 30, 20));
  t.script.dialogs.push((spec) => { assert.ok(spec.preview && typeof spec.preview.onChange === 'function', 'the dialog carries the preview hook'); return { sigma: 1.5, scaled: false, all: true }; });
  await run(sh, 'filterGaussian');
  assert.deepEqual(J(await pix(sh, 30, 20)), outside, 'outside the selection is untouched');
  assert.notDeepEqual(J(await pix(sh, 8, 8)), inside, 'inside the selection is blurred');
  await run(sh, 'editUndo');
  assert.deepEqual(J(await pix(sh, 8, 8)), inside);

  // Measure → Results rows (Area, Mean, Min, Max by default).
  await run(sh, 'analyzeMeasure');
  assert.ok(sh.windows.floats.has('results'), 'the Results window opens');
  await run(sh, 'analyzeMeasure');
  await until(() => sh.windows.floats.get('results'), 'results window');
  assert.equal(cmdOf(sh, 'analyzeClearResults').enabled(sh.opts.getState()), true);
  assert.equal(cmdOf(sh, 'fileSaveResults').enabled(sh.opts.getState()), true);

  // Select None, Convert to Mask → a new 8-bit image appears and takes the display; Window entries.
  sh.opts.onRoi(null, { final: true });
  await run(sh, 'typeBit8');
  await until(() => sh.images.filter(Boolean).pop().bitDepth === 8, '8-bit after Type');
  await run(sh, 'binMask');
  const maskImg = await until(() => { const i = sh.images.filter(Boolean).pop(); return /-mask$/.test(i.name) ? i : null; }, 'mask image shown');
  assert.equal(maskImg.bitDepth, 8);
  const values = new Set();
  for (let y = 0; y < H; y += 3) for (let x = 0; x < W; x += 3) for (const v of J(await pix(sh, x, y))) values.add(v);
  assert.ok([...values].every((v) => v === 0 || v === 255), 'the mask holds only 0 and 255');
  assert.ok(sh.opts.commands.filter((c) => c.menu[0] === 'Window' && /^winImg/.test(c.id)).length >= 2, 'the Window menu lists both images');
  assert.equal(cmdOf(sh, 'binErode').enabled(sh.opts.getState()), true, 'binary ops are open on the mask');
  await run(sh, 'binErode');
  assert.equal(cmdOf(sh, 'windowNext').enabled(sh.opts.getState()), true);
  await run(sh, 'windowNext');
  await until(() => { const i = sh.images.filter(Boolean).pop(); return !/-mask$/.test(i.name); }, 'back to the projection');

  // Save as TIFF: the download path (no file picker), then clean.
  await run(sh, 'fileSaveTiff');
  assert.ok(t.log.download && t.log.download.size > W * H * CH, 'a TIFF of at least the pixel bytes was offered');
  assert.equal(t.IJApp.hasUnsavedWork(), true, 'the mask image is still unsaved');

  // Leaving: Simple view keeps everything alive; Close asks (Keep for later) and disposes.
  assert.equal(await t.IJApp.canLeave('simple'), true);
  t.IJApp.unmount();
  assert.equal(sh.destroyed, undefined, 'the Simple view hides, it does not tear down');
  assert.equal(t.workers[0].dead, false, 'the worker survives the Simple view');
  t.IJApp.mount(t.root, { ctx: t.ctx, api: t.api });
  assert.equal(t.shells.length, 1, 'coming back reuses the shell');
  t.script.nextAsk = 'cancel';
  assert.equal(await t.IJApp.canLeave('close'), false, 'Cancel keeps the view open');
  t.script.nextAsk = 'keep';
  assert.equal(await t.IJApp.canLeave('close'), true, 'Keep for later lets it close');
  const askCfg = t.script.asks[t.script.asks.length - 1];
  assert.equal(askCfg.options.map((o) => o.id).join(), 'save,keep,discard,cancel');
  t.IJApp.unmount();
  assert.equal(sh.destroyed, true, 'close disposes the shell');
  await until(() => t.workers[0].dead, 'worker stopped');
  assert.equal(t.api.exits, 0, 'the view never left on its own');
}

// ═════════════ 2. a single plane opens as it is stored ═════════════
{
  const t = boot();
  t.desc.levels[0].indices = [2];
  t.IJApp.mount(t.root, { ctx: t.ctx, api: t.api });
  const sh = await until(() => t.shells[0], 'shell');
  await until(() => sh.images.filter(Boolean).some((i) => i.docId !== -1 && i.name), 'single plane loaded');
  const img = sh.images.filter(Boolean).pop();
  assert.equal(img.bitDepth, 8, 'a single plane opens as 8-bit');
  assert.ok(t.log.dialogSpecs[0].fields.some((f) => f.id === 'single'), 'no method question for one plane');
  assert.ok(!t.log.dialogSpecs[0].fields.some((f) => f.id === 'method'));
  // The pixel is the stored voxel of plane index 0 of the session.
  assert.deepEqual(J(await pix(sh, 3, 4)), [value(0, 0, 4, 3), value(1, 0, 4, 3)]);
  t.IJApp.unmount();
}

// ═════════════ 3. cancel of a load, frame lost, unavailable source ═════════════
{
  const t = boot();
  t.log.slow = 40;
  t.script.dialogs.push({ method: 'max', start: 1, stop: D, level: 0 });
  t.IJApp.mount(t.root, { ctx: t.ctx, api: t.api });
  const sh = await until(() => t.shells[0], 'shell');
  await until(() => t.log.blocks >= 1, 'first block read');
  sh.opts.onCancel();
  await until(() => sh.progress.length && sh.progress[sh.progress.length - 1] === null && t.log.session.released >= 1, 'cancel settles');
  assert.equal(cmdOf(sh, 'fileSaveTiff').enabled(sh.opts.getState()), false, 'nothing loaded after a cancel');
  assert.ok(sh.status.some((s) => /Cancelled/.test(s)), 'the status says it was cancelled');
  t.IJApp.unmount();
}
{
  const t = boot();
  t.log.frameLost = true;
  t.script.dialogs.push({ method: 'max', start: 1, stop: D, level: 0 });
  t.IJApp.mount(t.root, { ctx: t.ctx, api: t.api });
  const sh = await until(() => t.shells[0], 'shell');
  await until(() => t.script.asks.some((a) => /changed while it was being read/.test(a.message || '')), 'frame-lost sentence shown');
  const msg = t.script.asks.find((a) => /changed while/.test(a.message)).message;
  assert.ok(!/STUDIO_FRAME_LOST|Error/.test(msg), 'no technical text reaches the user');
  assert.equal(t.log.session.released >= 1, true);
  t.IJApp.unmount();
}
{
  const t = boot();
  t.desc.available = false; t.desc.reasonKey = 'studioAdvanced.needAxisPlane';
  t.IJApp.mount(t.root, { ctx: t.ctx, api: t.api });
  const sh = await until(() => t.shells[0], 'shell');
  await sleep(50);
  assert.equal(sh.images.filter(Boolean).length, 0, 'nothing loads without a readable figure');
  assert.equal(cmdOf(sh, 'stackProject').enabled(sh.opts.getState()), false, 'Z Project is off when the figure is not readable');
  t.IJApp.unmount();
}

// ═════════════ 4. worker crash → recovery offered ═════════════
{
  const t = boot();
  t.script.dialogs.push({ method: 'max', start: 1, stop: D, level: 0 });
  t.IJApp.mount(t.root, { ctx: t.ctx, api: t.api });
  const sh = await until(() => t.shells[0], 'shell');
  await until(() => sh.images.filter(Boolean).some((i) => i.docId !== -1 && i.name), 'loaded');
  const askCount = t.script.asks.length;
  t.script.nextAsk = 'later';
  t.workers[0].crash();
  await until(() => t.workers.length === 2, 'a new worker starts');
  await until(() => t.script.asks.length > askCount, 'recovery offered');
  assert.ok(/calculation engine stopped/.test(t.script.asks[askCount].title), 'the crash dialog names the engine, not an error');
  assert.equal(cmdOf(sh, 'editInvert').enabled(sh.opts.getState()), false, 'no document after the crash until recovered');
  t.IJApp.unmount();
}

console.log('ij app flow: OK');
process.exit(0);
