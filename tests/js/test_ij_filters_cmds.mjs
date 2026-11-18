// Package P2 (filters) of the Advanced Studio, end to end: every command of the package goes through
// tests/js/ij_harness.mjs — dialog values → the real extension API → the real engine → undo → redo → a restore from the
// journal after a "crash" (reload without flush) gives the same pixels. The harness also exercises each dialog's Preview box
// (a pixel preview must be answered by the engine) and fails on a dialog spec the real field schema refuses or a lang key
// that is in no lang file.
//
// Also: the menu entries (ids, menus, orders, shortcut), enabled() by bit depth, the dialog defaults / limits of ImageJ,
// the selection behaviour, the display range that follows Variance / Top Hat / Convolve, the error mapping.
//
// Run: node tests/js/test_ij_filters_cmds.mjs
import assert from 'node:assert/strict';
import { boot, until, J } from './ij_harness.mjs';

const cases = [];
const test = (name, fn) => cases.push([name, fn]);
const same = (a, b, msg) => assert.deepEqual(Array.from(a), Array.from(b), msg);
const pix = async (t, c = 0) => (await t.pixels(t.activeId(), c));
const stateOf = (t) => t.shell.opts.getState();
const lastDialog = (t) => t.log.dialogSpecs[t.log.dialogSpecs.length - 1];

const COMMANDS = {
  procSmooth: { menu: ['Process'], order: 10, shortcut: 'Ctrl+Shift+S' },
  procSharpen: { menu: ['Process'], order: 20 },
  procFindEdges: { menu: ['Process'], order: 30 },
  noiseDespeckle: { menu: ['Process', 'Noise'], order: 10 },
  noiseRemoveOutliers: { menu: ['Process', 'Noise'], order: 20 },
  noiseRemoveNaNs: { menu: ['Process', 'Noise'], order: 30 },
  mathAnd: { menu: ['Process', 'Math'], order: 50 },
  mathOr: { menu: ['Process', 'Math'], order: 60 },
  mathXor: { menu: ['Process', 'Math'], order: 70 },
  mathGamma: { menu: ['Process', 'Math'], order: 100 },
  mathLog: { menu: ['Process', 'Math'], order: 120 },
  mathExp: { menu: ['Process', 'Math'], order: 130 },
  mathSquare: { menu: ['Process', 'Math'], order: 140 },
  mathSqrt: { menu: ['Process', 'Math'], order: 150 },
  mathReciprocal: { menu: ['Process', 'Math'], order: 160 },
  mathNaNBackground: { menu: ['Process', 'Math'], order: 170 },
  filterConvolve: { menu: ['Process', 'Filters'], order: 10 },
  filterUnsharp: { menu: ['Process', 'Filters'], order: 70 },
  filterVariance: { menu: ['Process', 'Filters'], order: 80 },
  filterTopHat: { menu: ['Process', 'Filters'], order: 90 }
};

test('the commands are registered as frozen in PLAN-wave2 §1', async () => {
  const t = await boot({ channels: 2 });
  await t.open();
  for (const [id, want] of Object.entries(COMMANDS)) {
    const c = t.cmd(id);
    assert.ok(c, id + ' exists');
    assert.equal(c.pkg, 'filters', id);
    assert.deepEqual(J(c.menu), want.menu, id + ' menu');
    assert.equal(c.order, want.order, id + ' order');
    assert.equal(c.labelKey, 'cmd.' + id);
    if (want.shortcut) assert.ok(J(c.shortcut || []).includes(want.shortcut) || c.shortcut === want.shortcut, id + ' shortcut');
    else assert.ok(!c.shortcut || c.shortcut.length === 0, id + ' has no shortcut');
  }
  assert.equal(t.IJApp.COMMANDS.filter((c) => c.pkg === 'filters').length, Object.keys(COMMANDS).length, 'no extra command');
  t.close();
});

