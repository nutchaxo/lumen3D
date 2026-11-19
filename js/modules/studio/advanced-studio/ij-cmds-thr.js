/* ij-cmds-thr.js — menu commands of package thr (wave 3): Image › Adjust › Auto Threshold / Auto Local Threshold,
 * Process › Binary › Make Binary / Median / Options.
 *
 * Page only, runs before IJApp.mount. Each command talks to the extension API (`api`) and nothing else; the operations
 * they call (autoThresholdLevel, autoThreshold, autoThresholdMask, autoThresholdTryAll, autoLocalThreshold,
 * autoLocalThresholdTryAll, binaryMedian, and the v1 `binary` op) are registered by ij-proc-thr.js / ij-engine.js.
 *
 * Dialogs are Fiji's (tests/fixtures/ij-wave3/fiji-dialogs.json): labels, choice lists and defaults as captured, "Try all"
 * the default method. Binary Options is ij.plugin.filter.Binary.showDialog (Binary.java:52-88): iterations, count, Black
 * background, Pad edges when eroding, EDM output, Do:, Preview. ImageJ keeps `iterations` in a static field (one run of the
 * program: `api.sessionData` here), `count`, Black background and Pad edges in Prefs (the settings `thr.count`,
 * `thr.blackBackground`, default TRUE as Fiji ships, `thr.padEdges`); the Process › Binary commands read them. EDM output is a
 * static field in ImageJ too, but the Process › Binary › EDM commands of package seg read the setting `thr.edmOutput`
 * (ij-cmds-seg.js `edmChoice`), so it stays a setting.
 *
 * API gaps and deviations (PLAN-wave3 rules 1 and 13), reported to the orchestrator:
 *  - "Show threshold values in log window": the Studio has no Log window (no `api.log`); the values go to the status bar.
 *  - Fiji's dialog of a multichannel image adds "Stack" and "Use stack histogram" (fiji-dialogs.json); §10.2 says nothing about
 *    them, so none is offered: the active channel is thresholded.
 *  - "SetThreshold instead of Threshold" on a 16-bit image sets the range on the 16-bit image (Fiji first turns the image into 8-bit
 *    grey values and sets the range there): the 16-bit data are kept.
 */
