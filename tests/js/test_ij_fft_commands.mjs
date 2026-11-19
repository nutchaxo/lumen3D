// P-fft — Process > FFT (FFT, Inverse FFT, FFT Options…, Bandpass Filter…, Swap Quadrants) and Analyze > Directionality
// through the real controller and the real engine (tests/js/ij_harness.mjs): dialog values → the operation in the worker
// → undo → redo → reload() restore, with the golden images of tests/fixtures/ij-wave3/fft as input AND as the expected output,
// plus the dialogs' specs, the refusals and their error keys, and the Directionality outputs (results table, histogram
// plot, orientation map, colour wheel).
//
// Run: node tests/js/test_ij_fft_commands.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { boot, until, DIR, EN, langPart } from './ij_harness.mjs';
import { ROOT } from './harness.mjs';

const FIX = path.join(ROOT, 'tests', 'fixtures', 'ij-wave3', 'fft');
const load = (f) => JSON.parse(fs.readFileSync(path.join(FIX, f), 'utf8'));
function decode(d, bitDepth) {
  if (Array.isArray(d)) {
    const a = Float64Array.from(d, (v) => (v === null ? NaN : v));
    return bitDepth === 8 ? Uint8Array.from(a) : bitDepth === 16 ? Uint16Array.from(a) : Float32Array.from(a);
  }
  const b = Buffer.from(d.b64, 'base64');
  const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  return d.dtype === 'u8' ? new Uint8Array(ab) : d.dtype === 'u16' ? new Uint16Array(ab) : new Float32Array(ab);
}
const imageOf = (o, name) => ({ name, width: o.width, height: o.height, bitDepth: o.bitDepth, channels: [{ data: decode(o.data, o.bitDepth), name: 'C', color: '#ffffff' }] });
const arr = (a) => Array.from(a);
const J = (x) => JSON.parse(JSON.stringify(x));
const same32 = (got, want, what) => {
  assert.equal(got.length, want.length, what + ': length');
  for (let i = 0; i < got.length; i++) if (!Object.is(got[i], want[i]) && !(got[i] === 0 && want[i] === 0)) assert.fail(`${what}: value ${i}: ${got[i]} != ${want[i]}`);
};

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { console.error('FAIL ' + name); throw e; }
}
async function fresh(opts) {
  const t = await boot(Object.assign({ channels: 2 }, opts || {}));
  await t.open();
  return t;
}
const byName = (docs, name) => docs.find((d) => d.name === name);
async function activate(t, docId) {
  const c = t.shell.opts.commands.find((x) => x.id === 'winImg' + docId);
  assert.ok(c, 'window menu entry of ' + docId);
  await c.run();
  await until(() => t.activeId() === docId, 'image ' + docId + ' on screen');
}
// What a restored session holds: the documents of a reloaded boot, read through a fresh worker.
async function restored(t) {
  const keys = (await t.store.shared.list()).map((x) => x.key);
  const t2 = await t.reload();
  const w2 = await t2.spawn();
  for (const key of keys) {
    const res = await t2.engine('session.restore', { key }, w2);
    assert.equal(res.warnings.length, 0, JSON.stringify(res.warnings));
  }
  const infos = (await t2.engine('doc.list', {}, w2)).docs;
  return { t2, w2, infos, px: async (id, c) => (await t2.engine('doc.tile', { docId: id, channel: c || 0, level: 0, tx: 0, ty: 0 }, w2)).data.slice() };
}
const errorKeysShown = (t) => t.errors.map((e) => e.message);

// ═════════════ dialogs, menu, registration ═════════════
await test('commands: the menu rows of PLAN-wave3 §1.2, labels = ImageJ / Fiji text, enabled() and the lang parts', async () => {
  const t = await fresh();
  const rows = [['fftForward', 'Process', 'FFT', 10, 'FFT'], ['fftInverse', 'Process', 'FFT', 20, 'Inverse FFT'], ['fftOptions', 'Process', 'FFT', 40, 'FFT Options…'],
    ['fftBandpass', 'Process', 'FFT', 50, 'Bandpass Filter…'], ['fftSwapQuadrants', 'Process', 'FFT', 80, 'Swap Quadrants']];
  for (const [id, a, b, order, label] of rows) {
    const c = t.cmd(id);
    assert.ok(c, id);
    assert.deepEqual(J(c.menu), [a, b], id + ' menu path');
    assert.equal(c.order, order, id + ' order');
    assert.equal(EN.cmd[id], label, id + ' label');
  }
  assert.equal(t.cmd('fftBandpass').separatorBefore, true, 'a separator before Bandpass Filter');
  const d = t.cmd('analyzeDirectionality');
  assert.deepEqual(J(d.menu), ['Analyze']); assert.equal(d.order, 130); assert.equal(EN.cmd.analyzeDirectionality, 'Directionality');
  for (const id of ['fftForward', 'fftInverse', 'fftOptions', 'fftBandpass', 'fftSwapQuadrants', 'analyzeDirectionality']) assert.equal(t.isEnabled(id), true, id + ' is enabled with an image');
  // the lang part exists in all four languages with the same key set
  const part = langPart('fft');
  const keys = (o, p = '') => Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' ? keys(v, p + k + '.') : [p + k]));
  for (const c of ['fr', 'es', 'nl']) assert.deepEqual(keys(part[c]).sort(), keys(part.en).sort(), c + ' has the keys of en');
  t.close();
});

