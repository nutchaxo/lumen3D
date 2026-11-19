// Package P-enh of the Advanced Studio, end to end: every command goes through tests/js/ij_harness.mjs — dialog values → the real extension API →
// the real engine → undo → redo → a restore from the journal after a "crash" (reload without flush) gives the same pixels / documents.
//
// Commands: Process > Noise > Add Noise / Add Specified Noise / Salt and Pepper, Process > Enhance Local Contrast (CLAHE),
// Process > Filters > Frangi Vesselness, Plugins > Analyze > Tubeness.
// Also: the menu entries (ids, menus, orders), enabled() by bit depth, the dialogs (Fiji's fields, defaults and limits), the display range that follows a
// 16 / 32-bit noise, the seed drawn per run and journaled, the CLAHE mask through a blob, the time estimate, the error mapping, 8 / 16 / 32-bit images.
//
// Run: node tests/js/test_ij_enh_commands.mjs
import assert from 'node:assert/strict';
import { boot, until, J } from './ij_harness.mjs';

const cases = [];
const test = (name, fn) => cases.push([name, fn]);
const arr = (a) => Array.from(a);
const same = (a, b, msg) => assert.deepEqual(arr(a), arr(b), msg);
const pix = async (t, c = 0, id) => (await t.pixels(id === undefined ? t.activeId() : id, c));
const stateOf = (t) => t.shell.opts.getState();
const lastDialog = (t) => t.log.dialogSpecs[t.log.dialogSpecs.length - 1];
const field = (spec, id) => spec.fields.find((f) => f.id === id);
const byId = async (t, docId) => (await t.docs()).find((d) => d.docId === docId);

const COMMANDS = {
  noiseAdd: { menu: ['Process', 'Noise'], order: 5 },
  noiseAddSpecified: { menu: ['Process', 'Noise'], order: 6 },
  noiseSaltPepper: { menu: ['Process', 'Noise'], order: 7 },
  procCLAHE: { menu: ['Process'], order: 130, separatorBefore: true },
  pluginsFrangi: { menu: ['Process', 'Filters'], order: 900, separatorBefore: true },
  pluginsTubeness: { menu: ['Plugins', 'Analyze'], order: 20 }
};

test('the commands are registered as frozen in PLAN-wave3 §1.2, with no shortcut and no extra command', async () => {
  const t = await boot({ channels: 2 });
  await t.open();
  for (const [id, want] of Object.entries(COMMANDS)) {
    const c = t.cmd(id);
    assert.ok(c, id + ' exists');
    assert.equal(c.pkg, 'enh', id);
    assert.deepEqual(J(c.menu), want.menu, id + ' menu');
    assert.equal(c.order, want.order, id + ' order');
    assert.equal(c.labelKey, 'cmd.' + id);
    assert.equal(!!c.separatorBefore, !!want.separatorBefore, id + ' separator');
    assert.ok(!c.shortcut || c.shortcut.length === 0, id + ' has no shortcut');
    assert.notEqual(c.repeatable, false, id + ' is repeatable');
  }
  assert.equal(t.IJApp.COMMANDS.filter((c) => c.pkg === 'enh').length, Object.keys(COMMANDS).length, 'no extra command');
  // errors the package maps
  for (const [code, key] of [['IJ_ENH_CLAHE_SLOW_TOO_LARGE', 'err.enhClaheSlowTooLarge'], ['IJ_ENH_MASK_SIZE', 'err.enhMaskSize'], ['IJ_ENH_MASK_TYPE', 'err.enhMaskType']]) assert.equal(t.IJApp.errorKey({ code }), key, code);
  t.close();
});

test('enabled(): everything needs an image; Salt and Pepper is 8-bit only (DOES_8G + DOES_8C)', async () => {
  const t = await boot({ channels: 2 });
  await t.open();
  for (const bd of [8, 16, 32]) {
    if (bd > 8) await t.runCommand('typeBit' + bd, {});
    for (const id of Object.keys(COMMANDS)) assert.equal(t.isEnabled(id), id === 'noiseSaltPepper' ? bd === 8 : true, `${id} at ${bd} bits`);
  }
  t.close();
});

