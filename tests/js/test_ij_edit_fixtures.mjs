// Package edit (wave 3) — the golden fixtures recorded with real ImageJ 1.54p (tests/fixtures/ij-wave3/edit/), compared with the pure part
// of ij-proc-edit.js through the registry operations the engine runs:
//   paste       every transfer mode of Edit > Paste Control on 8 / 16 / 32 bits, at five positions (inside, partly outside, flush), with an
//               oval mask, and the divide-by-zero values of Edit > Options > Misc. (`paste_u8|u16|f32.json`)
//   draw        Edit > Draw of eleven selection types at line widths 1, 2, 5 and two foreground values per bit depth (`draw.json`)
//   newImage    File > New > Image: every type x fill, Noise with seeds 1 and 42 (`new_image.json`)
//   montage     Image > Stacks > Make Montage of a composite: the rendered tiles, layouts, borders, scale 0.5 (`montage_u8|u16.json`)
//   LUTs        the built-in tables, the .lut file formats (NIH, raw 768, raw 970, text) (`builtin_luts.json`, `lut_files.json`)
//   Duplicate   the channel range rule (`duplicator_channels.json`)
//
// Exactness: integer outputs are compared exactly; 32-bit outputs bit for bit (the fixtures hold floats printed by Java: parsing them back
// with Math.fround is exact). Run: node tests/js/test_ij_edit_fixtures.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT } from './harness.mjs';

const DIR = path.join(ROOT, 'js', 'modules', 'studio', 'advanced-studio');
const FIX = path.join(ROOT, 'tests', 'fixtures', 'ij-wave3', 'edit');
const ctx = vm.createContext({ console, setTimeout, clearTimeout, TextEncoder, TextDecoder });
ctx.self = ctx;
for (const f of ['ij-core.js', 'ij-proc-shared.js', 'ij-proc-multi.js', 'ij-proc-geom.js', 'ij-proc-io.js', 'ij-proc-edit.js']) vm.runInContext(fs.readFileSync(path.join(DIR, f), 'utf8'), ctx, { filename: f });
const R = ctx.IJOpRegistry, E = ctx.IJEdit;
assert.ok(R.get('paste') && R.get('draw') && R.get('copyRegion') && R.get('montage'), 'the ops are registered');
assert.ok(R.getCommand('edit.newImage') && R.getCommand('edit.display'), 'the worker commands are registered');
const load = (n) => JSON.parse(fs.readFileSync(path.join(FIX, n + '.json'), 'utf8'));
const j = (x) => JSON.parse(JSON.stringify(x));
const fix = (v) => (v === null ? NaN : v);

function decodeData(d, bitDepth) {
  if (Array.isArray(d)) {
    const a = Float64Array.from(d, fix);
    return bitDepth === 8 ? Uint8Array.from(a) : bitDepth === 16 ? Uint16Array.from(a) : Float32Array.from(a);
  }
  const b = Buffer.from(d.b64, 'base64');
  const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  const t = d.dtype || (bitDepth === 8 ? 'u8' : bitDepth === 16 ? 'u16' : 'f32');
  return t === 'u8' ? new Uint8Array(ab) : t === 'u16' ? new Uint16Array(ab) : new Float32Array(ab);
}
const sameBits = (a, b, what) => {
  assert.equal(a.length, b.length, what + ' length');
  for (let i = 0; i < a.length; i++) {
    const x = a[i], y = b[i];
    // a whole float printed by the fixture writer through (long) loses the sign of -0.0: zero equals zero
    if (x === 0 && y === 0) continue;
    assert.ok(Object.is(x, y), what + ' differs at ' + i + ': ' + x + ' != ' + y);
  }
};
let n = 0;
async function test(name, fn) { await fn(); n++; console.log('  ok  ' + name); }

const noopIo = { tick: async () => {}, check() {}, reserve() {}, release() {}, transfer() {}, channel: 0, region: null, docIds: [] };
const ctxOf = (scale) => ({ scale: scale || 1, range: () => ({ min: 0, max: 0 }), dep: () => null, check() {}, tick: async () => {} });

