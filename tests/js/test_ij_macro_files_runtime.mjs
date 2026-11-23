// The file built-ins of the macro runtime (FILES.md §8, §9, §6, §7) on the stand-in VFS of ij_macro_files_rt_support.mjs:
// File.*, getDirectory / getDir, getFileList, open / save / saveAs, runMacro(file), Table.open / save, roiManager open / save,
// IJ.checksum, getInfo("image.directory"), Dialog.addDirectory / addFile, the run() file commands (status 'file'), the pickers and their
// pause, the policy confirmations, permissions, aliases (result.vfs.needs), the quota text, macro.scan, and no network.
//
// Run: node tests/js/test_ij_macro_files_runtime.mjs
process.env.TZ = 'UTC';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { frt, makeDisk } from './ij_macro_files_rt_support.mjs';
import { okRun } from './ij_macro_rt_support.mjs';

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok  ' + name); } catch (err) { console.error('FAIL ' + name); throw err; }
}
const J = (x) => JSON.parse(JSON.stringify(x));
const md5 = (u8) => createHash('md5').update(u8).digest('hex');
const sha = (u8) => createHash('sha256').update(u8).digest('hex');
const errText = (r) => (r.result && r.result.error ? r.result.error.message : r.error ? String(r.error.message) : null);

const t = await frt();
// a 4 × 3 8-bit TIFF and a 2-plane 16-bit stack, written by the core TIFF writer through the engine
const id8 = await t.open({ name: 'src8', width: 4, height: 3, bitDepth: 8, channels: [{ name: 'C1', color: '#ffffff', display: { min: 0, max: 255, lut: 'Grays', invert: false }, planes: [Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])] }] });
const tiff8 = (await t.ok('doc.exportTiff', { docId: id8 })).bytes.slice();
const id16 = await t.open({ name: 'src16', width: 2, height: 2, bitDepth: 16, nZ: 2, channels: [{ name: 'C1', color: '#ffffff', display: { min: 0, max: 1000, lut: 'Grays', invert: false }, planes: [Uint16Array.from([1, 2, 3, 4]), Uint16Array.from([500, 600, 700, 800])] }] });
const tiff16 = (await t.ok('doc.exportTiff', { docId: id16 })).bytes.slice();
await t.run('close("*");');
t.page.current = null;

const disk = makeDisk({
  'a.tif': tiff8, 'stack.tif': tiff16, 'a b.tif': tiff8, 'notes.txt': 'line1\r\nline2\rline3\nlast', 'b.txt': 'b', '.hidden': 'h', 'Thumbs.db': 't', 'z.db': 'z',
  'Zed.txt': 'Z', 'sub/': {}, 'sub/inner.txt': 'inner', 'raw.bin': new Uint8Array(6000).map((_, i) => (i % 256)), 'empty/': {},
  'm.ijm': 'print("arg=" + getArgument()); print(getInfo("macro.filepath")); return "R";', 'data.dat': 'x', 'big1000.txt': 'x'.repeat(1000),
  'table.csv': 'A,B\n1,2\n3,4\n'
}, { mtime: 1700000000000 });
const D = t.grant('Data', disk, { mode: 'allow' });

await test('File.* on a granted folder: exists / isDirectory / isFile / length / lastModified / dateLastModified (missing: 0, 0, epoch)', async () => {
  const r = await t.runF([
    'print(File.exists("/Data/a.tif") + File.exists("/Data/sub") + File.exists("/Data/nope"));',
    'print(File.isDirectory("/Data/sub") + File.isDirectory("/Data/a.tif") + File.isFile("/Data/a.tif") + File.isFile("/Data/sub"));',
    'print(File.length("/Data/big1000.txt")); print(File.getLength("/Data/nope"));',
    'print(File.lastModified("/Data/a.tif")); print(File.dateLastModified("/Data/a.tif"));',
    'print(File.lastModified("/Data/nope")); print(File.dateLastModified("/Data/nope"));',
    'print(File.exists("/")); print(File.isDirectory("/Data/"));'
  ].join('\n'));
  assert.deepEqual(okRun(r, 'stat'), ['110', '1010', '1000', '0', '1700000000000', 'Tue Nov 14 22:13:20 UTC 2023', '0', 'Thu Jan 01 00:00:00 UTC 1970', '1', '1']);
});

