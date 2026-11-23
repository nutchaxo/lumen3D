// The run() bridge table (ij-macro-cmds.js) as a table: one entry for every command of a booted Studio (Window's dynamic image
// entries excepted) and none for a command that no longer exists, entry shapes, the ImageJ / Fiji names (trailing-space twins kept),
// the fixed classifications of INTEGRATION.md §5.4, IJ.convert verbatim from ij/IJ.java 1.54p, the resolve() order and refusals.
// The field-level checks (every field covered, every option has its item text) run against the real dialogs in test_ij_macro_parity.mjs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './harness.mjs';
import { boot, EN } from './ij_harness.mjs';
import { loadCmds, fixture, hasKey } from './ij_macro_cmds_support.mjs';

const L = loadCmds();
if (!L) { console.log('SKIP ij-macro-cmds.js absent'); process.exit(0); }
const { IJMacroCmds: C } = L;
const T = C.MACRO_COMMANDS;
const J = (x) => JSON.parse(JSON.stringify(x));

// ── every command of a booted Studio has exactly one entry
const t = await boot({});
const ids = t.IJApp.COMMANDS.filter((c) => !c.dynamic).map((c) => c.id);
t.close();
// File › Import › Results… is added by the file phase's plumbing (FILES.md §10.4): its entry may land before the command does
const PENDING = ['fileImportResults'].filter((id) => !ids.includes(id));
if (PENDING.length) console.log('SKIP ' + PENDING.join(', ') + ': not a Studio command yet (FILES.md §10.4), entry kept');
for (const id of ids) assert.ok(Object.prototype.hasOwnProperty.call(T, id), 'MACRO_COMMANDS has no entry for ' + id);
for (const id of Object.keys(T)) assert.ok(ids.includes(id) || PENDING.includes(id), 'MACRO_COMMANDS entry ' + id + ' names no command');
assert.equal(Object.keys(T).length, ids.length + PENDING.length);

