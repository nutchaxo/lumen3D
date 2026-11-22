// Stand-ins of the other builders' macro files for the PLUMBING tests (DOCS/studio-advanced/macros/INTEGRATION.md): the tests of
// test_ij_macro_{plumbing,lane,undo,batch,state}.mjs check ij-app.js / ij-engine.js / ij-worker.js / ij-view.js, so they must not depend on
// the real ij-proc-macro.js, ij-macro-cmds.js and ij-cmds-macro.js (written at the same time against the same contract). Not a test.
//
//   FAKE_SOURCES                 the pageSources / workerSources of boot() that put the stand-ins in place
//   steps(t, api, runId)         drives the stand-in `macro.run` of the worker: send(step) → the worker's acknowledgement
import { until } from './ij_harness.mjs';

// ── the worker package `macro` (also its page copy: the page registers the specs, never runs a handler) ───────────────────────
// macro.run opens the macro group of the run, then executes the steps the page sends through the passive macro.reply until 'end'
// (or a cancel), ends the group and answers like RUNTIME's run would ({ ok, aborted, changedDocs, undo, … }). Each step is
// acknowledged by the event 'macro.ack' { runId, n, out | error }.
export const WORKER_MACRO = `
(function (root) {
  'use strict';
  const R = root.IJOpRegistry;
  root.__macroLoaded = true;
  const runs = root.__macroRuns || (root.__macroRuns = new Map());
  const wake = (st) => { const w = st.wake; st.wake = null; if (w) w(); };
  R.defineCommand('macro.run', { pkg: 'macro', long: true, handler: async (a, E) => {
    const st = { steps: [], wake: null, cancelled: false, n: 0 };
    runs.set(a.runId, st);
    const ack = (n, extra) => E.postEvent(Object.assign({ event: 'macro.ack', runId: a.runId, n: n }, extra || {}));
    const begun = E.macroGroup.begin({ runId: a.runId, labelKey: 'op.macRun' });
    E.onCancel(() => { st.cancelled = true; wake(st); });
    ack(0, { begun: begun.docs, mirror: a.mirror, args: { name: a.name, arg: a.arg, options: a.options, texts: a.texts, prefs: a.prefs, log: a.log } });
    const changed = new Set();
    let aborted = false, undo = { changed: [], dropped: [] };
    try {
      for (;;) {
        while (!st.steps.length && !st.cancelled) await new Promise((r) => { st.wake = r; });
        if (st.cancelled) { aborted = true; break; }
        const s = st.steps.shift();
        const n = ++st.n;
        if (s.op === 'end') { ack(n); break; }
        try {
          let out = null;
          if (s.op === 'commit') {
            const src = E.plane(s.docId, s.c || 0, s.z || 0, s.t || 0);
            const data = new src.constructor(src.length);
            for (let i = 0; i < data.length; i++) data[i] = s.value !== undefined ? s.value : 255 - src[i];
            E.reserve(data.byteLength);
            await E.commitPlanes(s.docId, [{ c: s.c || 0, z: s.z || 0, t: s.t || 0, data }], { labelKey: 'op.macRun' });
            changed.add(s.docId);
          } else if (s.op === 'runOp') {
            out = await E.runOp(s.docId, s.name, s.params || {}, s.o || {});
            changed.add(s.docId);
          } else if (s.op === 'create') {
            const N = s.w * s.h;
            out = E.createDoc({ name: s.name || 'made', width: s.w, height: s.h, bitDepth: 8, channels: [{ data: new Uint8Array(N).fill(s.fill || 0), name: 'C1', color: '#ffffff' }] });
          } else if (s.op === 'batch') E.macroGroup.setBatch(a.runId, !!s.on);
          else if (s.op === 'reserve') { E.reserve(s.bytes); E.release(s.bytes); out = true; }
          else if (s.op === 'request') out = await E.request(s.cmd, s.args);
          else if (s.op === 'pixelBytes') out = E.pixelBytes();
          else if (s.op === 'beginAgain') out = E.macroGroup.begin({ runId: 'other', labelKey: 'x' });
          else if (s.op === 'endTwice') { const x = await E.macroGroup.end(a.runId); const y = await E.macroGroup.end(a.runId); out = { first: x, same: JSON.stringify(x) === JSON.stringify(y) }; }
          else if (s.op === 'rpc') E.postEvent({ event: 'macro.rpc', runId: a.runId, reqId: n, method: s.method, args: s.args || {}, writes: [] });
          ack(n, { out: out });
        } catch (err) { ack(n, { error: (err && err.code) || String(err) }); }
      }
    } finally {
      if (!a.skipEnd) undo = await E.macroGroup.end(a.runId);
      runs.delete(a.runId);
    }
    undo.changed.forEach((id) => changed.add(id));
    return { ok: !aborted, aborted: aborted, exited: false, error: null, prefsWrites: {}, changedDocs: Array.from(changed), undo: undo };
  } });
  R.defineCommand('macro.reply', { pkg: 'macro', passive: true, handler: (a) => {
    const st = runs.get(a.runId);
    if (st && a.step) { st.steps.push(a.step); wake(st); }
    return { queued: !!st };
  } });
  R.defineCommand('macro.echo', { pkg: 'macro', handler: async (a) => ({ v: a.v }) });
})(typeof self !== 'undefined' ? self : globalThis);
`;

