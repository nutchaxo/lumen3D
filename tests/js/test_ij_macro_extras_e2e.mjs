// End to end: the macro extras of the Advanced Studio (DOCS/studio-advanced/macros/EXTRAS.md §18) through the whole Studio under Node —
// the real page controller (ij-app.js, ij-cmds-macro.js: Recorder window, #@ dialog, Install, Startup, Batch Process window, Math › Macro),
// the real worker (engine, packages, ij-macro-lang.js, ij-macro-vfs.js, ij-macro-params.js, ij-macro-math.js, ij-proc-macro.js) and the
// file system fakes (a user folder, OPFS, IndexedDB, the pickers). Every network API of both realms is a spy.
//
// Run: node tests/js/test_ij_macro_extras_e2e.mjs
process.env.TZ = 'UTC';
let finished = false;
process.on('exit', (code) => { if (!finished && code === 0) { console.error('FAIL: the test stopped before its end (a promise never settled)'); process.exitCode = 1; } });
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { until, sleep, DIR } from './ij_harness.mjs';
import { fileBoot, folder, messageBoxes, pixelDigest } from './ij_macro_files_e2e_support.mjs';
import { ROOT } from './harness.mjs';
import { createHash } from 'node:crypto';

for (const f of ['ij-macro-rec.js', 'ij-macro-params.js', 'ij-macro-math.js']) {
  if (!fs.existsSync(path.join(DIR, f))) { console.log('SKIP test_ij_macro_extras_e2e: ' + f + ' is absent'); finished = true; process.exit(0); }
}

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok  ' + name); } catch (err) { console.error('FAIL ' + name); throw err; }
}
const J = (x) => (x === undefined ? x : JSON.parse(JSON.stringify(x)));
const deq = (a, b, m) => (m === undefined ? assert.deepEqual(J(a), J(b)) : assert.deepEqual(J(a), J(b), m));
const FIX = path.join(ROOT, 'tests', 'fixtures', 'ij-macro');
const page = (t) => vm.runInContext('IJMacroPage', t.page);
const lines = (...l) => l.join('\n');
const noMachinePath = (s) => !/[A-Za-z]:[\\/]|\\\\|\/Users\/|\/home\/[a-z]|file:\/\//.test(String(s));
const recLines = (text) => String(text).split('\n').filter((l) => l !== '');
/** A menu command once the Studio is idle again (the Macro Editor's Files section reads the workspace at opening: a short busy state). */
async function run(t, id, values, o) {
  await until(() => t.isEnabled(id), id + ' enabled', 8000);
  return t.runCommand(id, values, o);
}

/** The page's own state of an image: pixels of channel 0, its selection, its title. */
async function imageState(t, docId) {
  const d = t.worker.engine.inspectDoc(docId);
  const info = await t.engine('doc.info', { docId });
  const inf = info.info || info;
  const v = t.view(docId);
  const roi = v && typeof v.getRoi === 'function' ? v.getRoi() : null;
  return { title: inf.name || inf.title, sha: pixelDigest(inf.width, inf.height, d.channels.length, d.nZ, d.nT, inf.bitDepthIJ || inf.bitDepth, (c, z, tt) => d.channels[c].planes[tt * d.nZ + z]), roi: roi ? J(roi) : null };
}
/** The rows of the Results table the page shows (column → values). */
function results(t) {
  const api = t.api(null);
  const tb = api && typeof api.results === 'function' ? api.results() : null;
  return tb ? J(tb) : null;
}

