/* ij-cmds-bg.js — menu commands of package P1 (bg): Subtract Background, Enhance Contrast.
 *
 * Runs on the page only, before IJApp.mount. Every call goes through the documented extension API (ij-app.js).
 *
 *   Process > Subtract Background…   BackgroundSubtracter.showDialog: Rolling ball radius [50, pixels], Light
 *        background [on: Prefs "bs.background" defaults to true], Create background (don't subtract), Sliding
 *        paraboloid, Disable smoothing, Preview. "Separate colors" is for RGB images (not offered). A selection is
 *        ignored (the plugin has no SUPPORTS_MASKING flag).
 *   Process > Enhance Contrast…      ContrastEnhancer.showDialog: Saturated pixels [0.35 %], Normalize (not on a
 *        multi-channel image: it is a CompositeImage there), Update all when normalizing (area selection, not
 *        composite), Equalize histogram; plus the "Classic equalization" choice ImageJ takes from the Alt key.
 *        Without Normalize the result is the display range of the channel (api.setDisplay), the pixels are not touched.
 *
 * The dialog values of the last run are kept for the session (ImageJ's static fields): radius, light background,
 * create background, sliding paraboloid, smoothing; saturated pixels and equalize. ImageJ resets `normalize` and
 * `entireImage` on every run (instance fields): so do we.
 */
