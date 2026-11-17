// Package P1 (bg) of the Advanced Studio: Subtract Background and Enhance Contrast against the golden fixtures
// recorded with ImageJ 1.54p (tests/fixtures/ij-wave2/bg/, 88 files), through the REAL engine
// (ij-engine.js + ij-core + ij-analysis + ij-proc-shared + ij-proc-bg) in a vm sandbox, with `verifyInputs`
// (an op that writes into an input array fails with IJ_INTERNAL).
//
// What is compared
//   * subtractBackground (57): every rolling-ball / sliding-paraboloid case, 8, 16 and 32 bits, light / dark,
//     create background, smoothing off, corners off, a selection (ignored by ImageJ: the whole image is processed).
//     Integer outputs must be IDENTICAL; 32-bit outputs are compared bit for bit (Java float arithmetic is
//     reproduced with Math.fround at every step, so no tolerance is needed — any mismatch is listed).
//   * saturatedRange (10), enhanceNormalize (15), enhanceEqualize (6): the display range / the pixels.
//     Normalize and Equalize are driven the way the command drives them (compute saturatedRange with the
//     selection, then run the pixel op with or without the selection).
//   * determinism: the same result whatever the band height (1 row, 7 rows, the whole image) and the engine
//     never writes into its inputs.
//
// Run: node tests/js/test_ij_bg_fixtures.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT } from './harness.mjs';

const DIR = path.join(ROOT, 'js', 'modules', 'studio', 'advanced-studio');
const FIX = path.join(ROOT, 'tests', 'fixtures', 'ij-wave2', 'bg');

// ── the engine in a sandbox ──
const sandbox = { console, setTimeout, clearTimeout, MessageChannel, performance, TextEncoder, TextDecoder };
sandbox.self = sandbox;
vm.createContext(sandbox);
for (const f of ['ij-core.js', 'ij-analysis.js', 'ij-proc-shared.js', 'ij-engine.js', 'ij-proc-bg.js']) vm.runInContext(fs.readFileSync(path.join(DIR, f), 'utf8'), sandbox, { filename: f });
// A test-only size op that replaces a document's channels with given arrays (how a fixture image enters the engine).
vm.runInContext(`IJOpRegistry.define('bgTestLoad', { kind: 'size', version: 1,
  async run(view, params) { return { width: params.width, height: params.height, bitDepth: params.bitDepth, channels: params.channels.map((d, i) => ({ data: d, name: 'C' + (i + 1), color: '#ffffff' })) }; } });`, sandbox);
const { IJEngine, IJRoi, IJBg } = sandbox;
assert.ok(IJEngine && IJBg && IJRoi, 'modules loaded');

const closers = [];
function client(opts = {}) {
  const waiters = new Map();
  let n = 0, lastRun = 0;
  const fake = { navigator: {}, onmessage: null, postMessage(m) { if (m.id !== undefined && 'ok' in m) { const w = waiters.get(m.id); if (w) { waiters.delete(m.id); w(m); } } } };
  const eng = IJEngine.start(fake, Object.assign({ storage: 'memory', idleMs: 3600000, bandPixels: 1 << 20, adaptive: false, verifyInputs: true }, opts));
  closers.push(() => eng.dispose());
  const c = {
    call(cmd, args) { return new Promise((res) => { const id = ++n; if (cmd !== 'cancel') lastRun = id; waiters.set(id, res); fake.onmessage({ data: { id, cmd, args } }); }); },
    lastRunId: () => lastRun,
    async ok(cmd, args) { const m = await c.call(cmd, args); assert.ok(m.ok, `${cmd} failed: ${m.error && m.error.code}`); return m.result; },
    async err(cmd, args) { const m = await c.call(cmd, args); assert.ok(!m.ok, `${cmd} should have failed`); return m.error; },
    async load(image, channels) {
      const bd = image.bitDepth;
      const { docId } = await c.ok('doc.create', { name: 'fx', width: 1, height: 1, bitDepth: 8, channels: [{ name: 'A', color: '#fff' }] });
      await c.ok('doc.run', { docId, op: 'bgTestLoad', params: { width: image.width, height: image.height, bitDepth: bd, channels: channels || [typed(image)] }, roi: null, channel: 0 });
      return docId;
    },
    async pixels(docId, ch = 0) { return (await c.ok('doc.tile', { docId, channel: ch, level: 0, tx: 0, ty: 0 })).data; }
  };
  return c;
}

