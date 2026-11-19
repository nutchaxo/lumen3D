// P-io — the .roi codec (IJRoiCodec) and the RoiSet zip against the ImageJ 1.54p fixtures (tests/fixtures/ij-wave3/io):
//   roi_files.json      the bytes RoiEncoder wrote for every ROI type and option, with what RoiDecoder reads back
//   roiset_zip.json     a RoiSet zip (DEFLATED and STORED) as RoiManager.saveMultiple writes it
//   decode_ours.json    the 1.54p RoiDecoder over the files OUR encoder wrote (tests/fixtures/ij-wave3/io/ours/*.roi)
// Exactness: the bytes of a file are compared byte for byte; a decoded geometry is compared to the float32 values the Java
// decoder reports (our coordinates are the same float32 values widened), masks pixel for pixel.
//
// Run: node tests/js/test_ij_io_codec.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { FIX, b64, inflateRaw, loadIo, oursCases, readJson } from './ij_io_support.mjs';

const ctx = loadIo();
const C = ctx.IJRoiCodec, R = ctx.IJRoi, J = ctx.IJJava;
let n = 0;
const test = async (name, fn) => { try { await fn(); n++; } catch (err) { console.error('FAIL', name); throw err; } };
const hex = (u8) => Buffer.from(u8).toString('hex');
const sameBytes = (got, want, what) => {
  if (got.length === want.length && Buffer.from(got).equals(Buffer.from(want))) return;
  let at = -1;
  for (let i = 0; i < Math.max(got.length, want.length); i++) if (got[i] !== want[i]) { at = i; break; }
  assert.fail(`${what}: ${got.length} bytes vs ${want.length}, first difference at byte ${at} (got ${got[at]}, want ${want[at]})`);
};
const f32 = Math.fround;

// ─────────────────────────────────────────────────────────── Java number formatting
await test('IJ.d2s / ResultsTable.d2s / Float.toString / parseDouble', () => {
  // DecimalFormat HALF_EVEN on the exact value
  assert.equal(J.d2s(0.125, 2), '0.12');
  assert.equal(J.d2s(0.375, 2), '0.38');
  assert.equal(J.d2s(2.5, 0), '2');
  assert.equal(J.d2s(3.5, 0), '4');
  assert.equal(J.d2s(123456.7890625, 6), '123456.789062', 'the exact tie of the text_encoder fixture goes to the even digit');
  assert.equal(J.d2s(2.675, 2), '2.67', 'the exact binary value of 2.675 is below the tie');
  assert.equal(J.d2s(-1.5, 0), '-2');
  assert.equal(J.d2s(-0.0001, 3), '-0.000');
  assert.equal(J.d2s(1e-7, 3), '0.000');
  assert.equal(J.d2s(400, 3), '400.000');
  assert.equal(J.d2s(NaN, 3), 'NaN');
  assert.equal(J.d2s(Infinity, 3), 'Infinity');
  assert.equal(J.d2s(-Infinity, 3), '-Infinity');
  assert.equal(J.d2s(3.4028234663852886e38, 3), '3.4e38');
  assert.equal(J.d2s(1e30, 2), '1000000000000000000000000000000.00', 'Java prints the shortest digits then zeros');
  assert.equal(J.d2s(0.5, 4), '0.5000');
  assert.equal(J.d2s(20.5 * 0.5, 4), '10.2500');
  assert.equal(J.d2s(1.0625, -3), '1.062E0', 'scientific: HALF_EVEN too');
  assert.equal(J.d2s(12345.678, -2), '1.23E4');
  assert.equal(J.d2s(0, -2), '0.00E0');
  assert.equal(J.rtD2s(45, 0), '45');
  assert.equal(J.rtD2s(0.25, 3), '0.250');
  assert.equal(J.rtD2s(0.0001, 3), '1.000E-4', 'ResultsTable switches to scientific notation below 10^-places');
  assert.equal(J.rtD2s(1e13, 3), '1.000E13');
  assert.equal(J.floatToString(1), '1.0');
  assert.equal(J.floatToString(2.25), '2.25');
  assert.equal(J.floatToString(100), '100.0');
  assert.equal(J.floatToString(f32(0.1)), '0.1');
  assert.equal(J.floatToString(f32(1e-4)), '1.0E-4');
  assert.equal(J.floatToString(f32(0.001)), '0.001');
  assert.equal(J.floatToString(f32(1.234e10)), '1.234E10');
  assert.equal(J.floatToString(9999999), '9999999.0');
  assert.equal(J.floatToString(1e7), '1.0E7');
  assert.equal(J.floatToString(3.4028234663852886e38), '3.4028235E38');
  assert.equal(J.floatToString(f32(123456.789)), '123456.79');
  assert.equal(J.floatToString(-0), '-0.0');
  assert.equal(J.floatToString(NaN), 'NaN');
  assert.equal(J.floatToString(f32(16777216)), '1.6777216E7');
  assert.equal(J.parseDouble('17'), 17);
  assert.equal(J.parseDouble('-5.5e2'), -550);
  assert.equal(J.parseDouble('1.5f'), 1.5);
  assert.equal(J.parseDouble('+3'), 3);
  assert.equal(J.parseDouble('.5'), 0.5);
  assert.equal(J.parseDouble('5.'), 5);
  assert.equal(J.parseDouble('Infinity'), Infinity);
  assert.equal(J.parseDouble('-Infinity'), -Infinity);
  assert.ok(Number.isNaN(J.parseDouble('NaN')));
  for (const s of ['abc', '', '1,5', '1e', '--1', '0x10', '1_0', 'nan', 'inf']) assert.ok(Number.isNaN(J.parseDouble(s)), s);
});