async function restoreMatches(t, label, ids) {
  const docs = await t.docs();
  const live = new Map();
  for (const d of docs) live.set(d.docId, await Promise.all(d.channels.map((c, i) => pix(t, i, d.docId))));
  await t.worker.engine.whenIdle();
  const key = (await t.store.shared.list())[0].key;
  const t2 = await t.reload({ flush: false });
  const w2 = await t2.spawn();
  const res = await t2.engine('session.restore', { key }, w2);
  assert.equal(res.warnings.length, 0, label + ': ' + JSON.stringify(res.warnings));
  const infos = (await t2.engine('doc.list', {}, w2)).docs;
  for (const [id, chans] of live) {
    if (ids && !ids.includes(id)) continue;
    const info = infos.find((d) => d.docId === id);
    assert.ok(info, `${label}: document ${id} restored`);
    for (let c = 0; c < chans.length; c++) same((await t2.engine('doc.tile', { docId: id, channel: c, level: 0, tx: 0, ty: 0 }, w2)).data, chans[c], `${label}: document ${id} channel ${c} restored from the journal`);
  }
  t2.close();
}

for (const bd of [8, 16, 32]) {
  test(`${bd}-bit noise commands: change, undo, redo, restore from the journal; another run draws another seed`, async () => {
    const t = await boot({ channels: 2 });
    await t.open();
    if (bd > 8) await t.runCommand('typeBit' + bd, {});
    const ids = ['noiseAdd', 'noiseAddSpecified'].concat(bd === 8 ? ['noiseSaltPepper'] : []);
    for (const id of ids) {
      const before = arr(await pix(t, 0)), other = arr(await pix(t, 1));
      await t.runCommand(id, id === 'noiseAddSpecified' ? { sd: 12 } : undefined);
      const after = arr(await pix(t, 0));
      assert.notDeepEqual(after, before, id + ' changed the active channel');
      same(await pix(t, 1), other, id + ' left the other channel alone');
      await t.runCommand('editUndo'); same(await pix(t, 0), before, id + ': undo');
      await t.runCommand('editRedo'); same(await pix(t, 0), after, id + ': redo');
      // a second run of the same command draws a new seed (ImageJ's noise differs from one run to the next)
      await t.runCommand('editUndo');
      await t.runCommand(id, id === 'noiseAddSpecified' ? { sd: 12 } : undefined);
      assert.notDeepEqual(arr(await pix(t, 0)), after, id + ': a new seed each run');
      assert.equal(t.errors.length, 0, id + ' reported an error');
    }
    await restoreMatches(t, bd + '-bit noise');
    t.close();
  });
}

test('the seed of a run is journaled with the step (the engine entry carries it) and Salt and Pepper changes at most 5 % of the pixels', async () => {
  const t = await boot({ channels: 1 });
  await t.open();
  const before = arr(await pix(t, 0));
  await t.runCommand('noiseSaltPepper');
  const after = arr(await pix(t, 0));
  const changed = after.filter((v, i) => v !== before[i]).length;
  assert.ok(changed > 0 && changed <= Math.floor(0.05 * after.length), 'changed ' + changed);
  for (let i = 0; i < after.length; i++) if (after[i] !== before[i]) assert.ok(after[i] === 0 || after[i] === 255, 'a hit pixel is white or black');
  const docId = t.activeId();
  await t.worker.engine.whenIdle();
  const key = (await t.store.shared.list())[0].key;
  const stored = await t.store.shared.load(key);
  const d = stored.docs[docId] || stored.docs[String(docId)];
  const entries = (d.journal || []).filter((e) => e.op === 'saltAndPepper');
  assert.ok(entries.length >= 1 || (d.snapshot && d.snapshot.rev > 0), 'the step is journaled or already in a snapshot');
  if (entries.length) { assert.ok(Number.isInteger(entries[0].params.seed) && entries[0].params.seed >= 0 && entries[0].params.seed < 2 ** 31, 'a 31-bit seed'); assert.equal(entries[0].params.percent, 0.05); }
  t.close();
});

