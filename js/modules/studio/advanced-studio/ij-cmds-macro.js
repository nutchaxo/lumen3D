/* ij-cmds-macro.js — page side of package `macro`: Plugins › Macros › Run… / Edit…, Window › Log, the Macro Editor, Log, Macro Error and
 * text windows, and the RPC host a running macro talks to (DOCS/studio-advanced/macros/INTEGRATION.md §3, §4, §7).
 *
 * Page only, loaded after ij-app.js like every ij-cmds-<pkg>.js. The interpreter runs in the engine worker (ij-macro-lang.js +
 * ij-proc-macro.js); this file starts a run through the package's own `api.macro` (ij-app.js), answers the worker's `ext:macro.rpc`
 * requests with `macro.reply`, applies the write-behind queue that comes with each request, and shows the Log the worker streams
 * (`ext:macro.log`). It reaches the page only through the extension API: never ctx.studio, the dataset library or the network.
 *
 * Texts: ImageJ's own macro error texts are data and are shown verbatim (English, as ImageJ prints them); every sentence the platform
 * adds goes through the plugin lang keys (cmd.mac*, dlg.mac.*, err.mac*, warn.mac*).
 *
 * Macro preferences (call("ij.Prefs.get/set"), CALL-WHITELIST.md §6): localStorage 'lumen3d.studio.macroPrefs' = { v: 1, prefs }; a
 * snapshot goes to the worker at the start of a run and only the keys the run changed are merged back at its end, so two Studio tabs
 * never wipe each other's keys. A blocked store is an in-memory map for the page session.
 */
