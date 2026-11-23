// IJMacroParams.scanMacros / installPlan (js/modules/studio/advanced-studio/ij-macro-params.js) against ImageJ 1.54p:
// MacroInstaller.install + addShortcut and Menus.convertShortcutToCode (DOCS/studio-advanced/macros/EXTRAS.md §7.2, §7.3).
// The expected menus, counts and shortcut tables below were produced by the REAL ij.plugin.MacroInstaller of ij-1.54p.jar,
// installing each text into a java.awt.Menu registered as the Plugins › Macros menu (installTools off, AutoRun not started),
// with empty ImageJ shortcut tables. scanMacros is checked against the Studio's own tokenizer (IJMacro.compile).
//
// Run: node tests/js/test_ij_macro_install.mjs        (IJ_JAR=<ij-1.54p.jar> re-reads the jar's macros; default Fiji path)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { ROOT, loadModule } from './harness.mjs';

const FILE = path.join(ROOT, 'js', 'modules', 'studio', 'advanced-studio', 'ij-macro-params.js');
if (!fs.existsSync(FILE)) { console.log('SKIP ij-macro-params.js absent'); process.exit(0); }
const P = loadModule('js/modules/studio/advanced-studio/ij-macro-params.js', 'IJMacroParams');
const IJMacro = loadModule('js/modules/studio/advanced-studio/ij-macro-lang.js', 'IJMacro');
let n = 0;
const J = (x) => JSON.parse(JSON.stringify(x));
// the module lives in its own vm realm: compare plain copies
const deq = (a, b, m) => assert.deepEqual(J(a), J(b), m);
const ok = (name) => { n++; if (process.env.VERBOSE) console.log('  ok   ' + name); };

// ── scanMacros = the MACRO + STRING_CONSTANT pairs of ij.macro.Tokenizer
const sameAsCompile = (src, what) => {
  const mine = P.scanMacros(src);
  deq(mine.map((m) => m.name), IJMacro.compile(src).macros, what + ': names');
  mine.forEach((m, i) => assert.equal(m.index, i, what + ': index'));
  return mine;
};
/** Lines of the MACRO tokens followed by a STRING_CONSTANT, from the Studio's tokenizer. */
const macroLines = (src) => {
  const t = IJMacro.compile(src).tokens, out = [];
  for (let i = 0; i + 1 < t.length; i++) if (t[i].token === IJMacro.K.MACRO && t[i + 1].token === IJMacro.K.STRING_CONSTANT) out.push(t[i].line);
  return out;
};
const CORPUS = [
  ['plain', 'macro "A" { print(1); }\nmacro "B [b]" {}'],
  ['line comments', '// macro "Nope" {}\nmacro "Yes" {} // macro "AlsoNope"\n'],
  ['block comments', '/* macro "X" {}\n\n macro "Y" */ macro "Z" {}\n\n\nmacro "W" {}'],
  ['single quotes', "macro 'Single' { }\nmacro \"Dq\" {}"],
  ['escapes', 'macro "Tab\\there \\"q\\" \\\\ \\101 \\n" {}\nmacro "u\\u0041" {}'],
  ['macro inside strings', 's = "macro \\"Fake\\" {}";\nmacro "Real" {}\nt = \'macro "Fake2"\';'],
  ['unterminated string ends at the line', 'x = "abc\nmacro "After" {}'],
  ['comment between', 'macro /* c */ "Spaced" {}\nmacro // c\n "NextLine" {}'],
  ['not a string', 'macro Foo {}\nmacro ("Paren") {}\nmacro "Ok" {}'],
  ['case', 'Macro "Upper" {}\nMACRO "Caps" {}\nmacro "lower" {}'],
  ['number then e', 'x = 1 e macro "Lost";\nmacro "Kept" {}'],
  ['hex', 'x = 0xFF; macro "AfterHex" {}\ny = 0 macro "AfterZero" {}'],
  ['operators', 'a+=1; b-- ; c==d; e>=f; g<<1; h&&i; j||k; macro "Ops" {}'],
  ['high chars', 'macro "Caf\u00e9 \u4e2d" {}\n\u00e9macro "A" {}\nmacro\u00a0"Nbsp" {}'],
  ['crlf', 'macro "One" {}\r\nmacro "Two" {}\rmacro "Three" {}\n'],
  ['empty', ''],
  ['tools', 'macro "Brush Tool - C000" {}\nmacro "Brush Tool Options" {}\nmacro "AutoRun" {}']
];
for (const [what, src] of CORPUS) {
  sameAsCompile(src, what);
  deq(P.scanMacros(src).map((m) => m.line), macroLines(src), what + ': lines');
  ok('scanMacros ' + what);
}
deq(P.scanMacros('macro "A" {}\n\nmacro "B" {}').map((m) => [m.name, m.line, m.index]), [['A', 1, 0], ['B', 3, 1]]);
deq(P.scanMacros('x = "abc\nmacro "After" {}').map((m) => m.name), ['After'], 'StreamTokenizer: a quote stops at the line end');
deq(P.scanMacros('macro "a\\tb\\101" {}').map((m) => m.name), ['a\tbA'], 'StreamTokenizer escapes (\\t, octal)');
deq(P.scanMacros('macro "u\\u0041" {}').map((m) => m.name), ['uu0041'], '\\u is not an escape of StreamTokenizer');
deq(P.scanMacros('x = 1 e macro "Lost";\nmacro "Kept" {}').map((m) => m.name), ['Kept'],
  'Tokenizer.tryScientificNotation loses the token after a lone e');
