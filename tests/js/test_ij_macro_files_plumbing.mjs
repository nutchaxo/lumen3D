// Macro files, PLUMBING side (DOCS/studio-advanced/macros/FILES.md §5.1, §5.5, §9.3, §9.4, §10): the virtual file system loads with package
// `macro` (PACKAGE_PRE) and a broken one withdraws that package alone; the granted folders travel to the worker untouched (structured clone,
// never JSON); a run() file command answers { status: 'file' } without touching a Studio command; pickFile / saveFile refuse inside a
// command a macro started and work as before outside; the engine's file codecs (E.decodeImage / encodeImage / markSaved, createDoc clean,
// info.file); the mirror's new fields; IJTextIo.readTable (ResultsTable.open 1.54p) and tableText (byte-identical to File › Save As ›
// Results); IJPng; File › Import › Results…; the dialog field `path`.
//
// The other builders' files are replaced by stand-ins (ij_macro_plumbing_fakes.mjs + the ones below): this checks ij-app.js, ij-engine.js,
// ij-worker.js, ij-proc-io.js, ij-cmds-io.js, ij-view.js and the harness only.
//
// Run: node tests/js/test_ij_macro_files_plumbing.mjs
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { boot, until, J, loadViewModules } from './ij_harness.mjs';
import { FAKE_SOURCES, WORKER_MACRO, VFS_STANDIN, PAGE_CMDTAB, startRun } from './ij_macro_plumbing_fakes.mjs';

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok  ' + name); } catch (err) { console.error('FAIL ' + name); throw err; }
}
const reject = async (p, code, what) => {
  let err = null;
  try { await p; } catch (e) { err = e; }
  assert.ok(err, what + ': it must reject');
  assert.equal(err.code, code, what + ': ' + (err && err.code));
  return err;
};
const norm = (x) => JSON.parse(JSON.stringify(x, (k, v) => (v === undefined ? '__undefined__' : v)));
const deq = (a, b, m) => assert.deepStrictEqual(norm(a), norm(b), m);
const file = (name, content) => {
  const u8 = typeof content === 'string' ? new TextEncoder().encode(content) : content;
  return { name, size: u8.length, arrayBuffer: async () => u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength), text: async () => new TextDecoder().decode(u8) };
};

// ── stand-ins: a CMDTAB that knows two file commands and two commands that reach a picker; worker commands that expose the engine's E ──
const CMDTAB = PAGE_CMDTAB.replace("const IJMacroCmds = (() => {", `const IJMacroCmds = (() => {
  const FILES = {
    'Tiff...': { id: 'fileSaveTiff', entry: { name: 'Tiff...', cls: 'F', dialogs: [], file: { op: 'saveTiff', dialog: { kind: 'save', title: 'Save as TIFF' } } } },
    'ZIP...': { file: { op: 'saveZip', dialog: { kind: 'save', title: 'Save as TIFF/ZIP' } }, name: 'ZIP...' }
  };
  const PICKERS = { 'Pick Text Image': 'fileImportTextImage', 'Save Results Direct': 'fileSaveResults' };
  function fileRequest(spec, options) {
    globalThis.__fileRequests = (globalThis.__fileRequests || []).concat([{ spec, options }]);
    const m = options ? /(?:^| )save=(\\S+)/.exec(options) : null;
    return { op: spec.op, key: 'save', pathText: m ? m[1] : null, values: {} };
  }
  globalThis.__fileStand = { FILES, PICKERS, fileRequest };`).replace(
  "  function resolve(name) {\n",
  "  function resolve(name) {\n    if (globalThis.__fileStand.FILES[name]) return globalThis.__fileStand.FILES[name];\n    if (globalThis.__fileStand.PICKERS[name]) return { id: globalThis.__fileStand.PICKERS[name], entry: { name, cls: 'A', dialogs: [] } };\n").replace(
  "  return { resolve, headlessAnswer, nameOf: () => null, NO_IMAGE_TEXT: 'There are no images open' };",
  "  return { resolve, headlessAnswer, fileRequest, nameOf: () => null, NO_IMAGE_TEXT: 'There are no images open' };");
assert.ok(CMDTAB.includes('fileRequest, nameOf') && CMDTAB.includes('__fileStand.FILES[name]'), 'the CMDTAB stand-in was patched');

const WORKER_FILES = VFS_STANDIN + `
IJOpRegistry.defineCommand('plumb.decode', { pkg: 'macro', long: true, handler: async (a, E) => {
  const img = await E.decodeImage(a.bytes, { name: a.name, kind: a.kind, plane: a.plane });
  const shape = { name: img.name, width: img.width, height: img.height, bitDepth: img.bitDepth, rgb: !!img.rgb, nC: img.channels.length,
    planes: img.channels.map((c) => (Array.isArray(c.planes) ? c.planes.length : 1)), display: img.channels.map((c) => c.display || null) };
  if (!a.create) return { shape, data: img.channels.map((c) => Array.from(Array.isArray(c.planes) ? c.planes[0] : c.data)) };
  const info = E.createDoc(img, { clean: a.clean === true, provenance: { opened: true, file: a.file } });
  return { shape, info };
} });
IJOpRegistry.defineCommand('plumb.encode', { pkg: 'macro', long: true, handler: (a, E) => E.encodeImage(a.docId, a.o) });
IJOpRegistry.defineCommand('plumb.markSaved', { pkg: 'macro', long: true, handler: (a, E) => E.markSaved(a.docId, a.o) });
`;
const SOURCES = {
  workerSources: Object.assign({}, FAKE_SOURCES.workerSources, { 'ij-macro-vfs.js': WORKER_FILES }),
  pageSources: Object.assign({}, FAKE_SOURCES.pageSources, { 'ij-macro-cmds.js': CMDTAB })
};
const bootF = (more) => boot(Object.assign({}, SOURCES, more || {}));

