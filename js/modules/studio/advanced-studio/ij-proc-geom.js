/* ij-proc-geom.js — package P5 (geom): Rotate, Scale, Resize, Canvas Size, Translate, Bin, Set Scale / Properties.
 *
 * Loaded on the page AND in the worker (ij-worker.js loads it in its own try/catch: a failure here disables the
 * package's commands, it never takes the Advanced view down). Pure: no DOM, no engine globals; the operations
 * are registered with IJOpRegistry.define(name, spec) (ij-core.js, PLAN-wave2 §2.1).
 *
 *   rotate         pixel   ImageProcessor.rotate (Byte/Short/FloatProcessor), the Rotator plugin: positive = clockwise,
 *                          centre (roiX + (roiW-1)/2, roiY + (roiH-1)/2), None / Bilinear / Bicubic, background 0;
 *                          with an area selection: the rectangle's content, rotated in place (SUPPORTS_MASKING)
 *   rotateEnlarge  size    Rotator.enlargeCanvas() (RoiRotator bounds of the whole image → Canvas Size, centred, zero
 *                          fill) then ip.rotate(angle) on the new canvas
 *   scaleInPlace   pixel   ImageProcessor.scale (the canvas does not change)
 *   scaleNew       newdoc  ImageProcessor.resize(w, h, averageWhenDownsizing) in a new image, Scaler.scale(imp)
 *   resize         size    Image > Adjust > Size (Resizer): StackProcessor.resize → ip.resize(w, h, averageWhenDownsizing)
 *   canvasSize     size    CanvasResizer.expandImage, 9 anchors, zero fill
 *   translate      pixel   ImageProcessor.translate (Translator)
 *   bin            size    Binner.shrink
 *   setCalibration size    calibration only (Image > Properties, Analyze > Set Scale): the arrays are not touched
 *
 * Every op is deterministic and band-invariant: an output pixel depends only on the source image and the
 * parameters, never on the band the engine happens to compute it in (the pixel ops answer through `region`).
 * Java arithmetic is reproduced where it decides a value: `(int)` is Math.trunc, `(float)` is Math.fround,
 * `(byte)(v+0.5)` stores v+0.5 in the typed array (truncation), float accumulations round at every step.
 *
 * Reference: ImageJ 1.54p (public domain), cited at each port as Class.method with the lines that settle the trap.
 */
