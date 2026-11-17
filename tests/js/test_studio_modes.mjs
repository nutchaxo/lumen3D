// Studio modes (js/components/studio-editor.js registerMode / setMode / requestClose):
//   • registerMode validates the mode and returns an unregister function; the header's
//     #studio-mode-switch (Simple + one button per mode) shows only while a Studio is open
//     and a mode is registered, a mode that is not eligible is disabled with its reason as
//     the title, and the default view of an opening is Simple;
//   • setMode('id') hands the whole layout to the mode (header and body hidden,
//     #studio-mode-root shown, mount(root, api)); api.exit() asks canLeave('simple');
//   • while a mode is active the Simple shortcuts, the command palette and the wheel do
//     nothing;
//   • requestClose asks the active mode canLeave('close') (a mode that throws keeps the
//     work), then closes, which unmounts the mode; with no mode it closes at once;
//   • open() / setSliceResult({ reopen }) with a mode holding work ask canLeave('replace')
//     and return a Promise of the token (null when refused); a mode with unsaved work that
//     is NOT the active view is asked too (close / replace);
//   • beforeunload is cancelled while a registered mode reports unsaved work;
//   • a mode that fails to mount leaves the Simple view in place.
//
// The module runs for real in a vm; a hook spliced in before its `return {` reaches the
// closure (the source file is not modified).
//
// Run: node tests/js/test_studio_modes.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT } from './harness.mjs';

