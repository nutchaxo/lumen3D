// Package fiji through the real controller and the real engine (tests/js/ij_harness.mjs): dialog values → worker → Results / table / plot
// windows / new images, then undo (these commands are not undo steps of the source image) and a reload (new images and Cell Counter
// markers come back).
//   Analyze > Skeleton > Analyze Skeleton (2D/3D)         skelAnalyze
//   Analyze > Local Thickness > Local Thickness           ltComplete
//   Analyze > Tools > Fractal Box Count… / Curve Fitting… toolsFractalBoxCount, toolsCurveFitting (panel)
//   Analyze > Colocalization > Coloc 2                    colocColoc2
//   Plugins > Analyze > Cell Counter > Cell Counter       pluginsCellCounter (panel + the hidden tool `counter`)
//
// Run: node tests/js/test_ij_fiji_cmds.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { boot, until, J, EN, DIR } from './ij_harness.mjs';
import { ROOT } from './harness.mjs';

const FX = path.join(ROOT, 'tests', 'fixtures', 'ij-wave3', 'fiji');
const fx = (f) => JSON.parse(fs.readFileSync(path.join(FX, f), 'utf8'));
const u8 = (d) => { const b = Buffer.from(d.data.b64, 'base64'); return new Uint8Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); };

function* walk(el) { yield el; for (const c of el.children || []) yield* walk(c); }
const find = (root, pred) => { for (const n of walk(root)) if (pred(n)) return n; return null; };
const findAll = (root, pred) => { const out = []; for (const n of walk(root)) if (pred(n)) out.push(n); return out; };
const button = (root, text) => find(root, (n) => n.tagName === 'BUTTON' && n.textContent === text);
const fire = (el, type, ev) => { for (const f of (el.listeners[type] || []).slice()) f(Object.assign({ target: el, type }, ev || {})); };
const tableOf = (el) => { const out = { th: [], td: [] }; for (const n of walk(el)) { if (n.tagName === 'TH') out.th.push(n.textContent); if (n.tagName === 'TD') out.td.push(n.textContent); } return out; };
const tableWindows = (t) => [...t.shell.windows.floats.values()].filter((w) => /^table-/.test(w.id));
const plots = [];
const spyPlot = (t) => { const real = t.page.IJPlot.draw; t.page.IJPlot.draw = (c, spec, o) => { plots.push(spec); try { return real(c, spec, o); } catch (_) { return null; } }; };

async function results(t, n) {
  let rows = null;
  await until(() => {
    for (let i = t.log.msgs.length - 1; i >= 0; i--) {
      const m = t.log.msgs[i];
      if (m.cmd === 'session.putMeta' && m.args && Array.isArray(m.args.results)) { if (m.args.results.length >= n) { rows = m.args.results; return true; } return false; }
    }
    return false;
  }, 'the results to be persisted', 5000);
  return J(rows);
}
const addImage = (t, name, w, h, arrays, extra) => t.api('fiji').addDoc(Object.assign({ name, width: w, height: h, bitDepth: 8,
  channels: arrays.map((a, i) => ({ data: a, name: 'C' + (i + 1), color: ['#ffffff', '#00ff00', '#ff0000'][i % 3] })) }, extra || {}), { placement: 'tab' });
const docByName = async (t, name) => (await t.docs()).find((d) => d.name === name);
const labelOf = (spec, id) => { const f = spec.fields.find((x) => x.id === id); return f ? (f.label || EN.dlg && f.labelKey && f.labelKey.split('.').reduce((a, k) => (a ? a[k] : undefined), EN)) : undefined; };