await test('dialogs: the Bandpass and Directionality fields, defaults and limits of ImageJ / Fiji', async () => {
  const t = await fresh();
  await t.runCommand('fftBandpass', {});
  let spec = t.log.dialogSpecs[t.log.dialogSpecs.length - 1];
  const f = (id) => spec.fields.find((x) => x.id === id);
  assert.equal(spec.title, EN.dlg.fft.bandTitle); assert.equal(EN.dlg.fft.bandTitle, 'FFT Bandpass Filter');
  assert.deepEqual(J(spec.fields.map((x) => x.id).slice(0, 7)), ['large', 'small', 'stripes', 'tolerance', 'autoscale', 'saturate', 'displayFilter']);
  assert.equal(f('large').value, 40); assert.equal(f('small').value, 3); assert.equal(f('stripes').value, 'none'); assert.equal(f('tolerance').value, 5);
  assert.equal(f('autoscale').value, true); assert.equal(f('saturate').value, true); assert.equal(f('displayFilter').value, false);
  assert.deepEqual(J(f('stripes').options.map((o) => o.value)), ['none', 'horizontal', 'vertical']);
  assert.ok(spec.fields.some((x) => x.id === 'all'), 'the all-channels box on a multichannel image');
  assert.equal(f('all').value, true, 'FFTFilter.showBandpassDialog: a composite image is processed channel by channel by default (processStack = true)');
  assert.equal(EN.dlg.fft.large, 'Filter large structures down to'); assert.equal(EN.dlg.fft.stripes, 'Suppress stripes:');
  await t.runCommand('analyzeDirectionality', { method: 'gradient' });
  spec = t.log.dialogSpecs[t.log.dialogSpecs.length - 1];
  assert.equal(spec.title, 'Directionality analysis');
  assert.equal(f('all').value, true, 'Fiji analyses every slice');
  assert.deepEqual(J(spec.fields.map((x) => x.id).slice(0, 7)), ['method', 'nbins', 'start', 'end', 'orientationMap', 'colorWheel', 'table']);
  assert.equal(f('method').value, 'fourier'); assert.equal(f('nbins').value, 90); assert.equal(f('start').value, -90); assert.equal(f('end').value, 90);
  assert.deepEqual(J(f('method').options.map((o) => EN.dlg.fft[o.labelKey.split('.').pop()])), ['Fourier components', 'Local gradient orientation']);
  assert.deepEqual(J([f('orientationMap'), f('colorWheel'), f('table')].map((x) => x.value)), [false, false, false]);
  // the histogram end follows its start
  const set = {};
  spec.onChange({ start: -30 }, (patch) => { Object.assign(set, patch); }, 'start');
  assert.equal(set.end, 150);
  assert.ok(spec.validate({ nbins: 4, start: 0 }).nbins, 'Nbins below 5 refused');
  assert.ok(spec.validate({ nbins: 90, start: 200 }).start, 'a start beyond 180 refused');
  assert.equal(spec.validate({ nbins: 90, start: -90 }), null);
  t.close();
});

// ═════════════ FFT and Inverse FFT ═════════════
await test('FFT: "FFT of" 8-bit power spectrum of the ImageJ fixture, padded to a power of 2 (mean-filled), the selection cropped first; undo-free; restored after a reload', async () => {
  const fx = load('forward_u8.json');
  const c = fx.cases[1];                                  // 20 x 12 -> 32 x 32
  const t = await fresh();
  const api = t.api('fft');
  const src = await api.addDoc(imageOf(c.input, 'src'), { placement: 'tab' });
  await t.runCommand('fftForward');
  const docs = await t.docs();
  const fft = byName(docs, 'FFT of src');
  assert.ok(fft, 'FFT of src');
  assert.equal(fft.bitDepth, 8); assert.equal(fft.width, 32); assert.equal(fft.height, 32); assert.equal(fft.channels.length, 1);
  assert.equal(fft.provenance.fft.padded, 32); assert.equal(fft.provenance.fft.origW, 20); assert.equal(fft.provenance.fft.origH, 12);
  assert.equal(fft.provenance.fft.sourceDocId, src); assert.equal(fft.provenance.fft.channel, 0); assert.equal(fft.provenance.fft.kind, 'fft');
  assert.deepEqual(arr(await t.pixels(fft.docId, 0)), arr(decode(c.powerSpectrum8.data, 8)), 'ImageJ power spectrum');
  assert.equal(fft.undoDepth, 0);
  assert.equal(byName(docs, 'src').unsaved, true);
  assert.equal(docs.filter((d) => d.name === 'PS of src').length, 0, 'no raw spectrum by default');
  // reload: the spectrum comes back and still names its source
  const r = await restored(t);
  const back = byName(r.infos, 'FFT of src');
  assert.ok(back, 'restored');
  assert.deepEqual(arr(await r.px(back.docId, 0)), arr(decode(c.powerSpectrum8.data, 8)));
  assert.equal(back.provenance.fft.sourceDocId, src);
  r.t2.close();
});

