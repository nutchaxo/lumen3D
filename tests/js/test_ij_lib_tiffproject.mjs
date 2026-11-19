// doc.tiff.project (ij-proc-lib.js): the projection of an original TIFF, read page by page with Range requests into IJProject.
// Driven directly with a recorded worker `E` over synthetic TIFFs (deflate + predictor, 8 / 16 / 32-bit, chunky RGB, strips split in
// bands by a small memory budget), every method against a whole-plane IJProject reference; request counts, a host that ignores Range,
// cancel (no document), refusals before one byte is requested.
//
// Run: node tests/js/test_ij_lib_tiffproject.mjs
import assert from 'node:assert/strict';
import { loadLib, buildTiff, imagej, host, makeE, callCommand, sameArray, referenceProject, BASE_URL } from './ij_lib_support.mjs';

const ctx = loadLib();
let passed = 0;
const test = async (name, fn) => { await fn(); passed++; };
const codeOf = async (p) => { try { await p; } catch (e) { return e.code || e.name; } return null; };
const J = (x) => JSON.parse(JSON.stringify(x));

const METHODS = ['avg', 'max', 'min', 'sum', 'sd', 'median'];
const ij = (c, z, extra) => imagej({ channels: c, slices: z, spacing: 2, info: 'Source: Imaris .ims ResolutionLevel 1', ranges: [0, 200, 5, 180, 1, 90], colors: ['#ff0000', '#00ff00', '#0000ff'], labels: ['A', 'B', 'C'], ...(extra || {}) });
const argsFor = (t, o) => ({ url: t.index.url, index: t.index, z0: 0, z1: 0, frame: 0, method: 'max', name: 'T', calibration: { pixelWidth: 0.5, pixelHeight: 0.5, unit: 'µm' },
  provenance: { source: 'library' }, sessionKey: 'lib|x', channels: [{ c: 0, name: 'A', color: '#ff0000' }], ...(o || {}) });

await test('every method on a deflate + predictor 8-bit stack equals the whole-plane IJProject reference, bands and requests included', async () => {
  const t = buildTiff({ w: 13, h: 11, pages: 12, bits: 8, rowsPerStrip: 3, compression: 'deflate', predictor: 2, imagej: ij(3, 4) });   // 3 channels × 4 slices, 4 strips per page
  const h = host(t.file);
  for (const method of METHODS) {
    const E = makeE({ fetchImpl: h.fetchImpl });
    const channels = [0, 1, 2].map((c) => ({ c, name: 'ch' + c, color: ['#ff0000', '#00ff00', '#0000ff'][c] }));
    const res = await callCommand(ctx, 'doc.tiff.project', argsFor(t, { method, z0: 1, z1: 3, channels }), E);
    const ref = referenceProject(ctx, t, { method, z0: 1, z1: 3, channels: [0, 1, 2], page: (z, c) => z * 3 + c });
    assert.equal(E.rec.docs.length, 1, method + ': one document');
    const img = E.rec.docs[0].image;
    assert.equal(img.bitDepth, ref[0].bitDepth, method + ': bit depth');
    img.channels.forEach((c, k) => sameArray(c.data, ref[k].data, `${method} channel ${k}`));
    assert.equal(res.info.docId, 'doc1');
    assert.deepEqual([img.width, img.height, img.name], [13, 11, 'T']);
    assert.deepEqual(J(E.rec.docs[0].opts), { provenance: { source: 'library' }, sessionKey: 'lib|x' });
  }
});