(function (root) {
  'use strict';
  if (typeof IJApp === 'undefined' || typeof IJApp.extend !== 'function') return;
  if (!Array.isArray(IJApp.PACKAGE_NAMES) || IJApp.PACKAGE_NAMES.indexOf('macro') < 0) return;

  const PREFS_KEY = 'lumen3d.studio.macroPrefs';
  const EDITOR_SETTING = 'mac.editorText';
  const EDITOR_MAX = 60000;          // characters kept in the setting (contract §7)
  const SETTING_JSON_MAX = 65536;    // api.settings refuses a value whose JSON is longer
  const LINE_PX = 16;                // the editor's line height (ij-style.css .ij-mac-text / .ij-mac-gutter)
  const PERSIST_MS = 400;
  const RENDER_MS = 100;
  const NBSP = ' ';

  // Tool windows a macro names by their ImageJ title (selectWindow): ContrastAdjuster "B&C", ThresholdAdjuster "Threshold", Channels "Channels".
  const TOOL_TITLES = { 'Results': 'results', 'ROI Manager': 'roiManager', 'B&C': 'bc', 'Threshold': 'threshold', 'Channels': 'channels' };

  // ───────────────────────────── pure helpers (exposed for the tests) ─────────────────────────────

  /** Offsets of the first character of each line. */
  function lineStarts(text) {
    const out = [0];
    for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) out.push(i + 1);
    return out;
  }
  /** 1-based line n of text → { start, end } (end excludes the newline); null when the text has no such line. */
  function lineRange(text, n) {
    const s = lineStarts(String(text));
    if (!(n >= 1 && n <= s.length)) return null;
    const start = s[n - 1];
    const end = n < s.length ? s[n] - 1 : String(text).length;
    return { start, end };
  }
  /** 1-based line of a character offset. */
  function lineOfOffset(text, offset) {
    let n = 1;
    const lim = Math.min(Math.max(0, offset | 0), String(text).length);
    for (let i = 0; i < lim; i++) if (text.charCodeAt(i) === 10) n++;
    return n;
  }
  /** What Run selection runs: the selected text, or the line of the caret (ImageJ's Evaluate Line) when nothing is selected.
   *  lineOffset = editor line of the snippet's line 1, minus one (an error at snippet line L is editor line L + lineOffset). */
  function runSlice(text, selStart, selEnd) {
    const t = String(text);
    let a = Math.max(0, Math.min(selStart | 0, selEnd | 0)), b = Math.min(t.length, Math.max(selStart | 0, selEnd | 0));
    if (a === b) {
      const r = lineRange(t, lineOfOffset(t, a));
      a = r.start; b = r.end;
    }
    return { source: t.slice(a, b), lineOffset: lineOfOffset(t, a) - 1 };
  }
  /** The editor's own keys (PLAN D12): Run = Ctrl+Enter, Run selection = Ctrl+Shift+Enter, Abort = Escape. */
  function editorAction(e) {
    if (!e) return null;
    const mod = !!(e.ctrlKey || e.metaKey);
    if (e.key === 'Enter' && mod && !e.altKey) return e.shiftKey ? 'runSelection' : 'run';
    if (e.key === 'Escape' && !mod && !e.altKey && !e.shiftKey) return 'abort';
    return null;
  }
  /** Whether the editor text fits the setting that keeps it across a reload. */
  function persistable(text) {
    const t = String(text);
    return t.length <= EDITOR_MAX && JSON.stringify(t).length <= SETTING_JSON_MAX;
  }
  /** The Macro Error window's text: ImageJ's dialog text verbatim; an internal failure of the interpreter (a JS exception, whose text is
   *  technical) becomes the platform's sentence. → { text, line, message } */
  function errorDisplay(error, tr) {
    if (!error) return null;
    const line = Number.isFinite(Number(error.line)) ? Number(error.line) : 0;
    let message = String(error.message === undefined || error.message === null ? '' : error.message);
    if (/^Internal error/.test(message)) message = tr('err.unknown');
    const text = typeof error.dialogText === 'string' && error.dialogText ? error.dialogText : message + '\n' + tr('dlg.mac.line', { n: line });
    return { text, line, message };
  }
  /** A multi-line message as dialog rows (a message row shows one line: ij-view writes it with textContent). */
  function messageFields(text, idBase) {
    const lines = String(text === undefined || text === null ? '' : text).split('\n');
    return lines.map((l, k) => ({ type: 'message', id: idBase + ':' + k, label: l === '' ? NBSP : l }));
  }
  /** The worker's DlgField list (INTEGRATION.md §4.1) → IJViewPure fields. Labels are macro data: plain `label`, never a key. */
  function viewFields(fields) {
    const out = [];
    for (const f of Array.isArray(fields) ? fields : []) {
      if (!f || typeof f.id !== 'string' || !f.id) throw macroError('dialog field without id');
      const label = f.label === undefined || f.label === null || f.label === '' ? NBSP : String(f.label);
      const opts = () => (Array.isArray(f.options) ? f.options : []).map((o) => (o && typeof o === 'object'
        ? { value: o.value, label: String(o.label === undefined || o.label === null ? o.value : o.label) }
        : { value: o, label: String(o) }));
      const fin = (x) => typeof x === 'number' && Number.isFinite(x);
      switch (f.type) {
        case 'message': out.push(...messageFields(f.label !== undefined ? f.label : f.value, f.id)); break;
        case 'number': {
          const g = { type: 'number', id: f.id, label, value: Number(f.value) };
          if (fin(f.decimals)) g.decimals = f.decimals;
          if (fin(f.min)) g.min = f.min;
          if (fin(f.max)) g.max = f.max;
          // Dialog.addNumber(label, value, decimals, columns, units): the units are macro data, shown as given
          if (typeof f.units === 'string' && f.units !== '') g.units = f.units;
          out.push(g); break;
        }
        case 'slider': {
          const g = { type: 'slider', id: f.id, label, value: Number(f.value), min: fin(f.min) ? f.min : 0, max: fin(f.max) ? f.max : 100 };
          if (fin(f.step)) g.step = f.step;
          if (fin(f.decimals)) g.decimals = f.decimals;
          out.push(g); break;
        }
        case 'check': out.push({ type: 'check', id: f.id, label, value: !!f.value }); break;
        case 'choice':
        case 'radio': {
          const g = { type: f.type, id: f.id, label, value: f.value, options: opts() };
          if (fin(f.columns)) g.columns = f.columns;
          out.push(g); break;
        }
        case 'string': out.push({ type: 'string', id: f.id, label, value: String(f.value === undefined || f.value === null ? '' : f.value) }); break;
        case 'textarea': {
          const g = { type: 'textarea', id: f.id, label, value: String(f.value === undefined || f.value === null ? '' : f.value) };
          if (fin(f.rows)) g.rows = f.rows;
          out.push(g); break;
        }
        case 'doc': out.push({ type: 'doc', id: f.id, label, value: f.value, options: opts() }); break;
        default: throw macroError('dialog field type ' + String(f.type));
      }
    }
    return out;
  }
  /** The macro preference map of the stored entry (CALL-WHITELIST §6): anything else = empty. */
  function parsePrefs(raw) {
    let o = null;
    try { o = typeof raw === 'string' ? JSON.parse(raw) : null; } catch (_) { o = null; }
    const out = {};
    if (!o || typeof o !== 'object' || o.v !== 1 || !o.prefs || typeof o.prefs !== 'object' || Array.isArray(o.prefs)) return out;
    for (const k of Object.keys(o.prefs)) if (typeof o.prefs[k] === 'string') out[k] = o.prefs[k];
    return out;
  }
  /** stored map + this run's changed keys (string values only) → the new map; the stored map is not modified. */
  function mergePrefs(stored, writes) {
    const out = Object.assign({}, stored || {});
    if (writes && typeof writes === 'object') for (const k of Object.keys(writes)) if (typeof writes[k] === 'string') out[k] = writes[k];
    return out;
  }
  /** FNV-1a (32 bits) of a byte table, hex: the name of a LUT a macro made (setLut). */
  function fnvHex(bytes) {
    let h = 0x811c9dc5;
    for (let i = 0; i < bytes.length; i++) { h ^= bytes[i] & 255; h = Math.imul(h, 16777619) >>> 0; }
    return h.toString(16);
  }
  const emptyTable = (name) => ({ name, size: 0, headings: [], columns: {}, labels: null, rev: 0 });
  function macroError(text) { return Object.assign(new Error(text), { code: 'IJ_BAD_ARGS' }); }
  const docIdsOf = (x) => (Array.isArray(x) ? x.filter((v) => v !== null && v !== undefined) : []);
  /** Whether a raw Log line opens the Log window (\\Clear and \\Close do not: ImageJ's IJ.log). */
  const opensLog = (raw) => !(typeof raw === 'string' && (raw === '\\Close' || raw.indexOf('\\Clear') === 0));

  /** The Log magic of ImageJ through the shared pure implementation (ij-proc-macro.js), so the page and the worker agree. */
  function applyLogLines(lines, raw) {
    const P = typeof IJMacroProto !== 'undefined' && IJMacroProto && IJMacroProto.log && typeof IJMacroProto.log.apply === 'function' ? IJMacroProto.log : null;
    if (P) return P.apply(lines, raw);
    // the package's page copy is absent: plain lines (the macro commands are disabled in that case, this only keeps a stray event harmless)
    return lines.concat(raw.filter((r) => typeof r === 'string' && opensLog(r)));
  }
  const isDropMarker = (l) => !!l && typeof l === 'object' && Number.isFinite(l.dropped);

  // ───────────────────────────── state ─────────────────────────────

  const M = {
    seq: 0,
    log: [],                       // the Log, raw lines as IJMacroProto.log.apply keeps them (a { dropped } marker first when capped)
    texts: new Map(),              // [Title] text windows: title → lines
    activeText: null,
    editorText: null,              // loaded from the setting on first use
    persisted: null,               // the value last written to the setting
    notPersisted: false,
    persistTimer: 0,
    lastError: null,               // { text, line, editorLine | null }
    errorLine: 0,                  // editor line marked as the error line (0 = none)
    run: null,                     // { runId, lineOffset } while a run started here is in progress
    status: { kind: 'idle', text: '' },
    memPrefs: null,                // the preferences when localStorage is unusable
    panels: { editor: new Set(), log: new Set(), error: new Set(), text: new Set() },
    renderTimer: 0
  };

  const apiOf = () => IJApp.apiFor('macro');
  const trOf = (a) => (k, p) => a.tr(k, p);
  function notify(kind) { for (const inst of M.panels[kind]) { try { inst.render(); } catch (err) { console.error('[advanced-studio] macro panel', err); } } }
  function scheduleRender() {
    if (M.renderTimer) return;
    M.renderTimer = setTimeout(() => { M.renderTimer = 0; notify('log'); notify('text'); }, RENDER_MS);
  }
  // Opening a panel is asynchronous: opens and closes go through one chain so a \Close right after a line closes what the line opened.
  let windowOps = Promise.resolve();
  function windowOp(id, fn) { windowOps = windowOps.then(fn).catch((err) => console.error('[advanced-studio] macro panel ' + id, err)); return windowOps; }
  const openQuiet = (a, id, focus) => windowOp(id, () => a.openPanel(id, { focus: !!focus }));
  const closeQuiet = (a, id) => windowOp(id, () => a.closePanel(id));

  // ── Log ──
  function logLines() {
    const a = apiOf();
    return M.log.map((l) => (isDropMarker(l) ? a.tr('dlg.mac.linesDropped', { n: l.dropped }) : String(l)));
  }
  function receiveLog(a, raw) {
    if (!Array.isArray(raw) || !raw.length) return;
    let show = null;
    for (const r of raw) { if (r === '\\Close') show = false; else if (opensLog(r)) show = true; }
    M.log = applyLogLines(M.log, raw.map(String));
    if (show === true) openQuiet(a, 'macroLog');
    else if (show === false) closeQuiet(a, 'macroLog');
    scheduleRender();
  }
  // ── [Title] text windows (print("[Title]", …), String.show) ──
  function printToWindow(a, title, text) {
    const t = String(title);
    if (text === '\\Close') { M.texts.delete(t); if (M.activeText === t) M.activeText = M.texts.size ? Array.from(M.texts.keys())[0] : null; if (!M.texts.size) closeQuiet(a, 'macroText'); scheduleRender(); return; }
    M.texts.set(t, applyLogLines(M.texts.get(t) || [], [String(text)]));
    M.activeText = t;
    openQuiet(a, 'macroText');
    scheduleRender();
  }

  // ── macro preferences ──
  function readPrefs() {
    try {
      const raw = localStorage.getItem(PREFS_KEY);
      return parsePrefs(raw);
    } catch (_) { return Object.assign({}, M.memPrefs || {}); }
  }
  function writePrefsBack(writes) {
    if (!writes || typeof writes !== 'object' || !Object.keys(writes).length) return;
    let stored;
    let usable = true;
    try { stored = parsePrefs(localStorage.getItem(PREFS_KEY)); } catch (_) { usable = false; stored = M.memPrefs || {}; }
    const next = mergePrefs(stored, writes);
    M.memPrefs = next;
    if (!usable) return;
    try { localStorage.setItem(PREFS_KEY, JSON.stringify({ v: 1, prefs: next })); } catch (err) { console.error('[advanced-studio] macro preferences', err); }
  }

  // ── editor text ──
  function editorText(a) {
    if (M.editorText === null) {
      let v = '';
      try { v = a.settings.get(EDITOR_SETTING); } catch (err) { console.error('[advanced-studio] macro editor text', err); }
      M.editorText = typeof v === 'string' ? v : '';
      M.persisted = M.editorText;
    }
    return M.editorText;
  }
  function persistEditor(a) {
    clearTimeout(M.persistTimer);
    M.persistTimer = 0;
    const text = M.editorText === null ? '' : M.editorText;
    const ok = persistable(text);
    const value = ok ? text : '';
    if (value !== M.persisted) {
      try { a.settings.set(EDITOR_SETTING, value); M.persisted = value; } catch (err) { console.error('[advanced-studio] macro editor text', err); }
    }
    if (M.notPersisted !== !ok) { M.notPersisted = !ok; notify('editor'); }
  }
  function schedulePersist(a) {
    clearTimeout(M.persistTimer);
    M.persistTimer = setTimeout(() => persistEditor(a), PERSIST_MS);
  }

  // ───────────────────────────── the RPC host ─────────────────────────────

  /** Write-behind ops (§4.2): each one changes page state, returns nothing to the macro. */
  const WRITES = {
    'roi.set': (a, x) => a.setRoi(x.roi || null, { docId: x.docId }),
    'display.set': (a, x) => a.setDisplay(x.docId, x.c, { min: x.min, max: x.max }),
    'display.lut': async (a, x) => {
      if (x.table !== undefined && x.table !== null) {
        const t = Uint8Array.from(x.table);
        if (t.length !== 768) throw macroError('display.lut: table');
        const name = 'macro-' + fnvHex(t);
        await a.registerLut(name, t);
        return a.setDisplay(x.docId, x.c, { lut: name });
      }
      return a.setDisplay(x.docId, x.c, { lut: String(x.name) });
    },
    'display.mode': (a, x) => a.setDisplayMode(x.docId, x.mode),
    'display.visible': (a, x) => a.macro.setVisible(x.docId, Array.isArray(x.visible) ? x.visible.map(Boolean) : []),
    'thr.set': (a, x) => a.macro.thresholds.set(x.docId, x.c, { lower: x.lower, upper: x.upper, dark: !!x.dark }),
    'thr.reset': (a, x) => a.macro.thresholds.reset(x.docId, x.c),
    'thr.mode': (a, x) => a.macro.thresholdMode(x.mode),
    'table.replace': (a, x) => (x.name === 'Results' ? a.macro.results.replace(x.table) : a.macro.tables.replace(String(x.name), x.table)),
    'table.remove': (a, x) => (x.name === 'Results' ? a.macro.results.replace(emptyTable('Results')) : a.macro.tables.remove(String(x.name))),
    // IJ.renameResults: the Results table moves to a named table and back
    'table.rename': async (a, x) => {
      const from = String(x.from), to = String(x.to);
      if (from === to) return undefined;
      if (from === 'Results') {
        await a.macro.tables.replace(to, Object.assign({}, a.macro.results.get(), { name: to }));
        return a.macro.results.replace(emptyTable('Results'));
      }
      if (to === 'Results') {
        const t = a.macro.tables.get(from);
        if (!t) return undefined;
        await a.macro.results.replace(Object.assign({}, t, { name: 'Results' }));
        return a.macro.tables.remove(from);
      }
      return a.macro.tables.rename(from, to);
    },
    'table.show': (a, x) => (x.name === 'Results' ? a.openTool('results') : a.macro.tables.show(String(x.name))),
    'rm.set': (a, x) => a.roiManager.set(Array.isArray(x.list) ? x.list : []),
    'rm.select': (a, x) => a.roiManager.select(Array.isArray(x.indices) ? x.indices : []),
    'rm.show': (a, x) => a.macro.roiManagerShow({ showAll: !!x.showAll, labels: !!x.labels }),
    'setting.set': (a, x) => a.macro.settings.set(x.key, x.value),
    'measurements.set': (a, x) => {
      const p = {};
      if (x.groups !== undefined) p.groups = x.groups;
      if (x.decimals !== undefined) p.decimals = x.decimals;
      return a.macro.measurements.set(p);
    },
    'colors.set': (a, x) => {
      const p = {};
      for (const k of ['foreground', 'background', 'selection']) if (x[k] !== undefined) p[k] = x[k];
      return a.macro.colors.set(p);
    },
    'tool.set': (a, x) => a.setTool(x.id),
    'status.show': (a, x) => a.macro.status(String(x.text === undefined || x.text === null ? '' : x.text)),
    'progress.show': (a, x) => a.macro.progress(x.fraction === null || x.fraction === undefined ? null : Number(x.fraction))
  };

  /** A write that fails (an image closed in between, a range the page refuses) is logged and the next one runs: the reply's mirror
   *  hands the page's real state back to the worker. An op outside the closed list is a bug of the worker side → the request fails. */
  async function applyWrites(a, writes) {
    if (!Array.isArray(writes)) return null;
    for (const w of writes) {
      const op = Array.isArray(w) ? w[0] : undefined;
      const fn = typeof op === 'string' && Object.prototype.hasOwnProperty.call(WRITES, op) ? WRITES[op] : null;
      if (!fn) return a.tr('err.macNotInBrowser', { name: String(op) });
      try { await fn(a, (w[1] && typeof w[1] === 'object') ? w[1] : {}); } catch (err) { console.error('[advanced-studio] macro write ' + op, err); }
    }
    return null;
  }

  /** Dialogs the macro opens close when the run ends (abort, crash, unmount): the lane's signal goes into each spec. */
  function dialogSpec(a, spec) { return Object.assign(spec, { signal: a.macro.signal() }); }
  const strOf = (v) => String(v === undefined || v === null ? '' : v);

  async function messageBox(a, title, text, okLabel) {
    return a.dialog(dialogSpec(a, { title: strOf(title), fields: messageFields(text, 'm'), okLabel: okLabel || a.tr('dlg.ok') }));
  }

  /** getBoolean: ImageJ's YesNoCancelDialog (Yes, No, Cancel). */
  async function askBoolean(a, x) {
    const yes = strOf(x.yes).trim() || a.tr('dlg.yes');
    const no = strOf(x.no).trim() || a.tr('dlg.no');
    const signal = a.macro.signal();
    if (signal && signal.aborted) return { cancelled: true };
    if (typeof Dialog !== 'undefined' && Dialog && typeof Dialog.ask === 'function') {
      const onAbort = () => { if (typeof Dialog.close === 'function') Dialog.close('cancel'); };
      if (signal) signal.addEventListener('abort', onAbort);
      try {
        const id = await Dialog.ask({ title: strOf(x.title), message: strOf(x.message), dismissId: 'cancel',
          options: [{ id: 'yes', label: yes, primary: true }, { id: 'no', label: no }, { id: 'cancel', label: a.tr('dlg.cancel') }] });
        return id === 'yes' ? { value: true } : id === 'no' ? { value: false } : { cancelled: true };
      } finally { if (signal) signal.removeEventListener('abort', onAbort); }
    }
    const v = await a.dialog(dialogSpec(a, { title: strOf(x.title), okLabel: a.tr('dlg.ok'), fields: messageFields(x.message, 'm').concat([
      { type: 'radio', id: 'answer', label: NBSP, value: 'yes', options: [{ value: 'yes', label: yes }, { value: 'no', label: no }] }]) }));
    return v ? { value: v.answer === 'yes' } : { cancelled: true };
  }

  function selectableTitle(a, t) {
    if (Object.prototype.hasOwnProperty.call(TOOL_TITLES, t)) return 'tool';
    if (t === 'Log') return 'log';
    if (a.macro.tables.list().indexOf(t) >= 0) return 'table';
    if (M.texts.has(t)) return 'text';
    return null;
  }

  /** List.setCommands: the commands a macro can name, with the Studio package as ImageJ's "class" (PLAN §9.2). */
  function commandList(a) {
    const C = typeof IJMacroCmds !== 'undefined' ? IJMacroCmds : null;
    if (!C || !C.MACRO_COMMANDS) return [];
    const live = new Set(a.commands().map((c) => c.id));
    const pkgOf = new Map((IJApp.COMMANDS || []).map((c) => [c.id, c.pkg || 'core']));
    const out = [];
    for (const id of Object.keys(C.MACRO_COMMANDS)) {
      if (!live.has(id)) continue;
      const name = typeof C.nameOf === 'function' ? C.nameOf(id) : (C.MACRO_COMMANDS[id] && C.MACRO_COMMANDS[id].name);
      if (typeof name === 'string' && name) out.push([name, pkgOf.get(id) || 'core']);
    }
    return out;
  }

  /** RPC methods (§4.1), one handler each. */
  const RPC = {
    run: (a, x) => a.macro.runCommand(strOf(x.name), x.options === undefined ? null : x.options,
      { current: x.current === undefined ? null : x.current, vars: x.vars && typeof x.vars === 'object' ? x.vars : {}, alt: !!x.alt, shift: !!x.shift,
        rgbWeights: Array.isArray(x.rgbWeights) ? x.rgbWeights : null }),
    'dialog.show': async (a, x) => {
      const spec = { title: strOf(x.title), fields: viewFields(x.fields), okLabel: x.okLabel ? String(x.okLabel) : a.tr('dlg.ok') };
      // GenericDialog.hideCancelButton (Dialog.create has a Cancel button by default)
      if (x.cancel === false) spec.noCancel = true;
      const v = await a.dialog(dialogSpec(a, spec));
      if (!v) return { cancelled: true };
      const values = {};
      for (const f of x.fields || []) if (f && f.type !== 'message' && Object.prototype.hasOwnProperty.call(v, f.id)) values[f.id] = v[f.id];
      return { values };
    },
    'dialog.message': async (a, x) => { await messageBox(a, x.title, x.text); return {}; },
    'dialog.messageCancel': async (a, x) => ({ ok: (await messageBox(a, x.title, x.text)) !== null }),
    // WaitForUserDialog: non-modal; the lane is paused, so the operator may use the menus and tools meanwhile
    'dialog.waitForUser': async (a, x) => {
      const resume = a.macro.pause();
      try {
        const v = await a.dialog(dialogSpec(a, { title: strOf(x.title), fields: messageFields(x.text, 'm'), okLabel: a.tr('dlg.ok'), nonModal: true }));
        return { ok: v !== null };
      } finally { resume(); }
    },
    // Functions.getNumber: "int decimalPlaces = (int)defaultValue==defaultValue?0:2;"
    'dialog.number': async (a, x) => {
      const value = Number(x.value);
      const v = await a.dialog(dialogSpec(a, { title: strOf(x.title), okLabel: a.tr('dlg.ok'),
        fields: [{ type: 'number', id: 'value', label: strOf(x.prompt) || NBSP, value, decimals: Number.isInteger(value) ? 0 : 2 }] }));
      return v && typeof v.value === 'number' ? { value: v.value } : { cancelled: true };
    },
    'dialog.string': async (a, x) => {
      const v = await a.dialog(dialogSpec(a, { title: strOf(x.title), okLabel: a.tr('dlg.ok'),
        fields: [{ type: 'string', id: 'value', label: strOf(x.prompt) || NBSP, value: strOf(x.value) }] }));
      return v ? { value: strOf(v.value) } : { cancelled: true };
    },
    'dialog.boolean': askBoolean,
    'error.show': async (a, x) => { await messageBox(a, a.tr('dlg.mac.errorTitle'), x.text); return {}; },
    'image.select': async (a, x) => { await a.macro.selectImage(x.docId); return { current: x.docId }; },
    'image.close': async (a, x) => ({ closed: (await a.macro.closeImages(docIdsOf(x.docIds))) || [] }),
    'image.show': async (a, x) => { await a.macro.showImages(docIdsOf(x.docIds)); return {}; },
    'image.adopt': async (a, x) => ({ id: await a.macro.adopt(x.docId) }),
    'window.select': async (a, x) => {
      const t = strOf(x.title);
      const kind = selectableTitle(a, t);
      if (kind === 'tool') await a.openTool(TOOL_TITLES[t]);
      else if (kind === 'log') await a.openPanel('macroLog', { focus: true });
      else if (kind === 'table') await a.macro.tables.show(t);
      else if (kind === 'text') { M.activeText = t; await a.openPanel('macroText', { focus: true }); notify('text'); }
      return { found: kind !== null };
    },
    // Functions.close(pattern): a TextWindow titled "Results" runs "Clear Results" first; the Log's lines go with its window
    'window.close': async (a, x) => {
      const t = strOf(x.title);
      if (t === 'Log') { M.log = []; closeQuiet(a, 'macroLog'); notify('log'); return { closed: true }; }
      if (t === 'Results') { await a.macro.results.replace(emptyTable('Results')); if (a.macro.closeTool) a.macro.closeTool('results'); return { closed: true }; }
      if (M.texts.has(t)) { printToWindow(a, t, '\\Close'); return { closed: true }; }
      if (a.macro.tables.list().indexOf(t) >= 0) { await a.macro.tables.remove(t); return { closed: true }; }
      if (Object.prototype.hasOwnProperty.call(TOOL_TITLES, t) && a.macro.closeTool) return { closed: !!a.macro.closeTool(TOOL_TITLES[t]) };
      return { closed: false };
    },
    'clipboard.copy': async (a, x) => {
      try { await a.copyText(strOf(x.text)); return { ok: true }; } catch (err) { console.error('[advanced-studio] macro clipboard', err); return { ok: false }; }
    },
    flush: () => ({}),
    'image.rename': async (a, x) => { await a.rename(x.docId, strOf(x.title)); return {}; },
    'window.print': (a, x) => { printToWindow(a, strOf(x.title), strOf(x.text)); return {}; },
    'command.list': (a) => ({ commands: commandList(a) })
  };

  /** The text a failed method sends back: the platform sentence of a known error code, never the exception's message. */
  function failText(a, err) {
    const key = err && typeof IJApp.errorKey === 'function' ? IJApp.errorKey(err) : '';
    return key ? a.tr(key) : a.tr('err.unknown');
  }

  /**
   * The host of one run: listens to the run's ext:macro.rpc / ext:macro.log events, serves one request at a time in arrival order and
   * drops whatever arrives once the lane is gone (abort, crash, unmount: no reply, §3.2).
   */
  function makeHost(a, runId) {
    let chain = Promise.resolve();
    let disposed = false;
    const alive = () => { const r = a.macro.running(); return !disposed && !!r && r.runId === runId; };
    async function serve(ev) {
      if (!alive()) return;
      let reply;
      try {
        const bad = await applyWrites(a, ev.writes);
        if (bad !== null) reply = { ok: false, error: { text: bad } };
        else if (!alive()) return;
        else {
          const fn = typeof ev.method === 'string' && Object.prototype.hasOwnProperty.call(RPC, ev.method) ? RPC[ev.method] : null;
          if (!fn) reply = { ok: false, error: { text: a.tr('err.macNotInBrowser', { name: strOf(ev.method) }) } };
          else {
            if (typeof a.macro.takeError === 'function') a.macro.takeError();
            const result = await fn(a, ev.args && typeof ev.args === 'object' ? ev.args : {});
            // a page method that reported its error instead of throwing (rename …): the request fails with it
            const reported = typeof a.macro.takeError === 'function' ? a.macro.takeError() : null;
            reply = reported ? { ok: false, error: { text: failText(a, reported) } } : { ok: true, result };
          }
        }
      } catch (err) {
        console.error('[advanced-studio] macro request ' + strOf(ev.method), err);
        reply = { ok: false, error: { text: failText(a, err) } };
      }
      if (!alive()) return;
      const msg = Object.assign({ runId, reqId: ev.reqId }, reply);
      // a flush (the write-behind batch) needs no mirror: the worker drops it
      if (reply.ok && ev.method !== 'flush') msg.mirror = a.macro.mirror();
      await a.call('macro.reply', msg);
    }
    const offs = [
      a.on('ext:macro.rpc', (ev) => {
        if (!ev || ev.runId !== runId || disposed) return;
        chain = chain.then(() => serve(ev)).catch((err) => console.error('[advanced-studio] macro reply', err));
      }),
      a.on('ext:macro.log', (ev) => { if (ev && ev.runId === runId && !disposed) receiveLog(a, ev.lines); })
    ];
    return {
      dispose() { disposed = true; for (const off of offs) { try { off(); } catch (_) { /* the view is gone */ } } },
      idle: () => chain
    };
  }

  // ───────────────────────────── runs ─────────────────────────────

  function setStatus(kind, text) { M.status = { kind, text }; notify('editor'); }
  function textsFor(a) {
    const out = {};
    const keys = typeof IJMacroProto !== 'undefined' && IJMacroProto && Array.isArray(IJMacroProto.TEXT_KEYS) ? IJMacroProto.TEXT_KEYS : [];
    for (const k of keys) out[k] = a.tr(k);
    return out;
  }

  /**
   * Runs a macro text. o = { name, arg, lineOffset } — lineOffset: the editor line of the source's line 1 minus one when the text comes
   * from the editor (the error line is then marked there); null otherwise. → RunResult (§3.1).
   */
  async function startRun(source, o) {
    const opt = o || {};
    const a = apiOf();
    if (!a.macro) throw Object.assign(new Error('package macro is not available'), { code: 'IJ_MODULE_MISSING' });
    if (M.run || a.macro.running()) throw Object.assign(new Error('a macro is running'), { code: 'IJ_MACRO_BUSY' });
    // the operator's own long step still runs (api.macro.start refuses it too)
    if (typeof a.state === 'function' && a.state().busy) throw Object.assign(new Error('a step is running'), { code: 'IJ_MACRO_STEP_BUSY' });
    if (M.persistTimer) persistEditor(a);
    const runId = 'r' + (++M.seq);
    const lineOffset = Number.isInteger(opt.lineOffset) ? opt.lineOffset : null;
    const host = makeHost(a, runId);
    M.run = { runId, lineOffset };
    if (lineOffset !== null && M.errorLine) { M.errorLine = 0; notify('editor'); }
    setStatus('running', a.tr('dlg.mac.running'));
    let result = null;
    try {
      result = await a.macro.start({
        runId, source: String(source), name: opt.name ? String(opt.name) : 'Macro', arg: strOf(opt.arg),
        texts: textsFor(a), prefs: readPrefs(), log: logLines(), options: { fastPath: true, syncLoops: false, syncRecursion: false }
      });
    } catch (err) {
      setStatus('idle', '');
      throw err;
    } finally {
      host.dispose();
      M.run = null;
    }
    finishRun(a, result, lineOffset);
    return result;
  }

  function finishRun(a, result, lineOffset) {
    const r = result || {};
    writePrefsBack(r.prefsWrites);
    const undo = r.undo && Array.isArray(r.undo.dropped) ? r.undo.dropped : [];
    if (undo.length) {
      const docs = (a.state() && a.state().docs) || [];
      for (const id of undo) { const d = docs.find((x) => x.docId === id); a.toast('warn.macUndoDropped', { title: d && d.name ? d.name : String(id) }); }
    }
    const tr = trOf(a);
    if (r.error && !r.error.silent) {
      const d = errorDisplay(r.error, tr);
      if (/^Internal error/.test(String(r.error.message))) console.error('[advanced-studio] macro', r.error.message);
      M.lastError = { text: d.text, line: d.line, editorLine: lineOffset !== null && d.line > 0 ? d.line + lineOffset : null };
      if (M.lastError.editorLine) M.errorLine = M.lastError.editorLine;
      setStatus('error', tr('dlg.mac.line', { n: d.line }) + ': ' + d.message.split('\n')[0]);
      notify('error');
      openQuiet(a, 'macroError', true);
    } else if (r.aborted) setStatus('aborted', tr('dlg.mac.aborted'));
    else setStatus('finished', tr('dlg.mac.finished'));
  }

  function abortRun() {
    const a = apiOf();
    if (a.macro && a.macro.running()) a.macro.abort();
  }

  // ───────────────────────────── windows ─────────────────────────────

  function el(tag, props) {
    const e = document.createElement(tag);
    if (props) {
      for (const k of Object.keys(props)) {
        const v = props[k];
        if (v === null || v === undefined || v === false) continue;
        if (k === 'class') e.className = v;
        else if (k === 'text') e.textContent = v;
        else if (k === 'on') { for (const ev of Object.keys(v)) e.addEventListener(ev, v[ev]); }
        else if (k === 'attrs') { for (const at of Object.keys(v)) e.setAttribute(at, v[at]); }
        else e[k] = v;
      }
    }
    for (let i = 2; i < arguments.length; i++) {
      const kids = Array.isArray(arguments[i]) ? arguments[i] : [arguments[i]];
      for (const kid of kids) if (kid) e.appendChild(kid);
    }
    return e;
  }
  const button = (label, onClick, cls, attrs) => el('button', { type: 'button', class: 'ij-btn' + (cls ? ' ' + cls : ''), text: label, attrs, on: { click: onClick } });
  const stop = (e) => { if (e.preventDefault) e.preventDefault(); if (e.stopPropagation) e.stopPropagation(); };
  // a run started here counts from the click: api.macro.start commits a pending paste before the lane exists
  const running = () => { if (M.run) return true; const a = apiOf(); return !!(a.macro && a.macro.running()); };

  /** Macro Editor: a plain textarea with line numbers; keyboard only works (the Tab key keeps moving the focus). */
  function buildEditor(rootEl, papi) {
    const text = editorText(papi);
    const ta = el('textarea', { class: 'ij-mac-text', wrap: 'off', value: text,
      attrs: { spellcheck: 'false', 'aria-label': papi.tr('dlg.mac.editorTitle'), autocomplete: 'off', autocapitalize: 'off', 'aria-keyshortcuts': 'Control+Enter Control+Shift+Enter Escape' } });
    const gutter = el('div', { class: 'ij-mac-gutter', attrs: { 'aria-hidden': 'true' } });
    const status = el('span', { class: 'ij-mac-status', attrs: { role: 'status', 'aria-live': 'polite' } });
    const note = el('p', { class: 'ij-note', text: papi.tr('dlg.mac.notPersisted') });
    const runBtn = button(papi.tr('dlg.mac.run'), () => runFrom(false), 'ij-btn--primary', { title: papi.tr('dlg.mac.run') + ' (Ctrl+Enter)', 'aria-keyshortcuts': 'Control+Enter' });
    const selBtn = button(papi.tr('dlg.mac.runSelection'), () => runFrom(true), '', { title: papi.tr('dlg.mac.runSelection') + ' (Ctrl+Shift+Enter)', 'aria-keyshortcuts': 'Control+Shift+Enter' });
    const abortBtn = button(papi.tr('dlg.mac.abort'), () => abortRun(), 'ij-btn--danger', { title: papi.tr('dlg.mac.abort') + ' (Esc)', 'aria-keyshortcuts': 'Escape' });
    let gutterKey = '';

    function paintGutter() {
      const n = lineStarts(ta.value).length;
      const key = n + ':' + M.errorLine;
      if (key === gutterKey) return;
      gutterKey = key;
      const rows = [];
      for (let i = 1; i <= n; i++) rows.push(el('div', { class: 'ij-mac-gutter-line' + (i === M.errorLine ? ' ij-mac-err' : ''), text: String(i) }));
      gutter.replaceChildren(...rows);
      gutter.scrollTop = ta.scrollTop;
    }
    function render() {
      const busy = running();
      runBtn.disabled = busy; selBtn.disabled = busy; abortBtn.disabled = !busy;
      status.textContent = M.status.text;
      status.className = 'ij-mac-status' + (M.status.kind === 'error' ? ' ij-mac-status-err' : '');
      note.hidden = !M.notPersisted;
      paintGutter();
    }
    function showLine(n) {
      const r = lineRange(ta.value, n);
      if (!r) return;
      if (typeof ta.focus === 'function') ta.focus();
      if (typeof ta.setSelectionRange === 'function') ta.setSelectionRange(r.start, r.end);
      ta.scrollTop = Math.max(0, (n - 3) * LINE_PX);
      gutter.scrollTop = ta.scrollTop;
    }
    function runFrom(selection) {
      if (running()) { papi.toast('err.macBusy'); return; }
      const st = typeof papi.state === 'function' ? papi.state() : null;
      if (st && st.busy) { papi.toast('err.macStepBusy'); return; }
      let source = ta.value, lineOffset = 0;
      if (selection) {
        const s = runSlice(ta.value, ta.selectionStart || 0, ta.selectionEnd || 0);
        source = s.source; lineOffset = s.lineOffset;
      }
      if (!source.trim()) { papi.toast('dlg.mac.empty'); return; }
      startRun(source, { name: 'Macro', lineOffset }).catch((err) => papi.error(err));
      render();
    }
    ta.addEventListener('keydown', (e) => {
      const act = editorAction(e);
      if (act === 'run' || act === 'runSelection') { stop(e); runFrom(act === 'runSelection'); }
      else if (act === 'abort' && running()) { stop(e); abortRun(); }
    });
    ta.addEventListener('input', () => { M.editorText = ta.value; schedulePersist(papi); paintGutter(); });
    ta.addEventListener('scroll', () => { gutter.scrollTop = ta.scrollTop; });
    rootEl.appendChild(el('div', { class: 'ij-mac-editor' },
      el('div', { class: 'ij-mac-toolbar' }, runBtn, selBtn, abortBtn, status),
      el('div', { class: 'ij-mac-body' }, gutter, ta),
      note));
    const inst = { render, showLine, _state: () => ({ ta, gutter, status, note, runBtn, selBtn, abortBtn }) };
    M.panels.editor.add(inst);
    render();
    if (typeof ta.focus === 'function') ta.focus();
    return {
      refresh() { render(); },
      dispose() { M.panels.editor.delete(inst); if (M.persistTimer) persistEditor(papi); },
      showLine, _state: inst._state
    };
  }

  /** A text pane for the Log and the [Title] windows: one <pre>, kept scrolled to the end while it was at the end. */
  function textPane() {
    const pre = el('pre', { class: 'ij-mac-pre', tabIndex: 0 });
    return {
      pre,
      set(text) {
        const atEnd = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 4;
        pre.textContent = text;
        if (atEnd) pre.scrollTop = pre.scrollHeight;
      }
    };
  }
  async function copyFromClick(papi, text) {
    try { await papi.copyText(text); } catch (err) { console.error('[advanced-studio] macro clipboard', err); papi.toast('err.macClipboard'); }
  }

  function buildLog(rootEl, papi) {
    const pane = textPane();
    pane.pre.setAttribute('aria-label', papi.tr('dlg.mac.logTitle'));
    const text = () => logLines().join('\n');
    rootEl.appendChild(el('div', { class: 'ij-mac-logwin' },
      el('div', { class: 'ij-mac-toolbar' },
        button(papi.tr('dlg.mac.clear'), () => { M.log = []; notify('log'); }),
        button(papi.tr('dlg.mac.copy'), () => { copyFromClick(papi, text()); })),
      pane.pre));
    const inst = { render() { pane.set(text()); }, _state: () => ({ pre: pane.pre }) };
    M.panels.log.add(inst);
    inst.render();
    return {
      refresh() {},
      // ImageJ: the Log's lines go with its window
      dispose() { M.panels.log.delete(inst); M.log = []; },
      _state: inst._state
    };
  }

  function buildError(rootEl, papi) {
    const pane = textPane();
    pane.pre.setAttribute('aria-label', papi.tr('dlg.mac.errorTitle'));
    const line = el('span', { class: 'ij-mac-status' });
    const show = button(papi.tr('dlg.mac.showLine'), () => {
      const e = M.lastError;
      if (!e || !e.editorLine) return;
      Promise.resolve(papi.openPanel('macroEditor', { focus: true })).then(() => {
        M.errorLine = e.editorLine;
        for (const inst of M.panels.editor) { inst.render(); inst.showLine(e.editorLine); }
      }).catch((err) => papi.error(err));
    });
    rootEl.appendChild(el('div', { class: 'ij-mac-errwin' }, pane.pre, el('div', { class: 'ij-mac-toolbar' }, show, line)));
    const inst = {
      render() {
        const e = M.lastError;
        pane.set(e ? e.text : '');
        line.textContent = e && e.line > 0 ? papi.tr('dlg.mac.line', { n: e.line }) : '';
        show.hidden = !(e && e.editorLine);
      },
      _state: () => ({ pre: pane.pre, line, show })
    };
    M.panels.error.add(inst);
    inst.render();
    // reopened after a reload (persist) with nothing to show: the window goes away again
    if (!M.lastError) setTimeout(() => { if (!M.lastError) closeQuiet(papi, 'macroError'); }, 0);
    return { refresh() {}, dispose() { M.panels.error.delete(inst); }, _state: inst._state };
  }

  function buildText(rootEl, papi) {
    const tabs = el('div', { class: 'ij-mac-tabs', attrs: { role: 'tablist' } });
    const pane = textPane();
    pane.pre.setAttribute('role', 'tabpanel');
    const lines = () => (M.activeText !== null && M.texts.has(M.activeText) ? M.texts.get(M.activeText) : [])
      .map((l) => (isDropMarker(l) ? papi.tr('dlg.mac.linesDropped', { n: l.dropped }) : String(l))).join('\n');
    rootEl.appendChild(el('div', { class: 'ij-mac-textwin' }, tabs, pane.pre,
      el('div', { class: 'ij-mac-toolbar' },
        button(papi.tr('dlg.mac.clear'), () => { if (M.activeText !== null && M.texts.has(M.activeText)) { M.texts.set(M.activeText, []); notify('text'); } }),
        button(papi.tr('dlg.mac.copy'), () => { copyFromClick(papi, lines()); }))));
    let tabKey = null;
    const inst = {
      render() {
        if (M.activeText === null || !M.texts.has(M.activeText)) M.activeText = M.texts.size ? Array.from(M.texts.keys())[0] : null;
        const key = Array.from(M.texts.keys()).join('\u0001') + '\u0002' + M.activeText;
        if (key !== tabKey) {
          tabKey = key;
          tabs.replaceChildren(...Array.from(M.texts.keys()).map((t) => {
            const on = t === M.activeText;
            return el('button', { type: 'button', class: 'ij-mac-tab' + (on ? ' ij-mac-tab-active' : ''), text: t,
              attrs: { role: 'tab', 'aria-selected': on ? 'true' : 'false' }, on: { click: () => { M.activeText = t; notify('text'); } } });
          }));
        }
        pane.set(lines());
      },
      _state: () => ({ tabs, pre: pane.pre })
    };
    M.panels.text.add(inst);
    inst.render();
    if (!M.texts.size) setTimeout(() => { if (!M.texts.size) closeQuiet(papi, 'macroText'); }, 0);
    // the text of a [Title] window goes with its window, as the Log's
    return { refresh() {}, dispose() { M.panels.text.delete(inst); M.texts.clear(); M.activeText = null; }, _state: inst._state };
  }

  // ───────────────────────────── commands ─────────────────────────────

  const commands = [
    {
      // Plugins › Macros › Run…: the code to run, prefilled with the editor's text (no file of the computer in this phase)
      id: 'macRun', menu: ['Plugins', 'Macros'], order: 20,
      enabled: (st) => !(st && st.busy),
      async run(api) {
        const initial = editorText(api);
        const v = await api.dialog({ title: api.tr('dlg.mac.runTitle'), okLabel: api.tr('dlg.mac.run'),
          fields: [{ type: 'textarea', id: 'code', labelKey: 'dlg.mac.runPrompt', value: initial, rows: 14, monospace: true, remember: false }] });
        if (!v) return;
        const code = strOf(v.code);
        if (!code.trim()) { api.toast('dlg.mac.empty'); return; }
        await startRun(code, { name: 'Macro', lineOffset: code === M.editorText ? 0 : null });
      }
    },
    {
      id: 'macEdit', menu: ['Plugins', 'Macros'], order: 30,
      enabled: () => true,
      async run(api) { await api.openPanel('macroEditor', { focus: true }); }
    },
    {
      id: 'windowLog', menu: ['Window'], order: 52,
      enabled: () => true,
      async run(api) { await api.openPanel('macroLog', { focus: true }); }
    }
  ];

  IJApp.extend({
    pkg: 'macro',
    commands,
    panels: {
      macroEditor: { titleKey: 'dlg.mac.editorTitle', build: buildEditor, persist: true, defaultSize: { w: 600, h: 440 } },
      macroLog: { titleKey: 'dlg.mac.logTitle', build: buildLog, persist: true, defaultSize: { w: 480, h: 320 } },
      macroError: { titleKey: 'dlg.mac.errorTitle', build: buildError, persist: true, defaultSize: { w: 520, h: 240 } },
      macroText: { titleKey: 'dlg.mac.textTitle', build: buildText, persist: true, defaultSize: { w: 480, h: 320 } }
    },
    errors: { IJ_MACRO_BUSY: 'err.macBusy', IJ_MACRO_STEP_BUSY: 'err.macStepBusy', IJ_MACRO_GROUP: 'err.macUndoDuringRun' }
  });

  root.IJMacroPage = Object.freeze({
    run: (source, o) => startRun(source, { name: o && o.name, arg: o && o.arg, lineOffset: null }),
    abort: abortRun,
    logLines,
    // for the tests
    _internals: Object.freeze({
      RPC, WRITES, lineStarts, lineRange, lineOfOffset, runSlice, editorAction, persistable, errorDisplay,
      messageFields, viewFields, parsePrefs, mergePrefs, fnvHex, emptyTable, commandList, PREFS_KEY, EDITOR_SETTING, EDITOR_MAX,
      state: () => M,
      reset() {
        clearTimeout(M.persistTimer); clearTimeout(M.renderTimer);
        Object.assign(M, { log: [], texts: new Map(), activeText: null, editorText: null, persisted: null, notPersisted: false, persistTimer: 0, lastError: null, errorLine: 0,
          run: null, status: { kind: 'idle', text: '' }, memPrefs: null, renderTimer: 0 });
      },
      startRun
    })
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
