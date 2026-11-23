// Regression tests of the review of macro files (DOCS/studio-advanced/macros/REVIEW-files.md): one block per fixed finding, named
// after it (F = imagej-fidelity, S = security-privacy, R = robustness-compat). Pure parts run on the modules alone; the rest goes
// through the whole Advanced Studio under Node (tests/js/ij_macro_files_e2e_support.mjs fileBoot: real page, real worker, the
// file system fakes).
//
// Run: node tests/js/test_ij_macro_files_review.mjs
process.env.TZ = 'UTC';
let finished = false;
process.on('exit', (code) => { if (!finished && code === 0) { console.error('FAIL: the test stopped before its end (a promise never settled)'); process.exitCode = 1; } });
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import zlib from 'node:zlib';
import { ROOT } from './harness.mjs';
import { until, sleep } from './ij_harness.mjs';
import { loadIo } from './ij_io_support.mjs';
import { FakeFileReaderSync, makeFakeDisk, makeFakeOpfs, makeSnapshot } from './ij_macro_fs_fakes.mjs';
import { fileBoot, folder } from './ij_macro_files_e2e_support.mjs';

const DIR = path.join(ROOT, 'js', 'modules', 'studio', 'advanced-studio');
let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok  ' + name); } catch (err) { console.error('FAIL ' + name); throw err; }
}
const lines = (...l) => l.join('\n');
const NL = '\n';
const dec = (u8) => new TextDecoder().decode(u8);
// values of another vm realm compared by structure
const plain = (x) => JSON.parse(JSON.stringify(x));
const fire = (e, type, extra) => {
  for (const f of ((e.listeners && e.listeners[type]) || []).slice()) f(Object.assign({ target: e, currentTarget: e, type, preventDefault() {}, stopPropagation() {} }, extra || {}));
};
async function codeOf(p) {
  try { await (typeof p === 'function' ? p() : p); } catch (e) { return e.code || e.name; }
  return 'no error';
}
/** One fresh Studio with the folder `Data` granted in mode allow; `log(src)` runs a macro and returns its Log lines. */
async function studio(tree, o = {}) {
  const t = await fileBoot(o);
  const disk = folder('Data', tree || {});
  await t.grantFolder(disk, { mode: o.mode || 'allow' });
  const log = async (src) => {
    const r = await t.runMacro(lines('print("\\\\Clear");', src));
    assert.equal(r.ok, true, JSON.stringify(r.error));
    return Array.from(t.macroLog());
  };
  return { t, disk, log };
}

// ───────────────────────────────────────────── VFS module (pure, own realm)
const VFS_SRC = fs.readFileSync(path.join(DIR, 'ij-macro-vfs.js'), 'utf8');
function vfsRealm() {
  const ctx = vm.createContext({ console, setTimeout, clearTimeout, TextEncoder, TextDecoder, Blob, FileReaderSync: FakeFileReaderSync });
  vm.runInContext(VFS_SRC, ctx, { filename: 'ij-macro-vfs.js' });
  return ctx.IJMacroVFS;
}
/** A Web Locks manager shared by the "tabs" of one test: request() holds until the callback's promise settles. */
function makeLocks() {
  const held = new Map();
  return {
    held,
    request(name, cb) {
      held.set(name, (held.get(name) || 0) + 1);
      return Promise.resolve(cb({ name, mode: 'exclusive' })).finally(() => { const n = held.get(name) - 1; if (n) held.set(name, n); else held.delete(name); });
    },
    async query() { return { held: Array.from(held.keys(), (name) => ({ name, mode: 'exclusive' })), pending: [] }; }
  };
}
const SNAP_ID = 'aaaaaaaaaaaaaaaa';
const snapGrant = (tree) => ({ id: SNAP_ID, name: 'snap', kind: 'snapshot', target: 'overlay', mode: 'allow', folderName: 'snap', snapshot: makeSnapshot('snap', tree) });
async function openIn(V, o) {
  const vfs = V.open({ roots: o.roots || [], aliases: [], mountId: o.mountId || 'mount-1', opfs: o.opfs ? () => o.opfs.storage.getDirectory() : null,
    now: o.now || (() => 1700000500000), locks: o.locks === undefined ? null : o.locks, estimate: o.opfs ? () => o.opfs.storage.estimate() : undefined });
  await vfs.prepare();
  return vfs;
}