// ───────────────────────────────────────── paste ─────────────────────────────────────────
for (const [file, bd] of [['paste_u8', 8], ['paste_u16', 16], ['paste_f32', 32]]) {
  await test('paste ' + bd + '-bit: every transfer mode, five positions, an oval mask, divide by zero values (' + file + ')', async () => {
    const f = load(file);
    const dst = decodeData(f.destination.data, bd), clip = decodeData(f.clipboard.data, bd);
    const W = f.destination.width, H = f.destination.height, cw = f.clipboard.width, ch = f.clipboard.height;
    const spec = R.get('paste');
    // the oval mask of ImageJ: OvalRoi(x, y, w, h).getMask()
    const ovalMask = E.ovalMask(cw, ch);
    let checked = 0;
    for (const c of f.cases) {
      const mode = c.params.mode.toLowerCase();
      const params = { data: clip, w: cw, h: ch, x: c.params.x, y: c.params.y, mode, mask: c.params.ovalMask ? ovalMask : null };
      if (bd === 32 && c.params.divideByZero !== null && c.params.divideByZero !== undefined && c.params.divideByZero !== 'Infinity') params.divZero = String(c.params.divideByZero);
      spec.validate(params, { width: W, height: H, bitDepth: bd, channels: 1 });
      const prep = spec.prepare({ width: W, height: H, bitDepth: bd }, 0, params, ctxOf(1));
      const res = await prep.region({ width: W, height: H, bitDepth: bd, data: dst }, { x: 0, y: 0, w: W, h: H });
      sameBits(res, decodeData(c.output.data, bd), file + ' ' + JSON.stringify(c.params));
      checked++;
    }
    assert.ok(checked >= 84);
  });
}

await test('paste: the divide-by-zero value of the fixture is what the Misc option reads ("Infinity" = IEEE, "NaN", "max", a number)', async () => {
  const f = load('paste_f32');
  const seen = new Set(f.cases.map((c) => c.params.divideByZero));
  assert.ok(seen.has('Infinity'));
  const M = ctx.IJMulti;
  assert.equal(M.parseDivZero('Infinity'), Infinity);
  assert.equal(M.parseDivZero('INFINITE'), Infinity);
  assert.ok(Number.isNaN(M.parseDivZero('nan')));
  assert.equal(M.parseDivZero('max'), 3.4028234663852886e38);
  assert.equal(M.parseDivZero(' -2.5f '), -2.5);
  assert.equal(M.parseDivZero('1e3'), 1000);
  assert.equal(M.parseDivZero('-Infinity'), -Infinity);
  assert.equal(M.parseDivZero('infinity!'), null);
  assert.equal(M.parseDivZero(''), null);
  assert.equal(M.parseDivZero('0x10'), null);
  assert.equal(M.parseDivZero('1,5'), null);
  for (const c of f.cases) if (c.params.divideByZero !== 'Infinity') assert.notEqual(M.parseDivZero(String(c.params.divideByZero)), null);
  assert.ok([...seen].some((v) => v !== 'Infinity'), 'the fixture holds other divide-by-zero values than +Infinity: ' + [...seen].join(' '));
});

await test('paste: a preview at level 2 reads the clipboard at the centre of each level pixel; the mask keeps the destination', async () => {
  const W = 16, H = 16;
  const dst = new Uint8Array(W * H).fill(50);
  const clip = new Uint8Array(8 * 8).fill(200);
  const mask = new Uint8Array(64); for (let i = 0; i < 64; i++) mask[i] = i % 8 < 4 ? 1 : 0;
  const spec = R.get('paste');
  const prep = spec.prepare({ width: W, height: H, bitDepth: 8 }, 0, { data: clip, w: 8, h: 8, x: 4, y: 4, mode: 'copy', mask }, ctxOf(2));
  // level 1 (scale 2): an 8 x 8 image; level pixel q covers image pixels [2q, 2q+2), its centre is 2q + 1
  const lvl = new Uint8Array(64).fill(50);
  const res = await prep.region({ width: 8, height: 8, bitDepth: 8, data: lvl }, { x: 0, y: 0, w: 8, h: 8 });
  // the clipboard covers image pixels 4..11: centres 5, 7, 9, 11 = level pixels 2..5; its mask keeps the columns 0..3 of 8 (image x 4..7): level pixels 2 and 3
  const want = new Uint8Array(64).fill(50);
  for (let y = 2; y <= 5; y++) for (const x of [2, 3]) want[y * 8 + x] = 200;
  assert.deepEqual(Array.from(res), Array.from(want));
  assert.deepEqual(j(prep.apron), { x: W, y: H });
});

