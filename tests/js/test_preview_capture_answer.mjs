// The admin Datasets editor's "set the preview" button (REQUEST_SCREENSHOT →
// SCREENSHOT_RESPONSE), run as written (functions lifted from their sources) against
// scripted stubs:
//   • the 2D page answers it (it had no handler: the button spun forever on a
//     photograph), `not_ready` before the photograph is up, a 512 px picture after;
//   • the volume viewer answers `not_ready` before init() binds its handler, and stays
//     silent once that handler is there (one answer per request);
//   • the admin arms a timeout, gives the button back on a missing answer, ignores an
//     answer to an abandoned request (dataset switched), and shows a sentence, never
//     the page's error code.
//
// Run: node tests/js/test_preview_capture_answer.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT } from './harness.mjs';

const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const viewerSrc = read('js/pages/viewer.js');
const page2dSrc = read('js/pages/2d.js');
const adminSrc = read('js/pages/admin/tab-datasets.js');

/** A function of an IIFE page (two-space indent) or of a module (no indent). */
function lift(src, name, indent = '  ') {
  const m = src.match(new RegExp(`\\n${indent}(?:async )?function ${name}\\([^\\n]*\\) \\{\\n[\\s\\S]*?\\n${indent}\\}\\n`));
  assert.ok(m, `${name} must be defined`);
  return m[0];
}

// ── 1. The 2D page ───────────────────────────────────────────────────────────
{
  const posts = [];
  const errors = [];
  const ctx = vm.createContext({
    posts, errors,
    console: { error: (...a) => errors.push(a) },
    window: { parent: { postMessage: (msg, origin) => posts.push({ msg, origin }) } },
    Utils: { trustedTargetOrigin: () => 'http://host' },
    document: {
      createElement: () => {
        const draws = [];
        return {
          width: 0, height: 0, draws,
          getContext: () => ({ fillRect() {}, drawImage: (...a) => draws.push(a), set fillStyle(v) {} }),
          toDataURL: (type) => `data:${type};base64,AAAA`,
        };
      },
    },
    canvas: null,
  });
  vm.runInContext(`
    let _meta = null, _panelIndex = null;
    const Viewer2D = { getCanvas: () => canvas };
    ${lift(page2dSrc, '_answerScreenshot')}
    globalThis.answer = _answerScreenshot;
    globalThis.setMeta = (m) => { _meta = m; };
  `, ctx);
  ctx.answer({ type: 'REQUEST_SCREENSHOT', requestId: 'r1' });
  assert.equal(posts.length, 1, 'answered before the photograph is up');
  assert.equal(posts[0].msg.type, 'SCREENSHOT_RESPONSE');
  assert.equal(posts[0].msg.success, false);
  assert.equal(posts[0].msg.error, 'not_ready', 'with a code the admin turns into a sentence');
  assert.equal(posts[0].msg.requestId, 'r1', 'the request id is echoed');
  assert.equal(posts[0].origin, 'http://host', 'to the page origin, never "*"');

  ctx.setMeta({ id: '2d/a' });
  ctx.canvas = { width: 1600, height: 800 };
  ctx.answer({ type: 'REQUEST_SCREENSHOT', requestId: 'r2' });
  const ok = posts[1].msg;
  assert.equal(ok.success, true, 'the photograph on screen is captured');
  assert.match(ok.dataUrl, /^data:image\/webp/);
  assert.equal(ok.requestId, 'r2');

  ctx.canvas = { width: 0, height: 0 };
  ctx.answer({ requestId: 7 });
  assert.equal(posts[2].msg.error, 'no_canvas', 'an unsized stage is refused, not drawn');
  assert.equal(posts[2].msg.requestId, null, 'a non-string request id is not echoed');

  // The listener exists at module level, so the admin preview (no panel index) hears it.
  const tail = page2dSrc.slice(page2dSrc.lastIndexOf('})();'));
  assert.ok(/type === 'REQUEST_SCREENSHOT'\) App2D\._answerScreenshot\(e\.data\)/.test(tail), 'module-level listener answers the request');
  assert.ok(tail.includes('e.source !== window.parent'), '… from the hosting page only');
  assert.ok(page2dSrc.includes('    _answerScreenshot,\n'), 'App2D exposes it');
}

