// Fixtures for the v3 brick-tree reader tests (DOCS/dataset-migrations/SPEC.md §13):
// a synthetic v3 tree written exactly as §13.2–13.4 lay it out (66³ bricks with a
// clamp-to-edge border, 9 × 8 mosaics of 66² slices, packs per level and channel,
// binary index.bin, compact manifest), a mocked fetch that speaks single and
// multi-range HTTP, and the REAL brick-decode-worker.js running in a vm context.
//
// Node cannot encode WebP, so a brick image is a minimal stand-in ("FAKE", u16 width,
// u16 height, grey bytes) and the worker's createImageBitmap / OffscreenCanvas are
// stubbed to decode it: everything after the picture decode — mosaic un-tiling,
// regions, LUTs, channel assembly — is the worker's own code.
import { readFileSync } from 'node:fs';
import { createHash, webcrypto } from 'node:crypto';
import path from 'node:path';
import vm from 'node:vm';
import { loadModule, ROOT } from './harness.mjs';

export const STRIDE = 66;
export const COLS = 9;
export const ROWS = 8;
const enc = new TextEncoder();

/** The stand-in picture format: "FAKE", u16 w, u16 h (LE), w·h grey bytes. */
export function fakeImage(w, h, gray) {
  const out = new Uint8Array(8 + w * h);
  out.set(enc.encode('FAKE'), 0);
  new DataView(out.buffer).setUint16(4, w, true);
  new DataView(out.buffer).setUint16(6, h, true);
  out.set(gray, 8);
  return out;
}

/** A 66³ brick (z-major, then y, then x) as its 594 × 528 mosaic picture. */
export function mosaicOf(brick) {
  const W = COLS * STRIDE, H = ROWS * STRIDE;
  const gray = new Uint8Array(W * H);
  for (let s = 0; s < STRIDE; s++) {
    const px0 = (s % COLS) * STRIDE, py0 = Math.floor(s / COLS) * STRIDE;
    for (let y = 0; y < STRIDE; y++) {
      for (let x = 0; x < STRIDE; x++) gray[(py0 + y) * W + px0 + x] = brick[(s * STRIDE + y) * STRIDE + x];
    }
  }
  return fakeImage(W, H, gray);
}

function stubImageApi() {
  return {
    createImageBitmap: async (blob) => {
      const u8 = new Uint8Array(await blob.arrayBuffer());
      if (String.fromCharCode(...u8.subarray(0, 4)) !== 'FAKE') throw new Error('not an image');
      const dv = new DataView(u8.buffer, u8.byteOffset);
      const width = dv.getUint16(4, true), height = dv.getUint16(6, true);
      if (u8.length !== 8 + width * height) throw new Error('truncated image');
      return { width, height, gray: u8.subarray(8), close() {} };
    },
    OffscreenCanvas: function (w, h) {
      this.width = w; this.height = h;
      let img = null;
      this.getContext = () => ({
        globalCompositeOperation: '',
        drawImage(bmp) { img = bmp; },
        getImageData(x0, y0, w2, h2) {
          const data = new Uint8ClampedArray(w2 * h2 * 4);
          for (let y = 0; y < h2; y++) {
            for (let x = 0; x < w2; x++) {
              const ix = x0 + x, iy = y0 + y;
              const v = img && ix < img.width && iy < img.height ? img.gray[iy * img.width + ix] : 0;
              const o = (y * w2 + x) * 4;
              data[o] = v; data[o + 1] = v; data[o + 2] = v; data[o + 3] = 255;
            }
          }
          return { data };
        }
      });
    }
  };
}

const WORKER_SRC = readFileSync(path.join(ROOT, 'js/core/brick-decode-worker.js'), 'utf8');

/** A Worker running js/core/brick-decode-worker.js in its own vm context. */
export class VmBrickWorker {
  constructor() {
    this.onmessage = null;
    this.onerror = null;
    this.terminated = false;
    const ctx = vm.createContext({ console, setTimeout, clearTimeout, Blob, performance: { now: () => Date.now() }, ...stubImageApi() });
    ctx.self = ctx;
    ctx.postMessage = (msg) => {
      if (this.terminated) return;
      setTimeout(() => this.onmessage && this.onmessage({ data: msg }), 0);
    };
    vm.runInContext(WORKER_SRC, ctx, { filename: 'brick-decode-worker.js' });
    this.ctx = ctx;
  }
  postMessage(msg) {
    if (this.terminated) return;
    setTimeout(() => this.ctx.onmessage({ data: msg }), 0);
  }
  terminate() { this.terminated = true; }
}

/** Direct access to the worker's message loop (un-mosaic tests). */
export function rawWorker() {
  const results = [];
  const ctx = vm.createContext({ console, setTimeout, clearTimeout, Blob, performance: { now: () => 0 }, ...stubImageApi() });
  ctx.self = ctx;
  ctx.postMessage = (m) => results.push(m);
  vm.runInContext(WORKER_SRC, ctx, { filename: 'brick-decode-worker.js' });
  return { send: (m) => ctx.onmessage({ data: m }), results };
}

