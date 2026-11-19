/* ij-core.js — pure, DOM-free image core of the Studio's Advanced view.
 *
 * Classic script that works in the page and inside a worker. Everything is
 * wrapped in one function so nothing leaks into the global lexical scope; the
 * public singletons are attached to `self` (page: window, worker: self).
 *
 *   IJImage    images, channel images, display state
 *   IJLuts     ImageJ look-up tables (256 × RGB)
 *   IJRoi      region-of-interest geometry (masks, areas, perimeters, RLE)
 *   IJOpRegistry  the operation registry both the page and the worker read (PLAN-wave2 §2.1)
 *   IJOps      statistics, histogram, contrast, conversion, maths, geometry
 *   IJProject  band-based streaming Z projector (six methods)
 *   IJTiff     ImageJ-hyperstack TIFF writer + uncompressed TIFF reader
 *
 * Conventions
 *   - A "channel image" is { width, height, bitDepth, data } with bitDepth 8
 *     (Uint8Array), 16 (Uint16Array) or 32 (Float32Array).
 *   - Pixel (i, j) covers [i, i+1) × [j, j+1) in continuous image coordinates;
 *     its centre is (i + 0.5, j + 0.5).
 *   - A "mask box" is { x, y, w, h, data } where data is a Uint8Array w·h of
 *     0 / 1 laid out row-major in the box, positioned at (x, y) of the image.
 *     `null` means "the whole image".
 *   - Errors carry a stable `code` (IJ_*); the message is never shown to users.
 */
