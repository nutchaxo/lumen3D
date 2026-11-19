// Advanced Studio, package thr: the menu commands of ij-cmds-thr.js and the controller's threshold / binary code, end to end through
// tests/js/ij_harness.mjs — dialog values → the real controller → the REAL worker engine → undo → redo → reload() restores the journal.
//
//   * Image › Adjust › Auto Threshold / Auto Local Threshold: where they sit, Fiji's dialog (fiji-dialogs.json: fields, order, defaults,
//     "Try all" first), 8-bit in place, 16-bit → a new 8-bit mask, "SetThreshold instead", Try all (labelled montage), refusals;
//   * Process › Binary › Make Binary / Median / Options: the dialog of Binary.java, the settings it writes and the commands that read
//     them (Erode with iterations / count / Pad edges, Black background off = foreground 0 and an inverting LUT on the mask);
//   * the Threshold window's "16-bit histogram" (doc.threshold handler).
//
// Run: node tests/js/test_ij_thr_commands.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { boot, until, EN, DIR } from './ij_harness.mjs';

const sandbox = { console, setTimeout, clearTimeout };
sandbox.self = sandbox;
vm.createContext(sandbox);
for (const f of ['ij-core.js', 'ij-analysis.js', 'ij-proc-shared.js', 'ij-proc-seg.js', 'ij-proc-thr.js']) vm.runInContext(fs.readFileSync(path.join(DIR, f), 'utf8'), sandbox, { filename: f });
const { IJThreshold: T, IJBinary: B, IJThr, IJFilters } = sandbox;

let passed = 0;
async function test(name, fn) { try { await fn(); passed++; console.log('  ok  ' + name); } catch (e) { console.error('FAIL ' + name); throw e; } }
const A = (x) => Array.from(x);
const VOL = { width: 60, height: 44, depth: 3, channels: 1 };
const lastSpec = (t) => t.log.dialogSpecs[t.log.dialogSpecs.length - 1];
const hist8 = (px) => { const h = new Float64Array(256); for (const v of px) h[v]++; return h; };
const infoOf = async (t, id) => (await t.docs()).find((d) => d.docId === id);
// reload() + session.restore of every journal: the documents come back from the journal alone (rule 6), no warning
async function restored(t) {
  const t2 = await t.reload();
  const w2 = await t2.spawn();
  for (const k of (await t2.store.shared.list()).map((x) => x.key)) { const r = await t2.engine('session.restore', { key: k }, w2); assert.equal(r.warnings.length, 0, JSON.stringify(r.warnings)); }
  return t2;
}

await test('registration: menu, order, separators, no shortcut, enabled rules; labels are ImageJ\'s / Fiji\'s', async () => {
  const t = await boot({ volume: VOL });
  const by = (id) => t.IJApp.COMMANDS.find((c) => c.id === id);
  const want = { adjustAutoLocalThreshold: [['Image', 'Adjust'], 50], adjustAutoThreshold: [['Image', 'Adjust'], 60], binMakeBinary: [['Process', 'Binary'], 5],
    binMedian: [['Process', 'Binary'], 55], binOptions: [['Process', 'Binary'], 130] };
  for (const [id, [menu, order]] of Object.entries(want)) {
    const c = by(id);
    assert.ok(c, id); assert.equal(c.pkg, 'thr'); assert.deepEqual(A(c.menu), menu); assert.equal(c.order, order); assert.equal(c.shortcut, null);
  }
  assert.equal(by('adjustAutoLocalThreshold').separatorBefore, true, 'the Fiji plugins follow a separator (Image > Adjust)');
  assert.equal(by('binOptions').separatorBefore, true);
  assert.equal(by('binMask').order, 10); assert.ok(by('binMakeBinary').order < by('binMask').order);
  assert.ok(by('binClose').order < by('binMedian').order && by('binMedian').order < by('binOutline').order, 'Median sits between Close and Outline');
  const labels = { adjustAutoThreshold: 'Auto Threshold', adjustAutoLocalThreshold: 'Auto Local Threshold', binMakeBinary: 'Make Binary', binMedian: 'Median', binOptions: 'Options…' };
  for (const [id, l] of Object.entries(labels)) assert.equal(EN.cmd[id], l);
  const st = (doc, o) => Object.assign({ doc, roi: null, prevRoi: null, busy: false, nDocs: 1, canUndo: false, canRedo: false, dirty: false, hasResults: false, canProject: true, threshold: null, activeChannel: 0 }, o);
  const img = (bd) => ({ docId: 'x', name: 'x', width: 10, height: 10, bitDepth: bd, channels: [{ name: 'a' }] });
  for (const id of ['adjustAutoThreshold', 'adjustAutoLocalThreshold', 'binMakeBinary']) { assert.equal(by(id).enabled(st(null)), false, id); assert.equal(by(id).enabled(st(img(8), { busy: true })), false, id); assert.equal(by(id).enabled(st(img(32))), true, id + ' is offered on 32 bits (it explains the refusal)'); }
  assert.equal(by('binMedian').enabled(st(img(8))), true); assert.equal(by('binMedian').enabled(st(img(16))), false);
  assert.equal(by('binOptions').enabled(st(null)), true, 'Binary Options works without an image (Binary.setup: NO_IMAGE_REQUIRED)');
  t.close();
});

