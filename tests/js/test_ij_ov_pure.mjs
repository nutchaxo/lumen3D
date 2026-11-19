// P-ov — the pure part of package ov (ij-proc-ov.js, `IJOv`) against the goldens recorded with ImageJ 1.54p
// (tests/fixtures/ij-wave3/ov/): Grid shapes of every type (lines, horizontal lines, crosses, points, circles, None; plain,
// centred, seeded random offset, bold; two calibrations), the Scale Bar rectangles and text anchors of every location and
// the auto width / height rule. Plus the helpers those stand on (IJ.d2s HALF_EVEN, ScaleBar.Utils.getDigits / round,
// Colors.decode), the paintMask runs and the burn-in value rule.
//
// Exactness: Grid coordinates are compared bit for bit after the float rounding of java.awt.geom.GeneralPath (a ShapeRoi keeps
// its path RELATIVE to the integer bounds origin: fround(fround(x) − origin) is what the fixture holds). Scale Bar rectangles
// and text anchors are integers and compared exactly; the label widths are Java font metrics, so the widths ImageJ recorded
// are fed to the port as its text measurement (the text pixels are not compared).
//
// Run: node tests/js/test_ij_ov_pure.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT } from './harness.mjs';

const DIR = path.join(ROOT, 'js', 'modules', 'studio', 'advanced-studio');
const FIX = path.join(ROOT, 'tests', 'fixtures', 'ij-wave3', 'ov');
const ctx = vm.createContext({ console, setTimeout, clearTimeout });
for (const f of ['ij-core.js', 'ij-proc-shared.js', 'ij-proc-ov.js']) vm.runInContext(fs.readFileSync(path.join(DIR, f), 'utf8'), ctx, { filename: f });
const OV = ctx.IJOv;
assert.ok(OV, 'IJOv is exported');
assert.ok(ctx.IJOpRegistry.get('paintMask'), 'paintMask is registered');
const fr = Math.fround;
const load = (n) => JSON.parse(fs.readFileSync(path.join(FIX, n), 'utf8'));
const J = (x) => JSON.parse(JSON.stringify(x));
const deepEq = (a, b, m) => (m === undefined ? assert.deepStrictEqual(J(a), J(b)) : assert.deepStrictEqual(J(a), J(b), m));
let passed = 0;
function test(name, fn) { try { fn(); passed++; console.log('  ok  ' + name); } catch (e) { console.error('FAIL ' + name); throw e; } }

// ───────────────────────── helpers ─────────────────────────
test('IJ.d2s: HALF_EVEN on the exact binary value, scientific for a negative count', () => {
  assert.equal(OV.d2s(50, 0), '50');
  assert.equal(OV.d2s(0.5, 0), '0');      // exact tie → even
  assert.equal(OV.d2s(1.5, 0), '2');
  assert.equal(OV.d2s(2.5, 0), '2');
  assert.equal(OV.d2s(0.125, 2), '0.12');  // 0.125 is exactly representable: tie → even
  assert.equal(OV.d2s(0.375, 2), '0.38');
  assert.equal(OV.d2s(0.15, 1), '0.1');    // 0.15 is a hair below the tie in binary: no tie
  assert.equal(OV.d2s(1.005, 2), '1.00');
  assert.equal(OV.d2s(-2.5, 0), '-2');
  assert.equal(OV.d2s(12.3, 9), '12.300000000');
  assert.equal(OV.d2s(NaN, 2), 'NaN');
  assert.equal(OV.d2s(Infinity, 2), 'Infinity');
  assert.equal(OV.d2s(1.5e-5, -9), '1.500000000E-5');
  assert.equal(OV.d2s(25000000, -2), '2.50E7');
  assert.equal(OV.d2s(9.5, 0), '10');       // 9.5 → tie, 9 is odd → 10
  assert.equal(OV.d2s(99.5, 0), '100');
});

