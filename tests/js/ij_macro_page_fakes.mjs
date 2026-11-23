// Fakes for the tests of the page side of package `macro` (ij-cmds-macro.js). Not a test (no `test_` prefix).
//
// loadMacroPage(opts) runs the REAL ij-cmds-macro.js in a vm context behind:
//   - a small DOM (createElement, children, textContent, value, selection, listeners, attributes);
//   - a fake IJApp (extend() records the registration, apiFor('macro') = the fake api below);
//   - a fake package api whose `macro` member follows INTEGRATION.md §2.3 and records every call; `start()` creates a lane and
//     resolves when the test calls `finish(result)`; `emit(event, payload)` delivers an ext: event as ij-app.js would.
// Stand-ins of IJMacroProto (ij-proc-macro.js) and IJMacroCmds (ij-macro-cmds.js) are used unless opts.proto / opts.cmds give others.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT } from './harness.mjs';

export const DIR = path.join(ROOT, 'js', 'modules', 'studio', 'advanced-studio');
export const LANGS = ['en', 'fr', 'es', 'nl'];
export const lang = Object.fromEntries(LANGS.map((c) => [c, JSON.parse(fs.readFileSync(path.join(DIR, 'lang', c + '.json'), 'utf8'))]));
export const lookup = (dict, key) => key.split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), dict);
const interp = (s, p) => String(s).replace(/\{(\w+)\}/g, (m, k) => (p && p[k] !== undefined ? String(p[k]) : m));
export const tr = (key, params) => { const v = lookup(lang.en, key); return typeof v === 'string' ? interp(v, params) : key; };
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export async function until(fn, what, ms = 3000) {
  const t0 = Date.now();
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timeout: ' + what); await sleep(2); }
}

// ── DOM ──
export function makeDom() {
  function node(tag) {
    const listeners = {};
    const attrs = {};
    let kids = [];
    let text = '';
    const n = {
      tagName: String(tag).toUpperCase(), style: {}, className: '', hidden: false, disabled: false, value: '', type: '', tabIndex: -1,
      scrollTop: 0, scrollHeight: 0, clientHeight: 100, selectionStart: 0, selectionEnd: 0, focused: 0, parentNode: null,
      get children() { return kids.slice(); },
      get firstChild() { return kids[0] || null; },
      get textContent() { return kids.length ? kids.map((k) => k.textContent).join('') : text; },
      set textContent(v) { for (const k of kids) k.parentNode = null; kids = []; text = String(v); },
      appendChild(c) { if (c.parentNode) c.parentNode.removeChild(c); kids.push(c); c.parentNode = n; return c; },
      removeChild(c) { kids = kids.filter((x) => x !== c); c.parentNode = null; return c; },
      replaceChildren(...cs) { for (const k of kids) k.parentNode = null; kids = []; text = ''; for (const c of cs) n.appendChild(c); },
      setAttribute(k, v) { attrs[k] = String(v); }, getAttribute: (k) => (k in attrs ? attrs[k] : null), attrs,
      addEventListener(t, f) { (listeners[t] = listeners[t] || []).push(f); },
      removeEventListener(t, f) { listeners[t] = (listeners[t] || []).filter((x) => x !== f); },
      dispatch(type, ev) { const e = Object.assign({ type, target: n, defaultPrevented: false, propagationStopped: false, preventDefault() { e.defaultPrevented = true; }, stopPropagation() { e.propagationStopped = true; } }, ev || {}); for (const f of (listeners[type] || []).slice()) f(e); return e; },
      click() { if (!n.disabled) n.dispatch('click'); },
      focus() { n.focused++; },
      setSelectionRange(a, b) { n.selectionStart = a; n.selectionEnd = b; n.lastSelection = [a, b]; },
      listeners
    };
    return n;
  }
  const document = { createElement: node, body: node('body') };
  return { document, node };
}

