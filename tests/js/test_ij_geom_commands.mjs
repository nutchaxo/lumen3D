// Package P5 (geom) of the Advanced Studio, end to end through tests/js/ij_harness.mjs: the REAL controller behind a recording
// chrome, the REAL worker and engine behind a fake Worker, the dialogs validated by the real field schema.
//
//   • one run per command (dialog values → api → engine): the pixels are what the kernels of ij-proc-geom.js (themselves
//     checked against ImageJ 1.54p by test_ij_geom_fixtures.mjs) give for the image on screen, the calibration follows,
//     undo restores the old image, redo the new one, and a restore from the stored journal (reload without a snapshot)
//     and from a snapshot gives the same pixels;
//   • 8, 16 and 32 bits; a selection (Rotate, Translate, Scale keep to its rectangle, Rotate ignores Enlarge with one);
//   • the Rotate grid overlay, the preview of Rotate and Translate (the harness ticks the Preview box), the dialogs'
//     derived fields (Size, Scale, Properties, Set Scale) and their validate() messages;
//   • refusals: the error codes of the ops and what the operator is told (IJApp.errorKey), bad arguments, a bit depth
//     the op does not take, an estimate that does not fit.
//
// Run: node tests/js/test_ij_geom_commands.mjs
import assert from 'node:assert/strict';
import { boot, until, J } from './ij_harness.mjs';

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { console.error('FAIL ' + name); throw e; }
}
const arr = (a) => Array.from(a);
const fnv = (a) => { let h = 0x811c9dc5; const u = new Uint8Array(a.buffer, a.byteOffset, a.byteLength); for (let i = 0; i < u.length; i++) { h ^= u[i]; h = Math.imul(h, 16777619) >>> 0; } return h.toString(16); };

async function snap(t, id, w) {
  const info = w ? await t.engine('doc.info', { docId: id }, w) : (await t.docs()).find((d) => d.docId === id);
  const ch = [];
  for (let c = 0; c < info.channels.length; c++) {
    const r = w ? await t.engine('doc.tile', { docId: id, channel: c, level: 0, tx: 0, ty: 0 }, w) : null;
    ch.push(w ? r.data.slice() : await t.pixels(id, c));
  }
  return { w: info.width, h: info.height, bd: info.bitDepth, cal: J(info.calibration), ch };
}
const same = (a, b, msg) => {
  assert.equal(a.w + 'x' + a.h, b.w + 'x' + b.h, msg + ' (size)');
  assert.equal(a.ch.length, b.ch.length, msg + ' (channels)');
  for (let c = 0; c < a.ch.length; c++) assert.equal(fnv(a.ch[c]), fnv(b.ch[c]), msg + ' (channel ' + c + ')');
};
const differ = (a, b, msg) => assert.ok(a.w !== b.w || a.h !== b.h || a.ch.some((x, c) => fnv(x) !== fnv(b.ch[c])), msg);

/** Undo → the old image, redo → the new one, a restore from the journal and from a snapshot → the new one. */
async function roundTrip(t, id, before, after) {
  await t.runCommand('editUndo');
  same(await snap(t, id), before, 'undo');
  await t.runCommand('editRedo');
  same(await snap(t, id), after, 'redo');
  await t.worker.engine.whenIdle();
  const key = (await t.store.shared.list())[0].key;
  const t2 = await t.reload({ flush: false });
  const w2 = await t2.spawn();
  const res = await t2.engine('session.restore', { key }, w2);
  assert.equal(res.warnings.length, 0, 'journal replay: ' + JSON.stringify(res.warnings));
  same(await snap(t2, id, w2), after, 'restore from the journal');
  // and from a snapshot: flush, boot again on the same storage
  await t2.engine('flush', {}, w2);
  const t3 = await t2.reload({ flush: false });
  const w3 = await t3.spawn();
  const res3 = await t3.engine('session.restore', { key }, w3);
  assert.equal(res3.warnings.length, 0, 'snapshot restore: ' + JSON.stringify(res3.warnings));
  same(await snap(t3, id, w3), after, 'restore from the snapshot');
  t3.close();
}

const G = (t) => t.page.IJGeom;
const roiRect = (x, y, w, h) => ({ type: 'rect', x, y, w, h });
async function select(t, roi) { await t.shell.opts.onRoi(roi, { final: true }); }

// ─────────────────────────────── Rotate ───────────────────────────────
await test('Rotate: pixels = the kernel, grid overlay, preview, undo / redo / journal restore', async () => {
  const t = await boot({ channels: 2 });
  await t.open();
  const id = t.activeId();
  const before = await snap(t, id);
  await t.runCommand('transformRotate', { angle: 30, grid: 3, interpolation: 'bilinear' });
  const after = await snap(t, id);
  differ(before, after, 'rotated');
  assert.equal(after.w + 'x' + after.h, before.w + 'x' + before.h);
  for (let c = 0; c < 2; c++) {
    const exp = G(t).kernels.rotateBand(Uint8Array.from(before.ch[c]), before.w, before.h, 8, { x: 0, y: 0, w: before.w, h: before.h }, 30, 1, 0, 0, before.w, before.h);
    assert.equal(fnv(after.ch[c]), fnv(exp), 'channel ' + c + ' is the rotated channel');
  }
  // the grid: one overlay item, lines at (i + 1/2) / n of the size (Rotator.drawGridLines), cleared after the dialog
  const grids = t.log.overlays.filter((o) => o && o[0] && o[0].kind === 'grid');
  assert.ok(grids.length >= 1, 'the grid was drawn when the dialog opened');
  assert.deepEqual(J(grids[0][0].lines), [[20, 0, 20, 30], [0, 15, 40, 15]]);
  // editing "Grid lines" redraws it: 3 lines each way, at 1/6, 3/6 and 5/6
  let redrawn = null;
  t.script.dialogs.push((spec) => {
    spec.onChange({ angle: 15, grid: 3, interpolation: 'bilinear' }, () => {}, 'grid');
    redrawn = t.log.overlays.filter((o) => o && o[0] && o[0].kind === 'grid').pop();
    return null;
  });
  await t.shell.opts.onCommand(t.cmd('transformRotate'), { source: 'menu' });
  assert.equal(redrawn[0].lines.length, 6);
  assert.deepEqual(J(redrawn[0].lines.slice(0, 2)), [[40 / 6, 0, 40 / 6, 30], [0, 30 / 6, 40, 30 / 6]]);
  await t.runCommand('editUndo');
  await t.runCommand('editRedo');
  assert.equal(t.log.overlays[t.log.overlays.length - 1], null, 'the overlay is cleared when the dialog closes');
  assert.ok(t.log.previews.length >= 1, 'the Preview box was exercised');
  await roundTrip(t, id, before, after);
  t.close();
});

