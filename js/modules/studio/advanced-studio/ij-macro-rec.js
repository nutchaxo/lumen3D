/* ij-macro-rec.js — IJMacroRec: ImageJ 1.54p's macro Recorder (ij.plugin.frame.Recorder) for the Advanced Studio.
 *
 * Contract: DOCS/studio-advanced/macros/EXTRAS.md §5. Classic script, page only (and Node for the tests): no DOM at load, no network,
 * no engine. It turns what the OPERATOR does — the `command` and `action` events ij-app.js emits (EXTRAS.md §4.1), never a macro's own
 * steps — into the macro text ImageJ's Recorder writes, line for line:
 *   - commands: Executer.setCommand + Recorder.saveCommand (Recorder.java:144-686), options folded field by field with GenericDialog's
 *     accumulator (IJMacroOptions.recordTokens / foldTokens, ij-macro-cmds.js);
 *   - selections: Roi / Line / PolygonRoi / PointRoi handleMouseUp, the Wand click of ImageCanvas (roiLines);
 *   - tool windows: ThresholdAdjuster, ContrastAdjuster, RoiManager, Channels, WindowManager activations, the toolbar.
 * Reads at call time only: IJMacroOptions (recordTokens, foldTokens, getValue, trimKey), IJMacroCmds (MACRO_COMMANDS, resolve) and the
 * number formats IJOv.d2s (IJ.d2s) and IJAna.d2s (ResultsTable.d2s).
 *
 * Recorded text is macro source: English, verbatim, never a machine path (a file the operator picked outside the folders granted to
 * macros is recorded as a commented line naming the file alone). It only ever reaches a text area or the macro interpreter.
 */
