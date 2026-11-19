/* ij-proc-ov.js — package ov (wave 3): Image › Overlay, Analyze › Tools › Grid… and Scale Bar….
 *
 * Loaded on the page AND in the worker (ij-worker.js loads it in its own try/catch). No DOM, no engine globals besides
 * the registry. It holds
 *   • `paintMask`  pixel op — the burn-in of a Scale Bar drawn without the overlay: one or more RLE masks, each painted with
 *                  one value per channel, in order (a background box under the bar). Band-invariant: a pixel's value depends
 *                  only on its position.
 *   • `IJOv`       the pure part both commands stand on (tested without a browser):
 *       d2s, getDigits, round125       IJ.d2s, ScaleBar.Utils.getDigits / round
 *       decodeColor, colorName         ij.plugin.Colors.decode / getColor / colorToString
 *       gridGeometry                   ij.plugin.Grid, every type, centred / random offset / bold
 *       scaleBarDefaults, scaleBarGeometry   ij.plugin.ScaleBar.computeDefaultBarWidth / createScaleBarOverlay
 *       burnValue                      the value ScaleBar.drawOverlayOnProcessor leaves in a pixel of one channel
 *       buildMaskRuns                  rectangles + raster patches → the RLE of a paintMask layer
 *
 * Java arithmetic is reproduced where it decides a value: `(int)` is Math.trunc, `Math.round` is floor(x + 0.5), a
 * GeneralPath is float (Math.fround), integer division truncates, DecimalFormat rounds HALF_EVEN on the exact binary value.
 *
 * Reference: ImageJ 1.54p (public domain): ij/plugin/Grid.java, ij/plugin/ScaleBar.java, ij/plugin/OverlayCommands.java,
 * ij/plugin/Colors.java, ij/IJ.java, ij/process/ImageProcessor.java.
 */
