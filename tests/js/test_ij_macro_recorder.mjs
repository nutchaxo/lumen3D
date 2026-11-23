// The Advanced Studio's macro Recorder (js/modules/studio/advanced-studio/ij-macro-rec.js, DOCS/studio-advanced/macros/EXTRAS.md §5)
// against ImageJ 1.54p's ij.plugin.frame.Recorder:
//   1. the formatters (fixString, addQuotes, trimKey, strip, the record(...) overloads) on vectors written from Recorder.java;
//   2. the model: saveCommand's special names, the colour / black-background lines and their flags, the macro-time rule, the selection
//      lines, the tool-window lines (Threshold, B&C, ROI Manager, Channels), ImageJ's missing newline after a fractional setMinAndMax;
//   3. the Recorder window (Create / Run / Help) on a small DOM stand-in;
//   4. (a) the `recorded` sweep: every Studio command whose ImageJ dialog was captured with the Recorder's string
//      (tests/fixtures/ij-macro/ij-dialogs.json) runs in the Node harness, answered with ImageJ's own default values, and the line the
//      Recorder writes carries ImageJ's options (a short list of exceptions, each with its reason);
//   5. (b) a recorded operator session (selection, Gaussian Blur, Threshold, Convert to Mask, Analyze Particles, ROI Manager, another
//      image activated, Invert, Measure) replayed as a macro on a fresh boot: same pixels, selection, Results and ROI Manager;
//   6. (c) every case of tests/fixtures/ij-macro/recorder-golden.json (the real jar's Recorder text) replayed through the model: SKIP while
//      the golden is absent.
// The page events (`command`, `action`) come from ij-app.js when it emits them; a command or action the page does not report yet is fed
// to the model by this test's own stand-in, built from the same dialog specs and values (the model never knows the difference).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { DIR, EN, boot, sleep, until } from './ij_harness.mjs';
import { fixture } from './ij_macro_cmds_support.mjs';

const REC_FILE = path.join(DIR, 'ij-macro-rec.js');
if (!fs.existsSync(REC_FILE)) { console.log('SKIP test_ij_macro_recorder: ij-macro-rec.js is absent'); process.exit(0); }
if (!fs.existsSync(path.join(DIR, 'ij-macro-cmds.js'))) { console.log('SKIP test_ij_macro_recorder: ij-macro-cmds.js is absent'); process.exit(0); }

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok  ' + name); } catch (err) { console.error('FAIL ' + name); throw err; }
}

// ── a context with what the page loads before the Recorder ───────────────────────────────────────────────────────────────
function loadRec() {
  const ctx = vm.createContext({ console, setTimeout, clearTimeout });
  ctx.self = ctx;
  for (const f of ['ij-core.js', 'ij-analysis.js', 'ij-proc-shared.js', 'ij-proc-ov.js', 'ij-proc-ana.js', 'ij-macro-cmds.js']) {
    vm.runInContext(fs.readFileSync(path.join(DIR, f), 'utf8'), ctx, { filename: f });
  }
  // stand-ins for IJMacroOptions.recordTokens / foldTokens (EXTRAS.md §4.6) while ij-macro-cmds.js does not have them yet
  if (typeof ctx.IJMacroOptions.recordTokens !== 'function' || typeof ctx.IJMacroOptions.foldTokens !== 'function') {
    console.log('  (IJMacroOptions.recordTokens / foldTokens absent: the stand-in of this test is used)');
    ctx.IJMacroOptions = Object.assign({}, ctx.IJMacroOptions, standInTokens(ctx.IJMacroOptions));
  }
  vm.runInContext(fs.readFileSync(REC_FILE, 'utf8'), ctx, { filename: 'ij-macro-rec.js' });
  return ctx;
}
function standInTokens(O) {
  const trimNumber = (v) => { if (v.endsWith('.0')) v = v.slice(0, -2); if (v.endsWith('.00')) v = v.slice(0, -3); return v; };
  const num = (v, f) => (Number.isInteger(f.decimals) ? v.toFixed(f.decimals) : (Number.isInteger(v) ? String(v) : String(v)));
  const itemText = (f, v, de) => {
    const map = de && de.items && de.items[f.id];
    if (map) for (const k of Object.keys(map)) if (map[k] !== null && String(map[k]) === String(v)) return k;
    const o = (f.options || []).find((x) => String(x && typeof x === 'object' ? x.value : x) === String(v));
    return o && typeof o === 'object' ? String(o.label !== undefined ? o.label : o.value) : String(v);
  };
  return {
    recordTokens(values, de, spec) {
      const out = [];
      const keys = (de && de.keys) || {};
      let ta = 0;
      for (const f of (spec.fields || []).filter(Boolean)) {
        if (f.type === 'message' || !Object.prototype.hasOwnProperty.call(values, f.id)) continue;
        let key = Object.prototype.hasOwnProperty.call(keys, f.id) ? keys[f.id] : (f.ijKey || (f.id === 'all' && f.type === 'check' ? 'stack' : null));
        if (!key) continue;
        key = O.trimKey(O.fixString(key));
        const v = values[f.id];
        if (f.type === 'check') { out.push(v ? { t: 'flag', key } : { t: 'blank' }); continue; }
        if (f.type === 'number' || f.type === 'slider') {
          const text = trimNumber(num(Number(v), f));
          if (de && de.smart && text === trimNumber(num(Number(f.value), f))) continue;
          out.push({ t: 'opt', key, value: text === '' ? '[]' : text });
        } else if (f.type === 'textarea') out.push({ t: 'opt', key: ++ta === 1 ? 'text1' : 'text2', value: O.fixString(String(v)) });
        else if (f.type === 'choice' || f.type === 'radio' || f.type === 'doc' || f.type === 'channel') {
          if (de && de.smart && f.type !== 'radio' && String(v) === String(f.value)) continue;
          out.push({ t: 'opt', key, value: itemText(f, v, de) });
        } else {
          const s = O.fixString(String(v));
          if (de && de.smart && s === O.fixString(String(f.value))) { out.push({ t: 'blank' }); continue; }
          out.push({ t: 'opt', key, value: s === '' ? '[]' : s });
        }
      }
      return out;
    },
    foldTokens(tokens, start) {
      let o = start === undefined ? null : start;
      for (const tk of tokens) {
        if (tk.t === 'opt') { const v = String(tk.value).indexOf(' ') > -1 ? '[' + tk.value + ']' : String(tk.value); o = o === null ? tk.key + '=' + v : o + ' ' + tk.key + '=' + v; }
        else if (tk.t === 'flag') o = o === null || o === ' ' ? tk.key : o + ' ' + tk.key;
        else if (o === null) o = ' ';
      }
      return o;
    }
  };
}

const C = loadRec();
const R = C.IJMacroRec;
const T = C.IJMacroCmds.MACRO_COMMANDS;
const idOf = (name) => Object.keys(T).find((k) => T[k].name === name && !T[k].alias);

// a fake command pair: the 'start' and 'end' records of EXTRAS.md §4.1
let seq = 0;
const ctxOf = (o) => Object.assign({ docId: 1, title: 'img', bitDepth: 8, nSlices: 1, nC: 1, roi: null, fg: [255, 255, 255], bg: [0, 0, 0], sel: [255, 255, 0], blackBackground: false }, o || {});
function dlgStep(fields, values, entry, index) {
  return { kind: 'dialog', index: index || 0, title: 't', fields, offered: {}, values, entry: entry || null };
}
function command(m, name, o) {
  const op = Object.assign({ id: name ? idOf(name) || 'x' : 'x', cls: 'A', steps: [], status: 'ok', file: null, duringMacro: false }, o || {});
  const s = ++seq;
  const head = { seq: s, id: op.id, name, cls: op.cls, source: op.source || 'menu', duringMacro: op.duringMacro };
  m.onCommand(Object.assign({ phase: 'start' }, head));
  if (op.during) op.during();
  m.onCommand(Object.assign({ phase: 'end' }, head, { status: op.status, steps: op.steps, file: op.file, before: op.before || ctxOf(op.ctx), after: op.after || ctxOf(op.ctx),
    created: op.created || [], closed: [], alt: op.alt }));
}
const fresh = () => { const m = R.create(); m.open(); return m; };

// ═══════════════════════════════════════ 1. formatters ═══════════════════════════════════════

await test('fixString / addQuotes / trimKey / strip / macroName follow Recorder.java', () => {
  assert.equal(R.fixString('a"b\\c\nd\te\x7f\x85é '), 'a\\"b\\\\c\\nd\\011e\\177\\205é ');
  assert.equal(R.fixString('\x01'), '\\001');
  assert.equal(R.addQuotes('a b'), '[a b]');
  assert.equal(R.addQuotes('ab'), 'ab');
  assert.equal(R.addQuotes(null), '');
  assert.equal(R.trimKey('Sigma (Radius):'), 'sigma');
  assert.equal(R.trimKey('Save as TIFF'), 'save');
  assert.equal(R.trimKey('Open'), 'open');
  assert.equal(R.trimKey('Radius:'), 'radius');
  assert.equal(R.strip('save=[/Data/a b.tif] x=1'), '/Data/a b.tif');
  assert.equal(R.strip('open=/tmp/a.tif stack'), '/tmp/a.tif');
  assert.equal(R.strip('open=[/tmp/a'), '/tmp/a');
  assert.equal(R.strip('3'), '3');
  assert.equal(R.macroName('Macro.ijm'), 'Macro.ijm');
  assert.equal(R.macroName('Notes.txt'), 'Notes.txt');
  assert.equal(R.macroName('Script.js'), 'Script.ijm');
  assert.equal(R.macroName('a.b.c'), 'a.b.ijm');
  assert.equal(R.macroName('Recorded'), 'Recorded.ijm');
  assert.equal(R.fixPath('/Data/x y/a.tif'), '/Data/x y/a.tif');
});

await test('the record(...) overloads give the text Recorder.java appends', () => {
  const L = R.line;
  assert.equal(L.r0('resetThreshold'), 'resetThreshold;\n');
  assert.equal(L.r1('selectImage', 'blobs.gif'), 'selectImage("blobs.gif");\n');
  assert.equal(L.r1('setTool', 'oval'), '//setTool("oval");\n');
  assert.equal(L.r2('roiManager', 'Rename', 'cell 1'), 'roiManager("Rename", "cell 1");\n');
  assert.equal(L.r2('saveAs', 'Tiff', '/tmp/a.tif'), 'saveAs("Tiff", "/tmp/a.tif");\n');
  assert.equal(L.r3('imageCalculator', 'Add create', 'a', 'b'), 'imageCalculator("Add create", "a","b");\n');
  assert.equal(L.ri('makeRectangle', 10, 20, 30.9, -0.5), 'makeRectangle(10, 20, 30, 0);\n');
  assert.equal(L.ri('Stack.setChannel', 2), 'Stack.setChannel(2);\n');
  assert.equal(L.rdd('setThreshold', 1.5, 200), 'setThreshold(1.5000, 200.0000);\n');
  assert.equal(L.rdd('setThreshold', 0.00001, 2), 'setThreshold(0.000010000, 2.000000000);\n');
  assert.equal(L.rdd('setThreshold', -3.25, 1e3), 'setThreshold(-3.2500, 1000.0000);\n');
  assert.equal(L.riis('makePoint', 3, 4, 'small yellow hybrid'), 'makePoint(3, 4, "small yellow hybrid");\n');
  assert.equal(L.rsi('roiManager', 'Set Line Width', 2), 'roiManager("Set Line Width", 2);\n');
  assert.equal(L.riiiid('makeEllipse', 1, 2, 3, 4, 0.5), 'makeEllipse(1, 2, 3, 4, 0.50);\n');
  assert.equal(R.colorToString([255, 200, 0]), 'orange');
  assert.equal(R.colorToString([192, 192, 192]), 'lightGray');
  assert.equal(R.colorToString([1, 2, 255]), '#0102ff');
});

// ═══════════════════════════════════════ 2. the model ═══════════════════════════════════════