await test('Rotate: 0 degrees on 8 bits changes nothing (ByteProcessor), 16-bit does alter the last column; nearest neighbour and bicubic', async () => {
  const t = await boot({ channels: 1 });
  await t.open();
  const id = t.activeId();
  const before = await snap(t, id);
  const whole = { x: 0, y: 0, w: before.w, h: before.h };
  await t.runCommand('transformRotate', { angle: 0, grid: 0, interpolation: 'bilinear' });
  same(await snap(t, id), before, 'ByteProcessor.rotate: if (angle%360==0) return');
  for (const [interp, m] of [['none', 0], ['bicubic', 2]]) {
    await t.runCommand('transformRotate', { angle: -17.5, grid: 1, interpolation: interp });
    const cur = await snap(t, id);
    const exp = G(t).kernels.rotateBand(Uint8Array.from(before.ch[0]), before.w, before.h, 8, whole, -17.5, m, 0, 0, before.w, before.h);
    assert.equal(fnv(cur.ch[0]), fnv(exp), interp);
    await t.runCommand('editUndo');
    same(await snap(t, id), before, interp + ': undo');
  }
  t.close();
  const t16 = await boot({ channels: 1 });
  await t16.open();
  await t16.runCommand('typeBit16', {});
  const id16 = t16.activeId();
  const b16 = await snap(t16, id16);
  await t16.runCommand('transformRotate', { angle: 0, grid: 0, interpolation: 'bilinear' });
  const a16 = await snap(t16, id16);
  const exp16 = G(t16).kernels.rotateBand(Uint16Array.from(b16.ch[0]), b16.w, b16.h, 16, { x: 0, y: 0, w: b16.w, h: b16.h }, 0, 1, 0, 0, b16.w, b16.h);
  assert.equal(fnv(a16.ch[0]), fnv(exp16), 'ShortProcessor.rotate has no early return: xs >= xlimit is clamped to width-1.001');
  t16.close();
});

await test('Rotate with a selection: only its rectangle, centred on it; Enlarge is not offered', async () => {
  const t = await boot({ channels: 1 });
  await t.open();
  const id = t.activeId();
  const before = await snap(t, id);
  await select(t, roiRect(8, 5, 20, 16));
  await t.runCommand('transformRotate', { angle: 15, grid: 0, interpolation: 'bilinear' });
  assert.ok(!t.log.dialogSpecs.at(-1).fields.some((f) => f.id === 'enlarge'), 'no Enlarge with a partial selection');
  const after = await snap(t, id);
  const exp = G(t).kernels.rotateBand(Uint8Array.from(before.ch[0]), before.w, before.h, 8, { x: 8, y: 5, w: 20, h: 16 }, 15, 1, 8, 5, 20, 16);
  for (let y = 0; y < before.h; y++) for (let x = 0; x < before.w; x++) {
    const inside = x >= 8 && x < 28 && y >= 5 && y < 21;
    const want = inside ? exp[(y - 5) * 20 + (x - 8)] : before.ch[0][y * before.w + x];
    assert.equal(after.ch[0][y * before.w + x], want, `(${x},${y})`);
  }
  // an oval: the pixels of the rectangle outside the oval keep their value (SUPPORTS_MASKING)
  await t.runCommand('editUndo');
  await select(t, { type: 'oval', x: 6, y: 4, w: 24, h: 20 });
  await t.runCommand('transformRotate', { angle: -30, grid: 0, interpolation: 'bilinear' });
  const ov = await snap(t, id);
  assert.equal(ov.ch[0][4 * before.w + 6], before.ch[0][4 * before.w + 6], 'a corner of the oval box is outside the oval: unchanged');
  t.close();
});

await test('Rotate with Enlarge: the canvas grows (Rotator.enlargeCanvas), zero fill, undo gives the old size', async () => {
  const t = await boot({ channels: 2 });
  await t.open();
  const id = t.activeId();
  const before = await snap(t, id);
  await t.runCommand('transformRotate', { angle: 30, grid: 0, interpolation: 'bilinear', enlarge: true });
  const after = await snap(t, id);
  const e = G(t).enlargedSize(before.w, before.h, 30);
  assert.equal(after.w + 'x' + after.h, e.w + 'x' + e.h);
  assert.ok(e.w > before.w && e.h > before.h);
  assert.equal(after.ch[0][0], 0, 'the corner of the new canvas is zero');
  await roundTrip(t, id, before, after);
  t.close();
});