const sha256 = (u8) => createHash('sha256').update(u8).digest('hex');
const ceil64 = (n) => Math.ceil(n / 64);

/**
 * A v3 tree in memory under `base`. `levels` = [{ dims, voxelSize }]; `value(k, c, x,
 * y, z)` the voxel of level k (0 = absent). A brick is stored iff its interior holds a
 * non-zero voxel (SPEC §13.1 ESS); its 66³ border is clamp-to-edge. Packs hold at most
 * `perPack` bricks. Returns { files: Map(path → Uint8Array), manifest, manifestText,
 * stored(k, c, bx, by, bz) → Uint8Array 66³ | null, packs: Map }.
 */
export function buildV3Tree({ base, channels, levels, value, perPack = 3 }) {
  const files = new Map();
  const storedMap = new Map();
  const entries = [];      // per level, per channel: [{pack, offset, length}] in (bz, by, bx)
  const packCounts = [];
  levels.forEach((lv, k) => {
    const { x: X, y: Y, z: Z } = lv.dims;
    const gx = ceil64(X), gy = ceil64(Y), gz = ceil64(Z);
    const clamp = (v, n) => Math.max(0, Math.min(n - 1, v));
    let packCount = 0;
    const perChannel = [];
    for (let c = 0; c < channels; c++) {
      const list = [];
      let pack = -1, inPack = perPack, offset = 0, packBytes = [];
      const flush = () => {
        if (pack < 0) return;
        const total = packBytes.reduce((s, b) => s + b.length, 0);
        const out = new Uint8Array(total);
        let o = 0;
        for (const b of packBytes) { out.set(b, o); o += b.length; }
        files.set(`${base}/l${k}/c${c}/p${String(pack).padStart(5, '0')}.bin`, out);
      };
      for (let bz = 0; bz < gz; bz++) for (let by = 0; by < gy; by++) for (let bx = 0; bx < gx; bx++) {
        let any = false;
        for (let z = bz * 64; z < Math.min(Z, bz * 64 + 64) && !any; z++) {
          for (let y = by * 64; y < Math.min(Y, by * 64 + 64) && !any; y++) {
            for (let x = bx * 64; x < Math.min(X, bx * 64 + 64); x++) if (value(k, c, x, y, z)) { any = true; break; }
          }
        }
        if (!any) { list.push({ pack: 0, offset: 0, length: 0 }); continue; }
        const brick = new Uint8Array(STRIDE ** 3);
        for (let sz = 0; sz < STRIDE; sz++) for (let sy = 0; sy < STRIDE; sy++) for (let sx = 0; sx < STRIDE; sx++) {
          brick[(sz * STRIDE + sy) * STRIDE + sx] = value(k, c,
            clamp(bx * 64 - 1 + sx, X), clamp(by * 64 - 1 + sy, Y), clamp(bz * 64 - 1 + sz, Z));
        }
        storedMap.set(`${k}/${c}/${bx}_${by}_${bz}`, brick);
        const img = mosaicOf(brick);
        if (inPack >= perPack) { flush(); pack++; inPack = 0; offset = 0; packBytes = []; }
        list.push({ pack, offset, length: img.length });
        packBytes.push(img);
        offset += img.length;
        inPack++;
      }
      flush();
      packCount = Math.max(packCount, pack + 1);
      perChannel.push(list);
    }
    entries.push(perChannel);
    packCounts.push(packCount);
  });
  // index.bin (SPEC §13.3)
  const L = levels.length;
  let size = 12 + 16 * L;
  levels.forEach((lv) => { size += 10 * channels * ceil64(lv.dims.x) * ceil64(lv.dims.y) * ceil64(lv.dims.z); });
  const index = new Uint8Array(size);
  const dv = new DataView(index.buffer);
  index.set(enc.encode('LBIX'), 0);
  dv.setUint16(4, 1, true); dv.setUint16(6, L, true); dv.setUint16(8, channels, true); dv.setUint16(10, 0, true);
  levels.forEach((lv, k) => {
    const p = 12 + 16 * k;
    dv.setUint32(p, ceil64(lv.dims.x), true); dv.setUint32(p + 4, ceil64(lv.dims.y), true);
    dv.setUint32(p + 8, ceil64(lv.dims.z), true); dv.setUint32(p + 12, packCounts[k], true);
  });
  let at = 12 + 16 * L;
  for (let k = 0; k < L; k++) for (let c = 0; c < channels; c++) for (const e of entries[k][c]) {
    dv.setUint16(at, e.pack, true); dv.setUint32(at + 2, e.offset, true); dv.setUint32(at + 6, e.length, true);
    at += 10;
  }
  files.set(`${base}/index.bin`, index);
  const manifest = {
    schema: 'iribhm-bricks-v3', version: 3, formatVersion: 4,
    channels, brickSize: 64, apron: 1, brickPacking: { mode: 'grid', cols: COLS, rows: ROWS, slice: STRIDE },
    encoding: 'webp-lossless',
    levels: levels.map((lv, k) => ({
      level: k, dimensions: { ...lv.dims }, voxelSize: { ...lv.voxelSize },
      gridSize: { x: ceil64(lv.dims.x), y: ceil64(lv.dims.y), z: ceil64(lv.dims.z) },
      brickCount: entries[k].reduce((s, list) => s + list.filter(e => e.length).length, 0)
    })),
    timepoints: null,
    index: { url: 'index.bin', bytes: index.length, sha256: sha256(index) },
    histograms: [], createdAt: '2026-10-05T00:00:00Z'
  };
  const manifestText = JSON.stringify(manifest);
  files.set(`${base}/manifest.json`, enc.encode(manifestText));
  return {
    files, manifest, manifestText, entries, packCounts,
    stored: (k, c, bx, by, bz) => storedMap.get(`${k}/${c}/${bx}_${by}_${bz}`) || null
  };
}

