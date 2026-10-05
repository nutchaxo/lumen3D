// Viewer2D behaviour that does not need a browser: the wheel in every deltaMode,
// the calibration contract (an uncalibrated photograph has no physical view),
// adjustment sanitising, the native-image failure state, and the processing
// pipeline's coalescing (only the newest request starts while one is running).
//
// Run: node tests/js/test_pages_viewer2d.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT } from './harness.mjs';

const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');

function boot({ withWorker = false } = {}) {
  const listeners = {};
  const ctx2d = new Proxy({}, { get: (t, k) => (k in t ? t[k] : () => ({ width: 10 })), set: (t, k, v) => { t[k] = v; return true; } });
  const canvas = {
    width: 0, height: 0, clientWidth: 800, clientHeight: 600,
    getContext: () => ctx2d,
    addEventListener: (type, fn) => { listeners[type] = fn; },
    getBoundingClientRect: () => ({ left: 0, top: 0 }),
    setPointerCapture() {},
    parentElement: {},
    toBlob: (cb) => cb({ size: 1 })
  };
  const images = [];
  class FakeImage {
    constructor() { this.complete = false; this.naturalWidth = 0; this.naturalHeight = 0; images.push(this); }
    removeAttribute(name) { if (name === 'src') { this.src = null; this.aborted = true; } }
    decode() {
      return new Promise((resolve, reject) => { this._settle = (ok, w = 640) => { this.naturalWidth = w; this.naturalHeight = w * 0.75; this.complete = true; ok ? resolve() : reject(new Error('decode')); }; });
    }
  }
  const frames = [];
  const jobs = [];
  class FakeWorker {
    constructor() { this.onmessage = null; FakeWorker.last = this; }
    postMessage(msg) { jobs.push(msg); }
    terminate() {}
  }
  const sandbox = {
    console, setTimeout, clearTimeout, Image: FakeImage, Math, Number, Object, Promise, JSON, Map, Set, Array,
    window: { devicePixelRatio: 1 },
    document: { createElement: () => ({ getContext: () => ctx2d, width: 0, height: 0 }) },
    ResizeObserver: class { observe() {} disconnect() {} },
    requestAnimationFrame: (fn) => { frames.push(fn); return frames.length; },
    getComputedStyle: () => ({ backgroundColor: '#123' }),
    ToolManager: { current: () => 'navigate' }
  };
  if (withWorker) {
    sandbox.Worker = FakeWorker;
    sandbox.OffscreenCanvas = class {};
    sandbox.createImageBitmap = async (img) => ({ width: img.naturalWidth, height: img.naturalHeight, close() {} });
  }
  const ctx = vm.createContext(sandbox);
  vm.runInContext(read('js/workers/pixel-ops-2d.js') + '\n;globalThis.PixelOps2D = PixelOps2D;', ctx);
  vm.runInContext(read('js/viewers/2d-viewer.js') + '\n;globalThis.__V = Viewer2D;', ctx, { filename: '2d-viewer.js' });
  const V = ctx.__V;
  V.init(canvas);
  return { V, canvas, listeners, images, frames, jobs, FakeWorker, ctx };
}

const flush = () => new Promise(r => setImmediate(r));

// ── wheel: pixels, lines and pages all zoom by a sensible amount ──
{
  const { V, listeners } = boot();
  V.load({ previewUrl: 'p', nativeUrl: 'n', width: 4000, height: 3000, pixelSizeUm: 2 });
  const scaleAfter = (event) => {
    V.fit();
    const before = V.getView().scale;
    listeners.wheel({ preventDefault() {}, clientX: 400, clientY: 300, ...event });
    return V.getView().scale / before;
  };
  const pixel = scaleAfter({ deltaY: -100, deltaMode: 0 });
  const line = scaleAfter({ deltaY: -3, deltaMode: 1 });
  assert.ok(Math.abs(pixel - 1.1) < 1e-9, 'one pixel-mode notch (100) is the documented 10 %');
  assert.ok(line > 1.09 && line < 1.11, `a Firefox line-mode notch (3 lines) zooms like a notch, not 0.3 % (${line})`);
  assert.ok(scaleAfter({ deltaY: -100000, deltaMode: 0 }) < 1.4, 'one event never zooms by more than three notches');
}

// ── calibration: no pixel size, no physical view, no scale ──
{
  const { V } = boot();
  V.load({ previewUrl: 'p', nativeUrl: 'n', width: 4000, height: 3000, pixelSizeUm: null });
  assert.equal(V.getPixelSizeUm(), null);
  assert.equal(V.getPhysicalView(), null, 'an uncalibrated photograph has no physical view to share');
  const before = V.getView();
  V.setPhysicalView({ umPerCss: 3, centerUm: { x: 10, y: 10 } });
  assert.deepEqual(V.getView(), before, 'and ignores one it is given');
  assert.equal(V.getPhysicalCalibration().calibrationStatus, 'metadata-missing');

  const cal = boot().V;
  cal.load({ previewUrl: 'p', nativeUrl: 'n', width: 4000, height: 3000, pixelSizeUm: 2 });
  const pv = cal.getPhysicalView();
  assert.ok(pv && pv.umPerCss > 0);
  cal.setPhysicalView(pv);
  assert.ok(Math.abs(cal.getPhysicalView().umPerCss - pv.umPerCss) < 1e-9, 'the physical view round-trips');
}