await test('selections: rectangle / oval / line on every mouse-up, polygon / segmented line / angle when built, the first point only, the Wand click', () => {
  const sel = (roi, action, more) => R.roiLines(Object.assign({ kind: 'roi', action: action || 'draw', roi, wand: null, combine: null, ctx: ctxOf() }, more || {}), null);
  assert.equal(sel({ type: 'rect', x: 10, y: 12, w: 40, h: 30 }), 'makeRectangle(10, 12, 40, 30);\n');
  assert.equal(sel({ type: 'rect', x: 11, y: 12, w: 40, h: 30 }, 'move'), 'makeRectangle(11, 12, 40, 30);\n');
  assert.equal(sel({ type: 'rect', x: 10, y: 12, w: 44, h: 30 }, 'resize'), 'makeRectangle(10, 12, 44, 30);\n');
  assert.equal(sel({ type: 'rect', x: 10, y: 12, w: 44, h: 30 }, 'nudge'), '');
  assert.equal(sel(null, 'clear'), '');
  assert.equal(sel({ type: 'oval', x: 1, y: 2, w: 3, h: 4 }), 'makeOval(1, 2, 3, 4);\n');
  assert.equal(sel({ type: 'line', x1: 3.7, y1: 4, x2: 50, y2: 60.2, width: 5 }), 'makeLine(3, 4, 50, 60);\n');
  assert.equal(sel({ type: 'polygon', points: [[4, 4], [30, 6.5], [25, 30]] }), 'makePolygon(4,4,30,7,25,30);\n');
  assert.equal(sel({ type: 'polygon', points: [[4, 4], [30, 6], [25, 30]] }, 'move'), '');
  assert.equal(sel({ type: 'polyline', points: [[1, 2], [3, 4], [5, 6]] }), 'makeLine(1,2,3,4,5,6);\n');
  assert.equal(sel({ type: 'angle', points: [[10, 20], [30, 40], [50, 25]] }), 'makeSelection("angle",newArray(10,30,50),newArray(20,40,25));\n');
  assert.equal(sel({ type: 'point', points: [[12.5, 7.9]] }), 'makePoint(12, 7, "small yellow hybrid");\n');
  assert.equal(R.roiLines({ kind: 'roi', action: 'draw', roi: { type: 'point', points: [[1, 1]] }, ctx: ctxOf({ sel: [0, 128, 255] }) }, null), 'makePoint(1, 1, "small #0080ff hybrid");\n');
  assert.equal(sel({ type: 'point', points: [[12, 7], [20, 9]] }, 'draw', { combine: 'add' }), '');
  assert.equal(sel({ type: 'freehand', points: [[1, 1], [5, 1], [3, 6]] }), '');
  assert.equal(sel({ type: 'polygon', points: [[1, 1], [5, 1], [3, 6]], traced: true }, 'draw', { wand: { x: 5, y: 6, tolerance: 0, connectivity: 8 } }), 'doWand(5, 6, 0.0, "8-connected");\n');
  assert.equal(sel({ type: 'polygon', points: [[1, 1], [5, 1], [3, 6]], traced: true }, 'draw', { wand: { x: 7, y: 8, tolerance: 10, connectivity: 4 }, combine: 'add' }), 'doWand(7, 8, 10.0, "4-connected");\n');
  assert.equal(sel({ type: 'polygon', points: [[1, 1], [5, 1], [3, 6]], traced: true }, 'draw', { wand: { x: 7, y: 8, tolerance: 2.5, connectivity: 8 } }), 'doWand(7, 8, 2.5, "8-connected");\n');
});

await test('a closed Recorder writes nothing; open() starts empty; close() drops the text; open() while open keeps it', () => {
  const m = R.create();
  assert.equal(m.isOpen(), false);
  m.onAction({ kind: 'roi', action: 'draw', roi: { type: 'rect', x: 1, y: 1, w: 2, h: 2 } });
  command(m, 'Invert');
  assert.equal(m.text(), '');
  m.open();
  assert.equal(m.name(), 'Macro.ijm');
  command(m, 'Invert');
  assert.equal(m.text(), 'run("Invert");\n');
  m.open();
  assert.equal(m.text(), 'run("Invert");\n');
  m.close();
  assert.equal(m.text(), '');
  m.open();
  assert.equal(m.text(), '');
  const seen = [];
  const off = m.on('change', (e) => seen.push(e.kind));
  command(m, 'Invert');
  m.setText('x');
  m.setName('Foo.ijm');
  off();
  command(m, 'Invert');
  assert.deepEqual(seen, ['append', 'set', 'name']);
  assert.equal(m.name(), 'Foo.ijm');
  assert.equal(m.text(), 'xrun("Invert");\n');
});

await test('commands: options folded from the dialog steps, the stack answer, cancel / failure / nested / class rules', () => {
  const m = fresh();
  const f = [{ type: 'number', id: 'sigma', label: 'Sigma', value: 2, decimals: 2 }, { type: 'check', id: 'scaled', label: 'Scaled', value: false }];
  const e = { keys: { sigma: 'sigma', scaled: 'scaled' } };
  command(m, 'Gaussian Blur...', { steps: [dlgStep(f, { sigma: 2, scaled: false }, e)] });
  command(m, 'Gaussian Blur...', { steps: [dlgStep(f, { sigma: 5, scaled: true }, e), { kind: 'stack', answer: 'all' }] });
  command(m, 'Gaussian Blur...', { steps: [dlgStep(f, { sigma: 3, scaled: false }, e), { kind: 'stack', answer: 'current' }] });
  assert.equal(m.text(), 'run("Gaussian Blur...", "sigma=2");\nrun("Gaussian Blur...", "sigma=5 scaled stack");\nrun("Gaussian Blur...", "sigma=3 slice");\n');
  // a cancelled dialog: Executer still saves the command, with the options of the dialogs before it (none here)
  const m2 = fresh();
  command(m2, 'Gaussian Blur...', { status: 'cancelled', steps: [dlgStep(f, null, e)] });
  assert.equal(m2.text(), 'run("Gaussian Blur...");\n');
  // a failure before anything was committed: nothing (Executer's throw skips saveCommand); after a committed step: the command
  const m3 = fresh();
  command(m3, 'Invert', { status: 'failed' });
  command(m3, 'Gaussian Blur...', { status: 'failed', steps: [dlgStep(f, { sigma: 4, scaled: false }, e)] });
  assert.equal(m3.text(), 'run("Gaussian Blur...", "sigma=4");\n');
  // class E, no ImageJ name, class D
  const m4 = fresh();
  command(m4, 'Record...', { cls: 'E' });
  command(m4, null, { id: 'fileOpenLibrary' });
  command(m4, 'Studio Thing', { cls: 'D' });
  command(m4, 'Gaussian Blur...', { cls: 'D', steps: [dlgStep(f, { sigma: 2, scaled: false }, e)] });
  assert.equal(m4.text(), 'run("Studio Thing"); // Studio only\nrun("Gaussian Blur...", "sigma=2"); // Studio only\n');
  // the Batch Process window: opening it from the menu writes nothing, its Process button writes BatchProcessor's line
  const mb = fresh();
  command(mb, 'Macro... ', { id: 'batchMacro', cls: 'F' });
  assert.equal(mb.text(), '', 'opening the Batch Process window is not recorded');
  const bf = [{ type: 'choice', id: 'output_format', label: 'Output format:', value: 'TIFF', options: [{ value: 'TIFF', label: 'TIFF' }] },
    { type: 'string', id: 'file', label: 'File name contains:', value: '' }, { type: 'textarea', id: 'text1', label: ' ', value: '' }];
  command(mb, 'Macro... ', { id: 'batchMacro', cls: 'F', steps: [dlgStep(bf, { output_format: 'TIFF', file: '', text1: 'run("Invert");' },
    { keys: { output_format: 'output_format', file: 'file', text1: 'text1' } })] });
  assert.equal(mb.text(), 'run("Macro... ", "output_format=TIFF file=[] text1=run(\\"Invert\\");");\n', 'golden batch/recorded');
  // nested start ignored; an end of another seq ignored; selectImage not recorded while a command runs
  const m5 = fresh();
  const s = ++seq;
  m5.onCommand({ phase: 'start', seq: s, id: 'editInvert', name: 'Invert', cls: 'A', source: 'menu', duringMacro: false });
  m5.onCommand({ phase: 'start', seq: s + 1, id: 'editFill', name: 'Fill', cls: 'A', source: 'menu', duringMacro: false });
  m5.onAction({ kind: 'activate', title: 'other', duringMacro: false });
  m5.onAction({ kind: 'roi', action: 'draw', roi: { type: 'rect', x: 1, y: 2, w: 3, h: 4 }, ctx: ctxOf() });
  m5.onCommand({ phase: 'end', seq: s + 1, id: 'editFill', name: 'Fill', cls: 'A', status: 'ok', steps: [], before: ctxOf(), after: ctxOf() });
  assert.equal(m5.inCommand(), true);
  m5.onCommand({ phase: 'end', seq: s, id: 'editInvert', name: 'Invert', cls: 'A', status: 'ok', steps: [], before: ctxOf(), after: ctxOf() });
  assert.equal(m5.text(), 'makeRectangle(1, 2, 3, 4);\nrun("Invert");\n');
  ++seq;
  // a command the operator runs while a macro waits is recorded (Executer's thread is no macro thread)
  const m6 = fresh();
  command(m6, 'Invert', { duringMacro: true });
  assert.equal(m6.text(), 'run("Invert");\n');
});

await test('saveCommand: colour and black-background lines once until Create, Fill / Clear / Draw "slice", Make Binary, Close, renames', () => {
  const m = fresh();
  command(m, 'Fill', { ctx: { fg: [255, 0, 0] } });
  command(m, 'Fill', { ctx: { fg: [0, 255, 0] } });
  command(m, 'Draw');
  command(m, 'Clear', { ctx: { bg: [10, 20, 30] } });
  command(m, 'Clear Outside');
  command(m, 'Convert to Mask', { ctx: { blackBackground: true } });
  command(m, 'Erode');
  assert.equal(m.text(), 'setForegroundColor(255, 0, 0);\nrun("Fill", "slice");\nrun("Fill", "slice");\nrun("Draw", "slice");\n'
    + 'setBackgroundColor(10, 20, 30);\nrun("Clear", "slice");\nrun("Clear Outside");\nsetOption("BlackBackground", true);\nrun("Convert to Mask");\nrun("Erode");\n');
  m.resetFlags();
  m.clear();
  command(m, 'Clear Outside', { ctx: { bg: [0, 0, 0] } });
  command(m, 'Skeletonize', { ctx: { blackBackground: false } });
  assert.equal(m.text(), 'setBackgroundColor(0, 0, 0);\nrun("Clear Outside");\nsetOption("BlackBackground", false);\nrun("Skeletonize");\n');
  // Make Binary on a single image is recorded as Convert to Mask without options; on a stack it keeps its name and options
  const sf = [{ type: 'choice', id: 'method', label: 'Method', value: 'Default', options: ['Default', 'Huang'] }];
  const se = { keys: { method: 'method' }, items: { method: { Default: 'Default', Huang: 'Huang' } } };
  const m2 = fresh();
  command(m2, 'Make Binary', { steps: [dlgStep(sf, { method: 'Huang' }, se)], ctx: { nSlices: 1, blackBackground: true } });
  command(m2, 'Make Binary', { steps: [dlgStep(sf, { method: 'Huang' }, se)], ctx: { nSlices: 3 } });
  assert.equal(m2.text(), 'setOption("BlackBackground", true);\nrun("Convert to Mask");\nrun("Make Binary", "method=Huang");\n');
  const m3 = fresh();
  command(m3, 'Close');
  command(m3, 'Close', { duringMacro: true });
  command(m3, 'Duplicate Image...');
  command(m3, 'Add to Manager');
  command(m3, 'Find Commands...');
  command(m3, 'Threshold...');
  command(m3, 'Brightness/Contrast...');
  command(m3, 'Channels Tool...');
  command(m3, 'Fonts...');
  command(m3, 'Start Animation [\\]');
  command(m3, 'Plot Profile', { alt: true });
  command(m3, 'Plot Profile');
  assert.equal(m3.text(), 'close;\nrun("Duplicate...");\n//run("Threshold...");\n//run("Brightness/Contrast...");\n//run("Channels Tool...");\n//run("Fonts...");\n'
    + 'doCommand("Start Animation [\\\\]");\nsetKeyDown("alt"); run("Plot Profile");\nrun("Plot Profile");\n');
});

