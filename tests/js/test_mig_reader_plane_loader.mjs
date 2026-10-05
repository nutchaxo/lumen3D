// PlaneLoader (js/core/plane-loader.js) reads a format-2 planes/ tree exactly
// (DOCS/dataset-migrations/SPEC.md §3, §8): a synthetic tree written with the shared
// PlaneCodec (encodePngGray + buildPackHeader), served by a mocked fetch that honours
// Range (206 + Content-Range) — or ignores it (200, the whole pack) — and decoded by
// the REAL plane-decode-worker.js, run in a vm context behind a Worker stand-in that
// speaks its postMessage protocol. Covered:
//   • manifest validation (schema, codec, level, LOD0 dimensions, channels, tile grid,
//     headerBytes formula, bricks-manifest sha256) and the ?v= stamp on pack URLs;
//   • loadRegion = the volume, voxel for voxel: whole plane, tile-edge rects (one
//     pixel each side of a 512 seam, the ragged last tile), one channel or several;
//   • an empty tile (length 0) reads as zeros and is never fetched;
//   • only the tiles a rect needs are fetched, as merged byte runs; estimate() =
//     the bytes actually fetched;
//   • compose (LUT, component slots, stride 4) and loadRegionMax (per-channel max
//     over planes, LUT after the max);
//   • a server answering 200 to a Range request (whole pack) gives the same pixels;
//   • abort before and during a load rejects with AbortError;
//   • the JS SHA-256 fallback equals node's.
//
// Run: node tests/js/test_mig_reader_plane_loader.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash, webcrypto } from 'node:crypto';
import path from 'node:path';
import vm from 'node:vm';
import { loadModule, ROOT } from './harness.mjs';

export const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');
const streams = { Blob, CompressionStream, DecompressionStream, Response, TextEncoder, TextDecoder };
export const PlaneCodec = loadModule('js/core/plane-codec.js', 'PlaneCodec', { ...streams });
assert.ok(PlaneCodec?.encodePngGray && PlaneCodec?.buildPackHeader, 'PlaneCodec loads');

/** A Worker running js/workers/plane-decode-worker.js in its own vm context. */
export class VmWorker {
  constructor(url) {
    this.url = url;
    this.onmessage = null;
    this.onerror = null;
    this.terminated = false;
    const ctx = vm.createContext({ console, setTimeout, clearTimeout, ...streams, location: { search: '' } });
    ctx.self = ctx;
    ctx.importScripts = (rel) => {
      assert.match(rel, /^\.\.\/core\/plane-codec\.js(\?v=[^&]+)?$/, 'the worker imports the shared codec');
      vm.runInContext(read('js/core/plane-codec.js'), ctx, { filename: 'plane-codec.js' });
    };
    ctx.postMessage = (msg) => {
      if (this.terminated) return;
      setTimeout(() => this.onmessage && this.onmessage({ data: msg }), 0);
    };
    vm.runInContext(read('js/workers/plane-decode-worker.js'), ctx, { filename: 'plane-decode-worker.js' });
    this.ctx = ctx;
    VmWorker.spawned++;
  }
  postMessage(msg) {
    if (this.terminated) return;
    setTimeout(() => this.ctx.onmessage({ data: msg }), 0);
  }
  terminate() { this.terminated = true; }
}
VmWorker.spawned = 0;

/**
 * A planes tree in memory: { files: Map(url → Uint8Array), manifestText, bricksManifest }.
 * voxel(x, y, z, c) → uint8; tiles entirely 0 get length 0 (as every writer does).
 */
