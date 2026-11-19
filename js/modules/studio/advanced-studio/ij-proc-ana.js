/* ij-proc-ana.js — package P-ana (wave 3): measurements, Analyze Particles outputs, Histogram, Plot Profile, the table
 * helpers of the Results window.
 *
 * Classic script, page AND worker (ij-worker.js loads it in its own try/catch: a failure here disables the package's
 * commands, the engine keeps answering with the wave-2 code). Pure: no DOM, no engine globals. Attaches `IJAna` to `self`
 * and registers one operation with IJOpRegistry:
 *
 *   particleImage   newdoc   the "Show:" image of Analyze Particles (Outlines, Bare Outlines, Ellipses, Masks, Count Masks)
 *                            ij.plugin.filter.ParticleAnalyzer.drawParticle / showResults
 *
 *   IJAna.d2s(n, places)                         ij.measure.ResultsTable.d2s (Java DecimalFormat, HALF_EVEN)
 *   IJAna.cellString(v, precision)               ResultsTable.getValueAsString for a numeric cell
 *   IJAna.parseRange(text) → { a, b } | null     ParticleAnalyzer.showDialog: Tools.split(text, " -") + Tools.parseDouble
 *   IJAna.particleSettings(sizeText, circText, unitSquared) → { minSize, maxSize, minCirc, maxCirc }   (pixels)
 *   IJAna.sizeText(minPx, maxPx, unitSquared) → "min-max"
 *   IJAna.profile(img, roi, o) → { values, step }   ProfilePlot.getProfile (line, segmented line, rectangle)
 *   IJAna.histogramStats(img, mask, o) → { n, mean, stdDev, min, max, dmode, maxCount, histMin, histMax, binSize }
 *   IJAna.drawEllipse(out, w, h, fit, value)      ij.process.EllipseFitter.drawEllipse
 *   IJAna.invertY(row, height, ph)               ij.measure.Calibration.getY(y, imageHeight)
 *   IJAna.sortOrder(rows, key, nanEmpty) → [index]   ResultsTable.sort(column) (stable, Double.compare)
 *   IJAna.rankMatches(words, name, path) → boolean   ij.plugin.CommandFinder.populateList
 *
 * Reference: ImageJ 1.54p (public domain). Every port cites `Class.method` and quotes the lines that settle a trap.
 */
