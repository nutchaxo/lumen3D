// doc.oblique.* and doc.zproj.* (ij-proc-lib.js): the accumulators the page streams into, one brick (or block) per call. Driven directly with a
// recorded worker `E`: bricks of a synthetic volume, in any order, equal the direct evaluation (IJOblique.reference); a brick the packer did
// not store is zeros and never "missing"; a failed one is; tokens, refusals, abort; the z projection of a processed volume equals IJProject.
//
// Run: node tests/js/test_ij_lib_oblique.mjs
import assert from 'node:assert/strict';
import { loadLib, makeE, callCommand, sameArray } from './ij_lib_support.mjs';

const ctx = loadLib();
let passed = 0;
const test = async (name, fn) => { await fn(); passed++; };
const codeOf = async (p) => { try { await p; } catch (e) { return e.code || e.name; } return null; };

const DIMS = { x: 32, y: 24, z: 20 };
const value = (c, x, y, z) => ((x * 7 + y * 13 + z * 29 + c * 61) % 250) + 1;
const G = (over) => Object.assign({ dims: DIMS, width: 30, height: 20, o: [0.08, 0.1, 0.2], a: [0.03, 0.005, 0.002], b: [-0.004, 0.04, 0.01], c: [0.01, 0.005, 0.03], steps: 5, projected: true, projMode: 'max' }, over || {});
const boxes = (size) => {
  const out = [];
  for (let z = 0; z < DIMS.z; z += size) for (let y = 0; y < DIMS.y; y += size) for (let x = 0; x < DIMS.x; x += size) {
    out.push({ x0: x, y0: y, z0: z, x1: Math.min(DIMS.x, x + size), y1: Math.min(DIMS.y, y + size), z1: Math.min(DIMS.z, z + size) });
  }
  return out;
};
const brickData = (c, b, vol) => {
  const w = b.x1 - b.x0, h = b.y1 - b.y0, d = b.z1 - b.z0, out = new Uint8Array(w * h * d);
  for (let z = 0; z < d; z++) for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[(z * h + y) * w + x] = vol(c, b.x0 + x, b.y0 + y, b.z0 + z);
  return out;
};
const inBox = (b, x, y, z) => x >= b.x0 && x < b.x1 && y >= b.y0 && y < b.y1 && z >= b.z0 && z < b.z1;
const CH = [{ index: 0, name: 'A', color: '#ff0000' }, { index: 3, name: 'B', color: '#00ff00' }];
const CAL = { pixelWidth: 2, pixelHeight: 2, unit: 'µm' };

async function runOblique(g, opts) {
  const o = opts || {};
  const E = makeE({ budgetBytes: o.budgetBytes });
  const begin = await callCommand(ctx, 'doc.oblique.begin', { G: g, channels: CH, name: 'obl', calibration: CAL, provenance: { mode: 'oblique' }, sessionKey: 'lib|k' }, E);
  assert.match(begin.token, /^liboi?\d+$|^libo\d+$/);
  const order = boxes(o.brick || 8);
  if (o.shuffle) order.reverse();
  for (const ch of CH) {
    const failed = [];
    for (const b of order) {
      if (o.ess && o.ess(b)) continue;                                   // not stored: never delivered, never failed
      if (o.fail && o.fail(b, ch.index)) { failed.push(b); continue; }
      await callCommand(ctx, 'doc.oblique.add', { token: begin.token, channel: ch.index, box: b, data: brickData(ch.index, b, o.vol || value) }, E);
    }
    await callCommand(ctx, 'doc.oblique.add', { token: begin.token, channel: ch.index, done: true, failed }, E);
  }
  const fin = await callCommand(ctx, 'doc.oblique.finish', { token: begin.token }, E);
  return { E, fin, token: begin.token };
}