await test('16-bit: max / min / average keep 16 bits, median / sum / sd are 32-bit; the stored display range goes with a multichannel projection except Sum and SD', async () => {
  const t = buildTiff({ w: 9, h: 6, pages: 6, bits: 16, compression: 'deflate', predictor: 2, imagej: ij(2, 3, { ranges: [0, 4000, 10, 3000] }),
    pixel: (p, x, y) => ((p + 1) * 4001 + x * 977 + y * 331) % 65536 });
  const h = host(t.file);
  for (const method of METHODS) {
    const E = makeE({ fetchImpl: h.fetchImpl });
    await callCommand(ctx, 'doc.tiff.project', argsFor(t, { method, z0: 0, z1: 2, channels: [{ c: 0, name: 'A', color: '#ff0000' }, { c: 1, name: 'B', color: '#00ff00' }] }), E);
    const ref = referenceProject(ctx, t, { method, z0: 0, z1: 2, channels: [0, 1], page: (z, c) => z * 2 + c });
    const img = E.rec.docs[0].image;
    const want = method === 'sum' || method === 'sd' || method === 'median' ? 32 : 16;
    assert.equal(img.bitDepth, want, method);
    img.channels.forEach((c, k) => sameArray(c.data, ref[k].data, `${method} ${k}`));
    if (method !== 'sum' && method !== 'sd') {                 // ZProjector copies the LUTs of a multichannel image and resets Sum / SD only (:446-450)
      assert.deepEqual(J(img.channels[0].display), { min: 0, max: 4000, lut: 'Red', invert: false }, method + ': the acquisition display range of the first channel');
      assert.deepEqual(J(img.channels[1].display), { min: 10, max: 3000, lut: 'Green', invert: false });
    } else assert.equal(img.channels[0].display, undefined, method + ': a changed scale takes the engine default');
  }
});

await test('a single-channel projection takes the engine default display (ZProjector resets it to the data range), a single plane keeps the file display', async () => {
  const t = buildTiff({ w: 9, h: 6, pages: 3, bits: 16, compression: 'deflate', imagej: ij(1, 3, { ranges: [0, 4000] }), pixel: (p, x, y) => ((p + 1) * 4001 + x * 977 + y * 331) % 65536 });
  const h = host(t.file);
  for (const method of ['avg', 'max', 'median']) {
    const E = makeE({ fetchImpl: h.fetchImpl });
    await callCommand(ctx, 'doc.tiff.project', argsFor(t, { method, z0: 0, z1: 2 }), E);
    assert.equal(E.rec.docs[0].image.channels[0].display, undefined, method);
  }
  const E = makeE({ fetchImpl: h.fetchImpl });
  await callCommand(ctx, 'doc.tiff.project', argsFor(t, { method: 'avg', z0: 1, z1: 1 }), E);
  assert.deepEqual(J(E.rec.docs[0].image.channels[0].display), { min: 0, max: 4000, lut: 'Red', invert: false }, 'one plane is a copy');
});

await test('the page is told how far the pages are read (libTiffProgress, whole percents, ends at 1)', async () => {
  const t = buildTiff({ w: 9, h: 6, pages: 4, bits: 8, imagej: ij(1, 4) });
  const h = host(t.file);
  const E = makeE({ fetchImpl: h.fetchImpl });
  await callCommand(ctx, 'doc.tiff.project', argsFor(t, { method: 'max', z0: 0, z1: 3 }), E);
  const ev = E.rec.events.filter((e) => e.event === 'libTiffProgress');
  assert.ok(ev.length >= 2);
  assert.equal(ev[ev.length - 1].fraction, 1);
  assert.ok(ev.every((e, i) => i === 0 || e.fraction > ev[i - 1].fraction), 'increasing');
});

await test('32-bit float with NaN: average skips NaN per pixel (the float path), max / min keep the type', async () => {
  const t = buildTiff({ w: 7, h: 5, pages: 4, bits: 32, compression: 'deflate', imagej: ij(1, 4), pixel: (p, x, y) => ((x + y + p) % 4 === 0 && p % 2 === 0 ? NaN : p * 1.5 + x * 0.25 + y) });
  const h = host(t.file);
  for (const method of ['avg', 'max', 'min', 'sum']) {
    const E = makeE({ fetchImpl: h.fetchImpl });
    await callCommand(ctx, 'doc.tiff.project', argsFor(t, { method, z0: 0, z1: 3 }), E);
    const ref = referenceProject(ctx, t, { method, z0: 0, z1: 3, channels: [0], page: (z) => z });
    assert.equal(E.rec.docs[0].image.bitDepth, 32);
    sameArray(E.rec.docs[0].image.channels[0].data, ref[0].data, method);
  }
});

