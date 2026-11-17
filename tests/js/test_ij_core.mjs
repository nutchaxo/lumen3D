// ij-core.js — every function of the Advanced view's pure core against
// hand-computed values (and the ImageJ algorithms they copy).
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FILE = 'js/modules/studio/advanced-studio/ij-core.js';
vm.runInThisContext(readFileSync(path.join(ROOT, FILE), 'utf8'), { filename: FILE });
const { IJImage, IJLuts, IJRoi, IJOps, IJProject } = globalThis;

const arr = (a) => Array.from(a);
const near = (a, b, eps = 1e-9, msg) => assert.ok(Math.abs(a - b) <= eps, (msg || '') + ' expected ' + b + ' got ' + a);
const ch = (w, h, bd, data) => ({ width: w, height: h, bitDepth: bd, data: bd === 8 ? Uint8Array.from(data) : bd === 16 ? Uint16Array.from(data) : Float32Array.from(data) });
const throwsCode = (fn, code) => assert.throws(fn, (e) => e.code === code, 'expected ' + code);

let passed = 0;
function test(name, fn) { fn(); passed++; }

// ------------------------------------------------------------------ IJImage
test('IJImage.create / typedArrayFor / bytes / dataRange / defaultDisplay', () => {
  const img = IJImage.create({ name: 'a', width: 4, height: 3, bitDepth: 16,
    channels: [{ name: 'DAPI', color: '#0000ff' }, { name: 'GFP', color: '#00ff00' }, { name: 'x', color: '#336699' }],
    calibration: { pixelWidth: 0.5, pixelHeight: 0.5, unit: 'µm' } });
  assert.equal(img.width, 4); assert.equal(img.height, 3); assert.equal(img.bitDepth, 16);
  assert.equal(img.channels.length, 3);
  assert.ok(img.channels[0].data instanceof Uint16Array);
  assert.equal(img.channels[0].data.length, 12);
  assert.equal(IJImage.bytes(img), 3 * 12 * 2);
  assert.deepEqual([img.channels[0].display.lut, img.channels[1].display.lut, img.channels[2].display.lut], ['Blue', 'Green', '#336699']);
  assert.equal(img.calibration.unit, 'µm');
  // blank 16-bit: degenerate range → full range; 8-bit 0..255; 32-bit blank 0..1
  assert.deepEqual([img.channels[0].display.min, img.channels[0].display.max], [0, 65535]);
  const i8 = IJImage.create({ width: 2, height: 2, bitDepth: 8 });
  assert.deepEqual([i8.channels[0].display.min, i8.channels[0].display.max], [0, 255]);
  assert.equal(i8.channels[0].name, 'C1');
  assert.equal(i8.calibration.unit, 'px');
  const i32 = IJImage.create({ width: 2, height: 2, bitDepth: 32 });
  assert.deepEqual([i32.channels[0].display.min, i32.channels[0].display.max], [0, 1]);
  assert.ok(IJImage.typedArrayFor(32, 3) instanceof Float32Array);
  throwsCode(() => IJImage.typedArrayFor(12, 1), 'IJ_BAD_DEPTH');
  // dataRange ignores NaN / Infinity on float data
  assert.deepEqual(IJImage.dataRange(Float32Array.from([NaN, 3, -2, Infinity, -Infinity, 7])), { min: -2, max: 7 });
  assert.deepEqual(IJImage.dataRange(Float32Array.from([NaN, NaN])), { min: 0, max: 0 });
  assert.deepEqual(IJImage.dataRange(Uint16Array.from([5, 9, 2])), { min: 2, max: 9 });
  // defaultDisplay on data: 16/32 take the data range
  const c = { bitDepth: 16, data: Uint16Array.from([100, 900, 300]) };
  const dd = IJImage.defaultDisplay(c, 16);
  assert.deepEqual([dd.min, dd.max, dd.lut, dd.invert], [100, 900, 'Grays', false]);
  const ci = IJImage.channelImage(img, 1);
  assert.equal(ci.data, img.channels[1].data); assert.equal(ci.bitDepth, 16);
});

