// Shared helpers of the "Open from Library" tests (not a test: no `test_` prefix): a synthetic TIFF writer + the index the
// api/tiff-index endpoint would answer for it, a fake host that serves it with Range / multipart (and its failure modes), a worker-side
// `E` stand-in for calling the commands of ij-proc-lib.js directly, and a synthetic ctx.studio.library.
import assert from 'node:assert/strict';
import vm from 'node:vm';
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './harness.mjs';

const DIR = path.join(ROOT, 'js', 'modules', 'studio', 'advanced-studio');
export const BASE_URL = 'http://test.local/DATA_WEB/3d/demo/download/';

/** ij-core + ij-proc-shared + ij-proc-lib in one vm context (page and worker alike for these tests). */
export function loadLib(extra = {}) {
  const ctx = vm.createContext({ console, setTimeout, clearTimeout, setInterval, clearInterval, AbortController, TextEncoder, TextDecoder, DecompressionStream, atob, btoa, ...extra });
  ctx.self = ctx;
  for (const f of ['ij-core.js', 'ij-proc-shared.js', 'ij-proc-lib.js']) vm.runInContext(fs.readFileSync(path.join(DIR, f), 'utf8'), ctx, { filename: f });
  return ctx;
}

const b64 = (u8) => Buffer.from(u8).toString('base64');

/**
 * buildTiff({ w, h, pages, bits (8 | 16 | 32 = float), spp (1 | 3 chunky), rowsPerStrip, compression ('none' | 'deflate'), predictor (1 | 2),
 *   imagej, resolution, pixel(page, x, y, s) → number, name })
 * → { file: Uint8Array, index, pixel, planeOf(page, s) } — pages back to back, a 40-byte gap (the IFD) after each, like the bundle writer.
 */
export function buildTiff(o) {
  const w = o.w, h = o.h, pages = o.pages, bits = o.bits || 8, spp = o.spp || 1, rps = Math.min(o.rowsPerStrip || h, h);
  const comp = o.compression === 'deflate' ? 8 : 1, predictor = o.predictor || 1;
  const bps = bits / 8;
  const pixel = o.pixel || ((p, x, y, s) => (p * 37 + x * 5 + y * 11 + s * 3) % 250 + 1);
  const strips = Math.ceil(h / rps);
  const offsets = [], counts = [], parts = [new Uint8Array(8)];
  let at = 8;
  const gap = 40;
  for (let p = 0; p < pages; p++) {
    for (let s = 0; s < strips; s++) {
      const rows = Math.min(rps, h - s * rps);
      const raw = new Uint8Array(rows * w * spp * bps), dv = new DataView(raw.buffer);
      const vals = new Array(rows * w * spp);
      for (let y = 0; y < rows; y++) for (let x = 0; x < w; x++) for (let c = 0; c < spp; c++) vals[(y * w + x) * spp + c] = pixel(p, x, s * rps + y, c);
      if (predictor === 2 && bits !== 32) {
        const mod = bits === 8 ? 256 : 65536;
        for (let y = 0; y < rows; y++) for (let x = w - 1; x >= 1; x--) for (let c = 0; c < spp; c++) {
          const i = (y * w + x) * spp + c, j = (y * w + x - 1) * spp + c;
          vals[i] = (((vals[i] - vals[j]) % mod) + mod) % mod;
        }
      }
      vals.forEach((v, i) => { if (bits === 8) dv.setUint8(i, v); else if (bits === 16) dv.setUint16(i * 2, v, true); else dv.setFloat32(i * 4, v, true); });
      const bytes = comp === 8 ? new Uint8Array(zlib.deflateSync(Buffer.from(raw))) : raw;
      offsets.push(at); counts.push(bytes.length); parts.push(bytes); at += bytes.length;
    }
    parts.push(new Uint8Array(gap).fill(0xEE)); at += gap;
  }
  const file = new Uint8Array(at);
  let k = 0;
  for (const p of parts) { file.set(p, k); k += p.length; }
  const name = o.name || 'demo.tif';
  const index = {
    v: 1, dataset: o.dataset || '3d/demo', file: name, url: BASE_URL + encodeURIComponent(name).replace(/%2F/g, '/'), size: file.length, mtime: 1731234567,
    bigtiff: false, littleEndian: true, width: w, height: h, bitsPerSample: bits, sampleFormat: bits === 32 ? 3 : 1, samplesPerPixel: spp,
    planarConfig: 1, photometric: spp === 3 ? 2 : 1, compression: comp, predictor, tiled: false, rowsPerStrip: rps, pages, uniform: true,
    resolution: o.resolution === undefined ? { x: 2, y: 2, unit: 1 } : o.resolution, imagej: o.imagej === undefined ? null : o.imagej,
    strips: { perPage: strips, offsets: b64(new Uint8Array(new Float64Array(offsets).buffer)), byteCounts: b64(new Uint8Array(new Uint32Array(counts).buffer)) }
  };
  return { file, index, pixel, strips, offsets, counts };
}