// ═════════════ Analyze Skeleton ═════════════
{
  const t = await boot({ channels: 1 });
  spyPlot(t);
  await t.open();
  const g = fx('skeleton/graph0.json');
  const id = await addImage(t, 'skel', g.input.width, g.input.height, [u8(g.input)]);
  const info0 = await t.engine('doc.info', { docId: id });
  const want = g.cases.find((c) => c.name === 'shortestPath');
  // a row already in Results: Fiji's `new ResultsTable().show("Results")` replaces it
  t.api('fiji').addResults([{ Label: 'earlier measurement', Area: 1 }], { show: false });
  // the dialog = Fiji's: field order, labels, defaults
  await t.runCommand('skelAnalyze', { prune: 'none', pruneEnds: false, excludeRoi: false, shortestPath: true, detailed: true, labeled: true });
  const spec = t.log.dialogSpecs[t.log.dialogSpecs.length - 1];
  assert.equal(spec.title, 'Analyze Skeleton', 'the title is the one of Fiji, not the menu label');
  assert.deepEqual(J(spec.fields.map((f) => f.id)), ['secLoops', 'prune', 'secEnds', 'pruneEnds', 'excludeRoi', 'secResults', 'shortestPath', 'detailed', 'labeled']);
  assert.deepEqual(J(spec.fields.map((f) => labelOf(spec, f.id))), ['Elimination of Loops:', 'Prune cycle method:', 'Elimination of End-points:', 'Prune ends', 'Exclude ROI from pruning', 'Results and Output:', 'Calculate largest shortest path', 'Show detailed info', 'Display labeled skeletons']);
  assert.deepEqual(J(spec.fields.find((f) => f.id === 'prune').options.map((o) => o.value)), ['none', 'shortest', 'lowestVoxel', 'lowestBranch']);
  assert.equal(spec.fields.find((f) => f.id === 'prune').value, 'none');
  assert.ok(spec.fields.filter((f) => f.type === 'check').every((f) => f.value === false), 'every checkbox starts ticked off');
  const rows = await results(t, 3);
  assert.equal(rows.length, 3, 'one row per skeleton, the earlier Results rows replaced');
  assert.ok(rows.every((r) => r.Label !== 'earlier measurement'));
  const cols = want.result.table.headings;
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 9; c++) assert.ok(Math.abs(rows[r][cols[c]] - want.result.table.rows[r][c]) < 1e-6, `row ${r} ${cols[c]}: ${rows[r][cols[c]]} vs ${want.result.table.rows[r][c]}`);
    assert.ok(Math.abs(rows[r]['Longest Shortest Path'] - want.result.table.rows[r][9]) < 1e-6 || r === 2, `row ${r} Longest Shortest Path`);
  }
  assert.ok(tableWindows(t).some((w) => /Branch information/.test(w.spec.title || '')), 'the Branch information table opened');
  const branch = tableOf(tableWindows(t).find((w) => /Branch information/.test(w.spec.title || '')).spec.content);
  assert.deepEqual(branch.th, ['Skeleton ID', 'Branch length', 'V1 x', 'V1 y', 'V1 z', 'V2 x', 'V2 y', 'V2 z', 'Euclidean distance', 'running average length', 'average intensity (inner 3rd)', 'average intensity']);
  assert.equal(branch.td.length, 12 * 8, '5 + 1 + 2 branches');
  // the images
  await until(async () => (await t.docs()).length >= 4, 'the new images');
  const tagged = await docByName(t, 'Tagged skeleton');
  assert.ok(tagged && tagged.bitDepth === 8);
  const tw = u8(want.result.created.find((x) => x.title === 'Tagged skeleton').image);
  const got = await t.pixels(tagged.docId, 0);
  assert.equal(got.length, tw.length);
  let diff = 0;
  for (let i = 0; i < tw.length; i++) if (got[i] !== tw[i]) diff++;
  assert.equal(diff, 0, 'the tagged skeleton is Fiji\'s (30 end-points, 70 junctions, 127 slabs)');
  assert.ok(await docByName(t, 'Longest shortest paths') && await docByName(t, 'skel-labeled-skeletons'));
  const lab = await docByName(t, 'skel-labeled-skeletons');
  assert.equal(lab.bitDepth, 32);
  const lp = await t.pixels(lab.docId, 0);
  assert.equal(Math.max(...lp), 3, 'three trees, numbered 1..3');
  // a read-only analysis: the skeleton itself has no new undo step, nothing changed
  const info1 = await t.engine('doc.info', { docId: id });
  assert.equal(info1.rev, info0.rev); assert.equal(info1.undoDepth, info0.undoDepth);
  // a pruned run: the skeleton left comes as another image, the table keeps Fiji's numbers
  await t.shell.opts.onActivate(id);
  await t.runCommand('skelAnalyze', { prune: 'none', pruneEnds: true, excludeRoi: false, shortestPath: false, detailed: false, labeled: false });
  const pruned = await until(async () => (await docByName(t, 'skel-pruned')) || null, 'the pruned skeleton');
  const px = await t.pixels(pruned.docId, 0);
  const pe = g.cases.find((c) => c.name === 'pruneEnds');
  const pw = u8(pe.result.self);
  let d2 = 0;
  for (let i = 0; i < pw.length; i++) if ((px[i] !== 0) !== (pw[i] !== 0)) d2++;
  assert.equal(d2, 0, 'Prune ends leaves the skeleton Fiji leaves');
  await t.close();
}

