// Package edit (wave 3), end to end through the real controller and the real engine (tests/js/ij_harness.mjs):
//   File > New > Image / Internal Clipboard / System Clipboard, File > Close All, File > Import > LUT…, File > Save As > LUT…,
//   Edit > Cut / Copy / Copy to System / Paste / Paste Control… / Draw, Edit > Options > Appearance… / Colors… / Conversions… / Misc…,
//   Image > Duplicate…, Image > Color > Invert LUTs / Show LUT, Image > Stacks > Make Montage…, Image > Lookup Tables > 3-3-2 RGB / Red/Green,
//   and the consumers of the Options (Fill / Clear / Draw colours, the divide-by-zero value of Image Calculator and Paste).
// The numbers behind the operations are checked against ImageJ 1.54p in test_ij_edit_fixtures.mjs; here: the menu rows, the dialogs (fields,
// defaults, what is remembered), the floating paste (the clipboard posted to the worker once, preview, commit on the next command, Escape),
// undo / redo / reload of every step, refusals and the error keys, determinism and "no write into the inputs" (the harness runs the engine
// with verifyInputs).
//
// Run: node tests/js/test_ij_edit_commands.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { boot, until, sleep, J, DIR, langPart } from './ij_harness.mjs';

const arr = (x) => Array.from(x);
const eq = (a, b, m) => assert.deepEqual(J(a), J(b), m || 'values differ');
const setRoi = (t, roi, final = true) => t.shell.opts.onRoi(roi, { final, source: 'draw' });
const activeRoi = (t) => t.shell.activeRoi;
const lastSpec = (t) => t.log.dialogSpecs[t.log.dialogSpecs.length - 1];
const field = (spec, id) => spec.fields.find((f) => f.id === id);
const idOf = (t) => t.activeId();

let n = 0;
async function test(name, fn) { await fn(); n++; console.log('  ok  ' + name); }
const fresh = async (o) => { const t = await boot(Object.assign({ channels: 3 }, o || {})); await t.open(); return t; };
// Boots a new page on the same storage and restores every stored session: { docs, pixels(docId, c), close() }
async function reloaded(t) {
  await t.flush();
  const keys = (await t.store.shared.list()).map((x) => x.key);
  const t2 = await t.reload();
  const w2 = await t2.spawn();
  const warnings = [];
  for (const key of keys) { const r = await t2.engine('session.restore', { key }, w2); warnings.push(...r.warnings); }
  const docs = (await t2.engine('doc.list', {}, w2)).docs;
  return { docs, warnings, pixels: async (docId, c) => (await t2.engine('doc.tile', { docId, channel: c, level: 0, tx: 0, ty: 0 }, w2)).data.slice(), close: () => t2.close() };
}
const part = langPart('edit');

await test('menu rows, shortcuts and labels: ImageJ\'s order, the Fiji / ImageJ text verbatim', async () => {
  const t = await fresh();
  const want = {
    fileNewImage: [['File', 'New'], 10, 'n'], fileNewInternalClipboard: [['File', 'New'], 20, null], fileNewSystemClipboard: [['File', 'New'], 30, 'Shift+V'],
    fileCloseAll: [['File'], 22, null], fileImportLut: [['File', 'Import'], 10, null], fileSaveLut: [['File', 'SaveAs'], 22, null],
    editCut: [['Edit'], 22, 'Ctrl+X'], editCopy: [['Edit'], 24, 'Ctrl+C'], editCopyToSystem: [['Edit'], 26, null], editPaste: [['Edit'], 27, 'Ctrl+V'],
    editPasteControl: [['Edit'], 28, null], editDraw: [['Edit'], 55, 'd'],
    optAppearance: [['Edit', 'Options'], 10, null], optColors: [['Edit', 'Options'], 30, null], optConversions: [['Edit', 'Options'], 50, null], optMisc: [['Edit', 'Options'], 110, null],
    colorInvertLuts: [['Image', 'Color'], 35, null], colorShowLut: [['Image', 'Color'], 60, null], stackMontage: [['Image', 'Stacks'], 10, null],
    lut332RGB: [['Image', 'LookupTables'], 70, null], lutRedGreen: [['Image', 'LookupTables'], 140, null]
  };
  for (const [id, [menu, order, key]] of Object.entries(want)) {
    const c = t.cmd(id);
    assert.ok(c, id);
    eq(c.menu, menu, id + ' menu');
    assert.equal(c.order, order, id + ' order');
    eq([].concat(c.shortcut || []), key ? [key] : [], id + ' shortcut');
    assert.ok(c.repeatable !== false, id + ' is repeatable');
  }
  assert.equal(!!t.cmd('editCut').separatorBefore, true, 'a separator before Cut');
  assert.equal(!!t.cmd('colorShowLut').separatorBefore, true, 'a separator before Show LUT');
  assert.equal(t.cmd('imageRename').order, 95, 'Rename moved to its ImageJ place, after Duplicate (90)');
  assert.ok(t.cmd('imageDuplicate').order < t.cmd('imageRename').order);
  eq(part.en.cmd, { fileNewImage: 'Image…', fileNewInternalClipboard: 'Internal Clipboard', fileNewSystemClipboard: 'System Clipboard', fileCloseAll: 'Close All', fileImportLut: 'LUT…', fileSaveLut: 'LUT…',
    editCut: 'Cut', editCopy: 'Copy', editCopyToSystem: 'Copy to System', editPaste: 'Paste', editPasteControl: 'Paste Control…', editDraw: 'Draw', optAppearance: 'Appearance…', optColors: 'Colors…',
    optConversions: 'Conversions…', optMisc: 'Misc…', colorInvertLuts: 'Invert LUTs', colorShowLut: 'Show LUT', stackMontage: 'Make Montage…', lut332RGB: '3-3-2 RGB', lutRedGreen: 'Red/Green' });
  // the four languages carry the same keys, and every {token} survives
  const keys = (o, p = '') => Object.entries(o).flatMap(([k, v]) => (typeof v === 'object' ? keys(v, p + k + '.') : [p + k]));
  const get = (o, k) => k.split('.').reduce((a, c) => a[c], o);
  for (const l of ['fr', 'es', 'nl']) {
    eq(keys(part[l]).sort(), keys(part.en).sort(), l + ' key set');
    for (const k of keys(part.en)) {
      assert.ok(String(get(part[l], k)).trim().length > 0, l + ':' + k);
      assert.equal((String(get(part[l], k)).match(/\{\w+\}/g) || []).sort().join(), (String(get(part.en, k)).match(/\{\w+\}/g) || []).sort().join(), l + ':' + k + ' tokens');
    }
  }
  t.close();
});

await test('enabled(): Cut needs an area selection, Draw any selection, Montage several channels, Close All an image; Options need nothing', async () => {
  const t = await fresh();
  setRoi(t, null);
  eq(['editCut', 'editDraw', 'editCopy', 'editPaste', 'stackMontage', 'fileCloseAll', 'optColors'].map((id) => !!t.isEnabled(id)), [false, false, true, true, true, true, true]);
  setRoi(t, { type: 'rect', x: 2, y: 2, w: 6, h: 5 });
  eq(['editCut', 'editDraw'].map((id) => !!t.isEnabled(id)), [true, true]);
  setRoi(t, { type: 'line', x1: 1, y1: 1, x2: 9, y2: 9 });
  eq(['editCut', 'editDraw'].map((id) => !!t.isEnabled(id)), [false, true], 'Cut: "This command requires an area selection"; Draw draws a line');
  t.close();
});