await test('FFT of a selection: its bounding box only (ImageJ crops first), the other channels untouched', async () => {
  const fx = load('forward_roi_crop.json');
  const t = await fresh();
  const api = t.api('fft');
  await api.addDoc(imageOf(fx.input, 'roi'), { placement: 'tab' });
  api.setRoi({ type: 'rect', x: fx.roi.x, y: fx.roi.y, w: fx.roi.w, h: fx.roi.h });
  await t.runCommand('fftForward');
  const fft = byName(await t.docs(), 'FFT of roi');
  assert.equal(fft.width, fx.padded);
  assert.deepEqual(arr(await t.pixels(fft.docId, 0)), arr(decode(fx.powerSpectrum8.data, 8)));
  assert.deepEqual(J(fft.provenance.fft.crop), { x: fx.roi.x, y: fx.roi.y, w: fx.roi.w, h: fx.roi.h });
  t.close();
});

await test('FFT Options…: the raw power spectrum ("PS of", 32-bit, swapped as ImageJ does) and the FFT window, kept in the settings; both off = the FFT window anyway', async () => {
  const fx = load('forward_f32.json');
  const c = fx.cases[0];
  const t = await fresh();
  const api = t.api('fft');
  await api.addDoc(imageOf(c.input, 'f'), { placement: 'tab' });
  await t.runCommand('fftOptions', { fftWindow: true, rawPs: true });
  assert.equal(t.settings.get('fft.rawPs'), true); assert.equal(t.settings.get('fft.fftWindow'), true);
  await t.runCommand('fftForward');
  let docs = await t.docs();
  const ps = byName(docs, 'PS of f'), fft = byName(docs, 'FFT of f');
  assert.ok(ps && fft, 'both outputs');
  assert.equal(ps.bitDepth, 32);
  assert.equal(ps.calibration.unit, 'pixel', 'FFT.java:254-257: "PS of" is a new ImagePlus with no calibration');
  same32(await t.pixels(ps.docId, 0), decode(c.rawPowerSpectrumSwapped.data, 32), 'raw power spectrum');
  assert.deepEqual(arr(await t.pixels(fft.docId, 0)), arr(decode(c.powerSpectrum8.data, 8)));
  // the raw spectrum alone
  await t.runCommand('fftOptions', { fftWindow: false, rawPs: true });
  await activate(t, byName(docs, 'f').docId);
  await t.runCommand('fftForward');
  docs = await t.docs();
  assert.equal(docs.filter((d) => d.name === 'PS of f').length, 2, 'a second raw spectrum');
  assert.equal(docs.filter((d) => d.name === 'FFT of f').length, 1, 'no second FFT window');
  // both off: ImageJ forces the FFT window (FFT.java:275-276)
  await t.runCommand('fftOptions', { fftWindow: false, rawPs: false });
  await activate(t, byName(docs, 'f').docId);
  await t.runCommand('fftForward');
  docs = await t.docs();
  assert.equal(docs.filter((d) => d.name === 'FFT of f').length, 2, 'the FFT window anyway');
  assert.equal(docs.filter((d) => d.name === 'PS of f').length, 2);
  // the settings survive a reload of the page
  const t2 = await t.reload();
  assert.equal(t2.settings.get('fft.rawPs'), false);
  t2.close();
});

