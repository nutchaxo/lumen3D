/* ij-cmds-roi.js — menu commands of package P6 (roi): Edit > Selection (Specify, To Bounding Box, Enlarge, Fit Ellipse,
 * Convex Hull, Create Mask, Create Selection).
 *
 * Page only, runs before IJApp.mount; talks to the app through the documented extension API (ij-app.js header). The pure
 * geometry (IJRoiTools, ij-proc-roi.js) is loaded on the page as well; the worker does the work that reads pixels or
 * allocates image-sized buffers (the `enlargeRoi`, `createSelection` and `createMask` operations).
 *
 * The other P6 commands are registered by ij-app.js itself because they read the Results table the extension API does not
 * expose: Analyze > Summarize and Distribution. The Set Measurements dialog, the Wand / Segmented line / Angle tools, the
 * ROI Manager Measure and Multi Measure buttons, Plot Profile along a segmented line live there too (PLAN-wave2 §2.6).
 *
 * Reference: ImageJ 1.54p ij.plugin.Selection, SpecifyROI, RoiEnlarger (public domain).
 */
(function () {
  'use strict';
  if (typeof IJApp === 'undefined' || typeof IJApp.extend !== 'function') return;

  const AREA = new Set(['rect', 'oval', 'polygon', 'freehand', 'mask']);
  const isArea = (roi) => !!roi && AREA.has(roi.type);
  const idle = (st) => !!st.doc && !st.busy;
  const hasArea = (st) => idle(st) && isArea(st.roi);
  const hasRoi = (st) => idle(st) && !!st.roi;

  // What ImageJ keeps between two calls of a dialog (static fields of SpecifyROI / RoiEnlarger).
  const SPEC = { oval: false, square: false, centered: false, scaled: false };
  const ENLARGE = { distance: 15, usePixels: false };

  function calOf(doc) {
    const c = (doc && doc.calibration) || {};
    const pw = c.pixelWidth > 0 ? c.pixelWidth : 1, ph = c.pixelHeight > 0 ? c.pixelHeight : 1;
    return { pw, ph, unit: c.unit || '', scaled: !!c.unit && (pw !== 1 || ph !== 1) };
  }

  /* Edit > Selection > Specify (SpecifyROI): width, height, the position of the top-left corner (or of the centre),
   * Oval, Constrain square/circle, Centered, Scaled units. The selection follows the dialog while it is open and is put
   * back when it is cancelled. "width = imp.getWidth()/2; height = imp.getHeight()/2; xRoi = width/2; yRoi = height/2"
   * when there is no selection. */
  async function specify(api) {
    const st = api.state();
    const doc = st.doc;
    if (!doc) return;
    const cal = calOf(doc);
    const roi0 = st.roi || null;
    let width, height, x, y, oval = SPEC.oval;
    if (roi0 && typeof IJRoi !== 'undefined') {
      oval = roi0.type === 'oval';
      const b = IJRoi.bounds(roi0);
      width = b.w; height = b.h; x = b.x; y = b.y;
      if (SPEC.scaled && cal.scaled) { x *= cal.pw; y *= cal.ph; width *= cal.pw; height *= cal.ph; }
      if (SPEC.centered) { x += width / 2.0; y += height / 2.0; }
    } else {
      width = Math.floor(doc.width / 2); height = Math.floor(doc.height / 2);
      x = width / 2; y = height / 2;
    }
    const roiOf = (v) => {
      let xp = v.x, yp = v.y, wp = v.width, hp = v.height;
      if (v.centered) { xp -= wp / 2; yp -= hp / 2; }
      if (cal.scaled && v.scaled) { xp /= cal.pw; yp /= cal.ph; wp /= cal.pw; hp /= cal.ph; }
      return { type: v.oval ? 'oval' : 'rect', x: xp, y: yp, w: wp, h: hp };
    };
    const first = { width, height, x, y, oval, square: SPEC.square, centered: SPEC.centered, scaled: SPEC.scaled && cal.scaled };
    const docId = doc.docId;
    if (!roi0) api.setRoi(roiOf(first), { docId });
    const fields = [
      { type: 'number', id: 'width', labelKey: 'dlg.roi.specWidth', value: width, min: 0, step: 'any' },
      { type: 'number', id: 'height', labelKey: 'dlg.roi.specHeight', value: height, min: 0, step: 'any' },
      { type: 'number', id: 'x', labelKey: 'dlg.roi.specX', value: x, step: 'any' },
      { type: 'number', id: 'y', labelKey: 'dlg.roi.specY', value: y, step: 'any' },
      { type: 'check', id: 'oval', labelKey: 'dlg.roi.specOval', value: oval },
      { type: 'check', id: 'square', labelKey: 'dlg.roi.specSquare', value: SPEC.square },
      { type: 'check', id: 'centered', labelKey: 'dlg.roi.specCentered', value: SPEC.centered }];
    if (cal.scaled) fields.push({ type: 'check', id: 'scaled', label: api.tr('dlg.roi.specScaled', { unit: cal.unit }), value: first.scaled });
    const v = await api.dialog({
      title: api.tr('cmd.selSpecify'), fields, nonModal: true,
      validate: (vals) => {
        const out = {};
        if (!(vals.width > 0)) out.width = 'dlg.roi.specSize';
        if (!(vals.height > 0)) out.height = 'dlg.roi.specSize';
        return Object.keys(out).length ? out : null;
      },
      onChange: (vals, set, changedId) => {
        const cur = Object.assign({ scaled: false }, vals);
        // SpecifyROI.dialogItemChanged: "Constrain square/circle" makes width = height; "Centered" keeps the roi where it is
        if (changedId === 'square' && cur.square) { const m = 0.5 * (cur.width + cur.height); cur.width = m; cur.height = m; set({ width: m, height: m }); }
        if (cur.square && cur.width !== cur.height) {
          if (changedId === 'width') { cur.height = cur.width; set({ height: cur.width }); } else if (changedId === 'height') { cur.width = cur.height; set({ width: cur.height }); }
        }
        if (changedId === 'centered') {
          const shift = cur.centered ? 0.5 : -0.5;
          cur.x += shift * cur.width; cur.y += shift * cur.height; set({ x: cur.x, y: cur.y });
        }
        if (changedId === 'scaled' && cal.scaled) {
          const fx = cur.scaled ? cal.pw : 1 / cal.pw, fy = cur.scaled ? cal.ph : 1 / cal.ph;
          cur.width *= fx; cur.height *= fy; cur.x *= fx; cur.y *= fy;
          set({ width: cur.width, height: cur.height, x: cur.x, y: cur.y });
        }
        if (cur.width > 0 && cur.height > 0) api.setRoi(roiOf(cur), { docId });
      }
    });
    if (!v) { api.setRoi(roi0, { docId }); return; }
    SPEC.oval = !!v.oval; SPEC.square = !!v.square; SPEC.centered = !!v.centered; SPEC.scaled = cal.scaled ? !!v.scaled : SPEC.scaled;
    api.setRoi(roiOf(Object.assign({ scaled: false }, v)), { docId });
  }

  /* Selection.toBoundingBox: "Rectangle r = roi.getBounds(); ... new Roi(r.x, r.y, r.width, r.height)". */
  function toBoundingBox(api) {
    const st = api.state();
    if (!st.doc || !st.roi) return;
    const b = IJRoiTools.roiBounds(st.roi);
    api.setRoi({ type: 'rect', x: b.x, y: b.y, w: b.w, h: b.h });
  }

  /* Edit > Selection > Enlarge (RoiEnlarger.run): the distance in the image's unit unless "Pixel units"; negative shrinks;
   * "pixels = usePixels ? n : n/pixelWidth". The worker computes it (EDM of the padded mask). */
  async function enlarge(api) {
    const st = api.state();
    const doc = st.doc;
    if (!doc || !isArea(st.roi)) return;
    const cal = calOf(doc);
    const usePixels = !cal.scaled || ENLARGE.usePixels;
    let shown = ENLARGE.distance;
    if (cal.scaled && !usePixels) shown = ENLARGE.distance * cal.pw;
    const fields = [{ type: 'number', id: 'n', labelKey: 'dlg.roi.enlargeBy', value: Number(shown.toFixed(6)), step: 'any', units: cal.scaled && !usePixels ? cal.unit : api.tr('dlg.pixels') }];
    if (cal.scaled) fields.push({ type: 'check', id: 'pixels', labelKey: 'dlg.roi.enlargePixels', value: usePixels });
    fields.push({ type: 'message', id: 'hint', value: api.tr('dlg.roi.enlargeHint') });
    if (cal.scaled && cal.pw !== cal.ph) fields.push({ type: 'message', id: 'warn', value: api.tr('dlg.roi.enlargeWarn') });
    const v = await api.dialog({
      title: api.tr('cmd.selEnlarge'), fields,
      onChange: (vals, set, changedId) => {
        // the Pixel units box converts the number on screen, as RoiEnlarger.dialogItemChanged does
        if (changedId === 'pixels' && cal.scaled) set({ n: Number((vals.pixels ? vals.n / cal.pw : vals.n * cal.pw).toFixed(6)) });
      }
    });
    if (!v) return;
    const pixelUnits = cal.scaled ? !!v.pixels : true;
    const pixels = pixelUnits ? v.n : v.n / cal.pw;
    ENLARGE.distance = pixels; ENLARGE.usePixels = pixelUnits;
    const res = await api.compute('enlargeRoi', { n: pixels }, { roi: st.roi, labelKey: 'op.enlargeRoi' });
    if (!res || !res.roi) return;
    if (res.unchanged) { api.toast('res.roiUnchanged'); return; }
    api.setRoi(res.roi);
  }

  /* Edit > Selection > Fit Ellipse (Selection.createEllipse): the ellipse of the same second moments and area as the
   * selection, as an EllipseRoi of 72 vertices: "dx = stats.major*Math.cos(angle)/2; … new EllipseRoi(x1, y1, x2, y2,
   * stats.minor/stats.major)". Pixel units (the statistics are taken without a calibration). */
  async function fitEllipse(api) {
    const st = api.state();
    if (!st.doc || !isArea(st.roi)) return;
    const res = await api.compute('fitEllipse', {}, { roi: st.roi, labelKey: 'op.fitEllipse' });
    if (!res || !res.roi) return;
    api.setRoi(res.roi);
  }

  /* Edit > Selection > Convex Hull: "FloatPolygon p = roi.getFloatConvexHull(); … new PolygonRoi(p, Roi.POLYGON)". The worker
   * traces and wraps the vertices (millions on a large mask). */
  async function convexHull(api) {
    const st = api.state();
    if (!st.doc || !st.roi) return;
    const res = await api.compute('convexHull', {}, { roi: st.roi, labelKey: 'op.convexHull' });
    if (res === null || res === undefined) return;
    if (!res.roi) { api.toast('res.roiUnchanged'); return; }
    api.setRoi(res.roi);
  }

  /* The range the Threshold window holds for this image and channel, else null. */
  function thresholdOf(st) {
    const t = st.threshold;
    return t && st.doc && t.docId === st.doc.docId && t.channel === st.activeChannel ? t : null;
  }

  /* Edit > Selection > Create Mask (Selection.createMask): 255 inside an area selection ("imp.createRoiMask()"); without
   * one — or with the whole image selected on a thresholded image — 255 inside the threshold ("imp.createThresholdMask()"). */
  async function createMask(api) {
    const st = api.state();
    const doc = st.doc;
    if (!doc) return;
    const t = thresholdOf(st);
    const whole = isArea(st.roi) && st.roi.type === 'rect' && st.roi.x === 0 && st.roi.y === 0 && st.roi.w === doc.width && st.roi.h === doc.height;
    if ((!isArea(st.roi) || whole) && t) {
      await api.run('createMask', { source: 'threshold', lower: t.lower, upper: t.upper }, { channel: st.activeChannel, roi: null, labelKey: 'op.createMask' });
      return;
    }
    if (!isArea(st.roi)) { api.error(Object.assign(new Error('needs a selection or a threshold'), { code: 'IJ_ROI_NEEDS_THRESHOLD' })); return; }
    await api.run('createMask', { source: 'roi' }, { roi: st.roi, labelKey: 'op.createMask' });
  }

  /* Edit > Selection > Create Selection (Selection.createSelectionFromMask): the thresholded pixels when a range is set,
   * else the foreground of a binary mask; the worker traces them (ThresholdToSelection) into a selection. */
  async function createSelection(api) {
    const st = api.state();
    if (!st.doc) return;
    const t = thresholdOf(st);
    const res = await api.compute('createSelection', t ? { lower: t.lower, upper: t.upper } : { binary: true }, { channel: st.activeChannel, roi: null, labelKey: 'op.createSelection' });
    if (res === null || res === undefined) return;
    if (!res.roi) { api.toast('res.roiNone'); return; }
    api.setRoi(res.roi);
  }

  IJApp.extend({
    pkg: 'roi',
    commands: [
      { id: 'selSpecify', menu: ['Edit', 'Selection'], order: 190, enabled: idle, run: specify },
      { id: 'selToBoundingBox', menu: ['Edit', 'Selection'], order: 210, enabled: (st) => hasRoi(st) && typeof IJRoiTools !== 'undefined', run: toBoundingBox },
      { id: 'selEnlarge', menu: ['Edit', 'Selection'], order: 170, enabled: hasArea, run: enlarge },
      { id: 'selFitEllipse', menu: ['Edit', 'Selection'], order: 60, enabled: hasArea, run: fitEllipse },
      { id: 'selConvexHull', menu: ['Edit', 'Selection'], order: 90, enabled: (st) => hasRoi(st) && st.roi.type !== 'line' && st.roi.type !== 'angle', run: convexHull },
      { id: 'selCreateMask', menu: ['Edit', 'Selection'], order: 120, long: true, enabled: idle, run: createMask },
      { id: 'selCreateSelection', menu: ['Edit', 'Selection'], order: 110, long: true, enabled: idle, run: createSelection }
    ],
    errors: {
      IJ_ROI_REDIRECT_SIZE: 'err.roiRedirectSize',
      IJ_ROI_NOT_MASK: 'err.roiNotMask',
      IJ_ROI_NEEDS_THRESHOLD: 'err.roiNeedsThreshold'
    }
  });
})();
