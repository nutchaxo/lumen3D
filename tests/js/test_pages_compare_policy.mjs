// The Compare page's decisions that do not need a browser: the shared quality
// budget, the time-sync echo guard, what a closed panel leaves behind, and the
// workspace of a comparison with a failed panel.
//
// Run: node tests/js/test_pages_compare_policy.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT } from './harness.mjs';

const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');
const policyCtx = vm.createContext({ console });
vm.runInContext(read('js/pages/compare-policy.js') + '\n;globalThis.__P = { CompareQuality, CompareTimeSync };', policyCtx, { filename: 'compare-policy.js' });
const { CompareQuality, CompareTimeSync } = policyCtx.__P;

const MB = 1024 * 1024;
const cost = { '512x512': 256 * MB, '1024x1024': 1000 * MB, '2048x2048': 3000 * MB, native: 6000 * MB };

// ── quality budget ──
{
  const two = CompareQuality.plan([
    { key: 'a', quality: '512x512', bytes: cost }, { key: 'b', quality: '512x512', bytes: cost }
  ], 1536 * MB, 0, '1024x1024');
  const levels = [two.get('a'), two.get('b')].sort();
  assert.deepEqual(levels, ['1024x1024', '512x512'], 'two big volumes: one is raised, the budget keeps the other at 512');
  const sum = [...two.values()].reduce((s, q) => s + cost[q], 0);
  assert.ok(sum <= 1536 * MB, `the plan fits the budget (${sum / MB} MB)`);

  const alone = CompareQuality.plan([{ key: 'a', quality: '512x512', bytes: cost }], 64 * 1024 * MB, 0, '1024x1024');
  assert.equal(alone.get('a'), '1024x1024', 'automatic raises stop at the ceiling however large the budget');

  const crowded = CompareQuality.plan([
    { key: 'a', quality: '1024x1024', bytes: cost }, { key: 'b', quality: '1024x1024', bytes: cost },
    { key: 'c', quality: '512x512', bytes: cost }
  ], 1536 * MB, 0, '1024x1024');
  const crowdedSum = [...crowded.values()].reduce((s, q) => s + cost[q], 0);
  assert.ok(crowdedSum <= 1536 * MB, 'a panel added over budget brings the others down');
  assert.ok([...crowded.values()].includes('512x512'));

  const reserved = CompareQuality.plan([{ key: 'a', quality: '512x512', bytes: cost }], 1536 * MB, 1200 * MB, '1024x1024');
  assert.equal(reserved.get('a'), '512x512', 'panels that have not reported yet hold their share back');

  const unpriced = CompareQuality.plan([{ key: 'a', quality: '512x512', bytes: null }], 1536 * MB);
  assert.equal(unpriced.size, 0, 'a panel that reports no prices is left to the count rule');

  const odd = CompareQuality.plan([{ key: 'a', quality: '4096x4096', bytes: cost }], 1536 * MB);
  assert.ok(['512x512', '1024x1024', '2048x2048', 'native'].includes(odd.get('a')), 'a level without a price falls to a priced one');
  assert.equal(CompareQuality.isQuality('1024x1024'), true);
  assert.equal(CompareQuality.isQuality('<script>'), false);
}

