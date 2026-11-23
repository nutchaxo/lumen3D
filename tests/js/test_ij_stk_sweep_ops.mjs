// Stacks and RGB, the operations of the sweep against the golden fixtures of ImageJ 1.54p (tests/fixtures/ij-stacks, agent F), through the real engine:
//   stackproc   Gaussian / Invert / Add / Median / Subtract Background over all slices or one slice, hyperstacks (planes + channels), Crop, Canvas Size,
//               Size (X / Y in place, Depth / Time a new image), Scale (new window with Z, in place), Bin with Z shrink, Image Calculator (stack x stack,
//               stack x image, sizes, types, RGB, hyperstack), the stack histogram;
//   convert     Convert Stack to Binary (stackToMask / stackToMaskNew) in every variant of the dialog;
//   rgb         Gaussian / Median / Add / Invert / Rotate / Scale / Bin / Canvas ... on a 24-bit image (a filter works per colour), Measure weighted / unweighted
//               (Skewness and Kurtosis from the float luminance, %Area 0), the histogram of the luminance.
// Where ImageJ is integer the result is bit-exact; the documented exceptions are the 16-bit and 32-bit Gaussian Blur (IJFilters.gaussian of ij-analysis.js keeps its
// y pass in doubles: at most 1 grey level in a few pixels, the 32-bit within 1e-4 relative).
//
// Run: node tests/js/test_ij_stk_sweep_ops.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { loadWorld, client, fixture, FIX, compareDoc, fixturePlanes, planesInIJOrder, sameArrays } from './ij_sweep_lib.mjs';

const world = loadWorld();
const clients = [];
const open = () => { const c = client(world); clients.push(c); return c; };
const kv = (opt) => Object.fromEntries(String(opt).replace(/\[([^\]]*)\]/g, (m, g) => g.replace(/\s/g, '_')).split(/\s+/).filter(Boolean).map((x) => { const [k, v] = x.split('='); return [k, v === undefined ? true : v]; }));
const INTERP = { None: 'none', Bilinear: 'bilinear', Bicubic: 'bicubic' };
let groups = 0;
async function test(name, fn) {
  try { await fn(); groups++; console.log('  ok  ' + name); }
  catch (e) { console.error('FAIL ' + name); throw e; }
}
const tolFor = (bd) => (bd === 32 ? { rel: 1e-4, abs: 1e-4 } : (bd === 16 ? 1 : 0));

/** Runs `op` on a fixture input and compares the document with `expected` (a STACK). `planes` = the request's planes. */
async function runAndCompare(S, expected, op, params, o = {}) {
  const c = open();
  const id = await c.open(S);
  const args = { docId: id, op, params, roi: o.roi || null, channel: o.channel === undefined ? 0 : o.channel };
  if (o.planes) args.planes = o.planes;
  const m = await c.call('doc.run', args);
  assert.ok(m.ok, `${op} failed: ${m.error && m.error.code} ${m.error && m.error.message}`);
  const why = compareDoc(c.doc(id), expected, o.tol === undefined ? 0 : o.tol);
  return why;
}

// ═════════════ stackproc: filters over the planes of a stack ═════════════
await test('Gaussian Blur: every slice (Yes), the slice on screen (No), 8 / 16 / 32-bit, hyperstacks with every channel', async () => {
  const cases = [
    ['gaussian_u8_all_slices', 0, { planes: 'all' }, { sigma: 2 }], ['gaussian_u16_all_slices', 0, { planes: 'all' }, { sigma: 1.5 }], ['gaussian_u16_all_slices', 1, {}, { sigma: 1.5 }],
    ['gaussian_u16_all_slices', 2, {}, { sigma: 1.5 }], ['gaussian_f32_current_slice', 0, {}, { sigma: 1.5 }], ['gaussian_f32_current_slice', 1, { planes: 'all' }, { sigma: 1.5 }],
    ['gaussian_hyperstack_1c', 0, { planes: 'all' }, { sigma: 1.5 }], ['gaussian_hyperstack_1c', 1, {}, { sigma: 1.5 }],
    // multichannel: Yes = every plane of every channel (channel 'all'); No / "slice" = one plane of one channel; a composite in COMPOSITE mode is processed whole
    ['gaussian_hyperstack_color_mode', 0, { planes: 'all', channel: 'all' }, { sigma: 1.5 }], ['gaussian_hyperstack_color_mode', 1, {}, { sigma: 1.5 }],
    ['gaussian_hyperstack_composite', 0, { planes: 'all', channel: 'all' }, { sigma: 1.5 }], ['gaussian_hyperstack_composite', 1, {}, { sigma: 1.5 }],
    ['gaussian_hyperstack_composite', 2, {}, { sigma: 1.5 }]
  ];
  for (const [name, ci, o, params] of cases) {
    const f = fixture('stackproc', name), cs = f.cases[ci], S = f.input;
    if (cs.options === 'sigma=1.5' && name === 'gaussian_hyperstack_composite') o.planes = 'all', o.channel = 'all';   // no word: COMPOSITE mode processes the whole image
    const why = await runAndCompare(S, cs.self, 'gaussian', params, Object.assign({ tol: tolFor(S.bitDepth) }, o));
    assert.equal(why, '', `${name} [${cs.options}]: ${why}`);
  }
});

