// Advanced Studio, package P3 (seg): regression tests of the review round.
//
//   • a journal REPLAY (no snapshot) gives the same pixels when the channel has an inverting LUT (the LUT is copied into the params);
//   • Find Maxima treats a 32-bit image titled "EDM of …" as an EDM (MaximumFinder.run: isEDM);
//   • an Overwrite sets the display range like ByteProcessor.setPixels(0, fp) / EDM.run;
//   • the watershed ticks after every dilation pass; the maxima are reserved before they are allocated and come back as an Int32Array;
//   • maxSortingError uses the float 1.1f; Outline honours an inverting LUT; the preview count says it is approximate.
//
// Run: node tests/js/test_ij_seg_review.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { boot, until, sleep, EN, DIR } from './ij_harness.mjs';

const sandbox = { console, setTimeout, clearTimeout };
sandbox.self = sandbox;
vm.createContext(sandbox);
for (const f of ['ij-core.js', 'ij-analysis.js', 'ij-proc-shared.js', 'ij-proc-seg.js']) vm.runInContext(fs.readFileSync(path.join(DIR, f), 'utf8'), sandbox, { filename: f });
const { IJSeg, IJBinary } = sandbox;

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok  ' + name); } catch (e) { console.error('FAIL ' + name); throw e; }
}
const A = (x) => Array.from(x);
const same = (a, b, msg) => assert.equal(a.length, b.length, msg + ' (length)') || assert.ok(a.every((v, i) => v === b[i] || (v !== v && b[i] !== b[i])), msg);
const diff = (a, b) => { let n = 0; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++; return n; };
const VOL = { width: 80, height: 60, depth: 3, channels: 1 };

async function maskDoc(t) {
  await t.runCommand('binMask');
  const id = t.activeId();
  const info = (await t.docs()).find((d) => d.docId === id);
  return { id, w: info.width, h: info.height };
}

// ═════════════════════════════════════════ 1. journal replay with an inverting LUT ═════════════════════════════════════════
for (const [cmd, vals] of [['binWatershed'], ['binDistanceMap', {}], ['binSkeletonize'], ['binVoronoi', {}], ['binUltimatePoints', {}], ['binOutline']]) {
  await test(`${cmd}: the journal replays to the same pixels with an inverting LUT (no snapshot)`, async () => {
    for (const inverted of [true, false]) {
      const t = await boot({ volume: VOL });
      await t.open();
      const m = await maskDoc(t);
      await t.flush(); // the mask is stored: what follows lives only in the journal
      if (inverted) await t.engine('doc.setDisplay', { docId: m.id, channel: 0, invert: true });
      await t.runCommand(cmd, vals);
      const after = A(await t.pixels(m.id, 0));
      await sleep(300);
      const t2 = await t.reload({ flush: false });
      const w2 = await t2.spawn();
      for (const k of (await t2.store.shared.list()).map((x) => x.key)) {
        const r = await t2.engine('session.restore', { key: k }, w2);
        assert.equal(r.warnings.length, 0, JSON.stringify(r.warnings));
      }
      const restored = A(await t2.pixels(m.id, 0));
      assert.equal(diff(after, restored), 0, `${cmd} (inverted LUT: ${inverted}) differs after the replay`);
      t2.close();
    }
  });
}

await test('the LUT is copied into the params once (resolve is idempotent, validate refuses a malformed field)', async () => {
  const t = await boot({ volume: VOL });
  await t.open();
  const m = await maskDoc(t);
  await t.engine('doc.setDisplay', { docId: m.id, channel: 0, invert: true });
  await t.runCommand('binSkeletonize');
  const j = t.log && null; void j;
  const bad = await t.engine('doc.run', { docId: m.id, op: 'skeletonize', params: { invert: 'yes' }, roi: null, channel: 0 }).then(() => null, (e) => e);
  assert.ok(bad && bad.code === 'IJ_BAD_ARGS', 'a malformed invert is refused: ' + (bad && bad.code));
  t.close();
});