await test('Auto Threshold: Fiji\'s dialog (fields, order, "Try all" first and the default), then 8-bit in place', async () => {
  const t = await boot({ volume: VOL });
  await t.open();
  const id = t.activeId();
  const src = A(await t.pixels(id, 0));
  await t.runCommand('adjustAutoThreshold', { method: 'Otsu' });
  const spec = lastSpec(t);
  assert.deepEqual(A(spec.fields.map((f) => f.id)), ['method', 'ignoreBlack', 'ignoreWhite', 'white', 'setThreshold', 'showValues']);
  assert.equal(spec.fields[0].value, 'Try all', 'the default is Try all');
  assert.deepEqual(A(spec.fields[0].options.map((o) => o.value)), ['Try all', 'Default', 'Huang', 'Huang2', 'Intermodes', 'IsoData', 'Li', 'MaxEntropy', 'Mean', 'MinError(I)', 'Minimum', 'Moments', 'Otsu', 'Percentile', 'RenyiEntropy', 'Shanbhag', 'Triangle', 'Yen']);
  assert.deepEqual(A(spec.fields.slice(1).map((f) => f.value)), [false, false, true, false, false], 'Fiji\'s defaults');
  assert.deepEqual(A(spec.fields.map((f) => EN.dlg.thr[f.labelKey.split('.').pop()])).slice(1), ['Ignore black', 'Ignore white', 'White objects on black background', 'SetThreshold instead of Threshold (single images)', 'Show threshold values in log window']);
  const level = IJThr.fijiLevel(hist8(src), 'Otsu', false);
  const out = A(await t.pixels(id, 0));
  assert.deepEqual(out, src.map((v) => (v > level ? 255 : 0)));
  assert.equal((await infoOf(t, id)).undoDepth, 1, 'one undo step');
  await t.runCommand('editUndo');
  assert.deepEqual(A(await t.pixels(id, 0)), src, 'undo');
  await t.runCommand('editRedo');
  assert.deepEqual(A(await t.pixels(id, 0)), out, 'redo');
  const t2 = await t.reload();
  const w2 = await t2.spawn();
  for (const k of (await t2.store.shared.list()).map((x) => x.key)) { const r = await t2.engine('session.restore', { key: k }, w2); assert.equal(r.warnings.length, 0, JSON.stringify(r.warnings)); }
  assert.deepEqual(A(await t2.pixels(id, 0)), out, 'restored from the journal');
  t2.close();
});