await test('R2: the overlay manifest is written in two slots; a newer record cut short leaves the older one in use', async () => {
  const V = vfsRealm();
  const opfs = makeFakeOpfs({});
  const tree = { 'old.txt': 'O', 'gone.txt': 'G', 'keep.txt': 'K' };
  let vfs = await openIn(V, { opfs, roots: [snapGrant(tree)] });
  await vfs.rename('/snap/old.txt', '/snap/new.txt');
  await vfs.remove('/snap/gone.txt');
  await vfs.close();
  vfs = await openIn(V, { opfs, roots: [snapGrant(tree)], mountId: 'mount-2' });
  await vfs.write('/snap/later.txt', 'L');
  await vfs.close();
  const slot = (n) => { const b = opfs.bytes('lumen3d-ij-macro/ws/' + SNAP_ID + '/' + n); return b ? JSON.parse(dec(b)) : null; };
  const a = slot('manifest.json'), b = slot('manifest.json.1');
  assert.ok(a && b, 'both slots written');
  assert.deepEqual([a.seq, b.seq].sort(), [1, 2]);
  const newest = a.seq > b.seq ? 'manifest.json' : 'manifest.json.1';
  // the next write is cut mid-string (quota, a killed worker): the newest slot holds garbage
  const ws = await (await (await opfs.root.getDirectoryHandle('lumen3d-ij-macro')).getDirectoryHandle('ws')).getDirectoryHandle(SNAP_ID);
  const w = await (await ws.getFileHandle(newest)).createWritable();
  await w.write('{"v":1,"rootId":"' + SNAP_ID + '","renames":[{"from":"old.txt","to":"new.txt","dir');
  await w.close();
  const err = console.error; console.error = () => {};
  try { vfs = await openIn(V, { opfs, roots: [snapGrant(tree)], mountId: 'mount-3' }); } finally { console.error = err; }
  const names = (await vfs.list('/snap')).map((x) => x.name).sort();
  assert.ok(names.includes('new.txt') && !names.includes('old.txt'), 'the rename survives: ' + names);
  assert.ok(!names.includes('gone.txt'), 'the deletion survives');
  const ch = await vfs.changes(SNAP_ID);
  assert.deepEqual(plain(ch.deleted), ['gone.txt']);
  assert.deepEqual(plain(ch.renamed), [{ from: 'old.txt', to: 'new.txt' }]);
  await vfs.close();
});

await test('R10: an overlay write cut short by the quota leaves the intact base file visible, not a truncated copy to download', async () => {
  const V = vfsRealm();
  const opfs = makeFakeOpfs({ quota: 2000 });
  const orig = new Uint8Array(3000).fill(66);
  let vfs = await openIn(V, { opfs, roots: [snapGrant({ 'a.tif': orig })] });
  assert.equal(await codeOf(vfs.write('/snap/a.tif', new Uint8Array(3000).fill(65))), 'VFS_QUOTA');
  assert.equal((await vfs.stat('/snap/a.tif')).size, 3000);
  assert.equal((await vfs.read('/snap/a.tif'))[0], 66);
  assert.deepEqual(plain((await vfs.changes(SNAP_ID)).files), []);
  await vfs.close();
  vfs = await openIn(V, { opfs, roots: [snapGrant({ 'a.tif': orig })], mountId: 'mount-2' });
  assert.equal((await vfs.stat('/snap/a.tif')).size, 3000);
  await vfs.close();
});

