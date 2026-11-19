// IJTiffStream (ij-proc-lib.js): the plan of a TIFF index, the request runs (multi-range, request budget),
// the multipart parsing and its fallbacks, a host that ignores Range, and the strip decoding (deflate,
// predictor 2, byte order, 8 / 16 / 32-bit float, chunky RGB). A real bundle TIFF is read when the local
// DATA_WEB holds one.
//
// Run: node tests/js/test_ij_lib_tiff.mjs
import assert from 'node:assert/strict';
import vm from 'node:vm';
import zlib from 'node:zlib';
import { readFileSync, existsSync, openSync, readSync, closeSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FILE = 'js/modules/studio/advanced-studio/ij-proc-lib.js';
vm.runInThisContext(readFileSync(path.join(ROOT, FILE), 'utf8'), { filename: FILE });
const { IJTiffStream } = globalThis;

let passed = 0;
async function test(name, fn) { await fn(); passed++; }
const codeOf = async (fn) => { try { await fn(); } catch (e) { return e.code; } return null; };

const b64 = (u8) => Buffer.from(u8).toString('base64');
function tables(offsets, counts) {
  const o = new Float64Array(offsets), c = new Uint32Array(counts);
  return { offsets: b64(new Uint8Array(o.buffer)), byteCounts: b64(new Uint8Array(c.buffer)) };
}

// A synthetic file: `pages` pages of `strips` strips each, IFD-sized gaps between pages; payload strip bytes
// are given by `payload(page, strip)`. → { file: Uint8Array, offsets, counts }
function layout(pages, strips, payload, gap = 40) {
  const offsets = [], counts = [], parts = [new Uint8Array(8)];
  let at = 8;
  for (let p = 0; p < pages; p++) {
    for (let s = 0; s < strips; s++) {
      const bytes = payload(p, s);
      offsets.push(at); counts.push(bytes.length);
      parts.push(bytes); at += bytes.length;
    }
    parts.push(new Uint8Array(gap).fill(0xEE)); at += gap;     // the page's IFD
  }
  const file = new Uint8Array(at);
  let k = 0;
  for (const p of parts) { file.set(p, k); k += p.length; }
  return { file, offsets, counts };
}

function indexOf(over, lay) {
  return {
    v: 1, dataset: '3d/demo', file: 'demo.tif', url: 'DATA_WEB/3d/demo/download/demo.tif', size: lay.file.length, mtime: 1,
    bigtiff: false, littleEndian: true, width: 8, height: 8, bitsPerSample: 8, sampleFormat: 1, samplesPerPixel: 1,
    planarConfig: 1, photometric: 1, compression: 1, predictor: 1, tiled: false, rowsPerStrip: 2, pages: 0, uniform: true,
    resolution: { x: 2, y: 2, unit: 1 }, imagej: null,
    strips: { perPage: 4, ...tables(lay.offsets, lay.counts) }, ...over
  };
}

// A fake host over `file`: Range with several parts → multipart/byteranges, one → 206, mode switches.
function host(file, mode = 'multi') {
  const log = { requests: 0, inFlight: 0, maxInFlight: 0, cancelled: 0, ranges: [] };
  const fetchImpl = async (url, init) => {
    log.requests++; log.inFlight++; log.maxInFlight = Math.max(log.maxInFlight, log.inFlight);
    await new Promise((r) => setTimeout(r, 2));
    try {
      const spec = /bytes=(.*)/.exec(init.headers.Range)[1].split(',').map((s) => s.trim().split('-').map(Number));
      log.ranges.push(spec.length);
      if (mode === 'ignore') {
        return new Response(new ReadableStream({ start(c) { c.enqueue(file.subarray(0, 16)); }, cancel() { log.cancelled++; } }), { status: 200 });
      }
      if (spec.length > 1 && mode === 'refuse-multi') return new Response('', { status: 416 });
      if (spec.length > 1 && mode === 'ignore-multi') return new Response(new ReadableStream({ start(c) { c.enqueue(file.subarray(0, 16)); }, cancel() { log.cancelled++; } }), { status: 200 });
      if (spec.length > 1 && mode === 'plain-206') return new Response(file.slice(spec[0][0], spec[0][1] + 1), { status: 206 });
      if (spec.length === 1 || mode === 'union') {
        const a = Math.min(...spec.map((s) => s[0])), b = Math.max(...spec.map((s) => s[1]));
        if (spec.length > 1 && mode === 'union') {
          return new Response(file.slice(a, b + 1), { status: 206, headers: { 'Content-Range': `bytes ${a}-${b}/${file.length}` } });
        }
        return new Response(file.slice(a, b + 1), { status: 206, headers: { 'Content-Range': `bytes ${a}-${b}/${file.length}` } });
      }
      const boundary = 'THIS_STRING_SEPARATES';
      const chunks = [];
      const enc = (s) => Buffer.from(s, 'latin1');
      for (const [a, b] of spec) {
        chunks.push(enc(`--${boundary}\r\nContent-Type: image/tiff\r\nContent-Range: bytes ${a}-${b}/${file.length}\r\n\r\n`), Buffer.from(file.subarray(a, b + 1)), enc('\r\n'));
      }
      chunks.push(enc(`--${boundary}--\r\n`));
      return new Response(Buffer.concat(chunks), { status: 206, headers: { 'Content-Type': `multipart/byteranges; boundary=${boundary}` } });
    } finally { log.inFlight--; }
  };
  return { fetchImpl, log };
}

const sameBytes = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

await test('plan: hyperstack shape, page order (channels fastest), calibration, refusals', () => {
  const lay = layout(6, 4, (p, s) => new Uint8Array(16).fill(p * 10 + s));
  const ij = { version: '1.54f', images: 6, channels: 3, slices: 2, frames: 1, hyperstack: true, mode: 'composite', unit: 'micron', spacing: 2.5, ranges: [0, 255, 0, 100, 5, 9], colors: ['#ff0000', '#00ff00', '#0000ff'], labels: ['A', 'B', 'C'] };
  const idx = indexOf({ pages: 6, imagej: ij, resolution: { x: 2.5, y: 2.5, unit: 1 } }, lay);
  const p = IJTiffStream.plan(idx);
  assert.deepEqual([p.channels, p.slices, p.frames, p.pages], [3, 2, 1, 6]);
  assert.equal(p.spacingUm, 2.5);
  assert.ok(Math.abs(p.pixelUm.x - 0.4) < 1e-12 && Math.abs(p.pixelUm.y - 0.4) < 1e-12);
  assert.deepEqual(p.colors, ij.colors);
  assert.equal(IJTiffStream.pageOf(p, { z: 1, c: 2, t: 0 }), 5);
  assert.equal(IJTiffStream.pageOf(p, { z: 0, c: 1, t: 0 }), 1);
  assert.equal(p.bitDepth, 8); assert.equal(p.float, false);
  const s = p.stripsOf(3);
  assert.deepEqual(Array.from(s.offsets), lay.offsets.slice(12, 16));
  assert.deepEqual(Array.from(s.counts), [16, 16, 16, 16]);
  assert.throws(() => IJTiffStream.pageOf(p, { z: 2, c: 0, t: 0 }), (e) => e.code === 'IJ_LIB_BAD_ARGS');
  // without ImageJ: a flat stack of slices
  const flat = IJTiffStream.plan(indexOf({ pages: 6 }, lay));
  assert.deepEqual([flat.channels, flat.slices], [1, 6]);
  // a shape that does not multiply out falls back to a flat stack
  const odd = IJTiffStream.plan(indexOf({ pages: 6, imagej: { ...ij, channels: 4 } }, lay));
  assert.deepEqual([odd.channels, odd.slices], [1, 6]);

  const refuse = (over, detail) => {
    try { IJTiffStream.plan(indexOf({ pages: 6, ...over }, lay)); } catch (e) { assert.equal(e.code, 'IJ_LIB_TIFF_UNSUPPORTED'); assert.match(e.detail, detail); return; }
    assert.fail('not refused: ' + detail);
  };
  refuse({ compression: 5 }, /compression 5/);
  refuse({ compression: 7 }, /compression/);
  refuse({ predictor: 3 }, /predictor 3/);
  refuse({ bitsPerSample: 12 }, /bits 12/);
  refuse({ bitsPerSample: 32, sampleFormat: 1 }, /32-bit integer/);
  refuse({ bitsPerSample: 16, sampleFormat: 2 }, /sample format 2/);
  refuse({ tiled: true }, /tiled/);
  refuse({ samplesPerPixel: 3, planarConfig: 2 }, /planar/);
  refuse({ uniform: false }, /non-uniform/);
  assert.equal(IJTiffStream.plan(indexOf({ pages: 6, compression: 8, predictor: 2, bitsPerSample: 16 }, lay)).bitDepth, 16);
  assert.equal(IJTiffStream.plan(indexOf({ pages: 6, compression: 32946 }, lay)).compression, 32946);
  const f32 = IJTiffStream.plan(indexOf({ pages: 6, bitsPerSample: 32, sampleFormat: 3 }, lay));
  assert.equal(f32.float, true);
});

await test('plan: an ImageJ single-directory stack is expanded to its images', () => {
  const lay = layout(1, 4, () => new Uint8Array(16).fill(1), 0);
  const idx = indexOf({ pages: 1, imagej: { images: 5, channels: 1, slices: 5, frames: 1, ranges: [], colors: [], labels: [] } }, lay);
  const p = IJTiffStream.plan(idx);
  assert.equal(p.pages, 5);
  assert.deepEqual(Array.from(p.stripsOf(2).offsets), lay.offsets.map((o) => o + 2 * 64));
});

await test('runs: one range per page, ≤ 32 parts and ≤ 32 MiB per request, in order', () => {
  // the E8-1 shape: 300 pages × 16 strips of small payloads → ⌈300 / 32⌉ requests, not 4800
  const lay = layout(300, 16, (p, s) => new Uint8Array(64));
  const p = IJTiffStream.plan(indexOf({ pages: 300, strips: { perPage: 16, ...tables(lay.offsets, lay.counts) }, height: 32 }, lay));
  const all = Array.from({ length: 300 }, (_, i) => i);
  const runs = IJTiffStream.runs(p, all);
  assert.equal(runs.length, Math.ceil(300 / 32));
  for (const r of runs) {
    assert.ok(r.ranges.length <= 32);
    assert.equal(new Set(r.parts.map((q) => q.page)).size, r.ranges.length, 'one range per page');
  }
  assert.deepEqual(runs.flatMap((r) => r.parts.filter((q) => q.strip === 0).map((q) => q.page)), all);
  // big pages: the byte budget splits the runs
  const big = layout(40, 4, () => new Uint8Array(3 * 1024 * 1024), 8);
  const pb = IJTiffStream.plan(indexOf({ pages: 40, strips: { perPage: 4, ...tables(big.offsets, big.counts) } }, big));
  const rb = IJTiffStream.runs(pb, Array.from({ length: 40 }, (_, i) => i), { maxBytes: 32 * 1024 * 1024 });
  assert.equal(rb.length, 20, 'two 12 MiB pages per 32 MiB request; a page is never split');
  for (const r of rb) assert.ok(r.parts.reduce((a, q) => a + q.len, 0) <= 32 * 1024 * 1024);
  // a page larger than the budget is a run of its own
  assert.equal(IJTiffStream.runs(pb, [0, 1], { maxBytes: 1024 }).length, 2);
  // strip bands of one page
  const bands = IJTiffStream.bands(pb, { maxBytes: 100, channels: 1 });
  assert.deepEqual(bands.map((b) => [b.s0, b.s1]), [[0, 1], [1, 2], [2, 3], [3, 4]]);
  assert.deepEqual(bands.map((b) => [b.y0, b.y1]), [[0, 2], [2, 4], [4, 6], [6, 8]]);
  const oneBand = IJTiffStream.runs(pb, [{ page: 3, s0: 1, s1: 3 }]);
  assert.deepEqual(oneBand[0].parts.map((q) => q.strip), [1, 2]);
  assert.equal(oneBand[0].ranges.length, 1, 'adjacent strips of a band are one range');
});

await test('fetchRun: multipart, single range, union answer, 416 fallback, a host that ignores Range', async () => {
  const lay = layout(10, 4, (p, s) => Uint8Array.from({ length: 50 + s }, (_, i) => (p * 31 + s * 7 + i) & 255));
  const p = IJTiffStream.plan(indexOf({ pages: 10, strips: { perPage: 4, ...tables(lay.offsets, lay.counts) } }, lay));
  const run = IJTiffStream.runs(p, [1, 4, 7])[0];
  assert.equal(run.ranges.length, 3);
  const expect = (page) => { const s = p.stripsOf(page); const parts = []; for (let i = 0; i < 4; i++) parts.push(lay.file.subarray(s.offsets[i], s.offsets[i] + s.counts[i])); return Uint8Array.from(Buffer.concat(parts)); };
  for (const mode of ['multi', 'union', 'refuse-multi', 'ignore-multi', 'plain-206']) {
    IJTiffStream._refusedMulti.clear();
    const h = host(lay.file, mode);
    const got = await IJTiffStream.fetchRun('http://x/demo.tif', run, { fetchImpl: h.fetchImpl });
    assert.deepEqual([...got.keys()].sort((a, b) => a - b), [1, 4, 7], mode);
    for (const page of [1, 4, 7]) assert.ok(sameBytes(got.get(page), expect(page)), `${mode} page ${page}`);
    if (mode === 'refuse-multi' || mode === 'ignore-multi' || mode === 'plain-206') {
      assert.deepEqual(h.log.ranges, [3, 1, 1, 1], 'one range per page after the refusal: ' + mode);
      assert.ok(IJTiffStream._refusedMulti.has('x'), 'the host is remembered');
      // the next run to that host goes one range per request, with no failing multi-range first
      const again = host(lay.file, mode);
      await IJTiffStream.fetchRun('http://x/demo.tif', run, { fetchImpl: again.fetchImpl });
      assert.deepEqual(again.log.ranges, [1, 1, 1], 'no multi-range retried: ' + mode);
      // and readPages plans one range per request for it
      assert.ok(IJTiffStream.readPages && IJTiffStream.runs(p, [1, 4, 7], { maxParts: 1 }).length === 3);
    } else assert.equal(h.log.requests, 1, mode);
  }
  // one page, one range
  const h1 = host(lay.file);
  const single = await IJTiffStream.fetchRun('http://x/demo.tif', IJTiffStream.runs(p, [2])[0], { fetchImpl: h1.fetchImpl });
  assert.ok(sameBytes(single.get(2), expect(2)));
  // a host that answers 200: the body is aborted at once, never read
  const h2 = host(lay.file, 'ignore');
  assert.equal(await codeOf(() => IJTiffStream.fetchRun('http://x/demo.tif', run, { fetchImpl: h2.fetchImpl })), 'IJ_LIB_TIFF_NO_RANGE');
  assert.ok(h2.log.cancelled >= 1);
  // a 200 to a SINGLE range is the host that ignores Range: NO_RANGE (a multi-range 200 only means 'one range at a time')
  IJTiffStream._refusedMulti.clear();
  const h3 = host(lay.file, 'ignore');
  assert.equal(await codeOf(() => IJTiffStream.fetchRun('http://x/demo.tif', IJTiffStream.runs(p, [2])[0], { fetchImpl: h3.fetchImpl })), 'IJ_LIB_TIFF_NO_RANGE');
  IJTiffStream._refusedMulti.clear();
  // abort
  const ctl = new AbortController(); ctl.abort();
  let aborted = null;
  try { await IJTiffStream.fetchRun('http://x/demo.tif', run, { fetchImpl: host(lay.file).fetchImpl, signal: ctl.signal }); } catch (e) { aborted = e.name; }
  assert.equal(aborted, 'AbortError');
});

await test('fetchRun parses the exact multipart bytes dev_server._send_multipart_ranges writes', async () => {
  // dev_server.py:7056-7058, byte for byte: each head starts with CRLF + "--boundary", the part data is followed
  // directly by the NEXT head's leading CRLF, and the tail is CRLF + "--boundary--" CRLF (no preamble CRLF-less form).
  const lay = layout(10, 4, (p, s) => Uint8Array.from({ length: 30 + s }, (_, i) => (p * 13 + s * 5 + i) & 255));
  const p = IJTiffStream.plan(indexOf({ pages: 10, strips: { perPage: 4, ...tables(lay.offsets, lay.counts) } }, lay));
  const run = IJTiffStream.runs(p, [0, 2, 5])[0];
  const fetchImpl = async (url, init) => {
    const spec = /bytes=(.*)/.exec(init.headers.Range)[1].split(',').map((x) => x.trim().split('-').map(Number));
    const boundary = 'f0e1d2c3b4a5968778695a4b3c2d1e0f';
    const parts = [];
    for (const [a, b] of spec) {
      parts.push(Buffer.from('\r\n--' + boundary + '\r\nContent-Type: application/octet-stream\r\nContent-Range: bytes ' + a + '-' + b + '/' + lay.file.length + '\r\n\r\n', 'latin1'), Buffer.from(lay.file.subarray(a, b + 1)));
    }
    parts.push(Buffer.from('\r\n--' + boundary + '--\r\n', 'latin1'));
    return new Response(Buffer.concat(parts), { status: 206, headers: { 'Content-Type': 'multipart/byteranges; boundary=' + boundary } });
  };
  IJTiffStream._refusedMulti.clear();
  const got = await IJTiffStream.fetchRun('http://dev/x.tif', run, { fetchImpl });
  for (const page of [0, 2, 5]) {
    const st = p.stripsOf(page);
    const want = Buffer.concat([0, 1, 2, 3].map((i) => Buffer.from(lay.file.subarray(st.offsets[i], st.offsets[i] + st.counts[i]))));
    assert.ok(sameBytes(got.get(page), Uint8Array.from(want)), `page ${page}`);
  }
});

await test('readPages: ≤ 2 requests in flight, every page once, request budget', async () => {
  const lay = layout(100, 4, (p, s) => new Uint8Array(40).fill((p + s) & 255));
  const p = IJTiffStream.plan(indexOf({ pages: 100, strips: { perPage: 4, ...tables(lay.offsets, lay.counts) } }, lay));
  const h = host(lay.file);
  const seen = [];
  const r = await IJTiffStream.readPages('http://x/demo.tif', p, Array.from({ length: 100 }, (_, i) => i), { fetchImpl: h.fetchImpl, onPage: (e, bytes) => { seen.push(e.page); assert.equal(bytes.length, 160); } });
  assert.equal(r.requests, Math.ceil(100 / 32));
  assert.equal(h.log.requests, r.requests);
  assert.ok(h.log.maxInFlight <= 2);
  assert.deepEqual(seen.sort((a, b) => a - b), Array.from({ length: 100 }, (_, i) => i));
  // a failure ends the others
  IJTiffStream._refusedMulti.clear();
  const bad = host(lay.file, 'ignore');
  assert.equal(await codeOf(() => IJTiffStream.readPages('http://x/demo.tif', p, [0, 1, 2], { fetchImpl: bad.fetchImpl })), 'IJ_LIB_TIFF_NO_RANGE');
});

function strips(width, rows, bps, spp, fill) { // fill(x, y, j) → sample value; native values, row-major chunky
  const n = width * rows * spp;
  const T = bps === 1 ? Uint8Array : bps === 2 ? Uint16Array : Float32Array;
  const a = new T(n);
  for (let y = 0; y < rows; y++) for (let x = 0; x < width; x++) for (let j = 0; j < spp; j++) a[(y * width + x) * spp + j] = fill(x, y, j);
  return a;
}
function encode(a, { le = true, predictor = 1, spp = 1, width, deflate = false }) {
  const bps = a.BYTES_PER_ELEMENT;
  let bits = a.constructor === Float32Array ? new Uint32Array(a.buffer.slice(0)) : a.slice();
  if (predictor === 2) {
    const rowLen = width * spp, rows = bits.length / rowLen, d = bits.slice();
    for (let y = 0; y < rows; y++) for (let x = rowLen - 1; x >= spp; x--) d[y * rowLen + x] = bits[y * rowLen + x] - bits[y * rowLen + x - spp];
    bits = d;
  }
  const bytes = new Uint8Array(bits.buffer.slice(0));
  if (!le && bps > 1) for (let i = 0; i < bytes.length; i += bps) bytes.subarray(i, i + bps).reverse();
  return deflate ? new Uint8Array(zlib.deflateSync(bytes)) : bytes;
}

await test('decodeStrip: 8 / 16 / 32-bit, byte orders, predictor 2, deflate, chunky RGB', async () => {
  const W = 9, R = 5;
  const cases = [];
  for (const bps of [1, 2, 4]) for (const le of [true, false]) for (const predictor of [1, 2]) for (const deflate of [false, true]) cases.push({ bps, le, predictor, deflate });
  for (const c of cases) {
    const fill = (x, y) => (c.bps === 4 ? (x * 1.5 - y * 0.25 + 3) : c.bps === 2 ? (x * 4001 + y * 97 + (y === 2 ? 60000 : 0)) % 65536 : (x * 37 + y * 11 + (y === 1 ? 240 : 0)) & 255);
    const a = strips(W, R, c.bps, 1, fill);
    const idx = indexOf({ pages: 1, width: W, height: R, rowsPerStrip: R, bitsPerSample: c.bps * 8, sampleFormat: c.bps === 4 ? 3 : 1, compression: c.deflate ? 8 : 1, predictor: c.predictor, littleEndian: c.le, strips: { perPage: 1, ...tables([8], [1]) } }, { file: new Uint8Array(9) });
    const p = IJTiffStream.plan(idx);
    const out = (await IJTiffStream.decodeStrip(p, encode(a, { le: c.le, predictor: c.predictor, width: W, deflate: c.deflate }), R))[0];
    assert.equal(out.constructor, c.bps === 4 ? Float32Array : c.bps === 2 ? Uint16Array : Uint8Array);
    assert.ok(sameBytes(new Uint8Array(out.buffer, out.byteOffset, out.byteLength), new Uint8Array(a.buffer)), JSON.stringify(c));
  }
  // chunky RGB, predictor per sample
  const rgb = strips(W, R, 1, 3, (x, y, j) => (x * (j + 2) + y * 5 + j * 60) & 255);
  const idx = indexOf({ pages: 1, width: W, height: R, rowsPerStrip: R, samplesPerPixel: 3, predictor: 2, photometric: 2, strips: { perPage: 1, ...tables([8], [1]) } }, { file: new Uint8Array(9) });
  const planes = await IJTiffStream.decodeStrip(IJTiffStream.plan(idx), encode(rgb, { predictor: 2, spp: 3, width: W }), R);
  assert.equal(planes.length, 3);
  for (let j = 0; j < 3; j++) for (let i = 0; i < W * R; i++) assert.equal(planes[j][i], rgb[i * 3 + j]);
  // a short strip is corrupt, an injected inflate is used
  const p8 = IJTiffStream.plan(indexOf({ pages: 1, width: W, height: R, rowsPerStrip: R, compression: 8, strips: { perPage: 1, ...tables([8], [1]) } }, { file: new Uint8Array(9) }));
  assert.equal(await codeOf(() => IJTiffStream.decodeStrip(p8, new Uint8Array(zlib.deflateSync(new Uint8Array(10))), R)), 'IJ_LIB_TIFF_CORRUPT');
  const fake = await IJTiffStream.decodeStrip(p8, new Uint8Array(1), R, { inflate: async () => new Uint8Array(W * R).fill(9) });
  assert.equal(fake[0][0], 9);
});

await test('decodePage: strips of a page back to back, partial last strip, a band', async () => {
  const W = 8, H = 7, RPS = 3;      // strips of 3, 3 and 1 rows
  const full = strips(W, H, 2, 1, (x, y) => x * 300 + y * 7);
  const parts = [0, 1, 2].map((s) => encode(full.subarray(s * RPS * W, Math.min(H, (s + 1) * RPS) * W), { predictor: 2, width: W, deflate: true }));
  const lay = layout(1, 3, (_p, s) => parts[s]);
  const idx = indexOf({ pages: 1, width: W, height: H, rowsPerStrip: RPS, bitsPerSample: 16, compression: 8, predictor: 2, strips: { perPage: 3, ...tables(lay.offsets, lay.counts) } }, lay);
  const p = IJTiffStream.plan(idx);
  const h = host(lay.file);
  const got = await IJTiffStream.fetchRun('http://x/t.tif', IJTiffStream.runs(p, [0])[0], { fetchImpl: h.fetchImpl });
  const page = (await IJTiffStream.decodePage(p, 0, got.get(0)))[0];
  assert.deepEqual(Array.from(page), Array.from(full));
  const band = IJTiffStream.runs(p, [{ page: 0, s0: 1, s1: 3 }])[0];
  const gb = await IJTiffStream.fetchRun('http://x/t.tif', band, { fetchImpl: h.fetchImpl });
  const decoded = (await IJTiffStream.decodePage(p, { page: 0, s0: 1, s1: 3 }, gb.get('0:1')))[0];
  assert.deepEqual(Array.from(decoded), Array.from(full.subarray(RPS * W)));
});

// ---- a real bundle TIFF of the local DATA_WEB (E8-1: 300 pages, deflate, 2048²) -----------------------
await test('a real bundle TIFF (when the local DATA_WEB holds one)', async () => {
  const dir = path.join(ROOT, 'DATA_WEB', '3d', 'Egfl7eGFP-E8-1-DAPI-Egfl7-Pecam1-10x-stack', 'download');
  const name = 'Egfl7eGFP-E8-1-DAPI-Egfl7-Pecam1-10x-stack.tif';
  const file = path.join(dir, name);
  if (!existsSync(file)) { console.log('SKIP real TIFF: DATA_WEB has no E8-1 bundle'); return; }
  const py = ['python', 'python3', 'py'].find((c) => spawnSync(c, ['-c', 'print(1)']).stdout?.toString().trim() === '1');
  if (!py) { console.log('SKIP real TIFF: no python to build the index'); return; }
  const code = `import sys, json; sys.path.insert(0, ${JSON.stringify(ROOT)}); import dev_server as d; print(d._tiff_json(d._tiff_index(${JSON.stringify(file)}, '3d/x', ${JSON.stringify(name)})))`;
  const run = spawnSync(py, ['-c', code], { maxBuffer: 1 << 28 });
  if (run.status !== 0) { console.log('SKIP real TIFF: the index could not be built'); return; }
  const index = JSON.parse(run.stdout.toString('utf8'));
  const p = IJTiffStream.plan(index);
  assert.deepEqual([p.width, p.height, p.bitDepth, p.channels, p.slices, p.pages], [2048, 2048, 8, 3, 100, 300]);
  assert.equal(p.labels.join(','), 'DAPI,GFP,Pecam1');
  assert.ok(Math.abs(p.pixelUm.x - 0.4612) < 1e-3 && Math.abs(p.spacingUm - 3.5294) < 1e-3);
  IJTiffStream._refusedMulti.clear();
  const fd = openSync(file, 'r');
  const size = statSync(file).size;
  const fetchImpl = async (url, init) => {
    const spec = /bytes=(.*)/.exec(init.headers.Range)[1].split(',').map((s) => s.trim().split('-').map(Number));
    const chunks = [], boundary = 'B';
    for (const [a, b] of spec) { const buf = Buffer.alloc(b - a + 1); readSync(fd, buf, 0, buf.length, a); chunks.push(Buffer.from(`--${boundary}\r\nContent-Range: bytes ${a}-${b}/${size}\r\n\r\n`, 'latin1'), buf, Buffer.from('\r\n')); }
    chunks.push(Buffer.from(`--${boundary}--\r\n`));
    return new Response(Buffer.concat(chunks), { status: 206, headers: { 'Content-Type': `multipart/byteranges; boundary=${boundary}` } });
  };
  try {
    const pages = [IJTiffStream.pageOf(p, { z: 50, c: 0, t: 0 }), IJTiffStream.pageOf(p, { z: 50, c: 1, t: 0 }), IJTiffStream.pageOf(p, { z: 51, c: 2, t: 0 })];
    const got = new Map();
    const r = await IJTiffStream.readPages('file://x', p, pages, { fetchImpl, onPage: async (e, bytes) => { got.set(e.page, (await IJTiffStream.decodePage(p, e, bytes))[0]); } });
    assert.equal(r.requests, 1);
    for (const pg of pages) {
      const img = got.get(pg);
      assert.equal(img.length, 2048 * 2048);
      let max = 0, nz = 0;
      for (let i = 0; i < img.length; i += 17) { if (img[i] > max) max = img[i]; if (img[i]) nz++; }
      assert.ok(max > 0 && nz > 100, `page ${pg} holds signal`);
    }
  } finally { closeSync(fd); }
});

await test('a dropped connection and a damaged deflate strip carry their own codes (never an internal failure); an over-long inflate is truncated', async () => {
  const lay = layout(2, 4, () => new Uint8Array(16).fill(1));
  const p = IJTiffStream.plan(indexOf({ pages: 2 }, lay));
  assert.equal(await codeOf(() => IJTiffStream.inflate(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]))), 'IJ_LIB_TIFF_CORRUPT');
  const zlib = await import('node:zlib');
  const z = new Uint8Array(zlib.deflateSync(Buffer.alloc(4096, 7)));
  assert.equal((await IJTiffStream.inflate(z, 4096)).length, 4096);
  const cut = await IJTiffStream.inflate(z, 100);
  assert.equal(cut.length, 100);
  assert.ok(cut.every((v) => v === 7));
  const offline = async () => { throw new TypeError('Failed to fetch'); };
  assert.equal(await codeOf(() => IJTiffStream.readPages('file://x', p, [0], { fetchImpl: offline })), 'IJ_LIB_TIFF_HTTP');
  const aborted = async () => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }); };
  let name = null;
  try { await IJTiffStream.readPages('file://x', p, [0], { fetchImpl: aborted }); } catch (e) { name = e.name; }
  assert.equal(name, 'AbortError');
});

console.log(`test_ij_lib_tiff: ${passed} groups passed`);
