/* ij-cmds-fiji.js — menu commands of package fiji (wave 3): Analyze Skeleton, Local Thickness, Fractal Box Count, Curve Fitting, Coloc 2,
 * Cell Counter. Runs on the page only, before IJApp.mount; talks to the app through the documented extension API (IJApp.EXT_API_MEMBERS) and to
 * the worker through the registry operations of ij-proc-fiji.js (analyzeSkeleton, skeletonTagged, localThickness, fractalBoxCount, curveFit,
 * cellMarkerValues) and ij-proc-coloc.js (coloc).
 *
 * Menus (PLAN-wave3 §1.2):  Analyze > Skeleton > Analyze Skeleton (2D/3D)    Analyze > Local Thickness > Local Thickness (complete process)
 *   Analyze > Tools > Fractal Box Count… / Curve Fitting…    Analyze > Colocalization > Coloc 2    Plugins > Analyze > Cell Counter > Cell Counter
 * Dialogs: the fields, labels and defaults Fiji / ImageJ have (tests/fixtures/ij-wave3/fiji-dialogs.json, PLAN-wave3 §1.5 / §10.2).
 *   Dropped on purpose (display only or no stacks): Coloc 2's "Show Save PDF Dialog", "Display Images in Result", "Display Shuffled Images";
 *   Cell Counter's "Keep Original" and "Show All" (they act on stacks); Curve Fitting's "Show settings" and the user-defined formula (macro language).
 *   Curve Fitting's "Apply" is built (op fitApply: a 32-bit "<name>-transformed" image, like Fitter.applyFunction).
 * Nothing here writes into an image: results go to the Results table, table / plot windows or new images; the Cell Counter's markers are
 * persistent annotations of the image (tag |CC|), not undo steps.
 */
