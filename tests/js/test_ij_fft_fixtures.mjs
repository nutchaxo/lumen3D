// P-fft — the golden fixtures recorded with real ImageJ 1.54p (tests/fixtures/ij-wave3/fft/): FHT forward (padding, 8-bit
// power spectrum, raw power spectrum), Inverse FFT with no / pass / filter masks, Bandpass Filter (every option, odd sizes,
// 8 / 16 / 32 bits, a selection), the Bandpass multiplier itself and Swap Quadrants, compared with the registry operations
// of ij-proc-fft.js.
//
// Tolerance: bit-identical for every integer output and for the 8-bit / 16-bit results of the filters. 32-bit outputs are
// compared bit for bit as well (the port rounds every Java float operation); the test states how many values differ in the
// last bit if any (`MAX_ULP`), which the code of ij-proc-fft.js is expected to keep at 0.
//
// Run: node tests/js/test_ij_fft_fixtures.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT } from './harness.mjs';

const DIR = path.join(ROOT, 'js', 'modules', 'studio', 'advanced-studio');
const FIX = path.join(ROOT, 'tests', 'fixtures', 'ij-wave3', 'fft');
const ctx = vm.createContext({ console, setTimeout, clearTimeout });
for (const f of ['ij-core.js', 'ij-proc-fft.js']) vm.runInContext(fs.readFileSync(path.join(DIR, f), 'utf8'), ctx, { filename: f });
const R = ctx.IJOpRegistry;
const P = ctx.IJFftPkg;
for (const n of ['fft', 'inverseFft', 'bandpass', 'bandpassFilter', 'swapQuadrants', 'directionality']) assert.ok(R.get(n), n + ' is registered');

function decodeData(d, bitDepth) {
  if (Array.isArray(d)) {
    const a = Float64Array.from(d, (v) => (v === null ? NaN : v));
    return bitDepth === 8 ? Uint8Array.from(a) : bitDepth === 16 ? Uint16Array.from(a) : Float32Array.from(a);
  }
  const b = Buffer.from(d.b64, 'base64');
  const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  return d.dtype === 'u8' ? new Uint8Array(ab) : d.dtype === 'u16' ? new Uint16Array(ab) : new Float32Array(ab);
}
const img = (o) => ({ width: o.width, height: o.height, bitDepth: o.bitDepth, data: decodeData(o.data, o.bitDepth) });
function dataRange(a) {
  let mn = Infinity, mx = -Infinity;
  for (const v of a) { if (v - v !== 0) continue; if (v < mn) mn = v; if (v > mx) mx = v; }
  return mn > mx ? { min: 0, max: 0 } : { min: mn, max: mx };
}
function viewOf(id, name, im, provenance) {
  const r = im.bitDepth === 8 ? { min: 0, max: 255 } : dataRange(im.data);
  return {
    id, name, width: im.width, height: im.height, bitDepth: im.bitDepth, calibration: { pixelWidth: 1, pixelHeight: 1, unit: 'px' }, provenance: provenance || {}, active: 0,
    channels: [{ data: im.data, name: 'c1', color: '#ffffff', display: { min: r.min, max: r.max, lut: 'Grays', invert: false } }]
  };
}
const io = (views, over) => Object.assign({
  docIds: views.map((v) => v.id), channel: 0, region: null,
  tick: async () => {}, check() {}, reserve() {}, release() {}, dep: (n) => ctx[n],
  roiMask: (roi) => ({ x: roi.x, y: roi.y, w: roi.w, h: roi.h, data: new Uint8Array(roi.w * roi.h).fill(1) }),
  readDoc: (id) => { const v = views.find((x) => x.id === id); if (!v) throw Object.assign(new Error('x'), { code: 'IJ_NO_DOC' }); return v; }
}, over || {});

let maxUlp = 0;
function same(got, want, what, bitDepth) {
  assert.equal(got.length, want.length, what + ': length');
  let bad = 0, first = -1;
  for (let i = 0; i < got.length; i++) {
    let ok = bitDepth === 32 ? Object.is(got[i], want[i]) : got[i] === want[i];
    if (!ok && bitDepth === 32 && got[i] === 0 && want[i] === 0) ok = true;
    if (!ok) { bad++; if (first < 0) first = i; }
  }
  assert.equal(bad, 0, `${what}: ${bad} of ${got.length} values differ (first at ${first}: got ${got[first]}, want ${want[first]})`);
}
const runPixel = async (name, im, params, rect, channelPlane) => {
  const spec = R.get(name);
  const view = viewOf('d', 'src', im);
  const prep = spec.prepare(view, 0, params, { scale: 1, check() {}, tick: async () => {}, range: () => dataRange(im.data), dep: (n) => ctx[n] });
  return prep.region ? prep.region({ width: im.width, height: im.height, bitDepth: im.bitDepth, data: im.data }, rect) : prep.fn(im);
};