// ------------------------------------------------------------------ IJLuts
test('IJLuts tables', () => {
  assert.deepEqual(IJLuts.names(), ['Grays', 'Red', 'Green', 'Blue', 'Cyan', 'Magenta', 'Yellow', 'Fire', 'Ice', 'Spectrum', '16 Colors', 'HiLo']);
  for (const n of IJLuts.names()) assert.equal(IJLuts.get(n).length, 768);
  const g = IJLuts.get('Grays');
  assert.deepEqual([g[0], g[1], g[2], g[300], g[301], g[302], g[765], g[766], g[767]], [0, 0, 0, 100, 100, 100, 255, 255, 255]);
  const r = IJLuts.get('Red'), cy = IJLuts.get('Cyan'), ye = IJLuts.get('Yellow'), mg = IJLuts.get('Magenta');
  assert.deepEqual([r[3 * 77], r[3 * 77 + 1], r[3 * 77 + 2]], [77, 0, 0]);
  assert.deepEqual([cy[3 * 9], cy[3 * 9 + 1], cy[3 * 9 + 2]], [0, 9, 9]);
  assert.deepEqual([ye[3 * 9], ye[3 * 9 + 1], ye[3 * 9 + 2]], [9, 9, 0]);
  assert.deepEqual([mg[3 * 9], mg[3 * 9 + 1], mg[3 * 9 + 2]], [9, 0, 9]);
  // Fire: control points land exactly on multiples of 8; entry 8 = control 1 = (0,0,61); 255 = (255,255,255)·(blend of 30,31)
  const f = IJLuts.get('Fire');
  assert.deepEqual([f[0], f[1], f[2]], [0, 0, 0]);
  assert.deepEqual([f[24], f[25], f[26]], [0, 0, 61]);
  assert.deepEqual([f[16 * 3 + 0], f[16 * 3 + 1], f[16 * 3 + 2]], [1, 0, 96]);
  // entry 12: control 1 + 4/8 → between (0,0,61) and (1,0,96): r = 0.5 → ⌊0.5⌋ = 0, b = 78.5 → 78
  assert.deepEqual([f[36], f[37], f[38]], [0, 0, 78]);
  assert.deepEqual([f[765], f[766], f[767]], [255, 255, 255 * 0 + f[767]]);
  assert.equal(f[765], 255); assert.equal(f[766], 255); assert.ok(f[767] >= 223 && f[767] <= 255);
  // Ice: entry 0 = control 0 = (0, 156, 140); entry 8 = (0, 165, 147)
  const ic = IJLuts.get('Ice');
  assert.deepEqual([ic[0], ic[1], ic[2]], [0, 156, 140]);
  assert.deepEqual([ic[24], ic[25], ic[26]], [0, 165, 147]);
  // Spectrum: hue i/255 — 0 red, 85 → h=2 → (0,255,0), 170 → h=4 → (0,0,255)
  const sp = IJLuts.get('Spectrum');
  assert.deepEqual([sp[0], sp[1], sp[2]], [255, 0, 0]);
  assert.deepEqual([sp[85 * 3], sp[85 * 3 + 1], sp[85 * 3 + 2]], [0, 255, 0]);
  assert.deepEqual([sp[170 * 3], sp[170 * 3 + 1], sp[170 * 3 + 2]], [0, 0, 255]);
  assert.deepEqual([sp[765], sp[766], sp[767]], [255, 0, 0]);
  // 16 Colors: Fiji luts/16_colors.lut byte for byte — 15 flat bands of 16 levels,
  // band 13 (entries 208..223) a blue ramp at r = 245, g = 0.
  const s16 = IJLuts.get('16 Colors');
  const flat = [[0, 0, 0], [1, 1, 171], [1, 1, 224], [0, 110, 255], [1, 171, 254], [1, 224, 254], [1, 254, 1], [190, 255, 0],
    [255, 255, 0], [255, 224, 0], [255, 141, 0], [250, 94, 0], [245, 0, 0], null, [222, 180, 222], [255, 255, 255]];
  const ramp13 = [135, 141, 147, 153, 160, 166, 172, 178, 185, 191, 197, 203, 210, 216, 222, 228];
  for (let k = 0; k < 16; k++) for (let j = 0; j < 16; j++) {
    const i = k * 16 + j;
    assert.deepEqual([s16[i * 3], s16[i * 3 + 1], s16[i * 3 + 2]], k === 13 ? [245, 0, ramp13[j]] : flat[k], `16 Colors entry ${i}`);
  }
  assert.deepEqual([s16[0], s16[1], s16[2]], [0, 0, 0]);
  assert.deepEqual([s16[765], s16[766], s16[767]], [255, 255, 255]);
  // HiLo: blue at 0, red at 255, grey between
  const hl = IJLuts.get('HiLo');
  assert.deepEqual([hl[0], hl[1], hl[2]], [0, 0, 255]);
  assert.deepEqual([hl[765], hl[766], hl[767]], [255, 0, 0]);
  assert.deepEqual([hl[3 * 100], hl[3 * 100 + 1], hl[3 * 100 + 2]], [100, 100, 100]);
  // copies, colour ramps, errors
  const a = IJLuts.get('Fire'); a[0] = 99;
  assert.equal(IJLuts.get('Fire')[0], 0);
  const fc = IJLuts.fromColor('#ff8000');
  assert.deepEqual([fc[255 * 3], fc[255 * 3 + 1], fc[255 * 3 + 2]], [255, 128, 0]);
  assert.deepEqual([fc[0], fc[1], fc[2]], [0, 0, 0]);
  assert.deepEqual(arr(IJLuts.fromColor('#ffffff')), arr(IJLuts.get('Grays')));
  assert.deepEqual(arr(IJLuts.get('#ff0000')), arr(IJLuts.get('Red')));
  assert.equal(IJLuts.forColor('#00FF00'), 'Green'); assert.equal(IJLuts.forColor('#ffffff'), 'Grays'); assert.equal(IJLuts.forColor('#123456'), '#123456');
  throwsCode(() => IJLuts.get('Nope'), 'IJ_BAD_LUT'); throwsCode(() => IJLuts.fromColor('red'), 'IJ_BAD_COLOR');
  // identify is the inverse of get
  assert.deepEqual(IJLuts.identify(IJLuts.get('Fire')), { lut: 'Fire', invert: false });
  const rev = new Uint8Array(768); const fire = IJLuts.get('Fire');
  for (let i = 0; i < 256; i++) for (let k = 0; k < 3; k++) rev[i * 3 + k] = fire[(255 - i) * 3 + k];
  assert.deepEqual(IJLuts.identify(rev), { lut: 'Fire', invert: true });
  assert.deepEqual(IJLuts.identify(IJLuts.fromColor('#336699')), { lut: '#336699', invert: false });
  {
    // LUT.createLutFromColor truncates: (int)(i · c/255)
    const t = IJLuts.fromColor('#c80000');
    assert.equal(t[1 * 3], 0, 'level 1 of colour 200 is 0, not 1');
    assert.equal(t[255 * 3], 200);
    assert.equal(t[128 * 3], Math.floor(128 * (200 / 255)));
    assert.deepEqual(Array.from(IJLuts.fromColor('#ffffff')), Array.from(IJLuts.get('Grays')));
  }
});