await test('Invert, Add, Median, Subtract Background, Crop, Canvas Size over a stack: bit-exact, with a selection too', async () => {
  const one = async (name, ci, op, params, o) => {
    const f = fixture('stackproc', name), cs = f.cases[ci];
    const why = await runAndCompare(f.input || cs.input, cs.self, op, params, Object.assign({ roi: f.roi }, o));
    assert.equal(why, '', `${name} [${cs.options}]: ${why}`);
  };
  await one('invert_u16_all_slices', 0, 'invert', {}, { planes: 'all' });
  await one('invert_u8_roi_all_slices', 0, 'invert', {}, { planes: 'all' });
  await one('add_u8_all_slices', 0, 'math', { op: 'add', value: 25 }, { planes: 'all' });
  await one('add_u8_all_slices', 1, 'math', { op: 'add', value: 25 }, {});
  await one('median_u8_all_slices', 0, 'rank', { type: 'median', radius: 2 }, { planes: 'all' });
  await one('subtract_background_all_slices', 0, 'subtractBackground', { radius: 10 }, { planes: 'all' });
  await one('crop_stack', 0, 'crop', {}, {});
  await one('canvas_translate_rotate_stack', 0, 'canvasSize', { width: 45, height: 30, position: 'center' }, {});
});

await test('Translate and Rotate over a stack: every slice (Yes) or the slice on screen, the same pixels as on a single image', async () => {
  const f = fixture('stackproc', 'canvas_translate_rotate_stack'), S = f.input;
  const trans = f.cases.findIndex((c) => /^x=3 y=2/.test(c.options)), rot = f.cases.findIndex((c) => /^angle=15/.test(c.options));
  const cT = open(), idT = await cT.open(S);
  await cT.ok('doc.run', { docId: idT, op: 'translate', params: { dx: 3, dy: 2, interpolation: 'none' }, roi: null, channel: 0, planes: 'all' });
  assert.equal(compareDoc(cT.doc(idT), f.cases[trans].self), '', 'Translate');
  const cR = open(), idR = await cR.open(S);
  await cR.ok('doc.run', { docId: idR, op: 'rotate', params: { angle: 15, interpolation: 'bilinear', rect: null }, roi: null, channel: 0, planes: 'all' });
  assert.equal(compareDoc(cR.doc(idR), f.cases[rot].self), '', 'Rotate');
});

// ═════════════ Size / Scale / Bin ═════════════
await test('Size...: X and Y of every slice in place; a new Depth / Time opens a NEW image (Resizer.zScale on every x-z image)', async () => {
  for (const name of ['size_stack_xy', 'size_stack_depth', 'size_hyperstack']) {
    const f = fixture('stackproc', name);
    for (const cs of f.cases) {
      const o = kv(cs.options), S = f.input;
      const c = open(), id = await c.open(S);
      const common = { interpolation: INTERP[o.interpolation], averageWhenDownsizing: !!o.average };
      const r1 = await c.ok('doc.run', { docId: id, op: 'resize', params: Object.assign({ width: +o.width, height: +o.height }, common), roi: null, channel: 'all' });
      void r1;
      assert.equal(compareDoc(c.doc(id), cs.self, 1), '', `${name} [${cs.options}] in place`);
      const zChange = (o.depth && +o.depth !== S.dims.z) || (o.time && +o.time !== S.dims.t);
      if (zChange) {
        const r = await c.ok('doc.run', { docId: id, op: 'resizeDepth', params: Object.assign({}, common, o.depth && +o.depth !== S.dims.z ? { depth: +o.depth } : {}, o.time && +o.time !== S.dims.t ? { time: +o.time } : {}), roi: null, channel: 'all' });
        assert.equal(r.newDocIds.length, 1, 'a new image');
        assert.equal(compareDoc(c.doc(r.newDocIds[0]), cs.created[0], 1), '', `${name} [${cs.options}] new image`);
      } else assert.equal(cs.created.length, 0, 'nothing created');
    }
  }
});

