/* ij-proc-seg.js — package P3 (seg): Distance Map, Ultimate Points, Watershed, Voronoi, Skeletonize, Find Maxima.
 *
 * Classic script, page AND worker (ij-worker.js loads it in its own try/catch). Pure: no DOM, no engine
 * globals. Operations are registered with IJOpRegistry.define (PLAN-wave2 §2.1):
 *
 *   edm, ultimatePoints, watershed, voronoi, skeletonize   pixel, whole image, selection ignored (ImageJ:
 *       EDM.java "These functions do not take ROIs into account"; Binary.run: `ip.resetRoi(); skeletonize(ip)`)
 *   edmOutput       newdoc  the EDM / UEP / Voronoi into a NEW 8-bit, 16-bit or 32-bit image (Process › Binary ›
 *                           Options › "EDM output"; the Overwrite choice is the pixel operation above)
 *   findMaxima      compute Count / Point Selection / List: { count, points:[x0,y0,x1,y1,…] } in ImageJ's order
 *   findMaximaImage newdoc  Single Points / Maxima Within Tolerance / Segmented Particles
 *
 * Reference: ImageJ 1.54p (public domain) — ij.plugin.filter.{EDM, MaximumFinder, Binary},
 * ij.process.{BinaryProcessor, ByteProcessor, FloatProcessor, TypeConverter}, ij.gui.Wand. Every port cites its
 * Class.method and quotes the lines that settle a trap.
 *
 * Mask convention. ImageJ's binary plugins work on "black = objects" or "white = objects" depending on
 * Prefs.blackBackground and the LUT. This Studio keeps masks as ImageJ does with Prefs.blackBackground = true:
 * objects are 255 on a 0 background, and a channel whose display says `invert` (inverting LUT) swaps them:
 *   EDM.setup:  `background255 = (invertedLut && Prefs.blackBackground) || (!invertedLut && !Prefs.blackBackground);`
 *   Binary.skeletonize: `int fg = Prefs.blackBackground?255:0; if (ip.isInvertedLut()) fg = 255-fg;`
 * The Outline command is the v1 `binary` operation (ij-analysis.js IJBinary.outline) on a normal LUT; on an inverting
 * LUT the objects are the 0 pixels (`BinaryProcessor.process`: `bgColor = parent.isInvertedLut() ? 0 : 255`): both are
 * the `segOutline` operation below.
 *
 * Precision. ImageJ keeps the EDM and every MaximumFinder quantity in Java `float`: wherever the Java code
 * adds, subtracts or scales floats the port rounds with Math.fround at the same place (the sort key, the
 * sorting-error margin, the ridge height of an EDM). Integer images (8 and 16 bit) hold exact values, so
 * their results are exact; for 32-bit images the same float arithmetic gives the same bits.
 */