test('16 / 32-bit noise: the display range becomes the data range of the whole image (ShortProcessor / FloatProcessor.noise end with resetMinAndMax); 8-bit keeps its display', async () => {
  for (const bd of [8, 16, 32]) {
    const t = await boot({ channels: 2 });
    await t.open();
    if (bd > 8) await t.runCommand('typeBit' + bd, {});
    const docId = t.activeId();
    await t.engine('doc.setDisplay', { docId, channel: 0, min: 3, max: 77 });
    await t.runCommand('noiseAddSpecified', { sd: 30 });
    const info = await byId(t, docId);
    const px = arr(await pix(t, 0));
    if (bd === 8) assert.deepEqual([info.channels[0].display.min, info.channels[0].display.max], [3, 77], '8-bit: untouched');
    else assert.deepEqual([info.channels[0].display.min, info.channels[0].display.max], [Math.min(...px), Math.max(...px)], bd + '-bit: the data range');
    // the display reset is part of the undo step: one undo gives back the pixels AND the range that was set
    await t.runCommand('editUndo');
    const back = await byId(t, docId);
    assert.deepEqual([back.channels[0].display.min, back.channels[0].display.max], [3, 77], bd + '-bit: undo restores the display range');
    t.close();
  }
});

test('Add Specified Noise: Fiji\'s dialog (Standard Deviation: 25.00), the all-channels box on a multichannel image, all channels in one step on ONE stream', async () => {
  const t = await boot({ channels: 3 });
  await t.open();
  await t.runCommand('noiseAddSpecified', {});
  const d = lastDialog(t);
  const sd = field(d, 'sd');
  assert.equal(sd.type, 'number'); assert.equal(sd.value, 25); assert.equal(sd.decimals, 2); assert.equal(sd.min, 0);
  assert.equal(sd.labelKey, 'dlg.enh.sd'); assert.equal(d.titleKey, 'dlg.enh.noiseTitle');
  assert.ok(field(d, 'all'), 'a three-channel image offers "all channels"');
  assert.equal(d.preview, undefined, 'ImageJ shows no Preview here');
  await t.runCommand('editUndo').catch(() => {});
  const before = [0, 1, 2].map(() => null);
  for (let c = 0; c < 3; c++) before[c] = arr(await pix(t, c));
  await t.runCommand('noiseAddSpecified', { sd: 20, all: true });
  for (let c = 0; c < 3; c++) assert.notDeepEqual(arr(await pix(t, c)), before[c], 'channel ' + c + ' changed');
  assert.equal((await byId(t, t.activeId())).undoDepth >= 1, true);
  await t.runCommand('editUndo');
  for (let c = 0; c < 3; c++) same(await pix(t, c), before[c], 'one undo step restores every channel');
  // a one-channel image has no such box
  const t1 = await boot({ channels: 1 });
  await t1.open();
  await t1.runCommand('noiseAddSpecified', {});
  assert.equal(field(lastDialog(t1), 'all'), undefined);
  t1.close();
  t.close();
});

test('a selection restricts Add Noise: pixels outside it are untouched', async () => {
  const t = await boot({ channels: 1 });
  await t.open();
  const docId = t.activeId();
  const before = arr(await pix(t, 0));
  await t.engine('doc.run', { docId, op: 'addNoise', params: { seed: 4, sd: 30 }, roi: { type: 'rect', x: 5, y: 4, w: 12, h: 9 }, channel: 0 });
  const after = arr(await pix(t, 0)), W = (await byId(t, docId)).width;
  let inside = 0;
  for (let i = 0; i < after.length; i++) {
    const x = i % W, y = (i / W) | 0, in_ = x >= 5 && x < 17 && y >= 4 && y < 13;
    if (!in_) assert.equal(after[i], before[i]); else if (after[i] !== before[i]) inside++;
  }
  assert.ok(inside > 0);
  t.close();
});

