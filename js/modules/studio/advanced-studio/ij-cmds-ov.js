/* ij-cmds-ov.js — menu commands of package ov (wave 3): Image › Overlay (Add Selection, Hide, Show, From / To ROI Manager,
 * Remove, Toggle), Analyze › Tools › Grid… and Scale Bar…. Page only; talks to the app through the documented extension API
 * (IJApp.EXT_API_MEMBERS) and to the worker through the `paintMask` operation of ij-proc-ov.js.
 *
 * The overlay of ImageJ is the document's persistent annotations (api.annotations, PLAN-wave3 §2.5): not undo steps, kept in the
 * session, cleared with a warning by a size change. Every geometry, default and quirk is ij-proc-ov.js (IJOv), ported from
 * ij.plugin.OverlayCommands / Grid / ScaleBar and checked against the goldens of tests/fixtures/ij-wave3/ov.
 *
 * What the browser changes (listed in the About box):
 *   • Add Selection adds at once with the remembered style, as ImageJ does; its dialog (RoiProperties, reduced to the stroke / width /
 *     fill / New overlay fields that fit a stored selection) opens with Alt held (run(api, { alt }), the modifiers of the menu click). The point type / size fields of a point selection are not offered.
 *   • Grid and Scale Bar preview ONLY while the dialog's Preview box is ticked; Cancel puts the previous grid / bar back.
 *   • A grid's Bold width follows Grid.java:129-135 (2 px, widened by 1/mag when zoomed out) with the zoom of the moment the grid is made.
 *   • A vertical scale bar label is set horizontally beside its bar in the overlay (an annotation text has no rotation); a burnt-in
 *     bar keeps ImageJ's rotated text.
 *   • Text burnt into the pixels is rasterised by the browser's fonts and thresholded at half coverage (no anti-aliasing), where
 *     ImageJ's Java font anti-aliases; the bar rectangles are exact. Burn-in is available on multichannel images too (ImageJ forces
 *     the overlay on a composite): each channel gets the value of its own LUT.
 *   • Scale Bar's "Remove Scale Bar" button is a check box; the digits of the width are those of its number, not of the typed text
 *     (the dialog hands over numbers: "10.0" gives "10 µm", ImageJ "10.0 µm"; scientific notation is not offered).
 *   • The area per point of Grid is kept for the page session only, as ImageJ's static is kept for the session.
 *   • To ROI Manager keeps the overlay items that are not selections (text, scale bar, grid): ImageJ turns every overlay element
 *     into a manager entry and removes the overlay.
 *   • Random grid offsets draw from a journaled seed (api.sessionData), ImageJ from the clock.
 */