(function () {
  'use strict';
  if (typeof IJApp === 'undefined' || typeof IJApp.extend !== 'function') return;

  const AREA = { rect: 1, oval: 1, polygon: 1, freehand: 1, mask: 1 };
  const last = { radius: 50, light: true, create: false, sliding: false, noSmooth: false, saturated: 0.35, equalize: false };

  function codeError(code) { return Object.assign(new Error(code), { code }); }

  /* The bounding rectangle of an area selection, clipped to the image: ImagePlus.getProcessor() hands
   * equalize() `ip.setRoi(roi.getBounds())`. null when there is no area selection (the whole image). */
  function boundsRect(roi, info) {
    if (!roi || !AREA[roi.type] || typeof IJRoi === 'undefined') return null;
    // every area type: IJRoi.bounds (a polygon / freehand / mask carries points or runs, not x / y / w / h)
    const bb = IJRoi.bounds(roi);
    const x0 = Math.max(0, bb.x), y0 = Math.max(0, bb.y);
    const x1 = Math.min(info.width, bb.x + bb.w), y1 = Math.min(info.height, bb.y + bb.h);
    if (!(x1 > x0 && y1 > y0)) return null;
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  async function subtractBackground(api) {
    const st = api.state();
    const info = st.doc;
    if (!info) return;
    const multi = (info.channels || []).length > 1;
    const fields = [
      { type: 'number', id: 'radius', labelKey: 'dlg.bg.radius', value: last.radius, step: 5, decimals: 1, unitsKey: 'dlg.pixels' },
      { type: 'check', id: 'light', labelKey: 'dlg.bg.light', value: last.light },
      { type: 'check', id: 'create', labelKey: 'dlg.bg.create', value: last.create },
      { type: 'check', id: 'sliding', labelKey: 'dlg.bg.sliding', value: last.sliding },
      { type: 'check', id: 'noSmooth', labelKey: 'dlg.bg.noSmooth', value: last.noSmooth }
    ];
    if (multi) fields.push({ type: 'check', id: 'all', labelKey: 'dlg.allChannels', value: false });
    // radius <= 0.0001 || gd.invalidNumber() → the dialog refuses (dialogItemChanged returns false)
    const params = (v) => ({ radius: Number(v.radius), light: !!v.light, createBackground: !!v.create, sliding: !!v.sliding, disableSmoothing: !!v.noSmooth, correctCorners: true });
    const values = await api.dialog({
      title: api.tr('cmd.procSubtractBackground'),
      okLabel: api.tr('dlg.ok'),
      fields,
      validate: (v) => (Number(v.radius) > 0.0001 && Number(v.radius) <= 10000 ? null : { radius: 'err.badArgs' }),
      preview: { op: 'subtractBackground', params, channel: (v) => (v.all ? 'all' : st.activeChannel) } // the run's channel, captured once: a non-modal dialog must not follow a later switch
    });
    if (!values) return;
    last.radius = Number(values.radius); last.light = !!values.light; last.create = !!values.create;
    last.sliding = !!values.sliding; last.noSmooth = !!values.noSmooth;
    await api.run('subtractBackground', params(values), { docId: info.docId, channel: values.all ? 'all' : st.activeChannel, noRoi: true, labelKey: 'op.subtractBackground' });
  }

  async function enhanceContrast(api) {
    const st = api.state();
    const info = st.doc;
    if (!info) return;
    const composite = (info.channels || []).length > 1;
    const roi = st.roi;
    const areaRoi = !!roi && !!AREA[roi.type] && !composite;
    const ch = st.activeChannel;
    const fields = [{ type: 'number', id: 'saturated', labelKey: 'dlg.bg.saturated', value: last.saturated, min: 0, max: 100, step: 0.1, decimals: 2, units: '%' }];
    if (!composite) fields.push({ type: 'check', id: 'normalize', labelKey: 'dlg.bg.normalize', value: false });
    if (areaRoi) fields.push({ type: 'check', id: 'entire', labelKey: 'dlg.bg.entire', value: false });
    fields.push({ type: 'check', id: 'equalize', labelKey: 'dlg.bg.equalize', value: last.equalize });
    fields.push({ type: 'check', id: 'classic', labelKey: 'dlg.bg.classic', value: false, enabledIf: (v) => !!v.equalize });
    const v = await api.dialog({ title: api.tr('cmd.procEnhanceContrast'), okLabel: api.tr('dlg.ok'), fields });
    if (!v) return;
    last.saturated = Number(v.saturated);
    last.equalize = !!v.equalize;
    const normalize = !composite && !!v.normalize;
    const maxValue = info.bitDepth === 32 ? 1 : info.bitDepth === 16 ? 65535 : 255;

    if (v.equalize) {
      // ContrastEnhancer.equalize(imp): "Equalization of 32-bit images not supported."
      if (info.bitDepth === 32) { api.error(codeError('IJ_BG_EQUALIZE_32')); return; }
      const res = await api.run('enhanceEqualize', { classic: !!v.classic, rect: boundsRect(roi, info) }, { docId: info.docId, channel: ch, noRoi: true, labelKey: 'op.enhanceEqualize' });
      if (!res) return;
      if (normalize) await api.setDisplay(info.docId, ch, { min: 0, max: maxValue }); // run(): ip.setMinAndMax(0, maxValue)
      return;
    }

    // stretchHistogram: the statistics of the selection (a line / point: its bounding rectangle, as ImageJ does)
    const range = await api.compute('saturatedRange', { saturated: Math.min(100, Math.max(0, Number(v.saturated))) }, { docId: info.docId, channel: ch, labelKey: 'op.saturatedRange' });
    if (!range) return;
    if (!range.valid) {
      // hmax <= hmin: stretchHistogram does nothing, but run() still ends with
      //   "if (normalize) { ... ip.setMinAndMax(0, ip.getBitDepth()==32?1.0:ip.maxValue()); }"
      if (normalize) await api.setDisplay(info.docId, ch, { min: 0, max: maxValue });
      api.toast('res.enhanceNoChange');
      return;
    }
    if (!normalize) {
      await api.setDisplay(info.docId, ch, { min: range.displayMin, max: range.displayMax });
      return;
    }
    // updateSelectionOnly = areaRoi && !entireImage (&& normalize): only the selection is remapped on 8 / 16 bits;
    // a 32-bit image is always normalised whole (normalizeFloat loops over every pixel, applyTable is a no-op).
    const selectionOnly = areaRoi && !v.entire && info.bitDepth !== 32;
    const res = await api.run('enhanceNormalize', { min: range.min, max: range.max }, { docId: info.docId, channel: ch, noRoi: !selectionOnly, labelKey: 'op.enhanceNormalize' });
    if (!res) return;
    await api.setDisplay(info.docId, ch, { min: 0, max: maxValue }); // run(): ip.setMinAndMax(0, 1.0 | maxValue())
  }

  IJApp.extend({
    pkg: 'bg',
    commands: [
      { id: 'procEnhanceContrast', menu: ['Process'], order: 50, separatorBefore: true, run: enhanceContrast },
      { id: 'procSubtractBackground', menu: ['Process'], order: 110, long: true, run: subtractBackground }
    ],
    errors: { IJ_BG_TOO_SMALL: 'err.bgTooSmall', IJ_BG_EQUALIZE_32: 'err.bgEqualize32' }
  });
})();