await test('paste: refuses another bit depth (IJ_EDIT_PASTE_TYPE), a wrong size and an unknown mode', async () => {
  const spec = R.get('paste');
  const bad = (p, info, code) => { try { spec.validate(p, info); } catch (e) { assert.equal(e.code, code, JSON.stringify(Object.keys(p))); return; } assert.fail('accepted'); };
  bad({ data: new Uint16Array(4), w: 2, h: 2, x: 0, y: 0, mode: 'copy' }, { width: 4, height: 4, bitDepth: 8 }, 'IJ_EDIT_PASTE_TYPE');
  bad({ data: new Uint8Array(3), w: 2, h: 2, x: 0, y: 0, mode: 'copy' }, { width: 4, height: 4, bitDepth: 8 }, 'IJ_BAD_ARGS');
  bad({ data: new Uint8Array(4), w: 2, h: 2, x: 0, y: 0, mode: 'screen' }, { width: 4, height: 4, bitDepth: 8 }, 'IJ_BAD_ARGS');
  bad({ data: new Uint8Array(4), w: 2, h: 2, x: 0.5, y: 0, mode: 'copy' }, { width: 4, height: 4, bitDepth: 8 }, 'IJ_BAD_ARGS');
});

// ───────────────────────────────────────── draw ─────────────────────────────────────────
await test('draw: eleven selection types x line widths 1, 2, 5 x 8/16/32 bits, pixel for pixel (draw.json)', async () => {
  const f = load('draw');
  const W = f.width, H = f.height;
  const toRoi = (r) => {
    const fp = r.roi.floatPolygon || [];
    const pts = []; for (let i = 0; i + 1 < fp.length; i += 2) pts.push([fp[i], fp[i + 1]]);
    switch (r.name) {
      case 'rect': return { type: 'rect', x: r.roi.bounds[0], y: r.roi.bounds[1], w: r.roi.bounds[2], h: r.roi.bounds[3] };
      case 'oval': return { type: 'oval', x: r.roi.bounds[0], y: r.roi.bounds[1], w: r.roi.bounds[2], h: r.roi.bounds[3] };
      case 'polygon': return { type: 'polygon', points: pts };
      case 'freehand': return { type: 'freehand', points: pts };
      case 'traced': return { type: 'polygon', points: pts };
      case 'line': return { type: 'line', x1: pts[0][0], y1: pts[0][1], x2: pts[1][0], y2: pts[1][1] };
      case 'polyline': case 'freeline': return { type: 'polyline', points: pts };
      case 'angle': return { type: 'angle', points: pts };
      case 'point': return { type: 'point', points: pts };
      case 'holed': {
        const m = r.roi.mask;
        const bits = decodeData(m.data, 8).map((v) => (v ? 1 : 0));
        return ctx.IJRoi.translate(ctx.IJRoi.fromMask(bits, m.w, m.h), m.x, m.y);
      }
      default: throw new Error(r.name);
    }
  };
  const rois = new Map(f.rois.map((r) => [r.name, r]));
  let checked = 0;
  for (const c of f.cases) {
    const r = rois.get(c.roi);
    const roi = toRoi(r);
    const bd = c.bitDepth;
    const bg = f.background[String(bd)];
    const Ctor = bd === 8 ? Uint8Array : bd === 16 ? Uint16Array : Float32Array;
    const src = new Ctor(W * H).fill(bg);
    const out = E.drawRoi(src, W, H, bd, roi, c.foregroundValue, c.lineWidth, 1);
    const want = Array.from(src);
    for (const [i, v] of c.changed) want[i] = v;
    const got = Array.from(out);
    for (let i = 0; i < want.length; i++) {
      if (!Object.is(Math.fround(want[i]), bd === 32 ? Math.fround(got[i]) : got[i]) && want[i] !== got[i]) assert.fail(c.roi + ' ' + bd + '-bit width ' + c.lineWidth + ' differs at ' + i + ' (x=' + (i % W) + ', y=' + Math.floor(i / W) + '): ' + got[i] + ' != ' + want[i]);
    }
    checked++;
  }
  assert.equal(checked, f.cases.length);
});