// ── fixture decoding (tools/ij_fixtures/README.md) ──
function decodeData(d) {
  if (Array.isArray(d)) return Float64Array.from(d, (v) => (v === null ? NaN : v));
  const b = Buffer.from(d.b64, 'base64');
  const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  return d.dtype === 'u8' ? new Uint8Array(ab) : d.dtype === 'u16' ? new Uint16Array(ab) : new Float32Array(ab);
}
function typed(img) {
  const raw = decodeData(img.data);
  if (img.bitDepth === 8) return Uint8Array.from(raw);
  if (img.bitDepth === 16) return Uint16Array.from(raw);
  return Float32Array.from(raw); // plain floats are the shortest repr of a float32
}
const typedWith = (img) => ({ width: img.width, height: img.height, bitDepth: img.bitDepth, data: typed(img) });
function roiOf(r, W, H) {
  if (!r) return null;
  if (r.type === 'rect') return { type: 'rect', x: r.x, y: r.y, w: r.w, h: r.h };
  // oval / polygon: ImageJ's own rasterisation, as the exact pixel set
  const m = r.mask;
  const md = decodeData(m.data);
  const full = new Uint8Array(W * H);
  for (let y = 0; y < m.h; y++) for (let x = 0; x < m.w; x++) if (md[y * m.w + x]) full[(y + m.y) * W + (x + m.x)] = 1;
  return IJRoi.fromMask(full, W, H);
}
const boundsOf = (roi) => roi && roi.type !== 'line' ? { x: roi.x, y: roi.y, w: roi.w, h: roi.h } : null;

function diff(actual, expected) {
  let bad = 0, maxAbs = 0, first = -1;
  for (let i = 0; i < expected.length; i++) {
    const a = actual[i], e = expected[i];
    if (Object.is(a, e) || (a === e) || (a !== a && e !== e)) continue;
    bad++;
    if (first < 0) first = i;
    const d = Math.abs(a - e);
    if (d > maxAbs) maxAbs = d;
  }
  return { bad, maxAbs, first };
}

// ── run one fixture through the engine, the way the command drives it ──
async function run(c, f) {
  const img = f.input;
  const W = img.width, H = img.height, bd = img.bitDepth;
  const docId = await c.load(img);
  const roi = roiOf(f.roi, W, H);
  const p = f.params;
  switch (f.op) {
    case 'subtractBackground':
      await c.ok('doc.run', { docId, op: 'subtractBackground', params: { radius: p.radius, light: p.light, createBackground: p.createBackground, sliding: p.sliding, disableSmoothing: p.disableSmoothing, correctCorners: p.correctCorners }, roi, channel: 0 });
      return { pixels: await c.pixels(docId) };
    case 'saturatedRange': {
      const r = await c.ok('doc.compute', { docId, op: 'saturatedRange', params: { saturated: p.saturated }, roi, channel: 0 });
      return { range: r };
    }
    case 'enhanceNormalize': {
      const r = await c.ok('doc.compute', { docId, op: 'saturatedRange', params: { saturated: p.saturated }, roi, channel: 0 });
      assert.ok(r.valid, f.case + ': a valid range');
      // command: updateSelectionOnly = area selection && !entireImage; a 32-bit image is always normalised whole
      const selectionOnly = !!roi && !p.entireImage && bd !== 32;
      await c.ok('doc.run', { docId, op: 'enhanceNormalize', params: { min: r.min, max: r.max }, roi: selectionOnly ? roi : null, channel: 0 });
      return { pixels: await c.pixels(docId), range: r };
    }
    case 'enhanceEqualize':
      await c.ok('doc.run', { docId, op: 'enhanceEqualize', params: { classic: p.classic, rect: boundsOf(roi) }, roi: null, channel: 0 });
      return { pixels: await c.pixels(docId) };
    default: throw new Error('unknown fixture op ' + f.op);
  }
}