ok('scanMacros vectors');

// ── installPlan against the real MacroInstaller (expected values from ij-1.54p.jar, see the header)
const EXPECT = {
  'keys-letters': [['Lower [a]', 'Upper [A]', 'Digit [5]', 'Fkey [f5]', 'F11 [F11]', 'Bad F [F13]', 'Bad F0 [F0]', 'Pad [n7]', 'PadPlus [N+]', 'PadDiv [n/]', 'Both [&3]', 'Long [Ctrl]', 'Empty []', 'Sym [/]', 'Twice [a]', 'FkeyAgain [F5]', 'PadAgain [N7]', 'Nested [x] tail [y]', 'BothLetter [&a]'], 19, 0, 0, null,
    { 51: 'Both [&3]', 53: 'Digit [5]', 65: 'Twice [a]', 107: 'PadPlus [N+]', 265: 'BothLetter [&a]' },
    { 0: 'BothLetter [&a]', 99: 'Both [&3]', 103: 'Pad [n7]', 111: 'PadDiv [n/]', 116: 'Fkey [f5]', 122: 'F11 [F11]' }],
  structure: [['One', '-', { menu: 'Sub', items: ['Child A', 'Child B'] }, { menu: 'Other', items: ['-'] }, 'Dup', 'Dup', '<>Odd'], 12, 1, 2, null, {}, {}],
  'only-autorun.ijm': [['only-autorun'], 1, 0, 1, 'only-autorun', {}, {}],
  'plain.ijm': [['plain'], 1, 0, 0, 'plain', {}, {}],
  '.hidden': [['.hidden'], 1, 0, 0, '.hidden', {}, {}],
  noext: [['noext'], 1, 0, 0, 'noext', {}, {}],
  'only-options.txt': [['only-options'], 1, 0, 0, 'only-options', {}, {}],
  'only-tool.txt': [[], 0, 1, 0, null, {}, {}]
};
const SOURCES = {
  'keys-letters': ['Lower [a]', 'Upper [A]', 'Digit [5]', 'Fkey [f5]', 'F11 [F11]', 'Bad F [F13]', 'Bad F0 [F0]', 'Pad [n7]', 'PadPlus [N+]', 'PadDiv [n/]', 'Both [&3]', 'Long [Ctrl]', 'Empty []', 'Sym [/]', 'Twice [a]', 'FkeyAgain [F5]', 'PadAgain [N7]', 'Nested [x] tail [y]', 'BothLetter [&a]'].map((s) => 'macro "' + s + '" {}').join('\n') + '\n',
  structure: 'macro "AutoRun" { print("a"); }\nmacro "AutoRunAndHide" {}\nmacro "One" {}\nmacro "-" {}\nmacro "<Sub>Child A" {}\nmacro "<Sub> Child B" {}\nmacro "<Other>-" {}\nmacro "Pencil Tool Options" {}\nmacro "Pencil Tool Selected" {}\nmacro "Popup Menu" {}\nmacro "Paint Tool - C000" {}\nmacro "Dup" {}\nmacro "Dup" {}\nmacro "<>Odd" {}\n',
  'only-autorun.ijm': 'macro "AutoRun" { print("a"); }\n',
  'plain.ijm': 'print("hello");\n',
  '.hidden': 'print("x");\n',
  noext: 'print("x");\n',
  'only-options.txt': 'macro "Brush Tool Options" {}\n',
  'only-tool.txt': 'macro "Brush Tool - C000" {}\n'
};
const JAR_EXPECT = {
  'StartupMacros.txt': [[], 0, 4, 0, null, {}, {}],
  'MeasureStack.txt': [['MeasureStack'], 1, 0, 0, 'MeasureStack', {}, {}],
  'Overlay Editing Tools.txt': [[], 0, 5, 0, null, {}, {}],
  'RoiMenuTool.txt': [['Keypad shortcuts for setting default group', 'Group 0 (none) [n0]', 'Group 1 [n1]', 'Group 2 [n2]', 'Group 3 [n3]', 'Group 4 [n4]', 'Group 5 [n5]', 'Group 6 [n6]', 'Group 7 [n7]', 'Group 8 [n8]', 'Group 9 [n9]'], 11, 1, 0, null, {},
    { 96: 'Group 0 (none) [n0]', 97: 'Group 1 [n1]', 98: 'Group 2 [n2]', 99: 'Group 3 [n3]', 100: 'Group 4 [n4]', 101: 'Group 5 [n5]', 102: 'Group 6 [n6]', 103: 'Group 7 [n7]', 104: 'Group 8 [n8]', 105: 'Group 9 [n9]' }],
  'MoveSelection.txt': [['MoveSelection'], 1, 0, 0, 'MoveSelection', {}, {}],
  'CommandFinderTool.txt': [[], 0, 1, 0, null, {}, {}],
  'Label_Tool.txt': [['Label Tool (double click for options) Options'], 1, 1, 0, null, {}, {}],
  'InvertAllLuts.txt': [['InvertAllLuts'], 1, 0, 0, 'InvertAllLuts', {}, {}],
  'TimeStamp.ijm': [['TimeStamp'], 1, 0, 0, 'TimeStamp', {}, {}],
  'DeveloperMenuTool.txt': [[], 0, 1, 0, null, {}, {}],
  'StacksMenuTool.txt': [[], 0, 1, 0, null, {}, {}],
  'SmoothWandTool.txt': [['SmoothWandTool'], 1, 0, 0, 'SmoothWandTool', {}, {}],
  'ShowAllLuts.txt': [['ShowAllLuts'], 1, 0, 0, 'ShowAllLuts', {}, {}],
  'MagicMontageTools.txt': [['Extract Selected Panels', 'Add Panel to Manager [F1]', 'Montage to Stack', 'Selected panels to stack [F2]', 'Crop Montage [F3]', 'Fit Clipboard content into panel [F4]', 'Fill Panel with Clipboard content [F5]', 'Set Montage Layout', 'Change Montage Layout'], 10, 7, 0, null, {},
    { 112: 'Add Panel to Manager [F1]', 113: 'Selected panels to stack [F2]', 114: 'Crop Montage [F3]', 115: 'Fit Clipboard content into panel [F4]', 116: 'Fill Panel with Clipboard content [F5]' }],
  'SprayCanTool.txt': [[], 0, 1, 0, null, {}, {}],
  'AddParticles.txt': [['AddParticles'], 1, 0, 0, 'AddParticles', {}, {}],
  'LUTMenuTool.txt': [[], 0, 1, 0, null, {}, null],
  'FloodFillTool.txt': [[], 0, 1, 0, null, {}, {}],
  'ConvertStackToBinary.txt': [['ConvertStackToBinary'], 1, 0, 0, 'ConvertStackToBinary', {}, {}],
  'Circle_Tool.txt': [[], 0, 1, 0, null, {}, {}],
  'Search.txt': [['Search'], 1, 0, 0, 'Search', {}, {}]
};