await test('a single plane (one slice) is the page itself, and a chunky RGB page is three channels', async () => {
  const t = buildTiff({ w: 8, h: 6, pages: 2, bits: 8, spp: 3, rowsPerStrip: 2, imagej: null, resolution: { x: 100, y: 100, unit: 3 } });
  const h = host(t.file);
  const E = makeE({ fetchImpl: h.fetchImpl });
  await callCommand(ctx, 'doc.tiff.project', argsFor(t, { asChannels: true, method: 'avg', z0: 1, z1: 1, channels: [0, 1, 2].map((c) => ({ c, name: 'RGB'[c], color: ['#ff0000', '#00ff00', '#0000ff'][c] })) }), E);
  const img = E.rec.docs[0].image;
  assert.equal(img.channels.length, 3);
  for (let c = 0; c < 3; c++) {
    const want = new Uint8Array(8 * 6);
    for (let y = 0; y < 6; y++) for (let x = 0; x < 8; x++) want[y * 8 + x] = t.pixel(1, x, y, c);
    sameArray(img.channels[c].data, want, 'plane ' + c);
  }
  assert.equal(h.log.requests, 1, 'one page = one request');
  // the pages of a photograph without ImageJ metadata are its channels
  const plain = buildTiff({ w: 8, h: 6, pages: 3, bits: 8 });
  const E2 = makeE({ fetchImpl: host(plain.file).fetchImpl });
  await callCommand(ctx, 'doc.tiff.project', argsFor(plain, { asChannels: true, method: 'avg', channels: [0, 1, 2].map((c) => ({ c, name: 'C' + c })) }), E2);
  const g = E2.rec.docs[0].image.channels[2].data;
  assert.equal(g[0], plain.pixel(2, 0, 0, 0));
  assert.equal(g[8 * 6 - 1], plain.pixel(2, 7, 5, 0));
});

await test('a small memory budget cuts the pages in bands of whole strips: the same picture, more requests', async () => {
  const t = buildTiff({ w: 16, h: 40, pages: 6, bits: 8, rowsPerStrip: 4, compression: 'deflate', imagej: ij(2, 3) });      // 10 strips per page
  const h = host(t.file);
  const FETCH = 4 * 1048576;                         // what the handler keeps for the requests in flight at a 16 MiB budget
  const big = makeE({ fetchImpl: h.fetchImpl, budgetBytes: 16 << 20 });
  await callCommand(ctx, 'doc.tiff.project', argsFor(t, { method: 'median', z0: 0, z1: 2, channels: [{ c: 0, name: 'A' }, { c: 1, name: 'B' }] }), big);
  const whole = big.rec.docs[0].image.channels.map((c) => c.data);
  const requestsWhole = h.log.requests;
  // a limit that refuses the whole-page band: the handler halves its band until the reservation fits
  const need = big.rec.reservations[0];
  assert.ok(need > FETCH);
  const limit = Math.floor(FETCH + (need - FETCH) * 0.7);
  const h2 = host(t.file);
  const small = makeE({ fetchImpl: h2.fetchImpl, budgetBytes: 16 << 20, limit });
  await callCommand(ctx, 'doc.tiff.project', argsFor(t, { method: 'median', z0: 0, z1: 2, channels: [{ c: 0, name: 'A' }, { c: 1, name: 'B' }] }), small);
  assert.ok(small.rec.reservations[0] <= limit, 'it reserved what fits');
  small.rec.docs[0].image.channels.forEach((c, k) => sameArray(c.data, whole[k], 'banded channel ' + k));
  assert.ok(h2.log.requests > requestsWhole, `bands: ${h2.log.requests} requests against ${requestsWhole}`);
  // a limit nothing fits
  assert.equal(await codeOf(callCommand(ctx, 'doc.tiff.project', argsFor(t, { method: 'median', z0: 0, z1: 2, channels: [{ c: 0, name: 'A' }] }), makeE({ fetchImpl: host(t.file).fetchImpl, limit: 10 }))), 'IJ_OVER_BUDGET');
});

await test('the request budget: several pages per request (multi-range), never one request per strip', async () => {
  const t = buildTiff({ w: 8, h: 32, pages: 40, bits: 8, rowsPerStrip: 4, compression: 'deflate', imagej: ij(1, 40) });          // 8 strips per page
  const h = host(t.file);
  const E = makeE({ fetchImpl: h.fetchImpl });
  await callCommand(ctx, 'doc.tiff.project', argsFor(t, { method: 'max', z0: 0, z1: 39 }), E);
  assert.ok(h.log.requests <= Math.ceil(40 / 32) + 1, `${h.log.requests} requests for 40 pages (the strips of a page are one range)`);
  assert.ok(Math.max(...h.log.ranges) >= 8, 'a request carries several ranges');
  assert.ok(E.rec.ticks >= 40, 'progress per page');
});

