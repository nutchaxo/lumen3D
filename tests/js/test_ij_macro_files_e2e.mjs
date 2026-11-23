// End to end: ImageJ macros on the user's files (DOCS/studio-advanced/macros/FILES.md §18) through the whole Advanced Studio under Node —
// the real page controller and Macro Editor (Files section, pause strip, pickers on clicks), the real worker (engine, codecs, language,
// ij-macro-vfs.js, ij-proc-macro.js) and the file system fakes (a user folder, OPFS, IndexedDB, the pickers).
//
// Run: node tests/js/test_ij_macro_files_e2e.mjs
process.env.TZ = 'UTC';
// a run that never settles empties the event loop and Node exits 0: count that as a failure
let finished = false;
process.on('exit', (code) => { if (!finished && code === 0) { console.error('FAIL: the test stopped before its end (a promise never settled)'); process.exitCode = 1; } });
import assert from 'node:assert/strict';
import { until } from './ij_harness.mjs';
import { fileBoot, folder, fx, messageBoxes } from './ij_macro_files_e2e_support.mjs';

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok  ' + name); } catch (err) { console.error('FAIL ' + name); throw err; }
}
const lines = (...l) => l.join('\n');
const BS = '\\\\';   // a backslash inside a macro string literal
const arr = (x) => Array.from(x || []);
const NL = String.fromCharCode(10);
const dec = (u8) => new TextDecoder().decode(u8);

/** A 8-bit TIFF written by the Studio's own engine (doc.import + doc.exportTiff). */
async function tiffOf(t, name, w, h, fill) {
  const data = new Uint8Array(w * h);
  for (let i = 0; i < data.length; i++) data[i] = fill(i % w, Math.floor(i / w)) & 0xff;
  const r = await t.engine('doc.import', { image: { name, width: w, height: h, bitDepth: 8, nZ: 1, nT: 1,
    calibration: { pixelWidth: 1, pixelHeight: 1, pixelDepth: 1, unit: 'pixel' },
    channels: [{ name: 'C1', color: '#ffffff', display: { min: 0, max: 255, lut: 'Grays', invert: false }, data }] } });
  const bytes = (await t.engine('doc.exportTiff', { docId: r.docId })).bytes.slice();
  await t.engine('doc.close', { docId: r.docId, discard: true });
  return bytes;
}
const planeOf = (im) => (Array.isArray(im.channels[0].planes) ? im.channels[0].planes[0] : im.channels[0].data);
async function setEditorText(t, text) {
  const ta = await until(() => {
    const out = [];
    const walk = (e) => { if (!e) return; out.push(e); for (const k of e.children || []) walk(k); };
    walk(t.panel('macroEditor'));
    return out.find((e) => e.tagName === 'TEXTAREA') || null;
  }, 'the editor text area');
  ta.value = text;
  for (const f of (ta.listeners.input || []).slice()) f({ target: ta, type: 'input' });
}
/** Starts a run and waits for its pause strip; resolves { run (the pending result), pause }. */
async function runUntilPause(t, src, state) {
  const run = t.runMacro(src);
  const pause = await t.waitPause(state);
  return { run, pause };
}
const noMachinePath = (s) => !/[A-Za-z]:[\\/]|\\\\|\/Users\/|\/home\/[a-z]/.test(String(s));