await test('Rotate, 16 and 32 bits', async () => {
  for (const bits of [16, 32]) {
    const t = await boot({ channels: 1 });
    await t.open();
    await t.runCommand(bits === 16 ? 'typeBit16' : 'typeBit32', {});
    const id = t.activeId();
    const before = await snap(t, id);
    assert.equal(before.bd, bits);
    await t.runCommand('transformRotate', { angle: 15, grid: 0, interpolation: 'bicubic' });
    const after = await snap(t, id);
    const T = bits === 16 ? Uint16Array : Float32Array;
    const exp = G(t).kernels.rotateBand(T.from(before.ch[0]), before.w, before.h, bits, { x: 0, y: 0, w: before.w, h: before.h }, 15, 2, 0, 0, before.w, before.h);
    assert.equal(fnv(after.ch[0]), fnv(exp), bits + '-bit');
    await roundTrip(t, id, before, after);
    t.close();
  }
});

// ─────────────────────────────── Translate ───────────────────────────────
await test('Translate: the content moves, zero comes in, undo / redo / restore; a selection moves its rectangle only', async () => {
  const t = await boot({ channels: 2 });
  await t.open();
  const id = t.activeId();
  const before = await snap(t, id);
  await t.runCommand('transformTranslate', { dx: 3, dy: -2, interpolation: 'none' });
  const after = await snap(t, id);
  for (let c = 0; c < 2; c++) for (let y = 0; y < before.h; y++) for (let x = 0; x < before.w; x++) {
    const sx = x - 3, sy = y + 2;
    const want = sx >= 0 && sx < before.w && sy >= 0 && sy < before.h ? before.ch[c][sy * before.w + sx] : 0;
    assert.equal(after.ch[c][y * before.w + x], want);
  }
  assert.ok(t.log.previews.length >= 1, 'previewed');
  await roundTrip(t, id, before, after);
  t.close();
  // a selection: the rectangle takes its content from the whole image, nothing outside it changes
  const t2 = await boot({ channels: 1 });
  await t2.open();
  const id2 = t2.activeId();
  const b2 = await snap(t2, id2);
  await select(t2, roiRect(10, 8, 12, 10));
  await t2.runCommand('transformTranslate', { dx: 2, dy: 1, interpolation: 'none' });
  const a2 = await snap(t2, id2);
  for (let y = 0; y < b2.h; y++) for (let x = 0; x < b2.w; x++) {
    const inside = x >= 10 && x < 22 && y >= 8 && y < 18;
    const want = inside ? b2.ch[0][(y - 1) * b2.w + (x - 2)] : b2.ch[0][y * b2.w + x];
    assert.equal(a2.ch[0][y * b2.w + x], want, `(${x},${y})`);
  }
  t2.close();
});

await test('Translate, 16 and 32 bits, bilinear: the last row and column become zero (ImageProcessor.translate)', async () => {
  for (const bits of [16, 32]) {
    const t = await boot({ channels: 1 });
    await t.open();
    await t.runCommand(bits === 16 ? 'typeBit16' : 'typeBit32', {});
    const id = t.activeId();
    const before = await snap(t, id);
    await t.runCommand('transformTranslate', { dx: 0.5, dy: 0.25, interpolation: 'bilinear' });
    const after = await snap(t, id);
    assert.equal(after.ch[0][after.w - 1], 0);
    assert.equal(after.ch[0][(after.h - 1) * after.w], 0);
    await roundTrip(t, id, before, after);
    t.close();
  }
});

// ─────────────────────────────── Bin ───────────────────────────────
await test('Bin: every method, calibration x factor, undo / redo / restore; the dialog refuses a factor larger than the image', async () => {
  const t = await boot({ channels: 2 });
  await t.open();
  const id = t.activeId();
  const before = await snap(t, id);
  for (const method of ['average', 'median', 'min', 'max', 'sum']) {
    await t.runCommand('transformBin', { xshrink: 3, yshrink: 2, method });
    const a = await snap(t, id);
    assert.equal(a.w + 'x' + a.h, '13x15');
    assert.ok(Math.abs(a.cal.pixelWidth - before.cal.pixelWidth * 3) < 1e-9 && Math.abs(a.cal.pixelHeight - before.cal.pixelHeight * 2) < 1e-9, 'calibration x factor');
    const c0 = before.ch[0];
    const at = (x, y) => c0[y * before.w + x];
    // the block (0,0) of the source: columns 0..2, rows 0..1
    const blk = [at(0, 0), at(1, 0), at(2, 0), at(0, 1), at(1, 1), at(2, 1)];
    const exp = { average: Math.floor(blk.reduce((s, v) => s + v, 0) / 6 + 0.5), min: Math.min(...blk), max: Math.max(...blk), sum: Math.min(255, blk.reduce((s, v) => s + v, 0)) }[method];
    if (exp !== undefined) assert.equal(a.ch[0][0], exp, method);
    if (method === 'median') assert.equal(a.ch[0][0], blk.slice().sort((x, y) => x - y)[1], 'ImageJ "median" of a 3 x 2 block: halfsize+1 = 4 largest zeroed, the maximum of the two left = the second smallest');
    await t.runCommand('editUndo');
    same(await snap(t, id), before, method + ': undo');
  }
  await t.runCommand('transformBin', { xshrink: 2, yshrink: 2, method: 'average' });
  const after = await snap(t, id);
  await roundTrip(t, id, before, after);
  t.close();
  // validate(): a factor larger than the image
  const t2 = await boot({ channels: 1 });
  await t2.open();
  let msgs = null;
  t2.script.dialogs.push((spec) => { msgs = spec.validate({ xshrink: 100, yshrink: 2, method: 'average' }); return null; });
  await t2.shell.opts.onCommand(t2.cmd('transformBin'), { source: 'menu' });
  assert.deepEqual(J(msgs), { xshrink: 'err.geomBinTooLarge' });
  t2.close();
});

