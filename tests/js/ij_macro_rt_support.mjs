// Shared support of the macro runtime tests (not a test: no `test_` prefix).
//
// rt(opts) boots, under Node, the REAL worker side of the Advanced Studio macros: ij-core / ij-analysis / ij-proc-shared / ij-engine
// (memory storage), the packages the tests need (opts.packages, default multi + geom + roi + ana), ij-macro-lang.js and ij-proc-macro.js,
// in one vm context with a fake `self`. A scripted PAGE answers the worker's `ext:macro.rpc` events exactly as the contract says
// (INTEGRATION.md §3, §4): it applies the write-behind ops in order, runs the method, and replies with `macro.reply` + a fresh mirror.
// The page model is small and explicit (images in opening order with ImageJ ids, selections, ROI Manager, tables, thresholds, settings,
// colours) so a test can read what the macro changed: t.page.
//
//   const t = await rt();
//   const id = await t.open({ name: 'a', width: 8, height: 8, bitDepth: 8, channels: [{ data }] });
//   const r = await t.run('print(getPixel(0,0));');   // → { result, log, rpc: [method…], writes: [[op, args]…] }
//   t.pixels(id), t.call(cmd, args), t.close()
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT } from './harness.mjs';

export const DIR = path.join(ROOT, 'js', 'modules', 'studio', 'advanced-studio');
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function loadWorker(opts = {}) {
  const sandbox = { console, setTimeout, clearTimeout, setInterval, clearInterval, MessageChannel, performance, TextEncoder, TextDecoder, AbortController, Blob, structuredClone };
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  const files = ['ij-core.js', 'ij-analysis.js', 'ij-proc-shared.js', 'ij-engine.js'];
  for (const p of opts.packages || ['multi', 'geom', 'roi', 'ana']) files.push('ij-proc-' + p + '.js');
  files.push('ij-macro-lang.js');
  // the virtual file system loads with the language (FILES.md F2) once it exists; opts.vfs === false keeps it out (stand-in tests)
  if (opts.vfs !== false && fs.existsSync(path.join(DIR, 'ij-macro-vfs.js'))) files.push('ij-macro-vfs.js');
  files.push('ij-proc-macro.js');
  for (const f of files) vm.runInContext((opts.sources && opts.sources[f]) || fs.readFileSync(path.join(DIR, f), 'utf8'), sandbox, { filename: f });
  return sandbox;
}

export const TEXTS = {
  'err.macNetwork': 'Macros cannot use the network.',
  'err.macBioFormats': 'Bio-Formats is not available in the browser: save the image as TIFF in Fiji (File › Save As › Tiff…) and open the TIFF.',
  'err.macExec': 'exec() is not available in the browser.',
  'err.macEvalScript': 'Only macro code can be evaluated in the browser.',
  'err.macExtensions': 'Macro extensions are not available.',
  'err.macDebug': 'The macro debugger is not available.',
  'err.macCallRefused': 'call() is not available in the browser for "{target}".\nOnly a few ImageJ calls are emulated: ij.Prefs.get/set, ij.IJ.freeMemory/currentMemory/maxMemory/pad, RoiManager.getName, ThresholdAdjuster.setMode, ImageWindow.setNextLocation, ImagePlus.setDefault16bitRange.',
  'err.macPadLimit': 'call(): ij.IJ.pad length is limited to 4096 in the browser',
  'err.macPrefsQuota': 'call("ij.Prefs.set"): the browser keeps at most 256 macro preferences, 8 KB each, 64 KB in all',
  'err.mac16bitRange': 'call("ij.ImagePlus.setDefault16bitRange", {value}) is not available in the browser: the 16-bit display range is automatic',
  'err.macPageTimeout': 'The page did not answer ({method}).',
  'err.macNotInBrowser': '{name} is not available in the browser.',
  'err.macArrow': 'Arrow selections are not available.',
  'err.macClipboard': 'The clipboard can only be used from a click.',
  'err.macRefused': '{command} is not available to macros: {reason}',
  'err.macFolderNotGranted': 'Folder not granted: {path} — choose it in the Files section of the Macro Editor.',
  'err.macFolderStale': 'The folder {name} must be chosen again in the Files section: this browser forgets folders between visits.',
  'err.macReadOnly': '{path}: this folder is read-only for macros (change its mode in the Files section).',
  'err.macWriteRefused': 'Writing refused: {path}',
  'err.macRootDelete': '{path} is a folder you granted: a macro cannot delete it.',
  'err.macPermission': 'No permission to use {name}: allow it again in the Files section.',
  'err.macQuota': 'Not enough browser storage: {written} written, {free} free',
  'err.macNoStorage': 'This browser gives the page no storage (a private window?): the macro cannot write {path}.',
  'err.macFileGone': '{path} can no longer be read: it changed after the folder was chosen. Choose the folder again.',
  'err.macFileBusy': '{path} is in use by another tab of the Studio.',
  'err.macFileTooLarge': '{path} is too large to be read in the browser.',
  'err.macSaveFormat': '{format} files cannot be written in the browser.',
  'err.macReasonSequence': 'image sequences are not available yet: open the files with open() in a loop, then use Image › Stacks › Images to Stack.'
};