// ────────────────────────────────────────────────────────────────────────────────────────────────
await test('a folder of five TIFFs: getDirectory queued before Run (one click), getFileList, open, Gaussian Blur, saveAs("Tiff"), close', async () => {
  const t = await fileBoot();
  const fills = { 'a.tif': (x, y) => x * 13 + y * 7, 'b.tif': (x, y) => (x ^ y) * 9, 'c.tif': (x, y) => x * y, 'd.tif': (x) => (x > 8 ? 240 : 10), 'e.tif': (x, y) => 255 - x * 5 - y };
  const tree = { 'notes.txt': 'not an image' };
  for (const [n, fill] of Object.entries(fills)) tree[n] = await tiffOf(t, n, 20, 14, fill);
  const disk = folder('Data', tree);
  await t.grantFolder(disk, { mode: 'allow' });
  const src = lines(
    'dir = getDirectory("Choose a Directory");',
    'list = getFileList(dir);',
    'File.makeDirectory(dir + "out");',
    'for (i = 0; i < list.length; i++) {',
    '  if (endsWith(list[i], ".tif")) {',
    '    open(dir + list[i]);',
    '    run("Gaussian Blur...", "sigma=2");',
    '    saveAs("Tiff", dir + "out/" + list[i]);',
    '    close();',
    '  }',
    '}',
    'print(list.length + " " + getInfo("image.directory"));');
  // the editor's Files section counts the picker of the text and offers it as one click before Run
  await setEditorText(t, src);
  const label = t.tr('dlg.mac.files.queuePick', { prompt: 'Choose a Directory' });
  await until(() => t.findButton(label), 'the queued picker button', 4000);
  assert.ok(t.texts().includes(t.tr('dlg.mac.files.queue', { folders: 1, files: 0 })), 'the Files section says what the macro asks for');
  t.pickers.push('directory', disk.dir());
  await t.click(label);
  await until(() => t.state().queue.folders.length === 1, 'one answer queued');
  const r = await t.runMacro(src);
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.equal(t.pause(), null, 'no pause: the answer came from the queue');
  assert.deepEqual(arr(t.macroLog()), ['6 '], 'getFileList saw the 6 files (listed before out/ was made); no image left open');
  assert.equal(t.state().queue.folders.length, 0, 'the answer was used');
  // the files on the disk equal the interactive command on the same image, opened by the operator's own File › Open
  for (const n of Object.keys(fills)) {
    const out = disk.bytes('out/' + n);
    assert.ok(out, 'out/' + n + ' written');
    const saved = await t.worker.far.IJTiff.read(out, n);
    const before = (await t.docs()).map((d) => d.docId);
    t.pickFile([new fx.FakeFile([tree[n]], n, { lastModified: 1700000000000 })]);
    await t.runCommand('fileOpen');
    const docId = await until(async () => (await t.docs()).map((d) => d.docId).find((id) => !before.includes(id)), 'the operator opened ' + n);
    await until(() => t.activeId() === docId, 'the opened image is active');
    await t.runCommand('filterGaussian', { sigma: 2 });
    const interactive = await t.pixels(docId);
    assert.deepEqual(Array.from(planeOf(saved)), Array.from(interactive), n + ': the macro file equals the interactive Gaussian Blur');
    await t.engine('doc.close', { docId, discard: true });
  }
  assert.deepEqual(arr(r.undo && r.undo.changed), [], 'files are not undo steps; no image left open changed');
  assert.deepEqual(t.net, [], 'no network call');
  t.close();
});

await test('mode Ask: the first overwrite of a run pauses once; Allow for this run, Refuse (macro error at its line), Abort (nothing written after)', async () => {
  const t = await fileBoot();
  const a = await tiffOf(t, 'a.tif', 8, 8, (x, y) => x + y);
  const disk = folder('Data', { 'a.tif': a, 'out/': {}, 'out/a.tif': a, 'out/b.tif': a });
  const root = await t.grantFolder(disk, { mode: 'ask' });
  assert.equal(root.mode, 'ask');
  const src = lines('open("/Data/a.tif");', 'run("Invert");', 'saveAs("Tiff", "/Data/out/a.tif");', 'saveAs("Tiff", "/Data/out/b.tif");', 'File.saveString("x", "/Data/after.txt");', 'print("done");');
  // Allow for this run: one question for the root, then every overwrite of the run goes through
  let s = await runUntilPause(t, src, 'confirm');
  assert.ok(s.pause.text.indexOf('/Data/out/a.tif') >= 0, 'the strip names the file: ' + s.pause.text);
  assert.ok(t.texts().includes(t.tr('dlg.mac.paused')), 'the editor status says the run waits');
  const seq = t.state().pauseSeq;
  await t.click(t.tr('dlg.mac.pause.allowRun'));
  let r = await s.run;
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.equal(t.state().pauseSeq, seq, 'exactly one confirmation for the root in the run');
  assert.deepEqual(arr(t.macroLog()).slice(-1), ['done']);
  assert.notDeepEqual(Array.from(disk.bytes('out/a.tif')), Array.from(a), 'out/a.tif replaced');
  assert.equal(disk.text('after.txt'), 'x');
  // Refuse: a macro error with the path, at the line of the write
  s = await runUntilPause(t, src, 'confirm');
  await t.click(t.tr('dlg.mac.pause.refuse'));
  r = await s.run;
  assert.equal(r.ok, false);
  assert.equal(r.error.message, t.tr('err.macWriteRefused', { path: '/Data/out/a.tif' }));
  assert.equal(r.error.line, 3);
  // Abort: the run stops, nothing after it is written
  const d0 = disk.tree();
  const src2 = src.replace('after.txt', 'after2.txt');
  s = await runUntilPause(t, src2, 'confirm');
  await t.click(t.tr('dlg.mac.pause.abort'));
  r = await s.run;
  assert.equal(r.aborted, true);
  assert.equal(disk.exists('after2.txt'), false, 'nothing written after the abort');
  assert.deepEqual(Object.keys(disk.tree()).sort(), Object.keys(d0).sort());
  assert.equal(t.pause(), null, 'the strip is closed');
  t.close();
});