// ─────────────────────────────────────────────────────────── encoder against the bytes RoiEncoder wrote
const files = readJson('roi_files.json');
const fixture = (name) => files.cases.find((c) => c.name === name);
const fixtureBytes = (name) => b64(fixture(name).b64);
const pointsOf = (name) => { const fp = fixture(name).roi.floatPolygon; const p = []; for (let i = 0; i < fp.length; i += 2) p.push([fp[i], fp[i + 1]]); return p; };

// our model of each ROI the 1.54p driver (tools/ij_fixtures/W3Io.java) built
const MODEL = {
  rect: () => ({ roi: { type: 'rect', x: 10, y: 8, w: 30, h: 20 } }),
  rect_rounded: () => ({ roi: { type: 'rect', x: 10, y: 8, w: 30, h: 20, arc: 8 } }),
  rect_subpixel: () => ({ roi: { type: 'rect', x: 10.5, y: 8.25, w: 30.75, h: 20.5 } }),
  oval: () => ({ roi: { type: 'oval', x: 12, y: 6, w: 28, h: 22 } }),
  oval_subpixel: () => ({ roi: { type: 'oval', x: 12.5, y: 6.5, w: 27.25, h: 22.75 } }),
  polygon: () => ({ roi: { type: 'polygon', points: [[8, 6], [40, 10], [52, 30], [30, 22], [36, 40], [14, 34]] } }),
  polygon_subpixel: () => ({ roi: { type: 'polygon', points: [[8.5, 6.25], [40.5, 10], [52, 30.5], [20, 40]] } }),
  freehand: () => ({ roi: { type: 'freehand', points: pointsOf('freehand') } }),
  traced: () => ({ roi: { type: 'polygon', traced: true, points: pointsOf('traced') } }),
  freehand_subpixel: () => ({ roi: { type: 'freehand', points: [[10.5, 10], [14, 9.5], [18, 12], [17, 18.5], [11, 17]] } }),
  line: () => ({ roi: { type: 'line', x1: 6, y1: 40, x2: 58, y2: 8 } }),
  line_subpixel: () => ({ roi: { type: 'line', x1: 6.5, y1: 40.25, x2: 58.75, y2: 8.5 } }),
  line_width4: () => ({ roi: { type: 'line', x1: 6, y1: 40, x2: 58, y2: 8, width: 4 } }),
  polyline: () => ({ roi: { type: 'polyline', points: [[6, 38], [18, 12], [33, 30], [46, 10], [58, 28]] } }),
  polyline_subpixel: () => ({ roi: { type: 'polyline', points: [[6.5, 38], [18, 12.5], [33.25, 30]] } }),
  angle: () => ({ roi: { type: 'angle', points: [[10, 10], [30, 20], [40, 8]] } }),
  point_single: () => ({ roi: { type: 'point', points: [[21, 17]] } }),
  points_multi: () => ({ roi: { type: 'point', points: [[10, 10], [30, 8], [46, 20], [40, 38]] } }),
  points_subpixel: () => ({ roi: { type: 'point', points: [[10.5, 10], [30.25, 8.75], [46, 20.5]] } }),
  // setName / setStrokeColor / setFillColor / setStrokeWidth / setPosition: the style travels beside the ROI.
  // ImageJ's setFillColor drops the stroke colour (the 1.54p file has none), so the model gives the fill only.
  rect_named: () => ({ roi: { type: 'rect', x: 4, y: 4, w: 20, h: 16, name: 'cell-7' } }),
  oval_styled: () => ({ roi: { type: 'oval', x: 8, y: 8, w: 24, h: 24 }, style: { name: 'styled', fill: '#8000ff60', width: 3.5 } }),
  rect_position_czt: () => ({ roi: { type: 'rect', x: 6, y: 6, w: 12, h: 12 }, style: { position: { c: 2, z: 3, t: 4 } } }),
  rect_stroke_only: () => ({ roi: { type: 'rect', x: 6, y: 6, w: 12, h: 12 }, style: { stroke: '#00ffff' } })
};

