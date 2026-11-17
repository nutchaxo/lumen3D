// P4 (multi) — Image Calculator, Split / Merge / Arrange Channels and Rename, end to end through
// tests/js/ij_harness.mjs: the real menu command (dialog values) → the real engine in the worker → undo /
// redo → reload() restore → the same pixels; the dialogs' specs; enabled() rules; refusals and their
// error keys; scratch accounting; determinism and cancellation of the newdoc operations.
//
// Run: node tests/js/test_ij_multi_commands.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { boot, until, DIR, EN } from './ij_harness.mjs';
import { ROOT } from './harness.mjs';

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { console.error('FAIL ' + name); throw e; }
}
const arr = (a) => Array.from(a);
const J = (x) => JSON.parse(JSON.stringify(x));

async function fresh(opts) {
  const t = await boot(Object.assign({ channels: 3 }, opts || {}));
  await t.open();
  return t;
}
const byName = (docs, name) => docs.find((d) => d.name === name);
async function chPixels(t, docId, c, w) { return (await t.engine('doc.tile', { docId, channel: c, level: 0, tx: 0, ty: 0 }, w)).data.slice(); }
async function activate(t, docId) {
  const c = t.shell.opts.commands.find((x) => x.id === 'winImg' + docId);
  assert.ok(c, 'window menu entry of ' + docId);
  await c.run();
  await until(() => t.activeId() === docId, 'image ' + docId + ' on screen');
}
async function engineErr(t, cmd, args) {
  try { await t.engine(cmd, args); } catch (e) { return e; }
  assert.fail(cmd + ' was expected to fail');
}
// What a restored session holds: the documents of a reloaded boot, read through a fresh worker.
async function restored(t) {
  const key = (await t.store.shared.list())[0].key;
  const t2 = await t.reload();
  const w2 = await t2.spawn();
  const res = await t2.engine('session.restore', { key }, w2);
  assert.equal(res.warnings.length, 0, JSON.stringify(res.warnings));
  const infos = (await t2.engine('doc.list', {}, w2)).docs;
  return { t2, w2, infos, px: (id, c) => chPixels(t2, id, c, w2) };
}

const C = { C1: 'C1-HARNESS Z 0–4 (Max Intensity)', C2: 'C2-HARNESS Z 0–4 (Max Intensity)', C3: 'C3-HARNESS Z 0–4 (Max Intensity)' };
const SRC = 'HARNESS Z 0–4 (Max Intensity)';

await test('Split Channels: one image per channel, source kept, undo-free, restored after a reload', async () => {
  const t = await fresh();
  const src = (await t.docs())[0];
  const before = [0, 1, 2].map(() => null);
  for (let c = 0; c < 3; c++) before[c] = await t.pixels(src.docId, c);
  assert.ok(t.isEnabled('colorSplitChannels'));
  await t.runCommand('colorSplitChannels');
  const docs = await t.docs();
  assert.equal(docs.length, 4);
  for (let c = 0; c < 3; c++) {
    const d = byName(docs, `C${c + 1}-${SRC}`);
    assert.ok(d, 'C' + (c + 1));
    assert.equal(d.channels.length, 1);
    assert.equal(d.width, src.width); assert.equal(d.height, src.height); assert.equal(d.bitDepth, 8);
    assert.deepEqual(J(d.channels[0]), J(src.channels[c]), 'name, colour and display follow the channel');
    assert.deepEqual(J(d.calibration), J(src.calibration));
    assert.deepEqual(arr(await t.pixels(d.docId, 0)), arr(before[c]), 'pixels of C' + (c + 1));
    assert.equal(d.undoDepth, 0);
  }
  const srcAfter = byName(docs, SRC);
  assert.equal(srcAfter.channels.length, 3, 'the source image is left open');
  for (let c = 0; c < 3; c++) assert.deepEqual(arr(await t.pixels(src.docId, c)), arr(before[c]), 'source untouched');
  // reload: the new images come back with the same pixels
  const r = await restored(t);
  for (let c = 0; c < 3; c++) {
    const d = byName(r.infos, `C${c + 1}-${SRC}`);
    assert.ok(d, 'restored C' + (c + 1));
    assert.deepEqual(arr(await r.px(d.docId, 0)), arr(before[c]));
  }
  r.t2.close();
});

await test('Split Channels refuses a one-channel image (command disabled, engine error and its key)', async () => {
  const t = await fresh();
  await t.runCommand('colorSplitChannels');
  const one = byName(await t.docs(), C.C1);
  await activate(t, one.docId);
  assert.equal(t.isEnabled('colorSplitChannels'), false, 'needs more than one channel');
  const e = await engineErr(t, 'doc.run', { docId: one.docId, op: 'splitChannels', params: {}, roi: null, channel: 0 });
  assert.equal(e.code, 'IJ_MULTI_SINGLE_CHANNEL');
  assert.equal(t.IJApp.errorKey(e), 'err.multiSingleChannel');
  assert.equal((await t.docs()).length, 4, 'no document was created');
  t.close();
});

await test('Merge Channels: C1..C3 pre-filled from the C<n>- titles, sources kept, colours from the sources; Ignore source LUTs gives red / green / blue', async () => {
  const t = await fresh();
  const src = (await t.docs())[0];
  const orig = [];
  for (let c = 0; c < 3; c++) orig.push(arr(await t.pixels(src.docId, c)));
  await t.runCommand('colorSplitChannels');
  const docs = await t.docs();
  assert.equal(t.isEnabled('colorMergeChannels'), true);
  await t.runCommand('colorMergeChannels');
  const spec = t.log.dialogSpecs[t.log.dialogSpecs.length - 1];
  assert.equal(spec.fields.filter((f) => f.type === 'choice').length, 7, 'C1..C7');
  const val = (id) => spec.fields.find((f) => f.id === id).value;
  for (let c = 1; c <= 3; c++) assert.equal(val('c' + c), byName(docs, C['C' + c]).docId, 'C' + c + ' pre-filled');
  for (let c = 4; c <= 7; c++) assert.equal(val('c' + c), 'none', 'C' + c + ' is *None*');
  // the sources are single-channel images only: the original (3 channels) is not offered
  const offered = spec.fields.find((f) => f.id === 'c1').options.filter((o) => o.value !== 'none').map((o) => o.value);
  assert.deepEqual(arr(offered).sort(), [1, 2, 3].map((c) => byName(docs, C['C' + c]).docId).sort());
  const after = await t.docs();
  assert.equal(after.length, 5);
  const merged = after.filter((d) => d.name === SRC && d.docId !== src.docId);
  assert.equal(merged.length, 1, 'the merged image is called as the title without "C1-"');
  const m = merged[0];
  assert.deepEqual(arr(m.channels.map((c) => c.name)), ['DAPI', 'GFP', 'RFP']);
  assert.deepEqual(arr(m.channels.map((c) => c.color)), arr(src.channels.map((c) => c.color)), 'coloured sources keep their colour');
  for (let c = 0; c < 3; c++) assert.deepEqual(arr(await t.pixels(m.docId, c)), orig[c]);
  for (const c of [1, 2, 3]) assert.equal(byName(after, C['C' + c]).channels.length, 1, 'sources stay open');
  // Ignore source LUTs: the default colour of each slot
  await t.runCommand('colorMergeChannels', { ignoreLuts: true });
  const two = (await t.docs()).filter((d) => d.name === SRC && d.docId !== src.docId && d.docId !== m.docId)[0];
  assert.ok(two, 'second merged image');
  assert.deepEqual(arr(two.channels.map((c) => c.color)), ['#ff0000', '#00ff00', '#0000ff']);
  assert.deepEqual(arr(two.channels.map((c) => c.display.lut)), ['Red', 'Green', 'Blue']);
  assert.deepEqual(arr(await t.pixels(two.docId, 1)), orig[1]);
  // reload
  const r = await restored(t);
  const rm = r.infos.find((d) => d.docId === m.docId);
  assert.ok(rm);
  for (let c = 0; c < 3; c++) assert.deepEqual(arr(await r.px(rm.docId, c)), orig[c]);
  r.t2.close();
});

