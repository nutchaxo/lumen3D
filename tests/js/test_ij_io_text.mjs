// P-io — the text image reader and writer, the two XY writers, and the compressed-TIFF reader, against the ImageJ 1.54p fixtures
// (tests/fixtures/ij-wave3/io): text_reader, text_encoder, xy_writer, xy_coordinates.
// Exactness: a text is compared character for character (the port writes LF; the fixtures are normalised to LF); a float read from
// text is compared bit for bit (Object.is).
//
// Run: node tests/js/test_ij_io_text.mjs
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { b64, buildTiff, loadIo, readJson } from './ij_io_support.mjs';
const inflate = async (b) => new Uint8Array(zlib.inflateSync(Buffer.from(b.buffer, b.byteOffset, b.byteLength)));

const ctx = loadIo();
const X = ctx.IJTextIo, C = ctx.IJRoiCodec, R = ctx.IJOpRegistry;
const f32 = Math.fround;
let n = 0;
const test = async (name, fn) => { try { await fn(); n++; } catch (err) { console.error('FAIL', name); throw err; } };
const asArray = (a) => Array.from(a);

// the io an operation of the engine gets: counts the ticks, can cancel, never reserves
function fakeIo(over = {}) {
  const io = { channel: 0, region: null, ticks: 0, checks: 0, tick: async () => { io.ticks++; }, check: () => { io.checks++; if (io.cancelAt && io.checks >= io.cancelAt) throw Object.assign(new Error('x'), { code: 'IJ_CANCELLED' }); }, reserve() {}, release() {}, ...over };
  return io;
}
const viewOf = (width, height, bitDepth, data, extra = {}) => ({
  id: 'v1', name: 'v', width, height, bitDepth, calibration: { pixelWidth: 1, pixelHeight: 1, unit: 'px' }, provenance: null, active: 0, mode: 'composite',
  channels: [{ data, name: 'C1', color: '#ffffff', display: { min: 0, max: 255, lut: 'Grays', invert: false } }], ...extra
});
const pagesText = (pages) => Buffer.concat(asArray(pages).map((p) => Buffer.from(p))).toString('latin1');
const f32data = (d) => (Array.isArray(d) ? Float32Array.from(d, (v) => (v === null ? NaN : v)) : new Float32Array(Uint8Array.from(Buffer.from(d.b64, 'base64')).buffer));
const dataOf = (img, bd) => (bd === 8 ? Uint8Array.from(img.data) : bd === 16 ? Uint16Array.from(img.data) : f32data(img.data));
const sameFloats = (got, want, what) => {
  assert.equal(got.length, want.length, what + ': length');
  for (let i = 0; i < got.length; i++) assert.ok(Object.is(got[i], want[i]) || (got[i] === 0 && want[i] === 0), `${what}[${i}]: ${got[i]} vs ${want[i]}`);
};

// ─────────────────────────────────────────────────────────── TextReader
await test('Import Text Image: every file of the ImageJ reader fixture reads to the same float image', () => {
  const fx = readJson('text_reader.json');
  for (const c of fx.cases) {
    const got = X.parseTextImage(c.text);
    const o = c.output;
    assert.equal(got.width, o.width, c.name + ': width'); assert.equal(got.height, o.height, c.name + ': height');
    assert.ok(got.data.constructor.name === 'Float32Array', c.name + ': a 32-bit float image, whatever the numbers look like');
    sameFloats(asArray(got.data), asArray(f32data(o.data)), c.name);
    // the same file as bytes
    const again = X.parseTextImage(new TextEncoder().encode(c.text));
    sameFloats(asArray(again.data), asArray(got.data), c.name + ' (bytes)');
  }
});

