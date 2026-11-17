// Advanced Studio, package P3 (seg): Distance Map, Ultimate Points, Watershed, Voronoi, Skeletonize, Outline, Find Maxima
// (js/modules/studio/advanced-studio/ij-proc-seg.js) against the golden fixtures recorded with the real ImageJ 1.54p
// (tests/fixtures/ij-wave2/seg/, tools/ij_fixtures/P3.java), the engine contract and independent properties.
//
//   1. every golden fixture, value for value, through the registered operations (a pixel op: prepare → region; the
//      compute / newdoc ops: run with an io). All integer outputs are exact. The 32-bit ones (EDM, Ultimate Points and
//      Voronoi as float) are compared BIT for bit: Java's float arithmetic is reproduced with Math.fround where ImageJ adds,
//      scales or compares floats, so no tolerance is needed.
//      Find Maxima: the fixture driver calls MaximumFinder.findMaxima(...) without an ImagePlus, so `imp.getRoi().contains`
//      never filtered the points (`roi==null` in analyzeAndMarkMaxima). The real command does filter: the test checks the
//      port against the unfiltered fixture AND that the filtered list equals the fixture list restricted to ImageJ's own mask.
//   2. determinism: bands of one row / 7 rows / the whole image with adaptive banding off give identical bytes through the
//      real engine; the engine's input guard (verifyInputs) proves no op writes into an array it was given.
//   3. the engine contract: refusals (non-binary, wrong bit depth), the selection is ignored, validation of the
//      parameters, the memory estimate, a cancel leaves the document untouched.
//   4. independent properties: the EDM against a brute-force distance (≤ 0.09 as ImageJ documents), watershed splits two
//      touching disks, the ultimate points of two disks, the skeleton of a bar.
//
// Run: node tests/js/test_ij_seg.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT } from './harness.mjs';

const DIR = path.join(ROOT, 'js', 'modules', 'studio', 'advanced-studio');
const FX = path.join(ROOT, 'tests', 'fixtures', 'ij-wave2', 'seg');
const sandbox = { console, setTimeout, clearTimeout, MessageChannel, performance, TextEncoder, TextDecoder };
sandbox.self = sandbox;
vm.createContext(sandbox);
for (const f of ['ij-core.js', 'ij-analysis.js', 'ij-proc-shared.js', 'ij-proc-seg.js', 'ij-engine.js']) {
  vm.runInContext(fs.readFileSync(path.join(DIR, f), 'utf8'), sandbox, { filename: f });
}
const { IJOpRegistry: R, IJSeg, IJShared, IJBinary, IJRoi, IJEngine, IJTiff } = sandbox;
assert.ok(R && IJSeg && IJShared && IJBinary && IJRoi && IJEngine && IJTiff, 'modules loaded');

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok  ' + name); } catch (e) { console.error('FAIL ' + name); throw e; }
}
const A = (x) => Array.from(x);
const fnv = (a) => { let h = 0x811c9dc5; const u = new Uint8Array(a.buffer, a.byteOffset, a.byteLength); for (let i = 0; i < u.length; i++) { h ^= u[i]; h = Math.imul(h, 16777619) >>> 0; } return h.toString(16); };

// ── fixtures ──
function decodeData(d, bitDepth) {
  let a;
  if (Array.isArray(d)) a = Float64Array.from(d, (v) => (v === null ? NaN : v));
  else {
    const b = Buffer.from(d.b64, 'base64');
    const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
    a = d.dtype === 'u8' ? new Uint8Array(ab) : d.dtype === 'u16' ? new Uint16Array(ab) : new Float32Array(ab);
  }
  return bitDepth === 8 ? Uint8Array.from(a) : bitDepth === 16 ? Uint16Array.from(a) : Float32Array.from(a);
}
const image = (i) => ({ width: i.width, height: i.height, bitDepth: i.bitDepth, data: decodeData(i.data, i.bitDepth) });
const diff = (a, b) => { let n = 0; for (let i = 0; i < a.length; i++) if (!(a[i] === b[i] || (a[i] !== a[i] && b[i] !== b[i]))) n++; return n; };
const files = fs.readdirSync(FX).filter((f) => f.endsWith('.json')).sort();
const fixtures = files.map((f) => ({ file: f, ...JSON.parse(fs.readFileSync(path.join(FX, f), 'utf8')) }));
assert.ok(fixtures.length >= 75, 'the seg fixtures are there: ' + fixtures.length);

const viewOf = (img, o = {}) => ({
  id: 1, name: o.name || 'img.tif', width: img.width, height: img.height, bitDepth: img.bitDepth, calibration: { pixelWidth: 1, pixelHeight: 1, unit: 'pixel' }, provenance: {},
  channels: [{ data: img.data, name: 'C1', color: '#ffffff', display: { min: 0, max: img.bitDepth === 8 ? 255 : 65535, lut: 'Grays', invert: !!o.invert } }], active: 0
});
const pixelCtx = { scale: 1, range: () => ({ min: 0, max: 255 }), dep: () => null, check() {}, tick: async () => {} };
async function runPixel(op, img, params, o = {}) {
  const spec = R.get(op);
  assert.ok(spec && spec.kind === 'pixel', op + ' is a pixel operation');
  const view = viewOf(img, o);
  const p = Object.assign({}, params);
  if (spec.validate) spec.validate(p, { width: img.width, height: img.height, bitDepth: img.bitDepth, channels: 1, docs: [] });
  const prep = spec.prepare(view, 0, p, pixelCtx);
  assert.equal(prep.whole, true, op + ' is a whole-image operation');
  return prep.region({ width: img.width, height: img.height, bitDepth: img.bitDepth, data: img.data }, { x: 0, y: 0, w: img.width, h: img.height });
}
function ioFor(view, o = {}) {
  return {
    channel: o.channel === undefined ? 0 : o.channel, region: o.region || null, docIds: [view.id], tick: async () => {}, check() {}, reserve() {}, release() {}, dep: () => null,
    roiMask: (roi) => (roi && IJRoi.isArea(roi) ? IJRoi.mask(roi, view.width, view.height) : null), transfer() {}
  };
}
const runCompute = (op, img, params, roi, o = {}) => R.get(op).run(viewOf(img, o), params, roi || null, ioFor(viewOf(img, o), o));

