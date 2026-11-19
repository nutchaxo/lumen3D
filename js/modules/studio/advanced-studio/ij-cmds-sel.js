/* ij-cmds-sel.js — menu commands of package sel (wave 3): Edit > Selection > Fit Spline, Fit Circle, Fit Rectangle, Interpolate,
 * Properties…, Scale…, Rotate…, Translate…, Make Band…, Straighten…, Line to Area, Area to Line.
 *
 * Page only, runs before IJApp.mount; talks to the app through the documented extension API (ij-app.js header). The geometry is
 * IJSelOps (ij-proc-sel.js, loaded on the page as well); what reads pixels or allocates image-sized buffers (Make Band, the wide
 * Line to Area, Straighten) runs in the worker as the operations `makeBand`, `lineToArea` and `straighten`.
 *
 * Dialogs follow ImageJ's (ij.plugin.Selection / RoiScaler / RoiRotator / Straightener / gui.RoiProperties): Interpolate "Interval:" 1.0
 * pixel + Smooth + "Adjust interval to match"; Scale "X scale factor:" / "Y scale factor:" 1.5 + Centered; Rotate "Angle:" 15 degrees +
 * "Rotate around image center"; Translate "X offset (pixels):" / "Y offset (pixels):"; Make Band "Band Size:" (calibrated units, max 255
 * pixels); Straighten "Title:" + "Line Width:" (20 pixels when the line is one pixel wide); Properties "Name:" + "Width:" (lines).
 * None of them has a Preview: ImageJ does not preview a selection operation. What ImageJ remembers between two calls (the static fields
 * of its plugins) is remembered here for the session.
 *
 * Reference: ImageJ 1.54p (public domain) — ij.plugin.Selection, RoiScaler, RoiRotator, Straightener, ij.gui.RoiProperties.
 *
 * Dialog sources (ImageJ 1.54p, ij/ prefix): plugin/Selection.java Interpolate :274-277 · Make Band :896-897 · translate :1084-1086;
 * plugin/RoiScaler.java :42-45; plugin/RoiRotator.java :44-51; plugin/Straightener.java :34-37; gui/RoiProperties.java :107-129;
 * the Fit Rectangle sentence is Selection.java:978.
 */