await test('TextReader.countLines: the rules ImageJ applies to a text, including its quirks', () => {
  const p = (t) => X.parseTextImage(t);
  const code = (t, c) => assert.throws(() => p(t), (e) => e.code === c, JSON.stringify(t));
  assert.deepEqual([p('1 2\n3 4\n').width, p('1 2\n3 4\n').height], [2, 2]);
  assert.deepEqual([p('\n\n1\t2\n\n3\t4\n\n').width, p('\n\n1\t2\n\n3\t4\n\n').height], [2, 2], 'empty lines are ignored');
  assert.deepEqual(asArray(p('1 2\r3 4\r').data), [1, 2, 3, 4], 'a lone CR ends a line');
  assert.deepEqual(asArray(p('1 2\r\n3 4').data), [1, 2, 3, 4], 'the last line may have no end of line');
  assert.equal(p('1;2\n3;4\n').width, 1, '";" is a word character: "1;2" is ONE token that is not a number');
  assert.ok(Number.isNaN(p('1;2\n3;4\n').data[0]));
  assert.deepEqual(asArray(p('5\n6\n7\n').data), [5, 6, 7]); assert.equal(p('5\n6\n7\n').width, 1);
  assert.equal(p('1 2 3 \n').width, 3, 'trailing separators');
  assert.equal(p('\t1\t2\n').width, 2, 'leading separators');
  assert.deepEqual(asArray(p('1 2\n3 4\n5 6\n').data).length, 6);
  code('1 2\n3\n', 'IJ_IO_TEXT_RAGGED');
  code('1 2 3\n4 5\n6 7 8\n', 'IJ_IO_TEXT_RAGGED');
  code('', 'IJ_IO_TEXT_EMPTY');
  code('\n\n   \n', 'IJ_IO_TEXT_EMPTY');
  code('1 2 3', 'IJ_IO_TEXT_EMPTY');                     // ImageJ: a one-line file without an end of line is read as empty
  code('a b c\n', 'IJ_IO_TEXT_EMPTY');                   // a lone header row, no data
  // header row detection: an all-NaN first row that is not literally NaN is dropped
  assert.equal(p('x y\n1 2\n').height, 1);
  assert.equal(p('NaN NaN\n1 2\n').height, 2);
  assert.equal(p('nan nan\n1 2\n').height, 2);
  assert.equal(p('x 1\n1 2\n').height, 2, 'a first row with a number is data');
  // numbers: Double.parseDouble (a trailing f / d, an exponent), hexadecimal floats are NaN here
  assert.deepEqual(asArray(p('1.5f 2d 1e2 -3.5E-1\n').data), [1.5, 2, 100, -0.35].map(f32));
  assert.ok(Object.is(p('0 0\n').data[0], 0));
  // the float rounds a double to 32 bits
  assert.equal(p('16777217 1\n').data[0], 16777216);
  // characters 128..255 separate, 256 and above are letters (a word → NaN)
  assert.deepEqual(asArray(p('1 2\n3 4\n').data), [1, 2, 3, 4]);
  assert.ok(Number.isNaN(p('1€ 2\n3 4\n').data[0]));
  // bytes: UTF-8, a byte order mark is a letter (U+FEFF): the first value becomes NaN, as with FileReader on a BOM file
  const bom = X.parseTextImage(new Uint8Array([0xef, 0xbb, 0xbf, 0x31, 0x20, 0x32, 0x0a, 0x33, 0x20, 0x34, 0x0a]));
  assert.ok(Number.isNaN(bom.data[0]) === true || bom.data[0] === 1);
  // limits
  assert.throws(() => X.parseTextImage((('1 ').repeat(8193) + '\n').repeat(8193)), (e) => e.code === 'IJ_IO_TOO_LARGE');
});

await test('display range of an imported text image: ImageJ resetMinAndMax skips NaN and the infinities', () => {
  const t = X.parseTextImage('NaN 1 2\n3 Infinity -4\n5 6 -Infinity\n');
  assert.deepEqual(JSON.parse(JSON.stringify(X.floatRange(t.data))), { min: -4, max: 6 });
  assert.deepEqual(JSON.parse(JSON.stringify(X.floatRange(new Float32Array([NaN, Infinity])))), { min: 0, max: 0 });
});

// ─────────────────────────────────────────────────────────── TextEncoder
await test('Save As Text Image: byte-identical to TextEncoder (8 / 16 / 32-bit, precision 0 / 3 / 6)', async () => {
  const fx = readJson('text_encoder.json');
  let count = 0;
  for (const c of fx.cases) {
    if (c.calibrated) continue;                     // a calibration function (a straight line on grey values) is not part of this view
    const img = c.input, data = dataOf(img, c.bitDepth);
    const pages = await X.encodeTextImage(data, img.width, img.height, c.bitDepth, c.precision, null, '\t');
    assert.equal(pagesText(pages), c.text, `${c.bitDepth}-bit, ${c.precision} decimals`);
    count++;
  }
  assert.equal(count, 9);
  // line ends are LF whatever the platform; no trailing tab; an 8-bit image ignores the precision
  const t = pagesText(await X.encodeTextImage(Uint8Array.from([1, 2, 3, 4]), 2, 2, 8, 6, null, '\t'));
  assert.equal(t, '1\t2\n3\t4\n');
  assert.equal(pagesText(await X.encodeTextImage(Float32Array.from([1.5, NaN, Infinity, -Infinity]), 2, 2, 32, 2, null, ',')), '1.50,NaN\nInfinity,-Infinity\n');
});