// ═══════════════════════════════════════ 1. the Recorder ═══════════════════════════════════════
await test('Recorder: a dialog command, a rectangle, Measure, Duplicate, activating the other image and Invert give ImageJ\'s lines; Create, then the replay on a fresh boot gives the same pixels', async () => {
  const t = await fileBoot();
  const first = t.activeId();
  const R = t.recorder();
  await R.open();
  t.toolRoi({ type: 'rect', x: 10, y: 8, w: 30, h: 20 }, { tool: 'rect' });
  await sleep(0);
  await run(t, 'filterGaussian', { sigma: 2 });
  await run(t, 'analyzeMeasure');
  await run(t, 'imageDuplicate', {});
  const dup = t.activeId();
  assert.notEqual(dup, first, 'Duplicate made a new image');
  const firstTitle = (await imageState(t, first)).title;
  t.activate(first);
  await until(() => t.shell.activeDocId() === first, 'the first image is active');
  await run(t, 'editInvert');
  // the Threshold window: its opening range, then Apply (Convert to Mask on an 8-bit image)
  await run(t, 'adjustThreshold');
  await t.thresholdAction('apply');
  await until(() => /Convert to Mask/.test(R.text()), 'the Convert to Mask line');
  await until(() => t.isEnabled('editInvert'), 'idle');
  const text = R.text();
  const got = recLines(text);
  const thrAt = got.indexOf('//run("Threshold...");');
  assert.ok(thrAt > 0, 'the Threshold window line: ' + JSON.stringify(got));
  const auto = got[thrAt - 1];
  // ThresholdAdjuster: the opening range is recorded before the command line (method Default, the Studio has no 16-bit histogram box)
  assert.ok(/^setAutoThreshold\("Default( dark)? no-reset"\);$/.test(auto), 'the opening auto threshold line: ' + auto);
  const mask = got.slice(thrAt + 1);
  assert.ok(/^\/\/setThreshold\(\d+, \d+\);$/.test(mask[0]), 'Apply: the //setThreshold comment of Thresholder.applyThreshold: ' + JSON.stringify(mask));
  assert.ok(/^setOption\("BlackBackground", (true|false)\);$/.test(mask[1]), mask[1]);
  deq(mask.slice(2), ['run("Convert to Mask");']);
  deq(got.slice(0, thrAt - 1), ['makeRectangle(10, 8, 30, 20);', 'run("Gaussian Blur...", "sigma=2");', 'run("Measure");', 'run("Duplicate...", " ");',
    'selectImage("' + firstTitle + '");', 'run("Invert");']);
  assert.ok(noMachinePath(text));
  const after = { first: await imageState(t, first), dup: await imageState(t, dup), results: results(t), docs: (await t.docs()).length };
  // Create: a new macro in the Macro Editor holding the Recorder's text
  page(t)._internals.state().editorText = '';
  await R.create();
  assert.equal(page(t)._internals.state().editorText, text, 'the Macro Editor holds the recorded text');
  assert.equal(t.net.length, 0, 'no network: ' + t.net.join(', '));
  t.close();

  // the replay: a fresh boot on the same volume runs the recorded text as a macro
  const t2 = await fileBoot();
  const first2 = t2.activeId();
  const r = await t2.runMacro(text);
  assert.ok(r && r.ok, 'the recorded macro runs: ' + JSON.stringify(r && r.error));
  await until(() => t2.isEnabled('editInvert'), 'idle after the replay');
  const docs2 = await t2.docs();
  assert.equal(docs2.length, after.docs, 'the same images');
  const s1 = await imageState(t2, first2);
  assert.equal(s1.sha, after.first.sha, 'the first image\'s pixels');
  const dup2 = docs2.map((d) => d.docId).find((id) => id !== first2 && t2.worker.engine.inspectDoc(id) && (t2.worker.engine.inspectDoc(id).channels[0].planes[0].length === t.worker.engine.inspectDoc(dup).channels[0].planes[0].length));
  assert.ok(dup2 !== undefined, 'the duplicate');
  assert.equal((await imageState(t2, dup2)).sha, after.dup.sha, 'the duplicate\'s pixels');
  deq(results(t2), after.results, 'the Results table');
  assert.equal(t2.net.length, 0);
  t2.close();
});

await test('Recorder: a running macro\'s own commands, selections and activations are never recorded; while it waits for the operator, the operator\'s selection is, the activation is not (X1)', async () => {
  const t = await fileBoot();
  const first = t.activeId();
  let r = await t.runMacro('newImage("other", "8-bit ramp", 40, 30, 1);');
  assert.ok(r.ok, JSON.stringify(r.error));
  await until(() => t.isEnabled('editInvert'), 'idle');
  const other = t.activeId();
  const R = t.recorder();
  await R.open();
  // waitForUser: a non-modal box; the operator acts while the run is paused, then clicks OK
  t.script.dialogs.push(async (spec) => {
    assert.equal(spec.nonModal, true);
    t.toolRoi({ type: 'rect', x: 3, y: 4, w: 10, h: 12 }, { tool: 'rect', docId: other });
    await sleep(0);
    t.activate(first);
    await sleep(0);
    return {};
  });
  r = await t.runMacro(lines('selectImage("other");', 'run("Invert");', 'makeRectangle(1, 1, 5, 5);', 'roiManager("Add");', 'waitForUser("go");',
    'selectImage("other");', 'run("Invert");', 'makeOval(2, 2, 8, 8);'));
  assert.ok(r.ok, JSON.stringify(r.error));
  assert.equal(R.text(), 'makeRectangle(3, 4, 10, 12);\n', 'only the operator\'s selection: ' + JSON.stringify(R.text()));
  assert.equal(t.net.length, 0);
  t.close();
});