// a PNG read back with node:zlib (the browser's decoder is not there): IHDR, PLTE and the unfiltered rows (filter 0 only: what IJPng writes)
function readPng(u8) {
  const b = Buffer.from(u8);
  assert.deepEqual(Array.from(b.subarray(0, 8)), [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'PNG signature');
  let p = 8, ihdr = null, plte = null;
  const idat = [];
  while (p < b.length) {
    const len = b.readUInt32BE(p), type = b.toString('latin1', p + 4, p + 8), body = b.subarray(p + 8, p + 8 + len);
    const crc = zlib.crc32 ? zlib.crc32(b.subarray(p + 4, p + 8 + len)) : null;
    if (crc !== null) assert.equal(crc >>> 0, b.readUInt32BE(p + 8 + len), 'CRC of ' + type);
    if (type === 'IHDR') ihdr = { w: body.readUInt32BE(0), h: body.readUInt32BE(4), depth: body[8], ctype: body[9] };
    else if (type === 'PLTE') plte = Uint8Array.from(body);
    else if (type === 'IDAT') idat.push(body);
    p += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bpp = (ihdr.ctype === 2 ? 3 : 1) * (ihdr.depth / 8);
  const stride = ihdr.w * bpp + 1;
  const rows = [];
  for (let y = 0; y < ihdr.h; y++) { assert.equal(raw[y * stride], 0, 'filter none'); rows.push(raw.subarray(y * stride + 1, (y + 1) * stride)); }
  return { ihdr, plte, rows };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
await test('loading: PACKAGE_PRE = language + file system, one importScripts call before ij-proc-macro.js; plugin.json lists ij-macro-vfs.js before ij-proc-macro.js', async () => {
  const t = await bootF();
  const A = t.IJApp;
  deq(Array.from(A.PACKAGE_PRE.macro), ['ij-macro-lang.js', 'ij-macro-vfs.js', 'ij-macro-params.js', 'ij-macro-math.js']);
  const mac = A.workerInit({ fileUrl: (f) => 'u:' + f }).packages.find((p) => p.pkg === 'macro');
  deq(mac.pre, ['u:ij-macro-lang.js', 'u:ij-macro-vfs.js', 'u:ij-macro-params.js', 'u:ij-macro-math.js']);
  const w = await t.spawn();
  assert.equal(t.failedPackages().size, 0, 'no package failed');
  assert.equal(w.far.__vfsLoaded, true, 'the file system ran in the worker');
  assert.ok(w.far.IJOpRegistry.getCommand('plumb.decode'), 'commands it defines are registered');
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { DIR } = await import('./ij_harness.mjs');
  const pj = JSON.parse(fs.readFileSync(path.join(DIR, 'plugin.json'), 'utf8')).scripts;
  assert.equal(pj.indexOf('ij-macro-vfs.js') + 1, pj.indexOf('ij-proc-macro.js'), 'right before ij-proc-macro.js');
  t.close();
});

await test('a broken ij-macro-vfs.js withdraws package macro alone (its commands too); the engine and every other package work', async () => {
  for (const more of [{ brokenPackages: ['ij-macro-vfs.js'] },
    { workerSources: Object.assign({}, SOURCES.workerSources, { 'ij-macro-vfs.js': 'throw new Error("the file system does not load");' }) }]) {
    const t = await bootF(more);
    await t.open();
    await until(() => t.failedPackages().has('macro'), 'packageFailed macro');
    deq([...t.failedPackages()], ['macro'], 'only package macro');
    assert.notEqual(t.worker.far.__macroLoaded, true, 'ij-proc-macro.js never ran without its file system');
    assert.equal(t.worker.far.IJOpRegistry.getCommand('macro.run'), null);
    assert.ok(t.worker.far.IJOpRegistry.get('invert'), 'the engine is there');
    await t.runCommand('editInvert');
    await reject(t.api('macro').macro.start({ runId: 'rb', source: 'x' }), 'IJ_MODULE_MISSING', 'macro.start');
    t.close();
  }
});

await test('vfs travels untouched: start({ vfs }) posts the same object (handles and File objects survive only a structured clone), result.vfs comes back; macro.reply / macro.vfs / macro.scan args too', async () => {
  const t = await bootF();
  await t.open();
  const api = t.api('macro');
  const handle = { kind: 'directory', name: 'data', queryPermission() {} };
  const theFile = file('a.tif', new Uint8Array([1, 2, 3]));
  const vfs = { roots: [{ id: '0123456789abcdef', name: 'data', kind: 'fsa', target: 'inplace', mode: 'ask', folderName: 'data', handle,
    snapshot: { rels: ['a.tif'], files: [theFile], dirs: [] } }], aliases: [{ literal: 'C:/data/', rootId: '0123456789abcdef', ci: true, createdAt: 1 }],
    mountId: 'fedcba9876543210', queue: { folders: 1, files: 0 } };
  const seen = [];
  const vfsResult = { needs: [{ kind: 'alias', literal: 'D:/x/', prefixes: ['D:/x/', 'D:/'] }], changedRoots: ['0123456789abcdef'] };
  t.log.intercept = (m) => {
    if (m.cmd === 'macro.run') { seen.push(m.args); return { ok: true, aborted: false, exited: false, error: null, changedDocs: [], undo: { changed: [], dropped: [] }, vfs: vfsResult }; }
    if (m.cmd === 'macro.vfs' || m.cmd === 'macro.scan' || m.cmd === 'macro.reply') { seen.push(m.args); return { ok: m.cmd }; }
    return undefined;
  };
  const r = await api.macro.start({ runId: 'v1', source: 'x', vfs });
  assert.equal(seen[0].vfs, vfs, 'the very object reached postMessage');
  assert.equal(seen[0].vfs.roots[0].handle, handle);
  assert.equal(seen[0].vfs.roots[0].snapshot.files[0], theFile);
  deq(r.vfs, vfsResult, 'result.vfs unchanged');
  const noVfs = await api.macro.start({ runId: 'v2', source: 'x' });
  assert.ok(noVfs);
  assert.equal(Object.prototype.hasOwnProperty.call(seen[1], 'vfs'), false, 'no vfs given: none sent');
  // the page copy of the worker commands: stand-in specs when RUNTIME's are not there yet
  const R = t.page.IJOpRegistry;
  if (!R.getCommand('macro.vfs')) R.defineCommand('macro.vfs', { pkg: 'macro', long: true, handler() {} });
  if (!R.getCommand('macro.scan')) R.defineCommand('macro.scan', { pkg: 'macro', passive: true, handler() {} });
  const grant = vfs.roots[0];
  await api.call('macro.reply', { runId: 'none', step: { grant } });
  assert.equal(seen[seen.length - 1].step.grant.handle, handle, 'macro.reply');
  await api.call('macro.vfs', { op: 'usage', roots: vfs.roots, aliases: vfs.aliases, mountId: vfs.mountId, texts: {} });
  assert.equal(seen[seen.length - 1].roots, vfs.roots, 'macro.vfs');
  await api.call('macro.scan', { source: 'getDirectory("Choose")', aliases: vfs.aliases });
  assert.equal(seen[seen.length - 1].aliases, vfs.aliases, 'macro.scan');
  t.log.intercept = null;
  t.close();
});

await test('run() of a file command: { status: "file", file: fileRequest + name + options }, no Studio command runs, no enabled test (no image needed)', async () => {
  const t = await bootF();
  await t.open();
  const run = await startRun(t);
  const api = run.api;
  const before = (await t.docs()).length;
  const r = await api.macro.runCommand('Tiff...', 'save=/data/o.tif', {});
  assert.equal(r.status, 'file');
  assert.equal(r.text, '');
  deq(r.created, []); deq(r.closed, []);
  assert.equal(r.current, t.activeId(), 'the macro\'s current image');
  deq(r.file, { op: 'saveTiff', key: 'save', pathText: '/data/o.tif', values: {}, name: 'Tiff...', options: 'save=/data/o.tif ' });
  const rq = t.page.__fileRequests[0];
  assert.equal(rq.options, 'save=/data/o.tif ', 'fileRequest gets the normalised options');
  deq(rq.spec, { op: 'saveTiff', dialog: { kind: 'save', title: 'Save as TIFF' } });
  // a FILE_NAMES command (no Studio command) and a null options string (the op will show its dialog)
  const z = await api.macro.runCommand('ZIP...', null, {});
  assert.equal(z.status, 'file');
  assert.equal(z.file.op, 'saveZip');
  assert.equal(z.file.pathText, null);
  assert.equal(z.file.options, null);
  assert.equal(t.saved.length, 0, 'nothing was downloaded');
  assert.equal((await t.docs()).length, before, 'no image made');
  // the current image named by the run is the one reported
  const z2 = await api.macro.runCommand('ZIP...', 'save=/a.zip', { current: 999999 });
  assert.equal(z2.current, t.activeId(), 'an unknown current falls back to the active image');
  await run.end();
  // no image at all: still a file request (the op says ImageJ's "There are no images open")
  t.close();
});

await test('F9 guard: inside a command a macro started, pickFile / saveFile reject IJ_MACRO_FILE_DIRECT before any picker; the run gets err.macFileDirect; outside a macro they work as before', async () => {
  const t = await bootF();
  await t.open();
  const created = [];
  const realCreate = t.page.document.createElement;
  t.page.document.createElement = (tag) => { created.push(tag); return realCreate(tag); };
  await t.runCommand('analyzeMeasure');
  const run = await startRun(t);
  const api = run.api;
  t.pickFile([file('x.txt', '1 2\n3 4\n')]);
  const r = await api.macro.runCommand('Pick Text Image', null, {});
  assert.equal(r.status, 'failed');
  assert.ok(/Pick Text Image/.test(r.text) || r.text === 'err.macFileDirect', 'the macro error names the command: ' + r.text);
  assert.ok(!created.includes('input'), 'no file input was made');
  // the internal save path (saveFile, used by File › Save As › Results) refuses too, before the picker / the download
  const s0 = t.saved.length;
  const r2 = await api.macro.runCommand('Save Results Direct', null, {});
  assert.equal(r2.status, 'failed');
  assert.ok(/Save Results Direct/.test(r2.text) || r2.text === 'err.macFileDirect', r2.text);
  assert.equal(t.saved.length, s0, 'no download');
  await run.end();
  // outside a macro: the picker opens (the scripted answer is used) and the save downloads, as before
  t.page.document.createElement = realCreate;
  const n0 = (await t.docs()).length;
  await t.runCommand('fileImportTextImage');
  await until(async () => (await t.docs()).length > n0, 'the text image opened');
  await t.runCommand('fileSaveResults');
  assert.equal(t.saved.length, s0 + 1, 'Save As › Results downloaded');
  // the api members themselves, outside a lane
  t.pickFile(null);
  assert.equal(await t.api('io').pickFile({ accept: '.txt' }), null, 'a cancelled picker is null');
  t.close();
});

await test('mirror: images[i].file from the engine, roiManager.open, front (image, a table window, a text window the page reports), read-only file settings', async () => {
  const t = await bootF();
  await t.open();
  const api = t.api('macro');
  let m = api.macro.mirror();
  assert.equal(m.images[0].file, null);
  assert.equal(m.roiManager.open, false);
  deq(m.front, { kind: 'image', title: m.images[0].title });
  deq([m.settings['ana.saveHeaders'], m.settings['ana.saveRowNumbers'], m.settings['ana.ext'], m.settings['io.jpegQuality']], [true, true, '.csv', 85], 'the defaults of Input/Output');
  assert.throws(() => api.macro.settings.set('io.jpegQuality', 50), (e) => e.code === 'IJ_EXT_FORBIDDEN', 'read only for macros');
  t.api('io').settings.set('io.jpegQuality', 60);
  assert.equal(api.macro.settings.get('io.jpegQuality'), 60, 'the operator\'s value');
  // an image the worker made from a file: its origin
  const tif = await t.engine('doc.exportTiff', { docId: t.activeId() });
  const made = await t.engine('plumb.decode', { bytes: tif.bytes, name: 'a.tif', kind: 'tiff', create: true, clean: true,
    file: { rootId: '0123456789abcdef', root: 'data', rel: 'sub/a.tif', dir: '/data/sub/', name: 'a.tif', format: 'tiff' } });
  await api.macro.adopt(made.info.docId);
  m = api.macro.mirror();
  const im = m.images.find((i) => i.docId === made.info.docId);
  deq(im.file, { dir: '/data/sub/', name: 'a.tif', format: 'tiff' }, 'the virtual origin, nothing else');
  assert.equal(im.changes, false, 'an opened file is not unsaved');
  // the ROI Manager window, a table window, then an image again
  t.api(null).openTool('roiManager');
  assert.equal(api.macro.mirror().roiManager.open, true);
  t.api(null).openTable('Summary', ['A'], [[1]]);
  deq(api.macro.mirror().front, { kind: 'table', title: 'Summary' });
  api.macro.noteFront('log', 'Log');
  deq(api.macro.mirror().front, { kind: 'log', title: 'Log' });
  assert.throws(() => api.macro.noteFront('image', 'x'), (e) => e.code === 'IJ_BAD_ARGS');
  await api.macro.selectImage(made.info.docId);
  deq(api.macro.mirror().front, { kind: 'image', title: im.title }, 'an activated image takes the front back');
  t.close();
});

await test('E.decodeImage: TIFF (stack, one plane of it), 16-bit PNG (decode16, stays 16-bit), text image; no picture decoder = IJ_IO_DECODE; createDoc clean / not clean', async () => {
  const t = await bootF();
  const w = await t.spawn();
  // a 2-channel x 3-slice 16-bit stack
  const W = 5, H = 3, n = W * H;
  const planes = (c) => Array.from({ length: 3 }, (_, z) => Uint16Array.from({ length: n }, (_, i) => 1000 * c + 100 * z + i));
  const st = await t.engine('doc.import', { image: { name: 'st', width: W, height: H, bitDepth: 16, nZ: 3, nT: 1, calibration: { pixelWidth: 0.5, pixelHeight: 0.5, unit: 'µm' },
    channels: [{ planes: planes(0), name: 'A', color: '#ff0000' }, { planes: planes(1), name: 'B', color: '#00ff00' }] } }, w);
  const tif = await t.engine('plumb.encode', { docId: st.docId || st.info.docId, o: { format: 'tiff' } }, w);
  const exp = await t.engine('doc.exportTiff', { docId: st.docId || st.info.docId }, w);
  deq(Array.from(tif.bytes), Array.from(exp.bytes), 'encodeImage tiff = doc.exportTiff, byte for byte');
  assert.equal(tif.rev, exp.rev);
  const back = await t.engine('plumb.decode', { bytes: tif.bytes, name: 'st.tif', kind: 'tiff' }, w);
  deq([back.shape.width, back.shape.height, back.shape.bitDepth, back.shape.nC, back.shape.planes], [W, H, 16, 2, [3, 3]], 'the stack reads back');
  deq(back.data[0], Array.from(planes(0)[0]));
  // Opener.openTiff(path, n): n = 4 = channel 2, slice 2 (channels fastest)
  const p4 = await t.engine('plumb.decode', { bytes: tif.bytes, name: 'st.tif', kind: 'tiff', plane: 4 }, w);
  deq([p4.shape.nC, p4.shape.planes], [1, [1]]);
  deq(p4.data[0], Array.from(planes(1)[1]), 'the 4th image of the file');
  await reject(t.engine('plumb.decode', { bytes: tif.bytes, kind: 'tiff', plane: 7 }, w), 'IJ_IO_PLANE', 'N out of range');
  // 16-bit grey PNG: written by encodeImage (write16gs), read by decode16
  const g16 = await t.engine('doc.import', { image: { name: 'g16', width: W, height: H, bitDepth: 16, calibration: { pixelWidth: 1, pixelHeight: 1, unit: 'px' },
    channels: [{ data: Uint16Array.from({ length: n }, (_, i) => i * 4000), name: 'C1', color: '#ffffff', display: { min: 0, max: 100, lut: 'Grays', invert: false } }] } }, w);
  const png = await t.engine('plumb.encode', { docId: g16.docId || g16.info.docId, o: { format: 'png' } }, w);
  const pg = await t.engine('plumb.decode', { bytes: png.bytes, name: 'g.png', kind: 'picture', create: true, clean: true, file: { dir: '/data/', name: 'g.png', format: 'png' } }, w);
  deq([pg.shape.bitDepth, pg.shape.width, pg.shape.height], [16, W, H], 'a 16-bit PNG stays 16-bit');
  const pgPix = await t.engine('doc.tile', { docId: pg.info.docId, channel: 0, level: 0, tx: 0, ty: 0 }, w);
  deq(Array.from(pgPix.data), Array.from({ length: n }, (_, i) => i * 4000), 'raw values, whatever the display range');
  deq([pg.info.unsaved, pg.info.file], [false, { dir: '/data/', name: 'g.png', format: 'png' }], 'clean, with its origin');
  // an 8-bit PNG needs the browser's decoder: none in this worker
  const g8 = await t.engine('doc.import', { image: { name: 'g8', width: 2, height: 1, bitDepth: 8, channels: [{ data: Uint8Array.of(3, 9), name: 'C1', color: '#ffffff' }] } }, w);
  const png8 = await t.engine('plumb.encode', { docId: g8.docId || g8.info.docId, o: { format: 'png' } }, w);
  await reject(t.engine('plumb.decode', { bytes: png8.bytes, kind: 'picture' }, w), 'IJ_IO_DECODE', 'no createImageBitmap / OffscreenCanvas');
  // text image: 32-bit, header row dropped
  const tx = await t.engine('plumb.decode', { bytes: new TextEncoder().encode('x\ty\n1.5\t2\n3\t-4\n'), name: 'n.txt', kind: 'text', create: true }, w);
  deq([tx.shape.bitDepth, tx.shape.width, tx.shape.height, tx.info.unsaved], [32, 2, 2, true], 'a 32-bit image; not clean when the caller does not say so');
  await reject(t.engine('plumb.decode', { bytes: new Uint8Array(0), kind: 'tiff' }, w), 'IJ_BAD_ARGS', 'no bytes');
  await reject(t.engine('plumb.decode', { bytes: new Uint8Array(4), kind: 'avi' }, w), 'IJ_BAD_ARGS', 'unknown kind');
  // a FileOrigin is virtual strings only
  await reject(t.engine('plumb.decode', { bytes: tif.bytes, kind: 'tiff', create: true, file: { dir: 'C:\\data\\', name: 'a.tif' } }, w), 'IJ_BAD_ARGS', 'a machine path is refused');
  t.close();
});

await test('E.encodeImage: PNG as PNG_Writer (grey 8-bit raw, stretched / coloured 8-bit = palette, 32-bit through create8BitImage, composite and RGB = RGB), ZIP, raw, JPEG through OffscreenCanvas', async () => {
  const t = await bootF();
  const w = await t.spawn();
  const id = (r) => r.docId !== undefined ? r.docId : r.info.docId;
  const imp = (image) => t.engine('doc.import', { image }, w).then(id);
  const enc = (docId, o) => t.engine('plumb.encode', { docId, o }, w);
  const g8 = await imp({ name: 'g8', width: 3, height: 2, bitDepth: 8, channels: [{ data: Uint8Array.of(0, 10, 20, 30, 200, 255), name: 'C1', color: '#ffffff', display: { min: 0, max: 255, lut: 'Grays', invert: false } }] });
  let p = readPng((await enc(g8, { format: 'png' })).bytes);
  deq([p.ihdr.ctype, p.ihdr.depth, p.plte], [0, 8, null], 'default grey LUT, full range: a greyscale PNG');
  deq(Array.from(p.rows[0]).concat(Array.from(p.rows[1])), [0, 10, 20, 30, 200, 255], 'the pixels themselves');
  // the same pixels with a stretched range: ByteProcessor bakes it into the LUT, the indices stay
  const s8 = await imp({ name: 's8', width: 3, height: 2, bitDepth: 8, channels: [{ data: Uint8Array.of(0, 10, 20, 30, 200, 255), name: 'C1', color: '#ffffff', display: { min: 10, max: 30, lut: 'Grays', invert: false } }] });
  p = readPng((await enc(s8, { format: 'png' })).bytes);
  assert.equal(p.ihdr.ctype, 3, 'palette');
  deq(Array.from(p.rows[0]), [0, 10, 20], 'indices unchanged');
  deq([p.plte[0], p.plte[9 * 3], p.plte[10 * 3], p.plte[20 * 3], p.plte[31 * 3]], [0, 0, 0, 128, 255], 'ByteProcessor.setMinAndMax table');
  // Fire LUT
  const f8 = await imp({ name: 'f8', width: 2, height: 1, bitDepth: 8, channels: [{ data: Uint8Array.of(0, 128), name: 'C1', color: '#ffffff', display: { min: 0, max: 255, lut: 'Fire', invert: false } }] });
  p = readPng((await enc(f8, { format: 'png' })).bytes);
  assert.equal(p.ihdr.ctype, 3);
  const fire = t.worker.far.IJLuts.get('Fire');
  deq(Array.from(p.plte), Array.from(fire), 'the PLTE is the LUT');
  // 32-bit: FloatProcessor.create8BitImage then the (grey) table
  const f32 = await imp({ name: 'f32', width: 3, height: 1, bitDepth: 32, channels: [{ data: Float32Array.of(0, 0.5, 1), name: 'C1', color: '#ffffff', display: { min: 0, max: 1, lut: 'Grays', invert: false } }] });
  p = readPng((await enc(f32, { format: 'png' })).bytes);
  deq([p.ihdr.ctype, Array.from(p.rows[0])], [0, [0, 128, 255]], '(int)((v-min)*255/(max-min)+0.5)');
  // a 16-bit image with a coloured LUT is not write16gs: create8BitImage + the LUT
  const c16 = await imp({ name: 'c16', width: 2, height: 1, bitDepth: 16, channels: [{ data: Uint16Array.of(0, 1000), name: 'C1', color: '#ff0000', display: { min: 0, max: 1000, lut: 'Red', invert: false } }] });
  p = readPng((await enc(c16, { format: 'png' })).bytes);
  deq([p.ihdr.ctype, p.ihdr.depth], [3, 8]);
  // a composite: the RGB of its display
  const comp = await imp({ name: 'comp', width: 2, height: 1, bitDepth: 8, mode: 'composite', channels: [
    { data: Uint8Array.of(255, 0), name: 'R', color: '#ff0000', display: { min: 0, max: 255, lut: 'Red', invert: false } },
    { data: Uint8Array.of(0, 255), name: 'G', color: '#00ff00', display: { min: 0, max: 255, lut: 'Green', invert: false } }] });
  p = readPng((await enc(comp, { format: 'png' })).bytes);
  deq([p.ihdr.ctype, Array.from(p.rows[0])], [2, [255, 0, 0, 0, 255, 0]], 'a red pixel, a green pixel');
  // RGB image
  const rgb = await imp({ name: 'rgb', width: 1, height: 1, bitDepth: 8, rgb: true, channels: [{ data: Uint8Array.of(1), name: 'Red', color: '#ff0000' }, { data: Uint8Array.of(2), name: 'Green', color: '#00ff00' }, { data: Uint8Array.of(3), name: 'Blue', color: '#0000ff' }] });
  p = readPng((await enc(rgb, { format: 'png' })).bytes);
  deq([p.ihdr.ctype, Array.from(p.rows[0])], [2, [1, 2, 3]]);
  // ZIP: one STORE entry "<title minus .zip>.tif" holding the TIFF
  const z = await enc(g8, { format: 'zip' });
  const entries = await t.page.IJRoiCodec.zipRead(z.bytes);
  deq(entries.map((e) => e.name), ['g8.tif']);
  deq(Array.from(entries[0].bytes), Array.from((await t.engine('doc.exportTiff', { docId: g8 }, w)).bytes), 'the entry is the TIFF');
  await t.engine('doc.rename', { docId: g8, name: 'r.zip' }, w);
  deq((await t.page.IJRoiCodec.zipRead((await enc(g8, { format: 'zip' })).bytes)).map((e) => e.name), ['r.tif'], 'FileSaver.saveAsZip naming');
  deq((await t.page.IJRoiCodec.zipRead((await enc(g8, { format: 'zip', entryName: 'x.tif' })).bytes)).map((e) => e.name), ['x.tif']);
  // raw: big-endian, every plane in stack order (c fastest)
  const two = await imp({ name: 'two', width: 2, height: 1, bitDepth: 16, nZ: 2, nT: 1, channels: [
    { planes: [Uint16Array.of(1, 2), Uint16Array.of(5, 6)], name: 'A', color: '#ffffff' }, { planes: [Uint16Array.of(3, 4), Uint16Array.of(7, 8)], name: 'B', color: '#ffffff' }] });
  deq(Array.from((await enc(two, { format: 'raw' })).bytes), [0, 1, 0, 2, 0, 3, 0, 4, 0, 5, 0, 6, 0, 7, 0, 8], 'c1z1 c2z1 c1z2 c2z2');
  deq(Array.from((await enc(rgb, { format: 'raw' })).bytes), [1, 2, 3], 'an RGB pixel = R G B');
  deq(Array.from((await enc(f32, { format: 'raw' })).bytes.slice(4, 8)), [0x3f, 0, 0, 0], '0.5f big-endian');
  // JPEG: no encoder in this worker; with one, the displayed RGB at the quality asked
  await reject(enc(g8, { format: 'jpeg' }), 'IJ_IO_ENCODE', 'no OffscreenCanvas');
  const seen = {};
  t.worker.far.OffscreenCanvas = class {
    constructor(W, H) { this.width = W; this.height = H; }
    getContext() { return { createImageData: (W, H) => ({ data: new Uint8ClampedArray(W * H * 4) }), putImageData: (im) => { seen.rgba = Array.from(im.data); } }; }
    async convertToBlob(o) { seen.opts = o; return new Blob([Uint8Array.of(0xff, 0xd8, 0xff)], { type: 'image/jpeg' }); }
  };
  const j = await enc(comp, { format: 'jpeg', quality: 70 });
  deq(Array.from(j.bytes), [0xff, 0xd8, 0xff]);
  deq(seen.opts, { type: 'image/jpeg', quality: 0.7 });
  deq(seen.rgba, [255, 0, 0, 255, 0, 255, 0, 255], 'the composite as displayed, opaque');
  await enc(s8, { format: 'jpeg' });
  assert.equal(seen.opts.quality, 0.85, 'JpegWriter default quality 85');
  deq(seen.rgba.slice(0, 12), [0, 0, 0, 255, 0, 0, 0, 255, 128, 128, 128, 255], 'an 8-bit image through its stretched table');
  await reject(enc(g8, { format: 'gif' }), 'IJ_BAD_ARGS', 'a format the Studio does not write');
  t.close();
});

await test('E.markSaved: the revision written is the saved one, provenance.file = the FileOrigin (null clears), info.file follows; persisted with the session', async () => {
  const t = await bootF();
  const w = await t.spawn();
  const d = await t.engine('doc.import', { image: { name: 'm', width: 2, height: 1, bitDepth: 8, channels: [{ data: Uint8Array.of(1, 2), name: 'C1', color: '#ffffff' }] } }, w);
  const docId = d.docId !== undefined ? d.docId : d.info.docId;
  const e = await t.engine('plumb.encode', { docId, o: { format: 'tiff' } }, w);
  const info = await t.engine('plumb.markSaved', { docId, o: { rev: e.rev, file: { rootId: 'aa', root: 'data', rel: 'm.tif', dir: '/data/', name: 'm.tif', format: 'tiff' } } }, w);
  deq([info.unsaved, info.file], [false, { dir: '/data/', name: 'm.tif', format: 'tiff' }]);
  const full = await t.engine('doc.info', { docId }, w);
  deq(full.provenance.file, { dir: '/data/', name: 'm.tif', rootId: 'aa', root: 'data', rel: 'm.tif', format: 'tiff' });
  const cleared = await t.engine('plumb.markSaved', { docId, o: { file: null } }, w);
  assert.equal(cleared.file, null);
  await reject(t.engine('plumb.markSaved', { docId, o: { file: { dir: '/data', name: 'x' } } }, w), 'IJ_BAD_ARGS', 'a directory ends with /');
  t.close();
});

await test('IJTextIo.readTable = ResultsTable.open 1.54p; tableText = File › Save As › Results byte for byte (csv and tsv)', async () => {
  const t = await bootF();
  await t.open();
  const T = t.page.IJTextIo;
  // an ImageJ Results file: row numbers, Label, a NaN
  let r = T.readTable(' ,Label,Area,Mean\n1,a.tif,12,3.5\n2,b,4,NaN\n', { name: 'Results.csv' });
  deq([r.size, r.headings, r.columns.Area, r.labels, r.showRowNumbers], [2, ['Area', 'Mean'], [12, 4], ['a.tif', 'b'], true]);
  assert.ok(Number.isNaN(r.columns.Mean[1]));
  // quoted commas stay in their cell; text cells are strings
  r = T.readTable('Name,Value\n"a,b",1\nc,x\n', { name: 't.csv' });
  deq([r.headings, r.columns.Name, r.columns.Value, r.labels, r.showRowNumbers], [['Name', 'Value'], ['a,b', 'c'], [1, 'x'], null, false]);
  // tab separated (not .csv), all-numeric first line = no header: C1, C2
  r = T.readTable('1\t2\r\n3\t4\r\n', { name: 'n.txt' });
  deq([r.size, r.headings, r.columns.C1, r.columns.C2], [2, ['C1', 'C2'], [1, 3], [2, 4]]);
  // a missing cell is NaN, a trailing empty cell is dropped by String.split
  r = T.readTable('a\tb\tc\n1\t2\n', { name: 'm.tsv' });
  deq([r.columns.a, r.columns.b], [[1], [2]]);
  assert.ok(Number.isNaN(r.columns.c[0]));
  // header only, empty, invalid
  r = T.readTable('A,B\n', { name: 'h.csv' });
  deq([r.size, r.headings], [0, ['A', 'B']]);
  deq(T.readTable('', { name: 'e.csv' }).size, 0, 'an empty file = an empty table');
  assert.throws(() => T.readTable('\n\n', { name: 'e.csv' }), (e) => e.code === 'IJ_IO_TABLE_EMPTY' && e.ijText === 'Table is empty or invalid');
  assert.throws(() => T.readTable(',,,\n1,2\n', { name: 'i.csv' }), (e) => e.code === 'IJ_IO_TABLE_INVALID' && e.ijText === 'This is not a tab or comma delimited text file.');
  assert.throws(() => T.readTable('Error: x\n', { name: 'q.csv', path: '/d/q.csv' }), (e) => e.code === 'IJ_IO_TABLE_ERROR' && e.ijText === 'Error opening /d/q.csv');
  // a BOM on the first heading is removed; Java's parseDouble trims
  r = T.readTable(new Uint8Array([0xef, 0xbb, 0xbf].concat(Array.from(new TextEncoder().encode('X,Y\n 1 ,2\n')))), { name: 'b.csv' });
  deq([r.headings, r.columns.X], [['X', 'Y'], [1]]);
  // tableText vs the operator's own File › Save As › Results
  const api = t.api('macro');
  await t.runCommand('analyzeMeasure');
  await t.runCommand('analyzeMeasure');
  for (const [ext, sep] of [['.csv', ','], ['.tsv', '\t'], ['.txt', '\t']]) {
    t.api('ana').settings.set('ana.ext', ext);
    const s0 = t.saved.length;
    await t.runCommand('fileSaveResults');
    const op = await t.saved[s0].blob.text();
    const mine = T.tableText(api.macro.results.get(), { sep, headers: true, rowNumbers: true, precision: 3 });
    assert.equal(mine, op, 'identical to Save As › Results (' + ext + ')');
    assert.ok(op.split('\n').length === 4 && op.endsWith('\n'), 'header + 2 rows');
  }
  // headers / row numbers off, a label, a comma in a CSV cell, an empty cell
  const sa = t.api('ana').settings; sa.set('ana.saveHeaders', false); sa.set('ana.saveRowNumbers', false); sa.set('ana.ext', '.csv');
  api.macro.results.replace({ name: 'Results', size: 2, headings: ['Area', 'Note'], columns: { Area: [1.25, null], Note: ['a,b', 'q"x'] }, labels: ['L1', null], rev: 0 });
  const s1 = t.saved.length;
  await t.runCommand('fileSaveResults');
  const op2 = await t.saved[s1].blob.text();
  // Area held 1.25: ResultsTable gave the column 3 decimal places, so its missing cell (0) prints 0.000
  assert.equal(T.tableText(api.macro.results.get(), { sep: ',', headers: false, rowNumbers: false, precision: 3, decimalColumn: (h) => h === 'Area' }), op2);
  assert.equal(op2, 'L1,1.250,"a,b"\n,0.000,"q""x"\n', 'ResultsTable precision 3, a missing cell of a decimal column 0.000, quotes doubled');
  t.close();
});

await test('File › Import › Results…: the file replaces the Results table (labels, numbers, strings); a bad file is reported', async () => {
  const t = await bootF();
  await t.open();
  await t.runCommand('analyzeMeasure');
  const c = t.cmd('fileImportResults');
  assert.ok(c, 'registered by package io');
  deq(c.menu, ['File', 'Import']);
  t.pickFile([file('Results.csv', ' ,Label,Area,Kind\n1,a,2.5,x\n2,b,4,y\n')]);
  await t.runCommand('fileImportResults');
  const r = t.api('macro').macro.results.get();
  deq([r.size, r.labels, r.columns.Area, r.columns.Kind], [2, ['a', 'b'], [2.5, 4], ['x', 'y']]);
  t.pickFile([file('bad.csv', '\n\n')]);
  const errs = await t.runCommand('fileImportResults', undefined, { expectError: true });
  assert.equal(errs.length, 1);
  t.pickFile(null);
  await t.runCommand('fileImportResults');
  t.close();
});

await test('IJPng (page copy): encode then decode16 round trip, interlaced 16-bit decoded, any other PNG = null', async () => {
  const t = await bootF({ fs: {} });
  const P = t.page.IJPng;
  const data = Uint16Array.from({ length: 7 * 5 }, (_, i) => (i * 1999) & 0xffff);
  const png = await P.encode({ width: 7, height: 5, kind: 'gray16', data });
  const back = await P.decode16(png);
  deq([back.width, back.height, back.bitDepth, Array.from(back.channels[0].data)], [7, 5, 16, Array.from(data)]);
  deq([back.channels[0].display.min, back.channels[0].display.max], [Math.min(...data), Math.max(...data)], 'display range = data range');
  assert.equal(await P.decode16(await P.encode({ width: 2, height: 1, kind: 'gray8', data: Uint8Array.of(1, 2) })), null, '8-bit: not ours');
  assert.equal(await P.decode16(new Uint8Array(40)), null, 'not a PNG');
  // an Adam7-interlaced 16-bit PNG (written here: 3 x 3, each pass row with filter 0)
  const W = 3, H = 3, val = (x, y) => 1000 + 10 * y + x;
  const passes = [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]];
  const raw = [];
  for (const [x0, y0, dx, dy] of passes) {
    for (let y = y0; y < H; y += dy) {
      const row = [];
      for (let x = x0; x < W; x += dx) row.push(val(x, y) >> 8, val(x, y) & 255);
      if (row.length) raw.push(0, ...row);
    }
  }
  const chunk = (type, body) => { const b = Buffer.alloc(12 + body.length); b.writeUInt32BE(body.length, 0); b.write(type, 4, 'latin1'); Buffer.from(body).copy(b, 8); b.writeUInt32BE(0, 8 + body.length); return b; };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 16; ihdr[9] = 0; ihdr[12] = 1;
  const file2 = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.from(raw))), chunk('IEND', Buffer.alloc(0))]);
  const il = await P.decode16(new Uint8Array(file2));
  deq(Array.from(il.channels[0].data), Array.from({ length: 9 }, (_, i) => val(i % 3, Math.floor(i / 3))), 'Adam7');
  t.close();
});