await test('draw: the op refuses a missing selection and an out-of-range width; the fill/clear values are not its business', async () => {
  const spec = R.get('draw');
  assert.throws(() => spec.prepare({ width: 8, height: 8, bitDepth: 8 }, 0, { value: 255, lineWidth: 1 }, ctxOf(1)), (e) => e.code === 'IJ_NEEDS_ROI');
  assert.throws(() => spec.validate({ value: 255, lineWidth: 0 }, {}), (e) => e.code === 'IJ_BAD_ARGS');
  assert.throws(() => spec.validate({ value: NaN, lineWidth: 1 }, {}), (e) => e.code === 'IJ_BAD_ARGS');
  spec.validate({ value: 1, lineWidth: 3, staticWidth: 5, shape: { type: 'rect', x: 1, y: 1, w: 2, h: 2 } }, {});
});

await test('draw: a wide Line selection draws a line when the static width is 1 and the outline of its rectangle otherwise', async () => {
  const W = 40, H = 30;
  const line = { type: 'line', x1: 4, y1: 6, x2: 30, y2: 20 };
  const a = E.drawRoi(new Uint8Array(W * H), W, H, 8, line, 255, 4, 1);
  const b = E.drawRoi(new Uint8Array(W * H), W, H, 8, line, 255, 4, 5);
  const cnt = (d) => d.reduce((s, v) => s + (v ? 1 : 0), 0);
  assert.ok(cnt(a) > 40 && cnt(b) > 40 && cnt(a) !== cnt(b));
  // a line of width 1 with a static width of 5: ImageJ draws it one pixel wide ("else ip.setLineWidth(1)")
  const c = E.drawRoi(new Uint8Array(W * H), W, H, 8, line, 255, 1, 5);
  const d = E.drawRoi(new Uint8Array(W * H), W, H, 8, line, 255, 1, 1);
  assert.deepEqual(Array.from(c), Array.from(d));
});

// ──────────────────────────────────── New Image ────────────────────────────────────
await test('new image: every type x fill, Noise with seeds 1 and 42, the display range and the inverting LUT of "White" (new_image.json)', async () => {
  const f = load('new_image');
  assert.deepEqual(j(f.firstUseDefaults), { typeIndex: 0, fillIndex: 1, fill: 'Black', width: 512, height: 512 });
  for (const c of f.cases) {
    const bd = parseInt(c.params.type, 10);
    const fill = c.params.fill.toLowerCase();
    const img = await E.makeNewImage(bd, fill, c.params.width, c.params.height, c.params.seed === null ? 0 : c.params.seed, null);
    sameBits(img.data, decodeData(c.output.data, bd), JSON.stringify(c.params));
    assert.equal(img.invert, c.invertedLut, 'inverting LUT ' + JSON.stringify(c.params));
    assert.equal(img.display.invert, c.invertedLut);
    assert.ok(Object.is(Math.fround(img.display.min), Math.fround(c.displayMin)), 'display min ' + JSON.stringify(c.params) + ' ' + img.display.min + ' vs ' + c.displayMin);
    assert.ok(Object.is(Math.fround(img.display.max), Math.fround(c.displayMax)), 'display max ' + JSON.stringify(c.params));
  }
});

