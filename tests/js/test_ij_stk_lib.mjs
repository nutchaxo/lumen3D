// File › Open from Library as a real z-stack (ij-proc-lib.js): doc.tiff.stack (an original TIFF read page by page, Range requests batched)
// and doc.stack.begin / add / finish / abort (the planes of a processed volume streamed in bands), driven directly with a recorded worker `E`
// over synthetic TIFFs. Every plane equals the source plane, the whole stack is reserved before the first request, no per-plane request burst,
// cancel leaves no document.  The panel and entry flow halves: test_ij_stk_lib_panel.mjs.
// Run: node tests/js/test_ij_stk_lib.mjs
import assert from 'node:assert/strict';
import { loadLib, buildTiff, imagej, host, makeE, callCommand, BASE_URL } from './ij_lib_support.mjs';

const ctx = loadLib();
let passed = 0;
const test = async (name, fn) => { try { await fn(); passed++; } catch (e) { console.error('FAIL ' + name); throw e; } };
const codeOf = async (p) => { try { await p; } catch (e) { return e.code || e.name; } return null; };
const arr = (a) => Array.from(a);
const ij = (c, z, extra) => imagej({ channels: c, slices: z, spacing: 2, info: 'Source: Imaris .ims ResolutionLevel 1', ranges: [0, 200, 5, 180, 1, 90], colors: ['#ff0000', '#00ff00', '#0000ff'], labels: ['A', 'B', 'C'], ...(extra || {}) });
const argsFor = (t, o) => ({ url: t.index.url, index: t.index, z0: 0, z1: 3, frame: 0, name: 'S', calibration: { pixelWidth: 0.5, pixelHeight: 0.5, pixelDepth: 2, unit: 'µm' },
  provenance: { source: 'library' }, sessionKey: 'lib|stack', channels: [{ c: 0, name: 'A', color: '#ff0000' }], ...(o || {}) });
const planeOf = (t, page, s = 0) => { const w = t.index.width, h = t.index.height, bits = t.index.bitsPerSample; const a = bits === 8 ? new Uint8Array(w * h) : bits === 16 ? new Uint16Array(w * h) : new Float32Array(w * h); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) a[y * w + x] = t.pixel(page, x, y, s); return a; };

await test('doc.tiff.stack: every plane of every channel, 8 / 16 / 32-bit, deflate + predictor, strips', async () => {
  for (const bits of [8, 16, 32]) {
    const pixel = (p, x, y) => (bits === 32 ? ((p + 1) * 3.25 + x * 0.5 - y * 0.125) : ((p * 37 + x * 5 + y * 11) % 250 + 1));
    const t = buildTiff({ w: 13, h: 11, pages: 12, bits, rowsPerStrip: 3, compression: 'deflate', predictor: bits === 32 ? 1 : 2, imagej: ij(3, 4), pixel });   // 3 channels × 4 slices
    const h = host(t.file);
    const E = makeE({ fetchImpl: h.fetchImpl });
    const channels = [0, 1, 2].map((c) => ({ c, name: 'ch' + c, color: ['#ff0000', '#00ff00', '#0000ff'][c] }));
    const res = await callCommand(ctx, 'doc.tiff.stack', argsFor(t, { z0: 1, z1: 3, channels }), E);
    assert.equal(E.rec.docs.length, 1);
    const img = E.rec.docs[0].image;
    assert.deepEqual([img.width, img.height, img.bitDepth, img.nZ, img.nT, img.hyperstack, img.name], [13, 11, bits, 3, 1, true, 'S']);
    assert.equal(img.calibration.pixelDepth, 2); assert.equal(img.calibration.unit, 'µm');
    img.channels.forEach((c, k) => {
      assert.equal(c.planes.length, 3); assert.equal(c.name, 'ch' + k);
      c.planes.forEach((p, zi) => assert.deepEqual(arr(p), arr(planeOf(t, (zi + 1) * 3 + k)), `bits ${bits} channel ${k} slice ${zi + 1}`));
      assert.deepEqual(JSON.parse(JSON.stringify(c.display)), { min: [0, 5, 1][k] * 1, max: [200, 180, 90][k], lut: ['Red', 'Green', 'Blue'][k], invert: false });
    });
    assert.equal(res.requests, h.log.requests);
    // a batched read: far fewer requests than pages (9 pages here)
    assert.ok(h.log.requests <= 3, 'requests ' + h.log.requests);
    assert.ok(E.rec.reservations.length >= 1);
  }
});