await test('mode Read-only: every write is refused with the translated text; nothing reaches the disk', async () => {
  const t = await fileBoot();
  const disk = folder('Data', { 'a.txt': 'a' });
  await t.grantFolder(disk, { mode: 'readonly' });
  const before = JSON.stringify(disk.tree());
  const r = await t.runMacro(lines('print(File.exists("/Data/a.txt"));', 'File.saveString("x", "/Data/new.txt");'));
  assert.equal(r.ok, false);
  assert.equal(r.error.message, t.tr('err.macReadOnly', { path: '/Data/new.txt' }));
  assert.equal(r.error.line, 2);
  assert.deepEqual(arr(t.macroLog()), ['1'], 'reading works');
  assert.equal(JSON.stringify(disk.tree()), before);
  t.close();
});

await test('a hard-coded C:\\ path stops the run with the folder to choose; the alias chosen in the Files section makes the same macro work', async () => {
  const t = await fileBoot();
  const a = await tiffOf(t, 'a.tif', 6, 4, (x) => x * 40);
  const src = lines('open("C:' + BS + 'data' + BS + 'run1' + BS + 'a.tif");', 'print(getTitle() + " " + getInfo("image.directory") + " " + File.directory);');
  let r = await t.runMacro(src);
  assert.equal(r.ok, false);
  assert.equal(r.error.message, t.tr('err.macFolderNotGranted', { path: 'C:/data/run1/' }));
  assert.deepEqual(arr(r.vfs && r.vfs.needs).map((n) => n.literal), ['C:/data/run1/']);
  // the Files section offers the folder (deepest level by default); one click on a gesture picks it
  const disk = folder('run1', { 'a.tif': a });
  t.pickers.push('directory', disk.dir());
  await t.click(t.tr('dlg.mac.files.aliasChoose', { literal: 'C:/data/run1/' }));
  await until(() => t.state().aliases.length === 1, 'the alias is stored');
  assert.equal(t.state().aliases[0].literal, 'C:/data/run1/');
  r = await t.runMacro(src);
  assert.equal(r.ok, true, JSON.stringify(r.error));
  const out = arr(t.macroLog()).slice(-1)[0];
  assert.equal(out, 'a.tif /run1/ /run1/');
  assert.ok(noMachinePath(out), 'the macro sees the virtual folder, never C:');
  t.close();
});

await test('a picker beyond the queue pauses the run: Cancel aborts it ("Macro canceled"); Choose… on a click continues', async () => {
  const t = await fileBoot();
  const disk = folder('Pics', { 'x.txt': 'x' });
  const src = lines('d = getDirectory("Pick the input");', 'l = getFileList(d);', 'print("got " + d + " " + l.length);');
  let s = await runUntilPause(t, src, 'pick');
  assert.equal(s.pause.text, 'Pick the input');
  // a picker never opens without a gesture
  t.pickers.push('directory', disk.dir());
  await t.click(t.tr('dlg.mac.pause.choose'), { gesture: false });
  await new Promise((res) => setTimeout(res, 50));
  assert.ok(t.pause(), 'no gesture: no picker, the run still waits');
  await t.click(t.tr('dlg.cancel'));
  let r = await s.run;
  assert.equal(r.aborted, true, 'Cancel = Macro.abort');
  assert.equal(r.error, null);
  assert.deepEqual(arr(t.macroLog()), []);
  s = await runUntilPause(t, src, 'pick');
  await t.click(t.tr('dlg.mac.pause.choose'));
  r = await s.run;
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.deepEqual(arr(t.macroLog()).slice(-1), ['got /Pics/ 1']);
  t.close();
});

await test('File.open / print / File.close write the exact text; a run aborted before File.close still leaves the flushed bytes', async () => {
  const t = await fileBoot();
  const disk = folder('Data', {});
  await t.grantFolder(disk, { mode: 'allow' });
  let r = await t.runMacro(lines('f = File.open("/Data/log.txt");', 'print(f, "a");', 'print(f, "b' + BS.slice(0, 1) + 'n");', 'File.close(f);'));
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.equal(disk.text('log.txt'), 'a' + NL + 'b' + NL);
  const s = await runUntilPause(t, lines('f = File.open("/Data/w.txt");', 'print(f, "kept");', 'd = getDirectory("Wait");'), 'pick');
  t.P.abort();
  r = await s.run;
  assert.equal(r.aborted, true);
  assert.equal(disk.text('w.txt'), 'kept' + NL, 'the writer was flushed at the end of the run');
  t.close();
});