/** The Plugins › Macros items a plan produces, in ImageJ's shape (a submenu is placed where its first child appears). */
function menuOf(plan) {
  const out = [], subs = new Map();
  for (const r of plan.rows) {
    if (r.parent === null) { out.push(r.label); continue; }
    if (!subs.has(r.parent)) { const m = { menu: r.parent, items: [] }; subs.set(r.parent, m); out.push(m); }
    subs.get(r.parent).items.push(r.label);
  }
  if (plan.anonymous) out.push(plan.anonymous.name);
  return out;
}
const strKeys = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [String(k), v]));
function compare(name, src, exp) {
  const [items, nMacros, toolCount, autoRuns, anonymous, macroTable, menuTable] = exp;
  const plan = P.installPlan(src, { fileName: name, isMacro: false });
  deq(menuOf(plan), items, name + ': menu');
  assert.equal(plan.count, nMacros, name + ': nMacros');
  assert.equal(plan.toolCount, toolCount, name + ': toolCount');
  assert.equal(plan.autoRun !== null, autoRuns > 0 && name.indexOf('StartupMacros') < 0, name + ': AutoRun');
  assert.equal(plan.anonymous ? plan.anonymous.name : null, anonymous, name + ': anonymous');
  deq(strKeys(plan.keyTables.macro), strKeys(macroTable), name + ': one-character shortcut table');
  if (menuTable) deq(strKeys(plan.keyTables.menu), strKeys(menuTable), name + ': shortcut table');
  return plan;
}
for (const [name, exp] of Object.entries(EXPECT)) { compare(name, SOURCES[name], exp); ok('installPlan ' + name); }

