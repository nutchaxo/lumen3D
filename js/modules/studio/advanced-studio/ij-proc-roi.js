/* ij-proc-roi.js — package P6 (roi): Wand, Angle, Segmented line, Enlarge, Create Mask / Selection,
 * Convex Hull, Fit Ellipse, and the measurement maths behind Analyze > Measure.
 *
 * Classic script, page AND worker (ij-worker.js loads it in its own try/catch: a failure here disables the
 * package's commands, the engine falls back to its basic rows). Pure: no DOM, no engine globals. Attaches
 * `IJRoiTools` to `self` and registers six operations with IJOpRegistry (PLAN-wave2 §1; fitEllipse and convexHull are worker
 * compute operations of Edit > Selection added in the review round, so a mask-sized selection never blocks the page):
 *   wand            compute   trace the outline of the pixels around (x, y)            ij.gui.Wand.autoOutline
 *   enlargeRoi      compute   grow / shrink a selection by n pixels                    ij.plugin.RoiEnlarger.enlarge255
 *   createSelection compute   selection from a threshold / a binary mask               ij.plugin.filter.ThresholdToSelection
 *   fitEllipse      compute   Edit > Selection > Fit Ellipse                          ij.plugin.Selection.createEllipse
 *   convexHull      compute   Edit > Selection > Convex Hull                          ij.plugin.Selection.convexHull
 *   createMask      newdoc    8-bit mask (255 inside) of a selection or a threshold    ij.plugin.Selection.createMask
 *
 * Reference: ImageJ 1.54p (public domain). Every port cites `Class.method` and quotes the source lines that
 * settle a trap. Coordinates are ImageJ's: a vertex (x, y) is the top-left CORNER of pixel (x, y); a LINE /
 * ANGLE endpoint is a pixel-centre coordinate (integer = the centre of that pixel).
 *
 *   IJRoiTools.wandOutline(img, x, y, o) → [[x,y],…] | null
 *   IJRoiTools.roiVertices(roi) → { xs, ys }          Roi.getFloatPolygon("")  (no closing duplicate)
 *   IJRoiTools.convexHull(xs, ys) → { xs, ys }        FloatPolygon.getConvexHull (gift wrapping order)
 *   IJRoiTools.feretValues(roi, pw, ph, W, H) → { feret, angle, min, x, y } | null
 *   IJRoiTools.fitEllipse(mask, rect) → { major, minor, angle, theta, xCenter, yCenter }
 *   IJRoiTools.ellipsePolygon(x1, y1, x2, y2, aspect) → [[x,y]×72]
 *   IJRoiTools.perimeter(roi, pw, ph) → number         Roi.getLength() (calibrated)
 *   IJRoiTools.profile(img, roi) → Float64Array        ProfilePlot.getProfile (line, segmented line)
 *   IJRoiTools.measureArea / measureLine / measurePoints / measureAngle → result rows (short keys)
 *   IJRoiTools.enlarge(roi, n, W, H) → roi             RoiEnlarger.enlarge255
 */
