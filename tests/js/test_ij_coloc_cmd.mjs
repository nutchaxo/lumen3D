// Analyze > Colocalization through the real controller and the real engine (tests/js/ij_harness.mjs):
// dialog values → compute op in the worker → table window + 2D histogram plot. The command writes nothing:
// no undo step, no revision bump, the pixels are untouched (the engine runs with verifyInputs, so a write into
// an input array would fail the run), and a reload restores the same pixels.
//
// Run: node tests/js/test_ij_coloc_cmd.mjs
import assert from 'node:assert/strict';
import { boot, until, J } from './ij_harness.mjs';

const ID = 'analyzeColocalization';

// text of a fake DOM tree (the harness's elements): { th: [..], td: [..] } of the first table found
function tableOf(el) {
  const out = { th: [], td: [] };
  const walk = (n) => {
    if (!n || typeof n !== 'object') return;
    if (n.tagName === 'TH') out.th.push(n.textContent);
    if (n.tagName === 'TD') out.td.push(n.textContent);
    for (const c of n.children || []) walk(c);
  };
  walk(el);
  return out;
}
const tableWindows = (t) => [...t.shell.windows.floats.values()].filter((w) => /^table-/.test(w.id));

// the plot windows' specs are what IJPlot.draw receives
const plots = [];
function spyPlot(t) {
  const real = t.page.IJPlot.draw;
  t.page.IJPlot.draw = (canvas, spec, opts) => { plots.push(spec); try { return real(canvas, spec, opts); } catch (_) { return null; } };
}

// the reference: naive two-pass formulas on the pixels the engine holds
function reference(a, b) {
  const n = a.length;
  let sa = 0, sb = 0; for (let i = 0; i < n; i++) { sa += a[i]; sb += b[i]; }
  const ma = sa / n, mb = sb / n;
  let saa = 0, sbb = 0, sab = 0, raa = 0, rbb = 0, rab = 0, n1 = 0, n2 = 0;
  for (let i = 0; i < n; i++) {
    saa += (a[i] - ma) ** 2; sbb += (b[i] - mb) ** 2; sab += (a[i] - ma) * (b[i] - mb);
    raa += a[i] * a[i]; rbb += b[i] * b[i]; rab += a[i] * b[i];
    if (b[i] > 0) n1 += a[i];
    if (a[i] > 0) n2 += b[i];
  }
  return { r: sab / Math.sqrt(saa * sbb), overlap: rab / Math.sqrt(raa * rbb), m1: n1 / sa, m2: n2 / sb };
}
const cellNum = (s) => Number(s);

const t = await boot({ channels: 3 });
spyPlot(t);
await t.open();
const A = t.activeId();
const info0 = (await t.docs()).find((d) => d.docId === A);
assert.equal(info0.bitDepth, 8);
assert.equal(info0.channels.length, 3);
const px = async (id, c) => Array.from(await t.pixels(id, c));
const before = [await px(A, 0), await px(A, 1), await px(A, 2)];
const rev0 = (await t.engine('doc.info', { docId: A })).rev;
const undoDepth0 = (await t.engine('doc.info', { docId: A })).undoDepth;

// ── 1. two channels of the current image ──
{
  const errs = await t.runCommand(ID, { doc1: A, ch1: 0, doc2: A, ch2: 1, mode: 'none', denominator: 'all' });
  assert.equal(errs.length, 0);
  const spec = t.log.dialogSpecs[t.log.dialogSpecs.length - 1];
  assert.deepEqual(J(spec.fields.map((f) => f.id)), ['doc1', 'ch1', 'doc2', 'ch2', 'mode', 't1', 't2', 'excludeZero', 'denominator', 'note']);
  assert.equal(spec.fields.find((f) => f.id === 'ch2').value, 1, 'channel 2 defaults to the second channel');
  assert.equal(spec.fields.find((f) => f.id === 'mode').value, 'none');
  await until(() => tableWindows(t).length === 1, 'the table window');
  const tab = tableOf(tableWindows(t)[0].spec.content);
  assert.equal(tab.th.length, tab.td.length, 'one row, one cell per column');
  assert.ok(tab.th.includes('Pearson r (all ROI pixels)') && tab.th.includes('M1 (sum ch1 where ch2>0 / sum ch1, all ROI pixels)'));
  assert.ok(tab.th.some((h) => /^tM1 \(sum ch1 above T1 and T2 \/ sum ch, all ROI pixels\)$/.test(h)), 'the tM1 denominator is named in its header');
  const want = reference(before[0], before[1]);
  const at = (h) => cellNum(tab.td[tab.th.indexOf(h)]);
  assert.ok(Math.abs(at('Pearson r (all ROI pixels)') - Math.round(want.r * 1e4) / 1e4) < 1e-9);
  assert.ok(Math.abs(at('Overlap R') - Math.round(want.overlap * 1e4) / 1e4) < 1e-9);
  assert.ok(Math.abs(at('M1 (sum ch1 where ch2>0 / sum ch1, all ROI pixels)') - Math.round(want.m1 * 1e4) / 1e4) < 1e-9);
  assert.equal(at('ROI pixels'), info0.width * info0.height);
  await until(() => plots.length >= 1, 'the plot window drew');
  const p = plots[plots.length - 1];
  assert.equal(p.image.w, 256); assert.equal(p.image.h, 256); assert.equal(p.image.logScale, true);
  assert.equal(p.image.data.length, 65536);
  let total = 0; for (let i = 0; i < p.image.data.length; i++) total += p.image.data[i];
  assert.equal(total, info0.width * info0.height, 'every pixel is in the 2D histogram');
  assert.ok(Array.from(p.overlays).every((o) => o.kind === 'line'));
  assert.equal(p.csv.columns.length, 3);
}

