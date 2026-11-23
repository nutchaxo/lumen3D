// The run() file commands of the Advanced Studio's macros (DOCS/studio-advanced/macros/FILES.md §9): every row of the §9.2 table resolves
// to its class F entry or FILE_NAMES spec with ImageJ 1.54p's dialog title, fileRequest reads the path the way OpenDialog / SaveDialog /
// DirectoryChooser do in macro mode, the refusals of §9.1, no `later` left, and every op is one of IJMacroProto.FILE_OPS (and back).
// The option keys were checked on the real jar by tools/ij_fixtures/macro/FileCmdProbe.java (run_filecmd.sh): save= and path= write
// through every save command, open= / path= / open=[] path=… read through Open..., Text Image... , LUT... , Results... , run= / path=
// run a macro file.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT } from './harness.mjs';
import { loadCmds } from './ij_macro_cmds_support.mjs';

const L = loadCmds();
if (!L) { console.log('SKIP ij-macro-cmds.js absent'); process.exit(0); }
const { IJMacroCmds: C, IJMacroOptions: O } = L;
const T = C.MACRO_COMMANDS;
const J = (x) => JSON.parse(JSON.stringify(x));
const DIR = path.join(ROOT, 'js', 'modules', 'studio', 'advanced-studio');

// ── §9.2: [Studio id | null (FILE_NAMES), ImageJ name, op, dialog kind, dialog title]
const ROWS = [
  ['fileOpen', 'Open...', 'open', 'open', 'Open'],
  ['fileSaveTiff', 'Tiff...', 'saveTiff', 'save', 'Save as TIFF'],
  ['fileSaveJpeg', 'Jpeg...', 'saveJpeg', 'save', 'Save as JPEG'],
  ['fileSavePng', 'PNG...', 'savePng', 'save', 'Save as PNG'],
  ['fileSaveResults', 'Results...', 'saveResults', 'save', 'Save as Text'],
  ['fileImportTextImage', 'Text Image... ', 'importTextImage', 'open', 'Open Text Image...'],
  ['fileSaveTextImage', 'Text Image...', 'saveTextImage', 'save', 'Save as Text'],
  ['fileSaveSelection', 'Selection...', 'saveSelection', 'save', 'Save Selection...'],
  ['fileSaveXY', 'XY Coordinates...', 'saveXY', 'save', 'Save Coordinates as Text...'],
  ['fileImportLut', 'LUT... ', 'importLut', 'open', 'Open LUT...'],
  ['fileSaveLut', 'LUT...', 'saveLut', 'save', 'Save as LUT'],
  ['toolsSaveXY', 'Save XY Coordinates...', 'saveXYCoordinates', 'save', 'Save Coordinates as Text...'],
  ['fileImportResults', 'Results... ', 'importResults', 'open', 'Open Table'],
  ['macRun', 'Run...', 'runMacro', 'open', 'Run Macro or Script...'],
  // the macro extras (EXTRAS.md §4.3): MacroInstaller's OpenDialog, and BatchProcessor whose folders are not GenericDialog fields (kind none)
  ['macInstall', 'Install...', 'install', 'open', 'Install Macros'],
  ['batchMacro', 'Macro... ', 'batchMacro', 'none', 'Batch Process'],
  [null, 'Save', 'save', 'save', 'Save as TIFF'],
  [null, 'Table... ', 'importTable', 'open', 'Open Table...'],
  [null, 'Text...', 'saveText', 'save', 'Save as Text'],
  [null, 'ZIP...', 'saveZip', 'save', 'Save as TIFF/ZIP'],
  [null, 'Raw Data...', 'saveRaw', 'save', 'Save as Raw'],
  // File › Import commands with no Studio command (integration: the file corpus runs them)
  [null, 'Text File... ', 'importTextFile', 'open', 'Open Text File...'],
  [null, 'XY Coordinates... ', 'importXY', 'open', 'Open Text Image...'],
  [null, 'Raw...', 'importRaw', 'open', 'Open Raw...']
];
// the option key ImageJ's dialog reads (Macro.trimKey of its title), from the jar probe
const KEY = { Open: 'open', 'Open Text Image...': 'open', 'Open LUT...': 'open', 'Open Table': 'open', 'Open Table...': 'open', 'Run Macro or Script...': 'run', 'Open Text File...': 'open', 'Open Raw...': 'open', 'Install Macros': 'install', 'Batch Process': 'batch' };
const ops = new Set();
for (const [id, name, op, kind, title] of ROWS) {
  const r = J(C.resolve(name));
  assert.ok(r, name + ' resolves');
  let spec;
  if (id) {
    assert.equal(r.id, id, name);
    assert.equal(r.entry.cls, 'F', name + ' is class F');
    assert.equal(r.entry.name, name);
    assert.deepEqual(r.entry.dialogs, [], name + ' has no dialog table');
    assert.equal(r.entry.refuse, undefined);
    spec = r.entry.file;
    assert.equal(C.nameOf(id), name);
  } else {
    assert.equal(r.name, name);
    assert.equal(r.id, undefined, name + ' has no Studio command');
    spec = r.file;
    assert.ok(C.FILE_NAMES.some((f) => f.name === name), name + ' in FILE_NAMES');
  }
  assert.equal(spec.op, op, name + ' op');
  assert.equal(spec.dialog.kind, kind, name + ' kind');
  assert.equal(spec.dialog.title, title, name + ' title');
  assert.equal(C.fileRequest(spec, null).key, KEY[title] || 'save', name + ' key');
  ops.add(op);
}
assert.deepEqual(J(C.FILE_NAMES).map((f) => f.name).sort(), ['Raw Data...', 'Raw...', 'Save', 'Table... ', 'Text File... ', 'Text...', 'XY Coordinates... ', 'ZIP...']);
assert.deepEqual(Object.keys(T).filter((id) => T[id].cls === 'F').sort(), ROWS.filter((r) => r[0]).map((r) => r[0]).sort(), 'class F = the §9.2 Studio rows');
assert.ok(Object.isFrozen(C.FILE_NAMES) && C.FILE_NAMES.every((f) => Object.isFrozen(f) && Object.isFrozen(f.file) && Object.isFrozen(f.file.dialog)));
assert.ok(Object.isFrozen(T.toolsSaveXY.file.extra) && Object.isFrozen(T.toolsSaveXY.file.extra.background));
assert.equal(C.resolve('Measurements...').id, 'fileImportResults', 'IJ.convert: Measurements... → Results... ');
assert.equal(C.resolve('Results').id, 'windowResults', 'Window › Results is not the file command');
assert.equal(C.resolve('Open').id, 'binOpen', 'Process › Binary › Open is not Open...');
assert.equal(C.resolve('save'), null, 'no case folding');
assert.equal(C.resolve('Table...'), null, 'File › New › Table... is no Studio command');
assert.equal(C.resolve('New... '), null, 'IJ.convert: New...  → Table... (File › New), not the import');