// ═════════════════════════════════════════ 1. golden fixtures ═════════════════════════════════════════
const tally = {};
const note = (op, ok) => { tally[op] = tally[op] || { ok: 0, n: 0 }; tally[op].n++; if (ok) tally[op].ok++; };

// A mask selection from a 0/1 array, through the app's own encoder (a mask ROI has `rle`).
function maskRoi(m) {
  const data = decodeData(m.data, 8);
  const box = IJRoi.fromMask(data, m.w, m.h); // bounding box of the set pixels + runs
  return { roi: Object.assign({}, box, { x: box.x + m.x, y: box.y + m.y }), data };
}

await test('golden fixtures: Distance Map, Ultimate Points, Watershed, Voronoi, Skeletonize, Outline (exact)', async () => {
  for (const fx of fixtures.filter((f) => ['edm', 'ultimatePoints', 'watershed', 'voronoi', 'skeletonize', 'binary'].includes(f.op))) {
    const inp = image(fx.input);
    let ok, label = fx.file;
    if (fx.op === 'binary') {
      assert.equal(fx.params.op, 'outline');
      const out = IJBinary.outline(inp.data, inp.width, inp.height, {});
      const exp = decodeData(fx.output.data, 8);
      ok = diff(out, exp) === 0;
    } else if (fx.params.output === 'float') {
      const fn = { edm: IJSeg.edmFloat, ultimatePoints: IJSeg.uepFloat, voronoi: IJSeg.voronoiFloat }[fx.op];
      const out = await fn(inp.data, inp.width, inp.height, false, null);
      const exp = decodeData(fx.output.data, 32);
      assert.equal(out.constructor.name, 'Float32Array');
      // bit for bit: the same float arithmetic as Java
      ok = Buffer.compare(Buffer.from(out.buffer, out.byteOffset, out.byteLength), Buffer.from(exp.buffer, exp.byteOffset, exp.byteLength)) === 0;
    } else {
      const out = await runPixel(fx.op, inp, fx.params);
      ok = diff(out, decodeData(fx.output.data, 8)) === 0;
    }
    note(fx.op, ok);
    assert.ok(ok, label + ' differs from ImageJ 1.54p');
  }
  // IJShared.makeFloatEDM (W0) against the seg EDM fixtures: identical bits (nothing to report)
  for (const fx of fixtures.filter((f) => f.op === 'edm' && f.params.output === 'float')) {
    const inp = image(fx.input);
    const out = IJShared.makeFloatEDM(inp.data, inp.width, inp.height, {});
    assert.equal(diff(out, decodeData(fx.output.data, 32)), 0, fx.file + ': IJShared.makeFloatEDM');
  }
});

await test('golden fixtures: Find Maxima — Count / Point Selection / List and the three images (exact)', async () => {
  const fm = fixtures.filter((f) => f.op === 'findMaxima');
  assert.ok(fm.length >= 40);
  for (const fx of fm) {
    const inp = image(fx.input);
    const roiInfo = fx.roi && fx.roi.mask ? maskRoi(fx.roi.mask) : null;
    const roi = roiInfo ? roiInfo.roi : (fx.roi ? { type: 'rect', x: fx.roi.x, y: fx.roi.y, w: fx.roi.w, h: fx.roi.h } : null);
    const contains = roiInfo
      ? (x, y) => { const m = fx.roi.mask; return x >= m.x && x < m.x + m.w && y >= m.y && y < m.y + m.h && roiInfo.data[(y - m.y) * m.w + (x - m.x)] !== 0; }
      : (fx.roi ? (x, y) => x >= fx.roi.x && x < fx.roi.x + fx.roi.w && y >= fx.roi.y && y < fx.roi.y + fx.roi.h : null);
    // points (compute op): the real command filters through Roi.contains, the driver did not
    const res = await runCompute('findMaxima', inp, fx.params, roi);
    const expAll = fx.result.points;
    const expFiltered = [];
    for (let i = 0; i < expAll.length; i += 2) if (!contains || contains(expAll[i], expAll[i + 1])) expFiltered.push(expAll[i], expAll[i + 1]);
    assert.deepEqual(A(res.points), expFiltered, fx.file + ': points (ImageJ order, inside the selection)');
    assert.equal(res.count, expFiltered.length / 2, fx.file + ': count');
    if (!fx.roi) assert.equal(res.count, fx.result.count, fx.file + ': count (no selection)');
    // the unfiltered list through the finder itself: exactly the fixture
    const raw = await IJSeg.findMaxima({ data: fx.params.light ? IJSeg.invertedCopy(inp.data, inp.bitDepth) : inp.data, width: inp.width, height: inp.height }, {
      tolerance: fx.params.prominence, strict: fx.params.strict, excludeOnEdges: fx.params.excludeEdges, outputType: IJSeg.POINT_SELECTION,
      threshold: fx.params.aboveLower && !fx.params.light ? fx.params.aboveLower.lower : IJSeg.NO_THRESHOLD,
      roi: fx.roi ? { x: fx.roi.x, y: fx.roi.y, w: fx.roi.w, h: fx.roi.h } : null, mask: roiInfo ? null : null, contains: null
    });
    assert.deepEqual(A(raw.points), expAll, fx.file + ': unfiltered points = the fixture, in ImageJ\'s order');
    // the three images (newdoc op)
    for (const [out, kind] of [['single', 'single'], ['tolerance', 'tolerance'], ['segmented', 'segmented']]) {
      const [doc] = await runCompute('findMaximaImage', inp, Object.assign({ output: out }, fx.params), kind === 'segmented' ? roi : roi);
      assert.equal(doc.bitDepth, 8);
      assert.equal(doc.name, 'img.tif' + (out === 'segmented' ? ' Segmented' : ' Maxima'));
      const exp = decodeData(fx.outputs[kind].data, 8);
      assert.equal(diff(doc.channels[0].data, exp), 0, fx.file + ': ' + out + ' image');
    }
    note('findMaxima', true);
  }
});