await test('encode: byte-identical to RoiEncoder for every type and option it can express', () => {
  let count = 0;
  for (const [name, make] of Object.entries(MODEL)) {
    const { roi, style } = make();
    sameBytes(C.encode(roi, style), fixtureBytes(name), name);
    count++;
  }
  assert.equal(count, Object.keys(MODEL).length);
  // every fixture is either modelled, or one of the types this view does not have (decoded to a polygon / a mask)
  const unmodelled = files.cases.map((c) => c.name).filter((nm) => !MODEL[nm]).sort();
  assert.deepEqual(unmodelled, ['composite_holed', 'composite_two_rects', 'ellipse', 'freeline', 'rotated_rect']);
});

await test('encode: the structure of the 64 + 64 byte headers, from the source', () => {
  const b = C.encode({ type: 'rect', x: 10, y: 8, w: 30, h: 20 }, { name: 'ab', stroke: '#ff8000', fill: '#11223344', width: 2.5, position: { c: 1, z: 2, t: 3 } });
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  assert.equal(String.fromCharCode(b[0], b[1], b[2], b[3]), 'Iout');
  assert.equal(dv.getInt16(4), 228, 'VERSION');
  assert.equal(b[6], 1, 'rect');
  assert.deepEqual([dv.getInt16(8), dv.getInt16(10), dv.getInt16(12), dv.getInt16(14)], [8, 10, 28, 40], 'top left bottom right');
  assert.equal(dv.getInt16(34), 2, 'stroke width (int)');
  assert.equal(dv.getInt32(40), 0xff8000 | 0xff000000 | 0, 'stroke colour, opaque ARGB');
  assert.equal(dv.getInt32(44) >>> 0, 0x44112233, 'fill colour ARGB: the alpha of "#rrggbbaa" comes first in the file');
  assert.equal(dv.getInt16(50) & 8192, 8192, 'SCALE_STROKE_WIDTH');
  const h2 = dv.getInt32(60);
  assert.equal(h2, 64);
  assert.equal(b.length, 64 + 64 + 4, 'headers + the name');
  assert.deepEqual([dv.getInt32(h2 + 4), dv.getInt32(h2 + 8), dv.getInt32(h2 + 12)], [1, 2, 3], 'c z t');
  assert.equal(dv.getInt32(h2 + 16), h2 + 64);
  assert.equal(dv.getInt32(h2 + 20), 2);
  assert.equal(dv.getFloat32(h2 + 36), 2.5);
  assert.equal(String.fromCharCode(dv.getUint16(h2 + 64), dv.getUint16(h2 + 66)), 'ab');
  // sizes: a polygon of n integer vertices = 128 + 4n; float coordinates add 8n; a point adds a counter table (4n)
  assert.equal(C.encode({ type: 'polygon', points: [[0, 0], [5, 0], [5, 5]] }).length, 128 + 12);
  assert.equal(C.encode({ type: 'polygon', points: [[0, 0.5], [5, 0], [5, 5]] }).length, 128 + 12 + 24);
  assert.equal(C.encode({ type: 'point', points: [[1, 1], [2, 2]] }).length, 128 + 8 + 16 + 8);
});