await test('dialog field "path": schema (pathKind, browse), value collected as a string, a Browse… button that calls browse() first and writes the answer', async () => {
  const P = (await bootF()).IJViewPure;
  deq(P.fieldProblems([{ type: 'path', id: 'd', label: 'Dir', value: '', pathKind: 'directory', browse: () => null }]), []);
  assert.ok(P.fieldProblems([{ type: 'path', id: 'd', label: 'Dir' }]).some((x) => /pathKind/.test(x)), 'pathKind required');
  assert.ok(P.fieldProblems([{ type: 'path', id: 'd', label: 'Dir', pathKind: 'file', browse: 3 }]).some((x) => /browse/.test(x)));
  deq(P.collectFields([{ type: 'path', id: 'd', label: 'D', pathKind: 'file' }], { d: '/data/a.tif' }).values, { d: '/data/a.tif' });
  // the real dialog on a minimal DOM
  const listeners = new Map();
  class FEl {
    constructor(tag, doc) { this.tagName = tag.toUpperCase(); this.ownerDocument = doc; this.style = {}; this.dataset = {}; this.children = []; this.parentNode = null; this._ls = []; this.classList = { set: new Set(), add(...c) { c.forEach((x) => this.set.add(x)); }, remove(...c) { c.forEach((x) => this.set.delete(x)); }, contains(c) { return this.set.has(c); }, toggle() {} }; this.value = ''; this.checked = false; this.type = ''; this.hidden = false; this._text = ''; this.id = ''; }
    set className(v) { this.classList.set = new Set(String(v).split(/\s+/).filter(Boolean)); }
    get className() { return Array.from(this.classList.set).join(' '); }
    get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }
    set textContent(v) { this.children = []; this._text = String(v); }
    appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
    append(...cs) { cs.forEach((c) => this.appendChild(c)); }
    removeChild(c) { this.children = this.children.filter((x) => x !== c); return c; }
    get firstChild() { return this.children[0] || null; }
    contains(n) { for (let x = n; x; x = x.parentNode) if (x === this) return true; return false; }
    setAttribute() {} getAttribute() { return null; } removeAttribute() {}
    addEventListener(ev, fn) { this._ls.push({ ev, fn }); listeners.set(listeners.size, fn); }
    removeEventListener(ev, fn) { this._ls = this._ls.filter((l) => !(l.ev === ev && l.fn === fn)); }
    dispatchEvent(e) { e.target = this; for (const l of this._ls.slice()) if (l.ev === e.type) l.fn(e); return true; }
    fire(ev, e = {}) { const evt = Object.assign({ type: ev, target: this, preventDefault() {}, stopPropagation() {} }, e); for (const l of this._ls.slice()) if (l.ev === ev) l.fn(evt); return evt; }
    focus() { this.ownerDocument.activeElement = this; } select() {} setPointerCapture() {} releasePointerCapture() {}
    getBoundingClientRect() { return { left: 0, top: 0, right: 200, bottom: 20, width: 200, height: 20 }; }
    get offsetWidth() { return 220; } get offsetHeight() { return 120; } get offsetLeft() { return 0; } get offsetTop() { return 0; }
    closest() { return null; }
    querySelectorAll() { return []; } querySelector() { return null; }
    getContext() { return new Proxy({}, { get: () => () => {} }); }
  }
  const win = { devicePixelRatio: 1, innerWidth: 1000, innerHeight: 700, requestAnimationFrame: (f) => setTimeout(f, 0), cancelAnimationFrame() {}, getComputedStyle: () => ({ position: 'relative' }), addEventListener() {}, removeEventListener() {} };
  const doc = { defaultView: win, activeElement: null, createElement: (tg) => new FEl(tg, doc), createElementNS: (ns, tg) => new FEl(tg, doc), contains: () => true, addEventListener() {}, removeEventListener() {} };
  doc.body = new FEl('body', doc);
  class FEvent { constructor(type, init = {}) { this.type = type; Object.assign(this, init); } }
  const M = loadViewModules({ Event: FEvent, document: doc, window: win });
  const root = new FEl('div', doc); root.clientWidth = 1000; root.clientHeight = 700; doc.body.appendChild(root);
  const shell = { windows: M.IJWindows.create({ root, t: (k, f) => f }) };
  let browsed = 0, answer = null;
  const browse = () => { browsed++; return new Promise((r) => { answer = r; }); };
  const p = shell.windows.dialog({ title: 'D', fields: [{ type: 'path', id: 'dir', label: 'Directory', value: '/x/', pathKind: 'directory', browse }] });
  const all = [];
  const walk = (n) => { for (const c of n.children) { all.push(c); walk(c); } };
  walk(root);
  walk(doc.body);
  const input = all.find((n) => n.tagName === 'INPUT' && n.name === 'dir');
  const btn = all.find((n) => n.tagName === 'BUTTON' && n.classList.contains('ij-field-browse'));
  assert.ok(input && btn, 'a text input and a Browse button');
  assert.equal(input.value, '/x/');
  assert.equal(btn.textContent, 'Browse...');
  btn.fire('click');
  assert.equal(browsed, 1, 'browse() ran inside the click');
  answer('/data/');
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(input.value, '/data/', 'the answer is written into the field');
  btn.fire('click');
  answer(null);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(input.value, '/data/', 'a cancelled browse leaves the field as it was');
  const now = [];
  const w2 = (n) => { for (const c of n.children) { now.push(c); w2(c); } };
  w2(root); w2(doc.body);
  const okBtn = now.find((n) => n.tagName === 'BUTTON' && !n.classList.contains('ij-field-browse') && /ok/i.test(n.textContent));
  assert.ok(okBtn, 'the OK button: ' + now.filter((n) => n.tagName === 'BUTTON').map((n) => n.textContent).join('|'));
  okBtn.fire('click');
  deq(await p, { dir: '/data/' }, 'the value of the path field is its text');
});