// ── the toolsSaveXY extras (XYCoordinates.run 1.54p: "Background value:", "Invert y coordinates off…", "Suppress Log output",
// "Process all N images")
assert.deepEqual(J(T.toolsSaveXY.file.extra), { background: { key: 'background', type: 'number' }, invert: { key: 'invert', type: 'check' },
  suppress: { key: 'suppress', type: 'check' }, process: { key: 'process', type: 'check' } });
assert.equal(T.toolsSaveXY.file.gdTitle, 'Save XY Coordinates');
assert.deepEqual(J(O.keyOf(['Background value:', 'Invert y coordinates off (0 at top of image)', 'Suppress Log output', 'Process all 3 images'])),
  ['background', 'invert', 'suppress', 'process'], 'the extras keys are GenericDialog\'s');

// ── fileRequest: the path rules
const N = O.normalize;
const req = (spec, opts, ctx) => J(C.fileRequest(spec, opts === null ? null : N(opts), ctx));
const OPEN = T.fileOpen.file, TIFF = T.fileSaveTiff.file, RUN = T.macRun.file;
assert.deepEqual(req(OPEN, 'open=/R/a.tif'), { op: 'open', key: 'open', pathText: '/R/a.tif', values: {} });
assert.equal(req(OPEN, 'path=/R/a.tif').pathText, '/R/a.tif', 'OpenDialog: path= when the title key is absent');
assert.equal(req(OPEN, 'open=[] path=[/R/a b.tif]').pathText, '/R/a b.tif', 'OpenDialog: path= when the title key is empty');
assert.equal(req(OPEN, 'open=[]').pathText, null, 'OpenDialog: an empty path shows the dialog');
assert.equal(req(OPEN, 'open=/R/a.tif path=/R/b.tif').pathText, '/R/a.tif', 'the title key wins');
assert.equal(req(OPEN, 'open=[/R/a b.tif]').pathText, '/R/a b.tif', 'brackets');
assert.equal(req(OPEN, "open='/R/a b.tif'").pathText, '/R/a b.tif', 'quotes');
assert.equal(req(OPEN, 'open=[/R/x[1].tif]').pathText, '/R/x[1].tif', 'nested brackets');
assert.equal(req(OPEN, 'reopen=/R/a.tif').pathText, null, 'the key is not preceded by a letter');
assert.equal(req(OPEN, '_open=/R/a.tif').pathText, '/R/a.tif', 'a non-letter before the key is accepted (Macro.getValue)');
assert.equal(req(OPEN, 'open=&p').pathText, '&p', 'the variable step is the runtime\'s');
assert.equal(req(OPEN, 'open=C:\\data\\a.tif').pathText, 'C:\\data\\a.tif', 'separators are the runtime\'s (normalizeSeparators)');
assert.equal(req(OPEN, null).pathText, null, 'no options: the dialog');
assert.equal(J(C.fileRequest(OPEN, undefined)).pathText, null);
assert.equal(req(TIFF, 'save=/R/o.tif').pathText, '/R/o.tif');
assert.equal(req(TIFF, 'path=/R/o.tif').pathText, '/R/o.tif', 'SaveDialog.isMacro: path= when the title key is absent');
assert.equal(req(TIFF, 'save=[] path=/R/o.tif').pathText, '', 'SaveDialog has no empty test: an empty save= is kept');
assert.equal(req(TIFF, 'open=/R/o.tif').pathText, null, 'a save command does not read open=');
assert.equal(req(TIFF, null).pathText, null);
assert.equal(req(RUN, 'run=/R/m.ijm').pathText, '/R/m.ijm');
assert.equal(req(RUN, 'path=/R/m.ijm').pathText, '/R/m.ijm');
assert.equal(req(RUN, 'open=/R/m.ijm').pathText, null, 'Run... reads run=');
// OpenDialog's "Open As String" fallback key, and the DirectoryChooser kind
const OAS = { op: 'open', dialog: { kind: 'open', title: 'Open As String' } };
assert.equal(req(OAS, 'openasstring=/R/a.txt').pathText, '/R/a.txt', 'OpenAsString (trimKey lowercases it)');
assert.equal(req(OAS, 'open=[] path=[] openasstring=/R/a.txt').pathText, '/R/a.txt');
assert.equal(req(OAS, 'open=/R/b.txt openasstring=/R/a.txt').pathText, '/R/b.txt');
assert.equal(req(OPEN, 'openasstring=/R/a.txt').pathText, null, 'only for the title "Open As String"');
const DIRS = { op: 'x', dialog: { kind: 'dir', title: 'Choose a Directory' } };
assert.deepEqual(req(DIRS, 'choose=/R/'), { op: 'x', key: 'choose', pathText: '/R/', values: {} });
assert.equal(req(DIRS, 'choose=[]').pathText, '', 'DirectoryChooser keeps an empty value');
assert.equal(req(DIRS, 'path=/R/').pathText, null, 'DirectoryChooser has no path= fallback');