(function (root) {
  'use strict';

  const IJRoi = root.IJRoi, IJOps = root.IJOps, IJShared = root.IJShared, IJOpRegistry = root.IJOpRegistry;
  if (!IJRoi || !IJOps || !IJShared || !IJOpRegistry) throw Object.assign(new Error('ij-proc-roi needs ij-core and ij-proc-shared'), { code: 'IJ_MODULE_MISSING' });

  const fr = Math.fround;
  const jround = (v) => Math.floor(v + 0.5);          // java.lang.Math.round(double)
  const jint = (v) => (v < 0 ? Math.ceil(v) : Math.floor(v)); // (int) cast
  function fail(code, msg) { const e = new Error(msg || code); e.code = code; return e; }
  function finite(v) { return typeof v === 'number' && isFinite(v); }
  const MAX_VERTS = IJRoi.MAX_VERTS;

  // ================================================================================================
  // Wand — ij.gui.Wand
  // ================================================================================================

  /** java.awt.Polygon.contains(double x, double y) with int vertices (even-odd, half-open). */
  function polygonContains(xs, ys, x, y) {
    const n = xs.length;
    if (n <= 2) return false;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < n; i++) { if (xs[i] < minX) minX = xs[i]; if (xs[i] > maxX) maxX = xs[i]; if (ys[i] < minY) minY = ys[i]; if (ys[i] > maxY) maxY = ys[i]; }
    if (!(x >= minX && y >= minY && x < maxX && y < maxY)) return false; // Rectangle2D.contains: right / bottom exclusive
    let hits = 0;
    let lastx = xs[n - 1], lasty = ys[n - 1], curx, cury;
    for (let i = 0; i < n; lastx = curx, lasty = cury, i++) {
      curx = xs[i]; cury = ys[i];
      if (cury === lasty) continue;
      let leftx;
      if (curx < lastx) { if (x >= lastx) continue; leftx = curx; } else { if (x >= curx) continue; leftx = lastx; }
      let test1, test2;
      if (cury < lasty) {
        if (y < cury || y >= lasty) continue;
        if (x < leftx) { hits++; continue; }
        test1 = x - curx; test2 = y - cury;
      } else {
        if (y < lasty || y >= cury) continue;
        if (x < leftx) { hits++; continue; }
        test1 = x - lastx; test2 = y - lasty;
      }
      if (test1 < (test2 / (lasty - cury) * (lastx - curx))) hits++;
    }
    return (hits & 1) !== 0;
  }

  /* Wand.autoOutline(startX, startY, tolerance, mode) — the non-legacy path (4- or 8-connected), and the
   * thresholded form autoOutline(startX, startY, lower, upper, mode) when o.lower / o.upper are given.
   *   "lowerThreshold = (float)(startValue - tolerance); upperThreshold = (float)(startValue + tolerance);"
   *   "if (inside(x,y)) {   seedX = x; do {x++;} while (inside(x,y)); } else { do { x++; if (x>=width) return; }
   *    while (!inside(x,y)); seedX = x; }"   — a click on the background walks right to the first object
   * and traces it. A tolerance-0 click on a float NaN returns nothing: "if (fpixels!=null &&
   * Float.isNaN(getPixel(startX, startY))) return;". The outline is a single boundary: holes stay inside.
   * img = { data, width, height }. Returns the vertices in ImageJ's order (clockwise around inside pixels) or null. */
  function wandOutline(img, startX, startY, o) {
    const W = img.width, H = img.height, d = img.data;
    if (!(Number.isInteger(startX) && Number.isInteger(startY)) || startX < 0 || startX >= W || startY < 0 || startY >= H) return null;
    const f32 = d instanceof Float32Array;
    if (f32 && d[startY * W + startX] !== d[startY * W + startX]) return null;
    const four = o.mode === 4;
    let lower, upper;
    if (o.lower !== undefined && o.upper !== undefined) { lower = fr(o.lower); upper = fr(o.upper); } else {
      const tol = o.tolerance || 0, sv = d[startY * W + startX];
      lower = fr(sv - tol); upper = fr(sv + tol);
    }
    const inside = (x, y) => {
      if (x < 0 || x >= W || y < 0 || y >= H) return false;
      const v = d[y * W + x];
      return v >= lower && v <= upper;
    };
    // inside(x, y, direction): the pixel in a given direction from vertex (x, y)
    const insideDir = (x, y, dir) => {
      switch (dir & 3) {
        case 0: return inside(x, y);
        case 1: return inside(x, y - 1);
        case 2: return inside(x - 1, y - 1);
        default: return inside(x - 1, y);
      }
    };
    let xs = [], ys = [], xmin = W;
    function addPoint(x, y) {
      if (xs.length >= MAX_VERTS) throw fail('IJ_ROI_TOO_COMPLEX', 'wand outline');
      xs.push(x); ys.push(y);
      if (xmin > x) xmin = x;
    }
    /* Wand.traceEdge: "We walk along the border, from one vertex to the next, with the outside pixels always
     * being at the left-hand side. For 8-connected tracing, we always trying to turn left as much as possible"
     * "return (direction <= 0);  // if we have done a clockwise loop, inside pixels are enclosed" */
    function traceEdge(sx, sy, fourConnected) {
      xs = []; ys = []; xmin = W;
      let startDirection;
      if (inside(sx, sy)) startDirection = 1; else { startDirection = 3; sy++; }
      let x = sx, y = sy, direction = startDirection;
      do {
        let newDirection;
        if (fourConnected) {
          newDirection = direction;
          do {
            if (!insideDir(x, y, newDirection)) break;
            newDirection++;
          } while (newDirection < direction + 2);
          newDirection--;
        } else {
          newDirection = direction + 1;
          do {
            if (insideDir(x, y, newDirection)) break;
            newDirection--;
          } while (newDirection >= direction);
        }
        if (newDirection !== direction) addPoint(x, y);
        switch (newDirection & 3) { case 0: x++; break; case 1: y--; break; case 2: x--; break; default: y++; }
        direction = newDirection;
      } while (x !== sx || y !== sy || (direction & 3) !== startDirection);
      if (xs[0] !== x) addPoint(x, y);
      return direction <= 0;
    }

    let x = startX; const y = startY;
    let seedX;
    if (inside(x, y)) {
      seedX = x;
      do { x++; } while (inside(x, y));
    } else {
      do { x++; if (x >= W) return null; } while (!inside(x, y));
      seedX = x;
    }
    let first = true;
    for (;;) {
      const insideSelected = traceEdge(x, y, four);
      if (insideSelected) {
        if (first) break;
        if (xmin <= seedX && polygonContains(xs, ys, seedX, startY)) break;
      }
      first = false;
      // "we have traced an inner hole or the wrong particle"
      if (!inside(x, y)) do { x++; if (x > W) throw fail('IJ_INTERNAL', 'Wand Malfunction'); } while (!inside(x, y));
      do { x++; } while (inside(x, y));
    }
    if (!xs.length) return null;
    const pts = new Array(xs.length);
    for (let i = 0; i < xs.length; i++) pts[i] = [xs[i], ys[i]];
    return pts;
  }

  // ================================================================================================
  // Polygon geometry — Roi.getFloatPolygon, FloatPolygon.getConvexHull, Roi.getFeretValues
  // ================================================================================================

  /* java.awt.geom.Ellipse2D path, flattened as ShapeRoi.getFloatPolygon does:
   *   OvalRoi.getFloatPolygon: "new ShapeRoi(new Ellipse2D.Double(x-0.0004, y-0.0004, width+0.0008, height+0.0008))"
   *   ShapeRoi.FLATNESS = 0.1; java.awt.geom.FlatteningPathIterator (limit 10): a cubic is subdivided at t = 1/2
   *   (CubicCurve2D.subdivide) until getFlatnessSq < flatness², left half first; every leaf contributes its end point. */
  function ellipsePolygon2D(x, y, w, h) {
    const CV = 0.5522847498307933, pcv = 0.5 + CV * 0.5, ncv = 0.5 - CV * 0.5;
    const ctrl = [[1.0, pcv, pcv, 1.0, 0.5, 1.0], [ncv, 1.0, 0.0, pcv, 0.0, 0.5], [0.0, ncv, ncv, 0.0, 0.5, 0.0], [pcv, 0.0, 1.0, ncv, 1.0, 0.5]];
    const sqFlat = 0.1 * 0.1, LIMIT = 10;
    const xs = [], ys = [];
    let cx = x + w, cy = y + h / 2;
    xs.push(cx); ys.push(cy);
    const segDist2 = (x1, y1, x2, y2, px, py) => { // Line2D.ptSegDistSq
      x2 -= x1; y2 -= y1; px -= x1; py -= y1;
      let dot = px * x2 + py * y2, proj;
      if (dot <= 0.0) proj = 0.0; else {
        px = x2 - px; py = y2 - py;
        dot = px * x2 + py * y2;
        if (dot <= 0.0) proj = 0.0; else proj = dot * dot / (x2 * x2 + y2 * y2);
      }
      const l = px * px + py * py - proj;
      return l < 0 ? 0 : l;
    };
    const flatSq = (c) => Math.max(segDist2(c[0], c[1], c[6], c[7], c[2], c[3]), segDist2(c[0], c[1], c[6], c[7], c[4], c[5]));
    function subdivide(c) {
      let x1 = c[0], y1 = c[1], cx1 = c[2], cy1 = c[3], cx2 = c[4], cy2 = c[5], x2 = c[6], y2 = c[7];
      const L = [x1, y1], R = [0, 0, 0, 0, 0, 0, x2, y2];
      x1 = (x1 + cx1) / 2.0; y1 = (y1 + cy1) / 2.0;
      x2 = (x2 + cx2) / 2.0; y2 = (y2 + cy2) / 2.0;
      let centerx = (cx1 + cx2) / 2.0, centery = (cy1 + cy2) / 2.0;
      cx1 = (x1 + centerx) / 2.0; cy1 = (y1 + centery) / 2.0;
      cx2 = (x2 + centerx) / 2.0; cy2 = (y2 + centery) / 2.0;
      centerx = (cx1 + cx2) / 2.0; centery = (cy1 + cy2) / 2.0;
      L.push(x1, y1, cx1, cy1, centerx, centery);
      R[0] = centerx; R[1] = centery; R[2] = cx2; R[3] = cy2; R[4] = x2; R[5] = y2;
      return [L, R];
    }
    function flatten(c, level) {
      if (level < LIMIT && flatSq(c) >= sqFlat) { const [l, r] = subdivide(c); flatten(l, level + 1); flatten(r, level + 1); } else { xs.push(c[6]); ys.push(c[7]); }
    }
    for (let k = 0; k < 4; k++) {
      const q = ctrl[k];
      const end = [x + q[4] * w, y + q[5] * h];
      flatten([cx, cy, x + q[0] * w, y + q[1] * h, x + q[2] * w, y + q[3] * h, end[0], end[1]], 0);
      cx = end[0]; cy = end[1];
    }
    // SEG_CLOSE: the last point equals the first: "xp.removeLast(1)"
    if (xs[xs.length - 1] === xs[0] && ys[ys.length - 1] === ys[0]) { xs.pop(); ys.pop(); }
    return { xs: xs.map(fr), ys: ys.map(fr) };
  }
  function ovalPolygon(x, y, w, h) { return ellipsePolygon2D(x - 0.0004, y - 0.0004, w + 0.0008, h + 0.0008); }

  /* Roi.getFloatPolygon(""): "no duplicate closing points". Rectangles give their four corners, ovals the
   * flattened ellipse, polygons / traced / freehand their vertices, a mask the vertices of every traced loop. */
  function roiVertices(roi) {
    let xs = [], ys = [];
    switch (roi.type) {
      case 'rect': xs = [roi.x, roi.x + roi.w, roi.x + roi.w, roi.x]; ys = [roi.y, roi.y, roi.y + roi.h, roi.y + roi.h]; break;
      case 'oval': return ovalPolygon(roi.x, roi.y, roi.w, roi.h);
      case 'mask': for (const loop of IJRoi.outlines(roi)) for (const p of loop) { xs.push(p[0]); ys.push(p[1]); } break;
      case 'line': xs = [roi.x1, roi.x2]; ys = [roi.y1, roi.y2]; break;
      default: if (roi.points) for (const p of roi.points) { xs.push(fr(p[0])); ys.push(fr(p[1])); }
    }
    const n = xs.length;
    if (IJRoi.isArea(roi) && n > 1 && xs[0] === xs[n - 1] && ys[0] === ys[n - 1]) { xs.pop(); ys.pop(); }
    return { xs, ys };
  }

  /* FloatPolygon.getConvexHull — gift wrapping, "The sequence of the points on the convex hull is
   * counterclockwise" (y down on the screen). A start point = smallest y, then smallest x; collinear points
   * "avoid collinear points on the hull: take longest possible side length". O(n·h): above FAST_HULL vertices
   * the same hull is built by monotone chain (O(n log n)) and put in the same order. */
  const FAST_HULL = 1500;
  function convexHull(xp, yp) {
    const npoints = xp.length;
    if (!npoints) return { xs: [], ys: [] };
    if (npoints > FAST_HULL) return convexHullFast(xp, yp);
    const xx = [], yy = [];
    let smallestY = Infinity;
    for (let i = 0; i < npoints; i++) if (yp[i] < smallestY) smallestY = yp[i];
    let smallestX = Infinity, p1 = 0;
    for (let i = 0; i < npoints; i++) if (yp[i] === smallestY && xp[i] < smallestX) { smallestX = xp[i]; p1 = i; }
    const pstart = p1;
    do {
      const x1 = xp[p1], y1 = yp[p1];
      let p2 = p1, x2 = 0, y2 = 0;
      do {
        p2++; if (p2 === npoints) p2 = 0;
        if (p2 === p1) break;
        x2 = xp[p2]; y2 = yp[p2];
      } while (x2 === x1 && y2 === y1);
      let p3 = p2 + 1; if (p3 === npoints) p3 = 0;
      if (p2 !== p1) do {
        const x3 = xp[p3], y3 = yp[p3];
        const determinate = x1 * (y2 - y3) - y1 * (x2 - x3) + (y3 * x2 - y2 * x3);
        let collinearAndFurther = false;
        if (determinate === 0 && p3 !== p2) {
          const d2sqr = (x2 - x1) * (x2 - x1) + (y2 - y1) * (y2 - y1);
          const d3sqr = (x3 - x1) * (x3 - x1) + (y3 - y1) * (y3 - y1);
          collinearAndFurther = d3sqr > d2sqr;
        }
        if (determinate > 0 || collinearAndFurther) { x2 = x3; y2 = y3; p2 = p3; }
        p3++; if (p3 === npoints) p3 = 0;
      } while (p3 !== p1);
      xx.push(fr(x1)); yy.push(fr(y1));
      if (p2 === p1) break;
      p1 = p2;
      if (xx.length > 1 && xp[p1] === xx[0] && yp[p1] === yy[0]) break;
    } while (p1 !== pstart);
    return { xs: xx, ys: yy };
  }

  /* Monotone chain, strict turns (no collinear points), then rotated to start at the smallest-y / smallest-x
   * vertex and oriented as the gift wrapping walks: from the start point the next hull point is the one that
   * keeps every other point on the side where `determinate <= 0` (see above). */
  function convexHullFast(xp, yp) {
    const idx = Array.from({ length: xp.length }, (_, i) => i).sort((a, b) => xp[a] - xp[b] || yp[a] - yp[b]);
    const cross = (o, a, b) => (xp[a] - xp[o]) * (yp[b] - yp[o]) - (yp[a] - yp[o]) * (xp[b] - xp[o]);
    const lower = [];
    for (const i of idx) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], i) <= 0) lower.pop(); lower.push(i); }
    const upper = [];
    for (let k = idx.length - 1; k >= 0; k--) { const i = idx[k]; while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], i) <= 0) upper.pop(); upper.push(i); }
    upper.pop(); lower.pop();
    let hull = lower.concat(upper); // counterclockwise in a y-up frame = clockwise on screen
    // unique points only
    const seen = new Set(); hull = hull.filter((i) => { const k = xp[i] + ',' + yp[i]; if (seen.has(k)) return false; seen.add(k); return true; });
    if (hull.length < 2) return { xs: hull.map((i) => fr(xp[i])), ys: hull.map((i) => fr(yp[i])) };
    let start = 0;
    for (let k = 1; k < hull.length; k++) { const a = hull[k], b = hull[start]; if (yp[a] < yp[b] || (yp[a] === yp[b] && xp[a] < xp[b])) start = k; }
    let ordered = hull.slice(start).concat(hull.slice(0, start));
    // the gift wrapping walks so that the second point has the larger x-direction turn: compare with the reference rule
    const s = ordered[0], n1 = ordered[1], n2 = ordered[ordered.length - 1];
    const det = (a, b, c) => xp[a] * (yp[b] - yp[c]) - yp[a] * (xp[b] - xp[c]) + (yp[c] * xp[b] - yp[b] * xp[c]);
    // gift wrapping keeps p2 when no candidate has determinate > 0, i.e. every other point q gives det(s, p2, q) <= 0
    if (!(det(s, n1, n2) <= 0)) ordered = [ordered[0]].concat(ordered.slice(1).reverse());
    return { xs: ordered.map((i) => fr(xp[i])), ys: ordered.map((i) => fr(yp[i])) };
  }

  /* Analyzer.getArea(Polygon p) over Roi.getConvexHull(): the hull rounded to integers ("toIntR"), then
   * "carea += (p.xpoints[i]+p.xpoints[iminus1])*(p.ypoints[i]-p.ypoints[iminus1])" and "Math.abs(carea/2.0)". */
  function hullAreaRounded(hull) {
    const n = hull.xs.length;
    if (!n) return NaN;
    const X = hull.xs.map(jround), Y = hull.ys.map(jround);
    let carea = 0;
    for (let i = 0; i < n; i++) { const j = i === 0 ? n - 1 : i - 1; carea += (X[i] + X[j]) * (Y[i] - Y[j]); }
    return Math.abs(carea / 2.0);
  }

  /* Roi.getFeretValues: [0] Feret, [1] FeretAngle (0..180), [2] MinFeret, [3][4] FeretX / FeretY = the start
   * point in PIXEL coordinates ("a[3] = xf1; a[4] = yf1;" — not scaled), the diameter and MinFeret calibrated.
   * OvalRoi overrides it: the axes of the bounding box ("a[0] = highAspect ? height*ph : width*pw") and a
   * scaled start point. */
  function feretValues(roi, pw, ph, W, H) {
    if (roi && roi.type === 'oval') {
      const highAspect = ph * roi.h > pw * roi.w;
      return {
        feret: highAspect ? roi.h * ph : roi.w * pw, angle: highAspect ? 90.0 : 0.0, min: highAspect ? roi.w * pw : roi.h * ph,
        x: (roi.x + (highAspect ? 0.5 * roi.w : 0)) * pw, y: (roi.y + (highAspect ? roi.h : 0.5 * roi.h)) * ph
      };
    }
    const poly = roiVertices(roi || { type: 'rect', x: 0, y: 0, w: W, h: H });
    const hull = convexHull(poly.xs, poly.ys);
    const xp = hull.xs, yp = hull.ys, n = xp.length;
    if (!n) return null;
    const ell = roi && roi.ellipse && pw === ph ? roi.ellipse : null;
    let p1 = 0, p2 = 0, diameterSqr = 0.0;
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
      const dx = (xp[i] - xp[j]) * pw, dy = (yp[i] - yp[j]) * ph;
      const dsqr = dx * dx + dy * dy;
      if (dsqr > diameterSqr) { diameterSqr = dsqr; p1 = i; p2 = j; }
    }
    if (xp[p1] > xp[p2]) { const t = p1; p1 = p2; p2 = t; }
    const xf1 = xp[p1], yf1 = yp[p1], xf2 = xp[p2], yf2 = yp[p2];
    let angle = (180.0 / Math.PI) * Math.atan2((yf1 - yf2) * ph, (xf2 - xf1) * pw);
    if (angle < 0.0) angle += 180.0;
    // minimum caliper width: "The following code requires a counterclockwise convex hull with no duplicate points"
    let x0 = xp[n - 1], y0 = yp[n - 1];
    let minFeret = Number.MAX_VALUE;
    for (let i = 0; i < n; i++) {
      const xprev = x0, yprev = y0;
      x0 = xp[i]; y0 = yp[i];
      let xnorm = (y0 - yprev) * ph, ynorm = (xprev - x0) * pw;
      const normalizationFactor = 1 / Math.sqrt(xnorm * xnorm + ynorm * ynorm);
      xnorm *= normalizationFactor * pw;
      ynorm *= normalizationFactor * ph;
      let maxDist = 0;
      for (let j = 0; j < n; j++) {
        const dist = (xp[j] - x0) * xnorm + (yp[j] - y0) * ynorm;
        if (dist > maxDist) maxDist = dist;
      }
      if (maxDist < minFeret) minFeret = maxDist;
    }
    // EllipseRoi.getFeretValues: "a[0] = major*pw; a[2] = minor*pw;" when "pw != ph" does not hold (the hull is the 72-gon)
    if (ell) {
      const major = Math.sqrt((ell.x2 - ell.x1) ** 2 + (ell.y2 - ell.y1) ** 2);
      return { feret: major * pw, angle, min: major * ell.aspect * pw, x: xf1, y: yf1 };
    }
    return { feret: Math.sqrt(diameterSqr), angle, min: minFeret, x: xf1, y: yf1 };
  }

  // ================================================================================================
  // Perimeter / length — Roi.getLength, PolygonRoi.getLength
  // ================================================================================================

  function polyLength(pts, pw, ph, close) {
    const n = pts.length;
    if (n < 2) return 0;
    let len = 0;
    for (let i = 0; i < n - 1; i++) len += Math.sqrt(((pts[i + 1][0] - pts[i][0]) * pw) ** 2 + ((pts[i + 1][1] - pts[i][1]) * ph) ** 2);
    if (close) len += Math.sqrt(((pts[0][0] - pts[n - 1][0]) * pw) ** 2 + ((pts[0][1] - pts[n - 1][1]) * ph) ** 2);
    return len;
  }
  /* PolygonRoi.getSmoothedLineLength + the closing segment (getSmoothedPerimeter), calibrated: each segment
   * "Math.sqrt(dx*dx*w2+dy*dy*h2)". */
  function smoothedLength(pts, pw, ph, close) {
    const n = pts.length, w2 = pw * pw, h2 = ph * ph;
    if (n < 3) return polyLength(pts, pw, ph, close);
    const X = (i) => pts[i][0], Y = (i) => pts[i][1];
    const seg = (dx, dy) => Math.sqrt(dx * dx * w2 + dy * dy * h2);
    let len = seg((X(0) + X(1) + X(2)) / 3.0 - X(0), (Y(0) + Y(1) + Y(2)) / 3.0 - Y(0));
    for (let i = 1; i < n - 2; i++) len += seg((X(i + 2) - X(i - 1)) / 3.0, (Y(i + 2) - Y(i - 1)) / 3.0);
    len += seg(X(n - 1) - (X(n - 3) + X(n - 2) + X(n - 1)) / 3.0, Y(n - 1) - (Y(n - 3) + Y(n - 2) + Y(n - 1)) / 3.0);
    if (close) len += seg(X(n - 1) - X(0), Y(n - 1) - Y(0));
    return len;
  }
  /* Roi.getLength() of every selection type, calibrated:
   *   rect  "double perimeter = 2.0*width*pw + 2.0*height*ph;"
   *   oval  "Math.PI*(3*(a + b) - Math.sqrt((3*a + b)*(a + 3*b)))" with a = 0.5*width*pw, b = 0.5*height*ph
   *   traced polygon: PolygonRoi.getTracedPerimeter; freehand: the smoothed perimeter; other polygon: the edge sum
   *   line / polyline: its length; mask: the traced perimeters of every outline of the pixel set. */
  function perimeter(roi, pw, ph) {
    pw = pw || 1; ph = ph || 1;
    switch (roi.type) {
      case 'rect': return 2.0 * roi.w * pw + 2.0 * roi.h * ph;
      case 'oval': { const a = 0.5 * roi.w * pw, b = 0.5 * roi.h * ph; return Math.PI * (3 * (a + b) - Math.sqrt((3 * a + b) * (a + 3 * b))); }
      case 'polygon': if (roi.ellipse) return polyLength(roi.points, pw, ph, true); // EllipseRoi.getLength: the plain edge sum
        return roi.traced || isTracedPolygon(roi.points) ? IJRoi.tracedPerimeter(roi.points, pw, ph) : polyLength(roi.points, pw, ph, true);
      case 'freehand': return smoothedLength(roi.points, pw, ph, true);
      case 'line': return Math.sqrt(((roi.x2 - roi.x1) * pw) ** 2 + ((roi.y2 - roi.y1) * ph) ** 2);
      case 'polyline': return polyLength(roi.points, pw, ph, false);
      case 'mask': return maskPerimeter(roi, pw, ph);
      default: return 0;
    }
  }

  // ================================================================================================
  // ThresholdToSelection outlines — the polygons of a mask as ImageJ's Create Selection builds them
  // ================================================================================================

  /* ij.plugin.filter.ThresholdToSelection.Outline: a Cartesian polygon in progress, a deque of points (front stored
   * reversed). "optimize out intermediate points of straight lines" happens in append(x, y) / prepend(x, y) and in
   * getPolygon, as in the source. */
  function Outline() { this.fx = []; this.fy = []; this.bx = []; this.by = []; }
  Outline.prototype.size = function () { return this.fx.length + this.bx.length; };
  Outline.prototype.X = function (i) { const f = this.fx.length; return i < f ? this.fx[f - 1 - i] : this.bx[i - f]; };
  Outline.prototype.Y = function (i) { const f = this.fx.length; return i < f ? this.fy[f - 1 - i] : this.by[i - f]; };
  function collinear(x1, y1, x2, y2, x3, y3) { return (x2 - x1) * (y3 - y2) === (y2 - y1) * (x3 - x2); }
  /* "if (last-first>=2 && collinear(x[last-2], y[last-2], x[last-1], y[last-1], x, y)) replace previous point" */
  Outline.prototype.appendPt = function (x, y) {
    const n = this.size();
    if (n >= 2 && collinear(this.X(n - 2), this.Y(n - 2), this.X(n - 1), this.Y(n - 1), x, y)) {
      if (this.bx.length) { this.bx[this.bx.length - 1] = x; this.by[this.by.length - 1] = y; } else { this.fx[0] = x; this.fy[0] = y; }
    } else { this.bx.push(x); this.by.push(y); }
  };
  /* "if (last-first>=2 && collinear(x[first+1], y[first+1], x[first], y[first], x, y)) replace the first point" */
  Outline.prototype.prependPt = function (x, y) {
    const n = this.size();
    if (n >= 2 && collinear(this.X(1), this.Y(1), this.X(0), this.Y(0), x, y)) {
      if (this.fx.length) { this.fx[this.fx.length - 1] = x; this.fy[this.fy.length - 1] = y; } else { this.bx[0] = x; this.by[0] = y; }
    } else { this.fx.push(x); this.fy.push(y); }
  };
  Outline.prototype.adopt = function (o) { this.fx = o.fx; this.fy = o.fy; this.bx = o.bx; this.by = o.by; };
  /* Merge with another Outline by adding it at the end (the smaller one is copied into the larger one's arrays). */
  Outline.prototype.appendOutline = function (o) {
    const n = this.size(), m = o.size();
    if (n >= m) { for (let i = 0; i < m; i++) { this.bx.push(o.X(i)); this.by.push(o.Y(i)); } } else {
      for (let i = n - 1; i >= 0; i--) { o.fx.push(this.X(i)); o.fy.push(this.Y(i)); }
      this.adopt(o);
    }
  };
  /* Merge with another Outline by adding it at the beginning. */
  Outline.prototype.prependOutline = function (o) {
    const n = this.size(), m = o.size();
    if (n >= m) { for (let i = m - 1; i >= 0; i--) { this.fx.push(o.X(i)); this.fy.push(o.Y(i)); } } else {
      for (let i = 0; i < n; i++) { o.bx.push(this.X(i)); o.by.push(this.Y(i)); }
      this.adopt(o);
    }
  };
  /* Outline.getPolygon: "optimize out intermediate points of straight lines (created, e.g., by merging outlines)". */
  Outline.prototype.getPolygon = function () {
    const n0 = this.size();
    const x = new Array(n0), y = new Array(n0);
    for (let i = 0; i < n0; i++) { x[i] = this.X(i); y[i] = this.Y(i); }
    let first = 0, last = n0, i, j = first + 1;
    for (i = first + 1; i + 1 < last; j++) {
      if (collinear(x[j - 1], y[j - 1], x[j], y[j], x[j + 1], y[j + 1])) { last--; continue; }
      if (i !== j) { x[i] = x[j]; y[i] = y[j]; }
      i++;
    }
    if (collinear(x[j - 1], y[j - 1], x[j], y[j], x[first], y[first])) last--;
    else { x[i] = x[j]; y[i] = y[j]; }
    if (last - first > 2 && collinear(x[last - 1], y[last - 1], x[first], y[first], x[first + 1], y[first + 1])) first++;
    const out = [];
    for (let k = first; k < last; k++) out.push([x[k], y[k]]);
    return out;
  };

  /* ThresholdToSelection.getRoi over the dense 0/1 mask `sel` (w x h): every outline, the filled ones and the holes, in the
   * order ImageJ appends them to its GeneralPath. "(Without the code with xAfterLowerRightCorner, etc., this case of
   * 8-connected pixels would result in disjunct outlines, e.g. a one-pixel-wide line with angle between 0 and -90 deg
   * would be converted to many separate rectangular segments)." Vertices are in the box's own coordinates. */
  function thresholdOutlines(sel, w, h, io) {
    const polygons = [];
    let prevRow = new Uint8Array(w + 2), thisRow = new Uint8Array(w + 2);
    const outline = new Array(w + 1).fill(null);
    const assertion = () => fail('IJ_INTERNAL', 'ThresholdToSelection assertion failed');
    for (let y = 0; y <= h; y++) {
      if (io && (y & 255) === 0) io.check();
      const b = prevRow; prevRow = thisRow; thisRow = b;
      let xAfterLowerRightCorner = -1, oAfterLowerRightCorner = null;
      thisRow[1] = y < h ? sel[y * w] : 0;
      for (let x = 0; x <= w; x++) {
        if (y < h && x < w - 1) thisRow[x + 2] = sel[y * w + x + 1];
        else if (x < w - 1) thisRow[x + 2] = 0;
        if (thisRow[x + 1]) {
          if (!prevRow[x + 1]) {
            // Upper edge of selected area
            if (outline[x] === null) {
              if (outline[x + 1] === null) {
                outline[x + 1] = outline[x] = new Outline();
                outline[x].appendPt(x + 1, y);
                outline[x].appendPt(x, y);
              } else {
                outline[x] = outline[x + 1];
                outline[x + 1] = null;
                outline[x].appendPt(x, y);
              }
            } else if (outline[x + 1] === null) {
              if (x === xAfterLowerRightCorner) {
                outline[x + 1] = outline[x];
                outline[x] = oAfterLowerRightCorner;
                outline[x].appendPt(x, y);
                outline[x + 1].prependPt(x + 1, y);
              } else {
                outline[x + 1] = outline[x];
                outline[x] = null;
                outline[x + 1].prependPt(x + 1, y);
              }
            } else if (outline[x + 1] === outline[x]) {
              if (x < w - 1 && y < h && x !== xAfterLowerRightCorner && !thisRow[x + 2] && prevRow[x + 2]) {
                outline[x] = null;
                outline[x + 1].prependPt(x + 1, y);
                xAfterLowerRightCorner = x + 1;
                oAfterLowerRightCorner = outline[x + 1];
              } else {
                polygons.push(outline[x].getPolygon()); // MINUS (add inner hole)
                outline[x + 1] = null;
                outline[x] = (x === xAfterLowerRightCorner) ? oAfterLowerRightCorner : null;
              }
            } else {
              outline[x].prependOutline(outline[x + 1]); // merge
              for (let x1 = 0; x1 <= w; x1++) {
                if (x1 !== x + 1 && outline[x1] === outline[x + 1]) {
                  outline[x1] = outline[x];
                  outline[x + 1] = null;
                  outline[x] = (x === xAfterLowerRightCorner) ? oAfterLowerRightCorner : null;
                  break;
                }
              }
              if (outline[x + 1] !== null) throw assertion();
            }
          }
          if (!thisRow[x]) { // left edge
            if (outline[x] === null) throw assertion();
            outline[x].appendPt(x, y + 1);
          }
        } else {
          if (prevRow[x + 1]) {
            // Lower edge of selected area
            if (outline[x] === null) {
              if (outline[x + 1] === null) {
                outline[x] = outline[x + 1] = new Outline();
                outline[x].appendPt(x, y);
                outline[x].appendPt(x + 1, y);
              } else {
                outline[x] = outline[x + 1];
                outline[x + 1] = null;
                outline[x].prependPt(x, y);
              }
            } else if (outline[x + 1] === null) {
              if (x === xAfterLowerRightCorner) {
                outline[x + 1] = outline[x];
                outline[x] = oAfterLowerRightCorner;
                outline[x].prependPt(x, y);
                outline[x + 1].appendPt(x + 1, y);
              } else {
                outline[x + 1] = outline[x];
                outline[x] = null;
                outline[x + 1].appendPt(x + 1, y);
              }
            } else if (outline[x + 1] === outline[x]) {
              if (x < w - 1 && y < h && x !== xAfterLowerRightCorner && thisRow[x + 2] && !prevRow[x + 2]) {
                outline[x] = null;
                outline[x + 1].appendPt(x + 1, y);
                xAfterLowerRightCorner = x + 1;
                oAfterLowerRightCorner = outline[x + 1];
              } else {
                polygons.push(outline[x].getPolygon()); // PLUS (add filled outline)
                outline[x + 1] = null;
                outline[x] = x === xAfterLowerRightCorner ? oAfterLowerRightCorner : null;
              }
            } else if (x < w - 1 && y < h && x !== xAfterLowerRightCorner && thisRow[x + 2] && !prevRow[x + 2]) {
              outline[x].appendPt(x + 1, y);
              outline[x + 1].prependPt(x + 1, y);
              xAfterLowerRightCorner = x + 1;
              oAfterLowerRightCorner = outline[x];
              outline[x] = null;
            } else {
              outline[x].appendOutline(outline[x + 1]); // merge
              for (let x1 = 0; x1 <= w; x1++) {
                if (x1 !== x + 1 && outline[x1] === outline[x + 1]) {
                  outline[x1] = outline[x];
                  outline[x + 1] = null;
                  outline[x] = (x === xAfterLowerRightCorner) ? oAfterLowerRightCorner : null;
                  break;
                }
              }
              if (outline[x + 1] !== null) throw assertion();
            }
          }
          if (thisRow[x]) { // right edge
            if (outline[x] === null) throw assertion();
            outline[x].prependPt(x, y + 1);
          }
        }
      }
    }
    return polygons;
  }

  /* The polygons of a mask selection, image coordinates; cached per (immutable) run array. */
  const TTS_CACHE = new WeakMap();
  function maskOutlines(roi, io) {
    const hit = TTS_CACHE.get(roi.rle);
    if (hit && hit.x === roi.x && hit.y === roi.y && hit.w === roi.w && hit.h === roi.h) return hit.polys;
    if (!(roi.w > 0 && roi.h > 0)) return [];
    const d = IJRoi.maskDense(roi);
    const polys = thresholdOutlines(d, roi.w, roi.h, io).map((poly) => poly.map((p) => [p[0] + roi.x, p[1] + roi.y]));
    TTS_CACHE.set(roi.rle, { x: roi.x, y: roi.y, w: roi.w, h: roi.h, polys });
    return polys;
  }

  /* Roi.getLength of the selection ThresholdToSelection returns (ShapeRoi.trySimplify). More than one subpath: "boolean
   * forceTrace = getLength && (!done || nSubPaths>0);  //when calculating the length for >1 subpath, assume traced rois if
   * it can be such" -> every outline gets the traced perimeter. One outline: guessType gives a RECTANGLE for "nSegments == 4
   * && closed && horizontalVerticalIntOnly && longEdges" (2w + 2h), else TRACED_ROI / an integer rectilinear POLYGON
   * (PolygonRoi.isTraced) = the traced perimeter. */
  function maskPerimeter(roi, pw, ph) {
    const polys = maskOutlines(roi);
    if (polys.length === 1 && polys[0].length === 4) {
      const p = polys[0];
      let len = 0;
      for (let i = 0; i < 4; i++) { const a = p[i], b = p[(i + 1) % 4]; len += Math.abs(b[0] - a[0]) + Math.abs(b[1] - a[1]); }
      if (len / (4 * Math.sqrt(4)) >= 2) { const w = Math.abs(p[2][0] - p[0][0]), h = Math.abs(p[2][1] - p[0][1]); return 2.0 * w * pw + 2.0 * h * ph; }
    }
    let s = 0;
    for (const poly of polys) s += IJRoi.tracedPerimeter(poly, pw, ph);
    return s;
  }

  function isTracedPolygon(pts) {
    const n = pts.length;
    if (n < 4) return false;
    for (let i = 0; i < n; i++) {
      const a = pts[i], b = pts[(i + 1) % n];
      if (!Number.isInteger(a[0]) || !Number.isInteger(a[1])) return false;
      if (a[0] !== b[0] && a[1] !== b[1]) return false;
    }
    return true;
  }

  /* Line.getFloatAngle (calibrated): "dx *= cal.pixelWidth; dy *= cal.pixelHeight; atan2(dy, dx)"; y points up. */
  function lineAngleCal(x1, y1, x2, y2, pw, ph) {
    return (180.0 / Math.PI) * Math.atan2((y1 - y2) * ph, (x2 - x1) * pw);
  }
  /* PolygonRoi.getAngleAsString: "degrees = Math.abs(180-Math.abs(angle1-angle2)); if (degrees>180.0) degrees =
   * 360.0-degrees;" over the arms p0→p1 and p1→p2; Prefs.reflexAngle is false. */
  function angleOf(pts, pw, ph) {
    const a1 = lineAngleCal(pts[0][0], pts[0][1], pts[1][0], pts[1][1], pw, ph);
    const a2 = lineAngleCal(pts[1][0], pts[1][1], pts[2][0], pts[2][1], pw, ph);
    let degrees = Math.abs(180 - Math.abs(a1 - a2));
    if (degrees > 180.0) degrees = 360.0 - degrees;
    return degrees;
  }

  // ================================================================================================
  // Ellipse — ij.process.EllipseFitter, ij.gui.EllipseRoi
  // ================================================================================================

  /* EllipseFitter.fit over the bits of `mask` (rect.w × rect.h, null = no mask). Source quotes:
   *   "if (mask==null) { major = (width*2) / sqrtPi; minor = (height*2) / sqrtPi; angle = 0.0; ...
   *    if (major < minor) { swap; angle = 90.0; } xCenter = left + width / 2.0; yCenter = top + height / 2.0;"
   *   "x2sum += 0.08333333 * bitCount;"  (the pixel's own variance)  and  "if (m4 < 0.000001) m4 = 0.000001;" */
  function fitEllipse(mask, rect) {
    const sqrtPi = 1.772453851, HALFPI = 1.5707963267949;
    const left = rect.x, top = rect.y, width = rect.w, height = rect.h;
    let major, minor, angle, theta, xCenter, yCenter;
    if (!mask) {
      major = (width * 2) / sqrtPi; minor = (height * 2) / sqrtPi; angle = 0.0; theta = 0.0;
      if (major < minor) { const t = major; major = minor; minor = t; angle = 90.0; theta = Math.PI / 2.0; }
      return { major, minor, angle, theta, xCenter: left + width / 2.0, yCenter: top + height / 2.0 };
    }
    let xsum = 0, ysum = 0, x2sum = 0, y2sum = 0, xysum = 0, bitCount = 0;
    for (let y = 0; y < height; y++) {
      let bitcountOfLine = 0, xSumOfLine = 0;
      const offset = y * width;
      for (let x = 0; x < width; x++) {
        if (mask[offset + x] !== 0) { bitcountOfLine++; xSumOfLine += x; x2sum += x * x; }
      }
      xsum += xSumOfLine; ysum += bitcountOfLine * y;
      xysum += xSumOfLine * y;
      y2sum += y * y * bitcountOfLine;
      bitCount += bitcountOfLine;
    }
    let u20 = 0, u02 = 0, u11 = 0, xm = 0, ym = 0;
    if (bitCount !== 0) {
      x2sum += 0.08333333 * bitCount; y2sum += 0.08333333 * bitCount;
      const n = bitCount;
      const x1 = xsum / n, y1 = ysum / n, x2 = x2sum / n, y2 = y2sum / n, xy = xysum / n;
      xm = x1; ym = y1;
      u20 = x2 - (x1 * x1); u02 = y2 - (y1 * y1); u11 = xy - x1 * y1;
    }
    let m4 = 4.0 * Math.abs(u02 * u20 - u11 * u11);
    if (m4 < 0.000001) m4 = 0.000001;
    let a11 = u02 / m4;
    const a12 = u11 / m4;
    let a22 = u20 / m4;
    let tmp = a11 - a22;
    if (tmp === 0.0) tmp = 0.000001;
    theta = 0.5 * Math.atan(2.0 * a12 / tmp);
    if (theta < 0.0) theta += HALFPI;
    if (a12 > 0.0) theta += HALFPI;
    else if (a12 === 0.0) {
      if (a22 > a11) { theta = 0.0; tmp = a22; a22 = a11; a11 = tmp; } else if (a11 !== a22) theta = HALFPI;
    }
    tmp = Math.sin(theta);
    if (tmp === 0.0) tmp = 0.000001;
    const z = a12 * Math.cos(theta) / tmp;
    major = Math.sqrt(1.0 / Math.abs(a22 + z));
    minor = Math.sqrt(1.0 / Math.abs(a11 - z));
    const scale = Math.sqrt(bitCount / (Math.PI * major * minor));
    major = major * scale * 2.0; minor = minor * scale * 2.0;
    angle = 180.0 * theta / Math.PI;
    if (angle === 180.0) angle = 0.0;
    if (major < minor) { tmp = major; major = minor; minor = tmp; }
    return { major, minor, angle, theta, xCenter: left + xm + 0.5, yCenter: top + ym + 0.5 };
  }

  /* EllipseRoi.makeEllipse: 72 float vertices. */
  function ellipsePolygon(x1, y1, x2, y2, aspect) {
    if (aspect < 0.0) aspect = 0.0;
    if (aspect > 1.0) aspect = 1.0;
    const centerX = (x1 + x2) / 2.0, centerY = (y1 + y2) / 2.0;
    let dx = x2 - x1, dy = y2 - y1;
    const major = Math.sqrt(dx * dx + dy * dy), minor = major * aspect;
    const phiB = Math.atan2(dy, dx), alpha = phiB * 180.0 / Math.PI;
    const out = [];
    for (let i = 0; i < 72; i++) {
      const degrees = i * 360.0 / 72;
      const beta1 = degrees / 180.0 * Math.PI;
      dx = Math.cos(beta1) * major / 2.0; dy = Math.sin(beta1) * minor / 2.0;
      const beta2 = Math.atan2(dy, dx), rad = Math.sqrt(dx * dx + dy * dy);
      const beta3 = beta2 + alpha / 180.0 * Math.PI;
      out.push([fr(centerX + Math.cos(beta3) * rad), fr(centerY + Math.sin(beta3) * rad)]);
    }
    return out;
  }

  // ================================================================================================
  // Profiles — ProfilePlot.getStraightLineProfile / getIrregularProfile, ImageProcessor.getInterpolatedValue
  // ================================================================================================

  /* ImageProcessor.getInterpolatedValue: "if (x<0.0 || x>=width-1.0 || y<0.0 || y>=height-1.0) { if (x<-1.0 ||
   * x>=width || y<-1.0 || y>=height) return 0.0; else return getInterpolatedEdgeValue(x, y); }" */
  function interpolatedValue(d, W, H, x, y) {
    const edge = (xx, yy) => { if (xx <= 0) xx = 0; if (xx >= W) xx = W - 1; if (yy <= 0) yy = 0; if (yy >= H) yy = H - 1; return d[yy * W + xx]; };
    if (x < 0.0 || x >= W - 1.0 || y < 0.0 || y >= H - 1.0) {
      if (x < -1.0 || x >= W || y < -1.0 || y >= H) return 0.0;
      const xb = jint(x), yb = jint(y);
      let xf = x - xb, yf = y - yb;
      if (xf < 0.0) xf = 0.0; if (yf < 0.0) yf = 0.0;
      const ll = edge(xb, yb), lr = edge(xb + 1, yb), ur = edge(xb + 1, yb + 1), ul = edge(xb, yb + 1);
      const ua = ul + xf * (ur - ul), la = ll + xf * (lr - ll);
      return la + yf * (ua - la);
    }
    const xb = jint(x), yb = jint(y);
    let xf = x - xb, yf = y - yb;
    if (xf < 0.0) xf = 0.0; if (yf < 0.0) yf = 0.0;
    const ll = d[yb * W + xb], lr = d[yb * W + xb + 1], ur = d[(yb + 1) * W + xb + 1], ul = d[(yb + 1) * W + xb];
    const ua = ul + xf * (ur - ul), la = ll + xf * (lr - ll);
    return la + yf * (ua - la);
  }

  /* ImageProcessor.getLine(x1, y1, x2, y2) with interpolation (ProfilePlot: ip.setInterpolate(PlotWindow.interpolate)):
   * "int n = (int)Math.round(Math.sqrt(dx*dx + dy*dy)); double xinc = n>0?dx/n:0; ... double[] data = new double[n+1];
   * for (i<=n) { data[i] = getInterpolatedValue(rx, ry); rx += xinc; ry += yinc; }" */
  function lineSamples(img, x1, y1, x2, y2) {
    const dx = x2 - x1, dy = y2 - y1;
    const n = jround(Math.sqrt(dx * dx + dy * dy));
    const xinc = n > 0 ? dx / n : 0, yinc = n > 0 ? dy / n : 0;
    const out = new Float64Array(n + 1);
    let rx = x1, ry = y1;
    for (let i = 0; i <= n; i++) { out[i] = interpolatedValue(img.data, img.width, img.height, rx, ry); rx += xinc; ry += yinc; }
    return out;
  }

  /* ProfilePlot.getIrregularProfile (polyline of width 1, interpolation on): points one pixel apart
   * ("distance2>=1.0-inc/2.0") found by stepping 0.01 along every segment:
   *   "xinc = dx*inc/distance; n2 = (int)(distance/inc); if (n==2) n2++;" */
  function irregularProfile(img, pts) {
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
          values.push(interpolatedValue(img.data, img.width, img.height, x, y));
          lastx = x; lasty = y;
        }
        x += xinc; y += yinc;
      } while (--n2 > 0);
    }
    return Float64Array.from(values);
  }

  /* ij.measure.SplineFitter (natural cubic spline, float[] flavour) as PolygonRoi.getSpline drives it. Java does the
   * few float - float subtractions in single precision ("cj = x[1]-x[0]", "ba = x[rs]-x[ls]"): kept with Math.fround. */
  function splineFit(x, y, n) {
    const y2 = new Float64Array(n), cp = new Float64Array(n);
    let newX = x[1], newY = y[1];
    let cj = fr(x[1] - x[0]);
    let newDj = fr(y[1] - y[0]) / cj;
    let j = 1;
    while (j < n - 1) {
      const oldX = newX, oldY = newY, aj = cj, oldDj = newDj;
      newX = x[j + 1]; newY = y[j + 1];
      cj = newX - oldX;
      newDj = (newY - oldY) / cj;
      const bj = 2.0 * (cj + aj);
      const invDenom = 1.0 / (bj - aj * cp[j - 1]);
      const dj = 6.0 * (newDj - oldDj);
      y2[j] = (dj - aj * y2[j - 1]) * invDenom;
      cp[j] = cj * invDenom;
      j += 1;
    }
    while (j > 0) { j -= 1; y2[j] = y2[j] - cp[j] * y2[j + 1]; }
    return function evalSpline(xp) {
      let ls = 0, rs = n - 1;
      while (rs > 1 + ls) { const m = Math.floor(0.5 * (ls + rs)); if (x[m] < xp) ls = m; else rs = m; }
      const ba = fr(x[rs] - x[ls]), xa = xp - x[ls], bx = x[rs] - xp, ba2 = ba * ba;
      const lower = xa * y[rs] + bx * y[ls];
      const C = (xa * xa - ba2) * xa * y2[rs], D = (bx * bx - ba2) * bx * y2[ls];
      return (lower + (C + D) / 6.0) / ba;
    };
  }

  /* Straightener.straightenLine + ProfilePlot.getWideLineProfile / Line.getPixels for a line wider than a pixel:
   *   PolygonRoi.fitSplineForStraightening: "getSpline((int)(getUncalibratedLength()*2)+1, null, null)" then
   *   "getEquidistantPoints(spline[0], spline[1], spline[0].length, 1.0, null)" (points one pixel apart);
   *   per point: "dx = x2-x1; dy = y1-y2; length = (float)Math.sqrt(dx*dx+dy*dy); x = x2-dy*(width-1)/2.0;
   *   y = y2-dx*(width-1)/2.0;" then `width` interpolated samples across the line (x += dy; y += dx), stored as floats;
   *   the profile is the average over those `width` rows per column (getColumnAverageProfile). */
  function wideProfile(img, pts, width) {
    const nPoints = pts.length;
    // PolygonRoi keeps its float vertices RELATIVE to the minimum of the set ("xpf[i] -= (float)bounds.x" in finishPolygon),
    // fits the spline on those and hands the points back as "xSpline[i] + xbase" (getFloatPolygon), after a re-basing on
    // the bounds of the spline (resetSplineFitBoundingRect). Every step is a float operation: reproduced so the sample
    // positions are the same floats.
    const ax = pts.map((p) => fr(p[0])), ay = pts.map((p) => fr(p[1]));
    let bx0 = Infinity, by0 = Infinity;
    for (let i = 0; i < nPoints; i++) { if (ax[i] < bx0) bx0 = ax[i]; if (ay[i] < by0) by0 = ay[i]; }
    const xpf = ax.map((v) => fr(v - bx0)), ypf = ay.map((v) => fr(v - by0));
    let uLen = 0;
    for (let i = 0; i < nPoints - 1; i++) uLen += Math.sqrt(fr(xpf[i + 1] - xpf[i]) ** 2 + fr(ypf[i + 1] - ypf[i]) ** 2); // PolygonRoi.getLength(float[]…): float differences
    const evaluationPoints = jint(uLen * 2) + 1;
    const nodePos = new Array(nPoints);
    let last = 0;
    nodePos[0] = 0;
    for (let i = 1; i < nPoints; i++) {
      const dx = fr(xpf[i] - xpf[i - 1]), dy = fr(ypf[i] - ypf[i - 1]);
      let dl = fr(Math.sqrt(Math.sqrt(fr(fr(dx * dx) + fr(dy * dy)))));
      if (dl < 0.001) dl = fr(0.001);
      last = fr(last + dl);
      nodePos[i] = last;
    }
    const sx = splineFit(nodePos, xpf, nPoints), sy = splineFit(nodePos, ypf, nPoints);
    const scale = last / (evaluationPoints - 1);
    const sxs = new Array(evaluationPoints), sys = new Array(evaluationPoints);
    for (let i = 0; i < evaluationPoints; i++) { const v = i * scale; sxs[i] = fr(sx(v)); sys[i] = fr(sy(v)); }
    // getEquidistantPoints(xSpline, ySpline, n, 1.0, null)
    let length = 0;
    for (let i = 0; i < evaluationPoints - 1; i++) length += Math.sqrt(fr(sxs[i + 1] - sxs[i]) ** 2 + fr(sys[i + 1] - sys[i]) ** 2);
    const npOut = jround(length / 1.0) + 1;
    const step = length / (npOut - 1);
    const px = new Array(npOut), py = new Array(npOut);
    px[0] = sxs[0]; py[0] = sys[0];
    let lengthRead = 0, written = 1, x2 = sxs[0], y2 = sys[0];
    for (let i = 1; i < evaluationPoints; i++) {
      const x1 = x2, y1 = y2;
      x2 = sxs[i]; y2 = sys[i];
      const dx = x2 - x1, dy = y2 - y1;
      const distance = Math.sqrt(dx * dx + dy * dy);
      lengthRead += distance;
      let over = lengthRead - written * step;
      while ((over >= 0.0 || i === evaluationPoints - 1) && written < npOut) {
        let frac = over / distance;
        if (distance === 0) frac = 0;
        px[written] = fr(x2 - frac * dx); py[written] = fr(y2 - frac * dy);
        over -= step; written++;
      }
    }
    const n = npOut;
    if (n < 2) return new Float64Array(0);
    // setSpline → resetSplineFitBoundingRect, then getFloatPolygon
    let bx1 = Infinity, by1 = Infinity;
    for (let i = 0; i < n; i++) { px[i] = fr(px[i] + bx0); py[i] = fr(py[i] + by0); if (px[i] < bx1) bx1 = px[i]; if (py[i] < by1) by1 = py[i]; }
    for (let i = 0; i < n; i++) { px[i] = fr(fr(px[i] - bx1) + bx1); py[i] = fr(fr(py[i] - by1) + by1); }
    const rows = new Float32Array(n * width);
    // "double x2 = p.xpoints[0]-(p.xpoints[1]-p.xpoints[0]);" — float arithmetic
    let xa = fr(px[0] - fr(px[1] - px[0])), ya = fr(py[0] - fr(py[1] - py[0]));
    for (let i = 0; i < n; i++) {
      const x1 = xa, y1 = ya;
      xa = px[i]; ya = py[i];
      let dx = xa - x1, dy = y1 - ya;
      const len = fr(Math.sqrt(dx * dx + dy * dy));
      dx /= len; dy /= len;
      let x = xa - dy * (width - 1) / 2.0, y = ya - dx * (width - 1) / 2.0;
      for (let j = 0; j < width; j++) { rows[j * n + i] = interpolatedValue(img.data, img.width, img.height, x, y); x += dy; y += dx; }
    }
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) { let sum = 0, c = 0; for (let j = 0; j < width; j++) { const v = rows[j * n + i]; if (v === v) { sum += v; c++; } } out[i] = sum / c; }
    return out;
  }

  /** The profile of a straight line or of a segmented line of width 1 (null for another selection). */
  function profile(img, roi) {
    if (roi.type === 'line') {
      // Line.getPixels: "if (getStrokeWidth()<=1) ip.getLine(...) else straightenLine(imp, this, 0)" with width (int)strokeWidth
      if ((roi.width || 0) <= 1) return lineSamples(img, roi.x1, roi.y1, roi.x2, roi.y2);
      return wideProfile(img, [[roi.x1, roi.y1], [roi.x2, roi.y2]], jint(roi.width));
    }
    if (roi.type === 'polyline') {
      // ProfilePlot: "int lineWidth = (int)Math.round(roi.getStrokeWidth()); if (lineWidth<=1) getIrregularProfile else getWideLineProfile"
      const lw = jround(roi.width || 0);
      return lw <= 1 ? irregularProfile(img, roi.points) : wideProfile(img, roi.points, lw);
    }
    return null;
  }

  // ================================================================================================
  // Line → area (wide lines) — Roi.convertLineToArea
  // ================================================================================================

  /* The pixel mask of a segmented line of width > 1: a rectangle per segment (the first / last extended by half a
   * pixel: "xfrom = p.xpoints[0] - 0.5*dx1"), a triangle between segments, each filled at "polygonFiller.setPolygon(
   * xv, yv, 4, 0.5f, 0.5f)" (the line coordinate convention differs from the area one by half a pixel). */
  function polylineAreaMask(pts, lineWidth, W, H) {
    const out = new Uint8Array(W * H);
    const radius = lineWidth / 2.0, n = pts.length;
    const P = pts.map((p) => [fr(p[0]), fr(p[1])]);
    const paint = (poly) => {
      const m = IJRoi.mask({ type: 'polygon', points: poly.map((p) => [p[0] + 0.5, p[1] + 0.5]) }, W, H);
      for (let j = 0; j < m.h; j++) for (let i = 0; i < m.w; i++) if (m.data[j * m.w + i]) out[(m.y + j) * W + m.x + i] = 1;
    };
    let dx1 = P[1][0] - P[0][0], dy1 = P[1][1] - P[0][1];
    let l = Math.sqrt(dx1 * dx1 + dy1 * dy1);
    dx1 /= l; dy1 /= l;
    let dx0 = dx1, dy0 = dy1;
    let xfrom = P[0][0] - 0.5 * dx1, yfrom = P[0][1] - 0.5 * dy1;
    for (let i = 1; i < n; i++) {
      let xto = P[i][0], yto = P[i][1];
      if (i === n - 1) { xto += 0.5 * dx1; yto += 0.5 * dy1; }
      paint([[fr(xfrom + radius * dy1), fr(yfrom - radius * dx1)], [fr(xfrom - radius * dy1), fr(yfrom + radius * dx1)],
        [fr(xto - radius * dy1), fr(yto + radius * dx1)], [fr(xto + radius * dy1), fr(yto - radius * dx1)]]);
      if (i > 1) {
        const rightTurn = (dx1 * dy0 > dx0 * dy1);
        let t0x = fr(xfrom), t0y = fr(yfrom), t1x, t1y, t2x, t2y;
        if (rightTurn) {
          t1x = fr(xfrom - radius * dy0); t1y = fr(yfrom + radius * dx0);
          t2x = fr(xfrom - radius * dy1); t2y = fr(yfrom + radius * dx1);
          t0x += fr(0.5 * (radius * dy0 + radius * dy1)); t0y -= fr(0.5 * (radius * dx0 + radius * dx1));
        } else {
          t1x = fr(xfrom + radius * dy0); t1y = fr(yfrom - radius * dx0);
          t2x = fr(xfrom + radius * dy1); t2y = fr(yfrom - radius * dx1);
          t0x -= fr(0.5 * (radius * dy0 + radius * dy1)); t0y += fr(0.5 * (radius * dx0 + radius * dx1));
        }
        paint([[fr(t0x), fr(t0y)], [t1x, t1y], [t2x, t2y]]);
      }
      dx0 = dx1; dy0 = dy1; xfrom = xto; yfrom = yto;
      if (i < n - 1) {
        dx1 = P[i + 1][0] - P[i][0]; dy1 = P[i + 1][1] - P[i][1];
        l = Math.sqrt(dx1 * dx1 + dy1 * dy1);
        dx1 /= l; dy1 /= l;
      }
    }
    return out;
  }

  // ================================================================================================
  // Measurements — Analyzer.saveResults / measureLength / measurePoint / measureAngle
  // ================================================================================================

  /* The pixels of an area selection in ImageJ's own bounding rectangle. A polygon with fractional vertices has the
   * bounds of FloatPolygon.getBounds(): "bounds = new Rectangle(iMinX, iMinY, (int)(maxX-iMinX+0.5), (int)(maxY-iMinY+0.5))"
   * (so a column whose centre lies beyond the right-most vertex is not part of it); every other selection the
   * bounding box of IJRoi.mask. Clipped to the image when W, H are given. -> { x, y, w, h, data } */
  function roiMaskBox(roi, W, H) {
    const m = IJRoi.mask(roi, W, H);
    if (!(roi.type === 'polygon' || roi.type === 'freehand') || !m.w || !m.h) return m;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of roi.points) { const x = fr(p[0]), y = fr(p[1]); if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
    const ix = Math.floor(minX), iy = Math.floor(minY);
    const x1 = ix + jint(maxX - ix + 0.5), y1 = iy + jint(maxY - iy + 0.5);
    const nx0 = Math.max(m.x, ix), ny0 = Math.max(m.y, iy), nx1 = Math.min(m.x + m.w, x1), ny1 = Math.min(m.y + m.h, y1);
    if (nx0 === m.x && ny0 === m.y && nx1 === m.x + m.w && ny1 === m.y + m.h) return m;
    const w = Math.max(0, nx1 - nx0), h = Math.max(0, ny1 - ny0), data = new Uint8Array(w * h);
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) data[j * w + i] = m.data[(ny0 - m.y + j) * m.w + (nx0 - m.x + i)];
    return { x: nx0, y: ny0, w, h, data };
  }

  /* Roi.getBounds without building the mask: a float polygon has "(int)(max-iMin+0.5)" (FloatPolygon.getBounds), every
   * other selection IJRoi.bounds. */
  function roiBounds(roi) {
    if (!(roi.type === 'polygon' || roi.type === 'freehand') || !roi.points.length) return IJRoi.bounds(roi);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of roi.points) { const x = fr(p[0]), y = fr(p[1]); if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
    const ix = Math.floor(minX), iy = Math.floor(minY);
    return { x: ix, y: iy, w: jint(maxX - ix + 0.5), h: jint(maxY - iy + 0.5) };
  }

  function calOf(c) { return { pw: c && c.pixelWidth > 0 ? c.pixelWidth : 1, ph: c && c.pixelHeight > 0 ? c.pixelHeight : 1 }; }

  /* The threshold-limited pixel mask: ImageStatistics with LIMIT counts only "v>=minThreshold && v<=maxThreshold". */
  function limitMask(img, box, base, thr) {
    const out = new Uint8Array(box.w * box.h), d = img.data, W = img.width;
    for (let j = 0; j < box.h; j++) {
      const row = (box.y + j) * W + box.x;
      for (let i = 0; i < box.w; i++) {
        const k = j * box.w + i;
        if (base && !base[k]) continue;
        const v = d[row + i];
        if (v >= thr.lower && v <= thr.upper) out[k] = 1;
      }
    }
    return out;
  }

  /* One row for an area selection (or the whole image) — Analyzer.saveResults with the statistics of
   * ImageStatistics. a = { img: {data,width,height,bitDepth}, roi, cal: calibration, keys: [short keys],
   * thr: {lower, upper}|null, limit }. Only the requested keys are returned. Row keys:
   *   area mean stdDev mode min max xCentroid yCentroid xCenterOfMass yCenterOfMass perim bx by bw bh major minor angle
   *   circularity feret feretX feretY feretAngle minFeret aspectRatio roundness solidity intDen rawIntDen median
   *   skewness kurtosis areaFraction minThreshold maxThreshold */
  function measureArea(a) {
    const img = a.img, W = img.width, H = img.height;
    const { pw, ph } = calOf(a.cal);
    const calibration = { pixelWidth: pw, pixelHeight: ph };
    const want = new Set(a.keys || []);
    const roi = a.roi || null;
    const limit = !!(a.limit && a.thr);
    let rect, mask = null;
    if (!roi) rect = { x: 0, y: 0, w: W, h: H };
    else {
      const m = roiMaskBox(roi, W, H);
      if (!(m.w > 0 && m.h > 0)) throw fail('IJ_EMPTY_ROI', 'the selection is outside the image');
      rect = { x: m.x, y: m.y, w: m.w, h: m.h };
      if (roi.type !== 'rect') mask = m.data;
    }
    const eff = limit ? limitMask(img, rect, mask, a.thr) : mask;        // the pixels the statistics see
    const box = eff ? { x: rect.x, y: rect.y, w: rect.w, h: rect.h, data: eff } : (roi ? { x: rect.x, y: rect.y, w: rect.w, h: rect.h, data: new Uint8Array(rect.w * rect.h).fill(1) } : null);
    let st = IJOps.statistics(img, box, { calibration });
    // An RGB image (img.lum = the unrounded luminance of ColorProcessor.getPixelValue): ColorStatistics.calculateMoments takes Skewness and
    // Kurtosis from those floats around the histogram mean, and never calculates %Area (it stays 0).
    if (img.lum) st = Object.assign({}, st, colorMoments(img.lum, W, rect, eff, st.mean, st.n));
    const row = {};
    const n = st.n;
    const fitNeeded = want.has('major') || want.has('minor') || want.has('angle') || want.has('aspectRatio') || want.has('roundness') || want.has('circularity') || want.has('solidity');
    let ef = null;
    if (fitNeeded) {
      ef = fitEllipse(eff, rect);
      // ImageStatistics.fitEllipse: "double psize = (Math.abs(pw-ph)/pw)<.01?pw:0.0; major = ef.major*psize;"
      const psize = (Math.abs(pw - ph) / pw) < 0.01 ? pw : 0.0;
      ef.majorCal = ef.major * psize; ef.minorCal = ef.minor * psize;
    }
    const set = (k, v) => { if (want.has(k)) row[k] = v; };
    set('area', st.area); set('mean', st.mean); set('stdDev', st.stdDev); set('mode', st.mode);
    set('min', st.min); set('max', st.max);
    // "xCentroid = ef.xCenter" when ELLIPSE or SHAPE_DESCRIPTORS were asked for, else the centroid of the counted pixels
    if (ef) { set('xCentroid', ef.xCenter * pw); set('yCentroid', ef.yCenter * ph); } else { set('xCentroid', st.xCentroid); set('yCentroid', st.yCentroid); }
    set('xCenterOfMass', st.xCenterOfMass); set('yCenterOfMass', st.yCenterOfMass);
    // "rt.addValue(ResultsTable.INTEGRATED_DENSITY,stats.area*stats.mean); RAW: stats.pixelCount*stats.umean"
    set('intDen', st.area * st.mean); set('rawIntDen', n * st.mean);
    set('median', st.median); set('skewness', st.skewness); set('kurtosis', st.kurtosis);
    // perimeter: "if (roi!=null) perimeter = roi.getLength(); else perimeter = imp.getWidth()*2+imp.getHeight()*2;"
    let perim = 0;
    if (want.has('perim') || want.has('circularity')) perim = roi ? perimeter(roi, pw, ph) : W * 2 + H * 2;
    set('perim', perim);
    if (want.has('circularity')) {
      let c = perim === 0.0 ? 0.0 : 4.0 * Math.PI * (st.area / (perim * perim));
      if (c > 1.0) c = 1.0;
      row.circularity = c;
    }
    if (ef) {
      set('major', ef.majorCal); set('minor', ef.minorCal); set('angle', ef.angle);
      // "AR = stats.major/stats.minor; ROUNDNESS = 4.0*stats.area/(Math.PI*stats.major*stats.major)"
      set('aspectRatio', ef.majorCal / ef.minorCal);
      set('roundness', 4.0 * st.area / (Math.PI * ef.majorCal * ef.majorCal));
      if (want.has('solidity')) {
        // "double convexArea = roi!=null?getArea(roi.getConvexHull()):stats.pixelCount;  SOLIDITY: stats.pixelCount/convexArea"
        let convexArea = n;
        if (roi) { const v = roiVertices(roi); convexArea = hullAreaRounded(convexHull(v.xs, v.ys)); }
        row.solidity = n / convexArea;
      }
    }
    if (want.has('bx') || want.has('by') || want.has('bw') || want.has('bh')) {
      set('bx', rect.x * pw); set('by', rect.y * ph); set('bw', rect.w * pw); set('bh', rect.h * ph);
    }
    if (want.has('feret') || want.has('feretX') || want.has('feretY') || want.has('feretAngle') || want.has('minFeret')) {
      const f = feretValues(roi, pw, ph, W, H);
      set('feret', f ? f.feret : NaN); set('feretX', f ? f.x : NaN); set('feretY', f ? f.y : NaN);
      set('feretAngle', f ? f.angle : NaN); set('minFeret', f ? f.min : NaN);
    }
    if (want.has('areaFraction')) row.areaFraction = img.lum ? 0 : areaFraction(img, rect, mask, a.thr);
    // Analyzer.saveResults: "rt.addValue(MIN_THRESHOLD, stats.lowerThreshold)" and ImageStatistics: "public double
    // lowerThreshold = Double.NaN;" — only saveThreshold (limited AND thresholded) sets it.
    if (a.limit) { set('minThreshold', a.thr ? a.thr.lower : NaN); set('maxThreshold', a.thr ? a.thr.upper : NaN); }
    return row;
  }
  function defaultThreshold(bd) { return bd === 8 ? { lower: 0, upper: 255 } : bd === 16 ? { lower: 0, upper: 65535 } : { lower: -3.4028234663852886e38, upper: 3.4028234663852886e38 }; }

  /* calculateAreaFraction: the share of the selection that is thresholded, or non-zero without a threshold.
   *   ShortStatistics / ByteStatistics: "int t1 = (int)Math.round(ip.getMinThreshold()); ... if (i>=t1 && i<=t2) sum += hist[i];"
   *   "if (t1==NO_THRESHOLD) { ... sum = total - hist[0]; }"  (total = every pixel of the selection)
   *   FloatStatistics: "float t1 = (float)ip.getMinThreshold(); ... if (noThresh) { if (v!=0f) sum++; } else if (v>=t1 && v<=t2) sum++;" */
  /* ColorStatistics.calculateMoments: v = ip.getPixelValue(x, y) (a float), v2 = v*v, sums of v, v^2, v^3, v^4 over the mask, then
   *   variance = sum2/n - mean^2;  skewness = ((sum3 - 3 mean sum2)/n + 2 mean mean^2) / (variance sd);
   *   kurtosis = (((sum4 - 4 mean sum3 + 6 mean^2 sum2)/n - 3 mean^4) / variance^2) - 3     with the HISTOGRAM mean. */
  function colorMoments(lum, W, rect, mask, mean, n) {
    let sum2 = 0, sum3 = 0, sum4 = 0;
    for (let y = 0; y < rect.h; y++) {
      const row = (rect.y + y) * W + rect.x, mrow = y * rect.w;
      for (let x = 0; x < rect.w; x++) {
        if (mask && !mask[mrow + x]) continue;
        const v = lum[row + x], v2 = v * v;
        sum2 += v2; sum3 += v * v2; sum4 += v2 * v2;
      }
    }
    const mean2 = mean * mean, variance = sum2 / n - mean2, sd = Math.sqrt(variance);
    return {
      skewness: ((sum3 - 3.0 * mean * sum2) / n + 2.0 * mean * mean2) / (variance * sd),
      kurtosis: (((sum4 - 4.0 * mean * sum3 + 6.0 * mean2 * sum2) / n - 3.0 * mean2 * mean2) / (variance * variance) - 3.0)
    };
  }

  function areaFraction(img, rect, mask, thr) {
    const d = img.data, W = img.width, f32 = img.bitDepth === 32;
    let sum = 0, total = 0;
    let t1 = 0, t2 = 0;
    if (thr) { if (f32) { t1 = fr(thr.lower); t2 = fr(thr.upper); } else { t1 = jround(thr.lower); t2 = jround(thr.upper); } }
    for (let j = 0; j < rect.h; j++) {
      const row = (rect.y + j) * W + rect.x;
      for (let i = 0; i < rect.w; i++) {
        if (mask && !mask[j * rect.w + i]) continue;
        const v = d[row + i];
        total++;
        if (!thr) { if (v !== 0) sum++; } else if (v >= t1 && v <= t2) sum++;
      }
    }
    return sum * 100.0 / total;
  }

  /* Analyzer.measureLength — a straight or segmented line. "if ((measurements&(AREA+MEAN+STD_DEV+MODE+MIN_MAX+
   * CENTROID+MEDIAN))==0) { Length, Angle only }". Otherwise the statistics are those of the PROFILE values as a
   * 1 × n float image ("ip2 = new FloatProcessor(values.length, 1, values)", so Area = n·pw·ph), or — for a line
   * wider than a pixel — of the area the line covers (Roi.convertLineToArea). */
  function measureLine(a) {
    const img = a.img, W = img.width, H = img.height;
    const { pw, ph } = calOf(a.cal);
    const calibration = { pixelWidth: pw, pixelHeight: ph };
    const want = new Set(a.keys || []);
    const roi = a.roi;
    const row = {};
    const length = perimeter(roi, pw, ph);
    const statKeys = ['area', 'mean', 'stdDev', 'mode', 'min', 'max', 'xCentroid', 'yCentroid', 'median'];
    const needStats = statKeys.some((k) => want.has(k));
    // "if ((measurements&(AREA+MEAN+STD_DEV+MODE+MIN_MAX+CENTROID+MEDIAN))==0) { rt.addValue("Length", ...); Angle; return; }"
    if (!needStats) {
      row.length = length;
      if (roi.type === 'line') row.angle = lineAngleCal(roi.x1, roi.y1, roi.x2, roi.y2, pw, ph);
      return row;
    }
    if (needStats) {
      const lineWidth = jround(roi.width || 1);
      let st;
      if (lineWidth > 1) {
        let m;
        if (roi.type === 'line') m = IJRoi.mask({ type: 'line', x1: roi.x1, y1: roi.y1, x2: roi.x2, y2: roi.y2, width: lineWidth }, W, H);
        else {
          const full = polylineAreaMask(roi.points, lineWidth, W, H);
          m = IJRoi.fromMask(full, W, H);
          m = IJRoi.mask(m, W, H);
        }
        if (!(m.w > 0 && m.h > 0)) throw fail('IJ_EMPTY_ROI', 'the line is outside the image');
        const eff = a.limit && a.thr ? limitMask(img, m, m.data, a.thr) : m.data;
        st = IJOps.statistics(img, { x: m.x, y: m.y, w: m.w, h: m.h, data: eff }, { calibration });
      } else {
        const vals = profile(img, roi);
        // "if (limit!=0) ip2 = convertToOriginalDepth(imp2, ip2);" — convertToByte(false) / convertToShort(false): the
        // value + 0.5 truncated, clamped to the type's range (an 8 / 16-bit image only)
        let f, bdp = 32;
        if (a.limit && (img.bitDepth === 8 || img.bitDepth === 16)) {
          const hi = img.bitDepth === 8 ? 255 : 65535;
          f = img.bitDepth === 8 ? new Uint8Array(vals.length) : new Uint16Array(vals.length);
          for (let i = 0; i < vals.length; i++) { const v = vals[i]; f[i] = v < 0 ? 0 : v > hi ? hi : Math.floor(v + 0.5); }
          bdp = img.bitDepth;
        } else f = Float32Array.from(vals);
        const pimg = { width: f.length, height: 1, bitDepth: bdp, data: f };
        let box = null;
        if (a.limit && a.thr) box = { x: 0, y: 0, w: f.length, h: 1, data: limitMask(pimg, { x: 0, y: 0, w: f.length, h: 1 }, null, a.thr) };
        st = IJOps.statistics(pimg, box, { calibration });
      }
      for (const k of ['area', 'mean', 'stdDev', 'mode', 'min', 'max', 'median']) if (want.has(k)) row[k] = st[k];
      // "if ((roi instanceof Line) && (measurements&CENTROID)!=0) { xCentroid = the mid point }"; else the statistics' 0
      if (want.has('xCentroid') || want.has('yCentroid')) {
        if (roi.type === 'line') { row.xCentroid = (roi.x1 + (roi.x2 - roi.x1) / 2.0) * pw; row.yCentroid = (roi.y1 + (roi.y2 - roi.y1) / 2.0) * ph; } else { row.xCentroid = 0; row.yCentroid = 0; }
      }
    }
    if (want.has('perim')) row.perim = length;
    if (want.has('bx') || want.has('by') || want.has('bw') || want.has('bh')) {
      const b = IJRoi.bounds(roi);
      if (want.has('bx')) row.bx = b.x * pw; if (want.has('by')) row.by = b.y * ph; if (want.has('bw')) row.bw = b.w * pw; if (want.has('bh')) row.bh = b.h * ph;
    }
    row.length = length;
    if (roi.type === 'line') row.angle = lineAngleCal(roi.x1, roi.y1, roi.x2, roi.y2, pw, ph);
    if (a.limit) { if (want.has('minThreshold')) row.minThreshold = a.thr ? a.thr.lower : NaN; if (want.has('maxThreshold')) row.maxThreshold = a.thr ? a.thr.upper : NaN; }
    return row;
  }

  /* Analyzer.measurePoint: one row per point.
   *   "ip.setRoi((int)Math.round(p.xpoints[i]), (int)Math.round(p.ypoints[i]), 1, 1);"  — ImageJ's point coordinates
   *   are pixel indices; this view marks pixel (i, j) by its centre (i + ½, j + ½), so the pixel read is floor(x),
   *   floor(y) (= round of the index coordinate) and the reported X / Y are the index coordinates, calibrated:
   *   "rt.addValue("X", cal.getX(x)); rt.addValue("Y", cal.getY(y, imp.getHeight()));", "AREA: rt.addValue(AREA, 0)". */
  function measurePoints(a) {
    const img = a.img, W = img.width, H = img.height;
    const { pw, ph } = calOf(a.cal);
    const calibration = { pixelWidth: pw, pixelHeight: ph };
    const want = new Set(a.keys || []);
    const rows = [];
    for (const p of a.roi.points) {
      const ix = Math.floor(p[0]), iy = Math.floor(p[1]);
      if (ix < 0 || iy < 0 || ix >= W || iy >= H) throw fail('IJ_EMPTY_ROI', 'a point is outside the image');
      const st = IJOps.statistics(img, { x: ix, y: iy, w: 1, h: 1, data: Uint8Array.of(1) }, { calibration });
      const row = {};
      const set = (k, v) => { if (want.has(k)) row[k] = v; };
      const x = p[0] - 0.5, y = p[1] - 0.5;
      set('area', 0); set('mean', st.mean); set('stdDev', st.stdDev); set('mode', st.mode); set('min', st.min); set('max', st.max);
      set('median', st.median); set('intDen', st.area * st.mean); set('rawIntDen', st.mean);
      // "stats.xCenterOfMass = p.xpoints[i];" — the raw pixel coordinate, saveResults does not calibrate it
      set('xCenterOfMass', x); set('yCenterOfMass', y);
      row.xCentroid = x * pw; row.yCentroid = y * ph;           // "X" / "Y" of savePoints, always present
      rows.push(row);
    }
    return rows;
  }

  function measureAngle(a) {
    const { pw, ph } = calOf(a.cal);
    return { angle: angleOf(a.roi.points, pw, ph) };
  }

  // ================================================================================================
  // Selections — RoiEnlarger, Selection.createMask, ThresholdToSelection
  // ================================================================================================

  /* RoiEnlarger.enlarge255 — what Edit > Selection > Enlarge runs for |n| < 256:
   *   rect / oval: "bounds.x -= n; ... width += 2*n" (a result of no width is the unchanged selection)
   *   n > 0: "ip.invert(); roi.setLocation(n+1, n+1); ip.setColor(0); ip.fill(roi); new EDM().toEDM(ip);
   *           ip.setThreshold(0, n); roi2 = new ThresholdToSelection().convert(ip);"
   *   n < 0: "ip.setColor(255); ip.fill(roi); toEDM(ip); ip.setThreshold(n+1, 255); ..."  (null result: the selection stays)
   * EDM.toEDM = "ip.setPixels(0, makeFloatEDM(ip, 0, false))": a byte is "(int)(float + 0.5f)" clamped to 255.
   * The pixels of the result are those of the padded buffer, moved back by the padding. Returns the new selection
   * (a rect, or a mask) or the argument itself when nothing changes. */
  function enlarge(roi, pixels, W, H, io, o) {
    if (!IJRoi.isArea(roi)) throw fail('IJ_NEEDS_ROI', 'an area selection is needed');
    if (pixels === 0) return roi;
    const n = jround(pixels);
    if (n === 0) return roi;
    if (roi.type === 'rect' || roi.type === 'oval') {
      const w = roi.w + 2 * n, h = roi.h + 2 * n;
      if (w <= 0 || h <= 0) return roi;
      return { type: roi.type, x: roi.x - n, y: roi.y - n, w, h };
    }
    // "Roi roi2 = Math.abs(n)<256?enlarge255(roi,n):enlarge(roi,n);" — the float EDM path (no rounding to bytes) beyond 255
    const exact = o && o.exact !== undefined ? !!o.exact : Math.abs(pixels) >= 256;
    const m = IJRoi.mask(roi); // unclipped: the selection may leave the image
    if (!(m.w > 0 && m.h > 0)) throw fail('IJ_EMPTY_ROI', 'empty selection');
    const pad = n > 0 ? n + 1 : 1;
    const bw = m.w + 2 * pad, bh = m.h + 2 * pad;
    if (bw * bh > 268435456) throw fail('IJ_ROI_TOO_COMPLEX', 'the enlarged selection is too large');
    const buf = new Uint8Array(bw * bh);
    if (n > 0) {
      buf.fill(255);
      for (let j = 0; j < m.h; j++) for (let i = 0; i < m.w; i++) if (m.data[j * m.w + i]) buf[(j + pad) * bw + i + pad] = 0;
    } else {
      for (let j = 0; j < m.h; j++) for (let i = 0; i < m.w; i++) if (m.data[j * m.w + i]) buf[(j + pad) * bw + i + pad] = 255;
    }
    if (io) io.check();
    const edm = IJShared.makeFloatEDM(buf, bw, bh);
    const out = new Uint8Array(bw * bh);
    if (exact) {
      // enlarge(): "edm.setThreshold(0, n)" / shrink: "edm.setThreshold(n+1, Float.MAX_VALUE)"
      const lo = n > 0 ? 0 : -n + 1, hi = n > 0 ? n : 3.4028234663852886e38;
      for (let i = 0; i < edm.length; i++) { const v = edm[i]; if (v >= lo && v <= hi) out[i] = 255; }
    } else {
      const lo = n > 0 ? 0 : -n + 1, hi = n > 0 ? n : 255;
      for (let i = 0; i < edm.length; i++) {
        let v = fr(edm[i] + 0.5);
        if (v < 0) v = 0; if (v > 255) v = 255;
        v = jint(v);
        if (v >= lo && v <= hi) out[i] = 255;
      }
    }
    if (io) io.check();
    const r = IJShared.maskToRoi(out, bw, bh);
    if (!r) return roi;                                   // "if (roi2==null) return roi;"
    return IJRoi.translate(r, m.x - pad, m.y - pad);      // the buffer's origin in image coordinates
  }

  /** The 8-bit mask of an area selection: 255 inside (ImagePlus.createRoiMask: "mask.setColor(255); mask.fill(roi)"). */
  function roiMask255(roi, W, H) {
    const out = new Uint8Array(W * H);
    const m = IJRoi.mask(roi, W, H);
    for (let j = 0; j < m.h; j++) for (let i = 0; i < m.w; i++) if (m.data[j * m.w + i]) out[(m.y + j) * W + m.x + i] = 255;
    return out;
  }

  // ================================================================================================
  // Operations
  // ================================================================================================

  function channelOf(view, io) {
    const c = Number.isInteger(io && io.channel) ? io.channel : (view.active || 0);
    if (!Number.isInteger(c) || c < 0 || c >= view.channels.length) throw fail('IJ_BAD_ARGS', 'channel');
    return c;
  }

  IJOpRegistry.define('wand', {
    kind: 'compute', version: 1, stack: 'plane', rgb: 'gray', channels: 'one', roi: 'ignore', preview: false,
    validate(p, info) {
      if (!Number.isInteger(p.x) || !Number.isInteger(p.y)) throw fail('IJ_BAD_ARGS', 'wand point');
      if (p.x < 0 || p.y < 0 || p.x >= info.width || p.y >= info.height) throw fail('IJ_BAD_ARGS', 'wand point outside');
      if (p.connectivity !== 4 && p.connectivity !== 8) throw fail('IJ_BAD_ARGS', 'wand connectivity');
      if (p.tolerance !== undefined && !(finite(p.tolerance) && p.tolerance >= 0)) throw fail('IJ_BAD_ARGS', 'wand tolerance');
      if ((p.lower === undefined) !== (p.upper === undefined)) throw fail('IJ_BAD_ARGS', 'wand threshold');
    },
    scratchBytes: (info) => Math.min(info.width * info.height, MAX_VERTS) * 24 + 65536,
    async run(view, p, roi, io) {
      const c = channelOf(view, io);
      const img = { data: view.channels[c].data, width: view.width, height: view.height };
      io.check();
      const pts = wandOutline(img, p.x, p.y, { tolerance: p.tolerance || 0, mode: p.connectivity, lower: p.lower, upper: p.upper });
      io.check();
      return pts ? { points: pts } : null;
    }
  });

  /* Edit > Selection > Fit Ellipse (Selection.createEllipse): "dx = stats.major*Math.cos(angle)/2; dy = -stats.major*
   * Math.sin(angle)/2; new EllipseRoi(x1, y1, x2, y2, stats.minor/stats.major)" — statistics taken in pixels. The result
   * is a 72-vertex polygon that remembers its ellipse (perimeter = edge sum, Feret from the axes, as EllipseRoi). */
  IJOpRegistry.define('fitEllipse', {
    kind: 'compute', version: 1, stack: 'plane', rgb: 'gray', channels: 'one', roi: 'ignore', preview: false,
    validate() {},
    scratchBytes(info) { const r = info.roi, b = r && IJRoi.isArea(r) ? IJRoi.bounds(r) : { w: info.width, h: info.height }; return b.w * b.h * 2 + 65536; },
    async run(view, p, roi, io) {
      if (!roi || !IJRoi.isArea(roi)) throw fail('IJ_NEEDS_ROI', 'an area selection is needed');
      io.check();
      const box = roiMaskBox(roi, view.width, view.height);
      if (!(box.w > 0 && box.h > 0)) throw fail('IJ_EMPTY_ROI', 'empty selection');
      io.check();
      const ef = fitEllipse(roi.type === 'rect' ? null : box.data, { x: box.x, y: box.y, w: box.w, h: box.h });
      const dx = ef.major * Math.cos(ef.angle / 180.0 * Math.PI) / 2.0;
      const dy = -ef.major * Math.sin(ef.angle / 180.0 * Math.PI) / 2.0;
      const x1 = ef.xCenter - dx, y1 = ef.yCenter - dy, x2 = ef.xCenter + dx, y2 = ef.yCenter + dy, aspect = ef.minor / ef.major;
      return { roi: { type: 'polygon', points: ellipsePolygon(x1, y1, x2, y2, aspect), ellipse: { x1, y1, x2, y2, aspect } } };
    }
  });

  /* Edit > Selection > Convex Hull: "FloatPolygon p = roi.getFloatConvexHull(); … new PolygonRoi(p, Roi.POLYGON)". */
  IJOpRegistry.define('convexHull', {
    kind: 'compute', version: 1, stack: 'plane', rgb: 'gray', channels: 'one', roi: 'ignore', preview: false,
    validate() {},
    scratchBytes(info) { return Math.min(info.width * info.height, MAX_VERTS) * 32 + 65536; },
    async run(view, p, roi, io) {
      if (!roi || roi.type === 'line' || roi.type === 'angle') throw fail('IJ_NEEDS_ROI', 'a selection is needed');
      io.check();
      const v = roiVertices(roi);
      io.check();
      const h = convexHull(v.xs, v.ys);
      if (h.xs.length < 3) return { roi: null };
      return { roi: { type: 'polygon', points: h.xs.map((x, i) => [x, h.ys[i]]) } };
    }
  });

  IJOpRegistry.define('enlargeRoi', {
    kind: 'compute', version: 1, stack: 'plane', rgb: 'gray', channels: 'one', roi: 'ignore', preview: false,
    validate(p) { if (!finite(p.n) || Math.abs(p.n) > 100000) throw fail('IJ_BAD_ARGS', 'enlarge distance'); },
    scratchBytes(info, p) {
      const r = info.roi, b = r && IJRoi.isArea(r) ? IJRoi.bounds(r) : { w: info.width, h: info.height };
      const n = Math.abs(Math.round(p.n || 0));
      return (b.w + 2 * n + 2) * (b.h + 2 * n + 2) * 7 + 65536;
    },
    async run(view, p, roi, io) {
      if (!roi || !IJRoi.isArea(roi)) throw fail('IJ_NEEDS_ROI', 'an area selection is needed');
      io.check();
      const out = enlarge(roi, p.n, view.width, view.height, io, { exact: p.exact });
      return { roi: out, unchanged: out === roi };
    }
  });

  /* Create Selection: "if (ip.isThreshold()) { ThresholdToSelection } if (!ip.isBinary()) error;
   *  int threshold = ip.isInvertedLut()?255:0; if (Prefs.blackBackground) threshold = (threshold==255)?0:255;"
   * so the 255 pixels of a mask on a normal LUT (the 0 pixels on an inverting one). */
  IJOpRegistry.define('createSelection', {
    kind: 'compute', version: 1, stack: 'plane', rgb: 'gray', channels: 'one', roi: 'ignore', preview: false,
    validate(p) {
      if (p.binary) return;
      if (!finite(p.lower) || !finite(p.upper) || p.lower > p.upper) throw fail('IJ_BAD_ARGS', 'threshold');
    },
    scratchBytes: (info) => info.width * info.height * 3 + 65536,
    async run(view, p, roi, io) {
      const c = channelOf(view, io);
      const ch = view.channels[c];
      let lower = p.lower, upper = p.upper;
      if (p.binary) {
        if (view.bitDepth !== 8) throw fail('IJ_ROI_NOT_MASK', 'not a mask');
        const d = ch.data;
        for (let i = 0; i < d.length; i++) if (d[i] !== 0 && d[i] !== 255) throw fail('IJ_ROI_NOT_MASK', 'not a mask');
        const level = ch.display && ch.display.invert ? 0 : 255;
        lower = level; upper = level;
      }
      io.check();
      const m = IJShared.thresholdMask(ch, lower, upper);
      io.check();
      return { roi: IJShared.maskToRoi(m, view.width, view.height) };
    }
  });

  /* Selection.createMask: "mask = imp.createRoiMask()" (255 inside the selection) or, without an area selection,
   * "imp.createThresholdMask()" (255 inside the threshold). The new image is "Mask" / "mask", calibrated as the source. */
  IJOpRegistry.define('createMask', {
    kind: 'newdoc', version: 1, stack: 'plane', rgb: 'gray', channels: 'one', roi: 'ignore', preview: false,
    validate(p) {
      if (p.source === 'threshold') { if (!finite(p.lower) || !finite(p.upper) || p.lower > p.upper) throw fail('IJ_BAD_ARGS', 'threshold'); } else if (p.source !== 'roi') throw fail('IJ_BAD_ARGS', 'source');
    },
    scratchBytes: (info) => info.width * info.height * 2 + 65536,
    async run(view, p, roi, io) {
      const W = view.width, H = view.height;
      let data, name;
      if (p.source === 'roi') {
        if (!roi || !IJRoi.isArea(roi)) throw fail('IJ_NEEDS_ROI', 'an area selection is needed');
        data = roiMask255(roi, W, H); name = 'Mask';
      } else {
        const c = channelOf(view, io);
        data = IJShared.thresholdMask(view.channels[c], p.lower, p.upper); name = 'mask';
      }
      io.check();
      const doc = { name, width: W, height: H, bitDepth: 8, channels: [{ name, color: '#ffffff', data }] };
      if (view.calibration) doc.calibration = Object.assign({}, view.calibration);
      return [doc];
    }
  });

  root.IJRoiTools = {
    wandOutline, ovalPolygon, roiVertices, convexHull, hullAreaRounded, feretValues, fitEllipse, ellipsePolygon,
    perimeter, polyLength, lineAngleCal, angleOf, interpolatedValue, lineSamples, irregularProfile, profile, polylineAreaMask, wideProfile,
    roiMaskBox, roiBounds, maskOutlines, maskPerimeter, measureArea, measureLine, measurePoints, measureAngle, areaFraction, enlarge, roiMask255, polygonContains, defaultThreshold
  };
})(typeof self !== 'undefined' ? self : globalThis);