// ── the jar's own macros (re-read when the jar is here; the expectations above stay checked either way)
function readZip(file) {
  const buf = fs.readFileSync(file);
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error('not a zip: ' + file);
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = new Map();
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nlen);
    p += 46 + nlen + xlen + clen;
    if (!/^macros\/[^/]+\.(txt|ijm)$/.test(name)) continue;
    const lstart = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(lstart, lstart + csize);
    out.set(name.slice(7), (method === 8 ? zlib.inflateRawSync(raw) : raw).toString('utf8'));
  }
  return out;
}
const JAR = process.env.IJ_JAR || 'D:/APT/3A/BIOIMAGING/Fiji/jars/ij-1.54p.jar';
if (fs.existsSync(JAR)) {
  const files = readZip(JAR);
  deq([...files.keys()].sort(), Object.keys(JAR_EXPECT).sort(), 'the jar ships the macros the expectations list');
  for (const [name, text] of files) {
    sameAsCompile(text, name);
    deq(P.scanMacros(text).map((m) => m.line), macroLines(text), name + ': lines');
    compare(name, text, JAR_EXPECT[name]);
    ok('jar ' + name);
  }
  console.log('  jar corpus: ' + files.size + ' macro files of ' + path.basename(JAR) + ' re-read');
} else console.log('  jar corpus: ' + JAR + ' not found; checked against the recorded MacroInstaller results only');