await test('Auto Threshold: not white = the dark objects, Ignore black / white, the dialog remembers its values, a selection limits the pixels', async () => {
  const t = await boot({ volume: VOL });
  await t.open();
  const id = t.activeId();
  const src = A(await t.pixels(id, 0));
  await t.runCommand('adjustAutoThreshold', { method: 'Mean', white: false });
  const level = IJThr.fijiLevel(hist8(src), 'Mean', false);
  assert.deepEqual(A(await t.pixels(id, 0)), src.map((v) => (v <= level ? 255 : 0)), 'objects are the pixels at or below the level, shown 255');
  await t.runCommand('editUndo');
  await t.runCommand('adjustAutoThreshold', {});
  const spec = lastSpec(t);
  assert.equal(spec.fields[0].value, 'Mean', 'the last values come back (ImageJ static fields)');
  assert.equal(spec.fields[3].value, false);
  await t.runCommand('editUndo');
  // a selection: the histogram and the pixels are the selection's
  await t.api('thr').setRoi({ type: 'rect', x: 4, y: 3, w: 30, h: 20 }, { docId: id });
  await t.runCommand('adjustAutoThreshold', { method: 'Otsu', white: true });
  const sel = A(await t.pixels(id, 0));
  const inside = (x, y) => x >= 4 && x < 34 && y >= 3 && y < 23;
  const sub = []; for (let y = 3; y < 23; y++) for (let x = 4; x < 34; x++) sub.push(src[y * VOL.width + x]);
  const lv = IJThr.fijiLevel(hist8(sub), 'Otsu', false);
  for (let y = 0; y < VOL.height; y++) for (let x = 0; x < VOL.width; x++) assert.equal(sel[y * VOL.width + x], inside(x, y) ? (src[y * VOL.width + x] > lv ? 255 : 0) : src[y * VOL.width + x], `(${x},${y})`);
  t.close();
});

await test('Auto Threshold on 16 bits: the 65 536-bin level, a NEW 8-bit mask, the source untouched; "SetThreshold instead" sets the range', async () => {
  const t = await boot({ volume: VOL });
  await t.open();
  await t.runCommand('typeBit16', {});
  const id = t.activeId();
  const src = await t.pixels(id, 0);
  const docs0 = (await t.docs()).length;
  await t.runCommand('adjustAutoThreshold', { method: 'Li' });
  const docs = await t.docs();
  assert.equal(docs.length, docs0 + 1, 'a new image');
  const mask = docs.find((d) => d.docId !== id && d.bitDepth === 8 && /-mask$/.test(d.name));
  assert.ok(mask, 'an 8-bit "-mask" image: ' + docs.map((d) => d.name + '/' + d.bitDepth).join(','));
  const h16 = new Float64Array(65536); for (const v of src) h16[v]++;
  const level = IJThr.fijiLevel(h16, 'Li', true);
  const mp = await t.pixels(mask.docId, 0);
  for (let i = 0; i < mp.length; i++) assert.equal(mp[i], src[i] > level ? 255 : 0);
  assert.deepEqual(A(await t.pixels(id, 0)), A(src), 'the 16-bit source is untouched');
  // SetThreshold instead: the Threshold window's range (a 16-bit image keeps its 16-bit data: documented deviation of ij-cmds-thr.js)
  for (let i = 0; i < 12 && t.activeId() !== id; i++) await t.runCommand('windowNext');
  await t.runCommand('adjustAutoThreshold', { method: 'Li', setThreshold: true });
  const th = t.api('thr').state().threshold;
  assert.ok(th && th.docId === id, 'the Threshold window holds a range');
  assert.equal(th.lower, level + 1, 'white objects: [level + 1, top]');
  assert.equal((await t.docs()).length, docs0 + 1, 'no new image');
  const t2 = await restored(t);
  assert.deepEqual(A(await t2.pixels(mask.docId, 0)), A(mp), 'the 16-bit mask restored from the journal');
  assert.deepEqual(A(await t2.pixels(id, 0)), A(src), 'and the source');
  t2.close();
});