// ───────────────────────────────────────── Montage ─────────────────────────────────────────
for (const [file, bd] of [['montage_u8', 8], ['montage_u16', 16]]) {
  await test('montage ' + bd + '-bit: the channels rendered through their LUT and range, layouts, borders, scale 0.5 (' + file + ')', async () => {
    const f = load(file);
    const W = f.sourceChannels[0].data.width, H = f.sourceChannels[0].data.height;
    const hex = (c) => c;
    const chans = f.sourceChannels.map((s, i) => ({
      data: decodeData(s.data.data, bd), name: 'C' + (i + 1), color: hex(s.lutColor),
      display: { min: s.displayMin, max: s.displayMax, lut: ctx.IJLuts.forColor(s.lutColor), invert: false }
    }));
    // the rendered tiles
    f.tiles.forEach((t, i) => {
      const r = E.renderChannelRGB(chans[i], bd, false);
      assert.deepEqual(Array.from(r.r), Array.from(decodeData(t.r, 8)), 'tile ' + i + ' red');
      assert.deepEqual(Array.from(r.g), Array.from(decodeData(t.g, 8)), 'tile ' + i + ' green');
      assert.deepEqual(Array.from(r.b), Array.from(decodeData(t.b, 8)), 'tile ' + i + ' blue');
    });
    const view = { id: 1, name: 'src', width: W, height: H, bitDepth: bd, calibration: { pixelWidth: 1, pixelHeight: 1, unit: 'px' }, active: 0, mode: 'composite', channels: chans };
    const spec = R.get('montage');
    // montage_u16.json holds every layout twice (same parameters, cases 0..3 and 4..7). The first four were recorded before the display ranges
    // reached the ImagePlus: their pixels differ from the second four AND from the recorded `tiles` (a fixture-driver artefact, reported to the
    // orchestrator); the second four equal the tiles, which is what the plan says the montage is made of. Only those are compared.
    let cases = f.cases;
    if (f.cases.length === 8) {
      const same = (i) => JSON.stringify(f.cases[i].params) === JSON.stringify(f.cases[i + 4].params);
      assert.ok([0, 1, 2, 3].every(same), 'the two groups repeat the same parameters');
      assert.notDeepEqual(f.cases[0].output.r.b64, f.cases[4].output.r.b64, 'the first group is the stale one');
      cases = f.cases.slice(4);
    }
    for (const c of cases) {
      const p = { columns: c.params.columns, rows: c.params.rows, scale: c.params.scale, first: c.params.first, last: c.params.last, increment: c.params.increment, border: c.params.border, label: false };
      spec.validate(p, { width: W, height: H, bitDepth: bd, channels: 3 });
      const res = await spec.run(view, p, null, noopIo);
      assert.equal(res.length, 1);
      assert.equal(res[0].width, c.output.width, JSON.stringify(c.params)); assert.equal(res[0].height, c.output.height);
      ['r', 'g', 'b'].forEach((k, i) => assert.deepEqual(Array.from(res[0].channels[i].data), Array.from(decodeData(c.output[k], 8)), file + ' ' + JSON.stringify(c.params) + ' plane ' + k));
      assert.equal(res[0].bitDepth, 8); assert.equal(res[0].name, 'Montage');
    }
  });
}

await test('montage layout rule: MontageMaker.makeMontage defaults for 2..16 slices of 24 x 20 (montage_layout_rule.json)', async () => {
  const f = load('montage_layout_rule');
  for (const r of f.rule) {
    const d = E.montageDefaults(r.n, f.tile.width);
    assert.equal(d.columns, r.columns, 'columns of ' + r.n); assert.equal(d.rows, r.rows, 'rows of ' + r.n); assert.equal(d.scale, r.scale);
    assert.equal(d.first, 1); assert.equal(d.last, r.n); assert.equal(d.increment, 1);
    const s = E.montageSize(f.tile.width, f.tile.height, d);
    assert.equal(s.mw, r.outputWidth, 'width of ' + r.n); assert.equal(s.mh, r.outputHeight, 'height of ' + r.n);
  }
  // the 0.5 and 0.25 reductions: "if (imp.getWidth()*columns>800) scale = 0.5; if (imp.getWidth()*columns>1600) scale = 0.25;"
  assert.equal(E.montageDefaults(9, 300).scale, 0.5); assert.equal(E.montageDefaults(9, 600).scale, 0.25); assert.equal(E.montageDefaults(4, 400).scale, 1.0);
  assert.deepEqual(j(E.montageClamp({ first: 0, last: 99, increment: 0, border: -3 }, 5)), { first: 1, last: 5, increment: 1, border: 0 });
  assert.deepEqual(j(E.montageClamp({ first: 4, last: 2, increment: 2, border: 1 }, 5)), { first: 1, last: 5, increment: 2, border: 1 });
});

await test('montage: a white bottom strip turns the border and the background to ImageJ\'s white-background colours; a single channel is refused', async () => {
  const W = 8, H = 14;
  const data = new Uint8Array(W * H).fill(230);
  const mk = (d) => ({ data: d, name: 'c', color: '#ffffff', display: { min: 0, max: 255, lut: 'Grays', invert: false } });
  const view = { id: 1, name: 'w', width: W, height: H, bitDepth: 8, calibration: { pixelWidth: 2, pixelHeight: 2, unit: 'um' }, active: 0, mode: 'composite', channels: [mk(data), mk(data.slice())] };
  const res = await R.get('montage').run(view, { columns: 3, rows: 1, scale: 1, first: 1, last: 2, increment: 1, border: 2 }, null, noopIo);
  const d = res[0];
  // 3 columns, only two slices: the third cell stays the background (white), the borders are the foreground (black)
  assert.equal(d.channels[0].data[0 * d.width + 8], 0, 'border column is the foreground colour black');
  assert.equal(d.channels[0].data[0 * d.width + 20], 255, 'the empty third cell is the white background');
  assert.deepEqual(j(d.calibration), { pixelWidth: 2, pixelHeight: 2, unit: 'um' });
  const half = await R.get('montage').run(view, { columns: 2, rows: 1, scale: 0.5, first: 1, last: 2, increment: 1, border: 0 }, null, noopIo);
  assert.deepEqual(j(half[0].calibration), { pixelWidth: 4, pixelHeight: 4, unit: 'um' }, 'cal.pixelWidth /= scale');
  await assert.rejects(R.get('montage').run(Object.assign({}, view, { channels: [mk(data)] }), { columns: 1, rows: 1, scale: 1, first: 1, last: 1, increment: 1, border: 0 }, null, noopIo), (e) => e.code === 'IJ_EDIT_STACK_REQUIRED');
});