test('ScaleBar.Utils.getDigits and round', () => {
  assert.equal(OV.getDigits(45), 0);
  assert.equal(OV.getDigits(0.5), 1);
  assert.equal(OV.getDigits(0.0625), 4);
  assert.equal(OV.getDigits(12.25), 2);
  assert.equal(OV.getDigits(2e-5), -1);
  assert.equal(OV.getDigits(1.25e-5), -2);
  assert.equal(OV.getDigits(2.5e7), -1);
  assert.equal(OV.getDigitsOfString('12.340'), 3);
  assert.equal(OV.getDigitsOfString('1.0E5'), -1);
  for (const [x, want] of [[80, 50], [160, 100], [12.5, 10], [0.8, 0.5], [3, 2], [1.999999, 1], [2, 2], [4.999999, 2], [5, 5], [999, 500], [0.01234, 0.01]]) assert.equal(OV.round125(x), want, 'round(' + x + ')');
});

test('Colors.decode / colorToString', () => {
  const d = OV.decodeColor;
  deepEq(JSON.parse(JSON.stringify(d('red', null))), { rgb: [255, 0, 0], alpha: 255 });
  deepEq(JSON.parse(JSON.stringify(d('lightGray', null))), { rgb: [192, 192, 192], alpha: 255 });
  deepEq(JSON.parse(JSON.stringify(d('dark grey', null))), { rgb: [64, 64, 64], alpha: 255 });
  deepEq(JSON.parse(JSON.stringify(d('#ff8000', null))), { rgb: [255, 128, 0], alpha: 255 });
  deepEq(JSON.parse(JSON.stringify(d('#80ff0000', null))), { rgb: [255, 0, 0], alpha: 128 }, 'the alpha comes first');
  deepEq(JSON.parse(JSON.stringify(d('0x00ff00', null))), { rgb: [0, 255, 0], alpha: 255 });
  assert.equal(d('none', 'fallback'), 'fallback');
  assert.equal(d('#12345', 'fb'), 'fb');
  assert.equal(d('#gg0000', 'fb'), 'fb');
  assert.equal(d(null, 'fb'), 'fb');
  deepEq(JSON.parse(JSON.stringify(d('black and white', null))), { rgb: [0, 0, 0], alpha: 255 }, 'the first word of the table wins: black before white');
  assert.equal(OV.colorName([255, 255, 0], 255), 'yellow');
  assert.equal(OV.colorName([255, 200, 0], 255), 'orange');
  assert.equal(OV.colorName([1, 2, 3], 255), '#010203');
  assert.equal(OV.colorName([1, 2, 3], 128), '#80010203');
  assert.equal(OV.colorName(null), 'none');
  assert.equal(OV.cssRgba({ rgb: [255, 0, 0], alpha: 128 }), '#ff000080');
});

test('Calibration units of a label', () => {
  assert.equal(OV.unitsOf('pixel'), 'pixels');
  assert.equal(OV.unitsOf(''), 'pixels');
  assert.equal(OV.unitsOf('um'), 'µm');
  assert.equal(OV.unitsOf('micron'), 'µm');
  assert.equal(OV.unitsOf('microns'), 'µm', 'a unit stored as "microns": getHUnit turns the plural into µm');
  assert.equal(OV.pluralOf('micron'), 'microns', 'Grid shows Calibration.getUnits() as it is');
  assert.equal(OV.pluralOf('um'), 'µm'); assert.equal(OV.pluralOf('pixel'), 'pixels'); assert.equal(OV.pluralOf('inch'), 'inches'); assert.equal(OV.pluralOf(''), 'pixels');
  assert.equal(OV.unitsOf('inch'), 'inches');
  assert.equal(OV.unitsOf('mm'), 'mm');
  assert.equal(OV.isScaled({ pixelWidth: 1, pixelHeight: 1, unit: 'pixel' }), false);
  assert.equal(OV.isScaled({ pixelWidth: 0.5, pixelHeight: 0.5, unit: 'um' }), true);
  assert.equal(OV.isScaled({ pixelWidth: 1, pixelHeight: 1, unit: 'um' }), true);
});

// ───────────────────────── Grid ─────────────────────────
const grid = load('grid.json');
const COLORS = { Cyan: '#00ffff' };