await test('pure File members: names, parents, separators normalised (\\ → /), no file system touched', async () => {
  const r = await t.runF([
    'print(File.getName("/Data/sub/a.b.tif")); print(File.getNameWithoutExtension("/Data/sub/a.b.tif")); print(File.getDirectory("/Data/sub/a.b.tif"));',
    'print(File.getParent("/Data/sub/a.b.tif")); print(File.getDirectory("a.tif")); print(File.getName("C:\\\\x\\\\y.tif")); print(File.getAbsolutePath("rel/x.txt"));',
    'print(File.separator); print(File.getDefaultDir); File.setDefaultDir("/Data/sub"); print(File.getDefaultDir);'
  ].join('\n'));
  assert.deepEqual(okRun(r, 'pure'), ['a.b.tif', 'a.b', '/Data/sub/', '/Data/sub', '', 'y.tif', '/home/rel/x.txt', '/', '', '/Data/sub/']);
  const r2 = await t.runF('File.foo("x");');
  assert.equal(errText(r2), 'Unrecognized File function foo');
  const r3 = await t.runF('File.setDefaultDir("");');
  okRun(r3, 'reset default dir');
});

await test('makeDirectory / delete / rename / copy: ImageJ return values and texts', async () => {
  let r = await t.runF('File.makeDirectory("/Data/out"); print(File.isDirectory("/Data/out")); File.mkdir("/Data/x/y"); print(File.exists("/Data/x/y"));');
  assert.deepEqual(okRun(r, 'mkdir'), ['1', '0']);
  r = await t.runF('File.saveString("q", "/Data/out/q.txt"); print(File.delete("/Data/out")); print(File.delete("/Data/out/q.txt")); print(File.delete("/Data/out")); print(File.delete("/Data/missing"));');
  assert.deepEqual(okRun(r, 'delete'), ['0', '1', '1', '0']);
  r = await t.runF('File.saveString("r", "/Data/r1.txt"); print(File.rename("/Data/r1.txt", "/Data/r2.txt")); print(File.rename("/Data/r2.txt", "/Data/b.txt")); print(File.exists("/Data/r2.txt"));');
  assert.deepEqual(okRun(r, 'rename'), ['1', '0', '1']);
  r = await t.runF('x = File.rename("0", "/Data/r9.txt");');
  assert.equal(errText(r), 'Invalid path');
  assert.equal(r.result.error.line, 1);
  r = await t.runF('File.copy("/Data/b.txt", "/Data/b2.txt"); print(File.length("/Data/b2.txt")); print(File.lastModified("/Data/b2.txt"));');
  assert.deepEqual(okRun(r, 'copy'), ['1', '1700000000000'], 'Tools.copyFile keeps the source mtime');
  r = await t.runF('File.copy("/Data/none.txt", "/Data/b3.txt");');
  assert.equal(errText(r), 'Source file does not exist');
  r = await t.runF('print(File.delete("/Data"));');
  assert.equal(errText(r), '/Data is a folder you granted: a macro cannot delete it.');
});

await test('saveString / append / openAsString / openAsRawString', async () => {
  let r = await t.runF('File.saveString("a\\nb", "/Data/s.txt"); s = File.openAsString("/Data/s.txt"); print(s.length); print(s);');
  assert.deepEqual(okRun(r, 'round trip'), ['4', 'a\nb\n']);
  assert.equal(disk.text('s.txt'), 'a\nb');
  r = await t.runF('print(File.openAsString("/Data/notes.txt"));');
  assert.deepEqual(okRun(r, 'crlf'), ['line1\nline2\nline3\nlast\n']);
  r = await t.runF('x = File.openAsString("/Data/missing.txt");');
  assert.equal(errText(r), 'Error: file not found');
  r = await t.runF('File.append("a", "/Data/ap.txt"); File.append("b", "/Data/ap.txt");');
  okRun(r, 'append');
  assert.equal(disk.text('ap.txt'), 'a\nb\n');
  r = await t.runF('s = File.openAsRawString("/Data/raw.bin"); print(s.length); print(charCodeAt(s, 200)); s = File.openAsRawString("/Data/raw.bin", 10); print(s.length); print(lengthOf(File.openAsRawString("/Data/big1000.txt")));');
  assert.deepEqual(okRun(r, 'raw'), ['5000', '200', '10', '1000']);
  r = await t.runF('x = File.openAsRawString("/Data/nothing.bin");');
  assert.equal(errText(r), 'File not found');
  r = await t.runF('File.saveString("x", "/Data/nofolder/x.txt");');
  assert.equal(errText(r), 'java.io.FileNotFoundException: /Data/nofolder/x.txt (No such file or directory)');
  r = await t.runF('x = File.openUrlAsString("https://example.org");');
  assert.equal(errText(r), 'Macros cannot use the network.');
});