// ────────────────────────────────── look-up tables ──────────────────────────────────
await test('built-in tables: 3-3-2 RGB and Red/Green are LutLoader\'s; the 12 tables of the fixture match IJLuts (builtin_luts.json)', async () => {
  const f = load('builtin_luts');
  const rgb = (c) => { const t = decodeData(c.rgb768, 8); const o = new Uint8Array(768); for (let i = 0; i < 256; i++) { o[i * 3] = t[i]; o[i * 3 + 1] = t[256 + i]; o[i * 3 + 2] = t[512 + i]; } return o; };
  const byName = new Map(f.cases.map((c) => [c.name, c]));
  assert.deepEqual(Array.from(E.lutRgb332()), Array.from(rgb(byName.get('3-3-2 rgb') || byName.get('3-3-2 RGB'))));
  assert.deepEqual(Array.from(E.lutRedGreen()), Array.from(rgb(byName.get('redgreen') || byName.get('red/green'))));
  assert.deepEqual(Array.from(ctx.IJLuts.get('3-3-2 RGB')), Array.from(E.lutRgb332()), 'registered on this side');
  assert.deepEqual(Array.from(ctx.IJLuts.get('Red/Green')), Array.from(E.lutRedGreen()));
  // the green half of Red/Green wraps: (byte)(128*2) = 0 ... (byte)(255*2) = 254
  const rg = E.lutRedGreen();
  assert.equal(rg[128 * 3 + 1], 0); assert.equal(rg[129 * 3 + 1], 2); assert.equal(rg[255 * 3 + 1], 254); assert.equal(rg[127 * 3], 254);
  for (const c of f.cases) {
    if (!c.found) continue;
    const key = { fire: 'Fire', grays: 'Grays', ice: 'Ice', spectrum: 'Spectrum', red: 'Red', green: 'Green', blue: 'Blue', cyan: 'Cyan', magenta: 'Magenta', yellow: 'Yellow' }[c.name];
    if (key) assert.deepEqual(Array.from(ctx.IJLuts.get(key)), Array.from(rgb(c)), c.name);
  }
});

await test('.lut files: NIH Image (interpolated below 256 colours), raw 768, raw 970, text with or without an index column / header rows (lut_files.json)', async () => {
  const f = load('lut_files');
  for (const c of f.cases) {
    const bytes = new Uint8Array(Buffer.from(c.fileB64, 'base64'));
    assert.equal(bytes.length, c.length, c.file);
    const t = decodeData(c.rgb768, 8);
    const want = new Uint8Array(768); for (let i = 0; i < 256; i++) { want[i * 3] = t[i]; want[i * 3 + 1] = t[256 + i]; want[i * 3 + 2] = t[512 + i]; }
    const got = ctx.IJLutFile.parse(bytes);
    assert.deepEqual(Array.from(got.table), Array.from(want), c.file);
    // saving gives the raw 768 planar bytes, which read back as the same table
    const w = ctx.IJLutFile.write(got.table);
    assert.equal(w.length, 768);
    assert.deepEqual(Array.from(ctx.IJLutFile.parse(w).table), Array.from(got.table));
  }
  // a 16-colour NIH LUT of 80 bytes is not read (length > 768 is required), nor is anything above 10000 bytes
  assert.throws(() => ctx.IJLutFile.parse(new Uint8Array(80)), (e) => e.code === 'IJ_EDIT_LUT_UNKNOWN');
  assert.throws(() => ctx.IJLutFile.parse(new Uint8Array(10001)), (e) => e.code === 'IJ_EDIT_LUT_UNKNOWN');
  assert.throws(() => ctx.IJLutFile.parse(new Uint8Array(800)), (e) => e.code === 'IJ_EDIT_LUT_UNKNOWN', 'no ICOL header, not raw, not text');
  assert.equal(ctx.IJLutFile.parse(new Uint8Array(0)).kind, 'raw', 'LutLoader reads an empty file as an all-black raw LUT');
});