// ── 1. every fixture ──
const files = fs.readdirSync(FIX).filter((x) => x.endsWith('.json')).sort();
assert.equal(files.length, 88, 'the 88 golden fixtures of package bg');
const stat = { total: 0, exact: 0, mismatches: [] };
const byOp = {};
{
  const c = client();
  for (const file of files) {
    const f = JSON.parse(fs.readFileSync(path.join(FIX, file), 'utf8'));
    assert.equal(f.imagej, '1.54p');
    const out = await run(c, f);
    stat.total++;
    byOp[f.op] = byOp[f.op] || { total: 0, exact: 0 };
    byOp[f.op].total++;
    let ok = true, why = '';
    if (f.op === 'saturatedRange') {
      const e = f.result;
      ok = out.range.valid && out.range.displayMin === e.displayMin && out.range.displayMax === e.displayMax;
      if (!ok) why = `display range ${out.range.displayMin}..${out.range.displayMax} vs ${e.displayMin}..${e.displayMax}`;
    } else {
      const expected = typed(f.output);
      const d = diff(out.pixels, expected);
      ok = d.bad === 0 && out.pixels.length === expected.length;
      if (!ok) why = `${d.bad}/${expected.length} pixels differ, max |Δ| ${d.maxAbs}, first at ${d.first}`;
      if (ok && f.op === 'enhanceNormalize') {
        // run(): ip.setMinAndMax(0, 1.0 | maxValue()) — the command's display after Normalize
        const max = bdOf(f) === 32 ? 1 : bdOf(f) === 16 ? 65535 : 255;
        assert.deepEqual({ min: 0, max }, f.displayRange, f.case + ': the display range after Normalize');
      }
    }
    if (ok) { stat.exact++; byOp[f.op].exact++; } else stat.mismatches.push(`${f.case}: ${why}`);
  }
}
function bdOf(f) { return f.input.bitDepth; }
console.log('fixtures:', JSON.stringify(byOp), `${stat.exact}/${stat.total} exact`);
for (const m of stat.mismatches) console.log('  MISMATCH ' + m);
assert.equal(stat.mismatches.length, 0, 'every golden fixture matches ImageJ 1.54p value for value:\n' + stat.mismatches.join('\n'));
assert.equal(byOp.subtractBackground.total, 57);
assert.equal(byOp.saturatedRange.total, 10);
assert.equal(byOp.enhanceNormalize.total, 15);
assert.equal(byOp.enhanceEqualize.total, 6);

// ── 2. the selection is ignored by Subtract Background (ImageJ: no SUPPORTS_MASKING) ──
{
  const c = client();
  const a = JSON.parse(fs.readFileSync(path.join(FIX, 'rb_r12_dark_roi_rect_u8.json'), 'utf8'));
  const b = JSON.parse(fs.readFileSync(path.join(FIX, 'rb_r12_dark_u8.json'), 'utf8'));
  assert.notDeepEqual(a.input.data, b.input.data, 'different inputs');
  const docId = await c.load(a.input);
  await c.ok('doc.run', { docId, op: 'subtractBackground', params: a.params, roi: roiOf(a.roi, 64, 48), channel: 0 });
  const withRoi = await c.pixels(docId);
  const docId2 = await c.load(a.input);
  await c.ok('doc.run', { docId: docId2, op: 'subtractBackground', params: a.params, roi: null, channel: 0 });
  assert.deepEqual(Array.from(withRoi), Array.from(await c.pixels(docId2)), 'a selection changes nothing');
  const inside = typed(a.input), out = withRoi;
  let changedOutside = 0;
  for (let y = 0; y < 48; y++) for (let x = 0; x < 64; x++) if (!(x >= 10 && x < 40 && y >= 8 && y < 30) && out[y * 64 + x] !== inside[y * 64 + x]) changedOutside++;
  assert.ok(changedOutside > 500, 'pixels outside the selection are processed too (' + changedOutside + ')');
}