// ═════════════════════════════════════════ Duplicate ═════════════════════════════════════════
await test('Duplicate (several channels): Title and Channels (c): — no Ignore selection (showHSDialog); the bounding box, the selection moves to 0,0, a copy of a copy keeps counting', async () => {
  const t = await fresh();
  const api = t.api(null);
  const srcName = api.state().doc.name;
  setRoi(t, null);
  await t.runCommand('imageDuplicate');
  let spec = lastSpec(t);
  eq(spec.fields.map((f) => f.id), ['title', 'channels'], 'no selection: Title and Channels (c): only');
  assert.equal(field(spec, 'title').value, srcName + '-1', 'WindowManager.getUniqueName: "-1" appended');
  assert.equal(field(spec, 'channels').value, '1-3');
  let docs = await t.docs();
  assert.equal(docs.length, 2, 'the copy is a new image');
  const copy = docs.find((d) => d.name === srcName + '-1');
  assert.ok(copy && copy.width === 40 && copy.height === 30 && copy.channels.length === 3);
  // the copy of the copy: "x-1" made by Duplicate loses its -1 and takes the next free number
  await t.runCommand('imageDuplicate');
  assert.equal(field(lastSpec(t), 'title').value, srcName + '-2', 'the unique title counts on from the duplicate');
  // the first image is the one to work on again
  const src = (await t.docs()).find((d) => d.name === srcName);
  const back = () => t.layout().activate(src.docId);
  back();
  const px = await t.pixels(src.docId, 1);
  setRoi(t, { type: 'oval', x: 6, y: 5, w: 12, h: 10 });
  await t.runCommand('imageDuplicate', { title: 'oval copy', channels: '2-3' });
  spec = lastSpec(t);
  eq(spec.fields.map((f) => f.id), ['title', 'channels'], 'a multichannel image: showHSDialog has no Ignore selection');
  assert.equal(spec.title, 'Duplicate', 'the title of the hyperstack dialog has no ellipsis');
  const oc = (await t.docs()).find((d) => d.name === 'oval copy');
  assert.ok(oc && oc.width === 12 && oc.height === 10 && oc.channels.length === 2, 'the bounding box of the selection, channels 2 and 3');
  assert.equal(oc.channels[0].name, src.channels[1].name, 'the channels keep their names');
  const got = await t.pixels(oc.docId, 0);
  for (let y = 0; y < 10; y++) for (let x = 0; x < 12; x++) assert.equal(got[y * 12 + x], px[(5 + y) * 40 + 6 + x], 'pixel ' + x + ',' + y + ' of the copy');
  const sel = activeRoi(t);
  assert.ok(sel && sel.type === 'oval' && sel.x === 0 && sel.y === 0, 'the copy carries the selection moved to 0,0: ' + JSON.stringify(sel));
  // a rectangle: cropped, no selection on the copy
  back();
  setRoi(t, { type: 'rect', x: 4, y: 4, w: 10, h: 6 });
  await t.runCommand('imageDuplicate', { title: 'rectcopy' });
  const rc = (await t.docs()).find((d) => d.name === 'rectcopy');
  assert.ok(rc.width === 10 && rc.height === 6);
  assert.equal(activeRoi(t), null, 'a rectangle needs no selection on the copy');
  // a selection wholly outside the image is ignored (and the checkbox is not offered)
  back();
  setRoi(t, { type: 'rect', x: 100, y: 100, w: 5, h: 5 });
  await t.runCommand('imageDuplicate', { title: 'outside' });
  eq(lastSpec(t).fields.map((f) => f.id), ['title', 'channels']);
  assert.equal((await t.docs()).find((d) => d.name === 'outside').width, 40);
  // "Channels (c):" read as ImageJ reads it: "3" is channel 3 only, "1,3" channel 1, "3-1" everything
  back();
  setRoi(t, null);
  await t.runCommand('imageDuplicate', { title: 'c3', channels: '3' });
  assert.equal((await t.docs()).find((d) => d.name === 'c3').channels.length, 1);
  back();
  await t.runCommand('imageDuplicate', { title: 'c13', channels: '1,3' });
  assert.equal((await t.docs()).find((d) => d.name === 'c13').channels.length, 1);
  back();
  await t.runCommand('imageDuplicate', { title: 'c31', channels: '3-1' });
  assert.equal((await t.docs()).find((d) => d.name === 'c31').channels.length, 3);
  // a duplicate survives a reload (it has its own baseline)
  const r = await reloaded(t);
  assert.equal(r.warnings.length, 0, JSON.stringify(r.warnings));
  assert.ok(r.docs.some((d) => d.name === 'oval copy'));
  r.close();
});

await test('Duplicate… (one channel): Ignore selection for ANY selection, remembered; an empty Channels (c): text is refused with a message, not a throw', async () => {
  const t = await fresh({ channels: 1 });
  const srcName = t.api(null).state().doc.name;
  setRoi(t, { type: 'rect', x: 3, y: 3, w: 9, h: 7 });
  await t.runCommand('imageDuplicate', { title: 'whole', ignore: true });
  let spec = lastSpec(t);
  eq(spec.fields.map((f) => f.id), ['title', 'ignore']);
  assert.equal(spec.title, 'Duplicate…');
  const wh = (await t.docs()).find((d) => d.name === 'whole');
  assert.ok(wh.width === 40 && wh.height === 30, 'a selection that is ignored does not crop');
  const r2 = activeRoi(t);
  assert.ok(r2 && r2.type === 'rect' && r2.x === 3 && r2.w === 9, 'the original selection is carried at its place');
  const src = (await t.docs()).find((d) => d.name === srcName);
  t.layout().activate(src.docId);
  setRoi(t, { type: 'rect', x: 3, y: 3, w: 9, h: 7 });
  await t.runCommand('imageDuplicate', { title: 'again' });
  assert.equal(field(lastSpec(t), 'ignore').value, true, 'Duplicator keeps staticIgnoreSelection');
  // the selection of the image is a line: still offered
  t.layout().activate(src.docId);
  setRoi(t, { type: 'line', x1: 1, y1: 1, x2: 9, y2: 9 });
  await t.runCommand('imageDuplicate', { title: 'line' });
  eq(lastSpec(t).fields.map((f) => f.id), ['title', 'ignore'], 'any selection offers Ignore selection');
  // a selection outside the image: the field is still shown, on the remembered value (1.54p overwrites the roiOutside tick), and the copy is whole
  t.layout().activate(src.docId);
  setRoi(t, { type: 'rect', x: 2, y: 2, w: 9, h: 7 });
  await t.runCommand('imageDuplicate', { title: 'unticked', ignore: false });
  t.layout().activate(src.docId);
  setRoi(t, { type: 'rect', x: 500, y: 500, w: 9, h: 7 });
  await t.runCommand('imageDuplicate', { title: 'outside' });
  const fo = lastSpec(t).fields;
  eq(fo.map((f) => f.id), ['title', 'ignore'], 'an outside selection still offers Ignore selection');
  assert.equal(fo.find((f) => f.id === 'ignore').value, false, 'on the remembered value, not forced on');
  assert.equal((await t.docs()).find((d) => d.name === 'outside').width, src.width, 'an outside selection is ignored, ticked or not');
  t.close();
  // several channels: an empty Channels (c): text is refused by the dialog's validate with a translated key
  const t3 = await fresh();
  let refused = null;
  t3.script.dialogs.push((s) => { refused = s.validate({ title: 'x', channels: '  ' }); return { title: 'ok copy', channels: '1-2' }; });
  await t3.runCommand('imageDuplicate');
  eq(refused, { channels: 'dlg.dupChannelsEmpty' });
  assert.ok((await t3.docs()).some((d) => d.name === 'ok copy'));
  t3.close();
});

