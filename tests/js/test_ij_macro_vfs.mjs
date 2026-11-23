// IJMacroVFS (js/modules/studio/advanced-studio/ij-macro-vfs.js), FILES.md §2–§4 and §7:
//   • the pure path rules (separators, full / machine paths, `..` clamp, aliases longest prefix + case rules, root names and
//     reserved names, java.io.File helpers, IJ.updateExtension / addSeparator, formatBytes) and the hashes against node:crypto;
//   • every Vfs operation on each backend over the fakes of ij_macro_fs_fakes.mjs: FSA in place, FSA through the overlay
//     (write refused), snapshot + overlay, loose files (Chromium entries and snapshot), /tmp, /Downloads, the virtual roots;
//   • overlay semantics: read-after-write, whiteouts, renames of folders (also chained and back), listing merge order,
//     copy-on-write append, the manifest across two open()s;
//   • the policy table (§7.1) incl. VFS_ASK / allow, the permission states (§3.5), quota / busy / gone / stale / no storage,
//     /tmp clearing per mount id (F14), serialisation of operations, path safety (no escape from a root).
//
// Run: node tests/js/test_ij_macro_vfs.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { ROOT } from './harness.mjs';
import { FakeFile, FakeFileReaderSync, makeFakeDisk, makeFakeOpfs, makeSnapshot, makeEntryTree, makePickers, makeFakeIndexedDB, installFsGlobals } from './ij_macro_fs_fakes.mjs';

process.env.TZ = 'UTC';
const SRC = path.join(ROOT, 'js/modules/studio/advanced-studio/ij-macro-vfs.js');
vm.runInThisContext(fs.readFileSync(SRC, 'utf8'), { filename: SRC });
const V = globalThis.IJMacroVFS;
assert.ok(V && Object.isFrozen(V), 'IJMacroVFS is a frozen global');

let failures = 0, passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; }
  catch (e) { failures++; console.error('FAIL ' + name + '\n', e); }
}
const isPromise = (v) => !!v && typeof v.then === 'function';
const txt = (u8) => new TextDecoder().decode(u8);
async function code(f) {
  try { await (typeof f === 'function' ? f() : f); } catch (e) { return e.code || e.name; }
  return 'no error';
}
function codeSync(f) {
  try { f(); } catch (e) { return e.code; }
  return 'no error';
}
const ID = { data: '0123456789abcdef', snap: 'aaaaaaaaaaaaaaaa', ro: 'bbbbbbbbbbbbbbbb', files: 'cccccccccccccccc', ov: 'dddddddddddddddd', b: 'eeeeeeeeeeeeeeee' };
function fsaGrant(disk, over = {}) {
  return Object.assign({ id: ID.data, name: 'data', kind: 'fsa', target: 'inplace', mode: 'allow', folderName: 'data', handle: disk.dir() }, over);
}
function snapGrant(tree, over = {}) {
  return Object.assign({ id: ID.snap, name: 'snap', kind: 'snapshot', target: 'overlay', mode: 'allow', folderName: 'snap', snapshot: makeSnapshot('snap', tree) }, over);
}
async function openVfs(o = {}) {
  const opfs = o.opfs === null ? null : (o.opfs || makeFakeOpfs({}));
  const first = [];
  const vfs = V.open({ roots: o.roots || [], aliases: o.aliases || [], mountId: o.mountId || 'mount-1',
    opfs: opfs ? () => opfs.storage.getDirectory() : null, lutFiles: o.lutFiles, now: o.now || (() => 1700000500000),
    estimate: opfs ? () => opfs.storage.estimate() : undefined, onFirstOverlayWrite: (id) => first.push(id) });
  await vfs.prepare();
  return { vfs, opfs, first };
}
globalThis.FileReaderSync = FakeFileReaderSync;