await test('R3 + R9: /tmp/ is one folder per mount, held by a Web Lock; another tab neither clears nor sees it; a mount nobody holds is collected; the marker is outside /tmp/', async () => {
  const opfs = makeFakeOpfs({});
  const locks = makeLocks();
  const tabA = vfsRealm(), tabB = vfsRealm();
  let a = await openIn(tabA, { opfs, mountId: 'A', locks });
  await a.write('/tmp/a.txt', 'one');
  await a.close();
  // a mount whose worker is gone (its lock released), and a file of the old one-folder layout
  const tmpDir = await (await opfs.root.getDirectoryHandle('lumen3d-ij-macro')).getDirectoryHandle('tmp');
  await (await tmpDir.getDirectoryHandle('C', { create: true })).getFileHandle('c.txt', { create: true });
  await tmpDir.getFileHandle('loose.txt', { create: true });
  const b = await openIn(tabB, { opfs, mountId: 'B', locks });
  assert.deepEqual(plain(await b.list('/tmp/')), [], 'tab B starts empty');
  assert.equal(await b.stat('/tmp/a.txt'), null, 'tab B does not see tab A');
  await b.write('/tmp/.mount', 'mine');
  assert.equal(dec(await b.read('/tmp/.mount')), 'mine', 'every name under /tmp/ is the macro\'s');
  assert.deepEqual(plain((await b.list('/tmp/')).map((x) => x.name)), ['.mount']);
  await b.close();
  const left = Object.keys(opfs.tree('lumen3d-ij-macro/tmp/')).map((k) => k.split('/')[0]).filter((k, i, all) => all.indexOf(k) === i).sort();
  assert.deepEqual(left, ['A', 'B'], 'mount C and the loose file were collected, A (held by tab A) and B kept: ' + left);
  a = await openIn(tabA, { opfs, mountId: 'A', locks });
  assert.equal(dec(await a.read('/tmp/a.txt')), 'one', 'tab A keeps its /tmp/ after tab B opened');
  // tab A's Studio is opened again (a new mount): its old folder goes, tab B's stays
  await a.close();
  a = await openIn(tabA, { opfs, mountId: 'A2', locks });
  assert.deepEqual(plain(await a.list('/tmp/')), []);
  await a.close();
  const after = Object.keys(opfs.tree('lumen3d-ij-macro/tmp/')).map((k) => k.split('/')[0]).filter((k, i, all) => all.indexOf(k) === i).sort();
  assert.deepEqual(after, ['A2', 'B']);
  assert.ok(locks.held.has('lumen3d-ij-tmp-B') && locks.held.has('lumen3d-ij-tmp-A2') && !locks.held.has('lumen3d-ij-tmp-A'), 'the lock of the mount left is released');
});

await test('R4: an append to an in-place Chromium folder is a slow append (the tick waits), the workspace and /tmp/ are not', async () => {
  const V = vfsRealm();
  const opfs = makeFakeOpfs({});
  const disk = makeFakeDisk({ 'a.txt': 'A' }, { name: 'data' });
  const vfs = await openIn(V, { opfs, roots: [{ id: '0123456789abcdef', name: 'data', kind: 'fsa', target: 'inplace', mode: 'allow', folderName: 'data', handle: disk.dir() }, snapGrant({})] });
  assert.equal(vfs.slowAppend('/data/log.txt'), true);
  assert.equal(vfs.slowAppend('/snap/log.txt'), false);
  assert.equal(vfs.slowAppend('/tmp/log.txt'), false);
  assert.equal(vfs.slowAppend('/nowhere/x'), false);
  await vfs.close();
});