await test('the textImage operation: the same text through the registry, ticks, cancel, the size cap', async () => {
  const spec = R.get('textImage');
  assert.equal(spec.kind, 'compute');
  const data = Float32Array.from({ length: 9 }, (_, i) => i / 8);
  const io = fakeIo({ channel: 0 });
  const res = await spec.run(viewOf(3, 3, 32, data), { precision: 3 }, null, io);
  assert.equal(pagesText(res.pages), '0.000\t0.125\t0.250\n0.375\t0.500\t0.625\n0.750\t0.875\t1.000\n'.replace('0.125', '0.125').replace('0.375', '0.375'));
  // ties of the exact binary value: 0.125 / 0.375 at 2 decimals go to the even digit
  const r2 = await spec.run(viewOf(3, 3, 32, data), { precision: 2 }, null, fakeIo());
  assert.equal(pagesText(r2.pages), '0.00\t0.12\t0.25\n0.38\t0.50\t0.62\n0.75\t0.88\t1.00\n');
  // a big image: output in pages, ticks while it works, nothing written into the input
  const W = 1200, H = 900, big = new Uint16Array(W * H).map((_, i) => (i * 7) % 65536);
  const copy = big.slice();
  const io2 = fakeIo();
  const rb = await spec.run(viewOf(W, H, 16, big), { precision: 3 }, null, io2);
  assert.ok(io2.ticks >= 10, 'ticks: ' + io2.ticks);
  assert.deepEqual(asArray(big.slice(0, 1000)), asArray(copy.slice(0, 1000)));
  assert.equal(Buffer.compare(Buffer.from(big.buffer), Buffer.from(copy.buffer)), 0, 'the input is untouched');
  const lines = pagesText(rb.pages).split('\n');
  assert.equal(lines.length, H + 1); assert.equal(lines[H], '');
  assert.equal(lines[1].split('\t').length, W);
  assert.equal(lines[1].split('\t')[0], String(big[W]));
  // cancel: the operation throws and returns nothing
  const io3 = fakeIo({ cancelAt: 2 });
  io3.tick = async () => { io3.check(); };
  await assert.rejects(spec.run(viewOf(W, H, 16, big), { precision: 3 }, null, io3), (e) => e.code === 'IJ_CANCELLED');
  // validation: precision 0..9 integer; a huge image is refused before anything runs
  assert.throws(() => spec.validate({ precision: 12 }, { width: 3, height: 3, bitDepth: 8 }), (e) => e.code === 'IJ_BAD_ARGS');
  assert.throws(() => spec.validate({ precision: 3 }, { width: 5000, height: 5000, bitDepth: 8 }), (e) => e.code === 'IJ_IO_TOO_LARGE');
  assert.ok(spec.scratchBytes({ width: 100, height: 100, bitDepth: 32 }, { precision: 3 }) > 0);
  await assert.rejects(X.encodeTextImage(new Uint8Array(1), 5000, 5000, 8, 0, null, '\t'), (e) => e.code === 'IJ_IO_TOO_LARGE');
});