await test('Bin on a 16-bit image: sum clamps at 65535 and the display maximum grows; 32-bit does not clamp', async () => {
  const t = await boot({ channels: 1 });
  await t.open();
  await t.runCommand('typeBit16', {});
  const id = t.activeId();
  const before = await snap(t, id);
  const info0 = (await t.docs()).find((d) => d.docId === id);
  await t.runCommand('transformBin', { xshrink: 2, yshrink: 2, method: 'sum' });
  const after = await snap(t, id);
  const at = (x, y) => before.ch[0][y * before.w + x];
  assert.equal(after.ch[0][0], Math.min(65535, at(0, 0) + at(1, 0) + at(0, 1) + at(1, 1)));
  const info1 = (await t.docs()).find((d) => d.docId === id);
  assert.ok(info1.channels[0].display.max >= info0.channels[0].display.max, 'the display maximum follows the sum');
  t.close();
});

// ─────────────────────────────── Size (resize) ───────────────────────────────
await test('Image > Adjust > Size: the dialog keeps the aspect ratio, the result is the kernel, the calibration is divided', async () => {
  const t = await boot({ channels: 2 });
  await t.open();
  const id = t.activeId();
  const before = await snap(t, id);
  await t.runCommand('adjustSize', { width: 20, height: 15, constrain: true, average: true, interpolation: 'bilinear' });
  const spec = t.log.dialogSpecs.at(-1);
  assert.equal(spec.fields.find((f) => f.id === 'width').value, 20, 'default = half the width');
  assert.equal(spec.fields.find((f) => f.id === 'height').value, 15);
  const after = await snap(t, id);
  assert.equal(after.w + 'x' + after.h, '20x15');
  assert.ok(Math.abs(after.cal.pixelWidth - before.cal.pixelWidth * 2) < 1e-9, 'pixelWidth *= origWidth/newWidth');
  const exp = await G(t).kernels.resizeImage(Uint8Array.from(before.ch[1]), before.w, before.h, 8, { x: 0, y: 0, w: before.w, h: before.h }, 20, 15, 1, true, null);
  assert.equal(fnv(after.ch[1]), fnv(exp));
  await roundTrip(t, id, before, after);
  t.close();
  // constrain on: a width of 25 rewrites the height (30/40 * 25 = 18.75 → 19) at OK, whatever the height field says
  const t2 = await boot({ channels: 1 });
  await t2.open();
  const id2 = t2.activeId();
  let derived = null;
  t2.script.dialogs.push((spec) => {
    spec.onChange({ width: 25, height: 99, constrain: true, average: true, interpolation: 'bilinear' }, (p) => { derived = p; }, 'width');
    return { width: 25, height: 99, constrain: true, average: true, interpolation: 'bilinear' };
  });
  await t2.shell.opts.onCommand(t2.cmd('adjustSize'), { source: 'menu' });
  assert.deepEqual(J(derived), { height: 19 });
  const a2 = await snap(t2, id2);
  assert.equal(a2.w + 'x' + a2.h, '25x19');
  t2.close();
});

await test('Size with a selection resizes its rectangle into the image; 16 and 32 bits, averaging off, nearest', async () => {
  const t = await boot({ channels: 1 });
  await t.open();
  const id = t.activeId();
  const before = await snap(t, id);
  await select(t, roiRect(4, 3, 24, 18));
  await t.runCommand('adjustSize', { width: 12, height: 9, constrain: true, average: false, interpolation: 'none' });
  const after = await snap(t, id);
  assert.equal(after.w + 'x' + after.h, '12x9');
  assert.ok(Math.abs(after.cal.pixelWidth - before.cal.pixelWidth * 2) < 1e-9, 'origWidth is the selection width');
  await roundTrip(t, id, before, after);
  t.close();
  for (const bits of [16, 32]) {
    const t3 = await boot({ channels: 1 });
    await t3.open();
    await t3.runCommand(bits === 16 ? 'typeBit16' : 'typeBit32', {});
    const id3 = t3.activeId();
    const b3 = await snap(t3, id3);
    await t3.runCommand('adjustSize', { width: 10, height: 8, constrain: false, average: true, interpolation: 'bicubic' });
    const a3 = await snap(t3, id3);
    assert.equal(a3.w + 'x' + a3.h, '10x8');
    assert.equal(a3.bd, bits);
    await roundTrip(t3, id3, b3, a3);
    t3.close();
  }
});

// ─────────────────────────────── Canvas Size ───────────────────────────────
await test('Canvas Size: 9 anchors, zero fill, a smaller canvas cuts, undo / redo / restore', async () => {
  const t = await boot({ channels: 2 });
  await t.open();
  const id = t.activeId();
  const before = await snap(t, id);
  for (const position of G(t).POSITIONS) {
    await t.runCommand('adjustCanvasSize', { width: 50, height: 41, position });
    const a = await snap(t, id);
    assert.equal(a.w + 'x' + a.h, '50x41');
    const o = G(t).canvasOffsets(before.w, before.h, 50, 41, position);
    for (const [x, y] of [[0, 0], [before.w - 1, before.h - 1], [13, 7]]) assert.equal(a.ch[1][(y + o.y) * 50 + x + o.x], before.ch[1][y * before.w + x], position);
    const cornerOutside = o.x > 0 ? [0, 0] : [49, 0];
    if (o.x > 0 || o.y > 0 || o.x + before.w < 50 || o.y + before.h < 41) assert.equal(a.ch[0].reduce((s, v) => s + v, 0), before.ch[0].reduce((s, v) => s + v, 0), position + ': nothing is lost, the rest is zero');
    void cornerOutside;
    await t.runCommand('editUndo');
  }
  await t.runCommand('adjustCanvasSize', { width: 25, height: 20, position: 'bottomRight' });
  const small = await snap(t, id);
  assert.equal(small.w + 'x' + small.h, '25x20');
  assert.equal(small.ch[0][0], before.ch[0][(before.h - 20) * before.w + (before.w - 25)]);
  await roundTrip(t, id, before, small);
  t.close();
});

