/* ij-cmds-geom.js — menu commands of package P5 (geom): Rotate, Scale, Size, Canvas Size, Translate, Bin,
 * Properties and Set Scale. Runs on the page only, before IJApp.mount; talks to the app through the documented
 * extension API (api.state / dialog / run / overlay / setRoi), never to the engine directly.
 *
 *   transformRotate     Image > Transform > Rotate...     ij.plugin.filter.Rotator   (angle, grid lines, interpolation, enlarge)
 *   transformTranslate  Image > Transform > Translate...  ij.plugin.filter.Translator
 *   transformBin        Image > Transform > Bin...        ij.plugin.Binner
 *   adjustSize          Image > Adjust > Size...          ij.plugin.Resizer
 *   adjustCanvasSize    Image > Adjust > Canvas Size...   ij.plugin.CanvasResizer
 *   imageScale          Image > Scale...                  ij.plugin.Scaler
 *   imageProperties     Image > Properties...             ij.plugin.filter.ImageProperties (the 2-D part)
 *   analyzeSetScale     Analyze > Set Scale...            ij.plugin.filter.ScaleDialog
 *
 * Differences from ImageJ, all on purpose:
 *   - a document has several channels that must stay registered: the geometry operations always run on EVERY channel;
 *   - no "Fill with background color" (Rotate, Scale) and no "Zero fill" box (Canvas Size): there is no background colour in
 *     this view, the new area is always zero (ImageJ's "zero" option and `ip.setBackgroundValue(0)`);
 *   - no stack / hyperstack fields and no "Global" calibration;
 *   - Rotate draws its grid while its dialog is open, ImageJ only while Preview is ticked.
 */