await test('doc.tiff.stack: a single channel stack is not a hyperstack; chunky RGB pages are read as three channels', async () => {
  const t = buildTiff({ w: 9, h: 7, pages: 5, bits: 8, imagej: ij(1, 5) });
  const E = makeE({ fetchImpl: host(t.file).fetchImpl });
  await callCommand(ctx, 'doc.tiff.stack', argsFor(t, { z0: 0, z1: 4 }), E);
  const img = E.rec.docs[0].image;
  assert.deepEqual([img.nZ, img.hyperstack, img.channels.length], [5, false, 1]);
  img.channels[0].planes.forEach((p, z) => assert.deepEqual(arr(p), arr(planeOf(t, z))));
  const rgb = buildTiff({ w: 6, h: 5, pages: 3, bits: 8, spp: 3, imagej: null });
  const E2 = makeE({ fetchImpl: host(rgb.file).fetchImpl });
  await callCommand(ctx, 'doc.tiff.stack', argsFor(rgb, { z0: 0, z1: 2, asChannels: false, channels: [0, 1, 2].map((c) => ({ c, name: 'c' + c, color: '#ffffff' })) }), E2);
  const im2 = E2.rec.docs[0].image;
  assert.equal(im2.nZ, 3);
  im2.channels.forEach((c, k) => c.planes.forEach((p, z) => assert.deepEqual(arr(p), arr(planeOf(rgb, z, k)))));
});

await test('doc.tiff.stack: refusals come before one byte is requested; cancel leaves no document', async () => {
  const t = buildTiff({ w: 40, h: 30, pages: 8, bits: 16, imagej: ij(1, 8) });
  const h = host(t.file);
  const over = makeE({ fetchImpl: h.fetchImpl, limit: 8 * 40 * 30 * 2 - 1 });
  assert.equal(await codeOf(callCommand(ctx, 'doc.tiff.stack', argsFor(t, { z0: 0, z1: 7 }), over)), 'IJ_OVER_BUDGET');
  assert.equal(h.log.requests, 0, 'nothing requested');
  assert.equal(over.rec.docs.length, 0);
  for (const bad of [{ z0: 5, z1: 2 }, { z0: 0, z1: 99 }, { frame: 3 }, { channels: [] }, { channels: [{ c: 7 }] }, { url: 'nope' }]) {
    assert.equal(await codeOf(callCommand(ctx, 'doc.tiff.stack', argsFor(t, { z0: 0, z1: 3, ...bad }), makeE({ fetchImpl: h.fetchImpl }))), 'IJ_BAD_ARGS', JSON.stringify(Object.keys(bad)));
  }
  const E = makeE({ fetchImpl: host(t.file).fetchImpl, cancelAfter: 1 });
  assert.equal(await codeOf(callCommand(ctx, 'doc.tiff.stack', argsFor(t, { z0: 0, z1: 7 }), E)), 'IJ_CANCELLED');
  assert.equal(E.rec.docs.length, 0);
  assert.equal(await codeOf(callCommand(ctx, 'doc.tiff.stack', argsFor(t, { z0: 0, z1: 7 }), makeE({ fetchImpl: host(t.file, 'http500').fetchImpl }))) !== null, true, 'a host error is an error');
});

