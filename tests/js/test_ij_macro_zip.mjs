// IJMacroVFS.zip (the streaming STORE ZIP writer, FILES.md §11.2) and Vfs.deliver (§11.1, §11.3):
//   • round trip through readZip (strict: local/central agreement, CRC-32, sizes) and, when Python is on PATH, through
//     Python's zipfile (a temp file, `python -I -c …`; SKIP otherwise);
//   • UTF-8 names (flag bit 11), DOS time in local time (TZ=UTC here), folder entries, version needed 20 / 45;
//   • ZIP64 by entry size (a sparse sink: a real 4 GiB entry whose data bytes are counted, not kept), by entry offset and
//     central directory offset, and by 65 536 entries; the same paths forced at small sizes through `testLimits`
//     (test-only knob) so Python can read them whole;
//   • errors: wrong entry size, entry left open, bad names;
//   • deliver: kinds none / files / zip, ≤ 3 links rule, README.txt only with deletions or renames, entry order (folders
//     before their files), quota while building, the archive replaced on a second delivery, discard.
//
// Run: node tests/js/test_ij_macro_zip.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { ROOT } from './harness.mjs';
import { FakeFileReaderSync, makeFakeOpfs, makeSnapshot, readZip, sparseSink, memorySink } from './ij_macro_fs_fakes.mjs';

process.env.TZ = 'UTC';
const SRC = path.join(ROOT, 'js/modules/studio/advanced-studio/ij-macro-vfs.js');
vm.runInThisContext(fs.readFileSync(SRC, 'utf8'), { filename: SRC });
const V = globalThis.IJMacroVFS;
globalThis.FileReaderSync = FakeFileReaderSync;

let failures = 0, passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; }
  catch (e) { failures++; console.error('FAIL ' + name + '\n', e); }
}
const enc = new TextEncoder();
const sha = (u8) => crypto.createHash('sha256').update(u8).digest('hex');
const T0 = 1700000000000;   // 2023-11-14 22:13:20 UTC