(function (root) {
  'use strict';
  const R = root.IJOpRegistry;
  const S = root.IJShared;
  const fr = Math.fround;
  const mtrunc = Math.trunc;
  const mround = Math.round; // a local: a global lookup is slow in a sandboxed realm

  function fail(code, message) {
    const e = new Error(message || code);
    e.code = code;
    return e;
  }
  if (!R) return;
  if (!S) throw fail('IJ_MODULE_MISSING', 'IJShared');

  // ───────────────────────────────────────────── MaximumFinder ─────────────────────────────────────────────
  // ij.plugin.filter.MaximumFinder (1.54p), ported method by method. `data` is the pixel array of the image
  // the finder reads (Uint8Array, Uint16Array or Float32Array: `ip.getPixelValue(x, y)` of an uncalibrated image
  // is the raw value).

  const NO_THRESHOLD = -808080.0; // ImageProcessor.NO_THRESHOLD
  const SINGLE_POINTS = 0, IN_TOLERANCE = 1, SEGMENTED = 2, POINT_SELECTION = 3, LIST = 4, COUNT = 5;
  // MaximumFinder: "the following constants are used to set bits corresponding to pixel types"
  const MAXIMUM = 1, LISTED = 2, PROCESSED = 4, MAX_AREA = 8, EQUAL = 16, MAX_POINT = 32, ELIMINATED = 64;
  const OUTPUT_TYPE_MASKS = [MAX_POINT, MAX_AREA, MAX_AREA];
  const SQRT2 = fr(1.4142135624); // final static float SQRT2 = 1.4142135624f
  const HALF_SQRT2 = fr(0.5 * SQRT2); // 0.5f*SQRT2 (a power-of-two factor: exact in float)
  const DIR_X = [0, 1, 1, 1, 0, -1, -1, -1]; // DIR_X_OFFSET, 0 = North (-y), clockwise
  const DIR_Y = [-1, -1, 0, 1, 1, 1, 0, -1];
  const YIELD_MASK = 0x3fff; // an `await` every 16 384 units of work in a hot loop (the tick itself rate-limits)

  // A progress window of a controller: { tick(f) → Promise, check() }. null = no progress, never yields.
  function sub(ctl, lo, hi) {
    return ctl ? { tick: (f) => ctl.tick(lo + (hi - lo) * Math.min(1, Math.max(0, f))), check: ctl.check, reserve: ctl.reserve } : null;
  }
  async function tick(ctl, f) { if (ctl) await ctl.tick(f); }

  // Stable LSD radix sort of `offs` by `keys` (Uint32), ascending; ties keep their order (here: raster order).
  // MaximumFinder: `maxPoints[iMax++] = (long)iValue<<32|p; ... Arrays.sort(maxPoints)` sorts by (iValue, p), and the
  // points are listed in raster order (p ascending), so a stable sort by iValue gives the same sequence.
  function sortByKey(keys, offs) {
    const n = keys.length;
    let k0 = keys, o0 = offs, k1 = new Uint32Array(n), o1 = new Int32Array(n);
    const count = new Int32Array(2048);
    for (let shift = 0; shift < 32; shift += 11) {
      count.fill(0);
      for (let i = 0; i < n; i++) count[(k0[i] >>> shift) & 2047]++;
      let sum = 0;
      for (let b = 0; b < 2048; b++) { const c = count[b]; count[b] = sum; sum += c; }
      for (let i = 0; i < n; i++) {
        const b = (k0[i] >>> shift) & 2047;
        const d = count[b]++;
        k1[d] = k0[i]; o1[d] = o0[i];
      }
      let t = k0; k0 = k1; k1 = t;
      t = o0; o0 = o1; o1 = t;
    }
    return o0; // after three passes the sorted offsets are in o0 (three swaps: the second buffer)
  }

  /* Find the maxima of an image — MaximumFinder.findMaxima(ip, tolerance, strict, threshold, outputType,
   * excludeOnEdges, isEDM).
   *   src = { data, width, height }
   *   o   = { tolerance, strict, threshold (default NO_THRESHOLD), outputType (SINGLE_POINTS … COUNT),
   *           excludeOnEdges, isEDM, roi: {x,y,w,h} | null (the ROI rectangle of `ip`),
   *           mask: Uint8Array(roi.w·roi.h) | null (ip.getMaskArray()), contains(x, y) | null (imp.getRoi().contains) }
   * → { out: Uint8Array | null (0 / 255 image: SINGLE_POINTS, IN_TOLERANCE, SEGMENTED), points: [x0, y0, …] | null
   *     (POINT_SELECTION, LIST, COUNT: MaximumFinder's xyCoordinates) } */
  // `1.1f * (isEDM ? SQRT2/2f : (globalMax-globalMin)/2e9f)`: float times float, rounded once (1.1f is not the double 1.1)
  const sortingMargin = (isEDM, range) => fr(fr(1.1) * (isEDM ? fr(SQRT2 / 2) : fr(range / fr(2e9))));

  async function findMaxima(src, o, ctl) {
    const data = src.data, width = src.width, height = src.height;
    const size = width * height;
    const tolerance = o.tolerance;
    const strict = !!o.strict;
    const outputType = o.outputType;
    const excludeOnEdges = !!o.excludeOnEdges;
    const isEDM = !!o.isEDM;
    const roi = o.roi || { x: 0, y: 0, w: width, h: height };
    const mask = o.mask || null;
    let threshold = o.threshold === undefined ? NO_THRESHOLD : o.threshold;
    const isFloat = data.constructor.name === 'Float32Array'; // by name: the caller's realm may not be this one
    if (isEDM && !isFloat) throw fail('IJ_BAD_ARGS', 'an EDM is a float image');

    // makeDirectionOffsets: "dirOffset  = new int[] {-width, -width+1, +1, +width+1, +width, +width-1,   -1, -width-1 }"
    const dirOffset = [-width, -width + 1, 1, width + 1, width, width - 1, -1, -width - 1];
    let shift = 0, mult = 1;
    do { shift++; mult *= 2; } while (mult < width);
    const intEncodeXMask = mult - 1;
    const intEncodeShift = shift;
    const xmax = width - 1, ymax = height - 1;
    // isWithin(x, y, direction): is the neighbour in that direction inside the image
    function isWithin(x, y, d) {
      switch (d) {
        case 0: return y > 0;
        case 1: return x < xmax && y > 0;
        case 2: return x < xmax;
        case 3: return x < xmax && y < ymax;
        case 4: return y < ymax;
        case 5: return x > 0 && y < ymax;
        case 6: return x > 0;
        case 7: return x > 0 && y > 0;
      }
      return false;
    }

    /* trueEdmHeight: "Get estimated "true" height of a maximum or saddle point of a Euclidian Distance Map."
     * Java float arithmetic throughout (sums of two floats halved, offsets added: Math.fround at each float result). */
    const dOff = Int32Array.from(dirOffset), dX = Int32Array.from(DIR_X), dY = Int32Array.from(DIR_Y); // typed copies for the hot loops
    function trueEdmHeight(x, y) {
      const offset = x + y * width;
      const v = data[offset];
      if (x === 0 || y === 0 || x === xmax || y === ymax || v === 0) return v; // "don't recalculate for edge pixels or background"
      let trueH = fr(v + HALF_SQRT2); // "true height can never by higher than this"
      let ridgeOrMax = false;
      for (let d = 0; d < 4; d++) { // "for all directions halfway around:" (d2 = (d+4)%8, the opposite direction)
        const v1 = data[offset + dOff[d]];
        const v2 = data[offset + dOff[d + 4]];
        let h;
        if (v >= v1 && v >= v2) { ridgeOrMax = true; h = fr((v1 + v2) * 0.5); } else h = v1 < v2 ? v1 : v2; // (v1+v2)/2: halving is exact, one rounding
        h = fr(h + ((d & 1) === 0 ? 1 : SQRT2)); // "in diagonal directions, distance is sqrt2"
        if (trueH > h) trueH = h;
      }
      if (!ridgeOrMax) trueH = v;
      return trueH;
    }

    // ── findMaxima(): globalMin / globalMax over the ROI rectangle ("ImageStatistics won't work if we have no ImagePlus")
    let globalMin = 3.4028234663852886e38; // Float.MAX_VALUE
    let globalMax = -3.4028234663852886e38;
    for (let y = roi.y; y < roi.y + roi.h; y++) {
      for (let x = roi.x, i = x + y * width; x < roi.x + roi.w; x++, i++) {
        const v = data[i];
        if (globalMin > v) globalMin = v;
        if (globalMax < v) globalMax = v;
      }
    }
    const range = fr(globalMax - globalMin); // float - float
    let maximumPossible = globalMax > globalMin;
    if (strict && range <= tolerance) maximumPossible = false; // `globalMax - globalMin <= tolerance` (float difference)
    // "avoid rounding errors"
    if (threshold !== NO_THRESHOLD) threshold -= range * 1e-6;
    // "for segmentation, exclusion of edge maxima cannot be done now but has to be done after segmentation"
    const excludeEdgesNow = excludeOnEdges && outputType !== SEGMENTED;

    const types = new Uint8Array(size); // "will be a notepad for pixel types"

    // ── getSortedMaxPoints
    await tick(ctl, 0);
    let maxOffs = new Int32Array(0);
    if (maximumPossible) {
      const checkThreshold = threshold !== NO_THRESHOLD;
      let nMax = 0;
      for (let y = roi.y; y < roi.y + roi.h; y++) { // find local maxima now
        if ((y & 31) === 0) await tick(ctl, 0.25 * ((y - roi.y) / roi.h));
        for (let x = roi.x, i = x + y * width; x < roi.x + roi.w; x++, i++) {
          const v = data[i];
          if (v === globalMin) continue;
          if (excludeEdgesNow && (x === 0 || x === xmax || y === 0 || y === ymax)) continue;
          if (checkThreshold && v < threshold) continue;
          let isMax = true;
          /* "check wheter we have a local maximum. Note: For an EDM, we need all maxima: those of the EDM-corrected
           * values (needed by findMaxima) and those of the raw values (needed by cleanupMaxima)". ImageJ computes the
           * corrected heights of the pixel and of every neighbour first; they only matter when a neighbour is higher, so
           * they are computed then (trueEdmHeight has no side effect). */
          let vTrue = 0, haveTrue = false;
          const isInner = (y !== 0 && y !== ymax) && (x !== 0 && x !== xmax);
          for (let d = 0; d < 8; d++) { // compare with the 8 neighbor pixels
            if (isInner || isWithin(x, y, d)) {
              if (data[i + dOff[d]] > v) { // vNeighbor > v
                if (!isEDM) { isMax = false; break; } // vNeighborTrue == vNeighbor, vTrue == v
                if (!haveTrue) { vTrue = trueEdmHeight(x, y); haveTrue = true; }
                if (trueEdmHeight(x + dX[d], y + dY[d]) > vTrue) { isMax = false; break; }
              }
            }
          }
          if (isMax) { types[i] = MAXIMUM; nMax++; }
        }
      }
      // "float vFactor = (float)(2e9/(globalMax-globalMin)); //for converting float values into a 32-bit int"
      const vFactor = fr(2e9 / range);
      // Every plateau pixel is a maximum: keys + offsets + the two sort buffers = 16 bytes each, counted before they exist.
      if (ctl && ctl.reserve) ctl.reserve(16 * nMax);
      const keys = new Uint32Array(nMax);
      const offs = new Int32Array(nMax);
      let iMax = 0;
      for (let y = roi.y; y < roi.y + roi.h; y++) { // "enter all maxima into an array"
        if ((y & 31) === 0) await tick(ctl, 0.25 + 0.05 * ((y - roi.y) / roi.h));
        for (let x = roi.x, p = x + y * width; x < roi.x + roi.w; x++, p++) {
          if (types[p] === MAXIMUM) {
            const fValue = isEDM ? trueEdmHeight(x, y) : data[p];
            // "int iValue = (int)((fValue-globalMin)*vFactor); //32-bit int, linear function of float value" — float
            // subtraction, float product, then the saturating float→int cast.
            const f = fr(fr(fValue - globalMin) * vFactor);
            let iValue = f >= 2147483647 ? 2147483647 : f <= -2147483648 ? -2147483648 : f !== f ? 0 : mtrunc(f);
            keys[iMax] = (iValue ^ 0x80000000) >>> 0; // signed order == unsigned order of the biased key
            offs[iMax] = p;
            iMax++;
          }
        }
      }
      await tick(ctl, 0.3);
      maxOffs = sortByKey(keys, offs);
    }
    const nMax = maxOffs.length;

    // ── analyzeAndMarkMaxima
    // "if (ip instanceof FloatProcessor) maxSortingError = 1.1f * (isEDM ? SQRT2/2f : (globalMax-globalMin)/2e9f);"
    let maxSortingError = 0;
    if (isFloat) maxSortingError = sortingMargin(isEDM, range);
    const tolF = fr(tolerance); // `v0-(float)tolerance`
    const pList = new Int32Array(size); // "here we enter points starting from a maximum" (reused by cleanupMaxima)
    const displayOrCount = outputType === POINT_SELECTION || outputType === LIST || outputType === COUNT;
    let points = displayOrCount ? new Int32Array(1024) : null; // x0, y0, x1, y1, … (grown by doubling)
    let nPoints = 0;
    const contains = o.contains || null;
    const edmPixels = isEDM ? data : null;
    let work = 0;

    for (let iMax = nMax - 1; iMax >= 0; iMax--) { // "process all maxima now, starting from the highest"
      if ((iMax & 255) === 0) await tick(ctl, 0.3 + 0.35 * (1 - iMax / nMax));
      let offset0 = maxOffs[iMax]; // the 32 lower bits, where the pixel index is encoded
      if ((types[offset0] & PROCESSED) !== 0) continue; // "this maximum has been reached from another one, skip it"
      let x0 = offset0 % width;
      let y0 = (offset0 / width) | 0;
      let v0 = isEDM ? trueEdmHeight(x0, y0) : data[offset0];
      let sortingError;
      do { // "repeat if we have encountered a sortingError"
        pList[0] = offset0;
        types[offset0] |= (EQUAL | LISTED); // "mark first point as equal height (to itself) and listed"
        let listLen = 1;
        let listI = 0;
        let isEdgeMaximum = (x0 === 0 || x0 === xmax || y0 === 0 || y0 === ymax);
        sortingError = false; // "if sorting was inaccurate: a higher maximum was not handled so far"
        let maxPossible = true; // "it may be a true maximum"
        let xEqual = x0; // "for creating a single point: determine average over the coordinates of contiguous equal-height points"
        let yEqual = y0;
        let nEqual = 1;
        let hiBound = fr(v0 + maxSortingError); // `v0 + maxSortingError`
        let loBound = fr(v0 - tolF); // `v0-(float)tolerance`
        do { // "while neigbor list is not fully processed (to listLen)"
          const offset = pList[listI];
          const y = (offset / width) | 0;
          const x = offset - y * width;
          const isInner = (y !== 0 && y !== ymax) && (x !== 0 && x !== xmax);
          for (let d = 0; d < 8; d++) { // "analyze all neighbors (in 8 directions) at the same level"
            const offset2 = offset + dOff[d];
            if ((isInner || isWithin(x, y, d)) && (types[offset2] & LISTED) === 0) {
              if (isEDM && edmPixels[offset2] <= 0) continue; // "ignore the background (non-particles)"
              if ((types[offset2] & PROCESSED) !== 0) {
                maxPossible = false; // "we have reached a point processed previously, thus it is no maximum now"
                break;
              }
              const x2 = x + dX[d];
              const y2 = y + dY[d];
              const v2 = isEDM ? trueEdmHeight(x2, y2) : data[offset2];
              if (v2 > hiBound) {
                maxPossible = false; // "we have reached a higher point, thus it is no maximum"
                break;
              } else if (v2 >= loBound) {
                if (v2 > v0) { // "maybe this point should have been treated earlier"
                  sortingError = true;
                  offset0 = offset2; v0 = v2; x0 = x2; y0 = y2;
                  hiBound = fr(v0 + maxSortingError); loBound = fr(v0 - tolF);
                }
                pList[listLen] = offset2;
                listLen++; // "we have found a new point within the tolerance"
                types[offset2] |= LISTED;
                if ((x2 === 0 || x2 === xmax || y2 === 0 || y2 === ymax) && (strict || v2 >= v0)) {
                  isEdgeMaximum = true;
                  if (excludeEdgesNow) {
                    maxPossible = false;
                    break; // "we have an edge maximum"
                  }
                }
                if (v2 === v0) { // "prepare finding center of equal points (in case single point needed)"
                  types[offset2] |= EQUAL;
                  xEqual += x2;
                  yEqual += y2;
                  nEqual++;
                }
              }
            }
          }
          listI++;
          if ((++work & YIELD_MASK) === 0) await tick(ctl, 0.3 + 0.35 * (1 - iMax / nMax));
        } while (listI < listLen);

        if (sortingError) { // "if x0,y0 was not the true maximum but we have reached a higher one"
          for (listI = 0; listI < listLen; listI++) types[pList[listI]] = 0; // "reset all points encountered, then retry"
        } else {
          const resetMask = ~(maxPossible ? LISTED : (LISTED | EQUAL));
          xEqual /= nEqual;
          yEqual /= nEqual;
          let minDist2 = 1e20;
          let nearestI = 0;
          for (listI = 0; listI < listLen; listI++) {
            const offset = pList[listI];
            const y = (offset / width) | 0;
            const x = offset - y * width;
            types[offset] &= resetMask; // "reset attributes no longer needed"
            types[offset] |= PROCESSED; // "mark as processed"
            if (maxPossible) {
              types[offset] |= MAX_AREA;
              if ((types[offset] & EQUAL) !== 0) {
                const dist2 = (xEqual - x) * (xEqual - x) + (yEqual - y) * (yEqual - y);
                if (dist2 < minDist2) {
                  minDist2 = dist2; // "this could be the best "single maximum" point"
                  nearestI = listI;
                }
              }
            }
          }
          if (maxPossible) {
            const offset = pList[nearestI];
            types[offset] |= MAX_POINT;
            // `this.excludeOnEdges` is the dialog's static field: the same flag as the `excludeOnEdges` argument
            if (displayOrCount && !(excludeOnEdges && isEdgeMaximum)) {
              const y = (offset / width) | 0;
              const x = offset - y * width;
              if (!contains || contains(x, y)) {
                if (nPoints + 2 > points.length) { const g = new Int32Array(points.length * 2); g.set(points); points = g; }
                points[nPoints++] = x; points[nPoints++] = y;
              }
            }
          }
        }
      } while (sortingError); // "redo if we have encountered a higher maximum: handle it now."
    }
    if (nMax === 0) types.fill(PROCESSED | MAX_AREA); // "no initial maxima at all? then consider all as 'within tolerance'"
    if (displayOrCount) return { out: null, points: points.slice(0, nPoints) };

    // ── output image
    let outPixels;
    if (outputType === SEGMENTED) {
      /* "Segmentation required, convert to 8bit (also for 8-bit images, since the calibration may have a negative
       * slope). outIp has background 0, maximum areas 255" */
      outPixels = await make8bit(data, types, width, height, isEDM, globalMin, globalMax, threshold, sub(ctl, 0.65, 0.67));
      await cleanupMaxima(outPixels, types, maxOffs, pList, width, height, dirOffset, isWithin, sub(ctl, 0.67, 0.72));
      const ok = await watershedSegment(outPixels, width, height, intEncodeXMask, intEncodeShift, dirOffset, isWithin, sub(ctl, 0.72, 0.95), pList);
      if (!ok) return null;
      if (!isEDM) await cleanupExtraLines(outPixels, width, height, dirOffset, isWithin, sub(ctl, 0.95, 0.99)); // "eliminate lines due to local minima (none in EDM)"
      for (let i = 0; i < size; i++) if (outPixels[i] < 255) outPixels[i] = 0; // watershedPostProcess: "levels to binary image"
      if (excludeOnEdges) deleteEdgeParticles(outPixels, types, width, height);
    } else { // "outputType other than SEGMENTED"
      const m = OUTPUT_TYPE_MASKS[outputType];
      for (let i = 0; i < size; i++) types[i] = ((types[i] & m) !== 0) ? 255 : 0;
      outPixels = types;
    }
    // "delete everything outside roi"
    if (roi.x !== 0 || roi.y !== 0 || roi.w !== width || roi.h !== height || mask) {
      for (let y = 0, i = 0; y < height; y++) {
        for (let x = 0; x < width; x++, i++) {
          if (x < roi.x || x >= roi.x + roi.w || y < roi.y || y >= roi.y + roi.h) outPixels[i] = 0;
          else if (mask && mask[x - roi.x + roi.w * (y - roi.y)] === 0) outPixels[i] = 0;
        }
      }
    }
    await tick(ctl, 1);
    return { out: outPixels, points: null };
  }

  /* make8bit: "Create an 8-bit image by scaling the pixel values of ip to 1-254 (<lower threshold 0) and mark maximum
   * areas as 255. For use as input for watershed segmentation". */
  async function make8bit(data, types, width, height, isEDM, globalMin, globalMax, threshold, ctl) {
    let minValue;
    if (isEDM) { threshold = 0.5; minValue = 1.0; } else minValue = (threshold === NO_THRESHOLD) ? globalMin : threshold;
    // "everything above minValue should become >(byte)0"
    const offset = minValue - (globalMax - minValue) * (1.0 / 253 / 2 - 1e-6);
    let factor = 253 / (globalMax - minValue);
    if (isEDM && factor > 1) factor = 1; // "with EDM, no better resolution"
    const size = width * height;
    const pixels = new Uint8Array(size);
    const hasThreshold = threshold !== NO_THRESHOLD;
    // the per-pixel loop lives in a plain function over a chunk (it optimises as one tight loop); the chunks tick between them
    function chunk(from, to) {
      for (let i = from; i < to; i++) {
        const rawValue = data[i];
        if (hasThreshold && rawValue < threshold) pixels[i] = 0;
        else if ((types[i] & MAX_AREA) !== 0) pixels[i] = 255; // "prepare watershed by setting "true" maxima+surroundings to 255"
        else {
          const r = mround((rawValue - offset) * factor); // Math.round(double): floor(x + 0.5), as JS (NaN → 0 as Java's long cast)
          const v = 1 + (r !== r ? 0 : r);
          pixels[i] = v < 1 ? 1 : v <= 254 ? v : 254;
        }
      }
    }
    for (let from = 0; from < size; from += 0x100000) {
      if (from) await tick(ctl, from / size);
      chunk(from, Math.min(size, from + 0x100000));
    }
    return pixels;
  }

  /* cleanupMaxima: "eliminate unmarked maxima for use by watershed. Starting from each previous maximum, explore the
   * surrounding down to successively lower levels until a marked maximum is touched (or the plateau of a previously
   * eliminated maximum leads to a marked maximum). Then set all the points above this value to this value". */
  async function cleanupMaxima(pixels, types, maxOffs, pList, width, height, dirOffset, isWithin, ctl) {
    const nMax = maxOffs.length;
    for (let iMax = nMax - 1; iMax >= 0; iMax--) {
      if ((iMax & 1023) === 0) await tick(ctl, 1 - iMax / nMax);
      const offset0 = maxOffs[iMax];
      if ((types[offset0] & (MAX_AREA | ELIMINATED)) !== 0) continue;
      const level = pixels[offset0] & 255;
      let loLevel = level + 1;
      pList[0] = offset0; // "we start the list at the current maximum"
      types[offset0] |= LISTED;
      let listLen = 1;
      let lastLen = 1;
      let listI = 0;
      let saddleFound = false;
      while (!saddleFound && loLevel > 0) {
        loLevel--;
        lastLen = listLen; // "remember end of list for previous level"
        listI = 0; // "in each level, start analyzing the neighbors of all pixels"
        do { // "for all pixels listed so far"
          const offset = pList[listI];
          const y = (offset / width) | 0;
          const x = offset - y * width;
          const isInner = (y !== 0 && y !== height - 1) && (x !== 0 && x !== width - 1);
          for (let d = 0; d < 8; d++) {
            const offset2 = offset + dirOffset[d];
            if ((isInner || isWithin(x, y, d)) && (types[offset2] & LISTED) === 0) {
              if ((types[offset2] & MAX_AREA) !== 0 || (((types[offset2] & ELIMINATED) !== 0) && (pixels[offset2] & 255) >= loLevel)) {
                saddleFound = true; // "we have reached a point touching a "true" maximum..." or "a level not lower, but touching a "true" maximum"
                break;
              } else if ((pixels[offset2] & 255) >= loLevel && (types[offset2] & ELIMINATED) === 0) {
                pList[listLen] = offset2;
                listLen++; // "we have found a new point to be processed"
                types[offset2] |= LISTED;
              }
            }
          }
          if (saddleFound) break; // "no reason to search any further"
          listI++;
        } while (listI < listLen);
      }
      for (listI = 0; listI < listLen; listI++) types[pList[listI]] &= ~LISTED; // "reset attribute since we may come to this place again"
      for (listI = 0; listI < lastLen; listI++) { // "for all points higher than the level of the saddle point"
        const offset = pList[listI];
        pixels[offset] = loLevel; // "set pixel value to the level of the saddle point"
        types[offset] |= ELIMINATED; // "mark as processed: there can't be a local maximum in this area"
      }
    }
  }

  /* makeFateTable: "Creates the lookup table used by the watershed function for dilating the particles." */
  function makeFateTable() {
    const table = new Int32Array(256);
    const isSet = new Array(8);
    for (let item = 0; item < 256; item++) { // "dissect into pixels"
      for (let i = 0, mask = 1; i < 8; i++) { isSet[i] = (item & mask) === mask; mask *= 2; }
      for (let i = 0, mask = 1; i < 8; i++) { // "we dilate in the direction opposite to the direction of the existing neighbors"
        if (isSet[(i + 4) % 8]) table[item] |= mask;
        mask *= 2;
      }
      for (let i = 0; i < 8; i += 2) { // "if side pixels are set, for counting transitions it is as good as if the adjacent edges were also set"
        if (isSet[i]) { isSet[(i + 1) % 8] = true; isSet[(i + 7) % 8] = true; }
      }
      let transitions = 0;
      for (let i = 0; i < 8; i++) if (isSet[i] !== isSet[(i + 1) % 8]) transitions++;
      if (transitions >= 4) table[item] = 0; // "if neighbors contain more than one region, dilation ito this pixel is forbidden"
    }
    return table;
  }

  /* watershedSegment: "Do watershed segmentation on a byte image, with the start points (maxima) set to 255 and the
   * background set to 0. ... On output, all particles will be set to 255, segmentation lines remain at their old value."
   *
   * Same result as ImageJ's loop (processLevel called once per direction pass, each pass scanning every pixel of the level
   * that is still unset), but event driven. A pixel of the level changes in a pass iff fateTable[index] has the bit of the
   * pass's direction, where `index` is its 8-neighbour occupation (neighbour === 255). Within a pass the changes are all
   * decided on the pixels as they were before the pass (they are written afterwards), so a pass is a pure function of
   * (index, direction) and the order of the list is irrelevant. We therefore keep `index` per pending pixel (`nb`), update
   * it only when a neighbour turns 255 (at most 8 updates per pixel set), and keep one candidate list per direction bit: a
   * pixel is pushed to the list of every bit its fate mask gains. A pass takes its list, drops entries that are no longer
   * pending or no longer carry the bit, and sets the rest — exactly the set ImageJ's full scan finds, and the same count n,
   * so the idle/remaining control flow below is ImageJ's, verbatim. The cost falls from (passes × level size) to
   * (level size + 8 × pixels set). `scratch` (≥ 2·size bytes, free after cleanupMaxima) holds the per-pixel state word `ps` (see below). */
  const BIT_INDEX = Uint8Array.from({ length: 129 }, (_, v) => (v === 2 ? 1 : v === 4 ? 2 : v === 8 ? 3 : v === 16 ? 4 : v === 32 ? 5 : v === 64 ? 6 : v === 128 ? 7 : 0)); // index of a single set bit
  const BIT_OF_OPPOSITE = [16, 32, 64, 128, 1, 2, 4, 8]; // the bit a pixel set in direction d is for the neighbour (index bit (d+4)%8)
  async function watershedSegment(pixels, width, height, intEncodeXMask, intEncodeShift, dirOffset, isWithin, ctl, scratch) {
    const size = width * height;
    // "Create an array with the coordinates of all points between value 1 and 254"
    const histogram = new Int32Array(256);
    for (let i = 0; i < size; i++) histogram[pixels[i]]++;
    const arraySize = size - histogram[0] - histogram[255];
    const coordinates = new Int32Array(arraySize); // "from pixel coordinates, low bits x, high bits y"
    let highestValue = 0;
    let maxBinSize = 0;
    let offset = 0;
    const levelStart = new Int32Array(256);
    for (let v = 1; v < 255; v++) {
      levelStart[v] = offset;
      offset += histogram[v];
      if (histogram[v] > 0) highestValue = v;
      if (histogram[v] > maxBinSize) maxBinSize = histogram[v];
    }
    const levelOffset = new Int32Array(highestValue + 1);
    for (let y = 0, i = 0; y < height; y++) {
      for (let x = 0; x < width; x++, i++) {
        const v = pixels[i];
        if (v > 0 && v < 255) {
          offset = levelStart[v] + levelOffset[v];
          coordinates[offset] = x | (y << intEncodeShift);
          levelOffset[v]++;
        }
      }
    }
    // One 16-bit word per pixel (one cache line per neighbour touched): bits 0-7 = the neighbourhood index of a pending pixel
    // (event mode), bits 8-9 = 1 pending in the level / 2 taken by the running pass, bit 10 = the pixel is on the image border.
    const ps = new Uint16Array(scratch.buffer, scratch.byteOffset, size);
    ps.fill(0);
    const fate = Uint8Array.from(makeFateTable()); // "prevent features from merging"
    const table = makeFateTable();
    const ADD_BITS = new Uint8Array(8 * 256); // [d][old index] -> direction bits gained when the neighbour in direction d turns 255
    for (let d = 0; d < 8; d++) for (let old = 0; old < 256; old++) ADD_BITS[(d << 8) | old] = fate[old ^ BIT_OF_OPPOSITE[d]] & ~fate[old];
    const directionSequence = [7, 3, 1, 5, 0, 4, 2, 6]; // "diagonal directions first"
    const xmax = width - 1, ymax = height - 1;
    const yMask = ~intEncodeXMask;
    // ImageJ's own list of the pixels set in one pass (min(maxBinSize, (w*h+2)/3) ints; a level that took the border
    // points of the one above can need more, so processLevel grows it).
    const holder = { list: new Int32Array(Math.max(1, Math.min(maxBinSize, Math.floor((size + 2) / 3)))) };
    if (ctl && ctl.reserve) ctl.reserve(4 * holder.list.length);
    // Event mode memory: the direction lists and `changed` together never exceed 2 * LIST_CAP ints (about 1.33 B per
    // pixel, what ImageJ's list of set pixels costs); a list that would grow past it abandons event mode for the rest of
    // the level (the scan pass has no such lists). Every growth is reserved before it is allocated.
    const LIST_CAP = Math.floor(size / 6) + 4096;
    const bkA = []; const bkN = new Int32Array(8); // candidate lists per direction bit
    let capTotal = 0;
    let overflow = false;
    for (let b = 0; b < 8; b++) bkA.push(null);
    let changed = null;
    function push(b, o) {
      let a = bkA[b];
      const n = bkN[b];
      if (a === null || n === a.length) {
        const cap = a === null ? 1024 : n * 2;
        if (capTotal + cap - (a === null ? 0 : n) > LIST_CAP) { overflow = true; return; }
        if (ctl && ctl.reserve) ctl.reserve(4 * cap);
        const g = new Int32Array(cap);
        if (a !== null) { g.set(a); capTotal -= a.length; }
        capTotal += cap;
        bkA[b] = a = g;
      }
      a[n] = o; bkN[b] = n + 1;
    }
    let work = 0;

    // one pass in direction `pass` (event mode): returns the number of pixels set (processLevel's return value)
    function runPass(pass) {
      const bit = 1 << pass;
      const A = bkA[pass], len = bkN[pass];
      if (len === 0) return 0;
      if (changed === null || changed.length < len) {
        const cap = Math.max(len, changed === null ? 1024 : Math.min(changed.length * 2, LIST_CAP));
        if (ctl && ctl.reserve) ctl.reserve(4 * cap);
        changed = new Int32Array(cap);
      }
      let nCh = 0;
      for (let j = 0; j < len; j++) {
        const o = A[j];
        const st = ps[o];
        if ((st & 0x300) === 0x100 && (fate[st & 255] & bit) !== 0) { ps[o] = st + 0x100; changed[nCh++] = o; } // keeps the border flag
      }
      bkN[pass] = 0;
      for (let j = 0; j < nCh; j++) { // "set pixels to 255", then tell the neighbours
        const o = changed[j];
        pixels[o] = 255;
        const edge = (ps[o] & 0x400) !== 0;
        ps[o] = 0;
        if (overflow) continue; // event mode is being abandoned: only the pixels themselves matter now
        let x = 0, y = 0;
        if (edge) { y = (o / width) | 0; x = o - y * width; }
        for (let d = 0; d < 8; d++) {
          if (!edge || isWithin(x, y, d)) {
            const n = o + dirOffset[d];
            const v = ps[n];
            if ((v & 0x300) === 0x100) {
              const old = v & 255;
              ps[n] = v ^ BIT_OF_OPPOSITE[d];
              // the direction bits the neighbour gains: fate[old ^ bit] & ~fate[old]
              let add = ADD_BITS[(d << 8) | old];
              while (add !== 0) { const low = add & -add; push(BIT_INDEX[low], n); add ^= low; }
            }
          }
        }
      }
      work += nCh + len;
      return nCh;
    }

    // Switch a level to event mode: `nPts` unprocessed points sit at coordinates[start ...], in ImageJ's order. false (and
    // nothing changed) when the lists would outgrow LIST_CAP.
    async function enterEvent(start, nPts) {
      for (let b = 0; b < 8; b++) bkN[b] = 0;
      overflow = false;
      for (let i = 0; i < nPts && !overflow; i++) { // occupation index of every point
        const xy = coordinates[start + i];
        const x = xy & intEncodeXMask;
        const y = (xy & yMask) >> intEncodeShift;
        const o = x + y * width;
        let index = 0;
        if (x > 0 && x < xmax && y > 0 && y < ymax) {
          if (pixels[o - width] === 255) index ^= 1;
          if (pixels[o - width + 1] === 255) index ^= 2;
          if (pixels[o + 1] === 255) index ^= 4;
          if (pixels[o + width + 1] === 255) index ^= 8;
          if (pixels[o + width] === 255) index ^= 16;
          if (pixels[o + width - 1] === 255) index ^= 32;
          if (pixels[o - 1] === 255) index ^= 64;
          if (pixels[o - width - 1] === 255) index ^= 128;
        } else {
          if (y > 0 && pixels[o - width] === 255) index ^= 1;
          if (x < xmax && y > 0 && pixels[o - width + 1] === 255) index ^= 2;
          if (x < xmax && pixels[o + 1] === 255) index ^= 4;
          if (x < xmax && y < ymax && pixels[o + width + 1] === 255) index ^= 8;
          if (y < ymax && pixels[o + width] === 255) index ^= 16;
          if (x > 0 && y < ymax && pixels[o + width - 1] === 255) index ^= 32;
          if (x > 0 && pixels[o - 1] === 255) index ^= 64;
          if (x > 0 && y > 0 && pixels[o - width - 1] === 255) index ^= 128;
        }
        ps[o] = index | ((x > 0 && x < xmax && y > 0 && y < ymax) ? 0x100 : 0x500); // 0x400 = on the image border (neighbour tests need isWithin)
        const m = fate[index];
        if (m !== 0) for (let b = 0; b < 8; b++) if ((m >> b) & 1) push(b, o);
        if ((i & 0x3ffff) === 0x3ffff && ctl) await ctl.check();
      }
      if (overflow) {
        overflow = false;
        for (let i = 0; i < nPts; i++) { const xy = coordinates[start + i]; ps[(xy & intEncodeXMask) + ((xy & yMask) >> intEncodeShift) * width] = 0; }
        return false;
      }
      return true;
    }
    // Leave event mode: compact the entry list to the points still pending, in order (what processLevel leaves).
    function leaveEvent(start, evLen) {
      let k = 0;
      for (let i = 0; i < evLen; i++) {
        const xy = coordinates[start + i];
        const o = (xy & intEncodeXMask) + ((xy & yMask) >> intEncodeShift) * width;
        if ((ps[o] & 0x300) === 0x100) { coordinates[start + k++] = xy; ps[o] = 0; }
      }
      overflow = false;
    }

    // ImageJ's scan pass costs the size of the level's unprocessed list per pass; the event mode costs one setup scan plus
    // at most 8 neighbour updates per pixel set. A level that settles in a few passes (the rings of a Voronoi) is cheaper
    // by scan, one that needs many (a checkerboard of maxima) by events: scan first, switch after SCAN_PASSES passes (measured: 4 keeps a Voronoi ring level on the scan, 2 loses it).
    // Both give the same pixels, so the mode may change between any two passes.
    const SCAN_PASSES = 4;
    const EVENT_MIN_POINTS = 2048;
    for (let level = highestValue; level >= 1; level--) {
      const start = levelStart[level];
      const count = histogram[level];
      let remaining = count; // "number of points in the level that have not been processed"
      let evMode = false, noEvent = false, passes = 0, evLen = 0;
      let idle = 0;
      while (remaining > 0 && idle < 8) {
        let dIndex = 0;
        do { // "expand each level in 8 directions"
          let n;
          if (evMode) {
            n = runPass(directionSequence[dIndex % 8]);
            if (overflow) { leaveEvent(start, evLen); evMode = false; noEvent = true; }
          } else {
            work += remaining;
            n = processLevel(directionSequence[dIndex % 8], pixels, width, height, table, start, remaining, coordinates, holder, intEncodeXMask, intEncodeShift);
            passes++;
          }
          remaining -= n; // "number of points processed"
          if (n > 0) idle = 0; // "nothing processed in this direction?"
          dIndex++;
          if (!evMode && !noEvent && passes >= SCAN_PASSES && remaining >= EVENT_MIN_POINTS) {
            if (await enterEvent(start, remaining)) { evMode = true; evLen = remaining; } else noEvent = true;
          }
          if (work > 0x40000 && ctl) { work = 0; await ctl.tick((highestValue - level + (count > 0 ? 1 - remaining / count : 1)) / (highestValue + 1)); }
        } while (remaining > 0 && idle++ < 8); // Java `idle++<8`: post-increment, as written
      }
      if (evMode && remaining > 0) leaveEvent(start, evLen); // the unreached points, in their order, where ImageJ's compaction leaves them
      if (ctl) await ctl.tick((highestValue - level + 1) / (highestValue + 1));
      if (remaining > 0 && level > 1) { // "any pixels that we have not reached?"
        let nextLevel = level; // "find the next level to process"
        do nextLevel--; while (nextLevel > 1 && histogram[nextLevel] === 0);
        /* "in principle we should add all unprocessed pixels of this level to the tasklist of the next level. This would
         * make it very slow for some images, however. Thus we only add the pixels if they are at the border (of the image
         * or a thresholded area) and correct unprocessed pixels at the very end by CleanupExtraLines" */
        if (nextLevel > 0) {
          let newNextLevelEnd = levelStart[nextLevel] + histogram[nextLevel];
          for (let i = 0, p = start; i < remaining; i++, p++) {
            const xy = coordinates[p];
            const x = xy & intEncodeXMask;
            const y = (xy & yMask) >> intEncodeShift;
            const pOffset = x + y * width;
            let addToNext = false;
            if (x === 0 || y === 0 || x === width - 1 || y === height - 1) addToNext = true; // "image border"
            else {
              for (let d = 0; d < 8; d++) {
                if (isWithin(x, y, d) && pixels[pOffset + dirOffset[d]] === 0) { addToNext = true; break; } // "border of area below threshold"
              }
            }
            if (addToNext) coordinates[newNextLevelEnd++] = xy;
          }
          // "tasklist for the next level to process becomes longer by this:"
          histogram[nextLevel] = newNextLevelEnd - levelStart[nextLevel];
        }
      }
    }
    return true;
  }

  /* processLevel: "dilate the UEP on one level by one pixel in the direction specified by step, i.e., set pixels to 255". */
  function processLevel(pass, pixels, width, height, fateTable, levelStart, levelNPoints, coordinates, holder, xMask, shift) {
    const xmax = width - 1;
    const ymax = height - 1;
    let nChanged = 0;
    let nUnchanged = 0;
    let setPointList = holder.list;
    const yMask = ~xMask;
    const bit = 1 << pass;
    for (let i = 0, p = levelStart; i < levelNPoints; i++, p++) {
      const xy = coordinates[p];
      const x = xy & xMask;
      const y = (xy & yMask) >> shift;
      const offset = x + y * width;
      let index = 0; // "neighborhood pixel ocupation: index in fateTable"
      if (x > 0 && x < xmax && y > 0 && y < ymax) { // inside the image all eight neighbours exist
        if (pixels[offset - width] === 255) index ^= 1;
        if (pixels[offset - width + 1] === 255) index ^= 2;
        if (pixels[offset + 1] === 255) index ^= 4;
        if (pixels[offset + width + 1] === 255) index ^= 8;
        if (pixels[offset + width] === 255) index ^= 16;
        if (pixels[offset + width - 1] === 255) index ^= 32;
        if (pixels[offset - 1] === 255) index ^= 64;
        if (pixels[offset - width - 1] === 255) index ^= 128;
      } else {
        if (y > 0 && pixels[offset - width] === 255) index ^= 1;
        if (x < xmax && y > 0 && pixels[offset - width + 1] === 255) index ^= 2;
        if (x < xmax && pixels[offset + 1] === 255) index ^= 4;
        if (x < xmax && y < ymax && pixels[offset + width + 1] === 255) index ^= 8;
        if (y < ymax && pixels[offset + width] === 255) index ^= 16;
        if (x > 0 && y < ymax && pixels[offset + width - 1] === 255) index ^= 32;
        if (x > 0 && pixels[offset - 1] === 255) index ^= 64;
        if (x > 0 && y > 0 && pixels[offset - width - 1] === 255) index ^= 128;
      }
      if ((fateTable[index] & bit) === bit) {
        if (nChanged === setPointList.length) { const g = new Int32Array(setPointList.length * 2); g.set(setPointList); setPointList = holder.list = g; }
        setPointList[nChanged++] = offset; // "remember to set pixel to 255"
      } else coordinates[levelStart + (nUnchanged++)] = xy; // "keep this pixel for future passes"
    }
    for (let i = 0; i < nChanged; i++) pixels[setPointList[i]] = 255;
    return nChanged;
  }

  /* cleanupExtraLines: "Delete extra structures form watershed of non-EDM images, e.g., foreground patches, single dots
   * and lines ending somewhere within a segmented particle". */
  async function cleanupExtraLines(pixels, width, height, dirOffset, isWithin, ctl) {
    for (let y = 0, i = 0; y < height; y++) {
      if ((y & 63) === 0) await tick(ctl, y / height);
      for (let x = 0; x < width; x++, i++) {
        const v = pixels[i];
        if (v !== 255 && v !== 0) {
          const nRadii = nRadiiAt(pixels, x, y, width, height, dirOffset, isWithin); // "number of lines radiating"
          if (nRadii === 0) pixels[i] = 255; // "single point or foreground patch?"
          else if (nRadii === 1) removeLineFrom(pixels, x, y, width, height, dirOffset, isWithin);
        }
      }
    }
  }

  /* removeLineFrom: "delete a line starting at x, y up to the next (4-connected) vertex". */
  function removeLineFrom(pixels, x, y, width, height, dirOffset, isWithin) {
    pixels[x + width * y] = 255; // "delete the first point"
    let continues;
    do {
      continues = false;
      const isInner = (y !== 0 && y !== height - 1) && (x !== 0 && x !== width - 1);
      for (let d = 0; d < 8; d += 2) { // "analyze 4-connected neighbors"
        if (isInner || isWithin(x, y, d)) {
          const v = pixels[x + width * y + dirOffset[d]];
          if (v !== 255 && v !== 0) {
            const nRadii = nRadiiAt(pixels, x + DIR_X[d], y + DIR_Y[d], width, height, dirOffset, isWithin);
            if (nRadii <= 1) { // "found a point or line end"
              x += DIR_X[d];
              y += DIR_Y[d];
              pixels[x + width * y] = 255; // "delete the point"
              continues = nRadii === 1; // "continue along that line"
              break;
            }
          }
        }
      }
    } while (continues);
  }

  /* nRadii: "Analyze the neighbors of a pixel (x, y) in a byte image; pixels <255 ("non-white") are considered foreground.
   * Edge pixels are considered foreground. Returns the number of 4-connected lines emanating from this point." */
  function nRadiiAt(pixels, x, y, width, height, dirOffset, isWithin) {
    const offset = x + y * width;
    let countTransitions = 0;
    let prevPixelSet = true;
    let firstPixelSet = true;
    const isInner = (y !== 0 && y !== height - 1) && (x !== 0 && x !== width - 1);
    for (let d = 0; d < 8; d++) { // "walk around the point and note every no-line->line transition"
      let pixelSet = prevPixelSet;
      if (isInner || isWithin(x, y, d)) {
        const isSet = pixels[offset + dirOffset[d]] !== 255;
        if ((d & 1) === 0) pixelSet = isSet; // "non-diagonal directions: always regarded"
        else if (!isSet) pixelSet = false; // "diagonal directions may separate two lines, but are insufficient for a 4-connected line"
      } else pixelSet = true;
      if (pixelSet && !prevPixelSet) countTransitions++;
      prevPixelSet = pixelSet;
      if (d === 0) firstPixelSet = pixelSet;
    }
    if (firstPixelSet && !prevPixelSet) countTransitions++;
    return countTransitions;
  }

  /* deleteEdgeParticles: "delete particles corresponding to edge maxima" — walks the four borders, and for a border pixel
   * that is in a maximum area (MAX_AREA) and not 0 traces its particle with ij.gui.Wand and fills the outline with 0. */
  function deleteEdgeParticles(pixels, types, width, height) {
    for (let x = 0; x < width; x++) {
      let y = 0;
      if ((types[x + y * width] & MAX_AREA) !== 0 && pixels[x + y * width] !== 0) deleteParticle(x, y, pixels, width, height);
      y = height - 1;
      if ((types[x + y * width] & MAX_AREA) !== 0 && pixels[x + y * width] !== 0) deleteParticle(x, y, pixels, width, height);
    }
    for (let y = 1; y < height - 1; y++) {
      let x = 0;
      if ((types[x + y * width] & MAX_AREA) !== 0 && pixels[x + y * width] !== 0) deleteParticle(x, y, pixels, width, height);
      x = width - 1;
      if ((types[x + y * width] & MAX_AREA) !== 0 && pixels[x + y * width] !== 0) deleteParticle(x, y, pixels, width, height);
    }
  }

  /* deleteParticle: `wand.autoOutline(x, y, 255, 255)` — the int overload, i.e. THRESHOLDED_MODE|LEGACY_MODE: the outline
   * of the first border met going right from (x, y), 8-connected, WITHOUT the test that it encloses the seed ("if (legacyMode)
   * return; // in legacy mode, don't care what we have got"). Then `new PolygonRoi(…, TRACED_ROI)`, `ip.fill()`,
   * `ip.reset(ip.getMask())`: the pixels inside the traced polygon (pixel centres, even-odd) become 0. */
  function deleteParticle(sx, sy, pixels, width, height) {
    const inside = (x, y) => x >= 0 && x < width && y >= 0 && y < height && pixels[y * width + x] === 255;
    let x = sx;
    const y = sy;
    if (inside(x, y)) { do { x++; } while (inside(x, y)); } // "find a border when coming from inside"
    else { // "find a border when coming from outside (thresholded only)"
      do { x++; if (x >= width) return; } while (!inside(x, y));
    }
    const poly = traceEdge(x, y, inside);
    if (!poly.length) return;
    fillTraced(poly, pixels, width, height, 0);
  }

  /* Wand.traceEdge(startX, startY, fourConnected = false): "Trace the outline, starting at a point (startX, startY). Pixel
   * (startX-1, startY) must be outside, (startX, startY) must be inside, or reverse." Returns the vertices [x0, y0, x1, y1, …]. */
  function traceEdge(startX, startY, inside) {
    const xs = [], ys = [];
    const ins = (x, y, direction) => {
      switch (direction & 3) { // '& 3' is remainder modulo 4
        case 0: return inside(x, y);
        case 1: return inside(x, y - 1);
        case 2: return inside(x - 1, y - 1);
        case 3: return inside(x - 1, y);
      }
      return false;
    };
    let startDirection;
    if (inside(startX, startY)) startDirection = 1; // "inside at left, outside right: starting in direction 1 = up"
    else { startDirection = 3; startY++; } // "starting in direction 3 = down; continue after the boundary that has direction 3"
    let x = startX, y = startY, direction = startDirection;
    do {
      // 8-connected: "we always trying to turn left as much as possible"
      let newDirection = direction + 1;
      do {
        if (ins(x, y, newDirection)) break;
        newDirection--;
      } while (newDirection >= direction);
      if (newDirection !== direction) { xs.push(x); ys.push(y); } // "a corner point of the outline polygon: add to list"
      switch (newDirection & 3) { case 0: x++; break; case 1: y--; break; case 2: x--; break; case 3: y++; break; }
      direction = newDirection;
    } while (x !== startX || y !== startY || (direction & 3) !== startDirection);
    if (xs[0] !== x) { xs.push(x); ys.push(y); } // "if the start point = end point is a corner: add to list"
    const out = [];
    for (let i = 0; i < xs.length; i++) out.push(xs[i], ys[i]);
    return out;
  }

  // Even-odd fill of an integer polygon [x0, y0, …] at pixel centres (ImageJ's PolygonFiller for a traced outline).
  function fillTraced(poly, pixels, width, height, value) {
    const n = poly.length / 2;
    let y0 = Infinity, y1 = -Infinity;
    for (let i = 0; i < n; i++) { const y = poly[2 * i + 1]; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    y0 = Math.max(0, y0); y1 = Math.min(height, y1);
    for (let y = y0; y < y1; y++) {
      const yc = y + 0.5;
      const xsx = [];
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const ay = poly[2 * i + 1], by = poly[2 * j + 1];
        if (ay === by) continue;
        if ((ay <= yc && yc < by) || (by <= yc && yc < ay)) xsx.push(poly[2 * i]); // vertical edges only: integer outline
      }
      xsx.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xsx.length; k += 2) {
        const a = Math.max(0, xsx[k]), b = Math.min(width, xsx[k + 1]);
        for (let x = a; x < b; x++) pixels[y * width + x] = value;
      }
    }
  }

  // ───────────────────────────────────────────── EDM family ─────────────────────────────────────────────
  // ij.plugin.filter.EDM. `mask` holds 0 / 255; `bg255` = EDM.background255.

  const MAXFINDER_TOLERANCE = 0.5; // "reasonable values are 0.3 ... 0.8; segmentation is more aggressive with smaller values"

  // The transform is cooperative: it ticks (progress, and the cancel check of the engine) every ~0.5 M pixels, `ctl` being the
  // sub-range of the caller's progress it may use.
  function floatEdm(mask, w, h, backgroundValue, ctl) {
    return S.makeFloatEDMAsync(mask, w, h, { backgroundValue, edgesAreBackground: false, tick: ctl ? (f) => ctl.tick(f) : null, check: ctl && ctl.check ? () => ctl.check() : null });
  }

  /* EDM.run for processType EDM: "FloatProcessor floatEdm = makeFloatEDM(ip, backgroundValue, false)" with
   * "(background255 ? (byte)255 : 0)" as the background value. */
  async function edmFloat(mask, w, h, bg255, ctl) {
    const f = await floatEdm(mask, w, h, bg255 ? 255 : 0, ctl);
    await tick(ctl, 1);
    return f;
  }

  /* Ultimate eroded points: findMaxima(floatEdm, 0.5, NO_THRESHOLD, SINGLE_POINTS, false, true) then
   * resetMasked(floatEdm, maxIp, 0): the EDM value stays where the output has a point, 0 elsewhere. */
  async function uepFloat(mask, w, h, bg255, ctl) {
    const f = await floatEdm(mask, w, h, bg255 ? 255 : 0, sub(ctl, 0, 0.2));
    await tick(ctl, 0.2);
    const r = await findMaxima({ data: f, width: w, height: h }, { tolerance: MAXFINDER_TOLERANCE, strict: false, threshold: NO_THRESHOLD, outputType: SINGLE_POINTS, excludeOnEdges: false, isEDM: true }, sub(ctl, 0.2, 1));
    const m = r.out;
    for (let i = 0; i < f.length; i++) if (m[i] === 0) f[i] = 0;
    return f;
  }

  /* Watershed: maxIp = findMaxima(floatEdm, 0.5, NO_THRESHOLD, SEGMENTED, false, true); "if (background255) maxIp.invert();
   * ip.copyBits(maxIp, 0, 0, Blitter.COPY);". */
  async function watershedBinary(mask, w, h, bg255, ctl) {
    const f = await floatEdm(mask, w, h, bg255 ? 255 : 0, sub(ctl, 0, 0.1));
    await tick(ctl, 0.1);
    const r = await findMaxima({ data: f, width: w, height: h }, { tolerance: MAXFINDER_TOLERANCE, strict: false, threshold: NO_THRESHOLD, outputType: SEGMENTED, excludeOnEdges: false, isEDM: true }, sub(ctl, 0.1, 1));
    const out = r.out;
    if (bg255) for (let i = 0; i < out.length; i++) out[i] = 255 - out[i];
    return out;
  }

  /* Voronoi: "Voronoi needs EDM of the background": backgroundValue = background255 ? 0 : (byte)255; "Voronoi starts from
   * minima of EDM" (floatEdm.multiply(-1)); SEGMENTED, isEDM false; multiply(-1) again; resetMasked(floatEdm, maxIp, -1):
   * the value is cleared inside the segmented particles, so only the dividing lines keep their EDM value. */
  async function voronoiFloat(mask, w, h, bg255, ctl) {
    const f = await floatEdm(mask, w, h, bg255 ? 0 : 255, sub(ctl, 0, 0.1));
    await tick(ctl, 0.1);
    for (let i = 0; i < f.length; i++) f[i] = fr(f[i] * -1);
    const r = await findMaxima({ data: f, width: w, height: h }, { tolerance: MAXFINDER_TOLERANCE, strict: false, threshold: NO_THRESHOLD, outputType: SEGMENTED, excludeOnEdges: false, isEDM: false }, sub(ctl, 0.1, 1));
    const m = r.out;
    for (let i = 0; i < f.length; i++) { f[i] = fr(f[i] * -1); if (m[i] === 255) f[i] = 0; }
    return f;
  }

  /* ByteProcessor.setPixels(0, FloatProcessor): "value = fPixels[i] + 0.5f; if (value<0f) value = 0f; if (value>255f) value = 255f;
   * pixels[i] = (byte)value;" — the Overwrite output. */
  function overwriteBytes(f) {
    const out = new Uint8Array(f.length);
    for (let i = 0; i < f.length; i++) {
      let v = fr(f[i] + 0.5);
      if (v < 0) v = 0;
      if (v > 255) v = 255;
      out[i] = v;
    }
    return out;
  }
  /* EDM.run, BYTE output: `floatEdm.setMinAndMax(0., 255.); outIp = floatEdm.convertToByte(true);` →
   * FloatProcessor.create8BitImage: "value = pixels[i]-min2; if (value<0.0) value=0.0; ivalue = (int)(value*scale+0.5);
   * if (ivalue>maxValue) ivalue = maxValue;" with scale = 255.0/(max2-min2) = 1. */
  function scaledBytes(f) {
    const out = new Uint8Array(f.length);
    for (let i = 0; i < f.length; i++) {
      let value = f[i] - 0;
      if (value < 0) value = 0;
      let iv = mtrunc(value * 1 + 0.5);
      if (iv > 255 || iv !== iv) iv = value !== value ? 0 : 255;
      out[i] = iv;
    }
    return out;
  }
  /* EDM.run, SHORT output: `floatEdm.setMinAndMax(0., 65535.); outIp = floatEdm.convertToShort(true);` →
   * TypeConverter.convertFloatToShort: "value = (pixels32[i]-min)*scale; if (value<0.0) value = 0.0; if (value>65535.0)
   * value = 65535.0; pixels16[i] = (short)(value+0.5);" with scale = 65535.0/(max-min) = 1. */
  function scaledShorts(f) {
    const out = new Uint16Array(f.length);
    for (let i = 0; i < f.length; i++) {
      let value = (f[i] - 0) * 1;
      if (value < 0) value = 0;
      if (value > 65535) value = 65535;
      out[i] = value + 0.5;
    }
    return out;
  }

  // ───────────────────────────────────────────── Skeletonize ─────────────────────────────────────────────
  // ij.process.BinaryProcessor.skeletonize(foreground): the two lookup tables of the source, verbatim.
  const SKEL_TABLE = Int32Array.from([
    0, 0, 0, 0, 0, 0, 1, 3, 0, 0, 3, 1, 1, 0, 1, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0, 3, 0, 3, 3,
    0, 0, 0, 0, 0, 0, 0, 0, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 3, 0, 2, 2,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    2, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 2, 0, 0, 0, 3, 0, 0, 0, 0, 0, 0, 0, 3, 0, 0, 0, 3, 0, 2, 0,
    0, 0, 3, 1, 0, 0, 1, 3, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1,
    3, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    2, 3, 1, 3, 0, 0, 1, 3, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    2, 3, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 3, 3, 0, 1, 0, 0, 0, 0, 2, 2, 0, 0, 2, 0, 0, 0]);
  // "use a second table to remove "stuck" pixels"
  const SKEL_TABLE2 = Int32Array.from([
    0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0, 2, 2, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);

  /* BinaryProcessor.thin(pass, table) of ImageJ: every sub-pass decides each interior foreground pixel from the image AS IT WAS
   * (`getPixelsCopy()`), then writes. An even pass removes the pixels whose table code is 1 or 3, an odd one 2 or 3.
   * `bgColor = foreground==255?0:-1` (a signed byte: -1 is 255). A pixel's code is a function of its 8 neighbours alone.
   *
   * Event-driven form (same result, cost O(frontier) instead of O(image) per sub-pass). Let S_k be the image before sub-pass k,
   * N_k(p) the 8-neighbourhood of p in S_k and d(N, parity) the table decision. A foreground pixel p that is not removed at
   * sub-pass k-2 and has N_k(p) = N_{k-2}(p) is not removed at sub-pass k either: k and k-2 have the SAME parity, so
   * d(N_k, parity k) = d(N_{k-2}, parity k-2) = "keep". N_k(p) differs from N_{k-2}(p) only if a pixel next to p was removed
   * by sub-pass k-2 or k-1 (the only writes are removals, so S_k = S_{k-2} minus R_{k-2} minus R_{k-1}). So the pixels to
   * evaluate at sub-pass k are exactly the foreground pixels in A_{k-2} u A_{k-1}, A_j = the pixels 8-adjacent to R_j; the
   * first two sub-passes with a table (nothing is known about k-2, k-1) evaluate every foreground pixel. Because the decisions
   * are read from the unmodified image, the removals are collected first and applied after: no snapshot copy either.
   * Removed counts, and therefore the number of passes of the two loops, are those of the full scan.
   * Marks (bits of the working image beside the foreground bit 1): value 4 de-duplicates A_j while it is built, value 2 marks the
   * candidates already decided in one sub-pass; both are cleared by walking the lists. Every walk over a list checks for
   * cancellation every 0x4000 entries (`report`), so no stretch of work lasts more than a few ms of a worker. */
  const grow = (list, need) => { if (need > list.buf.length) { const nb = new Int32Array(Math.max(need, Math.ceil(list.buf.length * 1.25), 1024)); nb.set(list.buf.subarray(0, list.n)); list.buf = nb; } };
  const newList = () => ({ buf: new Int32Array(1024), n: 0 });
  // The working image holds 1 for a foreground pixel, 0 for the background (bits 1 and 2 are the marks of the phase below), so a
  // pixel's marks live in the cache line its neighbours are read from.
  function skelCode(img, o, W) {
    return (img[o - W - 1] & 1) | ((img[o - W] & 1) << 1) | ((img[o - W + 1] & 1) << 2) | ((img[o + 1] & 1) << 3) |
      ((img[o + W + 1] & 1) << 4) | ((img[o + W] & 1) << 5) | ((img[o + W - 1] & 1) << 6) | ((img[o - 1] & 1) << 7);
  }

  /* One phase = one lookup table, run to convergence. `st` carries the working image, the mark array and the progress. */
  async function skeletonPhase(st, table, ctl) {
    const { cur, W, H, nbr } = st, mark = cur;
    const evens = new Uint8Array(256), odds = new Uint8Array(256); // pass parity -> does code `table[index]` remove the pixel
    for (let i = 0; i < 256; i++) { const c = table[i]; evens[i] = c === 1 || c === 3 ? 1 : 0; odds[i] = c === 2 || c === 3 ? 1 : 0; }
    const rem = newList(); // R_k, the removals of the sub-pass in progress
    let aNew = newList(), aOld = newList(); // A_{k-1}, A_{k-2}
    let full = 2, pixelsRemoved;
    const report = async () => { if (ctl) await ctl.tick(Math.min(0.99, st.removed / st.fgCount)); };
    do {
      pixelsRemoved = 0;
      for (let half = 0; half < 2; half++, st.pass++) {
        const remove = (st.pass & 1) === 1 ? odds : evens;
        rem.n = 0;
        if (full > 0) {
          full--;
          for (let y = 1; y <= H - 2; y++) {
            if ((y & 127) === 0) await report();
            let o = 1 + y * W;
            for (let x = 1; x <= W - 2; x++, o++) {
              if ((cur[o] & 1) === 0) continue;
              if (remove[skelCode(cur, o, W)] === 1) { grow(rem, rem.n + 1); rem.buf[rem.n++] = o; }
            }
          }
        } else {
          let steps = 0; // counted before any `continue`, so a run of skipped entries cannot starve the check
          for (let w2 = 0; w2 < 2; w2++) { // decide each candidate once (value 2), then clear the marks
            const b = w2 === 0 ? aNew.buf : aOld.buf, n = w2 === 0 ? aNew.n : aOld.n;
            for (let i = 0; i < n; i++) {
              if ((++steps & 0x3FFF) === 0) await report();
              const o = b[i];
              if ((cur[o] & 3) !== 1) continue; // removed since A_j was built, or already decided
              mark[o] |= 2;
              if (remove[skelCode(cur, o, W)] === 1) { grow(rem, rem.n + 1); rem.buf[rem.n++] = o; }
            }
          }
          for (let w2 = 0; w2 < 2; w2++) {
            const b = w2 === 0 ? aNew.buf : aOld.buf, n = w2 === 0 ? aNew.n : aOld.n;
            for (let i = 0; i < n; i++) { mark[b[i]] &= 5; if ((i & 0x3FFF) === 0x3FFF) await report(); }
          }
        }
        for (let i = 0, n = rem.n; i < n; i++) { cur[rem.buf[i]] = 0; if ((i & 0x3FFF) === 0x3FFF) await report(); } // apply after every decision was read
        pixelsRemoved += rem.n;
        st.removed += rem.n;
        // A_k: the foreground left next to this sub-pass's removals; it replaces A_{k-2}
        const t = aOld; aOld = aNew; aNew = t; aNew.n = 0;
        {
          const rb = rem.buf, rn = rem.n;
          let ab = aNew.buf, an = 0;
          for (let i = 0; i < rn; i++) {
            if ((i & 0x3FFF) === 0x3FFF) { aNew.n = an; await report(); }
            const o = rb[i];
            if (an + 8 > ab.length) { aNew.n = an; grow(aNew, an + 8); ab = aNew.buf; }
            for (let d = 0; d < 8; d++) {
              const q = o + nbr[d];
              if ((cur[q] & 5) === 1) { cur[q] |= 4; ab[an++] = q; }
            }
          }
          aNew.n = an;
        }
        for (let i = 0, n = aNew.n; i < n; i++) { mark[aNew.buf[i]] &= 3; if ((i & 0x3FFF) === 0x3FFF) await report(); }
      }
      await report();
    } while (pixelsRemoved > 0);
  }

  /* BinaryProcessor.skeletonize(foreground): "boolean edgePixels = hasEdgePixels(); BinaryProcessor ip2 = expand(edgePixels);
   * ip2.skeletonize2(foreground); shrink(ip2, edgePixels);"
   * Progress: the share of the foreground removed so far, which never goes back. It is a fair proxy of the work (the
   * frontier cost is about the sum of the |A_k|) but it ends below 1 by the share the skeleton keeps: near 0.9-0.99 on blobs
   * and cells, 0.2-0.7 on a noisy or thin mask, where the bar then jumps to done; the number of passes is not known in advance. */
  async function skeletonize(src, w, h, foreground, ctl) {
    let edge = false;
    for (let x = 0; x < w && !edge; x++) if (src[x] === foreground || src[(h - 1) * w + x] === foreground) edge = true;
    for (let y = 0; y < h && !edge; y++) if (src[y * w] === foreground || src[y * w + w - 1] === foreground) edge = true;
    let W = w, H = h, cur;
    if (edge) { // expand: "a new (width+2, height+2) processor, filled with 255 when foreground==0, the image inserted at (1,1)"
      W = w + 2; H = h + 2;
      cur = new Uint8Array(W * H);
      if (foreground === 0) cur.fill(255);
      for (let y = 0; y < h; y++) cur.set(src.subarray(y * w, y * w + w), (y + 1) * W + 1);
    } else cur = Uint8Array.from(src);
    const background = 255 - foreground;
    // skeletonize2: "setColor(background); moveTo(0,0); lineTo(0,height-1); moveTo(0,0); lineTo(width-1,0);
    //  moveTo(width-1,0); lineTo(width-1,height-1); moveTo(0,height-1); lineTo(width,height-1);"
    for (let x = 0; x < W; x++) { cur[x] = background; cur[(H - 1) * W + x] = background; }
    for (let y = 0; y < H; y++) { cur[y * W] = background; cur[y * W + W - 1] = background; }
    let fgCount = 0;
    for (let i = 0; i < cur.length; i++) { const f = cur[i] !== background ? 1 : 0; cur[i] = f; fgCount += f; } // any non-background value is foreground, as `!= bgColor` in thin()
    const st = {
      cur, W, H, pass: 0, removed: 0, fgCount: Math.max(1, fgCount),
      nbr: Int32Array.from([-W - 1, -W, -W + 1, 1, W + 1, W, W - 1, -1])
    };
    await skeletonPhase(st, SKEL_TABLE, ctl);
    await skeletonPhase(st, SKEL_TABLE2, ctl); // "use a second table to remove "stuck" pixels"
    for (let i = 0; i < cur.length; i++) cur[i] = (cur[i] & 1) === 1 ? foreground : background;
    if (!edge) return cur;
    const out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) out.set(cur.subarray((y + 1) * W + 1, (y + 1) * W + 1 + w), y * w);
    return out;
  }

  // ───────────────────────────────────────────── operations ─────────────────────────────────────────────

  const hasInverted = (view, c) => S.hasInvertedLut(view.channels[c] && view.channels[c].display);
  /* The LUT of a channel is display state, which is not journaled and is put back AFTER a replay: `resolve` copies it into the
   * params when the request is accepted (`params.invert[c]`, one boolean per channel) and `prepare` / `run` read only that.
   * A params object without it (an entry written before) falls back to the live display. */
  function validateInvert(p) {
    if (p && p.invert !== undefined && !(Array.isArray(p.invert) && p.invert.every((b) => typeof b === 'boolean'))) throw fail('IJ_BAD_ARGS', 'invert');
  }
  function resolveInvert(view, params) {
    if (params && Array.isArray(params.invert)) return params; // idempotent
    return Object.assign({}, params, { invert: view.channels.map((ch) => S.hasInvertedLut(ch.display)) });
  }
  const invertedOf = (view, c, params) => (params && Array.isArray(params.invert) && typeof params.invert[c] === 'boolean' ? params.invert[c] : hasInverted(view, c));

  /* EDM.setup: "if (!ip.isBinary()) { IJ.error("8-bit binary image (0 and 255) required."); return DONE; }" */
  function checkBinary(data) {
    for (let i = 0; i < data.length; i++) { const v = data[i]; if (v !== 0 && v !== 255) throw fail('IJ_SEG_NOT_BINARY', 'an 8-bit binary image (0 and 255) is required'); }
  }

  const px = (info) => info.width * info.height;
  const checkOverwrite = (p) => { if (p && p.output !== undefined && p.output !== 'overwrite') throw fail('IJ_BAD_ARGS', 'output'); };

  function defineBinaryOp(name, scratchPerPixel, make) {
    R.define(name, {
      kind: 'pixel', version: 1, stack: 'ask', rgb: false, bitDepths: [8], roi: 'ignore', preview: false,
      validate(params) { checkOverwrite(params); validateInvert(params); },
      resolve: resolveInvert,
      scratchBytes: (info) => px(info) * scratchPerPixel + 65536,
      prepare(view, c, params, ctx) {
        checkBinary(view.channels[c].data);
        const bg255 = invertedOf(view, c, params);
        const ctl = { tick: (f) => ctx.tick(f), check: ctx.check };
        return { whole: true, apron: { x: 0, y: 0 }, region: async (full) => make(full.data, full.width, full.height, bg255, ctl) };
      }
    });
  }
  // Bytes per pixel besides the new array and the undo patch the engine counts: EDM = the float map + the 8-bit result;
  // UEP = + the finder's types / pList / maxima; watershed = + the 8-bit segmentation and its work list; Voronoi: the
  // maxima of the negated EDM are ALL the object pixels (a plateau at 0), up to 16 bytes each.
  defineBinaryOp('edm', 5, async (mask, w, h, bg, ctl) => overwriteBytes(await edmFloat(mask, w, h, bg, ctl)));
  defineBinaryOp('ultimatePoints', 19, async (mask, w, h, bg, ctl) => overwriteBytes(await uepFloat(mask, w, h, bg, ctl)));
  defineBinaryOp('watershed', 21, (mask, w, h, bg, ctl) => watershedBinary(mask, w, h, bg, ctl));
  defineBinaryOp('voronoi', 29, async (mask, w, h, bg, ctl) => overwriteBytes(await voronoiFloat(mask, w, h, bg, ctl)));
  /* Binary.run: `else if (arg.startsWith("skel")) { ip.resetRoi(); skeletonize(ip); }` — the selection is dropped, and the
   * foreground follows the LUT (`int fg = Prefs.blackBackground?255:0; if (ip.isInvertedLut()) fg = 255-fg;`). */
  R.define('skeletonize', {
    kind: 'pixel', version: 1, stack: 'ask', rgb: false, bitDepths: [8], roi: 'ignore', preview: false,
    validate(params) { checkOverwrite(params); validateInvert(params); },
    resolve: resolveInvert,
    scratchBytes: (info) => px(info) * 12 + 65536, // working image (padded when an object touches the edge, its mark bits inline) + the removal / adjacent-pixel lists (three lists of 4 B entries, R, A_{k-1}, A_{k-2}; each keeps the largest capacity it ever reached, possibly in different sub-passes, grown by 1.25 with the old buffer alive while copying: at most about 1.25 * 4 * (max|R| + 2 * max|A|) = 15 B/px in theory, 4.5 B/px measured at worst)
    prepare(view, c, params, ctx) {
      checkBinary(view.channels[c].data);
      const fg = invertedOf(view, c, params) ? 0 : 255;
      const ctl = { tick: (f) => ctx.tick(f), check: ctx.check };
      return { whole: true, apron: { x: 0, y: 0 }, region: async (full) => skeletonize(full.data, full.width, full.height, fg, ctl) };
    }
  });

  /* Process > Binary > Outline = Binary.outline: "if (Prefs.blackBackground) ip.invert(); ((ByteProcessor)ip).outline(); ..." and
   * BinaryProcessor.process: "int bgColor = 255; if (parent.isInvertedLut()) bgColor = 0;" — the objects are the 255 pixels,
   * or the 0 pixels under an inverting LUT. The v1 outline (IJBinary.outline) works on 255 objects: for an inverting LUT the
   * same picture is inverted, outlined, inverted back. The LUT is copied into the params (`resolve`) like the other
   * operations of this file, so a replay does not depend on the display. */
  R.define('segOutline', {
    kind: 'pixel', version: 1, stack: 'ask', rgb: false, bitDepths: [8],
    validate: validateInvert,
    resolve: resolveInvert,
    scratchBytes: (info) => px(info) * 2 + 65536,
    prepare(view, c, params) {
      const B = root.IJBinary;
      if (!B) throw fail('IJ_MODULE_MISSING', 'IJBinary');
      const dark = invertedOf(view, c, params);
      return {
        apron: { x: 1, y: 1 },
        fn: (src) => {
          if (!dark) return B.outline({ data: src.data, width: src.width, height: src.height }, {});
          const inv = new Uint8Array(src.data.length);
          for (let i = 0; i < inv.length; i++) inv[i] = 255 - src.data[i];
          const o = B.outline({ data: inv, width: src.width, height: src.height }, {});
          for (let i = 0; i < o.data.length; i++) o.data[i] = 255 - o.data[i];
          return o;
        }
      };
    }
  });

  // ImagePlus.getShortTitle
  function shortTitle(name) {
    let title = String(name || '').trim();
    let index = title.lastIndexOf('.');
    if (index > 0) { title = title.substring(0, index); title = title.replace(/ /g, ''); }
    else { index = title.indexOf(' '); if (index > -1) title = title.substring(0, index); }
    return title;
  }
  const EDM_KINDS = { edm: 'EDM of ', ultimatePoints: 'UEPs of ', voronoi: 'Voronoi of ' }; // EDM.TITLE_PREFIX

  /* Process › Binary › Options › EDM output: BYTE / SHORT / FLOAT = a new image named TITLE_PREFIX + short title
   * (`outImp = new ImagePlus(TITLE_PREFIX[processType]+imp.getShortTitle(), outIp)`), display range reset
   * (`ip.resetMinAndMax()`), calibration of the source. */
  R.define('edmOutput', {
    kind: 'newdoc', version: 1, stack: 'each', rgb: false, bitDepths: [8], channels: 'one', roi: 'ignore', preview: false,
    validate(params) {
      if (!params || !Object.prototype.hasOwnProperty.call(EDM_KINDS, params.kind)) throw fail('IJ_BAD_ARGS', 'kind');
      if (!['byte', 'short', 'float'].includes(params.output)) throw fail('IJ_BAD_ARGS', 'output');
      validateInvert(params);
    },
    resolve: resolveInvert,
    scratchBytes: (info, params) => px(info) * ((params && params.kind === 'voronoi' ? 28 : params && params.kind === 'ultimatePoints' ? 18 : 4) + (params && params.output === 'byte' ? 1 : 4)) + 65536,
    async run(view, params, roi, io) {
      const c = Number.isInteger(io.channel) ? io.channel : (view.active || 0);
      if (!(c >= 0 && c < view.channels.length)) throw fail('IJ_BAD_ARGS', 'channel');
      const data = view.channels[c].data;
      checkBinary(data);
      const bg255 = invertedOf(view, c, params);
      const w = view.width, h = view.height;
      const ctl = { tick: (f) => io.tick(f, 'op.edmOutput'), check: () => io.check() };
      const make = params.kind === 'edm' ? edmFloat : params.kind === 'ultimatePoints' ? uepFloat : voronoiFloat;
      const f = await make(data, w, h, bg255, sub(ctl, 0, 0.95));
      let out, bitDepth;
      if (params.output === 'float') { out = f; bitDepth = 32; }
      else if (params.output === 'short') { out = scaledShorts(f); bitDepth = 16; }
      else { out = scaledBytes(f); bitDepth = 8; }
      io.check();
      const src = view.channels[c];
      return [{
        name: EDM_KINDS[params.kind] + shortTitle(view.name), width: w, height: h, bitDepth,
        calibration: view.calibration ? Object.assign({}, view.calibration) : view.calibration,
        channels: [{ name: src.name, color: '#ffffff', data: out }]
      }];
    }
  });

  /* Display range of a channel after an Overwrite: `ByteProcessor.setPixels(0, fp)` ends with
   * `setMinAndMax(fp.getMin(), fp.getMax())`, and EDM.run then does `if (floatEdm.getMax() > 255.) ip.resetMinAndMax();`
   * (8-bit: 0..255). The min / max here are those of the rounded 8-bit result, which the command reads once the run has
   * committed (the float map itself is gone by then). */
  R.define('segDisplayRange', {
    kind: 'compute', version: 1, stack: 'plane', rgb: 'gray', channels: 'one', bitDepths: [8], preview: false,
    scratchBytes: () => 4096,
    async run(view, params, roi, io) {
      const c = Number.isInteger(io.channel) ? io.channel : (view.active || 0);
      if (!(c >= 0 && c < view.channels.length)) throw fail('IJ_BAD_ARGS', 'channel');
      const d = view.channels[c].data;
      let min = 255, max = 0;
      for (let i = 0; i < d.length; i++) { const v = d[i]; if (v < min) min = v; if (v > max) max = v; }
      if (!d.length || max >= 255) return { min: 0, max: 255 };
      return { min, max };
    }
  });

  // ── Find Maxima

  /* MaximumFinder.run: "if ((invertedLut&&!lightBackground) || (!invertedLut&&lightBackground)) { threshold = NO_THRESHOLD; ...
   * ip = ip.duplicate(); ... ip.invert();": the inverted copy. ByteProcessor.invert = 255 - v; ShortProcessor.invert (default
   * Prefs.fullRange16bitInversions = false): `resetMinAndMax(); process(INVERT)` with v2 = max2 - (v1 - min2) over the DATA range;
   * FloatProcessor.invert: v2 = max2 - (v1 - min2) in float. */
  function invertedCopy(data, bitDepth) {
    const n = data.length;
    if (bitDepth === 8) { const o = new Uint8Array(n); for (let i = 0; i < n; i++) o[i] = 255 - data[i]; return o; }
    let min = Infinity, max = -Infinity;
    for (let i = 0; i < n; i++) { const v = data[i]; if (v === v && v !== Infinity && v !== -Infinity) { if (v < min) min = v; if (v > max) max = v; } }
    if (min > max) { min = 0; max = 0; }
    if (bitDepth === 16) { const o = new Uint16Array(n); for (let i = 0; i < n; i++) o[i] = max - (data[i] - min); return o; }
    const o = new Float32Array(n);
    const mn = fr(min), mx = fr(max);
    for (let i = 0; i < n; i++) o[i] = fr(mx - fr(data[i] - mn));
    return o;
  }

  function validateMaxima(p) {
    if (!p || typeof p !== 'object') throw fail('IJ_BAD_ARGS', 'params');
    if (!(typeof p.prominence === 'number' && isFinite(p.prominence) && p.prominence >= 0)) throw fail('IJ_BAD_ARGS', 'prominence');
    for (const k of ['strict', 'excludeEdges', 'light']) if (p[k] !== undefined && typeof p[k] !== 'boolean') throw fail('IJ_BAD_ARGS', k);
    if (p.isEDM !== undefined && typeof p.isEDM !== 'boolean') throw fail('IJ_BAD_ARGS', 'isEDM');
    validateInvert(p);
    if (p.aboveLower !== undefined && p.aboveLower !== null && !(p.aboveLower && typeof p.aboveLower.lower === 'number' && isFinite(p.aboveLower.lower))) throw fail('IJ_BAD_ARGS', 'aboveLower');
  }
  /* MaximumFinder.run: "boolean isEDM = imp!=null && imp.getBitDepth()==32 && imp.getTitle().startsWith("EDM of ");" — the title
   * and the LUT belong to the moment the command is accepted, so both are copied into the params. */
  function resolveMaxima(view, params) {
    const p = resolveInvert(view, params);
    if (p.isEDM !== undefined) return p;
    return Object.assign({}, p, { isEDM: view.bitDepth === 32 && String(view.name == null ? '' : view.name).startsWith('EDM of ') });
  }
  const SAMPLE_BYTES = { 8: 1, 16: 2, 32: 4 };
  // 1 types + 4 pList + 8 for the maxima (16 B each: keys, offsets and the sort buffers; room for one maximum in two
  // pixels; a plateau reaches 16 B per pixel, which `findMaxima` reserves once it has counted them) + the inverted copy; the segmentation adds the 8-bit picture and the watershed work list.
  const maximaScratch = (info, params, segmented) => {
    let n = px(info);
    if (params && params.preview) n = Math.min(n, 4.5e6); // a preview works on the visible region only (≤ ~4 Mpx)
    return n * (1 + 4 + 8 + (segmented ? 1 + 4 + 1 : 1) + (params && params.light ? SAMPLE_BYTES[info.bitDepth] : 0)) + 65536;
  };

  /* The input of a Find Maxima run: the channel (inverted when finding minima), cropped to `region` when asked (the preview),
   * the ROI rectangle / mask / contains in that frame. null = nothing to do (the region misses the selection). */
  function maximaInput(view, c, params, roi, io, outputType) {
    const w = view.width, h = view.height;
    const ch = view.channels[c];
    const minima = S.lightBackgroundInvert(!!params.light, invertedOf(view, c, params));
    // "if (roi!=null && (!roi.isArea() || outputType==SEGMENTED)) { imp.deleteRoi(); roi = null; }"
    let box = null;
    if (roi && outputType !== SEGMENTED) box = io.roiMask(roi); // null for a non-area selection
    const region = io.region && Number.isFinite(io.region.x1) ? { x0: Math.max(0, io.region.x0), y0: Math.max(0, io.region.y0), x1: Math.min(w, io.region.x1), y1: Math.min(h, io.region.y1) } : null;
    let data = ch.data, W = w, H = h, ox = 0, oy = 0;
    if (region) {
      if (!(region.x1 > region.x0 && region.y1 > region.y0)) return null;
      W = region.x1 - region.x0; H = region.y1 - region.y0; ox = region.x0; oy = region.y0;
      const Ctor = data.constructor;
      const crop = new Ctor(W * H);
      for (let y = 0; y < H; y++) crop.set(data.subarray((y + oy) * w + ox, (y + oy) * w + ox + W), y * W);
      data = crop;
    }
    if (minima) data = invertedCopy(data, view.bitDepth);
    let rect = null, mask = null, contains = null;
    if (box) {
      let bx = box.x - ox, by = box.y - oy, bw = box.w, bh = box.h, bdata = box.data;
      if (region) { // intersect with the cropped frame
        const x0 = Math.max(0, bx), y0 = Math.max(0, by), x1 = Math.min(W, bx + bw), y1 = Math.min(H, by + bh);
        if (!(x1 > x0 && y1 > y0)) return null;
        const nd = new Uint8Array((x1 - x0) * (y1 - y0));
        for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) nd[(y - y0) * (x1 - x0) + (x - x0)] = bdata[(y - by) * bw + (x - bx)];
        bx = x0; by = y0; bw = x1 - x0; bh = y1 - y0; bdata = nd;
      }
      rect = { x: bx, y: by, w: bw, h: bh };
      if (roi.type !== 'rect') mask = bdata;
      // Roi.contains(x, y) of the selection: the selection's own pixel set
      contains = (x, y) => x >= bx && x < bx + bw && y >= by && y < by + bh && bdata[(y - by) * bw + (x - bx)] !== 0;
    }
    let threshold = NO_THRESHOLD;
    // "double threshold = useMinThreshold?ip.getMinThreshold():NO_THRESHOLD;" and for minima: "threshold = NO_THRESHOLD"
    if (params.aboveLower && !minima) threshold = params.aboveLower.lower;
    return { data, W, H, ox, oy, rect, mask, contains, threshold };
  }

  /* MaximumFinder.run → findMaxima(ip, tolerance, strictMode, threshold, outputType, excludeOnEdges, isEDM), isEDM from
   * `resolveMaxima` (a 32-bit image titled "EDM of …"). */
  async function runMaxima(view, params, roi, io, outputType) {
    const c = Number.isInteger(io.channel) ? io.channel : (view.active || 0);
    if (!(c >= 0 && c < view.channels.length)) throw fail('IJ_BAD_ARGS', 'channel');
    const inp = maximaInput(view, c, params, roi, io, outputType);
    if (!inp) return { c, W: 0, H: 0, ox: 0, oy: 0, r: { out: null, points: new Int32Array(0) } };
    const ctl = { tick: (f) => io.tick(f, 'op.findMaxima'), check: () => io.check(), reserve: (n) => io.reserve(n) };
    const r = await findMaxima({ data: inp.data, width: inp.W, height: inp.H }, {
      tolerance: params.prominence, strict: !!params.strict, threshold: inp.threshold, outputType,
      excludeOnEdges: !!params.excludeEdges, isEDM: params.isEDM === true, roi: inp.rect, mask: inp.mask, contains: inp.contains
    }, ctl);
    io.check();
    return { c, W: inp.W, H: inp.H, ox: inp.ox, oy: inp.oy, r };
  }

  R.define('findMaxima', {
    kind: 'compute', version: 1, stack: 'plane', rgb: 'gray', channels: 'one', preview: false,
    validate: (p) => validateMaxima(p),
    resolve: resolveMaxima,
    scratchBytes: (info, params) => maximaScratch(info, params, false),
    async run(view, params, roi, io) {
      const m = await runMaxima(view, params, roi, io, POINT_SELECTION);
      const pts = m.r.points || new Int32Array(0);
      if (m.ox || m.oy) for (let i = 0; i < pts.length; i += 2) { pts[i] += m.ox; pts[i + 1] += m.oy; }
      io.transfer(pts.buffer); // millions of maxima are moved, not copied
      // a preview works on the visible crop: its edges are not the image's, so its count is only a guide
      return { count: pts.length / 2, points: pts, approximate: m.W !== view.width || m.H !== view.height };
    }
  });

  const IMAGE_OUTPUTS = { single: SINGLE_POINTS, tolerance: IN_TOLERANCE, segmented: SEGMENTED };
  /* MaximumFinder.run: "if (outputType == SEGMENTED) resultName = " Segmented"; else resultName = " Maxima";" — a new 8-bit
   * image titled `<title> Segmented` / `<title> Maxima`, 255 on 0, the spatial calibration kept. */
  R.define('findMaximaImage', {
    kind: 'newdoc', version: 1, stack: 'plane', rgb: 'gray', channels: 'one', preview: false,
    resolve: resolveMaxima,
    validate(p) {
      validateMaxima(p);
      if (!Object.prototype.hasOwnProperty.call(IMAGE_OUTPUTS, p.output)) throw fail('IJ_BAD_ARGS', 'output');
    },
    scratchBytes: (info, params) => maximaScratch(info, params, params && params.output === 'segmented') + px(info),
    async run(view, params, roi, io) {
      const m = await runMaxima(view, params, roi, io, IMAGE_OUTPUTS[params.output]);
      const w = view.width, h = view.height;
      let out = new Uint8Array(w * h);
      if (m.r.out) {
        if (m.ox || m.oy || m.W !== w || m.H !== h) { for (let y = 0; y < m.H; y++) out.set(m.r.out.subarray(y * m.W, y * m.W + m.W), (y + m.oy) * w + m.ox); }
        else out = m.r.out;
      }
      const src = view.channels[m.c];
      return [{
        name: view.name + (params.output === 'segmented' ? ' Segmented' : ' Maxima'), width: w, height: h, bitDepth: 8,
        calibration: view.calibration ? Object.assign({}, view.calibration) : view.calibration,
        channels: [{ name: src.name, color: '#ffffff', data: out }]
      }];
    }
  });

  root.IJSeg = {
    NO_THRESHOLD, SINGLE_POINTS, IN_TOLERANCE, SEGMENTED, POINT_SELECTION, LIST, COUNT,
    findMaxima, edmFloat, uepFloat, voronoiFloat, watershedBinary, skeletonize, overwriteBytes, scaledBytes, scaledShorts,
    invertedCopy, shortTitle, sortingMargin
  };
})(typeof self !== 'undefined' ? self : globalThis);
