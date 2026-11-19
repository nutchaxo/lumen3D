// P-io — the roiSetOp operation (the ROI Manager's AND / OR (Combine) / XOR / Split) on its own: the pixels of the result against masks
// built independently, ImageJ's rules for points and lines, trySimplify, the refusals, the inputs left untouched, cancel.
//
// Run: node tests/js/test_ij_io_roiops.mjs
import assert from 'node:assert/strict';
import { loadIo, maskOf } from './ij_io_support.mjs';

const ctx = loadIo();
const R = ctx.IJOpRegistry, IJRoi = ctx.IJRoi;
const spec = R.get('roiSetOp');
let n = 0;
const test = async (name, fn) => { try { await fn(); n++; } catch (err) { console.error('FAIL', name); throw err; } };
const J = (x) => JSON.parse(JSON.stringify(x));
const view = { id: 'v', name: 'v', width: 64, height: 48, bitDepth: 8, calibration: { pixelWidth: 1, pixelHeight: 1, unit: 'px' }, active: 0, channels: [{ data: new Uint8Array(64 * 48), name: 'C1', color: '#fff', display: {} }] };
const fakeIo = (over = {}) => ({ channel: 0, checks: 0, check() { this.checks++; if (this.cancelAt && this.checks >= this.cancelAt) throw Object.assign(new Error('c'), { code: 'IJ_CANCELLED' }); }, tick: async () => {}, reserve() {}, release() {}, ...over });
const run = (params, io) => spec.run(view, params, null, io || fakeIo());
const W = 64, H = 48;
// an independent dense mask of a ROI (centres of the pixels inside): rect and polygon by their own formulae, a mask ROI by its runs
function dense(roi) {
  const f = new Uint8Array(W * H);
  const set = (x, y) => { if (x >= 0 && y >= 0 && x < W && y < H) f[y * W + x] = 1; };
  if (roi.type === 'rect') { for (let y = roi.y; y < roi.y + roi.h; y++) for (let x = roi.x; x < roi.x + roi.w; x++) set(x, y); }
  else if (roi.type === 'oval') { const a = roi.w / 2, b = roi.h / 2, cx = roi.x + a, cy = roi.y + b; for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const dx = (x + 0.5 - cx) / a, dy = (y + 0.5 - cy) / b; if (dx * dx + dy * dy <= 1 + 1e-9) set(x, y); } }
  else if (roi.type === 'point') for (const p of roi.points) set(Math.floor(p[0]), Math.floor(p[1]));
  else if (roi.type === 'mask') { let pos = 0, bit = 0; for (const run of roi.rle) { if (bit) for (let k = pos; k < pos + run; k++) set(roi.x + (k % roi.w), roi.y + Math.floor(k / roi.w)); pos += run; bit ^= 1; } }
  else if (roi.type === 'polygon') { const m = IJRoi.mask(roi); for (let j = 0; j < m.h; j++) for (let i = 0; i < m.w; i++) if (m.data[j * m.w + i]) set(m.x + i, m.y + j); }
  return f;
}
const same = (got, want, what) => { let bad = 0; for (let i = 0; i < want.length; i++) if (got[i] !== want[i]) bad++; assert.equal(bad, 0, `${what}: ${bad} pixels differ`); };
const A = { type: 'rect', x: 4, y: 4, w: 20, h: 14 };
const B = { type: 'oval', x: 14, y: 8, w: 24, h: 20 };
const Cr = { type: 'polygon', points: [[30, 5], [55, 12], [48, 40], [26, 30]] };
const D = { type: 'rect', x: 40, y: 2, w: 8, h: 6 };
const deepFreeze = (o) => { if (o && typeof o === 'object') { Object.freeze(o); for (const k of Object.keys(o)) if (!(ArrayBuffer.isView(o[k]))) deepFreeze(o[k]); } return o; };

await test('AND, OR and XOR give the pixels of the logical combination of the masks, for two and for several selections', async () => {
  const [a, b, c] = [A, B, Cr].map(dense);
  for (const [op, f] of [['and', (x, y, z) => x & y], ['or', (x, y) => x | y], ['xor', (x, y) => x ^ y]]) {
    const res = await run({ op, rois: [A, B] });
    assert.ok(res.roi, op);
    same(dense(res.roi), a.map((v, i) => f(v, b[i])), op + ' of two');
  }
  same(dense((await run({ op: 'and', rois: [A, B, Cr] })).roi || { type: 'point', points: [] }), a.map((v, i) => v & b[i] & c[i]), 'AND of three');
  same(dense((await run({ op: 'or', rois: [A, B, Cr] })).roi), a.map((v, i) => v | b[i] | c[i]), 'OR of three');
  same(dense((await run({ op: 'xor', rois: [A, B, Cr] })).roi), a.map((v, i) => v ^ b[i] ^ c[i]), 'XOR of three: odd coverage');
  // a ROI of another position partly outside the image still combines (nothing is clipped to the image)
  const out = { type: 'rect', x: -5, y: -3, w: 12, h: 9 };
  const res = await run({ op: 'or', rois: [out, A] });
  const m = IJRoi.mask(res.roi);
  assert.ok(m.x <= -5 && m.y <= -3);
});