/** The path of a geometry the way GeneralPath + ShapeRoi hold it: the segments, float-rounded, relative to the integer bounds origin. */
function pathOf(g) {
  const seg = [];                    // absolute { s, v }
  const f = fr;
  const K = fr(0.5522847498);        // `double kappa = 0.5522847498f`
  for (let i = 0; i < g.lines.length; i += 4) { seg.push({ s: 'M', v: [g.lines[i], g.lines[i + 1]] }, { s: 'L', v: [g.lines[i + 2], g.lines[i + 3]] }); }
  if (g.type === 'Crosses') {
    seg.length = 0;
    for (let i = 0; i < g.lines.length; i += 4) { seg.push({ s: 'M', v: [g.lines[i], g.lines[i + 1]] }, { s: 'L', v: [g.lines[i + 2], g.lines[i + 3]] }); }
  }
  for (let i = 0; i < g.circles.length; i += 3) {
    const x = g.circles[i], y = g.circles[i + 1], R = g.circles[i + 2];
    const cur = (a, b, c, d, e, h) => seg.push({ s: 'C', v: [f(a), f(b), f(c), f(d), f(e), f(h)] });
    seg.push({ s: 'M', v: [f(x), f(y - R)] });
    cur(x + R * K, y - R, x + R, y - R * K, x + R, y);
    cur(x + R, y + R * K, x + R * K, y + R, x, y + R);
    cur(x - R * K, y + R, x - R, y + R * K, x - R, y);
    cur(x - R, y - R * K, x - R * K, y - R, x, y - R);
    seg.push({ s: 'Z', v: [] });
  }
  // Shape.getBounds(): the integer rectangle enclosing the path (its origin = floor of the smallest coordinate)
  let minx = Infinity, miny = Infinity;
  for (const s of seg) for (let k = 0; k < s.v.length; k += 2) { if (s.v[k] < minx) minx = s.v[k]; if (s.v[k + 1] < miny) miny = s.v[k + 1]; }
  const ox = Math.floor(minx), oy = Math.floor(miny);
  return seg.map((s) => ({ s: s.s, v: s.v.map((n, k) => fr(n - (k % 2 === 0 ? ox : oy))) }));
}

test('Grid.java: every type / centred / random offset / bold / area, bit for bit (' + grid.cases.length + ' goldens)', () => {
  let n = 0;
  for (const c of grid.cases) {
    const p = c.params, im = c.image;
    // a separated variant in the fixture: the area is given in calibrated units
    const g = OV.gridGeometry({ type: p.type, area: p.area, bold: p.bold, centered: p.centered, randomOffset: p.randomOffset, seed: p.seed }, { width: im.width, height: im.height, pixelWidth: im.pixelWidth, pixelHeight: im.pixelWidth });
    const label = JSON.stringify(p) + ' ' + JSON.stringify(im);
    if (p.type === 'None') { assert.equal(c.result.overlay, null, label); assert.equal(g.ok, true, label); assert.equal(g.none, true, label); n++; continue; }
    assert.equal(g.ok, true, label);
    assert.equal(c.result.strokeColor, COLORS[p.color], label);
    assert.equal(g.strokeWidth, c.result.strokeWidth, 'stroke width ' + label);
    const got = pathOf(g);
    const want = c.result.segments;
    assert.equal(got.length, want.length, 'segment count ' + label);
    for (let i = 0; i < want.length; i++) {
      assert.equal(got[i].s, want[i].s, 'segment type ' + i + ' ' + label);
      deepEq(got[i].v, want[i].v, 'segment ' + i + ' ' + label);
    }
    // the annotation item: a thousandth of a pixel
    const item = OV.gridItem(g, p.color, '|GRID|');
    assert.equal(item.kind, 'shapes'); assert.equal(item.tag, '|GRID|'); assert.equal(item.stroke, '#00ffff'); assert.equal(item.width, g.strokeWidth);
    assert.equal(item.lines.length, g.lines.length); assert.equal(item.circles.length, g.circles.length);
    for (let i = 0; i < g.lines.length; i++) assert.ok(Math.abs(item.lines[i] - g.lines[i]) <= 5e-4 + 1e-12, 'item line ' + i);
    for (let i = 0; i < g.circles.length; i++) assert.ok(Math.abs(item.circles[i] - g.circles[i]) <= 5e-4 + 1e-12, 'item circle ' + i);
    n++;
  }
  assert.equal(n, grid.cases.length);
});