/** Depth-first search of a node tree. */
export function find(rootNode, pred) {
  const out = [];
  (function walk(x) { if (!x) return; if (pred(x)) out.push(x); for (const k of x.children || []) walk(k); })(rootNode);
  return out;
}
export const byClass = (rootNode, cls) => find(rootNode, (x) => String(x.className).split(/\s+/).includes(cls));
export const buttonByText = (rootNode, text) => find(rootNode, (x) => x.tagName === 'BUTTON' && x.textContent === text)[0];

// ── stand-ins of the other builders' files (only what the page reads) ──
export function standInProto() {
  const RPC_METHODS = {};
  for (const m of ['run', 'dialog.show', 'dialog.message', 'dialog.messageCancel', 'dialog.waitForUser', 'dialog.number', 'dialog.string', 'dialog.boolean',
    'error.show', 'image.select', 'image.close', 'image.show', 'image.adopt', 'window.select', 'window.close', 'clipboard.copy']) RPC_METHODS[m] = { interactive: true };
  for (const m of ['flush', 'image.rename', 'window.print', 'command.list']) RPC_METHODS[m] = { interactive: false };
  return {
    TEXT_KEYS: ['err.macPageTimeout', 'err.macExec', 'err.macCallRefused'],
    RPC_METHODS,
    WRITE_OPS: ['roi.set', 'display.set', 'display.lut', 'display.mode', 'display.visible', 'thr.set', 'thr.reset', 'thr.mode', 'table.replace', 'table.remove',
      'table.rename', 'table.show', 'rm.set', 'rm.select', 'rm.show', 'setting.set', 'measurements.set', 'colors.set', 'tool.set', 'status.show', 'progress.show'],
    // the minimum of ImageJ's Log magic the page tests need (the real one is ij-proc-macro.js, tested by test_ij_macro_log.mjs)
    log: {
      MAX_LINES: 100000,
      apply(lines, raw) {
        let out = lines.slice();
        for (const r of raw) {
          if (r.startsWith('\\Clear') || r === '\\Close') out = [];
          else if (r.startsWith('\\Update:')) { if (out.length) out[out.length - 1] = r.slice(8); else out.push(r.slice(8)); }
          else out.push(r);
        }
        return out;
      }
    }
  };
}
export function standInCmds() {
  return {
    MACRO_COMMANDS: { procGaussian: { name: 'Gaussian Blur...', cls: 'A', dialogs: [] }, imgInvert: { name: 'Invert', cls: 'A', dialogs: [] }, gone: { name: 'Gone', cls: 'A', dialogs: [] } },
    nameOf(id) { return this.MACRO_COMMANDS[id] ? this.MACRO_COMMANDS[id].name : null; }
  };
}