/** The scripted page + the real worker engine. */
export async function rt(opts = {}) {
  const W = loadWorker(opts);
  const log = [];
  const waiters = new Map();
  let n = 0;
  const fake = { navigator: {}, onmessage: null, postMessage(m) { log.push(m); onPost(m); } };
  const eng = W.IJEngine.start(fake, Object.assign({ storage: 'memory', idleMs: 3600000, bandPixels: 1 << 20, verifyInputs: true }, opts.engine || {}));
  // E.request (INTEGRATION.md §2.7) for an engine that does not have it yet: the same handlers, reached as a page request
  const REQUESTS = new Set(['doc.info', 'doc.stats', 'doc.histogram', 'doc.profile', 'doc.threshold', 'doc.compute', 'doc.labels', 'doc.setLabel']);
  const spec = W.IJOpRegistry.getCommand('macro.run');
  if (spec && opts.shimRequest !== false) {
    const orig = spec.handler;
    spec.handler = (a, E) => {
      if (typeof E.request === 'function') return orig(a, E);
      const E2 = Object.create(E);
      E2.request = (cmd, args) => { if (!REQUESTS.has(cmd)) return Promise.reject(Object.assign(new Error('request'), { code: 'IJ_BAD_ARGS' })); return ok(cmd, args); };
      return orig(a, E2);
    };
  }
  function call(cmd, args, onId) {
    return new Promise((res) => { const id = ++n; waiters.set(id, res); if (onId) onId(id); fake.onmessage({ data: { id, cmd, args } }); });
  }
  async function ok(cmd, args) {
    const m = await call(cmd, args);
    if (!m.ok) throw Object.assign(new Error(cmd + ' failed: ' + (m.error && m.error.code) + ' ' + (m.error && m.error.message)), { error: m.error });
    return m.result;
  }

  // ---------------- the page model
  const page = {
    images: [],                 // { docId, id, title, hidden, changes }
    nextId: -1,
    current: null,
    selections: {},
    roiManager: { list: [], selected: [], showAll: false, labels: false },
    tables: { Results: { name: 'Results', size: 0, headings: [], columns: {}, labels: null, rev: 1 } },
    thresholds: {},
    thresholdWindow: null,
    settings: { 'thr.blackBackground': false },
    measurements: { groups: ['area', 'mean', 'minMax'], decimals: 3 },
    colors: { foreground: [255, 255, 255], background: [0, 0, 0], selection: [255, 255, 0] },
    lineWidth: 1, tool: 'rect', workspace: { width: 1600, height: 900 },
    log: [], rpc: [], writes: [], status: [], progress: [], shown: [], closedWindows: [], printed: [], dialogs: [],
    answers: {},                // method → (args) => result | Promise  (a test's own answers)
    noReply: new Set(),         // methods the page never answers (timeouts, aborts)
    sentTables: new Map()
  };
  async function infoOf(docId) { return (await ok('doc.info', { docId })).info || (await ok('doc.info', { docId })); }
  function register(docId, name, hidden) {
    let im = page.images.find((x) => x.docId === docId);
    if (!im) { im = { docId, id: page.nextId--, title: name, hidden: !!hidden, changes: false }; page.images.push(im); }
    return im;
  }
  async function mirror() {
    const images = [];
    for (const im of page.images) {
      let info;
      try { info = await ok('doc.info', { docId: im.docId }); } catch (_) { continue; }
      info = info.info || info;
      images.push({
        docId: im.docId, id: im.id, title: im.title, width: info.width, height: info.height, bitDepth: info.bitDepthIJ, nC: info.nC, nZ: info.nZ, nT: info.nT,
        hyperstack: info.hyperstack, rgb: info.rgb, hidden: im.hidden, ephemeral: !!info.ephemeral, changes: im.changes, mode: info.mode, active: info.active,
        pos: { c: info.active, z: info.z, t: info.t }, visible: info.visible, calibration: info.calibration,
        display: info.channels.map((c) => ({ min: c.display.min, max: c.display.max, lut: c.display.lut, invert: !!c.display.invert }))
      });
    }
    const tables = {};
    for (const name of Object.keys(page.tables)) {
      const t = page.tables[name];
      if (page.sentTables.get(name) === t.rev) tables[name] = { same: true };
      else { tables[name] = JSON.parse(JSON.stringify(t)); page.sentTables.set(name, t.rev); }
    }
    return {
      images, current: page.current, selections: JSON.parse(JSON.stringify(page.selections)), roiManager: JSON.parse(JSON.stringify(page.roiManager)),
      tables, thresholds: JSON.parse(JSON.stringify(page.thresholds)), thresholdWindow: page.thresholdWindow, settings: Object.assign({}, page.settings),
      measurements: JSON.parse(JSON.stringify(page.measurements)), colors: JSON.parse(JSON.stringify(page.colors)), lineWidth: page.lineWidth,
      tool: page.tool, workspace: page.workspace
    };
  }
  function applyWrite(op, a) {
    page.writes.push([op, a]);
    switch (op) {
      case 'roi.set': page.selections[a.docId] = a.roi; break;
      case 'display.set': return ok('doc.setDisplay', { docId: a.docId, channel: a.c, min: a.min, max: a.max });
      case 'display.lut': return ok('doc.setDisplay', { docId: a.docId, channel: a.c, lut: a.name || 'Grays' });
      case 'display.mode': return ok('doc.setDisplay', { docId: a.docId, mode: a.mode });
      case 'display.visible': return ok('doc.setDisplay', { docId: a.docId, visible: a.visible });
      case 'thr.set': (page.thresholds[a.docId] = page.thresholds[a.docId] || {})[a.c] = { lower: a.lower, upper: a.upper, dark: a.dark }; break;
      case 'thr.reset': if (page.thresholds[a.docId]) delete page.thresholds[a.docId][a.c]; break;
      case 'thr.mode': page.thrMode = a.mode; break;
      case 'table.replace': page.tables[a.name] = Object.assign(JSON.parse(JSON.stringify(a.table)), { rev: ((page.tables[a.name] && page.tables[a.name].rev) || 0) + 1 }); break;
      case 'table.remove': delete page.tables[a.name]; break;
      case 'table.rename': page.tables[a.to] = Object.assign({}, page.tables[a.from], { name: a.to, rev: 99 }); delete page.tables[a.from]; if (a.from === 'Results') page.tables.Results = { name: 'Results', size: 0, headings: [], columns: {}, labels: null, rev: 100 }; break;
      case 'table.show': page.shown.push(a.name); break;
      case 'rm.set': page.roiManager.list = a.list; break;
      case 'rm.select': page.roiManager.selected = a.indices; break;
      case 'rm.show': page.roiManager.showAll = a.showAll; page.roiManager.labels = a.labels; break;
      case 'setting.set': page.settings[a.key] = a.value; break;
      case 'measurements.set': if (a.groups) page.measurements.groups = a.groups; if (a.decimals !== undefined) page.measurements.decimals = a.decimals; break;
      case 'colors.set': Object.assign(page.colors, a); break;
      case 'tool.set': page.tool = a.id; break;
      case 'status.show': page.status.push(a.text); break;
      case 'progress.show': page.progress.push(a.fraction); break;
      default: throw new Error('unknown write op ' + op);
    }
    return null;
  }
  async function method(name, a) {
    if (page.answers[name]) return page.answers[name](a, page);
    switch (name) {
      case 'flush': return {};
      case 'image.adopt': { const info = await ok('doc.info', { docId: a.docId }); const im = register(a.docId, (info.info || info).name, (info.info || info).hidden); if (!im.hidden) page.current = a.docId; return { id: im.id }; }
      case 'image.select': page.current = a.docId; return { current: a.docId };
      case 'image.close': {
        const closed = [];
        for (const id of a.docIds) { try { await ok('doc.close', { docId: id, discard: true }); } catch (_) { /* already gone */ } page.images = page.images.filter((x) => x.docId !== id); closed.push(id); }
        if (closed.indexOf(page.current) >= 0) page.current = page.images.length ? page.images[page.images.length - 1].docId : null;
        return { closed };
      }
      case 'image.show': for (const id of a.docIds) { const im = page.images.find((x) => x.docId === id); if (im) im.hidden = false; } return {};
      case 'image.rename': { const im = page.images.find((x) => x.docId === a.docId); if (im) im.title = a.title; return {}; }
      case 'window.print': page.printed.push([a.title, a.text]); return {};
      case 'window.select': return { found: !!page.tables[a.title] || a.title === 'Log' };
      case 'window.close': page.closedWindows.push(a.title); return { closed: true };
      case 'command.list': return { commands: [['Gaussian Blur...', 'filters'], ['Invert', 'core']] };
      case 'clipboard.copy': return { ok: true };
      case 'dialog.message': case 'error.show': page.dialogs.push([name, a]); return {};
      case 'dialog.messageCancel': case 'dialog.waitForUser': page.dialogs.push([name, a]); return { ok: true };
      case 'dialog.number': case 'dialog.string': page.dialogs.push([name, a]); return { value: a.value };
      case 'dialog.boolean': page.dialogs.push([name, a]); return { value: true };
      case 'dialog.show': {
        page.dialogs.push([name, a]);
        const values = {};
        for (const f of a.fields) if (f.type !== 'message') values[f.id] = f.value;
        return { values };
      }
      case 'run': return { status: 'unrecognized', text: 'Unrecognized command: "' + a.name + '"', current: page.current, created: [], closed: [] };
      default: throw new Error('the page has no method ' + name);
    }
  }
  const runResults = new Map();
  function onPost(m) {
    if (m.id !== undefined && 'ok' in m) { const w = waiters.get(m.id); if (w) { waiters.delete(m.id); w(m); } return; }
    if (m.event === 'ext:macro.log') { page.log.push(...m.lines); return; }
    if (m.event === 'docCreated') { register(m.docId, m.info.name, m.info.hidden); return; }
    if (m.event === 'ext:macro.rpc') {
      page.rpc.push(m.method);
      if (page.noReply.has(m.method)) return;
      (async () => {
        let reply;
        try {
          for (const [op, a] of m.writes || []) await applyWrite(op, a);
          const result = await method(m.method, m.args);
          reply = { runId: m.runId, reqId: m.reqId, ok: true, result, mirror: await mirror() };
        } catch (err) {
          reply = { runId: m.runId, reqId: m.reqId, ok: false, error: { text: String(err && err.text || err.message) } };
        }
        const r = await call('macro.reply', reply);
        assert.ok(r.ok, 'macro.reply answered');
      })();
    }
  }
  /** Imports an image (API.md §3 stack image) and registers it with the page (a new ImageJ id, current). */
  async function open(image, o = {}) {
    const r = await ok('doc.import', { image });
    const docId = r.docId;
    register(docId, image.name, !!o.hidden);
    page.current = docId;
    return docId;
  }
  let runSeq = 0;
  /** Runs a macro; resolves with the macro.run result, the Log, the RPC methods and the writes of THIS run. */
  async function run(source, o = {}) {
    const rpc0 = page.rpc.length, w0 = page.writes.length, l0 = page.log.length;
    const runId = 'r' + (++runSeq);
    const args = { runId, source, name: o.name || 'Macro', arg: o.arg || '', mirror: await mirror(), log: page.log.slice(), texts: Object.assign({}, TEXTS, o.texts || {}), prefs: o.prefs || {},
      options: Object.assign({ fastPath: true, syncLoops: false, syncRecursion: false }, o.options || {}) };
    if (o.vfs !== undefined) args.vfs = o.vfs;
    // a complete first mirror: forget what earlier runs were sent
    page.sentTables = new Map();
    args.mirror = await mirror();
    let reqId = null;
    const p = call('macro.run', args, (id) => { reqId = id; });
    if (o.onStart) o.onStart({ runId, reqId, promise: p, cancel: () => call('cancel', { targetId: reqId }) });
    const m = await p;
    // let the last log event land
    await sleep(0);
    return { runId, msg: m, result: m.ok ? m.result : null, error: m.ok ? null : m.error, log: page.log.slice(l0), rpc: page.rpc.slice(rpc0), writes: page.writes.slice(w0) };
  }
  function pixels(docId, c = 0, z = 0, t = 0) { const d = eng.inspectDoc(docId); return Array.from(d.channels[c].planes[t * d.nZ + z]); }
  return { W, eng, call, ok, page, open, run, pixels, mirror, log, close() { eng.dispose(); } };
}

/** The Log lines a run printed (macro.log raw strings). */
export const out = (r) => r.log;
/** Asserts a run ended normally and returns its log. */
export function okRun(r, what) {
  assert.ok(r.result, (what || 'run') + ': macro.run failed ' + JSON.stringify(r.error));
  assert.equal(r.result.error, null, (what || 'run') + ': macro error ' + JSON.stringify(r.result.error));
  return r.log;
}