// ------------------------------------------------------------------ IJRoi
function polyLen(p) { let l = 0; for (let i = 0; i < p.length; i++) { const q = p[(i + 1) % p.length]; l += Math.hypot(q[0] - p[i][0], q[1] - p[i][1]); } return l; }
test('IJRoi masks, areas, perimeters', () => {
  const r = { type: 'rect', x: 1, y: 2, w: 3, h: 2 };
  assert.deepEqual(IJRoi.bounds(r), { x: 1, y: 2, w: 3, h: 2 });
  assert.equal(IJRoi.area(r), 6);
  const m = IJRoi.mask(r, 10, 10);
  assert.deepEqual([m.x, m.y, m.w, m.h], [1, 2, 3, 2]);
  assert.deepEqual(arr(m.data), [1, 1, 1, 1, 1, 1]);
  // clipped by the image
  const mc = IJRoi.mask({ type: 'rect', x: -1, y: 0, w: 3, h: 1 }, 5, 5);
  assert.deepEqual([mc.x, mc.w, mc.h], [0, 2, 1]);
  const mo = IJRoi.mask({ type: 'rect', x: 20, y: 0, w: 3, h: 1 }, 5, 5);
  assert.equal(mo.w, 0);
  assert.equal(IJRoi.perimeter(r), 10);

  // oval 4×4: the four corner pixels have their centre outside → 12 pixels
  const ov = { type: 'oval', x: 0, y: 0, w: 4, h: 4 };
  const mv = IJRoi.mask(ov, 4, 4);
  assert.deepEqual(arr(mv.data), [0, 1, 1, 0, 1, 1, 1, 1, 1, 1, 1, 1, 0, 1, 1, 0]);
  assert.equal(IJRoi.area(ov), 12);
  near(IJRoi.perimeter(ov), 4 * Math.PI, 1e-12, 'Ramanujan on a circle is exact');
  near(IJRoi.perimeter({ type: 'oval', x: 0, y: 0, w: 10, h: 4 }), Math.PI * (3 * 7 - Math.sqrt((15 + 2) * (5 + 6))), 1e-12);
  assert.equal(IJRoi.mask({ type: 'oval', x: 3, y: 3, w: 1, h: 1 }, 10, 10).data[0], 1);

  // polygon: right triangle (0,0)(4,0)(0,4): pixel centres with x+y ≤ 2 → 6
  const tri = { type: 'polygon', points: [[0, 0], [4, 0], [0, 4]] };
  const mt = IJRoi.mask(tri, 4, 4);
  assert.deepEqual(arr(mt.data), [1, 1, 1, 0, 1, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0]);
  assert.equal(IJRoi.area(tri), 6);
  near(IJRoi.perimeter(tri), 8 + 4 * Math.SQRT2, 1e-12);
  // a rectangle drawn as polygon fills every pixel (left/top inclusive, right/bottom exclusive)
  assert.equal(IJRoi.area({ type: 'polygon', points: [[0, 0], [3, 0], [3, 2], [0, 2]] }), 6);
  // concave (even-odd) polygon: a "U"
  const U = { type: 'polygon', points: [[0, 0], [3, 0], [3, 3], [2, 3], [2, 1], [1, 1], [1, 3], [0, 3]] };
  assert.deepEqual(arr(IJRoi.mask(U, 3, 3).data), [1, 1, 1, 1, 0, 1, 1, 0, 1]);
  assert.ok(IJRoi.contains(U, 0.5, 2.5)); assert.ok(!IJRoi.contains(U, 1.5, 2.5));

  // traced perimeter (ImageJ): a single pixel outline = 4 − 2(2 − √2); a 2×2 square = 4√2
  near(IJRoi.tracedPerimeter([[0, 0], [1, 0], [1, 1], [0, 1]]), 4 - 2 * (2 - Math.SQRT2), 1e-12);
  near(IJRoi.tracedPerimeter([[0, 0], [2, 0], [2, 2], [0, 2]]), 4 * Math.SQRT2, 1e-12);
  near(IJRoi.perimeter({ type: 'polygon', traced: true, points: [[0, 0], [1, 0], [1, 1], [0, 1]] }), 2.8284271247461903, 1e-12);
  // an integer rectilinear polygon is `traced` for ImageJ (Roi.isTraced): corner correction applies
  near(IJRoi.perimeter({ type: 'polygon', points: [[0, 0], [3, 0], [3, 2], [0, 2]] }), 10 - 4 * (2 - Math.SQRT2), 1e-12);
  near(IJRoi.perimeter({ type: 'polygon', points: [[0, 0], [3, 0], [0.5, 2], [0, 2]] }), polyLen([[0, 0], [3, 0], [0.5, 2], [0, 2]]), 1e-12);
  near(IJRoi.perimeter({ type: 'polygon', points: [[0, 0], [3, 0], [3, 2]] }), 5 + Math.hypot(3, 2), 1e-12);
  assert.equal(IJRoi.tracedPerimeter([[0, 0], [1, 0], [1, 1]]), 0, 'fewer than 4 vertices → 0');
  // non-square pixels: Σ|dx|·pw + Σ|dy|·ph − nCorners·((pw + ph) − √(pw² + ph²))
  near(IJRoi.tracedPerimeter([[0, 0], [1, 0], [1, 1], [0, 1]], 1, 2), 1 + 2 + 1 + 2 - 2 * (3 - Math.sqrt(5)), 1e-12);
  // freehand: ImageJ getSmoothedPerimeter = open smoothed line (first / middle / last segments) + raw closing segment
  const fh = [[0, 0], [2, 0], [2, 2], [0, 2]];
  const k3 = Math.hypot(4 / 3, 2 / 3);
  near(IJRoi.perimeter({ type: 'freehand', points: fh }), k3 + 2 / 3 + k3 + 2, 1e-12);
  {
    const circle = []; for (let i = 0; i < 40; i++) circle.push([50 + 30 * Math.cos(i * Math.PI / 20), 50 + 30 * Math.sin(i * Math.PI / 20)]);
    const P = circle, n = P.length;
    let L = Math.hypot((P[0][0] + P[1][0] + P[2][0]) / 3 - P[0][0], (P[0][1] + P[1][1] + P[2][1]) / 3 - P[0][1]);
    for (let i = 1; i <= n - 3; i++) L += Math.hypot((P[i + 2][0] - P[i - 1][0]) / 3, (P[i + 2][1] - P[i - 1][1]) / 3);
    L += Math.hypot(P[n - 1][0] - (P[n - 3][0] + P[n - 2][0] + P[n - 1][0]) / 3, P[n - 1][1] - (P[n - 3][1] + P[n - 2][1] + P[n - 1][1]) / 3);
    L += Math.hypot(P[n - 1][0] - P[0][0], P[n - 1][1] - P[0][1]);
    near(IJRoi.perimeter({ type: 'freehand', points: circle }), L, 1e-9, 'smoothed freehand of a 40-gon');
  }

  // line
  const ln = { type: 'line', x1: 0, y1: 0, x2: 3, y2: 4, width: 1 };
  near(IJRoi.lineLength(ln), 5); near(IJRoi.lineLength(ln, { pixelWidth: 2, pixelHeight: 1 }), Math.hypot(6, 4));
  near(IJRoi.lineAngle({ type: 'line', x1: 0, y1: 0, x2: 1, y2: 1 }), -45);
  near(IJRoi.lineAngle({ type: 'line', x1: 0, y1: 1, x2: 1, y2: 0 }), 45);
  near(IJRoi.lineAngle({ type: 'line', x1: 1, y1: 0, x2: 0, y2: 0 }), 180);
  assert.equal(IJRoi.perimeter(ln), 5); assert.equal(IJRoi.area(ln), 0); assert.equal(IJRoi.isArea(ln), false);
  // a horizontal line 3 px long, width 1, from the left edge of pixel 0 to the right edge of pixel 2, at y=0.5 → 3 pixels
  const hline = IJRoi.mask({ type: 'line', x1: 0, y1: 0.5, x2: 3, y2: 0.5, width: 1 }, 5, 5);
  assert.deepEqual([hline.x, hline.y, hline.w, hline.h], [0, 0, 3, 1]);
  assert.deepEqual(arr(hline.data), [1, 1, 1]);

  // point
  const pt = { type: 'point', points: [[1.5, 0.2], [3.9, 2.1]] };
  assert.deepEqual(IJRoi.bounds(pt), { x: 1, y: 0, w: 3, h: 3 });
  const mp = IJRoi.mask(pt, 5, 5);
  assert.equal(arr(mp.data).reduce((a, b) => a + b, 0), 2);
  assert.equal(mp.data[0 * 3 + 0], 1); assert.equal(mp.data[2 * 3 + 2], 1);
  assert.equal(IJRoi.area(pt), 0);

  // contains
  assert.ok(IJRoi.contains(r, 1, 2)); assert.ok(!IJRoi.contains(r, 4, 2));
  assert.ok(IJRoi.contains(ov, 2, 2)); assert.ok(!IJRoi.contains(ov, 0.1, 0.1));
  assert.ok(IJRoi.contains(tri, 1, 1)); assert.ok(!IJRoi.contains(tri, 3, 3));

  // validate
  assert.equal(IJRoi.validate(r), true);
  for (const bad of [null, { type: 'blob' }, { type: 'rect', x: 0, y: 0, w: -1, h: 1 }, { type: 'polygon', points: [[0, 0], [1, 1]] },
    { type: 'line', x1: 0, y1: 0, x2: NaN, y2: 0 }, { type: 'mask', x: 0, y: 0, w: 2, h: 2, rle: [1, 1] }, { type: 'point', points: [] }]) {
    throwsCode(() => IJRoi.validate(bad), 'IJ_BAD_ROI');
  }
});