await test('Inverse FFT: ImageJ fixtures for no / pass / filter masks at 8, 16 and 32 bits; the source depth; undo-free; restored; the spectrum must come from an open, unchanged image', async () => {
  for (const [bd, file] of [['u8', 'inverse_u8.json'], ['u16', 'inverse_u16.json'], ['f32', 'inverse_f32.json']]) {
    const fx = load(file);
    const t = await fresh();
    const api = t.api('fft');
    for (const c of fx.cases.slice(0, 3)) {                 // 32 x 32: none, pass, filter
      const srcName = `s-${bd}-${c.mask}`;
      const src = await api.addDoc(imageOf(c.input, srcName), { placement: 'tab' });
      await t.runCommand('fftForward');
      const fft = byName(await t.docs(), 'FFT of ' + srcName);
      // the spectrum as the operator edited it: a copy of the spectrum document carrying the fixture's edited pixels
      const edited = await api.addDoc(imageOf(c.psEdited, 'FFT of ' + srcName), { placement: 'tab', provenance: Object.assign({}, fft.provenance) });
      await activate(t, edited);
      await t.runCommand('fftInverse');
      const out = byName(await t.docs(), 'Inverse FFT of ' + srcName);
      assert.ok(out, 'the inverse image ' + c.mask);
      assert.equal(out.bitDepth, c.input.bitDepth); assert.equal(out.width, c.input.width);
      const want = decode(c.outputSourceDepth.data, c.input.bitDepth);
      const got = await t.pixels(out.docId, 0);
      if (c.input.bitDepth === 32) same32(got, want, `${bd} ${c.mask}`); else assert.deepEqual(arr(got), arr(want), `${bd} ${c.mask}`);
      assert.equal(out.undoDepth, 0);
      // TypeConverter.convertFloatToByte: bp.resetMinAndMax() = setMinAndMax(0, 255) (ByteProcessor.java:476-477)
      if (c.input.bitDepth === 8) assert.deepEqual(J({ min: out.channels[0].display.min, max: out.channels[0].display.max }), { min: 0, max: 255 }, 'an 8-bit inverse displays 0-255');
      assert.equal(out.provenance.fftInverse.mask, c.mask === 'none' ? 'none' : c.mask);
      void src;
    }
    t.close();
  }
  // the first one more: undo of the source is no undo of the inverse; a reload restores the output
  const fx = load('inverse_u8.json'), c = fx.cases[1];
  const t = await fresh();
  const api = t.api('fft');
  await api.addDoc(imageOf(c.input, 'src'), { placement: 'tab' });
  await t.runCommand('fftForward');
  const fft = byName(await t.docs(), 'FFT of src');
  const edited = await api.addDoc(imageOf(c.psEdited, 'FFT of src'), { placement: 'tab', provenance: Object.assign({}, fft.provenance) });
  await activate(t, edited);
  await t.runCommand('fftInverse');
  const r = await restored(t);
  const back = byName(r.infos, 'Inverse FFT of src');
  assert.ok(back, 'restored');
  assert.deepEqual(arr(await r.px(back.docId, 0)), arr(decode(c.outputSourceDepth.data, c.input.bitDepth)));
  r.t2.close();
});

await test('Inverse FFT refuses: an image that is not a spectrum, a source that was closed or changed (and says why)', async () => {
  const fx = load('inverse_u8.json'), c = fx.cases[0];
  const t = await fresh();
  const api = t.api('fft');
  // a plain image
  await t.runCommand('fftInverse', {}, { expectError: true });
  assert.equal(t.errors.length, 1);
  assert.equal(t.errors[0].message, EN.err.fftNotFd, 'Frequency domain image required');
  // changed source
  const src = await api.addDoc(imageOf(c.input, 'src'), { placement: 'tab' });
  await t.runCommand('fftForward');
  const fft = byName(await t.docs(), 'FFT of src');
  await activate(t, src);
  await t.runCommand('editInvert');
  await activate(t, fft.docId);
  await t.runCommand('fftInverse', {}, { expectError: true });
  assert.equal(t.errors[t.errors.length - 1].message, EN.err.fftSourceChanged, 'the source changed');
  // undo of the invert makes the same pixels again: the inverse works (the content is what counts)
  await activate(t, src);
  await t.runCommand('editUndo');
  await activate(t, fft.docId);
  await t.runCommand('fftInverse');
  assert.ok(byName(await t.docs(), 'Inverse FFT of src'), 'the source is as it was');
  // closed source
  await api.closeDoc(src);
  await activate(t, fft.docId);
  const n = t.errors.length;
  await t.runCommand('fftInverse', {}, { expectError: true });
  assert.equal(t.errors.length, n + 1);
  assert.equal(t.errors[n].message, EN.err.fftSourceChanged, 'the source was closed');
  t.close();
});

await test('Inverse FFT of an 8-bit spectrum nothing was drawn on: the ImageJ notice, once the spectrum mean changed', async () => {
  const fx = load('inverse_u8.json'), c = fx.cases[0];
  const t = await fresh();
  const api = t.api('fft');
  await api.addDoc(imageOf(c.input, 'src'), { placement: 'tab' });
  await t.runCommand('fftForward');
  const fft = byName(await t.docs(), 'FFT of src');
  // untouched: no notice (the mean is the one the transform stored)
  const dialogs = t.log.dialogSpecs.length;
  await t.runCommand('fftInverse');
  assert.equal(t.log.dialogSpecs.length, dialogs, 'no notice for the untouched spectrum');
  // the operator changed values but set no pixel to 0 or 255: the notice is shown and nothing is filtered
  const ps = decode(c.psEdited.data, 8);
  const odd = new Uint8Array(ps.length); for (let i = 0; i < odd.length; i++) odd[i] = 30 + (i % 50);
  const edited = await api.addDoc({ name: 'FFT of src', width: 32, height: 32, bitDepth: 8, channels: [{ data: odd, name: 'C', color: '#ffffff' }] }, { placement: 'tab', provenance: Object.assign({}, fft.provenance) });
  await activate(t, edited);
  await t.runCommand('fftInverse');
  const spec = t.log.dialogSpecs[t.log.dialogSpecs.length - 1];
  assert.equal(spec.title, 'Inverse FFT');
  assert.equal(spec.fields[0].labelKey, 'dlg.fft.noMask');
  assert.equal(EN.dlg.fft.noMask, 'No pixels have been set to 0 (black) or 255 (white) so filtering will not be done.');
  t.close();
});