// ── time sync: no echo, no rubber band ──
{
  const A = { timeTotal: 100, timeExpect: [] }, B = { timeTotal: 10, timeExpect: [] };
  const now = 1000;
  // A is scrubbed to frame 50 of 100.
  const msg = { value: 50, total: 100, fraction: 50 / 99 };
  assert.equal(CompareTimeSync.isEcho(A, msg, now), false, 'a user action is not an echo');
  const to = CompareTimeSync.relay([A, B], A, msg, now);
  assert.deepEqual(to, [B]);
  assert.equal(B.timeExpect[0].frame, 5, 'B is ordered to frame round(.505 * 9) = 5');
  // B loads 5 and reports it: that is its answer, the host must not send A to 55.
  assert.equal(CompareTimeSync.isEcho(B, { value: 5, total: 10, fraction: 5 / 9 }, now + 200), true);
  assert.equal(B.timeExpect.length, 0, 'the order is consumed');
  // B is then scrubbed by the user to 7: a real action.
  assert.equal(CompareTimeSync.isEcho(B, { value: 7, total: 10, fraction: 7 / 9 }, now + 400), false);

  // Equal lengths: A runs ahead while B is still loading an older frame.
  const P = { timeTotal: 50, timeExpect: [] }, Q = { timeTotal: 50, timeExpect: [] };
  CompareTimeSync.relay([P, Q], P, { value: 20, total: 50, fraction: 20 / 49 }, now);
  CompareTimeSync.relay([P, Q], P, { value: 22, total: 50, fraction: 22 / 49 }, now + 50);
  assert.equal(CompareTimeSync.isEcho(Q, { value: 20, total: 50, fraction: 20 / 49 }, now + 100), true, 'the late report of frame 20 is dropped');
  assert.equal(CompareTimeSync.isEcho(Q, { value: 22, total: 50, fraction: 22 / 49 }, now + 150), true);
  assert.equal(CompareTimeSync.isEcho(Q, { value: 30, total: 50, fraction: 30 / 49 }, now + 200), false);

  // Unknown length: the page never answers a sync with a report, so its next report
  // is the operator's own scrub and must not be swallowed; an old order expires.
  const U = { timeTotal: 0, timeExpect: [] };
  CompareTimeSync.relay([P, U], P, { value: 10, total: 50, fraction: 10 / 49 }, now);
  assert.equal(CompareTimeSync.isEcho(U, { value: 3, total: 12 }, now + 10), false, 'a scrub of a panel of unknown length is relayed');
  CompareTimeSync.relay([P, Q], P, { value: 40, total: 50, fraction: 40 / 49 }, now);
  assert.equal(CompareTimeSync.isEcho(Q, { value: 40, total: 50 }, now + 60000), false, 'an order older than the window is forgotten');
}