test('IJRoi mask ROIs: RLE, fromMask, inverse, translate', () => {
  // image 3×2, set pixels (1,0) (2,0) (2,1)
  const full = Uint8Array.from([0, 1, 1, 0, 0, 1]);
  const mr = IJRoi.fromMask(full, 3, 2);
  assert.deepEqual([mr.type, mr.x, mr.y, mr.w, mr.h], ['mask', 1, 0, 2, 2]);
  assert.deepEqual(mr.rle, [0, 2, 1, 1]);
  assert.equal(IJRoi.area(mr), 3);
  assert.deepEqual(arr(IJRoi.mask(mr, 3, 2).data), [1, 1, 0, 1]);
  assert.deepEqual(IJRoi.bounds(mr), { x: 1, y: 0, w: 2, h: 2 });
  assert.ok(IJRoi.contains(mr, 2.5, 1.5)); assert.ok(!IJRoi.contains(mr, 1.5, 1.5));
  assert.equal(IJRoi.validate(mr), true);
  assert.deepEqual(IJRoi.rleEncode(Uint8Array.from([1, 1, 0, 1])), [0, 2, 1, 1]);
  assert.deepEqual(IJRoi.rleEncode(Uint8Array.from([0, 0, 0])), [3]);
  const empty = IJRoi.fromMask(new Uint8Array(6), 3, 2);
  assert.deepEqual([empty.w, empty.h, empty.rle.length], [0, 0, 0]);
  assert.equal(IJRoi.validate(empty), true); assert.equal(IJRoi.area(empty), 0);
  // inverse of a 1×1 rect in a 2×2 image = the other three pixels
  const inv = IJRoi.inverse({ type: 'rect', x: 0, y: 0, w: 1, h: 1 }, 2, 2);
  assert.equal(IJRoi.area(inv), 3);
  assert.deepEqual(arr(IJRoi.mask(inv, 2, 2).data), [0, 1, 1, 1]);
  assert.deepEqual([inv.x, inv.y, inv.w, inv.h], [0, 0, 2, 2]);
  // mask clipped to a smaller image
  const clipped = IJRoi.mask(mr, 2, 2);
  assert.deepEqual([clipped.x, clipped.w, clipped.h], [1, 1, 2]);
  assert.deepEqual(arr(clipped.data), [1, 0]);
  // translate
  const t = IJRoi.translate(mr, 3, 4);
  assert.deepEqual([t.x, t.y], [4, 4]);
  assert.deepEqual(IJRoi.translate({ type: 'polygon', points: [[0, 0], [1, 0], [1, 1]] }, 2, 1).points, [[2, 1], [3, 1], [3, 2]]);
  const tl = IJRoi.translate({ type: 'line', x1: 0, y1: 0, x2: 1, y2: 1, width: 2 }, 1, 2);
  assert.deepEqual([tl.x1, tl.y1, tl.x2, tl.y2, tl.width], [1, 2, 2, 3, 2]);
});

// ------------------------------------------------------------------ IJOps
test('IJOps.statistics', () => {
  const c = ch(2, 2, 8, [10, 20, 30, 40]);
  const s = IJOps.statistics(c, null);
  assert.equal(s.n, 4); assert.equal(s.area, 4); assert.equal(s.mean, 25);
  near(s.stdDev, Math.sqrt(500 / 3), 1e-12);
  assert.equal(s.min, 10); assert.equal(s.max, 40);
  assert.equal(s.median, 30, 'ImageJ cumulative rule: first value whose count exceeds n/2');
  assert.equal(s.mode, 10, 'lowest value on ties');
  assert.equal(s.intDen, 100); assert.equal(s.rawIntDen, 100);
  near(s.xCentroid, 1); near(s.yCentroid, 1);
  near(s.xCenterOfMass, 1.1); near(s.yCenterOfMass, 1.2);
  near(s.skewness, 0, 1e-12); near(s.kurtosis, -1.36, 1e-12);
  // calibration
  const sc = IJOps.statistics(c, null, { calibration: { pixelWidth: 0.5, pixelHeight: 0.25 } });
  near(sc.area, 0.5); near(sc.intDen, 12.5); near(sc.xCentroid, 0.5); near(sc.yCentroid, 0.25); near(sc.xCenterOfMass, 0.55);
  assert.equal(sc.rawIntDen, 100);
  // mask: right column (20, 40)
  const mb = IJRoi.mask({ type: 'rect', x: 1, y: 0, w: 1, h: 2 }, 2, 2);
  const sm = IJOps.statistics(c, mb);
  assert.equal(sm.n, 2); assert.equal(sm.mean, 30); near(sm.stdDev, Math.sqrt(200)); assert.equal(sm.median, 40); near(sm.xCentroid, 1.5);
  // single pixel: sd 0; constant: skew/kurtosis NaN
  assert.equal(IJOps.statistics(ch(1, 1, 8, [7]), null).stdDev, 0);
  assert.ok(Number.isNaN(IJOps.statistics(ch(2, 1, 8, [7, 7]), null).skewness));
  // mode with repeated value; odd-count median
  const m3 = IJOps.statistics(ch(3, 1, 8, [5, 9, 9]), null);
  assert.equal(m3.mode, 9); assert.equal(m3.median, 9);
  // 16-bit
  const s16 = IJOps.statistics(ch(2, 1, 16, [1000, 3000]), null);
  assert.equal(s16.mean, 2000); assert.equal(s16.median, 3000); assert.equal(s16.max, 3000);
  // 32-bit: NaN / Infinity left out
  const s32 = IJOps.statistics(ch(5, 1, 32, [1, 2, NaN, Infinity, 6]), null);
  assert.equal(s32.n, 3); assert.equal(s32.mean, 3); assert.equal(s32.min, 1); assert.equal(s32.max, 6); assert.equal(s32.median, 2, 'odd count 3: middle value');
  assert.equal(IJOps.statistics(ch(4, 1, 32, [1, 2, 4, 9]), null).median, 3, 'even count: FloatStatistics averages the two middle values');
  assert.equal(IJOps.statistics(ch(4, 1, 16, [1, 2, 4, 9]), null).median, 4, '16-bit keeps the cumulative-histogram rule');
  // 32-bit mode: 256 bins over [1,6], width 5/256; value 1 is in bin 0 (count 1), 2 in bin 51, 6 in bin 255 → first max = bin 0
  near(s32.mode, 1 + (5 / 256) / 2, 1e-9);
  // empty mask
  const se = IJOps.statistics(c, { x: 0, y: 0, w: 2, h: 2, data: new Uint8Array(4) });
  assert.equal(se.n, 0); assert.equal(se.area, 0); assert.ok(Number.isNaN(se.mean));
});