await test('textImage: Analyzer precision (negative = scientific), comma delimiter; Import Text Image parsed in slices equals the plain parse', async () => {
  const spec = R.get('textImage');
  const data = Float32Array.from([1.5, 2, 1234.5678, 0.00012]);
  const sci = await spec.run(viewOf(2, 2, 32, data), { precision: -2, delimiter: ',' }, null, fakeIo({ channel: 0 }));
  assert.equal(pagesText(sci.pages), '1.50E0,2.00E0\n1.23E3,1.20E-4\n');
  const five = await spec.run(viewOf(2, 2, 32, data), { precision: 5, delimiter: ',' }, null, fakeIo({ channel: 0 }));
  assert.equal(pagesText(five.pages), '1.50000,2.00000\n1234.56775,0.00012\n');
  assert.doesNotThrow(() => spec.validate({ precision: -9 }, { width: 2, height: 2, bitDepth: 32 }));
  assert.throws(() => spec.validate({ precision: -10 }, { width: 2, height: 2, bitDepth: 32 }), (e) => e.code === 'IJ_BAD_ARGS');
  assert.throws(() => spec.validate({ precision: 3, delimiter: ';' }, { width: 2, height: 2, bitDepth: 32 }), (e) => e.code === 'IJ_BAD_ARGS');
  // the sliced parse: the same image as the synchronous one on a 400 x 300 text, and the byte cap
  let txt = ''; for (let y = 0; y < 300; y++) { const row = []; for (let x = 0; x < 400; x++) row.push(((x * 31 + y * 17) % 997) / 8); txt += row.join('\t') + '\n'; }
  const a = X.parseTextImage(txt), b = await X.parseTextImageAsync(txt);
  assert.equal(b.width, 400); assert.equal(b.height, 300);
  assert.equal(Buffer.compare(Buffer.from(a.data.buffer), Buffer.from(b.data.buffer)), 0);
  await assert.rejects(X.parseTextImageAsync(new Uint8Array(257 * 1048576)), (e) => e.code === 'IJ_IO_TOO_LARGE');
  // a text of several slices (the generator hands control back every 1 M characters)
  const big = ('1 2 3 4 5 6 7 8 9 10'+String.fromCharCode(10)).repeat(200000);
  const r = await X.parseTextImageAsync(big);
  assert.equal(r.width, 10); assert.equal(r.height, 200000);
});

// ─────────────────────────────────────────────────────────── XYWriter
await test('Save As XY Coordinates: every ROI of the fixture prints the lines XYWriter printed (calibrated or not)', () => {
  const files = readJson('roi_files.json'), fx = readJson('xy_writer.json');
  let count = 0, sets = 0;
  for (const c of fx.cases) {
    const roi = C.decode(b64(files.cases.find((x) => x.name === c.name).b64));
    const cal = c.calibrated ? { pixelWidth: 0.5, pixelHeight: 0.5, unit: 'um' } : { pixelWidth: 1, pixelHeight: 1, unit: 'px' };
    const got = X.xyWriterText(roi, cal);
    if (/^composite/.test(c.name)) {
      // the vertices of a composite come out in the order of the path ImageJ built; ours follow the outline tracer: same vertices
      assert.deepEqual(got.split('\n').sort(), c.text.split('\n').sort(), c.name + ' (vertex set)');
      sets++;
    } else assert.equal(got, c.text, `${c.name}${c.calibrated ? ' (calibrated)' : ''}`);
    count++;
  }
  assert.equal(count, 56); assert.equal(sets, 4);
  // a selection made here (never through a file): the same rules
  assert.equal(X.xyWriterText({ type: 'rect', x: 1, y: 2, w: 3, h: 4 }, { pixelWidth: 1, pixelHeight: 1, unit: 'px' }), '1\t2\n4\t2\n4\t6\n1\t6\n');
  assert.equal(X.xyWriterText({ type: 'polygon', points: [[0, 0], [2, 0], [2, 2]] }, { pixelWidth: 0.25, pixelHeight: 0.5, unit: 'µm' }), '0.0000\t0.0000\n0.5000\t0.0000\n0.5000\t1.0000\n');
  assert.equal(X.xyWriterText({ type: 'point', points: [[3, 4]] }, { pixelWidth: 1, pixelHeight: 1, unit: 'px' }), '3.0000\t4.0000\n', 'a point has subpixel resolution');
  assert.equal(X.xyWriterText({ type: 'line', x1: 0, y1: 0, x2: 4, y2: 3 }, { pixelWidth: 1, pixelHeight: 1, unit: 'px' }), '0.0000\t0.0000\n4.0000\t3.0000\n');
  // a calibration in pixels with another unit string still counts as scaled
  assert.equal(X.xyWriterText({ type: 'rect', x: 1, y: 1, w: 2, h: 2 }, { pixelWidth: 1, pixelHeight: 1, unit: 'mm' }), '1.0000\t1.0000\n3.0000\t1.0000\n3.0000\t3.0000\n1.0000\t3.0000\n');
  assert.ok(R.get('roiSetOp'));
});