// ═══════════════════════════════════════════════════════════ §2 pure rules
await test('separators and classification', () => {
  assert.equal(V.normalizeSeparators('C:\\a\\b.tif'), 'C:/a/b.tif');
  assert.equal(V.normalizeSeparators(12), '12');
  for (const s of ['/a', 'C:/x', 'C:\\x', 'http://h/x', 'a:/b']) assert.equal(V.isFullPath(s), true, s);
  for (const s of ['a', 'a/b', 'C:x', '']) assert.equal(V.isFullPath(s), false, s);
  for (const s of ['http://h/x', 'https://h', 'file:/c/x', 'FILE:\\c']) assert.equal(V.isUrl(s), true, s);
  assert.equal(V.isUrl('/data/x.tif'), false);
  for (const s of ['C:/x', 'c:\\x', '//srv/share', '\\\\srv\\share\\a']) assert.equal(V.isMachinePath(s), true, s);
  for (const s of ['/x', 'x', 'C:x']) assert.equal(V.isMachinePath(s), false, s);
});
await test('java.io.File helpers (Unix rules)', () => {
  assert.equal(V.javaName('/a/b/c.tif'), 'c.tif');
  assert.equal(V.javaName('/a/b/'), 'b');
  assert.equal(V.javaName('a\\b.tif'), 'b.tif');
  assert.equal(V.javaName('/'), '');
  assert.equal(V.javaName('//a//b'), 'b');
  assert.equal(V.javaParent('/a/b/c.tif'), '/a/b');
  assert.equal(V.javaParent('/a'), '/');
  assert.equal(V.javaParent('/'), null);
  assert.equal(V.javaParent('a.tif'), null);
  assert.equal(V.javaParent('a/b'), 'a');
  assert.equal(V.javaParent('/a/b/'), '/a');
  assert.equal(V.javaAbsolute('x.tif'), '/home/x.tif');
  assert.equal(V.javaAbsolute(''), '/home');
  assert.equal(V.javaAbsolute('/r/x'), '/r/x');
  assert.equal(V.nameWithoutExtension('a.tif'), 'a');
  assert.equal(V.nameWithoutExtension('a.ab.cdef'), 'a.ab');
  assert.equal(V.nameWithoutExtension('a.abcde'), 'a.abcde');
  assert.equal(V.nameWithoutExtension(null), '');
  assert.equal(V.getNameWithoutExtension('/r/s/a.b.tif'), 'a.b');
  assert.equal(V.getNameWithoutExtension('/r/s/a.abcdef'), 'a');
  assert.equal(V.getNameWithoutExtension('/r/s/noext'), 'noext');
});
await test('IJ.updateExtension / addSeparator verbatim', () => {
  assert.equal(V.updateExtension('/r/a.1', '.tif'), '/r/a.1.tif');
  assert.equal(V.updateExtension('/r/b.jpeg', '.png'), '/r/b.png');
  assert.equal(V.updateExtension('/r/b', '.png'), '/r/b.png');
  assert.equal(V.updateExtension('/r.d/b', '.png'), '/r.d/b.png');
  assert.equal(V.updateExtension('/r/b.abcdef', '.png'), '/r/b.abcdef.png');
  assert.equal(V.updateExtension(null, '.png'), null);
  assert.equal(V.addSeparator('/r/a'), '/r/a/');
  assert.equal(V.addSeparator('/r/a/'), '/r/a/');
  assert.equal(V.addSeparator(''), '');
  assert.equal(V.addSeparator(null), null);
});
await test('root names: de-duplicated, reserved, sanitised', () => {
  assert.equal(V.rootName([], 'run1'), 'run1');
  assert.equal(V.rootName(['run1'], 'run1'), 'run1 (2)');
  assert.equal(V.rootName(['run1', 'RUN1 (2)'], 'Run1'), 'Run1 (3)');
  assert.equal(V.rootName([], 'tmp'), 'tmp (2)');
  assert.equal(V.rootName([], 'DOWNLOADS'), 'DOWNLOADS (2)');
  assert.equal(V.rootName([], 'Luts'), 'Luts (2)');
  assert.equal(V.rootName([], ''), 'Files');
  assert.equal(V.rootName(['Files'], null), 'Files (2)');
  assert.equal(V.rootName([], '..'), 'Files');
  assert.equal(V.rootName([], 'a/b\\c'), 'a_b_c');
  assert.deepEqual(Array.from(V.RESERVED), ['tmp', 'home', 'macros', 'luts', 'imagej', 'Downloads']);
});
await test('alias prefixes', () => {
  assert.deepEqual(V.aliasPrefixes('C:/data/run1/'), ['C:/data/run1/', 'C:/data/', 'C:/']);
  assert.deepEqual(V.aliasPrefixes('C:\\data\\run1'), ['C:/data/run1/', 'C:/data/', 'C:/']);
  assert.deepEqual(V.aliasPrefixes('//srv/share/a/'), ['//srv/share/a/', '//srv/share/']);
  assert.deepEqual(V.aliasPrefixes('/Users/me/data/'), ['/Users/me/data/', '/Users/me/', '/Users/']);
});
await test('formatBytes', () => {
  assert.equal(V.formatBytes(0), '0 B');
  assert.equal(V.formatBytes(512), '512 B');
  assert.equal(V.formatBytes(1500), '1.5 KB');
  assert.equal(V.formatBytes(12.3e6), '12.3 MB');
  assert.equal(V.formatBytes(1.2e9), '1.2 GB');
  assert.equal(V.formatBytes(999999), '1.0 MB');
  assert.equal(V.formatBytes(-4), '0 B');
});
await test('hashes and CRC-32 against node:crypto / zlib vectors', () => {
  const enc = new TextEncoder();
  assert.equal(V.crc32.done(V.crc32.update(0xffffffff, enc.encode('123456789'))), 0xcbf43926);
  assert.equal(V.hash.md5().hex(), 'd41d8cd98f00b204e9800998ecf8427e');
  assert.equal(V.hash.sha256().update(enc.encode('abc')).hex(), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  for (const n of [0, 1, 55, 56, 63, 64, 65, 119, 120, 1000, 100003]) {
    const data = crypto.randomBytes(n);
    const m = V.hash.md5(), s = V.hash.sha256();
    let crc = 0xffffffff;
    for (let o = 0; o < n;) { const k = Math.min(n - o, 1 + ((o * 7919) % 97)); m.update(data.subarray(o, o + k)); s.update(data.subarray(o, o + k)); crc = V.crc32.update(crc, data.subarray(o, o + k)); o += k; }
    assert.equal(m.hex(), crypto.createHash('md5').update(data).digest('hex'), 'md5 ' + n);
    assert.equal(s.hex(), crypto.createHash('sha256').update(data).digest('hex'), 'sha256 ' + n);
    let ref = 0xffffffff;
    for (const b of data) { ref ^= b; for (let k = 0; k < 8; k++) ref = ref & 1 ? 0xedb88320 ^ (ref >>> 1) : ref >>> 1; }
    assert.equal(V.crc32.done(crc), (ref ^ 0xffffffff) >>> 0, 'crc ' + n);
  }
});
await test('error codes and VfsError', () => {
  assert.deepEqual(Array.from(V.ERRORS), ['VFS_BAD_PATH', 'VFS_NOT_GRANTED', 'VFS_NOT_FOUND', 'VFS_NOT_A_DIR', 'VFS_IS_A_DIR', 'VFS_EXISTS',
    'VFS_READ_ONLY', 'VFS_ASK', 'VFS_PERMISSION', 'VFS_QUOTA', 'VFS_ROOT_DELETE', 'VFS_NOT_EMPTY', 'VFS_BAD_NAME', 'VFS_GONE', 'VFS_STALE',
    'VFS_BUSY', 'VFS_TOO_LARGE', 'VFS_NO_STORAGE', 'VFS_CLOSED', 'VFS_IO']);
  const e = new V.VfsError('VFS_ASK', '/r/a', { rootId: 'x', action: 'delete' });
  assert.equal(e.code, 'VFS_ASK'); assert.equal(e.path, '/r/a'); assert.equal(e.details.action, 'delete'); assert.equal(e.action, 'delete');
});

// ═══════════════════════════════════════════════════════════ §2.3 resolution and path safety
await test('resolution: bases, .. clamp, roots, top', async () => {
  const disk = makeFakeDisk({ 'a.tif': 'A' });
  const { vfs } = await openVfs({ roots: [fsaGrant(disk), snapGrant({})] });
  let r = vfs.resolve('/data/sub/../a.tif');
  assert.deepEqual(r, { vpath: '/data/a.tif', rootId: ID.data, root: 'data', rel: 'a.tif', isRoot: false, isTop: false });
  r = vfs.resolve('a.tif', { base: '/data/' });
  assert.equal(r.vpath, '/data/a.tif');
  r = vfs.resolve('x.tif');
  assert.equal(r.vpath, '/home/x.tif'); assert.equal(r.rootId, 'home');
  r = vfs.resolve('\\data\\a.tif');
  assert.equal(r.vpath, '/data/a.tif');
  r = vfs.resolve('/data/');
  assert.equal(r.isRoot, true); assert.equal(r.vpath, '/data/'); assert.equal(r.rel, '');
  r = vfs.resolve('/');
  assert.equal(r.isTop, true); assert.equal(r.vpath, '/');
  r = vfs.resolve('/data/../../../..');
  assert.equal(r.isTop, true, '.. never climbs above /');
  r = vfs.resolve('/data/../snap/x');
  assert.equal(r.vpath, '/snap/x', 'moving between two granted roots is legal');
  r = vfs.resolve('/data/./sub//b/');
  assert.equal(r.vpath, '/data/sub/b/');
  r = vfs.resolve('/tmp/a'); assert.equal(r.rootId, 'tmp');
  r = vfs.resolve('/Downloads/a'); assert.equal(r.rootId, 'downloads');
  r = vfs.resolve('/luts/Fire.lut'); assert.equal(r.rootId, 'luts');
  for (const bad of ['', 'a\u0000b', '/data/a\u0000', 'http://example.org/a.tif', 'file:/C:/x']) assert.equal(codeSync(() => vfs.resolve(bad)), 'VFS_BAD_PATH', JSON.stringify(bad));
  await vfs.close();
});
await test('resolution: machine paths need an alias (drive, UNC, POSIX)', async () => {
  const disk = makeFakeDisk({ 'run1/a.tif': 'A' });
  const { vfs } = await openVfs({ roots: [fsaGrant(disk)] });
  let e;
  try { vfs.resolve('C:\\data\\run1\\a.tif'); } catch (x) { e = x; }
  assert.equal(e.code, 'VFS_NOT_GRANTED');
  assert.equal(e.details.literal, 'C:/data/run1/');
  assert.deepEqual(e.details.prefixes, ['C:/data/run1/', 'C:/data/', 'C:/']);
  try { vfs.resolve('C:/data/run1/../run2/b.tif'); } catch (x) { e = x; }
  assert.equal(e.details.literal, 'C:/data/run2/', '.. is collapsed inside the machine path, clamped at its drive');
  try { vfs.resolve('C:/../../x.tif'); } catch (x) { e = x; }
  assert.equal(e.details.literal, 'C:/');
  try { vfs.resolve('\\\\srv\\share\\a\\b.tif'); } catch (x) { e = x; }
  assert.equal(e.details.literal, '//srv/share/a/'); assert.deepEqual(e.details.prefixes, ['//srv/share/a/', '//srv/share/']);
  try { vfs.resolve('/Users/me/x.tif'); } catch (x) { e = x; }
  assert.equal(e.code, 'VFS_NOT_GRANTED'); assert.equal(e.details.literal, '/Users/me/');
  try { vfs.resolve('/Data/a.tif'); } catch (x) { e = x; }
  assert.equal(e.code, 'VFS_NOT_GRANTED', 'root names are case-sensitive');
  try { vfs.resolve('x.tif', { base: 'C:/data/' }); } catch (x) { e = x; }
  assert.equal(e.details.literal, 'C:/data/', 'a machine default folder makes relative names machine paths');
  await vfs.close();
});
await test('resolution: aliases (longest prefix, case rules, dangling)', async () => {
  const disk = makeFakeDisk({ 'run1/a.tif': 'A', 'b.tif': 'B' });
  const other = makeFakeDisk({ 'z.tif': 'Z' });
  const { vfs } = await openVfs({
    roots: [fsaGrant(disk), fsaGrant(other, { id: ID.b, name: 'run1' })],
    aliases: [{ literal: 'C:/data/', rootId: ID.data, ci: true }, { literal: 'C:\\DATA\\run1\\', rootId: ID.b, ci: true },
      { literal: '/Users/me/', rootId: ID.data, ci: false }, { literal: 'D:/gone/', rootId: 'ffffffffffffffff', ci: true }]
  });
  assert.equal(vfs.resolve('c:\\data\\b.tif').vpath, '/data/b.tif');
  assert.equal(vfs.resolve('C:/data/run1/z.tif').vpath, '/run1/z.tif', 'the longest alias wins, compared case-insensitively');
  assert.equal(vfs.resolve('C:/data/run1').vpath, '/run1', 'the aliased folder itself');
  assert.equal(vfs.resolve('C:/data/run10/x').vpath, '/data/run10/x', 'a prefix matches whole segments only');
  assert.equal(vfs.resolve('/Users/me/b.tif').vpath, '/data/b.tif');
  assert.equal(codeSync(() => vfs.resolve('/users/me/b.tif')), 'VFS_NOT_GRANTED', 'POSIX aliases are case-sensitive');
  assert.equal(codeSync(() => vfs.resolve('D:/gone/x')), 'VFS_NOT_GRANTED', 'a dangling alias is absent');
  assert.equal(vfs.resolve('C:/data/run1/../b.tif').vpath, '/data/b.tif');
  const r = (() => { try { return vfs.resolve('C:/data/../../etc/passwd'); } catch (x) { return x; } })();
  assert.equal(r.code, 'VFS_NOT_GRANTED', 'climbing out of an alias reaches no root');
  assert.equal(txt(await vfs.read('C:\\data\\run1\\z.tif')), 'Z');
  vfs.setAliases([]);
  assert.equal(codeSync(() => vfs.resolve('C:/data/b.tif')), 'VFS_NOT_GRANTED');
  await vfs.close();
});
await test('path safety: no escape, reserved names stay virtual, names the backend refuses', async () => {
  const disk = makeFakeDisk({ 'in/a.txt': 'a' }, { windowsNames: true });
  const shadow = makeFakeDisk({ 'evil.txt': 'e' });
  const { vfs } = await openVfs({ roots: [fsaGrant(disk), fsaGrant(shadow, { id: ID.b, name: 'tmp' })] });
  const names = (await vfs.list('/')).map((x) => x.name);
  assert.ok(names.includes('tmp') && names.includes('tmp (2)'), 'a grant named like a virtual root is renamed: ' + names);
  assert.equal(vfs.resolve('/tmp/x').rootId, 'tmp');
  assert.equal(vfs.resolve('/tmp (2)/evil.txt').rootId, ID.b);
  for (const p of ['/data/../../x', '/data/in/../../../x', '/data/in/../../tmp (2)/../../x']) assert.equal(codeSync(() => vfs.resolve(p)), 'VFS_NOT_GRANTED', p);
  assert.equal(vfs.resolve('/data/in/../../../tmp/x').rootId, 'tmp', 'clamped at /, then a root by name');
  assert.equal(await code(() => vfs.write('/data/CON', 'x')), 'VFS_BAD_NAME');
  assert.equal(await code(() => vfs.write('/data/a?.txt', 'x')), 'VFS_BAD_NAME');
  assert.equal(await code(() => vfs.write('/data/trail.', 'x')), 'VFS_BAD_NAME');
  assert.equal(await vfs.mkdir('/data/nul.txt').then(() => 'ok', (e) => e.code), 'VFS_BAD_NAME');
  assert.equal(await vfs.stat('/data/CON'), null);
  assert.deepEqual(Object.keys(disk.tree()).sort(), ['in/', 'in/a.txt']);
  await vfs.close();
});

// ═══════════════════════════════════════════════════════════ FSA in place
await test('FSA in place: stat / list / read / write / append / mkdir / remove / rename / copy', async () => {
  let clock = 1700000600000;
  const disk = makeFakeDisk({ 'a.tif': 'AAAA', 'sub/': {}, 'sub/b.txt': 'bee', 'full/x': 'x' }, { now: () => clock });
  const { vfs, first } = await openVfs({ roots: [fsaGrant(disk)] });
  assert.deepEqual(await vfs.stat('/data/a.tif'), { kind: 'file', size: 4, mtime: 1700000000000 });
  assert.deepEqual(await vfs.stat('/data/sub'), { kind: 'dir', size: 0, mtime: 0 });
  assert.deepEqual(await vfs.stat('/data/'), { kind: 'dir', size: 0, mtime: 0 });
  assert.equal(await vfs.stat('/data/nope'), null);
  assert.equal(await vfs.stat('/data/a.tif/x'), null);
  assert.deepEqual((await vfs.list('/data')).map((x) => x.name + ':' + x.kind).sort(), ['a.tif:file', 'full:dir', 'sub:dir']);
  assert.equal(await vfs.list('/data/a.tif'), null);
  assert.equal(await vfs.list('/data/nope'), null);
  assert.equal(txt(await vfs.read('/data/a.tif')), 'AAAA');
  assert.equal(txt(await vfs.read('/data/a.tif', { offset: 1, length: 2 })), 'AA');
  assert.equal(txt(await vfs.read('/data/a.tif', { offset: 9 })), '');
  assert.equal(await code(() => vfs.read('/data/sub')), 'VFS_IS_A_DIR');
  assert.equal(await code(() => vfs.read('/data/zz')), 'VFS_NOT_FOUND');
  await vfs.write('/data/new.txt', [new TextEncoder().encode('he'), 'llo']);
  assert.equal(disk.text('new.txt'), 'hello');
  await vfs.write('/data/new.txt', ' world', { append: true });
  assert.equal(disk.text('new.txt'), 'hello world');
  await vfs.write('/data/new.txt', 'X');
  assert.equal(disk.text('new.txt'), 'X', 'a write truncates');
  assert.equal(await code(() => vfs.write('/data/missing/x.txt', 'x')), 'VFS_NOT_FOUND');
  assert.equal(await code(() => vfs.write('/data/a.tif/x.txt', 'x')), 'VFS_NOT_A_DIR');
  assert.equal(await code(() => vfs.write('/data/sub', 'x')), 'VFS_IS_A_DIR');
  assert.equal(await code(() => vfs.write('/data/', 'x')), 'VFS_IS_A_DIR');
  assert.equal(await code(() => vfs.write('/', 'x')), 'VFS_IS_A_DIR');
  assert.equal(await vfs.mkdir('/data/out'), true);
  assert.equal(await vfs.mkdir('/data/out'), false);
  assert.equal(await vfs.mkdir('/data/x/y'), false, 'one level only');
  assert.equal(await vfs.mkdir('/data/'), false);
  assert.equal(await vfs.remove('/data/full'), false, 'a folder with content is not deleted');
  assert.equal(await vfs.remove('/data/out'), true);
  assert.equal(await vfs.remove('/data/zzz'), false);
  assert.equal(await code(() => vfs.remove('/data/')), 'VFS_ROOT_DELETE');
  assert.equal(await code(() => vfs.remove('/')), 'VFS_ROOT_DELETE');
  assert.equal(await vfs.rename('/data/new.txt', '/data/sub/renamed.txt'), true);
  assert.equal(disk.text('sub/renamed.txt'), 'X');
  assert.equal(disk.exists('new.txt'), false);
  assert.equal(await vfs.rename('/data/sub/renamed.txt', '/data/a.tif'), false, 'the target exists');
  assert.equal(await vfs.rename('/data/nope', '/data/x'), false);
  assert.equal(await vfs.rename('/data/sub', '/data/sub/inner'), false, 'not into itself');
  assert.equal(await vfs.rename('/data/sub', '/data/sub2'), true);
  assert.equal(disk.text('sub2/b.txt'), 'bee');
  await vfs.copy('/data/a.tif', '/data/copy.tif');
  assert.equal(disk.text('copy.tif'), 'AAAA');
  assert.equal(await code(() => vfs.copy('/data/none', '/data/c')), 'VFS_NOT_FOUND');
  assert.equal(await code(() => vfs.copy('/data/sub2', '/data/c')), 'VFS_IS_A_DIR');
  await vfs.copy('/data/copy.tif', '/data/copy.tif');
  assert.equal(disk.text('copy.tif'), '', 'Tools.copyFile onto itself truncates (Java opens the target after the source)');
  assert.deepEqual(first, [], 'in place writes are not overlay writes');
  assert.deepEqual(vfs.changedRoots(), []);
  await vfs.close();
});
await test('FSA rename without move(): file copied + removed, folder refused', async () => {
  const disk = makeFakeDisk({ 'a.txt': 'aa', 'd/': {}, 'd/x': 'x' }, { move: false });
  const { vfs } = await openVfs({ roots: [fsaGrant(disk)] });
  assert.equal(await vfs.rename('/data/a.txt', '/data/b.txt'), true);
  assert.equal(disk.text('b.txt'), 'aa'); assert.equal(disk.exists('a.txt'), false);
  assert.equal(await vfs.rename('/data/d', '/data/e'), false);
  await vfs.close();
});
await test('FSA writes go straight to the target (F8): an aborted write leaves the old content, no sibling file', async () => {
  const disk = makeFakeDisk({ 'a.txt': 'old' });
  const { vfs } = await openVfs({ roots: [fsaGrant(disk)] });
  disk.failNext('write', 'TypeError');
  assert.notEqual(await code(() => vfs.write('/data/a.txt', 'new')), 'no error');
  assert.equal(disk.text('a.txt'), 'old');
  disk.failNext('close', 'QuotaExceededError');
  assert.equal(await code(() => vfs.write('/data/a.txt', 'new')), 'VFS_QUOTA');
  assert.deepEqual(Object.keys(disk.tree()), ['a.txt']);
  await vfs.write('/data/a.txt', 'new');
  assert.equal(disk.text('a.txt'), 'new');
  await vfs.close();
});
await test('FSA permission states (§3.5)', async () => {
  const disk = makeFakeDisk({ 'a.txt': 'a' });
  disk.setPermission('readwrite', 'prompt');
  disk.setPermission('read', 'prompt');
  const { vfs } = await openVfs({ roots: [fsaGrant(disk)] });
  let e;
  try { await vfs.stat('/data/a.txt'); } catch (x) { e = x; }
  assert.equal(e.code, 'VFS_PERMISSION'); assert.equal(e.details.mode, 'read'); assert.equal(e.details.state, 'prompt'); assert.equal(e.details.rootId, ID.data);
  disk.setPermission('read', 'granted');
  assert.equal(txt(await vfs.read('/data/a.txt')), 'a');
  try { await vfs.write('/data/b.txt', 'b'); } catch (x) { e = x; }
  assert.equal(e.code, 'VFS_PERMISSION'); assert.equal(e.details.mode, 'readwrite');
  disk.setPermission('readwrite', 'denied');
  assert.equal(await code(() => vfs.write('/data/b.txt', 'b')), 'VFS_PERMISSION', 'denied on an in-place root: no silent overlay');
  disk.setPermission('readwrite', 'granted');
  vfs.addGrant(fsaGrant(disk));
  await vfs.write('/data/b.txt', 'b');
  assert.equal(disk.text('b.txt'), 'b');
  await vfs.close();
});

// ═══════════════════════════════════════════════════════════ overlay roots
await test('snapshot overlay: read-after-write, whiteouts, listing merge order, the base untouched', async () => {
  const snap = makeSnapshot('snap', { 'b.txt': 'B', 'a.txt': 'A', 'sub/c.txt': 'C', 'empty/': {} });
  const g = { id: ID.snap, name: 'snap', kind: 'snapshot', target: 'overlay', mode: 'allow', folderName: 'snap', snapshot: snap };
  const { vfs, opfs, first } = await openVfs({ roots: [g] });
  assert.deepEqual((await vfs.list('/snap')).map((x) => x.name), ['b.txt', 'a.txt', 'sub', 'empty'], 'base order kept');
  await vfs.write('/snap/z.txt', 'Z');
  await vfs.write('/snap/m.txt', 'M');
  await vfs.write('/snap/a.txt', 'A2');
  assert.deepEqual((await vfs.list('/snap')).map((x) => x.name), ['b.txt', 'a.txt', 'sub', 'empty', 'm.txt', 'z.txt'], 'new names after the base, sorted');
  assert.equal(txt(await vfs.read('/snap/a.txt')), 'A2');
  assert.equal(await snap.files[1].text(), 'A', 'the snapshot file is never written');
  assert.equal(await vfs.remove('/snap/b.txt'), true);
  assert.equal(await vfs.stat('/snap/b.txt'), null);
  assert.equal(await code(() => vfs.read('/snap/b.txt')), 'VFS_NOT_FOUND');
  assert.ok(!(await vfs.list('/snap')).some((x) => x.name === 'b.txt'));
  assert.equal(await vfs.remove('/snap/a.txt'), true, 'an overlay file shadowing a base file');
  assert.equal(await vfs.stat('/snap/a.txt'), null, 'deleting the overlay copy does not bring the base file back');
  await vfs.write('/snap/b.txt', 'B2');
  assert.equal(txt(await vfs.read('/snap/b.txt')), 'B2', 'a deleted name can be written again');
  assert.equal(await vfs.remove('/snap/empty'), true);
  assert.equal(await vfs.mkdir('/snap/empty'), true, 'a deleted folder can be created again');
  assert.deepEqual(await vfs.list('/snap/empty'), []);
  assert.equal(await vfs.remove('/snap/sub'), false, 'a folder with base content is not empty');
  await vfs.write('/snap/sub/new.txt', 'N');
  assert.deepEqual((await vfs.list('/snap/sub')).map((x) => x.name), ['c.txt', 'new.txt']);
  assert.deepEqual(first, [ID.snap]);
  assert.deepEqual(vfs.changedRoots(), [ID.snap]);
  const ch = await vfs.changes(ID.snap);
  assert.deepEqual(ch.files.map((f) => f.rel + ':' + f.kind), ['b.txt:modified', 'm.txt:new', 'sub/new.txt:new', 'z.txt:new']);
  assert.deepEqual(ch.deleted, ['a.txt'], 'a whiteout re-created by an overlay file is not a deletion');
  assert.deepEqual(ch.dirs, ['empty']);
  assert.equal(ch.bytes, 2 + 1 + 1 + 1);
  await vfs.close();
  assert.equal(opfs.openHandles(), 0, 'close() releases every access handle');
});
await test('overlay renames: files, folders, chained, back, into a re-created name', async () => {
  const snap = makeSnapshot('snap', { 'a/x.txt': 'X', 'a/y.txt': 'Y', 'f.txt': 'F', 'g.txt': 'G' });
  const { vfs } = await openVfs({ roots: [snapGrant({}, { snapshot: snap })] });
  await vfs.write('/snap/a/new.txt', 'N');
  assert.equal(await vfs.rename('/snap/a/x.txt', '/snap/a/x2.txt'), true);
  assert.equal(await vfs.rename('/snap/a', '/snap/c'), true);
  assert.deepEqual((await vfs.list('/snap/c')).map((x) => x.name).sort(), ['new.txt', 'x2.txt', 'y.txt']);
  assert.equal(await vfs.stat('/snap/a'), null);
  assert.equal(await vfs.stat('/snap/c/x.txt'), null, 'the earlier rename inside the folder stays');
  assert.equal(txt(await vfs.read('/snap/c/x2.txt')), 'X');
  assert.equal(txt(await vfs.read('/snap/c/new.txt')), 'N');
  assert.equal(await vfs.rename('/snap/c', '/snap/a'), true, 'renamed back');
  assert.deepEqual((await vfs.list('/snap/a')).map((x) => x.name).sort(), ['new.txt', 'x2.txt', 'y.txt']);
  assert.equal(await vfs.stat('/snap/a/x.txt'), null);
  assert.equal(await vfs.mkdir('/snap/p'), true);
  assert.equal(await vfs.rename('/snap/a/y.txt', '/snap/p/y.txt'), true);
  assert.equal(await vfs.rename('/snap/a', '/snap/q'), true);
  assert.equal(await vfs.rename('/snap/p/y.txt', '/snap/a.txt'), true);
  assert.equal(txt(await vfs.read('/snap/a.txt')), 'Y');
  assert.equal(await vfs.remove('/snap/f.txt'), true);
  assert.equal(await vfs.rename('/snap/g.txt', '/snap/f.txt'), true, 'rename onto a deleted name');
  assert.equal(txt(await vfs.read('/snap/f.txt')), 'G');
  assert.equal(await vfs.stat('/snap/g.txt'), null);
  await vfs.write('/snap/h.txt', 'H');
  assert.equal(await vfs.rename('/snap/h.txt', '/snap/q/h.txt'), true, 'an overlay file moves in OPFS');
  assert.equal(txt(await vfs.read('/snap/q/h.txt')), 'H');
  assert.equal(await vfs.rename('/snap/q', '/snap/q/inner'), false);
  const ch = await vfs.changes(ID.snap);
  assert.deepEqual(ch.deleted, ['f.txt']);
  assert.deepEqual(ch.renamed.map((r) => r.from + '>' + r.to).sort(), ['a/x.txt>q/x2.txt', 'a/y.txt>a.txt', 'a>q', 'g.txt>f.txt'].sort());
  assert.deepEqual(ch.files.map((f) => f.rel), ['q/h.txt', 'q/new.txt']);
  await vfs.close();
});
await test('overlay: copy-on-write append, copy from the base keeps mtime, delete of a renamed entry', async () => {
  const snap = makeSnapshot('snap', { 'log.txt': { bytes: 'one\n', mtime: 1600000000000 }, 'img.tif': { bytes: 'IMG', mtime: 1650000000000 } });
  const { vfs } = await openVfs({ roots: [snapGrant({}, { snapshot: snap })] });
  await vfs.write('/snap/log.txt', 'two\n', { append: true });
  assert.equal(txt(await vfs.read('/snap/log.txt')), 'one\ntwo\n');
  await vfs.write('/snap/log.txt', 'three\n', { append: true });
  assert.equal(txt(await vfs.read('/snap/log.txt')), 'one\ntwo\nthree\n');
  await vfs.copy('/snap/img.tif', '/snap/img2.tif');
  assert.deepEqual(await vfs.stat('/snap/img2.tif'), { kind: 'file', size: 3, mtime: 1650000000000 });
  await vfs.copy('/snap/img.tif', '/tmp/img.tif');
  assert.equal((await vfs.stat('/tmp/img.tif')).mtime, 1650000000000);
  assert.equal(await vfs.rename('/snap/img.tif', '/snap/pic.tif'), true);
  assert.equal(await vfs.remove('/snap/pic.tif'), true);
  const ch = await vfs.changes(ID.snap);
  assert.deepEqual(ch.deleted, ['img.tif'], 'a renamed then deleted entry is one deletion of its original name');
  assert.deepEqual(ch.renamed, []);
  await vfs.close();
});
await test('overlay manifest persists across two open()s; a corrupt manifest keeps the data', async () => {
  const opfs = makeFakeOpfs({});
  const tree = { 'a.txt': 'A', 'd/b.txt': 'B' };
  let { vfs } = await openVfs({ opfs, roots: [snapGrant(tree)] });
  await vfs.write('/snap/new.txt', 'N');
  await vfs.remove('/snap/a.txt');
  await vfs.rename('/snap/d', '/snap/e');
  await vfs.mkdir('/snap/made');
  await vfs.close();
  ({ vfs } = await openVfs({ opfs, roots: [snapGrant(tree)], mountId: 'mount-2' }));
  assert.deepEqual((await vfs.list('/snap')).map((x) => x.name), ['e', 'made', 'new.txt']);
  assert.equal(txt(await vfs.read('/snap/e/b.txt')), 'B');
  assert.equal((await vfs.stat('/snap/new.txt')).mtime, 1700000500000);
  await vfs.close();
  const man = JSON.parse(txt(opfs.bytes('lumen3d-ij-macro/ws/' + ID.snap + '/manifest.json')));
  assert.deepEqual(man.whiteouts, ['a.txt']);
  assert.deepEqual(man.renames, [{ from: 'd', to: 'e', dir: true }]);
  assert.deepEqual(man.dirs, ['made/']);
  assert.equal(man.v, 1); assert.equal(man.rootId, ID.snap); assert.equal(man.folderName, 'snap');
  // corrupt the manifest: the files written survive, the records are lost (and said so in the console)
  const ws = await (await (await opfs.root.getDirectoryHandle('lumen3d-ij-macro')).getDirectoryHandle('ws')).getDirectoryHandle(ID.snap);
  const w = await (await ws.getFileHandle('manifest.json')).createWritable();
  await w.write('{not json'); await w.close();
  const err = console.error; console.error = () => {};
  try { ({ vfs } = await openVfs({ opfs, roots: [snapGrant(tree)] })); } finally { console.error = err; }
  assert.equal(txt(await vfs.read('/snap/new.txt')), 'N');
  await vfs.close();
});
await test('FSA root through the overlay (write refused): reads the folder, writes the workspace, folder untouched', async () => {
  const disk = makeFakeDisk({ 'a.txt': 'A', 'sub/b.txt': 'B' });
  disk.setPermission('readwrite', 'denied');
  const { vfs } = await openVfs({ roots: [fsaGrant(disk, { target: 'overlay', writeRefused: true, mode: 'ask' })] });
  await vfs.write('/data/sub/c.txt', 'C');
  assert.equal(txt(await vfs.read('/data/sub/c.txt')), 'C');
  assert.equal(await code(() => vfs.write('/data/a.txt', 'A2')), 'VFS_ASK');
  vfs.allow(ID.data);
  await vfs.write('/data/a.txt', 'A2');
  assert.equal(await vfs.remove('/data/sub/b.txt'), true);
  assert.deepEqual((await vfs.list('/data/sub')).map((x) => x.name), ['c.txt']);
  assert.deepEqual(Object.keys(disk.tree()).sort(), ['a.txt', 'sub/', 'sub/b.txt']);
  assert.equal(disk.text('a.txt'), 'A');
  disk.setPermission('read', 'prompt');
  disk.setPermission('readwrite', 'prompt');
  const e = await Promise.resolve().then(() => vfs.stat('/data/zzz')).then(() => null, (x) => x);
  assert.equal(e.code, 'VFS_PERMISSION', 'a permission revoked during the run');
  assert.equal(e.details.rootId, ID.data); assert.equal(e.details.mode, 'read');
  const e2 = await Promise.resolve().then(() => vfs.stat('/data/zzz')).then(() => null, (x) => x);
  assert.equal(e2.details.state, 'prompt', 'the next access asks the browser again');
  await vfs.close();
});
await test('loose files: Chromium entries (writable save-picker entry in place) and a snapshot elsewhere', async () => {
  const disk = makeFakeDisk({ 'in.txt': 'IN', 'out.txt': '' });
  const g = { id: ID.files, name: 'Files', kind: 'files', target: 'overlay', mode: 'allow', folderName: 'Files',
    entries: [{ name: 'in.txt', handle: disk.file('in.txt'), writable: false }, { name: 'out.txt', handle: disk.file('out.txt'), writable: true }] };
  const { vfs } = await openVfs({ roots: [g] });
  assert.deepEqual((await vfs.list('/Files')).map((x) => x.name), ['in.txt', 'out.txt']);
  assert.equal(txt(await vfs.read('/Files/in.txt')), 'IN');
  await vfs.write('/Files/out.txt', 'RESULT');
  assert.equal(disk.text('out.txt'), 'RESULT', 'the save-picker file is written in place');
  await vfs.write('/Files/in.txt', 'CHANGED');
  assert.equal(disk.text('in.txt'), 'IN', 'a read-only entry gets an overlay copy');
  assert.equal(txt(await vfs.read('/Files/in.txt')), 'CHANGED');
  assert.equal(await vfs.stat('/Files/sub/x'), null);
  assert.deepEqual((await vfs.changes(ID.files)).files.map((f) => f.rel), ['in.txt']);
  await vfs.close();
  const g2 = { id: ID.files, name: 'Files', kind: 'files', target: 'overlay', mode: 'allow', folderName: 'Files', snapshot: makeSnapshot('Files', { 'p.txt': 'P' }) };
  const r2 = await openVfs({ roots: [g2] });
  assert.equal(txt(await r2.vfs.read('/Files/p.txt')), 'P');
  await r2.vfs.close();
});
await test('/Downloads/: an allow root over an empty base', async () => {
  const { vfs } = await openVfs();
  assert.deepEqual(await vfs.list('/Downloads'), []);
  await vfs.write('/Downloads/r.csv', 'a,b\n');
  await vfs.write('/Downloads/r.csv', 'c,d\n');
  assert.equal(txt(await vfs.read('/Downloads/r.csv')), 'c,d\n', 'allow: no confirmation');
  assert.deepEqual(vfs.changedRoots(), ['downloads']);
  assert.deepEqual((await vfs.changes('downloads')).files.map((f) => f.rel + ':' + f.kind), ['r.csv:new']);
  await vfs.close();
});
await test('virtual roots: /luts/ generated, /home/ /macros/ /imagej/ empty, all read-only', async () => {
  const lut = new Uint8Array(768).map((_, i) => i % 256);
  const { vfs } = await openVfs({ lutFiles: () => [{ name: 'Fire', bytes: lut }, { name: 'Grays.lut', bytes: lut }] });
  assert.deepEqual(await vfs.list('/luts/'), [{ name: 'Fire.lut', kind: 'file' }, { name: 'Grays.lut', kind: 'file' }]);
  assert.deepEqual(await vfs.stat('/luts/Fire.lut'), { kind: 'file', size: 768, mtime: 0 });
  assert.deepEqual(Array.from(await vfs.read('/luts/Fire.lut', { offset: 10, length: 3 })), [10, 11, 12]);
  for (const r of ['/home/', '/macros/', '/imagej/']) assert.deepEqual(await vfs.list(r), [], r);
  assert.equal(await vfs.stat('/home/.imagej/'), null);
  assert.equal(await vfs.stat('/imagej/plugins/'), null);
  for (const p of ['/home/x.txt', '/luts/Fire.lut', '/macros/m.ijm']) assert.equal(await code(() => vfs.write(p, 'x')), 'VFS_READ_ONLY', p);
  assert.equal(await code(() => vfs.mkdir('/home/d')), 'VFS_READ_ONLY');
  assert.equal(await code(() => vfs.remove('/luts/Fire.lut')), 'VFS_READ_ONLY');
  assert.equal(await code(() => vfs.remove('/luts/')), 'VFS_ROOT_DELETE');
  await vfs.close();
});

// ═══════════════════════════════════════════════════════════ /tmp
await test('/tmp/: synchronous once open, survives a second open of the same mount, cleared on a new mount (F14)', async () => {
  const opfs = makeFakeOpfs({});
  let { vfs } = await openVfs({ opfs, mountId: 'A' });
  await vfs.write('/tmp/a.txt', 'one');
  const r = vfs.read('/tmp/a.txt');
  assert.ok(!isPromise(r), 'a read of an open /tmp file is synchronous');
  assert.equal(txt(r), 'one');
  const w = vfs.write('/tmp/a.txt', 'two', { append: true });
  assert.ok(!isPromise(w), 'an append to an open /tmp file is synchronous');
  assert.ok(!isPromise(vfs.stat('/tmp/a.txt')) && !isPromise(vfs.list('/tmp/')));
  assert.equal(await vfs.mkdir('/tmp/d'), true);
  await vfs.write('/tmp/d/b.txt', 'b');
  assert.deepEqual((await vfs.list('/tmp/')).map((x) => x.name), ['a.txt', 'd'], '.mount is hidden');
  assert.equal(await vfs.stat('/tmp/.mount'), null);
  await vfs.close();
  ({ vfs } = await openVfs({ opfs, mountId: 'A' }));
  assert.equal(txt(await vfs.read('/tmp/a.txt')), 'onetwo', 'a worker restarted in the same Studio open keeps /tmp');
  await vfs.close();
  ({ vfs } = await openVfs({ opfs, mountId: 'B' }));
  assert.deepEqual(await vfs.list('/tmp/'), [], 'a new Studio open starts with an empty /tmp');
  await vfs.write('/tmp/x', 'x');
  assert.deepEqual((await vfs.usage()).tmpBytes, 1);
  await vfs.clearTmp();
  assert.deepEqual(await vfs.list('/tmp/'), []);
  await vfs.close();
});

// ═══════════════════════════════════════════════════════════ §7.1 policy
await test('policy: read-only, ask (+ allow for the run), allow, root delete', async () => {
  const mk = () => makeFakeDisk({ 'a.txt': 'a', 'd/': {}, 'e/': {}, 'e/x': 'x' });
  const ro = mk(), ask = mk(), al = mk();
  const { vfs } = await openVfs({ roots: [fsaGrant(ro, { id: ID.ro, name: 'ro', mode: 'readonly' }), fsaGrant(ask, { mode: 'ask', name: 'ask' }),
    fsaGrant(al, { id: ID.b, name: 'al', mode: 'allow' })] });
  // read-only: every mutation refused, reads fine
  assert.equal(txt(await vfs.read('/ro/a.txt')), 'a');
  for (const p of [() => vfs.write('/ro/new.txt', 'n'), () => vfs.write('/ro/a.txt', 'n'), () => vfs.mkdir('/ro/n'), () => vfs.remove('/ro/a.txt'),
    () => vfs.rename('/ro/a.txt', '/ro/b.txt'), () => vfs.copy('/ask/a.txt', '/ro/c.txt'), () => vfs.remove('/ro/missing')]) assert.equal(await code(p), 'VFS_READ_ONLY');
  const roErr = await Promise.resolve().then(() => vfs.write('/ro/x', 'x')).then(() => null, (e) => e);
  assert.equal(roErr.details.root, 'ro');
  assert.deepEqual(Object.keys(ro.tree()).sort(), ['a.txt', 'd/', 'e/', 'e/x']);
  // ask: new files and folders pass, the rest asks
  await vfs.write('/ask/new.txt', 'n');
  assert.equal(await vfs.mkdir('/ask/n'), true);
  const cases = [
    [() => vfs.write('/ask/a.txt', 'z'), 'overwrite', '/ask/a.txt'],
    [() => vfs.write('/ask/a.txt', 'z', { append: true }), 'overwrite', '/ask/a.txt'],
    [() => vfs.copy('/al/a.txt', '/ask/a.txt'), 'overwrite', '/ask/a.txt'],
    [() => vfs.remove('/ask/a.txt'), 'delete', '/ask/a.txt'],
    [() => vfs.rename('/ask/a.txt', '/ask/b.txt'), 'rename', '/ask/a.txt', '/ask/b.txt'],
    [() => vfs.mkdir('/ask/d'), 'mkdir', '/ask/d']
  ];
  for (const [f, action, p, to] of cases) {
    const e = await Promise.resolve().then(f).then(() => null, (x) => x);
    assert.ok(e, action);
    assert.equal(e.code, 'VFS_ASK');
    assert.deepEqual(e.details, Object.assign({ rootId: ID.data, root: 'ask', action, path: p }, to ? { to } : {}));
  }
  assert.equal(await vfs.remove('/ask/missing'), false, 'nothing to delete: no question');
  assert.equal(await vfs.rename('/ask/a.txt', '/ask/new.txt'), false, 'a rename that cannot happen: no question');
  assert.equal(await vfs.remove('/ask/e'), false, 'a folder with content: no question');
  assert.equal(ask.text('a.txt'), 'a');
  vfs.allow(ID.data);
  await vfs.write('/ask/a.txt', 'z');
  assert.equal(await vfs.mkdir('/ask/d'), false, 'allowed: an existing name stays as it was');
  assert.equal(await vfs.rename('/ask/a.txt', '/ask/b.txt'), true);
  assert.equal(await vfs.remove('/ask/b.txt'), true);
  // allow: everything
  await vfs.write('/al/a.txt', 'z');
  assert.equal(await vfs.remove('/al/a.txt'), true);
  for (const r of ['/ro/', '/ask/', '/al/', '/tmp/', '/Downloads/', '/ro', '/']) assert.equal(await code(() => vfs.remove(r)), 'VFS_ROOT_DELETE', r);
  await vfs.close();
  // a new Vfs (a new run) asks again
  const again = await openVfs({ roots: [fsaGrant(ask, { mode: 'ask', name: 'ask' })] });
  assert.equal(await code(() => again.vfs.write('/ask/new.txt', 'again')), 'VFS_ASK');
  await again.vfs.close();
});

// ═══════════════════════════════════════════════════════════ storage failures
await test('quota: VFS_QUOTA { written, free }, the partial write recorded', async () => {
  const opfs = makeFakeOpfs({ quota: 1 << 20 });
  const { vfs } = await openVfs({ opfs, roots: [snapGrant({})] });
  const big = new Uint8Array(2 << 20);
  const e = await vfs.write('/snap/big.bin', big).then(() => null, (x) => x);
  assert.equal(e.code, 'VFS_QUOTA');
  assert.ok(e.details.written > 0 && e.details.written <= 1 << 20, 'written ' + e.details.written);
  assert.equal(typeof e.details.free, 'number');
  assert.equal(e.details.free, (1 << 20) - opfs.used());
  assert.equal(e.path, '/snap/big.bin');
  const st = await vfs.stat('/snap/big.bin');
  assert.ok(st && st.size === e.details.written, 'the bytes that fit stay, as on a full disk');
  assert.equal(await code(() => vfs.close()), 'VFS_QUOTA', 'no room left for the workspace manifest either');
  assert.equal(opfs.openHandles(), 0);
});
await test('busy (another tab holds the workspace), gone (file changed after the pick), stale, no storage', async () => {
  const opfs = makeFakeOpfs({});
  let r = await openVfs({ opfs, roots: [snapGrant({})] });
  await r.vfs.write('/snap/n.txt', 'N');
  await r.vfs.close();
  const lock = opfs.lock('lumen3d-ij-macro/ws/' + ID.snap + '/data/n.txt');
  r = await openVfs({ opfs, roots: [snapGrant({})] });
  assert.equal(await code(() => r.vfs.read('/snap/n.txt')), 'VFS_BUSY');
  assert.equal(await code(() => r.vfs.write('/snap/m.txt', 'M')), 'VFS_BUSY');
  await r.vfs.close();
  lock.close();
  r = await openVfs({ opfs, roots: [snapGrant({})] });
  assert.equal(txt(await r.vfs.read('/snap/n.txt')), 'N');
  await r.vfs.close();
  const snap = makeSnapshot('snap', { 'g.txt': 'G' });
  snap.files[0]._gone = true;
  r = await openVfs({ roots: [snapGrant({}, { snapshot: snap })] });
  assert.equal(await code(() => r.vfs.read('/snap/g.txt')), 'VFS_GONE');
  await r.vfs.close();
  globalThis.FileReaderSync = undefined;
  r = await openVfs({ roots: [snapGrant({}, { snapshot: snap })] });
  assert.equal(await code(() => r.vfs.read('/snap/g.txt')), 'VFS_GONE', 'also on the asynchronous read path');
  await r.vfs.close();
  globalThis.FileReaderSync = FakeFileReaderSync;
  r = await openVfs({ roots: [snapGrant({}, { snapshot: null })] });
  const e = await Promise.resolve().then(() => r.vfs.list('/snap/')).then(() => null, (x) => x);
  assert.equal(e.code, 'VFS_STALE'); assert.deepEqual(e.details, { rootId: ID.snap, root: 'snap' });
  assert.equal(await code(() => r.vfs.write('/snap/x', 'x')), 'VFS_STALE');
  await r.vfs.close();
  r = await openVfs({ opfs: null, roots: [snapGrant({ 'a.txt': 'A' })] });
  assert.equal(txt(await r.vfs.read('/snap/a.txt')), 'A', 'without storage the folder still reads');
  assert.equal(await code(() => r.vfs.write('/snap/b.txt', 'B')), 'VFS_NO_STORAGE');
  assert.equal(await code(() => r.vfs.write('/tmp/b.txt', 'B')), 'VFS_NO_STORAGE');
  assert.equal(await code(() => r.vfs.write('/Downloads/b.txt', 'B')), 'VFS_NO_STORAGE');
  assert.deepEqual(await r.vfs.list('/tmp/'), []);
  await r.vfs.close();
  const quiet = console.error; console.error = () => {};
  const failing = await openVfs({ opfs: { storage: { getDirectory: () => Promise.reject(new DOMException('no', 'SecurityError')) } }, roots: [] })
    .catch((x) => x).finally(() => { console.error = quiet; });
  assert.ok(failing.vfs, 'a private window (getDirectory refused) is a Vfs without storage, not an error');
  await failing.vfs.close();
});
await test('too large: a read over 2^31 - 1 bytes is refused before reading', async () => {
  const huge = { size: 2 ** 31 + 10, lastModified: 0, slice() { throw new Error('must not read'); } };
  const { vfs } = await openVfs({ roots: [snapGrant({}, { snapshot: { rels: ['h.bin'], files: [huge], dirs: [] } })] });
  assert.equal((await vfs.stat('/snap/h.bin')).size, 2 ** 31 + 10);
  assert.equal(await code(() => vfs.read('/snap/h.bin')), 'VFS_TOO_LARGE');
  const rd = await vfs.openRead('/snap/h.bin');
  assert.equal(rd.size, 2 ** 31 + 10);
  rd.close();
  await vfs.close();
});

// ═══════════════════════════════════════════════════════════ serialisation, sync paths, closing
await test('serialisation: operations settle in call order; synchronous paths stay synchronous', async () => {
  const disk = makeFakeDisk({});
  const snap = makeSnapshot('snap', { 'a.txt': 'A' });
  const { vfs } = await openVfs({ roots: [fsaGrant(disk), snapGrant({}, { snapshot: snap })] });
  const r0 = vfs.read('/snap/a.txt');
  assert.ok(!isPromise(r0), 'a snapshot read with FileReaderSync is synchronous');
  assert.ok(!isPromise(vfs.stat('/snap/a.txt')) && !isPromise(vfs.list('/snap/')), 'snapshot stat / list synchronous');
  const order = [];
  const p1 = vfs.write('/data/one.txt', '1').then(() => order.push('w1'));
  const p2 = vfs.read('/snap/a.txt');
  assert.ok(isPromise(p2), 'issued while a write is pending: queued');
  p2.then(() => order.push('r'));
  const p3 = vfs.stat('/data/one.txt').then((s) => { order.push('s'); return s; });
  const [, , st] = await Promise.all([p1, p2, p3]);
  assert.deepEqual(order, ['w1', 'r', 's']);
  assert.equal(st.size, 1, 'the stat saw the write issued before it');
  const p4 = vfs.write('/data/fail/x', 'x');
  const p5 = vfs.write('/data/two.txt', '2');
  assert.equal(await code(p4), 'VFS_NOT_FOUND');
  await p5;
  assert.equal(disk.text('two.txt'), '2', 'a failed operation does not block the queue');
  await vfs.close();
  assert.equal(codeSync(() => vfs.read('/snap/a.txt')), 'VFS_CLOSED');
  await vfs.close();
});
await test('openRead: chunked reads, closed Vfs refuses', async () => {
  const data = crypto.randomBytes(100000);
  const { vfs } = await openVfs({ roots: [snapGrant({ 'b.bin': data })] });
  const rd = await vfs.openRead('/snap/b.bin');
  const h = V.hash.sha256();
  for (let o = 0; o < rd.size; o += 30000) h.update(await rd.read(o, 30000));
  assert.equal(h.hex(), crypto.createHash('sha256').update(data).digest('hex'));
  await vfs.close();
  assert.equal(codeSync(() => rd.read(0, 1)), 'VFS_CLOSED');
});
await test('addGrant during a run; a re-grant keeps the overlay workspace', async () => {
  const opfs = makeFakeOpfs({});
  const { vfs } = await openVfs({ opfs });
  const disk = makeFakeDisk({ 'p.txt': 'P' });
  await vfs.addGrant(fsaGrant(disk, { name: 'picked' }));
  assert.equal(txt(await vfs.read('/picked/p.txt')), 'P');
  await vfs.addGrant(snapGrant({ 's.txt': 'S' }));
  await vfs.write('/snap/w.txt', 'W');
  await vfs.addGrant(snapGrant({ 's.txt': 'S' }, { mode: 'ask' }));
  assert.equal(txt(await vfs.read('/snap/w.txt')), 'W');
  assert.equal(await code(() => vfs.write('/snap/s.txt', 'S2')), 'VFS_ASK', 'the new grant brings its mode');
  // a file this Vfs created is still a new file when it is written again (a writer's appends, a second saveAs): no question
  assert.equal(await code(() => vfs.write('/snap/w.txt', 'W2', { append: true })), 'no error');
  assert.equal(txt(await vfs.read('/snap/w.txt')), 'WW2');
  await vfs.close();
});
await test('fakes sanity: entry tree, pickers need a gesture, IndexedDB round trip', async () => {
  const top = makeEntryTree('dropped', { 'a.txt': 'A', 'sub/b.txt': 'B', 'empty/': {} });
  const names = await new Promise((res) => top.createReader().readEntries((list) => res(list.map((e) => e.name))));
  assert.deepEqual(names.sort(), ['a.txt', 'empty', 'sub']);
  const g = {};
  const disk = makeFakeDisk({}, { name: 'picked' });
  const pk = makePickers({ directory: [disk.dir()] }).install(g);
  assert.equal(await g.showDirectoryPicker({ mode: 'readwrite' }).then(() => 'ok', (e) => e.name), 'SecurityError');
  g.__activation = true;
  const h = await g.showDirectoryPicker({ mode: 'readwrite' });
  assert.equal(h.name, 'picked');
  assert.equal(pk.calls.length, 2);
  const idb = makeFakeIndexedDB();
  const db = await new Promise((res, rej) => { const q = idb.open('lumen3d-ij-macro', 1); q.onupgradeneeded = () => q.result.createObjectStore('roots', { keyPath: 'id' }); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
  await new Promise((res) => { const tx = db.transaction(['roots'], 'readwrite'); tx.objectStore('roots').put({ id: 'x', handle: h }); tx.oncomplete = res; });
  const back = await new Promise((res) => { const q = db.transaction(['roots']).objectStore('roots').get('x'); q.onsuccess = () => res(q.result); });
  assert.equal(back.handle, h, 'handles are kept by reference (structured clone of a handle is the same entry)');
  const uninstall = installFsGlobals(g, { opfs: makeFakeOpfs({}) });
  assert.equal(typeof g.navigator.storage.getDirectory, 'function');
  assert.equal(g.FileReaderSync, FakeFileReaderSync);
  uninstall();
  const f = new FakeFile(['ab', new Uint8Array([99])], 'f.bin', { lastModified: 5 });
  assert.equal(await f.slice(1).text(), 'bc');
  assert.equal(new TextDecoder().decode(new FakeFileReaderSync().readAsArrayBuffer(f.slice(0, 2))), 'ab');
});

// ═══════════════════════════════════════════════════════════ no network in the file
await test('no network API in ij-macro-vfs.js', () => {
  const src = fs.readFileSync(SRC, 'utf8');
  for (const w of ['fetch', 'XMLHttpRequest', 'sendBeacon', 'WebSocket', 'EventSource', 'importScripts', 'new Worker', 'window.open', 'location', 'E.fetch',
    'eval(', 'new Function', 'WebAssembly']) assert.equal(src.indexOf(w), -1, 'forbidden word in the source: ' + w);
});

console.log((failures ? 'FAILED ' : 'ok ') + passed + ' passed, ' + failures + ' failed — test_ij_macro_vfs');
if (failures) process.exit(1);