test('IJOps.histogram', () => {
  const h8 = IJOps.histogram(ch(2, 2, 8, [0, 0, 255, 7]), null);
  assert.equal(h8.counts.length, 256); assert.equal(h8.counts[0], 2); assert.equal(h8.counts[255], 1); assert.equal(h8.counts[7], 1);
  assert.equal(h8.binWidth, 1); assert.equal(h8.min, 0); assert.equal(h8.max, 255);
  // 16-bit: values 0..3 into 2 bins over [0,3] → scale 2/4
  const h16 = IJOps.histogram(ch(4, 1, 16, [0, 1, 2, 3]), null, { bins: 2 });
  assert.deepEqual(arr(h16.counts), [2, 2]); assert.equal(h16.binWidth, 2); assert.equal(h16.min, 0); assert.equal(h16.max, 3);
  // 16-bit default range = data min..max in the mask, 256 bins
  const h16b = IJOps.histogram(ch(3, 1, 16, [100, 100, 355]), null);
  assert.equal(h16b.min, 100); assert.equal(h16b.max, 355); assert.equal(h16b.counts[0], 2); assert.equal(h16b.counts[255], 1); assert.equal(h16b.binWidth, 1);
  // 32-bit: [0,1] into 4 bins, top value in the last bin
  const h32 = IJOps.histogram(ch(5, 1, 32, [0, 0.3, 0.6, 1, NaN]), null, { bins: 4 });
  assert.deepEqual(arr(h32.counts), [1, 1, 1, 1]); assert.equal(h32.binWidth, 0.25);
  // explicit range drops outsiders; mask restricts
  const hr = IJOps.histogram(ch(4, 1, 16, [0, 5, 10, 20]), null, { bins: 3, min: 5, max: 10 });
  assert.deepEqual(arr(hr.counts), [1, 0, 1]); // 5 → bin 0 (width 2), 10 → bin ⌊5·3/6⌋ = 2
  const hm = IJOps.histogram(ch(2, 1, 8, [1, 2]), { x: 1, y: 0, w: 1, h: 1, data: Uint8Array.from([1]) });
  assert.equal(hm.counts[2], 1); assert.equal(hm.counts[1], 0);
});

test('IJOps.autoContrast (ImageJ ContrastAdjuster)', () => {
  const hist = new Uint32Array(256);
  hist[50] = 500; hist[100] = 1000; hist[200] = 500; // pixelCount 10000 → limit 1000, threshold 2
  let a = IJOps.autoContrast(hist, 10000, 0);
  assert.deepEqual([a.min, a.max, a.nextAutoThreshold], [50, 200, 5000]);
  a = IJOps.autoContrast(hist, 10000, a.nextAutoThreshold); // 2500 → threshold 4
  assert.deepEqual([a.min, a.max, a.nextAutoThreshold], [50, 200, 2500]);
  // counts above the limit are ignored: a 5000 spike at 0 and 255 does not stretch the range
  const h2 = new Uint32Array(256); h2[0] = 5000; h2[255] = 5000; h2[80] = 300; h2[160] = 300;
  a = IJOps.autoContrast(h2, 10600, 0);
  assert.deepEqual([a.min, a.max], [80, 160]);
  // halving until < 10 resets to 5000
  assert.equal(IJOps.autoContrast(hist, 10000, 15).nextAutoThreshold, 7);
  assert.equal(IJOps.autoContrast(hist, 10000, 7).nextAutoThreshold, 5000);
  assert.equal(IJOps.autoContrast(hist, 10000, 5000).nextAutoThreshold, 2500);
  // one qualifying bin → min == max → data range
  const h3 = new Uint32Array(256); h3[100] = 500;
  a = IJOps.autoContrast(h3, 10000, 0, { dataMin: 3, dataMax: 240 });
  assert.deepEqual([a.min, a.max], [3, 240]);
  // nothing qualifies (threshold too high) → data range
  a = IJOps.autoContrast(new Uint32Array(256), 10000, 0, { dataMin: 1, dataMax: 9 });
  assert.deepEqual([a.min, a.max], [1, 9]);
  // histogram scaled bins: min = histMin + bin·binWidth
  a = IJOps.autoContrast(hist, 10000, 0, { histMin: 1000, binWidth: 4 });
  assert.deepEqual([a.min, a.max], [1200, 1800]);
});

test('IJOps.applyLut / convert / invert', () => {
  const a8 = IJOps.applyLut(ch(5, 1, 8, [40, 50, 100, 149, 150]), 50, 149);
  // ContrastAdjuster.apply: v ≤ min → 0, v ≥ max → 255, else (int)((v − min)/(max − min)·256)
  assert.deepEqual(arr(a8.data), [0, 0, 129, 255, 255]);
  assert.deepEqual(arr(IJOps.applyLut(ch(4, 1, 8, [50, 51, 60, 100]), 50.9, 100.9).data), [0, 5, 51, 255], 'min / max are truncated to integers first');
  assert.equal(IJOps.applyLut(ch(2, 1, 8, [10, 11]), 10, 10).data[1], 255, 'max === min: everything above is 255');
  assert.deepEqual(arr(IJOps.applyLut(ch(3, 1, 8, [0, 100, 255]), 0, 255).data), [0, 100, 255], 'full range is the identity');
  const a16 = IJOps.applyLut(ch(5, 1, 16, [50, 100, 150, 200, 900]), 100, 200);
  assert.deepEqual(arr(a16.data), [0, 0, 32768, 65535, 65535]);
  throwsCode(() => IJOps.applyLut(ch(1, 1, 32, [1]), 0, 1), 'IJ_NOT_32BIT');

  // up-conversion keeps values
  const up = IJOps.convert(ch(2, 1, 8, [3, 250]), 16);
  assert.equal(up.bitDepth, 16); assert.deepEqual(arr(up.data), [3, 250]);
  assert.equal(IJOps.convert(ch(1, 1, 16, [65535]), 32).data[0], 65535);
  // 16 → 8
  assert.deepEqual(arr(IJOps.convert(ch(3, 1, 16, [0, 255, 1000]), 8, { min: 0, max: 255 }).data), [0, 255, 255]);
  assert.deepEqual(arr(IJOps.convert(ch(4, 1, 16, [99, 100, 227, 355]), 8, { min: 100, max: 355 }).data), [0, 0, 127, 255]);
  assert.deepEqual(arr(IJOps.convert(ch(2, 1, 16, [10, 1000]), 8, { scale: false }).data), [10, 255]);
  // default range = data range: [100, 355] on [100,355]
  assert.deepEqual(arr(IJOps.convert(ch(2, 1, 16, [100, 355]), 8).data), [0, 255]);
  // 32 → 8, NaN → 0
  assert.deepEqual(arr(IJOps.convert(ch(5, 1, 32, [0, 0.5, 1, NaN, 2]), 8, { min: 0, max: 1 }).data), [0, 128, 255, 0, 255]);
  assert.deepEqual(arr(IJOps.convert(ch(3, 1, 32, [-1, 0.5, 1]), 16, { min: 0, max: 1 }).data), [0, 32768, 65535]);
  assert.deepEqual(arr(IJOps.convert(ch(2, 1, 32, [2.4, 300.6]), 8, { scale: false }).data), [2, 255]);
  assert.equal(IJOps.convert(ch(1, 1, 8, [5]), 8).data[0], 5);

  assert.deepEqual(arr(IJOps.invert(ch(3, 1, 8, [0, 255, 100])).data), [255, 0, 155]);
  assert.deepEqual(arr(IJOps.invert(ch(2, 1, 16, [0, 65000])).data), [65000, 0], '16-bit inverts about the data range, not 65535');
  assert.deepEqual(arr(IJOps.invert(ch(3, 1, 16, [100, 500, 900])).data), [900, 500, 100]);
  assert.deepEqual(arr(IJOps.invert(ch(3, 1, 32, [1, 2, 4]), { min: 0, max: 10 }).data), [9, 8, 6], '32-bit uses the display range when given');
  assert.deepEqual(arr(IJOps.invert(ch(3, 1, 32, [1, 2, 4])).data), [4, 3, 1]);
});