await test('the result is simplified as ShapeRoi.trySimplify: a rectangle, a traced polygon, else a mask', async () => {
  const r1 = await run({ op: 'and', rois: [{ type: 'rect', x: 2, y: 2, w: 10, h: 10 }, { type: 'rect', x: 6, y: 6, w: 10, h: 10 }] });
  assert.deepEqual(J(r1.roi), { type: 'rect', x: 6, y: 6, w: 6, h: 6 });
  // a 3x3 square is too small for guessType's rectangle rule (average edge length): a traced polygon of four vertices
  const small = await run({ op: 'and', rois: [{ type: 'rect', x: 2, y: 2, w: 3, h: 3 }, { type: 'rect', x: 0, y: 0, w: 10, h: 10 }] });
  assert.equal(small.roi.type, 'polygon'); assert.equal(small.roi.traced, true); assert.equal(small.roi.points.length, 4);
  const l = await run({ op: 'or', rois: [{ type: 'rect', x: 2, y: 2, w: 10, h: 10 }, { type: 'rect', x: 6, y: 6, w: 10, h: 10 }] });
  assert.equal(l.roi.type, 'polygon'); assert.equal(l.roi.traced, true);
  assert.equal(l.roi.points.length, 8, 'the L-like union has eight corners');
  const two = await run({ op: 'or', rois: [A, D] });
  assert.equal(two.roi.type, 'mask', 'two parts stay a composite');
  const holed = await run({ op: 'xor', rois: [{ type: 'rect', x: 2, y: 2, w: 20, h: 20 }, { type: 'rect', x: 8, y: 8, w: 6, h: 6 }] });
  assert.equal(holed.roi.type, 'mask', 'a hole: a composite');
  assert.equal(IJRoi.area(holed.roi), 20 * 20 - 36);
  // nothing in common: no selection
  assert.deepEqual(J(await run({ op: 'and', rois: [A, D] })), { roi: null });
  assert.deepEqual(J(await run({ op: 'xor', rois: [A, A] })), { roi: null });
});

await test('points: OR gathers them, AND with one point selection keeps the points inside the areas', async () => {
  const P1 = { type: 'point', points: [[5, 5], [30, 30]] }, P2 = { type: 'point', points: [[7.5, 8]] };
  const or = await run({ op: 'or', rois: [P1, P2] });
  assert.deepEqual(J(or.roi), { type: 'point', points: [[5, 5], [30, 30], [7.5, 8]] });
  const and = await run({ op: 'and', rois: [A, P1] });
  assert.deepEqual(J(and.roi), { type: 'point', points: [[5, 5]] }, '"the points inside all selected area rois are kept"');
  assert.deepEqual(J(await run({ op: 'and', rois: [P1, A, B] })), { roi: null }, 'the points are in the rectangle or the oval, not in both');
  assert.deepEqual(J(await run({ op: 'and', rois: [A, { type: 'point', points: [[60, 40]] }] })), { roi: null }, 'no point left');
  // two point selections in an AND are areas (one pixel each): their common pixels
  const both = await run({ op: 'and', rois: [P1, { type: 'point', points: [[5.9, 5.1], [31, 31]] }] });
  assert.equal(both.roi.type, 'polygon', 'one pixel: four corners, too short for the rectangle rule');
  assert.equal(IJRoi.area(both.roi), 1);
  // a point and an area in an OR / XOR: the pixel is an area
  const mixed = await run({ op: 'or', rois: [A, P1] });
  assert.equal(mixed.roi.type, 'mask');
  assert.equal(IJRoi.area(mixed.roi), 20 * 14 + 1);
});

await test('lines become areas first (Roi.convertLineToArea): a straight line by its width, a segmented line by its segments', async () => {
  const line = { type: 'line', x1: 10, y1: 30, x2: 40, y2: 30, width: 3 };
  const res = await run({ op: 'or', rois: [A, line] });
  const lm = dense({ type: 'polygon', points: [[10, 28.5], [40, 28.5], [40, 31.5], [10, 31.5]] });
  const got = dense(res.roi), a = dense(A);
  same(got, a.map((v, i) => v | lm[i]), 'rectangle of the line\'s width');
  const poly = { type: 'polyline', points: [[10, 40], [20, 40], [20, 46]], width: 2 };
  const r2 = await run({ op: 'or', rois: [A, poly] });
  assert.ok(IJRoi.area(r2.roi) > 20 * 14 + 10);
  const ang = { type: 'angle', points: [[40, 20], [50, 20], [50, 30]] };
  assert.ok((await run({ op: 'or', rois: [A, ang] })).roi);
});