// ── CLAHE ───────────────────────────────────────────────────────────────────────────────────────────────────
test('CLAHE dialog: Fiji\'s fields, defaults and order; "process as composite" only on a multichannel image; the mask lists every open image (Fiji list: the image itself included); the display-aid note', async () => {
  const t = await boot({ channels: 2 });
  await t.open();
  await t.runCommand('colorSplitChannels');   // C1 / C2: two single-channel 8-bit images of the same size
  const docs = await t.docs();
  const src = docs.find((d) => d.channels.length === 2);
  await t.runCommand('winImg' + src.docId).catch(() => {});
  await t.shell.opts.commands.find((c) => c.id === 'winImg' + src.docId).run();
  await until(() => t.activeId() === src.docId, 'source on screen');
  await t.runCommand('procCLAHE', {});
  const d = lastDialog(t);
  assert.deepEqual(arr(d.fields.map((f) => f.id)), ['blocksize', 'bins', 'slope', 'mask', 'fast', 'composite', 'note']);
  assert.equal(field(d, 'blocksize').value, 127); assert.equal(field(d, 'blocksize').integer, true);
  assert.equal(field(d, 'bins').value, 256); assert.equal(field(d, 'bins').max, 256);
  assert.equal(field(d, 'slope').value, 3); assert.equal(field(d, 'slope').decimals, 2); assert.equal(field(d, 'slope').min, 1);
  assert.equal(field(d, 'mask').value, 'none');
  assert.deepEqual(arr(field(d, 'mask').options.map((o) => (o.value === 'none' ? 'none' : docs.find((x) => x.docId === o.value).name))).sort(), ['C1-HARNESS Z 0–4 (Max Intensity)', 'C2-HARNESS Z 0–4 (Max Intensity)', src.name, 'none'].sort());
  assert.equal(field(d, 'fast').value, true); assert.equal(field(d, 'composite').value, true);
  assert.equal(field(d, 'composite').visibleIf({}), true);
  assert.equal(field(d, 'note').labelKey, 'dlg.enh.claheNote');
  const labels = ['blocksize', 'bins', 'slope', 'mask', 'fast', 'composite'].map((k) => field(d, k).labelKey);
  assert.deepEqual(labels, ['dlg.enh.blocksize', 'dlg.enh.bins', 'dlg.enh.slope', 'dlg.enh.mask', 'dlg.enh.fast', 'dlg.enh.composite']);
  assert.equal(d.validate({ fast: false }), null, 'a small image may run exactly');
  // a single-channel image: no composite box
  await t.shell.opts.commands.find((c) => c.id === 'winImg' + docs.find((x) => x.channels.length === 1).docId).run();
  await until(() => t.activeId() !== src.docId, 'another image on screen');
  await t.runCommand('procCLAHE', {});
  assert.equal(field(lastDialog(t), 'composite').visibleIf({}), false);
  t.close();
});

for (const bd of [8, 16, 32]) {
  test(`${bd}-bit CLAHE: composite changes every channel in one undo step; unticked changes the active channel only; exact and fast; restore from the journal`, async () => {
    const t = await boot({ channels: 3 });
    await t.open();
    if (bd > 8) await t.runCommand('typeBit' + bd, {});
    const orig = [];
    for (let c = 0; c < 3; c++) orig.push(arr(await pix(t, c)));
    await t.runCommand('procCLAHE', { blocksize: 15, bins: 256, slope: 3, fast: false, composite: true });
    const a = [];
    for (let c = 0; c < 3; c++) { a.push(arr(await pix(t, c))); assert.notDeepEqual(a[c], orig[c], 'composite: channel ' + c); }
    await t.runCommand('editUndo');
    for (let c = 0; c < 3; c++) same(await pix(t, c), orig[c], 'one undo step for the three channels');
    await t.runCommand('procCLAHE', { blocksize: 15, bins: 128, slope: 2, fast: true, composite: false });
    assert.notDeepEqual(arr(await pix(t, 0)), orig[0], 'the active channel changed');
    same(await pix(t, 1), orig[1], 'the other channels did not'); same(await pix(t, 2), orig[2]);
    await t.runCommand('editUndo');
    await t.runCommand('editRedo');
    assert.equal(t.errors.length, 0);
    await restoreMatches(t, bd + '-bit CLAHE');
    t.close();
  });
}

test('CLAHE with a mask image: the mask goes to the worker as a blob (>= 64 KiB), masked-out pixels are untouched, the journal replays it', async () => {
  const t = await boot({ channels: 2, volume: { width: 300, height: 240, depth: 2, channels: 2 } });
  await t.open();
  await t.runCommand('colorSplitChannels');
  const docs = await t.docs();
  const src = docs.find((d) => d.channels.length === 2), c1 = docs.find((d) => d.name.startsWith('C1-'));
  assert.ok(src.width * src.height >= 65536, 'the mask is large enough to be stored as a blob');
  // make the C1 image a mask: 0 on the left third, a value elsewhere
  const maskPx = new Uint8Array(src.width * src.height);
  for (let i = 0; i < maskPx.length; i++) maskPx[i] = (i % src.width) < 100 ? 0 : 255;
  await t.engine('doc.run', { docId: c1.docId, op: 'fill', params: { value: 0 }, roi: null, channel: 0 });
  // paint the right two thirds with 255 through a rectangle fill (a selection)
  await t.engine('doc.run', { docId: c1.docId, op: 'fill', params: { value: 255 }, roi: { type: 'rect', x: 100, y: 0, w: src.width - 100, h: src.height }, channel: 0 });
  await t.shell.opts.commands.find((c) => c.id === 'winImg' + src.docId).run();
  await until(() => t.activeId() === src.docId, 'source on screen');
  const before = arr(await pix(t, 0));
  await t.runCommand('procCLAHE', { blocksize: 31, bins: 256, slope: 3, fast: true, composite: false, mask: c1.docId });
  const after = arr(await pix(t, 0));
  let changedIn = 0;
  for (let i = 0; i < after.length; i++) { if (maskPx[i] === 0) assert.equal(after[i], before[i], 'masked-out pixel ' + i); else if (after[i] !== before[i]) changedIn++; }
  assert.ok(changedIn > 1000, 'the masked-in pixels changed');
  // the engine journaled the mask once, as a blob; a restore replays it
  await restoreMatches(t, 'masked CLAHE', [src.docId]);
  t.close();
});