/** An ImageJ block for the index: a hyperstack of `channels` × `slices`. */
export function imagej(o) {
  const c = o.channels || 1, z = o.slices || 1;
  return Object.assign({ version: '1.54f', images: c * z * (o.frames || 1), channels: c, slices: z, frames: o.frames || 1, hyperstack: true, mode: 'composite', unit: 'micron',
    spacing: o.spacing === undefined ? 2 : o.spacing, ranges: o.ranges || [], colors: o.colors || [], labels: o.labels || [],
    info: o.info === undefined ? 'Dataset: demo\nSource: Imaris .ims ResolutionLevel 1, native uint16\nVoxel size (um): X=0.5 Y=0.5 Z=2' : o.info }, o.extra || {});
}

/** A fake host over `file`: Range with several parts → multipart/byteranges, one → 206; modes 'multi' | 'ignore' | 'refuse-multi' | 'http500'. */
export function host(file, mode = 'multi') {
  const log = { requests: 0, ranges: [], urls: [] };
  const fetchImpl = async (url, init) => {
    log.requests++; log.urls.push(String(url));
    await new Promise((r) => setTimeout(r, 1));
    if (init && init.signal && init.signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    const spec = /bytes=(.*)/.exec((init.headers || {}).Range)[1].split(',').map((s) => s.trim().split('-').map(Number));
    log.ranges.push(spec.length);
    if (mode === 'http500') return new Response('', { status: 500 });
    if (mode === 'ignore') return new Response(new ReadableStream({ start(c) { c.enqueue(file.subarray(0, 16)); } }), { status: 200 });
    if (spec.length > 1 && mode === 'refuse-multi') return new Response('', { status: 416 });
    if (spec.length === 1) {
      const [a, b] = spec[0];
      return new Response(file.slice(a, b + 1), { status: 206, headers: { 'Content-Range': `bytes ${a}-${b}/${file.length}` } });
    }
    const boundary = 'THIS_STRING_SEPARATES';
    const enc = (s) => Buffer.from(s, 'latin1');
    const chunks = [];
    for (const [a, b] of spec) chunks.push(enc(`--${boundary}\r\nContent-Type: image/tiff\r\nContent-Range: bytes ${a}-${b}/${file.length}\r\n\r\n`), Buffer.from(file.subarray(a, b + 1)), enc('\r\n'));
    chunks.push(enc(`--${boundary}--\r\n`));
    return new Response(Buffer.concat(chunks), { status: 206, headers: { 'Content-Type': `multipart/byteranges; boundary=${boundary}` } });
  };
  return { fetchImpl, log };
}

/**
 * The `E` of a worker command, recorded: reserve (throws IJ_OVER_BUDGET above `limit` bytes of reservations), tick / check (cancel after
 * `cancelAfter` ticks), createDoc (records the image), fetch.
 */
export function makeE(o = {}) {
  const rec = { reserved: 0, reservations: [], ticks: 0, docs: [], events: [], released: 0 };
  const ijError = (code, message) => Object.assign(new Error(message || code), { code });
  const E = {
    budgetBytes: o.budgetBytes || 1 << 30, rec, ijError,
    check() { if (o.cancelAfter !== undefined && rec.ticks >= o.cancelAfter) throw ijError('IJ_CANCELLED', 'cancelled'); },
    async tick(f, key) { rec.ticks++; rec.lastFraction = f; rec.lastKey = key; E.check(); },
    reserve(n) {
      if (o.limit !== undefined && rec.reserved + n > o.limit) throw ijError('IJ_OVER_BUDGET', 'over');
      rec.reserved += n; rec.reservations.push(n);
    },
    release(n) { rec.reserved -= n; rec.released += n; },
    createDoc(image, opts) { const info = { docId: 'doc' + (rec.docs.length + 1), name: image.name, width: image.width, height: image.height, bitDepth: image.bitDepth }; rec.docs.push({ image, opts, info }); return info; },
    fetch: (...a) => (o.fetchImpl || fetch)(...a),
    postEvent(ev) { rec.events.push(ev); }
  };
  return E;
}

/** Runs a registered worker command of the loaded lib files: call(ctx, 'doc.tiff.project', args, E). */
export async function callCommand(ctx, name, args, E) {
  const spec = ctx.IJOpRegistry.getCommand(name);
  assert.ok(spec, 'the command ' + name + ' is registered');
  assert.equal(spec.pkg, 'lib');
  return spec.handler(args, E);
}

export const sameArray = (a, b, what) => {
  assert.equal(a.length, b.length, (what || 'arrays') + ' length');
  for (let i = 0; i < a.length; i++) if (!(a[i] === b[i] || (a[i] !== a[i] && b[i] !== b[i]))) assert.fail(`${what || 'arrays'} differ at ${i}: ${a[i]} vs ${b[i]}`);
};

/** The reference projection of a TIFF built by buildTiff, through IJProject over whole planes (no bands, no requests). */
export function referenceProject(ctx, t, o) {
  const IJProject = ctx.IJProject;
  const { w, h } = { w: t.index.width, h: t.index.height };
  const depth = o.z1 - o.z0 + 1;
  const bits = t.index.bitsPerSample;
  const Ctor = bits === 8 ? Uint8Array : bits === 16 ? Uint16Array : Float32Array;
  const proj = IJProject.create({ method: o.method, width: w, height: h, depth, channels: o.channels.length, inputBitDepth: bits });
  o.channels.forEach((c, k) => {
    for (let z = o.z0; z <= o.z1; z++) {
      const plane = new Ctor(w * h);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) plane[y * w + x] = t.pixel(o.page(z, c), x, y, o.sample ? o.sample(c) : 0);
      proj.addBlock({ channel: k, y0: 0, rows: h, z0: z - o.z0, depth: 1, data: plane });
    }
  });
  return proj.finish();
}