await test('golden fixtures: the app rasterisation of the fixture selections gives the same maxima', async () => {
  // A rectangle is exact. For the oval the app's pixel-centre rule can differ from ImageJ's OvalRoi on the boundary:
  // the maxima of the fixture are not on it, the lists are identical.
  for (const fx of fixtures.filter((f) => f.op === 'findMaxima' && f.roi)) {
    const inp = image(fx.input);
    const roi = { type: fx.roi.type, x: fx.roi.x, y: fx.roi.y, w: fx.roi.w, h: fx.roi.h };
    const a = await runCompute('findMaxima', inp, fx.params, roi);
    const m = fx.roi.mask ? maskRoi(fx.roi.mask) : null;
    const b = await runCompute('findMaxima', inp, fx.params, m ? m.roi : roi);
    assert.deepEqual(A(a.points), A(b.points), fx.file + ': ' + fx.roi.type + ' as the app rasterises it');
  }
});

await test('golden fixture summary: nothing skipped', () => {
  const total = fixtures.length;
  let ok = 0, n = 0;
  for (const k of Object.keys(tally)) { ok += tally[k].ok; n += tally[k].n; }
  // every fixture was run by one of the two tests above (findMaxima counted once per file)
  assert.equal(n, total, 'every fixture file was compared: ' + JSON.stringify(tally));
  assert.equal(ok, n);
  console.log('      fixtures compared: ' + ok + '/' + total + ' ' + JSON.stringify(Object.fromEntries(Object.entries(tally).map(([k, v]) => [k, v.ok + '/' + v.n]))));
});

// ═════════════════════════════════════════ 2. conventions ═════════════════════════════════════════
const disks = fixtures.find((f) => f.file === 'edm_overwrite_disks.json');
const disksImg = image(disks.input);
const invertedBytes = (a) => Uint8Array.from(a, (v) => 255 - v);

await test('an inverting LUT swaps the foreground (EDM.setup background255, Binary.skeletonize foreground)', async () => {
  const inv = { width: disksImg.width, height: disksImg.height, bitDepth: 8, data: invertedBytes(disksImg.data) };
  for (const op of ['edm', 'ultimatePoints', 'watershed', 'voronoi']) {
    const a = await runPixel(op, disksImg, { output: 'overwrite' });
    const b = await runPixel(op, inv, { output: 'overwrite' }, { invert: true });
    if (op === 'watershed') assert.equal(diff(b, invertedBytes(a)), 0, op + ': result inverted with the input');
    else assert.equal(diff(a, b), 0, op);
  }
  const s1 = await runPixel('skeletonize', disksImg, {});
  const s2 = await runPixel('skeletonize', inv, {}, { invert: true });
  // the skeleton foreground follows the LUT: with an inverting LUT the objects are 0, so the skeleton is 0 on 255
  assert.equal(diff(s2, invertedBytes(s1)), 0);
});

await test('Voronoi of a single connected object and Watershed of a full image change nothing (README of the fixtures)', async () => {
  const full = fixtures.find((f) => f.file === 'watershed_full.json');
  const fi = image(full.input);
  assert.equal(diff(await runPixel('watershed', fi, { output: 'overwrite' }), fi.data), 0);
  const v = await runPixel('voronoi', fi, { output: 'overwrite' });
  assert.equal(diff(v, new Uint8Array(v.length)), 0);
});