await test('S4 / R6: a read larger than the room the caller gives is refused before a byte is read', async () => {
  const reads = [];
  const ctx = vm.createContext({ console, setTimeout, clearTimeout, TextEncoder, TextDecoder, Blob,
    FileReaderSync: class extends FakeFileReaderSync { readAsArrayBuffer(b) { reads.push(b.size); return super.readAsArrayBuffer(b); } } });
  vm.runInContext(VFS_SRC, ctx, { filename: 'ij-macro-vfs.js' });
  const vfs = await openIn(ctx.IJMacroVFS, { opfs: makeFakeOpfs({}), roots: [snapGrant({ 'big.raw': new Uint8Array(4096) })] });
  assert.equal(await codeOf(() => vfs.read('/snap/big.raw', { offset: 0, length: -1, max: 1000 })), 'VFS_TOO_LARGE');
  assert.deepEqual(reads, [], 'nothing allocated');
  assert.equal((await vfs.read('/snap/big.raw', { offset: 0, length: -1, max: 4096 })).length, 4096);
  await vfs.close();
});

// ───────────────────────────────────────────── codecs (pure)
function pngOf(w, h, depth, ctype, idat) {
  const chunk = (type, body) => {
    const out = Buffer.alloc(12 + body.length);
    out.writeUInt32BE(body.length, 0); out.write(type, 4, 'latin1'); body.copy(out, 8);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = depth; ihdr[9] = ctype;
  return new Uint8Array(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]));
}
await test('S1: a 16-bit PNG whose data inflates past its header is stopped; the room is asked before inflating', async () => {
  const io = loadIo({ DecompressionStream, CompressionStream });
  const P = io.IJPng;
  const bomb = pngOf(1, 1, 16, 0, zlib.deflateSync(Buffer.alloc(8 * 1048576)));
  const rooms = [];
  assert.equal(await codeOf(() => P.decode16(bomb, { room: (n) => rooms.push(n) })), 'IJ_IO_DECODE');
  assert.equal(rooms.length, 1);
  assert.ok(rooms[0] < 64 * 1024, 'the room asked is the header\'s size, not the bomb\'s: ' + rooms[0]);
  // a room refused stops the decode before anything is inflated
  const ok = pngOf(4, 2, 16, 0, zlib.deflateSync(Buffer.alloc(2 * (1 + 8))));
  assert.equal(await codeOf(() => P.decode16(ok, { room: () => { throw Object.assign(new Error('x'), { code: 'IJ_OVER_BUDGET' }); } })), 'IJ_OVER_BUDGET');
  const img = await P.decode16(ok, { room: () => {} });
  assert.deepEqual(plain([img.width, img.height]), [4, 2]);
});