export async function buildTree({ base, dims, channels, tileSize = 512, voxel, bricksManifest }) {
  const TX = Math.ceil(dims.x / tileSize), TY = Math.ceil(dims.y / tileSize);
  const files = new Map();
  const headerBytes = PlaneCodec.headerBytes(channels, TX, TY);
  for (let z = 0; z < dims.z; z++) {
    const entries = [];
    const payloads = [];
    let offset = headerBytes;
    for (let c = 0; c < channels; c++) {
      for (let ty = 0; ty < TY; ty++) {
        for (let tx = 0; tx < TX; tx++) {
          const w = Math.min(tileSize, dims.x - tx * tileSize), h = Math.min(tileSize, dims.y - ty * tileSize);
          const data = new Uint8Array(w * h);
          let any = false;
          for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
            const v = voxel(tx * tileSize + x, ty * tileSize + y, z, c);
            data[y * w + x] = v;
            if (v) any = true;
          }
          if (!any) { entries.push({ offset: 0, length: 0 }); continue; }
          const png = await PlaneCodec.encodePngGray(w, h, data);
          entries.push({ offset, length: png.length });
          payloads.push(png);
          offset += png.length;
        }
      }
    }
    const header = PlaneCodec.buildPackHeader({ channels, tilesX: TX, tilesY: TY, z, entries });
    const pack = new Uint8Array(offset);
    pack.set(header, 0);
    let o = headerBytes;
    for (const p of payloads) { pack.set(p, o); o += p.length; }
    files.set(`${base}/z${String(z).padStart(5, '0')}.bin`, pack);
  }
  const bricksBytes = new TextEncoder().encode(bricksManifest);
  const manifest = {
    schema: 'lumen-planes-v1', formatVersion: 2, level: 0,
    dimensions: { x: dims.x, y: dims.y, z: dims.z }, channels, tileSize,
    tiles: { x: TX, y: TY }, codec: 'png-gray8', packPattern: 'z{z}.bin', headerBytes,
    source: { manifestSha256: createHash('sha256').update(bricksBytes).digest('hex') },
    producer: 'migration-browser', createdAt: '2026-10-05T00:00:00Z'
  };
  const manifestText = JSON.stringify(manifest);
  files.set(`${base}/manifest.json`, new TextEncoder().encode(manifestText));
  return { files, manifest, manifestText, bricksBytes };
}

/**
 * fetch over `files`: Range → 206 (+ Content-Range) unless `ignoreRange`. Every
 * request is logged { url, range, bytes }. `delay` ms per answer; honours signal.
 */
export function mockFetch(files, opts = {}) {
  const log = [];
  const fn = async (url, init = {}) => {
    const signal = init.signal;
    const abortErr = () => new DOMException('aborted', 'AbortError');
    if (signal?.aborted) throw abortErr();
    if (opts.delay) {
      await new Promise((resolve, reject) => {
        const t = setTimeout(resolve, opts.delay);
        signal?.addEventListener?.('abort', () => { clearTimeout(t); reject(abortErr()); }, { once: true });
      });
    }
    const [pathPart, query = ''] = String(url).split('?');
    const body = files.get(pathPart);
    const range = init.headers?.Range || null;
    const entry = { url: String(url), path: pathPart, query, range, bytes: 0, cache: init.cache };
    log.push(entry);
    if (!body) return new Response('not found', { status: 404 });
    const m = range && !opts.ignoreRange ? /^bytes=(\d+)-(\d+)$/.exec(range) : null;
    if (m) {
      const a = Number(m[1]), b = Math.min(Number(m[2]), body.length - 1);
      const slice = body.slice(a, b + 1);
      entry.bytes = slice.length;
      return new Response(slice, { status: 206, headers: { 'Content-Range': `bytes ${a}-${b}/${body.length}` } });
    }
    entry.bytes = body.length;
    return new Response(body.slice(), { status: 200 });
  };
  fn.log = log;
  return fn;
}

export function loadPlaneLoader(fetchImpl, extra = {}) {
  return loadModule('js/core/plane-loader.js', 'PlaneLoader', {
    fetch: fetchImpl, Worker: VmWorker, PlaneCodec, Response, DOMException, crypto: webcrypto,
    navigator: { hardwareConcurrency: 4 }, Promise, ...extra
  });
}

// Imported for its fixtures by the Studio test: run only when executed directly.
if (String(process.argv[1] || '').endsWith('test_mig_reader_plane_loader.mjs')) await main();