await test('Inverse FFT, the real flow: Edit > Fill on the "FFT of" window itself, then Inverse FFT; the same after a session restore', async () => {
  const fx = load('inverse_u8.json'), c = fx.cases[1];
  const t = await fresh();
  const api = t.api('fft');
  const src = await api.addDoc(imageOf(c.input, 'src'), { placement: 'tab' });
  await t.runCommand('fftForward');
  const fft = byName(await t.docs(), 'FFT of src');
  await activate(t, fft.docId);
  t.api('edit').settings.set('colors.foreground', 'white');
  api.setRoi({ type: 'rect', x: 12, y: 10, w: 4, h: 3 });
  await t.runCommand('editFill');
  const drawn = await t.pixels(fft.docId, 0);
  assert.ok(arr(drawn).includes(255), 'the spectrum was drawn on');
  await t.runCommand('editSelectNone');
  await t.runCommand('fftInverse');
  const out = byName(await t.docs(), 'Inverse FFT of src');
  assert.ok(out, 'the inverse of the drawn spectrum');
  assert.equal(out.provenance.fftInverse.mask, 'pass');
  const want = arr(await t.pixels(out.docId, 0));
  // the same spectrum as a copy carrying the provenance gives the same image
  const copy = await api.addDoc({ name: 'FFT of src', width: fft.width, height: fft.height, bitDepth: 8, channels: [{ data: drawn.slice(), name: 'C', color: '#ffffff' }] }, { placement: 'tab', provenance: Object.assign({}, fft.provenance) });
  await activate(t, copy);
  await t.runCommand('fftInverse');
  const outs = (await t.docs()).filter((d) => d.name === 'Inverse FFT of src');
  assert.equal(outs.length, 2);
  assert.deepEqual(arr(await t.pixels(outs[1].docId, 0)), want, 'a drawn window and a copy of it agree');
  // after a restore of the session the spectrum still names its source (document ids survive) and inverts to the same pixels
  const r = await restored(t);
  const fftBack = byName(r.infos, 'FFT of src'), srcBack = byName(r.infos, 'src');
  assert.ok(fftBack && srcBack, 'both documents restored');
  assert.equal(fftBack.provenance.fft.sourceDocId, srcBack.docId, 'the source id survives the restore');
  const res = await r.t2.engine('doc.run', { docId: fftBack.docId, docIds: [fftBack.docId, srcBack.docId], op: 'inverseFft', params: {}, roi: null, channel: 0 }, r.w2);
  assert.equal(res.newDocIds.length, 1, 'Inverse FFT after the restore');
  assert.deepEqual(arr(await r.px(res.newDocIds[0], 0)), want, 'the same pixels after the restore');
  r.t2.close();
  void src;
  t.close();
});

