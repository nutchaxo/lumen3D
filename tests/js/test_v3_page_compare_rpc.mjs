// The Compare page asks its panels (DOCS: CLAUDE.md §3.4) — it never calls into
// their documents. Covered:
//   • ComparePanelRpc (compare-policy.js): request ids, the expected answer type, the
//     answer accepted only from the panel asked and only once, ok:false → rejection,
//     timeouts, a closed panel rejecting its pending requests, an unreachable panel;
//   • the panel side of both pages (the REAL _answerHostRequest of viewer.js and of
//     2d.js, lifted with their helpers): REQUEST_CAPTURE snapshots the view in the very
//     task of the request (the WebGL buffer is not kept) and transfers the bitmap,
//     REQUEST_STUDIO_SLICE hands the picture as a transferred bitmap with the raw
//     channel values and the histograms (no canvas, nothing a structured clone would
//     refuse), REQUEST_WORKSPACE_STATE / REQUEST_CHANNEL_STATE plain data, failures
//     as ok:false;
//   • the round trip through compare.js in a vm: two panels (a volume, a photograph)
//     answering through those real handlers, the workspace state built from their
//     answers, an answer arriving from the wrong panel's window ignored;
//   • compare.js and studio-editor.js no longer reach into a panel's document.
//
// Run: node tests/js/test_v3_page_compare_rpc.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { loadModule, ROOT } from './harness.mjs';

const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const compareSrc = read('js/pages/compare.js');
const viewerSrc = read('js/pages/viewer.js');
const page2dSrc = read('js/pages/2d.js');
const studioSrc = read('js/components/studio-editor.js');
const flush = () => new Promise(r => setImmediate(r));

function liftFrom(src, name, file) {
  const m = src.match(new RegExp(`\\n  (?:async )?function ${name}\\([^\\n]*\\) \\{\\n[\\s\\S]*?\\n  \\}\\n`));
  assert.ok(m, `${name} must be defined at module level in ${file}`);
  return m[0];
}

// ── No reaching into a panel's document ───────────────────────────────────────────
{
  const code = compareSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.ok(!/\bViewerApp\b/.test(code), 'compare.js never names ViewerApp');
  assert.ok(!/\bApp2D\b/.test(code), 'compare.js never names App2D');
  assert.ok(!/contentWindow\s*\??\.\s*(?:ViewerApp|App2D|VolumeSlicer|VolumeViewer)/.test(code), 'compare.js calls nothing through contentWindow');
  // What compare.js still does with a frame's window: post to it, compare it to an
  // event's source, nudge it to re-layout, and tell about:blank from the page.
  const uses = Array.from(code.matchAll(/contentWindow\??\.?(\w+)?/g), m => m[1] || '');
  for (const u of uses) assert.ok(['', 'postMessage', 'dispatchEvent', 'location'].includes(u), `compare.js uses contentWindow.${u}`);
  assert.ok(!/contentWindow\s*\??\.\s*(?:ViewerApp|VolumeSlicer)/.test(studioSrc), 'studio-editor.js calls nothing through a panel frame');
  console.log('compare.js / studio-editor.js do not reach into the panels: OK');
}