// ═══════════════════════════════════ Copy, Cut, Paste ═══════════════════════════════════
await test('Copy then Paste: the clipboard is the active channel\'s bounding box; Paste floats, shows a preview and is committed by the next command (one undo step)', async () => {
  const t = await fresh();
  const id = idOf(t);
  const before = await t.pixels(id, 0);
  const before1 = await t.pixels(id, 1);
  setRoi(t, { type: 'rect', x: 5, y: 4, w: 8, h: 6 });
  await t.runCommand('editCopy');
  setRoi(t, null);
  const posted0 = t.log.msgs.filter((m) => m.cmd === 'engine.putBlob').length;
  await t.runCommand('editPaste');
  // ImagePlus.paste: no selection and the clipboard smaller than the image: centred on the visible area (here the whole 40 x 30 image)
  eq(activeRoi(t), { type: 'rect', x: 16, y: 12, w: 8, h: 6 });
  assert.equal(t.log.msgs.filter((m) => m.cmd === 'engine.putBlob').length, posted0 + 1, 'the clipboard goes to the worker once');
  await until(() => t.view(id).preview, 'a floating paste previews');
  const pv = t.log.msgs.filter((m) => m.cmd === 'doc.preview' && m.args.op === 'paste');
  assert.ok(pv.length >= 1);
  assert.ok(pv.every((m) => m.args.params.data && m.args.params.data.blobRef && !ArrayBuffer.isView(m.args.params.data)), 'a preview carries the blobRef, never the pixels');
  // the selection is dragged: only x and y change, nothing is posted again
  setRoi(t, { type: 'rect', x: 20, y: 10, w: 8, h: 6 }, false);
  setRoi(t, { type: 'rect', x: 22, y: 11, w: 8, h: 6 }, true);
  await until(() => t.log.msgs.some((m) => m.cmd === 'doc.preview' && m.args.op === 'paste' && m.args.params.x === 22), 'the preview follows the selection');
  assert.equal(t.log.msgs.filter((m) => m.cmd === 'engine.putBlob').length, posted0 + 1, 'moving the selection does not post the clipboard again');
  // nothing is changed yet
  eq(arr(await t.pixels(id, 0)), arr(before));
  // another command commits first
  await t.runCommand('editSelectAll');
  const after = await t.pixels(id, 0);
  const want = arr(before);
  for (let y = 0; y < 6; y++) for (let x = 0; x < 8; x++) want[(11 + y) * 40 + 22 + x] = before[(4 + y) * 40 + 5 + x];
  eq(arr(after), want, 'the clipboard sits at the selection\'s place');
  eq(arr(await t.pixels(id, 1)), arr(before1), 'only the active channel changes');
  // one undo step
  await t.runCommand('editUndo');
  eq(arr(await t.pixels(id, 0)), arr(before));
  await t.runCommand('editRedo');
  eq(arr(await t.pixels(id, 0)), want);
  // a reload replays the paste from the journal (the blob is stored once with the document)
  const r = await reloaded(t);
  assert.equal(r.warnings.length, 0, JSON.stringify(r.warnings));
  const d2 = r.docs.find((d) => d.docId === id);
  eq(arr(await r.pixels(d2.docId, 0)), want, 'replayed after a reload');
  r.close();
});

await test('Paste: a selection of the clipboard\'s size takes it in place; Escape cancels; Enter commits; deselecting commits', async () => {
  const t = await fresh();
  const id = idOf(t);
  const before = await t.pixels(id, 0);
  setRoi(t, { type: 'rect', x: 5, y: 4, w: 8, h: 6 });
  await t.runCommand('editCopy');
  setRoi(t, { type: 'rect', x: 30, y: 20, w: 8, h: 6 });
  await t.runCommand('editPaste');
  eq(activeRoi(t), { type: 'rect', x: 30, y: 20, w: 8, h: 6 }, 'in place');
  const key = (k) => t.root.children.find((c) => c.listeners && c.listeners.keydown).listeners.keydown.forEach((f) => f({ key: k, target: { tagName: 'DIV' }, preventDefault() {}, stopPropagation() {} }));
  // Escape = Roi.abortPaste: the image as it was, the selection stays
  key('Escape');
  await sleep(60);
  eq(arr(await t.pixels(id, 0)), arr(before));
  assert.ok(activeRoi(t), 'the selection stays');
  // paste again and press Enter
  await t.runCommand('editPaste');
  key('Enter');
  await until(async () => arr(await t.pixels(id, 0)).join() !== arr(before).join(), 'Enter commits the paste');
  await until(() => t.isEnabled('editUndo'), 'the committed paste is an undo step');
  await t.runCommand('editUndo');
  eq(arr(await t.pixels(id, 0)), arr(before));
  // deselecting (a click outside) lands the paste where it is
  await t.runCommand('editPaste');
  setRoi(t, null);
  await until(async () => arr(await t.pixels(id, 0)).join() !== arr(before).join(), 'deselecting commits the paste');
  await until(() => t.isEnabled('editUndo'), 'the committed paste is an undo step');
  t.close();
});

await test('Paste Control…: the transfer mode panel changes what Paste does (Add on 8 bits saturates), and keeps its choice', async () => {
  const t = await fresh();
  const id = idOf(t);
  const before = await t.pixels(id, 0);
  setRoi(t, { type: 'rect', x: 5, y: 4, w: 8, h: 6 });
  await t.runCommand('editCopy');
  await t.runCommand('editPasteControl');
  assert.ok(t.shell.windows.floats.has('pasteControl'), 'a tool window');
  assert.equal(t.settings.get('edit.pasteMode'), undefined, 'not stored in the preferences');
  const el = t.panel('pasteControl');
  assert.ok(el);
  const walk = (e, f) => { f(e); for (const c of e.children || []) walk(c, f); };
  let sel = null; walk(el, (e) => { if (e.tagName === 'SELECT') sel = e; });
  assert.ok(sel, 'a Transfer Mode select');
  eq(sel.children.map((o) => o.value), ['copy', 'blend', 'difference', 'transparent-white', 'transparent-zero', 'and', 'or', 'xor', 'add', 'subtract', 'multiply', 'divide', 'min', 'max']);
  // PasteController.itemStateChanged: Roi.setPasteMode(mode)
  sel.value = 'add'; for (const f of sel.listeners.change || []) f({ target: sel });
  // the mode is the session's, not a preference: Edit > Paste keeps it until the panel is built again (Roi.pasteMode is static)
  setRoi(t, { type: 'rect', x: 5, y: 4, w: 8, h: 6 });
  await t.runCommand('editPaste');
  await t.runCommand('editSelectNone');
  const after = await t.pixels(id, 0);
  for (let y = 0; y < 6; y++) for (let x = 0; x < 8; x++) { const v = before[(4 + y) * 40 + 5 + x]; assert.equal(after[(4 + y) * 40 + 5 + x], Math.min(255, v + v), 'Add: dst + src saturating at 255'); }
  t.close();
});