// ── views and adjustments from files are input ──
{
  const { V } = boot();
  V.load({ previewUrl: 'p', nativeUrl: 'n', width: 4000, height: 3000, pixelSizeUm: 2 });
  V.setView({ scale: 1e9, tx: 0, ty: 0 });
  assert.ok(V.getView().scale <= 32, 'a crazy zoom is clamped to the wheel range');
  V.setAdjustments({ gamma: 'x', brightness: NaN, contrast: 500, bogus: 1, wbRed: Infinity });
  const a = V.getAdjustments();
  assert.equal(a.gamma, 1, 'a non-number is ignored');
  assert.equal(a.brightness, 0);
  assert.equal(a.contrast, 100, 'an excess is clamped');
  assert.equal(a.wbRed, 1);
  assert.equal('bogus' in a, false, 'unknown keys are dropped');
  V.setAdjustments({ contrast: 0 });
  assert.equal(V.getAdjustments().contrast, 0);
}

// ── load states: a native failure under a visible preview is its own state ──
{
  const { V, images } = boot();
  const states = [];
  V.onLoadState(s => states.push(s));
  const loaded = V.load({ previewUrl: 'p', nativeUrl: 'n', width: 4000, height: 3000, pixelSizeUm: 2 });
  loaded.catch(() => {});
  images[0]._settle(true, 640);
  await flush();
  images[1]._settle(false);
  await loaded.catch(() => {});
  assert.deepEqual(states, ['loading', 'preview', 'nativeError']);

  // A superseded load aborts its transfers and is not reported.
  const second = boot();
  const s2 = [];
  second.V.onLoadState(s => s2.push(s));
  second.V.load({ previewUrl: 'p1', nativeUrl: 'n1', width: 100, height: 100, pixelSizeUm: 1 }).catch(() => {});
  second.V.load({ previewUrl: 'p2', nativeUrl: 'n2', width: 100, height: 100, pixelSizeUm: 1 }).catch(() => {});
  assert.ok(second.images.slice(0, 2).every(i => i.aborted), 'the first photograph\'s requests are cancelled');

  // Stepping through a collection holds the native request back.
  const held = boot();
  held.V.load({ previewUrl: 'p', nativeUrl: 'n', width: 100, height: 100, pixelSizeUm: 1, deferNative: true }).catch(() => {});
  assert.equal(held.images.length, 1, 'only the preview is requested until the key settles');
  held.V.load({ previewUrl: 'p2', nativeUrl: 'n2', width: 100, height: 100, pixelSizeUm: 1, deferNative: true }).catch(() => {});
  await new Promise(r => setTimeout(r, 260));
  assert.equal(held.images.length, 3, 'the abandoned photograph never asked for its native image; the settled one did');
}

// ── processing: one job at a time, the newest request wins, old results are dropped ──
{
  const { V, images, jobs, FakeWorker, frames } = boot({ withWorker: true });
  V.load({ previewUrl: 'p', nativeUrl: 'n', width: 640, height: 480, pixelSizeUm: 2 }).catch(() => {});
  images[0]._settle(true, 640);
  await flush();
  const runFrames = () => { while (frames.length) frames.shift()(); };
  runFrames();
  V.setAdjustments({ brightness: 10 });
  runFrames();
  await flush();
  assert.equal(jobs.length, 1, 'the first adjustment starts one job');
  for (const b of [20, 30, 40, 50]) { V.setAdjustments({ brightness: b }); runFrames(); }
  await flush();
  assert.equal(jobs.length, 1, 'a slider drag does not queue a job per tick');
  // Answer the first job: the newest request (50) is the next and only one.
  const closed = [];
  FakeWorker.last.onmessage({ data: { id: jobs[0].id, bitmap: { width: 640, height: 480, close() { closed.push(1); } } } });
  await flush();
  await flush();
  assert.equal(jobs.length, 2, 'then exactly one more job starts');
  assert.equal(jobs[1].job.adjust.brightness, 50, 'and it carries the newest value');
  FakeWorker.last.onmessage({ data: { id: jobs[1].id, bitmap: { width: 640, height: 480, close() {} } } });
  await V.whenProcessed();
  assert.equal(closed.length, 1, 'the superseded rendering is released');

  // Disabling the adjustments frees the processed copy.
  V.setAdjustments({ brightness: 0 });
  runFrames();
}

// ── dispose with a job in flight: the processing loop is released ──
{
  const { V, images, jobs, frames } = boot({ withWorker: true });
  V.load({ previewUrl: 'p', nativeUrl: 'n', width: 640, height: 480, pixelSizeUm: 2 }).catch(() => {});
  images[0]._settle(true, 640);
  await flush();
  const runFrames = () => { while (frames.length) frames.shift()(); };
  runFrames();
  V.setAdjustments({ brightness: 10 });
  runFrames();
  await flush();
  assert.equal(jobs.length, 1, 'a job is in the (terminated) worker');
  const warn = console.warn; console.warn = () => {};
  V.dispose();
  const settled = await Promise.race([V.whenProcessed().then(() => true), new Promise(r => setTimeout(() => r(false), 200))]);
  console.warn = warn;
  assert.equal(settled, true, 'disposing settles the calls of the terminated worker');
}

// ── static guards ──
{
  const viewer = read('js/viewers/2d-viewer.js');
  assert.ok(!/getImageData\([^)]*\)[\s\S]{0,400}for \(let y = 0, i = 0/.test(viewer), 'no per-pixel loop is left in the viewer');
  assert.ok(!viewer.includes('getComputedStyle(_container).backgroundColor || \'#000\';\n    _ctx.fillRect'), 'the backdrop colour is not read per frame');
  assert.ok(read('2d.html').indexOf('pixel-ops-2d.js') < read('2d.html').indexOf('2d-viewer.js'), '2d.html loads the pixel ops before the viewer');
}

console.log('Viewer2D: OK');