(function () {
  'use strict';
  if (typeof IJApp === 'undefined' || typeof IJApp.extend !== 'function') return;

  const has = (st) => !!st.doc && !st.busy;
  const is8 = (st) => has(st) && st.doc.bitDepth === 8;
  const thrError = (code) => { const e = new Error(code); e.code = code; return e; };

  const FIJI_METHODS = ['Default', 'Huang', 'Huang2', 'Intermodes', 'IsoData', 'Li', 'MaxEntropy', 'Mean', 'MinError(I)', 'Minimum',
    'Moments', 'Otsu', 'Percentile', 'RenyiEntropy', 'Shanbhag', 'Triangle', 'Yen'];
  const LOCAL_METHODS = ['Bernsen', 'Contrast', 'Mean', 'Median', 'MidGrey', 'Niblack', 'Otsu', 'Phansalkar', 'Sauvola'];
  const TRY_ALL = 'Try all';

  // ImageJ keeps the last dialog values in static fields (here: for the session; Repeat Command re-opens the dialog with them).
  const last = {
    at: { method: TRY_ALL, ignoreBlack: false, ignoreWhite: false, white: true, setThreshold: false, showValues: false },
    alt: { method: TRY_ALL, radius: 15, parameter1: 0, parameter2: 0, white: true }
  };

  const methodOptions = (names) => [{ value: TRY_ALL, labelKey: 'dlg.thr.tryAll' }].concat(names.map((m) => ({ value: m, label: m })));

  // "Try all": a labelled montage, one panel per method. The layout is the op's (IJThr.tryAllLayout); the name of each panel is a text item of the
  // image's annotations (page-drawn: crisp at any zoom, no font burned into pixels), tagged so a second run replaces it.
  function labelPanels(api, docId, srcDoc, names) {
    if (typeof IJThr === 'undefined' || !docId) return;
    const L = IJThr.tryAllLayout(srcDoc.width, srcDoc.height, names.length, 4096);
    const size = Math.max(9, Math.round(L.ph / 10));
    const items = names.map((text, i) => {
      const o = L.cell(i);
      return { kind: 'text', x: o.x + 3, y: o.y + 3, text, size, color: '#ffff00', background: '#000000', bold: false, serif: false, align: 'left', tag: 'thr.tryall' };
    });
    api.annotations.set(docId, items, { tag: 'thr.tryall' });
  }

  // ── Image › Adjust › Auto Threshold (Fiji, fiji.threshold.Auto_Threshold) ──
  async function autoThreshold(api) {
    const st = api.state();
    const doc = st.doc;
    if (!doc) return;
    if (doc.bitDepth === 32) throw thrError('IJ_THR_32BIT');
    const v = await api.dialog({
      titleKey: 'cmd.adjustAutoThreshold', okLabel: api.tr('dlg.ok'),
      fields: [
        { type: 'choice', id: 'method', labelKey: 'dlg.thr.method', value: last.at.method, options: methodOptions(FIJI_METHODS) },
        { type: 'check', id: 'ignoreBlack', labelKey: 'dlg.thr.ignoreBlack', value: last.at.ignoreBlack },
        { type: 'check', id: 'ignoreWhite', labelKey: 'dlg.thr.ignoreWhite', value: last.at.ignoreWhite },
        { type: 'check', id: 'white', labelKey: 'dlg.thr.white', value: last.at.white },
        { type: 'check', id: 'setThreshold', labelKey: 'dlg.thr.setThreshold', value: last.at.setThreshold, enabledIf: (x) => x.method !== TRY_ALL },
        { type: 'check', id: 'showValues', labelKey: 'dlg.thr.showValues', value: last.at.showValues }
      ]
    });
    if (!v) return;
    // the dialog is non-modal elsewhere (menus stay usable): the run belongs to the image it was opened on
    const now = api.state();
    if (!now.doc || now.doc.docId !== doc.docId) return;
    last.at = { method: v.method, ignoreBlack: !!v.ignoreBlack, ignoreWhite: !!v.ignoreWhite, white: !!v.white, setThreshold: !!v.setThreshold, showValues: !!v.showValues };
    const ch = st.activeChannel;
    const flags = { ignoreBlack: !!v.ignoreBlack, ignoreWhite: !!v.ignoreWhite, white: !!v.white };
    if (v.method === TRY_ALL) {
      // "Show threshold values": Fiji logs the level of every method; the levels are computed here (one cancellable step each) and
      // handed to the montage, which then draws exactly what was logged
      let levels;
      if (v.showValues) {
        levels = [];
        for (const m of FIJI_METHODS) {
          const lv = await api.compute('autoThresholdLevel', Object.assign({ method: m }, flags), { docId: doc.docId, channel: ch, labelKey: 'op.autoThreshold' });
          if (!lv) return;
          levels.push(lv.level);
        }
        api.toast('dlg.thr.levelsStatus', { list: FIJI_METHODS.map((m, i) => m + ': ' + levels[i]).join(', ') });
      }
      const res = await api.run('autoThresholdTryAll', levels ? Object.assign({ levels }, flags) : flags, { docId: doc.docId, channel: ch, labelKey: 'op.autoThreshold' });
      if (res && res.newDocIds && res.newDocIds.length) labelPanels(api, res.newDocIds[0], doc, FIJI_METHODS);
      return;
    }
    const lv = await api.compute('autoThresholdLevel', Object.assign({ method: v.method }, flags), { docId: doc.docId, channel: ch, labelKey: 'op.autoThreshold' });
    if (!lv) return;
    // Show threshold values in log window: the Studio has no Log window (API gap, see the header); the status bar carries them
    if (v.showValues) api.toast('dlg.thr.levelStatus', { method: v.method, level: lv.level });
    if (v.setThreshold) { await api.setThreshold(doc.docId, ch, { lower: lv.lower, upper: lv.upper, dark: !!v.white }); return; }
    if (doc.bitDepth === 8) await api.run('autoThreshold', { method: v.method, level: lv.level, white: !!v.white }, { docId: doc.docId, channel: ch, labelKey: 'op.autoThreshold' });
    else await api.run('autoThresholdMask', { method: v.method, level: lv.level, white: !!v.white }, { docId: doc.docId, channel: ch, labelKey: 'op.autoThreshold' });
  }

  // ── Image › Adjust › Auto Local Threshold (Fiji, fiji.threshold.Auto_Local_Threshold) ──
  async function autoLocalThreshold(api) {
    const st = api.state();
    const doc = st.doc;
    if (!doc) return;
    if (doc.bitDepth !== 8) throw thrError('IJ_THR_8BIT');
    const v = await api.dialog({
      titleKey: 'cmd.adjustAutoLocalThreshold', okLabel: api.tr('dlg.ok'),
      fields: [
        { type: 'choice', id: 'method', labelKey: 'dlg.thr.method', value: last.alt.method, options: methodOptions(LOCAL_METHODS) },
        { type: 'number', id: 'radius', labelKey: 'dlg.thr.radius', value: last.alt.radius, min: 1, max: 1000, step: 1, decimals: 0 },
        { type: 'message', id: 'special', labelKey: 'dlg.thr.special' },
        { type: 'number', id: 'parameter1', labelKey: 'dlg.thr.parameter1', value: last.alt.parameter1, step: 'any' },
        { type: 'number', id: 'parameter2', labelKey: 'dlg.thr.parameter2', value: last.alt.parameter2, step: 'any' },
        { type: 'check', id: 'white', labelKey: 'dlg.thr.white', value: last.alt.white },
        { type: 'message', id: 'alwaysWhite', labelKey: 'dlg.thr.alwaysWhite' }
      ]
    });
    if (!v) return;
    const now = api.state();
    if (!now.doc || now.doc.docId !== doc.docId) return;
    last.alt = { method: v.method, radius: Math.round(Number(v.radius)), parameter1: Number(v.parameter1), parameter2: Number(v.parameter2), white: !!v.white };
    const params = { radius: last.alt.radius, parameter1: last.alt.parameter1, parameter2: last.alt.parameter2, white: last.alt.white };
    const ch = st.activeChannel;
    if (v.method === TRY_ALL) {
      const res = await api.run('autoLocalThresholdTryAll', params, { docId: doc.docId, channel: ch, labelKey: 'op.autoLocalThreshold' });
      if (res && res.newDocIds && res.newDocIds.length) labelPanels(api, res.newDocIds[0], doc, LOCAL_METHODS);
      return;
    }
    await api.run('autoLocalThreshold', Object.assign({ method: v.method }, params), { docId: doc.docId, channel: ch, labelKey: 'op.autoLocalThreshold' });
  }

  // ── Process › Binary › Median (Binary.java:47-48: IJ.getNumber("Radius:", medianRadius), static, 3 at the start) ──
  async function binaryMedian(api) {
    const v = await api.dialog({
      titleKey: 'cmd.binMedian', okLabel: api.tr('dlg.ok'),
      fields: [{ type: 'number', id: 'radius', labelKey: 'dlg.thr.medianRadius', value: last.medianRadius === undefined ? 3 : last.medianRadius, min: 0, max: 1000, step: 'any' }]
    });
    if (!v) return;
    last.medianRadius = Number(v.radius);
    await api.run('binaryMedian', { radius: last.medianRadius }, { channel: 'all', labelKey: 'op.binaryMedian' });
  }

  // ── Process › Binary › Options (Binary.java:52-112) ──
  const OPERATIONS = [['nothing', 'dlg.thr.opNothing'], ['erode', 'dlg.thr.opErode'], ['dilate', 'dlg.thr.opDilate'], ['open', 'dlg.thr.opOpen'],
    ['close', 'dlg.thr.opClose'], ['outline', 'dlg.thr.opOutline'], ['fillHoles', 'dlg.thr.opFillHoles'], ['skeletonize', 'dlg.thr.opSkeletonize']];
  const DO_COMMAND = { erode: 'binErode', dilate: 'binDilate', open: 'binOpen', close: 'binClose', outline: 'binOutline', fillHoles: 'binFillHoles', skeletonize: 'binSkeletonize' };
  const clampInt = (x, lo, hi) => Math.max(lo, Math.min(hi, Math.floor(Number(x))));
  const objectValue = (blackBackground, inverted) => (inverted ? 255 - (blackBackground ? 255 : 0) : (blackBackground ? 255 : 0));

  // The preview of "Do:" (KEEP_PREVIEW): the chosen operation drawn over the image with the dialog's values, without keeping them.
  function binaryPreview(api, doc) {
    const channels = (doc.channels || []).length;
    let noted = false;
    return {
      onChange(values, ctl) {
        if (!values) { api.cancelPreview(); return; }
        const op = values.operation;
        // the operation chosen under Do: is what is drawn; Nothing and Skeletonize (a whole-image pass) draw nothing
        if (!op || op === 'nothing' || op === 'skeletonize') { api.cancelPreview(); if (ctl) { noted = true; ctl.note(api.tr('dlg.thr.previewNone')); } return; }
        if (noted && ctl) { noted = false; ctl.note(null); }
        const fg = [];
        for (let c = 0; c < channels; c++) fg.push(objectValue(values.blackBackground, !!(doc.channels[c].display && doc.channels[c].display.invert)));
        if (op === 'outline') {
          api.preview('segOutline', { invert: fg.map((f) => f === 0) }, { docId: doc.docId, channel: 'all' }).catch(() => {});
          return;
        }
        api.preview('binary', { op, iterations: clampInt(values.iterations, 1, 100), count: clampInt(values.count, 1, 8), padEdges: !!values.padEdges, foreground: fg },
          { docId: doc.docId, channel: 'all' }).catch(() => {});
      }
    };
  }

  // `static int iterations = 1` (Binary.java:22) lives for the run of the program: the package's session data here
  const sessionIterations = (api) => { const d = api.sessionData.get('thr'); return d && Number.isInteger(d.iterations) ? d.iterations : 1; };

  async function binaryOptions(api) {
    const st = api.state();
    let doc = st.doc && st.doc.bitDepth === 8 ? st.doc : null;
    // Binary.setup: any image that is not binary (0 and 255 only) gets NO_IMAGE_REQUIRED — no "Do:", no Preview
    if (doc) {
      const r = await api.compute('thrIsBinary', {}, { docId: doc.docId, channel: st.activeChannel, labelKey: 'cmd.binOptions' });
      if (!r || !r.binary) doc = null;
    }
    const get = (k, d) => { const x = api.settings.get(k); return x === undefined ? d : x; };
    const fields = [
      { type: 'number', id: 'iterations', labelKey: 'dlg.thr.iterations', value: clampInt(sessionIterations(api), 1, 100), min: 1, max: 100, step: 1, decimals: 0 },
      { type: 'number', id: 'count', labelKey: 'dlg.thr.count', value: clampInt(get('thr.count', 1), 1, 8), min: 1, max: 8, step: 1, decimals: 0 },
      { type: 'check', id: 'blackBackground', labelKey: 'dlg.thr.blackBackground', value: get('thr.blackBackground', true) !== false },
      { type: 'check', id: 'padEdges', labelKey: 'dlg.thr.padEdges', value: get('thr.padEdges', false) === true },
      { type: 'choice', id: 'edmOutput', labelKey: 'dlg.thr.edmOutput', value: ['overwrite', 'byte', 'short', 'float'].includes(get('thr.edmOutput', 'overwrite')) ? get('thr.edmOutput', 'overwrite') : 'overwrite',
        options: [{ value: 'overwrite', labelKey: 'dlg.seg.outOverwrite' }, { value: 'byte', labelKey: 'dlg.seg.out8' }, { value: 'short', labelKey: 'dlg.seg.out16' }, { value: 'float', labelKey: 'dlg.seg.out32' }] }
    ];
    // "if (imp!=null)": the Do: choice and the preview exist only when an image can take the operation
    if (doc) fields.push({ type: 'choice', id: 'operation', labelKey: 'dlg.thr.do', value: 'nothing', options: OPERATIONS.map(([value, labelKey]) => ({ value, labelKey })) });
    const v = await api.dialog({ titleKey: 'dlg.thr.optionsTitle', okLabel: api.tr('dlg.ok'), fields, preview: doc ? binaryPreview(api, doc) : undefined });
    if (!v) return;
    api.sessionData.set('thr', Object.assign({}, api.sessionData.get('thr') || {}, { iterations: clampInt(v.iterations, 1, 100) }));
    api.settings.set('thr.count', clampInt(v.count, 1, 8));
    api.settings.set('thr.blackBackground', !!v.blackBackground);
    api.settings.set('thr.padEdges', !!v.padEdges);
    api.settings.set('thr.edmOutput', v.edmOutput);
    if (doc && v.operation && v.operation !== 'nothing' && DO_COMMAND[v.operation]) {
      const now = api.state();
      if (now.doc && now.doc.docId === doc.docId) await api.runCommand(DO_COMMAND[v.operation]);
    }
  }

  IJApp.extend({
    pkg: 'thr',
    errors: { IJ_THR_32BIT: 'err.thr32bit', IJ_THR_8BIT: 'err.thr8bit', IJ_THR_NOT_BINARY: 'err.thrNotBinary' },
    commands: [
      { id: 'adjustAutoLocalThreshold', menu: ['Image', 'Adjust'], order: 50, separatorBefore: true, run: autoLocalThreshold },
      { id: 'adjustAutoThreshold', menu: ['Image', 'Adjust'], order: 60, run: autoThreshold },
      { id: 'binMakeBinary', menu: ['Process', 'Binary'], order: 5, run: (api) => api.runCommand('binMask') },
      { id: 'binMedian', menu: ['Process', 'Binary'], order: 55, enabled: is8, run: binaryMedian },
      { id: 'binOptions', menu: ['Process', 'Binary'], order: 130, separatorBefore: true, enabled: (st) => !st.busy, run: binaryOptions }
    ]
  });
})();