await test('Auto Threshold: 32-bit refused with a sentence, Show threshold values reports the level, Try all makes a labelled montage', async () => {
  const t = await boot({ volume: VOL });
  await t.open();
  const id = t.activeId();
  const src = A(await t.pixels(id, 0));
  await t.runCommand('adjustAutoThreshold', { method: 'Triangle', showValues: true });
  assert.ok(t.log.status.some((s) => /Triangle: \d+/.test(String(s))), 'the level in the status bar: ' + JSON.stringify(t.log.status.slice(-3)));
  await t.runCommand('editUndo');
  // Try all
  const n0 = (await t.docs()).length;
  await t.runCommand('adjustAutoThreshold', { method: 'Try all' });
  const docs = await t.docs();
  assert.equal(docs.length, n0 + 1);
  const mont = docs[docs.length - 1];
  const N = IJThr.FIJI_METHODS.length;
  const L = IJThr.tryAllLayout(VOL.width, VOL.height, N, 4096);
  assert.deepEqual([mont.width, mont.height, mont.bitDepth], [L.width, L.height, 8]);
  const ann = t.view(mont.docId).annotations;
  assert.ok(ann && ann.items.length === N, 'one label per method (no original panel)');
  assert.deepEqual(A(ann.items.map((i) => i.text)), A(IJThr.FIJI_METHODS));
  assert.ok(ann.items.every((i) => i.kind === 'text' && i.tag === 'thr.tryall'));
  const o = L.cell(3);
  assert.deepEqual([ann.items[3].x, ann.items[3].y], [o.x + 3, o.y + 3], 'inside its panel');
  const mp = await t.pixels(mont.docId, 0);
  assert.ok(mp.every((v) => v === 0 || v === 255), 'a binary montage');
  const h8 = hist8(src);
  IJThr.FIJI_METHODS.forEach((m, k) => {
    const lv = IJThr.fijiLevel(h8, m, false), pc = L.cell(k);
    for (let y = 0; y < VOL.height; y++) for (let x = 0; x < VOL.width; x++) assert.equal(mp[(pc.y + y) * L.width + pc.x + x], src[y * VOL.width + x] > lv ? 255 : 0, m);
  });
  assert.deepEqual(A(await t.pixels(id, 0)), src, 'the source is untouched by Try all');
  // Show threshold values with Try all: every method's level in the status bar, the montage draws those very levels
  for (let i = 0; i < 12 && t.activeId() !== id; i++) await t.runCommand('windowNext');
  assert.equal(t.activeId(), id);
  await t.runCommand('adjustAutoThreshold', { method: 'Try all', showValues: true });
  const line = String(t.log.status.filter((x) => /Default: \d+/.test(String(x))).pop());
  for (const m of IJThr.FIJI_METHODS) assert.ok(new RegExp(m.replace(/[()]/g, '\\$&') + ': \\d+').test(line), m + ' in ' + line);
  const docs2 = await t.docs(), mont2 = docs2[docs2.length - 1];
  assert.notEqual(mont2.docId, mont.docId);
  assert.deepEqual(A(await t.pixels(mont2.docId, 0)), A(mp), 'the same montage');

  // 32 bits
  await t.runCommand('typeBit32', {});
  const e = await t.runCommand('adjustAutoThreshold', { method: 'Otsu' }, { expectError: true });
  assert.equal(e[0].message, EN.err.thr32bit);
  // reload / restore (the last use of this boot): the montage comes back from the journal (its labels live in the session meta, which the harness's engine-level restore does not read)
  const t2 = await restored(t);
  assert.deepEqual(A(await t2.pixels(mont.docId, 0)), A(mp), 'Try all restored');
  t2.close();
});