await test('Merge Channels: C1 and C3 picked → red and blue (the colour of the slot, not of the position)', async () => {
  const t = await fresh({ channels: 3 });
  await t.runCommand('colorSplitChannels');
  // take the sources through gray LUTs so the slot colours apply: Ignore source LUTs
  const docs = await t.docs();
  await t.runCommand('colorMergeChannels', { c2: 'none', ignoreLuts: true });
  const merged = (await t.docs()).filter((d) => d.name === SRC && d.channels.length === 2);
  assert.equal(merged.length, 1);
  assert.deepEqual(arr(merged[0].channels.map((c) => c.color)), ['#ff0000', '#0000ff']);
  assert.deepEqual(arr(merged[0].channels.map((c) => c.name)), ['DAPI', 'RFP']);
  assert.equal(byName(docs, C.C2).channels.length, 1);
  t.close();
});

await test('Merge Channels: the dialog refuses fewer than two sources, other sizes and other bit depths', async () => {
  const t = await fresh();
  await t.runCommand('colorSplitChannels');
  const docs = await t.docs();
  const a = byName(docs, C.C1), b = byName(docs, C.C2), c3 = byName(docs, C.C3);
  const n0 = docs.length;
  // fewer than two
  await assert.rejects(t.runCommand('colorMergeChannels', { c1: a.docId, c2: 'none', c3: 'none' }), /dlg\.multi\.needTwo/);
  // another size: crop C2 in place (Image > Crop)
  await activate(t, b.docId);
  t.shell.opts.onRoi({ type: 'rect', x: 0, y: 0, w: 10, h: 8 }, { final: true });
  await t.runCommand('imageCrop');
  const cropped = (await t.docs()).find((d) => d.docId === b.docId);
  assert.equal(cropped.width, 10);
  await assert.rejects(t.runCommand('colorMergeChannels', { c1: a.docId, c2: b.docId, c3: 'none' }), /"c2":"dlg\.multi\.sizeMismatch"/);
  // another bit depth: C3 to 16 bits
  await activate(t, c3.docId);
  await t.runCommand('typeBit16');
  await assert.rejects(t.runCommand('colorMergeChannels', { c1: a.docId, c2: 'none', c3: c3.docId }), /"c3":"dlg\.multi\.depthMismatch"/);
  assert.equal((await t.docs()).length, n0, 'nothing was merged');
  for (const k of ['needTwo', 'sizeMismatch', 'depthMismatch']) assert.equal(typeof EN.dlg.multi[k], 'string');
  t.close();
});

await test('Merge Channels: engine refusals carry their codes and create nothing', async () => {
  const t = await fresh();
  await t.runCommand('colorSplitChannels');
  const docs = await t.docs();
  const src = byName(docs, SRC), a = byName(docs, C.C1), b = byName(docs, C.C2), c3 = byName(docs, C.C3);
  const n0 = docs.length;
  const run = (docId, ids, slots, extra) => engineErr(t, 'doc.run', { docId, docIds: ids, op: 'mergeChannels', params: Object.assign({ sources: ids.map((id, i) => ({ docId: id, slot: slots[i] })) }, extra || {}), roi: null, channel: 0 });
  // a source with several channels
  let e = await run(a.docId, [a.docId, src.docId], [0, 1]);
  assert.equal(e.code, 'IJ_MULTI_NOT_SINGLE'); assert.equal(t.IJApp.errorKey(e), 'err.multiNotSingle');
  // one source only
  e = await engineErr(t, 'doc.run', { docId: a.docId, docIds: [a.docId], op: 'mergeChannels', params: { sources: [{ docId: a.docId, slot: 0 }] }, roi: null, channel: 0 });
  assert.equal(e.code, 'IJ_MULTI_NEED_TWO'); assert.equal(t.IJApp.errorKey(e), 'err.multiNeedTwo');
  // another size
  const small = (await t.engine('doc.run', { docId: b.docId, op: 'cropToNew', params: {}, roi: { type: 'rect', x: 0, y: 0, w: 10, h: 8 }, channel: 0 })).newDocIds[0];
  e = await run(a.docId, [a.docId, small], [0, 1]);
  assert.equal(e.code, 'IJ_SIZE_MISMATCH'); assert.equal(t.IJApp.errorKey(e), 'err.sizeMismatch');
  // another bit depth
  await t.engine('doc.run', { docId: c3.docId, op: 'convert', params: { bitDepth: 16, scale: false }, roi: null, channel: 'all' });
  e = await run(a.docId, [a.docId, c3.docId], [0, 1]);
  assert.equal(e.code, 'IJ_MULTI_DEPTH_MISMATCH'); assert.equal(t.IJApp.errorKey(e), 'err.multiDepthMismatch');
  // malformed sources / a document that does not exist
  e = await engineErr(t, 'doc.run', { docId: a.docId, docIds: [a.docId, b.docId], op: 'mergeChannels', params: { sources: [{ docId: a.docId, slot: 0 }, { docId: b.docId, slot: 0 }] }, roi: null, channel: 0 });
  assert.equal(e.code, 'IJ_BAD_ARGS', 'a slot twice');
  e = await engineErr(t, 'doc.run', { docId: a.docId, docIds: [a.docId, 'nope'], op: 'mergeChannels', params: { sources: [{ docId: a.docId, slot: 0 }, { docId: 'nope', slot: 1 }] }, roi: null, channel: 0 });
  assert.ok(e.code === 'IJ_NO_DOC' || e.code === 'IJ_BAD_ARGS', 'unknown document: ' + e.code);
  assert.equal((await t.docs()).length, n0 + 1, 'only the crop exists: nothing was merged');
  for (const k of ['multiNotSingle', 'multiNeedTwo', 'multiDepthMismatch', 'multiSingleChannel', 'multiTooMany']) assert.equal(typeof EN.err[k], 'string');
  t.close();
});