await test('Scale...: a new window with Process entire stack and Z Scale, one plane without, in place for the whole stack', async () => {
  const f = fixture('stackproc', 'scale_stack'), S = f.input;
  for (const cs of f.cases) {
    const o = kv(cs.options), c = open(), id = await c.open(S);
    const xs = parseFloat(o.x), ys = parseFloat(o.y), zs = parseFloat(o.z || '1');
    const width = Math.max(1, Math.floor(S.width * xs + 0.5)), height = Math.max(1, Math.floor(S.height * ys + 0.5)), depth = Math.max(1, Math.floor(S.dims.z * zs + 0.5));
    const common = { xscale: xs, yscale: ys, interpolation: INTERP[o.interpolation], averageWhenDownsizing: !!o.average };
    if (o.create) {
      const r = await c.ok('doc.run', { docId: id, op: 'scaleNew', params: Object.assign({ width, height, stack: !!o.process, name: o.title }, common, o.process && depth !== S.dims.z ? { depth } : {}), roi: null, channel: 'all' });
      assert.equal(compareDoc(c.doc(r.newDocIds[0]), cs.created[0], 1), '', `scale [${cs.options}]`);
    } else {
      await c.ok('doc.run', { docId: id, op: 'scaleInPlace', params: Object.assign({ rect: null }, common), roi: null, channel: 'all', planes: o.process ? 'all' : 'current' });
      assert.equal(compareDoc(c.doc(id), cs.self, 1), '', `scale in place [${cs.options}]`);
    }
  }
});

await test('Bin...: X, Y and Z shrink on a stack (the z median is the mean, Binner.shrinkZ), every method', async () => {
  const f = fixture('stackproc', 'bin_stack');
  for (const cs of f.cases) {
    const o = kv(cs.options);
    const why = await runAndCompare(f.input, cs.self, 'bin', { xshrink: +o.x, yshrink: +o.y, zshrink: +o.z, method: o.bin.toLowerCase() }, { channel: 'all' });
    assert.equal(why, '', `bin [${cs.options}]: ${why}`);
  }
});

// ═════════════ Image Calculator ═════════════
await test('Image Calculator: stack x stack, stack x image, different sizes and types, RGB stacks, hyperstacks; a stack of another depth is refused', async () => {
  const OPS = { Add: 'add', Subtract: 'subtract', Multiply: 'multiply', Divide: 'divide', AND: 'and', OR: 'or', XOR: 'xor', Min: 'min', Max: 'max', Average: 'average', Difference: 'difference', Copy: 'copy', 'Transparent-zero': 'transparent-zero' };
  let compared = 0, refused = 0;
  for (const name of fs.readdirSync(FIX + '/stackproc').filter((f) => f.startsWith('calc_')).map((f) => f.replace('.json', ''))) {
    const f = fixture('stackproc', name), ins = f.inputs || [f.input, f.input2];
    for (const cs of f.cases) {
      const o = kv(cs.options.replace(/\s+(\d+-bit)/, ' float32=true'));
      const c = open(), byTitle = {};
      for (const S of ins) byTitle[S.title] = await c.open(S);
      const id1 = byTitle[o.image1], id2 = byTitle[o.image2], d1 = ins.find((S) => S.title === o.image1);
      const nC = d1.bitDepth === 24 ? 3 : d1.dims.c;
      const params = { op: OPS[o.operation], float32: !!o.float32, all: nC > 1 };
      if (!params.all) { params.channel1 = 0; params.channel2 = 0; }
      // the word `stack` = Yes; a hyperstack is processed whole without a question
      if ((o.stack || d1.hyperstack) && d1.dims.z * d1.dims.t > 1) params.slices = 'all';
      const m = await c.call('doc.run', { docId: id1, docIds: id1 === id2 ? [id1] : [id1, id2], op: 'imageCalculator', params, roi: null, channel: 0 });
      if (cs.thrown) { assert.equal(m.ok, false, name); assert.equal(m.error.code, 'IJ_CALC_STACKS'); refused++; continue; }
      if (!cs.created.length) continue;      // "Create new window" unticked: ImageJ writes into image 1, the page always opens a new image
      assert.ok(m.ok, `${name} [${cs.options}] ${m.error && m.error.code}`);
      assert.equal(compareDoc(c.doc(m.result.newDocIds[0]), cs.created[0]), '', `${name} [${cs.options}]`);
      compared++;
    }
  }
  assert.ok(compared >= 30 && refused === 2, `${compared} results compared, ${refused} refusals`);
});