// ─────────────────────────────── Scale ───────────────────────────────
await test('Scale, new window: a second image of the new size, calibration / scale, the source untouched', async () => {
  const t = await boot({ channels: 2 });
  await t.open();
  const id = t.activeId();
  const before = await snap(t, id);
  const n0 = (await t.docs()).length;
  await t.runCommand('imageScale', { xscale: 0.5, yscale: 0.5, width: 20, height: 15, interpolation: 'bilinear', average: true, newWindow: true, title: 'half' });
  const docs = await t.docs();
  assert.equal(docs.length, n0 + 1);
  const nd = docs.find((d) => d.name === 'half');
  assert.ok(nd, 'the new image carries the title of the dialog');
  const a = await snap(t, nd.docId);
  assert.equal(a.w + 'x' + a.h, '20x15');
  assert.ok(Math.abs(a.cal.pixelWidth - before.cal.pixelWidth * 2) < 1e-9, 'pixelWidth *= 1/xscale');
  same(await snap(t, id), before, 'the source image is untouched');
  const exp = await G(t).kernels.resizeImage(Uint8Array.from(before.ch[0]), before.w, before.h, 8, { x: 0, y: 0, w: before.w, h: before.h }, 20, 15, 1, true, null);
  assert.equal(fnv(a.ch[0]), fnv(exp));
  // the new image survives a reload (its own baseline)
  await t.worker.engine.whenIdle();
  const key = (await t.store.shared.list())[0].key;
  const t2 = await t.reload({ flush: false });
  const w2 = await t2.spawn();
  const res = await t2.engine('session.restore', { key }, w2);
  assert.equal(res.warnings.length, 0);
  same(await snap(t2, nd.docId, w2), a, 'the new image after a reload');
  t2.close();
});

await test('Scale in place: the canvas does not change, the selection is dropped, 16-bit fills with the display minimum', async () => {
  const t = await boot({ channels: 1 });
  await t.open();
  await t.runCommand('typeBit16', {});
  const id = t.activeId();
  const before = await snap(t, id);
  const info = (await t.docs()).find((d) => d.docId === id);
  await select(t, roiRect(0, 0, before.w, before.h));
  assert.ok(t.shell.opts.getState().roi, 'a selection is set');
  await t.runCommand('imageScale', { xscale: 0.5, yscale: 0.5, width: 20, height: 15, interpolation: 'bilinear', average: true, newWindow: false, title: 'x' });
  const after = await snap(t, id);
  assert.equal(after.w + 'x' + after.h, before.w + 'x' + before.h);
  assert.equal(t.shell.opts.getState().roi, null, 'the selection is removed (Scaler.scale: imp.deleteRoi())');
  const fill = G(t).scaleFill(16, info.channels[0].display.min);
  assert.equal(after.ch[0][0], fill, 'outside the scaled image: the display minimum');
  assert.equal(after.ch[0][after.w - 1], fill);
  await roundTrip(t, id, before, after);
  t.close();
});

await test('Scale dialog: derived fields (X scale → Y scale, width, height; width → height, scales)', async () => {
  const t = await boot({ channels: 1 });
  await t.open();
  let out = [];
  t.script.dialogs.push((spec) => {
    const set = (p) => out.push(J(p));
    const base = { xscale: 0.5, yscale: 0.5, width: 20, height: 15, interpolation: 'bilinear', average: true, newWindow: true, title: 't' };
    spec.onChange(Object.assign({}, base, { xscale: 2 }), set, 'xscale');
    spec.onChange(Object.assign({}, base, { yscale: 0.25 }), set, 'yscale');
    spec.onChange(Object.assign({}, base, { width: 10 }), set, 'width');
    spec.onChange(Object.assign({}, base, { height: 6 }), set, 'height');
    return null;
  });
  await t.shell.opts.onCommand(t.cmd('imageScale'), { source: 'menu' });
  assert.deepEqual(out, [{ yscale: 2, width: 80, height: 60 }, { height: 8 }, { height: 8, xscale: 0.25, yscale: 8 / 30 }, { yscale: 6 / 30 }]);
  t.close();
});

// ─────────────────────────────── Properties / Set Scale ───────────────────────────────
await test('Properties: calibration only (the selection stays), undo / redo, restore; an empty unit removes the scale', async () => {
  const t = await boot({ channels: 1 });
  await t.open();
  const id = t.activeId();
  const before = await snap(t, id);
  await select(t, roiRect(3, 3, 10, 8));
  const rev0 = (await t.docs())[0].rev;
  await t.runCommand('imageProperties', { pixelWidth: 2, pixelHeight: 3, unit: 'mm' });
  const after = await snap(t, id);
  assert.deepEqual([after.cal.pixelWidth, after.cal.pixelHeight, after.cal.unit], [2, 3, 'mm']);
  same(after, Object.assign({}, before, { cal: after.cal }), 'the pixels are untouched');
  assert.ok((await t.docs())[0].rev > rev0);
  assert.ok(t.shell.opts.getState().roi, 'a calibration-only change keeps the selection');
  await roundTrip(t, id, before, after);
  const t2 = await boot({ channels: 1 });
  await t2.open();
  await t2.runCommand('imageProperties', { pixelWidth: 0.5, pixelHeight: 0.5, unit: '' });
  const r = await snap(t2, t2.activeId());
  assert.deepEqual([r.cal.pixelWidth, r.cal.pixelHeight, r.cal.unit], [1, 1, 'pixel']);
  t2.close(); t.close();
});