// ═══════════════════════════════════════ 2. #@ script parameters ═══════════════════════════════════════
function* walk(e) { if (!e) return; yield e; for (const k of e.children || []) yield* walk(k); }
async function setEditorText(t, text) {
  const ta = await until(() => Array.from(walk(t.panel('macroEditor'))).find((e) => e.tagName === 'TEXTAREA') || null, 'the editor text area');
  ta.value = text;
  for (const f of (ta.listeners.input || []).slice()) f({ target: ta, type: 'input' });
}
/** What the Macro Editor's Run does with its text (ij-cmds-macro.js runFrom → runMacroText: #@ dialog, injection, Outputs), awaited. */
async function editorRun(t, text) {
  await setEditorText(t, text);
  await until(() => !t.api('macro').macro.running() && t.isEnabled('macRun'), 'idle before Run');
  const d0 = t.log.dialogSpecs.length;
  await t.extras().runMacroText(text, { name: 'Macro', lineOffset: 0, identity: 'Macro.ijm' });
  await sleep(0);
  return t.log.dialogSpecs.slice(d0);
}
const PARAM_SRC = lines(
  '#@ Integer (label="Count", min=1, max=10, value=3) n',
  '#@ String (choices={"a","b"}, style="radioButtonHorizontal") s',
  '#@ Boolean (value=true) flag',
  '#@ File (style="directory") dir',
  '#@output String greeting',
  'print(n + s + flag + " " + File.isDirectory(dir) + " " + dir);',
  'greeting = "hi " + n;');

await test('#@: Integer / String choices / Boolean / File(directory) in one dialog before the run, values injected and persisted, Cancel runs nothing, a service refused before the run, #@output in the Outputs window', async () => {
  const t = await fileBoot();
  await t.grantFolder(folder('Data', { 'a.txt': 'x' }), { mode: 'allow' });
  const X = t.extras();
  page(t)._internals.reset();
  t.script.dialogs.push({ p0: 5, p1: 'b', p2: true, p3: '/Data/' });
  let specs = await editorRun(t, PARAM_SRC);
  const pd = specs.filter((s) => s.title === 'Macro' || /\.ijm$/.test(s.title));
  assert.equal(pd.length, 1, 'one parameter dialog: ' + JSON.stringify(specs.map((s) => s.title)));
  const f = pd[0].fields.filter((x) => x.type !== 'message');
  deq(f.map((x) => x.label), ['Count', 'S', 'Flag', 'Dir'], 'Fiji\'s labels: the label attribute, else the name with a capital first letter');
  deq(f.map((x) => x.type), ['number', 'radio', 'check', 'path'], 'the field kinds');
  assert.equal(f[0].value, 3);
  deq(t.macroLog(), ['5b1 1 /Data/'], 'the values injected as the IJ1 macro engine does');
  await until(() => t.shell.windows.floats.get('macroOutputs'), 'the Outputs window');
  deq(X.state().outputs, [{ name: 'greeting', value: 'hi 5' }]);
  const stored = (await X.all('params')).map((p) => [p.name, p.value]).sort();
  deq(stored, [['dir', '/Data/'], ['flag', true], ['n', 5], ['s', 'b']], 'persisted in IndexedDB lumen3d-ij-macro, by input name');
  // the next run: the dialog comes pre-filled with the stored values
  page(t)._internals.reset();
  t.script.dialogs.push({});
  specs = await editorRun(t, PARAM_SRC);
  const f2 = specs.find((s) => s.fields.some((x) => x.id === 'p0')).fields;
  deq(['p0', 'p1', 'p2', 'p3'].map((id) => f2.find((x) => x.id === id).value), [5, 'b', true, '/Data/']);
  deq(t.macroLog(), ['5b1 1 /Data/']);
  // Cancel: the macro does not run
  page(t)._internals.reset();
  t.script.dialogs.push(null);
  await editorRun(t, PARAM_SRC.replace('print(', 'print("ran " + '));
  deq(t.macroLog(), [], 'nothing ran');
  // a service: refused before the run, naming the parameter
  page(t)._internals.reset();
  const d0 = t.log.dialogSpecs.length;
  await editorRun(t, '#@ UIService ui\nprint("ran");');
  deq(t.macroLog(), []);
  const box = t.log.dialogSpecs.slice(d0).find((s) => s.title === t.tr('dlg.mac.params.title'));
  assert.ok(box && box.fields.some((x) => /\bui\b/.test(x.label) && /UIService/.test(x.label)), 'the refusal names ui: ' + JSON.stringify(box && box.fields));
  assert.equal(t.net.length, 0);
  t.close();
});