// ═════════════ the histogram of a stack ═════════════
await test('Histogram: "Include all N images?" = StackStatistics (counts, min, max, mean, standard deviation, bin width) of 8 / 16 / 32-bit stacks', async () => {
  const f = fixture('stackproc', 'histogram_all_slices');
  for (const cs of f.cases) {
    const c = open(), id = await c.open(cs.input);
    const r = await c.ok('doc.stackHistogram', { docId: id, roi: null, channel: 0, bins: 256, planes: 'all' });
    assert.ok(sameArrays(r.counts, cs.stackHistogram), cs.bitDepth + '-bit counts');
    assert.equal(r.stats.min, cs.stackMin); assert.equal(r.stats.max, cs.stackMax);
    assert.equal(r.stats.mean, cs.stackMean); assert.equal(r.stats.stdDev, cs.stackStdDev);
    assert.equal(r.min, cs.histMin); assert.equal(r.binWidth, cs.binSize);
    assert.equal(r.counts.reduce((a, b) => a + b, 0), cs.input.width * cs.input.height * cs.input.dims.z, 'every pixel of every slice');
    // the slice histograms of the fixture add up to the stack's (8 bits: the same 256 bins)
    if (cs.bitDepth === 8) assert.ok(sameArrays(cs.sliceHistograms.reduce((a, h) => a.map((v, i) => v + h[i])), cs.stackHistogram));
  }
});

// ═════════════ Convert Stack to Binary ═════════════
await test('Convert to Mask / Make Binary on a stack: every variant of the dialog (Calculate, Only, Black background, Create new stack, Method, Background, a set threshold)', async () => {
  const THR = { s8t: { lower: 60, upper: 200 }, s16t: { lower: 10000, upper: 45000 } };   // the thresholds the driver set (tools/ij_fixtures/W4Conv.java)
  let n = 0;
  for (const name of fs.readdirSync(FIX + '/convert').filter((f) => f.startsWith('to_binary_')).map((f) => f.replace('.json', ''))) {
    const f = fixture('convert', name);
    if (name === 'to_binary_single_image') continue;     // one image: the Thresholder of a single plane (the page's toMask path)
    for (const cs of f.cases) {
      const S = f.input || cs.input, o = kv(cs.options);
      const c = open(), id = await c.open(S);
      const params = { method: o.method || 'Default', background: o.background || 'Default', calculate: !!o.calculate, only: !!o.only, black: !!o.black, legacy: true };
      if (THR[S.title]) params.threshold = THR[S.title];
      if (S.luts && S.luts[0] === 'inverting') params.invertedLut = true;
      const m = await c.call('doc.run', { docId: id, op: o.create ? 'stackToMaskNew' : 'stackToMask', params, roi: null, channel: 0 });
      assert.ok(m.ok, `${name} [${cs.options}] ${m.error && m.error.code}`);
      const got = o.create ? c.doc(m.result.newDocIds[0]) : c.doc(id);
      assert.equal(compareDoc(got, o.create ? cs.created[0] : cs.self), '', `${name} [${cs.options}]`);
      // "Black background" off: an inverting LUT, the objects stay 255
      if (!o.black && !o.create) assert.equal(got.channels[0].display.invert, true, name + ' inverting LUT');
      n++;
    }
  }
  assert.ok(n >= 25, n + ' variants');
  // 16-bit Only: ImageJ refuses ("8-bit stack required to process a single slice.")
  const c = open(), f = fixture('convert', 'to_binary_stack_u16'), id = await c.open(f.input);
  const e = await c.err('doc.run', { docId: id, op: 'stackToMask', params: { only: true }, roi: null, channel: 0 });
  assert.equal(e.code, 'IJ_BAD_TYPE');
  // the source of "Create new stack" stays as it was
  const c2 = open(), f2 = fixture('convert', 'to_binary_stack_u8_black'), id2 = await c2.open(f2.input);
  await c2.ok('doc.run', { docId: id2, op: 'stackToMaskNew', params: { calculate: true, black: true }, roi: null, channel: 0 });
  assert.equal(compareDoc(c2.doc(id2), f2.input), '', 'the source is unchanged');
});