test('IJOps.math / fill / clear / clearOutside', () => {
  const base = ch(2, 1, 8, [10, 200]);
  const run = (op, v, mb) => arr(IJOps.math(base, op, v, mb).data);
  assert.deepEqual(run('add', 100), [110, 255]);
  assert.deepEqual(run('subtract', 20), [0, 180]);
  assert.deepEqual(run('multiply', 1.5), [15, 255]);
  assert.deepEqual(run('divide', 3), [3, 67]);
  assert.deepEqual(run('divide', 0), [10, 200], 'ImageMath: divide by 0 is a no-op on 8/16-bit');
  // the operand of add / subtract / min / max / set is truncated, (int)value
  assert.deepEqual(run('add', 2.7), [12, 202]);
  assert.deepEqual(run('subtract', 2.7), [8, 198]);
  assert.deepEqual(arr(IJOps.math(ch(2, 1, 8, [5, 200]), 'min', 10.6).data), [10, 200]);
  assert.deepEqual(arr(IJOps.math(ch(2, 1, 8, [5, 200]), 'max', 99.9).data), [5, 99]);
  assert.deepEqual(run('set', 7.9), [7, 7]);
  assert.deepEqual(run('min', 50), [50, 200]);
  assert.deepEqual(run('max', 50), [10, 50]);
  assert.deepEqual(run('abs'), [10, 200]);
  assert.deepEqual(run('set', 7.4), [7, 7]);
  assert.deepEqual(run('add', 5, { x: 0, y: 0, w: 1, h: 1, data: Uint8Array.from([1]) }), [15, 200], 'outside the mask is untouched');
  assert.deepEqual(arr(base.data), [10, 200], 'input is not modified');
  assert.deepEqual(arr(IJOps.math(ch(2, 1, 16, [10, 65000]), 'divide', 0).data), [10, 65000]);
  assert.deepEqual(arr(IJOps.math(ch(2, 1, 16, [10, 65000]), 'add', 1000).data), [1010, 65535]);
  const f = IJOps.math(ch(3, 1, 32, [-2, 1.5, 4]), 'multiply', 0.5);
  assert.deepEqual(arr(f.data), [-1, 0.75, 2]);
  assert.deepEqual(arr(IJOps.math(ch(2, 1, 32, [-2, 1]), 'abs').data), [2, 1]);
  assert.deepEqual(arr(IJOps.math(ch(2, 1, 32, [-2, 0]), 'divide', 0).data), [-Infinity, NaN]);
  throwsCode(() => IJOps.math(base, 'pow', 2), 'IJ_BAD_OP');

  const img = ch(3, 2, 8, [1, 2, 3, 4, 5, 6]);
  const mid = IJRoi.mask({ type: 'rect', x: 1, y: 0, w: 1, h: 2 }, 3, 2);
  assert.deepEqual(arr(IJOps.fill(img, mid, 9).data), [1, 9, 3, 4, 9, 6]);
  assert.deepEqual(arr(IJOps.fill(img, mid, 9.9).data), [1, 9, 3, 4, 9, 6], 'setValue truncates');
  assert.deepEqual(arr(IJOps.fill(img, null, 300).data), [255, 255, 255, 255, 255, 255]);
  assert.deepEqual(arr(IJOps.clear(img, mid, 0).data), [1, 0, 3, 4, 0, 6]);
  assert.deepEqual(arr(IJOps.clearOutside(img, mid, 0).data), [0, 2, 0, 0, 5, 0]);
  assert.deepEqual(arr(IJOps.clearOutside(img, null, 0).data), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(arr(IJOps.fill(ch(2, 1, 32, [1, 2]), null, 0.25).data), [0.25, 0.25]);
  assert.deepEqual(arr(img.data), [1, 2, 3, 4, 5, 6]);
});

test('IJOps geometry: crop / flips / rotate90', () => {
  const g = ch(3, 2, 8, [1, 2, 3, 4, 5, 6]);
  const c = IJOps.crop(g, 1, 0, 2, 2);
  assert.deepEqual([c.width, c.height], [2, 2]); assert.deepEqual(arr(c.data), [2, 3, 5, 6]);
  const cc = IJOps.crop(g, -1, 1, 3, 5); // clipped to x 0..2, y 1..1
  assert.deepEqual([cc.width, cc.height], [2, 1]); assert.deepEqual(arr(cc.data), [4, 5]);
  throwsCode(() => IJOps.crop(g, 5, 5, 2, 2), 'IJ_BAD_ROI');
  assert.deepEqual(arr(IJOps.flipH(g).data), [3, 2, 1, 6, 5, 4]);
  assert.deepEqual(arr(IJOps.flipV(g).data), [4, 5, 6, 1, 2, 3]);
  const r = IJOps.rotate90(g, 'right');
  assert.deepEqual([r.width, r.height], [2, 3]); assert.deepEqual(arr(r.data), [4, 1, 5, 2, 6, 3]);
  const l = IJOps.rotate90(g, 'left');
  assert.deepEqual([l.width, l.height], [2, 3]); assert.deepEqual(arr(l.data), [3, 6, 2, 5, 1, 4]);
  assert.deepEqual(arr(IJOps.rotate90(r, 'left').data), arr(g.data), 'right then left is the identity');
  const f = IJOps.flipH(ch(2, 1, 32, [0.5, -1]));
  assert.deepEqual(arr(f.data), [-1, 0.5]); assert.equal(f.bitDepth, 32);
  throwsCode(() => IJOps.rotate90(g, 'up'), 'IJ_BAD_OP');
});

test('IJOps.profile / downsample2', () => {
  const row = ch(4, 1, 8, [0, 10, 20, 30]);
  let p = IJOps.profile(row, { x1: 0, y1: 0, x2: 3, y2: 0 }, 1);
  assert.deepEqual(arr(p.values), [0, 10, 20, 30]); assert.equal(p.step, 1);
  // ImageJ samples at the raw coordinates (no half-pixel shift).
  // length 1.5 → n = round(1.5) = 2 → 3 samples, spacing .75, at image x = 0, .75, 1.5
  p = IJOps.profile(row, { x1: 0, y1: 0, x2: 1.5, y2: 0 }, 1);
  assert.deepEqual(arr(p.values).map((v) => +v.toFixed(9)), [0, 7.5, 15]); near(p.step, 0.75);
  const sq = ch(2, 2, 8, [0, 10, 20, 30]);
  p = IJOps.profile(sq, { x1: 0, y1: 0, x2: 1, y2: 1 }, 1);
  assert.equal(p.values.length, 2); near(p.step, Math.SQRT2); near(p.values[0], 0); near(p.values[1], 30);
  // bilinear centre between the four pixels: (0+10+20+30)/4 = 15
  p = IJOps.profile(sq, { x1: 0.5, y1: 0.5, x2: 0.5, y2: 0.5 }, 1);
  assert.equal(p.values.length, 1); near(p.values[0], 15); assert.equal(p.step, 0);
  // width 3 averages across the line (offsets −1, 0, +1; clamped at the edge)
  const col = ch(3, 3, 8, [0, 0, 0, 30, 30, 30, 60, 60, 60]);
  p = IJOps.profile(col, { x1: 0, y1: 1, x2: 2, y2: 1 }, 3);
  assert.deepEqual(arr(p.values), [30, 30, 30]); // (0 + 30 + 60)/3
  p = IJOps.profile(col, { x1: 0, y1: 0, x2: 2, y2: 0 }, 3);
  near(p.values[0], (0 + 0 + 30) / 3); // offsets −1 (clamped to row 0), 0, +1

  const d = IJOps.downsample2(ch(3, 1, 8, [0, 10, 20]));
  assert.deepEqual([d.width, d.height], [2, 1]); assert.deepEqual(arr(d.data), [5, 20]);
  assert.deepEqual(arr(IJOps.downsample2(ch(2, 2, 8, [1, 2, 2, 2])).data), [2]);
  assert.deepEqual(arr(IJOps.downsample2(ch(2, 2, 8, [1, 1, 1, 2])).data), [1]);
  assert.deepEqual(arr(IJOps.downsample2(ch(2, 2, 16, [1000, 1001, 1001, 1001])).data), [1001]);
  assert.deepEqual(arr(IJOps.downsample2(ch(2, 2, 32, [1, 2, 2, 2])).data), [1.75]);
  const odd = IJOps.downsample2(ch(3, 3, 8, [1, 1, 5, 1, 1, 5, 9, 9, 9]));
  assert.deepEqual([odd.width, odd.height], [2, 2]); assert.deepEqual(arr(odd.data), [1, 5, 9, 9]);
});

// ------------------------------------------------------------------ IJProject
function planes(W, H, depth, fn) {
  const out = [];
  for (let z = 0; z < depth; z++) { const p = new Uint8Array(W * H); for (let i = 0; i < W * H; i++) p[i] = fn(z, i); out.push(p); }
  return out;
}
function feed(proj, ps, W, H, order, bandRows, zChunk, channel = 0) {
  // blocks (band × z-chunk) in the given order
  const blocks = [];
  for (let y0 = 0; y0 < H; y0 += bandRows) {
    const rows = Math.min(bandRows, H - y0);
    for (let z0 = 0; z0 < ps.length; z0 += zChunk) blocks.push({ y0, rows, z0, d: Math.min(zChunk, ps.length - z0) });
  }
  order(blocks);
  for (const b of blocks) {
    const data = new Uint8Array(b.d * b.rows * W);
    for (let z = 0; z < b.d; z++) data.set(ps[b.z0 + z].subarray(b.y0 * W, (b.y0 + b.rows) * W), z * b.rows * W);
    proj.addBlock({ channel, y0: b.y0, rows: b.rows, z0: b.z0, depth: b.d, data });
  }
}

test('IJProject: ImageJ ZProjector bit depths (inputBitDepth: 8)', () => {
  const W = 2, H = 2;
  const ps = [Uint8Array.from([1, 2, 3, 4]), Uint8Array.from([5, 0, 3, 8]), Uint8Array.from([2, 2, 9, 1])];
  const run = (method, depth, planes) => {
    const pr = IJProject.create({ method, width: W, height: H, depth, channels: 1, inputBitDepth: 8 });
    feed(pr, planes || ps, W, H, () => {}, 2, 3);
    return pr.finish()[0];
  };
  assert.equal(IJProject.outputBitDepth('max', 3, 8), 8);
  assert.equal(IJProject.outputBitDepth('min', 3, 16), 16);
  assert.equal(IJProject.outputBitDepth('avg', 3, 8), 8);
  assert.equal(IJProject.outputBitDepth('median', 3, 8), 8);
  assert.equal(IJProject.outputBitDepth('median', 3, 16), 32);
  assert.equal(IJProject.outputBitDepth('sum', 3, 8), 32, 'sum is always a float image in ZProjector');
  assert.equal(IJProject.outputBitDepth('sd', 3, 8), 32);
  const av = run('avg', 3);
  assert.equal(av.bitDepth, 8); assert.ok(av.data instanceof Uint8Array);
  // (int)(mean + 0.5): 8/3 → 3, 4/3 → 1, 5 → 5, 13/3 → 4
  assert.deepEqual(arr(av.data), [3, 1, 5, 4]);
  const sm = run('sum', 3); assert.equal(sm.bitDepth, 32); assert.deepEqual(arr(sm.data), [8, 4, 15, 13]);
  const md = run('median', 3); assert.equal(md.bitDepth, 8); assert.deepEqual(arr(md.data), [2, 2, 3, 4]);
  // even depth: mean of the two middle values, then rounded half up for the 8-bit result
  const ev = [[1], [2], [4], [6]].map((a) => Uint8Array.from(a));
  const pe = IJProject.create({ method: 'median', width: 1, height: 1, depth: 4, channels: 1, inputBitDepth: 8 });
  feed(pe, ev, 1, 1, () => {}, 1, 4);
  assert.equal(pe.finish()[0].data[0], 3); // (2+4)/2
  const po = IJProject.create({ method: 'median', width: 1, height: 1, depth: 4, channels: 1, inputBitDepth: 8 });
  feed(po, [[1], [2], [3], [6]].map((a) => Uint8Array.from(a)), 1, 1, () => {}, 1, 4);
  assert.equal(po.finish()[0].data[0], 3); // (2+3)/2 = 2.5 → 3
  assert.equal(IJProject.estimateBytes({ method: 'sum', width: 100, height: 20, depth: 10, channels: 1, inputBitDepth: 8 }), 100 * 20 * 4 + 20 * 100 * 4);
  assert.equal(IJProject.estimateBytes({ method: 'avg', width: 100, height: 20, depth: 10, channels: 1, inputBitDepth: 8 }), 100 * 20 * 1 + 20 * 100 * 4);
});

test('IJProject: six methods, hand values', () => {
  const W = 2, H = 2;
  const ps = [Uint8Array.from([1, 2, 3, 4]), Uint8Array.from([5, 0, 3, 8]), Uint8Array.from([2, 2, 9, 1])];
  const run = (method) => {
    const pr = IJProject.create({ method, width: W, height: H, depth: 3, channels: 1 });
    feed(pr, ps, W, H, () => {}, 2, 3);
    assert.equal(pr.progress(), 1);
    return pr.finish()[0];
  };
  const mx = run('max'); assert.equal(mx.bitDepth, 8); assert.deepEqual(arr(mx.data), [5, 2, 9, 8]);
  const mn = run('min'); assert.equal(mn.bitDepth, 8); assert.deepEqual(arr(mn.data), [1, 0, 3, 1]);
  const sm = run('sum'); assert.equal(sm.bitDepth, 16); assert.ok(sm.data instanceof Uint16Array); assert.deepEqual(arr(sm.data), [8, 4, 15, 13]);
  const av = run('avg'); assert.equal(av.bitDepth, 32);
  [8 / 3, 4 / 3, 5, 13 / 3].forEach((v, i) => near(av.data[i], v, 1e-6));
  const sd = run('sd'); assert.equal(sd.bitDepth, 32);
  // pixel 0 = {1,5,2}: mean 8/3, Σ(x−mean)² = 26/3 → sample variance 13/3
  near(sd.data[0], Math.sqrt(13 / 3), 1e-6);
  near(sd.data[2], Math.sqrt(12), 1e-6); // {3,3,9}: mean 5, Σ = 4+4+16 = 24 → /2 = 12
  const md = run('median'); assert.equal(md.bitDepth, 32); assert.deepEqual(arr(md.data), [2, 2, 3, 4]);
  // even depth: mean of the two middle values
  const pe = IJProject.create({ method: 'median', width: 1, height: 1, depth: 4, channels: 1 });
  feed(pe, [[1], [9], [4], [6]].map((a) => Uint8Array.from(a)), 1, 1, () => {}, 1, 4);
  assert.equal(pe.finish()[0].data[0], 5); // sorted 1,4,6,9 → (4+6)/2
  const p1 = IJProject.create({ method: 'sd', width: 1, height: 1, depth: 1, channels: 1 });
  feed(p1, [Uint8Array.from([7])], 1, 1, () => {}, 1, 1);
  assert.equal(p1.finish()[0].data[0], 0);
});

test('IJProject: band and z order independence, several channels', () => {
  const W = 5, H = 7, D = 9;
  const ps = planes(W, H, D, (z, i) => (z * 37 + i * 11 + (z * i) % 13) & 255);
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } };
  for (const method of ['max', 'min', 'sum', 'avg', 'sd', 'median']) {
    const ref = IJProject.create({ method, width: W, height: H, depth: D, channels: 1 });
    feed(ref, ps, W, H, () => {}, H, D);
    const want = ref.finish()[0];
    const got = IJProject.create({ method, width: W, height: H, depth: D, channels: 2 });
    feed(got, ps, W, H, shuffle, 3, 4, 0);
    assert.ok(got.progress() > 0.49 && got.progress() < 0.51, 'half done after channel 0');
    feed(got, ps, W, H, shuffle, 3, 2, 1);
    const [c0, c1] = got.finish();
    assert.deepEqual(arr(c0.data), arr(want.data), method + ' channel 0');
    assert.deepEqual(arr(c1.data), arr(want.data), method + ' channel 1');
  }
  // sum of 257 planes of 255 is exactly 65535 in 16 bits; 258 planes switch to 32 bits
  assert.equal(IJProject.outputBitDepth('sum', 257), 16); assert.equal(IJProject.outputBitDepth('sum', 258), 32);
  assert.equal(IJProject.outputBitDepth('max', 500), 8); assert.equal(IJProject.outputBitDepth('median', 3), 32);
  const full = IJProject.create({ method: 'sum', width: 1, height: 1, depth: 257, channels: 1 });
  feed(full, planes(1, 1, 257, () => 255), 1, 1, () => {}, 1, 64);
  const r = full.finish()[0]; assert.equal(r.bitDepth, 16); assert.equal(r.data[0], 65535);
  const big = IJProject.create({ method: 'sum', width: 1, height: 1, depth: 258, channels: 1 });
  feed(big, planes(1, 1, 258, () => 255), 1, 1, () => {}, 1, 100);
  const rb = big.finish()[0]; assert.equal(rb.bitDepth, 32); assert.ok(rb.data instanceof Float32Array); assert.equal(rb.data[0], 65790);
});

