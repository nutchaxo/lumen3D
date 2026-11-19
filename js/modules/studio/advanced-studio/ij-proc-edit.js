/* ij-proc-edit.js — package edit (wave 3): clipboard, draw, new image, options, duplicate, look-up tables, montage.
 *
 * Loaded on the page AND in the worker (ij-worker.js loads it in its own try/catch: a failure here disables the package's commands,
 * it never takes the Advanced view down). Pure: no DOM, no engine globals; the operations are registered with
 * IJOpRegistry.define(name, spec) / defineCommand (ij-core.js).
 *
 *   paste       pixel   ij.ImagePlus.paste + ij.gui.Roi.updatePaste: ip.copyBits(clipboard, x, y, mode) with the transfer mode of
 *                       Edit > Paste Control (ij.process.ByteBlitter / ShortBlitter / FloatBlitter), then ip.reset(mask)
 *   copyRegion  compute ij.ImagePlus.copy: ip.crop() of the selection's bounding box + its mask (the clipboard is held by the page)
 *   draw        pixel   ij.plugin.filter.Filler.draw: ip.setGlobalForegroundColor(); roi.drawPixels(ip)
 *   montage     newdoc  ij.plugin.MontageMaker.makeMontage2 over the channels of a composite
 *   edit.newImage        (worker command)  ij.gui.NewImage.createImage — the new image needs no image to run on
 *   edit.display         (worker command)  the display (look-up table, inversion, range) of every channel, as the engine holds it
 *
 * Also exported (page and tests): IJEdit (the pure parts) and IJLutFile (ij.plugin.LutLoader.openLut / FileSaver.saveAsLut).
 *
 * Reference: ImageJ 1.54p (public domain). Every integer type is simulated the way Java computes it (int arithmetic, (byte) /
 * (short) narrowing, the (int) cast of a double).
 */