// ── ComparePanelRpc ───────────────────────────────────────────────────────────────
const timers = [];
const fakeTimers = {
  setTimeout: (fn, ms) => { const t = { fn, ms, live: true }; timers.push(t); return t; },
  clearTimeout: (t) => { if (t) t.live = false; }
};
const Rpc = loadModule('js/pages/compare-policy.js', 'ComparePanelRpc');
{
  const sent = [];
  const rpc = Rpc.create({ post: (key, msg) => { if (key === 'gone') return false; sent.push({ key, msg }); return true; }, timeoutMs: 1000, ...fakeTimers });
  // Request → its answer, by id, from the panel asked.
  const p = rpc.request('0', 'REQUEST_WORKSPACE_STATE');
  const { msg } = sent.at(-1);
  assert.equal(msg.type, 'REQUEST_WORKSPACE_STATE');
  assert.match(msg.requestId, /^r[0-9a-z]+-\d+$/);
  assert.equal(rpc.pending(), 1);
  assert.equal(rpc.settle('1', { type: 'WORKSPACE_STATE', requestId: msg.requestId, ok: true }), false, 'another panel cannot answer it');
  assert.equal(rpc.settle('0', { type: 'CAPTURE', requestId: msg.requestId, ok: true }), false, 'nor an answer of another kind');
  assert.equal(rpc.settle('0', { type: 'WORKSPACE_STATE', ok: true }), false, 'nor one without its id');
  assert.equal(rpc.settle('0', { type: 'WORKSPACE_STATE', requestId: msg.requestId, ok: true, state: { a: 1 } }), true);
  assert.deepEqual((await p).state, { a: 1 });
  assert.equal(rpc.settle('0', { type: 'WORKSPACE_STATE', requestId: msg.requestId, ok: true }), false, 'answered once');
  assert.equal(rpc.pending(), 0);
  // ok:false rejects with the panel's error.
  const q = rpc.request(3, 'REQUEST_CAPTURE');
  rpc.settle('3', { type: 'CAPTURE', requestId: sent.at(-1).msg.requestId, ok: false, error: 'nothing to capture' });
  await assert.rejects(q, (e) => e.code === 'COMPARE_PANEL_ERROR' && /nothing to capture/.test(e.message));
  // Timeout.
  const r = rpc.request('0', 'REQUEST_STUDIO_SLICE', {}, { timeoutMs: 5000 });
  const timer = timers.filter(t => t.live).at(-1);
  assert.equal(timer.ms, 5000, 'the per-request timeout');
  timer.fn();
  await assert.rejects(r, (e) => e.code === 'COMPARE_TIMEOUT');
  assert.equal(rpc.settle('0', { type: 'STUDIO_SLICE', requestId: sent.at(-1).msg.requestId, ok: true }), false, 'a late answer is dropped');
  // A closed panel rejects what it still owed; an unreachable one at once.
  const s1 = rpc.request('2', 'REQUEST_CHANNEL_STATE');
  const s2 = rpc.request('2', 'REQUEST_CAPTURE');
  const other = rpc.request('5', 'REQUEST_CAPTURE');
  rpc.dropPanel('2');
  await assert.rejects(s1, (e) => e.code === 'COMPARE_UNREACHABLE');
  await assert.rejects(s2, (e) => e.code === 'COMPARE_UNREACHABLE');
  assert.equal(rpc.pending(), 1, 'the other panel\'s request is untouched');
  rpc.settle('5', { type: 'CAPTURE', requestId: sent.at(-1).msg.requestId, ok: true });
  await other;
  await assert.rejects(rpc.request('gone', 'REQUEST_CAPTURE'), (e) => e.code === 'COMPARE_UNREACHABLE');
  await assert.rejects(rpc.request('0', 'REQUEST_EVERYTHING'), (e) => e.code === 'COMPARE_BAD_REQUEST');
  assert.equal(rpc.pending(), 0);
  // Every request type has its answer type, handled by compare.js.
  for (const [req, ans] of Object.entries(Rpc.ANSWER_OF)) {
    assert.ok(compareSrc.includes(`'${req}'`), `compare.js sends ${req}`);
    assert.ok(compareSrc.includes(`case '${ans}':`), `compare.js routes ${ans}`);
    for (const [name, src] of [['viewer.js', viewerSrc], ['2d.js', page2dSrc]]) {
      assert.ok(src.includes(`'${req}'`), `${name} answers ${req}`);
      assert.ok(src.includes(`type: '${ans}', requestId`), `${name} sends ${ans} with the requestId`);
    }
  }
  console.log('ComparePanelRpc: ids, answer type, panel identity, once, errors, timeouts, closed panels: OK');
}

// ── The panel side: viewer.js ─────────────────────────────────────────────────────
/** A canvas whose pixels last only for the task that drew them (a WebGL view). */
function volatileCanvas(w, h) {
  const c = { width: w, height: h, fresh: true, nodeType: 1 };
  queueMicrotask(() => { c.fresh = false; });
  return c;
}
function makeImageApi(log) {
  return async function createImageBitmap(canvas) {
    // The copy is taken at the call: a canvas already cleared yields an empty bitmap.
    log.push({ fresh: canvas.fresh !== false });
    return { width: canvas.width, height: canvas.height, blank: canvas.fresh === false, close() {} };
  };
}