await test('Image Calculator: two images, every operation reaches the engine; Image1 and Image2 are untouched; the result is a new image that survives a reload', async () => {
  const t = await fresh();
  await t.runCommand('colorSplitChannels');
  const docs = await t.docs();
  const a = byName(docs, C.C1), b = byName(docs, C.C2);
  const pa = arr(await t.pixels(a.docId, 0)), pb = arr(await t.pixels(b.docId, 0));
  const expect = {
    add: (x, y) => Math.min(255, x + y), subtract: (x, y) => Math.max(0, x - y), multiply: (x, y) => Math.min(255, x * y),
    divide: (x, y) => (y === 0 ? 255 : Math.floor(x / y)), and: (x, y) => x & y, or: (x, y) => x | y, xor: (x, y) => x ^ y,
    min: (x, y) => Math.min(x, y), max: (x, y) => Math.max(x, y), average: (x, y) => (x + y) >> 1, difference: (x, y) => Math.abs(x - y),
    copy: (x, y) => y, 'transparent-zero': (x, y) => (y === 0 ? x : y)
  };
  const made = [];
  for (const op of Object.keys(expect)) {
    const before = (await t.docs()).length;
    await t.runCommand('procImageCalculator', { image1: a.docId, op, image2: b.docId });
    const now = await t.docs();
    assert.equal(now.length, before + 1, op + ': one new image');
    const r = now[now.length - 1];
    assert.equal(r.name, 'Result of ' + C.C1);
    assert.equal(r.channels.length, 1); assert.equal(r.bitDepth, 8);
    assert.deepEqual(arr(await t.pixels(r.docId, 0)), pa.map((x, i) => expect[op](x, pb[i])), op);
    assert.deepEqual(J(r.calibration), J(a.calibration));
    assert.equal(r.channels[0].name, a.channels[0].name);
    made.push([op, r.docId]);
  }
  assert.deepEqual(arr(await t.pixels(a.docId, 0)), pa, 'Image1 untouched');
  assert.deepEqual(arr(await t.pixels(b.docId, 0)), pb, 'Image2 untouched');
  // Image1 = Image2 is allowed (ImageJ): x - x = 0
  await t.runCommand('procImageCalculator', { image1: a.docId, op: 'subtract', image2: a.docId });
  const same = (await t.docs()).pop();
  assert.ok(arr(await t.pixels(same.docId, 0)).every((v) => v === 0));
  const r = await restored(t);
  for (const [op, id] of made) assert.deepEqual(arr(await r.px(id, 0)), pa.map((x, i) => expect[op](x, pb[i])), 'restored ' + op);
  r.t2.close();
});

await test('Image Calculator: all channels when the counts match (default), one channel each otherwise, 32-bit result', async () => {
  const t = await fresh();
  const src = (await t.docs())[0];
  await t.runCommand('colorSplitChannels');
  await t.runCommand('colorMergeChannels');
  const all = await t.docs();
  const copy = all.find((d) => d.name === SRC && d.docId !== src.docId);
  const orig = []; for (let c = 0; c < 3; c++) orig.push(arr(await t.pixels(src.docId, c)));
  // 3 channels with 3 channels: every channel against its own
  await t.runCommand('procImageCalculator', { image1: src.docId, op: 'add', image2: copy.docId });
  let spec = t.log.dialogSpecs[t.log.dialogSpecs.length - 1];
  assert.deepEqual(arr(spec.fields.map((f) => f.id)), ['image1', 'op', 'image2', 'allChannels', 'channel1', 'channel2', 'float32', 'sizeNote', 'newWindowNote']);
  let r = (await t.docs()).pop();
  assert.equal(r.channels.length, 3);
  assert.deepEqual(arr(r.channels.map((c) => c.name)), ['DAPI', 'GFP', 'RFP']);
  for (let c = 0; c < 3; c++) assert.deepEqual(arr(await t.pixels(r.docId, c)), orig[c].map((x) => Math.min(255, 2 * x)));
  // 32-bit result: no clamp
  await t.runCommand('procImageCalculator', { image1: src.docId, op: 'add', image2: copy.docId, float32: true });
  r = (await t.docs()).pop();
  assert.equal(r.bitDepth, 32);
  for (let c = 0; c < 3; c++) assert.deepEqual(arr(await t.pixels(r.docId, c)), orig[c].map((x) => 2 * x));
  assert.ok(r.channels[0].display.max > 255 || orig[0].every((x) => x * 2 <= 255), 'display range follows the data');
  // all channels off: one channel of each (channel 2 of the original against channel 0 of C1)
  const c1 = byName(all, C.C1);
  await t.runCommand('procImageCalculator', { image1: src.docId, op: 'subtract', image2: c1.docId, allChannels: false, channel1: 2 });
  r = (await t.docs()).pop();
  assert.equal(r.channels.length, 1);
  assert.equal(r.channels[0].name, 'RFP');
  assert.deepEqual(arr(await t.pixels(r.docId, 0)), orig[2].map((x, i) => Math.max(0, x - orig[0][i])));
  // three channels against one: no all-channels switch is offered, the channel of Image1 is asked
  await t.runCommand('procImageCalculator', { image1: src.docId, op: 'max', image2: c1.docId, channel1: 1 });
  spec = t.log.dialogSpecs[t.log.dialogSpecs.length - 1];
  r = (await t.docs()).pop();
  assert.equal(r.channels.length, 1);
  assert.equal(r.channels[0].name, 'GFP');
  assert.deepEqual(arr(await t.pixels(r.docId, 0)), orig[1].map((x, i) => Math.max(x, orig[0][i])));
  t.close();
});