// ── Studio rules over ImageJ's (EXTRAS.md §7.3)
{ // ImageJ keys → Studio specs, and the Studio's own key table
  const plan = P.installPlan(SOURCES['keys-letters'], { fileName: 'k.ijm' });
  const keys = Object.fromEntries(plan.rows.filter((r) => r.shortcut).map((r) => [r.name, r.shortcut]));
  deq(keys, { 'Both [&3]': '3', 'Digit [5]': '5', 'Twice [a]': 'a', 'PadPlus [N+]': '+', 'BothLetter [&a]': 'Shift+A',
    'Pad [n7]': '7', 'PadDiv [n/]': '/', 'Fkey [f5]': 'F5', 'F11 [F11]': 'F11' });
  deq(plan.keysInUse, ['FkeyAgain [F5]', 'PadAgain [N7]'], "ImageJ's \"already in use\" names");
  assert.equal(plan.rows.find((r) => r.name === 'Long [Ctrl]').keySpec, null);
  assert.equal(plan.rows.find((r) => r.name === 'Fkey [f5]').keySpec, 'F5', 'a key of more than one character is upper-cased');
  ok('Studio key specs');
}
{ // taken / reserved by the Studio
  const use = (spec) => ({ taken: spec === 'h' || spec === 'F1', by: spec === 'h' ? 'analyzeHistogram' : null, reserved: spec === 'F5' || spec === 'F11' });
  const src = 'macro "Hello [h]" {}\nmacro "Help [F1]" {}\nmacro "Reload [F5]" {}\nmacro "Free [j]" {}\nmacro "Up [U]" {}\n';
  const plan = P.installPlan(src, { fileName: 'x.ijm', shortcutUse: use });
  deq(plan.rows.map((r) => r.shortcut), [null, null, null, 'j', 'Shift+U']);
  deq(plan.keysInUse, ['Hello [h]', 'Help [F1]']);
  deq(plan.keysReserved, [{ name: 'Reload [F5]', key: 'F5' }]);
  ok('taken / reserved keys');
}
{ // a keypad key and its main key are one browser key: the one-character table (read first by ImageJ.keyPressed) keeps it
  const plan = P.installPlan('macro "Main [1]" {}\nmacro "Pad [n1]" {}\n', { fileName: 'x.ijm' });
  deq(plan.rows.map((r) => r.shortcut), ['1', null]);
  deq(plan.keysInUse, ['Pad [n1]']);
  deq(strKeys(plan.keyTables.macro), { 49: 'Main [1]' });
  deq(strKeys(plan.keyTables.menu), { 97: 'Pad [n1]' });
  ok('keypad and main key');
}
{ // one-character keys: the later entry takes the key (hashtable put), silently
  const plan = P.installPlan('macro "First [q]" {}\nmacro "Second [q]" {}\n', { fileName: 'x.ijm' });
  deq(plan.rows.map((r) => r.shortcut), [null, 'q']);
  deq(plan.keysInUse, []);
  ok('one-character precedence');
}
{ // AutoRun, notices, rows
  const plan = P.installPlan(SOURCES.structure, { fileName: 'set.ijm' });
  assert.equal(plan.autoRun, 0, 'the first AutoRun entry');
  deq(plan.notices, [{ key: 'dlg.mac.install.toolsSkipped', params: { n: 1 } }, { key: 'dlg.mac.install.popupSkipped', params: {} }]);
  const sub = plan.rows.filter((r) => r.parent === 'Sub');
  deq(sub.map((r) => [r.child, r.label, r.kind]), [['Child A', 'Child A', 'menu'], ['Child B', 'Child B', 'menu']]);
  assert.equal(plan.rows.find((r) => r.parent === 'Other').kind, 'separator');
  assert.equal(plan.rows.find((r) => r.name === '-').kind, 'separator');
  const dups = plan.rows.filter((r) => r.name === 'Dup');
  deq(dups.map((r) => r.index), [11, 11], 'MacroInstaller.runMacro finds the first entry of a name');
  deq(dups.map((r) => r.entry), [11, 12]);
  assert.equal(P.installPlan(SOURCES.structure, { fileName: 'set.ijm', isMacro: true }).autoRun, null, 'no AutoRun from a macro (IJ.isMacro)');
  assert.equal(P.installPlan(SOURCES.structure, { fileName: 'StartupMacros.ijm' }).autoRun, null, 'openingStartupMacrosInEditor');
  assert.equal(P.installPlan(SOURCES.structure, { fileName: null }).autoRun, 0, 'the Studio startup set (no file name) keeps its AutoRun');
  assert.equal(P.installPlan('print(1);', { fileName: null }).anonymous, null, 'no anonymous row without a file name');
  assert.equal(P.installPlan('', { fileName: 'e.ijm' }).anonymous, null, 'no anonymous row for an empty text');
  ok('installPlan structure');
}

// ── security: no network, no code construction in the file
const text = fs.readFileSync(FILE, 'utf8');
for (const w of ['fetch(', 'XMLHttpRequest', 'sendBeacon', 'WebSocket', 'EventSource', 'importScripts', 'new Worker', 'window.open', 'location', 'eval(', 'new Function', 'WebAssembly', 'indexedDB', 'document.'])
  assert.ok(text.indexOf(w) < 0, 'ij-macro-params.js uses ' + w);
ok('no network');

console.log('test_ij_macro_install: ' + n + ' checks passed');