await test('Cut: the selection\'s pixels take the background colour (inside a non-rectangular mask only), the clipboard keeps the mask; Paste puts the shape back', async () => {
  const t = await fresh();
  const id = idOf(t);
  const before = await t.pixels(id, 0);
  const oval = { type: 'oval', x: 10, y: 8, w: 10, h: 8 };
  setRoi(t, oval);
  await t.runCommand('editCut');
  const cut = await t.pixels(id, 0);
  const m = t.page.IJRoi.mask(oval, 40, 30);
  for (let y = 0; y < 30; y++) for (let x = 0; x < 40; x++) {
    const inside = x >= m.x && y >= m.y && x < m.x + m.w && y < m.y + m.h && m.data[(y - m.y) * m.w + x - m.x];
    assert.equal(cut[y * 40 + x], inside ? 0 : before[y * 40 + x], 'cut pixel ' + x + ',' + y);
  }
  // Paste at another place: a selection of the clipboard's size is the place AND the mask (ImagePlus.paste keeps the selection, Roi.updatePaste
  // masks with it): a rectangle takes the whole bounding box of the clipboard and stays a rectangle
  setRoi(t, { type: 'rect', x: 25, y: 15, w: 10, h: 8 });
  await t.runCommand('editPaste');
  const sel = activeRoi(t);
  assert.ok(sel.type === 'rect' && sel.x === 25 && sel.y === 15 && sel.w === 10 && sel.h === 8, 'the selection of the same size is kept: ' + JSON.stringify(sel));
  await t.runCommand('editSelectNone');
  const pasted = await t.pixels(id, 0);
  for (let y = 0; y < 8; y++) for (let x = 0; x < 10; x++) assert.equal(pasted[(15 + y) * 40 + 25 + x], before[(8 + y) * 40 + 10 + x], 'pasted pixel ' + x + ',' + y);
  // nowhere to put it: no selection, the clipboard's own shape is the pasted selection and only its pixels are written
  await t.runCommand('editPaste');
  const sel2 = activeRoi(t);
  assert.equal(sel2.type, 'oval', 'no selection: the clipboard shape');
  await t.runCommand('editSelectNone');
  const centred = await t.pixels(id, 0);
  const b2 = t.page.IJRoi.bounds(oval);
  let changed = 0;
  for (let y = 0; y < 30; y++) for (let x = 0; x < 40; x++) if (centred[y * 40 + x] !== pasted[y * 40 + x]) changed++;
  assert.ok(changed > 0 && changed <= b2.w * b2.h, 'only the oval pixels change');
  // Cut is not offered without an area selection
  setRoi(t, { type: 'line', x1: 1, y1: 1, x2: 5, y2: 5 });
  assert.equal(t.isEnabled('editCut'), false);
  t.close();
});

await test('Paste into a selection of the same size: the target shape masks the paste (an oval target takes a rectangle clipboard inside the oval only)', async () => {
  const t = await fresh();
  const id = idOf(t);
  const before = await t.pixels(id, 0);
  setRoi(t, { type: 'rect', x: 2, y: 3, w: 10, h: 8 });
  await t.runCommand('editCopy');
  const oval = { type: 'oval', x: 22, y: 14, w: 10, h: 8 };
  setRoi(t, oval);
  await t.runCommand('editPaste');
  const sel = activeRoi(t);
  assert.ok(sel.type === 'oval' && sel.x === 22 && sel.y === 14, 'the oval selection is kept: ' + JSON.stringify(sel));
  await t.runCommand('editSelectNone');
  const after = await t.pixels(id, 0);
  const m = t.page.IJRoi.mask(oval, 40, 30);
  let inside = 0;
  for (let y = 0; y < 8; y++) for (let x = 0; x < 10; x++) {
    const inOval = m.data[y * m.w + x];
    inside += inOval ? 1 : 0;
    assert.equal(after[(14 + y) * 40 + 22 + x], inOval ? before[(3 + y) * 40 + 2 + x] : before[(14 + y) * 40 + 22 + x], 'pixel ' + x + ',' + y);
  }
  assert.ok(inside > 0 && inside < 80);
  t.close();
});

await test('Cut uses the background colour of Edit > Options > Colors', async () => {
  const t = await fresh();
  const id = idOf(t);
  t.api('edit').settings.set('colors.background', 'white');
  setRoi(t, { type: 'rect', x: 2, y: 2, w: 4, h: 4 });
  await t.runCommand('editCut');
  assert.equal((await t.pixels(id, 0))[2 * 40 + 2], 255);
  t.close();
});

await test('Paste: another bit depth is refused (IJ_EDIT_PASTE_TYPE); an empty internal clipboard goes to the system clipboard (not available here: said so)', async () => {
  const t = await fresh();
  setRoi(t, { type: 'rect', x: 5, y: 4, w: 8, h: 6 });
  await t.runCommand('editCopy');
  await t.runCommand('typeBit16');
  const errs = await t.runCommand('editPaste', undefined, { expectError: true });
  assert.ok(errs.length >= 1, 'an error dialog');
  assert.ok(!t.log.msgs.some((m) => m.cmd === 'doc.preview' && m.args.op === 'paste'), 'nothing floats');
  t.close();
  const t2 = await fresh();
  // Clipboard.paste: "if (ImagePlus.getClipboard()==null) showSystemClipboard();" — no clipboard API in this environment
  assert.ok((await t2.runCommand('editPaste', undefined, { expectError: true })).length >= 1);
  assert.ok((await t2.runCommand('fileNewSystemClipboard', undefined, { expectError: true })).length >= 1);
  assert.ok((await t2.runCommand('editCopyToSystem', undefined, { expectError: true })).length >= 1);
  t2.close();
});

await test('Copy to System during a floating paste: the paste lands before the picture is rendered, and the write starts synchronously', async () => {
  const t = await fresh();
  const id = idOf(t);
  const before = arr(await t.pixels(id, 0)).join();
  setRoi(t, { type: 'rect', x: 5, y: 4, w: 8, h: 6 });
  await t.runCommand('editCopy');
  setRoi(t, { type: 'rect', x: 30, y: 20, w: 8, h: 6 });
  await t.runCommand('editPaste');
  assert.equal(arr(await t.pixels(id, 0)).join(), before, 'still floating');
  let atRender = null, started = false;
  t.page.ClipboardItem = function (o) { this.png = o['image/png']; };
  t.page.navigator.clipboard = { write: async ([item]) => { started = true; await item.png.catch(() => {}); atRender = arr(await t.pixels(id, 0)).join(); } };
  await t.runCommand('editCopyToSystem');
  assert.ok(started, 'the clipboard write was called');
  assert.notEqual(atRender, before, 'the floating paste had landed by the time the picture was produced');
  t.close();
});

await test('A floating paste whose image is closed gives its blobs back to the worker', async () => {
  const t = await fresh();
  const id = idOf(t);
  setRoi(t, { type: 'rect', x: 5, y: 4, w: 8, h: 6 });
  await t.runCommand('editCopy');
  setRoi(t, { type: 'rect', x: 30, y: 20, w: 8, h: 6 });
  await t.runCommand('editPaste');
  t.script.nextAsk = 'discard';
  await t.shell.opts.onCloseImage(id);
  await until(() => t.log.msgs.some((m) => m.cmd === 'engine.dropBlob'), 'the blob is dropped');
  t.close();
});

await test('Internal Clipboard: the clipboard as an image "Clipboard" (a non-rectangular selection is cleared outside); empty = refusal', async () => {
  const t = await fresh();
  assert.ok((await t.runCommand('fileNewInternalClipboard', undefined, { expectError: true })).length >= 1, 'The internal clipboard is empty.');
  const id = idOf(t);
  const src = await t.pixels(id, 0);
  const oval = { type: 'oval', x: 10, y: 8, w: 10, h: 8 };
  setRoi(t, oval);
  await t.runCommand('editCopy');
  await t.runCommand('fileNewInternalClipboard');
  const clip = (await t.docs()).find((d) => d.name === 'Clipboard');
  assert.ok(clip && clip.width === 10 && clip.height === 8 && clip.channels.length === 1 && clip.bitDepth === 8);
  const px = await t.pixels(clip.docId, 0);
  const m = t.page.IJRoi.mask(oval, 40, 30);
  for (let y = 0; y < 8; y++) for (let x = 0; x < 10; x++) assert.equal(px[y * 10 + x], m.data[y * m.w + x] ? src[(8 + y) * 40 + 10 + x] : 0, 'clipboard pixel ' + x + ',' + y);
  await t.runCommand('fileNewInternalClipboard');
  assert.ok((await t.docs()).some((d) => d.name === 'Clipboard-1'), 'a second one is numbered');
  t.close();
});