(function () {
  'use strict';
  if (typeof IJApp === 'undefined' || typeof IJApp.extend !== 'function') return;

  const AREA = new Set(['rect', 'oval', 'polygon', 'freehand', 'mask']);
  const GRID_COLOR = '#ffd400';
  const INTERP = ['none', 'bilinear', 'bicubic'];
  const jround = (v) => Math.floor(v + 0.5);                    // Java's Math.round(double)

  const isArea = (roi) => !!roi && (typeof IJRoi !== 'undefined' && typeof IJRoi.isArea === 'function' ? IJRoi.isArea(roi) : AREA.has(roi.type));
  // The rectangle an area selection works on: its integer bounds clipped to the image; null = no area selection.
  function selRect(roi, W, H) {
    if (!isArea(roi)) return null;
    let b;
    try { b = (typeof IJRoi !== 'undefined' && IJRoi.bounds) ? IJRoi.bounds(roi) : { x: roi.x, y: roi.y, w: roi.w, h: roi.h }; } catch (_) { return null; }
    const x0 = Math.max(0, b.x), y0 = Math.max(0, b.y), x1 = Math.min(W, b.x + b.w), y1 = Math.min(H, b.y + b.h);
    if (!(x1 > x0) || !(y1 > y0)) return null;
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }
  const isWhole = (r, W, H) => !r || (r.x === 0 && r.y === 0 && r.w === W && r.h === H);
  const interpOptions = () => INTERP.map((v) => ({ value: v, labelKey: 'dlg.geom.interp.' + v }));

  /* ij.measure.Calibration.scaled() and Tools.getDecimalPlaces / IJ.d2s, as the dialogs of ImageJ use them. */
  function decimalPlaces(n) {
    if (Number.isInteger(n) || n !== n) return 0;
    let s = String(n);
    if (s.indexOf('e') >= 0) return -2;
    if (s.indexOf('.') < 0) return 0;
    s = s.replace(/0+$/, '');
    return Math.min(4, s.length - s.indexOf('.') - 1);
  }
  const d2s = (v, digits) => (digits < 0 ? v.toExponential(Math.min(9, -digits + 1)) : v.toFixed(Math.min(9, digits)));
  const calibrated = (cal) => !!cal && (cal.pixelWidth !== 1 || cal.pixelHeight !== 1 || !(!cal.unit || cal.unit === 'px' || cal.unit === 'pixel' || cal.unit === 'pixels'));
  const unitText = (cal) => (cal && cal.unit && cal.unit !== 'px' && cal.unit !== 'pixels' ? cal.unit : 'pixel');

  // ── Image > Transform > Rotate... ──────────────────────────────────────────────────────────────
  // Rotator.showDialog: slider Angle -90..90 (0.1), Grid lines (0 digits), Interpolation, [Enlarge image only when
  // the selection is the whole image], Preview. `canEnlarge = r==null || (r.x==0&&r.y==0&&r.width==w&&r.height==h)`.
  function gridLines(W, H, n) {
    // Rotator.drawGridLines: xinc = width/lines; xstart = xinc/2 — vertical lines at xstart + xinc*i, horizontal likewise.
    const lines = [];
    const xinc = W / n, yinc = H / n, xs = xinc / 2, ys = yinc / 2;
    for (let i = 0; i < n; i++) { lines.push([xs + xinc * i, 0, xs + xinc * i, H]); lines.push([0, ys + yinc * i, W, ys + yinc * i]); }
    return lines;
  }

  async function rotate(api) {
    const st = api.state();
    const doc = st.doc;
    if (!doc) return;
    const W = doc.width, H = doc.height;
    const rect = selRect(st.roi, W, H);
    const canEnlarge = isWhole(rect, W, H);
    const drawGrid = (n) => { if (n > 0) api.overlay([{ kind: 'grid', lines: gridLines(W, H, n), color: GRID_COLOR }]); else api.clearOverlay(); };
    const fields = [
      { type: 'slider', id: 'angle', labelKey: 'dlg.geom.angle', value: 15, min: -90, max: 90, step: 0.1 },
      { type: 'number', id: 'grid', labelKey: 'dlg.geom.gridLines', value: 1, min: 0, max: 200, integer: true, decimals: 0 },
      { type: 'choice', id: 'interpolation', labelKey: 'dlg.geom.interpolation', value: 'bilinear', options: interpOptions() }
    ];
    if (canEnlarge) fields.push({ type: 'check', id: 'enlarge', labelKey: 'dlg.geom.enlarge', value: false });
    // The dialog is non-modal: the selection (or the image) may change while it is open, so the rectangle is read when used.
    const liveRect = () => { const s = api.state(); return s.doc && s.doc.docId === doc.docId ? selRect(s.roi, W, H) : rect; };
    drawGrid(1);
    let v;
    try {
      v = await api.dialog({
        title: api.tr('cmd.transformRotate'), okLabel: api.tr('dlg.ok'), nonModal: true, fields,
        onChange: (values) => drawGrid(values.grid),
        // With "Enlarge" ticked the preview still shows the rotation inside the current canvas (ImageJ enlarges on OK only).
        preview: { op: 'rotate', channel: 'all', params: (vals) => ({ angle: vals.angle, interpolation: vals.interpolation, rect: liveRect() }) }
      });
    } finally { api.clearOverlay(); }
    if (!v) return;
    const now = api.state();
    if (!now.doc || now.doc.docId !== doc.docId) return;   // another image became active while the dialog was open
    const rectNow = selRect(now.roi, W, H);
    if (canEnlarge && v.enlarge && isWhole(rectNow, W, H)) await api.run('rotateEnlarge', { angle: v.angle, interpolation: v.interpolation }, { docId: doc.docId, noRoi: true, labelKey: 'cmd.transformRotate' });
    else await api.run('rotate', { angle: v.angle, interpolation: v.interpolation, rect: rectNow }, Object.assign({ docId: doc.docId, channel: 'all', labelKey: 'cmd.transformRotate' }, now.roi ? { roi: now.roi } : {}));
  }

  // ── Image > Transform > Translate... ───────────────────────────────────────────────────────────
  // Translator.showDialog: sliders X offset / Y offset -100..100 (0.1), Interpolation (None by default), Preview.
  async function translate(api) {
    const st = api.state();
    if (!st.doc) return;
    const v = await api.dialog({
      title: api.tr('cmd.transformTranslate'), okLabel: api.tr('dlg.ok'), nonModal: true,
      fields: [
        { type: 'slider', id: 'dx', labelKey: 'dlg.geom.xOffset', value: 15, min: -100, max: 100, step: 0.1 },
        { type: 'slider', id: 'dy', labelKey: 'dlg.geom.yOffset', value: 15, min: -100, max: 100, step: 0.1 },
        { type: 'choice', id: 'interpolation', labelKey: 'dlg.geom.interpolation', value: 'none', options: interpOptions() }
      ],
      preview: { op: 'translate', channel: 'all', params: (vals) => ({ dx: vals.dx, dy: vals.dy, interpolation: vals.interpolation }) }
    });
    if (!v) return;
    const now = api.state();
    if (!now.doc || now.doc.docId !== st.doc.docId) return;   // another image became active while the dialog was open
    await api.run('translate', { dx: v.dx, dy: v.dy, interpolation: v.interpolation }, { docId: st.doc.docId, channel: 'all', labelKey: 'cmd.transformTranslate' });
  }

  // ── Image > Transform > Bin... ─────────────────────────────────────────────────────────────────
  // Binner.showDialog: X shrink factor, Y shrink factor (0 digits), Bin Method (Average, Median, Min, Max, Sum).
  async function bin(api) {
    const st = api.state();
    const doc = st.doc;
    if (!doc) return;
    const v = await api.dialog({
      title: api.tr('cmd.transformBin'), okLabel: api.tr('dlg.ok'),
      fields: [
        { type: 'number', id: 'xshrink', labelKey: 'dlg.geom.xShrink', value: 2, min: 1, max: 4096, integer: true, decimals: 0 },
        { type: 'number', id: 'yshrink', labelKey: 'dlg.geom.yShrink', value: 2, min: 1, max: 4096, integer: true, decimals: 0 },
        { type: 'choice', id: 'method', labelKey: 'dlg.geom.binMethod', value: 'average', options: ['average', 'median', 'min', 'max', 'sum'].map((m) => ({ value: m, labelKey: 'dlg.geom.bin.' + m })) },
        { type: 'message', id: 'note', labelKey: 'dlg.geom.binNote' }
      ],
      validate: (vals) => {
        const out = {};
        if (Math.floor(doc.width / vals.xshrink) < 1) out.xshrink = 'err.geomBinTooLarge';
        if (Math.floor(doc.height / vals.yshrink) < 1) out.yshrink = 'err.geomBinTooLarge';
        return Object.keys(out).length ? out : null;
      }
    });
    if (!v) return;
    await api.run('bin', { xshrink: v.xshrink, yshrink: v.yshrink, method: v.method }, { noRoi: true, labelKey: 'cmd.transformBin' });
  }

  // ── Image > Adjust > Size... ───────────────────────────────────────────────────────────────────
  // Resizer.run: Width, Height (pixels), Constrain aspect ratio, Average when downsizing, Interpolation (Bilinear).
  // First values: newWidth = (int)origWidth/2, newHeight = (int)(newWidth*(origHeight/origWidth)) (constrained).
  // textValueChanged / updateFields: with Constrain on, an edit of Width rewrites Height and the reverse
  // (sizeToHeight remembers which was edited last); ticking Constrain rewrites the other from the last edited one.
  async function size(api) {
    const st = api.state();
    const doc = st.doc;
    if (!doc) return;
    const r = selRect(st.roi, doc.width, doc.height) || { x: 0, y: 0, w: doc.width, h: doc.height };
    const ow = r.w, oh = r.h;
    const w0 = Math.max(1, Math.floor(ow / 2));
    const h0 = Math.max(1, Math.trunc(w0 * (oh / ow)));
    let sizeToHeight = false;
    const v = await api.dialog({
      title: api.tr('cmd.adjustSize'), okLabel: api.tr('dlg.ok'),
      fields: [
        { type: 'number', id: 'width', labelKey: 'dlg.geom.widthPx', value: w0, min: 1, max: 100000, integer: true, decimals: 0 },
        { type: 'number', id: 'height', labelKey: 'dlg.geom.heightPx', value: h0, min: 1, max: 100000, integer: true, decimals: 0 },
        { type: 'check', id: 'constrain', labelKey: 'dlg.geom.constrain', value: true },
        { type: 'check', id: 'average', labelKey: 'dlg.geom.average', value: true },
        { type: 'choice', id: 'interpolation', labelKey: 'dlg.geom.interpolation', value: 'bilinear', options: interpOptions() }
      ],
      onChange: (vals, set, changed) => {
        if (!vals.constrain) return;
        if (changed === 'width') sizeToHeight = false;
        else if (changed === 'height') sizeToHeight = true;
        else if (changed !== 'constrain') return;
        if (sizeToHeight) set({ width: Math.max(1, jround(vals.height * (ow / oh))) });
        else set({ height: Math.max(1, jround(vals.width * (oh / ow))) });
      }
    });
    if (!v) return;
    let width = v.width, height = v.height;
    // Resizer: if (!crop && constrain) { if (sizeToHeight) newWidth = round(newHeight*(origWidth/origHeight)); else newHeight = round(newWidth*(origHeight/origWidth)); }
    if (v.constrain) { if (sizeToHeight) width = Math.max(1, jround(height * (ow / oh))); else height = Math.max(1, jround(width * (oh / ow))); }
    await api.run('resize', { width, height, interpolation: v.interpolation, averageWhenDownsizing: !!v.average }, { labelKey: 'cmd.adjustSize' });
  }

  // ── Image > Adjust > Canvas Size... ────────────────────────────────────────────────────────────
  // CanvasResizer.run: Width, Height (pixels), Position (Top-Left … Bottom-Right, Center), [Zero Fill: always on here].
  async function canvasSize(api) {
    const st = api.state();
    const doc = st.doc;
    if (!doc) return;
    const positions = ['topLeft', 'topCenter', 'topRight', 'centerLeft', 'center', 'centerRight', 'bottomLeft', 'bottomCenter', 'bottomRight'];
    const v = await api.dialog({
      title: api.tr('cmd.adjustCanvasSize'), okLabel: api.tr('dlg.ok'),
      fields: [
        { type: 'number', id: 'width', labelKey: 'dlg.geom.widthPx', value: doc.width, min: 1, max: 100000, integer: true, decimals: 0 },
        { type: 'number', id: 'height', labelKey: 'dlg.geom.heightPx', value: doc.height, min: 1, max: 100000, integer: true, decimals: 0 },
        { type: 'choice', id: 'position', labelKey: 'dlg.geom.position', value: 'center', options: positions.map((p) => ({ value: p, labelKey: 'dlg.geom.pos.' + p })) },
        { type: 'message', id: 'note', labelKey: 'dlg.geom.canvasNote' }
      ]
    });
    if (!v) return;
    await api.run('canvasSize', { width: v.width, height: v.height, position: v.position }, { noRoi: true, labelKey: 'cmd.adjustCanvasSize' });
  }

  // ── Image > Scale... ───────────────────────────────────────────────────────────────────────────
  // Scaler.showDialog: X Scale, Y Scale, Width, Height, Interpolation, Average when downsizing, Create new window, Title.
  // textValueChanged: editing X Scale sets Y Scale (aspect kept), Width and Height; editing Y Scale sets Height; editing
  // Width sets Height (aspect kept) and both scales; the scales win at OK: `if (xscale>0 && yscale>0) newWidth = round(r.width*xscale)`.
  function uniqueName(api, name) {
    const base = String(name || 'image').replace(/\.(tif|tiff|png|csv)$/i, '');
    const taken = new Set((api.state().docs || []).map((d) => d.name));
    let n = 1;
    while (taken.has(base + '-' + n)) n++;
    return base + '-' + n;
  }
  async function scale(api) {
    const st = api.state();
    const doc = st.doc;
    if (!doc) return;
    const W = doc.width, H = doc.height;
    const rect = selRect(st.roi, W, H);
    const r = rect || { x: 0, y: 0, w: W, h: H };
    const v = await api.dialog({
      title: api.tr('cmd.imageScale'), okLabel: api.tr('dlg.ok'),
      fields: [
        { type: 'number', id: 'xscale', labelKey: 'dlg.geom.xScale', value: 0.5, min: 0.0001, max: 1000 },
        { type: 'number', id: 'yscale', labelKey: 'dlg.geom.yScale', value: 0.5, min: 0.0001, max: 1000 },
        { type: 'number', id: 'width', labelKey: 'dlg.geom.widthPx', value: Math.max(1, jround(r.w * 0.5)), min: 1, max: 100000, integer: true, decimals: 0 },
        { type: 'number', id: 'height', labelKey: 'dlg.geom.heightPx', value: Math.max(1, jround(r.h * 0.5)), min: 1, max: 100000, integer: true, decimals: 0 },
        { type: 'choice', id: 'interpolation', labelKey: 'dlg.geom.interpolation', value: 'bilinear', options: interpOptions() },
        { type: 'check', id: 'average', labelKey: 'dlg.geom.average', value: true },
        { type: 'check', id: 'newWindow', labelKey: 'dlg.geom.newWindow', value: true },
        { type: 'string', id: 'title', labelKey: 'dlg.geom.title', value: uniqueName(api, doc.name), enabledIf: (vals) => !!vals.newWindow }
      ],
      onChange: (vals, set, changed) => {
        if (changed === 'xscale') set({ yscale: vals.xscale, width: Math.max(1, jround(vals.xscale * r.w)), height: Math.max(1, jround(vals.xscale * r.h)) });
        else if (changed === 'yscale') set({ height: Math.max(1, jround(vals.yscale * r.h)) });
        else if (changed === 'width') {
          const h = Math.max(1, jround(vals.width * r.h / r.w));
          set({ height: h, xscale: vals.width / r.w, yscale: h / r.h });
        } else if (changed === 'height') set({ yscale: vals.height / r.h });
      }
    });
    if (!v) return;
    let width = v.width, height = v.height;
    if (v.xscale > 0 && v.yscale > 0) { width = Math.max(1, jround(r.w * v.xscale)); height = Math.max(1, jround(r.h * v.yscale)); }
    if (v.newWindow) {
      await api.run('scaleNew', { xscale: v.xscale, yscale: v.yscale, interpolation: v.interpolation, averageWhenDownsizing: !!v.average, width, height, name: v.title || uniqueName(api, doc.name) },
        { labelKey: 'cmd.imageScale' });
      return;
    }
    // Scaler.run: `if ((ip.getWidth()>1 && ip.getHeight()>1) || newWindow) ip.setInterpolationMethod(m) else NONE`
    const interpolation = W > 1 && H > 1 ? v.interpolation : 'none';
    const res = await api.run('scaleInPlace', { xscale: v.xscale, yscale: v.yscale, interpolation, rect }, { channel: 'all', labelKey: 'cmd.imageScale' });
    if (res) api.setRoi(null);           // Scaler.scale: imp.deleteRoi()
  }

  // ── Image > Properties... ──────────────────────────────────────────────────────────────────────
  // ImageProperties.showDialog (2-D part): Pixel_width, Pixel_height with the unit of length; an empty unit, "none" or a
  // pixel width of 0 removes the calibration. getNewScale / getUnitsPerCm: typing another known unit converts the sizes.
  const UNITS = [['nm', 1e7], ['µm', 1e4], ['mm', 10], ['cm', 1], ['m', 0.01], ['km', 0.00001], ['inch', 0.3937], ['ft', 0.0328083], ['mi', 0.000006213]];
  function unitIndex(unit) {
    const u = String(unit || '').toLowerCase();
    if (u === 'cm' || u.startsWith('cent')) return 3;
    if (u === 'mm' || u.startsWith('milli')) return 2;
    if (u.startsWith('inch')) return 6;
    if (u.startsWith('µ') || u.startsWith('u') || u.startsWith('micro')) return 1;
    if (u === 'nm' || u.startsWith('nano')) return 0;
    if (u === 'm' || u.startsWith('meter')) return 4;
    if (u === 'km' || u.startsWith('kilo')) return 5;
    if (u === 'ft' || u === 'foot' || u === 'feet') return 7;
    if (u === 'mi' || u.startsWith('mile')) return 8;
    return -1;
  }
  const unitsPerCm = (i) => (i >= 0 ? UNITS[i][1] : 0);
  async function properties(api) {
    const st = api.state();
    const doc = st.doc;
    if (!doc) return;
    const cal = doc.calibration || { pixelWidth: 1, pixelHeight: 1, unit: 'pixel' };
    const pw0 = cal.pixelWidth > 0 ? cal.pixelWidth : 1, ph0 = cal.pixelHeight > 0 ? cal.pixelHeight : 1;
    let oldUnitIndex = unitIndex(unitText(cal)), oldUnitsPerCm = unitsPerCm(oldUnitIndex);
    let calUnit = unitText(cal);
    // textChangedCount==1 && (calPixelHeight!=1.0||calPixelDepth!=1.0) → the height no longer follows the width
    let duplicatePixelWidth = ph0 === 1;
    const v = await api.dialog({
      title: doc.name || api.tr('cmd.imageProperties'), okLabel: api.tr('dlg.ok'),
      fields: [
        { type: 'number', id: 'pixelWidth', labelKey: 'dlg.geom.pixelWidth', value: pw0, min: 0 },
        { type: 'number', id: 'pixelHeight', labelKey: 'dlg.geom.pixelHeight', value: ph0, min: 0 },
        { type: 'string', id: 'unit', labelKey: 'dlg.geom.unit', value: unitText(cal) },
        { type: 'message', id: 'note', labelKey: 'dlg.geom.propertiesNote' }
      ],
      onChange: (vals, set, changed) => {
        const w = vals.pixelWidth, h = vals.pixelHeight;
        if (changed === 'pixelHeight' && h !== w) duplicatePixelWidth = false;
        if (changed === 'pixelWidth' && duplicatePixelWidth) set({ pixelHeight: w });
        if (vals.unit !== calUnit && changed === 'unit') {
          // getNewScale(newUnit, oldScale): newScale = oldScale * (oldUnitsPerCm / newUnitsPerCm)
          const ni = unitIndex(vals.unit);
          if (oldUnitsPerCm !== 0 && ni >= 0 && ni !== oldUnitIndex && w > 0 && h > 0) {
            const f = oldUnitsPerCm / unitsPerCm(ni);
            const nw = 1 / ((1 / w) * f), nh = 1 / ((1 / h) * f);
            set({ pixelWidth: nw, pixelHeight: nh });
            oldUnitIndex = ni; oldUnitsPerCm = unitsPerCm(ni);
          }
          calUnit = vals.unit;
        }
      }
    });
    if (!v) return;
    const unit = String(v.unit).trim();
    const reset = unit === '' || unit.toLowerCase() === 'none' || v.pixelWidth === 0;
    const next = reset ? { pixelWidth: 1, pixelHeight: 1, unit: 'pixel' } : { pixelWidth: v.pixelWidth, pixelHeight: v.pixelHeight > 0 ? v.pixelHeight : v.pixelWidth, unit };
    await applyCalibration(api, doc, next, 'cmd.imageProperties');
  }

  async function applyCalibration(api, doc, next, labelKey) {
    const cal = doc.calibration || { pixelWidth: 1, pixelHeight: 1, unit: 'pixel' };
    const same = cal.pixelWidth === next.pixelWidth && cal.pixelHeight === next.pixelHeight && unitText(cal) === unitText(next);
    if (same) return;
    await api.run('setCalibration', { pixelWidth: next.pixelWidth, pixelHeight: next.pixelHeight, unit: next.unit }, { noRoi: true, labelKey: labelKey || 'cmd.imageProperties' });
  }

  // ── Analyze > Set Scale... ─────────────────────────────────────────────────────────────────────
  // ScaleDialog.run: "Distance in pixels" (the raw length of a straight line, or the larger side of a rectangle), "Known
  // distance", "Pixel aspect ratio", "Unit of length", a live "Scale:" line and a "Click to Remove Scale" button.
  async function setScale(api) {
    const st = api.state();
    const doc = st.doc;
    if (!doc) return;
    const cal = doc.calibration || { pixelWidth: 1, pixelHeight: 1, unit: 'pixel' };
    let measured = 0, known = 0, aspect = 1, unit = 'pixel';
    const roi = st.roi;
    if (roi && roi.type === 'line') measured = Math.hypot(roi.x2 - roi.x1, roi.y2 - roi.y1);
    else if (roi && roi.type === 'rect') measured = Math.max(roi.w, roi.h);
    const length = d2s(measured, 2);
    if (calibrated(cal)) {
      const pw = cal.pixelWidth > 0 ? cal.pixelWidth : 1, ph = cal.pixelHeight > 0 ? cal.pixelHeight : 1;
      if (measured !== 0) known = measured * pw;
      else { measured = 1.0 / pw; known = 1.0; }
      aspect = ph / pw;
      unit = unitText(cal);
    }
    const scaleText = (m, k, u) => {
      const noUnit = u.startsWith('pixel') || u.startsWith('Pixel') || u === '';
      if (m <= 0 || k <= 0 || noUnit) return api.tr('dlg.geom.noScale');
      const s = m / k, digits = decimalPlaces(s);
      return d2s(s, digits) + (s === 1 ? ' pixel/' : ' pixels/') + u;
    };
    // SetScaleDialog.textValueChanged: scaleChanged is set only when the operator edits one of the two distance fields (or Remove).
    let scaleChanged = false;
    const v = await api.dialog({
      title: api.tr('cmd.analyzeSetScale'), okLabel: api.tr('dlg.ok'),
      fields: [
        { type: 'number', id: 'measured', labelKey: 'dlg.geom.distancePx', value: measured, min: 0, decimals: Math.max(0, decimalPlaces(measured)) },
        { type: 'number', id: 'known', labelKey: 'dlg.geom.knownDistance', value: known, min: 0, decimals: 2 },
        { type: 'number', id: 'aspect', labelKey: 'dlg.geom.aspectRatio', value: aspect, min: 0, decimals: aspect === 1 ? 1 : 3 },
        { type: 'string', id: 'unit', labelKey: 'dlg.geom.unitLength', value: unit },
        { type: 'check', id: 'remove', labelKey: 'dlg.geom.removeScale', value: false },
        { type: 'string', id: 'scale', labelKey: 'dlg.geom.scale', value: scaleText(measured, known, unit), enabledIf: () => false }
      ],
      onChange: (vals, set, changed) => {
        let u = vals.unit;
        if (changed === 'measured' || changed === 'known') scaleChanged = true;
        if (changed === 'remove' && vals.remove) {
          scaleChanged = true;
          // SetScaleDialog.actionPerformed (the Click to Remove Scale button)
          set({ measured: parseFloat(length), known: 0, aspect: 1, unit: 'pixel', remove: false });
          set({ scale: api.tr('dlg.geom.noScale') });
          return;
        }
        const noUnit = u.startsWith('pixel') || u.startsWith('Pixel') || u === '';
        if (vals.known > 0 && noUnit && changed === 'known') { u = 'unit'; set({ unit: u }); }
        set({ scale: scaleText(vals.measured, vals.known, u) });
      }
    });
    if (!v) return;
    let u = String(v.unit);
    if (u === 'A') u = 'Å';
    if (v.measured === v.known && u === 'unit') u = 'pixel';
    const noUnit = u.startsWith('pixel') || u.startsWith('Pixel') || u === '';
    let next;
    if (v.measured <= 0 || v.known <= 0 || noUnit) next = { pixelWidth: 1, pixelHeight: 1, unit: 'pixel' };
    else {
      // `if (gd.scaleChanged || IJ.macroRunning()) cal.pixelWidth = known/measured;` — the flag, not a value comparison: the
      // fields show rounded text, so pressing OK on an untouched dialog must keep the stored width.
      const pw0 = cal.pixelWidth > 0 ? cal.pixelWidth : 1;
      const pixelWidth = scaleChanged ? v.known / v.measured : pw0;
      next = { pixelWidth, pixelHeight: v.aspect !== 0 ? pixelWidth * v.aspect : pixelWidth, unit: u };
    }
    await applyCalibration(api, doc, next, 'cmd.analyzeSetScale');
  }

  IJApp.extend({
    pkg: 'geom',
    errors: {
      IJ_GEOM_BIN_TOO_LARGE: 'err.geomBinTooLarge',
      IJ_GEOM_ENLARGE_SELECTION: 'err.geomEnlargeSelection'
    },
    commands: [
      { id: 'adjustSize', menu: ['Image', 'Adjust'], order: 30, separatorBefore: true, long: true, run: size },
      { id: 'adjustCanvasSize', menu: ['Image', 'Adjust'], order: 40, long: true, run: canvasSize },
      { id: 'imageProperties', menu: ['Image'], order: 40, shortcut: 'Ctrl+Shift+P', run: properties },
      { id: 'imageScale', menu: ['Image'], order: 100, shortcut: 'Ctrl+E', long: true, run: scale },
      { id: 'transformRotate', menu: ['Image', 'Transform'], order: 50, separatorBefore: true, long: true, run: rotate },
      { id: 'transformTranslate', menu: ['Image', 'Transform'], order: 60, long: true, run: translate },
      { id: 'transformBin', menu: ['Image', 'Transform'], order: 70, long: true, run: bin },
      { id: 'analyzeSetScale', menu: ['Analyze'], order: 70, run: setScale }
    ]
  });
})();
