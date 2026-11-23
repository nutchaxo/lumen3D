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
 *
 * Files (DOCS/studio-advanced/macros/FILES.md): every file operation runs in the worker; this side only grants folders (a picker opens
 * inside the click that asked for it, never otherwise), keeps the grants and aliases in IndexedDB 'lumen3d-ij-macro', answers the
 * worker's pickers from the pre-run queue or by pausing the run, asks the overwrite / permission questions, shows the Files section of
 * the Macro Editor and hands the browser workspace's results over as downloads. A macro only ever sees virtual paths (/<Root>/…).
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

  // Files (FILES.md §3.4): the store holds grants, aliases and settings; `macros` / `params` exist for later phases (no version bump then)
  const DB_NAME = 'lumen3d-ij-macro';
  const DB_VERSION = 1;
  const DB_STORES = { roots: 'id', aliases: 'literal', settings: 'key', macros: 'id', params: 'id' };
  const MODES = ['readonly', 'ask', 'allow'];
  const DOWNLOADS_ID = 'downloads';
  const SCAN_MS = 500;
  const LINK_TTL_MS = 60000;
  const MODE_KEYS = { readonly: 'dlg.mac.files.modeReadonly', ask: 'dlg.mac.files.modeAsk', allow: 'dlg.mac.files.modeAllow' };
  const KIND_KEYS = { fsa: 'dlg.mac.files.kindFolder', snapshot: 'dlg.mac.files.kindFolder', files: 'dlg.mac.files.kindFiles', downloads: 'dlg.mac.files.kindDownloads' };
  const STATE_KEYS = { ready: 'dlg.mac.files.stateReady', prompt: 'dlg.mac.files.statePrompt', stale: 'dlg.mac.files.stateStale' };
  const CONFIRM_KEYS = { overwrite: 'dlg.mac.pause.confirmOverwrite', delete: 'dlg.mac.pause.confirmDelete', rename: 'dlg.mac.pause.confirmRename', mkdir: 'dlg.mac.pause.confirmMkdir' };
  // the archive's README is written by the worker in the operator's language
  const README_KEYS = ['dlg.mac.files.readme', 'dlg.mac.files.readmeManual', 'dlg.mac.files.readmeDelete', 'dlg.mac.files.readmeRename'];

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
  /** The worker's DlgField list (INTEGRATION.md §4.1, FILES.md §6.6) → IJViewPure fields. Labels are macro data: plain `label`, never a
   *  key. o.pathField(f, label) builds a `path` field (Dialog.addDirectory / addFile) with its Browse button; without it the field is
   *  a plain path text. */
  function viewFields(fields, o) {
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
        case 'path': out.push(o && typeof o.pathField === 'function' ? o.pathField(f, label)
          : { type: 'path', id: f.id, label, value: String(f.value === undefined || f.value === null ? '' : f.value), pathKind: f.pathKind === 'file' ? 'file' : 'directory' }); break;
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
  const DROPPED = Object.freeze({ dropped: true });
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
    editorFile: null,              // name of the .ijm / .txt file last opened in the editor (Save suggests it)
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
    noteFront(a, 'text', t);
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

  /* The front window the worker's writers read (FILES.md §5.5 mirror.front): the Log and text windows are the page's own panels. */
  function noteFront(a, kind, title) {
    try { if (a.macro && typeof a.macro.noteFront === 'function') a.macro.noteFront(kind, title); } catch (err) { console.error('[advanced-studio] macro front window', err); }
  }

  /** RPC methods (§4.1), one handler each. */
  const RPC = {
    run: (a, x) => a.macro.runCommand(strOf(x.name), x.options === undefined ? null : x.options,
      { current: x.current === undefined ? null : x.current, vars: x.vars && typeof x.vars === 'object' ? x.vars : {}, alt: !!x.alt, shift: !!x.shift,
        rgbWeights: Array.isArray(x.rgbWeights) ? x.rgbWeights : null }),
    'dialog.show': async (a, x) => {
      // the folders and files a path field took (queued answers, Browse…): the worker adds them before it reads the values
      const grants = [];
      if (Array.isArray(x.fields) && x.fields.some((f) => f && f.type === 'path')) await ensureLoaded();
      const spec = { title: strOf(x.title), fields: viewFields(x.fields, { pathField: (f, label) => pathField(f, label, grants) }),
        okLabel: x.okLabel ? String(x.okLabel) : a.tr('dlg.ok') };
      // GenericDialog.hideCancelButton (Dialog.create has a Cancel button by default)
      if (x.cancel === false) spec.noCancel = true;
      const v = await a.dialog(dialogSpec(a, spec));
      if (!v) return { cancelled: true };
      const values = {};
      for (const f of x.fields || []) if (f && f.type !== 'message' && Object.prototype.hasOwnProperty.call(v, f.id)) values[f.id] = v[f.id];
      return grants.length ? { values, grants: uniqueGrants(grants) } : { values };
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
      else if (kind === 'log') { await a.openPanel('macroLog', { focus: true }); noteFront(a, 'log', 'Log'); }
      else if (kind === 'table') await a.macro.tables.show(t);
      else if (kind === 'text') { M.activeText = t; await a.openPanel('macroText', { focus: true }); notify('text'); noteFront(a, 'text', t); }
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
    'command.list': (a) => ({ commands: commandList(a) }),
    // FILES.md §5.4
    'vfs.pick': vfsPick,
    'vfs.confirm': vfsConfirm,
    'vfs.regrant': vfsRegrant,
    // open() of an Editor file type (F20): a text window titled with the file name, never the Macro Editor that runs the macro
    'text.open': (a, x) => {
      const t = strOf(x.title);
      M.texts.set(t, strOf(x.text).split('\n'));
      M.activeText = t;
      openQuiet(a, 'macroText');
      noteFront(a, 'text', t);
      scheduleRender();
      return {};
    },
    'window.text': windowText
  };

  /** Lines as TextPanel.save writes them: each line followed by the (POSIX) line separator. */
  function linesText(lines, a) {
    return lines.map((l) => (isDropMarker(l) ? a.tr('dlg.mac.linesDropped', { n: l.dropped }) : String(l)) + '\n').join('');
  }
  /** window.text: a text window, the Log, or a table as TextPanel.saveAs writes it (ResultsTable.saveAs: tab-delimited here, the
   *  headings and row numbers as the I/O options say). */
  function windowText(a, x) {
    const t = strOf(x.title);
    if (M.texts.has(t)) return { found: true, text: linesText(M.texts.get(t), a) };
    if (t === 'Log') return { found: true, text: linesText(logLines(), a) };
    const table = t === 'Results' ? a.macro.results.get() : (a.macro.tables.list().indexOf(t) >= 0 ? a.macro.tables.get(t) : null);
    if (!table || (t === 'Results' && !table.size)) return { found: false, text: '' };
    if (typeof IJTextIo === 'undefined' || !IJTextIo || typeof IJTextIo.tableText !== 'function') throw macroError('window.text: no table writer');
    const headers = a.settings.get('ana.saveHeaders') !== false;
    const rowNumbers = a.settings.get('ana.saveRowNumbers') === true;
    return { found: true, text: IJTextIo.tableText(table, { sep: '\t', headers, rowNumbers }) };
  }

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
            // a question the run's end closed (abort, crash, unmount): the request is dropped, as every request of a gone lane
            if (result === DROPPED) return;
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
      a.on('ext:macro.log', (ev) => { if (ev && ev.runId === runId && !disposed) receiveLog(a, ev.lines); }),
      a.on('ext:macro.vfs', (ev) => { if (ev && ev.runId === runId && !disposed) vfsEvent(ev); })
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
    // the Files section's own read of the workspace changes (macro.vfs) holds the busy state for a moment: a run waits for it
    if (V.refreshing) {
      await V.refreshing;
      if (M.run || a.macro.running()) throw Object.assign(new Error('a macro is running'), { code: 'IJ_MACRO_BUSY' });
    }
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
      await ensureLoaded();
      if (V.refreshing) await V.refreshing;
      touchRoots();
      result = await a.macro.start({
        runId, source: String(source), name: opt.name ? String(opt.name) : 'Macro', arg: strOf(opt.arg),
        texts: textsFor(a), prefs: readPrefs(), log: logLines(), options: { fastPath: true, syncLoops: false, syncRecursion: false },
        vfs: vfsRunArgs()
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
    vfsAfterRun(a, r.vfs);
  }

  function abortRun() {
    const a = apiOf();
    if (a.macro && a.macro.running()) a.macro.abort();
  }

  // ───────────────────────────── files (FILES.md) ─────────────────────────────

  const VFS = () => (typeof IJMacroVFS !== 'undefined' && IJMacroVFS ? IJMacroVFS : null);
  /** Feature detection of the File System Access pickers (Chromium); never the user agent. */
  const hasFn = (name) => { try { return typeof root[name] === 'function'; } catch (_) { return false; } };
  const storageApi = () => { try { const n = root.navigator; return n && n.storage ? n.storage : null; } catch (_) { return null; } };

  function hex16() {
    const b = new Uint8Array(8);
    const c = root.crypto;
    if (c && typeof c.getRandomValues === 'function') c.getRandomValues(b);
    else for (let i = 0; i < 8; i++) b[i] = Math.floor(Math.random() * 256);
    let s = '';
    for (let i = 0; i < 8; i++) s += (b[i] < 16 ? '0' : '') + b[i].toString(16);
    return s;
  }

  const V = {
    mountId: hex16(),              // FILES.md F13 / F14: the worker's /tmp/ and dialog statics live as long as this id
    dbP: null, mem: { roots: new Map(), aliases: new Map(), settings: new Map() },
    loaded: false, loading: null,
    roots: [],                     // granted roots: the stored record + `snapshot` (this page session only)
    aliases: [],                   // AliasRecord
    perm: new Map(),               // rootId → 'granted' | 'prompt' | 'denied' (FSA queryPermission for the mode the root needs)
    settings: { defaultMode: 'ask', collapsed: false },
    queue: { folders: [], files: [] },   // answers picked before (or during) a run: { vpath, rootId }
    scan: null, scanTimer: 0, scanSeq: 0,
    needs: [],                     // machine paths without an alias: { literal, prefixes }
    levels: new Map(),             // literal → the alias level chosen in its row
    changes: new Map(), dirty: new Set(), deliveries: new Map(), changesLoaded: false, refreshing: null,
    estimate: null, persisted: null, persistAsked: false, writeRefusedNote: false,
    pause: null, pauseSeq: 0, ver: 0
  };
  function filesChanged() { V.ver++; notify('editor'); }

  // ── IndexedDB 'lumen3d-ij-macro' (an in-memory copy keeps the page session working when the store is blocked) ──
  function idbRequest(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('indexedDB request'));
    });
  }
  function openDb() {
    return new Promise((resolve) => {
      let idb = null;
      try { idb = root.indexedDB || null; } catch (_) { idb = null; }
      if (!idb || typeof idb.open !== 'function') { resolve(null); return; }
      let req;
      try { req = idb.open(DB_NAME, DB_VERSION); } catch (err) { console.error('[advanced-studio] macro files store', err); resolve(null); return; }
      req.onupgradeneeded = (e) => {
        const db = req.result || (e && e.target && e.target.result);
        for (const name of Object.keys(DB_STORES)) {
          const names = db.objectStoreNames;
          if (names && typeof names.contains === 'function' && names.contains(name)) continue;
          db.createObjectStore(name, { keyPath: DB_STORES[name] });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => { console.error('[advanced-studio] macro files store', req.error); resolve(null); };
      req.onblocked = () => resolve(null);
    });
  }
  const dbOpen = () => { if (!V.dbP) V.dbP = openDb(); return V.dbP; };
  async function dbAll(store) {
    const db = await dbOpen();
    if (db) {
      try { return await idbRequest(db.transaction([store], 'readonly').objectStore(store).getAll()) || []; } catch (err) { console.error('[advanced-studio] macro files store', err); }
    }
    return Array.from(V.mem[store].values());
  }
  async function dbPut(store, rec) {
    V.mem[store].set(rec[DB_STORES[store]], rec);
    const db = await dbOpen();
    if (!db) return;
    try { await idbRequest(db.transaction([store], 'readwrite').objectStore(store).put(rec)); } catch (err) { console.error('[advanced-studio] macro files store', err); }
  }
  async function dbDelete(store, key) {
    V.mem[store].delete(key);
    const db = await dbOpen();
    if (!db) return;
    try { await idbRequest(db.transaction([store], 'readwrite').objectStore(store).delete(key)); } catch (err) { console.error('[advanced-studio] macro files store', err); }
  }

  // ── roots ──
  const fsaFilesRoot = (r) => r.kind === 'files' && Array.isArray(r.entries);
  /** Whether the root's writes land in the browser workspace (the overlay of FILES.md §4.4). */
  const isOverlay = (r) => r.kind === 'downloads' || r.kind === 'snapshot' || (r.kind === 'files' && !Array.isArray(r.entries)) || (r.kind === 'fsa' && r.target === 'overlay');
  /** The FSA permission a root needs: writing in place needs readwrite, anything else reads. */
  const neededMode = (r) => (r.kind === 'fsa' && r.target === 'inplace' && r.mode !== 'readonly' ? 'readwrite' : 'read');
  /** The handles whose permission a root needs, with the mode each needs: a folder, or each file of a Files root of handles (a save
   *  picker's file is written in place). */
  function permTargets(r) {
    if (r.kind === 'fsa') return r.handle ? [{ handle: r.handle, mode: neededMode(r) }] : [];
    if (fsaFilesRoot(r)) return r.entries.map((e) => ({ handle: e.handle, mode: e.writable && r.mode !== 'readonly' ? 'readwrite' : 'read' }));
    return [];
  }
  const handleRoot = (r) => r.kind === 'fsa' || fsaFilesRoot(r);
  function rootState(r) {
    if (handleRoot(r)) return V.perm.get(r.id) === 'granted' ? 'ready' : 'prompt';
    if (r.kind === 'snapshot' || (r.kind === 'files' && !Array.isArray(r.entries))) return r.snapshot ? 'ready' : 'stale';
    return 'ready';
  }
  const downloadsGrant = () => ({ id: DOWNLOADS_ID, name: 'Downloads', kind: 'downloads', target: 'overlay', mode: 'allow', folderName: 'Downloads' });
  /** RootGrant (FILES.md §3.2), structured-cloned to the worker: handles and File objects travel as they are. */
  function grantOf(r) {
    if (!r) return null;
    if (r.kind === 'downloads') return downloadsGrant();
    const g = { id: r.id, name: r.name, kind: r.kind, target: isOverlay(r) ? 'overlay' : 'inplace', mode: r.mode, folderName: r.folderName };
    if (r.kind === 'fsa') g.handle = r.handle;
    if (fsaFilesRoot(r)) g.entries = r.entries.map((e) => ({ name: e.name, handle: e.handle, writable: !!e.writable }));
    else if (r.kind === 'snapshot' || r.kind === 'files') g.snapshot = r.snapshot ? { rels: r.snapshot.rels.slice(), files: r.snapshot.files.slice(), dirs: r.snapshot.dirs.slice() } : null;
    if (r.writeRefused) g.writeRefused = true;
    return g;
  }
  const rootById = (id) => V.roots.find((r) => r.id === id) || null;
  const grantById = (id) => (id === DOWNLOADS_ID ? downloadsGrant() : grantOf(rootById(id)));
  const grantsList = () => V.roots.map(grantOf).concat([downloadsGrant()]);
  function uniqueGrants(list) { const seen = new Set(); return list.filter((g) => g && !seen.has(g.id) && seen.add(g.id)); }
  const aliasesList = () => V.aliases.map((x) => ({ literal: x.literal, rootId: x.rootId, ci: !!x.ci, createdAt: x.createdAt }));

  /** The names a folder copy holds (FNV-1a of the sorted relative paths): a workspace goes back only onto the folder it was made
   *  over, never onto another folder of the same name (FILES.md §3.1). */
  function snapshotPrint(snap) {
    const rels = (snap && Array.isArray(snap.rels) ? snap.rels.map(String) : []).sort();
    const text = rels.join('\n');
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i) & 0xffff; h = Math.imul(h, 16777619) >>> 0; }
    return rels.length + ':' + h.toString(16);
  }
  /** The stored form: never the snapshot's File objects (that would copy the user's folder into the browser). */
  function recordOf(r) {
    const o = { v: 1, id: r.id, name: r.name, kind: r.kind, target: r.target, mode: r.mode, folderName: r.folderName, createdAt: r.createdAt, lastUsedAt: r.lastUsedAt };
    if (typeof r.snapPrint === 'string') o.snapPrint = r.snapPrint;
    if (r.kind === 'fsa') o.handle = r.handle;
    if (fsaFilesRoot(r)) o.entries = r.entries.map((e) => ({ name: e.name, handle: e.handle, writable: !!e.writable }));
    if (r.writeRefused) o.writeRefused = true;
    return o;
  }
  function rootFromRecord(o) {
    if (!o || o.v !== 1 || typeof o.id !== 'string' || !/^[0-9a-f]{16}$/.test(o.id) || typeof o.name !== 'string' || !o.name) return null;
    if (['fsa', 'snapshot', 'files'].indexOf(o.kind) < 0) return null;
    if (o.kind === 'fsa' && !(o.handle && typeof o.handle === 'object')) return null;
    const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
    const r = {
      id: o.id, name: o.name, kind: o.kind, mode: MODES.indexOf(o.mode) >= 0 ? o.mode : 'ask',
      target: o.kind === 'fsa' && o.target === 'inplace' && !o.writeRefused ? 'inplace' : 'overlay',
      folderName: typeof o.folderName === 'string' && o.folderName ? o.folderName : o.name, writeRefused: !!o.writeRefused,
      createdAt: num(o.createdAt), lastUsedAt: num(o.lastUsedAt), snapshot: null
    };
    if (o.kind === 'snapshot' && typeof o.snapPrint === 'string') r.snapPrint = o.snapPrint;
    if (o.kind === 'fsa') r.handle = o.handle;
    if (o.kind === 'files' && Array.isArray(o.entries)) r.entries = o.entries.filter((e) => e && typeof e.name === 'string' && e.handle).map((e) => ({ name: e.name, handle: e.handle, writable: !!e.writable }));
    return r;
  }
  const saveRoot = (r) => dbPut('roots', recordOf(r));
  async function refreshPermission(r) {
    if (!handleRoot(r)) return;
    let st = 'granted';
    for (const t of permTargets(r)) {
      let one = 'prompt';
      try { one = typeof t.handle.queryPermission === 'function' ? await t.handle.queryPermission({ mode: t.mode }) : 'granted'; }
      catch (err) { console.error('[advanced-studio] macro folder permission', err); }
      if (one !== 'granted') { st = one === 'denied' ? 'denied' : 'prompt'; if (st === 'prompt') break; }
    }
    V.perm.set(r.id, st);
  }
  /** requestPermission on every handle of a root, all called inside the click that asked (the browser's prompt needs the gesture).
   *  → Promise<'granted' | 'prompt' | 'denied'>. */
  function requestRootPermission(r, mode) {
    const asks = permTargets(r).map((t) => {
      const m = mode === 'readwrite' && t.mode === 'readwrite' ? 'readwrite' : t.mode;
      try { return typeof t.handle.requestPermission === 'function' ? Promise.resolve(t.handle.requestPermission({ mode: m })) : Promise.resolve('granted'); }
      catch (err) { return Promise.reject(err); }
    });
    return Promise.all(asks).then((states) => (states.every((x) => x === 'granted') ? 'granted' : states.indexOf('denied') >= 0 ? 'denied' : 'prompt'));
  }

  function ensureLoaded() {
    if (V.loaded) return Promise.resolve();
    if (V.loading) return V.loading;
    V.loading = (async () => {
      try {
        const [recs, als, sets] = await Promise.all([dbAll('roots'), dbAll('aliases'), dbAll('settings')]);
        V.roots = recs.map(rootFromRecord).filter(Boolean).sort((p, q) => p.createdAt - q.createdAt);
        V.aliases = als.filter((x) => x && typeof x.literal === 'string' && x.literal && typeof x.rootId === 'string')
          .map((x) => ({ literal: x.literal, rootId: x.rootId, ci: !!x.ci, createdAt: typeof x.createdAt === 'number' ? x.createdAt : 0 }));
        for (const s of sets) {
          if (!s || typeof s.key !== 'string') continue;
          if (s.key === 'defaultMode' && MODES.indexOf(s.value) >= 0) V.settings.defaultMode = s.value;
          else if (s.key === 'collapsed') V.settings.collapsed = !!s.value;
        }
        for (const r of V.roots) await refreshPermission(r);
      } catch (err) { console.error('[advanced-studio] macro files store', err); }
      V.loaded = true;
      V.loading = null;
      filesChanged();
    })();
    return V.loading;
  }
  function touchRoots() {
    const now = Date.now();
    for (const r of V.roots) if (rootState(r) === 'ready') { r.lastUsedAt = now; saveRoot(r); }
  }
  function newRoot(kind, folderName, extra) {
    const now = Date.now();
    let id = hex16();
    while (rootById(id)) id = hex16();
    const name = VFS().rootName(V.roots.map((x) => x.name), folderName);
    return Object.assign({ id, name, kind, target: 'overlay', mode: V.settings.defaultMode, folderName, writeRefused: false, createdAt: now, lastUsedAt: now, snapshot: null }, extra);
  }
  /** A folder handle (picker or drop): the same folder granted again keeps its root (FILES.md §3.1). */
  async function addFsaRoot(handle, writeRefused) {
    await ensureLoaded();
    for (const r of V.roots) {
      if (r.kind !== 'fsa') continue;
      let same = false;
      try { same = !!(await r.handle.isSameEntry(handle)); } catch (_) { same = false; }
      if (!same) continue;
      if (writeRefused) { r.writeRefused = true; r.target = 'overlay'; }
      else if (r.writeRefused) { r.writeRefused = false; r.target = 'inplace'; }
      r.handle = handle;
      r.lastUsedAt = Date.now();
      await saveRoot(r);
      await refreshPermission(r);
      filesChanged();
      return r;
    }
    const r = newRoot('fsa', String(handle.name), { handle, target: writeRefused ? 'overlay' : 'inplace', writeRefused: !!writeRefused });
    // the row shows its permission state from the start
    await refreshPermission(r);
    if (!rootById(r.id)) V.roots.push(r);
    await saveRoot(r);
    filesChanged();
    return r;
  }
  /** A folder read as a copy (webkitdirectory, a dropped folder): a stale root of the same folder name takes it back, keeping its
   *  workspace and aliases (folders are chosen again at each visit in these browsers). */
  async function addSnapshotRoot(s) {
    await ensureLoaded();
    const print = snapshotPrint(s.snapshot);
    // the same name AND the same files (a root stored before the print existed is taken on its name)
    let r = V.roots.find((x) => x.kind === 'snapshot' && !x.snapshot && x.folderName === s.folderName && (x.snapPrint === undefined || x.snapPrint === print));
    if (r) { r.snapshot = s.snapshot; r.snapPrint = print; r.lastUsedAt = Date.now(); }
    else { r = newRoot('snapshot', s.folderName, { snapshot: s.snapshot, snapPrint: print }); V.roots.push(r); }
    await saveRoot(r);
    filesChanged();
    return r;
  }
  /** A folder copy as a root of its own, even when a stale root has its name. */
  async function addNewSnapshotRoot(s, print) {
    const r = newRoot('snapshot', s.folderName, { snapshot: s.snapshot, snapPrint: print });
    V.roots.push(r);
    await saveRoot(r);
    filesChanged();
    return r;
  }
  /** Loose files (open / save pickers, a dropped file) share one root, `Files` (FILES.md §3.2). */
  async function addLooseFile(item) {
    await ensureLoaded();
    let r = V.roots.find((x) => x.kind === 'files') || null;
    if (!r) {
      r = newRoot('files', 'Files', item.handle ? { entries: [] } : { snapshot: { rels: [], files: [], dirs: [] } });
      V.roots.push(r);
    }
    if (item.handle) {
      const name = String(item.handle.name);
      if (!Array.isArray(r.entries)) { r.entries = []; r.snapshot = null; }
      r.entries = r.entries.filter((e) => e.name !== name).concat([{ name, handle: item.handle, writable: !!item.writable }]);
    } else {
      if (Array.isArray(r.entries)) throw macroError('a file without a handle in a root of handles');
      const name = String(item.file.name);
      const s = r.snapshot || { rels: [], files: [], dirs: [] };
      const i = s.rels.indexOf(name);
      if (i >= 0) s.files[i] = item.file; else { s.rels.push(name); s.files.push(item.file); }
      r.snapshot = s;
    }
    r.lastUsedAt = Date.now();
    await saveRoot(r);
    await refreshPermission(r);
    filesChanged();
    return r;
  }
  async function removeRoot(papi, r) {
    if (running()) return;
    if (isOverlay(r)) {
      await refreshChanges(papi, [r.id]);
      const ch = V.changes.get(r.id);
      if (ch && changeCount(ch) > 0) { if (!(await discardRoot(papi, r))) return; }
      // a workspace known to be empty goes with its root; one whose content could not be read is left alone
      else if (ch) await papi.call('macro.vfs', Object.assign(vfsBase(papi), { op: 'discard', rootId: r.id }));
    }
    V.roots = V.roots.filter((x) => x !== r);
    V.perm.delete(r.id); V.changes.delete(r.id); V.deliveries.delete(r.id); V.dirty.delete(r.id);
    V.queue.folders = V.queue.folders.filter((q) => q.rootId !== r.id);
    V.queue.files = V.queue.files.filter((q) => q.rootId !== r.id);
    await dbDelete('roots', r.id);
    filesChanged();
    scheduleScan(0);
  }

  // ── aliases (FILES.md §3.3) ──
  const ciLiteral = (l) => /^[A-Za-z]:\//.test(l) || l.indexOf('//') === 0;
  function covered(literal) {
    return V.aliases.some((al) => {
      if (!rootById(al.rootId)) return false;
      return al.ci ? literal.toLowerCase().indexOf(al.literal.toLowerCase()) === 0 : literal.indexOf(al.literal) === 0;
    });
  }
  function prefixesOf(literal, given) {
    if (Array.isArray(given) && given.length && given.every((p) => typeof p === 'string' && p)) return given.slice();
    const F = VFS();
    return F ? F.aliasPrefixes(literal) : [literal];
  }
  function addNeed(literal, prefixes) {
    const l = String(literal);
    if (!l || V.needs.some((n) => n.literal === l)) return;
    V.needs.push({ literal: l, prefixes: prefixesOf(l, prefixes) });
  }
  /** Machine paths without an alias: the last runs' and the scan's, in that order. */
  function pendingNeeds() {
    const out = [];
    const seen = new Set();
    const scanned = V.scan ? V.scan.machinePaths.map((l) => ({ literal: String(l), prefixes: prefixesOf(String(l)) })) : [];
    for (const n of V.needs.concat(scanned)) {
      if (seen.has(n.literal) || covered(n.literal)) continue;
      seen.add(n.literal);
      out.push(n);
    }
    return out;
  }
  async function setAlias(literal, rootId) {
    const rec = { literal, rootId, ci: ciLiteral(literal), createdAt: Date.now() };
    // stored first: the alias the Files section shows is the one a reload will find
    await dbPut('aliases', rec);
    V.aliases = V.aliases.filter((x) => x.literal !== literal).concat([rec]);
    V.needs = V.needs.filter((n) => !covered(n.literal));
    filesChanged();
    scheduleScan(0);
  }
  async function removeAlias(literal) {
    V.aliases = V.aliases.filter((x) => x.literal !== literal);
    await dbDelete('aliases', literal);
    filesChanged();
    scheduleScan(0);
  }

  // ── pickers: each opens inside the click that called it (the browser refuses a picker without a gesture) ──
  function inputPicker(o) {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      if (o.directory) { input.webkitdirectory = true; input.setAttribute('webkitdirectory', ''); }
      if (o.multiple) input.multiple = true;
      let done = false;
      const finish = (v) => { if (!done) { done = true; resolve(v); } };
      input.addEventListener('change', () => { const f = Array.from(input.files || []); finish(f.length ? f : null); });
      input.addEventListener('cancel', () => finish(null));
      input.click();
    });
  }
  /** Files of <input webkitdirectory>: webkitRelativePath = '<folder>/<rel>'. Directories are only known through their files. */
  function snapshotOfFiles(files) {
    let folderName = '';
    const rels = [], list = [], dirs = new Set();
    for (const f of files) {
      const segs = String(f.webkitRelativePath || '').split('/').filter((s) => s !== '');
      if (segs.length < 2) continue;
      if (!folderName) folderName = segs[0];
      if (segs[0] !== folderName) continue;
      rels.push(segs.slice(1).join('/'));
      list.push(f);
      for (let i = 2; i < segs.length; i++) dirs.add(segs.slice(1, i).join('/') + '/');
    }
    return folderName ? { folderName, snapshot: { rels, files: list, dirs: Array.from(dirs).sort() } } : null;
  }
  function readAllEntries(dir) {
    return new Promise((resolve, reject) => {
      const reader = dir.createReader();
      const out = [];
      const next = () => reader.readEntries((batch) => { if (!batch || !batch.length) resolve(out); else { for (const e of batch) out.push(e); next(); } }, reject);
      next();
    });
  }
  const entryFile = (e) => new Promise((resolve, reject) => e.file(resolve, reject));
  /** A dropped folder (webkitGetAsEntry), walked here: the worker gets the File list, entries do not clone. */
  async function snapshotOfEntry(dirEntry) {
    const rels = [], files = [], dirs = [];
    async function walk(d, prefix) {
      for (const k of await readAllEntries(d)) {
        if (k.isDirectory) { dirs.push(prefix + k.name + '/'); await walk(k, prefix + k.name + '/'); }
        else if (k.isFile) {
          try { files.push(await entryFile(k)); rels.push(prefix + k.name); } catch (err) { console.error('[advanced-studio] macro dropped file', err); }
        }
      }
    }
    await walk(dirEntry, '');
    return { folderName: String(dirEntry.name), snapshot: { rels, files, dirs } };
  }
  function pickFailure(err, kind, o) {
    // Chromium: write permission refused for a readwrite folder → the folder can still be read (writes then go to the workspace)
    if (err && err.name === 'NotAllowedError' && kind === 'directory' && !o.readOnly) return { writeRefused: true };
    if (!err || err.name !== 'AbortError') console.error('[advanced-studio] macro picker', err);
    return { cancelled: true };
  }
  /** Starts the browser picker synchronously (call it first in a click handler) → Promise of what was picked. */
  function startPicker(kind, o) {
    const opt = o || {};
    const fail = (err) => pickFailure(err, kind, opt);
    try {
      if (kind === 'directory') {
        if (hasFn('showDirectoryPicker')) {
          return Promise.resolve(root.showDirectoryPicker({ mode: opt.readOnly ? 'read' : 'readwrite' }))
            .then((handle) => (handle ? { fsa: handle, readOnly: !!opt.readOnly } : { cancelled: true }), fail);
        }
        return inputPicker({ directory: true }).then((files) => { const s = files ? snapshotOfFiles(files) : null; return s ? { snap: s } : { cancelled: true }; });
      }
      if (kind === 'save') {
        if (!hasFn('showSaveFilePicker')) return Promise.resolve({ cancelled: true });
        return Promise.resolve(root.showSaveFilePicker({ suggestedName: opt.suggested || undefined }))
          .then((handle) => (handle ? { fileHandle: handle, writable: true } : { cancelled: true }), fail);
      }
      if (hasFn('showOpenFilePicker')) {
        return Promise.resolve(root.showOpenFilePicker({ multiple: false }))
          .then((hs) => (hs && hs[0] ? { fileHandle: hs[0], writable: false } : { cancelled: true }), fail);
      }
      return inputPicker({}).then((files) => (files ? { file: files[0] } : { cancelled: true }));
    } catch (err) { return Promise.resolve(fail(err)); }
  }
  /** What a picker returned → the root it went into: { vpath, grant } | { cancelled } | { writeRefused }. */
  async function adoptPick(res) {
    if (!res || res.cancelled) return { cancelled: true };
    if (res.fsa) { const r = await addFsaRoot(res.fsa, res.readOnly); return { vpath: '/' + r.name + '/', grant: grantOf(r) }; }
    if (res.writeRefused) return { writeRefused: true };
    if (res.snap) { const r = await addSnapshotRoot(res.snap); return { vpath: '/' + r.name + '/', grant: grantOf(r) }; }
    if (res.fileHandle) { const r = await addLooseFile({ handle: res.fileHandle, writable: res.writable }); return { vpath: '/' + r.name + '/' + String(res.fileHandle.name), grant: grantOf(r) }; }
    if (res.file) { const r = await addLooseFile({ file: res.file }); return { vpath: '/' + r.name + '/' + String(res.file.name), grant: grantOf(r) }; }
    return { cancelled: true };
  }
  const choose = (kind, o) => startPicker(kind, o).then(adoptPick);

  // ── the worker's pickers, questions and permission requests (FILES.md §6.3, §6.4): one pause strip at a time ──
  /** p = { state, text, actions, … } → the reply its buttons give; DROPPED when the run ends first (the strip closes, nothing is sent). */
  function pauseFor(a, p) {
    const fallback = DROPPED;
    return new Promise((resolve) => {
      const signal = a.macro.signal();
      if (signal && signal.aborted) { resolve(fallback); return; }
      const resume = a.macro.pause();
      let settled = false;
      const onAbort = () => finish(fallback);
      function finish(v) {
        if (settled) return;
        settled = true;
        if (signal) signal.removeEventListener('abort', onAbort);
        if (V.pause === p) V.pause = null;
        try { resume(); } catch (err) { console.error('[advanced-studio] macro resume', err); }
        notify('editor');
        resolve(v);
      }
      p.seq = ++V.pauseSeq;
      p.finish = finish;
      p.settled = () => settled;
      if (signal) signal.addEventListener('abort', onAbort);
      V.pause = p;
      openQuiet(a, 'macroEditor', true);
      notify('editor');
    });
  }
  function suggestedName(defaultName, ext) {
    const d = strOf(defaultName), e = strOf(ext);
    return !e || d.toLowerCase().endsWith(e.toLowerCase()) ? d : d + e;
  }
  /** A name typed for /Downloads/: one path segment. */
  function cleanFileName(s) {
    const n = strOf(s).trim().replace(/[\\/]+/g, '_');
    return n && n !== '.' && n !== '..' && n.indexOf('\u0000') < 0 ? n : '';
  }
  async function vfsPick(a, x) {
    await ensureLoaded();
    const kind = x.kind === 'file' || x.kind === 'save' ? x.kind : 'directory';
    if (kind !== 'save') {
      const q = kind === 'file' ? V.queue.files : V.queue.folders;
      while (q.length) {
        const ans = q.shift();
        const g = grantById(ans.rootId);
        filesChanged();
        if (g) return { vpath: ans.vpath, grant: g };
      }
    }
    const fsaDir = kind === 'directory' && hasFn('showDirectoryPicker');
    const suggested = suggestedName(x.defaultName, x.ext);
    const p = { kind, state: kind === 'save' && !hasFn('showSaveFilePicker') ? 'saveName' : 'pick', text: strOf(x.prompt), value: suggested,
      hint: fsaDir ? 'dlg.mac.files.blockedHint' : null, readOnlyOption: fsaDir };
    p.actions = {
      choose(readOnly) {
        const pr = choose(kind, { readOnly: !!readOnly, suggested });
        pr.then((r) => {
          if (p.settled()) return;
          if (r.writeRefused) { p.state = 'pickReadOnly'; notify('editor'); return; }
          if (!r.cancelled) p.finish({ vpath: r.vpath, grant: r.grant });
        }).catch((err) => console.error('[advanced-studio] macro picker', err));
      },
      save(name) {
        const n = cleanFileName(name);
        if (n) p.finish({ vpath: '/Downloads/' + n, grant: downloadsGrant() });
      },
      cancel: () => p.finish({ cancelled: true })
    };
    return pauseFor(a, p);
  }
  function vfsConfirm(a, x) {
    const key = Object.prototype.hasOwnProperty.call(CONFIRM_KEYS, x.action) ? CONFIRM_KEYS[x.action] : CONFIRM_KEYS.overwrite;
    const p = { state: 'confirm', text: a.tr(key, { path: strOf(x.path), to: strOf(x.to) }) };
    p.actions = { allow: () => p.finish({ choice: 'allow' }), refuse: () => p.finish({ choice: 'refuse' }), abort: () => p.finish({ choice: 'abort' }) };
    return pauseFor(a, p);
  }
  async function vfsRegrant(a, x) {
    await ensureLoaded();
    const r = rootById(x.rootId);
    const targets = r && handleRoot(r) ? permTargets(r) : [];
    if (!targets.length || !targets.every((t) => t.handle && typeof t.handle.requestPermission === 'function')) return { ok: false };
    // one question for a folder written in place: readwrite (it covers read), not a read prompt then a write prompt
    const mode = x.mode === 'readwrite' || neededMode(r) === 'readwrite' ? 'readwrite' : 'read';
    const p = { state: 'regrant', text: a.tr('dlg.mac.pause.regrant', { name: strOf(x.root) || r.name }) };
    p.actions = {
      allow() {
        requestRootPermission(r, mode).then((state) => {
          V.perm.set(r.id, state);
          filesChanged();
          if (!p.settled()) p.finish(state === 'granted' ? { ok: true, grant: grantOf(r) } : { ok: false });
        }, (err) => console.error('[advanced-studio] macro folder permission', err));
      },
      cancel: () => p.finish({ ok: false })
    };
    return pauseFor(a, p);
  }
  /** A Dialog.addDirectory / addFile field: an empty default takes the next queued answer; Browse… picks without pausing (its cancel
   *  leaves the field as it was, as GenericDialog's Browse button does). */
  function pathField(f, label, grants) {
    const kind = f.pathKind === 'file' ? 'file' : 'directory';
    let value = strOf(f.value);
    if (value === '') {
      const q = kind === 'file' ? V.queue.files : V.queue.folders;
      while (q.length && value === '') {
        const ans = q.shift();
        const g = grantById(ans.rootId);
        if (g) { value = ans.vpath; grants.push(g); }
      }
      filesChanged();
    }
    return {
      type: 'path', id: f.id, label, value, pathKind: kind,
      browse: () => choose(kind, {}).then((r) => {
        if (r.cancelled || r.writeRefused) return null;
        grants.push(r.grant);
        return r.vpath;
      })
    };
  }

  // ── worker events, runs ──
  function vfsEvent(ev) {
    if (ev.type === 'firstOverlayWrite') askPersist();
    else if (ev.type === 'changed' && typeof ev.rootId === 'string') { V.dirty.add(ev.rootId); filesChanged(); }
  }
  /** navigator.storage.persist() once per page session, at the first write to the browser workspace (FILES.md §5.3). */
  function askPersist() {
    if (V.persistAsked) return;
    V.persistAsked = true;
    const s = storageApi();
    let p = null;
    try { if (s && typeof s.persist === 'function') p = s.persist(); } catch (err) { console.error('[advanced-studio] macro storage', err); }
    Promise.resolve(p).catch((err) => console.error('[advanced-studio] macro storage', err)).then(() => refreshEstimate());
  }
  async function refreshEstimate() {
    const s = storageApi();
    if (!s || typeof s.estimate !== 'function') return;
    try {
      const e = await s.estimate();
      if (e && Number.isFinite(e.usage) && Number.isFinite(e.quota)) { V.estimate = { usage: e.usage, quota: e.quota }; filesChanged(); }
    } catch (err) { console.error('[advanced-studio] macro storage', err); }
    try {
      if (typeof s.persisted === 'function') { const was = V.persisted; V.persisted = (await s.persisted()) === true; if (was !== V.persisted) filesChanged(); }
    } catch (err) { console.error('[advanced-studio] macro storage', err); }
  }
  function vfsTexts(a) {
    const out = textsFor(a);
    for (const k of README_KEYS) out[k] = a.tr(k);
    return out;
  }
  /** The mount id of this Studio open: a new one each time the Studio is opened afresh (api.macro.mountSeq), so /tmp/ starts empty. */
  function mountIdNow() {
    let seq = null;
    try { const a = apiOf(); seq = a && a.macro && typeof a.macro.mountSeq === 'function' ? a.macro.mountSeq() : null; } catch (_) { seq = null; }
    if (seq !== null && seq !== V.mountSeq) { if (V.mountSeq !== undefined) V.mountId = hex16(); V.mountSeq = seq; }
    return V.mountId;
  }
  const vfsBase = (a) => ({ roots: grantsList(), aliases: aliasesList(), mountId: mountIdNow(), texts: vfsTexts(a) });
  const vfsRunArgs = () => ({ roots: grantsList(), aliases: aliasesList(), mountId: mountIdNow(), queue: { folders: V.queue.folders.length, files: V.queue.files.length } });
  const changeCount = (ch) => (ch ? ch.files.length + ch.deleted.length + ch.renamed.length : 0);
  const overlayIds = () => V.roots.filter(isOverlay).map((r) => r.id).concat([DOWNLOADS_ID]);
  function vfsAfterRun(a, fv) {
    const ids = new Set(V.dirty);
    if (fv && typeof fv === 'object') {
      for (const n of Array.isArray(fv.needs) ? fv.needs : []) if (n && n.kind === 'alias' && typeof n.literal === 'string') addNeed(n.literal, n.prefixes);
      // a root the run changed again: the links built before no longer hold its results
      for (const id of Array.isArray(fv.changedRoots) ? fv.changedRoots : []) if (typeof id === 'string') { ids.add(id); V.deliveries.delete(id); }
      if (Array.isArray(fv.needs) && fv.needs.length) {
        if (V.settings.collapsed) { V.settings.collapsed = false; dbPut('settings', { key: 'collapsed', value: false }); }
        openQuiet(a, 'macroEditor', false);
      }
    }
    filesChanged();
    if (ids.size) refreshChanges(a, Array.from(ids)).then(() => refreshEstimate());
  }
  /** Workspace changes, read one root after the other; a run started meanwhile waits for the read (macro.vfs holds the busy state). */
  function refreshChanges(a, ids) {
    const p = (V.refreshing || Promise.resolve()).then(() => readChanges(a, ids)).catch((err) => console.error('[advanced-studio] macro workspace', err));
    V.refreshing = p;
    p.then(() => { if (V.refreshing === p) V.refreshing = null; });
    return p;
  }
  async function readChanges(a, ids) {
    if (running()) return;
    await ensureLoaded();
    for (const id of ids || overlayIds()) {
      if (!grantById(id)) { V.changes.delete(id); continue; }
      let res = null;
      try { res = await a.call('macro.vfs', Object.assign(vfsBase(a), { op: 'changes', rootId: id })); } catch (err) { console.error('[advanced-studio] macro workspace', err); return; }
      if (res && Array.isArray(res.files) && Array.isArray(res.deleted) && Array.isArray(res.renamed)) { V.changes.set(id, res); V.dirty.delete(id); }
    }
    filesChanged();
  }
  async function deliverRoot(papi, id) {
    if (running()) return;
    const res = await papi.call('macro.vfs', Object.assign(vfsBase(papi), { op: 'deliver', rootId: id }), { labelKey: 'op.macZip' });
    if (!res || typeof res !== 'object') return;
    if (res.kind === 'zip' && res.file) V.deliveries.set(id, [{ name: strOf(res.name), file: res.file }]);
    else if (res.kind === 'files' && Array.isArray(res.files)) V.deliveries.set(id, res.files.filter((f) => f && f.file).map((f) => ({ name: strOf(f.name), file: f.file })));
    else { V.deliveries.delete(id); await refreshChanges(papi, [id]); }
    filesChanged();
    refreshEstimate();
  }
  /** One download per click, so the browser never asks about multiple downloads. */
  function downloadFile(file, name) {
    const url = URL.createObjectURL(file);
    const link = el('a', { href: url, download: name });
    document.body.appendChild(link);
    link.click();
    if (link.parentNode) link.parentNode.removeChild(link);
    setTimeout(() => URL.revokeObjectURL(url), LINK_TTL_MS);
  }
  async function discardRoot(papi, r) {
    const n = changeCount(V.changes.get(r.id));
    const ok = await papi.dialog({ title: papi.tr('dlg.mac.files.discard'), okLabel: papi.tr('dlg.mac.files.discard'),
      fields: messageFields(papi.tr('dlg.mac.files.discardConfirm', { n, name: '/' + r.name + '/' }), 'm') });
    if (!ok) return false;
    const res = await papi.call('macro.vfs', Object.assign(vfsBase(papi), { op: 'discard', rootId: r.id }));
    if (res === null || res === undefined) return false;
    V.changes.delete(r.id); V.deliveries.delete(r.id); V.dirty.delete(r.id);
    filesChanged();
    refreshEstimate();
    return true;
  }

  // ── the pre-run scan (FILES.md §6.1, §6.2) ──
  function scheduleScan(ms) {
    clearTimeout(V.scanTimer);
    V.scanTimer = setTimeout(() => { V.scanTimer = 0; runScan().catch((err) => console.error('[advanced-studio] macro scan', err)); }, ms === undefined ? SCAN_MS : ms);
  }
  async function runScan() {
    const a = apiOf();
    const seq = ++V.scanSeq;
    const source = M.editorText === null ? '' : M.editorText;
    let res = null;
    if (source.trim()) {
      try { await ensureLoaded(); res = await a.call('macro.scan', { source, aliases: aliasesList() }); } catch (err) { console.error('[advanced-studio] macro scan', err); res = null; }
    }
    if (seq !== V.scanSeq) return;
    const arr = (v) => (Array.isArray(v) ? v : []);
    V.scan = res && typeof res === 'object' ? { folders: arr(res.folders), files: arr(res.files), machinePaths: arr(res.machinePaths).filter((l) => typeof l === 'string') } : null;
    filesChanged();
  }
  /** The editor opened: the grants are read, the storage estimate and (once) the workspace changes refreshed. */
  function filesOpened(papi) {
    ensureLoaded().then(() => {
      refreshEstimate();
      if (!V.changesLoaded && !running()) { V.changesLoaded = true; return refreshChanges(papi); }
      return null;
    }).catch((err) => console.error('[advanced-studio] macro files', err));
    scheduleScan(0);
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

  // ── the pause strip and the Files section of the Macro Editor (FILES.md §6.5, §11, §3) ──
  /** Interactive elements carry a key so a rebuilt section gives the keyboard focus back to the same control. */
  function keyed(node, k) { node.setAttribute('data-fkey', k); return node; }
  function focusedKey(container) {
    let ae = null;
    try { ae = document.activeElement || null; } catch (_) { ae = null; }
    if (!ae || typeof ae.getAttribute !== 'function') return null;
    if (typeof container.contains === 'function' && !container.contains(ae)) return null;
    return ae.getAttribute('data-fkey');
  }
  function findKeyed(n, k) {
    if (n.getAttribute && n.getAttribute('data-fkey') === k) return n;
    for (const c of Array.from(n.children || [])) { const hit = findKeyed(c, k); if (hit) return hit; }
    return null;
  }
  function refocus(container, k) {
    if (!k) return;
    const hit = findKeyed(container, k);
    if (hit && typeof hit.focus === 'function') hit.focus();
  }
  function selectField(labelText, value, options, onChange, fkey) {
    const sel = keyed(el('select', { class: 'ij-mac-files-select' }, options.map((o) => el('option', { value: o.value, text: o.label, selected: o.value === value }))), fkey);
    sel.value = value;
    sel.addEventListener('change', () => onChange(sel.value));
    return el('label', { class: 'ij-mac-files-field' }, el('span', { text: labelText }), sel);
  }

  const CONFIRM_GUARD_MS = 500;
  function buildPause(papi) {
    const tr = (k, p) => papi.tr(k, p);
    const box = el('div', { class: 'ij-mac-pause', hidden: true, attrs: { role: 'group', 'aria-live': 'assertive' } });
    let key = '';
    function render() {
      const p = V.pause;
      const k = p ? p.seq + ':' + p.state : '';
      if (k === key) return;
      key = k;
      box.hidden = !p;
      if (!p) { box.replaceChildren(); return; }
      const text = (s) => el('p', { class: 'ij-mac-pause-text', text: s });
      const kids = [], acts = [];
      let input = null;
      switch (p.state) {
        case 'pick':
          // the worker's prompt is macro data: verbatim
          kids.push(text(p.text));
          if (p.hint) kids.push(el('p', { class: 'ij-mac-pause-hint', text: tr(p.hint) }));
          acts.push(button(tr('dlg.mac.pause.choose'), () => p.actions.choose(false), 'ij-btn--primary'));
          if (p.readOnlyOption) acts.push(button(tr('dlg.mac.files.chooseReadOnly'), () => p.actions.choose(true)));
          acts.push(button(tr('dlg.cancel'), () => p.actions.cancel()));
          break;
        case 'pickReadOnly':
          kids.push(text(p.text), el('p', { class: 'ij-mac-pause-hint', text: tr('dlg.mac.files.writeRefused') }));
          acts.push(button(tr('dlg.mac.files.chooseReadOnly'), () => p.actions.choose(true), 'ij-btn--primary'));
          acts.push(button(tr('dlg.cancel'), () => p.actions.cancel()));
          break;
        case 'saveName': {
          kids.push(text(p.text));
          const field = el('input', { type: 'text', class: 'ij-mac-pause-input', value: p.value, attrs: { spellcheck: 'false', autocomplete: 'off' } });
          field.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { stop(e); p.actions.save(field.value); } else if (e.key === 'Escape') { stop(e); p.actions.cancel(); }
          });
          input = field;
          kids.push(el('label', { class: 'ij-mac-pause-field' }, el('span', { text: tr('dlg.mac.pause.saveName') }), field));
          acts.push(button(tr('dlg.mac.pause.save'), () => p.actions.save(field.value), 'ij-btn--primary'));
          acts.push(button(tr('dlg.cancel'), () => p.actions.cancel()));
          break;
        }
        case 'confirm': {
          kids.push(text(p.text));
          const shownAt = Date.now();
          // a keyboard activation (detail 0) in the strip's first half second is a key pressed for something else
          acts.push(button(tr('dlg.mac.pause.allowRun'), (e) => { if (e && e.detail === 0 && Date.now() - shownAt < CONFIRM_GUARD_MS) return; p.actions.allow(); }, 'ij-btn--primary'));
          acts.push(button(tr('dlg.mac.pause.refuse'), () => p.actions.refuse()));
          acts.push(button(tr('dlg.mac.pause.abort'), () => p.actions.abort(), 'ij-btn--danger'));
          break;
        }
        case 'regrant':
          kids.push(text(p.text));
          acts.push(button(tr('dlg.mac.pause.allow'), () => p.actions.allow(), 'ij-btn--primary'));
          acts.push(button(tr('dlg.cancel'), () => p.actions.cancel()));
          break;
        default: break;
      }
      box.replaceChildren(...kids, el('div', { class: 'ij-mac-pause-actions' }, acts));
      // a key already on its way (the Enter that closed a waitForUser) must not grant a whole root: the confirmation focuses Refuse
      const target = input || (p.state === 'confirm' ? acts[1] : acts[0]);
      if (target && typeof target.focus === 'function') target.focus();
    }
    return { el: box, render };
  }

  function setMode(papi, r, v) {
    if (MODES.indexOf(v) < 0) return;
    r.mode = v;
    saveRoot(r).then(() => refreshPermission(r)).then(() => filesChanged()).catch((err) => papi.error(err));
  }
  function setTarget(papi, r, v) {
    if (v !== 'inplace' && v !== 'overlay') return;
    r.target = v;
    saveRoot(r).then(() => refreshPermission(r)).then(() => filesChanged()).catch((err) => papi.error(err));
  }
  function addFolderClick(papi, readOnly) {
    const pr = choose('directory', { readOnly });
    pr.then((r) => {
      V.writeRefusedNote = !!r.writeRefused;
      filesChanged();
      if (!r.cancelled && !r.writeRefused) scheduleScan(0);
    }).catch((err) => papi.error(err));
  }
  function aliasClick(papi, levelOf) {
    const pr = choose('directory', {});
    pr.then((r) => {
      if (r.writeRefused) { V.writeRefusedNote = true; filesChanged(); return null; }
      if (r.cancelled) return null;
      return setAlias(levelOf(), r.grant.id);
    }).catch((err) => papi.error(err));
  }
  function queueClick(papi, kind) {
    const pr = choose(kind, {});
    pr.then((r) => {
      if (r.writeRefused) { V.writeRefusedNote = true; filesChanged(); return; }
      if (r.cancelled) return;
      (kind === 'file' ? V.queue.files : V.queue.folders).push({ vpath: r.vpath, rootId: r.grant.id });
      filesChanged();
    }).catch((err) => papi.error(err));
  }
  function regrantClick(papi, r) {
    requestRootPermission(r, neededMode(r)).then((state) => { V.perm.set(r.id, state); filesChanged(); }, (err) => papi.error(err));
  }
  /** A root read as a copy comes back stale after a reload: the folder (or the files) chosen again refill it. */
  function rechooseClick(papi, r) {
    const pr = r.kind === 'files' ? inputPicker({ multiple: true }) : inputPicker({ directory: true });
    pr.then(async (files) => {
      if (!files) return;
      if (r.kind === 'files') r.snapshot = { rels: files.map((f) => String(f.name)), files: files.slice(), dirs: [] };
      else {
        const s = snapshotOfFiles(files);
        if (!s) return;
        const print = snapshotPrint(s.snapshot);
        if (r.snapPrint !== undefined && r.snapPrint !== print) {
          // another folder (or this one with other files): its workspace goes onto it only when the operator says so
          await refreshChanges(papi, [r.id]);
          const n = changeCount(V.changes.get(r.id));
          const attach = n === 0 || await papi.dialog({ title: papi.tr('dlg.mac.files.rechoose'), okLabel: papi.tr('dlg.mac.files.attach'),
            fields: messageFields(papi.tr('dlg.mac.files.otherFolder', { name: '/' + r.name + '/', folder: s.folderName, n }), 'm') });
          if (!attach) { await addNewSnapshotRoot(s, print); return; }
        }
        r.snapshot = s.snapshot;
        r.snapPrint = print;
        r.folderName = s.folderName;
      }
      r.lastUsedAt = Date.now();
      await saveRoot(r);
      filesChanged();
    }).catch((err) => papi.error(err));
  }
  function onDrop(papi, e) {
    const dt = e.dataTransfer;
    const items = dt && dt.items ? Array.from(dt.items) : [];
    const jobs = [];
    // every item is read inside the drop event: the browser empties the list once it returns
    for (const it of items) {
      if (!it || it.kind !== 'file') continue;
      if (hasFn('showDirectoryPicker') && typeof it.getAsFileSystemHandle === 'function') {
        jobs.push(Promise.resolve(it.getAsFileSystemHandle()).then((h) => (h ? { handle: h } : null)));
        continue;
      }
      const entry = typeof it.webkitGetAsEntry === 'function' ? it.webkitGetAsEntry() : null;
      if (entry && entry.isDirectory) jobs.push(snapshotOfEntry(entry).then((s) => ({ snap: s })));
      else if (entry && entry.isFile) jobs.push(entryFile(entry).then((f) => ({ file: f })));
      else {
        const f = typeof it.getAsFile === 'function' ? it.getAsFile() : null;
        if (f) jobs.push(Promise.resolve({ file: f }));
      }
    }
    if (!jobs.length) return;
    Promise.all(jobs.map((j) => j.catch((err) => { console.error('[advanced-studio] macro drop', err); return null; }))).then(async (res) => {
      for (const x of res) {
        if (!x) continue;
        if (x.handle) { if (x.handle.kind === 'directory') await addFsaRoot(x.handle, false); else await addLooseFile({ handle: x.handle, writable: false }); }
        else if (x.snap) await addSnapshotRoot(x.snap);
        else if (x.file) await addLooseFile({ file: x.file });
      }
      scheduleScan(0);
    }).catch((err) => papi.error(err));
  }
  function dropZone(papi) {
    const base = 'ij-mac-files-drop';
    const z = el('div', { class: base, text: papi.tr('dlg.mac.files.drop') });
    z.addEventListener('dragover', (e) => { stop(e); if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'; z.className = base + ' ij-mac-files-drop-over'; });
    z.addEventListener('dragleave', () => { z.className = base; });
    z.addEventListener('drop', (e) => { stop(e); z.className = base; onDrop(papi, e); });
    return z;
  }
  function changesBlock(papi, r, busy) {
    const ch = V.changes.get(r.id);
    const n = changeCount(ch);
    const got = V.deliveries.get(r.id);
    const kids = [];
    if (ch && n) kids.push(el('span', { class: 'ij-mac-files-meta', text: papi.tr('dlg.mac.files.changes', { n }) }));
    if (n) { const b = keyed(button(papi.tr('dlg.mac.files.download'), () => { deliverRoot(papi, r.id).catch((err) => papi.error(err)); }), 'deliver:' + r.id); b.disabled = busy; kids.push(b); }
    if (got) {
      got.forEach((it, i) => kids.push(keyed(button(papi.tr('dlg.mac.files.downloadLink', { name: it.name }), () => downloadFile(it.file, it.name), 'ij-mac-files-link'), 'link:' + r.id + ':' + i)));
      if (n) { const d = keyed(button(papi.tr('dlg.mac.files.discard'), () => { discardRoot(papi, r).catch((err) => papi.error(err)); }, 'ij-btn--danger'), 'discard:' + r.id); d.disabled = busy; kids.push(d); }
    }
    return kids.length ? el('div', { class: 'ij-mac-files-changes' }, kids) : null;
  }
  function rootRow(papi, r, busy) {
    const tr = (k, p) => papi.tr(k, p);
    const st = rootState(r);
    const head = el('div', { class: 'ij-mac-files-head' },
      el('span', { class: 'ij-mac-files-name', text: '/' + r.name + '/' }),
      el('span', { class: 'ij-mac-files-meta', text: tr(KIND_KEYS[r.kind]) }),
      el('span', { class: 'ij-mac-files-state' + (st === 'ready' ? '' : ' ij-mac-files-warn'), text: tr(STATE_KEYS[st]) }));
    const ctl = [selectField(tr('dlg.mac.files.mode'), r.mode, MODES.map((m) => ({ value: m, label: tr(MODE_KEYS[m]) })), (v) => setMode(papi, r, v), 'mode:' + r.id)];
    if (r.kind === 'fsa' && !r.writeRefused) {
      ctl.push(selectField(tr('dlg.mac.files.target'), r.target, [{ value: 'inplace', label: tr('dlg.mac.files.targetInplace') }, { value: 'overlay', label: tr('dlg.mac.files.targetOverlay') }],
        (v) => setTarget(papi, r, v), 'target:' + r.id));
    } else if (!fsaFilesRoot(r)) {
      ctl.push(el('span', { class: 'ij-mac-files-field' }, el('span', { text: tr('dlg.mac.files.target') }), el('span', { class: 'ij-mac-files-meta', text: tr('dlg.mac.files.targetOverlay') })));
    }
    if (st === 'prompt') ctl.push(keyed(button(tr('dlg.mac.files.regrant'), () => regrantClick(papi, r), 'ij-btn--primary'), 'regrant:' + r.id));
    if (st === 'stale') ctl.push(keyed(button(tr('dlg.mac.files.rechoose'), () => rechooseClick(papi, r), 'ij-btn--primary'), 'rechoose:' + r.id));
    const rm = keyed(button(tr('dlg.mac.files.remove'), () => { removeRoot(papi, r).catch((err) => papi.error(err)); }, 'ij-btn--danger'), 'remove:' + r.id);
    rm.disabled = busy;
    ctl.push(rm);
    const kids = [head, el('div', { class: 'ij-mac-files-controls' }, ctl)];
    if (r.writeRefused) kids.push(el('p', { class: 'ij-mac-files-note', text: tr('dlg.mac.files.writeRefused') }));
    const ch = changesBlock(papi, r, busy);
    if (ch) kids.push(ch);
    return el('li', { class: 'ij-mac-files-row ij-mac-files-root' }, kids);
  }
  function filesContent(papi, busy) {
    const tr = (k, p) => papi.tr(k, p);
    const F = VFS();
    const fsa = hasFn('showDirectoryPicker');
    const out = [];
    const note = (text, warn) => el('p', { class: 'ij-mac-files-note' + (warn ? ' ij-mac-files-warn' : ''), text });
    if (!fsa) out.push(note(tr('dlg.mac.files.browserNote')));
    // WebKit may delete a site's storage after 7 days without a visit unless it is persistent (PLAN §10.6)
    if (!fsa && V.persisted !== true) out.push(note(tr('dlg.mac.files.evictNote')));
    const acts = [keyed(button(tr('dlg.mac.files.addFolder'), () => addFolderClick(papi, false), 'ij-btn--primary'), 'add')];
    if (fsa) acts.push(keyed(button(tr('dlg.mac.files.chooseReadOnly'), () => addFolderClick(papi, true)), 'add-ro'));
    if (!F) for (const b of acts) b.disabled = true;
    out.push(el('div', { class: 'ij-mac-files-actions' }, acts, F ? dropZone(papi) : null));
    if (fsa) out.push(note(tr('dlg.mac.files.blockedHint')));
    if (V.writeRefusedNote) out.push(note(tr('dlg.mac.files.writeRefused'), true));
    // granted roots, then /Downloads/ while it holds results
    const rows = V.roots.map((r) => rootRow(papi, r, busy));
    const dl = changesBlock(papi, { id: DOWNLOADS_ID, name: 'Downloads', kind: 'downloads' }, busy);
    if (dl) {
      rows.push(el('li', { class: 'ij-mac-files-row ij-mac-files-root' },
        el('div', { class: 'ij-mac-files-head' }, el('span', { class: 'ij-mac-files-name', text: '/Downloads/' }), el('span', { class: 'ij-mac-files-meta', text: tr('dlg.mac.files.kindDownloads') })), dl));
    }
    if (!V.roots.length) out.push(note(tr('dlg.mac.files.empty')));
    if (rows.length) out.push(el('ul', { class: 'ij-mac-files-list' }, rows));
    // paths written in macros (aliases), and the machine paths that still need one
    const aliasRows = [];
    for (const al of V.aliases) {
      const r = rootById(al.rootId);
      const rm = keyed(button(tr('dlg.mac.files.remove'), () => { removeAlias(al.literal).catch((err) => papi.error(err)); }), 'alias-rm:' + al.literal);
      if (r) aliasRows.push(el('li', { class: 'ij-mac-files-row' }, el('span', { class: 'ij-mac-files-path', text: tr('dlg.mac.files.aliasRow', { literal: al.literal, name: '/' + r.name + '/' }) }), rm));
      else {
        const ch = keyed(button(tr('dlg.mac.files.aliasChoose', { literal: al.literal }), () => aliasClick(papi, () => al.literal), 'ij-btn--primary'), 'alias-ch:' + al.literal);
        ch.disabled = !F;
        aliasRows.push(el('li', { class: 'ij-mac-files-row' }, el('span', { class: 'ij-mac-files-path', text: al.literal }), ch, rm));
      }
    }
    for (const n of pendingNeeds()) {
      const level = V.levels.get(n.literal);
      const cur = n.prefixes.indexOf(level) >= 0 ? level : n.prefixes[0];
      const holder = { value: cur };
      const lvl = selectField(tr('dlg.mac.files.aliasLevel'), cur, n.prefixes.map((x) => ({ value: x, label: x })), (v) => { holder.value = v; V.levels.set(n.literal, v); }, 'need-lvl:' + n.literal);
      const ch = keyed(button(tr('dlg.mac.files.aliasChoose', { literal: n.literal }), () => aliasClick(papi, () => holder.value), 'ij-btn--primary'), 'need:' + n.literal);
      ch.disabled = !F;
      aliasRows.push(el('li', { class: 'ij-mac-files-row ij-mac-files-need' }, ch, lvl));
    }
    if (aliasRows.length) out.push(el('p', { class: 'ij-mac-files-sub', text: tr('dlg.mac.files.aliases') }), el('ul', { class: 'ij-mac-files-list' }, aliasRows));
    // the pickers the macro text asks for, answered one click each before Run
    const sc = V.scan;
    const nFolders = sc ? sc.folders.length : 0, nFiles = sc ? sc.files.length : 0;
    const ready = V.queue.folders.length + V.queue.files.length;
    if (nFolders || nFiles || ready) {
      const items = [];
      const pickRow = (pick, i, kind, answers) => {
        const ans = answers[i];
        const b = keyed(button(tr('dlg.mac.files.queuePick', { prompt: strOf(pick && pick.prompt) }), () => queueClick(papi, kind)), 'q:' + kind + ':' + i);
        // answers are a FIFO: only the next unanswered pick of each kind is offered
        b.disabled = !F || !!ans || i !== answers.length;
        return el('li', { class: 'ij-mac-files-row' }, b, ans ? el('span', { class: 'ij-mac-files-path', text: ans.vpath }) : null);
      };
      if (sc) {
        sc.folders.forEach((p, i) => items.push(pickRow(p, i, 'directory', V.queue.folders)));
        sc.files.forEach((p, i) => items.push(pickRow(p, i, 'file', V.queue.files)));
      }
      const foot = [el('span', { class: 'ij-mac-files-meta', text: tr('dlg.mac.files.queueReady', { n: ready }) })];
      if (ready) foot.push(keyed(button(tr('dlg.mac.files.queueClear'), () => { V.queue.folders = []; V.queue.files = []; filesChanged(); }), 'q-clear'));
      out.push(el('div', { class: 'ij-mac-files-queue' },
        el('p', { class: 'ij-mac-files-sub', text: tr('dlg.mac.files.queue', { folders: nFolders, files: nFiles }) }),
        items.length ? el('ul', { class: 'ij-mac-files-list' }, items) : null,
        el('div', { class: 'ij-mac-files-actions' }, foot)));
    }
    if (V.estimate && F) out.push(el('p', { class: 'ij-mac-files-storage', text: tr('dlg.mac.files.storage', { used: F.formatBytes(V.estimate.usage), quota: F.formatBytes(V.estimate.quota) }) }));
    return out;
  }
  function buildFiles(papi) {
    const toggle = el('button', { type: 'button', class: 'ij-mac-files-toggle', text: papi.tr('dlg.mac.files.title'), attrs: { 'aria-expanded': 'true' } });
    const body = el('div', { class: 'ij-mac-files-body' });
    toggle.addEventListener('click', () => {
      V.settings.collapsed = !V.settings.collapsed;
      dbPut('settings', { key: 'collapsed', value: V.settings.collapsed });
      if (!V.settings.collapsed) refreshEstimate();
      filesChanged();
    });
    const box = el('section', { class: 'ij-mac-files', attrs: { 'aria-label': papi.tr('dlg.mac.files.title') } }, toggle, body);
    let key = '';
    function render() {
      const busy = running();
      const k = V.ver + ':' + (busy ? 1 : 0);
      if (k === key) return;
      key = k;
      toggle.setAttribute('aria-expanded', V.settings.collapsed ? 'false' : 'true');
      body.hidden = V.settings.collapsed;
      if (V.settings.collapsed) { body.replaceChildren(); return; }
      const fk = focusedKey(body);
      body.replaceChildren(...filesContent(papi, busy));
      refocus(body, fk);
    }
    return { el: box, render };
  }

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
    const openBtn = button(papi.tr('dlg.mac.open'), () => openMacroFile());
    const saveBtn = button(papi.tr('dlg.mac.save'), () => saveMacroFile());
    const pause = buildPause(papi);
    const files = buildFiles(papi);
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
      status.textContent = V.pause ? papi.tr('dlg.mac.paused') : M.status.text;
      status.className = 'ij-mac-status' + (M.status.kind === 'error' && !V.pause ? ' ij-mac-status-err' : '');
      note.hidden = !M.notPersisted;
      paintGutter();
      pause.render();
      files.render();
    }
    // Open / Save: the picker opens in the click itself (pickFile / saveFile need its user activation)
    function openMacroFile() {
      const pr = papi.pickFile({ accept: '.ijm,.txt' });
      Promise.resolve(pr).then(async (list) => {
        const f = list && list[0];
        if (!f) return;
        const t = await f.text();
        ta.value = t;
        M.editorText = ta.value;
        M.editorFile = String(f.name || '');
        if (M.errorLine) M.errorLine = 0;
        schedulePersist(papi);
        paintGutter();
        scheduleScan();
      }).catch((err) => papi.error(err));
    }
    function saveMacroFile() {
      const base = String(M.editorFile || 'Macro').replace(/\.(ijm|txt)$/i, '') || 'Macro';
      const t = ta.value;
      Promise.resolve(papi.saveFile(base + '.ijm', 'text/plain', '.ijm', 'dlg.mac.ijmFiles', async () => new Blob([t], { type: 'text/plain' })))
        .catch((err) => papi.error(err));
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
    ta.addEventListener('input', () => { M.editorText = ta.value; schedulePersist(papi); paintGutter(); scheduleScan(); });
    ta.addEventListener('scroll', () => { gutter.scrollTop = ta.scrollTop; });
    rootEl.appendChild(el('div', { class: 'ij-mac-editor' },
      el('div', { class: 'ij-mac-toolbar' }, runBtn, selBtn, abortBtn, openBtn, saveBtn, status),
      pause.el,
      el('div', { class: 'ij-mac-body' }, gutter, ta),
      note,
      files.el));
    const inst = { render, showLine, _state: () => ({ ta, gutter, status, note, runBtn, selBtn, abortBtn, openBtn, saveBtn, pause: pause.el, files: files.el }) };
    M.panels.editor.add(inst);
    render();
    // a question of the worker keeps the focus on its strip
    if (!V.pause && typeof ta.focus === 'function') ta.focus();
    filesOpened(papi);
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
      // Plugins › Macros › Run…: the code to run, prefilled with the editor's text (a macro file of the computer opens in the editor with Open…;
      // run("Run...", "run=<path>") inside a macro is a file command of the worker)
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
      // room for the Files section under the text
      macroEditor: { titleKey: 'dlg.mac.editorTitle', build: buildEditor, persist: true, defaultSize: { w: 640, h: 560 } },
      macroLog: { titleKey: 'dlg.mac.logTitle', build: buildLog, persist: true, defaultSize: { w: 480, h: 320 } },
      macroError: { titleKey: 'dlg.mac.errorTitle', build: buildError, persist: true, defaultSize: { w: 520, h: 240 } },
      macroText: { titleKey: 'dlg.mac.textTitle', build: buildText, persist: true, defaultSize: { w: 480, h: 320 } }
    },
    errors: {
      IJ_MACRO_BUSY: 'err.macBusy', IJ_MACRO_STEP_BUSY: 'err.macStepBusy', IJ_MACRO_GROUP: 'err.macUndoDuringRun',
      // FILES.md §5.2
      IJ_MACRO_VFS_QUOTA: 'err.macZipQuota', IJ_MACRO_VFS_BUSY: 'err.macWorkspaceBusy', IJ_MACRO_VFS_NO_STORAGE: 'err.macNoStorageUi', IJ_MACRO_FILE_DIRECT: 'err.macFileDirect'
    }
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
        Object.assign(M, { log: [], texts: new Map(), activeText: null, editorText: null, editorFile: null, persisted: null, notPersisted: false, persistTimer: 0, lastError: null, errorLine: 0,
          run: null, status: { kind: 'idle', text: '' }, memPrefs: null, renderTimer: 0 });
      },
      startRun,
      // files (FILES.md)
      files: Object.freeze({
        state: () => V, DB_NAME, DB_VERSION, DB_STORES, ensureLoaded, grantsList, grantOf, recordOf, rootFromRecord, snapshotOfFiles, snapshotOfEntry,
        suggestedName, cleanFileName, pendingNeeds, runScan, refreshChanges, refreshEstimate, vfsRunArgs, rootState, refreshPermission, snapshotPrint
      })
    })
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