// ═══════════════════════════════════════ 3. Install / Startup ═══════════════════════════════════════
const SET = lines(
  'var count = 0;',
  'macro "Add And Invert [h]" { run("Add...", "value=10"); run("Invert"); count++; print("count " + count); }',
  'macro "AutoRun" { print("auto"); }',
  'macro "Hello [F9]" { count++; print("hello " + count); }',
  '');
const fileOf = (name, text) => ({ name, size: text.length, arrayBuffer: async () => new TextEncoder().encode(text).buffer });

await test('Install…: three macro blocks — a key the Studio holds is dropped with ImageJ\'s box, AutoRun runs at once; an installed entry runs from the menu as one undo step and keeps the set\'s globals; restored at the next open without AutoRun', async () => {
  const t = await fileBoot();
  const X = t.extras();
  page(t)._internals.reset();
  const doc = t.activeId();
  const d0 = t.log.dialogSpecs.length;
  t.pickFile([fileOf('set.ijm', SET)]);
  await run(t, 'macInstall');
  await until(() => t.installed().length === 2, 'two rows');
  deq(t.installed().map((r) => [r.label, r.shortcut]), [['Add And Invert [h]', null], ['Hello [F9]', 'F9']]);
  const box = messageBoxes(t, d0).find((b) => b.title === t.tr('dlg.mac.install.title'));
  assert.ok(box && box.text.indexOf(t.tr('dlg.mac.install.keyInUse')) === 0 && /Add And Invert \[h\]/.test(box.text), 'ImageJ\'s "already in use" box: ' + JSON.stringify(messageBoxes(t, d0)));
  await until(() => t.macroLog().includes('auto'), 'AutoRun ran right after the install');
  // a menu row: one undo step for the whole entry
  await until(() => !t.api('macro').macro.running() && t.isEnabled('editUndo') !== undefined, 'idle');
  const before = await t.pixels(doc);
  await t.runInstalled('Add And Invert [h]');
  const after = await t.pixels(doc);
  for (let i = 0; i < 64; i++) assert.equal(after[i], 255 - Math.min(255, before[i] + 10), 'pixel ' + i);
  await t.runInstalled('Hello [F9]');
  deq(t.macroLog().filter((l) => /^(count|hello) /.test(l)), ['count 1', 'hello 2'], 'the set\'s var persists between entries');
  await run(t, 'editUndo');
  deq(await t.pixels(doc), before, 'one Undo restores the entry\'s two commands (Hello changed no pixel)');
  // run("<installed name>") from a macro: nested, same lane
  page(t)._internals.reset();
  const r = await t.runMacro('run("Hello [F9]"); print("after");');
  assert.ok(r.ok, JSON.stringify(r.error));
  deq(t.macroLog(), ['hello 3', 'after']);
  const stored = await X.macroRecord('installed');
  assert.equal(stored.name, 'set.ijm');
  assert.equal(stored.origin, 'file');
  // what a fresh open runs (EXTRAS.md §7.6): the stored set comes back, its AutoRun does not run (restoring is no install)
  page(t)._internals.reset();
  X.reset();
  await X.startup();
  await until(() => t.installed().length === 2, 'rows restored');
  deq(t.installed().map((r) => r.label), ['Add And Invert [h]', 'Hello [F9]']);
  await sleep(50);
  assert.ok(!t.macroLog().includes('auto'), 'no AutoRun at a restore');
  assert.equal(t.net.length, 0);
  t.close();
});