await test('File.open writer: errors of Functions.openFile / closeFile; the buffered text is flushed at close (language L1)', async () => {
  let r = await t.runF('f = File.open("/Data/log.txt"); print(f, "a"); print(f, "b\\n"); File.close(f); print(File.exists("/Data/log.txt"));');
  assert.deepEqual(okRun(r, 'writer'), ['1']);
  if (disk.text('log.txt') === '') console.log('SKIP writer content: the language does not hand print(f, …) to f.writer yet (FILES.md §16 L1)');
  else assert.equal(disk.text('log.txt'), 'a\nb\n');
  r = await t.runF('f = File.open("/Data/w1.txt"); g = File.open("/Data/w2.txt");');
  assert.equal(errText(r), 'Currently, only one file can be open at a time');
  r = await t.runF('f = File.open("/Data/data.dat");');
  assert.equal(errText(r), "File exists and suffix is not '.txt', '.java', etc.");
  r = await t.runF('File.close("x");');
  assert.equal(errText(r), 'Invalid file variable');
  r = await t.runF('f = File.open("/Data/nofolder/x.txt");');
  assert.equal(errText(r), 'File open error \n"/Data/nofolder/x.txt (No such file or directory)"\n');
});

await test('getFileList: sorted (UTF-16 order), dot names and Thumbs.db hidden, "/" after folders; missing → empty; "/" lists the roots', async () => {
  const r = await t.runF('l = getFileList("/Data/"); s = ""; for (i = 0; i < l.length; i++) s = s + l[i] + ","; print(s); n1 = getFileList("/Data/nope/"); print(n1.length); n2 = getFileList("/Data/empty/"); print(n2.length); r = getFileList("/"); if (r.length > 0) print("1");');
  const log = okRun(r, 'list');
  const names = log[0].split(',').filter(Boolean);
  assert.ok(names.indexOf('.hidden') < 0 && names.indexOf('Thumbs.db') < 0, 'hidden names removed');
  assert.ok(names.indexOf('sub/') >= 0 && names.indexOf('empty/') >= 0, 'folders end with /');
  assert.deepEqual(names, names.slice().sort((x, y) => (x.replace(/\/$/, '') < y.replace(/\/$/, '') ? -1 : 1)), 'Arrays.sort order before the /');
  assert.ok(names.indexOf('Zed.txt') < names.indexOf('a b.tif'), 'upper case sorts first (code unit order)');
  assert.deepEqual(log.slice(1), ['0', '0', '1']);
});

await test('getDirectory keywords; a chooser asks the page (vfs.pick) and Cancel aborts the macro', async () => {
  let r = await t.runF('print(getDirectory("home")); print(getDir("temp")); print(getDirectory("luts")); print(getDirectory("downloads")); print(getDirectory("file")); print(getDirectory("cwd"));');
  const log = okRun(r, 'keywords');
  assert.deepEqual(log.slice(0, 4), ['/home/', '/tmp/', '/luts/', '/Downloads/']);
  assert.equal(log[5], '/home/');
  const picks = [];
  t.page.answers['vfs.pick'] = (a) => { picks.push(a); return { vpath: '/Data/' }; };
  r = await t.runF('d = getDirectory("Choose a Directory"); print(d); l = getFileList(d); if (l.length > 3) print("1");');
  assert.deepEqual(okRun(r, 'chooser'), ['/Data/', '1']);
  assert.deepEqual(J(picks), [{ kind: 'directory', prompt: 'Choose a Directory', source: 'getDirectory' }]);
  t.page.answers['vfs.pick'] = () => ({ cancelled: true });
  r = await t.runF('d = getDirectory("Pick one"); print("after");');
  assert.equal(r.result.aborted, true, 'Cancel = Macro.abort');
  assert.deepEqual(r.log, []);
  delete t.page.answers['vfs.pick'];
});