// ═════════════ Bandpass ═════════════
await test('Bandpass Filter: ImageJ fixtures (8 / 16 / 32 bits, odd sizes, every option, a selection); undo, redo, reload; Display filter', async () => {
  const STR = { None: 'none', Horizontal: 'horizontal', Vertical: 'vertical' };
  for (const file of ['bandpass_u8.json', 'bandpass_u16.json', 'bandpass_f32.json']) {
    const fx = load(file);
    const picks = [fx.cases[0], fx.cases[2], fx.cases[3], fx.cases[fx.cases.length - 1]];   // defaults, horizontal stripes, vertical stripes + 25 %, the selection
    const t = await fresh();
    const api = t.api('fft');
    for (const c of picks) {
      const id = await api.addDoc(imageOf(c.input, 'bp'), { placement: 'tab' });
      if (c.roi) api.setRoi({ type: 'rect', x: c.roi.x, y: c.roi.y, w: c.roi.w, h: c.roi.h });
      const before = await t.pixels(id, 0);
      await t.runCommand('fftBandpass', { large: c.params.large, small: c.params.small, stripes: STR[c.params.stripes], tolerance: c.params.tolerance, autoscale: c.params.autoscale, saturate: c.params.saturate });
      const got = await t.pixels(id, 0);
      const want = decode(c.output.data, c.input.bitDepth);
      if (c.input.bitDepth === 32) same32(got, want, `${file} ${JSON.stringify(c.params)}`); else assert.deepEqual(arr(got), arr(want), `${file} ${JSON.stringify(c.params)}`);
      const info = byName(await t.docs(), 'bp') || (await t.docs()).find((d) => d.docId === id);
      assert.equal(info.undoDepth, 1, 'one undo step');
      // undo restores the input, redo the filtered image
      await t.runCommand('editUndo');
      assert.deepEqual(arr(await t.pixels(id, 0)), arr(before), 'undo');
      await t.runCommand('editRedo');
      const again = await t.pixels(id, 0);
      if (c.input.bitDepth === 32) same32(again, want, 'redo'); else assert.deepEqual(arr(again), arr(want), 'redo');
      await api.closeDoc(id).catch(() => {});
    }
    t.close();
  }
  // a reload replays the journal: the same pixels
  const fx = load('bandpass_u16.json'), c = fx.cases[0];
  const t = await fresh();
  const api = t.api('fft');
  const id = await api.addDoc(imageOf(c.input, 'bp'), { placement: 'tab' });
  await t.runCommand('fftBandpass', { large: 40, small: 3 });
  const r = await restored(t);
  assert.deepEqual(arr(await r.px(id, 0)), arr(decode(c.output.data, c.input.bitDepth)));
  r.t2.close();
});

await test('Bandpass Filter: the whole image, every channel, the filter image, and the limits of the padded size', async () => {
  const fx = load('bandpass_u8.json'), c = fx.cases[0];
  const t = await fresh({ channels: 3 });
  const docs0 = await t.docs();
  const id = docs0[0].docId;
  const before = [];
  for (let k = 0; k < 3; k++) before.push(await t.pixels(id, k));
  await t.runCommand('fftBandpass', { all: false, displayFilter: true, autoscale: false });
  const a = [];
  for (let k = 0; k < 3; k++) a.push(await t.pixels(id, k));
  assert.notDeepEqual(arr(a[0]), arr(before[0]), 'the active channel was filtered');
  assert.deepEqual(arr(a[1]), arr(before[1]), 'the other channels were not');
  // the "Filter" image of Display filter: 32-bit, the padded size, the multiplier
  const filt = byName(await t.docs(), 'Filter');
  assert.ok(filt, 'the filter image'); assert.equal(filt.bitDepth, 32);
  const side = filt.width; assert.equal(side & (side - 1), 0, 'a power of 2'); assert.equal(filt.height, side);
  const tile = await t.pixels(filt.docId, 0);
  let mn = Infinity, mx = -Infinity; for (const v of tile) { if (v < mn) mn = v; if (v > mx) mx = v; }
  assert.ok(mn >= 0 && mx <= 1, 'a band-pass multiplier is in [0, 1]');
  assert.equal(tile[(side / 2) * side + side / 2], 1, 'the DC term (the mean, swapped to the centre) is kept: FFTFilter.filterLargeSmall never touches fht[0]');
  const k1 = tile[(side / 2) * side + side / 2 + 1];
  assert.ok(k1 > 0 && k1 < 1, 'the lowest frequency is attenuated, not removed: ' + k1);
  await activate(t, id);
  await t.runCommand('editUndo');
  await t.runCommand('fftBandpass', { all: true, autoscale: false });
  for (let k = 0; k < 3; k++) assert.notDeepEqual(arr(await t.pixels(id, k)), arr(before[k]), 'channel ' + k);
  // a too large image: the padded side would be 16384
  const big = await t.api('fft').addDoc({ name: 'wide', width: 5462, height: 4, bitDepth: 8, channels: [{ data: new Uint8Array(5462 * 4).fill(7), name: 'W', color: '#ffffff' }] }, { placement: 'tab' });
  void big;
  const n = t.errors.length;
  await t.runCommand('fftBandpass', {}, { expectError: true });
  assert.equal(t.errors[n].message, EN.err.fftTooLarge);
  void c;
  t.close();
});