await test('Startup: RunAtStartup then the startup set\'s AutoRun at a fresh open; a failing startup macro shows the Macro Error window and the Studio stays usable', async () => {
  const t = await fileBoot();
  page(t)._internals.reset();
  await t.startup({ startupMacros: 'macro "AutoRun" { print("A"); }\n', runAtStartup: 'print("R");' });
  deq(t.macroLog(), ['R', 'A']);
  page(t)._internals.reset();
  await t.startup({ startupMacros: 'macro "AutoRun" { print("A"); }\n', runAtStartup: 'print(undefinedThing);' });
  deq(t.macroLog(), ['A'], 'the next step still runs');
  const err = page(t)._internals.state().lastError;
  assert.ok(err && /Undefined variable/.test(String(err.dialogText || err.message || JSON.stringify(err))), 'the Macro Error window: ' + JSON.stringify(err));
  // the Studio is usable: a command runs
  const doc = t.activeId();
  const before = await t.pixels(doc);
  await run(t, 'editInvert');
  const after = await t.pixels(doc);
  assert.equal(after[0], 255 - before[0]);
  assert.equal(t.net.length, 0);
  t.close();
});

// ═══════════════════════════════════════ 4. Process › Batch › Macro ═══════════════════════════════════════
/** An 8-bit TIFF written by the Studio's own engine (doc.import + doc.exportTiff). */
async function tiffOf(t, name, w, h, fill) {
  const data = new Uint8Array(w * h);
  for (let i = 0; i < data.length; i++) data[i] = fill(i % w, Math.floor(i / w)) & 0xff;
  const r = await t.engine('doc.import', { image: { name, width: w, height: h, bitDepth: 8, nZ: 1, nT: 1,
    calibration: { pixelWidth: 1, pixelHeight: 1, pixelDepth: 1, unit: 'pixel' },
    channels: [{ name: 'C1', color: '#ffffff', display: { min: 0, max: 255, lut: 'Grays', invert: false }, data }] } });
  const bytes = (await t.engine('doc.exportTiff', { docId: r.docId })).bytes.slice();
  await t.engine('doc.close', { docId: r.docId, discard: true });
  return { bytes, data };
}
const FILLS = { 'a.tif': (x, y) => x * 13 + y * 7, 'b.tif': (x, y) => (x ^ y) * 9, 'c.tif': (x, y) => x * y, 'd.tif': (x) => (x > 8 ? 240 : 10), 'e.tif': (x, y) => 255 - x * 5 - y };
async function batchFolder(t) {
  const tree = { '.hidden': 'x', 'notes/': null };
  const src = {};
  for (const [n, fill] of Object.entries(FILLS)) { const r = await tiffOf(t, n, 20, 14, fill); tree[n] = r.bytes; src[n] = r.data; }
  await t.grantFolder(folder('Data', tree), { mode: 'allow' });
  return src;
}
/** The pixels of every file a folder holds, read back by a macro (open, then the engine's plane), by file name. */
async function readBack(t, dir, only) {
  const out = {};
  page(t)._internals.reset();
  const r = await t.runMacro('list = getFileList("' + dir + '"); for (i = 0; i < list.length; i++) print(list[i]);');
  assert.ok(r.ok, JSON.stringify(r.error));
  for (const name of t.macroLog().slice().filter((n) => !only || only.test(n))) {
    const o = await t.runMacro('open("' + dir + name + '");');
    assert.ok(o.ok, JSON.stringify(o.error));
    await until(() => t.isEnabled('editInvert'), 'idle');
    out[name] = Array.from(await t.pixels(t.activeId()));
    await t.runMacro('close();');
  }
  return out;
}