// ---- Python's zipfile, when available
const PY = (() => {
  for (const exe of ['python3', 'python']) {
    try {
      const r = spawnSync(exe, ['-I', '-c', 'import zipfile, json, hashlib, sys; print(sys.version_info[0])'], { encoding: 'utf8', timeout: 20000 });
      if (r.status === 0 && r.stdout.trim() === '3') return exe;
    } catch (_) { /* not installed */ }
  }
  return null;
})();
const PY_READ = [
  'import zipfile, json, hashlib, sys',
  'z = zipfile.ZipFile(sys.argv[1])',
  'bad = z.testzip()',
  'out = []',
  'for i in z.infolist():',
  '    d = z.read(i) if not i.is_dir() else b""',
  '    out.append([i.filename, i.file_size, hashlib.sha256(d).hexdigest(), list(i.date_time), i.flag_bits, i.is_dir()])',
  'print(json.dumps({"bad": bad, "entries": out, "count": len(out)}))'
].join('\n');
const PY_COUNT = 'import zipfile, sys\nz = zipfile.ZipFile(sys.argv[1])\nprint(len(z.infolist()), z.testzip())';
let pySkipped = false;
function python(bytes, script = PY_READ) {
  if (!PY) { if (!pySkipped) { console.log('SKIP Python zipfile round trip: no python3 / python on PATH'); pySkipped = true; } return null; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ijm-zip-'));
  const f = path.join(dir, 'a.zip');
  try {
    fs.writeFileSync(f, bytes);
    const r = spawnSync(PY, ['-I', '-c', script, f], { encoding: 'utf8', timeout: 120000, maxBuffer: 64 << 20 });
    if (r.status !== 0) throw new Error('python failed: ' + r.stderr);
    return script === PY_READ ? JSON.parse(r.stdout) : r.stdout.trim();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

// ═══════════════════════════════════════════════════════════ writer
await test('round trip: files, folders, UTF-8 names, DOS time, CRC, streamed chunks', () => {
  const sink = memorySink();
  const z = V.zip.create(sink, { now: () => T0 });
  const big = crypto.randomBytes(300000);
  z.add('run/', { size: 0, mtime: T0 }).end();
  const e = z.add('run/big.bin', { size: big.length, mtime: T0 });
  for (let o = 0; o < big.length; o += 65536) e.write(big.subarray(o, o + 65536));
  e.end();
  z.addBytes('run/données é 日本.txt', enc.encode('héllo\n'), T0 + 1000);
  z.addBytes('empty.txt', new Uint8Array(0), 0);
  z.addBytes('README.txt', 'text as a string', T0);
  const res = z.finish();
  assert.deepEqual(res, { entries: 5, bytes: sink.position(), zip64: false });
  const bytes = sink.bytes();
  const list = readZip(bytes);
  assert.deepEqual(list.map((x) => x.name), ['run/', 'run/big.bin', 'run/données é 日本.txt', 'empty.txt', 'README.txt']);
  assert.equal(sha(list[1].data), sha(big));
  assert.equal(new TextDecoder().decode(list[2].data), 'héllo\n');
  assert.equal(new TextDecoder().decode(list[4].data), 'text as a string');
  for (const x of list) { assert.equal(x.flags, 0x0800, 'UTF-8 flag on ' + x.name); assert.equal(x.versionNeeded, 20); assert.equal(x.zip64, false); }
  assert.deepEqual(list[0].dos, { time: (22 << 11) | (13 << 5) | 10, date: ((2023 - 1980) << 9) | (11 << 5) | 14 });
  assert.deepEqual(list[2].dos.time, (22 << 11) | (13 << 5) | 10, 'two-second resolution');
  assert.deepEqual(list[3].dos, { time: 0, date: (1 << 5) | 1 }, 'before 1980 → 1980-01-01');
  assert.equal(list.zip64End, false);
  const py = python(bytes);
  if (py) {
    assert.equal(py.bad, null);
    assert.deepEqual(py.entries.map((x) => x[0]), list.map((x) => x.name));
    assert.equal(py.entries[1][2], sha(big));
    assert.deepEqual(py.entries[1][3], [2023, 11, 14, 22, 13, 20]);
    assert.equal(py.entries[0][5], true, 'a name ending with / is a folder');
  }
});
await test('errors: size mismatch, entry left open, finished, bad names', () => {
  const z = V.zip.create(memorySink(), {});
  const e = z.add('a', { size: 3 });
  assert.throws(() => e.write(new Uint8Array(4)), (x) => x.code === 'VFS_IO');
  e.write(new Uint8Array(2));
  assert.throws(() => e.end(), (x) => x.code === 'VFS_IO');
  assert.throws(() => z.add('b', { size: 0 }), (x) => x.code === 'VFS_IO', 'one entry at a time');
  assert.throws(() => z.finish(), (x) => x.code === 'VFS_IO');
  e.write(new Uint8Array(1)); e.end();
  for (const bad of ['', '/abs', 'a\\b', 'nul\u0000']) assert.throws(() => z.add(bad, { size: 0 }), (x) => x.code === 'VFS_BAD_NAME', JSON.stringify(bad));
  z.finish();
  assert.throws(() => z.add('c', { size: 0 }), (x) => x.code === 'VFS_IO');
  assert.throws(() => e.write(new Uint8Array(1)), (x) => x.code === 'VFS_IO');
});
await test('ZIP64 forced at small sizes (testLimits): by size, by offset, by count — readZip and Python agree', () => {
  const sink = memorySink();
  const z = V.zip.create(sink, { now: () => T0, testLimits: { size: 1000, offset: 2000, count: 4 } });
  const a = crypto.randomBytes(1500), b = crypto.randomBytes(10), c = crypto.randomBytes(1200);
  z.addBytes('a.bin', a, T0);
  z.addBytes('b.bin', b, T0);
  z.addBytes('c.bin', c, T0);
  z.addBytes('d.txt', 'd', T0);
  const res = z.finish();
  assert.equal(res.zip64, true);
  const bytes = sink.bytes();
  const list = readZip(bytes);
  assert.equal(list.zip64End, true, 'count ≥ the limit and central directory past the offset limit → ZIP64 end record');
  assert.deepEqual(list.map((x) => [x.name, x.zip64Local, x.zip64, x.versionNeeded]), [
    ['a.bin', true, true, 45], ['b.bin', false, false, 20], ['c.bin', true, true, 45], ['d.txt', false, true, 45]]);
  assert.equal(sha(list[0].data), sha(a)); assert.equal(sha(list[2].data), sha(c));
  const eocd = bytes.subarray(bytes.length - 22);
  assert.deepEqual(Array.from(eocd.subarray(8, 20)), [0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff], 'classic fields hold -1');
  const py = python(bytes);
  if (py) {
    assert.equal(py.bad, null);
    assert.deepEqual(py.entries.map((x) => [x[0], x[1], x[2]]), [['a.bin', 1500, sha(a)], ['b.bin', 10, sha(b)], ['c.bin', 1200, sha(c)], ['d.txt', 1, sha(enc.encode('d'))]]);
  }
});
await test('ZIP64 by a real 4 GiB entry (sparse sink): local + central extra, offsets past 4 GiB, end records; constant memory', () => {
  const sink = sparseSink();
  const z = V.zip.create(sink, { now: () => T0 });
  const size = 0x100000000 + 5;   // 4 GiB + 5
  const chunk = new Uint8Array(64 << 20);
  const e = z.add('huge.raw', { size, mtime: T0 });
  let left = size;
  while (left > 0) { const k = Math.min(left, chunk.length); e.write(k === chunk.length ? chunk : chunk.subarray(0, k)); left -= k; }
  e.end();
  z.addBytes('after.txt', 'after', T0);
  const res = z.finish();
  assert.equal(res.zip64, true);
  assert.equal(sink.dropped(), size - 5, 'every 64 MiB data chunk went straight to the sink (the last 5 bytes are a kept small write)');
  const list = readZip(sink);
  assert.equal(list.zip64End, true);
  assert.equal(list[0].name, 'huge.raw'); assert.equal(list[0].size, size); assert.equal(list[0].zip64Local, true); assert.equal(list[0].versionNeeded, 45);
  assert.equal(list[0].crc, V.crc32.done(zeroCrc(size)), 'the CRC patched into the local header');
  assert.equal(list[1].name, 'after.txt'); assert.ok(list[1].offset > 0xffffffff, 'second entry offset past 4 GiB');
  assert.equal(list[1].zip64, true, 'its central record carries the ZIP64 offset'); assert.equal(list[1].zip64Local, false);
  assert.ok(list.cdOffset > 0xffffffff);
});
function zeroCrc(n) {
  // Reference CRC register after n zero bytes, computed independently of the writer: one zero byte is a linear map of the
  const T = new Uint32Array(256).map((_, k) => { let c = k; for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  // State transform of one zero byte is linear over GF(2); square-and-multiply on 32×32 bit matrices.
  const apply = (m, v) => { let r = 0; for (let i = 0; v; i++, v >>>= 1) if (v & 1) r ^= m[i]; return r >>> 0; };
  const mul = (a, b) => b.map((col) => apply(a, col));
  const one = new Array(32).fill(0).map((_, i) => apply2(i));
  function apply2(i) { const v = (1 << i) >>> 0; return (T[v & 255] ^ (v >>> 8)) >>> 0; }
  let result = new Array(32).fill(0).map((_, i) => (1 << i) >>> 0);
  let base = one;
  for (let k = n; k > 0; k = Math.floor(k / 2)) { if (k % 2) result = mul(base, result); base = mul(base, base); }
  return apply(result, 0xffffffff);
}
await test('ZIP64 by 65 536 entries: count in the ZIP64 end record; Python counts them', () => {
  const sink = memorySink();
  const z = V.zip.create(sink, { now: () => T0 });
  const one = enc.encode('x');
  for (let i = 0; i < 65536; i++) z.addBytes('f/' + i, one, T0);
  const res = z.finish();
  assert.equal(res.entries, 65536); assert.equal(res.zip64, true);
  const bytes = sink.bytes();
  const list = readZip(bytes);
  assert.equal(list.length, 65536); assert.equal(list.zip64End, true);
  assert.equal(list[65535].name, 'f/65535');
  const py = python(bytes, PY_COUNT);
  if (py) assert.equal(py, '65536 None');
  const small = memorySink();
  const z2 = V.zip.create(small, {});
  for (let i = 0; i < 65534; i++) z2.addBytes(String(i), one, T0);
  assert.equal(z2.finish().zip64, false, '65 534 entries fit the classic end record');
  assert.equal(readZip(small.bytes()).zip64End, false);
});

// ═══════════════════════════════════════════════════════════ deliver
const ID = 'aaaaaaaaaaaaaaaa';
async function overlay(tree, o = {}) {
  const opfs = o.opfs || makeFakeOpfs({});
  const vfs = V.open({ roots: [{ id: ID, name: 'run 1', kind: 'snapshot', target: 'overlay', mode: 'allow', folderName: 'run 1', snapshot: makeSnapshot('run 1', tree) }],
    aliases: [], mountId: 'm', opfs: () => opfs.storage.getDirectory(), now: () => T0, estimate: () => opfs.storage.estimate() });
  await vfs.prepare();
  return { vfs, opfs };
}
await test('deliver: none, then up to 3 files as links', async () => {
  const { vfs } = await overlay({ 'a.txt': 'A' });
  assert.deepEqual(await vfs.deliver(ID, {}), { kind: 'none' });
  await vfs.write('/run 1/out/../r1.csv', '1');
  await vfs.write('/run 1/a.txt', 'A2');
  await vfs.mkdir('/run 1/res');
  await vfs.write('/run 1/res/r2.csv', '22');
  const d = await vfs.deliver(ID, {});
  assert.equal(d.kind, 'files');
  assert.deepEqual(d.files.map((f) => f.name), ['a.txt', 'r1.csv', 'r2.csv']);
  assert.equal(await d.files[2].file.text(), '22');
  assert.equal((await vfs.deliver(ID, { maxLinks: 2 })).kind, 'zip', 'more files than links → an archive');
  await vfs.close();
});
await test('deliver: a ZIP of <Folder>/<rel> in order, README.txt with deletions and renames', async () => {
  const { vfs, opfs } = await overlay({ 'a.txt': 'A', 'b.txt': 'B', 'sub/c.txt': 'C', 'old/x.txt': 'X' });
  await vfs.remove('/run 1/b.txt');
  await vfs.rename('/run 1/old', '/run 1/new');
  await vfs.write('/run 1/sub/c.txt', 'C2');
  await vfs.write('/run 1/z.txt', 'Z');
  await vfs.mkdir('/run 1/emptydir');
  await vfs.mkdir('/run 1/a-dir');
  await vfs.write('/run 1/a-dir/f.txt', 'F');
  const ticks = [];
  const texts = { 'dlg.mac.files.readme': 'Résultats {name}.\nDécompresser ici.', 'dlg.mac.files.readmeManual': 'À faire :',
    'dlg.mac.files.readmeDelete': 'supprimer  {path}', 'dlg.mac.files.readmeRename': 'renommer  {from}  ->  {to}' };
  const d = await vfs.deliver(ID, { texts, onProgress: (fr, done, total) => ticks.push([fr, done, total]) });
  assert.equal(d.kind, 'zip'); assert.equal(d.name, 'run 1-results.zip'); assert.equal(d.zip64, false);
  const bytes = new Uint8Array(await d.file.arrayBuffer());
  assert.equal(d.bytes, bytes.length);
  const list = readZip(bytes);
  assert.equal(d.entries, list.length);
  assert.deepEqual(list.map((x) => x.name), ['README.txt', 'run 1/a-dir/', 'run 1/a-dir/f.txt', 'run 1/emptydir/', 'run 1/sub/c.txt', 'run 1/z.txt']);
  assert.equal(new TextDecoder().decode(list[0].data),
    'Résultats run 1.\nDécompresser ici.\n\nÀ faire :\n  supprimer  run 1/b.txt\n  renommer  run 1/old  ->  run 1/new\n');
  assert.equal(new TextDecoder().decode(list[4].data), 'C2');
  assert.deepEqual(ticks[ticks.length - 1], [1, 4, 4]);
  assert.ok(ticks.every(([fr]) => fr >= 0 && fr <= 1), 'onProgress(fraction, done, total)');
  assert.ok(opfs.bytes('lumen3d-ij-macro/out/' + ID + '.zip'), 'built in OPFS');
  assert.equal(opfs.openHandles(), 0, 'its access handle closed before getFile()');
  const py = python(bytes);
  if (py) { assert.equal(py.bad, null); assert.deepEqual(py.entries.map((x) => x[0]), list.map((x) => x.name)); }
  // English texts when the page sends none; a second delivery replaces the archive
  await vfs.remove('/run 1/z.txt');
  const d2 = await vfs.deliver(ID, {});
  const l2 = readZip(new Uint8Array(await d2.file.arrayBuffer()));
  assert.ok(new TextDecoder().decode(l2[0].data).startsWith('Results of macros run in the Lumen3D Advanced Studio on the folder run 1.\n'));
  assert.ok(!l2.some((x) => x.name === 'run 1/z.txt'));
  await vfs.close();
});
await test('deliver: no README without deletions or renames; an empty new folder alone needs the archive', async () => {
  const { vfs } = await overlay({ 'a.txt': 'A' });
  await vfs.mkdir('/run 1/out');
  const d = await vfs.deliver(ID, {});
  assert.equal(d.kind, 'zip');
  assert.deepEqual(readZip(new Uint8Array(await d.file.arrayBuffer())).map((x) => x.name), ['run 1/out/']);
  for (let i = 0; i < 5; i++) await vfs.write('/run 1/out/f' + i + '.txt', String(i));
  const d2 = await vfs.deliver(ID, {});
  const names = readZip(new Uint8Array(await d2.file.arrayBuffer())).map((x) => x.name);
  assert.ok(!names.includes('README.txt'));
  assert.deepEqual(names, ['run 1/out/', 'run 1/out/f0.txt', 'run 1/out/f1.txt', 'run 1/out/f2.txt', 'run 1/out/f3.txt', 'run 1/out/f4.txt']);
  await vfs.close();
});
await test('deliver: a deletion alone is an archive with only README.txt; discard empties the workspace', async () => {
  const { vfs, opfs } = await overlay({ 'a.txt': 'A', 'b.txt': 'B' });
  await vfs.remove('/run 1/a.txt');
  const d = await vfs.deliver(ID, {});
  assert.equal(d.kind, 'zip');
  assert.deepEqual(readZip(new Uint8Array(await d.file.arrayBuffer())).map((x) => x.name), ['README.txt']);
  await vfs.write('/run 1/n.txt', 'N');
  await vfs.discard(ID);
  assert.deepEqual(await vfs.deliver(ID, {}), { kind: 'none' });
  assert.deepEqual((await vfs.list('/run 1/')).map((x) => x.name), ['a.txt', 'b.txt'], 'the folder as it was chosen');
  assert.equal(opfs.bytes('lumen3d-ij-macro/out/' + ID + '.zip'), null);
  assert.deepEqual((await vfs.usage()).workspaces[ID], 0);
  await vfs.close();
});
await test('deliver: quota while building the archive → VFS_QUOTA, no partial archive left', async () => {
  const opfs = makeFakeOpfs({ quota: 1 << 20 });
  const { vfs } = await overlay({}, { opfs });
  for (let i = 0; i < 4; i++) await vfs.write('/run 1/f' + i + '.bin', new Uint8Array(200000));
  let e;
  try { await vfs.deliver(ID, {}); } catch (x) { e = x; }
  assert.equal(e && e.code, 'VFS_QUOTA');
  assert.equal(opfs.bytes('lumen3d-ij-macro/out/' + ID + '.zip'), null);
  assert.equal((await vfs.usage()).workspaces[ID], 800000);
  await vfs.close();
  assert.equal(opfs.openHandles(), 0);
});
await test('deliver: unknown or in-place roots have nothing to deliver; the output name keeps the folder name', async () => {
  const { vfs } = await overlay({});
  assert.deepEqual(await vfs.deliver('ffffffffffffffff', {}), { kind: 'none' });
  assert.deepEqual(await vfs.changes('ffffffffffffffff'), { rootId: 'ffffffffffffffff', files: [], deleted: [], renamed: [], dirs: [], bytes: 0 });
  await vfs.write('/Downloads/a.txt', 'a'); await vfs.write('/Downloads/b.txt', 'b'); await vfs.write('/Downloads/c.txt', 'c'); await vfs.write('/Downloads/d.txt', 'd');
  const d = await vfs.deliver('downloads', {});
  assert.equal(d.name, 'Downloads-results.zip');
  assert.deepEqual(readZip(new Uint8Array(await d.file.arrayBuffer())).map((x) => x.name), ['Downloads/a.txt', 'Downloads/b.txt', 'Downloads/c.txt', 'Downloads/d.txt']);
  await vfs.close();
});

await test('deliver: an exception from onProgress (a cancelled request) stops the archive and passes through', async () => {
  const { vfs, opfs } = await overlay({});
  for (let i = 0; i < 5; i++) await vfs.write('/run 1/f' + i + '.txt', 'data' + i);
  let e;
  try { await vfs.deliver(ID, { onProgress: () => { throw Object.assign(new Error('cancelled'), { code: 'IJ_CANCELLED' }); } }); } catch (x) { e = x; }
  assert.equal(e && e.code, 'IJ_CANCELLED');
  assert.equal(opfs.bytes('lumen3d-ij-macro/out/' + ID + '.zip'), null, 'no partial archive');
  await vfs.close();
  assert.equal(opfs.openHandles(), 0);
});
console.log((failures ? 'FAILED ' : 'ok ') + passed + ' passed, ' + failures + ' failed — test_ij_macro_zip');
if (failures) process.exit(1);