// ── 3. determinism: the band height changes nothing; inputs are never written ──
{
  const pick = ['rb_r12_dark_u8', 'rb_r50_light_u16', 'para_r12_dark_f32', 'rb_r12_dark_create_u8', 'normalize_u16_035', 'normalize_roi_oval_sel_u8', 'normalize_f32_2', 'equalize_sqrt_u16', 'equalize_roi_rect_u8'];
  for (const name of pick) {
    const f = JSON.parse(fs.readFileSync(path.join(FIX, name + '.json'), 'utf8'));
    const W = f.input.width;
    const outs = [];
    for (const bandPixels of [W, W * 7, 1 << 20]) {
      const c = client({ bandPixels });
      outs.push(Array.from((await run(c, f)).pixels));
    }
    assert.deepEqual(outs[1], outs[0], name + ': 7-row bands = 1-row bands');
    assert.deepEqual(outs[2], outs[0], name + ': the whole image = 1-row bands');
    assert.deepEqual(outs[0], Array.from(typed(f.output)), name + ': and = ImageJ');
  }
  // the input array of the document is not modified by the op (verifyInputs would have thrown IJ_INTERNAL) and an
  // undo gives it back byte for byte
  const f = JSON.parse(fs.readFileSync(path.join(FIX, 'rb_r12_dark_u16.json'), 'utf8'));
  const c = client();
  const docId = await c.load(f.input);
  const before = Array.from(await c.pixels(docId));
  await c.ok('doc.run', { docId, op: 'subtractBackground', params: f.params, roi: null, channel: 0 });
  assert.notDeepEqual(Array.from(await c.pixels(docId)), before);
  await c.ok('doc.undo', { docId });
  assert.deepEqual(Array.from(await c.pixels(docId)), before, 'undo restores the input');
}

// ── 4. a multi-channel document: each channel is its own background; the channel argument selects ──
{
  const a = JSON.parse(fs.readFileSync(path.join(FIX, 'rb_r12_dark_u8.json'), 'utf8'));
  const b = JSON.parse(fs.readFileSync(path.join(FIX, 'rb_r12_light_u8.json'), 'utf8'));
  const c = client();
  const docId = await c.load(a.input, [typed(a.input), typed(b.input)]);
  await c.ok('doc.run', { docId, op: 'subtractBackground', params: a.params, roi: null, channel: 'all' });
  assert.deepEqual(Array.from(await c.pixels(docId, 0)), Array.from(typed(a.output)), 'channel 0');
  const docB = await c.load(b.input);
  await c.ok('doc.run', { docId: docB, op: 'subtractBackground', params: a.params, roi: null, channel: 0 });
  assert.deepEqual(Array.from(await c.pixels(docId, 1)), Array.from(await c.pixels(docB, 0)), 'channel 1 = the same image alone');
  // one channel only
  const doc2 = await c.load(a.input, [typed(a.input), typed(b.input)]);
  await c.ok('doc.run', { docId: doc2, op: 'subtractBackground', params: a.params, roi: null, channel: 1 });
  assert.deepEqual(Array.from(await c.pixels(doc2, 0)), Array.from(typed(a.input)), 'the other channel is untouched');
}

// ── 5. an inverting LUT = the light-background convention flipped ──
{
  const f = JSON.parse(fs.readFileSync(path.join(FIX, 'rb_r12_light_u8.json'), 'utf8'));
  const c = client();
  const plain = await c.load(f.input);
  await c.ok('doc.run', { docId: plain, op: 'subtractBackground', params: Object.assign({}, f.params, { light: false }), roi: null, channel: 0 });
  const inv = await c.load(f.input);
  await c.ok('doc.setDisplay', { docId: inv, channel: 0, invert: true });
  await c.ok('doc.run', { docId: inv, op: 'subtractBackground', params: Object.assign({}, f.params, { light: false }), roi: null, channel: 0 });
  const light = await c.load(f.input);
  await c.ok('doc.run', { docId: light, op: 'subtractBackground', params: f.params, roi: null, channel: 0 });
  assert.deepEqual(Array.from(await c.pixels(inv)), Array.from(await c.pixels(light)), 'inverted LUT + dark = light background on a normal LUT');
  assert.notDeepEqual(Array.from(await c.pixels(inv)), Array.from(await c.pixels(plain)));
  assert.deepEqual(Array.from(await c.pixels(light)), Array.from(typed(f.output)), 'and = ImageJ');
  // the journaled params carry the LUT state: a replay does not depend on the display
  const j = await c.ok('doc.info', { docId: inv });
  assert.ok(j.undoDepth >= 1);
}