await test('Batch › Macro: a granted folder of 5 TIFFs, run("Invert"), TIFF to /tmp/out/ — 5 files equal to the interactive Invert, the Recorder line, no undo record; Cancel after file 2 leaves 2 files; a file name filter', async () => {
  const t = await fileBoot();
  const src = await batchFolder(t);
  let r = await t.runMacro('File.makeDirectory("/tmp/out/"); File.makeDirectory("/tmp/cut/"); File.makeDirectory("/tmp/flt/");');
  assert.ok(r.ok, JSON.stringify(r.error));
  // the interactive Invert of one image, for the expected pixels
  r = await t.runMacro('open("/Data/a.tif");');
  await until(() => t.isEnabled('editInvert'), 'idle');
  const aDoc = t.activeId();
  await run(t, 'editInvert');
  const interactiveA = Array.from(await t.pixels(aDoc));
  await t.runMacro('close();');
  const R = t.recorder();
  await R.open();
  const events = [];
  const off = t.api('macro').on('ext:macro.batch', (e) => events.push(J(e)));
  const docs0 = (await t.docs()).length;
  const undo0 = t.isEnabled('editUndo');
  page(t)._internals.reset();
  r = await t.batch({ input: '/Data/', output: '/tmp/out/', format: 'TIFF', filter: '', code: 'run("Invert");' });
  assert.ok(r && r.ok, JSON.stringify(r && r.error));
  deq(r.batch.processed, ['a.tif', 'b.tif', 'c.tif', 'd.tif', 'e.tif']);
  deq(r.batch.saved, ['/tmp/out/a.tif', '/tmp/out/b.tif', '/tmp/out/c.tif', '/tmp/out/d.tif', '/tmp/out/e.tif']);
  assert.ok(events.length >= 1 && events[events.length - 1].name === 'e.tif' && events[events.length - 1].total === 7, 'progress with the file name, the last image always: ' + JSON.stringify(events));
  assert.equal((await t.docs()).length, docs0, 'no image left behind');
  assert.equal(t.isEnabled('editUndo'), undo0, 'a batch leaves no undo step');
  assert.equal(R.text(), 'run("Macro... ", "output_format=TIFF file=[] text1=run(\\"Invert\\");");\n', 'BatchProcessor\'s Recorder line (golden batch/recorded)');
  const out = await readBack(t, '/tmp/out/');
  deq(Object.keys(out).sort(), ['a.tif', 'b.tif', 'c.tif', 'd.tif', 'e.tif']);
  deq(out['a.tif'], interactiveA, 'a.tif equals the interactive Invert');
  for (const [n, data] of Object.entries(src)) deq(out[n], Array.from(data, (v) => 255 - v), n + ' inverted');
  // Cancel while the third image's macro runs: the batch stops, the two files already saved stay
  page(t)._internals.reset();
  const pending = t.batch({ input: '/Data/', output: '/tmp/cut/', format: 'TIFF', filter: '', code: 'run("Invert"); print("image " + i); if (i == 2) wait(20000);' });
  await until(() => t.macroLog().includes('image 2'), 'the third image is processed', 15000);
  page(t).abort();
  r = await pending;
  assert.ok(r && r.aborted, 'the batch was cancelled');
  deq(r.batch.saved, ['/tmp/cut/a.tif', '/tmp/cut/b.tif']);
  deq(Object.keys(await readBack(t, '/tmp/cut/')).sort(), ['a.tif', 'b.tif']);
  // File name contains: FolderOpener.getFilteredList keeps the names that contain the text
  r = await t.batch({ input: '/Data/', output: '/tmp/flt/', format: 'PNG', filter: 'd', code: 'run("Invert");' });
  assert.ok(r && r.ok, JSON.stringify(r && r.error));
  deq(r.batch.saved, ['/tmp/flt/d.png']);
  // run("Macro... ", …) from a macro: the GenericDialog part from the options, the folders the window stored (BatchProcessor.addPanels)
  page(t)._internals.reset();
  r = await t.runMacro('run("Macro... ", "output_format=TIFF file=e text1=[run(\\"Invert\\");]"); print("back");');
  assert.ok(r.ok, JSON.stringify(r.error));
  deq(t.macroLog(), ['back']);
  // the PNG written above is not read back: Node has no image decoder for it (the browser's createImageBitmap)
  const tiffs = await readBack(t, '/tmp/flt/', /\.tif$/);
  deq(Object.keys(tiffs), ['e.tif'], 'only the file the options\' filter keeps, in the stored output folder of the last batch');
  deq(tiffs['e.tif'], Array.from(src['e.tif'], (v) => 255 - v));
  off();
  assert.equal(t.net.length, 0);
  for (const l of [R.text(), JSON.stringify(r), t.macroLog().join('\n')]) assert.ok(noMachinePath(l), l);
  t.close();
});