await test('EDM output types: new 8-bit / 16-bit / 32-bit image named as ImageJ names it', async () => {
  const f = await IJSeg.edmFloat(disksImg.data, disksImg.width, disksImg.height, false, null);
  const view = viewOf(disksImg, { name: 'my cells.tif' });
  const spec = R.get('edmOutput');
  const run = (p) => spec.run(view, p, null, ioFor(view));
  const [e32] = await run({ kind: 'edm', output: 'float' });
  assert.equal(e32.name, 'EDM of mycells'); // ImagePlus.getShortTitle: extension dropped, spaces removed for a file name
  assert.equal(e32.bitDepth, 32);
  assert.equal(diff(e32.channels[0].data, f), 0);
  const [e8] = await run({ kind: 'edm', output: 'byte' });
  const [e16] = await run({ kind: 'edm', output: 'short' });
  assert.equal(e8.bitDepth, 8); assert.equal(e16.bitDepth, 16);
  for (let i = 0; i < f.length; i++) {
    // convertToByte(true) with min 0 / max 255: (int)(v + 0.5) clamped; convertToShort(true): (short)(v + 0.5) (scale 1)
    assert.equal(e8.channels[0].data[i], Math.min(255, Math.trunc(f[i] + 0.5)));
    assert.equal(e16.channels[0].data[i], Math.min(65535, Math.trunc(f[i] + 0.5)));
  }
  assert.equal((await run({ kind: 'ultimatePoints', output: 'float' }))[0][ 'name'], 'UEPs of mycells');
  assert.equal((await run({ kind: 'voronoi', output: 'float' }))[0].name, 'Voronoi of mycells');
  assert.equal(IJSeg.shortTitle('E85 embryo 1'), 'E85'); // no dot: cut at the first space
  const ueFloat = (await run({ kind: 'ultimatePoints', output: 'float' }))[0].channels[0].data;
  const ueFx = fixtures.find((x) => x.file === 'ultimate_float_disks.json');
  assert.equal(diff(ueFloat, decodeData(ueFx.output.data, 32)), 0, 'UEP float image = the fixture');
  // the long EDM values of the 32-bit output are not clamped to 255 (the overwrite output is)
  const big = new Uint8Array(600 * 3).fill(255);
  for (let y = 0; y < 3; y++) big[y * 600] = 0; // one background column: distances up to 599
  const bigImg = { width: 600, height: 3, bitDepth: 8, data: big };
  const f32 = (await spec.run(viewOf(bigImg), { kind: 'edm', output: 'float' }, null, ioFor(viewOf(bigImg))))[0].channels[0].data;
  assert.ok(Math.max(...f32) > 255, 'a float EDM keeps values above 255');
  assert.equal(Math.max(...A(await runPixel('edm', bigImg, { output: 'overwrite' }))), 255, 'overwrite clamps at 255');
});

// ═════════════════════════════════════════ 3. engine contract ═════════════════════════════════════════
const closers = [];
function client(opts = {}) {
  const waiters = new Map();
  const log = [];
  let n = 0;
  const fake = {
    navigator: {}, onmessage: null,
    postMessage(m) {
      log.push(m);
      if (m.id !== undefined && 'ok' in m) { const w = waiters.get(m.id); if (w) { waiters.delete(m.id); w(m); } }
      // Cancel at the first progress event of the armed request: deterministic (Node's timers starve while the engine
      // keeps yielding through a MessageChannel, so a timer-based cancel would race).
      else if (m.event === 'progress' && armed.has(m.id)) { armed.delete(m.id); fake.onmessage({ data: { id: ++n, cmd: 'cancel', args: { targetId: m.id } } }); }
    }
  };
  const armed = new Set();
  const eng = IJEngine.start(fake, Object.assign({ storage: 'memory', idleMs: 3600000, bandPixels: 1 << 20, verifyInputs: true }, opts));
  closers.push(() => eng.dispose());
  const c = {
    log, lastId: 0,
    /** Cancels `id` as soon as the engine reports its first progress (it yields every 50 ms of work). */
    armCancel(id) { armed.add(id); },
    call(cmd, args) { return new Promise((res) => { const id = ++n; c.lastId = id; waiters.set(id, res); fake.onmessage({ data: { id, cmd, args } }); }); },
    async ok(cmd, args) { const m = await c.call(cmd, args); assert.ok(m.ok, `${cmd} failed: ${m.error && m.error.code}`); return m.result; },
    async err(cmd, args) { const m = await c.call(cmd, args); assert.ok(!m.ok, `${cmd} should have failed`); return m.error; },
    async openImage(img, name) {
      const tiff = IJTiff.write({ width: img.width, height: img.height, bitDepth: img.bitDepth, calibration: { pixelWidth: 0.5, pixelHeight: 0.5, unit: 'um' },
        channels: [{ data: img.data, name: 'C1', color: '#ffffff', display: { min: 0, max: img.bitDepth === 8 ? 255 : 65535, lut: 'Grays', invert: false } }] });
      return (await c.ok('doc.open', { bytes: tiff, name: name || 'mask.tif' })).docId;
    },
    async pixels(docId) {
      const info = await c.ok('doc.info', { docId });
      const out = new (info.bitDepth === 8 ? Uint8Array : info.bitDepth === 16 ? Uint16Array : Float32Array)(info.width * info.height);
      const T = info.tileSize;
      for (let ty = 0; ty * T < info.height; ty++) for (let tx = 0; tx * T < info.width; tx++) {
        const t = await c.ok('doc.tile', { docId, channel: 0, level: 0, tx, ty });
        for (let y = 0; y < t.height; y++) for (let x = 0; x < t.width; x++) out[(ty * T + y) * info.width + tx * T + x] = t.data[y * t.width + x];
      }
      return out;
    }
  };
  return c;
}

await test('band variation (1 row / 7 rows / whole image, adaptive off): byte-identical, inputs never written', async () => {
  const blobs = image(fixtures.find((f) => f.file === 'edm_overwrite_blobs.json').input);
  const W = blobs.width;
  const ops = [['edm', { output: 'overwrite' }], ['ultimatePoints', { output: 'overwrite' }], ['watershed', { output: 'overwrite' }], ['voronoi', { output: 'overwrite' }], ['skeletonize', {}]];
  const results = {};
  for (const band of [W, W * 7, 1 << 20]) {
    const c = client({ bandPixels: band, adaptive: false });
    for (const [op, params] of ops) {
      const id = await c.openImage(blobs);
      await c.ok('doc.run', { docId: id, op, params, roi: null, channel: 0 });
      const px = await c.pixels(id);
      (results[op] = results[op] || []).push(fnv(px));
      // and it equals the direct result
      const direct = await runPixel(op, blobs, params);
      assert.equal(diff(px, direct), 0, op + ' through the engine = the operation');
    }
  }
  for (const [op] of ops) assert.equal(new Set(results[op]).size, 1, op + ' is identical for every band size: ' + results[op]);
  const c = client();
  // outline = the v1 binary op, through the same engine
  const id = await c.openImage(blobs);
  await c.ok('doc.run', { docId: id, op: 'binary', params: { op: 'outline' }, roi: null, channel: 0 });
  assert.equal(diff(await c.pixels(id), decodeData(fixtures.find((f) => f.file === 'outline_blobs.json').output.data, 8)), 0, 'the v1 outline op = ImageJ');
});