let passed = 0;
const files = fs.readdirSync(FIX).filter((f) => f.endsWith('.json')).sort();
const load = (f) => JSON.parse(fs.readFileSync(path.join(FIX, f), 'utf8'));

// ---- forward
for (const bd of ['u8', 'u16', 'f32']) {
  const j = load(`forward_${bd}.json`);
  assert.equal(j.op, 'fft');
  for (const c of j.cases) {
    const input = img(c.input), tag = `forward ${bd} ${c.size[0]}x${c.size[1]}`;
    const res = await R.get('fft').run(viewOf('s', 'src', input), { fftWindow: true, rawPs: true }, null, io([viewOf('s', 'src', input)]));
    assert.equal(res.length, 2, tag + ': PS of + FFT of');
    const [ps, fft] = res;
    assert.equal(ps.name, 'PS of src'); assert.equal(fft.name, 'FFT of src');
    assert.equal(fft.width, c.padded, tag + ': padded side'); assert.equal(fft.bitDepth, 8); assert.equal(ps.bitDepth, 32);
    same(fft.channels[0].data, decodeData(c.powerSpectrum8.data, 8), tag + ' power spectrum 8-bit', 8);
    same(ps.channels[0].data, decodeData(c.rawPowerSpectrumSwapped.data, 32), tag + ' raw power spectrum (swapped)', 32);
    assert.equal(fft.provenance.fft.padded, c.padded);
    // the transform itself (FHT)
    const f = await P.forwardFht(input.data, input.width, input.height, input.bitDepth);
    same(f.fht, decodeData(c.fht.data, 32), tag + ' FHT', 32);
    assert.equal(P.meanOf((await P.powerSpectrum(f.fht, f.side)).ps8, 8), c.powerSpectrumMean, tag + ' powerSpectrumMean');
    passed++;
  }
}

// ---- forward of a selection: crop to the bounding box first
{
  const j = load('forward_roi_crop.json');
  const input = img(j.input);
  const view = viewOf('s', 'src', input);
  const res = await R.get('fft').run(view, { fftWindow: true }, { type: 'rect', x: j.roi.x, y: j.roi.y, w: j.roi.w, h: j.roi.h }, io([view]));
  assert.equal(res.length, 1);
  assert.equal(res[0].width, j.padded);
  assert.deepEqual({ ...res[0].provenance.fft.crop }, { x: j.roi.x, y: j.roi.y, w: j.roi.w, h: j.roi.h });
  same(res[0].channels[0].data, decodeData(j.powerSpectrum8.data, 8), 'selection: power spectrum', 8);
  const f = await P.forwardFht(await (async () => {
    const o = new Uint8Array(j.roi.w * j.roi.h);
    for (let y = 0; y < j.roi.h; y++) o.set(input.data.subarray((j.roi.y + y) * input.width + j.roi.x, (j.roi.y + y) * input.width + j.roi.x + j.roi.w), y * j.roi.w);
    return o;
  })(), j.roi.w, j.roi.h, 8);
  same(f.fht, decodeData(j.fht.data, 32), 'selection: FHT', 32);
  passed++;
}

// ---- inverse
for (const bd of ['u8', 'u16', 'f32']) {
  const j = load(`inverse_${bd}.json`);
  for (const c of j.cases) {
    const input = img(c.input);
    const tag = `inverse ${bd} ${c.size[0]}x${c.size[1]} mask ${c.mask}`;
    const src = viewOf('s', 'src', input);
    const fftDoc = (await R.get('fft').run(src, { fftWindow: true }, null, io([src])))[0];
    // the edited power spectrum of the fixture replaces the one the transform gave
    const ps = img(c.psEdited);
    const psView = viewOf('p', fftDoc.name, ps, fftDoc.provenance);
    const out = (await R.get('inverseFft').run(psView, {}, null, io([psView, src])))[0];
    assert.equal(out.name, 'Inverse FFT of src');
    assert.equal(out.bitDepth, input.bitDepth);
    assert.equal(out.width, input.width); assert.equal(out.height, input.height);
    same(out.channels[0].data, decodeData(c.outputSourceDepth.data, input.bitDepth), tag, input.bitDepth);
    assert.equal(out.provenance.fftInverse.mask, c.mask, tag + ': mask mode');
    passed++;
  }
}