// ── 2. The volume viewer before init() ───────────────────────────────────────
{
  const start = viewerSrc.indexOf('// Early answer to REQUEST_SCREENSHOT');
  const end = viewerSrc.indexOf('// Boot-level safety net', start);
  assert.ok(start > 0 && end > start, 'the early listener is installed at module level');
  const block = viewerSrc.slice(start, end);
  const posts = [];
  const listeners = [];
  const parent = { postMessage: (msg, origin) => posts.push({ msg, origin }) };
  const ctx = vm.createContext({
    window: { parent, addEventListener: (type, fn) => { if (type === 'message') listeners.push(fn); } },
    Utils: { isTrustedMessageOrigin: () => true, trustedTargetOrigin: () => 'http://host' },
    ViewerApp: { _hearsHost: () => false },
  });
  vm.runInContext(`const _fromViewerHost = (e) => e.source === window.parent;\n${block}`, ctx);
  assert.equal(listeners.length, 1);
  listeners[0]({ source: parent, data: { type: 'REQUEST_SCREENSHOT', requestId: 'v1' } });
  assert.deepEqual(JSON.parse(JSON.stringify(posts[0].msg)), { type: 'SCREENSHOT_RESPONSE', requestId: 'v1', success: false, error: 'not_ready' },
    'before init() binds its handler, the viewer says it is not ready');
  listeners[0]({ source: {}, data: { type: 'REQUEST_SCREENSHOT' } });
  assert.equal(posts.length, 1, 'another window is not answered');
  ctx.ViewerApp._hearsHost = () => true;
  listeners[0]({ source: parent, data: { type: 'REQUEST_SCREENSHOT', requestId: 'v2' } });
  assert.equal(posts.length, 1, 'once the handler of _bindIframeSync is bound, it alone answers');
  assert.ok(/function _bindIframeSync\(\) \{\n    if \(!_isIframe\) return;\n    _hostListenerBound = true;/.test(viewerSrc), '_bindIframeSync marks the handler as bound');
  assert.ok(viewerSrc.includes('_hearsHost: () => _hostListenerBound'), 'ViewerApp exposes it');
  // The handler itself echoes the id and sends codes, never a message text.
  const handler = viewerSrc.slice(viewerSrc.indexOf("} else if (data.type === 'REQUEST_SCREENSHOT') {"));
  const body = handler.slice(0, handler.indexOf('\n  }\n'));
  assert.ok(body.includes('requestId, ...msg'), 'the viewer echoes the request id');
  assert.ok(!/error: err\.message/.test(body), 'no technical text crosses to the admin');
}

// ── 3. The admin button ──────────────────────────────────────────────────────
{
  const timers = new Map();
  let timerSeq = 0;
  const toasts = [];
  const saved = [];
  const posted = [];
  const btn = { disabled: false, innerHTML: 'idle' };
  const ctx = vm.createContext({
    timers, toasts, saved, posted, btn,
    console: { error() {} },
    setTimeout: (fn, ms) => { const id = ++timerSeq; timers.set(id, { fn, ms }); return id; },
    clearTimeout: (id) => timers.delete(id),
    window: { location: { origin: 'http://admin' } },
    t: (key, fallback) => `T:${key}`,
    escHtml: (s) => s,
    toast: (msg, kind) => toasts.push({ msg, kind }),
    saveThumbnail: (url) => saved.push(url),
    isStagingEditable: () => true,
  });
  const constant = adminSrc.match(/\nconst CAPTURE_REPLY_TIMEOUT = \d+;\n/);
  assert.ok(constant, 'a reply timeout is declared');
  vm.runInContext(`
    ${constant[0]}
    let _capture = null, _captureSeq = 0;
    let _current = { id: '2d/a' }, _draft = { id: '2d/a' };
    const DOM = { btnSetPreview: btn, previewFrame: { contentWindow: { postMessage: (m, o) => posted.push({ m, o }) } } };
    ${lift(adminSrc, 'paintCaptureButton', '')}
    ${lift(adminSrc, 'requestCapture', '')}
    ${lift(adminSrc, 'cancelCapture', '')}
    ${lift(adminSrc, 'onCaptureResponse', '')}
    Object.assign(globalThis, { requestCapture, cancelCapture, onCaptureResponse, pending: () => _capture });
  `, ctx);
  const fire = () => { const [id, t] = [...timers][0]; timers.delete(id); t.fn(); };

  // No answer: the button comes back with a sentence.
  ctx.requestCapture();
  assert.equal(btn.disabled, true, 'busy while waiting');
  assert.equal(posted[0].m.type, 'REQUEST_SCREENSHOT');
  assert.equal(typeof posted[0].m.requestId, 'string', 'each request carries an id');
  assert.equal(posted[0].o, 'http://admin', 'posted to the same origin, not "*"');
  assert.equal(timers.size, 1);
  assert.equal([...timers.values()][0].ms, 8000);
  ctx.requestCapture();
  assert.equal(posted.length, 1, 'a second click while one waits sends nothing');
  fire();
  assert.equal(btn.disabled, false, 'the button is given back when the page never answers');
  assert.equal(btn.innerHTML, 'T:admin.setPreview');
  assert.equal(toasts.at(-1).msg, 'T:admin.captureUnavailable');
  assert.equal(ctx.pending(), null);

  // A late answer to that request is ignored.
  ctx.onCaptureResponse({ type: 'SCREENSHOT_RESPONSE', requestId: posted[0].m.requestId, success: true, dataUrl: 'data:x' });
  assert.equal(saved.length, 0, 'an answer after the timeout saves nothing');

  // The right answer saves; the timer is cleared.
  ctx.requestCapture();
  const id2 = posted[1].m.requestId;
  assert.notEqual(id2, posted[0].m.requestId, 'a new id per request');
  ctx.onCaptureResponse({ requestId: 'someone-else', success: true, dataUrl: 'data:y' });
  assert.equal(saved.length, 0, 'an answer to another request is ignored');
  ctx.onCaptureResponse({ requestId: id2, success: true, dataUrl: 'data:z' });
  assert.deepEqual(saved, ['data:z']);
  assert.equal(timers.size, 0, 'the timeout is cleared by the answer');

  // An error code becomes a sentence.
  ctx.requestCapture();
  ctx.onCaptureResponse({ requestId: posted[2].m.requestId, success: false, error: 'capture_failed' });
  assert.equal(toasts.at(-1).msg, 'T:admin.captureFailed', 'a failure reads as a translated sentence');
  assert.ok(!toasts.some((x) => /capture_failed|not_ready/.test(x.msg)), 'the code never reaches the screen');
  ctx.requestCapture();
  ctx.onCaptureResponse({ requestId: posted[3].m.requestId, success: false, error: 'not_ready' });
  assert.equal(toasts.at(-1).msg, 'T:admin.captureUnavailable');

  // A dataset switch abandons the request: no toast, no save, button back.
  ctx.requestCapture();
  const id5 = posted[4].m.requestId;
  const toastCount = toasts.length;
  ctx.cancelCapture();
  assert.equal(btn.disabled, false);
  assert.equal(timers.size, 0);
  ctx.onCaptureResponse({ requestId: id5, success: true, dataUrl: 'data:old' });
  assert.equal(saved.length, 1, 'the answer about the dataset that left is not saved onto the new one');
  assert.equal(toasts.length, toastCount);

  // The wiring.
  for (const fn of ['loadPreview', 'stopPreview', 'closeEditor']) {
    assert.ok(lift(adminSrc, fn, '').includes('cancelCapture();'), `${fn} abandons a pending capture`);
  }
  assert.ok(adminSrc.includes("addEventListener('click', requestCapture)"), 'the button asks through requestCapture');
  assert.ok(adminSrc.includes("e.data?.type === 'SCREENSHOT_RESPONSE') onCaptureResponse(e.data)"), 'and the answer goes through onCaptureResponse');
  assert.ok(!/toastCaptureError/.test(adminSrc), 'the page error text is no longer interpolated into a toast');
}

console.log('preview capture: 2D page answers, viewer answers before init, admin times out and ignores stale answers: OK');