await test('refusals: a non-binary 8-bit image, 16 and 32 bits, an invalid parameter', async () => {
  const c = client();
  const grey = { width: 20, height: 20, bitDepth: 8, data: Uint8Array.from({ length: 400 }, (_, i) => (i * 7) % 251) };
  const gid = await c.openImage(grey);
  for (const op of ['edm', 'ultimatePoints', 'watershed', 'voronoi', 'skeletonize']) {
    const e = await c.err('doc.run', { docId: gid, op, params: op === 'skeletonize' ? {} : { output: 'overwrite' }, roi: null, channel: 0 });
    assert.equal(e.code, 'IJ_SEG_NOT_BINARY', op);
  }
  assert.equal((await c.err('doc.run', { docId: gid, op: 'edmOutput', params: { kind: 'edm', output: 'float' }, roi: null, channel: 0 })).code, 'IJ_SEG_NOT_BINARY');
  assert.equal(fnv(await c.pixels(gid)), fnv(grey.data), 'a refused operation leaves the image as it was');
  const g16 = await c.openImage({ width: 8, height: 8, bitDepth: 16, data: new Uint16Array(64) });
  const g32 = await c.openImage({ width: 8, height: 8, bitDepth: 32, data: new Float32Array(64) });
  for (const id of [g16, g32]) for (const op of ['edm', 'ultimatePoints', 'watershed', 'voronoi', 'skeletonize']) {
    assert.equal((await c.err('doc.run', { docId: id, op, params: op === 'skeletonize' ? {} : { output: 'overwrite' }, roi: null, channel: 0 })).code, 'IJ_BAD_TYPE', op);
  }
  // Find Maxima works on every depth
  for (const id of [g16, g32]) await c.ok('doc.compute', { docId: id, op: 'findMaxima', params: { prominence: 10 }, roi: null, channel: 0 });
  // parameters
  const bin = await c.openImage(disksImg);
  assert.equal((await c.err('doc.run', { docId: bin, op: 'edm', params: { output: 'float' }, roi: null, channel: 0 })).code, 'IJ_BAD_ARGS', 'Overwrite is the only pixel output');
  assert.equal((await c.err('doc.run', { docId: bin, op: 'edmOutput', params: { kind: 'voronoi', output: 'overwrite' }, roi: null, channel: 0 })).code, 'IJ_BAD_ARGS');
  assert.equal((await c.err('doc.run', { docId: bin, op: 'edmOutput', params: { kind: 'nope', output: 'float' }, roi: null, channel: 0 })).code, 'IJ_BAD_ARGS');
  for (const bad of [{}, { prominence: -1 }, { prominence: 'x' }, { prominence: NaN }, { prominence: 5, strict: 1 }, { prominence: 5, aboveLower: { lower: 'a' } }, { prominence: 5, aboveLower: 3 }]) {
    assert.equal((await c.err('doc.compute', { docId: bin, op: 'findMaxima', params: bad, roi: null, channel: 0 })).code, 'IJ_BAD_ARGS', JSON.stringify(bad));
  }
  assert.equal((await c.err('doc.run', { docId: bin, op: 'findMaximaImage', params: { prominence: 5, output: 'count' }, roi: null, channel: 0 })).code, 'IJ_BAD_ARGS');
  assert.equal((await c.err('doc.run', { docId: bin, op: 'findMaxima', params: { prominence: 5 }, roi: null, channel: 0 })).code, 'IJ_BAD_ARGS', 'a compute operation runs through doc.compute');
  assert.equal((await c.err('doc.compute', { docId: bin, op: 'findMaxima', params: { prominence: 5 }, roi: null, channel: 5 })).code, 'IJ_BAD_ARGS', 'a channel the image does not have');
});

await test('the selection is ignored by the binary operations (EDM: "do not take ROIs into account"; Skeletonize: resetRoi)', async () => {
  const c = client();
  const roi = { type: 'oval', x: 5, y: 5, w: 20, h: 18 };
  for (const [op, params] of [['edm', { output: 'overwrite' }], ['ultimatePoints', { output: 'overwrite' }], ['watershed', { output: 'overwrite' }], ['voronoi', { output: 'overwrite' }], ['skeletonize', {}]]) {
    const a = await c.openImage(disksImg), b = await c.openImage(disksImg);
    await c.ok('doc.run', { docId: a, op, params, roi: null, channel: 0 });
    await c.ok('doc.run', { docId: b, op, params, roi, channel: 0 });
    assert.equal(fnv(await c.pixels(a)), fnv(await c.pixels(b)), op + ' with a selection = without');
  }
});