await test('Image Calculator: 8 bits with a 16-bit Image2 (scaled by its display range), 16-bit Image1 with 8-bit Image2, different sizes', async () => {
  const t = await fresh();
  await t.runCommand('colorSplitChannels');
  const docs = await t.docs();
  const a = byName(docs, C.C1), b = byName(docs, C.C2);
  const pa = arr(await t.pixels(a.docId, 0));
  // C2 → 16 bits through Image > Type
  await activate(t, b.docId);
  await t.runCommand('typeBit16');
  const b16 = (await t.docs()).find((d) => d.docId === b.docId);
  assert.equal(b16.bitDepth, 16);
  const pb = arr(await t.pixels(b.docId, 0));
  const mn = Math.trunc(b16.channels[0].display.min), mx = Math.trunc(b16.channels[0].display.max);
  const scale = 256 / (mx - mn + 1);
  const conv = pb.map((v) => Math.min(255, Math.trunc(Math.max(0, v - mn) * scale + 0.5)));
  await t.runCommand('procImageCalculator', { image1: a.docId, op: 'add', image2: b.docId });
  let r = (await t.docs()).pop();
  assert.equal(r.bitDepth, 8);
  assert.deepEqual(arr(await t.pixels(r.docId, 0)), pa.map((x, i) => Math.min(255, x + conv[i])), 'ShortProcessor → ByteProcessor.convertToByte(true)');
  // 16-bit Image1 with the 8-bit Image2: plain values, the result is 16-bit
  await t.runCommand('procImageCalculator', { image1: b.docId, op: 'add', image2: a.docId });
  r = (await t.docs()).pop();
  assert.equal(r.bitDepth, 16);
  assert.deepEqual(arr(await t.pixels(r.docId, 0)), pb.map((x, i) => x + pa[i]));
  assert.equal(r.channels[0].display.max, Math.max(...pb.map((x, i) => x + pa[i])), 'a 16-bit result shows its data range (resetMinAndMax)');
  // other size: crop C1 in place to 10 x 8; the result is the common top-left rectangle, whatever the order
  await activate(t, a.docId);
  t.shell.opts.onRoi({ type: 'rect', x: 5, y: 3, w: 10, h: 8 }, { final: true });
  await t.runCommand('imageCrop');
  const pc = arr(await t.pixels(a.docId, 0));
  const pbfull = arr(await t.pixels(docs.find((d) => d.name === C.C3).docId, 0));
  const c3 = docs.find((d) => d.name === C.C3);
  await t.runCommand('procImageCalculator', { image1: c3.docId, op: 'subtract', image2: a.docId });
  let spec = t.log.dialogSpecs[t.log.dialogSpecs.length - 1];
  assert.equal(spec.fields.find((f) => f.id === 'sizeNote').visibleIf({ image1: c3.docId, image2: a.docId }), true, 'the size note is shown for two sizes');
  assert.equal(spec.fields.find((f) => f.id === 'sizeNote').visibleIf({ image1: c3.docId, image2: c3.docId }), false);
  r = (await t.docs()).pop();
  assert.equal(r.width, 10); assert.equal(r.height, 8);
  const px = arr(await t.pixels(r.docId, 0));
  for (let y = 0; y < 8; y++) for (let x = 0; x < 10; x++) assert.equal(px[y * 10 + x], Math.max(0, pbfull[y * 40 + x] - pc[y * 10 + x]));
  await t.runCommand('procImageCalculator', { image1: a.docId, op: 'add', image2: c3.docId });
  r = (await t.docs()).pop();
  assert.equal(r.width, 10); assert.equal(r.height, 8);
  const py = arr(await t.pixels(r.docId, 0));
  for (let y = 0; y < 8; y++) for (let x = 0; x < 10; x++) assert.equal(py[y * 10 + x], Math.min(255, pc[y * 10 + x] + pbfull[y * 40 + x]));
  t.close();
});

await test('Image Calculator: refusals (unknown operation, channel out of range, mismatched channel counts, a missing document) and no new image', async () => {
  const t = await fresh();
  await t.runCommand('colorSplitChannels');
  const docs = await t.docs();
  const src = byName(docs, SRC), a = byName(docs, C.C1);
  const n0 = docs.length;
  const run = (docId, ids, params) => engineErr(t, 'doc.run', { docId, docIds: ids, op: 'imageCalculator', params, roi: null, channel: 0 });
  assert.equal((await run(a.docId, [a.docId], { op: 'power', all: false, channel1: 0, channel2: 0 })).code, 'IJ_BAD_ARGS');
  assert.equal((await run(a.docId, [a.docId], { op: 'add', all: false, channel1: 1, channel2: 0 })).code, 'IJ_BAD_ARGS', 'channel1 out of range');
  assert.equal((await run(a.docId, [a.docId, src.docId], { op: 'add', all: false, channel1: 0, channel2: 3 })).code, 'IJ_BAD_ARGS', 'channel2 out of range');
  assert.equal((await run(a.docId, [a.docId, src.docId], { op: 'add', all: true })).code, 'IJ_BAD_ARGS', '1 channel against 3, all channels');
  assert.equal((await run(a.docId, [a.docId], { op: 'add', all: false, channel1: 0 })).code, 'IJ_BAD_ARGS', 'no channel2');
  assert.equal((await run(a.docId, [a.docId], { op: 'add', float32: 'yes', all: false, channel1: 0, channel2: 0 })).code, 'IJ_BAD_ARGS');
  const missing = await run(a.docId, [a.docId, 'gone'], { op: 'add', all: false, channel1: 0, channel2: 0 });
  assert.ok(missing.code === 'IJ_NO_DOC' || missing.code === 'IJ_BAD_ARGS', 'missing doc: ' + missing.code);
  assert.equal(t.IJApp.errorKey({ code: 'IJ_BAD_ARGS' }), 'err.badArgs');
  assert.equal((await t.docs()).length, n0);
  t.close();
});

await test('Image Calculator: the dialog — fields, defaults, the size note, the visible channel fields', async () => {
  const t = await fresh();
  await t.runCommand('colorSplitChannels');
  const docs = await t.docs();
  const a = byName(docs, C.C1), src = byName(docs, SRC);
  await t.runCommand('procImageCalculator', { image1: a.docId, image2: src.docId, channel2: 1 });
  const spec = t.log.dialogSpecs[t.log.dialogSpecs.length - 1];
  const f = (id) => spec.fields.find((x) => x.id === id);
  assert.equal(f('op').value, 'add');
  assert.deepEqual(arr(f('op').options.map((o) => o.value)), ['add', 'subtract', 'multiply', 'divide', 'and', 'or', 'xor', 'min', 'max', 'average', 'difference', 'copy', 'transparent-zero']);
  assert.equal(f('float32').value, false);
  assert.equal(f('image1').type, 'doc'); assert.equal(f('image2').type, 'doc');
  assert.equal(f('channel1').docField, 'image1'); assert.equal(f('channel2').docField, 'image2');
  assert.equal(f('image1').options.length, 4);
  // visibility: 1 channel vs 3 channels → only the channel of Image2
  assert.equal(f('allChannels').visibleIf({ image1: a.docId, image2: src.docId }), false);
  assert.equal(f('channel1').visibleIf({ image1: a.docId, image2: src.docId }), false);
  assert.equal(f('channel2').visibleIf({ image1: a.docId, image2: src.docId }), true);
  assert.equal(f('allChannels').visibleIf({ image1: src.docId, image2: src.docId }), true);
  assert.equal(f('channel1').visibleIf({ image1: src.docId, image2: src.docId, allChannels: true }), false);
  assert.equal(f('channel1').visibleIf({ image1: src.docId, image2: src.docId, allChannels: false }), true);
  assert.equal(f('sizeNote').visibleIf({ image1: a.docId, image2: src.docId }), false);
  // the result of channel2 = 1 against a single-channel image1: GFP of the original
  const r = (await t.docs()).pop();
  assert.equal(r.channels.length, 1);
  t.close();
});