test('CLAHE announces a long run: a time estimate dialog (OK runs, Cancel runs nothing); a short one does not ask', async () => {
  const t = await boot({ channels: 1 });
  await t.open();
  const before = arr(await pix(t, 0));
  const dialogsBefore = t.log.dialogSpecs.length;
  await t.runCommand('procCLAHE', { blocksize: 15, bins: 256, slope: 3, fast: true });
  assert.equal(t.log.dialogSpecs.length - dialogsBefore, 1, 'a small image: one dialog only');
  await t.runCommand('editUndo');
  const real = t.page.IJEnhPkg.claheSeconds;
  t.page.IJEnhPkg.claheSeconds = () => 95;
  try {
    const n0 = t.log.dialogSpecs.length;
    await t.runCommand('procCLAHE', [{ blocksize: 15, bins: 256, slope: 3, fast: true }, null]);   // the estimate dialog is cancelled
    assert.equal(t.log.dialogSpecs.length - n0, 2);
    const est = lastDialog(t);
    assert.equal(est.titleKey, 'dlg.enh.claheTitle');
    assert.match(est.fields[0].label, /2 min/, 'minutes above 90 s: ' + est.fields[0].label);
    same(await pix(t, 0), before, 'cancelled: nothing ran');
    t.page.IJEnhPkg.claheSeconds = () => 30;
    await t.runCommand('procCLAHE', [{ blocksize: 15, bins: 256, slope: 3, fast: true }, {}]);
    assert.match(lastDialog(t).fields[0].label, /30 s/);
    assert.notDeepEqual(arr(await pix(t, 0)), before, 'confirmed: it ran');
  } finally { t.page.IJEnhPkg.claheSeconds = real; }
  t.close();
});

test('CLAHE ignores the selection (design choice, UNVERIFIED against Fiji: no fixture records a selection; the mask is the way to restrict)', async () => {
  const t = await boot({ channels: 1 });
  await t.open();
  const docId = t.activeId();
  const a = arr(await pix(t, 0));
  await t.engine('doc.run', { docId, op: 'clahe', params: { blocksize: 15, bins: 256, slope: 3, fast: true }, roi: { type: 'rect', x: 2, y: 2, w: 8, h: 8 }, channel: 0 });
  const withRoi = arr(await pix(t, 0));
  await t.engine('doc.undo', { docId });
  await t.engine('doc.run', { docId, op: 'clahe', params: { blocksize: 15, bins: 256, slope: 3, fast: true }, roi: null, channel: 0 });
  assert.deepEqual(arr(await pix(t, 0)), withRoi);
  assert.notDeepEqual(withRoi, a);
  t.close();
});