await test('Find Maxima: the selection limits the maxima, segmentation ignores it, a line selection is the whole image', async () => {
  const c = client();
  const fx = fixtures.find((f) => f.file === 'fm_p10_roi_rect_u8.json');
  const id = await c.openImage(image(fx.input));
  const whole = await c.ok('doc.compute', { docId: id, op: 'findMaxima', params: fx.params, roi: null, channel: 0 });
  const inRect = await c.ok('doc.compute', { docId: id, op: 'findMaxima', params: fx.params, roi: { type: 'rect', x: 5, y: 4, w: 28, h: 20 }, channel: 0 });
  assert.ok(inRect.count < whole.count && inRect.count > 0);
  const inside = [];
  for (let i = 0; i < inRect.points.length; i += 2) inside.push([inRect.points[i], inRect.points[i + 1]]);
  for (const [x, y] of inside) assert.ok(x >= 5 && x < 33 && y >= 4 && y < 24, 'inside the rectangle');
  // a line / a point selection is not an area: the whole image (MaximumFinder.run: `!roi.isArea()` → deleteRoi)
  const line = await c.ok('doc.compute', { docId: id, op: 'findMaxima', params: fx.params, roi: { type: 'line', x1: 0, y1: 0, x2: 10, y2: 10, width: 1 }, channel: 0 });
  assert.deepEqual(J(line), J(whole));
  const pt = await c.ok('doc.compute', { docId: id, op: 'findMaxima', params: fx.params, roi: { type: 'point', points: [[3.5, 3.5]] }, channel: 0 });
  assert.deepEqual(J(pt), J(whole));
  // Segmented Particles: the selection is deleted ("outputType==SEGMENTED") — the picture of the whole image
  const a = await c.ok('doc.run', { docId: id, op: 'findMaximaImage', params: Object.assign({ output: 'segmented' }, fx.params), roi: null, channel: 0 });
  const b = await c.ok('doc.run', { docId: id, op: 'findMaximaImage', params: Object.assign({ output: 'segmented' }, fx.params), roi: { type: 'rect', x: 5, y: 4, w: 28, h: 20 }, channel: 0 });
  assert.equal(fnv(await c.pixels(a.newDocIds[0])), fnv(await c.pixels(b.newDocIds[0])));
  // a rectangle outside the image refuses
  assert.equal((await c.err('doc.compute', { docId: id, op: 'findMaxima', params: fx.params, roi: { type: 'rect', x: 100, y: 100, w: 5, h: 5 }, channel: 0 })).code, 'IJ_EMPTY_ROI');
  // the new image keeps the calibration
  const info = await c.ok('doc.info', { docId: a.newDocIds[0] });
  assert.equal(info.bitDepth, 8);
  assert.equal(info.calibration.pixelWidth, 0.5);
});
function J(x) { return JSON.parse(JSON.stringify(x)); }

await test('Find Maxima on the visible region (preview): the points inside it, in image coordinates', async () => {
  const c = client();
  const fx = fixtures.find((f) => f.file === 'fm_blobs_p20_u8.json');
  const id = await c.openImage(image(fx.input));
  const whole = await c.ok('doc.compute', { docId: id, op: 'findMaxima', params: fx.params, roi: null, channel: 0 });
  const r = { x0: 10, y0: 8, x1: 40, y1: 35 };
  const part = await c.ok('doc.compute', { docId: id, op: 'findMaxima', params: Object.assign({ preview: true }, fx.params), roi: null, channel: 0, region: r });
  assert.ok(part.count > 0 && part.count <= whole.count);
  for (let i = 0; i < part.points.length; i += 2) assert.ok(part.points[i] >= r.x0 && part.points[i] < r.x1 && part.points[i + 1] >= r.y0 && part.points[i + 1] < r.y1);
  // the maxima well inside the region are those of the whole image
  const wholeSet = new Set(); for (let i = 0; i < whole.points.length; i += 2) wholeSet.add(whole.points[i] + ',' + whole.points[i + 1]);
  let common = 0;
  for (let i = 0; i < part.points.length; i += 2) if (wholeSet.has(part.points[i] + ',' + part.points[i + 1])) common++;
  assert.ok(common >= part.count - 1, 'the region preview shows the maxima of the whole image (' + common + ' of ' + part.count + ')');
  // an empty region has no maxima
  const none = await c.ok('doc.compute', { docId: id, op: 'findMaxima', params: fx.params, roi: null, channel: 0, region: { x0: 5, y0: 5, x1: 5, y1: 9 } });
  assert.equal(none.count, 0);
});

await test('memory: the estimate counts the scratch, a refused step never starts', async () => {
  const c = client({ budgetBytes: 40000 });
  const big = { width: 60, height: 60, bitDepth: 8, data: new Uint8Array(3600) };
  big.data.fill(255, 600, 900);
  const id = await c.openImage(big);
  const est = await c.ok('doc.estimate', { docId: id, op: 'watershed', params: { output: 'overwrite' }, roi: null, channel: 0 });
  assert.ok(est.needBytes >= 3600 * 20, 'watershed declares its float EDM and work arrays: ' + est.needBytes);
  const e2 = await c.ok('doc.estimate', { docId: id, op: 'voronoi', params: { output: 'overwrite' }, roi: null, channel: 0 });
  assert.ok(e2.needBytes > est.needBytes, 'Voronoi (a maximum at every object pixel) declares more');
  const e3 = await c.ok('doc.estimate', { docId: id, op: 'edm', params: { output: 'overwrite' }, roi: null, channel: 0 });
  assert.ok(e3.needBytes >= 3600 * 4 && e3.needBytes < est.needBytes);
  const f = await c.ok('doc.estimate', { docId: id, op: 'findMaxima', params: { prominence: 5, light: true }, roi: null, channel: 0 });
  const g = await c.ok('doc.estimate', { docId: id, op: 'findMaxima', params: { prominence: 5, light: false }, roi: null, channel: 0 });
  assert.ok(f.needBytes > g.needBytes, 'the inverted copy of a light-background search is declared');
  const huge = client({ budgetBytes: 60000 });
  const hid = await huge.openImage({ width: 100, height: 100, bitDepth: 8, data: new Uint8Array(10000) });
  const before = fnv(await huge.pixels(hid));
  const e = await huge.err('doc.run', { docId: hid, op: 'watershed', params: { output: 'overwrite' }, roi: null, channel: 0 });
  assert.equal(e.code, 'IJ_OVER_BUDGET');
  assert.equal(fnv(await huge.pixels(hid)), before);
});

