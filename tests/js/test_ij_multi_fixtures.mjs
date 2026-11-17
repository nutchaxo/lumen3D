// P4 (multi) — the golden fixtures recorded with real ImageJ 1.54p (tests/fixtures/ij-wave2/multi/): Image
// Calculator (13 operations x 8/16/32 bits, mixed bit depths, 32-bit result, different sizes), Split
// Channels and Merge Channels, compared value for value against the registry operations of
// ij-proc-multi.js.
//
// Exactness: integer outputs are compared exactly. 32-bit outputs are compared bit for bit (Object.is, NaN
// equals NaN, -0 differs from +0): Java float arithmetic and a JS double operation stored in a
// Float32Array give the same correctly rounded result for + - * / (a double has more than 2x24+2 bits, so the
// double rounding is innocuous), and Average rounds the float sum first like Java does.
//
// Run: node tests/js/test_ij_multi_fixtures.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT } from './harness.mjs';

const DIR = path.join(ROOT, 'js', 'modules', 'studio', 'advanced-studio');
const FIX = path.join(ROOT, 'tests', 'fixtures', 'ij-wave2', 'multi');
const ctx = vm.createContext({ console, setTimeout, clearTimeout });
for (const f of ['ij-core.js', 'ij-proc-multi.js']) vm.runInContext(fs.readFileSync(path.join(DIR, f), 'utf8'), ctx, { filename: f });
const R = ctx.IJOpRegistry;
assert.ok(R.get('imageCalculator') && R.get('splitChannels') && R.get('mergeChannels') && R.get('arrangeChannels'), 'the four ops are registered');

function decodeData(d, bitDepth) {
  if (Array.isArray(d)) {
    const a = Float64Array.from(d, (v) => (v === null ? NaN : v));
    return bitDepth === 8 ? Uint8Array.from(a) : bitDepth === 16 ? Uint16Array.from(a) : Float32Array.from(a);
  }
  const b = Buffer.from(d.b64, 'base64');
  const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  return d.dtype === 'u8' ? new Uint8Array(ab) : d.dtype === 'u16' ? new Uint16Array(ab) : new Float32Array(ab);
}
function dataRange(a) {
  let mn = Infinity, mx = -Infinity;
  for (const v of a) { if (v - v !== 0) continue; if (v < mn) mn = v; if (v > mx) mx = v; }
  return mn > mx ? { min: 0, max: 0 } : { min: mn, max: mx };
}
// A document view as the engine hands it to an op. The display range is the data range (the ImagePlus of the
// fixture driver: ip.getMin()/getMax() = findMinAndMax).
function viewOf(id, name, im, nameOfCh) {
  const chans = im.channels || [im];
  return {
    id, name, width: im.width, height: im.height, bitDepth: im.bitDepth, calibration: { pixelWidth: 1, pixelHeight: 1, unit: 'px' }, provenance: null, active: 0,
    channels: chans.map((c, i) => {
      const data = decodeData(c.data, im.bitDepth);
      const r = im.bitDepth === 8 ? { min: 0, max: 255 } : dataRange(data);
      return { data, name: (nameOfCh && nameOfCh[i]) || ('c' + (i + 1)), color: '#ffffff', display: { min: r.min, max: r.max, lut: 'Grays', invert: false } };
    })
  };
}
const io = (views) => ({
  docIds: views.map((v) => v.id), channel: null, region: null,
  tick: async () => {}, check() {}, reserve() {}, release() {}, dep: (n) => ctx[n],
  readDoc: (id) => { const v = views.find((x) => x.id === id); if (!v) throw Object.assign(new Error('x'), { code: 'IJ_BAD_ARGS' }); return v; }
});
// `signless`: the fixture stored the data as a plain JSON array, whose writer prints a whole float through
// (long) — Fx.num in tools/ij_fixtures — which loses the sign of -0.0. Zero then equals zero, whatever its
// sign; base64 data (and every non-zero value) is compared bit for bit.
function sameData(got, want, bitDepth, what, signless) {
  assert.equal(got.length, want.length, what + ': length');
  let bad = 0, first = -1;
  for (let i = 0; i < got.length; i++) {
    const ok = bitDepth === 32 ? (Object.is(got[i], want[i]) || (signless && got[i] === 0 && want[i] === 0)) : got[i] === want[i];
    if (!ok) { bad++; if (first < 0) first = i; }
  }
  assert.equal(bad, 0, `${what}: ${bad} of ${got.length} values differ (first at ${first}: got ${got[first]}, want ${want[first]})`);
}
const registryRun = async (name, view, params, views) => R.get(name).run(view, params, null, io(views));

let passed = 0, total = 0;
const files = fs.readdirSync(FIX).filter((f) => f.endsWith('.json')).sort();
const byOp = { imageCalculator: [], splitChannels: [], mergeChannels: [] };
for (const f of files) { const j = JSON.parse(fs.readFileSync(path.join(FIX, f), 'utf8')); (byOp[j.op] || assert.fail('unknown fixture op ' + j.op)).push(j); }
assert.equal(byOp.imageCalculator.length, 60);
assert.equal(byOp.splitChannels.length, 6);
assert.equal(byOp.mergeChannels.length, 6);
const failures = [];