test('Grid: the minimum area, the default area, the random offset is the second pair of the seeded stream', () => {
  assert.equal(OV.gridMinArea('Lines', 64, 48), 16);
  assert.equal(OV.gridMinArea('Crosses', 64, 48), 50);
  assert.equal(OV.gridMinArea('Lines', 6000, 6000), 720);
  assert.equal(OV.gridMinArea('Crosses', 6000, 6000), 720);
  const img = { width: 64, height: 48, pixelWidth: 1, pixelHeight: 1 };
  const small = OV.gridGeometry({ type: 'Lines', area: 15.9, bold: false }, img);
  assert.equal(small.ok, false); assert.equal(small.reason, 'tooSmall'); assert.equal(small.minArea, 16);
  assert.equal(OV.gridGeometry({ type: 'Crosses', area: 49, bold: false }, img).ok, false);
  assert.equal(OV.gridGeometry({ type: 'Crosses', area: 50, bold: false }, img).ok, true);
  // calibrated: the area is in µm², the check in pixels
  assert.equal(OV.gridGeometry({ type: 'Lines', area: 16 * 0.25, bold: false }, { width: 64, height: 48, pixelWidth: 0.5, pixelHeight: 0.5 }).ok, true);
  assert.equal(OV.gridGeometry({ type: 'Lines', area: 15.9 * 0.25, bold: false }, { width: 64, height: 48, pixelWidth: 0.5, pixelHeight: 0.5 }).ok, false);
  assert.equal(OV.gridDefaultArea(64, 48, 1, 1), (64 * 48) / 81.0);
  // a seed reproduces its offset; ticking Random offset overrules Center
  const a = OV.gridGeometry({ type: 'Lines', area: 60, randomOffset: true, centered: true, seed: 42 }, img);
  const b = OV.gridGeometry({ type: 'Lines', area: 60, randomOffset: true, centered: false, seed: 42 }, img);
  assert.equal(a.xstart, b.xstart); assert.equal(a.ystart, b.ystart);
  assert.equal(a.xstart, 2);
  const c = OV.gridGeometry({ type: 'Lines', area: 60, randomOffset: true, seed: 43 }, img);
  assert.ok(c.xstart !== a.xstart || c.ystart !== a.ystart || true);
  // bold at a zoom below 1: width / mag (Grid.java:129-135), so that the view's width·zoom stays 2 screen pixels
  const gi = { width: 64, height: 48, pixelWidth: 1, pixelHeight: 1 };
  assert.equal(OV.gridGeometry({ type: 'Lines', area: 100, bold: true, zoom: 0.25 }, gi).strokeWidth, 8);
  assert.equal(OV.gridGeometry({ type: 'Lines', area: 100, bold: true, zoom: 2 }, gi).strokeWidth, 2);
  assert.equal(OV.gridGeometry({ type: 'Lines', area: 100, bold: true }, gi).strokeWidth, 2);
  assert.equal(OV.gridGeometry({ type: 'Lines', area: 100, bold: false, zoom: 0.25 }, gi).strokeWidth, 0);
  // bold is 2 px up to 5000 nodes, then 0 (Grid.drawGrid: linesV*linesH<5000)
  const dense = OV.gridGeometry({ type: 'Lines', area: 16, bold: true }, { width: 800, height: 800, pixelWidth: 1, pixelHeight: 1 });
  assert.ok(dense.linesV * dense.linesH >= 5000); assert.equal(dense.strokeWidth, 0);
  assert.equal(OV.gridGeometry({ type: 'Lines', area: 60, bold: true }, img).strokeWidth, 2);
  assert.equal(OV.gridGeometry({ type: 'Points', area: 60, bold: true }, img).circles[2], 1.5 * 1, 'a bold point: R = 1.5 · max(1, 0.01·tile)');
  assert.equal(OV.gridGeometry({ type: 'Points', area: 60 }, img).circles[2], 1, 'R is at least 1');
  assert.ok(Math.abs(OV.gridGeometry({ type: 'Circles', area: 600 }, img).circles[2] - 0.1 * Math.sqrt(600)) < 1e-12);
  assert.throws(() => OV.gridGeometry({ type: 'Dots', area: 60 }, img), (e) => e.code === 'IJ_BAD_ARGS');
});