// ── fileRequest: the extras (GenericDialog's macro mode)
const SXY = T.toolsSaveXY.file;
assert.deepEqual(req(SXY, 'background=0 suppress save=/R/xy.txt'),
  { op: 'saveXYCoordinates', key: 'save', pathText: '/R/xy.txt', values: { background: 0, invert: false, suppress: true, process: false } });
assert.deepEqual(req(SXY, 'save=/R/xy.txt').values, { background: null, invert: false, suppress: false, process: false }, 'an absent number keeps the default');
assert.deepEqual(req(SXY, null).values, { background: null, invert: null, suppress: null, process: null }, 'no options: every extra unknown');
assert.equal(req(SXY, 'background=0x10 save=a.txt').values.background, 16, 'hex');
assert.ok(Number.isNaN(C.fileRequest(SXY, N('background=NaN save=a.txt')).values.background), 'NaN');
assert.equal(req(SXY, 'background=bg save=a.txt', { vars: { bg: { n: 7, s: '7' } } }).values.background, 7, 'a variable name');
assert.equal(req(SXY, 'background=&bg save=a.txt', { vars: { bg: { n: 3 } } }).values.background, 3, '&variable');
const bad = req(SXY, 'background=x save=a.txt');
assert.equal(bad.values.background, null);
assert.equal(bad.error, 'Numeric value expected in run() function\n \n\t Dialog box title: "Save XY Coordinates"\n\t Key: "background"\n\t Value or variable name: "x"');
assert.equal(req(SXY, 'background=1 save=a.txt').error, undefined);
assert.equal(req(SXY, 'background=0 invert process save=[a b.txt]').values.invert, true);
assert.equal(req(SXY, 'background=0 save=[invert.txt]').values.invert, false, 'a word inside a bracketed literal is no checkbox');
const CHO = { op: 'x', dialog: { kind: 'save', title: 'Save' }, extra: { mode: { key: 'mode', type: 'choice', items: ['A', 'B'] }, label: { key: 'label', type: 'string' } } };
assert.deepEqual(req(CHO, 'mode=B label=[x y]').values, { mode: 'B', label: 'x y' });
assert.equal(req(CHO, 'mode=C').error, '"C" is not a valid choice for "mode"');
assert.equal(req(CHO, 'label=&v', { vars: { v: { s: 'hello' } } }).values.label, 'hello');