// ---- Image Calculator
for (const j of byOp.imageCalculator) {
  total++;
  try {
    const v1 = viewOf(1, 'a', j.input), v2 = viewOf(2, 'b', j.input2);
    const params = { op: j.params.op, float32: !!j.params.float32, all: false, channel1: 0, channel2: 0 };
    const spec = R.get('imageCalculator');
    const info = { width: v1.width, height: v1.height, bitDepth: v1.bitDepth, channels: 1, docs: [{ width: v2.width, height: v2.height, bitDepth: v2.bitDepth, channels: 1 }] };
    spec.validate(params, info);
    const before = [v1.channels[0].data.slice(), v2.channels[0].data.slice()];
    const res = await registryRun('imageCalculator', v1, params, [v1, v2]);
    assert.equal(res.length, 1);
    const r = res[0];
    assert.equal(r.bitDepth, j.output.bitDepth, 'bit depth');
    assert.equal(r.width, j.output.width, 'width');
    assert.equal(r.height, j.output.height, 'height');
    assert.equal(r.name, 'Result of a');
    sameData(r.channels[0].data, decodeData(j.output.data, j.output.bitDepth), j.output.bitDepth, j.case, Array.isArray(j.output.data));
    sameData(v1.channels[0].data, before[0], v1.bitDepth, 'input 1 untouched');
    sameData(v2.channels[0].data, before[1], v2.bitDepth, 'input 2 untouched');
    assert.ok(spec.scratchBytes(info, params) >= r.channels[0].data.byteLength, 'scratchBytes covers the result');
    passed++;
  } catch (e) { failures.push(j.case + ': ' + e.message); }
}
console.log(`  imageCalculator fixtures: ${byOp.imageCalculator.filter((j) => !failures.some((m) => m.startsWith(j.case + ':'))).length}/${byOp.imageCalculator.length}`);

// ---- Split Channels
for (const j of byOp.splitChannels) {
  total++;
  try {
    const v = viewOf(1, j.params.title, j.input);
    const before = v.channels.map((c) => c.data.slice());
    const res = await registryRun('splitChannels', v, {}, [v]);
    assert.deepEqual(Array.from(res, (r) => r.name), j.result.names);
    assert.equal(res.length, j.result.channels.length);
    res.forEach((r, i) => {
      assert.equal(r.channels.length, 1);
      assert.equal(r.width, j.result.channels[i].width); assert.equal(r.height, j.result.channels[i].height); assert.equal(r.bitDepth, j.result.channels[i].bitDepth);
      sameData(r.channels[0].data, decodeData(j.result.channels[i].data, r.bitDepth), r.bitDepth, j.case + ' C' + (i + 1));
      assert.notEqual(r.channels[0].data, v.channels[i].data, 'the split image owns its array');
    });
    v.channels.forEach((c, i) => sameData(c.data, before[i], v.bitDepth, 'source untouched'));
    passed++;
  } catch (e) { failures.push(j.case + ': ' + e.message); }
}

// ---- Merge Channels (sources = the split images, gray LUTs: default colours of the slots)
const hexRgb = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
for (const j of byOp.mergeChannels) {
  total++;
  try {
    const sources = j.input.channels.map((c, i) => viewOf(10 + i, 'C' + (i + 1) + '-emb 1.tif', { width: j.input.width, height: j.input.height, bitDepth: j.input.bitDepth, channels: [c] }));
    const params = { sources: sources.map((s, i) => ({ docId: s.id, slot: i })), ignoreLuts: false };
    R.get('mergeChannels').validate(params, { width: j.input.width, height: j.input.height, bitDepth: j.input.bitDepth, channels: 1, docs: [] });
    const res = await registryRun('mergeChannels', sources[0], params, sources);
    assert.equal(res.length, 1);
    const r = res[0];
    assert.equal(r.name, j.result.title);
    assert.equal(r.channels.length, j.result.nChannels);
    assert.equal(r.bitDepth, j.result.bitDepth);
    r.channels.forEach((c, i) => {
      sameData(c.data, decodeData(j.result.channels[i].data, r.bitDepth), r.bitDepth, j.case + ' channel ' + (i + 1), true);
      assert.deepEqual(hexRgb(c.color), j.result.lutMaxRGB[i], 'LUT colour at 255 of channel ' + (i + 1));
      assert.equal(c.display.min, sources[i].channels[0].display.min);
      assert.equal(c.display.max, sources[i].channels[0].display.max);
      assert.notEqual(c.data, sources[i].channels[0].data);
    });
    passed++;
  } catch (e) { failures.push(j.case + ': ' + e.message); }
}
console.log(`  split/merge fixtures: ${byOp.splitChannels.length + byOp.mergeChannels.length - failures.filter((m) => /^(split|merge)_/.test(m)).length}/${byOp.splitChannels.length + byOp.mergeChannels.length}`);
for (const m of failures) console.error('MISMATCH ' + m);
assert.equal(failures.length, 0, `${failures.length} of ${total} fixtures do not match`);
console.log(`ok test_ij_multi_fixtures: ${passed}/${total} golden fixtures match ImageJ 1.54p`);