// ---- swap quadrants
{
  const j = load('swap_quadrants.json');
  for (const c of j.cases) {
    const input = img(c.input);
    const out = await runPixel('swapQuadrants', input, {}, { x: 0, y: 0, w: input.width, h: input.height });
    same(out.data || out, decodeData(c.output.data, c.bitDepth), `swap ${c.bitDepth}-bit ${c.size}`, c.bitDepth);
    passed++;
  }
}

// ---- the bandpass multiplier
{
  const j = load('bandpass_filter_arrays.json');
  const STR = { None: 0, Horizontal: 1, Vertical: 2 };
  for (const c of j.cases) {
    const n = c.n;
    const f = new Float32Array(n * n).fill(1);
    await P.filterLargeSmall(f, n, 2.0 * c.params.large / n, 2.0 * c.params.small / n, STR[c.params.stripes], c.params.sharpness, null, null);
    same(f, decodeData(c.filter.data, 32), `filterLargeSmall n=${n} ${JSON.stringify(c.params)}`, 32);
    // the same through the second output buffer
    const g = new Float32Array(n * n).fill(1), h = new Float32Array(n * n).fill(1);
    await P.filterLargeSmall(g, n, 2.0 * c.params.large / n, 2.0 * c.params.small / n, STR[c.params.stripes], c.params.sharpness, h, null);
    same(h, f, 'filter array of the Display filter', 32);
    passed++;
  }
}

// ---- bandpass
for (const bd of ['u8', 'u16', 'f32']) {
  const j = load(`bandpass_${bd}.json`);
  const STR = { None: 0, Horizontal: 1, Vertical: 2 };
  for (const c of j.cases) {
    const input = img(c.input);
    const p = { large: c.params.large, small: c.params.small, stripes: STR[c.params.stripes], tolerance: c.params.tolerance, autoscale: c.params.autoscale, saturate: c.params.saturate };
    const rect = c.roi ? { x: c.roi.x, y: c.roi.y, w: c.roi.w, h: c.roi.h } : { x: 0, y: 0, w: input.width, h: input.height };
    const got = await runPixel('bandpass', input, p, rect);
    // the engine copies the rectangle into the channel
    const out = input.data.slice();
    for (let y = 0; y < rect.h; y++) for (let x = 0; x < rect.w; x++) out[(rect.y + y) * input.width + rect.x + x] = got[y * rect.w + x];
    same(out, decodeData(c.output.data, input.bitDepth), `bandpass ${bd} ${c.size} ${JSON.stringify(c.params)}${c.roi ? ' roi' : ''}`, input.bitDepth);
    passed++;
  }
}

// ---- the streaming mean of the power spectrum (the ImageJ notice of Inverse FFT) equals the mean of the 8-bit spectrum
for (const bd of ['u8', 'u16', 'f32']) {
  for (const c of load(`forward_${bd}.json`).cases) {
    const input = img(c.input);
    const f = await P.forwardFht(input.data, input.width, input.height, input.bitDepth);
    assert.equal(P.powerSpectrumMean(f.fht, f.side), c.powerSpectrumMean, `powerSpectrumMean ${bd} ${c.size}`);
    passed++;
  }
}

// ---- Swap Quadrants on odd sizes: the last row and column of an odd image stay, the four windows (size = width/2) trade places as
// FFT.swapQuadrants crops and inserts them (re-done here with crop / insert on plain arrays)
{
  const crop = (a, w, x, y, cw, ch) => { const o = new Int32Array(cw * ch); for (let j = 0; j < ch; j++) for (let i = 0; i < cw; i++) o[j * cw + i] = a[(y + j) * w + x + i]; return o; };
  const insert = (a, w, t, tw, th, x, y) => { for (let j = 0; j < th; j++) for (let i = 0; i < tw; i++) a[(y + j) * w + x + i] = t[j * tw + i]; };
  for (const n of [5, 7, 9, 12, 33]) {
    const a = Int32Array.from({ length: n * n }, (_, i) => i + 1);
    const want = a.slice(), size = n >> 1;
    const t1 = crop(want, n, size, 0, size, size), t2 = crop(want, n, 0, size, size, size);
    insert(want, n, t1, size, size, 0, size); insert(want, n, t2, size, size, size, 0);
    const u1 = crop(want, n, 0, 0, size, size), u2 = crop(want, n, size, size, size, size);
    insert(want, n, u1, size, size, size, size); insert(want, n, u2, size, size, 0, 0);
    const got = P.swapQuadrants(a, n, n, false);
    same(got, want, `swapQuadrants ${n}x${n}`, 32);
    same(P.swapQuadrants(got, n, n, false), a, `swapQuadrants twice ${n}x${n}`, 32);
    if (n % 2) for (let k = 0; k < n; k++) { assert.equal(got[(n - 1) * n + k], a[(n - 1) * n + k]); assert.equal(got[k * n + (n - 1)], a[k * n + (n - 1)]); }
    const inPlace = a.slice(); P.swapQuadrants(inPlace, n, n, true);
    same(inPlace, want, `swapQuadrants in place ${n}x${n}`, 32);
    passed++;
  }
}