await test('Arrange Channels: reorder, undo, redo, a restore after a snapshot and after the journal alone; dropping channels', async () => {
  const t = await fresh();
  const src = (await t.docs())[0];
  const orig = []; for (let c = 0; c < 3; c++) orig.push(arr(await t.pixels(src.docId, c)));
  assert.ok(t.isEnabled('colorArrangeChannels'));
  await t.runCommand('colorArrangeChannels', { order: '312' });
  let info = (await t.docs())[0];
  assert.deepEqual(arr(info.channels.map((c) => c.name)), ['RFP', 'DAPI', 'GFP']);
  assert.deepEqual(arr(info.channels.map((c) => c.color)), ['#ff4444', '#4488ff', '#44ff44'], 'colour and display follow the array');
  assert.deepEqual(arr(info.channels.map((c) => c.display.lut)), ['#ff4444', '#4488ff', '#44ff44']);
  assert.deepEqual([0, 1, 2].map(() => null).length, 3);
  assert.deepEqual(arr(await t.pixels(src.docId, 0)), orig[2]);
  assert.deepEqual(arr(await t.pixels(src.docId, 1)), orig[0]);
  assert.deepEqual(arr(await t.pixels(src.docId, 2)), orig[1]);
  assert.equal(info.undoDepth, 1);
  // undo → redo
  await t.engine('doc.undo', { docId: src.docId });
  info = await t.engine('doc.info', { docId: src.docId });
  assert.deepEqual(arr(info.channels.map((c) => c.name)), ['DAPI', 'GFP', 'RFP']);
  for (let c = 0; c < 3; c++) assert.deepEqual(arr(await t.pixels(src.docId, c)), orig[c], 'undo restores every channel');
  await t.engine('doc.redo', { docId: src.docId });
  info = await t.engine('doc.info', { docId: src.docId });
  assert.deepEqual(arr(info.channels.map((c) => c.name)), ['RFP', 'DAPI', 'GFP']);
  // reload: after a flush (snapshot)
  let r = await restored(t);
  let ri = r.infos.find((d) => d.docId === src.docId);
  assert.deepEqual(arr(ri.channels.map((c) => c.name)), ['RFP', 'DAPI', 'GFP']);
  assert.deepEqual(arr(await r.px(src.docId, 0)), orig[2]);
  assert.deepEqual(arr(await r.px(src.docId, 1)), orig[0]);
  assert.deepEqual(arr(await r.px(src.docId, 2)), orig[1]);
  // reload without a flush: the journal entry is replayed on the baseline
  const key = (await r.t2.store.shared.list())[0].key;
  const t3 = await r.t2.reload({ flush: false });
  const w3 = await t3.spawn();
  const res = await t3.engine('session.restore', { key }, w3);
  assert.equal(res.warnings.length, 0, JSON.stringify(res.warnings));
  const i3 = await t3.engine('doc.info', { docId: src.docId }, w3);
  assert.deepEqual(arr(i3.channels.map((c) => c.name)), ['RFP', 'DAPI', 'GFP']);
  assert.deepEqual(arr(await chPixels(t3, src.docId, 0, w3)), orig[2]);
  t3.close();
  // dropping: "31" keeps RFP and DAPI
  const t4 = await fresh();
  await t4.runCommand('colorArrangeChannels', { order: '31' });
  const d4 = (await t4.docs())[0];
  assert.deepEqual(arr(d4.channels.map((c) => c.name)), ['RFP', 'DAPI']);
  assert.equal(t4.log.dialogSpecs[t4.log.dialogSpecs.length - 1].fields[1].visibleIf({ order: '31' }), true, 'the reduction is announced');
  assert.equal(t4.log.dialogSpecs[t4.log.dialogSpecs.length - 1].fields[1].visibleIf({ order: '123' }), false);
  await t4.engine('doc.undo', { docId: d4.docId });
  assert.equal((await t4.engine('doc.info', { docId: d4.docId })).channels.length, 3, 'undo brings the dropped channel back');
  await t4.engine('doc.redo', { docId: d4.docId });
  assert.equal((await t4.engine('doc.info', { docId: d4.docId })).channels.length, 2);
  t4.close();
  r.t2.close();
});

await test('Arrange Channels: the dialog refuses a repeated or unknown channel; the identity order changes nothing; the engine refuses the same', async () => {
  const t = await fresh();
  const src = (await t.docs())[0];
  for (const bad of ['', '112', '124', '1234', 'a12', '0']) {
    await assert.rejects(t.runCommand('colorArrangeChannels', { order: bad }), /validate\(\)/, 'order ' + JSON.stringify(bad));
  }
  await t.runCommand('colorArrangeChannels', { order: '123' });
  assert.equal((await t.docs())[0].undoDepth, 0, 'the identity order is not a step');
  for (const order of [[0, 0], [3], [-1, 0], [], [0.5], 'abc']) {
    const e = await engineErr(t, 'doc.run', { docId: src.docId, op: 'arrangeChannels', params: { order }, roi: null, channel: 0 });
    assert.equal(e.code, 'IJ_BAD_ARGS', JSON.stringify(order));
  }
  assert.equal((await t.docs())[0].undoDepth, 0);
  // a one-channel image: disabled; engine error
  await t.runCommand('colorSplitChannels');
  const one = byName(await t.docs(), C.C1);
  await activate(t, one.docId);
  assert.equal(t.isEnabled('colorArrangeChannels'), false);
  const e = await engineErr(t, 'doc.run', { docId: one.docId, op: 'arrangeChannels', params: { order: [0] }, roi: null, channel: 0 });
  assert.equal(e.code, 'IJ_MULTI_SINGLE_CHANNEL');
  t.close();
});

await test('Rename: the title changes, no undo step, kept after a reload; an empty title is refused', async () => {
  const t = await fresh();
  const src = (await t.docs())[0];
  assert.ok(t.isEnabled('imageRename'));
  await t.runCommand('imageRename', { name: '  Embryo E85 #2 ' });
  let info = (await t.docs())[0];
  assert.equal(info.name, 'Embryo E85 #2', 'trimmed');
  assert.equal(info.undoDepth, 0, 'Rename is not an undo step');
  const spec = t.log.dialogSpecs[t.log.dialogSpecs.length - 1];
  assert.equal(spec.fields[0].value, SRC, 'the dialog starts from the current title');
  await assert.rejects(t.runCommand('imageRename', { name: '   ' }), /validate\(\)/);
  assert.equal((await t.docs())[0].name, 'Embryo E85 #2');
  // a pixel step then undo: the name stays
  await t.runCommand('editInvert');
  await t.engine('doc.undo', { docId: src.docId });
  assert.equal((await t.engine('doc.info', { docId: src.docId })).name, 'Embryo E85 #2');
  const r = await restored(t);
  assert.equal(r.infos.find((d) => d.docId === src.docId).name, 'Embryo E85 #2');
  r.t2.close();
});