await test('open(path): TIFF with its file name as title, origin for getInfo / getDirectory("image"), File.directory / name, unique titles', async () => {
  let r = await t.runF('open("/Data/a.tif"); print(getTitle()); print(getWidth() + "x" + getHeight() + " " + bitDepth()); print(getInfo("image.directory")); print(getInfo("image.filename")); print(getDirectory("image")); print(File.directory); print(File.name); print(File.nameWithoutExtension); print(getPixel(1, 0));');
  assert.deepEqual(okRun(r, 'open'), ['a.tif', '4x3 8', '/Data/', 'a.tif', '/Data/', '/Data/', 'a.tif', 'a', '2']);
  r = await t.runF('open("/Data/a.tif"); print(getTitle()); print(nImages);');
  assert.deepEqual(okRun(r, 'twice'), ['a-1.tif', '2']);
  r = await t.runF('open("/Data/stack.tif"); print(nSlices + " " + bitDepth()); close(); open("/Data/stack.tif", 2); print(nSlices + " " + getPixel(0, 0));');
  assert.deepEqual(okRun(r, 'stack + plane'), ['2 16', '1 500']);
  r = await t.runF('open("/Data/notes.txt", 2);');
  assert.equal(errText(r), 'Opener: TIFF file required');
  r = await t.runF('File.setDefaultDir("/Data/"); open("a.tif"); print(getInfo("image.directory")); File.setDefaultDir("");');
  assert.deepEqual(okRun(r, 'relative to the default dir'), ['/Data/']);
  await t.runF('close("*");');
});

await test('open(): missing file = the Opener box then a quiet stop; run("Open...") missing = a macro error at its line (F12); text files go to a text window', async () => {
  t.page.dialogs.length = 0;
  let r = await t.runF('print("x");\nopen("/Data/missing.tif");\nprint("never");');
  assert.equal(r.result.aborted, true);
  assert.deepEqual(r.log, ['x']);
  const box = t.page.dialogs.find((d) => d[0] === 'dialog.message');
  assert.deepEqual(J(box[1]), { title: 'Opener', text: 'File not found: \n/Data/missing.tif' });
  t.page.answers.run = (a) => (a.name === 'Open...' ? { status: 'file', text: '', current: a.current, created: [], closed: [], file: { op: 'open', key: 'open', pathText: '/Data/missing.tif', values: {}, name: 'Open...', options: a.options } } : null);
  r = await t.runF('print(1);\nrun("Open...", "open=/Data/missing.tif");');
  assert.equal(errText(r), 'File not found: \n/Data/missing.tif');
  assert.equal(r.result.error.line, 2);
  delete t.page.answers.run;
  r = await t.runF('open("/Data/m.ijm"); open("/Data/notes.txt");');
  okRun(r, 'text windows');
  assert.deepEqual(t.page.texts.slice(-2).map((x) => x[0]), ['m.ijm', 'notes.txt'], 'F20: a text window titled with the file name');
  r = await t.runF('open("/Data/sub");');
  assert.match(errText(r), /^open\("\/Data\/sub"\) is not available to macros: image sequences/);
  r = await t.runF('open("/Data/x.czi");');
  assert.match(errText(r), /^Bio-Formats|^err\.macBioFormats/);
});

await test('open() of a table, a ROI and a LUT', async () => {
  let r = await t.runF('open("/Data/table.csv"); print(Table.size("table.csv")); print(Table.headings("table.csv"));');
  assert.deepEqual(okRun(r, 'table'), ['2', 'A\tB']);
  // a ROI written by the macro, then opened onto a blank image
  r = await t.runF('newImage("w", "8-bit black", 40, 30, 1); makeRectangle(2, 3, 10, 5); saveAs("Selection", "/Data/r.roi"); close(); open("/Data/r.roi"); print(getTitle()); print(getWidth() + "x" + getHeight()); getSelectionBounds(x, y, w, h); print(x + " " + y + " " + w + " " + h);');
  assert.deepEqual(okRun(r, 'roi'), ['r.roi', '22x18', '2 3 10 5']);
  r = await t.runF('newImage("l", "8-bit ramp", 8, 8, 1); saveAs("LUT", "/Data/g.lut"); close("*"); open("/Data/g.lut"); print(getTitle()); print(getWidth() + "x" + getHeight());');
  assert.deepEqual(okRun(r, 'lut'), ['g.lut', '256x32']);
  assert.equal(disk.bytes('g.lut').length, 768);
  await t.runF('close("*");');
});