await test('Paste with no image open shows the internal clipboard as an image', async () => {
  const t = await fresh();
  setRoi(t, { type: 'rect', x: 5, y: 4, w: 8, h: 6 });
  await t.runCommand('editCopy');
  await t.runCommand('fileCloseAll');
  assert.equal((await t.docs()).length, 0);
  await t.runCommand('editPaste');
  const d = await t.docs();
  assert.equal(d.length, 1); assert.equal(d[0].name, 'Clipboard'); assert.equal(d[0].width, 8);
  t.close();
});

// ═════════════════════════════════════════ Draw ═════════════════════════════════════════
await test('Draw: the selection\'s outline in the foreground colour, widths from the selection and from the tool; undo and a reload', async () => {
  const t = await fresh({ channels: 2 });
  const id = idOf(t);
  const before = await t.pixels(id, 0);
  const E = t.page.IJEdit;
  const rect = { type: 'rect', x: 6, y: 5, w: 15, h: 11 };
  setRoi(t, rect);
  await t.runCommand('editDraw');
  const want = E.drawRoi(before, 40, 30, 8, rect, 255, 1, 1);
  eq(arr(await t.pixels(id, 0)), arr(want), 'foreground white = 255 on 8 bits');
  const kept = t.api(null).state().roi;
  assert.ok(kept && kept.type === 'rect', 'the selection stays, as in ImageJ');
  await t.runCommand('editUndo');
  eq(arr(await t.pixels(id, 0)), arr(before));
  await t.runCommand('editRedo');
  eq(arr(await t.pixels(id, 0)), arr(want));
  // a polygon with another foreground colour
  t.api('edit').settings.set('colors.foreground', 'gray');
  const poly = { type: 'polygon', points: [[5, 5], [30, 8], [25, 25], [8, 20]] };
  setRoi(t, poly);
  await t.runCommand('editDraw');
  const gv = t.api(null).colorValue(id, 0, 'foreground');
  assert.ok(gv > 0 && gv < 255, 'gray on a red table: the nearest entry of the LUT (getBestIndex) ' + gv);
  const w2 = E.drawRoi(want, 40, 30, 8, poly, gv, 1, 1);
  eq(arr(await t.pixels(id, 0)), arr(w2));
  // a wide line selection: the line width of the selection
  const line = { type: 'line', x1: 4, y1: 25, x2: 35, y2: 6, width: 3 };
  setRoi(t, line);
  await t.runCommand('editDraw');
  const w3 = E.drawRoi(w2, 40, 30, 8, line, gv, 3, 1);
  eq(arr(await t.pixels(id, 0)), arr(w3));
  // the journaled params carry the selection, so a reload replays the drawing
  const r = await reloaded(t);
  assert.equal(r.warnings.length, 0, JSON.stringify(r.warnings));
  const d2 = r.docs.find((d) => d.docId === id);
  eq(arr(await r.pixels(d2.docId, 0)), arr(w3), 'replayed after a reload');
  r.close();
});

await test('Draw: on 16 bits the foreground value follows the display range (the setColor of ImageJ: white = the range maximum, not 65535)', async () => {
  const t = await fresh({ channels: 1 });
  const id = idOf(t);
  await t.runCommand('typeBit16');
  const v = t.api(null).colorValue(id, 0, 'foreground');
  const max = t.api(null).state().doc.channels[0].display.max;
  assert.equal(v, max, 'white = the display maximum');
  setRoi(t, { type: 'rect', x: 2, y: 2, w: 6, h: 6 });
  await t.runCommand('editDraw');
  assert.equal((await t.pixels(id, 0))[2 * 40 + 2], v);
  assert.ok(v < 65535);
  t.close();
});

// ═════════════════════════════════════════ New Image ═════════════════════════════════════════
await test('File > New > Image…: Name, Type, Fill with (Black first), Width, Height; the fills, a unique title, the dialog remembers its values', async () => {
  const t = await fresh();
  await t.runCommand('fileNewImage', { width: 512, height: 512 });
  let spec = lastSpec(t);
  eq(spec.fields.map((f) => f.id), ['name', 'type', 'fill', 'width', 'height']);
  assert.equal(field(spec, 'name').value, 'Untitled'); assert.equal(field(spec, 'fill').value, 'black', 'first use: Black (NewImage.staticFillWith = FILL_BLACK)');
  assert.equal(field(spec, 'width').value, 512); assert.equal(field(spec, 'height').value, 512);
  let docs = await t.docs();
  const d0 = docs.find((d) => d.name === 'Untitled');
  assert.ok(d0 && d0.width === 512 && d0.height === 512 && d0.bitDepth === 8 && d0.channels.length === 1);
  // the next call starts from what was typed; the title is made unique
  await t.runCommand('fileNewImage', { type: 16, fill: 'ramp', width: 20, height: 10 });
  await t.runCommand('fileNewImage', {});
  spec = lastSpec(t);
  assert.equal(field(spec, 'fill').value, 'ramp'); assert.equal(field(spec, 'width').value, 20); assert.equal(String(field(spec, 'type').value), '16');
  docs = await t.docs();
  const r = docs.find((d) => d.name === 'Untitled-1');
  assert.ok(r && r.width === 20 && r.bitDepth === 16, 'Untitled-1: WindowManager.makeUniqueName');
  assert.ok(docs.some((d) => d.name === 'Untitled-2'));
  const rp = await t.pixels(r.docId, 0);
  for (let x = 0; x < 20; x++) assert.equal(rp[x], Math.trunc((x * 65536.0) / 20 + 0.5), 'ramp 16-bit');
  assert.equal(r.channels[0].display.max, 65535);
  // White: 8 bits is 255; 16 and 32 bits are zeros with an inverting LUT
  await t.runCommand('fileNewImage', { name: 'w8', type: 8, fill: 'white', width: 6, height: 4 });
  await t.runCommand('fileNewImage', { name: 'w16', type: 16, fill: 'white', width: 6, height: 4 });
  docs = await t.docs();
  const w8 = docs.find((d) => d.name === 'w8'), w16 = docs.find((d) => d.name === 'w16');
  assert.ok((await t.pixels(w8.docId, 0)).every((v) => v === 255));
  assert.ok((await t.pixels(w16.docId, 0)).every((v) => v === 0) && w16.channels[0].display.invert === true, 'zeros and an inverted LUT');
  t.close();
});

await test('File > New > Image…: Noise is seeded (the seed is journaled), deterministic per seed, reload-proof; bad arguments and a huge image are refused', async () => {
  const t = await fresh();
  await t.runCommand('fileNewImage', { name: 'n8', type: 8, fill: 'noise', width: 30, height: 20 });
  const n8 = (await t.docs()).find((d) => d.name === 'n8');
  const px = await t.pixels(n8.docId, 0);
  assert.ok(px.some((v) => v !== 127) && px.every((v) => v >= 0 && v <= 255), 'around 127');
  const seed = n8.provenance && n8.provenance.newImage && n8.provenance.newImage.seed;
  assert.ok(Number.isInteger(seed), 'the seed is in the provenance: ' + JSON.stringify(n8.provenance));
  // the same seed through the worker command gives the same pixels
  const a = await t.engine('edit.newImage', { name: 'x1', bitDepth: 8, fill: 'noise', width: 30, height: 20, seed });
  assert.deepEqual(arr(await t.pixels(a.info.docId, 0)), arr(px));
  const b = await t.engine('edit.newImage', { name: 'x2', bitDepth: 8, fill: 'noise', width: 30, height: 20, seed: seed + 1 });
  assert.notDeepEqual(arr(await t.pixels(b.info.docId, 0)), arr(px));
  // 32-bit noise keeps the data range as its display range
  const f = await t.engine('edit.newImage', { name: 'f', bitDepth: 32, fill: 'noise', width: 30, height: 20, seed: 1 });
  assert.ok(f.info.channels[0].display.min < 0 && f.info.channels[0].display.max > 0);
  await assert.rejects(t.engine('edit.newImage', { name: 'x', bitDepth: 12, fill: 'black', width: 4, height: 4 }), (e) => e.code === 'IJ_BAD_ARGS');
  await assert.rejects(t.engine('edit.newImage', { name: 'x', bitDepth: 8, fill: 'black', width: 20000, height: 20000 }), (e) => e.code === 'IJ_TOO_LARGE');
  await assert.rejects(t.engine('edit.newImage', { name: 'x', bitDepth: 8, fill: 'plaid', width: 4, height: 4 }), (e) => e.code === 'IJ_BAD_ARGS');
  const r = await reloaded(t);
  assert.ok(r.docs.some((d) => d.name === 'n8'), 'an image that was made survives a reload');
  r.close();
});