await test('harness boot({ fs }): pickers, IndexedDB and storage on the page, OPFS + FileReaderSync in the worker, t.gesture = transient activation; without fs nothing changes', async () => {
  let F;
  try { F = await import('./ij_macro_fs_fakes.mjs'); } catch (_) { F = null; }
  if (!F) { console.log('SKIP harness fs hooks: tests/js/ij_macro_fs_fakes.mjs is not there yet'); return; }
  const disk = F.makeFakeDisk({ 'a.txt': 'x' });
  const opfs = F.makeFakeOpfs({ quota: 1 << 20 });
  const pickers = F.makePickers({ directory: disk.dir() });
  const idb = F.makeFakeIndexedDB();
  const t = await bootF({ fs: { opfs, pickers, idb } });
  assert.equal(typeof t.page.showDirectoryPicker, 'function');
  assert.equal(t.page.indexedDB, idb);
  let refused = null;
  try { await t.page.showDirectoryPicker({ mode: 'readwrite' }); } catch (e) { refused = e; }
  assert.ok(refused && refused.name === 'SecurityError', 'a picker without a gesture is refused');
  const h = await t.gesture(() => t.page.showDirectoryPicker({ mode: 'readwrite' }));
  assert.equal(h.kind, 'directory', 'with a gesture it opens');
  assert.equal(t.page.__activation, false, 'the activation ends with the synchronous part');
  const est = await t.page.navigator.storage.estimate();
  assert.ok(est && typeof est.quota === 'number');
  const w = await t.spawn();
  assert.equal(typeof w.far.navigator.storage.getDirectory, 'function');
  assert.equal(await w.far.navigator.storage.getDirectory(), opfs.root, 'the worker\'s OPFS root is the fake\'s');
  assert.equal(w.far.FileReaderSync, F.FakeFileReaderSync, 'FileReaderSync from the fakes');
  assert.equal(typeof w.far.CompressionStream, 'function');
  t.close();
  const t2 = await bootF();
  assert.equal(t2.page.showDirectoryPicker, undefined);
  assert.equal(t2.page.indexedDB, undefined);
  const w2 = await t2.spawn();
  assert.equal(w2.far.navigator.storage, undefined, 'no OPFS without fs');
  assert.equal(w2.far.FileReaderSync, undefined);
  t2.close();
});

console.log(`test_ij_macro_files_plumbing: ${passed} passed`);