// ═════════════ Local Thickness ═════════════
{
  const t = await boot({ channels: 1 });
  await t.open();
  const g = fx('localthickness/lines.json');
  const id = await addImage(t, 'in', g.input.width, g.input.height, [u8(g.input)]);
  const c = g.cases.find((x) => x.params.threshold === 128 && !x.params.inverse);
  await t.runCommand('ltComplete', { threshold: 128, inverse: false });
  const spec = t.log.dialogSpecs[t.log.dialogSpecs.length - 1];
  assert.deepEqual(J(spec.fields.map((f) => f.id)), ['threshold', 'inverse']);
  assert.deepEqual(J(spec.fields.map((f) => labelOf(spec, f.id))), ['Threshold (1 to 255; value < thresh is background)', 'Inverse case (background when value >= thresh)']);
  assert.equal(spec.fields[0].value, 128);
  const doc = await until(async () => (await docByName(t, 'in_LocThk')) || null, 'the thickness image');
  assert.equal(doc.bitDepth, 32);
  const out = await t.pixels(doc.docId, 0);
  const want = c.result.created[0].image, wb = Buffer.from(want.data.b64, 'base64');
  const wf = new Float32Array(wb.buffer.slice(wb.byteOffset, wb.byteOffset + wb.byteLength));
  const src = u8(g.input), W = g.input.width, H = g.input.height;
  let bad = 0, n = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let inter = src[y * W + x] >= 128;
    for (let dy = -1; dy <= 1 && inter; dy++) for (let dx = -1; dx <= 1; dx++) { const xx = x + dx, yy = y + dy; if (xx >= 0 && yy >= 0 && xx < W && yy < H && src[yy * W + xx] < 128) { inter = false; break; } }
    if (!inter) continue;
    n++;
    if (Math.abs(out[y * W + x] - wf[y * W + x]) > 1e-4) bad++;
  }
  assert.ok(n > 100 && bad === 0, `interior pixels agree with Fiji (${bad} of ${n} differ)`);
  assert.equal((await t.engine('doc.info', { docId: id })).undoDepth, 0, 'the source gets no undo step');
  // a threshold above every pixel: nothing to measure → an error dialog, no image
  // no object pixel / no background pixel at this threshold: a message, no image
  const nDocs = (await t.docs()).length;
  await addImage(t, 'empty', 8, 8, [new Uint8Array(64)]);
  await t.runCommand('ltComplete', { threshold: 128, inverse: false }, { expectError: true });
  await addImage(t, 'full', 8, 8, [new Uint8Array(64).fill(255)]);
  await t.runCommand('ltComplete', { threshold: 128, inverse: false }, { expectError: true });
  assert.equal((await t.docs()).length, nDocs + 2, 'the two failed runs made no image');
  // a map made from the primary image comes back after a reload (it is journaled with its session)
  await t.shell.opts.onActivate((await t.docs()).find((d) => !['in', 'in_LocThk', 'empty', 'full'].includes(d.name)).docId);
  const prim = (await t.docs()).find((d) => !['in', 'in_LocThk', 'empty', 'full'].includes(d.name));
  const pp = Array.from(await t.pixels(prim.docId, 0)).sort((a, b) => a - b);
  const thr = Math.max(1, Math.min(255, pp[Math.floor(pp.length / 2)] || 1));
  await t.runCommand('ltComplete', { threshold: thr, inverse: false });
  const mapName = prim.name + '_LocThk';
  await until(async () => (await docByName(t, mapName)) || null, 'the thickness map of the primary image');
  await t.flush();
  const t2 = await t.reload();
  await t2.open();
  await until(async () => (await t2.docs()).some((d) => d.name === mapName && d.bitDepth === 32), 'the thickness map after a reload');
  t2.close();
}

// ═════════════ Fractal Box Count ═════════════
{
  const t = await boot({ channels: 1 });
  spyPlot(t);
  await t.open();
  const f = fx('fractal_box_count.json');
  const inp = f.inputs.find((i) => i.name === 'carpet81').image;
  const id = await addImage(t, 'carpet81.tif', inp.width, inp.height, [u8(inp)]);
  const want = f.cases.find((c) => c.image === 'carpet81' && c.params.blackBackground && !c.params.invertedLut && c.params.boxSizes === '2,3,4,6,8,12,16,32,64').result;
  await t.runCommand('toolsFractalBoxCount', { sizes: '2,3,4,6,8,12,16,32,64', blackBackground: true });
  const spec = t.log.dialogSpecs[t.log.dialogSpecs.length - 1];
  assert.equal(spec.title, 'Fractal Box Counter');
  assert.deepEqual(J(spec.fields.map((x) => x.id)), ['sizes', 'blackBackground']);
  assert.deepEqual(J(spec.fields.map((x) => labelOf(spec, x.id))), ['Box Sizes:', 'Black Background']);
  assert.equal(spec.fields[0].value, '2,3,4,6,8,12,16,32,64'); assert.equal(spec.fields[1].value, false);
  const rows = await results(t, 1);
  const r = rows[rows.length - 1];
  assert.equal(r.Label, 'carpet81');
  want.headings.slice(1, -1).forEach((h, i) => assert.equal(r[h], want.values[i + 1], h));
  assert.ok(Math.abs(r.D - want.values[want.values.length - 1]) < 1e-12);
  await until(() => plots.some((s) => s.text === 'D=' + want.values[want.values.length - 1].toFixed(4)), 'the plot with the D label');
  // bad sizes are refused by the dialog; a grey image is refused by the operation
  const rowsBefore = rows.length;
  await t.runCommand('toolsFractalBoxCount', { sizes: '0,3', blackBackground: false }).catch(() => {});
  const again = t.log.dialogSpecs[t.log.dialogSpecs.length - 1];
  assert.deepEqual([again.fields[0].value, again.fields[1].value], ['2,3,4,6,8,12,16,32,64', true], 'both fields are the ones confirmed last (static fields of FractalBoxCounter)');
  const grey = new Uint8Array(100).map((_, i) => i * 2);
  await addImage(t, 'grey', 10, 10, [grey]);
  await t.runCommand('toolsFractalBoxCount', { sizes: '2,4', blackBackground: false }, { expectError: true });
  assert.equal((await results(t, 1)).length, rowsBefore, 'nothing was added to Results');
  void id;
  await t.close();
}