(function () {
  'use strict';
  if (typeof IJApp === 'undefined' || typeof IJApp.extend !== 'function') return;

  const g = typeof self !== 'undefined' ? self : globalThis;
  const is8 = (st) => !!st.doc && !st.busy && st.doc.bitDepth === 8;
  const badType = () => Object.assign(new Error('bit depth'), { code: 'IJ_BAD_TYPE' });
  const docInfoOf = (st, id) => (st.docs || []).find((d) => d.docId === id) || null;
  const calOf = (info) => { const c = (info && info.calibration) || {}; return { pw: c.pixelWidth > 0 ? c.pixelWidth : 1, ph: c.pixelHeight > 0 ? c.pixelHeight : 1 }; };
  const channelOf = (st) => (Number.isInteger(st.activeChannel) && st.activeChannel >= 0 ? st.activeChannel : 0);
  // IJ.d2s(x, decimals)
  const d2s = (x, n) => (x === null || x === undefined || !isFinite(x) ? String(x) : x.toFixed(n));
  // ImagePlus.getShortTitle (ImagePlus.java:1176-1188): a title with a dot after position 0 loses everything from the LAST dot and its spaces;
  // otherwise it is cut at the first space
  const shortTitle = (name) => {
    let t = String(name || '').trim();
    const dot = t.lastIndexOf('.');
    if (dot > 0) return t.substring(0, dot).replace(/ /g, '');
    const sp = t.indexOf(' ');
    return sp > -1 ? t.substring(0, sp) : t;
  };
  // the Costes randomisation seed: journaled with the run; a fixed value when the browser has no crypto (never the clock)
  const seed31 = () => { try { return crypto.getRandomValues(new Uint32Array(1))[0] & 0x7fffffff; } catch (_) { return 0x1f3d5b79; } };

  // a DOM node: h('div', { class, text, value, type, title, on: { click } }, [children])
  function h(tag, props, kids) {
    const el = document.createElement(tag);
    const p = props || {};
    for (const k of Object.keys(p)) {
      const v = p[k];
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'on') for (const ev of Object.keys(v)) el.addEventListener(ev, v[ev]);
      else if (k === 'value' || k === 'checked' || k === 'disabled' || k === 'type' || k === 'title' || k === 'rows' || k === 'cols' || k === 'name') el[k] = v;
      else el.setAttribute(k, String(v));
    }
    for (const c of kids || []) if (c) el.appendChild(c);
    return el;
  }

  // ═════════════════════════ Analyze Skeleton ═════════════════════════
  const PRUNE = ['none', 'shortest', 'lowestVoxel', 'lowestBranch'];
  const PRUNE_KEYS = ['dlg.fiji.pruneNone', 'dlg.fiji.pruneShortest', 'dlg.fiji.pruneLowestVoxel', 'dlg.fiji.pruneLowestBranch'];

  async function runSkeleton(api) {
    const st = api.state();
    if (!st.doc) return;
    if (st.doc.bitDepth !== 8) throw badType();
    const v = await api.dialog({
      title: api.tr('dlg.fiji.skelTitle'), okLabel: api.tr('dlg.ok'),
      fields: [
        { type: 'message', id: 'secLoops', labelKey: 'dlg.fiji.skelLoops' },
        { type: 'choice', id: 'prune', labelKey: 'dlg.fiji.prune', value: 'none', options: PRUNE.map((value, i) => ({ value, labelKey: PRUNE_KEYS[i] })) },
        { type: 'message', id: 'secEnds', labelKey: 'dlg.fiji.skelEnds' },
        { type: 'check', id: 'pruneEnds', labelKey: 'dlg.fiji.pruneEnds', value: false },
        { type: 'check', id: 'excludeRoi', labelKey: 'dlg.fiji.excludeRoi', value: false },
        { type: 'message', id: 'secResults', labelKey: 'dlg.fiji.skelResults' },
        { type: 'check', id: 'shortestPath', labelKey: 'dlg.fiji.shortestPath', value: false },
        { type: 'check', id: 'detailed', labelKey: 'dlg.fiji.detailed', value: false },
        { type: 'check', id: 'labeled', labelKey: 'dlg.fiji.labeled', value: false }
      ]
    });
    if (!v) return;
    const cal = calOf(st.doc), ch = channelOf(st);
    const params = { prune: v.prune, pruneEnds: !!v.pruneEnds, excludeRoi: !!v.excludeRoi, shortestPath: !!v.shortestPath, detailed: !!v.detailed, labeled: !!v.labeled,
      ch, pixelWidth: cal.pw, pixelHeight: cal.ph };
    const opts = { docId: st.doc.docId, channel: ch };
    const res = await api.compute('analyzeSkeleton', params, Object.assign({ labelKey: 'op.analyzeSkeleton' }, opts));
    if (!res) return;
    // AnalyzeSkeleton_.showResults: `new ResultsTable()` … `rt.show("Results")`, which replaces what the Results table held
    api.addResults(res.rows.map((row) => { const o = {}; res.columns.forEach((c, i) => { o[c] = row[i]; }); return o; }), { replace: true });
    if (res.branchRows) api.openTable(api.tr('res.skeletonBranchInfo'), res.branchColumns, res.branchRows);
    // the images need the graph again (a separate worker request) but not the Branch information rows
    await api.run('skeletonTagged', Object.assign({}, params, { detailed: false }), Object.assign({ placement: 'tab', labelKey: 'op.skeletonTagged' }, opts));
  }

  // ═════════════════════════ Local Thickness ═════════════════════════
  async function runThickness(api) {
    const st = api.state();
    if (!st.doc) return;
    if (st.doc.bitDepth !== 8) throw badType();
    const v = await api.dialog({
      title: api.tr('dlg.fiji.ltTitle'), okLabel: api.tr('dlg.ok'),
      fields: [
        { type: 'number', id: 'threshold', labelKey: 'dlg.fiji.ltThreshold', value: 128, min: 1, max: 255, step: 1, integer: true },
        { type: 'check', id: 'inverse', labelKey: 'dlg.fiji.ltInverse', value: false }
      ]
    });
    if (!v) return;
    await api.run('localThickness', { threshold: v.threshold, inverse: !!v.inverse }, { docId: st.doc.docId, channel: channelOf(st), placement: 'tab', labelKey: 'op.localThickness' });
  }

  // ═════════════════════════ Fractal Box Count ═════════════════════════
  const BOX_DEFAULT = '2,3,4,6,8,12,16,32,64';
  // FractalBoxCounter keeps both fields in static fields: the next call of the session starts from what was confirmed
  const boxLast = { sizes: BOX_DEFAULT, blackBackground: false };
  async function runFractal(api) {
    const st = api.state();
    if (!st.doc) return;
    if (st.doc.bitDepth !== 8) throw badType();
    const parse = (s) => (g.IJFractal ? g.IJFractal.parseBoxSizes(s) : null);
    const v = await api.dialog({
      title: api.tr('dlg.fiji.fractalTitle'), okLabel: api.tr('dlg.ok'),
      fields: [
        { type: 'string', id: 'sizes', labelKey: 'dlg.fiji.boxSizes', value: boxLast.sizes },
        { type: 'check', id: 'blackBackground', labelKey: 'dlg.fiji.blackBackground', value: boxLast.blackBackground }
      ],
      validate(x) {
        const s = parse(x.sizes);
        if (!s || s.length < 1 || s.some((n) => n < 1 || n > 65536) || s.length > 64) return { sizes: 'dlg.fiji.boxSizesBad' };
        return null;
      }
    });
    if (!v) return;
    boxLast.sizes = String(v.sizes); boxLast.blackBackground = !!v.blackBackground;
    const ch = channelOf(st);
    const info = st.doc.channels && st.doc.channels[ch];
    // FractalBoxCounter.run: foreground = black background ? 255 : 0, flipped for an inverted LUT
    let foreground = v.blackBackground ? 255 : 0;
    if (info && info.display && info.display.invert) foreground = 255 - foreground;
    const boxSizes = parse(v.sizes);
    const res = await api.compute('fractalBoxCount', { boxSizes, foreground }, { docId: st.doc.docId, channel: ch, labelKey: 'op.fractalBoxCount' });
    if (!res) return;
    const row = { Label: shortTitle(st.doc.name) };
    res.sizes.forEach((s, i) => { row['C' + s] = res.counts[i]; });
    row.D = res.D;
    api.addResults([row]);
    api.openPlot({
      title: api.tr('res.fractalPlot'), xLabel: api.tr('res.fractalX'), yLabel: api.tr('res.fractalY'), text: 'D=' + d2s(res.D, 4),
      series: [{ kind: 'line', x: res.line.x, y: res.line.y, color: '#e53935' }, { kind: 'points', x: res.logSizes, y: res.logCounts, color: '#1e88e5' }],
      csv: { columns: ['size', 'count'], rows: res.sizes.map((s, i) => [s, res.counts[i]]) }
    });
  }

  // ═════════════════════════ Curve Fitting (panel) ═════════════════════════
  const FIT_DATA = '0.00  0.00\n1.00  0.90\n2.00  4.50\n3.00  8.00\n4.00  18.00\n5.00  24.00\n';   // Fitter: dx = {0,1,2,3,4,5}, dy = {0,.9,4.5,8,18,24}
  // Fitter.getData: tokens " \t\n\r,", at least two pairs, an even count; a token that is not a number is an error
  function parseFitData(text) {
    const toks = String(text).replace(/[^\n\t\x20-\x7e]/g, ' ').split(/[ \t\n\r,]+/).filter((t) => t.length > 0);
    if (toks.length < 4 || toks.length % 2 !== 0) return { error: 'dlg.fiji.fitDataCount' };
    const x = [], y = [];
    for (let i = 0; i < toks.length; i += 2) {
      const a = Number(toks[i].replace(/[fFdD]$/, '')), b = Number(toks[i + 1].replace(/[fFdD]$/, ''));
      if (!isFinite(a) || !isFinite(b) || /^0x/i.test(toks[i]) || /^0x/i.test(toks[i + 1])) return { error: 'dlg.fiji.fitDataBad', at: i / 2 };
      x.push(a); y.push(b);
    }
    return { x, y };
  }
  // IJ.d2s(x, decimals) with a negative count = DecimalFormat "0.00000E0"
  const d2sExp = (x, n) => x.toExponential(n).replace('e', 'E').replace('E+', 'E');
  // IJ.d2s(x, significantDigits, maxDigits) (IJ.java:1038-1050), used here as d2s(x, 5, 9)
  function d2s3(x, significantDigits, maxDigits) {
    if (!isFinite(x)) return String(x);
    const log10 = Math.log10(Math.abs(x));
    const roundErrorAtMax = 0.223 * Math.pow(10, -maxDigits);
    const magnitude = Math.ceil(log10 + roundErrorAtMax);
    let decimals = x === 0 ? 0 : maxDigits - magnitude;
    if (decimals < 0 || magnitude < significantDigits + 1 - maxDigits) return d2sExp(x, significantDigits);
    if (decimals > significantDigits) decimals = Math.max(significantDigits, decimals - maxDigits + significantDigits);
    return d2s(x, Math.min(9, decimals));
  }
  const sig = (x) => d2s3(x, 5, 9);

  function buildCurveFitter(el, papi) {
    const sorted = g.IJCurveFit ? g.IJCurveFit.SORTED_TYPES : [];
    const names = g.IJCurveFit ? g.IJCurveFit.FIT_LIST : [];
    const select = h('select', { class: 'ij-search' }, sorted.map((t) => { const o = h('option', { text: names[t] }); o.value = String(t); return o; }));
    const area = h('textarea', { rows: 15, cols: 30, class: 'ij-search' });
    area.value = FIT_DATA;
    area.style.fontFamily = 'monospace';
    const out = h('pre', { class: 'ij-info-pre', text: '' });
    let fitting = false, last = null;   // last = the fit Apply transforms an image with (Fitter's static cf / fitType)
    const fit = async () => {
      if (fitting) return;
      const data = parseFitData(area.value);
      if (data.error) { out.textContent = papi.tr(data.error, { n: (data.at || 0) + 1 }); return; }
      fitting = true;
      try {
        const fitType = Number(select.value);
        const res = await papi.compute('curveFit', { fitType, x: data.x, y: data.y, randomSeed: 0 }, { docless: true, labelKey: 'op.curveFit' });
        if (!res) return;
        last = null;
        if (!res.ok) { out.textContent = papi.tr('dlg.fiji.fitFailed', { reason: res.statusString }); return; }
        const letters = 'abcdefghi';
        const lines = [
          papi.tr('dlg.fiji.fitFormula') + ' ' + res.formula,
          papi.tr('dlg.fiji.fitStatus') + ' ' + res.statusString,
          // CurveFitter.getResultString: the minimizations line and "(max: …)" only when no linear regression was used
          ...(res.linearRegressionUsed ? [] : [papi.tr('dlg.fiji.fitMinimizations') + ' ' + res.completedMinimizations]),
          papi.tr('dlg.fiji.fitIterations') + ' ' + res.iterations + (res.linearRegressionUsed ? '' : ' (max: ' + res.maxIterations + ')'),
          papi.tr('dlg.fiji.fitSSE') + ' ' + sig(res.sumResidualsSqr),
          papi.tr('dlg.fiji.fitSD') + ' ' + sig(res.sd),
          'R^2: ' + d2s(res.rSquared, 5),
          papi.tr('dlg.fiji.fitParams')
        ];
        res.params.forEach((p, i) => lines.push('  ' + letters[i] + ' = ' + sig(p)));
        last = { fitType, params: res.params.slice() };
        out.textContent = lines.join('\n');
        papi.openPlot({
          title: res.formula, xLabel: 'X', yLabel: 'Y', text: res.name + '\nR^2 = ' + d2s(res.rSquared, 4),
          series: [{ kind: 'line', x: res.curve.x, y: res.curve.y, color: '#e53935', label: 'fit' }, { kind: 'points', x: data.x, y: data.y, color: '#1e88e5', label: 'data' }],
          csv: { columns: ['x', 'y', 'fit residual'], rows: data.x.map((xv, i) => [xv, data.y[i], res.residuals[i]]) }
        });
        papi.openPlot({
          title: papi.tr('res.fitResiduals', { name: res.name }), xLabel: 'X', yLabel: papi.tr('res.fitResidual'),
          series: [{ kind: 'bars', x: data.x, y: res.residuals, color: '#757575', label: 'residuals' }],
          csv: { columns: ['x', 'residual'], rows: data.x.map((xv, i) => [xv, res.residuals[i]]) }
        });
      } catch (err) { papi.error(err); } finally { fitting = false; }
    };
    const fitBtn = h('button', { class: 'ij-btn', type: 'button', text: papi.tr('dlg.fiji.fitFit'), on: { click: fit } });
    const applyBtn = h('button', { class: 'ij-btn', type: 'button', text: papi.tr('dlg.fiji.fitApply'), on: { click: async () => {
      try {
        const st = papi.state();
        if (!last) { papi.toast('dlg.fiji.fitNoFunction'); return; }
        if (!st.doc) { papi.toast('dlg.fiji.fitNoImage'); return; }
        await papi.run('fitApply', { fitType: last.fitType, params: last.params }, { docId: st.doc.docId, channel: channelOf(st), placement: 'tab', labelKey: 'op.fitApply' });
      } catch (err) { papi.error(err); }
    } } });
    const openBtn = h('button', { class: 'ij-btn', type: 'button', text: papi.tr('dlg.fiji.fitOpen'), on: { click: async () => {
      try {
        const files = await papi.pickFile({ accept: '.txt,.csv,.tsv,text/plain', multiple: false });
        if (!files || !files[0]) return;
        const text = await files[0].text();
        // Fitter.open: reads lines until one is longer than 100 characters
        const kept = [];
        for (const line of text.split(/\r?\n/)) { if (line.length > 100) break; kept.push(line); }
        area.value = kept.join('\n') + '\n';
      } catch (err) { papi.error(err); }
    } } });
    el.appendChild(h('div', { class: 'ij-row' }, [select, fitBtn, applyBtn, openBtn]));
    el.appendChild(h('div', { class: 'ij-row' }, [area]));
    el.appendChild(out);
    return { refresh() {}, dispose() {} };
  }

  async function runCurveFit(api) { await api.openPanel('curveFitter', { focus: true }); }

  // ═════════════════════════ Coloc 2 ═════════════════════════
  const COLOC_ROI_NONE = 'none', COLOC_ROI_1 = 'roi1', COLOC_ROI_2 = 'roi2', COLOC_ROI_MANAGER = 'manager';
  const MANDERS_COLUMNS = (c) => /^(M1|M2|tM1|tM2|Overlap R)/.test(c);

  // The Li et al. (2004) plot of one channel: the product of the differences from the means (PDM), averaged in the intensity bins of the
  // joint histogram, against that channel's intensity (bin centres).
  function liSeries(res, which) {
    const B = res.histBins, n1 = which === 1;
    const [x0, x1] = n1 ? res.xRange : res.yRange, [y0, y1] = n1 ? res.yRange : res.xRange;
    const bw = (x1 - x0) / B, bh = (y1 - y0) / B, ma = n1 ? res.mean1 : res.mean2, mb = n1 ? res.mean2 : res.mean1;
    const xs = [], ys = [];
    for (let i = 0; i < B; i++) {
      let cnt = 0, sum = 0;
      for (let j = 0; j < B; j++) {
        const c = n1 ? res.hist[j * B + i] : res.hist[i * B + j];
        if (!c) continue;
        cnt += c; sum += c * (y0 + (j + 0.5) * bh - mb);
      }
      if (cnt) { const xc = x0 + (i + 0.5) * bw; xs.push(xc); ys.push((xc - ma) * (sum / cnt)); }
    }
    return { x: xs, y: ys };
  }

  async function runColoc2(api) {
    const st = api.state();
    if (!st.doc) return;
    const docs = st.docs;
    const second = st.doc.channels.length > 1 ? 1 : 0;
    const v = await api.dialog({
      title: api.tr('cmd.colocColoc2'), okLabel: api.tr('dlg.ok'),
      fields: [
        { type: 'doc', id: 'doc1', labelKey: 'dlg.coloc.image1' },
        { type: 'channel', id: 'ch1', labelKey: 'dlg.fiji.colocChannel1', docField: 'doc1', value: 0 },
        { type: 'doc', id: 'doc2', labelKey: 'dlg.coloc.image2' },
        { type: 'channel', id: 'ch2', labelKey: 'dlg.fiji.colocChannel2', docField: 'doc2', value: second },
        { type: 'choice', id: 'roi', labelKey: 'dlg.fiji.colocRoi', value: COLOC_ROI_NONE, options: [
          { value: COLOC_ROI_NONE, labelKey: 'dlg.fiji.colocRoiNone' }, { value: COLOC_ROI_1, labelKey: 'dlg.fiji.colocRoi1' },
          { value: COLOC_ROI_2, labelKey: 'dlg.fiji.colocRoi2' }, { value: COLOC_ROI_MANAGER, labelKey: 'dlg.fiji.colocRoiManager' }
        ].concat(docs.map((d) => ({ value: 'doc:' + d.docId, label: d.name }))) },
        { type: 'choice', id: 'regression', labelKey: 'dlg.fiji.colocRegression', value: 'costes', options: [
          { value: 'costes', labelKey: 'dlg.fiji.colocCostes' }, { value: 'bisection', labelKey: 'dlg.fiji.colocBisection' }] },
        { type: 'message', id: 'algorithms', labelKey: 'dlg.fiji.colocAlgorithms' },
        { type: 'check', id: 'liHistCh1', labelKey: 'dlg.fiji.colocLiHist1', value: true },
        { type: 'check', id: 'liHistCh2', labelKey: 'dlg.fiji.colocLiHist2', value: true },
        { type: 'check', id: 'liIcq', labelKey: 'dlg.fiji.colocLiIcq', value: true },
        { type: 'check', id: 'spearman', labelKey: 'dlg.fiji.colocSpearman', value: true },
        { type: 'check', id: 'manders', labelKey: 'dlg.fiji.colocManders', value: true },
        { type: 'check', id: 'kendall', labelKey: 'dlg.fiji.colocKendall', value: true },
        { type: 'check', id: 'hist2d', labelKey: 'dlg.fiji.colocHist2d', value: true },
        { type: 'check', id: 'costesTest', labelKey: 'dlg.fiji.colocCostesTest', value: true },
        { type: 'number', id: 'psf', labelKey: 'dlg.fiji.colocPsf', value: 3, min: 0.5, max: 100, step: 0.5, decimals: 1, enabledIf: (x) => !!x.costesTest },
        { type: 'number', id: 'randomisations', labelKey: 'dlg.fiji.colocRandomisations', value: 10, min: 1, max: 1000, step: 1, integer: true, enabledIf: (x) => !!x.costesTest }
      ],
      validate(x) {
        const d1 = docInfoOf(st, x.doc1), d2 = docInfoOf(st, x.doc2), out = {};
        if (d1 && d2) {
          if (d1.width !== d2.width || d1.height !== d2.height) out.doc2 = 'err.sizeMismatch';
          else if (d1.bitDepth !== d2.bitDepth) out.doc2 = 'err.colocMixedDepth';
          else if (d1.docId === d2.docId && x.ch1 === x.ch2) out.ch2 = 'dlg.coloc.sameChannel';
        }
        if (x.roi === COLOC_ROI_1 && (!st.roi || st.doc.docId !== x.doc1)) out.roi = 'dlg.fiji.colocRoiNotActive';
        if (x.roi === COLOC_ROI_2 && (!st.roi || st.doc.docId !== x.doc2)) out.roi = 'dlg.fiji.colocRoiNotActive';
        if (x.roi === COLOC_ROI_MANAGER && !api.roiManager.list().some((e) => e.docId === x.doc1)) out.roi = 'dlg.fiji.colocRoiManagerEmpty';
        if (typeof x.roi === 'string' && x.roi.indexOf('doc:') === 0) {
          const md = docInfoOf(st, x.roi.slice(4));
          if (md && d1 && (md.width !== d1.width || md.height !== d1.height)) out.roi = 'err.sizeMismatch';
          else if (md && md.bitDepth !== 8) out.roi = 'dlg.fiji.colocMaskType';
        }
        return Object.keys(out).length ? out : null;
      }
    });
    if (!v) return;
    const same = v.doc1 === v.doc2;
    const params = { ch1: v.ch1, ch2: v.ch2, doc2: same ? null : v.doc2, mode: 'costes', search: v.regression === 'bisection' ? 'bisection' : 'scan', t1: 0, t2: 0,
      excludeZero: false, denominator: 'above', roundT2: true, spearman: !!v.spearman, kendall: !!v.kendall };
    const seed = seed31();
    if (v.costesTest) params.costes = { psf: v.psf, n: v.randomisations, seed };
    const docIds = [];
    if (!same) docIds.push(v.doc2);
    let roi;
    if (v.roi === COLOC_ROI_1 || v.roi === COLOC_ROI_2) roi = st.roi;
    else if (v.roi === COLOC_ROI_MANAGER) {
      // the first selected entry of the ROI Manager that belongs to image 1 (else the first entry of image 1)
      const list = api.roiManager.list(), sel = api.roiManager.selected();
      const pick = sel.map((i) => list[i]).find((e) => e && e.docId === v.doc1) || list.find((e) => e.docId === v.doc1);
      roi = pick ? pick.roi : undefined;
    } else if (typeof v.roi === 'string' && v.roi.indexOf('doc:') === 0) { params.maskDoc = v.roi.slice(4); docIds.push(params.maskDoc); }
    const opts = { docId: v.doc1, docIds: docIds.length ? docIds : undefined, labelKey: 'op.coloc' };
    // compute() reads opts.roi (undefined = the selection of the image): <None>, a mask image and an empty ROI Manager pick must NOT fall back to it
    opts.roi = roi || null;
    const res = await api.compute('coloc', params, opts);
    if (!res) return;
    const i1 = docInfoOf(api.state(), v.doc1), i2 = docInfoOf(api.state(), v.doc2);
    if (!i1 || !i2) return;
    if (res.costes === 'failed') api.toast('res.colocCostesFailed');
    if (res.negative) api.toast('res.colocNegative');
    const ui = g.IJColocUi;
    const t = ui.tableOf(res, params, i1, i2);
    const keep = t.columns.map((c, i) => ({ c, i })).filter(({ c }) => !(v.manders === false && MANDERS_COLUMNS(c)) && !(v.liIcq === false && c === 'Li ICQ'));
    let columns = keep.map((k) => k.c), row = keep.map((k) => t.rows[0][k.i]);
    columns.push('Threshold regression'); row.push(v.regression === 'bisection' ? 'Bisection' : 'Costes');
    columns.push('Pearson r (above T1 or T2)'); row.push(ui.cell(res.pearsonAboveOr));
    if (v.manders) {   // Coloc 2's thresholded Manders coefficients: the sum of one channel where the OTHER is above its threshold
      columns.push("Manders' tM1 (Above autothreshold of Ch2)", "Manders' tM2 (Above autothreshold of Ch1)");
      row.push(ui.cell(res.tm1Coloc2), ui.cell(res.tm2Coloc2));
    }
    if (v.spearman) { columns.push("Spearman's rank correlation value", "Spearman's correlation t-statistic", 't-statistic degrees of freedom'); row.push(ui.cell(res.spearman), ui.cell(res.spearmanT), ui.cell(res.spearmanDf)); }
    if (v.kendall) { columns.push("Kendall's Tau-b rank correlation value"); row.push(ui.cell(res.kendall)); }
    if (v.costesTest) {
      columns.push('Costes P-Value', 'Costes Shuffled Mean', 'Costes Shuffled Std.D.', 'Ratio of rand. Pearsons >= actual Pearsons value', 'Costes randomisations', 'PSF');
      row.push(ui.cell(res.costesP), ui.cell(res.costesMean), ui.cell(res.costesSd), ui.cell(res.costesRatioGE), res.costesN, v.psf);
    }
    api.openTable(api.tr('res.colocTable', { a: i1.name, b: i2.name }), columns, [row]);
    if (v.hist2d) api.openPlot(ui.plotOf(api, res, params, i1, i2));
    for (const which of [1, 2]) {
      if (!(which === 1 ? v.liHistCh1 : v.liHistCh2)) continue;
      const s = liSeries(res, which), info = which === 1 ? i1 : i2;
      api.openPlot({
        title: api.tr('res.colocLiPlot', { n: which, name: info.name }), xLabel: api.tr('res.colocLiX', { n: which }), yLabel: 'PDM', series: [{ kind: 'points', x: s.x, y: s.y, color: '#1e88e5' }],
        csv: { columns: [api.tr('res.colocLiX', { n: which }), 'PDM'], rows: s.x.map((x, i) => [x, s.y[i]]) }
      });
    }
  }

  // ═════════════════════════ Cell Counter ═════════════════════════
  const CC_TAG = '|CC|';
  // The colour order of the counter's types: blue, green, magenta, red, cyan, orange, pink, yellow (Fiji's own cycle of eight).
  const CC_COLORS = ['#0000ff', '#00ff00', '#ff00ff', '#ff0000', '#00ffff', '#ffc800', '#ffafaf', '#ffff00'];
  const CC_COLOR_NAMES = [['red', '#ff0000'], ['green', '#00ff00'], ['blue', '#0000ff'], ['magenta', '#ff00ff'], ['cyan', '#00ffff'], ['yellow', '#ffff00'],
    ['orange', '#ffc800'], ['black', '#000000'], ['white', '#ffffff'], ['gray', '#808080'], ['lightgray', '#c0c0c0'], ['darkgray', '#404040'], ['pink', '#ffafaf']];
  const CC_MAX_TYPES = 20, CC_MAX_MARKERS = 100000;
  const CC = {
    docId: null, current: 1, deleteMode: false, showNumbers: true,
    types: Array.from({ length: 8 }, (_, i) => ({ name: 'Type ' + (i + 1), color: CC_COLORS[i % 8] })),
    ui: null, order: new Map()
  };
  const ccSave = (api) => { try { return api.sessionData.set('fiji', { cellCounter: { docId: CC.docId, current: CC.current, types: CC.types, showNumbers: CC.showNumbers } }); } catch (_) { return null; } };
  function ccLoad(api) {
    let d = null;
    try { d = api.sessionData.get('fiji'); } catch (_) { d = null; }
    const c = d && d.cellCounter;
    if (!c) return;
    if (Array.isArray(c.types) && c.types.length >= 1 && c.types.length <= CC_MAX_TYPES && c.types.every((t) => t && typeof t.name === 'string' && /^#[0-9a-f]{6}$/i.test(t.color))) CC.types = c.types.map((t) => ({ name: t.name.slice(0, 60), color: t.color }));
    if (Number.isInteger(c.current) && c.current >= 1 && c.current <= CC.types.length) CC.current = c.current;
    if (typeof c.showNumbers === 'boolean') CC.showNumbers = c.showNumbers;
    if (typeof c.docId === 'string' || Number.isInteger(c.docId)) CC.docId = c.docId;
  }
  const ccMarkers = (api) => (CC.docId === null ? [] : api.annotations.get(CC.docId).items.filter((i) => i.tag === CC_TAG && i.kind === 'marker'));
  const ccCounts = (api) => { const c = CC.types.map(() => 0); for (const m of ccMarkers(api)) if (m.type >= 1 && m.type <= c.length) c[m.type - 1]++; return c; };
  const ccItem = (x, y, type) => ({ kind: 'marker', x, y, type, color: CC.types[type - 1].color, label: CC.showNumbers, tag: CC_TAG });
  const ccRefreshUi = () => { if (CC.ui) CC.ui(); };

  // the XML Fiji's counter writes and reads (sc.fiji.cellCounter.WriteXML / ReadXML): CellCounter_Marker_File
  const xmlEsc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const xmlUnesc = (s) => String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
  function ccWriteXml(imageName, types, markers, current) {
    const L = [];
    const ind = (d) => (d === 0 ? '' : ' '.repeat(1 + 4 * (d - 1)));
    L.push('<?xml version="1.0" encoding="UTF-8"?>', '<CellCounter_Marker_File>', ind(1) + '<Image_Properties>', ind(2) + '<Image_Filename>' + xmlEsc(imageName) + '</Image_Filename>',
      ind(1) + '</Image_Properties>', ind(1) + '<Marker_Data>', ind(2) + '<Current_Type>' + current + '</Current_Type>');
    types.forEach((t, i) => {
      L.push(ind(2) + '<Marker_Type>', ind(3) + '<Type>' + (i + 1) + '</Type>', ind(3) + '<Name>' + xmlEsc(t.name) + '</Name>');
      for (const m of markers) {
        if (m.type !== i + 1) continue;
        L.push(ind(3) + '<Marker>', ind(4) + '<MarkerX>' + m.x + '</MarkerX>', ind(4) + '<MarkerY>' + m.y + '</MarkerY>', ind(4) + '<MarkerZ>1</MarkerZ>', ind(3) + '</Marker>');
      }
      L.push(ind(2) + '</Marker_Type>');
    });
    L.push(ind(1) + '</Marker_Data>', '</CellCounter_Marker_File>', '');
    return L.join('\n');
  }
  // Returns { types: [{ name }], markers: [{ x, y, type }], current } or throws { code: 'IJ_FIJI_BAD_XML' }
  function ccReadXml(text) {
    const bad = () => Object.assign(new Error('xml'), { code: 'IJ_FIJI_BAD_XML' });
    const s = String(text);
    if (s.length > 64 * 1048576 || s.indexOf('<CellCounter_Marker_File') < 0) throw bad();
    const tagOf = (src, name) => { const m = new RegExp('<' + name + '>([\\s\\S]*?)</' + name + '>').exec(src); return m ? m[1].trim() : null; };
    const cur = tagOf(s, 'Current_Type');
    const types = [], markers = [];
    const rx = /<Marker_Type>([\s\S]*?)<\/Marker_Type>/g;
    let m;
    while ((m = rx.exec(s)) !== null) {
      const typeNo = Number(tagOf(m[1], 'Type'));
      if (!Number.isInteger(typeNo) || typeNo < 1 || typeNo > CC_MAX_TYPES) throw bad();
      const name = tagOf(m[1], 'Name');
      types[typeNo - 1] = { name: name === null ? 'Type ' + typeNo : xmlUnesc(name).slice(0, 60) };
      const mr = /<Marker>([\s\S]*?)<\/Marker>/g;
      let k;
      while ((k = mr.exec(m[1])) !== null) {
        const x = Number(tagOf(k[1], 'MarkerX')), y = Number(tagOf(k[1], 'MarkerY'));
        if (!Number.isFinite(x) || !Number.isFinite(y)) throw bad();
        markers.push({ x: Math.round(x), y: Math.round(y), type: typeNo });
        if (markers.length > CC_MAX_MARKERS) throw bad();
      }
    }
    if (!types.length) throw bad();
    for (let i = 0; i < types.length; i++) if (!types[i]) types[i] = { name: 'Type ' + (i + 1) };
    const current = cur !== null && Number.isInteger(Number(cur)) ? Number(cur) : 1;
    return { types, markers, current: Math.min(Math.max(1, current), types.length) };
  }

  // The image as displayed (1:1) with the counter's markers on it: a coloured cross and the type number beside it (Fiji's counter overlay).
  async function ccMarkedPng(api, docId, markers) {
    const blob = await api.renderPng(docId, {});
    if (!markers.length || typeof document === 'undefined') return blob;
    const bmp = await createImageBitmap(blob);
    const cv = document.createElement('canvas');
    cv.width = bmp.width; cv.height = bmp.height;
    const c = cv.getContext('2d');
    c.drawImage(bmp, 0, 0);
    if (bmp.close) bmp.close();
    const arm = Math.max(3, Math.round(Math.max(cv.width, cv.height) / 160)), fs = Math.max(9, arm * 3);
    c.lineWidth = Math.max(1, Math.round(arm / 3));
    c.font = fs + 'px sans-serif';
    c.textBaseline = 'middle';
    for (const m of markers) {
      const x = m.x + 0.5, y = m.y + 0.5;
      c.strokeStyle = m.color;
      c.beginPath(); c.moveTo(x - arm, y); c.lineTo(x + arm, y); c.moveTo(x, y - arm); c.lineTo(x, y + arm); c.stroke();
      if (m.label) { c.fillStyle = m.color; c.fillText(String(m.type), x + arm + 2, y); }
    }
    return new Promise((resolve, reject) => cv.toBlob((b) => (b ? resolve(b) : reject(Object.assign(new Error('png'), { code: 'IJ_PNG_FAILED' }))), 'image/png'));
  }

  function buildCellCounter(el, papi) {
    ccLoad(papi);
    const rows = [], radios = [];
    const status = h('div', { class: 'ij-note', text: '' });
    const rowsBox = h('div', { class: 'ij-list' });
    const draw = () => {
      rowsBox.children.length = 0;
      rows.length = 0; radios.length = 0;
      const counts = ccCounts(papi);
      CC.types.forEach((t, i) => {
        const radio = h('input', { type: 'radio', name: 'cc-type' });
        radio.checked = CC.current === i + 1;
        radio.addEventListener('change', () => { CC.current = i + 1; ccSave(papi); });
        const sw = h('span', { class: 'ij-swatch' });
        sw.style.background = t.color;
        const cnt = h('input', { type: 'text', class: 'ij-search' });
        cnt.value = String(counts[i]);
        cnt.disabled = true;
        cnt.style.width = '4em';
        rows.push(cnt); radios.push(radio);
        rowsBox.appendChild(h('div', { class: 'ij-list-row' }, [radio, sw, h('span', { text: t.name }), cnt]));
      });
      status.textContent = CC.docId === null ? papi.tr('dlg.fiji.ccNotInitialized') : papi.tr('dlg.fiji.ccBoundTo', { name: (docInfoOf(papi.state(), CC.docId) || {}).name || '' });
    };
    CC.ui = draw;
    const need = () => {
      if (CC.docId === null || !docInfoOf(papi.state(), CC.docId)) { papi.toast('dlg.fiji.ccNotInitialized'); return false; }
      return true;
    };
    const button = (key, fn) => h('button', { class: 'ij-btn', type: 'button', text: papi.tr(key), on: { click: () => { Promise.resolve().then(fn).catch((err) => papi.error(err)); } } });
    const setMarkers = (items) => { papi.annotations.set(CC.docId, items, { tag: CC_TAG }); ccRefreshUi(); };

    const initialize = () => {
      const st = papi.state();
      if (!st.doc) return;
      CC.docId = st.doc.docId;
      ccSave(papi);
      try { papi.setTool('counter'); } catch (_) { /* a tool the toolbar lacks */ }
      papi.annotations.setVisible(CC.docId, true);
      ccRefreshUi();
    };
    const add = () => {
      if (CC.types.length >= CC_MAX_TYPES) return;
      const i = CC.types.length;
      CC.types.push({ name: 'Type ' + (i + 1), color: CC_COLORS[i % 8] });
      ccSave(papi); ccRefreshUi();
    };
    const remove = () => {
      if (CC.types.length <= 1) return;
      const n = CC.types.length;
      if (CC.docId !== null) setMarkers(ccMarkers(papi).filter((m) => m.type !== n));
      CC.types.pop();
      if (CC.current > CC.types.length) CC.current = CC.types.length;
      ccSave(papi); ccRefreshUi();
    };
    const rename = async () => {
      const v = await papi.dialog({ title: papi.tr('dlg.fiji.ccRename'), okLabel: papi.tr('dlg.ok'), fields: [{ type: 'string', id: 'name', labelKey: 'dlg.fiji.ccName', value: CC.types[CC.current - 1].name }],
        validate: (x) => (String(x.name).trim() ? null : { name: 'dlg.fiji.ccNameEmpty' }) });
      if (!v) return;
      CC.types[CC.current - 1].name = String(v.name).trim().slice(0, 60);
      ccSave(papi); ccRefreshUi();
    };
    const del = () => {   // the last marker added of the selected type
      if (!need()) return;
      const items = ccMarkers(papi);
      let last = -1;
      items.forEach((m, i) => { if (m.type === CC.current) last = i; });
      if (last < 0) return;
      setMarkers(items.filter((_, i) => i !== last));
    };
    const options = async () => {
      const t = CC.types[CC.current - 1];
      const cur = (CC_COLOR_NAMES.find((c) => c[1] === t.color) || [null])[0];
      const v = await papi.dialog({ title: papi.tr('dlg.fiji.ccOptions'), okLabel: papi.tr('dlg.ok'), fields: [
        { type: 'choice', id: 'color', labelKey: 'dlg.fiji.ccColor', value: cur || 'red', options: CC_COLOR_NAMES.map(([value]) => ({ value, label: value })) }] });
      if (!v) return;
      t.color = (CC_COLOR_NAMES.find((c) => c[0] === v.color) || CC_COLOR_NAMES[0])[1];
      ccSave(papi);
      if (CC.docId !== null) setMarkers(ccMarkers(papi).map((m) => (m.type === CC.current ? Object.assign({}, m, { color: t.color }) : m)));
      ccRefreshUi();
    };
    const results = () => {
      if (!need()) return;
      const counts = ccCounts(papi);
      papi.openTable(papi.tr('res.cellCounterResults'), ['Slice'].concat(CC.types.map((t) => t.name)), [[1].concat(counts)]);
    };
    const reset = () => { if (CC.docId !== null) setMarkers([]); ccRefreshUi(); };
    const saveMarkers = async () => {
      if (!need()) return;
      const info = docInfoOf(papi.state(), CC.docId);
      const markers = ccMarkers(papi);
      await papi.saveFile(shortTitle(info.name) + '.xml', 'application/xml', '.xml', 'XML', async () => new Blob([ccWriteXml(shortTitle(info.name) + '.tif', CC.types, markers, CC.current)], { type: 'application/xml' }));
    };
    const loadMarkers = async () => {
      if (!need()) return;
      const files = await papi.pickFile({ accept: '.xml,text/xml,application/xml', multiple: false });
      if (!files || !files[0]) return;
      const data = ccReadXml(await files[0].text());
      CC.types = data.types.map((t, i) => ({ name: t.name, color: (CC.types[i] && CC.types[i].color) || CC_COLORS[i % 8] }));
      CC.current = data.current;
      setMarkers(data.markers.map((m) => ccItem(m.x, m.y, m.type)));
      ccSave(papi);
    };
    const exportImage = async () => {
      if (!need()) return;
      const info = docInfoOf(papi.state(), CC.docId);
      // renderPng draws the pixels only (annotations live on the overlay canvas): the |CC| markers are painted here, at image scale
      await papi.saveFile(shortTitle(info.name) + '-markers.png', 'image/png', '.png', 'PNG', async () => ccMarkedPng(papi, CC.docId, ccMarkers(papi)));
    };
    const measure = async () => {
      if (!need()) return;
      const items = ccMarkers(papi);
      if (!items.length) return;
      const pts = [];
      for (const m of items) pts.push(m.x, m.y);
      const res = await papi.compute('cellMarkerValues', { points: pts }, { docId: CC.docId, labelKey: 'op.cellMarkerValues' });
      if (!res) return;
      papi.openTable(papi.tr('res.cellCounterMeasure'), ['Type', 'X', 'Y'].concat(res.channels), items.map((m, i) => [CC.types[m.type - 1].name, m.x, m.y].concat(res.values[i].map((v) => (v === null ? '' : v)))));
    };
    const check = (key, value, on) => {
      const box = h('input', { type: 'checkbox' });
      box.checked = value;
      box.addEventListener('change', () => on(!!box.checked));
      return h('label', { class: 'ij-check' }, [box, h('span', { text: papi.tr(key) })]);
    };
    draw();
    el.appendChild(rowsBox);
    el.appendChild(h('div', { class: 'ij-row' }, [button('dlg.fiji.ccInitialize', initialize), button('dlg.fiji.ccAdd', add), button('dlg.fiji.ccRemove', remove), button('dlg.fiji.ccRename', rename)]));
    el.appendChild(h('div', { class: 'ij-row' }, [button('dlg.fiji.ccDelete', del), check('dlg.fiji.ccDeleteMode', CC.deleteMode, (b) => { CC.deleteMode = b; }), button('dlg.fiji.ccOptions', options)]));
    el.appendChild(h('div', { class: 'ij-row' }, [button('dlg.fiji.ccResults', results), button('dlg.fiji.ccReset', reset), check('dlg.fiji.ccShowNumbers', CC.showNumbers, (b) => {
      CC.showNumbers = b; ccSave(papi);
      if (CC.docId !== null) setMarkers(ccMarkers(papi).map((m) => Object.assign({}, m, { label: b })));
    })]));
    el.appendChild(h('div', { class: 'ij-row' }, [button('dlg.fiji.ccSaveMarkers', saveMarkers), button('dlg.fiji.ccLoadMarkers', loadMarkers), button('dlg.fiji.ccExportImage', exportImage), button('dlg.fiji.ccMeasure', measure)]));
    el.appendChild(status);
    let curTool = null;
    const offTool = papi.on('tool', (id) => { curTool = id; });
    const off = papi.on('doc', (e) => { if (e && (e.kind === 'closed' || e.kind === 'renamed' || e.kind === 'opened')) { if (e.kind === 'closed' && e.docId === CC.docId) { CC.docId = null; ccSave(papi); } ccRefreshUi(); } });
    return {
      refresh() { ccRefreshUi(); },
      dispose() {
        off();
        CC.ui = null;
        offTool();
        // leave the counter tool only when it is still the active one (the user may have picked another)
        try { if (curTool === 'counter') papi.setTool('rect'); } catch (_) { /* nothing to restore */ }
      }
    };
  }

  // the toolbar tool of the counter: a click adds a marker of the selected type, or (Delete Mode) removes the nearest one
  function counterPointer(api, ev) {
    if (ev.type !== 'down' || (ev.button !== undefined && ev.button !== 0)) return;
    if (CC.docId === null || ev.docId !== CC.docId) return;
    const x = Math.floor(ev.x), y = Math.floor(ev.y);
    const items = ccMarkers(api);
    if (CC.deleteMode) {
      let zoom = 1;
      try { const v = api.view(ev.docId); if (v) zoom = v.getView().zoom || 1; } catch (_) { zoom = 1; }
      const radius = Math.max(3, 10 / zoom);
      let best = -1, bd = radius * radius;
      items.forEach((m, i) => { const d = (m.x - ev.x) ** 2 + (m.y - ev.y) ** 2; if (d <= bd) { bd = d; best = i; } });
      if (best >= 0) { api.annotations.set(CC.docId, items.filter((_, i) => i !== best), { tag: CC_TAG }); ccRefreshUi(); }
      return;
    }
    if (items.length >= CC_MAX_MARKERS) return;
    api.annotations.add(CC.docId, [ccItem(x, y, CC.current)]);
    ccRefreshUi();
  }

  async function runCellCounter(api) { await api.openPanel('cellCounter', { focus: true }); }

  IJApp.extend({
    pkg: 'fiji',
    commands: [
      { id: 'skelAnalyze', menu: ['Analyze', 'Skeleton'], order: 10, long: true, enabled: is8, run: runSkeleton },
      { id: 'ltComplete', menu: ['Analyze', 'LocalThickness'], order: 10, long: true, enabled: is8, run: runThickness },
      { id: 'toolsFractalBoxCount', menu: ['Analyze', 'Tools'], order: 20, enabled: is8, run: runFractal },
      { id: 'toolsCurveFitting', menu: ['Analyze', 'Tools'], order: 40, run: runCurveFit },
      { id: 'colocColoc2', menu: ['Analyze', 'Colocalization'], order: 10, long: true, run: runColoc2 },
      { id: 'pluginsCellCounter', menu: ['Plugins', 'Analyze', 'CellCounter'], order: 10, run: runCellCounter }
    ],
    panels: {
      curveFitter: { titleKey: 'dlg.fiji.curveFitterTitle', build: buildCurveFitter, defaultSize: { w: 360, h: 420 } },
      cellCounter: { titleKey: 'dlg.fiji.cellCounterTitle', build: buildCellCounter, persist: true, defaultSize: { w: 320, h: 460 } }
    },
    tools: [{ id: 'counter', labelKey: 'tool.counter', icon: 'crosshair', cursor: 'crosshair', hidden: true, onPointer: counterPointer }],
    errors: {
      IJ_FIJI_NO_FOREGROUND: 'err.fijiNoForeground', IJ_FIJI_NOT_BINARY: 'err.fijiNotBinary', IJ_FIJI_EMPTY: 'err.fijiEmpty', IJ_FIJI_NO_SKELETON: 'err.fijiNoSkeleton',
      IJ_FIJI_NO_BACKGROUND: 'err.fijiNoBackground', IJ_FIJI_KENDALL_TOO_LARGE: 'err.fijiKendallTooLarge', IJ_FIJI_BAD_XML: 'err.fijiBadXml'
    }
  });

  g.IJFijiUi = { fitNumber: sig, parseFitData, ccWriteXml, ccReadXml, liSeries, CC_COLORS };
})();