await test('a host that ignores Range: the body is dropped at once and the user hears IJ_LIB_TIFF_NO_RANGE; one that refuses several ranges still works', async () => {
  const t = buildTiff({ w: 8, h: 8, pages: 4, bits: 8, imagej: ij(1, 4) });
  const ign = makeE({ fetchImpl: host(t.file, 'ignore').fetchImpl });
  assert.equal(await codeOf(callCommand(ctx, 'doc.tiff.project', argsFor(t, { method: 'max', z0: 0, z1: 3 }), ign)), 'IJ_LIB_TIFF_NO_RANGE');
  assert.equal(ign.rec.docs.length, 0, 'no document');
  ctx.IJTiffStream._refusedMulti.clear();
  const h = host(t.file, 'refuse-multi');
  const E = makeE({ fetchImpl: h.fetchImpl });
  await callCommand(ctx, 'doc.tiff.project', argsFor(t, { method: 'max', z0: 0, z1: 3 }), E);
  const ref = referenceProject(ctx, t, { method: 'max', z0: 0, z1: 3, channels: [0], page: (z) => z });
  sameArray(E.rec.docs[0].image.channels[0].data, ref[0].data, 'one range per request');
  ctx.IJTiffStream._refusedMulti.clear();
  assert.equal(await codeOf(callCommand(ctx, 'doc.tiff.project', argsFor(t, { method: 'max', z0: 0, z1: 3 }), makeE({ fetchImpl: host(t.file, 'http500').fetchImpl }))), 'IJ_LIB_TIFF_HTTP');
});

await test('cancel: the task is flagged mid-read, nothing is left of the work (no document)', async () => {
  const t = buildTiff({ w: 8, h: 8, pages: 30, bits: 8, rowsPerStrip: 2, imagej: ij(1, 30) });
  const h = host(t.file);
  const E = makeE({ fetchImpl: h.fetchImpl, cancelAfter: 5 });
  assert.equal(await codeOf(callCommand(ctx, 'doc.tiff.project', argsFor(t, { method: 'avg', z0: 0, z1: 29 }), E)), 'IJ_CANCELLED');
  assert.equal(E.rec.docs.length, 0);
});

await test('refusals come before any request: unsupported TIFF, bad ranges, channels, url, method', async () => {
  const t = buildTiff({ w: 8, h: 8, pages: 4, bits: 8, imagej: ij(1, 4) });
  const h = host(t.file);
  const run = (over, index) => callCommand(ctx, 'doc.tiff.project', argsFor(index || t, over), makeE({ fetchImpl: h.fetchImpl }));
  assert.equal(await codeOf(run({}, { ...t, index: { ...t.index, compression: 5 } })), 'IJ_LIB_TIFF_UNSUPPORTED');
  assert.equal(await codeOf(run({ z1: 4 })), 'IJ_BAD_ARGS');
  assert.equal(await codeOf(run({ z0: 2, z1: 1 })), 'IJ_BAD_ARGS');
  assert.equal(await codeOf(run({ frame: 1 })), 'IJ_BAD_ARGS');
  assert.equal(await codeOf(run({ channels: [{ c: 1 }] })), 'IJ_BAD_ARGS');
  assert.equal(await codeOf(run({ channels: [] })), 'IJ_BAD_ARGS');
  assert.equal(await codeOf(run({ method: 'mode' })), 'IJ_BAD_ARGS');
  assert.equal(await codeOf(run({ url: 'DATA_WEB/relative.tif' })), 'IJ_BAD_ARGS', 'a relative URL would resolve against the worker script');
  assert.equal(await codeOf(run({ calibration: { pixelWidth: 0, pixelHeight: 1, unit: 'µm' } })), 'IJ_BAD_ARGS');
  assert.equal(h.log.requests, 0, 'nothing was requested');
  assert.ok(BASE_URL.startsWith('http'));
});

console.log('test_ij_lib_tiffproject: ' + passed + ' groups passed');