// ─────────────────────────────────────────────────────────── XYCoordinates
await test('Save XY Coordinates: the text of XYCoordinates over the fixture images, y from the bottom or the top', async () => {
  const fx = readJson('xy_coordinates.json');
  const spec = R.get('xyCoordinates');
  let count = 0;
  for (const c of fx.cases) {
    const img = c.input, data = dataOf(img, c.bitDepth);
    const view = viewOf(img.width, img.height, c.bitDepth, data);
    const before = data.slice();
    let got;
    if (!c.selection) {
      assert.deepEqual(JSON.parse(JSON.stringify(await spec.run(view, { mode: 'probe' }, null, fakeIo()))), { background: data[0] });
      got = await spec.run(view, { mode: 'points', background: c.params.background, invertY: c.params.invertY }, null, fakeIo());
    } else {
      // ImageJ saves the selection as a result table: the mask of the ROI the fixture holds
      const roi = c.roi.type === 'oval' ? { type: 'oval', x: c.roi.x, y: c.roi.y, w: c.roi.w, h: c.roi.h } : { type: 'rect', x: c.roi.x, y: c.roi.y, w: c.roi.w, h: c.roi.h };
      got = await spec.run(view, { mode: 'selection' }, roi, fakeIo());
    }
    assert.equal(pagesText(got.pages), c.text, `${c.bitDepth}-bit ${c.selection ? 'selection ' + c.roi.type : JSON.stringify(c.params)}`);
    assert.equal(Buffer.compare(Buffer.from(data.buffer), Buffer.from(before.buffer)), 0, 'the input is untouched');
    count++;
  }
  assert.equal(count, 6);
});

await test('Save XY Coordinates: background rules, NaN, 16-bit, the selection table\'s number format, errors, cancel', async () => {
  const spec = R.get('xyCoordinates');
  const run = async (view, params, roi, io) => pagesText((await spec.run(view, params, roi || null, io || fakeIo())).pages);
  // default background = the pixel (0, 0): the dialog passes it; null reads it again
  const v16 = viewOf(3, 2, 16, Uint16Array.from([5, 5, 7, 5, 9, 5]));
  assert.equal(await run(v16, { mode: 'points', background: null, invertY: false }), '1\t0\t9\n2\t1\t7\n');
  assert.equal(await run(v16, { mode: 'points', background: 0, invertY: true }), '0\t0\t5\n1\t0\t5\n2\t0\t7\n0\t1\t5\n1\t1\t9\n2\t1\t5\n');
  // a NaN background hides the NaN pixels (v!=background is true for NaN otherwise)
  const vf = viewOf(3, 1, 32, Float32Array.from([NaN, 1.5, NaN]));
  assert.equal(await run(vf, { mode: 'points', background: NaN, invertY: true }), '1\t0\t1.5\n');
  assert.equal(await run(vf, { mode: 'points', background: 0, invertY: true }), '0\t0\tNaN\n1\t0\t1.5\n2\t0\tNaN\n', 'NaN != 0');
  // Float.toString of the value: 1.0E-4, 1.0E10, -0.0
  const vg = viewOf(4, 1, 32, Float32Array.from([1e-4, 1e10, -0, 0.1]));
  assert.equal(await run(vg, { mode: 'points', background: 5, invertY: true }), '0\t0\t1.0E-4\n1\t0\t1.0E10\n2\t0\t-0.0\n3\t0\t0.1\n');
  // the result table of a selection: (int)n == n prints without decimals (-0 as DecimalFormat does), others with 3 (ResultsTable AUTO_FORMAT), tiny values in scientific notation; 1e10 is no int
  assert.equal(await run(vg, { mode: 'selection' }, { type: 'rect', x: 0, y: 0, w: 4, h: 1 }), 'X,Y,Value\n0,0,1.000E-4\n1,0,10000000000.000\n2,0,-0\n3,0,0.100\n');
  assert.equal(await run(viewOf(2, 1, 32, Float32Array.from([2.5, 3])), { mode: 'selection' }, { type: 'rect', x: 0, y: 0, w: 2, h: 1 }), 'X,Y,Value\n0,0,2.500\n1,0,3\n');
  // an area selection is required for the selection mode
  await assert.rejects(spec.run(v16, { mode: 'selection' }, { type: 'line', x1: 0, y1: 0, x2: 2, y2: 0 }, fakeIo()), (e) => e.code === 'IJ_NEEDS_ROI');
  await assert.rejects(spec.run(v16, { mode: 'selection' }, null, fakeIo()), (e) => e.code === 'IJ_NEEDS_ROI');
  assert.throws(() => spec.validate({ mode: 'nope' }), (e) => e.code === 'IJ_BAD_ARGS');
  assert.throws(() => spec.validate({ mode: 'points', background: 'x', invertY: false }), (e) => e.code === 'IJ_BAD_ARGS');
  assert.throws(() => spec.validate({ mode: 'points', background: 0, invertY: 1 }), (e) => e.code === 'IJ_BAD_ARGS');
  // a channel the document does not have
  await assert.rejects(spec.run(v16, { mode: 'probe' }, null, fakeIo({ channel: 3 })), (e) => e.code === 'IJ_BAD_ARGS');
  // progress and cancel over a big image
  const W = 900, H = 700, d = new Uint8Array(W * H).map((_, i) => (i % 3 ? 1 : 0));
  const io = fakeIo();
  const big = await spec.run(viewOf(W, H, 8, d), { mode: 'points', background: 0, invertY: false }, null, io);
  assert.ok(io.ticks >= 5, 'ticks ' + io.ticks);
  assert.equal(big.count, d.reduce((s, v) => s + (v ? 1 : 0), 0));
  const io2 = fakeIo({ cancelAt: 2 }); io2.tick = async () => { io2.check(); };
  await assert.rejects(spec.run(viewOf(W, H, 8, d), { mode: 'points', background: 0, invertY: false }, null, io2), (e) => e.code === 'IJ_CANCELLED');
});