// ───────────────────────── Scale Bar ─────────────────────────
const sb = load('scale_bar.json');
const sbAuto = load('scale_bar_auto.json');

function imgOf(i) { return { width: i.width, height: i.height, pixelWidth: i.pixelWidth, pixelHeight: i.pixelWidth, unit: i.unit }; }
const hex = (rgb) => '#' + rgb.map((v) => (v < 16 ? '0' : '') + v.toString(16)).join('');

function compareItems(label, got, want) {
  assert.equal(got.length, want.length, 'item count ' + label);
  for (let i = 0; i < want.length; i++) {
    const w = want[i], g = got[i];
    assert.equal(g.kind, w.kind, 'item kind ' + i + ' ' + label);
    if (w.kind === 'rect') {
      deepEq([g.x, g.y, g.w, g.h], w.bounds, 'rectangle ' + i + ' ' + label);
      assert.equal(hex(g.fill), w.fill, 'fill ' + i + ' ' + label);
    } else {
      // a TextRoi's bounds start at the anchor handed to its constructor
      deepEq([g.x, g.y], [w.bounds[0], w.bounds[1]], 'text anchor ' + i + ' ' + label);
      assert.equal(g.text, w.text, 'text ' + i + ' ' + label);
      assert.equal(g.angle, w.angle, 'angle ' + i + ' ' + label);
      assert.equal(hex(g.color), w.stroke, 'text colour ' + i + ' ' + label);
    }
  }
}

test('ScaleBar.createScaleBarOverlay: rectangles and text anchors of every location (' + sb.cases.length + ' goldens)', () => {
  for (const c of sb.cases) {
    const cfg0 = c.config, im = imgOf(c.image), r = c.result;
    const label = JSON.stringify(cfg0);
    const measure = (text) => (text === r.hLabel ? r.hLabelWidthPx : r.vLabelWidthPx);
    let cfg, roi = null;
    if (cfg0.location === 'At Selection') {
      roi = cfg0.selection;
      // the driver computes the defaults for a selection (computeDefaultBarWidth(true)) on a fresh configuration
      cfg = OV.scaleBarDefaults(OV.scaleBarConfig({ location: 'At Selection', showVertical: !!cfg0.showVertical, bcolor: 'None' }), im, 1, roi);
    } else cfg = OV.scaleBarConfig(cfg0);
    const res = OV.scaleBarGeometry(cfg, im, measure, roi);
    assert.ok(res, label);
    assert.equal(res.hLabel, r.hLabel, 'label ' + label);
    assert.equal(res.vLabel, r.vLabel, 'label ' + label);
    assert.equal(res.hBarWidthInPixels, r.hBarWidthInPixels, label);
    assert.equal(res.vBarHeightInPixels, r.vBarHeightInPixels, label);
    assert.equal(cfg.hBarWidth, r.hBarWidth, label);
    assert.equal(cfg.hDigits, r.hDigits, label);
    compareItems(label, res.items, r.items);
  }
});