await test('enabled(): Split / Arrange need several channels, Merge two single-channel images, nothing runs while busy', async () => {
  const t = await fresh();
  const mk = (o) => Object.assign({ doc: null, docs: [], roi: null, prevRoi: null, busy: false, nDocs: 0, canUndo: false, canRedo: false, dirty: false, hasResults: false, canProject: true, threshold: null, activeChannel: 0 }, o);
  const info = (n, bd) => ({ docId: 'x' + n + bd, name: 'n', width: 4, height: 4, bitDepth: bd || 8, channels: Array.from({ length: n }, (_, i) => ({ name: 'c' + i })) });
  const en = (id, st) => t.cmd(id).enabled(st);
  const ids = ['procImageCalculator', 'colorSplitChannels', 'colorMergeChannels', 'colorArrangeChannels', 'imageRename'];
  for (const id of ids) assert.equal(en(id, mk({})), false, id + ' needs an image');
  const three = info(3), one = info(1), ten = info(10);
  assert.equal(en('procImageCalculator', mk({ doc: one, docs: [one], nDocs: 1 })), true);
  assert.equal(en('imageRename', mk({ doc: one, docs: [one], nDocs: 1 })), true);
  assert.equal(en('colorSplitChannels', mk({ doc: one, docs: [one] })), false);
  assert.equal(en('colorSplitChannels', mk({ doc: three, docs: [three] })), true);
  assert.equal(en('colorArrangeChannels', mk({ doc: one, docs: [one] })), false);
  assert.equal(en('colorArrangeChannels', mk({ doc: three, docs: [three] })), true);
  assert.equal(en('colorArrangeChannels', mk({ doc: ten, docs: [ten] })), false, 'ChannelArranger: no more than 9 channels');
  assert.equal(en('colorMergeChannels', mk({ doc: one, docs: [one], nDocs: 1 })), true, 'one single-channel image can fill two slots (RGBStackMerge.isDuplicate)');
  assert.equal(en('colorMergeChannels', mk({ doc: three, docs: [three], nDocs: 1 })), false, 'no single-channel image');
  assert.equal(en('colorMergeChannels', mk({ doc: three, docs: [three, three], nDocs: 2 })), false, 'sources must have a single channel');
  assert.equal(en('colorMergeChannels', mk({ doc: one, docs: [one, info(1)], nDocs: 2 })), true);
  for (const id of ids) assert.equal(en(id, mk({ doc: three, docs: [three, info(1), info(1)], nDocs: 3, busy: true })), false, id + ' is disabled while busy');
  t.close();
});

await test('Menu positions and ids of the package (PLAN-wave2 §1)', async () => {
  const t = await fresh();
  const spec = { procImageCalculator: [['Process'], 100], colorSplitChannels: [['Image', 'Color'], 10], colorMergeChannels: [['Image', 'Color'], 20], colorArrangeChannels: [['Image', 'Color'], 30], imageRename: [['Image'], 50] };
  for (const [id, [menu, order]] of Object.entries(spec)) {
    const c = t.cmd(id);
    assert.ok(c, id);
    assert.deepEqual(arr(c.menu), menu, id + ' menu');
    assert.equal(c.order, order, id + ' order');
    assert.equal(c.pkg, 'multi');
    assert.ok(!c.shortcut || c.shortcut.length === 0, id + ' has no shortcut');
  }
  assert.equal(t.cmd('procImageCalculator').separatorBefore, true);
  t.close();
});

await test('Scratch accounting: a result over the memory budget is refused before it is computed, nothing is created', async () => {
  // one 40x30 image of 3 channels (3.6 KB). The 32-bit result of 3 channels needs 14.4 KB.
  const t = await fresh({ budgetBytes: 24000 });
  const src = (await t.docs())[0];
  const est = await t.engine('doc.estimate', { docId: src.docId, docIds: [src.docId], op: 'imageCalculator', params: { op: 'add', float32: true, all: true }, roi: null, channel: 0 });
  assert.ok(est.needBytes >= 3 * 40 * 30 * 4, 'declared: ' + est.needBytes);
  const small = await t.engine('doc.estimate', { docId: src.docId, docIds: [src.docId], op: 'imageCalculator', params: { op: 'add', float32: false, all: false, channel1: 0, channel2: 0 }, roi: null, channel: 0 });
  assert.ok(small.needBytes >= 40 * 30 && small.needBytes < est.needBytes);
  t.close();
  const tight = await fresh({ budgetBytes: 9000 });
  const s2 = (await tight.docs())[0];
  const n0 = (await tight.docs()).length;
  const e = await engineErr(tight, 'doc.run', { docId: s2.docId, docIds: [s2.docId], op: 'imageCalculator', params: { op: 'add', float32: true, all: true }, roi: null, channel: 0 });
  assert.equal(e.code, 'IJ_OVER_BUDGET');
  assert.equal(tight.IJApp.errorKey(e), 'err.overBudget');
  assert.equal((await tight.docs()).length, n0);
  tight.close();
});

// ───────────────────────── unit level: determinism and cancellation ─────────────────────────
const ctx = vm.createContext({ console, setTimeout, clearTimeout });
for (const f of ['ij-core.js', 'ij-proc-multi.js']) vm.runInContext(fs.readFileSync(path.join(DIR, f), 'utf8'), ctx, { filename: f });
const R = ctx.IJOpRegistry;
function view(id, w, h, bd, fill, display) {
  const Ctor = bd === 8 ? Uint8Array : bd === 16 ? Uint16Array : Float32Array;
  const data = new Ctor(w * h);
  for (let i = 0; i < data.length; i++) data[i] = fill(i, i % w, (i / w) | 0);
  return { id, name: 'v' + id, width: w, height: h, bitDepth: bd, calibration: { pixelWidth: 1, pixelHeight: 1, unit: 'px' }, provenance: null, active: 0, channels: [{ data, name: 'c', color: '#ffffff', display: display || { min: 0, max: bd === 8 ? 255 : 65535, lut: 'Grays', invert: false } }] };
}
const stubIo = (views, o) => Object.assign({ docIds: views.map((v) => v.id), tick: async () => {}, check() {}, reserve() {}, release() {}, dep: (n) => ctx[n], readDoc: (id) => views.find((v) => v.id === id) }, o || {});

await test('determinism: two runs give the same bytes, and a row of the result depends only on the same rows of the inputs', async () => {
  const W = 1100, H = 1100;
  const rnd = (seed) => { let s = seed; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s; }; };
  const r1 = rnd(7), r2 = rnd(9);
  const a = view(1, W, H, 16, () => r1() >>> 16), b = view(2, W, H, 8, () => r2() >>> 24);
  for (const op of ['add', 'multiply', 'divide', 'average', 'difference', 'xor']) {
    const params = { op, float32: false, all: false, channel1: 0, channel2: 0 };
    const x = await R.get('imageCalculator').run(a, params, null, stubIo([a, b]));
    const y = await R.get('imageCalculator').run(a, params, null, stubIo([a, b]));
    assert.deepEqual(Buffer.from(x[0].channels[0].data.buffer), Buffer.from(y[0].channels[0].data.buffer), op + ': same bytes twice');
    // the same operation on a band of 7 rows
    const rows = 7, y0 = 531;
    const sub = (v) => ({ id: v.id, name: v.name, width: W, height: rows, bitDepth: v.bitDepth, calibration: v.calibration, provenance: null, active: 0, channels: [Object.assign({}, v.channels[0], { data: v.channels[0].data.slice(y0 * W, (y0 + rows) * W) })] });
    const sa = sub(a), sb = sub(b);
    const z = await R.get('imageCalculator').run(sa, params, null, stubIo([sa, sb]));
    assert.deepEqual(Buffer.from(z[0].channels[0].data.buffer), Buffer.from(x[0].channels[0].data.slice(y0 * W, (y0 + rows) * W).buffer), op + ': a band of rows gives the same rows');
  }
});

