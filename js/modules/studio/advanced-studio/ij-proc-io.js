/* ij-proc-io.js — package P-io (io): file formats, the ROI codec, the text image, the two XY writers.
 *
 * Loaded on the page AND in the worker (ij-worker.js loads it in its own try/catch: a failure here disables the
 * package's commands, it never takes the Advanced view down). Pure: no DOM, no engine globals; the operations are
 * registered with IJOpRegistry.define(name, spec) (ij-core.js).
 *
 * Attaches to `self`:
 *   IJJava       Java number formatting the ImageJ text outputs depend on:
 *                  d2s(n, places)      IJ.d2s (DecimalFormat, HALF_EVEN on the exact value; NaN / Infinity as Java prints them)
 *                  rtD2s(n, places)    ResultsTable.d2s (scientific notation for tiny / huge values)
 *                  floatToString(v)    Float.toString (the shortest digits that read back as the float)
 *                  parseDouble(s)      Double.parseDouble as Tools.parseDouble(s, NaN) uses it
 *   IJRoiCodec   the .roi file format of ij/io/RoiEncoder.java / RoiDecoder.java (format version 228) and the RoiSet zip:
 *                  encode(roi, style) → Uint8Array     decode(bytes, opts) → roi     decodeEntry(bytes, opts) → { roi, name, stroke, fill, width, position }
 *                  encodeSet(entries) → Uint8Array     decodeSet(zip, { inflateRaw }) → Promise<[{ name, bytes }]>
 *                  xyPolygon(roi) → { points, sub }    (the vertices XYWriter prints)
 *   IJTextIo     ij/plugin/TextReader.java, ij/io/TextEncoder.java, ij/plugin/filter/XYWriter.java, ij/plugin/XYCoordinates.java
 *   IJFileKinds  File > Open: the kind of a file, the page's own error codes, a decoded picture as an image
 *   IJLocalTiff  the compressed TIFFs the Download Center writes (deflate 8 / 32946, predictor 1 / 2), read through IJTiffStream.decodeStrip
 *
 * Registry operations (all compute, none previews):
 *   roiSetOp       the ROI Manager's AND / OR (Combine) / XOR / Split on the pixel masks of the ROIs
 *   xyCoordinates  Analyze > Tools > Save XY Coordinates (and its probe of the default background value)
 *   textImage      File > Save As > Text Image
 *
 * Reference: ImageJ 1.54p (public domain). Where the port differs from the Java, the difference is stated beside the code.
 */