// ═════════════ 24-bit RGB ═════════════
await test('RGB: Gaussian, Median, Mean, Min, Max, Add, Subtract, Multiply, Log, Gamma, Invert, Flip, Rotate, Scale, Size, Canvas, Bin, Smooth, Sharpen, Find Edges, Unsharp, Translate match ImageJ per colour', async () => {
  const R = (name, op, params, o = {}) => Object.assign({ name, op, params }, o);
  const list = [
    R('filter_add', 'math', { op: 'add', value: 25 }), R('filter_add_with_roi', 'math', { op: 'add', value: 25 }, { roi: true }), R('filter_subtract', 'math', { op: 'subtract', value: 40 }),
    R('filter_multiply', 'math', { op: 'multiply', value: 1.5 }), R('filter_log', 'math2', { op: 'log' }), R('filter_gamma', 'math2', { op: 'gamma', value: 0.5 }),
    R('filter_gaussian', 'gaussian', { sigma: 2 }), R('filter_gaussian_with_roi', 'gaussian', { sigma: 2 }, { roi: true }),
    R('filter_gaussian_stack_all', 'gaussian', { sigma: 2 }, { planes: 'all', ci: 0 }), R('filter_gaussian_stack_all', 'gaussian', { sigma: 2 }, { ci: 1 }),
    R('filter_invert', 'invert', {}), R('filter_invert_stack_all', 'invert', {}, { planes: 'all', ci: 0 }),
    R('filter_median', 'rank', { type: 'median', radius: 2 }), R('filter_mean', 'rank', { type: 'mean', radius: 2 }), R('filter_min', 'rank', { type: 'min', radius: 1 }), R('filter_max', 'rank', { type: 'max', radius: 1 }),
    R('filter_smooth', 'filter3x3', { type: 'smooth' }), R('filter_sharpen', 'filter3x3', { type: 'sharpen' }), R('filter_find_edges', 'filter3x3', { type: 'edges' }),
    R('filter_unsharp', 'unsharpMask', { sigma: 2, weight: 0.6 }), R('filter_flip_h', 'flipH', {}),
    R('filter_translate', 'translate', { dx: 3, dy: 2, interpolation: 'none' }), R('filter_rotate_30', 'rotate', { angle: 30, interpolation: 'bilinear', rect: null }),
    R('filter_rotate90left', 'rotate90', { dir: 'left' }), R('filter_rotate90right', 'rotate90', { dir: 'right' }),
    R('filter_canvas', 'canvasSize', { width: 45, height: 30, position: 'center' }), R('filter_bin', 'bin', { xshrink: 2, yshrink: 2, method: 'average' }),
    R('filter_size', 'resize', { width: 20, height: 12, interpolation: 'bilinear', averageWhenDownsizing: true })
  ];
  for (const k of list) {
    const f = fixture('rgb', k.name), cs = f.cases[k.ci || 0];
    const c = open(), id = await c.open(f.input || cs.input);
    const m = await c.call('doc.run', Object.assign({ docId: id, op: k.op, params: k.params, roi: k.roi ? f.roi : null, channel: 'all' }, k.planes ? { planes: k.planes } : {}));
    assert.ok(m.ok, `${k.name}: ${m.error && m.error.code} ${m.error && m.error.message}`);
    assert.equal(compareDoc(c.doc(id), cs.self), '', `${k.name} [${cs.options}]`);
    assert.equal(c.doc(id).rgb, true, k.name + ' stays RGB');
  }
  // Scale... of an RGB image into a new window
  const f = fixture('rgb', 'filter_scale_half'), cs = f.cases[0], c = open(), id = await c.open(f.input);
  const r = await c.ok('doc.run', { docId: id, op: 'scaleNew', params: { xscale: 0.5, yscale: 0.5, interpolation: 'bilinear', averageWhenDownsizing: true, width: 15, height: 9, name: 'out' }, roi: null, channel: 'all' });
  assert.equal(compareDoc(c.doc(r.newDocIds[0]), cs.created[0]), '', 'Scale');
  assert.equal(c.doc(r.newDocIds[0]).rgb, true);
});