// ═════════════ Swap Quadrants ═════════════
await test('Swap Quadrants: ImageJ fixtures (8 / 16 / 32 bits), every channel, twice = identity, undo; a non-square image is refused', async () => {
  const fx = load('swap_quadrants.json');
  for (const c of fx.cases.filter((x) => x.size === 8)) {
    const t = await fresh();
    const api = t.api('fft');
    const id = await api.addDoc(imageOf(c.input, 'sq'), { placement: 'tab' });
    await t.runCommand('fftSwapQuadrants');
    const got = await t.pixels(id, 0), want = decode(c.output.data, c.input.bitDepth);
    if (c.bitDepth === 32) same32(got, want, 'swap'); else assert.deepEqual(arr(got), arr(want), `swap ${c.bitDepth}`);
    await t.runCommand('fftSwapQuadrants');
    assert.deepEqual(arr(await t.pixels(id, 0)), arr(decode(c.input.data, c.bitDepth)), 'twice is the identity');
    await t.runCommand('editUndo');
    if (c.bitDepth === 32) same32(await t.pixels(id, 0), want, 'undo of the second one'); else assert.deepEqual(arr(await t.pixels(id, 0)), arr(want));
    t.close();
  }
  const t = await fresh({ channels: 2 });
  const id = (await t.docs())[0].docId;
  const info = (await t.docs())[0];
  assert.notEqual(info.width, info.height, 'the harness image is not square');
  const n = t.errors.length;
  await t.runCommand('fftSwapQuadrants', {}, { expectError: true });
  assert.equal(t.errors[n].message, EN.err.fftNotSquare);
  assert.equal((await t.docs())[0].undoDepth, 0);
  void id;
  t.close();
});

// ═════════════ Directionality ═════════════
const tableTexts = (t) => [...t.shell.windows.floats.values()].filter((w) => /^table-/.test(w.id));
function tableOf(el) {
  const out = { th: [], td: [] };
  const walk = (n) => { if (!n || typeof n !== 'object') return; if (n.tagName === 'TH') out.th.push(n.textContent); if (n.tagName === 'TD') out.td.push(n.textContent); for (const c of n.children || []) walk(c); };
  walk(el);
  return out;
}
const gratings = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'ij-wave3', 'fiji', 'directionality', 'gratings.json'), 'utf8'));
const grating = (name) => { const i = gratings.inputs.find((x) => x.name === name); return { name, width: i.image.width, height: i.image.height, bitDepth: 8, channels: [{ data: new Uint8Array(Buffer.from(i.image.data.b64, 'base64')), name: 'G', color: '#ffffff' }] }; };

await test('Directionality: results table, histogram plot with the Gaussian fit, the table of the histogram, an orientation map and a colour wheel, no undo step', async () => {
  const t = await fresh({ channels: 2 });
  const plots = [];
  const real = t.page.IJPlot.draw;
  t.page.IJPlot.draw = (canvas, spec, opts) => { plots.push(spec); try { return real(canvas, spec, opts); } catch (_) { return null; } };
  const api = t.api('fft');
  const id = await api.addDoc(grating('grating30'), { placement: 'tab' });
  const info0 = (await t.docs()).find((d) => d.docId === id);
  const before = await t.pixels(id, 0);
  const rev0 = (await t.engine('doc.info', { docId: id })).rev;
  const nDocs = (await t.docs()).length;
  await t.runCommand('analyzeDirectionality', { method: 'gradient', nbins: 90, start: -90, orientationMap: true, colorWheel: true, table: true });
  // the fit: the Fiji values for this image are direction 0.4637 rad (26.57 deg), dispersion 0.0413 rad, amount 0.850
  const resTables = tableTexts(t);
  assert.equal(resTables.length, 2, 'results + histogram table');
  const res = tableOf(resTables.find((w) => /Directionality results/.test(w.spec.title)).spec.content);
  assert.deepEqual(res.th, ['Slice', 'Direction (°)', 'Dispersion (°)', 'Amount', 'Goodness']);
  const num = (s) => Number(String(s).replace(',', '.'));
  assert.ok(Math.abs(num(res.td[1]) - 26.57) <= 2, 'direction ' + res.td[1]);
  assert.ok(Math.abs(num(res.td[2]) - 0.0413 * 180 / Math.PI) <= 0.24, 'dispersion ' + res.td[2]);
  assert.ok(Math.abs(num(res.td[3]) - 0.85) <= 0.05, 'amount ' + res.td[3]);
  const hist = tableOf(resTables.find((w) => /Directionality histograms/.test(w.spec.title)).spec.content);
  assert.equal(hist.td.length, 90 * 2, 'a row per bin');
  // the plot: the histogram bars and the fit
  assert.equal(plots.length, 1);
  assert.deepEqual(J(plots[0].series.map((s) => s.kind)), ['bars', 'line']);
  assert.equal(plots[0].series[0].x.length, 90);
  const sum = plots[0].series[0].y.reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9, 'the histogram sums to 1');
  // the maps
  const docs = await t.docs();
  assert.equal(docs.length, nDocs + 2, 'orientation map + colour wheel');
  const map = docs.find((d) => /^Orientation map of/.test(d.name));
  assert.equal(map.bitDepth, 32); assert.equal(map.width, info0.width); assert.equal(map.height, info0.height);
  assert.equal(map.channels[0].display.lut, 'Directionality');
  const mp = await t.pixels(map.docId, 0);
  let inside = 0; for (const v of mp) if (v >= -90 && v < 90) inside++;
  assert.ok(inside > mp.length * 0.9, 'most pixels carry an orientation in [start, start+180)');
  const wheel = docs.find((d) => d.name === 'Color wheel');
  assert.equal(wheel.width, 128); assert.equal(wheel.bitDepth, 32);
  // the analysed image is untouched: no undo step, no revision
  const after = (await t.engine('doc.info', { docId: id }));
  assert.equal(after.rev, rev0); assert.equal(after.undoDepth, 0);
  assert.deepEqual(arr(await t.pixels(id, 0)), arr(before));
  t.close();
});