await test('cancel: a cancelled New Image creates nothing (the loops check for Cancel before they yield)', async () => {
  const t = await fresh();
  const before = (await t.docs()).length;
  await t.engine('doc.list');
  const w = t.worker;
  const id = 880001;
  const p = new Promise((resolve, reject) => w.__pending.set(id, { resolve, reject, cmd: 'edit.newImage' }));
  p.catch(() => {});
  // the engine runs the first slice of the command inside this call; Cancel follows at once and is seen at the first check
  w.far.onmessage({ data: { id, cmd: 'edit.newImage', args: { name: 'big', bitDepth: 16, fill: 'noise', width: 2000, height: 2000, seed: 5 } } });
  await t.engine('cancel', { targetId: id });
  await assert.rejects(p, (e) => e.code === 'IJ_CANCELLED');
  assert.equal((await t.docs()).length, before, 'no image was made');
  t.close();
});

await test('File > Close All closes every image in order', async () => {
  const t = await fresh();
  await t.runCommand('fileNewImage', { name: 'a', width: 8, height: 8 });
  await t.runCommand('fileNewImage', { name: 'b', width: 8, height: 8 });
  assert.equal((await t.docs()).length, 3);
  await t.runCommand('fileCloseAll');
  assert.equal((await t.docs()).length, 0);
  t.close();
});

// ═════════════════════════════════════════ Options ═════════════════════════════════════════
await test('Edit > Options > Colors…: three choices (ImageJ\'s list), written to the preferences; Fill and Clear follow', async () => {
  const t = await fresh();
  const id = idOf(t);
  await t.runCommand('optColors', {});
  const spec = lastSpec(t);
  eq(spec.fields.map((f) => f.id), ['foreground', 'background', 'selection']);
  eq(field(spec, 'foreground').options.map((o) => o.value), ['red', 'green', 'blue', 'magenta', 'cyan', 'yellow', 'orange', 'black', 'white', 'gray', 'lightgray', 'darkgray', 'pink']);
  assert.equal(field(spec, 'foreground').value, 'white'); assert.equal(field(spec, 'background').value, 'black'); assert.equal(field(spec, 'selection').value, 'yellow');
  await t.runCommand('optColors', { foreground: 'gray', background: 'lightgray', selection: 'cyan' });
  assert.equal(t.settings.get('colors.foreground'), 'gray'); assert.equal(t.settings.get('colors.background'), 'lightgray'); assert.equal(t.settings.get('colors.selection'), 'cyan');
  setRoi(t, { type: 'rect', x: 2, y: 2, w: 5, h: 5 });
  await t.runCommand('editFill');
  // the value is the table entry nearest to the colour (ImageJ's getBestIndex), through the one rule api.colorValue implements
  const fg = t.api(null).colorValue(id, 0, 'foreground'), bg = t.api(null).colorValue(id, 0, 'background');
  assert.notEqual(fg, bg);
  assert.equal((await t.pixels(id, 0))[2 * 40 + 2], fg, 'Fill: the foreground colour (gray)');
  await t.runCommand('editClear');
  assert.equal((await t.pixels(id, 0))[2 * 40 + 2], bg, 'Clear: the background colour (light gray)');
  await t.runCommand('optColors', {});
  assert.equal(field(lastSpec(t), 'foreground').value, 'gray', 'the dialog shows what was chosen');
  t.close();
});

await test('Edit > Options > Conversions… and Appearance…: the preferences the rest of the application reads', async () => {
  const t = await fresh();
  await t.runCommand('optConversions', {});
  let spec = lastSpec(t);
  eq(spec.fields.map((f) => f.id), ['scale', 'fullRange16']);
  assert.equal(field(spec, 'scale').value, true); assert.equal(field(spec, 'fullRange16').value, false);
  await t.runCommand('optConversions', { scale: false, fullRange16: true });
  assert.equal(t.settings.get('conv.scale'), false); assert.equal(t.settings.get('conv.fullRange16'), true);
  await t.runCommand('optConversions', {});
  assert.equal(field(lastSpec(t), 'scale').value, false);
  await t.runCommand('optAppearance', {});
  spec = lastSpec(t);
  eq(spec.fields.map((f) => f.id), ['interpolate']); assert.equal(field(spec, 'interpolate').value, false);
  await t.runCommand('optAppearance', { interpolate: true });
  assert.equal(t.settings.get('appearance.interpolate'), true);
  assert.equal(t.view(idOf(t)).interpolate, true, 'the view interpolates');
  t.close();
});

await test('Edit > Options > Misc…: the divide-by-zero value is read as ImageJ reads it and shown as Java prints a float; Image Calculator Divide uses it', async () => {
  const t = await fresh({ channels: 1 });
  await t.runCommand('optMisc', {});
  assert.equal(field(lastSpec(t), 'divZero').value, 'Infinity');
  await t.runCommand('optMisc', { divZero: 'max' });
  assert.equal(t.settings.get('misc.divZero'), '3.4028235E38');
  await t.runCommand('optMisc', {});
  assert.equal(field(lastSpec(t), 'divZero').value, '3.4028235E38');
  await t.runCommand('optMisc', { divZero: 'banana' });
  assert.equal(t.settings.get('misc.divZero'), '3.4028235E38', 'unreadable text leaves the value as it was');
  await t.runCommand('optMisc', { divZero: ' -2.5f' });
  assert.equal(t.settings.get('misc.divZero'), '-2.5');
  await t.runCommand('optMisc', { divZero: 'NaN' });
  assert.equal(t.settings.get('misc.divZero'), 'NaN');
  // Image Calculator: 32-bit Divide by a zero pixel
  await t.runCommand('optMisc', { divZero: '7' });
  await t.runCommand('fileNewImage', { name: 'num', type: 32, fill: 'ramp', width: 8, height: 4 });
  await t.runCommand('fileNewImage', { name: 'den', type: 32, fill: 'ramp', width: 8, height: 4 });
  const docs = await t.docs();
  const num = docs.find((d) => d.name === 'num'), den = docs.find((d) => d.name === 'den');
  await t.runCommand('procImageCalculator', { image1: num.docId, op: 'divide', image2: den.docId, float32: true });
  const res = (await t.docs()).find((d) => d.name === 'Result of num');
  const px = await t.pixels(res.docId, 0);
  assert.equal(px[0], 7, 'x / 0 with the divide-by-zero value 7 (the ramp starts at 0)');
  assert.equal(px[2], 1, 'other pixels divide normally: 0.25 / 0.25');
  // back to +Infinity: plain IEEE (0 / 0 = NaN)
  await t.runCommand('optMisc', { divZero: 'Infinity' });
  await t.runCommand('procImageCalculator', { image1: num.docId, op: 'divide', image2: den.docId, float32: true });
  const res2 = (await t.docs()).filter((d) => d.name.startsWith('Result of num')).pop();
  assert.ok(Number.isNaN((await t.pixels(res2.docId, 0))[0]));
  t.close();
});