// ───────────────────────────────────── Duplicate ─────────────────────────────────────
await test('Duplicate: the channel range of "Channels (c):" and the unique title', async () => {
  const f = load('duplicator_channels');
  const seen = new Set(f.cases.map((c) => c.params.firstC + '-' + c.params.lastC));
  for (const k of seen) {
    const [a, b] = k.split('-').map(Number);
    assert.deepEqual(j(E.parseChannelRange(a === b ? String(a) : a + '-' + b, 3)), { first: a, last: b }, k);
  }
  const P = (s, n) => j(E.parseChannelRange(s, n));
  assert.deepEqual(P('1-3', 3), { first: 1, last: 3 });
  assert.deepEqual(P('2', 3), { first: 2, last: 2 });
  assert.deepEqual(P('1,3', 3), { first: 1, last: 1 }, 'Tools.split(" -") does not split on a comma: one token, no number, channel 1 only');
  assert.deepEqual(P('3-1', 3), { first: 1, last: 3 }, 'first > last: everything');
  assert.deepEqual(P('0-9', 3), { first: 1, last: 3 });
  assert.deepEqual(P('2 - 3', 3), { first: 2, last: 3 }, 'spaces and dashes both split');
  assert.deepEqual(P('1-2-3', 3), { first: 1, last: 1 }, 'three tokens: no upper bound');
  assert.deepEqual(P('', 3), { first: 1, last: 1 });
  assert.deepEqual(P('x', 3), { first: 1, last: 1 });
  assert.deepEqual(P('2.7', 3), { first: 2, last: 2 }, '(int)2.7');
  // WindowManager.getUniqueName
  assert.equal(E.uniqueName('cells.tif', ['cells.tif'], false), 'cells-1.tif');
  assert.equal(E.uniqueName('cells-1.tif', ['cells.tif', 'cells-1.tif'], true), 'cells-2.tif', 'a title this command made loses its -N');
  assert.equal(E.uniqueName('cells-1.tif', ['cells-1.tif'], false), 'cells-1-1.tif', 'any other title keeps it');
  assert.equal(E.uniqueName('a', ['a-1', 'a-2'], false), 'a-3');
  assert.equal(E.uniqueName('stack.v5', [], false), 'stack-1.v5', 'a dot 3 from the end is an extension');
  assert.equal(E.uniqueName('im.something', [], false), 'im.something-1', 'a long tail is no extension');
  assert.equal(E.makeUniqueName('Untitled', []), 'Untitled');
  assert.equal(E.makeUniqueName('Untitled', ['Untitled']), 'Untitled-1');
  assert.equal(E.makeUniqueName('Untitled', ['Untitled', 'Untitled-1']), 'Untitled-2');
});

await test('Invert LUTs (macro InvertAllLuts): Grays gives inverted grays, Red gives white to red, twice is the identity on the colours', async () => {
  const g = E.invertLutTable(ctx.IJLuts.get('Grays'));
  for (let i = 0; i < 256; i++) { assert.equal(g[i * 3], 255 - i); assert.equal(g[i * 3 + 1], 255 - i); assert.equal(g[i * 3 + 2], 255 - i); }
  const r = E.invertLutTable(ctx.IJLuts.get('Red'));
  assert.deepEqual([r[0], r[1], r[2]], [255, 255, 255]);
  assert.deepEqual([r[255 * 3], r[255 * 3 + 1], r[255 * 3 + 2]], [255, 0, 0]);
  assert.deepEqual([r[100 * 3], r[100 * 3 + 1], r[100 * 3 + 2]], [255, 155, 155]);
  const rr = E.invertLutTable(r);
  const red = ctx.IJLuts.get('Red');
  for (let i = 0; i < 768; i++) assert.ok(Math.abs(rr[i] - red[i]) <= 1, 'twice: ' + i);
});

