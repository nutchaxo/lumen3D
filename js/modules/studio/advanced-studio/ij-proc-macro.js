/* ij-proc-macro.js — package `macro`: the worker runtime of ImageJ macros in the Advanced Studio.
 *
 * Loaded on the page AND in the worker (ij-worker.js loads it in the package's own try/catch, right after ij-macro-lang.js:
 * a failure of either withdraws package `macro` and never stops the engine). Contract: DOCS/studio-advanced/macros/INTEGRATION.md
 * (§3 protocol, §4 IJMacroProto, §6 scope); the language itself is IJMacro (ij-macro-lang.js, worker only).
 *
 *   page AND worker   IJMacroProto: the shared protocol tables (TEXT_KEYS, RPC_METHODS, WRITE_OPS, OPTION_SETTINGS, log)
 *                     the command specs `macro.run` (long) and `macro.reply` (passive), registered on both sides so the page's
 *                     callExt ownership check knows them; only the worker runs a handler.
 *   worker            one macro run = one `macro.run` request: the interpreter (IJMacro.run), an RPC client to the page
 *                     (event `macro.rpc` → passive command `macro.reply`), a write-behind queue, a mirror of the page state, the
 *                     working copies of the planes a macro writes (published through E.commitPlanes), the Log stream, and every
 *                     built-in of the phase that needs the Studio (image model, stacks, page state, call(), the refusals).
 *
 * The built-ins are installed lazily, once, the first time a run starts (installBuiltins): this file never reads IJMacro at load
 * time, so its page copy is inert and a worker whose language file failed never half-installs.
 *
 * Reference semantics: ImageJ 1.54p (public domain): ij.macro.Functions, ij.process.{Byte,Short,Float,Color}Processor,
 * ImageStatistics, NewImage, ImageCalculator. Goldens: tests/fixtures/ij-macro/runtime-golden.json (tools/ij_fixtures/macro/
 * run_runtime.sh). Macros never use the network and never reach the site's datasets: nothing here fetches, imports a script,
 * starts a worker or evaluates text other than macro code.
 */