// ── IJ.saveAs's format table (IJ.java 1.54p saveAs / updateExtension / saveAsTiff), FILES.md §8.6
const R0 = (n) => J(C.resolve(n));
const UE = (p, e) => C.updateExtension(p, e);
assert.equal(UE('/R/a.1', '.tif'), '/R/a.1.tif', 'a digit after the dot: appended');
assert.equal(UE('/R/b.jpeg', '.png'), '/R/b.png');
assert.equal(UE('/R/b', '.png'), '/R/b.png');
assert.equal(UE('/R/b.longext', '.png'), '/R/b.longext.png', 'an extension longer than 4 characters is kept');
assert.equal(UE('/R.dir/b', '.png'), '/R.dir/b.png', 'a dot in a folder name is no extension');
assert.equal(UE('/R/b.', '.png'), '/R/b.png');
assert.equal(UE(null, '.png'), null);
const SA = (f, p) => J(C.saveAsPlan(f, p));
assert.deepEqual(SA('Tiff', '/R/a.1'), { op: 'saveTiff', path: '/R/a.1.tif' });
assert.deepEqual(SA('tif', '/R/a.tiff'), { op: 'saveTiff', path: '/R/a.tiff' }, '.tiff kept');
assert.deepEqual(SA('TIFF', '/R/a.png'), { op: 'saveTiff', path: '/R/a.tif' });
assert.deepEqual(SA('tiff', ''), { op: 'saveTiff', path: null }, 'an empty path is the dialog');
assert.deepEqual(SA('tiff virtual stack', null), { op: 'saveTiff', path: null }, 'indexOf, not equality');
assert.deepEqual(SA('Jpeg', '/R/a.tif'), { op: 'saveJpeg', path: '/R/a.jpg' });
assert.deepEqual(SA('jpg', '/R/a'), { op: 'saveJpeg', path: '/R/a.jpg' });
assert.deepEqual(SA('gif', '/R/a.tif'), { refuse: { key: 'err.macSaveFormat', params: { format: 'gif' } }, path: '/R/a.gif' });
assert.deepEqual(SA('Text Image', '/R/a.CSV'), { command: 'Text Image...', path: '/R/a.csv', options: 'save=/R/a.csv' }, '.CSV keeps a .csv extension');
assert.deepEqual(SA('text image', '/R/a.tif'), { command: 'Text Image...', path: '/R/a.txt', options: 'save=/R/a.txt' });
assert.deepEqual(SA('Text', '/R/log.csv'), { command: 'Text...', path: '/R/log.csv', options: 'save=/R/log.csv' });
assert.deepEqual(SA('txt', '/R/log'), { command: 'Text...', path: '/R/log.txt', options: 'save=/R/log.txt' });
assert.deepEqual(SA('ZIP', '/R/a b.tif'), { command: 'ZIP...', path: '/R/a b.zip', options: 'save=[/R/a b.zip]' }, 'a space: brackets');
assert.deepEqual(SA('raw', '/R/a.tif'), { command: 'Raw Data...', path: '/R/a.tif', options: 'save=/R/a.tif' }, 'raw keeps the path (updateExtension commented out in 1.54p)');
assert.deepEqual(SA('PNG', '/R/b.jpeg'), { command: 'PNG...', path: '/R/b.png', options: 'save=/R/b.png' });
assert.deepEqual(SA('lut', '/R/l'), { command: 'LUT...', path: '/R/l.lut', options: 'save=/R/l.lut' });
for (const f of ['Results', 'measurements', 'Table']) assert.deepEqual(SA(f, '/R/r.csv'), { command: 'Results...', path: '/R/r.csv', options: 'save=/R/r.csv' }, f);
assert.deepEqual(SA('selection', '/R/s'), { command: 'Selection...', path: '/R/s.roi', options: 'save=/R/s.roi' });
assert.deepEqual(SA('ROI', '/R/s.txt'), { command: 'Selection...', path: '/R/s.roi', options: 'save=/R/s.roi' });
assert.deepEqual(SA('XY Coordinates', '/R/c.csv'), { command: 'XY Coordinates...', path: '/R/c.txt', options: 'save=/R/c.txt' });
assert.deepEqual(SA('coordinates', null), { command: 'XY Coordinates...', path: null, options: null });
assert.deepEqual(SA('png', null), { command: 'PNG...', path: null, options: null }, 'no path: run(command) shows its dialog');
for (const [f, cmd, ext] of [['avi', 'AVI... ', '.avi'], ['bmp', 'BMP...', '.bmp'], ['fits', 'FITS...', '.fits'], ['pgm', 'PGM...', '.pgm']]) {
  const r = SA(f, '/R/a.tif');
  assert.equal(r.command, cmd);
  assert.equal(r.path, '/R/a' + ext);
  assert.deepEqual(R0(cmd), { refuse: { key: 'err.macSaveFormat', params: { format: f } } }, cmd + ' is refused by resolve');
}
assert.deepEqual(SA('Foo', '/R/x.foo'), { unsupported: { message: 'Unsupported save() or saveAs() file format: "foo"\n \n"/R/x.foo"' }, command: 'foo', path: '/R/x.foo',
  options: 'save=/R/x.foo' });