(function (root) {
  'use strict';

  const DEFAULT_NAME = 'Macro.ijm';
  const MICRON = 'µ';
  const FOLDER_UNKNOWN = ' // folder unknown: chosen outside the folders granted to macros';
  const STUDIO_ONLY = ' // Studio only';

  // ── Recorder.java formatters ──────────────────────────────────────────────────────────────────────────────────────────────

  /** Recorder.fixString :195-213 — the text of a quoted macro string, quotes not added. */
  function fixString(str) {
    const s = String(str === undefined || str === null ? '' : str);
    let out = '';
    for (let i = 0; i < s.length; i++) {
      const c = s.charAt(i), code = s.charCodeAt(i);
      if (c === '\\' || c === '"') out += '\\' + c;
      else if (c === '\n') out += '\\n';
      else if (code < 32 || (code > 126 && code < 0xa0)) out += '\\' + code.toString(8).padStart(3, '0');
      else out += c;
    }
    return out;
  }
  /** Recorder.addQuotes :771-778 */
  function addQuotes(value) {
    const v = value === undefined || value === null ? '' : String(value);
    return v.indexOf(' ') > -1 ? '[' + v + ']' : v;
  }
  /** Recorder.trimKey :545-554 (Locale.US lower case: ASCII only changes for the keys GenericDialog makes) */
  function trimKey(key) {
    let k = String(key);
    let i = k.indexOf(' ');
    if (i > -1) k = k.slice(0, i);
    i = k.indexOf(':');
    if (i > -1) k = k.slice(0, i);
    return k.toLowerCase();
  }
  /** Recorder.strip :755-769 — the value of the first key=value of an option string. */
  function strip(value) {
    let v = String(value);
    let i = v.indexOf('=');
    if (i >= 0) v = v.slice(i + 1);
    if (v.startsWith('[')) {
      let j = v.indexOf(']');
      if (j === -1) j = v.length;
      v = v.slice(1, j);
    } else {
      i = v.indexOf(' ');
      if (i !== -1) v = v.slice(0, i);
    }
    return v;
  }
  /** Recorder.fixPath only rewrites '\' on Windows; a virtual path already uses '/'. */
  const fixPath = (p) => (p === undefined || p === null ? '' : String(p));
  /** Java's (int) cast of a double: toward zero, NaN → 0, saturated at the int range. */
  function jint(v) {
    const n = Number(v);
    if (n !== n) return 0;
    if (n >= 2147483647) return 2147483647;
    if (n <= -2147483648) return -2147483648;
    const t = Math.trunc(n);
    return t === 0 ? 0 : t;
  }
  /** PolygonRoi.toIntR: (int)Math.floor(v + 0.5) */
  const toIntR = (v) => jint(Math.floor(Number(v) + 0.5));
  /** createMacro :808-811 — a name not ending ".txt" loses its extension and takes ".ijm". */
  function macroName(name) {
    let n = String(name === undefined || name === null ? '' : name);
    if (!n.endsWith('.txt')) {
      const dot = n.lastIndexOf('.');
      if (dot >= 0) n = n.slice(0, dot);
      n += '.ijm';
    }
    return n;
  }

  function ijD2s(n, places) {
    if (root.IJOv && typeof root.IJOv.d2s === 'function') return root.IJOv.d2s(n, places);
    throw new Error('IJMacroRec: IJ.d2s (ij-proc-ov.js) is not loaded');
  }
  function rtD2s(n, places) {
    if (root.IJAna && typeof root.IJAna.d2s === 'function') return root.IJAna.d2s(n, places);
    throw new Error('IJMacroRec: ResultsTable.d2s (ij-proc-ana.js) is not loaded');
  }

  // the record(...) overloads of Recorder.java (macro mode), each giving the exact text appended to the window
  const line = Object.freeze({
    r0: (method) => method + ';\n',                                                                       // record(String) :143-146
    r1: (method, arg) => (method === 'setTool' ? '//setTool' : method) + '("' + arg + '");\n',           // record(String,String) :216-233
    r2: (method, a1, a2) => method + '("' + a1 + '", "' + (a1 === 'Open' || a1 === 'Save' || method === 'saveAs' ? fixPath(a2) : a2) + '");\n',
    r3: (method, a1, a2, a3) => method + '("' + a1 + '", "' + a2 + '","' + a3 + '");\n',                  // :248-251
    ri: (method, ...ints) => method + '(' + ints.map(jint).join(', ') + ');\n',                          // int overloads :253-322
    rdd: (method, d1, d2) => {                                                                            // :263-268
      const places = Math.abs(d1) < 0.0001 || Math.abs(d2) < 0.0001 ? 9 : 4;
      return method + '(' + ijD2s(d1, places) + ', ' + ijD2s(d2, places) + ');\n';
    },
    riis: (method, a1, a2, s) => method + '(' + jint(a1) + ', ' + jint(a2) + ', "' + s + '");\n',        // :258-261
    rsi: (method, s, i) => method + '("' + s + '", ' + jint(i) + ');\n',                                  // :277-280
    riiiid: (method, a1, a2, a3, a4, d) => method + '(' + [a1, a2, a3, a4].map(jint).join(', ') + ', ' + ijD2s(d, 2) + ');\n'   // :329-332
  });

  // Colors.colorToString: the lower-case name of one of Java's named colours, else #rrggbb (PointRoi lower-cases its whole option string)
  const COLOR_NAMES = [['red', [255, 0, 0]], ['green', [0, 255, 0]], ['blue', [0, 0, 255]], ['magenta', [255, 0, 255]], ['cyan', [0, 255, 255]],
    ['yellow', [255, 255, 0]], ['orange', [255, 200, 0]], ['black', [0, 0, 0]], ['white', [255, 255, 255]], ['gray', [128, 128, 128]],
    ['lightGray', [192, 192, 192]], ['darkGray', [64, 64, 64]], ['pink', [255, 175, 175]]];
  const hex2 = (x) => (jint(x) & 255).toString(16).padStart(2, '0');
  function colorToString(c) {
    if (!Array.isArray(c) || c.length < 3) return 'none';
    for (const [n, v] of COLOR_NAMES) if (v[0] === c[0] && v[1] === c[1] && v[2] === c[2]) return n;
    return '#' + hex2(c[0]) + hex2(c[1]) + hex2(c[2]);
  }

  // Toolbar.getName for the Studio's tools (Toolbar.java:885-896); a Studio-only tool records nothing
  const TOOL_NAMES = Object.freeze({ rect: 'rectangle', oval: 'oval', polygon: 'polygon', freehand: 'freehand', line: 'line', polyline: 'polyline',
    angle: 'angle', point: 'point', wand: 'wand', zoom: 'zoom', hand: 'hand' });
  const THRESHOLD_MODES = Object.freeze({ red: 'Red', bw: 'B&W', overunder: 'Over/Under' });
  // RoiManager buttons that record roiManager("<op>") through record() :2810-2814 (never while a macro runs)
  const RM_PLAIN = new Set(['Update', 'Delete', 'Measure', 'Deselect', 'Fill', 'Draw', 'XOR', 'Split', 'Multi Measure', 'Multi Plot', 'Sort', 'AND']);
  // RoiManager controls that test IJ.recording() alone (itemStateChanged :308-331, "OR (Combine)" :250-251): recorded while a macro waits
  const RM_ALWAYS = new Set(['Show All', 'Show None', 'Show All with labels', 'Show All without labels', 'OR']);
  // Recorder.isSaveAs :706-723
  const SAVE_AS = new Set(['Tiff...', 'Gif...', 'Jpeg...', 'Text Image...', 'ZIP...', 'Raw Data...', 'BMP...', 'PNG...', 'PGM...', 'FITS...', 'LUT...',
    'Selection...', 'XY Coordinates...', 'Text... ', 'Save']);

  // ── selections (Roi / Line / PolygonRoi / PointRoi handleMouseUp, ImageCanvas's Wand click) ──────────────────────────────

  /**
   * The line(s) one selection action records, '' when ImageJ records nothing: a rectangle / oval / straight line on every mouse-up
   * (draw, move, resize), a polygon / segmented line / angle when it is built (userCreated), the first point of a point selection,
   * the Wand click as doWand(x, y, tolerance, mode). Freehand, nudges, clears and a Shift-added point record nothing.
   */
  function roiLines(rec, ctx) {
    if (!rec || rec.kind !== 'roi') return '';
    const action = rec.action;
    if (action === 'clear' || action === 'nudge') return '';
    if (rec.wand && typeof rec.wand === 'object') {
      if (action !== 'draw') return '';
      const w = rec.wand;
      const tol = root.IJMacroOptions && typeof root.IJMacroOptions.javaToString === 'function' ? root.IJMacroOptions.javaToString(Number(w.tolerance) || 0) : String(Number(w.tolerance) || 0);
      // ImageCanvas.java:1229 — the Studio has no Legacy mode, so never the 2-argument doWand
      return 'doWand(' + jint(w.x) + ', ' + jint(w.y) + ', ' + tol + ', "' + (Number(w.connectivity) === 4 ? '4-connected' : '8-connected') + '");\n';
    }
    const roi = rec.roi;
    if (!roi || typeof roi !== 'object') return '';
    const moved = action === 'draw' || action === 'move' || action === 'resize';
    switch (roi.type) {
      case 'rect':
        return moved ? line.ri('makeRectangle', roi.x, roi.y, roi.w, roi.h) : '';
      case 'oval':
        return moved ? line.ri('makeOval', roi.x, roi.y, roi.w, roi.h) : '';
      case 'line':
        return moved ? line.ri('makeLine', roi.x1, roi.y1, roi.x2, roi.y2) : '';
      case 'polygon': case 'polyline': {
        if (action !== 'draw' || roi.traced || !Array.isArray(roi.points)) return '';
        // recordRoi(Polygon, type) :445-455: the arguments are joined with ',' and no space
        const args = roi.points.map((p) => toIntR(p[0]) + ',' + toIntR(p[1])).join(',');
        return (roi.type === 'polyline' ? 'makeLine(' : 'makePolygon(') + args + ');\n';
      }
      case 'angle': {
        if (action !== 'draw' || !Array.isArray(roi.points) || roi.points.length < 3) return '';
        const p = roi.points;
        return 'makeSelection("angle",newArray(' + toIntR(p[0][0]) + ',' + toIntR(p[1][0]) + ',' + toIntR(p[2][0]) + '),newArray('
          + toIntR(p[0][1]) + ',' + toIntR(p[1][1]) + ',' + toIntR(p[2][1]) + '));\n';
      }
      case 'point': {
        if (action !== 'draw' || rec.combine === 'add' || !Array.isArray(roi.points) || roi.points.length !== 1) return '';
        const sel = (ctx && ctx.sel) || (rec.ctx && rec.ctx.sel) || [255, 255, 0];
        // PointRoi.java:145-153: sizes[SMALL] + colour + types[HYBRID], lower-cased
        const options = ('Small ' + colorToString(sel) + ' Hybrid').toLowerCase();
        return line.riis('makePoint', Math.floor(Number(roi.points[0][0])), Math.floor(Number(roi.points[0][1])), options);
      }
      default:
        return '';
    }
  }

  // ── commands (Executer.setCommand / Recorder.saveCommand) ─────────────────────────────────────────────────────────────

  function opts() {
    const O = root.IJMacroOptions;
    if (!O || typeof O.recordTokens !== 'function' || typeof O.foldTokens !== 'function') throw new Error('IJMacroRec: IJMacroOptions.recordTokens / foldTokens (ij-macro-cmds.js) are not loaded');
    return O;
  }
  /** Macro.getValue for appendNewImage */
  function getValue(options, key, dflt) {
    const O = root.IJMacroOptions;
    const v = O && typeof O.getValue === 'function' ? O.getValue(options, key, dflt) : null;
    return v === null || v === undefined ? dflt : v;
  }
  /** Tools.parseDouble then Java's (int): a text that is no number gives (int)NaN = 0. */
  function parseInt0(s) {
    const t = String(s).trim();
    const n = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(t) ? Number(t) : NaN;
    return jint(n);
  }
  /** Recorder.appendNewImage :725-753 */
  function newImageLine(options, hyperstack) {
    const o = (options === null ? 'null' : options) + ' ';
    const title = getValue(o, 'name', 'Untitled');
    let type = getValue(o, 'type', '8-bit');
    const fill = getValue(o, 'fill', '');
    if (fill !== '') type = type + ' ' + fill.toLowerCase();
    if (hyperstack) {
      const mode = getValue(o, 'display', '');
      if (mode !== '') type = type + ' ' + mode.toLowerCase() + '-mode';
      if (o.indexOf(' label') >= 0) type = type + ' label';
    }
    const width = parseInt0(getValue(o, 'width', '512'));
    const height = parseInt0(getValue(o, 'height', '512'));
    let dims = ', ' + parseInt0(getValue(o, 'slices', '1'));
    if (hyperstack) dims = ', ' + parseInt0(getValue(o, 'channels', '1')) + ', ' + parseInt0(getValue(o, 'slices', '1')) + ', ' + parseInt0(getValue(o, 'frames', '1'));
    return 'newImage("' + title + '", "' + type + '", ' + width + ', ' + height + dims + ');\n';
  }
  /** Recorder.recordPath :492-507 */
  function recordPath(options, key, path) {
    if (key === null || key === undefined) return options;
    const k = trimKey(key);
    const p = addQuotes(fixPath(path));
    if (options !== null && options.indexOf(k + '=' + p) >= 0) return options;
    return options === null || options === ' ' ? k + '=' + p : options + ' ' + k + '=' + p;
  }
  const isNonAscii = (s) => { for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) > 127) return true; return false; };
  const has = (o, k) => !!o && Object.prototype.hasOwnProperty.call(o, k);

  /** The FileSpec of a file command (EXTRAS.md §4.1 FileRef comes only with those): its OpenDialog / SaveDialog title is the path key. */
  function fileSpecOf(rec) {
    const C = root.IJMacroCmds;
    if (!C) return null;
    if (C.MACRO_COMMANDS && rec.id && has(C.MACRO_COMMANDS, rec.id) && C.MACRO_COMMANDS[rec.id].file) return C.MACRO_COMMANDS[rec.id].file;
    if (typeof C.resolve === 'function') {
      const r = C.resolve(rec.name);
      if (r && r.file) return r.file;
      if (r && r.entry && r.entry.file) return r.entry.file;
    }
    return null;
  }

  /** The ImageJ item text of a choice value (the table's items map, else the option label the dialog showed). */
  function itemText(field, value, entry) {
    const map = entry && entry.items && entry.items[field.id];
    if (map) for (const k of Object.keys(map)) if (map[k] !== null && String(map[k]) === String(value)) return k;
    const o = (field.options || []).find((x) => String(x && typeof x === 'object' ? x.value : x) === String(value));
    if (o && typeof o === 'object') return String(o.label !== undefined ? o.label : o.value);
    return o !== undefined ? String(o) : String(value);
  }
  /** ImageCalculator.java:176-188: imageCalculator("<op>[ create][ 32-bit][ stack]", "<img1>", "<img2>") and no run() line. */
  function imageCalculatorLine(rec) {
    const step = (rec.steps || []).find((s) => s && s.kind === 'dialog' && s.values);
    if (!step) return null;
    const fields = (step.fields || []).filter(Boolean);
    const keys = (step.entry && step.entry.keys) || {};
    const fieldOf = (ijKey) => fields.find((f) => (has(keys, f.id) ? keys[f.id] : f.ijKey) === ijKey) || null;
    const fOp = fieldOf('operation'), f1 = fieldOf('image1'), f2 = fieldOf('image2'), fCreate = fieldOf('create'), fFloat = fieldOf('32-bit');
    if (!fOp || !f1 || !f2) return null;
    const v = step.values;
    let options = itemText(fOp, v[fOp.id], step.entry);
    const create = fCreate && has(v, fCreate.id) ? !!v[fCreate.id] : (rec.created || []).length > 0;
    if (create) options += ' create';
    if (fFloat && v[fFloat.id]) options += ' 32-bit';
    if ((rec.steps || []).some((s) => s && s.kind === 'stack' && s.answer === 'all')) options += ' stack';
    return line.r3('imageCalculator', options, itemText(f1, v[f1.id], null), itemText(f2, v[f2.id], null));
  }

  // ── the model ───────────────────────────────────────────────────────────────────────────────────────────────────────

  function create() {
    const st = { open: false, text: '', name: DEFAULT_NAME, cmd: null, fgColorSet: false, bgColorSet: false, bbSet: false };
    const listeners = new Set();

    function changed(kind, appended) {
      for (const fn of Array.from(listeners)) {
        try { fn({ kind, appended: appended || '', text: st.text }); } catch (err) { if (typeof console !== 'undefined') console.error('[advanced-studio] recorder listener', err); }
      }
    }
    function append(s) {
      if (!st.open || !s) return;
      st.text += s;
      changed('append', s);
    }

    /**
     * Recorder.saveCommand :559-686 in macro mode, for the command `name` with `options` (null when no dialog recorded anything) and
     * `imp` = the image after the command. → { pre: string, line: string, post: string }: lines before the command line (colours,
     * black background), the command line itself, and the line after it (the non-ASCII warning).
     */
    function saveCommand(nameIn, optionsIn, imp, rec) {
      let name = nameIn, options = optionsIn;
      let pre = '', cmdLine = '', post = '';
      const ctx = imp || {};
      if (name === 'Duplicate Image...') name = 'Duplicate...';
      if (name === 'Make Binary' && ctx.docId !== null && ctx.docId !== undefined && Number(ctx.nSlices) === 1) { name = 'Convert to Mask'; options = null; }
      if (options === null && (name === 'Fill' || name === 'Clear' || name === 'Draw')) options = 'slice';
      if (!st.fgColorSet && (name === 'Fill' || name === 'Draw')) { pre += line.ri('setForegroundColor', ...rgb(ctx.fg, [255, 255, 255])); st.fgColorSet = true; }
      else if (!st.bgColorSet && (name === 'Clear' || name === 'Clear Outside')) { pre += line.ri('setBackgroundColor', ...rgb(ctx.bg, [0, 0, 0])); st.bgColorSet = true; }
      if (!st.bbSet && (name === 'Convert to Mask' || name === 'Erode' || name === 'Dilate' || name === 'Skeletonize')) {
        pre += 'setOption("BlackBackground", ' + (ctx.blackBackground ? 'true' : 'false') + ');\n';
        st.bbSet = true;
      }
      if (name === 'Add Shortcut by Name... ') name = 'Add Shortcut... ';
      if (options !== null) {
        if (name === 'Open...' || name === 'URL...') cmdLine = 'open("' + fixPath(strip(options)) + '");\n';
        else if (SAVE_AS.has(name)) {
          let fmt = name;
          if (fmt.endsWith('...')) fmt = fmt.slice(0, -3);
          if (fmt === 'Save') fmt = 'Tiff';
          cmdLine = 'saveAs("' + fmt + '", "' + strip(options) + '");\n';
        } else if (name === 'Image...') cmdLine = newImageLine(options, false);
        else if (name === 'Hyperstack...' || name === 'New Hyperstack...') cmdLine = newImageLine(options, true);
        else if (name === 'Set Slice...') cmdLine = 'setSlice(' + strip(options) + ');\n';
        else if (name === 'Rename...') cmdLine = 'rename("' + strip(options) + '");\n';
        else if (name === 'Wand Tool...') cmdLine = '//run("' + name + '", "' + options + '");\n';
        else if (name === 'Results... ' && options.indexOf('.txt') === -1) cmdLine = 'open("' + strip(options) + '");\n';
        else if (name === 'Results...' || name === 'Run...') cmdLine = '';
        else {
          if (name === 'Calibrate...') {
            if (options.startsWith('function=None unit=[Gray Value]')) options = options.slice(0, 13);
            else if (options.startsWith('function=None')) {
              const i = options.indexOf(' text1=');
              if (i > 0) options = options.slice(0, i);
            }
          }
          if (name === 'Scale Bar...') {
            for (const s of ['thickness=4 ', 'location=[Lower Right] ', 'font=14 ', 'color=White ', 'background=None ']) options = options.split(s).join('');
            if (options.indexOf('height=50') >= 0 || options.indexOf('thickness=') >= 0) options = options.split('horizontal ').join('');
          }
          cmdLine = 'run("' + name + '", "' + options + '");\n';
          if (isNonAscii(options) && options.indexOf('=' + MICRON + 'm') < 0) post = '  <<warning: the options string contains one or more non-ascii characters>>\n';
        }
      } else if (name === 'Threshold...' || name === 'Fonts...' || name === 'Brightness/Contrast...' || name === 'Channels Tool...') {
        cmdLine = '//run("' + name + '");\n';
      } else if (name === 'Start Animation [\\]') cmdLine = 'doCommand("Start Animation [\\\\]");\n';
      else if (name === 'Blobs') cmdLine = 'run("Blobs (25K)");\n';
      else if (name === 'Add to Manager' || name === 'Find Commands...') cmdLine = '';
      else {
        const alt = !!(rec && (rec.alt || (rec.mods && rec.mods.alt)));
        cmdLine = (alt && (name === 'Open Next' || name === 'Plot Profile') ? 'setKeyDown("alt"); ' : '') + 'run("' + name + '");\n';
      }
      return { pre, line: cmdLine, post };
    }
    function rgb(c, dflt) {
      const v = Array.isArray(c) && c.length >= 3 ? c : dflt;
      return [v[0], v[1], v[2]];
    }

    function endCommand(rec) {
      if (rec.name === null || rec.name === undefined || rec.cls === 'E') return;
      const steps = Array.isArray(rec.steps) ? rec.steps.filter(Boolean) : [];
      const committed = steps.some((s) => s.kind === 'stack' || (s.kind === 'dialog' && s.values));
      if (rec.status === 'failed' && !committed) return;
      // Process › Batch › Macro opens a tool window: Executer saves BatchProcessor's command only when its dialog returns (Process), and
      // that line comes from the window's Process button (recordCommand, golden batch/recorded) — opening the window writes nothing
      if (rec.id === 'batchMacro' && !committed) return;
      // Commands.closeImage :138-145: record("close"), then setCommand(null) — not while a macro runs
      if (rec.name === 'Close') { if (!rec.duringMacro) append(line.r0('close')); return; }
      if (rec.name === 'Image Calculator...' && rec.status === 'ok') {
        const calc = imageCalculatorLine(rec);
        if (calc !== null) { append(studioOnly(calc, rec)); return; }
      }
      const O = opts();
      let options = null;
      for (const s of steps) {
        if (s.kind === 'dialog' && s.values) options = O.foldTokens(O.recordTokens(s.values, s.entry || null, { fields: (s.fields || []).filter(Boolean) }), options);
        else if (s.kind === 'stack') options = O.foldTokens([{ t: 'flag', key: s.answer === 'all' ? 'stack' : 'slice' }], options);   // IJ.setupDialog :1286-1291
      }
      // a file another dialog of the command touched (a "Save changes?" of an image it closes) is not the command's path
      const spec = rec.file && typeof rec.file === 'object' ? fileSpecOf(rec) : null;
      const file = spec && spec.dialog && typeof spec.dialog.title === 'string' ? rec.file : null;
      const unknownFolder = !!file && (file.vpath === null || file.vpath === undefined || file.vpath === '');
      if (file) options = recordPath(options, spec.dialog.title, unknownFolder ? String(file.name || '') : file.vpath);
      const out = saveCommand(rec.name, options, rec.after || rec.before || null, rec);
      let cmd = out.line;
      if (cmd && unknownFolder) cmd = '//' + cmd.slice(0, -1) + FOLDER_UNKNOWN + '\n';
      append(conversionLine(rec) + out.pre + studioOnly(cmd, rec) + out.post);
    }
    /** ImageConverter.record (ij/process/ImageConverter.java:152-167), written while the conversion runs, so before the command's line:
     *  16 / 32-bit → 8-bit and 32-bit → 16-bit. The Studio has no "calibrate conversions" option, so always the ScaleConversions form. */
    function conversionLine(rec) {
      const b = rec.before || {};
      const bd = Number(b.bitDepth);
      if (rec.status !== 'ok' || !((rec.name === '8-bit' && (bd === 16 || bd === 32)) || (rec.name === '16-bit' && bd === 32))) return '';
      return 'setOption("ScaleConversions", ' + (b.scaleConversions === false ? 'false' : 'true') + ');\n';
    }
    // The window a command opened is activated by an AWT event after Executer's saveCommand: ImageJ then records selectImage("<new title>")
    // or not, depending on the event order (the jar's runs differ; recorder-golden.json lists them in asyncActivationStripped). Not
    // reproduced (EXTRAS.md X5 / P9): only an operator's activation is recorded.
    function studioOnly(text, rec) {
      return text && rec.cls === 'D' ? text.slice(0, -1) + STUDIO_ONLY + '\n' : text;
    }

    function onCommand(rec) {
      if (!st.open || !rec || typeof rec !== 'object') return;
      if (rec.phase === 'start') {
        if (st.cmd) return;
        st.cmd = { seq: rec.seq, name: rec.name !== null && rec.name !== undefined ? rec.name : rec.id };
        return;
      }
      if (rec.phase !== 'end' || !st.cmd || st.cmd.seq !== rec.seq) return;
      st.cmd = null;
      endCommand(rec);
    }

    /** WindowManager.setWindow :54 / the Window menu :578 → record(method, title): never inside a command, never while a macro runs. */
    function selectLine(rec, method, title) {
      if (rec.duringMacro || st.cmd) return '';
      return method + '("' + title + '");\n';
    }

    /** ContrastAdjuster.recordSetMinAndMax :1068-1083: whole numbers as ints; else two decimals and no newline (ImageJ's recordString). */
    function minAndMaxLine(min, max) {
      if (jint(min) === min && jint(max) === max) return line.ri('setMinAndMax', min, max);
      return 'setMinAndMax(' + rtD2s(min, 2) + ', ' + rtD2s(max, 2) + ');';
    }

    function thresholdLine(rec) {
      const bd = Number(rec.bitDepth);
      switch (rec.op) {
        case 'auto': case 'method': case 'dark': case 'hist16': {
          // ThresholdAdjuster.autoSetLevels :503-529: "hist16 = sixteenBit && bitDepth!=32" (the remembered box counts on 8-bit too);
          // "Don't reset range" is on by default (Prefs NO_RESET, true) and the Studio never resets the display range for a threshold,
          // so the window is always in its no-reset state. With no-reset, a 16 / 32-bit image whose display range is narrower than its
          // data first records that range (recordSetMinAndMax), when the page reports both.
          let out = '';
          if (bd !== 8 && [rec.displayMin, rec.displayMax, rec.dataMin, rec.dataMax].every((v) => typeof v === 'number' && Number.isFinite(v))
            && (rec.displayMin > rec.dataMin || rec.displayMax < rec.dataMax)) out += minAndMaxLine(rec.displayMin, rec.displayMax);
          const hist16 = !!rec.hist16 && bd !== 32;
          return out + line.r1('setAutoThreshold', String(rec.method) + (rec.dark ? ' dark' : '') + (hist16 ? ' 16-bit' : '') + ' no-reset');
        }
        case 'mode':
          return THRESHOLD_MODES[rec.mode] ? 'call("ij.plugin.frame.ThresholdAdjuster.setMode", "' + THRESHOLD_MODES[rec.mode] + '");\n' : '';
        case 'set':
          // ThresholdAdjuster.doSet :799-821 (unsigned images: the raw form)
          return bd === 32 ? line.rdd('setThreshold', Number(rec.lower), Number(rec.upper)) : line.riis('setThreshold', rec.lower, rec.upper, 'raw');
        case 'reset':
          return line.r0('resetThreshold');
        case 'apply':
          // Thresholder.applyThreshold :219-223: an 8-bit (or RGB) image with a set threshold; a 16 / 32-bit image takes
          // applyShortOrFloatThreshold, which records nothing. `!IJ.isMacro()`: not while a macro waits.
          if (rec.duringMacro || !(bd === 8 || bd === 24)) return '';
          return bd === 24 ? line.ri('//setThreshold', 255, 255) : line.ri('//setThreshold', rec.lower, rec.upper);
        default:
          return '';
      }
    }

    function bcLine(rec) {
      switch (rec.op) {
        case 'auto': return line.r2('run', 'Enhance Contrast', 'saturated=0.35');          // ContrastAdjuster.java:857-863
        case 'reset': return line.r0('resetMinAndMax');                                    // :1133-1139
        case 'set': {
          // ContrastAdjuster.doSet :925-934 then recordSetMinAndMax :1068-1083 (the fractional form has no "\n")
          let min = Number(rec.min), max = Number(rec.max);
          if (Number(rec.bitDepth) !== 32) { min = jint(min); max = jint(max); }
          return minAndMaxLine(min, max);
        }
        case 'apply':
          return rec.scope === 'slice' || rec.scope === 'stack' ? line.r2('run', 'Apply LUT', rec.scope) : line.r1('run', 'Apply LUT');   // :700-733
        default: return '';
      }
    }

    function rmLines(rec) {
      const op = String(rec.op);
      if (rec.duringMacro && !RM_ALWAYS.has(op)) return '';
      if (op === 'Add') {
        // RoiManager.recordAdd :430-439 (the Studio has no default ROI Manager colour; a colour / width given is recorded as ImageJ does)
        const color = Array.isArray(rec.color) ? rec.color : null;
        const w = Number.isFinite(Number(rec.lineWidth)) ? jint(rec.lineWidth) : 1;
        const hex = color ? hex2(color[0]) + hex2(color[1]) + hex2(color[2]) : null;
        if (color && w === 1) return 'roiManager("Add", "' + hex + '");\n';
        // getHex(null) is ImageCanvas.getShowAllColor(): cyan by default
        if (w > 1) return 'roiManager("Add", "' + (hex || '00ffff') + '", ' + w + ');\n';
        return line.r1('roiManager', 'Add');
      }
      if (op === 'Select') {
        const idx = (rec.indices || []).map(jint);
        if (!idx.length) return '';
        return idx.length === 1 ? 'roiManager("Select", ' + idx[0] + ');\n' : 'roiManager("Select", newArray(' + idx.join(',') + '));\n';   // :2862-2880
      }
      if (op === 'OR') return line.r1('roiManager', 'Combine');
      // drawOrFill :1465 starts with imp.deleteRoi(), which deselects the one selected row whose ROI is the image's (ImagePlus.deleteRoi →
      // RoiManager.deselect(roi) :2642 → record("roiManager", "Deselect")) before the button's own line
      if ((op === 'Fill' || op === 'Draw') && Array.isArray(rec.indices) && rec.indices.length === 1) return line.r1('roiManager', 'Deselect') + line.r1('roiManager', op);
      if (op === 'Rename') return line.r2('roiManager', 'Rename', String(rec.name === undefined || rec.name === null ? '' : rec.name));
      if (op === 'Open' || op === 'Save') {
        const f = rec.file && typeof rec.file === 'object' ? rec.file : null;
        if (!f) return '';
        if (f.vpath) return line.r2('roiManager', op, f.vpath);
        return '//' + line.r2('roiManager', op, String(f.name || '')).slice(0, -1) + FOLDER_UNKNOWN + '\n';
      }
      if (op === 'Properties') {
        // RoiManager.setProperties :1622-1641
        let out = '';
        const group = Number.isInteger(rec.group) ? rec.group : 0;
        if (Number.isInteger(rec.group) && rec.group >= 0) out += line.ri('RoiManager.setGroup', rec.group);
        if (Number.isInteger(rec.position) && rec.position >= 0) out += line.ri('RoiManager.setPosition', rec.position);
        if (Array.isArray(rec.fillColor)) out += line.r2('roiManager', 'Set Fill Color', colorToString(rec.fillColor));
        else {
          if (group === 0) out += line.r2('roiManager', 'Set Color', colorToString(Array.isArray(rec.color) ? rec.color : [255, 0, 0]));
          out += line.rsi('roiManager', 'Set Line Width', Number.isFinite(Number(rec.lineWidth)) ? rec.lineWidth : 1);
        }
        return out;
      }
      if (RM_PLAIN.has(op) || RM_ALWAYS.has(op)) return line.r1('roiManager', op);
      return '';
    }

    function channelsLines(rec) {
      if (rec.op === 'mode') {
        // Channels.itemStateChanged :240-247: "cstr" is null for Color / Grayscale, which Java prints as "null"
        const mode = rec.mode === 'color' || rec.mode === 'grayscale' ? rec.mode : 'composite';
        const cstr = rec.projection !== undefined && rec.projection !== null ? String(rec.projection) : (mode === 'composite' ? 'Sum' : 'null');
        return 'Property.set("CompositeProjection", "' + cstr + '");\n' + line.r1('Stack.setDisplayMode', mode);
      }
      if (rec.op === 'active') return line.r1('Stack.setActiveChannels', String(rec.active));
      if (rec.op === 'channel') return line.ri('Stack.setChannel', rec.channel);
      return '';
    }

    function onAction(rec) {
      if (!st.open || !rec || typeof rec !== 'object') return;
      switch (rec.kind) {
        case 'roi': append(roiLines(rec, rec.ctx)); break;
        // WindowManager.setCurrentWindow :54 → record("selectImage", title): the raw title (Recorder.record(String, String) quotes it as is)
        case 'activate': append(selectLine(rec, 'selectImage', String(rec.title === null || rec.title === undefined ? '' : rec.title))); break;
        case 'window': append(selectLine(rec, 'selectWindow', String(rec.title))); break;
        case 'tool': if (TOOL_NAMES[rec.tool]) append(line.r1('setTool', TOOL_NAMES[rec.tool])); break;
        case 'lineWidth': append('run("Line Width...", "line=' + jint(rec.width) + '");\n'); break;
        case 'threshold': append(thresholdLine(rec)); break;
        case 'bc': append(bcLine(rec)); break;
        case 'rm': append(rmLines(rec)); break;
        case 'channels': append(channelsLines(rec)); break;
        default: break;
      }
    }

    return Object.freeze({
      /** new Recorder(): a fresh, empty text and the colour / black-background flags cleared; nothing when already open (toFront). */
      open() {
        if (st.open) return;
        st.open = true; st.text = ''; st.cmd = null;
        st.fgColorSet = st.bgColorSet = st.bbSet = false;
        changed('open');
      },
      /** Recorder.close: the text goes with the window (the next open starts empty). */
      close() {
        if (!st.open) return;
        st.open = false; st.text = ''; st.cmd = null;
        changed('close');
      },
      isOpen: () => st.open,
      text: () => st.text,
      setText(s) { if (!st.open) return; st.text = String(s === undefined || s === null ? '' : s); changed('set'); },
      clear() { if (!st.open) return; st.text = ''; changed('set'); },
      name: () => st.name,
      setName(s) { st.name = String(s === undefined || s === null ? '' : s); changed('name'); },
      inCommand: () => !!st.cmd,
      onCommand,
      onAction,
      resetFlags() { st.fgColorSet = st.bgColorSet = st.bbSet = false; },
      on(event, fn) {
        if (event !== 'change' || typeof fn !== 'function') throw new Error('IJMacroRec: on(\'change\', fn)');
        listeners.add(fn);
        return () => listeners.delete(fn);
      }
    });
  }

  // ── Run: Recorder.runCode :924-971 ─────────────────────────────────────────────────────────────────────────────────────

  /** The text Run executes for a selection [start, end) of `text`: the selection, or the line holding the caret. null = the caret is at
   *  offset 0 with nothing selected (ImageJ shows its hint instead). → { start, end, text } (the range ImageJ selects, then runs). */
  function runRange(text, startIn, endIn) {
    const t = String(text === undefined || text === null ? '' : text);
    let start = Math.max(0, Math.min(t.length, Number(startIn) || 0));
    let end = Math.max(start, Math.min(t.length, Number(endIn) || 0));
    if (start === 0 && end === 0) return null;
    if (start === end) {
      while (start > 0) {
        start--;
        if (t.charAt(start) === '\n') { start++; break; }
      }
      if (end < t.length && t.charAt(end) === '\n') end--;
      while (end < t.length - 1) {
        end++;
        if (t.charAt(end) === '\n') break;
      }
    }
    return { start, end, text: t.slice(start, end) };
  }

  // ── the Recorder window (extension panel `macroRecorder`) ────────────────────────────────────────────────────────────

  /**
   * Fills the panel element: "Record:" [Macro] "Name:" [Macro.ijm] [Create] [Run] [Help] above an editable monospaced text area.
   * papi = { tr, model, create(name, text), run(text), message(titleKey, textKey), isRunning() }.
   */
  function buildPanel(el, papi) {
    const doc = el.ownerDocument || root.document;
    const model = papi.model;
    const tr = (k) => papi.tr(k);
    const mk = (tag, cls, text) => {
      const n = doc.createElement(tag);
      if (cls) n.className = cls;
      if (text !== undefined) n.textContent = text;
      return n;
    };
    const bar = mk('div', 'ij-mac-rec-row');
    const recLabel = mk('label', 'ij-mac-rec-label', tr('dlg.mac.rec.record'));
    const mode = mk('select', 'ij-mac-rec-mode');
    const opt = mk('option', null, tr('dlg.mac.rec.modeMacro'));
    opt.value = 'Macro';
    mode.appendChild(opt);
    mode.disabled = true;
    const nameLabel = mk('label', 'ij-mac-rec-label', tr('dlg.mac.rec.name'));
    const name = mk('input', 'ij-mac-rec-name');
    name.type = 'text';
    name.value = model.name();
    name.spellcheck = false;
    const bCreate = mk('button', 'ij-mac-rec-btn', tr('dlg.mac.rec.create'));
    const bRun = mk('button', 'ij-mac-rec-btn', tr('dlg.mac.rec.run'));
    const bHelp = mk('button', 'ij-mac-rec-btn', tr('dlg.mac.rec.help'));
    for (const b of [bCreate, bRun, bHelp]) b.type = 'button';
    for (const n of [recLabel, mode, nameLabel, name, bCreate, bRun, bHelp]) bar.appendChild(n);
    const area = mk('textarea', 'ij-mac-rec-text');
    area.spellcheck = false;
    area.wrap = 'off';
    area.value = model.text();
    if (el.classList && typeof el.classList.add === 'function') el.classList.add('ij-mac-rec');
    else el.className = (el.className ? el.className + ' ' : '') + 'ij-mac-rec';
    el.appendChild(bar);
    el.appendChild(area);

    let editing = false;
    const off = model.on('change', (ev) => {
      if (ev.kind === 'name') { if (name.value !== model.name()) name.value = model.name(); return; }
      if (editing) return;
      if (ev.kind === 'append' && area.value + ev.appended === model.text()) {
        const s = area.selectionStart, e = area.selectionEnd;
        area.value = model.text();
        if (typeof s === 'number' && typeof e === 'number' && (s !== e || s < area.value.length - ev.appended.length)) { area.selectionStart = s; area.selectionEnd = e; }
        area.scrollTop = area.scrollHeight;
        return;
      }
      area.value = model.text();
    });

    function onCreate() {
      const text = model.text();
      if (!text) { papi.message('dlg.mac.rec.title', 'dlg.mac.rec.createEmpty'); return; }
      Promise.resolve(papi.create(macroName(model.name()), text))
        .then((done) => { if (done !== false) model.resetFlags(); })
        .catch((err) => { if (typeof console !== 'undefined') console.error('[advanced-studio] recorder create', err); });
    }
    function onRun() {
      if (typeof papi.isRunning === 'function' && papi.isRunning()) return;
      const r = runRange(area.value, area.selectionStart, area.selectionEnd);
      if (!r) { papi.message('dlg.mac.rec.title', 'dlg.mac.rec.runHint'); return; }
      try { area.selectionStart = r.start; area.selectionEnd = r.end; } catch (_) { /* a control without a selection API */ }
      if (r.text === '') return;
      Promise.resolve(papi.run(r.text)).catch((err) => { if (typeof console !== 'undefined') console.error('[advanced-studio] recorder run', err); });
    }
    // dlg.mac.rec.help is the button's label; the box text is its own key
    const onHelp = () => papi.message('dlg.mac.rec.title', 'dlg.mac.rec.helpText');
    const onName = () => model.setName(name.value);
    const onInput = () => { editing = true; try { model.setText(area.value); } finally { editing = false; } };
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'Enter' || e.keyCode === 13)) { e.preventDefault(); onRun(); }
    };
    const bind = [[bCreate, 'click', onCreate], [bRun, 'click', onRun], [bHelp, 'click', onHelp], [name, 'input', onName], [name, 'change', onName],
      [area, 'input', onInput], [area, 'keydown', onKey]];
    for (const [n, t, f] of bind) n.addEventListener(t, f);

    return {
      refresh(kind) {
        if (kind !== 'lang') return;
        recLabel.textContent = tr('dlg.mac.rec.record');
        opt.textContent = tr('dlg.mac.rec.modeMacro');
        nameLabel.textContent = tr('dlg.mac.rec.name');
        bCreate.textContent = tr('dlg.mac.rec.create');
        bRun.textContent = tr('dlg.mac.rec.run');
        bHelp.textContent = tr('dlg.mac.rec.help');
      },
      dispose() {
        off();
        for (const [n, t, f] of bind) n.removeEventListener(t, f);
      },
      // the controls, for the page's tests
      controls: { mode, name, create: bCreate, run: bRun, help: bHelp, text: area }
    };
  }

  const IJMacroRec = Object.freeze({
    fixString, addQuotes, trimKey, strip, fixPath, macroName, line, roiLines, colorToString, runRange, create, buildPanel,
    TOOL_NAMES, DEFAULT_NAME
  });
  root.IJMacroRec = IJMacroRec;
})(typeof self !== 'undefined' ? self : globalThis);