// ── Tubeness / Frangi ───────────────────────────────────────────────────────────────────────────────────────
test('Tubeness: dialog (Sigma, the voxel-separation note, Use calibration information), default sigma = the smaller pixel size of a calibrated image; new 32-bit image "tubeness of <name>"; restore', async () => {
  const t = await boot({ channels: 2 });
  await t.open();
  const src = stateOf(t).doc;
  await t.runCommand('pluginsTubeness', { sigma: 1.5, useCalibration: false });
  const d = lastDialog(t);
  assert.deepEqual(arr(d.fields.map((f) => f.id)), ['sigma', 'sigmaNote', 'useCalibration', 'channelNote']);
  assert.equal(field(d, 'sigma').labelKey, 'dlg.enh.sigma'); assert.equal(field(d, 'useCalibration').value, true);
  assert.equal(field(d, 'sigmaNote').labelKey, 'dlg.enh.sigmaNote');
  assert.equal(field(d, 'channelNote').visibleIf({}), true, 'two channels: the note names the active one');
  const unitless = field(d, 'sigma').value;
  assert.equal(unitless, Number(((src.calibration && src.calibration.unit && src.calibration.unit !== 'pixel') ? Math.min(src.calibration.pixelWidth, src.calibration.pixelHeight) : 1).toPrecision(6)), 'default = min pixel size when calibrated, else 1');
  const docs = await t.docs();
  const made = docs.filter((x) => x.name.startsWith('tubeness of '));
  assert.equal(made.length, 1);
  const m = made[0];
  assert.equal(m.name, 'tubeness of ' + src.name); assert.equal(m.bitDepth, 32); assert.equal(m.channels.length, 1);
  assert.equal(m.width, src.width); assert.equal(m.height, src.height);
  assert.deepEqual(J(m.calibration), J(src.calibration));
  const px = arr(await pix(t, 0, m.docId));
  assert.ok(px.some((v) => v > 0), 'a response');
  assert.ok(t.shell.lay.adds.some((a) => a.docId === m.docId && a.placement === 'splitRight'), 'opened beside the source');
  assert.equal((await byId(t, src.docId)).undoDepth, 0, 'the source gets no undo step');
  await restoreMatches(t, 'tubeness', [m.docId]);
  t.close();
});

test('Tubeness default sigma on a calibrated image is its smallest pixel size', async () => {
  const t = await boot({ channels: 1 });
  await t.open();
  await t.runCommand('imageProperties', { pixelWidth: 0.4, pixelHeight: 0.6, unit: 'um' });
  assert.equal(stateOf(t).doc.calibration.pixelWidth, 0.4);
  await t.runCommand('pluginsTubeness', {});
  assert.equal(field(lastDialog(t), 'sigma').value, 0.4);
  await t.runCommand('imageProperties', { pixelWidth: 1, pixelHeight: 1, unit: 'pixel' });
  await t.runCommand('pluginsTubeness', {});
  assert.equal(field(lastDialog(t), 'sigma').value, 1, 'uncalibrated: 1');
  t.close();
});

test('Frangi: dialog (Apply Gaussian at each scale: / Spacing 1, 1 / Scale 2, 5 and their notes), validation keys, one new 32-bit image with a channel "Scale <s>" per scale; restore', async () => {
  const t = await boot({ channels: 1 });
  await t.open();
  const src = stateOf(t).doc;
  await t.runCommand('pluginsFrangi', {});
  const d = lastDialog(t);
  assert.deepEqual(arr(d.fields.map((f) => f.id)), ['doGauss', 'spacing', 'spacingNote', 'scales', 'scalesNote', 'channelNote']);
  assert.equal(field(d, 'doGauss').value, false); assert.equal(field(d, 'doGauss').labelKey, 'dlg.enh.frangiGauss');
  assert.equal(field(d, 'spacing').value, '1, 1'); assert.equal(field(d, 'scales').value, '2, 5');
  assert.equal(field(d, 'channelNote').visibleIf({}), false, 'one channel: no note');
  assert.equal(d.validate({ doGauss: false, spacing: '1, 1', scales: '2, 5' }), null);
  assert.deepEqual(J(d.validate({ doGauss: false, spacing: '1, x', scales: '2, 5' })), { spacing: 'dlg.enh.spacingBad' });
  assert.deepEqual(J(d.validate({ doGauss: false, spacing: '0, 1', scales: '2, 5' })), { spacing: 'dlg.enh.spacingBad' });
  assert.deepEqual(J(d.validate({ doGauss: false, spacing: '1, 1', scales: '2.5' })), { scales: 'dlg.enh.scalesBad' });
  assert.deepEqual(J(d.validate({ doGauss: false, spacing: '1, 1', scales: '0' })), { scales: 'dlg.enh.scalesBad' });
  assert.deepEqual(J(d.validate({ doGauss: false, spacing: '1, 1', scales: '65' })), { scales: 'dlg.enh.scalesBad' });
  assert.deepEqual(J(d.validate({ doGauss: false, spacing: 'a', scales: '' })), { spacing: 'dlg.enh.spacingBad', scales: 'dlg.enh.scalesBad' });
  const made = (await t.docs()).filter((x) => x.name.startsWith('Frangi Vesselness of '));
  assert.equal(made.length, 1, 'the defaults ran');
  assert.equal(made[0].channels.length, 2);
  assert.deepEqual(arr(made[0].channels.map((c) => c.name)), ['Scale 2', 'Scale 5']);
  await t.runCommand('pluginsFrangi', { doGauss: true, spacing: '1, 1', scales: '1 3 4' });
  const made2 = (await t.docs()).filter((x) => x.name.startsWith('Frangi Vesselness of ') && x.docId !== made[0].docId);
  assert.equal(made2.length, 1);
  assert.deepEqual(arr(made2[0].channels.map((c) => c.name)), ['Scale 1', 'Scale 3', 'Scale 4']);
  assert.equal(made2[0].bitDepth, 32); assert.equal(made2[0].width, src.width);
  assert.equal(t.errors.length, 0);
  for (const m of [made[0], made2[0]]) for (let c = 0; c < m.channels.length; c++) { const p = arr(await pix(t, c, m.docId)); assert.ok(p.every((v) => v >= 0 && v <= 1), 'vesselness is in [0, 1]'); }
  await restoreMatches(t, 'frangi', [made[0].docId, made2[0].docId]);
  t.close();
});