assert.equal(SA('Foo', '').unsupported.message, 'Unsupported save() or saveAs() file format: "foo"\n \n"null"');
assert.equal(R0('foo'), null, 'then run("foo") is an unrecognized command');
assert.equal(C.saveAsPlan(null, '/R/a'), null);
// every command the plan names resolves (a class F entry, a FILE_NAMES spec or a format refusal)
for (const f of ['text image', 'text', 'zip', 'raw', 'png', 'lut', 'results', 'selection', 'xy']) {
  const r = J(C.resolve(SA(f, '/R/a').command));
  assert.ok(r && (r.file || (r.entry && r.entry.cls === 'F')), f + ' → ' + SA(f, '/R/a').command);
}

// ── §9.1 refusals
const R = (n) => J(C.resolve(n));
assert.deepEqual(R('Image Sequence...'), { refuse: { key: 'err.macRefused', params: { command: 'Image Sequence...', reasonKey: 'err.macReasonSequence' } } });
assert.deepEqual(R('Image Sequence... '), { refuse: { key: 'err.macRefused', params: { command: 'Image Sequence... ', reasonKey: 'err.macReasonSequence' } } });
for (const [n, f] of [['Gif...', 'gif'], ['AVI... ', 'avi'], ['BMP...', 'bmp'], ['PGM...', 'pgm'], ['FITS...', 'fits']]) assert.deepEqual(R(n), { refuse: { key: 'err.macSaveFormat', params: { format: f } } }, n);
for (const n of ['Gif... ', 'AVI...', 'BMP... ', 'Image Sequence']) assert.equal(R(n), null, JSON.stringify(n) + ': exact names only');
assert.deepEqual(R('Bio-Formats Importer'), { refuse: { key: 'err.macBioFormats', params: { name: 'Bio-Formats Importer' } } }, 'refusals without params carry the name');
assert.deepEqual(R('Open from Library...'), { refuse: { key: 'err.macRefused', params: { command: 'Open from Library...', reasonKey: 'err.macReasonLibrary' } } });
for (const r of C.REFUSED_NAMES) assert.ok(Object.isFrozen(r) && (!r.params || Object.isFrozen(r.params)));
// ── no `later` left (FILES.md §12.3)
const src = fs.readFileSync(path.join(DIR, 'ij-macro-cmds.js'), 'utf8');
assert.ok(!/\blater\s*\(/.test(src), 'no later(...) entry');
assert.ok(!src.includes('macFileLater'), 'err.macFileLater is retired');
for (const [id, e] of Object.entries(T)) { assert.equal(e.later, undefined, id); assert.notEqual(e.refuse, 'err.macFileLater', id); }

// ── ops ⊂ IJMacroProto.FILE_OPS, and every FILE_OPS entry reachable from a name
const PROC = path.join(DIR, 'ij-proc-macro.js');
let FILE_OPS = null;
if (fs.existsSync(PROC)) {
  const noop = new Proxy(function () {}, { get: (t, k) => (k === Symbol.toPrimitive ? () => '' : noop), apply: () => noop, construct: () => noop });
  const ctx = { console, IJOpRegistry: noop };
  ctx.self = ctx;
  vm.createContext(ctx);
  try {
    vm.runInContext(fs.readFileSync(PROC, 'utf8'), ctx, { filename: 'ij-proc-macro.js' });
    FILE_OPS = ctx.IJMacroProto && ctx.IJMacroProto.FILE_OPS ? Array.from(ctx.IJMacroProto.FILE_OPS) : null;
  } catch (err) {
    console.log('SKIP ij-proc-macro.js does not load in Node here: ' + err.message);
  }
}
if (FILE_OPS) {
  for (const op of ops) assert.ok(FILE_OPS.includes(op), 'op ' + op + ' is in IJMacroProto.FILE_OPS');
  for (const op of FILE_OPS) assert.ok(ops.has(op), 'IJMacroProto.FILE_OPS ' + op + ' is reachable from a run() name');
  assert.deepEqual([...FILE_OPS].sort(), ['batchMacro', 'importLut', 'importRaw', 'importResults', 'importTable', 'importTextFile', 'importTextImage', 'importXY', 'install', 'open', 'runMacro', 'save', 'saveJpeg', 'saveLut',
    'savePng', 'saveRaw', 'saveResults', 'saveSelection', 'saveText', 'saveTextImage', 'saveTiff', 'saveXY', 'saveXYCoordinates', 'saveZip']);
} else if (FILE_OPS === null && fs.existsSync(PROC)) console.log('SKIP IJMacroProto.FILE_OPS absent (RUNTIME): ops coverage not checked');
else console.log('SKIP ij-proc-macro.js absent: ops coverage not checked');

console.log('ok: ' + ROWS.length + ' file commands, ' + ops.size + ' ops');
process.exit(0);