await test('saveCommand: New Image, Hyperstack, Set Slice, Rename, Calibrate, Scale Bar, the non-ASCII warning', () => {
  const m = fresh();
  const tf = (id) => ({ type: 'string', id, label: id, value: '' });
  const nf = (id) => ({ type: 'number', id, label: id, value: 0 });
  const ch = (id, list) => ({ type: 'choice', id, label: id, value: list[0], options: list });
  const newImg = [tf('name'), ch('type', ['8-bit', '16-bit']), ch('fill', ['White', 'Black']), nf('width'), nf('height')];
  const ni = { keys: { name: 'name', type: 'type', fill: 'fill', width: 'width', height: 'height' } };
  command(m, 'Image...', { steps: [dlgStep(newImg, { name: 'Untitled', type: '8-bit', fill: 'Black', width: 512, height: 512 }, ni)] });
  command(m, 'Image...', { steps: [dlgStep(newImg, { name: 'my img', type: '16-bit', fill: 'White', width: 64.7, height: 32 }, ni)] });
  const hyper = newImg.concat([ch('display', ['Color', 'Composite']), nf('channels'), nf('slices'), nf('frames'), { type: 'check', id: 'label', label: 'label', value: false }]);
  const hi = { keys: Object.assign({}, ni.keys, { display: 'display', channels: 'channels', slices: 'slices', frames: 'frames', label: 'label' }) };
  command(m, 'New Hyperstack...', { steps: [dlgStep(hyper, { name: 'HyperStack', type: '8-bit', fill: 'White', width: 400, height: 300, display: 'Color', channels: 3, slices: 4, frames: 5, label: true }, hi)] });
  command(m, 'Set Slice...', { steps: [dlgStep([nf('slice')], { slice: 7 }, { keys: { slice: 'slice' } })] });
  command(m, 'Rename...', { steps: [dlgStep([tf('name')], { name: 'new name' }, { keys: { name: 'title' } })] });
  assert.equal(m.text(), 'newImage("Untitled", "8-bit black", 512, 512, 1);\nnewImage("my img", "16-bit white", 64, 32, 1);\n'
    + 'newImage("HyperStack", "8-bit white color-mode label", 400, 300, 3, 4, 5);\nsetSlice(7);\nrename("new name");\n');
  const m2 = fresh();
  const raw = (s) => [{ kind: 'dialog', index: 0, title: 't', fields: [tf('o')], offered: {}, values: { o: s }, entry: { keys: { o: 'x' } } }];
  // a token stand-in whose folded string is exactly s: recordTokens of one string field gives "x=<s>", so bypass with a raw step
  const rawStep = (opts) => {
    const fields = [], values = {}, keys = {};
    (opts.match(/\S+=\[[^\]]*\]|\S+/g) || []).forEach((w, i) => {
      const eq = w.indexOf('=');
      const id = 'f' + i;
      if (eq < 0) { fields.push({ type: 'check', id, label: w, value: false }); values[id] = true; keys[id] = w; }
      else { fields.push(tf(id)); values[id] = w.slice(eq + 1).replace(/^\[|\]$/g, ''); keys[id] = w.slice(0, eq); }
    });
    return [dlgStep(fields, values, { keys })];
  };
  void raw;
  command(m2, 'Calibrate...', { steps: rawStep('function=None unit=[Gray Value] text1=x') });
  command(m2, 'Calibrate...', { steps: rawStep('function=None unit=mm text1=1 text2=2') });
  command(m2, 'Scale Bar...', { steps: rawStep('width=50 height=50 thickness=4 font=14 color=White background=None location=[Lower Right] horizontal bold overlay') });
  command(m2, 'Properties...', { steps: rawStep('unit=µm pixel_width=1') });
  command(m2, 'Rename...', { steps: rawStep('title=café') });
  command(m2, 'Gaussian Blur...', { steps: rawStep('sigma=2 note=café') });
  assert.equal(m2.text(), 'run("Calibrate...", "function=None");\nrun("Calibrate...", "function=None unit=mm");\n'
    + 'run("Scale Bar...", "width=50 height=50 bold overlay");\nrun("Properties...", "unit=µm pixel_width=1");\nrename("café");\n'
    + 'run("Gaussian Blur...", "sigma=2 note=café");\n  <<warning: the options string contains one or more non-ascii characters>>\n');
});

await test('files: open / saveAs with a virtual path; a file chosen outside the granted folders is a commented line naming the file', () => {
  const m = fresh();
  command(m, 'Open...', { cls: 'F', file: { op: 'open', command: 'Open...', format: null, name: 'a b.tif', vpath: '/Data/run 1/a b.tif' } });
  command(m, 'Tiff...', { cls: 'F', file: { op: 'save', command: 'Tiff...', format: 'Tiff', name: 'a.tif', vpath: '/tmp/a.tif' } });
  command(m, 'PNG...', { cls: 'F', file: { op: 'save', command: 'PNG...', format: 'PNG', name: 'a.png', vpath: '/Out/a.png' } });
  command(m, 'Results... ', { cls: 'F', file: { op: 'open', command: 'Results... ', format: null, name: 'r.csv', vpath: '/Data/r.csv' } });
  command(m, 'Results...', { cls: 'F', file: { op: 'save', command: 'Results...', format: 'Results', name: 'r.csv', vpath: '/tmp/r.csv' } });
  command(m, 'Open...', { cls: 'F', file: { op: 'open', command: 'Open...', format: null, name: 'a.tif', vpath: null } });
  command(m, 'Tiff...', { cls: 'F', file: { op: 'save', command: 'Tiff...', format: 'Tiff', name: 'a.tif', vpath: null } });
  assert.equal(m.text(), 'open("/Data/run 1/a b.tif");\nsaveAs("Tiff", "/tmp/a.tif");\nsaveAs("PNG", "/Out/a.png");\nopen("/Data/r.csv");\n'
    + '//open("a.tif"); // folder unknown: chosen outside the folders granted to macros\n'
    + '//saveAs("Tiff", "a.tif"); // folder unknown: chosen outside the folders granted to macros\n');
});

await test('Image Calculator is recorded as imageCalculator(...) and no run() line', () => {
  const m = fresh();
  const docs = [{ value: 3, label: 'blobs' }, { value: 4, label: 'other img' }];
  const fields = [{ type: 'doc', id: 'image1', label: 'Image1', value: 3, options: docs }, { type: 'choice', id: 'op', label: 'Op', value: 'add', options: ['add', 'subtract'] },
    { type: 'doc', id: 'image2', label: 'Image2', value: 4, options: docs }, { type: 'check', id: 'float32', label: '32', value: false }];
  const entry = T.procImageCalculator.dialogs[0];
  command(m, 'Image Calculator...', { steps: [dlgStep(fields, { image1: 3, op: 'subtract', image2: 4, float32: true }, entry)], created: [9] });
  command(m, 'Image Calculator...', { steps: [dlgStep(fields, { image1: 4, op: 'add', image2: 4, float32: false }, entry), { kind: 'stack', answer: 'all' }], created: [] });
  command(m, 'Image Calculator...', { status: 'cancelled', steps: [dlgStep(fields, null, entry)] });
  assert.equal(m.text(), 'imageCalculator("Subtract create 32-bit", "blobs","other img");\nimageCalculator("Add stack", "other img","other img");\nrun("Image Calculator...");\n');
});

await test('activations, windows, tools, line width; the macro-time rule (X1)', () => {
  const m = fresh();
  m.onAction({ kind: 'activate', title: 'a"b.tif', duringMacro: false });
  m.onAction({ kind: 'activate', title: 'c.tif', duringMacro: true });
  m.onAction({ kind: 'window', title: 'Results', duringMacro: false });
  m.onAction({ kind: 'window', title: 'Log', duringMacro: true });
  m.onAction({ kind: 'tool', tool: 'oval', duringMacro: false });
  m.onAction({ kind: 'tool', tool: 'polyline', duringMacro: true });
  m.onAction({ kind: 'tool', tool: 'cellCounter', duringMacro: false });
  m.onAction({ kind: 'lineWidth', width: 5, duringMacro: false });
  m.onAction({ kind: 'roi', action: 'draw', roi: { type: 'line', x1: 1, y1: 2, x2: 3, y2: 4 }, duringMacro: true, ctx: ctxOf() });
  // WindowManager.setCurrentWindow records the raw title (Recorder.record(String, String) adds no escape)
  assert.equal(m.text(), 'selectImage("a"b.tif");\nselectWindow("Results");\n//setTool("oval");\n//setTool("polyline");\nrun("Line Width...", "line=5");\nmakeLine(1, 2, 3, 4);\n');
});

await test('Threshold window: setAutoThreshold, setMode, Set, Reset, Apply (8-bit comment line, none on 16 / 32-bit or while a macro waits)', () => {
  const m = fresh();
  const thr = (o) => m.onAction(Object.assign({ kind: 'threshold', duringMacro: false, method: 'Default', dark: false, hist16: false, mode: 'red', lower: 0, upper: 0, bitDepth: 8, stack: false }, o));
  thr({ op: 'auto', dark: true });
  thr({ op: 'method', method: 'Otsu', dark: true });
  thr({ op: 'hist16', method: 'Otsu', hist16: true, bitDepth: 16 });
  thr({ op: 'hist16', method: 'Otsu', hist16: true, bitDepth: 8 });
  thr({ op: 'hist16', method: 'Otsu', hist16: true, bitDepth: 32 });
  thr({ op: 'auto', bitDepth: 16, displayMin: 100, displayMax: 2000, dataMin: 0, dataMax: 4095 });
  thr({ op: 'auto', bitDepth: 16, displayMin: 0, displayMax: 4095, dataMin: 0, dataMax: 4095 });
  thr({ op: 'mode', mode: 'bw' });
  thr({ op: 'mode', mode: 'overunder' });
  thr({ op: 'set', lower: 50, upper: 255 });
  thr({ op: 'set', lower: 12.75, upper: 99.5, bitDepth: 32 });
  thr({ op: 'set', lower: 100.9, upper: 3000, bitDepth: 16 });
  thr({ op: 'reset' });
  thr({ op: 'apply', lower: 120, upper: 255 });
  thr({ op: 'apply', lower: 120, upper: 4000, bitDepth: 16 });
  thr({ op: 'apply', lower: 120, upper: 255, duringMacro: true });
  thr({ op: 'auto', duringMacro: true });
  assert.equal(m.text(), 'setAutoThreshold("Default dark no-reset");\nsetAutoThreshold("Otsu dark no-reset");\nsetAutoThreshold("Otsu 16-bit no-reset");\n'
    + 'setAutoThreshold("Otsu 16-bit no-reset");\nsetAutoThreshold("Otsu no-reset");\nsetMinAndMax(100, 2000);\nsetAutoThreshold("Default no-reset");\nsetAutoThreshold("Default no-reset");\n'
    + 'call("ij.plugin.frame.ThresholdAdjuster.setMode", "B&W");\ncall("ij.plugin.frame.ThresholdAdjuster.setMode", "Over/Under");\n'
    + 'setThreshold(50, 255, "raw");\nsetThreshold(12.7500, 99.5000);\nsetThreshold(100, 3000, "raw");\nresetThreshold;\n//setThreshold(120, 255);\n'
    + 'setAutoThreshold("Default no-reset");\n');
  // Apply = the comment line, then the Convert to Mask command pair (EXTRAS.md §18 item 3)
  const m2 = fresh();
  m2.onAction({ kind: 'threshold', op: 'apply', lower: 0, upper: 128, bitDepth: 8, duringMacro: false });
  command(m2, 'Convert to Mask', { source: 'threshold', ctx: { blackBackground: false } });
  assert.equal(m2.text(), '//setThreshold(0, 128);\nsetOption("BlackBackground", false);\nrun("Convert to Mask");\n');
});