// ═══════════════════════════════════════ 5. Process › Math › Macro ═══════════════════════════════════════
const sha256 = (u8) => createHash('sha256').update(u8).digest('hex');
const MG = JSON.parse(fs.readFileSync(path.join(FIX, 'math-golden.json'), 'utf8'));

await test('Math › Macro: "v=v*2" from the menu (Preview, the jar\'s pixels, one Undo) and "v=v+50*sin(d/10)" from a macro equal the jar goldens; the journal replays both; 512×512 timings', async () => {
  const t = await fileBoot();
  // the golden's input: 8-bit 64×48, (x*5 + y*3) & 255
  let r = await t.runMacro('newImage("m", "8-bit black", 64, 48, 1); for (y = 0; y < 48; y++) for (x = 0; x < 64; x++) setPixel(x, y, (x*5 + y*3) & 255); updateDisplay();');
  assert.ok(r.ok, JSON.stringify(r.error));
  await until(() => t.isEnabled('mathMacro'), 'idle');
  const doc = t.activeId();
  const input = await t.pixels(doc);
  assert.equal(sha256(input), MG.cases['v-times-2-8bit'].inputSha256, 'the golden\'s input image');
  const p0 = t.log.previews.length;
  await run(t, 'mathMacro', { code: 'v=v*2' });
  const spec = t.log.dialogSpecs.filter((s) => s.title === t.tr('dlg.mac.math.title')).pop();
  assert.ok(spec && spec.preview, 'the Expression Evaluator has a Preview');
  assert.ok(t.log.previews.slice(p0).some((p) => p !== null && p !== undefined), 'the preview was drawn on the image (op macroMath, the harness ticks Preview)');
  assert.equal(sha256(await t.pixels(doc)), MG.cases['v-times-2-8bit'].sha256, 'v=v*2 equals ImageJ\'s pixels');
  await run(t, 'editUndo');
  deq(await t.pixels(doc), input, 'one Undo restores the image');
  await run(t, 'editRedo');
  assert.equal(sha256(await t.pixels(doc)), MG.cases['v-times-2-8bit'].sha256);
  await run(t, 'editUndo');
  r = await t.runMacro('run("Macro...", "code=v=v+50*sin(d/10)");');
  assert.ok(r.ok, JSON.stringify(r.error));
  await until(() => t.isEnabled('mathMacro'), 'idle');
  const live = await t.pixels(doc);
  assert.equal(sha256(live), MG.cases['default-sin-d'].sha256, 'run("Macro...", "code=…") equals ImageJ\'s pixels');
  // the journal: a restore on a second engine replays the steps to the same pixels
  await t.worker.engine.whenIdle();
  const keys = (await t.store.shared.list()).map((s) => s.key);
  const t2 = await t.reload({ flush: false });
  const w2 = await t2.spawn();
  let restored = null;
  for (const key of keys) {
    const res = await t2.engine('session.restore', { key }, w2);
    if (w2.engine.inspectDoc(doc)) { assert.equal(res.warnings.length, 0, JSON.stringify(res.warnings)); restored = (await t2.engine('doc.tile', { docId: doc, channel: 0, level: 0, tx: 0, ty: 0 }, w2)).data; break; }
  }
  assert.ok(restored, 'the session holding the image restores');
  assert.equal(sha256(restored), MG.cases['default-sin-d'].sha256, 'baseline + journal replay = the live result');
  t2.close();
  // timings: 512×512 8-bit through the real engine op
  const t3 = await fileBoot();
  for (const code of ['v=v*2', 'v=v+50*sin(d/10)']) {
    await t3.runMacro('newImage("p", "8-bit ramp", 512, 512, 1);');
    await until(() => t3.isEnabled('mathMacro'), 'idle');
    const t0 = Date.now();
    const rr = await t3.runMacro('run("Macro...", "code=' + code + '");');
    const ms = Date.now() - t0;
    assert.ok(rr.ok, JSON.stringify(rr.error));
    console.log('    macroMath ' + code + ' 512x512 8-bit: ' + ms + ' ms (the jar: ' + (code === 'v=v*2' ? MG.cases['perf-512-times2'].jarMs : MG.cases['perf-512'].jarMs) + ' ms)');
    assert.ok(ms < 20000, 'no hang');
    await t3.runMacro('close();');
  }
  assert.equal(t.net.length + t3.net.length, 0);
  t3.close();
});

finished = true;
console.log(passed + ' passed');