// ── shapes
const CLASSES = new Set(['A', 'B', 'C', 'D', 'E', 'F']);
for (const [id, e] of Object.entries(T)) {
  assert.equal(typeof e.name, 'string', id + ' name');
  assert.ok(e.name.length > 0, id + ' name');
  assert.ok(CLASSES.has(e.cls), id + ' cls');
  assert.ok(Array.isArray(e.dialogs), id + ' dialogs');
  if (e.cls === 'E') {
    assert.equal(typeof e.refuse, 'string', id + ': a class E entry carries its reason key');
    assert.ok(hasKey(e.refuse) || !fs.existsSync(path.join(ROOT, 'js/modules/studio/advanced-studio/lang/en.json')) || e.refuse.startsWith('err.mac'), id + ' refuse key');
    assert.equal(e.dialogs.length, 0, id + ': a refused command has no dialog table');
  } else assert.equal(e.refuse, undefined, id + ': only class E refuses');
  assert.equal(e.later, undefined, id + ': the file phase retired `later`');
  assert.notEqual(e.refuse, 'err.macFileLater', id);
  if (e.cls === 'F') {
    assert.ok(e.file && typeof e.file.op === 'string' && e.file.dialog && typeof e.file.dialog.title === 'string', id + ': a class F entry carries its FileSpec');
    assert.equal(e.dialogs.length, 0, id + ': a file command has no dialog table');
  } else assert.equal(e.file, undefined, id + ': only class F carries a FileSpec');
  if (e.alias !== undefined) { assert.ok(T[e.alias], id + ' alias'); assert.equal(T[e.alias].name, e.name, id + ': an alias shares its name'); }
  if (e.disabledText !== undefined) assert.equal(typeof e.disabledText, 'string', id + ' disabledText');
  for (const [k, d] of e.dialogs.entries()) {
    const at = id + ' dialog ' + k;
    assert.ok(d.ij === null || /#\d+$/.test(d.ij), at + ' ij');
    assert.ok(d.title === null || typeof d.title === 'string', at + ' title');
    assert.ok(d.keys && typeof d.keys === 'object', at + ' keys');
    for (const [f, key] of Object.entries(d.keys)) assert.ok(key === null || (typeof key === 'string' && key.length > 0 && key === key.toLowerCase() || /[A-Z]/.test(key) && e.cls === 'B'), at + ' key of ' + f + ': ' + key);
    for (const f of Object.keys(d.items || {})) {
      assert.ok(Object.prototype.hasOwnProperty.call(d.keys, f), at + ': items of ' + f + ' without a key');
      assert.ok(Object.keys(d.items[f]).length > 0, at + ': empty items of ' + f);
    }
    for (const f of d.titles || []) assert.ok(Object.prototype.hasOwnProperty.call(d.keys, f), at + ': titles field ' + f + ' without a key');
    for (const f of Object.keys(d.derive || {})) { assert.ok(Object.prototype.hasOwnProperty.call(d.keys, f), at + ': derived ' + f); assert.equal(typeof d.derive[f], 'function'); }
    if (d.refuse !== undefined) assert.equal(typeof d.refuse, 'string', at + ' refuse');
    if (d.ij) assert.ok(d.ij.startsWith(e.name + '#'), at + ': its capture key is the command name');
  }
}

// ── fixed classifications (INTEGRATION.md §5.4)
const byCls = (cls) => Object.keys(T).filter((id) => T[id].cls === cls).sort();
// + the macro extras the operator alone uses (EXTRAS.md §4.3): the Recorder, the startup texts, Remove Installed Macros
assert.deepEqual(byCls('E'), ['editRedo', 'editUndo', 'fileCloseStudio', 'fileOpenLibrary', 'fileRecover', 'fileSimple', 'macRecord', 'macRemoveInstalled', 'macStartup', 'optStartup']);
assert.equal(T.macRecord.refuse, 'err.macReasonRecorder');
assert.equal(T.macStartup.refuse, 'err.macReasonStartup');
assert.equal(T.optStartup.refuse, 'err.macReasonStartup');
assert.equal(T.macRemoveInstalled.refuse, 'err.macReasonInstalled');
assert.equal(T.fileOpenLibrary.refuse, 'err.macReasonLibrary');
assert.equal(T.fileSimple.refuse, 'err.macReasonHost');
assert.equal(T.fileCloseStudio.refuse, 'err.macReasonHost');
assert.equal(T.fileRecover.refuse, 'err.macReasonRecover');
assert.equal(T.editUndo.refuse, 'err.macReasonUndo');
assert.equal(T.editRedo.refuse, 'err.macReasonUndo');
assert.deepEqual(byCls('F'), ['fileImportLut', 'fileImportResults', 'fileImportTextImage', 'fileOpen', 'fileSaveJpeg', 'fileSaveLut', 'fileSavePng',
  'fileSaveResults', 'fileSaveSelection', 'fileSaveTextImage', 'fileSaveTiff', 'fileSaveXY', 'macRun', 'toolsSaveXY'].concat(['batchMacro', 'macInstall']).sort(), 'every command that reads or writes a file of the user is class F');
// a command that calls pickFile / saveFile from its run is in that list (static scan of the command modules)
const DIR = path.join(ROOT, 'js', 'modules', 'studio', 'advanced-studio');
for (const f of fs.readdirSync(DIR).filter((x) => /^ij-cmds-.*\.js$/.test(x) && x !== 'ij-cmds-macro.js')) {
  const src = fs.readFileSync(path.join(DIR, f), 'utf8');
  for (const m of src.matchAll(/id: '(\w+)'[^\n]*\n(?:(?!\n\s*\{ id:|\n\s*id: ')[\s\S]){0,1600}?\b(?:api|papi)\.(?:pickFile|saveFile)\(/g)) {
    if (T[m[1]]) assert.ok(T[m[1]].cls === 'F' || T[m[1]].cls === 'B', f + ': ' + m[1] + ' uses a file picker but is not class F');
  }
}
assert.deepEqual(byCls('D'), ['analyzeColocalization', 'helpAbout', 'helpShortcuts', 'macEdit', 'windowLog', 'windowNext', 'windowPrevious', 'windowResults']);
for (const id of byCls('D')) assert.equal(T[id].name, String(EN.cmd[id]).replace(/…/g, '...'), id + ': a class D name is the English Studio label');
assert.deepEqual(byCls('C'), ['lut16Colors', 'lutHiLo', 'procRepeatCommand', 'windowRoiManager', 'zoomFit', 'zoomIn', 'zoomOut']);
assert.equal(T.procRepeatCommand.name, 'Repeat Command');
assert.deepEqual(byCls('B'), ['adjustAutoLocalThreshold', 'adjustAutoThreshold', 'analyzeDirectionality', 'colocColoc2', 'hyperReorder', 'ltComplete', 'pluginsCellCounter',
  'pluginsFrangi', 'pluginsTubeness', 'procCLAHE', 'skelAnalyze']);

// ── names: trailing-space twins (PLAN §8.1) and the jar / Fiji tables
const TWINS = { fileImportLut: 'LUT... ', fileSaveLut: 'LUT...', fileImportTextImage: 'Text Image... ', fileSaveTextImage: 'Text Image...', selProperties: 'Properties... ',
  imageProperties: 'Properties...', selScale: 'Scale... ', imageScale: 'Scale...', selRotate: 'Rotate...', transformRotate: 'Rotate... ', selTranslate: 'Translate... ',
  transformTranslate: 'Translate...', fileSaveXY: 'XY Coordinates...', fileSaveResults: 'Results...', mathSet: 'Set...' };
for (const [id, n] of Object.entries(TWINS)) assert.equal(T[id].name, n, id + ' twin name');
const IJ = fixture('ij-dialogs.json'), FJ = fixture('fiji-macro-keys.json');
if (IJ) {
  const fijiOnly = new Set(['16 colors', 'HiLo']);
  for (const [id, e] of Object.entries(T)) {
    if (e.cls === 'A' || e.cls === 'F' || (e.cls === 'E' && !['Recover...', 'Back to Simple view', 'Close Studio', 'Open from Library...', 'Redo', 'Remove Installed Macros'].includes(e.name))) {
      assert.ok(Object.prototype.hasOwnProperty.call(IJ.commands, e.name), id + ': "' + e.name + '" is no ImageJ 1.54p command');
    }
    if (e.cls === 'B' && FJ) assert.ok(Object.prototype.hasOwnProperty.call(FJ.commands, e.name), id + ': "' + e.name + '" is not in the Fiji capture');
    if (e.cls === 'C' && !fijiOnly.has(e.name) && e.name !== 'Repeat Command') assert.ok(Object.prototype.hasOwnProperty.call(IJ.commands, e.name), id + ': "' + e.name + '"');
    // a label that is an ImageJ command name keeps it exactly
    const label = String(EN.cmd[id] || '').replace(/…/g, '...');
    if (e.cls === 'A' && !TWINS[id] && Object.prototype.hasOwnProperty.call(IJ.commands, label)) assert.equal(e.name, label, id);
  }
} else console.log('SKIP ij-dialogs.json absent: names not checked against the jar');
// A–C names are unique (an alias excepted)
const seen = new Map();
for (const [id, e] of Object.entries(T)) {
  if (!['A', 'B', 'C', 'F'].includes(e.cls) || e.alias) continue;
  assert.ok(!seen.has(e.name), 'name "' + e.name + '" of ' + id + ' is also ' + seen.get(e.name));
  seen.set(e.name, id);
}

// ── IJ.convert, verbatim from ij/IJ.java 1.54p: the committed extract tests/fixtures/ij-macro/ij-convert.json, itself checked
// against the source when the (gitignored) ImageJ sources are present
const convert = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'ij-macro', 'ij-convert.json'), 'utf8')).table;
assert.ok(Object.keys(convert).length > 50);
assert.deepEqual(J(C.IJ_CONVERT), convert, 'IJ_CONVERT = IJ.convert of 1.54p');
const ijJava = path.join(ROOT, 'DOCS', 'studio-advanced', 'macros', 'ij-src', 'ij', 'IJ.java');
if (fs.existsSync(ijJava)) {
  const src = fs.readFileSync(ijJava, 'utf8');
  const body = src.slice(src.indexOf('private static String convert('), src.indexOf('String command2 = (String)commandTable.get(command);'));
  const unq = (s) => s.replace(/\\(.)/g, '$1');
  const table = {};
  for (const m of body.matchAll(/commandTable\.put\("((?:[^"\\]|\\.)*)",\s*"((?:[^"\\]|\\.)*)"\)/g)) table[unq(m[1])] = unq(m[2]);
  assert.deepEqual(convert, table, 'ij-convert.json = IJ.convert of ij/IJ.java');
}

// ── resolve
const R = (n) => J(C.resolve(n));
assert.deepEqual(R('Gaussian Blur...'), { id: 'filterGaussian', entry: J(T.filterGaussian) });
assert.equal(R('Rotate... ').id, 'transformRotate', 'the trailing-space twin is the transform');
assert.equal(R('Rotate...').id, 'selRotate');
assert.equal(R('Set... '), null, 'Image > Zoom > Set... is no Studio command');
assert.equal(R('gaussian blur...'), null, 'no case folding');
assert.equal(R(' Gaussian Blur...'), null, 'no trimming');
assert.equal(R('Gaussian Blur'), null);
assert.equal(R('In').id, 'zoomIn', 'IJ.convert');
assert.equal(R('In [+]').id, 'zoomIn');
assert.equal(R('Out').id, 'zoomOut');
assert.equal(R('Threshold').id, 'binMakeBinary', 'IJ.convert: Threshold → Make Binary');
assert.equal(R('Start Animation').id, 'stackStartAnimation');
assert.equal(R('RGB Merge...').id, 'colorMergeChannels');
assert.equal(R('Arbitrarily...').id, 'transformRotate');
assert.equal(R('Channels...').id, 'colorChannels');
assert.equal(R('Enhance Contrast').id, 'procEnhanceContrast');
assert.equal(R('Statistics...').id, 'stackStatistics');
assert.equal(R('New... '), null, 'converted to Table..., which the Studio has not');
assert.equal(R('Log').id, 'mathLog', 'Process > Math > Log owns the name');
assert.equal(R('ROI Manager...').id, 'toolsRoiManager', 'the Window entry is an alias');
assert.equal(R('Results').id, 'windowResults');
assert.equal(R('Repeat Command').id, 'procRepeatCommand');
assert.equal(R('Enhance Local Contrast (CLAHE)').id, 'procCLAHE');
assert.equal(R('16 colors').id, 'lut16Colors');
assert.deepEqual(R('Open from Library...'), { refuse: { key: 'err.macRefused', params: { command: 'Open from Library...', reasonKey: 'err.macReasonLibrary' } } });
assert.deepEqual(R('Undo'), { refuse: { key: 'err.macRefused', params: { command: 'Undo', reasonKey: 'err.macReasonUndo' } } });
assert.deepEqual(R('Open...'), { id: 'fileOpen', entry: J(T.fileOpen) }, 'a file command resolves to its class F entry');
assert.deepEqual(R('Tiff...'), { id: 'fileSaveTiff', entry: J(T.fileSaveTiff) });
assert.deepEqual(R('Run...'), { id: 'macRun', entry: J(T.macRun) });
assert.equal(R('Measurements...').id, 'fileImportResults', 'IJ.convert: Measurements... → Results... ');
assert.deepEqual(R('Bio-Formats Importer').refuse.key, 'err.macBioFormats');
assert.deepEqual(R('Bio-Formats Windowless Importer').refuse.key, 'err.macBioFormats');
assert.deepEqual(R('Bio-Formats Macro Extensions').refuse.key, 'err.macBioFormats', 'the Bio-Formats prefix comes first');
assert.deepEqual(R('URL...').refuse.key, 'err.macNetwork');
assert.deepEqual(R('Stack Macro Extensions').refuse.key, 'err.macExtensions');
assert.equal(R('Nope'), null);
assert.equal(C.resolve(undefined), null);
assert.equal(C.resolve(42), null);
assert.equal(C.nameOf('filterGaussian'), 'Gaussian Blur...');
assert.equal(C.nameOf('nope'), null);
assert.equal(C.NO_IMAGE_TEXT, 'There are no images open');
for (const r of C.REFUSED_NAMES) assert.ok(hasKey(r.key) || r.key.startsWith('err.mac'), r.key);

// ── no network, no evaluation, no DOM in the file (INTEGRATION.md §8): the code without comments, string literals and property names
// (ImageJ's Scale Bar has a dialog key "location": data, not the page's location)
function codeOnly(src) {
  let out = '', i = 0;
  while (i < src.length) {
    const c = src[i], d = src[i + 1];
    if (c === '/' && d === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? src.length : e + 2; continue; }
    if (c === '/' && d === '/') { const e = src.indexOf('\n', i + 2); i = e < 0 ? src.length : e; continue; }
    if (c === "'" || c === '"' || c === '`') { let j = i + 1; while (j < src.length && src[j] !== c) { if (src[j] === '\\') j++; j++; } out += '""'; i = j + 1; continue; }
    out += c; i++;
  }
  return out.replace(/([{,]\s*)[A-Za-z_$][\w$]*\s*:/g, '$1:');
}
const SRC = codeOnly(fs.readFileSync(path.join(DIR, 'ij-macro-cmds.js'), 'utf8'));
for (const re of [/\bfetch\b/, /\bXMLHttpRequest\b/, /\bsendBeacon\b/, /\bWebSocket\b/, /\bEventSource\b/, /\bimportScripts\b/, /\bnew\s+Worker\b/, /\bwindow\b/,
  /\blocation\b/, /\bE\.fetch\b/, /\beval\b/, /\bnew\s+Function\b/, /\bFunction\s*\(/, /\bWebAssembly\b/, /\bdocument\b/, /\binnerHTML\b/, /\blocalStorage\b/]) {
  assert.ok(!re.test(SRC), 'ij-macro-cmds.js must not use ' + re);
}

console.log('ok: ' + ids.length + ' commands, ' + ['A', 'B', 'C', 'D', 'E', 'F'].map((c) => c + ' ' + byCls(c).length).join(', '));
process.exit(0);
