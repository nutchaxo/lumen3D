/* ij-macro-cmds.js — the run() bridge tables of the Advanced Studio's ImageJ macros (DOCS/studio-advanced/macros/INTEGRATION.md §5).
 *
 * Classic script, page and Node, pure (no DOM, no network, no engine): loaded before ij-app.js, read by it at call time only.
 * Attaches two singletons to `self`:
 *
 *   IJMacroOptions — ImageJ's option-string semantics (ij.Macro, ij.gui.GenericDialog, ij.IJ, ij.plugin.frame.Recorder 1.54p):
 *     normalize(options) → string | null      Macro.setOptions + Macro.getOptions: null / '' → null (the dialogs are shown), else options + ' '
 *     trimKey(label) → string                 Macro.trimKey
 *     keyOf(labels) → [key]                   GenericDialog.saveLabel over one dialog's labels (key, key_0, key_1, …)
 *     getValue(options, key, dflt) → string | null   Macro.getValue
 *     isMatch(options, word) → boolean        GenericDialog.isMatch(options, word + ' ') (the checkbox test)
 *     hasWord(options, word) → boolean        "word " in the normalised string (IJ.setupDialog / PlugInFilterRunner)
 *     setupDialogStack(options) → boolean     hasWord(options, 'stack')
 *     build(values, dialogEntry, spec) → string   the option string the Recorder would write for these values
 *     javaDouble(text) → number | null        Double.valueOf (null = NumberFormatException)
 *     javaToString(n) → string                Double.toString
 *
 *   IJMacroCmds — the Studio command behind each ImageJ command name, and the headless answer of its dialogs:
 *     MACRO_COMMANDS { [commandId]: Entry }, IJ_CONVERT, REFUSED_NAMES, NO_IMAGE_TEXT,
 *     resolve(name), nameOf(commandId), headlessAnswer(spec, options, ctx)
 *
 * Entry = { name, cls: 'A'|'B'|'C'|'D'|'E', refuse?, later?, alias?, dialogs: [DialogEntry], disabledText?, noopWhenDisabled?, notes? }
 * noopWhenDisabled: on an image the Studio command is disabled for, ImageJ runs the command as a no-op (run() succeeds, nothing changes).
 * DialogEntry.rewrite(options) → options: the plugin's own Macro.setOptions before its dialog (Scaler, ImageProperties, ContrastEnhancer).
 * DialogEntry = { ij: '<capture key>' | null, title: string | null (null = the title the dialog shows), keys: { fieldId: imagejKey | null },
 *   items: { fieldId: { imagejItemText: studioValue (null = keep the default) } }, smart?, titles?: [fieldId], derive?: { fieldId(options) },
 *   refuse?: langKey, setup? }
 * Beyond INTEGRATION.md §5.2: `alias` (an entry that shares its name with the command it duplicates and is never resolved), `titles`
 * (a choice that lists open images by title: an item not in `items` is matched against the option labels), `derive` (a field set from
 * the options string by a rule of its own, e.g. Set Measurements' redirect=None), DialogEntry `refuse` (a dialog variant macros may not
 * answer: the figure's projection from the site's dataset), `title: null`, DialogEntry `setup` (a PlugInFilter: its "all channels" check
 * follows IJ.setupDialog, which also reads headlessAnswer's optional ctx.composite / ctx.rgb).
 *
 * Keys come from tests/fixtures/ij-macro/ij-dialogs.json and fiji-macro-keys.json (the real jar / Fiji, DialogKeys.java) and from the
 * ImageJ 1.54p sources (DOCS/studio-advanced/macros/ij-src) for the dialogs the capture could not open. Reference: ImageJ 1.54p.
 */