(function () {
  'use strict';
  if (typeof IJApp === 'undefined' || typeof IJApp.extend !== 'function') return;

  const idle = (st) => !!st.doc && !st.busy;
  const hasRoi = (st) => idle(st) && !!st.roi;
  const AREA = new Set(['rect', 'oval', 'polygon', 'freehand', 'mask']);
  const LINES = new Set(['line', 'polyline', 'angle']);
  const hasArea = (st) => hasRoi(st) && AREA.has(st.roi.type);
  const hasLine = (st) => hasRoi(st) && LINES.has(st.roi.type);

  // What ImageJ keeps in static fields: Selection.smooth / adjust / bandSize / translateX / translateY, RoiScaler.defaultXScale /
  // defaultYScale, RoiRotator.defaultAngle / rotateAroundImageCenter. (The interval is 1.0 on every call: "gd.addNumericField(
  // "Interval:", 1.0, 1, 4, "pixel")".)
  const MEM = { smooth: false, adjust: false, bandSize: 15, translateX: 0, translateY: 0, xscale: 1.5, yscale: 1.5, angle: 15, aroundCenter: false };

  const needDoc = (api) => { const st = api.state(); return st.doc && st.roi ? st : null; };

  /* A composite (mask) selection is traced and rasterised again by Scale, Rotate and Interpolate: image-sized buffers, so it runs in the
   * worker; polygons and lines are cheap and stay on the page. */
  const heavy = (st) => st.roi.type === 'mask';
  async function transform(api, st, op, params, direct) {
    if (!heavy(st)) return direct();
    return api.compute('selTransform', Object.assign({ op }, params), { roi: st.roi, labelKey: 'op.selTransform' });
  }

  async function applyResult(api, res) {
    if (!res) return;
    if (res.unchanged) { api.toast('res.roiUnchanged'); return; }
    api.setRoi(res.roi);
  }

  /* Edit > Selection > Fit Spline. */
  async function fitSpline(api) {
    const st = needDoc(api);
    if (!st) return;
    await applyResult(api, IJSelOps.fitSpline(st.roi));
  }

  /* Edit > Selection > Fit Circle. */
  async function fitCircle(api) {
    const st = needDoc(api);
    if (!st) return;
    await applyResult(api, IJSelOps.fitCircle(st.roi, st.doc.width, st.doc.height));
  }

  /* Edit > Selection > Fit Rectangle. */
  async function fitRectangle(api) {
    const st = needDoc(api);
    if (!st) return;
    await applyResult(api, IJSelOps.fitRectangle(st.roi));
  }

  /* Edit > Selection > Interpolate: "if (roi.getType()==Roi.POINT) return;" then the dialog. */
  async function interpolate(api) {
    const st = needDoc(api);
    if (!st) return;
    if (st.roi.type === 'point') return;
    const v = await api.dialog({
      title: api.tr('dlg.sel.interpolateTitle'),
      fields: [
        { type: 'number', id: 'interval', labelKey: 'dlg.sel.interval', value: 1.0, min: 0.01, decimals: 1, step: 'any', unitsKey: 'dlg.sel.pixel' },
        { type: 'check', id: 'smooth', labelKey: 'dlg.sel.smooth', value: MEM.smooth },
        { type: 'check', id: 'adjust', labelKey: 'dlg.sel.adjust', value: MEM.adjust }]
    });
    if (!v) return;
    MEM.smooth = !!v.smooth; MEM.adjust = !!v.adjust;
    await applyResult(api, await transform(api, st, 'interpolate', { interval: v.interval, smooth: !!v.smooth, adjust: !!v.adjust }, () => IJSelOps.interpolate(st.roi, v.interval, !!v.smooth, !!v.adjust)));
  }

  /* Edit > Selection > Properties… (RoiProperties): the name and, for a line, its width. "if (!isRange) roi.setName(name.length()>0?
   * name:null)". */
  async function properties(api) {
    const st = needDoc(api);
    if (!st) return;
    const roi = st.roi;
    const isLine = roi.type === 'line' || roi.type === 'polyline';
    const fields = [{ type: 'string', id: 'name', labelKey: 'dlg.sel.name', value: typeof roi.name === 'string' ? roi.name : '' }];
    if (isLine) {
      const w = roi.width === undefined ? 1 : roi.width;
      fields.push({ type: 'number', id: 'width', labelKey: 'dlg.sel.width', value: w, min: 0, decimals: Number.isInteger(w) ? 0 : 1, step: 'any' });
    }
    const v = await api.dialog({
      title: api.tr('dlg.sel.propertiesTitle'), fields,
      validate: (vals) => (typeof vals.name === 'string' && vals.name.length > 255 ? { name: 'dlg.sel.nameLong' } : null)
    });
    if (!v) return;
    const out = Object.assign({}, roi);
    if (roi.rle) out.rle = roi.rle.slice();
    if (v.name.length > 0) out.name = v.name; else delete out.name;
    if (isLine) out.width = v.width;
    api.setRoi(out);
  }

  /* Edit > Selection > Scale…: "X scale factor:", "Y scale factor:", "Centered". */
  async function scale(api) {
    const st = needDoc(api);
    if (!st) return;
    const v = await api.dialog({
      title: api.tr('dlg.sel.scaleTitle'),
      fields: [
        { type: 'number', id: 'xscale', labelKey: 'dlg.sel.xscale', value: MEM.xscale, decimals: 2, step: 'any' },
        { type: 'number', id: 'yscale', labelKey: 'dlg.sel.yscale', value: MEM.yscale, decimals: 2, step: 'any' },
        { type: 'check', id: 'centered', labelKey: 'dlg.sel.centered', value: false }]
    });
    if (!v) return;
    MEM.xscale = v.xscale; MEM.yscale = v.yscale;
    await applyResult(api, await transform(api, st, 'scale', { xscale: v.xscale, yscale: v.yscale, centered: !!v.centered }, () => IJSelOps.scale(st.roi, v.xscale, v.yscale, !!v.centered, st.doc.width, st.doc.height)));
  }

  /* Edit > Selection > Rotate…: "Angle:" (degrees; negative = counter-clockwise), "Rotate around image center". */
  async function rotate(api) {
    const st = needDoc(api);
    if (!st) return;
    const v = await api.dialog({
      title: api.tr('dlg.sel.rotateTitle'),
      fields: [
        { type: 'number', id: 'angle', labelKey: 'dlg.sel.angle', value: MEM.angle, decimals: Number.isInteger(MEM.angle) ? 0 : 2, step: 'any', unitsKey: 'dlg.sel.degrees' },
        { type: 'check', id: 'aroundCenter', labelKey: 'dlg.sel.aroundCenter', value: MEM.aroundCenter },
        { type: 'message', id: 'hint', labelKey: 'dlg.sel.rotateHint' }]
    });
    if (!v) return;
    MEM.angle = v.angle; MEM.aroundCenter = !!v.aroundCenter;
    await applyResult(api, await transform(api, st, 'rotate', { angle: v.angle, aroundCenter: !!v.aroundCenter }, () => IJSelOps.rotate(st.roi, v.angle, !!v.aroundCenter, st.doc.width, st.doc.height)));
  }

  /* Edit > Selection > Translate…: "X offset (pixels):", "Y offset (pixels):". */
  async function translate(api) {
    const st = needDoc(api);
    if (!st) return;
    const v = await api.dialog({
      title: api.tr('dlg.sel.translateTitle'),
      fields: [
        { type: 'number', id: 'dx', labelKey: 'dlg.sel.dx', value: MEM.translateX, decimals: 0, step: 'any' },
        { type: 'number', id: 'dy', labelKey: 'dlg.sel.dy', value: MEM.translateY, decimals: 0, step: 'any' }]
    });
    if (!v) return;
    MEM.translateX = v.dx; MEM.translateY = v.dy;
    await applyResult(api, IJSelOps.translate(st.roi, v.dx, v.dy));
  }

  /* Edit > Selection > Make Band…: "Band Size:" in the calibrated unit ("double size = pixels*cal.pixelWidth; decimalPlaces = 0 unless
   * the size is not an integer"), "int n = (int)Math.round(size/cal.pixelWidth); if (n >255) error". */
  async function makeBand(api) {
    const st = needDoc(api);
    if (!st) return;
    if (!AREA.has(st.roi.type)) { api.error(Object.assign(new Error('area selection required'), { code: 'IJ_SEL_NEEDS_AREA' })); return; }
    const cal = st.doc.calibration || {};
    const pw = cal.pixelWidth > 0 ? cal.pixelWidth : 1;
    const unit = cal.unit && !/^pixels?$/i.test(String(cal.unit)) ? cal.unit : api.tr('dlg.pixels'); // Calibration.getUnits()
    const size0 = Number((MEM.bandSize * pw).toFixed(6));
    const v = await api.dialog({
      title: api.tr('dlg.sel.bandTitle'),
      fields: [{ type: 'number', id: 'size', labelKey: 'dlg.sel.bandSize', value: size0, min: 0, decimals: Number.isInteger(size0) ? 0 : 2, step: 'any', units: unit }],
      validate: (vals) => (Math.round(vals.size / pw) > 255 ? { size: 'err.selBandTooWide' } : null)
    });
    if (!v) return;
    const n = Math.round(v.size / pw);
    if (n > 255) { api.error(Object.assign(new Error('band too wide'), { code: 'IJ_SEL_BAND_TOO_WIDE' })); return; }
    const res = await api.compute('makeBand', { n }, { roi: st.roi, labelKey: 'op.makeBand' });
    if (!res || !res.roi) return;
    MEM.bandSize = n;
    api.setRoi(res.roi);
  }

  /* WindowManager.getUniqueName: a trailing "-1".."-999" is replaced, an extension kept, the first free "-1" … "-99" is taken. */
  function uniqueName(name, taken) {
    let name2 = name, extension = '';
    const lastDot = name2.lastIndexOf('.');
    if (lastDot !== -1 && name2.length - lastDot < 6 && lastDot !== name2.length - 1) { extension = name2.substring(lastDot); name2 = name2.substring(0, lastDot); }
    const lastDash = name2.lastIndexOf('-');
    if (lastDash !== -1 && name2.length - lastDash < 4 && lastDash < name2.length - 1 && /[0-9]/.test(name2.charAt(lastDash + 1)) && name2.charAt(lastDash + 1) !== '0') name2 = name2.substring(0, lastDash);
    for (let i = 1; i <= 99; i++) { const n3 = name2 + '-' + i + extension; if (!taken.has(n3)) return n3; }
    return name;
  }

  /* Edit > Selection > Straighten…: a line, a segmented line, a free line (an angle too: Roi.isLine()). */
  async function straighten(api) {
    const st = needDoc(api);
    if (!st) return;
    const roi = st.roi;
    if (!(roi.type === 'line' || roi.type === 'polyline' || roi.type === 'angle')) { api.error(Object.assign(new Error('line selection required'), { code: 'IJ_SEL_NEEDS_LINE' })); return; }
    // "int width = (int)Math.round(roi.getStrokeWidth()); … if (width<=1) width = 20;"
    let width = Math.round(roi.width === undefined ? 1 : roi.width);
    if (width <= 1) width = 20;
    const taken = new Set(st.docs.map((d) => d.name));
    const v = await api.dialog({
      title: api.tr('dlg.sel.straightenTitle'),
      fields: [
        { type: 'string', id: 'title', labelKey: 'dlg.sel.title', value: uniqueName(st.doc.name, taken) },
        { type: 'number', id: 'width', labelKey: 'dlg.sel.lineWidth', value: width, min: 1, max: 4096, integer: true, decimals: 0, unitsKey: 'dlg.pixels' }],
      validate: (vals) => (typeof vals.title === 'string' && vals.title.length > 255 ? { title: 'dlg.sel.nameLong' } : null)
    });
    if (!v) return;
    await api.run('straighten', { width: v.width, title: v.title }, { roi, labelKey: 'op.straighten' });
  }

  /* Edit > Selection > Line to Area: "Roi roi2 = Roi.convertLineToArea(roi)". A straight line becomes a rotated rectangle at once; a
   * segmented line is painted in the worker. */
  async function lineToArea(api) {
    const st = needDoc(api);
    if (!st) return;
    const roi = st.roi;
    if (!LINES.has(roi.type)) { api.error(Object.assign(new Error('line selection required'), { code: 'IJ_SEL_NEEDS_LINE' })); return; }
    if (roi.type === 'line') { api.setRoi(IJSelOps.lineToArea(roi).roi); return; }
    const res = await api.compute('lineToArea', {}, { roi, labelKey: 'op.lineToArea' });
    if (!res || !res.roi) return;
    api.setRoi(res.roi);
  }

  /* Edit > Selection > Area to Line. */
  async function areaToLine(api) {
    const st = needDoc(api);
    if (!st) return;
    await applyResult(api, IJSelOps.areaToLine(st.roi, st.doc.width, st.doc.height));
  }

  // Edit › Selection, ImageJ's order (IJ_Props.txt selection04…selection26; the rows of ij-cmds-roi.js and the core fill the gaps)
  IJApp.extend({
    pkg: 'sel',
    commands: [
      { id: 'selFitSpline', menu: ['Edit', 'Selection'], order: 40, enabled: (st) => hasRoi(st) && ['polygon', 'freehand', 'polyline'].includes(st.roi.type), run: fitSpline },
      { id: 'selFitCircle', menu: ['Edit', 'Selection'], order: 50, enabled: (st) => hasRoi(st) && st.roi.type !== 'line', run: fitCircle },
      { id: 'selFitRectangle', menu: ['Edit', 'Selection'], order: 70, enabled: (st) => hasRoi(st) && st.roi.type !== 'line', run: fitRectangle },
      { id: 'selInterpolate', menu: ['Edit', 'Selection'], order: 80, enabled: (st) => hasRoi(st) && st.roi.type !== 'point', run: interpolate },
      { id: 'selProperties', menu: ['Edit', 'Selection'], order: 130, separatorBefore: true, shortcut: 'y', keys: ['y'], enabled: hasRoi, run: properties },
      { id: 'selScale', menu: ['Edit', 'Selection'], order: 140, enabled: hasRoi, run: scale },
      { id: 'selRotate', menu: ['Edit', 'Selection'], order: 150, enabled: hasRoi, run: rotate },
      { id: 'selTranslate', menu: ['Edit', 'Selection'], order: 160, enabled: hasRoi, run: translate },
      { id: 'selMakeBand', menu: ['Edit', 'Selection'], order: 180, long: true, enabled: hasArea, run: makeBand },
      { id: 'selStraighten', menu: ['Edit', 'Selection'], order: 200, long: true, enabled: hasLine, run: straighten },
      { id: 'selLineToArea', menu: ['Edit', 'Selection'], order: 220, enabled: hasLine, run: lineToArea },
      { id: 'selAreaToLine', menu: ['Edit', 'Selection'], order: 230, enabled: (st) => hasArea(st) && st.roi.type !== 'mask', run: areaToLine }
    ],
    errors: {
      IJ_SEL_NEEDS_POLY: 'err.selNeedsPoly',
      IJ_SEL_FEW_POINTS: 'err.selFewPoints',
      IJ_SEL_FEW_POINTS_RECT: 'err.selFewPointsRect',
      IJ_SEL_COLLINEAR: 'err.selCollinear',
      IJ_SEL_NEEDS_AREA_OR_POINTS: 'err.selNeedsAreaOrPoints',
      IJ_SEL_NEEDS_AREA: 'err.selNeedsArea',
      IJ_SEL_NEEDS_LINE: 'err.selNeedsLine',
      IJ_SEL_COMPOSITE: 'err.selComposite',
      IJ_SEL_INTERVAL: 'err.selInterval',
      IJ_SEL_NO_BAND: 'err.selNoBand',
      IJ_SEL_BAND_TOO_WIDE: 'err.selBandTooWide'
    }
  });
})();