const SRC = readFileSync(path.join(ROOT, 'js/components/studio-editor.js'), 'utf8').replace(/\r/g, '');
const RETURN_RE = /\n  return \{\n    init,/;
assert.ok(RETURN_RE.test(SRC), 'studio-editor.js still ends its IIFE with `return { init, …`');
assert.ok(/function _openNow\(sliceResult\) \{[\s\S]*?\n    if \(_activeMode\) _deactivateMode\(\);/.test(SRC), 'a new document leaves the active mode before it is built');

const HOOK = `
  globalThis.__studio = {
    setup(container, canvas, doc) {
      _container = container; _canvas = canvas; _doc = doc; _isOpen = true;
      for (const name of ['_cancelChannelRecompose', '_cancelDrawRequest', '_resetPointerState', '_releaseRaw',
        '_releaseScratchCanvases', '_releaseMinimapThumb', '_removeCompareMenus', '_resizeCanvas']) {
        eval(name + ' = () => { globalThis.__stubbed.push("' + name + '"); }');
      }
      _closeTextEditor = () => {};
      _portableDocument = (d) => d;
      setLoadProgress = () => {};
      _bindEvents();
    },
    stubOpenNow(fn) { const front = _openNow; _openNow = (sr) => { if (_activeMode) _deactivateMode(); return fn(sr, front); }; },
    stubUndo(fn) { _undo = fn; },
    setPalette(p) { _palette = p; },
    onKeyDown: (e) => _onKeyDown(e),
    onWheel: (e) => _onWheel(e),
    refresh: () => _refreshModeSwitch(),
    get isOpen() { return _isOpen; },
    set isOpen(v) { _isOpen = v; },
  };`;
const instrumented = SRC.replace(RETURN_RE, (m) => `\n${HOOK}${m}`);

// ── a small fake DOM ─────────────────────────────────────────────────────────
function makeEl(id = '') {
  const e = {
    id, children: [], attrs: {}, dataset: {}, listeners: {}, classes: new Set(), title: '', disabled: false, textContent: '', className: '', type: '',
    classList: {
      add: (c) => e.classes.add(c),
      remove: (c) => e.classes.delete(c),
      toggle: (c, force) => { if (force === undefined ? !e.classes.has(c) : force) e.classes.add(c); else e.classes.delete(c); },
      contains: (c) => e.classes.has(c),
    },
    setAttribute(k, v) { e.attrs[k] = String(v); },
    appendChild(child) { e.children.push(child); return child; },
    replaceChildren() { e.children = []; },
    addEventListener(type, fn) { (e.listeners[type] ||= []).push(fn); },
    querySelector: () => null,
    closest: () => null,
  };
  return e;
}
const byId = {
  'studio-mode-switch': makeEl('studio-mode-switch'),
  'studio-mode-root': makeEl('studio-mode-root'),
  'btn-close-studio': makeEl('btn-close-studio'),
};
byId['studio-mode-root'].classes.add('hidden');
const header = makeEl('header');
const body = makeEl('body');
const container = makeEl('studio-layout');
container.querySelector = (sel) => (sel === '.studio-header' ? header : sel === '.studio-body' ? body : null);
const canvas = Object.assign(makeEl('canvas'), { addEventListener() {} });
const windowListeners = {};
const toasts = [];
const sandbox = {
  console: Object.assign(Object.create(console), { error() {}, warn() {} }),
  setTimeout, clearTimeout,
  requestAnimationFrame: (fn) => setTimeout(fn, 0),
  __stubbed: [],
  ExportManager: { toast: (t) => toasts.push(t) },
  I18n: { t: (k) => ({ 'studioAdvanced.needAxisPlane': 'Needs an axis plane', 'studio.modeSimple': 'Simple' }[k] ?? k), translateDOM() {} },
  document: {
    getElementById: (id) => byId[id] || null,
    querySelector: () => null, querySelectorAll: () => [],
    addEventListener() {}, createElement: () => makeEl(), body: { appendChild() {} },
  },
  window: {
    innerWidth: 800, innerHeight: 600,
    addEventListener: (type, fn) => { (windowListeners[type] ||= []).push(fn); },
  },
};
vm.createContext(sandbox);
vm.runInContext(instrumented, sandbox, { filename: 'studio-editor.js' });
const S = sandbox.__studio;
const E = sandbox.StudioEditor || vm.runInContext('StudioEditor', sandbox);

const flush = () => new Promise((resolve) => setImmediate(resolve));
const key = (k, extra = {}) => {
  const ev = { key: k, target: { matches: () => false }, ctrlKey: false, metaKey: false, shiftKey: false, prevented: false, preventDefault() { this.prevented = true; }, ...extra };
  S.onKeyDown(ev);
  return ev;
};

S.setup(container, canvas, { layers: [], guides: [] });
const switchEl = byId['studio-mode-switch'];
const root = byId['studio-mode-root'];
const buttons = () => switchEl.children;

// ── registration ────────────────────────────────────────────────────────────
assert.throws(() => E.registerMode(null), { name: "TypeError" });
assert.throws(() => E.registerMode({ id: 'simple', mount() {}, unmount() {} }), { name: "TypeError" }, 'simple is the default view, not a mode');
assert.throws(() => E.registerMode({ id: 'x', mount() {} }), { name: "TypeError" }, 'unmount is required');
assert.equal(E.getMode(), 'simple');
S.refresh();
assert.ok(switchEl.classes.has('hidden'), 'no mode registered: no switch');

const log = [];
let eligible = { ok: false, reasonKey: 'studioAdvanced.needAxisPlane' };
let leave = { simple: true, close: true, replace: true };
let work = false;
let mountError = null;
const mode = {
  id: 'advanced',
  label: () => 'Advanced',
  icon: 'microscope',
  eligible: () => eligible,
  async mount(rootEl, api) {
    log.push('mount');
    mode.api = api;
    mode.root = rootEl;
    if (mountError) throw mountError;
  },
  unmount() { log.push('unmount'); },
  async canLeave(reason) {
    log.push(`canLeave:${reason}`);
    const answer = leave[reason];
    if (answer instanceof Error) throw answer;
    return answer;
  },
  hasUnsavedWork: () => work,
};
const unregister = E.registerMode(mode);
assert.equal(typeof unregister, 'function');
assert.ok(!switchEl.classes.has('hidden'), 'a mode is registered and the Studio is open: the switch shows');
assert.deepEqual(buttons().map(b => b.dataset.studioMode), ['simple', 'advanced']);
assert.equal(buttons()[0].attrs['aria-pressed'], 'true', 'each opening starts on Simple');
assert.equal(buttons()[1].disabled, true, 'not eligible: disabled');
assert.equal(buttons()[1].title, 'Needs an axis plane', 'the reason is the title');
assert.equal(buttons()[1].children.at(-1).textContent, 'Advanced');
assert.equal(await E.setMode('advanced'), false, 'an ineligible mode cannot be entered');
assert.equal(E.getMode(), 'simple');
assert.equal(await E.setMode('nope'), false, 'an unknown mode');
assert.equal(await E.setMode('simple'), true, 'already there');

// A click on a disabled button does nothing; on an enabled one it switches.
eligible = { ok: true };
S.setup(container, canvas, { layers: [], guides: [] }); // re-bind is idempotent (_eventsBound)
S.refresh();
assert.equal(buttons()[1].disabled, false, 'eligible once the document allows it');

// ── entering ─────────────────────────────────────────────────────────────────
const clickAdvanced = () => {
  const button = buttons().find(b => b.dataset.studioMode === 'advanced');
  for (const fn of switchEl.listeners.click || []) fn({ target: { closest: (sel) => (sel === '[data-studio-mode]' ? button : null) } });
};
clickAdvanced();
await flush();
assert.equal(E.getMode(), 'advanced');
assert.deepEqual(log, ['mount']);
assert.equal(mode.root, root, 'the mode draws in #studio-mode-root');
assert.ok(header.classes.has('hidden') && body.classes.has('hidden'), 'the Simple studio is hidden');
assert.ok(!root.classes.has('hidden'), 'the mode root shows');
assert.equal(typeof mode.api.getDocument().layers.length, 'number', 'api.getDocument');
assert.equal(typeof mode.api.token(), 'number');

// ── Simple shortcuts are off while a mode is active ─────────────────────────
let undone = 0;
S.stubUndo(() => { undone++; });
const palette = makeEl('palette');
palette.classes.add('hidden');
S.setPalette(palette);
let ev = key('z', { ctrlKey: true });
assert.equal(undone, 0, 'Ctrl+Z is not the Studio\'s undo while a mode is active');
assert.ok(!ev.prevented);
key('k', { ctrlKey: true });
assert.ok(palette.classes.has('hidden'), 'Ctrl+K opens no palette');
const wheel = { prevented: false, preventDefault() { this.prevented = true; } };
S.onWheel(wheel);
assert.equal(wheel.prevented, false, 'the wheel is left alone');

// ── leaving to Simple ────────────────────────────────────────────────────────
log.length = 0;
leave.simple = false;
assert.equal(await mode.api.exit(), false, 'canLeave(simple) false: stays');
assert.equal(E.getMode(), 'advanced');
assert.deepEqual(log, ['canLeave:simple']);
leave.simple = true;
log.length = 0;
assert.equal(await mode.api.exit(), true);
assert.deepEqual(log, ['canLeave:simple', 'unmount']);
assert.equal(E.getMode(), 'simple');
assert.ok(!header.classes.has('hidden') && !body.classes.has('hidden'), 'the Simple studio is back');
assert.ok(root.classes.has('hidden'));
assert.equal(buttons()[0].attrs['aria-pressed'], 'true');
ev = key('z', { ctrlKey: true });
assert.equal(undone, 1, 'Simple shortcuts work again');
assert.ok(ev.prevented);
key('k', { ctrlKey: true });
assert.ok(!palette.classes.has('hidden'), 'the palette opens again');
assert.equal(await mode.api.exit(), false, 'a stale api (the mode is not active) does nothing');
console.log('modes: switch, eligibility, enter / exit, shortcuts off: OK');

// ── requestClose ─────────────────────────────────────────────────────────────
assert.equal(await E.setMode('advanced'), true);
log.length = 0;
leave.close = false;
assert.equal(await E.requestClose(), false, 'canLeave(close) false: the Studio stays');
assert.equal(S.isOpen, true);
assert.equal(E.getMode(), 'advanced');
assert.deepEqual(log, ['canLeave:close']);
// The close button goes through the same door.
for (const fn of byId['btn-close-studio'].listeners.click || []) fn({});
await flush();
assert.equal(S.isOpen, true, 'the X button asks too');
leave.close = new Error('boom');
assert.equal(await E.requestClose(), false, 'a mode that cannot answer keeps the work');
assert.equal(S.isOpen, true);
leave.close = true;
log.length = 0;
const closing = E.requestClose();
assert.equal(E.requestClose(), closing, 'a second request joins the first');
assert.equal(await closing, true);
assert.equal(S.isOpen, false, 'closed');
assert.deepEqual(log, ['canLeave:close', 'unmount'], 'close() unmounts the active mode');
assert.ok(switchEl.classes.has('hidden'), 'no Studio: no switch');
assert.ok(!header.classes.has('hidden') && root.classes.has('hidden'));
console.log('requestClose: canLeave(close), throw keeps the work, unmounts on close: OK');

// ── no active mode: close at once ───────────────────────────────────────────
S.setup(container, canvas, { layers: [], guides: [] });
S.refresh();
log.length = 0;
let closedAtOnce = false;
const closeResult = E.requestClose();
closedAtOnce = S.isOpen === false;
assert.ok(closedAtOnce, 'with no mode with work, close() ran synchronously');
assert.equal(await closeResult, true);
assert.deepEqual(log, [], 'nobody was asked');

// ── a mode with work that is not the active view is asked too ───────────────
S.setup(container, canvas, { layers: [], guides: [] });
work = true;
leave.close = false;
assert.equal(await E.requestClose(), false, 'Simple view, but the mode holds unsaved work: asked, refused');
assert.equal(S.isOpen, true);
assert.deepEqual(log, ['canLeave:close']);
leave.close = true;
log.length = 0;
assert.equal(await E.requestClose(), true);
assert.deepEqual(log, ['canLeave:close'], 'asked once, never mounted: nothing to unmount');
work = false;
console.log('requestClose with work in an inactive mode: OK');

// ── replace guard ────────────────────────────────────────────────────────────
S.setup(container, canvas, { layers: [], guides: [] });
const opened = [];
S.stubOpenNow((sr) => { opened.push(sr); return 99; });
assert.equal(await E.setMode('advanced'), true);
log.length = 0;
leave.replace = false;
let promise = E.open({ canvas: {} });
assert.ok(promise && typeof promise.then === 'function', 'with a mode active the answer is a Promise');
assert.equal(await promise, null, 'refused: null');
assert.deepEqual(opened, [], 'the document was not replaced');
assert.equal(E.getMode(), 'advanced');
assert.deepEqual(log, ['canLeave:replace']);
leave.replace = true;
log.length = 0;
assert.equal(await E.open({ canvas: { n: 1 } }), 99, 'agreed: the new document opens');
assert.equal(opened.length, 1);
assert.deepEqual(log, ['canLeave:replace', 'unmount'], 'the mode is left before the new document is built');
assert.equal(E.getMode(), 'simple');
// With no mode and no work: synchronous, as before.
log.length = 0;
const sync = E.open({ canvas: { n: 2 } });
assert.equal(sync, 99, 'plain Simple studio: open stays synchronous');
assert.deepEqual(log, []);
// setSliceResult({ reopen }) goes through the same guard.
assert.equal(await E.setMode('advanced'), true);
log.length = 0;
leave.replace = false;
const openedBefore = opened.length;
const reopened = E.setSliceResult({ canvas: {} }, { reopen: true });
assert.ok(reopened && typeof reopened.then === 'function');
await reopened;
assert.equal(opened.length, openedBefore, 'reopen refused');
assert.deepEqual(log, ['canLeave:replace']);
leave.replace = true;
await E.setSliceResult({ canvas: {} }, { reopen: true });
assert.equal(opened.length, openedBefore + 1, 'reopen agreed');
console.log('replace guard: open / reopen ask canLeave(replace): OK');

// ── beforeunload ─────────────────────────────────────────────────────────────
const unload = windowListeners.beforeunload || [];
assert.equal(unload.length, 1, 'one beforeunload listener');
const unloadEvent = () => ({ prevented: false, returnValue: undefined, preventDefault() { this.prevented = true; } });
work = false;
let u = unloadEvent();
unload[0](u);
assert.equal(u.prevented, false, 'no unsaved work: the page leaves');
work = true;
u = unloadEvent();
unload[0](u);
assert.equal(u.prevented, true, 'unsaved work: the browser asks');
assert.equal(u.returnValue, '');
work = false;
console.log('beforeunload with unsaved work: OK');

// ── mount failure ────────────────────────────────────────────────────────────
mountError = new Error('mount failed');
S.setup(container, canvas, { layers: [], guides: [] });
toasts.length = 0;
assert.equal(await E.setMode('advanced'), false, 'a mode that fails to mount');
assert.equal(E.getMode(), 'simple');
assert.ok(!header.classes.has('hidden') && root.classes.has('hidden'), 'the Simple view is back');
assert.equal(toasts.length, 1, 'the operator is told, with no technical text');
assert.ok(!/mount failed/.test(toasts[0]));
mountError = null;

// ── unregister ───────────────────────────────────────────────────────────────
assert.equal(await E.setMode('advanced'), true);
unregister();
assert.equal(E.getMode(), 'simple', 'unregistering the active mode leaves it');
assert.equal(await E.setMode('advanced'), false);
assert.ok(switchEl.classes.has('hidden'), 'no mode left: no switch');
console.log('mount failure and unregister: OK');

console.log('Studio modes: OK');