(function (root) {
  'use strict';

  function fail(code, message) {
    const e = new Error(message || code);
    e.code = code;
    return e;
  }

  const LE = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1; // host byte order

  function typedArrayFor(bitDepth, n) {
    if (bitDepth === 8) return new Uint8Array(n);
    if (bitDepth === 16) return new Uint16Array(n);
    if (bitDepth === 32) return new Float32Array(n);
    throw fail('IJ_BAD_DEPTH', 'bit depth ' + bitDepth);
  }
  function maxValue(bitDepth) { return bitDepth === 8 ? 255 : bitDepth === 16 ? 65535 : Infinity; }
  function clampInt(v, max) { return v < 0 ? 0 : v > max ? max : v; }
  // Round half up, as ImageJ's (int)(v + 0.5) for non-negative values.
  function roundHalfUp(v) { return Math.floor(v + 0.5); }

  // ---------------------------------------------------------------- IJImage
  const IJImage = (() => {
    function bytes(img) {
      let n = 0;
      for (const c of img.channels) n += c.data.byteLength;
      return n;
    }

    /* Min / max of a pixel array. 32-bit ignores NaN and ±Infinity exactly as
     * ImageJ's findMinAndMax does. No finite value → { 0, 0 }. */
    function dataRange(data) {
      let min = Infinity, max = -Infinity;
      const n = data.length;
      if (data instanceof Float32Array) {
        for (let i = 0; i < n; i++) {
          const v = data[i];
          if (v - v !== 0) continue; // NaN, ±Infinity
          if (v < min) min = v;
          if (v > max) max = v;
        }
      } else {
        for (let i = 0; i < n; i++) {
          const v = data[i];
          if (v < min) min = v;
          if (v > max) max = v;
        }
      }
      return min > max ? { min: 0, max: 0 } : { min, max };
    }

    /* Default display of a channel: 8-bit 0–255; 16/32-bit the data range.
     * A degenerate range (blank image) falls back to 0–65535 (16) / 0–1 (32)
     * so a new empty image is not a zero-width window. */
    function defaultDisplay(ch, bitDepth) {
      const bd = bitDepth || ch.bitDepth;
      if (bd === 8) return { min: 0, max: 255, lut: 'Grays', invert: false };
      const r = dataRange(ch.data);
      let min = r.min, max = r.max;
      if (!(max > min)) { if (bd === 16) { min = 0; max = 65535; } else { min = 0; max = 1; } }
      return { min, max, lut: 'Grays', invert: false };
    }

    function create(o) {
      const width = o.width | 0, height = o.height | 0, bitDepth = o.bitDepth;
      if (!(width > 0 && height > 0)) throw fail('IJ_BAD_SIZE', 'size');
      const defs = o.channels && o.channels.length ? o.channels : [{ name: 'C1', color: '#ffffff' }];
      const cal = o.calibration || {};
      return {
        name: o.name || 'Untitled',
        width, height, bitDepth,
        channels: defs.map((d, i) => {
          const ch = { name: d.name || ('C' + (i + 1)), color: d.color || '#ffffff', data: typedArrayFor(bitDepth, width * height) };
          ch.display = defaultDisplay(ch, bitDepth);
          ch.display.lut = IJLuts.forColor(ch.color);
          return ch;
        }),
        calibration: {
          pixelWidth: cal.pixelWidth > 0 ? cal.pixelWidth : 1,
          pixelHeight: cal.pixelHeight > 0 ? cal.pixelHeight : 1,
          unit: cal.unit || 'px'
        },
        provenance: o.provenance || null
      };
    }

    function channelImage(img, c) {
      const ch = img.channels[c];
      return { width: img.width, height: img.height, bitDepth: img.bitDepth, data: ch.data };
    }

    return { create, typedArrayFor, bytes, defaultDisplay, dataRange, channelImage };
  })();

  // ---------------------------------------------------------------- IJLuts
  const IJLuts = (() => {
    const NAMES = ['Grays', 'Red', 'Green', 'Blue', 'Cyan', 'Magenta', 'Yellow', 'Fire', 'Ice', 'Spectrum', '16 Colors', 'HiLo'];
    const cache = new Map();
    // Tables an extension registered under a name of its own (api.registerLut): never one of NAMES.
    const customs = new Map();

    /* ImageJ LutLoader.interpolate: 32 control colours stretched to 256
     * entries, entry i blends control i1 = ⌊i·32/256⌋ and i2 = i1 + 1 with
     * fraction i·32/256 − i1; the (byte) cast truncates. */
    function interpolate(r, g, b) {
      const n = r.length, scale = n / 256;
      const t = new Uint8Array(768);
      for (let i = 0; i < 256; i++) {
        const i1 = Math.floor(i * scale);
        let i2 = i1 + 1;
        if (i2 === n) i2 = n - 1;
        const f = i * scale - i1;
        t[i * 3] = Math.floor((1 - f) * r[i1] + f * r[i2]);
        t[i * 3 + 1] = Math.floor((1 - f) * g[i1] + f * g[i2]);
        t[i * 3 + 2] = Math.floor((1 - f) * b[i1] + f * b[i2]);
      }
      return t;
    }

    function primary(rr, gg, bb) {
      const t = new Uint8Array(768);
      for (let i = 0; i < 256; i++) { t[i * 3] = rr ? i : 0; t[i * 3 + 1] = gg ? i : 0; t[i * 3 + 2] = bb ? i : 0; }
      return t;
    }

    // Java's Color.HSBtoRGB with single-precision arithmetic (saturation = brightness = 1).
    function hsbToRgb(hue) {
      const f32 = Math.fround;
      const h = f32(f32(hue - Math.floor(hue)) * 6);
      const f = f32(h - Math.floor(h));
      const p = 0, q = f32(1 - f), t = f32(1 - f32(1 - f));
      const c = (v) => Math.floor(f32(f32(v) * 255) + 0.5);
      switch (Math.floor(h)) {
        case 0: return [c(1), c(t), c(p)];
        case 1: return [c(q), c(1), c(p)];
        case 2: return [c(p), c(1), c(t)];
        case 3: return [c(p), c(q), c(1)];
        case 4: return [c(t), c(p), c(1)];
        default: return [c(1), c(p), c(q)];
      }
    }

    function build(name) {
      switch (name) {
        case 'Grays': return primary(1, 1, 1);
        case 'Red': return primary(1, 0, 0);
        case 'Green': return primary(0, 1, 0);
        case 'Blue': return primary(0, 0, 1);
        case 'Cyan': return primary(0, 1, 1);
        case 'Magenta': return primary(1, 0, 1);
        case 'Yellow': return primary(1, 1, 0);
        case 'Fire': return interpolate(
          [0, 0, 1, 25, 49, 73, 98, 122, 146, 162, 173, 184, 195, 207, 217, 229, 240, 252, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255],
          [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 14, 35, 57, 79, 101, 117, 133, 147, 161, 175, 190, 205, 219, 234, 248, 255, 255, 255, 255],
          [0, 61, 96, 130, 165, 192, 220, 227, 210, 181, 151, 122, 93, 64, 35, 5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 35, 98, 160, 223, 255]);
        case 'Ice': return interpolate(
          [0, 0, 0, 0, 0, 0, 19, 29, 50, 48, 79, 112, 134, 158, 186, 201, 217, 229, 242, 250, 250, 250, 250, 251, 250, 250, 250, 250, 251, 251, 243, 230],
          [156, 165, 176, 184, 190, 196, 193, 184, 171, 162, 146, 125, 107, 93, 81, 87, 92, 97, 95, 93, 93, 90, 85, 69, 64, 54, 47, 35, 19, 0, 4, 0],
          [140, 147, 158, 166, 170, 176, 209, 220, 234, 225, 236, 246, 250, 251, 250, 250, 245, 230, 230, 222, 202, 180, 163, 142, 123, 114, 106, 94, 84, 64, 26, 27]);
        case 'Spectrum': {
          // ImageJ: Color.getHSBColor(i / 255f, 1f, 1f)
          const t = new Uint8Array(768);
          for (let i = 0; i < 256; i++) {
            const c = hsbToRgb(Math.fround(i / 255));
            t[i * 3] = c[0]; t[i * 3 + 1] = c[1]; t[i * 3 + 2] = c[2];
          }
          return t;
        }
        case '16 Colors': {
          // Fiji luts/16_colors.lut, read byte for byte: band k = entries 16k..16k+15;
          // all bands are flat except band 13, a blue ramp at r=245, g=0.
          const pal = [[0, 0, 0], [1, 1, 171], [1, 1, 224], [0, 110, 255], [1, 171, 254], [1, 224, 254], [1, 254, 1], [190, 255, 0],
            [255, 255, 0], [255, 224, 0], [255, 141, 0], [250, 94, 0], [245, 0, 0], null, [222, 180, 222], [255, 255, 255]];
          const ramp = [135, 141, 147, 153, 160, 166, 172, 178, 185, 191, 197, 203, 210, 216, 222, 228];
          const t = new Uint8Array(768);
          for (let i = 0; i < 256; i++) {
            const k = i >> 4;
            const c = k === 13 ? [245, 0, ramp[i & 15]] : pal[k];
            t[i * 3] = c[0]; t[i * 3 + 1] = c[1]; t[i * 3 + 2] = c[2];
          }
          return t;
        }
        case 'HiLo': {
          // Grays, with level 0 shown blue and level 255 shown red (saturation indicator).
          const t = primary(1, 1, 1);
          t[0] = 0; t[1] = 0; t[2] = 255;
          t[255 * 3] = 255; t[255 * 3 + 1] = 0; t[255 * 3 + 2] = 0;
          return t;
        }
        default: return null;
      }
    }

    function parseHex(s) {
      const m = /^#?([0-9a-f]{6})$/i.exec(String(s));
      if (!m) return null;
      const v = parseInt(m[1], 16);
      return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
    }
    function toHex(c) { return '#' + c.map((v) => (v < 16 ? '0' : '') + v.toString(16)).join(''); }

    /* A linear ramp from black to the colour, as ImageJ's LUT.createLutFromColor:
     * increment = channel/255, entry = (int)(i · increment), i.e. truncated, so
     * level 255 reaches the colour and a white channel equals Grays. */
    function fromColor(hex) {
      const c = parseHex(hex);
      if (!c) throw fail('IJ_BAD_COLOR', 'colour');
      const t = new Uint8Array(768);
      const inc = [c[0] / 255, c[1] / 255, c[2] / 255];
      for (let i = 0; i < 256; i++) {
        t[i * 3] = Math.floor(i * inc[0]);
        t[i * 3 + 1] = Math.floor(i * inc[1]);
        t[i * 3 + 2] = Math.floor(i * inc[2]);
      }
      return t;
    }

    function names() { return NAMES.slice(); }

    /* A table by name ('Fire'…), '#rrggbb', or a ready 768-byte table (returned
     * as a copy). Always interleaved r,g,b per level. */
    function get(nameOrTable) {
      if (nameOrTable instanceof Uint8Array) {
        if (nameOrTable.length !== 768) throw fail('IJ_BAD_LUT', 'lut size');
        return new Uint8Array(nameOrTable);
      }
      if (typeof nameOrTable === 'string' && nameOrTable.charAt(0) === '#') return fromColor(nameOrTable);
      if (typeof nameOrTable === 'string' && customs.has(nameOrTable)) return new Uint8Array(customs.get(nameOrTable));
      if (!cache.has(nameOrTable)) {
        const t = build(nameOrTable);
        if (!t) throw fail('IJ_BAD_LUT', 'unknown lut');
        cache.set(nameOrTable, t);
      }
      return new Uint8Array(cache.get(nameOrTable));
    }

    /* Display LUT of a channel colour: white → Grays, the six primaries by
     * name, any other colour its '#rrggbb' ramp. */
    function forColor(hex) {
      const c = parseHex(hex);
      if (!c) return 'Grays';
      const map = { '255,255,255': 'Grays', '255,0,0': 'Red', '0,255,0': 'Green', '0,0,255': 'Blue', '0,255,255': 'Cyan', '255,0,255': 'Magenta', '255,255,0': 'Yellow' };
      return map[c.join(',')] || toHex(c);
    }

    function reversed(t) {
      const r = new Uint8Array(768);
      for (let i = 0; i < 256; i++) { const j = 255 - i; r[i * 3] = t[j * 3]; r[i * 3 + 1] = t[j * 3 + 1]; r[i * 3 + 2] = t[j * 3 + 2]; }
      return r;
    }
    function same(a, b) { for (let i = 0; i < 768; i++) if (a[i] !== b[i]) return false; return true; }

    /* Identify a table: { lut: name | '#rrggbb' | Uint8Array, invert } — the
     * inverse of get() (used by the TIFF reader). */
    function identify(table) {
      for (const rev of [false, true]) {
        const t = rev ? reversed(table) : table;
        for (const n of NAMES) if (same(t, get(n))) return { lut: n, invert: rev };
        for (const [n, tab] of customs) if (same(t, tab)) return { lut: n, invert: rev };
        const top = [t[765], t[766], t[767]];
        if (top[0] + top[1] + top[2] > 0 && same(t, fromColor(toHex(top)))) return { lut: forColor(toHex(top)), invert: rev };
      }
      return { lut: new Uint8Array(table), invert: false };
    }

    /* Registers a table under a name an extension chose (a LUT file, 3-3-2 RGB, Red/Green): a channel's
     * display.lut may then name it, the TIFF writer and the renderer read it through get(). The name is a
     * plain label (1..64 characters, not a built-in name, not '#rrggbb'); registering a name again replaces
     * its table. The table is copied. */
    function register(name, table) {
      if (typeof name !== 'string' || !name.trim() || name.length > 64 || name.charAt(0) === '#' || NAMES.indexOf(name) >= 0) throw fail('IJ_BAD_LUT', 'lut name');
      // (duck-typed: a table built in another realm, a test's or the page's, is still a Uint8Array)
      if (!ArrayBuffer.isView(table) || !table.constructor || table.constructor.name !== 'Uint8Array' || table.length !== 768) throw fail('IJ_BAD_LUT', 'lut size');
      customs.set(name, new Uint8Array(table));
      return name;
    }
    /* The registered names with their tables (copies), registration order: what the page stores in the session meta. */
    function registered() { return Array.from(customs, ([n, t]) => ({ name: n, table: new Uint8Array(t) })); }

    return { names, get, fromColor, forColor, identify, register, registered };
  })();

  // ---------------------------------------------------------------- IJRoi
  const IJRoi = (() => {
    const EPS = 1e-9;
    const RUN_ENDS = new WeakMap();

    function badRoi(msg) { return fail('IJ_BAD_ROI', msg || 'roi'); }
    function finite(v) { return typeof v === 'number' && isFinite(v); }

    // Caps (PLAN-wave2 §2.2): a selection of a noisy image can hold millions of runs / vertices;
    // beyond these the journal, the storage and the hit tests stop being usable.
    const MAX_RUNS = 2000000;
    const MAX_VERTS = 1000000;

    function tooComplex(msg) { return fail('IJ_ROI_TOO_COMPLEX', msg || 'selection too complex'); }

    function validate(roi) {
      if (!roi || typeof roi !== 'object') throw badRoi('not an object');
      // A selection may carry a name (ROI Manager, Properties): a short string, never read by the pixel code.
      if (roi.name !== undefined && (typeof roi.name !== 'string' || roi.name.length > 255)) throw badRoi('name');
      switch (roi.type) {
        case 'rect': case 'oval':
          if (!(finite(roi.x) && finite(roi.y) && finite(roi.w) && finite(roi.h) && roi.w >= 0 && roi.h >= 0)) throw badRoi('box');
          break;
        case 'polygon': case 'freehand': case 'point': case 'polyline': case 'angle': {
          // polyline = a segmented line (open, not an area); angle = exactly three points
          // (arm end, vertex, arm end); a multi-point selection stays a `point` with n >= 1 points.
          const need = roi.type === 'point' ? 1 : roi.type === 'polyline' ? 2 : 3;
          if (!Array.isArray(roi.points) || roi.points.length < need) throw badRoi('points');
          if (roi.type === 'angle' && roi.points.length !== 3) throw badRoi('angle points');
          if (roi.points.length > MAX_VERTS) throw tooComplex('vertices');
          for (const p of roi.points) if (!Array.isArray(p) || !finite(p[0]) || !finite(p[1])) throw badRoi('point');
          // a segmented line has a width like a straight line (Properties, Line to Area)
          if (roi.type === 'polyline' && roi.width !== undefined && !(finite(roi.width) && roi.width >= 0)) throw badRoi('polyline width');
          break;
        }
        case 'line':
          if (!(finite(roi.x1) && finite(roi.y1) && finite(roi.x2) && finite(roi.y2))) throw badRoi('line');
          if (roi.width !== undefined && !(finite(roi.width) && roi.width >= 0)) throw badRoi('line width');
          break;
        case 'mask': {
          if (!(finite(roi.x) && finite(roi.y) && Number.isInteger(roi.w) && Number.isInteger(roi.h) && roi.w >= 0 && roi.h >= 0)) throw badRoi('mask box');
          if (!Array.isArray(roi.rle) && !(ArrayBuffer.isView(roi.rle) && roi.rle.constructor && roi.rle.constructor.name === 'Uint32Array')) throw badRoi('rle');
          if (roi.rle.length > MAX_RUNS) throw tooComplex('runs');
          let s = 0;
          for (let i = 0; i < roi.rle.length; i++) { const r = roi.rle[i]; if (!Number.isInteger(r) || r < 0) throw badRoi('run'); s += r; }
          if (s !== roi.w * roi.h) throw badRoi('rle length');
          break;
        }
        default: throw badRoi('type');
      }
      return true;
    }

    function isArea(roi) { return roi.type === 'rect' || roi.type === 'oval' || roi.type === 'polygon' || roi.type === 'freehand' || roi.type === 'mask'; }

    function lineCorners(roi) {
      const dx = roi.x2 - roi.x1, dy = roi.y2 - roi.y1;
      const len = Math.sqrt(dx * dx + dy * dy);
      const hw = Math.max(1, roi.width || 1) / 2;
      const nx = len > 0 ? -dy / len : 0, ny = len > 0 ? dx / len : 1;
      return [[roi.x1 + nx * hw, roi.y1 + ny * hw], [roi.x2 + nx * hw, roi.y2 + ny * hw], [roi.x2 - nx * hw, roi.y2 - ny * hw], [roi.x1 - nx * hw, roi.y1 - ny * hw]];
    }

    /* Integer bounding box. Fractional boxes grow outward (floor / ceil). */
    function bounds(roi) {
      let x0, y0, x1, y1;
      switch (roi.type) {
        case 'rect': case 'oval': case 'mask':
          x0 = roi.x; y0 = roi.y; x1 = roi.x + roi.w; y1 = roi.y + roi.h; break;
        default: {
          const pts = roi.type === 'line' ? lineCorners(roi) : roi.points;
          if (!pts || !pts.length) throw badRoi('bounds');
          x0 = Infinity; y0 = Infinity; x1 = -Infinity; y1 = -Infinity;
          for (const p of pts) { if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0]; if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1]; }
          if (roi.type === 'point') { x0 = Math.floor(x0); y0 = Math.floor(y0); x1 = Math.floor(x1) + 1; y1 = Math.floor(y1) + 1; }
        }
      }
      const bx = Math.floor(x0), by = Math.floor(y0);
      return { x: bx, y: by, w: Math.ceil(x1) - bx, h: Math.ceil(y1) - by };
    }

    /* The fill rule of journals written before the PolygonFiller port (plugin 1.0.0): a pixel is inside when its
     * centre is, crossings use half-open edges (y1 <= yc < y2) and the span is [ceil(xa - 1/2), ceil(xb - 1/2)), so
     * left/top edges are inclusive and right/bottom exclusive. Kept ONLY so such a journal replays to the pixels it
     * was recorded with: an entry carries `maskRule: 2` since 1.1.0, an entry without it replays with `fillRule: 1`. */
    function fillPolygonLegacy(pts, bx, by, bw, bh, out) {
      const n = pts.length;
      const xs = [];
      for (let row = 0; row < bh; row++) {
        const yc = by + row + 0.5;
        xs.length = 0;
        for (let i = 0; i < n; i++) {
          const a = pts[i], b = pts[(i + 1) % n];
          const ya = a[1], yb = b[1];
          if ((ya <= yc && yb > yc) || (yb <= yc && ya > yc)) xs.push(a[0] + (yc - ya) * (b[0] - a[0]) / (yb - ya));
        }
        if (xs.length < 2) continue;
        xs.sort((p, q) => p - q);
        for (let k = 0; k + 1 < xs.length; k += 2) {
          let s = Math.ceil(xs[k] - 0.5) - bx, e = Math.ceil(xs[k + 1] - 0.5) - bx;
          if (s < 0) s = 0;
          if (e > bw) e = bw;
          for (let x = s; x < e; x++) out[row * bw + x] = 1;
        }
      }
    }

    /* ij.process.PolygonFiller, ported: an even-odd scanline fill where "outline and pixel coordinates are shifted by
     * 0.5" (pixel (i, j) is the square [i, i+1) x [j, j+1)). Quotes of the source that settle the tie rules:
     *   "int y1 = (int)Math.round(y1f); ... if (y1==y2) continue;"                  a horizontal edge is ignored; an edge
     *                                                                                covers the rows [round(y1), round(y2))
     *   "ex[edges] = x1f + (y1 - y1f + 0.5)*slope + 1e-8;"                          its x at the CENTRE of its first row
     *   "x1 = (int)(ex[aedge[i]]+0.5); x2 = (int)(ex[aedge[i+1]]+0.5); for (x=x1; x<x2; x++)"
     * so a pixel is inside when its centre lies in (left edge, right edge]: a centre exactly on a left boundary is
     * outside, exactly on a right boundary inside; vertically (top, bottom]. Writes 1 into `out` for the box
     * (bx, by, bw, bh); the active edges are kept sorted per row, so the cost is O(rows * active edges). */
    function fillPolygon(pts, bx, by, bw, bh, out) {
      const n = pts.length;
      const edges = [];
      for (let i = 0; i < n; i++) {
        const a = pts[i], b = pts[i + 1 === n ? 0 : i + 1];
        let x1f = a[0], y1f = a[1], x2f = b[0], y2f = b[1];
        let y1 = Math.floor(y1f + 0.5), y2 = Math.floor(y2f + 0.5);
        if (y1 === y2) continue;
        if (y1 > y2) { let t = y1; y1 = y2; y2 = t; t = y1f; y1f = y2f; y2f = t; t = x1f; x1f = x2f; x2f = t; }
        const slope = (x2f - x1f) / (y2f - y1f);
        edges.push({ y1, y2, ex: x1f + (y1 - y1f + 0.5) * slope + 1e-8, slope });
      }
      if (!edges.length) return;
      edges.sort((p, q) => p.y1 - q.y1);
      let active = [], next = 0;
      let yMax = edges[0].y2;
      for (let i = 1; i < edges.length; i++) if (edges[i].y2 > yMax) yMax = edges[i].y2;
      const yEnd = Math.min(by + bh, yMax);
      let y = Math.max(by, edges[0].y1);
      for (; y < yEnd; y++) {
        while (next < edges.length && edges[next].y1 <= y) { active.push(edges[next]); next++; }
        active = active.filter((e) => y < e.y2);
        if (active.length < 2) continue;
        const xs = active.map((e) => e.ex + (y - e.y1) * e.slope);
        xs.sort((p, q) => p - q);
        const row = (y - by) * bw;
        for (let k = 0; k + 1 < xs.length; k += 2) {
          let s = Math.floor(xs[k] + 0.5) - bx, e2 = Math.floor(xs[k + 1] + 0.5) - bx;
          if (s < 0) s = 0;
          if (e2 > bw) e2 = bw;
          for (let x = s; x < e2; x++) out[row + x] = 1;
        }
      }
    }

    function clipBox(b, w, h) {
      if (!(finite(w) && finite(h))) return b;
      const x0 = Math.max(0, b.x), y0 = Math.max(0, b.y);
      const x1 = Math.min(w, b.x + b.w), y1 = Math.min(h, b.y + b.h);
      if (x1 <= x0 || y1 <= y0) return { x: x0, y: y0, w: 0, h: 0 };
      return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    }

    /* Mask of an ROI inside its integer bounds (clipped to the image when the
     * image size is given). Oval: pixel centre inside the ellipse
     * ((x+½−cx)/rx)² + ((y+½−cy)/ry)² ≤ 1 — ImageJ fills pixels whose centre
     * is inside; its integer outline can differ on the edge pixel of very
     * small ovals. Line: the pixels whose centre lies in the rectangle of the
     * line's width (≥ 1). Point: the pixel containing each point. */
    function mask(roi, w, h) {
      validate(roi);
      const b = clipBox(bounds(roi), w, h);
      const data = new Uint8Array(b.w * b.h);
      if (b.w === 0 || b.h === 0) return { x: b.x, y: b.y, w: b.w, h: b.h, data };
      switch (roi.type) {
        case 'rect': {
          const x0 = roi.x, x1 = roi.x + roi.w, y0 = roi.y, y1 = roi.y + roi.h;
          for (let j = 0; j < b.h; j++) {
            const yc = b.y + j + 0.5;
            if (yc < y0 || yc >= y1) continue;
            for (let i = 0; i < b.w; i++) { const xc = b.x + i + 0.5; if (xc >= x0 && xc < x1) data[j * b.w + i] = 1; }
          }
          break;
        }
        case 'oval': {
          const rx = roi.w / 2, ry = roi.h / 2, cx = roi.x + rx, cy = roi.y + ry;
          for (let j = 0; j < b.h; j++) {
            const dy = (b.y + j + 0.5 - cy) / ry;
            for (let i = 0; i < b.w; i++) {
              const dx = (b.x + i + 0.5 - cx) / rx;
              if (dx * dx + dy * dy <= 1 + EPS) data[j * b.w + i] = 1;
            }
          }
          break;
        }
        case 'polygon': case 'freehand': (roi.fillRule === 1 ? fillPolygonLegacy : fillPolygon)(roi.points, b.x, b.y, b.w, b.h, data); break;
        case 'line': (roi.fillRule === 1 ? fillPolygonLegacy : fillPolygon)(lineCorners(roi), b.x, b.y, b.w, b.h, data); break;
        case 'point':
          for (const p of roi.points) {
            const i = Math.floor(p[0]) - b.x, j = Math.floor(p[1]) - b.y;
            if (i >= 0 && j >= 0 && i < b.w && j < b.h) data[j * b.w + i] = 1;
          }
          break;
        case 'mask': {
          let pos = 0, bit = 0;
          for (let r = 0; r < roi.rle.length; r++) {
            const run = roi.rle[r];
            if (bit) {
              for (let k = pos; k < pos + run; k++) {
                const i = roi.x + (k % roi.w) - b.x, j = roi.y + Math.floor(k / roi.w) - b.y;
                if (i >= 0 && j >= 0 && i < b.w && j < b.h) data[j * b.w + i] = 1;
              }
            }
            pos += run; bit ^= 1;
          }
          break;
        }
      }
      return { x: b.x, y: b.y, w: b.w, h: b.h, data };
    }

    /* Continuous point test. Polygon: even-odd ray cast. Mask: the pixel
     * floor(x), floor(y). Line / point: false (they enclose no area). */
    function contains(roi, x, y) {
      switch (roi.type) {
        case 'rect': return x >= roi.x && x < roi.x + roi.w && y >= roi.y && y < roi.y + roi.h;
        case 'oval': {
          const rx = roi.w / 2, ry = roi.h / 2;
          if (!(rx > 0 && ry > 0)) return false;
          const dx = (x - roi.x - rx) / rx, dy = (y - roi.y - ry) / ry;
          return dx * dx + dy * dy <= 1 + EPS;
        }
        case 'polygon': case 'freehand': {
          const p = roi.points;
          let inside = false;
          for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
            const yi = p[i][1], yj = p[j][1];
            if ((yi <= y) !== (yj <= y) && x < p[i][0] + (y - yi) * (p[j][0] - p[i][0]) / (yj - yi)) inside = !inside;
          }
          return inside;
        }
        case 'mask': {
          const i = Math.floor(x) - roi.x, j = Math.floor(y) - roi.y;
          if (i < 0 || j < 0 || i >= roi.w || j >= roi.h) return false;
          const k = j * roi.w + i;
          // Cumulative run ends, cached per run array (immutable once published): a binary search
          // instead of a walk over up to 2 M runs on every pointer move.
          const rle = roi.rle;
          let cum = RUN_ENDS.get(rle);
          if (!cum) {
            cum = new Float64Array(rle.length);
            let pos = 0;
            for (let r = 0; r < rle.length; r++) { pos += rle[r]; cum[r] = pos; }
            RUN_ENDS.set(rle, cum);
          }
          let lo = 0, hi = cum.length - 1;
          if (!(hi >= 0) || k >= cum[hi]) return false;
          while (lo < hi) { const mid = (lo + hi) >> 1; if (k < cum[mid]) hi = mid; else lo = mid + 1; }
          return (lo & 1) === 1;
        }
        default: return false;
      }
    }

    /* Area in pixels = number of mask pixels (what Analyze › Measure counts). */
    function area(roi) {
      if (!isArea(roi)) return 0;
      if (roi.type === 'mask') { let s = 0; for (let i = 1; i < roi.rle.length; i += 2) s += roi.rle[i]; return s; }
      if (roi.type === 'rect' && Number.isInteger(roi.x) && Number.isInteger(roi.y) && Number.isInteger(roi.w) && Number.isInteger(roi.h)) return roi.w * roi.h;
      const m = mask(roi);
      let s = 0;
      for (let i = 0; i < m.data.length; i++) s += m.data[i];
      return s;
    }

    /* ImageJ PolygonRoi.getTracedPerimeter: Σ|dx|·w + Σ|dy|·h − nCorners·((w + h) − √(w² + h²))
     * over a closed outline made of horizontal / vertical grid steps (pw, ph =
     * pixel size, 1 here); fewer than 4 vertices → 0. */
    function tracedPerimeter(pts, pw, ph) {
      const n = pts.length;
      if (n < 4) return 0;
      pw = pw || 1; ph = ph || 1;
      let sumdx = 0, sumdy = 0, nCorners = 0;
      let dx1 = pts[0][0] - pts[n - 1][0], dy1 = pts[0][1] - pts[n - 1][1];
      let side1 = Math.abs(dx1) + Math.abs(dy1);
      let corner = false;
      for (let i = 0; i < n; i++) {
        const nx = i + 1 === n ? 0 : i + 1;
        const dx2 = pts[nx][0] - pts[i][0], dy2 = pts[nx][1] - pts[i][1];
        sumdx += Math.abs(dx1); sumdy += Math.abs(dy1);
        const side2 = Math.abs(dx2) + Math.abs(dy2);
        if (side1 > 1 || !corner) { corner = true; nCorners++; } else corner = false;
        dx1 = dx2; dy1 = dy2; side1 = side2;
      }
      return sumdx * pw + sumdy * ph - nCorners * ((pw + ph) - Math.sqrt(pw * pw + ph * ph));
    }

    /* PolygonRoi.isTraced(): a polygon whose vertices are integers and whose
     * edges (the closing one included) are all horizontal or vertical. */
    function isRectilinearInt(pts) {
      const n = pts.length;
      if (n < 4) return false;
      for (let i = 0; i < n; i++) {
        const a = pts[i], b = pts[(i + 1) % n];
        if (!Number.isInteger(a[0]) || !Number.isInteger(a[1])) return false;
        if (a[0] !== b[0] && a[1] !== b[1]) return false;
      }
      return true;
    }

    /* ImageJ PolygonRoi.getSmoothedPerimeter = getSmoothedLineLength (an OPEN
     * line: first segment p0 → mean(p0..p2), middle segments |p[i+2] − p[i−1]|/3,
     * last segment mean(p[n−3..n−1]) → p[n−1]) plus the raw closing segment
     * p[n−1] → p0. Fewer than 3 points: the plain polygon length. */
    function smoothedPerimeter(pts) {
      const n = pts.length;
      if (n < 3) return polygonPerimeter(pts);
      const X = (i) => pts[i][0], Y = (i) => pts[i][1];
      let len = Math.hypot((X(0) + X(1) + X(2)) / 3 - X(0), (Y(0) + Y(1) + Y(2)) / 3 - Y(0));
      for (let i = 1; i <= n - 3; i++) len += Math.hypot((X(i + 2) - X(i - 1)) / 3, (Y(i + 2) - Y(i - 1)) / 3);
      len += Math.hypot(X(n - 1) - (X(n - 3) + X(n - 2) + X(n - 1)) / 3, Y(n - 1) - (Y(n - 3) + Y(n - 2) + Y(n - 1)) / 3);
      len += Math.hypot(X(n - 1) - X(0), Y(n - 1) - Y(0));
      return len;
    }

    function polygonPerimeter(pts) {
      let len = 0;
      for (let i = 0; i < pts.length; i++) { const j = (i + 1) % pts.length; len += Math.hypot(pts[j][0] - pts[i][0], pts[j][1] - pts[i][1]); }
      return len;
    }

    function lineLength(roi, cal) {
      const pw = (cal && cal.pixelWidth) || 1, ph = (cal && cal.pixelHeight) || 1;
      if (roi.type === 'polyline') {
        let len = 0;
        for (let i = 1; i < roi.points.length; i++) len += Math.hypot((roi.points[i][0] - roi.points[i - 1][0]) * pw, (roi.points[i][1] - roi.points[i - 1][1]) * ph);
        return len;
      }
      return Math.hypot((roi.x2 - roi.x1) * pw, (roi.y2 - roi.y1) * ph);
    }

    /* Dense 0/1 pixels of a mask ROI inside its own box. */
    function maskDense(roi) {
      const d = new Uint8Array(roi.w * roi.h);
      let pos = 0, bit = 0;
      for (let r = 0; r < roi.rle.length; r++) {
        const run = roi.rle[r];
        if (bit) d.fill(1, pos, pos + run);
        pos += run; bit ^= 1;
      }
      return d;
    }

    /* Outline loops of a mask ROI, in image coordinates, as the vertex lists of an ImageJ traced
     * (wand / ThresholdToSelection style) selection: vertices only where the direction changes,
     * foreground kept on the right of the travel direction. At a vertex where two pixels touch
     * diagonally the path turns RIGHT first, so diagonal neighbours are separate outlines (the
     * foreground is 4-connected, holes 8-connected). The outer loops and the holes all appear.
     * Golden fixtures of ImageJ 1.54f's ThresholdToSelection will confirm this rule. */
    // Tracing a mask costs O(box) memory (a dense copy + a visited map): the loops are cached per run array (immutable once
    // published), and a box beyond MAX_OUTLINE_PIXELS is refused instead of exhausting the memory of the worker.
    const OUTLINE_CACHE = new WeakMap();
    const MAX_OUTLINE_PIXELS = 1 << 27;
    function outlines(roi) {
      if (roi.type !== 'mask') {
        if (roi.type === 'polygon' || roi.type === 'freehand') return [roi.points.map((p) => [p[0], p[1]])];
        return [];
      }
      const w = roi.w, h = roi.h;
      if (!(w > 0 && h > 0)) return [];
      const hit = OUTLINE_CACHE.get(roi.rle);
      if (hit && hit.x === roi.x && hit.y === roi.y && hit.w === w && hit.h === h) return hit.loops;
      if (w * h > MAX_OUTLINE_PIXELS) throw tooComplex('outline of a very large mask');
      const loops = traceOutlines(roi, w, h);
      OUTLINE_CACHE.set(roi.rle, { x: roi.x, y: roi.y, w, h, loops });
      return loops;
    }

    function traceOutlines(roi, w, h) {
      const dense = maskDense(roi);
      const fg = (x, y) => x >= 0 && y >= 0 && x < w && y < h && dense[y * w + x] === 1;
      const W1 = w + 1;
      const seen = new Uint8Array(W1 * (h + 1));
      const DX = [1, 0, -1, 0], DY = [0, 1, 0, -1];
      // boundary edge leaving vertex (x, y) in direction d: foreground on its right, background on its left
      const edge = (x, y, d) => {
        switch (d) {
          case 0: return fg(x, y) && !fg(x, y - 1);
          case 1: return fg(x - 1, y) && !fg(x, y);
          case 2: return fg(x - 1, y - 1) && !fg(x - 1, y);
          default: return fg(x, y - 1) && !fg(x - 1, y - 1);
        }
      };
      const turns = [1, 0, 3];
      const loops = [];
      for (let y = 0; y <= h; y++) {
        for (let x = 0; x <= w; x++) {
          for (let d0 = 0; d0 < 4; d0++) {
            if (((seen[y * W1 + x] >> d0) & 1) || !edge(x, y, d0)) continue;
            const pts = [];
            let cx = x, cy = y, d = d0;
            for (;;) {
              seen[cy * W1 + cx] |= 1 << d;
              const nx = cx + DX[d], ny = cy + DY[d];
              // next direction: right turn, straight, left turn
              let nd = -1;
              for (let t = 0; t < 3; t++) { const c = (d + turns[t]) & 3; if (edge(nx, ny, c)) { nd = c; break; } }
              if (nd !== d) pts.push([nx + roi.x, ny + roi.y]);
              cx = nx; cy = ny; d = nd;
              if (d < 0 || (cx === x && cy === y && d === d0)) break;
            }
            if (pts.length) loops.push(pts);
          }
        }
      }
      return loops;
    }

    /* Perimeter in pixels. rect 2(w+h); oval Ramanujan's first approximation
     * π(3(a+b) − √((3a+b)(a+3b))) with semi-axes a, b; polygon the edge sum
     * (traced polygons — `traced: true`, e.g. particle outlines, and any polygon
     * of integer vertices with only horizontal / vertical edges, as ImageJ's
     * Roi.isTraced — get the corner correction); freehand ImageJ's smoothed length; line its length;
     * point / angle 0; polyline its length; mask the sum of the traced perimeters of every
     * outline (outer loops and holes) of its pixels, which is what ImageJ reports for the
     * ShapeRoi of a traced mask. */
    function perimeter(roi) {
      switch (roi.type) {
        case 'rect': return 2 * (roi.w + roi.h);
        case 'oval': {
          const a = roi.w / 2, b = roi.h / 2;
          return Math.PI * (3 * (a + b) - Math.sqrt((3 * a + b) * (a + 3 * b)));
        }
        case 'polygon': return roi.traced || isRectilinearInt(roi.points) ? tracedPerimeter(roi.points) : polygonPerimeter(roi.points);
        case 'freehand': return smoothedPerimeter(roi.points);
        case 'line': case 'polyline': return lineLength(roi);
        case 'mask': {
          let sum = 0;
          for (const loop of outlines(roi)) sum += tracedPerimeter(loop);
          return sum;
        }
        default: return 0;
      }
    }

    /* ImageJ Roi.getFloatAngle: degrees, y pointing up, range (−180, 180]. */
    function lineAngle(roi) {
      const dx = roi.x2 - roi.x1, dy = roi.y1 - roi.y2;
      return Math.atan2(dy, dx) * 180 / Math.PI;
    }

    /* Alternating run lengths of 0/1 starting with a 0-run (possibly empty). */
    function rleEncode(data) {
      const runs = [];
      let bit = 0, run = 0;
      for (let i = 0; i < data.length; i++) {
        const b = data[i] ? 1 : 0;
        if (b === bit) run++; else { runs.push(run); bit = b; run = 1; }
      }
      runs.push(run);
      return runs;
    }

    /* Mask ROI from a full-image 0/non-0 array: tight box around the set
     * pixels + runs. Empty → a 0×0 box. */
    function fromMask(maskData, w, h) {
      let x0 = w, y0 = h, x1 = -1, y1 = -1;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          if (maskData[y * w + x]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
        }
      }
      if (x1 < 0) return { type: 'mask', x: 0, y: 0, w: 0, h: 0, rle: new Uint32Array(0) };
      const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
      const sub = new Uint8Array(bw * bh);
      for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) sub[y * bw + x] = maskData[(y + y0) * w + x + x0] ? 1 : 0;
      const runs = rleEncode(sub);
      if (runs.length > MAX_RUNS) throw tooComplex('runs');
      return { type: 'mask', x: x0, y: y0, w: bw, h: bh, rle: Uint32Array.from(runs) };
    }

    /* Complement of an ROI inside the w×h image, as a mask ROI. */
    function inverse(roi, w, h) {
      const m = mask(roi, w, h);
      const full = new Uint8Array(w * h).fill(1);
      for (let j = 0; j < m.h; j++) for (let i = 0; i < m.w; i++) if (m.data[j * m.w + i]) full[(m.y + j) * w + m.x + i] = 0;
      return fromMask(full, w, h);
    }

    /* Copy moved by (dx, dy). Typed arrays (a mask's runs) are copied as typed arrays: a JSON
     * round trip would turn them into plain objects that validate() rejects. */
    function translate(roi, dx, dy) {
      const r = Object.assign({}, roi);
      if (roi.points) r.points = roi.points.map((p) => [p[0] + dx, p[1] + dy]);
      if (roi.rle) r.rle = roi.rle.slice();
      if (r.type === 'line') { r.x1 += dx; r.x2 += dx; r.y1 += dy; r.y2 += dy; }
      if ('x' in r) { r.x += dx; r.y += dy; }
      return r;
    }

    /* Approximate serialized size in bytes (what a journal entry would carry). */
    function byteSize(roi) {
      if (!roi) return 0;
      if (roi.rle) return roi.rle.length * 4 + 64;
      if (roi.points) return roi.points.length * 16 + 64;
      return 96;
    }

    /* FNV-1a (32 bit) over a canonical byte stream of the ROI, plus its size: the key under which
     * a large ROI is journaled once per document (`roiRef`). */
    // Two independent 32-bit lanes (FNV-1a, and a multiply-xorshift one) + the byte size: a stored body is
    // shared by every entry with the same reference, so a collision would replay the wrong selection silently.
    function hash(roi) {
      let h = 0x811c9dc5, g = 0x9e3779b9;
      const f64 = new Float64Array(1), u8 = new Uint8Array(f64.buffer);
      const byte = (b) => {
        h ^= b; h = Math.imul(h, 0x01000193) >>> 0;
        g = Math.imul(g ^ b, 0x5bd1e995) >>> 0; g = (g ^ (g >>> 15)) >>> 0;
      };
      const str = (t) => { for (let i = 0; i < t.length; i++) byte(t.charCodeAt(i) & 255); byte(0); };
      const num = (v) => { f64[0] = v; for (let i = 0; i < 8; i++) byte(u8[i]); };
      str(roi.type);
      for (const k of ['x', 'y', 'w', 'h', 'x1', 'y1', 'x2', 'y2', 'width']) if (typeof roi[k] === 'number') { str(k); num(roi[k]); }
      if (roi.points) { str('p'); for (const p of roi.points) { num(p[0]); num(p[1]); } }
      if (roi.rle) {
        str('r');
        for (let i = 0; i < roi.rle.length; i++) { const v = roi.rle[i]; byte(v & 255); byte((v >>> 8) & 255); byte((v >>> 16) & 255); byte((v >>> 24) & 255); }
      }
      return (h >>> 0).toString(16).padStart(8, '0') + (g >>> 0).toString(16).padStart(8, '0') + '-' + byteSize(roi);
    }

    return { validate, isArea, bounds, mask, contains, area, perimeter, lineLength, lineAngle, inverse, fromMask, translate, tracedPerimeter, smoothedPerimeter, rleEncode, outlines, maskDense, byteSize, hash, MAX_RUNS, MAX_VERTS };
  })();

  // ---------------------------------------------------------------- IJOps
  const IJOps = (() => {
    /* Visit every pixel of the channel inside the mask box. */
    function forEachIn(ch, mb, fn) {
      const w = ch.width, h = ch.height;
      if (!mb) {
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) fn(y * w + x, x, y);
        return;
      }
      const x0 = Math.max(0, mb.x), y0 = Math.max(0, mb.y), x1 = Math.min(w, mb.x + mb.w), y1 = Math.min(h, mb.y + mb.h);
      const d = mb.data;
      for (let y = y0; y < y1; y++) {
        const row = (y - mb.y) * mb.w - mb.x;
        for (let x = x0; x < x1; x++) if (d[row + x]) fn(y * w + x, x, y);
      }
    }

    function blank(ch, w, h, bd) { return { width: w, height: h, bitDepth: bd || ch.bitDepth, data: typedArrayFor(bd || ch.bitDepth, w * h) }; }
    function copy(ch) { return { width: ch.width, height: ch.height, bitDepth: ch.bitDepth, data: ch.data.slice() }; }

    /* Measurements of the pixels inside the mask (ImageJ ImageStatistics).
     *   stdDev     sample standard deviation, n − 1
     *   median     8/16-bit: first value whose running count exceeds n/2 (ImageJ's
     *              cumulative-histogram rule); 32-bit: sorted middle, the mean of
     *              the two middle values for an even count (FloatStatistics)
     *   mode       most frequent value (lowest on ties); 32-bit: centre of the
     *              fullest of 256 bins over [min, max]
     *   intDen     calibrated area × mean;  rawIntDen  Σ value
     *   xCentroid  mean of (x + ½) over the pixels, × pixel width
     *   xCenterOfMass  Σ v·(x + ½) / Σ v, × pixel width
     *   skewness   m3 / m2^1.5,  kurtosis  m4 / m2² − 3  (m_k central moments / n)
     * 32-bit: NaN and ±Infinity pixels are left out (ImageJ's float statistics). */
    function statistics(ch, mb, opts) {
      const cal = (opts && opts.calibration) || {};
      const pw = cal.pixelWidth || 1, ph = cal.pixelHeight || 1;
      const d = ch.data, f32 = ch.bitDepth === 32;
      let n = 0, sum = 0, min = Infinity, max = -Infinity, sx = 0, sy = 0;
      forEachIn(ch, mb, (i, x, y) => {
        const v = d[i];
        if (f32 && v - v !== 0) return;
        n++; sum += v; sx += x + 0.5; sy += y + 0.5;
        if (v < min) min = v;
        if (v > max) max = v;
      });
      if (n === 0) {
        return { area: 0, mean: NaN, stdDev: NaN, min: NaN, max: NaN, median: NaN, mode: NaN, intDen: 0, rawIntDen: 0, xCentroid: NaN, yCentroid: NaN, xCenterOfMass: NaN, yCenterOfMass: NaN, skewness: NaN, kurtosis: NaN, n: 0 };
      }
      const mean = sum / n;
      let m2 = 0, m3 = 0, m4 = 0, vx = 0, vy = 0;
      let counts = null, vals = null, k = 0;
      if (f32) vals = new Float32Array(n); else counts = new Uint32Array(ch.bitDepth === 8 ? 256 : 65536);
      forEachIn(ch, mb, (i, x, y) => {
        const v = d[i];
        if (f32) { if (v - v !== 0) return; vals[k++] = v; } else counts[v]++;
        const e = v - mean, e2 = e * e;
        m2 += e2; m3 += e2 * e; m4 += e2 * e2;
        vx += v * (x + 0.5); vy += v * (y + 0.5);
      });
      const variance = m2 / n;
      let median, mode;
      if (f32) {
        vals.sort();
        { const m = n >> 1; median = (n & 1) ? vals[m] : Math.fround((vals[m - 1] + vals[m]) / 2); } // FloatStatistics.getMedian
        if (max === min) mode = min;
        else {
          const c = new Uint32Array(256), bw = (max - min) / 256;
          for (let i = 0; i < n; i++) { let b = Math.floor((vals[i] - min) / bw); if (b > 255) b = 255; c[b]++; }
          let best = 0;
          for (let b = 1; b < 256; b++) if (c[b] > c[best]) best = b;
          mode = min + best * bw + bw / 2;
        }
      } else {
        const half = n / 2;
        let cum = 0, bestC = -1, found = false;
        median = 0; mode = 0;
        for (let v = 0; v < counts.length; v++) {
          const c = counts[v];
          if (c > bestC) { bestC = c; mode = v; }
          if (!found) { cum += c; if (cum > half) { median = v; found = true; } }
        }
      }
      const area = n * pw * ph;
      return {
        area, mean,
        stdDev: n > 1 ? Math.sqrt(m2 / (n - 1)) : 0,
        min, max, median, mode,
        intDen: area * mean, rawIntDen: sum,
        xCentroid: sx / n * pw, yCentroid: sy / n * ph,
        xCenterOfMass: sum !== 0 ? vx / sum * pw : NaN, yCenterOfMass: sum !== 0 ? vy / sum * ph : NaN,
        skewness: variance > 0 ? m3 / n / Math.pow(variance, 1.5) : NaN,
        kurtosis: variance > 0 ? m4 / n / (variance * variance) - 3 : NaN,
        n
      };
    }

    /* Histogram of the pixels inside the mask. 8-bit: 256 exact bins (binWidth 1)
     * unless bins / min / max are given. 16-bit: integer values binned over
     * [min, max] with scale bins/(max − min + 1) so every integer lands in a
     * bin. 32-bit: scale bins/(max − min), the top value in the last bin.
     * Values outside an explicit [min, max] are not counted. */
    function histogram(ch, mb, opts) {
      const o = opts || {};
      const bins = o.bins || 256;
      const f32 = ch.bitDepth === 32;
      let min = o.min, max = o.max;
      if (min === undefined || max === undefined) {
        let lo = Infinity, hi = -Infinity;
        if (ch.bitDepth === 8) { lo = 0; hi = 255; }
        else forEachIn(ch, mb, (i) => { const v = ch.data[i]; if (f32 && v - v !== 0) return; if (v < lo) lo = v; if (v > hi) hi = v; });
        if (lo > hi) { lo = 0; hi = 0; }
        if (min === undefined) min = lo;
        if (max === undefined) max = hi;
      }
      const counts = new Uint32Array(bins);
      const span = f32 ? max - min : max - min + 1;
      const scale = span > 0 ? bins / span : 0;
      const d = ch.data;
      forEachIn(ch, mb, (i) => {
        const v = d[i];
        if (f32 && v - v !== 0) return;
        if (v < min || v > max) return;
        let b = Math.floor((v - min) * scale);
        if (b >= bins) b = bins - 1;
        counts[b]++;
      });
      return { counts, binWidth: scale > 0 ? 1 / scale : 0, min, max };
    }

    /* ImageJ ContrastAdjuster.autoAdjust on a histogram.
     *   autoThreshold   the value returned by the previous click (0 / unset on the first)
     *   t = autoThreshold < 10 ? 5000 : ⌊autoThreshold / 2⌋   (also returned as nextAutoThreshold)
     *   limit = ⌊pixelCount / 10⌋,  threshold = ⌊pixelCount / t⌋
     *   hmin = first bin whose count (zeroed when > limit) exceeds threshold,  hmax = last such bin
     * opts: histMin / binWidth of the histogram (default 0 / 1), dataMin / dataMax for the fallback
     * when no bin qualifies or hmin and hmax coincide. */
    function autoContrast(hist, pixelCount, autoThreshold, opts) {
      const o = opts || {};
      const histMin = o.histMin || 0, binWidth = o.binWidth || 1;
      const t = !(autoThreshold >= 10) ? 5000 : Math.floor(autoThreshold / 2);
      const limit = Math.floor(pixelCount / 10);
      const threshold = Math.floor(pixelCount / t);
      const n = hist.length;
      let i = -1, found = false;
      do { i++; let c = hist[i]; if (c > limit) c = 0; found = c > threshold; } while (!found && i < n - 1);
      const hmin = i;
      i = n; found = false;
      do { i--; let c = hist[i]; if (c > limit) c = 0; found = c > threshold; } while (!found && i > 0);
      const hmax = i;
      const dataMin = o.dataMin !== undefined ? o.dataMin : histMin;
      const dataMax = o.dataMax !== undefined ? o.dataMax : histMin + (n - 1) * binWidth;
      let min, max;
      if (hmax >= hmin) {
        min = histMin + hmin * binWidth; max = histMin + hmax * binWidth;
        if (min === max) { min = dataMin; max = dataMax; }
      } else { min = dataMin; max = dataMax; }
      return { min, max, nextAutoThreshold: t };
    }

    /* Apply the display range to the pixel data (ImageJ ContrastAdjuster.apply,
     * one table for 8 and 16 bit). min / max are truncated to integers first
     * ((int)getDisplayRangeMin/Max); range = 256 (8-bit) or 65536 (16-bit):
     *   v ≤ min → 0;  v ≥ max → range − 1;  else (int)((v − min)/(max − min) · range). */
    function applyLut(ch, min, max) {
      if (ch.bitDepth === 32) throw fail('IJ_NOT_32BIT', 'apply on 32-bit');
      const out = blank(ch, ch.width, ch.height);
      const range = ch.bitDepth === 8 ? 256 : 65536;
      const mn = Math.trunc(min), mx = Math.trunc(max);
      const table = ch.bitDepth === 8 ? new Uint8Array(range) : new Uint16Array(range);
      for (let v = 0; v < range; v++) {
        if (v <= mn) table[v] = 0;
        else if (v >= mx) table[v] = range - 1;
        else table[v] = Math.trunc((v - mn) / (mx - mn) * range);
      }
      const s = ch.data, d = out.data;
      for (let i = 0; i < s.length; i++) d[i] = table[s[i]];
      return out;
    }

    /* Bit-depth conversion (ImageJ Image › Type).
     * up-conversions keep the values.
     * 16 → 8: v < min → 0, else min(255, ⌊(v − min)·256 / (max − min + 1) + ½⌋)
     * 32 → 8: ⌊(v − min)·255 / (max − min) + ½⌋ clamped to 0…255, NaN → 0
     * 32 → 16: ⌊(v − min)·65535 / (max − min) + ½⌋ clamped to 0…65535
     * min / max default to the data range; scale:false rounds and clamps instead. */
    function convert(ch, to, opts) {
      const o = opts || {};
      const from = ch.bitDepth;
      if (to === from) return copy(ch);
      const out = blank(ch, ch.width, ch.height, to);
      const s = ch.data, d = out.data, n = s.length;
      if (to > from) { for (let i = 0; i < n; i++) d[i] = s[i]; return out; }
      let min = o.min, max = o.max;
      if (min === undefined || max === undefined) {
        const r = IJImage.dataRange(s);
        if (min === undefined) min = r.min;
        if (max === undefined) max = r.max;
      }
      const scale = o.scale !== false;
      const top = to === 8 ? 255 : 65535;
      if (from === 16) { // to 8
        for (let i = 0; i < n; i++) {
          const v = s[i];
          if (!scale) { d[i] = v > 255 ? 255 : v; continue; }
          if (v < min) { d[i] = 0; continue; }
          const r = Math.floor((v - min) * 256 / (max - min + 1) + 0.5);
          d[i] = r > 255 ? 255 : r;
        }
        return out;
      }
      const k = max > min ? top / (max - min) : 0;
      for (let i = 0; i < n; i++) {
        const v = s[i];
        if (v !== v) { d[i] = 0; continue; }
        const r = scale ? Math.floor((v - min) * k + 0.5) : Math.floor(v + 0.5);
        d[i] = r < 0 ? 0 : r > top ? top : r;
      }
      return out;
    }

    /* 8-bit 255 − v. 16-bit: about the data's own range, max + min − v (ImageJ
     * ShortProcessor.invert without Prefs.fullRange16bitInversions); with
     * opts.fullRange (that preference) 65535 − v. 32-bit: FloatProcessor.process
     * INVERT, "v2 = max2 − (v1 − min2)" in float arithmetic, on opts.min / opts.max
     * (the display range ImageJ's FloatProcessor.invert reads), default the finite
     * data range. */
    function invert(ch, opts) {
      const out = blank(ch, ch.width, ch.height);
      const s = ch.data, d = out.data, n = s.length;
      if (ch.bitDepth === 8) { for (let i = 0; i < n; i++) d[i] = 255 - s[i]; return out; }
      const o = opts || {};
      if (ch.bitDepth === 16 && o.fullRange) { for (let i = 0; i < n; i++) d[i] = 65535 - s[i]; return out; }
      const r = IJImage.dataRange(s);
      if (ch.bitDepth === 32) {
        const mn = Math.fround(o.min !== undefined ? o.min : r.min), mx = Math.fround(o.max !== undefined ? o.max : r.max);
        for (let i = 0; i < n; i++) d[i] = Math.fround(mx - Math.fround(Math.fround(s[i]) - mn));
        return out;
      }
      const t = r.max + r.min;
      for (let i = 0; i < n; i++) d[i] = t - s[i];
      return out;
    }

    /* Process › Math. Pixels outside the mask are unchanged.
     * 8/16-bit follows ImageJ's integer tables: the operand of add / subtract /
     * min / max / set is truncated ((int)value), multiply is round(v·value)
     * (Java Math.round, half up), divide multiplies by 1/value and a division by
     * 0 leaves the image unchanged; results are clamped to 0…max.
     * 'min' raises pixels BELOW value to value (ImageJ Min); 'max' lowers pixels ABOVE value to value.
     * 32-bit: IEEE single arithmetic (÷0 → ±Infinity / NaN). abs on unsigned data is the identity. */
    function math(ch, op, value, mb) {
      const valid = ['add', 'subtract', 'multiply', 'divide', 'min', 'max', 'abs', 'set'];
      if (valid.indexOf(op) < 0) throw fail('IJ_BAD_OP', 'math ' + op);
      const out = copy(ch);
      const d = out.data, top = maxValue(ch.bitDepth), f32 = ch.bitDepth === 32;
      if (!f32 && op === 'divide' && value === 0) return out;
      const iv = f32 ? value : Math.trunc(value);
      const inv = f32 ? 0 : 1 / value;
      forEachIn(ch, mb, (i) => {
        const v = d[i];
        let r;
        switch (op) {
          case 'add': r = v + iv; break;
          case 'subtract': r = f32 ? v - value : v + Math.trunc(-value); break;
          case 'multiply': r = f32 ? v * value : roundHalfUp(v * value); break;
          case 'divide': r = f32 ? (value === 0 ? v / 0 : v / value) : roundHalfUp(v * inv); break;
          case 'min': r = v < value ? iv : v; break;
          case 'max': r = v > value ? iv : v; break;
          case 'abs': r = Math.abs(v); break;
          default: r = iv;
        }
        d[i] = f32 ? r : clampInt(Math.floor(r + 0.5), top);
      });
      return out;
    }

    /* The value written by fill / clear: truncated ((int)value) for integer data. */
    function setValue(ch, value) { return ch.bitDepth === 32 ? value : clampInt(Math.trunc(value), maxValue(ch.bitDepth)); }

    function fill(ch, mb, value) {
      const out = copy(ch), v = setValue(ch, value), d = out.data;
      forEachIn(ch, mb, (i) => { d[i] = v; });
      return out;
    }
    function clear(ch, mb, value) { return fill(ch, mb, value || 0); }
    function clearOutside(ch, mb, value) {
      const out = copy(ch);
      if (!mb) return out;
      const v = setValue(ch, value || 0), d = out.data, w = ch.width;
      for (let y = 0; y < ch.height; y++) {
        const inY = y >= mb.y && y < mb.y + mb.h;
        for (let x = 0; x < w; x++) {
          const inside = inY && x >= mb.x && x < mb.x + mb.w && mb.data[(y - mb.y) * mb.w + (x - mb.x)];
          if (!inside) d[y * w + x] = v;
        }
      }
      return out;
    }

    function crop(ch, x, y, w, h) {
      const x0 = Math.max(0, x), y0 = Math.max(0, y), x1 = Math.min(ch.width, x + w), y1 = Math.min(ch.height, y + h);
      if (x1 <= x0 || y1 <= y0) throw fail('IJ_BAD_ROI', 'empty crop');
      const out = blank(ch, x1 - x0, y1 - y0);
      for (let j = y0; j < y1; j++) out.data.set(ch.data.subarray(j * ch.width + x0, j * ch.width + x1), (j - y0) * out.width);
      return out;
    }

    function flipH(ch) {
      const out = blank(ch, ch.width, ch.height), w = ch.width;
      for (let y = 0; y < ch.height; y++) for (let x = 0; x < w; x++) out.data[y * w + x] = ch.data[y * w + (w - 1 - x)];
      return out;
    }
    function flipV(ch) {
      const out = blank(ch, ch.width, ch.height), w = ch.width, h = ch.height;
      for (let y = 0; y < h; y++) out.data.set(ch.data.subarray((h - 1 - y) * w, (h - y) * w), y * w);
      return out;
    }
    /* dir 'right' (clockwise, ImageJ "Rotate 90 Degrees Right") or 'left'. The result is h × w.
     * right: new[x][h−1−y] = old[y][x];   left: new[w−1−x][y] = old[y][x]. */
    function rotate90(ch, dir) {
      const right = dir === 'right' || dir === 1 || dir === 90;
      const left = dir === 'left' || dir === -1 || dir === -90;
      if (!right && !left) throw fail('IJ_BAD_OP', 'rotate dir');
      const w = ch.width, h = ch.height;
      const out = blank(ch, h, w);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const v = ch.data[y * w + x];
          if (right) out.data[x * h + (h - 1 - y)] = v; else out.data[(w - 1 - x) * h + y] = v;
        }
      }
      return out;
    }

    // Bilinear sample with pixel i's value located at coordinate i (ImageJ's
    // getInterpolatedValue); coordinates outside the image are clamped to the edge.
    function bilinear(ch, x, y) {
      const w = ch.width, h = ch.height;
      if (x < 0) x = 0; else if (x > w - 1) x = w - 1;
      if (y < 0) y = 0; else if (y > h - 1) y = h - 1;
      const x0 = Math.floor(x), y0 = Math.floor(y);
      const x1 = x0 + 1 < w ? x0 + 1 : x0, y1 = y0 + 1 < h ? y0 + 1 : y0;
      const fx = x - x0, fy = y - y0, d = ch.data;
      const top = d[y0 * w + x0] * (1 - fx) + d[y0 * w + x1] * fx;
      const bot = d[y1 * w + x0] * (1 - fx) + d[y1 * w + x1] * fx;
      return top * (1 - fy) + bot * fy;
    }

    /* ImageJ ProfilePlot of a straight line. n = round(length) steps → n + 1
     * samples, spacing step = length / n. As ImageJ's Line.getPixels →
     * ImageProcessor.getLine, a sample at (x, y) reads getInterpolatedValue(x, y)
     * at the raw coordinates, with no half-pixel shift: a line snapped to integer
     * endpoints returns exactly the pixels it passes through. Width W = max(1, round(width)): every sample is the
     * mean of W bilinear values across the line at offsets j − (W − 1)/2. */
    function profile(ch, line, width) {
      const dx = line.x2 - line.x1, dy = line.y2 - line.y1;
      const len = Math.sqrt(dx * dx + dy * dy);
      const n = Math.round(len);
      const W = Math.max(1, Math.round(width || line.width || 1));
      const ux = n > 0 ? dx / len : 0, uy = n > 0 ? dy / len : 0;
      const nx = -uy, ny = ux;
      const values = new Float64Array(n + 1);
      for (let k = 0; k <= n; k++) {
        const t = n > 0 ? k / n : 0;
        const cx = line.x1 + dx * t, cy = line.y1 + dy * t;
        let s = 0;
        for (let j = 0; j < W; j++) { const o = j - (W - 1) / 2; s += bilinear(ch, cx + nx * o, cy + ny * o); }
        values[k] = s / W;
      }
      return { values, step: n > 0 ? len / n : 0 };
    }

    /* 2 × 2 mean; width' = ⌈w/2⌉, the odd last row / column replicates itself.
     * 8/16-bit round half up: ⌊(a+b+c+d+2)/4⌋. */
    function downsample2(ch) {
      const w = ch.width, h = ch.height, ow = (w + 1) >> 1, oh = (h + 1) >> 1;
      const out = blank(ch, ow, oh), s = ch.data, d = out.data, f32 = ch.bitDepth === 32;
      for (let y = 0; y < oh; y++) {
        const y0 = y * 2, y1 = y0 + 1 < h ? y0 + 1 : y0;
        for (let x = 0; x < ow; x++) {
          const x0 = x * 2, x1 = x0 + 1 < w ? x0 + 1 : x0;
          const sum = s[y0 * w + x0] + s[y0 * w + x1] + s[y1 * w + x0] + s[y1 * w + x1];
          d[y * ow + x] = f32 ? sum / 4 : Math.floor((sum + 2) / 4);
        }
      }
      return out;
    }

    return { statistics, histogram, autoContrast, applyLut, convert, invert, math, fill, clear, clearOutside, crop, flipH, flipV, rotate90, profile, downsample2 };
  })();

  // ---------------------------------------------------------------- IJProject
  const IJProject = (() => {
    const METHODS = ['max', 'min', 'sum', 'avg', 'sd', 'median'];
    const FLOAT_MAX = 3.4028234663852886e38; // Float.MAX_VALUE

    /* Output bit depth. Without `inputBd` (legacy): sum is 16-bit while
     * 255·depth ≤ 65535 (depth ≤ 257), else 32-bit float; avg / sd / median are
     * 32-bit float; max / min keep 8 bits.
     * With `inputBd` (8, 16 or 32) the rules are ImageJ ZProjector's: max / min / avg
     * keep the input depth (avg rounded half up; a 32-bit average is its own
     * NaN-skipping float path), median is 8-bit for 8-bit input and 32-bit float
     * otherwise, sum and sd are 32-bit float. */
    function outputBitDepth(method, depth, inputBd) {
      if (inputBd) {
        if (method === 'sum' || method === 'sd') return 32;
        if (method === 'median') return inputBd === 8 ? 8 : 32;
        return inputBd;
      }
      if (method === 'max' || method === 'min') return 8;
      if (method === 'sum') return depth <= 257 ? 16 : 32;
      return 32;
    }

    function channelCount(c) { return typeof c === 'number' ? c : Array.isArray(c) ? c.length : 1; }

    function inputDepth(o) {
      const d = o.inputBitDepth;
      if (d === undefined || d === null || d === 8) return 8;
      if (d === 16 || d === 32) return d;
      throw fail('IJ_BAD_DEPTH', 'projection input bit depth ' + d);
    }

    /* Bytes held: the full output images + the accumulators of one band of
     * `bandRows` rows for every channel (the peak while streaming band by band) + the planes of a
     * 16 / 32-bit in-order sum that arrived before their turn. */
    function estimateBytes(o) {
      const C = channelCount(o.channels), w = o.width, h = o.height, depth = o.depth;
      const inBD = inputDepth(o), bytesIn = inBD / 8;
      const bandRows = Math.min(o.bandRows || 64, h);
      const out = C * w * h * (outputBitDepth(o.method, depth, o.inputBitDepth) / 8);
      const P = bandRows * w;
      let band;
      switch (o.method) {
        case 'max': case 'min': band = P * bytesIn; break;
        case 'sum': band = P * 4; break;
        case 'avg': band = inBD === 32 ? P * 12 : P * 4; break; // 32-bit: Float64 sums + Int32 counts
        case 'sd': band = P * 16; break;
        default: band = P * depth * bytesIn;
      }
      // 16 / 32-bit sums are taken in z order: a plane that arrives early waits as a copy (`pending`). With
      // readPages' two requests in flight, up to one run of pages (`pendingPlanes`, default 32) can wait per band.
      const inOrder = inBD !== 8 && (o.method === 'sum' || o.method === 'avg' || o.method === 'sd');
      const wait = inOrder ? Math.min(depth, o.pendingPlanes === undefined ? 32 : Math.max(0, o.pendingPlanes | 0)) * P * bytesIn : 0;
      return out + C * (band + wait);
    }

    const TAGS = { 8: ['[object Uint8Array]', '[object Uint8ClampedArray]'], 16: ['[object Uint16Array]'], 32: ['[object Float32Array]'] };

    function create(o) {
      const method = o.method;
      if (METHODS.indexOf(method) < 0) throw fail('IJ_BAD_OP', 'projection ' + method);
      const width = o.width | 0, height = o.height | 0, depth = o.depth | 0, C = channelCount(o.channels);
      if (!(width > 0 && height > 0 && depth > 0 && C > 0)) throw fail('IJ_BAD_SIZE', 'projection size');
      const inBD = inputDepth(o);
      const outBD = outputBitDepth(method, depth, o.inputBitDepth);
      // sums of 16 / 32-bit input are float or double running sums: z order matters
      const inOrder = inBD !== 8 && (method === 'sum' || method === 'avg' || method === 'sd');
      const outs = [];
      for (let c = 0; c < C; c++) outs.push(typedArrayFor(outBD, width * height));
      const rowsDone = new Array(C).fill(0);
      const bands = new Map(); // "y0:rows" → { y0, rows, ch: [state | null | 'done'] }
      let received = 0;
      const total = C * height * depth;

      function newState(P) {
        const s = { seen: new Uint8Array(depth), got: 0, next: 0, pending: inOrder ? new Map() : null };
        switch (method) {
          case 'max':
            s.a = inBD === 8 ? new Uint8Array(P) : inBD === 16 ? new Uint16Array(P) : new Float32Array(P).fill(-FLOAT_MAX);
            break;
          case 'min':
            s.a = inBD === 8 ? new Uint8Array(P).fill(255) : inBD === 16 ? new Uint16Array(P).fill(65535) : new Float32Array(P).fill(FLOAT_MAX);
            break;
          case 'sum': s.a = inBD === 8 ? new Uint32Array(P) : new Float32Array(P); break; // ZProjector adds in float
          case 'avg':
            if (inBD === 8) s.a = new Uint32Array(P);
            else if (inBD === 16) s.a = new Float32Array(P);
            else { s.a = new Float64Array(P); s.n = new Int32Array(P); } // doAverageFloatProjection
            break;
          case 'sd': s.a = new Float64Array(P); s.b = new Float64Array(P); break;
          default: s.raw = inBD === 8 ? new Uint8Array(P * depth) : inBD === 16 ? new Uint16Array(P * depth) : new Float32Array(P * depth);
        }
        return s;
      }

      function accumulate(s, plane, P) {
        switch (method) {
          case 'max': { const a = s.a; for (let i = 0; i < P; i++) if (plane[i] > a[i]) a[i] = plane[i]; break; }
          case 'min': { const a = s.a; for (let i = 0; i < P; i++) if (plane[i] < a[i]) a[i] = plane[i]; break; }
          case 'sum': { const a = s.a; for (let i = 0; i < P; i++) a[i] += plane[i]; break; }
          case 'avg': {
            const a = s.a;
            if (inBD === 32) { const n = s.n; for (let i = 0; i < P; i++) { const v = plane[i]; if (v === v) { a[i] += v; n[i]++; } } }
            else for (let i = 0; i < P; i++) a[i] += plane[i];
            break;
          }
          case 'sd': { const a = s.a, b = s.b; for (let i = 0; i < P; i++) { const v = plane[i]; a[i] += v; b[i] += v * v; } break; }
          default: break;
        }
      }

      /* ZProjector.StandardDeviation.postProcess, term for term (NaN sums give 0 there too). */
      function sdValue(sum, sum2) {
        if (depth < 2) return 0;
        const n = depth, sd = (n * sum2 - sum * sum) / n;
        return sd > 0 ? Math.sqrt(sd / (n - 1)) : 0;
      }

      function finalize(c, band, s) {
        const out = outs[c], P = band.rows * width, base = band.y0 * width;
        switch (method) {
          case 'max': case 'min': case 'sum': for (let i = 0; i < P; i++) out[base + i] = s.a[i]; break;
          case 'avg':
            if (inBD === 8) for (let i = 0; i < P; i++) out[base + i] = outBD < 32 ? Math.floor(s.a[i] / depth + 0.5) : s.a[i] / depth;
            else if (inBD === 16) { // float mean, then (short)(mean + 0.5f)
              for (let i = 0; i < P; i++) out[base + i] = Math.fround(Math.fround(s.a[i] / depth) + 0.5) | 0;
            } else for (let i = 0; i < P; i++) out[base + i] = s.a[i] / s.n[i]; // (float)(sum / count); 0 / 0 = NaN
            break;
          case 'sd':
            for (let i = 0; i < P; i++) out[base + i] = sdValue(s.a[i], s.b[i]);
            break;
          default: { // median: even n → mean of the two middle values
            const kLo = (depth - 1) >> 1, kHi = depth >> 1, raw = s.raw;
            if (inBD === 8) { // counting sort per pixel; 8-bit result rounded half up
              const counts = new Uint32Array(256);
              for (let p = 0; p < P; p++) {
                for (let z = 0; z < depth; z++) counts[raw[z * P + p]]++;
                let cum = 0, lo = -1, hi = -1;
                for (let v = 0; v < 256; v++) {
                  cum += counts[v];
                  if (lo < 0 && cum > kLo) lo = v;
                  if (cum > kHi) { hi = v; break; }
                }
                out[base + p] = outBD < 32 ? Math.floor((lo + hi) / 2 + 0.5) : (lo + hi) / 2;
                for (let z = 0; z < depth; z++) counts[raw[z * P + p]] = 0;
              }
            } else { // 16 / 32-bit: Arrays.sort (NaN last), float (a + b) / 2f
              const scratch = inBD === 16 ? new Uint16Array(depth) : new Float32Array(depth);
              for (let p = 0; p < P; p++) {
                for (let z = 0; z < depth; z++) scratch[z] = raw[z * P + p];
                scratch.sort();
                out[base + p] = (depth & 1) ? scratch[kHi] : Math.fround(Math.fround(scratch[kLo] + scratch[kHi]) / 2);
              }
            }
          }
        }
        rowsDone[c] += band.rows;
      }

      /* block: { channel, y0, rows, z0, depth: d, data } — data is z-major
       * (plane, row, column) of d·rows·width samples of the input bit depth (Uint8Array,
       * Uint16Array or Float32Array). Blocks of one band may arrive in any z order;
       * planes are placed by index, never by arrival. */
      function addBlock(b) {
        const c = b.channel | 0, y0 = b.y0 | 0, rows = b.rows | 0, z0 = b.z0 | 0, d = b.depth | 0;
        if (c < 0 || c >= C || y0 < 0 || rows <= 0 || y0 + rows > height || z0 < 0 || d <= 0 || z0 + d > depth) throw fail('IJ_BAD_BLOCK', 'block range');
        const P = rows * width;
        if (!b.data || b.data.length !== d * P) throw fail('IJ_BAD_BLOCK', 'block size');
        if (TAGS[inBD].indexOf(Object.prototype.toString.call(b.data)) < 0) throw fail('IJ_BAD_BLOCK', 'block type');
        const key = y0 + ':' + rows;
        let band = bands.get(key);
        if (!band) {
          for (const o2 of bands.values()) if (y0 < o2.y0 + o2.rows && o2.y0 < y0 + rows) throw fail('IJ_BAD_BLOCK', 'overlapping band');
          band = { y0, rows, ch: new Array(C).fill(null) };
          bands.set(key, band);
        }
        if (band.ch[c] === 'done') throw fail('IJ_BAD_BLOCK', 'band already complete');
        const s = band.ch[c] || (band.ch[c] = newState(P));
        for (let zi = 0; zi < d; zi++) if (s.seen[z0 + zi]) throw fail('IJ_BAD_BLOCK', 'plane repeated');
        for (let zi = 0; zi < d; zi++) {
          const plane = b.data.subarray(zi * P, (zi + 1) * P);
          s.seen[z0 + zi] = 1;
          if (method === 'median') s.raw.set(plane, (z0 + zi) * P);
          else if (inOrder) {
            // float / double running sums are not associative: ImageJ adds the planes in z order, so a plane
            // that arrives early waits (a private copy: the caller reuses its block) for the ones before it
            if (z0 + zi !== s.next) { s.pending.set(z0 + zi, plane.slice()); continue; }
            accumulate(s, plane, P);
            s.next++;
            for (let q = s.pending.get(s.next); q; q = s.pending.get(s.next)) { s.pending.delete(s.next); accumulate(s, q, P); s.next++; }
          } else accumulate(s, plane, P);
        }
        s.got += d;
        received += d * rows;
        if (s.got === depth) { finalize(c, band, s); band.ch[c] = 'done'; }
      }

      function finish() {
        for (let c = 0; c < C; c++) if (rowsDone[c] !== height) throw fail('IJ_INCOMPLETE', 'projection incomplete');
        return outs.map((data) => ({ data, bitDepth: outBD }));
      }

      return {
        outputBitDepth: outBD,
        addBlock,
        progress: () => received / total,
        finish,
        estimateBytes: (bandRows) => estimateBytes({ method, width, height, depth, channels: C, bandRows, inputBitDepth: o.inputBitDepth })
      };
    }

    return { create, estimateBytes, outputBitDepth };
  })();

  // ---------------------------------------------------------------- IJTiff
  const IJTiff = (() => {
    const MAGIC = 0x494a494a; // 'IJIJ', ImageJ metadata header
    const T_LABL = 0x6c61626c, T_RANG = 0x72616e67, T_LUTS = 0x6c757473;
    const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };

    function unsupported(msg) { return fail('IJ_TIFF_UNSUPPORTED', msg || 'unsupported TIFF'); }
    function fmtNum(v) { return Number.isInteger(v) ? v.toFixed(1) : String(v); }

    function pixelBytesLE(data) {
      const u8 = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      if (LE || data.BYTES_PER_ELEMENT === 1) return u8;
      const sw = new Uint8Array(u8.length), k = data.BYTES_PER_ELEMENT;
      for (let i = 0; i < u8.length; i += k) for (let j = 0; j < k; j++) sw[i + j] = u8[i + k - 1 - j];
      return sw;
    }

    function planar(t) {
      const p = new Uint8Array(768);
      for (let i = 0; i < 256; i++) { p[i] = t[i * 3]; p[256 + i] = t[i * 3 + 1]; p[512 + i] = t[i * 3 + 2]; }
      return p;
    }
    // An inverting display is stored as the reversed table.
    function lutBytes(display) {
      const t = IJLuts.get(display.lut || 'Grays');
      if (!display.invert) return planar(t);
      const r = new Uint8Array(768);
      for (let i = 0; i < 256; i++) { const j = 255 - i; r[i * 3] = t[j * 3]; r[i * 3 + 1] = t[j * 3 + 1]; r[i * 3 + 2] = t[j * 3 + 2]; }
      return planar(r);
    }

    /* ImageJ metadata (tags 50838 byte counts / 50839 data): magic, (type, count)
     * pairs, then the entries in the same order — slice labels ('labl', UTF-16),
     * display ranges ('rang', 2 doubles per channel) and LUTs ('luts', planar
     * r,g,b × 256 per channel). All integers use the file's (little) byte order,
     * which is also how ImageJ and tifffile read the block. */
    function buildMetadata(img) {
      const C = img.channels.length;
      const parts = [], counts = [];
      const hdr = new Uint8Array(4 + 8 * 3);
      const hv = new DataView(hdr.buffer);
      hv.setUint32(0, MAGIC, true);
      hv.setUint32(4, T_LABL, true); hv.setUint32(8, C, true);
      hv.setUint32(12, T_RANG, true); hv.setUint32(16, 1, true);
      hv.setUint32(20, T_LUTS, true); hv.setUint32(24, C, true);
      parts.push(hdr); counts.push(hdr.length);
      for (const ch of img.channels) {
        const s = String(ch.name || '');
        const b = new Uint8Array(s.length * 2), v = new DataView(b.buffer);
        for (let i = 0; i < s.length; i++) v.setUint16(i * 2, s.charCodeAt(i), true);
        parts.push(b); counts.push(b.length);
      }
      const rang = new Uint8Array(C * 16), rv = new DataView(rang.buffer);
      img.channels.forEach((ch, i) => { rv.setFloat64(i * 16, ch.display.min, true); rv.setFloat64(i * 16 + 8, ch.display.max, true); });
      parts.push(rang); counts.push(rang.length);
      for (const ch of img.channels) { const l = lutBytes(ch.display); parts.push(l); counts.push(l.length); }
      let total = 0;
      for (const p of parts) total += p.length;
      const bytes = new Uint8Array(total);
      let o = 0;
      for (const p of parts) { bytes.set(p, o); o += p.length; }
      return { bytes, counts };
    }

    function ascii(s) { const b = new Uint8Array(s.length + 1); for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0x7f; return b; }
    function u32le(arr) { const b = new Uint8Array(arr.length * 4), v = new DataView(b.buffer); arr.forEach((x, i) => v.setUint32(i * 4, x, true)); return b; }

    /* One uncompressed IFD per channel (single strip), data back to back after
     * the directories. Resolution tags carry pixels per unit as num / 10^k
     * (ResolutionUnit 1 = none, `unit=micron` in the ImageJ description).
     * Larger than 4 GiB → IJ_TOO_LARGE. */
    function write(img) {
      const C = img.channels.length, W = img.width, H = img.height, bd = img.bitDepth;
      if (!C || !(W > 0 && H > 0) || [8, 16, 32].indexOf(bd) < 0) throw fail('IJ_BAD_SIZE', 'image');
      const planeBytes = W * H * (bd / 8);
      for (const ch of img.channels) if (ch.data.length !== W * H) throw fail('IJ_BAD_SIZE', 'channel size');
      const cal = img.calibration || { pixelWidth: 1, pixelHeight: 1, unit: 'px' };
      const calibrated = !!cal.unit && cal.unit !== 'px' && cal.unit !== 'pixel';
      const unitName = cal.unit === 'µm' || cal.unit === 'um' || cal.unit === 'micron' ? 'micron' : cal.unit;
      const d0 = img.channels[0].display;
      let desc = 'ImageJ=1.54f\nimages=' + C + '\nchannels=' + C + '\nslices=1\nframes=1\nhyperstack=true\nmode=' + (C > 1 ? 'composite' : 'grayscale') + '\n';
      if (calibrated) desc += 'unit=' + unitName + '\n';
      desc += 'min=' + fmtNum(d0.min) + '\nmax=' + fmtNum(d0.max) + '\n';
      const meta = buildMetadata(img);

      const rat = (v) => {
        let den = 1000000, num = Math.round(v * den);
        while (num > 0xffffffff && den > 1) { den = Math.floor(den / 10); num = Math.round(v * den); }
        const b = new Uint8Array(8), dv = new DataView(b.buffer);
        dv.setUint32(0, num >>> 0, true); dv.setUint32(4, den, true);
        return b;
      };

      // entry: { tag, type, count, inline: number | 'DATA', blob: Uint8Array }
      const ifdEntries = (c) => {
        const e = [
          { tag: 256, type: 4, count: 1, inline: W }, { tag: 257, type: 4, count: 1, inline: H },
          { tag: 258, type: 3, count: 1, inline: bd }, { tag: 259, type: 3, count: 1, inline: 1 },
          { tag: 262, type: 3, count: 1, inline: 1 }
        ];
        if (c === 0) e.push({ tag: 270, type: 2, count: desc.length + 1, blob: ascii(desc) });
        e.push({ tag: 273, type: 4, count: 1, inline: 'DATA' }, { tag: 277, type: 3, count: 1, inline: 1 },
          { tag: 278, type: 4, count: 1, inline: H }, { tag: 279, type: 4, count: 1, inline: planeBytes });
        if (calibrated) e.push({ tag: 282, type: 5, count: 1, blob: rat(1 / cal.pixelWidth) }, { tag: 283, type: 5, count: 1, blob: rat(1 / cal.pixelHeight) });
        e.push({ tag: 284, type: 3, count: 1, inline: 1 }, { tag: 296, type: 3, count: 1, inline: 1 }, { tag: 339, type: 3, count: 1, inline: bd === 32 ? 3 : 1 });
        if (c === 0) e.push({ tag: 50838, type: 4, count: meta.counts.length, blob: u32le(meta.counts) }, { tag: 50839, type: 1, count: meta.bytes.length, blob: meta.bytes });
        return e;
      };
      const all = [];
      for (let c = 0; c < C; c++) all.push(ifdEntries(c));
      let pos = 8;
      const ifdOff = [];
      for (let c = 0; c < C; c++) { ifdOff.push(pos); pos += 2 + all[c].length * 12 + 4; }
      for (const list of all) for (const e of list) {
        if (e.blob && e.blob.length > 4) { if (pos & 1) pos++; e.off = pos; pos += e.blob.length; }
      }
      if (pos & 1) pos++;
      const dataStart = pos;
      const totalSize = dataStart + C * planeBytes;
      if (totalSize > 0xffffffff) throw fail('IJ_TOO_LARGE', 'over 4 GiB');

      const out = new Uint8Array(totalSize), dv = new DataView(out.buffer);
      out[0] = 0x49; out[1] = 0x49; dv.setUint16(2, 42, true); dv.setUint32(4, ifdOff[0], true);
      for (let c = 0; c < C; c++) {
        let p = ifdOff[c];
        dv.setUint16(p, all[c].length, true); p += 2;
        for (const e of all[c]) {
          dv.setUint16(p, e.tag, true); dv.setUint16(p + 2, e.type, true); dv.setUint32(p + 4, e.count, true);
          if (e.blob) {
            if (e.blob.length > 4) { dv.setUint32(p + 8, e.off, true); out.set(e.blob, e.off); } else out.set(e.blob, p + 8);
          } else {
            const val = e.inline === 'DATA' ? dataStart + c * planeBytes : e.inline;
            if (e.type === 3) dv.setUint16(p + 8, val, true); else dv.setUint32(p + 8, val, true);
          }
          p += 12;
        }
        dv.setUint32(p, c + 1 < C ? ifdOff[c + 1] : 0, true);
        out.set(pixelBytesLE(img.channels[c].data), dataStart + c * planeBytes);
      }
      return out;
    }

    function parseDescription(s) {
      const o = {};
      for (const line of s.split(/\r?\n/)) { const k = line.indexOf('='); if (k > 0) o[line.slice(0, k)] = line.slice(k + 1); }
      return o;
    }

    /* Uncompressed, strip-organised, single-sample 8/16/32-bit (float) TIFF,
     * little or big endian. Planes become channels. ImageJ's one-IFD stacks
     * (`images=N`, planes back to back) and one-IFD-per-plane files both read.
     * Anything else → IJ_TIFF_UNSUPPORTED. */
    function read(input, name) {
      const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
      if (bytes.length < 8) throw unsupported('short');
      const le = bytes[0] === 0x49 && bytes[1] === 0x49;
      if (!le && !(bytes[0] === 0x4d && bytes[1] === 0x4d)) throw unsupported('not TIFF');
      const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const ver = dv.getUint16(2, le);
      if (ver !== 42) throw unsupported(ver === 43 ? 'BigTIFF' : 'version');
      const inFile = (o, n) => o >= 0 && n >= 0 && o + n <= bytes.length;

      const ifds = [];
      const seen = new Set();
      let off = dv.getUint32(4, le);
      while (off) {
        if (seen.has(off) || ifds.length > 65536 || !inFile(off, 2)) throw unsupported('bad IFD chain');
        seen.add(off);
        const n = dv.getUint16(off, le);
        if (!inFile(off + 2, n * 12 + 4)) throw unsupported('bad IFD');
        const tags = {};
        for (let i = 0; i < n; i++) {
          const e = off + 2 + i * 12;
          const tag = dv.getUint16(e, le), type = dv.getUint16(e + 2, le), count = dv.getUint32(e + 4, le);
          const sz = TYPE_SIZE[type];
          if (!sz) continue;
          const bytesLen = sz * count;
          const at = bytesLen <= 4 ? e + 8 : dv.getUint32(e + 8, le);
          if (!inFile(at, bytesLen)) throw unsupported('bad tag');
          tags[tag] = { type, count, at, bytesLen };
        }
        ifds.push(tags);
        off = dv.getUint32(off + 2 + n * 12, le);
      }
      if (!ifds.length) throw unsupported('no IFD');

      const nums = (t) => {
        const a = new Array(t.count);
        for (let i = 0; i < t.count; i++) {
          const p = t.at + i * TYPE_SIZE[t.type];
          switch (t.type) {
            case 1: case 7: a[i] = bytes[p]; break;
            case 3: a[i] = dv.getUint16(p, le); break;
            case 4: a[i] = dv.getUint32(p, le); break;
            case 5: { const d = dv.getUint32(p + 4, le); a[i] = d ? dv.getUint32(p, le) / d : 0; break; }
            case 12: a[i] = dv.getFloat64(p, le); break;
            default: throw unsupported('tag type');
          }
        }
        return a;
      };
      const one = (tags, id, dflt) => (tags[id] ? nums(tags[id])[0] : dflt);

      const t0 = ifds[0];
      let desc = {};
      if (t0[270] && t0[270].type === 2) {
        let s = '';
        for (let i = 0; i < t0[270].count; i++) { const c = bytes[t0[270].at + i]; if (!c) break; s += String.fromCharCode(c); }
        desc = parseDescription(s);
      }

      const W = one(t0, 256), H = one(t0, 257), bd = one(t0, 258, 1);
      if (!(W > 0 && H > 0)) throw unsupported('size');
      if ([8, 16, 32].indexOf(bd) < 0) throw unsupported('bit depth');
      const planeBytes = W * H * (bd / 8);
      if ((parseInt(desc.slices, 10) || 1) * (parseInt(desc.frames, 10) || 1) > 1) throw unsupported('z / t stacks');

      const planes = [];
      for (const tags of ifds) {
        if (one(tags, 256) !== W || one(tags, 257) !== H || one(tags, 258, 1) !== bd) throw unsupported('mixed planes');
        if (one(tags, 259, 1) !== 1) throw unsupported('compression');
        if (one(tags, 277, 1) !== 1) throw unsupported('samples per pixel');
        if (one(tags, 284, 1) !== 1) throw unsupported('planar');
        if (tags[322] || tags[324]) throw unsupported('tiles');
        if (one(tags, 317, 1) !== 1) throw unsupported('predictor');
        const photo = one(tags, 262, 1);
        if (photo !== 0 && photo !== 1) throw unsupported('photometric');
        if (one(tags, 339, 1) !== (bd === 32 ? 3 : 1)) throw unsupported('sample format');
        if (!tags[273] || !tags[279]) throw unsupported('strips');
        const so = nums(tags[273]), sc = nums(tags[279]);
        if (so.length !== sc.length) throw unsupported('strips');
        planes.push({ so, sc, photo });
      }

      // ImageJ stacks: one IFD + `images=N` means N planes back to back.
      const images = parseInt(desc.images, 10) || 1;
      let sources;
      if (ifds.length === 1 && images > 1) {
        const first = planes[0].so[0];
        sources = [];
        for (let k = 0; k < images; k++) sources.push([{ o: first + k * planeBytes, n: planeBytes }]);
      } else {
        sources = planes.map((p) => {
          let have = 0;
          const runs = [];
          for (let i = 0; i < p.so.length && have < planeBytes; i++) {
            const n = Math.min(p.sc[i], planeBytes - have);
            runs.push({ o: p.so[i], n }); have += n;
          }
          if (have !== planeBytes) throw unsupported('strip size');
          return runs;
        });
      }

      const Ctor = bd === 8 ? Uint8Array : bd === 16 ? Uint16Array : Float32Array;
      const datas = sources.map((runs) => {
        const buf = new Uint8Array(planeBytes);
        let at = 0;
        for (const r of runs) {
          if (!inFile(r.o, r.n)) throw unsupported('data out of file');
          buf.set(bytes.subarray(r.o, r.o + r.n), at); at += r.n;
        }
        if (bd > 8 && le !== LE) { // swap into host order
          const k = bd / 8;
          for (let i = 0; i < buf.length; i += k) for (let a = 0, b = k - 1; a < b; a++, b--) { const t = buf[i + a]; buf[i + a] = buf[i + b]; buf[i + b] = t; }
        }
        return new Ctor(buf.buffer);
      });

      // ImageJ metadata: labels, display ranges, LUTs
      let labels = null, ranges = null, luts = null;
      const tc = t0[50838], td = t0[50839];
      if (tc && td && tc.type === 4) {
        const counts = nums(tc);
        let p = td.at;
        const end = td.at + td.bytesLen;
        if (counts.length && counts[0] >= 4 && p + counts[0] <= end && dv.getUint32(p, le) === MAGIC) {
          const nTypes = (counts[0] - 4) / 8;
          const types = [];
          for (let i = 0; i < nTypes; i++) types.push({ type: dv.getUint32(p + 4 + i * 8, le), count: dv.getUint32(p + 8 + i * 8, le) });
          p += counts[0];
          let ci = 1;
          for (const t of types) {
            for (let k = 0; k < t.count; k++) {
              const n = counts[ci++];
              if (n === undefined || p + n > end) throw unsupported('metadata');
              if (t.type === T_RANG) {
                ranges = [];
                for (let q = 0; q + 16 <= n; q += 16) ranges.push([dv.getFloat64(p + q, le), dv.getFloat64(p + q + 8, le)]);
              } else if (t.type === T_LUTS && n === 768) {
                const tab = new Uint8Array(768);
                for (let i = 0; i < 256; i++) { tab[i * 3] = bytes[p + i]; tab[i * 3 + 1] = bytes[p + 256 + i]; tab[i * 3 + 2] = bytes[p + 512 + i]; }
                (luts || (luts = [])).push(tab);
              } else if (t.type === T_LABL) {
                let s = '';
                for (let q = 0; q + 2 <= n; q += 2) s += String.fromCharCode(dv.getUint16(p + q, le));
                (labels || (labels = [])).push(s);
              }
              p += n;
            }
          }
        }
      }

      // calibration: pixels per unit → size of a pixel
      const cal = { pixelWidth: 1, pixelHeight: 1, unit: 'px' };
      if (t0[282] && t0[283]) {
        const xr = nums(t0[282])[0], yr = nums(t0[283])[0], ru = one(t0, 296, 2);
        if (xr > 0 && yr > 0) {
          if (desc.unit) { cal.unit = /^(micron|um|µm|μm)$/i.test(desc.unit) ? 'µm' : desc.unit; cal.pixelWidth = 1 / xr; cal.pixelHeight = 1 / yr; }
          else if (ru === 3) { cal.unit = 'µm'; cal.pixelWidth = 10000 / xr; cal.pixelHeight = 10000 / yr; }
          else if (ru === 2) { cal.unit = 'µm'; cal.pixelWidth = 25400 / xr; cal.pixelHeight = 25400 / yr; }
        }
      }

      const dMin = desc.min !== undefined ? parseFloat(desc.min) : NaN, dMax = desc.max !== undefined ? parseFloat(desc.max) : NaN;
      const base = { Grays: '#ffffff', Red: '#ff0000', Green: '#00ff00', Blue: '#0000ff', Cyan: '#00ffff', Magenta: '#ff00ff', Yellow: '#ffff00' };
      const channels = datas.map((data, i) => {
        const ch = { name: labels && labels[i] ? labels[i] : 'C' + (i + 1), color: '#ffffff', data };
        const disp = IJImage.defaultDisplay(ch, bd);
        if (ranges && ranges[i]) { disp.min = ranges[i][0]; disp.max = ranges[i][1]; }
        else if (dMin === dMin && dMax === dMax) { disp.min = dMin; disp.max = dMax; }
        if (luts && luts[i]) {
          const id = IJLuts.identify(luts[i]);
          disp.lut = id.lut; disp.invert = id.invert;
          if (typeof id.lut === 'string') ch.color = id.lut.charAt(0) === '#' ? id.lut : (base[id.lut] || '#ffffff');
        } else if (planes[Math.min(i, planes.length - 1)].photo === 0) disp.invert = true;
        ch.display = disp;
        return ch;
      });
      return { name: name || 'Untitled', width: W, height: H, bitDepth: bd, channels, calibration: cal, provenance: null };
    }

    return { write, read };
  })();

  // ---------------------------------------------------------------- IJOpRegistry
  /* The operation registry of the Advanced Studio (PLAN-wave2 §2.1). Page and worker both load
   * this file, so both see the same names; a package registers its operations in its own
   * `ij-proc-<pkg>.js`. The engine (ij-engine.js) is the only consumer that RUNS a spec.
   *
   *   IJOpRegistry.define(name, spec)  idempotent for the same spec object; IJ_BAD_ARGS for a
   *                                    different spec under the same name or a malformed spec
   *   IJOpRegistry.get(name) → spec | null
   *   IJOpRegistry.list(kind?) → [name]
   *   IJOpRegistry.unregister(name)    (the worker's package loader only)
   *
   * spec = {
   *   kind:       'pixel' | 'size' | 'newdoc' | 'compute'
   *   version:    positive integer, written in the journal entry; a replay of an entry whose
   *               version differs from the registered one stops (IJ_REPLAY_STOPPED, the stored journal is kept)
   *   bitDepths:  [8, 16, 32] (default all) — another depth fails with IJ_BAD_TYPE
   *   channels:   'each' | 'one' | 'all'   (pixel: per channel / the one channel the request names, else the
   *               active one, journaled as such / every channel as one step; compute + newdoc: 'one' = the
   *               channel the request names, in io.channel; default 'each' for pixel, 'one' otherwise)
   *   roi:        'mask' | 'bounds' | 'ignore'   what a selection means (default 'mask')
   *   preview:    false | 'region' | 'reduced'  (default 'region' for pixel, false otherwise)
   *   validate(params, info)            throws IJ_BAD_ARGS. info = { width, height, bitDepth, channels, region,
   *                                     docs: [{ width, height, bitDepth, channels }] of the other documents named in docIds }
   *   resolve(view, params, chans)      → params with the non-journaled state (display range, threshold…) copied in.
   *                                     Called ONCE, when the request is accepted (the result is what the journal
   *                                     stores); NEVER on a replay, where the state is not the one of that moment.
   *                                     Keep it idempotent: fill what is missing, keep what the caller gave.
   *   scratchBytes(info, params)        → bytes the algorithm allocates. pixel: BESIDE the new arrays and the undo
   *                                     patch the engine counts itself. size / newdoc / compute: the op's whole peak,
   *                                     its output included. The engine reserves it BEFORE run (IJ_OVER_BUDGET, run
   *                                     never starts) and releases it when run returns; io.reserve(n) draws on it first.
   *   prepare(view, c, params, ctx)     (pixel)  → { apron:{x,y}, fn(src) | region(full, rect), whole? }; fn / region
   *                                     may be async. ctx = { scale, range(c), dep, check(), tick(f, stepKey?) }
   *   run(view, params, roi, io)        (size | newdoc | compute)
   * }
   * v1 flags kept for the built-in operations: outside, needsRoi, display, whole. */
  const IJOpRegistry = (() => {
    const specs = new Map();
    const KINDS = ['pixel', 'size', 'newdoc', 'compute'];

    function bad(msg) { return fail('IJ_BAD_ARGS', msg); }

    function normalize(name, spec) {
      if (typeof name !== 'string' || !/^[A-Za-z][A-Za-z0-9]*$/.test(name)) throw bad('op name');
      if (!spec || typeof spec !== 'object') throw bad('op spec ' + name);
      if (KINDS.indexOf(spec.kind) < 0) throw bad('op kind ' + name);
      if (!Number.isInteger(spec.version) || spec.version < 1) throw bad('op version ' + name);
      if (spec.bitDepths === undefined) spec.bitDepths = [8, 16, 32];
      if (!Array.isArray(spec.bitDepths) || !spec.bitDepths.length || spec.bitDepths.some((b) => b !== 8 && b !== 16 && b !== 32)) throw bad('op bitDepths ' + name);
      if (spec.channels === undefined) spec.channels = spec.kind === 'pixel' ? 'each' : 'one';
      if (['each', 'one', 'all'].indexOf(spec.channels) < 0) throw bad('op channels ' + name);
      if (spec.roi === undefined) spec.roi = 'mask';
      if (['mask', 'bounds', 'ignore'].indexOf(spec.roi) < 0) throw bad('op roi ' + name);
      if (spec.preview === undefined) spec.preview = spec.kind === 'pixel' ? 'region' : false;
      if (spec.preview !== false && spec.preview !== 'region' && spec.preview !== 'reduced') throw bad('op preview ' + name);
      if (spec.kind !== 'pixel' && spec.preview !== false) throw bad('only a pixel op previews ' + name);
      for (const f of ['validate', 'resolve', 'scratchBytes']) if (spec[f] !== undefined && typeof spec[f] !== 'function') throw bad('op ' + f + ' ' + name);
      // display: true = the step resets the display range of the channels it changes (resetMinAndMax) as part of its undo step;
      // '16/32' = only on a 16 or 32-bit image (8-bit keeps its range). docless: a compute op that needs no document (run gets view = null).
      if (spec.display !== undefined && spec.display !== true && spec.display !== false && spec.display !== '16/32') throw bad('op display ' + name);
      if (spec.docless !== undefined && typeof spec.docless !== 'boolean') throw bad('op docless ' + name);
      if (spec.docless && spec.kind !== 'compute') throw bad('only a compute op can be docless ' + name);
      if (spec.kind === 'pixel') { if (typeof spec.prepare !== 'function') throw bad('op prepare ' + name); }
      else if (typeof spec.run !== 'function') throw bad('op run ' + name);
      return spec;
    }

    function define(name, spec) {
      const old = specs.get(name);
      if (old) {
        if (old === spec) return spec;
        throw bad('op ' + name + ' is already defined');
      }
      normalize(name, spec);
      specs.set(name, spec);
      return spec;
    }
    function get(name) { return specs.get(name) || null; }
    function list(kind) {
      const out = [];
      for (const [n, sp] of specs) if (!kind || sp.kind === kind) out.push(n);
      return out;
    }
    // Only the worker's package loader uses this: the ops a package registered before it threw are
    // withdrawn, so a half-loaded package cannot leave half its commands working.
    function unregister(name) { return specs.delete(name); }

    // ── worker commands of a package (PLAN-wave3 §2.6) ──
    // A package whose work does not fit "an op on a document" (a streaming accumulator, a library read) registers a
    // worker command of its own. The engine dispatches an unknown `cmd` name to it, the page's api.call may reach
    // it only from the package that registered it. Page and worker both load the package file, so both see the
    // names; only the worker ever runs a handler.
    //   IJOpRegistry.defineCommand(name, { pkg, long?, handler(args, E) })   name: 'doc.tiff.project' (lower-case
    //                              first segment, at least one dot; `engine.` and `session.` belong to the engine)
    //   IJOpRegistry.getCommand(name) → spec | null    listCommands(pkg?) → [name]
    //   IJOpRegistry.unregisterCommand(name)           the worker's package loader (a package that failed to load);
    //                              the name is remembered: a request for it answers IJ_MODULE_MISSING, not IJ_UNKNOWN_CMD
    const commands = new Map();
    const withdrawnCommands = new Set();
    function defineCommand(name, spec) {
      if (typeof name !== 'string' || !/^[a-z][A-Za-z0-9]*(\.[A-Za-z][A-Za-z0-9]*)+$/.test(name) || /^(engine|session)\./.test(name)) throw bad('command name');
      if (!spec || typeof spec !== 'object' || typeof spec.pkg !== 'string' || !/^[a-z][a-z0-9]*$/.test(spec.pkg)) throw bad('command pkg ' + name);
      if (typeof spec.handler !== 'function') throw bad('command handler ' + name);
      if (spec.long !== undefined && typeof spec.long !== 'boolean') throw bad('command long ' + name);
      const old = commands.get(name);
      if (old) {
        if (old === spec) return spec;
        throw bad('command ' + name + ' is already defined');
      }
      commands.set(name, spec);
      withdrawnCommands.delete(name);
      return spec;
    }
    function getCommand(name) { return commands.get(name) || null; }
    function listCommands(pkg) {
      const out = [];
      for (const [n, sp] of commands) if (!pkg || sp.pkg === pkg) out.push(n);
      return out;
    }
    function unregisterCommand(name) {
      const had = commands.delete(name);
      if (had) withdrawnCommands.add(name);
      return had;
    }
    function isWithdrawnCommand(name) { return withdrawnCommands.has(name); }
    return { define, get, list, unregister, defineCommand, getCommand, listCommands, unregisterCommand, isWithdrawnCommand };
  })();

  root.IJImage = IJImage;
  root.IJLuts = IJLuts;
  root.IJRoi = IJRoi;
  root.IJOps = IJOps;
  root.IJProject = IJProject;
  root.IJTiff = IJTiff;
  root.IJOpRegistry = IJOpRegistry;
})(typeof self !== 'undefined' ? self : globalThis);