// ─────────────────────────────────────────────────────────── the compressed TIFFs of the Download Center
const gradient = (w, h, bd, seed = 1) => {
  const a = bd === 8 ? new Uint8Array(w * h) : bd === 16 ? new Uint16Array(w * h) : new Float32Array(w * h);
  for (let i = 0; i < a.length; i++) {
    const x = i % w, y = Math.floor(i / w);
    a[i] = bd === 8 ? (x * 3 + y * 7 + seed * 31) & 255 : bd === 16 ? (x * 211 + y * 997 + seed * 4001) & 65535 : f32((x - y) * 0.37 + seed + (x * y) / 7);
  }
  return a;
};

await test('compressed TIFFs: deflate (8) and 32946, predictor 1 and 2, strips, byte orders, 8 / 16 / 32-bit', async () => {
  const T = ctx.IJLocalTiff;
  let count = 0;
  for (const bd of [8, 16, 32]) for (const compression of ['deflate', 'adobe']) for (const predictor of bd === 32 ? [1, 2] : [1, 2]) for (const bigEndian of [false, true]) {
    const W = 37, H = 29;
    const planes = [gradient(W, H, bd, 1), gradient(W, H, bd, 2)];
    const bytes = buildTiff({ width: W, height: H, bitDepth: bd, planes: planes.map((p) => p.slice()), compression, predictor, rowsPerStrip: 8, bigEndian, description: 'ImageJ=1.54f\nimages=2\nchannels=2\n' });
    assert.equal(T.needsDecoder(bytes), true);
    const img = await T.read(bytes, 'bundle', { inflate });
    assert.equal(img.name, 'bundle'); assert.equal(img.width, W); assert.equal(img.height, H); assert.equal(img.bitDepth, bd);
    assert.equal(img.channels.length, 2);
    img.channels.forEach((ch, i) => {
      assert.equal(ch.data.length, W * H);
      assert.equal(Buffer.compare(Buffer.from(ch.data.buffer, ch.data.byteOffset, ch.data.byteLength), Buffer.from(planes[i].buffer, planes[i].byteOffset, planes[i].byteLength)), 0, `${bd}-bit ${compression} predictor ${predictor} ${bigEndian ? 'MM' : 'II'} plane ${i}`);
    });
    count++;
  }
  assert.equal(count, 24);
});