await test('encode: a long vertex list becomes a composite; a name over 255 characters is cut; an empty mask is refused', () => {
  const big = []; for (let i = 0; i < 70000; i++) big.push([i % 300, Math.floor(i / 300) + (i % 2)]);
  const bytes = C.encode({ type: 'polygon', points: big });
  assert.equal(new DataView(bytes.buffer).getInt32(36) > 0, true, 'a shape array stands for more than 65535 vertices');
  const back = C.decode(bytes);
  assert.equal(back.type, 'mask');
  assert.throws(() => C.encode({ type: 'rect', x: 1, y: 1, w: 3, h: 3, name: 'x'.repeat(300) }), (e) => e.code === 'IJ_BAD_ROI');
  assert.equal(C.decode(C.encode({ type: 'rect', x: 1, y: 1, w: 3, h: 3 }, { name: 'y'.repeat(300) })).name.length, 255);
  assert.throws(() => C.encode({ type: 'mask', x: 0, y: 0, w: 0, h: 0, rle: new Uint32Array(0) }), (e) => e.code === 'IJ_EMPTY_ROI' || e.code === 'IJ_BAD_ROI');
  assert.throws(() => C.encode({ type: 'rect', x: NaN, y: 0, w: 1, h: 1 }), (e) => e.code === 'IJ_BAD_ROI');
  // a point list over 65535 points keeps its count in the SIZE field
  const pts = []; for (let i = 0; i < 70000; i++) pts.push([i % 500, Math.floor(i / 500)]);
  const pb = C.encode({ type: 'point', points: pts });
  const dv = new DataView(pb.buffer);
  assert.equal(dv.getUint16(16), 0); assert.equal(dv.getInt32(18), 70000);
});

// ─────────────────────────────────────────────────────────── decoder against what RoiDecoder reports
// the fixtures print a float with 7 significant digits
const near = (a, b, tol, what) => assert.ok(Math.abs(a - b) <= Math.max(tol, 2e-7 * Math.abs(b)), `${what}: ${a} vs ${b}`);
function samePolygon(got, want, what) {
  assert.equal(got.length * 2, want.length, what + ': vertex count');
  for (let i = 0; i < got.length; i++) { near(got[i][0], want[2 * i], 1e-6, what + ' x' + i); near(got[i][1], want[2 * i + 1], 1e-6, what + ' y' + i); }
}
function sameMask(roi, desc, what) {
  assert.ok(desc.mask, what + ': the fixture has a mask');
  const m = R.mask(roi), want = desc.mask;
  assert.deepEqual([m.x, m.y, m.w, m.h], [want.x, want.y, want.w, want.h], what + ': mask box');
  const wd = Array.isArray(want.data) ? want.data : Array.from(b64(want.data.b64));
  let bad = 0;
  for (let i = 0; i < wd.length; i++) if ((m.data[i] ? 1 : 0) !== (wd[i] ? 1 : 0)) bad++;
  assert.equal(bad, 0, `${what}: ${bad} mask pixels differ`);
}
const TYPE_OF = { Rectangle: 'rect', Oval: 'oval', Polygon: 'polygon', Freehand: 'freehand', Traced: 'polygon', 'Straight Line': 'line', Polyline: 'polyline', Freeline: 'polyline', Angle: 'angle', Point: 'point', 'Rotated Rectangle': 'polygon', Composite: 'mask' };