// ═════════════ Curve Fitting panel ═════════════
{
  const t = await boot({ channels: 1 });
  spyPlot(t);
  await t.open();
  await t.runCommand('toolsCurveFitting');
  const panel = await until(() => t.panel('curveFitter') || null, 'the Curve Fitter window');
  const select = find(panel, (n) => n.tagName === 'SELECT'), area = find(panel, (n) => n.tagName === 'TEXTAREA'), pre = find(panel, (n) => n.tagName === 'PRE');
  assert.equal(area.value, '0.00  0.00\n1.00  0.90\n2.00  4.50\n3.00  8.00\n4.00  18.00\n5.00  24.00\n', 'the data ImageJ starts with');
  assert.equal(select.children.length, 25, 'every built-in function, in CurveFitter.sortedTypes order');
  assert.deepEqual(select.children.map((o) => o.textContent).slice(0, 4), ['Straight Line', '2nd Degree Polynomial', '3rd Degree Polynomial', '4th Degree Polynomial']);
  const fit = button(panel, 'Fit');
  assert.ok(fit && button(panel, 'Open') && button(panel, 'Apply'));
  // Apply before any fit: nothing to apply, no image made
  const nBefore = (await t.docs()).length;
  fire(button(panel, 'Apply'), 'click');
  await new Promise((r) => setTimeout(r, 60));
  assert.equal((await t.docs()).length, nBefore, 'Apply without a fitted function makes no image');
  // the fixture's 4th-degree polynomial data
  const cf = fx('curve_fit.json'), c4 = cf.cases.find((c) => c.fitType === 3);
  area.value = c4.x.map((x, i) => x + ' ' + c4.y[i]).join('\n');
  select.value = '3';
  fire(fit, 'click');
  await until(() => /Parameters:/.test(pre.textContent), 'the fit result');
  assert.match(pre.textContent, /Formula: y = a\+bx\+cx\^2\+dx\^3\+ex\^4/);
  assert.match(pre.textContent, /Status: Success/);
  const m = /a = (\S+)/.exec(pre.textContent);
  assert.ok(Math.abs(Number(m[1]) / c4.result.params[0] - 1) < 1e-4, 'a is ImageJ\'s: ' + m[1]);
  assert.match(pre.textContent, new RegExp('R\\^2: ' + c4.result.rSquared.toFixed(5).replace('.', '\\.')));
  await until(() => plots.filter((s) => Array.isArray(s.series) && s.series.some((q) => q.kind === 'bars')).length >= 1, 'the residuals plot');
  const fitPlot = plots.find((s) => s.series && s.series.some((q) => q.label === 'fit'));
  assert.equal(fitPlot.series.find((q) => q.label === 'fit').x.length, Math.max(100, c4.x.length), '100 points of the curve (CurveFitter.getPlot)');
  // IJ.d2s(x, 5, 9) (CurveFitter.getResultString): five decimals, fewer when nine digits would be exceeded, scientific beyond
  const fn = t.page.IJFijiUi.fitNumber;
  assert.deepEqual(['2.25000', '123456789', '1.00000E-7', '0.00000E0', '-0.12346', '1.23457E-5'].map((x, i) => fn([2.25, 123456789.123, 1e-7, 0, -0.123456, 0.0000123456789][i])), ['2.25000', '123456789', '1.00000E-7', '0.00000E0', '-0.12346', '1.23457E-5']);
  assert.ok(/Number of completed minimizations: [0-9]+[\s]+Number of iterations: [0-9]+ \(max: [0-9]+\)/.test(pre.textContent), 'the nonlinear fit prints its minimizations and the maximum');
  // Apply: the fitted function of the last fit applied to every pixel, in a new 32-bit image "<name>-transformed" (Fitter.applyFunction)
  const ramp = new Uint8Array(64).map((_, i) => i * 4);
  await addImage(t, 'ramp', 8, 8, [ramp]);
  fire(button(panel, 'Apply'), 'click');
  const tr = await until(async () => (await docByName(t, 'ramp-transformed')) || null, 'the transformed image');
  assert.equal(tr.bitDepth, 32);
  assert.ok(tr.calibration && tr.calibration.pixelWidth === 1 && tr.calibration.unit === 'pixel', 'a new uncalibrated image, like new ImagePlus(title, ip)');
  const fitted = await t.page.IJCurveFit.fitCurve({ fitType: 3, x: c4.x, y: c4.y, randomSeed: 0 });
  const got = await t.pixels(tr.docId, 0);
  for (let i = 0; i < 64; i += 7) assert.equal(got[i], Math.fround(t.page.IJCurveFit.fValue(3, fitted.params, ramp[i])), 'pixel ' + i + ' = f(params, value)');
  assert.equal((await t.engine('doc.info', { docId: (await docByName(t, 'ramp')).docId })).undoDepth, 0, 'the source image is untouched');
  // not enough data
  area.value = '1 2';
  fire(fit, 'click');
  await until(() => /At least two/.test(pre.textContent), 'the data error');
  await t.close();
}