// ── nothing was written ──
{
  const after = [await px(A, 0), await px(A, 1), await px(A, 2)];
  assert.deepEqual(after, before, 'the pixels are untouched');
  const i = await t.engine('doc.info', { docId: A });
  assert.equal(i.rev, rev0); assert.equal(i.undoDepth, undoDepth0, 'no undo step');
  assert.equal(t.isEnabled('editRedo'), false);
}

// ── 2. an area selection, manual thresholds, the other denominator ──
{
  t.shell.opts.onRoi({ type: 'rect', x: 5, y: 4, w: 20, h: 12 }, { final: true });
  await until(() => t.shell.opts.getState().roi, 'selection set');
  await t.runCommand(ID, { doc1: A, ch1: 0, doc2: A, ch2: 2, mode: 'manual', t1: 100, t2: 80, excludeZero: true, denominator: 'above' });
  await until(() => tableWindows(t).length === 2, 'second table');
  const tab = tableOf(tableWindows(t)[1].spec.content);
  assert.ok(tab.th.includes('tM1 (sum ch1 above T1 and T2 / sum ch above T)'));
  const n = cellNum(tab.td[tab.th.indexOf('ROI pixels')]);
  assert.ok(n <= 240 && n > 0, 'at most the 20 x 12 selection (zero-zero pixels excluded): ' + n);
  assert.equal(tab.td[tab.th.indexOf('Thresholds')], 'manual');
  assert.equal(cellNum(tab.td[tab.th.indexOf('T1')]), 100);
  assert.equal(cellNum(tab.td[tab.th.indexOf('T2')]), 80);
  // thresholds are drawn
  await until(() => plots.length >= 2, 'second plot');
  const p = plots[plots.length - 1];
  assert.ok(Array.from(p.overlays).some((o) => o.x1 === 100 && o.x2 === 100), 'the T1 line');
  assert.ok(Array.from(p.overlays).some((o) => o.y1 === 80 && o.y2 === 80), 'the T2 line');
  t.shell.opts.onRoi(null, { final: true });
  await until(() => !t.shell.opts.getState().roi, 'selection cleared');
}