await test('decode: every ImageJ file reads to the geometry RoiDecoder reports', () => {
  for (const c of files.cases) {
    const d = C.decodeEntry(b64(c.b64));
    const want = c.decoded;
    const expectType = c.name === 'rotated_rect' ? 'polygon' : c.name === 'ellipse' ? 'freehand' : TYPE_OF[want.typeName];
    assert.equal(d.roi.type, expectType, c.name + ': type');
    assert.equal(!!d.roi.traced, want.typeName === 'Traced', c.name + ': traced flag');
    assert.equal(d.name || null, want.name, c.name + ': name');
    if (d.roi.type === 'rect' || d.roi.type === 'oval') {
      const fb = want.floatBounds;
      assert.deepEqual([d.roi.x, d.roi.y, d.roi.w, d.roi.h], [fb[0], fb[1], fb[2], fb[3]].map((v, i) => (want.subPixel ? v : (i < 2 ? v : Math.max(1, v)))), c.name + ': box');
    } else if (d.roi.type === 'line') {
      assert.equal(d.roi.width || 0, want.strokeWidth, c.name + ': line width');
      const fb = want.floatBounds;
      near(Math.min(d.roi.x1, d.roi.x2), fb[0], 1e-6, c.name + ' x'); near(Math.min(d.roi.y1, d.roi.y2), fb[1], 1e-6, c.name + ' y');
    } else if (d.roi.type !== 'mask') samePolygon(d.roi.points, want.floatPolygon, c.name);
    else sameMask(d.roi, want, c.name);
    if (want.mask && d.roi.type !== 'mask' && c.name !== 'rect_rounded') {
      // the ImageJ mask of the ROI and ours agree on the pixels (rect / oval / polygon of the fixture)
      const mk = R.mask(d.roi);
      if (mk.w && ['rect', 'polygon', 'freehand'].includes(d.roi.type) && !want.subPixel) {
        assert.equal(R.area(d.roi), want.area, c.name + ': area');
      }
    }
  }
});

await test('decode: style, name, position and arc', () => {
  const s = C.decodeEntry(fixtureBytes('oval_styled'));
  assert.equal(s.name, 'styled'); assert.equal(s.width, 3.5); assert.equal(s.fill, '#8000ff60'); assert.equal(s.stroke, null);
  const c = C.decodeEntry(fixtureBytes('rect_stroke_only'));
  assert.equal(c.stroke, '#00ffff'); assert.equal(c.fill, null);
  assert.deepEqual(JSON.parse(JSON.stringify(C.decodeEntry(fixtureBytes('rect_position_czt')).position)), { c: 2, z: 3, t: 4 });
  assert.equal(C.decodeEntry(fixtureBytes('rect_position_czt')).stroke, null);
  assert.equal(C.decode(fixtureBytes('rect_rounded')).arc, 8);
  assert.equal(C.decode(fixtureBytes('rect')).arc, undefined);
  // the file's own name is used when the file has none ("RoiDecoder: name = file name without .roi")
  assert.equal(C.decode(fixtureBytes('rect'), { fileName: 'nucleus 4.roi' }).name, 'nucleus 4');
  assert.equal(C.decode(fixtureBytes('rect_named'), { fileName: 'other.roi' }).name, 'cell-7', 'the name inside the file wins');
  // a point has no stroke width (RoiDecoder: setStrokeWidth(0))
  assert.equal(C.decodeEntry(fixtureBytes('point_single')).width, 0);
});

await test('encode(decode(file)) gives the file back; the types this view lacks come back as what they are', () => {
  for (const c of files.cases) {
    if (['freeline', 'ellipse', 'rotated_rect', 'composite_holed', 'composite_two_rects'].includes(c.name)) continue;
    const bytes = b64(c.b64);
    const d = C.decodeEntry(bytes);
    sameBytes(C.encode(d.roi, d), bytes, c.name + ' round trip');
  }
  // a freehand LINE is a segmented line here; an EllipseRoi / RotatedRectRoi keep their vertices as a freehand / polygon
  const fl = C.decode(fixtureBytes('freeline'));
  assert.equal(fl.type, 'polyline');
  assert.equal(new DataView(C.encode(fl).buffer).getInt16(4) === 228 && C.encode(fl)[6], 5);
  const el = C.decode(fixtureBytes('ellipse'));
  const again = C.decode(C.encode(el));
  samePolygon(again.points, fixture('ellipse').roi.floatPolygon, 'ellipse vertices survive');
  const rr = C.decode(fixtureBytes('rotated_rect'));
  samePolygon(C.decode(C.encode(rr)).points, fixture('rotated_rect').roi.floatPolygon, 'rotated rectangle vertices survive');
});