// ── the page: bookkeeping around closed / failed panels (compare.js in a stub DOM) ──
{
  const posts = [];
  const timers = [];
  const clicks = [];
  const handlers = new Map();
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
  const makeFrame = (index) => {
    const win = { postMessage: (m) => posts.push({ index, m }), ViewerApp: { getWorkspaceState: () => ({ viewer: { cache: 1 } }) } };
    return { dataset: {}, contentWindow: win, title: '', addEventListener() {}, removeEventListener() {}, win };
  };
  const frames = [];
  const makeEl = () => proxy({
    querySelector: (sel) => {
      if (sel === 'iframe.viewer-frame') { const f = makeFrame(frames.length); frames.push(f); return f; }
      return proxy({ addEventListener() {} });
    },
    remove() {}
  });
  const ORIGIN = 'https://lab.example';
  const sandbox = {
    console, setTimeout: (fn) => { timers.push(fn); return timers.length; }, clearTimeout() {},
    requestAnimationFrame: (fn) => fn(),
    window: { location: { origin: ORIGIN }, addEventListener() {}, postMessage() {} },
    document: {
      addEventListener() {}, querySelector: () => null, querySelectorAll: () => [],
      getElementById: () => proxy(),
      createElement: (tag) => (tag === 'button' ? proxy({ addEventListener: (type, fn) => clicks.push(fn), remove() {} }) : makeEl()), body: { appendChild() {} }
    },
    Catalog: { getById: (id) => ({ id, type: 'live', name: id }) },
    I18n: { t: (k) => k }, Theme: { isDark: () => true }, InstanceConfig: { get: (k, d) => d },
    Event: class {}, URLSearchParams, JSON, Date, Math, Number, String, Object, Array, Promise, Map, Set
  };
  const ctx = vm.createContext(sandbox);
  const utilsSrc = read('js/core/utils.js');
  vm.runInContext(utilsSrc + '\n;globalThis.Utils = Utils;', ctx, { filename: 'utils.js' });
  vm.runInContext(read('js/pages/compare-policy.js') + '\n;globalThis.CompareQuality = CompareQuality; globalThis.CompareTimeSync = CompareTimeSync;', ctx);
  vm.runInContext(read('js/pages/compare.js') + '\n;globalThis.CompareApp = CompareApp;', ctx, { filename: 'compare.js' });
  const App = ctx.CompareApp;
  assert.equal(typeof App.removePanel, 'function', 'a panel can be closed through the API');

  const a = App.addPanel('A'), b = App.addPanel('B');
  assert.ok(a && b);
  const ready = (panel, extra = {}) => App._handleIframeMessage({
    origin: ORIGIN, source: panel.iframe.contentWindow,
    data: { type: 'PANEL_READY', sourceIndex: panel.index, name: panel.id, datasetType: 'live', toolbar: { tools: [], toggles: [] },
      features: { volume: true, timeline: true, photo: false, ...extra.features }, quality: '512x512' }
  });
  const send = (panel, data) => App._handleIframeMessage({ origin: ORIGIN, source: panel.iframe.contentWindow, data: { sourceIndex: panel.index, ...data } });
  const sentTo = (panel, type) => posts.filter(p => p.index === frames.indexOf(panel.iframe) && p.m.type === type);

  // A workspace waits for a panel that is loading, but not for one that failed.
  assert.equal(App.getWorkspaceState(), null, 'panels still loading: no workspace yet');
  ready(a);
  send(b, { type: 'PANEL_ERROR', message: 'boom' });
  const ws = App.getWorkspaceState();
  assert.ok(ws, 'a failed panel does not block the workspace');
  assert.equal(JSON.stringify(ws.compare.panels), '["A","B"]', 'the failed panel stays listed so reopening retries it');
  assert.equal(ws.compare.iframeStates[1], null);

  // Time echo through the real handler.
  const c = App.addPanel('C');
  ready(b, {});  // b recovers (a late PANEL_READY)
  ready(c);
  send(a, { type: 'SYNC_TIME', value: 50, total: 100, fraction: 50 / 99 });
  send(b, { type: 'SYNC_TIME', value: 5, total: 10, fraction: 5 / 9 });   // b's answer (learns its length)
  const toA = sentTo(a, 'SYNC_TIME').length;
  send(c, { type: 'SYNC_TIME', value: 50, total: 100, fraction: 50 / 99 }); // c's own scrub (its length was unknown until now)
  assert.equal(sentTo(a, 'SYNC_TIME').length, toA + 1, 'a scrub of a panel whose length was unknown reaches its siblings');
  // b's length is known now: a's next scrub orders b to frame round(.606 * 9) = 5, and b's report of 5
  // (an older page answering) is not relayed back to a.
  send(a, { type: 'SYNC_TIME', value: 60, total: 100, fraction: 60 / 99 });
  const toA2 = sentTo(a, 'SYNC_TIME').length;
  send(b, { type: 'SYNC_TIME', value: 5, total: 10, fraction: 5 / 9 });
  assert.equal(sentTo(a, 'SYNC_TIME').length, toA2, 'nothing was relayed back to the panel that was scrubbed');

  // What a closed panel shared is not replayed to a new one.
  send(a, { type: 'SYNC_CAMERA', value: { cameraZ: 3 } });
  App.removePanel(a.index);
  App.removePanel(b.index);
  App.removePanel(c.index);
  const d = App.addPanel('D');
  const before = posts.length;
  ready(d);
  const replayed = posts.slice(before).filter(p => p.m.type === 'SYNC_CAMERA');
  assert.equal(replayed.length, 0, 'a new panel opens where nothing stale was left');

  // Retry: the ready timeout of the failed attempt must not fail the new one.
  const e = App.addPanel('E');
  await new Promise(r => setImmediate(r));
  const firstAttemptTimers = timers.splice(0);
  send(e, { type: 'PANEL_ERROR', message: 'boom' });
  assert.equal(e.failed, true);
  assert.ok(clicks.length, 'a failed panel offers a Retry button');
  await new Promise(r => setImmediate(r));   // the failed attempt gives its load slot back
  clicks[clicks.length - 1]();
  await new Promise(r => setImmediate(r));
  assert.equal(e.failed, false, 'retrying clears the failure');
  firstAttemptTimers.forEach(fn => fn());
  assert.equal(e.failed, false, "the first attempt's timeout does not fail the retry");
  timers.splice(0).forEach(fn => fn());
  assert.equal(e.failed, true, "the retry's own timeout still fails it");
}

// ── static guards ──
{
  const compare = read('js/pages/compare.js');
  assert.ok(compare.includes('CompareTimeSync.isEcho') && compare.includes('CompareQuality.plan'), 'compare.js uses the policy module');
  const qualityChange = compare.slice(compare.indexOf("getElementById('compare-quality')?.addEventListener('change'"));
  assert.ok(/qualityFailed = null[\s\S]*_scheduleQuality\(\)/.test(qualityChange.slice(0, 400)),
    'choosing a quality explicitly lets a level that failed earlier be tried again');
  assert.ok(read('compare.html').includes('js/pages/compare-policy.js'), 'compare.html loads the policy module before compare.js');
  assert.ok(read('compare.html').indexOf('compare-policy.js') < read('compare.html').indexOf('js/pages/compare.js'));
}

console.log('compare policy: OK');