await test('Auto Local Threshold: Fiji\'s dialog, the result equals the operation on the engine\'s pixels, undo / redo, refusal on 16 bits', async () => {
  const t = await boot({ volume: VOL });
  await t.open();
  const id = t.activeId();
  const src = Uint8Array.from(await t.pixels(id, 0));
  await t.runCommand('adjustAutoLocalThreshold', { method: 'Sauvola', radius: 7, parameter1: 0.4, parameter2: 100, white: true });
  const spec = lastSpec(t);
  assert.deepEqual(A(spec.fields.map((f) => f.id)), ['method', 'radius', 'special', 'parameter1', 'parameter2', 'white', 'alwaysWhite']);
  assert.equal(spec.fields[0].value, 'Try all');
  assert.deepEqual(A(spec.fields[0].options.map((o) => o.value)), ['Try all', 'Bernsen', 'Contrast', 'Mean', 'Median', 'MidGrey', 'Niblack', 'Otsu', 'Phansalkar', 'Sauvola']);
  assert.deepEqual([spec.fields[1].value, spec.fields[3].value, spec.fields[4].value, spec.fields[5].value], [15, 0, 0, true], 'Radius 15, parameters 0, white objects');
  assert.equal(EN.dlg.thr.special, 'Special parameters (if different from default)');
  assert.equal(EN.dlg.thr.alwaysWhite, 'Thresholded result is always shown in white [255].');
  const out = A(await t.pixels(id, 0));
  assert.deepEqual(out, A(IJThr.localThreshold({ width: VOL.width, height: VOL.height, bitDepth: 8, data: src }, 'Sauvola', 7, 0.4, 100, true)));
  await t.runCommand('editUndo');
  assert.deepEqual(A(await t.pixels(id, 0)), A(src));
  await t.runCommand('editRedo');
  assert.deepEqual(A(await t.pixels(id, 0)), out);
  await t.runCommand('adjustAutoLocalThreshold', { method: 'Try all' });
  const docs = await t.docs();
  const mont = docs[docs.length - 1];
  assert.equal(t.view(mont.docId).annotations.items.length, 9, 'one label per method');
  assert.deepEqual(A(t.view(mont.docId).annotations.items.map((i) => i.text)), ['Bernsen', 'Contrast', 'Mean', 'Median', 'MidGrey', 'Niblack', 'Otsu', 'Phansalkar', 'Sauvola']);
  const montPx = A(await t.pixels(mont.docId, 0));
  for (let i = 0; i < 12 && t.activeId() !== id; i++) await t.runCommand('windowNext');
  await t.runCommand('typeBit16', {});
  const e = await t.runCommand('adjustAutoLocalThreshold', { method: 'Mean' }, { expectError: true });
  assert.equal(e[0].message, EN.err.thr8bit);
  // reload / restore: the in-place run (undone and redone above) and the Try all montage both come back from the journal
  const now = A(await t.pixels(id, 0));
  const t2 = await restored(t); // the last use of this boot
  assert.deepEqual(A(await t2.pixels(id, 0)), now, 'Auto Local Threshold (then Type > 16-bit) restored');
  assert.deepEqual(A(await t2.pixels(mont.docId, 0)), montPx, 'Try all restored');
  t2.close();

});

// the mask every Process > Binary command below works on
async function maskDoc(t) {
  await t.runCommand('binMask');
  const id = t.activeId();
  const info = await infoOf(t, id);
  return { id, w: info.width, h: info.height };
}

await test('Make Binary = Convert to Mask on the image; with Black background off the mask gets an inverting LUT (data stays 255)', async () => {
  const t = await boot({ volume: VOL });
  await t.open();
  const src = A(await t.pixels(t.activeId(), 0));
  const n0 = (await t.docs()).length;
  await t.runCommand('binMakeBinary');
  let docs = await t.docs();
  assert.equal(docs.length, n0 + 1);
  const a = docs[docs.length - 1];
  const pa = A(await t.pixels(a.docId, 0));
  assert.ok(pa.every((v) => v === 0 || v === 255) && pa.includes(255) && pa.includes(0));
  assert.equal(a.channels[0].display.invert, false, 'black background (the default): a normal LUT');
  for (let i = 0; i < 12 && t.activeId() === a.docId; i++) await t.runCommand('windowNext');
  await t.api('thr').settings.set('thr.blackBackground', false);
  await t.runCommand('binMask');
  docs = await t.docs();
  const b = docs[docs.length - 1];
  await until(async () => (await infoOf(t, b.docId)).channels[0].display.invert === true, 'the inverting LUT reaches the engine');
  assert.deepEqual(A(await t.pixels(b.docId, 0)), pa, 'the same pixels (255 = object)');
  void src;
  const t2 = await restored(t);
  assert.deepEqual(A(await t2.pixels(a.docId, 0)), pa, 'Make Binary restored from the journal');
  assert.deepEqual(A(await t2.pixels(b.docId, 0)), pa);
  t2.close();
  t.close();
});