// ---- operation contracts: no write into the input, whole-image passes (the engine cannot split them into bands, so the band
// size cannot matter), validation, cancellation
{
  const im = img(load('forward_u8.json').cases[1].input);
  const before = im.data.slice();
  const spec = R.get('bandpass'), swap = R.get('swapQuadrants');
  const ctxOf = (check) => ({ scale: 1, check, tick: async () => {}, range: () => dataRange(im.data), dep: (n) => ctx[n] });
  const P0 = { large: 40, small: 3, stripes: 0, tolerance: 5, autoscale: true, saturate: true };
  assert.equal(spec.prepare(viewOf('d', 'src', im), 0, P0, ctxOf(() => {})).whole, true, 'Bandpass takes the image in one band');
  assert.equal(swap.prepare(viewOf('d', 'src', im), 0, {}, ctxOf(() => {})).whole, true, 'Swap Quadrants takes the image in one band');
  assert.equal(spec.roi, 'bounds', 'the selection is a rectangle (FFTFilter is not a masking filter)');
  assert.equal(swap.roi, 'ignore', 'Swap Quadrants ignores the selection');
  assert.equal(spec.preview, false); assert.equal(R.get('fft').preview, false);
  // validation
  for (const bad of [{ ...P0, large: -1 }, { ...P0, small: 'x' }, { ...P0, stripes: 3 }, { ...P0, tolerance: 101 }, { ...P0, autoscale: 1 }]) assert.throws(() => spec.validate(bad, {}), (e) => e.code === 'IJ_BAD_ARGS');
  spec.validate(P0, {});
  assert.throws(() => R.get('fft').validate({ fftWindow: false, rawPs: false }, {}), (e) => e.code === 'IJ_FFT_NO_OUTPUT');
  R.get('fft').validate({ fftWindow: false, rawPs: true }, {});
  assert.throws(() => swap.validate({}, { width: 5, height: 6 }), (e) => e.code === 'IJ_FFT_NOT_SQUARE');
  swap.validate({}, { width: 6, height: 6 });
  // a check() that throws (Cancel) stops each operation, nothing is produced and the input is untouched
  const canceller = () => { let k = 0; return () => { if (++k > 3) throw Object.assign(new Error('c'), { code: 'IJ_CANCELLED' }); }; };
  const bigIm = { width: 600, height: 500, bitDepth: 8, data: Uint8Array.from({ length: 300000 }, (_, i) => (i * 37 + (i >> 5)) & 255) };   // padded side 1024
  const bigBefore = bigIm.data.slice();
  const prep = spec.prepare(viewOf('d', 'src', bigIm), 0, P0, ctxOf(canceller()));
  await assert.rejects(prep.region({ width: 600, height: 500, bitDepth: 8, data: bigIm.data }, { x: 0, y: 0, w: 600, h: 500 }), (e) => e.code === 'IJ_CANCELLED');
  const sv = viewOf('s', 'src', bigIm);
  await assert.rejects(R.get('fft').run(sv, { rawPs: true }, null, io([sv], { check: canceller() })), (e) => e.code === 'IJ_CANCELLED');
  assert.deepEqual(Array.from(bigIm.data), Array.from(bigBefore));
  const wv = viewOf('w', 'wide', { width: 2000, height: 10, bitDepth: 8, data: new Uint8Array(20000) });   // padded side 4096: many rows
  await assert.rejects(R.get('bandpassFilter').run(wv, P0, null, io([wv], { check: canceller() })), (e) => e.code === 'IJ_CANCELLED');
  assert.deepEqual(Array.from(im.data), Array.from(before), 'the input array was never written');
  passed++;
}

