// P-io — the commands and the ROI Manager window, end to end through tests/js/ij_harness.mjs: the real menu command (dialog values,
// file picker) → the real engine in the worker → what is saved / shown → reload() restore:
//   File › Import › Text Image…, File › Save As › Text Image… / Selection… / XY Coordinates…, Analyze › Tools › Save XY Coordinates…,
//   File › Open (TIFF, deflate TIFF, PNG / JPEG / GIF / BMP, text image, .roi, RoiSet .zip, .lut, unknown),
//   the ROI Manager window (every button, the More » popup in ImageJ's order, multi-selection, style, files) and its operations.
//
// Run: node tests/js/test_ij_io_commands.mjs
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { boot, until, EN, J } from './ij_harness.mjs';
import { buildTiff } from './ij_io_support.mjs';

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { console.error('FAIL ' + name); throw e; }
}
const arr = (a) => Array.from(a);
// values of the page / worker realm differ in prototype from ours: compare by structure, undefined kept visible
const norm = (x) => JSON.parse(JSON.stringify(x, (k, v) => (v === undefined ? '__undefined__' : v)));
const deq = (a, b, m) => (m === undefined ? assert.deepStrictEqual(norm(a), norm(b)) : assert.deepStrictEqual(norm(a), norm(b), m));
const rect = (x, y, w, h) => ({ type: 'rect', x, y, w, h });
const setRoi = (t, roi) => t.shell.opts.onRoi(roi, { final: true, source: 'draw' });
const activeRoi = (t) => J(t.shell.activeRoi);
function* walk(el) { yield el; for (const c of el.children || []) yield* walk(c); }
const findByText = (root, text, tag = 'BUTTON') => { for (const n of walk(root)) if (n.tagName === tag && n.textContent === text) return n; return null; };
// The stand-in DOM does not empty an element on `textContent = ''`: the rows of the last render are the last ones.
let CURRENT = null;
const rows = (root) => { const all = arr(walk(root)).filter((n) => /ij-list-row/.test(n.className || '')); const n = CURRENT ? CURRENT.api('io').roiManager.list().length : all.length; return n ? all.slice(-n) : []; };
const click = async (el, ev) => { assert.ok(el, 'an element to click'); for (const fn of el.listeners.click || []) await fn(Object.assign({ shiftKey: false, ctrlKey: false, metaKey: false, target: el }, ev || {})); };
const file = (name, content) => {
  const u8 = typeof content === 'string' ? new TextEncoder().encode(content) : Uint8Array.from(content);
  return { name, size: u8.length, arrayBuffer: async () => u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength), text: async () => new TextDecoder().decode(u8) };
};
const blobBytes = async (b) => new Uint8Array(await b.arrayBuffer());
const byName = (docs, name) => docs.find((d) => d.name === name);