// ── the run() bridge tables (CMDTAB's IJMacroOptions / IJMacroCmds), reduced to what the plumbing tests need ────────────────
// headlessAnswer: `<fieldId>=<value>` per field (a bare word ticks a check; the check `all` reads `stack`), `&x` = vars[x].n,
// the value `bad` is refused with an ImageJ-like text; every answer is recorded in globalThis.__headless.
export const PAGE_CMDTAB = `
const IJMacroOptions = (() => {
  function normalize(o) {
    if (o === null || o === undefined) return null;
    const s = String(o);
    if (s === '') return null;
    return s.endsWith(' ') ? s : s + ' ';
  }
  function hasWord(o, w) { return typeof o === 'string' && o.indexOf(w + ' ') >= 0; }
  return { normalize, hasWord, setupDialogStack: (o) => hasWord(o, 'stack') };
})();
const IJMacroCmds = (() => {
  const NAMES = { 'Run...': 'macRun', 'Invert': 'editInvert', 'Gaussian Blur...': 'filterGaussian', 'Duplicate...': 'imageDuplicate', 'Revert': 'fileRevert', '8-bit': 'typeBit8',
    'Histogram': 'analyzeHistogram', 'Next Image': 'windowNext', 'Measure': 'analyzeMeasure', 'Fail': 'zFail', 'Twice': 'zTwice', 'Ask': 'zAsk',
    'Gone': 'zGone', 'Seg': 'procFindMaxima' };
  const REFUSE = {
    'Open from Library...': { key: 'err.macRefused', params: { command: 'Open from Library...', reasonKey: 'err.macReasonLibrary' } },
    'Open...': { key: 'err.macFileLater', params: { name: 'Open...' } }
  };
  function resolve(name) {
    if (NAMES[name]) return { id: NAMES[name], entry: { name, cls: 'A', dialogs: [], disabledText: name === 'Next Image' ? 'Next needs two images' : undefined } };
    if (REFUSE[name]) return { refuse: REFUSE[name] };
    return null;
  }
  function headlessAnswer(spec, options, ctx) {
    const raw = {};
    for (const f of spec.fields || []) {
      if (f.type === 'message') continue;
      if (f.type === 'check') { raw[f.id] = (' ' + options).indexOf(' ' + (f.id === 'all' ? 'stack' : f.id) + ' ') >= 0; continue; }
      const m = new RegExp('(?:^| )' + f.id + '=(\\\\S+)').exec(options);
      if (m) {
        if (m[1] === 'bad') return { ok: false, error: { text: '"bad" is not a valid choice for "' + f.id + '"' } };
        raw[f.id] = m[1].charAt(0) === '&' ? String((ctx.vars[m[1].slice(1)] || {}).n) : m[1];
      } else raw[f.id] = f.value === undefined || f.value === null ? '' : String(f.value);
    }
    const r = ctx.pure.collectFields(spec.fields, raw, { hidden: new Set() });
    if (!r.ok) return { ok: false, error: { text: 'invalid ' + JSON.stringify(r.errors) } };
    globalThis.__headless = (globalThis.__headless || []).concat([{ commandId: ctx.commandId, dialogIndex: ctx.dialogIndex, title: spec.title, fields: (spec.fields || []).map((f) => ({ id: f.id, type: f.type, options: f.options })) }]);
    return { ok: true, values: r.values, unknown: [] };
  }
  return { resolve, headlessAnswer, nameOf: () => null, NO_IMAGE_TEXT: 'There are no images open' };
})();
`;