// ---- Inverse FFT: what it refuses at the operation level
{
  const c = load('inverse_u8.json').cases[1];
  const input = img(c.input);
  const src = viewOf('s', 'src', input);
  const fftDoc = (await R.get('fft').run(src, {}, null, io([src])))[0];
  const ps = viewOf('p', fftDoc.name, img(c.psEdited), fftDoc.provenance);
  const code = async (f) => { try { await f(); } catch (e) { return e.code; } return null; };
  assert.equal(await code(() => R.get('inverseFft').run(ps, {}, null, io([ps]))), 'IJ_FFT_SOURCE_CHANGED', 'no source named');
  assert.equal(await code(() => R.get('inverseFft').run(ps, {}, null, io([ps, viewOf('zzz', 'other', input)]))), 'IJ_FFT_SOURCE_CHANGED', 'another document than the one the spectrum came from');
  const changed = viewOf('s', 'src', { ...input, data: input.data.map((v) => 255 - v) });
  assert.equal(await code(() => R.get('inverseFft').run(ps, {}, null, io([ps, changed]))), 'IJ_FFT_SOURCE_CHANGED', 'pixels changed');
  const other = viewOf('s', 'src', { ...input, width: 31, height: 32, data: input.data.slice(0, 31 * 32) });
  assert.equal(await code(() => R.get('inverseFft').run(ps, {}, null, io([ps, other]))), 'IJ_FFT_SOURCE_CHANGED', 'size changed');
  const plain = viewOf('x', 'plain', input);
  assert.equal(await code(() => R.get('inverseFft').run(plain, {}, null, io([plain, src]))), 'IJ_FFT_NOT_FD', 'not a spectrum');
  const raw = (await R.get('fft').run(src, { rawPs: true, fftWindow: false }, null, io([src])))[0];
  assert.equal(raw.name, 'PS of src');
  const rawView = viewOf('r', raw.name, { width: raw.width, height: raw.height, bitDepth: 32, data: raw.channels[0].data }, raw.provenance);
  assert.equal(await code(() => R.get('inverseFft').run(rawView, {}, null, io([rawView, src]))), 'IJ_FFT_NOT_FD', 'the raw power spectrum has no phase: it cannot be inverted');
  // a spectrum edited to another size is not a mask: nothing is filtered (FFT.doMasking returns)
  const small = viewOf('p', fftDoc.name, { width: 16, height: 16, bitDepth: 8, data: new Uint8Array(256).fill(255) }, fftDoc.provenance);
  const back = (await R.get('inverseFft').run(small, {}, null, io([small, src])))[0];
  assert.equal(back.provenance.fftInverse.mask, 'skip');
  same(back.channels[0].data, input.data, 'unmasked inverse = the source', 8);
  passed++;
}

// ---- the limits
{
  const big = { width: 5462, height: 8, bitDepth: 8, data: new Uint8Array(5462 * 8) };
  await assert.rejects(runPixel('bandpass', big, { large: 40, small: 3, stripes: 0, tolerance: 5, autoscale: true, saturate: true }, { x: 0, y: 0, w: 5462, h: 8 }), (e) => e.code === 'IJ_FFT_TOO_LARGE');
  assert.equal(P.bandpassSide(5461, 8), 8192, 'the largest side Bandpass accepts');
  assert.equal(P.bandpassSide(5462, 8), 16384);
  const wide = { width: 8193, height: 4, bitDepth: 8, data: new Uint8Array(8193 * 4) };
  const v = viewOf('w', 'wide', wide);
  await assert.rejects(R.get('fft').run(v, {}, null, io([v])), (e) => e.code === 'IJ_FFT_TOO_LARGE');
  // a selection brings a too large image back under the limit: the crop is what is padded
  const res = await R.get('fft').run(v, { fftWindow: true }, { type: 'rect', x: 0, y: 0, w: 100, h: 4 }, io([v]));
  assert.equal(res[0].width, 128);
  // memory: the scratch each operation declares covers its arrays (padded side 8192: 9 planes of the padded size for FFT)
  const info = { width: 6000, height: 6000, bitDepth: 16, channels: 3, region: null, roi: null, docs: [] };
  assert.equal(R.get('fft').scratchBytes(info, {}), 8192 * 8192 * 9 + 6000 * 6000 * 2);
  assert.equal(R.get('bandpass').scratchBytes({ ...info, region: { w: 5461, h: 5461 } }), 8192 * 8192 * 8 + 5461 * 5461 * 4);
  assert.equal(R.get('bandpass').scratchBytes({ ...info, region: { w: 6000, h: 6000 } }), 0, 'refused by region() with IJ_FFT_TOO_LARGE, not by the budget');
  passed++;
}

console.log(`test_ij_fft_fixtures: ${passed} groups passed`);