(function (root) {
  'use strict';
  const R = root.IJOpRegistry;
  // The language (ij-macro-lang.js) is a top-level const of its own script: a global binding, not a property of self.
  const LANG = () => (typeof IJMacro !== 'undefined' ? IJMacro : null);

  // ════════════════════════════════════════════════════════════════════════════════════════════════
  //  IJMacroProto — the shared protocol tables (INTEGRATION.md §4)
  // ════════════════════════════════════════════════════════════════════════════════════════════════

  /** Every lang key the worker needs (sent translated as `args.texts`). */
  const TEXT_KEYS = Object.freeze([
    'err.macFileLater', 'err.macNetwork', 'err.macBioFormats', 'err.macExec', 'err.macEvalScript', 'err.macExtensions',
    'err.macDebug', 'err.macCallRefused', 'err.macPadLimit', 'err.macPrefsQuota', 'err.mac16bitRange', 'err.macPageTimeout',
    'err.macNotInBrowser', 'err.macArrow', 'err.macClipboard'
  ]);

  /** The closed list of page methods the worker calls (§4.1). interactive = no timeout (it waits for the operator). */
  const RPC_METHODS = Object.freeze({
    'run': Object.freeze({ interactive: true }),
    'dialog.show': Object.freeze({ interactive: true }),
    'dialog.message': Object.freeze({ interactive: true }),
    'dialog.messageCancel': Object.freeze({ interactive: true }),
    'dialog.waitForUser': Object.freeze({ interactive: true }),
    'dialog.number': Object.freeze({ interactive: true }),
    'dialog.string': Object.freeze({ interactive: true }),
    'dialog.boolean': Object.freeze({ interactive: true }),
    'error.show': Object.freeze({ interactive: true }),
    'image.select': Object.freeze({ interactive: true }),
    'image.close': Object.freeze({ interactive: true }),
    'image.show': Object.freeze({ interactive: true }),
    'image.adopt': Object.freeze({ interactive: true }),
    'window.select': Object.freeze({ interactive: true }),
    'window.close': Object.freeze({ interactive: true }),
    'clipboard.copy': Object.freeze({ interactive: true }),
    'flush': Object.freeze({ interactive: false }),
    'image.rename': Object.freeze({ interactive: false }),
    'window.print': Object.freeze({ interactive: false }),
    'command.list': Object.freeze({ interactive: false })
  });

  /** The closed list of write-behind operations (§4.2), applied by the page in order before the method of the next request. */
  const WRITE_OPS = Object.freeze(['roi.set', 'display.set', 'display.lut', 'display.mode', 'display.visible', 'thr.set', 'thr.reset',
    'thr.mode', 'table.replace', 'table.remove', 'table.rename', 'table.show', 'rm.set', 'rm.select', 'rm.show', 'setting.set',
    'measurements.set', 'colors.set', 'tool.set', 'status.show', 'progress.show']);

  /**
   * setOption(name, state) names with a Studio meaning, from Functions.setOption 1.54p (the order of its if/else chain, lower-cased
   * name; `match` says how ImageJ compares: 'eq' arg1.equals, 'start' arg1.startsWith, 'has' arg1.indexOf(...) != -1).
   *   { setting: key }       a Studio setting (MACRO_SETTING_KEYS), written with setting.set
   *   { measurement: group } a Set Measurements group (Analyzer.setMeasurement), written with measurements.set
   *   { noop: true }         a host option without a browser meaning (accepted, nothing happens)
   *   { rmShow: true }       "Show All" of the ROI Manager;  { changes: true } the image's `changes` flag
   * A name that matches none is ImageJ's "Invalid option".
   */
  const OPTION_SETTINGS = Object.freeze({
    'disablepopupmenu': Object.freeze({ noop: true, match: 'eq' }),
    'show all': Object.freeze({ rmShow: true, match: 'start' }),
    'changes': Object.freeze({ changes: true, match: 'eq' }),
    'debugmode': Object.freeze({ noop: true, match: 'eq' }),
    'openusingplugins': Object.freeze({ noop: true, match: 'eq' }),
    'queuemacros': Object.freeze({ noop: true, match: 'eq' }),
    'disableundo': Object.freeze({ noop: true, match: 'eq' }),
    'openashyper': Object.freeze({ noop: true, match: 'start' }),
    'black': Object.freeze({ setting: 'thr.blackBackground', match: 'start' }),
    'display lab': Object.freeze({ measurement: 'labels', match: 'start' }),
    'limit to': Object.freeze({ measurement: 'limit', match: 'start' }),
    'add to': Object.freeze({ measurement: 'addToOverlay', match: 'start' }),
    'area': Object.freeze({ measurement: 'area', match: 'eq' }),
    'mean': Object.freeze({ measurement: 'mean', match: 'eq' }),
    'perim': Object.freeze({ measurement: 'perimeter', match: 'start' }),
    'stack position': Object.freeze({ measurement: 'stackPos', match: 'eq' }),
    'std': Object.freeze({ measurement: 'stdDev', match: 'start' }),
    'showrowindexes': Object.freeze({ noop: true, match: 'eq' }),
    'show': Object.freeze({ noop: true, match: 'start' }),
    'bicubic': Object.freeze({ noop: true, match: 'start' }),
    'wand': Object.freeze({ noop: true, match: 'start' }),
    'points': Object.freeze({ noop: true, match: 'has' }),
    'expandablearrays': Object.freeze({ noop: true, match: 'start' }),
    'loop': Object.freeze({ noop: true, match: 'start' }),
    'jfilechooser': Object.freeze({ noop: true, match: 'start' }),
    'auto': Object.freeze({ noop: true, match: 'start' }),
    'antialiasedtext': Object.freeze({ noop: true, match: 'eq' }),
    'savebatchoutput': Object.freeze({ noop: true, match: 'eq' }),
    'converttomicrons': Object.freeze({ noop: true, match: 'start' }),
    'supportmacroundo': Object.freeze({ noop: true, match: 'start' }),
    'inverty': Object.freeze({ measurement: 'invertY', match: 'eq' }),
    'scaleconversions': Object.freeze({ setting: 'conv.scale', match: 'eq' }),
    'copyhead': Object.freeze({ noop: true, match: 'start' }),
    'waitforcompletion': Object.freeze({ noop: true, match: 'eq' }),
    'interpolatelines': Object.freeze({ noop: true, match: 'eq' }),
    'flipfitsimages': Object.freeze({ noop: true, match: 'eq' }),
    'monospaced': Object.freeze({ noop: true, match: 'start' }),
    'fullrange': Object.freeze({ noop: true, match: 'start' }),
    'opengrayscale': Object.freeze({ noop: true, match: 'start' }),
    'calibrate': Object.freeze({ noop: true, match: 'start' }),
    'mousewheel': Object.freeze({ noop: true, match: 'start' }),
    'setijmenubar': Object.freeze({ noop: true, match: 'start' })
  });
  /** The entry of OPTION_SETTINGS ImageJ's chain reaches first for `name` (lower-cased by the caller), or null. */
  function optionFor(lc) {
    for (const k of Object.keys(OPTION_SETTINGS)) {
      const o = OPTION_SETTINGS[k];
      if (o.match === 'eq' ? lc === k : o.match === 'start' ? lc.startsWith(k) : lc.indexOf(k) !== -1) return o;
    }
    return null;
  }

  // ---- Log: ImageJ's IJ.log + TextPanel rules ----
  const LOG_MAX_LINES = 100000;
  const LOG_SLACK = 4096;
  /* Java String.split("\n"): trailing empty strings removed, a string without "\n" is itself. */
  function javaSplitNl(s) {
    const parts = s.split('\n');
    while (parts.length > 1 && parts[parts.length - 1] === '') parts.pop();
    if (parts.length === 1 && parts[0] === '' && s.length > 0) return [];
    return parts;
  }
  function isDropMarker(x) { return x !== null && typeof x === 'object' && typeof x.dropped === 'number'; }
  /**
   * Applies print()'s raw strings to a Log line list (a fresh array is returned; the input is not modified):
   *   IJ.log: "if (s.startsWith("\\")) handleLogCommand(s); else { if (s.endsWith("\n")) { if (s.equals("\n\n")) s="\n \n ";
   *     else if (s.endsWith("\n\n")) s = s.substring(0, s.length()-2)+"\n \n "; else s = s+" "; } logPanel.append(s); }"
   *   handleLogCommand: "\\Closed" drops the panel (here: the lines; the next print starts a new Log); "\\Update:" replaces the last
   *     line (appends when empty); "\\Update<n>:" replaces line n (0..25, padding with empty lines; another n appends the text as
   *     it is); "\\Clear" empties; "\\Heading:" sets column headings (not part of the text); "\\Close" closes the Log window, which
   *     logs "\\Closed" (TextWindow.close); anything else is appended verbatim.
   *   TextPanel.append splits on "\n" (String.split).
   * The list keeps at most MAX_LINES text lines; older ones are dropped behind one { dropped: n } marker at index 0.
   */
  function logApply(lines, raw) {
    return logApplyInPlace(Array.isArray(lines) ? lines.slice() : [], raw, 0);
  }
  /**
   * logApply on `out` itself (mutated, returned): the worker's Log of a run, where a print must not copy the whole list. `slack` > 0
   * lets the list grow that many lines past MAX_LINES before the oldest are dropped in one splice (logText reads the last MAX_LINES).
   */
  function logApplyInPlace(out, raw, slack) {
    const marked = () => out.length > 0 && isDropMarker(out[0]);
    const textCount = () => out.length - (marked() ? 1 : 0);
    const trim = (limit) => {
      const k = textCount() - LOG_MAX_LINES;
      if (k <= 0 || textCount() <= limit) return;
      if (marked()) { out[0] = { dropped: out[0].dropped + k }; out.splice(1, k); }
      else { out.splice(0, k); out.unshift({ dropped: k }); }
    };
    const append = (s) => { for (const p of javaSplitNl(s)) out.push(p); };
    for (let s of raw || []) {
      if (s === null || s === undefined) continue;
      s = String(s);
      if (s.startsWith('\\')) {
        if (s === '\\Closed' || s === '\\Close' || s === '\\Clear') out.length = 0;
        else if (s.startsWith('\\Update:')) {
          const s2 = s.substring(8);
          if (textCount() === 0) append(s2); else out[out.length - 1] = s2;
        } else if (s.startsWith('\\Update')) {
          const ci = s.indexOf(':');
          if (ci === -1) { append(s); continue; }
          const line = toolsInt(s.substring(7, ci));
          if (line < 0 || line > 25) { append(s); continue; }
          // a line number counts from the first line kept: the slack goes first
          trim(LOG_MAX_LINES);
          const at = line + (marked() ? 1 : 0);
          while (at >= out.length) out.push('');
          out[at] = s.substring(ci + 1);
        } else if (s.startsWith('\\Heading:')) { /* column headings: not text */ }
        else append(s);
      } else {
        if (s.endsWith('\n')) {
          if (s === '\n\n') s = '\n \n ';
          else if (s.endsWith('\n\n')) s = s.substring(0, s.length - 2) + '\n \n ';
          else s = s + ' ';
        }
        append(s);
      }
    }
    trim(LOG_MAX_LINES + (slack > 0 ? slack : 0));
    return out;
  }
  /** IJ.getLog / TextPanel.getText: every text line followed by "\n" ("" for an empty Log). */
  function logText(lines) {
    const list = lines || [];
    let n = 0;
    for (const l of list) if (!isDropMarker(l)) n++;
    // a list with slack (logApplyInPlace) holds more than MAX_LINES: the oldest ones are no longer in the Log
    let skip = n > LOG_MAX_LINES ? n - LOG_MAX_LINES : 0;
    const parts = [];
    for (const l of list) {
      if (isDropMarker(l)) continue;
      if (skip > 0) { skip--; continue; }
      parts.push(l);
    }
    return parts.length ? parts.join('\n') + '\n' : '';
  }
  /* (int)Tools.parseDouble(s, -1) */
  function toolsInt(s) {
    const v = parseJavaDouble(s);
    return v === null || v !== v ? -1 : d2i(v);
  }

  root.IJMacroProto = Object.freeze({
    TEXT_KEYS, RPC_METHODS, WRITE_OPS, OPTION_SETTINGS,
    log: Object.freeze({ MAX_LINES: LOG_MAX_LINES, apply: logApply, text: logText }),
    optionFor
  });

  // ════════════════════════════════════════════════════════════════════════════════════════════════
  //  Java helpers
  // ════════════════════════════════════════════════════════════════════════════════════════════════

  /* (int) of a double: NaN → 0, saturating, truncating toward zero. */
  function d2i(x) {
    if (x !== x) return 0;
    if (x >= 2147483647) return 2147483647;
    if (x <= -2147483648) return -2147483648;
    return x < 0 ? Math.ceil(x) : Math.floor(x);
  }
  /* java.lang.Math.round(double) */
  const jround = (v) => Math.floor(v + 0.5);
  /* Double.parseDouble of a trimmed string (Tools.parseDouble): null when it is not a Java double literal. */
  const JAVA_DOUBLE = /^[+-]?(NaN|Infinity|((\d+\.?\d*|\.\d+)([eE][+-]?\d+)?)[fFdD]?)$/;
  function parseJavaDouble(s) {
    if (typeof s !== 'string') return null;
    const t = s.trim();
    if (!JAVA_DOUBLE.test(t)) return null;
    const core = t.replace(/[fFdD]$/, '');
    return Number(core);
  }
  function toolsParseDouble(s, dflt) { const v = parseJavaDouble(s); return v === null ? dflt : v; }
  const ctorOf = (bd) => (bd === 8 ? Uint8Array : bd === 16 ? Uint16Array : Float32Array);
  function ijError(code, message) { const e = new Error(message || code); e.code = code; return e; }
  /** A macro error with ImageJ's (or a translated) text: hostHook turns it into an interpreter error at the current line. */
  function macroError(text) { const e = new Error(text); e.macroText = text; return e; }
  const now = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());

  // ════════════════════════════════════════════════════════════════════════════════════════════════
  //  call(): the whitelist of CALL-WHITELIST.md §5 (exact string, no reflection)
  // ════════════════════════════════════════════════════════════════════════════════════════════════

  /* Tools.parseDouble for call()'s pass 2: Double.parseDouble(trim); "NaN" parses but counts as not a number. */
  function callNumber(s) {
    const v = parseJavaDouble(String(s));
    return v === null || v !== v ? null : v;
  }
  const CALL_TABLE = new Map([
    ['ij.Prefs.get', { overloads: [['S', 'S']] }],
    ['ij.Prefs.set', { overloads: [['S', 'S']] }],
    ['ij.IJ.freeMemory', { overloads: [[]] }],
    ['ij.IJ.currentMemory', { overloads: [[]] }],
    ['ij.IJ.maxMemory', { overloads: [[]] }],
    ['ij.IJ.pad', { overloads: [['I', 'I'], ['S', 'I']] }],
    ['ij.plugin.frame.RoiManager.getName', { overloads: [['S']] }],
    ['ij.plugin.frame.ThresholdAdjuster.setMode', { overloads: [['S']] }],
    ['ij.gui.ImageWindow.setNextLocation', { overloads: [['I', 'I']] }],
    ['ij.ImagePlus.setDefault16bitRange', { overloads: [['I']] }]
  ]);
  /**
   * ImageJ's resolution of call(target, args…) against the whitelist (Functions.call, bytecode): split at the LAST '.', pass 1 =
   * every argument a String, pass 2 (n > 0) = a numeric argument becomes (int) of its value; the overload set is the entry's only.
   * → { target, javaArgs, sig } | { error: text } | { refused: true }
   */
  function resolveCall(target, args) {
    const dot = target.lastIndexOf('.');
    if (dot < 0) return { error: "'classname.methodname' expected" };
    const entry = CALL_TABLE.get(target);
    if (!entry) return { refused: true };
    const cls = target.substring(0, dot), m = target.substring(dot + 1), n = args.length;
    const all = entry.overloads.filter((o) => o.length === n);
    if (all.some((o) => o.every((t) => t === 'S'))) return { target, javaArgs: args.slice(), sig: all.find((o) => o.every((t) => t === 'S')) };
    if (n > 0) {
      const types = args.map((a) => (callNumber(a) === null ? 'S' : 'I'));
      const hit = all.find((o) => o.every((t, i) => t === types[i]));
      if (hit) return { target, javaArgs: args.map((a, i) => (types[i] === 'I' ? d2i(callNumber(a)) : a)), sig: hit };
    }
    return { error: 'Could not find the method ' + m + ' with ' + n + ' parameter(s) in class ' + cls };
  }
  /** ij.IJ.freeMemory over the engine's accounting (CALL-WHITELIST §5). */
  function freeMemoryText(inUse, max) {
    let s = inUse < 10240000 ? Math.floor(inUse / 1024) + 'K' : Math.floor(inUse / 1048576) + 'MB';
    if (max > 0) {
      const p = Number((BigInt(Math.floor(inUse)) * 100n) / BigInt(Math.floor(max)));
      s += ' of ' + Math.floor(max / 1048576) + 'MB (' + (p < 1 ? '<1' : String(p)) + '%)';
    }
    return s;
  }
  const PREF_MAX_KEYS = 256, PREF_MAX_VALUE = 8192, PREF_MAX_TOTAL = 65536, PREF_MAX_KEY = 128;

  // ════════════════════════════════════════════════════════════════════════════════════════════════
  //  Studio measurement keys ↔ ImageJ column headings (ij-app.js COLUMNS / MEASURE_GROUPS)
  // ════════════════════════════════════════════════════════════════════════════════════════════════
  const MEASURE_COLUMNS = [
    ['area', 'Area'], ['mean', 'Mean'], ['stdDev', 'StdDev'], ['mode', 'Mode'], ['min', 'Min'],
    ['max', 'Max'], ['xCentroid', 'X'], ['yCentroid', 'Y'], ['xCenterOfMass', 'XM'],
    ['yCenterOfMass', 'YM'], ['perim', 'Perim.'], ['bx', 'BX'], ['by', 'BY'], ['bw', 'Width'], ['bh', 'Height'],
    ['major', 'Major'], ['minor', 'Minor'], ['angle', 'Angle'], ['circularity', 'Circ.'], ['feret', 'Feret'],
    ['intDen', 'IntDen'], ['median', 'Median'], ['skewness', 'Skew'], ['kurtosis', 'Kurt'], ['areaFraction', '%Area'],
    ['rawIntDen', 'RawIntDen'], ['feretX', 'FeretX'], ['feretY', 'FeretY'], ['feretAngle', 'FeretAngle'], ['minFeret', 'MinFeret'],
    ['aspectRatio', 'AR'], ['roundness', 'Round'], ['solidity', 'Solidity'], ['minThreshold', 'MinThr'], ['maxThreshold', 'MaxThr'],
    ['length', 'Length']
  ];
  /* ResultsTable.getDefaultHeadings (the columns getValue(key) accepts by prefix), in ImageJ's order. */
  const DEFAULT_HEADINGS = ['Area', 'Mean', 'StdDev', 'Mode', 'Min', 'Max', 'X', 'Y', 'XM', 'YM', 'Perim.', 'BX', 'BY', 'Width', 'Height',
    'Major', 'Minor', 'Angle', 'Circ.', 'Feret', 'IntDen', 'Median', 'Skew', 'Kurt', '%Area', 'RawIntDen', 'Ch', 'Slice', 'Frame',
    'FeretX', 'FeretY', 'FeretAngle', 'MinFeret', 'AR', 'Round', 'Solidity', 'MinThr', 'MaxThr'];
  const KEY_OF_HEADING = new Map(MEASURE_COLUMNS.map(([k, h]) => [h, k]));
  const ALL_MEASURE_KEYS = MEASURE_COLUMNS.map(([k]) => k).filter((k) => k !== 'length');

  // ════════════════════════════════════════════════════════════════════════════════════════════════
  //  Page + worker: the worker command specs
  // ════════════════════════════════════════════════════════════════════════════════════════════════

  const RUNS = new Map();   // runId → Run (at most one at a time per worker)

  if (R && typeof R.defineCommand === 'function') {
    if (!R.getCommand('macro.run')) R.defineCommand('macro.run', { pkg: 'macro', long: true, handler: (a, E) => macroRun(a, E) });
    if (!R.getCommand('macro.reply')) {
      R.defineCommand('macro.reply', {
        pkg: 'macro', passive: true,
        handler(a) {
          const run = a && typeof a.runId === 'string' ? RUNS.get(a.runId) : null;
          if (run) run.onReply(a);
          return {};
        }
      });
    }
  }

  // An op of this package: the calibration a macro sets (setVoxelSize, Stack.setXUnit … setFrameInterval). Calibration only: the planes
  // come back as they are, which the engine records as a calibration change. ImageJ keeps every field of Calibration it is given.
  if (R && typeof R.define === 'function' && !R.get('macroCalibration')) {
    R.define('macroCalibration', {
      kind: 'size', version: 1, stack: 'all', rgb: 'each',
      validate(p) {
        if (!p || typeof p.calibration !== 'object' || p.calibration === null) throw ijError('IJ_BAD_ARGS', 'calibration');
        for (const k of ['pixelWidth', 'pixelHeight', 'pixelDepth', 'frameInterval', 'fps', 'xOrigin', 'yOrigin', 'zOrigin'])
          if (p.calibration[k] !== undefined && typeof p.calibration[k] !== 'number') throw ijError('IJ_BAD_ARGS', k);
        for (const k of ['unit', 'timeUnit', 'yUnit', 'zUnit', 'valueUnit'])
          if (p.calibration[k] !== undefined && (typeof p.calibration[k] !== 'string' || p.calibration[k].length > 64)) throw ijError('IJ_BAD_ARGS', k);
      },
      async run(view, p) {
        const cal = Object.assign({}, view.calibration || {}, p.calibration);
        return { width: view.width, height: view.height, bitDepth: view.bitDepth, calibration: cal, channels: view.channels.map((c) => ({ data: c.data })) };
      }
    });
  }

  // ════════════════════════════════════════════════════════════════════════════════════════════════
  //  Worker: one run
  // ════════════════════════════════════════════════════════════════════════════════════════════════

  let RPC_TIMEOUT_MS = 30000;
  // the methods after which the page's active image is the macro's current one
  const TAKES_CURRENT = new Set(['image.select', 'image.close', 'window.select']);
  const FLUSH_MS = 250, TABLE_FLUSH_MS = 1000, LOG_FLUSH_MS = 50, CANCEL_POLL_MS = 20;
  const RGB_NAMES = [{ name: 'Red', color: '#ff0000' }, { name: 'Green', color: '#00ff00' }, { name: 'Blue', color: '#0000ff' }];
  const COMPOSITE_COLORS = ['#ff0000', '#00ff00', '#0000ff', '#ffffff', '#00ffff', '#ff00ff', '#ffff00'];

  function emptyTable(name) { return { name, size: 0, headings: [], columns: {}, labels: null, rev: 0 }; }
  function cloneTable(t) {
    const columns = {};
    for (const h of t.headings || []) columns[h] = (t.columns && t.columns[h] ? t.columns[h] : []).slice();
    return { name: t.name, size: t.size | 0, headings: (t.headings || []).slice(), columns, labels: t.labels ? t.labels.slice() : null, rev: t.rev | 0 };
  }

  class Run {
    constructor(a, E) {
      this.E = E;
      this.runId = a.runId;
      this.name = typeof a.name === 'string' && a.name ? a.name : 'Macro';
      this.texts = a.texts && typeof a.texts === 'object' ? a.texts : {};
      this.prefs = new Map();
      if (a.prefs && typeof a.prefs === 'object') for (const k of Object.keys(a.prefs)) this.prefs.set(k, String(a.prefs[k]));
      this.prefsWrites = new Map();
      this.ctrl = new AbortController();
      this.ending = false;
      // page state
      this.images = new Map();
      this.order = [];
      this.current = null;
      this.selections = {};
      this.rm = { list: [], selected: [], showAll: false, labels: false };
      this.tables = new Map();
      this.thresholds = {};
      this.thresholdWindow = null;
      this.settings = {};
      this.measurements = { groups: ['area', 'mean', 'minMax'], decimals: 3 };
      this.colors = { foreground: [255, 255, 255], background: [0, 0, 0], selection: [255, 255, 0] };
      this.lineWidth = 1;
      this.tool = 'rect';
      this.workspace = { width: 1024, height: 768 };
      this.applyMirror(a.mirror || {}, true);
      // write-behind queue
      this.queue = [];
      this.dirtyTables = new Map();
      this.lastTableSend = now();
      this.flushTimer = null;
      // rpc
      this.reqSeq = 0;
      this.pending = null;
      this.chain = Promise.resolve();
      this.rpcCount = 0;
      // log
      this.logLines = logApply([], []);
      if (Array.isArray(a.log)) this.logLines = a.log.slice();
      this.logPending = [];
      this.logTimer = null;
      // pixels
      this.work = new Map();       // `${docId}:${c}:${pi}` → { docId, c, z, t, data, alpha? }
      this.P = null;               // the processor of the current image (ImageJ's defaultIP), dropped by resetImage()
      this.snapshots = new Map();  // docId → { pos, planes: [copies] } (snapshot / reset)
      this.draw = { color: null, value: NaN, lineWidth: 0, x: 0, y: 0, autoUpdate: true };
      this.changed = new Set();
      this.batch = false;
      this.batchDocs = [];         // ImageJ's Interpreter.imageTable: the images made in batch mode, in order
      this.keys = { alt: false, shift: false };
      this.infoProps = new Map();  // docId → "Info" property (setMetadata("Info", …)), kept for the run
      this.dialog = null;          // Dialog.create … Dialog.show
      this.currentTable = null;
      this.rgbWeights = null;
      this.host = this.makeHost();
    }

    tr(key, params) {
      let s = this.texts[key];
      if (typeof s !== 'string') s = key;
      if (params) s = s.replace(/\{([A-Za-z0-9_]+)\}/g, (m, k) => (params[k] !== undefined ? String(params[k]) : m));
      return s;
    }

    // ---------------------------------------------------------------- mirror
    /** takeCurrent: the page's active image becomes the macro's current one (the first mirror, a close, a selection, an operator's
     *  pause); otherwise the worker keeps its own (ImageJ's current image of the macro is not the page's focus) while it is open. */
    applyMirror(m, first, takeCurrent) {
      if (!m || typeof m !== 'object') return;
      if (Array.isArray(m.images)) {
        this.images = new Map();
        this.order = [];
        for (const im of m.images) {
          if (!im || im.docId === undefined || im.docId === null) continue;
          this.images.set(im.docId, Object.assign({}, im));
          this.order.push(im.docId);
        }
      }
      if (m.current !== undefined) {
        // the page's active image moved during the request (the operator picked another one in a pause): it is the macro's now
        const moved = !first && m.current !== this.pageCurrent;
        if (first || takeCurrent || moved || this.current === null || !this.images.has(this.current)) this.current = m.current;
        this.pageCurrent = m.current;
      }
      if (m.selections && typeof m.selections === 'object') this.selections = Object.assign({}, m.selections);
      if (m.roiManager && typeof m.roiManager === 'object') {
        const r = m.roiManager;
        // same: the list is the one the page sent last (it goes once per change)
        const list = r.same === true && this.rm && Array.isArray(this.rm.list) ? this.rm.list : (Array.isArray(r.list) ? r.list.slice() : []);
        this.rm = { list, selected: Array.isArray(r.selected) ? r.selected.slice() : [], showAll: !!r.showAll, labels: !!r.labels };
      }
      if (m.tables && typeof m.tables === 'object') {
        const next = new Map();
        for (const name of Object.keys(m.tables)) {
          const t = m.tables[name];
          if (t && t.same === true) { if (this.tables.has(name)) next.set(name, this.tables.get(name)); }
          else if (t && typeof t === 'object') next.set(name, cloneTable(Object.assign({ name }, t)));
        }
        // a table this run changed and has not sent yet keeps its local content
        if (this.dirtyTables) for (const [name, t] of this.dirtyTables) next.set(name, t);
        if (!next.has('Results')) next.set('Results', this.tables.get('Results') || emptyTable('Results'));
        this.tables = next;
      } else if (first) this.tables.set('Results', emptyTable('Results'));
      if (m.thresholds && typeof m.thresholds === 'object') this.thresholds = JSON.parse(JSON.stringify(m.thresholds));
      if (m.thresholdWindow !== undefined) this.thresholdWindow = m.thresholdWindow;
      if (m.settings && typeof m.settings === 'object') this.settings = Object.assign({}, m.settings);
      if (m.measurements && typeof m.measurements === 'object') this.measurements = { groups: Array.isArray(m.measurements.groups) ? m.measurements.groups.slice() : [], decimals: m.measurements.decimals | 0 };
      if (m.colors && typeof m.colors === 'object') this.colors = Object.assign({}, this.colors, m.colors);
      if (typeof m.lineWidth === 'number') this.lineWidth = m.lineWidth;
      if (typeof m.tool === 'string') this.tool = m.tool;
      if (m.workspace && typeof m.workspace === 'object') this.workspace = Object.assign({}, m.workspace);
      this.P = null;
    }

    // ---------------------------------------------------------------- write-behind
    write(op, args) {
      if (WRITE_OPS.indexOf(op) < 0) throw ijError('IJ_INTERNAL', 'write op ' + op);
      if (op === 'table.replace') { this.dirtyTables.set(args.name, args.table); this.scheduleFlush(); return; }
      if (op === 'table.remove') this.dirtyTables.delete(args.name);
      if (op === 'table.rename' && this.dirtyTables.has(args.from)) {
        // the rows written so far must reach the page under the old name before it is renamed
        this.queue.push(['table.replace', { name: args.from, table: cloneTable(this.dirtyTables.get(args.from)) }]);
        this.dirtyTables.delete(args.from);
      }
      this.queue.push([op, args]);
      this.scheduleFlush();
    }
    scheduleFlush() {
      if (this.flushTimer || this.ending) return;
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        if (this.ending || this.ctrl.signal.aborted) return;
        const tablesDue = this.dirtyTables.size && now() - this.lastTableSend >= TABLE_FLUSH_MS;
        if (!this.queue.length && !tablesDue) { if (this.dirtyTables.size) this.scheduleFlush(); return; }
        this.rpc('flush', {}).catch(() => {});
        if (this.dirtyTables.size) this.scheduleFlush();
      }, FLUSH_MS);
    }
    takeWrites(withTables) {
      const out = this.queue;
      this.queue = [];
      if (withTables && this.dirtyTables.size) {
        for (const [name, table] of this.dirtyTables) out.push(['table.replace', { name, table: cloneTable(table) }]);
        this.dirtyTables.clear();
        this.lastTableSend = now();
      }
      return out;
    }

    // ---------------------------------------------------------------- RPC
    rpc(method, args) {
      if (!Object.prototype.hasOwnProperty.call(RPC_METHODS, method)) return Promise.reject(ijError('IJ_INTERNAL', 'rpc ' + method));
      const p = this.chain.then(() => this.send(method, args || {}));
      this.chain = p.catch(() => {});
      return p;
    }
    async send(method, args, allTables) {
      if (this.ctrl.signal.aborted) throw new (LANG().MacroCancel)('abort');
      if (method !== 'flush') { await this.commitAll(); this.P = null; }
      this.flushLog();
      const tablesDue = allTables === true || method !== 'flush' || now() - this.lastTableSend >= TABLE_FLUSH_MS;
      const writes = this.takeWrites(tablesDue);
      const reqId = ++this.reqSeq;
      this.rpcCount++;
      return new Promise((resolve, reject) => {
        const pend = { reqId, method, resolve, reject, timer: null };
        if (!RPC_METHODS[method].interactive) {
          pend.timer = setTimeout(() => {
            if (this.pending !== pend) return;
            this.pending = null;
            reject(macroError(this.tr('err.macPageTimeout', { method })));
          }, RPC_TIMEOUT_MS);
        }
        this.pending = pend;
        try {
          this.E.postEvent({ event: 'macro.rpc', runId: this.runId, reqId, method, args, writes });
        } catch (err) { this.pending = null; if (pend.timer) clearTimeout(pend.timer); reject(err); }
      });
    }
    onReply(a) {
      const pend = this.pending;
      if (!pend || a.reqId !== pend.reqId) return;   // a late reply of a run that moved on
      this.pending = null;
      if (pend.timer) clearTimeout(pend.timer);
      // a flush reply only acknowledges writes: its mirror could predate a write queued since it left
      if (a.mirror && pend.method !== 'flush') this.applyMirror(a.mirror, false, TAKES_CURRENT.has(pend.method));
      if (a.ok) pend.resolve(a.result === undefined ? {} : a.result);
      else pend.reject(macroError(a.error && typeof a.error.text === 'string' ? a.error.text : ''));
    }
    abort() {
      if (this.ctrl.signal.aborted) return;
      this.ctrl.abort();
      const pend = this.pending;
      if (pend) {
        this.pending = null;
        if (pend.timer) clearTimeout(pend.timer);
        pend.reject(new (LANG().MacroCancel)('abort'));
      }
    }

    // ---------------------------------------------------------------- log
    log(s) {
      // in place: a run that prints 100 000 lines must not copy the list at every print
      this.logLines = logApplyInPlace(this.logLines, [s], LOG_SLACK);
      this.logPending.push(s);
      if (!this.logTimer) this.logTimer = setTimeout(() => { this.logTimer = null; this.flushLog(); }, LOG_FLUSH_MS);
    }
    flushLog() {
      if (this.logTimer) { clearTimeout(this.logTimer); this.logTimer = null; }
      if (!this.logPending.length) return;
      const lines = this.logPending;
      this.logPending = [];
      try { this.E.postEvent({ event: 'macro.log', runId: this.runId, lines }); } catch (err) { console.error('[advanced-studio] macro log', err); }
    }

    // ---------------------------------------------------------------- working copies
    plane(docId, c, z, t) {
      const d = this.E.dims(docId);
      const w = this.work.get(docId + ':' + c + ':' + (t * d.nZ + z));
      return w ? w.data : this.E.plane(docId, c, z, t);
    }
    writable(docId, c, z, t, nZ) {
      const key = docId + ':' + c + ':' + (t * nZ + z);
      let w = this.work.get(key);
      if (!w) {
        const src = this.E.plane(docId, c, z, t);
        this.E.reserve(src.byteLength);
        w = { docId, c, z, t, data: src.slice(), alpha: null };
        this.work.set(key, w);
      }
      return w;
    }
    /** Sends the queued writes now (one flush request) when there are any. */
    async syncWrites() {
      if (this.queue.length || this.dirtyTables.size) await this.rpc('flush', {});
    }
    /** Publishes every working copy (one E.commitPlanes per document, inside the run's undo group) and drops them. */
    /** final = the end of the run: an aborted run still publishes what it wrote (the request is cancelled by then). */
    async commitAll(final) {
      if (!this.work.size) return;
      const byDoc = new Map();
      for (const w of this.work.values()) {
        if (!byDoc.has(w.docId)) byDoc.set(w.docId, []);
        byDoc.get(w.docId).push({ c: w.c, z: w.z, t: w.t, data: w.data });
      }
      this.work = new Map();
      this.P = null;
      for (const [docId, list] of byDoc) {
        let open = true;
        try { this.E.dims(docId); } catch (_) { open = false; }
        if (!open) { for (const it of list) this.E.release(it.data.byteLength); continue; }
        await this.E.commitPlanes(docId, list, final ? { labelKey: 'op.macRun', final: true } : { labelKey: 'op.macRun' });
        this.changed.add(docId);
      }
    }

    // ---------------------------------------------------------------- host of IJMacro.run
    makeHost() {
      const M = this;
      return {
        M,
        syncFunctions: new Set(['setOption', 'String.getResultsHeadings', 'String.setFontSize', 'IJ.deleteRows', 'IJ.freeMemory',
          'IJ.currentMemory', 'IJ.maxMemory', 'IJ.getToolName', 'IJ.renameResults', 'Array.show']),
        call(name, args) { return hostCall(M, name, args); },
        showMessage(title, text) { return M.rpc('dialog.message', { title: String(title), text: String(text) }).then(() => undefined); },
        showError(text) { return M.rpc('error.show', { text: String(text) }).then(() => undefined); },
        printToWindow(title, text) { return M.rpc('window.print', { title: String(title), text: String(text) }).then(() => undefined); },
        runMacroFile(path) { throw macroError(M.tr('err.macFileLater', { name: 'runMacro("' + String(path) + '")' })); },
        getVersion() { return '1.54p'; }
      };
    }
  }

  // ---------------------------------------------------------------- the macro.run handler
  async function macroRun(a, E) {
    const IJMacro = LANG();
    if (!IJMacro || typeof IJMacro.run !== 'function') throw ijError('IJ_MODULE_MISSING', 'the macro language did not load');
    if (!a || typeof a.runId !== 'string' || !a.runId || typeof a.source !== 'string') throw ijError('IJ_BAD_ARGS', 'macro.run');
    if (RUNS.size) throw ijError('IJ_MACRO_BUSY', 'a macro is already running');
    installBuiltins();
    const M = new Run(a, E);
    RUNS.set(a.runId, M);
    const opt = a.options && typeof a.options === 'object' ? a.options : {};
    let groupOpen = false, poll = null, res = null, endError = null;
    try {
      if (E.macroGroup && typeof E.macroGroup.begin === 'function') { E.macroGroup.begin({ runId: a.runId, labelKey: 'op.macRun' }); groupOpen = true; }
      if (typeof E.onCancel === 'function') E.onCancel(() => M.abort());
      // the cancel of the request also reaches a run whose engine has no onCancel hook (E.check throws once the task is cancelled)
      poll = setInterval(() => { try { E.check(); } catch (_) { M.abort(); } }, CANCEL_POLL_MS);
      res = await IJMacro.run(a.source, {
        host: M.host, signal: M.ctrl.signal, onLog: (s) => M.log(s), arg: typeof a.arg === 'string' ? a.arg : '',
        fastPath: opt.fastPath !== false, syncLoops: opt.syncLoops === true, syncRecursion: opt.syncRecursion === true, sliceMs: 50
      });
    } finally {
      if (poll) clearInterval(poll);
      M.ending = true;
      if (M.flushTimer) { clearTimeout(M.flushTimer); M.flushTimer = null; }
      // an abort keeps the changes made so far (ImageJ), published as part of the one undo step
      try { await M.commitAll(true); } catch (err) {
        // an engine whose commitPlanes ignores the `final` option refuses a cancelled request: the changes of an aborted run are lost
        if (!(err && err.code === 'IJ_CANCELLED')) { endError = endError || err; console.error('[advanced-studio] macro commit', err); }
      }
      M.flushLog();
      if (!M.ctrl.signal.aborted && (M.queue.length || M.dirtyTables.size)) {
        try { await M.chain; await M.send('flush', {}, true); } catch (err) { console.error('[advanced-studio] macro flush', err); }
      }
      RUNS.delete(a.runId);
    }
    let undo = { changed: [], dropped: [] };
    if (groupOpen) {
      try { undo = await E.macroGroup.end(a.runId); } catch (err) { console.error('[advanced-studio] macro undo group', err); }
    }
    const changedDocs = Array.from(new Set(Array.from(M.changed).concat(undo && Array.isArray(undo.changed) ? undo.changed : [])));
    const prefsWrites = {};
    for (const [k, v] of M.prefsWrites) prefsWrites[k] = v;
    let error = res ? res.error : null;
    // an engine failure at the end of the run is technical: the page shows its own sentence for an "Internal error"
    if (!error && endError) error = { message: 'Internal error: ' + String(endError.message || endError), line: 0, lineText: null, excerpt: null, calledFrom: [], silent: false, dialogText: null };
    return {
      ok: !!(res && res.ok) && !endError, aborted: !!(res && res.aborted) || M.ctrl.signal.aborted, exited: !!(res && res.exited),
      error, prefsWrites, changedDocs, undo: { changed: undo && Array.isArray(undo.changed) ? undo.changed : [], dropped: undo && Array.isArray(undo.dropped) ? undo.dropped : [] }
    };
  }

  // ════════════════════════════════════════════════════════════════════════════════════════════════
  //  Built-ins
  // ════════════════════════════════════════════════════════════════════════════════════════════════

  let installed = false;
  /* Filled by installBuiltins (the language's own constants). */
  let K = null, COMMA = 0, RP = 0, LP = 0, DOT = 0, WORD = 0, NUMBER = 0, Variable = null, MacroCancel = null;

  const runOf = (f) => f.interp.ctx.host.M;

  /* ---- argument readers (Functions.getFirstArg / getNextArg / getLastArg, run by a signature) ----
   * n number  s string  b boolean  v variable  V array variable (no index)  a numeric array  A Variable[] array  S string array
   * x string or number (isStringArg decides: { s } or the number)   '?' every following argument is optional (read when a comma follows) */
  function* readArgs(f, sig) {
    const it = f.interp;
    if (sig === null) return [];
    if (!sig) { it.getParens(); return []; }
    it.getLeftParen();
    const out = [];
    let optional = false, first = true;
    for (let i = 0; i < sig.length; i++) {
      const ch = sig[i];
      if (ch === '?') { optional = true; continue; }
      if (!first) {
        if (optional && it.nextToken() !== COMMA) break;
        it.getComma();
      }
      first = false;
      switch (ch) {
        case 'n': out.push(yield* it.getExpression()); break;
        case 's': out.push(yield* f.getString()); break;
        case 'b': { const v = yield* it.getBooleanExpression(); it.checkBoolean(v); out.push(v !== 0); break; }
        case 'v': out.push(yield* f.getVariable()); break;
        case 'V': out.push(arrayVariable(it)); break;
        case 'a': out.push(yield* f.getNumericArray()); break;
        case 'A': out.push(yield* f.getArray()); break;
        case 'S': out.push(yield* f.getStringArray()); break;
        case 'x': out.push(f.isStringArg() ? { s: yield* f.getString() } : yield* it.getExpression()); break;
        default: throw ijError('IJ_INTERNAL', 'signature ' + sig);
      }
    }
    it.getRightParen();
    return out;
  }
  function readArgs$s(f, sig) {
    const it = f.interp;
    if (sig === null) return [];
    if (!sig) { it.getParens(); return []; }
    it.getLeftParen();
    const out = [];
    let optional = false, first = true;
    for (let i = 0; i < sig.length; i++) {
      const ch = sig[i];
      if (ch === '?') { optional = true; continue; }
      if (!first) {
        if (optional && it.nextToken() !== COMMA) break;
        it.getComma();
      }
      first = false;
      switch (ch) {
        case 'n': out.push(it.getExpression$s()); break;
        case 's': out.push(f.getString$s()); break;
        case 'b': { const v = it.getBooleanExpression$s(); it.checkBoolean(v); out.push(v !== 0); break; }
        case 'v': out.push(f.getVariable$s()); break;
        case 'V': out.push(arrayVariable(it)); break;
        case 'a': out.push(f.getNumericArray$s()); break;
        case 'A': out.push(f.getArray$s()); break;
        case 'S': out.push(f.getStringArray$s()); break;
        case 'x': out.push(f.isStringArg() ? { s: f.getString$s() } : it.getExpression$s()); break;
        default: throw ijError('IJ_INTERNAL', 'signature ' + sig);
      }
    }
    it.getRightParen();
    return out;
  }
  /* Functions.getArrayVariable: the variable named by the next token, created when absent (never indexed). */
  function arrayVariable(it) {
    it.getToken();
    if (it.token !== WORD) it.error('Variable expected');
    let v = it.lookupLocalVariable(it.tokenAddress);
    if (v === null) v = it.pushNew(it.tokenAddress, 0.0, null, it);
    return v;
  }
  /* The member name after "Name." (doStack / doRoi / doTable …). */
  function memberName(f) {
    const it = f.interp;
    it.getToken();
    if (it.token !== DOT) it.error("'.' expected");
    it.getToken();
    const t = it.token;
    if (!(t === WORD || t === K.PREDEFINED_FUNCTION || t === K.NUMERIC_FUNCTION || t === K.STRING_FUNCTION || t === K.ARRAY_FUNCTION || t === K.VARIABLE_FUNCTION))
      it.error('Function name expected: ');
    return it.tokenString;
  }

  /**
   * define(kind, name, sig, body, opts): a built-in that never suspends: body(f, args, M) returns its value (ignored for 'do').
   * The generator form and the fast-path twin parse the same signature; the body is shared.
   */
  function defSync(kind, name, sig, body) {
    const gen = function* (f) { const a = yield* readArgs(f, sig); return body(f, a, runOf(f)); };
    const sync = (f) => body(f, readArgs$s(f, sig), runOf(f));
    LANG().define(kind, name, gen, { suspends: false, sync });
  }
  /* A built-in that may wait (an RPC, an engine request): body returns a value or a Promise; a rejection with a text is a macro
   * error at the current line (Functions.hostHook). */
  function defAsync(kind, name, sig, body) {
    const gen = function* (f) {
      const a = yield* readArgs(f, sig);
      const M = runOf(f);
      return yield* f.hostHook(() => body(f, a, M));
    };
    LANG().define(kind, name, gen, { suspends: true });
  }
  /* A refused built-in: its arguments are parsed as ImageJ would (so a syntax error is still reported first), then the macro stops
   * with the translated reason. */
  function defRefused(kind, name, sig, textOf) {
    defSync(kind, name, sig, (f, a, M) => { f.interp.error(textOf(M, a)); return kind === 'num' ? 0 : kind === 'str' ? '' : kind === 'arr' ? [] : null; });
  }
  /**
   * A namespace (Stack.*, Roi.*, Table.* …): members = { name: { sig, sync?: (f, args, M), async?: (f, args, M), raw? } }.
   * `raw` members parse their own arguments (raw(f, M) generator / raw$s(f, M) plain). suspends = the async members.
   */
  function defNamespace(kind, name, members, unknownText, wrap) {
    const susp = {};
    for (const k of Object.keys(members)) susp[k] = !!members[k].async || !!members[k].rawAsync;
    // a numeric member with no value is NaN (doStack's setters): a numeric statement that is not NaN is printed by the interpreter
    const out = (v) => (wrap ? wrap(v) : kind === 'num' && (v === null || v === undefined) ? NaN : v);
    const gen = function* (f) {
      const M = runOf(f);
      const m = memberName(f);
      const e = Object.prototype.hasOwnProperty.call(members, m) ? members[m] : null;
      if (!e) { f.interp.error(typeof unknownText === 'function' ? unknownText(m) : unknownText); return out(null); }
      if (e.rawAsync) return out(yield* f.hostHook(() => e.rawAsync(f, M)));
      if (e.raw) return out(yield* e.raw(f, M));
      const a = yield* readArgs(f, e.sig);
      if (e.async) return out(yield* f.hostHook(() => e.async(f, a, M)));
      return out(e.sync(f, a, M));
    };
    const sync = (f) => {
      const M = runOf(f);
      const m = memberName(f);
      const e = Object.prototype.hasOwnProperty.call(members, m) ? members[m] : null;
      if (!e) { f.interp.error(typeof unknownText === 'function' ? unknownText(m) : unknownText); return out(null); }
      if (e.raw) return out(e.raw$s(f, M));
      if (e.async || e.rawAsync) throw ijError('IJ_INTERNAL', 'a waiting member ran in the fast path');
      return out(e.sync(f, readArgs$s(f, e.sig), M));
    };
    LANG().define(kind, name, gen, { suspends: susp, sync });
  }

  // ---------------------------------------------------------------- the current image
  /** ImageJ's getImage(): the macro's current image ("There are no images open" otherwise). */
  function img(f, M) {
    const im = curImage(f, M);
    // "defaultIP = null": the drawing value the processor held is computed again at the next draw
    M.fg = undefined;
    return im;
  }
  /* The current image without ImageJ's getImage() side effect (getProcessor reuses defaultIP while it exists). */
  function curImage(f, M) {
    const id = M.current;
    const im = id !== null && id !== undefined ? M.images.get(id) : null;
    if (!im) { f.interp.error('There are no images open'); return null; }
    return im;
  }
  /** The dimensions of a document as the engine holds them now (the mirror can be one RPC behind after an in-worker op). */
  function dimsOf(M, docId) { return M.E.dims(docId); }
  function stackDims(M, docId) {
    const d = dimsOf(M, docId);
    return { nC: d.rgb ? 1 : d.nC, nZ: d.nZ, nT: d.nT, rgb: d.rgb, bd: d.bitDepth, bdIJ: d.bitDepthIJ, W: d.width, H: d.height, hyperstack: d.hyperstack };
  }
  function stackSize(sd) { return sd.nC * sd.nZ * sd.nT; }
  /** ImagePlus.isHyperStack in a macro (no window): openAsHyperStack && getNDimensions() > 3. */
  function isHyper(sd) { return !!sd.hyperstack && ((sd.nC > 1 ? 1 : 0) + (sd.nZ > 1 ? 1 : 0) + (sd.nT > 1 ? 1 : 0)) >= 2; }

  /**
   * The processor of the current image (ImageJ's defaultIP): the plane at the image's position, read through the working copy when
   * one exists. { docId, W, H, bd, rgb, c, z, t, nZ, data | r g b }. Cached until resetImage() (M.P = null).
   */
  function proc(f, M) {
    let P = M.P;
    if (P && P.docId === M.current) return P;
    const im = curImage(f, M);
    const sd = stackDims(M, im.docId);
    const pos = M.E.getPosition(im.docId);
    P = { docId: im.docId, W: sd.W, H: sd.H, bd: sd.bd, rgb: sd.rgb, c: sd.rgb ? 0 : pos.c, z: pos.z, t: pos.t, nZ: sd.nZ, nT: sd.nT, nC: sd.nC, im, writable: false };
    if (P.rgb) {
      P.r = M.plane(P.docId, 0, P.z, P.t); P.g = M.plane(P.docId, 1, P.z, P.t); P.b = M.plane(P.docId, 2, P.z, P.t);
      const w = M.work.get(P.docId + ':0:' + (P.t * P.nZ + P.z));
      P.alpha = w ? w.alpha : null;
    } else P.data = M.plane(P.docId, P.c, P.z, P.t);
    M.P = P;
    return P;
  }
  /** The same processor with writable working copies (created at the first write). */
  function wproc(f, M) {
    const P = proc(f, M);
    if (P.writable) return P;
    if (P.rgb) {
      const w0 = M.writable(P.docId, 0, P.z, P.t, P.nZ);
      P.r = w0.data; P.g = M.writable(P.docId, 1, P.z, P.t, P.nZ).data; P.b = M.writable(P.docId, 2, P.z, P.t, P.nZ).data;
      P.w0 = w0; P.alpha = w0.alpha;
    } else P.data = M.writable(P.docId, P.c, P.z, P.t, P.nZ).data;
    P.writable = true;
    return P;
  }
  /* RGB of one pixel as ColorProcessor stores it: alpha 0xff unless a raw putPixel left another one (kept for the run). */
  function rgbGet(P, i) {
    const a = P.alpha ? P.alpha[i] : 255;
    return ((a << 24) | (P.r[i] << 16) | (P.g[i] << 8) | P.b[i]) | 0;
  }
  function rgbSet(P, i, v) {
    P.r[i] = (v >> 16) & 0xff; P.g[i] = (v >> 8) & 0xff; P.b[i] = v & 0xff;
    const a = (v >>> 24) & 0xff;
    if (a !== 255 || P.alpha) {
      if (!P.alpha) { P.alpha = new Uint8Array(P.W * P.H).fill(255); P.w0.alpha = P.alpha; }
      P.alpha[i] = a;
    }
  }
  /* ColorProcessor.getPixelValue: the unweighted (or setRGBWeights) mean of r, g, b. */
  function rgbValue(M, P, i) {
    const w = M.rgbWeights;
    const r = P.r[i], g = P.g[i], b = P.b[i];
    return w ? Math.fround(r * w[0] + g * w[1] + b * w[2]) : Math.fround(r * (1 / 3) + g * (1 / 3) + b * (1 / 3));
  }
  /* ImageProcessor.getPixelValue (calibration tables are not modelled: none exists in the Studio). */
  function pixelValue(M, P, x, y) {
    if (x < 0 || x >= P.W || y < 0 || y >= P.H) return NaN;
    const i = y * P.W + x;
    return P.rgb ? rgbValue(M, P, i) : P.data[i];
  }
  /* ImageProcessor.getInterpolatedValue (bilinear, useBicubic off) */
  function interpolatedValue(M, P, x, y) {
    const W = P.W, H = P.H;
    const edge = (xx, yy) => { if (xx <= 0) xx = 0; if (xx >= W) xx = W - 1; if (yy <= 0) yy = 0; if (yy >= H) yy = H - 1; return pixelValue(M, P, xx, yy); };
    const get = (x < 0.0 || x >= W - 1.0 || y < 0.0 || y >= H - 1.0) ? (x < -1.0 || x >= W || y < -1.0 || y >= H ? null : edge) : (xx, yy) => pixelValue(M, P, xx, yy);
    if (get === null) return 0.0;
    const xbase = d2i(x), ybase = d2i(y);
    let xf = x - xbase, yf = y - ybase;
    if (xf < 0.0) xf = 0.0;
    if (yf < 0.0) yf = 0.0;
    const ll = get(xbase, ybase), lr = get(xbase + 1, ybase), ur = get(xbase + 1, ybase + 1), ul = get(xbase, ybase + 1);
    const upper = ul + xf * (ur - ul), lower = ll + xf * (lr - ll);
    return lower + yf * (upper - lower);
  }
  /* ColorProcessor.getPixelInterpolated (bilinear): 0 outside [0, w-1) × [0, h-1), else the rounded mean per channel with alpha 0xff. */
  function rgbInterpolated(P, x, y) {
    if (x < 0.0 || y < 0.0 || x >= P.W - 1 || y >= P.H - 1) return 0;
    const xbase = d2i(x), ybase = d2i(y), xf = x - xbase, yf = y - ybase, o = ybase * P.W + xbase;
    const ch = (A) => {
      const ll = A[o], lr = A[o + 1], ur = A[o + P.W + 1], ul = A[o + P.W];
      const upper = ul + xf * (ur - ul), lower = ll + xf * (lr - ll);
      return d2i(lower + yf * (upper - lower) + 0.5) & 0xff;
    };
    return (0xff000000 | (ch(P.r) << 16) | (ch(P.g) << 8) | ch(P.b)) | 0;
  }

  // ---------------------------------------------------------------- the drawing value (Functions.getProcessor colour rules)
  /** The displayed 256-entry table of a channel: its LUT (IJLuts, inverted when the display says so); for 8-bit, as
   *  ByteProcessor.setMinAndMax remaps it ("index = i-this.min; index = (int)(256.0*index/(max-min))"). */
  function displayTable(M, P) {
    const IJLuts = root.IJLuts;
    const disp = (P.im.display && P.im.display[P.c]) || {};
    let t = null;
    try { t = IJLuts ? IJLuts.get(disp.lut === undefined || disp.lut === null ? 'Grays' : disp.lut) : null; } catch (_) { t = null; }
    if (!t || t.length < 768) { t = new Uint8Array(768); for (let i = 0; i < 256; i++) t[i * 3] = t[i * 3 + 1] = t[i * 3 + 2] = i; }
    if (disp.invert) {
      const r = new Uint8Array(768);
      for (let i = 0; i < 256; i++) { const j = 255 - i; r[i * 3] = t[j * 3]; r[i * 3 + 1] = t[j * 3 + 1]; r[i * 3 + 2] = t[j * 3 + 2]; }
      t = r;
    }
    if (P.bd === 8 && disp.min !== undefined && disp.max !== undefined && !(disp.min === 0 && disp.max === 255)) {
      const min = jround(disp.min), max = jround(disp.max), out = new Uint8Array(768);
      for (let i = 0; i < 256; i++) {
        let index;
        if (i < min) index = 0; else if (i > max) index = 255;
        else { index = d2i(256.0 * (i - min) / (disp.max - disp.min)); if (index < 0) index = 0; if (index > 255) index = 255; }
        out[i * 3] = t[index * 3]; out[i * 3 + 1] = t[index * 3 + 1]; out[i * 3 + 2] = t[index * 3 + 2];
      }
      t = out;
    }
    return t;
  }
  /* ImageProcessor.getBestIndex */
  function bestIndex(table, rgb) {
    let minD = Infinity, idx = 0;
    for (let i = 0; i < 256; i++) {
      const dr = table[i * 3] - rgb[0], dg = table[i * 3 + 1] - rgb[1], db = table[i * 3 + 2] - rgb[2];
      const d = dr * dr + dg * dg + db * db;
      if (d < minD) { minD = d; idx = i; }
      if (minD === 0) break;
    }
    return idx;
  }
  /**
   * What the processor stores when it draws: setColor(value) (globalValue), setColor(r, g, b)/setColor("name") (globalColor), else
   * the Toolbar foreground colour. Byte: the best LUT index; Short / Float: "min + (max-min)*(bestIndex/255.0)" over the display
   * range (with the "black on a range starting above 0" and "unset range" special cases); RGB: the colour itself.
   */
  function fgValue(M, P) {
    if (M.fg !== undefined && M.fg.docId === P.docId) return M.fg.v;
    const v = fgFromGlobals(M, P);
    M.fg = { docId: P.docId, v };
    return v;
  }
  function fgFromGlobals(M, P) {
    const D = M.draw;
    if (P.rgb && D.value === D.value && D.color === null) return d2i(D.value);
    if (!P.rgb && D.value === D.value && D.color === null) {
      if (P.bd === 8) { let v = d2i(D.value); if (v < 0) v = 0; if (v > 255) v = 255; return v; }
      if (P.bd === 16) { let v = d2i(D.value); if (v < 0) v = 0; if (v > 65535) v = 65535; return v; }
      return Math.fround(D.value);
    }
    let rgb = D.color;
    if (rgb === null) rgb = (M.colors && M.colors.foreground) || [255, 255, 255];
    if (P.rgb) return ((0xff << 24) | (rgb[0] << 16) | (rgb[1] << 8) | rgb[2]) | 0;
    const bi = bestIndex(displayTable(M, P), rgb);
    if (P.bd === 8) return bi;
    const disp = (P.im.display && P.im.display[P.c]) || { min: 0, max: P.bd === 16 ? 65535 : 1 };
    const min = disp.min, max = disp.max;
    if (P.bd === 16) {
      if (bi > 0 && min === 0 && max === 0) return bi;
      if (bi === 0 && min > 0 && (rgb[0] | rgb[1] | rgb[2]) === 0) return 0;
      let v = d2i(min + (max - min) * (bi / 255.0));
      if (v < 0) v = 0; if (v > 65535) v = 65535;
      return v;
    }
    if (bi > 0 && min === 0 && max === 0) return bi;
    if (bi === 0 && min > 0 && (rgb[0] | rgb[1] | rgb[2]) === 0) return 0;
    return Math.fround(min + (max - min) * (bi / 255.0));
  }
  /** A drawing raster over the current writable plane: drawPixel / lineTo / drawRect / fill rectangle / fill mask, ImageProcessor's rules. */
  function raster(f, M) {
    const P = wproc(f, M);
    const W = P.W, H = P.H, fg = fgValue(M, P);
    const set = P.rgb ? (i) => rgbSet(P, i, fg) : (i) => { P.data[i] = fg; };
    let lw = M.draw.lineWidth > 0 ? M.draw.lineWidth : (M.lineWidth > 0 ? M.lineWidth : 1);
    if (lw < 1) lw = 1;
    const drawPixel = (x, y) => { if (x >= 0 && x <= W - 1 && y >= 0 && y <= H - 1) set(y * W + x); };
    const dot2 = (x, y) => { drawPixel(x, y); drawPixel(x - 1, y); drawPixel(x, y - 1); drawPixel(x - 1, y - 1); };
    const masks = new Map();
    function dot(xc, yc) {
      let r = lw / 2.0;
      const xmin = d2i(xc - r + 0.5), ymin = d2i(yc - r + 0.5), xmax = xmin + lw, ymax = ymin + lw;
      if (xmin < 0 || ymin < 0 || xmax > W - 1 || ymax > H - 1) {
        const r2 = r * r;
        r -= 0.5;
        const xo = xmin + r, yo = ymin + r;
        for (let y = ymin; y < ymax; y++) for (let x = xmin; x < xmax; x++) { const xx = x - xo, yy = y - yo; if (xx * xx + yy * yy <= r2) drawPixel(x, y); }
      } else {
        let m = masks.get(lw);
        if (!m) { m = ovalMask(lw, lw); masks.set(lw, m); }
        for (let y = 0; y < lw; y++) for (let x = 0; x < lw; x++) if (m[y * lw + x]) set((ymin + y) * W + xmin + x);
      }
    }
    const R2 = {
      P, fg, lw,
      moveTo(x, y) { M.draw.x = x; M.draw.y = y; },
      // ImageProcessor.lineTo
      lineTo(x2, y2) {
        const lw2 = d2i(lw / 2);
        const xMin = -lw2 - 1, xMax = W - 1 + lw2 + 1, yMin = -lw2 - 1, yMax = H - 1 + lw2 + 1;
        const cx = M.draw.x, cy = M.draw.y;
        const dx = x2 - cx, dy = y2 - cy;
        const absdx = dx >= 0 ? dx : -dx, absdy = dy >= 0 ? dy : -dy;
        const n = absdy > absdx ? absdy : absdx;
        const xinc = dx !== 0 ? dx / n : 0, yinc = dy !== 0 ? dy / n : 0;
        let x = cx, y = cy;
        M.draw.x = x2; M.draw.y = y2;
        let i1 = 0;
        if (dx > 0) i1 = Math.max(i1, d2i((xMin - x) / xinc));
        else if (dx < 0) i1 = Math.max(i1, d2i((xMax - x) / xinc));
        else if (x < xMin || x > xMax) return;
        if (dy > 0) i1 = Math.max(i1, d2i((yMin - y) / yinc));
        else if (dy < 0) i1 = Math.max(i1, d2i((yMax - y) / yinc));
        else if (y < yMin || y > yMax) return;
        let i2 = n;
        if (dx > 0) i2 = Math.min(i2, d2i((xMax - x) / xinc));
        else if (dx < 0) i2 = Math.min(i2, d2i((xMin - x) / xinc));
        if (dy > 0) i2 = Math.min(i2, d2i((yMax - y) / yinc));
        else if (dy < 0) i2 = Math.min(i2, d2i((yMin - y) / yinc));
        x += i1 * xinc; y += i1 * yinc;
        for (let i = i1; i <= i2; i++) {
          if (lw === 1) drawPixel(jround(x), jround(y));
          else if (lw === 2) dot2(jround(x), jround(y));
          else dot(jround(x), jround(y));
          x += xinc; y += yinc;
        }
      },
      // ImageProcessor.drawRect
      drawRect(x, y, w, h) {
        if (w < 1 || h < 1) return;
        const a = lw === 1 ? 1 : 0;
        R2.moveTo(x, y); R2.lineTo(x + w - a, y); R2.lineTo(x + w - a, y + h - a); R2.lineTo(x, y + h - a); R2.lineTo(x, y);
      },
      drawPolygon(xs, ys) {
        R2.moveTo(xs[0], ys[0]);
        for (let i = 0; i < xs.length; i++) R2.lineTo(xs[i], ys[i]);
        R2.lineTo(xs[0], ys[0]);
      },
      // ImageProcessor.setRoi(x, y, w, h) + fill(): the rectangle clipped to the image
      fillRect(x, y, w, h) {
        const x0 = Math.max(0, x), y0 = Math.max(0, y), x1 = Math.min(W, x + w), y1 = Math.min(H, y + h);
        if (!(x1 > x0 && y1 > y0)) return;
        for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) set(yy * W + xx);
      },
      fillMask(m) {
        for (let yy = 0; yy < m.h; yy++) {
          const gy = m.y + yy;
          if (gy < 0 || gy >= H) continue;
          for (let xx = 0; xx < m.w; xx++) {
            const gx = m.x + xx;
            if (gx >= 0 && gx < W && m.data[yy * m.w + xx]) set(gy * W + gx);
          }
        }
      },
      set
    };
    return R2;
  }
  /* OvalRoi.getMask: "double a=width/2.0, b=height/2.0; a2=a*a, b2=b*b; a -= 0.5; b -= 0.5; … if ((xx*xx/a2+yy*yy/b2)<=1.0)" */
  function ovalMask(width, height) {
    const m = new Uint8Array(Math.max(0, width * height));
    let a = width / 2.0, b = height / 2.0;
    const a2 = a * a, b2 = b * b;
    a -= 0.5; b -= 0.5;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) { const xx = x - a, yy = y - b; if ((xx * xx / a2 + yy * yy / b2) <= 1.0) m[y * width + x] = 1; }
    return m;
  }
  /* OvalRoi.getPolygon: the traced outline of its mask (corner coordinates), as the Wand returns it. */
  function ovalOutline(x, y, w, h) {
    const IJRoi = root.IJRoi;
    const m = ovalMask(w, h);
    const r = IJRoi.fromMask(m, w, h);
    if (!r.w) return [];
    const loops = IJRoi.outlines(r);
    return loops.length ? loops[0].map((p) => [p[0] + x, p[1] + y]) : [];
  }

  // ---------------------------------------------------------------- ROIs
  /** ImageJ selection type of a Studio roi (Roi.getType). */
  function roiType(roi) {
    if (!roi) return -1;
    if (roi.ijType !== undefined) return roi.ijType;
    switch (roi.type) {
      case 'rect': return 0; case 'oval': return 1; case 'polygon': return 2; case 'freehand': return 3;
      case 'line': return 5; case 'polyline': return 6; case 'angle': return 8; case 'mask': return 9; case 'point': return 10;
      default: return -1;
    }
  }
  const isAreaRoi = (roi) => !!roi && (roi.type === 'rect' || roi.type === 'oval' || roi.type === 'polygon' || roi.type === 'freehand' || roi.type === 'mask');
  const isLineRoi = (roi) => !!roi && (roi.type === 'line' || roi.type === 'polyline');
  function selectionOf(M, docId) { const r = M.selections[docId]; return r === undefined ? null : r; }
  function setSelection(M, docId, roi) {
    M.selections[docId] = roi;
    M.write('roi.set', { docId, roi });
  }
  /** Roi.getBounds() (integer box). */
  function roiBounds(roi) {
    const IJRoi = root.IJRoi;
    return IJRoi.bounds(roi);
  }

  // ---------------------------------------------------------------- statistics (ImageStatistics of one processor)
  /**
   * ImageStatistics.getStatistics(ip, AREA+MEAN+MIN_MAX(+STD_DEV), cal) for the pixels of `mask` (null = the rectangle `rect`):
   * ByteStatistics (256 bins), ShortStatistics (histogram16 + 256 bins over min..max), FloatStatistics (256 bins over min..max of
   * the finite values), ColorStatistics (the luminance). Quoted rules: see histogramStats in ij-proc-ana.js and the 1.54p sources:
   * the 16-bit range is the first / last non-empty bin of the full histogram, a float pixel counts when -Float.MAX..Float.MAX.
   */
  function planeStats(M, P, rect, mask, nBins, histMin, histMax) {
    nBins = nBins || 256;
    const W = P.W;
    const x0 = rect.x, y0 = rect.y, w = rect.w, h = rect.h;
    const each = (fn) => {
      for (let y = 0; y < h; y++) {
        const row = (y0 + y) * W + x0, mrow = y * w;
        for (let x = 0; x < w; x++) if (!mask || mask[mrow + x]) fn(row + x);
      }
    };
    let n = 0, sum = 0, sum2 = 0, min, max, histogram, histogram16 = null, binSize;
    if (P.rgb || P.bd === 8) {
      const hist = new Float64Array(256);
      if (P.rgb) each((i) => { hist[d2i(rgbValue(M, P, i) + 0.5) & 0xff]++; });
      else each((i) => { hist[P.data[i]]++; });
      let lo = 0; while (lo < 255 && hist[lo] === 0) lo++;
      let hi = 255; while (hi > 0 && hist[hi] === 0) hi--;
      min = lo; max = hi;
      for (let i = 0; i < 256; i++) { const c = hist[i]; n += c; sum += i * c; sum2 += i * i * c; }
      if (nBins === 256) histogram = Array.from(hist);
      else {
        histogram = new Array(nBins).fill(0);
        const scale = nBins / 256;
        for (let i = 0; i < 256; i++) { let idx = d2i(scale * i); if (idx >= nBins) idx = nBins - 1; histogram[idx] += hist[i]; }
      }
      binSize = 256 / nBins;
      histMin = 0; histMax = 256;
    } else if (P.bd === 16) {
      const hist = new Float64Array(65536);
      each((i) => { hist[P.data[i]]++; });
      let lo = 0; while (lo < 65535 && hist[lo] === 0) lo++;
      let hi = 65535; while (hi > 0 && hist[hi] === 0) hi--;
      min = lo; max = hi;
      histogram16 = hist;
      if (!(histMin || histMax)) { histMin = min; histMax = max; }
      else { if (min < histMin) min = d2i(histMin); if (max > histMax) max = d2i(histMax); }
      binSize = (histMax - histMin + 1) / nBins;
      const scale = 1.0 / binSize, hMin = d2i(histMin);
      histogram = new Array(nBins).fill(0);
      for (let i = min; i <= max; i++) {
        const c = hist[i];
        n += c; sum += i * c; sum2 += i * i * c;
        let idx = d2i(scale * (i - hMin));
        if (idx >= nBins) idx = nBins - 1;
        histogram[idx] += c;
      }
    } else {
      let roiMin = Number.MAX_VALUE, roiMax = -Number.MAX_VALUE;
      const FMAX = 3.4028234663852886e38;
      each((i) => { const v = P.data[i]; if (v >= -FMAX && v <= FMAX) { if (v < roiMin) roiMin = v; if (v > roiMax) roiMax = v; } });
      min = roiMin; max = roiMax;
      if (!(histMin || histMax)) { histMin = min; histMax = max; }
      else { if (min < histMin) min = histMin; if (max > histMax) max = histMax; }
      binSize = (histMax - histMin) / nBins;
      const scale = nBins / (histMax - histMin);
      histogram = new Array(nBins).fill(0);
      each((i) => {
        const v = P.data[i];
        if (v >= -FMAX && v <= FMAX && v >= histMin && v <= histMax) {
          n++; sum += v; sum2 += v * v;
          let idx = d2i(scale * (v - histMin));
          if (idx >= nBins) idx = nBins - 1;
          histogram[idx]++;
        }
      });
    }
    const mean = sum / n;
    let stdDev = 0;
    if (n > 0) { const v = (n * sum2 - sum * sum) / n; stdDev = v > 0.0 ? Math.sqrt(v / (n - 1.0)) : 0.0; }
    return { n, mean, stdDev, min, max, histogram, histogram16, histMin, histMax, binSize, nBins };
  }
  /** The rectangle and mask of the current selection over the processor (ImageProcessor.setRoi(roi)). */
  function roiRegion(P, roi) {
    if (isAreaRoi(roi)) {
      const m = root.IJRoi.mask(roi, P.W, P.H);
      const x0 = Math.max(0, m.x), y0 = Math.max(0, m.y), x1 = Math.min(P.W, m.x + m.w), y1 = Math.min(P.H, m.y + m.h);
      if (!(x1 > x0 && y1 > y0)) return { rect: { x: 0, y: 0, w: 0, h: 0 }, mask: null };
      const w = x1 - x0, h = y1 - y0;
      if (roi.type === 'rect') return { rect: { x: x0, y: y0, w, h }, mask: null };
      const data = new Uint8Array(w * h);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data[y * w + x] = m.data[(y0 + y - m.y) * m.w + (x0 + x - m.x)];
      return { rect: { x: x0, y: y0, w, h }, mask: data };
    }
    return { rect: { x: 0, y: 0, w: P.W, h: P.H }, mask: null };
  }
  function calOf(im) {
    const c = (im && im.calibration) || {};
    return { pw: c.pixelWidth > 0 ? c.pixelWidth : 1, ph: c.pixelHeight > 0 ? c.pixelHeight : 1, pd: c.pixelDepth > 0 ? c.pixelDepth : 1, unit: c.unit || 'pixel' };
  }
  /* Calibration.getUnits: "pixels" for an uncalibrated image, the unit (plural "pixels" for "pixel") otherwise. */
  function unitsOf(im) {
    const u = calOf(im).unit;
    return u === 'pixel' || u === 'pixels' || u === '' ? 'pixels' : u === 'micron' ? 'microns' : u === 'inch' ? 'inches' : u;
  }

  // ---------------------------------------------------------------- Tables (ResultsTable semantics on the mirror)
  function tableFor(f, M, title) {
    const name = title === null || title === undefined ? (M.currentTable && M.tables.has(M.currentTable) ? M.currentTable : 'Results') : title;
    let t = M.tables.get(name);
    if (!t && name === 'Results') { t = emptyTable('Results'); M.tables.set('Results', t); }
    if (!t) f.interp.error('"' + name + '" table not found');
    return t;
  }
  function touchTable(M, t) { M.write('table.replace', { name: t.name, table: t }); }
  function addColumn(t, h) {
    if (t.headings.indexOf(h) < 0) { t.headings.push(h); t.columns[h] = new Array(t.size).fill(0); }
    return t.columns[h];
  }
  function incrementCounter(t) {
    t.size++;
    for (const h of t.headings) t.columns[h].push(0);
    if (t.labels) t.labels.push(null);
  }
  /* ResultsTable.n / d2s of a numeric cell: a whole number without decimals, else `precision` decimals (AUTO_FORMAT). */
  function cellString(M, v) {
    if (typeof v === 'string') return v;
    if (v === null || v === undefined) v = 0;
    const IJAna = root.IJAna;
    const prec = M.measurements && Number.isInteger(M.measurements.decimals) ? M.measurements.decimals : 3;
    if (IJAna && typeof IJAna.cellString === 'function') return IJAna.cellString(v, prec);
    if (d2i(v) === v) return LANG().d2s(v, 0);
    return LANG().d2s(v, prec);
  }
  function cellNumber(v) {
    if (typeof v === 'number') return v;
    if (v === null || v === undefined) return 0;
    if (v === 'NaN') return NaN;
    return toolsParseDouble(v, NaN);
  }

  // ---------------------------------------------------------------- page methods called by built-ins
  async function selectImageDoc(M, docId) {
    const r = await M.rpc('image.select', { docId });
    M.current = r && r.current !== undefined ? r.current : docId;
    M.P = null;
  }
  async function adopt(M, info) {
    const r = await M.rpc('image.adopt', { docId: info.docId });
    if (!M.images.has(info.docId)) {
      M.images.set(info.docId, imageEntry(info, r && typeof r.id === 'number' ? r.id : 0));
      M.order.push(info.docId);
    }
    M.current = info.docId;
    M.P = null;
    return r;
  }
  /* A mirror image entry for a document the worker created (replaced by the page's own at the next reply). */
  function imageEntry(info, id) {
    const nC = info.rgb ? 1 : (info.nC || (info.channels ? info.channels.length : 1));
    return {
      docId: info.docId, id, title: info.name, width: info.width, height: info.height, bitDepth: info.rgb ? 24 : info.bitDepth,
      nC, nZ: info.nZ || 1, nT: info.nT || 1, hyperstack: !!info.hyperstack, rgb: !!info.rgb, hidden: !!info.hidden, ephemeral: !!info.ephemeral,
      changes: false, mode: info.mode || 'composite', active: 0, pos: { c: 0, z: 0, t: 0 }, visible: (info.channels || []).map(() => true),
      calibration: Object.assign({ pixelWidth: 1, pixelHeight: 1, pixelDepth: 1, unit: 'pixel' }, info.calibration || {}),
      display: (info.channels || []).map((c) => Object.assign({ min: 0, max: 255, lut: 'Grays', invert: false }, c.display || {}))
    };
  }
  /** The variables a run() options string names (`&name`, or a bare `key=name` value that is a variable): { name: { n?, s? } }. */
  function optionVars(it, options) {
    const out = {};
    if (typeof options !== 'string' || !options) return out;
    const names = new Set();
    const rx = /&([A-Za-z_][A-Za-z0-9_]*)/g;
    let m;
    while ((m = rx.exec(options)) !== null) names.add(m[1]);
    const rx2 = /=([A-Za-z_][A-Za-z0-9_]*)(?=\s|$)/g;
    while ((m = rx2.exec(options)) !== null) names.add(m[1]);
    for (const name of names) {
      const v = findVariable(it, name);
      if (!v || v.getArray() !== null) continue;
      const s = v.getString();
      out[name] = s !== null ? { s } : { n: v.getValue(), s: LANG().numToString(v.getValue()) };
    }
    return out;
  }
  /* Interpreter.getVariable2: the innermost variable of that name on the stack. */
  function findVariable(it, name) {
    const stack = it.stack;
    if (!stack) return null;
    for (let i = it.topOfStack; i >= 0; i--) {
      const v = stack[i];
      if (v && it.pgm.table[v.symTabIndex] && it.pgm.table[v.symTabIndex].str === name) return v;
    }
    return null;
  }
  /** run(name, options) through the page lane (§2.4): a status other than ok stops the macro with its text. */
  async function runCommand(f, M, name, options) {
    const it = f.interp;
    const r = await M.rpc('run', { name, options, vars: optionVars(it, options), current: M.current, alt: !!M.keys.alt, shift: !!M.keys.shift,
      rgbWeights: M.rgbWeights ? M.rgbWeights.slice() : null });
    M.keys.alt = false; M.keys.shift = false;
    M.P = null;
    if (r && r.current !== undefined) M.current = r.current;
    const status = r && r.status;
    if (status === 'ok') {
      const ip = r.inPlace;
      if (ip && typeof ip === 'object' && M.images.has(ip.docId) && M.images.has(ip.resultId)) {
        await calcInPlace(M, ip.docId, ip.resultId, { all: ip.all !== false, channel1: ip.channel1 | 0, slices: ip.slices === 'all' ? 'all' : undefined });
      }
      return;
    }
    if (status === 'cancelled') throw new MacroCancel('abort');
    throw macroError(r && typeof r.text === 'string' && r.text ? r.text : 'Unrecognized command: "' + name + '"');
  }

  // ---------------------------------------------------------------- core host calls (ij-macro-lang.js f.hostCall)
  function hostCall(M, name, args) {
    switch (name) {
      case 'setOption': return setOptionHost(M, String(args[0]), !!args[1]);
      case 'List.setMeasurements': return listMeasurements(M, args.length ? String(args[0]) : '');
      case 'List.setCommands': return M.rpc('command.list', {}).then((r) => {
        const o = {};
        for (const row of (r && r.commands) || []) if (Array.isArray(row) && row.length >= 2) o[String(row[0])] = String(row[1]);
        return o;
      });
      case 'String.copy': return M.rpc('clipboard.copy', { text: String(args[0]) }).then((r) => { if (!r || !r.ok) throw macroError(M.tr('err.macClipboard')); return null; });
      case 'String.paste': throw macroError(M.tr('err.macClipboard'));
      case 'String.show': return M.rpc('window.print', { title: 'Untitled', text: String(args[0]) }).then(() => null);
      case 'String.copyResults': return M.rpc('clipboard.copy', { text: resultsText(M) }).then((r) => { if (!r || !r.ok) throw macroError(M.tr('err.macClipboard')); return null; });
      case 'String.getResultsHeadings': {
        const t = M.tables.get('Results');
        return t ? t.headings.join('\t') : '';
      }
      case 'String.setFontSize': return null;
      case 'IJ.deleteRows': {
        const t = M.tables.get('Results') || emptyTable('Results');
        deleteRows(t, args[0] | 0, args[1] | 0);
        M.tables.set('Results', t);
        touchTable(M, t);
        return null;
      }
      case 'IJ.freeMemory': return freeMemoryText(pixelBytes(M), maxMemory(M));
      case 'IJ.currentMemory': return String(pixelBytes(M));
      case 'IJ.maxMemory': return String(maxMemory(M));
      case 'IJ.getToolName': return M.tool || '';
      case 'IJ.renameResults': return renameResults(M, args);
      case 'IJ.checksum': throw macroError(M.tr('err.macFileLater', { name: 'IJ.checksum("file")' }));
      case 'Array.show': {
        const [title, names, cols] = args;
        const t = emptyTable(String(title));
        const rows = cols.reduce((n, c) => Math.max(n, c.length), 0);
        t.size = rows;
        names.forEach((h, k) => { t.headings.push(String(h)); t.columns[String(h)] = Array.from({ length: rows }, (_, i) => (i < cols[k].length ? cols[k][i] : 0)); });
        M.tables.set(t.name, t);
        M.currentTable = t.name;
        touchTable(M, t);
        M.write('table.show', { name: t.name });
        return null;
      }
      default: throw macroError(M.tr('err.macNotInBrowser', { name }));
    }
  }
  function resultsText(M) {
    const t = M.tables.get('Results');
    if (!t) return '';
    let s = '';
    for (let i = 0; i < t.size; i++) s += (i + 1) + '\t' + t.headings.map((h) => cellString(M, t.columns[h][i])).join('\t') + '\n';
    return s;
  }
  function deleteRows(t, first, last) {
    if (first < 0) first = 0;
    if (last >= t.size) last = t.size - 1;
    if (last < first) return;
    const n = last - first + 1;
    for (const h of t.headings) t.columns[h].splice(first, n);
    if (t.labels) t.labels.splice(first, n);
    t.size -= n;
  }
  /* IJ.renameResults(name) / (oldName, newName) */
  function renameResults(M, args) {
    const from = args.length > 1 ? String(args[0]) : 'Results';
    const to = args.length > 1 ? String(args[1]) : String(args[0]);
    const t = M.tables.get(from);
    if (!t) return null;
    M.tables.delete(from);
    t.name = to;
    M.tables.set(to, t);
    if (from === 'Results') M.tables.set('Results', emptyTable('Results'));
    M.write('table.rename', { from, to });
    return null;
  }
  function pixelBytes(M) {
    if (typeof M.E.pixelBytes === 'function') return M.E.pixelBytes();
    let n = 0;
    for (const docId of M.images.keys()) {
      try { const d = M.E.dims(docId); const per = d.width * d.height * (d.bitDepth === 8 ? 1 : d.bitDepth === 16 ? 2 : 4); n += per * (d.rgb ? 3 : d.nC) * d.nZ * d.nT; } catch (_) { /* closed */ }
    }
    return n;
  }
  /* The pixel cap of the engine, said as a whole power of two GiB (no finer than navigator.deviceMemory). */
  function maxMemory(M) {
    const GiB = 1073741824;
    const b = Number(M.E.budgetBytes) > 0 ? Number(M.E.budgetBytes) : GiB;
    return Math.pow(2, Math.max(0, Math.round(Math.log2(Math.max(b, GiB) / GiB)))) * GiB;
  }
  function setOptionHost(M, name, state) {
    const lc = name.toLowerCase();
    const o = optionFor(lc);
    if (!o) throw macroError('Invalid option');
    if (o.setting) { M.settings[o.setting] = state; M.write('setting.set', { key: o.setting, value: state }); }
    else if (o.measurement) {
      const g = new Set(M.measurements.groups || []);
      if (state) g.add(o.measurement); else g.delete(o.measurement);
      M.measurements.groups = Array.from(g);
      M.write('measurements.set', { groups: M.measurements.groups });
    } else if (o.rmShow) { M.rm.showAll = state; M.write('rm.show', { showAll: state, labels: M.rm.labels }); }
    else if (o.changes) { const im = M.images.get(M.current); if (im) im.changes = state; else throw macroError('There are no images open'); }
    return null;
  }
  /* List.setMeasurements: every measurement of the current image and selection, as Measure would compute it (Analyzer.measure with
   * every key), keyed by the ImageJ column headings. */
  async function listMeasurements(M, arg) {
    const im = M.images.get(M.current);
    if (!im) throw macroError('There are no images open');
    if (typeof M.E.request !== 'function') throw macroError(M.tr('err.macNotInBrowser', { name: 'List.setMeasurements' }));
    await M.commitAll();
    const pos = M.E.getPosition(im.docId);
    const roi = selectionOf(M, im.docId);
    const keys = ALL_MEASURE_KEYS.slice();
    if (isLineRoi(roi)) keys.push('length');
    const thr = arg.indexOf('limit') >= 0 ? thresholdOf(M, im.docId, pos.c) : null;
    const r = await M.E.request('doc.stats', { docId: im.docId, channel: im.rgb ? 0 : pos.c, roi, measurements: keys, pos: { z: pos.z, t: pos.t },
      threshold: thr, limit: !!thr });
    const row = (r && r.row) || {};
    const out = {};
    for (const [k, h] of MEASURE_COLUMNS) if (row[k] !== undefined && row[k] !== null) out[h] = typeof row[k] === 'number' ? numberText(row[k]) : String(row[k]);
    return out;
  }
  /* List values: ImageJ stores ""+value (Double.toString), not the macro's 4-decimal text. */
  function numberText(v) {
    const IJMacro = LANG();
    if (typeof IJMacro.javaDouble === 'function') return IJMacro.javaDouble(v);
    return String(v);
  }
  function thresholdOf(M, docId, c) {
    const t = M.thresholds && M.thresholds[docId];
    const e = t ? t[c] : null;
    return e && isFinite(e.lower) && isFinite(e.upper) ? { lower: e.lower, upper: e.upper, dark: !!e.dark } : null;
  }

  // ════════════════════════════════════════════════════════════════════════════════════════════════
  //  installBuiltins
  // ════════════════════════════════════════════════════════════════════════════════════════════════
  function installBuiltins() {
    if (installed) return;
    const IJMacro = LANG();
    if (!IJMacro) throw ijError('IJ_MODULE_MISSING', 'IJMacro');
    K = IJMacro.K;
    COMMA = 44; RP = 41; LP = 40; DOT = 46;
    WORD = K.WORD; NUMBER = K.NUMBER;
    Variable = IJMacro.Variable;
    MacroCancel = IJMacro.MacroCancel;
    installImageModel();
    installStacks();
    installPageState();
    installCallAndRefusals();
    installed = true;
  }

  // ---------------------------------------------------------------- image model
  function installImageModel() {
    const IJMacro = LANG();

    // getPixel(x, y) / getPixel(index)  (Functions.getPixel)
    const getPixelBody = (f, a, M) => {
      const P = proc(f, M);
      if (a.length === 2) {
        const x = a[0], y = a[1], ix = d2i(x), iy = d2i(y);
        if (x === ix && y === iy) {
          if (ix < 0 || ix >= P.W || iy < 0 || iy >= P.H) return P.bd === 32 && !P.rgb ? NaN : 0;
          const i = iy * P.W + ix;
          return P.rgb ? rgbGet(P, i) : P.data[i];
        }
        return P.rgb ? rgbInterpolated(P, x, y) : interpolatedValue(M, P, x, y);
      }
      const i = d2i(a[0]);
      if (i < 0 || i >= P.W * P.H) f.interp.error('Index ' + i + ' out of bounds for length ' + (P.W * P.H));
      if (P.rgb) return rgbGet(P, i);
      return P.data[i];
    };
    defSync('num', 'getPixel', 'n?n', getPixelBody);

    // setPixel(x, y, v) / putPixel / setPixel(index, v)  (Functions.setPixel: putPixel / putPixelValue / set / setf)
    const setPixelBody = (f, a, M) => {
      const P = wproc(f, M);
      if (a.length === 3) {
        const x = d2i(a[0]), y = d2i(a[1]), v = a[2];
        if (x < 0 || x >= P.W || y < 0 || y >= P.H) return null;
        const i = y * P.W + x;
        if (P.rgb) rgbSet(P, i, d2i(v));
        else if (P.bd === 32) P.data[i] = v;
        else { let iv = d2i(v); const top = P.bd === 8 ? 255 : 65535; if (iv > top) iv = top; if (iv < 0) iv = 0; P.data[i] = iv; }
        return null;
      }
      const i = d2i(a[0]), v = a[1];
      if (i < 0 || i >= P.W * P.H) { f.interp.error('Index ' + i + ' out of bounds for length ' + (P.W * P.H)); return null; }
      if (P.rgb) rgbSet(P, i, d2i(v));
      else if (P.bd === 32) P.data[i] = v;
      else P.data[i] = d2i(Math.fround(v)) & (P.bd === 8 ? 0xff : 0xffff);   // (byte)(float)v / (short)(float)v
      return null;
    };
    defSync('do', 'setPixel', 'nn?n', setPixelBody);
    defSync('do', 'putPixel', 'nn?n', setPixelBody);

    defSync('num', 'getWidth', '', (f, a, M) => stackDims(M, img(f, M).docId).W);
    defSync('num', 'getHeight', '', (f, a, M) => stackDims(M, img(f, M).docId).H);
    defSync('num', 'bitDepth', '', (f, a, M) => stackDims(M, img(f, M).docId).bdIJ);
    defSync('num', 'getImageID', '', (f, a, M) => img(f, M).id);
    defSync('str', 'getTitle', '', (f, a, M) => img(f, M).title);

    // getStatistics(area, mean, min, max, std, histogram) / getRawStatistics(nPixels, …)
    const statsBuiltin = (calibrated) => function* (f) {
      const it = f.interp;
      it.getLeftParen();
      const vars = [yield* f.getVariable()];
      it.getToken();
      let arg = 1;
      while (it.token === COMMA) {
        arg++;
        if (arg <= 5) vars.push(yield* f.getVariable());
        else if (arg === 6) vars.push(arrayVariable(it));
        else it.error("')' expected");
        it.getToken();
      }
      if (it.token !== RP) it.error("')' expected");
      const M = runOf(f);
      return yield* f.hostHook(() => statistics(f, M, vars, calibrated));
    };
    IJMacro.define('do', 'getStatistics', statsBuiltin(true), { suspends: true });
    IJMacro.define('do', 'getRawStatistics', statsBuiltin(false), { suspends: true });

    // getHistogram(values, counts, nBins[, histMin, histMax])
    IJMacro.define('do', 'getHistogram', function* (f) {
      const it = f.interp;
      it.getLeftParen();
      let values = null;
      if (it.nextToken() === NUMBER) yield* it.getExpression(); else values = arrayVariable(it);
      it.getComma();
      const counts = arrayVariable(it);
      it.getComma();
      const nBins = d2i(yield* it.getExpression());
      const M = runOf(f);
      const im = img(f, M);
      const bdIJ = stackDims(M, im.docId).bdIJ;
      let histMin = 0, histMax = 0, setMinMax = false;
      if (it.nextToken() === COMMA) {
        it.getComma(); histMin = yield* it.getExpression();
        it.getComma(); histMax = yield* it.getExpression();
        it.getRightParen();
        if (bdIJ === 8 || bdIJ === 24) it.error('16 or 32-bit image required to set histMin and histMax');
        setMinMax = true;
      } else it.getRightParen();
      histogram(f, M, values, counts, nBins, histMin, histMax, setMinMax);
      return null;
    }, { suspends: false, sync(f) {
      const it = f.interp;
      it.getLeftParen();
      let values = null;
      if (it.nextToken() === NUMBER) it.getExpression$s(); else values = arrayVariable(it);
      it.getComma();
      const counts = arrayVariable(it);
      it.getComma();
      const nBins = d2i(it.getExpression$s());
      const M = runOf(f);
      const im = img(f, M);
      const bdIJ = stackDims(M, im.docId).bdIJ;
      let histMin = 0, histMax = 0, setMinMax = false;
      if (it.nextToken() === COMMA) {
        it.getComma(); histMin = it.getExpression$s();
        it.getComma(); histMax = it.getExpression$s();
        it.getRightParen();
        if (bdIJ === 8 || bdIJ === 24) it.error('16 or 32-bit image required to set histMin and histMax');
        setMinMax = true;
      } else it.getRightParen();
      histogram(f, M, values, counts, nBins, histMin, histMax, setMinMax);
      return null;
    } });

    // getMinAndMax / setMinAndMax / resetMinAndMax
    defSync('do', 'getMinAndMax', 'vv', (f, a, M) => {
      const im = img(f, M);
      const P = proc(f, M);
      const d = (im.display && im.display[P.c]) || null;
      let min = d ? d.min : 0, max = d ? d.max : (P.bd === 16 ? 65535 : P.bd === 32 ? 1 : 255);
      if (P.rgb) { min = d ? d.min : 0; max = d ? d.max : 255; }
      a[0].setValue(min); a[1].setValue(max);
      return null;
    });
    defSync('do', 'setMinAndMax', 'nn?n', (f, a, M) => {
      const im = img(f, M);
      const sd = stackDims(M, im.docId);
      if (a.length === 3 && sd.bdIJ !== 24) f.interp.error('RGB image required');
      setDisplayRange(M, im, sd, a[0], a[1]);
      return null;
    });
    defSync('do', 'resetMinAndMax', '', (f, a, M) => {
      const im = img(f, M);
      const P = proc(f, M);
      let min = 0, max = 255;
      if (!P.rgb && P.bd !== 8) {
        const st = planeStats(M, P, { x: 0, y: 0, w: P.W, h: P.H }, null);
        min = st.min; max = st.max;
        if (P.bd === 32 && !(max > min)) { /* FloatProcessor.resetMinAndMax keeps a flat range as it is */ }
      }
      const chans = P.rgb ? [0, 1, 2] : [P.c];
      for (const c of chans) setDisplay(M, im, c, min, max);
      M.P = null;
      return null;
    });

    // getPixelSize(unit, pw, ph[, pd]) / getVoxelSize(w, h, d, unit) / setVoxelSize(w, h, d, unit)
    defSync('do', 'getPixelSize', 'vvv?v', (f, a, M) => {
      const im = img(f, M), c = calOf(im);
      a[0].setString(unitsOf(im)); a[1].setValue(c.pw); a[2].setValue(c.ph);
      if (a[3]) a[3].setValue(c.pd);
      return null;
    });
    defSync('do', 'getVoxelSize', 'vvvv', (f, a, M) => {
      const im = img(f, M), c = calOf(im);
      a[0].setValue(c.pw); a[1].setValue(c.ph); a[2].setValue(c.pd); a[3].setString(unitsOf(im));
      return null;
    });
    defAsync('do', 'setVoxelSize', 'nnns', (f, a, M) => setCalibration(f, M, { pixelWidth: a[0], pixelHeight: a[1], pixelDepth: a[2], unit: calUnit(a[3]) }));

    // calibrate(value): Calibration.getCValue (no density calibration in the Studio: the value itself)
    defSync('num', 'calibrate', 'n', (f, a, M) => { img(f, M); return a[0]; });

    // toScaled / toUnscaled (Functions.toScaled: one argument = a length in x; two = x, y; three = x, y, z)
    const scaledBody = (scaled) => (f, a, M) => {
      const im = img(f, M);
      const c = (im.calibration) || {};
      const pw = c.pixelWidth > 0 ? c.pixelWidth : 1, ph = c.pixelHeight > 0 ? c.pixelHeight : 1, pd = c.pixelDepth > 0 ? c.pixelDepth : 1;
      const xo = c.xOrigin || 0, yo = c.yOrigin || 0, zo = c.zOrigin || 0;
      if (a.length === 1) { a[0].setValue(scaled ? a[0].getValue() * pw : a[0].getValue() / pw); return null; }
      a[0].setValue(scaled ? (a[0].getValue() - xo) * pw : a[0].getValue() / pw + xo);
      a[1].setValue(scaled ? (a[1].getValue() - yo) * ph : a[1].getValue() / ph + yo);
      if (a.length > 2) a[2].setValue(scaled ? (a[2].getValue() - zo) * pd : a[2].getValue() / pd + zo);
      return null;
    };
    defSync('do', 'toScaled', 'v?vv', scaledBody(true));
    defSync('do', 'toUnscaled', 'v?vv', scaledBody(false));

    // changeValues(v1, v2, v3)  (Functions.changeValues)
    defSync('do', 'changeValues', 'nnn', (f, a, M) => {
      const P = wproc(f, M);
      let lo = a[0], hi = a[1];
      const v3 = a[2];
      const roi = selectionOf(M, P.docId);
      const reg = roiRegion(P, isAreaRoi(roi) ? roi : null);
      const r = isAreaRoi(roi) ? root.IJRoi.bounds(roi) : { x: 0, y: 0, w: P.W, h: P.H };
      const xmin = r.x, ymin = r.y, xmax = r.x + r.w, ymax = r.y + r.h;
      const isFloat = !P.rgb && P.bd === 32;
      if (P.rgb) { lo = d2i(lo) & 0xffffff; hi = d2i(hi) & 0xffffff; }
      const top = P.bd === 8 ? 255 : 65535;
      const nanAll = lo !== lo && hi !== hi;
      const m = reg.mask, mr = reg.rect;
      for (let y = ymin; y < ymax; y++) {
        for (let x = xmin; x < xmax; x++) {
          if (x < 0 || y < 0 || x >= P.W || y >= P.H) continue;
          const i = y * P.W + x;
          const v = isFloat ? P.data[i] : (P.rgb ? rgbGet(P, i) & 0xffffff : P.data[i]);
          let replace = v >= lo && v <= hi;
          if (nanAll && v !== v) replace = true;
          if (!replace) continue;
          // with a non-rectangular selection, ip.reset(mask) puts back every pixel outside the mask
          if (m && !(x >= mr.x && y >= mr.y && x < mr.x + mr.w && y < mr.y + mr.h && m[(y - mr.y) * mr.w + (x - mr.x)])) continue;
          if (isFloat) P.data[i] = v3;
          else if (P.rgb) rgbSet(P, i, d2i(v3));
          else { let iv = d2i(v3); if (iv > top) iv = top; if (iv < 0) iv = 0; P.data[i] = iv; }
        }
      }
      return null;
    });

    // setColor(value) / setColor(r, g, b) / setColor("name")
    IJMacro.define('do', 'setColor', function* (f) {
      const it = f.interp;
      it.getLeftParen();
      const M = runOf(f);
      if (f.isStringArg()) { const s = yield* f.getString(); it.getRightParen(); setColorName(f, M, s); return null; }
      const a1 = yield* it.getExpression();
      if (it.nextToken() === RP) { it.getRightParen(); setColorValue(f, M, a1); return null; }
      it.getComma(); const g = yield* it.getExpression(); it.getComma(); const b = yield* it.getExpression(); it.getRightParen();
      setColorRGB(M, a1, g, b);
      return null;
    }, { suspends: false, sync(f) {
      const it = f.interp;
      it.getLeftParen();
      const M = runOf(f);
      if (f.isStringArg()) { const s = f.getString$s(); it.getRightParen(); setColorName(f, M, s); return null; }
      const a1 = it.getExpression$s();
      if (it.nextToken() === RP) { it.getRightParen(); setColorValue(f, M, a1); return null; }
      it.getComma(); const g = it.getExpression$s(); it.getComma(); const b = it.getExpression$s(); it.getRightParen();
      setColorRGB(M, a1, g, b);
      return null;
    } });
    defSync('do', 'setLineWidth', 'n', (f, a, M) => { M.draw.lineWidth = d2i(a[0]); M.lineWidth = d2i(a[0]); return null; });
    const fgbg = (fg) => (f, a, M) => {
      let r, g, b;
      if (a.length === 1) { const v = d2i(a[0]); r = (v & 0xff0000) >> 16; g = (v & 0xff00) >> 8; b = v & 0xff; }
      else { r = d2i(a[0]); g = d2i(a[1]); b = d2i(a[2]); }
      const c = [r & 0xff, g & 0xff, b & 0xff].map((x, i) => Math.max(0, Math.min(255, [r, g, b][i])));
      const im = M.images.get(M.current) || null;
      if (fg) {
        // Functions.setForegroundColor: getProcessor() (line width), IJ.setForegroundColor, resetImage(), setLineWidth() → a new
        // defaultIP coloured from the globals that are still set, and only then "globalColor = null; globalValue = Double.NaN"
        if (im) proc(f, M);
        M.colors.foreground = c;
        M.write('colors.set', { foreground: c });
        if (im) { M.fg = undefined; fgValue(M, proc(f, M)); } else M.fg = undefined;
        M.draw.color = null; M.draw.value = NaN;
      } else { M.colors.background = c; M.write('colors.set', { background: c }); M.fg = undefined; }
      return null;
    };
    defSync('do', 'setForegroundColor', 'n?nn', fgbg(true));
    defSync('do', 'setBackgroundColor', 'n?nn', fgbg(false));

    // moveTo / lineTo / drawLine / drawRect / drawOval / fillRect / fillOval / fill / floodFill
    defSync('do', 'moveTo', 'nn', (f, a, M) => { M.draw.x = jround(a[0]); M.draw.y = jround(a[1]); return null; });
    defSync('do', 'lineTo', 'nn', (f, a, M) => { raster(f, M).lineTo(jround(a[0]), jround(a[1])); return null; });
    defSync('do', 'drawLine', 'nnnn', (f, a, M) => { const r = raster(f, M); r.moveTo(jround(a[0]), jround(a[1])); r.lineTo(jround(a[2]), jround(a[3])); return null; });
    defSync('do', 'drawRect', 'nnnn', (f, a, M) => { raster(f, M).drawRect(d2i(a[0]), d2i(a[1]), d2i(a[2]), d2i(a[3])); return null; });
    defSync('do', 'fillRect', 'nnnn', (f, a, M) => { raster(f, M).fillRect(d2i(a[0]), d2i(a[1]), d2i(a[2]), d2i(a[3])); return null; });
    defSync('do', 'drawOval', 'nnnn', (f, a, M) => {
      const x = d2i(a[0]), y = d2i(a[1]), w = d2i(a[2]), h = d2i(a[3]);
      const r = raster(f, M);
      if (w * h > 4 * r.P.W * r.P.H || w <= 0 || h <= 0) return null;
      const pts = ovalOutline(x, y, w, h);
      if (pts.length) r.drawPolygon(pts.map((p) => p[0]), pts.map((p) => p[1]));
      return null;
    });
    defSync('do', 'fillOval', 'nnnn', (f, a, M) => {
      const x = d2i(a[0]), y = d2i(a[1]), w = d2i(a[2]), h = d2i(a[3]);
      const r = raster(f, M);
      if (w * h > 4 * r.P.W * r.P.H || w <= 0 || h <= 0) return null;
      r.fillMask({ x, y, w, h, data: ovalMask(w, h) });
      return null;
    });
    defSync('do', 'fill', '', (f, a, M) => {
      const r = raster(f, M);
      M.fg = undefined;   // doIPMethod(FILL) calls getImage() after it took the processor
      const roi = selectionOf(M, r.P.docId);
      if (!roi) r.fillRect(0, 0, r.P.W, r.P.H);
      else if (roi.type === 'rect') { const b = root.IJRoi.bounds(roi); r.fillRect(b.x, b.y, b.w, b.h); }
      else if (isAreaRoi(roi)) r.fillMask(root.IJRoi.mask(roi, r.P.W, r.P.H));
      else if (roi.type === 'line') { r.moveTo(jround(roi.x1), jround(roi.y1)); r.lineTo(jround(roi.x2), jround(roi.y2)); }
      else if (roi.type === 'polyline' || roi.type === 'angle') { const p = roi.points; r.moveTo(jround(p[0][0]), jround(p[0][1])); for (let i = 1; i < p.length; i++) r.lineTo(jround(p[i][0]), jround(p[i][1])); }
      else if (roi.type === 'point') for (const p of roi.points) { r.moveTo(jround(p[0]), jround(p[1])); r.lineTo(jround(p[0]), jround(p[1])); }
      return null;
    });
    defSync('do', 'floodFill', 'nn?s', (f, a, M) => { floodFill(f, M, d2i(a[0]), d2i(a[1]), a.length > 2 && String(a[2]).indexOf('8') !== -1); return null; });

    // snapshot / reset (ImageProcessor.snapshot / reset of the current plane)
    defSync('do', 'snapshot', '', (f, a, M) => {
      const P = proc(f, M);
      M.snapshots.set(P.docId, { z: P.z, t: P.t, c: P.c, rgb: P.rgb, planes: P.rgb ? [P.r.slice(), P.g.slice(), P.b.slice()] : [P.data.slice()] });
      return null;
    });
    defSync('do', 'reset', '', (f, a, M) => {
      const P = proc(f, M);
      const s = M.snapshots.get(P.docId);
      if (!s || s.planes[0].length !== P.W * P.H) return null;
      const W = wproc(f, M);
      if (W.rgb) { W.r.set(s.planes[0]); W.g.set(s.planes[1]); W.b.set(s.planes[2]); }
      else W.data.set(s.planes[0]);
      return null;
    });
    defSync('do', 'setupUndo', '', () => null);
    defAsync('do', 'updateDisplay', '', async (f, a, M) => { await M.commitAll(); M.P = null; return null; });
    defSync('do', 'autoUpdate', 'b', (f, a, M) => { M.draw.autoUpdate = a[0]; return null; });

    // getProfile()
    defAsync('arr', 'getProfile', '', async (f, a, M) => {
      const im = M.images.get(M.current);
      if (!im) throw macroError('There are no images open');
      const roi = selectionOf(M, im.docId);
      if (!roi) throw macroError('Selection required');
      if (!(roi.type === 'line' || roi.type === 'polyline' || roi.type === 'rect')) throw macroError('Line or rectangular selection required');
      if (typeof M.E.request !== 'function') throw macroError(M.tr('err.macNotInBrowser', { name: 'getProfile' }));
      await M.commitAll();
      const pos = M.E.getPosition(im.docId);
      const r = await M.E.request('doc.profile', { docId: im.docId, channel: im.rgb ? 0 : pos.c, roi, pos: { z: pos.z, t: pos.t }, vertical: !!M.keys.alt });
      return f.newVariableArray(Array.from((r && r.values) || []));
    });

    // getValue(x, y) / getValue("key")
    IJMacro.define('num', 'getValue', function* (f) {
      const it = f.interp;
      it.getLeftParen();
      const M = runOf(f);
      if (!f.isStringArg()) {
        const x = yield* it.getExpression();
        it.getComma(); const y = yield* it.getExpression(); it.getRightParen();
        const P = proc(f, M);
        const ix = d2i(x), iy = d2i(y);
        return x === ix && y === iy ? pixelValue(M, P, ix, iy) : interpolatedValue(M, P, x, y);
      }
      const key = yield* f.getString();
      it.getRightParen();
      return yield* f.hostHook(() => getValueKey(f, M, key));
    }, { suspends: true });

    // newImage(title, type, width, height, depth) / (…, c, z, t)
    defAsync('do', 'newImage', 'ssnnn?nn', (f, a, M) => newImage(f, M, a));
    // imageCalculator(op, img1, img2)
    IJMacro.define('do', 'imageCalculator', function* (f) {
      const it = f.interp;
      const op = yield* f.getFirstString();
      it.getComma();
      const i1 = f.isStringArg() ? { s: yield* f.getString() } : yield* it.getExpression();
      it.getComma();
      const i2 = f.isStringArg() ? { s: yield* f.getString() } : yield* it.getExpression();
      it.getRightParen();
      const M = runOf(f);
      return yield* f.hostHook(() => imageCalculator(f, M, op, i1, i2));
    }, { suspends: true });

    // setRGBWeights(r, g, b): ColorProcessor.setWeightingFactors for the run (getPixelValue, statistics of an RGB image)
    defSync('do', 'setRGBWeights', 'nnn', (f, a, M) => { M.rgbWeights = [a[0], a[1], a[2]]; return null; });
    defSync('do', 'setZCoordinate', 'n', (f, a, M) => {
      const im = img(f, M);
      const sd = stackDims(M, im.docId), size = stackSize(sd), z = d2i(a[0]);
      if (z < 0 || z >= size) f.interp.error('Z coordinate (' + z + ') is out of 0-' + (size - 1) + ' range');
      const p = root.IJStack.position(sd, z + 1);
      M.P = null;
      const P = proc(f, M);
      P.c = sd.rgb ? 0 : p.c; P.z = p.z; P.t = p.t;
      if (P.rgb) { P.r = M.plane(P.docId, 0, p.z, p.t); P.g = M.plane(P.docId, 1, p.z, p.t); P.b = M.plane(P.docId, 2, p.z, p.t); }
      else P.data = M.plane(P.docId, P.c, p.z, p.t);
      return null;
    });
  }

  /* getStatistics / getRawStatistics (Functions.getStatistics): area or pixel count, mean, min, max, std, histogram. */
  function statistics(f, M, vars, calibrated) {
    const P = proc(f, M);
    const roi = selectionOf(M, P.docId);
    if (roi && isLineRoi(roi)) return lineStatistics(f, M, P, roi, vars, calibrated);
    const reg = roiRegion(P, isAreaRoi(roi) ? roi : null);
    const st = planeStats(M, P, reg.rect, reg.mask);
    const cal = calOf(P.im);
    vars[0].setValue(calibrated ? st.n * cal.pw * cal.ph : st.n);
    if (vars[1]) vars[1].setValue(st.mean);
    if (vars[2]) vars[2].setValue(st.min);
    if (vars[3]) vars[3].setValue(st.max);
    if (vars[4]) vars[4].setValue(st.stdDev);
    if (vars[5]) {
      const is16 = !calibrated && !P.rgb && P.bd === 16;
      if (is16) { const hmax = d2i(st.max); vars[5].setArray(Array.from({ length: hmax + 1 }, (_, i) => Variable.num(st.histogram16[i]))); }
      else vars[5].setArray(st.histogram.slice(0, 256).map((c) => Variable.num(c)));
    }
    return null;
  }
  /* A line selection: the statistics of its profile (ProfilePlot values in a 1-row FloatProcessor), through the engine. */
  async function lineStatistics(f, M, P, roi, vars, calibrated) {
    if (typeof M.E.request !== 'function') throw macroError(M.tr('err.macNotInBrowser', { name: 'getStatistics' }));
    await M.commitAll();
    const r = await M.E.request('doc.profile', { docId: P.docId, channel: P.rgb ? 0 : P.c, roi, pos: { z: P.z, t: P.t } });
    const values = Float32Array.from((r && r.values) || []);
    const Q = { W: values.length, H: 1, bd: 32, rgb: false, data: values };
    let rect = { x: 0, y: 0, w: values.length, h: 1 };
    if (roi.type === 'line' && (roi.y1 === roi.y2 || roi.x1 === roi.x2) && [roi.x1, roi.y1, roi.x2, roi.y2].every((v) => v === d2i(v))) rect = { x: 0, y: 0, w: Math.max(0, values.length - 1), h: 1 };
    const st = planeStats(M, Q, rect, null);
    vars[0].setValue(calibrated ? st.n : st.n);
    if (vars[1]) vars[1].setValue(st.mean);
    if (vars[2]) vars[2].setValue(st.min);
    if (vars[3]) vars[3].setValue(st.max);
    if (vars[4]) vars[4].setValue(st.stdDev);
    if (vars[5]) vars[5].setArray(st.histogram.slice(0, 256).map((c) => Variable.num(c)));
    return null;
  }
  /* getHistogram (Functions.getHistogram) */
  function histogram(f, M, values, counts, nBins, histMin, histMax, setMinMax) {
    const P = proc(f, M);
    const roi = selectionOf(M, P.docId);
    const reg = roiRegion(P, isAreaRoi(roi) ? roi : null);
    const bdIJ = P.rgb ? 24 : P.bd;
    if (nBins === 65536 && bdIJ === 16) {
      const st = planeStats(M, P, reg.rect, reg.mask);
      const hist = st.histogram16;
      const arr = counts.getArray();
      if (arr !== null && arr.length === nBins) for (let i = 0; i < nBins; i++) arr[i].setValue(hist[i]);
      else counts.setArray(Array.from(hist, (c) => Variable.num(c)));
      return;
    }
    if (!(nBins > 0)) f.interp.error('Invalid number of bins');
    let st, inc = 1.0, start;
    if ((bdIJ === 8 || bdIJ === 24) && nBins !== 256) {
      // convertToShort(false) then getStatistics(…, nBins, 0, 256): the 16-bit binning over [0, 256]
      const Q = { W: P.W, H: P.H, bd: 16, rgb: false, data: P.rgb ? Uint16Array.from({ length: P.W * P.H }, (_, i) => d2i(rgbValue(M, P, i) + 0.5) & 0xff) : Uint16Array.from(P.data) };
      st = planeStats(M, Q, reg.rect, reg.mask, nBins, 0, 256);
      start = st.histMin;
      inc = (st.histMax - st.histMin) / st.nBins;
    } else {
      st = planeStats(M, P, reg.rect, reg.mask, nBins, setMinMax ? histMin : 0, setMinMax ? histMax : 0);
      start = (bdIJ === 8 || bdIJ === 24) ? 0 : st.histMin;
      if (bdIJ === 16 || bdIJ === 32) inc = (st.histMax - st.histMin) / st.nBins;
    }
    if (values !== null) {
      const arr = new Array(nBins);
      let v = start;
      for (let i = 0; i < nBins; i++) { arr[i] = Variable.num(v); v += inc; }
      values.setArray(arr);
    }
    const arr = counts.getArray();
    if (arr !== null && arr.length === nBins) for (let i = 0; i < nBins; i++) arr[i].setValue(st.histogram[i]);
    else counts.setArray(st.histogram.map((c) => Variable.num(c)));
  }
  function setDisplay(M, im, c, min, max) {
    if (!im.display) im.display = [];
    im.display[c] = Object.assign({}, im.display[c] || {}, { min, max });
    M.write('display.set', { docId: im.docId, c, min, max });
  }
  /* IJ.setMinAndMax: 8 and 16-bit ranges are whole numbers (Math.round), 16-bit (0, 0) resets to the data range; an RGB image's
   * channels share the range (the `channels` argument is not modelled: every colour). */
  function setDisplayRange(M, im, sd, min, max) {
    if (max < min) return;
    const P = M.P;
    const c = sd.rgb ? 0 : M.E.getPosition(im.docId).c;
    if (sd.bd !== 32) { min = jround(min); max = jround(max); }
    if (sd.bd === 16 && min === 0 && max === 0) {
      const Q = { W: sd.W, H: sd.H, bd: 16, rgb: false, data: M.plane(im.docId, c, M.E.getPosition(im.docId).z, M.E.getPosition(im.docId).t) };
      const st = planeStats(M, Q, { x: 0, y: 0, w: sd.W, h: sd.H }, null);
      min = st.min; max = st.max;
    }
    const chans = sd.rgb ? [0, 1, 2] : [c];
    for (const ch of chans) setDisplay(M, im, ch, min, max);
    if (P) M.P = null;
  }
  function setColorName(f, M, s) {
    const c = colorOf(s);
    if (!c) { f.interp.error("'red', 'green', or '#0000ff' etc. expected"); return; }
    M.draw.color = c; M.draw.value = NaN; M.fg = undefined;
  }
  function setColorRGB(M, r, g, b) {
    const cl = (v) => { v = d2i(v); return v < 0 ? 0 : v > 255 ? 255 : v; };
    M.draw.color = [cl(r), cl(g), cl(b)]; M.draw.value = NaN; M.fg = undefined;
  }
  /* Functions.setColor(double): the range check of the type, then ip.setValue */
  function setColorValue(f, M, value) {
    const P = proc(f, M);
    if (!P.rgb && P.bd === 8 && (value < 0 || value > 255)) f.interp.error('Argument out of 8-bit range (0-255)');
    if (!P.rgb && P.bd === 16 && (value < 0 || value > 65535)) f.interp.error('Argument out of 16-bit range (0-65535)');
    M.fg = undefined;
    if (P.rgb) { M.draw.value = value; M.draw.color = null; return; }
    M.draw.value = value; M.draw.color = null;
  }
  /* Functions.getColor + Colors.decode */
  const NAMED = { black: [0, 0, 0], white: [255, 255, 255], red: [255, 0, 0], green: [0, 255, 0], blue: [0, 0, 255], cyan: [0, 255, 255],
    darkgray: [64, 64, 64], gray: [128, 128, 128], lightgray: [192, 192, 192], magenta: [255, 0, 255], orange: [255, 200, 0], yellow: [255, 255, 0], pink: [255, 175, 175] };
  function colorOf(s) {
    const c = String(s).toLowerCase();
    if (NAMED[c]) return NAMED[c].slice();
    if (c.startsWith('#')) {
      const hex = c.substring(1);
      if (/^[0-9a-f]{6}$/.test(hex)) { const v = parseInt(hex, 16); return [(v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff]; }
      if (/^[0-9a-f]{8}$/.test(hex)) { const v = parseInt(hex.substring(2), 16); return [(v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff]; }
      return [0, 0, 0];
    }
    return null;
  }
  /* ij.process.FloodFiller.fill / fill8 (the scan-line fill of the seed's exact value) with the drawing value. */
  function floodFill(f, M, x, y, eight) {
    const r = raster(f, M);
    const P = r.P, W = P.W, H = P.H;
    if (x < 0 || x >= W || y < 0 || y >= H) return;
    const get = P.rgb ? (i) => rgbGet(P, i) : (i) => P.data[i];
    const seed = get(y * W + x);
    const same = (i) => { const v = get(i); return v === seed || (v !== v && seed !== seed); };
    const fgv = r.fg;
    if (P.rgb ? (seed === fgv) : (seed === fgv)) return;
    const stack = [[x, y]];
    while (stack.length) {
      const [sx, sy] = stack.pop();
      if (!same(sy * W + sx)) continue;
      let x1 = sx, x2 = sx;
      while (x1 > 0 && same(sy * W + x1 - 1)) x1--;
      while (x2 < W - 1 && same(sy * W + x2 + 1)) x2++;
      for (let i = x1; i <= x2; i++) r.set(sy * W + i);
      const a = eight ? Math.max(0, x1 - 1) : x1, b = eight ? Math.min(W - 1, x2 + 1) : x2;
      for (const ny of [sy - 1, sy + 1]) {
        if (ny < 0 || ny >= H) continue;
        let inRun = false;
        for (let i = a; i <= b; i++) {
          if (same(ny * W + i)) { if (!inRun) { stack.push([i, ny]); inRun = true; } }
          else inRun = false;
        }
      }
    }
  }
  /* getValue("key") (Functions.getValue) */
  async function getValueKey(f, M, key) {
    if (key === 'rgb.foreground') { const c = M.colors.foreground || [255, 255, 255]; return (c[0] << 16) | (c[1] << 8) | c[2]; }
    if (key === 'rgb.background') { const c = M.colors.background || [0, 0, 0]; return (c[0] << 16) | (c[1] << 8) | c[2]; }
    if (key.indexOf('foreground') >= 0 || key.indexOf('background') >= 0) {
      const c = key.indexOf('foreground') >= 0 ? M.colors.foreground || [255, 255, 255] : M.colors.background || [0, 0, 0];
      const im = M.images.get(M.current);
      if (!im) return (c[0] << 16) | (c[1] << 8) | c[2];
      const P = proc(f, M);
      if (P.rgb) return (c[0] << 16) | (c[1] << 8) | c[2];
      const save = M.draw.color, saveV = M.draw.value;
      M.draw.color = c; M.draw.value = NaN;
      const v = fgValue(M, P);
      M.draw.color = save; M.draw.value = saveV;
      return v;
    }
    if (key === 'image.size') {
      const im = img(f, M);
      const sd = stackDims(M, im.docId);
      return sd.W * sd.H * (sd.bdIJ === 24 ? 4 : sd.bd / 8) * stackSize(sd);
    }
    if (key === 'selection.size') { const im = img(f, M); const roi = selectionOf(M, im.docId); return roi ? roiSize(roi) : 0; }
    if (key === 'selection.width') {
      // roi.getStrokeWidth(): 0 unless a width was given to the selection
      const im = img(f, M); const roi = selectionOf(M, im.docId); if (!roi) f.interp.error('No selection'); return roi.width > 0 ? roi.width : 0;
    }
    if (key === 'results.count') { const t = M.tables.get('Results'); return t ? t.size : 0; }
    if (key === 'rotation.angle') return 15;
    if (key === 'font.size') return 12;
    if (key === 'font.height') return 15;
    if (key === 'done') return f.interp.done ? 1 : 0;
    if (key === 'hashCode' || key === 'instance') return 0;
    // Functions.getValue: a key that starts with a default heading goes to IJ.getValue, which splits "<column>[ options]" at the first
    // space and reads the column by its exact name (none: NaN)
    if (!key.startsWith('Length') && !DEFAULT_HEADINGS.some((h) => key.startsWith(h))) { f.interp.error('Invalid key'); return 0; }
    const sp = key.indexOf(' ');
    const column = sp > 0 ? key.slice(0, sp) : key;
    const opts = sp > 0 && sp < key.length - 1 ? key.slice(sp + 1) : '';
    const mkey = column === 'Ch' || column === 'Slice' || column === 'Frame' ? column : KEY_OF_HEADING.get(column) || null;
    if (!mkey) return NaN;
    return measureValue(f, M, key, mkey, { limit: opts.indexOf('limit') >= 0, raw: opts.indexOf('raw') >= 0 });
  }
  /* IJ.getValue(imp, measurement): Analyzer.measure of the current selection with ALL_STATS + SLICE (+ LIMIT for " limit"; " raw" without the
     calibration), the column `key`. The Set Measurements state plays no part. */
  async function measureValue(f, M, key, mkey, o) {
    const im = img(f, M);
    if (mkey === 'Ch' || mkey === 'Slice' || mkey === 'Frame') {
      const p = M.E.getPosition(im.docId);
      return mkey === 'Ch' ? p.c + 1 : mkey === 'Slice' ? p.z + 1 : p.t + 1;
    }
    if (typeof M.E.request !== 'function') throw macroError(M.tr('err.macNotInBrowser', { name: 'getValue("' + key + '")' }));
    await M.commitAll();
    M.P = null;
    const pos = M.E.getPosition(im.docId);
    const roi = selectionOf(M, im.docId);
    const keys = [mkey];
    const lim = !!(o && o.limit);
    const thr = thresholdOf(M, im.docId, im.rgb ? 0 : pos.c);
    const r = await M.E.request('doc.stats', { docId: im.docId, channel: im.rgb ? 0 : pos.c, roi, measurements: keys, pos: { z: pos.z, t: pos.t }, threshold: thr, limit: lim && !!thr,
      raw: !!(o && o.raw) });
    const row = (r && r.row) || {};
    const v = row[mkey];
    if (v === undefined || v === null) return NaN;
    return typeof v === 'number' ? v : toolsParseDouble(String(v), NaN);
  }
  function roiSize(roi) {
    if (roi.type === 'rect') return 4;
    if (roi.type === 'line') return 2;
    if (roi.points) return roi.points.length;
    if (roi.type === 'oval') { const v = root.IJRoiTools && root.IJRoiTools.ovalPolygon ? root.IJRoiTools.ovalPolygon(roi.x, roi.y, roi.w, roi.h) : null; return v ? v.xs.length : 0; }
    return 0;
  }
  async function setCalibration(f, M, cal) {
    const im = img(f, M);
    await M.commitAll();
    await M.E.runOp(im.docId, 'macroCalibration', { calibration: cal }, { planes: 'all', noUndo: false });
    im.calibration = Object.assign({}, im.calibration || {}, cal);
    M.changed.add(im.docId);
    M.P = null;
    return null;
  }
  /* Calibration.setUnit: an empty unit is the pixel, "um" is spelled with the micro sign, anything else is kept as given. */
  function calUnit(u) {
    const s = String(u);
    if (s === '' || s === 'pixels' || s === 'pixel') return 'pixel';
    if (s === 'um') return 'µm';
    return s;
  }

  /* NewImage: the type string (IJ.createImage) and the fill of every slice. */
  async function newImage(f, M, a) {
    const title = a[0];
    let type = a[1];
    const width = d2i(a[2]), height = d2i(a[3]);
    let depth = d2i(a[4]);
    let c = -1, z = -1, t = -1;
    if (a.length > 5) { c = depth; z = d2i(a[5]); t = d2i(a[6]); }
    if (width < 1 || height < 1) throw macroError('Width or height < 1');
    const hyper = c >= 0;
    if (hyper) {
      // HyperStackMaker.labelHyperstack draws each slice's label as text into its pixels: no text rendering here
      if (type.indexOf('label') >= 0) throw macroError(M.tr('err.macNotInBrowser', { name: 'newImage("' + type + '")' }));
      if (!(type.indexOf('white') >= 0 || type.indexOf('ramp') >= 0)) type += 'black';
      depth = c * z * t;
    }
    const lc = type.toLowerCase();
    let bd = 8;
    if (lc.indexOf('16') >= 0) bd = 16;
    const signedInt = lc.indexOf('32-bit int') >= 0;
    if (lc.indexOf('32') >= 0) bd = 32;
    if (lc.indexOf('24') >= 0 || lc.indexOf('rgb') >= 0 || signedInt) bd = 24;
    if (signedInt) throw macroError(M.tr('err.macNotInBrowser', { name: 'newImage("32-bit int")' }));
    let fill = bd === 16 || bd === 32 ? 'black' : 'white';
    if (lc.indexOf('white') >= 0) fill = 'white';
    else if (lc.indexOf('black') >= 0) fill = 'black';
    else if (lc.indexOf('ramp') >= 0) fill = 'ramp';
    else if (lc.indexOf('noise') >= 0 || lc.indexOf('random') >= 0) fill = 'noise';
    if (depth < 1) depth = 1;
    if (width * height > 2147483647) throw macroError('Image is too large. ImageJ does not support\nsingle images larger than 2 gigapixels.');
    const nC = hyper ? Math.max(1, c) : 1, nZ = hyper ? Math.max(1, z) : depth, nT = hyper ? Math.max(1, t) : 1;
    const rgb = bd === 24, sbd = rgb ? 8 : bd;
    const N = width * height, C = ctorOf(sbd);
    const planesPerChannel = nZ * nT;
    const bytes = N * (sbd === 8 ? 1 : sbd === 16 ? 2 : 4) * (rgb ? 3 : 1);
    const IJShared = root.IJShared;
    let rnd = null;
    const random = () => { if (!rnd) rnd = new IJShared.JavaRandom(Date.now() % 2147483647); return rnd; };
    // the first slice, then each other one: white / ramp copy the first, noise has its own draw, black is zeros
    const firstSlice = () => {
      if (rgb) {
        const r = new Uint8Array(N), g = new Uint8Array(N), b = new Uint8Array(N);
        if (fill === 'white') { r.fill(255); g.fill(255); b.fill(255); }
        else if (fill === 'ramp') { for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) { const v = d2i((x * 256.0) / width) & 0xff; const i = y * width + x; r[i] = g[i] = b[i] = v; } }
        else if (fill === 'noise') for (const p of [r, g, b]) { p.fill(127); noise(p, 8, 31, random()); }
        return [r, g, b];
      }
      const d = new C(N);
      if (sbd === 8) {
        if (fill === 'white') d.fill(255);
        else if (fill === 'ramp') for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) d[y * width + x] = d2i((x * 256.0) / width) & 0xff;
        else if (fill === 'noise') { d.fill(127); noise(d, 8, 31, random()); }
      } else if (sbd === 16) {
        if (fill === 'ramp') for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) d[y * width + x] = d2i(((x * 65536.0) / width) + 0.5) & 0xffff;
        else if (fill === 'noise') { d.fill(32767); noise(d, 16, 7940, random()); }
      } else {
        if (fill === 'ramp') for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) d[y * width + x] = (x * 1.0) / width;
        else if (fill === 'noise') noise(d, 32, 1, random());
      }
      return [d];
    };
    M.E.reserve(bytes);
    const first = firstSlice();
    // a slice of the stack, flat index n (0-based): ImageJ fills slices 2..N the same way whatever the dimensions
    const nSlices = nC * planesPerChannel;
    const sliceArrays = (n) => {
      if (n === 0) return first;
      if (fill === 'noise') {
        if (rgb) return [0, 1, 2].map(() => { const p = new Uint8Array(N); p.fill(127); noise(p, 8, 31, random()); return p; });
        const d = new C(N);
        if (sbd === 8) { d.fill(127); noise(d, 8, 31, random()); } else if (sbd === 16) { d.fill(32767); noise(d, 16, 7940, random()); } else noise(d, 32, 1, random());
        return [d];
      }
      if (fill === 'white' || fill === 'ramp') return first;
      return rgb ? [new Uint8Array(N), new Uint8Array(N), new Uint8Array(N)] : [new C(N)];
    };
    const k = rgb ? 3 : nC;
    const channels = [];
    for (let ci = 0; ci < k; ci++) channels.push({ planes: new Array(planesPerChannel) });
    const blank = rgb ? null : new C(N);
    for (let n = 0; n < nSlices; n++) {
      const cc = n % nC, pi = (n - cc) / nC;
      const arrays = (fill === 'black' && n > 0) ? (rgb ? [new Uint8Array(N), new Uint8Array(N), new Uint8Array(N)] : [blank]) : sliceArrays(n);
      if (rgb) { channels[0].planes[pi] = arrays[0]; channels[1].planes[pi] = arrays[1]; channels[2].planes[pi] = arrays[2]; }
      else channels[cc].planes[pi] = arrays[0];
      if ((n & 63) === 63) M.E.check();
    }
    const displayOf = (data) => {
      if (rgb || sbd === 8) return { min: 0, max: 255, lut: 'Grays', invert: false };
      if (sbd === 16) return { min: 0, max: 65535, lut: 'Grays', invert: fill === 'white' };
      if (fill === 'noise') { let mn = Infinity, mx = -Infinity; for (let i = 0; i < data.length; i++) { const v = data[i]; if (v < mn) mn = v; if (v > mx) mx = v; } return { min: mn, max: mx, lut: 'Grays', invert: false }; }
      return { min: 0, max: 1, lut: 'Grays', invert: fill === 'white' };
    };
    const image = {
      name: title, width, height, bitDepth: sbd, nZ, nT, rgb, hyperstack: hyper,
      calibration: { pixelWidth: 1, pixelHeight: 1, pixelDepth: 1, unit: 'pixel' },
      channels: channels.map((ch, ci) => {
        const base = rgb ? RGB_NAMES[ci] : { name: 'C' + (ci + 1), color: nC > 1 ? (lc.indexOf('composite') >= 0 || lc.indexOf('color') >= 0 || true ? COMPOSITE_COLORS[ci % 7] : '#ffffff') : '#ffffff' };
        const lut = !rgb && nC > 1 ? COMPOSITE_COLORS[ci % 7] : 'Grays';
        const disp = Object.assign(displayOf(ch.planes[0]), rgb ? {} : { lut: nC > 1 ? lut : 'Grays' });
        return { name: base.name, color: base.color, display: disp, planes: ch.planes };
      })
    };
    if (hyper && nC > 1 && !rgb) image.mode = lc.indexOf('composite') >= 0 ? 'composite' : lc.indexOf('grayscale') >= 0 ? 'gray' : 'color';
    await M.commitAll();
    const info = M.E.createDoc(image, { hidden: M.batch, provenance: { macro: { newImage: type } } });
    if (M.batch) M.batchDocs.push(info.docId);
    await adopt(M, info);
    return null;
  }
  /* ImageProcessor.noise(sd) as ij-proc-edit.js addNoise does (Byte / Short: a draw outside the range is drawn again). */
  function noise(data, bd, sd, rnd) {
    const n = data.length;
    if (bd === 32) { for (let i = 0; i < n; i++) data[i] = data[i] + Math.fround(rnd.nextGaussian() * sd); return; }
    const top = bd === 8 ? 255 : 65535;
    for (let i = 0; i < n; i++) {
      for (;;) {
        const v = data[i] + jround(rnd.nextGaussian() * sd);
        if (v >= 0 && v <= top) { data[i] = v; break; }
      }
    }
  }
  /* imageCalculator(operator, img1, img2): ImageCalculator.calculate through the op the Image Calculator… command runs. */
  async function imageCalculator(f, M, operation, i1, i2) {
    const lc = operation.toLowerCase();
    const OPS = ['add', 'sub', 'mul', 'div', 'and', 'or', 'xor', 'min', 'max', 'ave', 'diff', 'copy', 'zero'];
    const NAMES = ['add', 'subtract', 'multiply', 'divide', 'and', 'or', 'xor', 'min', 'max', 'average', 'difference', 'copy', 'transparent-zero'];
    let op = lc.indexOf('xor') !== -1 ? 6 : -1;
    if (op === -1) for (let i = 0; i < OPS.length; i++) if (lc.indexOf(OPS[i]) !== -1) { op = i; break; }
    const find = (a) => {
      for (const im of M.images.values()) if (typeof a === 'object' ? im.title === a.s : im.id === d2i(a)) return im;
      return null;
    };
    const a = find(i1), b = find(i2);
    if (!a || !b) throw macroError('Image not found');
    if (op === -1) { await M.rpc('dialog.message', { title: 'Image Calculator', text: 'No valid operator' }); return null; }
    let create = operation.indexOf('create') !== -1;
    const float32 = operation.indexOf('32') !== -1 || operation.indexOf('float') !== -1;
    const stack = operation.indexOf('stack') !== -1;
    const da = stackDims(M, a.docId), db = stackDims(M, b.docId);
    if (float32 && !(da.bd === 32 && db.bd === 32 && !da.rgb && !db.rgb)) create = true;
    const params = { op: NAMES[op], float32, all: true };
    if (!(da.nC === db.nC || db.nC === 1)) { const pa = M.E.getPosition(a.docId), pb = M.E.getPosition(b.docId); params.all = false; params.channel1 = pa.c; params.channel2 = pb.c; }
    const planesA = da.nZ * da.nT, planesB = db.nZ * db.nT;
    if (stack && planesA > 1) {
      if (planesB > 1 && planesB !== planesA) throw macroError("'Image1' and 'image2' must be stacks with the same\nnumber of slices, or 'image2' must be a single image.");
      params.slices = 'all';
    }
    await M.commitAll();
    // the result reads image 1's display range from the engine: the ranges this run set must have reached it
    await M.syncWrites();
    const docIds = a.docId === b.docId ? [a.docId] : [a.docId, b.docId];
    const res = await M.E.runOp(a.docId, 'imageCalculator', params, { docIds, posOf: posOfDocs(M, docIds) });
    const newId = res && res.newDocIds && res.newDocIds.length ? res.newDocIds[0] : null;
    if (newId === null) return null;
    const info = res.newInfos && res.newInfos[0] ? res.newInfos[0] : null;
    if (create) {
      if (M.batch) M.batchDocs.push(newId);
      if (info) await adopt(M, info);
      else { M.current = newId; M.P = null; }
      return null;
    }
    return calcInPlace(M, a.docId, newId, params);
  }
  /* ImageCalculator without "create": the result's planes go back into image 1 over the overlap (ImageCalculator blits image 2 at (0, 0)),
     the result image is closed. Shared by imageCalculator() and run("Image Calculator...", "…") without `create` (the page command made the
     result, the run reply names it: RunReply.inPlace). */
  async function calcInPlace(M, docA, newId, params) {
    const a = { docId: docA };
    const da = stackDims(M, a.docId);
    const planesA = da.nZ * da.nT;
    const dn = stackDims(M, newId);
    const list = [];
    const pa = M.E.getPosition(a.docId);
    const zs = params.slices === 'all' ? Array.from({ length: planesA }, (_, i) => i) : [pa.t * da.nZ + pa.z];
    const chans = da.rgb ? [0, 1, 2] : (params.all ? Array.from({ length: da.nC }, (_, i) => i) : [params.channel1]);
    for (const c of chans) {
      for (let k = 0; k < zs.length; k++) {
        const pi = zs[k], z = pi % da.nZ, t = (pi - z) / da.nZ;
        const src = M.E.plane(newId, da.rgb ? c : (params.all ? c : 0), params.slices === 'all' ? z : 0, params.slices === 'all' ? t : 0);
        const dst = M.E.plane(a.docId, c, z, t).slice();
        for (let y = 0; y < Math.min(dn.H, da.H); y++) for (let x = 0; x < Math.min(dn.W, da.W); x++) dst[y * da.W + x] = src[y * dn.W + x];
        list.push({ c, z, t, data: dst });
      }
    }
    if (list.length) { await M.E.commitPlanes(a.docId, list, { labelKey: 'op.macRun' }); M.changed.add(a.docId); }
    await M.rpc('image.close', { docIds: [newId] });
    M.current = a.docId;
    M.P = null;
    return null;
  }
  function posOfDocs(M, ids) {
    const o = {};
    for (const id of ids) { const p = M.E.getPosition(id); o[id] = { z: p.z, t: p.t }; }
    return o;
  }

  // ---------------------------------------------------------------- stacks
  function installStacks() {
    defSync('num', 'nSlices', '', (f, a, M) => stackSize(stackDims(M, img(f, M).docId)));
    defSync('num', 'getSliceNumber', '', (f, a, M) => {
      const im = img(f, M);
      const sd = stackDims(M, im.docId), p = M.E.getPosition(im.docId);
      return root.IJStack.stackIndex(sd, sd.rgb ? 0 : p.c, p.z, p.t);
    });
    // setSlice(n): "if (n==1 && nSlices==1) return; else if (n<1 || n>nSlices) error"
    defSync('do', 'setSlice', 'n', (f, a, M) => {
      const im = img(f, M);
      const sd = stackDims(M, im.docId), n = d2i(a[0]), size = stackSize(sd);
      if (n === 1 && size === 1) return null;
      if (n < 1 || n > size) { f.interp.error('Argument must be >=1 and <=' + size); return null; }
      const p = root.IJStack.position(sd, n);
      M.E.setPosition(im.docId, sd.rgb ? { z: p.z, t: p.t } : p);
      M.P = null;
      return null;
    });
    defSync('do', 'getDimensions', 'vvvvv', (f, a, M) => {
      const sd = stackDims(M, img(f, M).docId);
      a[0].setValue(sd.W); a[1].setValue(sd.H); a[2].setValue(sd.nC); a[3].setValue(sd.nZ); a[4].setValue(sd.nT);
      return null;
    });
    // getMetadata("Label" | "Info") / setMetadata
    LANG().define('str', 'getMetadata', function* (f) {
      const it = f.interp;
      const M = runOf(f);
      const im = img(f, M);
      let type;
      if (it.nextToken() === LP && it.nextNextToken() !== RP) type = (yield* f.getStringArg()).toLowerCase();
      else { it.getParens(); type = stackSize(stackDims(M, im.docId)) > 1 ? 'label' : 'info'; }
      return metadataGet(M, im, type);
    }, { suspends: false, sync(f) {
      const it = f.interp;
      const M = runOf(f);
      const im = img(f, M);
      let type;
      if (it.nextToken() === LP && it.nextNextToken() !== RP) type = f.getStringArg$s().toLowerCase();
      else { it.getParens(); type = stackSize(stackDims(M, im.docId)) > 1 ? 'label' : 'info'; }
      return metadataGet(M, im, type);
    } });
    defAsync('do', 'setMetadata', 's?s', async (f, a, M) => {
      const im = img(f, M);
      const size = stackSize(stackDims(M, im.docId));
      let metadata, isInfo = false;
      if (a.length === 1) {
        metadata = a[0];
        if (size === 1) isInfo = true;
        if (metadata.startsWith('Info:')) { metadata = metadata.substring(5); isInfo = true; }
      } else { metadata = a[1]; isInfo = a[0].startsWith('info') || a[0].startsWith('Info'); }
      if (metadata !== null && metadata.length === 0) metadata = null;
      if (isInfo) { M.infoProps.set(im.docId, metadata); return null; }
      if (typeof M.E.request !== 'function') throw macroError(M.tr('err.macNotInBrowser', { name: 'setMetadata' }));
      await M.commitAll();
      const sd = stackDims(M, im.docId), p = M.E.getPosition(im.docId);
      await M.E.request('doc.setLabel', { docId: im.docId, n: root.IJStack.stackIndex(sd, sd.rgb ? 0 : p.c, p.z, p.t), label: metadata });
      M.changed.add(im.docId);
      return null;
    });

    const pos3 = (f, M) => { const im = img(f, M); return { im, sd: stackDims(M, im.docId), p: M.E.getPosition(im.docId) }; };
    /* ImagePlus.setPosition(c, z, t): each clamped to 1..n */
    /* ImagePlus.setPosition: "if (channel<0) channel=0; … if (channel==0) channel=getC(); … if (channel>nChannels) channel=nChannels;" */
    const setPos = (M, im, sd, c, z, t) => {
      const p0 = M.E.getPosition(im.docId);
      const cl = (v, n, cur) => (v <= 0 ? cur + 1 : v > n ? n : v);
      const pos = { c: cl(c, sd.nC, sd.rgb ? 0 : p0.c) - 1, z: cl(z, sd.nZ, p0.z) - 1, t: cl(t, sd.nT, p0.t) - 1 };
      M.E.setPosition(im.docId, sd.rgb ? { z: pos.z, t: pos.t } : pos);
      M.P = null;
    };
    const needStack = (f, sd) => { if (stackSize(sd) === 1) f.interp.error('Stack required'); };
    const calSet = (fields) => (f, a, M) => setCalibration(f, M, fields(a, img(f, M)));
    defNamespace('num', 'Stack', {
      size: { sig: '', sync: (f, a, M) => stackSize(stackDims(M, img(f, M).docId)) },
      isHyperstack: { sig: '', sync: (f, a, M) => (isHyper(stackDims(M, img(f, M).docId)) ? 1 : 0) },
      isHyperStack: { sig: '', sync: (f, a, M) => (isHyper(stackDims(M, img(f, M).docId)) ? 1 : 0) },
      getDimensions: { sig: 'vvvvv', sync: (f, a, M) => { const sd = stackDims(M, img(f, M).docId); a[0].setValue(sd.W); a[1].setValue(sd.H); a[2].setValue(sd.nC); a[3].setValue(sd.nZ); a[4].setValue(sd.nT); return NaN; } },
      setPosition: { sig: 'nnn', sync: (f, a, M) => { const { im, sd } = pos3(f, M); setPos(M, im, sd, d2i(a[0]), d2i(a[1]), d2i(a[2])); return NaN; } },
      setChannel: { sig: 'n', sync: (f, a, M) => { const { im, sd, p } = pos3(f, M); setPos(M, im, sd, d2i(a[0]), p.z + 1, p.t + 1); return NaN; } },
      setSlice: { sig: 'n', sync: (f, a, M) => { const { im, sd, p } = pos3(f, M); setPos(M, im, sd, (sd.rgb ? 0 : p.c) + 1, d2i(a[0]), p.t + 1); return NaN; } },
      setFrame: { sig: 'n', sync: (f, a, M) => { const { im, sd, p } = pos3(f, M); setPos(M, im, sd, (sd.rgb ? 0 : p.c) + 1, p.z + 1, d2i(a[0])); return NaN; } },
      getPosition: { sig: 'vvv', sync: (f, a, M) => { const { sd, p } = pos3(f, M); a[0].setValue((sd.rgb ? 0 : p.c) + 1); a[1].setValue(p.z + 1); a[2].setValue(p.t + 1); return NaN; } },
      getFrameRate: { sig: '', sync: (f, a, M) => { const c = img(f, M).calibration || {}; return typeof c.fps === 'number' ? c.fps : 0; } },
      setFrameRate: { sig: 'n', async: calSet((a) => ({ fps: a[0] })) },
      getFrameInterval: { sig: '', sync: (f, a, M) => { const c = img(f, M).calibration || {}; return c.frameInterval || 0; } },
      setFrameInterval: { sig: 'n', async: calSet((a) => ({ frameInterval: a[0] })) },
      setTUnit: { sig: 's', async: calSet((a) => ({ timeUnit: a[0] })) },
      setXUnit: { sig: 's', async: calSet((a) => ({ unit: calUnit(a[0]) })) },
      setYUnit: { sig: 's', async: calSet((a) => ({ yUnit: a[0] })) },
      setZUnit: { sig: 's', async: calSet((a) => ({ zUnit: a[0] })) },
      setUnits: { sig: 'sssss', async: calSet((a) => ({ unit: calUnit(a[0]), yUnit: a[1], zUnit: a[2], timeUnit: a[3], valueUnit: a[4] })) },
      getUnits: { sig: 'vvvvv', sync: (f, a, M) => {
        const im = img(f, M), c = im.calibration || {}, x = unitsOf(im);
        a[0].setString(x); a[1].setString(c.yUnit || x); a[2].setString(c.zUnit || x); a[3].setString(c.timeUnit || 'sec'); a[4].setString(c.valueUnit || 'Gray Value');
        return NaN;
      } },
      getDisplayMode: { sig: 'v', sync: (f, a, M) => {
        const { im, sd } = pos3(f, M); needStack(f, sd);
        a[0].setString(sd.nC > 1 && !sd.rgb ? ({ composite: 'composite', color: 'color', gray: 'grayscale' }[im.mode] || 'composite') : '');
        return NaN;
      } },
      setDisplayMode: { sig: 's', sync: (f, a, M) => {
        const { im, sd } = pos3(f, M); needStack(f, sd);
        if (!(sd.nC > 1 && !sd.rgb)) f.interp.error('Composite image required');
        const m = a[0].toLowerCase(), mode = m === 'composite' ? 'composite' : m === 'color' ? 'color' : m.startsWith('gray') ? 'gray' : null;
        if (!mode) f.interp.error('Invalid mode');
        im.mode = mode;
        M.write('display.mode', { docId: im.docId, mode });
        return NaN;
      } },
      setActiveChannels: { sig: 's', sync: (f, a, M) => {
        const { im, sd } = pos3(f, M); needStack(f, sd);
        if (!(sd.nC > 1 && !sd.rgb)) return NaN;
        const v = Array.from({ length: sd.nC }, (_, i) => a[0].charAt(i) === '1');
        im.visible = v;
        M.write('display.visible', { docId: im.docId, visible: v });
        return NaN;
      } },
      getActiveChannels: { sig: 'v', sync: (f, a, M) => {
        const { im, sd } = pos3(f, M); needStack(f, sd);
        if (!(sd.nC > 1 && !sd.rgb)) f.interp.error('Composite image required');
        // CompositeImage.getActiveChannels is MAX_CHANNELS (8) long: the channels past the image's count read '0'
        const v = im.visible || [];
        let s = '';
        for (let i = 0; i < Math.max(8, sd.nC); i++) s += i < sd.nC ? (v[i] === false ? '0' : '1') : '0';
        a[0].setString(s);
        return NaN;
      } },
      toggleChannel: { sig: 'n', sync: (f, a, M) => {
        const { im, sd } = pos3(f, M); needStack(f, sd);
        if (!(sd.nC > 1 && !sd.rgb)) f.interp.error('Composite image required');
        const ch = d2i(a[0]);
        if (ch < 1 || ch > sd.nC) f.interp.error('Invalid channel: ' + ch);
        // "if (getMode()!=IJ.COMPOSITE) setMode(IJ.COMPOSITE)": entering the composite mode makes every channel active again
        const wasComposite = im.mode === 'composite';
        const v = Array.from({ length: sd.nC }, (_, i) => !wasComposite || !(im.visible && im.visible[i] === false));
        v[ch - 1] = !v[ch - 1];
        im.visible = v;
        if (!wasComposite) { im.mode = 'composite'; M.write('display.mode', { docId: im.docId, mode: 'composite' }); }
        M.write('display.visible', { docId: im.docId, visible: v });
        return NaN;
      } },
      setDimensions: { sig: 'nnn', sync: (f, a, M) => { const { sd } = pos3(f, M); needStack(f, sd); f.interp.error(M.tr('err.macNotInBrowser', { name: 'Stack.setDimensions' })); return NaN; } },
      swap: { sig: 'nn', sync: (f, a, M) => { const { sd } = pos3(f, M); needStack(f, sd); f.interp.error(M.tr('err.macNotInBrowser', { name: 'Stack.swap' })); return NaN; } },
      getStatistics: { sig: 'v?vvvvV', sync: (f, a, M) => { const { sd } = pos3(f, M); needStack(f, sd); stackStatistics(f, M, a); return NaN; } },
      startOrthoViews: { sig: '', sync: (f, a, M) => { f.interp.error(M.tr('err.macNotInBrowser', { name: 'Stack.startOrthoViews' })); return NaN; } },
      stopOrthoViews: { sig: '', sync: () => NaN },
      getOrthoViewsID: { sig: '', sync: () => 0 }
    }, 'Unrecognized Stack function');
  }
  function metadataGet(M, im, type) {
    if (type.indexOf('info') >= 0) { const v = M.infoProps.get(im.docId); return v === undefined || v === null ? '' : v; }
    const sd = stackDims(M, im.docId), p = M.E.getPosition(im.docId);
    const n = root.IJStack.stackIndex(sd, sd.rgb ? 0 : p.c, p.z, p.t);
    let label = null;
    try { label = M.E.getLabel(im.docId, n); } catch (_) { label = null; }
    return label === null || label === undefined ? '' : label;
  }
  /**
   * Stack.getStatistics (StackStatistics(imp), uncalibrated): 8-bit and RGB images sum the 256-bin histograms of every slice
   * (sum8BitHistograms), 16-bit images sum their full histograms and bin them in 256 over min..max (sum16BitHistograms,
   * "binSize = (histMax-histMin+1)/nBins"), 32-bit images take the min and max of every finite value, then 256 bins over that range
   * (doCalculations, "scale = nBins/(histMax-histMin)"). The selection masks every slice.
   */
  function stackStatistics(f, M, a) {
    const im = img(f, M);
    const sd = stackDims(M, im.docId);
    const size = stackSize(sd);
    const P0 = proc(f, M);
    const roi = selectionOf(M, im.docId);
    const reg = roiRegion(P0, isAreaRoi(roi) ? roi : null);
    const slices = [];
    for (let s = 1; s <= size; s++) {
      const p = root.IJStack.position(sd, s);
      const Q = { W: sd.W, H: sd.H, bd: sd.bd, rgb: sd.rgb, im };
      if (sd.rgb) { Q.r = M.plane(im.docId, 0, p.z, p.t); Q.g = M.plane(im.docId, 1, p.z, p.t); Q.b = M.plane(im.docId, 2, p.z, p.t); }
      else Q.data = M.plane(im.docId, p.c, p.z, p.t);
      slices.push(Q);
    }
    let n = 0, sum = 0, sum2 = 0, min, max;
    const hist = new Array(256).fill(0);
    if (sd.rgb || sd.bd === 8) {
      const h = new Float64Array(256);
      for (const Q of slices) { const st = planeStats(M, Q, reg.rect, reg.mask); for (let i = 0; i < 256; i++) h[i] += st.histogram[i]; }
      for (let i = 0; i < 256; i++) { const c = h[i]; n += c; sum += i * c; sum2 += i * i * c; hist[i] = c; }
      min = 0; while (min < 255 && h[min] === 0) min++;
      max = 255; while (max > 0 && h[max] === 0) max--;
    } else if (sd.bd === 16) {
      const h = new Float64Array(65536);
      for (const Q of slices) { const st = planeStats(M, Q, reg.rect, reg.mask); for (let i = 0; i < 65536; i++) h[i] += st.histogram16[i]; }
      min = 0; while (h[min] === 0 && min < 65535) min++;
      max = 65535; while (h[max] === 0 && max > 0) max--;
      const binSize = (max - min + 1) / 256, scale = 1.0 / binSize;
      for (let i = min; i <= max; i++) {
        const c = h[i];
        n += c; sum += i * c; sum2 += i * i * c;
        let idx = d2i(scale * (i - min));
        if (idx >= 256) idx = 255;
        hist[idx] += c;
      }
    } else {
      const FMAX = 3.4028234663852886e38, W = sd.W;
      const each = (Q, fn) => {
        const r = reg.rect;
        for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) if (!reg.mask || reg.mask[y * r.w + x]) fn(Q.data[(r.y + y) * W + r.x + x]);
      };
      let lo = Number.MAX_VALUE, hi = -Number.MAX_VALUE;
      for (const Q of slices) each(Q, (v) => { if (v >= -FMAX && v <= FMAX) { if (v < lo) lo = v; if (v > hi) hi = v; } });
      min = lo; max = hi;
      const scale = 256 / (max - min);
      for (const Q of slices) each(Q, (v) => {
        if (v >= -FMAX && v <= FMAX && v >= min && v <= max) {
          n++; sum += v; sum2 += v * v;
          let idx = d2i(scale * (v - min));
          if (idx >= 256) idx = 255;
          hist[idx]++;
        }
      });
    }
    const mean = sum / n;
    let std = 0;
    if (n > 0) { const v = (n * sum2 - sum * sum) / n; std = v > 0.0 ? Math.sqrt(v / (n - 1.0)) : 0.0; }
    a[0].setValue(n);
    if (a[1]) a[1].setValue(mean);
    if (a[2]) a[2].setValue(min);
    if (a[3]) a[3].setValue(max);
    if (a[4]) a[4].setValue(std);
    if (a[5]) a[5].setArray(hist.map((c) => Variable.num(c)));
  }

  // ---------------------------------------------------------------- page state
  function installPageState() {
    const IJMacro = LANG();
    // run(command[, options]) / doCommand
    IJMacro.define('do', 'run', function* (f) {
      const it = f.interp;
      it.getLeftParen();
      const name = yield* f.getString();
      it.getToken();
      if (!(it.token === RP || it.token === COMMA)) it.error("',' or ')'  expected");
      let options = null;
      if (it.token === COMMA) { options = yield* f.getString(); it.getRightParen(); }
      const M = runOf(f);
      yield* f.hostHook(() => runCommand(f, M, name, options));
      return null;
    }, { suspends: true });
    defAsync('do', 'doCommand', 's', (f, a, M) => runCommand(f, M, a[0], null));
    defAsync('do', 'invert', '', (f, a, M) => runCommand(f, M, 'Invert', null));
    defSync('do', 'setKeyDown', 's', (f, a, M) => {
      const s = a[0].toLowerCase();
      M.keys.alt = s.indexOf('alt') !== -1;
      M.keys.shift = s.indexOf('shift') !== -1;
      return null;
    });
    defSync('num', 'isKeyDown', 's', (f, a, M) => { const s = a[0].toLowerCase(); return (s.indexOf('alt') !== -1 ? M.keys.alt : s.indexOf('shift') !== -1 ? M.keys.shift : false) ? 1 : 0; });

    // images
    defSync('num', 'nImages', '', (f, a, M) => M.images.size);
    defSync('num', 'isOpen', 'x', (f, a, M) => {
      const x = a[0];
      if (typeof x === 'object') {
        for (const im of M.images.values()) if (im.title === x.s) return 1;
        for (const name of M.tables.keys()) if (name === x.s && (name !== 'Results' || M.tables.get(name).size > 0)) return 1;
        return x.s === 'Log' && logText(M.logLines) !== '' ? 1 : 0;
      }
      const id = d2i(x);
      for (const im of M.images.values()) if (im.id === id) return 1;
      return 0;
    });
    defSync('num', 'isActive', 'n', (f, a, M) => { const im = M.images.get(M.current); return im && im.id === d2i(a[0]) ? 1 : 0; });
    IJMacro.define('do', 'selectImage', function* (f) {
      const it = f.interp;
      it.getLeftParen();
      const M = runOf(f);
      let target = null;
      if (f.isStringArg()) {
        const title = yield* f.getString();
        for (const id of M.order) { const im = M.images.get(id); if (im && im.title === title) { target = im; break; } }
        if (!target) it.error('"' + title + '" not found');
        it.getRightParen();
      } else {
        const id = d2i(yield* it.getExpression());
        for (const im of M.images.values()) if (im.id === id) { target = im; break; }
        if (!target) it.error('Image ' + id + ' not found');
        it.getRightParen();
      }
      yield* f.hostHook(() => selectImageDoc(M, target.docId));
      return null;
    }, { suspends: true });
    defAsync('do', 'selectWindow', 's', async (f, a, M) => {
      const title = a[0];
      for (const id of M.order) { const im = M.images.get(id); if (im && im.title === title) { await selectImageDoc(M, im.docId); return null; } }
      const r = await M.rpc('window.select', { title });
      // IJ.selectWindow: error("Macro Error", …) then Macro.abort
      if (!r || !r.found) throw macroError('No window with the title "' + title + '" found.');
      if (M.tables.has(title)) M.currentTable = title;
      return null;
    });
    IJMacro.define('do', 'close', function* (f) {
      const it = f.interp;
      let pattern = null, keep = false;
      if (it.nextToken() === LP) {
        it.getLeftParen();
        if (it.nextToken() !== RP) pattern = yield* f.getString();
        if (it.nextToken() === COMMA) { it.getComma(); keep = (yield* f.getString()).toLowerCase() === 'keep'; }
        it.getRightParen();
      }
      const M = runOf(f);
      return yield* f.hostHook(() => closeImages(f, M, pattern, keep));
    }, { suspends: true });
    defAsync('do', 'rename', 's', async (f, a, M) => {
      const im = img(f, M);
      im.title = a[0];
      await M.rpc('image.rename', { docId: im.docId, title: a[0] });
      return null;
    });
    defAsync('do', 'setBatchMode', 'x', (f, a, M) => setBatchMode(f, M, a[0]));
    defSync('arr', 'getList', 's', (f, a, M) => {
      const key = a[0].toLowerCase();
      if (key === 'image.titles') return f.newVariableArray(M.order.map((id) => M.images.get(id)).filter(Boolean).map((im) => im.title));
      if (key === 'window.titles') {
        const out = [];
        for (const name of M.tables.keys()) if (name !== 'Results' || M.tables.get(name).size > 0) out.push(name);
        if (logText(M.logLines) !== '') out.push('Log');
        return f.newVariableArray(out);
      }
      if (key === 'threshold.methods') return f.newVariableArray(['Default', 'Huang', 'Intermodes', 'IsoData', 'IJ_IsoData', 'Li', 'MaxEntropy', 'Mean', 'MinError', 'Minimum', 'Moments', 'Otsu', 'Percentile', 'RenyiEntropy', 'Shanbhag', 'Triangle', 'Yen']);
      if (key === 'luts') return f.newVariableArray(['Grays', 'Red', 'Green', 'Blue', 'Cyan', 'Magenta', 'Yellow', 'Fire', 'Ice', 'Spectrum', '16 Colors', 'HiLo']);
      if (key === 'java.properties') return f.newVariableArray(Object.keys(VIRTUAL_PROPS).sort());
      f.interp.error('Unvalid key');
      return [];
    });
    defSync('num', 'is', 's', (f, a, M) => isFn(f, M, a[0].toLowerCase()) ? 1 : 0);
    defSync('num', 'screenWidth', '', (f, a, M) => (M.workspace && M.workspace.width) || 1024);
    defSync('num', 'screenHeight', '', (f, a, M) => (M.workspace && M.workspace.height) || 768);
    defSync('num', 'getZoom', '', (f, a, M) => { img(f, M); return 1; });
    defSync('do', 'setLocation', 'nn?nn', () => null);
    defSync('do', 'getLocationAndSize', 'vvvv', (f, a, M) => { const sd = stackDims(M, img(f, M).docId); a[0].setValue(0); a[1].setValue(0); a[2].setValue(sd.W); a[3].setValue(sd.H); return null; });
    defSync('do', 'getDisplayedArea', 'vvvv', (f, a, M) => { const sd = stackDims(M, img(f, M).docId); a[0].setValue(0); a[1].setValue(0); a[2].setValue(sd.W); a[3].setValue(sd.H); return null; });
    defSync('do', 'getCursorLoc', 'vvvv', (f, a, M) => { const im = img(f, M); const sd = stackDims(M, im.docId), p = M.E.getPosition(im.docId); a[0].setValue(0); a[1].setValue(0); a[2].setValue(root.IJStack.stackIndex(sd, sd.rgb ? 0 : p.c, p.z, p.t) - 1); a[3].setValue(0); return null; });
    defSync('do', 'beep', '', () => null);
    defSync('do', 'setPasteMode', 's', () => null);
    defSync('do', 'saveSettings', '', () => null);
    defSync('do', 'restoreSettings', '', () => null);
    defSync('do', 'restorePreviousTool', '', () => null);
    defSync('do', 'setJustification', 's', () => null);
    // text is not drawn into pixels in the browser (drawString is refused): the font has nothing to apply to
    defSync('do', 'setFont', 's?ns', () => null);
    defRefused('num', 'getStringWidth', 's', (M) => M.tr('err.macNotInBrowser', { name: 'getStringWidth' }));
    defSync('arr', 'getFontList', '', (f) => f.newVariableArray(['SansSerif', 'Serif', 'Monospaced']));
    defSync('do', 'getDateAndTime', 'vvvvvvvv', (f, a) => {
      const d = new Date();
      a[0].setValue(d.getFullYear()); a[1].setValue(d.getMonth()); a[2].setValue(d.getDay()); a[3].setValue(d.getDate());
      a[4].setValue(d.getHours()); a[5].setValue(d.getMinutes()); a[6].setValue(d.getSeconds()); a[7].setValue(d.getMilliseconds());
      return null;
    });
    defSync('do', 'showStatus', 's?s', (f, a, M) => { let s = a[0]; if (s.startsWith('!')) s = s.substring(1); M.write('status.show', { text: s }); return null; });
    defSync('do', 'showProgress', 'n?n', (f, a, M) => { const fr = a.length === 2 ? (a[0] + 1.0) / a[1] : a[0]; M.write('progress.show', { fraction: fr }); return null; });
    IJMacro.define('str', 'getInfo', function* (f) {
      const it = f.interp;
      const M = runOf(f);
      const STRING_CONSTANT = K.STRING_CONSTANT;
      if (it.nextNextToken() === STRING_CONSTANT || (it.nextToken() === LP && it.nextNextToken() !== RP)) return getInfoKey(f, M, yield* f.getStringArg());
      it.getParens();
      f.interp.error(M.tr('err.macNotInBrowser', { name: 'getInfo()' }));
      return '';
    }, { suspends: false, sync(f) {
      const it = f.interp;
      const M = runOf(f);
      if (it.nextNextToken() === K.STRING_CONSTANT || (it.nextToken() === LP && it.nextNextToken() !== RP)) return getInfoKey(f, M, f.getStringArg$s());
      it.getParens();
      f.interp.error(M.tr('err.macNotInBrowser', { name: 'getInfo()' }));
      return '';
    } });
    defRefused('str', 'getImageInfo', '', (M) => M.tr('err.macNotInBrowser', { name: 'getImageInfo' }));

    // selections
    defSync('do', 'makeRectangle', 'nnnn?n', (f, a, M) => {
      const im = img(f, M);
      if (a.length > 4 && d2i(a[4]) >= 1) f.interp.error(M.tr('err.macNotInBrowser', { name: 'makeRectangle(…, arcSize)' }));
      const [x, y, w, h] = a;
      // IJ.makeRectangle: "if (width<=0 || height<0) img.deleteRoi(); else img.setRoi(new Roi(x, y, width, height))"
      setSelection(M, im.docId, w <= 0 || h < 0 ? null : { type: 'rect', x, y, w, h });
      return null;
    });
    defSync('do', 'makeOval', 'nnnn', (f, a, M) => {
      const im = img(f, M);
      const [x, y, w, h] = a;
      setSelection(M, im.docId, w <= 0 || h < 0 ? null : { type: 'oval', x, y, w, h });
      return null;
    });
    IJMacro.define('do', 'makeLine', function* (f) { return makeLineParse(f, yield* readNumberList(f)); }, { suspends: false, sync: (f) => makeLineParse(f, readNumberList$s(f)) });
    IJMacro.define('do', 'makePolygon', function* (f) { return makePolygonParse(f, yield* readNumberList(f)); }, { suspends: false, sync: (f) => makePolygonParse(f, readNumberList$s(f)) });
    defSync('do', 'makePoint', 'nn?s', (f, a, M) => { const im = img(f, M); setSelection(M, im.docId, { type: 'point', points: [[a[0], a[1]]] }); return null; });
    IJMacro.define('do', 'makeSelection', function* (f) {
      const it = f.interp;
      it.getLeftParen();
      const type = f.isStringArg() ? { s: yield* f.getString() } : yield* it.getExpression();
      it.getComma(); const xs = yield* f.getNumericArray();
      it.getComma(); const ys = yield* f.getNumericArray();
      let n = null;
      if (it.nextToken() === COMMA) { it.getComma(); n = d2i(yield* it.getExpression()); }
      it.getRightParen();
      return makeSelection(f, runOf(f), type, xs, ys, n);
    }, { suspends: false, sync(f) {
      const it = f.interp;
      it.getLeftParen();
      const type = f.isStringArg() ? { s: f.getString$s() } : it.getExpression$s();
      it.getComma(); const xs = f.getNumericArray$s();
      it.getComma(); const ys = f.getNumericArray$s();
      let n = null;
      if (it.nextToken() === COMMA) { it.getComma(); n = d2i(it.getExpression$s()); }
      it.getRightParen();
      return makeSelection(f, runOf(f), type, xs, ys, n);
    } });
    defRefused('do', 'makeArrow', 'nnnn?s', (M) => M.tr('err.macArrow'));
    defRefused('do', 'makeEllipse', 'nnnnn', (M) => M.tr('err.macNotInBrowser', { name: 'makeEllipse' }));
    defRefused('do', 'makeRotatedRectangle', 'nnnnn', (M) => M.tr('err.macNotInBrowser', { name: 'makeRotatedRectangle' }));
    defRefused('do', 'makeText', 'snn', (M) => M.tr('err.macNotInBrowser', { name: 'makeText' }));
    defRefused('do', 'drawString', 'snn?s', (M) => M.tr('err.macNotInBrowser', { name: 'drawString' }));
    defSync('num', 'selectionType', '', (f, a, M) => {
      if (!M.images.size) return -1;
      const im = img(f, M);
      return roiType(selectionOf(M, im.docId));
    });
    defSync('do', 'getSelectionBounds', 'vvvv', (f, a, M) => boundsOut(f, M, a));
    defSync('do', 'getBoundingRect', 'vvvv', (f, a, M) => boundsOut(f, M, a));
    defSync('do', 'getSelectionCoordinates', 'VV', (f, a, M) => {
      const im = img(f, M);
      const roi = selectionOf(M, im.docId);
      if (!roi) f.interp.error('Selection required');
      const v = vertices(f, M, roi);
      a[0].setArray(v.xs.map((x) => Variable.num(x)));
      a[1].setArray(v.ys.map((y) => Variable.num(y)));
      return null;
    });
    defSync('do', 'getLine', 'vvvvv', (f, a, M) => {
      const im = img(f, M);
      const roi = selectionOf(M, im.docId);
      let x1 = -1, y1 = -1, x2 = -1, y2 = -1;
      if (roi && roi.type === 'line') { x1 = roi.x1; y1 = roi.y1; x2 = roi.x2; y2 = roi.y2; }
      a[0].setValue(x1); a[1].setValue(y1); a[2].setValue(x2); a[3].setValue(y2);
      a[4].setValue(roi ? (roi.width > 0 ? roi.width : 0) : 1);
      return null;
    });
    defSync('do', 'setSelectionName', 's', (f, a, M) => {
      const im = img(f, M);
      const roi = selectionOf(M, im.docId);
      if (!roi) { f.interp.error('No selection'); return null; }
      setSelection(M, im.docId, Object.assign({}, roi, { name: a[0] }));
      return null;
    });
    // Functions.selectionName reads no parentheses: selectionName() is ImageJ's "')' expected"
    defSync('str', 'selectionName', null, (f, a, M) => {
      const im = img(f, M);
      const roi = selectionOf(M, im.docId);
      if (!roi) f.interp.error('No selection');
      return roi && typeof roi.name === 'string' ? roi.name : '';
    });
    defSync('do', 'setSelectionLocation', 'nn', (f, a, M) => {
      const im = img(f, M);
      const roi = selectionOf(M, im.docId);
      if (!roi) { f.interp.error('Selection required'); return null; }
      const b = roiBounds(roi);
      setSelection(M, im.docId, root.IJRoi.translate(roi, jround(a[0]) - b.x, jround(a[1]) - b.y));
      return null;
    });
    defSync('num', 'selectionContains', 'nn', (f, a, M) => {
      const im = img(f, M);
      const roi = selectionOf(M, im.docId);
      if (!roi) f.interp.error('Selection required');
      const x = jround(a[0]), y = jround(a[1]);
      if (roi.type === 'point') return roi.points.some((p) => d2i(p[0]) === x && d2i(p[1]) === y) ? 1 : 0;
      if (!isAreaRoi(roi)) return 0;
      const m = root.IJRoi.mask(roi, x + 1, y + 1);
      const i = x - m.x, j = y - m.y;
      return i >= 0 && j >= 0 && i < m.w && j < m.h && m.data[j * m.w + i] ? 1 : 0;
    });

    // thresholds
    defSync('do', 'setThreshold', 'nn?s', (f, a, M) => {
      const im = img(f, M);
      const sd = stackDims(M, im.docId);
      if (sd.rgb) return null;   // ImageProcessor.setThreshold: "if (this instanceof ColorProcessor) return;"
      const c = M.E.getPosition(im.docId).c;
      let lower = a[0], upper = a[1];
      // ShortProcessor.setThreshold: clamped to 0..65535 then Math.round; ByteProcessor: clamped to 0..255; FloatProcessor: as given
      if (sd.bd === 16) { if (lower < 0) lower = 0; if (upper > 65535) upper = 65535; lower = jround(lower); upper = jround(upper); }
      else if (sd.bd === 8) { if (lower < 0) lower = 0; if (upper > 255) upper = 255; }
      const mode = a.length > 2 ? String(a[2]).toLowerCase() : null;
      if (!M.thresholds[im.docId]) M.thresholds[im.docId] = {};
      const dark = !!(M.settings['thr.blackBackground']);
      M.thresholds[im.docId][c] = { lower, upper, dark };
      M.write('thr.set', { docId: im.docId, c, lower, upper, dark });
      if (mode) {
        const m = mode.indexOf('black') >= 0 ? 'bw' : mode.indexOf('over') >= 0 ? 'overunder' : mode.indexOf('no') >= 0 ? null : 'red';
        if (m) M.write('thr.mode', { mode: m });
      }
      return null;
    });
    defSync('do', 'getThreshold', 'vv', (f, a, M) => {
      const im = img(f, M);
      const c = M.E.getPosition(im.docId).c;
      const e = thresholdOf(M, im.docId, c);
      a[0].setValue(e ? e.lower : -1); a[1].setValue(e ? e.upper : -1);
      return null;
    });
    defSync('do', 'resetThreshold', '', (f, a, M) => {
      const im = img(f, M);
      const c = M.E.getPosition(im.docId).c;
      if (M.thresholds[im.docId]) delete M.thresholds[im.docId][c];
      M.write('thr.reset', { docId: im.docId, c });
      return null;
    });
    IJMacro.define('do', 'setAutoThreshold', function* (f) {
      const it = f.interp;
      let method = null;
      if (it.nextToken() === LP) {
        it.getLeftParen();
        if (f.isStringArg()) method = yield* f.getString();
        it.getRightParen();
      }
      const M = runOf(f);
      return yield* f.hostHook(() => autoThreshold(f, M, method));
    }, { suspends: true });

    // Results
    defSync('num', 'nResults', '', (f, a, M) => { const t = M.tables.get('Results'); return t ? t.size : 0; });
    defSync('num', 'getResultsCount', '', (f, a, M) => { const t = M.tables.get('Results'); return t ? t.size : 0; });
    defSync('num', 'getResult', 's?ns', (f, a, M) => getResult(f, M, a[0], a.length > 1 ? d2i(a[1]) : -1, a.length > 2 ? a[2] : null, true));
    defSync('str', 'getResultString', 's?ns', (f, a, M) => getResultString(f, M, a[0], a.length > 1 ? d2i(a[1]) : -1, a.length > 2 ? a[2] : null));
    defSync('str', 'getResultLabel', 'n', (f, a, M) => {
      const t = resultsTable(f, M, true);
      const row = d2i(a[0]);
      if (row < 0 || row >= t.size) f.interp.error('Row (' + row + ') out of range');
      const l = t.labels ? t.labels[row] : null;
      return l !== null && l !== undefined ? l : '';
    });
    IJMacro.define('do', 'setResult', function* (f) { return setResultParse(f, null, yield* readSetResult(f)); }, { suspends: false, sync: (f) => setResultParse(f, null, readSetResult$s(f)) });
    defSync('do', 'updateResults', '', (f, a, M) => {
      // ResultsTable.show: the table goes to the page with the next flush, not at the once-a-second pace of the coalesced writes
      const t = M.tables.get('Results') || emptyTable('Results');
      M.tables.set('Results', t);
      M.dirtyTables.delete('Results');
      M.queue.push(['table.replace', { name: 'Results', table: cloneTable(t) }]);
      M.write('table.show', { name: 'Results' });
      return null;
    });

    // Table.*
    defNamespace('variable', 'Table', tableMembers(), 'Unrecognized function name', (v) => (v === null || v === undefined ? null : (v instanceof Variable ? v : (typeof v === 'string' ? Variable.string(v) : Variable.num(v)))));

    // ROI Manager
    defAsync('num', 'roiManager', 's?xx', (f, a, M) => roiManager(f, M, a));
    defNamespace('variable', 'RoiManager', roiManagerMembers(), 'Unrecognized RoiManager function', (v) => (v === null || v === undefined ? null : (v instanceof Variable ? v : (typeof v === 'string' ? Variable.string(v) : Variable.num(v)))));
    defNamespace('variable', 'Roi', roiMembers(), 'Unrecognized Roi function', (v) => (v === null || v === undefined ? null : (v instanceof Variable ? v : (typeof v === 'string' ? Variable.string(v) : Variable.num(v)))));

    // dialogs
    defAsync('num', 'getNumber', 'sn', async (f, a, M) => {
      const r = await M.rpc('dialog.number', { title: dialogTitle(f), prompt: a[0], value: a[1] });
      if (!r || r.cancelled) { f.interp.done = true; return a[1]; }
      return typeof r.value === 'number' && r.value === r.value ? r.value : a[1];
    });
    defAsync('str', 'getString', 'ss', async (f, a, M) => {
      const r = await M.rpc('dialog.string', { title: dialogTitle(f), prompt: a[0], value: a[1] });
      if (!r || r.cancelled) { f.interp.done = true; return ''; }
      return typeof r.value === 'string' ? r.value : '';
    });
    defAsync('num', 'getBoolean', 's?ss', async (f, a, M) => {
      const r = await M.rpc('dialog.boolean', { title: dialogTitle(f), message: a[0], yes: a.length > 1 ? a[1] : '  Yes  ', no: a.length > 2 ? a[2] : '  No  ' });
      if (!r || r.cancelled) { f.interp.done = true; return 0; }
      return r.value ? 1 : 0;
    });
    defAsync('do', 'showMessageWithCancel', 's?s', async (f, a, M) => {
      const title = a.length > 1 ? a[0] : '', text = a.length > 1 ? a[1] : a[0];
      const r = await M.rpc('dialog.messageCancel', { title, text });
      if (!r || !r.ok) throw new MacroCancel('abort');
      return null;
    });
    IJMacro.define('do', 'waitForUser', function* (f) {
      const it = f.interp;
      let title = 'Action Required', text = '   Click "OK" to continue     ';
      if (it.nextToken() === LP) {
        title = yield* f.getFirstString();
        if (it.nextToken() === COMMA) text = yield* f.getLastString();
        else { text = title; title = 'Action Required'; it.getRightParen(); }
      }
      const M = runOf(f);
      return yield* f.hostHook(() => M.rpc('dialog.waitForUser', { title, text }).then((r) => { if (!r || !r.ok) throw new MacroCancel('abort'); return null; }));
    }, { suspends: true });
    defNamespace('str', 'Dialog', dialogMembers(), (name) => 'Unrecognized Dialog function ' + name);

    // tools
    IJMacro.define('do', 'setTool', function* (f) {
      const it = f.interp;
      it.getLeftParen();
      const x = f.isStringArg() ? { s: yield* f.getString() } : yield* it.getExpression();
      it.getRightParen();
      return setTool(f, runOf(f), x);
    }, { suspends: false, sync(f) {
      const it = f.interp;
      it.getLeftParen();
      const x = f.isStringArg() ? { s: f.getString$s() } : it.getExpression$s();
      it.getRightParen();
      return setTool(f, runOf(f), x);
    } });
    defSync('num', 'toolID', '', (f, a, M) => { const i = TOOL_IDS.indexOf(M.tool); return i < 0 ? 0 : i; });

    // LUTs
    defSync('do', 'getLut', 'VVV', (f, a, M) => {
      const P = proc(f, M);
      if (P.rgb) f.interp.error('Non-RGB image expected');
      const t = lutTable(M, P);
      const pick = (o) => Array.from({ length: 256 }, (_, i) => Variable.num(t[i * 3 + o]));
      a[0].setArray(pick(0)); a[1].setArray(pick(1)); a[2].setArray(pick(2));
      return null;
    });
    defSync('do', 'setLut', 'aaa', (f, a, M) => {
      const [r, g, b] = a;
      if (g.length !== r.length || b.length !== r.length) f.interp.error('Arrays are not the same length');
      const P = proc(f, M);
      if (P.rgb) f.interp.error('Non-RGB image expected');
      if (r.length !== 256) f.interp.error(M.tr('err.macNotInBrowser', { name: 'setLut (a table of ' + r.length + ' entries)' }));
      const table = new Array(768);
      for (let i = 0; i < 256; i++) { table[i * 3] = d2i(r[i]) & 0xff; table[i * 3 + 1] = d2i(g[i]) & 0xff; table[i * 3 + 2] = d2i(b[i]) & 0xff; }
      if (!P.im.display) P.im.display = [];
      P.im.display[P.c] = Object.assign({}, P.im.display[P.c] || {}, { lut: table, invert: false });
      M.write('display.lut', { docId: P.docId, c: P.c, table });
      M.P = null;
      return null;
    });
    defAsync('do', 'showText', 's?s', (f, a, M) => M.rpc('window.print', { title: a.length > 1 ? a[0] : 'Untitled', text: a.length > 1 ? a[1] : a[0] }).then(() => null));
    defSync('arr', 'newMenu', 'sS', (f, a) => f.newVariableArray(a[1]));
  }

  // ---- number lists (makeLine / makePolygon parse their own comma lists) ----
  function* readNumberList(f) {
    const it = f.interp;
    it.getLeftParen();
    const out = [yield* it.getExpression()];
    for (;;) {
      it.getToken();
      if (it.token !== COMMA) { if (it.token !== RP) it.error("')' expected"); break; }
      out.push(yield* it.getExpression());
    }
    return out;
  }
  function readNumberList$s(f) {
    const it = f.interp;
    it.getLeftParen();
    const out = [it.getExpression$s()];
    for (;;) {
      it.getToken();
      if (it.token !== COMMA) { if (it.token !== RP) it.error("')' expected"); break; }
      out.push(it.getExpression$s());
    }
    return out;
  }
  /* makeLine(x1, y1, x2, y2[, lineWidth]) / (x1, y1, …, xn, yn): Functions.makeLine */
  function makeLineParse(f, v) {
    const M = runOf(f);
    if (v.length < 4) f.interp.error("',' expected");
    const im = img(f, M);
    if (v.length === 4) { setSelection(M, im.docId, { type: 'line', x1: v[0], y1: v[1], x2: v[2], y2: v[3] }); return null; }
    if (v.length === 5) { setSelection(M, im.docId, { type: 'line', x1: v[0], y1: v[1], x2: v[2], y2: v[3], width: jround(v[4]) }); return null; }
    if (v.length % 2 === 1) f.interp.error("',' expected");
    const pts = [];
    for (let i = 0; i < v.length; i += 2) pts.push([jround(v[i]), jround(v[i + 1])]);
    setSelection(M, im.docId, { type: 'polyline', points: pts });
    return null;
  }
  function makePolygonParse(f, v) {
    const M = runOf(f);
    if (v.length % 2 === 1) f.interp.error("',' expected");
    const pts = [];
    for (let i = 0; i < v.length; i += 2) pts.push([jround(v[i]), jround(v[i + 1])]);
    if (pts.length < 3) f.interp.error('Fewer than 3 points');
    const im = img(f, M);
    setSelection(M, im.docId, { type: 'polygon', points: pts });
    return null;
  }
  /* makeSelection(type, x, y[, n]): Functions.makeSelection */
  function makeSelection(f, M, type, xs, ys, nArg) {
    let roiType, typeName = null;
    if (typeof type === 'object') {
      typeName = type.s.toLowerCase();
      roiType = 2;
      if (typeName.indexOf('free') >= 0) roiType = 3;
      if (typeName.indexOf('traced') >= 0) roiType = 4;
      if (typeName.indexOf('line') >= 0) roiType = typeName.indexOf('free') >= 0 ? 7 : 6;
      if (typeName.indexOf('angle') >= 0) roiType = 8;
      if (typeName.indexOf('point') >= 0 || typeName.indexOf('cross') >= 0 || typeName.indexOf('circle') >= 0 || typeName.indexOf('dot') >= 0) roiType = 10;
    } else {
      roiType = d2i(type);
      if (roiType < 0 || roiType === 9) f.interp.error('Invalid selection type (' + roiType + ')');
      if (roiType === 0) roiType = 2;
      if (roiType === 1) roiType = 3;
    }
    let n = xs.length;
    if (nArg !== null) { n = nArg; if (n > xs.length || n > ys.length) f.interp.error('Array too short'); }
    else if (ys.length !== n) f.interp.error('Arrays are not the same length');
    const im = img(f, M);
    const floatC = xs.slice(0, n).some((x, i) => x !== d2i(x) || ys[i] !== d2i(ys[i]));
    const pt = (i) => (floatC ? [Math.fround(xs[i]), Math.fround(ys[i])] : [jround(xs[i]), jround(ys[i])]);
    const pts = Array.from({ length: n }, (_, i) => pt(i));
    let roi;
    if (roiType === 5) {
      if (n !== 2) f.interp.error('2 element arrays expected');
      roi = { type: 'line', x1: pts[0][0], y1: pts[0][1], x2: pts[1][0], y2: pts[1][1] };
    } else if (roiType === 10) roi = { type: 'point', points: pts };
    else if (roiType === 6 || roiType === 7) roi = { type: 'polyline', points: pts };
    else if (roiType === 8) roi = { type: 'angle', points: pts };
    else roi = { type: roiType === 3 ? 'freehand' : 'polygon', points: pts };
    if (roiType === 4 || roiType === 7) roi.ijType = roiType;
    try { root.IJRoi.validate(roi); } catch (_) { f.interp.error('Invalid selection'); }
    setSelection(M, im.docId, roi);
    return null;
  }
  function boundsOut(f, M, a) {
    const im = img(f, M);
    const roi = selectionOf(M, im.docId);
    if (roi) { const b = roiBounds(roi); a[0].setValue(b.x); a[1].setValue(b.y); a[2].setValue(b.w); a[3].setValue(b.h); }
    else { const sd = stackDims(M, im.docId); a[0].setValue(0); a[1].setValue(0); a[2].setValue(sd.W); a[3].setValue(sd.H); }
    return null;
  }
  /* Roi.getFloatPolygon (getSelectionCoordinates): a line its two ends, a rectangle its corners, an oval the flattened ellipse. */
  function vertices(f, M, roi) {
    if (roi.type === 'line') return { xs: [roi.x1, roi.x2], ys: [roi.y1, roi.y2] };
    const T = root.IJRoiTools;
    if (T && typeof T.roiVertices === 'function') {
      const v = T.roiVertices(roi);
      if (v && Array.isArray(v.xs)) return { xs: Array.from(v.xs), ys: Array.from(v.ys) };
      if (Array.isArray(v)) return { xs: v.map((p) => p[0]), ys: v.map((p) => p[1]) };
    }
    if (roi.type === 'rect') return { xs: [roi.x, roi.x + roi.w, roi.x + roi.w, roi.x], ys: [roi.y, roi.y, roi.y + roi.h, roi.y + roi.h] };
    if (roi.points) return { xs: roi.points.map((p) => p[0]), ys: roi.points.map((p) => p[1]) };
    f.interp.error(M.tr('err.macNotInBrowser', { name: 'getSelectionCoordinates' }));
    return { xs: [], ys: [] };
  }

  /* close() / close(pattern[, "keep"]) (Functions.close) */
  async function closeImages(f, M, pattern, keep) {
    if (pattern === null) {
      const im = img(f, M);
      await M.commitAll();
      const r = await M.rpc('image.close', { docIds: [im.docId] });
      for (const id of (r && r.closed) || []) { M.images.delete(id); M.order = M.order.filter((x) => x !== id); }
      M.P = null;
      return null;
    }
    const lc = pattern.toLowerCase();
    const others = pattern === '\\Others';
    const wild = pattern.indexOf('*') >= 0 || pattern.indexOf('?') >= 0;
    // "if (!hasWildcard || isTextPattern)": a wildcard pattern closes no tool window unless it names a text file
    const textPattern = ['.txt', '.ijm', '.js', '.java', '.py', '.bs', '.csv', '.tsv'].some((e) => pattern.endsWith(e));
    if (!others && (!wild || textPattern)) {
      if (pattern === 'Results') { M.tables.set('Results', emptyTable('Results')); M.dirtyTables.delete('Results'); }
      const windowNames = ['Log', 'ROI Manager', 'Threshold', 'B&C', 'Results'].concat(Array.from(M.tables.keys()));
      const done = new Set();
      for (const w of windowNames) {
        if (done.has(w)) continue;
        const match = wild ? wildMatch(w, pattern) : (w.toLowerCase() === lc);
        if (!match) continue;
        done.add(w);
        await M.rpc('window.close', { title: w });
        if (M.tables.has(w) && w !== 'Results') M.tables.delete(w);
        if (w === 'Log') M.logLines = [];
      }
    }
    const front = M.current;
    const kill = [];
    for (const id of M.order) {
      const im = M.images.get(id);
      if (!im) continue;
      const match = others ? id !== front : wildMatch(im.title, pattern);
      if (match && !(im.changes && keep)) kill.push(id);
    }
    if (kill.length) {
      await M.commitAll();
      const r = await M.rpc('image.close', { docIds: kill });
      for (const id of (r && r.closed) || []) { M.images.delete(id); M.order = M.order.filter((x) => x !== id); }
    }
    M.P = null;
    return null;
  }
  /* ij.util.WildcardMatch, case-insensitive: '*' any run, '?' one character. */
  function wildMatch(s, p) {
    const rx = new RegExp('^' + String(p).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');
    return rx.test(String(s));
  }
  /* setBatchMode(true | false | "show" | "hide" | "exit and display") (Functions.setBatchMode) */
  async function setBatchMode(f, M, arg) {
    if (typeof arg !== 'object') {
      const on = arg !== 0;
      if (on) {
        if (M.batch) return null;
        M.batch = true;
        if (M.E.macroGroup && typeof M.E.macroGroup.setBatch === 'function') M.E.macroGroup.setBatch(M.runId, true);
        return null;
      }
      const cur = M.current;
      M.batch = false;
      if (M.E.macroGroup && typeof M.E.macroGroup.setBatch === 'function') M.E.macroGroup.setBatch(M.runId, false);
      // "interp.setBatchMode(false); displayBatchModeImage(imp2)": the current image is shown, the other batch images are dropped
      if (cur !== null && M.images.has(cur) && M.images.get(cur).hidden) await M.rpc('image.show', { docIds: [cur] });
      M.batchDocs = [];
      return null;
    }
    const s = arg.s.toLowerCase();
    const cur = M.current;
    if (s === 'show') {
      if (cur !== null && M.images.has(cur)) { await M.rpc('image.show', { docIds: [cur] }); M.batchDocs = M.batchDocs.filter((x) => x !== cur); }
      return null;
    }
    if (s === 'hide') {
      M.batch = true;
      if (M.E.macroGroup && typeof M.E.macroGroup.setBatch === 'function') M.E.macroGroup.setBatch(M.runId, true);
      return null;
    }
    // "exit and display" (any other string): every batch image is displayed, the current one last
    M.batch = false;
    if (M.E.macroGroup && typeof M.E.macroGroup.setBatch === 'function') M.E.macroGroup.setBatch(M.runId, false);
    const show = [];
    for (const id of M.order) { const im = M.images.get(id); if (im && im.hidden && id !== cur) show.push(id); }
    if (cur !== null && M.images.has(cur) && M.images.get(cur).hidden) show.push(cur);
    if (show.length) await M.rpc('image.show', { docIds: show });
    M.batchDocs = [];
    return null;
  }
  /* is(key) (Functions.is) */
  function isFn(f, M, arg) {
    if (arg === 'locked') { img(f, M); return false; }
    if (arg.indexOf('invert') >= 0 && arg.indexOf('lut') >= 0) { const P = proc(f, M); const d = (P.im.display && P.im.display[P.c]) || {}; return !!d.invert; }
    if (arg.indexOf('hyper') >= 0) return isHyper(stackDims(M, img(f, M).docId));
    if (arg.indexOf('batch') >= 0) return M.batch;
    if (arg.indexOf('applet') >= 0) return false;
    if (arg.indexOf('virtual') >= 0) { img(f, M); return false; }
    if (arg.indexOf('composite') >= 0) { const sd = stackDims(M, img(f, M).docId); return sd.nC > 1 && !sd.rgb; }
    if (arg.indexOf('caps') >= 0) return false;
    if (arg.indexOf('change') >= 0) return !!img(f, M).changes;
    if (arg.indexOf('binary') >= 0) {
      const P = proc(f, M);
      if (P.rgb || P.bd !== 8) return false;
      for (let i = 0; i < P.data.length; i++) { const v = P.data[i]; if (v !== 0 && v !== 255) return false; }
      return true;
    }
    if (arg.indexOf('grayscale') >= 0) {
      const P = proc(f, M);
      if (P.rgb) { for (let i = 0; i < P.r.length; i++) if (P.r[i] !== P.g[i] || P.g[i] !== P.b[i]) return false; return true; }
      const t = displayTable(M, P);
      for (let i = 0; i < 256; i++) if (t[i * 3] !== i || t[i * 3 + 1] !== i || t[i * 3 + 2] !== i) return false;
      return true;
    }
    if (arg.startsWith('global')) return false;
    if (arg.indexOf('animated') >= 0) { img(f, M); return false; }
    if (arg === 'inverty') return (M.measurements.groups || []).indexOf('invertY') >= 0;
    if (arg.startsWith('area')) return isAreaRoi(selectionOf(M, img(f, M).docId));
    if (arg.startsWith('line')) return isLineRoi(selectionOf(M, img(f, M).docId));
    if (arg.startsWith('fft')) { img(f, M); return false; }
    f.interp.error('Invalid argument');
    return false;
  }
  /* The fixed property set getInfo("…") answers for a Java system property: never the real machine. */
  const VIRTUAL_PROPS = Object.freeze({
    'file.separator': '/', 'path.separator': ':', 'line.separator': '\n', 'os.name': 'Browser', 'os.arch': '', 'os.version': '',
    'user.home': '/home', 'user.dir': '/home', 'user.name': 'user', 'java.version': '1.8.0', 'java.vendor': 'Browser',
    'java.home': '/imagej/java', 'user.language': 'en'
  });
  function getInfoKey(f, M, key) {
    const lk = key.toLowerCase();
    if (lk === 'command.name') return '';
    if (lk === 'overlay') { img(f, M); return ''; }
    if (lk === 'log') return logText(M.logLines);
    if (key.indexOf('.') === -1) { img(f, M); return ''; }
    if (lk === 'micrometer.abbreviation') return 'µm';
    if (lk === 'image.title') return img(f, M).title;
    if (lk === 'image.subtitle') return '';
    if (lk === 'slice.label') {
      const im = img(f, M);
      return metadataGet(M, im, 'label');
    }
    if (lk === 'window.contents') { f.interp.error(M.tr('err.macNotInBrowser', { name: 'getInfo("window.contents")' })); return ''; }
    if (lk === 'image.description' || lk === 'image.filename' || lk === 'image.directory') { img(f, M); return ''; }
    if (lk === 'selection.name' || lk === 'roi.name') { const roi = selectionOf(M, img(f, M).docId); return roi && typeof roi.name === 'string' ? roi.name : ''; }
    if (lk === 'selection.color' || lk === 'roi.color') {
      const roi = selectionOf(M, img(f, M).docId);
      if (!roi) f.interp.error('No selection');
      const c = roi.stroke || M.colors.selection || [255, 255, 0];
      return Array.isArray(c) ? colorName(c) : String(c);
    }
    if (lk === 'font.name') return 'SansSerif';
    if (lk === 'threshold.method') return 'Default';
    if (lk === 'threshold.mode') { const m = M.thresholdWindow && M.thresholdWindow.mode; return m === 'bw' ? 'B&W' : m === 'overunder' ? 'Over/Under' : 'Red'; }
    if (lk === 'window.type') return M.images.size ? 'Image' : '';
    if (lk === 'window.title' || lk === 'window.name') { const im = M.images.get(M.current); return im ? im.title : ''; }
    if (lk === 'macro.filepath') return 'null';
    return Object.prototype.hasOwnProperty.call(VIRTUAL_PROPS, key) ? VIRTUAL_PROPS[key] : 'Invalid key';
  }
  /* Colors.colorToString */
  function colorName(c) {
    for (const k of ['black', 'white', 'red', 'green', 'blue', 'cyan', 'magenta', 'yellow', 'orange', 'pink', 'gray', 'lightgray', 'darkgray'])
      if (NAMED[k][0] === c[0] && NAMED[k][1] === c[1] && NAMED[k][2] === c[2]) return k;
    return '#' + c.map((v) => (v & 0xff).toString(16).padStart(2, '0')).join('');
  }
  /* setAutoThreshold() / setAutoThreshold("Method [dark] …") through the engine's threshold code (the Threshold window's). */
  async function autoThreshold(f, M, method) {
    const im = img(f, M);
    const sd = stackDims(M, im.docId);
    if (sd.rgb) throw macroError('Non-RGB image expected');
    if (typeof M.E.request !== 'function') throw macroError(M.tr('err.macNotInBrowser', { name: 'setAutoThreshold' }));
    let name = 'Default', dark = false, h16 = false;
    let legacy = method === null;
    if (method !== null) {
      const words = method.split(/\s+/).filter(Boolean);
      name = words[0] || 'Default';
      const METHODS = ['Default', 'Huang', 'Intermodes', 'IsoData', 'IJ_IsoData', 'Li', 'MaxEntropy', 'Mean', 'MinError', 'Minimum', 'Moments', 'Otsu', 'Percentile', 'RenyiEntropy', 'Shanbhag', 'Triangle', 'Yen'];
      if (METHODS.indexOf(name) < 0) throw macroError('Invalid method ("' + name + '")');
      dark = method.indexOf('dark') >= 0;
      h16 = method.indexOf('16') >= 0;
    }
    await M.commitAll();
    const pos = M.E.getPosition(im.docId);
    const roi = selectionOf(M, im.docId);
    const r = await M.E.request('doc.threshold', { docId: im.docId, channel: pos.c, roi: isAreaRoi(roi) ? roi : null, method: legacy ? 'Default' : name, dark,
      histogram16: h16, pos: { z: pos.z, t: pos.t }, invertedLut: !!(im.display && im.display[pos.c] && im.display[pos.c].invert) });
    if (!r) return null;
    if (!M.thresholds[im.docId]) M.thresholds[im.docId] = {};
    M.thresholds[im.docId][pos.c] = { lower: r.lower, upper: r.upper, dark };
    M.write('thr.set', { docId: im.docId, c: pos.c, lower: r.lower, upper: r.upper, dark });
    return null;
  }

  // ---- Results helpers ----
  function resultsTable(f, M, report) {
    const t = M.tables.get('Results');
    if ((!t || t.size === 0) && report) f.interp.error('No results found');
    return t || emptyTable('Results');
  }
  function getResult(f, M, column, row, title) {
    const t = title !== null ? tableFor(f, M, title) : resultsTable(f, M, true);
    if (row === -1) row = t.size - 1;
    if (row < 0 || row >= t.size) f.interp.error('Row (' + row + ') out of range');
    if (t.headings.indexOf(column) < 0) return NaN;
    const v = t.columns[column][row];
    const n = cellNumber(v);
    return n;
  }
  function getResultString(f, M, column, row, title) {
    const t = title !== null ? tableFor(f, M, title) : resultsTable(f, M, true);
    if (row === -1) row = t.size - 1;
    if (row < 0 || row >= t.size) f.interp.error('Row (' + row + ') out of range');
    if (t.headings.indexOf(column) >= 0) return cellString(M, t.columns[column][row]);
    if (column === 'Label' && t.labels && t.labels[row] !== null && t.labels[row] !== undefined) return t.labels[row];
    return 'null';
  }
  function* readSetResult(f) {
    const it = f.interp;
    it.getLeftParen();
    const column = yield* f.getString();
    it.getComma();
    const row = d2i(yield* it.getExpression());
    it.getComma();
    let value;
    if (f.isStringArg() || column === 'Label') value = { s: yield* f.getString() };
    else value = yield* it.getExpression();
    let title = null;
    if (it.nextToken() === COMMA) { it.getComma(); title = yield* f.getString(); }
    it.getRightParen();
    return { column, row, value, title };
  }
  function readSetResult$s(f) {
    const it = f.interp;
    it.getLeftParen();
    const column = f.getString$s();
    it.getComma();
    const row = d2i(it.getExpression$s());
    it.getComma();
    let value;
    if (f.isStringArg() || column === 'Label') value = { s: f.getString$s() };
    else value = it.getExpression$s();
    let title = null;
    if (it.nextToken() === COMMA) { it.getComma(); title = f.getString$s(); }
    it.getRightParen();
    return { column, row, value, title };
  }
  /* setResult / Table.set (Functions.setResult) */
  function setResultParse(f, tableTitle, r) {
    const M = runOf(f);
    const title = r.title !== null ? r.title : tableTitle;
    let t;
    if (title === null) {
      t = M.tables.get('Results');
      if (!t) { t = emptyTable('Results'); M.tables.set('Results', t); }
    } else t = tableFor(f, M, title);
    if (r.row < 0 || r.row > t.size) f.interp.error('Row (' + r.row + ') out of range');
    if (r.row === t.size) incrementCounter(t);
    if (r.column === 'Label') {
      if (!t.labels) t.labels = new Array(t.size).fill(null);
      t.labels[r.row] = typeof r.value === 'object' ? r.value.s : String(r.value);
    } else {
      const col = addColumn(t, r.column);
      col[r.row] = typeof r.value === 'object' ? r.value.s : r.value;
    }
    M.dirtyTables.set(t.name, t);
    M.scheduleFlush();
    return null;
  }

  // ---- Table.* (Functions.doTable) ----
  function tableMembers() {
    const titleArg = function* (f) {
      const it = f.interp;
      let title = null;
      if (it.nextToken() === LP) { it.getLeftParen(); if (it.nextToken() !== RP) title = yield* f.getString(); it.getRightParen(); }
      return title;
    };
    const titleArg$s = (f) => {
      const it = f.interp;
      let title = null;
      if (it.nextToken() === LP) { it.getLeftParen(); if (it.nextToken() !== RP) title = f.getString$s(); it.getRightParen(); }
      return title;
    };
    const create = (f, M, title) => {
      const name = title === null ? (M.currentTable || 'Results') : title;
      const t = emptyTable(name);
      M.tables.set(name, t);
      if (name !== 'Results') M.currentTable = name;
      touchTable(M, t);
      M.write('table.show', { name });
      return null;
    };
    const getCol = (f, a, M) => {
      const t = tableFor(f, M, a.length > 1 ? a[1] : null);
      if (t.headings.indexOf(a[0]) < 0) { f.interp.error('"' + a[0] + '" column not found'); return null; }
      const v = new Variable();
      v.setArray(t.columns[a[0]].map((x) => (typeof x === 'string' ? Variable.string(x) : Variable.num(cellNumber(x)))));
      return v;
    };
    return {
      create: { raw: function* (f, M) { return create(f, M, yield* titleArg(f)); }, raw$s: (f, M) => create(f, M, titleArg$s(f)) },
      reset: { raw: function* (f, M) { return create(f, M, yield* titleArg(f)); }, raw$s: (f, M) => create(f, M, titleArg$s(f)) },
      size: { raw: function* (f, M) { return tableFor(f, M, yield* titleArg(f)).size; }, raw$s: (f, M) => tableFor(f, M, titleArg$s(f)).size },
      title: { raw: function* (f, M) { return tableFor(f, M, yield* titleArg(f)).name; }, raw$s: (f, M) => tableFor(f, M, titleArg$s(f)).name },
      headings: { raw: function* (f, M) { return tableFor(f, M, yield* titleArg(f)).headings.join('\t'); }, raw$s: (f, M) => tableFor(f, M, titleArg$s(f)).headings.join('\t') },
      allHeadings: { sig: '', sync: () => DEFAULT_HEADINGS.join('\t') },
      get: { sig: 's?ns', sync: (f, a, M) => getResult(f, M, a[0], a.length > 1 ? d2i(a[1]) : -1, a.length > 2 ? a[2] : (M.currentTable || null), true) },
      getString: { sig: 's?ns', sync: (f, a, M) => getResultString(f, M, a[0], a.length > 1 ? d2i(a[1]) : -1, a.length > 2 ? a[2] : (M.currentTable || null)) },
      set: { raw: function* (f, M) { return setResultParse(f, M.currentTable || null, yield* readSetResult(f)); }, raw$s: (f, M) => setResultParse(f, M.currentTable || null, readSetResult$s(f)) },
      getColumn: { sig: 's?s', sync: getCol },
      columnExists: { sig: 's?s', sync: (f, a, M) => (tableFor(f, M, a.length > 1 ? a[1] : null).headings.indexOf(a[0]) >= 0 ? 1 : 0) },
      setColumn: { sig: 's?As', sync: (f, a, M) => {
        const t = tableFor(f, M, a.length > 2 ? a[2] : null);
        const arr = a.length > 1 ? a[1] : [];
        const vals = arr.map((v) => (v.getString() !== null ? v.getString() : v.getValue()));
        if (vals.length > t.size) { while (t.size < vals.length) incrementCounter(t); }
        const col = addColumn(t, a[0]);
        for (let i = 0; i < t.size; i++) col[i] = i < vals.length ? vals[i] : 0;
        touchTable(M, t);
        return null;
      } },
      update: { raw: function* (f, M) { const t = tableFor(f, M, yield* titleArg(f)); touchTable(M, t); M.write('table.show', { name: t.name }); return null; },
        raw$s: (f, M) => { const t = tableFor(f, M, titleArg$s(f)); touchTable(M, t); M.write('table.show', { name: t.name }); return null; } },
      deleteRows: { sig: 'nn?s', sync: (f, a, M) => { const t = tableFor(f, M, a.length > 2 ? a[2] : null); deleteRows(t, d2i(a[0]), d2i(a[1])); touchTable(M, t); return null; } },
      deleteColumn: { sig: 's?s', sync: (f, a, M) => {
        const t = tableFor(f, M, a.length > 1 ? a[1] : null);
        const i = t.headings.indexOf(a[0]);
        if (i < 0) { f.interp.error('"' + a[0] + '" column not found'); return null; }
        t.headings.splice(i, 1); delete t.columns[a[0]];
        touchTable(M, t);
        return null;
      } },
      renameColumn: { sig: 'ss?s', sync: (f, a, M) => {
        const t = tableFor(f, M, a.length > 2 ? a[2] : null);
        const i = t.headings.indexOf(a[0]);
        if (i < 0) { f.interp.error('"' + a[0] + '" column not found'); return null; }
        if (t.headings.indexOf(a[1]) >= 0) { f.interp.error('"' + a[1] + '" column exists'); return null; }
        t.headings[i] = a[1]; t.columns[a[1]] = t.columns[a[0]]; delete t.columns[a[0]];
        touchTable(M, t);
        return null;
      } },
      sort: { sig: 's?s', sync: (f, a, M) => {
        const t = tableFor(f, M, a.length > 1 ? a[1] : null);
        if (t.headings.indexOf(a[0]) < 0) { f.interp.error('"' + a[0] + '" column not found'); return null; }
        const col = t.columns[a[0]];
        const order = Array.from({ length: t.size }, (_, i) => i);
        const num = (v) => cellNumber(v);
        order.sort((x, y) => { const p = num(col[x]), q = num(col[y]); return p < q ? -1 : p > q ? 1 : (p === q ? x - y : (p !== p ? (q !== q ? x - y : 1) : -1)); });
        for (const h of t.headings) { const c = t.columns[h]; t.columns[h] = order.map((i) => c[i]); }
        if (t.labels) { const l = t.labels; t.labels = order.map((i) => l[i]); }
        touchTable(M, t);
        return null;
      } },
      rename: { sig: 's?s', sync: (f, a, M) => renameResults(M, a.length > 1 ? [a[0], a[1]] : [a[0]]) },
      showRowNumbers: { sig: 'n?s', sync: () => null },
      showRowIndexes: { sig: 'n?s', sync: () => null },
      hideRowNumbers: { sig: '?s', sync: () => null },
      saveColumnHeader: { sig: 'n?s', sync: () => null },
      setLocationAndSize: { sig: 'nnnn?s', sync: () => null },
      setLocAndSize: { sig: 'nnnn?s', sync: () => null },
      getSelectionStart: { sig: '?s', sync: () => -1 },
      getSelectionEnd: { sig: '?s', sync: () => -1 },
      setSelection: { sig: 'nn?s', sync: () => null },
      applyMacro: { sig: 's?s', sync: (f, a, M) => { f.interp.error(M.tr('err.macNotInBrowser', { name: 'Table.applyMacro' })); return null; } },
      save: { sig: 's?s', sync: (f, a, M) => { f.interp.error(M.tr('err.macFileLater', { name: 'Table.save' })); return null; } },
      open: { sig: 's?s', sync: (f, a, M) => { f.interp.error(M.tr('err.macFileLater', { name: 'Table.open' })); return null; } },
      showArrays: { sig: 's?AAAAAAAAA', sync: (f, a, M) => { f.interp.error(M.tr('err.macNotInBrowser', { name: 'Table.showArrays' })); return null; } }
    };
  }

  // ---- ROI Manager (Functions.roiManager / doRoiManager): ImageJ's actions on the mirror, the page stores the list ----
  function rmName(M, roi, docId) {
    if (roi && typeof roi.name === 'string' && roi.name) return roi.name;
    // RoiManager.getLabel: "yyyy-xxxx" of the centre (with the slice of a stack in front)
    const b = root.IJRoi.bounds(roi);
    const xc = Math.max(0, b.x + d2i(b.w / 2)), yc = Math.max(0, b.y + d2i(b.h / 2));
    const pad = (v) => String(v).padStart(4, '0');
    let label = pad(yc) + '-' + pad(xc);
    if (docId !== undefined && docId !== null) {
      try {
        const d = root.IJStack && M.E.dims(docId);
        if (d && d.nZ * d.nT * (d.rgb ? 1 : d.nC) > 1) { const p = M.E.getPosition(docId); const sd = { nC: d.rgb ? 1 : d.nC, nZ: d.nZ, nT: d.nT }; label = pad(root.IJStack.stackIndex(sd, d.rgb ? 0 : p.c, p.z, p.t)) + '-' + label; }
      } catch (_) { /* closed */ }
    }
    return label;
  }
  function rmSync(M) { M.write('rm.set', { list: M.rm.list.slice() }); M.write('rm.select', { indices: M.rm.selected.slice() }); }
  async function roiManager(f, M, a) {
    const cmd = String(a[0]).toLowerCase();
    const arg = a.length > 1 ? a[1] : undefined;
    const argS = typeof arg === 'object' ? arg.s : arg;
    const list = M.rm.list;
    const im = M.images.get(M.current) || null;
    switch (cmd) {
      case 'add': {
        if (!im) throw macroError('There are no images open');
        const roi = selectionOf(M, im.docId);
        if (!roi) throw macroError('The active image does not have a selection.');
        const entry = { name: rmName(M, roi, im.docId), docId: im.docId, roi: Object.assign({}, roi) };
        if (typeof argS === 'string' && argS) entry.stroke = argS;
        if (a.length > 2 && typeof a[2] === 'number') entry.width = a[2];
        list.push(entry);
        rmSync(M);
        return NaN;
      }
      case 'count': case 'size': return list.length;
      case 'index': return M.rm.selected.length ? M.rm.selected[0] : -1;
      case 'select': {
        const idx = d2i(Number(arg));
        if (idx < 0 || idx > list.length - 1) throw macroError('Index (' + idx + ') is outside of the 0-' + (list.length - 1) + ' range');
        M.rm.selected = [idx];
        const e = list[idx];
        const target = im ? im.docId : e.docId;
        if (target !== null && target !== undefined) setSelection(M, target, Object.assign({}, e.roi));
        M.write('rm.select', { indices: [idx] });
        return NaN;
      }
      case 'deselect': M.rm.selected = []; M.write('rm.select', { indices: [] }); return NaN;
      case 'delete': {
        if (M.rm.selected.length) { const s = new Set(M.rm.selected); M.rm.list = list.filter((_, i) => !s.has(i)); }
        else M.rm.list = [];
        M.rm.selected = [];
        rmSync(M);
        return NaN;
      }
      case 'reset': M.rm.list = []; M.rm.selected = []; rmSync(M); return NaN;
      case 'rename': {
        const i = M.rm.selected.length ? M.rm.selected[0] : -1;
        if (i < 0) throw macroError('Exactly one item in the list must be selected.');
        list[i] = Object.assign({}, list[i], { name: String(argS) });
        rmSync(M);
        return NaN;
      }
      case 'update': {
        const i = M.rm.selected.length ? M.rm.selected[0] : -1;
        if (i < 0 || !im) return NaN;
        const roi = selectionOf(M, im.docId);
        if (roi) { list[i] = Object.assign({}, list[i], { roi: Object.assign({}, roi), docId: im.docId }); rmSync(M); }
        return NaN;
      }
      case 'show all': case 'show all with labels': case 'show all without labels':
        M.rm.showAll = true; M.rm.labels = cmd === 'show all with labels' ? true : cmd === 'show all without labels' ? false : M.rm.labels;
        M.write('rm.show', { showAll: true, labels: M.rm.labels }); return NaN;
      case 'show none': M.rm.showAll = false; M.write('rm.show', { showAll: false, labels: M.rm.labels }); return NaN;
      case 'usenames': return NaN;
      case 'sort': {
        const order = list.map((e, i) => i).sort((x, y) => (list[x].name < list[y].name ? -1 : list[x].name > list[y].name ? 1 : x - y));
        M.rm.list = order.map((i) => list[i]);
        M.rm.selected = [];
        rmSync(M);
        return NaN;
      }
      case 'translate': {
        const dx = Number(arg), dy = a.length > 2 ? Number(a[2]) : 0;
        const idx = M.rm.selected.length ? M.rm.selected : list.map((_, i) => i);
        for (const i of idx) list[i] = Object.assign({}, list[i], { roi: root.IJRoi.translate(list[i].roi, dx, dy) });
        rmSync(M);
        return NaN;
      }
      case 'set color': case 'set fill color': case 'set line width': {
        const idx = M.rm.selected.length ? M.rm.selected : list.map((_, i) => i);
        for (const i of idx) {
          if (cmd === 'set color') list[i] = Object.assign({}, list[i], { stroke: String(argS) });
          else if (cmd === 'set fill color') list[i] = Object.assign({}, list[i], { fill: String(argS) });
          else list[i] = Object.assign({}, list[i], { width: Number(argS) });
        }
        rmSync(M);
        return NaN;
      }
      case 'measure': case 'multi measure': {
        if (!im) throw macroError('There are no images open');
        const idx = M.rm.selected.length ? M.rm.selected.slice() : list.map((_, i) => i);
        for (const i of idx) {
          setSelection(M, im.docId, Object.assign({}, list[i].roi));
          await runCommand(f, M, 'Measure', null);
        }
        return NaN;
      }
      case 'open': case 'save': case 'save selected': throw macroError(M.tr('err.macFileLater', { name: 'roiManager("' + a[0] + '")' }));
      default: throw macroError(M.tr('err.macNotInBrowser', { name: 'roiManager("' + a[0] + '")' }));
    }
  }
  function roiManagerMembers() {
    return {
      size: { sig: '', sync: (f, a, M) => M.rm.list.length },
      selected: { sig: '', sync: (f, a, M) => M.rm.selected.length },
      getName: { sig: 'n', sync: (f, a, M) => { const i = d2i(a[0]); return i >= 0 && i < M.rm.list.length ? M.rm.list[i].name : 'null'; } },
      getIndex: { sig: 's', sync: (f, a, M) => M.rm.list.findIndex((e) => e.name === a[0]) },
      select: { sig: 'n', sync: (f, a, M) => {
        const i = d2i(a[0]);
        if (i < 0 || i >= M.rm.list.length) f.interp.error('Index (' + i + ') is outside of the 0-' + (M.rm.list.length - 1) + ' range');
        M.rm.selected = [i];
        const im = M.images.get(M.current);
        if (im) setSelection(M, im.docId, Object.assign({}, M.rm.list[i].roi));
        M.write('rm.select', { indices: [i] });
        return null;
      } },
      selectGroup: { sig: 'n', sync: (f, a, M) => { f.interp.error(M.tr('err.macNotInBrowser', { name: 'RoiManager.selectGroup' })); return null; } },
      setGroup: { sig: 'n', sync: (f, a, M) => { f.interp.error(M.tr('err.macNotInBrowser', { name: 'RoiManager.setGroup' })); return null; } },
      useNamesAsLabels: { sig: 'b', sync: (f, a, M) => { M.rm.labels = a[0]; M.write('rm.show', { showAll: M.rm.showAll, labels: a[0] }); return null; } },
      setPosition: { sig: 'n', sync: (f, a, M) => {
        for (const i of M.rm.selected) M.rm.list[i] = Object.assign({}, M.rm.list[i], { position: { c: 0, z: d2i(a[0]), t: 0 } });
        rmSync(M);
        return null;
      } },
      multiCrop: { sig: 'ss', sync: (f, a, M) => { f.interp.error(M.tr('err.macNotInBrowser', { name: 'RoiManager.multiCrop' })); return null; } }
    };
  }
  // ---- Roi.* (Functions.doRoi): the common getters and setters on the current selection ----
  function roiMembers() {
    const cur = (f, M) => { const im = img(f, M); const roi = selectionOf(M, im.docId); if (!roi) f.interp.error('No selection'); return { im, roi }; };
    return {
      size: { sig: '', sync: (f, a, M) => { const im = img(f, M); const roi = selectionOf(M, im.docId); return roi ? roiSize(roi) : 0; } },
      contains: { sig: 'nn', sync: (f, a, M) => { const { roi } = cur(f, M); if (!isAreaRoi(roi)) return 0; return root.IJRoi.contains(roi, a[0], a[1]) ? 1 : 0; } },
      getBounds: { sig: 'vvvv', sync: (f, a, M) => { const { roi } = cur(f, M); const b = roiBounds(roi); a[0].setValue(b.x); a[1].setValue(b.y); a[2].setValue(b.w); a[3].setValue(b.h); return null; } },
      getFloatBounds: { sig: 'vvvv', sync: (f, a, M) => {
        const { roi } = cur(f, M);
        let x0, y0, x1, y1;
        if (roi.type === 'rect' || roi.type === 'oval' || roi.type === 'mask') { x0 = roi.x; y0 = roi.y; x1 = roi.x + roi.w; y1 = roi.y + roi.h; }
        else { const v = vertices(f, M, roi); x0 = Math.min(...v.xs); y0 = Math.min(...v.ys); x1 = Math.max(...v.xs); y1 = Math.max(...v.ys); }
        a[0].setValue(x0); a[1].setValue(y0); a[2].setValue(x1 - x0); a[3].setValue(y1 - y0);
        return null;
      } },
      getCoordinates: { sig: 'VV', sync: (f, a, M) => { const { roi } = cur(f, M); const v = vertices(f, M, roi); a[0].setArray(v.xs.map((x) => Variable.num(x))); a[1].setArray(v.ys.map((y) => Variable.num(y))); return null; } },
      getName: { sig: '', sync: (f, a, M) => { const im = img(f, M); const roi = selectionOf(M, im.docId); return roi && typeof roi.name === 'string' ? roi.name : ''; } },
      setName: { sig: 's', sync: (f, a, M) => { const { im, roi } = cur(f, M); setSelection(M, im.docId, Object.assign({}, roi, { name: a[0] })); return null; } },
      getType: { sig: '', sync: (f, a, M) => {
        const im = img(f, M); const roi = selectionOf(M, im.docId);
        return ['rectangle', 'oval', 'polygon', 'freehand', 'traced', 'line', 'polyline', 'freeline', 'angle', 'composite', 'point'][roiType(roi)] || '';
      } },
      move: { sig: 'nn', sync: (f, a, M) => { const { im, roi } = cur(f, M); const b = roiBounds(roi); setSelection(M, im.docId, root.IJRoi.translate(roi, a[0] - b.x, a[1] - b.y)); return null; } },
      translate: { sig: 'nn', sync: (f, a, M) => { const { im, roi } = cur(f, M); setSelection(M, im.docId, root.IJRoi.translate(roi, a[0], a[1])); return null; } },
      remove: { sig: '', sync: (f, a, M) => { const im = img(f, M); setSelection(M, im.docId, null); return null; } },
      selectNone: { sig: '', sync: (f, a, M) => { const im = img(f, M); setSelection(M, im.docId, null); return null; } },
      setStrokeColor: { sig: 's', sync: (f, a, M) => { const { im, roi } = cur(f, M); setSelection(M, im.docId, Object.assign({}, roi, { stroke: a[0] })); return null; } },
      setFillColor: { sig: 's', sync: (f, a, M) => { const { im, roi } = cur(f, M); setSelection(M, im.docId, Object.assign({}, roi, { fill: a[0] })); return null; } },
      getStrokeColor: { sig: '', sync: (f, a, M) => { const { roi } = cur(f, M); return typeof roi.stroke === 'string' ? roi.stroke : ''; } },
      getFillColor: { sig: '', sync: (f, a, M) => { const { roi } = cur(f, M); return typeof roi.fill === 'string' ? roi.fill : ''; } },
      setStrokeWidth: { sig: 'n', sync: (f, a, M) => { const { im, roi } = cur(f, M); setSelection(M, im.docId, Object.assign({}, roi, { width: a[0] })); return null; } },
      getStrokeWidth: { sig: '', sync: (f, a, M) => { const { roi } = cur(f, M); return roi.width > 0 ? roi.width : 0; } },
      setPosition: { sig: 'n?nn', sync: (f, a, M) => {
        const { im, roi } = cur(f, M);
        const position = a.length === 3 ? { c: d2i(a[0]), z: d2i(a[1]), t: d2i(a[2]) } : { c: 0, z: d2i(a[0]), t: 0 };
        setSelection(M, im.docId, Object.assign({}, roi, { position }));
        return null;
      } },
      getPosition: { sig: 'vvv', sync: (f, a, M) => { const { roi } = cur(f, M); const p = roi.position || { c: 0, z: 0, t: 0 }; a[0].setValue(p.c); a[1].setValue(p.z); a[2].setValue(p.t); return null; } },
      getDefaultColor: { sig: '', sync: (f, a, M) => colorName(M.colors.selection || [255, 255, 0]) }
    };
  }

  // ---- Dialog.* (Functions.doDialog): the fields are built in the worker, shown by the page in one dialog.show ----
  // GenericDialog reads its fields back by kind and in order: getNextNumber the numeric fields and sliders, getNextString the string
  // fields, getNextBoolean the checkboxes, getNextChoice the choices (an image choice is one), getNextRadioButton the radio groups; one
  // read past the last field is ImageJ's "Dialog error" (an IndexOutOfBoundsException).
  function dialogMembers() {
    const need = (f, M) => { if (!M.dialog) f.interp.error('No dialog created with Dialog.create()'); return M.dialog; };
    const add = (M, field, kind) => { field.id = 'f' + M.dialog.fields.length; field.kind = kind; M.dialog.fields.push(field); return field; };
    const next = (f, M, kind) => {
      const d = need(f, M);
      let seen = 0;
      for (const fld of d.fields) if (fld.kind === kind) { if (seen === d.read[kind]) { d.read[kind]++; return fld; } seen++; }
      f.interp.error('Dialog error');
      return null;
    };
    const value = (M, fld) => (M.dialog.values && Object.prototype.hasOwnProperty.call(M.dialog.values, fld.id) ? M.dialog.values[fld.id] : fld.value);
    const create = (f, a, M) => { M.dialog = { title: a[0], fields: [], cancel: true, values: null, read: { number: 0, string: 0, check: 0, choice: 0, radio: 0 } }; return null; };
    const fileField = (name) => (f, a, M) => { need(f, M); f.interp.error(M.tr('err.macFileLater', { name })); return null; };
    return {
      create: { sig: 's', sync: create },
      createNonBlocking: { sig: 's', sync: create },
      addString: { sig: 'ss?n', sync: (f, a, M) => { need(f, M); add(M, { type: 'string', label: a[0], value: a[1], columns: a.length > 2 ? d2i(a[2]) : 8 }, 'string'); return null; } },
      addDirectory: { sig: 'ss?n', sync: fileField('Dialog.addDirectory') },
      addFile: { sig: 'ss?n', sync: fileField('Dialog.addFile') },
      addImageChoice: { sig: 's?s', sync: (f, a, M) => {
        need(f, M);
        if (!M.images.size) f.interp.error('No images');
        const opts = M.order.map((id) => M.images.get(id)).filter(Boolean).map((im) => ({ value: im.docId, label: im.title }));
        const def = a.length > 1 ? (opts.find((o) => o.label === a[1]) || opts[0]) : (opts.find((o) => o.value === M.current) || opts[0]);
        add(M, { type: 'doc', label: a[0], value: def.value, options: opts }, 'choice');
        return null;
      } },
      addNumber: { sig: 'sn?nns', sync: (f, a, M) => {
        need(f, M);
        // "int decimalPlaces = (int)defaultNumber==defaultNumber?0:3;" then (decimals, columns, units) when given
        const decimals = a.length > 2 ? d2i(a[2]) : (d2i(a[1]) === a[1] ? 0 : 3);
        const fld = { type: 'number', label: a[0], value: a[1], decimals };
        if (a.length > 4 && a[4]) fld.units = a[4];
        add(M, fld, 'number');
        return null;
      } },
      addSlider: { sig: 'snnn?n', sync: (f, a, M) => {
        need(f, M);
        const fld = { type: 'slider', label: a[0], min: a[1], max: a[2], value: a[3] };
        if (a.length > 4 && a[4] !== 0) fld.step = a[4];
        add(M, fld, 'number');
        return null;
      } },
      addCheckbox: { sig: 'sn', sync: (f, a, M) => { need(f, M); add(M, { type: 'check', label: a[0], value: a[1] === 1 }, 'check'); return null; } },
      addCheckboxGroup: { sig: 'nnSa', sync: (f, a, M) => {
        need(f, M);
        const labels = a[2], states = a[3];
        if (labels.length !== states.length) f.interp.error('labels.length!=states.length');
        for (let i = 0; i < labels.length; i++) add(M, { type: 'check', label: labels[i], value: states[i] === 1.0 }, 'check');
        return null;
      } },
      addRadioButtonGroup: { sig: 'sSnns', sync: (f, a, M) => {
        need(f, M);
        const items = a[1];
        add(M, { type: 'radio', label: a[0], value: items.indexOf(a[4]) >= 0 ? a[4] : items[0], options: items.map((x) => ({ value: x, label: x })) }, 'radio');
        return null;
      } },
      addMessage: { sig: 's?ns', sync: (f, a, M) => { need(f, M); add(M, { type: 'message', label: a[0] }, 'message'); return null; } },
      addHelp: { sig: 's', sync: (f, a, M) => { need(f, M); return null; } },
      addChoice: { sig: 'sS?s', sync: (f, a, M) => {
        need(f, M);
        const items = a[1];
        const def = a.length > 2 ? a[2] : items[0];
        add(M, { type: 'choice', label: a[0], value: items.indexOf(def) >= 0 ? def : items[0], options: items.map((x) => ({ value: x, label: x })) }, 'choice');
        return null;
      } },
      setInsets: { sig: 'nnn', sync: (f, a, M) => { need(f, M); return null; } },
      addImage: { sig: 's', sync: fileField('Dialog.addImage') },
      addToSameRow: { sig: '', sync: (f, a, M) => { need(f, M); return null; } },
      enableYesNoCancel: { sig: 'ss', sync: (f, a, M) => { f.interp.error(M.tr('err.macNotInBrowser', { name: 'Dialog.enableYesNoCancel' })); return null; } },
      setLocation: { sig: 'nn', sync: (f, a, M) => { need(f, M); return null; } },
      getLocation: { sig: 'vv', sync: (f, a, M) => { need(f, M); a[0].setValue(0); a[1].setValue(0); return null; } },
      show: { sig: '', async: async (f, a, M) => {
        const d = need(f, M);
        const fields = d.fields.map((x) => {
          const o = { id: x.id, type: x.type, label: x.label, value: x.value };
          for (const k of ['decimals', 'min', 'max', 'step', 'options', 'columns', 'units']) if (x[k] !== undefined) o[k] = x[k];
          return o;
        });
        const r = await M.rpc('dialog.show', { title: d.title, fields, cancel: d.cancel });
        if (!r || r.cancelled) throw new MacroCancel('abort');
        d.values = (r && r.values) || {};
        for (const k of Object.keys(d.read)) d.read[k] = 0;
        return null;
      } },
      getString: { sig: '', sync: (f, a, M) => String(value(M, next(f, M, 'string'))) },
      getNumber: { sig: '', sync: (f, a, M) => {
        const v = value(M, next(f, M, 'number'));
        const n = typeof v === 'number' ? v : toolsParseDouble(String(v), NaN);
        return LANG().javaDouble(n);
      } },
      getCheckbox: { sig: '', sync: (f, a, M) => (value(M, next(f, M, 'check')) ? '1' : '0') },
      getChoice: { sig: '', sync: (f, a, M) => {
        const fld = next(f, M, 'choice');
        const v = value(M, fld);
        if (fld.type === 'doc') { const im = M.images.get(v); return im ? im.title : ''; }
        return String(v);
      } },
      getImageChoice: { sig: '', sync: (f, a, M) => { const fld = next(f, M, 'choice'); const v = value(M, fld); const im = M.images.get(v); return im ? im.title : ''; } },
      getRadioButton: { sig: '', sync: (f, a, M) => String(value(M, next(f, M, 'radio'))) },
      getYesNoCancel: { sig: '', sync: (f, a, M) => { need(f, M); return 'yes'; } }
    };
  }
  function dialogTitle(f) {
    let title = f.interp.macroName !== undefined && f.interp.macroName !== null ? String(f.interp.macroName) : '';
    if (title.endsWith(' Options')) title = title.substring(0, title.length - 8);
    return title;
  }
  /* Toolbar tool ids (Toolbar.getToolId order) ↔ Studio tool ids. */
  const TOOL_IDS = ['rect', 'oval', 'polygon', 'freehand', 'line', 'polyline', 'freeline', 'point', 'wand', 'text', 'unused', 'zoom', 'hand', 'dropper', 'angle'];
  const TOOL_NAMES = { rectangle: 'rect', roundrect: 'rect', rotrect: 'rect', oval: 'oval', ellipse: 'oval', brush: 'oval', polygon: 'polygon', freehand: 'freehand',
    line: 'line', straight: 'line', polyline: 'polyline', freeline: 'polyline', arrow: 'line', angle: 'angle', point: 'point', multipoint: 'point', wand: 'wand',
    zoom: 'zoom', hand: 'hand' };
  function setTool(f, M, x) {
    let id = null;
    if (typeof x === 'object') {
      const s = x.s.toLowerCase();
      for (const k of Object.keys(TOOL_NAMES)) if (s.indexOf(k) >= 0) { id = TOOL_NAMES[k]; if (k === s) break; }
      if (!id) { f.interp.error('Unrecognized tool name'); return null; }
    } else {
      const n = d2i(x);
      id = TOOL_IDS[n] && TOOL_IDS[n] !== 'unused' && TOOL_IDS[n] !== 'text' && TOOL_IDS[n] !== 'dropper' && TOOL_IDS[n] !== 'freeline' ? TOOL_IDS[n] : (n === 6 ? 'polyline' : null);
      if (!id) return null;
    }
    M.tool = id;
    M.write('tool.set', { id });
    return null;
  }
  function lutTable(M, P) {
    const disp = (P.im.display && P.im.display[P.c]) || {};
    if (Array.isArray(disp.lut) && disp.lut.length === 768) return disp.lut;
    const IJLuts = root.IJLuts;
    let t = null;
    try { t = IJLuts ? IJLuts.get(disp.lut === undefined || disp.lut === null ? 'Grays' : disp.lut) : null; } catch (_) { t = null; }
    if (!t) { t = new Uint8Array(768); for (let i = 0; i < 256; i++) t[i * 3] = t[i * 3 + 1] = t[i * 3 + 2] = i; }
    if (disp.invert) {
      const r = new Uint8Array(768);
      for (let i = 0; i < 256; i++) { const j = 255 - i; r[i * 3] = t[j * 3]; r[i * 3 + 1] = t[j * 3 + 1]; r[i * 3 + 2] = t[j * 3 + 2]; }
      t = r;
    }
    return t;
  }

  // ---------------------------------------------------------------- call() and the refusals
  function installCallAndRefusals() {
    const IJMacro = LANG();
    IJMacro.define('str', 'call', function* (f) {
      const it = f.interp;
      it.getLeftParen();
      const target = yield* f.getString();
      const args = [];
      while (it.nextToken() === COMMA) { it.getComma(); args.push(yield* f.getString()); }
      it.getRightParen();
      return callBody(f, runOf(f), target, args);
    }, { suspends: false, sync(f) {
      const it = f.interp;
      it.getLeftParen();
      const target = f.getString$s();
      const args = [];
      while (it.nextToken() === COMMA) { it.getComma(); args.push(f.getString$s()); }
      it.getRightParen();
      return callBody(f, runOf(f), target, args);
    } });

    // file built-ins: a later phase of the Studio (refused with the translated message, never silently)
    const later = (name) => (M) => M.tr('err.macFileLater', { name });
    IJMacro.define('do', 'open', function* (f) {
      const it = f.interp;
      let path = '';
      if (it.nextToken() === LP) {
        it.getLeftParen();
        if (it.nextToken() !== RP) path = yield* f.getString();
        while (it.nextToken() === COMMA) { it.getComma(); yield* it.getExpression(); }
        it.getRightParen();
      }
      const M = runOf(f);
      f.interp.error(openRefusal(M, path));
      return null;
    }, { suspends: false, sync(f) {
      const it = f.interp;
      let path = '';
      if (it.nextToken() === LP) {
        it.getLeftParen();
        if (it.nextToken() !== RP) path = f.getString$s();
        while (it.nextToken() === COMMA) { it.getComma(); it.getExpression$s(); }
        it.getRightParen();
      }
      f.interp.error(openRefusal(runOf(f), path));
      return null;
    } });
    defRefused('do', 'save', 's', later('save'));
    defRefused('do', 'saveAs', 's?s', later('saveAs'));
    defRefused('str', 'getDirectory', 's', later('getDirectory'));
    defRefused('str', 'getDir', 's', later('getDir'));
    defRefused('arr', 'getFileList', 's', later('getFileList'));
    IJMacro.define('str', 'File', function* (f) { const m = memberName(f); yield* skipArgs(f); f.interp.error(fileRefusal(f, m)); return ''; },
      { suspends: false, sync(f) { const m = memberName(f); skipArgs$s(f); f.interp.error(fileRefusal(f, m)); return ''; } });
    IJMacro.define('str', 'exec', function* (f) { yield* skipArgs(f); f.interp.error(runOf(f).tr('err.macExec')); return ''; },
      { suspends: false, sync(f) { skipArgs$s(f); f.interp.error(runOf(f).tr('err.macExec')); return ''; } });
    IJMacro.define('str', 'Ext', function* (f) { memberName(f); yield* skipArgs(f); f.interp.error(runOf(f).tr('err.macExtensions')); return ''; },
      { suspends: false, sync(f) { memberName(f); skipArgs$s(f); f.interp.error(runOf(f).tr('err.macExtensions')); return ''; } });
    IJMacro.define('str', 'debug', function* (f) { yield* skipArgs(f); f.interp.error(runOf(f).tr('err.macDebug')); return ''; },
      { suspends: false, sync(f) { skipArgs$s(f); f.interp.error(runOf(f).tr('err.macDebug')); return ''; } });

    // eval(code) runs macro code in a nested interpreter of the same run; eval("js"|"script"|"bsh"|"python", …) is refused
    IJMacro.define('str', 'eval', function* (f) {
      const it = f.interp;
      it.getLeftParen();
      const name = yield* f.getString();
      let arg = null;
      if (it.nextToken() === COMMA) { it.getComma(); arg = yield* f.getString(); }
      it.getRightParen();
      if (arg !== null && (name === 'script' || name === 'js' || name === 'bsh' || name === 'python')) { it.error(runOf(f).tr('err.macEvalScript')); return ''; }
      return yield* runNested(f, name, arg);
    }, { suspends: true });
  }
  /* The nested interpreter of eval(): IJ.runMacro (Macro_Runner) shares the run's context, so the same lane and undo group. */
  function* runNested(f, code, arg) {
    const IJMacro = LANG();
    const outer = f.interp;
    const nested = new IJMacro.Interpreter(outer.ctx);
    nested.argument = arg;
    nested.calledMacro = true;
    try {
      yield* nested.run(code);
      return nested.returnValue;
    } catch (e) {
      if (e instanceof MacroCancel && e.kind === 'abort') throw e;
      if (e && e.constructor && e.constructor.name === 'SyncViolation') throw e;
      if (e instanceof RangeError && /call stack/i.test(e.message)) throw e;
      if (e instanceof MacroCancel && e.kind === 'error' && nested.wasError && !nested.errorSilent)
        yield* f.hostHook(() => outer.ctx.showError(nested.errorDialogText()));
      return '[aborted]';
    }
  }
  function* skipArgs(f) {
    const it = f.interp;
    if (it.nextToken() !== LP) return;
    it.getLeftParen();
    if (it.nextToken() !== RP) {
      for (;;) {
        if (f.isStringArg()) yield* f.getString(); else yield* it.getExpression();
        if (it.nextToken() !== COMMA) break;
        it.getComma();
      }
    }
    it.getRightParen();
  }
  function skipArgs$s(f) {
    const it = f.interp;
    if (it.nextToken() !== LP) return;
    it.getLeftParen();
    if (it.nextToken() !== RP) {
      for (;;) {
        if (f.isStringArg()) f.getString$s(); else it.getExpression$s();
        if (it.nextToken() !== COMMA) break;
        it.getComma();
      }
    }
    it.getRightParen();
  }
  function fileRefusal(f, member) {
    return runOf(f).tr('err.macFileLater', { name: 'File.' + member });
  }
  const BIO_EXT = /\.(ims|czi|lif|nd2|lsm|oib|oif|vsi|zvi|nd|lei|sld|scn|svs|mvd2|ome\.tiff?)$/i;
  function openRefusal(M, path) {
    const p = String(path || '');
    if (/^(https?|ftp):\/\//i.test(p)) return M.tr('err.macNetwork');
    if (BIO_EXT.test(p)) return M.tr('err.macBioFormats');
    return M.tr('err.macFileLater', { name: p ? 'open("' + p + '")' : 'open()' });
  }
  /* call(target, args…): the whitelist (CALL-WHITELIST.md §5). Anything else stops the macro with err.macCallRefused. */
  function callBody(f, M, target, args) {
    const r = resolveCall(target, args);
    if (r.error) { f.interp.error(r.error); return null; }
    if (r.refused) {
      const shown = target.length > 200 ? target.substring(0, 200) : target;
      f.interp.error(M.tr('err.macCallRefused', { target: shown }));
      return null;
    }
    const a = r.javaArgs;
    switch (r.target) {
      case 'ij.Prefs.get': {
        const k = a[0];
        if (M.prefsWrites.has(k)) return M.prefsWrites.get(k);
        if (M.prefs.has(k)) return M.prefs.get(k);
        return a[1];
      }
      case 'ij.Prefs.set': {
        const k = a[0], v = a[1];
        if (k.indexOf('.') < 1) { M.log('java.lang.IllegalArgumentException: Key must have a prefix'); return null; }
        const merged = new Map(M.prefs);
        for (const [kk, vv] of M.prefsWrites) merged.set(kk, vv);
        merged.set(k, v);
        let total = 0;
        for (const [kk, vv] of merged) total += kk.length + vv.length;
        if (k.length > PREF_MAX_KEY || v.length > PREF_MAX_VALUE || merged.size > PREF_MAX_KEYS || total > PREF_MAX_TOTAL) { f.interp.error(M.tr('err.macPrefsQuota')); return null; }
        M.prefsWrites.set(k, v);
        return null;
      }
      case 'ij.IJ.freeMemory': return freeMemoryText(pixelBytes(M), maxMemory(M));
      case 'ij.IJ.currentMemory': return String(pixelBytes(M));
      case 'ij.IJ.maxMemory': return String(maxMemory(M));
      case 'ij.IJ.pad': {
        const str = typeof a[0] === 'number' ? String(a[0]) : a[0];
        const len = a[1];
        if (len > 4096) { f.interp.error(M.tr('err.macPadLimit')); return null; }
        return len <= str.length ? str : '0'.repeat(len - str.length) + str;
      }
      case 'ij.plugin.frame.RoiManager.getName': {
        const i = d2i(toolsParseDouble(a[0], -1));
        return i >= 0 && i < M.rm.list.length && typeof M.rm.list[i].name === 'string' ? M.rm.list[i].name : 'null';
      }
      case 'ij.plugin.frame.ThresholdAdjuster.setMode': {
        const m = a[0] === 'Red' ? 'red' : a[0] === 'B&W' ? 'bw' : a[0] === 'Over/Under' ? 'overunder' : null;
        if (m && M.thresholdWindow) M.write('thr.mode', { mode: m });
        return null;
      }
      case 'ij.gui.ImageWindow.setNextLocation': return null;
      case 'ij.ImagePlus.setDefault16bitRange': {
        let v = a[0];
        if ([8, 10, 12, 14, 15, 16].indexOf(v) < 0) v = 0;
        if (v !== 0) { f.interp.error(M.tr('err.mac16bitRange', { value: v })); return null; }
        return null;
      }
      default: f.interp.error(M.tr('err.macCallRefused', { target })); return null;
    }
  }

  // Test hooks (pure helpers and the run registry): not part of the contract.
  root.IJMacroRuntime = Object.freeze({
    resolveCall, freeMemoryText, optionFor, logApply, logText, parseJavaDouble,
    runs: () => Array.from(RUNS.keys()),
    run: (runId) => RUNS.get(runId) || null,
    setRpcTimeout(ms) { const old = RPC_TIMEOUT_MS; RPC_TIMEOUT_MS = ms > 0 ? ms : 30000; return old; }
  });
})(typeof self !== 'undefined' ? self : globalThis);