(function (root) {
  'use strict';
  const R = root.IJOpRegistry;
  const F32 = Math.fround;

  function ijError(code, message) { const e = new Error(message || code); e.code = code; return e; }
  const bad = (m) => ijError('IJ_BAD_ARGS', m);
  const finite = (v) => typeof v === 'number' && isFinite(v);
  const isInt = (v) => Number.isInteger(v);
  // The module is loaded in the page, the worker and test contexts: typed arrays cross realms, so no `instanceof`.
  const isU8 = (b) => ArrayBuffer.isView(b) && b.constructor && b.constructor.name === 'Uint8Array';
  const toU8 = (b) => (isU8(b) ? b : ArrayBuffer.isView(b) ? new Uint8Array(b.buffer, b.byteOffset, b.byteLength) : new Uint8Array(b));

  // ====================================================================================== IJJava
  const IJJava = (() => {
    /* The digits of the exact value of a double `a` ≥ 0 rounded to `places` decimals with HALF_EVEN (what Java's
     * DecimalFormat does since JDK 8: the exact binary value decides, an exact tie goes to the even digit). toFixed
     * rounds the exact value correctly except on an exact tie, where it picks the larger neighbour: ties are found
     * exactly (a tie needs at most places+1 fractional bits) and settled here. */
    function fixedHalfEven(a, places) {
      if (a >= 1e15) {
        // Java formats the SHORTEST digits of the double and pads with zeros (the exact digits of 1e30 are not printed)
        let s = String(a);
        if (/e/i.test(s)) {
          const m = /^(\d)(?:\.(\d+))?e\+(\d+)$/.exec(s);
          const ds = m[1] + (m[2] || '');
          s = ds + '0'.repeat(Math.max(0, Number(m[3]) + 1 - ds.length));
        }
        if (s.indexOf('.') < 0) return places ? s + '.' + '0'.repeat(places) : s;
        const [ip, fp] = s.split('.');
        return places ? ip + '.' + fp.padEnd(places, '0').slice(0, places) : ip;
      }
      const fl = Math.floor(a), frac = a - fl;
      if (places >= 0 && frac > 0 && Number.isInteger(frac * Math.pow(2, places + 1))) {
        const t = frac * Math.pow(10, places);        // exact: frac has at most places+1 fractional bits
        if (t - Math.floor(t) === 0.5) {
          let scaled = BigInt(fl) * (10n ** BigInt(places)) + BigInt(Math.floor(t));
          if (scaled % 2n === 1n) scaled += 1n;       // the tie goes to the even digit
          const txt = scaled.toString().padStart(places + 1, '0');
          return places ? txt.slice(0, txt.length - places) + '.' + txt.slice(txt.length - places) : txt;
        }
      }
      return a.toFixed(places);
    }

    /* "0.000E0" patterns of DecimalFormat: `digits` decimals in the mantissa, HALF_EVEN on the exact value. */
    function sciHalfEven(n, digits) {
      const neg = n < 0 || Object.is(n, -0);
      const a = Math.abs(n);
      if (a === 0) return (neg ? '-' : '') + (digits ? '0.' + '0'.repeat(digits) : '0') + 'E0';
      let e = Math.floor(Math.log10(a));
      for (let k = 0; k < 3; k++) { if (a < Math.pow(10, e)) e--; else if (a >= Math.pow(10, e + 1)) e++; else break; }
      // exact rational a = m · 2^q ; digits = round_half_even(a / 10^e · 10^digits)
      const buf = new DataView(new ArrayBuffer(8)); buf.setFloat64(0, a);
      const bits = buf.getBigUint64(0);
      const be = Number((bits >> 52n) & 0x7ffn);
      let mant = bits & 0xfffffffffffffn;
      let q;
      if (be === 0) q = -1074; else { mant |= 1n << 52n; q = be - 1075; }
      const roundDiv = (num, den) => { let d = num / den; const r2 = (num % den) * 2n; if (r2 > den || (r2 === den && d % 2n === 1n)) d += 1n; return d; };
      const compute = (ee) => {
        let num = mant, den = 1n;
        if (q >= 0) num <<= BigInt(q); else den <<= BigInt(-q);
        const sh = digits - ee;
        if (sh >= 0) num *= 10n ** BigInt(sh); else den *= 10n ** BigInt(-sh);
        return roundDiv(num, den);
      };
      let m = compute(e);
      if (m >= 10n ** BigInt(digits + 1)) { e += 1; m = compute(e); }
      const txt = m.toString().padStart(digits + 1, '0');
      return (neg ? '-' : '') + (digits ? txt[0] + '.' + txt.slice(1) : txt) + 'E' + e;
    }

    /* ij.IJ.d2s(double n, int decimalPlaces) */
    function d2s(n, places) {
      if (n !== n || n === Infinity || n === -Infinity) return String(n);
      if (n === 3.4028234663852886e38) return '3.4e38';
      if (places < 0) return sciHalfEven(n, Math.min(9, -places));
      places = Math.min(9, places);
      const neg = n < 0 || Object.is(n, -0);
      return (neg ? '-' : '') + fixedHalfEven(Math.abs(n), places);
    }

    /* ij.measure.ResultsTable.d2s: scientific notation for a tiny or huge value */
    function rtD2s(n, places) {
      if (n !== n || n === Infinity || n === -Infinity) return String(n);
      if (n === 3.4028234663852886e38) return '3.4e38';
      const np = Math.abs(n);
      if ((np !== 0 && np < 1 / Math.pow(10, places)) || np > 999999999999 || places < 0) {
        let dp = places < 0 ? Math.min(9, -places) : 3;
        return sciHalfEven(n, dp);
      }
      return d2s(n, Math.max(0, Math.min(9, places)));
    }

    /* java.lang.Float.toString for a float value held in a double. */
    function floatToString(v) {
      if (v !== v) return 'NaN';
      if (v === Infinity) return 'Infinity';
      if (v === -Infinity) return '-Infinity';
      if (v === 0) return Object.is(v, -0) ? '-0.0' : '0.0';
      const sign = v < 0 ? '-' : '';
      const a = Math.abs(v);
      let s = null;
      for (let p = 1; p <= 9; p++) { const c = a.toExponential(p - 1); if (F32(Number(c)) === a) { s = c; break; } }
      if (s === null) s = a.toExponential(8);
      const m = /^(\d)(?:\.(\d+))?e([+-]\d+)$/.exec(s);
      const ds = m[1] + (m[2] || '');
      const e = parseInt(m[3], 10);
      if (a >= 1e-3 && a < 1e7) {
        if (e >= 0) {
          const ip = ds.slice(0, e + 1).padEnd(e + 1, '0');
          return sign + ip + '.' + (ds.slice(e + 1) || '0');
        }
        return sign + '0.' + '0'.repeat(-e - 1) + ds;
      }
      return sign + ds[0] + '.' + (ds.slice(1) || '0') + 'E' + e;
    }

    /* Tools.parseDouble(s, NaN): Double.parseDouble, NaN when it throws. A hexadecimal float literal is not read
     * (it throws here, Java reads it): such a token is NaN. */
    const DOUBLE_RX = /^[+-]?(?:NaN|Infinity|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?[fFdD]?)$/;
    function parseDouble(s) {
      if (typeof s !== 'string' || !DOUBLE_RX.test(s)) return NaN;
      const t = s.replace(/[fFdD]$/, '');
      if (/NaN$/.test(t)) return NaN;
      if (/Infinity$/.test(t)) return t[0] === '-' ? -Infinity : Infinity;
      return Number(t);
    }
    return { d2s, rtD2s, floatToString, parseDouble, fixedHalfEven };
  })();

  // ====================================================================================== CRC-32 and the zip container
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
    return t;
  })();
  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 255] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }
  const utf8 = (s) => new TextEncoder().encode(s);

  /* A ZIP of STORED entries (RoiManager.saveMultiple writes DEFLATED; any reader takes both). Entry time fixed
   * (2000-01-01 00:00): the same ROIs always give the same bytes. */
  function zipStore(entries) {
    const DOS_DATE = ((2000 - 1980) << 9) | (1 << 5) | 1, DOS_TIME = 0;
    const names = entries.map((e) => utf8(e.name));
    let total = 22;
    entries.forEach((e, i) => { total += 30 + names[i].length + e.bytes.length + 46 + names[i].length; });
    if (entries.length > 65535 || total > 0xffffffff) throw ijError('IJ_IO_TOO_LARGE', 'zip too large');
    const out = new Uint8Array(total);
    const dv = new DataView(out.buffer);
    let p = 0;
    const offsets = [], crcs = [];
    entries.forEach((e, i) => {
      offsets.push(p);
      const crc = crc32(e.bytes); crcs.push(crc);
      dv.setUint32(p, 0x04034b50, true); dv.setUint16(p + 4, 20, true); dv.setUint16(p + 6, 0x0800, true); dv.setUint16(p + 8, 0, true);
      dv.setUint16(p + 10, DOS_TIME, true); dv.setUint16(p + 12, DOS_DATE, true); dv.setUint32(p + 14, crc, true);
      dv.setUint32(p + 18, e.bytes.length, true); dv.setUint32(p + 22, e.bytes.length, true);
      dv.setUint16(p + 26, names[i].length, true); dv.setUint16(p + 28, 0, true);
      out.set(names[i], p + 30); p += 30 + names[i].length;
      out.set(e.bytes, p); p += e.bytes.length;
    });
    const cdStart = p;
    entries.forEach((e, i) => {
      dv.setUint32(p, 0x02014b50, true); dv.setUint16(p + 4, 20, true); dv.setUint16(p + 6, 20, true); dv.setUint16(p + 8, 0x0800, true);
      dv.setUint16(p + 10, 0, true); dv.setUint16(p + 12, DOS_TIME, true); dv.setUint16(p + 14, DOS_DATE, true); dv.setUint32(p + 16, crcs[i], true);
      dv.setUint32(p + 20, e.bytes.length, true); dv.setUint32(p + 24, e.bytes.length, true); dv.setUint16(p + 28, names[i].length, true);
      dv.setUint16(p + 30, 0, true); dv.setUint16(p + 32, 0, true); dv.setUint16(p + 34, 0, true); dv.setUint16(p + 36, 0, true);
      dv.setUint32(p + 38, 0, true); dv.setUint32(p + 42, offsets[i], true);
      out.set(names[i], p + 46); p += 46 + names[i].length;
    });
    dv.setUint32(p, 0x06054b50, true); dv.setUint16(p + 4, 0, true); dv.setUint16(p + 6, 0, true);
    dv.setUint16(p + 8, entries.length, true); dv.setUint16(p + 10, entries.length, true);
    dv.setUint32(p + 12, p - cdStart, true); dv.setUint32(p + 16, cdStart, true); dv.setUint16(p + 20, 0, true);
    return out;
  }

  /* The entries of a ZIP, in archive order: [{ name, bytes }]. STORED and DEFLATED; `inflateRaw(bytes) → bytes | Promise`
   * is injected (the page's DecompressionStream('deflate-raw'), node:zlib in the tests). Sizes and CRC-32 are checked. */
  const ZIP_ENTRY_MAX = 256 * 1048576;

  /* The browser's raw-deflate stream (Chrome 103, Firefox 113, Safari 16.4); IJ_IO_ZIP_DEFLATE when there is none. */
  async function inflateRawStream(bytes) {
    const DS = root.DecompressionStream;
    let ds = null;
    if (typeof DS === 'function') { try { ds = new DS('deflate-raw'); } catch (_) { ds = null; } }
    if (!ds) throw ijError('IJ_IO_ZIP_DEFLATE', 'no deflate-raw stream');
    const writer = ds.writable.getWriter();
    writer.write(bytes).catch(() => {});
    writer.close().catch(() => {});
    const reader = ds.readable.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      const r = await reader.read();
      if (r.done) break;
      chunks.push(r.value); total += r.value.length;
      if (total > ZIP_ENTRY_MAX) throw ijError('IJ_IO_TOO_LARGE', 'entry');
    }
    const out = new Uint8Array(total);
    let at = 0;
    for (const c of chunks) { out.set(c, at); at += c.length; }
    return out;
  }

  async function zipRead(input, o) {
    const zip = toU8(input);
    if (zip.length < 22) throw ijError('IJ_IO_ZIP_BAD', 'short');
    const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    let eocd = -1;
    for (let i = zip.length - 22, lo = Math.max(0, zip.length - 22 - 65535); i >= lo; i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw ijError('IJ_IO_ZIP_BAD', 'no end of central directory');
    const count = dv.getUint16(eocd + 10, true);
    let p = dv.getUint32(eocd + 16, true);
    if (count === 0xffff || p === 0xffffffff) throw ijError('IJ_IO_ZIP_BAD', 'zip64');
    const out = [];
    for (let k = 0; k < count; k++) {
      if (p + 46 > zip.length || dv.getUint32(p, true) !== 0x02014b50) throw ijError('IJ_IO_ZIP_BAD', 'central directory');
      const flags = dv.getUint16(p + 8, true), method = dv.getUint16(p + 10, true);
      const crc = dv.getUint32(p + 16, true), csize = dv.getUint32(p + 20, true), usize = dv.getUint32(p + 24, true);
      const nl = dv.getUint16(p + 28, true), el = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true), lho = dv.getUint32(p + 42, true);
      if (p + 46 + nl > zip.length) throw ijError('IJ_IO_ZIP_BAD', 'name');
      const rawName = zip.subarray(p + 46, p + 46 + nl);
      const name = (flags & 0x0800) ? new TextDecoder('utf-8').decode(rawName) : String.fromCharCode.apply(null, Array.from(rawName));
      p += 46 + nl + el + cl;
      if (flags & 1) throw ijError('IJ_IO_ZIP_BAD', 'encrypted');
      if (name.endsWith('/')) continue;
      if (usize > ZIP_ENTRY_MAX) throw ijError('IJ_IO_TOO_LARGE', 'entry');
      if (lho + 30 > zip.length || dv.getUint32(lho, true) !== 0x04034b50) throw ijError('IJ_IO_ZIP_BAD', 'local header');
      const ds = lho + 30 + dv.getUint16(lho + 26, true) + dv.getUint16(lho + 28, true);
      if (ds + csize > zip.length) throw ijError('IJ_IO_ZIP_BAD', 'data');
      const data = zip.subarray(ds, ds + csize);
      let bytes;
      if (method === 0) bytes = data.slice();
      else if (method === 8) {
        bytes = toU8(await ((o && typeof o.inflateRaw === 'function') ? o.inflateRaw(data) : inflateRawStream(data)));
      } else throw ijError('IJ_IO_ZIP_BAD', 'method ' + method);
      if (bytes.length !== usize || crc32(bytes) !== crc) throw ijError('IJ_IO_ZIP_BAD', 'checksum');
      out.push({ name, bytes });
    }
    return out;
  }

  // ====================================================================================== IJRoiCodec
  const IJRoiCodec = (() => {
    const VERSION = 228, HEADER = 64, HEADER2 = 64;
    // RoiDecoder offsets
    const O = { TYPE: 6, TOP: 8, LEFT: 10, BOTTOM: 12, RIGHT: 14, N: 16, X1: 18, Y1: 22, X2: 26, Y2: 30, SIZE: 18, STROKE_WIDTH: 34, SHAPE: 36,
      STROKE_COLOR: 40, FILL_COLOR: 44, SUBTYPE: 48, OPTIONS: 50, FLOAT_PARAM: 52, POINT_TYPE: 52, ARC: 54, POSITION: 56, HDR2: 60 };
    const H2 = { C: 4, Z: 8, T: 12, NAME_OFFSET: 16, NAME_LENGTH: 20, GROUP: 30, IMAGE_SIZE: 32, FLOAT_STROKE_WIDTH: 36, COUNTERS: 48 };
    const OPT = { SUB_PIXEL: 128, SCALE_STROKE_WIDTH: 8192 };
    const T = { polygon: 0, rect: 1, oval: 2, line: 3, freeline: 4, polyline: 5, freehand: 7, traced: 8, angle: 9, point: 10 };
    const SUB = { TEXT: 1, ARROW: 2, ELLIPSE: 3, IMAGE: 4, ROTATED_RECT: 5 };
    const FILL_FLATNESS = 0.01, FLATNESS = 0.1;

    // ---- big-endian primitives over a Uint8Array
    const putShort = (dv, o, v) => dv.setUint16(o, v & 0xffff, false);
    const putInt = (dv, o, v) => dv.setInt32(o, v | 0, false);
    const putFloat = (dv, o, v) => dv.setFloat32(o, v, false);

    const trunc = Math.trunc;
    const allInt = (a) => a.every((v) => Number.isInteger(v));

    // ---- colours: '#rrggbb' / '#rrggbbaa' <-> Java's ARGB int
    function argbOf(css, withAlpha) {
      if (typeof css !== 'string') return 0;
      const m = /^#([0-9a-fA-F]{6})([0-9a-fA-F]{2})?$/.exec(css);
      if (!m) return 0;
      const rgb = parseInt(m[1], 16);
      const a = withAlpha && m[2] ? parseInt(m[2], 16) : 255;
      return ((a << 24) | rgb) | 0;
    }
    const hex2 = (v) => (v & 255).toString(16).padStart(2, '0');
    const strokeOf = (argb) => '#' + hex2(argb >> 16) + hex2(argb >> 8) + hex2(argb);
    const fillOf = (argb) => '#' + hex2(argb >> 16) + hex2(argb >> 8) + hex2(argb) + hex2(argb >>> 24);

    // ---- ImageJ's integer bounds
    /* Roi.setIntBounds(Rectangle2D.Double): a line / point keeps the pixels `draw` touches, an area encloses its box. */
    function intBounds(bx, by, bw, bh, lineConvention) {
      if (lineConvention) {
        const x = Math.floor(bx + 0.5), y = Math.floor(by + 0.5);
        return { x, y, w: Math.floor(bx + bw + 1.5) - x, h: Math.floor(by + bh + 1.5) - y };
      }
      const x = Math.floor(bx), y = Math.floor(by);
      return { x, y, w: Math.ceil(bx + bw) - x, h: Math.ceil(by + bh) - y };
    }

    // ---- composite (ShapeRoi) paths
    const SEG = { MOVE: 0, LINE: 1, QUAD: 2, CUBIC: 3, CLOSE: 4 };
    const SEG_COORDS = [2, 2, 4, 6, 0];

    // The textbook distance from a point to a segment (clamped projection): used by the flatness test of a curve.
    function segDistSq(x1, y1, x2, y2, px, py) {
      const dx = x2 - x1, dy = y2 - y1, len2 = dx * dx + dy * dy;
      let t = len2 > 0 ? ((px - x1) * dx + (py - y1) * dy) / len2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const ex = x1 + t * dx - px, ey = y1 + t * dy - py;
      return ex * ex + ey * ey;
    }

    /* Subdivides a Bézier (control points `c`, 4 or 3 points) until each leaf is flatter than `flatness` (depth ≤ 10) and
     * appends the end point of every leaf to `out`: java.awt.geom.FlatteningPathIterator's left-first order. */
    function flattenCurve(c, flatness, out) {
      const sq = flatness * flatness;
      const rec = (p, level) => {
        const n = p.length;
        let flat;
        if (n === 4) flat = Math.max(segDistSq(p[0][0], p[0][1], p[3][0], p[3][1], p[1][0], p[1][1]), segDistSq(p[0][0], p[0][1], p[3][0], p[3][1], p[2][0], p[2][1]));
        else flat = segDistSq(p[0][0], p[0][1], p[2][0], p[2][1], p[1][0], p[1][1]);
        if (level < 10 && flat >= sq) {
          if (n === 4) {
            const m = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
            const p01 = m(p[0], p[1]), p12 = m(p[1], p[2]), p23 = m(p[2], p[3]), a = m(p01, p12), b = m(p12, p23), mid = m(a, b);
            rec([p[0], p01, a, mid], level + 1); rec([mid, b, p23, p[3]], level + 1);
          } else {
            const m = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
            const p01 = m(p[0], p[1]), p12 = m(p[1], p[2]), mid = m(p01, p12);
            rec([p[0], p01, mid], level + 1); rec([mid, p12, p[2]], level + 1);
          }
        } else out.push([p[n - 1][0], p[n - 1][1]]);
      };
      rec(c, 0);
    }

    /* The subpaths of a shape array as closed vertex loops (curves flattened). */
    function shapeLoops(arr, flatness) {
      const loops = [];
      let cur = null, last = null;
      for (let i = 0; i < arr.length;) {
        const type = arr[i];
        if (!(type >= 0 && type <= 4) || !Number.isInteger(type)) throw ijError('IJ_IO_BAD_ROI', 'segment type');
        const nc = SEG_COORDS[type];
        if (i + 1 + nc > arr.length) break;
        const c = arr.slice(i + 1, i + 1 + nc);
        i += 1 + nc;
        if (type === SEG.MOVE) { cur = [[c[0], c[1]]]; loops.push(cur); last = [c[0], c[1]]; }
        else if (type === SEG.LINE) { if (!cur) continue; cur.push([c[0], c[1]]); last = [c[0], c[1]]; }
        else if (type === SEG.QUAD) { if (!cur) continue; flattenCurve([last, [c[0], c[1]], [c[2], c[3]]], flatness, cur); last = [c[2], c[3]]; }
        else if (type === SEG.CUBIC) { if (!cur) continue; flattenCurve([last, [c[0], c[1]], [c[2], c[3]], [c[4], c[5]]], flatness, cur); last = [c[4], c[5]]; }
        else if (type === SEG.CLOSE) { cur = null; }
      }
      return loops.filter((l) => l.length >= 3);
    }

    /* The mask ROI of closed loops: the even-odd union (ShapeRoi fills the flattened outline with the PolygonFiller; the
     * parity of the crossings of every subpath together is the XOR of the fills of each). */
    function maskOfLoops(loops) {
      if (!loops.length) return { type: 'mask', x: 0, y: 0, w: 0, h: 0, rle: new Uint32Array(0) };
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const l of loops) for (const p of l) { if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0]; if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1]; }
      const bx = Math.floor(x0), by = Math.floor(y0), W = Math.ceil(x1) - bx, H = Math.ceil(y1) - by;
      if (W * H > 268435456) throw ijError('IJ_ROI_TOO_COMPLEX', 'composite too large');
      const canvas = new Uint8Array(Math.max(0, W * H));
      for (const l of loops) {
        const m = root.IJRoi.mask({ type: 'polygon', points: l });
        for (let j = 0; j < m.h; j++) for (let i = 0; i < m.w; i++) if (m.data[j * m.w + i]) canvas[(m.y - by + j) * W + (m.x - bx + i)] ^= 1;
      }
      const r = root.IJRoi.fromMask(canvas, W, H);
      return r.w ? root.IJRoi.translate(r, bx, by) : r;
    }

    // ================================================================ encode
    function normStyle(roi, style) {
      const st = style || {};
      const name = typeof st.name === 'string' ? st.name : (typeof roi.name === 'string' ? roi.name : '');
      let width = 0;
      if (finite(st.width) && st.width > 0) width = st.width;
      else if ((roi.type === 'line' || roi.type === 'polyline') && finite(roi.width) && roi.width > 1) width = roi.width;
      const pos = st.position && typeof st.position === 'object' ? st.position : null;
      return {
        name, width,
        stroke: argbOf(st.stroke, false), fill: argbOf(st.fill, true),
        c: pos && isInt(pos.c) ? pos.c : 0, z: pos && isInt(pos.z) ? pos.z : 0, t: pos && isInt(pos.t) ? pos.t : 0,
        // Roi.getPosition(): the stack slice of a plain stack (Roi.setPosition(int)); a hyperstack position is c / z / t and leaves it 0
        n: pos && isInt(pos.n) && pos.n > 0 ? pos.n : 0
      };
    }

    /* Writes the 64 + 64 byte headers and the tail every ROI shares (RoiEncoder.saveStrokeWidthAndColor, putHeader2,
     * putName, saveOverlayOptions). `cfg` = { type, bounds:{x,y,w,h}, st, dataBytes (coordinates between the headers),
     * counters (n) | 0, options, hdr2Offset }. → { data, dv } */
    function frame(cfg) {
      const st = cfg.st;
      const nameChars = st.name.length;
      const nameBytes = nameChars * 2;
      const counters = cfg.counters || 0;
      const total = HEADER + HEADER2 + cfg.dataBytes + nameBytes + counters * 4;
      const data = new Uint8Array(total), dv = new DataView(data.buffer);
      data[0] = 73; data[1] = 111; data[2] = 117; data[3] = 116;
      putShort(dv, 4, VERSION);
      data[O.TYPE] = cfg.type;
      const b = cfg.bounds;
      putShort(dv, O.TOP, b.y); putShort(dv, O.LEFT, b.x); putShort(dv, O.BOTTOM, b.y + b.h); putShort(dv, O.RIGHT, b.x + b.w);
      let options = cfg.options | 0;
      if (st.width > 0) { options |= OPT.SCALE_STROKE_WIDTH; putShort(dv, O.STROKE_WIDTH, trunc(st.width)); }
      if (st.stroke) putInt(dv, O.STROKE_COLOR, st.stroke);
      if (st.fill) putInt(dv, O.FILL_COLOR, st.fill);
      putShort(dv, O.OPTIONS, options);
      if (st.n > 0) putInt(dv, O.POSITION, st.n);
      const h2 = HEADER + cfg.dataBytes;
      putInt(dv, O.HDR2, h2);
      putInt(dv, h2 + H2.C, st.c); putInt(dv, h2 + H2.Z, st.z); putInt(dv, h2 + H2.T, st.t);
      if (nameBytes) {
        const off = h2 + HEADER2;
        putInt(dv, h2 + H2.NAME_OFFSET, off); putInt(dv, h2 + H2.NAME_LENGTH, nameChars);
        for (let i = 0; i < nameChars; i++) putShort(dv, off + i * 2, st.name.charCodeAt(i));
      }
      putFloat(dv, h2 + H2.FLOAT_STROKE_WIDTH, st.width > 0 ? st.width : 0);
      if (counters) {
        const off = h2 + HEADER2 + nameBytes;
        putInt(dv, h2 + H2.COUNTERS, off);
        // the counter of every point is 0 (a PointRoi outside the multi-point tool): written as RoiEncoder does
      }
      return { data, dv };
    }

    function encodeShape(loops, st) {
      const arr = [];
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const l of loops) {
        l.forEach((p, i) => { arr.push(i === 0 ? SEG.MOVE : SEG.LINE, p[0], p[1]); if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0]; if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1]; });
        arr.push(SEG.CLOSE);
      }
      const bx = Math.floor(x0), by = Math.floor(y0);
      const f = frame({ type: T.rect, bounds: { x: bx, y: by, w: Math.ceil(x1) - bx, h: Math.ceil(y1) - by }, st, dataBytes: arr.length * 4, options: 0 });
      putInt(f.dv, O.SHAPE, arr.length);
      for (let i = 0; i < arr.length; i++) putFloat(f.dv, HEADER + i * 4, arr[i]);
      return f.data;
    }

    function encode(roi, style) {
      root.IJRoi.validate(roi);
      const st = normStyle(roi, style);
      if (st.name.length > 255) st.name = st.name.slice(0, 255);
      switch (roi.type) {
        case 'rect': case 'oval': {
          const integer = allInt([roi.x, roi.y, roi.w, roi.h]);
          const big = Math.abs(roi.x) > 60000 || Math.abs(roi.y) > 60000 || roi.w > 60000 || roi.h > 60000;
          const sub = !integer || big;
          const b = sub
            ? { x: trunc(roi.x), y: trunc(roi.y), w: Math.max(1, Math.ceil(roi.w)), h: Math.max(1, Math.ceil(roi.h)) }
            : { x: roi.x, y: roi.y, w: Math.max(1, roi.w), h: Math.max(1, roi.h) };
          const f = frame({ type: roi.type === 'rect' ? T.rect : T.oval, bounds: b, st, dataBytes: 0, options: sub ? OPT.SUB_PIXEL : 0 });
          if (sub) { putFloat(f.dv, O.X1, roi.x); putFloat(f.dv, O.Y1, roi.y); putFloat(f.dv, O.X1 + 8, roi.w); putFloat(f.dv, O.Y1 + 8, roi.h); }
          if (roi.type === 'rect' && isInt(roi.arc) && roi.arc > 0) putShort(f.dv, O.ARC, roi.arc);
          return f.data;
        }
        case 'line': {
          const bb = intBounds(Math.min(roi.x1, roi.x2), Math.min(roi.y1, roi.y2), Math.abs(roi.x2 - roi.x1), Math.abs(roi.y2 - roi.y1), true);
          const f = frame({ type: T.line, bounds: bb, st, dataBytes: 0, options: 0 });
          putFloat(f.dv, O.X1, roi.x1); putFloat(f.dv, O.Y1, roi.y1); putFloat(f.dv, O.X2, roi.x2); putFloat(f.dv, O.Y2, roi.y2);
          return f.data;
        }
        case 'mask': {
          if (!(roi.w > 0 && roi.h > 0) || !root.IJRoi.area(roi)) throw ijError('IJ_EMPTY_ROI', 'empty mask');
          const loops = root.IJRoi.outlines(roi).filter((l) => l.length >= 3);
          if (loops.length === 1) return encode({ type: 'polygon', points: loops[0], traced: true, name: roi.name }, style);
          return encodeShape(loops, st);
        }
        default: break;
      }
      // polygon, freehand, traced polygon, polyline, angle, point
      const kind = roi.type === 'polygon' ? (roi.traced ? 'traced' : 'polygon') : roi.type;
      const type = T[kind];
      const n0 = roi.points.length;
      const isPoint = roi.type === 'point';
      if (n0 > 65535 && !isPoint && (kind === 'polygon' || kind === 'freehand' || kind === 'traced')) return encodeShape([roi.points.map((p) => [p[0], p[1]])], st);
      const n = (n0 > 65535 && !isPoint) ? 65535 : n0;
      const pts = roi.points;
      const lineConv = roi.type === 'polyline' || roi.type === 'angle' || isPoint;
      const sub = isPoint || !allInt(pts.slice(0, n).flat());
      let bounds, xs = new Array(n), ys = new Array(n), xf = null, yf = null;
      if (!sub) {
        let mnx = Infinity, mny = Infinity, mxx = -Infinity, mxy = -Infinity;
        for (let i = 0; i < n; i++) { const p = pts[i]; if (p[0] < mnx) mnx = p[0]; if (p[0] > mxx) mxx = p[0]; if (p[1] < mny) mny = p[1]; if (p[1] > mxy) mxy = p[1]; }
        // java.awt.Polygon.getBounds; an open line keeps the pixels `draw` touches (finishPolygon: width++, height++)
        bounds = { x: mnx, y: mny, w: mxx - mnx + (lineConv ? 1 : 0), h: mxy - mny + (lineConv ? 1 : 0) };
        for (let i = 0; i < n; i++) { xs[i] = pts[i][0] - mnx; ys[i] = pts[i][1] - mny; }
      } else {
        // PolygonRoi(float[]...): coordinates stored as float relative to the float bounds, then rounded for the integer table
        let mnx = Infinity, mny = Infinity, mxx = -Infinity, mxy = -Infinity;
        const fx = new Array(n), fy = new Array(n);
        for (let i = 0; i < n; i++) {
          fx[i] = F32(pts[i][0]); fy[i] = F32(pts[i][1]);
          if (fx[i] < mnx) mnx = fx[i]; if (fx[i] > mxx) mxx = fx[i]; if (fy[i] < mny) mny = fy[i]; if (fy[i] > mxy) mxy = fy[i];
        }
        const bx = mnx, by = mny, bw = F32(mxx - mnx), bh = F32(mxy - mny);
        bounds = intBounds(bx, by, bw, bh, lineConv);
        xf = new Array(n); yf = new Array(n);
        for (let i = 0; i < n; i++) {
          const rx = F32(fx[i] - F32(bx)), ry = F32(fy[i] - F32(by));
          xs[i] = Math.floor(rx + 0.5); ys[i] = Math.floor(ry + 0.5);
          xf[i] = F32(rx + F32(bx)); yf[i] = F32(ry + F32(by));
        }
      }
      const floatBytes = sub ? n * 8 : 0;
      const f = frame({ type, bounds, st, dataBytes: n * 4 + floatBytes, options: sub ? OPT.SUB_PIXEL : 0, counters: isPoint ? n : 0 });
      const { dv } = f;
      if (isPoint && n > 65535) putInt(dv, O.SIZE, n); else putShort(dv, O.N, n);
      if (isPoint) { dv.setUint8(O.POINT_TYPE, 0); putShort(dv, O.STROKE_WIDTH, 1); }
      const b1 = HEADER, b2 = HEADER + 2 * n;
      for (let i = 0; i < n; i++) { putShort(dv, b1 + i * 2, xs[i]); putShort(dv, b2 + i * 2, ys[i]); }
      if (sub) {
        const c1 = HEADER + 4 * n, c2 = c1 + 4 * n;
        for (let i = 0; i < n; i++) { putFloat(dv, c1 + i * 4, xf[i]); putFloat(dv, c2 + i * 4, yf[i]); }
      }
      return f.data;
    }

    // ================================================================ decode
    function decodeEntry(input, o) {
      const data = toU8(input);
      const size = data.length;
      if (size < HEADER || data[0] !== 73 || data[1] !== 111) throw ijError('IJ_IO_BAD_ROI', 'not an ImageJ ROI');
      const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
      // RoiDecoder.getShort: a signed short, read as unsigned when it would be below -5000
      const getShort = (b) => { const v = dv.getInt16(b, false); return v < -5000 ? dv.getUint16(b, false) : v; };
      const getInt = (b) => dv.getInt32(b, false);
      const getFloat = (b) => dv.getFloat32(b, false);
      const version = getShort(4), type = data[O.TYPE], subtype = getShort(O.SUBTYPE);
      const top = getShort(O.TOP), left = getShort(O.LEFT), bottom = getShort(O.BOTTOM), right = getShort(O.RIGHT);
      const width = right - left, height = bottom - top;
      let n = dv.getUint16(O.N, false);
      if (n === 0) n = getInt(O.SIZE);
      const options = getShort(O.OPTIONS);
      const hdr2 = getInt(O.HDR2);
      const subPixel = (options & OPT.SUB_PIXEL) !== 0 && version >= 222;
      const subRect = version >= 223 && subPixel && (type === T.rect || type === T.oval);
      let channel = 0, slice = 0, frameT = 0;
      const stackN = size >= O.POSITION + 4 ? getInt(O.POSITION) : 0;
      if (hdr2 > 0 && hdr2 + H2.IMAGE_SIZE + 4 <= size) { channel = getInt(hdr2 + H2.C); slice = getInt(hdr2 + H2.Z); frameT = getInt(hdr2 + H2.T); }
      const need = (end) => { if (end > size) throw ijError('IJ_IO_BAD_ROI', 'truncated'); };

      // name, stroke, fill
      let name = o && typeof o.fileName === 'string' ? o.fileName.replace(/\.roi$/i, '') : null;
      if (hdr2 > 0 && hdr2 + 24 <= size) {
        const off = getInt(hdr2 + H2.NAME_OFFSET), len = getInt(hdr2 + H2.NAME_LENGTH);
        if (off !== 0 && len > 0 && off + len * 2 <= size && off >= 0) {
          let s = '';
          for (let i = 0; i < len; i++) s += String.fromCharCode(dv.getUint16(off + i * 2, false));
          name = s;
        }
      }
      let width2 = 0;
      if (version >= 218) {
        width2 = getShort(O.STROKE_WIDTH);
        if (hdr2 > 0 && hdr2 + H2.FLOAT_STROKE_WIDTH + 4 <= size) { const w = getFloat(hdr2 + H2.FLOAT_STROKE_WIDTH); if (w > 0) width2 = w; }
        if (!(width2 > 0) || type === T.point) width2 = 0;     // a PointRoi: setStrokeWidth(0)
      }
      const fillArgb = version >= 218 ? getInt(O.FILL_COLOR) : 0, strokeArgb = version >= 218 ? getInt(O.STROKE_COLOR) : 0;

      let roi = null;
      if (getInt(O.SHAPE) > 0) {
        // ShapeRoi: type must be rect; the float array of path segments (RoiDecoder.getShapeRoi)
        if (type !== T.rect) throw ijError('IJ_IO_BAD_ROI', 'composite type');
        const cnt = getInt(O.SHAPE);
        need(HEADER + cnt * 4);
        const arr = new Array(cnt);
        for (let i = 0; i < cnt; i++) arr[i] = getFloat(HEADER + i * 4);
        roi = maskOfLoops(shapeLoops(arr, FILL_FLATNESS));
      } else {
        switch (type) {
          case T.rect: case T.oval: {
            const t = type === T.rect ? 'rect' : 'oval';
            if (subRect) roi = { type: t, x: getFloat(O.X1), y: getFloat(O.Y1), w: getFloat(O.X1 + 8), h: getFloat(O.Y1 + 8) };
            else roi = { type: t, x: left, y: top, w: Math.max(1, width), h: Math.max(1, height) };
            if (type === T.rect) { const arc = getShort(O.ARC); if (arc > 0) roi.arc = arc; }
            break;
          }
          case T.line:
            roi = { type: 'line', x1: getFloat(O.X1), y1: getFloat(O.Y1), x2: getFloat(O.X2), y2: getFloat(O.Y2) };
            break;
          case T.polygon: case T.freehand: case T.traced: case T.polyline: case T.freeline: case T.angle: case T.point: {
            if (!(n > 0)) throw ijError('IJ_IO_BAD_ROI', 'no coordinates');
            const pts = new Array(n);
            if (subPixel) {
              need(HEADER + 8 * n);
              const b1 = HEADER + 4 * n, b2 = b1 + 4 * n;
              need(b2 + 4 * n);
              for (let i = 0; i < n; i++) pts[i] = [getFloat(b1 + i * 4), getFloat(b2 + i * 4)];
            } else {
              const b1 = HEADER, b2 = b1 + 2 * n;
              need(b2 + 2 * n);
              for (let i = 0; i < n; i++) {
                let xt = getShort(b1 + i * 2), yt = getShort(b2 + i * 2);
                if (xt < 0) xt = 0; if (yt < 0) yt = 0;
                pts[i] = [left + xt, top + yt];
              }
            }
            if (type === T.point) roi = { type: 'point', points: pts };
            else if (type === T.polygon) roi = { type: 'polygon', points: pts };
            else if (type === T.traced) roi = { type: 'polygon', points: pts, traced: true };
            else if (type === T.freehand) roi = { type: 'freehand', points: pts };       // an EllipseRoi / RotatedRectRoi keeps its stored vertices
            else if (type === T.angle) { if (n !== 3) throw ijError('IJ_IO_BAD_ROI', 'angle'); roi = { type: 'angle', points: pts }; }
            else { if (n < 2) throw ijError('IJ_IO_BAD_ROI', 'polyline'); roi = { type: 'polyline', points: pts }; }
            if (subtype === SUB.ROTATED_RECT && type === T.polygon) roi = { type: 'polygon', points: pts };
            break;
          }
          default: throw ijError('IJ_IO_BAD_ROI', 'ROI type ' + type);
        }
        if (width2 > 0 && (roi.type === 'line' || roi.type === 'polyline')) roi.width = width2;
      }
      if (typeof name === 'string' && name.length) roi.name = name.slice(0, 255);
      root.IJRoi.validate(roi);
      return {
        roi, name: typeof name === 'string' ? name : '',
        stroke: strokeArgb ? strokeOf(strokeArgb) : null, fill: fillArgb ? fillOf(fillArgb) : null,
        width: width2 > 0 && roi.type !== 'line' && roi.type !== 'polyline' ? width2 : (roi.width || 0),
        position: (channel > 0 || slice > 0 || frameT > 0 || stackN > 0) ? (stackN > 0 && !(channel > 0 || slice > 0 || frameT > 0) ? { c: 0, z: 0, t: 0, n: stackN } : { c: channel, z: slice, t: frameT }) : null
      };
    }
    function decode(bytes, o) { return decodeEntry(bytes, o).roi; }

    // ================================================================ RoiSet
    /* RoiManager.getUniqueName: a name already used by another entry gets "-1", "-2" … (a trailing "-nnn" of at most 3
     * characters is replaced), until nobody else has it. */
    function uniqueName(names, index) {
      let name = names[index], n = 1;
      const other = (nm) => { for (let i = 0; i < names.length; i++) if (i !== index && names[i] === nm) return true; return false; };
      while (other(name)) {
        const dash = name.lastIndexOf('-');
        if (dash !== -1 && name.length - dash < 5) name = name.substring(0, dash);
        name = name + '-' + n; n++;
      }
      names[index] = name;
      return name;
    }

    /* entries = [{ roi, name, stroke?, fill?, width?, position? }] → the ZIP RoiManager.saveMultiple writes ('<name>.roi'). */
    function encodeSet(entries) {
      const names = entries.map((e) => (typeof e.name === 'string' && e.name ? e.name : (e.roi && e.roi.name) || 'roi'));
      const used = new Set();
      const list = entries.map((e, i) => {
        // RoiManager.saveMultiple: the first entry of a name keeps it; a duplicate ZipException makes getUniqueName pick another
        let label = /\.roi$/.test(names[i]) ? names[i] : names[i] + '.roi';
        if (used.has(label)) { label = uniqueName(names, i); if (!/\.roi$/.test(label)) label += '.roi'; }
        while (used.has(label)) label = label.replace(/\.roi$/, '') + '-x.roi';
        used.add(label);
        return { name: label, bytes: encode(e.roi, { name: e.name, stroke: e.stroke, fill: e.fill, width: e.width, position: e.position }) };
      });
      return zipStore(list);
    }

    async function decodeSet(zip, o) {
      const entries = await zipRead(zip, o);
      const out = [];
      for (const e of entries) {
        // RoiManager.openZip: "if (name.endsWith(".roi"))" (case-sensitive) and the list label is "name.substring(0, name.length()-4)";
        // the name in the ROI's own header stays on the selection (d.name), the label is what the list shows
        if (!e.name.endsWith('.roi')) continue;
        const d = decodeEntry(e.bytes, { fileName: e.name.replace(/^.*\//, '') });
        out.push(Object.assign(d, { label: e.name.substring(0, e.name.length - 4) }));
      }
      if (!out.length) throw ijError('IJ_IO_ZIP_NO_ROI', 'no .roi files');
      return out;
    }

    // ================================================================ the vertices XYWriter prints
    const scaled = (cal) => !!cal && !(cal.pixelWidth === 1 && cal.pixelHeight === 1 && (!cal.unit || /^(px|pixel|pixels)$/i.test(cal.unit)));

    /* OvalRoi.getPolygon(): the Wand's outline of the oval mask (autoOutline(width/2, height/2, 255, 255), 8-connected
     * legacy mode), vertices where the direction changes, starting from the right of the box and walking up. */
    function ovalPolygon(x, y, w, h) {
      const mask = new Uint8Array(w * h);
      let a = w / 2, b = h / 2;
      const a2 = a * a, b2 = b * b;
      a -= 0.5; b -= 0.5;
      for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) { const xx = i - a, yy = j - b; if (xx * xx / a2 + yy * yy / b2 <= 1.0) mask[j * w + i] = 1; }
      const inside = (px, py) => px >= 0 && px < w && py >= 0 && py < h && mask[py * w + px] === 1;
      const dirInside = (px, py, d) => {
        switch (d & 3) { case 0: return inside(px, py); case 1: return inside(px, py - 1); case 2: return inside(px - 1, py - 1); default: return inside(px - 1, py); }
      };
      let sx = Math.floor(w / 2); const sy = Math.floor(h / 2);
      if (!inside(sx, sy)) return [];
      do { sx++; } while (inside(sx, sy));
      const startDirection = inside(sx, sy) ? 1 : 3;
      let px = sx, py = sy;
      if (startDirection === 3) py++;
      let direction = startDirection;
      const pts = [];
      do {
        let nd = direction + 1;
        do { if (dirInside(px, py, nd)) break; nd--; } while (nd >= direction);
        if (nd !== direction) pts.push([px + x, py + y]);
        switch (nd & 3) { case 0: px++; break; case 1: py--; break; case 2: px--; break; default: py++; }
        direction = nd;
      } while (px !== sx || py !== sy || (direction & 3) !== startDirection);
      if (!pts.length || pts[0][0] !== px + x) pts.push([px + x, py + y]);
      return pts;
    }

    /* OvalRoi.getFloatPolygon(): the ellipse of the integer bounds, grown by 0.0004 per side, flattened (ShapeRoi, flatness
     * 0.1) with the control points held as floats. */
    function ovalFloatPolygon(roi) {
      const ix = trunc(roi.x), iy = trunc(roi.y), iw = Math.max(1, Math.ceil(roi.w)), ih = Math.max(1, Math.ceil(roi.h));
      const x0 = ix - 0.0004, y0 = iy - 0.0004, w0 = iw + 0.0008, h0 = ih + 0.0008;
      const C = 0.5522847498307933, pcv = 0.5 + C * 0.5, ncv = 0.5 - C * 0.5;
      const ctrl = [[1.0, pcv, pcv, 1.0, 0.5, 1.0], [ncv, 1.0, 0.0, pcv, 0.0, 0.5], [0.0, ncv, ncv, 0.0, 0.5, 0.0], [pcv, 0.0, 1.0, ncv, 1.0, 0.5]];
      const bx = Math.floor(x0), by = Math.floor(y0);
      const P = (cx, cy) => [F32(x0 + cx * w0 - bx), F32(y0 + cy * h0 - by)];
      let cur = P(1.0, 0.5);
      const start = cur;
      const out = [cur];
      for (const c of ctrl) {
        const p1 = P(c[0], c[1]), p2 = P(c[2], c[3]), p3 = P(c[4], c[5]);
        const leaf = [];
        flattenCurve([cur, p1, p2, p3], FLATNESS, leaf);
        for (const q of leaf) out.push([F32(q[0]), F32(q[1])]);
        cur = p3;
      }
      if (out.length > 1 && out[out.length - 1][0] === start[0] && out[out.length - 1][1] === start[1]) out.pop();
      return out.map((p) => [F32(F32(p[0]) + F32(bx)), F32(F32(p[1]) + F32(by))]);
    }

    /* The vertices Roi.getPolygon() / getFloatPolygon() give XYWriter: { points, sub } — `sub` = the ROI has subpixel
     * resolution (printed with 4 decimals). */
    function xyPolygon(roi) {
      switch (roi.type) {
        case 'rect': {
          const sub = !allInt([roi.x, roi.y, roi.w, roi.h]);
          const w = Math.max(sub ? 0 : 1, roi.w), h = Math.max(sub ? 0 : 1, roi.h);
          return { sub, points: [[roi.x, roi.y], [roi.x + w, roi.y], [roi.x + w, roi.y + h], [roi.x, roi.y + h]] };
        }
        case 'oval': {
          if (allInt([roi.x, roi.y, roi.w, roi.h])) return { sub: false, points: ovalPolygon(roi.x, roi.y, Math.max(1, roi.w), Math.max(1, roi.h)) };
          return { sub: true, points: ovalFloatPolygon(roi) };
        }
        case 'line': {
          if (!(roi.width > 1)) return { sub: true, points: [[roi.x1, roi.y1], [roi.x2, roi.y2]] };
          // Line.getFloatPolygon(strokeWidth): the rectangle of the wide line, with the 0.5 pixel shift of the area convention
          const sw = roi.width;
          let dx = roi.x2 - roi.x1, dy = roi.y2 - roi.y1;
          const len = Math.sqrt(dx * dx + dy * dy);
          dx *= 0.5 / len; dy *= 0.5 / len;
          return {
            sub: true,
            points: [
              [roi.x1 + 0.5 - dx + dy * sw, roi.y1 + 0.5 - dy - dx * sw], [roi.x1 + 0.5 - dx - dy * sw, roi.y1 + 0.5 - dy + dx * sw],
              [roi.x2 + 0.5 + dx - dy * sw, roi.y2 + 0.5 + dy + dx * sw], [roi.x2 + 0.5 + dx + dy * sw, roi.y2 + 0.5 + dy - dx * sw]
            ]
          };
        }
        case 'point': return { sub: true, points: roi.points.map((p) => [p[0], p[1]]) };
        case 'polygon': case 'freehand': case 'polyline': case 'angle':
          return { sub: !allInt(roi.points.flat()), points: roi.points.map((p) => [p[0], p[1]]) };
        case 'mask': {
          // Known difference: the vertices are those of IJRoi.outlines (same outline, same pixels); the START vertex and the order of a
          // traced / composite selection may differ from ImageJ's PolygonRoi / ShapeRoi.getPolygon, so the tests compare vertex sets.
          const pts = [];
          for (const l of root.IJRoi.outlines(roi)) for (const p of l) pts.push([p[0], p[1]]);
          return { sub: false, points: pts };
        }
        default: return { sub: false, points: [] };
      }
    }

    return { encode, decode, decodeEntry, encodeSet, decodeSet, xyPolygon, scaled, uniqueName, crc32, zipStore, zipRead, inflateRaw: inflateRawStream, maskOfLoops, shapeLoops, intBounds, VERSION };
  })();

  // ====================================================================================== IJTextIo
  const IJTextIo = (() => {
    const { d2s, rtD2s, floatToString, parseDouble } = IJJava;
    const MAX_VALUES = 16 * 1000 * 1000;        // File > Save As > Text Image
    const MAX_READ_VALUES = 64 * 1000 * 1000;   // File > Import > Text Image
    const MAX_READ_BYTES = 256 * 1048576;       // one decoded string stays far below V8's string length (2^29 - 24 characters)
    const CHUNK = 1 << 20;                      // characters tokenized between two yields of the page
    const MAX_OUT_BYTES = 512 * 1048576;        // a text output the browser can still hold

    /* ij.plugin.TextReader (open(path)): a tab / comma / space separated text as a FLOAT image — there is no 8- or 16-bit
     * type rule in ImageJ's reader: TextReader.run shows the float processor as it is. The tokenizer is the StreamTokenizer
     * of countLines / read: word characters are '+' and '-'..DEL (45..127), characters >= 256 are letters; 0..42, ',' and
     * 128..255 separate; '\n', '\r' and "\r\n" end a line. `text` = a string or the file's bytes (read as UTF-8). */
    function* parseCore(input) {
      if ((typeof input === 'string' ? input.length : toU8(input).length) > MAX_READ_BYTES) throw ijError('IJ_IO_TOO_LARGE', 'text image');
      const text = typeof input === 'string' ? input : new TextDecoder('utf-8').decode(toU8(input));
      const isWord = (c) => c === 43 || (c >= 45 && c <= 127) || c >= 256;
      // a generator: it hands control back every CHUNK characters so the page can stay responsive (parseTextImageAsync)
      const tokens = function* (visit) {
        const n = text.length;
        let i = 0, next = CHUNK;
        while (i < n) {
          if (i >= next) { next = i + CHUNK; yield i / n; }
          const c = text.charCodeAt(i);
          if (isWord(c)) {
            let j = i + 1;
            while (j < n && isWord(text.charCodeAt(j))) j++;
            if (visit(1, i, j) === false) return;
            i = j;
          } else if (c === 13) { if (visit(2) === false) return; i += (i + 1 < n && text.charCodeAt(i + 1) === 10) ? 2 : 1; }
          else if (c === 10) { if (visit(2) === false) return; i++; }
          else i++;
        }
      };
      // countLines
      let lines = 0, width = 1, wordsPerLine = 0, wordsInPreviousLine = 0;
      yield* tokens((kind) => {
        if (kind === 2) {
          lines++;
          if (wordsPerLine === 0) lines--;           // empty lines are ignored
          if (lines === 1 && wordsPerLine > 0) width = wordsPerLine;
          if (lines > 1 && wordsPerLine !== 0 && wordsPerLine !== wordsInPreviousLine) throw Object.assign(ijError('IJ_IO_TEXT_RAGGED', 'line ' + lines), { line: lines });
          if (wordsPerLine !== 0) wordsInPreviousLine = wordsPerLine;
          wordsPerLine = 0;
        } else wordsPerLine++;
        return true;
      });
      if (wordsPerLine === width) lines++;          // the last line does not end with an end of line
      if (width * lines === 0) throw ijError('IJ_IO_TEXT_EMPTY', 'no numbers');
      if (width * lines > MAX_READ_VALUES) throw ijError('IJ_IO_TOO_LARGE', 'text image');
      const size = width * lines;
      const pixels = new Float32Array(size);
      let i = 0, firstTok = null;
      yield* tokens((kind, a, b) => {
        if (kind !== 1) return true;
        const s = text.slice(a, b);
        if (i === 0) firstTok = s;
        pixels[i++] = F32(parseDouble(s));
        return i < size;
      });
      let nanFirst = 0;
      for (let k = 0; k < width; k++) if (k < pixels.length && pixels[k] !== pixels[k]) nanFirst++;
      let data = pixels, height = lines;
      // "assume first row is header": an all-NaN first row that does not literally say NaN
      if (nanFirst === width && !(firstTok === 'NaN' || firstTok === 'nan')) {
        if (lines < 2) throw ijError('IJ_IO_TEXT_EMPTY', 'header only');
        data = pixels.slice(width); height = lines - 1;
      }
      return { width, height, data };
    }
    function parseTextImage(input) {
      const g = parseCore(input);
      for (;;) { const r = g.next(); if (r.done) return r.value; }
    }
    /* The same parse for the page thread: the tokenizer gives control back every CHUNK characters and this waits a task
     * whenever 30 ms went by, so a 30 MB text image never blocks the UI. */
    async function parseTextImageAsync(input) {
      const g = parseCore(input);
      let t0 = Date.now();
      for (;;) {
        const r = g.next();
        if (r.done) return r.value;
        if (Date.now() - t0 >= 30) { await new Promise((res) => setTimeout(res, 0)); t0 = Date.now(); }
      }
    }

    /* The display range of a float image after ip.resetMinAndMax(): FloatProcessor.findMinAndMax skips NaN and ±Infinity. */
    function floatRange(data) {
      let mn = Infinity, mx = -Infinity;
      for (let i = 0; i < data.length; i++) { const v = data[i]; if (v - v !== 0) continue; if (v < mn) mn = v; if (v > mx) mx = v; }
      return mn > mx ? { min: 0, max: 0 } : { min: mn, max: mx };
    }

    /* A growing ASCII output in pages of 4 MiB (a text image can hold tens of millions of numbers: one string would not fit). */
    function makeSink(limit) {
      const PAGE = 4 * 1048576;
      const pages = [];
      let cur = new Uint8Array(PAGE), at = 0, total = 0;
      return {
        put(s) {
          for (let i = 0; i < s.length; i++) {
            if (at === PAGE) { pages.push(cur); cur = new Uint8Array(PAGE); at = 0; }
            cur[at++] = s.charCodeAt(i);
          }
          total += s.length;
          if (total > limit) throw ijError('IJ_IO_TOO_LARGE', 'text output');
        },
        finish() { pages.push(cur.subarray(0, at)); return pages.filter((p) => p.length); },
        get size() { return total; }
      };
    }

    /* ij.io.TextEncoder.write: rows of tab-separated values; an uncalibrated 8 / 16-bit image prints integers, a 32-bit one
     * IJ.d2s(value, precision). The line ends are LF (ImageJ writes the platform's separator). */
    async function encodeTextImage(data, width, height, bitDepth, precision, io, delimiter) {
      if (width * height > MAX_VALUES) throw ijError('IJ_IO_TOO_LARGE', 'text image');
      const sink = makeSink(MAX_OUT_BYTES);
      const sep = delimiter || '\t';
      const intData = bitDepth !== 32;
      let sinceTick = 0;
      for (let y = 0; y < height; y++) {
        let line = '';
        for (let x = 0; x < width; x++) {
          const v = data[y * width + x];
          line += intData ? String(v) : d2s(v, precision);
          if (x !== width - 1) line += sep;
        }
        sink.put(line + '\n');
        sinceTick += width;
        if (io && sinceTick >= 65536) { sinceTick = 0; await io.tick(y / height, 'op.textImage'); }
      }
      return sink.finish();
    }

    /* XYWriter.saveXYCoordinates (the text only): one vertex per line, tab separated, IJ.d2s(v · pixel size, 4) when the ROI
     * is subpixel or the image is calibrated, integers otherwise. */
    function xyWriterText(roi, cal) {
      const poly = IJRoiCodec.xyPolygon(roi);
      const pw = (cal && cal.pixelWidth) || 1, ph = (cal && cal.pixelHeight) || 1;
      const sc = IJRoiCodec.scaled(cal);
      let out = '';
      for (const p of poly.points) {
        if (poly.sub) out += d2s(F32(p[0]) * pw, 4) + '\t' + d2s(F32(p[1]) * ph, 4) + '\n';
        else if (sc) out += d2s(p[0] * pw, 4) + '\t' + d2s(p[1] * ph, 4) + '\n';
        else out += p[0] + '\t' + p[1] + '\n';
      }
      return out;
    }

    /* The "Value" column of ImageJ's result table (ResultsTable AUTO_FORMAT, precision 3): an integer without decimals. */
    const autoFormat = (v, places) => (Number.isInteger(v) && Math.abs(v) < 2147483648 ? rtD2s(v, 0) : rtD2s(v, places === undefined ? 3 : places));

    return { parseTextImage, parseTextImageAsync, floatRange, makeSink, encodeTextImage, xyWriterText, autoFormat, floatToString, d2s, MAX_VALUES, MAX_OUT_BYTES };
  })();

  // ====================================================================================== IJFileKinds
  /* File > Open: what a file is (its extension first, then its first bytes), the errors the page raises for a file it cannot use,
   * and the image a decoded picture becomes. Pure: the page decodes the picture (createImageBitmap) and hands the RGBA over. */
  const IJFileKinds = (() => {
    const CODES = ['IJ_IO_UNKNOWN_FORMAT', 'IJ_IO_NEEDS_IMAGE', 'IJ_IO_DECODE', 'IJ_IO_TOO_LARGE'];
    function error(code) { if (CODES.indexOf(code) < 0) throw bad('error code'); return ijError(code); }
    function kindOf(name, b) {
      const ext = (/\.([A-Za-z0-9]+)$/.exec(String(name)) || [])[1];
      const e = ext ? ext.toLowerCase() : '';
      if (e === 'tif' || e === 'tiff') return 'tiff';
      if (e === 'png' || e === 'jpg' || e === 'jpeg' || e === 'gif' || e === 'bmp') return 'image';
      if (e === 'txt') return 'text';
      if (e === 'roi') return 'roi';
      if (e === 'zip') return 'zip';
      if (e === 'lut') return 'lut';
      if (b && b.length >= 4) {
        if ((b[0] === 0x49 && b[1] === 0x49 && b[2] === 42 && b[3] === 0) || (b[0] === 0x4d && b[1] === 0x4d && b[2] === 0 && b[3] === 42)) return 'tiff';
        if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image';
        if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image';
        if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'image';
        if (b[0] === 0x50 && b[1] === 0x4b && b[2] === 3 && b[3] === 4) return 'zip';
        if (b[0] === 0x49 && b[1] === 0x6f && b[2] === 0x75 && b[3] === 0x74) return 'roi';
      }
      if (b && b.length >= 2 && b[0] === 0x42 && b[1] === 0x4d) return 'image';
      return null;
    }
    /* A picture the browser decoded → an image: one grey channel when every pixel has R = G = B (ImageJ turns a grey RGB picture
     * into an 8-bit image, Opener.convertGrayJpegTo8Bits), else a 24-bit RGB image (`rgb: true`: three 8-bit planes named Red, Green,
     * Blue). The browser hands over 8 bits per channel; the alpha is ignored. */
    function imageFromRgba(rgba, w, h, name) {
      const n = w * h;
      let grey = true;
      for (let i = 0; i < n && grey; i++) if (rgba[i * 4] !== rgba[i * 4 + 1] || rgba[i * 4] !== rgba[i * 4 + 2]) grey = false;
      const calibration = { pixelWidth: 1, pixelHeight: 1, unit: 'px' };
      const plane = (k) => { const a = new Uint8Array(n); for (let i = 0; i < n; i++) a[i] = rgba[i * 4 + k]; return a; };
      if (grey) return { name, width: w, height: h, bitDepth: 8, calibration, channels: [{ data: plane(0), name: 'C1', color: '#ffffff', display: { min: 0, max: 255, lut: 'Grays', invert: false } }] };
      const rgb = [['Red', '#ff0000'], ['Green', '#00ff00'], ['Blue', '#0000ff']];
      return { name, width: w, height: h, bitDepth: 8, calibration, rgb: true, channels: rgb.map(([lut, color], k) => ({ data: plane(k), name: lut, color, display: { min: 0, max: 255, lut, invert: false } })) };
    }
    return { CODES, error, kindOf, imageFromRgba };
  })();

  // ====================================================================================== IJLocalTiff
  /* A compressed TIFF read from a file on disk (File > Open of a Download Center bundle page, or of anything an ImageJ
   * writes with deflate): 8 / 16 / 32-bit float grey or 8-bit RGB, classic TIFF, strips compressed with Adobe deflate (8) or
   * 32946, predictor 1 or 2. Every strip goes through IJTiffStream.decodeStrip (inflate, byte order, horizontal predictor).
   * The directories, the ImageJ description (channels / slices / frames, hyperstack, mode, calibration) and the metadata (labels,
   * ranges, LUTs) are read by IJTiff.parse / IJTiff.assemble — the same stack image as the uncompressed reader gives.
   * `needsDecoder(bytes)` says whether the file is one of these (else IJTiff.read / doc.open takes it). */
  const IJLocalTiff = (() => {
    const unsupported = (m) => ijError('IJ_TIFF_UNSUPPORTED', m || 'unsupported TIFF');
    const tiff = () => { const t = root.IJTiff; if (!t || typeof t.parse !== 'function') throw ijError('IJ_MODULE_MISSING', 'IJTiff'); return t; };

    /* Does the file need this reader (a compressed or predicted strip)? false for what IJTiff.read already reads;
     * throws IJ_TIFF_UNSUPPORTED when the file is neither. */
    function needsDecoder(input) {
      const bytes = toU8(input);
      const t = tiff().parse(bytes);
      return t.ifds.some((tags) => t.one(tags, 259, 1) !== 1 || t.one(tags, 317, 1) !== 1);
    }

    async function read(input, name, o) {
      const T = tiff();
      const bytes = toU8(input);
      const stream = root.IJTiffStream;
      if (!stream || typeof stream.decodeStrip !== 'function') throw ijError('IJ_MODULE_MISSING', 'IJTiffStream');
      const P = T.parse(bytes);
      const infos = P.ifds.map((tags) => T.ifdInfo(P, tags));
      const f = infos[0];
      const W = f.W, H = f.H, bd = f.bd, spp = f.spp;
      const Ctor = bd === 8 ? Uint8Array : bd === 16 ? Uint16Array : Float32Array;
      const images = [];
      for (const info of infos) {
        if (info.W !== W || info.H !== H || info.bd !== bd || info.spp !== spp) throw unsupported('mixed planes');
        if (info.compression !== 1 && info.compression !== 8 && info.compression !== 32946) throw unsupported('compression');
        if (info.predictor !== 1 && info.predictor !== 2) throw unsupported('predictor');
        const strips = info.so.length;
        // planar RGB: the strips of the three samples follow one another (spp planes of ceil(H / rps) strips)
        const split = info.planarConfig === 2 && spp === 3;
        const per = split ? strips / 3 : strips;
        if (!Number.isInteger(per) || Math.ceil(H / info.rps) !== per) throw unsupported('strip count');
        const planes = [];
        for (let s = 0; s < (split ? 3 : 1); s++) planes.push(spp === 1 || split ? new Ctor(W * H) : [new Ctor(W * H), new Ctor(W * H), new Ctor(W * H)]);
        const p = { compression: info.compression, predictor: info.predictor, bitDepth: bd, width: W, spp: split ? 1 : spp, littleEndian: P.le, float: bd === 32 };
        for (let k = 0; k < strips; k++) {
          if (o && o.check) o.check();
          const sample = split ? Math.floor(k / per) : 0, strip = split ? k % per : k;
          const rows = Math.min(info.rps, H - strip * info.rps);
          if (!(info.so[k] >= 0 && info.so[k] + info.sc[k] <= bytes.length)) throw unsupported('data out of file');
          const got = await stream.decodeStrip(p, bytes.subarray(info.so[k], info.so[k] + info.sc[k]), rows, o && o.inflate ? { inflate: o.inflate } : undefined);
          if (split) planes[sample].set(got[0], strip * info.rps * W);
          else if (spp === 1) planes[0].set(got[0], strip * info.rps * W);
          else for (let c = 0; c < 3; c++) planes[0][c].set(got[c], strip * info.rps * W);
        }
        images.push(spp === 1 ? [planes[0]] : split ? planes : planes[0]);
      }
      return T.assemble(P, images, name);
    }
    return { needsDecoder, read };
  })();

  // ====================================================================================== operations
  if (R) {
    /* roiSetOp: the selections of the ROI Manager combined as pixel masks.
     *   params { op: 'and' | 'or' | 'xor' | 'split', rois: [roi] }            → { roi } | { rois: [roi] } | { roi: null } (nothing left)
     * ImageJ combines the OUTLINES (ShapeRoi.and / or / xor, then trySimplify); here each selection is filled first and the masks
     * are combined, which gives the same pixels wherever the outlines run along pixel edges (every traced, rectangular or
     * mask selection) and the PolygonFiller's pixels for the others. A line selection is first made an area (a straight line:
     * the rectangle of its width; a polyline / angle: the union of its segments); a point is the pixel it lies in. */
    const MASK_CAP = 128 * 1000 * 1000;

    function areaOf(roi) {
      const IJRoi = root.IJRoi;
      IJRoi.validate(roi);
      if (roi.type === 'polyline' || roi.type === 'angle') {
        const w = roi.width > 1 ? roi.width : 1;
        const parts = [];
        for (let i = 1; i < roi.points.length; i++) parts.push(IJRoi.mask({ type: 'line', x1: roi.points[i - 1][0], y1: roi.points[i - 1][1], x2: roi.points[i][0], y2: roi.points[i][1], width: w }));
        return parts;
      }
      return [IJRoi.mask(roi)];
    }

    function combine(op, rois, io) {
      const IJRoi = root.IJRoi;
      // pass 1: the union box only — the masks are dropped at once, so n selections never hold n layers at the same time
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const r of rois) {
        for (const m of areaOf(r)) {
          if (!(m.w > 0 && m.h > 0)) continue;
          if (m.x < x0) x0 = m.x; if (m.y < y0) y0 = m.y; if (m.x + m.w > x1) x1 = m.x + m.w; if (m.y + m.h > y1) y1 = m.y + m.h;
        }
        if (io) io.check();
      }
      if (x0 === Infinity) return null;
      const W = x1 - x0, H = y1 - y0;
      // one accumulator + one scratch layer = 2·W·H bytes, whatever the number of selections (the declared scratchBytes)
      if (W * H > MASK_CAP) throw ijError('IJ_IO_TOO_LARGE', 'combined selection');
      const out = new Uint8Array(W * H);
      const L = new Uint8Array(W * H);
      const STEP = 1 << 22;
      // pass 2: each selection is painted into the scratch layer and folded into the accumulator at once
      rois.forEach((r, k) => {
        L.fill(0);
        for (const m of areaOf(r)) for (let j = 0; j < m.h; j++) {
          const row = (m.y - y0 + j) * W + (m.x - x0);
          for (let i = 0; i < m.w; i++) if (m.data[j * m.w + i]) L[row + i] = 1;
          if (io && (j & 255) === 255) io.check();
        }
        for (let a = 0; a < out.length; a += STEP) {
          const e = Math.min(out.length, a + STEP);
          if (k === 0) for (let i = a; i < e; i++) out[i] = L[i];
          else if (op === 'and') for (let i = a; i < e; i++) out[i] &= L[i];
          else if (op === 'or') for (let i = a; i < e; i++) out[i] |= L[i];
          else for (let i = a; i < e; i++) out[i] ^= L[i];
          if (io) io.check();
        }
      });
      const r = IJRoi.fromMask(out, W, H);
      return r.w ? IJRoi.translate(r, x0, y0) : null;
    }

    /* ShapeRoi.trySimplify / guessType for a traced loop: a closed loop of four axis-aligned long edges is a rectangle, else a
     * traced polygon. */
    function simplifyLoop(loop) {
      if (loop.length === 4) {
        const xs = loop.map((p) => p[0]), ys = loop.map((p) => p[1]);
        const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
        const rectLike = loop.every((p, i) => { const q = loop[(i + 1) % 4]; return p[0] === q[0] || p[1] === q[1]; });
        const len = 2 * ((x1 - x0) + (y1 - y0));
        if (rectLike && x1 > x0 && y1 > y0 && len / (4 * 2) >= 2) return { type: 'rect', x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
      }
      return { type: 'polygon', points: loop.map((p) => [p[0], p[1]]), traced: true };
    }
    function simplify(mask) {
      const loops = root.IJRoi.outlines(mask);
      if (loops.length === 1) return simplifyLoop(loops[0]);
      return mask;
    }

    R.define('roiSetOp', {
      kind: 'compute', version: 1, channels: 'one', roi: 'ignore', preview: false,
      validate(params) {
        if (!params || ['and', 'or', 'xor', 'split'].indexOf(params.op) < 0) throw bad('op');
        if (!Array.isArray(params.rois) || params.rois.length < 1 || params.rois.length > 100000) throw bad('rois');
        if (params.op !== 'split' && params.rois.length < 2) throw bad('rois');
        for (const r of params.rois) root.IJRoi.validate(r);
      },
      // the accumulator and one layer over the UNION box of the selections (not their sum): 2 · W · H
      scratchBytes: (info, params) => {
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const r of (params && params.rois) || []) {
          try {
            const b = root.IJRoi.bounds(r);
            const pad = r.width > 1 ? Math.ceil(r.width) : 0;
            x0 = Math.min(x0, b.x - pad); y0 = Math.min(y0, b.y - pad); x1 = Math.max(x1, b.x + b.w + pad); y1 = Math.max(y1, b.y + b.h + pad);
          } catch (_) { /* validate reports it */ }
        }
        if (x0 === Infinity) return 0;
        return Math.min((x1 - x0) * (y1 - y0), MASK_CAP) * 2;
      },
      async run(view, params, roi, io) {
        const IJRoi = root.IJRoi;
        for (const r of params.rois) IJRoi.validate(r);
        io.check();
        if (params.op === 'split') {
          const m = params.rois[0];
          if (m.type !== 'mask') throw ijError('IJ_IO_NEEDS_COMPOSITE', 'composite selection required');
          const loops = IJRoi.outlines(m);
          return { rois: loops.map((l) => simplifyLoop(l)) };
        }
        const rois = params.rois;
        if (params.op === 'or' && rois.every((r) => r.type === 'point')) {
          // RoiManager.combinePoints: one multi-point selection
          const pts = [];
          for (const r of rois) for (const p of r.points) pts.push([p[0], p[1]]);
          return { roi: { type: 'point', points: pts } };
        }
        if (params.op === 'and') {
          const pointRois = rois.filter((r) => r.type === 'point');
          if (pointRois.length === 1) {
            // "If there is one PointRoi in the list of selected Rois, the points inside all selected area rois are kept."
            const areas = rois.filter((r) => r.type !== 'point');
            if (areas.length < 1) throw bad('rois');
            const region = areas.length === 1 ? IJRoi.mask(areas[0]) : (() => { const c = combine('and', areas, io); return c ? IJRoi.mask(c) : null; })();
            const kept = region ? pointRois[0].points.filter((p) => { const i = Math.floor(p[0]) - region.x, j = Math.floor(p[1]) - region.y; return i >= 0 && j >= 0 && i < region.w && j < region.h && region.data[j * region.w + i]; }) : [];
            return kept.length ? { roi: { type: 'point', points: kept.map((p) => [p[0], p[1]]) } } : { roi: null };
          }
        }
        const out = combine(params.op, rois, io);
        return { roi: out ? simplify(out) : null };
      }
    });

    /* xyCoordinates: Analyze > Tools > Save XY Coordinates.
     *   mode 'probe'      → { background } the value of the pixel (0, 0): the dialog's default
     *   mode 'points'     params { background, invertY } → { pages: [Uint8Array], count } "x<TAB>y<TAB>value" of every pixel that is not the background
     *   mode 'selection'  the area selection (the op's roi): "X,Y,Value" as a .csv, the dialog skipped
     * XYCoordinates.java: "v!=background && !(nanBackground&&Double.isNaN(v))"; 8 / 16-bit values print as ints, 32-bit as Float.toString. */
    R.define('xyCoordinates', {
      kind: 'compute', version: 1, channels: 'one', roi: 'ignore', preview: false,
      validate(params) {
        if (!params || ['probe', 'points', 'selection'].indexOf(params.mode) < 0) throw bad('mode');
        if (params.mode === 'points') {
          if (params.background !== null && !(typeof params.background === 'number')) throw bad('background');
          if (typeof params.invertY !== 'boolean') throw bad('invertY');
        }
        if (params.precision !== undefined && !(Number.isInteger(params.precision) && params.precision >= 0 && params.precision <= 9)) throw bad('precision');
      },
      // the text output is held in pages up to MAX_OUT_BYTES: about 24 bytes a pixel of a worst-case image, refused up front
      scratchBytes: (info, params) => (params && params.mode === 'probe' ? 4096 : Math.min(IJTextIo.MAX_OUT_BYTES, info && info.width && info.height ? info.width * info.height * 24 : 8 * 1048576)),
      async run(view, params, roi, io) {
        const c = Number.isInteger(io.channel) ? io.channel : (view.active || 0);
        if (!(c >= 0 && c < view.channels.length)) throw bad('channel');
        const data = view.channels[c].data;
        const W = view.width, H = view.height, bd = view.bitDepth;
        const val = (i) => data[i];
        if (params.mode === 'probe') return { background: val(0) };
        const sink = IJTextIo.makeSink(IJTextIo.MAX_OUT_BYTES);
        let count = 0;
        if (params.mode === 'selection') {
          const IJRoi = root.IJRoi;
          if (!roi || !IJRoi.isArea(roi)) throw ijError('IJ_NEEDS_ROI', 'area selection');
          const m = IJRoi.mask(roi, W, H);
          sink.put('X,Y,Value\n');
          for (let j = 0; j < m.h; j++) {
            for (let i = 0; i < m.w; i++) {
              if (!m.data[j * m.w + i]) continue;
              const x = m.x + i, y = m.y + j;
              sink.put(x + ',' + y + ',' + IJTextIo.autoFormat(val(y * W + x), params.precision) + '\n');
              count++;
            }
            if ((j & 63) === 0) await io.tick(j / Math.max(1, m.h), 'op.xyCoordinates');
          }
          return { pages: sink.finish(), count };
        }
        const bg = params.background === null ? val(0) : params.background;
        const nanBackground = bg !== bg;
        for (let i = 0; i < H; i++) {
          const y = params.invertY ? i : H - 1 - i;
          const row = y * W;
          for (let x = 0; x < W; x++) {
            const v = val(row + x);
            if (v !== bg && !(nanBackground && v !== v)) {
              sink.put(x + '\t' + (params.invertY ? y : H - 1 - y) + '\t' + (bd === 32 ? IJJava.floatToString(v) : String(v)) + '\n');
              count++;
            }
          }
          if ((i & 63) === 0) await io.tick(i / H, 'op.xyCoordinates');
        }
        return { pages: sink.finish(), count };
      }
    });

    /* textImage: File > Save As > Text Image of the channel the request names — TextEncoder over the whole image. */
    R.define('textImage', {
      kind: 'compute', version: 1, channels: 'one', roi: 'ignore', preview: false,
      validate(params, info) {
        // FileSaver.saveAsText: Analyzer.getPrecision(), negated when Scientific notation is ticked (-9..9)
        const p = params && params.precision;
        if (!(Number.isInteger(p) && p >= -9 && p <= 9)) throw bad('precision');
        if (params.delimiter !== undefined && params.delimiter !== '\t' && params.delimiter !== ',') throw bad('delimiter');
        if (info && info.width * info.height > IJTextIo.MAX_VALUES) throw ijError('IJ_IO_TOO_LARGE', 'text image');
      },
      scratchBytes: (info) => Math.min(IJTextIo.MAX_OUT_BYTES, info && info.width && info.height ? info.width * info.height * (info.bitDepth === 32 ? 12 : 6) : 0),
      async run(view, params, roi, io) {
        const c = Number.isInteger(io.channel) ? io.channel : (view.active || 0);
        if (!(c >= 0 && c < view.channels.length)) throw bad('channel');
        const pages = await IJTextIo.encodeTextImage(view.channels[c].data, view.width, view.height, view.bitDepth, params.precision, io, params.delimiter || '\t');
        return { pages };
      }
    });
  }

  root.IJJava = IJJava;
  root.IJRoiCodec = IJRoiCodec;
  root.IJTextIo = IJTextIo;
  root.IJLocalTiff = IJLocalTiff;
  root.IJFileKinds = IJFileKinds;
})(typeof self !== 'undefined' ? self : globalThis);