test('IJProject: errors and estimate', () => {
  const pr = IJProject.create({ method: 'max', width: 2, height: 2, depth: 2, channels: 1 });
  pr.addBlock({ channel: 0, y0: 0, rows: 2, z0: 0, depth: 1, data: new Uint8Array(4) });
  throwsCode(() => pr.finish(), 'IJ_INCOMPLETE');
  throwsCode(() => pr.addBlock({ channel: 0, y0: 0, rows: 2, z0: 0, depth: 1, data: new Uint8Array(4) }), 'IJ_BAD_BLOCK');
  throwsCode(() => pr.addBlock({ channel: 1, y0: 0, rows: 2, z0: 1, depth: 1, data: new Uint8Array(4) }), 'IJ_BAD_BLOCK');
  throwsCode(() => pr.addBlock({ channel: 0, y0: 0, rows: 2, z0: 1, depth: 1, data: new Uint8Array(3) }), 'IJ_BAD_BLOCK');
  throwsCode(() => pr.addBlock({ channel: 0, y0: 1, rows: 1, z0: 1, depth: 1, data: new Uint8Array(2) }), 'IJ_BAD_BLOCK'); // overlaps band 0:2
  pr.addBlock({ channel: 0, y0: 0, rows: 2, z0: 1, depth: 1, data: Uint8Array.from([9, 0, 0, 0]) });
  assert.deepEqual(arr(pr.finish()[0].data), [9, 0, 0, 0]);
  throwsCode(() => pr.addBlock({ channel: 0, y0: 0, rows: 2, z0: 0, depth: 1, data: new Uint8Array(4) }), 'IJ_BAD_BLOCK'); // band already complete
  throwsCode(() => IJProject.create({ method: 'mode', width: 1, height: 1, depth: 1, channels: 1 }), 'IJ_BAD_OP');
  throwsCode(() => IJProject.create({ method: 'max', width: 0, height: 1, depth: 1, channels: 1 }), 'IJ_BAD_SIZE');
  // estimate = outputs + one band of accumulators
  assert.equal(IJProject.estimateBytes({ method: 'max', width: 100, height: 200, depth: 10, channels: 2, bandRows: 64 }), 2 * 100 * 200 + 2 * 64 * 100);
  assert.equal(IJProject.estimateBytes({ method: 'median', width: 100, height: 200, depth: 10, channels: 1, bandRows: 64 }), 100 * 200 * 4 + 64 * 100 * 10);
  assert.equal(IJProject.estimateBytes({ method: 'sum', width: 100, height: 20, depth: 10, channels: 1 }), 100 * 20 * 2 + 20 * 100 * 4);
  assert.ok(pr.estimateBytes() > 0);
});

console.log('test_ij_core: ' + passed + ' groups passed');
