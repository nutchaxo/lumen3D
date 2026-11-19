// Shared helpers of the P-io tests (not a test: no `test_` prefix).
//   loadIo()     the pure modules of ij-proc-io.js in a vm context (with ij-core, ij-proc-shared and ij-proc-lib behind it)
//   oursCases()  the ROIs of OUR model the encoder is checked with (written to tests/fixtures/ij-wave3/io/ours/ for the 1.54p decoder)
//   FIX          tests/fixtures/ij-wave3/io
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import zlib from 'node:zlib';
import { ROOT } from './harness.mjs';

export const DIR = path.join(ROOT, 'js', 'modules', 'studio', 'advanced-studio');
export const FIX = path.join(ROOT, 'tests', 'fixtures', 'ij-wave3', 'io');

export function loadIo(extra = {}) {
  const ctx = vm.createContext({ console, setTimeout, clearTimeout, TextEncoder, TextDecoder, atob, btoa, Blob, ...extra });
  for (const f of ['ij-core.js', 'ij-proc-shared.js', 'ij-proc-lib.js', 'ij-proc-io.js']) vm.runInContext(fs.readFileSync(path.join(DIR, f), 'utf8'), ctx, { filename: f });
  return ctx;
}

export const readJson = (f) => JSON.parse(fs.readFileSync(path.join(FIX, f), 'utf8'));
export const b64 = (s) => new Uint8Array(Buffer.from(s, 'base64'));
/** node:zlib as the raw-deflate decoder the page takes from DecompressionStream('deflate-raw') */
export const inflateRaw = async (bytes) => new Uint8Array(zlib.inflateRawSync(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)));

/** A mask ROI from rows of '#' / '.' with its top-left corner at (x, y). */
export function maskOf(ctx, rows, x, y) {
  const h = rows.length, w = rows[0].length;
  const full = new Uint8Array((x + w) * (y + h));
  rows.forEach((r, j) => { for (let i = 0; i < w; i++) if (r[i] === '#') full[(y + j) * (x + w) + x + i] = 1; });
  return ctx.IJRoi.fromMask(full, x + w, y + h);
}

/** The ROIs of our model the encoder is exercised with: { name, roi, style? }. */
export function oursCases(ctx) {
  const R = [];
  const add = (name, roi, style) => R.push({ name, roi, style });
  add('rect', { type: 'rect', x: 10, y: 8, w: 30, h: 20 });
  add('rect_subpixel', { type: 'rect', x: 10.5, y: 8.25, w: 30.75, h: 20.5 });
  add('rect_styled', { type: 'rect', x: 4, y: 4, w: 20, h: 16 }, { name: 'cell-7', stroke: '#ff8000', width: 3, position: { c: 2, z: 3, t: 4 } });
  add('rect_fill', { type: 'rect', x: 6, y: 6, w: 12, h: 12 }, { name: 'filled', fill: '#8000ff60' });
  add('rect_unicode_name', { type: 'rect', x: 2, y: 3, w: 9, h: 7 }, { name: 'cellule-é-β' });
  add('oval', { type: 'oval', x: 12, y: 6, w: 28, h: 22 });
  add('oval_subpixel', { type: 'oval', x: 12.5, y: 6.5, w: 27.25, h: 22.75 });
  add('polygon', { type: 'polygon', points: [[8, 6], [40, 10], [52, 30], [30, 22], [36, 40], [14, 34]] });
  add('polygon_subpixel', { type: 'polygon', points: [[8.5, 6.25], [40.5, 10], [52, 30.5], [20, 40]] });
  add('freehand', { type: 'freehand', points: [[10, 10], [14, 9], [18, 12], [17, 18], [11, 17]] });
  add('freehand_subpixel', { type: 'freehand', points: [[10.5, 10], [14, 9.5], [18, 12], [17, 18.5], [11, 17]] });
  add('traced', { type: 'polygon', traced: true, points: [[19, 11], [25, 11], [25, 14], [28, 14], [28, 20], [19, 20]] });
  add('line', { type: 'line', x1: 6, y1: 40, x2: 58, y2: 8 });
  add('line_subpixel', { type: 'line', x1: 6.5, y1: 40.25, x2: 58.75, y2: 8.5 });
  add('line_width4', { type: 'line', x1: 6, y1: 40, x2: 58, y2: 8, width: 4 });
  add('polyline', { type: 'polyline', points: [[6, 38], [18, 12], [33, 30], [46, 10], [58, 28]] });
  add('polyline_subpixel', { type: 'polyline', points: [[6.5, 38], [18, 12.5], [33.25, 30]] });
  add('angle', { type: 'angle', points: [[10, 10], [30, 20], [40, 8]] });
  add('points', { type: 'point', points: [[10, 10], [30, 8], [46, 20], [40, 38]] });
  add('points_subpixel', { type: 'point', points: [[10.5, 10], [30.25, 8.75], [46, 20.5]] });
  add('mask_traced', { type: 'mask', ...maskOf(ctx, ['..###.', '.####.', '######', '..##..'], 7, 5) });
  add('mask_hole', { type: 'mask', ...maskOf(ctx, ['#######', '#.....#', '#.###.#', '#.#.#.#', '#.###.#', '#.....#', '#######'], 3, 4) });
  add('mask_two', { type: 'mask', ...maskOf(ctx, ['###....##', '###....##', '.........', '....###..'], 2, 2) });
  add('mask_diagonal', { type: 'mask', ...maskOf(ctx, ['##..', '##..', '..##', '..##'], 5, 5) });
  return R;
}