function viewerPanel({ sliceResult, captureCanvas, state, channels, histograms, initialized = true } = {}) {
  const posted = [];
  const bitmaps = [];
  const body = `
    const _isIframe = true;
    const _panelIndex = '1';
    let _isInitialized = env.initialized;
    function getCaptureCanvas() { return env.captureCanvas ? env.captureCanvas() : null; }
    function getCurrentSliceResult() { return env.sliceResult ? env.sliceResult() : null; }
    function _getWorkspaceState() { return env.state; }
    function getChannelState() { return env.channels; }
    ${['_postToHost', '_plainForHost', '_sliceResultForHost', '_answerHostRequest'].map(n => liftFrom(viewerSrc, n, 'viewer.js')).join('\n')}
    return { answer: _answerHostRequest };
  `;
  const win = { parent: { postMessage: (message, origin, transfer) => posted.push({ message, origin, transfer: transfer || [] }) } };
  const page = new Function('env', 'window', 'Utils', 'VolumeViewer', 'createImageBitmap', body)(
    { sliceResult, captureCanvas, state, channels, initialized },
    win, { trustedTargetOrigin: () => 'https://lab.example' }, { getChannelHistograms: () => histograms || null }, makeImageApi(bitmaps)
  );
  return { page, posted, bitmaps };
}

function photoPanel({ meta = { name: 'photo', pixelSizeUm: { x: 2 } }, canvas = { width: 640, height: 480 } } = {}) {
  const posted = [];
  const bitmaps = [];
  const body = `
    const _panelIndex = '2';
    let _meta = env.meta;
    const Viewer2D = { getCanvas: () => env.canvas };
    function _studioSliceResult() { return _meta ? { canvas: env.canvas, width: 640, height: 480, source: '2d', pixelSizeUm: { x: 2, y: 2 }, calibrated: true, dataset: _meta, channelState: [] } : null; }
    function _getWorkspaceState() { return { viewer: { view: { scale: 2 } } }; }
    ${['_postToHost', '_answerHostRequest'].map(n => liftFrom(page2dSrc, n, '2d.js')).join('\n')}
    return { answer: _answerHostRequest };
  `;
  const win = { parent: { postMessage: (message, origin, transfer) => posted.push({ message, origin, transfer: transfer || [] }) } };
  const page = new Function('env', 'window', 'Utils', 'createImageBitmap', body)(
    { meta, canvas }, win, { trustedTargetOrigin: () => 'https://lab.example' }, makeImageApi(bitmaps));
  return { page, posted, bitmaps };
}

/** A message as postMessage would carry it: structured-cloneable once its transfers are set aside. */
function assertCloneable(entry, label) {
  const strip = (v) => {
    if (entry.transfer.includes(v)) return null;
    if (Array.isArray(v)) return v.map(strip);
    if (v && typeof v === 'object' && !ArrayBuffer.isView(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, strip(x)]));
    return v;
  };
  assert.doesNotThrow(() => structuredClone(strip(entry.message)), `${label}: structured-cloneable`);
  assert.equal(entry.origin, 'https://lab.example', `${label}: never the wildcard origin`);
}