// ── the page package `macro` (PAGE's ij-cmds-macro.js): a few commands the tests run through runMacroCommand ─────────────────
export const PAGE_MACRO_CMDS = `
(function () {
  'use strict';
  IJApp.extend({
    pkg: 'macro',
    commands: [
      { id: 'macRun', menu: ['Plugins', 'Macros'], order: 20, enabled: () => true, run(api, mods) { globalThis.__macApi = api; globalThis.__mods = mods; } },
      { id: 'zFail', menu: ['Plugins', 'Macros'], order: 90, run() { throw Object.assign(new Error('boom'), { code: 'IJ_BAD_ARGS' }); } },
      { id: 'zTwice', menu: ['Plugins', 'Macros'], order: 91, async run(api) {
        // two steps at once inside ONE command: outside a macro the second would find the page busy
        const r = await Promise.all([api.run('invert', {}), api.run('invert', {})]);
        globalThis.__twice = r.map((x) => x !== null);
      } },
      { id: 'zAsk', menu: ['Plugins', 'Macros'], order: 92, async run(api) {
        globalThis.__asked = await api.dialog({ title: 'Ask', fields: [{ type: 'number', id: 'n', label: 'N', value: 3 }, { type: 'doc', id: 'img', label: 'Image' }] });
      } },
      { id: 'zGone', menu: ['Plugins', 'Macros'], order: 93, async run(api) { await api.run('noSuchOp', {}); } }
    ],
    errors: { IJ_MACRO_BUSY: 'err.macBusy', IJ_MACRO_GROUP: 'err.macUndoDuringRun' }
  });
})();
`;

/** boot() options that put every stand-in in place (worker + page). */
export const FAKE_SOURCES = {
  workerSources: { 'ij-proc-macro.js': WORKER_MACRO },
  pageSources: { 'ij-proc-macro.js': WORKER_MACRO, 'ij-macro-cmds.js': PAGE_CMDTAB, 'ij-cmds-macro.js': PAGE_MACRO_CMDS }
};

/**
 * The page side of a stand-in run: start(o) → { result: Promise<RunResult>, step(s) → Promise<ack>, end() → Promise<RunResult> }.
 * Waits for the run's first acknowledgement (the group is open) before resolving.
 */
export async function startRun(t, o = {}) {
  const api = t.api('macro');
  const runId = o.runId || ('r' + Math.random().toString(36).slice(2, 8));
  const acks = () => t.log.events.filter((e) => e.event === 'ext:macro.ack' && e.runId === runId);
  const result = api.macro.start(Object.assign({ runId, source: 'x', name: 'Test', arg: '', texts: { 'op.macRun': 'Running macro' }, prefs: {}, log: [] }, o.start || {}));
  result.catch(() => {});
  await until(() => acks().length >= 1, 'the run opened its group');
  let n = 0;
  return {
    runId, api, result, first: acks()[0],
    async step(s) {
      const want = ++n;
      await api.call('macro.reply', { runId, step: s });
      const a = await until(() => acks().find((x) => x.n === want), 'step ' + JSON.stringify(s.op));
      return a;
    },
    async end() { await this.step({ op: 'end' }); return result; }
  };
}

/** A request straight to a worker's engine for a run started with t.engine('macro.run'), sends one step and waits for its ack. */
export async function engineStep(t, w, runId, k, s) {
  await t.engine('macro.reply', { runId, step: s }, w);
  return until(() => t.log.events.find((e) => e.event === 'ext:macro.ack' && e.runId === runId && e.n === k), 'engine step ' + s.op);
}