await test('Binary Options: the dialog of Binary.java, the settings it writes, and the commands that read them', async () => {
  const t = await boot({ volume: VOL });
  await t.open();
  const m = await maskDoc(t);
  const bin = Uint8Array.from(await t.pixels(m.id, 0));
  await t.runCommand('binOptions', { iterations: 2, count: 3, padEdges: true, edmOutput: 'float', operation: 'nothing' });
  const spec = lastSpec(t);
  assert.deepEqual(A(spec.fields.map((f) => f.id)), ['iterations', 'count', 'blackBackground', 'padEdges', 'edmOutput', 'operation']);
  assert.deepEqual(A(spec.fields.slice(0, 5).map((f) => f.value)).slice(0, 4), [1, 1, true, false], 'Binary.java defaults, Black background on (Fiji)');
  assert.equal(spec.fields[0].min, 1); assert.equal(spec.fields[0].max, 100); assert.equal(spec.fields[1].max, 8);
  assert.deepEqual(A(spec.fields[4].options.map((o) => o.value)), ['overwrite', 'byte', 'short', 'float']);
  assert.deepEqual(A(spec.fields[5].options.map((o) => o.value)), ['nothing', 'erode', 'dilate', 'open', 'close', 'outline', 'fillHoles', 'skeletonize']);
  assert.equal(EN.dlg.thr.iterations, 'Iterations (1-100):'); assert.equal(EN.dlg.thr.count, 'Count (1-8):'); assert.equal(EN.dlg.thr.padEdges, 'Pad edges when eroding');
  const s = t.api('thr').settings;
  // ImageJ keeps `iterations` in a static field (the run of the program: session data here), count / Pad edges / Black background in Prefs
  assert.deepEqual([s.get('thr.count'), s.get('thr.padEdges'), s.get('thr.edmOutput'), s.get('thr.blackBackground')], [3, true, 'float', true]);
  assert.equal(s.get('thr.iterations'), undefined, 'iterations are not a persistent preference');
  assert.equal(t.api('thr').sessionData.get('thr').iterations, 2);
  const before = A(await t.pixels(m.id, 0));
  await t.runCommand('binErode');
  assert.deepEqual(A(await t.pixels(m.id, 0)), A(B.erode(bin, m.w, m.h, { iterations: 2, count: 3, padEdges: true })), 'Erode reads iterations, count and Pad edges');
  await t.runCommand('editUndo');
  await t.runCommand('binOpen');
  assert.deepEqual(A(await t.pixels(m.id, 0)), A(B.open(bin, m.w, m.h, { iterations: 2, count: 3, padEdges: true })), 'Open too');
  await t.runCommand('editUndo');
  assert.deepEqual(A(await t.pixels(m.id, 0)), before);
  // Do: runs the operation with the new values, and the dialog is shown again with them next time
  await t.runCommand('binOptions', { iterations: 1, count: 1, padEdges: false, operation: 'dilate' });
  assert.deepEqual(A(await t.pixels(m.id, 0)), A(B.dilate(bin, m.w, m.h, { iterations: 1, count: 1 })), 'Do: Dilate');

  await t.runCommand('binOptions', {});
  assert.deepEqual(A(lastSpec(t).fields.slice(0, 4).map((f) => f.value)), [1, 1, true, false]);
  assert.equal(lastSpec(t).fields[4].value, 'float', 'the EDM output comes back');
  // reload / restore: the Do: run is a journaled step
  const t2 = await restored(t);
  assert.deepEqual(A(await t2.pixels(m.id, 0)), A(B.dilate(bin, m.w, m.h, { iterations: 1, count: 1 })), 'Do: Dilate restored');
  t2.close();
});

await test('Binary Options with Black background off: the objects are the 0 pixels (foreground 0), for Erode / Fill Holes / Outline / Skeletonize', async () => {
  const t = await boot({ volume: VOL });
  await t.open();
  const m = await maskDoc(t);
  const bin = Uint8Array.from(await t.pixels(m.id, 0));
  await t.runCommand('binOptions', { blackBackground: false, operation: 'nothing' });
  assert.equal(t.api('thr').settings.get('thr.blackBackground'), false);
  await t.runCommand('binErode');
  assert.deepEqual(A(await t.pixels(m.id, 0)), A(B.erode(bin, m.w, m.h, { foreground: 0 })), 'Erode erodes the 0 objects');
  await t.runCommand('editUndo');
  await t.runCommand('binFillHoles');
  assert.deepEqual(A(await t.pixels(m.id, 0)), A(B.fillHoles(bin, m.w, m.h, { foreground: 0 })), 'Fill Holes');
  await t.runCommand('editUndo');
  await t.runCommand('binOutline');
  const out = A(await t.pixels(m.id, 0));
  assert.deepEqual(out, A(B.outline(bin, m.w, m.h, { foreground: 0 })), 'Outline of the 0 objects');
  await t.runCommand('editUndo');
  await t.runCommand('binSkeletonize');
  assert.ok(A(await t.pixels(m.id, 0)).every((v) => v === 0 || v === 255));
  // an inverting LUT swaps it back: foreground = 255 − fg
  await t.api('thr').setDisplay(m.id, 0, { invert: true });
  await until(async () => (await infoOf(t, m.id)).channels[0].display.invert === true, 'LUT');
  await t.runCommand('editUndo');
  await t.runCommand('binErode');
  assert.deepEqual(A(await t.pixels(m.id, 0)), A(B.erode(bin, m.w, m.h, {})), 'black background off + inverting LUT = 255 objects again');
  t.close();
});