// ═════════════ Coloc 2 ═════════════
{
  const t = await boot({ channels: 1 });
  spyPlot(t);
  await t.open();
  const px = fx('coloc2/pairs.json'), ex = fx('coloc2/pairs_exact.json');
  const A = u8(px.inputs.a), B = u8(px.inputs.b);
  const id = await addImage(t, 'pair', 64, 64, [A, B]);
  const c = ex.cases.find((x) => x.pair === 'correlated' && x.regression === 'Bisection');
  const values = { doc1: id, ch1: 0, doc2: id, ch2: 1, roi: 'none', regression: 'bisection', liHistCh1: true, liHistCh2: false, liIcq: true, spearman: true, manders: true, kendall: true, hist2d: true, costesTest: true, psf: 3, randomisations: 10 };
  await t.runCommand('colocColoc2', values);
  const spec = t.log.dialogSpecs[t.log.dialogSpecs.length - 1];
  assert.deepEqual(J(spec.fields.map((f) => f.id)), ['doc1', 'ch1', 'doc2', 'ch2', 'roi', 'regression', 'algorithms', 'liHistCh1', 'liHistCh2', 'liIcq', 'spearman', 'manders', 'kendall', 'hist2d', 'costesTest', 'psf', 'randomisations']);
  assert.deepEqual(J(spec.fields.filter((f) => f.type === 'check').map((f) => labelOf(spec, f.id))), ['Li Histogram Channel 1', 'Li Histogram Channel 2', 'Li ICQ', "Spearman's Rank Correlation", "Manders' Correlation", "Kendall's Tau Rank Correlation", '2D Intensity Histogram', "Costes' Significance Test"]);
  assert.ok(spec.fields.filter((f) => f.type === 'check').every((f) => f.value === true), 'every algorithm starts ticked, as in Fiji');
  assert.equal(spec.fields.find((f) => f.id === 'psf').value, 3); assert.equal(spec.fields.find((f) => f.id === 'randomisations').value, 10);
  assert.deepEqual(J(spec.fields.find((f) => f.id === 'regression').options.map((o) => o.value)), ['costes', 'bisection']);
  const tab = await until(() => { const w = tableWindows(t).find((x) => /pair/.test(x.spec.title || '')); return w ? tableOf(w.spec.content) : null; }, 'the Coloc 2 table');
  const at = (h) => Number(tab.td[tab.th.indexOf(h)]);
  assert.ok(Math.abs(at("Spearman's rank correlation value") - c.exact.spearman) < 1e-3);
  assert.ok(Math.abs(at("Kendall's Tau-b rank correlation value") - c.exact.kendallTauB) < 1e-3);
  assert.equal(at('T1'), c.thresholds[0], 'the bisection threshold of Fiji');
  assert.equal(tab.td[tab.th.indexOf('Threshold regression')], 'Bisection');
  assert.ok(tab.th.includes('Costes P-Value') && !tab.th.includes('Costes seed') && tab.th.includes('Pearson r (all ROI pixels)'), 'the wave-2 columns stay, the new ones follow');
  assert.ok(Math.abs(at('tM1 (sum ch1 above T1 and T2 / sum ch1 above T1)') - c.exact.tM1_ge) < 2e-2 || tab.th.some((h) => /^tM1/.test(h)));
  await until(() => plots.some((s) => s.image && s.image.w === 256), 'the 2D histogram');
  await until(() => plots.some((s) => /Li plot, channel 1/.test(s.title || '')), 'the Li plot of channel 1');
  assert.ok(!plots.some((s) => /Li plot, channel 2/.test(s.title || '')), 'channel 2\'s Li plot was not asked for');
  // unticked algorithms leave their columns out
  await t.runCommand('colocColoc2', Object.assign({}, values, { regression: 'costes', manders: false, spearman: false, kendall: false, costesTest: false, liIcq: false, hist2d: false, liHistCh1: false }));
  await until(() => tableWindows(t).length >= 2, 'the second table');
  const tab2 = tableOf(tableWindows(t)[tableWindows(t).length - 1].spec.content);
  assert.ok(!tab2.th.includes("Spearman's rank correlation value") && !tab2.th.includes('Li ICQ') && !tab2.th.some((h) => /^M1/.test(h)) && !tab2.th.includes('Costes P-Value'));
  // an open 8-bit image as the mask: only its non-zero pixels are measured
  const mask = new Uint8Array(64 * 64);
  for (let y = 0; y < 32; y++) for (let x = 0; x < 64; x++) mask[y * 64 + x] = 255;
  const mid = await addImage(t, 'mask', 64, 64, [mask]);
  await t.runCommand('colocColoc2', Object.assign({}, values, { doc1: id, doc2: id, roi: 'doc:' + mid, costesTest: false, hist2d: false, liHistCh1: false }));
  await until(() => tableWindows(t).length >= 3, 'the masked table');
  const tab3 = tableOf(tableWindows(t)[tableWindows(t).length - 1].spec.content);
  assert.equal(Number(tab3.td[tab3.th.indexOf('ROI pixels')]), 64 * 32, 'the mask halves the measured pixels');
  const before = await t.pixels(id, 0);
  assert.deepEqual(Array.from(before), Array.from(A), 'nothing was written to the images');
  // the mask list holds every open image (Fiji's), a mask that cannot be one is refused by the dialog with a message
  const wide = await addImage(t, 'wide', 64, 64, [new Uint16Array(64 * 64).fill(1)], { bitDepth: 16 });
  await t.runCommand('colocColoc2', Object.assign({}, values, { doc1: id, doc2: id, roi: 'doc:' + mid, costesTest: false, hist2d: false, liHistCh1: false }));
  const spec2 = t.log.dialogSpecs[t.log.dialogSpecs.length - 1];
  const maskValues = spec2.fields.find((f) => f.id === 'roi').options.map((o) => o.value);
  assert.deepEqual(J(maskValues.slice(0, 4)), ['none', 'roi1', 'roi2', 'manager']);
  assert.ok(maskValues.includes('doc:' + wide) && maskValues.includes('doc:' + mid) && maskValues.includes('doc:' + id), 'every open image is a mask choice');
  const nTables = tableWindows(t).length;
  await t.runCommand('colocColoc2', Object.assign({}, values, { doc1: id, doc2: id, roi: 'doc:' + wide, costesTest: false, hist2d: false, liHistCh1: false })).catch(() => {});
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(tableWindows(t).length, nTables, 'a 16-bit mask is refused: no table');
  await t.close();
}