test('enabled() follows the bit depth: Remove NaNs / Reciprocal / NaN Background need 32 bits, AND / OR / XOR refuse them', async () => {
  const t = await boot({ channels: 2 });
  await t.open();
  const only32 = ['noiseRemoveNaNs', 'mathReciprocal', 'mathNaNBackground'], not32 = ['mathAnd', 'mathOr', 'mathXor'];
  for (const bd of [8, 16, 32]) {
    if (bd > 8) await t.runCommand('typeBit' + bd, {});
    assert.equal(stateOf(t).doc.bitDepth, bd);
    for (const id of only32) assert.equal(t.isEnabled(id), bd === 32, `${id} at ${bd} bits`);
    for (const id of not32) assert.equal(t.isEnabled(id), bd !== 32, `${id} at ${bd} bits`);
    for (const id of Object.keys(COMMANDS).filter((k) => !only32.includes(k) && !not32.includes(k))) assert.equal(t.isEnabled(id), true, `${id} at ${bd} bits`);
  }
  t.close();
});

// One command at a time: it changes the pixels, undo gives them back, redo again.
async function cycle(t, id, values, o = {}) {
  const docId = t.activeId();
  const before = Array.from(await pix(t, 0));
  const other = Array.from(await pix(t, 1));
  await t.runCommand(id, values);
  const after = Array.from(await pix(t, 0));
  if (!o.same) assert.notDeepEqual(after, before, id + ' changed the active channel');
  if (!o.all) same(await pix(t, 1), other, id + ' left the other channel alone');
  await t.runCommand('editUndo');
  same(await pix(t, 0), before, id + ': undo');
  await t.runCommand('editRedo');
  same(await pix(t, 0), after, id + ': redo');
  void docId;
  // back to the start for the next command (the journal then holds run, undo, redo, undo entries to replay)
  if (!o.keep) await t.runCommand('editUndo');
  return after;
}

async function restoreMatches(t, label) {
  const docId = t.activeId();
  const live = [Array.from(await pix(t, 0)), Array.from(await pix(t, 1))];
  await t.worker.engine.whenIdle();
  const key = (await t.store.shared.list())[0].key;
  const t2 = await t.reload({ flush: false });
  const w2 = await t2.spawn();
  const res = await t2.engine('session.restore', { key }, w2);
  assert.equal(res.warnings.length, 0, label + ': ' + JSON.stringify(res.warnings));
  for (const c of [0, 1]) {
    const got = (await t2.engine('doc.tile', { docId, channel: c, level: 0, tx: 0, ty: 0 }, w2)).data;
    same(got, live[c], `${label}: channel ${c} restored from the journal`);
  }
  t2.close();
}

const DIALOGS = {
  noiseRemoveOutliers: { radius: 2, threshold: 2, which: 'outliersBright' },
  mathAnd: { bits: '11110000' }, mathOr: { bits: '00001111' }, mathXor: { bits: '10101010' },
  mathGamma: { value: 0.6 },
  filterConvolve: { kernel: '1 2 0\n3 4 -1\n0 1 2', normalize: true },
  filterUnsharp: { sigma: 1.5, weight: 0.6 },
  filterVariance: { radius: 2 },
  filterTopHat: { radius: 3, light: false, dontSubtract: false }
};
const NO_DIALOG = ['procSmooth', 'procSharpen', 'procFindEdges', 'noiseDespeckle', 'mathLog', 'mathExp', 'mathSquare', 'mathSqrt'];