await test('cancellation: a check() that throws stops the operation between two chunks and leaves the inputs alone', async () => {
  const W = 1100, H = 1100;
  const a = view(1, W, H, 8, (i) => i & 255), b = view(2, W, H, 8, (i) => (i * 7) & 255);
  const snap = [a.channels[0].data.slice(), b.channels[0].data.slice()];
  let checks = 0, ticks = 0;
  const io = stubIo([a, b], { check() { if (++checks >= 2) throw Object.assign(new Error('x'), { code: 'IJ_CANCELLED' }); }, tick: async () => { ticks++; } });
  await assert.rejects(R.get('imageCalculator').run(a, { op: 'add', all: false, channel1: 0, channel2: 0 }, null, io), (e) => e.code === 'IJ_CANCELLED');
  assert.ok(ticks >= 1 && checks === 2, 'the operation yields in chunks: ' + ticks + ' ticks, ' + checks + ' checks');
  assert.deepEqual(Buffer.from(a.channels[0].data), Buffer.from(snap[0]));
  assert.deepEqual(Buffer.from(b.channels[0].data), Buffer.from(snap[1]));
});

await test('conversions without a fixture: a 32-bit Image2 into an 8 / 16-bit result (ImageJ TypeConverter, ByteProcessor/ShortProcessor.copyBits)', async () => {
  // dst 8-bit, src float, Add: convertToByte(true) = create8BitImage: (int)((v-min)*255/(max-min)+0.5), min/max = the display range
  const f = new Float32Array([-10, 0, 5, 10, 20, 30, NaN, Infinity]);
  const a = view(1, 8, 1, 8, (i) => 10 * i);
  const b = view(2, 8, 1, 32, (i) => f[i], { min: 0, max: 20, lut: 'Grays', invert: false });
  const run = async (A, B, p) => (await R.get('imageCalculator').run(A, Object.assign({ all: false, channel1: 0, channel2: 0 }, p), null, stubIo([A, B])))[0].channels[0].data;
  // create8BitImage with the display range 0..20: scale 255/20 = 12.75; -10 -> 0, 5 -> (int)(63.75+0.5) = 64, 10 -> 128,
  // 20 and 30 -> 255, NaN -> (int)NaN = 0, +Infinity -> (int) saturates -> 255
  assert.deepEqual(Array.from(await run(a, b, { op: 'copy' })), [0, 0, 64, 128, 255, 255, 0, 255]);
  // dst 8-bit, src float, Multiply: temporary float, setPixels(): (byte)(fround(a*b + 0.5f)) clamped to 0..255:
  // 0*-10 = -0 -> 0 ; 10*0 -> 0 ; 20*5 -> 100 ; 30*10, 40*20, 50*30 -> 255 ; 60*NaN -> 0 ; 70*Infinity -> 255
  assert.deepEqual(Array.from(await run(a, b, { op: 'multiply' })), [0, 0, 100, 255, 255, 255, 0, 255]);
  // dst 8-bit, src float, Divide: 0/0 = NaN -> 0, x/0 = Infinity -> 255 (setPixels clamps)
  const z = view(3, 4, 1, 32, (i) => [0, 1, 0, 2][i], { min: 0, max: 2, lut: 'Grays', invert: false });
  const n = view(4, 4, 1, 8, (i) => [0, 5, 7, 9][i]);
  assert.deepEqual(Array.from(await run(n, z, { op: 'divide' })), [0, 5, 255, 5]);
  // dst 16-bit, src float, Add: convertToShort(false) = clamp(v) then (short)(v+0.5)
  const d16 = view(5, 6, 1, 16, (i) => 1000 * i);
  const s32 = view(6, 6, 1, 32, (i) => [-5, 0.4, 0.5, 70000, NaN, 12.5][i]);
  // -5 -> 0 ; 0.4 -> (short)0.9 = 0 ; 0.5 -> 1 ; 70000 -> 65535 ; NaN -> 0 ; 12.5 -> 13
  assert.deepEqual(Array.from(await run(d16, s32, { op: 'add' })), [0, 1000, 2001, 65535, 4000, 5013]);
  // 32-bit result: 8/16 sources are plain floats
  const w = Array.from(await run(a, view(7, 8, 1, 16, (i) => 1000 * i), { op: 'add', float32: true }));
  assert.deepEqual(w, Array.from({ length: 8 }, (_, i) => 10 * i + 1000 * i));
  // a 0 * negative float is -0 (IEEE), as in Java
  const zero = view(8, 2, 1, 32, (i) => [0, 3][i]), neg = view(9, 2, 1, 32, (i) => [-1.5, 2][i]);
  const mz = await run(zero, neg, { op: 'multiply' });
  assert.ok(Object.is(mz[0], -0) && mz[1] === 6);
  // average rounds the float sum first: 16777216 + 1 does not fit a float mantissa
  const big = view(10, 2, 1, 32, (i) => [16777216, 1][i]), one = view(11, 2, 1, 32, (i) => [1, 3][i]);
  const av = await run(big, one, { op: 'average' });
  assert.equal(av[0], 8388608.0, 'fround(16777216 + 1) / 2');
  assert.equal(av[1], 2);
});

await test('the integer blitters of 16 bits wrap the product like Java ints (65535 * 65535 gives 0, not 65535)', async () => {
  const a = view(1, 4, 1, 16, (i) => [65535, 46341, 46340, 300][i]), b = view(2, 4, 1, 16, (i) => [65535, 46341, 46340, 300][i]);
  const out = Array.from((await R.get('imageCalculator').run(a, { op: 'multiply', all: false, channel1: 0, channel2: 0 }, null, stubIo([a, b])))[0].channels[0].data);
  // 65535^2 = 4294836225 -> int -131071 -> 0 ; 46341^2 = 2147488281 -> -2147479015 -> 0 ; 46340^2 = 2147395600 -> clamp 65535 ; 300^2 = 90000 -> 65535
  assert.deepEqual(out, [0, 0, 65535, 65535]);
});