await test('cancel: a running Skeletonize stops and leaves the document untouched', async () => {
  const c = client();
  const N = 900;
  const data = new Uint8Array(N * N);
  for (let y = 100; y < N - 100; y++) for (let x = 100; x < N - 100; x++) data[y * N + x] = 255; // a thick square: hundreds of thinning passes
  const id = await c.openImage({ width: N, height: N, bitDepth: 8, data });
  const before = fnv(await c.pixels(id));
  const p = c.call('doc.run', { docId: id, op: 'skeletonize', params: {}, roi: null, channel: 0 });
  c.armCancel(c.lastId);
  const m = await p;
  assert.equal(m.ok, false);
  assert.equal(m.error.code, 'IJ_CANCELLED');
  assert.equal(fnv(await c.pixels(id)), before, 'the cancelled step changed nothing');
  const info = await c.ok('doc.info', { docId: id });
  assert.equal(info.undoDepth, 0, 'no undo step was recorded');
});

await test('cancel: Find Maxima (points and segmented image) and Watershed stop, nothing is created or changed', async () => {
  const c = client();
  const N = 1400;
  const rnd = lcg(11);
  const noise = new Uint8Array(N * N);
  for (let i = 0; i < noise.length; i++) noise[i] = 40 + Math.floor(rnd() * 120); // thousands of maxima: a long run
  const id = await c.openImage({ width: N, height: N, bitDepth: 8, data: noise });
  const before = fnv(await c.pixels(id));
  const nDocs = (await c.ok('doc.list')).docs.length;
  for (const [cmd, args] of [
    ['doc.compute', { docId: id, op: 'findMaxima', params: { prominence: 2 }, roi: null, channel: 0 }],
    ['doc.run', { docId: id, op: 'findMaximaImage', params: { prominence: 2, output: 'segmented' }, roi: null, channel: 0 }]]) {
    const p = c.call(cmd, args);
    c.armCancel(c.lastId);
    const m = await p;
    assert.equal(m.ok, false, cmd + ' was cancelled');
    assert.equal(m.error.code, 'IJ_CANCELLED');
  }
  assert.equal(fnv(await c.pixels(id)), before);
  assert.equal((await c.ok('doc.list')).docs.length, nDocs, 'no image was created');
  // a watershed of a big binary image: the cancel lands between two levels
  const mask = new Uint8Array(N * N);
  for (let i = 0; i < mask.length; i++) mask[i] = noise[i] > 100 ? 255 : 0;
  const mid = await c.openImage({ width: N, height: N, bitDepth: 8, data: mask });
  const p = c.call('doc.run', { docId: mid, op: 'watershed', params: { output: 'overwrite' }, roi: null, channel: 0 });
  c.armCancel(c.lastId);
  assert.equal((await p).error.code, 'IJ_CANCELLED');
  assert.equal(fnv(await c.pixels(mid)), fnv(mask));
});

// ═════════════════════════════════════════ 4. independent properties ═════════════════════════════════════════
function lcg(seed) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; }

await test('EDM against a brute-force Euclidean distance (ImageJ documents -0.09 … 0 at most)', async () => {
  const rnd = lcg(7);
  for (const [w, h, p] of [[40, 33, 0.2], [64, 64, 0.04], [90, 20, 0.08]]) {
    const m = new Uint8Array(w * h);
    for (let i = 0; i < m.length; i++) m[i] = rnd() < p ? 0 : 255; // sparse background points: large distances
    const f = await IJSeg.edmFloat(m, w, h, false, null);
    const bg = [];
    for (let i = 0; i < m.length; i++) if (m[i] === 0) bg.push([i % w, (i / w) | 0]);
    let worst = 0;
    for (let i = 0; i < m.length; i++) {
      if (m[i] === 0) { assert.equal(f[i], 0); continue; }
      const x = i % w, y = (i / w) | 0;
      let best = Infinity;
      for (const [bx, by] of bg) { const d = (x - bx) * (x - bx) + (y - by) * (y - by); if (d < best) best = d; }
      const exact = bg.length ? Math.sqrt(best) : Math.sqrt(2147483648);
      worst = Math.max(worst, Math.abs(f[i] - exact));
      assert.ok(f[i] - exact <= 1e-5 && exact - f[i] <= 0.0901, `EDM ${f[i]} vs ${exact} at ${x},${y}`);
    }
  }
});