await test('an oblique plane built brick by brick equals the direct evaluation, whatever the order and the brick size (single, max, mean)', async () => {
  for (const [mode, g] of [['single', G({ steps: 1, projected: false, projMode: null })], ['max', G()], ['mean', G({ projMode: 'mean' })]]) {
    for (const [brick, shuffle] of [[8, false], [7, true], [32, false]]) {
      const { E, fin } = await runOblique(g, { brick, shuffle });
      assert.equal(fin.missing, 0, mode + ': nothing missing');
      const doc = E.rec.docs[0];
      assert.deepEqual([doc.image.width, doc.image.height, doc.image.bitDepth, doc.image.name], [30, 20, 8, 'obl']);
      assert.deepEqual(doc.image.channels.map((c) => [c.name, c.color]), [['A', '#ff0000'], ['B', '#00ff00']]);
      CH.forEach((ch, k) => sameArray(doc.image.channels[k].data, ctx.IJOblique.reference(g, (x, y, z) => value(ch.index, x, y, z)), `${mode} brick ${brick} channel ${ch.index}`));
      assert.deepEqual(JSON.parse(JSON.stringify(doc.opts)), { provenance: { mode: 'oblique' }, sessionKey: 'lib|k' });
      assert.equal(fin.info.docId, 'doc1');
    }
  }
});

await test('a brick the packer did not store is zeros, not missing (the mean is not biased); a failed brick is missing', async () => {
  const g = G({ projMode: 'mean' });
  const stored = (b) => !(b.x0 === 8 && b.y0 === 8);                                    // the bricks of one column were never stored
  const ess = await runOblique(g, { brick: 8, ess: (b) => !stored(b) });
  assert.equal(ess.fin.missing, 0, 'ESS bricks are zero voxels');
  CH.forEach((ch, k) => sameArray(ess.E.rec.docs[0].image.channels[k].data,
    ctx.IJOblique.reference(g, (x, y, z) => (stored({ x0: x - (x % 8), y0: y - (y % 8) }) ? value(ch.index, x, y, z) : 0)), 'mean over zeros, channel ' + ch.index));
  // the same bricks FAILED: the pixels with a sample in them are counted
  const failBoxes = boxes(8).filter((b) => !stored(b));
  const bad = await runOblique(g, { brick: 8, fail: (b) => !stored(b) });
  const acc = ctx.IJOblique.create(g, { channel: 0 });
  const want = acc.missing(failBoxes).count;
  assert.ok(want > 0, 'the failed column meets the plane');
  assert.equal(bad.fin.missing, want, 'the union over channels equals the failed pixels (both channels failed the same boxes)');
  // a failure in one channel only still counts once
  const one = await runOblique(g, { brick: 8, fail: (b, c) => c === 3 && !stored(b) });
  assert.equal(one.fin.missing, want);
});

await test('a channel left unfinished is finished by finish(); begin checks the memory; the document keeps the channel order', async () => {
  const g = G({ steps: 1, projected: false, projMode: null });
  const E = makeE();
  const { token } = await callCommand(ctx, 'doc.oblique.begin', { G: g, channels: CH, name: 'obl', calibration: CAL, provenance: {} }, E);
  for (const b of boxes(8)) await callCommand(ctx, 'doc.oblique.add', { token, channel: 0, box: b, data: brickData(0, b, value) }, E);
  const fin = await callCommand(ctx, 'doc.oblique.finish', { token }, E);
  assert.equal(fin.missing, 0);
  sameArray(E.rec.docs[0].image.channels[0].data, ctx.IJOblique.reference(g, (x, y, z) => value(0, x, y, z)), 'channel 0');
  sameArray(E.rec.docs[0].image.channels[1].data, new Uint8Array(30 * 20), 'channel 3 had no brick: zeros');
  // begin reserves what the accumulators need and says so when it does not fit
  const need = ctx.IJOblique.estimateBytes(g, { channels: 2 });
  const small = makeE({ limit: need - 1 });
  assert.equal(await codeOf(callCommand(ctx, 'doc.oblique.begin', { G: g, channels: CH, name: 'x', calibration: CAL }, small)), 'IJ_OVER_BUDGET');
  const ok = makeE({ limit: need });
  await callCommand(ctx, 'doc.oblique.begin', { G: g, channels: CH, name: 'x', calibration: CAL }, ok);
  assert.equal(ok.rec.reservations[0], need);
});

