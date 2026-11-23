// File › Open and Save As of stacks / hyperstacks / RGB, end to end through tests/js/ij_harness.mjs (menu command → worker engine → file):
//   a stack TIFF opens as a stack (dimensions, labels, mode, calibration), Save As › Tiff of a stack writes every plane and ImageJ's layout,
//   a TIFF saved and opened again is the same document, File › Save As › Jpeg… writes the plane on screen at quality 85, a PNG save is one
//   picture. (A colour PNG / JPEG opening as a 24-bit RGB image: test_ij_io_commands.mjs.)
// Run: node tests/js/test_ij_stk_io_commands.mjs
import assert from 'node:assert/strict';
import { boot, until } from './ij_harness.mjs';
import { buildTiff } from './ij_io_support.mjs';

let passed = 0;
async function test(name, fn) { try { await fn(); passed++; console.log('  ok  ' + name); } catch (e) { console.error('FAIL ' + name); throw e; } }
const arr = (a) => Array.from(a);
const file = (name, content) => {
  const u8 = typeof content === 'string' ? new TextEncoder().encode(content) : Uint8Array.from(content);
  return { name, size: u8.length, arrayBuffer: async () => u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength), text: async () => new TextDecoder().decode(u8) };
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function settle(t) { await sleep(40); let quiet = 0; while (quiet < 5) { quiet = t.shell.opts.getState().busy ? 0 : quiet + 1; await sleep(15); } }
async function openVia(t, files) { const e0 = t.errors.length; t.pickFile(files); await t.runCommand('fileOpen'); await settle(t); return t.errors.splice(e0); }
const lastSaved = (t) => t.saved[t.saved.length - 1];
const byName = (docs, name) => docs.find((d) => d.name === name);
const at = async (t, id, c, z) => (await t.engine('doc.tile', { docId: id, channel: c, level: 0, tx: 0, ty: 0, pos: { z } })).data.slice();
const blobBytes = async (b) => new Uint8Array(await b.arrayBuffer());

async function fresh() {
  const t = await boot({ channels: 2 });
  await t.open();
  t.page.DecompressionStream = DecompressionStream;
  return t;
}

const W = 8, H = 6;
const plane = (seed) => Uint16Array.from({ length: W * H }, (_, i) => (i * 131 + seed * 977) % 4096);

await test('File › Open: an ImageJ stack TIFF (z), a hyperstack (c, z, t) and the compressed one', async () => {
  const t = await fresh();
  const z = [0, 1, 2, 3].map((i) => plane(i));
  const zBytes = buildTiff({ width: W, height: H, bitDepth: 16, planes: z.map((p) => p.slice()), bigEndian: true, description: 'ImageJ=1.54p\nimages=4\nslices=4\nunit=micron\nspacing=2.5\nloop=false\nmin=0.0\nmax=4095.0\n', resolution: { x: 2, y: 2, unit: 1 } });
  const hs = [0, 1, 2, 3, 4, 5].map((i) => plane(10 + i));
  const hBytes = buildTiff({ width: W, height: H, bitDepth: 16, planes: hs.map((p) => p.slice()), compression: 'deflate', predictor: 2, bigEndian: true,
    description: 'ImageJ=1.54p\nimages=6\nchannels=2\nslices=3\nhyperstack=true\nmode=color\n', imagejMeta: { labels: ['a', 'b', 'c', 'd', 'e', 'f'], ranges: [[0, 4000], [10, 3000]] } });
  t.page.IJLocalTiff.read = () => { throw new Error('the page decoded a compressed TIFF'); };
  assert.equal((await openVia(t, [file('zstack.tif', zBytes), file('hyper.tif', hBytes)])).length, 0);
  const docs = await t.docs();
  const a = byName(docs, 'zstack'), b = byName(docs, 'hyper');
  assert.ok(a && b);
  assert.deepEqual([a.nZ, a.nT, a.channels.length, a.hyperstack, a.nSlices, a.unsaved], [4, 1, 1, false, 4, false]);
  assert.ok(Math.abs(a.calibration.pixelDepth - 2.5) < 1e-12 && a.calibration.unit === 'µm');
  for (let i = 0; i < 4; i++) {
    assert.deepEqual(arr(await at(t, a.docId, 0, i)), arr(z[i]), 'slice ' + (i + 1));
  }
  assert.deepEqual([b.nZ, b.nT, b.channels.length, b.hyperstack], [3, 1, 2, true]);
  assert.deepEqual(arr((await t.engine('doc.labels', { docId: b.docId })).labels), ['a', 'b', 'c', 'd', 'e', 'f']);
  assert.deepEqual([b.channels[0].display.min, b.channels[0].display.max, b.channels[1].display.min, b.channels[1].display.max], [0, 4000, 10, 3000]);
  const bi = await t.engine('doc.info', { docId: b.docId });
  assert.equal(bi.display ? bi.display.mode : bi.mode, 'color');
  t.close();
});

await test('File › Save As › Tiff of a stack writes every plane in ImageJ\'s layout, and opens again as the same stack', async () => {
  const t = await fresh();
  const bytes = buildTiff({ width: W, height: H, bitDepth: 16, planes: [0, 1, 2].map((i) => plane(i)), description: 'ImageJ=1.54p\nimages=3\nslices=3\n' });
  await openVia(t, [file('s.tif', bytes)]);
  const d = byName(await t.docs(), 's');
  await t.runCommand('fileSaveTiff');
  const out = lastSaved(t);
  assert.ok(/\.tif$/.test(out.name));
  const saved = await blobBytes(out.blob);
  assert.equal(String.fromCharCode(saved[0], saved[1]), 'MM', 'ImageJ layout');
  assert.ok(saved.length >= 3 * W * H * 2);
  await openVia(t, [file('again.tif', saved)]);
  const again = byName(await t.docs(), 'again');
  assert.deepEqual([again.nZ, again.nT, again.channels.length], [3, 1, 1]);
  for (let i = 0; i < 3; i++) {
    assert.deepEqual(arr(await at(t, again.docId, 0, i)), arr(plane(i)));
  }
  assert.ok(d);
  t.close();
});

await test('File › Save As › Jpeg…: the plane on screen, quality 85, a .jpg name; PNG of a stack is one picture', async () => {
  const t = await fresh();
  const info = (await t.docs())[0];
  const v = t.view(info.docId);
  const asked = [];
  v.renderToCanvas = async (o) => ({ toBlob(cb, type, q) { asked.push({ type, q, scale: o && o.scale }); cb(new Blob([Uint8Array.from([0xff, 0xd8, 0xff, 0xd9])], { type })); } });
  await t.runCommand('fileSaveJpeg');
  assert.deepEqual(asked.pop(), { type: 'image/jpeg', q: 0.85, scale: 1 });
  assert.ok(/\.jpg$/.test(lastSaved(t).name), lastSaved(t).name);
  assert.equal(lastSaved(t).blob.type, 'image/jpeg');
  await t.runCommand('fileSavePng');
  assert.deepEqual(asked.pop(), { type: 'image/png', q: undefined, scale: 1 });
  assert.ok(/\.png$/.test(lastSaved(t).name));
  // a user setting changes the quality
  t.api('io').settings.set('io.jpegQuality', 60);
  await t.runCommand('fileSaveJpeg');
  assert.equal(asked.pop().q, 0.6);
  t.close();
});

console.log(`ok test_ij_stk_io_commands (${passed} groups)`);
