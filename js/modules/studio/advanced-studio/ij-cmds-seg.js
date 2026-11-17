/* ij-cmds-seg.js — menu commands of package P3 (seg): Find Maxima, Process › Binary › Outline, Skeletonize,
 * Distance Map, Ultimate Points, Watershed, Voronoi.
 *
 * Page only, runs before IJApp.mount (PLAN-wave2 §2.5). Each command talks to the extension API (`api`) and nothing
 * else; the operations they call are registered by ij-proc-seg.js (worker and page).
 *
 * ImageJ reference (1.54p): Process › Find Maxima… is ij.plugin.filter.MaximumFinder.showDialog (fields, defaults and the
 * order of the output choice are the dialog's); Distance Map / Ultimate Points / Voronoi / Watershed are ij.plugin.filter.EDM
 * (no dialog: the output type is the "EDM output" choice of Process › Binary › Options, kept in a static field — here the same
 * choice is asked by the command and remembered for the session), Outline / Skeletonize are ij.plugin.filter.Binary.
 */
(function () {
  'use strict';
  if (typeof IJApp === 'undefined' || typeof IJApp.extend !== 'function') return;

  const IJRoiLimit = 1000000; // IJRoi.MAX_VERTS
  const has = (st) => !!st.doc && !st.busy;
  const is8 = (st) => has(st) && st.doc.bitDepth === 8;

  // ImageJ keeps the dialog values in static fields (MaximumFinder.tolerance, strict, excludeOnEdges, lightBackground,
  // dialogOutputType; EDM.outputType): the same here, for the session.
  const last = { edmOutput: 'overwrite', prominence: 10, strict: false, excludeEdges: false, aboveLower: false, light: false, output: 'points' };

  /* MaximumFinder.dialogItemChanged: "(invertedLut&&!lightBackground) || (!invertedLut&&lightBackground)" = find minima. */
  const findsMinima = (light, inverted) => (!!light && !inverted) || (!light && !!inverted);

  // Process › Binary › Distance Map / Ultimate Points / Voronoi: the EDM output type, then the operation.
  async function distanceMap(api, op) {
    const st = api.state();
    const doc = st.doc;
    if (!doc) return;
    const fields = [{
      type: 'choice', id: 'output', labelKey: 'dlg.seg.output', value: last.edmOutput,
      options: [
        { value: 'overwrite', labelKey: 'dlg.seg.outOverwrite' }, { value: 'byte', labelKey: 'dlg.seg.out8' },
        { value: 'short', labelKey: 'dlg.seg.out16' }, { value: 'float', labelKey: 'dlg.seg.out32' }]
    }];
    if ((doc.channels || []).length > 1) {
      fields.push({ type: 'check', id: 'all', labelKey: 'dlg.allChannels', value: false, visibleIf: (v) => v.output === 'overwrite' });
    }
    const title = op === 'edm' ? api.tr('cmd.binDistanceMap') : op === 'ultimatePoints' ? api.tr('cmd.binUltimatePoints') : api.tr('cmd.binVoronoi');
    const v = await api.dialog({ title, fields, okLabel: api.tr('dlg.ok') });
    if (!v) return;
    last.edmOutput = v.output;
    if (v.output === 'overwrite') {
      const chans = v.all ? doc.channels.map((_, i) => i) : [st.activeChannel];
      const done = await api.run(op, { output: 'overwrite' }, { channel: v.all ? 'all' : st.activeChannel });
      if (done) await showEdmRange(api, doc.docId, chans);
    } else await api.run('edmOutput', { kind: op, output: v.output }, { channel: st.activeChannel, labelKey: 'op.edmOutput' });
  }

  /* ByteProcessor.setPixels(0, fp) ends with "setMinAndMax(fp.getMin(), fp.getMax())" and EDM.run then does
   * "if (floatEdm.getMax() > 255.) ip.resetMinAndMax();" (8-bit: 0..255): an Overwrite leaves the display on the range of
   * the map, not on 0..255 (a map whose maximum is 4 would look black). The display is not an undo step. */
  async function showEdmRange(api, docId, chans) {
    for (const c of chans) {
      const r = await api.compute('segDisplayRange', {}, { docId, channel: c, labelKey: 'op.edm' });
      if (r && r.max >= r.min) await api.setDisplay(docId, c, { min: r.min, max: r.max });
    }
  }

  // No dialog in ImageJ: the active channel, the whole image.
  async function plain(api, op, params, labelKey) {
    const st = api.state();
    if (!st.doc) return;
    await api.run(op, params, { channel: st.activeChannel, labelKey });
  }

  async function findMaxima(api) {
    const st = api.state();
    const doc = st.doc;
    if (!doc) return;
    const ch = st.activeChannel;
    const inverted = !!(doc.channels && doc.channels[ch] && doc.channels[ch].display && doc.channels[ch].display.invert);
    // "if (thresholded) gd.addCheckbox("Above lower threshold", useMinThreshold);" — thresholded = the channel has a threshold set
    const thr = st.threshold && st.threshold.docId === doc.docId && st.threshold.channel === ch ? st.threshold : null;
    const float = doc.bitDepth === 32;
    const fields = [
      { type: 'number', id: 'prominence', labelKey: 'dlg.seg.prominence', value: last.prominence, min: 0, step: float ? 0.01 : 1, decimals: float ? 2 : undefined },
      { type: 'check', id: 'strict', labelKey: 'dlg.seg.strict', value: last.strict },
      { type: 'check', id: 'excludeEdges', labelKey: 'dlg.seg.excludeEdges', value: last.excludeEdges }
    ];
    // "Above lower threshold" cannot be used when finding minima (dark background with an inverting LUT, or light background)
    if (thr) fields.push({ type: 'check', id: 'aboveLower', labelKey: 'dlg.seg.aboveLower', value: last.aboveLower, enabledIf: (v) => !findsMinima(v.light, inverted) });
    fields.push({ type: 'check', id: 'light', labelKey: 'dlg.seg.light', value: last.light });
    fields.push({
      type: 'choice', id: 'output', labelKey: 'dlg.seg.outputType', value: last.output,
      options: [
        { value: 'single', labelKey: 'dlg.seg.type.single' }, { value: 'tolerance', labelKey: 'dlg.seg.type.tolerance' },
        { value: 'segmented', labelKey: 'dlg.seg.type.segmented' }, { value: 'points', labelKey: 'dlg.seg.type.points' },
        { value: 'list', labelKey: 'dlg.seg.type.list' }, { value: 'count', labelKey: 'dlg.seg.type.count' }]
    });
    const build = (v) => ({
      prominence: Math.max(0, Number(v.prominence)), strict: !!v.strict, excludeEdges: !!v.excludeEdges, light: !!v.light,
      aboveLower: thr && v.aboveLower && !findsMinima(v.light, inverted) ? { lower: thr.lower } : null
    });
    const values = await api.dialog({
      title: api.tr('cmd.procFindMaxima'), fields, okLabel: api.tr('dlg.ok'),
      // "Preview point selection": the maxima as points over the visible region, at level 0, whatever output type is chosen
      preview: {
        compute: 'findMaxima',
        params: (v) => Object.assign(build(v), { preview: true }),
        overlay(res) {
          api.toast(res.approximate ? 'dlg.seg.previewCountApprox' : 'dlg.seg.previewCount', { n: res.count });
          const pts = new Array(res.points.length);
          for (let i = 0; i < pts.length; i++) pts[i] = res.points[i] + 0.5; // the centre of the pixel
          return res.count ? [{ kind: 'points', pts, color: '#ffff00' }] : null;
        }
      }
    });
    if (!values) return;
    // The dialog is non-modal (the menus stay usable): the run belongs to the image it was opened on.
    const now = api.state();
    if (!now.doc || now.doc.docId !== doc.docId) return;
    last.prominence = Math.max(0, Number(values.prominence));
    last.strict = !!values.strict;
    last.excludeEdges = !!values.excludeEdges;
    if (thr) last.aboveLower = !!values.aboveLower;
    last.light = !!values.light;
    last.output = values.output;
    const params = build(values);
    const opts = { docId: doc.docId, channel: ch, labelKey: 'op.findMaxima' };
    if (values.output === 'single' || values.output === 'tolerance' || values.output === 'segmented') {
      await api.run('findMaximaImage', Object.assign({ output: values.output }, params), { docId: doc.docId, channel: ch, labelKey: 'op.findMaximaImage' });
      return;
    }
    const res = await api.compute('findMaxima', params, opts);
    if (!res) return;
    if (values.output === 'count') { // `rt.addValue("Count", npoints)` — a row of the Results table
      api.addResults([{ Count: res.count }]);
    } else if (values.output === 'list') { // the X, Y of every maximum, in the order MaximumFinder finds them
      const rows = [];
      for (let i = 0; i < res.points.length; i += 2) rows.push([res.points[i], res.points[i + 1]]);
      api.openTable(api.tr('res.fmList'), ['X', 'Y'], rows);
    } else { // Point Selection: "if (imp!=null && npoints>0) imp.setRoi(new PointRoi(xyCoordinates))"
      if (res.count > IJRoiLimit) { // a selection keeps at most this many points (IJRoi.MAX_VERTS)
        api.toast('err.roiTooComplex');
        return;
      }
      if (res.count > 0) {
        const pts = [];
        for (let i = 0; i < res.points.length; i += 2) pts.push([res.points[i] + 0.5, res.points[i + 1] + 0.5]);
        api.setRoi({ type: 'point', points: pts }, { docId: doc.docId });
      }
      api.toast('dlg.seg.previewCount', { n: res.count });
    }
  }

  IJApp.extend({
    pkg: 'seg',
    errors: { IJ_SEG_NOT_BINARY: 'err.segNotBinary' },
    commands: [
      { id: 'procFindMaxima', menu: ['Process'], order: 40, long: true, run: findMaxima },
      { id: 'binOutline', menu: ['Process', 'Binary'], order: 60, enabled: is8, run: (api) => plain(api, 'segOutline', {}, 'op.segOutline') },
      { id: 'binSkeletonize', menu: ['Process', 'Binary'], order: 80, long: true, enabled: is8, run: (api) => plain(api, 'skeletonize', {}, 'op.skeletonize') },
      { id: 'binDistanceMap', menu: ['Process', 'Binary'], order: 90, separatorBefore: true, long: true, enabled: is8, run: (api) => distanceMap(api, 'edm') },
      { id: 'binUltimatePoints', menu: ['Process', 'Binary'], order: 100, long: true, enabled: is8, run: (api) => distanceMap(api, 'ultimatePoints') },
      { id: 'binWatershed', menu: ['Process', 'Binary'], order: 110, long: true, enabled: is8, run: (api) => plain(api, 'watershed', { output: 'overwrite' }, 'op.watershed') },
      { id: 'binVoronoi', menu: ['Process', 'Binary'], order: 120, long: true, enabled: is8, run: (api) => distanceMap(api, 'voronoi') }
    ]
  });
})();