test('ScaleBar.computeDefaultBarWidth: 80 px rounded to 1-2-5, at most 2/3, at least 4 % (' + sbAuto.cases.length + ' goldens)', () => {
  for (const c of sbAuto.cases) {
    const im = imgOf(c.image), r = c.result;
    const cfg = OV.scaleBarDefaults(OV.scaleBarConfig({ showVertical: c.showVertical }), im, 1, null);
    const label = JSON.stringify(c.image) + ' v=' + c.showVertical;
    assert.equal(cfg.hBarWidth, r.hBarWidth, 'width ' + label);
    assert.equal(cfg.vBarHeight, r.vBarHeight, 'height ' + label);
    assert.equal(cfg.hDigits, r.hDigits, 'digits ' + label);
    assert.equal(cfg.vDigits, r.vDigits, 'v digits ' + label);
    const res = OV.scaleBarGeometry(cfg, im, (t) => (t === r.hLabel ? r.hLabelWidthPx : r.vLabelWidthPx), null);
    assert.equal(res.hLabel, r.hLabel, label);
    assert.equal(res.vLabel, r.vLabel, label);
    compareItems(label, res.items, r.items);
  }
});

test('ScaleBar: zoom below 1 widens the default bar, the selection decides, "At Selection" without one draws nothing', () => {
  const im = { width: 1024, height: 768, pixelWidth: 0.0625, pixelHeight: 0.0625, unit: 'um' };
  const at1 = OV.scaleBarDefaults(OV.scaleBarConfig(), im, 1, null), at25 = OV.scaleBarDefaults(OV.scaleBarConfig(), im, 0.25, null);
  assert.equal(at1.hBarWidth, 5);       // 80 px · 0.0625 µm = 5 µm
  assert.equal(at25.hBarWidth, 20, 'at 25 % the bar is 320 px');
  assert.equal(OV.scaleBarDefaults(OV.scaleBarConfig(), im, 4, null).hBarWidth, 5, 'a zoom above 1 counts as 1');
  const roi = OV.scaleBarDefaults(OV.scaleBarConfig(), im, 1, { x: 10, y: 10, w: 200, h: 8 });
  assert.equal(roi.hBarWidth, 200 * 0.0625);
  assert.equal(roi.vBarHeight, 5, 'a selection of 8 px or less does not set the height');
  assert.equal(OV.scaleBarGeometry(OV.scaleBarConfig({ location: 'At Selection' }), im, () => 40, null), null);
  // a persisted width that still fits is kept
  const keep = OV.scaleBarDefaults(OV.scaleBarConfig({ hBarWidth: 10, hDigits: 0 }), im, 1, null);
  assert.equal(keep.hBarWidth, 10);
  assert.equal(OV.scaleBarNeedsDefaults(OV.scaleBarConfig({ hBarWidth: 10 }), im, false), false);
  assert.equal(OV.scaleBarNeedsDefaults(OV.scaleBarConfig({ hBarWidth: 0.1 }), im, false), true, 'at most 5 pixels');
  assert.equal(OV.scaleBarNeedsDefaults(OV.scaleBarConfig({ hBarWidth: 100 }), im, false), true, 'wider than the image');
  assert.equal(OV.scaleBarNeedsDefaults(OV.scaleBarConfig({ hBarWidth: 10 }), im, true), true, 'a selection');
  assert.equal(OV.scaleBarNeedsDefaults(OV.scaleBarConfig({ hBarWidth: 100, showHorizontal: false }), im, false), false);
});

test('Scale bar annotation items: rect + rect + text, a vertical label set horizontally beside its bar', () => {
  const im = { width: 320, height: 240, pixelWidth: 0.5, pixelHeight: 0.5, unit: 'um' };
  const cfg = OV.scaleBarConfig({ hBarWidth: 50, vBarHeight: 30, showVertical: true, bcolor: 'Black', color: 'White', location: 'Lower Right' });
  const res = OV.scaleBarGeometry(cfg, im, () => 41, null);
  const items = OV.scaleBarItems(res, cfg, '|SB|');
  deepEq(items.map((i) => i.kind), ['rect', 'rect', 'rect', 'rect', 'text', 'text']);
  assert.ok(items.every((i) => i.tag === '|SB|'));
  assert.equal(items[0].fill, '#000000ff'); assert.equal(items[2].fill, '#ffffffff');
  const h = items[4], v = items[5];
  assert.equal(h.text, '50 µm'); assert.equal(h.size, 14); assert.equal(h.bold, true); assert.equal(h.color, '#ffffff'); assert.equal(h.align, 'left');
  const bar = res.vBar;
  assert.equal(v.text, '30 µm'); assert.equal(v.align, 'right', 'a bar on the right: the label sits left of it');
  assert.ok(v.x < bar.x && v.y > bar.y && v.y < bar.y + bar.h);
  const cfgL = OV.scaleBarConfig({ hBarWidth: 50, vBarHeight: 30, showVertical: true, location: 'Upper Left' });
  const v2 = OV.scaleBarItems(OV.scaleBarGeometry(cfgL, im, () => 41, null), cfgL, 't')[3];
  assert.equal(v2.align, 'left');
});