async function main() {
  // ── The synthetic tree: 1100 × 700 × 3, three channels, 512-px tiles (3 × 2) ──
  const DIMS = { x: 1100, y: 700, z: 3 };
  const C = 3;
  const voxel = (x, y, z, c) => {
    // Channel 1 is black over tile (tx 2, ty 1) of every plane: an empty tile.
    if (c === 1 && x >= 1024 && y >= 512) return 0;
    return ((x * 73856093) ^ (y * 19349663) ^ (z * 83492791) ^ (c * 2654435761)) >>> 0 & 255;
  };
  const BASE = 'DATA_WEB/3d/demo/planes';
  const BRICKS = 'DATA_WEB/3d/demo/bricks/manifest.json';
  const tree0 = await buildTree({ base: BASE, dims: DIMS, channels: C, voxel, bricksManifest: '{"schema":"iribhm-bricks-v2","levels":[]}' });
  tree0.files.set(BRICKS, tree0.bricksBytes);

  const expectRegion = (z, c, r) => {
    const w = r.x1 - r.x0, h = r.y1 - r.y0;
    const out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[y * w + x] = voxel(r.x0 + x, r.y0 + y, z, c);
    return out;
  };
  const sameBytes = (a, b, label) => {
    assert.equal(a.length, b.length, `${label}: length`);
    let diff = 0;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diff++;
    assert.equal(diff, 0, `${label}: ${diff} bytes differ`);
  };
  const openArgs = { dimensions: { x: DIMS.x, y: DIMS.y, z: DIMS.z }, channels: C, sourceManifestUrl: BRICKS };

  // ── SHA-256 fallback ────────────────────────────────────────────────────────
  {
    const L = loadPlaneLoader(mockFetch(new Map()));
    for (const n of [0, 1, 55, 56, 63, 64, 65, 119, 1000, 100003]) {
      const buf = new Uint8Array(n);
      for (let i = 0; i < n; i++) buf[i] = (i * 131 + 7) & 255;
      assert.equal(L._sha256Js(buf), createHash('sha256').update(buf).digest('hex'), `JS SHA-256, ${n} bytes`);
    }
    console.log('JS SHA-256 fallback = node crypto: OK');
  }

  // ── Manifest validation ────────────────────────────────────────────────────
  {
    const fetchOk = mockFetch(tree0.files);
    const L = loadPlaneLoader(fetchOk);
    const tree = await L.open(BASE, openArgs);
    assert.equal(tree.headerBytes, 16 + 12 * C * 2 * 3);
    assert.equal(fetchOk.log[0].cache, 'no-cache', 'the planes manifest is revalidated');
    assert.equal(fetchOk.log[1].cache, 'force-cache', 'the bricks manifest is the cached copy the viewer read');
    const bad = async (mutate, code, label, args = openArgs) => {
      const m = JSON.parse(tree0.manifestText);
      mutate(m);
      const files = new Map(tree0.files);
      files.set(`${BASE}/manifest.json`, new TextEncoder().encode(JSON.stringify(m)));
      await assert.rejects(loadPlaneLoader(mockFetch(files)).open(BASE, args), (e) => e.code === code, label);
    };
    await bad(m => { m.schema = 'lumen-planes-v0'; }, 'PLANES_INVALID', 'schema');
    await bad(m => { m.codec = 'webp'; }, 'PLANES_INVALID', 'codec');
    await bad(m => { m.level = 1; }, 'PLANES_INVALID', 'level');
    await bad(m => { m.headerBytes += 12; }, 'PLANES_INVALID', 'headerBytes formula');
    await bad(m => { m.tiles.x = 2; }, 'PLANES_INVALID', 'tile grid');
    await bad(m => { m.packPattern = 'p{z}.bin'; }, 'PLANES_INVALID', 'pack pattern');
    await bad(() => {}, 'PLANES_INVALID', 'dimensions ≠ the bricks LOD0', { ...openArgs, dimensions: { x: 1100, y: 700, z: 4 } });
    await bad(() => {}, 'PLANES_INVALID', 'channels ≠ the bricks', { ...openArgs, channels: 4 });
    await bad(m => { m.source.manifestSha256 = 'f'.repeat(64); }, 'PLANES_STALE', 'cut from another bricks manifest');
    const missing = new Map(tree0.files);
    missing.delete(`${BASE}/manifest.json`);
    await assert.rejects(loadPlaneLoader(mockFetch(missing)).open(BASE, openArgs), (e) => e.code === 'PLANES_HTTP', 'no planes/');
    console.log('planes manifest validation (schema, codec, level, dims, channels, grid, headerBytes, sha256): OK');
  }

  // ── Regions, exact ─────────────────────────────────────────────────────────
  {
    const f = mockFetch(tree0.files);
    const L = loadPlaneLoader(f);
    const tree = await L.open(BASE, openArgs);
    const rects = [
      { x0: 0, y0: 0, x1: DIMS.x, y1: DIMS.y },
      { x0: 511, y0: 511, x1: 513, y1: 513 },        // one pixel each side of both seams
      { x0: 1023, y0: 0, x1: 1100, y1: 700 },        // the ragged last column of tiles
      { x0: 1099, y0: 699, x1: 1100, y1: 700 },      // the last voxel
      { x0: 300, y0: 100, x1: 900, y1: 650 },
      { x0: 0, y0: 512, x1: 512, y1: 700 }           // exactly one tile
    ];
    for (const r of rects) {
      for (const chans of [[0, 1, 2], [1], [2, 0]]) {
        for (const z of [0, 2]) {
          const got = await tree.loadRegion(z, chans, r);
          assert.equal(got.width, r.x1 - r.x0);
          assert.equal(got.height, r.y1 - r.y0);
          chans.forEach((c, i) => sameBytes(got.data[i], expectRegion(z, c, r), `z${z} c${c} ${JSON.stringify(r)}`));
        }
      }
    }
    // Every pack URL carries the manifest's stamp.
    const packs = f.log.filter(e => e.path.endsWith('.bin'));
    const stamp = L._fnv1a(tree0.manifestText);
    assert.ok(packs.length && packs.every(e => e.query === `v=${stamp}`), 'packs are fetched with ?v=<fnv1a of the planes manifest>');
    assert.ok(packs.every(e => e.range), 'every pack read is a Range request');
    console.log('loadRegion = the volume (whole plane, tile seams, ragged edge, channel subsets): OK');
  }

  // ── Only the needed tiles; empty tiles never fetched; estimate = fetched ─────
  {
    const f = mockFetch(tree0.files);
    const L = loadPlaneLoader(f);
    const tree = await L.open(BASE, openArgs);
    await tree.header(1);
    const before = f.log.length;
    // Channel 1, tile (tx 2, ty 1) alone: the empty tile — nothing to fetch.
    const r = { x0: 1030, y0: 520, x1: 1090, y1: 690 };
    const est = await tree.estimate([1], [1], r);
    assert.deepEqual({ bytes: est.bytes, tiles: est.tiles, exact: est.exact }, { bytes: 0, tiles: 0, exact: true });
    const got = await tree.loadRegion(1, [1], r);
    assert.equal(f.log.length, before, 'an empty tile costs no request');
    assert.ok(got.data[0].every(v => v === 0), 'an empty tile reads as zeros');
    // One tile of channel 2: exactly its bytes.
    const pack = tree0.files.get(`${BASE}/z00001.bin`);
    const h = PlaneCodec.parsePackHeader(pack.subarray(0, tree.headerBytes));
    const one = h.entries[PlaneCodec.tileIndex(2, 0, 1, 3, 2)];
    const r2 = { x0: 600, y0: 10, x1: 700, y1: 20 };
    const est2 = await tree.estimate([1], [2], r2);
    assert.equal(est2.bytes, one.length, 'estimate: the one tile');
    const mark = f.log.length;
    await tree.loadRegion(1, [2], r2);
    const fetched = f.log.slice(mark);
    assert.equal(fetched.length, 1);
    assert.equal(fetched[0].range, `bytes=${one.offset}-${one.offset + one.length - 1}`);
    // A whole plane of three channels: estimate = what the runs fetched.
    const whole = { x0: 0, y0: 0, x1: DIMS.x, y1: DIMS.y };
    const est3 = await tree.estimate([1], [0, 1, 2], whole);
    const mark3 = f.log.length;
    await tree.loadRegion(1, [0, 1, 2], whole);
    const sum = f.log.slice(mark3).reduce((s, e) => s + e.bytes, 0);
    assert.equal(sum, est3.bytes, 'estimate = bytes fetched');
    assert.ok(f.log.slice(mark3).length <= 2, 'adjacent tiles merge into few runs');
    console.log('only the needed tiles, merged runs, empty tiles free, estimate exact: OK');
  }

  // ── Compose and MIP ─────────────────────────────────────────────────────────
  {
    const L = loadPlaneLoader(mockFetch(tree0.files));
    const tree = await L.open(BASE, openArgs);
    const lut = new Uint8Array(256);
    const floor = 9;
    for (let i = 0; i < 256; i++) lut[i] = i <= floor ? 0 : Math.min(255, Math.round((i - floor) * 255 / (255 - floor)));
    const r = { x0: 400, y0: 300, x1: 1100, y1: 700 };
    const W = r.x1 - r.x0, H = r.y1 - r.y0;
    const chans = [0, 2];
    const compose = { components: 4, slots: chans, luts: [lut, null] };
    const got = await tree.loadRegion(1, chans, r, { compose });
    const exp = new Uint8Array(W * H * 4);
    for (let i = 0; i < W * H; i++) {
      const x = r.x0 + (i % W), y = r.y0 + Math.floor(i / W);
      exp[i * 4] = lut[voxel(x, y, 1, 0)];
      exp[i * 4 + 2] = voxel(x, y, 1, 2);
    }
    sameBytes(got.rgba, exp, 'compose (LUT on slot 0, raw on slot 2, slots 1 and 3 zero)');
    // Bands: delivered as they decode, covering the rect once, in order.
    const seen = [];
    const banded = await tree.loadRegion(1, chans, r, { compose, bands: true, onBand: (b) => seen.push(b.y0) });
    assert.equal(banded.bands.length, seen.length);
    let y = r.y0;
    for (const b of banded.bands) { assert.equal(b.y0, y); y += b.height; }
    assert.equal(y, r.y1, 'the bands tile the rect');
    // MIP over the three planes: max of the stored values, then the LUT.
    const mip = await tree.loadRegionMax([2, 0, 1], chans, r, { compose, concurrency: 2 });
    const expMip = new Uint8Array(W * H * 4);
    for (let i = 0; i < W * H; i++) {
      const x = r.x0 + (i % W), yy = r.y0 + Math.floor(i / W);
      let m0 = 0, m2 = 0;
      for (let z = 0; z < 3; z++) { m0 = Math.max(m0, lut[voxel(x, yy, z, 0)]); m2 = Math.max(m2, voxel(x, yy, z, 2)); }
      expMip[i * 4] = m0;
      expMip[i * 4 + 2] = m2;
    }
    sameBytes(mip.rgba, expMip, 'loadRegionMax = per-channel max of lut(v)');
    const raw = await tree.loadRegionMax([0, 1, 2], [1], { x0: 0, y0: 0, x1: DIMS.x, y1: DIMS.y });
    const expRaw = new Uint8Array(DIMS.x * DIMS.y);
    for (let yy = 0; yy < DIMS.y; yy++) for (let x = 0; x < DIMS.x; x++) {
      expRaw[yy * DIMS.x + x] = Math.max(voxel(x, yy, 0, 1), voxel(x, yy, 1, 1), voxel(x, yy, 2, 1));
    }
    sameBytes(raw.data[0], expRaw, 'loadRegionMax, per-channel planes (an empty tile in every plane)');
    console.log('compose (LUT, slots, bands) and loadRegionMax (MIP, LUT after the max): OK');
  }

  // ── A server without ranges ─────────────────────────────────────────────────
  {
    const f = mockFetch(tree0.files, { ignoreRange: true });
    const L = loadPlaneLoader(f);
    const tree = await L.open(BASE, openArgs);
    const r = { x0: 500, y0: 500, x1: 1100, y1: 700 };
    const got = await tree.loadRegion(2, [0, 1, 2], r);
    [0, 1, 2].forEach((c, i) => sameBytes(got.data[i], expectRegion(2, c, r), `200 answer, c${c}`));
    assert.equal(tree.isRangeless(), true, 'the tree stops asking for ranges');
    const packReqs = f.log.filter(e => e.path.endsWith('z00002.bin'));
    assert.equal(packReqs.length, 1, 'the whole pack served the header and the tiles');
    const mip = await tree.loadRegionMax([0, 1], [2], r);
    const exp = new Uint8Array((r.x1 - r.x0) * (r.y1 - r.y0));
    for (let i = 0; i < exp.length; i++) {
      const x = r.x0 + (i % (r.x1 - r.x0)), y = r.y0 + Math.floor(i / (r.x1 - r.x0));
      exp[i] = Math.max(voxel(x, y, 0, 2), voxel(x, y, 1, 2));
    }
    sameBytes(mip.data[0], exp, '200 answers, MIP');
    console.log('a 200 answer to a Range request (whole pack) gives the same pixels: OK');
  }

  // ── Abort ────────────────────────────────────────────────────────────────────
  {
    const L = loadPlaneLoader(mockFetch(tree0.files, { delay: 20 }));
    const tree = await L.open(BASE, openArgs);
    const pre = new AbortController();
    pre.abort();
    await assert.rejects(tree.loadRegion(0, [0], { x0: 0, y0: 0, x1: 10, y1: 10 }, { signal: pre.signal }), (e) => e.name === 'AbortError', 'aborted before');
    const mid = new AbortController();
    const p = tree.loadRegionMax([0, 1, 2], [0, 1, 2], { x0: 0, y0: 0, x1: DIMS.x, y1: DIMS.y }, { signal: mid.signal });
    setTimeout(() => mid.abort(), 30);
    await assert.rejects(p, (e) => e.name === 'AbortError', 'aborted during');
    // The tree still works afterwards.
    const ok = await tree.loadRegion(0, [0], { x0: 0, y0: 0, x1: 64, y1: 64 });
    sameBytes(ok.data[0], expectRegion(0, 0, { x0: 0, y0: 0, x1: 64, y1: 64 }), 'after an abort');
    console.log('abort before / during a load → AbortError, tree still usable: OK');
  }

  // ── A corrupt tile fails the load (the viewer then reads the bricks) ─────────
  {
    const files = new Map(tree0.files);
    const pack = files.get(`${BASE}/z00000.bin`).slice();
    const h = PlaneCodec.parsePackHeader(pack.subarray(0, 16 + 12 * C * 6));
    const e = h.entries[0];
    pack[e.offset + e.length - 6] ^= 0xFF;   // inside the IEND CRC / last IDAT bytes
    files.set(`${BASE}/z00000.bin`, pack);
    const tree = await loadPlaneLoader(mockFetch(files)).open(BASE, openArgs);
    await assert.rejects(tree.loadRegion(0, [0], { x0: 0, y0: 0, x1: 100, y1: 100 }), (err) => err.code === 'PLANES_DECODE', 'a corrupt tile is an error, never pixels');
    console.log('a corrupt tile rejects the load: OK');
  }

  // ── A decode worker dies: the pool is respawned and every band the old pool still
  //    owed rejects (it used to hang the caller forever) ────────────────────────
  {
    const made = [];
    class HoldWorker extends VmWorker {
      constructor(url) { super(url); this.hold = false; made.push(this); }
      postMessage(msg) { if (!this.hold) super.postMessage(msg); }
    }
    const tree = await loadPlaneLoader(mockFetch(tree0.files), { Worker: HoldWorker }).open(BASE, openArgs);
    await tree.loadRegion(0, [0], { x0: 0, y0: 0, x1: 10, y1: 10 });   // spawns the pool
    const pool = made.slice();
    assert.ok(pool.length >= 2);
    pool[1].hold = true;   // this worker will never answer its band
    const owed = tree.loadRegion(1, [0], { x0: 0, y0: 0, x1: DIMS.x, y1: DIMS.y });
    const outcome = owed.then(() => 'resolved', (e) => e.code);
    await new Promise((r) => setTimeout(r, 50));
    pool[0].onerror({ message: 'crash' });   // another worker of the pool dies
    const next = await tree.loadRegion(2, [0], { x0: 0, y0: 0, x1: 64, y1: 64 });
    sameBytes(next.data[0], expectRegion(2, 0, { x0: 0, y0: 0, x1: 64, y1: 64 }), 'the respawned pool decodes');
    assert.equal(await outcome, 'PLANES_DECODE', 'the band owed by the old pool rejects');
    console.log('a dead decode worker never leaves a load pending: OK');
  }

  console.log('PlaneLoader: OK');
}