await test('Watershed splits two touching disks, Ultimate Points finds one point per disk, Skeletonize reduces a bar to a line', async () => {
  const W = 60, H = 40;
  const m = new Uint8Array(W * H);
  const disk = (cx, cy, r) => { for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) m[y * W + x] = 255; };
  disk(20, 20, 11); disk(37, 20, 11);
  const img = { width: W, height: H, bitDepth: 8, data: m };
  const label = (d) => { // 8-connected components
    const seen = new Uint8Array(d.length); let n = 0;
    for (let i = 0; i < d.length; i++) if (d[i] === 255 && !seen[i]) {
      n++; const st = [i]; seen[i] = 1;
      while (st.length) { const j = st.pop(); const x = j % W, y = (j / W) | 0; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue; const k = yy * W + xx; if (d[k] === 255 && !seen[k]) { seen[k] = 1; st.push(k); } } }
    }
    return n;
  };
  assert.equal(label(m), 1, 'the disks touch');
  const ws = await runPixel('watershed', img, { output: 'overwrite' });
  assert.equal(label(ws), 2, 'the watershed line separates them');
  for (let i = 0; i < m.length; i++) assert.ok(ws[i] <= m[i], 'the watershed only removes pixels (COPY of a subset = AND with the input)');
  const uep = await runPixel('ultimatePoints', img, { output: 'overwrite' });
  let pts = 0; for (const v of uep) if (v) pts++;
  assert.equal(pts, 2, 'one ultimate point per disk');
  const bar = new Uint8Array(W * H);
  for (let y = 15; y < 26; y++) for (let x = 5; x < 55; x++) bar[y * W + x] = 255;
  const sk = await runPixel('skeletonize', { width: W, height: H, bitDepth: 8, data: bar }, {});
  let count = 0; for (const v of sk) if (v === 255) count++;
  assert.ok(count > 30 && count < 60, 'a thin line: ' + count);
  for (let y = 0; y < H; y++) { let row = 0; for (let x = 0; x < W; x++) if (sk[y * W + x] === 255) row++; assert.ok(row <= 55); }
  assert.equal(label(sk), 1, 'the skeleton of a bar is connected');
  // idempotent: skeletonizing a skeleton changes nothing
  const sk2 = await runPixel('skeletonize', { width: W, height: H, bitDepth: 8, data: Uint8Array.from(sk) }, {});
  assert.equal(diff(sk, sk2), 0);
  // an object touching the edge: ImageJ pads, the skeleton stays inside the image
  const edgeBar = new Uint8Array(W * H);
  for (let y = 0; y < 8; y++) for (let x = 0; x < W; x++) edgeBar[y * W + x] = 255;
  const sk3 = await runPixel('skeletonize', { width: W, height: H, bitDepth: 8, data: edgeBar }, {});
  let c3 = 0; for (const v of sk3) if (v === 255) c3++;
  assert.ok(c3 > 0 && c3 < 3 * W);
});

await test('Find Maxima properties: strict mode, edge exclusion, light background, plateau centre, determinism', async () => {
  const W = 30, H = 20;
  const d = new Uint8Array(W * H);
  for (let y = 5; y < 8; y++) for (let x = 10; x < 15; x++) d[y * W + x] = 200; // a 5×3 plateau
  d[15 * W + 0] = 255; // a maximum on the edge
  const img = { width: W, height: H, bitDepth: 8, data: d };
  const base = { prominence: 20, strict: false, excludeEdges: false, light: false, aboveLower: null };
  let r = await runCompute('findMaxima', img, base);
  assert.deepEqual(A(r.points).slice(0, 2), [0, 15], 'the highest maximum first');
  assert.ok(A(r.points).join().includes('12,6'), 'a plateau is marked at its centre pixel');
  r = await runCompute('findMaxima', img, Object.assign({}, base, { excludeEdges: true }));
  assert.equal(r.count, 1, 'the edge maximum is excluded');
  // Strict: a prominence larger than the whole range finds nothing; loose accepts the global maximum
  const strict = await runCompute('findMaxima', img, Object.assign({}, base, { prominence: 300, strict: true }));
  assert.equal(strict.count, 0);
  const loose = await runCompute('findMaxima', img, Object.assign({}, base, { prominence: 300 }));
  assert.equal(loose.count, 1);
  // light background = the minima of the image: invert gives the same as the minima
  const inv = { width: W, height: H, bitDepth: 8, data: invertedBytes(d) };
  const a = await runCompute('findMaxima', inv, Object.assign({}, base, { light: true }));
  const b = await runCompute('findMaxima', img, base);
  assert.deepEqual(A(a.points), A(b.points));
  // an inverting LUT without "Light background" also finds the minima (the LUT convention)
  const c2 = await runCompute('findMaxima', inv, base, null, { invert: true });
  assert.deepEqual(A(c2.points), A(b.points));
  // Above lower threshold: the maxima below it are dropped; with light background it is ignored (ImageJ refuses the combination)
  const t = await runCompute('findMaxima', img, Object.assign({}, base, { aboveLower: { lower: 210 } }));
  assert.equal(t.count, 1);
  const tl = await runCompute('findMaxima', inv, Object.assign({}, base, { light: true, aboveLower: { lower: 210 } }));
  assert.deepEqual(A(tl.points), A(b.points));
  // repeatable
  assert.deepEqual(A((await runCompute('findMaxima', img, base)).points), A(b.points));
  // 16 bit "light background" inverts about the DATA range (fullRange16bitInversions is false): same maxima
  const d16 = Uint16Array.from(d, (v) => v * 200);
  const m16 = await runCompute('findMaxima', { width: W, height: H, bitDepth: 16, data: d16 }, Object.assign({}, base, { prominence: 4000 }));
  assert.deepEqual(A(m16.points), A(b.points));
  // no pixel above the global minimum: nothing; a flat image has no maximum
  assert.equal((await runCompute('findMaxima', { width: 5, height: 5, bitDepth: 8, data: new Uint8Array(25).fill(9) }, base)).count, 0);
  // 'Maxima Within Tolerance' of a flat image: every pixel (nMax == 0: "consider all as within tolerance")
  const [flat] = await runCompute('findMaximaImage', { width: 5, height: 5, bitDepth: 8, data: new Uint8Array(25).fill(9) }, Object.assign({ output: 'tolerance' }, base));
  assert.ok(flat.channels[0].data.every((v) => v === 255));
});

for (const f of closers) f();
console.log(`\n${passed} tests passed`);