await test('Binary Options: the preview of "Do:" draws the operation without keeping it; Skeletonize has none', async () => {
  const t = await boot({ volume: VOL });
  await t.open();
  const m = await maskDoc(t);
  const before = Uint8Array.from(await t.pixels(m.id, 0));
  const p0 = t.log.previews.length;
  // the harness ticks Preview, waits for the engine's answer and unticks it; OK then runs Do: Erode with the same values
  await t.runCommand('binOptions', { operation: 'erode', iterations: 2 });
  assert.ok(t.log.previews.length > p0, 'a preview was drawn');
  assert.deepEqual(A(await t.pixels(m.id, 0)), A(B.erode(before, m.w, m.h, { iterations: 2 })), 'Do: Erode ran once, on the values of the dialog');
  assert.equal((await infoOf(t, m.id)).undoDepth, 1, 'the preview itself is no undo step');
  await t.runCommand('editUndo');
  // Nothing / Skeletonize have no preview: the dialog says so
  await t.runCommand('binOptions', { operation: 'nothing', iterations: 1 });
  assert.ok(t.log.notes.includes(EN.dlg.thr.previewNone), 'the note: ' + JSON.stringify(t.log.notes.slice(-3)));
  assert.deepEqual(A(await t.pixels(m.id, 0)), A(before));
  t.close();
});

await test('Binary Median: dialog "Radius:" (3), the pixels equal Binary.median, one undo step, undo / redo / reload', async () => {
  const t = await boot({ volume: VOL });
  await t.open();
  const m = await maskDoc(t);
  const bin = Uint8Array.from(await t.pixels(m.id, 0));
  const exp = (r) => A(IJFilters.rank({ width: m.w, height: m.h, bitDepth: 8, data: bin }, r, 'mean').data.map((v) => (v < 128 ? 0 : 255)));
  await t.runCommand('binMedian', {});
  assert.equal(lastSpec(t).fields[0].value, 3, 'IJ.getNumber("Radius:", 3)');
  assert.equal(EN.dlg.thr.medianRadius, 'Radius:');
  const out = A(await t.pixels(m.id, 0));
  assert.deepEqual(out, exp(3));
  assert.equal((await infoOf(t, m.id)).undoDepth, 1);
  await t.runCommand('editUndo');
  assert.deepEqual(A(await t.pixels(m.id, 0)), A(bin), 'undo');
  await t.runCommand('editRedo');
  assert.deepEqual(A(await t.pixels(m.id, 0)), out, 'redo');
  await t.runCommand('editUndo');
  await t.runCommand('binMedian', { radius: 1.5 });
  assert.deepEqual(A(await t.pixels(m.id, 0)), exp(1.5));
  await t.runCommand('editUndo');
  await t.runCommand('binMedian', {});
  assert.equal(lastSpec(t).fields[0].value, 1.5, 'the last radius comes back');
  assert.deepEqual(A(await t.pixels(m.id, 0)), exp(1.5));
  const t2 = await restored(t);
  assert.deepEqual(A(await t2.pixels(m.id, 0)), exp(1.5), 'restored from the journal');
  t2.close();
});