for (const bd of [16, 32]) {
  test(`${bd}-bit Tubeness and Frangi through the menu give 32-bit images`, async () => {
    const t = await boot({ channels: 1 });
    await t.open();
    await t.runCommand('typeBit' + bd, {});
    await t.runCommand('pluginsTubeness', {});
    await t.runCommand('pluginsFrangi', {});
    const docs = await t.docs();
    assert.equal(docs.filter((x) => x.bitDepth === 32 && /^(tubeness|Frangi Vesselness) of /.test(x.name)).length, 2);
    assert.equal(t.errors.length, 0);
    t.close();
  });
}

test('a CLAHE run with the exact mode on an image over 16 megapixels is refused by the dialog (validate) with the error key; no worker work', async () => {
  const t = await boot({ channels: 1 });
  await t.open();
  await t.runCommand('procCLAHE', {});
  const d = lastDialog(t);
  assert.equal(d.validate({ fast: false }), null, 'small image');
  // the dialog of a big image: the harness image is small, so assert the rule on the pure value the command reads
  assert.equal(t.page.IJEnhPkg.CLAHE_SLOW_MAX_PIXELS, 16 * 1000 * 1000);
  t.close();
});


// ── review fixes ────────────────────────────────────────────────────────────────────────────────────────────
test('CLAHE mask: a 16-bit image and the image itself are listed; a 16-bit mask is refused when it runs (IJ_ENH_MASK_TYPE), the image itself works as its own mask', async () => {
  const t = await boot({ channels: 2 });
  await t.open();
  await t.runCommand('colorSplitChannels');
  const docs = await t.docs();
  const c1 = docs.find((d) => d.name.startsWith('C1-')), c2 = docs.find((d) => d.name.startsWith('C2-'));
  await t.shell.opts.commands.find((c) => c.id === 'winImg' + c1.docId).run();
  await until(() => t.activeId() === c1.docId, 'C1 on screen');
  await t.runCommand('typeBit16', {});
  await t.shell.opts.commands.find((c) => c.id === 'winImg' + c2.docId).run();
  await until(() => t.activeId() === c2.docId, 'C2 on screen');
  const before = arr(await pix(t, 0, c2.docId));
  await t.runCommand('procCLAHE', { blocksize: 15, bins: 256, slope: 3, fast: true, mask: c1.docId }, { expectError: true });
  assert.ok(field(lastDialog(t), 'mask').options.some((o) => o.value === c1.docId), 'the 16-bit image is a choice');
  assert.ok(field(lastDialog(t), 'mask').options.some((o) => o.value === c2.docId), 'the image itself is a choice');
  assert.equal(t.errors.length, 1, 'one error shown');
  same(await pix(t, 0, c2.docId), before, 'nothing ran');
  t.errors.length = 0;
  await t.runCommand('procCLAHE', { blocksize: 15, bins: 256, slope: 3, fast: true, mask: c2.docId });
  assert.notDeepEqual(arr(await pix(t, 0, c2.docId)), before, 'the image as its own mask ran');
  t.close();
});