await test('Float.toString for the divide-by-zero value of Edit > Options > Misc.', async () => {
  const s = E.javaFloatToString;
  assert.equal(s(Infinity), 'Infinity'); assert.equal(s(-Infinity), '-Infinity'); assert.equal(s(NaN), 'NaN');
  assert.equal(s(0), '0.0'); assert.equal(s(1), '1.0'); assert.equal(s(-2.5), '-2.5'); assert.equal(s(100), '100.0');
  assert.equal(s(3.4028234663852886e38), '3.4028235E38'); assert.equal(s(1e-5), '1.0E-5'); assert.equal(s(12345678), '1.2345678E7');
  assert.equal(s(0.001), '0.001'); assert.equal(s(1234567), '1234567.0'); assert.equal(s(0.1), '0.1');
});

// ───────────────────────────── Edit > Options > Conversions…, Invert LUTs ─────────────────────────────
await test('Image > Type with "Scale when converting" off and on: 16 -> 8, 32 -> 8, 32 -> 16, 16 -> 32, 8 -> 16 / 32 (conversions.json)', async () => {
  const f = load('conversions');
  let checked = 0, unscaled = 0;
  for (const c of f.cases) {
    const inp = { width: c.input.width, height: c.input.height, bitDepth: c.input.bitDepth, data: decodeData(c.input.data, c.input.bitDepth) };
    const out = ctx.IJOps.convert(inp, c.params.to, { min: c.params.displayMin, max: c.params.displayMax, scale: c.params.scale });
    assert.equal(out.bitDepth, c.params.to);
    sameBits(out.data, decodeData(c.output.data, c.output.bitDepth), 'conversions ' + JSON.stringify(c.params));
    checked++; if (!c.params.scale) unscaled++;
  }
  assert.equal(checked, 28); assert.ok(unscaled >= 14);
});

await test('Invert (ShortProcessor / FloatProcessor) with and without "Full range 16-bit inversions" (invert_full_range.json)', async () => {
  const f = load('invert_full_range');
  const IJOps = ctx.IJOps;
  for (const c of f.cases) {
    const bd = c.input.bitDepth;
    const inp = { width: c.input.width, height: c.input.height, bitDepth: bd, data: decodeData(c.input.data, bd) };
    const want = decodeData(c.output.data, bd);
    const label = 'invert ' + JSON.stringify(c.params);
    // FloatProcessor.invert reads the display range (-10..120 when the fixture set one); a 16-bit image spans 0..65535 in every case, so the
    // data range and the full range coincide here
    const opts = bd === 32 && c.params.displayRangeSet ? { min: -10, max: 120 } : (c.params.fullRange16bitInversions ? { fullRange: true } : undefined);
    const got = IJOps.invert(inp, opts).data;
    if (bd !== 32) sameBits(got, want, label);
    else {
      // FloatProcessor.process(INVERT): "float min2, max2; v2 = max2 - (v1 - min2);" — float arithmetic, every step rounded to a float.
      const mn = c.params.displayRangeSet ? -10 : -300, mx = c.params.displayRangeSet ? 120 : 70000;
      const java = Float32Array.from(inp.data, (v) => Math.fround(Math.fround(mx) - Math.fround(Math.fround(v) - Math.fround(mn))));
      sameBits(java, want, label + ' (ImageJ operation order)');
      sameBits(got, want, label);
    }
  }
  // ShortProcessor.invert with Prefs.fullRange16bitInversions: "setMinAndMax(0, 65535); process(INVERT, 0); resetMinAndMax()"
  const part = { width: 3, height: 1, bitDepth: 16, data: Uint16Array.from([100, 150, 200]) };
  assert.deepEqual(Array.from(IJOps.invert(part, { fullRange: true }).data), [65435, 65385, 65335]);
  assert.deepEqual(Array.from(IJOps.invert(part).data), [200, 150, 100]);
});

await test('Invert LUTs (macro InvertAllLuts 1.54p): the recorded before / after tables of ten LUTs, entry for entry (invert_luts.json)', async () => {
  const f = load('invert_luts');
  assert.ok(f.cases.length >= 10);
  for (const c of f.cases) {
    const got = E.invertLutTable(Uint8Array.from(c.before));
    for (let i = 0; i < 768; i++) assert.equal(got[i], c.after[i], c.name + ' entry ' + i);
  }
  assert.ok(f.compositeProjectionAfter.every((m) => m === 'Invert'), 'a composite shown as a Sum is switched to the Invert projection');
});

console.log(n + ' groups passed');