/** A synthetic 8-bit volume: value(c, x, y, z), dims, and the readers a library facade would offer. */
export function makeVolume(o = {}) {
  const dims = o.dims || { x: 20, y: 16, z: 6 }, nc = o.channels || 2;
  const value = o.value || ((c, x, y, z) => (((x * 3 + y * 5 + z * 17 + c * 40) % 250) + 1));
  return { dims, nc, value };
}

// ───────────────────────────── a synthetic ctx.studio.library ─────────────────────────────
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * makeLibrary({ datasets: { id: { item, desc, tiffs: { file: index }, volume: { value, dims } } } }) → the facade of PLAN-wave3 §3.1 over
 * synthetic data, with a log of every call. A dataset's `desc` is what describe() answers; `volume` feeds openPlanes / openOblique.
 */
export function makeLibrary(o) {
  const log = { calls: [], released: [], runs: 0, outstanding: 0, maxOutstanding: 0 };
  const data = o.datasets;
  const rec = (name, ...args) => log.calls.push([name, ...args]);
  const get = (id) => { const d = data[id]; if (!d) throw Object.assign(new Error('unknown'), { code: 'LIBRARY_UNKNOWN', datasetId: id }); return d; };
  const lib = {
    log,
    list: () => Object.values(data).filter((d) => d.listed !== false).map((d) => d.item),
    async describe(id, opt) {
      rec('describe', id, opt && opt.timepoint);
      const d = get(id);
      if (d.describeError) throw Object.assign(new Error('describe'), { code: d.describeError, datasetId: id });
      if (d.latency) await sleepMs(d.latency);
      if (opt && opt.signal && opt.signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      return JSON.parse(JSON.stringify(typeof d.desc === 'function' ? d.desc(opt || {}) : d.desc));
    },
    async tiffIndex(id, file) {
      rec('tiffIndex', id, file);
      const idx = get(id).tiffs && get(id).tiffs[file];
      if (!idx) throw Object.assign(new Error('no index'), { code: 'LIBRARY_TIFF_INDEX', status: 404 });
      return JSON.parse(JSON.stringify(idx));
    },
    async openPlanes(id, opt) {
      rec('openPlanes', id, { first: opt.first, last: opt.last, level: opt.level, timepoint: opt.timepoint });
      const d = get(id), v = d.volume, dd = typeof d.desc === 'function' ? d.desc({}) : d.desc;
      const lv = opt.level || 0, f = 1 << lv;
      const width = Math.ceil(v.dims.x / f), height = Math.ceil(v.dims.y / f);
      const indices = []; for (let z = opt.first; z <= opt.last; z++) indices.push(z);
      let released = false;
      return {
        level: lv, width, height, depth: indices.length, indices, bandRows: o.bandRows || 8, zChunk: o.zChunk || 2,
        calibration: { pixelWidth: dd.levels[lv].voxelUm.x, pixelHeight: dd.levels[lv].voxelUm.y, unit: 'µm' },
        estimateBytes: () => width * height * indices.length * 2, backend: 'bricks',
        assertFrame() { if (released) throw Object.assign(new Error('released'), { code: 'LIBRARY_RELEASED' }); },
        release() { released = true; log.released.push(id); },
        async readBlock({ y0, y1, z0, z1, channels, signal }) {
          if (signal && signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
          const rows = y1 - y0, depth = z1 - z0;
          const out = channels.map((c) => { const a = new Uint8Array(depth * rows * width); for (let z = 0; z < depth; z++) for (let y = 0; y < rows; y++) for (let x = 0; x < width; x++) a[(z * rows + y) * width + x] = v.value(c, x * f, (y0 + y) * f, indices[z0 + z]); return a; });
          return { width, rows, depth, data: out };
        }
      };
    },
    async openOblique(id, opt) {
      rec('openOblique', id, { level: opt.level, spec: opt.spec, timepoint: opt.timepoint });
      const d = get(id);
      if (d.obliqueError) throw Object.assign(new Error('oblique'), { code: d.obliqueError, datasetId: id, needsViewer: true });
      const g = d.geometry(opt.spec);
      let released = false;
      return {
        level: opt.level || 0, width: g.width, height: g.height, pixelUm: { x: 1.5, y: 1.5 }, channels: d.volume.nc, geometry: g, estimateBytes: () => 1,
        release() { released = true; log.released.push(id + '#oblique'); },
        async run({ channels, signal, onBrick }) {
          log.runs++;
          const tally = { delivered: 0, failed: [], empty: [] };
          for (const c of channels) {
            for (const b of d.bricks(g)) {
              if (signal && signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
              if (b.skip === 'ess') { tally.empty.push({ channel: c, ...b.box }); continue; }
              if (b.skip === 'fail') { tally.failed.push({ channel: c, ...b.box }); continue; }
              log.outstanding++; log.maxOutstanding = Math.max(log.maxOutstanding, log.outstanding);
              await onBrick({ channel: c, box: b.box, data: b.data(c) });
              log.outstanding--;
              tally.delivered++;
            }
          }
          return tally;
        }
      };
    },
    async preview(id, q, opt) { rec('preview', id, q, opt && opt.size); return o.preview ? o.preview(id, q) : null; },
    viewerUrl: (id) => 'viewer.html?id=' + encodeURIComponent(id),
    release(id) { rec('release', id); }
  };
  return lib;
}