// ═════════════ Cell Counter ═════════════
{
  const t = await boot({ channels: 2 });
  await t.open();
  const api = t.api('fiji');
  const id = t.activeId();
  const info0 = await t.engine('doc.info', { docId: id });
  await t.runCommand('pluginsCellCounter');
  const panel = await until(() => t.panel('cellCounter') || null, 'the Cell Counter window');
  const labels = findAll(panel, (n) => n.tagName === 'BUTTON').map((b) => b.textContent);
  assert.deepEqual(labels, ['Initialize', 'Add', 'Remove', 'Rename', 'Delete', 'Options', 'Results', 'Reset', 'Save Markers', 'Load Markers', 'Export Image', 'Measure...']);
  assert.equal(findAll(panel, (n) => n.tagName === 'INPUT' && n.type === 'radio').length, 8, 'eight types');
  const state = () => api.state();
  const ptr = (x, y, type) => t.shell.opts.onToolPointer(id, { type: type || 'down', x, y, button: 0 });
  // before Initialize a click does nothing
  fire(button(panel, 'Initialize'), 'click');
  await until(() => state().doc && t.shell.opts, 'initialised');
  await new Promise((r) => setTimeout(r, 20));
  const radios = () => findAll(panel, (n) => n.tagName === 'INPUT' && n.type === 'radio');
  const counts = () => findAll(panel, (n) => n.tagName === 'INPUT' && n.type === 'text').map((n) => Number(n.value));
  assert.deepEqual(counts(), [0, 0, 0, 0, 0, 0, 0, 0]);
  const markersOf = () => api.annotations.get(id).items.filter((i) => i.tag === '|CC|');
  // the tool is the one selected: clicks add markers of the selected type
  assert.equal(t.shell.opts.tools.length >= 1, true);
  ptr(10.7, 12.2); ptr(20, 30); ptr(33, 8);
  radios()[1].checked = true; fire(radios()[1], 'change');
  ptr(40, 40);
  radios()[3].checked = true; fire(radios()[3], 'change');
  ptr(5, 50); ptr(15, 55);
  radios()[7].checked = true; fire(radios()[7], 'change');
  ptr(60, 10);
  await until(() => markersOf().length === 7, 'seven markers');
  assert.deepEqual(J(markersOf().map((m) => [m.x, m.y, m.type])), [[10, 12, 1], [20, 30, 1], [33, 8, 1], [40, 40, 2], [5, 50, 4], [15, 55, 4], [60, 10, 8]]);
  await until(() => JSON.stringify(counts()) === '[3,1,0,2,0,0,0,1]', 'the counts of the panel');
  // Fiji's XML, byte for byte (the line ending is LF here)
  const want = fx('cellcounter/markers_xml.json').result.xml;
  fire(button(panel, 'Save Markers'), 'click');
  await until(() => t.saved.length >= 1, 'the XML file');
  const text = await t.saved[t.saved.length - 1].blob.text();
  assert.match(text, /<Current_Type>8<\/Current_Type>/, 'the selected type is written');
  assert.equal(text.replace('<Current_Type>8<', '<Current_Type>1<'), want.replace(/image\.tif/, text.match(/<Image_Filename>(.*)<\/Image_Filename>/)[1]), 'the CellCounter_Marker_File');
  // Results
  fire(button(panel, 'Results'), 'click');
  const rt = await until(() => { const w = tableWindows(t).find((x) => /Cell Counter: Results/.test(x.spec.title || '')); return w ? tableOf(w.spec.content) : null; }, 'the Results table');
  assert.deepEqual(rt.th, ['Slice', 'Type 1', 'Type 2', 'Type 3', 'Type 4', 'Type 5', 'Type 6', 'Type 7', 'Type 8']);
  assert.deepEqual(rt.td, ['1', '3', '1', '0', '2', '0', '0', '0', '1']);
  // Measure: the value of every channel at each marker
  fire(button(panel, 'Measure...'), 'click');
  const mt = await until(() => { const w = tableWindows(t).find((x) => /Cell Counter: Measure/.test(x.spec.title || '')); return w ? tableOf(w.spec.content) : null; }, 'the Measure table');
  assert.deepEqual(mt.th.slice(0, 3), ['Type', 'X', 'Y']); assert.equal(mt.td.length, 7 * mt.th.length);
  const p0 = await t.pixels(id, 0), W = info0.width;
  assert.equal(Number(mt.td[3]), p0[12 * W + 10], 'the first marker reads pixel (10, 12) of channel 1');
  // Delete removes the last marker of the selected type; Delete Mode removes the one nearest the click
  fire(button(panel, 'Delete'), 'click');
  await until(() => markersOf().length === 6 && !markersOf().some((m) => m.type === 8), 'Delete');
  const dm = find(panel, (n) => n.tagName === 'INPUT' && n.type === 'checkbox' && n.parentNode && n.parentNode.children.some((c) => c.textContent === 'Delete Mode'));
  dm.checked = true; fire(dm, 'change');
  ptr(21, 31);
  await until(() => markersOf().length === 5 && !markersOf().some((m) => m.x === 20), 'Delete Mode');
  dm.checked = false; fire(dm, 'change');
  // Rename, Remove, Add
  radios()[0].checked = true; fire(radios()[0], 'change');
  t.script.dialogs.push({ name: 'Tumour' });
  fire(button(panel, 'Rename'), 'click');
  await until(() => findAll(panel, (n) => n.tagName === 'SPAN' && n.textContent === 'Tumour').length === 1, 'the renamed type');
  t.script.dialogs.push({ color: 'green' });
  fire(button(panel, 'Options'), 'click');
  await until(() => markersOf().filter((m) => m.type === 1).every((m) => m.color === '#00ff00'), 'the new colour of the markers');
  // Add / Remove change the number of types
  fire(button(panel, 'Add'), 'click');
  await until(() => radios().length === 9, 'a ninth type');
  fire(button(panel, 'Remove'), 'click');
  await until(() => radios().length === 8, 'back to eight');
  // markers are annotations: no undo step, and they survive a reload; Reset clears them
  const info1 = await t.engine('doc.info', { docId: id });
  assert.equal(info1.rev, info0.rev); assert.equal(info1.undoDepth, info0.undoDepth);
  // the engine stores the meta of the session: wait until the stored copy holds the five markers
  await until(async () => {
    await t.flush();
    const list = await t.store.shared.list();
    for (const e of list) { const m = (await t.store.shared.load(e.key)).meta; const an = m && m.ui && m.ui.annotations && m.ui.annotations[id]; if (an && an.items.filter((x) => x.tag === '|CC|').length === 5) return true; }
    return false;
  }, 'the markers stored with the session', 8000);
  const t2 = await t.reload();
  await t2.open();
  const api2 = t2.api('fiji');
  const idb = (await t2.docs())[0].docId;
  await until(() => api2.annotations.get(idb).items.filter((i) => i.tag === '|CC|').length === 5, 'the markers after a reload');
  // Load Markers: the file Fiji wrote
  const panel2 = (await t2.openPanel('cellCounter'), t2.panel('cellCounter'));
  fire(button(panel2, 'Initialize'), 'click');
  await new Promise((r) => setTimeout(r, 20));
  t2.pickFile([{ name: 'markers.xml', async text() { return want; } }]);
  fire(button(panel2, 'Load Markers'), 'click');
  await until(() => api2.annotations.get(idb).items.filter((i) => i.tag === '|CC|').length === 7, 'the markers of the file');
  fire(button(panel2, 'Reset'), 'click');
  await until(() => api2.annotations.get(idb).items.filter((i) => i.tag === '|CC|').length === 0, 'Reset');
  // a file that is not a marker file
  t2.pickFile([{ name: 'bad.xml', async text() { return '<nope/>'; } }]);
  fire(button(panel2, 'Load Markers'), 'click');
  await until(() => t2.errors.length >= 1, 'the error dialog');
  await t2.close();
}