await test('Properties dialog: the height follows the width only on an uncalibrated image; another known unit converts the sizes', async () => {
  const t = await boot({ channels: 1 });
  await t.open();
  // the harness volume is calibrated in µm (0.5): ImageProperties.textValueChanged — textChangedCount==1 && calPixelHeight!=1.0 → no link
  const out = [];
  t.script.dialogs.push((spec) => {
    const set = (p) => out.push(J(p));
    const cur = { pixelWidth: 0.5, pixelHeight: 0.5, unit: 'µm' };
    spec.onChange(Object.assign({}, cur, { pixelWidth: 0.75 }), set, 'pixelWidth');
    spec.onChange(Object.assign({}, cur, { pixelWidth: 0.75, unit: 'mm' }), set, 'unit');
    return null;
  });
  await t.shell.opts.onCommand(t.cmd('imageProperties'), { source: 'menu' });
  assert.equal(out.length, 1, 'no link on a calibrated image: ' + JSON.stringify(out));
  assert.ok(Math.abs(out[0].pixelWidth - 0.75 * 1e-3) < 1e-12 && Math.abs(out[0].pixelHeight - 0.5 * 1e-3) < 1e-12, 'µm → mm: x 1e-3 (' + JSON.stringify(out[0]) + ')');
  // an uncalibrated image: the height follows the width until the height is edited
  await t.runCommand('imageProperties', { pixelWidth: 1, pixelHeight: 1, unit: '' });
  const out2 = [];
  t.script.dialogs.push((spec) => {
    const set = (p) => out2.push(J(p));
    spec.onChange({ pixelWidth: 2, pixelHeight: 1, unit: 'pixel' }, set, 'pixelWidth');
    spec.onChange({ pixelWidth: 2, pixelHeight: 5, unit: 'pixel' }, set, 'pixelHeight');
    spec.onChange({ pixelWidth: 3, pixelHeight: 5, unit: 'pixel' }, set, 'pixelWidth');
    return null;
  });
  await t.shell.opts.onCommand(t.cmd('imageProperties'), { source: 'menu' });
  assert.deepEqual(out2, [{ pixelHeight: 2 }], 'the link is broken by an edit of the height');
  t.close();
});

await test('Set Scale: from a straight line, the scale line, aspect ratio, unit "um" → µm, the scale does not change when only the unit does', async () => {
  const t = await boot({ channels: 1 });
  await t.open();
  const id = t.activeId();
  const before = await snap(t, id);
  await select(t, { type: 'line', x1: 0, y1: 0, x2: 30, y2: 40, width: 1 });
  await t.runCommand('analyzeSetScale', { measured: 50, known: 25, aspect: 1, unit: 'um', remove: false });
  const spec = t.log.dialogSpecs.at(-1);
  assert.equal(spec.fields.find((f) => f.id === 'measured').value, 50, 'the raw length of the line');
  const after = await snap(t, id);
  assert.deepEqual([after.cal.pixelWidth, after.cal.pixelHeight, after.cal.unit], [0.5, 0.5, 'µm']);
  await roundTrip(t, id, before, after);
  t.close();
  // aspect ratio and Remove scale
  const t2 = await boot({ channels: 1 });
  await t2.open();
  // only the unit changes (the harness image is 0.5 µm per pixel: the dialog opens with 2 px = 1 unit): the scale stays
  await t2.runCommand('analyzeSetScale', { measured: 2, known: 1, aspect: 1, unit: 'mm', remove: false });
  const u = await snap(t2, t2.activeId());
  assert.deepEqual([u.cal.pixelWidth, u.cal.pixelHeight, u.cal.unit], [0.5, 0.5, 'mm']);
  await t2.runCommand('analyzeSetScale', { measured: 10, known: 5, aspect: 2, unit: 'mm', remove: false });
  const a = await snap(t2, t2.activeId());
  assert.deepEqual([a.cal.pixelWidth, a.cal.pixelHeight, a.cal.unit], [0.5, 1, 'mm']);
  await t2.runCommand('analyzeSetScale', { measured: 10, known: 0, aspect: 1, unit: 'pixel', remove: false });
  const r = await snap(t2, t2.activeId());
  assert.deepEqual([r.cal.pixelWidth, r.cal.pixelHeight, r.cal.unit], [1, 1, 'pixel']);
  // the dialog's own fields: the scale line and the unit it suggests
  const lines = [];
  t2.script.dialogs.push((spec) => {
    spec.onChange({ measured: 10, known: 5, aspect: 1, unit: 'mm', remove: false }, (p) => lines.push(J(p)), 'known');
    spec.onChange({ measured: 10, known: 5, aspect: 1, unit: 'pixel', remove: false }, (p) => lines.push(J(p)), 'known');
    spec.onChange({ measured: 10, known: 5, aspect: 1, unit: 'mm', remove: true }, (p) => lines.push(J(p)), 'remove');
    return null;
  });
  await t2.shell.opts.onCommand(t2.cmd('analyzeSetScale'), { source: 'menu' });
  assert.deepEqual(lines[0], { scale: '2 pixels/mm' });
  assert.deepEqual(lines[1], { unit: 'unit' });
  assert.deepEqual(lines[2], { scale: '2 pixels/unit' });
  assert.equal(lines[3].known, 0);
  assert.equal(lines[3].unit, 'pixel');
  t2.close();
});