await test('Binary Median and Binary Options on an image that is not binary: ImageJ\'s refusal, no Do:, nothing written', async () => {
  const t = await boot({ volume: Object.assign({}, VOL, { channels: 2 }), channels: 2 });
  await t.open();
  const id = t.activeId();
  const src = [A(await t.pixels(id, 0)), A(await t.pixels(id, 1))];
  assert.ok(src[0].some((v) => v !== 0 && v !== 255), 'a grey image');
  // Binary.setup: "8-bit binary (0 and 255 only) image required." for every argument but "options", the median included
  const e = await t.runCommand('binMedian', { radius: 3 }, { expectError: true });
  assert.equal(e[0].message, EN.err.thrNotBinary);
  assert.match(EN.err.thrNotBinary, /8-bit binary \(0 and 255 only\) image required/);
  assert.equal((await infoOf(t, id)).undoDepth, 0, 'no step');
  for (let c = 0; c < 2; c++) assert.deepEqual(A(await t.pixels(id, c)), src[c], 'channel ' + c + ' untouched');
  // Binary Options: no "Do:" (NO_IMAGE_REQUIRED), so no preview either
  await t.runCommand('binOptions', { iterations: 1 });
  assert.deepEqual(A(lastSpec(t).fields.map((f) => f.id)), ['iterations', 'count', 'blackBackground', 'padEdges', 'edmOutput']);
  assert.equal(lastSpec(t).preview, undefined);
  // a binary image (the mask of this one) gets Do: and the preview, on every channel
  const mk = await maskDoc(t);
  await t.runCommand('binOptions', { iterations: 1 });
  assert.equal(lastSpec(t).fields[lastSpec(t).fields.length - 1].id, 'operation');
  assert.ok(lastSpec(t).preview);
  // the compute op itself
  assert.equal((await t.engine('doc.compute', { docId: mk.id, op: 'thrIsBinary', params: {}, roi: null, channel: 0 })).binary, true);
  assert.equal((await t.engine('doc.compute', { docId: id, op: 'thrIsBinary', params: {}, roi: null, channel: 0 })).binary, false);
  t.close();
});

await test('the Threshold window: the "16-bit histogram" option reaches doc.threshold (lower / upper / level of ImageJ), 256 bins otherwise', async () => {
  const t = await boot({ volume: VOL });
  await t.open();
  await t.runCommand('typeBit16', {});
  const id = t.activeId();
  const src = await t.pixels(id, 0);
  const h16 = new Float64Array(65536); for (const v of src) h16[v]++;
  for (const method of ['Default', 'Otsu', 'Yen', 'IJ_IsoData', 'Minimum']) {
    for (const dark of [true, false]) {
      const r = await t.engine('doc.threshold', { docId: id, channel: 0, method, dark, histogram16: true });
      const exp = T.level(h16, method, { bilevelSubtractOne: false });
      assert.equal(r.level, Math.max(0, exp), `${method} level`);
      assert.deepEqual([r.ijLower, r.ijUpper], dark ? [exp, 65535] : [0, exp], `${method} dark=${dark}`);
      assert.equal(r.histogram16, true);
    }
  }
  const r256 = await t.engine('doc.threshold', { docId: id, channel: 0, method: 'Otsu', dark: true });
  assert.equal(r256.histogram16, false);
  assert.ok(r256.level >= 0 && r256.level <= 255);
  const inv = await t.engine('doc.threshold', { docId: id, channel: 0, method: 'Otsu', dark: true, histogram16: true, invertedLut: true });
  assert.equal(inv.ijLower, 0, 'an inverting LUT swaps the sides');
  // the window offers every AutoThresholder method
  assert.equal(T.methods().length, 17);
  t.close();
});

await test('the Threshold window remembers its "16-bit histogram" box (ThresholdAdjuster Prefs): the saved setting decides the first range', async () => {
  const res = [];
  for (const on of [false, true]) {
    const t = await boot({ volume: VOL });
    await t.open();
    await t.runCommand('typeBit16', {});
    const id = t.activeId();
    if (on) t.api('thr').settings.set('thr.hist16', true);
    assert.equal(await t.api('thr').openTool('threshold'), true);
    await until(() => t.api('thr').state().threshold, 'the first automatic range');
    const th = t.api('thr').state().threshold;
    const ref = await t.engine('doc.threshold', { docId: id, channel: 0, method: 'Default', dark: true, histogram16: on });
    assert.equal(ref.histogram16, on);
    assert.deepEqual([th.lower, th.upper], [ref.lower, ref.upper], 'hist16 = ' + on);
    res.push([th.lower, th.upper]);
    t.close();
  }
  assert.notDeepEqual(res[0], res[1], 'the 256-bin and the 16-bit histogram give different ranges here');
});

console.log(passed + ' tests passed');