await test('/tmp/: read after write in the same run, kept across runs of one mount, empty after a new mount', async () => {
  const t = await fileBoot();
  let r = await t.runMacro(lines(
    'for (i = 0; i < 200; i++) { File.saveString("v" + i, "/tmp/x.txt"); s = File.openAsString("/tmp/x.txt"); }',
    'print(substring(s, 0, lengthOf(s) - 1) + " " + lengthOf(s));', 'print(File.exists("/tmp/x.txt"));'));
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.deepEqual(arr(t.macroLog()), ['v199 5', '1']);
  r = await t.runMacro('s = File.openAsString("/tmp/x.txt"); print(substring(s, 0, lengthOf(s) - 1));');
  assert.deepEqual(arr(t.macroLog()).slice(-1), ['v199'], 'the second run of the mount reads it');
  t.newMount();
  r = await t.runMacro('print(File.exists("/tmp/x.txt"));');
  assert.deepEqual(arr(t.macroLog()).slice(-1), ['0'], 'a new mount starts with an empty /tmp/');
  assert.equal(t.opfs.openHandles(), 0, 'no sync access handle left open');
  t.close();
});

await test('open() of a file the Studio cannot read shows ImageJ\'s Opener text and stops the macro', async () => {
  const t = await fileBoot();
  const disk = folder('Data', { 'x.xyz': new Uint8Array([1, 2, 3, 250, 251, 252, 253, 0, 0, 7, 8, 9]) });
  await t.grantFolder(disk, { mode: 'allow' });
  const d0 = t.log.dialogSpecs.length;
  const r = await t.runMacro(lines('print("before");', 'open("/Data/x.xyz");', 'print("not reached");'));
  assert.equal(r.aborted, true);
  assert.deepEqual(arr(t.macroLog()), ['before']);
  const boxes = messageBoxes(t, d0);
  assert.equal(boxes.length, 1);
  assert.equal(boxes[0].title, 'Opener');
  assert.ok(boxes[0].text.indexOf('/Data/x.xyz') >= 0 && noMachinePath(boxes[0].text), boxes[0].text);
  t.close();
});

await test('Firefox / Safari: a folder read as a copy; writes go to the browser workspace; 2 files = links, 5 files + a deletion = one ZIP', async () => {
  const t = await fileBoot({ fsa: false });
  assert.ok(t.texts().includes(t.tr('dlg.mac.files.browserNote')), 'the Files section explains the copy');
  const disk = folder('Exp', { 'keep.txt': 'k', 'gone.txt': 'g', 'sub/': {}, 'sub/s.txt': 's' });
  const root = await t.grantFolder(disk, { mode: 'allow' });
  assert.equal(root.kind, 'snapshot');
  let r = await t.runMacro(lines('File.saveString("1", "/Exp/r1.txt");', 'File.saveString("2", "/Exp/sub/r2.txt");',
    'l = getFileList("/Exp/"); print(l.length);'));
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.deepEqual(arr(t.macroLog()), ['4'], 'getFileList shows the workspace file r1.txt beside keep.txt, gone.txt, sub/');
  assert.equal(disk.exists('r1.txt'), false, 'the folder itself is never written');
  assert.deepEqual(arr(r.vfs.changedRoots), [root.id]);
  await t.click(t.tr('dlg.mac.files.download'));
  for (const n of ['r1.txt', 'r2.txt']) await until(() => t.findButton(t.tr('dlg.mac.files.downloadLink', { name: n })), 'the link to ' + n);
  const s0 = t.saved.length;
  await t.click(t.tr('dlg.mac.files.downloadLink', { name: 'r1.txt' }));
  assert.equal(t.saved.length, s0 + 1);
  assert.equal(t.saved[s0].name, 'r1.txt');
  assert.equal(dec(new Uint8Array(await t.saved[s0].blob.arrayBuffer())), '1');
  // three more files and a deletion: the archive, with README.txt for what a ZIP cannot apply
  r = await t.runMacro(lines('for (i = 3; i <= 5; i++) File.saveString("" + i, "/Exp/r" + i + ".txt");', 'print(File.delete("/Exp/gone.txt"));'));
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.deepEqual(arr(t.macroLog()).slice(-1), ['1']);
  // the links of the first delivery went with the new changes; the section counts them again
  await until(() => !t.findButton(t.tr('dlg.mac.files.downloadLink', { name: 'r1.txt' })) && t.texts().includes(t.tr('dlg.mac.files.changes', { n: 6 })), 'the new changes');
  await t.click(t.tr('dlg.mac.files.download'));
  const zipLabel = t.tr('dlg.mac.files.downloadLink', { name: 'Exp-results.zip' });
  await until(() => t.findButton(zipLabel), 'the archive link');
  await t.click(zipLabel);
  const zip = t.saved[t.saved.length - 1];
  assert.equal(zip.name, 'Exp-results.zip');
  const entries = fx.readZip(new Uint8Array(await zip.blob.arrayBuffer()));
  const names = entries.map((e) => e.name).sort();
  assert.deepEqual(names, ['Exp/r1.txt', 'Exp/r3.txt', 'Exp/r4.txt', 'Exp/r5.txt', 'Exp/sub/r2.txt', 'README.txt']);
  const readme = dec(entries.find((e) => e.name === 'README.txt').data);
  assert.ok(readme.indexOf('Exp/gone.txt') >= 0, 'README lists the deletion: ' + readme);
  assert.equal(dec(entries.find((e) => e.name === 'Exp/r4.txt').data), '4');
  assert.deepEqual(t.net, []);
  t.close();
});