await test('B&C: Auto, Reset, Set (whole numbers; a fractional 32-bit range has no newline: the next line follows on the same line), Apply', () => {
  const m = fresh();
  const bc = (o) => m.onAction(Object.assign({ kind: 'bc', duringMacro: false, bitDepth: 8, scope: null }, o));
  bc({ op: 'auto' });
  bc({ op: 'reset' });
  bc({ op: 'set', min: 10, max: 200 });
  bc({ op: 'set', min: 10.7, max: 200.2, bitDepth: 16 });
  bc({ op: 'apply' });
  bc({ op: 'apply', scope: 'stack' });
  bc({ op: 'set', min: 0.25, max: 1.5, bitDepth: 32 });
  m.onAction({ kind: 'roi', action: 'draw', roi: { type: 'rect', x: 1, y: 2, w: 3, h: 4 }, ctx: ctxOf() });
  bc({ op: 'set', min: 2, max: 9, bitDepth: 32 });
  assert.equal(m.text(), 'run("Enhance Contrast", "saturated=0.35");\nresetMinAndMax;\nsetMinAndMax(10, 200);\nsetMinAndMax(10, 200);\nrun("Apply LUT");\n'
    + 'run("Apply LUT", "stack");\nsetMinAndMax(0.25, 1.50);makeRectangle(1, 2, 3, 4);\nsetMinAndMax(2, 9);\n');
});

await test('ROI Manager buttons and Channels tool', () => {
  const m = fresh();
  const rm = (op, o) => m.onAction(Object.assign({ kind: 'rm', op, duringMacro: false, indices: [], count: 1 }, o || {}));
  rm('Add');
  rm('Add', { color: [255, 0, 0], lineWidth: 1 });
  rm('Add', { color: [0, 0, 255], lineWidth: 3 });
  rm('Add', { lineWidth: 4 });
  rm('Select', { indices: [2] });
  rm('Select', { indices: [0, 2, 5] });
  for (const op of ['Update', 'Delete', 'Measure', 'Deselect', 'Show All', 'Show None', 'Show All with labels', 'Show All without labels', 'Fill', 'Draw', 'AND', 'XOR',
    'Split', 'Multi Measure', 'Multi Plot', 'Sort']) rm(op);
  rm('OR');
  rm('Rename', { name: 'cell A' });
  rm('Open', { file: { op: 'open', name: 'RoiSet.zip', vpath: '/Data/RoiSet.zip' } });
  rm('Save', { file: { op: 'save', name: 'RoiSet.zip', vpath: null } });
  rm('Properties', { color: [0, 255, 255], lineWidth: 2 });
  rm('Properties', { group: 3, position: 4, fillColor: [255, 0, 255] });
  rm('Add', { duringMacro: true });
  rm('Delete', { duringMacro: true });
  rm('Show All', { duringMacro: true });
  rm('OR', { duringMacro: true });
  assert.equal(m.text(), 'roiManager("Add");\nroiManager("Add", "ff0000");\nroiManager("Add", "0000ff", 3);\nroiManager("Add", "00ffff", 4);\nroiManager("Select", 2);\nroiManager("Select", newArray(0,2,5));\n'
    + 'roiManager("Update");\nroiManager("Delete");\nroiManager("Measure");\nroiManager("Deselect");\nroiManager("Show All");\nroiManager("Show None");\n'
    + 'roiManager("Show All with labels");\nroiManager("Show All without labels");\nroiManager("Fill");\nroiManager("Draw");\nroiManager("AND");\nroiManager("XOR");\n'
    + 'roiManager("Split");\nroiManager("Multi Measure");\nroiManager("Multi Plot");\nroiManager("Sort");\nroiManager("Combine");\nroiManager("Rename", "cell A");\n'
    + 'roiManager("Open", "/Data/RoiSet.zip");\n//roiManager("Save", "RoiSet.zip"); // folder unknown: chosen outside the folders granted to macros\n'
    + 'roiManager("Set Color", "cyan");\nroiManager("Set Line Width", 2);\nRoiManager.setGroup(3);\nRoiManager.setPosition(4);\nroiManager("Set Fill Color", "magenta");\n'
    + 'roiManager("Show All");\nroiManager("Combine");\n');
  const m2 = fresh();
  m2.onAction({ kind: 'channels', op: 'mode', mode: 'composite', projection: 'Max', duringMacro: false });
  m2.onAction({ kind: 'channels', op: 'mode', mode: 'composite', duringMacro: false });
  m2.onAction({ kind: 'channels', op: 'mode', mode: 'grayscale', duringMacro: false });
  m2.onAction({ kind: 'channels', op: 'active', active: '1010', duringMacro: true });
  m2.onAction({ kind: 'channels', op: 'channel', channel: 2, duringMacro: false });
  assert.equal(m2.text(), 'Property.set("CompositeProjection", "Max");\nStack.setDisplayMode("composite");\nProperty.set("CompositeProjection", "Sum");\nStack.setDisplayMode("composite");\n'
    + 'Property.set("CompositeProjection", "null");\nStack.setDisplayMode("grayscale");\nStack.setActiveChannels("1010");\nStack.setChannel(2);\n');
});

await test('Run takes the selection or the line of the caret (Recorder.runCode), nothing at offset 0', () => {
  const text = 'run("Invert");\nmakeRectangle(1, 2, 3, 4);\nrun("Measure");\n';
  assert.equal(R.runRange(text, 0, 0), null);
  assert.equal(R.runRange(text, 3, 3).text, 'run("Invert");');
  assert.equal(R.runRange(text, 14, 14).text, 'run("Invert");');
  assert.equal(R.runRange(text, 15, 15).text, 'makeRectangle(1, 2, 3, 4);');
  assert.equal(R.runRange(text, 0, 30).text, text.slice(0, 30));
  assert.equal(R.runRange(text, text.length, text.length).text, '');
  assert.equal(R.runRange('abc', 1, 1).text, 'ab');   // ImageJ's own rule on a last line with no newline
});

// ═══════════════════════════════════════ 3. the window ═══════════════════════════════════════

function fakeDom() {
  const mk = (tag) => {
    const listeners = {};
    const el = {
      tagName: tag.toUpperCase(), children: [], className: '', textContent: '', value: '', type: '', disabled: false, selectionStart: 0, selectionEnd: 0,
      scrollTop: 0, scrollHeight: 100, ownerDocument: null,
      appendChild(c) { el.children.push(c); c.parentNode = el; return c; },
      addEventListener(t, f) { (listeners[t] = listeners[t] || []).push(f); },
      removeEventListener(t, f) { listeners[t] = (listeners[t] || []).filter((x) => x !== f); },
      fire(t, ev) { for (const f of (listeners[t] || []).slice()) f(Object.assign({ preventDefault() { this.prevented = true; } }, ev || {})); },
      count: (t) => (listeners[t] || []).length
    };
    return el;
  };
  const doc = { createElement: mk };
  const root = mk('div');
  root.ownerDocument = doc;
  return root;
}

await test('the Recorder window: Record [Macro] Name [Macro.ijm] Create Run Help over the text; Create / Run / Help / Ctrl+Enter', async () => {
  const el = fakeDom();
  const m = fresh();
  const calls = [];
  const papi = { tr: (k) => 'T(' + k + ')', model: m, create: (n, t) => { calls.push(['create', n, t]); return true; }, run: (t) => { calls.push(['run', t]); },
    message: (a, b) => calls.push(['message', a, b]), isRunning: () => false };
  const p = R.buildPanel(el, papi);
  const [bar, area] = el.children;
  assert.equal(bar.className, 'ij-mac-rec-row');
  assert.equal(area.className, 'ij-mac-rec-text');
  assert.equal(area.tagName, 'TEXTAREA');
  assert.deepEqual(bar.children.map((c) => c.tagName), ['LABEL', 'SELECT', 'LABEL', 'INPUT', 'BUTTON', 'BUTTON', 'BUTTON']);
  assert.equal(bar.children[0].textContent, 'T(dlg.mac.rec.record)');
  assert.equal(bar.children[1].disabled, true);
  assert.equal(bar.children[1].children.length, 1);
  assert.equal(bar.children[1].children[0].textContent, 'T(dlg.mac.rec.modeMacro)');
  assert.equal(bar.children[3].value, 'Macro.ijm');
  assert.deepEqual(bar.children.slice(4).map((b) => b.textContent), ['T(dlg.mac.rec.create)', 'T(dlg.mac.rec.run)', 'T(dlg.mac.rec.help)']);
  // Create on an empty Recorder: ImageJ's message
  p.controls.create.fire('click');
  assert.deepEqual(calls.pop(), ['message', 'dlg.mac.rec.title', 'dlg.mac.rec.createEmpty']);
  // recorded lines appear in the text area and scroll into view
  command(m, 'Fill', { ctx: { fg: [1, 2, 3] } });
  assert.equal(area.value, 'setForegroundColor(1, 2, 3);\nrun("Fill", "slice");\n');
  assert.equal(area.scrollTop, area.scrollHeight);
  // the name field: Create uses createMacro's name rule, then the flags are cleared (the next Fill writes its colour again)
  p.controls.name.value = 'Recorded.js';
  p.controls.name.fire('input');
  assert.equal(m.name(), 'Recorded.js');
  p.controls.create.fire('click');
  await sleep(0);
  assert.deepEqual(calls.pop(), ['create', 'Recorded.ijm', 'setForegroundColor(1, 2, 3);\nrun("Fill", "slice");\n']);
  command(m, 'Fill', { ctx: { fg: [4, 5, 6] } });
  assert.ok(m.text().endsWith('setForegroundColor(4, 5, 6);\nrun("Fill", "slice");\n'));
  // an edit in the text area is the model's text
  area.value = 'run("Invert");\nrun("Measure");\n';
  area.fire('input');
  assert.equal(m.text(), 'run("Invert");\nrun("Measure");\n');
  // Run: the caret's line; offset 0 → the hint; Ctrl+Enter = Run
  area.selectionStart = area.selectionEnd = 17;
  p.controls.run.fire('click');
  assert.deepEqual(calls.pop(), ['run', 'run("Measure");']);
  assert.equal(area.selectionStart, 15);
  area.selectionStart = area.selectionEnd = 0;
  p.controls.run.fire('click');
  assert.deepEqual(calls.pop(), ['message', 'dlg.mac.rec.title', 'dlg.mac.rec.runHint']);
  area.selectionStart = 0; area.selectionEnd = 14;
  const ev = { ctrlKey: true, key: 'Enter' };
  area.fire('keydown', ev);
  assert.deepEqual(calls.pop(), ['run', 'run("Invert");']);
  area.fire('keydown', { ctrlKey: true, key: 'r' });
  assert.equal(calls.length, 0, 'Ctrl+R is never bound (PLAN D12)');
  papi.isRunning = () => true;
  p.controls.run.fire('click');
  assert.equal(calls.length, 0, 'no second run while one is running');
  p.controls.help.fire('click');
  assert.deepEqual(calls.pop(), ['message', 'dlg.mac.rec.title', 'dlg.mac.rec.helpText']);
  // a refused Create (the operator kept the editor's text) keeps the flags
  const m2 = fresh();
  const el2 = fakeDom();
  const p2 = R.buildPanel(el2, Object.assign({}, papi, { model: m2, create: () => false }));
  command(m2, 'Clear', { ctx: { bg: [9, 9, 9] } });
  p2.controls.create.fire('click');
  await sleep(0);
  command(m2, 'Clear', { ctx: { bg: [8, 8, 8] } });
  assert.equal(m2.text(), 'setBackgroundColor(9, 9, 9);\nrun("Clear", "slice");\nrun("Clear", "slice");\n');
  p.refresh('lang');
  p.dispose();
  p2.dispose();
  assert.equal(p.controls.run.count('click'), 0);
  const before = area.value;
  command(m, 'Invert');
  assert.equal(area.value, before, 'a disposed window no longer follows the model');
  assert.ok(String(el.className).indexOf('ij-mac-rec') >= 0, 'the panel root carries .ij-mac-rec');
  for (const k of ['title', 'record', 'modeMacro', 'name', 'create', 'run', 'help', 'helpText', 'createEmpty', 'runHint', 'replaceEditor', 'replace']) {
    if (!(EN.dlg && EN.dlg.mac && EN.dlg.mac.rec && typeof EN.dlg.mac.rec[k] === 'string')) { console.log('  (lang key dlg.mac.rec.' + k + ' not in lang/en.json yet: PAGE writes §13)'); break; }
  }
});