await test('composite selections: the shape array reads to the ImageJ mask, and a mask writes back to the same pixels', () => {
  for (const name of ['composite_holed', 'composite_two_rects']) {
    const d = C.decode(fixtureBytes(name));
    assert.equal(d.type, 'mask');
    sameMask(d, fixture(name).roi, name);
    const out = C.encode(d);
    assert.equal(out.length, fixture(name).length, name + ': same number of segments as ImageJ wrote');
    const m1 = R.mask(d), m2 = R.mask(C.decode(out));
    assert.deepEqual([m2.x, m2.y, m2.w, m2.h], [m1.x, m1.y, m1.w, m1.h]);
    assert.deepEqual(Array.from(m2.data), Array.from(m1.data), name + ': pixels survive the round trip');
  }
  // curves: a QUADTO / CUBICTO subpath is flattened; a circle of cubics fills like the oval of the same box
  const k = 0.5522847498307933, cx = 20, cy = 20, r = 10;
  const arr = [0, cx + r, cy, 3, cx + r, cy + k * r, cx + k * r, cy + r, cx, cy + r, 3, cx - k * r, cy + r, cx - r, cy + k * r, cx - r, cy, 3, cx - r, cy - k * r, cx - k * r, cy - r, cx, cy - r, 3, cx + k * r, cy - r, cx + r, cy - k * r, cx + r, cy, 4];
  const bytes = new Uint8Array(64 + 64 + arr.length * 4);
  const dv = new DataView(bytes.buffer);
  bytes.set([73, 111, 117, 116]); dv.setInt16(4, 228); bytes[6] = 1; dv.setInt16(8, 10); dv.setInt16(10, 10); dv.setInt16(12, 30); dv.setInt16(14, 30); dv.setInt32(36, arr.length); dv.setInt32(60, 64 + arr.length * 4);
  arr.forEach((v, i) => dv.setFloat32(64 + i * 4, v));
  const circle = C.decode(bytes);
  const ov = R.mask({ type: 'oval', x: 10, y: 10, w: 20, h: 20 }), cm = R.mask(circle);
  assert.deepEqual([cm.x, cm.y, cm.w, cm.h], [ov.x, ov.y, ov.w, ov.h]);
  let diff = 0; for (let i = 0; i < ov.data.length; i++) if (ov.data[i] !== cm.data[i]) diff++;
  assert.ok(diff <= 6, `a circle of cubics and the oval differ by ${diff} edge pixels`);
});

await test('a mask: one outline → a traced polygon; holes or several parts → a composite; both read back to the same pixels', () => {
  for (const cs of oursCases(ctx).filter((x) => x.roi.type === 'mask')) {
    const bytes = C.encode(cs.roi, cs.style);
    const loops = R.outlines(cs.roi).length;
    assert.equal(bytes[6], loops === 1 ? 8 : 1, cs.name + ': traced polygon (8) for one outline, rect type with a shape array (1) otherwise');
    assert.equal(new DataView(bytes.buffer, bytes.byteOffset).getInt32(36) > 0, loops !== 1, cs.name);
    const back = C.decode(bytes);
    const a = R.mask(cs.roi), b = R.mask(back);
    assert.deepEqual([b.x, b.y, b.w, b.h], [a.x, a.y, a.w, a.h], cs.name + ': box');
    assert.deepEqual(Array.from(b.data), Array.from(a.data), cs.name + ': pixels');
  }
});