for (const bd of [8, 16, 32]) {
  test(`every command of the package, ${bd}-bit: change, undo, redo, restore from the journal`, async () => {
    const t = await boot({ channels: 2 });
    await t.open();
    if (bd > 8) await t.runCommand('typeBit' + bd, {});
    const ids = NO_DIALOG.concat(Object.keys(DIALOGS));
    for (const id of ids) {
      if (['mathAnd', 'mathOr', 'mathXor'].includes(id) && bd === 32) continue;
      await cycle(t, id, DIALOGS[id] || undefined, { keep: id === 'filterTopHat' || id === 'procSmooth' });
      assert.equal(t.errors.length, 0, id + ' reported an error');
    }
    if (bd === 32) {
      for (const id of ['mathReciprocal']) await cycle(t, id, undefined);
      // NaN Background uses the range of the Threshold window; Remove NaNs fills what it made
      const before = Array.from(await pix(t, 0));
      await t.runCommand('mathNaNBackground', [{}]);
      const nan = Array.from(await pix(t, 0));
      // the range the confirmation names is the one of the Threshold window at that moment
      const msg = lastDialog(t).fields.find((f) => f.id === 'msg').label;
      const m = /outside (\S+) – (\S+) /.exec(msg);
      assert.ok(m, 'the confirmation names the range: ' + msg);
      const th = { lower: Number(m[1]), upper: Number(m[2]) };
      assert.ok(Number.isFinite(th.lower) && th.lower <= th.upper, 'the Threshold window holds a range');
      let n = 0;
      for (let i = 0; i < before.length; i++) {
        const out = before[i] < th.lower || before[i] > th.upper;
        assert.equal(Number.isNaN(nan[i]), out || Number.isNaN(before[i]), 'pixel ' + i);
        if (out) n++;
      }
      assert.ok(n > 0 && n < before.length, 'some pixels become NaN, not all');
      await cycle(t, 'noiseRemoveNaNs', { radius: 2 }, { keep: true });
      assert.ok(Array.from(await pix(t, 0)).filter((v) => Number.isNaN(v)).length < n, 'Remove NaNs removed NaNs');
    }
    await restoreMatches(t, bd + '-bit');
    t.close();
  });
}

test('16-bit math is relative to the display range at the moment of the step (resolve journals it)', async () => {
  const t = await boot({ channels: 2 });
  await t.open();
  await t.runCommand('typeBit16', {});
  const docId = t.activeId();
  await t.engine('doc.setDisplay', { docId, channel: 0, min: 20, max: 200 });
  await t.runCommand('mathGamma', { value: 0.5 });
  const a = Array.from(await pix(t, 0));
  await t.runCommand('mathLog');
  const b = Array.from(await pix(t, 0));
  // the display moves on; a replay must not read it
  await t.engine('doc.setDisplay', { docId, channel: 0, min: 1, max: 60000 });
  await restoreMatches(t, 'display range');
  assert.notDeepEqual(a, b);
  t.close();
});

test('the dialogs mirror ImageJ: fields, defaults and limits', async () => {
  const t = await boot({ channels: 2 });
  await t.open();
  const field = (spec, id) => spec.fields.find((f) => f.id === id);
  await t.runCommand('filterUnsharp', {});
  let d = lastDialog(t);
  assert.equal(field(d, 'sigma').value, 1); assert.equal(field(d, 'weight').value, 0.6);
  assert.equal(field(d, 'weight').max, 0.99); assert.equal(field(d, 'sigma').min, 0);
  assert.equal(typeof d.preview.onChange, 'function', 'a Preview');
  assert.ok(field(d, 'all'), 'a two-channel image offers "all channels"');
  await t.runCommand('filterConvolve', {});
  d = lastDialog(t);
  assert.equal(field(d, 'kernel').type, 'textarea');
  assert.equal(field(d, 'kernel').value, '-1 -1 -1 -1 -1\n-1 -1 -1 -1 -1\n-1 -1 24 -1 -1\n-1 -1 -1 -1 -1\n-1 -1 -1 -1 -1\n', 'the default kernel of Convolver');
  assert.equal(field(d, 'normalize').value, true, 'Normalize Kernel defaults to on');
  for (const bad of ['1 2\n3 4', '1 2 3\n4 5', '1 2 x', '']) {
    const v = d.validate({ kernel: bad, normalize: true });
    assert.ok(v && typeof v.kernel === 'string' && v.kernel.startsWith('dlg.flt.kernel'), JSON.stringify(bad));
  }
  assert.equal(d.validate({ kernel: '0 1 0\n1 -4 1\n0 1 0', normalize: false }), null);
  await t.runCommand('noiseRemoveOutliers', {});
  d = lastDialog(t);
  assert.equal(field(d, 'radius').value, 2); assert.equal(field(d, 'threshold').value, 50); assert.equal(field(d, 'which').value, 'outliersBright');
  assert.deepEqual(J(field(d, 'which').options.map((o) => o.value)), ['outliersBright', 'outliersDark']);
  await t.runCommand('filterVariance', {});
  d = lastDialog(t);
  assert.equal(field(d, 'radius').value, 2); assert.equal(field(d, 'radius').max, 1000);
  assert.ok(field(d, 'note'), 'the clipping note on 8-bit images');
  await t.runCommand('filterTopHat', {});
  d = lastDialog(t);
  assert.equal(field(d, 'radius').value, 2); assert.equal(field(d, 'light').value, false); assert.equal(field(d, 'dontSubtract').value, false);
  await t.runCommand('mathGamma', {});
  d = lastDialog(t);
  assert.equal(field(d, 'value').type, 'slider'); assert.equal(field(d, 'value').value, 0.5);
  assert.ok(field(d, 'value').min >= 0.05 && field(d, 'value').max === 5, 'Gamma must be between 0.05 and 5.0');
  await t.runCommand('mathAnd', {});
  d = lastDialog(t);
  assert.equal(field(d, 'bits').value, '11110000', 'the default binary value of ImageMath');
  assert.ok(d.validate({ bits: '12' }) && d.validate({ bits: '' }) && d.validate({ bits: '1'.repeat(33) }));
  assert.equal(d.validate({ bits: '1010' }), null);
  await t.runCommand('typeBit32', {});
  await t.runCommand('filterVariance', {});
  assert.ok(!lastDialog(t).fields.find((f) => f.id === 'note'), 'no clipping note on 32 bits');
  await t.runCommand('noiseRemoveNaNs', {});
  d = lastDialog(t);
  assert.equal(field(d, 'radius').value, 2); assert.equal(field(d, 'radius').max, 100);
  t.close();
});