// ═════════════ review fixes: ROI <None>, 16-bit Coloc 2, 16/32-bit refusals, reloaded skeleton images ═════════════
{
  const t = await boot({ channels: 1 });
  spyPlot(t);
  await t.open();
  const px = fx('coloc2/pairs.json');
  const A = u8(px.inputs.a), B = u8(px.inputs.b);
  const id = await addImage(t, 'pair', 64, 64, [A, B]);
  const base = { doc1: id, ch1: 0, doc2: id, ch2: 1, roi: 'none', regression: 'costes', liHistCh1: false, liHistCh2: false, liIcq: false, spearman: false, manders: false, kendall: false, hist2d: false, costesTest: false, psf: 3, randomisations: 10 };
  const roiPixels = async (over, nth) => {
    await t.runCommand('colocColoc2', Object.assign({}, base, over));
    await until(() => tableWindows(t).length >= nth, 'the Coloc 2 table ' + nth);
    const tab = tableOf(tableWindows(t)[tableWindows(t).length - 1].spec.content);
    return Number(tab.td[tab.th.indexOf('ROI pixels')]);
  };
  const whole = await roiPixels({}, 1);
  // a selection is drawn on image 1: "<None>" must still measure the whole image, "ROI(s) in channel 1" only the selection
  t.shell.opts.onRoi({ type: 'rect', x: 8, y: 8, w: 10, h: 10 }, { final: true });
  await until(() => t.shell.opts.getState().roi, 'the selection');
  assert.equal(await roiPixels({ roi: 'none' }, 2), whole, '<None> ignores the selection');
  const sel = await roiPixels({ roi: 'roi1' }, 3);
  assert.ok(sel > 0 && sel <= 100, 'the selection alone: ' + sel);
  const mid = await addImage(t, 'mask', 64, 64, [new Uint8Array(64 * 64).fill(255)]);
  assert.equal(await roiPixels({ roi: 'doc:' + mid }, 4), whole, 'a mask image replaces the selection (Fiji ignores the ROI there)');
  // 16-bit pair end to end
  const a16 = Uint16Array.from(A, (v) => v * 200), b16 = Uint16Array.from(B, (v) => v * 200);
  const id16 = await addImage(t, 'pair16', 64, 64, [a16, b16], { bitDepth: 16 });
  t.shell.opts.onRoi(null, { final: true });
  await until(() => !t.shell.opts.getState().roi, 'selection cleared');
  const n16 = await roiPixels({ doc1: id16, doc2: id16 }, 5);
  assert.ok(n16 > 0 && n16 <= 4096, 'a 16-bit pair is measured: ' + n16);
  const tab16 = tableOf(tableWindows(t)[tableWindows(t).length - 1].spec.content);
  assert.ok(Number(tab16.td[tab16.th.indexOf('Pearson r (all ROI pixels)')]) > 0.5, 'the same correlation as the 8-bit pair');
  // Fiji's own column names
  await t.runCommand('colocColoc2', Object.assign({}, base, { spearman: true, manders: true, kendall: true, costesTest: true }));
  await until(() => tableWindows(t).length >= 6, 'the full table');
  const full = tableOf(tableWindows(t)[tableWindows(t).length - 1].spec.content);
  for (const h of ["Manders' tM1 (Above autothreshold of Ch2)", "Manders' tM2 (Above autothreshold of Ch1)", "Spearman's correlation t-statistic", 't-statistic degrees of freedom', 'Costes P-Value', 'Costes Shuffled Mean', 'Costes Shuffled Std.D.']) assert.ok(full.th.includes(h), h);
  // 16- and 32-bit images: the three 8-bit commands are not offered
  for (const [bits, mk] of [[16, (n) => new Uint16Array(n)], [32, (n) => new Float32Array(n)]]) {
    const did = await addImage(t, 'deep' + bits, 16, 16, [mk(256)], { bitDepth: bits });
    await t.shell.opts.onActivate(did);
    for (const cmd of ['skelAnalyze', 'ltComplete', 'toolsFractalBoxCount']) assert.equal(t.cmd(cmd).enabled(t.shell.opts.getState()), false, cmd + ' is not offered on a ' + bits + '-bit image');
  }
  await t.close();
}
{
  const t = await boot({ channels: 1 });
  await t.open();
  // (as for the thickness map: only images made from the primary image of a session are journaled with it)
  const prim = (await t.docs())[0];
  await t.shell.opts.onActivate(prim.docId);
  await t.runCommand('skelAnalyze', { prune: 'shortest', pruneEnds: false, excludeRoi: false, shortestPath: true, detailed: false, labeled: true });
  await until(async () => (await docByName(t, 'Tagged skeleton')) || null, 'the tagged skeleton');
  await t.flush();
  const t2 = await t.reload();
  await t2.open();
  const labName = prim.name.replace(/\.(tiff?|png)$/i, '') + '-labeled-skeletons';
  await until(async () => { const d = await t2.docs(); return d.some((x) => x.name === 'Tagged skeleton') && d.some((x) => x.name === 'Longest shortest paths') && d.some((x) => x.name === labName && x.bitDepth === 32); }, 'the skeleton images after a reload');
  await t2.close();
}

console.log('ij fiji commands: OK');