(function (root) {
  'use strict';
  const R = root.IJOpRegistry;
  if (!R) return;

  function ijError(code, message) { const e = new Error(message || code); e.code = code; return e; }
  const bytesOf = (bd) => (bd === 8 ? 1 : bd === 16 ? 2 : 4);
  function ctorOf(bd) { return bd === 8 ? Uint8Array : bd === 16 ? Uint16Array : Float32Array; }
  const isInt = (v) => typeof v === 'number' && Number.isInteger(v);
  // Java (int) of a double: NaN -> 0, saturating, truncating toward zero.
  function d2i(x) {
    if (x !== x) return 0;
    if (x >= 2147483647) return 2147483647;
    if (x <= -2147483648) return -2147483648;
    return x < 0 ? Math.ceil(x) : Math.floor(x);
  }
  // Java Math.round(double) -> long (floor(x + 0.5)), narrowed to an int for the values used here
  const jround = (x) => d2i(Math.floor(x + 0.5));
  function multi() { const M = root.IJMulti; if (!M) throw ijError('IJ_MODULE_MISSING', 'package multi'); return M; }

  // ════════════════════════════════════════════════════════════════════════════════════════════════
  //  Edit > Paste: ij.process.Blitter modes of Edit > Paste Control
  // ════════════════════════════════════════════════════════════════════════════════════════════════

  // ij.plugin.frame.PasteController.itemStateChanged: Copy → COPY, Blend → AVERAGE, Difference → DIFFERENCE, Transparent-white →
  // COPY_TRANSPARENT, Transparent-zero → COPY_ZERO_TRANSPARENT, AND, OR, XOR, Add, Subtract, Multiply, Divide, Min, Max.
  const PASTE_MODES = ['copy', 'blend', 'difference', 'transparent-white', 'transparent-zero', 'and', 'or', 'xor', 'add', 'subtract', 'multiply', 'divide', 'min', 'max'];
  const MODE_KERNEL = { copy: 'copy', blend: 'average', difference: 'difference', 'transparent-zero': 'transparent-zero', and: 'and', or: 'or', xor: 'xor',
    add: 'add', subtract: 'subtract', multiply: 'multiply', divide: 'divide', min: 'min', max: 'max' };

  /**
   * out[o..o+n) = out OP s[0..n) for the paste mode `mode` on a `bd`-bit image (the kernels are those of Image Calculator's Blitters, which
   * ij-proc-multi.js ports line by line).
   *   ByteBlitter:  "private int transparent = 255;" ... "case COPY_TRANSPARENT: src = srcPixels[srcIndex++]&255; if (src==transparent)
   *                 dst = pixels[dstIndex]; else dst = src;" (nobody calls setTransparentColor on a paste: white stays transparent)
   *   ShortBlitter / FloatBlitter: "case COPY: case COPY_INVERTED: case COPY_TRANSPARENT: pixels[dstIndex++] = srcPixels[srcIndex++];" — a
   *                 plain copy: Transparent-white means nothing on 16 and 32 bits.
   *   FloatBlitter DIVIDE: "if (useDBZValue && src==0.0) pixels[dstIndex] = divideByZeroValue; else pixels[dstIndex] = pixels[dstIndex]/src;"
   *                 with "boolean useDBZValue = !Float.isInfinite(divideByZeroValue);" (`dbz` = Edit > Options > Misc.)
   */
  function pasteKernel(bd, mode, dbz) {
    const M = multi();
    if (mode === 'transparent-white') {
      if (bd === 8) return (out, o, s, n) => { for (let i = 0; i < n; i++) if (s[i] !== 255) out[o + i] = s[i]; };
      return bd === 32 ? M.floatKernel('copy') : M.intKernel('copy', bd === 8 ? 255 : 65535);
    }
    const op = MODE_KERNEL[mode];
    if (!op) throw ijError('IJ_BAD_ARGS', 'paste mode');
    return bd === 32 ? M.floatKernel(op, dbz) : M.intKernel(op, bd === 8 ? 255 : 65535);
  }

  /**
   * The pixels of the rectangle `rect` of `full` (an image {width, height, data}) after the clipboard {data, w, h} was pasted with its top-left
   * corner at (x, y) in the transfer mode `mode`:
   *   ImagePlus.paste (macro branch) / Roi.updatePaste:  ip.copyBits(clipboard.getProcessor(), x, y, pasteMode);
   *                                                      if (nonRect) { ip.setMask(roi.getMask()); ip.setRoi(roi.getBounds()); ip.reset(ip.getMask()); }
   * copyBits clips the clipboard to the image ("r1 = r1.intersection(r2)"); reset(mask) puts the snapshot back where the mask is 0.
   * `scale` = 2^level of a reduced preview: `full` is then the level image and each of its pixels reads the clipboard at its centre
   * ((q * scale + scale / 2) in image pixels, the engine's own rule for the selection mask of a preview).
   */
  function pasteRegion(full, rect, p, scale) {
    const s = scale > 1 ? scale | 0 : 1;
    const bd = p.bitDepth;
    const Ctor = ctorOf(bd);
    const kernel = pasteKernel(bd, p.mode, p.dbz);
    const out = new Ctor(rect.w * rect.h);
    const srow = bd === 32 ? new Float32Array(rect.w) : new Int32Array(rect.w);
    const act = new Uint8Array(rect.w);
    const tmp = new Ctor(rect.w);
    const half = s >> 1;
    for (let ry = 0; ry < rect.h; ry++) {
      if (p.check && (ry & 127) === 127) p.check();
      const qy = rect.y + ry;
      const base = qy * full.width + rect.x;
      for (let i = 0; i < rect.w; i++) out[ry * rect.w + i] = full.data[base + i];
      const gy = s === 1 ? qy : qy * s + half;
      const cy = gy - p.y;
      if (cy < 0 || cy >= p.h) continue;
      let any = false;
      for (let i = 0; i < rect.w; i++) {
        const gx = s === 1 ? rect.x + i : (rect.x + i) * s + half;
        const cx = gx - p.x;
        if (cx < 0 || cx >= p.w || (p.mask && p.mask[cy * p.w + cx] === 0)) { act[i] = 0; continue; }
        act[i] = 1; any = true;
        srow[i] = p.data[cy * p.w + cx];
      }
      if (!any) continue;
      const o = ry * rect.w;
      for (let i = 0; i < rect.w; i++) tmp[i] = out[o + i];
      kernel(tmp, 0, srow, rect.w);
      for (let i = 0; i < rect.w; i++) if (act[i]) out[o + i] = tmp[i];
    }
    return out;
  }

  function validatePaste(params, info) {
    const p = params || {};
    if (PASTE_MODES.indexOf(p.mode) < 0) throw ijError('IJ_BAD_ARGS', 'mode');
    if (!isInt(p.w) || p.w < 1 || !isInt(p.h) || p.h < 1 || !isInt(p.x) || !isInt(p.y)) throw ijError('IJ_BAD_ARGS', 'geometry');
    if (p.divZero !== undefined && (typeof p.divZero !== 'string' || p.divZero.length > 64 || multi().parseDivZero(p.divZero) === null)) throw ijError('IJ_BAD_ARGS', 'divZero');
    const d = p.data;
    if (!ArrayBuffer.isView(d)) throw ijError('IJ_BAD_ARGS', 'clipboard data');
    // "ByteBlitter ... ip.convertToByte(true)": ImageJ converts a clipboard of another type; this plugin says so instead
    if (d.constructor.name !== ctorOf(info.bitDepth).name) throw ijError('IJ_EDIT_PASTE_TYPE', 'the clipboard is not a ' + info.bitDepth + '-bit image');
    if (d.length !== p.w * p.h) throw ijError('IJ_BAD_ARGS', 'clipboard size');
    if (p.mask !== undefined && p.mask !== null && !(ArrayBuffer.isView(p.mask) && p.mask.constructor.name === 'Uint8Array' && p.mask.length === p.w * p.h)) throw ijError('IJ_BAD_ARGS', 'mask');
  }

  R.define('paste', {
    kind: 'pixel', version: 1, channels: 'one', roi: 'bounds', preview: 'reduced',
    validate: validatePaste,
    scratchBytes: (info) => 16 * info.width + 8 * 1048576,
    prepare(view, c, params, ctx) {
      const scale = ctx && ctx.scale ? ctx.scale : 1;
      const dbz = params.divZero === undefined ? undefined : multi().parseDivZero(params.divZero);
      const p = { data: params.data, w: params.w, h: params.h, x: params.x, y: params.y, mode: params.mode, mask: params.mask || null, bitDepth: view.bitDepth, dbz, check: ctx && ctx.check };
      // The work window of a reduced preview is placed from the view's own rectangle: the clipboard is positioned from the image's origin, so
      // the window must start there — an apron as large as the image makes it the whole level image.
      return {
        apron: { x: view.width, y: view.height }, whole: true,
        async region(full, rect) {
          if (ctx && ctx.check) ctx.check();
          const out = pasteRegion(full, rect, p, scale);
          if (ctx && ctx.tick) await ctx.tick(1, 'op.paste');
          return out;
        }
      };
    }
  });

  // ImagePlus.copy: the selection's bounding box (area selections only, "Roi roi = getRoi(); if (roi!=null && !roi.isArea()) roi = null;")
  // clipped to the image, and its mask. A rectangle needs no mask ("if (roi!=null && roi.getType()!=Roi.RECTANGLE) getMask()").
  R.define('copyRegion', {
    kind: 'compute', version: 1, channels: 'one', roi: 'ignore',
    scratchBytes: (info) => info.width * info.height * bytesOf(info.bitDepth) + 4 * info.width * info.height,
    async run(view, params, roi, io) {
      const W = view.width, H = view.height, bd = view.bitDepth;
      const c = isInt(io.channel) ? io.channel : (view.active || 0);
      if (!isInt(c) || c < 0 || c >= view.channels.length) throw ijError('IJ_BAD_ARGS', 'channel');
      const IJRoi = root.IJRoi;
      let box = { x: 0, y: 0, w: W, h: H }, maskBox = null;
      if (roi && IJRoi) {
        IJRoi.validate(roi);
        if (IJRoi.isArea(roi)) {
          const m = IJRoi.mask(roi, W, H);
          if (!(m.w > 0 && m.h > 0)) throw ijError('IJ_EMPTY_ROI', 'the selection is outside the image');
          box = { x: m.x, y: m.y, w: m.w, h: m.h };
          if (roi.type !== 'rect') maskBox = m;
        }
      }
      io.reserve(box.w * box.h * (bytesOf(bd) + 1));
      const src = view.channels[c].data;
      const data = new (ctorOf(bd))(box.w * box.h);
      for (let y = 0; y < box.h; y++) {
        const o = (box.y + y) * W + box.x;
        data.set(src.subarray(o, o + box.w), y * box.w);
        if ((y & 255) === 255) { io.check(); await io.tick(y / box.h, 'op.copyRegion'); }
      }
      const result = { x: box.x, y: box.y, w: box.w, h: box.h, bitDepth: bd, data, mask: maskBox ? Uint8Array.from(maskBox.data) : null };
      io.transfer(data.buffer);
      if (result.mask) io.transfer(result.mask.buffer);
      return result;
    }
  });

  // ════════════════════════════════════════════════════════════════════════════════════════════════
  //  Edit > Draw: ij.plugin.filter.Filler.draw → Roi.drawPixels(ip)
  // ════════════════════════════════════════════════════════════════════════════════════════════════

  /**
   * The drawing primitives of ij.process.ImageProcessor on one channel: moveTo / lineTo with a line width (drawPixel for 1, drawDot2 for 2,
   * drawDot above), drawRect, drawPolygon. `fg` is what ip.setValue(value) stores:
   *   ByteProcessor / ShortProcessor.setValue: "fgColor = (int)value; if (fgColor<0) fgColor = 0; if (fgColor>255 | 65535) ..."
   *   FloatProcessor.setValue: "fillColor = (float)value;"
   * The clipping rectangle of a processor is the whole image (resetRoi), whatever the selection: Filler.draw sets no mask.
   */
  function makeRaster(data, W, H, bd, value, width0) {
    let fg;
    if (bd === 32) fg = Math.fround(value);
    else { fg = d2i(value); const top = bd === 8 ? 255 : 65535; if (fg < 0) fg = 0; if (fg > top) fg = top; }
    const clipXMin = 0, clipXMax = W - 1, clipYMin = 0, clipYMax = H - 1;
    let lineWidth = width0 < 1 ? 1 : width0;
    let cx = 0, cy = 0;
    const dotMasks = new Map();

    function drawPixel(x, y) { if (x >= clipXMin && x <= clipXMax && y >= clipYMin && y <= clipYMax) data[y * W + x] = fg; }
    function drawDot2(x, y) { drawPixel(x, y); drawPixel(x - 1, y); drawPixel(x, y - 1); drawPixel(x - 1, y - 1); }
    // ImageProcessor.drawDot: a lineWidth x lineWidth dot whose pixels are those of OvalRoi(0, 0, lineWidth, lineWidth).getMask()
    function drawDot(xc, yc) {
      let r = lineWidth / 2.0;
      const xmin = d2i(xc - r + 0.5), ymin = d2i(yc - r + 0.5);
      const xmax = xmin + lineWidth, ymax = ymin + lineWidth;
      if (xmin < clipXMin || ymin < clipYMin || xmax > clipXMax || ymax > clipYMax) {
        // "draw edge dot": r2 = r*r; r -= 0.5; xoffset = xmin+r ... if (xx*xx+yy*yy<=r2) drawPixel(x, y)
        const r2 = r * r;
        r -= 0.5;
        const xo = xmin + r, yo = ymin + r;
        for (let y = ymin; y < ymax; y++) {
          for (let x = xmin; x < xmax; x++) {
            const xx = x - xo, yy = y - yo;
            if (xx * xx + yy * yy <= r2) drawPixel(x, y);
          }
        }
      } else {
        let m = dotMasks.get(lineWidth);
        if (!m) { m = ovalMask(lineWidth, lineWidth); dotMasks.set(lineWidth, m); }
        for (let y = 0; y < lineWidth; y++) for (let x = 0; x < lineWidth; x++) if (m[y * lineWidth + x]) data[(ymin + y) * W + xmin + x] = fg;
      }
    }
    // ImageProcessor.lineTo
    function lineTo(x2, y2) {
      const lw2 = (lineWidth / 2) | 0;
      const xMin = clipXMin - lw2 - 1, xMax = clipXMax + lw2 + 1, yMin = clipYMin - lw2 - 1, yMax = clipYMax + lw2 + 1;
      const dx = x2 - cx, dy = y2 - cy;
      const absdx = dx >= 0 ? dx : -dx, absdy = dy >= 0 ? dy : -dy;
      const n = absdy > absdx ? absdy : absdx;
      const xinc = dx !== 0 ? dx / n : 0;
      const yinc = dy !== 0 ? dy / n : 0;
      let x = cx, y = cy;
      cx = x2; cy = y2;
      let i1 = 0;
      if (dx > 0) i1 = Math.max(i1, d2i((xMin - x) / xinc));
      else if (dx < 0) i1 = Math.max(i1, d2i((xMax - x) / xinc));
      else if (x < xMin || x > xMax) return;
      if (dy > 0) i1 = Math.max(i1, d2i((yMin - y) / yinc));
      else if (dy < 0) i1 = Math.max(i1, d2i((yMax - y) / yinc));
      else if (y < yMin || y > yMax) return;
      let i2 = n;
      if (dx > 0) i2 = Math.min(i2, d2i((xMax - x) / xinc));
      else if (dx < 0) i2 = Math.min(i2, d2i((xMin - x) / xinc));
      if (dy > 0) i2 = Math.min(i2, d2i((yMax - y) / yinc));
      else if (dy < 0) i2 = Math.min(i2, d2i((yMin - y) / yinc));
      x += i1 * xinc;
      y += i1 * yinc;
      for (let i = i1; i <= i2; i++) {
        if (lineWidth === 1) drawPixel(jround(x), jround(y));
        else if (lineWidth === 2) drawDot2(jround(x), jround(y));
        else drawDot(jround(x), jround(y));
        x += xinc;
        y += yinc;
      }
    }
    return {
      moveTo(x, y) { cx = x; cy = y; },
      lineTo,
      setLineWidth(w) { lineWidth = w < 1 ? 1 : w; },
      getLineWidth: () => lineWidth,
      // ImageProcessor.drawRect: "if (lineWidth==1) { moveTo(x, y); lineTo(x+width-1, y); ... } else { moveTo(x, y); lineTo(x+width, y); ...}"
      drawRect(x, y, w, h) {
        if (w < 1 || h < 1) return;
        const a = lineWidth === 1 ? 1 : 0;
        this.moveTo(x, y);
        lineTo(x + w - a, y);
        lineTo(x + w - a, y + h - a);
        lineTo(x, y + h - a);
        lineTo(x, y);
      },
      // ImageProcessor.drawPolygon: "moveTo(p.xpoints[0], p.ypoints[0]); for (i<npoints) lineTo(p.xpoints[i], p.ypoints[i]); lineTo(p.xpoints[0], ...)"
      drawPolygon(xs, ys) {
        this.moveTo(xs[0], ys[0]);
        for (let i = 0; i < xs.length; i++) lineTo(xs[i], ys[i]);
        lineTo(xs[0], ys[0]);
      }
    };
  }

  /**
   * ij.gui.OvalRoi.getMask: "double a=width/2.0, b=height/2.0; double a2=a*a, b2=b*b; a -= 0.5; b -= 0.5; ...
   * xx = x - a; yy = y - b; if ((xx*xx/a2+yy*yy/b2)<=1.0) pixels[offset+x] = -1;"
   */
  function ovalMask(width, height) {
    const m = new Uint8Array(width * height);
    let a = width / 2.0, b = height / 2.0;
    const a2 = a * a, b2 = b * b;
    a -= 0.5; b -= 0.5;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const xx = x - a, yy = y - b;
        if ((xx * xx / a2 + yy * yy / b2) <= 1.0) m[y * width + x] = 1;
      }
    }
    return m;
  }

  /** The outline of a binary mask as the vertices of its traced polygon (direction changes only) — OvalRoi.getPolygon's Wand. */
  function maskOutlines(mask, w, h, ox, oy) {
    const IJRoi = root.IJRoi;
    const r = IJRoi.fromMask(mask, w, h);
    if (!r.w) return [];
    const loops = IJRoi.outlines(r);
    return loops.map((l) => l.map((p) => [p[0] + ox, p[1] + oy]));
  }

  /**
   * Roi.drawPixels(ip) of every selection type, quoting the source:
   *   Roi (rectangle):  "if (getStrokeWidth()>1f) ip.setLineWidth((int)Math.round(getStrokeWidth()));
   *                      if (ip.getLineWidth()==1) ip.drawRect(x, y, width+1, height+1); else ip.drawRect(x, y, width, height);"
   *   OvalRoi:          the polygon of its mask (Wand) through ip.drawPolygon, the same stroke width rule
   *   PolygonRoi:       "ip.moveTo(round(x0), round(y0)); for (i=1..) ip.lineTo(round(xi), round(yi)); if (type==POLYGON || type==FREEROI
   *                      || type==TRACED_ROI) ip.lineTo(round(x0), round(y0));" (round = (int)Math.round, half up)
   *   Line:             "boolean fillLine = getStrokeWidth()>1 && getWidth()<=1; if (fillLine) ip.setLineWidth((int)Math.round(getStrokeWidth()));
   *                      else ip.setLineWidth(1); ... if (getStrokeWidth()<=1 || fillLine) { ip.moveTo(round(x1), round(y1)); ip.lineTo(round(x2),
   *                      round(y2)); } else { Polygon p = getPolygon(); ip.drawPolygon(p); }"   (getWidth() is the static Line width)
   *   PointRoi:         "ip.setLineWidth(Analyzer.markWidth); for each point: ip.moveTo(round(x), round(y)); ip.lineTo(round(x), round(y));"
   *                     (markWidth is 0 unless Set Measurements asked for a mark: one pixel)
   *   ShapeRoi (a selection with holes, here a mask): the flattened outline of every ring, "ip.moveTo(x+(int)sx, y+(int)sy)", "ip.lineTo(...)",
   *                     "case SEG_CLOSE: ip.lineTo(x+(int)sx, y+(int)sy)" — and NO setLineWidth: the processor's own width.
   * `lw0` = ip.getLineWidth() when the call starts (PlugInFilterRunner: ip.setLineWidth(Line.getWidth())).
   */
  function drawRoiPixels(r, roi, strokeWidth, lw0) {
    const IJRoi = root.IJRoi;
    const sw = strokeWidth > 1 ? Math.round(strokeWidth) : 0;
    switch (roi.type) {
      case 'rect': {
        const b = IJRoi.bounds(roi);
        if (sw) r.setLineWidth(sw);
        if (r.getLineWidth() === 1) r.drawRect(b.x, b.y, b.w + 1, b.h + 1); else r.drawRect(b.x, b.y, b.w, b.h);
        r.setLineWidth(lw0);
        return;
      }
      case 'oval': {
        const b = IJRoi.bounds(roi);
        const m = ovalMask(b.w, b.h);
        const loops = maskOutlines(m, b.w, b.h, b.x, b.y);
        if (sw) r.setLineWidth(sw);
        for (const l of loops) r.drawPolygon(l.map((p) => p[0]), l.map((p) => p[1]));
        r.setLineWidth(lw0);
        return;
      }
      case 'polygon': case 'freehand': case 'polyline': case 'angle': {
        const pts = roi.points;
        if (sw) r.setLineWidth(sw);
        r.moveTo(jround(pts[0][0]), jround(pts[0][1]));
        for (let i = 1; i < pts.length; i++) r.lineTo(jround(pts[i][0]), jround(pts[i][1]));
        if (roi.type === 'polygon' || roi.type === 'freehand') r.lineTo(jround(pts[0][0]), jround(pts[0][1]));
        r.setLineWidth(lw0);
        return;
      }
      case 'line': {
        const fillLine = strokeWidth > 1 && lw0 <= 1;
        r.setLineWidth(fillLine ? Math.round(strokeWidth) : 1);
        if (strokeWidth <= 1 || fillLine) {
          r.moveTo(jround(roi.x1), jround(roi.y1));
          r.lineTo(jround(roi.x2), jround(roi.y2));
        } else {
          const poly = linePolygon(roi, strokeWidth);
          r.drawPolygon(poly.map((p) => p[0]), poly.map((p) => p[1]));
        }
        r.setLineWidth(lw0);
        return;
      }
      case 'point': {
        r.setLineWidth(1);
        for (const p of roi.points) { const x = jround(p[0]), y = jround(p[1]); r.moveTo(x, y); r.lineTo(x, y); }
        r.setLineWidth(lw0);
        return;
      }
      case 'mask': {
        r.setLineWidth(lw0);
        for (const l of IJRoi.outlines(roi)) {
          r.moveTo(l[0][0] | 0, l[0][1] | 0);
          for (let i = 1; i < l.length; i++) r.lineTo(l[i][0] | 0, l[i][1] | 0);
          r.lineTo(l[0][0] | 0, l[0][1] | 0);
        }
        return;
      }
      default: throw ijError('IJ_BAD_ROI', 'type');
    }
  }

  /**
   * Line.getPolygon() of a wide line: "toIntR(getFloatPolygon(strokeWidth))" with the four corners
   *   dx = (x2-x1) * 0.5/len, dy = (y2-y1) * 0.5/len;  p1 = (x1+0.5-dx+dy*w, y1+0.5-dy-dx*w);  p2 = (x1+0.5-dx-dy*w, y1+0.5-dy+dx*w);
   *   p3 = (x2+0.5+dx-dy*w, y2+0.5+dy+dx*w);  p4 = (x2+0.5+dx+dy*w, y2+0.5+dy-dx*w)       (each cast to float)
   * and toIntR = (int)Math.round of the float.
   */
  function linePolygon(roi, w) {
    const x1 = roi.x1, y1 = roi.y1, x2 = roi.x2, y2 = roi.y2;
    let dx = x2 - x1, dy = y2 - y1;
    const len = Math.sqrt(dx * dx + dy * dy);
    dx *= 0.5 / len; dy *= 0.5 / len;
    const f = Math.fround;
    const pts = [
      [x1 + 0.5 - dx + dy * w, y1 + 0.5 - dy - dx * w], [x1 + 0.5 - dx - dy * w, y1 + 0.5 - dy + dx * w],
      [x2 + 0.5 + dx - dy * w, y2 + 0.5 + dy + dx * w], [x2 + 0.5 + dx + dy * w, y2 + 0.5 + dy - dx * w]];
    return pts.map((p) => [jround(f(p[0])), jround(f(p[1]))]);
  }

  /** `data` copy with the selection drawn: the pure core of the `draw` operation. */
  function drawRoi(src, W, H, bd, roi, value, lineWidth, staticWidth) {
    const data = src.slice();
    const lw0 = staticWidth > 1 ? Math.round(staticWidth) : 1;
    const r = makeRaster(data, W, H, bd, value, lw0);
    drawRoiPixels(r, roi, lineWidth, lw0);
    return data;
  }

  // params { value, lineWidth, staticWidth?, shape? }: `value` = ip.setValue(value) (the page computes the foreground colour's value for the
  // channel: api.colorValue), `lineWidth` = the selection's stroke width (1 = none), `staticWidth` = Line.getWidth(), the width the
  // processor itself draws with (absent = 1). The selection is `shape` — a pixel operation is not handed the selection's SHAPE by the engine
  // (only its mask), so the page passes it with the parameters; `ctx.roi` is taken when an engine hands it over.
  R.define('draw', {
    kind: 'pixel', version: 1, roi: 'ignore', preview: false,
    validate(params) {
      const p = params || {};
      if (typeof p.value !== 'number' || !isFinite(p.value)) throw ijError('IJ_BAD_ARGS', 'value');
      if (!isInt(p.lineWidth) || p.lineWidth < 1 || p.lineWidth > 1000) throw ijError('IJ_BAD_ARGS', 'lineWidth');
      if (p.staticWidth !== undefined && (!isInt(p.staticWidth) || p.staticWidth < 1 || p.staticWidth > 1000)) throw ijError('IJ_BAD_ARGS', 'staticWidth');
      if (p.shape !== undefined && p.shape !== null) root.IJRoi.validate(p.shape);
    },
    scratchBytes: (info) => info.width * info.height * bytesOf(info.bitDepth),
    prepare(view, c, params, ctx) {
      const shape = params.shape || (ctx && ctx.roi) || null;
      if (!shape) throw ijError('IJ_NEEDS_ROI', 'draw needs the selection');
      return { apron: { x: 0, y: 0 }, whole: true, fn: (src) => drawRoi(src.data, src.width, src.height, view.bitDepth, shape, params.value, params.lineWidth, params.staticWidth || 1) };
    }
  });

  // ════════════════════════════════════════════════════════════════════════════════════════════════
  //  File > New > Image: ij.gui.NewImage
  // ════════════════════════════════════════════════════════════════════════════════════════════════

  const NEW_FILLS = ['white', 'black', 'ramp', 'noise'];
  /**
   * ByteProcessor / ShortProcessor.noise(sd): "ran = (int)Math.round(rnd.nextGaussian()*standardDeviation); v = pixels[i] + ran;
   * inRange = v>=0 && v<=255 (65535); if (inRange) pixels[i] = v" repeated until in range, row after row, one stream. FloatProcessor.noise:
   * "float RandomBrightness = (float)(rnd.nextGaussian()*standardDeviation); pixels[i] = pixels[i] + RandomBrightness;"
   * `rnd.setSeed((int)seed)` once (ImageProcessor.setRandomSeed); `io` (optional) is ticked every ~32 K pixels.
   */
  async function addNoise(data, bd, sd, rnd, io) {
    const n = data.length;
    if (bd === 32) {
      for (let i = 0; i < n; i++) {
        data[i] = data[i] + Math.fround(rnd.nextGaussian() * sd);
        if (io && (i & 32767) === 32767) { io.check(); await io.tick(i / n, 'op.newImage'); }
      }
      return;
    }
    const top = bd === 8 ? 255 : 65535;
    for (let i = 0; i < n; i++) {
      for (;;) {
        const ran = jround(rnd.nextGaussian() * sd);
        const v = data[i] + ran;
        if (v >= 0 && v <= top) { data[i] = v; break; }
      }
      if (io && (i & 32767) === 32767) { io.check(); await io.tick(i / n, 'op.newImage'); }
    }
  }

  /**
   * NewImage.createByteImage / createShortImage / createFloatImage.
   *   White   8-bit: every pixel 255.  16 and 32 bits: zeros and "ip.invertLut()" (`invert` true): "if (fill==FILL_WHITE) ip.invertLut();"
   *   Black   zeros.
   *   Ramp    8-bit  ramp[i] = (byte)((i*256.0)/width);   16-bit  (short)(((i*65536.0)/width)+0.5);   32-bit  (float)((i*1.0)/width)
   *   Noise   8-bit  ip.add(127); ip.noise(31)   16-bit  ip.add(32767); ip.noise(7940)   32-bit  ip.noise(1)
   * The display range: 8-bit 0..255; 16-bit "imp.getProcessor().setMinAndMax(0, 65535)"; 32-bit "if (fill!=FILL_NOISE) setMinAndMax(0.0, 1.0)"
   * (a noise image keeps the range of its data, FloatProcessor.findMinAndMax).
   */
  async function makeNewImage(bd, fill, width, height, seed, io) {
    if (NEW_FILLS.indexOf(fill) < 0) throw ijError('IJ_BAD_ARGS', 'fill');
    const Ctor = ctorOf(bd);
    const data = new Ctor(width * height);
    let invert = false;
    if (fill === 'white') {
      if (bd === 8) data.fill(255); else invert = true;
    } else if (fill === 'ramp') {
      const ramp = new Ctor(width);
      for (let i = 0; i < width; i++) ramp[i] = bd === 8 ? d2i((i * 256.0) / width) & 255 : bd === 16 ? d2i(((i * 65536.0) / width) + 0.5) & 0xffff : Math.fround((i * 1.0) / width);
      for (let y = 0; y < height; y++) data.set(ramp, y * width);
    } else if (fill === 'noise') {
      const rnd = new root.IJShared.JavaRandom(seed | 0);
      if (bd === 8) { data.fill(127); await addNoise(data, 8, 31, rnd, io); }
      else if (bd === 16) { data.fill(32767); await addNoise(data, 16, 7940, rnd, io); }
      else await addNoise(data, 32, 1, rnd, io);
    }
    let min = 0, max = bd === 8 ? 255 : bd === 16 ? 65535 : 1;
    if (bd === 32 && fill === 'noise') {
      const r = root.IJImage.dataRange(data);
      min = r.min; max = r.max;
      if (!(max > min)) { min = 0; max = 1; }
    }
    return { data, invert, display: { min, max, lut: 'Grays', invert } };
  }

  R.defineCommand('edit.newImage', {
    pkg: 'edit', long: true,
    async handler(a, E) {
      const bd = a.bitDepth;
      if (bd !== 8 && bd !== 16 && bd !== 32) throw E.ijError('IJ_BAD_ARGS', 'bitDepth');
      if (!isInt(a.width) || !isInt(a.height) || a.width < 1 || a.height < 1) throw E.ijError('IJ_BAD_ARGS', 'size');
      // ImageJ refuses more than 2 gigapixels; the budget refuses before that (the arrays are allocated only once it said yes)
      if (a.width * a.height > 268435456) throw E.ijError('IJ_TOO_LARGE', 'image too large');
      const name = typeof a.name === 'string' && a.name.trim() ? a.name.trim().slice(0, 255) : 'Untitled';
      E.reserve(a.width * a.height * bytesOf(bd));
      const img = await makeNewImage(bd, a.fill, a.width, a.height, a.seed, E);
      E.check();
      const info = E.createDoc({
        name, width: a.width, height: a.height, bitDepth: bd,
        channels: [{ name: 'C1', color: '#ffffff', data: img.data, display: img.display }]
      }, { provenance: { newImage: { fill: a.fill, seed: a.fill === 'noise' ? (a.seed | 0) : null } } });
      return { info };
    }
  });

  // What the engine holds as the display of each channel of a document (the page's own copy can be a patch behind).
  R.defineCommand('edit.display', {
    pkg: 'edit',
    handler(a, E) {
      const v = E.readDoc(a.docId);
      return {
        mode: v.mode, active: v.active,
        channels: v.channels.map((c) => ({ name: c.name, color: c.color, min: c.display.min, max: c.display.max, lut: c.display.lut === undefined ? null : c.display.lut, invert: !!c.display.invert }))
      };
    }
  });

  // ════════════════════════════════════════════════════════════════════════════════════════════════
  //  Stacks > Make Montage: ij.plugin.MontageMaker over the channels of a composite
  // ════════════════════════════════════════════════════════════════════════════════════════════════

  /** ImagePlus.getImage of a composite channel in COLOR mode: the 8-bit index of each pixel and the channel's table (with its inversion). */
  function channelTable(ch, grayMode) {
    const IJLuts = root.IJLuts;
    let t;
    if (grayMode) return IJLuts.get('Grays');
    const d = ch.display || {};
    t = IJLuts.get(d.lut === undefined || d.lut === null ? (ch.color || '#ffffff') : d.lut);
    if (d.invert) {
      const r = new Uint8Array(768);
      for (let i = 0; i < 256; i++) { const j = 255 - i; r[i * 3] = t[j * 3]; r[i * 3 + 1] = t[j * 3 + 1]; r[i * 3 + 2] = t[j * 3 + 2]; }
      t = r;
    }
    return t;
  }

  /**
   * The 8-bit index each stored value is shown at, as the processor's create8BitImage / cm do:
   *   8-bit   ByteProcessor.setMinAndMax(min, max): "for (i<256) { if (i<min) lut[i] = lut1[0]; else if (i>max) lut[i] = lut1[255]; else {
   *           index = i-this.min; index = (int)(256.0*index/(max-min)); clamp 0..255; lut[i] = lut1[index]; } }" (this.min = (int)Math.round(min))
   *   16-bit  ShortProcessor.create8BitImage: "min2=(int)getMin(), max2=(int)getMax(); scale = 256.0/(max2-min2+1); value = (pixels[i]&0xffff)-min2;
   *           if (value<0) value = 0; value = (int)(value*scale+0.5); if (value>255) value = 255;"  (setMinAndMax stores (int)Math.round; 0,0 resets)
   *   32-bit  FloatProcessor.create8BitImage: "min2 = getMin(), max2 = getMax(); scale = 255.0/(max2-min2); value = pixels[i]-min2;
   *           if (value<0.0) value=0.0; ivalue = (int)(value*scale+0.5); if (ivalue>255) ivalue = 255;"  (setMinAndMax stores (float))
   */
  function displayIndexer(bd, dmin, dmax, data) {
    if (bd === 8) {
      const lut = new Uint8Array(256);
      const imin = jround(dmin);
      for (let i = 0; i < 256; i++) {
        if (i < dmin) lut[i] = 0;
        else if (i > dmax) lut[i] = 255;
        else { let k = d2i(256.0 * (i - imin) / (dmax - dmin)); if (k < 0) k = 0; if (k > 255) k = 255; lut[i] = k; }
      }
      return (v) => lut[v];
    }
    if (bd === 16) {
      let mn = jround(dmin), mx = jround(dmax);
      if (dmin === 0 && dmax === 0) { const r = root.IJImage.dataRange(data); mn = r.min; mx = r.max; }
      const scale = 256.0 / (mx - mn + 1);
      return (v) => { let q = v - mn; if (q < 0) q = 0; q = d2i(q * scale + 0.5); return q > 255 ? 255 : q; };
    }
    let mn = Math.fround(dmin), mx = Math.fround(dmax);
    if (dmin === 0 && dmax === 0) { const r = root.IJImage.dataRange(data); mn = Math.fround(r.min); mx = Math.fround(r.max); }
    const scale = 255.0 / (mx - mn);
    return (v) => { let q = v - mn; if (q < 0.0) q = 0.0; q = d2i(q * scale + 0.5); return q > 255 ? 255 : q; };
  }

  /**
   * One channel rendered to its R, G, B planes (the ColorProcessor of the composite's COLOR mode). With `io` the work is done in slices of
   * about a million pixels between two checks for Cancel (the page's tests and small images call it without).
   */
  function renderChannelRGB(ch, bd, grayMode, io) {
    const n = ch.data.length;
    const table = channelTable(ch, grayMode);
    const d = ch.display || { min: 0, max: bd === 8 ? 255 : 65535 };
    const ix = displayIndexer(bd, d.min, d.max, ch.data);
    const r = new Uint8Array(n), g = new Uint8Array(n), b = new Uint8Array(n);
    const data = ch.data;
    const fill = (from, to) => { for (let i = from; i < to; i++) { const k = ix(data[i]) * 3; r[i] = table[k]; g[i] = table[k + 1]; b[i] = table[k + 2]; } };
    if (!io) { fill(0, n); return { r, g, b }; }
    return (async () => {
      const STEP = 1 << 20;
      for (let from = 0; from < n; from += STEP) { io.check(); fill(from, Math.min(n, from + STEP)); await io.tick(Math.min(1, (from + STEP) / n), 'op.montage'); }
      return { r, g, b };
    })();
  }

  /**
   * MontageMaker.makeMontage: the dialog's defaults for a stack of n slices of width W:
   *   "columns = (int)Math.sqrt(nSlices); rows = columns; int n = nSlices - columns*rows; if (n>0) columns += (int)Math.ceil((double)n/rows);
   *    scale = 1.0; if (imp.getWidth()*columns>800) scale = 0.5; if (imp.getWidth()*columns>1600) scale = 0.25; inc = 1; first = 1; last = nSlices;"
   */
  function montageDefaults(n, W) {
    let columns = d2i(Math.sqrt(n));
    const rows = columns;
    const rest = n - columns * rows;
    if (rest > 0) columns += d2i(Math.ceil(rest / rows));
    let scale = 1.0;
    if (W * columns > 800) scale = 0.5;
    if (W * columns > 1600) scale = 0.25;
    return { columns, rows, scale, first: 1, last: n, increment: 1, border: 0, fontSize: 12 };
  }

  /** The dialog's clamps: "if (borderWidth<0) borderWidth = 0; if (first<1) first = 1; if (last>nSlices) last = nSlices; if (first>last) {first=1; last=nSlices;} if (inc<1) inc = 1;" */
  function montageClamp(p, n) {
    const o = Object.assign({}, p);
    if (o.border < 0) o.border = 0;
    if (o.first < 1) o.first = 1;
    if (o.last > n) o.last = n;
    if (o.first > o.last) { o.first = 1; o.last = n; }
    if (o.increment < 1) o.increment = 1;
    return o;
  }

  /** The montage's size: "width = (int)(stackWidth*scale); ... montageWidth = width*columns + borderWidth*(columns-1);" */
  function montageSize(W, H, p) {
    const width = d2i(W * p.scale), height = d2i(H * p.scale);
    return { width, height, mw: width * p.columns + p.border * (p.columns - 1), mh: height * p.rows + p.border * (p.rows - 1) };
  }

  function validateMontage(params, info) {
    const p = params || {};
    for (const k of ['columns', 'rows', 'first', 'last', 'increment', 'border']) if (!isInt(p[k])) throw ijError('IJ_BAD_ARGS', k);
    if (p.columns < 1 || p.rows < 1 || p.border > 10000) throw ijError('IJ_BAD_ARGS', 'layout');
    if (typeof p.scale !== 'number' || !(p.scale > 0) || !isFinite(p.scale)) throw ijError('IJ_BAD_ARGS', 'scale');
    for (const k of ['fg', 'bg']) if (p[k] !== undefined && p[k] !== null && !(Array.isArray(p[k]) && p[k].length === 3 && p[k].every((v) => isInt(v) && v >= 0 && v <= 255))) throw ijError('IJ_BAD_ARGS', k);
    const s = montageSize(info.width, info.height, p);
    if (s.width < 1 || s.height < 1) throw ijError('IJ_BAD_ARGS', 'scale');
    if (s.mw * s.mh > 268435456) throw ijError('IJ_TOO_LARGE', 'montage');
  }

  R.define('montage', {
    kind: 'newdoc', version: 1, roi: 'ignore', bitDepths: [8, 16, 32],
    validate: validateMontage,
    scratchBytes(info, params) {
      const p = params || {};
      if (!isInt(p.columns) || !isInt(p.rows) || !(p.scale > 0)) return 0;
      const s = montageSize(info.width, info.height, p);
      return 3 * s.mw * s.mh + 12 * info.width * info.height + 6 * s.width * s.height;
    },
    async run(view, params, roi, io) {
      const n = view.channels.length;
      if (n < 2) throw ijError('IJ_EDIT_STACK_REQUIRED', 'a stack is required');
      const W = view.width, H = view.height, bd = view.bitDepth;
      const p = montageClamp(params, n);
      const { width, height, mw, mh } = montageSize(W, H, p);
      const grayMode = view.mode === 'gray';
      // MontageMaker.makeMontage2: "if (useForegroundColor) { fgColor = Toolbar.getForegroundColor(); bgColor = Toolbar.getBackgroundColor(); } else {
      //   boolean whiteBackground = false; if ((ip instanceof ByteProcessor) || (ip instanceof ColorProcessor)) { ip.setRoi(0, stackHeight-12,
      //   stackWidth, 12); stats = getStatistics(ip, MODE); ip.resetRoi(); whiteBackground = stats.mode>=200; if (imp.isInvertedLut()) ... }
      //   if (whiteBackground) { fgColor=Color.black; bgColor = Color.white; } }"   (default fgColor white, bgColor black)
      let fg = [255, 255, 255], bg = [0, 0, 0];
      const first = await renderChannelRGB(view.channels[0], bd, grayMode, io);
      if (p.useForeground) { fg = p.fg || fg; bg = p.bg || bg; }
      else {
        // ColorProcessor.getHistogram of the bottom 12 rows of slice 1: v = (int)(r*1/3 + g*1/3 + b*1/3 + 0.5), the first maximum is the mode
        const hist = new Int32Array(256);
        const y0 = Math.max(0, H - 12);
        const w3 = 1 / 3;
        for (let y = y0; y < H; y++) for (let x = 0; x < W; x++) { const i = y * W + x; hist[d2i(first.r[i] * w3 + first.g[i] * w3 + first.b[i] * w3 + 0.5)]++; }
        let mode = 0, maxCount = 0;
        for (let i = 0; i < 256; i++) if (hist[i] > maxCount) { maxCount = hist[i]; mode = i; }
        if (mode >= 200) { fg = [0, 0, 0]; bg = [255, 255, 255]; }
      }
      io.reserve(3 * mw * mh);
      const out = [new Uint8Array(mw * mh), new Uint8Array(mw * mh), new Uint8Array(mw * mh)];
      for (let k = 0; k < 3; k++) if (bg[k]) out[k].fill(bg[k]);
      const G = root.IJGeom;
      if (p.scale !== 1.0 && (!G || !G.kernels || !G.kernels.resizeImage)) throw ijError('IJ_MODULE_MISSING', 'package geom');
      let x = 0, y = 0, slice = p.first;
      const total = Math.max(1, Math.floor((p.last - p.first) / p.increment) + 1);
      let done = 0;
      while (slice <= p.last) {
        const tile = slice === 1 ? first : await renderChannelRGB(view.channels[slice - 1], bd, grayMode, io);
        let planes = [tile.r, tile.g, tile.b];
        if (p.scale !== 1.0) {
          // "aSlice.setInterpolationMethod(ImageProcessor.BILINEAR); boolean averageWhenDownSizing = width<200; aSlice = aSlice.resize(width, height, ...)"
          const rr = { x: 0, y: 0, w: W, h: H };
          const res = [];
          for (const pl of planes) res.push(await G.kernels.resizeImage(pl, W, H, 8, rr, width, height, 1, width < 200, async () => { io.check(); await io.tick(done / total, 'op.montage'); }));
          planes = res;
        }
        // montage.insert(aSlice, x, y): the tile clipped to the montage
        for (let k = 0; k < 3; k++) {
          for (let ty = 0; ty < height; ty++) {
            const dy = y + ty;
            if (dy < 0 || dy >= mh) continue;
            const w = Math.min(width, mw - x);
            if (w > 0) out[k].set(planes[k].subarray(ty * width, ty * width + w), dy * mw + x);
          }
        }
        x += width + p.border;
        if (x >= mw) {
          x = 0;
          y += height + p.border;
          if (y >= mh) break;
        }
        slice += p.increment;
        done++;
        io.check();
        await io.tick(done / total, 'op.montage');
      }
      // "if (borderWidth>0) { for (x=width; x<montageWidth; x+=width+borderWidth) { montage.setRoi(x, 0, borderWidth, montageHeight); montage.fill(); }
      //  for (y=height; ...) { montage.setRoi(0, y, montageWidth, borderWidth); montage.fill(); } }" — filled with the foreground colour
      if (p.border > 0) {
        for (let bx = width; bx < mw; bx += width + p.border) {
          for (let yy = 0; yy < mh; yy++) for (let xx = bx; xx < Math.min(mw, bx + p.border); xx++) { const i = yy * mw + xx; out[0][i] = fg[0]; out[1][i] = fg[1]; out[2][i] = fg[2]; }
          io.check();
        }
        for (let by = height; by < mh; by += height + p.border) {
          for (let yy = by; yy < Math.min(mh, by + p.border); yy++) for (let xx = 0; xx < mw; xx++) { const i = yy * mw + xx; out[0][i] = fg[0]; out[1][i] = fg[1]; out[2][i] = fg[2]; }
          io.check();
        }
      }
      // "Calibration cal = imp2.getCalibration(); if (cal.scaled()) { cal.pixelWidth /= scale; cal.pixelHeight /= scale; }"
      let cal = view.calibration ? Object.assign({}, view.calibration) : view.calibration;
      if (cal) {
        const scaled = cal.pixelWidth !== 1 || cal.pixelHeight !== 1 || (typeof cal.unit === 'string' && cal.unit !== 'px' && cal.unit !== 'pixel');
        if (scaled) { cal.pixelWidth /= p.scale; cal.pixelHeight /= p.scale; }
      }
      const defs = [['R', '#ff0000'], ['G', '#00ff00'], ['B', '#0000ff']];
      return [{
        name: 'Montage', width: mw, height: mh, bitDepth: 8, calibration: cal,
        provenance: { montage: { columns: p.columns, rows: p.rows, width, height, border: p.border, first: p.first, last: p.last, increment: p.increment } },
        channels: defs.map((d, k) => ({ name: d[0], color: d[1], data: out[k], display: { min: 0, max: 255, lut: root.IJLuts.forColor(d[1]), invert: false } }))
      }];
    }
  });

  // ════════════════════════════════════════════════════════════════════════════════════════════════
  //  Look-up tables: ij.plugin.LutLoader
  // ════════════════════════════════════════════════════════════════════════════════════════════════

  /**
   * LutLoader.rgb332:  "reds[i] = (byte)(i&0xe0); greens[i] = (byte)((i<<3)&0xe0); blues[i] = (byte)((i<<6)&0xc0);"
   * LutLoader.redGreen: "for (i<128) { reds[i] = (byte)(i*2); greens[i] = 0; blues[i] = 0 } for (i=128..255) { reds[i] = 0; greens[i] = (byte)(i*2); blues[i] = 0 }"
   * (the green half wraps: (byte)(128*2) = 0 ... (byte)(255*2) = 254). Tables are interleaved r, g, b per level.
   */
  function lutRgb332() {
    const t = new Uint8Array(768);
    for (let i = 0; i < 256; i++) { t[i * 3] = i & 0xe0; t[i * 3 + 1] = (i << 3) & 0xe0; t[i * 3 + 2] = (i << 6) & 0xc0; }
    return t;
  }
  function lutRedGreen() {
    const t = new Uint8Array(768);
    for (let i = 0; i < 128; i++) t[i * 3] = (i * 2) & 255;
    for (let i = 128; i < 256; i++) t[i * 3 + 1] = (i * 2) & 255;
    return t;
  }
  const LUT_RGB332 = '3-3-2 RGB', LUT_REDGREEN = 'Red/Green';
  // Registered by name on both sides: a channel's display.lut may then name them (the renderer, the TIFF writer and a restored session read them).
  try { if (root.IJLuts && root.IJLuts.register) { root.IJLuts.register(LUT_RGB332, lutRgb332()); root.IJLuts.register(LUT_REDGREEN, lutRedGreen()); } } catch (e) { /* registered by an earlier load of this file */ }

  /** LutLoader.interpolate: "scale = nColors/256.0; i1 = (int)(i*scale); i2 = i1+1; if (i2==nColors) i2 = nColors-1; fraction = i*scale - i1;
   *  reds[i] = (byte)((1.0-fraction)*(r[i1]&255) + fraction*(r[i2]&255));" */
  function interpolateLut(r, g, b, nColors) {
    const t = new Uint8Array(768);
    const scale = nColors / 256.0;
    for (let i = 0; i < 256; i++) {
      const i1 = d2i(i * scale);
      let i2 = i1 + 1;
      if (i2 === nColors) i2 = nColors - 1;
      const f = i * scale - i1;
      t[i * 3] = d2i((1.0 - f) * r[i1] + f * r[i2]) & 255;
      t[i * 3 + 1] = d2i((1.0 - f) * g[i1] + f * g[i2]) & 255;
      t[i * 3 + 2] = d2i((1.0 - f) * b[i1] + f * b[i2]) & 255;
    }
    return t;
  }

  const planar = (bytes, off, n) => {
    const r = new Uint8Array(256), g = new Uint8Array(256), b = new Uint8Array(256);
    for (let i = 0; i < n; i++) { r[i] = off + i < bytes.length ? bytes[off + i] : 0; g[i] = off + n + i < bytes.length ? bytes[off + n + i] : 0; b[i] = off + 2 * n + i < bytes.length ? bytes[off + 2 * n + i] : 0; }
    return { r, g, b };
  };
  const toInterleaved = (p) => { const t = new Uint8Array(768); for (let i = 0; i < 256; i++) { t[i * 3] = p.r[i]; t[i * 3 + 1] = p.g[i]; t[i * 3 + 2] = p.b[i]; } return t; };

  /**
   * LutLoader.openLut(fi), in its own order:
   *   "if (length>10000) { error(path); return false; }  (anything bigger is no LUT)
   *    if (length>768) size = openBinaryLut(fi, isURL, false);                          // attempt to read NIH Image LUT
   *    if (size==0 && (length==0||length==768||length==970)) size = openBinaryLut(fi, isURL, true);   // otherwise read raw LUT
   *    if (size==0 && length>768) size = openTextLut(fi);
   *    if (size==0) error(path);   return size==256;"
   * NIH Image: a 32-byte header — "id = f.readInt(); if (id!=1229147980) { return 0; }  // 'ICOL'", then short version, short nColors,
   * short start, short end, long, long, int — then nColors reds, nColors greens, nColors blues, "if (nColors<256) interpolate(...)".
   * Raw: 256 reds, 256 greens, 256 blues. Text: TextReader's float image, "if (width<3||width>4||height<256||height>258) return 0;
   * x = width==4?1:0; y = height>256?1:0; crop (x, y, 3, 256)", each value narrowed with (byte).
   * `parse(bytes)` → { table: Uint8Array(768) interleaved, kind: 'nih' | 'raw' | 'text' } or throws IJ_EDIT_LUT_UNKNOWN.
   */
  const f2b = (v) => d2i(v) & 255;
  function parseLut(bytes) {
    const b = bytes instanceof Uint8Array || (ArrayBuffer.isView(bytes) && bytes.constructor.name === 'Uint8Array') ? bytes : new Uint8Array(bytes);
    const length = b.length;
    const unknown = () => ijError('IJ_EDIT_LUT_UNKNOWN', 'not a LUT');
    if (length > 10000) throw unknown();
    if (length > 768) {
      // 'ICOL' = 1229147980
      if (length >= 32 && b[0] === 0x49 && b[1] === 0x43 && b[2] === 0x4f && b[3] === 0x4c) {
        // id (4 bytes), version (short), nColors (short at offset 6), start, end (shorts), two longs, an int: 32 bytes
        const nColors = (b[6] << 8) | b[7];
        const n = nColors & 0x8000 ? nColors - 65536 : nColors;
        if (n >= 1 && n <= 256) {
          const p = planar(b, 32, n);
          return { table: n < 256 ? interpolateLut(p.r, p.g, p.b, n) : toInterleaved(p), kind: 'nih' };
        }
        throw unknown();   // nColors out of 1..256: ImageJ's own array access fails
      }
    }
    if (length === 0 || length === 768 || length === 970) return { table: toInterleaved(planar(b, 0, 256)), kind: 'raw' };
    if (length > 768) {
      const T = root.IJTextIo;
      if (T && typeof T.parseTextImage === 'function') {
        let im = null;
        try { im = T.parseTextImage(b); } catch (e) { im = null; }
        if (im && !(im.width < 3 || im.width > 4 || im.height < 256 || im.height > 258)) {
          const x = im.width === 4 ? 1 : 0, y = im.height > 256 ? 1 : 0;
          const t = new Uint8Array(768);
          for (let i = 0; i < 256; i++) for (let c = 0; c < 3; c++) t[i * 3 + c] = f2b(im.data[(y + i) * im.width + x + c]);
          return { table: t, kind: 'text' };
        }
      }
    }
    throw unknown();
  }
  /** FileSaver.saveAsLut: "pixels[i] = reds[i]; pixels[i+256] = greens[i]; pixels[i+512] = blues[i];" — 768 bytes. */
  function writeLut(table) {
    if (!(ArrayBuffer.isView(table) && table.length === 768)) throw ijError('IJ_BAD_LUT', 'lut size');
    const out = new Uint8Array(768);
    for (let i = 0; i < 256; i++) { out[i] = table[i * 3]; out[i + 256] = table[i * 3 + 1]; out[i + 512] = table[i * 3 + 2]; }
    return out;
  }
  const IJLutFile = { parse: parseLut, write: writeLut };

  /**
   * Image > Color > Invert LUTs: ImageJ runs the macro InvertAllLuts (ij.plugin.SimpleCommands "invert"), which replaces the table of every
   * channel by the table whose colours are the complements of the old ones with the hue turned back by half a turn — an inverted LUT that keeps
   * its colour (Red becomes white → red, Grays inverted grays):
   *   hsv = HSV_from_RGB(255-reds[i], 255-greens[i], 255-blues[i]);  hsv[0] = (hsv[0]+128)%256;  rgb = RGB_from_HSV(hsv[0], hsv[1], hsv[2]);
   *   REDS[i] = round(rgb[0]) ...
   * (the macro's functions are ported below, number for number; every macro number is a double)
   */
  function hsvFromRgb(r, g, b) {
    const v = Math.max(r, Math.max(g, b));
    const c = v - Math.min(r, Math.min(g, b));
    let h = 0;
    if (c > 0) {
      // macro text: "if (v==r) h = 256/6 * (0 + g-b)/c;" — evaluated left to right, ((256/6) * (0+g-b)) / c, NOT 256/6 * (0 + (g-b)/c)
      if (v === r) h = 256 / 6 * (0 + g - b) / c;
      if (v === g) h = 256 / 6 * (2 + (b - r) / c);
      if (v === b) h = 256 / 6 * (4 + (r - g) / c);
    }
    h = (h + 256) % 256;
    let s = 0;
    if (v > 0) s = c / v * 256;
    return [h, s, v];
  }
  function rgbFromHsv(h, s, v) {
    const f = (k) => { const a = (k + h / 256 * 6) % 6; return v - v * s / 256 * Math.max(0, Math.min(a, Math.min(4 - a, 1))); };
    return [f(5), f(3), f(1)];
  }
  function invertLutTable(t) {
    const out = new Uint8Array(768);
    for (let i = 0; i < 256; i++) {
      const hsv = hsvFromRgb(255 - t[i * 3], 255 - t[i * 3 + 1], 255 - t[i * 3 + 2]);
      hsv[0] = (hsv[0] + 128) % 256;
      const rgb = rgbFromHsv(hsv[0], hsv[1], hsv[2]);
      out[i * 3] = Math.floor(rgb[0] + 0.5); out[i * 3 + 1] = Math.floor(rgb[1] + 0.5); out[i * 3 + 2] = Math.floor(rgb[2] + 0.5);
    }
    return out;
  }
  /** The table a channel shows: its look-up table with the inversion applied. */
  function effectiveTable(lut, invert, color) {
    const t = root.IJLuts.get(lut === undefined || lut === null ? (color || '#ffffff') : lut);
    if (!invert) return t;
    const r = new Uint8Array(768);
    for (let i = 0; i < 256; i++) { const j = 255 - i; r[i * 3] = t[j * 3]; r[i * 3 + 1] = t[j * 3 + 1]; r[i * 3 + 2] = t[j * 3 + 2]; }
    return r;
  }

  // ════════════════════════════════════════════════════════════════════════════════════════════════
  //  Small shared pieces: Duplicate's range, window titles, Java number text
  // ════════════════════════════════════════════════════════════════════════════════════════════════

  /**
   * Duplicator.showHSDialog: "String[] range = Tools.split(gd.getNextString(), " -"); double c1 = gd.parseDouble(range[0]); double c2 =
   * range.length==2?gd.parseDouble(range[1]):Double.NaN; firstC = Double.isNaN(c1)?1:(int)c1; lastC = Double.isNaN(c2)?firstC:(int)c2;
   * if (firstC<1) firstC = 1; if (lastC>nChannels) lastC = nChannels; if (firstC>lastC) {firstC=1; lastC=nChannels;}"
   * Tools.split is a StringTokenizer on " -" (no empty tokens): "2-3" → 2, 3;  "2" → 2 and 2;  "1,3" is ONE token that is no number → channel 1 only.
   * Returns { first, last } (1-based).
   */
  function parseChannelRange(text, nChannels) {
    const toks = String(text === undefined || text === null ? '' : text).split(/[ -]+/).filter((s) => s.length);
    const num = (s) => { const t = String(s).trim(); return /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(t) ? Number(t) : NaN; };
    // ImageJ's range[0] throws ArrayIndexOutOfBounds for an empty list (no recovery in the dialog): this port takes channel 1 only
    const c1 = toks.length > 0 ? num(toks[0]) : NaN;
    const c2 = toks.length === 2 ? num(toks[1]) : NaN;
    let first = c1 !== c1 ? 1 : d2i(c1);
    let last = c2 !== c2 ? first : d2i(c2);
    if (first < 1) first = 1;
    if (last > nChannels) last = nChannels;
    if (first > last) { first = 1; last = nChannels; }
    return { first, last };
  }

  /**
   * WindowManager.getUniqueName(imp, name) / makeUniqueName: the extension (a dot at most 5 characters before the end) is set aside; "-N"
   * (one or two digits, no leading 0) is dropped when the title is one this command made (`uniqueProp` = imp.getProp("UniqueName") != null,
   * or no image at all); then "name-1" .. "name-99" until no open image has that title.
   */
  function uniqueName(name, existing, uniqueProp) {
    const taken = new Set(existing);
    let name2 = String(name);
    let extension = '';
    let len = name2.length;
    const lastDot = name2.lastIndexOf('.');
    if (lastDot !== -1 && len - lastDot < 6 && lastDot !== len - 1) { extension = name2.substring(lastDot); name2 = name2.substring(0, lastDot); }
    let lastDash = name2.lastIndexOf('-');
    len = name2.length;
    if (!uniqueProp) lastDash = -1;
    if (lastDash !== -1 && len - lastDash < 4 && lastDash < len - 1 && /[0-9]/.test(name2.charAt(lastDash + 1)) && name2.charAt(lastDash + 1) !== '0') name2 = name2.substring(0, lastDash);
    for (let i = 1; i <= 99; i++) { const n3 = name2 + '-' + i + extension; if (!taken.has(n3)) return n3; }
    return name;
  }
  /** WindowManager.makeUniqueName: the name itself when no image has it. */
  function makeUniqueName(name, existing) { return new Set(existing).has(name) ? uniqueName(name, existing, true) : name; }

  /** Float.toString of a float value (the text Edit > Options > Misc. shows for the divide-by-zero value). */
  function javaFloatToString(v) {
    if (v !== v) return 'NaN';
    if (v === Infinity) return 'Infinity';
    if (v === -Infinity) return '-Infinity';
    if (v === 0) return 1 / v < 0 ? '-0.0' : '0.0';
    const a = Math.abs(Math.fround(v));
    let e = null;
    for (let p = 1; p <= 9; p++) { const s = a.toExponential(p - 1); if (Math.fround(Number(s)) === a) { e = s; break; } }
    if (e === null) e = a.toExponential(8);
    const m = /^(\d)(?:\.(\d+))?e([+-]\d+)$/.exec(e);
    const digits = m[1] + (m[2] || '');
    const exp = Number(m[3]);
    let out;
    if (a >= 1e-3 && a < 1e7) {
      if (exp >= 0) {
        const intPart = digits.length > exp + 1 ? digits.slice(0, exp + 1) : digits + '0'.repeat(exp + 1 - digits.length);
        const frac = digits.length > exp + 1 ? digits.slice(exp + 1) : '0';
        out = intPart + '.' + frac;
      } else out = '0.' + '0'.repeat(-exp - 1) + digits;
    } else out = digits.charAt(0) + '.' + (digits.length > 1 ? digits.slice(1) : '0') + 'E' + exp;
    return (v < 0 ? '-' : '') + out;
  }

  root.IJLutFile = IJLutFile;
  root.IJEdit = {
    PASTE_MODES, NEW_FILLS, LUT_RGB332, LUT_REDGREEN,
    pasteRegion, pasteKernel, drawRoi, makeRaster, ovalMask, linePolygon,
    makeNewImage, addNoise, renderChannelRGB, displayIndexer, channelTable, montageDefaults, montageClamp, montageSize,
    lutRgb332, lutRedGreen, invertLutTable, effectiveTable, parseChannelRange, uniqueName, makeUniqueName, javaFloatToString
  };
})(typeof self !== 'undefined' ? self : globalThis);