/**
 * A classic TIFF writer for the tests of the compressed reader: planes of one sample each (8 / 16-bit unsigned, 32-bit float),
 * strips of `rowsPerStrip` rows, compression 'none' | 'deflate' (8) | 'adobe' (32946: the same zlib stream), predictor 1 | 2
 * (horizontal differencing per row, modulo the sample width), little or big endian, an ImageJ description on the first plane.
 *   buildTiff({ width, height, bitDepth, planes: [TypedArray], compression, predictor, rowsPerStrip, bigEndian, description, photometric,
 *               imagejMeta: { ranges: [[min, max]], luts: [Uint8Array(768) interleaved r g b], labels: [string] }, resolution: { x, y, unit } })
 */
export function buildTiff(o) {
  const le = !o.bigEndian, W = o.width, H = o.height, bd = o.bitDepth;
  const rps = o.rowsPerStrip || H, comp = o.compression || 'none', pred = o.predictor || 1;
  const bps = bd / 8;
  const chunks = [];            // everything after the 8-byte header, in order, with absolute offsets known as we go
  let pos = 8;
  const put = (u8) => { const at = pos; chunks.push(u8); pos += u8.length; if (pos & 1) { chunks.push(new Uint8Array(1)); pos++; } return at; };
  const u16 = (v) => { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, v, le); return b; };
  const u32 = (v) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v, le); return b; };
  const stripsOfPlane = o.planes.map((plane) => {
    const offsets = [], counts = [];
    for (let s = 0; s * rps < H; s++) {
      const rows = Math.min(rps, H - s * rps);
      const vals = plane.slice(s * rps * W, (s * rps + rows) * W);
      const bits = bd === 32 ? new Uint32Array(vals.buffer, vals.byteOffset, vals.length) : vals;
      if (pred === 2) for (let y = 0; y < rows; y++) for (let x = W - 1; x >= 1; x--) bits[y * W + x] = (bits[y * W + x] - bits[y * W + x - 1]);
      let bytes = new Uint8Array(rows * W * bps);
      const dv = new DataView(bytes.buffer);
      for (let i = 0; i < rows * W; i++) { if (bps === 1) bytes[i] = bits[i]; else if (bps === 2) dv.setUint16(i * 2, bits[i], le); else dv.setUint32(i * 4, bits[i], le); }
      if (comp !== 'none') bytes = new Uint8Array(zlib.deflateSync(Buffer.from(bytes)));
      offsets.push(put(bytes)); counts.push(bytes.length);
    }
    return { offsets, counts };
  });
  const ifds = [];
  o.planes.forEach((plane, p) => {
    const st = stripsOfPlane[p];
    const e = [];                                       // [tag, type, count, Uint8Array value]
    const short = (tag, v) => e.push([tag, 3, 1, u16(v)]);
    const long = (tag, v) => e.push([tag, 4, 1, u32(v)]);
    long(256, W); long(257, H); short(258, bd); short(259, comp === 'none' ? 1 : comp === 'deflate' ? 8 : 32946);
    short(262, o.photometric === undefined ? 1 : o.photometric);
    if (p === 0 && o.description) { const t = new TextEncoder().encode(o.description + '\0'); e.push([270, 2, t.length, t]); }
    e.push([273, 4, st.offsets.length, Uint8Array.from(st.offsets.flatMap((v) => Array.from(u32(v))))]);
    short(277, 1); long(278, rps);
    e.push([279, 4, st.counts.length, Uint8Array.from(st.counts.flatMap((v) => Array.from(u32(v))))]);
    if (p === 0 && o.resolution) {
      const rat = (v) => Uint8Array.from([...u32(Math.round(v * 1000000)), ...u32(1000000)]);
      e.push([282, 5, 1, rat(o.resolution.x)]); e.push([283, 5, 1, rat(o.resolution.y)]); short(296, o.resolution.unit || 2);
    }
    short(284, 1);
    if (pred === 2) short(317, 2);
    short(339, bd === 32 ? 3 : 1);
    if (p === 0 && o.imagejMeta) {
      const m = o.imagejMeta, parts = [], counts = [];
      const hdr = [], types = [];
      const add = (type, items) => { types.push([type, items.length]); for (const b of items) { parts.push(b); counts.push(b.length); } };
      if (m.labels) add(0x6c61626c, m.labels.map((s) => { const b = new Uint8Array(s.length * 2); const dv = new DataView(b.buffer); for (let i = 0; i < s.length; i++) dv.setUint16(i * 2, s.charCodeAt(i), le); return b; }));
      if (m.ranges) { const b = new Uint8Array(m.ranges.length * 16); const dv = new DataView(b.buffer); m.ranges.forEach((r, i) => { dv.setFloat64(i * 16, r[0], le); dv.setFloat64(i * 16 + 8, r[1], le); }); add(0x72616e67, [b]); }
      if (m.luts) add(0x6c757473, m.luts.map((t) => { const b = new Uint8Array(768); for (let i = 0; i < 256; i++) { b[i] = t[i * 3]; b[256 + i] = t[i * 3 + 1]; b[512 + i] = t[i * 3 + 2]; } return b; }));
      const head = new Uint8Array(4 + types.length * 8); const hv = new DataView(head.buffer);
      hv.setUint32(0, 0x494a494a, le); types.forEach(([t, c], i) => { hv.setUint32(4 + i * 8, t, le); hv.setUint32(8 + i * 8, c, le); });
      const data = Uint8Array.from([...head, ...parts.flatMap((b) => Array.from(b))]);
      const cnt = [head.length, ...counts];
      e.push([50838, 4, cnt.length, Uint8Array.from(cnt.flatMap((v) => Array.from(u32(v))))]);
      e.push([50839, 1, data.length, data]);
    }
    e.sort((a, b) => a[0] - b[0]);
    ifds.push(e);
  });
  // values over 4 bytes live out of line; the IFDs follow
  const ifdAt = [];
  const out = [];
  ifds.forEach((e) => {
    e.forEach((ent) => { if (ent[3].length > 4) ent.push(put(ent[3])); });
  });
  ifds.forEach((e, i) => { ifdAt.push(pos); pos += 2 + e.length * 12 + 4; if (pos & 1) pos++; void i; });
  const total = pos;
  const file = new Uint8Array(total);
  const dv = new DataView(file.buffer);
  file[0] = le ? 0x49 : 0x4d; file[1] = file[0]; dv.setUint16(2, 42, le); dv.setUint32(4, ifdAt[0], le);
  let at = 8;
  for (const c of chunks) { file.set(c, at); at += c.length; }
  ifds.forEach((e, i) => {
    let p = ifdAt[i];
    dv.setUint16(p, e.length, le); p += 2;
    for (const ent of e) {
      dv.setUint16(p, ent[0], le); dv.setUint16(p + 2, ent[1], le); dv.setUint32(p + 4, ent[2], le);
      if (ent[3].length > 4) dv.setUint32(p + 8, ent[4], le); else file.set(ent[3], p + 8);
      p += 12;
    }
    dv.setUint32(p, i + 1 < ifds.length ? ifdAt[i + 1] : 0, le);
  });
  return file;
}