(function (root) {
  'use strict';
  // Local aliases: in a vm context (tests, bench) every `Math.x` is a lookup through the contextified global, ~50x slower than a closure variable in a hot loop.
  const { abs: M_abs, ceil: M_ceil, cos: M_cos, floor: M_floor, fround: M_fround, max: M_max, min: M_min, round: M_round, sin: M_sin, sqrt: M_sqrt, trunc: M_trunc, atan2: M_atan2 } = Math;
  const R = root.IJOpRegistry;
  if (!R) return;

  function fail(code, message) {
    const e = new Error(message || code);
    e.code = code;
    return e;
  }
  const bad = (m) => fail('IJ_BAD_ARGS', m);
  const isInt = (n) => typeof n === 'number' && Number.isInteger(n);
  const isNum = (n) => typeof n === 'number' && isFinite(n);
  const NONE = 0, BILINEAR = 1, BICUBIC = 2;
  const METHOD = { none: NONE, bilinear: BILINEAR, bicubic: BICUBIC };
  const bppOf = (bd) => bd / 8;
  const FLT_MAX = 3.4028234663852886e38;
  const TICK_PIXELS = 1 << 19;     // work between two progress ticks of a size / newdoc op (a count, never a clock)

  // ─────────────────────────── interpolation (ImageProcessor) ───────────────────────────

  /* ImageProcessor.cubic: Catmull-Rom, a = 0.5.
   *   z = x*x*(x*(-a+2.0) + (a-3.0)) + 1.0;   (|x| < 1)
   *   z = -a*x*x*x + 5.0*a*x*x - 8.0*a*x + 4.0*a;   (1 <= |x| < 2) */
  const A = 0.5;
  function cubic(x) {
    if (x < 0.0) x = -x;
    let z = 0.0;
    if (x < 1.0) z = x * x * (x * (-A + 2.0) + (A - 3.0)) + 1.0;
    else if (x < 2.0) z = -A * x * x * x + 5.0 * A * x * x - 8.0 * A * x + 4.0 * A;
    return z;
  }

  // Byte/ShortProcessor.getInterpolatedPixel(x, y, pixels): the private bilinear, x in [0, w-1), y in [0, h-1).
  function bilI(p, W, x, y) {
    const xb = x | 0, yb = y | 0;
    const xf = x - xb, yf = y - yb;
    const o = yb * W + xb;
    const ll = p[o], lr = p[o + 1], ur = p[o + W + 1], ul = p[o + W];
    const ua = ul + xf * (ur - ul);
    const la = ll + xf * (lr - ll);
    return la + yf * (ua - la);
  }

  /* FloatProcessor.getInterpolatedPixel(x, y, pixels): the same, with the NaN handling of the source:
   *   if (Double.isNaN(upperLeft ) && xFraction>=0.5) upperAverage = upperRight;
   *   else if (Double.isNaN(upperRight) && xFraction<0.5 ) upperAverage = upperLeft; ... (same for the lower pair)
   *   if (Double.isNaN(lowerAverage) && yFraction>=0.5) return upperAverage;
   *   else if (Double.isNaN(upperAverage) && yFraction<0.5 ) return lowerAverage; */
  function bilF(p, W, x, y) {
    const xb = x | 0, yb = y | 0;
    const xf = x - xb, yf = y - yb;
    const o = yb * W + xb;
    const ll = p[o], lr = p[o + 1], ur = p[o + W + 1], ul = p[o + W];
    let ua;
    if (ul !== ul && xf >= 0.5) ua = ur;
    else if (ur !== ur && xf < 0.5) ua = ul;
    else ua = ul + xf * (ur - ul);
    let la;
    if (ll !== ll && xf >= 0.5) la = lr;
    else if (lr !== lr && xf < 0.5) la = ll;
    else la = ll + xf * (lr - ll);
    if (la !== la && yf >= 0.5) return ua;
    if (ua !== ua && yf < 0.5) return la;
    return la + yf * (ua - la);
  }

  /* ImageProcessor.getBilinearInterpolatedPixel(x, y) on the copy `ip2` (background 0 in every caller: Rotator and
   * Scaler set 0, a fresh Short/FloatProcessor starts at 0, a bicubic resize never leaves [-1, w)):
   *   if (x>=-1 && x<width && y>=-1 && y<height) { ... getInterpolatedPixel(x, y) ... } else return getBackgroundValue();
   * with the public getInterpolatedPixel clamping: x<0 → 0; x>=width-1.0 → width-1.001 (same for y). */
  function bilEdge(p, W, H, x, y, isF) {
    if (x >= -1 && x < W && y >= -1 && y < H) {
      if (x < 0.0) x = 0.0;
      if (x >= W - 1.0) x = W - 1.001;
      if (y < 0.0) y = 0.0;
      if (y >= H - 1.0) y = H - 1.001;
      return isF ? bilF(p, W, x, y) : bilI(p, W, x, y);
    }
    return 0;
  }

  /* ImageProcessor.getBicubicInterpolatedPixel(x0, y0, ip2) (Burger & Burge):
   *   if (u0<=0 || u0>=width-2 || v0<=0 || v0>=height-2) return ip2.getBilinearInterpolatedPixel(x0, y0);
   *   for (j = 0..3) { v = v0-1+j; p = 0; for (i = 0..3) { u = u0-1+i; p = p + ip2.get(u,v) * cubic(x0 - u); } q = q + p * cubic(y0 - v); }
   * The loops are unrolled, in the source's order (the sums start from 0 and add left to right, so every double is the
   * same). The value leaves through RES[0]: a function that returns a double boxes it, which cost this kernel 6x. */
  const RES = new Float64Array(1);
  function bicubic(p, W, H, x0, y0, isF) {
    const u0 = M_floor(x0), v0 = M_floor(y0);
    if (u0 <= 0 || u0 >= W - 2 || v0 <= 0 || v0 >= H - 2) { RES[0] = bilEdge(p, W, H, x0, y0, isF); return; }
    const w0 = cubic(x0 - (u0 - 1)), w1 = cubic(x0 - u0), w2 = cubic(x0 - (u0 + 1)), w3 = cubic(x0 - (u0 + 2));
    const z0 = cubic(y0 - (v0 - 1)), z1 = cubic(y0 - v0), z2 = cubic(y0 - (v0 + 1)), z3 = cubic(y0 - (v0 + 2));
    let r = (v0 - 1) * W + (u0 - 1);
    let s = 0;
    s = s + p[r] * w0; s = s + p[r + 1] * w1; s = s + p[r + 2] * w2; s = s + p[r + 3] * w3;
    let q = 0 + s * z0;
    r += W; s = 0;
    s = s + p[r] * w0; s = s + p[r + 1] * w1; s = s + p[r + 2] * w2; s = s + p[r + 3] * w3;
    q = q + s * z1;
    r += W; s = 0;
    s = s + p[r] * w0; s = s + p[r + 1] * w1; s = s + p[r + 2] * w2; s = s + p[r + 3] * w3;
    q = q + s * z2;
    r += W; s = 0;
    s = s + p[r] * w0; s = s + p[r + 1] * w1; s = s + p[r + 2] * w2; s = s + p[r + 3] * w3;
    q = q + s * z3;
    RES[0] = q;
  }

  // Result of a bicubic read as a stored value: `int value = (int)(q+0.5); if (value<0) value = 0; if (value>MAX) ...`
  function bicubicInt(q, maxV) {
    let v = M_trunc(q + 0.5);
    if (v < 0) v = 0;
    if (v > maxV) v = maxV;
    return v;
  }

  // ─────────────────────────── Rotate ───────────────────────────

  /* ByteProcessor.rotate / ShortProcessor.rotate / FloatProcessor.rotate (1.54p), for the band
   * (bx, by, bw, bh) of the output; `src` is the whole image (the source of every pixel), rr the rotation
   * rectangle (the selection's bounds, or the image).
   *
   *   if (angle%360==0) return;                                  — ByteProcessor ONLY (Short/Float rotate by 0
   *                                                                 and so alter the last row / column: the
   *                                                                 clamp `xs>=xlimit → xlimit2` interpolates)
   *   double centerX = roiX + (roiWidth-1)/2.0;
   *   double centerY = roiY + (roiHeight-1)/2.0;
   *   double angleRadians = -angle/(180.0/Math.PI);
   *   double tmp1 = centerY*sa-centerX*ca;  double tmp2 = -centerX*sa-centerY*ca;
   *   tmp3 = tmp1 - y*sa + centerX;  tmp4 = tmp2 + y*ca + centerY;  xs = x*ca + tmp3;  ys = x*sa + tmp4;
   *   if ((xs>=-0.01) && (xs<dwidth) && (ys>=-0.01) && (ys<dheight)) { BILINEAR: clamp to [0, w-1.001] then
   *       (byte)(getInterpolatedPixel(xs, ys, pixels2)+0.5);  NONE: ixs = (int)(xs+0.5) ... pixels2[width*iys+ixs]
   *   } else pixels[index++] = (byte)bgColor;                    — background 0 (Rotator: ip.setBackgroundValue(0))
   *   BICUBIC: no bounds test, getBicubicInterpolatedPixel(xs, ys, ip2) (value (int)(q+0.5) clamped; float: (float)q) */
  function rotateBand(src, W, H, bd, rr, angle, method, bx, by, bw, bh) {
    const out = new src.constructor(bw * bh);
    if (bd === 8 && angle % 360 === 0) {
      for (let y = 0; y < bh; y++) out.set(src.subarray((by + y) * W + bx, (by + y) * W + bx + bw), y * bw);
      return out;
    }
    const isF = bd === 32, maxV = bd === 8 ? 255 : 65535;
    const centerX = rr.x + (rr.w - 1) / 2.0, centerY = rr.y + (rr.h - 1) / 2.0;
    const rad = -angle / (180.0 / Math.PI);
    const ca = M_cos(rad), sa = M_sin(rad);
    const tmp1 = centerY * sa - centerX * ca, tmp2 = -centerX * sa - centerY * ca;
    const xlimit = W - 1.0, xlimit2 = W - 1.001, ylimit = H - 1.0, ylimit2 = H - 1.001;
    for (let y = by; y < by + bh; y++) {
      const tmp3 = tmp1 - y * sa + centerX, tmp4 = tmp2 + y * ca + centerY;
      let o = (y - by) * bw;
      for (let x = bx; x < bx + bw; x++, o++) {
        let xs = x * ca + tmp3, ys = x * sa + tmp4;
        if (method === BICUBIC) {
          bicubic(src, W, H, xs, ys, isF);
          const q = RES[0];
          out[o] = isF ? q : bicubicInt(q, maxV);
        } else if (xs >= -0.01 && xs < W && ys >= -0.01 && ys < H) {
          if (method === BILINEAR) {
            if (xs < 0.0) xs = 0.0;
            if (xs >= xlimit) xs = xlimit2;
            if (ys < 0.0) ys = 0.0;
            if (ys >= ylimit) ys = ylimit2;
            out[o] = isF ? bilF(src, W, xs, ys) : bilI(src, W, xs, ys) + 0.5;
          } else {
            let ixs = M_trunc(xs + 0.5), iys = M_trunc(ys + 0.5);
            if (ixs >= W) ixs = W - 1;
            if (iys >= H) iys = H - 1;
            out[o] = src[W * iys + ixs];
          }
        } else out[o] = 0;
      }
    }
    return out;
  }

  /* Rotator.enlargeCanvas():
   *   IJ.run(imp, "Select All", ""); IJ.run(imp, "Rotate...", "angle="+angle);    → RoiRotator.rotate(Roi(0,0,w,h), angle)
   *   Rectangle2D.Double fb = roi.getFloatBounds();
   *   Rectangle r = new Rectangle((int)M_round(fb.x),(int)M_round(fb.y),(int)M_round(fb.width),(int)M_round(fb.height));
   *   if (r.width<imp.getWidth()) r.width = imp.getWidth();
   *   if (r.height<imp.getHeight()) r.height = imp.getHeight();
   *   IJ.run(imp, "Canvas Size...", "width="+r.width+" height="+r.height+" position=Center zero");
   * RoiRotator.rotate(roi, angle, xcenter, ycenter): theta = -angle*Math.PI/180.0; per corner of the (float) polygon
   *   dx = x-xcenter; dy = ycenter-y; radius = M_sqrt(dx*dx+dy*dy); a = M_atan2(dy, dx);
   *   x' = (float)(xcenter+radius*M_cos(a+theta)); y' = (float)(ycenter-radius*M_sin(a+theta));
   * the rotation centre of a Roi is the middle of its bounds; FloatPolygon.getFloatBounds is
   * (minX, minY, maxX-minX, maxY-minY) in float. */
  function enlargedSize(W, H, angle) {
    const xc = W / 2.0, yc = H / 2.0;
    const theta = -angle * Math.PI / 180.0;
    const corners = [[0, 0], [W, 0], [W, H], [0, H]];
    let minX = FLT_MAX, minY = FLT_MAX, maxX = 1.401298464324817e-45, maxY = 1.401298464324817e-45;
    for (const c of corners) {
      const dx = c[0] - xc, dy = yc - c[1];
      const radius = M_sqrt(dx * dx + dy * dy);
      const a = M_atan2(dy, dx);
      const x = M_fround(xc + radius * M_cos(a + theta));
      const y = M_fround(yc - radius * M_sin(a + theta));
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    // (int)M_round(double) = floor(x + 0.5)
    let w = M_floor(M_fround(maxX - minX) + 0.5), h = M_floor(M_fround(maxY - minY) + 0.5);
    if (w < W) w = W;
    if (h < H) h = H;
    return { w, h, xOff: M_trunc((w - W) / 2), yOff: M_trunc((h - H) / 2) };
  }

  // ─────────────────────────── Scale in place ───────────────────────────

  /* ByteProcessor.scale / ShortProcessor.scale / FloatProcessor.scale (1.54p), for the band of the output.
   *
   *   xCenter = roiX + roiWidth/2.0;   yCenter = roiY + roiHeight/2.0;
   *   if ((xScale>1.0) && (yScale>1.0)) { //expand roi
   *       xmin = (int)(xCenter-(xCenter-roiX)*xScale); if (xmin<0) xmin = 0;
   *       xmax = xmin + (int)(roiWidth*xScale) - 1;    if (xmax>=width) xmax = width - 1;   (same for y) }
   *   else { xmin = roiX; xmax = roiX + roiWidth - 1; ... }
   *   boolean checkCoordinates = (xScale < 1.0) || (yScale < 1.0);
   *   ys = (y-yCenter)/yScale + yCenter;   xs = (x-xCenter)/xScale + xCenter;
   *   non-bicubic: ysi = (int)ys; if (ys<0.0) ys = 0.0; if (ys>=ylimit) ys = ylimit2;   (BEFORE the row loop, every method)
   *       if (checkCoordinates && ((xsi<xmin) || (xsi>xmax) || (ysi<ymin) || (ysi>ymax))) pixels[index1++] = BG;
   *       BILINEAR: clamp xs, (…)getInterpolatedPixel(xs, ys, pixels2)+0.5;  NONE: pixels2[index2+xsi]
   *   BICUBIC: getBicubicInterpolatedPixel(xs, ys, ip2), no coordinate check and no clamping of ys.
   * BG is where the bit depths differ, and it is NOT the background value:
   *   Byte:  pixels[index1++] = (byte)bgColor;      (Scaler: ip.setBackgroundValue(0) → 0)
   *   Short: short min2 = (short)getMin();  … pixels[index1++] = min2;     (the DISPLAY minimum of the processor)
   *   Float: pixels[index1++] = (float)getMin();
   * `fill` is that value, resolved from the display range at accept time (see the op's resolve). Pixels the loop does
   * not visit (outside [xmin..xmax] × [ymin..ymax]) keep the source value. */
  function scaleRegion(rr, W, H, xScale, yScale) {
    const xCenter = rr.x + rr.w / 2.0, yCenter = rr.y + rr.h / 2.0;
    let xmin, xmax, ymin, ymax;
    if (xScale > 1.0 && yScale > 1.0) {
      xmin = M_trunc(xCenter - (xCenter - rr.x) * xScale);
      if (xmin < 0) xmin = 0;
      xmax = xmin + M_trunc(rr.w * xScale) - 1;
      if (xmax >= W) xmax = W - 1;
      ymin = M_trunc(yCenter - (yCenter - rr.y) * yScale);
      if (ymin < 0) ymin = 0;
      ymax = ymin + M_trunc(rr.h * yScale) - 1;
      if (ymax >= H) ymax = H - 1;
    } else {
      xmin = rr.x; xmax = rr.x + rr.w - 1; ymin = rr.y; ymax = rr.y + rr.h - 1;
    }
    return { xCenter, yCenter, xmin, xmax, ymin, ymax };
  }

  function scaleBand(src, W, H, bd, rr, xScale, yScale, method, fill, bx, by, bw, bh) {
    const out = new src.constructor(bw * bh);
    const g = scaleRegion(rr, W, H, xScale, yScale);
    const isF = bd === 32, maxV = bd === 8 ? 255 : 65535;
    const checkCoordinates = xScale < 1.0 || yScale < 1.0;
    const xlimit = W - 1.0, xlimit2 = W - 1.001, ylimit = H - 1.0, ylimit2 = H - 1.001;
    for (let y = by; y < by + bh; y++) {
      const o0 = (y - by) * bw;
      if (y < g.ymin || y > g.ymax) {
        for (let x = 0; x < bw; x++) out[o0 + x] = src[y * W + bx + x];
        continue;
      }
      let ys = (y - g.yCenter) / yScale + g.yCenter;
      let ysi = 0, index2 = 0;
      if (method !== BICUBIC) {
        ysi = M_trunc(ys);
        if (ys < 0.0) ys = 0.0;
        if (ys >= ylimit) ys = ylimit2;
        index2 = W * M_trunc(ys);
      }
      for (let x = bx; x < bx + bw; x++) {
        const o = o0 + (x - bx);
        if (x < g.xmin || x > g.xmax) { out[o] = src[y * W + x]; continue; }
        let xs = (x - g.xCenter) / xScale + g.xCenter;
        if (method === BICUBIC) {
          bicubic(src, W, H, xs, ys, isF);
          const q = RES[0];
          out[o] = isF ? q : bicubicInt(q, maxV);
        } else {
          const xsi = M_trunc(xs);
          if (checkCoordinates && (xsi < g.xmin || xsi > g.xmax || ysi < g.ymin || ysi > g.ymax)) out[o] = fill;
          else if (method === BILINEAR) {
            if (xs < 0.0) xs = 0.0;
            if (xs >= xlimit) xs = xlimit2;
            out[o] = isF ? bilF(src, W, xs, ys) : bilI(src, W, xs, ys) + 0.5;
          } else out[o] = src[index2 + xsi];
        }
      }
    }
    return out;
  }

  // The fill value of a scale-in-place on the pixels that leave the scaled rectangle, from the display minimum.
  function scaleFill(bd, displayMin) {
    const m = isNum(displayMin) ? displayMin : 0;
    if (bd === 8) return 0;
    // ShortProcessor.setMinAndMax: `min = (int)M_round(minimum)`, then fill = (short)getMin(): the ROUNDED minimum, a negative one as its 16-bit pattern
    if (bd === 16) return M_floor(m + 0.5) & 0xFFFF;
    return M_fround(m);
  }

  // ─────────────────────────── Translate ───────────────────────────

  /* ImageProcessor.translate(xOffset, yOffset) (1.54p):
   *   ImageProcessor ip2 = this.duplicate(); ip2.setBackgroundValue(0.0);
   *   boolean integerOffsets = xOffset==(int)xOffset && yOffset==(int)yOffset;
   *   if (integerOffsets || interpolationMethod==NONE) putPixel(x, y, ip2.getPixel(x-(int)xOffset, y-(int)yOffset));
   *   else putPixel(x, y, ip2.getPixelInterpolated(x-xOffset, y-yOffset));
   * getPixel is 0 outside the image; getPixelInterpolated (Byte/Short):
   *   BILINEAR: if (x<0.0 || y<0.0 || x>=width-1 || y>=height-1) return 0; else (int)M_round(getInterpolatedPixel(x, y, pixels))
   *   BICUBIC:  (int)(getBicubicInterpolatedPixel(x, y, this)+0.5) clamped to the type;  Float: (float) of the value
   * (the last row and column of a bilinear translation therefore become 0). */
  function translateBand(src, W, H, bd, dx, dy, method, bx, by, bw, bh) {
    const out = new src.constructor(bw * bh);
    const isF = bd === 32, maxV = bd === 8 ? 255 : 65535;
    const tdx = M_trunc(dx), tdy = M_trunc(dy);
    const integerOffsets = dx === tdx && dy === tdy;
    if (integerOffsets || method === NONE) {
      for (let y = by; y < by + bh; y++) {
        const sy = y - tdy;
        if (sy < 0 || sy >= H) continue;                  // the row stays 0
        let o = (y - by) * bw;
        for (let x = bx; x < bx + bw; x++, o++) {
          const sx = x - tdx;
          if (sx >= 0 && sx < W) out[o] = src[sy * W + sx];
        }
      }
    } else if (method === BILINEAR) {
      const xmax = W - 1, ymax = H - 1;
      for (let y = by; y < by + bh; y++) {
        const yy = y - dy;
        if (yy < 0.0 || yy >= ymax) continue;
        const yb = yy | 0, yf = yy - yb, row = yb * W;
        let o = (y - by) * bw;
        for (let x = bx; x < bx + bw; x++, o++) {
          const xx = x - dx;
          if (xx < 0.0 || xx >= xmax) continue;
          if (isF) { out[o] = bilF(src, W, xx, yy); continue; }
          const xb = xx | 0, xf = xx - xb, i = row + xb;
          const ll = src[i], lr = src[i + 1], ur = src[i + W + 1], ul = src[i + W];
          const ua = ul + xf * (ur - ul), la = ll + xf * (lr - ll);
          out[o] = M_floor(la + yf * (ua - la) + 0.5);   // (int)M_round(...)
        }
      }
    } else {
      for (let y = by; y < by + bh; y++) {
        const yy = y - dy;
        let o = (y - by) * bw;
        for (let x = bx; x < bx + bw; x++, o++) {
          bicubic(src, W, H, x - dx, yy, isF);
          const q = RES[0];
          out[o] = isF ? q : bicubicInt(q, maxV);
        }
      }
    }
    return out;
  }

  // ─────────────────────────── Resize ───────────────────────────

  function cropRect(src, W, rr) {
    const out = new src.constructor(rr.w * rr.h);
    for (let y = 0; y < rr.h; y++) out.set(src.subarray((rr.y + y) * W + rr.x, (rr.y + y) * W + rr.x + rr.w), y * rr.w);
    return out;
  }

  /* ImageProcessor.resizeLinearly (a source of width 1 or height 1 with interpolation): row 0 only, linear.
   *   boolean rotate = width==1; if (rotate) { ip1=ip1.rotateLeft(); swap(width2, height2) }
   *   scale = (double)(width1-1)/(width2-1);  x1 = (int)(x*scale); x2 = x1+1; if (x2==width1) x2=width1-1;
   *   fraction = x*scale - x1;  data2[x] = (float)((1.0-fraction)*data1[x1] + fraction*data1[x2]);
   *   every row of the result is data2; then convertToByte(false) / convertToShort(false) (round half up, clamped)
   *   and rotateRight().  Java's (int) of NaN is 0. */
  function resizeLinearly(src, W, H, bd, dstW, dstH) {
    const rotate = W === 1;
    let width2 = dstW, height2 = dstH;
    if (rotate) { width2 = dstH; height2 = dstW; }
    const width1 = rotate ? H : W;
    const data1 = new Float32Array(width1);
    for (let i = 0; i < width1; i++) data1[i] = rotate ? src[i * W] : src[i];
    const data2 = new Float32Array(width2);
    const scale = (width1 - 1) / (width2 - 1);
    const d2i = (v) => (v !== v ? 0 : M_trunc(v));
    for (let x = 0; x < width2; x++) {
      const x1 = d2i(x * scale);
      let x2 = x1 + 1;
      if (x2 === width1) x2 = width1 - 1;
      const fraction = x * scale - x1;
      data2[x] = (1.0 - fraction) * data1[x1] + fraction * data1[x2];
    }
    const maxV = bd === 8 ? 255 : 65535;
    const conv = (v) => {
      if (bd === 32) return v;
      let t = M_fround(v + 0.5);
      if (t < 0) t = 0;
      if (t > maxV) t = maxV;
      return t;
    };
    const out = new src.constructor(dstW * dstH);
    if (!rotate) { for (let y = 0; y < dstH; y++) for (let x = 0; x < dstW; x++) out[y * dstW + x] = conv(data2[x]); }
    else { for (let y = 0; y < dstH; y++) for (let x = 0; x < dstW; x++) out[y * dstW + x] = conv(data2[y]); }
    return out;
  }

  /* ByteProcessor.resize / ShortProcessor.resize / FloatProcessor.resize (dstWidth, dstHeight) (1.54p):
   *   if (roiWidth==dstWidth && roiHeight==dstHeight) return crop();
   *   if ((width==1||height==1) && interpolationMethod!=NONE) return resizeLinearly(dstWidth, dstHeight);
   *   srcCenterX = roiX + roiWidth/2.0;   dstCenterX = dstWidth/2.0;   xScale = (double)dstWidth/roiWidth;
   *   if (interpolationMethod!=NONE) { if (dstWidth!=width) dstCenterX+=xScale/4.0; if (dstHeight!=height) dstCenterY+=yScale/4.0; }
   *       (compared with the width of the WHOLE image, not of the selection)
   *   ys = (y-dstCenterY)/yScale + srcCenterY;  xs = (x-dstCenterX)/xScale + srcCenterX;
   *   BICUBIC: getBicubicInterpolatedPixel(xs, ys, this);
   *   else: if (BILINEAR) clamp ys to [0, height-1.001], xs to [0, width-1.001]; NONE: pixels[width*(int)ys + (int)xs]
   * `hook(fraction)` is awaited every TICK_PIXELS outputs (progress / cancel). */
  async function resizePlain(src, W, H, bd, rr, dstW, dstH, method, hook) {
    if (rr.w === dstW && rr.h === dstH) return cropRect(src, W, rr);
    if ((W === 1 || H === 1) && method !== NONE) return resizeLinearly(src, W, H, bd, dstW, dstH);
    const isF = bd === 32, maxV = bd === 8 ? 255 : 65535;
    const srcCenterX = rr.x + rr.w / 2.0, srcCenterY = rr.y + rr.h / 2.0;
    let dstCenterX = dstW / 2.0, dstCenterY = dstH / 2.0;
    const xScale = dstW / rr.w, yScale = dstH / rr.h;
    if (method !== NONE) {
      if (dstW !== W) dstCenterX += xScale / 4.0;
      if (dstH !== H) dstCenterY += yScale / 4.0;
    }
    const out = new src.constructor(dstW * dstH);
    const xlimit = W - 1.0, xlimit2 = W - 1.001, ylimit = H - 1.0, ylimit2 = H - 1.001;
    let acc = 0;
    for (let y = 0; y < dstH; y++) {
      let ys = (y - dstCenterY) / yScale + srcCenterY;
      if (method === BILINEAR) {
        if (ys < 0.0) ys = 0.0;
        if (ys >= ylimit) ys = ylimit2;
      }
      const index1 = W * M_trunc(ys);
      let o = y * dstW;
      for (let x = 0; x < dstW; x++, o++) {
        let xs = (x - dstCenterX) / xScale + srcCenterX;
        if (method === BICUBIC) {
          bicubic(src, W, H, xs, ys, isF);
          const q = RES[0];
          out[o] = isF ? q : bicubicInt(q, maxV);
        } else if (method === BILINEAR) {
          if (xs < 0.0) xs = 0.0;
          if (xs >= xlimit) xs = xlimit2;
          out[o] = isF ? bilF(src, W, xs, ys) : bilI(src, W, xs, ys) + 0.5;
        } else out[o] = src[index1 + M_trunc(xs)];
      }
      acc += dstW;
      if (hook && acc >= TICK_PIXELS) { acc = 0; await hook((y + 1) / dstH); }
    }
    return out;
  }

  /* ij.process.DownsizeTable (1.54p, Michael Schmid): the convolution table of a 1-D downsizing. Left edges of the first
   * pixel coincide; kernel: NONE 1f, BILINEAR 1f - (float)M_abs(x), BICUBIC (float)ImageProcessor.cubic(x); kernel
   * sizes 1 / 2 / 4; out-of-bounds sources count as the edge pixel; the weights of a destination pixel are normalised
   * ((float)(weights[i]/sum)); unused entries point to destination 0 with weight 0. */
  function downsizeTable(srcSize, srcOrigin, srcLength, dstSize, method) {
    const scale = srcLength / dstSize;
    const kernelSize = method === NONE ? 1 : method === BILINEAR ? 2 : 4;
    const srcIndex = (di) => srcOrigin - 0.5 + (di + 0.5) * scale;
    const dstIndex = (si) => (si - srcOrigin + 0.5) / scale - 0.5;
    const kernel = (x) => (method === NONE ? 1 : method === BILINEAR ? M_fround(1 - M_fround(M_abs(x))) : M_fround(cubic(x)));
    const srcStartUncorr = M_ceil(1e-8 + srcIndex(-0.5 * kernelSize));
    const srcStart = srcStartUncorr < 0 ? 0 : srcStartUncorr;
    const srcEndUncorr = M_floor(1e-8 + srcIndex(dstSize - 1 + 0.5 * kernelSize));
    const srcEnd = srcEndUncorr >= srcSize ? srcSize - 1 : srcEndUncorr;
    const arraySize = (srcEnd - srcStart + 1) * kernelSize;
    const indices = new Int32Array(arraySize).fill(-1);
    const weights = new Float32Array(arraySize);
    for (let dst = 0; dst < dstSize; dst++) {
      let sum = 0;
      const lowestS = M_ceil(1e-8 + srcIndex(dst - 0.5 * kernelSize));
      const highestS = M_floor(-1e-8 + srcIndex(dst + 0.5 * kernelSize));
      for (let src = lowestS; src <= highestS; src++) {
        const s = src < 0 ? 0 : (src >= srcSize ? srcSize - 1 : src);
        let p = (s - srcStart) * kernelSize;
        while (indices[p] !== -1 && indices[p] !== dst) p++;
        indices[p] = dst;
        const weight = kernel(dst - dstIndex(src));
        sum += weight;
        weights[p] += weight;
      }
      let iStart = (lowestS - srcStart) * kernelSize;
      if (iStart < 0) iStart = 0;
      let iStop = (highestS - srcStart) * kernelSize + (kernelSize - 1);
      if (iStop >= indices.length) iStop = indices.length - 1;
      for (let i = iStart; i <= iStop; i++) if (indices[i] === dst) weights[i] = weights[i] / sum;
    }
    for (let i = 0; i < indices.length; i++) if (indices[i] === -1) indices[i] = 0;
    return { kernelSize, srcStart, srcEnd, indices, weights };
  }

  /* FloatProcessor.downsize1D(dstWidth, dstHeight, xDirection): every source line of the selection is convolved through
   * the table; `pixels2[...] += v * dt.weights[tablePointer]` is a float multiply and a float add. `pix` is read as
   * float (an 8/16-bit value is exact in a float). Returns the new dstW × dstH float image. */
  async function downsize1D(pix, W, H, roi, dstW, dstH, xDirection, method, hook, h0, h1) {
    const srcPointInc = xDirection ? 1 : W, srcLineInc = xDirection ? W : 1;
    const dstPointInc = xDirection ? 1 : dstW, dstLineInc = xDirection ? dstW : 1;
    const srcLine0 = xDirection ? roi.y : roi.x;
    const dstLines = xDirection ? dstH : dstW;
    const dt = xDirection ? downsizeTable(W, roi.x, roi.w, dstW, method) : downsizeTable(H, roi.y, roi.h, dstH, method);
    const out = new Float32Array(dstW * dstH);
    const indices = dt.indices, weights = dt.weights, ks = dt.kernelSize, srcStart = dt.srcStart, srcEnd = dt.srcEnd;
    const per = M_max(1, srcEnd - srcStart + 1) * ks;
    let acc = 0;
    if (!xDirection) {
      // Column pass, row-major: each output pixel still receives its contributions in the same order (source rows
      // ascending, table entries in order), so every float sum is bit-identical to the column-by-column loop, but the
      // reads and writes are sequential instead of a stride of W.
      for (let srcPoint = srcStart, tp = 0; srcPoint <= srcEnd; srcPoint++) {
        const rowBase = srcPoint * W + srcLine0;
        for (let i = 0; i < ks; i++, tp++) {
          const wgt = weights[tp], ob = indices[tp] * dstW;
          for (let x = 0; x < dstW; x++) out[ob + x] = out[ob + x] + M_fround(pix[rowBase + x] * wgt);
        }
        acc += dstW * ks;
        if (hook && acc >= TICK_PIXELS) { acc = 0; await hook(h0 + (h1 - h0) * ((srcPoint - srcStart + 1) / (srcEnd - srcStart + 1))); }
      }
      return out;
    }
    for (let srcLine = srcLine0, dstLine = 0; dstLine < dstLines; srcLine++, dstLine++) {
      const dstLineOffset = dstLine * dstLineInc;
      let tp = 0;
      for (let srcPoint = srcStart, p = srcPoint * srcPointInc + srcLine * srcLineInc; srcPoint <= srcEnd; srcPoint++, p += srcPointInc) {
        const v = pix[p];
        for (let i = 0; i < ks; i++, tp++) {
          const idx = dstLineOffset + indices[tp] * dstPointInc;
          out[idx] = out[idx] + M_fround(v * weights[tp]);   // pixels2[...] += v * dt.weights[tablePointer] (float · float, float + float)
        }
      }
      acc += per;
      if (hook && acc >= TICK_PIXELS) { acc = 0; await hook(h0 + (h1 - h0) * ((dstLine + 1) / dstLines)); }
    }
    return out;
  }

  // ImageProcessor.setPixels(channelNumber, fp) for Byte / Short: value = fPixels[i] + 0.5f; clamp; (byte)value / (short)value.
  function floatToType(fp, bd) {
    if (bd === 32) return fp;
    const maxV = bd === 8 ? 255 : 65535;
    const out = bd === 8 ? new Uint8Array(fp.length) : new Uint16Array(fp.length);
    for (let i = 0; i < fp.length; i++) {
      let v = M_fround(fp[i] + 0.5);
      if (v < 0) v = 0;
      if (v > maxV) v = maxV;
      out[i] = v;
    }
    return out;
  }

  /* ImageProcessor.resize(dstWidth, dstHeight, useAveraging) (Michael Schmid):
   *   if ((dstWidth>=rWidth && dstHeight>=rHeight) || !useAverging) return resize(dstWidth, dstHeight);
   *   else { // downsizing with averaging in at least one direction: convert to float
   *       fp.setInterpolationMethod(interpolationMethod); fp.setRoi(getRoi()); fp2 = fp.downsize(dstWidth, dstHeight, msg);
   *       ip2.setPixels(channelNumber, fp2); }
   * FloatProcessor.downsize: downsize1D in x when dstWidth<roiWidth, then (roi (0,0,dstWidth,roiHeight)) in y when
   * dstHeight<roiHeight (`roiHeight` is the ORIGINAL processor's field); then
   *   if (ip2.getWidth()!=dstWidth || ip2.getHeight()!=dstHeight) ip2 = (FloatProcessor)ip2.resize(dstWidth, dstHeight);
   * (the upsizing direction of a mixed resize, with the same interpolation method). */
  async function resizeImage(src, W, H, bd, rr, dstW, dstH, method, avg, hook) {
    if ((dstW >= rr.w && dstH >= rr.h) || !avg) return resizePlain(src, W, H, bd, rr, dstW, dstH, method, hook);
    let cur = src, cw = W, ch = H, croi = rr;
    const steps = (dstW < rr.w ? 1 : 0) + (dstH < rr.h ? 1 : 0);
    let step = 0;
    const sub = (f0, f1) => (hook ? (f) => hook(f0 + (f1 - f0) * f) : null);
    if (dstW < rr.w) {
      cur = await downsize1D(cur, cw, ch, croi, dstW, rr.h, true, method, sub(step / (steps + 1), (step + 1) / (steps + 1)), 0, 1);
      step++;
      cw = dstW; ch = rr.h; croi = { x: 0, y: 0, w: dstW, h: rr.h };
    }
    if (dstH < rr.h) {
      cur = await downsize1D(cur, cw, ch, croi, croi.w, dstH, false, method, sub(step / (steps + 1), (step + 1) / (steps + 1)), 0, 1);
      step++;
      cw = croi.w; ch = dstH; croi = { x: 0, y: 0, w: cw, h: ch };
      if (cw !== dstW) { /* the x direction is upsized below */ }
    }
    if (cw !== dstW || ch !== dstH) {
      cur = await resizePlain(cur, cw, ch, 32, { x: 0, y: 0, w: cw, h: ch }, dstW, dstH, method, sub(steps / (steps + 1), 1));
    }
    return floatToType(cur, bd);
  }

  // ─────────────────────────── Bin ───────────────────────────

  /* ij.plugin.Binner.shrink(ImageProcessor, method) (1.54p): w = ip.getWidth()/xshrink (integer division, the remainder
   * is dropped), one value per xshrink × yshrink block, computed in float and stored with ip2.setf(x, y, v):
   *   ByteProcessor.setf:  pixels[y*width+x] = (byte)(value+0.5f);   Short: (short)(value+0.5f)   Float: value
   *   getAverage: float sum += ip.getf(..);  return (float)(sum/(xshrink*yshrink));
   *   getMin / getMax: Float.MAX_VALUE / -Float.MAX_VALUE;
   *   getSum: if (maxValue>0f && sum>maxValue) sum = maxValue;     maxValue = 255 (8-bit), 65535 (16-bit), 0 (32-bit)
   *   getMedian: the source's own selection (NOT a sort): halfsize = shrinksize/2; (halfsize+1) times: the largest
   *     value above 0f is zeroed; then the maximum of what is left is the "median" — so with 2 × 2 it is the
   *     SMALLEST of the four, and a value <= 0 is never found by `pixel>max` (max starts at 0f).
   * `inv` (an inverting LUT): Binner.shrink(ImagePlus): if (ip.isInvertedLut()) ip.invert(); ip2 = shrink(ip, method);
   * if (ip.isInvertedLut()) ip2.invert();  — see invertPixels. */
  /* Fast paths of binImage, one monomorphic loop per method (a single loop testing the method per block ran at ~1.5 us
   * per output in V8: the polymorphic body never optimised). Each fills output rows y0..y1 and gives the same values:
   *   average / sum of an integer image: the float running sum of getAverage/getSum is EXACT while n * maxValue <= 2^24
   *   (every partial sum is an integer of at most 2^24, which float32 holds exactly), so an integer sum equals the Math.fround chain; otherwise (32-bit, big
   *   blocks) the float chain is kept. The result is stored through ip2.setf: (value + 0.5f) for Byte / Short. */
  function binRowsSum(src, W, out, w, xs, ys, n, y0, y1, isAvg, exact, maxValue, isF, col) {
    if (exact) {
      // Streaming form of the exact integer sum: the ys source rows of an output row are added into one line of column
      // sums (sequential reads), then xs neighbours of that line make a block sum. Integer adds, same value.
      for (let y = y0; y < y1; y++) {
        const r0 = y * ys * W;
        const lim = w * xs;
        for (let x = 0; x < lim; x++) col[x] = src[r0 + x];
        for (let y2 = 1; y2 < ys; y2++) { const r = r0 + y2 * W; for (let x = 0; x < lim; x++) col[x] += src[r + x]; }
        let o = y * w;
        for (let x = 0, c = 0; x < w; x++, o++) {
          let sum = 0;
          for (let x2 = 0; x2 < xs; x2++) sum += col[c++];
          let v;
          if (isAvg) v = M_fround(sum / n);
          else { if (maxValue > 0 && sum > maxValue) sum = maxValue; v = sum; }
          out[o] = M_fround(v + 0.5);
        }
      }
      return;
    }
    for (let y = y0; y < y1; y++) {
      const base0 = y * ys * W;
      let o = y * w;
      for (let x = 0; x < w; x++, o++) {
        const base = base0 + x * xs;
        let sum = 0;
        for (let y2 = 0, r = base; y2 < ys; y2++, r += W) for (let x2 = 0; x2 < xs; x2++) sum = M_fround(sum + src[r + x2]);
        let v;
        if (isAvg) v = M_fround(sum / n);
        else { if (maxValue > 0 && sum > maxValue) sum = maxValue; v = sum; }
        out[o] = isF ? v : M_fround(v + 0.5);
      }
    }
  }
  function binRowsMinMax(src, W, out, w, xs, ys, y0, y1, isMin, isF) {
    for (let y = y0; y < y1; y++) {
      const base0 = y * ys * W;
      let o = y * w;
      for (let x = 0; x < w; x++, o++) {
        const base = base0 + x * xs;
        let v = isMin ? FLT_MAX : -FLT_MAX;
        if (isMin) { for (let y2 = 0, r = base; y2 < ys; y2++, r += W) for (let x2 = 0; x2 < xs; x2++) { const q = src[r + x2]; if (q < v) v = q; } }
        else { for (let y2 = 0, r = base; y2 < ys; y2++, r += W) for (let x2 = 0; x2 < xs; x2++) { const q = src[r + x2]; if (q > v) v = q; } }
        out[o] = isF ? v : M_fround(v + 0.5);
      }
    }
  }
  function binRowsMedian(src, W, out, w, xs, ys, n, px, y0, y1, isF) {
    const half = n >> 1;
    for (let y = y0; y < y1; y++) {
      let o = y * w;
      for (let x = 0; x < w; x++, o++) {
        const base = y * ys * W + x * xs;
        let p = 0;
        for (let y2 = 0; y2 < ys; y2++) { const r = base + y2 * W; for (let x2 = 0; x2 < xs; x2++) px[p++] = src[r + x2]; }
        for (let i = 0; i <= half; i++) {
          let max = 0, mj = 0;
          for (let j = 0; j < n; j++) if (px[j] > max) { max = px[j]; mj = j; }
          px[mj] = 0;
        }
        let max = -FLT_MAX;
        for (let j = 0; j < n; j++) if (px[j] > max) max = px[j];
        out[o] = isF ? max : M_fround(max + 0.5);
      }
    }
  }

  async function binImage(src, W, H, bd, xs, ys, method, hook) {
    const w = M_floor(W / xs), h = M_floor(H / ys);
    const out = new src.constructor(w * h);
    const maxValue = method === 'sum' ? (bd === 8 ? 255 : bd === 16 ? 65535 : 0) : 0;
    const n = xs * ys;
    const px = new Float32Array(n);
    const isF = bd === 32;
    const col = new Int32Array(w * xs); // one line of column sums, reused by every slice (binRowsSum, exact path)
    const exact = !isF && n * (bd === 8 ? 255 : 65535) <= 16777216;
    // rows per slice so a progress / cancel check comes at least every ~TICK_PIXELS source pixels
    const rowsPer = M_max(1, M_floor(TICK_PIXELS / M_max(1, w * n)));
    for (let y0 = 0; y0 < h; y0 += rowsPer) {
      const y1 = M_min(h, y0 + rowsPer);
      if (method === 'average' || method === 'sum') binRowsSum(src, W, out, w, xs, ys, n, y0, y1, method === 'average', exact, maxValue, isF, col);
      else if (method === 'min' || method === 'max') binRowsMinMax(src, W, out, w, xs, ys, y0, y1, method === 'min', isF);
      else binRowsMedian(src, W, out, w, xs, ys, n, px, y0, y1, isF);
      if (hook) await hook(y1 / h);
    }
    return { w, h, data: out };
  }

  /* ip.invert() for the inverting-LUT image of Binner.shrink(ImagePlus): 8-bit 255-v; 16-bit about the DATA range
   * (ShortProcessor.invert(): resetMinAndMax(); process(INVERT): v2 = max2 - (v1 - min2)); 32-bit about the processor's
   * min/max (FloatProcessor.process INVERT, the display range). */
  function invertAbout(data, bd, mn, mx) {
    const out = new data.constructor(data.length);
    if (bd === 8) { for (let i = 0; i < data.length; i++) out[i] = 255 - data[i]; return out; }
    for (let i = 0; i < data.length; i++) {
      // FloatProcessor.process(INVERT): float min2/max2 and float arithmetic (`v2 = max2 - (v1 - min2)`)
      let v = bd === 32 ? M_fround(M_fround(mx) - M_fround(data[i] - M_fround(mn))) : mx - (data[i] - mn);
      if (bd === 16) { if (v < 0) v = 0; if (v > 65535) v = 65535; out[i] = v + 0.5; } else out[i] = v;
    }
    return out;
  }
  function dataRange(data) {
    let mn = Infinity, mx = -Infinity;
    for (let i = 0; i < data.length; i++) { const v = data[i]; if (v < mn) mn = v; if (v > mx) mx = v; }
    return { min: mn, max: mx };
  }

  // ─────────────────────────── Canvas Size ───────────────────────────

  const POSITIONS = ['topLeft', 'topCenter', 'topRight', 'centerLeft', 'center', 'centerRight', 'bottomLeft', 'bottomCenter', 'bottomRight'];
  /* CanvasResizer.run:  xC = (wNew - wOld)/2; xR = (wNew - wOld); yC = (hNew - hOld)/2; yB = (hNew - hOld);   (int division)
   *   TL (0,0)  TC (xC,0)  TR (xR,0)  CL (0,yC)  C (xC,yC)  CR (xR,yC)  BL (0,yB)  BC (xC,yB)  BR (xR,yB) */
  function canvasOffsets(wOld, hOld, wNew, hNew, position) {
    const xC = M_trunc((wNew - wOld) / 2), xR = wNew - wOld, yC = M_trunc((hNew - hOld) / 2), yB = hNew - hOld;
    const i = POSITIONS.indexOf(position);
    switch (i) {
      case 0: return { x: 0, y: 0 };
      case 1: return { x: xC, y: 0 };
      case 2: return { x: xR, y: 0 };
      case 3: return { x: 0, y: yC };
      case 5: return { x: xR, y: yC };
      case 6: return { x: 0, y: yB };
      case 7: return { x: xC, y: yB };
      case 8: return { x: xR, y: yB };
      default: return { x: xC, y: yC };
    }
  }
  // CanvasResizer.expandImage: createProcessor(wNew, hNew); fill 0 (zero fill); insert(ipOld, xOff, yOff) — clipped to the new canvas.
  function canvasChannel(src, W, H, wNew, hNew, xOff, yOff) {
    const out = new src.constructor(wNew * hNew);
    const x0 = M_max(0, xOff), x1 = M_min(wNew, xOff + W), y0 = M_max(0, yOff), y1 = M_min(hNew, yOff + H);
    if (x1 <= x0 || y1 <= y0) return out;
    for (let y = y0; y < y1; y++) {
      const so = (y - yOff) * W + (x0 - xOff);
      out.set(src.subarray(so, so + (x1 - x0)), y * wNew + x0);
    }
    return out;
  }

  // ─────────────────────────── calibration ───────────────────────────

  // ij.measure.Calibration.scaled(): pixelWidth!=1.0 || pixelHeight!=1.0 || pixelDepth!=1.0 || !unit.equals("pixel")
  function isScaled(cal) {
    if (!cal) return false;
    const u = cal.unit;
    const unscaledUnit = !u || u === 'pixel' || u === 'px' || u === 'pixels';
    return (cal.pixelWidth !== undefined && cal.pixelWidth !== 1) || (cal.pixelHeight !== undefined && cal.pixelHeight !== 1) || !unscaledUnit;
  }
  function calOf(cal) { return { pixelWidth: cal && cal.pixelWidth > 0 ? cal.pixelWidth : 1, pixelHeight: cal && cal.pixelHeight > 0 ? cal.pixelHeight : 1, unit: (cal && cal.unit) || 'pixel' }; }
  function scaledCalibration(cal, fx, fy) {
    const c = Object.assign({}, cal || { pixelWidth: 1, pixelHeight: 1, unit: 'pixel' });
    if (isScaled(c)) { c.pixelWidth = (c.pixelWidth > 0 ? c.pixelWidth : 1) * fx; c.pixelHeight = (c.pixelHeight > 0 ? c.pixelHeight : 1) * fy; }
    return c;
  }
  // Calibration.sanitizeUnit: "" → "pixel"; "um" → "µm"; "A" → "Å".
  function sanitizeUnit(unit) {
    if (unit === null || unit === undefined || unit === '') return 'pixel';
    if (unit === 'um') return 'µm';
    if (unit === 'A') return 'Å';
    return unit;
  }

  // ─────────────────────────── helpers of the ops ───────────────────────────

  function cleanProvenance(p) {
    const q = Object.assign({}, p || {});
    delete q.cropOrigin;
    return q;
  }
  function checkRect(r, W, H, what) {
    if (!r || !isInt(r.x) || !isInt(r.y) || !isInt(r.w) || !isInt(r.h) || r.w < 1 || r.h < 1 || r.x < 0 || r.y < 0 || r.x + r.w > W || r.y + r.h > H) throw bad(what + ' rectangle');
  }
  function methodOf(p) {
    const m = METHOD[p.interpolation];
    if (m === undefined) throw bad('interpolation');
    return m;
  }
  // The rectangle of a pixel op at the level the engine works at (a preview climbs the pyramid; level 0 = the params).
  function levelRect(rect, W0, H0, sc, W, H) {
    if (!rect) return { x: 0, y: 0, w: W, h: H };
    if (sc === 1 && W === W0 && H === H0) return rect;
    const x0 = M_max(0, M_floor(rect.x / sc)), y0 = M_max(0, M_floor(rect.y / sc));
    const x1 = M_min(W, M_ceil((rect.x + rect.w) / sc)), y1 = M_min(H, M_ceil((rect.y + rect.h) / sc));
    return { x: x0, y: y0, w: M_max(1, x1 - x0), h: M_max(1, y1 - y0) };
  }
  // The area selection a size / newdoc op works on: its bounds clipped to the image (a line / point selection = the image).
  function areaRect(roi, W, H) {
    if (!roi || !root.IJRoi) return { x: 0, y: 0, w: W, h: H };
    root.IJRoi.validate(roi);
    if (!root.IJRoi.isArea(roi)) return { x: 0, y: 0, w: W, h: H };
    const b = root.IJRoi.bounds(roi);
    const x0 = M_max(0, b.x), y0 = M_max(0, b.y), x1 = M_min(W, b.x + b.w), y1 = M_min(H, b.y + b.h);
    if (!(x1 > x0) || !(y1 > y0)) throw fail('IJ_EMPTY_ROI', 'the selection is outside the image');
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }
  const isWhole = (r, W, H) => r.x === 0 && r.y === 0 && r.w === W && r.h === H;
  function displayOf(ch) { return ch && ch.display ? Object.assign({}, ch.display) : undefined; }
  function checkSizeDim(n, what) { if (!isInt(n) || n < 1 || n > 100000) throw bad(what); }

  // ─────────────────────────── the operations ───────────────────────────

  R.define('rotate', {
    kind: 'pixel', version: 1, roi: 'mask', preview: 'reduced',
    validate(p, info) {
      if (!isNum(p.angle) || M_abs(p.angle) > 36000) throw bad('angle');
      methodOf(p);
      if (p.rect !== undefined && p.rect !== null) checkRect(p.rect, info.width, info.height, 'rotate');
    },
    prepare(view, c, p, ctx) {
      const method = methodOf(p), bd = view.bitDepth, sc = (ctx && ctx.scale) || 1;
      const W0 = view.width, H0 = view.height;
      return {
        // The source of every pixel is the whole image: the preview must work on all of it (apron = the image).
        apron: { x: W0, y: H0 },
        region: (full, rect) => rotateBand(full.data, full.width, full.height, bd, levelRect(p.rect, W0, H0, sc, full.width, full.height), p.angle, method, rect.x, rect.y, rect.w, rect.h)
      };
    }
  });

  R.define('rotateEnlarge', {
    kind: 'size', version: 1,
    validate(p) {
      if (!isNum(p.angle) || M_abs(p.angle) > 36000) throw bad('angle');
      methodOf(p);
    },
    scratchBytes(info, p) {
      const e = enlargedSize(info.width, info.height, p.angle);
      return e.w * e.h * bppOf(info.bitDepth) * (info.channels + 1);
    },
    async run(view, p, roi, io) {
      const W = view.width, H = view.height, bd = view.bitDepth, method = methodOf(p);
      // Rotator: canEnlarge = r==null || (r.x==0&&r.y==0&&r.width==imp.getWidth()&&r.height==imp.getHeight()); a line is no selection.
      const sel = areaRect(roi, W, H);
      if (!isWhole(sel, W, H)) throw fail('IJ_GEOM_ENLARGE_SELECTION', 'Enlarge needs the whole image');
      const e = enlargedSize(W, H, p.angle);
      io.reserve(e.w * e.h * bppOf(bd) * (view.channels.length + 1));
      const n = view.channels.length;
      const rows = M_max(1, M_floor(TICK_PIXELS / e.w));
      const rr = { x: 0, y: 0, w: e.w, h: e.h };
      const channels = [];
      for (let i = 0; i < n; i++) {
        const ch = view.channels[i];
        const canvas = canvasChannel(ch.data, W, H, e.w, e.h, e.xOff, e.yOff);
        const out = new canvas.constructor(e.w * e.h);
        for (let y = 0; y < e.h; y += rows) {
          const bh = M_min(rows, e.h - y);
          out.set(rotateBand(canvas, e.w, e.h, bd, rr, p.angle, method, 0, y, e.w, bh), y * e.w);
          await io.tick((i + (y + bh) / e.h) / n, 'op.rotateEnlarge');
        }
        channels.push({ data: out, name: ch.name, color: ch.color, display: displayOf(ch) });
      }
      io.check();
      return { width: e.w, height: e.h, bitDepth: bd, channels, provenance: cleanProvenance(view.provenance) };
    }
  });

  R.define('scaleInPlace', {
    kind: 'pixel', version: 1, roi: 'bounds', outside: true, preview: 'reduced',
    validate(p, info) {
      if (!isNum(p.xscale) || !isNum(p.yscale) || !(p.xscale > 0) || !(p.yscale > 0)) throw bad('scale');
      methodOf(p);
      if (p.rect !== undefined && p.rect !== null) checkRect(p.rect, info.width, info.height, 'scale');
    },
    // Short / Float ImageProcessor.scale fill what leaves the scaled rectangle with getMin(), the display minimum: it is not
    // journaled, so it is copied into the params when the request is accepted (never on a replay).
    resolve(view, params, chans) {
      const p = Object.assign({}, params);
      p.fills = Object.assign({}, p.fills);
      for (const c of chans) if (p.fills[c] === undefined) { const d = view.channels[c] && view.channels[c].display; p.fills[c] = scaleFill(view.bitDepth, d && d.min); }
      return p;
    },
    prepare(view, c, p, ctx) {
      const method = methodOf(p), bd = view.bitDepth, sc = (ctx && ctx.scale) || 1;
      const W0 = view.width, H0 = view.height;
      const fill = p.fills && p.fills[c] !== undefined ? p.fills[c] : 0;
      return {
        apron: { x: W0, y: H0 },
        region: (full, rect) => scaleBand(full.data, full.width, full.height, bd, levelRect(p.rect, W0, H0, sc, full.width, full.height), p.xscale, p.yscale, method, fill, rect.x, rect.y, rect.w, rect.h)
      };
    }
  });

  R.define('translate', {
    kind: 'pixel', version: 1, roi: 'bounds', preview: 'reduced',
    validate(p) {
      if (!isNum(p.dx) || !isNum(p.dy) || M_abs(p.dx) > 1e6 || M_abs(p.dy) > 1e6) throw bad('offset');
      methodOf(p);
    },
    prepare(view, c, p, ctx) {
      const method = methodOf(p), bd = view.bitDepth, sc = (ctx && ctx.scale) || 1;
      const dx = p.dx / sc, dy = p.dy / sc;
      return {
        apron: { x: M_min(view.width, M_ceil(M_abs(dx)) + 3), y: M_min(view.height, M_ceil(M_abs(dy)) + 3) },
        region: (full, rect) => translateBand(full.data, full.width, full.height, bd, dx, dy, method, rect.x, rect.y, rect.w, rect.h)
      };
    }
  });

  // Result size of a resize: the output arrays of every channel plus the float intermediates of the averaging path.
  function resizeScratch(info, dstW, dstH, rr, avg) {
    const bytes = bppOf(info.bitDepth);
    let extra = 0;
    if (avg && !(dstW >= rr.w && dstH >= rr.h)) extra = (dstW < rr.w ? dstW * rr.h * 4 : 0) + (dstH < rr.h ? dstW * dstH * 4 : 0) + dstW * dstH * 4;
    return info.channels * dstW * dstH * bytes + extra;
  }
  function validateResize(p, info) {
    checkSizeDim(p.width, 'width'); checkSizeDim(p.height, 'height');
    methodOf(p);
    if (p.averageWhenDownsizing !== undefined && typeof p.averageWhenDownsizing !== 'boolean') throw bad('averageWhenDownsizing');
    void info;
  }

  R.define('scaleNew', {
    kind: 'newdoc', version: 1,
    validate(p) {
      validateResize(p);
      if (!isNum(p.xscale) || !isNum(p.yscale) || !(p.xscale > 0) || !(p.yscale > 0)) throw bad('scale');
    },
    scratchBytes(info, p) {
      const rr = info.roi ? safeRect(info.roi, info.width, info.height) : { x: 0, y: 0, w: info.width, h: info.height };
      return resizeScratch(info, p.width, p.height, rr, p.averageWhenDownsizing !== false);
    },
    async run(view, p, roi, io) {
      const W = view.width, H = view.height, bd = view.bitDepth, method = methodOf(p), n = view.channels.length;
      const rr = areaRect(roi, W, H);
      const avg = p.averageWhenDownsizing !== false;
      io.reserve(resizeScratch({ channels: n, bitDepth: bd }, p.width, p.height, rr, avg));
      // Scaler.scale(imp), new window: `if (w==1 || h==1) method = NONE` is the in-place rule; the new window keeps the choice.
      const channels = [];
      for (let i = 0; i < n; i++) {
        const ch = view.channels[i];
        const hook = (f) => io.tick((i + f) / n, 'op.scaleNew');
        channels.push({ data: await resizeImage(ch.data, W, H, bd, rr, p.width, p.height, method, avg, hook), name: ch.name, color: ch.color, display: displayOf(ch) });
        await io.tick((i + 1) / n, 'op.scaleNew');
      }
      io.check();
      // Scaler: if (cal.scaled()) { cal.pixelWidth *= 1.0/xscale; cal.pixelHeight *= 1.0/yscale; }
      return [{
        name: typeof p.name === 'string' && p.name ? p.name : view.name + '-1', width: p.width, height: p.height, bitDepth: bd,
        calibration: scaledCalibration(view.calibration, 1.0 / p.xscale, 1.0 / p.yscale), channels, provenance: cleanProvenance(view.provenance)
      }];
    }
  });

  function safeRect(roi, W, H) { try { return areaRect(roi, W, H); } catch (e) { return { x: 0, y: 0, w: W, h: H }; } }

  R.define('resize', {
    kind: 'size', version: 1,
    validate: validateResize,
    scratchBytes(info, p) {
      const rr = info.roi ? safeRect(info.roi, info.width, info.height) : { x: 0, y: 0, w: info.width, h: info.height };
      return resizeScratch(info, p.width, p.height, rr, p.averageWhenDownsizing !== false);
    },
    async run(view, p, roi, io) {
      const W = view.width, H = view.height, bd = view.bitDepth, method = methodOf(p), n = view.channels.length;
      const rr = areaRect(roi, W, H);
      const whole = isWhole(rr, W, H);
      // Resizer.run: if (roi!=null || newWidth!=origWidth || newHeight!=origHeight) { … } — otherwise nothing happens.
      if (whole && !(roi && root.IJRoi && root.IJRoi.isArea(roi)) && p.width === W && p.height === H) return null;
      const avg = p.averageWhenDownsizing !== false;
      io.reserve(resizeScratch({ channels: n, bitDepth: bd }, p.width, p.height, rr, avg));
      const channels = [];
      for (let i = 0; i < n; i++) {
        const ch = view.channels[i];
        const hook = (f) => io.tick((i + f) / n, 'op.resize');
        channels.push({ data: await resizeImage(ch.data, W, H, bd, rr, p.width, p.height, method, avg, hook), name: ch.name, color: ch.color, display: displayOf(ch) });
        await io.tick((i + 1) / n, 'op.resize');
      }
      io.check();
      // Resizer: if (cal.scaled()) { cal.pixelWidth *= origWidth/newWidth; cal.pixelHeight *= origHeight/newHeight; }
      return { width: p.width, height: p.height, bitDepth: bd, calibration: scaledCalibration(view.calibration, rr.w / p.width, rr.h / p.height), channels, provenance: cleanProvenance(view.provenance) };
    }
  });

  R.define('canvasSize', {
    kind: 'size', version: 1,
    validate(p) {
      checkSizeDim(p.width, 'width'); checkSizeDim(p.height, 'height');
      if (POSITIONS.indexOf(p.position) < 0) throw bad('position');
    },
    scratchBytes: (info, p) => info.channels * p.width * p.height * bppOf(info.bitDepth),
    async run(view, p, roi, io) {
      const W = view.width, H = view.height, bd = view.bitDepth, n = view.channels.length;
      if (p.width === W && p.height === H) return null;
      io.reserve(n * p.width * p.height * bppOf(bd));
      const off = canvasOffsets(W, H, p.width, p.height, p.position);
      const channels = [];
      for (let i = 0; i < n; i++) {
        const ch = view.channels[i];
        channels.push({ data: canvasChannel(ch.data, W, H, p.width, p.height, off.x, off.y), name: ch.name, color: ch.color, display: displayOf(ch) });
        await io.tick((i + 1) / n, 'op.canvasSize');
      }
      io.check();
      return { width: p.width, height: p.height, bitDepth: bd, channels, provenance: cleanProvenance(view.provenance) };
    }
  });

  const BIN_METHODS = ['average', 'median', 'min', 'max', 'sum'];
  R.define('bin', {
    kind: 'size', version: 1,
    // The display state (inverted LUT, display range) is not journaled: it is copied into the params when the step is
    // accepted (never on a replay), so a reload replays the pixels the operator saw.
    resolve(view, p) {
      if (p.disp) return p;
      return Object.assign({}, p, { disp: view.channels.map((ch) => {
        const d = ch.display || {};
        return { invert: !!d.invert, min: Number.isFinite(d.min) ? d.min : 0, max: Number.isFinite(d.max) ? d.max : 0 };
      }) });
    },
    validate(p, info) {
      if (!isInt(p.xshrink) || !isInt(p.yshrink) || p.xshrink < 1 || p.yshrink < 1) throw bad('shrink factor');
      if (BIN_METHODS.indexOf(p.method) < 0) throw bad('bin method');
      if (info && (M_floor(info.width / p.xshrink) < 1 || M_floor(info.height / p.yshrink) < 1)) throw fail('IJ_GEOM_BIN_TOO_LARGE', 'the bin factor is larger than the image');
    },
    scratchBytes: (info, p) => info.channels * M_floor(info.width / p.xshrink) * M_floor(info.height / p.yshrink) * bppOf(info.bitDepth) + info.width * info.height * bppOf(info.bitDepth),
    async run(view, p, roi, io) {
      const W = view.width, H = view.height, bd = view.bitDepth, n = view.channels.length;
      const w = M_floor(W / p.xshrink), h = M_floor(H / p.yshrink);
      if (w < 1 || h < 1) throw fail('IJ_GEOM_BIN_TOO_LARGE', 'the bin factor is larger than the image');
      io.reserve(n * w * h * bppOf(bd) + W * H * bppOf(bd));
      const channels = [];
      for (let i = 0; i < n; i++) {
        const ch = view.channels[i];
        const d = (p.disp && p.disp[i]) || { invert: !!(ch.display && ch.display.invert), min: ch.display ? ch.display.min : 0, max: ch.display ? ch.display.max : 0 };
        const inv = !!d.invert;
        let src = ch.data;
        if (inv) {
          const r = dataRange(src);
          src = bd === 16 ? invertAbout(src, bd, r.min, r.max) : invertAbout(src, bd, d.min, d.max);
        }
        const res = await binImage(src, W, H, bd, p.xshrink, p.yshrink, p.method, (f) => io.tick((i + f) / n, 'op.bin'));
        let data = res.data;
        if (inv) {
          if (bd === 16) { const r = dataRange(data); data = invertAbout(data, bd, r.min, r.max); } else data = invertAbout(data, bd, d.min, d.max);
        }
        let display = displayOf(ch);
        // Binner.shrink: if (method==SUM && imp2.getBitDepth()>8) ip.setMinAndMax(ip.getMin(), ip.getMax()*xshrink*yshrink*zshrink);
        if (p.method === 'sum' && bd > 8 && display) display.max = bd === 16 ? M_min(65535, d.max * p.xshrink * p.yshrink) : d.max * p.xshrink * p.yshrink;
        channels.push({ data, name: ch.name, color: ch.color, display });
        await io.tick((i + 1) / n, 'op.bin');
      }
      io.check();
      // Binner.shrink: if (cal2.scaled()) { cal2.pixelWidth *= xshrink; cal2.pixelHeight *= yshrink; cal2.pixelDepth *= zshrink; }
      return { width: w, height: h, bitDepth: bd, calibration: scaledCalibration(view.calibration, p.xshrink, p.yshrink), channels, provenance: cleanProvenance(view.provenance) };
    }
  });

  R.define('setCalibration', {
    kind: 'size', version: 1,
    validate(p) {
      if (!isNum(p.pixelWidth) || !isNum(p.pixelHeight) || !(p.pixelWidth > 0) || !(p.pixelHeight > 0)) throw bad('pixel size');
      if (typeof p.unit !== 'string' || p.unit.length > 32) throw bad('unit');
    },
    async run(view, p) {
      // Calibration only: the very same arrays come back, which the engine records as `changed.calibration`.
      // ImageProperties: only an empty / "none" unit or a zero width resets the calibration (the command maps those to 1/1/pixel);
      // the unit "pixel" with another width is kept as an aspect calibration.
      const u0 = sanitizeUnit(p.unit);
      const unit = (u0 === 'pixels' || u0 === 'px') ? 'pixel' : u0;
      const cal = Object.assign({}, view.calibration || {}, { pixelWidth: p.pixelWidth, pixelHeight: p.pixelHeight, unit });
      return { width: view.width, height: view.height, bitDepth: view.bitDepth, calibration: cal, channels: view.channels.map((c) => ({ data: c.data })) };
    }
  });

  // The pure helpers the commands (page side) and the tests share.
  root.IJGeom = {
    enlargedSize, canvasOffsets, POSITIONS, isScaled, calOf, sanitizeUnit, scaleFill, scaleRegion, cubic,
    kernels: { rotateBand, scaleBand, translateBand, resizeImage, binImage }
  };
})(typeof self !== 'undefined' ? self : globalThis);