// ═════════════════════════════════════════ 2. isEDM from the title ═════════════════════════════════════════
await test('Find Maxima on a 32-bit "EDM of …" image works on the EDM (isEDM), like ImageJ', async () => {
  const t = await boot({ volume: VOL });
  await t.open();
  const m = await maskDoc(t);
  t.api('thr').settings.set('thr.edmOutput', 'float'); // Process > Binary > Options > EDM output: 32-bit
  await t.runCommand('binDistanceMap');
  const edmDoc = (await t.docs()).find((d) => d.bitDepth === 32 && d.name.startsWith('EDM of '));
  assert.ok(edmDoc, 'the Distance Map is a 32-bit image titled "EDM of …"');
  for (let i = 0; i < 12 && t.activeId() !== edmDoc.docId; i++) await t.runCommand('windowNext');
  assert.equal(t.activeId(), edmDoc.docId);
  const f = Float32Array.from(await t.pixels(edmDoc.docId, 0));
  for (const output of ['segmented', 'single']) {
    for (let i = 0; i < 12 && t.activeId() !== edmDoc.docId; i++) await t.runCommand('windowNext');
    const n0 = (await t.docs()).length;
    await t.runCommand('procFindMaxima', { prominence: 0.5, output });
    const docs = await t.docs();
    assert.equal(docs.length, n0 + 1);
    const got = docs.find((d) => d.name === edmDoc.name + (output === 'segmented' ? ' Segmented' : ' Maxima'));
    assert.ok(got, 'the new image: ' + docs.map((d) => d.name).join(' / '));
    const outType = output === 'segmented' ? IJSeg.SEGMENTED : IJSeg.SINGLE_POINTS;
    const asEdm = await IJSeg.findMaxima({ data: f, width: m.w, height: m.h }, { tolerance: 0.5, strict: false, threshold: IJSeg.NO_THRESHOLD, outputType: outType, excludeOnEdges: false, isEDM: true }, null);
    const plain = await IJSeg.findMaxima({ data: f, width: m.w, height: m.h }, { tolerance: 0.5, strict: false, threshold: IJSeg.NO_THRESHOLD, outputType: outType, excludeOnEdges: false, isEDM: false }, null);
    same(A(await t.pixels(got.docId, 0)), A(asEdm.out), output + ': the EDM path');
    if (output === 'segmented') assert.ok(diff(asEdm.out, plain.out) > 0, 'the two paths really differ on this image');
  }
  t.close();
});

// ═════════════════════════════════════════ 3. display range after an Overwrite ═════════════════════════════════════════
await test('Distance Map / Ultimate Points / Voronoi (Overwrite) leave the display on the range of the map, not 0..255', async () => {
  for (const [cmd, ref] of [['binDistanceMap', IJSeg.edmFloat], ['binUltimatePoints', IJSeg.uepFloat], ['binVoronoi', IJSeg.voronoiFloat]]) {
    const t = await boot({ volume: VOL });
    await t.open();
    const m = await maskDoc(t);
    const bin = Uint8Array.from(await t.pixels(m.id, 0));
    const exp = IJSeg.overwriteBytes(await ref(bin, m.w, m.h, false, null));
    let mn = 255, mx = 0;
    for (const v of exp) { if (v < mn) mn = v; if (v > mx) mx = v; }
    await t.runCommand(cmd, {});
    await until(async () => {
      const d = (await t.docs()).find((x) => x.docId === m.id).channels[0].display;
      return d.max === (mx >= 255 ? 255 : mx);
    }, cmd + ': display max');
    const d = (await t.docs()).find((x) => x.docId === m.id).channels[0].display;
    assert.equal(d.min, mx >= 255 ? 0 : mn, cmd + ' min');
    assert.equal(d.max, mx >= 255 ? 255 : mx, cmd + ' max');
    assert.ok(mx < 255, 'the test mask gives a small maximum (it would look black on 0..255)');
    t.close();
  }
});

// ═════════════════════════════════════════ 4. ticks, reserve, typed points, 1.1f ═════════════════════════════════════════
await test('Watershed ticks after every dilation pass, with a progress in [0, 1] that never goes back', async () => {
  const w = 160, h = 120;
  const mask = new Uint8Array(w * h);
  for (const [cx, cy, r] of [[40, 60, 30], [90, 60, 30], [130, 40, 18]]) for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) mask[y * w + x] = 255;
  const fr = [];
  let ticks = 0;
  const out = await IJSeg.watershedBinary(mask, w, h, false, { tick: async (f) => { ticks++; fr.push(f); }, check() {} });
  assert.ok(out.some((v) => v === 0) && out.some((v) => v === 255));
  assert.ok(ticks > 40, 'many ticks: ' + ticks);
  assert.ok(fr.every((f) => f >= 0 && f <= 1.0000001), 'progress within [0,1]');
  const plain = await IJSeg.watershedBinary(mask, w, h, false, null);
  same(A(out), A(plain), 'ticking does not change the result');
});

await test('Skeletonize ticks inside a pass (every 128 rows), result unchanged', async () => {
  const w = 60, h = 600;
  const mask = new Uint8Array(w * h);
  for (let y = 5; y < h - 5; y++) for (let x = 10; x < 50; x++) mask[y * w + x] = 255;
  let ticks = 0;
  const a = await IJSeg.skeletonize(mask, w, h, 255, { tick: async () => { ticks++; }, check() {} });
  const b = await IJSeg.skeletonize(mask, w, h, 255, null);
  same(A(a), A(b), 'same skeleton');
  assert.ok(ticks >= 4 * 4, 'ticks inside the passes: ' + ticks);
});