await test('refusals: a lost token, a finished channel, a foreign channel, a bad brick, a bad geometry; abort drops the token; the oldest of four goes', async () => {
  const g = G();
  const E = makeE();
  const { token } = await callCommand(ctx, 'doc.oblique.begin', { G: g, channels: CH, name: 'o', calibration: CAL }, E);
  const b = boxes(8)[0];
  assert.equal(await codeOf(callCommand(ctx, 'doc.oblique.add', { token: 'nope', channel: 0, box: b, data: brickData(0, b, value) }, E)), 'IJ_LIB_NO_TOKEN');
  assert.equal(await codeOf(callCommand(ctx, 'doc.oblique.add', { token, channel: 7, box: b, data: brickData(0, b, value) }, E)), 'IJ_BAD_ARGS');
  assert.equal(await codeOf(callCommand(ctx, 'doc.oblique.add', { token, channel: 0, box: b, data: new Uint8Array(3) }, E)), 'IJ_BAD_ARGS', 'a brick whose size is not its box');
  assert.equal(await codeOf(callCommand(ctx, 'doc.oblique.add', { token, channel: 0, box: { ...b, x1: 99 }, data: brickData(0, b, value) }, E)), 'IJ_BAD_ARGS');
  await callCommand(ctx, 'doc.oblique.add', { token, channel: 0, done: true, failed: [] }, E);
  assert.equal(await codeOf(callCommand(ctx, 'doc.oblique.add', { token, channel: 0, box: b, data: brickData(0, b, value) }, E)), 'IJ_BAD_ARGS', 'channel 0 is finished');
  assert.equal(await codeOf(callCommand(ctx, 'doc.oblique.begin', { G: { ...g, a: [NaN, 0, 0] }, channels: CH, name: 'o', calibration: CAL }, E)), 'IJ_BAD_ARGS');
  assert.equal(await codeOf(callCommand(ctx, 'doc.oblique.begin', { G: g, channels: [], name: 'o', calibration: CAL }, E)), 'IJ_BAD_ARGS');
  assert.equal((await callCommand(ctx, 'doc.oblique.abort', { token }, E)).dropped, true);
  assert.equal(await codeOf(callCommand(ctx, 'doc.oblique.finish', { token }, E)), 'IJ_LIB_NO_TOKEN');
  assert.equal((await callCommand(ctx, 'doc.oblique.abort', { token }, E)).dropped, false, 'abort is idempotent');
  assert.equal(E.rec.docs.length, 0, 'nothing became a document');
  // the table of live accumulators is bounded: a fourth begin drops the first
  const tokens = [];
  for (let i = 0; i < 4; i++) tokens.push((await callCommand(ctx, 'doc.oblique.begin', { G: g, channels: CH, name: 'o', calibration: CAL }, makeE())).token);
  assert.equal(await codeOf(callCommand(ctx, 'doc.oblique.finish', { token: tokens[0] }, makeE())), 'IJ_LIB_NO_TOKEN');
  assert.equal((await callCommand(ctx, 'doc.oblique.finish', { token: tokens[3] }, makeE())).missing, 0);
});