{
  const raw = { data: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), width: 2, height: 1, channels: 4, projected: true, coverage: false, coverageMask: new Uint8Array([255, 0]) };
  const v = viewerPanel({
    captureCanvas: () => volatileCanvas(800, 600),
    sliceResult: () => ({
      canvas: { width: 300, height: 200 }, width: 300, height: 200, raw, renderRes: 1536, cropRect: { x: 1, y: 2, x2: 300, y2: 201, renderRes: 1536 },
      planeSpec: { mode: 'xy', value: 0.5 }, pixelSizeUm: { x: 0.5, y: 0.5 }, channelState: [{ name: 'DAPI', enabled: true, onChange() {} }], quality: 'high'
    }),
    state: { viewer: { cache: { n: 1 }, zstackSlice: 4 }, plugins: { fn: undefined } },
    channels: [{ name: 'DAPI' }, { name: 'GFP' }],
    histograms: [[1, 2, 3], [4, 5, 6]]
  });
  // Capture: snapshotted while the view is still drawn (same task), bitmap transferred.
  assert.equal(v.page.answer({ type: 'REQUEST_CAPTURE', requestId: 'a1' }), true);
  assert.deepEqual(v.bitmaps, [{ fresh: true }], 'the bitmap is taken in the task of the request');
  await flush();
  const cap = v.posted.at(-1);
  assert.equal(cap.message.type, 'CAPTURE');
  assert.equal(cap.message.requestId, 'a1');
  assert.equal(cap.message.sourceIndex, '1');
  assert.equal(cap.message.ok, true);
  assert.equal(cap.message.bitmap.blank, false);
  assert.deepEqual(cap.transfer, [cap.message.bitmap], 'the bitmap is transferred, not copied');
  assertCloneable(cap, 'CAPTURE');
  // Studio slice: bitmap + raw + histograms, no canvas, no function.
  v.page.answer({ type: 'REQUEST_STUDIO_SLICE', requestId: 'a2' });
  await flush();
  const sl = v.posted.at(-1);
  assert.equal(sl.message.type, 'STUDIO_SLICE');
  const res = sl.message.result;
  assert.ok(!('canvas' in res), 'no canvas crosses');
  assert.equal(res.bitmap.width, 300);
  assert.deepEqual(sl.transfer, [res.bitmap]);
  assert.ok(res.raw.data instanceof Uint8Array && res.raw.data.length === 8, 'raw values as a typed array');
  assert.deepEqual(Array.from(res.raw.coverageMask), [255, 0], 'with the slab footprint');
  assert.equal(res.raw.projected, true);
  assert.deepEqual(res.histograms, [[1, 2, 3], [4, 5, 6]]);
  assert.deepEqual(res.cropRect, { x: 1, y: 2, x2: 300, y2: 201, renderRes: 1536 });
  assert.deepEqual(res.channelState, [{ name: 'DAPI', enabled: true }], 'functions dropped');
  assertCloneable(sl, 'STUDIO_SLICE');
  // States.
  v.page.answer({ type: 'REQUEST_WORKSPACE_STATE', requestId: 'a3' });
  assert.deepEqual(v.posted.at(-1).message.state, { viewer: { cache: { n: 1 }, zstackSlice: 4 }, plugins: {} });
  v.page.answer({ type: 'REQUEST_CHANNEL_STATE', requestId: 'a4' });
  assert.deepEqual(v.posted.at(-1).message.channels, [{ name: 'DAPI' }, { name: 'GFP' }]);
  v.posted.slice(-2).forEach(e => assertCloneable(e, e.message.type));
  // Nothing to show / no id / not a request.
  const none = viewerPanel({});
  none.page.answer({ type: 'REQUEST_CAPTURE', requestId: 'b1' });
  none.page.answer({ type: 'REQUEST_STUDIO_SLICE', requestId: 'b2' });
  assert.deepEqual(none.posted.map(e => [e.message.type, e.message.ok]), [['CAPTURE', false], ['STUDIO_SLICE', false]]);
  assert.equal(none.page.answer({ type: 'REQUEST_CAPTURE' }), true, 'a request without an id is swallowed');
  assert.equal(none.posted.length, 2, '… unanswered');
  assert.equal(none.page.answer({ type: 'SYNC_Z', value: 1 }), false, 'other messages go on to the page');
  assert.equal(none.page.answer({ type: 'REQUEST_SCREENSHOT' }), false, 'the thumbnail request keeps its own handler');
  const early = viewerPanel({ initialized: false, state: { a: 1 } });
  early.page.answer({ type: 'REQUEST_WORKSPACE_STATE', requestId: 'c1' });
  assert.equal(early.posted.at(-1).message.state, null, 'no state before the page is up');
  console.log('viewer.js answers the host: capture in-task + transferred, Studio slice with raw/histograms, states: OK');
}

