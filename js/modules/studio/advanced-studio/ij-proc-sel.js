/* ij-proc-sel.js — package sel (wave 3): Edit > Selection > Fit Spline, Fit Circle, Fit Rectangle, Interpolate, Scale, Rotate,
 * Translate, Make Band, Straighten, Line to Area, Area to Line.
 *
 * Classic script, page AND worker (ij-worker.js loads it in its own try/catch). Pure: no DOM, no engine globals. The geometry
 * lives in `IJSelOps` (page-pure: the commands of ij-cmds-sel.js call it directly); the work that reads pixels or allocates
 * image-sized buffers is registered as operations of the worker:
 *
 *   makeBand    compute  Edit > Selection > Make Band            ij.plugin.Selection.makeBand
 *   lineToArea  compute  Edit > Selection > Line to Area         ij.gui.Roi.convertLineToArea
 *   straighten  newdoc   Edit > Selection > Straighten           ij.plugin.Straightener.straightenLine
 *
 *   IJSelOps.fitSpline(roi) / fitCircle(roi, W, H) / fitRectangle(roi) / interpolate(roi, interval, smooth, adjust)
 *   IJSelOps.scale(roi, xscale, yscale, centered, W, H) / rotate(roi, angle, aroundImageCenter, W, H) / translate(roi, dx, dy)
 *   IJSelOps.areaToLine(roi, W, H) / lineToArea(roi) / makeBand(roi, n, W, H, ctl) / straightenPlanes(img, roi, width)
 *   Each returns the new selection (or { roi, unchanged } when ImageJ leaves the selection as it was) and throws an Error whose
 *   `code` is IJ_SEL_* (mapped to err.sel* sentences by ij-cmds-sel.js). Every transformed selection keeps `roi.name`.
 *
 * Source map (ImageJ 1.54p, ij/ prefix; the quoted trap lines sit next to each port):
 *   plugin/Selection.java    fitSpline :237 · interpolate :266 (composite test :288, type rules :301-312) · trimPolygon :338 (relative
 *                            coordinates :339-340, "+ r.x" :352-366) · rodbard :378 · smooth(int[]) :395 · smooth(float[]) :421 ·
 *                            getCurvature :439/:499 · lineToArea :685/:696 · areaToLine :700-731 · makeBand :879 · fitCircle :119 ·
 *                            fitRectangle :965 ("At least three points are required" :978) · translate :1069
 *   plugin/RoiScaler.java    scale :55 · scaleShape :123      plugin/RoiRotator.java  rotate :61 / :74
 *   plugin/Straightener.java run :12 · straighten :90 · straightenLine :126 · rotateLine :204
 *   gui/Roi.java             getInterpolatedPolygon :626/:639 · getRotationCenter :2680 · convertLineToArea :2751 · setLocation :273
 *   gui/PolygonRoi.java      fitSpline :926/:996 · fitSplineForStraightening :1022 · getInterpolatedPolygon :1605
 *   gui/EllipseRoi.java      FREEROI (:19) · makePolygonRelative (integer bounds)      measure/SplineFitter.java :15
 *
 * Reference: ImageJ 1.54p (public domain) — ij.plugin.{Selection, RoiScaler, RoiRotator, Straightener}, ij.gui.{Roi,
 * PolygonRoi, RotatedRectRoi, OvalRoi, Wand}, ij.measure.SplineFitter, ij.process.{FloatPolygon, PolygonFiller}. Every port cites
 * its Class.method and quotes the lines that settle a trap. Java `float` arithmetic is reproduced with Math.fround at the same
 * places (the polygon of a selection is a float array in ImageJ); coordinates are ImageJ's (a vertex is the top-left CORNER of a
 * pixel, a line / polyline vertex is a pixel-centre coordinate).
 *
 * How ImageJ's selection TYPES map onto this Studio's selections (a selection is { type, … } of ij-core.js):
 *   rect → RECTANGLE · oval → OVAL · polygon → POLYGON, TRACED_ROI when `traced: true` (the Wand and the particle outlines), FREEROI when `ellipse` is set (EllipseRoi, Fit Ellipse) ·
 *   freehand → FREEROI · polyline → POLYLINE, or FREELINE when `freeline: true` · line → LINE · angle → ANGLE · point → POINT ·
 *   mask → COMPOSITE (a ShapeRoi). A spline-fitted polygon / polyline keeps `spline: true` and its fitted nodes in `nodes`
 *   (PolygonRoi keeps xpf next to xSpline: "Straighten" and a second "Fit Spline" start from the nodes, not from the curve);
 *   a rotated rectangle keeps `rotRectWidth`; the rotation centre of a rotated selection is kept in `rotationCenter`.
 *   Those flags do not enter IJRoi.hash (ij-core.js): two selections that differ only by a flag share a journal body (reported).
 */