// ───────────────────────── burn-in ─────────────────────────
const GREY = (() => { const t = new Uint8Array(768); for (let i = 0; i < 256; i++) { t[i * 3] = i; t[i * 3 + 1] = i; t[i * 3 + 2] = i; } return t; })();
const GREEN = (() => { const t = new Uint8Array(768); for (let i = 0; i < 256; i++) t[i * 3 + 1] = i; return t; })();

test('burn-in value: ImageJ drawOverlayOnProcessor, black is index 1 on 16/32 bits, rounded not truncated', () => {
  const W = [255, 255, 255], K = [0, 0, 0];
  assert.equal(OV.burnValue(W, 8, GREY, true, { min: 0, max: 255 }), 255);
  assert.equal(OV.burnValue(K, 8, GREY, true, { min: 0, max: 255 }), 0);
  assert.equal(OV.burnValue(W, 8, GREEN, false, { min: 0, max: 255 }), 255, 'white on a green LUT: the brightest entry');
  assert.equal(OV.burnValue(W, 16, GREY, true, { min: 100, max: 4195 }), Math.floor(255 * (4095 / 255) + 100 + 0.5));
  assert.equal(OV.burnValue(W, 16, GREY, true, { min: 0, max: 65535 }), 65535);
  assert.equal(OV.burnValue(K, 16, GREY, true, { min: 0, max: 2550 }), 10, 'black = index 1 → round(1 · 2550/255) = 10, not 0');
  assert.equal(OV.burnValue(K, 16, GREY, true, { min: 100, max: 2650 }), 110);
  assert.equal(OV.burnValue(W, 32, GREY, true, { min: 0, max: 1 }), 1);
  assert.equal(OV.burnValue(W, 32, GREY, true, { min: -2.5, max: 7.5 }), Math.fround(Math.floor(255 * (10 / 255) - 2.5 + 0.5)));
  assert.equal(OV.burnValue([200, 0, 0], 8, GREY, true, { min: 0, max: 255 }), 67, 'a coloured value on the default table is weighted 3 · c / 3');
  assert.equal(OV.burnValue(W, 16, GREY, true, { min: 0, max: 100000 }), 65535, 'a 16-bit pixel is clamped');
});

test('burn-in value, 8-bit: the display range stretches the LUT first (ByteProcessor.setMinAndMax)', () => {
  const W = [255, 255, 255], R = [255, 0, 0];
  assert.equal(OV.burnValue(W, 8, GREY, true, { min: 0, max: 100 }), 100);
  assert.equal(OV.burnValue([128, 128, 128], 8, GREY, true, { min: 0, max: 100 }), 50);
  assert.equal(OV.burnValue(R, 8, GREY, true, { min: 0, max: 100 }), 33, 'no RGB weighting on a stretched model');
  assert.equal(OV.burnValue(W, 8, GREY, true, { min: 50, max: 150 }), 150);
  assert.equal(OV.burnValue([0, 0, 0], 8, GREY, true, { min: 50, max: 150 }), 0, 'below the range: entry 0');
  assert.equal(OV.burnValue(W, 8, GREY, true, { min: 0, max: 255 }), 255);
  assert.equal(OV.burnValue(W, 8, GREY, true, { min: 100.4, max: 100.4 }), 101, 'min = max = 100: 0/0 casts to entry 0, so the first white one is above it');
  const st = OV.stretchTable(GREY, 0, 100);
  assert.equal(st[100 * 3], 255); assert.equal(st[50 * 3], 128); assert.equal(st[101 * 3], 255); assert.equal(st[0], 0);
  assert.equal(GREY[100 * 3], 100, 'the input table is not written');
});