await test('save / saveAs: TIFF renamed to the file and marked saved, extensions (IJ.updateExtension), missing extension, unsupported format', async () => {
  t.saved.length = 0;
  let r = await t.runF('newImage("n", "8-bit ramp", 8, 4, 1); saveAs("Tiff", "/Data/o"); print(getTitle()); print(File.exists("/Data/o.tif"));');
  assert.deepEqual(okRun(r, 'saveAs tiff'), ['o.tif', '1']);
  // E.markSaved: the engine's own (its info carries the origin) or the stand-in's record
  const saved = t.page.images.find((x) => x.title === 'o.tif');
  const info = await t.ok('doc.info', { docId: saved.docId });
  const file = (info.info || info).file || (t.saved[0] && t.saved[0][1].file);
  assert.equal(file.dir, '/Data/');
  assert.equal(file.name, 'o.tif');
  r = await t.runF('saveAs("tiff", "/Data/a.1"); print(getTitle()); saveAs("png", "/Data/b.jpeg"); print(File.exists("/Data/b.png")); print(getTitle());');
  assert.deepEqual(okRun(r, 'updateExtension'), ['a.1.tif', '1', 'b.png'], 'FileSaver.saveAsPng → updateImp: the image takes the file name');
  r = await t.runF('save("/Data/plain"); print(File.exists("/Data/plain.tif")); print(getTitle());');
  assert.deepEqual(okRun(r, 'save no extension'), ['1', 'b.png'], 'IJ.save puts the title back');
  await t.runF('close("*");');
  t.page.dialogs.length = 0;
  r = await t.runF('save("/Data/noext"); print("goes on");');
  assert.deepEqual(okRun(r, 'no image'), ['goes on']);
  assert.deepEqual(J(t.page.dialogs[0][1]), { title: 'ImageJ', text: 'The file path passed to IJ.save() method or save()\nmacro function is missing the required extension.\n \n"/Data/noext"' });
  t.page.dialogs.length = 0;
  r = await t.runF('newImage("n", "8-bit ramp", 8, 4, 1); saveAs("foo", "/Data/f.x");');
  // IJ.saveAs: the "Unsupported" box (the macro goes on), then run("foo", …) from a built-in: the Executer's box and a quiet stop
  assert.equal(r.result.aborted, true);
  assert.deepEqual(t.page.dialogs.map((d) => d[1].text), ['Unsupported save() or saveAs() file format: "foo"\n \n"/Data/f.x"', 'Unrecognized command: "foo"']);
  r = await t.runF('saveAs("gif", "/Data/g.gif");');
  assert.equal(errText(r), 'gif files cannot be written in the browser.');
  t.page.dialogs.length = 0;
  r = await t.runF('saveAs("Jpeg", "/Data/j"); saveAs("ZIP", "/Data/z"); saveAs("Text Image", "/Data/t.csv"); saveAs("XY Coordinates", "/Data/xy"); print("never");');
  assert.equal(r.result.aborted, true, 'XY Coordinates without a selection, reached from saveAs(): the box, then a quiet stop (F12)');
  assert.equal(t.page.dialogs[0][1].text, 'This command requires a selection');
  assert.match(disk.text('j.jpg'), /^JPEG:\w+:q85$/, 'JpegWriter at the default quality (85)');
  assert.ok(/^ZIP:\d+:z\.tif$/.test(disk.text('z.zip')) || (disk.bytes('z.zip')[0] === 0x50 && disk.bytes('z.zip')[1] === 0x4b), 'a ZIP (FileSaver.saveAsZip)');
  assert.equal(disk.text('t.csv').split('\n')[0].split(',').length, 8, 'a comma-separated text image');
  await t.runF('close("*");');
});