// ── 3. two documents, Costes ──
{
  await t.runCommand('imageDuplicate');
  await until(() => t.activeId() !== A && t.activeId() !== undefined, 'duplicate shown');
  const B = t.activeId();
  await t.runCommand('editInvert');
  await until(async () => (await px(B, 0)).some((v, i) => v !== before[0][i]), 'inverted');
  assert.equal(t.isEnabled(ID), true);
  const nTables = tableWindows(t).length;
  await t.runCommand(ID, { doc1: A, ch1: 0, doc2: B, ch2: 0, mode: 'costes', denominator: 'all' });
  await until(() => tableWindows(t).length === nTables + 1, 'table of the two-image run');
  const tab = tableOf(tableWindows(t)[nTables].spec.content);
  assert.equal(tab.td[tab.th.indexOf('Thresholds')], 'Costes (failed)', 'an image against its inverse: no positive correlation');
  assert.ok(cellNum(tab.td[tab.th.indexOf('Pearson r (all ROI pixels)')]) < -0.99);
  assert.ok(t.log.status.some((s) => /Costes/.test(String(s))), 'the operator is told that the threshold was not found');
  // a failed search leaves the thresholds and what depends on them empty, and draws no threshold line
  for (const h of ['T1', 'T2', 'Pixels above T1 and T2', 'Pearson r (above T1 and T2)', 'Pearson r (below T1 or T2)']) assert.equal(tab.td[tab.th.indexOf(h)], '', h + ' is empty');
  assert.ok(tab.th.some((h, i) => /^tM1 /.test(h) && tab.td[i] === ''), 'tM1 is empty');
  await until(() => plots.length >= 3, 'plot of the failed run');
  const fp = plots[plots.length - 1];
  assert.ok(Array.from(fp.overlays).every((o) => !(o.x1 === o.x2 || o.y1 === o.y2)), 'no threshold line on the plot of a failed search');
  // a pair that does correlate: the search succeeds and finds the level the classical scan from the top finds
  const classical = (a, b, slope, intercept) => {
    let hi = 0; for (const v of a) if (v > hi) hi = v;
    for (let tt = hi; tt >= 0; tt--) {
      const t2 = slope * tt + intercept, sel = [];
      for (let i = 0; i < a.length; i++) if (!(a[i] >= tt && b[i] >= t2)) sel.push(i);
      if (sel.length < 2) return tt;
      let ma = 0, mb = 0; for (const i of sel) { ma += a[i]; mb += b[i]; } ma /= sel.length; mb /= sel.length;
      let saa = 0, sbb = 0, sab = 0; for (const i of sel) { saa += (a[i] - ma) ** 2; sbb += (b[i] - mb) ** 2; sab += (a[i] - ma) * (b[i] - mb); }
      if (!(saa > 0 && sbb > 0 && sab / Math.sqrt(saa * sbb) > 0)) return tt;
    }
    return null;
  };
  await t.runCommand(ID, { doc1: A, ch1: 1, doc2: A, ch2: 2, mode: 'costes' });
  await until(() => tableWindows(t).length === nTables + 2, 'table of the Costes run');
  const tab2 = tableOf(tableWindows(t)[nTables + 1].spec.content);
  assert.equal(tab2.td[tab2.th.indexOf('Thresholds')], 'Costes (ok)', 'the two channels correlate: the search succeeds');
  const m = cellNum(tab2.td[tab2.th.indexOf('Orthogonal slope')]), c = cellNum(tab2.td[tab2.th.indexOf('Orthogonal intercept')]);
  // the table rounds the slope and intercept (4 decimals): the level is checked against the scan run with the exact line, from the engine
  const exact = await t.engine('doc.compute', { docId: A, op: 'coloc', params: { ch1: 1, ch2: 2, doc2: null, mode: 'costes', t1: 0, t2: 0, excludeZero: false, denominator: 'all' }, roi: null, channel: 0 });
  assert.equal(exact.costes, 'ok');
  assert.equal(cellNum(tab2.td[tab2.th.indexOf('T1')]), exact.t1, 'the table shows the T1 of the engine');
  assert.equal(exact.t1, classical(before[1], before[2], exact.slope, exact.intercept), 'T1 = the classical scan from the maximum down');
  assert.ok(Math.abs(m - exact.slope) < 1e-3 && Math.abs(c - exact.intercept) < 1e-3);
  assert.equal(await t.isEnabled('editUndo'), true, 'the inversion of the copy is still undoable: coloc added no step');
  // the dialog refuses the same channel twice (cross-field validate)
  // (the app logs the refused dialog: keep the test output clean)
  const realError = console.error;
  console.error = () => {};
  try { await assert.rejects(t.runCommand(ID, { doc1: A, ch1: 0, doc2: A, ch2: 0 }), /dlg\.coloc\.sameChannel/); } finally { console.error = realError; }
  t.script.dialogs.length = 0;
  // cancel
  const n3 = tableWindows(t).length;
  await t.runCommand(ID, null);
  assert.equal(tableWindows(t).length, n3, 'a cancelled dialog opens nothing');
}

// ── 4. reload: the same pixels, the same answer ──
{
  const compute = (tt, w, docId, over, roi) => tt.engine('doc.compute', { docId, op: 'coloc', params: Object.assign({ ch1: 0, ch2: 1, doc2: null, mode: 'costes', t1: 0, t2: 0, excludeZero: false, denominator: 'all' }, over), roi: roi || null, channel: 0 }, w);
  const r1 = await compute(t, undefined, A);
  await t.flush();
  const keys = (await t.store.shared.list()).map((x) => x.key);
  const t2 = await t.reload({ flush: false });
  const w2 = await t2.spawn();
  for (const key of keys) await t2.engine('session.restore', { key }, w2);
  const restored = [];
  for (const c of [0, 1, 2]) restored.push(Array.from((await t2.engine('doc.tile', { docId: A, channel: c, level: 0, tx: 0, ty: 0 }, w2)).data));
  assert.deepEqual(restored, before, 'the restored image holds the same pixels');
  const r2 = await compute(t2, w2, A);
  const strip = (r) => { const { hist, ...rest } = r; return { rest: J(rest), hist: Array.from(hist) }; };
  assert.deepEqual(strip(r2), strip(r1), 'the same numbers after a reload');
  // the engine refuses what the dialog would have: errors keep their codes
  for (const over of [{ ch2: 0 }, { ch2: 9 }, { mode: 'weird' }, { doc2: 'nosuchdoc' }, { denominator: 'x' }]) {
    await assert.rejects(compute(t2, w2, A, over), (e) => e.code === 'IJ_BAD_ARGS', JSON.stringify(over));
  }
  await assert.rejects(compute(t2, w2, A, {}, { type: 'rect', x: 0, y: 0, w: 1, h: 1 }), (e) => e.code === 'IJ_COLOC_NO_PIXELS', 'a one-pixel selection');
  await assert.rejects(compute(t2, w2, A, {}, { type: 'rect', x: 500, y: 500, w: 3, h: 3 }), (e) => e.code === 'IJ_EMPTY_ROI', 'a selection outside the image');
  t2.close();
}
t.close();
console.log('ij coloc cmd: OK');