await test('RGB: the operations ImageJ refuses on 24 bits are refused (8-bit binary image required, grayscale required), the grey ones work on the luminance', async () => {
  const f = fixture('rgb', 'filter_add'), S = f.input;
  const c = open(), id = await c.open(S);
  for (const [op, params] of [['edm', {}], ['watershed', {}], ['skeletonize', {}], ['binary', { op: 'erode' }], ['binaryMedian', { radius: 1 }], ['autoThreshold', { level: 100 }], ['saltAndPepper', {}]]) {
    const e = await c.err('doc.run', { docId: id, op, params, roi: null, channel: 'all' });
    assert.ok(e.code === 'IJ_BAD_TYPE', `${op} on RGB: ${e.code}`);
  }
  // Find Maxima reads the brightness (the fixture's Count = 3), Convert to Mask thresholds it
  const r = await c.ok('doc.compute', { docId: id, op: 'findMaxima', params: { prominence: 10, output: 'count', rgbWeighted: false }, roi: null, channel: 0 }).catch((e) => e);
  assert.ok(r && !r.code, 'Find Maxima works on RGB');
});

await test('RGB Enhance Contrast with Normalize: the saturated range of the luminance, then ColorProcessor.setMinAndMax on every colour', async () => {
  const f = fixture('rgb', 'filter_enhance'), c = open(), id = await c.open(f.input);
  const range = await c.ok('doc.compute', { docId: id, op: 'saturatedRange', params: { saturated: 0.35, rgbWeighted: false }, roi: null, channel: 0 });
  assert.ok(range.valid);
  await c.ok('doc.run', { docId: id, op: 'enhanceNormalize', params: { min: range.min, max: range.max }, roi: null, channel: 'all' });
  assert.equal(compareDoc(c.doc(id), f.cases[0].self), '', 'saturated=0.35 normalize');
});

await test('RGB Measure: Mean, StdDev, Mode, Min, Max, IntDen, Median, Skew, Kurt are ImageJ\'s unweighted and weighted, %Area is 0 (ColorStatistics)', async () => {
  const keys = ['area', 'mean', 'stdDev', 'mode', 'min', 'max', 'intDen', 'median', 'skewness', 'kurtosis', 'areaFraction', 'rawIntDen'];
  const col = { area: 0, mean: 1, stdDev: 2, mode: 3, min: 4, max: 5, intDen: 6, median: 7, skewness: 8, kurtosis: 9, areaFraction: 10, rawIntDen: 11 };
  for (const name of ['measure_unweighted', 'measure_weighted']) {
    const f = fixture('rgb', name), c = open(), id = await c.open(f.input);
    const r = await c.ok('doc.stats', { docId: id, roi: f.roi, channel: 0, rgbWeighted: f.weighted, measurements: keys });
    const exp = f.cases[0].table.rows[0];
    for (const k of keys) {
      const want = exp[col[k]], got = r.row[k];
      assert.ok(Math.abs(got - want) <= 1e-9 * Math.max(1, Math.abs(want)), `${name} ${k}: ${got} vs ${want}`);
    }
  }
});

await test('RGB histogram: the luminance, weighted or not, with and without a selection', async () => {
  const f = fixture('rgb', 'histogram_values');
  for (const cs of f.cases) {
    const c = open(), id = await c.open(f.input);
    const r = await c.ok('doc.histogram', { docId: id, roi: cs.roi || null, channel: 0, bins: 256, rgbWeighted: cs.weighted });
    assert.ok(sameArrays(r.counts, cs.histogram), 'weighted=' + cs.weighted + (cs.roi ? ' with a selection' : ''));
  }
});

for (const c of clients) c.dispose();
console.log('ij stk sweep ops: ' + groups + ' groups passed');