await test('Split: one selection per outline, holes included, as ImageJ\'s getRois', async () => {
  const comp = (await run({ op: 'xor', rois: [{ type: 'rect', x: 2, y: 2, w: 20, h: 20 }, { type: 'rect', x: 8, y: 8, w: 6, h: 6 }] })).roi;
  const parts = (await run({ op: 'split', rois: [comp] })).rois;
  assert.equal(parts.length, 2);
  assert.deepEqual(J(parts.map((p) => IJRoi.area(p)).sort((x, y) => x - y)), [36, 400]);
  const twoMask = (await run({ op: 'or', rois: [A, D] })).roi;
  const sp = (await run({ op: 'split', rois: [twoMask] })).rois;
  assert.deepEqual(J(sp.map((p) => p.type).sort()), ['rect', 'rect']);
  assert.deepEqual(J(sp).sort((p, q) => p.x - q.x), [A, D].map((r) => J(r)));
  // a 3-pixel-wide shape: polygons, not rectangles
  const thin = maskOf(ctx, ['#.#', '#.#'], 4, 4);
  const sp2 = (await run({ op: 'split', rois: [{ type: 'mask', ...thin }] })).rois;
  assert.equal(sp2.length, 2); assert.ok(sp2.every((p) => p.type === 'polygon' && p.traced));
  // a plain selection is no composite
  await assert.rejects(run({ op: 'split', rois: [A] }), (e) => e.code === 'IJ_IO_NEEDS_COMPOSITE');
});

await test('validation, caps, immutability and cancel', async () => {
  const bad = (p) => assert.throws(() => spec.validate(p), (e) => e.code === 'IJ_BAD_ARGS' || e.code === 'IJ_BAD_ROI');
  bad(null); bad({ op: 'nand', rois: [A, B] }); bad({ op: 'and', rois: [A] }); bad({ op: 'and', rois: 'x' }); bad({ op: 'or', rois: [A, { type: 'bogus' }] });
  spec.validate({ op: 'split', rois: [A] });
  // a combination too large to rasterise is refused, not attempted
  await assert.rejects(run({ op: 'or', rois: [{ type: 'rect', x: 0, y: 0, w: 20000, h: 20000 }, A] }), (e) => e.code === 'IJ_IO_TOO_LARGE');
  // the inputs are never written (frozen copies would throw in strict mode)
  const frozen = deepFreeze(J([A, B, Cr]));
  const before = JSON.stringify(frozen);
  await run({ op: 'xor', rois: frozen });
  assert.equal(JSON.stringify(frozen), before);
  // cancel
  const io = fakeIo({ cancelAt: 2 });
  await assert.rejects(run({ op: 'or', rois: [A, B, Cr] }, io), (e) => e.code === 'IJ_CANCELLED');
  // determinism: the same call twice, the same bytes
  const x = await run({ op: 'xor', rois: [A, B, Cr] }), y = await run({ op: 'xor', rois: [A, B, Cr] });
  assert.equal(JSON.stringify(Array.from(x.roi.rle || [])) + JSON.stringify(x.roi.points || null), JSON.stringify(Array.from(y.roi.rle || [])) + JSON.stringify(y.roi.points || null));
  assert.ok(spec.scratchBytes({ width: 1, height: 1, bitDepth: 8 }, { op: 'or', rois: [A, B] }) > 0);
  assert.equal(spec.kind, 'compute');
});

await test('many selections: the memory is one accumulator and one layer over the union box, not a layer per selection', async () => {
  const rois = [];
  for (let k = 0; k < 101; k++) rois.push({ type: 'rect', x: (k % 10) * 290 + 3, y: Math.floor(k / 10) * 290 + 3, w: 6, h: 6 });
  const union = 2900 * 2900;
  const declared = spec.scratchBytes({ width: 4000, height: 4000, bitDepth: 8 }, { op: 'or', rois });
  assert.ok(declared >= 2 * 2600 * 2600 && declared <= 2 * 3000 * 3000, 'declared 2*W*H of the union box: ' + declared);
  let peak = 0;
  const base = process.memoryUsage().arrayBuffers;
  const io = fakeIo({ check() { const m = process.memoryUsage().arrayBuffers - base; if (m > peak) peak = m; } });
  // the peak is read on the first run only: a later run would count buffers the collector has not freed yet
  for (const op of ['or', 'xor', 'and']) {
    peak = 0;
    const res = await run({ op, rois }, io);
    if (op === 'or') assert.ok(peak < 2.6 * union, op + ': peak ' + peak + ' bytes against ' + union + ' for the union box');
    if (op === 'or') assert.ok(res.roi, 'a composite of 101 squares');
    if (op === 'and') assert.equal(res.roi, null, 'disjoint squares: nothing left');
  }
});

console.log(`ok test_ij_io_roiops (${n} groups)`);