await test('not enough browser storage: a write to the workspace ends the macro with the quota text', async () => {
  const t = await fileBoot({ fsa: false, opfs: { quota: 1 << 20 } });
  const disk = folder('Big', { 'a.txt': 'a' });
  await t.grantFolder(disk, { mode: 'allow' });
  const r = await t.runMacro(lines('s = "0123456789abcdef";', 'for (i = 0; i < 17; i++) s = s + s;', 'File.saveString(s, "/Big/huge.txt");'));
  assert.equal(r.ok, false);
  assert.ok(/^Not enough browser storage: .+ written, .+ free$/.test(r.error.message), r.error.message);
  t.close();
});

await test('a folder whose permission came back to "prompt" after a reload: the run pauses; Allow (a click) continues', async () => {
  const t = await fileBoot();
  const disk = folder('Data', { 'a.txt': 'a' });
  await t.grantFolder(disk, { mode: 'allow' });
  disk.setPermission('readwrite', 'prompt');
  disk.setPermission('read', 'prompt');
  disk.answerRequest('granted');
  const s = await runUntilPause(t, lines('File.saveString("b", "/Data/b.txt");', 'print("written");'), 'regrant');
  await t.click(t.tr('dlg.mac.pause.allow'));
  const r = await s.run;
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.equal(disk.text('b.txt'), 'b');
  t.close();
});

await test('run("Open...") without a path pauses for a file; with open= it does not; run("Tiff...", "save=…") writes', async () => {
  const t = await fileBoot();
  const a = await tiffOf(t, 'a.tif', 5, 5, (x, y) => x * y * 9);
  const disk = folder('Data', { 'a.tif': a });
  await t.grantFolder(disk, { mode: 'allow' });
  const s = await runUntilPause(t, lines('run("Open...");', 'print(getTitle());'), 'pick');
  t.pickers.push('openFile', disk.file('a.tif'));
  await t.click(t.tr('dlg.mac.pause.choose'));
  let r = await s.run;
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.deepEqual(arr(t.macroLog()).slice(-1), ['a.tif']);
  r = await t.runMacro(lines('close("*");', 'run("Open...", "open=/Data/a.tif");', 'run("Tiff...", "save=/Data/copy.tif");', 'print(getTitle());'));
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.equal(t.pause(), null);
  assert.deepEqual(arr(t.macroLog()).slice(-1), ['copy.tif']);
  assert.ok(disk.exists('copy.tif'));
  t.close();
});

await test('outside a macro the operator\'s File › Save As › Tiff still downloads through the browser', async () => {
  const t = await fileBoot();
  const r = await t.runMacro('newImage("shown", "8-bit ramp", 8, 8, 1);');
  assert.equal(r.ok, true, JSON.stringify(r.error));
  await until(() => t.isEnabled('fileSaveTiff'), 'Save As › Tiff is enabled on the image the macro left');
  const s0 = t.saved.length;
  await t.runCommand('fileSaveTiff');
  await until(() => t.saved.length > s0, 'a download');
  assert.ok(/\.tif$/.test(t.saved[t.saved.length - 1].name), 'a .tif download');
  t.close();
});

console.log('test_ij_macro_files_e2e: ' + passed + ' passed');
finished = true;