// ── The panel side: 2d.js ─────────────────────────────────────────────────────────
{
  const p = photoPanel();
  p.page.answer({ type: 'REQUEST_CAPTURE', requestId: 'p1' });
  p.page.answer({ type: 'REQUEST_STUDIO_SLICE', requestId: 'p2' });
  p.page.answer({ type: 'REQUEST_WORKSPACE_STATE', requestId: 'p3' });
  p.page.answer({ type: 'REQUEST_CHANNEL_STATE', requestId: 'p4' });
  await flush();
  const byType = Object.fromEntries(p.posted.map(e => [e.message.type, e]));
  assert.equal(byType.CAPTURE.message.bitmap.width, 640);
  assert.deepEqual(byType.CAPTURE.transfer, [byType.CAPTURE.message.bitmap]);
  const sr = byType.STUDIO_SLICE.message.result;
  assert.ok(!('canvas' in sr) && sr.bitmap.width === 640 && sr.raw === null && sr.dataset.name === 'photo');
  assert.deepEqual(byType.STUDIO_SLICE.transfer, [sr.bitmap]);
  assert.deepEqual(byType.WORKSPACE_STATE.message.state, { viewer: { view: { scale: 2 } } });
  assert.deepEqual(byType.CHANNEL_STATE.message.channels, [], 'a photograph has no channel to decompose');
  Object.values(byType).forEach(e => { assertCloneable(e, `2d ${e.message.type}`); assert.equal(e.message.sourceIndex, '2'); });
  const unmounted = photoPanel({ meta: null });
  unmounted.page.answer({ type: 'REQUEST_STUDIO_SLICE', requestId: 'q1' });
  unmounted.page.answer({ type: 'REQUEST_WORKSPACE_STATE', requestId: 'q2' });
  assert.deepEqual(unmounted.posted.map(e => [e.message.type, e.message.ok, e.message.state ?? null]), [['STUDIO_SLICE', false, null], ['WORKSPACE_STATE', true, null]]);
  console.log('2d.js answers the host: OK');
}

// ── Round trip through compare.js (vm) with both real panel handlers ─────────────────
{
  const ORIGIN = 'https://lab.example';
  const handlers = [];
  const proxy = (extra = {}) => new Proxy(function () {}, {
    get(t, k) {
      if (k in extra) return extra[k];
      if (k === 'dataset') return (extra.dataset ||= {});
      if (k === 'style') return {};
      if (k === 'classList') return { add() {}, remove() {}, toggle() {}, contains: () => false };
      if (k === 'querySelectorAll') return () => [];
      if (k === 'getBoundingClientRect') return () => ({ left: 0, top: 0, width: 100, height: 100, right: 100, bottom: 100 });
      if (k === Symbol.toPrimitive) return () => '';
      return proxy();
    },
    set(t, k, v) { extra[k] = v; return true; },
    apply: () => proxy()
  });
  const frames = [];
  const panelsOf = [];
  const responders = [];
  let foreign = null;      // when set, answers are posted from this window instead of the panel's
  const makeFrame = () => {
    const frame = { dataset: {}, title: '', addEventListener() {}, removeEventListener() {} };
    const win = {
      postMessage: (m) => {
        const i = frames.indexOf(frame);
        const responder = responders[i];
        if (!responder || typeof m.type !== 'string' || !m.type.startsWith('REQUEST_')) return;
        responder.page.answer(m);
        setImmediate(() => {
          for (const e of responder.posted.splice(0)) {
            ctx.CompareApp._handleIframeMessage({ origin: ORIGIN, source: foreign || win, data: { ...e.message, sourceIndex: panelsOf[i].index } });
          }
        });
      }
    };
    frame.contentWindow = win;
    return frame;
  };
  const makeEl = () => proxy({
    querySelector: (sel) => {
      if (sel === 'iframe.viewer-frame') { const fr = makeFrame(); frames.push(fr); return fr; }
      return proxy({ addEventListener() {} });
    },
    remove() {}
  });
  const sandbox = {
    console: { ...console, warn() {} }, setTimeout, clearTimeout, setImmediate,
    requestAnimationFrame: (fn) => fn(),
    window: { location: { origin: ORIGIN }, addEventListener() {}, postMessage() {} },
    document: {
      addEventListener() {}, querySelector: () => null, querySelectorAll: () => [],
      getElementById: () => proxy(),
      createElement: () => makeEl(), body: { appendChild() {} }
    },
    Catalog: { getById: (id) => ({ id, type: id === 'P' ? '2d' : '3d', name: id }) },
    I18n: { t: (k) => k }, Theme: { isDark: () => true }, InstanceConfig: { get: (k, d) => d },
    Event: class {}, URLSearchParams, JSON, Date, Math, Number, String, Object, Array, Promise, Map, Set
  };
  const ctx = vm.createContext(sandbox);
  vm.runInContext(read('js/core/utils.js') + '\n;globalThis.Utils = Utils;', ctx);
  vm.runInContext(read('js/pages/compare-policy.js'), ctx);
  vm.runInContext(compareSrc + '\n;globalThis.CompareApp = CompareApp;', ctx, { filename: 'compare.js' });
  const App = ctx.CompareApp;
  const vol = App.addPanel('V'), photo = App.addPanel('P');
  panelsOf.push(vol, photo);
  responders.push(
    viewerPanel({ state: { viewer: { cache: { bricks: 9 }, zstackSlice: 7 } }, channels: [{ name: 'a' }, { name: 'b' }] }),
    photoPanel()
  );
  const ready = (panel, type) => App._handleIframeMessage({
    origin: ORIGIN, source: panel.iframe.contentWindow,
    data: { type: 'PANEL_READY', sourceIndex: panel.index, name: panel.id, datasetType: type, toolbar: { tools: [], toggles: [] }, features: {}, quality: '512x512' }
  });
  assert.equal(App.getWorkspaceState(), null, 'no workspace before the panels are up');
  ready(vol, '3d');
  ready(photo, '2d');
  await flush(); await flush();
  const ws = App.getWorkspaceState();
  assert.ok(ws, 'the workspace, from the panels\' answers');
  assert.deepEqual(JSON.parse(JSON.stringify(ws.compare.iframeStates)), [{ viewer: { zstackSlice: 7 } }, { viewer: { view: { scale: 2 } } }], 'each panel\'s own state, brick cache dropped');
  assert.equal(ws.compare.panelZstackStates[0].slice, 7);
  // An answer from a window that is not the panel's own never settles its request.
  responders[0] = viewerPanel({ state: { viewer: { zstackSlice: 99 } } });
  foreign = { postMessage() {} };
  App.getWorkspaceState();
  await flush(); await flush();
  assert.equal(App.getWorkspaceState().compare.panelZstackStates[0].slice, 7, 'a foreign window\'s answer is ignored');
  foreign = null;
  // Closing the panels rejects what they still owed (no timer left behind).
  App.removePanel(vol.index);
  App.removePanel(photo.index);
  console.log('compare.js ⇄ panels round trip (workspace state, panel identity): OK');
}