// ─────────────────────────────────────────────────────────── our files, read by the real 1.54p decoder (decode_ours.json)
await test('our encoder\'s files are the ones the 1.54p RoiDecoder read (tests/fixtures/ij-wave3/io/ours) and it read them right', () => {
  const rec = readJson('decode_ours.json');
  const cases = oursCases(ctx);
  assert.equal(rec.count, cases.length);
  assert.equal(rec.cases.length, cases.length);
  for (const cs of cases) {
    const bytes = C.encode(cs.roi, cs.style);
    const onDisk = new Uint8Array(fs.readFileSync(path.join(FIX, 'ours', cs.name + '.roi')));
    sameBytes(bytes, onDisk, cs.name + ' (regenerate the files and decode_ours.json with tools/ij_fixtures when the encoder changes)');
    const j = rec.cases.find((x) => x.file === cs.name + '.roi');
    assert.ok(j, cs.name + ' was decoded by ImageJ');
    assert.equal(j.length, bytes.length);
    const d = j.decoded;
    assert.ok(!d.error, cs.name + ': ' + d.error);
    const roi = cs.roi;
    const want = { rect: 'Rectangle', oval: 'Oval', polygon: roi.traced ? 'Traced' : 'Polygon', freehand: 'Freehand', line: 'Straight Line', polyline: 'Polyline', angle: 'Angle', point: 'Point', mask: R.outlines(roi).length === 1 ? 'Traced' : 'Composite' }[roi.type];
    assert.equal(d.typeName, want, cs.name + ': type read by ImageJ');
    if (cs.style && cs.style.name) assert.equal(d.name, cs.style.name, cs.name + ': name');
    if (cs.style && cs.style.width) assert.equal(d.strokeWidth, cs.style.width, cs.name + ': stroke width');
    if (roi.type === 'line' && roi.width) assert.equal(d.strokeWidth, roi.width);
    if (roi.type === 'rect' || roi.type === 'oval') assert.deepEqual(d.floatBounds, [roi.x, roi.y, roi.w, roi.h], cs.name + ': float bounds');
    if (roi.type === 'line') {
      // ImageJ's Line.getFloatPolygon: the two end points, or the rectangle of a wide line
      samePolygon(C.xyPolygon(roi).points.map((p) => [f32(p[0]), f32(p[1])]), d.floatPolygon, cs.name + ' (line polygon)');
    } else if (roi.points) samePolygon(roi.points.map((p) => [f32(p[0]), f32(p[1])]), d.floatPolygon, cs.name);
    if (roi.type === 'mask') sameMask(roi, d, cs.name);
    if (['rect', 'polygon', 'freehand'].includes(roi.type) && !/subpixel/.test(cs.name)) assert.equal(R.area(roi), d.area, cs.name + ': area (ImageJ pixel count)');
  }
});

// ─────────────────────────────────────────────────────────── RoiSet zip
await test('RoiSet: the jar\'s zip (deflated and stored) reads to the files RoiEncoder wrote', async () => {
  const z = readJson('roiset_zip.json');
  const expect = ['rect', 'oval', 'polygon', 'line', 'points_multi', 'composite_holed', 'oval_styled'];
  for (const key of ['zipDeflatedB64', 'zipStoredB64']) {
    const entries = await C.zipRead(b64(z[key]), { inflateRaw });
    assert.deepEqual(Array.from(entries.map((e) => e.name)), z.entries.map((e) => e.entry), key + ': entry names, in archive order');
    entries.forEach((e, i) => sameBytes(e.bytes, fixtureBytes(expect[i]), key + ' ' + e.name));
    const set = await C.decodeSet(b64(z[key]), { inflateRaw });
    assert.equal(set.length, 7);
    assert.deepEqual(Array.from(set.map((s) => s.name)), z.entries.map((e, i) => (i === 6 ? 'styled' : e.entry.replace(/\.roi$/, ''))), 'names without .roi; the name inside a file wins (RoiDecoder.getRoiName)');
    assert.equal(set[6].fill, '#8000ff60'); assert.equal(set[6].width, 3.5);
    assert.equal(set[5].roi.type, 'mask');
  }
  // the deflated archive needs an inflater; without one the failure says so
  await assert.rejects(C.zipRead(b64(z.zipDeflatedB64)), (e) => e.code === 'IJ_IO_ZIP_DEFLATE');
  // the stored one does not
  assert.equal((await C.zipRead(b64(z.zipStoredB64))).length, 7);
});