await test('doc.zproj: the blocks of a processed volume, in any z order, equal IJProject over an 8-bit input (ImageJ depths: average / median 8-bit, sum / sd 32-bit)', async () => {
  const W = 11, H = 9, D = 7, C = 2;
  const vol = (c, x, y, z) => ((x * 3 + y * 5 + z * 17 + c * 40 + ((x * y) % 11) * 9) % 251) + 1;
  for (const method of ['avg', 'max', 'min', 'sum', 'sd', 'median']) {
    const E = makeE();
    const begin = await callCommand(ctx, 'doc.zproj.begin', { method, width: W, height: H, depth: D, channels: [{ name: 'A', color: '#ff0000' }, { name: 'B' }],
      name: 'P', calibration: CAL, provenance: { mode: 'z' }, sessionKey: 'lib|z', bandRows: 4 }, E);
    assert.equal(begin.outputBitDepth, ctx.IJProject.outputBitDepth(method, D, 8));
    assert.equal(begin.outputBitDepth, { avg: 8, max: 8, min: 8, median: 8, sum: 32, sd: 32 }[method], 'the depth ImageJ gives an 8-bit stack');
    const rows = begin.bandRows;
    assert.ok(rows >= 1 && rows <= 4);
    const ref = ctx.IJProject.create({ method, width: W, height: H, depth: D, channels: C, inputBitDepth: 8 });
    const zs = [[4, 7], [0, 2], [2, 4]];                                                        // out of order, 2 blocks of 3 and 2 of... (z0, z1 exclusive)
    for (let y0 = 0; y0 < H; y0 += rows) {
      const y1 = Math.min(H, y0 + rows);
      for (const [z0, z1] of zs) {
        const data = [0, 1].map((c) => { const a = new Uint8Array((z1 - z0) * (y1 - y0) * W); for (let z = z0; z < z1; z++) for (let y = y0; y < y1; y++) for (let x = 0; x < W; x++) a[((z - z0) * (y1 - y0) + (y - y0)) * W + x] = vol(c, x, y, z); return a; });
        const r = await callCommand(ctx, 'doc.zproj.add', { token: begin.token, y0, rows: y1 - y0, z0, depth: z1 - z0, data }, E);
        assert.ok(r.fraction > 0 && r.fraction <= 1);
        data.forEach((d, c) => ref.addBlock({ channel: c, y0, rows: y1 - y0, z0, depth: z1 - z0, data: d }));
      }
    }
    await callCommand(ctx, 'doc.zproj.finish', { token: begin.token }, E);
    const want = ref.finish();
    const img = E.rec.docs[0].image;
    assert.equal(img.bitDepth, want[0].bitDepth, method);
    want.forEach((w, c) => sameArray(img.channels[c].data, w.data, method + ' channel ' + c));
    assert.equal(JSON.stringify(Array.from(img.channels, (c) => [c.name, c.color || null])), JSON.stringify([['A', '#ff0000'], ['B', null]]));
  }
  // refusals
  const E = makeE();
  assert.equal(await codeOf(callCommand(ctx, 'doc.zproj.begin', { method: 'avg', width: 4, height: 4, depth: 2, channels: [{ name: 'A' }], calibration: CAL, bandRows: 4 }, makeE({ limit: 1 }))), 'IJ_OVER_BUDGET');
  assert.equal(await codeOf(callCommand(ctx, 'doc.zproj.begin', { method: 'mode', width: 4, height: 4, depth: 2, channels: [{ name: 'A' }] }, E)), 'IJ_BAD_ARGS');
  const { token } = await callCommand(ctx, 'doc.zproj.begin', { method: 'max', width: 4, height: 4, depth: 2, channels: [{ name: 'A' }, { name: 'B' }], calibration: CAL, bandRows: 4 }, E);
  assert.equal(await codeOf(callCommand(ctx, 'doc.zproj.add', { token, y0: 0, rows: 4, z0: 0, depth: 1, data: [new Uint8Array(16)] }, E)), 'IJ_BAD_ARGS', 'one array per channel');
  assert.equal(await codeOf(callCommand(ctx, 'doc.zproj.finish', { token }, E)), 'IJ_INCOMPLETE', 'a projection that was not fed is not a document');
  assert.equal(await codeOf(callCommand(ctx, 'doc.oblique.finish', { token }, E)), 'IJ_LIB_NO_TOKEN', 'a z token is not an oblique token');
});

console.log('test_ij_lib_oblique: ' + passed + ' groups passed');