// ═══════════════════════════════════════ harness helpers (4–6) ═══════════════════════════════════════

const W = 96, H = 64;
// DialogKeys.value: the capture image of tools/ij_fixtures/macro/DialogKeys.java
function capValue(x, y, k) {
  let v = 0.5 + 0.25 * Math.sin((x + 5 * k) * 0.21) * Math.cos(y * 0.17);
  let dx = x - (28 + 11 * k), dy = y - 30; if (dx * dx + dy * dy < 120) v += 0.3;
  dx = x - 70; dy = y - (22 + 7 * k); if (dx * dx + dy * dy < 60) v -= 0.25;
  return Math.fround(Math.max(0, Math.min(1, v)));
}
const jround = (v) => Math.floor(v + 0.5);
function capPlane(depth, k, binary, w, h) {
  const a = depth === 16 ? new Uint16Array(w * h) : depth === 32 ? new Float32Array(w * h) : new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const v = capValue(x, y, k);
    a[y * w + x] = binary ? (v > 0.6 ? 255 : 0) : depth === 16 ? jround(v * 4000) : depth === 32 ? Math.fround(v * 100) : jround(v * 255);
  }
  return a;
}
function capImage(name, input) {
  const w = input.id === 'square256' ? 256 : W, h = input.id === 'square256' ? 256 : H;
  const d = input.dims || { c: 1, z: 1, t: 1 };
  if (input.bitDepth === 24) {
    const r = new Uint8Array(w * h), g = new Uint8Array(w * h), b = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = y * w + x; r[i] = jround(capValue(x, y, 0) * 255); g[i] = jround(capValue(y, x, 0) * 255); b[i] = jround(capValue(x + 9, y, 0) * 255); }
    return { name, width: w, height: h, bitDepth: 8, rgb: true, calibration: { pixelWidth: 1, pixelHeight: 1, unit: 'pixel' }, channels: [{ name: 'R', data: r }, { name: 'G', data: g }, { name: 'B', data: b }] };
  }
  const img = { name, width: w, height: h, bitDepth: input.bitDepth, calibration: { pixelWidth: 1, pixelHeight: 1, unit: 'pixel' }, channels: [] };
  const NP = d.z * d.t;
  if (NP > 1) { img.nZ = d.z; img.nT = d.t; img.hyperstack = d.c > 1 || d.t > 1; }
  for (let c = 0; c < d.c; c++) {
    const ch = { name: 'C' + (c + 1), color: ['#ff0000', '#00ff00', '#0000ff'][c] };
    if (NP > 1) { ch.planes = []; for (let p = 0; p < NP; p++) ch.planes.push(capPlane(input.bitDepth, p * d.c + c, input.binary, w, h)); } else ch.data = capPlane(input.bitDepth, c, input.binary, w, h);
    img.channels.push(ch);
  }
  return img;
}
const CAP_ROIS = { rect: { type: 'rect', x: 16, y: 12, w: 48, h: 36 }, line: { type: 'line', x1: 10, y1: 10, x2: 80, y2: 50 } };

/** The ImageJ default of each Studio field of a dialog, from the captured components (keys through the table's DialogEntry). */
function imagejRaw(spec, de, cap) {
  const byKey = new Map();
  for (const c of cap.components || []) if (c.key && !byKey.has(c.key)) byKey.set(c.key, c);
  const raw = {};
  for (const f of (spec.fields || []).filter(Boolean)) {
    if (f.type === 'message') continue;
    raw[f.id] = f.type === 'check' ? !!f.value : (f.value === undefined || f.value === null ? '' : String(f.value));
    const key = de && de.keys ? de.keys[f.id] : null;
    const c = key ? byKey.get(key) : null;
    if (!c) continue;
    if ((c.t === 'numeric' || c.t === 'slider') && (f.type === 'number' || f.type === 'slider')) { const n = Number(c.value); if (Number.isFinite(n)) raw[f.id] = String(n); }
    else if (c.t === 'checkbox' && f.type === 'check') raw[f.id] = !!c.state;
    else if (c.t === 'string' && (f.type === 'string' || f.type === 'textarea')) raw[f.id] = String(c.value);
    else if (c.t === 'textarea' && f.type === 'textarea') raw[f.id] = String(c.value);
    else if (c.t === 'choice') {
      const text = c.selected;
      const map = de.items && de.items[f.id];
      if (map && Object.prototype.hasOwnProperty.call(map, text) && map[text] !== null) raw[f.id] = String(map[text]);
      else {
        const o = (f.options || []).find((x) => (x && typeof x === 'object' ? String(x.label !== undefined ? x.label : x.value) === text || String(x.value) === text : String(x) === text));
        if (o !== undefined) raw[f.id] = String(o && typeof o === 'object' ? o.value : o);
      }
    }
  }
  return raw;
}
function collect(t, spec, raw) {
  const P = t.IJViewPure;
  const hidden = new Set();
  for (let pass = 0; pass < 2; pass++) {
    const r0 = P.collectFields(spec.fields, raw, { hidden });
    for (const f of spec.fields) if (f && f.visibleIf) { if (f.visibleIf(r0.values)) hidden.delete(f.id); else hidden.add(f.id); }
  }
  const r = P.collectFields(spec.fields, raw, { hidden });
  return r.ok ? r.values : null;
}

/** The stand-in Ctx of EXTRAS.md §4.1 (used only for the records the page does not emit yet). */
function standInCtx(t, api) {
  const st = api.state();
  const d = st.doc;
  const col = api.colors && typeof api.colors.get === 'function' ? api.colors.get() : { foreground: [255, 255, 255], background: [0, 0, 0], selection: [255, 255, 0] };
  const nSlices = d ? (d.nZ || 1) * (d.nT || 1) * (d.rgb ? 1 : Math.max(1, (d.channels || []).length)) : null;
  return { docId: d ? d.docId : null, title: d ? d.name : null, bitDepth: d ? (d.rgb ? 24 : d.bitDepth) : null, nSlices, nC: d ? (d.channels || []).length : null,
    roi: st.roi || null, fg: col.foreground, bg: col.background, sel: col.selection, blackBackground: t.settings.get('thr.blackBackground') !== false };
}

/**
 * Wires a model to the page: the real `command` / `action` events when ij-app.js emits them, else this test's stand-in records.
 * → { model, command(id, values, o), roi(roi, action), activate(docId), action(rec), counts }
 */