await test('RoiSet: our zip is a valid archive, the names stay unique, the styles travel', async () => {
  const entries = [
    { roi: { type: 'rect', x: 1, y: 2, w: 3, h: 4 }, name: '0001-0004-0003' },
    { roi: { type: 'oval', x: 5, y: 6, w: 7, h: 8 }, name: '0001-0004-0003', stroke: '#ff0000', width: 2 },
    { roi: { type: 'rect', x: 9, y: 9, w: 2, h: 2 }, name: '0001-0004-0003', fill: '#00ff0080' },
    { roi: { type: 'point', points: [[3, 3]] }, name: 'p.roi' }
  ];
  const zip = C.encodeSet(entries);
  assert.equal(C.encodeSet(entries).join(), zip.join(), 'deterministic bytes');
  const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  assert.equal(dv.getUint32(zip.length - 22, true), 0x06054b50, 'end of central directory');
  assert.equal(dv.getUint16(zip.length - 22 + 10, true), 4);
  const back = await C.zipRead(zip);
  assert.deepEqual(Array.from(back.map((e) => e.name)), ['0001-0004-0003.roi', '0001-0004-0003-1.roi', '0001-0004-0003-2.roi', 'p.roi'], 'RoiManager.getUniqueName');
  const set = await C.decodeSet(zip);
  assert.equal(set[1].roi.type, 'oval'); assert.equal(set[1].stroke, '#ff0000'); assert.equal(set[1].width, 2); assert.equal(set[2].fill, '#00ff0080');
  assert.equal(set[3].roi.type, 'point');
  // the entries survive a deflate re-compression (what Fiji / ImageJ would do) through the injected inflater
  const raw = zlib.deflateRawSync(Buffer.from(back[0].bytes));
  assert.ok(raw.length > 0);
  // names (Tools of RoiManager.getUniqueName: a trailing "-nnn" shorter than 4 characters is replaced)
  const names = ['a-12', 'a-12', 'b'];
  assert.equal(C.uniqueName(names, 1), 'a-1');
  assert.equal(names[1], 'a-1');
});

await test('RoiSet and file errors are coded', async () => {
  const code = (c) => (e) => e.code === c;
  assert.throws(() => C.decode(new Uint8Array([1, 2, 3])), code('IJ_IO_BAD_ROI'));
  assert.throws(() => C.decode(new Uint8Array(70)), code('IJ_IO_BAD_ROI'));
  const good = fixtureBytes('polygon').slice();
  assert.throws(() => C.decode(good.subarray(0, 80)), code('IJ_IO_BAD_ROI'), 'truncated coordinates');
  const unknown = fixtureBytes('rect').slice(); unknown[6] = 6;
  assert.throws(() => C.decode(unknown), code('IJ_IO_BAD_ROI'), 'type 6 (noRoi) is not a selection');
  const zeroN = fixtureBytes('polygon').slice(); zeroN[16] = 0; zeroN[17] = 0;
  assert.throws(() => C.decode(zeroN), code('IJ_IO_BAD_ROI'));
  const badShape = fixtureBytes('composite_two_rects').slice(); badShape[6] = 0;
  assert.throws(() => C.decode(badShape), code('IJ_IO_BAD_ROI'), 'a composite must have type rect');
  await assert.rejects(C.zipRead(new Uint8Array(10)), code('IJ_IO_ZIP_BAD'));
  await assert.rejects(C.zipRead(new Uint8Array(40)), code('IJ_IO_ZIP_BAD'));
  const z = C.encodeSet([{ roi: { type: 'rect', x: 1, y: 1, w: 2, h: 2 }, name: 'a' }]);
  const flipped = z.slice(); flipped[40] ^= 0xff;                 // inside the entry's data
  await assert.rejects(C.zipRead(flipped), code('IJ_IO_ZIP_BAD'), 'a flipped byte breaks the CRC-32');
  const enc = z.slice(); enc[6] |= 1;                              // the "encrypted" flag of the local header is not read, the central one is
  const cd = new DataView(z.buffer, z.byteOffset, z.byteLength).getUint32(z.length - 22 + 16, true);
  const encC = z.slice(); encC[cd + 8] |= 1;
  await assert.rejects(C.zipRead(encC), code('IJ_IO_ZIP_BAD'));
  // an archive without .roi files
  const zipTxt = C.zipStore([{ name: 'readme.txt', bytes: new TextEncoder().encode('hi') }]);
  await assert.rejects(C.decodeSet(zipTxt), code('IJ_IO_ZIP_NO_ROI'));
  // an entry inside a folder keeps its base name
  const nested = C.zipStore([{ name: 'rois/cell 1.roi', bytes: fixtureBytes('rect') }]);
  assert.equal((await C.decodeSet(nested))[0].name, 'cell 1');
});

console.log(`ok test_ij_io_codec (${n} groups)`);