(function (root) {
  'use strict';
  const { floor: M_floor, trunc: M_trunc, abs: M_abs, max: M_max, min: M_min, sqrt: M_sqrt, fround: M_fround } = Math;

  function fail(code, message) {
    const e = new Error(message || code);
    e.code = code;
    return e;
  }
  const bad = (m) => fail('IJ_BAD_ARGS', m);
  const isNum = (n) => typeof n === 'number' && isFinite(n);
  /** Math.round(double) of Java: (long)Math.floor(x + 0.5). */
  const jround = (x) => M_floor(x + 0.5);

  // ───────────────────────────── number formatting ─────────────────────────────

  /* ij.IJ.d2s(n, decimalPlaces): `df[places].format(n)` — a java.text.DecimalFormat("0.00…") whose default rounding mode is
   * HALF_EVEN, applied to the exact binary value of the double (JDK 8+). Number.prototype.toFixed rounds an exact tie up, so
   * an exact tie is detected with BigInt and resolved to the even neighbour. A negative `decimalPlaces` is the scientific
   * format ("0.000E0" for -3, the exponent without a plus sign), which is what Utils.getDigits(double) asks for. */
  function isExactTie(x, d) {
    const dv = new DataView(new ArrayBuffer(8));
    dv.setFloat64(0, M_abs(x));
    const hi = dv.getUint32(0), lo = dv.getUint32(4);
    const e = (hi >>> 20) & 0x7ff;
    let mant = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
    let exp;
    if (e === 0) exp = -1074; else { mant |= 1n << 52n; exp = e - 1075; }
    // |x|·10^d has the fractional part 1/2 exactly  ⟺  2·mant·10^d·2^exp is an odd integer
    const num = mant * (10n ** BigInt(d)) * 2n;
    if (exp >= 0) return false;
    const k = BigInt(-exp);
    if ((num & ((1n << k) - 1n)) !== 0n) return false;
    return ((num >> k) & 1n) === 1n;
  }
  function decrementDigits(s) { // "12.30" → "12.29": the last digit of a non-negative decimal string, with borrow
    const a = s.split('');
    for (let i = a.length - 1; i >= 0; i--) {
      if (a[i] === '.') continue;
      if (a[i] === '0') { a[i] = '9'; continue; }
      a[i] = String.fromCharCode(a[i].charCodeAt(0) - 1);
      break;
    }
    const out = a.join('');
    return out.replace(/^0+(?=\d)/, '');
  }
  function d2s(n, decimalPlaces) {
    if (!isFinite(n)) return String(n);
    let places = decimalPlaces;
    if (places < 0) {
      places = M_min(-places, 9);
      return n.toExponential(places).replace('e+', 'E').replace('e', 'E');
    }
    if (places > 9) places = 9;
    const neg = n < 0;
    let s = M_abs(n).toFixed(places);
    if (isExactTie(n, places)) {
      const digits = s.replace('.', '');
      if ((digits.charCodeAt(digits.length - 1) - 48) % 2 === 1) s = decrementDigits(s);
    }
    return (neg ? '-' : '') + s;
  }

  /* ScaleBar.Utils.getDigits(String): the decimal digits of a number encoded in a string; a scientific format gives the
   * negative of the significant digits after the first. */
  function getDigitsOfString(str) {
    let hasDecimalPoint = false, scientific = false, totalDigits = 0, decimalDigits = 0;
    for (let i = 0; i < str.length; i++) {
      const c = str.charAt(i);
      if (c === '.') hasDecimalPoint = true;
      else if (c === 'e' || c === 'E') { scientific = true; break; }
      else if (c >= '0' && c <= '9') { totalDigits++; if (hasDecimalPoint) decimalDigits++; }
    }
    if (scientific) { const digits = -(totalDigits - 1); return digits === 0 ? -1 : digits; }
    return decimalDigits;
  }
  /* ScaleBar.Utils.getDigits(double):
   *     if (Math.abs(x) > 1000000 || Math.abs(x) < 1e-4) return getDigits(IJ.d2s(x, -9).replaceAll("0+E", "E"));
   *     else return getDigits(IJ.d2s(x, 9).replaceAll("0+\\z", "")); */
  function getDigits(x) {
    if (M_abs(x) > 1000000 || M_abs(x) < 1e-4) return getDigitsOfString(d2s(x, -9).replace(/0+E/, 'E'));
    return getDigitsOfString(d2s(x, 9).replace(/0+$/, ''));
  }
  /* ScaleBar.Utils.round: "Rounds down a positive value such that the first digit is 1, 2, or 5"
   *     double base = Math.pow(10, Math.floor(Math.log10(x)+1e-8));
   *     if (x > 4.999999*base) return 5*base; else if (x > 1.999999*base) return 2*base; else return base; */
  function round125(x) {
    const base = Math.pow(10, M_floor(Math.log10(x) + 1e-8));
    if (x > 4.999999 * base) return 5 * base;
    if (x > 1.999999 * base) return 2 * base;
    return base;
  }

  // ───────────────────────────── colours (ij.plugin.Colors) ─────────────────────────────

  const NAMES = ['red', 'green', 'blue', 'magenta', 'cyan', 'yellow', 'orange', 'black', 'white', 'gray', 'lightgray', 'darkgray', 'pink'];
  // java.awt.Color: orange = 255,200,0; pink = 255,175,175; gray 128, light gray 192, dark gray 64
  const NAMED_RGB = { red: [255, 0, 0], green: [0, 255, 0], blue: [0, 0, 255], magenta: [255, 0, 255], cyan: [0, 255, 255], yellow: [255, 255, 0],
    orange: [255, 200, 0], black: [0, 0, 0], white: [255, 255, 255], gray: [128, 128, 128], lightgray: [192, 192, 192], darkgray: [64, 64, 64], pink: [255, 175, 175] };
  const hex2 = (n) => (n < 16 ? '0' : '') + n.toString(16);
  const hexOf = (rgb) => '#' + hex2(rgb[0]) + hex2(rgb[1]) + hex2(rgb[2]);

  /* Colors.getColor(name, default): the NAME CONTAINS a colour word, tested in this order:
   *     black, white, red, blue, yellow, green, magenta, cyan, orange, pink, then gray / grey (light / dark). */
  function colorByName(name, fallback) {
    if (typeof name !== 'string' || name.length < 2) return fallback;
    const n = name.toLowerCase();
    const has = (i) => n.indexOf(NAMES[i]) >= 0;
    if (has(7)) return NAMED_RGB.black.slice();
    if (has(8)) return NAMED_RGB.white.slice();
    if (has(0)) return NAMED_RGB.red.slice();
    if (has(2)) return NAMED_RGB.blue.slice();
    if (has(5)) return NAMED_RGB.yellow.slice();
    if (has(1)) return NAMED_RGB.green.slice();
    if (has(3)) return NAMED_RGB.magenta.slice();
    if (has(4)) return NAMED_RGB.cyan.slice();
    if (has(6)) return NAMED_RGB.orange.slice();
    if (has(12)) return NAMED_RGB.pink.slice();
    if (has(9) || n.indexOf('grey') >= 0) {
      if (n.indexOf('light') >= 0) return NAMED_RGB.lightgray.slice();
      if (n.indexOf('dark') >= 0) return NAMED_RGB.darkgray.slice();
      return NAMED_RGB.gray.slice();
    }
    return fallback;
  }
  /* Colors.decode(hex, default): a colour name, else "#rrggbb" / "0xrrggbb" / "#aarrggbb" (the ALPHA comes first).
   * → { rgb: [r, g, b], alpha: 0..255 } or `fallback` (what the caller passes, usually null). */
  function decodeColor(text, fallback) {
    if (typeof text !== 'string' || text.length < 2) return fallback;
    const named = colorByName(text, null);
    if (named) return { rgb: named, alpha: 255 };
    let h = text;
    if (h.charAt(0) === '#') h = h.substring(1); else if (h.substring(0, 2) === '0x') h = h.substring(2);
    if (!(h.length === 6 || h.length === 8) || !/^[0-9a-fA-F]+$/.test(h)) return fallback;
    const v = parseInt(h, 16);
    if (h.length === 8) return { rgb: [(v >>> 16) & 255, (v >>> 8) & 255, v & 255], alpha: (v >>> 24) & 255 };
    return { rgb: [(v >>> 16) & 255, (v >>> 8) & 255, v & 255], alpha: 255 };
  }
  /* Colors.colorToString: one of the thirteen names when the colour is exactly one of them, else "#rrggbb" ("#aarrggbb"
   * when translucent); null = "none". */
  function colorName(rgb, alpha) {
    if (!rgb) return 'none';
    const a = alpha === undefined ? 255 : alpha;
    if (a === 255) for (const k of NAMES) { const c = NAMED_RGB[k]; if (c[0] === rgb[0] && c[1] === rgb[1] && c[2] === rgb[2]) return k; }
    return '#' + (a === 255 ? '' : hex2(a)) + hex2(rgb[0]) + hex2(rgb[1]) + hex2(rgb[2]);
  }
  /** "#rrggbb" of a decoded colour; "#rrggbbaa" (the annotation fill format) with its alpha. */
  const cssOpaque = (c) => hexOf(c.rgb);
  const cssRgba = (c) => hexOf(c.rgb) + hex2(c.alpha === undefined ? 255 : c.alpha);

  // ───────────────────────────── units (ij.measure.Calibration) ─────────────────────────────

  /* Calibration.setUnit → sanitizeUnit ("" → pixel, "um" → µm, "A" → Å); getUnits() → pluralForm (pixel → pixels, micron →
   * microns, inch → inches); ScaleBar.getHUnit(): "microns" → "µm". */
  function sanitizedUnit(unit) {
    let u = typeof unit === 'string' ? unit : '';
    if (u === '') u = 'pixel'; else if (u === 'um') u = 'µm'; else if (u === 'A') u = 'Å';
    return u;
  }
  /* Calibration.getUnits(): the plural form alone (Grid.java:159 shows it as is: "microns^2"). */
  function pluralOf(unit) {
    const u = sanitizedUnit(unit);
    if (u === 'pixel') return 'pixels';
    if (u === 'micron') return 'microns';
    if (u === 'inch') return 'inches';
    return u;
  }
  /* ScaleBar.getHUnit(): the plural form, then "microns" → "µm" (a unit stored as "microns" gets there too). */
  function unitsOf(unit) {
    const p = pluralOf(unit);
    return p === 'microns' ? 'µm' : p;
  }
  /* Calibration.scaled(): pixelWidth != 1 || pixelHeight != 1 || pixelDepth != 1 || !unit.equals("pixel") (no depth here). */
  function isScaled(cal) {
    const pw = cal && cal.pixelWidth > 0 ? cal.pixelWidth : 1, ph = cal && cal.pixelHeight > 0 ? cal.pixelHeight : 1;
    const u = cal && typeof cal.unit === 'string' && cal.unit !== '' ? cal.unit : 'pixel';
    return pw !== 1 || ph !== 1 || u !== 'pixel';
  }

  // ───────────────────────────── Analyze › Tools › Grid ─────────────────────────────

  const GRID_TYPES = ['Lines', 'Horizontal Lines', 'Crosses', 'Points', 'Circles', 'None'];
  const GRID_COLORS = ['Red', 'Green', 'Blue', 'Magenta', 'Cyan', 'Yellow', 'Orange', 'Black', 'White'];
  const CROSS_SIZE = 0.1;       // Grid.crossSize
  const GRID_SEEN = 5000;       // Grid.drawGrid: `bold && linesV*linesH<5000`

  /* Grid.dialogItemChanged, minus the dialog. The smallest area per point:
   *     double minArea= (width*height)/50000.0;
   *     if (type.equals(types[CROSSES])&&minArea<50.0) minArea = 50.0; else if (minArea<16) minArea = 16.0;
   *     if (areaPerPoint/(pixelWidth*pixelHeight)<minArea) { "Area per Point" too small }
   * (areaPerPoint is in calibrated units, minArea in pixels). */
  function gridMinArea(type, width, height) {
    let minArea = (width * height) / 50000.0;
    if (type === 'Crosses' && minArea < 50.0) minArea = 50.0;
    else if (minArea < 16) minArea = 16.0;
    return minArea;
  }
  /* The default area per point of Grid.showDialog: `(width*cal.pixelWidth*height*cal.pixelHeight)/81.0; // default to 9x9 grid`. */
  function gridDefaultArea(width, height, pw, ph) { return (width * pw * height * ph) / 81.0; }

  /* The random offset of Grid.dialogItemChanged:
   *     xstart = (int)(random.nextDouble()*tileWidth);  ystart = (int)(random.nextDouble()*tileHeight);
   * ImageJ's `Random(System.currentTimeMillis())` is drawn from at EVERY dialog update (two values each) and once more when
   * the dialog is OKed, so the grid it leaves is the one of the LAST update. A seeded port that reproduces ImageJ's result
   * for a seed (tests/fixtures/ij-wave3/ov/grid.json, recorded by running the plugin with Random(seed) in a macro: one
   * update before the dialog, one after OK) skips the first pair: the offset of a seed is its second pair. */
  function gridRandomOffset(seed, tileWidth, tileHeight) {
    const JR = root.IJShared && root.IJShared.JavaRandom;
    if (!JR) throw fail('IJ_MODULE_MISSING', 'JavaRandom');
    const r = new JR(seed);
    r.nextDouble(); r.nextDouble();
    return { x: M_trunc(r.nextDouble() * tileWidth), y: M_trunc(r.nextDouble() * tileHeight) };
  }

  /**
   * The geometry of one grid.
   *   opts = { type, area (areaPerPoint, calibrated units²), color, bold, centered, randomOffset, seed, zoom (the view's, default 1) }
   *   img  = { width, height, pixelWidth, pixelHeight }
   * → { ok:false, reason:'tooSmall', minArea }  |  { ok:true, none:true }  |
   *   { ok:true, type, tileWidth, tileHeight, xstart, ystart, linesV, linesH, strokeWidth, lines:[x1,y1,x2,y2…], circles:[cx,cy,r…] }
   * `lines` are float-rounded as the GeneralPath is (a Lines / Horizontal Lines coordinate is `(float)(xstart+i*tileWidth)`;
   * a cross arm and a circle are computed in double, then stored by the path as float: Math.fround of each number).
   * circles hold the centre and radius of the four Bézier arcs Grid.drawCircles draws (kappa 0.5522847498f).
   */
  function gridGeometry(opts, img) {
    const type = opts.type;
    if (GRID_TYPES.indexOf(type) < 0) throw bad('grid type');
    const width = img.width, height = img.height;
    const pw = img.pixelWidth > 0 ? img.pixelWidth : 1, ph = img.pixelHeight > 0 ? img.pixelHeight : 1;
    const randomOffset = !!opts.randomOffset;
    const centered = !!opts.centered && !randomOffset;      // `if (randomOffset) { centered = false; … }`
    const bold = !!opts.bold;
    if (!(opts.area > 0) || !isFinite(opts.area)) return { ok: false, reason: 'tooSmall', minArea: gridMinArea(type, width, height) };
    const minArea = gridMinArea(type, width, height);
    if (opts.area / (pw * ph) < minArea) return { ok: false, reason: 'tooSmall', minArea };
    if (type === 'None') return { ok: true, none: true };
    const tileSize = M_sqrt(opts.area);
    const tileWidth = tileSize / pw, tileHeight = tileSize / ph;
    let xstart, ystart;
    if (centered) {
      // (int)Math.round((width%tileWidth)/2.0)
      xstart = M_trunc(jround((width % tileWidth) / 2.0));
      ystart = M_trunc(jround((height % tileHeight) / 2.0));
    } else if (randomOffset) {
      const o = gridRandomOffset(opts.seed, tileWidth, tileHeight);
      xstart = o.x; ystart = o.y;
    } else {
      xstart = M_trunc(tileWidth / 2.0 + 0.5);
      ystart = M_trunc(tileHeight / 2.0 + 0.5);
    }
    const linesV = M_trunc((width - xstart) / tileWidth) + 1;
    const linesH = M_trunc((height - ystart) / tileHeight) + 1;
    const lines = [], circles = [];
    if (type === 'Lines') {
      for (let i = 0; i < linesV; i++) { const x = M_fround(xstart + i * tileWidth); lines.push(x, 0, x, height); }
      for (let i = 0; i < linesH; i++) { const y = M_fround(ystart + i * tileHeight); lines.push(0, y, width, y); }
    } else if (type === 'Horizontal Lines') {
      for (let i = 0; i < linesH; i++) { const y = M_fround(ystart + i * tileHeight); lines.push(0, y, width, y); }
    } else if (type === 'Crosses') {
      // Grid.drawCrosses: double arm = crossSize*tileWidth; if (arm<3) arm=3;
      let arm = CROSS_SIZE * tileWidth;
      if (arm < 3) arm = 3;
      for (let h = 0; h < linesV; h++) {
        for (let v = 0; v < linesH; v++) {
          const x = xstart + h * tileWidth, y = ystart + v * tileHeight;
          lines.push(M_fround(x - arm), M_fround(y), M_fround(x + arm), M_fround(y), M_fround(x), M_fround(y - arm), M_fround(x), M_fround(y + arm));
        }
      }
    } else {
      // Grid.drawCircles(size): Points = 0.01, Circles = 0.1;  double R = size*tileWidth; if (R<1) R = 1;
      //                         if (bold && type.equals(types[POINTS])) R*=1.5;
      let R = (type === 'Points' ? 0.01 : 0.1) * tileWidth;
      if (R < 1) R = 1;
      if (bold && type === 'Points') R *= 1.5;
      for (let h = 0; h < linesV; h++) {
        for (let v = 0; v < linesH; v++) circles.push(xstart + h * tileWidth, ystart + v * tileHeight, R);
      }
    }
    // Grid.drawGrid(Shape): `if (bold && linesV*linesH<5000) { … width = 2.0; if (mag<1.0) width = width/mag; roi.setStrokeWidth(width); }`
    // The view draws an item at width·zoom screen pixels, so the rule is applied when the grid is made, with the zoom of that moment.
    const mag = opts.zoom > 0 ? opts.zoom : 1;
    const strokeWidth = bold && linesV * linesH < GRID_SEEN ? (mag < 1.0 ? 2.0 / mag : 2) : 0;
    return { ok: true, type, tileWidth, tileHeight, xstart, ystart, linesV, linesH, strokeWidth, lines, circles };
  }

  const roundMilli = (v) => Math.round(v * 1000) / 1000;
  /** The annotation item of a grid: coordinates at a thousandth of a pixel (a float has 1.2e-4 at 1024), so that 50 000 crosses stay a few MB. */
  function gridItem(geom, colorText, tag) {
    const c = decodeColor(colorText, null) || { rgb: [0, 255, 255], alpha: 255 };   // Colors.getColor(color, Color.cyan)
    return { kind: 'shapes', lines: geom.lines.map(roundMilli), circles: geom.circles.map(roundMilli), points: [], stroke: cssOpaque(c), width: geom.strokeWidth, tag };
  }

  // ───────────────────────────── Analyze › Tools › Scale Bar ─────────────────────────────

  const SB_LOCATIONS = ['Upper Right', 'Lower Right', 'Lower Left', 'Upper Left', 'At Selection'];
  const SB_COLORS = ['White', 'Black', 'Light Gray', 'Gray', 'Dark Gray', 'Red', 'Green', 'Blue', 'Yellow'];
  const SB_BCOLORS = ['None', 'Black', 'White', 'Dark Gray', 'Gray', 'Light Gray', 'Yellow', 'Blue', 'Green', 'Red'];
  const SB_RGB = { White: [255, 255, 255], Black: [0, 0, 0], 'Light Gray': [192, 192, 192], Gray: [128, 128, 128], 'Dark Gray': [64, 64, 64], Red: [255, 0, 0],
    Green: [0, 255, 0], Blue: [0, 0, 255], Yellow: [255, 255, 0] };

  /** ScaleBarConfiguration(): the defaults of a fresh configuration. */
  function scaleBarConfig(over) {
    return Object.assign({
      showHorizontal: true, showVertical: false, hBarWidth: -1, vBarHeight: -1, hDigits: 0, vDigits: 0, barThicknessInPixels: 4,
      location: 'Lower Right', color: 'White', bcolor: 'None', boldText: true, hideText: false, serifFont: false, useOverlay: true, fontSize: 14
    }, over || {});
  }
  /* ScaleBar.getColor():  Color c = Color.black; White → white, Light Gray → lightGray, Gray → gray, Dark Gray → darkGray,
   * Red, Green, Blue, Yellow; anything else stays black. getBColor(): None → null (no background); the default is WHITE for
   * a name that is not in the table, then Black, Dark Gray, Gray, Light Gray, Yellow, Blue, Green, Red. */
  function scaleBarColor(name) { return SB_RGB[name] ? SB_RGB[name].slice() : [0, 0, 0]; }
  function scaleBarBackground(name) {
    if (name === null || name === undefined || name === 'None') return null;
    return SB_RGB[name] ? SB_RGB[name].slice() : [255, 255, 255];
  }

  /**
   * ScaleBar.computeDefaultBarWidth(currentROIExists), for a configuration without macro options: the bar of a first use
   * (or of one that does not fit the image) is 80 screen pixels (`mag` is the zoom, at most 1) rounded down to 1-2-5 × 10ᵏ,
   * at most 0.67 of the image and at least 4 % of it; a selection wider than 10 px gives its own width / height.
   *   img = { width, height, pixelWidth, pixelHeight }, roi = { x, y, w, h } | null → a new configuration
   */
  function scaleBarDefaults(cfgIn, img, mag, roi) {
    const cfg = Object.assign({}, cfgIn);
    let m = mag > 0 ? mag : 1;
    if (m > 1.0) m = 1.0;
    let pixelWidth = img.pixelWidth;
    if (!(pixelWidth > 0)) pixelWidth = 1.0;
    let pixelHeight = img.pixelHeight;
    if (!(pixelHeight > 0)) pixelHeight = 1.0;
    const imageWidth = img.width * pixelWidth, imageHeight = img.height * pixelHeight;
    const roiExists = !!roi;
    let hChanged = false;
    if (roiExists && roi.x >= 0 && roi.w > 10) {
      cfg.hBarWidth = roi.w * pixelWidth;                // "If the user has a ROI, set the bar width according to ROI width."
      hChanged = true;
    } else if (cfg.hBarWidth <= 0.0 || cfg.hBarWidth < 0.01 * imageWidth || cfg.hBarWidth > 0.67 * imageWidth) {
      cfg.hBarWidth = (80.0 * pixelWidth) / m;
      cfg.hBarWidth = round125(cfg.hBarWidth);
      // "If 80 pixels is too much, do 2/3 of the image. If too small, 4% of image (rounded down)"
      if (cfg.hBarWidth > 0.67 * imageWidth) cfg.hBarWidth = round125(0.67 * imageWidth);
      else if (cfg.hBarWidth < 0.04 * imageWidth) cfg.hBarWidth = round125(0.04 * imageWidth);
      hChanged = true;
    }
    let vChanged = false;
    if (roiExists && roi.y >= 0 && roi.h > 10) {
      cfg.vBarHeight = roi.h * pixelHeight;
      vChanged = true;
    } else if (cfg.vBarHeight <= 0.0 || cfg.vBarHeight < 0.01 * imageHeight || cfg.vBarHeight > 0.67 * imageHeight) {
      cfg.vBarHeight = (80.0 * pixelHeight) / m;
      cfg.vBarHeight = round125(cfg.vBarHeight);
      if (cfg.vBarHeight > 0.67 * imageHeight) cfg.vBarHeight = round125(0.67 * imageHeight);
      else if (cfg.vBarHeight < 0.04 * imageHeight) cfg.vBarHeight = round125(0.04 * imageHeight);
      vChanged = true;
    }
    if (hChanged) cfg.hDigits = getDigits(cfg.hBarWidth);
    if (vChanged) cfg.vDigits = getDigits(cfg.vBarHeight);
    return cfg;
  }
  /* The condition askUserConfiguration tests before it computes the defaults:
   *     config.showHorizontal && (config.hBarWidth <= 5*cal.pixelWidth || config.hBarWidth > cal.pixelWidth*imp.getWidth()) ||
   *     config.showVertical && (config.vBarHeight <= 5*cal.pixelHeight || config.vBarHeight > cal.pixelHeight*imp.getHeight()) || currentROIExists */
  function scaleBarNeedsDefaults(cfg, img, roiExists) {
    const pw = img.pixelWidth > 0 ? img.pixelWidth : 1, ph = img.pixelHeight > 0 ? img.pixelHeight : 1;
    return (cfg.showHorizontal && (cfg.hBarWidth <= 5 * pw || cfg.hBarWidth > pw * img.width)) ||
      (cfg.showVertical && (cfg.vBarHeight <= 5 * ph || cfg.vBarHeight > ph * img.height)) || !!roiExists;
  }

  /**
   * ScaleBar.createScaleBarOverlay(): every rectangle and text anchor, in image pixels, in the order ImageJ adds them
   * (backgrounds, bars, texts).
   *   cfg  = scaleBarConfig(...)   img = { width, height, pixelWidth, pixelHeight, unit }
   *   measure(text) → the width in pixels of `text` in the configured font (ImageProcessor.getStringWidth; the page measures
   *                   with its own canvas, the tests with the widths ImageJ recorded)
   *   roi  = { x, y, w, h } | null (the selection, for "At Selection")
   * → null when the location is "At Selection" and there is no selection (MissingRoiException: no bar is drawn),
   *   else { hBarWidthInPixels, vBarHeightInPixels, hLabel, vLabel, items:[{ kind:'rect', role:'background'|'bar', x, y, w, h, fill }|
   *   { kind:'text', x, y, text, angle, color, label:'h'|'v' }] }
   */
  function scaleBarGeometry(cfg, img, measure, roi) {
    const pw = img.pixelWidth > 0 ? img.pixelWidth : 1, ph = img.pixelHeight > 0 ? img.pixelHeight : 1;
    const unit = unitsOf(img.unit);
    const hLabel = d2s(cfg.hBarWidth, cfg.hDigits) + ' ' + unit;
    const vLabel = d2s(cfg.vBarHeight, cfg.vDigits) + ' ' + unit;
    const imageWidth = img.width, imageHeight = img.height;
    const thick = cfg.barThicknessInPixels, fs = cfg.fontSize;
    const idiv = (a, b) => M_trunc(a / b);                       // Java int division
    // setBackgroundBoxesPositions
    const hBarWidthInPixels = M_trunc(jround(cfg.hBarWidth / pw));
    const vBarHeightInPixels = M_trunc(jround(cfg.vBarHeight / ph));
    const hLabelWidth = cfg.hideText ? 0 : measure(hLabel);
    const vLabelHeight = cfg.hideText ? 0 : measure(vLabel);
    // getHBoxWidthInPixels / getHBoxHeightInPixels / getVBoxHeightInPixels / getVBoxWidthInPixels
    const hBoxWidth = cfg.showHorizontal ? M_max(hBarWidthInPixels, hLabelWidth) : 0;
    const hBoxHeight = cfg.showHorizontal ? thick + M_trunc((cfg.hideText ? 0 : fs) * 1.25) : 0;
    const vBoxHeight = cfg.showVertical ? M_max(vBarHeightInPixels, vLabelHeight) : 0;
    const vBoxWidth = cfg.showVertical ? thick + M_trunc((cfg.hideText ? 0 : fs) * 1.25) : 0;
    // getOuterMarginSizeInPixels: (imageWidth + imageHeight) / 100; getInnerMarginSizeInPixels:
    //     int maxWidth = Math.max(getHBoxWidthInPixels(), getVBoxHeightInPixels()); int margin = Math.max(maxWidth/20, 2);
    //     return config.bcolor.equals("None") ? 0 : margin;
    const outerMargin = idiv(imageWidth + imageHeight, 100);
    const innerMargin = cfg.bcolor === 'None' ? 0 : M_max(idiv(M_max(hBoxWidth, vBoxHeight), 20), 2);
    const loc = cfg.location;
    const hTextTop = cfg.showVertical && (loc === 'Upper Left' || loc === 'Upper Right');
    const hBack = { x: 0, y: 0, w: innerMargin + hBoxWidth + innerMargin, h: innerMargin + hBoxHeight + innerMargin };
    const vBack = { x: 0, y: 0, w: innerMargin + vBoxWidth + innerMargin, h: innerMargin + vBoxHeight + innerMargin };
    if (loc === 'Upper Right') {
      hBack.x = imageWidth - outerMargin - innerMargin - vBoxWidth + (cfg.showVertical ? thick : 0) - hBoxWidth - innerMargin;
      hBack.y = outerMargin;
      vBack.x = imageWidth - outerMargin - innerMargin - vBoxWidth - innerMargin;
      vBack.y = outerMargin + (hTextTop ? hBoxHeight - thick : 0);
      hBack.w += cfg.showVertical ? vBoxWidth - thick : 0;
    } else if (loc === 'Lower Right') {
      hBack.x = imageWidth - outerMargin - innerMargin - vBoxWidth - hBoxWidth + (cfg.showVertical ? thick : 0) - innerMargin;
      hBack.y = imageHeight - outerMargin - innerMargin - hBoxHeight - innerMargin;
      vBack.x = imageWidth - outerMargin - innerMargin - vBoxWidth - innerMargin;
      vBack.y = imageHeight - outerMargin - innerMargin - hBoxHeight + (cfg.showHorizontal ? thick : 0) - vBoxHeight - innerMargin;
      vBack.h += cfg.showHorizontal ? hBoxHeight - thick : 0;
    } else if (loc === 'Upper Left') {
      hBack.x = outerMargin + (cfg.showVertical ? vBack.w - 2 * innerMargin - thick : 0);
      hBack.y = outerMargin;
      vBack.x = outerMargin;
      vBack.y = outerMargin + (hTextTop ? hBoxHeight - thick : 0);
      hBack.w += cfg.showVertical ? vBoxWidth - thick : 0;
      hBack.x -= cfg.showVertical ? vBoxWidth - thick : 0;
    } else if (loc === 'Lower Left') {
      hBack.x = outerMargin + (cfg.showVertical ? vBack.w - 2 * innerMargin - thick : 0);
      hBack.y = imageHeight - outerMargin - innerMargin - hBoxHeight - innerMargin;
      vBack.x = outerMargin;
      vBack.y = imageHeight - outerMargin - innerMargin - hBoxHeight + (cfg.showHorizontal ? thick : 0) - vBoxHeight - innerMargin;
      vBack.h += cfg.showHorizontal ? hBoxHeight - thick : 0;
    } else {
      if (!roi) return null;                                    // throw new MissingRoiException()
      hBack.x = roi.x; hBack.y = roi.y; vBack.x = roi.x; vBack.y = roi.y;
    }
    // setElementsPositions
    const right = loc === 'Lower Right' || loc === 'Upper Right';
    const upper = loc === 'Upper Right' || loc === 'Upper Left';
    const hTextTop2 = cfg.showVertical && upper;
    const hBar = { x: 0, y: 0, w: hBarWidthInPixels, h: thick };
    hBar.x = hBack.x + innerMargin + idiv(hBoxWidth - hBarWidthInPixels, 2) + (cfg.showVertical && !right && upper ? vBoxWidth - thick : 0);
    hBar.y = hBack.y + innerMargin + (hTextTop2 ? hBoxHeight - thick : 0);
    const hText = { w: cfg.hideText ? 0 : hLabelWidth, h: cfg.hideText ? 0 : fs, x: 0, y: 0 };
    hText.x = hBack.x + innerMargin + idiv(hBoxWidth - hText.w, 2) + (cfg.showVertical && !right && upper ? vBoxWidth - thick : 0);
    hText.y = hTextTop2 ? (hBack.y + innerMargin - M_trunc(jround(fs * 0.25))) : (hBar.y + hBar.h);
    const vBar = { x: 0, y: 0, w: thick, h: vBarHeightInPixels };
    vBar.x = vBack.x + (right ? innerMargin : vBack.w - thick - innerMargin);
    vBar.y = vBack.y + innerMargin + idiv(vBoxHeight - vBar.h, 2);
    const vText = { w: cfg.hideText ? 0 : fs, h: cfg.hideText ? 0 : vLabelHeight, x: 0, y: 0 };
    vText.x = right ? (vBar.x + vBar.w) : (vBar.x - vBoxWidth + thick - M_trunc(jround(fs * 0.25)));
    vText.y = vBack.y + innerMargin + idiv(vBoxHeight - vText.h, 2);
    // createScaleBarOverlay
    const color = scaleBarColor(cfg.color), bcolor = scaleBarBackground(cfg.bcolor);
    const items = [];
    if (bcolor) {
      if (cfg.showHorizontal) items.push({ kind: 'rect', role: 'background', x: hBack.x, y: hBack.y, w: hBack.w, h: hBack.h, fill: bcolor });
      if (cfg.showVertical) items.push({ kind: 'rect', role: 'background', x: vBack.x, y: vBack.y, w: vBack.w, h: vBack.h, fill: bcolor });
    }
    if (cfg.showHorizontal) items.push({ kind: 'rect', role: 'bar', x: hBar.x, y: hBar.y, w: hBar.w, h: hBar.h, fill: color });
    if (cfg.showVertical) items.push({ kind: 'rect', role: 'bar', x: vBar.x, y: vBar.y, w: vBar.w, h: vBar.h, fill: color });
    if (!cfg.hideText) {
      if (cfg.showHorizontal) items.push({ kind: 'text', x: hText.x, y: hText.y, text: hLabel, angle: 0, color, label: 'h', width: hText.w });
      // vTextRoi = new TextRoi(vText.x, vText.y + vText.height, getVLabel(), font); vTextRoi.setAngle(90.0)
      if (cfg.showVertical) items.push({ kind: 'text', x: vText.x, y: vText.y + vText.h, text: vLabel, angle: 90, color, label: 'v', width: vText.h });
    }
    return { hBarWidthInPixels, vBarHeightInPixels, hLabel, vLabel, hBar, vBar, hText, vText, right, items };
  }

  const toCss = (rgb) => hexOf(rgb);
  /**
   * The annotation items of a scale bar (api.annotations): `rect` for a background and a bar, `text` for a label. The text
   * item has no rotation (PLAN-wave3 §2.5): a vertical label is set horizontally on the inner side of its bar, centred on it,
   * where ImageJ turns it by 90°.
   */
  function scaleBarItems(res, cfg, tag) {
    const out = [];
    for (const it of res.items) {
      if (it.kind === 'rect') { out.push({ kind: 'rect', x: it.x, y: it.y, w: it.w, h: it.h, fill: toCss(it.fill) + 'ff', tag }); continue; }
      const base = { kind: 'text', text: it.text, size: cfg.fontSize, color: toCss(it.color), background: null, bold: !!cfg.boldText, serif: !!cfg.serifFont, tag };
      if (it.label === 'h') { out.push(Object.assign(base, { x: it.x, y: it.y, align: 'left' })); continue; }
      const bar = res.vBar, cy = bar.y + bar.h / 2 - cfg.fontSize * 0.6;
      if (res.right) out.push(Object.assign(base, { x: bar.x - 3, y: cy, align: 'right' }));
      else out.push(Object.assign(base, { x: bar.x + bar.w + 3, y: cy, align: 'left' }));
    }
    return out;
  }

  // ───────────────────────────── burn-in ─────────────────────────────

  /* ByteProcessor.setMinAndMax(min, max) (ByteProcessor.java:450-469): the LUT as the display range stretches it.
   *     this.min = (int)Math.round(min); this.max = (int)Math.round(max);
   *     i < min → entry 0;  i > max → entry 255;  else index = (int)(256.0*(i-this.min)/(max-min)) clamped to 0..255
   * (a NaN from 0/0 casts to 0). table = 768 interleaved RGB bytes; the result is a new table. */
  function stretchTable(table, min, max) {
    const lo = M_trunc(jround(min)), hi = M_trunc(jround(max));
    const out = new Uint8Array(768);
    for (let i = 0; i < 256; i++) {
      let index;
      if (i < lo) index = 0;
      else if (i > hi) index = 255;
      else {
        const q = 256.0 * (i - lo) / (hi - lo);
        index = isNaN(q) ? 0 : M_trunc(q);
        if (index < 0) index = 0;
        if (index > 255) index = 255;
      }
      out[i * 3] = table[index * 3]; out[i * 3 + 1] = table[index * 3 + 1]; out[i * 3 + 2] = table[index * 3 + 2];
    }
    return out;
  }
  /* ImageProcessor.getBestIndex(Color): the index of the look-up-table entry nearest to the colour (squared RGB distance,
   * the first minimum wins); a colour that is not grey is weighted by the RGB weights (1/3 each) when the table is the
   * default one:
   *     r1 = (int)Math.round(3*r1*w[0]);  … */
  function bestIndex(rgb, table, isDefaultTable) {
    let r1 = rgb[0], g1 = rgb[1], b1 = rgb[2];
    if (!(r1 === g1 && g1 === b1) && isDefaultTable) {
      const w = 1 / 3;
      r1 = M_trunc(jround(3 * r1 * w)); g1 = M_trunc(jround(3 * g1 * w)); b1 = M_trunc(jround(3 * b1 * w));
    }
    let best = 0, min = Infinity;
    for (let i = 0; i < 256; i++) {
      const dr = table[i * 3] - r1, dg = table[i * 3 + 1] - g1, db = table[i * 3 + 2] - b1;
      const d = dr * dr + dg * dg + db * db;
      if (d < min) { min = d; best = i; }
      if (min === 0) break;
    }
    return best;
  }
  /**
   * The value ScaleBar.drawOverlayOnProcessor leaves in a pixel of a channel painted with `rgb`.
   *   8-bit: the overlay is drawn by ImageProcessor.drawOverlay: fgColor = getBestIndex(color).
   *   16 / 32-bit: the overlay is drawn on a black byte image whose LUT is grey, every drawn pixel (p > 0) is carried over:
   *       int i = processor.getBestIndex(fillColor);  fill = Color(lut[i]);  if (fill.equals(Color.BLACK)) fill = new Color(1, 1, 1);
   *       p = (int)Math.round(p * ((processor.getMax() - processor.getMin()) / 255d) + (float)processor.getMin());
   *   i.e. black is index 1, not 0, and the value is rounded, not truncated (a 32-bit pixel keeps that integer as a float).
   *   table = the 768 interleaved RGB bytes of the channel's LUT (the channel's invert flag already applied),
   *   display = { min, max } of the channel.
   */
  function burnValue(rgb, bitDepth, table, isDefaultTable, display) {
    if (bitDepth === 8) {
      // ByteProcessor.setMinAndMax replaces the colour model by a stretched copy of the LUT, and getBestIndex (and the Java2D
      // drawing of drawOverlay) work against THAT table; the stretched model is not defaultColorModel, so no RGB weighting.
      const mn = display ? Number(display.min) : 0, mx = display ? Number(display.max) : 255;
      if (isFinite(mn) && isFinite(mx) && mx >= mn && !(M_trunc(jround(mn)) === 0 && M_trunc(jround(mx)) === 255))
        return bestIndex(rgb, stretchTable(table, mn, mx), false);
      return bestIndex(rgb, table, isDefaultTable);
    }
    const best = bestIndex(rgb, table, isDefaultTable);
    const p = best === 0 ? 1 : best;
    const min = Number(display && display.min), max = Number(display && display.max);
    const v = M_floor(p * ((max - min) / 255) + M_fround(min) + 0.5);
    if (bitDepth === 16) return M_min(65535, M_max(0, v));
    return M_fround(v);
  }

  /**
   * The RLE of a paintMask layer: runs alternate unpainted / painted over the row-major image, the first one unpainted
   * (possibly 0), and sum to width·height.
   *   rects   [{ x, y, w, h }]    clipped to the image
   *   patches [{ x, y, w, h, data }]  data = w·h bytes, a non-zero byte is a painted pixel (a rasterised text)
   */
  function buildMaskRuns(width, height, rects, patches) {
    const rows = new Map();
    const span = (y, x0, x1) => {
      if (y < 0 || y >= height) return;
      if (x0 < 0) x0 = 0;
      if (x1 > width) x1 = width;
      if (x1 <= x0) return;
      let l = rows.get(y);
      if (!l) { l = []; rows.set(y, l); }
      l.push([x0, x1]);
    };
    for (const r of rects || []) {
      if (!(r.w > 0 && r.h > 0)) continue;
      const y0 = M_max(0, r.y), y1 = M_min(height, r.y + r.h);
      for (let y = y0; y < y1; y++) span(y, r.x, r.x + r.w);
    }
    for (const p of patches || []) {
      for (let j = 0; j < p.h; j++) {
        const y = p.y + j;
        if (y < 0 || y >= height) continue;
        let i = 0;
        while (i < p.w) {
          if (!p.data[j * p.w + i]) { i++; continue; }
          let k = i;
          while (k < p.w && p.data[j * p.w + k]) k++;
          span(y, p.x + i, p.x + k);
          i = k;
        }
      }
    }
    const ys = Array.from(rows.keys()).sort((a, b) => a - b);
    const runs = [];
    let cursor = 0;
    const paint = (from, to) => {
      const gap = from - cursor;
      if (gap === 0 && runs.length) runs[runs.length - 1] += to - from;
      else { runs.push(gap, to - from); }
      cursor = to;
    };
    for (const y of ys) {
      const l = rows.get(y).sort((a, b) => a[0] - b[0]);
      let a = l[0][0], b = l[0][1];
      for (let i = 1; i < l.length; i++) {
        if (l[i][0] <= b) { if (l[i][1] > b) b = l[i][1]; } else { paint(y * width + a, y * width + b); a = l[i][0]; b = l[i][1]; }
      }
      paint(y * width + a, y * width + b);
    }
    if (width * height - cursor > 0 || !runs.length) runs.push(width * height - cursor);
    return runs;
  }

  // ───────────────────────────── the paintMask operation ─────────────────────────────

  const MAX_LAYERS = 8;
  function castValue(v, bitDepth) {
    if (bitDepth === 32) return M_fround(v);
    const t = M_trunc(v);
    return M_min(bitDepth === 8 ? 255 : 65535, M_max(0, t));
  }
  function runsTotal(runs) { let s = 0; for (let i = 0; i < runs.length; i++) s += runs[i]; return s; }

  /* One band of the result: the rows of `rect` copied from the channel, then every layer's painted runs written over them,
   * in order. A run's position is row-major over the WHOLE image, so the answer never depends on how the engine cuts the
   * image into bands. */
  function paintBand(src, W, rect, layers, cum) {
    const out = new src.constructor(rect.w * rect.h);
    for (let y = 0; y < rect.h; y++) out.set(src.subarray((rect.y + y) * W + rect.x, (rect.y + y) * W + rect.x + rect.w), y * rect.w);
    const bandStart = rect.y * W, bandEnd = (rect.y + rect.h) * W;
    for (let li = 0; li < layers.length; li++) {
      const L = layers[li], runs = L.runs, starts = cum[li];
      // the first run whose end is past the band start (binary search on the run starts)
      let lo = 0, hi = runs.length - 1;
      while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= bandStart) lo = mid; else hi = mid - 1; }
      for (let i = lo; i < runs.length; i++) {
        const from = starts[i];
        if (from >= bandEnd) break;
        if ((i & 1) === 0) continue;
        const to = from + runs[i];
        const a = from < bandStart ? bandStart : from, b = to > bandEnd ? bandEnd : to;
        let pos = a;
        while (pos < b) {
          const y = M_trunc(pos / W), x = pos - y * W;
          const len = M_min(b - pos, W - x);
          const x0 = M_max(x, rect.x), x1 = M_min(x + len, rect.x + rect.w);
          if (x1 > x0) out.fill(L.value, (y - rect.y) * rect.w + (x0 - rect.x), (y - rect.y) * rect.w + (x1 - rect.x));
          pos += len;
        }
      }
    }
    return out;
  }
  function startsOf(runs) {
    const s = new Float64Array(runs.length + 1);
    for (let i = 0; i < runs.length; i++) s[i + 1] = s[i] + runs[i];
    return s;
  }

  if (root.IJOpRegistry) {
    root.IJOpRegistry.define('paintMask', {
      // Scale Bar › Overlay off: the bar, its background and its text are written into the pixels. `layers` = [{ runs, values }]
      // painted in order, `values[c]` = the value of channel c (burnValue); the whole image, whatever the selection.
      kind: 'pixel', version: 1, channels: 'each', roi: 'ignore', preview: false,
      validate(p, info) {
        if (!p || !Number.isInteger(p.w) || !Number.isInteger(p.h) || !Array.isArray(p.layers) || p.layers.length < 1 || p.layers.length > MAX_LAYERS) throw bad('paintMask params');
        if (info && (p.w !== info.width || p.h !== info.height)) throw fail('IJ_SIZE_MISMATCH', 'the mask is for another image size');
        for (const L of p.layers) {
          if (!L || !(Array.isArray(L.runs) || L.runs instanceof Uint32Array) || !Array.isArray(L.values)) throw bad('paintMask layer');
          for (let i = 0; i < L.runs.length; i++) if (!Number.isInteger(L.runs[i]) || L.runs[i] < 0) throw bad('paintMask run');
          if (runsTotal(L.runs) !== p.w * p.h) throw bad('paintMask runs do not cover the image');
          if (info && L.values.length !== info.channels) throw bad('paintMask values');
          for (const v of L.values) if (!isNum(v)) throw bad('paintMask value');
        }
      },
      scratchBytes: (info) => M_min(info.width * info.height, 1 << 20) * 4 + 65536,
      prepare(view, c, p) {
        const layers = p.layers.map((L) => ({ runs: L.runs, value: castValue(L.values[c], view.bitDepth) }));
        const cum = layers.map((L) => startsOf(L.runs));
        const W = view.width;
        return { apron: { x: 0, y: 0 }, region: (full, rect) => paintBand(full.data, W, rect, layers, cum) };
      }
    });
  }

  root.IJOv = {
    d2s, getDigits, getDigitsOfString, round125, decodeColor, colorName, cssOpaque, cssRgba, colorByName, unitsOf, pluralOf, isScaled,
    GRID_TYPES, GRID_COLORS, gridMinArea, gridDefaultArea, gridRandomOffset, gridGeometry, gridItem,
    SB_LOCATIONS, SB_COLORS, SB_BCOLORS, scaleBarConfig, scaleBarColor, scaleBarBackground, scaleBarDefaults, scaleBarNeedsDefaults, scaleBarGeometry, scaleBarItems,
    bestIndex, stretchTable, burnValue, buildMaskRuns, paintBand
  };
})(typeof self !== 'undefined' ? self : globalThis);