function zipOf(entries) {
  const locals = [], central = [];
  let off = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const raw = Buffer.from(e.data);
    const body = e.deflate ? zlib.deflateRawSync(raw) : raw;
    const usize = e.declared !== undefined ? e.declared : raw.length;
    const crc = zlib.crc32 ? zlib.crc32(raw) : 0;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(e.deflate ? 8 : 0, 8);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(body.length, 18); lh.writeUInt32LE(usize, 22); lh.writeUInt16LE(name.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(e.deflate ? 8 : 0, 10);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(body.length, 20); ch.writeUInt32LE(usize, 24); ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(off, 42);
    locals.push(lh, name, body); central.push(ch, name);
    off += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return new Uint8Array(Buffer.concat([...locals, cd, end]));
}
await test('S2: open() of a ZIP inflates its first entry only; the total of the entries is checked before inflating; an entry larger than declared stops', async () => {
  const io = loadIo({ DecompressionStream, CompressionStream });
  const C = io.IJRoiCodec;
  const zip = zipOf([{ name: 'a.tif', data: Buffer.from('TIFF') }, ...[1, 2, 3].map((i) => ({ name: 'pad' + i + '.bin', data: Buffer.alloc(1048576), deflate: true }))]);
  const inflated = [];
  const inflateRaw = (b, max) => { inflated.push(max); return new Uint8Array(zlib.inflateRawSync(Buffer.from(b))); };
  const one = await C.zipRead(zip, { inflateRaw, only: (n) => n === 'a.tif', maxTotal: 100 });
  assert.deepEqual(plain(one.map((e) => e.name)), ['a.tif']);
  assert.deepEqual(inflated, [], 'the deflated padding is never inflated');
  assert.equal(await codeOf(() => C.zipRead(zip, { inflateRaw, maxTotal: 2 * 1048576 })), 'IJ_IO_TOO_LARGE');
  assert.deepEqual(inflated, [], 'refused from the central directory');
  // an entry declaring 16 bytes and inflating to 1 MiB: the browser's stream stops at the declared size
  const liar = zipOf([{ name: 'x.roi', data: Buffer.alloc(1048576), deflate: true, declared: 16 }]);
  assert.equal(await codeOf(() => C.zipRead(liar, { inflateRaw: C.inflateRaw })), 'IJ_IO_ZIP_BAD');
});

// ───────────────────────────────────────────── Studio end to end
await test('R1: the golden file prints no SKIP line for the cases Node cannot run (run_all.py --strict-skips)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'tests', 'js', 'test_ij_macro_files_golden.mjs'), 'utf8');
  const skips = src.split('\n').filter((l) => /console\.log\(\s*['"`]SKIP/.test(l));
  assert.equal(skips.length, 1, 'only the "golden file absent" SKIP remains: ' + skips.join(' | '));
  assert.ok(/files-golden\.json is absent/.test(skips[0]));
});

await test('F1 + F2: a SaveDialog / OpenDialog in macro mode sets File.name and File.directory; saveAs("Tiff", path) and saveString do not', async () => {
  const lut = new Uint8Array(768);
  for (let i = 0; i < 256; i++) { lut[i] = i; lut[256 + i] = 255 - i; lut[512 + i] = i >> 1; }
  const { t, log } = await studio({ 'note.txt': 'hello' + NL, 'r.csv': 'A' + NL + '1' + NL, 'fire.lut': lut });
  const out = await log(lines(
    'newImage("img", "8-bit ramp", 16, 16, 1);',
    'saveAs("ZIP", "/Data/z.zip"); print("[" + File.name + "][" + File.directory + "]");',
    'setResult("A", 0, 1); saveAs("Results", "/Data/r2.csv"); print("[" + File.name + "]");',
    'saveAs("Text Image", "/Data/ti.txt"); print("[" + File.name + "]");',
    'saveAs("Tiff", "/Data/t.tif"); print("[" + File.name + "]");',
    'File.saveString("x", "/Data/s.txt"); print("[" + File.name + "]");',
    'run("Text File... ", "open=[/Data/note.txt]"); print("[" + File.name + "][" + File.directory + "]");',
    'run("Results... ", "open=[/Data/r.csv]"); print("[" + File.name + "]");',
    'run("LUT... ", "open=[/Data/fire.lut]"); print("[" + File.name + "]");'));
  assert.deepEqual(out, ['[z.zip][/Data/]', '[r2.csv]', '[ti.txt]', '[ti.txt]', '[ti.txt]', '[note.txt][/Data/]', '[r.csv]', '[fire.lut]']);
  t.close();
});

await test('F3: XY Coordinates of a macro rectangle / oval are sub-pixel (4 decimals); Select All stays integer', async () => {
  const { t, disk, log } = await studio({});
  await log(lines(
    'newImage("img", "8-bit black", 16, 16, 1);',
    'makeRectangle(1, 1, 4, 4); saveAs("XY Coordinates", "/Data/xr.txt");',
    'makeOval(1, 1, 4, 4); saveAs("XY Coordinates", "/Data/xo.txt");',
    'run("Select All"); saveAs("XY Coordinates", "/Data/xa.txt");'));
  assert.equal(disk.text('xr.txt'), '1.0000\t1.0000\n5.0000\t1.0000\n5.0000\t5.0000\n1.0000\t5.0000\n');
  const oval = disk.text('xo.txt').split('\n').filter(Boolean);
  assert.ok(oval.length > 4 && oval.every((l) => /^\d+\.\d{4}\t\d+\.\d{4}$/.test(l)), 'float vertices: ' + oval.slice(0, 3));
  assert.equal(oval[0], '5.0004\t3.0000', 'OvalRoi.getFloatPolygon starts where the jar does');
  assert.equal(disk.text('xa.txt'), '0\t0\n16\t0\n16\t16\n0\t16\n');
  t.close();
});

await test('F4: a Results column that held a non-integer prints every cell with the precision (getResultString and the file)', async () => {
  const { t, disk, log } = await studio({});
  const out = await log(lines(
    'setResult("B", 0, 2.5); setResult("B", 1, 3); setResult("C", 1, 4);',
    'print(getResultString("B", 1)); print(getResultString("C", 1));',
    'saveAs("Results", "/Data/r.csv");',
    'Table.create("T"); Table.set("x", 0, 1.5); Table.set("x", 1, 2); Table.set("x", 1, 7); print(Table.getString("x", 1));'));
  assert.deepEqual(out, ['3.000', '4', '7.000']);
  assert.equal(disk.text('r.csv'), ' ,B,C\n1,2.500,0\n2,3.000,4\n');
  // the operator's File › Save As › Results writes the same text
  const s0 = t.saved.length;
  await t.runCommand('fileSaveResults');
  await until(() => t.saved.length > s0, 'the Results download');
  const blob = t.saved[t.saved.length - 1].blob;
  assert.equal(await blob.text(), ' ,B,C\n1,2.500,0\n2,3.000,4\n');
  t.close();
});

await test('F5 + F7: Table.save writes the row numbers a table shows; Table.save("") offers "Table"', async () => {
  const { t, disk, log } = await studio({});
  await log(lines('Table.create("T"); Table.set("a", 0, 1); Table.set("a", 1, 2); Table.showRowNumbers(true); Table.save("/Data/t.csv");',
    'Table.create("U"); Table.set("a", 0, 1); Table.save("/Data/u.csv");'));
  assert.equal(disk.text('t.csv'), ' ,a\n1,1\n2,2\n');
  assert.equal(disk.text('u.csv'), 'a\n1\n');
  const src = fs.readFileSync(path.join(DIR, 'ij-proc-macro.js'), 'utf8');
  assert.ok(/pick\(M, 'save', 'Save Table', 'command', \{ defaultName: 'Table'/.test(src), 'SaveDialog("Save Table", "Table", …)');
  t.close();
});

await test('F6: a text window open() made is a window of the run (isOpen, window.titles, window.type), and close() closes it', async () => {
  const { t, log } = await studio({});
  const out = await log(lines(
    'File.saveString("hello\\n", "/Data/n.txt"); open("/Data/n.txt");',
    'print(isOpen("n.txt")); selectWindow("n.txt"); print(getInfo("window.type"));',
    'l = getList("window.titles"); s = ""; for (i = 0; i < l.length; i++) s = s + l[i] + ";"; print(s);',
    'close("n.txt"); print(isOpen("n.txt"));'));
  assert.equal(out[0], '1');
  assert.equal(out[1], 'Text');
  assert.ok(out[2].split(';').includes('n.txt'), out[2]);
  assert.equal(out[3], '0');
  t.close();
});

await test('S3: the overwrite confirmation focuses Refuse, and a keyboard activation of Allow in its first half second is ignored', async () => {
  const { t, disk } = await studio({ 'x.txt': 'old' }, { mode: 'ask' });
  const focused = [];
  const mk = t.page.document.createElement;
  t.page.document.createElement = (tag) => { const e = mk(tag); e.focus = () => focused.push(e); return e; };
  const run = t.runMacro('File.saveString("new", "/Data/x.txt");');
  await t.waitPause('confirm');
  await sleep(0);
  t.page.document.createElement = mk;
  const last = focused[focused.length - 1];
  assert.ok(last && last.textContent === t.tr('dlg.mac.pause.refuse'), 'focused: ' + (last && last.textContent));
  const allow = t.findButton(t.tr('dlg.mac.pause.allowRun'));
  t.gesture(() => fire(allow, 'click', { detail: 0 }));
  await sleep(20);
  assert.ok(t.pause() && t.pause().state === 'confirm', 'a key pressed for something else grants nothing');
  t.gesture(() => fire(allow, 'click', { detail: 1 }));
  const r = await run;
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.equal(disk.text('x.txt'), 'new');
  t.close();
});

await test('R5: a Files root of handles whose permission came back to "prompt" shows Allow again, and the run\'s regrant asks on a click', async () => {
  const t = await fileBoot();
  const disk = makeFakeDisk({ 'a.txt': 'from the file' }, { name: 'pc' });
  const F = t.F;
  const r = F.rootFromRecord({ v: 1, id: 'cccccccccccccccc', name: 'Files', kind: 'files', target: 'inplace', mode: 'allow', folderName: 'Files',
    entries: [{ name: 'a.txt', handle: disk.file('a.txt'), writable: false }], createdAt: 1, lastUsedAt: 1 });
  F.state().roots.push(r);
  disk.setPermission('readwrite', 'prompt'); disk.setPermission('read', 'prompt');
  await F.refreshPermission(r);
  assert.equal(F.rootState(r), 'prompt', 'not "Ready" while the browser would refuse');
  const run = t.runMacro('print(File.openAsString("/Files/a.txt"));');
  await t.waitPause('regrant');
  await t.click(t.tr('dlg.mac.pause.allow'));
  const res = await run;
  assert.equal(res.ok, true, JSON.stringify(res.error));
  assert.ok(Array.from(t.macroLog()).includes('from the file'), 'the file was read after the regrant');
  assert.equal(F.rootState(r), 'ready');
  t.close();
});

await test('R7: a folder copy chosen again with other files is not given the old workspace silently', async () => {
  const t = await fileBoot({ fsa: false });
  const F = t.F;
  const p1 = F.snapshotPrint({ rels: ['a.tif', 'b.tif'] });
  assert.equal(p1, F.snapshotPrint({ rels: ['b.tif', 'a.tif'] }), 'order-free');
  assert.notEqual(p1, F.snapshotPrint({ rels: ['a.tif', 'c.tif'] }));
  const rec = F.rootFromRecord({ v: 1, id: 'dddddddddddddddd', name: 'Data', kind: 'snapshot', target: 'overlay', mode: 'allow', folderName: 'Data', snapPrint: p1, createdAt: 1, lastUsedAt: 1 });
  assert.equal(rec.snapPrint, p1, 'the print is stored with the root');
  F.state().roots.push(rec);
  // another folder named Data
  await t.grantFolder(folder('Data', { 'other.txt': 'x' }), { mode: 'allow' });
  assert.equal(rec.snapshot, null, 'the stale root keeps its workspace for its own folder');
  assert.equal(F.state().roots.length, 2);
  // the same folder again
  const before = F.state().roots.length;
  t.pickFile(Object.assign([], makeSnapshot('Data', { 'a.tif': 'A', 'b.tif': 'B' }).files));
  await t.click(t.tr('dlg.mac.files.addFolder'));
  await until(() => rec.snapshot, 'the same folder takes its root back');
  assert.equal(F.state().roots.length, before);
  t.close();
});

await test('R8: Firefox / Safari: the Files section says Safari may delete the workspace after 7 days', async () => {
  const t = await fileBoot({ fsa: false });
  await until(() => t.texts().includes(t.tr('dlg.mac.files.evictNote')), 'the eviction note');
  for (const code of ['en', 'fr', 'es', 'nl']) {
    const l = JSON.parse(fs.readFileSync(path.join(DIR, 'lang', code + '.json'), 'utf8'));
    const f = l.dlg.mac.files;
    for (const k of ['evictNote', 'otherFolder', 'attach']) assert.equal(typeof f[k], 'string', code + ': dlg.mac.files.' + k);
  }
  t.close();
});

finished = true;
console.log('test_ij_macro_files_review: ' + passed + ' passed');