await test('Merge Channels (unit): one image in two slots, the title rule, gray and colour LUTs mixed, the slot colours', async () => {
  const g = (id, name, color, lut) => { const v = view(id, 6, 2, 8, (i) => (i * id) & 255); v.name = name; v.channels[0].color = color; v.channels[0].display = { min: 0, max: 255, lut, invert: false }; v.channels[0].name = 'ch' + id; return v; };
  const run = async (views, sources, extra) => (await R.get('mergeChannels').run(views[0], Object.assign({ sources }, extra || {}), null, stubIo(views)))[0];
  // the same image in C1 and C2 (RGBStackMerge.isDuplicate): two independent channels
  const a = g(1, 'embryo', '#ffffff', 'Grays');
  let r = await run([a], [{ docId: 1, slot: 0 }, { docId: 1, slot: 1 }]);
  assert.equal(r.name, 'Composite', 'a title without "C1-" is called Composite');
  assert.equal(r.channels.length, 2);
  assert.notEqual(r.channels[0].data, r.channels[1].data);
  assert.deepEqual(arr(r.channels[0].data), arr(a.channels[0].data));
  assert.deepEqual(arr(r.channels.map((c) => c.color)), ['#ff0000', '#00ff00']);
  // a coloured source: nobody gets a slot colour (allGrayLuts is false) unless the LUTs are ignored
  const b = g(2, 'C1-x', '#4488ff', '#4488ff'), c = g(3, 'C2-x', '#ffffff', 'Grays');
  r = await run([b, c], [{ docId: 2, slot: 0 }, { docId: 3, slot: 1 }]);
  assert.equal(r.name, 'x');
  assert.deepEqual(arr(r.channels.map((x) => x.color)), ['#4488ff', '#ffffff']);
  assert.deepEqual(arr(r.channels.map((x) => x.display.lut)), ['#4488ff', 'Grays']);
  r = await run([b, c], [{ docId: 2, slot: 0 }, { docId: 3, slot: 1 }], { ignoreLuts: true });
  assert.deepEqual(arr(r.channels.map((x) => x.color)), ['#ff0000', '#00ff00']);
  // C4 is gray (white), C5..C7 cyan, magenta, yellow
  const many = [4, 5, 6, 7].map((id) => g(id, 'n' + id, '#ffffff', 'Grays'));
  r = await run(many, [{ docId: 4, slot: 3 }, { docId: 5, slot: 4 }, { docId: 6, slot: 5 }, { docId: 7, slot: 6 }]);
  assert.deepEqual(arr(r.channels.map((x) => x.color)), ['#ffffff', '#00ffff', '#ff00ff', '#ffff00']);
  assert.deepEqual(arr(r.channels.map((x) => x.display.lut)), ['Grays', 'Cyan', 'Magenta', 'Yellow']);
  // slots are taken in slot order whatever the order of the request
  r = await run([a, b], [{ docId: 2, slot: 2 }, { docId: 1, slot: 0 }], { ignoreLuts: true });
  assert.deepEqual(arr(r.channels.map((x) => x.name)), ['ch1', 'ch2']);
  assert.deepEqual(arr(r.channels.map((x) => x.color)), ['#ff0000', '#0000ff']);
});

await test('review fixes: 8-bit result keeps Image1 range, rounded 16-bit bounds, grey ramps are not colour LUTs, Arrange recolours grey channels, channel2 without docs', async () => {
  const calc = async (A, B, p) => (await R.get('imageCalculator').run(A, Object.assign({ all: false, channel1: 0, channel2: 0 }, p), null, stubIo([A, B])))[0];
  // 1. ByteProcessor.createProcessor: setMinAndMax(min, max) of Image1 is carried to the result
  const a = view(1, 4, 1, 8, (i) => 10 * i, { min: 10, max: 200, lut: 'Grays', invert: false });
  const b = view(2, 4, 1, 8, (i) => i);
  let r = await calc(a, b, { op: 'add' });
  assert.equal(r.channels[0].display.min, 10); assert.equal(r.channels[0].display.max, 200);
  // 16 bits is reset (resetMinAndMax of the result), not carried
  const a16 = view(3, 4, 1, 16, (i) => 100 * i, { min: 5, max: 9, lut: 'Grays', invert: false });
  r = await calc(a16, view(4, 4, 1, 16, (i) => i), { op: 'add' });
  assert.notEqual(r.channels[0].display.max, 9);
  // 2. ShortProcessor.setMinAndMax rounds: 10.6..999.6 scales over 11..1000
  const dst = view(5, 3, 1, 8, () => 0);
  const src = view(6, 3, 1, 16, (i) => [11, 505, 1000][i], { min: 10.6, max: 999.6, lut: 'Grays', invert: false });
  const got = Array.from((await calc(dst, src, { op: 'copy' })).channels[0].data);
  const scale = 256.0 / (1000 - 11 + 1);
  assert.deepEqual(got, [11, 505, 1000].map((v) => Math.min(255, Math.floor((v - 11) * scale + 0.5))));
  // 3. a grey ramp of any brightness is not a colour LUT: the slot colours are used
  const g = (id, color, lut) => { const v = view(id, 2, 1, 8, (i) => i); v.channels[0].color = color; v.channels[0].display = { min: 0, max: 255, lut, invert: false }; return v; };
  const m = (await R.get('mergeChannels').run(g(7, '#cccccc', '#cccccc'), { sources: [{ docId: 7, slot: 0 }, { docId: 8, slot: 1 }] }, null, stubIo([g(7, '#cccccc', '#cccccc'), g(8, '#ffffff', 'Grays')])))[0];
  assert.deepEqual(arr(m.channels.map((c) => c.color)), ['#ff0000', '#00ff00']);
  const table = vm.runInContext('new Uint8Array(768)', ctx); for (let i = 0; i < 256; i++) table[i * 3] = table[i * 3 + 1] = table[i * 3 + 2] = 255 - i;
  assert.equal(ctx.IJMulti.isColorLut({ color: '#ffffff', display: { lut: table } }), false);
  assert.equal(ctx.IJMulti.isColorLut({ color: '#ff0000', display: { lut: 'Red' } }), true);
  // 4. Arrange recolours all-grey channels by new position, and leaves coloured ones alone
  const arr3 = (colored) => { const v = view(9, 2, 1, 8, (i) => i); v.channels = [0, 1, 2].map((k) => Object.assign({}, v.channels[0], { name: 'n' + k, data: new Uint8Array([k, k]), color: colored ? ['#ff4444', '#44ff44', '#4488ff'][k] : '#ffffff', display: { min: 0, max: 255, lut: colored ? ['#ff4444', '#44ff44', '#4488ff'][k] : 'Grays', invert: false } })); return v; };
  let ar = await R.get('arrangeChannels').run(arr3(false), { order: [2, 0, 1] }, null, stubIo([arr3(false)]));
  assert.deepEqual(arr(ar.channels.map((c) => c.color)), ['#ff0000', '#00ff00', '#0000ff']);
  assert.deepEqual(arr(ar.channels.map((c) => c.display.lut)), ['Red', 'Green', 'Blue']);
  ar = await R.get('arrangeChannels').run(arr3(true), { order: [2, 0, 1] }, null, stubIo([arr3(true)]));
  assert.equal(ar.channels[0].color, undefined, 'coloured channels keep their own');
  // 6. validate without a named Image2: channel2 is only checked against 0
  R.get('imageCalculator').validate({ op: 'add', channel1: 0, channel2: 2 }, { channels: 1, docs: [] });
  assert.throws(() => R.get('imageCalculator').validate({ op: 'add', channel1: 0, channel2: -1 }, { channels: 1, docs: [] }));
  assert.throws(() => R.get('imageCalculator').validate({ op: 'add', channel1: 0, channel2: 3 }, { channels: 1, docs: [{ channels: 3 }] }));
});

console.log(`ok test_ij_multi_commands: ${passed} groups`);
process.exit(0);