// ── 6. refusals, error codes, estimate ──
{
  const c = client();
  const f = JSON.parse(fs.readFileSync(path.join(FIX, 'rb_r12_dark_u8.json'), 'utf8'));
  const docId = await c.load(f.input);
  const code = async (cmd, args) => (await c.err(cmd, args)).code;
  const sb = (params) => ({ docId, op: 'subtractBackground', params: Object.assign({}, f.params, params), roi: null, channel: 0 });
  assert.equal(await code('doc.run', sb({ radius: 0 })), 'IJ_BAD_ARGS', 'radius 0');
  assert.equal(await code('doc.run', sb({ radius: 0.0001 })), 'IJ_BAD_ARGS', 'ImageJ: radius <= 0.0001 is invalid');
  assert.equal(await code('doc.run', sb({ radius: NaN })), 'IJ_BAD_ARGS');
  assert.equal(await code('doc.run', sb({ radius: '12' })), 'IJ_BAD_ARGS');
  assert.equal(await code('doc.run', sb({ radius: 1e6 })), 'IJ_BAD_ARGS', 'a radius that would run for hours');
  assert.equal(await code('doc.run', sb({ light: 1 })), 'IJ_BAD_ARGS');
  assert.equal(await code('doc.run', sb({ sliding: 'yes' })), 'IJ_BAD_ARGS');
  // ImageJ throws ArrayIndexOutOfBounds when the shrunken image has fewer than 2 pixels: a clear refusal here
  const tiny = await c.load({ width: 8, height: 8, bitDepth: 8 }, [new Uint8Array(64).fill(9)]);
  assert.equal(await code('doc.run', { docId: tiny, op: 'subtractBackground', params: Object.assign({}, f.params, { radius: 300 }), roi: null, channel: 0 }), 'IJ_BG_TOO_SMALL');
  // a shrunken height of 1 is not a crash in ImageJ (line0 stays zero): 400 x 3 at radius 50 -> 100 x 1 runs
  const flatImg = await c.load({ width: 400, height: 3, bitDepth: 8 }, [Uint8Array.from({ length: 1200 }, (_, i) => (i * 7) % 200)]);
  await c.ok('doc.run', { docId: flatImg, op: 'subtractBackground', params: Object.assign({}, f.params, { radius: 50 }), roi: null, channel: 0 });
  await c.ok('doc.run', { docId: tiny, op: 'subtractBackground', params: Object.assign({}, f.params, { radius: 300, sliding: true }), roi: null, channel: 0 }); // the paraboloid has no such limit
  await c.ok('doc.run', { docId: tiny, op: 'subtractBackground', params: Object.assign({}, f.params, { radius: 5 }), roi: null, channel: 0 });
  // a one-pixel image runs (the paraboloid lines have fewer than 3 points)
  const one = await c.load({ width: 1, height: 1, bitDepth: 8 }, [Uint8Array.of(7)]);
  await c.ok('doc.run', { docId: one, op: 'subtractBackground', params: Object.assign({}, f.params, { radius: 5, sliding: true }), roi: null, channel: 0 });
  await c.ok('doc.run', { docId: one, op: 'subtractBackground', params: Object.assign({}, f.params, { radius: 5 }), roi: null, channel: 0 });

  const norm = (params, extra) => Object.assign({ docId, op: 'enhanceNormalize', params, roi: null, channel: 0 }, extra);
  assert.equal(await code('doc.run', norm({ min: 5, max: 5 })), 'IJ_BAD_ARGS', 'max must exceed min');
  assert.equal(await code('doc.run', norm({ min: 'a', max: 7 })), 'IJ_BAD_ARGS');
  assert.equal(await code('doc.compute', { docId, op: 'saturatedRange', params: { saturated: -1 }, roi: null, channel: 0 }), 'IJ_BAD_ARGS');
  assert.equal(await code('doc.compute', { docId, op: 'saturatedRange', params: { saturated: 101 }, roi: null, channel: 0 }), 'IJ_BAD_ARGS');
  assert.equal(await code('doc.compute', { docId, op: 'saturatedRange', params: { saturated: 0.35 }, roi: null, channel: 9 }), 'IJ_BAD_ARGS', 'no such channel');
  assert.equal(await code('doc.compute', { docId, op: 'saturatedRange', params: { saturated: 0.35 }, roi: { type: 'rect', x: 500, y: 500, w: 3, h: 3 }, channel: 0 }), 'IJ_EMPTY_ROI', 'a selection outside the image');

  // Equalize: 8 and 16 bits only (ContrastEnhancer.equalize: "Equalization of 32-bit images not supported.")
  const f32 = JSON.parse(fs.readFileSync(path.join(FIX, 'normalize_f32_035.json'), 'utf8'));
  const d32 = await c.load(f32.input);
  assert.equal(await code('doc.run', { docId: d32, op: 'enhanceEqualize', params: { classic: false }, roi: null, channel: 0 }), 'IJ_BAD_TYPE');
  const eq = (params) => ({ docId, op: 'enhanceEqualize', params, roi: null, channel: 0 });
  assert.equal(await code('doc.run', eq({ classic: 'no' })), 'IJ_BAD_ARGS');
  assert.equal(await code('doc.run', eq({ rect: { x: 0, y: 0, w: 0, h: 5 } })), 'IJ_BAD_ARGS');
  assert.equal(await code('doc.run', eq({ rect: { x: 40, y: 0, w: 30, h: 5 } })), 'IJ_BAD_ARGS', 'a rectangle outside the image');
  assert.equal(await code('doc.run', { docId, op: 'saturatedRange', params: { saturated: 1 }, roi: null, channel: 0 }), 'IJ_BAD_ARGS', 'a compute op does not run through doc.run');
  assert.equal((await c.ok('doc.info', { docId })).undoDepth, 1, 'refused requests leave no undo step (only the test loader)');

  // estimate: the working copy is declared (float image + the result)
  const big = await c.load({ width: 1000, height: 800, bitDepth: 16 }, [new Uint16Array(800000)]);
  const est = await c.ok('doc.estimate', { docId: big, op: 'subtractBackground', params: Object.assign({}, f.params, { radius: 50 }), roi: null, channel: 0 });
  assert.ok(est.needBytes >= 800000 * (4 + 2 + 2), 'estimate counts the float copy, the result and the new array: ' + est.needBytes);
  assert.equal(est.fits, true);
}