await test('doc.stack.*: planes streamed in bands and z chunks make the stack, the stack is reserved by begin', async () => {
  const W = 10, H = 9, D = 5, C = 2;
  const value = (c, x, y, z) => (c * 90 + x * 3 + y * 7 + z * 11) % 251;
  const E = makeE();
  const begin = await callCommand(ctx, 'doc.stack.begin', { width: W, height: H, depth: D, channels: [{ name: 'a', color: '#ff0000' }, { name: 'b', color: '#00ff00' }], name: 'vol z0-4', calibration: { pixelWidth: 0.3, pixelHeight: 0.3, pixelDepth: 1.2, unit: 'µm' },
    provenance: { source: 'library' }, sessionKey: 'k' }, E);
  assert.equal(begin.bytes, C * D * W * H);
  assert.deepEqual(E.rec.reservations, [C * D * W * H], 'reserved whole');
  let last = 0;
  for (const [y0, y1] of [[0, 4], [4, 9]]) for (const [z0, z1] of [[0, 2], [2, 5]]) {
    const rows = y1 - y0, depth = z1 - z0;
    const data = [0, 1].map((c) => { const a = new Uint8Array(depth * rows * W); for (let z = 0; z < depth; z++) for (let y = 0; y < rows; y++) for (let x = 0; x < W; x++) a[(z * rows + y) * W + x] = value(c, x, y0 + y, z0 + z); return a; });
    last = (await callCommand(ctx, 'doc.stack.add', { token: begin.token, y0, rows, z0, depth, data }, E)).fraction;
  }
  assert.equal(last, 1);
  const fin = await callCommand(ctx, 'doc.stack.finish', { token: begin.token }, E);
  const img = E.rec.docs[0].image;
  assert.deepEqual([img.width, img.height, img.bitDepth, img.nZ, img.nT, img.hyperstack, img.name], [W, H, 8, D, 1, true, 'vol z0-4']);
  assert.equal(img.calibration.pixelDepth, 1.2);
  img.channels.forEach((c, k) => c.planes.forEach((p, z) => { for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (p[y * W + x] !== value(k, x, y, z)) assert.fail(`channel ${k} z ${z} (${x},${y})`); }));
  assert.equal(fin.info.docId, 'doc1');
  assert.equal(await codeOf(callCommand(ctx, 'doc.stack.finish', { token: begin.token }, E)), 'IJ_LIB_NO_TOKEN', 'a finished token is gone');
  // over budget: refused by begin, nothing allocated
  const small = makeE({ limit: C * D * W * H - 1 });
  assert.equal(await codeOf(callCommand(ctx, 'doc.stack.begin', { width: W, height: H, depth: D, channels: [{ name: 'a' }, { name: 'b' }] }, small)), 'IJ_OVER_BUDGET');
  // a single channel is no hyperstack; a bad block / unknown token / abort
  const E3 = makeE();
  const b3 = await callCommand(ctx, 'doc.stack.begin', { width: 4, height: 3, depth: 2, channels: [{ name: 'only' }] }, E3);
  assert.equal(await codeOf(callCommand(ctx, 'doc.stack.add', { token: b3.token, y0: 0, rows: 4, z0: 0, depth: 1, data: [new Uint8Array(16)] }, E3)), 'IJ_BAD_ARGS', 'rows past the height');
  assert.equal(await codeOf(callCommand(ctx, 'doc.stack.add', { token: b3.token, y0: 0, rows: 3, z0: 0, depth: 1, data: [new Uint8Array(5)] }, E3)), 'IJ_BAD_ARGS', 'a block of the wrong size');
  assert.equal(await codeOf(callCommand(ctx, 'doc.stack.add', { token: 'nope', y0: 0, rows: 1, z0: 0, depth: 1, data: [new Uint8Array(4)] }, E3)), 'IJ_LIB_NO_TOKEN');
  assert.equal((await callCommand(ctx, 'doc.stack.abort', { token: b3.token }, E3)).dropped, true);
  assert.equal(await codeOf(callCommand(ctx, 'doc.stack.finish', { token: b3.token }, E3)), 'IJ_LIB_NO_TOKEN');
  const b4 = await callCommand(ctx, 'doc.stack.begin', { width: 4, height: 3, depth: 2, channels: [{ name: 'only' }] }, E3);
  await callCommand(ctx, 'doc.stack.finish', { token: b4.token }, E3);
  assert.deepEqual([E3.rec.docs[0].image.hyperstack, E3.rec.docs[0].image.nZ], [false, 2]);
});

console.log(`ok test_ij_stk_lib (${passed} groups) ${BASE_URL ? '' : ''}`.trim());