(function (root) {
  'use strict';

  const IJRoi = root.IJRoi, IJOpRegistry = root.IJOpRegistry, IJShared = root.IJShared, IJRoiTools = root.IJRoiTools;
  if (!IJRoi || !IJOpRegistry || !IJShared || !IJRoiTools) throw Object.assign(new Error('ij-proc-sel needs ij-core, ij-proc-shared and ij-proc-roi'), { code: 'IJ_MODULE_MISSING' });

  const fr = Math.fround;
  const jround = (v) => Math.floor(v + 0.5);                   // java.lang.Math.round(double) / round(float)
  const jint = (v) => (v < 0 ? Math.ceil(v) : Math.floor(v));  // (int) cast
  const MAX_VERTS = IJRoi.MAX_VERTS;
  const SQ = Math.sqrt;
  function fail(code, msg) { const e = new Error(msg || code); e.code = code; return e; }
  function finite(v) { return typeof v === 'number' && isFinite(v); }
  const FLOAT_ZERO_THOUSANDTH = fr(0.001);

  const AREA_KINDS = new Set(['rect', 'oval', 'polygon', 'traced', 'freehand', 'composite']);
  const LINE_KINDS = new Set(['line', 'polyline', 'freeline', 'angle']); // Roi.isLine(): LINE … ANGLE

  /* The ImageJ type of a selection (see the header). */
  function kindOf(roi) {
    switch (roi.type) {
      case 'rect': return 'rect';
      case 'oval': return 'oval';
      case 'polygon': return roi.traced ? 'traced' : roi.ellipse ? 'freehand' : 'polygon'; // EllipseRoi.java:19 super(…, FREEROI)
      case 'freehand': return 'freehand';
      case 'polyline': return roi.freeline ? 'freeline' : 'polyline';
      case 'line': return 'line';
      case 'angle': return 'angle';
      case 'point': return 'point';
      case 'mask': return 'composite';
      default: throw fail('IJ_BAD_ROI', 'type');
    }
  }
  const isAreaKind = (k) => AREA_KINDS.has(k);
  const isLineKind = (k) => LINE_KINDS.has(k);

  function copyName(src, dst) { if (src && typeof src.name === 'string') dst.name = src.name; return dst; }

  /* Roi.getFloatPolygon(): rectangles give their corners, ovals the flattened ellipse (OvalRoi.getFloatPolygon), polygons /
   * lines their vertices. Float values. A mask (ShapeRoi) has no single polygon: the callers take its outlines. */
  function floatPolygon(roi) {
    switch (roi.type) {
      case 'rect': {
        const x0 = fr(roi.x), y0 = fr(roi.y), x1 = fr(roi.x + roi.w), y1 = fr(roi.y + roi.h);
        return { xs: [x0, x1, x1, x0], ys: [y0, y0, y1, y1] };
      }
      case 'oval': { const v = IJRoiTools.roiVertices(roi); return { xs: v.xs.slice(), ys: v.ys.slice() }; }
      case 'line': return { xs: [fr(roi.x1), fr(roi.x2)], ys: [fr(roi.y1), fr(roi.y2)] };
      case 'mask': throw fail('IJ_SEL_COMPOSITE', 'composite');
      default: return { xs: roi.points.map((p) => fr(p[0])), ys: roi.points.map((p) => fr(p[1])) };
    }
  }

  /* A new PolygonRoi of a given ImageJ type from float vertices. */
  function makePoly(kind, xs, ys, src, raw) {
    // PolygonRoi(float[], float[], n, type): finishPolygon() stores the vertices relative to the float origin ("xpf[i] -=
    // (float)bounds.x") and getFloatPolygon() adds it back ("xpf[i] + xbase"): two float roundings, exact only on the grid of
    // the origin. The vertices of the selection are what that round trip returns.
    const n = xs.length;
    let bx = Infinity, by = Infinity;
    for (let i = 0; i < n; i++) { const x = fr(xs[i]), y = fr(ys[i]); if (x < bx) bx = x; if (y < by) by = y; }
    const points = new Array(n);
    for (let i = 0; i < n; i++) points[i] = raw ? [fr(xs[i]), fr(ys[i])] : [fr(fr(fr(xs[i]) - bx) + bx), fr(fr(fr(ys[i]) - by) + by)];
    let o;
    switch (kind) {
      case 'polygon': o = { type: 'polygon', points }; break;
      case 'traced': o = { type: 'polygon', points, traced: true }; break;
      case 'freehand': o = { type: 'freehand', points }; break;
      case 'polyline': o = { type: 'polyline', points }; break;
      case 'freeline': o = { type: 'polyline', points, freeline: true }; break;
      case 'angle': o = { type: 'angle', points }; break;
      case 'point': o = { type: 'point', points }; break;
      default: throw fail('IJ_BAD_ARGS', 'kind');
    }
    return copyName(src, o);
  }

  const pairs = (xs, ys) => xs.map((x, i) => [x, ys[i]]);

  // ================================================================================================
  // Lengths — PolygonRoi.getLength() without calibration (what getUncalibratedLength returns)
  // ================================================================================================

  /* PolygonRoi.isTraced: "if (type==TRACED_ROI) return true; else if (type!=POLYGON || (this instanceof RotatedRectRoi)) return
   * false; … for all i: if (!((xp[nexti]-xp[i])==0||(yp[nexti]-yp[i])==0)) return false" (integer vertices, axis-parallel edges). */
  function isTracedPoly(kind, xs, ys, rot) {
    if (kind === 'traced') return true;
    if (kind !== 'polygon' || rot) return false;
    const n = xs.length;
    for (let i = 0; i < n; i++) {
      const nx = i + 1 === n ? 0 : i + 1;
      if (!((xs[nx] - xs[i]) === 0 || (ys[nx] - ys[i]) === 0)) return false;
      if (!(Number.isInteger(xs[i]) && Number.isInteger(ys[i]))) return false;
    }
    return true;
  }

  /* PolygonRoi.getSmoothedLineLength: "dx = (xp[0]+xp[1]+xp[2])/3.0-xp[0]; … dx = (xp[i+2]-xp[i-1])/3.0; … dx =
   * xp[nPoints-1]-(xp[nPoints-3]+xp[nPoints-2]+xp[nPoints-1])/3.0" (the float variant adds in float, the int one exactly). */
  function smoothedLineLength(xs, ys) {
    const n = xs.length;
    let length = 0, dx, dy;
    dx = fr(fr(xs[0] + xs[1]) + xs[2]) / 3.0 - xs[0];
    dy = fr(fr(ys[0] + ys[1]) + ys[2]) / 3.0 - ys[0];
    length += SQ(dx * dx + dy * dy);
    for (let i = 1; i < n - 2; i++) {
      dx = fr(xs[i + 2] - xs[i - 1]) / 3.0;
      dy = fr(ys[i + 2] - ys[i - 1]) / 3.0;
      length += SQ(dx * dx + dy * dy);
    }
    dx = xs[n - 1] - fr(fr(xs[n - 3] + xs[n - 2]) + xs[n - 1]) / 3.0;
    dy = ys[n - 1] - fr(fr(ys[n - 3] + ys[n - 2]) + ys[n - 1]) / 3.0;
    length += SQ(dx * dx + dy * dy);
    return length;
  }

  function plainLength(xs, ys, close) {
    const n = xs.length;
    if (n < 2) return 0;
    let length = 0;
    for (let i = 0; i < n - 1; i++) { const dx = fr(xs[i + 1] - xs[i]), dy = fr(ys[i + 1] - ys[i]); length += SQ(dx * dx + dy * dy); }
    if (close) { const dx = fr(xs[0] - xs[n - 1]), dy = fr(ys[0] - ys[n - 1]); length += SQ(dx * dx + dy * dy); }
    return length;
  }

  /* PolygonRoi.getLength(imp = null): "if (isTraced()) return getTracedPerimeter(imp); if (nPoints>2) { if (type==FREEROI) return
   * getSmoothedPerimeter(imp); else if (type==FREELINE && !(width==0 || height==0)) return getSmoothedLineLength(imp); }
   * boolean closeShape = isArea(); if (xSpline!=null) return getLength(xSpline, …)". `spline` = the polygon of a spline fit. */
  function polyLength(kind, xs, ys, rot) {
    const n = xs.length;
    if (isTracedPoly(kind, xs, ys, rot)) return IJRoi.tracedPerimeter(pairs(xs, ys), 1, 1);
    if (n > 2) {
      if (kind === 'freehand') { const dx = fr(xs[n - 1] - xs[0]), dy = fr(ys[n - 1] - ys[0]); return smoothedLineLength(xs, ys) + SQ(dx * dx + dy * dy); }
      if (kind === 'freeline') return smoothedLineLength(xs, ys);
    }
    return plainLength(xs, ys, isAreaKind(kind));
  }

  // ================================================================================================
  // SplineFitter and PolygonRoi.getSpline — ij.measure.SplineFitter (Katrukha, after Hornbeck), ij.gui.PolygonRoi
  // ================================================================================================

  /* new SplineFitter(float[] x, float[] y, n, closed). "For closed curves … a periodic continuation with a few [points] will be
   * used at both ends": EXTEND_BY = 7 (n-1 when fewer points). The arrays hold float values. */
  function splineFitter(x, y, n, closed) {
    if (closed) {
      let extendBy = 7;
      if (extendBy >= n) extendBy = n - 1;
      const n2 = n + 2 * extendBy;
      const xx = new Array(n2), yy = new Array(n2);
      for (let i = 0; i < extendBy; i++) { xx[i] = fr(x[n - (extendBy - i + 1)] - x[n - 1]); yy[i] = y[n - (extendBy - i + 1)]; }
      for (let i = extendBy; i < extendBy + n; i++) { xx[i] = x[i - extendBy]; yy[i] = y[i - extendBy]; }
      for (let i = extendBy + n; i < n2; i++) { xx[i] = fr(fr(x[i + 1 - (extendBy + n)] - x[0]) + x[n - 1]); yy[i] = y[i + 1 - (extendBy + n)]; }
      n = n2; x = xx; y = yy;
    }
    const y2 = new Float64Array(n), cp = new Float64Array(n);
    // "new_x = x[1]; new_y = y[1]; cj = x[1]-x[0]; new_dj = (y[1]-y[0])/cj;" — the first differences are float expressions
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
    /* evalSpline(float[] x, float[] y, n, xp): "ba = x[rs]-x[ls];" is a float subtraction */
    return function evalSpline(xp) {
      let ls = 0, rs = n - 1;
      while (rs > 1 + ls) { const m = Math.floor(0.5 * (ls + rs)); if (x[m] < xp) ls = m; else rs = m; }
      const ba = fr(x[rs] - x[ls]);
      const xa = xp - x[ls];
      const bx = x[rs] - xp;
      const ba2 = ba * ba;
      const lower = xa * y[rs] + bx * y[ls];
      const C = (xa * xa - ba2) * xa * y2[rs];
      const D = (bx * bx - ba2) * bx * y2[ls];
      return (lower + (C + D) / 6.0) / ba;
    };
  }

  /* PolygonRoi.getSpline: node positions grow by "(float)Math.sqrt(Math.sqrt(dx*dx+dy*dy))" (min 0.001f, float accumulation);
   * a closed polygon gets one more node, its first point. xpf / ypf are RELATIVE to the float origin (the minimum of the
   * vertices), as in ImageJ (xpf[i] -= (float)bounds.x); the spline is evaluated there and the origin added back in float. */
  function getSpline(nodes, isLine, evaluationPoints) {
    const xpf = nodes.xr.slice(), ypf = nodes.yr.slice(), bx = nodes.bx, by = nodes.by;
    const nPoints = xpf.length;
    const nNodes = isLine ? nPoints : nPoints + 1;
    const nodePositions = new Array(nNodes);
    let last = 0;
    nodePositions[0] = 0;
    const seg = (dxv, dyv) => {
      const dx = fr(dxv), dy = fr(dyv);
      let d = fr(SQ(SQ(fr(fr(dx * dx) + fr(dy * dy)))));
      if (d < FLOAT_ZERO_THOUSANDTH) d = FLOAT_ZERO_THOUSANDTH;
      return d;
    };
    for (let i = 1; i < nPoints; i++) { last = fr(last + seg(xpf[i] - xpf[i - 1], ypf[i] - ypf[i - 1])); nodePositions[i] = last; }
    if (!isLine) {
      last = fr(last + seg(xpf[nPoints - 1] - xpf[0], ypf[nPoints - 1] - ypf[0]));
      nodePositions[nNodes - 1] = last;
      xpf.push(xpf[0]); ypf.push(ypf[0]);
    }
    const sfx = splineFitter(nodePositions, xpf, nNodes, !isLine);
    const sfy = splineFitter(nodePositions, ypf, nNodes, !isLine);
    const scale = last / (evaluationPoints - 1);
    const outX = new Array(evaluationPoints), outY = new Array(evaluationPoints);
    for (let i = 0; i < evaluationPoints; i++) {
      const xvalue = i * scale;
      outX[i] = fr(sfx(xvalue));
      outY[i] = fr(sfy(xvalue));
    }
    return { xs: outX, ys: outY, bx, by };
  }

  /* PolygonRoi.setSpline → resetBoundingRect → resetSplineFitBoundingRect: "xSpline[i] = xSpline[i]+xbase" (absolute), the float
   * bounds are measured on those, "xSpline[i] -= xbase" (relative to the new origin) and getFloatPolygon adds that origin back:
   * the vertices of a spline-fitted selection are fr(fr(fr(rel + base) − min) + min). */
  /* The nodes of a polygon as PolygonRoi stores them: relative to the float origin (the minimum of the vertices), "xpf[i] -=
   * (float)bounds.x" (finishPolygon). */
  function relNodes(xs, ys) {
    let mx = Infinity, my = Infinity;
    for (let i = 0; i < xs.length; i++) { if (xs[i] < mx) mx = xs[i]; if (ys[i] < my) my = ys[i]; }
    const bx = fr(mx), by = fr(my);
    return { xr: xs.map((x) => fr(x - bx)), yr: ys.map((y) => fr(y - by)), bx, by };
  }

  function splineAbsolute(rel, nodes) {
    const n = rel.xs.length;
    const ax = new Array(n), ay = new Array(n);
    let mx = Infinity, my = Infinity;
    for (let i = 0; i < n; i++) { ax[i] = fr(rel.xs[i] + rel.bx); ay[i] = fr(rel.ys[i] + rel.by); if (ax[i] < mx) mx = ax[i]; if (ay[i] < my) my = ay[i]; }
    // resetSplineFitBoundingRect: the spline is re-based on its own minimum (xSpline[i] -= xbase) and "xpf[i] -= xSpline0 -
    // xSpline[0]" moves the nodes with it (float arithmetic): the nodes are now relative to (mx, my)
    let outNodes = null;
    if (nodes) {
      const dx = fr(rel.xs[0] - fr(ax[0] - mx)), dy = fr(rel.ys[0] - fr(ay[0] - my));
      outNodes = { xr: nodes.xr.map((v) => fr(v - dx)), yr: nodes.yr.map((v) => fr(v - dy)), bx: mx, by: my };
    }
    for (let i = 0; i < n; i++) { ax[i] = fr(fr(ax[i] - mx) + mx); ay[i] = fr(fr(ay[i] - my) + my); }
    return { xs: ax, ys: ay, nodes: outNodes };
  }

  /* PolygonRoi.getEquidistantPoints(…, segmentLength = 1.0, imp = null): "npOut = (int)Math.round(length/segmentLength)+1; step
   * = length/(npOut-1)" and points interpolated along the preliminary spline. */
  function equidistantPoints(xp, yp, segmentLength) {
    const npoints = xp.length;
    if (npoints <= 0) return null;
    const length = plainLength(xp, yp, false);
    const npOut = jround(length / segmentLength) + 1;
    const step = length / (npOut - 1);
    if (npOut > MAX_VERTS) throw fail('IJ_ROI_TOO_COMPLEX', 'spline points');
    const xo = new Array(npOut), yo = new Array(npOut);
    xo[0] = xp[0]; yo[0] = yp[0];
    let lengthRead = 0, pointsWritten = 1;
    let x2 = xp[0], y2 = yp[0];
    for (let i = 1; i < npoints; i++) {
      const x1 = x2, y1 = y2;
      x2 = xp[i]; y2 = yp[i];
      const dx = x2 - x1, dy = y2 - y1;
      const distance = SQ(dx * dx + dy * dy);
      lengthRead += distance;
      let over = lengthRead - pointsWritten * step;
      while ((over >= 0.0 || i === npoints - 1) && pointsWritten < npOut) {
        let f = over / distance;
        if (distance === 0) f = 0;
        xo[pointsWritten] = fr(x2 - f * dx);
        yo[pointsWritten] = fr(y2 - f * dy);
        over -= step;
        pointsWritten++;
      }
    }
    return { xs: xo, ys: yo, step: fr(step) };
  }

  // ================================================================================================
  // Fit Spline — ij.plugin.Selection.fitSpline / trimPolygon / trimFloatPolygon, PolygonRoi.fitSpline
  // ================================================================================================

  /* Selection.rodbard: "y = c*((a-x/(x-d))^(1/b); a=3.9, b=.88, c=712, d=44" */
  function rodbard(x) {
    let ex;
    if (x === 0.0) ex = 5.0; else ex = Math.exp(Math.log(x / 700.0) * 0.88);
    let y = 3.9 - 44.0;
    y = y / (1.0 + ex);
    return y + 44.0;
  }

  /* Convolver.convolveFloat1D of a one-row image with the kernel {1,1,1,1,1}: edge pixels replicated, "pixels[x+y*width] =
   * (float)(sum*scale)" with scale = 1/5.0. Returns the convolved array (a new one). */
  function convolve5(a) {
    const n = a.length, out = new Array(n), scale = 1.0 / 5.0;
    for (let x = 0; x < n; x++) {
      let sum = 0.0;
      for (let u = -2; u <= 2; u++) { let k = x + u; if (k <= 0) k = 0; if (k >= n) k = n - 1; sum += a[k] * 1.0; }
      out[x] = fr(sum * scale);
    }
    return out;
  }

  /* Selection.smooth(int[]): "out[i] /= 3.0f … a[i] = (int)Math.round(out[i])", end points preserved; < 3 points: unchanged. */
  function smoothInt(a) {
    const n = a.length;
    if (n < 3) return a.slice();
    const out = new Array(n);
    out[0] = a[0]; out[n - 1] = a[n - 1];
    for (let i = 1; i < n - 1; i++) { let s = 0; for (let j = i - 1; j < i + 2; j++) s = fr(s + a[j]); out[i] = fr(s / 3.0); }
    const r = new Array(n);
    for (let i = 0; i < n; i++) r[i] = i === 0 || i === n - 1 ? a[i] : jround(out[i]);
    return r;
  }
  /* Selection.smooth(float[]) — a new array, end points preserved. */
  function smoothFloat(a) {
    const n = a.length;
    if (n < 3) return a;
    const out = new Array(n);
    out[0] = a[0]; out[n - 1] = a[n - 1];
    for (let i = 1; i < n - 1; i++) { let s = 0; for (let j = i - 1; j < i + 2; j++) s = fr(s + a[j]); out[i] = fr(s / 3.0); }
    return out;
  }

  /* Selection.trimPolygon (integer vertices): the polygon is smoothed with a 3-point mean, its curvature measured against a
   * 5-point mean, and a vertex is kept each time the walked distance (+1 per step, +2·curvature) reaches rodbard(length). */
  function trimPolygonInt(kind, xsAbs, ysAbs, length) {
    // IJ/plugin/Selection.java:339 "int[] x = roi.getXCoordinates()" = coordinates relative to the integer bounds; the origin is
    // added back only to the kept vertices ("x[0] += r.x", "x[i2] = x2 + r.x", :352-366). The float convolution rounds differently
    // far from the origin, so the smoothing and the curvature must see the relative values.
    const n = xsAbs.length;
    const rx = Math.min(...xsAbs), ry = Math.min(...ysAbs);
    const xs = xsAbs.map((v) => v - rx), ys = ysAbs.map((v) => v - ry);
    const x = smoothInt(xs), y = smoothInt(ys);
    // getCurvature(int[], int[], n): "ipx.convolve(kernel, kernel.length, 1)" on a float copy; curvature = |convolved − x|
    const cx = convolve5(x), cy = convolve5(y);
    const curvature = new Array(n);
    for (let i = 0; i < n; i++) { const dx = fr(cx[i] - x[i]), dy = fr(cy[i] - y[i]); curvature[i] = fr(SQ(fr(fr(dx * dx) + fr(dy * dy)))); }
    const threshold = rodbard(length);
    let distance = SQ((x[1] - x[0]) * (x[1] - x[0]) + (y[1] - y[0]) * (y[1] - y[0]));
    const ox = [x[0] + rx], oy = [y[0] + ry];
    let x2 = 0, y2 = 0;
    for (let i = 1; i < n - 1; i++) {
      const x1 = x[i], y1 = y[i];
      x2 = x[i + 1]; y2 = y[i + 1];
      distance += SQ((x2 - x1) * (x2 - x1) + (y2 - y1) * (y2 - y1)) + 1;
      distance += curvature[i] * 2;
      if (distance >= threshold) { ox.push(x2 + rx); oy.push(y2 + ry); distance = 0.0; }
    }
    const type = kind === 'freeline' ? 'polyline' : 'polygon';
    if (type === 'polyline' && distance > 0.0) { ox.push(x2 + rx); oy.push(y2 + ry); }
    return { kind: type, xs: ox, ys: oy };
  }

  /* Selection.trimFloatPolygon (sub-pixel vertices). TRAP kept as in the source: getCurvature(float[], float[], n) builds its
   * FloatProcessors ON x and y themselves ("new FloatProcessor(n, 1, x, null)") and convolves them in place — the arrays the
   * loop below reads are the convolved ones, and the curvature is the distance to the pre-convolution copy x2. */
  function trimPolygonFloat(kind, xs, ys, length) {
    const n = xs.length;
    let x = smoothFloat(xs.slice()), y = smoothFloat(ys.slice());
    const x2c = x.slice(), y2c = y.slice();
    x = convolve5(x); y = convolve5(y);
    const curvature = new Array(n);
    for (let i = 0; i < n; i++) { const dx = fr(x2c[i] - x[i]), dy = fr(y2c[i] - y[i]); curvature[i] = fr(SQ(fr(fr(dx * dx) + fr(dy * dy)))); }
    const threshold = rodbard(length);
    const d0x = fr(x[1] - x[0]), d0y = fr(y[1] - y[0]);
    let distance = SQ(fr(fr(d0x * d0x) + fr(d0y * d0y)));
    const ox = [x[0]], oy = [y[0]];
    let x2 = 0, y2 = 0;
    for (let i = 1; i < n - 1; i++) {
      const x1 = x[i], y1 = y[i];
      x2 = x[i + 1]; y2 = y[i + 1];
      distance += SQ((x2 - x1) * (x2 - x1) + (y2 - y1) * (y2 - y1)) + 1;
      distance += curvature[i] * 2;
      if (distance >= threshold) { ox.push(fr(x2)); oy.push(fr(y2)); distance = 0.0; }
    }
    const type = kind === 'freeline' ? 'polyline' : 'polygon';
    if (type === 'polyline' && distance > 0.0) { ox.push(fr(x2)); oy.push(fr(y2)); }
    return { kind: type, xs: ox, ys: oy };
  }

  const allInt = (xs, ys) => xs.every(Number.isInteger) && ys.every(Number.isInteger);

  /* The nodes a selection is made of, relative to its float origin as PolygonRoi keeps them: the vertices of an ordinary one, the
   * stored nodes of a spline fit (PolygonRoi keeps xpf next to xSpline; `nodes` are relative to `nodeBase`). The stored nodes are
   * used only while they still match the curve (the first curve point is node 0): a selection moved or flipped by something that
   * knows only `points` falls back to the curve itself. */
  function nodesOf(roi) {
    if (roi.spline && Array.isArray(roi.nodes) && roi.nodes.length >= 2 && Array.isArray(roi.nodeBase) && roi.points && roi.points.length >= 2) {
      const b = roi.nodeBase, n0 = roi.nodes[0], p0 = roi.points[0];
      if (Math.abs(n0[0] + b[0] - p0[0]) < 1e-3 && Math.abs(n0[1] + b[1] - p0[1]) < 1e-3) {
        return { xr: roi.nodes.map((p) => fr(p[0])), yr: roi.nodes.map((p) => fr(p[1])), bx: fr(b[0]), by: fr(b[1]) };
      }
    }
    const p = floatPolygon(roi);
    return relNodes(p.xs, p.ys);
  }
  const absNodes = (nd) => ({ xs: nd.xr.map((v) => fr(v + nd.bx)), ys: nd.yr.map((v) => fr(v + nd.by)) });

  /* Selection.fitSpline — "boolean segmentedSelection = type==Roi.POLYGON||type==Roi.POLYLINE; if (!(segmentedSelection||
   * type==Roi.FREEROI||type==Roi.TRACED_ROI||type==Roi.FREELINE)) { IJ.error("Spline Fit", "Polygon or polyline selection
   * required"); return; } if (roi instanceof EllipseRoi) return;" then "if (!segmentedSelection && p.getNCoordinates()>3) trim…".
   * PolygonRoi.fitSpline(): "int evaluationPoints = (int)(length/2.0); if (ic!=null) { double mag = ic.getMagnification(); if
   * (mag<1.0) evaluationPoints *= mag; } if (evaluationPoints<100) evaluationPoints = 100;" — the magnification reduction is NOT
   * applied (a replayed journal must not depend on the zoom). Returns the fitted selection, or { roi, unchanged: true }. */
  function fitSpline(roi) {
    const kind = kindOf(roi);
    if (!(kind === 'polygon' || kind === 'traced' || kind === 'freehand' || kind === 'polyline' || kind === 'freeline')) throw fail('IJ_SEL_NEEDS_POLY', 'polygon or polyline required');
    if (roi.ellipse) return { roi: roi, unchanged: true };
    const segmented = kind === 'polygon' || kind === 'polyline';
    const isLine = isLineKind(kind);
    let nodes = nodesOf(roi);
    const abs = absNodes(nodes);
    let outKind = segmented ? kind : (isLine ? 'polyline' : 'polygon');
    // getUncalibratedLength of the selection as it stands: a spline-fitted one measures its curve (xSpline!=null)
    const curveLen = () => (roi.spline ? plainLength(roi.points.map((p) => fr(p[0])), roi.points.map((p) => fr(p[1])), !isLine) : polyLength(kind, abs.xs, abs.ys, roi.rotRectWidth !== undefined));
    let length;
    if (!segmented && abs.xs.length > 3) {
      const trimmed = allInt(abs.xs, abs.ys) ? trimPolygonInt(kind, abs.xs, abs.ys, curveLen()) : trimPolygonFloat(kind, abs.xs, abs.ys, curveLen());
      outKind = trimmed.kind;
      nodes = relNodes(trimmed.xs, trimmed.ys);
      if (trimmed.xs.length < 2) throw fail('IJ_SEL_NEEDS_POLY', 'too few points');
      length = polyLength(trimmed.kind, trimmed.xs, trimmed.ys, false);
    } else length = curveLen();
    let evaluationPoints = jint(length / 2.0);
    if (evaluationPoints < 100) evaluationPoints = 100;
    const sp = splineAbsolute(getSpline(nodes, outKind === 'polyline', evaluationPoints), nodes);
    const out = makePoly(outKind, sp.xs, sp.ys, roi, true);
    out.spline = true;
    out.nodes = sp.nodes.xr.map((v, i) => [v, sp.nodes.yr[i]]);
    out.nodeBase = [sp.nodes.bx, sp.nodes.by];
    if (outKind === 'polyline' && roi.width !== undefined) out.width = roi.width;
    return { roi: out };
  }

  /* The straightening spline of a line selection (PolygonRoi.fitSplineForStraightening): "getSpline((int)(getUncalibratedLength()*2)+1,
   * null, null); spline = getEquidistantPoints(spline[0], spline[1], spline[0].length, 1.0, null);". The selection is a POLYLINE
   * (a FREELINE was reduced by Fit Spline first, a straight line becomes a 2-point polyline). */
  function straighteningPoints(nodes) {
    const length = plainLength(nodes.xr, nodes.yr, false);
    const sp = getSpline(nodes, true, jint(length * 2) + 1);
    // the equidistant points are taken on the RELATIVE spline (the arrays getSpline returns); setSpline then resets the bounds
    const eq = equidistantPoints(sp.xs, sp.ys, 1.0);
    return splineAbsolute({ xs: eq.xs, ys: eq.ys, bx: sp.bx, by: sp.by }, null);
  }

  // ================================================================================================
  // Fit Circle — Selection.fitCircle (area: equal-area circle at the centroid; others: Pratt fit)
  // ================================================================================================

  /* ImageStatistics.getStatistics(ip, AREA+CENTROID, null) of the selection on an image of W × H: "pixelCount" = the pixels of the
   * mask inside the image, "xCentroid = xsum/count+0.5" (ByteStatistics.getCentroid). The pixel values play no part. */
  function areaStats(roi, W0, H0) {
    const W = finite(W0) ? W0 : 1 << 30, H = finite(H0) ? H0 : 1 << 30; // no image given: the selection is not clipped
    let count = 0, xsum = 0, ysum = 0;
    if (roi.type === 'rect') {
      // closed form of IJRoi.mask: a pixel is in when its centre is, i.e. columns ceil(x0 - 1/2) … ceil(x1 - 1/2) − 1, same rows
      const i0 = Math.max(0, Math.ceil(roi.x - 0.5)), i1 = Math.min(W, Math.ceil(roi.x + roi.w - 0.5));
      const j0 = Math.max(0, Math.ceil(roi.y - 0.5)), j1 = Math.min(H, Math.ceil(roi.y + roi.h - 0.5));
      if (i1 > i0 && j1 > j0) {
        const nx = i1 - i0, ny = j1 - j0;
        count = nx * ny;
        xsum = ((i0 + i1 - 1) * nx / 2) * ny;
        ysum = ((j0 + j1 - 1) * ny / 2) * nx;
      }
    } else {
      // strips of 64 rows (the roi shifted by an integer, so every pixel centre sees the same arithmetic): the mask held at any
      // moment is a strip, not the box of the selection
      const bb = IJRoi.bounds(roi);
      const y0 = Math.max(0, bb.y), y1 = Math.min(H, bb.y + bb.h), STRIP = 64;
      for (let ys = y0; ys < y1; ys += STRIP) {
        const sh = Math.min(STRIP, y1 - ys);
        const m = IJRoi.mask(IJRoi.translate(roi, 0, -ys), W, sh);
        for (let j = 0; j < m.h; j++) {
          const y = ys + m.y + j, row = j * m.w;
          let c = 0, xs = 0;
          for (let i = 0; i < m.w; i++) if (m.data[row + i]) { c++; xs += m.x + i; }
          count += c; xsum += xs; ysum += y * c;
        }
      }
    }
    return { pixelCount: count, xCentroid: xsum / count + 0.5, yCentroid: ysum / count + 0.5 };
  }

  /* Roi.getPolygon() of a line / point selection: integer vertices — "xpoints1 = toIntR(xpf)" of the vertices relative to the
   * float origin, plus the integer origin ("xpoints2[i] = xpoints1[i] + x"). */
  function integerPolygon(roi) {
    const p = floatPolygon(roi);
    let minX = Infinity, minY = Infinity;
    for (let i = 0; i < p.xs.length; i++) { if (p.xs[i] < minX) minX = p.xs[i]; if (p.ys[i] < minY) minY = p.ys[i]; }
    const bx = fr(minX), by = fr(minY), ix = Math.floor(minX), iy = Math.floor(minY);
    return { xs: p.xs.map((x) => jround(fr(x - bx)) + ix), ys: p.ys.map((y) => jround(fr(y - by)) + iy) };
  }

  function fitCircle(roi, W, H) {
    const kind = kindOf(roi);
    if (isAreaKind(kind)) {
      const st = areaStats(roi, W, H);
      if (!(st.pixelCount > 0)) throw fail('IJ_EMPTY_ROI', 'empty selection');
      const r = SQ(st.pixelCount / Math.PI);
      const d = jround(2.0 * r);
      return { roi: copyName(roi, { type: 'oval', x: jround(st.xCentroid - r), y: jround(st.yCentroid - r), w: d, h: d }) };
    }
    if (kind === 'line') throw fail('IJ_SEL_FEW_POINTS', 'at least 3 points');
    const poly = integerPolygon(roi);
    const n = poly.xs.length, x = poly.xs, y = poly.ys;
    if (n < 3) throw fail('IJ_SEL_FEW_POINTS', 'at least 3 points');
    let sumx = 0, sumy = 0;
    for (let i = 0; i < n; i++) { sumx = sumx + x[i]; sumy = sumy + y[i]; }
    const meanx = sumx / n, meany = sumy / n;
    const X = new Array(n), Y = new Array(n);
    let Mxx = 0, Myy = 0, Mxy = 0, Mxz = 0, Myz = 0, Mzz = 0;
    for (let i = 0; i < n; i++) {
      X[i] = x[i] - meanx; Y[i] = y[i] - meany;
      const Zi = X[i] * X[i] + Y[i] * Y[i];
      Mxy = Mxy + X[i] * Y[i]; Mxx = Mxx + X[i] * X[i]; Myy = Myy + Y[i] * Y[i];
      Mxz = Mxz + X[i] * Zi; Myz = Myz + Y[i] * Zi; Mzz = Mzz + Zi * Zi;
    }
    Mxx = Mxx / n; Myy = Myy / n; Mxy = Mxy / n; Mxz = Mxz / n; Myz = Myz / n; Mzz = Mzz / n;
    const Mz = Mxx + Myy;
    const Cov_xy = Mxx * Myy - Mxy * Mxy;
    const Mxz2 = Mxz * Mxz, Myz2 = Myz * Myz;
    const A2 = 4 * Cov_xy - 3 * Mz * Mz - Mzz;
    const A1 = Mzz * Mz + 4 * Cov_xy * Mz - Mxz2 - Myz2 - Mz * Mz * Mz;
    const A0 = Mxz2 * Myy + Myz2 * Mxx - Mzz * Cov_xy - 2 * Mxz * Myz * Mxy + Mz * Mz * Cov_xy;
    const A22 = A2 + A2;
    const epsilon = 1e-12, IterMax = 20;
    let ynew = 1e+20, xnew = 0;
    // Newton's method starting at x=0 (Pratt; N. Chernov's script)
    for (let iter = 1; iter <= IterMax; iter++) {
      const yold = ynew;
      ynew = A0 + xnew * (A1 + xnew * (A2 + 4.0 * xnew * xnew));
      if (Math.abs(ynew) > Math.abs(yold)) { xnew = 0; break; }
      const Dy = A1 + xnew * (A22 + 16 * xnew * xnew);
      const xold = xnew;
      xnew = xold - ynew / Dy;
      if (Math.abs((xnew - xold) / xnew) < epsilon) break;
      if (iter >= IterMax) xnew = 0;
      if (xnew < 0) xnew = 0;
    }
    const DET = xnew * xnew - xnew * Mz + Cov_xy;
    let CenterX = (Mxz * (Myy - xnew) - Myz * Mxy) / (2 * DET);
    let CenterY = (Myz * (Mxx - xnew) - Mxz * Mxy) / (2 * DET);
    const radius = SQ(CenterX * CenterX + CenterY * CenterY + Mz + 2 * xnew);
    if (Number.isNaN(radius)) throw fail('IJ_SEL_COLLINEAR', 'points are collinear');
    CenterX = CenterX + meanx; CenterY = CenterY + meany;
    return { roi: copyName(roi, { type: 'oval', x: jround(CenterX - radius), y: jround(CenterY - radius), w: jround(2 * radius), h: jround(2 * radius) }) };
  }

  // ================================================================================================
  // Fit Rectangle — Selection.fitRectangle (minimum-area rectangle among the sides of the convex hull; Freeman & Shapira 1975)
  // ================================================================================================

  /* RotatedRectRoi.makeRectangle(x1, y1, x2, y2) with its width: the four corners are floats, made relative to the integer
   * origin (makePolygonRelative: "xpf[i] = xpf[i]-x") and brought back by getFloatPolygon ("xpf[i] + xbase"). */
  function rotatedRect(x1, y1, x2, y2, rectWidth, src) {
    const length = SQ((x2 - x1) * (x2 - x1) + (y2 - y1) * (y2 - y1));
    const wsa = 0.5 * rectWidth * (y2 - y1) / length;
    const wca = -0.5 * rectWidth * (x2 - x1) / length;
    const xs = [fr(x1 + wsa), fr(x2 + wsa), fr(x2 - wsa), fr(x1 - wsa)];
    const ys = [fr(y1 + wca), fr(y2 + wca), fr(y2 - wca), fr(y1 - wca)];
    const ix = Math.floor(Math.min(...xs)), iy = Math.floor(Math.min(...ys));
    const ox = xs.map((v) => fr(fr(v - ix) + ix)), oy = ys.map((v) => fr(fr(v - iy) + iy));
    const o = makePoly('polygon', ox, oy, src, true);
    o.rotRectWidth = rectWidth;
    return o;
  }

  /* RotatedRectRoi.getParams(): x1, y1, x2, y2 from the corners, "hx(index) = xpf[index]+(xpf[indexPlus1]-xpf[index])/2+x" (float
   * arithmetic, x the integer origin) and the width. */
  function rotatedRectParams(roi) {
    const p = floatPolygon(roi);
    const ix = Math.floor(Math.min(...p.xs)), iy = Math.floor(Math.min(...p.ys));
    const xpf = p.xs.map((v) => fr(v - ix)), ypf = p.ys.map((v) => fr(v - iy));
    const hx = (i) => { const j = i < 3 ? i + 1 : 0; return fr(fr(xpf[i] + fr(fr(xpf[j] - xpf[i]) / 2)) + ix); };
    const hy = (i) => { const j = i < 3 ? i + 1 : 0; return fr(fr(ypf[i] + fr(fr(ypf[j] - ypf[i]) / 2)) + iy); };
    return [hx(3), hy(3), hx(1), hy(1), roi.rotRectWidth];
  }

  function fitRectangle(roi) {
    const kind = kindOf(roi);
    if (kind === 'line') throw fail('IJ_SEL_NEEDS_AREA_OR_POINTS', 'area, point or segmented / free line required');
    let hullSrc;
    if (kind === 'composite') {
      const v = IJRoiTools.roiVertices(roi);
      hullSrc = { xs: v.xs, ys: v.ys };
    } else {
      const v = IJRoiTools.roiVertices(roi);
      hullSrc = { xs: v.xs.map(fr), ys: v.ys.map(fr) };
    }
    if (!isAreaKind(kind)) {
      const n = hullSrc.xs.length, x = hullSrc.xs, y = hullSrc.ys;
      if (n < 3) throw fail('IJ_SEL_FEW_POINTS_RECT', 'at least 3 points');
      let colinear = true;
      for (let i = 2; i < n; i++) {
        const prod = fr(fr(fr(x[i] - x[0]) * fr(y[i] - y[0])) - fr(fr(x[i] - x[1]) * fr(y[i] - y[1])));
        if (prod !== 0) colinear = false;
      }
      if (colinear) throw fail('IJ_SEL_COLLINEAR', 'points are collinear');
    }
    const hull = IJRoiTools.convexHull(hullSrc.xs, hullSrc.ys);
    const xp = hull.xs, yp = hull.ys, np = xp.length;
    if (np < 3) throw fail('IJ_SEL_COLLINEAR', 'degenerate');
    let minArea = Infinity, minFD = 0, imin = -1, i2min = -1, jmin = -1, minHmin = 0, minHmax = 0;
    // the float expressions of the source: "(xp[i2] - xp[i]) * (yp[j] - yp[i])" multiplies two floats (a float), the quotient by
    // "Math.sqrt(Math.pow(…, 2) + Math.pow(…, 2))" is a double
    const sub = (a, b) => fr(a - b);
    for (let i = 0; i < np; i++) {
      let maxLD = 0, imax = -1, i2max = -1, jmax = -1;
      let i2 = i + 1;
      if (i === np - 1) i2 = 0;
      const ex = sub(xp[i2], xp[i]), ey = sub(yp[i2], yp[i]);
      const el = SQ(ex * ex + ey * ey);
      for (let j = 0; j < np; j++) {
        const cross = fr(fr(ex * sub(yp[j], yp[i])) - fr(sub(xp[j], xp[i]) * ey));
        const d = Math.abs(cross / el);
        if (maxLD < d) { maxLD = d; imax = i; jmax = j; i2max = i2; }
      }
      if (imax < 0) continue;
      let hmin = 0, hmax = 0;
      const fx = sub(xp[i2max], xp[imax]), fy = sub(yp[i2max], yp[imax]);
      const fl = SQ(fx * fx + fy * fy);
      for (let k = 0; k < np; k++) {
        const hd = fr(fr(fx * sub(xp[k], xp[imax])) + fr(sub(yp[k], yp[imax]) * fy)) / fl;
        hmin = Math.min(hmin, hd); hmax = Math.max(hmax, hd);
      }
      const area = maxLD * (hmax - hmin);
      if (minArea > area) { minArea = area; minFD = maxLD; minHmin = hmin; minHmax = hmax; imin = imax; i2min = i2max; jmin = jmax; }
    }
    if (imin < 0) throw fail('IJ_SEL_COLLINEAR', 'degenerate');
    const gx = sub(xp[i2min], xp[imin]), gy = sub(yp[i2min], yp[imin]);
    const gl = SQ(gx * gx + gy * gy);
    const pd = fr(fr(gx * sub(yp[jmin], yp[imin])) - fr(sub(xp[jmin], xp[imin]) * gy)) / gl; // signed feret diameter
    let pairAngle = Math.atan2(yp[i2min] - yp[imin], xp[i2min] - xp[imin]);
    const minAngle = pairAngle + Math.PI / 2;
    // rectangle center and signed full height
    const xm = xp[imin] + Math.cos(pairAngle) * (minHmax + minHmin) / 2 + Math.cos(minAngle) * pd / 2;
    const ym = yp[imin] + Math.sin(pairAngle) * (minHmax + minHmin) / 2 + Math.sin(minAngle) * pd / 2;
    let hm = minHmax - minHmin;
    if (minFD > Math.abs(hm)) { // ensure control axis is parallel to longer side
      pairAngle = pairAngle - Math.PI / 2;
      minFD = Math.abs(hm);
      hm = pd;
    }
    if (pairAngle * hm > 0) hm = -hm; // ensure first control point at the top
    const x1 = xm + Math.cos(pairAngle) * hm / 2, y1 = ym + Math.sin(pairAngle) * hm / 2;
    const x2 = xm - Math.cos(pairAngle) * hm / 2, y2 = ym - Math.sin(pairAngle) * hm / 2;
    return { roi: rotatedRect(x1, y1, x2, y2, minFD, roi) };
  }

  // ================================================================================================
  // Interpolate — Roi.getInterpolatedPolygon / PolygonRoi.getInterpolatedPolygon, Selection.interpolate
  // ================================================================================================

  /* Roi.lineCircleIntersection(ax, ay, bx, by, cx, cy, rad, ignoreOutside = true): 0, 2 or 4 coordinates. */
  function lineCircleIntersection(ax, ay, bx, by, cx, cy, rad) {
    const dxAC = cx - ax, dyAC = cy - ay;
    const lenAC = SQ(dxAC * dxAC + dyAC * dyAC);
    const dxAB = bx - ax, dyAB = by - ay;
    const xB2 = SQ(dxAB * dxAB + dyAB * dyAB);
    const phi1 = Math.atan2(dyAB, dxAB), phi2 = Math.atan2(dyAC, dxAC);
    const phi3 = phi1 - phi2;
    const xC2 = lenAC * Math.cos(phi3), yC2 = lenAC * Math.sin(phi3);
    if (Math.abs(yC2) > rad) return [];
    const halfChord = SQ(rad * rad - yC2 * yC2);
    const sectOne = xC2 - halfChord, sectTwo = xC2 + halfChord;
    const out = [];
    if (sectOne >= 0 && sectOne <= xB2) out.push(Math.cos(phi1) * sectOne + ax, Math.sin(phi1) * sectOne + ay);
    if (sectTwo >= 0 && sectTwo <= xB2) out.push(Math.cos(phi1) * sectTwo + ax, Math.sin(phi1) * sectTwo + ay);
    if (halfChord === 0 && out.length > 2) out.length = 2; // tangent line returns only one intersection
    return out;
  }

  /* Roi.getInterpolatedPolygon(FloatPolygon p, interval, smooth): "boolean allowToAdjust = interval < 0; interval = Math.abs(interval);"
   * points spaced `interval` apart along the outline (the circle-walk of N. Vischer); a negative interval lets the program shorten it so
   * that the last segment hits the end point (up to 50 trials, feedback factor 0.66). Float output. */
  function interpolatePolygon(xsIn, ysIn, isLine, interval) {
    const allowToAdjust = interval < 0;
    interval = Math.abs(interval);
    const xs = xsIn.slice(), ys = ysIn.slice();
    let npoints = xs.length;
    if (npoints < 2) return { xs, ys };
    if (Math.abs(interval) < 0.01) throw fail('IJ_SEL_INTERVAL', 'interval must be >= 0.01');
    if (!isLine) { npoints++; xs.push(xs[0]); ys.push(ys[0]); } // append (and later remove) the closing point
    let tryInterval = interval, minDiff = 1e9, bestInterval = 0;
    let srcPtr = 0, destPtr = 0;
    let destX = [], destY = [];
    const nTrials = 50;
    let trial = 0;
    while (trial <= nTrials) {
      destX = [xs[0]]; destY = [ys[0]];
      srcPtr = 0; destPtr = 0;
      let xA = xs[0], yA = ys[0];
      while (srcPtr < npoints - 1) {
        const xC = destX[destPtr], yC = destY[destPtr];
        const xB = xs[srcPtr + 1], yB = ys[srcPtr + 1];
        const inter = lineCircleIntersection(xA, yA, xB, yB, xC, yC, tryInterval);
        if (inter.length >= 2) {
          xA = inter[0]; yA = inter[1];
          destPtr++;
          destX[destPtr] = xA; destY[destPtr] = yA;
          if (destPtr > MAX_VERTS) throw fail('IJ_ROI_TOO_COMPLEX', 'interpolated vertices');
        } else {
          srcPtr++;
          xA = xs[srcPtr]; yA = ys[srcPtr];
        }
      }
      destPtr++;
      destX[destPtr] = xs[npoints - 1]; destY[destPtr] = ys[npoints - 1];
      destPtr++;
      if (!allowToAdjust) { if (isLine) destPtr--; break; }
      const nSegments = destPtr - 1;
      const dx = destX[destPtr - 2] - destX[destPtr - 1], dy = destY[destPtr - 2] - destY[destPtr - 1];
      const lastSeg = SQ(dx * dx + dy * dy);
      const diff = lastSeg - tryInterval; // always <= 0
      if (Math.abs(diff) < minDiff) { minDiff = Math.abs(diff); bestInterval = tryInterval; }
      const feedBackFactor = 0.66;
      tryInterval = tryInterval + feedBackFactor * diff / nSegments;
      // stop if tryInterval < 80% of interval, OR if last segment differs < 0.05 pixels
      if ((tryInterval < 0.8 * interval || Math.abs(diff) < 0.05 || trial === nTrials - 1) && trial < nTrials) { trial = nTrials; tryInterval = bestInterval; } else trial++;
    }
    if (!isLine) destPtr--; // remove closing point from end of array
    return { xs: destX.slice(0, destPtr).map(fr), ys: destY.slice(0, destPtr).map(fr) };
  }

  /* PolygonRoi.getInterpolatedPolygon: "if (smooth && (type==TRACED_ROI || type==FREEROI || type==FREELINE)) { for (int i=1;
   * i<p.npoints-2; i++) p.xpoints[i] = (p.xpoints[i-1]+p.xpoints[i]+p.xpoints[i+1])/3f; if (type!=FREELINE) { …the two end points
   * close the loop… } }" — in place, so every vertex sees the already smoothed predecessor. */
  function smoothForInterpolation(kind, xs, ys) {
    const n = xs.length;
    for (let i = 1; i < n - 2; i++) {
      xs[i] = fr(fr(fr(xs[i - 1] + xs[i]) + xs[i + 1]) / 3);
      ys[i] = fr(fr(fr(ys[i - 1] + ys[i]) + ys[i + 1]) / 3);
    }
    if (kind !== 'freeline') {
      xs[0] = fr(fr(fr(xs[n - 1] + xs[0]) + xs[1]) / 3);
      ys[0] = fr(fr(fr(ys[n - 1] + ys[0]) + ys[1]) / 3);
      xs[n - 1] = fr(fr(fr(xs[n - 2] + xs[n - 1]) + xs[0]) / 3);
      ys[n - 1] = fr(fr(fr(ys[n - 2] + ys[n - 1]) + ys[0]) / 3);
    }
  }

  // ---- composites (ShapeRoi): the outlines of a mask, filled again with the even-odd rule -----------------------------------

  /* The filled region of closed polygons under the even-odd rule: ShapeRoi.getMask fills "getFloatPolygon(FILL_FLATNESS, …)" (all
   * sub-paths in ONE PolygonFiller), whose scan lines pair the crossings of every loop — the same set as the XOR of the loops filled
   * one by one. Returns a `mask` selection (or null when nothing is inside). */
  function fillLoops(loops) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const l of loops) for (const p of l) { if (p[0] < minX) minX = p[0]; if (p[0] > maxX) maxX = p[0]; if (p[1] < minY) minY = p[1]; if (p[1] > maxY) maxY = p[1]; }
    if (!(minX <= maxX)) return null;
    const bx = Math.floor(minX), by = Math.floor(minY), bw = Math.ceil(maxX) - bx, bh = Math.ceil(maxY) - by;
    if (bw <= 0 || bh <= 0) return null;
    if (bw * bh > 1 << 28) throw fail('IJ_ROI_TOO_COMPLEX', 'selection too large');
    const dense = new Uint8Array(bw * bh);
    for (const l of loops) {
      if (l.length < 3) continue;
      const m = IJRoi.mask({ type: 'polygon', points: l.map((p) => [fr(p[0]), fr(p[1])]) });
      for (let j = 0; j < m.h; j++) {
        const dst = (m.y - by + j) * bw + (m.x - bx), src = j * m.w;
        for (let i = 0; i < m.w; i++) if (m.data[src + i]) dense[dst + i] ^= 1;
      }
    }
    const r = IJRoi.fromMask(dense, bw, bh);
    if (!r.w || !r.h) return null;
    return IJRoi.translate(r, bx, by);
  }

  const loopsOf = (roi) => IJRoi.outlines(roi).map((l) => l.map((p) => [p[0], p[1]]));

  /* The vertex order of the parts of a ShapeRoi as ImageJ hands them out (ShapeRoi.getRois of a ThresholdToSelection result), found
   * on the golden fixture of a ring (interval 2.5 with and without smoothing, 9, 3.7 adjusted): an outer boundary runs
   * COUNTER-CLOCKWISE on the screen and a hole CLOCKWISE — the reverse of how IJRoi.outlines walks them (foreground on the right) —
   * and each part starts at the END of its lowest horizontal edge: the rightmost lowest vertex of an outer boundary, the leftmost of
   * a hole. The interpolation walks the outline from its first vertex, so the order decides the vertices of the result. */
  function shapeRoiPartOrder(loop) {
    let a = 0;
    for (let i = 0; i < loop.length; i++) { const p = loop[i], q = loop[(i + 1) % loop.length]; a += p[0] * q[1] - q[0] * p[1]; }
    const outer = a > 0; // positive sum = clockwise on the screen (y down) = an outer boundary of IJRoi.outlines
    const l = loop.slice().reverse();
    let s = 0;
    for (let i = 1; i < l.length; i++) {
      const better = l[i][1] > l[s][1] || (l[i][1] === l[s][1] && (outer ? l[i][0] > l[s][0] : l[i][0] < l[s][0]));
      if (better) s = i;
    }
    return l.slice(s).concat(l.slice(0, s));
  }

  /* Selection.interpolate — "if (roi.getType()==Roi.POINT) return;" then, for a composite with several parts, every part is
   * interpolated ("FloatPolygon fPoly = roi2.getInterpolatedPolygon(interval,smooth)") and the parts are recombined ("Assume
   * subsequent Rois are holes"); otherwise "roi.getInterpolatedPolygon(sign*interval, smooth)" (sign −1 for "Adjust interval to
   * match") and "type = roi.isLine()?FREELINE:FREEROI; if (t==POLYGON && interval>1.0) type = POLYGON; if ((t==RECTANGLE||t==OVAL||
   * t==FREEROI) && interval>=8.0) type = POLYGON; if ((t==LINE||t==FREELINE) && interval>=8.0) type = POLYLINE; if (t==POLYLINE &&
   * interval>=8.0) type = POLYLINE;" (the "magnification >= 12" clause of the source is dropped: a replay must not depend on the zoom).
   * Deviation, composites: ImageJ subtracts each part from the accumulated shape ("tempRoi.not(newShapeRoi)"), which keeps an outer
   * boundary with its holes but loses earlier parts of a selection of several separate blobs; the even-odd union used here is the
   * same shape for outer + holes and keeps every blob. */
  function interpolate(roi, interval, smooth, adjust) {
    const kind = kindOf(roi);
    if (kind === 'point') return { roi, unchanged: true };
    if (!finite(interval)) throw fail('IJ_BAD_ARGS', 'interval');
    if (kind === 'composite') {
      const loops = loopsOf(roi).map(shapeRoiPartOrder);
      if (loops.length === 1) {
        // Selection.java:288 takes the composite branch only for "getRois().length>1"; a one-part ShapeRoi goes through
        // Roi.getInterpolatedPolygon(sign*interval, smooth) (Roi.java:626, base class: no smoothing for a COMPOSITE type), type FREEROI.
        // The whole ShapeRoi's path (not getRois()'s re-split parts): found on the golden fixture interpolate_onepart.json to start at the
        // top-most, left-most vertex and to run with the interior on its left (counter-clockwise on the screen).
        const raw = loopsOf(roi)[0].slice().reverse();
        let st = 0;
        for (let i = 1; i < raw.length; i++) if (raw[i][1] < raw[st][1] || (raw[i][1] === raw[st][1] && raw[i][0] < raw[st][0])) st = i;
        const l = raw.slice(st).concat(raw.slice(0, st));
        const r1 = interpolatePolygon(l.map((p) => fr(p[0])), l.map((p) => fr(p[1])), false, (adjust ? -1 : 1) * interval);
        return { roi: makePoly('freehand', r1.xs, r1.ys, roi) };
      }
      const out = [];
      for (const l of loops) {
        const xs = l.map((p) => fr(p[0])), ys = l.map((p) => fr(p[1]));
        if (smooth) smoothForInterpolation('traced', xs, ys);
        const r = interpolatePolygon(xs, ys, false, interval);
        out.push(pairs(r.xs, r.ys));
      }
      const m = fillLoops(out);
      if (!m) throw fail('IJ_EMPTY_ROI', 'empty selection');
      return { roi: copyName(roi, m) };
    }
    const sign = adjust ? -1 : 1;
    const p = floatPolygon(roi);
    if (smooth && (kind === 'traced' || kind === 'freehand' || kind === 'freeline')) smoothForInterpolation(kind, p.xs, p.ys);
    const isLine = isLineKind(kind);
    const r = interpolatePolygon(p.xs, p.ys, isLine, sign * interval);
    let type = isLine ? 'freeline' : 'freehand';
    if (kind === 'polygon' && interval > 1.0) type = 'polygon';
    if ((kind === 'rect' || kind === 'oval' || kind === 'freehand') && interval >= 8.0) type = 'polygon';
    if ((kind === 'line' || kind === 'freeline') && interval >= 8.0) type = 'polyline';
    if (kind === 'polyline' && interval >= 8.0) type = 'polyline';
    const out = makePoly(type, r.xs, r.ys, roi);
    if ((type === 'polyline' || type === 'freeline') && roi.width !== undefined) out.width = roi.width;
    return { roi: out };
  }

  // ================================================================================================
  // Scale, Rotate, Translate — ij.plugin.RoiScaler.scale, RoiRotator.rotate, Selection.translate
  // ================================================================================================

  /* Roi.getBounds of a line, a polyline or a point selection ("useLineSubpixelConvention": ensure the 'draw' area is enclosed):
   * setIntBounds: "x = (int)Math.floor(bounds.x + 0.5); width = (int)Math.floor(bounds.x + bounds.width + 1.5) - x" — one pixel
   * wider than the vertices span. Used for the centre of a centred scale. */
  function lineIntBounds(roi) {
    const p = roi.type === 'line' ? { xs: [roi.x1, roi.x2], ys: [roi.y1, roi.y2] } : { xs: roi.points.map((q) => fr(q[0])), ys: roi.points.map((q) => fr(q[1])) };
    const x0 = Math.min(...p.xs), x1 = Math.max(...p.xs), y0 = Math.min(...p.ys), y1 = Math.max(...p.ys);
    const x = Math.floor(x0 + 0.5), y = Math.floor(y0 + 0.5);
    return { x, y, w: Math.floor(x1 + 1.5) - x, h: Math.floor(y1 + 1.5) - y };
  }

  /* The polygon type RoiScaler / RoiRotator give a selection: "if (type==Roi.RECTANGLE) type = Roi.POLYGON; … if (type==Roi.OVAL||
   * type==Roi.TRACED_ROI) type = Roi.FREEROI;" */
  function transformedKind(kind) {
    if (kind === 'rect') return 'polygon';
    if (kind === 'oval' || kind === 'traced') return 'freehand';
    return kind;
  }

  /* An area ROI of a given selection type from transformed loops (composite). */
  function loopsRoi(loops, src) {
    const m = fillLoops(loops);
    if (!m) throw fail('IJ_EMPTY_ROI', 'empty selection');
    return copyName(src, m);
  }

  /* RoiScaler.scale: "poly.xpoints[i] = (float)(poly.xpoints[i]*xscale)" about the image origin; centred: "(float)Math.round((poly
   * .xpoints[i]-stats.xCentroid)*xscale+stats.xCentroid)" about the centroid of the selection (of the box centre for a line).
   * A composite is scaled as a shape ("at.scale(xscale, yscale); if (!centered) at.translate(r.x, r.y)") and, centred, put back
   * at "xbase = (int)(r.x-(r.width*xscale-r.width)/2.0)". "double width = roi.getStrokeWidth(); if (width!=0)
   * roi2.setStrokeWidth(width*xscale)". W, H: the image the selection lives on (the centroid is taken inside it). */
  function scale(roi, xscale, yscale, centered, W, H) {
    if (!(finite(xscale) && finite(yscale))) throw fail('IJ_BAD_ARGS', 'scale');
    const kind = kindOf(roi);
    if (kind === 'composite') {
      const r = { x: roi.x, y: roi.y, w: roi.w, h: roi.h };
      const loops = loopsOf(roi).map((l) => l.map((p) => {
        if (!centered) return [p[0] * xscale, p[1] * yscale];
        const xbase = jint(r.x - (r.w * xscale - r.w) / 2.0), ybase = jint(r.y - (r.h * yscale - r.h) / 2.0);
        return [(p[0] - r.x) * xscale + xbase, (p[1] - r.y) * yscale + ybase];
      }));
      return { roi: loopsRoi(loops, roi) };
    }
    const poly = kind === 'line' ? { xs: [fr(roi.x1), fr(roi.x2)], ys: [fr(roi.y1), fr(roi.y2)] } : floatPolygon(roi);
    let st = null;
    if (centered) {
      if (isLineKind(kind)) {
        // "if (roi.isLine()) { Rectangle r = roi.getBounds(); stats.xCentroid = r.x + Math.round(r.width/2.0); … }"
        const b = lineIntBounds(roi);
        st = { xCentroid: b.x + jround(b.w / 2.0), yCentroid: b.y + jround(b.h / 2.0) };
      } else if (kind === 'point' || kind === 'angle') {
        const m = IJRoi.bounds(roi);
        st = { xCentroid: m.x + m.w / 2.0, yCentroid: m.y + m.h / 2.0 };
      } else {
        st = areaStats(roi, W, H);
        if (!(st.pixelCount > 0)) throw fail('IJ_EMPTY_ROI', 'empty selection');
      }
    }
    for (let i = 0; i < poly.xs.length; i++) {
      if (centered) {
        poly.xs[i] = fr(jround((poly.xs[i] - st.xCentroid) * xscale + st.xCentroid));
        poly.ys[i] = fr(jround((poly.ys[i] - st.yCentroid) * yscale + st.yCentroid));
      } else {
        poly.xs[i] = fr(poly.xs[i] * xscale);
        poly.ys[i] = fr(poly.ys[i] * yscale);
      }
    }
    let out;
    if (kind === 'line') {
      out = copyName(roi, { type: 'line', x1: poly.xs[0], y1: poly.ys[0], x2: poly.xs[1], y2: poly.ys[1] });
    } else out = makePoly(transformedKind(kind), poly.xs, poly.ys, roi);
    if (roi.width !== undefined && roi.width !== 0 && (out.type === 'line' || out.type === 'polyline')) out.width = roi.width * xscale;
    return { roi: out };
  }

  /* Roi.getRotationCenter: "xcenter = r.getX()+r.getWidth()/2.0" of the float bounds, unless a centre was stored by an earlier
   * rotation ("roi2.setRotationCenter(xcenter,ycenter)") — the selection keeps turning about its first centre. */
  function rotationCenter(roi) {
    if (Array.isArray(roi.rotationCenter) && roi.rotationCenter.length === 2 && finite(roi.rotationCenter[0]) && finite(roi.rotationCenter[1])) return roi.rotationCenter.slice();
    // Roi.getFloatBounds(): the box of a rectangle / oval / composite; a Line its two end points; a float polygon or polyline the
    // FloatPolygon bounds; an INTEGER open polyline / point selection its integer box, one pixel wider ("width++" of the line convention)
    let x0, y0, x1, y1;
    if (roi.type === 'rect' || roi.type === 'oval' || roi.type === 'mask') { x0 = roi.x; y0 = roi.y; x1 = roi.x + roi.w; y1 = roi.y + roi.h; }
    else if (roi.ellipse && roi.points) {
      // EllipseRoi.makePolygonRelative: "Rectangle r = poly.getBounds()" — the INTEGER box of FloatPolygon.getBounds (floor of the
      // minimum, "(int)(max-iMin+0.5)" wide): the fixture has bounds [9,13,41,23] for vertices from 9.858 to 50.142
      const rb = IJRoiTools.roiBounds(roi);
      x0 = rb.x; y0 = rb.y; x1 = rb.x + rb.w; y1 = rb.y + rb.h;
    } else {
      const p = roi.type === 'line' ? { xs: [roi.x1, roi.x2], ys: [roi.y1, roi.y2] } : { xs: roi.points.map((q) => fr(q[0])), ys: roi.points.map((q) => fr(q[1])) };
      x0 = Math.min(...p.xs); x1 = Math.max(...p.xs); y0 = Math.min(...p.ys); y1 = Math.max(...p.ys);
      if ((roi.type === 'polyline' || roi.type === 'point' || roi.type === 'angle') && allInt(p.xs, p.ys)) { x1 += 1; y1 += 1; }
    }
    return [x0 + (x1 - x0) / 2.0, y0 + (y1 - y0) / 2.0];
  }

  /* java.awt.geom.AffineTransform.rotate(theta, ax, ay) of a point: the exact quadrant shortcuts of rotate(double) apply when
   * sin(theta) is exactly ±1 or cos(theta) exactly −1. */
  function affineRotate(theta) {
    const sin = Math.sin(theta);
    if (sin === 1.0) return (x, y, ax, ay) => [ax - (y - ay), ay + (x - ax)];
    if (sin === -1.0) return (x, y, ax, ay) => [ax + (y - ay), ay - (x - ax)];
    const cos = Math.cos(theta);
    if (cos === -1.0) return (x, y, ax, ay) => [ax - (x - ax), ay - (y - ay)];
    if (cos === 1.0) return (x, y) => [x, y];
    return (x, y, ax, ay) => [ax + (x - ax) * cos - (y - ay) * sin, ay + (x - ax) * sin + (y - ay) * cos];
  }

  /* RoiRotator.rotate(roi, angle, xcenter, ycenter): "double theta = -angle*Math.PI/180.0;" — a POSITIVE angle turns clockwise on
   * the screen, a negative one counter-clockwise (the dialog says "Enter negative angle to rotate counter-clockwise"); each vertex:
   * "dx = poly.xpoints[i]-xcenter; dy = ycenter-poly.ypoints[i]; radius = Math.sqrt(dx*dx+dy*dy); a = Math.atan2(dy, dx);
   * poly.xpoints[i] = (float)(xcenter+radius*Math.cos(a+theta)); poly.ypoints[i] = (float)(ycenter-radius*Math.sin(a+theta));".
   * A rotated rectangle turns its two axis points and keeps its width; a composite is rotated as a shape ("at.rotate(angle,
   * xcenter, ycenter)" with the opposite sign of theta). `aroundImageCenter`: the centre is (W/2, H/2) and no centre is remembered. */
  function rotate(roi, angle, aroundImageCenter, W, H) {
    if (!finite(angle)) throw fail('IJ_BAD_ARGS', 'angle');
    const kind = kindOf(roi);
    let c = rotationCenter(roi);
    if (aroundImageCenter) c = [W / 2.0, H / 2.0];
    const xcenter = c[0], ycenter = c[1];
    const theta = -angle * Math.PI / 180.0;
    let out;
    if (kind === 'composite') {
      const rot = affineRotate(-theta);
      const loops = loopsOf(roi).map((l) => l.map((p) => rot(p[0], p[1], xcenter, ycenter)));
      out = loopsRoi(loops, roi);
    } else {
      const rotatedRect = kind === 'polygon' && roi.rotRectWidth !== undefined;
      let poly, rectWidth = 0;
      if (kind === 'line') poly = { xs: [fr(roi.x1), fr(roi.x2)], ys: [fr(roi.y1), fr(roi.y2)] };
      else if (rotatedRect) { const p = rotatedRectParams(roi); poly = { xs: [fr(p[0]), fr(p[2])], ys: [fr(p[1]), fr(p[3])] }; rectWidth = p[4]; }
      else poly = floatPolygon(roi);
      for (let i = 0; i < poly.xs.length; i++) {
        const dx = poly.xs[i] - xcenter, dy = ycenter - poly.ys[i];
        const radius = SQ(dx * dx + dy * dy);
        const a = Math.atan2(dy, dx);
        poly.xs[i] = fr(xcenter + radius * Math.cos(a + theta));
        poly.ys[i] = fr(ycenter - radius * Math.sin(a + theta));
      }
      if (kind === 'line') out = copyName(roi, { type: 'line', x1: poly.xs[0], y1: poly.ys[0], x2: poly.xs[1], y2: poly.ys[1] });
      else if (rotatedRect) out = rotatedRectOfAxis(poly, rectWidth, roi);
      else out = makePoly(transformedKind(kind), poly.xs, poly.ys, roi);
      if (roi.width !== undefined && (out.type === 'line' || out.type === 'polyline')) out.width = roi.width;
    }
    if (!aroundImageCenter) out.rotationCenter = [xcenter, ycenter];
    return { roi: out };
  }
  function rotatedRectOfAxis(poly, rectWidth, src) { return rotatedRect(poly.xs[0], poly.ys[0], poly.xs[1], poly.ys[1], rectWidth, src); }

  /* Selection.translate: "Rectangle2D r = roi.getFloatBounds(); roi.setLocation(r.getX()+dx, r.getY()+dy);" — the selection moves
   * by (dx, dy) and keeps its type, its name and its line width (its spline nodes move with it). */
  function translate(roi, dx, dy) {
    if (!(finite(dx) && finite(dy))) throw fail('IJ_BAD_ARGS', 'offset');
    const out = IJRoi.translate(roi, dx, dy);
    if (Array.isArray(roi.nodeBase)) out.nodeBase = [roi.nodeBase[0] + dx, roi.nodeBase[1] + dy]; // the nodes are relative to it
    if (out.points && !(Number.isInteger(dx) && Number.isInteger(dy))) out.points = out.points.map((p) => [fr(p[0]), fr(p[1])]);
    return { roi: out };
  }

  // ================================================================================================
  // Area to Line, Line to Area — Selection.areaToLine, Roi.convertLineToArea
  // ================================================================================================

  /* A local port of Wand.autoOutline(x, y, lower, upper) in LEGACY mode over a predicate `inside` (thresholded legacy tracing is
   * 8-connected): "if (legacyMode) return; // in legacy mode, don't care what we have got" — the first border found is traced
   * even when it turns out to be an inner hole. Returns the vertices [[x, y]…] or null. */
  function wandLegacy(inside, W, H, startX, startY) {
    if (startX < 0 || startX >= W || startY < 0 || startY >= H) return null;
    let x = startX;
    const y = startY;
    if (inside(x, y)) { do { x++; } while (inside(x, y)); }
    else { do { x++; if (x >= W) return null; } while (!inside(x, y)); }
    const insideDir = (px, py, dir) => {
      switch (dir & 3) { case 0: return inside(px, py); case 1: return inside(px, py - 1); case 2: return inside(px - 1, py - 1); default: return inside(px - 1, py); }
    };
    const pts = [];
    let sy = y;
    const sx = x;
    let startDirection;
    if (inside(sx, sy)) startDirection = 1; else { startDirection = 3; sy++; }
    let cx = sx, cy = sy, direction = startDirection;
    do {
      let nd = direction + 1;
      do { if (insideDir(cx, cy, nd)) break; nd--; } while (nd >= direction);
      if (nd !== direction) { pts.push([cx, cy]); if (pts.length > MAX_VERTS) throw fail('IJ_ROI_TOO_COMPLEX', 'outline'); }
      switch (nd & 3) { case 0: cx++; break; case 1: cy--; break; case 2: cx--; break; default: cy++; }
      direction = nd;
    } while (cx !== sx || cy !== sy || (direction & 3) !== startDirection);
    if (pts[0][0] !== cx) pts.push([cx, cy]);
    return pts;
  }

  /* OvalRoi.getPolygon(): "Wand wand = new Wand(mask); wand.autoOutline(width/2,height/2, 255, 255);" + the integer origin. */
  function ovalIntegerPolygon(roi) {
    const w = roi.w, h = roi.h;
    const m = IJRoi.mask({ type: 'oval', x: roi.x, y: roi.y, w, h });
    const inside = (px, py) => px >= 0 && py >= 0 && px < m.w && py < m.h && m.data[py * m.w + px] === 1;
    const pts = wandLegacy(inside, m.w, m.h, Math.floor(m.w / 2), Math.floor(m.h / 2));
    if (!pts) throw fail('IJ_EMPTY_ROI', 'empty selection');
    return { xs: pts.map((p) => p[0] + m.x), ys: pts.map((p) => p[1] + m.y) };
  }

  /* Selection.areaToLine — "Polygon p = roi.getPolygon(); FloatPolygon fp = (roi.subPixelResolution()) ? roi.getFloatPolygon() :
   * null; … if (type1==Roi.COMPOSITE) error "Composite selections cannot be converted to lines."; if (fp==null && type1==Roi.TRACED_ROI)
   * { clamp the vertices to the image } int type2 = Roi.POLYLINE; if (type1==Roi.OVAL||type1==Roi.FREEROI||type1==Roi.TRACED_ROI||
   * ((roi instanceof PolygonRoi)&&((PolygonRoi)roi).isSplineFit())) type2 = Roi.FREELINE; … roi2.setLocation(bounds.x - 0.5,
   * bounds.y -0.5); //area and line roi coordinates are 0.5 pxl different" — the vertices move by −0.5 in x and y. */
  function areaToLine(roi, W, H) {
    const kind = kindOf(roi);
    if (!isAreaKind(kind)) throw fail('IJ_SEL_NEEDS_AREA', 'area selection required');
    if (kind === 'composite') throw fail('IJ_SEL_COMPOSITE', 'composite selections cannot be converted to lines');
    let xs, ys;
    let sub = false;
    if (kind === 'rect') { sub = !(Number.isInteger(roi.x) && Number.isInteger(roi.y) && Number.isInteger(roi.w) && Number.isInteger(roi.h)); }
    else if (kind !== 'oval') sub = !allInt(roi.points.map((p) => p[0]), roi.points.map((p) => p[1]));
    if (kind === 'oval') { const p = ovalIntegerPolygon(roi); xs = p.xs; ys = p.ys; }
    else if (sub) { const p = floatPolygon(roi); xs = p.xs; ys = p.ys; }
    else if (kind === 'rect') { const p = floatPolygon(roi); xs = p.xs; ys = p.ys; }
    else { xs = roi.points.map((p) => jround(p[0])); ys = roi.points.map((p) => jround(p[1])); }
    if (!sub && kind === 'traced') {
      for (let i = 0; i < xs.length; i++) { if (xs[i] >= W) xs[i] = W - 1; if (ys[i] >= H) ys[i] = H - 1; }
    }
    let type2 = 'polyline';
    if (kind === 'oval' || kind === 'freehand' || kind === 'traced' || roi.spline) type2 = 'freeline';
    let ox = -0.5, oy = -0.5; // setLocation(bounds.x - 0.5, …) of a polygon whose own origin is its first-vertex minimum …
    if (roi.ellipse && sub) {
      // … but an EllipseRoi's getFloatBounds() is the integer box: the vertices land at floor(min) − 0.5 (fixture ellipse.json areaToLine)
      ox = Math.floor(Math.min(...xs)) - 0.5 - Math.min(...xs); oy = Math.floor(Math.min(...ys)) - 0.5 - Math.min(...ys);
    }
    const out = makePoly(type2, xs.map((x) => x + ox), ys.map((y) => y + oy), roi);
    return { roi: out };
  }

  /* A mask (dense, box bx, by, bw, bh) as ThresholdToSelection builds a selection: ONE outline without a hole is a traced polygon,
   * anything else a composite. */
  function selectionOfMask(dense, bx, by, bw, bh, src) {
    const r = IJRoi.fromMask(dense, bw, bh);
    if (!r.w || !r.h) return null;
    const m = IJRoi.translate(r, bx, by);
    let loops;
    try { loops = IJRoi.outlines(m); } catch (e) { return copyName(src, m); }
    if (loops.length === 1) return copyName(src, { type: 'polygon', points: loops[0].map((p) => [p[0], p[1]]), traced: true });
    return copyName(src, m);
  }

  /* Roi.convertLineToArea — "double lineWidth = line.getStrokeWidth(); if (lineWidth<1.0) lineWidth = 1.0;" a straight line becomes
   * a RotatedRectRoi of that width; a polyline / freeline is painted into a ByteProcessor of "(int)Math.round(bounds.x+bounds.width
   * + lineWidth)" with one rectangle per segment and one triangle per joint ("polygonFiller.setPolygon(xv, yv, 4, 0.5f, 0.5f)":
   * line vs area coordinates differ by 0.5 pixel), then "ThresholdToSelection.convert(ip)". `ctl` = { check() } (cancel). */
  function lineToArea(roi, ctl) {
    const kind = kindOf(roi);
    if (!isLineKind(kind)) throw fail('IJ_SEL_NEEDS_LINE', 'line selection required');
    let lineWidth = roi.width === undefined ? 1.0 : roi.width;
    if (lineWidth < 1.0) lineWidth = 1.0;
    if (kind === 'line') {
      const out = rotatedRect(fr(roi.x1), fr(roi.y1), fr(roi.x2), fr(roi.y2), lineWidth, roi);
      return { roi: out };
    }
    const p = floatPolygon(roi);
    const xs = p.xs, ys = p.ys;
    const n = xs.length;
    if (n < 2) throw fail('IJ_EMPTY_ROI', 'empty selection');
    // Roi.getBounds of a polyline: the integer box of the vertices, one pixel larger ("width++" for open polylines)
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < n; i++) { if (xs[i] < minX) minX = xs[i]; if (xs[i] > maxX) maxX = xs[i]; if (ys[i] < minY) minY = ys[i]; if (ys[i] > maxY) maxY = ys[i]; }
    const allI = allInt(xs, ys);
    const bx = Math.floor(minX), by = Math.floor(minY);
    const bw = (allI ? maxX - bx : Math.ceil(maxX) - bx) + 1, bh = (allI ? maxY - by : Math.ceil(maxY) - by) + 1;
    const W = jround(bx + bw + lineWidth), H = jround(by + bh + lineWidth);
    if (!(W > 0 && H > 0) || W * H > 1 << 28) throw fail('IJ_ROI_TOO_COMPLEX', 'line too large');
    const ip = new Uint8Array(W * H);
    // A zero-length segment (a repeated vertex) has no direction: its unit vector is 0/0 = NaN, as in ImageJ, and "if
    // (Float.isNaN(xf[i])) polyStart = i + 1; continue;" (PolygonFiller.buildEdgeTable) makes a polygon with a NaN vertex fill nothing —
    // neither the rectangle of that segment nor the triangles of its two joints.
    const fill = (xv, yv) => {
      if (xv.some(Number.isNaN) || yv.some(Number.isNaN)) return;
      const m = IJRoi.mask({ type: 'polygon', points: xv.map((x, i) => [x + 0.5, yv[i] + 0.5]) }, W, H);
      for (let j = 0; j < m.h; j++) {
        const dst = (m.y + j) * W + m.x, src = j * m.w;
        for (let i = 0; i < m.w; i++) if (m.data[src + i]) ip[dst + i] = 255;
      }
    };
    const radius = lineWidth / 2.0;
    let dx1 = xs[1] - xs[0], dy1 = ys[1] - ys[0];
    let l = SQ(dx1 * dx1 + dy1 * dy1);
    dx1 = dx1 / l; dy1 = dy1 / l; // unit vector along current line segment
    let dx0 = dx1, dy0 = dy1;
    let xfrom = xs[0] - 0.5 * dx1, yfrom = ys[0] - 0.5 * dy1;
    for (let i = 1; i < n; i++) { // line segment from point i-1 ("from") to point i ("to")
      let xto = xs[i], yto = ys[i];
      if (i === n - 1) { xto += 0.5 * dx1; yto += 0.5 * dy1; }
      const xv = [fr(xfrom + radius * dy1), fr(xfrom - radius * dy1), fr(xto - radius * dy1), fr(xto + radius * dy1)];
      const yv = [fr(yfrom - radius * dx1), fr(yfrom + radius * dx1), fr(yto + radius * dx1), fr(yto - radius * dx1)];
      fill(xv, yv);
      if (i > 1) { // fill triangle to previous line segment
        const rightTurn = dx1 * dy0 > dx0 * dy1;
        const xt = [fr(xfrom), 0, 0], yt = [fr(yfrom), 0, 0];
        if (rightTurn) {
          xt[1] = fr(xfrom - radius * dy0); yt[1] = fr(yfrom + radius * dx0);
          xt[2] = fr(xfrom - radius * dy1); yt[2] = fr(yfrom + radius * dx1);
          xt[0] += fr(0.5 * (radius * dy0 + radius * dy1)); // extend triangle to avoid missing pixels
          yt[0] -= fr(0.5 * (radius * dx0 + radius * dx1));
        } else {
          xt[1] = fr(xfrom + radius * dy0); yt[1] = fr(yfrom - radius * dx0);
          xt[2] = fr(xfrom + radius * dy1); yt[2] = fr(yfrom - radius * dx1);
          xt[0] -= fr(0.5 * (radius * dy0 + radius * dy1));
          yt[0] += fr(0.5 * (radius * dx0 + radius * dx1));
        }
        xt[0] = fr(xt[0]); yt[0] = fr(yt[0]);
        fill(xt, yt);
      }
      dx0 = dx1; dy0 = dy1;
      xfrom = xto; yfrom = yto;
      if (i < n - 1) {
        dx1 = xs[i + 1] - xs[i]; dy1 = ys[i + 1] - ys[i];
        l = SQ(dx1 * dx1 + dy1 * dy1);
        dx1 = dx1 / l; dy1 = dy1 / l; // unit vector along next line segment
      }
      if (ctl && ctl.check) ctl.check();
    }
    const out = selectionOfMask(ip, 0, 0, W, H, roi);
    if (!out) throw fail('IJ_EMPTY_ROI', 'empty selection');
    return { roi: out };
  }

  // ================================================================================================
  // Make Band — Selection.makeBand
  // ================================================================================================

  /* Selection.makeBand: the selection's mask is painted into an image-sized ByteProcessor (255 inside), its "Distance Map" is taken
   * with Prefs.blackBackground forced to false and EDM output BYTE_OVERWRITE (so objects are the 0 pixels OUTSIDE the selection and
   * each gets its distance to the selection, rounded to a byte: "value = fPixels[i] + 0.5f; … (byte)value"), the threshold 0..n
   * is set and the Wand traces from the first pixel < n inside the selection's bounds:
   *   "for (int y=Math.max(r.y,0); y<Math.min(r.y+r.height, height); y++) { for (x…) { if (ip.getPixel(x, y)<n) { xx=x; yy=y; break; }"
   *   "int count = IJ.doWand(edm, xx, yy, 0, null);" (legacy mode, thresholded: 8-connected, the first outline found)
   * and the result is "roi2.not(roi1)": the traced region minus the selection. Cooperative: `ctl` = { tick(f), check() }.
   * Max 255 pixels (the byte EDM saturates). */
  async function makeBand(roi, n, W, H, ctl) {
    const kind = kindOf(roi);
    if (!isAreaKind(kind)) throw fail('IJ_SEL_NEEDS_AREA', 'area selection required');
    if (!Number.isInteger(n) || n < 0) throw fail('IJ_BAD_ARGS', 'band size');
    if (n > 255) throw fail('IJ_SEL_BAND_TOO_WIDE', 'cannot make bands wider than 255 pixels');
    const tick = async (f) => { if (ctl && ctl.tick) await ctl.tick(f); };
    const check = () => { if (ctl && ctl.check) ctl.check(); };
    // Roi.getBounds: a float polygon "(int)(max-iMin+0.5)", every other selection its integer box
    const r = kind === 'polygon' || kind === 'traced' || kind === 'freehand' ? IJRoiTools.roiBounds(roi) : IJRoi.bounds(roi);
    const mask = new Uint8Array(W * H);
    let mm;
    if (kind === 'rect') {
      const b = IJRoi.bounds(roi);
      mm = { x: Math.max(0, b.x), y: Math.max(0, b.y), w: 0, h: 0, data: null };
      const x1 = Math.min(W, b.x + b.w), y1 = Math.min(H, b.y + b.h);
      mm.w = Math.max(0, x1 - mm.x); mm.h = Math.max(0, y1 - mm.y);
      mm.data = new Uint8Array(mm.w * mm.h).fill(1); // a rectangle has no mask: the whole box is inserted
    } else mm = IJRoiTools.roiMaskBox(roi, W, H);
    for (let j = 0; j < mm.h; j++) { const o = (mm.y + j) * W + mm.x, s = j * mm.w; for (let i = 0; i < mm.w; i++) if (mm.data[s + i]) mask[o + i] = 255; if ((j & 127) === 127) check(); }
    mm = null; // the box mask is not needed any more
    check();
    let f = await IJShared.makeFloatEDMAsync(mask, W, H, { backgroundValue: 255, edgesAreBackground: false, tick: ctl && ctl.tick ? (v) => ctl.tick(0.05 + 0.8 * v) : null, check: ctl && ctl.check ? () => ctl.check() : null });
    const edm = new Uint8Array(W * H);
    for (let i = 0; i < edm.length; i++) {
      let v = fr(f[i] + 0.5);
      if (v < 0) v = 0;
      if (v > 255) v = 255;
      edm[i] = v;
      if ((i & 0xfffff) === 0xfffff) check();
    }
    f = null; // the 4 B/px float EDM goes before the region and the dense mask are allocated
    await tick(0.9);
    let xx = -1, yy = -1;
    for (let y = Math.max(r.y, 0); y < Math.min(r.y + r.h, H); y++) {
      for (let x = Math.max(r.x, 0); x < Math.min(r.x + r.w, W); x++) if (edm[y * W + x] < n) { xx = x; yy = y; break; }
      if (xx >= 0 || yy >= 0) break;
    }
    const inside = (x, y) => x >= 0 && y >= 0 && x < W && y < H && edm[y * W + x] <= n; // ip.setThreshold(0, n)
    const loop = xx < 0 ? null : wandLegacy(inside, W, H, xx, yy);
    if (!loop || loop.length < 3) throw fail('IJ_SEL_NO_BAND', 'unable to make band');
    check();
    const region = IJRoi.mask({ type: 'polygon', points: loop }, W, H);
    // "roi2.not(roi1)": region − selection
    const dense = new Uint8Array(region.w * region.h);
    for (let j = 0; j < region.h; j++) {
      for (let i = 0; i < region.w; i++) {
        if (!region.data[j * region.w + i]) continue;
        if (mask[(region.y + j) * W + region.x + i]) continue;
        dense[j * region.w + i] = 1;
      }
      if ((j & 127) === 127) check();
    }
    await tick(1);
    const m = IJRoi.fromMask(dense, region.w, region.h);
    if (!m.w || !m.h) throw fail('IJ_SEL_NO_BAND', 'unable to make band');
    return { roi: copyName(roi, IJRoi.translate(m, region.x, region.y)) };
  }

  // ================================================================================================
  // Straighten — ij.plugin.Straightener.straightenLine
  // ================================================================================================

  /* The nodes of the line Straighten works on: "if (type==Roi.FREELINE) IJ.run(imp, "Fit Spline", "")" first (trim → polyline), a
   * spline-fitted polyline goes back to its nodes ("if (roi.isSplineFit()) roi.removeSplineFit()"), a straight Line becomes a
   * 2-point polyline ("new PolygonRoi(fp.xpoints, fp.ypoints, 2, Roi.POLYLINE)"). */
  function straightenNodes(roi) {
    const kind = kindOf(roi);
    if (kind === 'line') return relNodes([fr(roi.x1), fr(roi.x2)], [fr(roi.y1), fr(roi.y2)]);
    if (kind === 'polyline' || kind === 'angle') return nodesOf(roi);
    if (kind === 'freeline') {
      const r = fitSpline(roi).roi;
      return { xr: r.nodes.map((p) => p[0]), yr: r.nodes.map((p) => p[1]), bx: r.nodeBase[0], by: r.nodeBase[1] };
    }
    throw fail('IJ_SEL_NEEDS_LINE', 'line selection required');
  }

  /* straightenLine: the equidistant (≈1 pixel) points p of the spline, then for each point the `width` perpendicular samples:
   *   "double x2 = p.xpoints[0]-(p.xpoints[1]-p.xpoints[0]);" (extrapolate back one pixel)  "dx = x2-x1; dy = y1-y2; double length =
   *   (float)Math.sqrt(dx*dx+dy*dy); dx /= length; dy /= length; double x = x2-dy*(width-1)/2.0; double y = y2-dx*(width-1)/2.0;"
   *   "ip2.putPixelValue(i, j++, ip.getInterpolatedValue(x, y)); x += dy; y += dx;"   (width 1: the value at the point itself)
   * The result of one plane is a FloatProcessor of n × width. img = { data, width, height }. Returns { data: Float32Array, w, h }. */
  function straightenPlane(img, p, width, tick) {
    const n = p.xs.length;
    const out = new Float32Array(n * width);
    let x2 = fr(p.xs[0] - fr(p.xs[1] - p.xs[0])), y2 = fr(p.ys[0] - fr(p.ys[1] - p.ys[0]));
    if (width <= 1) out[0] = IJRoiTools.interpolatedValue(img.data, img.width, img.height, x2, y2);
    for (let i = 0; i < n; i++) {
      const x1 = x2, y1 = y2;
      x2 = p.xs[i]; y2 = p.ys[i];
      if (width === 1) { out[i] = IJRoiTools.interpolatedValue(img.data, img.width, img.height, x2, y2); continue; }
      let dx = x2 - x1, dy = y1 - y2;
      const length = fr(SQ(dx * dx + dy * dy));
      dx /= length; dy /= length;
      let x = x2 - dy * (width - 1) / 2.0, y = y2 - dx * (width - 1) / 2.0;
      let n2 = width, j = 0;
      do {
        out[j++ * n + i] = IJRoiTools.interpolatedValue(img.data, img.width, img.height, x, y);
        x += dy; y += dx;
      } while (--n2 > 0);
      if (tick && (i & 1023) === 1023) tick(i / n);
    }
    return { data: out, w: n, h: width };
  }

  function straightenPoints(roi) {
    const nodes = straightenNodes(roi);
    if (nodes.xr.length < 2) throw fail('IJ_SEL_NEEDS_LINE', 'line selection required');
    const p = straighteningPoints(nodes);
    if (!p || p.xs.length < 2) throw fail('IJ_SEL_NEEDS_LINE', 'line too short');
    return p;
  }

  /* TypeConverter.convertFloatToByte (doScaling false): "value = fPixels[i] + 0.5f; if (value<0f) value = 0f; if (value>255f) value
   * = 255f; pixels[i] = (byte)value;" and convertFloatToShort: "value = pixels32[i]; … (short)(value+0.5)". */
  function backToDepth(f, bitDepth) {
    const n = f.length;
    if (bitDepth === 8) {
      const o = new Uint8Array(n);
      for (let i = 0; i < n; i++) { let v = fr(f[i] + 0.5); if (v < 0) v = 0; if (v > 255) v = 255; o[i] = v; }
      return o;
    }
    const o = new Uint16Array(n);
    for (let i = 0; i < n; i++) { let v = f[i]; if (v < 0.0) v = 0.0; if (v > 65535.0) v = 65535.0; o[i] = v + 0.5; }
    return o;
  }

  /* Straightener.run: "if (imp.isComposite()) processStack = true" — a multichannel image is straightened channel by channel and
   * comes back in the bit depth of the source ("ImageConverter.setDoScaling(false); if (imp.getBitDepth()==8) convertToGray8()");
   * a single-channel image gives the FloatProcessor of straightenLine (32-bit). Returns { width, height, bitDepth, planes[] }. */
  function straightenPlanes(view, roi, width, ctl) {
    if (!Number.isInteger(width) || width < 1) throw fail('IJ_BAD_ARGS', 'width');
    const p = straightenPoints(roi);
    if (p.xs.length * width > 1 << 27) throw fail('IJ_TOO_LARGE', 'straightened image too large');
    const C = view.channels.length;
    const planes = [];
    for (let c = 0; c < C; c++) {
      const r = straightenPlane({ data: view.channels[c].data, width: view.width, height: view.height }, p, width, (f) => { if (ctl && ctl.check) ctl.check(); if (ctl && ctl.tick) ctl.tick((c + f) / C); });
      planes.push(r.data);
      if (ctl && ctl.check) ctl.check();
      if (ctl && ctl.tick) ctl.tick((c + 1) / C);
    }
    const bitDepth = C > 1 ? view.bitDepth : 32;
    const out = C > 1 && view.bitDepth !== 32 ? planes.map((f) => backToDepth(f, view.bitDepth)) : planes;
    return { width: p.xs.length, height: width, bitDepth, planes: out };
  }

  // ================================================================================================
  // Registry operations
  // ================================================================================================

  const px = (info) => info.width * info.height;

  IJOpRegistry.define('makeBand', {
    kind: 'compute', version: 1, channels: 'one', roi: 'ignore', preview: false,
    validate(p) { if (!p || !Number.isInteger(p.n) || p.n < 0 || p.n > 255) throw fail('IJ_BAD_ARGS', 'band size'); },
    scratchBytes: (info) => px(info) * 9 + 65536, // mask 1 + float EDM 4 + byte EDM 1 + box mask ≤ 1 (peak), then mask + EDM + region ≤ 1 + dense ≤ 1
    async run(view, p, roi, io) {
      if (!roi || !IJRoi.isArea(roi)) throw fail('IJ_NEEDS_ROI', 'an area selection is needed');
      io.check();
      return makeBand(roi, p.n, view.width, view.height, { tick: (f) => io.tick(f, 'op.makeBand'), check: () => io.check() });
    }
  });

  IJOpRegistry.define('lineToArea', {
    kind: 'compute', version: 1, channels: 'one', roi: 'ignore', preview: false,
    validate() {},
    scratchBytes(info) {
      const r = info.roi;
      let b = { x: 0, y: 0, w: info.width, h: info.height };
      try { if (r && (r.type === 'polyline' || r.type === 'line' || r.type === 'angle')) b = IJRoi.bounds(r); } catch (e) { /* the run reports a bad selection */ }
      const w = r && r.width > 1 ? r.width : 1;
      return (b.x + b.w + w + 2) * (b.y + b.h + w + 2) * 3 + 65536;
    },
    async run(view, p, roi, io) {
      if (!roi || !(roi.type === 'polyline' || roi.type === 'line' || roi.type === 'angle')) throw fail('IJ_NEEDS_ROI', 'a line selection is needed');
      io.check();
      return lineToArea(roi, { check: () => io.check() });
    }
  });

  IJOpRegistry.define('straighten', {
    kind: 'newdoc', version: 1, channels: 'all', roi: 'ignore', preview: false,
    validate(p) {
      if (!p || !Number.isInteger(p.width) || p.width < 1 || p.width > 4096) throw fail('IJ_BAD_ARGS', 'line width');
      if (p.title !== undefined && (typeof p.title !== 'string' || p.title.length > 255)) throw fail('IJ_BAD_ARGS', 'title');
    },
    scratchBytes(info, p) {
      const r = info.roi;
      let len = 0;
      if (r && r.points) for (let i = 1; i < r.points.length; i++) len += Math.hypot(r.points[i][0] - r.points[i - 1][0], r.points[i][1] - r.points[i - 1][1]);
      else if (r && r.type === 'line') len = Math.hypot(r.x2 - r.x1, r.y2 - r.y1);
      else len = Math.max(info.width, info.height) * 4;
      const n = Math.ceil(len * 2) + 8, width = p && p.width ? p.width : 20;
      return (n * 8 + Math.ceil(len + 2) * width * 4 * 2 * Math.max(1, info.channels)) + 65536;
    },
    async run(view, p, roi, io) {
      if (!roi || !(roi.type === 'polyline' || roi.type === 'line' || roi.type === 'angle')) throw fail('IJ_NEEDS_ROI', 'a line selection is needed');
      io.check();
      // io.tick is asynchronous; the pixel loop is synchronous, so its promise is not awaited (a cancel is seen by the next check())
      const res = straightenPlanes(view, roi, p.width, { check: () => io.check(), tick: (f) => { const t = io.tick(f, 'op.straighten'); if (t && t.catch) t.catch(() => {}); } });
      io.check();
      const src = view.channels;
      const cal = view.calibration;
      // "if (cal.pixelWidth==cal.pixelHeight) imp2.setCalibration(cal)"
      const keepCal = cal && cal.pixelWidth === cal.pixelHeight ? Object.assign({}, cal) : undefined;
      const name = typeof p.title === 'string' && p.title.length ? p.title : view.name;
      const channels = res.planes.map((data, c) => {
        const ch = { name: src[c].name, color: src[c].color, data };
        if (res.bitDepth === 32) {
          // "ip2.setColorModel(ip.getColorModel()); ip2.resetMinAndMax()"
          let mn = Infinity, mx = -Infinity;
          for (let i = 0; i < data.length; i++) { const v = data[i]; if (v === v && v !== Infinity && v !== -Infinity) { if (v < mn) mn = v; if (v > mx) mx = v; } }
          if (!(mn <= mx)) { mn = 0; mx = 1; }
          ch.display = Object.assign({}, src[c].display, { min: mn, max: mx });
        } else ch.display = Object.assign({}, src[c].display);
        return ch;
      });
      return [{ name, width: res.width, height: res.height, bitDepth: res.bitDepth, calibration: keepCal || { pixelWidth: 1, pixelHeight: 1, unit: 'pixel' }, channels }];
    }
  });

  root.IJSelOps = {
    kindOf, fitSpline, fitCircle, fitRectangle, interpolate, scale, rotate, translate, areaToLine, lineToArea, makeBand,
    straightenPlanes, straightenPoints, interpolatePolygon, getSpline, splineFitter, trimPolygonInt, trimPolygonFloat, floatPolygon,
    rotatedRectParams, affineRotate, wandLegacy
  };
})(typeof self !== 'undefined' ? self : globalThis);