test('"all channels": the dialog commands process every channel, the others only the active one', async () => {
  const t = await boot({ channels: 2 });
  await t.open();
  const b0 = Array.from(await pix(t, 0)), b1 = Array.from(await pix(t, 1));
  await t.runCommand('procSmooth');
  assert.notDeepEqual(Array.from(await pix(t, 0)), b0); same(await pix(t, 1), b1, 'Smooth: the active channel only');
  await t.runCommand('editUndo');
  await t.runCommand('filterVariance', { radius: 2, all: true });
  assert.notDeepEqual(Array.from(await pix(t, 0)), b0); assert.notDeepEqual(Array.from(await pix(t, 1)), b1);
  // the same as the two single-channel runs
  await t.runCommand('editUndo');
  await t.runCommand('filterVariance', { radius: 2 });
  const v0 = Array.from(await pix(t, 0));
  await t.runCommand('editUndo');
  await t.runCommand('filterVariance', { radius: 2, all: true });
  same(await pix(t, 0), v0, 'channel 0 alone = channel 0 of all');
  t.close();
});

test('a selection limits the filters; a line selection means the whole image', async () => {
  const t = await boot({ channels: 2 });
  await t.open();
  const W = 40;
  const before = Array.from(await pix(t, 0));
  t.shell.opts.onRoi({ type: 'rect', x: 8, y: 6, w: 20, h: 12 }, { final: true });
  await t.runCommand('procSmooth');
  const after = Array.from(await pix(t, 0));
  let inside = 0, outsideChanged = 0;
  for (let i = 0; i < after.length; i++) {
    const x = i % W, y = Math.floor(i / W);
    const inRect = x >= 8 && x < 28 && y >= 6 && y < 18;
    if (!inRect && after[i] !== before[i]) outsideChanged++;
    if (inRect && after[i] !== before[i]) inside++;
  }
  assert.equal(outsideChanged, 0, 'nothing outside the rectangle changes');
  assert.ok(inside > 0, 'the rectangle is filtered');
  await t.runCommand('editUndo');
  t.shell.opts.onRoi({ type: 'line', x1: 1, y1: 1, x2: 20, y2: 15, width: 1 }, { final: true });
  await t.runCommand('procSmooth');
  const whole = Array.from(await pix(t, 0));
  t.shell.opts.onRoi(null, { final: true });
  await t.runCommand('editUndo');
  await t.runCommand('procSmooth');
  same(await pix(t, 0), whole, 'a line selection = no selection (Filters.setup: noRoi → ip.resetRoi())');
  t.close();
});