(function () {
  'use strict';
  if (typeof IJApp === 'undefined' || typeof IJApp.extend !== 'function') return;

  const GRID_TAG = '|GRID|';          // Grid.GRID
  const SB_TAG = '|SB|';              // ScaleBar.SCALE_BAR
  const OV = () => (typeof IJOv !== 'undefined' ? IJOv : null);
  const G = typeof self !== 'undefined' ? self : globalThis;

  // ───────────────────────────── the browser's canvas, behind one replaceable door (the tests swap it) ─────────────────────────────

  const UI = {
    /** A 2D canvas context of w × h pixels, or null where the browser has none (tests, locked-down contexts). */
    canvas(w, h) {
      try {
        let c = null;
        if (typeof OffscreenCanvas !== 'undefined') c = new OffscreenCanvas(w, h);
        else if (typeof document !== 'undefined' && document && typeof document.createElement === 'function') { c = document.createElement('canvas'); c.width = w; c.height = h; }
        const ctx = c && typeof c.getContext === 'function' ? c.getContext('2d', { willReadFrequently: true }) : null;
        return ctx && typeof ctx.measureText === 'function' ? ctx : null;
      } catch (e) { return null; }
    },
    font: (size, bold, serif) => `${bold ? 'bold ' : ''}${size}px ${serif ? 'serif' : 'sans-serif'}`,
    /** ImageProcessor.getStringWidth: the advance of `text` in whole pixels. */
    measure(text, size, bold, serif) {
      const ctx = UI.canvas(8, 8);
      if (!ctx) return Math.round(text.length * size * (bold ? 0.62 : 0.56));
      ctx.font = UI.font(size, bold, serif);
      return Math.round(ctx.measureText(text).width);
    },
    /**
     * A label as a raster: { w, h, data } (data = w·h bytes, non-zero = painted, half coverage) and the offset of the anchor
     * inside it. angle 0: the anchor is the top left of the text; angle 90: ImageJ's TextRoi anchor, the bottom left of a text
     * that reads upwards. null when the browser has no canvas.
     */
    MAX_RASTER_PIXELS: 33554432,
    rasterText(text, size, bold, serif, angle, width) {
      const pad = 2;
      const horizontal = angle !== 90;
      const w = horizontal ? Math.ceil(width) + 2 * pad : Math.ceil(size * 1.5) + 2 * pad;
      const h = horizontal ? Math.ceil(size * 1.5) + 2 * pad : Math.ceil(width) + 2 * pad;
      // a label of this many pixels is read back and walked on the main thread: beyond ~32 Mpx it is refused (null is only "no canvas")
      if (!(w * h <= UI.MAX_RASTER_PIXELS)) throw ovError('IJ_OV_LABEL_TOO_LARGE');
      const ctx = UI.canvas(w, h);
      if (!ctx) return null;
      ctx.clearRect(0, 0, w, h);
      ctx.font = UI.font(size, bold, serif);
      ctx.textBaseline = 'top';
      ctx.textAlign = 'left';
      ctx.fillStyle = '#ffffff';
      if (horizontal) { ctx.fillText(text, pad, pad); } else { ctx.translate(pad, h - pad); ctx.rotate(-Math.PI / 2); ctx.fillText(text, 0, 0); }
      const px = ctx.getImageData(0, 0, w, h).data;
      const data = new Uint8Array(w * h);
      for (let i = 0; i < data.length; i++) data[i] = px[i * 4 + 3] >= 128 ? 1 : 0;
      return { w, h, data, ax: pad, ay: horizontal ? pad : h - pad };
    },
    /** A 31-bit seed for a random grid offset (ImageJ: Random(System.currentTimeMillis())). */
    seed() {
      try {
        if (G.crypto && typeof G.crypto.getRandomValues === 'function') { const a = new Uint32Array(1); G.crypto.getRandomValues(a); return a[0] & 0x7fffffff; }
      } catch (e) { /* the clock below */ }
      return Date.now() & 0x7fffffff;
    }
  };
  G.IJOvUi = UI;
  /** Grid.saveAreaPerPoint: a static of the session (0 = the default of the next image). */
  let sessionGridArea = 0;

  // ───────────────────────────── helpers ─────────────────────────────

  const idle = (st) => !!(st && st.doc) && !st.busy;
  const isPromise = (v) => !!v && typeof v.then === 'function';
  /** A stored object or {} (a recording api answers promises). */
  function stored(api, key) {
    const v = api.settings.get(key);
    return v && typeof v === 'object' && !Array.isArray(v) && !isPromise(v) ? v : {};
  }
  function ovError(code) { const e = new Error(code); e.code = code; return e; }
  /** `Foo Bar` → `fooBar`: the lang key of a choice's label. */
  const camel = (s) => s.replace(/\s+(\w)/g, (m, c) => c.toUpperCase()).replace(/^\w/, (c) => c.toLowerCase());
  const opts = (prefix, list) => list.map((v) => ({ value: v, labelKey: prefix + camel(v) }));
  const num = (v, fallback) => (typeof v === 'number' && isFinite(v) ? v : fallback);
  const bool = (v, fallback) => (typeof v === 'boolean' ? v : fallback);
  const pick = (v, list, fallback) => (typeof v === 'string' && list.indexOf(v) >= 0 ? v : fallback);

  const itemsOf = (api, docId) => {
    const a = api.annotations.get(docId);
    return a && Array.isArray(a.items) ? a.items : [];
  };
  const taggedItems = (api, docId, tag) => itemsOf(api, docId).filter((it) => it.tag === tag);

  /** The calibration an overlay command reads: pixel sizes (never 0) and the unit. */
  function calOf(info) {
    const c = info.calibration || {};
    return { pixelWidth: c.pixelWidth > 0 ? c.pixelWidth : 1, pixelHeight: c.pixelHeight > 0 ? c.pixelHeight : 1, unit: c.unit || 'pixel' };
  }
  const imageOf = (info) => { const c = calOf(info); return { width: info.width, height: info.height, pixelWidth: c.pixelWidth, pixelHeight: c.pixelHeight, unit: c.unit }; };

  // ───────────────────────────── Image › Overlay ─────────────────────────────

  /** OverlayCommands.addSelection, through the dialog of RoiProperties ("Stroke color", "Width", "Fill color", "New overlay"). */
  async function addSelection(api, mods) {
    const st = api.state(), info = st.doc;
    if (!info || !OV()) return;
    const docId = info.docId, roi = st.roi;
    if (!roi) {
      // `if (roi==null && imp.getOverlay()!=null)` the "No Selection" dialog; `if (roi==null) IJ.error("This command requires a selection.")`
      if (!itemsOf(api, docId).length) throw ovError('IJ_NEEDS_ROI');
      const v = await api.dialog({ title: api.tr('dlg.ov.noSelectionTitle'), okLabel: api.tr('dlg.ok'), fields: [
        { type: 'message', id: 'msg', labelKey: 'dlg.ov.noSelectionMsg' },
        { type: 'check', id: 'remove', labelKey: 'dlg.ov.removeExisting', value: false }] });
      if (v && v.remove) api.annotations.set(docId, []);
      return;
    }
    const memory = stored(api, 'ov.add');
    const sel = OV().decodeColor(api.settings.get('colors.selection'), null) || { rgb: [255, 255, 0], alpha: 255 };
    // `if (roi.getStrokeColor()==null) roi.setStrokeColor(defaultRoi.getStrokeColor())` …: the remembered style applies without a dialog
    let vals = {
      stroke: typeof memory.stroke === 'string' && memory.stroke ? memory.stroke : OV().colorName(sel.rgb, 255),
      width: num(memory.width, 0), fill: typeof memory.fill === 'string' && memory.fill ? memory.fill : 'none', newOverlay: false };
    // `if (IJ.altKeyDown() || …) { RoiProperties rp = new RoiProperties("Add to Overlay", roi); if (!rp.showDialog()) return; … }`
    // RoiProperties.showDialog: a point has the stroke colour only, a line has no fill, any other selection stroke, width and fill.
    const isPoint = roi.type === 'point', isLine = roi.type === 'line' || roi.type === 'polyline' || roi.type === 'freeline' || roi.type === 'angle';
    if (mods && mods.alt) {
      const fields = [{ type: 'string', id: 'stroke', labelKey: isPoint ? 'dlg.ov.strokePoint' : 'dlg.ov.stroke', value: vals.stroke }];
      if (!isPoint) fields.push({ type: 'number', id: 'width', labelKey: 'dlg.ov.width', value: vals.width, min: 0, step: 'any', decimals: Number.isInteger(vals.width) ? 0 : 1 });
      if (!isPoint && !isLine) fields.push({ type: 'string', id: 'fill', labelKey: 'dlg.ov.fill', value: vals.fill });
      fields.push({ type: 'check', id: 'newOverlay', labelKey: 'dlg.ov.newOverlay', value: false });
      const v = await api.dialog({ title: api.tr('dlg.ov.addTitle'), okLabel: api.tr('dlg.ok'), fields });
      if (!v) return;
      vals = Object.assign({}, vals, v);
      if (isPoint) vals.width = 0;
      if (isPoint || isLine) vals.fill = 'none';
      api.settings.set('ov.add', { stroke: vals.stroke, width: vals.width, fill: vals.fill });
    }
    // Colors.decode(text, null): a text that is no colour is no colour; "none" leaves no fill
    const stroke = OV().decodeColor(vals.stroke, null);
    const fill = OV().decodeColor(vals.fill, null);
    let strokeCss = stroke ? OV().cssOpaque(stroke) : null, fillCss = fill ? OV().cssRgba(fill) : null;
    // `if (roi.getStrokeColor()==null && roi.getFillColor()==null) roi.setStrokeColor(Roi.getColor());`
    if (!strokeCss && !fillCss) strokeCss = OV().cssOpaque(sel);
    const item = { kind: 'roi', roi, stroke: strokeCss, width: vals.width, fill: fillCss };
    if (typeof roi.name === 'string' && roi.name) item.name = roi.name;
    // `if (overlay==null || newOverlay) overlay = OverlayLabels.createOverlay();`
    if (vals.newOverlay) api.annotations.set(docId, [item]); else api.annotations.add(docId, [item]);
    // `if (points || …) imp.deleteRoi();` — a multi-point selection leaves the image once it is in the overlay
    if (roi.type === 'point' && Array.isArray(roi.points) && roi.points.length > 1) api.setRoi(null, { docId });
  }

  /** OverlayCommands.fromRoiManager → RoiManager.moveRoisToOverlay: every entry of the manager is CLONED into the overlay (the list
   *  stays), `imp.deleteRoi()`. Here: the entries of this image. */
  async function fromRoiManager(api) {
    const st = api.state(), info = st.doc;
    if (!info) return;
    const docId = info.docId;
    const list = api.roiManager.list().filter((e) => e.docId === docId);
    if (!list.length) throw ovError('IJ_OV_MANAGER_EMPTY');
    const items = list.map((e) => {
      const it = { kind: 'roi', roi: e.roi, stroke: e.stroke || null, width: typeof e.width === 'number' ? e.width : 0, fill: e.fill ? (e.fill.length === 7 ? e.fill + 'ff' : e.fill) : null };
      if (e.name) it.name = e.name;
      return it;
    });
    api.annotations.add(docId, items);
    api.setRoi(null, { docId });
  }

  /** OverlayCommands.toRoiManager: `rm.setOverlay(overlay); imp.setOverlay(null);` — the manager is reset to the overlay's elements.
   *  Only the selections of an overlay can be manager entries here; text, scale bar and grid items stay in the overlay. */
  async function toRoiManager(api) {
    const st = api.state(), info = st.doc;
    if (!info) return;
    const docId = info.docId;
    const items = itemsOf(api, docId);
    if (!items.length) throw ovError('IJ_OV_NO_OVERLAY');                // IJ.error("Overlay required")
    const rois = items.filter((it) => it.kind === 'roi' && it.roi);
    if (!rois.length) throw ovError('IJ_OV_NO_ROI_ITEMS');
    const entries = rois.map((it) => {
      const e = { docId, roi: it.roi };
      if (it.name) e.name = it.name;
      if (it.stroke) e.stroke = it.stroke;
      if (typeof it.width === 'number' && it.width > 0) e.width = it.width;
      if (it.fill) e.fill = it.fill;
      return e;
    });
    // reset(): this image's entries are replaced, those of the other images are not touched
    const others = api.roiManager.list().filter((e) => e.docId !== docId);
    api.roiManager.set(others.concat(entries));
    api.annotations.remove(docId, { ids: rois.map((it) => it.id) });
    if (rois.length < items.length) api.toast('warn.ovKept', { n: items.length - rois.length });
  }

  // ───────────────────────────── Analyze › Tools › Grid ─────────────────────────────

  async function gridRun(api) {
    const st = api.state(), info = st.doc;
    const ov = OV();
    if (!info || !ov) return;
    const docId = info.docId;
    const cal = calOf(info), scaled = ov.isScaled(info.calibration);
    const img = { width: info.width, height: info.height, pixelWidth: scaled ? cal.pixelWidth : 1, pixelHeight: scaled ? cal.pixelHeight : 1 };
    const prefs = stored(api, 'ov.grid');
    // Grid.getSettings: the stored type ("None" comes back as Lines), colour, bold / centred / random; the static area (0 = the default)
    const type0 = pick(prefs.type, ov.GRID_TYPES, 'Lines') === 'None' ? 'Lines' : pick(prefs.type, ov.GRID_TYPES, 'Lines');
    let randomOffset0 = bool(prefs.randomOffset, false), centered0 = bool(prefs.centered, false);
    if (centered0) randomOffset0 = false;
    const area0 = sessionGridArea > 0 ? sessionGridArea : ov.gridDefaultArea(info.width, info.height, cal.pixelWidth, cal.pixelHeight);
    const places = scaled ? 2 : 0;
    const units = (scaled ? ov.pluralOf(cal.unit) : 'pixels') + '^2';      // Grid.java:159 cal.getUnits() + "^2"
    const previous = taggedItems(api, docId, GRID_TAG);
    const seed = UI.seed();
    const view0 = api.view(docId);
    const zoom0 = view0 && typeof view0.getView === 'function' && view0.getView() && view0.getView().zoom > 0 ? view0.getView().zoom : 1;
    const geometryOf = (v) => ov.gridGeometry({ type: v.type, area: v.area, color: v.color, bold: v.bold, centered: v.centered, randomOffset: v.randomOffset, seed, zoom: zoom0 }, img);
    const draw = (v) => {
      const g = geometryOf(v);
      if (!g.ok) return g;
      if (g.none) api.annotations.remove(docId, { tag: GRID_TAG });
      else api.annotations.set(docId, [ov.gridItem(g, v.color, GRID_TAG)], { tag: GRID_TAG });
      return g;
    };
    const v = await api.dialog({
      title: api.tr('dlg.ov.gridTitle'), okLabel: api.tr('dlg.ok'),
      fields: [
        { type: 'choice', id: 'type', labelKey: 'dlg.ov.gridType', value: type0, options: opts('dlg.ov.gt.', ov.GRID_TYPES) },
        { type: 'number', id: 'area', labelKey: 'dlg.ov.gridArea', value: area0, step: 'any', decimals: places, units },
        { type: 'choice', id: 'color', labelKey: 'dlg.ov.gridColor', value: pick(prefs.color, ov.GRID_COLORS, 'Cyan'), options: opts('dlg.ov.c.', ov.GRID_COLORS) },
        { type: 'check', id: 'bold', labelKey: 'dlg.ov.gridBold', value: bool(prefs.bold, false) },
        { type: 'check', id: 'centered', labelKey: 'dlg.ov.gridCenter', value: centered0 },
        { type: 'check', id: 'randomOffset', labelKey: 'dlg.ov.gridRandom', value: randomOffset0 }],
      // `if (randomOffset) { centered = false; centerCheckbox.setState(false); }`
      onChange(vals, set, changed) { if (changed === 'randomOffset' && vals.randomOffset) set({ centered: false }); },
      // Grid.dialogItemChanged: `"Area per Point" too small`
      validate(vals) { return vals.area / (img.pixelWidth * img.pixelHeight) < ov.gridMinArea(vals.type, img.width, img.height) ? { area: 'dlg.ov.gridTooSmall' } : null; },
      preview: {
        onChange(vals) {
          if (!vals) { api.annotations.set(docId, previous, { tag: GRID_TAG }); return; }
          draw(vals);
        }
      }
    });
    if (!v) { api.annotations.set(docId, previous, { tag: GRID_TAG }); return; }       // Cancel: the grid on entry comes back
    const g = draw(v);
    if (!g || !g.ok) { api.annotations.set(docId, previous, { tag: GRID_TAG }); return; }
    const centered = v.centered && !v.randomOffset;
    api.settings.set('ov.grid', { type: v.type, color: v.color, bold: v.bold, centered, randomOffset: v.randomOffset });
    sessionGridArea = v.area;
    // the seed of a random offset is part of the document's state, so the grid can be told again
    const cur = api.sessionData.get('ov');
    const data = cur && typeof cur === 'object' && !Array.isArray(cur) && !isPromise(cur) ? cur : {};
    const grids = data.grids && typeof data.grids === 'object' ? Object.assign({}, data.grids) : {};
    if (v.randomOffset && !g.none) grids[docId] = { seed, type: v.type, area: v.area, xstart: g.xstart, ystart: g.ystart }; else delete grids[docId];
    api.sessionData.set('ov', Object.assign({}, data, { grids }));
  }

  // ───────────────────────────── Analyze › Tools › Scale Bar ─────────────────────────────

  const CFG_KEYS = ['showHorizontal', 'showVertical', 'hBarWidth', 'vBarHeight', 'hDigits', 'vDigits', 'barThicknessInPixels', 'color', 'bcolor', 'boldText',
    'hideText', 'serifFont', 'useOverlay', 'fontSize'];
  /** The persisted configuration (ScaleBar.sConfig; its location is always Lower Right, `updateFrom` resets it). */
  function loadConfig(api) {
    const o = OV();
    const p = stored(api, 'ov.scaleBar');
    const d = o.scaleBarConfig();
    return o.scaleBarConfig({
      showHorizontal: bool(p.showHorizontal, d.showHorizontal), showVertical: bool(p.showVertical, d.showVertical),
      hBarWidth: num(p.hBarWidth, d.hBarWidth), vBarHeight: num(p.vBarHeight, d.vBarHeight),
      hDigits: Number.isInteger(p.hDigits) ? p.hDigits : 0, vDigits: Number.isInteger(p.vDigits) ? p.vDigits : 0,
      barThicknessInPixels: Number.isInteger(p.barThicknessInPixels) && p.barThicknessInPixels > 0 ? p.barThicknessInPixels : d.barThicknessInPixels,
      color: pick(p.color, o.SB_COLORS, d.color), bcolor: pick(p.bcolor, o.SB_BCOLORS, d.bcolor),
      boldText: bool(p.boldText, d.boldText), hideText: bool(p.hideText, d.hideText), serifFont: bool(p.serifFont, d.serifFont), useOverlay: bool(p.useOverlay, d.useOverlay),
      fontSize: Number.isInteger(p.fontSize) && p.fontSize > 0 ? p.fontSize : d.fontSize
    });
  }
  /** The width of a label in the configured font, the way ImageProcessor.getStringWidth measures it. */
  const measurerOf = (cfg) => (text) => UI.measure(text, cfg.fontSize, cfg.boldText, cfg.serifFont);

  /** The value of each channel for a colour: ImageJ's drawOverlayOnProcessor rule, with the channel's own LUT and display range. */
  function valuesFor(info, rgb) {
    const o = OV();
    return (info.channels || []).map((ch) => {
      const d = ch.display || {};
      let table;
      try { table = IJLuts.get(d.lut || 'Grays'); } catch (e) { table = IJLuts.get('Grays'); }
      if (d.invert) { const r = new Uint8Array(768); for (let i = 0; i < 256; i++) { const j = 255 - i; r[i * 3] = table[j * 3]; r[i * 3 + 1] = table[j * 3 + 1]; r[i * 3 + 2] = table[j * 3 + 2]; } table = r; }
      const isDefault = (!d.lut || d.lut === 'Grays') && !d.invert;
      return o.burnValue(rgb, info.bitDepth, table, isDefault, d);
    });
  }
  /** The paintMask parameters of a scale bar: the background box(es) under the bar and its text, then the bars and the text, each
   *  in its own colour and with the value of each channel. */
  function burnParams(info, cfg, res) {
    const o = OV();
    const box = (r) => ({ x: r.x, y: r.y, w: r.w, h: r.h });
    const backs = res.items.filter((it) => it.kind === 'rect' && it.role === 'background').map(box);
    const bars = res.items.filter((it) => it.kind === 'rect' && it.role === 'bar').map(box);
    const patches = [];
    for (const it of res.items) {
      if (it.kind !== 'text') continue;
      const patch = UI.rasterText(it.text, cfg.fontSize, cfg.boldText, cfg.serifFont, it.angle, it.width);
      if (!patch) throw ovError('IJ_OV_LABEL_CANVAS');          // no drawing surface: refused, never burnt without its text
      patches.push({ x: it.x - patch.ax, y: it.y - patch.ay, w: patch.w, h: patch.h, data: patch.data });
    }
    const layers = [];
    const bg = o.scaleBarBackground(cfg.bcolor);
    if (bg && backs.length) layers.push({ runs: o.buildMaskRuns(info.width, info.height, backs, []), values: valuesFor(info, bg) });
    layers.push({ runs: o.buildMaskRuns(info.width, info.height, bars, patches), values: valuesFor(info, o.scaleBarColor(cfg.color)) });
    return { w: info.width, h: info.height, layers };
  }

  async function scaleBarRun(api) {
    const st = api.state(), info = st.doc;
    const o = OV();
    if (!info || !o) return;
    const docId = info.docId;
    const img = imageOf(info);
    const previous = taggedItems(api, docId, SB_TAG);
    // `userRoiExists = parseCurrentROI()`: the bounds of the selection
    let roiBox = null;
    if (st.roi && typeof IJRoi !== 'undefined') { try { const b = IJRoi.bounds(st.roi); roiBox = { x: b.x, y: b.y, w: b.w, h: b.h }; } catch (e) { roiBox = null; } }
    const view = api.view(docId);
    const zoom = view && typeof view.getView === 'function' && view.getView() ? view.getView().zoom : 1;
    let cfg = loadConfig(api);
    if (roiBox) cfg.location = 'At Selection';                     // `if (currentROIExists) config.location = locations[AT_SELECTION];`
    if (o.scaleBarNeedsDefaults(cfg, img, !!roiBox) || !(cfg.hBarWidth > 0) || !(cfg.vBarHeight > 0)) cfg = o.scaleBarDefaults(cfg, img, zoom, roiBox);
    if (cfg.hDigits > 7) cfg.hDigits = 4;                          // BarDialog: `if (config.hDigits>7) config.hDigits=4;`
    if (cfg.vDigits > 7) cfg.vDigits = 4;
    const unit = o.unitsOf(img.unit);
    const digitsOf = (d) => (d >= 0 ? Math.min(d, 7) : 4);

    const fromValues = (v) => o.scaleBarConfig({
      showHorizontal: v.horizontal, showVertical: v.vertical, hBarWidth: v.width, vBarHeight: v.height,
      hDigits: o.getDigits(v.width), vDigits: o.getDigits(v.height), barThicknessInPixels: v.thickness, fontSize: v.fontSize,
      color: v.color, bcolor: v.background, location: v.location, boldText: v.bold, hideText: v.hideText, serifFont: v.serif, useOverlay: v.overlay
    });
    const geometry = (c) => o.scaleBarGeometry(c, img, measurerOf(c), roiBox);
    const show = (c) => {
      const res = geometry(c);
      if (!res) { api.annotations.remove(docId, { tag: SB_TAG }); return res; }
      api.annotations.set(docId, o.scaleBarItems(res, c, SB_TAG), { tag: SB_TAG });
      return res;
    };
    const had = previous.length > 0;
    const v = await api.dialog({
      title: api.tr('dlg.ov.sbTitle'), okLabel: api.tr('dlg.ok'),
      fields: [
        { type: 'number', id: 'width', label: api.tr('dlg.ov.sbWidth', { unit }), value: cfg.hBarWidth, step: 'any', decimals: digitsOf(cfg.hDigits) },
        { type: 'number', id: 'height', label: api.tr('dlg.ov.sbHeight', { unit }), value: cfg.vBarHeight, step: 'any', decimals: digitsOf(cfg.vDigits) },
        { type: 'number', id: 'thickness', labelKey: 'dlg.ov.sbThickness', value: cfg.barThicknessInPixels, min: 1, integer: true },
        { type: 'number', id: 'fontSize', labelKey: 'dlg.ov.sbFontSize', value: cfg.fontSize, min: 1, max: 2 * Math.max(img.width, img.height), integer: true },
        { type: 'choice', id: 'color', labelKey: 'dlg.ov.sbColor', value: cfg.color, options: opts('dlg.ov.c.', o.SB_COLORS) },
        { type: 'choice', id: 'background', labelKey: 'dlg.ov.sbBackground', value: cfg.bcolor, options: opts('dlg.ov.c.', o.SB_BCOLORS) },
        { type: 'choice', id: 'location', labelKey: 'dlg.ov.sbLocation', value: cfg.location, options: opts('dlg.ov.loc.', o.SB_LOCATIONS) },
        { type: 'check', id: 'horizontal', labelKey: 'dlg.ov.sbHorizontal', value: cfg.showHorizontal },
        { type: 'check', id: 'vertical', labelKey: 'dlg.ov.sbVertical', value: cfg.showVertical },
        { type: 'check', id: 'bold', labelKey: 'dlg.ov.sbBold', value: cfg.boldText },
        { type: 'check', id: 'hideText', labelKey: 'dlg.ov.sbHideText', value: cfg.hideText },
        { type: 'check', id: 'serif', labelKey: 'dlg.ov.sbSerif', value: cfg.serifFont },
        { type: 'check', id: 'overlay', labelKey: 'dlg.ov.sbOverlay', value: cfg.useOverlay },
        ...(had ? [{ type: 'check', id: 'removeBar', labelKey: 'dlg.ov.sbRemove', value: false }] : [])],
      validate(vals) {
        const bad = {};
        if (vals.removeBar) return null;
        if (vals.horizontal && !(vals.width > 0)) bad.width = 'dlg.ov.sbPositive';
        if (vals.vertical && !(vals.height > 0)) bad.height = 'dlg.ov.sbPositive';
        // "At Selection" without a selection: MissingRoiException, nothing is drawn
        if (vals.location === 'At Selection' && !roiBox) bad.location = 'dlg.ov.sbNeedsSelection';
        return Object.keys(bad).length ? bad : null;
      },
      preview: {
        onChange(vals) {
          if (!vals) { api.annotations.set(docId, previous, { tag: SB_TAG }); return; }
          if (vals.removeBar) { api.annotations.remove(docId, { tag: SB_TAG }); return; }
          show(fromValues(vals));
        }
      }
    });
    if (!v) { api.annotations.set(docId, previous, { tag: SB_TAG }); return; }       // Cancel: `removeScalebar(); restoreOverlayScaleBar();`
    if (v.removeBar) { api.annotations.remove(docId, { tag: SB_TAG }); return; }       // "Remove Scale Bar"
    const done = fromValues(v);
    const persisted = {};
    for (const k of CFG_KEYS) persisted[k] = done[k];
    api.settings.set('ov.scaleBar', persisted);                                       // persistConfiguration()
    if (done.useOverlay) {
      show(done);
      return;
    }
    // Overlay off: the bar is written into the pixels, every channel with the value of its own LUT
    const res = geometry(done);
    if (!res) return;
    const params = burnParams(info, done, res);
    const ran = await api.run('paintMask', params, { docId, channel: 'all', noRoi: true, labelKey: 'op.paintMask' });
    if (ran) api.annotations.remove(docId, { tag: SB_TAG });          // `removeScalebar()` first: a previous overlay bar goes
  }

  const overlayOf = (fn) => async (api) => { const st = api.state(); if (st.doc) fn(api, st.doc.docId); };

  IJApp.extend({
    pkg: 'ov',
    errors: {
      IJ_OV_NO_OVERLAY: 'err.ovNoOverlay', IJ_OV_MANAGER_EMPTY: 'err.ovManagerEmpty', IJ_OV_NO_ROI_ITEMS: 'err.ovNoRoiItems',
      IJ_OV_LABEL_TOO_LARGE: 'err.ovLabelTooLarge', IJ_OV_LABEL_CANVAS: 'err.ovLabelCanvas'
    },
    commands: [
      // Image › Overlay (IJ_Props.txt overlay01-08; Add Image, List Elements, Flatten, Labels, Measure Overlay, Options are out of scope)
      { id: 'overlayAddSelection', menu: ['Image', 'Overlay'], order: 10, shortcut: 'b', keys: ['b'], enabled: idle, run: addSelection },
      { id: 'overlayHide', menu: ['Image', 'Overlay'], order: 30, enabled: idle, run: overlayOf((api, id) => api.annotations.setVisible(id, false)) },
      { id: 'overlayShow', menu: ['Image', 'Overlay'], order: 40, enabled: idle, run: overlayOf((api, id) => api.annotations.setVisible(id, true)) },
      { id: 'overlayFromManager', menu: ['Image', 'Overlay'], order: 50, enabled: idle, run: fromRoiManager },
      { id: 'overlayToManager', menu: ['Image', 'Overlay'], order: 60, enabled: idle, run: toRoiManager },
      { id: 'overlayRemove', menu: ['Image', 'Overlay'], order: 70, enabled: idle, run: overlayOf((api, id) => api.annotations.set(id, [])) },
      { id: 'overlayToggle', menu: ['Image', 'Overlay'], order: 80, enabled: idle, run: overlayOf((api, id) => api.annotations.setVisible(id, 'toggle')) },
      // Analyze › Tools
      { id: 'toolsScaleBar', menu: ['Analyze', 'Tools'], order: 60, enabled: idle, run: scaleBarRun },
      { id: 'toolsGrid', menu: ['Analyze', 'Tools'], order: 90, enabled: idle, run: gridRun }
    ]
  });
})();