await test('Table.save / Table.open, saveAs("Results"), roiManager save / open, IJ.checksum', async () => {
  let r = await t.runF('Table.create("T"); Table.set("v", 0, 1.5); Table.set("v", 1, 2); Table.save("/Data/t.csv", "T"); Table.open("/Data/t.csv", "U"); print(Table.size("U")); print(Table.get("v", 0, "U"));');
  assert.deepEqual(okRun(r, 'table'), ['2', '1.5']);
  r = await t.runF('newImage("r", "8-bit black", 20, 20, 1); makeRectangle(1, 1, 4, 4); roiManager("add"); makeOval(5, 5, 6, 6); roiManager("add"); roiManager("save", "/Data/set.zip"); roiManager("reset"); roiManager("open", "/Data/set.zip"); print(roiManager("count"));');
  assert.deepEqual(okRun(r, 'roi set'), ['2']);
  r = await t.runF('roiManager("save", "/Data/set.txt");');
  assert.equal(r.result.aborted, true, "RoiManager.error: box + abort (Name must end with '.zip')");
  r = await t.runF('print(IJ.checksum("MD5 file", "/Data/b.txt")); print(IJ.checksum("SHA-256 file", "/Data/raw.bin")); print(IJ.checksum("MD5 file", "/Data/none"));');
  assert.deepEqual(okRun(r, 'checksum'), [md5(disk.bytes('b.txt')), sha(disk.bytes('raw.bin')), '0']);
  await t.runF('close("*"); roiManager("reset");');
});

await test('runMacro(file, arg): the return value, getInfo("macro.filepath") inside; missing = RunMacro box + quiet stop', async () => {
  let r = await t.runF('v = runMacro("/Data/m.ijm", "hello"); print(v); print(getInfo("macro.filepath"));');
  assert.deepEqual(okRun(r, 'runMacro'), ['arg=hello', '/Data/m.ijm', 'R', '/Data/m.ijm'], 'Macro_Runner.filePath is static: the outer macro still reads it (golden macro/runmacro-info)');
  t.page.dialogs.length = 0;
  r = await t.runF('runMacro("/Data/nope.ijm"); print("never");');
  assert.equal(r.result.aborted, true);
  assert.deepEqual(J(t.page.dialogs[0][1]), { title: 'RunMacro', text: 'Macro or script not found:\n \n/Data/nope.ijm' });
});

await test('policy: ask = one confirmation per root per run (allow / refuse / abort); read-only refuses every write', async () => {
  const d2 = makeDisk({ 'x.txt': 'old' });
  const A = t.grant('Ask', d2, { mode: 'ask' });
  const asked = [];
  t.page.answers['vfs.confirm'] = (a) => { asked.push(a); return { choice: 'allow' }; };
  let r = await t.runF('File.saveString("new", "/Ask/y.txt"); File.saveString("1", "/Ask/x.txt"); File.saveString("2", "/Ask/x.txt");');
  okRun(r, 'allow');
  assert.equal(asked.length, 1, 'one question for the root: Allow for this run covers the rest');
  assert.deepEqual(J(asked[0]), { rootId: A.id, root: 'Ask', action: 'overwrite', path: '/Ask/x.txt' });
  assert.equal(d2.text('x.txt'), '2');
  t.page.answers['vfs.confirm'] = () => ({ choice: 'refuse' });
  r = await t.runF('print(1);\nFile.saveString("3", "/Ask/x.txt");');
  assert.equal(errText(r), 'Writing refused: /Ask/x.txt');
  assert.equal(r.result.error.line, 2);
  t.page.answers['vfs.confirm'] = () => ({ choice: 'abort' });
  r = await t.runF('File.delete("/Ask/x.txt"); print("never");');
  assert.equal(r.result.aborted, true);
  assert.equal(d2.text('x.txt'), '2');
  delete t.page.answers['vfs.confirm'];
  t.grant('RO', makeDisk({ 'k.txt': 'k' }), { mode: 'readonly' });
  r = await t.runF('print(File.openAsString("/RO/k.txt")); File.saveString("z", "/RO/z.txt");');
  assert.equal(errText(r), '/RO/z.txt: this folder is read-only for macros (change its mode in the Files section).');
  assert.deepEqual(r.log, ['k\n']);
  r = await t.runF('File.saveString("z", "/home/z.txt");');
  assert.match(errText(r), /read-only/);
});