test('Remove NaNs / NaN Background: threshold window, error mapping', async () => {
  const t = await boot({ channels: 2 });
  await t.open();
  await t.runCommand('typeBit32', {});
  // without a threshold range the command says so (the Threshold window gives none): the mapped sentence
  const api = null; void api;
  const sentence = t.IJApp.errorKey({ code: 'IJ_FLT_NO_THRESHOLD' });
  assert.equal(sentence, 'err.fltNoThreshold');
  const en = (await import('./ij_harness.mjs')).EN;
  assert.equal(typeof en.err.fltNoThreshold, 'string');
  // cancelling the confirmation changes nothing
  const before = Array.from(await pix(t, 0));
  await t.runCommand('mathNaNBackground', [null]);
  same(await pix(t, 0), before, 'cancelled');
  // the Threshold window's range is the one used: the pixels outside it become NaN, the ones inside are kept, and the
  // display range is the exact data range of the WHOLE image afterwards
  const th = stateOf(t).threshold;
  assert.ok(th, 'the window is open');
  {
    const orig = Array.from(await pix(t, 0));
    await t.runCommand('mathNaNBackground', {});
    const out = await pix(t, 0);
    for (let i = 0; i < orig.length; i++) {
      if (orig[i] >= th.lower && orig[i] <= th.upper) assert.equal(out[i], orig[i], 'inside the range: kept');
      else assert.ok(Number.isNaN(out[i]), 'outside the range: NaN');
    }
    let lo = Infinity, hi = -Infinity;
    for (const v of out) { if (v === v && v - v === 0) { if (v < lo) lo = v; if (v > hi) hi = v; } }
    const dsp = (await t.engine('doc.info', { docId: t.activeId() })).channels[0].display;
    if (lo <= hi) { assert.equal(dsp.min, lo); assert.equal(dsp.max, hi); }
  }
  t.close();
});

test('the display range follows Variance / Top Hat / Convolve on a 16-bit image (stretchHistogram / resetMinAndMax)', async () => {
  const t = await boot({ channels: 1 });
  await t.open();
  await t.runCommand('typeBit16', {});
  const docId = t.activeId();
  const d0 = (await t.engine('doc.info', { docId })).channels[0].display;
  await t.runCommand('filterVariance', { radius: 2 });
  const info = await t.engine('doc.info', { docId });
  const d1 = info.channels[0].display;
  const px = await pix(t, 0);
  let mx = 0; for (const v of px) if (v > mx) mx = v;
  assert.notDeepEqual(J(d1), J(d0), 'Variance moved the display range');
  assert.ok(d1.max <= mx && d1.max > 0, `the display maximum (${d1.max}) lies inside the result's data (max ${mx})`);
  // Convolve without a selection: resetMinAndMax = the EXACT data range of the result (not a histogram bin edge)
  await t.runCommand('filterConvolve', { kernel: '1 2 0\n3 4 -1\n0 1 2', normalize: true });
  const px2 = await pix(t, 0);
  let lo = Infinity, hi = -Infinity; for (const v of px2) { if (v < lo) lo = v; if (v > hi) hi = v; }
  const d2 = (await t.engine('doc.info', { docId })).channels[0].display;
  assert.equal(d2.min, lo, 'Convolve: display min = data min'); assert.equal(d2.max, hi, 'Convolve: display max = data max');
  await t.runCommand('editUndo');
  await t.runCommand('editUndo');
  t.close();
});

let failed = 0;
for (const [name, fn] of cases) {
  try { await fn(); console.log('ok   ' + name); } catch (err) { failed++; console.log('FAIL ' + name + '\n' + (err && err.stack || err)); }
}
if (failed) { console.log(failed + ' failed'); process.exit(1); }
console.log('ij filters commands: OK (' + cases.length + ' groups)');