async function fresh(opts) {
  const t = await boot(Object.assign({ channels: 2 }, opts || {}));
  await t.open();
  t.page.DecompressionStream = DecompressionStream;
  return t;
}
async function activate(t, docId) {
  const c = t.shell.opts.commands.find((x) => x.id === 'winImg' + docId);
  assert.ok(c, 'window menu entry of ' + docId);
  await c.run();
  await until(() => t.activeId() === docId, 'image ' + docId + ' on screen');
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// File > Open returns at once (the picker may stay open): wait until the files picked are opened or refused.
async function settle(t) { await sleep(40); let quiet = 0; while (quiet < 5) { quiet = t.shell.opts.getState().busy ? 0 : quiet + 1; await sleep(15); } }
/** Picks `files` for File > Open; → the errors the operator was shown meanwhile (they are taken out of t.errors). */
async function openVia(t, files) { const e0 = t.errors.length; t.pickFile(files); await t.runCommand('fileOpen'); await settle(t); return t.errors.splice(e0); }
const lastSaved = (t) => t.saved[t.saved.length - 1];
const quiet = (t) => { t.errors.length = 0; t.failures.length = 0; };

// ─────────────────────────────────────────────────────────── the menu
await test('the commands: menu paths, orders, enabled rules, labels', async () => {
  const t = await fresh();
  const want = {
    fileImportTextImage: [['File', 'Import'], 20, 'Text Image…'], fileSaveTextImage: [['File', 'SaveAs'], 15, 'Text Image…'],
    fileSaveSelection: [['File', 'SaveAs'], 24, 'Selection…'], fileSaveXY: [['File', 'SaveAs'], 26, 'XY Coordinates…'], toolsSaveXY: [['Analyze', 'Tools'], 10, 'Save XY Coordinates…']
  };
  for (const [id, [menu, order, label]] of Object.entries(want)) {
    const c = t.cmd(id);
    assert.ok(c, id); deq(J(c.menu), menu); assert.equal(c.order, order); assert.equal(EN.cmd[id], label); assert.equal(c.repeatable !== false, true);
  }
  assert.equal(t.isEnabled('fileImportTextImage'), true);
  assert.equal(t.isEnabled('fileSaveTextImage'), true);
  assert.equal(t.isEnabled('toolsSaveXY'), true);
  assert.equal(t.isEnabled('fileSaveSelection'), false, 'ROI_REQUIRED');
  assert.equal(t.isEnabled('fileSaveXY'), false, 'ROI_REQUIRED');
  await setRoi(t, rect(2, 2, 6, 5));
  assert.equal(t.isEnabled('fileSaveSelection'), true);
  assert.equal(t.isEnabled('fileSaveXY'), true);
  t.close();
});

// ─────────────────────────────────────────────────────────── text image
await test('Import Text Image then Save As Text Image: a 32-bit image, the numbers back with 3 decimals, restored after a reload', async () => {
  const t = await fresh();
  t.pickFile([file('grad.txt', 'a\tb\tc\n1.5\t2\t3\n4\t5\t6.25\n')]);           // the header row is dropped
  await t.runCommand('fileImportTextImage');
  const docs = await t.docs();
  const d = byName(docs, 'grad');
  assert.ok(d, 'the image opened under the file name');
  deq([d.width, d.height, d.bitDepth, d.channels.length], [3, 2, 32, 1]);
  deq([d.channels[0].display.min, d.channels[0].display.max], [1.5, 6.25], 'display range = data range');
  deq(arr(await t.pixels(d.docId, 0)), [1.5, 2, 3, 4, 5, 6.25]);
  await activate(t, d.docId);
  await t.runCommand('fileSaveTextImage');
  const s = lastSaved(t);
  // FileSaver.saveAsText proposes <title>.csv and a .csv path is comma separated (FileSaver.java:577, :594-595)
  assert.equal(s.name, 'grad.csv');
  assert.equal(await s.blob.text(), '1.500,2.000,3.000\n4.000,5.000,6.250\n');
  // Analyzer.getPrecision: 5 decimals, then Scientific notation (negative precision)
  await t.runCommand('analyzeSetMeasurements', { decimals: 5 });
  await t.runCommand('fileSaveTextImage');
  assert.equal(await lastSaved(t).blob.text(), '1.50000,2.00000,3.00000\n4.00000,5.00000,6.25000\n');
  await t.runCommand('analyzeSetMeasurements', { scientific: true, decimals: 2 });
  await t.runCommand('fileSaveTextImage');
  assert.equal(await lastSaved(t).blob.text(), '1.50E0,2.00E0,3.00E0\n4.00E0,5.00E0,6.25E0\n');
  await t.runCommand('analyzeSetMeasurements', { scientific: false, decimals: 3 });
  // an 8-bit image writes integers (the harness' own image)
  const src = byName(await t.docs(), 'HARNESS Z 0–4 (Max Intensity)') || (await t.docs()).find((x) => x.bitDepth === 8);
  await activate(t, src.docId);
  await t.runCommand('fileSaveTextImage');
  const txt = await lastSaved(t).blob.text();
  const px = arr(await t.pixels(src.docId, 0));
  const want = []; for (let y = 0; y < src.height; y++) want.push(px.slice(y * src.width, (y + 1) * src.width).join(','));
  assert.equal(txt, want.join('\n') + '\n');
  assert.equal(lastSaved(t).name, src.name.replace(/[\\/:*?"<>|]+/g, '_') + '.csv');
  // reload: the image comes back as it was
  await t.flush();
  const keys = (await t.store.shared.list()).map((x) => x.key);
  const t2 = await t.reload();
  const w2 = await t2.spawn();
  for (const key of keys) await t2.engine('session.restore', { key }, w2);   // every opened file is a session of its own
  const back = byName((await t2.engine('doc.list', {}, w2)).docs, 'grad');
  assert.ok(back, 'restored');
  deq(arr((await t2.engine('doc.tile', { docId: back.docId, channel: 0, level: 0, tx: 0, ty: 0 }, w2)).data), [1.5, 2, 3, 4, 5, 6.25]);
  t2.close();
});

await test('Import Text Image: refusals are reported with their own sentence; a cancelled picker does nothing', async () => {
  const t = await fresh();
  const n0 = (await t.docs()).length;
  t.pickFile(null);
  await t.runCommand('fileImportTextImage');
  assert.equal((await t.docs()).length, n0);
  t.pickFile([file('bad.txt', '1 2 3\n4 5\n')]);
  let errs = await t.runCommand('fileImportTextImage', undefined, { expectError: true });
  assert.equal(errs[0].message, EN.err.ioTextRagged);
  quiet(t);
  t.pickFile([file('empty.txt', '   \n')]);
  errs = await t.runCommand('fileImportTextImage', undefined, { expectError: true });
  assert.equal(errs[0].message, EN.err.ioTextEmpty);
  quiet(t);
  assert.equal((await t.docs()).length, n0, 'nothing was opened');
  t.close();
});

// ─────────────────────────────────────────────────────────── selection files and the XY writers
await test('Save As Selection and XY Coordinates: the .roi file ImageJ reads, the vertices with the calibration', async () => {
  const t = await fresh();
  const info = (await t.docs())[0];
  const cal = info.calibration;
  await setRoi(t, { type: 'polygon', points: [[3, 4], [20, 5], [14.5, 18]], name: 'nucleus' });
  await t.runCommand('fileSaveSelection');
  const f = lastSaved(t);
  assert.equal(f.name, 'nucleus.roi');
  const back = t.page.IJRoiCodec.decodeEntry(await blobBytes(f.blob));
  assert.equal(back.name, 'nucleus');
  deq(J(back.roi.points), [[3, 4], [20, 5], [14.5, 18]]);
  // a selection without a name takes the image name
  await setRoi(t, rect(2, 3, 9, 7));
  await t.runCommand('fileSaveSelection');
  assert.equal(lastSaved(t).name, info.name.replace(/[\\/:*?"<>|]+/g, '_') + '.roi');
  deq(J(t.page.IJRoiCodec.decode(await blobBytes(lastSaved(t).blob))), rect(2, 3, 9, 7));
  // XYWriter: tab-separated, IJ.d2s(v·pixel size, 4) for a calibrated image
  await t.runCommand('fileSaveXY');
  const xy = await lastSaved(t).blob.text();
  const pw = cal.pixelWidth, ph = cal.pixelHeight;
  const d4 = (v) => v.toFixed(4);
  assert.equal(xy, `${d4(2 * pw)}\t${d4(3 * ph)}\n${d4(11 * pw)}\t${d4(3 * ph)}\n${d4(11 * pw)}\t${d4(10 * ph)}\n${d4(2 * pw)}\t${d4(10 * ph)}\n`);
  assert.equal(lastSaved(t).name, info.name.replace(/[\\/:*?"<>|]+/g, '_') + '.txt');
  // no selection: both are disabled and nothing is written
  await setRoi(t, null);
  assert.equal(t.isEnabled('fileSaveSelection'), false);
  assert.equal(t.isEnabled('fileSaveXY'), false);
  t.close();
});

await test('Analyze › Tools › Save XY Coordinates: the dialog proposes the corner pixel, every other pixel is listed; a selection skips the dialog', async () => {
  const t = await fresh();
  const info = (await t.docs())[0];
  const W = info.width, H = info.height;
  const px = arr(await t.pixels(info.docId, 0));
  await setRoi(t, null);
  const nSpecs = t.log.dialogSpecs.length;
  await t.runCommand('toolsSaveXY', { background: String(px[0]), invertY: true });
  const spec = t.log.dialogSpecs[nSpecs];
  deq(arr(spec.fields.map((f) => f.id)), ['note', 'background', 'invertY']);
  assert.equal(spec.fields[1].value, px[0], 'the default background is the pixel in the upper left corner');
  assert.equal(spec.fields[2].value, false);
  let want = '', count = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (px[y * W + x] !== px[0]) { want += `${x}\t${y}\t${px[y * W + x]}\n`; count++; }
  assert.ok(count > 0);
  assert.equal(await lastSaved(t).blob.text(), want);
  assert.equal(lastSaved(t).name, info.name.replace(/[\\/:*?"<>|]+/g, '_') + '.txt');
  // y from the bottom (the default)
  // XYCoordinates keeps invertY in a static field (XYCoordinates.java:20): the next run proposes the last choice
  const nSpecs1 = t.log.dialogSpecs.length;
  await t.runCommand('toolsSaveXY', { background: String(px[0]), invertY: false });
  assert.equal(t.log.dialogSpecs[nSpecs1].fields[2].value, true, 'the last invertY choice comes back');
  let want2 = '';
  for (let i = 0; i < H; i++) { const y = H - 1 - i; for (let x = 0; x < W; x++) if (px[y * W + x] !== px[0]) want2 += `${x}\t${H - 1 - y}\t${px[y * W + x]}\n`; }
  assert.equal(await lastSaved(t).blob.text(), want2);
  // an area selection: no dialog, "X,Y,Value" as .csv
  await setRoi(t, rect(4, 2, 3, 2));
  const nSpecs2 = t.log.dialogSpecs.length;
  await t.runCommand('toolsSaveXY');
  assert.equal(t.log.dialogSpecs.length, nSpecs2, 'the dialog is skipped');
  const csv = await lastSaved(t).blob.text();
  assert.equal(lastSaved(t).name.endsWith('.csv'), true);
  let wantCsv = 'X,Y,Value\n';
  for (let y = 2; y < 4; y++) for (let x = 4; x < 7; x++) wantCsv += `${x},${y},${px[y * W + x]}\n`;
  assert.equal(csv, wantCsv);
  // a line selection is no area: the dialog comes back
  await setRoi(t, { type: 'line', x1: 1, y1: 1, x2: 9, y2: 5 });
  const nSpecs3 = t.log.dialogSpecs.length;
  await t.runCommand('toolsSaveXY', { background: '0', invertY: false });
  assert.equal(t.log.dialogSpecs.length, nSpecs3 + 1);
  // the background trap on a 32-bit image: the dialog text (4 decimals) left alone means the EXACT corner value (GenericDialog.java:1199-1204)
  t.pickFile([file('f.txt', '0.12345678 0.5\n0.5 0.12345678\n')]);
  await t.runCommand('fileImportTextImage');
  await setRoi(t, null);
  await t.runCommand('toolsSaveXY', { background: 0.1235, invertY: true });
  assert.equal(await lastSaved(t).blob.text(), '1\t0\t0.5\n0\t1\t0.5\n', 'every pixel equal to the corner is skipped, 0.1235 is only its text');
  // a NaN corner stays NaN: NaN pixels are the background (XYCoordinates.java:108, :116)
  t.pickFile([file('n.txt', 'NaN 1\n1 NaN\n')]);
  await t.runCommand('fileImportTextImage');
  await setRoi(t, null);
  const ns = t.log.dialogSpecs.length;
  await t.runCommand('toolsSaveXY', { background: 'NaN', invertY: true });
  assert.equal(t.log.dialogSpecs[ns].fields[1].value, 'NaN');
  assert.equal(await lastSaved(t).blob.text(), '1\t0\t1.0\n0\t1\t1.0\n');
  t.close();
});

// ─────────────────────────────────────────────────────────── File › Open
await test('File › Open: TIFF (uncompressed and deflate with predictor), several files at once, the opened file is not unsaved', async () => {
  const t = await fresh();
  const W = 20, H = 12;
  const p0 = new Uint16Array(W * H).map((_, i) => (i * 37) % 4096), p1 = new Uint16Array(W * H).map((_, i) => (i * 11 + 5) % 4096);
  const plain = buildTiff({ width: W, height: H, bitDepth: 16, planes: [p0.slice(), p1.slice()] });
  const packed = buildTiff({ width: W, height: H, bitDepth: 16, planes: [p0.slice(), p1.slice()], compression: 'deflate', predictor: 2, rowsPerStrip: 5, imagejMeta: { labels: ['A', 'B'], ranges: [[0, 4095], [0, 4095]] }, description: 'ImageJ=1.54f\nchannels=2\n' });
  // the strip loops run in the worker: the page's own copy of the compressed-TIFF reader is never called
  t.page.IJLocalTiff.read = () => { throw new Error('the page decoded a compressed TIFF'); };
  assert.equal((await openVia(t, [file('plain.tif', plain), file('packed.tiff', packed)])).length, 0);
  const docs = await t.docs();
  const a = byName(docs, 'plain'), b = byName(docs, 'packed');
  assert.ok(a && b, 'both opened');
  for (const d of [a, b]) {
    deq([d.width, d.height, d.bitDepth, d.channels.length], [W, H, 16, 2]);
    deq(arr(await t.pixels(d.docId, 0)), arr(p0)); deq(arr(await t.pixels(d.docId, 1)), arr(p1));
    assert.equal(d.unsaved, false, 'a file just read from disk is what is on disk');
  }
  deq(b.channels.map((c) => c.name), ['A', 'B'], 'the ImageJ metadata of the compressed file');
  // a corrupt compressed file is reported; the other files of the pick still open
  const bad = packed.slice(); for (let i = 8; i < 40; i++) bad[i] ^= 0x5a;
  const errs = await openVia(t, [file('bad.tif', bad), file('again.tif', plain)]);
  assert.ok(errs.length >= 1);
  quiet(t);
  assert.ok(byName(await t.docs(), 'again'), 'one failing file does not stop the others');
  t.close();
});

await test('File › Open: PNG / JPEG / GIF / BMP — grey becomes one 8-bit channel, colour three coloured channels', async () => {
  const t = await fresh();
  // the browser's decoder is a stand-in here: the bytes of the "image" are a JSON of the pixels it would decode
  t.page.createImageBitmap = async (blob) => { const j = JSON.parse(await blob.text()); return { width: j.w, height: j.h, rgba: j.rgba, fill: j.fill, close() { t.page.__closed = (t.page.__closed || 0) + 1; } }; };
  // the picture is read in horizontal bands: drawImage(bmp, 0, y0, w, bh, 0, 0, w, bh) then getImageData(0, 0, w, bh)
  const bands = [];
  t.page.OffscreenCanvas = class { constructor(w, h) { this.width = w; this.height = h; } getContext() {
    const self = this;
    return {
      clearRect() {},
      drawImage(bmp, sx, sy, sw, sh) { self.bmp = bmp; self.band = { sy, sh, sw }; },
      getImageData(x, y, w, h) {
        const { sy, sh, sw } = self.band; bands.push([sy, sh]);
        if (self.bmp.fill) { const a = new Uint8ClampedArray(sw * sh * 4); for (let i = 0; i < sw * sh; i++) { a.set([...self.bmp.fill, 255], i * 4); } return { data: a }; }
        return { data: Uint8ClampedArray.from(self.bmp.rgba.slice(sy * sw * 4, (sy + sh) * sw * 4)) };
      }
    };
  } };
  const grey = { w: 3, h: 2, rgba: [0, 0, 0, 255, 10, 10, 10, 255, 20, 20, 20, 255, 30, 30, 30, 255, 40, 40, 40, 255, 50, 50, 50, 255] };
  const col = { w: 2, h: 1, rgba: [200, 100, 50, 255, 1, 2, 3, 255] };
  assert.equal((await openVia(t, [file('g.png', JSON.stringify(grey)), file('c.jpg', JSON.stringify(col)), file('x.gif', JSON.stringify(grey)), file('y.bmp', JSON.stringify(col)), file('z.jpeg', JSON.stringify(grey))])).length, 0);
  const docs = await t.docs();
  const g = byName(docs, 'g'), c = byName(docs, 'c');
  deq([g.width, g.height, g.bitDepth, g.channels.length], [3, 2, 8, 1]);
  deq(arr(await t.pixels(g.docId, 0)), [0, 10, 20, 30, 40, 50]);
  deq([c.width, c.height, c.bitDepth, c.channels.length], [2, 1, 8, 3]);
  deq(c.channels.map((x) => x.name), ['R', 'G', 'B'], 'the naming of File › New › System Clipboard');
  deq(c.channels.map((x) => x.color), ['#ff0000', '#00ff00', '#0000ff']);
  deq(c.channels.map((x) => x.display.lut), ['Red', 'Green', 'Blue']);
  deq([arr(await t.pixels(c.docId, 0)), arr(await t.pixels(c.docId, 1)), arr(await t.pixels(c.docId, 2))], [[200, 1], [100, 2], [50, 3]]);
  assert.ok(byName(docs, 'x') && byName(docs, 'y') && byName(docs, 'z'));
  assert.equal(t.page.__closed, 5, 'every bitmap is released');
  // a tall picture is read in bands of at most ~1 Mpx, never in one canvas; one over 268 Mpx is refused with the translated message
  bands.length = 0;
  assert.equal((await openVia(t, [file('tall.png', JSON.stringify({ w: 1024, h: 2500, fill: [7, 7, 7] }))])).length, 0);
  assert.ok(bands.length >= 3 && bands.every(([, sh]) => sh * 1024 <= 1048576), 'bands of at most 1 Mpx: ' + JSON.stringify(bands));
  deq(bands.map(([sy]) => sy), [0, 1024, 2048]);
  const tall = byName(await t.docs(), 'tall');
  deq([tall.width, tall.height, tall.channels.length], [1024, 2500, 1]);
  // 40 Mpx (a large microscopy JPEG) opens; over 268 Mpx is refused with the picture's own message, not the TIFF-save sentence
  assert.equal((await openVia(t, [file('big.png', JSON.stringify({ w: 8000, h: 5000, fill: [1, 1, 1] }))])).length, 0);
  assert.ok(byName(await t.docs(), 'big'), '40 Mpx opens');
  const huge = await openVia(t, [file('huge.png', JSON.stringify({ w: 20000, h: 14000, fill: [1, 1, 1] }))]);
  assert.equal(huge[0].message, EN.err.pictureTooLarge);
  assert.ok(!byName(await t.docs(), 'huge'));
  // the browser cannot decode the file
  t.page.createImageBitmap = async () => { throw new Error('boom'); };
  const errs = await openVia(t, [file('broken.png', 'not an image')]);
  assert.equal(errs[0].message, EN.err.ioDecode);
  quiet(t);
  t.close();
});

await test('File › Open of a .lut on a multichannel image shown in Grayscale: every channel takes the table and the mode becomes Color', async () => {
  const t = await fresh({ channels: 2 });
  const info = (await t.docs())[0];
  await t.api(null).setDisplayMode(info.docId, 'gray');
  const table = new Uint8Array(768); for (let i = 0; i < 256; i++) { table[i] = i; table[256 + i] = 0; table[512 + i] = 255 - i; }
  assert.equal((await openVia(t, [file('mix.lut', table)])).length, 0);
  let d;
  for (let i = 0; i < 100; i++) { d = (await t.docs()).find((x) => x.docId === info.docId); if (d.channels.every((c) => c.display.lut === 'mix')) break; await sleep(10); }
  deq(d.channels.map((c) => c.display.lut), ['mix', 'mix']);
  assert.equal((await t.engine('doc.info', { docId: info.docId })).mode, 'color');
  t.close();
});

await test('File › Open of a .lut behaves like File › Import › LUT: a built-in name is renamed, the table replaces an inverted one, no image opens the 256 × 32 ramp', async () => {
  const t = await fresh();
  const info = (await t.docs())[0];
  const table = new Uint8Array(768); for (let i = 0; i < 256; i++) { table[i] = i; table[256 + i] = 255 - i; table[512 + i] = 0; }
  const raw = () => Uint8Array.from(table);
  await t.runCommand('colorInvertLuts').catch(() => {});
  assert.equal((await openVia(t, [file('Fire.lut', raw())])).length, 0, 'a built-in name is accepted');
  const d1 = (await t.docs()).find((d) => d.docId === info.docId);
  assert.equal(d1.channels[0].display.lut, 'Fire (LUT)', 'renamed, not refused');
  assert.equal(d1.channels[0].display.invert, false, 'an inverted look-up table is replaced, not inverted again');
  const long = 'x'.repeat(70) + '.lut';
  assert.equal((await openVia(t, [file(long, raw())])).length, 0);
  assert.equal((await t.docs()).find((d) => d.docId === info.docId).channels[0].display.lut.length, 56, 'cut to 56 characters');
  // no image open: the ramp image LutLoader.createImage makes
  for (const d of await t.docs()) await t.api(null).closeDoc(d.docId);
  assert.equal((await t.docs()).length, 0);
  assert.equal((await openVia(t, [file('teal.lut', raw())])).length, 0);
  const ramp = (await t.docs())[0];
  assert.ok(ramp && ramp.width === 256 && ramp.height === 32 && ramp.channels[0].display.lut === 'teal');
  const px = await t.pixels(ramp.docId, 0);
  assert.equal(px[0], 0); assert.equal(px[255], 255); assert.equal(px[256 * 31 + 100], 100);
  t.close();
});

await test('File › Open: a text image, a selection (.roi), a RoiSet (.zip) and a LUT', async () => {
  const t = await fresh();
  const info = (await t.docs())[0];
  // text image
  assert.equal((await openVia(t, [file('t.txt', '1\t2\n3\t4\n')])).length, 0);
  const txt = byName(await t.docs(), 't');
  deq([txt.width, txt.height, txt.bitDepth, txt.unsaved], [2, 2, 32, false]);
  await activate(t, info.docId);
  // a .roi file: onto the active image, named after the file when it holds no name
  const C = t.page.IJRoiCodec;
  const roiBytes = C.encode({ type: 'oval', x: 3, y: 4, w: 10, h: 8 });
  assert.equal((await openVia(t, [file('cell 1.roi', roiBytes)])).length, 0);
  await until(() => t.shell.activeRoi && t.shell.activeRoi.type === 'oval', 'the selection');
  deq(activeRoi(t), { type: 'oval', x: 3, y: 4, w: 10, h: 8, name: 'cell 1' });
  // a RoiSet: the ROI Manager opens with its entries and their style
  const set = C.encodeSet([{ roi: rect(1, 1, 5, 5), name: 'a' }, { roi: { type: 'polygon', points: [[2, 2], [9, 3], [5, 9]] }, name: 'b', stroke: '#ff0000', fill: '#00ff0080', width: 2 }]);
  assert.equal((await openVia(t, [file('RoiSet.zip', set)])).length, 0);
  assert.ok(t.shell.windows.floats.get('roiManager'), 'the ROI Manager window');
  const list = t.api('io').roiManager.list();
  deq(list.map((e) => e.name), ['a', 'b']);
  assert.equal(list[1].stroke, '#ff0000'); assert.equal(list[1].fill, '#00ff0080'); assert.equal(list[1].width, 2);
  assert.equal(t.view(info.docId).rois.all.length, 2);
  // a DEFLATED zip, the form ImageJ and Fiji write (needs the page's raw-deflate stream)
  let raw = true;
  try { new DecompressionStream('deflate-raw'); } catch (_) { raw = false; }
  if (raw) {
    const z = (await import('./ij_io_support.mjs')).b64(JSON.parse((await import('node:fs')).readFileSync(new URL('../fixtures/ij-wave3/io/roiset_zip.json', import.meta.url), 'utf8')).zipDeflatedB64);
    assert.equal((await openVia(t, [file('fiji.zip', z)])).length, 0);
    assert.equal(t.api('io').roiManager.list().length, 2 + 7, 'the seven ROIs of the jar\'s deflated RoiSet');
  } else console.log('SKIP deflated RoiSet: this Node has no deflate-raw stream');
  // a LUT: the codec of the Edit package (IJLutFile) reads it; without the codec the file type is refused
  const realLut = t.page.IJLutFile;
  assert.ok(realLut && typeof realLut.parse === 'function', 'the Edit package registers its LUT codec');
  delete t.page.IJLutFile;
  let errs = await openVia(t, [file('my.lut', new Uint8Array(768).fill(7))]);
  assert.equal(errs[0].message, EN.err.ioUnknownFormat, 'no LUT codec');
  quiet(t);
  t.page.IJLutFile = realLut;
  const raw768 = new Uint8Array(768); for (let i = 0; i < 256; i++) { raw768[i] = i; raw768[256 + i] = 255 - i; raw768[512 + i] = 9; }
  assert.equal((await openVia(t, [file('teal.lut', raw768)])).length, 0);
  await until(async () => (await t.docs()).find((d) => d.docId === info.docId).channels[0].display.lut === 'teal', 'the LUT on the active channel', 4000);
  assert.ok(t.page.IJLuts.registered().some((r) => r.name === 'teal'), 'registered with the page and kept for the session');
  // a file that is no LUT: the codec's own sentence
  errs = await openVia(t, [file('junk.lut', new Uint8Array(100))]);
  assert.equal(errs[0].message, EN.err.editLutUnknown);
  quiet(t);
  // unknown types and no image
  errs = await openVia(t, [file('notes.docx', 'x')]);
  assert.equal(errs[0].message, EN.err.ioUnknownFormat);
  quiet(t);
  t.close();
});


await test('File › Open without an image: a selection file makes the blank image RoiReader.openRoi makes; a RoiSet needs an image', async () => {
  const t = await fresh();
  const only = (await t.docs())[0];
  t.script.nextAsk = 'discard';
  assert.equal(await t.api('io').closeDoc(only.docId), true);
  await until(async () => (await t.docs()).length === 0, 'no image left');
  let errs = await openVia(t, [file('a.roi', t.page.IJRoiCodec.encode(rect(1, 1, 3, 3)))]);
  assert.equal(errs.length, 0);
  await until(async () => (await t.docs()).length === 1, 'the blank image');
  const d = (await t.docs())[0];
  deq([d.name, d.width, d.height, d.bitDepth], ['a.roi', 14, 14, 8], 'ByteProcessor(r.x+r.width+10, r.y+r.height+10)');
  await until(() => t.shell.activeRoi && t.shell.activeRoi.type === 'rect', 'the selection on it');
  // an image that is big enough keeps the selection; one that is too small gets a new blank image
  assert.equal((await openVia(t, [file('b.roi', t.page.IJRoiCodec.encode(rect(2, 2, 5, 5)))])).length, 0);
  assert.equal((await t.docs()).length, 1, 'the open image is large enough');
  assert.equal((await openVia(t, [file('c.roi', t.page.IJRoiCodec.encode(rect(10, 10, 20, 20)))])).length, 0);
  await until(async () => (await t.docs()).length === 2, 'a second, larger blank image');
  const set = t.page.IJRoiCodec.encodeSet([{ roi: rect(1, 1, 5, 5), name: 'a' }]);
  t.script.nextAsk = 'discard';
  for (const x of await t.docs()) { t.script.nextAsk = 'discard'; await t.api('io').closeDoc(x.docId); }
  await until(async () => (await t.docs()).length === 0, 'no image left');
  errs = await openVia(t, [file('RoiSet.zip', set)]);
  assert.equal(errs[0].message, EN.err.ioNeedsImage);
  quiet(t);
  t.close();
});

// ─────────────────────────────────────────────────────────── the ROI Manager window
async function managerOf(t) {
  CURRENT = t;
  await t.runCommand('toolsRoiManager');
  const w = t.shell.windows.floats.get('roiManager');
  assert.ok(w, 'ROI Manager window');
  return w.spec.content;
}
const names = (t) => t.api('io').roiManager.list().map((e) => e.name);

await test('ROI Manager: the layout of RoiManager.java, the popup in ImageJ\'s order, Flatten disabled', async () => {
  const t = await fresh();
  const content = await managerOf(t);
  const buttons = arr(walk(content)).filter((n) => n.tagName === 'BUTTON' && !/ij-menu-item/.test(n.className || '')).map((n) => n.textContent);
  deq(buttons, ['Add [t]', 'Update', 'Delete', 'Rename…', 'Measure', 'Deselect', 'Properties…', 'Flatten [F]', 'More »']);
  assert.equal(findByText(content, 'Flatten [F]').disabled, true);
  assert.ok(/ij-btn-more/.test(findByText(content, 'More »').className), 'More » via the class kit');
  const items = arr(walk(content)).filter((n) => /ij-menu-item/.test(n.className || '')).map((n) => n.textContent);
  deq(items, ['Open…', 'Save…', 'Fill', 'Draw', 'AND', 'OR (Combine)', 'XOR', 'Split', 'Multi Measure', 'Multi Plot', 'Sort'], 'RoiManager.addPopupMenu without the excluded items');
  const boxes = arr(walk(content)).filter((n) => n.tagName === 'INPUT' && n.type === 'checkbox');
  assert.equal(boxes.length, 2, 'Show All and Labels');
  deq(arr(walk(content)).filter((n) => n.tagName === 'SPAN').map((n) => n.textContent), ['Show All', 'Labels']);
  t.close();
});

await test('ROI Manager: Add, select, Update, Rename, Deselect, Delete (with and without a selection), Sort', async () => {
  const t = await fresh();
  const info = (await t.docs())[0];
  const content = await managerOf(t);
  const tick = () => new Promise((r) => setTimeout(r, 90));
  // Add [t] with no selection does nothing
  await click(findByText(content, 'Add [t]'));
  assert.equal(names(t).length, 0);
  for (const r of [rect(2, 2, 8, 6), { type: 'oval', x: 12, y: 3, w: 10, h: 10 }, rect(20, 14, 6, 6)]) { await setRoi(t, r); await click(findByText(content, 'Add [t]')); }
  await tick();
  assert.equal(names(t).length, 3);
  assert.equal(rows(content).length, 3);
  // select the second: it becomes the selection of the image
  await click(rows(content)[1]);
  assert.equal(activeRoi(t).type, 'oval');
  deq(arr(t.api('io').roiManager.selected()), [1]);
  // Update: the selection of the image replaces the entry (name and place in the list are kept)
  await setRoi(t, rect(1, 1, 30, 4));
  const n1 = names(t)[1];
  await click(findByText(content, 'Update'));
  deq(J(t.api('io').roiManager.list()[1].roi), Object.assign(rect(1, 1, 30, 4), { name: n1 })); assert.equal(names(t)[1], n1, 'RoiManager.update: the ROI takes the name of the entry');
  // Update with nothing selected in the list: the message of ImageJ
  await click(findByText(content, 'Deselect'));
  deq(arr(t.api('io').roiManager.selected()), []);
  const asks = t.script.asks.length;
  await click(findByText(content, 'Update'));
  assert.equal(t.script.asks[asks].message, EN.roi.errOne);
  // Rename… (a dialog)
  await click(rows(content)[2]);
  t.script.dialogs.push({ name: 'nucleus' });
  await click(findByText(content, 'Rename…'));
  assert.equal(names(t)[2], 'nucleus');
  // Rename with nothing selected
  await click(findByText(content, 'Deselect'));
  const asks2 = t.script.asks.length;
  await click(findByText(content, 'Rename…'));
  assert.equal(t.script.asks[asks2].message, EN.roi.errOne);
  // Sort: String.compareToIgnoreCase, stable
  const rm = t.api('io').roiManager;
  rm.set([{ name: 'b2', roi: rect(0, 0, 2, 2) }, { name: 'B1', roi: rect(0, 0, 3, 3) }, { name: 'a10', roi: rect(0, 0, 4, 4) }, { name: 'A10', roi: rect(0, 0, 5, 5) }, { name: 'a2', roi: rect(0, 0, 6, 6) }]);
  await tick();
  await click(findByText(content, 'Sort'));
  deq(names(t), ['a10', 'A10', 'a2', 'B1', 'b2']);
  deq(rm.list().map((e) => e.roi.w), [4, 5, 6, 3, 2], 'the ROIs travel with their names; equal names (up to case) keep their order');
  // Delete with a selection: only the selected entries
  await click(rows(content)[0]);
  await click(rows(content)[2], { ctrlKey: true });
  deq(arr(rm.selected()), [0, 2]);
  await click(findByText(content, 'Delete'));
  deq(names(t), ['A10', 'B1', 'b2']);
  // Delete with none selected: the question of ImageJ, then everything goes
  const a3 = t.script.asks.length;
  await click(findByText(content, 'Delete'));
  assert.equal(t.script.asks[a3].message, EN.roi.deleteAll);
  assert.equal(names(t).length, 0);
  // Delete on an empty list
  const a4 = t.script.asks.length;
  await click(findByText(content, 'Delete'));
  assert.equal(t.script.asks[a4].message, EN.roi.errEmpty);
  void info;
  t.close();
});

await test('ROI Manager: Shift / Ctrl selection, Show All and Labels, Properties (one entry, a range, all entries)', async () => {
  const t = await fresh();
  const info = (await t.docs())[0];
  const content = await managerOf(t);
  const rm = t.api('io').roiManager;
  rm.add([0, 1, 2, 3].map((i) => ({ name: 'r' + i, roi: rect(2 + i * 5, 2, 4, 4) })));
  await new Promise((r) => setTimeout(r, 90));
  await click(rows(content)[0]);
  await click(rows(content)[2], { shiftKey: true });
  deq(arr(rm.selected()), [0, 1, 2], 'Shift: the range');
  await click(rows(content)[3], { ctrlKey: true });
  deq(arr(rm.selected()), [0, 1, 2, 3]);
  await click(rows(content)[1], { ctrlKey: true });
  deq(arr(rm.selected()), [0, 2, 3], 'Ctrl: toggles');
  // Show All / Labels: the views draw the entries, with or without their names
  const [showAll, labels] = arr(walk(content)).filter((n) => n.tagName === 'INPUT' && n.type === 'checkbox');
  showAll.checked = true; for (const f of showAll.listeners.change || []) f({ target: showAll });
  assert.equal(t.view(info.docId).rois.showAll, true);
  deq(t.view(info.docId).rois.all.map((e) => e.label), ['', '', '', ''], 'Labels is off at start (RoiManager.labelsCheckbox)');
  labels.checked = true; for (const f of labels.listeners.change || []) f({ target: labels });
  deq(t.view(info.docId).rois.all.map((e) => e.label), ['1', '2', '3', '4'], 'ImageCanvas draws ""+(index+1), not the name');
  t.api('edit').settings.set('appearance.useNames', true);
  deq(t.view(info.docId).rois.all.map((e) => e.label), ['r0', 'r1', 'r2', 'r3'], 'Prefs.useNamesAsLabels: the names');
  t.api('edit').settings.set('appearance.useNames', false);
  // Properties… of one entry: name, stroke colour, width, fill colour
  await click(rows(content)[1]);
  let n = t.log.dialogSpecs.length;
  t.script.dialogs.push({ name: 'cell A', stroke: 'red', width: '2', fill: '#80ff0000' });
  await click(findByText(content, 'Properties…'));
  let spec = t.log.dialogSpecs[n];
  assert.equal(spec.title, EN.dlg.io.rpTitle);
  deq(arr(spec.fields.map((f) => f.id)), ['name', 'stroke', 'width', 'fill']);
  assert.equal(spec.fields[0].value, 'r1'); assert.equal(spec.fields[1].value, 'yellow', 'no colour yet: the selection colour of the preferences'); assert.equal(spec.fields[3].value, 'none');
  let e1 = rm.list()[1];
  assert.equal(e1.name, 'cell A'); assert.equal(e1.stroke, '#ff0000'); assert.equal(e1.width, 2); assert.equal(e1.fill, '#ff000080', 'ImageJ "#aarrggbb": the alpha comes first in the text, last in the entry');
  assert.equal(t.view(info.docId).rois.all[1].stroke, '#ff0000');
  assert.equal(t.view(info.docId).rois.all[1].fill, '#ff000080');
  // the dialog shows what is there next time
  await click(rows(content)[1]);
  n = t.log.dialogSpecs.length;
  t.script.dialogs.push(null);
  await click(findByText(content, 'Properties…'));
  spec = t.log.dialogSpecs[n];
  deq([spec.fields[1].value, spec.fields[2].value, spec.fields[3].value], ['red', 2, '#80ff0000']);
  // a bad colour is refused by the dialog's own check (the harness fails a dialog that validates wrong): check validate() directly
  deq(J(spec.validate({ name: 'x', stroke: 'bluish', width: 1, fill: 'none' })), { stroke: 'dlg.io.badColor' });
  assert.equal(spec.validate({ name: 'x', stroke: '#00f', width: 1, fill: 'none' }) !== null, true, '#rgb is not a colour of ImageJ');
  assert.equal(spec.validate({ name: 'x', stroke: 'blue', width: 1, fill: 'none' }), null);
  // several selected: a range, the style applies to each; "all entries" asks first
  await click(rows(content)[0]);
  await click(rows(content)[2], { shiftKey: true });
  n = t.log.dialogSpecs.length;
  t.script.dialogs.push({ stroke: '#00ff00', width: '0', fill: 'none' });
  await click(findByText(content, 'Properties…'));
  spec = t.log.dialogSpecs[n];
  deq(arr(spec.fields.map((f) => f.id)), ['range', 'stroke', 'width', 'fill']);
  assert.ok(/1-3/.test(spec.fields[0].value));
  const l = rm.list();
  deq([l[0].stroke, l[1].stroke, l[2].stroke, l[3].stroke], ['#00ff00', '#00ff00', '#00ff00', undefined]);
  assert.equal(l[1].width, undefined, 'a width of 0 removes the stroke width'); assert.equal(l[1].fill, undefined);
  await click(findByText(content, 'Deselect'));
  const a = t.script.asks.length;
  t.script.dialogs.push({ stroke: 'blue', width: '1', fill: 'none' });
  await click(findByText(content, 'Properties…'));
  assert.equal(t.script.asks[a].message, EN.roi.applyAll.replace('{n}', '4'));
  deq(rm.list().map((e) => e.stroke), ['#0000ff', '#0000ff', '#0000ff', '#0000ff']);
  // the style reaches the stored session
  const meta = () => [...t.log.msgs].reverse().find((m) => m.cmd === 'session.putMeta' && Array.isArray(m.args.rois) && m.args.rois.length === 4 && m.args.rois.every((r) => r.stroke === '#0000ff'));
  await until(meta, 'the list with its style to be persisted', 5000);
  assert.ok(meta().args.rois.every((r) => r.stroke === '#0000ff' && r.width === 1));
  t.close();
});

await test('ROI Manager: AND, OR (Combine), XOR and Split on the selected entries', async () => {
  const t = await fresh();
  const info = (await t.docs())[0];
  const content = await managerOf(t);
  const rm = t.api('io').roiManager;
  const IJRoi = t.page.IJRoi;
  const A = rect(2, 2, 12, 8), B = { type: 'oval', x: 8, y: 4, w: 14, h: 12 }, Cc = rect(25, 18, 6, 6);
  rm.add([{ name: 'A', roi: A }, { name: 'B', roi: B }, { name: 'C', roi: Cc }]);
  await new Promise((r) => setTimeout(r, 90));
  const W = info.width, H = info.height;
  const dense = (roi) => { const m = IJRoi.mask(roi); const f = new Uint8Array(W * H); for (let j = 0; j < m.h; j++) for (let i = 0; i < m.w; i++) if (m.data[j * m.w + i]) f[(m.y + j) * W + m.x + i] = 1; return f; };
  const maskOfSel = () => dense(t.shell.activeRoi);
  const pick = async (idx) => { await click(findByText(content, 'Deselect')); await click(rows(content)[idx[0]]); for (const i of idx.slice(1)) await click(rows(content)[i], { ctrlKey: true }); };
  const run = async (label) => { await click(findByText(content, 'More »')); await click(findByText(content, label)); await until(() => true, 'x'); await new Promise((r) => setTimeout(r, 120)); };
  const a = dense(A), b = dense(B), c = dense(Cc);
  const eq = (got, want, what) => { let bad = 0; for (let i = 0; i < want.length; i++) if (got[i] !== want[i]) bad++; assert.equal(bad, 0, `${what}: ${bad} pixels differ`); };
  await pick([0, 1]); await run('AND');
  eq(maskOfSel(), a.map((v, i) => v & b[i]), 'AND');
  await pick([0, 1]); await run('OR (Combine)');
  eq(maskOfSel(), a.map((v, i) => v | b[i]), 'OR');
  await pick([0, 1]); await run('XOR');
  eq(maskOfSel(), a.map((v, i) => v ^ b[i]), 'XOR');
  // none selected = all entries
  await click(findByText(content, 'Deselect')); await run('OR (Combine)');
  eq(maskOfSel(), a.map((v, i) => v | b[i] | c[i]), 'OR of all');
  // a result that is one rectangle comes back as a rectangle; one outline as a traced polygon
  await pick([0, 2]); await run('AND');
  assert.equal(t.shell.activeRoi, null, 'nothing in common: no selection');
  rm.set([{ name: 'p', roi: rect(2, 2, 10, 10) }, { name: 'q', roi: rect(6, 6, 10, 10) }]);
  await new Promise((r) => setTimeout(r, 90));
  await pick([0, 1]); await run('AND');
  deq(activeRoi(t), rect(6, 6, 6, 6), 'trySimplify: a rectangle');
  await pick([0, 1]); await run('OR (Combine)');
  assert.equal(t.shell.activeRoi.type, 'polygon'); assert.equal(t.shell.activeRoi.traced, true);
  // one entry is not enough
  await pick([0]);
  const asks = t.script.asks.length;
  await run('AND');
  assert.equal(t.script.asks[asks].message, EN.roi.errMoreThanOne);
  // Split: a composite selection gives one entry per outline
  rm.set([{ name: 'p', roi: rect(2, 2, 6, 6) }, { name: 'q', roi: rect(20, 14, 8, 8) }]);
  await new Promise((r) => setTimeout(r, 90));
  await click(findByText(content, 'Deselect')); await run('OR (Combine)');
  assert.equal(t.shell.activeRoi.type, 'mask');
  await run('Split');
  const after = rm.list();
  assert.equal(after.length, 4);
  deq(J(after.slice(2).map((e) => e.roi)), [rect(2, 2, 6, 6), rect(20, 14, 8, 8)]);
  // Split on a plain selection
  await setRoi(t, rect(1, 1, 5, 5));
  const a5 = t.script.asks.length;
  await run('Split');
  assert.equal(t.script.asks[a5].message, EN.roi.errComposite);
  t.close();
});

await test('ROI Manager: Fill, Draw, Measure, Multi Measure, Multi Plot', async () => {
  const t = await fresh();
  const info = (await t.docs())[0];
  const content = await managerOf(t);
  const rm = t.api('io').roiManager;
  const W = info.width;
  rm.add([{ name: 'a', roi: rect(3, 3, 6, 4) }, { name: 'b', roi: { type: 'oval', x: 14, y: 8, w: 10, h: 10 } }]);
  await new Promise((r) => setTimeout(r, 90));
  const run = async (label) => { await click(findByText(content, 'More »')); await click(findByText(content, label)); await new Promise((r) => setTimeout(r, 200)); };
  // Fill: the foreground colour (white = 255 on an 8-bit grey table), every selected entry, the selection of the image is dropped
  await setRoi(t, rect(0, 0, 3, 3));
  await click(rows(content)[0]);
  await run('Fill');
  const px = arr(await t.pixels(info.docId, 0));
  const ch = info.channels[0].display;
  const white = await t.api('io').colorValue(info.docId, 0, 'foreground');
  for (let y = 3; y < 7; y++) for (let x = 3; x < 9; x++) assert.equal(px[y * W + x], white, `filled (${x},${y})`);
  assert.equal(t.shell.activeRoi, null, 'imp.deleteRoi()');
  void ch;
  // Draw: when the Edit package's operation exists the outline is written in the foreground colour, else the missing tool is said
  const hasDraw = !!t.page.IJOpRegistry.get('draw');
  await click(findByText(content, 'Deselect'));
  await click(rows(content)[1]);
  const e0 = t.errors.length;
  const px0 = arr(await t.pixels(info.docId, 0));
  await run('Draw');
  if (hasDraw) {
    assert.equal(t.errors.length, e0, 'drawn');
    // the outline of the oval (14,8 10x10) is written in the foreground colour: pixels changed, every one inside its box and white
    const after = arr(await t.pixels(info.docId, 0));
    let changed = 0;
    for (let i = 0; i < after.length; i++) if (after[i] !== px0[i]) {
      changed++;
      const x = i % W, y = Math.floor(i / W);
      assert.ok(x >= 13 && x <= 24 && y >= 7 && y <= 18, `(${x},${y}) lies inside the oval's box`);
      assert.equal(after[i], white, 'the foreground colour');
    }
    assert.ok(changed >= 20, 'the outline: ' + changed + ' pixels');
    assert.equal(after[13 * W + 14], white, 'the left extreme of the oval outline');
  }
  else { assert.equal(t.errors.length, e0 + 1, 'the Edit package is not loaded: the operation is missing, said in words'); assert.equal(t.errors[e0].message, EN.err.unknownOp); quiet(t); }
  // Measure: a row per entry, then the selection is dropped when several were measured
  await click(findByText(content, 'Deselect'));
  const r0 = (await t.api('io').state().resultsCount) || 0;
  void r0;
  await setRoi(t, rect(5, 5, 4, 4));
  await click(findByText(content, 'Measure'));
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(t.api('io').state().resultsCount, 2, 'Measure with none selected = every entry');
  assert.equal(t.shell.activeRoi, null, 'more than one entry measured: imp.deleteRoi()');
  // Multi Measure keeps working through the popup
  t.script.dialogs.push({ all: true, oneRow: true, append: true });
  await run('Multi Measure');
  assert.ok(t.api('io').state().resultsCount >= 3);
  // Multi Plot: one profile per entry (lines), all in one window
  rm.set([{ name: 'l1', roi: { type: 'line', x1: 2, y1: 3, x2: 30, y2: 3 } }, { name: 'l2', roi: { type: 'line', x1: 2, y1: 9, x2: 30, y2: 12 } }]);
  await new Promise((r) => setTimeout(r, 90));
  const before = arr(t.shell.windows.floats.keys()).length;
  await run('Multi Plot');
  const wins = arr(t.shell.windows.floats.values());
  assert.equal(wins.length, before + 1, 'a plot window');
  const plot = wins[wins.length - 1];
  assert.equal(plot.spec.title, EN.roi.profilesTitle);
  t.close();
});

await test('ROI Manager: Open… and Save… (.roi for one entry, a RoiSet .zip for several)', async () => {
  const t = await fresh();
  const content = await managerOf(t);
  const rm = t.api('io').roiManager;
  const C = t.page.IJRoiCodec;
  rm.add([
    { name: 'one', roi: rect(2, 2, 5, 5), stroke: '#ff0000', width: 3 },
    { name: 'two', roi: { type: 'polygon', points: [[3, 3], [12, 4], [8, 11]] }, fill: '#0000ff80' },
    { name: 'two', roi: { type: 'point', points: [[5, 5], [7.5, 6]] } }
  ]);
  await new Promise((r) => setTimeout(r, 90));
  const run = async (label) => { await click(findByText(content, 'More »')); await click(findByText(content, label)); await new Promise((r) => setTimeout(r, 150)); };
  // one entry selected: a .roi named after it
  await click(rows(content)[0]);
  await run('Save…');
  let f = lastSaved(t);
  assert.equal(f.name, 'one.roi');
  const d1 = C.decodeEntry(await blobBytes(f.blob));
  deq(J(d1.roi), { type: 'rect', x: 2, y: 2, w: 5, h: 5, name: 'one' }); assert.equal(d1.stroke, '#ff0000'); assert.equal(d1.width, 3);
  // none or several selected: a RoiSet of them, unique names
  await click(findByText(content, 'Deselect'));
  await run('Save…');
  f = lastSaved(t);
  assert.equal(f.name, 'RoiSet.zip');
  const back = await C.decodeSet(await blobBytes(f.blob));
  deq(arr(back.map((e) => e.name)), ['one', 'two', 'two']);
  const zipNames = arr((await C.zipRead(await blobBytes(f.blob))).map((e) => e.name));
  deq(zipNames, ['one.roi', 'two.roi', 'two-1.roi'], 'RoiManager.getUniqueName for the duplicate');
  assert.equal(back[1].fill, '#0000ff80'); assert.equal(back[2].roi.type, 'point');
  // Open…: the zip and a single .roi are added to the list
  rm.set([]);
  await new Promise((r) => setTimeout(r, 90));
  t.pickFile([file('RoiSet.zip', await blobBytes(f.blob)), file('solo.roi', C.encode(rect(1, 1, 2, 2)))]);
  await run('Open…');
  // RoiManager.openZip labels an entry with its zip entry name minus .roi: the second "two" was stored as two-1.roi
  deq(names(t), ['one', 'two', 'two-1', 'solo']);
  assert.equal(rm.list()[0].stroke, '#ff0000');
  // an empty list cannot be saved
  rm.set([]);
  await new Promise((r) => setTimeout(r, 90));
  const a = t.script.asks.length;
  await run('Save…');
  assert.equal(t.script.asks[a].message, EN.roi.errListEmpty);
  // a wrong file kind
  t.pickFile([file('a.txt', 'x')]);
  await run('Open…');
  assert.equal(t.errors.at(-1).message, EN.err.ioUnknownFormat);
  quiet(t);
  t.close();
});

console.log(`ok test_ij_io_commands (${passed} groups)`);