function operator(t, model) {
  const api = t.api('edit');
  const counts = { cmd: 0, act: 0, real: false };
  try {
    api.on('command', (r) => { if (r.phase === 'end') { counts.cmd++; counts.lastEnd = r; } model.onCommand(r); });
    api.on('action', (r) => { counts.act++; model.onAction(r); });
    counts.real = true;
  } catch (_) { counts.real = false; }
  let sseq = 1e6;
  return {
    model, counts, api,
    /** a menu command answered with `values` (one object per dialog, or a function(spec) → values) */
    async command(id, values, o) {
      const list = Array.isArray(values) ? values : (values === undefined ? [] : [values]);
      const captured = [];
      const answers = [];
      for (let i = 0; i < 8; i++) {
        const v = list[i];
        answers.push((spec) => {
          if (v === null) { captured.push({ spec, values: null }); return null; }
          const raw = typeof v === 'function' ? v(spec) : (() => {
            const r = {};
            for (const f of spec.fields || []) if (f && f.type !== 'message') r[f.id] = f.type === 'check' ? !!f.value : (f.value === undefined || f.value === null ? '' : String(f.value));
            for (const k of Object.keys(v || {})) r[k] = typeof v[k] === 'boolean' ? v[k] : String(v[k]);
            return r;
          })();
          const vals = collect(t, spec, raw);
          captured.push({ spec, values: vals });
          return vals;
        });
      }
      const asks0 = t.script.asks.length;
      const before = standInCtx(t, api);
      const ids0 = new Set((await t.docs()).map((d) => d.docId));
      const c0 = counts.cmd;
      const errs = await t.runCommand(id, answers, Object.assign({ source: 'menu' }, o || {}));
      if (counts.cmd === c0) {
        const entry = T[id] || null;
        const steps = [];
        let ci = 0;
        for (const cap of captured) {
          const fields = (cap.spec.fields || []).filter(Boolean);
          steps.push({ kind: 'dialog', index: ci, title: cap.spec.title || null, fields, offered: {}, values: cap.values, entry: entry ? C.IJMacroCmds.pickDialog(entry, ci, fields) : null });
          ci++;
        }
        for (const a of t.script.asks.slice(asks0)) if (a && a.title === EN.dlg.processStack) steps.push({ kind: 'stack', answer: 'all' });
        const created = (await t.docs()).map((d) => d.docId).filter((x) => !ids0.has(x));
        const head = { seq: ++sseq, id, name: C.IJMacroCmds.nameOf(id), cls: entry ? entry.cls : null, source: 'menu', duringMacro: false };
        model.onCommand(Object.assign({ phase: 'start' }, head));
        model.onCommand(Object.assign({ phase: 'end' }, head, { status: captured.some((x) => x.values === null) ? 'cancelled' : 'ok', steps, file: null, before,
          after: standInCtx(t, api), created, closed: [] }));
      }
      return { captured, errs };
    },
    async roi(roi, action) {
      const a0 = counts.act;
      const st = api.state();
      t.shell.opts.onRoi(roi, { final: true, source: action || 'draw', docId: st.doc.docId });
      await sleep(5);
      if (counts.act === a0) model.onAction({ kind: 'roi', action: action || 'draw', tool: roi ? roi.type : null, roi, wand: null, combine: null, duringMacro: false, docId: st.doc.docId, ctx: standInCtx(t, api) });
    },
    async activate(docId, title) {
      const a0 = counts.act;
      t.shell.clickTab(docId);
      await until(() => api.state().doc && api.state().doc.docId === docId, 'activation');
      await sleep(5);
      if (counts.act === a0) model.onAction({ kind: 'activate', title, duringMacro: false, docId, ctx: standInCtx(t, api) });
    },
    /** an action record this test feeds itself when the page did not emit one of `kind` since `from` */
    standIn(kind, rec, from) {
      if (counts.act > from) return false;
      model.onAction(Object.assign({ kind, duringMacro: false, docId: api.state().doc ? api.state().doc.docId : null, ctx: standInCtx(t, api) }, rec));
      return true;
    }
  };
}
async function closeAll(t, api) {
  for (const d of await t.docs()) { t.script.nextAsk = 'discard'; try { await api.closeDoc(d.docId); } catch (_) { /* gone */ } t.script.nextAsk = null; }
}
const unquote = (s) => s.replace(/\\(n|\\|"|[0-7]{3})/g, (m, e) => (e === 'n' ? '\n' : e === '\\' || e === '"' ? e : String.fromCharCode(parseInt(e, 8))));
/** the options of a run("name", "options"); line: null for run("name"); undefined when it is not that command's run() line */
function optionsOfLine(lineText, name) {
  const pre = 'run("' + name.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
  if (!lineText.startsWith(pre)) return undefined;
  const rest = lineText.slice(pre.length);
  if (rest === ');') return null;
  if (!rest.startsWith(', "') || !rest.endsWith('");')) return undefined;
  return rest.slice(3, -3).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
}

// ═══════════════════════════════════════ 4. (a) the `recorded` sweep ═══════════════════════════════════════

// Commands whose line cannot equal ImageJ's for ImageJ's own default values, with the reason (EXTRAS.md §4.6 asks for the list).
const SWEEP_EXCEPTIONS = {
  // an artefact of the capture: the jar's Prefs held no Math macro, so the default Code: was empty, "v=" stopped with a macro error and
  // the NonBlockingGenericDialog's options were reset by its dialog listener (GenericDialog.notifyListeners → Recorder.resetCommandOptions)
  // before the error: ImageJ wrote run("Macro..."). The Studio's default code is ImageMath's DEFAULT ("v=v+50*sin(d/10)"); the sweep's
  // empty value fails the same way but records the dialog's code=[] (the e2e test checks a real code's line).
  'Macro...': 'capture artefact: empty default code, macro error'
};
// Lines that differ today for a reason outside the Recorder (the fields a Studio dialog has, the run() table's keys / smart rules / decimals in
// ij-macro-cmds.js): each is a change request in the REC report. The test fails on any OTHER difference, and says when one of these matches.
const SWEEP_KNOWN = {
  'Z Project...': 'the Studio names the projection after its own source ("<dataset> Z a–b (Average Intensity)"), ImageJ AVG_<title>: the selectImage line carries that title',
  'Properties... ': 'ImageJ\'s ROI Properties dialog leaves no options; the Studio\'s dialog folds a blank',
  'Make Band...': 'ImageJ\'s captured line has no options; the Studio writes band=15',
  'Appearance...': 'the Studio\'s Appearance dialog lacks ImageJ\'s menu / gui / 16-bit fields',
  'Misc...': 'the Studio\'s Misc dialog lacks ImageJ\'s "Run single instance listener" check',
  'Input/Output...': 'the Studio\'s Input/Output dialog lacks jpeg / gif / use_file',
  'Plots...': 'the Studio\'s Plots dialog lacks width / height / font / draw_ticks',
  'Size...': 'the Studio\'s Size dialog has no Depth field on a single image (ImageJ always shows it)',
  'Properties...': 'the Studio\'s Properties fields have no decimals 4 (pixel_width=1.0000) and add unit / frame interval, which ImageJ leaves out',
  'Concatenate...': 'ImageJ reads "open" first and has no "-- None --" image3: the Studio\'s field order / items differ',
  'Make Binary': 'the Studio shows no Convert Stack to Binary dialog on an unthresholded stack',
  'Distribution...': 'Distribution\'s smart recording of or= / and= at their defaults is not in the table'
};

await test('(a) recorded sweep: the Studio\'s line for ImageJ\'s default values equals the captured Recorder line', async () => {
  const IJD = fixture('ij-dialogs.json');
  if (!IJD) { console.log('  SKIP ij-dialogs.json absent'); return; }
  const t = await boot({ firePreview: false, channels: 1 });
  await t.open();
  const api = t.api('edit');
  const model = R.create();
  model.open();
  const op = operator(t, model);
  const results = { same: 0, differ: [], known: [], fixed: [], notRun: [], excepted: [] };
  const byCap = new Map();
  for (const id of Object.keys(T)) {
    const e = T[id];
    if (e.alias || e.cls === 'E' || e.cls === 'F' || !e.dialogs.length) continue;
    const ijKey = e.dialogs.map((d) => d.ij).find((k) => typeof k === 'string');
    if (!ijKey) continue;
    const cname = ijKey.slice(0, ijKey.lastIndexOf('#'));
    const cap = IJD.commands[cname];
    if (!cap || !(cap.dialogs || []).some((d) => Object.prototype.hasOwnProperty.call(d, 'recorded'))) continue;
    if (!byCap.has(cname)) byCap.set(cname, { id, cap });
  }
  const FALLBACK_INPUTS = [
    { bitDepth: 8, dims: { c: 1, z: 1, t: 1 }, roi: null, binary: true, id: 'binary' },
    { bitDepth: 8, dims: { c: 1, z: 3, t: 1 }, roi: null, binary: false, id: 'stack3' },
    { bitDepth: 8, dims: { c: 2, z: 1, t: 1 }, roi: null, binary: false, id: 'composite2' },
    { bitDepth: 8, dims: { c: 2, z: 3, t: 2 }, roi: null, binary: false, id: 'hyper2x3x2' }
  ];
  for (const [cname, { id, cap }] of byCap) {
    if (SWEEP_EXCEPTIONS[cname]) { results.excepted.push(cname); continue; }
    const c = t.cmd(id);
    if (!c) { results.notRun.push(cname + ' (no Studio command ' + id + ')'); continue; }
    const capInput = cap.input || { bitDepth: 8, dims: { c: 1, z: 1, t: 1 }, roi: 'rect', id: '8bit-rect' };
    const recDialogs = cap.dialogs.filter((d) => d.kind !== 'YesNoCancelDialog');
    let ran = false, len0 = 0;
    const why = [];
    // the capture's own input first; the Studio may need another one (a binary image, a stack) where ImageJ accepted it
    for (const input of [capInput].concat(FALLBACK_INPUTS.filter((x) => x.id !== capInput.id))) {
      await closeAll(t, api);
      await api.addDoc(capImage('other', { bitDepth: 8, dims: { c: 1, z: 1, t: 1 }, id: input.id === 'square256' ? 'square256' : '' }), { placement: 'tab' });
      const docId = await api.addDoc(capImage('capture', input), { placement: 'tab' });
      if (input.roi && CAP_ROIS[input.roi]) api.setRoi(CAP_ROIS[input.roi], { docId });
      let enabled = false;
      try { enabled = !!c.enabled(t.shell.opts.getState()); } catch (_) { enabled = false; }
      if (!enabled) { why.push('disabled on ' + input.id); continue; }
      let k = 0;
      const answer = (spec) => {
        const fields = (spec.fields || []).filter(Boolean);
        const de = C.IJMacroCmds.pickDialog(T[id], k, fields);
        const capD = recDialogs[Math.min(k, recDialogs.length - 1)] || { components: [] };
        k++;
        return imagejRaw(spec, de, capD);
      };
      len0 = model.text().length;
      try {
        await Promise.race([op.command(id, [answer, answer, answer, answer]), new Promise((_, rj) => setTimeout(() => rj(new Error('timeout')), 20000))]);
        ran = true;
        break;
      } catch (err) {
        t.script.dialogs.length = 0;
        if (t.failures.length) t.failures.length = 0;
        why.push(input.id + ': ' + String(err && err.message).split('\n')[0].slice(0, 100));
      }
    }
    if (!ran) { results.notRun.push(cname + ' (' + why.join('; ') + ')'); continue; }
    const added = model.text().slice(len0).split('\n').filter((l) => l.trim() !== '');
    // the activation of the window a command opened follows the command line (P9): the command's own line is the one before it
    const callForm = cap.dialogs.map((d) => d.recordedCall).find((x) => typeof x === 'string');
    const cmdLines = callForm && callForm.startsWith('selectImage(') ? added : added.filter((l, i) => !(i === added.length - 1 && l.startsWith('selectImage(')));
    const last = (cmdLines[cmdLines.length - 1] || '').replace(/ \/\/ Studio only$/, '');
    const withRec = cap.dialogs.filter((d) => Object.prototype.hasOwnProperty.call(d, 'recorded'));
    const expDialog = withRec[withRec.length - 1];
    const call = cap.dialogs.map((d) => d.recordedCall).find((x) => typeof x === 'string');
    let ok;
    let want;
    if (call) { want = call; ok = last === call; }
    else {
      want = expDialog.recorded === null ? 'run("' + cname + '");' : 'run("' + cname + '", "' + expDialog.recorded + '");';
      const got = optionsOfLine(last, cname);
      ok = got !== undefined && got === expDialog.recorded;
    }
    if (ok) { results.same++; if (SWEEP_KNOWN[cname]) results.fixed.push(cname); }
    else if (SWEEP_KNOWN[cname]) results.known.push(cname + ': ' + SWEEP_KNOWN[cname] + '\n        Studio: ' + last + '\n        ImageJ: ' + want);
    else results.differ.push(cname + '\n        Studio: ' + last + '\n        ImageJ: ' + want);
  }
  t.close();
  console.log('  sweep: ' + results.same + ' equal, ' + results.differ.length + ' differ, ' + results.known.length + ' known (outside the Recorder), ' + results.notRun.length
    + ' not run, ' + results.excepted.length + ' excepted (' + results.excepted.join(', ') + ')');
  for (const d of results.differ) console.log('    DIFFER ' + d);
  for (const d of results.known) console.log('    KNOWN ' + d);
  for (const d of results.fixed) console.log('    NOW EQUAL (remove from SWEEP_KNOWN) ' + d);
  for (const n of results.notRun) console.log('    NOT RUN ' + n);
  assert.ok(results.same >= 1, 'the sweep compared nothing');
  assert.equal(results.differ.length, 0, results.differ.length + ' commands record another line than ImageJ (listed above)');
});

// ═══════════════════════════════════════ 5. (b) replay of an operator session ═══════════════════════════════════════

function blobs(w, h, seed) {
  const a = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let v = 30 + ((x * 7 + y * 13 + seed * 5) % 23);
    for (const [cx, cy, r] of [[14, 12, 6], [40, 30, 8], [22, 36, 5], [50, 10, 4]]) if ((x - cx) ** 2 + (y - cy) ** 2 < r * r) v = 200 + ((x + y) % 30);
    a[y * w + x] = v;
  }
  return a;
}
const BW = 64, BH = 48;
async function sessionImages(t) {
  const api = t.api('edit');
  const other = await api.addDoc({ name: 'other', width: BW, height: BH, bitDepth: 8, calibration: { pixelWidth: 1, pixelHeight: 1, unit: 'pixel' }, channels: [{ name: 'C1', data: blobs(BW, BH, 3) }] }, { placement: 'tab' });
  const cells = await api.addDoc({ name: 'cells', width: BW, height: BH, bitDepth: 8, calibration: { pixelWidth: 1, pixelHeight: 1, unit: 'pixel' }, channels: [{ name: 'C1', data: blobs(BW, BH, 0) }] }, { placement: 'tab' });
  return { other, cells };
}
/** What the session leaves: pixels of both images, the active image and its selection, Results, ROI Manager. */
async function stateOf(t) {
  const docs = await t.docs();
  const out = { pixels: {} };
  for (const n of ['cells', 'other']) {
    const d = docs.find((x) => x.name === n);
    out.pixels[n] = d ? Array.from(await t.pixels(d.docId)).join(',') : null;
  }
  const r = await t.runMacro([
    'print("active=" + getTitle());',
    'getSelectionBounds(x, y, w, h); print("sel=" + selectionType() + " " + x + " " + y + " " + w + " " + h);',
    'print("results=" + nResults);',
    'for (i = 0; i < nResults; i++) print("row " + i + ": " + getResult("Area", i) + " " + getResult("Mean", i) + " " + getResult("X", i) + " " + getResult("Y", i));',
    'print("rois=" + roiManager("count"));',
    'for (i = 0; i < roiManager("count"); i++) { roiManager("select", i); getSelectionBounds(x, y, w, h); print("roi " + i + ": " + x + " " + y + " " + w + " " + h); }'
  ].join('\n'));
  assert.equal(r.ok, true, 'state macro ran: ' + JSON.stringify(r.error));
  out.log = t.macroLog().slice(-200);
  return out;
}

await test('(b) a recorded operator session replays as a macro to the same pixels, selection, Results and ROI Manager', async () => {
  if (!fs.existsSync(path.join(DIR, 'ij-cmds-macro.js'))) { console.log('  SKIP ij-cmds-macro.js absent'); return; }
  const t = await boot({ firePreview: false, channels: 1 });
  await t.open();
  const { other } = await sessionImages(t);
  const model = R.create();
  model.open();
  const op = operator(t, model);
  const api = op.api;
  console.log('  page events: ' + (op.counts.real ? 'ij-app.js emits `command` / `action`' : 'stand-in records only'));
  await op.roi({ type: 'rect', x: 8, y: 6, w: 40, h: 30 }, 'draw');
  await op.command('filterGaussian', { sigma: 2 });
  await op.command('editSelectNone');
  // Image › Adjust › Threshold…: the window opens on its automatic range (ThresholdAdjuster records it as setAutoThreshold)
  let a0 = op.counts.act;
  await op.command('adjustThreshold');
  await until(() => api.state().threshold, 'the Threshold window range');
  const thr = api.state().threshold;
  op.standIn('threshold', { op: 'auto', method: 'Default', dark: !!thr.dark, hist16: false, mode: 'red', lower: thr.lower, upper: thr.upper, bitDepth: 8, stack: false }, a0);
  // Apply: the comment line of Thresholder, then Convert to Mask as ThresholdAdjuster.runThresholdCommand records it
  a0 = op.counts.act;
  if (typeof t.thresholdAction === 'function') await t.thresholdAction('apply', {});
  else {
    op.standIn('threshold', { op: 'apply', method: 'Default', dark: !!thr.dark, hist16: false, mode: 'red', lower: thr.lower, upper: thr.upper, bitDepth: 8, stack: false }, a0);
    await op.command('binMask');
  }
  await op.command('analyzeParticles', { display: true, clear: true });
  await op.roi({ type: 'rect', x: 4, y: 4, w: 20, h: 20 }, 'draw');
  a0 = op.counts.act;
  await op.command('editAddToManager');
  op.standIn('rm', { op: 'Add', indices: [], count: 1 }, a0);
  await op.activate(other, 'other');
  await op.command('editInvert');
  await op.roi({ type: 'oval', x: 10, y: 8, w: 30, h: 20 }, 'draw');
  await op.command('analyzeMeasure');
  const text = model.text();
  console.log('  recorded:\n    ' + text.trimEnd().split('\n').join('\n    '));
  for (const want of ['makeRectangle(8, 6, 40, 30);', 'run("Gaussian Blur...", "sigma=2");', 'run("Select None");', '//run("Threshold...");', 'setAutoThreshold("Default',
    'run("Convert to Mask");', 'run("Analyze Particles...", ', 'makeRectangle(4, 4, 20, 20);', 'roiManager("Add");', 'selectImage("other");', 'run("Invert");',
    'makeOval(10, 8, 30, 20);', 'run("Measure");']) assert.ok(text.indexOf(want) >= 0, 'recorded text holds ' + want);
  const opState = await stateOf(t);
  t.close();
  // replay on a fresh boot with the same images
  const t2 = await boot({ firePreview: false, channels: 1 });
  await t2.open();
  await sessionImages(t2);
  const r = await t2.runMacro(text);
  assert.equal(r.ok, true, 'the recorded macro runs: ' + JSON.stringify(r.error));
  const rpState = await stateOf(t2);
  t2.close();
  const tail = (s) => Array.from(s.log, String).filter((l) => /^(active|sel|results|row|rois|roi )/.test(l));
  assert.deepEqual(tail(rpState), tail(opState), 'same active image, selection, Results and ROI Manager');
  assert.equal(rpState.pixels.cells, opState.pixels.cells, 'same pixels of "cells"');
  assert.equal(rpState.pixels.other, opState.pixels.other, 'same pixels of "other"');
  console.log('    ' + tail(opState).join('\n    '));
});

// ═══════════════════════════════════════ 6. (c) the jar's Recorder goldens ═══════════════════════════════════════

// Golden cases whose line depends on what a plugin computes from the image, which the replay (the Recorder alone) cannot know
const GOLDEN_KNOWN = {
  // the Studio's Properties dialog is not ImageJ's (no linked Voxel depth: ImageProperties.textValueChanged copies a changed pixel width
  // into an equal depth; no unit fields, so no Stack.setXUnit line :215); the same dialog is a known line of the (a) sweep
  'cmd-properties-units': 'ImageProperties links the voxel depth to the pixel width and records Stack.setXUnit for a changed unit: the Studio dialog has neither',
  'file-open': 'the jar recorded run("Open...") with no path: its driver could not answer the native Open dialog (no OpenDialog path to record)',
  'cmd-scale-bar': 'ScaleBar computes its default width / height / font from the image width and calibration; the replay only has the captured dialog\'s defaults'
};

await test('(c) recorder-golden.json: every case through the model gives the jar\'s lines', async () => {
  const G = fixture('recorder-golden.json');
  if (!G) { console.log('  SKIP recorder-golden.json absent (CAPTURE)'); return; }
  const IJD = fixture('ij-dialogs.json');

  const kept = {};
  let keptPrev = {};
  let skipped = 0;
  const known = [];
  const ids = Object.keys(G.cases || {});
  let compared = 0;
  const differ = [];
  for (const id of ids) {
    const cs = G.cases[id];
    if (cs.driverError) { skipped++; console.log('  SKIP golden case ' + id + ': the jar could not be driven (' + cs.driverError + ')'); continue; }
    const m = R.create();
    m.open();
    const settings = (cs.setup && cs.setup.settings) || {};
    const images = ((cs.setup && cs.setup.images) || []).slice();
    let current = (cs.setup && cs.setup.current) || (images[images.length - 1] && images[images.length - 1].title) || 'img';
    const img = (title) => images.find((x) => x.title === title) || images[images.length - 1] || { bitDepth: 8, z: 1, c: 1, t: 1 };
    const ctx = () => { const i = img(current); return ctxOf({ title: current, bitDepth: i.bitDepth, nSlices: (i.c || 1) * (i.z || 1) * (i.t || 1), nC: i.c || 1,
      fg: settings.foreground || [255, 255, 255], bg: settings.background || [0, 0, 0], blackBackground: !!settings.blackBackground, sel: selRgb }); };
    const NAMED = { yellow: [255, 255, 0], red: [255, 0, 0], green: [0, 255, 0], blue: [0, 0, 255], cyan: [0, 255, 255], magenta: [255, 0, 255], white: [255, 255, 255], black: [0, 0, 0], orange: [255, 200, 0] };
    const selRgb = Array.isArray(settings.selectionColor) ? settings.selectionColor : (NAMED[String(settings.selectionColor || 'yellow').toLowerCase()] || [255, 255, 0]);
    const rois = new Map();
    // the driver resets the Threshold window (method Default, Dark background off) before every case
    const thrState = { method: 'Default', dark: false, lower: null, upper: null };
    // the ROI Manager rows the case's setup.prep added (rmAddRois)
    const rmRois = [];
    const chState = { mode: 'composite', active: null };
    const unmodelled = [];
    let lastCommand = null;
    let pendingMacro = false;
    let rmSel = [];
    const replay = (a) => {
      switch (a.do) {
        case 'tool': {
          // draw = the drag from points[0] to points[1] (or the vertices); move / resize = a drag of the current selection (its inside / the
          // handle under points[0]), as the jar's MouseEvents did
          const p = a.points || [];
          const tool = a.tool;
          const action = a.action || 'draw';
          const prev = rois.get(current) || null;
          let roi = null;
          const box = (x0, y0, x1, y1) => ({ x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) });
          if (action !== 'draw' && prev) {
            const dx = p[1][0] - p[0][0], dy = p[1][1] - p[0][1];
            if (action === 'move') {
              roi = prev.type === 'line' ? Object.assign({}, prev, { x1: prev.x1 + dx, y1: prev.y1 + dy, x2: prev.x2 + dx, y2: prev.y2 + dy })
                : prev.points ? Object.assign({}, prev, { points: prev.points.map((q) => [q[0] + dx, q[1] + dy]) }) : Object.assign({}, prev, { x: prev.x + dx, y: prev.y + dy });
            } else if (prev.type === 'line') {
              const d1 = Math.hypot(p[0][0] - prev.x1, p[0][1] - prev.y1), d2 = Math.hypot(p[0][0] - prev.x2, p[0][1] - prev.y2);
              roi = d1 <= d2 ? Object.assign({}, prev, { x1: p[1][0], y1: p[1][1] }) : Object.assign({}, prev, { x2: p[1][0], y2: p[1][1] });
            } else if (!prev.points) {
              const corners = [[prev.x, prev.y], [prev.x + prev.w, prev.y], [prev.x, prev.y + prev.h], [prev.x + prev.w, prev.y + prev.h]];
              let k = 0;
              for (let i = 1; i < 4; i++) if (Math.hypot(p[0][0] - corners[i][0], p[0][1] - corners[i][1]) < Math.hypot(p[0][0] - corners[k][0], p[0][1] - corners[k][1])) k = i;
              const opp = corners[3 - k];
              roi = Object.assign({ type: prev.type }, box(opp[0], opp[1], p[1][0], p[1][1]));
            } else roi = prev;
          } else if (tool === 'rect' || tool === 'oval') roi = Object.assign({ type: tool }, box(p[0][0], p[0][1], p[1][0], p[1][1]));
          else if (tool === 'line') roi = { type: 'line', x1: p[0][0], y1: p[0][1], x2: p[1][0], y2: p[1][1] };
          else if (tool === 'point' && a.shift && prev && prev.type === 'point') roi = { type: 'point', points: prev.points.concat(p) };
          else roi = { type: ['polygon', 'polyline', 'freehand', 'angle', 'point'].includes(tool) ? tool : 'polygon', points: p };
          rois.set(current, roi);
          m.onAction({ kind: 'roi', action, tool, roi, wand: null, combine: a.shift ? 'add' : null, duringMacro: pendingMacro, ctx: ctx() });
          break;
        }
        case 'wand':
          m.onAction({ kind: 'roi', action: 'draw', tool: 'wand', roi: { type: 'polygon', points: [[0, 0], [1, 0], [1, 1]], traced: true }, wand: { x: a.x, y: a.y, tolerance: a.tolerance, connectivity: a.connectivity }, combine: null, duringMacro: pendingMacro, ctx: ctx() });
          break;
        case 'activate': current = a.title; m.onAction({ kind: 'activate', title: a.title, duringMacro: pendingMacro, ctx: ctx() }); break;
        case 'window': m.onAction({ kind: 'window', title: a.title, duringMacro: pendingMacro, ctx: ctx() }); break;
        case 'chooseTool': m.onAction({ kind: 'tool', tool: a.tool, duringMacro: pendingMacro, ctx: ctx() }); break;
        case 'lineWidth': m.onAction({ kind: 'lineWidth', width: a.width, duringMacro: pendingMacro, ctx: ctx() }); break;
        case 'threshold': thresholdAction(a); break;
        case 'bc': bcAction(a); break;
        case 'rm': {
          const op = a.op === 'OR (Combine)' ? 'OR' : a.op;
          const idx = a.indices || [];
          if (op === 'Select') {
            // the driver clicks the rows one by one (Shift+click adds): RoiManager.valueChanged records each selection
            for (let k = 1; k <= idx.length; k++) m.onAction({ kind: 'rm', op, indices: idx.slice(0, k), count: rmRois.length || 2, duringMacro: pendingMacro, ctx: ctx() });
            const r = rmRois[idx[idx.length - 1]];
            if (r) rois.set(current, r.type === 'oval' || r.type === 'rect' ? { type: r.type, x: r.x, y: r.y, w: r.width, h: r.height } : r);
            rmSel = idx.slice();
            break;
          }
          m.onAction({ kind: 'rm', op, indices: op === 'Deselect' ? [] : (idx.length ? idx : rmSel), name: a.name, count: rmRois.length || 2, duringMacro: pendingMacro, ctx: ctx() });
          if (op === 'Deselect' || op === 'Fill' || op === 'Draw') rmSel = [];
          break;
        }
        case 'rmAddRois': for (const r of a.rois || []) rmRois.push(r); break;
        case 'openWindow': break;
        case 'channels': {
          const nC = img(current).c || 1;
          if (!chState.active) chState.active = new Array(nC).fill(true);
          if (a.op === 'mode') { chState.mode = a.mode; m.onAction({ kind: 'channels', op: 'mode', mode: a.mode, duringMacro: pendingMacro, ctx: ctx() }); }
          else if (a.op === 'active') {
            // Channels.itemStateChanged: a check box toggles the active channels in composite mode, else it picks the channel
            if (chState.mode === 'composite') {
              chState.active[a.channel - 1] = !!a.on;
              m.onAction({ kind: 'channels', op: 'active', active: chState.active.map((x) => (x ? '1' : '0')).join(''), duringMacro: pendingMacro, ctx: ctx() });
            } else m.onAction({ kind: 'channels', op: 'channel', channel: a.channel, duringMacro: pendingMacro, ctx: ctx() });
          } else if (a.op === 'channel') {
            // Channels.itemStateChanged in Color / Grayscale mode: the check box moves to that channel
            if (chState.mode !== 'composite') m.onAction({ kind: 'channels', op: 'channel', channel: a.channel, duringMacro: pendingMacro, ctx: ctx() });
          }
          break;
        }
        case 'macroWait': pendingMacro = true; break;
        case 'command': {
          if (a.name === 'Repeat Command') {
            // Executer.java:36-44: the repeated command is what runs (and is recorded); Repeat itself never is
            // its dialog opens on the values the previous run left (the plugin's statics), answered with the repeat's own values
            if (lastCommand) runCommandAction({ do: 'command', name: lastCommand.name, fieldLabels: a.fieldLabels || {}, values: a.values || {}, stack: a.stack, cancel: a.cancel });
            break;
          }
          runCommandAction(a);
          if (a.name !== 'Undo' && a.name !== 'Close') lastCommand = a;
          break;
        }
        default: unmodelled.push(String(a.do));
      }
    };
    // a command's dialog(s) rebuilt from ImageJ's own captured dialog (tests/fixtures/ij-macro/ij-dialogs.json): each component a field
    // keyed as GenericDialog keys it, at ImageJ's default text, with the case's values set by label (a typed text is recorded as typed)
    function dialogSteps(name, values, cancel, byKey) {
      const capCmd = IJD && IJD.commands[name];
      let capDialogs = capCmd ? (capCmd.dialogs || []).filter((d) => d.kind !== 'YesNoCancelDialog') : [];
      // a dialog ImageJ captured on a stack only (Convert Stack to Binary) is not shown for a single image
      const ci0 = capCmd && capCmd.input && capCmd.input.dims ? capCmd.input.dims : { z: 1, t: 1 };
      const cur = img(current);
      if ((ci0.z || 1) * (ci0.t || 1) > 1 && (cur.z || 1) * (cur.t || 1) === 1) capDialogs = [];
      if (!capDialogs.length) return values && Object.keys(values).length ? null : [];
      const keptHere = kept[name] || (kept[name] = {});
      const steps = [];
      capDialogs.forEach((d, di) => {
        const fields = [], vals = {}, keys = {};
        (d.components || []).forEach((c, ci) => {
          if (c.t === 'message') return;
          const id = 'c' + ci;
          // by label, else by key (a label that depends on the image, "Slice (1-3):", is captured on another stack in ij-dialogs.json)
          const given = values && Object.prototype.hasOwnProperty.call(values, c.label) ? values[c.label]
            : byKey && c.key && Object.prototype.hasOwnProperty.call(byKey, c.key) ? byKey[c.key] : undefined;
          // GenericDialog defaults are the plugin's statics: the value a previous case typed is offered again (as a number, in its format)
          if (given !== undefined && !cancel) keptHere[c.label] = given;
          const before = given === undefined && Object.prototype.hasOwnProperty.call(keptPrev[name] || {}, c.label) ? keptPrev[name][c.label] : undefined;
          if (before !== undefined && (c.t === 'numeric' || c.t === 'slider')) {
            fields.push({ type: 'number', id, label: c.label, value: Number(before), decimals: Number.isInteger(c.decimals) ? c.decimals : undefined });
            vals[id] = Number(before);
            keys[id] = c.key === undefined ? null : c.key;
            return;
          }
          if (before !== undefined && c.t === 'string') {
            fields.push({ type: 'string', id, label: c.label, value: String(before) });
            vals[id] = String(before);
            keys[id] = c.key === undefined ? null : c.key;
            return;
          }
          keys[id] = c.key === undefined ? null : c.key;
          if (c.t === 'checkbox') { fields.push({ type: 'check', id, label: c.label, value: !!c.state }); vals[id] = given === undefined ? !!c.state : given === true || given === 'true'; }
          else if (c.t === 'choice') { fields.push({ type: 'choice', id, label: c.label, value: c.selected, options: (c.items || []).slice() }); vals[id] = given === undefined ? c.selected : String(given); }
          else if ((c.t === 'numeric' || c.t === 'slider') && given === undefined) {
            fields.push({ type: 'number', id, label: c.label, value: Number(c.value), decimals: Number.isInteger(c.decimals) ? c.decimals : undefined });
            vals[id] = Number(c.value);
          } else {
            const dflt = String(c.value === undefined ? '' : c.value);
            fields.push({ type: c.t === 'textarea' ? 'textarea' : 'string', id, label: c.label, value: dflt });
            vals[id] = given === undefined ? dflt : String(given);
          }
        });
        steps.push(dlgStep(fields, cancel && di === 0 ? null : vals, { keys, smart: !!d.smartRecording }, di));
      });
      return cancel ? steps.slice(0, 1) : steps;
    }
    function runCommandAction(a) {
      keptPrev[a.name] = Object.assign({}, kept[a.name] || {});
      // the golden keys `values` by the ImageJ key and keeps the labels the driver typed into in `fieldLabels`
      const byLabel = a.fieldLabels || a.values || {};
      const steps = dialogSteps(a.name, byLabel, !!a.cancel, a.fieldLabels ? a.values : null);
      if (steps === null) { unmodelled.push(a.name + ' (no captured dialog for its values)'); return; }
      if (a.stack) steps.push({ kind: 'stack', answer: a.stack });
      const cid = idOf(a.name);
      const before = ctx();
      // the image a command opens becomes the current one (its title as ImageJ names it)
      const v = Object.assign({}, keptPrev[a.name] || {}, byLabel);
      let made = null;
      if (!a.cancel) {
        if (a.name === 'Duplicate...') made = byLabel['Title:'] !== undefined ? String(byLabel['Title:']) : current + '-1';   // a fresh name each time
        else if (a.name === 'Image...') made = v['Name:'] !== undefined ? String(v['Name:']) : 'Untitled';
        else if (a.name === 'Image Calculator...' && String(v['Create new window'] === undefined ? 'true' : v['Create new window']) === 'true') made = 'Result of ' + String(v['Image1:'] || current);
      }
      if (made !== null) { images.push(Object.assign({}, img(current), { title: made })); current = made; }
      const after = ctx();
      if (made !== null) after.docId = 'new:' + made;
      // a file the jar's driver typed into ImageJ's file dialog: the golden writes its folder as <dir>, here a virtual path of the same shape
      const file = typeof a.file === 'string' ? { op: /^(Open|Import)/.test(a.name) || a.name.endsWith(' ') ? 'open' : 'save', command: a.name, format: null, name: a.file, vpath: '<dir>/' + a.file } : null;
      command(m, a.name, { id: cid || 'x', cls: cid && T[cid] ? T[cid].cls : 'A', steps, status: a.cancel ? 'cancelled' : 'ok', before, after, duringMacro: pendingMacro,
        created: made !== null ? ['new:' + made] : [], file });
    }
    // the Threshold window: its state (method, dark, the range it holds) as ThresholdAdjuster keeps it; a range ImageJ computes itself (the
    // automatic one an Apply converts) is not the Recorder's business: it is read from the jar's own //setThreshold line
    function thresholdAction(a) {
      const bd = img(current).bitDepth;
      const rec = (o) => m.onAction(Object.assign({ kind: 'threshold', method: thrState.method, dark: thrState.dark, hist16: false, mode: 'red', lower: thrState.lower,
        upper: thrState.upper, bitDepth: bd, stack: false, duringMacro: pendingMacro, ctx: ctx() }, o));
      switch (a.op) {
        case 'open': {
          const s0 = ++seq;
          const head = { seq: s0, id: 'adjustThreshold', name: 'Threshold...', cls: 'A', source: 'menu', duringMacro: pendingMacro };
          m.onCommand(Object.assign({ phase: 'start' }, head));
          rec({ op: 'auto' });
          m.onCommand(Object.assign({ phase: 'end' }, head, { status: 'ok', steps: [], file: null, before: ctx(), after: ctx(), created: [], closed: [] }));
          thrState.lower = thrState.upper = null;
          break;
        }
        case 'method': thrState.method = a.method; rec({ op: 'method' }); break;
        case 'dark': thrState.dark = !!a.dark; rec({ op: 'dark' }); break;
        case 'mode': rec({ op: 'mode', mode: { Red: 'red', 'B&W': 'bw', 'Over/Under': 'overunder' }[a.mode] || 'red' }); break;
        case 'set': thrState.lower = Number(a.lower); thrState.upper = Number(a.upper); rec({ op: 'set' }); break;
        case 'auto': thrState.lower = thrState.upper = null; rec({ op: 'auto' }); break;
        case 'reset': thrState.lower = thrState.upper = null; rec({ op: 'reset' }); break;
        case 'apply': {
          // ThresholdAdjuster.apply :829-833: no range on the image → IJ.error("Thresholder", "Threshold is not set"), nothing runs
          if ((cs.unexpectedDialogs || []).some((d) => d && d.text === 'Threshold is not set')) break;
          if (thrState.lower === null) {
            const mm = /\/\/setThreshold\((-?\d+), (-?\d+)\);/.exec(cs.text || '');
            if (mm) { thrState.lower = Number(mm[1]); thrState.upper = Number(mm[2]); }
          }
          rec({ op: 'apply' });
          command(m, 'Convert to Mask', { id: 'binMask', steps: [], source: 'threshold', ctx: ctx(), duringMacro: pendingMacro });
          break;
        }
        default: unmodelled.push('threshold ' + a.op);
      }
    }
    function bcAction(a) {
      const bd = img(current).bitDepth;
      const rec = (o) => m.onAction(Object.assign({ kind: 'bc', bitDepth: bd, scope: null, duringMacro: pendingMacro, ctx: ctx() }, o));
      switch (a.op) {
        case 'open': command(m, 'Brightness/Contrast...', { id: 'adjustBC', ctx: ctx(), duringMacro: pendingMacro }); break;
        case 'set': rec({ op: 'set', min: Number(a.min), max: Number(a.max) }); break;
        case 'reset': case 'auto': case 'apply': rec({ op: a.op }); break;
        default: unmodelled.push('bc ' + a.op);
      }
    }
    // what the driver did before it cleared the Recorder (setup.prep): replayed, then the text is cleared as the driver did
    for (const a of (cs.setup && cs.setup.prep) || []) replay(a);
    m.clear();
    for (const a of cs.actions || []) replay(a);
    compared++;
    const got = m.text().split('\n').filter((l) => l !== '');
    const want = (cs.lines || []).filter((l) => l !== '');
    if (JSON.stringify(got) !== JSON.stringify(want) && GOLDEN_KNOWN[id]) known.push(id + ': ' + GOLDEN_KNOWN[id]);
    else if (JSON.stringify(got) !== JSON.stringify(want)) differ.push(id + ' (' + cs.source + ')' + (unmodelled.length ? ' [not modelled: ' + unmodelled.join(', ') + ']' : '') + '\n      got:  ' + JSON.stringify(got) + '\n      want: ' + JSON.stringify(want));
  }
  console.log('  goldens: ' + compared + ' cases, ' + differ.length + ' differ, ' + known.length + ' known, ' + skipped + ' skipped');
  for (const k of known) console.log('    KNOWN ' + k);
  for (const d of differ) console.log('    DIFFER ' + d);
  assert.equal(differ.length, 0, differ.length + ' golden cases differ (listed above)');
});

console.log(passed + ' passed');