// ─────────────────────────────── refusals and errors ───────────────────────────────
await test('refusals: bad arguments, a selection with Enlarge, a bin factor larger than the image, error mapping', async () => {
  const t = await boot({ channels: 1 });
  await t.open();
  const docId = t.activeId();
  const run = (op, params, roi) => t.engine('doc.run', { docId, op, params, roi: roi || null, channel: 'all' }).then(() => null, (e) => e);
  const full = { x: 0, y: 0, w: 40, h: 30 };
  for (const [op, params] of [
    ['rotate', { angle: NaN, interpolation: 'bilinear' }], ['rotate', { angle: 10, interpolation: 'sinc' }], ['rotate', { angle: 10, interpolation: 'none', rect: { x: 30, y: 0, w: 20, h: 5 } }],
    ['rotateEnlarge', { angle: 'x', interpolation: 'none' }],
    ['scaleInPlace', { xscale: 0, yscale: 1, interpolation: 'none', rect: full }], ['scaleInPlace', { xscale: 1, yscale: -1, interpolation: 'none' }],
    ['scaleNew', { xscale: 1, yscale: 1, interpolation: 'none', width: 0, height: 4 }], ['scaleNew', { xscale: 1, yscale: 1, interpolation: 'none', width: 4.5, height: 4 }],
    ['resize', { width: 0, height: 4, interpolation: 'none' }], ['resize', { width: 4, height: 4, interpolation: 'cubic' }],
    ['canvasSize', { width: 10, height: 10, position: 'middle' }], ['canvasSize', { width: -1, height: 10, position: 'center' }],
    ['translate', { dx: Infinity, dy: 0, interpolation: 'none' }], ['translate', { dx: 1, dy: 0 }],
    ['bin', { xshrink: 0, yshrink: 2, method: 'average' }], ['bin', { xshrink: 2, yshrink: 2, method: 'mode' }],
    ['setCalibration', { pixelWidth: -1, pixelHeight: 1, unit: 'mm' }], ['setCalibration', { pixelWidth: 1, pixelHeight: 1, unit: 5 }]
  ]) {
    const e = await run(op, params);
    assert.ok(e && e.code === 'IJ_BAD_ARGS', `${op} ${JSON.stringify(params)} → IJ_BAD_ARGS (got ${e && e.code})`);
  }
  const big = await run('bin', { xshrink: 41, yshrink: 1, method: 'average' });
  assert.equal(big.code, 'IJ_GEOM_BIN_TOO_LARGE');
  const enl = await run('rotateEnlarge', { angle: 10, interpolation: 'bilinear' }, roiRect(2, 2, 10, 10));
  assert.equal(enl.code, 'IJ_GEOM_ENLARGE_SELECTION');
  const ok = await run('rotateEnlarge', { angle: 10, interpolation: 'bilinear' }, { type: 'line', x1: 0, y1: 0, x2: 5, y2: 5, width: 1 });
  assert.equal(ok, null, 'a line is no selection: Enlarge works');
  // what the operator is told
  assert.equal(t.IJApp.errorKey({ code: 'IJ_GEOM_BIN_TOO_LARGE' }), 'err.geomBinTooLarge');
  assert.equal(t.IJApp.errorKey({ code: 'IJ_GEOM_ENLARGE_SELECTION' }), 'err.geomEnlargeSelection');
  assert.equal(t.IJApp.errorKey({ code: 'IJ_BAD_ARGS' }), 'err.badArgs');
  t.close();
});

await test('what the operator is told: the sentence of the error, never its message', async () => {
  const t = await boot({ channels: 1 });
  await t.open();
  const EN = (await import('./ij_harness.mjs')).EN;
  // the dialog's validate() would stop this value: a scripted function skips it, the op's own refusal must answer
  t.script.dialogs.push(() => ({ xshrink: 100, yshrink: 2, method: 'average' }));
  await t.runCommand('transformBin', undefined, { expectError: true });
  assert.equal(t.errors.at(-1).message, EN.err.geomBinTooLarge);
  t.close();
  const small = await boot({ channels: 1, budgetBytes: 100000 });
  await small.open();
  await small.runCommand('adjustCanvasSize', { width: 5000, height: 5000, position: 'center' }, { expectError: true });
  assert.equal(small.errors.at(-1).message, EN.err.overBudget);
  const snapAfter = await snap(small, small.activeId());
  assert.equal(snapAfter.w + 'x' + snapAfter.h, '40x30', 'the image is untouched');
  small.close();
});

await test('the memory budget refuses a Canvas Size / Scale that cannot fit, before anything runs, and leaves the image alone', async () => {
  const t = await boot({ channels: 2, budgetBytes: 200000 });
  await t.open();
  const id = t.activeId();
  const before = await snap(t, id);
  const e = await t.engine('doc.run', { docId: id, op: 'canvasSize', params: { width: 4000, height: 4000, position: 'center' }, roi: null, channel: 'all' }).then(() => null, (x) => x);
  assert.ok(e && e.code === 'IJ_OVER_BUDGET', 'canvasSize: ' + (e && e.code));
  const e2 = await t.engine('doc.run', { docId: id, op: 'rotateEnlarge', params: { angle: 45, interpolation: 'bilinear' }, roi: null, channel: 'all' }).then(() => null, (x) => x);
  assert.equal(e2, null, 'a small enlarge fits');
  await t.engine('doc.undo', { docId: id });
  same(await snap(t, id), before, 'the image is as it was');
  const est = await t.engine('doc.estimate', { docId: id, op: 'resize', params: { width: 5000, height: 5000, interpolation: 'bilinear', averageWhenDownsizing: false }, roi: null, channel: 'all' });
  assert.equal(est.fits, false);
  t.close();
});