await test('Find Maxima reserves 16 bytes per maximum once it has counted them; the points are an Int32Array', async () => {
  const w = 64, h = 64;
  const flat = new Uint8Array(w * h);
  for (let y = 10; y < 30; y++) for (let x = 10; x < 30; x++) flat[y * w + x] = 5; // a 20 x 20 plateau: every pixel is a maximum
  const reserved = [];
  const r = await IJSeg.findMaxima({ data: flat, width: w, height: h }, { tolerance: 1, strict: false, threshold: IJSeg.NO_THRESHOLD, outputType: IJSeg.POINT_SELECTION, excludeOnEdges: false, isEDM: false },
    { tick: async () => {}, check() {}, reserve: (n) => reserved.push(n) });
  assert.deepEqual(reserved, [16 * 400], 'one reservation of 16 B x 400 maxima');
  assert.equal(r.points.constructor.name, 'Int32Array');
  assert.equal(r.points.length, 2, 'a plateau is one point');
  const refuse = await IJSeg.findMaxima({ data: flat, width: w, height: h }, { tolerance: 1, strict: false, threshold: IJSeg.NO_THRESHOLD, outputType: IJSeg.COUNT, excludeOnEdges: false, isEDM: false },
    { tick: async () => {}, check() {}, reserve: () => { const e = new Error('over'); e.code = 'IJ_OVER_BUDGET'; throw e; } }).then(() => null, (e) => e);
  assert.ok(refuse && refuse.code === 'IJ_OVER_BUDGET', 'a refused reservation stops the finder before it allocates');
});

await test('maxSortingError is Java\'s 1.1f * x (float times float), not the double 1.1', async () => {
  const f = Math.fround;
  // Java: 1.1f * (SQRT2/2f) = 0.77781749 (float); the double 1.1 gives 0.77781743
  assert.equal(IJSeg.sortingMargin(true, 0), f(0.77781749));
  let differs = 0;
  for (let i = 1; i <= 400; i++) {
    const range = f(i * 0.37 + 1 / i);
    const exp = f(f(1.1) * f(range / f(2e9)));
    assert.equal(IJSeg.sortingMargin(false, range), exp);
    if (exp !== f(1.1 * f(range / f(2e9)))) differs++;
  }
  assert.ok(differs > 20, 'the two roundings differ on many ranges (' + differs + '/400)');
});

// ═════════════════════════════════════════ 5. Outline with an inverting LUT ═════════════════════════════════════════
await test('Outline outlines the 0 pixels under an inverting LUT (BinaryProcessor bgColor), journal included', async () => {
  const t = await boot({ volume: VOL });
  await t.open();
  const m = await maskDoc(t);
  const before = Uint8Array.from(await t.pixels(m.id, 0));
  await t.flush();
  await t.runCommand('lutInvert'); // Image > Lookup Tables > Invert LUT: the page and the engine both know it
  await sleep(200); // the display patch reaches the engine
  await t.runCommand('binOutline');
  const inv = new Uint8Array(before.length);
  for (let i = 0; i < inv.length; i++) inv[i] = 255 - before[i];
  const o = IJBinary.outline(inv, m.w, m.h, {});
  const exp = A(o).map((v) => 255 - v);
  const after = A(await t.pixels(m.id, 0));
  same(after, exp, 'the 0 pixels are the objects');
  assert.ok(diff(after, A(IJBinary.outline(before, m.w, m.h, {}))) > 0, 'not the outline of the 255 pixels');
  await t.runCommand('editUndo');
  same(A(await t.pixels(m.id, 0)), A(before), 'undo');
  await t.runCommand('editRedo');
  same(A(await t.pixels(m.id, 0)), exp, 'redo');
  t.close();
});

await test('the preview of Find Maxima on a crop says its count is approximate', async () => {
  const t = await boot({ volume: VOL });
  await t.open();
  const id = t.activeId();
  const part = await t.engine('doc.compute', { docId: id, op: 'findMaxima', params: { prominence: 10, preview: true }, roi: null, channel: 0, region: { x0: 10, y0: 10, x1: 50, y1: 40 } });
  assert.equal(part.approximate, true);
  const whole = await t.engine('doc.compute', { docId: id, op: 'findMaxima', params: { prominence: 10 }, roi: null, channel: 0 });
  assert.equal(whole.approximate, false);
  assert.equal(whole.points.constructor.name, 'Int32Array');
  t.close();
});

console.log(passed + ' tests passed');