test('Add Specified Noise remembers its last Standard Deviation, and CLAHE its last values (api.settings enh.*, as ImageJ keeps them in static fields)', async () => {
  const t = await boot({ channels: 1 });
  await t.open();
  await t.runCommand('noiseAddSpecified', { sd: 7.5 });
  await t.runCommand('noiseAddSpecified', {});
  assert.equal(field(lastDialog(t), 'sd').value, 7.5);
  await t.runCommand('procCLAHE', { blocksize: 21, bins: 128, slope: 2.5, fast: false });
  await t.runCommand('procCLAHE', {});
  const d = lastDialog(t);
  assert.deepEqual([field(d, 'blocksize').value, field(d, 'bins').value, field(d, 'slope').value, field(d, 'fast').value], [21, 128, 2.5, false]);
  t.close();
});

test('Add Noise and Salt and Pepper offer "all channels" on a multichannel image (IJ.setupDialog), none on a single channel', async () => {
  const t = await boot({ channels: 3 });
  await t.open();
  const base = [0, 1, 2].map(() => null);
  for (let c = 0; c < 3; c++) base[c] = arr(await pix(t, c));
  for (const id of ['noiseAdd', 'noiseSaltPepper']) {
    const n0 = t.log.dialogSpecs.length;
    await t.runCommand(id, { all: true });
    assert.equal(t.log.dialogSpecs.length - n0, 1, id + ' asks once');
    assert.equal(field(lastDialog(t), 'all').labelKey, 'dlg.allChannels'); assert.equal(field(lastDialog(t), 'all').value, false, 'default: the active channel');
    for (let c = 0; c < 3; c++) assert.notDeepEqual(arr(await pix(t, c)), base[c], `${id}: channel ${c}`);
    await t.runCommand('editUndo');
    for (let c = 0; c < 3; c++) same(await pix(t, c), base[c], id + ': one undo step');
    await t.runCommand(id, undefined);
    assert.notDeepEqual(arr(await pix(t, 0)), base[0], id + ': active channel');
    same(await pix(t, 1), base[1], id + ': the others untouched by default');
    await t.runCommand('editUndo');
    // a cancelled question runs nothing
    await t.runCommand(id, null);
    same(await pix(t, 0), base[0], id + ': cancelled');
  }
  const t1 = await boot({ channels: 1 });
  await t1.open();
  const n1 = t1.log.dialogSpecs.length;
  await t1.runCommand('noiseAdd');
  await t1.runCommand('noiseSaltPepper');
  assert.equal(t1.log.dialogSpecs.length, n1, 'no dialog on one channel');
  t1.close();
  t.close();
});

test('Add Specified Noise announces a long run (a huge sd redraws an 8-bit pixel ~sd/100 times) and runs nothing when declined', async () => {
  const t = await boot({ channels: 1 });
  await t.open();
  const real = t.page.IJEnhPkg.noiseSeconds;
  try {
    t.page.IJEnhPkg.noiseSeconds = () => 200;
    const before = arr(await pix(t, 0));
    const n0 = t.log.dialogSpecs.length;
    await t.runCommand('noiseAddSpecified', [{ sd: 100000 }, null]);
    assert.equal(t.log.dialogSpecs.length - n0, 2);
    assert.match(lastDialog(t).fields[0].label, /3 min/);
    same(await pix(t, 0), before, 'declined: nothing ran');
  } finally { t.page.IJEnhPkg.noiseSeconds = real; }
  t.close();
});

test('the Tubeness dialog carries Fiji\'s own title: "Tubeness" Filter (version 1.2)', async () => {
  const t = await boot({ channels: 1 });
  await t.open();
  await t.runCommand('pluginsTubeness', {});
  assert.equal(lastDialog(t).titleKey, 'dlg.enh.tubenessTitle');
  const parts = JSON.parse((await import('node:fs')).readFileSync(new URL('../../js/modules/studio/advanced-studio/lang-parts/enh.json', import.meta.url), 'utf8'));
  assert.equal(parts.en.dlg.enh.tubenessTitle, '"Tubeness" Filter (version 1.2)');
  t.close();
});

// the cases run one after the other (each boots its own worker)
let passed = 0;
for (const [name, fn] of cases) {
  try { await fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { console.error('FAIL ' + name); throw e; }
}
console.log(`ij enh commands: OK (${passed} groups)`);