/** "bytes=a-b, c-d" → [[a, b], …] or null. */
export function parseRangeHeader(h) {
  if (!h || !/^bytes=/.test(h)) return null;
  return h.slice(6).split(',').map(s => s.trim().split('-').map(Number));
}

export function multipartBody(ranges, file, boundary = 'LUMEN_BOUNDARY_7f3a') {
  const parts = [];
  for (const [a, b] of ranges) {
    parts.push(enc.encode(`\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\nContent-Range: bytes ${a}-${b}/${file.length}\r\n\r\n`));
    parts.push(file.subarray(a, b + 1));
  }
  parts.push(enc.encode(`\r\n--${boundary}--\r\n`));
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return { body: out, contentType: `multipart/byteranges; boundary=${boundary}` };
}

/**
 * fetch over `files`, logging { path, query, range } per request. mode:
 *   'multipart' (default) a multi-range request → 206 multipart/byteranges, one → 206 single
 *   'first'      only the first range of a multi-range request is served (single 206)
 *   'coalesce'   a multi-range request → one 206 covering first..last
 *   'malformed'  a multi-range request → a multipart body missing its Content-Range lines
 *   'ignore'     Range ignored, 200 with the whole file
 */
export function mockFetch(files, { mode = 'multipart', delay = 0 } = {}) {
  const log = [];
  const fn = async (url, init = {}) => {
    const signal = init.signal;
    const abortErr = () => new DOMException('aborted', 'AbortError');
    if (signal?.aborted) throw abortErr();
    if (delay) {
      await new Promise((resolve, reject) => {
        const t = setTimeout(resolve, delay);
        signal?.addEventListener?.('abort', () => { clearTimeout(t); reject(abortErr()); }, { once: true });
      });
    }
    const [p, query = ''] = String(url).split('?');
    const range = init.headers?.Range || null;
    log.push({ path: p, query, range });
    const file = files.get(p);
    if (!file) return new Response('not found', { status: 404 });
    const ranges = mode === 'ignore' ? null : parseRangeHeader(range);
    if (!ranges) return new Response(file.slice(), { status: 200, headers: { 'Content-Length': String(file.length) } });
    const single = ([a, b]) => new Response(file.slice(a, b + 1), {
      status: 206, headers: { 'Content-Range': `bytes ${a}-${b}/${file.length}`, 'Content-Type': 'application/octet-stream' }
    });
    if (ranges.length === 1 || mode === 'first') return single(ranges[0]);
    // A server capping the ranges of one request (nginx max_ranges, Apache MaxRanges):
    // several ranges are answered with the whole file.
    if (mode === 'multi200') return new Response(file.slice(), { status: 200, headers: { 'Content-Length': String(file.length) } });
    if (mode === 'coalesce') return single([Math.min(...ranges.map(r => r[0])), Math.max(...ranges.map(r => r[1]))]);
    if (mode === 'malformed') {
      const { body, contentType } = multipartBody(ranges, file);
      const broken = new TextDecoder('latin1').decode(body).replace(/Content-Range: [^\r]*\r\n/g, '');
      return new Response(Uint8Array.from(broken, ch => ch.charCodeAt(0)), { status: 206, headers: { 'Content-Type': contentType } });
    }
    const { body, contentType } = multipartBody(ranges, file);
    return new Response(body, { status: 206, headers: { 'Content-Type': contentType } });
  };
  fn.log = log;
  return fn;
}

export function loadBrickLoader(fetchImpl, extra = {}) {
  const BL = loadModule('js/core/brick-loader.js', 'BrickLoader', {
    document: { createElement: () => ({ getContext: () => ({}) }) },
    navigator: { hardwareConcurrency: 2 },
    performance: { now: () => Date.now() },
    window: {},
    AbortController, DOMException, Blob, Response, URL,
    crypto: webcrypto,
    Worker: VmBrickWorker,
    fetch: fetchImpl,
    ...extra
  });
  BL.configure({ decodeWorkers: 1 });
  return BL;
}
