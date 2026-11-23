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
    'err.macNetwork', 'err.macBioFormats', 'err.macExec', 'err.macEvalScript', 'err.macExtensions',
    'err.macDebug', 'err.macCallRefused', 'err.macPadLimit', 'err.macPrefsQuota', 'err.mac16bitRange', 'err.macPageTimeout',
    'err.macNotInBrowser', 'err.macArrow', 'err.macClipboard', 'err.macRefused',
    // files (FILES.md §12.1)
    'err.macFolderNotGranted', 'err.macFolderStale', 'err.macReadOnly', 'err.macWriteRefused', 'err.macRootDelete', 'err.macPermission',
    'err.macQuota', 'err.macNoStorage', 'err.macFileGone', 'err.macFileBusy', 'err.macFileTooLarge', 'err.macSaveFormat',
    'err.macReasonSequence', 'dlg.mac.files.readme', 'dlg.mac.files.readmeManual', 'dlg.mac.files.readmeDelete', 'dlg.mac.files.readmeRename'
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
    'command.list': Object.freeze({ interactive: false }),
    // files (FILES.md §5.4): pickers, confirmations and permissions wait for the operator; text windows answer at once
    'vfs.pick': Object.freeze({ interactive: true }),
    'vfs.confirm': Object.freeze({ interactive: true }),
    'vfs.regrant': Object.freeze({ interactive: true }),
    'text.open': Object.freeze({ interactive: false }),
    'window.text': Object.freeze({ interactive: false })
  });

  /** The closed list of run() file operations the worker executes (FILES.md §9.2): what a CmdResult `status: 'file'` may name. */
  const FILE_OPS = Object.freeze(['open', 'importTextImage', 'importLut', 'importResults', 'importTable', 'importTextFile', 'importXY', 'importRaw', 'save', 'saveTiff',
    'saveJpeg', 'savePng', 'saveZip', 'saveRaw', 'saveTextImage', 'saveLut', 'saveSelection', 'saveXY', 'saveXYCoordinates',
    'saveResults', 'saveText', 'runMacro']);

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
    TEXT_KEYS, RPC_METHODS, WRITE_OPS, OPTION_SETTINGS, FILE_OPS,
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

  if (R && typeof R.defineCommand === 'function') {
    if (!R.getCommand('macro.scan')) R.defineCommand('macro.scan', { pkg: 'macro', passive: true, handler: (a) => macroScan(a) });
    if (!R.getCommand('macro.vfs')) R.defineCommand('macro.vfs', { pkg: 'macro', long: true, handler: (a, E) => macroVfs(a, E) });
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
    const out = { name: t.name, size: t.size | 0, headings: (t.headings || []).slice(), columns, labels: t.labels ? t.labels.slice() : null, rev: t.rev | 0 };
    if (t.showRowNumbers === true) out.showRowNumbers = true;
    if (t.dec) out.dec = Object.assign({}, t.dec);
    return out;
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
      this.front = null;            // the page's front window (MeasurementsWriter, TextWriter): { kind, title }
      this.textWins = new Set();    // the text windows this run opened (open() of a text file, File › Import › Text File; F20)
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
      this.savedDocs = new Set();   // documents a save wrote to a file (E.markSaved): the page refreshes their unsaved flag and origin
      this.batch = false;
      this.batchDocs = [];         // ImageJ's Interpreter.imageTable: the images made in batch mode, in order
      this.keys = { alt: false, shift: false };
      this.infoProps = new Map();  // docId → "Info" property (setMetadata("Info", …)), kept for the run
      this.dialog = null;          // Dialog.create … Dialog.show
      this.currentTable = null;
      this.rgbWeights = null;
      // files (FILES.md §8.9)
      this.vfs = null;              // the run's IJMacroVFS (opened before the macro starts)
      this.vfsFault = null;         // why it could not be opened (raised by the first file built-in)
      this.vfsNeeds = [];           // result.vfs.needs: machine paths with no alias
      this.writers = new Set();     // File.open writers of this run (every interpreter)
      this.fileFault = null;        // a background flush failure, raised by the next file built-in
      this.fileTimer = null;
      this.fileBusy = false;
      this.changedPosted = new Set();
      this.macroPaths = [];         // getInfo("macro.filepath") inside runMacro(file)
      this.pendingNested = null;    // run("Run...", …): the macro file the run() statement runs next
      this.redirectErrors = false;  // IJ.redirectErrorMessages()
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
        this.rm = { list, selected: Array.isArray(r.selected) ? r.selected.slice() : [], showAll: !!r.showAll, labels: !!r.labels, open: !!r.open };
      }
      if (m.tables && typeof m.tables === 'object') {
        const next = new Map();
        for (const name of Object.keys(m.tables)) {
          const t = m.tables[name];
          if (t && t.same === true) { if (this.tables.has(name)) next.set(name, this.tables.get(name)); }
          else if (t && typeof t === 'object') {
            const c = cloneTable(Object.assign({ name }, t));
            // ResultsTable.showRowNumbers lives in the run (the page's tables do not carry it)
            const old = this.tables.get(name);
            if (t.showRowNumbers === undefined && old && old.showRowNumbers === true) c.showRowNumbers = true;
            next.set(name, c);
          }
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
      if (m.front !== undefined) this.front = m.front && typeof m.front === 'object' ? { kind: String(m.front.kind), title: String(m.front.title) } : null;
      this.P = null;
    }

    // ---------------------------------------------------------------- write-behind
    write(op, args) {
      if (WRITE_OPS.indexOf(op) < 0) throw ijError('IJ_INTERNAL', 'write op ' + op);
      if (op === 'table.show') this.front = { kind: 'table', title: args.name };
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
          'IJ.currentMemory', 'IJ.maxMemory', 'IJ.getToolName', 'IJ.renameResults', 'Array.show', 'IJ.redirectErrorMessages']),
        call(name, args) { return hostCall(M, name, args); },
        showMessage(title, text) { return M.rpc('dialog.message', { title: String(title), text: String(text) }).then(() => undefined); },
        showError(text) { return M.rpc('error.show', { text: String(text) }).then(() => undefined); },
        printToWindow(title, text) { M.front = { kind: 'text', title: String(title) }; return M.rpc('window.print', { title: String(title), text: String(text) }).then(() => undefined); },
        runMacroFile(path, arg) { return macroFileSource(M, path, arg).then((src) => (src ? src.text : null)); },
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
    let groupOpen = false, poll = null, res = null, endError = null, files = { error: null, changedRoots: [] };
    try {
      await openRunFiles(M, a);
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
      // the writers reach their files before the end of the run is published (F15), also after an error or an abort
      try { files = await endRunFiles(M); } catch (err) { console.error('[advanced-studio] macro files', err); }
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
    const changedDocs = Array.from(new Set(Array.from(M.changed).concat(Array.from(M.savedDocs), undo && Array.isArray(undo.changed) ? undo.changed : [])));
    const prefsWrites = {};
    for (const [k, v] of M.prefsWrites) prefsWrites[k] = v;
    let error = res ? res.error : null;
    // an engine failure at the end of the run is technical: the page shows its own sentence for an "Internal error"
    if (!error && endError) error = { message: 'Internal error: ' + String(endError.message || endError), line: 0, lineText: null, excerpt: null, calledFrom: [], silent: false, dialogText: null };
    // a buffered write that failed after the last statement (quota, permission) is the run's error
    const filesError = !error && !!files.error && !M.ctrl.signal.aborted;
    if (filesError) error = { message: files.error, line: 0, lineText: null, excerpt: null, calledFrom: [], silent: false, dialogText: null };
    return {
      ok: !!(res && res.ok) && !endError && !filesError, aborted: !!(res && res.aborted) || M.ctrl.signal.aborted, exited: !!(res && res.exited),
      error, prefsWrites, changedDocs, undo: { changed: undo && Array.isArray(undo.changed) ? undo.changed : [], dropped: undo && Array.isArray(undo.dropped) ? undo.dropped : [] },
      vfs: { needs: M.vfsNeeds.slice(), changedRoots: files.changedRoots || [] }
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
        // a string ({ s }), a whole array ({ a }: roiManager("select", newArray(…)), Functions.isArrayArg) or a number
        case 'x': out.push(f.isArrayArg() ? { a: yield* f.getNumericArray() } : f.isStringArg() ? { s: yield* f.getString() } : yield* it.getExpression()); break;
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
        case 'x': out.push(f.isArrayArg() ? { a: f.getNumericArray$s() } : f.isStringArg() ? { s: f.getString$s() } : it.getExpression$s()); break;
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
  /* ResultsTable.setValue: "if ((int)value!=value && !Double.isNaN(value)) decimalPlaces[column] = (short)precision" — a column that
   * once held a non-integer prints every cell (an unset one is 0) with `precision` decimals from then on. t.dec records the worker's
   * own writes; a table from the page or a file carries no record and is judged from its first 24 rows (addValue: "if (counter<25)"). */
  function markDecimal(t, h, v) {
    if (typeof v === 'number' && v === v && d2i(v) !== v) { if (!t.dec) t.dec = {}; t.dec[h] = true; }
  }
  function decimalColumn(t, h) {
    if (!t || h === undefined) return false;
    if (t.dec && t.dec[h] === true) return true;
    const col = t.columns && t.columns[h];
    if (!col) return false;
    for (let i = 0, n = Math.min(t.size, 24); i < n; i++) { const v = col[i]; if (typeof v === 'number' && v === v && d2i(v) !== v) return true; }
    return false;
  }
  /* ResultsTable.getValueAsString of a numeric cell: the column's decimal places once set, else AUTO_FORMAT (a whole number without
   * decimals, else `precision` decimals). t / h: the cell's table and column. */
  function cellString(M, v, t, h) {
    if (typeof v === 'string') return v;
    if (v === null || v === undefined) v = 0;
    const IJAna = root.IJAna;
    const prec = M.measurements && Number.isInteger(M.measurements.decimals) ? M.measurements.decimals : 3;
    if (IJAna && typeof IJAna.d2s === 'function' && decimalColumn(t, h)) return IJAna.d2s(v, prec);
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
    const im = M.images.get(M.current);
    if (im) M.front = { kind: 'image', title: im.title };
  }
  async function adopt(M, info) {
    const r = await M.rpc('image.adopt', { docId: info.docId });
    if (!M.images.has(info.docId)) {
      M.images.set(info.docId, imageEntry(info, r && typeof r.id === 'number' ? r.id : 0));
      M.order.push(info.docId);
    }
    M.current = info.docId;
    M.P = null;
    if (!info.hidden) M.front = { kind: 'image', title: info.name };
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
    if (status === 'file') { await runFileOp(f, M, r.file || {}, { viaMacroRun: true }); return; }
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
      case 'IJ.checksum': return checksumFile(M, String(args[0]), String(args[1]));
      case 'IJ.redirectErrorMessages': M.redirectErrors = true; return null;
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
    for (let i = 0; i < t.size; i++) s += (i + 1) + '\t' + t.headings.map((h) => cellString(M, t.columns[h][i], t, h)).join('\t') + '\n';
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
    installFiles();
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
      // run("Run...", …): Macro_Runner runs the file now, in this run (same lane, same undo group)
      if (M.pendingNested) { const n = M.pendingNested; M.pendingNested = null; yield* runNestedFile(f, M, n.source, n.arg, n.path); }
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
        if (M.textWins.has(x.s)) return 1;
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
      M.front = { kind: M.tables.has(title) ? 'table' : title === 'Log' ? 'log' : 'text', title };
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
        for (const name of M.textWins) if (out.indexOf(name) < 0) out.push(name);
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
      // new Roi(double…) keeps sub-pixel bounds (RoiEncoder writes them, option SUB_PIXEL_RESOLUTION)
      setSelection(M, im.docId, w <= 0 || h < 0 ? null : { type: 'rect', x, y, w, h, subPixel: true });
      return null;
    });
    defSync('do', 'makeOval', 'nnnn', (f, a, M) => {
      const im = img(f, M);
      const [x, y, w, h] = a;
      setSelection(M, im.docId, w <= 0 || h < 0 ? null : { type: 'oval', x, y, w, h, subPixel: true });
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
      const windowNames = ['Log', 'ROI Manager', 'Threshold', 'B&C', 'Results'].concat(Array.from(M.tables.keys()), Array.from(M.textWins));
      const done = new Set();
      for (const w of windowNames) {
        if (done.has(w)) continue;
        const match = wild ? wildMatch(w, pattern) : (w.toLowerCase() === lc);
        if (!match) continue;
        done.add(w);
        await M.rpc('window.close', { title: w });
        if (M.tables.has(w) && w !== 'Results') M.tables.delete(w);
        M.textWins.delete(w);
        if (M.front && M.front.kind === 'text' && M.front.title === w) M.front = null;
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
    if (lk === 'image.description') { img(f, M); return ''; }
    if (lk === 'image.filename' || lk === 'image.directory') {
      const im = img(f, M);
      if (!im.file) return '';
      return lk === 'image.filename' ? String(im.file.name || '') : String(im.file.dir || '');
    }
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
    // a text window in front (F20 puts a text file in a text window where ImageJ opens an Editor): TextWindow's "Text"
    if (lk === 'window.type') return M.front && M.front.kind === 'text' ? 'Text' : M.images.size ? 'Image' : '';
    if (lk === 'window.title' || lk === 'window.name') {
      if (M.front && M.front.title) return M.front.title;
      const im = M.images.get(M.current);
      return im ? im.title : '';
    }
    if (lk === 'macro.filepath') return M.macroPaths.length ? M.macroPaths[M.macroPaths.length - 1] : MOUNT.macroFile !== null ? MOUNT.macroFile : 'null';
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
    if (t.headings.indexOf(column) >= 0) return cellString(M, t.columns[column][row], t, column);
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
      markDecimal(t, r.column, col[r.row]);
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
    const columnHeadings = (t) => (t.showRowNumbers === true ? ' \t' : '') + t.headings.join('\t');
    const rowNumbersOf = (f, M, title, on) => {
      const t = tableFor(f, M, title);
      if (on) t.showRowNumbers = true; else delete t.showRowNumbers;
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
      // ResultsTable.getColumnHeadings: " " + delimiter first when the table shows row numbers
      headings: { raw: function* (f, M) { return columnHeadings(tableFor(f, M, yield* titleArg(f))); }, raw$s: (f, M) => columnHeadings(tableFor(f, M, titleArg$s(f))) },
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
        for (let i = 0; i < t.size; i++) { col[i] = i < vals.length ? vals[i] : 0; if (i < vals.length) markDecimal(t, a[0], col[i]); }
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
        if (t.dec) delete t.dec[a[0]];
        touchTable(M, t);
        return null;
      } },
      renameColumn: { sig: 'ss?s', sync: (f, a, M) => {
        const t = tableFor(f, M, a.length > 2 ? a[2] : null);
        const i = t.headings.indexOf(a[0]);
        if (i < 0) { f.interp.error('"' + a[0] + '" column not found'); return null; }
        if (t.headings.indexOf(a[1]) >= 0) { f.interp.error('"' + a[1] + '" column exists'); return null; }
        t.headings[i] = a[1]; t.columns[a[1]] = t.columns[a[0]]; delete t.columns[a[0]];
        if (t.dec && t.dec[a[0]]) { t.dec[a[1]] = true; delete t.dec[a[0]]; }
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
      showRowNumbers: { sig: 'n?s', sync: (f, a, M) => rowNumbersOf(f, M, a.length > 1 ? a[1] : null, a[0] !== 0) },
      showRowIndexes: { sig: 'n?s', sync: (f, a, M) => rowNumbersOf(f, M, a.length > 1 ? a[1] : null, a[0] !== 0) },
      hideRowNumbers: { sig: '?s', sync: (f, a, M) => rowNumbersOf(f, M, a.length ? a[0] : null, false) },
      saveColumnHeader: { sig: 'n?s', sync: () => null },
      setLocationAndSize: { sig: 'nnnn?s', sync: () => null },
      setLocAndSize: { sig: 'nnnn?s', sync: () => null },
      getSelectionStart: { sig: '?s', sync: () => -1 },
      getSelectionEnd: { sig: '?s', sync: () => -1 },
      setSelection: { sig: 'nn?s', sync: () => null },
      applyMacro: { sig: 's?s', sync: (f, a, M) => { f.interp.error(M.tr('err.macNotInBrowser', { name: 'Table.applyMacro' })); return null; } },
      save: { sig: 's?s', async: (f, a, M) => tableSave(f, M, a[0], a.length > 1 ? a[1] : null) },
      open: { sig: 's?s', async: (f, a, M) => tableOpen(f, M, a[0], a.length > 1 ? a[1] : null) },
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
        if (arg && typeof arg === 'object' && Array.isArray(arg.a)) {
          // Functions.setMultipleIndexes → RoiManager.setSelectedIndexes (the image's selection is left as it is)
          const idxs = arg.a.map((v) => d2i(v));
          for (const i of idxs) if (i < 0 || i >= list.length) throw macroError('Invalid index: ' + i);
          M.rm.selected = idxs;
          M.write('rm.select', { indices: idxs.slice() });
          return NaN;
        }
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
      case 'open': return rmOpen(M, typeof argS === 'string' ? argS : '');
      case 'save': return rmSave(M, typeof argS === 'string' ? argS : '', false);
      case 'save selected': return rmSave(M, typeof argS === 'string' ? argS : '', true);
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
    // GenericDialog.addDirectoryField / addFileField: a string field with a Browse… button (FILES.md §6.6)
    const pathField = (pathKind) => (f, a, M) => {
      need(f, M);
      add(M, { type: 'path', label: a[0], value: a[1], pathKind, columns: a.length > 2 ? d2i(a[2]) : 20 }, 'string');
      return null;
    };
    return {
      create: { sig: 's', sync: create },
      createNonBlocking: { sig: 's', sync: create },
      addString: { sig: 'ss?n', sync: (f, a, M) => { need(f, M); add(M, { type: 'string', label: a[0], value: a[1], columns: a.length > 2 ? d2i(a[2]) : 8 }, 'string'); return null; } },
      addDirectory: { sig: 'ss?n', sync: pathField('directory') },
      addFile: { sig: 'ss?n', sync: pathField('file') },
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
      addImage: { sig: 's', sync: (f, a, M) => { need(f, M); f.interp.error(M.tr('err.macNotInBrowser', { name: 'Dialog.addImage' })); return null; } },
      addToSameRow: { sig: '', sync: (f, a, M) => { need(f, M); return null; } },
      enableYesNoCancel: { sig: 'ss', sync: (f, a, M) => { f.interp.error(M.tr('err.macNotInBrowser', { name: 'Dialog.enableYesNoCancel' })); return null; } },
      setLocation: { sig: 'nn', sync: (f, a, M) => { need(f, M); return null; } },
      getLocation: { sig: 'vv', sync: (f, a, M) => { need(f, M); a[0].setValue(0); a[1].setValue(0); return null; } },
      show: { sig: '', async: async (f, a, M) => {
        const d = need(f, M);
        const fields = d.fields.map((x) => {
          const o = { id: x.id, type: x.type, label: x.label, value: x.value };
          for (const k of ['decimals', 'min', 'max', 'step', 'options', 'columns', 'units', 'pathKind']) if (x[k] !== undefined) o[k] = x[k];
          return o;
        });
        const r = await M.rpc('dialog.show', { title: d.title, fields, cancel: d.cancel });
        if (!r || r.cancelled) throw new MacroCancel('abort');
        // a Browse… of a path field granted a folder or a file: the worker can use it at once
        if (r && Array.isArray(r.grants) && M.vfs) for (const g of r.grants) { try { M.vfs.addGrant(g); } catch (err) { console.error('[advanced-studio] macro grant', err); } }
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
  // Bio-Formats files: refused by open() before any read (FILES.md §8.5)
  const BIO_EXT = /\.(ims|czi|lif|nd2|lsm|oib|oif|vsi|zvi|nd|lei|sld|scn|svs|mvd2|ome\.tiff?)$/i;
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

  // ════════════════════════════════════════════════════════════════════════════════════════════════
  //  Files (DOCS/studio-advanced/macros/FILES.md): the file built-ins and the run() file commands, on the virtual file system
  // ════════════════════════════════════════════════════════════════════════════════════════════════
  //
  // Every path a macro writes is virtual (/<Root>/…, FILES.md §2): IJMacroVFS (ij-macro-vfs.js, loaded before this file in the
  // worker) resolves it, enforces the per-root policy and holds the three backends. A VFS answer is a value or a Promise: an OPFS,
  // snapshot or virtual root answers synchronously, so the built-ins below chain with mp() and only wait when a backend does.
  // No path of the user's machine is ever printed unless the macro itself wrote it.

  const VFSLIB = () => (typeof IJMacroVFS !== 'undefined' ? IJMacroVFS : (root.IJMacroVFS || null));
  const isThen = (x) => x !== null && (typeof x === 'object' || typeof x === 'function') && typeof x.then === 'function';
  function mp(v, fn) { return isThen(v) ? v.then(fn) : fn(v); }
  const isVfsError = (e) => !!e && typeof e.code === 'string' && e.code.indexOf('VFS_') === 0;
  const vfsDetails = (e) => Object.assign({}, e || {}, e && e.details && typeof e.details === 'object' ? e.details : {});
  const HOME = '/home/';
  const UTF8 = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;
  const utf8 = (s) => UTF8.encode(String(s));
  const utf8Text = (u8) => new TextDecoder('utf-8', { ignoreBOM: true }).decode(u8);
  function latin1Text(u8) {
    let s = '';
    for (let i = 0; i < u8.length; i += 8192) s += String.fromCharCode.apply(null, u8.subarray(i, Math.min(u8.length, i + 8192)));
    return s;
  }

  // OpenDialog / SaveDialog statics (F13): ImageJ keeps them as long as it runs; here as long as one Studio mount.
  // macroFile = Macro_Runner's static filePath: the last macro file run, still answered by getInfo("macro.filepath") after it ends
  const MOUNT = { id: null, defaultDir: null, lastDir: null, lastName: null, macroFile: null };
  function enterMount(id) {
    if (typeof id !== 'string' || !id || id === MOUNT.id) return;
    MOUNT.id = id; MOUNT.defaultDir = null; MOUNT.lastDir = null; MOUNT.lastName = null; MOUNT.macroFile = null;
  }
  /** The base of a relative path for Opener.makeFullPath (the OpenDialog default directory, else user.dir). */
  const openerBase = () => MOUNT.defaultDir || HOME;

  // ---------------------------------------------------------------- the VFS of a run (or of a macro.vfs request)
  /* FileSaver.saveAsLut: reds[256], greens[256], blues[256] from a 768-byte RGB-interleaved IJLuts table. */
  function lutFileBytes(t) {
    if (root.IJLutFile && typeof root.IJLutFile.write === 'function') return root.IJLutFile.write(t);
    const p = new Uint8Array(768);
    for (let i = 0; i < 256; i++) { p[i] = t[i * 3]; p[256 + i] = t[i * 3 + 1]; p[512 + i] = t[i * 3 + 2]; }
    return p;
  }
  function lutFilesOf() {
    const L = root.IJLuts;
    if (!L || typeof L.names !== 'function') return [];
    const out = [];
    for (const name of L.names()) {
      let t = null;
      try { t = L.get(name); } catch (_) { t = null; }
      if (t && t.length === 768) out.push({ name: name + '.lut', bytes: lutFileBytes(t) });
    }
    return out;
  }
  function vfsContext(v, onFirstOverlayWrite) {
    const nav = root.navigator;
    return {
      roots: Array.isArray(v.roots) ? v.roots : [],
      aliases: Array.isArray(v.aliases) ? v.aliases : [],
      mountId: typeof v.mountId === 'string' ? v.mountId : (MOUNT.id || ''),
      opfs: nav && nav.storage && typeof nav.storage.getDirectory === 'function' ? () => nav.storage.getDirectory() : null,
      lutFiles: lutFilesOf,
      onFirstOverlayWrite: typeof onFirstOverlayWrite === 'function' ? onFirstOverlayWrite : () => {},
      now: () => Date.now()
    };
  }
  /** Opens the run's VFS before the macro starts (FILES.md §8.9). A failure is kept and raised by the first file built-in. */
  async function openRunFiles(M, a) {
    const V = VFSLIB();
    if (!V || typeof V.open !== 'function') return;
    const v = a.vfs && typeof a.vfs === 'object' ? a.vfs : {};
    enterMount(v.mountId);
    try {
      M.vfs = V.open(vfsContext(v, (rootId) => {
        try { M.E.postEvent({ event: 'macro.vfs', runId: M.runId, type: 'firstOverlayWrite', rootId }); } catch (err) { console.error('[advanced-studio] macro vfs event', err); }
      }));
      await M.vfs.prepare();
    } catch (err) {
      if (!isVfsError(err)) console.error('[advanced-studio] macro file system', err);
      M.vfsFault = err;
      if (M.vfs) { try { await M.vfs.close(); } catch (_) { /* nothing was opened */ } }
      M.vfs = null;
    }
    M.fileTimer = setInterval(() => fileTick(M), FLUSH_MS);
  }
  /* The `changed` event of every overlay root this run wrote in that the page has not been told about yet. */
  function postChanged(M) {
    if (!M.vfs || typeof M.vfs.changedRoots !== 'function') return [];
    let roots = [];
    try { roots = M.vfs.changedRoots() || []; } catch (_) { roots = []; }
    for (const rootId of roots) {
      if (M.changedPosted.has(rootId)) continue;
      M.changedPosted.add(rootId);
      try { M.E.postEvent({ event: 'macro.vfs', runId: M.runId, type: 'changed', rootId }); } catch (err) { console.error('[advanced-studio] macro vfs event', err); }
    }
    return roots.slice();
  }
  /* The 250 ms tick (F15): the buffered writers reach their files and the overlay manifests are written. A failure is raised by the
   * next file built-in (or at the end of the run). */
  function fileTick(M) {
    if (M.fileBusy || !M.vfs || M.ending) return;
    M.fileBusy = true;
    Promise.resolve()
      .then(() => flushWriters(M, 'tick'))
      .then(() => (M.vfs ? M.vfs.flush() : null))
      .then(() => { postChanged(M); }, (err) => { if (!M.fileFault) M.fileFault = err; })
      .then(() => { M.fileBusy = false; });
  }
  /** The end of a run (normal, error or abort): the writers are flushed, every handle closed. → { error: text | null, changedRoots }. */
  async function endRunFiles(M) {
    if (M.fileTimer) { clearInterval(M.fileTimer); M.fileTimer = null; }
    let text = null;
    const note = (err) => {
      if (text !== null || err instanceof MacroCancel) return;
      text = isVfsError(err) ? vfsText(M, err, err.path || '') : (err && err.macroText !== undefined ? err.macroText : null);
      if (text === null) { console.error('[advanced-studio] macro files at the end of the run', err); text = ''; }
    };
    if (M.fileFault) { note(M.fileFault); M.fileFault = null; }
    if (M.vfs) {
      // an aborted run cannot ask the operator anything: a write that needs a confirmation is not made
      try { await flushWriters(M, M.ctrl.signal.aborted); } catch (err) { note(err); }
      for (const w of M.writers) { w.chunks = []; w.bytes = 0; }
    }
    const changedRoots = postChanged(M);
    if (M.vfs) {
      try { await M.vfs.close(); } catch (err) { note(err); }
    }
    return { error: text === '' ? null : text, changedRoots };
  }

  // ---------------------------------------------------------------- buffered writers (File.open + print(f, …))
  /* An in-place Chromium folder copies the whole file into a new swap file at each append (createWritable keepExistingData): there a
   * tick flushes a writer only once it holds SLOW_FLUSH_BYTES or its last flush is SLOW_FLUSH_MS old (FILES.md F15). */
  const SLOW_FLUSH_BYTES = 1048576, SLOW_FLUSH_MS = 5000;
  function makeWriter(M, vpath, shown) {
    let slow = false;
    try { slow = !!(M.vfs && typeof M.vfs.slowAppend === 'function' && M.vfs.slowAppend(vpath)); } catch (_) { slow = false; }
    const w = {
      vpath, shown, chunks: [], bytes: 0, slow, flushedAt: now(),
      // the language's print(f, s) calls this synchronously (FILES.md §16 L1): it never suspends
      print(text) { const b = utf8(text); if (b.length) { w.chunks.push(b); w.bytes += b.length; } }
    };
    M.writers.add(w);
    return w;
  }
  /* background: no operator question (a tick, or the end of an aborted run): a write that needs one waits for the next file
   * built-in. 'tick': the 250 ms tick, which also lets a slow append target wait (SLOW_FLUSH_*). */
  function flushWriters(M, background) {
    let chain = null;
    for (const w of M.writers) {
      if (!w.chunks.length) continue;
      if (background === 'tick' && w.slow && w.bytes < SLOW_FLUSH_BYTES && now() - w.flushedAt < SLOW_FLUSH_MS) continue;
      const step = () => {
        if (!w.chunks.length) return null;
        const data = w.chunks, n = w.bytes;
        w.chunks = []; w.bytes = 0; w.flushedAt = now();
        const put = () => M.vfs.write(w.vpath, data, { append: true });
        const back = (err) => { w.chunks = data.concat(w.chunks); w.bytes += n; throw err; };
        // a tick cannot ask the operator: a write that needs a confirmation waits, whole, for the next foreground flush
        const onError = (err) => {
          if (background && err && err.code === 'VFS_ASK') { w.chunks = data.concat(w.chunks); w.bytes += n; return null; }
          return back(err);
        };
        let r;
        try { r = background ? put() : fsDo(M, put); } catch (err) { return onError(err); }
        return isThen(r) ? r.then(null, onError) : r;
      };
      chain = chain ? mp(chain, step) : step();
    }
    return chain;
  }
  function dropWriter(M, w) { M.writers.delete(w); }

  // ---------------------------------------------------------------- errors (FILES.md §8.1, F12)
  function formatBytes(n) {
    const V = VFSLIB();
    if (V && typeof V.formatBytes === 'function') return V.formatBytes(n);
    return String(n) + ' B';
  }
  /* The run stopped on a machine path: the page offers the folder in its Files section (result.vfs.needs). */
  function noteNeed(M, d) {
    const literal = typeof d.literal === 'string' ? d.literal : '';
    if (!literal || M.vfsNeeds.some((x) => x.literal === literal)) return;
    M.vfsNeeds.push({ kind: 'alias', literal, prefixes: Array.isArray(d.prefixes) ? d.prefixes.slice() : [] });
  }
  /** The macro error a VfsError stands for, or null for a condition the Java call reports itself (a return value or its own text). */
  function vfsText(M, e, shown) {
    const d = vfsDetails(e);
    const p = shown || (typeof d.path === 'string' ? d.path : '');
    switch (e.code) {
      case 'VFS_NOT_GRANTED': noteNeed(M, d); return M.tr('err.macFolderNotGranted', { path: d.literal || p });
      case 'VFS_STALE': return M.tr('err.macFolderStale', { name: d.root || '' });
      case 'VFS_READ_ONLY': return M.tr('err.macReadOnly', { path: p });
      case 'VFS_PERMISSION': return M.tr('err.macPermission', { name: d.root || '' });
      case 'VFS_QUOTA': return M.tr('err.macQuota', { written: formatBytes(d.written || 0), free: formatBytes(d.free || 0) });
      case 'VFS_NO_STORAGE': return M.tr('err.macNoStorage', { path: p });
      case 'VFS_GONE': return M.tr('err.macFileGone', { path: p });
      case 'VFS_BUSY': return M.tr('err.macFileBusy', { path: p });
      case 'VFS_TOO_LARGE': return M.tr('err.macFileTooLarge', { path: p });
      case 'VFS_ROOT_DELETE': return M.tr('err.macRootDelete', { path: p });
      default: return null;
    }
  }
  /** Rethrows `e` as what the macro sees: a macro error for the conditions of §8.1, the VfsError itself for the caller's Java rule. */
  function fsFail(M, e, shown) {
    if (e instanceof MacroCancel || (e && e.macroText !== undefined)) throw e;
    if (isVfsError(e)) {
      const t = vfsText(M, e, shown);
      if (t !== null) throw macroError(t);
    }
    throw e;
  }
  /* Java's I/O exception text on the platform the macro sees (F5): "<path> (No such file or directory)" … */
  function javaIoText(code, p) {
    const why = code === 'VFS_IS_A_DIR' ? 'Is a directory'
      : (code === 'VFS_BAD_NAME' || code === 'VFS_BAD_PATH') ? 'Invalid argument'
      : (code === 'VFS_NOT_FOUND' || code === 'VFS_NOT_A_DIR') ? 'No such file or directory' : 'Permission denied';
    return p + ' (' + why + ')';
  }
  /* A failure that is not a VfsError (a defect of a backend, a codec) is logged and shown as Java would show an I/O failure. */
  function asJavaCode(e) {
    if (isVfsError(e)) return e.code;
    console.error('[advanced-studio] macro file operation', e);
    return 'VFS_IO';
  }

  /** One VFS operation under the root's policy (§7.2) and permission (§3.5): VFS_ASK waits for vfs.confirm, VFS_PERMISSION for
   *  vfs.regrant, then the operation runs again. Any other failure is the caller's. */
  function fsDo(M, op, tries) {
    const n = tries || 0;
    const retry = (e) => {
      if (e && e.code === 'VFS_ASK') return confirmWrite(M, vfsDetails(e)).then(() => fsDo(M, op, n));
      if (e && e.code === 'VFS_PERMISSION' && n < 2) return regrantRoot(M, vfsDetails(e)).then(() => fsDo(M, op, n + 1));
      throw e;
    };
    let r;
    try { r = op(); } catch (e) { return retry(e); }
    return isThen(r) ? r.then(null, retry) : r;
  }
  function confirmWrite(M, d) {
    const args = { rootId: d.rootId, root: d.root, action: d.action, path: d.path };
    if (d.to !== undefined) args.to = d.to;
    return M.rpc('vfs.confirm', args).then((r) => {
      const c = r && r.choice;
      if (c === 'allow') { M.vfs.allow(d.rootId); return; }
      if (c === 'abort') throw new MacroCancel('abort');
      throw macroError(M.tr('err.macWriteRefused', { path: d.path }));
    });
  }
  function regrantRoot(M, d) {
    return M.rpc('vfs.regrant', { rootId: d.rootId, root: d.root, mode: d.mode === 'readwrite' ? 'readwrite' : 'read' }).then((r) => {
      if (r && r.ok === true && r.grant) { M.vfs.addGrant(r.grant); return; }
      throw macroError(M.tr('err.macPermission', { name: d.root || '' }));
    });
  }
  /**
   * attempt(M, shown, op, onJava): op() under fsDo; a VfsError of §8.1 becomes its macro error, any other failure goes to
   * onJava(code) (the Java call's own answer: a return value, or a throw of its text). Value or Promise.
   */
  function attempt(M, shown, op, onJava) {
    const fail = (e) => {
      if (e instanceof MacroCancel || (e && e.macroText !== undefined)) throw e;
      if (isVfsError(e) && vfsText(M, e, shown) !== null) return fsFail(M, e, shown);
      if (onJava) return onJava(asJavaCode(e), e);
      return fsFail(M, e, shown);
    };
    let r;
    try { r = fsDo(M, op); } catch (e) { return fail(e); }
    return isThen(r) ? r.then(null, fail) : r;
  }

  /** The run's VFS; a failure kept from the start or from a background flush is raised here (§8.9). */
  function vfsOf(M, shown) {
    const raise = (e) => {
      const t = isVfsError(e) ? vfsText(M, e, (e.path || shown)) : null;
      if (t !== null) throw macroError(t);
      if (e && e.macroText !== undefined) throw e;
      throw macroError(javaIoText(asJavaCode(e), e && typeof e.path === 'string' ? e.path : shown));
    };
    if (M.fileFault) { const e = M.fileFault; M.fileFault = null; raise(e); }
    if (M.vfs) return M.vfs;
    if (M.vfsFault) raise(M.vfsFault);
    throw macroError(M.tr('err.macNoStorage', { path: shown }));
  }
  /* IJMacroVFS itself (it loads with the language: absent only where the macro package is half-loaded, as in some tests). */
  function needLib(M, s) {
    const V = VFSLIB();
    if (V) return V;
    if (/:\/\/|file:\//.test(String(s))) throw macroError(M.tr('err.macNetwork'));
    throw macroError(M.tr('err.macNoStorage', { path: String(s) }));
  }
  function norm(s) {
    const V = VFSLIB();
    return V ? V.normalizeSeparators(s) : String(s).replace(/\\/g, '/');
  }
  /** resolve(path) after §2.1, with the URL refusal first (§7.3). Throws a VfsError (BAD_PATH, NOT_GRANTED) or a macro error. */
  function resolveIn(M, path, base) {
    const s = norm(path);
    const V = VFSLIB();
    if (V && V.isUrl(s)) throw macroError(M.tr('err.macNetwork'));
    return vfsOf(M, s).resolve(s, { base });
  }
  /* stat of a resolved path; `/` (the list of roots) is a directory. */
  function statOf(M, r) {
    if (r.isTop) return { kind: 'dir', size: 0, mtime: 0 };
    return M.vfs.stat(r.vpath);
  }
  /* The whole content of a file (read with length -1), refused (VFS_TOO_LARGE) before anything is allocated when it would not fit
   * `factor` times in the engine's free memory (an image file is decoded beside its bytes); a file up to READ_FLOOR always reads. */
  const READ_FLOOR = 16 * 1048576;
  function readAll(M, vpath, factor) {
    const o = { offset: 0, length: -1 };
    const free = M.E && typeof M.E.freeBytes === 'function' ? Number(M.E.freeBytes()) : NaN;
    if (free === free) o.max = Math.max(READ_FLOOR, Math.floor(free / (factor > 1 ? factor : 1)));
    return M.vfs.read(vpath, o);
  }

  /** IJ.error(title, msg) reached from a built-in (F12): the message box then the macro stops quietly; with
   *  IJ.redirectErrorMessages() the message goes to the Log and an Open / Reader error does not stop the macro (IJ.error 1.54p). */
  function errorBox(M, title, msg, ctx) {
    if (ctx && ctx.viaMacroRun) return Promise.reject(macroError(msg));
    if (M.redirectErrors) {
      M.redirectErrors = false;
      M.log(title + ': ' + msg);
      if (title.indexOf('Open') >= 0 || title.indexOf('Reader') >= 0) return Promise.resolve(null);
      return Promise.reject(new MacroCancel('abort'));
    }
    return M.rpc('dialog.message', { title, text: msg }).then(() => { throw new MacroCancel('abort'); });
  }
  /** IJ.error(msg): the box titled "ImageJ", and the macro goes on (F12). */
  function errorBoxContinue(M, msg) {
    if (M.redirectErrors) { M.redirectErrors = false; M.log('ImageJ: ' + msg); return Promise.resolve(null); }
    return M.rpc('dialog.message', { title: 'ImageJ', text: msg }).then(() => null);
  }

  // ---------------------------------------------------------------- pickers (F11, FILES.md §6)
  /* SaveDialog.setExtension's split: the page shows defaultName + ext. */
  function splitDefault(name, ext) {
    let n = String(name || 'Untitled');
    const dot = n.lastIndexOf('.');
    if (dot > 0 && ext) n = n.substring(0, dot);
    return n;
  }
  /**
   * pick(M, kind, prompt, source, o) → the chosen vpath ('directory' ends with '/'). Cancel = Macro.abort (every 1.54p dialog).
   * An OpenDialog and a SaveDialog set lastDir / lastName (getDirectory / getFileName) and the default directory; a DirectoryChooser
   * nothing.
   */
  function pick(M, kind, prompt, source, o) {
    const args = { kind, prompt: String(prompt), source };
    if (o && o.defaultName !== undefined) args.defaultName = o.defaultName;
    if (o && o.ext !== undefined) args.ext = o.ext;
    return M.rpc('vfs.pick', args).then((r) => {
      if (!r || r.cancelled || typeof r.vpath !== 'string' || !r.vpath) throw new MacroCancel('abort');
      if (r.grant && M.vfs) M.vfs.addGrant(r.grant);
      const V = VFSLIB();
      const vpath = V ? V.normalizeSeparators(r.vpath) : r.vpath;
      if (kind !== 'directory') {
        const slash = vpath.lastIndexOf('/');
        const dir = vpath.substring(0, slash + 1), name = vpath.substring(slash + 1);
        MOUNT.defaultDir = dir;
        MOUNT.lastDir = dir; MOUNT.lastName = name;
      }
      return vpath;
    });
  }
  /** OpenDialog.lookupPathVariable / SaveDialog.isMacro: a path option with no '.' that names a string variable is its value. */
  function lookupPathVariable(f, path) {
    if (path === null || path === undefined || path.indexOf('.') !== -1) return path;
    const name = path.charAt(0) === '&' ? path.substring(1) : path;
    const v = f && f.interp ? findVariable(f.interp, name) : null;
    const s = v && v.getArray() === null ? v.getString() : null;
    return s !== null && s !== undefined ? s : path;
  }

  // ---------------------------------------------------------------- Java File on a string (pure, §2.4)
  const jName = (s) => VFSLIB().javaName(norm(s));
  const jParent = (s) => VFSLIB().javaParent(norm(s));
  /* Date.toString(): "EEE MMM dd HH:mm:ss zzz yyyy" in the local zone. */
  function javaDate(ms) {
    const d = new Date(ms);
    const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const p2 = (n) => (n < 10 ? '0' : '') + n;
    let zone = 'UTC';
    try {
      const parts = new Intl.DateTimeFormat('en-US', { timeZoneName: 'short' }).formatToParts(d);
      const z = parts.find((x) => x.type === 'timeZoneName');
      if (z) zone = z.value;
    } catch (_) { zone = 'UTC'; }
    const m = /^GMT([+-])(\d{1,2})(?::(\d{2}))?$/.exec(zone);
    if (m) zone = 'GMT' + m[1] + p2(+m[2]) + ':' + (m[3] || '00');
    return DAYS[d.getDay()] + ' ' + MONTHS[d.getMonth()] + ' ' + p2(d.getDate()) + ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes()) + ':' +
      p2(d.getSeconds()) + ' ' + zone + ' ' + d.getFullYear();
  }

  // ---------------------------------------------------------------- File.* (Functions.doFile 1.54p, its order kept)
  const WRITER_SUFFIXES = ['.txt', '.java', '.xls', '.csv', '.tsv', '.ijm', '.html', '.htm'];
  /* the members that may wait for a backend or the operator (the others never suspend) */
  const FILE_SUSPENDS = Object.freeze({ open: true, openAsString: true, openAsRawString: true, openDialog: true, close: true, rename: true,
    copy: true, append: true, saveString: true, getLength: true, length: true, exists: true, isDirectory: true, isFile: true,
    makeDirectory: true, mkdir: true, lastModified: true, dateLastModified: true, delete: true });

  function fileMemberName(it) {
    it.getToken();
    if (it.token !== DOT) it.error("'.' expected");
    it.getToken();
    if (!(it.token === WORD || it.token === K.STRING_FUNCTION || it.token === K.NUMERIC_FUNCTION || it.token === K.PREDEFINED_FUNCTION))
      it.error('Function name expected: ');
    return it.tokenString;
  }
  /* The members that need no file system: the same body for the generator and the fast path. */
  function filePure(f, M, name, arg) {
    const V = VFSLIB();
    const s = norm(arg);
    switch (name) {
      case 'getNameWithoutExtension': return V.getNameWithoutExtension(s);
      case 'getName': return V.javaName(s);
      case 'getDirectory': { const p = V.javaParent(s); return p !== null ? p + '/' : ''; }
      case 'getAbsolutePath': return V.javaAbsolute(s);
      case 'getParent': return V.javaParent(s);
      default: return undefined;
    }
  }
  const FILE_PURE_ARG = new Set(['getNameWithoutExtension', 'getName', 'getDirectory', 'getAbsolutePath', 'getParent']);

  function* fileGen(f) {
    const it = f.interp;
    const M = runOf(f);
    const name = fileMemberName(it);
    const V = VFSLIB();
    if (!V) { it.error(M.tr('err.macNotInBrowser', { name: 'File.' + name })); return ''; }
    switch (name) {
      case 'open': {
        if (f.writer !== null) { it.error('Currently, only one file can be open at a time'); return ''; }
        const path = yield* f.getFirstString();
        let defaultName = null;
        if (it.nextToken() === RP) it.getRightParen(); else defaultName = yield* f.getLastString();
        return yield* f.hostHook(() => fileOpenWriter(f, M, path, defaultName));
      }
      case 'openAsString': { const p = yield* f.getStringArg(); return yield* f.hostHook(() => openAsString(f, M, p)); }
      case 'openAsRawString': {
        const p = yield* f.getFirstString();
        let max = 5000, specified = false;
        if (it.nextToken() === COMMA) { max = d2i(yield* f.getNextArg()); specified = true; }
        it.getRightParen();
        return yield* f.hostHook(() => openAsRawString(f, M, p, max, specified));
      }
      case 'openUrlAsString': yield* f.getStringArg(); it.error(M.tr('err.macNetwork')); return '';
      case 'openDialog': {
        const title = yield* f.getStringArg();
        return yield* f.hostHook(() => pick(M, 'file', title, 'openDialog'));
      }
      case 'close': {
        const s = yield* f.getStringArg();
        if (s !== '~0~') it.error('Invalid file variable');
        return yield* f.hostHook(() => closeWriter(f, M));
      }
      case 'separator': it.getParens(); return '/';
      case 'directory': it.getParens(); return MOUNT.lastDir !== null ? MOUNT.lastDir : '';
      case 'name': it.getParens(); return MOUNT.lastName !== null ? MOUNT.lastName : '';
      case 'nameWithoutExtension': it.getParens(); return MOUNT.lastName === null ? '' : V.nameWithoutExtension(MOUNT.lastName);
      case 'rename': {
        const a = yield* f.getFirstString();
        const b = yield* f.getLastString();
        checkPath(it, a); checkPath(it, b);
        return yield* f.hostHook(() => fileRename(M, a, b));
      }
      case 'copy': {
        const a = yield* f.getFirstString();
        const b = yield* f.getLastString();
        return yield* f.hostHook(() => fileCopy(M, a, b));
      }
      case 'append': case 'saveString': {
        const s = yield* f.getFirstString();
        const p = yield* f.getLastString();
        return yield* f.hostHook(() => writeString(M, name === 'append' ? s + '\n' : s, p, name === 'append'));
      }
      case 'openSequence': {
        yield* f.getFirstString();
        if (it.nextToken() === COMMA) yield* f.getNextString();
        it.getRightParen();
        it.error(M.tr('err.macRefused', { command: 'File.openSequence', reason: M.tr('err.macReasonSequence') }));
        return '';
      }
      default:
    }
    if (name.startsWith('setDefaultDir')) { MOUNT.defaultDir = V.addSeparator(norm(yield* f.getStringArg())); return null; }
    if (name.startsWith('getDefaultDir')) return MOUNT.defaultDir !== null ? MOUNT.defaultDir : '';
    const arg = yield* f.getStringArg();
    if (FILE_PURE_ARG.has(name)) return filePure(f, M, name, arg);
    switch (name) {
      case 'getLength': case 'length': case 'exists': case 'isDirectory': case 'isFile': case 'lastModified': case 'dateLastModified':
        return yield* f.hostHook(() => fileStat(M, name, arg));
      case 'makeDirectory': case 'mkdir': return yield* f.hostHook(() => fileMkdir(M, arg));
      case 'delete': return yield* f.hostHook(() => fileDelete(M, arg));
      default: it.error('Unrecognized File function ' + name); return null;
    }
  }
  function fileSync(f) {
    const it = f.interp;
    const M = runOf(f);
    const name = fileMemberName(it);
    const V = VFSLIB();
    if (!V) { it.error(M.tr('err.macNotInBrowser', { name: 'File.' + name })); return ''; }
    if (FILE_SUSPENDS[name]) throw ijError('IJ_INTERNAL', 'a waiting File member ran in the fast path');
    switch (name) {
      case 'openUrlAsString': f.getStringArg$s(); it.error(M.tr('err.macNetwork')); return '';
      case 'separator': it.getParens(); return '/';
      case 'directory': it.getParens(); return MOUNT.lastDir !== null ? MOUNT.lastDir : '';
      case 'name': it.getParens(); return MOUNT.lastName !== null ? MOUNT.lastName : '';
      case 'nameWithoutExtension': it.getParens(); return MOUNT.lastName === null ? '' : V.nameWithoutExtension(MOUNT.lastName);
      case 'openSequence': {
        f.getFirstString$s();
        if (it.nextToken() === COMMA) f.getNextString$s();
        it.getRightParen();
        it.error(M.tr('err.macRefused', { command: 'File.openSequence', reason: M.tr('err.macReasonSequence') }));
        return '';
      }
      default:
    }
    if (name.startsWith('setDefaultDir')) { MOUNT.defaultDir = V.addSeparator(norm(f.getStringArg$s())); return null; }
    if (name.startsWith('getDefaultDir')) return MOUNT.defaultDir !== null ? MOUNT.defaultDir : '';
    const arg = f.getStringArg$s();
    if (FILE_PURE_ARG.has(name)) return filePure(f, M, name, arg);
    it.error('Unrecognized File function ' + name);
    return null;
  }
  /* Functions.checkPath: new File(s).getPath() equal to "0" or "NaN" (a number passed where a path was meant). */
  function checkPath(it, s) {
    const p = norm(s).replace(/\/+/g, '/').replace(/(.)\/$/, '$1');
    if (p === '0' || p === 'NaN') it.error('Invalid path');
  }

  function fileStat(M, member, arg) {
    const shown = norm(arg);
    const answer = (st) => {
      switch (member) {
        case 'exists': return st ? '1' : '0';
        case 'isDirectory': return st && st.kind === 'dir' ? '1' : '0';
        case 'isFile': return st && st.kind === 'file' ? '1' : '0';
        case 'getLength': case 'length': return st && st.kind === 'file' ? String(st.size) : '0';
        case 'lastModified': return st ? String(Math.trunc(st.mtime)) : '0';
        default: return javaDate(st ? st.mtime : 0);
      }
    };
    return attempt(M, shown, () => mp(statOf(M, resolveIn(M, arg, HOME)), answer), () => answer(null));
  }
  function fileMkdir(M, arg) {
    const shown = norm(arg);
    return attempt(M, shown, () => mp(M.vfs.mkdir(resolveIn(M, arg, HOME).vpath), () => null), () => null);
  }
  function fileDelete(M, arg) {
    const shown = norm(arg);
    return attempt(M, shown, () => {
      const r = resolveIn(M, arg, HOME);
      if (r.isTop) return '0';
      return mp(M.vfs.remove(r.vpath), (b) => (b ? '1' : '0'));
    }, () => '0');
  }

  /* Functions.openFile: one PrintWriter per interpreter (f.writer), created / truncated now, flushed per F15. */
  function fileOpenWriter(f, M, path, defaultName) {
    const create = (p) => {
      const shown = norm(p);
      return attempt(M, shown, () => {
        const r = resolveIn(M, p, HOME);
        return mp(M.vfs.write(r.vpath, []), () => r.vpath);
      }, (code) => { throw macroError('File open error \n"' + javaIoText(code, shown) + '"\n'); });
    };
    let target;
    if (path === '' || defaultName !== null) {
      const title = defaultName !== null ? path : 'openFile';
      const dn = defaultName !== null ? defaultName : 'log.txt';
      target = pick(M, 'save', title, 'fileOpen', { defaultName: splitDefault(dn, '.txt'), ext: '.txt' }).then(create);
    } else {
      const shown = norm(path);
      target = mp(attempt(M, shown, () => mp(statOf(M, resolveIn(M, path, HOME)), (st) => !!st), () => false), (exists) => {
        if (exists && !WRITER_SUFFIXES.some((x) => path.endsWith(x))) throw macroError("File exists and suffix is not '.txt', '.java', etc.");
        return create(path);
      });
    }
    return mp(target, (vpath) => { f.writer = makeWriter(M, vpath, path === '' ? vpath : norm(path)); return '~0~'; });
  }
  function closeWriter(f, M) {
    const w = f.writer;
    if (!w) return null;
    f.writer = null;
    const r = flushWriters(M, false);
    const done = () => { dropWriter(M, w); return null; };
    return isThen(r) ? r.then(done, (e) => { dropWriter(M, w); return fsFail(M, e, w.shown); }) : done();
  }
  /* Functions.doFile rename: File.renameTo (same root only, never over an existing name) → "1" / "0". */
  function fileRename(M, a, b) {
    const shown = norm(a);
    return attempt(M, shown, () => {
      const ra = resolveIn(M, a, HOME), rb = resolveIn(M, b, HOME);
      return mp(M.vfs.rename(ra.vpath, rb.vpath), (ok) => (ok ? '1' : '0'));
    }, () => '0');
  }
  /* Tools.copyFile: "Source file does not exist", else the I/O exception's message. */
  function fileCopy(M, a, b) {
    const sa = norm(a), sb = norm(b);
    return attempt(M, sb, () => {
      const ra = resolveIn(M, a, HOME), rb = resolveIn(M, b, HOME);
      return mp(statOf(M, ra), (st) => {
        if (!st) throw macroError('Source file does not exist');
        if (st.kind === 'dir') throw macroError(javaIoText('VFS_IS_A_DIR', sa));
        return mp(M.vfs.copy(ra.vpath, rb.vpath), () => null);
      });
    }, (code) => {
      // File.createNewFile under a missing folder: the JVM's message carries no path
      if (code === 'VFS_NOT_FOUND' || code === 'VFS_NOT_A_DIR') throw macroError('No such file or directory');
      throw macroError(javaIoText(code, sb));
    });
  }
  /* IJ.saveString / IJ.append (IJ.write): a SaveDialog for '', the error is ""+e. */
  function writeString(M, text, path, append) {
    const go = (p) => {
      const shown = norm(p);
      return attempt(M, shown, () => mp(M.vfs.write(resolveIn(M, p, HOME).vpath, utf8(text), { append }), () => null),
        (code) => { throw macroError('java.io.FileNotFoundException: ' + javaIoText(code, shown)); });
    };
    if (path === '') return pick(M, 'save', append ? 'Append String...' : 'Save String...', append ? 'append' : 'saveString', { defaultName: 'Untitled', ext: '.txt' }).then(go);
    return go(path);
  }
  /* IJ.openAsString: BufferedReader.readLine + "\n" per line (UTF-8, a BOM kept). */
  function linesOf(u8) {
    const T = root.IJTextIo;
    if (T && typeof T.openAsStringText === 'function') return T.openAsStringText(u8);
    const text = utf8Text(u8);
    if (text === '') return '';
    const lines = text.split(/\r\n|\r|\n/);
    if (lines[lines.length - 1] === '') lines.pop();
    return lines.map((l) => l + '\n').join('');
  }
  /** IJ.openAsString(path) as Functions.openAsString uses it: "Error: …" strings become a macro error. */
  function openAsStringRaw(M, path, source) {
    const go = (p) => {
      const shown = norm(p);
      return attempt(M, shown, () => {
        const r = resolveIn(M, p, HOME);
        return mp(statOf(M, r), (st) => {
          if (!st) return 'Error: file not found';
          if (st.kind === 'dir') return 'Error: ' + javaIoText('VFS_IS_A_DIR', shown);
          return mp(readAll(M, r.vpath), linesOf);
        });
      }, (code) => 'Error: ' + javaIoText(code, shown));
    };
    if (path === '') return pick(M, 'file', 'Open Text File', source || 'openAsString').then(go);
    return go(path);
  }
  function openAsString(f, M, path) {
    return mp(openAsStringRaw(M, path), (str) => {
      if (str.startsWith('Error: ')) throw macroError(str);
      return str;
    });
  }
  function openAsRawString(f, M, path, max0, specified) {
    const go = (p) => {
      const shown = norm(p);
      const ioError = (msg) => { throw macroError('File open error \n"' + msg + '"\n'); };
      return attempt(M, shown, () => {
        const r = resolveIn(M, p, HOME);
        return mp(statOf(M, r), (st) => {
          if (!st) throw macroError('File not found');
          if (st.kind === 'dir') return ioError(javaIoText('VFS_IS_A_DIR', shown));
          let max = max0;
          const len = st.size;
          if (max > len || (p.endsWith('.txt') && !specified)) max = len;
          if (max < 0) return ioError(String(max));
          if (max === 0) return '';
          return mp(M.vfs.read(r.vpath, { offset: 0, length: max }), latin1Text);
        });
      }, (code) => ioError(javaIoText(code, shown)));
    };
    if (path === '') return pick(M, 'file', 'Open As String', 'openAsRawString').then(go);
    return go(path);
  }

  // ---------------------------------------------------------------- getDirectory / getDir (IJ.getDirectory 1.54p)
  const DIR_KEYWORDS = Object.freeze({ plugins: '/imagej/plugins/', macros: '/macros/', luts: '/luts/', home: '/home/', downloads: '/Downloads/',
    startup: '/imagej/', imagej: '/imagej/', preferences: '/home/.imagej/', temp: '/tmp/', cwd: '/home/' });
  function getDirectoryOf(M, title) {
    const V = VFSLIB();
    const t2 = String(title).toLowerCase();
    const sep = (d) => { const r = d === null || d === undefined ? null : (V ? V.addSeparator(d) : d); return r === null ? '' : r; };
    if (Object.prototype.hasOwnProperty.call(DIR_KEYWORDS, t2)) return DIR_KEYWORDS[t2];
    if (t2 === 'current' || t2 === 'default') return sep(MOUNT.defaultDir);
    if (t2 === 'image') { const im = M.images.get(M.current); return sep(im && im.file && im.file.dir ? im.file.dir : null); }
    if (t2 === 'file') return sep(MOUNT.lastDir);
    vfsOf(M, '');
    // DirectoryChooser: the default directory is put back after the dialog; Cancel = Macro.abort
    return pick(M, 'directory', title, 'getDirectory').then((vp) => sep(vp));
  }
  /** IJMacro.analyze / the fast path: a getDirectory() whose argument is a literal keyword never waits. */
  function getDirectorySuspends(pgm, j) {
    const code = pgm.code, MASK = K.TOK_MASK, SHIFT = K.TOK_SHIFT;
    if ((code[j + 1] & MASK) !== LP || (code[j + 2] & MASK) !== K.STRING_CONSTANT || (code[j + 3] & MASK) !== RP) return true;
    const s = String(pgm.table[code[j + 2] >> SHIFT].str).toLowerCase();
    return !(Object.prototype.hasOwnProperty.call(DIR_KEYWORDS, s) || s === 'current' || s === 'default' || s === 'image' || s === 'file');
  }

  // ---------------------------------------------------------------- getFileList (Functions.getFileList 1.54p, F5)
  function fileListOf(M, dir) {
    const shown = norm(dir);
    return attempt(M, shown, () => {
      const r = resolveIn(M, dir, HOME);
      return mp(M.vfs.list(r.vpath), (list) => {
        if (!list) return [];
        const kinds = new Map();
        for (const e of list) if (e && typeof e.name === 'string') kinds.set(e.name, e.kind);
        const names = Array.from(kinds.keys()).sort();
        const out = [];
        for (const n of names) {
          if (n.startsWith('.') || n === 'Thumbs.db') continue;
          out.push(kinds.get(n) === 'dir' ? n + '/' : n);
        }
        return out;
      });
    }, () => []);
  }

  // ---------------------------------------------------------------- open() (Functions.open → IJ.open → Opener 1.54p)
  /** Opener.getFileType 1.54p on the first 132 bytes (zero-padded: what FileInputStream.read leaves) and the file name. */
  function fileTypeOf(head, fileName) {
    if (!head) return 'UNKNOWN';
    const buf = new Uint8Array(132);
    buf.set(head.subarray(0, Math.min(132, head.length)));
    const b0 = buf[0], b1 = buf[1], b2 = buf[2], b3 = buf[3];
    const dicm = buf[128] === 68 && buf[129] === 73 && buf[130] === 67 && buf[131] === 77;
    let name = fileName;
    if (name.endsWith('.msr') || name.endsWith('.MSR')) return 'UNKNOWN';
    if (dicm && ((b0 === 73 && b1 === 73) || (b0 === 77 && b1 === 77))) return 'TIFF_AND_DICOM';
    if (name.endsWith('.lsm')) return 'UNKNOWN';
    // an OME-TIFF is Bio-Formats' (FILES.md §8.5.1)
    if (name.indexOf('.ome.tif') >= 0) return 'UNKNOWN';
    if (b0 === 73 && b1 === 73 && b2 === 42 && b3 === 0) return 'TIFF';
    if (b0 === 77 && b1 === 77 && b2 === 0 && b3 === 42) return 'TIFF';
    if (b0 === 255 && b1 === 216 && b2 === 255) return 'JPEG';
    if (b0 === 71 && b1 === 73 && b2 === 70 && b3 === 56) return 'GIF';
    name = name.toLowerCase();
    if (dicm || name.endsWith('.dcm')) return 'DICOM';
    if ((b0 === 8 || b0 === 2) && b1 === 0 && b3 === 0 && !name.endsWith('.spe') && name !== 'fid') return 'DICOM';
    if (b0 === 80 && (b1 === 49 || b1 === 52 || b1 === 50 || b1 === 53 || b1 === 51 || b1 === 54) && (b2 === 10 || b2 === 13 || b2 === 32 || b2 === 9)) return 'PGM';
    if (name.endsWith('.lut')) return 'LUT';
    if (b0 === 137 && b1 === 80 && b2 === 78 && b3 === 71) return 'PNG';
    if (name.endsWith('.zip')) return 'ZIP';
    if ((b0 === 83 && b1 === 73 && b2 === 77 && b3 === 80) || name.endsWith('.fts.gz') || name.endsWith('.fits.gz')) return 'FITS';
    if (name.endsWith('.java') || name.endsWith('.txt') || name.endsWith('.ijm') || name.endsWith('.js') || name.endsWith('.bsh') ||
      name.endsWith('.py') || name.endsWith('.html')) return 'JAVA_OR_TEXT';
    if (b0 === 73 && b1 === 111) return 'ROI';
    if ((b0 === 111 && b1 === 106 && b2 === 106 && b3 === 0) || name.endsWith('.ojj')) return 'OJJ';
    if (name.endsWith('.xls') || name.endsWith('.csv') || name.endsWith('.tsv')) return 'TABLE';
    if (name.endsWith('.avi')) return 'AVI';
    let isText = true;
    for (let i = 0; i < 10; i++) {
      const c = buf[i];
      if ((c < 32 && c !== 9 && c !== 10 && c !== 13) || c > 126) { isText = false; break; }
    }
    if (isText) return 'TEXT';
    if ((b0 === 66 && b1 === 77) || name.endsWith('.dib')) return 'BMP';
    if (name.endsWith('.raw')) return 'RAW';
    return 'UNKNOWN';
  }
  const dirOfVpath = (vp) => vp.substring(0, vp.lastIndexOf('/') + 1);
  const nameOfVpath = (vp) => vp.substring(vp.lastIndexOf('/') + 1);
  function originOf(r, name, format) {
    return { rootId: r.rootId, root: r.root, rel: r.rel, dir: dirOfVpath(r.vpath), name, format };
  }
  /* WindowManager.getUniqueName 1.54p over the displayed images (batch-mode images are never shown, never compared). */
  function uniqueTitle(M, name) {
    const shown = (t) => { for (const im of M.images.values()) if (!im.hidden && im.title === t) return true; return false; };
    if (!shown(name)) return name;
    let name2 = name, ext = '';
    let len = name2.length;
    const lastDot = name2.lastIndexOf('.');
    if (lastDot !== -1 && len - lastDot < 6 && lastDot !== len - 1) { ext = name2.substring(lastDot, len); name2 = name2.substring(0, lastDot); }
    const lastDash = name2.lastIndexOf('-');
    len = name2.length;
    if (lastDash !== -1 && len - lastDash < 4 && lastDash < len - 1 && /[1-9]/.test(name2.charAt(lastDash + 1))) name2 = name2.substring(0, lastDash);
    for (let i = 1; i <= 99; i++) { const n3 = name2 + '-' + i + ext; if (!shown(n3)) return n3; }
    return name;
  }
  /** A decoded file becomes a document of the run (F19): the file name as title, its origin (null: an image made from a ROI or a LUT
   *  file, which ImageJ gives no FileInfo) for getInfo / File › Save. */
  async function showOpened(M, image, origin, title, unique) {
    await M.commitAll();
    const t = M.batch || unique === false ? title : uniqueTitle(M, title);
    image.name = t;
    const info = M.E.createDoc(image, { hidden: M.batch, clean: true, provenance: origin ? { opened: true, file: origin } : { opened: true } });
    if (M.batch) M.batchDocs.push(info.docId);
    await adopt(M, info);
    const im = M.images.get(info.docId);
    if (im) { im.title = t; im.file = origin ? { dir: origin.dir, name: origin.name, format: origin.format } : null; }
    M.front = { kind: 'image', title: t };
    return info.docId;
  }
  /* The n-th plane (1-based, ImageJ stack order) of a decoded stack as a single image (Opener.openTiff(path, n)). */
  function planeOf(image, n) {
    const nZ = image.nZ || 1, nT = image.nT || 1, nC = image.rgb ? 1 : image.channels.length;
    const total = nC * nZ * nT;
    if (!(n >= 1 && n <= total)) throw ijError('IJ_BAD_ARGS', 'plane');
    const k = n - 1;
    const c = image.rgb ? 0 : k % nC, z = Math.floor(k / nC) % nZ, t = Math.floor(k / (nC * nZ));
    const pi = t * nZ + z;
    const chans = image.rgb ? image.channels : [image.channels[c]];
    return Object.assign({}, image, { nZ: 1, nT: 1, hyperstack: false, mode: undefined, labels: undefined,
      channels: chans.map((ch) => Object.assign({}, ch, { planes: [ch.planes[pi]] })) });
  }
  /** E.decodeImage (FILES.md §10.2), with the core TIFF reader when the engine has no decoder for a TIFF. */
  async function decodeFile(M, bytes, o) {
    if (typeof M.E.decodeImage === 'function') return M.E.decodeImage(bytes, o);
    if (o.kind === 'tiff' && root.IJTiff && typeof root.IJTiff.read === 'function') {
      const image = await root.IJTiff.read(bytes, o.name);
      return o.plane ? planeOf(image, o.plane) : image;
    }
    throw ijError('IJ_IO_DECODE', 'no decoder');
  }
  /* A decoder failure as ImageJ shows it: too large = the browser's limit, no decoder = not in the browser, else the Opener's box. */
  function decodeFailure(M, err, full, name, ctx) {
    const code = err && err.code;
    if (code === 'IJ_IO_TOO_LARGE' || code === 'IJ_PICTURE_TOO_LARGE' || code === 'IJ_BUDGET' || code === 'IJ_TOO_LARGE' || code === 'IJ_OVER_BUDGET')
      throw macroError(M.tr('err.macFileTooLarge', { path: full }));
    // Opener.openTiff(path, n) with n outside the stack: the Opener's box
    if (code === 'IJ_IO_PLANE' && err.details && typeof err.details.ijText === 'string') return errorBox(M, 'Opener', err.details.ijText, ctx);
    if (code === 'IJ_IO_DECODE' || code === 'IJ_IO_ENCODE') throw macroError(M.tr('err.macNotInBrowser', { name: 'open("' + name + '")' }));
    if (err && err.macroText !== undefined) throw err;
    if (err instanceof MacroCancel) throw err;
    console.error('[advanced-studio] macro open', err);
    return errorBox(M, 'Opener', 'Unsupported format or file not found:\n' + full, ctx);
  }
  /* o.plane: IJ.open(path, n), shown by ImagePlus.show without WindowManager.checkForDuplicateName (no unique title);
   * o.noOrigin: TextReader's image has no FileInfo directory (getInfo("image.directory") is ""). */
  async function openImageFile(M, r, name, kind, format, ctx, o) {
    const opt = o || {};
    const bytes = await attempt(M, r.vpath, () => readAll(M, r.vpath, 2), (code) => { throw macroError(javaIoText(code, r.vpath)); });
    let image;
    try { image = await decodeFile(M, bytes, { name, kind, plane: opt.plane || undefined }); } catch (err) { return decodeFailure(M, err, r.vpath, name, ctx); }
    return showOpened(M, image, opt.noOrigin ? null : originOf(r, name, format), name, opt.plane ? false : undefined);
  }
  /** Opener.open(path) 1.54p. ctx = { viaMacroRun } (F12). */
  async function openerOpen(f, M, raw, ctx) {
    const s = norm(raw);
    const V = needLib(M, s);
    if (V.isUrl(s)) throw macroError(M.tr('err.macNetwork'));
    if (s.endsWith('.jar') || s.endsWith('.class')) throw macroError(M.tr('err.macNotInBrowser', { name: 'open("' + s + '")' }));
    if (BIO_EXT.test(s)) throw macroError(M.tr('err.macBioFormats'));
    let r;
    try { r = resolveIn(M, s, openerBase()); } catch (e) { return fsFail(M, e, s); }
    const full = r.vpath;
    const name = V.javaName(full);
    MOUNT.lastDir = dirOfVpath(full);
    MOUNT.lastName = name;
    const probe = await attempt(M, full, () => mp(statOf(M, r), (st) => {
      if (st && st.kind === 'dir') return { st, head: null };
      if (!st) return { st: null, head: null };
      return mp(M.vfs.read(full, { offset: 0, length: Math.min(132, st.size) }), (head) => ({ st, head }));
    }), () => ({ st: null, head: null }));
    if (probe.st && probe.st.kind === 'dir') throw macroError(M.tr('err.macRefused', { command: 'open("' + s + '")', reason: M.tr('err.macReasonSequence') }));
    if (!probe.st) {
      // Opener.open, case UNKNOWN of a missing file: the full path, or its name when longer than 64 characters
      let p = full;
      if (p.length > 64) p = name;
      return errorBox(M, 'Opener', 'File not found:' + (p.length <= 64 ? ' \n' + p : ''), ctx);
    }
    const type = s.endsWith('.txt') ? 'JAVA_OR_TEXT' : fileTypeOf(probe.head, name);
    switch (type) {
      case 'TIFF': return openImageFile(M, r, name, 'tiff', 'tiff', ctx);
      case 'JPEG': return openImageFile(M, r, name, 'picture', 'jpeg', ctx);
      case 'GIF': return openImageFile(M, r, name, 'picture', 'gif', ctx);
      case 'PNG': return openImageFile(M, r, name, 'picture', 'png', ctx);
      case 'BMP': return openImageFile(M, r, name, 'picture', 'bmp', ctx);
      case 'ZIP': return openZipFile(M, r, name, ctx);
      case 'LUT': return openLutFile(M, r, name, ctx);
      case 'ROI': return openRoiFile(M, r, name, ctx);
      case 'TABLE': return openTableFile(M, r, name, { title: name.startsWith('Results.') ? 'Results' : name, box: 'Open Table' }, ctx);
      case 'JAVA_OR_TEXT': case 'TEXT': return openTextWindow(M, r, name);
      case 'UNKNOWN': return errorBox(M, 'Opener', 'Unsupported format or file not found:\n' + full, ctx);
      default: throw macroError(M.tr('err.macNotInBrowser', { name: 'open("' + name + '")' }));
    }
  }
  /* F20: an Editor file (.txt .ijm .java …) goes to a Studio text window titled with its name, never into the Macro Editor. */
  async function openTextWindow(M, r, name) {
    const bytes = await attempt(M, r.vpath, () => readAll(M, r.vpath), (code) => { throw macroError(javaIoText(code, r.vpath)); });
    await M.rpc('text.open', { title: name, text: linesOf(bytes) });
    M.front = { kind: 'text', title: name };
    M.textWins.add(name);
    return null;
  }
  /* ZipInputStream.getNextEntry: the name in the first local file header (null: no entry). */
  function firstZipName(bytes) {
    if (bytes.length < 30) return null;
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (dv.getUint32(0, true) !== 0x04034b50) return bytes.length >= 22 && dv.getUint32(0, true) === 0x06054b50 ? null : undefined;
    const flags = dv.getUint16(6, true), n = dv.getUint16(26, true);
    if (30 + n > bytes.length) return undefined;
    const raw = bytes.subarray(30, 30 + n);
    return (flags & 0x0800) ? utf8Text(raw) : latin1Text(raw);
  }
  /* The room an archive's inflated entries may take: the engine's free memory (no limit without an engine that says). */
  function zipRoom(M) {
    const free = M.E && typeof M.E.freeBytes === 'function' ? Number(M.E.freeBytes()) : NaN;
    return free === free ? free : undefined;
  }
  function zipEntries(M, bytes, only) {
    const C = root.IJRoiCodec;
    if (!C || typeof C.zipRead !== 'function') throw ijError('IJ_MODULE_MISSING', 'zip');
    return C.zipRead(bytes, { inflateRaw: C.inflateRaw, only, maxTotal: zipRoom(M) });
  }
  /** Opener.openZip 1.54p: the first entry decides (a ROI set, a TIFF, else the Opener's message). */
  async function openZipFile(M, r, name, ctx) {
    const bytes = await attempt(M, r.vpath, () => readAll(M, r.vpath, 2), (code) => { throw macroError(javaIoText(code, r.vpath)); });
    const firstName = firstZipName(bytes);
    if (firstName === null) return null;
    if (firstName === undefined) return errorBox(M, 'Opener', 'java.util.zip.ZipException: invalid zip file', ctx);
    if (firstName.endsWith('.roi')) {
      // In a macro RoiManager.getInstance() is never null (Interpreter.getBatchModeRoiManager), so Opener.openZip takes its other
      // branch: IJ.runMacro('roiManager("Open", getArgument())') in a new interpreter that shares the static batch mode and opens the
      // set into that interpreter's own batch-mode ROI Manager, dropped when it ends (jar: no Log line, roiManager("count") unchanged).
      if (M.batch) return null;
      return rmOpenZip(M, r.vpath, bytes);
    }
    if (!firstName.endsWith('.tif')) return errorBox(M, 'Opener', 'This ZIP archive does not contain a TIFF or DICOM file, or ROIs:\n   ' + r.vpath, ctx);
    let entries;
    // ZipInputStream: Opener.openZip reads the first entry alone
    try { entries = await zipEntries(M, bytes, (n) => n === firstName); } catch (err) {
      if (err && err.code === 'IJ_IO_TOO_LARGE') throw macroError(M.tr('err.macFileTooLarge', { path: r.vpath }));
      return errorBox(M, 'Opener', 'java.util.zip.ZipException: invalid zip file', ctx);
    }
    const first = entries[0];
    if (!first) return errorBox(M, 'Opener', 'java.util.zip.ZipException: invalid zip file', ctx);
    let image;
    try { image = await decodeFile(M, first.bytes, { name: first.name, kind: 'tiff' }); } catch (err) { return decodeFailure(M, err, r.vpath, name, ctx); }
    // the image is titled with the entry, its FileInfo names the archive (Opener.openZip)
    return showOpened(M, image, originOf(r, name, 'zip'), first.name);
  }
  /** LutLoader 1.54p: the table goes onto the current image (every channel of a composite in Grayscale mode, which turns to Color),
   *  or a 256 × 32 ramp titled with the file name when no image is open. */
  async function openLutFile(M, r, name, ctx) {
    const bytes = await attempt(M, r.vpath, () => readAll(M, r.vpath), (code) => { throw macroError(javaIoText(code, r.vpath)); });
    let table;
    try {
      if (!root.IJLutFile || typeof root.IJLutFile.parse !== 'function') throw ijError('IJ_MODULE_MISSING', 'LUT');
      table = root.IJLutFile.parse(bytes).table;
    } catch (err) {
      if (err && err.code === 'IJ_MODULE_MISSING') throw macroError(M.tr('err.macNotInBrowser', { name: 'open("' + name + '")' }));
      return errorBox(M, 'LUT Reader', 'This is not an ImageJ or NIH Image LUT, a 768 byte \nraw LUT, or a LUT in text format.\n \n' + r.vpath, ctx);
    }
    const lutName = name.replace(/\.[^.]*$/, '') || name;
    // the run's own copy of the display follows at once (getLut right after open reads it), as setLut does
    const apply = (target, c) => {
      if (!target.display) target.display = [];
      target.display[c] = Object.assign({}, target.display[c] || {}, { lut: Array.from(table), invert: false });
      M.write('display.lut', { docId: target.docId, c, name: lutName, table });
    };
    const im = M.images.get(M.current);
    if (im) {
      if (im.rgb) return errorBoxContinue(M, 'LUTs cannot be assiged to RGB Images.');
      const pos = M.E.getPosition(im.docId);
      if (im.nC > 1 && im.mode === 'gray') {
        M.write('display.mode', { docId: im.docId, mode: 'color' });
        im.mode = 'color';
        for (let c = 0; c < im.nC; c++) apply(im, c);
      } else apply(im, pos.c);
      M.P = null;
      return null;
    }
    const ramp = new Uint8Array(256 * 32);
    for (let y = 0; y < 32; y++) for (let x = 0; x < 256; x++) ramp[y * 256 + x] = x;
    const docId = await showOpened(M, { width: 256, height: 32, bitDepth: 8, nZ: 1, nT: 1, rgb: false, hyperstack: false,
      calibration: { pixelWidth: 1, pixelHeight: 1, pixelDepth: 1, unit: 'pixel' },
      channels: [{ name: 'C1', color: '#ffffff', display: { min: 0, max: 255, lut: 'Grays', invert: false }, planes: [ramp] }] }, null, name);
    const made = M.images.get(docId);
    if (made) apply(made, 0); else M.write('display.lut', { docId, c: 0, name: lutName, table });
    M.P = null;
    return null;
  }
  /** RoiReader 1.54p: onto the current image, or a blank 8-bit image named after the file when none is open or it is too small. */
  async function openRoiFile(M, r, name, ctx) {
    const bytes = await attempt(M, r.vpath, () => readAll(M, r.vpath), (code) => { throw macroError(javaIoText(code, r.vpath)); });
    let d;
    try { d = root.IJRoiCodec.decodeEntry(bytes, { fileName: name }); } catch (err) {
      console.error('[advanced-studio] macro roi', err);
      return errorBox(M, 'ROI Reader', 'java.io.IOException: invalid ROI file', ctx);
    }
    const b = roiBounds(d.roi);
    let im = M.images.get(M.current);
    if (!im || im.width < b.x + b.w || im.height < b.y + b.h) {
      const w = Math.max(1, b.x + b.w + 10), h = Math.max(1, b.y + b.h + 10);
      const docId = await showOpened(M, { width: w, height: h, bitDepth: 8, nZ: 1, nT: 1, rgb: false, hyperstack: false,
        calibration: { pixelWidth: 1, pixelHeight: 1, pixelDepth: 1, unit: 'pixel' },
        channels: [{ name: 'C1', color: '#ffffff', display: { min: 0, max: 255, lut: 'Grays', invert: false }, planes: [new Uint8Array(w * h)] }] }, null, name);
      im = M.images.get(docId);
    }
    const roi = Object.assign({}, d.roi);
    if (typeof d.name === 'string' && d.name) roi.name = d.name;
    setSelection(M, im.docId, roi);
    return null;
  }
  /* ResultsTable.open on the bytes (IJTextIo.readTable): → the table, or throws an Error whose message is ImageJ's text. */
  function readTableBytes(bytes, name, path) {
    const T = root.IJTextIo;
    if (!T || typeof T.readTable !== 'function') throw ijError('IJ_MODULE_MISSING', 'table reader');
    try { return T.readTable(bytes, { name, path }); } catch (err) {
      if (err && typeof err.ijText === 'string') throw macroError(err.ijText);
      throw err;
    }
  }
  function showTable(M, t, title, rowNumbers) {
    const table = { name: title, size: t.size | 0, headings: (t.headings || []).slice(), columns: {}, labels: t.labels ? t.labels.slice() : null, rev: 0 };
    if (rowNumbers || t.showRowNumbers === true) table.showRowNumbers = true;
    for (const h of table.headings) table.columns[h] = (t.columns[h] || []).slice();
    M.tables.set(title, table);
    if (title !== 'Results') M.currentTable = title;
    touchTable(M, table);
    M.write('table.show', { name: title });
    M.front = { kind: 'table', title };
    return null;
  }
  /** Opener.openTable / openResultsTable: o = { title, box (the IJ.error title), rowNumbers }. */
  async function openTableFile(M, r, name, o, ctx) {
    const st = await attempt(M, r.vpath, () => statOf(M, r), () => null);
    if (!st || st.kind !== 'file') return errorBox(M, o.box, 'Error opening ' + r.vpath, ctx);
    const bytes = await attempt(M, r.vpath, () => readAll(M, r.vpath), (code) => { throw macroError(javaIoText(code, r.vpath)); });
    let t;
    try { t = readTableBytes(bytes, name, r.vpath); } catch (err) {
      if (err && err.macroText !== undefined) return errorBox(M, o.box, err.macroText, ctx);
      throw err;
    }
    return showTable(M, t, o.title, !!o.rowNumbers);
  }

  /** open([path[, n | options]]) — Functions.open 1.54p. */
  async function openBuiltin(f, M, path, n) {
    needLib(M, path === null ? '' : path);
    if (path === null) {
      const vp = await pick(M, 'file', 'Open', 'open');
      await openerOpen(f, M, vp, { viaMacroRun: false });
      M.P = null;
      return null;
    }
    const s = norm(path);
    if (n === n && n !== null) {
      await openTiffPlane(f, M, path === '' ? null : path, d2i(n));
    } else await openerOpen(f, M, path === '' ? await pick(M, 'file', 'Open', 'open') : path, { viaMacroRun: false });
    // a machine path reached its file through an alias: File.directory / File.name keep the virtual path the Opener resolved
    if (path !== '' && !VFSLIB().isMachinePath(s)) {
      const V = VFSLIB();
      const parent = V.javaParent(s);
      MOUNT.lastDir = (parent === null ? 'null' : parent) + '/';
      MOUNT.lastName = V.javaName(s);
    }
    M.P = null;
    return null;
  }
  /* IJ.open(path, n): Opener.openImage(path, n) — a TIFF only ("Opener: TIFF file required" is the macro error of Functions.open). */
  async function openTiffPlane(f, M, path0, n) {
    const raw = path0 === null ? await pick(M, 'file', 'Open', 'open') : path0;
    const s = norm(raw);
    if (needLib(M, s).isUrl(s)) throw macroError(M.tr('err.macNetwork'));
    let r;
    try { r = resolveIn(M, s, openerBase()); } catch (e) { return fsFail(M, e, s); }
    const name = VFSLIB().javaName(r.vpath);
    MOUNT.lastDir = dirOfVpath(r.vpath);
    MOUNT.lastName = name;
    const head = await attempt(M, r.vpath, () => mp(statOf(M, r), (st) => (st && st.kind === 'file' ? M.vfs.read(r.vpath, { offset: 0, length: Math.min(132, st.size) }) : null)), () => null);
    if (fileTypeOf(head, name) !== 'TIFF') throw macroError('Opener: TIFF file required');
    return openImageFile(M, r, name, 'tiff', 'tiff', { viaMacroRun: true }, { plane: n });
  }

  // ---------------------------------------------------------------- writers (FileSaver, Writer, RoiWriter, XYWriter, MeasurementsWriter, TextWriter)
  /* ImageJ's IJ.noImage / PlugInFilterRunner checks, as a box from a built-in or a macro error from run() (F12). */
  function needImage(M, ctx) {
    const im = M.images.get(M.current);
    if (!im) return errorBox(M, 'No Image', 'There are no images open', ctx).then(() => null);
    return Promise.resolve(im);
  }
  /* A dialog in macro mode (SaveDialog.isMacro, OpenDialog.decodePath) then getDirectory / getFileName: File.directory / File.name
   * become the option's own directory and name (Opener.getDir / getName: the text up to the last '/', '' when there is none);
   * the default directory is left alone. A machine path keeps the virtual path its alias resolves to (never shown to a macro). */
  function noteDialogPath(M, p) {
    const V = VFSLIB();
    const s = norm(p);
    if (V && V.isMachinePath(s)) {
      let r;
      try { r = resolveIn(M, s, HOME); } catch (_) { return; }
      MOUNT.lastDir = dirOfVpath(r.vpath); MOUNT.lastName = nameOfVpath(r.vpath);
      return;
    }
    const i = s.lastIndexOf('/');
    if (i > 0) { MOUNT.lastDir = s.substring(0, i + 1); MOUNT.lastName = s.substring(i + 1); } else { MOUNT.lastDir = ''; MOUNT.lastName = s; }
  }
  /** The file a writer's SaveDialog names: the run() option (with OpenDialog's variable rule), else the picker (§6.3). */
  function savePathFor(f, M, req, title, defaultName, ext, source) {
    let p = req && req.pathText !== undefined && req.pathText !== null ? lookupPathVariable(f, String(req.pathText)) : null;
    if (p !== null) { noteDialogPath(M, p); return Promise.resolve(p); }
    return pick(M, 'save', title, source || 'command', { defaultName: splitDefault(defaultName, ext), ext });
  }
  function openPathFor(f, M, req, title, source) {
    let p = req && req.pathText !== undefined && req.pathText !== null && req.pathText !== '' ? lookupPathVariable(f, String(req.pathText)) : null;
    if (p !== null) { noteDialogPath(M, p); return Promise.resolve(p); }
    return pick(M, 'file', title, source || 'command');
  }
  /** Writes `bytes` to `raw` (relative = user.dir) under the policy; a Java failure is the writer's box `title`. */
  function writeTo(M, raw, bytes, title, ctx) {
    const shown = norm(raw);
    return attempt(M, shown, () => {
      const r = resolveIn(M, raw, HOME);
      return mp(M.vfs.write(r.vpath, bytes), () => r);
    }, (code) => errorBox(M, title, 'File saving error (IOException):\n   "' + javaIoText(code, shown) + '" \n   ' + shown, ctx).then(() => null));
  }
  async function encodeDoc(M, im, o) {
    await M.commitAll();
    await M.syncWrites();
    if (typeof M.E.encodeImage !== 'function') throw macroError(M.tr('err.macNotInBrowser', { name: 'saveAs("' + o.format + '")' }));
    try { return await M.E.encodeImage(im.docId, o); } catch (err) {
      if (err && (err.code === 'IJ_IO_ENCODE' || err.code === 'IJ_IO_DECODE')) throw macroError(M.tr('err.macSaveFormat', { format: o.format }));
      if (err && (err.code === 'IJ_IO_TOO_LARGE' || err.code === 'IJ_BUDGET' || err.code === 'IJ_OVER_BUDGET' || err.code === 'IJ_PICTURE_TOO_LARGE')) throw macroError(M.tr('err.macFileTooLarge', { path: im.title }));
      if (err && err.code === 'IJ_MODULE_MISSING') throw macroError(M.tr('err.macNotInBrowser', { name: 'saveAs("' + o.format + '")' }));
      if (err instanceof MacroCancel || (err && err.macroText !== undefined)) throw err;
      // a technical failure: the cause goes to the console, the macro shows the run's "Internal error"
      console.error('[advanced-studio] macro encode', err);
      throw macroError('Internal error: ' + String((err && err.code) || 'IJ_INTERNAL'));
    }
  }
  /** FileSaver.saveAsTiff(path) + updateImagePlus: the image takes the file's name and becomes "saved". */
  async function saveTiffTo(M, im, raw, ctx) {
    const enc = await encodeDoc(M, im, { format: 'tiff' });
    const r = await writeTo(M, raw, enc.bytes, 'FileSaver.saveAsTiff', ctx);
    if (!r) return null;
    await savedAs(M, im, r, nameOfVpath(r.vpath), 'tiff', enc.rev);
    return r;
  }
  /* FileSaver.updateImp: the image is titled with the saved name, is no longer "changed", and its FileInfo names the file. */
  async function savedAs(M, im, r, name, format, rev) {
    const origin = Object.assign(originOf(r, name, format), { dir: dirOfVpath(r.vpath) });
    if (typeof M.E.markSaved === 'function') { try { await M.E.markSaved(im.docId, { rev, file: origin }); } catch (err) { console.error('[advanced-studio] macro markSaved', err); } }
    im.file = { dir: origin.dir, name, format };
    M.savedDocs.add(im.docId);
    if (im.title !== name) { im.title = name; await M.rpc('image.rename', { docId: im.docId, title: name }); }
  }
  /** o.updates: the FileInfo format the writer records (FileSaver.saveAsPng / Jpeg / Zip / Raw call updateImp), absent = none
   *  (saveAsText, saveAsLut); o.entryName (ZIP) is the name the image takes. */
  async function saveEncoded(M, im, raw, o, title, ctx) {
    const enc = await encodeDoc(M, im, o);
    const r = await writeTo(M, raw, enc.bytes, title, ctx);
    if (r && o.updates) await savedAs(M, im, r, o.format === 'zip' && o.entryName ? o.entryName : nameOfVpath(r.vpath), o.updates, enc.rev);
    return r;
  }
  /* The effective table of the channel on screen (FileSaver.saveAsLut): its LUT, inverted when the display is. */
  function displayTableOf(M, im) {
    const pos = M.E.getPosition(im.docId);
    const d = (im.display && im.display[im.rgb ? 0 : pos.c]) || { lut: 'Grays', invert: false };
    let t = null;
    try { t = root.IJLuts.get(d.lut || 'Grays'); } catch (_) { t = null; }
    if (!t || t.length !== 768) t = root.IJLuts.get('Grays');
    if (!d.invert) return t;
    const r = new Uint8Array(768);
    for (let i = 0; i < 256; i++) { const j = 255 - i; r[i * 3] = t[j * 3]; r[i * 3 + 1] = t[j * 3 + 1]; r[i * 3 + 2] = t[j * 3 + 2]; }
    return r;
  }
  function concatPages(pages) {
    let n = 0;
    for (const p of pages) n += p.length;
    const out = new Uint8Array(n);
    let at = 0;
    for (const p of pages) { out.set(p, at); at += p.length; }
    return out;
  }
  /* A registry compute op of package io run on the current plane (its text output in pages). */
  async function computeText(M, im, opName, params, roi) {
    const spec = R.get(opName);
    if (!spec || typeof spec.run !== 'function') throw macroError(M.tr('err.macNotInBrowser', { name: opName }));
    await M.commitAll();
    const pos = M.E.getPosition(im.docId);
    const view = M.E.readDoc(im.docId, { z: pos.z, t: pos.t });
    const res = await spec.run(view, params, roi || null, { channel: im.rgb ? 0 : pos.c, tick: () => {}, check: () => {} });
    return res;
  }
  const precisionOf = (M) => (M.measurements && Number.isInteger(M.measurements.decimals) ? M.measurements.decimals : 3);
  function settingOf(M, key, dflt) {
    const v = M.settings ? M.settings[key] : undefined;
    return v === undefined || v === null ? dflt : v;
  }
  /** TextPanel.saveAs / ResultsTable.saveAs text of a table (IJTextIo.tableText with the Input/Output options). */
  function tableBytes(M, t, path, forceNumbers, what) {
    const T = root.IJTextIo;
    if (!T || typeof T.tableText !== 'function') throw macroError(M.tr('err.macNotInBrowser', { name: what || 'saveAs("results")' }));
    const csv = /\.csv$/i.test(path);
    const text = T.tableText(t, { sep: csv ? ',' : '\t', headers: settingOf(M, 'ana.saveHeaders', true) !== false,
      rowNumbers: forceNumbers === undefined ? settingOf(M, 'ana.saveRowNumbers', true) !== false : forceNumbers, precision: precisionOf(M),
      decimalColumn: (h) => decimalColumn(t, h) });
    return utf8(text);
  }

  /* The run() file operations (FILES.md §9.5), closed list FILE_OPS. op(f, M, req, ctx) → Promise. */
  const FILE_OP_IMPL = {
    async open(f, M, req, ctx) {
      const p = await openPathFor(f, M, req, 'Open', 'command');
      return openerOpen(f, M, p, ctx);
    },
    async importTextImage(f, M, req, ctx) {
      const p = await openPathFor(f, M, req, 'Open Text Image...', 'command');
      const s = norm(p);
      let r;
      try { r = resolveIn(M, s, openerBase()); } catch (e) { return fsFail(M, e, s); }
      const name = VFSLIB().javaName(r.vpath);
      const st = await attempt(M, r.vpath, () => statOf(M, r), () => null);
      if (!st || st.kind !== 'file') return errorBox(M, 'Text Reader', 'File not found:\n' + r.vpath, ctx);
      return openImageFile(M, r, name, 'text', 'text', ctx, { noOrigin: true });
    },
    async importLut(f, M, req, ctx) {
      const p = await openPathFor(f, M, req, 'Open LUT...', 'command');
      const s = norm(p);
      let r;
      try { r = resolveIn(M, s, openerBase()); } catch (e) { return fsFail(M, e, s); }
      return openLutFile(M, r, VFSLIB().javaName(r.vpath), ctx);
    },
    async importResults(f, M, req, ctx) {
      const p = await openPathFor(f, M, req, 'Open Table', 'command');
      const s = norm(p);
      let r;
      try { r = resolveIn(M, s, openerBase()); } catch (e) { return fsFail(M, e, s); }
      return openTableFile(M, r, VFSLIB().javaName(r.vpath), { title: 'Results', box: 'Open Results', rowNumbers: true }, ctx);
    },
    async importTable(f, M, req, ctx) {
      const p = await openPathFor(f, M, req, 'Open Table...', 'command');
      const s = norm(p);
      let r;
      try { r = resolveIn(M, s, openerBase()); } catch (e) { return fsFail(M, e, s); }
      const name = VFSLIB().javaName(r.vpath);
      return openTableFile(M, r, name, { title: name.startsWith('Results.') ? 'Results' : name, box: 'Open Table' }, ctx);
    },
    /* TextFileReader: the file in a text window (a Studio text window, F20). */
    async importTextFile(f, M, req, ctx) {
      const p = await openPathFor(f, M, req, 'Open Text File...', 'command');
      const s = norm(p);
      let r;
      try { r = resolveIn(M, s, openerBase()); } catch (e) { return fsFail(M, e, s); }
      const st = await attempt(M, r.vpath, () => statOf(M, r), () => null);
      if (!st || st.kind !== 'file') return errorBox(M, 'TextWindow', 'File not found:\n' + r.vpath, ctx);
      return openTextWindow(M, r, VFSLIB().javaName(r.vpath));
    },
    /* XY_Reader 1.54p: a two-column text file as a polygon (mean segment > 10 px) or freehand selection, on the current image or on a
     * blank 8-bit image named after the file when there is none or it is too small. */
    async importXY(f, M, req, ctx) {
      const p = await openPathFor(f, M, req, 'Open Text Image...', 'command');
      const s = norm(p);
      let r;
      try { r = resolveIn(M, s, openerBase()); } catch (e) { return fsFail(M, e, s); }
      const name = VFSLIB().javaName(r.vpath);
      const st = await attempt(M, r.vpath, () => statOf(M, r), () => null);
      if (!st || st.kind !== 'file') return errorBox(M, 'Text Reader', 'File not found:\n' + r.vpath, ctx);
      const bytes = await attempt(M, r.vpath, () => readAll(M, r.vpath), (code) => { throw macroError(javaIoText(code, r.vpath)); });
      let im0;
      try { im0 = root.IJTextIo.parseTextImage(utf8Text(bytes)); } catch (err) {
        if (err && err.code && /^IJ_IO_TEXT/.test(err.code)) { await M.rpc('dialog.message', { title: 'XY Reader', text: 'Two column text file required' }); return null; }
        throw err;
      }
      if (im0.width !== 2 || im0.height < 3) { await M.rpc('dialog.message', { title: 'XY Reader', text: 'Two column text file required' }); return null; }
      const n = im0.height;
      const xs = new Array(n), ys = new Array(n);
      let allIntegers = true, length = 0;
      for (let i = 0; i < n; i++) {
        xs[i] = im0.data[i * 2]; ys[i] = im0.data[i * 2 + 1];
        if (d2i(xs[i]) !== xs[i] || d2i(ys[i]) !== ys[i]) allIntegers = false;
        if (i > 0) { const dx = xs[i] - xs[i - 1], dy = ys[i] - ys[i - 1]; length += Math.sqrt(dx * dx + dy * dy); }
      }
      // Roi.toIntR: (int)Math.floor(v + 0.5); float coordinates are kept as floats (PolygonRoi(float[], float[], …))
      const pts = Array.from({ length: n }, (_, i) => (allIntegers ? [Math.floor(xs[i] + 0.5), Math.floor(ys[i] + 0.5)] : [Math.fround(xs[i]), Math.fround(ys[i])]));
      const roi = { type: length / n > 10 ? 'polygon' : 'freehand', points: pts };
      const b = roiBounds(roi);
      let im = M.images.get(M.current) || null;
      if (!im || im.width < b.x + b.w || im.height < b.y + b.h) {
        const w = Math.abs(b.x) + b.w + 10, h = Math.abs(b.y) + b.h + 10;
        const docId = await showOpened(M, { width: w, height: h, bitDepth: 8, nZ: 1, nT: 1, rgb: false, hyperstack: false,
          calibration: { pixelWidth: 1, pixelHeight: 1, pixelDepth: 1, unit: 'pixel' },
          channels: [{ name: 'C1', color: '#ffffff', display: { min: 0, max: 255, lut: 'Grays', invert: false }, planes: [new Uint8Array(w * h)] }] }, null, name);
        im = M.images.get(docId);
      }
      setSelection(M, im.docId, roi);
      return null;
    },
    /* File › Import › Raw (Raw + ImportDialog + FileOpener / ImageReader 1.54p). */
    async importRaw(f, M, req, ctx) {
      const p = await openPathFor(f, M, req, 'Open Raw...', 'command');
      const s = norm(p);
      let r;
      try { r = resolveIn(M, s, openerBase()); } catch (e) { return fsFail(M, e, s); }
      const name = VFSLIB().javaName(r.vpath);
      const st = await attempt(M, r.vpath, () => statOf(M, r), () => null);
      const v = req.values || {};
      const o = rawImportSettings(name, st && st.kind === 'file' ? st.size : null, v);
      if (o.error) throw macroError(o.error);
      if (v.openAll || v.virtual) throw macroError(M.tr('err.macRefused', { command: 'Raw...', reason: M.tr('err.macReasonSequence') }));
      if (!st || st.kind !== 'file') return errorBox(M, 'File>Import>Raw', 'File not found: ' + r.vpath, ctx);
      const bytes = await attempt(M, r.vpath, () => readAll(M, r.vpath), (code) => { throw macroError(javaIoText(code, r.vpath)); });
      let image;
      try { image = rawImage(bytes, o, name); } catch (err) {
        if (err && err.code === 'IJ_UNSUPPORTED') throw macroError(M.tr('err.macNotInBrowser', { name: 'Raw... (' + o.type + (o.white && o.type !== '8-bit' ? ', white is zero' : '') + ')' }));
        throw err;
      }
      return showOpened(M, image, originOf(r, name, 'raw'), name);
    },
    /* Commands.save → FileSaver.save: a TIFF opened from a granted folder and still titled with its file name is replaced in place. */
    async save(f, M, req, ctx) {
      const im = await needImage(M, ctx);
      if (!im) return null;
      const o = im.file;
      if (o && o.format === 'tiff' && o.dir && im.title === o.name && (req.pathText === null || req.pathText === undefined)) {
        const path = o.dir + o.name;
        const exists = await attempt(M, path, () => mp(statOf(M, resolveIn(M, path, HOME)), (st) => !!st), () => false);
        if (exists) return saveTiffTo(M, im, path, ctx);
      }
      const p = await savePathFor(f, M, req, 'Save as TIFF', im.title, '.tif');
      return saveTiffTo(M, im, p, ctx);
    },
    async saveTiff(f, M, req, ctx) {
      const im = await needImage(M, ctx);
      if (!im) return null;
      return saveTiffTo(M, im, await savePathFor(f, M, req, 'Save as TIFF', im.title, '.tif'), ctx);
    },
    async saveJpeg(f, M, req, ctx) {
      const im = await needImage(M, ctx);
      if (!im) return null;
      const p = await savePathFor(f, M, req, 'Save as JPEG', im.title, '.jpg');
      return saveEncoded(M, im, p, { format: 'jpeg', quality: Number(settingOf(M, 'io.jpegQuality', 85)), updates: 'jpeg' }, 'FileSaver.saveAsJpeg', ctx);
    },
    async savePng(f, M, req, ctx) {
      const im = await needImage(M, ctx);
      if (!im) return null;
      return saveEncoded(M, im, await savePathFor(f, M, req, 'Save as PNG...', im.title, '.png'), { format: 'png', updates: 'png' }, 'FileSaver.saveAsPng', ctx);
    },
    async saveZip(f, M, req, ctx) {
      const im = await needImage(M, ctx);
      if (!im) return null;
      let p = await savePathFor(f, M, req, 'Save as TIFF/ZIP', im.title, '.zip');
      // FileSaver.saveAsZip: ".zip" added to the path, the entry (and the image) named after the file with ".tif"
      if (!p.endsWith('.zip')) p += '.zip';
      let entry = nameOfVpath(norm(p));
      if (entry.endsWith('.zip')) entry = entry.substring(0, entry.length - 4);
      if (!entry.endsWith('.tif')) entry += '.tif';
      return saveEncoded(M, im, p, { format: 'zip', entryName: entry, updates: 'tiff' }, 'FileSaver.saveAsZip', ctx);
    },
    async saveRaw(f, M, req, ctx) {
      const im = await needImage(M, ctx);
      if (!im) return null;
      return saveEncoded(M, im, await savePathFor(f, M, req, 'Save as Raw', im.title, '.raw'), { format: 'raw', updates: 'raw' }, 'FileSaver.saveAsRaw', ctx);
    },
    /* FileSaver.saveAsText: TextEncoder at Analyzer.getPrecision(), comma-delimited for a .csv path. */
    async saveTextImage(f, M, req, ctx) {
      const im = await needImage(M, ctx);
      if (!im) return null;
      const p = await savePathFor(f, M, req, 'Save as Text', im.title, '.txt');
      const res = await computeText(M, im, 'textImage', { precision: precisionOf(M), delimiter: /\.csv$/i.test(p) ? ',' : '\t' });
      return writeTo(M, p, concatPages(res.pages || []), 'FileSaver.saveAsText', ctx);
    },
    async saveLut(f, M, req, ctx) {
      const im = await needImage(M, ctx);
      if (!im) return null;
      if (im.rgb) return errorBox(M, 'FileSaver', 'RGB Images do not have a LUT.', ctx);
      const p = await savePathFor(f, M, req, 'Save as LUT', im.title, '.lut');
      return writeTo(M, p, lutFileBytes(displayTableOf(M, im)), 'FileSaver.saveAsLut', ctx);
    },
    /* RoiWriter: the selection as a .roi (RoiEncoder), the default name the ROI's own. */
    async saveSelection(f, M, req, ctx) {
      const im = await needImage(M, ctx);
      if (!im) return null;
      const roi = selectionOf(M, im.docId);
      if (!roi) return errorBox(M, req.name || 'Selection...', 'This command requires a selection', ctx);
      const p = await savePathFor(f, M, req, 'Save Selection...', typeof roi.name === 'string' && roi.name ? roi.name : im.title, '.roi');
      const bytes = root.IJRoiCodec.encode(roi, { name: roi.name });
      return attempt(M, norm(p), () => mp(M.vfs.write(resolveIn(M, p, HOME).vpath, bytes), () => null),
        (code) => errorBox(M, 'ROI Writer', javaIoText(code, norm(p)), ctx).then(() => null));
    },
    /* XYWriter: the vertices of the selection, one per line. */
    async saveXY(f, M, req, ctx) {
      const im = await needImage(M, ctx);
      if (!im) return null;
      const roi = selectionOf(M, im.docId);
      if (!roi) return errorBox(M, req.name || 'XY Coordinates...', 'This command requires a selection', ctx);
      const p = await savePathFor(f, M, req, 'Save Coordinates as Text...', im.title, '.txt');
      const text = root.IJTextIo.xyWriterText(roi, im.calibration);
      return attempt(M, norm(p), () => mp(M.vfs.write(resolveIn(M, p, HOME).vpath, utf8(text)), () => null),
        (code) => errorBox(M, 'XYWriter', 'Unable to save coordinates:\n   ' + javaIoText(code, norm(p)), ctx).then(() => null));
    },
    /* XYCoordinates (Analyze › Tools › Save XY Coordinates): the dialog values come from the options, defaults as its showDialog. */
    async saveXYCoordinates(f, M, req, ctx) {
      const im = await needImage(M, ctx);
      if (!im) return null;
      const roi = selectionOf(M, im.docId);
      const v = req.values || {};
      const area = roi && root.IJRoi && root.IJRoi.isArea(roi);
      let params;
      if (area) params = { mode: 'selection', precision: precisionOf(M) };
      else {
        let bg = typeof v.background === 'number' ? v.background : null;
        if (bg === null) { const probe = await computeText(M, im, 'xyCoordinates', { mode: 'probe' }); bg = probe.background; }
        params = { mode: 'points', background: bg, invertY: !!v.invert, precision: precisionOf(M) };
      }
      const p = await savePathFor(f, M, req, 'Save Coordinates as Text...', im.title, area ? '.csv' : '.txt');
      const res = await computeText(M, im, 'xyCoordinates', params, area ? roi : null);
      return attempt(M, norm(p), () => mp(M.vfs.write(resolveIn(M, p, HOME).vpath, concatPages(res.pages || [])), () => null),
        (code) => errorBox(M, 'Save XY Coordinates', 'Error saving coordinates:\n   ' + javaIoText(code, norm(p)), ctx).then(() => null));
    },
    /* MeasurementsWriter: the front table window (not the Log), else the Results table. */
    async saveResults(f, M, req, ctx) {
      const fr = M.front;
      const name = fr && fr.kind === 'table' && fr.title !== 'Log' && M.tables.has(fr.title) ? fr.title : 'Results';
      const t = M.tables.get(name);
      if (!t || (name === 'Results' && t.size === 0)) return null;
      const ext = String(settingOf(M, 'ana.ext', '.csv'));
      const p = await savePathFor(f, M, req, 'Save as Text', name, ext);
      return writeTo(M, p, tableBytes(M, t, p), 'Save as Text', ctx);
    },
    /* TextWriter: the front text window (the Log, a table, a text window) through TextPanel.saveAs. */
    async saveText(f, M, req, ctx) {
      const fr = M.front;
      if (!fr || fr.kind === 'image') {
        return errorBox(M, 'Save As Text', 'This command requires a TextWindow, such\nas the "Log" window, or an Editor window. Use\nFile>Save>Text Image to save an image as text.', ctx);
      }
      const p = await savePathFor(f, M, req, 'Save as Text', fr.title, '.txt');
      let bytes;
      if (fr.kind === 'log') bytes = utf8(logText(M.logLines));
      else if (fr.kind === 'table' && M.tables.has(fr.title)) bytes = tableBytes(M, M.tables.get(fr.title), p);
      else {
        const r = await M.rpc('window.text', { title: fr.title });
        if (!r || !r.found) {
          return errorBox(M, 'Save As Text', 'This command requires a TextWindow, such\nas the "Log" window, or an Editor window. Use\nFile>Save>Text Image to save an image as text.', ctx);
        }
        bytes = utf8(String(r.text || ''));
      }
      return writeTo(M, p, bytes, 'Save as Text', ctx);
    },
    /* Macro_Runner.run: no path = its OpenDialog. */
    async runMacro(f, M, req, ctx) {
      const p = await openPathFor(f, M, req, 'Run Macro or Script...', 'runMacro');
      const src = await macroFileSource(M, p, null);
      if (src === null) return null;
      M.pendingNested = { source: src.text, arg: '', path: src.vpath };
      return null;
    }
  };
  // ---------------------------------------------------------------- File › Import › Raw (ImportDialog + ImageReader 1.54p)
  const RAW_TYPES = ['8-bit', '16-bit Signed', '16-bit Unsigned', '32-bit Signed', '32-bit Unsigned', '32-bit Real', '64-bit Real',
    '24-bit RGB', '24-bit RGB Planar', '24-bit BGR', '24-bit Integer', '32-bit ARGB', '32-bit ABGR', '1-bit Bitmap'];
  /* ImportDialog.showDialog in macro mode: 512 × 512, offset / gap 0, one image, then getDimensionsFromName (+ guessFormat on the file
   * size), then the options. The type keeps ImportDialog's static choice (Prefs raw.type, 0) unless the name or the options set it. */
  function rawImportSettings(name, fileSize, v) {
    const o = { type: RAW_TYPES[0], width: 512, height: 512, offset: 0, n: 1, gap: 0, white: false, little: false };
    if (/.*[0-9]+x[0-9]+.*/.test(name)) {
      const us = name.lastIndexOf('_');
      const name2 = (us >= 0 ? name.substring(us) : name).replace(/[^0-9]/g, ' ');
      const nums = name2.trim().split(/\s+/).filter(Boolean);
      const w = nums.length >= 2 ? parseInt(nums[0], 10) : 0, h = nums.length >= 2 ? parseInt(nums[1], 10) : 0;
      if (w >= 1 && h >= 1) {
        o.width = w; o.height = h; o.n = 1;
        if (nums.length > 2) { const d = parseInt(nums[2], 10); if (d > 0) o.n = d; }
        if (fileSize !== null) {
          const size = o.width * o.height * o.n;
          if (fileSize === 4 * size) o.type = '32-bit Real';
          else if (fileSize === 2 * size) o.type = '16-bit Unsigned';
          else if (fileSize === 3 * size) o.type = '24-bit RGB';
          else if (fileSize === size) o.type = '8-bit';
          if (name.endsWith('be.raw')) o.little = false;
          else if (name.endsWith('le.raw')) o.little = true;
        }
      }
    }
    if (typeof v.image === 'string') o.type = v.image;
    const int = (x) => (typeof x === 'number' && x === x ? Math.trunc(x) : null);
    if (int(v.width) !== null) o.width = int(v.width);
    if (int(v.height) !== null) o.height = int(v.height);
    if (int(v.offset) !== null) o.offset = int(v.offset);
    if (int(v.number) !== null) o.n = int(v.number);
    if (int(v.gap) !== null) o.gap = int(v.gap);
    if (typeof v.white === 'boolean') o.white = v.white;
    if (typeof v.littleEndian === 'boolean') o.little = v.littleEndian;
    if (!(o.width > 0 && o.height > 0)) o.error = 'Width or height <= 0';
    if (o.n < 1) o.n = 1;
    return o;
  }
  /* ImageReader: the planes of the file, missing bytes read as zeros; 16-bit signed + 32768 (GRAY16_SIGNED), 32/64-bit as float. */
  function rawImage(bytes, o, name) {
    const W = o.width, H = o.height, N = W * H;
    const SIZES = { '8-bit': 1, '16-bit Signed': 2, '16-bit Unsigned': 2, '32-bit Signed': 4, '32-bit Unsigned': 4, '32-bit Real': 4, '64-bit Real': 8,
      '24-bit RGB': 3, '24-bit RGB Planar': 3, '24-bit BGR': 3 };
    const bpp = SIZES[o.type];
    if (!bpp || (o.white && o.type !== '8-bit')) throw ijError('IJ_UNSUPPORTED', 'raw type');
    const imageBytes = N * bpp;
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const le = !!o.little;
    const rgb = o.type.indexOf('24-bit') === 0;
    const bitDepth = rgb || o.type === '8-bit' ? 8 : o.type.indexOf('16-bit') === 0 ? 16 : 32;
    const planes = rgb ? [[], [], []] : [[]];
    for (let k = 0; k < o.n; k++) {
      const base = o.offset + k * (imageBytes + o.gap);
      const avail = (i, w) => base + i + w <= bytes.length;
      if (rgb) {
        const R = new Uint8Array(N), G = new Uint8Array(N), B = new Uint8Array(N);
        for (let i = 0; i < N; i++) {
          if (o.type === '24-bit RGB Planar') {
            if (avail(i, 1)) R[i] = bytes[base + i];
            if (avail(N + i, 1)) G[i] = bytes[base + N + i];
            if (avail(2 * N + i, 1)) B[i] = bytes[base + 2 * N + i];
          } else if (avail(i * 3, 3)) {
            const a = bytes[base + i * 3], b = bytes[base + i * 3 + 1], c = bytes[base + i * 3 + 2];
            if (o.type === '24-bit BGR') { R[i] = c; G[i] = b; B[i] = a; } else { R[i] = a; G[i] = b; B[i] = c; }
          }
        }
        planes[0].push(R); planes[1].push(G); planes[2].push(B);
        continue;
      }
      let out;
      if (o.type === '8-bit') { out = new Uint8Array(N); for (let i = 0; i < N; i++) if (avail(i, 1)) out[i] = bytes[base + i]; }
      else if (o.type === '16-bit Unsigned') { out = new Uint16Array(N); for (let i = 0; i < N; i++) if (avail(i * 2, 2)) out[i] = dv.getUint16(base + i * 2, le); }
      else if (o.type === '16-bit Signed') { out = new Uint16Array(N); for (let i = 0; i < N; i++) out[i] = avail(i * 2, 2) ? dv.getInt16(base + i * 2, le) + 32768 : 32768; }
      else {
        out = new Float32Array(N);
        for (let i = 0; i < N; i++) {
          if (!avail(i * bpp, bpp)) continue;
          const at = base + i * bpp;
          out[i] = o.type === '32-bit Signed' ? dv.getInt32(at, le) : o.type === '32-bit Unsigned' ? dv.getUint32(at, le)
            : o.type === '32-bit Real' ? dv.getFloat32(at, le) : dv.getFloat64(at, le);
        }
      }
      planes[0].push(out);
    }
    // the display range of the middle image (ImportDialog.openImage: setSlice(n/2) + resetMinAndMax)
    const mid = planes[0][o.n > 1 ? Math.floor(o.n / 2) - 1 : 0];
    let min = 0, max = 255;
    if (!rgb && bitDepth !== 8) {
      min = Infinity; max = -Infinity;
      for (let i = 0; i < mid.length; i++) { const x = mid[i]; if (x === x && x !== Infinity && x !== -Infinity) { if (x < min) min = x; if (x > max) max = x; } }
      if (min === Infinity) { min = 0; max = 0; }
    }
    const cal = { pixelWidth: 1, pixelHeight: 1, pixelDepth: 1, unit: 'pixel' };
    const chan = (nm, color, pl, lut) => ({ name: nm, color, display: { min, max, lut, invert: !!(o.white && bitDepth === 8 && !rgb) }, planes: pl });
    return rgb
      ? { name, width: W, height: H, bitDepth: 8, nZ: o.n, nT: 1, rgb: true, hyperstack: false, calibration: cal,
        channels: [chan('Red', '#ff0000', planes[0], 'Red'), chan('Green', '#00ff00', planes[1], 'Green'), chan('Blue', '#0000ff', planes[2], 'Blue')] }
      : { name, width: W, height: H, bitDepth, nZ: o.n, nT: 1, rgb: false, hyperstack: false, calibration: cal, channels: [chan('C1', '#ffffff', planes[0], 'Grays')] };
  }

  /** A `status: 'file'` reply of run() (FILES.md §9.3). */
  async function runFileOp(f, M, file, ctx) {
    const op = file && typeof file.op === 'string' ? file.op : '';
    if (FILE_OPS.indexOf(op) < 0 || !Object.prototype.hasOwnProperty.call(FILE_OP_IMPL, op)) throw ijError('IJ_INTERNAL', 'file op ' + op);
    if (typeof file.error === 'string' && file.error) throw macroError(file.error);
    return FILE_OP_IMPL[op](f, M, file, ctx);
  }

  // ---------------------------------------------------------------- save(path) / saveAs(format[, path]) (IJ.save / IJ.saveAs 1.54p)
  function updateExt(path, ext) {
    if (path === null) return null;
    const V = VFSLIB();
    return V.updateExtension(path, ext);
  }
  async function saveBuiltin(f, M, path) {
    needLib(M, path);
    const im = M.images.get(M.current) || null;
    let p = path;
    let dot = p.lastIndexOf('.');
    if (dot === -1 && im) { p += '.tif'; dot = p.lastIndexOf('.'); }
    if (dot !== -1) {
      const title = im ? im.title : null;
      await saveAsBuiltin(f, M, p.substring(dot + 1), p);
      if (title !== null && im && im.title !== title) { im.title = title; await M.rpc('image.rename', { docId: im.docId, title }); }
      return null;
    }
    return errorBoxContinue(M, 'The file path passed to IJ.save() method or save()\nmacro function is missing the required extension.\n \n"' + p + '"');
  }
  async function saveAsBuiltin(f, M, format0, path0) {
    needLib(M, path0 === null ? '' : path0);
    let path = path0 !== null && path0.length === 0 ? null : path0;
    const format = String(format0).toLowerCase();
    const ctx = { viaMacroRun: false };
    const run = (op) => runFileOp(f, M, { op, pathText: path, values: {}, name: format0, options: path === null ? null : 'save=' + path }, ctx);
    if (format.indexOf('tif') !== -1) {
      const im = await needImage(M, ctx);
      if (!im) return null;
      if (path === null) return saveTiffTo(M, im, await pick(M, 'save', 'Save as TIFF', 'save', { defaultName: splitDefault(im.title, '.tif'), ext: '.tif' }), ctx);
      if (!path.endsWith('.tiff')) path = updateExt(path, '.tif');
      return saveTiffTo(M, im, path, ctx);
    }
    if (format.indexOf('jpeg') !== -1 || format.indexOf('jpg') !== -1) { path = updateExt(path, '.jpg'); return run('saveJpeg'); }
    if (format.indexOf('gif') !== -1) throw macroError(M.tr('err.macSaveFormat', { format: 'gif' }));
    if (format.indexOf('text image') !== -1) {
      path = updateExt(path, path !== null && (path.endsWith('.csv') || path.endsWith('.CSV')) ? '.csv' : '.txt');
      return run('saveTextImage');
    }
    if (format.indexOf('text') !== -1 || format.indexOf('txt') !== -1) {
      if (path !== null && !path.endsWith('.xls') && !path.endsWith('.csv') && !path.endsWith('.tsv')) path = updateExt(path, '.txt');
      return run('saveText');
    }
    if (format.indexOf('zip') !== -1) { path = updateExt(path, '.zip'); return run('saveZip'); }
    if (format.indexOf('raw') !== -1) return run('saveRaw');
    for (const x of ['avi', 'bmp', 'fits']) if (format.indexOf(x) !== -1) throw macroError(M.tr('err.macSaveFormat', { format: x }));
    if (format.indexOf('png') !== -1) { path = updateExt(path, '.png'); return run('savePng'); }
    if (format.indexOf('pgm') !== -1) throw macroError(M.tr('err.macSaveFormat', { format: 'pgm' }));
    if (format.indexOf('lut') !== -1) { path = updateExt(path, '.lut'); return run('saveLut'); }
    if (format.indexOf('results') !== -1 || format.indexOf('measurements') !== -1 || format.indexOf('table') !== -1) return run('saveResults');
    if (format.indexOf('selection') !== -1 || format.indexOf('roi') !== -1) { path = updateExt(path, '.roi'); return run('saveSelection'); }
    if (format.indexOf('xy') !== -1 || format.indexOf('coordinates') !== -1) { path = updateExt(path, '.txt'); return run('saveXY'); }
    await errorBoxContinue(M, 'Unsupported save() or saveAs() file format: "' + format + '"\n \n"' + path + '"');
    // IJ.run(imp, format, "save=…") from a built-in: the Executer's "Unrecognized command" box, then the macro stops (jar: quiet exit)
    try {
      return await runCommand(f, M, format, path === null ? null : (path.indexOf(' ') >= 0 ? 'save=[' + path + ']' : 'save=' + path));
    } catch (err) {
      if (err && typeof err.macroText === 'string' && err.macroText.startsWith('Unrecognized command: ')) {
        await M.rpc('dialog.message', { title: 'ImageJ', text: err.macroText });
        throw new MacroCancel('abort');
      }
      throw err;
    }
  }

  // ---------------------------------------------------------------- runMacro(path[, arg]) (Macro_Runner.runMacroFile 1.54p)
  /** → { text, vpath } of the macro file (ISO-8859-1), or a rejection after RunMacro's box (dialog + abort). */
  async function macroFileSource(M, name0, arg) {
    void arg;
    const name = String(name0);
    if (name.startsWith('ij.jar:')) throw macroError(M.tr('err.macNotInBrowser', { name: 'runMacro("' + name + '")' }));
    const V = needLib(M, name);
    const s = norm(name);
    if (V.isUrl(s)) throw macroError(M.tr('err.macNetwork'));
    const fullPath = s.startsWith('/') || s.indexOf(':/') === 1;
    const exists = (p) => attempt(M, p, () => mp(statOf(M, resolveIn(M, p, HOME)), (st) => !!st), () => false);
    let path = fullPath ? s : '/macros/' + s;
    const hasExtension = V.javaName(path).indexOf('.') >= 0;
    let found = hasExtension ? await exists(path) : false;
    if (!found && !fullPath && !hasExtension) {
      if (await exists(path + '.txt')) { path += '.txt'; found = true; }
      else if (await exists(path + '.ijm')) { path += '.ijm'; found = true; }
    }
    if (!found) found = await exists(path);
    if (!found && !fullPath) {
      const path2 = '/home/' + s;
      if (!hasExtension) {
        if (await exists(path2 + '.txt')) { path = path2 + '.txt'; found = true; }
        else if (await exists(path2 + '.ijm')) { path = path2 + '.ijm'; found = true; }
      }
      if (!found && await exists(path2)) { path = path2; found = true; }
    }
    if (!found) { await errorBox(M, 'RunMacro', 'Macro or script not found:\n \n' + path, null); return null; }
    const r = resolveIn(M, path, HOME);
    const bytes = await attempt(M, path, () => readAll(M, r.vpath), (code) => { throw macroError(javaIoText(code, path)); });
    MOUNT.lastDir = dirOfVpath(r.vpath);
    MOUNT.lastName = nameOfVpath(r.vpath);
    if (name.endsWith('.js') || name.endsWith('.bsh') || name.endsWith('.py')) throw macroError(M.tr('err.macEvalScript'));
    return { text: latin1Text(bytes), vpath: r.vpath };
  }
  /* The nested interpreter of runMacro(file) (Macro_Runner.runMacro): same run, same lane, same undo group; macro.filepath answers the file. */
  function* runNestedFile(f, M, text, arg, vpath) {
    M.macroPaths.push(vpath);
    MOUNT.macroFile = vpath;
    try { return yield* runNested(f, text, arg === null || arg === undefined ? '' : arg); } finally { M.macroPaths.pop(); }
  }

  // ---------------------------------------------------------------- ROI Manager files (RoiManager.runCommand / open / save 1.54p)
  function rmError(M, msg) {
    return M.rpc('dialog.message', { title: 'ROI Manager', text: msg }).then(() => { throw new MacroCancel('abort'); });
  }
  function rmEntryOf(M, d, label) {
    const roi = Object.assign({}, d.roi);
    const e = { name: label, docId: M.current, roi };
    if (d.stroke !== undefined && d.stroke !== null) e.stroke = d.stroke;
    if (d.fill !== undefined && d.fill !== null) e.fill = d.fill;
    if (typeof d.width === 'number') e.width = d.width;
    if (d.position) e.position = d.position;
    return e;
  }
  async function rmOpenZip(M, vpath, bytes) {
    const C = root.IJRoiCodec;
    let list;
    try { list = await C.decodeSet(bytes, { inflateRaw: C.inflateRaw, maxTotal: zipRoom(M) }); } catch (err) {
      if (err && err.code === 'IJ_IO_ZIP_NO_ROI') return rmError(M, 'This ZIP archive does not contain ".roi" files: ' + vpath);
      if (err && err.code === 'IJ_IO_TOO_LARGE') throw macroError(M.tr('err.macFileTooLarge', { path: vpath }));
      console.error('[advanced-studio] macro roi set', err);
      return rmError(M, 'java.util.zip.ZipException: invalid zip file');
    }
    for (const d of list) M.rm.list.push(rmEntryOf(M, d, d.label));
    rmSync(M);
    return NaN;
  }
  async function rmOpen(M, path0) {
    const p = path0 === '' ? await pick(M, 'file', 'Open Selection(s)...', 'command') : path0;
    const s = norm(p);
    let r;
    try { r = resolveIn(M, s, openerBase()); } catch (e) { return fsFail(M, e, s); }
    if (s.endsWith('.zip')) {
      const bytes = await attempt(M, r.vpath, () => readAll(M, r.vpath), (code) => rmError(M, 'java.io.FileNotFoundException: ' + javaIoText(code, r.vpath)).then(() => null));
      if (!bytes) return NaN;
      return rmOpenZip(M, r.vpath, bytes);
    }
    const bytes = await attempt(M, r.vpath, () => readAll(M, r.vpath), () => null);
    let d = null;
    if (bytes) { try { d = root.IJRoiCodec.decodeEntry(bytes, { fileName: nameOfVpath(r.vpath) }); } catch (_) { d = null; } }
    // "Unable to open ROI at <path>": RoiManager.open keeps it as errorMessage, with no message box
    if (!d) return NaN;
    let name = typeof d.name === 'string' && d.name ? d.name : nameOfVpath(r.vpath);
    if (name.endsWith('.roi')) name = name.substring(0, name.length - 4);
    M.rm.list.push(rmEntryOf(M, d, name));
    rmSync(M);
    return NaN;
  }
  async function rmSave(M, path0, selected) {
    const list = M.rm.list;
    const indexes = () => (M.rm.selected.length ? M.rm.selected.slice() : list.map((_, i) => i));
    if (path0 !== null && path0.endsWith('.roi')) {
      const idx = indexes();
      if (!idx.length) return rmError(M, 'The list is empty');
      const e = list[idx[0]];
      const bytes = root.IJRoiCodec.encode(e.roi, { name: e.name, stroke: e.stroke, fill: e.fill, width: e.width, position: e.position });
      await attempt(M, norm(path0), () => mp(M.vfs.write(resolveIn(M, path0, HOME).vpath, bytes), () => null),
        (code) => errorBox(M, 'ROI Manager', javaIoText(code, norm(path0)), null));
      return NaN;
    }
    if (path0 !== '' && !path0.endsWith('.zip')) return rmError(M, "Name must end with '.zip'");
    if (!list.length) return rmError(M, 'The list is empty');
    const idx = selected ? indexes() : list.map((_, i) => i);
    let p = path0;
    if (p === '') {
      p = await pick(M, 'save', 'Save ROIs...', 'command', { defaultName: 'RoiSet', ext: '.zip' });
      if (!(p.endsWith('.zip') || p.endsWith('.ZIP'))) p += '.zip';
    }
    const bytes = root.IJRoiCodec.encodeSet(idx.map((i) => list[i]).map((e) => ({ roi: e.roi, name: e.name, stroke: e.stroke, fill: e.fill, width: e.width, position: e.position })));
    await attempt(M, norm(p), () => mp(M.vfs.write(resolveIn(M, p, HOME).vpath, bytes), () => null),
      (code) => rmError(M, 'java.io.FileNotFoundException: ' + javaIoText(code, norm(p))));
    return NaN;
  }

  // ---------------------------------------------------------------- IJ.checksum("MD5 file" | "SHA-256 file", path) (Tools.getHash)
  const HASH_CHUNK = 16 * 1048576;
  async function checksumFile(M, method, path) {
    const V = VFSLIB();
    if (!V || !V.hash || !M.vfs) return '0';
    let handle = null;
    try {
      const r = resolveIn(M, path, HOME);
      const h = method === 'MD5' ? V.hash.md5() : V.hash.sha256();
      handle = await M.vfs.openRead(r.vpath);
      for (let at = 0; at < handle.size; at += HASH_CHUNK) h.update(await handle.read(at, Math.min(HASH_CHUNK, handle.size - at)));
      return h.hex();
    } catch (err) {
      if (err instanceof MacroCancel) throw err;
      if (err && err.macroText !== undefined && !isVfsError(err)) throw err;
      return '0';
    } finally {
      if (handle) { try { await handle.close(); } catch (_) { /* a read handle holds nothing to save */ } }
    }
  }

  // ---------------------------------------------------------------- macro.scan (FILES.md §6.1): the picker calls of a macro, before it runs
  function macroScan(a) {
    const IJMacro = LANG();
    const V = VFSLIB();
    if (!IJMacro || typeof IJMacro.tokenize !== 'function') throw ijError('IJ_MODULE_MISSING', 'IJMacro');
    if (!a || typeof a.source !== 'string') throw ijError('IJ_BAD_ARGS', 'macro.scan');
    const out = { folders: [], files: [], machinePaths: [] };
    let pgm;
    try { pgm = IJMacro.tokenize(a.source); } catch (_) { return out; }
    const KK = IJMacro.K, MASK = KK.TOK_MASK, SHIFT = KK.TOK_SHIFT;
    const code = pgm.code;
    const tok = (i) => (i < code.length ? code[i] & MASK : KK.EOF);
    const str = (i) => { const s = pgm.table[code[i] >> SHIFT]; return s && typeof s.str === 'string' ? s.str : ''; };
    const isName = (t) => t === KK.WORD || t === KK.STRING_FUNCTION || t === KK.NUMERIC_FUNCTION || t === KK.PREDEFINED_FUNCTION ||
      t === KK.ARRAY_FUNCTION || t === KK.VARIABLE_FUNCTION;
    const literalArg = (i) => (tok(i) === 40 && tok(i + 1) === KK.STRING_CONSTANT ? str(i + 1) : null);
    const aliases = Array.isArray(a.aliases) ? a.aliases : [];
    const covered = (dir) => aliases.some((al) => al && typeof al.literal === 'string' &&
      (al.ci ? dir.toLowerCase().startsWith(al.literal.toLowerCase()) : dir.startsWith(al.literal)));
    const seen = new Set();
    for (let i = 0; i < code.length; i++) {
      const t = tok(i);
      if (t === KK.EOF) break;
      const line = pgm.lineNumbers[i];
      if (t === KK.STRING_FUNCTION && (str(i) === 'getDirectory' || str(i) === 'getDir')) {
        const p = literalArg(i + 1);
        if (p !== null && tok(i + 3) === 41) {
          const lc = p.toLowerCase();
          if (!(Object.prototype.hasOwnProperty.call(DIR_KEYWORDS, lc) || lc === 'current' || lc === 'default' || lc === 'image' || lc === 'file'))
            out.folders.push({ prompt: p, line });
        }
      } else if (t === KK.STRING_FUNCTION && (str(i) === 'File' || str(i) === 'Dialog') && tok(i + 1) === 46 && isName(tok(i + 2))) {
        const member = str(i + 2), p = literalArg(i + 3);
        if (p !== null) {
          if (str(i) === 'File' && member === 'openDialog') out.files.push({ prompt: p, line });
          else if (str(i) === 'Dialog' && member === 'addDirectory') out.folders.push({ prompt: p, line });
          else if (str(i) === 'Dialog' && member === 'addFile') out.files.push({ prompt: p, line });
        }
      } else if (t === KK.STRING_CONSTANT && V && out.machinePaths.length < 20) {
        const s = V.normalizeSeparators(str(i));
        if (V.isMachinePath(s)) {
          const dir = s.endsWith('/') ? s : s.substring(0, s.lastIndexOf('/') + 1);
          if (dir && !seen.has(dir) && !covered(dir)) { seen.add(dir); out.machinePaths.push(dir); }
        }
      }
    }
    return out;
  }

  // ---------------------------------------------------------------- macro.vfs (FILES.md §5.2): delivery and storage, never during a run
  const VFS_UI_ERRORS = { VFS_QUOTA: 'IJ_MACRO_VFS_QUOTA', VFS_BUSY: 'IJ_MACRO_VFS_BUSY', VFS_NO_STORAGE: 'IJ_MACRO_VFS_NO_STORAGE' };
  async function macroVfs(a, E) {
    const V = VFSLIB();
    if (!V || typeof V.open !== 'function') throw ijError('IJ_MODULE_MISSING', 'IJMacroVFS');
    if (!a || typeof a.op !== 'string') throw ijError('IJ_BAD_ARGS', 'macro.vfs');
    if (RUNS.size) throw ijError('IJ_MACRO_BUSY', 'a macro is running');
    const ops = ['changes', 'deliver', 'discard', 'usage', 'clearTmp'];
    if (ops.indexOf(a.op) < 0) throw ijError('IJ_BAD_ARGS', 'macro.vfs op');
    const needsRoot = a.op === 'changes' || a.op === 'deliver' || a.op === 'discard';
    if (needsRoot && typeof a.rootId !== 'string') throw ijError('IJ_BAD_ARGS', 'rootId');
    enterMount(a.mountId);
    const vfs = V.open(vfsContext(a, null));
    try {
      await vfs.prepare();
      switch (a.op) {
        case 'changes': return await vfs.changes(a.rootId);
        case 'deliver': return await vfs.deliver(a.rootId, { texts: a.texts && typeof a.texts === 'object' ? a.texts : {}, maxLinks: 3,
          onProgress: (fr) => { try { E.tick(fr, 'op.macZip'); } catch (err) { if (err && err.code === 'IJ_CANCELLED') throw err; } } });
        case 'discard': await vfs.discard(a.rootId); return {};
        case 'usage': return await vfs.usage();
        case 'clearTmp': await vfs.clearTmp(); return {};
        default: return {};
      }
    } catch (err) {
      if (isVfsError(err) && VFS_UI_ERRORS[err.code]) throw ijError(VFS_UI_ERRORS[err.code], err.code);
      throw err;
    } finally {
      try { await vfs.close(); } catch (err) { console.error('[advanced-studio] macro vfs close', err); }
    }
  }

  // ---------------------------------------------------------------- installation of the file built-ins
  function installFiles() {
    const IJMacro = LANG();
    IJMacro.define('str', 'File', fileGen, { suspends: FILE_SUSPENDS, sync: fileSync });
    for (const name of ['getDirectory', 'getDir']) {
      IJMacro.define('str', name, function* (f) {
        const t = yield* f.getStringArg();
        const M = runOf(f);
        return yield* f.hostHook(() => getDirectoryOf(M, t));
      }, { suspends: (pgm, j) => getDirectorySuspends(pgm, j), sync(f) {
        const t = f.getStringArg$s();
        const r = getDirectoryOf(runOf(f), t);
        if (isThen(r)) throw ijError('IJ_INTERNAL', 'a directory chooser ran in the fast path');
        return r;
      } });
    }
    IJMacro.define('arr', 'getFileList', function* (f) {
      const dir = yield* f.getStringArg();
      const M = runOf(f);
      const list = yield* f.hostHook(() => fileListOf(M, dir));
      return f.newVariableArray(Array.isArray(list) ? list : []);
    }, { suspends: true });
    IJMacro.define('do', 'open', function* (f) {
      const it = f.interp;
      it.getLeftParen();
      let path = null, n = NaN;
      if (it.nextToken() === RP) it.getRightParen();
      else {
        path = yield* f.getString();
        if (it.nextToken() === COMMA) {
          it.getComma();
          if (f.isStringArg()) yield* f.getString(); else n = yield* it.getExpression();
        }
        it.getRightParen();
      }
      const M = runOf(f);
      yield* f.hostHook(() => openBuiltin(f, M, path, n));
      return null;
    }, { suspends: true });
    defAsync('do', 'save', 's', (f, a, M) => saveBuiltin(f, M, a[0]));
    IJMacro.define('do', 'saveAs', function* (f) {
      const it = f.interp;
      const format = yield* f.getFirstString();
      let path = null, oneArg = false;
      if (it.nextToken() === COMMA) path = yield* f.getLastString();
      else { it.getRightParen(); oneArg = true; }
      const M = runOf(f);
      // Functions.saveAs: one argument holding a separator is a path (a Windows "\" counts once normalised, F3)
      if (oneArg && norm(format).indexOf('/') >= 0) yield* f.hostHook(() => saveBuiltin(f, M, format));
      else yield* f.hostHook(() => saveAsBuiltin(f, M, format, path));
      return null;
    }, { suspends: true });
    IJMacro.define('str', 'runMacro', function* (f) {
      const it = f.interp;
      it.getLeftParen();
      const name = yield* f.getString();
      let arg = null;
      if (it.nextToken() === COMMA) { it.getComma(); arg = yield* f.getString(); }
      it.getRightParen();
      const M = runOf(f);
      const src = yield* f.hostHook(() => macroFileSource(M, name, arg));
      if (src === null || src === undefined) return null;
      return yield* runNestedFile(f, M, src.text, arg, src.vpath);
    }, { suspends: true });
  }

  // ---------------------------------------------------------------- Table.open / Table.save (Functions.openTable / saveTable 1.54p)
  async function tableOpen(f, M, path, title0) {
    const title = title0 !== null ? title0 : jName(path);
    const str = await openAsStringRaw(M, path, 'command');
    if (str.startsWith('Error:')) throw macroError('Error opening ' + norm(path));
    const t = readTableBytes(str, title, norm(path));
    return showTable(M, t, title, false);
  }
  async function tableSave(f, M, path0, title) {
    const t = tableFor(f, M, title);
    // ResultsTable.saveAs: new SaveDialog("Save Table", "Table", Prefs.defaultResultsExtension())
    const p = path0 === '' ? await pick(M, 'save', 'Save Table', 'command', { defaultName: 'Table', ext: String(settingOf(M, 'ana.ext', '.csv')) }) : path0;
    const shown = norm(p);
    await attempt(M, shown, () => {
      const r = resolveIn(M, p, HOME);
      // ResultsTable.saveAs: the table's own showRowNumbers, off when Prefs.dontSaveRowNumbers
      const numbers = t.name === 'Results' ? undefined : t.showRowNumbers === true && settingOf(M, 'ana.saveRowNumbers', true) !== false;
      return mp(M.vfs.write(r.vpath, tableBytes(M, t, p, numbers, 'Table.save')), () => null);
    }, (code) => { throw macroError(javaIoText(code, shown)); });
    return null;
  }

  // Test hooks (pure helpers and the run registry): not part of the contract.
  root.IJMacroRuntime = Object.freeze({
    resolveCall, freeMemoryText, optionFor, logApply, logText, parseJavaDouble, fileTypeOf, javaDate, macroScan,
    uniqueTitleOf: (titles, name) => uniqueTitle({ images: new Map(titles.map((t, i) => [i, { title: t, hidden: false }])) }, name),
    mount: () => Object.assign({}, MOUNT),
    runs: () => Array.from(RUNS.keys()),
    run: (runId) => RUNS.get(runId) || null,
    setRpcTimeout(ms) { const old = RPC_TIMEOUT_MS; RPC_TIMEOUT_MS = ms > 0 ? ms : 30000; return old; }
  });
})(typeof self !== 'undefined' ? self : globalThis);
