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
        // Binner.showDialog: "Z shrink factor" for a stack
        ...((doc.nZ || 1) > 1 ? [{ type: 'number', id: 'zshrink', labelKey: 'dlg.geom.zShrink', value: 1, min: 1, max: 4096, integer: true, decimals: 0 }] : []),
        { type: 'choice', id: 'method', labelKey: 'dlg.geom.binMethod', value: 'average', options: ['average', 'median', 'min', 'max', 'sum'].map((m) => ({ value: m, labelKey: 'dlg.geom.bin.' + m })) },
        { type: 'message', id: 'note', labelKey: 'dlg.geom.binNote' }
      ],
      validate: (vals) => {
        const out = {};
        if (Math.floor(doc.width / vals.xshrink) < 1) out.xshrink = 'err.geomBinTooLarge';
        if (Math.floor(doc.height / vals.yshrink) < 1) out.yshrink = 'err.geomBinTooLarge';
        if ((doc.nZ || 1) > 1 && Math.floor(doc.nZ / vals.zshrink) < 1) out.zshrink = 'err.geomBinTooLarge';
        return Object.keys(out).length ? out : null;
      }
    });
    if (!v) return;
    await api.run('bin', Object.assign({ xshrink: v.xshrink, yshrink: v.yshrink, method: v.method }, (doc.nZ || 1) > 1 ? { zshrink: v.zshrink } : {}), { noRoi: true, labelKey: 'cmd.transformBin' });
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
    // Resizer.run, a stack: "Depth (images):" (a hyperstack: "Depth (slices):" and "Time (frames):"), left as it is = no z scaling. A stack of frames only
    // (no slices) is scaled along t.
    const nZ = doc.nZ || 1, nT = doc.nT || 1, nSl = doc.nSlices || 1;
    const dimAware = !!doc.hyperstack || (doc.nC || 1) > 1;
    const depthFields = [];
    if (nSl > 1) {
      if (dimAware) {
        if (nZ > 1) depthFields.push({ type: 'number', id: 'depth', labelKey: 'dlg.geom.depthSlices', value: nZ, min: 1, max: 100000, integer: true, decimals: 0 });
        if (nT > 1) depthFields.push({ type: 'number', id: 'time', labelKey: 'dlg.geom.timeFrames', value: nT, min: 1, max: 100000, integer: true, decimals: 0 });
      } else if (nZ > 1) depthFields.push({ type: 'number', id: 'depth', labelKey: 'dlg.geom.depthImages', value: nZ, min: 1, max: 100000, integer: true, decimals: 0 });
      else depthFields.push({ type: 'number', id: 'time', labelKey: 'dlg.geom.depthImages', value: nT, min: 1, max: 100000, integer: true, decimals: 0 });
    }
    const v = await api.dialog({
      title: api.tr('cmd.adjustSize'), okLabel: api.tr('dlg.ok'),
      fields: [
        { type: 'number', id: 'width', labelKey: 'dlg.geom.widthPx', value: w0, min: 1, max: 100000, integer: true, decimals: 0 },
        { type: 'number', id: 'height', labelKey: 'dlg.geom.heightPx', value: h0, min: 1, max: 100000, integer: true, decimals: 0 },
        ...depthFields,
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
    // Resizer: the stack is resized in X and Y in place, a new Depth / Time opens the z-scaled stack as a NEW image (Resizer.zScale on the resized one)
    const newDepth = v.depth !== undefined ? v.depth : nZ, newTime = v.time !== undefined ? v.time : nT;
    const zChange = newDepth !== nZ || newTime !== nT;
    const xyChange = !(width === doc.width && height === doc.height && isWhole(r, doc.width, doc.height) && !isArea(st.roi));
    if (xyChange || !zChange) await api.run('resize', { width, height, interpolation: v.interpolation, averageWhenDownsizing: !!v.average }, { labelKey: 'cmd.adjustSize' });
    if (zChange) {
      const now = api.state();
      if (now.doc && now.doc.docId === doc.docId) {
        await api.run('resizeDepth', Object.assign({ interpolation: v.interpolation, averageWhenDownsizing: !!v.average }, newDepth !== nZ ? { depth: newDepth } : {}, newTime !== nT ? { time: newTime } : {}),
          { docId: doc.docId, noRoi: true, labelKey: 'cmd.adjustSize' });
      }
    }
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
  // Tools.parseDouble(s, dflt): Double.parseDouble or the default ("-", "", text)
  function parseDoubleOr(s, dflt) {
    const MO = typeof IJMacroOptions !== 'undefined' ? IJMacroOptions : null;
    const t = String(s === undefined || s === null ? '' : s);
    if (MO && typeof MO.javaDouble === 'function') { const n = MO.javaDouble(t); return n === null || Number.isNaN(n) ? dflt : n; }
    const n = t.trim() === '' ? NaN : Number(t.trim());
    return Number.isNaN(n) ? dflt : n;
  }
  async function scale(api, o) {
    const st = api.state();
    const doc = st.doc;
    if (!doc) return;
    const W = doc.width, H = doc.height;
    const rect = selRect(st.roi, W, H);
    const r = rect || { x: 0, y: 0, w: W, h: H };
    // Scaler.showDialog on a stack: "Z Scale", "Depth (images)" (z only: the slices of a stack, a z-scaled stack is a new window) and "Process entire stack"
    const nZ = doc.nZ || 1, nSl = doc.nSlices || 1, stackish = nSl > 1;
    // A macro answers Scaler's own string fields ("-" or 0 = "follow the other fields"); its options are rewritten as Scaler.showDialog does
    // (the run() table's `rewrite`): interpolate → Bilinear, no interpolation= → None, width= and height= → x=- y=- unless given.
    const mac = !!(o && o.source === 'macro');
    const w0 = Math.max(1, jround(r.w * 0.5)), h0 = Math.max(1, jround(r.h * 0.5));
    const scaleField = (id, labelKey, value) => (mac ? { type: 'string', id, labelKey, value: String(value) } : { type: 'number', id, labelKey, value, min: 0.0001, max: 1000 });
    const sizeField = (id, labelKey, value) => (mac ? { type: 'string', id, labelKey, value: String(value) }
      : { type: 'number', id, labelKey, value, min: 1, max: 100000, integer: true, decimals: 0 });
    const v = await api.dialog({
      title: api.tr('cmd.imageScale'), okLabel: api.tr('dlg.ok'),
      fields: [
        scaleField('xscale', 'dlg.geom.xScale', mac ? '0.5' : 0.5),
        scaleField('yscale', 'dlg.geom.yScale', mac ? '0.5' : 0.5),
        ...(nZ > 1 ? [scaleField('zscale', 'dlg.geom.zScale', mac ? '1.0' : 1)] : []),
        sizeField('width', 'dlg.geom.widthPx', w0),
        sizeField('height', 'dlg.geom.heightPx', h0),
        ...(nZ > 1 ? [sizeField('depth', 'dlg.geom.depthImages', nZ)] : []),
        { type: 'choice', id: 'interpolation', labelKey: 'dlg.geom.interpolation', value: 'bilinear', options: interpOptions() },
        { type: 'check', id: 'average', labelKey: 'dlg.geom.average', value: true },
        ...(stackish ? [{ type: 'check', id: 'process', labelKey: 'dlg.geom.processStack', value: true }] : []),
        { type: 'check', id: 'newWindow', labelKey: 'dlg.geom.newWindow', value: true },
        { type: 'string', id: 'title', labelKey: 'dlg.geom.title', value: uniqueName(api, doc.name), enabledIf: (vals) => !!vals.newWindow }
      ],
      onChange: (vals, set, changed) => {
        if (mac) return;
        if (changed === 'xscale') set({ yscale: vals.xscale, width: Math.max(1, jround(vals.xscale * r.w)), height: Math.max(1, jround(vals.xscale * r.h)) });
        else if (changed === 'yscale') set({ height: Math.max(1, jround(vals.yscale * r.h)) });
        else if (changed === 'width') {
          const h = Math.max(1, jround(vals.width * r.h / r.w));
          set({ height: h, xscale: vals.width / r.w, yscale: h / r.h });
        } else if (changed === 'height') set({ yscale: vals.height / r.h });
        else if (changed === 'zscale') set({ depth: Math.max(1, jround(vals.zscale * nZ)) });
        else if (changed === 'depth') set({ zscale: vals.depth / nZ });
      }
    });
    if (!v) return;
    if (mac) {
      // Scaler.showDialog after gd.showDialog(), on the string fields
      const xs = parseDoubleOr(v.xscale, 0), ys = parseDoubleOr(v.yscale, 0);
      const wstr = String(v.width);
      let nw = jround(parseDoubleOr(wstr, 0)), nh = jround(parseDoubleOr(v.height, 0));
      if (nh !== 0 && (wstr === '-' || wstr === '0')) nw = jround(nh * r.w / r.h);
      else if (nw !== 0 && nh === 0) nh = jround(nw * r.h / r.w);
      else if (nh !== 0 && nw === 0) nw = jround(nh * r.w / r.h);
      if (nw === 0 || nh === 0) throw Object.assign(new Error('Width or height is 0'), { code: 'IJ_MACRO_OPTIONS', macroText: 'Width or height is 0' });
      if (xs > 0 && ys > 0) { nw = jround(r.w * xs); nh = jround(r.h * ys); }
      v.width = nw; v.height = nh;
      v.xscale = xs > 0 ? xs : nw / r.w;
      v.yscale = xs > 0 ? ys : nh / r.h;
      if (nZ > 1) {
        const zs = parseDoubleOr(v.zscale, 0);
        v.zscale = zs > 0 ? zs : 0;
        v.depth = Math.max(1, jround(parseDoubleOr(v.depth, nZ)));
      }
    }
    let width = v.width, height = v.height;
    if (v.xscale > 0 && v.yscale > 0) { width = Math.max(1, jround(r.w * v.xscale)); height = Math.max(1, jround(r.h * v.yscale)); }
    // "Process entire stack" ticked (the default): every slice, else the one on screen; the depth is scaled only with the whole stack in a new window
    const process = stackish && v.process !== false;
    if (v.newWindow) {
      const params = { xscale: v.xscale, yscale: v.yscale, interpolation: v.interpolation, averageWhenDownsizing: !!v.average, width, height, name: v.title || uniqueName(api, doc.name) };
      if (stackish) {
        params.stack = process;
        const depth = nZ > 1 ? (v.zscale > 0 ? Math.max(1, jround(nZ * v.zscale)) : v.depth) : nZ;
        if (process && depth !== nZ) params.depth = depth;
      }
      await api.run('scaleNew', params, { labelKey: 'cmd.imageScale' });
      return;
    }
    // Scaler.run: `if ((ip.getWidth()>1 && ip.getHeight()>1) || newWindow) ip.setInterpolationMethod(m) else NONE`
    const interpolation = W > 1 && H > 1 ? v.interpolation : 'none';
    const res = await api.run('scaleInPlace', { xscale: v.xscale, yscale: v.yscale, interpolation, rect }, Object.assign({ channel: 'all', labelKey: 'cmd.imageScale' }, stackish ? { planes: process ? 'all' : 'current' } : {}));
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
  // ImageProperties.validateInterval: "3sec" → "3 sec"
  function validateInterval(text) {
    const s = String(text);
    if (s.indexOf(' ') !== -1) return s;
    let first = -1;
    for (let i = 0; i < s.length; i++) if (/\p{L}/u.test(s.charAt(i))) { first = i; break; }
    return first > 0 && first < s.length - 1 ? s.slice(0, first) + ' ' + s.slice(first) : s;
  }
  async function properties(api) {
    const st = api.state();
    const doc = st.doc;
    if (!doc) return;
    const cal = doc.calibration || { pixelWidth: 1, pixelHeight: 1, unit: 'pixel' };
    const pw0 = cal.pixelWidth > 0 ? cal.pixelWidth : 1, ph0 = cal.pixelHeight > 0 ? cal.pixelHeight : 1;
    const pd0 = cal.pixelDepth > 0 ? cal.pixelDepth : 1;
    const d = typeof api.dims === 'function' ? api.dims(doc.docId) : { nC: 1, nZ: 1, nT: 1, nSlices: 1, hyperstack: false };
    const nC = d.nC || 1, nZ = d.nZ || 1, nT = d.nT || 1, stackSize = d.nSlices || nC * nZ * nT;
    // ImageJ counts a plain stack as slices (channels = frames = 1)
    const hyper = !!d.hyperstack || nC > 1 || nT > 1;
    const c0 = hyper ? nC : 1, z0 = hyper ? nZ : stackSize, t0 = hyper ? nT : 1;
    const fi0 = cal.frameInterval > 0 ? cal.frameInterval : 0;
    const interval0 = (Math.trunc(fi0) === fi0 ? String(fi0) : d2s(fi0, 2)) + ' ' + (cal.timeUnit || 'sec');
    let oldUnitIndex = unitIndex(unitText(cal)), oldUnitsPerCm = unitsPerCm(oldUnitIndex);
    let calUnit = unitText(cal);
    // textChangedCount==1 && (calPixelHeight!=1.0||calPixelDepth!=1.0) → the height no longer follows the width
    let duplicatePixelWidth = ph0 === 1;
    const v = await api.dialog({
      title: doc.name || api.tr('cmd.imageProperties'), okLabel: api.tr('dlg.ok'),
      fields: [
        { type: 'number', id: 'channels', labelKey: 'dlg.stk.nChannels', value: c0, integer: true, decimals: 0 },
        { type: 'number', id: 'slices', labelKey: 'dlg.stk.nSlices', value: z0, integer: true, decimals: 0 },
        { type: 'number', id: 'frames', labelKey: 'dlg.stk.nFrames', value: t0, integer: true, decimals: 0 },
        { type: 'number', id: 'pixelWidth', labelKey: 'dlg.geom.pixelWidth', value: pw0, min: 0 },
        { type: 'number', id: 'pixelHeight', labelKey: 'dlg.geom.pixelHeight', value: ph0, min: 0 },
        { type: 'string', id: 'unit', labelKey: 'dlg.geom.unit', value: unitText(cal) },
        { type: 'number', id: 'pixelDepth', labelKey: 'dlg.geom.voxelDepth', value: pd0, min: 0 },
        { type: 'string', id: 'frameInterval', labelKey: 'dlg.geom.frameInterval', value: interval0 },
        { type: 'message', id: 'note', labelKey: 'dlg.geom.propertiesNote' }
      ],
      // "The product of channels (c), slices (z) and frames (t) must equal the stack size"
      validate: (x) => (Math.max(1, Math.trunc(x.channels)) * Math.max(1, Math.trunc(x.slices)) * Math.max(1, Math.trunc(x.frames)) !== stackSize
        ? { channels: 'err.stkBadDimensions' } : null),
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
    // imp.setDimensions(channels, slices, frames)
    const c1 = Math.max(1, Math.trunc(v.channels)), z1 = Math.max(1, Math.trunc(v.slices)), t1 = Math.max(1, Math.trunc(v.frames));
    if ((c1 !== c0 || z1 !== z0 || t1 !== t0) && c1 * z1 * t1 === stackSize) {
      const res = await api.run('stkToHyperstack', { order: 'xyczt', channels: c1, slices: z1, frames: t1, mode: c1 > 1 ? 'composite' : 'color' },
        { docId: doc.docId, noRoi: true, labelKey: 'cmd.imageProperties' });
      if (!res) return;
    }
    const unit = String(v.unit).trim();
    const reset = unit === '' || unit.toLowerCase() === 'none' || v.pixelWidth === 0;
    const next = reset ? { pixelWidth: 1, pixelHeight: 1, pixelDepth: 1, unit: 'pixel' }
      : { pixelWidth: v.pixelWidth, pixelHeight: v.pixelHeight > 0 ? v.pixelHeight : v.pixelWidth, pixelDepth: v.pixelDepth > 0 ? v.pixelDepth : 1, unit };
    // the frame interval: "<number> <unit>" (Tools.split on " -"); a sec interval within [1/30, 2] also sets the animation rate
    const parts = validateInterval(v.frameInterval).split(/[ -]+/).filter((x) => x.length > 0);
    const n = parts.length ? Number(parts[0]) : NaN;
    next.frameInterval = Number.isFinite(n) ? n : 0;
    let timeUnit = parts.length >= 2 ? parts[1] : 'sec';
    if (timeUnit === 'usec') timeUnit = 'µsec';
    next.timeUnit = timeUnit;
    if (timeUnit === 'sec' && next.frameInterval <= 2 && next.frameInterval >= 1 / 30) next.fps = 1 / next.frameInterval;
    await applyCalibration(api, api.state().doc || doc, next, 'cmd.imageProperties');
  }

  async function applyCalibration(api, doc, next, labelKey) {
    const cal = doc.calibration || { pixelWidth: 1, pixelHeight: 1, unit: 'pixel' };
    const extra = ['pixelDepth', 'frameInterval', 'timeUnit', 'fps'].filter((k) => next[k] !== undefined);
    const dflt = { pixelDepth: 1, frameInterval: 0, timeUnit: 'sec', fps: 0 };
    const same = cal.pixelWidth === next.pixelWidth && cal.pixelHeight === next.pixelHeight && unitText(cal) === unitText(next)
      && extra.every((k) => (cal[k] === undefined ? dflt[k] : cal[k]) === next[k]);
    if (same) return;
    const params = { pixelWidth: next.pixelWidth, pixelHeight: next.pixelHeight, unit: next.unit };
    for (const k of extra) params[k] = next[k];
    await api.run('setCalibration', params, { noRoi: true, labelKey: labelKey || 'cmd.imageProperties' });
  }

  // ── Analyze > Set Scale... ─────────────────────────────────────────────────────────────────────
  // ScaleDialog.run: "Distance in pixels" (the raw length of a straight line, or the larger side of a rectangle), "Known
  // distance", "Pixel aspect ratio", "Unit of length", a live "Scale:" line and a "Click to Remove Scale" button.
  async function setScale(api, o) {
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
      const pixelWidth = scaleChanged || (o && o.source === 'macro') ? v.known / v.measured : pw0;
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
      { id: 'adjustSize', menu: ['Image', 'Adjust'], order: 30, long: true, run: size },
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