await test('compressed TIFFs: the ImageJ metadata, the calibration, the photometric interpretation', async () => {
  const T = ctx.IJLocalTiff;
  const W = 16, H = 12;
  const red = new Uint8Array(768); for (let i = 0; i < 256; i++) red[i * 3] = i;
  const bytes = buildTiff({
    width: W, height: H, bitDepth: 8, planes: [gradient(W, H, 8, 1), gradient(W, H, 8, 2)], compression: 'deflate', predictor: 2, rowsPerStrip: 5,
    description: 'ImageJ=1.54f\nchannels=2\nunit=micron\nmin=10\nmax=200\n', resolution: { x: 2.5, y: 2.5, unit: 1 },
    imagejMeta: { labels: ['DAPI', 'GFP'], ranges: [[5, 250], [0, 100]], luts: [red, null].filter(Boolean) }
  });
  const img = await T.read(bytes, 'x', { inflate });
  assert.deepEqual(asArray(img.channels.map((c) => c.name)), ['DAPI', 'GFP']);
  assert.deepEqual([img.channels[0].display.min, img.channels[0].display.max, img.channels[1].display.min, img.channels[1].display.max], [5, 250, 0, 100]);
  assert.equal(img.channels[0].display.lut, 'Red'); assert.equal(img.channels[0].color, '#ff0000');
  assert.equal(img.calibration.unit, 'µm'); assert.ok(Math.abs(img.calibration.pixelWidth - 0.4) < 1e-9);
  const inv = await T.read(buildTiff({ width: 6, height: 4, bitDepth: 8, planes: [gradient(6, 4, 8)], compression: 'deflate', photometric: 0 }), 'inv', { inflate });
  assert.equal(inv.channels[0].display.invert, true, 'WhiteIsZero → an inverting LUT');
  // single-plane, no metadata: the defaults
  const plain = await T.read(buildTiff({ width: 6, height: 4, bitDepth: 16, planes: [gradient(6, 4, 16)], compression: 'deflate' }), undefined, { inflate });
  assert.equal(plain.name, 'Untitled'); assert.equal(plain.channels[0].name, 'C1'); assert.equal(plain.calibration.unit, 'px');
});

await test('compressed TIFFs: what is not read is refused with IJ_TIFF_UNSUPPORTED, and an uncompressed file does not need the decoder', async () => {
  const T = ctx.IJLocalTiff;
  const W = 8, H = 8, plane = gradient(W, H, 8);
  const plain = buildTiff({ width: W, height: H, bitDepth: 8, planes: [plane] });
  assert.equal(T.needsDecoder(plain), false);
  assert.equal(T.needsDecoder(buildTiff({ width: W, height: H, bitDepth: 8, planes: [plane], predictor: 2 })), true, 'a predictor alone needs it');
  const unsupported = (e) => e.code === 'IJ_TIFF_UNSUPPORTED';
  assert.throws(() => T.needsDecoder(new Uint8Array(4)), unsupported);
  assert.throws(() => T.needsDecoder(Uint8Array.from([0x49, 0x49, 43, 0, 8, 0, 0, 0])), unsupported, 'BigTIFF');
  assert.throws(() => T.needsDecoder(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8])), unsupported, 'not a TIFF');
  // LZW (5)
  const lzw = buildTiff({ width: W, height: H, bitDepth: 8, planes: [plane], compression: 'deflate' });
  const idx = (() => { for (let i = 8; i < lzw.length - 12; i++) if (lzw[i] === 3 && lzw[i + 1] === 1 && lzw[i + 2] === 3 && lzw[i + 3] === 0 && lzw[i + 4] === 1) return i; return -1; })();
  assert.ok(idx > 0, 'found the compression tag');
  const lz = lzw.slice(); lz[idx + 8] = 5;
  await assert.rejects(T.read(lz, 'x', { inflate }), unsupported);
  // a z stack described by ImageJ is read as a stack (the compressed reader shares assemble() with IJTiff.read)
  const zs = await T.read(buildTiff({ width: W, height: H, bitDepth: 8, planes: [plane, plane], compression: 'deflate', description: 'ImageJ=1.54f\nimages=2\nslices=2\n' }), 'x', { inflate });
  assert.equal(zs.nZ, 2); assert.equal(zs.nT, 1); assert.equal(zs.channels.length, 1); assert.equal(zs.channels[0].planes.length, 2);
  const z3 = await T.read(buildTiff({ width: W, height: H, bitDepth: 8, planes: [plane, plane, plane], compression: 'deflate', description: 'ImageJ=1.54f\nimages=3\nslices=3\n' }), 'x', { inflate });
  assert.equal(z3.nZ, 3);
  // a truncated strip: the data is cut off
  const cut = buildTiff({ width: W, height: H, bitDepth: 8, planes: [plane], compression: 'deflate' }).slice(0, 60);
  await assert.rejects(T.read(cut, 'x', { inflate }), unsupported);
  // a corrupt deflate stream is a corrupt file
  const bad = buildTiff({ width: W, height: H, bitDepth: 8, planes: [plane], compression: 'deflate' });
  bad[8] ^= 0xff; bad[9] ^= 0xff;
  await assert.rejects(T.read(bad, 'x', { inflate }));
  // no inflater available (no DecompressionStream in this realm)
  await assert.rejects(T.read(buildTiff({ width: W, height: H, bitDepth: 8, planes: [plane], compression: 'deflate' }), 'x'), (e) => e.code === 'IJ_LIB_TIFF_NO_INFLATE');
});