(function (root) {
  'use strict';

  const fr = Math.fround;
  const jround = (v) => Math.floor(v + 0.5);                    // java.lang.Math.round(double)
  const jint = (v) => (v < 0 ? Math.ceil(v) : Math.floor(v));   // (int) cast of a double (saturation is not needed here)
  function fail(code, msg) { const e = new Error(msg || code); e.code = code; return e; }

  // ================================================================================================
  // ResultsTable number formatting
  // ================================================================================================

  /* Exact decimal digits of |x| rounded to `places` fractional digits with the rounding mode of the Java DecimalFormat of
   * ResultsTable.d2s: HALF_EVEN for 1..9 places, HALF_UP for 0 (`df[0].setRoundingMode(RoundingMode.HALF_UP)`).
   * Number.prototype.toFixed rounds an exact tie up, so the ties are detected on the exact expansion
   * (toFixed(places + 25) is exact for every double whose decimal tie has at most places + 1 digits). */
  function fixedAbs(a, places) {
    if (places > 0) {
      const wide = a.toFixed(Math.min(100, places + 25));
      const dot = wide.indexOf('.');
      if (/^50*$/.test(wide.slice(dot + 1 + places))) {
        const keep = wide.slice(0, dot + 1 + places);
        // an exact tie: the even neighbour (truncated when the kept digit is even; toFixed rounds a tie up, which is the even one otherwise)
        return (keep.charCodeAt(keep.length - 1) - 48) % 2 === 0 ? keep : a.toFixed(places);
      }
    }
    return a.toFixed(places);
  }

  /** ij.measure.ResultsTable.d2s(double n, int decimalPlaces). */
  function d2s(n, places) {
    if (n !== n) return 'NaN';
    if (n === Infinity) return 'Infinity';
    if (n === -Infinity) return '-Infinity';
    if (n === 3.4028234663852886e38) return '3.4e38';   // "n==Float.MAX_VALUE // divide by 0 in FloatProcessor"
    const np = n < 0 ? -n : n;
    if ((np !== 0 && np < 1.0 / Math.pow(10, places)) || np > 999999999999 || places < 0) {
      let dp;
      if (places < 0) { dp = -places; if (dp > 9) dp = 9; } else dp = 3;
      // new DecimalFormat("0.000E0"): the exponent has no sign for a positive one and no padding
      return n.toExponential(dp).replace('e', 'E').replace('E+', 'E');
    }
    if (places < 0) places = 0;
    if (places > 9) places = 9;
    // DecimalFormat keeps the sign of a negative number that rounds to zero ("-0", "-0.000")
    return (n < 0 || Object.is(n, -0) ? '-' : '') + fixedAbs(np, places);
  }

  /* IJ.d2s(x, significantDigits, maxDigits) (IJ.java:1038-1050). */
  function d2sSig(x, significantDigits, maxDigits) {
    if (x !== x || !isFinite(x)) return d2s(x, 0);
    const log10 = Math.log10(Math.abs(x));
    const roundErrorAtMax = 0.223 * Math.pow(10, -maxDigits);
    const magnitude = Math.ceil(log10 + roundErrorAtMax);
    let decimals = x === 0 ? 0 : maxDigits - magnitude;
    if (decimals < 0 || magnitude < significantDigits + 1 - maxDigits) return d2s(x, -significantDigits);   // exp notation for large and small numbers
    if (decimals > significantDigits) decimals = Math.max(significantDigits, decimals - maxDigits + significantDigits);
    return d2s(x, decimals);
  }
  /* HistogramPlot.d2s(double d): "if ((int)d==d) return IJ.d2s(d, 0); else return IJ.d2s(d, 3, 8);" (HistogramPlot.java:344-349) — the Mean, StdDev,
   * Min, Max, Mode, Bins and Bin Width of the histogram window. */
  function histNumber(d) {
    if (d !== d) return 'NaN';
    return Math.abs(d) < 2147483648 && jint(d) === d ? d2s(d, 0) : d2sSig(d, 3, 8);
  }

  /** ResultsTable.getValueAsString: "(int)n==n && precision>=0 ? d2s(n, 0) : d2s(n, precision)". */
  function cellString(v, precision) {
    if (typeof v !== 'number') return v === undefined || v === null ? '' : String(v);
    if (v !== v) return 'NaN';
    if (jint(v) === v && precision >= 0 && Math.abs(v) < 2147483648) return d2s(v, 0);
    return d2s(v, precision);
  }

  // ================================================================================================
  // Analyze Particles dialog
  // ================================================================================================

  /* Tools.parseDouble(s, NaN): Double.parseDouble or NaN. */
  function parseDouble(s) {
    const t = String(s).trim();
    if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?[dDfF]?$/.test(t)) return Number(t.replace(/[dDfF]$/, ''));
    if (/^[+-]?Infinity$/.test(t)) return t[0] === '-' ? -Infinity : Infinity;
    return NaN;
  }

  /** `Tools.split(str, " -")` then the two numbers: { a, b } with NaN for a missing / unreadable one; null for a text without a token. */
  function parseRange(text) {
    const tokens = String(text === undefined || text === null ? '' : text).split(/[ -]+/).filter((t) => t.length > 0);
    return { a: tokens.length >= 1 ? parseDouble(tokens[0]) : 0.0, b: tokens.length === 2 ? parseDouble(tokens[1]) : NaN, tokens: tokens.length };
  }

  /* ParticleAnalyzer.showDialog:
   *   "minSize = Double.isNaN(mins)?DEFAULT_MIN_SIZE:mins/unitSquared; maxSize = Double.isNaN(maxs)?DEFAULT_MAX_SIZE:maxs/unitSquared;
   *    if (minSize<DEFAULT_MIN_SIZE) minSize = DEFAULT_MIN_SIZE; if (maxSize<minSize) maxSize = DEFAULT_MAX_SIZE;"
   *   "minCircularity = Double.isNaN(minc)?0.0:minc; maxCircularity = Double.isNaN(maxc)?1.0:maxc;
   *    if (minCircularity<0.0) minCircularity = 0.0; if (minCircularity>maxCircularity && maxCircularity==1.0) minCircularity = 0.0;
   *    if (minCircularity>maxCircularity) minCircularity = maxCircularity; if (maxCircularity<minCircularity) maxCircularity = minCircularity;
   *    if (minCircularity==1.0 && maxCircularity==1.0) minCircularity = 0.0;" */
  function particleSettings(sizeText, circText, unitSquared) {
    const us = unitSquared > 0 ? unitSquared : 1;
    const s = parseRange(sizeText);
    let minSize = s.a !== s.a ? 0.0 : s.a / us;
    let maxSize = s.b !== s.b ? Infinity : s.b / us;
    if (minSize < 0.0) minSize = 0.0;
    if (maxSize < minSize) maxSize = Infinity;
    const c = parseRange(circText);
    let minCirc = c.a !== c.a ? 0.0 : c.a;
    let maxCirc = c.b !== c.b ? 1.0 : c.b;
    if (minCirc < 0.0) minCirc = 0.0;
    if (minCirc > maxCirc && maxCirc === 1.0) minCirc = 0.0;
    if (minCirc > maxCirc) minCirc = maxCirc;
    if (maxCirc < minCirc) maxCirc = minCirc;
    if (minCirc === 1.0 && maxCirc === 1.0) minCirc = 0.0;
    return { minSize, maxSize, minCirc, maxCirc };
  }

  /* The text the dialog shows for the stored limits (ParticleAnalyzer.showDialog): "places = 0; if ((int)cmin!=cmin) places = 2;
   * ... cmax != DEFAULT_MAX_SIZE ... minStr = ResultsTable.d2s(cmin,places); if (minStr.indexOf("-")!=-1) { for (int i=places; i<=6; i++) {
   * minStr = ResultsTable.d2s(cmin, i); if (minStr.indexOf("-")==-1) break; } }". */
  function sizeText(minPx, maxPx, unitSquared) {
    const us = unitSquared > 0 ? unitSquared : 1;
    const cmin = minPx * us, cmax = maxPx * us;
    let places = 0;
    if (jint(cmin) !== cmin) places = 2;
    if (jint(cmax) !== cmax && cmax !== Infinity) places = 2;
    const str = (v) => {
      let s = d2s(v, places);
      if (s.indexOf('-') !== -1) for (let i = places; i <= 6; i++) { s = d2s(v, i); if (s.indexOf('-') === -1) break; }
      return s;
    };
    return str(cmin) + '-' + str(cmax);
  }
  const circText = (a, b) => d2s(a, 2) + '-' + d2s(b, 2);

  // ================================================================================================
  // Calibration.getY — Set Measurements › Invert Y coordinates
  // ================================================================================================

  /* Calibration.getY(double y, int imageHeight): "if (invertY || (Analyzer.getMeasurements()&Measurements.INVERT_Y)!=0) {
   * if (yOrigin!=0.0) return (yOrigin-y)*pixelHeight; else return (imageHeight-y-1)*pixelHeight; }". ImageJ reaches it for the
   * centroid (ImageStatistics.getCentroid: yCentroid = cal.getY(yCentroid, height), yCentroid the pixel coordinate + 0.5), the centre
   * of mass (…Statistics.calculateMoments), the bounding rectangle's Y (ImageStatistics.setup: roiY = cal.getY(ry, height)), the centre of a
   * line, the rectangle of a line and the Y of a point (Analyzer.measureLength / measurePoint). FeretY is taken from Roi.getFeretValues and is
   * NOT inverted. A calibrated value v = y_px · ph becomes (height − 1) · ph − v. */
  const INVERT_Y_KEYS = ['yCentroid', 'yCenterOfMass', 'by'];
  function invertY(row, height, ph, keys) {
    const k = keys || INVERT_Y_KEYS;
    const top = (height - 1) * ph;
    for (const key of k) if (typeof row[key] === 'number' && row[key] === row[key]) row[key] = top - row[key];
    return row;
  }

  // ================================================================================================
  // Results table helpers
  // ================================================================================================

  /* ResultsTable.sort(column): "Arrays.sort(ces)" on ComparableEntry { dValue, index }: Double.compare order (NaN last, -0.0 < 0.0), ties keep the
   * input order (Arrays.sort of objects is a stable merge sort). A cell with no value is 0, or NaN when "NaN empty cells" is set. */
  function sortOrder(rows, key, nanEmpty) {
    const val = (r) => { const v = r[key]; return typeof v === 'number' ? v : (nanEmpty ? NaN : 0); };
    const idx = rows.map((r, i) => i);
    const cmp = (x, y) => {
      if (x < y) return -1;
      if (x > y) return 1;
      if (x === y) { if (x === 0) { const nx = Object.is(x, -0), ny = Object.is(y, -0); return nx === ny ? 0 : (nx ? -1 : 1); } return 0; }
      const nx = x !== x, ny = y !== y;
      return nx === ny ? 0 : (nx ? 1 : -1);
    };
    const keyed = idx.map((i) => ({ i, v: val(rows[i]) }));
    keyed.sort((a, b) => cmp(a.v, b.v) || a.i - b.i);
    return keyed.map((e) => e.i);
  }

  /* CommandFinder.populateList: "String[] words = matchingSubstring.toLowerCase().split("\\s+"); ... every word must be contained in the command name
   * or in its menu path (both lower-cased)". */
  function rankMatches(words, name, path) {
    const n = String(name).toLowerCase(), p = String(path || '').toLowerCase();
    for (const w of words) if (!(n.indexOf(w) >= 0 || p.indexOf(w) >= 0)) return false;
    return true;
  }
  const searchWords = (text) => String(text === undefined || text === null ? '' : text).toLowerCase().split(/\s+/);

  // ================================================================================================
  // ProfilePlot
  // ================================================================================================

  /* ImageProcessor.getPixelValue(x, y): "Returns Float.NaN if (x,y) is outside the image" (Byte / Short / FloatProcessor). */
  function pixelValue(img, x, y) {
    if (x >= 0 && x < img.width && y >= 0 && y < img.height) return img.data[y * img.width + x];
    return NaN;
  }

  /* ImageProcessor.getLine(x1, y1, x2, y2) with interpolation OFF: "data[i] = getPixelValue((int)Math.round(rx), (int)Math.round(ry))". The
   * interpolating twin is IJRoiTools.lineSamples (ij-proc-roi.js). */
  function lineNearest(img, x1, y1, x2, y2) {
    const dx = x2 - x1, dy = y2 - y1;
    const n = jround(Math.sqrt(dx * dx + dy * dy));
    const xinc = n > 0 ? dx / n : 0, yinc = n > 0 ? dy / n : 0;
    const out = new Float64Array(n + 1);
    let rx = x1, ry = y1;
    for (let i = 0; i <= n; i++) { out[i] = pixelValue(img, jround(rx), jround(ry)); rx += xinc; ry += yinc; }
    return out;
  }

  /* ProfilePlot.getIrregularProfile with `PlotWindow.interpolate` as a parameter: "if (interpolate) value = ip.getInterpolatedValue(x, y); else
   * value = ip.getPixelValue((int)Math.round(x), (int)Math.round(y));" (same stepping as IJRoiTools.irregularProfile). */
  function irregularProfile(img, pts, interpolate, interp) {
    const n = pts.length, inc = 0.01;
    const values = [];
    let x2 = fr(pts[0][0]), y2 = fr(pts[0][1]);
    let lastx = 0.0, lasty = 0.0;
    for (let i = 1; i < n; i++) {
      const x1 = x2, y1 = y2;
      let x = x1, y = y1;
      x2 = fr(pts[i][0]); y2 = fr(pts[i][1]);
      let dx = x2 - x1, dy = y2 - y1;
      const distance = Math.sqrt(dx * dx + dy * dy);
      const xinc = dx * inc / distance, yinc = dy * inc / distance;
      let n2 = jint(distance / inc);
      if (n === 2) n2++;
      do {
        dx = x - lastx; dy = y - lasty;
        const distance2 = Math.sqrt(dx * dx + dy * dy);
        if (distance2 >= 1.0 - inc / 2.0) {
          values.push(interpolate ? interp(img.data, img.width, img.height, x, y) : pixelValue(img, jround(x), jround(y)));
          lastx = x; lasty = y;
        }
        x += xinc; y += yinc;
      } while (--n2 > 0);
    }
    return Float64Array.from(values);
  }

  /* ProfilePlot.getColumnAverageProfile / getRowAverageProfile (interpolation off, NaN pixels skipped):
   *   "double[] profile = new double[rect.width]; … aLine = ip.getLine(rect.x, y, rect.x+rect.width-1, y); … profile[i] += aLine[i]; counts[i]++;"
   *   "profile[i] /= counts[i];" — a column with no value is NaN. The profile has rect.width values (rect.height vertically) whatever the image holds:
   *   ImageProcessor.getLine reads "Float.NaN if (x,y) is outside the image", so the part of the rectangle outside the image gives NaN, never a shorter
   *   profile. A rectangle that does not touch the image at all is refused (ImageJ would plot an empty curve). */
  function rectProfile(img, rect, vertical) {
    const W = img.width, H = img.height;
    if (!(rect.w > 0) || !(rect.h > 0)) throw fail('IJ_EMPTY_ROI', 'the selection is empty');
    if (rect.x >= W || rect.y >= H || rect.x + rect.w <= 0 || rect.y + rect.h <= 0) throw fail('IJ_EMPTY_ROI', 'the selection is outside the image');
    const d = img.data;
    const len = vertical ? rect.h : rect.w;
    const sum = new Float64Array(len), cnt = new Int32Array(len);
    for (let y = rect.y; y < rect.y + rect.h; y++) {
      if (y < 0 || y >= H) continue;
      const o = y * W;
      for (let x = Math.max(0, rect.x); x < Math.min(W, rect.x + rect.w); x++) {
        const v = d[o + x];
        if (v !== v) continue;
        const i = vertical ? y - rect.y : x - rect.x;
        sum[i] += v; cnt[i]++;
      }
    }
    for (let i = 0; i < len; i++) sum[i] /= cnt[i];
    return sum;
  }

  /**
   * ProfilePlot(imp, verticalPlot).getProfile() of a straight line, a segmented line or a rectangle.
   *   o = { interpolate (PlotWindow.interpolate, default true), vertical (rectangle: average along the rows), calibration { pixelWidth, pixelHeight } }
   *   → { values: Float64Array, step } with the calibrated distance between two samples ("xInc = cal.pixelWidth"; a straight line with
   *   non-square pixels: calibrated over pixel length; a vertical rectangle profile: cal.pixelHeight).
   */
  function profile(img, roi, o) {
    const T = root.IJRoiTools;
    const opt = o || {};
    const interpolate = opt.interpolate !== false;
    const cal = opt.calibration || {};
    const pw = cal.pixelWidth > 0 ? cal.pixelWidth : 1, ph = cal.pixelHeight > 0 ? cal.pixelHeight : 1;
    if (!roi) throw fail('IJ_BAD_ROI', 'a selection is needed');
    if (roi.type === 'line') {
      let values;
      if ((roi.width || 0) <= 1) {
        // Line.getPixels: "if (getStrokeWidth()<=1) ip.getLine(x1d, y1d, x2d, y2d)"
        values = interpolate ? (T ? T.lineSamples(img, roi.x1, roi.y1, roi.x2, roi.y2) : lineNearest(img, roi.x1, roi.y1, roi.x2, roi.y2))
          : lineNearest(img, roi.x1, roi.y1, roi.x2, roi.y2);
      } else {
        if (!T) throw fail('IJ_MODULE_MISSING', 'module IJRoiTools is not loaded');
        values = T.wideProfile(img, [[roi.x1, roi.y1], [roi.x2, roi.y2]], jint(roi.width));
      }
      let step = pw;
      if (pw !== ph) {
        const dx = roi.x2 - roi.x1, dy = roi.y2 - roi.y1, pixelLength = Math.sqrt(dx * dx + dy * dy);
        if (pixelLength > 0) step = Math.sqrt((dx * pw) * (dx * pw) + (dy * ph) * (dy * ph)) / pixelLength;
      }
      return { values, step };
    }
    if (roi.type === 'polyline') {
      const lw = jround(roi.width || 0);
      let values;
      if (lw <= 1) values = irregularProfile(img, roi.points, interpolate, T ? T.interpolatedValue : null);
      else {
        if (!T) throw fail('IJ_MODULE_MISSING', 'module IJRoiTools is not loaded');
        values = T.wideProfile(img, roi.points, lw);
      }
      return { values, step: pw };
    }
    if (roi.type === 'rect') {
      const vertical = !!opt.vertical;
      return { values: rectProfile(img, { x: roi.x, y: roi.y, w: roi.w, h: roi.h }, vertical), step: vertical ? ph : pw };
    }
    throw fail('IJ_BAD_ROI', 'a line or a rectangle selection is needed');
  }

  // ================================================================================================
  // Histogram statistics — ByteStatistics / ShortStatistics / FloatStatistics with a histogram range
  // ================================================================================================

  /**
   * The numbers of the histogram window for `bins` bins over [histMin, histMax] ((0, 0) = the pixel value range), of the pixels
   * of `mask` (a box { x, y, w, h, data } or null) of `img` { data, width, height, bitDepth }:
   *   ShortStatistics.getStatistics: "if (histMin==0.0 && histMax==0.0) { histMin = min; histMax = max; } else { if (min<histMin) min = (int)histMin;
   *     if (max>histMax) max = (int)histMax; } binSize = (histMax-histMin+1)/nBins; … for (int i=min; i<=max; i++) { count = hist[i]; if (count>maxCount)
   *     { maxCount = count; dmode = i; } pixelCount += count; sum += i*count; sum2 += (i*i)*count; …"
   *   FloatStatistics.getStatistics / getMode: a pixel counts when "v>=histMin && v<=histMax"; "binSize = (histMax-histMin)/nBins"; the mode is
   *     "dmode = histMin+mode*binSize; if (binSize!=1.0) dmode += binSize/2.0".
   *   ByteStatistics: the 256 bins of 0..255.
   * → { n, mean, stdDev, min, max, dmode, maxCount, histMin, histMax, binSize }
   */
  function histogramStats(img, mask, o) {
    const opt = o || {};
    const nBins = opt.bins > 0 ? opt.bins : 256;
    let histMin = opt.histMin || 0, histMax = opt.histMax || 0;
    const W = img.width, d = img.data, bd = img.bitDepth;
    const mx0 = mask ? mask.x : 0, my0 = mask ? mask.y : 0, mw = mask ? mask.w : W, mh = mask ? mask.h : img.height;
    const each = (fn) => {
      for (let y = 0; y < mh; y++) {
        const o2 = (my0 + y) * W + mx0, m2 = y * mw;
        for (let x = 0; x < mw; x++) if (!mask || mask.data[m2 + x] !== 0) fn(d[o2 + x]);
      }
    };
    let n = 0, sum = 0, sum2 = 0, min, max, dmode = 0, maxCount = 0, binSize;
    if (bd === 32) {
      let roiMin = Number.MAX_VALUE, roiMax = -Number.MAX_VALUE;
      each((v) => { if (v === v && v >= -3.4028234663852886e38 && v <= 3.4028234663852886e38) { if (v < roiMin) roiMin = v; if (v > roiMax) roiMax = v; } });
      min = roiMin; max = roiMax;
      if (histMin === 0.0 && histMax === 0.0) { histMin = min; histMax = max; } else { if (min < histMin) min = histMin; if (max > histMax) max = histMax; }
      binSize = (histMax - histMin) / nBins;
      const scale = nBins / (histMax - histMin);
      const hist = new Int32Array(nBins);
      each((v) => {
        if (v === v && v >= histMin && v <= histMax) {
          n++; sum += v; sum2 += v * v;
          let i = jint(scale * (v - histMin));
          if (i >= nBins) i = nBins - 1;
          hist[i]++;
        }
      });
      let mode = 0;
      for (let i = 0; i < nBins; i++) if (hist[i] > maxCount) { maxCount = hist[i]; mode = i; }
      dmode = histMin + mode * binSize;
      if (binSize !== 1.0) dmode += binSize / 2.0;
    } else if (bd === 16) {
      const hist = new Uint32Array(65536);
      each((v) => { hist[v]++; });
      let lo = 0; while (lo < 65535 && hist[lo] === 0) lo++;
      let hi = 65535; while (hi > 0 && hist[hi] === 0) hi--;
      min = lo; max = hi;
      if (histMin === 0.0 && histMax === 0.0) { histMin = min; histMax = max; } else { if (min < histMin) min = jint(histMin); if (max > histMax) max = jint(histMax); }
      binSize = (histMax - histMin + 1) / nBins;
      // "dmode = i" for the most frequent value; getMode() then takes the modal BIN: "maxCount = count" over the binned histogram
      const scale16 = 1.0 / binSize, hMin = jint(histMin), bins16 = new Int32Array(nBins);
      let valueCount = 0;
      for (let i = min; i <= max; i++) {
        const c = hist[i];
        if (c > valueCount) { valueCount = c; dmode = i; }
        n += c; sum += i * c; sum2 += (i * i) * c;
        let idx = jint(scale16 * (i - hMin));
        if (idx >= nBins) idx = nBins - 1;
        bins16[idx] += c;
      }
      for (let i = 0; i < nBins; i++) if (bins16[i] > maxCount) maxCount = bins16[i];
    } else {
      const hist = new Uint32Array(256);
      each((v) => { hist[v]++; });
      let lo = 0; while (lo < 255 && hist[lo] === 0) lo++;
      let hi = 255; while (hi > 0 && hist[hi] === 0) hi--;
      min = lo; max = hi; histMin = 0; histMax = 255; binSize = 1;
      for (let i = 0; i < 256; i++) {
        const c = hist[i];
        if (c > maxCount) { maxCount = c; dmode = i; }   // 256 bins of one value each: the modal bin is the modal value
        n += c; sum += i * c; sum2 += (i * i) * c;
      }
    }
    const mean = sum / n;
    // ImageStatistics.calculateStdDev: "stdDev = (n*sum2-sum*sum)/n; if (stdDev>0.0) stdDev = Math.sqrt(stdDev/(n-1.0)); else stdDev = 0.0;"
    let stdDev = 0;
    if (n > 0) { const v = (n * sum2 - sum * sum) / n; stdDev = v > 0.0 ? Math.sqrt(v / (n - 1.0)) : 0.0; }
    return { n, mean, stdDev, min, max, dmode, maxCount, histMin, histMax, binSize };
  }

  // ================================================================================================
  // Drawing helpers of the "Show:" images
  // ================================================================================================

  /* ImageProcessor.lineTo(int x2, int y2) from the current point (cx, cy), line width 1: "n = max(|dx|,|dy|); xinc = dx!=0 ? (double)dx/n : 0; …
   * for (i=i1; i<=i2; i++) { drawPixel((int)Math.round(x), (int)Math.round(y)); x += xinc; y += yinc; }" — drawPixel ignores a point outside the image. */
  function lineTo(out, w, h, cx, cy, x2, y2, value) {
    const dx = x2 - cx, dy = y2 - cy;
    const absdx = dx >= 0 ? dx : -dx, absdy = dy >= 0 ? dy : -dy;
    const n = absdy > absdx ? absdy : absdx;
    const xinc = dx !== 0 ? dx / n : 0, yinc = dy !== 0 ? dy / n : 0;
    let x = cx, y = cy;
    for (let i = 0; i <= n; i++) {
      const px = jround(x), py = jround(y);
      if (px >= 0 && py >= 0 && px < w && py < h) out[py * w + px] = value;
      x += xinc; y += yinc;
    }
  }

  /** ParticleAnalyzer.drawOutline for a traced polygon: moveTo(first vertex), lineTo each next vertex, then back to the first. */
  function drawPolygon(out, w, h, pts, value) {
    const n = pts.length;
    if (!n) return;
    let cx = pts[0][0], cy = pts[0][1];
    for (let i = 1; i < n; i++) { lineTo(out, w, h, cx, cy, pts[i][0], pts[i][1], value); cx = pts[i][0]; cy = pts[i][1]; }
    lineTo(out, w, h, cx, cy, pts[0][0], pts[0][1], value);
  }

  /* EllipseFitter.drawEllipse(ip): the symmetric outline of an ellipse of the fit (major, minor, theta) centred on (xCenter, yCenter), drawn with moveTo /
   * lineTo. Quoted: "int xc = (int)Math.round(xCenter); … ymax = (int)Math.floor(Math.sqrt(Math.abs(k3 / k2))); if (ymax>maxY) ymax = maxY; if (ymax<1) ymax = 1;
   * … txmin[y] = (int)Math.round(j1 - j2); txmax[y] = (int)Math.round(j1 + j2);". */
  function drawEllipse(out, w, h, fit, value) {
    if (fit.major === 0.0 && fit.minor === 0.0) return;
    const sqr = (x) => x * x;
    const xc = jround(fit.xCenter), yc = jround(fit.yCenter);
    const maxY = h;
    const sint = Math.sin(fit.theta), cost = Math.cos(fit.theta);
    const rmajor2 = 1.0 / sqr(fit.major / 2), rminor2 = 1.0 / sqr(fit.minor / 2);
    const g11 = rmajor2 * sqr(cost) + rminor2 * sqr(sint);
    const g12 = (rmajor2 - rminor2) * sint * cost;
    const g22 = rmajor2 * sqr(sint) + rminor2 * sqr(cost);
    const k1 = -g12 / g11;
    const k2 = (sqr(g12) - g11 * g22) / sqr(g11);
    const k3 = 1.0 / g11;
    let ymax = Math.floor(Math.sqrt(Math.abs(k3 / k2)));
    if (ymax > maxY) ymax = maxY;
    if (ymax < 1) ymax = 1;
    const ymin = -ymax;
    const txmin = new Int32Array(ymax + 1), txmax = new Int32Array(ymax + 1);
    for (let y = 0; y <= ymax; y++) {
      const j2 = Math.sqrt(k2 * sqr(y) + k3), j1 = k1 * y;
      txmin[y] = jround(j1 - j2);
      txmax[y] = jround(j1 + j2);
    }
    let cx = xc + txmin[ymax - 1], cy = yc + ymin;
    for (let y = ymin; y < ymax; y++) {
      const x = y < 0 ? txmax[-y] : -txmin[y];
      lineTo(out, w, h, cx, cy, xc + x, yc + y, value);
      cx = xc + x; cy = yc + y;
    }
    for (let y = ymax; y > ymin; y--) {
      const x = y < 0 ? txmin[-y] : -txmax[y];
      lineTo(out, w, h, cx, cy, xc + x, yc + y, value);
      cx = xc + x; cy = yc + y;
    }
  }

  // ================================================================================================
  // particleImage — the "Show:" image
  // ================================================================================================

  const SHOW_KINDS = ['outlines', 'bareOutlines', 'ellipses', 'masks', 'countMasks'];
  const SHOW_PREFIX = { outlines: 'Drawing of ', bareOutlines: 'Drawing of ', ellipses: 'Drawing of ', masks: 'Mask of ', countMasks: 'Count Masks of ' };

  /** The analysis options a request carries, as ij-analysis.js IJParticles.analyze takes them (pixels; `unit: 'um2'` = calibrated sizes). */
  function analysisOptions(a, calibration, maskBox) {
    const o = Object.assign({}, a || {});
    const pw = calibration && calibration.pixelWidth > 0 ? calibration.pixelWidth : 1, ph = calibration && calibration.pixelHeight > 0 ? calibration.pixelHeight : 1;
    if (o.unit === 'um2') {
      const px = pw * ph;
      if (o.minSize != null) o.minSize = o.minSize / px;
      if (o.maxSize != null) o.maxSize = o.maxSize / px;
    }
    o.calibration = calibration;
    o.maskBox = maskBox || null;
    delete o.roi; delete o.unit; delete o.sink;
    return o;
  }

  const R = root.IJOpRegistry;
  if (R && !R.get('particleImage')) {
    R.define('particleImage', {
      kind: 'newdoc', version: 1, bitDepths: [8], channels: 'one', roi: 'mask',
      validate(params) {
        if (!params || SHOW_KINDS.indexOf(params.show) < 0) throw fail('IJ_BAD_ARGS', 'show');
        if (params.opts !== undefined && (params.opts === null || typeof params.opts !== 'object')) throw fail('IJ_BAD_ARGS', 'opts');
        if (params.threshold !== undefined && params.threshold !== null && !(params.threshold && isFinite(params.threshold.lower) && isFinite(params.threshold.upper))) throw fail('IJ_BAD_ARGS', 'threshold');
        if (params.rowOffset !== undefined && !(Number.isInteger(params.rowOffset) && params.rowOffset >= 0)) throw fail('IJ_BAD_ARGS', 'rowOffset');
      },
      // the peak of one analysis (IJParticles.scratchBytes: working copy, the pixel list and flood-fill stack at their doubled size, the drawing, the
      // selection's box and the ellipse mask) plus the thresholded mask
      scratchBytes: (info, params) => {
        const P = root.IJParticles, show = params && params.show;
        const base = P && P.scratchBytes ? P.scratchBytes(info.width, info.height, { counts: show === 'countMasks', ellipses: show === 'ellipses', roi: true }) : info.width * info.height * 12;
        return base + (params && params.threshold ? info.width * info.height : 0);
      },
      async run(view, params, roi, io) {
        const IJParticles = root.IJParticles;
        if (!IJParticles) throw fail('IJ_MODULE_MISSING', 'module IJParticles is not loaded');
        const W = view.width, H = view.height;
        const c = io.channel !== null && io.channel !== undefined ? io.channel : view.active;
        const ch = view.channels[c];
        if (!ch) throw fail('IJ_BAD_ARGS', 'channel');
        const box = roi ? io.roiMask(roi) : null;
        const show = params.show;
        const counts = show === 'countMasks';
        const offset = params.rowOffset || 0;
        const out = counts ? new Uint16Array(W * H) : new Uint8Array(W * H);
        // ParticleAnalyzer.analyze: "drawIP.setColor(Color.white); drawIP.fill(); drawIP.setColor(Color.black);" for the drawings (a white page, black marks);
        // the Masks and Count Masks images start at 0 ("if (showChoice==ROI_MASKS || blackBackground) { drawIP.setColor(Color.black); drawIP.fill(); … }"
        // for Count Masks; Masks use an inverted LUT, "else if (showChoice==MASKS&&!blackBackground) drawIP.invertLut();", so 255 marks a particle)
        const drawing = show === 'outlines' || show === 'bareOutlines' || show === 'ellipses';
        if (drawing) out.fill(255);
        let n = 0;
        const T = root.IJRoiTools;
        const sink = (rec, pix, np, index) => {
          n = index;
          if (show === 'masks') { for (let i = 0; i < np; i++) out[pix[i]] = 255; }
          else if (counts) {
            // drawRoiFilledParticle: "int grayLevel = (count < 65535) ? count : 65535;" with count = rt.size()
            // (with "Clear results" off the rows of an earlier run count too: rowOffset = rt.size() before this run)
            const count = index + offset;
            const g = count < 65535 ? count : 65535;
            for (let i = 0; i < np; i++) out[pix[i]] = g;
          } else if (show === 'ellipses') {
            if (!T) throw fail('IJ_MODULE_MISSING', 'module IJRoiTools is not loaded');
            // ImageStatistics.fitEllipse over the particle's mask in its bounding rectangle; "if (r.width>1 && r.height>1)" a mask exists, else the rectangle is used
            const rect = { x: rec.bx, y: rec.by, w: rec.bw, h: rec.bh };
            let m = null;
            if (rect.w > 1 && rect.h > 1) {
              m = new Uint8Array(rect.w * rect.h);
              for (let i = 0; i < np; i++) { const p = pix[i], x = p % W, y = (p - x) / W; m[(y - rect.y) * rect.w + (x - rect.x)] = 1; }
            }
            drawEllipse(out, W, H, T.fitEllipse(m, rect), 0);
          } else drawPolygon(out, W, H, rec.outline, 0);   // drawOutline: "ip.setValue(0.0)" (the labels of Outlines are text items of the page)
          io.check();
        };
        const o = analysisOptions(params.opts, view.calibration, box);
        o.sink = sink;
        // Composite ROIs: the circularity filter reads the length of the particle's selection (ParticleAnalyzer.java:915-927), as doc.particles does
        if (params.composite === true && !o.includeHoles && root.IJRoiTools && root.IJRoiTools.maskPerimeter && root.IJRoi) {
          o.perimeterOf = (outline, pix, np, rect, pw, ph) => {
            const sub = new Uint8Array(rect.w * rect.h);
            for (let k = 0; k < np; k++) { const px = pix[k], x = px % W, y = (px - x) / W; sub[(y - rect.y) * rect.w + (x - rect.x)] = 1; }
            return root.IJRoiTools.maskPerimeter({ type: 'mask', x: rect.x, y: rect.y, w: rect.w, h: rect.h, rle: Uint32Array.from(root.IJRoi.rleEncode(sub)) }, pw, ph);
          };
        }
        // ParticleAnalyzer.setThresholdLevels: the analysed pixels are the threshold range when the image has one
        let analysed = ch.data;
        if (params.threshold) {
          const lo = params.threshold.lower, hi = params.threshold.upper;
          analysed = new Uint8Array(W * H);
          for (let i = 0; i < analysed.length; i++) { const v = ch.data[i]; if (v >= lo && v <= hi) analysed[i] = 1; }
        }
        await IJParticles.analyzeAsync(analysed, W, H, o, (f) => io.tick(f, 'op.particles'));
        await io.tick(1, 'op.particles');
        // ImagePlus(prefix + title, outlines); setCalibration(imp.getCalibration())
        const display = counts ? undefined : { min: 0, max: 255, lut: 'Grays', invert: show === 'masks' };
        const chOut = { name: '', color: '#ffffff', data: out };
        if (display) chOut.display = display;
        return [{
          name: SHOW_PREFIX[show] + view.name, width: W, height: H, bitDepth: counts ? 16 : 8,
          calibration: view.calibration ? Object.assign({}, view.calibration) : view.calibration,
          channels: [chOut]
        }];
      }
    });
  }

  root.IJAna = {
    d2s, d2sSig, histNumber, cellString, parseRange, parseDouble, particleSettings, sizeText, circText, invertY, INVERT_Y_KEYS, sortOrder, rankMatches, searchWords,
    profile, rectProfile, lineNearest, irregularProfile, histogramStats, drawEllipse, drawPolygon, lineTo, analysisOptions, SHOW_KINDS
  };
})(typeof self !== 'undefined' ? self : globalThis);