// ═════════════════════════════════════════ look-up tables ═════════════════════════════════════════
const dispOf = async (t, id, c) => (await t.docs()).find((d) => d.docId === id).channels[c].display;

await test('3-3-2 RGB and Red/Green: the active channel gets the table (a fresh table: not inverted); the table survives a reload', async () => {
  const t = await fresh();
  const id = idOf(t);
  await t.runCommand('lutInvert');
  await sleep(30);
  assert.equal((await dispOf(t, id, 0)).invert, true);
  await t.runCommand('lut332RGB');
  await sleep(30);
  let d = await dispOf(t, id, 0);
  assert.equal(d.lut, '3-3-2 RGB'); assert.equal(d.invert, false, 'LutLoader.showLut installs a fresh colour model');
  await t.runCommand('lutRedGreen');
  await sleep(30);
  assert.equal((await dispOf(t, id, 0)).lut, 'Red/Green');
  await t.runCommand('lutInvert'); await sleep(30);
  await t.runCommand('lutFire'); await sleep(30);
  d = await dispOf(t, id, 0);
  assert.equal(d.lut, 'Fire'); assert.equal(d.invert, false, 'the built-in tables replace an inverted one too');
  await t.runCommand('lut332RGB'); await sleep(30);
  const r = await reloaded(t);
  const d2 = r.docs.find((d) => d.docId === id);
  assert.equal(d2.channels[0].display.lut, '3-3-2 RGB');
  r.close();
});

await test('Invert LUTs (the macro InvertAllLuts): every channel gets the inverse that keeps its colour; twice brings the colours back', async () => {
  const t = await fresh();
  const E = t.page.IJEdit;
  const stateDoc = () => t.api(null).state().doc;
  const colorOf = (i) => (stateDoc().channels[i] || {}).color;
  const before = (await t.docs())[0].channels.map((c) => c.display);
  // a composite shown as a Sum has no inverted rendering here (the macro's Invert projection): refused, nothing changes
  const errs = await t.runCommand('colorInvertLuts', undefined, { expectError: true });
  assert.ok(errs.length >= 1 && /Color or Grayscale/.test(errs[0].message), errs.map((e) => e.message).join('|'));
  assert.deepEqual((await t.docs())[0].channels.map((c) => c.display), before, 'the refused command changed nothing');
  await t.engine('doc.setDisplay', { docId: idOf(t), mode: 'color' });
  await t.runCommand('colorInvertLuts');
  await sleep(50);
  const mid = (await t.docs())[0].channels.map((c) => c.display);
  mid.forEach((d, i) => {
    const want = E.invertLutTable(E.effectiveTable(before[i].lut, before[i].invert, colorOf(i)));
    assert.deepEqual(arr(E.effectiveTable(d.lut, d.invert, colorOf(i))), arr(want), 'channel ' + i);
  });
  // the first channel is red: its table now runs from light to red
  const redTable = E.effectiveTable(mid[0].lut, mid[0].invert, colorOf(0));
  assert.ok(redTable[0] > 200 && redTable[1] > 200, 'the low end is light');
  await t.runCommand('colorInvertLuts');
  await sleep(50);
  const back = (await t.docs())[0].channels.map((c) => c.display);
  back.forEach((d, i) => {
    const a = E.effectiveTable(d.lut, d.invert, colorOf(i)), b = E.effectiveTable(before[i].lut, before[i].invert, colorOf(i));
    for (let k = 0; k < 768; k++) assert.ok(Math.abs(a[k] - b[k]) <= 1, 'channel ' + i + ' entry ' + k);
  });
  t.close();
});

await test('LutLoader on a grayscale composite: every channel takes the table and the image goes to Color mode (api.setDisplayMode)', async () => {
  const t = await fresh();
  await t.engine('doc.setDisplay', { docId: idOf(t), mode: 'gray' });
  await t.runCommand('lut332RGB');
  await sleep(50);
  const d = (await t.docs())[0];
  assert.ok(d.channels.length > 1);
  const luts = d.channels.map((c) => c.display.lut);
  assert.ok(luts.every((l) => l === luts[0]), 'one table on every channel: ' + luts.join('|'));
  const disp = await t.engine('edit.display', { docId: idOf(t) });
  assert.equal(disp.mode, 'color');
  t.close();
});

await test('Show LUT: opens a plot window of the active channel\'s table without error', async () => {
  const t = await fresh();
  const before = t.shell.windows.floats.size;
  await t.runCommand('colorShowLut');
  assert.ok(t.shell.windows.floats.size > before, 'a plot window opened');
  t.close();
});

await test('File > Save As > LUT… writes 768 raw bytes (reds, greens, blues); File > Import > LUT… reads them back and applies the table to the active channel', async () => {
  const t = await fresh();
  const id = idOf(t);
  await t.runCommand('lutFire'); await sleep(30);
  await t.runCommand('fileSaveLut');
  assert.equal(t.saved.length, 1);
  assert.ok(/\.lut$/.test(t.saved[0].name), t.saved[0].name);
  const bytes = new Uint8Array(await t.saved[0].blob.arrayBuffer());
  assert.equal(bytes.length, 768);
  const fire = t.page.IJLuts.get('Fire');
  for (let i = 0; i < 256; i++) { assert.equal(bytes[i], fire[i * 3]); assert.equal(bytes[256 + i], fire[i * 3 + 1]); assert.equal(bytes[512 + i], fire[i * 3 + 2]); }
  const mk = (name, data) => ({ name, arrayBuffer: async () => data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) });
  t.pickFile([mk('my fire.lut', bytes)]);
  await t.runCommand('fileImportLut');
  await sleep(30);
  let d = await dispOf(t, id, 0);
  assert.equal(d.lut, 'my fire'); assert.equal(d.invert, false);
  assert.deepEqual(arr(t.page.IJLuts.get('my fire')), arr(fire));
  // a file named like a built-in table does not replace it
  t.pickFile([mk('Fire.lut', bytes.map((v) => 255 - v))]);
  await t.runCommand('fileImportLut');
  await sleep(30);
  d = await dispOf(t, id, 0);
  assert.equal(d.lut, 'Fire (LUT)');
  assert.deepEqual(arr(t.page.IJLuts.get('Fire')), arr(fire), 'the built-in Fire is untouched');
  // a file that is no LUT is refused
  t.pickFile([mk('junk.lut', new Uint8Array(500))]);
  assert.ok((await t.runCommand('fileImportLut', undefined, { expectError: true })).length >= 1);
  // a cancelled picker does nothing
  t.pickFile(null);
  await t.runCommand('fileImportLut');
  t.close();
});