// Transferred pictures nobody waits for are released (an answer after its timeout, a
// duplicate, the answer of a panel closed meanwhile), and a canvas made from a bitmap
// closes it whatever happens.
{
  const lift = (name) => {
    const m = compareSrc.match(new RegExp(`\\n  function ${name}\\([^\\n]*\\) \\{\\n[\\s\\S]*?\\n  \\}\\n`));
    assert.ok(m, name);
    return m[0];
  };
  const doc = { createElement: () => ({ width: 0, height: 0, getContext: () => ({ drawImage() {} }) }) };
  const f = new Function('document', `${lift('_closeBitmap')}${lift('_releaseAnswer')}${lift('_canvasFromBitmap')} return { _releaseAnswer, _canvasFromBitmap };`)(doc);
  const bmp = (w = 4, h = 3) => ({ width: w, height: h, closed: 0, close() { this.closed++; } });
  const a = bmp(); f._releaseAnswer({ type: 'CAPTURE', bitmap: a });
  assert.equal(a.closed, 1, 'a late CAPTURE closes its bitmap');
  const b = bmp(); f._releaseAnswer({ type: 'STUDIO_SLICE', result: { bitmap: b } });
  assert.equal(b.closed, 1, 'a late STUDIO_SLICE closes its bitmap');
  f._releaseAnswer({ type: 'WORKSPACE_STATE', state: {} });
  const c = bmp(); assert.ok(f._canvasFromBitmap(c)); assert.equal(c.closed, 1);
  const d = bmp(0, 0); assert.equal(f._canvasFromBitmap(d), null); assert.equal(d.closed, 1, 'an empty bitmap is released too');
  assert.match(compareSrc, /if \(!_rpc\.settle\(panel\.index, data\)\) _releaseAnswer\(data\);/, 'unsettled answers are released');
  assert.match(compareSrc, /if \(!panel\) \{ _releaseAnswer\(data\); return; \}/, 'answers of a closed panel are released');
  console.log('Compare releases pictures nobody waits for: OK');
}

console.log('Compare request / response protocol: OK');