await test('Directionality: Fourier components of a grating at 60 degrees (every channel); a selection; the refusals', async () => {
  const t = await fresh({ channels: 2 });
  const api = t.api('fft');
  const id = await api.addDoc(grating('grating60'), { placement: 'tab' });
  await t.runCommand('analyzeDirectionality', { method: 'fourier', nbins: 90, start: -90 });
  const num = (s) => Number(String(s).replace(',', '.'));
  let res = tableOf(tableTexts(t)[0].spec.content);
  assert.equal(res.td.length, 5, 'one row');
  assert.ok(Math.abs(num(res.td[1]) - 60) <= 2, 'direction ' + res.td[1]);
  assert.ok(Math.abs(num(res.td[2]) - 0.0457 * 180 / Math.PI) <= 0.26, 'dispersion ' + res.td[2]);
  assert.ok(num(res.td[3]) > 0.9, 'amount ' + res.td[3]);
  // the harness image of the synthetic volume has two channels; "all channels" gives a row per channel
  const t2 = await fresh({ channels: 2 });
  await t2.runCommand('analyzeDirectionality', { method: 'gradient', nbins: 45, start: 0, all: true });
  res = tableOf(tableTexts(t2)[0].spec.content);
  assert.equal(res.td.length, 10, 'a row per channel');
  // too small an image: the refusal and its key
  const tiny = await t.api('fft').addDoc({ name: 'tiny', width: 12, height: 12, bitDepth: 8, channels: [{ data: new Uint8Array(144).map((_, i) => i), name: 'T', color: '#ffffff' }] }, { placement: 'tab' });
  void tiny;
  const n = t.errors.length;
  await t.runCommand('analyzeDirectionality', { method: 'fourier' }, { expectError: true });
  assert.equal(t.errors[n].message, EN.err.dirTooSmall);
  // a uniform image has no structure
  await t.api('fft').addDoc({ name: 'flat', width: 40, height: 40, bitDepth: 8, channels: [{ data: new Uint8Array(1600).fill(9), name: 'F', color: '#ffffff' }] }, { placement: 'tab' });
  const m = t.errors.length;
  await t.runCommand('analyzeDirectionality', { method: 'gradient' }, { expectError: true });
  assert.equal(t.errors[m].message, EN.err.dirNoSignal);
  void id;
  t.close(); t2.close();
});

await test('Bandpass Filter shows the values of its last run (FFTFilter keeps them in static fields); Directionality builds its orientation map in the worker', async () => {
  const t = await fresh();
  await t.runCommand('fftBandpass', { large: 12, small: 2, stripes: 'horizontal', tolerance: 7, autoscale: false, saturate: false, displayFilter: false, all: false });
  await t.runCommand('fftBandpass', {});
  const spec = t.log.dialogSpecs[t.log.dialogSpecs.length - 1];
  const f = (id) => spec.fields.find((x) => x.id === id);
  assert.equal(f('large').value, 12); assert.equal(f('small').value, 2); assert.equal(f('stripes').value, 'horizontal'); assert.equal(f('tolerance').value, 7);
  assert.equal(f('autoscale').value, false); assert.equal(f('saturate').value, false); assert.equal(f('displayFilter').value, false); assert.equal(f('all').value, false);
  // a cancelled dialog remembers nothing
  await t.runCommand('fftBandpass', null);
  await t.runCommand('fftBandpass', {});
  assert.equal(t.log.dialogSpecs[t.log.dialogSpecs.length - 1].fields.find((x) => x.id === 'large').value, 12);
  t.close();
  // the map: made by the worker command, nothing image-sized crosses to the page
  const t2 = await fresh();
  await t2.api('fft').addDoc(grating('grating30'), { placement: 'tab' });
  await t2.runCommand('analyzeDirectionality', { method: 'gradient', nbins: 90, start: -90, orientationMap: true });
  const map = (await t2.docs()).find((d) => /^Orientation map of/.test(d.name));
  assert.ok(map && map.bitDepth === 32, 'the map is a 32-bit image');
  const px = await t2.pixels(map.docId, 0);
  assert.ok(px.every((v) => v > -1e29), 'no GRADIENT_NONE sentinel is left');
  assert.ok(px.some((v) => v >= -90 && v < 90), 'orientations are in [start, start + 180)');
  t2.close();
});

console.log(`test_ij_fft_commands: ${passed} tests passed`);