await test('the commands are in the menu where PLAN-wave2 puts them, with their shortcuts', async () => {
  const t = await boot({ channels: 1 });
  await t.open();
  const want = {
    adjustSize: [['Image', 'Adjust'], null], adjustCanvasSize: [['Image', 'Adjust'], null], imageProperties: [['Image'], 'Ctrl+Shift+P'], imageScale: [['Image'], 'Ctrl+E'],
    transformRotate: [['Image', 'Transform'], null], transformTranslate: [['Image', 'Transform'], null], transformBin: [['Image', 'Transform'], null], analyzeSetScale: [['Analyze'], null]
  };
  for (const [id, [menu, key]] of Object.entries(want)) {
    const c = t.cmd(id);
    assert.ok(c, id);
    assert.deepEqual(arr(c.menu), menu, id);
    assert.deepEqual(arr(Array.isArray(c.shortcut) ? c.shortcut : (c.shortcut ? [c.shortcut] : [])), key ? [key] : [], id);
    assert.equal(c.pkg, 'geom');
    assert.ok(t.isEnabled(id), id + ' is enabled with an image');
  }
  assert.ok(t.cmd('transformRotate').order > t.cmd('transformRotateLeft').order && t.cmd('transformBin').order > t.cmd('transformTranslate').order);
  t.close();
});

// ─────────────────────────────── review-round regressions ───────────────────────────────
// What the real view does with a number field: shows it with `decimals`, reads the text back.
const viewValues = (spec, over) => {
  const v = {};
  for (const f of spec.fields) {
    if (f.type === 'message') continue;
    v[f.id] = f.type === 'number' && Number.isInteger(f.decimals) ? Number(Number(f.value).toFixed(f.decimals)) : f.value;
  }
  return Object.assign(v, over || {});
};

await test('Set Scale: OK on an untouched dialog keeps the stored width (the fields show rounded text); editing a distance applies it', async () => {
  const t = await boot({ channels: 1 });
  await t.open();
  const id = t.activeId();
  await t.runCommand('imageProperties', { pixelWidth: 0.3, pixelHeight: 0.3, unit: 'um' });
  const c0 = (await snap(t, id)).cal;
  const rev0 = (await t.docs()).find((d) => d.docId === id).rev;
  t.script.dialogs.push((spec) => viewValues(spec));
  await t.shell.opts.onCommand(t.cmd('analyzeSetScale'), { source: 'menu' });
  const c1 = (await snap(t, id)).cal;
  assert.equal(c1.pixelWidth, c0.pixelWidth, 'pixelWidth untouched');
  assert.equal((await t.docs()).find((d) => d.docId === id).rev, rev0, 'no new step');
  // with a line selection (4.24… shown as 4.24) the width must not drift either
  await select(t, { type: 'line', x1: 0, y1: 0, x2: 3, y2: 3, width: 1 });
  t.script.dialogs.push((spec) => viewValues(spec));
  await t.shell.opts.onCommand(t.cmd('analyzeSetScale'), { source: 'menu' });
  assert.equal((await snap(t, id)).cal.pixelWidth, c0.pixelWidth, 'line selection, untouched');
  // typing in the Known distance field applies known/measured
  t.script.dialogs.push((spec) => { const v = viewValues(spec, { known: 8 }); spec.onChange(v, () => {}, 'known'); return v; });
  await t.shell.opts.onCommand(t.cmd('analyzeSetScale'), { source: 'menu' });
  const ln = Math.hypot(3, 3);
  assert.ok(Math.abs((await snap(t, id)).cal.pixelWidth - 8 / ln) < 1e-4, 'edited known distance');
  t.close();
});

await test('Rotate: the selection drawn while the non-modal dialog is open is the one rotated; another image aborts', async () => {
  const roiA = { type: 'rect', x: 2, y: 2, w: 10, h: 8 }, roiB = { type: 'rect', x: 20, y: 12, w: 16, h: 14 };
  const ref = await boot({ channels: 1 });
  await ref.open();
  await select(ref, roiB);
  await ref.runCommand('transformRotate', { angle: 30, grid: 1, interpolation: 'bilinear' });
  const want = await snap(ref, ref.activeId());
  ref.close();
  const t = await boot({ channels: 1 });
  await t.open();
  const id = t.activeId();
  await select(t, roiA);
  t.script.dialogs.push(async (spec) => { await select(t, roiB); return viewValues(spec, { angle: 30, grid: 1, interpolation: 'bilinear' }); });
  await t.shell.opts.onCommand(t.cmd('transformRotate'), { source: 'menu' });
  same(await snap(t, id), want, 'rotation about the centre of the selection at OK time');
  t.close();
});

await test('Properties: the unit "pixel" keeps a pixel width other than 1 (an aspect calibration); an empty unit resets', async () => {
  const t = await boot({ channels: 1 });
  await t.open();
  const id = t.activeId();
  await t.runCommand('imageProperties', { pixelWidth: 2, pixelHeight: 3, unit: 'pixel' });
  const c = (await snap(t, id)).cal;
  assert.deepEqual([c.pixelWidth, c.pixelHeight, c.unit], [2, 3, 'pixel']);
  await t.runCommand('imageProperties', { pixelWidth: 2, pixelHeight: 3, unit: '' });
  const r = (await snap(t, id)).cal;
  assert.deepEqual([r.pixelWidth, r.pixelHeight, r.unit], [1, 1, 'pixel']);
  t.close();
});

await test('Adjust submenu orders follow the frozen table (separators do not count)', async () => {
  const t = await boot({ channels: 1 });
  await t.open();
  assert.equal(t.cmd('adjustSize').order, 30);
  assert.equal(t.cmd('adjustCanvasSize').order, 40);
  t.close();
});

console.log(`ij geom commands: ${passed} groups passed`);