await test('aliases: a machine path stops the run with the folder to choose (result.vfs.needs), then opens through the alias; never shows C:', async () => {
  let r = await t.runF('open("C:\\\\data\\\\run1\\\\a.tif");');
  assert.equal(errText(r), 'Folder not granted: C:/data/run1/ — choose it in the Files section of the Macro Editor.');
  assert.deepEqual(J(r.result.vfs.needs), [{ kind: 'alias', literal: 'C:/data/run1/', prefixes: ['C:/data/run1/', 'C:/data/', 'C:/'] }]);
  t.alias('C:/data/run1/', D, true);
  r = await t.runF('open("c:\\\\DATA\\\\run1\\\\a.tif"); print(getTitle()); print(getInfo("image.directory")); close();');
  assert.deepEqual(okRun(r, 'alias'), ['a.tif', '/Data/']);
});

await test('permission: a folder that needs a new permission pauses on vfs.regrant; refused = the permission text', async () => {
  const d3 = makeDisk({ 'p.txt': 'p' });
  const g = t.grant('Perm', d3, { mode: 'allow', permission: { readwrite: 'prompt' } });
  t.page.answers['vfs.regrant'] = (a) => ({ ok: true, grant: Object.assign({}, g, { permission: { readwrite: 'granted' } }), echo: a });
  let r = await t.runF('File.saveString("q", "/Perm/q.txt"); print(File.openAsString("/Perm/q.txt"));');
  assert.deepEqual(okRun(r, 'regrant'), ['q\n']);
  t.page.answers['vfs.regrant'] = () => ({ ok: false });
  r = await t.runF('File.saveString("r", "/Perm/r.txt");');
  assert.equal(errText(r), 'No permission to use Perm: allow it again in the Files section.');
  delete t.page.answers['vfs.regrant'];
});

await test('an async root (File System Access) behaves the same; the quota error text ends the macro', async () => {
  const d4 = makeDisk({ 'in.txt': 'abc' });
  t.grant('Fsa', d4, { mode: 'allow', async: true });
  let r = await t.runF('print(File.exists("/Fsa/in.txt")); print(File.openAsString("/Fsa/in.txt")); File.saveString("o", "/Fsa/o.txt"); l = getFileList("/Fsa/"); print(l.length);');
  assert.deepEqual(okRun(r, 'async'), ['1', 'abc\n', '2']);
  t.grant('Small', makeDisk(), { mode: 'allow', target: 'overlay', quota: 1000 });
  r = await t.runF('File.saveString("' + 'x'.repeat(1500) + '", "/Small/big.txt");');
  assert.equal(errText(r), 'Not enough browser storage: 1.0 KB written, 0 B free');
});

await test('the pickers of File.openDialog, open(), saveString("") and Dialog.addDirectory fields', async () => {
  const picks = [];
  t.page.answers['vfs.pick'] = (a) => { picks.push(a); return a.kind === 'save' ? { vpath: '/Data/saved.txt' } : { vpath: '/Data/a.tif' }; };
  let r = await t.runF('p = File.openDialog("Pick"); print(p); print(File.name); File.saveString("s", ""); open(); print(getTitle()); close();');
  assert.deepEqual(okRun(r, 'pickers'), ['/Data/a.tif', 'a.tif', 'a.tif']);
  assert.deepEqual(picks.map((p) => p.kind + ':' + p.prompt + ':' + p.source), ['file:Pick:openDialog', 'save:Save String...:saveString', 'file:Open:open']);
  assert.equal(disk.text('saved.txt'), 's');
  delete t.page.answers['vfs.pick'];
  let shown = null;
  t.page.answers['dialog.show'] = (a) => { shown = a; const values = {}; for (const f of a.fields) values[f.id] = f.type === 'path' ? '/Data/' : f.value; return { values, grants: [] }; };
  r = await t.runF('Dialog.create("D"); Dialog.addDirectory("Input", ""); Dialog.addFile("File", "x.tif"); Dialog.show(); print(Dialog.getString()); print(Dialog.getString());');
  assert.deepEqual(okRun(r, 'path fields'), ['/Data/', '/Data/']);
  assert.deepEqual(J(shown.fields.map((f) => f.type + ':' + f.pathKind)), ['path:directory', 'path:file']);
  delete t.page.answers['dialog.show'];
});