// ═════════════════════════════════════════ Make Montage ═════════════════════════════════════════
await test('Make Montage…: ImageJ\'s defaults for the channel count, an R/G/B 8-bit image, the tiles are the channels through their LUTs; labels as overlay text; remembered values', async () => {
  const t = await fresh();
  const id = idOf(t);
  const src = (await t.docs())[0];
  await t.runCommand('stackMontage', {});
  const spec = lastSpec(t);
  eq(spec.fields.map((f) => f.id), ['columns', 'rows', 'scale', 'first', 'last', 'increment', 'border', 'fontSize', 'label', 'useForeground']);
  // 3 slices: columns = (int)sqrt(3) = 1, rows = 1, n = 2 left → columns += ceil(2/1) = 3
  assert.equal(field(spec, 'columns').value, 3); assert.equal(field(spec, 'rows').value, 1); assert.equal(field(spec, 'scale').value, 1);
  assert.equal(field(spec, 'first').value, 1); assert.equal(field(spec, 'last').value, 3); assert.equal(field(spec, 'increment').value, 1); assert.equal(field(spec, 'border').value, 0);
  assert.equal(field(spec, 'fontSize').value, 12);
  let docs = await t.docs();
  const m = docs.find((d) => d.name === 'Montage');
  assert.ok(m && m.width === 120 && m.height === 30 && m.bitDepth === 8 && m.channels.length === 3);
  eq(m.channels.map((c) => c.name), ['R', 'G', 'B']);
  // the first tile is channel 1 through its LUT
  const E = t.page.IJEdit;
  const tile = E.renderChannelRGB({ data: await t.pixels(id, 0), display: src.channels[0].display, color: src.channels[0].color }, 8, false);
  const R = await t.pixels(m.docId, 0), G = await t.pixels(m.docId, 1);
  for (let y = 0; y < 30; y++) for (let x = 0; x < 40; x++) { assert.equal(R[y * 120 + x], tile.r[y * 40 + x]); assert.equal(G[y * 120 + x], tile.g[y * 40 + x]); }
  // the values are remembered while the stack is the same
  t.layout().activate(src.docId);
  await t.runCommand('stackMontage', { columns: 2, rows: 2, border: 2, label: true, fontSize: 9 });
  t.layout().activate(src.docId);
  await t.runCommand('stackMontage', {});
  const s2 = lastSpec(t);
  assert.equal(field(s2, 'columns').value, 2); assert.equal(field(s2, 'border').value, 2); assert.equal(field(s2, 'label').value, true);
  docs = await t.docs();
  const m2 = docs.filter((d) => d.name === 'Montage' && d.docId !== m.docId)[0];
  assert.ok(m2 && m2.width === 82 && m2.height === 62, '2 columns of 40 and a 2 px border: ' + (m2 && m2.width) + 'x' + (m2 && m2.height));
  // labels: the slice numbers as overlay text, none of them burnt in
  const ann = t.api(null).annotations.get(m2.docId);
  eq(ann.items.map((i) => i.text), ['1', '2', '3']);
  assert.ok(ann.items.every((i) => i.kind === 'text' && i.size === 9 && i.align === 'center'));
  const r = await reloaded(t);
  assert.ok(r.docs.some((d) => d.name === 'Montage'), 'the montage survives a reload');
  r.close();
});

await test('Make Montage…: a one-channel image has no stack (disabled); a scale that makes a tile smaller than a pixel is refused by the dialog', async () => {
  const t = await boot({ channels: 1 });
  await t.open();
  assert.equal(t.isEnabled('stackMontage'), false);
  t.close();
  const t2 = await fresh();
  await assert.rejects(t2.runCommand('stackMontage', { scale: 0.01 }), (e) => /refuses|scale/.test(e.message));
  t2.close();
});

// ═════════════════════════════════════════ review fixes ═════════════════════════════════════════
await test('Make Montage…: a change of stack resets the layout only; border, font size, Label Slices and Use foreground colour are statics that survive', async () => {
  const t = await fresh();
  const src = (await t.docs())[0];
  await t.runCommand('stackMontage', { columns: 3, rows: 1, border: 2, fontSize: 9, label: true, useForeground: true });
  const two = await t.api(null).addDoc({ name: 'two', width: 20, height: 20, bitDepth: 8, calibration: { pixelWidth: 1, pixelHeight: 1, unit: 'px' },
    channels: [0, 1].map((i) => ({ data: new Uint8Array(400).fill(10 + i), name: 'C' + (i + 1), color: i ? '#00ff00' : '#ff0000' })) }, { placement: 'tab' });
  t.layout().activate(two);
  await t.runCommand('stackMontage', {});
  const spec = lastSpec(t);
  const d = t.page.IJEdit.montageDefaults(2, 20);
  assert.equal(field(spec, 'columns').value, d.columns, 'the layout starts again from the defaults of the new stack');
  assert.equal(field(spec, 'border').value, 2); assert.equal(field(spec, 'fontSize').value, 9);
  assert.equal(field(spec, 'label').value, true); assert.equal(field(spec, 'useForeground').value, true);
  t.layout().activate(src.docId);
  t.close();
});

await test('File > New > Image… keeps its Name for the session only (NewImage.name is a static that is not saved), the other values in the preferences', async () => {
  const t = await fresh();
  await t.runCommand('fileNewImage', { name: 'cells', width: 8, height: 8 });
  const saved = t.settings.get('edit.newImage');
  assert.ok(saved && saved.name === undefined && saved.width === 8, JSON.stringify(saved));
  await t.runCommand('fileNewImage', {});
  assert.equal(field(lastSpec(t), 'name').value, 'cells', 'remembered within the session');
  const r = await reloaded(t);
  r.close();
  t.close();
  const t2 = await fresh();
  t2.settings.set && t2.settings.set('edit.newImage', { name: 'stale', type: 8, fill: 'black', width: 8, height: 8 });
  await t2.runCommand('fileNewImage', {});
  assert.equal(field(lastSpec(t2), 'name').value, 'Untitled', 'a name stored by an older version is ignored');
  t2.close();
});

await test('LUT commands with no image open make a 256 x 32 ramp image whose colour model is the table (LutLoader.createImage)', async () => {
  const t = await fresh();
  await t.runCommand('fileCloseAll');
  assert.equal((await t.docs()).length, 0);
  assert.equal(t.isEnabled('lut332RGB'), true); assert.equal(t.isEnabled('fileImportLut'), true);
  await t.runCommand('lut332RGB');
  await sleep(30);
  const docs = await t.docs();
  assert.equal(docs.length, 1);
  const d = docs[0];
  assert.ok(d.width === 256 && d.height === 32 && d.bitDepth === 8 && d.channels[0].display.lut === '3-3-2 RGB', JSON.stringify([d.width, d.height, d.channels[0].display]));
  const px = await t.pixels(d.docId, 0);
  for (let y = 0; y < 32; y++) for (let x = 0; x < 256; x += 51) assert.equal(px[y * 256 + x], x);
  // File > Import > LUT… with no image: the same, titled with the file's name
  await t.runCommand('fileCloseAll');
  const raw = new Uint8Array(768); for (let i = 0; i < 256; i++) { raw[i] = i; raw[256 + i] = 255 - i; raw[512 + i] = 0; }
  t.pickFile([new File([raw], 'rg.lut')]);
  await t.runCommand('fileImportLut');
  await sleep(30);
  const d2 = (await t.docs())[0];
  assert.ok(d2 && d2.name === 'rg.lut' && d2.width === 256 && d2.height === 32, JSON.stringify(d2 && [d2.name, d2.width]));
  t.close();
});

await test('Copy: a selection over the 64 MiB clipboard limit is refused from its bounds, before the worker builds the copy', async () => {
  const t = await fresh();
  await t.runCommand('fileNewImage', { name: 'big', type: 32, fill: 'black', width: 4100, height: 4100 });
  await sleep(100);
  const before = t.log.msgs.length;
  const errs = await t.runCommand('editCopy', undefined, { expectError: true });
  assert.ok(errs.length >= 1 && /64 MB/.test(errs[0].message), errs.map((e) => e.message).join('|'));
  assert.ok(!t.log.msgs.slice(before).some((m) => m && m.cmd === 'doc.compute' && m.args && m.args.op === 'copyRegion'), 'no copyRegion request was made');
  t.close();
});

console.log(n + ' groups passed');
