/* ij-cmds-coloc.js — menu command of package P7 (coloc): Analyze > Colocalization.
 *
 * Runs on the page only, before IJApp.mount. The computation is the compute op `coloc` of
 * ij-proc-coloc.js (the worker; cancellable, never on the main thread); this file asks the questions,
 * runs it and shows the answer: a table window (one row, the denominator of every Manders ratio named in its
 * header) and a plot window holding the 2D histogram of the two channels (log counts), the regression line
 * and the thresholds. Nothing is written to the images: no undo step, nothing to persist.
 *
 * ImageJ has no colocalisation command (Coloc 2 is Fiji): the dialog is this plugin's own; the ROI is the
 * selection of the first image (an area selection), applied to both images, which have the same size.
 */
(function () {
  'use strict';
  if (typeof IJApp === 'undefined' || typeof IJApp.extend !== 'function') return;

  const BINS = 256;

  const chName = (info, i) => {
    const c = info && info.channels ? info.channels[i] : null;
    return (i + 1) + (c && c.name ? ': ' + c.name : '');
  };
  const docInfo = (docs, id) => docs.find((d) => d.docId === id) || null;
  const cell = (v) => (v === null || v === undefined ? '' : v);

  // The window of one run: [columns, row]. ImageJ result column names stay English.
  function tableOf(res, p, i1, i2) {
    const den = res.denominator === 'above' ? 'sum ch above T' : 'sum ch, all ROI pixels';
    const columns = ['Image 1', 'Channel 1', 'Image 2', 'Channel 2', 'ROI pixels', 'Pearson r (all ROI pixels)', 'Pearson r (above T1 and T2)',
      'Pearson r (below T1 or T2)', 'M1 (sum ch1 where ch2>0 / sum ch1, all ROI pixels)', 'M2 (sum ch2 where ch1>0 / sum ch2, all ROI pixels)',
      'tM1 (sum ch1 above T1 and T2 / ' + den + ')', 'tM2 (sum ch2 above T1 and T2 / ' + den + ')', 'Overlap R', 'Li ICQ', 'T1', 'T2',
      'Pixels above T1 and T2', 'Orthogonal slope', 'Orthogonal intercept', 'Thresholds'];
    const mode = res.mode === 'costes' ? 'Costes (' + res.costes + ')' : (res.mode === 'manual' ? 'manual' : 'none (above zero)');
    const row = [i1.name, chName(i1, p.ch1), i2.name, chName(i2, p.ch2), res.n, res.pearsonAll, res.pearsonAbove, res.pearsonBelow, res.m1, res.m2,
      res.tm1, res.tm2, res.overlap, res.icq, res.t1, res.t2, res.nAbove, res.slope, res.intercept, mode].map(cell);
    return { columns, rows: [row] };
  }

  // The regression line and the threshold lines of the plot, clipped to the plotted box.
  function overlaysOf(res) {
    const out = [];
    const [x0, x1] = res.xRange, [y0, y1] = res.yRange;
    if (res.slope !== null && res.slope > 0 && res.intercept !== null) {
      const xa = Math.max(x0, (y0 - res.intercept) / res.slope), xb = Math.min(x1, (y1 - res.intercept) / res.slope);
      if (xa < xb) out.push({ kind: 'line', x1: xa, y1: res.slope * xa + res.intercept, x2: xb, y2: res.slope * xb + res.intercept, color: '#46c46f' });
    }
    if (res.mode !== 'none') {
      if (res.t1 !== null && res.t1 >= x0 && res.t1 <= x1) out.push({ kind: 'line', x1: res.t1, y1: y0, x2: res.t1, y2: y1, color: '#e0b43a' });
      if (res.t2 !== null && res.t2 >= y0 && res.t2 <= y1) out.push({ kind: 'line', x1: x0, y1: res.t2, x2: x1, y2: res.t2, color: '#e0b43a' });
    }
    return out;
  }

  function plotOf(api, res, p, i1, i2) {
    const data = Float32Array.from(res.hist);
    const bw = (res.xRange[1] - res.xRange[0]) / BINS, bh = (res.yRange[1] - res.yRange[0]) / BINS;
    const rows = [];
    for (let j = 0; j < BINS; j++) for (let i = 0; i < BINS; i++) {
      const c = res.hist[j * BINS + i];
      if (c > 0) rows.push([res.xRange[0] + (i + 0.5) * bw, res.yRange[0] + (j + 0.5) * bh, c]);
    }
    const l1 = i1.name + ' — ' + chName(i1, p.ch1), l2 = i2.name + ' — ' + chName(i2, p.ch2);
    return {
      title: api.tr('res.colocPlot', { a: i1.name, b: i2.name }), xLabel: l1, yLabel: l2, series: [],
      image: { w: BINS, h: BINS, data, logScale: true, lut: 'Fire', xRange: res.xRange.slice(), yRange: res.yRange.slice() },
      overlays: overlaysOf(res),
      csv: { columns: [l1, l2, 'count'], rows }
    };
  }

  async function runColoc(api) {
    const st = api.state();
    if (!st.doc) return;
    const docs = st.docs;
    const v = await api.dialog({
      title: api.tr('cmd.analyzeColocalization'),
      okLabel: api.tr('dlg.ok'),
      fields: [
        { type: 'doc', id: 'doc1', labelKey: 'dlg.coloc.image1' },
        { type: 'channel', id: 'ch1', labelKey: 'dlg.coloc.channel1', docField: 'doc1', value: 0 },
        { type: 'doc', id: 'doc2', labelKey: 'dlg.coloc.image2' },
        { type: 'channel', id: 'ch2', labelKey: 'dlg.coloc.channel2', docField: 'doc2', value: st.doc.channels.length > 1 ? 1 : 0 },
        { type: 'radio', id: 'mode', labelKey: 'dlg.coloc.thresholds', value: 'none', options: [
          { value: 'none', labelKey: 'dlg.coloc.thrNone' }, { value: 'manual', labelKey: 'dlg.coloc.thrManual' }, { value: 'costes', labelKey: 'dlg.coloc.thrCostes' }] },
        { type: 'number', id: 't1', labelKey: 'dlg.coloc.t1', value: 0, visibleIf: (x) => x.mode === 'manual' },
        { type: 'number', id: 't2', labelKey: 'dlg.coloc.t2', value: 0, visibleIf: (x) => x.mode === 'manual' },
        { type: 'check', id: 'excludeZero', labelKey: 'dlg.coloc.excludeZero', value: false },
        { type: 'radio', id: 'denominator', labelKey: 'dlg.coloc.denominator', value: 'all', options: [
          { value: 'all', labelKey: 'dlg.coloc.denAll' }, { value: 'above', labelKey: 'dlg.coloc.denAbove' }] },
        { type: 'message', id: 'note', labelKey: 'dlg.coloc.note' }
      ],
      validate(x) {
        const d1 = docInfo(docs, x.doc1), d2 = docInfo(docs, x.doc2), out = {};
        if (d1 && d2) {
          if (d1.width !== d2.width || d1.height !== d2.height) out.doc2 = 'err.sizeMismatch';
          else if (d1.bitDepth !== d2.bitDepth) out.doc2 = 'err.colocMixedDepth';
          else if (d1.docId === d2.docId && x.ch1 === x.ch2) out.ch2 = 'dlg.coloc.sameChannel';
        }
        return Object.keys(out).length ? out : null;
      }
    });
    if (!v) return;
    const same = v.doc1 === v.doc2;
    const params = {
      ch1: v.ch1, ch2: v.ch2, doc2: same ? null : v.doc2, mode: v.mode, t1: v.mode === 'manual' ? v.t1 : 0, t2: v.mode === 'manual' ? v.t2 : 0,
      excludeZero: !!v.excludeZero, denominator: v.denominator
    };
    const res = await api.compute('coloc', params, { docId: v.doc1, docIds: same ? undefined : [v.doc2], labelKey: 'op.coloc' });
    if (!res) return;
    const i1 = docInfo(docs, v.doc1), i2 = docInfo(docs, v.doc2);
    if (!i1 || !i2) return;
    if (res.costes === 'failed') api.toast('res.colocCostesFailed');
    if (res.negative) api.toast('res.colocNegative');
    const t = tableOf(res, params, i1, i2);
    api.openTable(api.tr('res.colocTable', { a: i1.name, b: i2.name }), t.columns, t.rows);
    api.openPlot(plotOf(api, res, params, i1, i2));
  }

  IJApp.extend({
    pkg: 'coloc',
    commands: [
      { id: 'analyzeColocalization', menu: ['Analyze'], order: 100, long: true, run: runColoc }
    ],
    errors: { IJ_COLOC_NO_PIXELS: 'err.colocNoPixels', IJ_COLOC_MIXED_DEPTH: 'err.colocMixedDepth' }
  });
})();