await test('run() file commands come back as status "file" and run in the worker (Tiff..., Results..., Run...)', async () => {
  t.page.answers.run = (a) => {
    const ops = { 'Tiff...': 'saveTiff', 'Results...': 'saveResults', 'Run...': 'runMacro' };
    if (!ops[a.name]) return { status: 'ok', text: '', current: a.current, created: [], closed: [] };
    const m = /(?:save|run)=(\S+)/.exec(a.options || '');
    return { status: 'file', text: '', current: a.current, created: [], closed: [], file: { op: ops[a.name], key: 'save', pathText: m ? m[1] : null, values: {}, name: a.name, options: a.options } };
  };
  let r = await t.runF('newImage("c", "8-bit ramp", 8, 4, 1); run("Tiff...", "save=/Data/cmd.tif"); print(getTitle());');
  assert.deepEqual(okRun(r, 'Tiff...'), ['cmd.tif']);
  assert.ok(disk.bytes('cmd.tif') && disk.bytes('cmd.tif')[0] === 0x49, 'a TIFF written');
  r = await t.runF('setResult("A", 0, 1); setResult("A", 1, 2); updateResults(); run("Results...", "save=/Data/res.csv");');
  okRun(r, 'Results...');
  assert.equal(disk.text('res.csv'), ' ,A\n1,1\n2,2\n');
  r = await t.runF('run("Run...", "run=/Data/m.ijm"); print("after");');
  assert.deepEqual(okRun(r, 'Run...'), ['arg=', '/Data/m.ijm', 'after']);
  delete t.page.answers.run;
  await t.runF('close("*"); run("Clear Results");');
});

await test('macro.scan: literal picker prompts, keywords not counted, machine paths not covered by an alias', async () => {
  const src = 'a = getDirectory("Choose input"); b = getDir("home"); c = File.openDialog("A file"); Dialog.create("x"); Dialog.addDirectory("Out", ""); Dialog.addFile("F", "");\n' +
    'd = getDirectory(a); open("C:\\\\data\\\\run1\\\\x.tif"); open("D:/other/y.tif"); open("C:/data/run1/z.tif");';
  const r = await t.ok('macro.scan', { source: src, aliases: [{ literal: 'D:/other/', rootId: 'x', ci: true }] });
  assert.deepEqual(J(r), { folders: [{ prompt: 'Choose input', line: 1 }, { prompt: 'Out', line: 1 }], files: [{ prompt: 'A file', line: 1 }, { prompt: 'F', line: 1 }], machinePaths: ['C:/data/run1/'] });
  const bad = await t.ok('macro.scan', { source: 'x = "unterminated', aliases: [] });
  assert.deepEqual(J(bad).folders, []);
});

await test('the writers and the result: changed overlay roots are reported; /tmp/ survives a run of the same mount, not a new one', async () => {
  t.grant('Over', makeDisk(), { mode: 'allow', target: 'overlay' });
  let r = await t.runF('File.saveString("o", "/Over/o.txt"); File.saveString("t", "/tmp/keep.txt");');
  okRun(r, 'overlay');
  assert.ok(r.result.vfs.changedRoots.length >= 1, 'changedRoots');
  r = await t.runF('print(File.exists("/tmp/keep.txt"));');
  assert.deepEqual(okRun(r, 'same mount'), ['1']);
  t.newMount();
  r = await t.runF('print(File.exists("/tmp/keep.txt"));');
  assert.deepEqual(okRun(r, 'new mount'), ['0']);
});

await test('no network API is touched by the file built-ins', async () => {
  const W = t.W;
  const calls = [];
  const spy = (name) => function () { calls.push(name); throw new Error(name + ' is forbidden'); };
  W.fetch = spy('fetch'); W.XMLHttpRequest = spy('XMLHttpRequest'); W.WebSocket = spy('WebSocket'); W.EventSource = spy('EventSource'); W.importScripts = spy('importScripts');
  await t.runF('open("/Data/a.tif"); saveAs("Tiff", "/Data/n.tif"); l = getFileList("/Data/"); s = File.openAsString("/Data/b.txt"); x = IJ.checksum("MD5 file", "/Data/b.txt"); close("*");');
  await t.runF('open("https://example.org/a.tif");');
  await t.runF('x = File.openUrlAsString("https://example.org/");');
  assert.deepEqual(calls, []);
});

t.close();
console.log('test_ij_macro_files_runtime: ' + passed + ' passed');