// ── the fake app ──
export function loadMacroPage(opts = {}) {
  const o = Object.assign({ localStore: new Map(), storageBlocked: false }, opts);
  const { document, node } = makeDom();
  const log = { calls: [], toasts: [], errors: [], dialogs: [], replies: [], status: [], panels: [] };
  const listeners = new Map();
  const settings = new Map(Object.entries(o.settings || {}));
  const docs = o.docs || [{ docId: 1, name: 'blobs.gif' }, { docId: 2, name: 'b' }];
  let lane = null;
  let finishFn = null;
  let seqMirror = 0;
  const rec = (name) => (...args) => { log.calls.push([name, ...args]); return undefined; };
  const recAsync = (name, value) => async (...args) => { log.calls.push([name, ...args]); return typeof value === 'function' ? value(...args) : value; };
  const tables = new Map();
  let results = { name: 'Results', size: 0, headings: [], columns: {}, labels: null, rev: 0 };
  const open = new Map();   // panel id → { el, inst }

  const macro = {
    async start(args) {
      log.calls.push(['macro.start', args]);
      if (lane) throw Object.assign(new Error('busy'), { code: 'IJ_MACRO_BUSY' });
      lane = { runId: args.runId, ctrl: new AbortController(), paused: 0 };
      return new Promise((resolve, reject) => {
        finishFn = (result, err) => { if (lane) lane.ctrl.abort(); lane = null; finishFn = null; if (err) reject(err); else resolve(result); };
      });
    },
    abort() { log.calls.push(['macro.abort']); if (lane) lane.ctrl.abort(); },
    running: () => (lane ? { runId: lane.runId, paused: lane.paused > 0 } : null),
    signal: () => (lane ? lane.ctrl.signal : null),
    pause() { log.calls.push(['macro.pause']); if (lane) lane.paused++; let done = false; return () => { if (done) return; done = true; log.calls.push(['macro.resume']); if (lane) lane.paused--; }; },
    runCommand: recAsync('macro.runCommand', (name) => (o.runCommand ? o.runCommand(name) : { status: 'ok', text: '', current: 1, created: [], closed: [] })),
    mirror: () => ({ seq: ++seqMirror, current: 1 }),
    ijId: (d) => -d, docOf: (id) => -id,
    selectImage: recAsync('macro.selectImage'),
    closeImages: recAsync('macro.closeImages', (ids) => ids.slice()),
    showImages: recAsync('macro.showImages'),
    adopt: recAsync('macro.adopt', (d) => -d),
    results: { get: () => results, replace: (t) => { log.calls.push(['results.replace', t]); results = t; } },
    tables: {
      list: () => Array.from(tables.keys()), get: (n) => tables.get(n) || null,
      replace: (n, t) => { log.calls.push(['tables.replace', n, t]); tables.set(n, t); },
      remove: (n) => { log.calls.push(['tables.remove', n]); tables.delete(n); },
      rename: (a, b) => { log.calls.push(['tables.rename', a, b]); if (tables.has(a)) { tables.set(b, tables.get(a)); tables.delete(a); } },
      show: (n) => { log.calls.push(['tables.show', n]); }
    },
    thresholds: { get: () => null, set: rec('thresholds.set'), reset: rec('thresholds.reset') },
    thresholdMode: rec('thresholdMode'),
    settings: { get: () => undefined, set: rec('macro.settings.set') },
    measurements: { get: () => ({ groups: [], decimals: 3 }), set: rec('measurements.set') },
    colors: { get: () => ({}), set: rec('colors.set') },
    roiManagerShow: rec('roiManagerShow'),
    setVisible: rec('setVisible'),
    status: rec('macro.status'),
    progress: rec('macro.progress')
  };
  const api = {
    tr,
    on(ev, fn) { let s = listeners.get(ev); if (!s) { s = new Set(); listeners.set(ev, s); } s.add(fn); return () => s.delete(fn); },
    settings: {
      get: (k) => settings.get(k),
      set(k, v) {
        if (!/^mac\./.test(k)) throw Object.assign(new Error('forbidden'), { code: 'IJ_EXT_FORBIDDEN' });
        const t = JSON.stringify(v); if (t === undefined || t.length > 65536) throw Object.assign(new Error('value'), { code: 'IJ_BAD_ARGS' });
        settings.set(k, v);
      }
    },
    dialog: async (spec) => { log.dialogs.push(spec); return o.dialog ? o.dialog(spec, log) : {}; },
    async openPanel(id, opt) {
      log.panels.push(['open', id, opt]);
      if (open.has(id)) return true;
      const p = reg.spec.panels[id];
      if (!p) throw new Error('no panel ' + id);
      const el = node('div');
      const inst = p.build(el, api) || {};
      open.set(id, { el, inst });
      return true;
    },
    closePanel(id) {
      log.panels.push(['close', id]);
      const w = open.get(id);
      if (!w) return;
      open.delete(id);
      if (w.inst.dispose) w.inst.dispose();
    },
    toast: (k, p) => log.toasts.push([k, p]),
    error: (err) => log.errors.push(err),
    state: () => ({ docs }),
    commands: () => (o.commands || [{ id: 'procGaussian' }, { id: 'imgInvert' }, { id: 'macRun' }]),
    setRoi: rec('setRoi'), setDisplay: recAsync('setDisplay'), registerLut: recAsync('registerLut'), setDisplayMode: recAsync('setDisplayMode'),
    roiManager: { set: rec('roiManager.set'), select: rec('roiManager.select') },
    setTool: rec('setTool'), openTool: recAsync('openTool', true), rename: recAsync('rename'),
    copyText: async (t) => { log.calls.push(['copyText', t]); if (o.copyFails) throw new Error('NotAllowedError: secret'); },
    async call(cmd, args) { log.calls.push(['call', cmd, args]); if (cmd === 'macro.reply') log.replies.push(args); return {}; },
    macro: o.noMacro ? undefined : macro
  };
  const reg = { spec: null };
  const IJApp = {
    PACKAGE_NAMES: o.packageNames || ['bg', 'stk', 'macro'],
    COMMANDS: [{ id: 'procGaussian', pkg: 'filters' }, { id: 'imgInvert' }, { id: 'macRun', pkg: 'macro' }],
    extend(spec) { if (reg.spec) throw new Error('extend twice'); reg.spec = spec; },
    apiFor: (pkg) => { if (pkg !== 'macro') throw new Error('apiFor ' + pkg); return api; },
    errorKey: (err) => (err && err.code === 'IJ_MACRO_BUSY' ? 'err.macBusy' : '')
  };
  const localStorage = {
    getItem(k) { if (o.storageBlocked) throw new Error('SecurityError'); return o.localStore.has(k) ? o.localStore.get(k) : null; },
    setItem(k, v) { if (o.storageBlocked) throw new Error('SecurityError'); o.localStore.set(k, String(v)); },
    removeItem(k) { o.localStore.delete(k); }
  };
  const sandbox = { console: o.console || console, setTimeout, clearTimeout, AbortController, Promise, document, localStorage, IJApp,
    IJMacroProto: o.proto === undefined ? standInProto() : o.proto, IJMacroCmds: o.cmds === undefined ? standInCmds() : o.cmds };
  if (o.Dialog) sandbox.Dialog = o.Dialog;
  for (const k of Object.keys(sandbox)) if (sandbox[k] === null) delete sandbox[k];
  const ctx = vm.createContext(sandbox);
  const file = path.join(DIR, 'ij-cmds-macro.js');
  vm.runInContext(fs.readFileSync(file, 'utf8'), ctx, { filename: 'ij-cmds-macro.js' });
  const page = ctx.IJMacroPage;
  return {
    ctx, page, api, macro, log, reg, settings, open, tables, localStore: o.localStore,
    get spec() { return reg.spec; },
    get lane() { return lane; },
    panel: (id) => open.get(id) || null,
    emit(ev, payload) { const s = listeners.get(ev); if (s) for (const fn of Array.from(s)) fn(payload); },
    listenerCount: (ev) => (listeners.get(ev) ? listeners.get(ev).size : 0),
    finish(result, err) { if (!finishFn) throw new Error('no run to finish'); finishFn(result || { ok: true, aborted: false, exited: false, error: null, prefsWrites: {}, changedDocs: [], undo: { changed: [], dropped: [] } }, err); },
    startArgs: () => { const c = log.calls.filter((x) => x[0] === 'macro.start'); return c.length ? c[c.length - 1][1] : null; },
    /** Sends one ext:macro.rpc request of the running lane and waits for its reply. */
    async rpc(method, args, writes) {
      const runId = lane.runId;
      const reqId = (this._req = (this._req || 0) + 1);
      const n = log.replies.length;
      this.emit('ext:macro.rpc', { event: 'ext:macro.rpc', runId, reqId, method, args: args || {}, writes: writes || [] });
      await until(() => log.replies.length > n, 'reply to ' + method);
      const r = log.replies[log.replies.length - 1];
      if (r.reqId !== reqId) throw new Error('reply out of order');
      return r;
    }
  };
}