(function (root) {
  'use strict';

  // ═══════════════════════════════════════ IJMacroOptions ═══════════════════════════════════════

  function normalize(options) {
    if (options === null || options === undefined) return null;
    const s = String(options);
    return s === '' ? null : s + ' ';
  }

  function trimKey(label) {
    let key = String(label);
    let i = key.indexOf(' ');
    if (i > -1) key = key.slice(0, i);
    i = key.indexOf(':');
    if (i > -1) key = key.slice(0, i);
    return key.toLowerCase();
  }

  function keyOf(labels) {
    const used = new Set(), out = [];
    for (const raw of labels || []) {
      let key = String(raw);
      if (key.length > 0) key = trimKey(key.trim());
      if (key.length > 0 && used.has(key)) {
        key += '_0';
        for (let n = 1; used.has(key); n++) key = key.slice(0, key.lastIndexOf('_')) + '_' + n;
      }
      used.add(key);
      out.push(key);
    }
    return out;
  }

  // Character.isLetter of one UTF-16 unit
  const LETTER = /\p{L}/u;
  const isLetter = (ch) => LETTER.test(ch);

  function getValue(options, key, dflt) {
    if (options === null || options === undefined) return dflt;
    let opts = String(options);
    const k = trimKey(key) + '=';
    if (!opts.endsWith(' ')) opts += ' ';
    let index = -1;
    do {
      index = opts.indexOf(k, ++index);
      if (index < 0) return dflt;
    } while (index !== 0 && isLetter(opts.charAt(index - 1)));
    opts = opts.slice(index + k.length);
    if (opts.charAt(0) === "'") {
      const e = opts.indexOf("'", 1);
      return e < 0 ? dflt : opts.slice(1, e);
    }
    if (opts.charAt(0) === '[') {
      let count = 1, e = -1;
      for (let i = 1; i < opts.length; i++) {
        const ch = opts.charAt(i);
        if (ch === '[') count++;
        else if (ch === ']') count--;
        if (count === 0) { e = i; break; }
      }
      return e < 0 ? dflt : opts.slice(1, e);
    }
    const e = opts.indexOf(' ');
    return e < 0 ? dflt : opts.slice(0, e);
  }

  /** GenericDialog.isMatch(s1, s2): s2 in s1, not inside a [bracketed literal] and not right after '='. */
  function javaIsMatch(s1, s2) {
    if (s1.startsWith(s2)) return true;
    s2 = ' ' + s2;
    const len1 = s1.length, len2 = s2.length;
    let inLiteral = false;
    for (let i = 0; i < len1 - len2 + 1; i++) {
      const c = s1.charAt(i);
      if (inLiteral && c === ']') inLiteral = false;
      else if (c === '[') inLiteral = true;
      if (c !== s2.charAt(0) || inLiteral || (i > 1 && s1.charAt(i - 1) === '=')) continue;
      let match = true;
      for (let j = 0; j < len2; j++) if (s2.charAt(j) !== s1.charAt(i + j)) { match = false; break; }
      if (match) return true;
    }
    return false;
  }

  function isMatch(options, word) {
    if (options === null || options === undefined) return false;
    let s = String(options);
    if (!s.endsWith(' ')) s += ' ';
    return javaIsMatch(s, trimKey(word) + ' ');
  }

  function hasWord(options, word) {
    if (options === null || options === undefined) return false;
    let s = String(options);
    if (!s.endsWith(' ')) s += ' ';
    return s.indexOf(word + ' ') >= 0;
  }

  const setupDialogStack = (options) => hasWord(options, 'stack');

  // Double.valueOf: Java trims the characters <= ' ', accepts NaN, Infinity, a decimal with an optional f/F/d/D suffix and a hex float
  const JAVA_DEC = /^[+-]?(?:NaN|Infinity|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?[fFdD]?)$/;
  const JAVA_HEX = /^([+-]?)0[xX]((?:[0-9a-fA-F]+\.?[0-9a-fA-F]*)|(?:\.[0-9a-fA-F]+))[pP]([+-]?\d+)[fFdD]?$/;
  function javaTrim(s) {
    let a = 0, b = s.length;
    while (a < b && s.charCodeAt(a) <= 32) a++;
    while (b > a && s.charCodeAt(b - 1) <= 32) b--;
    return s.slice(a, b);
  }
  function javaDouble(text) {
    if (text === null || text === undefined) return null;
    const s = javaTrim(String(text));
    if (JAVA_DEC.test(s)) {
      const body = s.replace(/[fFdD]$/, '');
      if (/NaN$/.test(body)) return NaN;
      if (/Infinity$/.test(body)) return body.charAt(0) === '-' ? -Infinity : Infinity;
      return Number(body);
    }
    const h = JAVA_HEX.exec(s);
    if (h) {
      const [ip, fp = ''] = h[2].split('.');
      let m = 0;
      for (const ch of ip + fp) m = m * 16 + parseInt(ch, 16);
      const v = m * Math.pow(2, Number(h[3]) - 4 * fp.length);
      return h[1] === '-' ? -v : v;
    }
    return null;
  }
  /** GenericDialog.parseHex: Integer.parseInt(s, 16), 0 when it throws. */
  function parseHex(s) {
    if (!/^[+-]?[0-9a-fA-F]+$/.test(s)) return 0;
    const v = parseInt(s, 16);
    return v >= -2147483648 && v <= 2147483647 ? v : 0;
  }

  /** Double.toString: the shortest digits that round-trip, plain between 10^-3 and 10^7, else d.dddE±n. */
  function javaToString(n) {
    if (Number.isNaN(n)) return 'NaN';
    if (n === Infinity) return 'Infinity';
    if (n === -Infinity) return '-Infinity';
    if (n === 0) return Object.is(n, -0) ? '-0.0' : '0.0';
    const sign = n < 0 ? '-' : '';
    const a = Math.abs(n);
    const m = /^(\d)(?:\.(\d+))?e([+-]\d+)$/.exec(a.toExponential());
    const digits = m[1] + (m[2] || '');
    const exp = Number(m[3]);
    if (a >= 1e-3 && a < 1e7) {
      if (exp >= 0) {
        const ip = digits.slice(0, exp + 1).padEnd(exp + 1, '0');
        const fp = digits.slice(exp + 1);
        return sign + ip + '.' + (fp || '0');
      }
      return sign + '0.' + '0'.repeat(-exp - 1) + digits;
    }
    // computerized notation needs a fraction digit: with one shortest digit Java writes the two-digit decimal nearest the value (4.9E-324)
    if (digits.length === 1) {
      const p = /^(\d)\.(\d)e([+-]\d+)$/.exec(a.toExponential(1));
      return sign + p[1] + '.' + p[2] + 'E' + Number(p[3]);
    }
    return sign + digits.charAt(0) + '.' + digits.slice(1) + 'E' + exp;
  }

  // Recorder.fixString / addQuotes / GenericDialog.trim — the text a recorded option takes
  function fixString(str) {
    let out = '';
    for (let i = 0; i < str.length; i++) {
      const c = str.charAt(i), code = str.charCodeAt(i);
      if (c === '\\' || c === '"') out += '\\' + c;
      else if (c === '\n') out += '\\n';
      else if (code < 32 || (code > 126 && code < 0xa0)) out += '\\' + code.toString(8).padStart(3, '0');
      else out += c;
    }
    return out;
  }
  const addQuotes = (v) => (v.indexOf(' ') > -1 ? '[' + v + ']' : v);
  function trimNumber(v) {
    if (v.endsWith('.0')) v = v.slice(0, -2);
    if (v.endsWith('.00')) v = v.slice(0, -3);
    return v;
  }
  function numberText(v, f) {
    if (!Number.isFinite(v)) return javaToString(v);
    if (f && Number.isInteger(f.decimals)) return v.toFixed(f.decimals);
    if (Number.isInteger(v)) return String(v);
    return String(Number(v.toPrecision(10)));
  }
  const optValue = (o) => (o && typeof o === 'object' ? o.value : o);
  const optLabel = (o) => (o && typeof o === 'object' ? (o.label !== undefined ? String(o.label) : String(o.value)) : String(o));

  /** The option string GenericDialog + Recorder write for `values` of the dialog `spec` described by `de` (component order). */
  function build(values, de, spec) {
    const keys = (de && de.keys) || {};
    const parts = [];
    for (const f of (spec && spec.fields) || []) {
      if (!f || f.type === 'message' || !Object.prototype.hasOwnProperty.call(values || {}, f.id)) continue;
      let key = Object.prototype.hasOwnProperty.call(keys, f.id) ? keys[f.id] : (f.ijKey || (f.id === 'all' && f.type === 'check' ? 'stack' : null));
      if (!key) continue;
      key = trimKey(fixString(key));
      const v = values[f.id];
      const isDefault = v === f.value || (typeof v === 'number' && typeof f.value === 'number' && numberText(v, f) === numberText(f.value, f));
      if (f.type === 'check') { if (v) parts.push(key); continue; }
      if (de && de.smart && isDefault) continue;
      let text;
      if (f.type === 'number' || f.type === 'slider') text = trimNumber(numberText(Number(v), f));
      else if (f.type === 'choice' || f.type === 'radio' || f.type === 'doc' || f.type === 'channel') text = itemTextOf(f, v, de);
      else text = fixString(String(v));
      if (text === '') text = '[]';
      parts.push(key + '=' + addQuotes(text));
    }
    return parts.join(' ');
  }
  function itemTextOf(f, v, de) {
    const map = de && de.items && de.items[f.id];
    if (map) for (const k of Object.keys(map)) if (map[k] !== null && String(map[k]) === String(v)) return k;
    if (f.type === 'channel' && !map) { const n = Number(v); if (Number.isInteger(n)) return String(n + 1); }
    const o = (f.options || []).find((x) => String(optValue(x)) === String(v));
    return o ? optLabel(o) : String(v);
  }

  const IJMacroOptions = { normalize, trimKey, keyOf, getValue, isMatch, hasWord, setupDialogStack, build, javaDouble, javaToString, parseHex, fixString };

  // ═══════════════════════════════════════ the command table ═══════════════════════════════════════

  const T = {};
  /** id, ImageJ name, class, dialogs, extra fields of the entry. */
  function add(id, name, cls, dialogs, extra) {
    if (T[id]) throw new Error('ij-macro-cmds: duplicate entry ' + id);
    T[id] = Object.assign({ name, cls, dialogs: dialogs || [] }, extra || {});
  }
  const dlg = (ij, title, keys, more) => Object.assign({ ij, title, keys }, more || {});
  /** items whose ImageJ text is the Studio value */
  const same = (list) => { const o = {}; for (const x of list) o[x] = x; return o; };
  const lowerOf = (list) => { const o = {}; for (const x of list) o[x] = x.toLowerCase(); return o; };
  const refused = (id, name, reason) => add(id, name, 'E', [], { refuse: reason });
  const later = (id, name) => add(id, name, 'E', [], { refuse: 'err.macFileLater', later: true });

  const INTERP = { None: 'none', Bilinear: 'bilinear', Bicubic: 'bicubic' };
  /** Scaler.showDialog in macro mode: " interpolate" → Bilinear, no interpolation= → None; width= and height= → the scales default to "-". */
  function scalerOptions(options) {
    let o = options;
    if (o.indexOf(' interpolate') >= 0) o = o.split(' interpolate').join(' interpolation=Bilinear');
    else if (o.indexOf(' interpolation=') < 0) o = o + ' interpolation=None';
    if (o.indexOf('width=') >= 0 && o.indexOf(' height=') >= 0) {
      const extra = [];
      if (getValue(o, 'x', null) === null) extra.push('x=-');
      if (getValue(o, 'y', null) === null) extra.push('y=-');
      if (getValue(o, 'z', null) === null) extra.push(o.indexOf(' depth=') >= 0 ? 'z=-' : 'z=1.0');
      if (extra.length) o = o.trimEnd() + ' ' + extra.join(' ');
    }
    return o.endsWith(' ') ? o : o + ' ';
  }
  const PROJ = { 'Average Intensity': 'avg', 'Max Intensity': 'max', 'Min Intensity': 'min', 'Sum Slices': 'sum', 'Standard Deviation': 'sd', Median: 'median' };
  const DISPLAY = { Composite: 'composite', Color: 'color', Grayscale: 'gray' };
  const COLORS13 = same(['red', 'green', 'blue', 'magenta', 'cyan', 'yellow', 'orange', 'black', 'white', 'gray', 'lightgray', 'darkgray', 'pink']);
  const BIN_METHODS = same(['Default', 'Huang', 'Intermodes', 'IsoData', 'IJ_IsoData', 'Li', 'MaxEntropy', 'Mean', 'MinError', 'Minimum', 'Moments', 'Otsu', 'Percentile', 'RenyiEntropy', 'Shanbhag', 'Triangle', 'Yen']);
  const CZT = same(['channel', 'slice', 'frame']);
  const ALL = 'stack';   // the Studio's "Process all channels" = PlugInFilterRunner's `stack` word in macro mode (INTEGRATION.md §5.3)
  const STACK_TO_BINARY = (cap) => dlg(cap, 'Convert Stack to Binary',
    { method: 'method', background: 'background', calculate: 'calculate', only: 'only', black: 'black', list: 'list', create: 'create' },
    { items: { method: BIN_METHODS, background: same(['Default', 'Dark', 'Light']) } });
  const MATH = (cap, title) => dlg(cap, title, { value: 'value', all: ALL }, { setup: true });
  const RADIUS = (cap, title) => dlg(cap, title, { radius: 'radius', all: ALL }, { setup: true });
  const BITS = (cap, title) => dlg(cap, title, { bits: 'value', all: ALL }, { setup: true });
  const RGB_KEEP = (cap) => dlg(cap, 'Convert to RGB', { slices: 'slices', frames: 'frames', keep: 'keep' });

  // ── File
  later('fileOpen', 'Open...');
  later('fileSaveTiff', 'Tiff...');
  later('fileSaveJpeg', 'Jpeg...');
  later('fileSavePng', 'PNG...');
  later('fileSaveResults', 'Results...');
  add('fileRevert', 'Revert', 'A');
  refused('fileRecover', 'Recover...', 'err.macReasonRecover');
  add('fileClose', 'Close', 'A');
  refused('fileSimple', 'Back to Simple view', 'err.macReasonHost');
  refused('fileCloseStudio', 'Close Studio', 'err.macReasonHost');
  refused('fileOpenLibrary', 'Open from Library...', 'err.macReasonLibrary');
  add('fileNewImage', 'Image...', 'A', [dlg('Image...#0', 'New Image...', { name: 'name', type: 'type', fill: 'fill', width: 'width', height: 'height' },
    { items: { type: { '8-bit': 8, '16-bit': 16, '32-bit': 32 }, fill: { White: 'white', Black: 'black', Ramp: 'ramp', Noise: 'noise' } } })],
  { notes: 'slices= is not read: the Studio command makes a single plane (newImage() and File > New > Hyperstack make stacks); RGB is not offered.' });
  add('fileNewInternalClipboard', 'Internal Clipboard', 'A');
  add('fileNewSystemClipboard', 'System Clipboard', 'A');
  add('fileCloseAll', 'Close All', 'A');
  later('fileImportTextImage', 'Text Image... ');
  later('fileSaveTextImage', 'Text Image...');
  later('fileSaveSelection', 'Selection...');
  later('fileSaveXY', 'XY Coordinates...');
  later('fileImportLut', 'LUT... ');
  later('fileSaveLut', 'LUT...');

  // ── Edit
  refused('editUndo', 'Undo', 'err.macReasonUndo');
  refused('editRedo', 'Redo', 'err.macReasonUndo');
  add('editClear', 'Clear', 'A');
  add('editClearOutside', 'Clear Outside', 'A');
  add('editFill', 'Fill', 'A');
  add('editInvert', 'Invert', 'A');
  add('editSelectAll', 'Select All', 'A');
  add('editSelectNone', 'Select None', 'A');
  add('editRestoreSelection', 'Restore Selection', 'A');
  add('editMakeInverse', 'Make Inverse', 'A');
  add('editAddToManager', 'Add to Manager', 'A');
  add('editCut', 'Cut', 'A');
  add('editCopy', 'Copy', 'A');
  add('editCopyToSystem', 'Copy to System', 'A');
  add('editPaste', 'Paste', 'A');
  add('editPasteControl', 'Paste Control...', 'A');
  add('editDraw', 'Draw', 'A');
  add('selSpecify', 'Specify...', 'A', [dlg('Specify...#0', 'Specify',
    { width: 'width', height: 'height', x: 'x', y: 'y', oval: 'oval', square: 'constrain', centered: 'centered' })]);
  add('selToBoundingBox', 'To Bounding Box', 'A');
  add('selEnlarge', 'Enlarge...', 'A', [dlg('Enlarge...#0', 'Enlarge Selection', { n: 'enlarge' })]);
  add('selFitEllipse', 'Fit Ellipse', 'A');
  add('selConvexHull', 'Convex Hull', 'A');
  add('selCreateMask', 'Create Mask', 'A');
  add('selCreateSelection', 'Create Selection', 'A');
  add('selFitSpline', 'Fit Spline', 'A');
  add('selFitCircle', 'Fit Circle', 'A');
  add('selFitRectangle', 'Fit Rectangle', 'A');
  add('selInterpolate', 'Interpolate', 'A', [dlg(null, 'Interpolate', { interval: 'interval', smooth: 'smooth', adjust: 'adjust' })]);
  add('selProperties', 'Properties... ', 'A', [dlg('Properties... #0', 'Properties ', { name: 'name', width: 'width' }, { smart: true })]);
  add('selScale', 'Scale... ', 'A', [dlg('Scale... #0', 'Scale Selection', { xscale: 'x', yscale: 'y', centered: 'centered' })]);
  add('selRotate', 'Rotate...', 'A', [dlg('Rotate...#0', 'Rotate Selection', { angle: 'angle', aroundCenter: 'rotate' })]);
  add('selTranslate', 'Translate... ', 'A', [dlg('Translate... #0', 'Translate', { dx: 'x', dy: 'y' })]);
  add('selMakeBand', 'Make Band...', 'A', [dlg('Make Band...#0', 'Make Band', { size: 'band' })]);
  add('selStraighten', 'Straighten...', 'A', [dlg('Straighten...#0', 'Straightener', { title: 'title', width: 'line' })]);
  add('selLineToArea', 'Line to Area', 'A');
  add('selAreaToLine', 'Area to Line', 'A');
  add('optAppearance', 'Appearance...', 'A', [dlg('Appearance...#0', 'Appearance', { interpolate: 'interpolate' })]);
  add('optColors', 'Colors...', 'A', [dlg('Colors...#0', 'Colors', { foreground: 'foreground', background: 'background', selection: 'selection' },
    { items: { foreground: COLORS13, background: COLORS13, selection: COLORS13 } })]);
  add('optConversions', 'Conversions...', 'A', [dlg('Conversions...#0', 'Conversion Options', { scale: 'scale', weighted: 'weighted', fullRange16: 'full' })]);
  add('optMisc', 'Misc...', 'A', [dlg('Misc...#0', 'Miscellaneous Options', { divZero: 'divide' })]);
  add('optInputOutput', 'Input/Output...', 'A', [dlg('Input/Output...#0', 'I/O Options',
    { ext: 'file', copyHeaders: 'copy_column', copyRowNumbers: 'copy_row', saveHeaders: 'save_column', saveRowNumbers: 'save_row' })]);
  add('optPlots', 'Plots...', 'A', [dlg('Plots...#0', 'Plot Defaults', { fixedScale: 'fixed', ymin: 'minimum', ymax: 'maximum', vertical: 'vertical', interpolate: 'interpolate' })]);

  // ── Image
  add('typeBit8', '8-bit', 'A');
  add('typeBit16', '16-bit', 'A');
  add('typeBit32', '32-bit', 'A');
  add('typeColor8', '8-bit Color', 'A', [dlg('8-bit Color#0', 'MedianCut', { number: 'number' })]);
  add('typeRgb', 'RGB Color', 'A', [RGB_KEEP(null)]);
  add('typeRgbStack', 'RGB Stack', 'A');
  add('typeHsbStack', 'HSB Stack', 'A');
  add('typeHsb32', 'HSB (32-bit)', 'A');
  add('typeLabStack', 'Lab Stack', 'A');
  add('adjustBC', 'Brightness/Contrast...', 'A');
  add('adjustThreshold', 'Threshold...', 'A');
  add('adjustSize', 'Size...', 'A', [dlg('Size...#0', 'Resize',
    { width: 'width', height: 'height', depth: 'depth', time: 'time', constrain: 'constrain', average: 'average', interpolation: 'interpolation' }, { items: { interpolation: INTERP } })]);
  add('adjustCanvasSize', 'Canvas Size...', 'A', [dlg('Canvas Size...#0', 'Resize Image Canvas', { width: 'width', height: 'height', position: 'position' },
    { items: { position: { 'Top-Left': 'topLeft', 'Top-Center': 'topCenter', 'Top-Right': 'topRight', 'Center-Left': 'centerLeft', Center: 'center',
      'Center-Right': 'centerRight', 'Bottom-Left': 'bottomLeft', 'Bottom-Center': 'bottomCenter', 'Bottom-Right': 'bottomRight' } } })],
  { notes: 'zero (Zero Fill) is not read: the Studio always fills the new area with zeros.' });
  add('adjustAutoThreshold', 'Auto Threshold', 'B', [dlg('Auto Threshold#0', 'Auto Threshold',
    { method: 'method', ignoreBlack: 'ignore_black', ignoreWhite: 'ignore_white', white: 'white', setThreshold: 'setthreshold', showValues: 'show' },
    { items: { method: same(['Try all', 'Default', 'Huang', 'Huang2', 'Intermodes', 'IsoData', 'Li', 'MaxEntropy', 'Mean', 'MinError(I)', 'Minimum', 'Moments', 'Otsu',
      'Percentile', 'RenyiEntropy', 'Shanbhag', 'Triangle', 'Yen']) } })]);
  add('adjustAutoLocalThreshold', 'Auto Local Threshold', 'B', [dlg('Auto Local Threshold#0', 'Auto Local Threshold',
    { method: 'method', radius: 'radius', parameter1: 'parameter_1', parameter2: 'parameter_2', white: 'white' },
    { items: { method: same(['Try all', 'Bernsen', 'Contrast', 'Mean', 'Median', 'MidGrey', 'Niblack', 'Otsu', 'Phansalkar', 'Sauvola']) } })]);
  add('imageInfo', 'Show Info...', 'A');
  add('imageCrop', 'Crop', 'A');
  add('imageDuplicate', 'Duplicate...', 'A', [dlg('Duplicate...#0', 'Duplicate...',
    { title: 'title', ignore: 'ignore', stack: 'duplicate', range: 'range', channels: 'channels', slices: 'slices', frames: 'frames' }, { smart: true })]);
  add('imageRename', 'Rename...', 'A', [dlg('Rename...#0', 'Rename', { name: 'title' })]);
  add('imageProperties', 'Properties...', 'A', [dlg('Properties...#0', null,
    { channels: 'channels', slices: 'slices', frames: 'frames', pixelWidth: 'pixel_width', pixelHeight: 'pixel_height', unit: 'unit', pixelDepth: 'voxel_depth',
      frameInterval: 'frame' },
    { rewrite: (o) => o.replace(/ depth=/g, ' slices=').replace(/ interval=/g, ' frame=') })],
  { notes: 'unit= is ImageProperties\' legacy macro key (options holding "unit=" switch the dialog to a "Unit of length:" field). The per-axis unit '
    + 'fields ("_"), origin, invert and global are not read.' });
  add('imageScale', 'Scale...', 'A', [dlg('Scale...#0', 'Scale',
    { xscale: 'x', yscale: 'y', zscale: 'z', width: 'width', height: 'height', depth: 'depth', interpolation: 'interpolation', average: 'average', process: 'process',
      newWindow: 'create', title: 'title' }, { items: { interpolation: INTERP }, rewrite: scalerOptions })]);
  add('colorChannels', 'Channels Tool...', 'A');
  add('colorSplitChannels', 'Split Channels', 'A');
  add('colorMergeChannels', 'Merge Channels...', 'A', [dlg('Merge Channels...#0', 'Merge Channels',
    { c1: 'c1', c2: 'c2', c3: 'c3', c4: 'c4', c5: 'c5', c6: 'c6', c7: 'c7', createComposite: 'create', keep: 'keep', ignoreLuts: 'ignore' },
    { titles: ['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7'], items: { c1: { '*None*': 'none' }, c2: { '*None*': 'none' }, c3: { '*None*': 'none' }, c4: { '*None*': 'none' },
      c5: { '*None*': 'none' }, c6: { '*None*': 'none' }, c7: { '*None*': 'none' } } })],
  { notes: 'keep: the field exists only when a macro runs the command; without it the source images are closed, as RGBStackMerge does.' });
  add('colorArrangeChannels', 'Arrange Channels...', 'A', [dlg('Arrange Channels...#0', 'Arrange Channels', { order: 'new' })]);
  add('colorInvertLuts', 'Invert LUTs', 'A');
  add('colorShowLut', 'Show LUT', 'A');
  add('colorStackToRgb', 'Stack to RGB', 'A', [RGB_KEEP('Stack to RGB#0')]);
  add('colorMakeComposite', 'Make Composite', 'A', [dlg('Make Composite#0', 'Make Composite', { display: 'display' }, { items: { display: DISPLAY } })]);
  add('stackProject', 'Z Project...', 'A', [
    dlg('Z Project...#0', 'ZProjection', { start: 'start', stop: 'stop', projection: 'projection', all: 'all' }, { items: { projection: PROJ } }),
    dlg(null, 'ZProjection', { start: 'start', stop: 'stop', method: 'projection', level: null }, { refuse: 'err.macReasonLibrary' })
  ], { notes: 'On a single image the Studio command projects the figure\'s slab from the site\'s dataset: refused to macros (second dialog).' });
  add('transformFlipH', 'Flip Horizontally', 'A');
  add('transformFlipV', 'Flip Vertically', 'A');
  add('transformRotateRight', 'Rotate 90 Degrees Right', 'A');
  add('transformRotateLeft', 'Rotate 90 Degrees Left', 'A');
  add('transformRotate', 'Rotate... ', 'A', [dlg('Rotate... #0', 'Rotate', { angle: 'angle', grid: 'grid', interpolation: 'interpolation', enlarge: 'enlarge' },
    { items: { interpolation: INTERP } })]);
  add('transformTranslate', 'Translate...', 'A', [dlg('Translate...#0', 'Translate', { dx: 'x', dy: 'y', interpolation: 'interpolation' }, { items: { interpolation: INTERP } })]);
  add('transformBin', 'Bin...', 'A', [dlg('Bin...#0', 'Image Shrink', { xshrink: 'x', yshrink: 'y', zshrink: 'z', method: 'bin' },
    { items: { method: lowerOf(['Average', 'Median', 'Min', 'Max', 'Sum']) } })]);
  add('zoomIn', 'In [+]', 'C');
  add('zoomOut', 'Out [-]', 'C');
  add('zoomOriginal', 'View 100%', 'A');
  add('zoomToSelection', 'To Selection', 'A');
  add('zoomFit', 'Scale to Fit', 'C');
  add('lutApply', 'Apply LUT', 'A');
  for (const [id, n] of [['lutGrays', 'Grays'], ['lutRed', 'Red'], ['lutGreen', 'Green'], ['lutBlue', 'Blue'], ['lutCyan', 'Cyan'], ['lutMagenta', 'Magenta'],
    ['lutYellow', 'Yellow'], ['lutFire', 'Fire'], ['lutIce', 'Ice'], ['lutSpectrum', 'Spectrum'], ['lut332RGB', '3-3-2 RGB'], ['lutRedGreen', 'Red/Green']]) add(id, n, 'A');
  add('lut16Colors', '16 colors', 'C', [], { notes: 'Fiji LUT luts/16_colors.lut' });
  add('lutHiLo', 'HiLo', 'C', [], { notes: 'Fiji LUT luts/HiLo.lut' });
  add('lutInvert', 'Invert LUT', 'A');

  // ── Image › Stacks, Hyperstacks
  add('stackAddSlice', 'Add Slice', 'A', [dlg(null, 'Add', { add: 'add', prepend: 'prepend' }, { items: { add: CZT } })]);
  add('stackDeleteSlice', 'Delete Slice', 'A', [dlg('Delete Slice#0', 'Delete', { delete: 'delete' }, { items: { delete: CZT } })]);
  add('stackNextSlice', 'Next Slice [>]', 'A');
  add('stackPreviousSlice', 'Previous Slice [<]', 'A');
  add('stackSetSlice', 'Set Slice...', 'A', [dlg('Set Slice...#0', 'Set Slice', { channel: 'channel', slice: 'slice', frame: 'frame' })]);
  add('stackImagesToStack', 'Images to Stack', 'A', [dlg(null, 'Images to Stack',
    { method: 'method', bicubic: 'bicubic', fill: 'fill', name: 'name', title: 'title', use: 'use', keep: 'keep' },
    { items: { method: { 'Copy (center)': 'center', 'Copy (top-left)': 'topleft', 'Scale (smallest)': 'smallest', 'Scale (largest)': 'largest' }, fill: { Black: 'black', White: 'white' } } })]);
  add('stackToImages', 'Stack to Images', 'A');
  add('stackReslice', 'Reslice [/]...', 'A', [dlg('Reslice [/]...#0', 'Reslice', { output: 'output', start: 'start', flip: 'flip', rotate: 'rotate', avoid: 'avoid' },
    { items: { start: lowerOf(['Top', 'Left', 'Bottom', 'Right']) } })]);
  add('stackZProfile', 'Plot Z-axis Profile', 'A', [dlg('Plot Z-axis Profile#0', 'Profiler', { profile: 'profile' }, { items: { profile: { time: 'time', 'z-axis': 'z' } } })]);
  add('stackMeasure', 'Measure Stack...', 'A', [dlg(null, 'Measure Hyperstack', { channels: 'channels', slices: 'slices', frames: 'frames', order: 'order' },
    { items: { order: { 'czt (default)': 'czt', ctz: 'ctz', zct: 'zct', ztc: 'ztc', tcz: 'tcz', tzc: 'tzc' } } })]);
  add('stackLabel', 'Label...', 'A', [dlg('Label...#0', 'Label Stacks',
    { format: 'format', starting: 'starting', interval: 'interval', x: 'x', y: 'y', font: 'font', text: 'text', range: 'range' },
    { items: { format: { 0: '0', '0000': '0000', '00:00': '00:00', '00:00:00': '00:00:00', Text: 'text', Label: 'label' } } })]);
  add('stackStatistics', 'Statistics', 'A');
  add('stackStartAnimation', 'Start Animation [\\]', 'A');
  add('stackStopAnimation', 'Stop Animation', 'A');
  add('stackAnimationOptions', 'Animation Options...', 'A', [dlg('Animation Options...#0', 'Animation Options',
    { speed: 'speed', first: 'first', last: 'last', loop: 'loop', start: 'start' })]);
  add('stackCombine', 'Combine...', 'A', [dlg('Combine...#0', 'Combiner', { stack1: 'stack1', stack2: 'stack2', combine: 'combine' })]);
  add('stackConcatenate', 'Concatenate...', 'A', [dlg('Concatenate...#0', 'Concatenator',
    { all: 'all_open', image1: 'image1', image2: 'image2', image3: 'image3', image4: 'image4', image5: 'image5', image6: 'image6', image7: 'image7', image8: 'image8',
      title: 'title', keep: 'keep', open: 'open' },
    { titles: ['image1', 'image2', 'image3', 'image4', 'image5', 'image6', 'image7', 'image8'],
      items: { image1: { '-- None --': 'none' }, image2: { '-- None --': 'none' }, image3: { '-- None --': 'none' }, image4: { '-- None --': 'none' },
        image5: { '-- None --': 'none' }, image6: { '-- None --': 'none' }, image7: { '-- None --': 'none' }, image8: { '-- None --': 'none' } } })]);
  add('stackGroupedZ', 'Grouped Z Project...', 'A', [dlg('Grouped Z Project...#0', 'Z Project', { projection: 'projection', group: 'group' }, { items: { projection: PROJ } })]);
  add('stackInsert', 'Insert...', 'A', [dlg('Insert...#0', 'Stack Inserter', { source: 'source', destination: 'destination', x: 'x', y: 'y' })]);
  add('stackSubstack', 'Make Substack...', 'A', [dlg('Make Substack...#0', null,
    { channels: 'channels', slices: 'slices', frames: 'frames', delete: 'delete', do: 'do_not' })]);
  add('stackMontageToStack', 'Montage to Stack...', 'A', [dlg('Montage to Stack...#0', 'Stack Maker', { columns: 'columns', rows: 'rows', border: 'border' })]);
  add('stackReduce', 'Reduce...', 'A', [dlg('Reduce...#0', 'Reduce Size', { reduction: 'reduction', reduce: 'reduce' })]);
  add('stackRemoveLabels', 'Remove Slice Labels', 'A', [], { noopWhenDisabled: true, notes: 'A single image has no slice label to remove (no error in ImageJ).' });
  add('stackReverse', 'Reverse', 'A');
  add('stackSetLabel', 'Set Label...', 'A', [dlg('Set Label...#0', null, { label: 'label' })]);
  add('stackMontage', 'Make Montage...', 'A', [dlg('Make Montage...#0', 'Make Montage',
    { columns: 'columns', rows: 'rows', scale: 'scale', first: 'first', last: 'last', increment: 'increment', border: 'border', fontSize: 'font', label: 'label', useForeground: 'use' })]);
  add('hyperNew', 'New Hyperstack...', 'A', [dlg('New Hyperstack...#0', 'New Hyperstack...',
    { name: 'name', type: 'type', display: 'display', width: 'width', height: 'height', channels: 'channels', slices: 'slices', frames: 'frames', label: 'label' },
    { items: { type: { '8-bit': '8', '16-bit': '16', '32-bit': '32', RGB: 'rgb' }, display: DISPLAY } })]);
  add('hyperToHyper', 'Stack to Hyperstack...', 'A', [dlg('Stack to Hyperstack...#0', 'Convert to HyperStack',
    { order: 'order', channels: 'channels', slices: 'slices', frames: 'frames', display: 'display' },
    { items: { order: { 'xyczt(default)': 'xyczt', xyctz: 'xyctz', xyzct: 'xyzct', xyztc: 'xyztc', xytcz: 'xytcz', xytzc: 'xytzc' }, display: DISPLAY } })]);
  add('hyperToStack', 'Hyperstack to Stack', 'A', [], { noopWhenDisabled: true, notes: 'HyperStackConverter.convertHSToStack leaves an image that is no hyperstack as it is.' });
  add('hyperReduceDim', 'Reduce Dimensionality...', 'A', [dlg('Reduce Dimensionality...#0', 'Reduce', { channels: 'channels', slices: 'slices', frames: 'frames', keep: 'keep' })]);
  add('hyperSubset', 'Make Subset...', 'A', [dlg('Make Subset...#0', null, { channels: 'channels', slices: 'slices', frames: 'frames' })]);
  add('hyperReorder', 'Re-order Hyperstack ...', 'B', [dlg('Re-order Hyperstack ...#0', null, { c: 'channels', z: 'slices', t: 'frames' },
    { items: { c: { 'Channels (c)': 'c', 'Slices (z)': 'z', 'Frames (t)': 't' }, z: { 'Channels (c)': 'c', 'Slices (z)': 'z', 'Frames (t)': 't' },
      t: { 'Channels (c)': 'c', 'Slices (z)': 'z', 'Frames (t)': 't' } } })]);

  // ── Process
  add('procSmooth', 'Smooth', 'A');
  add('procSharpen', 'Sharpen', 'A');
  add('procFindEdges', 'Find Edges', 'A');
  add('procFindMaxima', 'Find Maxima...', 'A', [dlg('Find Maxima...#0', 'Find Maxima...',
    { prominence: 'prominence', strict: 'strict', excludeEdges: 'exclude', light: 'light', output: 'output' },
    { items: { output: { 'Single Points': 'single', 'Maxima Within Tolerance': 'tolerance', 'Segmented Particles': 'segmented', 'Point Selection': 'points', List: 'list', Count: 'count' } } })]);
  add('procEnhanceContrast', 'Enhance Contrast...', 'A', [dlg('Enhance Contrast...#0', 'Enhance Contrast',
    { saturated: 'saturated', normalize: 'normalize', entire: 'update', equalize: 'equalize', classic: null, processAll: 'process_all', useStack: 'use' },
    { rewrite: (o) => o.split('normalize_all').join('process_all') })],
  { notes: 'classic: ImageJ takes the classic equalization from the Alt key, run("…") passes it as alt.' });
  add('procSubtractBackground', 'Subtract Background...', 'A', [dlg('Subtract Background...#0', 'Subtract Background...',
    { radius: 'rolling', light: 'light', create: 'create', sliding: 'sliding', noSmooth: 'disable', all: ALL }, { setup: true })]);
  add('procImageCalculator', 'Image Calculator...', 'A', [dlg('Image Calculator...#0', 'Image Calculator',
    { image1: 'image1', op: 'operation', image2: 'image2', allChannels: ALL, channel1: null, channel2: null, create: 'create', float32: '32-bit' },
    { items: { op: { Add: 'add', Subtract: 'subtract', Multiply: 'multiply', Divide: 'divide', AND: 'and', OR: 'or', XOR: 'xor', Min: 'min', Max: 'max', Average: 'average',
      Difference: 'difference', Copy: 'copy', 'Transparent-zero': 'transparent-zero' } } })],
  { notes: 'create: the field exists only when a macro runs the command; without it the macro runtime copies the result back into image 1 (RunReply.inPlace).' });
  add('procCLAHE', 'Enhance Local Contrast (CLAHE)', 'B', [dlg('Enhance Local Contrast (CLAHE)#0', 'CLAHE',
    { blocksize: 'blocksize', bins: 'histogram', slope: 'maximum', mask: 'mask', fast: 'fast_(less_accurate)', composite: 'process_as_composite' },
    { titles: ['mask'], items: { mask: { '*None*': 'none' } } })],
  { notes: 'process_as_composite: the composite checkbox was not captured (the capture image had one channel); key from Fiji\'s recorded macros.' });
  add('procRepeatCommand', 'Repeat Command', 'C', [], { notes: 'Repeats the operator\'s last command; its dialogs are interactive (Repeat passes no options).' });
  add('noiseDespeckle', 'Despeckle', 'A');
  add('noiseRemoveOutliers', 'Remove Outliers...', 'A', [dlg('Remove Outliers...#0', 'Remove Outliers...', { radius: 'radius', threshold: 'threshold', which: 'which', all: ALL },
    { setup: true, items: { which: { Bright: 'outliersBright', Dark: 'outliersDark' } } })]);
  add('noiseRemoveNaNs', 'Remove NaNs...', 'A', [dlg('Remove NaNs...#0', 'Remove NaNs...', { radius: 'radius' })]);
  add('noiseAdd', 'Add Noise', 'A', [dlg(null, 'Add Noise', { all: ALL }, { setup: true })]);
  add('noiseAddSpecified', 'Add Specified Noise...', 'A', [dlg('Add Specified Noise...#0', 'Gaussian Noise', { sd: 'standard', all: ALL }, { setup: true })]);
  add('noiseSaltPepper', 'Salt and Pepper', 'A', [dlg(null, 'Salt and Pepper', { all: ALL }, { setup: true })]);
  add('binMask', 'Convert to Mask', 'A', [STACK_TO_BINARY('Convert to Mask#0')]);
  add('binMakeBinary', 'Make Binary', 'A', [STACK_TO_BINARY('Make Binary#0')]);
  add('binFillHoles', 'Fill Holes', 'A');
  add('binErode', 'Erode', 'A');
  add('binDilate', 'Dilate', 'A');
  add('binOpen', 'Open', 'A');
  add('binClose', 'Close-', 'A');
  add('binMedian', 'Median', 'A', [dlg('Median#0', '', { radius: 'radius' })]);
  add('binOptions', 'Options...', 'A', [dlg('Options...#0', 'Binary Options',
    { iterations: 'iterations', count: 'count', blackBackground: 'black', padEdges: 'pad', edmOutput: 'edm', operation: 'do' },
    { items: { edmOutput: { Overwrite: 'overwrite', '8-bit': 'byte', '16-bit': 'short', '32-bit': 'float' },
      operation: { Nothing: 'nothing', Erode: 'erode', Dilate: 'dilate', Open: 'open', Close: 'close', Outline: 'outline', 'Fill Holes': 'fillHoles', Skeletonize: 'skeletonize' } } })]);
  add('binOutline', 'Outline', 'A');
  add('binSkeletonize', 'Skeletonize', 'A');
  add('binDistanceMap', 'Distance Map', 'A');
  add('binUltimatePoints', 'Ultimate Points', 'A');
  add('binWatershed', 'Watershed', 'A');
  add('binVoronoi', 'Voronoi', 'A');
  add('mathAdd', 'Add...', 'A', [MATH('Add...#0', 'Add')]);
  add('mathSubtract', 'Subtract...', 'A', [MATH('Subtract...#0', 'Subtract')]);
  add('mathMultiply', 'Multiply...', 'A', [MATH('Multiply...#0', 'Multiply')]);
  add('mathDivide', 'Divide...', 'A', [MATH('Divide...#0', 'Divide')]);
  add('mathAnd', 'AND...', 'A', [BITS('AND...#0', 'AND')]);
  add('mathOr', 'OR...', 'A', [BITS('OR...#0', 'OR')]);
  add('mathXor', 'XOR...', 'A', [BITS('XOR...#0', 'XOR')]);
  add('mathMin', 'Min...', 'A', [MATH('Min...#0', 'Min')]);
  add('mathMax', 'Max...', 'A', [MATH('Max...#0', 'Max')]);
  add('mathGamma', 'Gamma...', 'A', [MATH('Gamma...#0', 'Gamma')]);
  add('mathSet', 'Set...', 'A', [MATH('Set...#0', 'Set')]);
  add('mathLog', 'Log', 'A');
  add('mathExp', 'Exp', 'A');
  add('mathSquare', 'Square', 'A');
  add('mathSqrt', 'Square Root', 'A');
  add('mathReciprocal', 'Reciprocal', 'A');
  add('mathNaNBackground', 'NaN Background', 'A', [dlg(null, 'NaN Background', {})]);
  add('mathAbs', 'Abs', 'A');
  add('fftForward', 'FFT', 'A');
  add('fftInverse', 'Inverse FFT', 'A');
  add('fftOptions', 'FFT Options...', 'A', [dlg('FFT Options...#0', 'FFT Options', { fftWindow: 'fft', rawPs: 'raw' })]);
  add('fftBandpass', 'Bandpass Filter...', 'A', [dlg('Bandpass Filter...#0', 'FFT Bandpass Filter',
    { large: 'filter_large', small: 'filter_small', stripes: 'suppress', tolerance: 'tolerance', autoscale: 'autoscale', saturate: 'saturate', displayFilter: 'display', all: 'process' },
    { items: { stripes: lowerOf(['None', 'Horizontal', 'Vertical']) } })],
  { notes: 'all = FFTFilter\'s "Process entire stack" (key process).' });
  add('fftSwapQuadrants', 'Swap Quadrants', 'A');
  add('filterConvolve', 'Convolve...', 'A', [dlg('Convolve...#0', 'Convolver...', { kernel: 'text1', normalize: 'normalize', all: ALL }, { setup: true })]);
  add('filterGaussian', 'Gaussian Blur...', 'A', [dlg('Gaussian Blur...#0', 'Gaussian Blur...', { sigma: 'sigma', scaled: 'scaled', all: ALL }, { setup: true })]);
  add('filterMedian', 'Median...', 'A', [RADIUS('Median...#0', 'Median...')]);
  add('filterMean', 'Mean...', 'A', [RADIUS('Mean...#0', 'Mean...')]);
  add('filterMinimum', 'Minimum...', 'A', [RADIUS('Minimum...#0', 'Minimum...')]);
  add('filterMaximum', 'Maximum...', 'A', [RADIUS('Maximum...#0', 'Maximum...')]);
  add('filterUnsharp', 'Unsharp Mask...', 'A', [dlg('Unsharp Mask...#0', 'Unsharp Mask...', { sigma: 'radius', weight: 'mask', all: ALL }, { setup: true })]);
  add('filterVariance', 'Variance...', 'A', [RADIUS('Variance...#0', 'Variance...')]);
  add('filterTopHat', 'Top Hat...', 'A', [dlg('Top Hat...#0', 'Top Hat...', { radius: 'radius', light: 'light', dontSubtract: "don't", all: ALL }, { setup: true })]);
  add('pluginsFrangi', 'Frangi Vesselness', 'B', [dlg('Frangi Vesselness#0', 'Frangi Vesselness', { doGauss: 'doGauss', spacing: 'spacingString', scales: 'scaleString' })],
    { notes: 'SciJava command: the keys are its @Parameter names.' });

  // ── Analyze
  add('analyzeMeasure', 'Measure', 'A');
  add('analyzeParticles', 'Analyze Particles...', 'A', [dlg('Analyze Particles...#0', 'Analyze Particles',
    { size: 'size', circularity: 'circularity', show: 'show', display: 'display', exclude: 'exclude', clear: 'clear', holes: 'include', summarize: 'summarize',
      overlay: 'overlay', manager: 'add', composite: 'composite', record: 'record' },
    { items: { show: { Nothing: 'nothing', Overlay: 'overlay', 'Overlay Masks': 'overlayMasks', Outlines: 'outlines', 'Bare Outlines': 'bareOutlines', Ellipses: 'ellipses',
      Masks: 'masks', 'Count Masks': 'countMasks' } } })]);
  add('analyzeSummarize', 'Summarize', 'A');
  add('analyzeDistribution', 'Distribution...', 'A', [dlg('Distribution...#0', 'Distribution', { parameter: 'parameter', auto: 'automatic', bins: 'or', range: 'and' },
    { items: { parameter: same(['Area', 'Mean', 'Min', 'Max']) } })]);
  add('analyzeClearResults', 'Clear Results', 'A');
  add('analyzeSetMeasurements', 'Set Measurements...', 'A', [dlg('Set Measurements...#0', 'Set Measurements',
    { area: 'area', mean: 'mean', stdDev: 'standard', mode: 'modal', minMax: 'min', centroid: 'centroid', center: 'center', perimeter: 'perimeter', rect: 'bounding',
      ellipse: 'fit', shape: 'shape', feret: "feret's", intDen: 'integrated', median: 'median', skewness: 'skewness', kurtosis: 'kurtosis', areaFraction: 'area_fraction',
      stackPos: 'stack', limit: 'limit', labels: 'display', invertY: 'invert', scientific: 'scientific', addToOverlay: 'add', nanEmpty: 'nan',
      redirectOn: null, redirectDoc: 'redirect', redirectChannel: null, decimals: 'decimal' },
    { titles: ['redirectDoc'], items: { redirectDoc: { None: null } },
      // ImageJ's one "Redirect to:" choice is the Studio's switch + image: redirect=None turns redirection off, an image title turns it on
      derive: { redirectOn: (options) => { const v = getValue(options, 'redirect', null); return v === null ? undefined : v !== 'None'; } } })]);
  add('analyzeHistogram', 'Histogram', 'A', [dlg(null, 'Histogram', { bins: 'bins', useRange: 'use', xMin: 'x_min', xMax: 'x_max', yMax: 'y_max' })]);
  add('analyzePlotProfile', 'Plot Profile', 'A');
  add('analyzeSetScale', 'Set Scale...', 'A', [dlg('Set Scale...#0', 'Set Scale', { measured: 'distance', known: 'known', aspect: 'pixel', unit: 'unit', remove: null, scale: null })],
    { notes: 'remove: ImageJ removes the scale with distance=0 or known=0 (its "Click to Remove Scale" button has no key).' });
  add('analyzeColocalization', 'Colocalization...', 'D', [dlg(null, null,
    { doc1: 'image', ch1: 'channel', doc2: 'image_0', ch2: 'channel_0', mode: 'thresholds', t1: 'threshold,', t2: 'threshold,_0', excludeZero: 'exclude', denominator: 'tm1' },
    { items: { mode: { 'None (above zero)': 'none', Manual: 'manual', 'Costes automatic': 'costes' },
      denominator: { 'Sum over all selection pixels (Manders 1993, Costes 2004)': 'all', "Sum over pixels above the channel's own threshold (Coloc 2)": 'above' } } })],
  { notes: 'Studio only: the keys are Macro.trimKey of its English labels.' });
  add('analyzeDirectionality', 'Directionality', 'B', [dlg('Directionality#0', 'Directionality analysis v2.3.0',
    { method: 'method', nbins: 'nbins', start: 'histogram_start', end: 'histogram_end', orientationMap: 'build', colorWheel: 'display_color_wheel', table: 'display_table', all: ALL },
    { items: { method: { 'Fourier components': 'fourier', 'Local gradient orientation': 'gradient' } } })]);
  add('toolsRoiManager', 'ROI Manager...', 'A');
  add('toolsSyncWindows', 'Synchronize Windows', 'A');
  later('toolsSaveXY', 'Save XY Coordinates...');
  add('toolsScaleBar', 'Scale Bar...', 'A', [dlg('Scale Bar...#0', 'Scale Bar',
    { width: 'width', height: 'height', thickness: 'thickness', fontSize: 'font', color: 'color', background: 'background', location: 'location', horizontal: 'horizontal',
      vertical: 'vertical', bold: 'bold', hideText: 'hide', serif: 'serif', overlay: 'overlay' },
    { items: { color: same(['White', 'Black', 'Light Gray', 'Gray', 'Dark Gray', 'Red', 'Green', 'Blue', 'Yellow']),
      background: same(['None', 'Black', 'White', 'Dark Gray', 'Gray', 'Light Gray', 'Yellow', 'Blue', 'Green', 'Red']),
      location: same(['Upper Right', 'Lower Right', 'Lower Left', 'Upper Left', 'At Selection']) } })]);
  add('toolsGrid', 'Grid...', 'A', [dlg('Grid...#0', 'Grid...', { type: 'grid', area: 'area', color: 'color', bold: 'bold', centered: 'center', randomOffset: 'random' },
    { items: { type: same(['Lines', 'Horizontal Lines', 'Crosses', 'Points', 'Circles', 'None']), color: same(['Red', 'Green', 'Blue', 'Magenta', 'Cyan', 'Yellow', 'Orange', 'Black', 'White']) } })]);
  add('toolsFractalBoxCount', 'Fractal Box Count...', 'A', [dlg('Fractal Box Count...#0', 'Fractal Box Counter', { sizes: 'box', blackBackground: 'black' })]);
  add('toolsCurveFitting', 'Curve Fitting...', 'A');
  add('skelAnalyze', 'Analyze Skeleton (2D/3D)', 'B', [dlg('Analyze Skeleton (2D/3D)#0', 'Analyze Skeleton',
    { prune: 'prune', pruneEnds: 'prune_0', excludeRoi: 'exclude', shortestPath: 'calculate', detailed: 'show', labeled: 'display' },
    { items: { prune: { none: 'none', 'shortest branch': 'shortest', 'lowest intensity voxel': 'lowestVoxel', 'lowest intensity branch': 'lowestBranch' } } })]);
  add('ltComplete', 'Local Thickness (complete process)', 'B', [dlg('Local Thickness (complete process)#0', 'EDT...', { threshold: 'threshold', inverse: 'inverse' })]);
  add('colocColoc2', 'Coloc 2', 'B', [dlg('Coloc 2#0', 'Coloc 2',
    { doc1: 'channel_1', ch1: null, doc2: 'channel_2', ch2: null, roi: 'roi_or_mask', regression: 'threshold_regression', liHistCh1: 'li_histogram_channel_1',
      liHistCh2: 'li_histogram_channel_2', liIcq: 'li_icq', spearman: "spearman's_rank_correlation", manders: "manders'_correlation", kendall: "kendall's_tau_rank_correlation",
      hist2d: '2d_intensity_histogram', costesTest: "costes'_significance_test", psf: 'psf', randomisations: 'costes_randomisations' },
    { titles: ['roi'], items: { roi: { '<None>': 'none', 'ROI(s) in channel 1': 'roi1', 'ROI(s) in channel 2': 'roi2', 'ROI Manager': 'manager' },
      regression: { Costes: 'costes', Bisection: 'bisection' } } })],
  { notes: 'Coloc 2 picks an image per channel_1 / channel_2: the Studio channel of each image keeps its default.' });
  add('pluginsTubeness', 'Tubeness', 'B', [dlg('Tubeness#0', '"Tubeness" Filter (version 1.2)', { sigma: 'sigma', useCalibration: 'use' })]);
  add('pluginsCellCounter', 'Cell Counter', 'B', [], { notes: 'Opens the Cell Counter window; its clicks are not macro-drivable.' });

  // ── Image › Overlay
  add('overlayAddSelection', 'Add Selection...', 'A');
  add('overlayHide', 'Hide Overlay', 'A');
  add('overlayShow', 'Show Overlay', 'A');
  add('overlayFromManager', 'From ROI Manager', 'A');
  add('overlayToManager', 'To ROI Manager', 'A');
  add('overlayRemove', 'Remove Overlay', 'A');
  add('overlayToggle', 'Toggle Overlay', 'A');

  // ── Plugins, Window, Help
  add('utilFindCommands', 'Find Commands...', 'A');
  later('macRun', 'Run...');
  add('macEdit', 'Edit...', 'D');
  add('windowLog', 'Log', 'D', [], { notes: 'Process > Math > Log owns the ImageJ name "Log": run("Log") is mathLog (A–C win over D).' });
  add('windowShowAll', 'Show All', 'A');
  add('windowPutBehind', 'Put Behind [tab]', 'A');
  add('windowCascade', 'Cascade', 'A');
  add('windowTile', 'Tile', 'A');
  add('windowResults', 'Results', 'D', [], { notes: 'ImageJ macros use selectWindow("Results").' });
  add('windowRoiManager', 'ROI Manager...', 'C', [], { alias: 'toolsRoiManager' });
  add('windowNext', 'Next Image', 'D');
  add('windowPrevious', 'Previous Image', 'D');
  add('helpAbout', 'About Advanced view...', 'D');
  add('helpShortcuts', 'Keyboard shortcuts...', 'D');

  // IJ.convert (ij/IJ.java 1.54p): renamed commands that old macros still use
  const IJ_CONVERT = {
    'New...': 'Image...', Threshold: 'Make Binary', 'Display...': 'Appearance...', 'Start Animation': 'Start Animation [\\]',
    'Convert Images to Stack': 'Images to Stack', 'Convert Stack to Images': 'Stack to Images', 'Convert Stack to RGB': 'Stack to RGB',
    'Convert to Composite': 'Make Composite', 'RGB Split': 'Split Channels', 'RGB Merge...': 'Merge Channels...', 'Channels...': 'Channels Tool...',
    'New... ': 'Table...', 'Arbitrarily...': 'Rotate... ', 'Measurements...': 'Results... ', 'List Commands...': 'Find Commands...',
    'Capture Screen ': 'Capture Screen', 'Add to Manager ': 'Add to Manager', In: 'In [+]', Out: 'Out [-]', 'Enhance Contrast': 'Enhance Contrast...',
    'XY Coodinates... ': 'XY Coordinates... ', 'Statistics...': 'Statistics', 'Channels Tool... ': 'Channels Tool...', 'Profile Plot Options...': 'Plots...',
    'AuPbSn 40 (56K)': 'AuPbSn 40', 'Bat Cochlea Volume (19K)': 'Bat Cochlea Volume', 'Bat Cochlea Renderings (449K)': 'Bat Cochlea Renderings',
    'Blobs (25K)': 'Blobs', 'Boats (356K)': 'Boats', 'Cardio (768K, RGB DICOM)': 'Cardio (RGB DICOM)', 'Cell Colony (31K)': 'Cell Colony', 'Clown (14K)': 'Clown',
    'Confocal Series (2.2MB)': 'Confocal Series', 'CT (420K, 16-bit DICOM)': 'CT (16-bit DICOM)', 'Dot Blot (7K)': 'Dot Blot', 'Embryos (42K)': 'Embryos',
    'Fluorescent Cells (400K)': 'Fluorescent Cells', 'Fly Brain (1MB)': 'Fly Brain', 'Gel (105K)': 'Gel', 'HeLa Cells (1.3M, 48-bit RGB)': 'HeLa Cells (48-bit RGB)',
    'Leaf (36K)': 'Leaf', 'Line Graph (21K)': 'Line Graph', 'Mitosis (26MB, 5D stack)': 'Mitosis (5D stack)', 'MRI Stack (528K)': 'MRI Stack',
    'M51 Galaxy (177K, 16-bits)': 'M51 Galaxy (16-bits)', 'Neuron (1.6M, 5 channels)': 'Neuron (5 channels)', 'Nile Bend (1.9M)': 'Nile Bend',
    'Organ of Corti (2.8M, 4D stack)': 'Organ of Corti (4D stack)', 'Particles (75K)': 'Particles', 'T1 Head (2.4M, 16-bits)': 'T1 Head (16-bits)',
    'T1 Head Renderings (736K)': 'T1 Head Renderings', 'TEM Filter (112K)': 'TEM Filter', 'Tree Rings (48K)': 'Tree Rings'
  };

  const REFUSED_NAMES = [
    { exact: 'Bio-Formats Importer', key: 'err.macBioFormats' },
    { exact: 'Bio-Formats Windowless Importer', key: 'err.macBioFormats' },
    { prefix: 'Bio-Formats', key: 'err.macBioFormats' },
    { exact: 'URL...', key: 'err.macNetwork' },
    { suffix: ' Macro Extensions', key: 'err.macExtensions' }
  ];

  // IJ.noImage() in a macro: Interpreter.abort("There are no images open")
  const NO_IMAGE_TEXT = 'There are no images open';

  // Name → id. A–C win over D on a shared name (Window › Log is Studio only; Process › Math › Log is ImageJ's "Log").
  const ACTIVE = new Map(), REFUSED = new Map();
  for (const pass of [['A', 'B', 'C'], ['D'], ['E']]) {
    for (const id of Object.keys(T)) {
      const e = T[id];
      if (pass.indexOf(e.cls) < 0 || e.alias) continue;
      const m = e.cls === 'E' ? REFUSED : ACTIVE;
      if (!m.has(e.name)) m.set(e.name, id);
    }
  }
  for (const e of Object.values(T)) {
    Object.freeze(e.dialogs);
    for (const d of e.dialogs) { Object.freeze(d.keys); if (d.items) { for (const k of Object.keys(d.items)) Object.freeze(d.items[k]); Object.freeze(d.items); } Object.freeze(d); }
    Object.freeze(e);
  }
  Object.freeze(T);
  Object.freeze(IJ_CONVERT);
  REFUSED_NAMES.forEach(Object.freeze);
  Object.freeze(REFUSED_NAMES);

  function lookup(name) {
    if (ACTIVE.has(name)) { const id = ACTIVE.get(name); return { id, entry: T[id] }; }
    if (REFUSED.has(name)) {
      const e = T[REFUSED.get(name)];
      return { refuse: e.later ? { key: 'err.macFileLater', params: { name } } : { key: 'err.macRefused', params: { command: name, reasonKey: e.refuse } } };
    }
    return null;
  }

  /** run("name") → the Studio command, a refusal, or null (ImageJ's "Unrecognized command"). No case folding, no trimming. */
  function resolve(name) {
    if (typeof name !== 'string') return null;
    const direct = lookup(name);
    if (direct) return direct;
    if (Object.prototype.hasOwnProperty.call(IJ_CONVERT, name)) {
      const conv = lookup(IJ_CONVERT[name]);
      if (conv) return conv;
    }
    for (const r of REFUSED_NAMES) {
      if ((r.exact !== undefined && name === r.exact) || (r.prefix !== undefined && name.startsWith(r.prefix)) || (r.suffix !== undefined && name.endsWith(r.suffix))) {
        return { refuse: { key: r.key, params: Object.assign({ name }, r.params || {}) } };
      }
    }
    return null;
  }
  const nameOf = (id) => (Object.prototype.hasOwnProperty.call(T, id) ? T[id].name : null);

  // ═══════════════════════════════════════ headless answering (GenericDialog's macro mode) ═══════════════════════════════════════

  const CHOICE_LIKE = new Set(['choice', 'radio', 'doc', 'channel']);
  const has = (o, k) => !!o && Object.prototype.hasOwnProperty.call(o, k);

  function trOf(ctx) {
    if (ctx && typeof ctx.tr === 'function') return ctx.tr;
    return (k, p) => String(k) + (p ? ' ' + JSON.stringify(p) : '');
  }

  /** The DialogEntry that answers a dialog (INTEGRATION.md §5.3 rule 1): the one at its index when it covers every field, else the first that does.
   *  The "all channels" check (id `all`) is covered by ImageJ's `stack` word when the table does not name it. */
  function pickDialog(entry, index, fields) {
    const list = entry && Array.isArray(entry.dialogs) ? entry.dialogs : [];
    const ids = fields.filter((f) => f && f.type !== 'message' && !(f.id === 'all' && f.type === 'check')).map((f) => f.id);
    const covers = (d) => !!d && ids.every((id) => has(d.keys, id));
    if (covers(list[index])) return list[index];
    return list.find(covers) || null;
  }

  // Interpreter variable lookups, from the variables the worker sent: { n } numeric (with its text s), { s } string
  function varNumber(vars, name) {
    const v = has(vars, name) ? vars[name] : null;
    if (!v) return NaN;
    if (typeof v.n === 'number') return v.n;
    if (typeof v.s === 'string') { const d = javaDouble(v.s); return d === null ? NaN : d; }
    return NaN;
  }
  function varString(vars, name) {
    const v = has(vars, name) ? vars[name] : null;
    return v && typeof v.n !== 'number' && typeof v.s === 'string' ? v.s : null;
  }
  function varAsString(vars, name) {
    const s = varString(vars, name);
    if (s !== null) return s;
    const n = varNumber(vars, name);
    return Number.isNaN(n) ? null : javaToString(n);
  }
  function choiceVariable(vars, item) {
    const name = item.slice(1);
    const s = varString(vars, name);
    if (s !== null) return s;
    const n = varNumber(vars, name);
    if (Number.isNaN(n)) return name;
    return Number.isInteger(n) && n >= -2147483648 && n <= 2147483647 ? String(n) : javaToString(n);
  }

  function numericError(title, key, text) {
    return 'Numeric value expected in run() function\n \n'
      + '\t Dialog box title: "' + title + '"\n'
      + '\t Key: "' + String(key).toLowerCase() + '"\n'
      + '\t Value or variable name: "' + text + '"';
  }
  const choiceError = (item, key) => '"' + item + '" is not a valid choice for "' + key + '"';

  /** GenericDialog.getNextNumber in macro mode → { value } | { error }. */
  function readNumber(options, key, f, vars, title) {
    const text = getValue(options, key, null);
    if (text === null) return null;
    let value;
    if (text.startsWith('0x')) value = parseHex(text.slice(2));
    else {
      const d = javaDouble(text);
      if (d !== null) value = d;
      else {
        const name = text.startsWith('&') ? text.slice(1) : text;
        value = varNumber(vars, name);
        if (Number.isNaN(value)) return { error: numericError(title, key, name) };
      }
    }
    // an integer field takes ImageJ's (int) cast: GenericDialog hands the plugin a double it truncates
    if (f.integer && Number.isFinite(value)) value = Math.trunc(value);
    return { value };
  }

  /** GenericDialog.getNextString in macro mode. */
  function readString(options, key, f, vars) {
    let text = getValue(options, key, null);
    if (text === null) return null;
    const dflt = f.value === undefined || f.value === null ? '' : String(f.value);
    const numberExpected = dflt.length > 0 && (/^[0-9]/.test(dflt) || dflt.startsWith('-'));
    if (text.startsWith('&') || numberExpected || String(key).toLowerCase().startsWith(text)) {
      if (text.startsWith('&')) text = text.slice(1);
      const s = varAsString(vars, text);
      if (s !== null) text = s;
    }
    return { value: text };
  }

  /** A choice-like field: the item text → the option's value (items map, image titles, the value itself), else ImageJ's error. */
  function readChoice(options, key, f, de, vars, opts) {
    let item = getValue(options, key, null);
    if (item === null) return null;
    if (item.startsWith('&')) item = choiceVariable(vars, item);
    const live = opts.filter((o) => !(o && typeof o === 'object' && o.disabled));
    const map = de && de.items ? de.items[f.id] : null;
    const byTitle = !!(de && Array.isArray(de.titles) && de.titles.indexOf(f.id) >= 0) || f.type === 'doc';
    const find = (text) => {
      if (map && has(map, text)) {
        const v = map[text];
        if (v === null) return { keep: true };
        const o = live.find((x) => String(optValue(x)) === String(v));
        return o ? { value: optValue(o) } : null;
      }
      if (byTitle) { const o = live.find((x) => optLabel(x) === text); if (o) return { value: optValue(o) }; }
      if (f.type === 'channel' && !map) {
        if (/^\d+$/.test(text)) { const o = live.find((x) => String(optValue(x)) === String(Number(text) - 1)); if (o) return { value: optValue(o) }; }
        const o = live.find((x) => optLabel(x) === text);
        if (o) return { value: optValue(o) };
        return null;
      }
      if (!map && !byTitle) { const o = live.find((x) => String(optValue(x)) === text); if (o) return { value: optValue(o) }; }
      return null;
    };
    let hit = find(item);
    if (!hit) {
      // getNextChoiceIndex: an item that is no choice may name a string variable
      const s = varString(vars, item);
      if (s !== null) hit = find(s);
    }
    if (!hit) return { error: choiceError(item, key) };
    return hit;
  }

  /**
   * The values a Studio dialog returns when a macro's options string answers it (GenericDialog's macro mode, INTEGRATION.md §5.3).
   * spec = the expanded dialog spec; options = IJMacroOptions.normalize(...) (never null here); ctx = { commandId, entry, dialogIndex, vars, pure, tr,
   * composite?, rgb? } (the active image: several channels shown as a composite / an RGB image — IJ.setupDialog's rules for a PlugInFilter).
   * → { ok: true, values, unknown: [fieldId] } | { ok: false, error: { text } }. Never throws, never runs a preview.
   */
  function headlessAnswer(spec, options, ctx) {
    const c = ctx || {};
    const tr = trOf(c);
    try {
      return answer(spec || {}, options === null || options === undefined ? '' : String(options), c, tr);
    } catch (err) {
      if (typeof console !== 'undefined') console.error('[advanced-studio] macro options', err);
      return { ok: false, error: { text: tr('err.macNotInBrowser', { name: String((c.entry && c.entry.name) || c.commandId || '') }) } };
    }
  }

  function answer(spec, options, c, tr) {
    const P = c.pure;
    if (!P || typeof P.collectFields !== 'function') throw new Error('headlessAnswer: IJViewPure is required');
    const fields = Array.isArray(spec.fields) ? spec.fields.filter((f) => f && typeof f === 'object') : [];
    const vars = c.vars && typeof c.vars === 'object' ? c.vars : {};
    const de = pickDialog(c.entry, c.dialogIndex | 0, fields);
    // the plugin's own Macro.setOptions before its dialog (Scaler, ImageProperties)
    if (de && typeof de.rewrite === 'function') options = String(de.rewrite(options));
    const title = de && typeof de.title === 'string' ? de.title : String(spec.title || '');
    if (de && de.refuse) {
      const name = (c.entry && c.entry.name) || String(spec.title || '');
      return { ok: false, error: { text: tr('err.macRefused', { command: name, reason: tr(de.refuse) }) } };
    }
    const keyOfField = {}, unknown = [];
    for (const f of fields) {
      if (f.type === 'message') continue;
      if (de && has(de.keys, f.id)) keyOfField[f.id] = de.keys[f.id];
      else if (typeof f.ijKey === 'string' && f.ijKey) keyOfField[f.id] = f.ijKey;
      else if (f.id === 'all' && f.type === 'check') keyOfField[f.id] = ALL;
      else { keyOfField[f.id] = null; unknown.push(f.id); }
    }

    // raw control values (what the view reads from its controls), and which fields the options set
    const raw = {}, explicit = new Set();
    const rawOf = (f, v) => (f.type === 'check' ? !!v : (v === undefined || v === null ? '' : (typeof v === 'number' ? String(v) : String(v))));
    for (const f of fields) if (f.type !== 'message') raw[f.id] = rawOf(f, f.value);
    const derive = de && de.derive ? de.derive : null;
    // doc fields first: a channel field lists the channels of the image its doc field names
    const order = fields.filter((f) => f.type === 'doc').concat(fields.filter((f) => f.type !== 'doc' && f.type !== 'message'));
    for (const f of order) {
      if (derive && typeof derive[f.id] === 'function') {
        const v = derive[f.id](options);
        if (v !== undefined) { raw[f.id] = rawOf(f, v); explicit.add(f.id); }
        continue;
      }
      const key = keyOfField[f.id];
      if (key === null || key === undefined) continue;
      if (f.type === 'number' || f.type === 'slider') {
        const r = readNumber(options, key, f, vars, title);
        if (!r) continue;
        if (r.error) return { ok: false, error: { text: r.error } };
        raw[f.id] = String(r.value); explicit.add(f.id);
      } else if (f.type === 'check') {
        if (de && de.setup && f.id === 'all' && key === ALL) {
          // IJ.setupDialog: an RGB image is processed whole; a composite shown as composite does all its channels unless the options say
          // "slice"; else "stack " anywhere in the options
          raw[f.id] = !!c.rgb || (!!c.composite && options.indexOf('slice') < 0) || hasWord(options, 'stack');
        } else raw[f.id] = isMatch(options, key);
        explicit.add(f.id);
      } else if (CHOICE_LIKE.has(f.type)) {
        const opts = typeof P.effectiveOptions === 'function' ? P.effectiveOptions(f, raw) : (f.options || []);
        const r = readChoice(options, key, f, de, vars, opts);
        if (!r) continue;
        if (r.error) return { ok: false, error: { text: r.error } };
        if (r.keep) continue;
        raw[f.id] = String(r.value); explicit.add(f.id);
      } else if (f.type === 'textarea') {
        let t = getValue(options, key, null);
        if (t !== null && t.startsWith('&')) { const v = varAsString(vars, t.slice(1)); t = v !== null ? v : t.slice(1); }
        if (t !== null) { raw[f.id] = t; explicit.add(f.id); }
      } else {
        const r = readString(options, key, f, vars);
        if (r) { raw[f.id] = r.value; explicit.add(f.id); }
      }
    }

    const keyText = (id) => (keyOfField[id] ? keyOfField[id] : id);
    const invalid = (id, message) => ({ ok: false, error: { text: tr('dlg.mac.invalidValue', { title, key: keyText(id), message }) } });
    const collect = () => {
      // enabledIf / visibleIf as the view resolves them: two passes, a hidden field keeps its initial value
      const hidden = new Set();
      for (let pass = 0; pass < 2; pass++) {
        const r0 = P.collectFields(fields, raw, { hidden });
        let changed = false;
        for (const f of fields) {
          if (typeof f.visibleIf !== 'function') continue;
          let vis = true;
          try { vis = !!f.visibleIf(r0.values); } catch (e) { if (typeof console !== 'undefined') console.error('[advanced-studio] visibleIf', e); }
          if (vis === hidden.has(f.id)) { changed = true; if (vis) hidden.delete(f.id); else hidden.add(f.id); }
        }
        if (!changed) break;
      }
      return P.collectFields(fields, raw, { hidden });
    };
    const firstError = (r) => {
      const id = fields.map((f) => f.id).find((x) => r.errors[x] !== undefined);
      return invalid(id, tr('view.invalid.' + r.errors[id]));
    };

    let r = collect();
    if (!r.ok) return firstError(r);
    if (typeof spec.onChange === 'function') {
      // GenericDialog calls dialogItemChanged(gd, null) once in macro mode: a derived field follows the others unless the options set it
      const patch = {};
      const set = (p) => { for (const k of Object.keys(p || {})) if (!explicit.has(k)) patch[k] = p[k]; };
      try { spec.onChange(r.values, set, null); } catch (e) { if (typeof console !== 'undefined') console.error('[advanced-studio] onChange', e); }
      let touched = false;
      for (const k of Object.keys(patch)) {
        const f = fields.find((x) => x.id === k);
        const v = patch[k];
        if (!f || f.type === 'message' || (typeof v === 'number' && !Number.isFinite(v))) continue;
        raw[k] = rawOf(f, v); touched = true;
      }
      if (touched) { r = collect(); if (!r.ok) return firstError(r); }
    }
    if (typeof spec.validate === 'function') {
      let v = null;
      try { v = spec.validate(r.values); } catch (e) { if (typeof console !== 'undefined') console.error('[advanced-studio] validate', e); }
      if (v && typeof v === 'object') {
        const id = fields.map((f) => f.id).find((x) => v[x] !== undefined) || Object.keys(v)[0];
        if (id !== undefined) return invalid(id, tr(v[id]));
      }
    }
    return { ok: true, values: r.values, unknown };
  }

  root.IJMacroOptions = Object.freeze(IJMacroOptions);
  root.IJMacroCmds = Object.freeze({ MACRO_COMMANDS: T, IJ_CONVERT, REFUSED_NAMES, NO_IMAGE_TEXT, resolve, nameOf, headlessAnswer, pickDialog, IJMacroOptions: root.IJMacroOptions });
})(typeof self !== 'undefined' ? self : globalThis);