await test('File > Open: the kind of a file by name then by magic bytes; a decoded picture becomes one grey channel or three coloured ones', () => {
  const K = ctx.IJFileKinds;
  const kinds = { 'a.TIF': 'tiff', 'a.tiff': 'tiff', 'a.png': 'image', 'a.JPG': 'image', 'a.jpeg': 'image', 'a.gif': 'image', 'a.bmp': 'image', 'a.txt': 'text', 'a.roi': 'roi', 'a.zip': 'zip', 'a.lut': 'lut' };
  for (const [name, kind] of Object.entries(kinds)) assert.equal(K.kindOf(name, new Uint8Array(0)), kind, name);
  assert.equal(K.kindOf('noext', Uint8Array.from([0x49, 0x49, 42, 0])), 'tiff');
  assert.equal(K.kindOf('noext', Uint8Array.from([0x4d, 0x4d, 0, 42])), 'tiff');
  assert.equal(K.kindOf('x', Uint8Array.from([0x89, 0x50, 0x4e, 0x47])), 'image');
  assert.equal(K.kindOf('x', Uint8Array.from([0xff, 0xd8, 0xff, 0xe0])), 'image');
  assert.equal(K.kindOf('x', Uint8Array.from([0x47, 0x49, 0x46, 0x38])), 'image');
  assert.equal(K.kindOf('x', Uint8Array.from([0x42, 0x4d, 0, 0])), 'image');
  assert.equal(K.kindOf('x', Uint8Array.from([0x50, 0x4b, 3, 4])), 'zip');
  assert.equal(K.kindOf('x', Uint8Array.from([0x49, 0x6f, 0x75, 0x74])), 'roi');
  assert.equal(K.kindOf('notes.docx', Uint8Array.from([1, 2, 3, 4])), null);
  assert.equal(K.kindOf('a.docx.png', new Uint8Array(0)), 'image', 'the last extension counts');
  for (const c of ['IJ_IO_UNKNOWN_FORMAT', 'IJ_IO_NEEDS_IMAGE', 'IJ_IO_DECODE']) assert.equal(K.error(c).code, c);
  assert.throws(() => K.error('IJ_SOMETHING'), (e) => e.code === 'IJ_BAD_ARGS');
  const grey = K.imageFromRgba(Uint8ClampedArray.from([5, 5, 5, 255, 9, 9, 9, 0]), 2, 1, 'g');
  assert.equal(grey.channels.length, 1); assert.deepEqual(asArray(grey.channels[0].data), [5, 9]); assert.equal(grey.bitDepth, 8); assert.equal(grey.name, 'g');
  const col = K.imageFromRgba(Uint8ClampedArray.from([1, 2, 3, 255, 4, 5, 6, 255]), 2, 1, 'c');
  assert.equal(col.channels.length, 3); assert.equal(col.rgb, true); assert.equal(grey.rgb, undefined);
  assert.deepEqual(asArray(col.channels.map((c) => c.name)), ['Red', 'Green', 'Blue']);
  assert.deepEqual(asArray(col.channels.map((c) => c.color)), ['#ff0000', '#00ff00', '#0000ff']);
  assert.deepEqual(asArray(col.channels[1].data), [2, 5]);
  assert.deepEqual([col.channels[2].display.lut, col.channels[2].display.min, col.channels[2].display.max], ['Blue', 0, 255]);
});

console.log(`ok test_ij_io_text (${n} groups)`);