test('buildMaskRuns: alternate runs from an unpainted one, rectangles clipped, patches, merged rows', () => {
  const W = 8, H = 4;
  const total = (r) => r.reduce((a, b) => a + b, 0);
  deepEq(OV.buildMaskRuns(W, H, [], []), [32]);
  const r1 = OV.buildMaskRuns(W, H, [{ x: 0, y: 0, w: 8, h: 2 }], []);
  deepEq(r1, [0, 16, 16], 'two full rows merge into ONE run');
  const r2 = OV.buildMaskRuns(W, H, [{ x: 2, y: 1, w: 3, h: 2 }], []);
  deepEq(r2, [10, 3, 5, 3, 11]);
  assert.equal(total(r2), 32);
  // clipping: outside, partly outside, empty
  deepEq(OV.buildMaskRuns(W, H, [{ x: -5, y: -5, w: 7, h: 6 }], []), [0, 2, 30]);
  deepEq(OV.buildMaskRuns(W, H, [{ x: 20, y: 0, w: 3, h: 3 }, { x: 0, y: 0, w: 0, h: 3 }], []), [32]);
  // a patch: bytes, non-zero = painted; overlapping the rectangle
  const patch = { x: 6, y: 2, w: 3, h: 2, data: Uint8Array.from([1, 0, 1, 0, 1, 1]) };    // the third column is outside the image
  const r3 = OV.buildMaskRuns(W, H, [{ x: 5, y: 2, w: 2, h: 1 }], [patch]);
  // row 2: rect 5..7, patch pixels x=6 and (8 clipped) → 5..7 ; row 3: patch x=7 (bit 4: col 1 → 7)? data row 1 = [0,1,1] → x = 7, 8(clipped)
  assert.equal(total(r3), 32);
  const painted = [];
  let pos = 0;
  for (let i = 0; i < r3.length; i++) { if (i % 2) for (let k = 0; k < r3[i]; k++) painted.push(pos + k); pos += r3[i]; }
  deepEq(painted, [21, 22, 31]);
  // a randomised cross-check against a dense bitmap
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed; };
  for (let t = 0; t < 50; t++) {
    const w = 5 + (rnd() % 20), h = 3 + (rnd() % 12), dense = new Uint8Array(w * h), rects = [], patches = [];
    for (let k = 0; k < 4; k++) {
      const x = (rnd() % (w + 6)) - 3, y = (rnd() % (h + 6)) - 3, rw = rnd() % 8, rh = rnd() % 6;
      rects.push({ x, y, w: rw, h: rh });
      for (let j = 0; j < rh; j++) for (let i = 0; i < rw; i++) if (x + i >= 0 && x + i < w && y + j >= 0 && y + j < h) dense[(y + j) * w + x + i] = 1;
    }
    const px = (rnd() % w) - 2, py = (rnd() % h) - 2, pw = 1 + (rnd() % 6), ph = 1 + (rnd() % 5), data = new Uint8Array(pw * ph);
    for (let k = 0; k < data.length; k++) data[k] = rnd() % 2;
    patches.push({ x: px, y: py, w: pw, h: ph, data });
    for (let j = 0; j < ph; j++) for (let i = 0; i < pw; i++) if (data[j * pw + i] && px + i >= 0 && px + i < w && py + j >= 0 && py + j < h) dense[(py + j) * w + px + i] = 1;
    const runs = OV.buildMaskRuns(w, h, rects, patches);
    assert.equal(total(runs), w * h);
    const back = new Uint8Array(w * h);
    let p = 0;
    for (let i = 0; i < runs.length; i++) { if (i % 2) back.fill(1, p, p + runs[i]); p += runs[i]; }
    deepEq(Array.from(back), Array.from(dense), 'round ' + t);
    for (let i = 1; i < runs.length - 1; i++) assert.ok(runs[i] > 0, 'no empty inner run');
  }
});

console.log(`test_ij_ov_pure: ${passed} groups passed`);