// ── 7. cancel in the middle of a long run leaves the document untouched ──
{
  const c = client();
  const W = 1600, H = 1200;
  const data = new Uint8Array(W * H);
  for (let i = 0; i < data.length; i++) data[i] = (i * 7 + (i >> 5)) & 255;
  const docId = await c.load({ width: W, height: H, bitDepth: 8 }, [data]);
  const head = async () => Array.from((await c.ok('doc.tile', { docId, channel: 0, level: 0, tx: 0, ty: 0 })).data.subarray(0, 4096));
  const before = await head();
  const pending = c.call('doc.run', { docId, op: 'subtractBackground', params: { radius: 60, light: false, createBackground: false, sliding: true, disableSmoothing: false, correctCorners: true }, roi: null, channel: 0 });
  const runId = c.lastRunId();
  await new Promise((r) => setTimeout(r, 40));
  const m = await c.call('cancel', { targetId: runId });
  assert.ok(m.ok, 'cancel accepted');
  const res = await pending;
  assert.ok(!res.ok && res.error.code === 'IJ_CANCELLED', 'the run reports IJ_CANCELLED: ' + JSON.stringify(res.error));
  assert.equal((await c.ok('doc.info', { docId })).undoDepth, 1, 'no undo step for a cancelled run (only the test loader)');
  assert.deepEqual(await head(), before, 'pixels untouched');
}

for (const f of closers) f();
console.log('ij bg fixtures: OK');
