/* ij-cmds-stk.js — menu commands of package `stk`: Image > Stacks, Image > Hyperstacks, Image > Type, Image > Color (stack parts).
 * Runs on the page only, before IJApp.mount; talks to the app through the documented extension API (IJApp.EXT_API_MEMBERS) and to the worker
 * through the registry operations of ij-proc-stk.js (and ij-proc-multi.js for Split / Merge of RGB images).
 *
 * Dialogs mirror ImageJ 1.54p's captured GenericDialogs (tests/fixtures/ij-stacks/dialogs): labels, defaults, order; every field carries its macro
 * option key as `ijKey` (the macro layer reads it). Positions (c, z, t) of the page API are 0-based; ImageJ's dialogs are 1-based.
 *
 * Not done: the pixels of "Label..." are an overlay (ImageJ burns the text into the pixels with a Java font); Animation shares the page's
 * animator (api.animation).
 */
(function (root) {
  'use strict';
  if (typeof IJApp === 'undefined' || typeof IJApp.extend !== 'function') return;

  // ───────────────────────────── helpers ─────────────────────────────
  const nSl = (i) => (i && i.nSlices) || 1;
  const dimsOf = (i) => ({ nC: (i && i.nC) || 1, nZ: (i && i.nZ) || 1, nT: (i && i.nT) || 1 });
  const isHyper = (i) => !!i && (!!i.hyperstack || ((i.nC || 1) > 1));
  const isRgb = (i) => !!i && !!i.rgb;
  const idle = (st) => !!st && !!st.doc && !st.busy;
  const stackIdle = (st) => idle(st) && nSl(st.doc) > 1;
  const docsOf = (st) => (st && Array.isArray(st.docs) ? st.docs : []);
  const clampInt = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.trunc(Number(v))));
  const fnv = (bytes) => { let h = 0x811c9dc5; for (let i = 0; i < bytes.length; i++) { h ^= bytes[i]; h = Math.imul(h, 16777619) >>> 0; } return h.toString(16); };
  const num = (id, key, labelKey, value, o) => Object.assign({ type: 'number', id, ijKey: key, labelKey, value, integer: true, decimals: 0 }, o || {});
  const check = (id, key, labelKey, value, o) => Object.assign({ type: 'check', id, ijKey: key, labelKey, value: !!value }, o || {});
  const choice = (id, key, labelKey, value, options, o) => Object.assign({ type: 'choice', id, ijKey: key, labelKey, value, options }, o || {});
  const str = (id, key, labelKey, value, o) => Object.assign({ type: 'string', id, ijKey: key, labelKey, value: value === undefined ? '' : value }, o || {});
  const OK = (api) => api.tr('dlg.ok');

  const PROJ_OPTIONS = [
    { value: 'avg', labelKey: 'dlg.stk.pAvg' }, { value: 'max', labelKey: 'dlg.stk.pMax' }, { value: 'min', labelKey: 'dlg.stk.pMin' },
    { value: 'sum', labelKey: 'dlg.stk.pSum' }, { value: 'sd', labelKey: 'dlg.stk.pSd' }, { value: 'median', labelKey: 'dlg.stk.pMedian' }
  ];
  const DISPLAY_OPTIONS = [{ value: 'composite', labelKey: 'dlg.stk.dComposite' }, { value: 'color', labelKey: 'dlg.stk.dColor' }, { value: 'gray', labelKey: 'dlg.stk.dGray' }];
  const DIM_OPTIONS = [{ value: 'channel', labelKey: 'dlg.stk.channel' }, { value: 'slice', labelKey: 'dlg.stk.slice' }, { value: 'frame', labelKey: 'dlg.stk.frame' }];
  const ORDERS = ['xyczt', 'xyctz', 'xyzct', 'xyztc', 'xytcz', 'xytzc'];

  // ───────────────────────────── Image > Stacks ─────────────────────────────
  /** Image > Stacks > Add Slice (ij.plugin.StackEditor.addSlice): a plain stack gets a blank slice after the current one, a hyperstack asks what to add. */
  async function addSlice(api) {
    const info = api.state().doc;
    if (!info) return;
    let params = { add: 'slice', prepend: false };
    if (isHyper(info)) {
      const v = await api.dialog({ title: api.tr('dlg.stk.addTitle'), okLabel: OK(api), fields: [
        choice('add', 'add', 'dlg.stk.add', 'slice', DIM_OPTIONS), check('prepend', 'prepend', 'dlg.stk.prepend', false)] });
      if (!v) return;
      params = { add: v.add, prepend: !!v.prepend };
    }
    const res = await api.run('stkAddSlice', params, { docId: info.docId, noRoi: true, labelKey: 'op.stkAddSlice' });
    if (res && !isHyper(info)) {
      // the new slice is the current one (StackEditor.addSlice: "imp.setSlice(n+1)")
      const d = dimsOf(info);
      await api.setPosition(d.nZ === 1 && d.nT > 1 ? { t: Math.min(d.nT, (info.t || 0) + 1) } : { z: Math.min(d.nZ, (info.z || 0) + 1) }, { docId: info.docId });
    }
  }

  /** Delete Slice (StackEditor.deleteSlice): the current slice of a plain stack, the current channel / slice / frame of a hyperstack. */
  async function deleteSlice(api) {
    const info = api.state().doc;
    if (!info) return;
    let params = {};
    if (isHyper(info)) {
      const v = await api.dialog({ title: api.tr('dlg.stk.deleteTitle'), okLabel: OK(api), fields: [choice('delete', 'delete', 'dlg.stk.delete', 'slice', DIM_OPTIONS)] });
      if (!v) return;
      params = { delete: v.delete };
    }
    const res = await api.run('stkDeleteSlice', params, { docId: info.docId, noRoi: true, labelKey: 'op.stkDeleteSlice' });
    if (res && !isHyper(info)) {
      const d = dimsOf(info);
      await api.setPosition(d.nZ === 1 && d.nT > 1 ? { t: Math.max(0, (info.t || 0) - 1) } : { z: Math.max(0, (info.z || 0) - 1) }, { docId: info.docId });
    }
  }

  /** Next / Previous Slice (ij.plugin.Animator.nextSlice / previousSlice): z of a stack, the frames of a series of frames. */
  async function stepSlice(api, dir) {
    const info = api.state().doc;
    if (!info) return;
    const d = dimsOf(info), p = api.position(info.docId);
    if (d.nZ > 1 || d.nT === 1) await api.setPosition({ z: clampInt(p.z + dir, 0, d.nZ - 1) }, { docId: info.docId });
    else await api.setPosition({ t: clampInt(p.t + dir, 0, d.nT - 1) }, { docId: info.docId });
  }

  /** Set Slice... (ImageJ's Set Slice / Set Position dialogs): a slice number of a plain stack, channel / slice / frame of a hyperstack. */
  async function setSlice(api) {
    const info = api.state().doc;
    if (!info) return;
    const d = dimsOf(info), p = api.position(info.docId);
    if (isHyper(info)) {
      const v = await api.dialog({ title: api.tr('dlg.stk.setPositionTitle'), okLabel: OK(api), fields: [
        num('channel', 'channel', 'dlg.stk.channelN', p.c + 1, { min: 1, max: d.nC }), num('slice', 'slice', 'dlg.stk.sliceN', p.z + 1, { min: 1, max: d.nZ }),
        num('frame', 'frame', 'dlg.stk.frameN', p.t + 1, { min: 1, max: d.nT })] });
      if (!v) return;
      await api.setPosition({ c: clampInt(v.channel - 1, 0, d.nC - 1), z: clampInt(v.slice - 1, 0, d.nZ - 1), t: clampInt(v.frame - 1, 0, d.nT - 1) }, { docId: info.docId });
      return;
    }
    const n = nSl(info);
    const cur = d.nZ === 1 && d.nT > 1 ? p.t : p.z;
    const v = await api.dialog({ title: api.tr('dlg.stk.setSliceTitle'), okLabel: OK(api), fields: [num('slice', 'slice', 'dlg.stk.sliceN', cur + 1, { min: 1, max: n })] });
    if (!v) return;
    const k = clampInt(v.slice - 1, 0, n - 1);
    await api.setPosition(d.nZ === 1 && d.nT > 1 ? { t: k } : { z: k }, { docId: info.docId });
  }

  /** Images to Stack (ij.plugin.ImagesToStack): the open images (single planes) whose title contains the filter become the slices of a stack. */
  async function imagesToStack(api) {
    const st = api.state();
    const docs = docsOf(st).filter((d) => nSl(d) === 1);
    if (!docs.length) return;
    const sizes = (list) => list.some((d) => d.width !== list[0].width || d.height !== list[0].height);
    const v = await api.dialog({ title: api.tr('dlg.stk.imgStackTitle'), okLabel: OK(api), fields: [
      choice('method', 'method', 'dlg.stk.method', 'center', [{ value: 'center', labelKey: 'dlg.stk.mCenter' }, { value: 'topleft', labelKey: 'dlg.stk.mTopLeft' },
        { value: 'smallest', labelKey: 'dlg.stk.mSmallest' }, { value: 'largest', labelKey: 'dlg.stk.mLargest' }], { visibleIf: () => sizes(docs) }),
      check('bicubic', 'bicubic', 'dlg.stk.bicubic', false, { visibleIf: (x) => sizes(docs) && (x.method === 'smallest' || x.method === 'largest') }),
      choice('fill', 'fill', 'dlg.stk.fill', 'black', [{ value: 'black', labelKey: 'dlg.stk.black' }, { value: 'white', labelKey: 'dlg.stk.white' }],
        { visibleIf: (x) => sizes(docs) && (x.method === 'center' || x.method === 'topleft') }),
      str('name', 'name', 'dlg.stk.name', 'Stack'), str('title', 'title', 'dlg.stk.titleContains', ''),
      check('use', 'use', 'dlg.stk.useTitles', true), check('keep', 'keep', 'dlg.stk.keepSource', false)] });
    if (!v) return;
    const filter = String(v.title || '');
    const picked = docs.filter((d) => filter === '' || d.name.indexOf(filter) >= 0);
    if (!picked.length) { api.toast('err.stkNoImages'); return; }
    if (picked.some((d) => d.rgb) && picked.some((d) => !d.rgb)) { api.toast('err.stkMixedRgb'); return; }
    const ids = picked.map((d) => d.docId);
    const res = await api.run('stkImagesToStack', { method: v.method || 'center', bicubic: !!v.bicubic, fill: v.fill || 'black', name: String(v.name || 'Stack'), useTitles: !!v.use },
      { docId: ids[0], docIds: ids, noRoi: true, labelKey: 'op.stkImagesToStack', placement: 'tab' });
    if (res && !v.keep) for (const id of ids) await api.closeDoc(id);
  }

  /** Stack to Images (StackEditor.convertStackToImages): one image per slice; the stack is closed. */
  async function stackToImages(api) {
    const info = api.state().doc;
    if (!info) return;
    const res = await api.run('stkStackToImages', {}, { docId: info.docId, noRoi: true, labelKey: 'op.stkStackToImages', placement: 'tab' });
    if (res) await api.closeDoc(info.docId);
  }

  /** Reslice [/]... (ij.plugin.Slicer): a rectangle or the whole image cut from one side, a straight line cut `slice count` times. */
  async function reslice(api) {
    const st = api.state();
    const info = st.doc;
    if (!info) return;
    const roi = st.roi;
    const line = !!roi && roi.type === 'line';
    if (roi && !line && roi.type !== 'rect') { api.toast('err.stkResliceRoi'); return; }
    const cal = info.calibration || {};
    const unit = cal.unit && cal.unit !== 'pixel' ? cal.unit : 'pixel';
    const fields = [num('output', 'output', 'dlg.stk.outputSpacing', cal.pixelDepth || 1, { integer: false, decimals: 3, min: 0.001, units: unit })];
    if (line) fields.push(num('slice_count', 'slice', 'dlg.stk.sliceCount', 1, { min: 1 }));
    else fields.push(choice('start', 'start', 'dlg.stk.startAt', 'top', [{ value: 'top', labelKey: 'dlg.stk.top' }, { value: 'left', labelKey: 'dlg.stk.left' }, { value: 'bottom', labelKey: 'dlg.stk.bottom' }, { value: 'right', labelKey: 'dlg.stk.right' }]));
    fields.push(check('flip', 'flip', 'dlg.stk.flip', false), check('rotate', 'rotate', 'dlg.stk.rotate', false), check('avoid', 'avoid', 'dlg.stk.avoid', true));
    const v = await api.dialog({ title: api.tr('dlg.stk.resliceTitle'), okLabel: OK(api), fields });
    if (!v) return;
    const params = { output: Number(v.output), start: line ? 'top' : (v.start || 'top'), flip: !!v.flip, rotate: !!v.rotate, avoid: !!v.avoid };
    if (line) params.sliceCount = clampInt(v.slice_count, 1, 100000);
    await api.run('stkReslice', params, { docId: info.docId, labelKey: 'op.stkReslice', placement: 'splitRight' });
  }

  /** Z Project... (ij.plugin.ZProjector) of the active stack; also called by the page's Z Project command (ij-app.js stackProjectCommand). */
  async function zProject(api) {
    const st = api.state();
    const info = st.doc;
    if (!info) return;
    const d = dimsOf(info), hyper = isHyper(info);
    const depth = hyper ? d.nZ : nSl(info);
    const fields = [num('start', 'start', 'dlg.stk.startSlice', 1, { min: 1 }), num('stop', 'stop', 'dlg.stk.stopSlice', depth, { min: 1 }),
      choice('projection', 'projection', 'dlg.stk.projectionType', 'avg', PROJ_OPTIONS)];
    if (hyper && d.nT > 1) fields.push(check('all', 'all', 'dlg.stk.allFrames', true));
    const v = await api.dialog({ title: api.tr('dlg.stk.zprojTitle'), okLabel: OK(api), fields });
    if (!v) return;
    const start = clampInt(v.start, 1, depth), stop = clampInt(v.stop, 1, depth);
    await api.run('stkZProject', { start, stop, method: v.projection, allFrames: hyper && d.nT > 1 ? v.all !== false : false },
      { docId: info.docId, noRoi: true, labelKey: 'op.stkZProject', placement: 'splitRight' });
  }

  /** Plot Z-axis Profile (ij.plugin.ZAxisProfiler): the mean of the selection in every slice. */
  async function zProfile(api) {
    const st = api.state();
    const info = st.doc;
    if (!info) return;
    const d = dimsOf(info);
    let dimension = 'z';
    if (isHyper(info) && d.nZ > 1 && d.nT > 1) {
      const v = await api.dialog({ title: api.tr('dlg.stk.profilerTitle'), okLabel: OK(api), fields: [
        choice('profile', 'profile', 'dlg.stk.profile', 'time', [{ value: 'time', labelKey: 'dlg.stk.time' }, { value: 'z', labelKey: 'dlg.stk.zAxis' }])] });
      if (!v) return;
      dimension = v.profile === 'time' ? 'time' : 'z';
    }
    const r = await api.compute('stkProfile', { dimension, rgbWeighted: api.settings.get('conv.weighted') === true }, { docId: info.docId, labelKey: 'op.stkProfile' });
    if (!r) return;
    const xLabel = r.xLabel === 'Slice' ? api.tr('dlg.stk.plotSlice') : (r.xLabel + (r.unit ? ' (' + r.unit + ')' : ''));
    const rows = r.x.map((x, i) => [x, r.y[i]]);
    api.openPlot({ title: r.title, xLabel, yLabel: api.tr('dlg.stk.plotMean'), series: [{ kind: 'line', x: r.x, y: r.y, color: '#1e88e5', label: r.title }],
      csv: { columns: [r.xLabel === 'Slice' ? 'Slice' : r.xLabel, 'Mean'], rows } });
  }

  /** Measure Stack... (ij.plugin.filter.Analyzer on every slice): the page's Measure at each position; a hyperstack asks which dimensions. */
  async function measureStack(api) {
    const st = api.state();
    const info = st.doc;
    if (!info) return;
    const d = dimsOf(info), p0 = api.position(info.docId);
    let positions = [];
    if (isHyper(info)) {
      const v = await api.dialog({ title: api.tr('dlg.stk.measureTitle'), okLabel: OK(api), fields: [
        check('channels', 'channels', 'dlg.stk.channels', true), check('slices', 'slices', 'dlg.stk.slices', true), check('frames', 'frames', 'dlg.stk.frames', true),
        choice('order', 'order', 'dlg.stk.order', 'czt', ['czt', 'ctz', 'zct', 'ztc', 'tcz', 'tzc'].map((o) => ({ value: o, label: o + (o === 'czt' ? ' (default)' : '') })))] });
      if (!v) return;
      const sel = { c: v.channels ? d.nC : 1, z: v.slices ? d.nZ : 1, t: v.frames ? d.nT : 1 };
      const fixed = { c: p0.c, z: p0.z, t: p0.t };
      // the first letter of the order varies fastest (ImageJ's `order=czt` = channels fastest)
      const ord = String(v.order).split('');
      const total = sel.c * sel.z * sel.t;
      for (let k = 0; k < total; k++) {
        let r = k; const pos = { c: fixed.c, z: fixed.z, t: fixed.t };
        for (const ax of ord) { const n = sel[ax]; const i = r % n; r = (r - i) / n; if (n > 1 || sel[ax] === d['n' + ax.toUpperCase()]) pos[ax] = i; }
        positions.push(pos);
      }
    } else {
      const n = nSl(info);
      const tAxis = d.nZ === 1 && d.nT > 1;
      for (let i = 0; i < n; i++) positions.push(tAxis ? { t: i } : { z: i });
    }
    try {
      // Measure runs on the ACTIVE image: the loop stops if the operator switches to another one, rather than mixing its rows in.
      for (const pos of positions) {
        const now = api.state().doc;
        if (!now || now.docId !== info.docId) { api.toast('err.stkMeasureImageChanged'); break; }
        await api.setPosition(pos, { docId: info.docId });
        await api.runCommand('analyzeMeasure');
      }
    } finally { await api.setPosition({ c: p0.c, z: p0.z, t: p0.t }, { docId: info.docId }); }
  }

  /** Label... (ij.plugin.filter.StackLabeler): a text per slice, here an overlay (the pixels are not burnt in). */
  function labelText(format, v, i, label) {
    const value = v.starting + v.interval * i;
    const pad = (n, w) => { let s = String(Math.trunc(n)); while (s.length < w) s = '0' + s; return s; };
    switch (format) {
      case '0': return String(Math.round(value * 1000) / 1000);
      case '0000': return pad(value, 4);
      case '00:00': { const m = Math.trunc(value / 60), s = Math.trunc(value % 60); return pad(m, 2) + ':' + pad(s, 2); }
      case '00:00:00': { const h = Math.trunc(value / 3600), m = Math.trunc((value % 3600) / 60), s = Math.trunc(value % 60); return pad(h, 2) + ':' + pad(m, 2) + ':' + pad(s, 2); }
      case 'text': return String(v.text);
      default: return label === null || label === undefined ? 'null slice label (' + (i + 1) + ')' : label;
    }
  }
  async function labelStack(api) {
    const info = api.state().doc;
    if (!info) return;
    const n = nSl(info);
    const v = await api.dialog({ title: api.tr('dlg.stk.labelTitle'), okLabel: OK(api), fields: [
      choice('format', 'format', 'dlg.stk.format', '0', [{ value: '0', label: '0' }, { value: '0000', label: '0000' }, { value: '00:00', label: '00:00' }, { value: '00:00:00', label: '00:00:00' },
        { value: 'text', labelKey: 'dlg.stk.fmtText' }, { value: 'label', labelKey: 'dlg.stk.fmtLabel' }]),
      num('starting', 'starting', 'dlg.stk.startingValue', 0, { integer: false, decimals: 3 }), num('interval', 'interval', 'dlg.stk.interval', 1, { integer: false, decimals: 3 }),
      num('x', 'x', 'dlg.stk.xLocation', 5), num('y', 'y', 'dlg.stk.yLocation', 20), num('font', 'font', 'dlg.stk.fontSize', 18, { min: 1 }),
      str('text', 'text', 'dlg.stk.text', '', { visibleIf: (x) => x.format === 'text' }), str('range', 'range', 'dlg.stk.range', '1-' + n)] });
    if (!v) return;
    const m = /^\s*(\d+)\s*-\s*(\d+)\s*$/.exec(String(v.range)) || /^\s*(\d+)\s*$/.exec(String(v.range));
    const first = clampInt(m ? m[1] : 1, 1, n), last = clampInt(m ? (m[2] === undefined ? m[1] : m[2]) : n, 1, n);
    const items = [];
    const p0 = api.position(info.docId);
    const d0 = dimsOf(info);
    for (let k = first; k <= last; k++) {
      let label = null;
      if (v.format === 'label') {
        // the label of slice k is read at that position (api.label answers for the plane on screen)
        await api.setPosition(d0.nZ === 1 && d0.nT > 1 ? { t: k - 1 } : { z: k - 1 }, { docId: info.docId });
        label = api.label(info.docId);
      }
      items.push({ kind: 'text', x: v.x, y: v.y, text: labelText(v.format, v, k - first, label), size: v.font, color: '#ffffff', background: null, bold: false, serif: false, align: 'left', tag: 'stk.label', position: { n: k } });
    }
    if (v.format === 'label') await api.setPosition({ c: p0.c, z: p0.z, t: p0.t }, { docId: info.docId });
    api.annotations.remove(info.docId, { tag: 'stk.label' });
    api.annotations.add(info.docId, items);
  }

  /** Make Montage... (ij.plugin.MontageMaker) of a stack; also called by the page's Make Montage command (ij-cmds-edit.js) when the image is a stack. */
  const FG_NAMES = { white: [255, 255, 255], black: [0, 0, 0], red: [255, 0, 0], green: [0, 255, 0], blue: [0, 0, 255], yellow: [255, 255, 0], cyan: [0, 255, 255], magenta: [255, 0, 255], orange: [255, 200, 0], pink: [255, 175, 175], gray: [128, 128, 128], lightgray: [192, 192, 192], darkgray: [64, 64, 64] };
  let MONTAGE_LAST = null;
  async function montage(api) {
    const st = api.state();
    const info = st.doc;
    if (!info) return;
    const d = dimsOf(info);
    if (isHyper(info) && d.nC > 1 && (d.nZ > 1 || d.nT > 1)) { api.toast('err.stkNo5d'); return; }
    const n = d.nC > 1 ? d.nC : nSl(info);
    if (n < 2) { api.toast('err.stkNeedsStack'); return; }
    const E = root.IJEdit;
    let def = E && typeof E.montageDefaults === 'function' ? E.montageDefaults(n, info.width) : { columns: Math.ceil(Math.sqrt(n)), rows: Math.ceil(n / Math.ceil(Math.sqrt(n))), scale: 1, first: 1, last: n, increment: 1, border: 0, fontSize: 12 };
    // MontageMaker keeps its last values in static fields and starts the layout again (columns, rows, scale, increment, first, last) when the stack
    // changes; border width, font size, Label Slices and Use foreground colour survive any change
    if (MONTAGE_LAST) {
      const v0 = MONTAGE_LAST.values;
      def = MONTAGE_LAST.docId === info.docId || MONTAGE_LAST.n === n ? Object.assign({}, def, v0)
        : Object.assign({}, def, { border: v0.border, fontSize: v0.fontSize, label: v0.label, useForeground: v0.useForeground });
    }
    const v = await api.dialog({ title: api.tr('dlg.edit.montageTitle'), okLabel: OK(api), fields: [
      num('columns', 'columns', 'dlg.edit.columns', def.columns, { min: 1 }), num('rows', 'rows', 'dlg.edit.rows', def.rows, { min: 1 }),
      num('scale', 'scale', 'dlg.edit.scaleFactor', def.scale, { integer: false, decimals: 2, min: 0.01, step: 'any' }),
      num('first', 'first', 'dlg.edit.firstSlice', def.first), num('last', 'last', 'dlg.edit.lastSlice', def.last), num('increment', 'increment', 'dlg.edit.increment', def.increment),
      num('border', 'border', 'dlg.edit.borderWidth', def.border), num('fontSize', 'font', 'dlg.edit.fontSize', def.fontSize, { min: 1 }),
      check('label', 'label', 'dlg.edit.labelSlices', !!def.label), check('useForeground', 'use', 'dlg.edit.useForeground', !!def.useForeground)],
      validate: (x) => (Math.trunc(info.width * x.scale) < 1 || Math.trunc(info.height * x.scale) < 1 ? { scale: 'dlg.edit.montageScale' } : null) });
    if (!v) return;
    MONTAGE_LAST = { n, docId: info.docId, values: { columns: v.columns, rows: v.rows, scale: v.scale, first: v.first, last: v.last, increment: v.increment, border: v.border, fontSize: v.fontSize, label: !!v.label, useForeground: !!v.useForeground } };
    const params = { columns: Math.trunc(v.columns), rows: Math.trunc(v.rows), scale: Number(v.scale), first: clampInt(v.first, 1, n), last: clampInt(v.last, 1, n), inc: Math.max(1, Math.trunc(v.increment)), border: Math.max(0, Math.trunc(v.border)) };
    if (v.useForeground) {
      const lum = (rgb) => Math.round((rgb[0] + rgb[1] + rgb[2]) / 3);
      // a named colour, or the #rrggbb a macro's setForegroundColor stores
      const rgbOf = (key, dflt) => {
        const k = String(api.settings.get(key) || '').trim().toLowerCase();
        if (FG_NAMES[k]) return FG_NAMES[k];
        const m = /^#?([0-9a-f]{6})$/.exec(k);
        if (!m) return dflt;
        const n = parseInt(m[1], 16);
        return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
      };
      params.fg = lum(rgbOf('colors.foreground', [255, 255, 255])); params.bg = lum(rgbOf('colors.background', [0, 0, 0]));
    }
    const res = await api.run('stkMontage', params, { docId: info.docId, noRoi: true, labelKey: 'op.stkMontage', placement: 'tab' });
    if (!res || !res.newDocIds || !res.newDocIds.length || !v.label) return;
    // MontageMaker.drawLabel: the slice number centred under each tile, here an overlay text (not burnt into the pixels)
    const out = api.state().docs.find((x) => x.docId === res.newDocIds[0]);
    if (!out) return;
    const w = Math.trunc(info.width * params.scale), h = Math.trunc(info.height * params.scale);
    const items = [];
    let x = 0, y = 0, slice = params.first;
    while (slice <= params.last) {
      items.push({ kind: 'text', x: x + Math.trunc(w / 2), y: y + h - Math.trunc(params.border / 2) - v.fontSize - 1, text: String(slice), size: v.fontSize, color: '#ffffff', background: null, bold: false, serif: false, align: 'center', tag: 'stk.montage' });
      x += w + params.border;
      if (x >= out.width) { x = 0; y += h + params.border; if (y >= out.height) break; }
      slice += params.inc;
    }
    api.annotations.add(res.newDocIds[0], items);
  }

  /** Statistics (ij.plugin.filter.StackStatistics): one row of Results for the whole stack. */
  async function stackStatistics(api) {
    const st = api.state();
    const info = st.doc;
    if (!info) return;
    const r = await api.compute('stkStats', { rgbWeighted: api.settings.get('conv.weighted') === true }, { docId: info.docId, labelKey: 'op.stkStats' });
    if (!r) return;
    // the statistics columns carry the Results headings of the measurement columns (Mean, StdDev …), as Analyze › Measure's rows do
    const row = { voxels: r.voxels, pctVolume: r.percentVolume, Mean: r.mean, StdDev: r.stdDev, Min: r.min, Max: r.max, Mode: r.mode };
    if (r.calibrated) row.volume = r.volume;
    if (r.median !== null && r.median !== undefined) row.Median = r.median;
    api.addResults([row]);
  }

  // ── Animation
  // Start Animation [\] is a toggle, as the key is: a running animation stops (ImageJ's Animator)
  async function toggleAnimation(api) { const i = api.state().doc; if (i) api.animation.toggle({ docId: i.docId }); }
  async function stopAnimation(api) { const i = api.state().doc; if (i) api.animation.stop({ docId: i.docId }); }
  async function animationOptions(api) {
    const info = api.state().doc;
    if (!info) return;
    const o = api.animation.options({ docId: info.docId });
    const n = nSl(info);
    const v = await api.dialog({ title: api.tr('dlg.stk.animTitle'), okLabel: OK(api), fields: [
      num('speed', 'speed', 'dlg.stk.speed', o.fps, { integer: false, decimals: 1, min: 0.1, max: 1000 }), num('first', 'first', 'dlg.stk.firstFrame', o.first, { min: 1, max: n }),
      num('last', 'last', 'dlg.stk.lastFrame', o.last, { min: 1, max: n }), check('loop', 'loop', 'dlg.stk.loopBack', !!o.backAndForth), check('start', 'start', 'dlg.stk.startAnim', true)] });
    if (!v) return;
    api.animation.setOptions({ fps: Number(v.speed), first: clampInt(v.first, 1, n), last: clampInt(v.last, 1, n), backAndForth: !!v.loop }, { docId: info.docId });
    if (v.start) api.animation.start({ docId: info.docId });
  }

  // ── Tools
  async function combine(api) {
    const st = api.state();
    const docs = docsOf(st).filter((d) => !d.rgb || true);
    if (docs.length < 2) { api.toast('err.stkNeedTwoImages'); return; }
    const v = await api.dialog({ title: api.tr('dlg.stk.combineTitle'), okLabel: OK(api), fields: [
      { type: 'doc', id: 'stack1', ijKey: 'stack1', labelKey: 'dlg.stk.stack1', value: docs[0].docId }, { type: 'doc', id: 'stack2', ijKey: 'stack2', labelKey: 'dlg.stk.stack2', value: docs[1].docId },
      check('combine', 'combine', 'dlg.stk.combineVert', false)],
      validate: (x) => (x.stack1 === x.stack2 ? { stack2: 'dlg.stk.sameStack' } : null) });
    if (!v) return;
    const res = await api.run('stkCombine', { vertical: !!v.combine }, { docId: v.stack1, docIds: [v.stack1, v.stack2], noRoi: true, labelKey: 'op.stkCombine', placement: 'tab' });
    if (res) { await api.closeDoc(v.stack1); await api.closeDoc(v.stack2); }
  }

  async function concatenate(api) {
    const st = api.state();
    const docs = docsOf(st);
    if (docs.length < 2) { api.toast('err.stkNeedTwoImages'); return; }
    const opts = docs.map((d) => ({ value: d.docId, label: d.name }));
    const many = Math.min(docs.length + 1, 8);
    const fields = [check('all', 'all_open', 'dlg.stk.allOpen', false)];
    for (let i = 0; i < many; i++) {
      const isLast = i >= docs.length;
      fields.push(choice('image' + (i + 1), 'image' + (i + 1), 'dlg.stk.image', i < 2 ? docs[i].docId : 'none',
        isLast || i >= 2 ? [{ value: 'none', labelKey: 'dlg.stk.none' }].concat(opts) : opts.concat([{ value: 'none', labelKey: 'dlg.stk.none' }]), { label: api.tr('dlg.stk.image') + (i + 1) + ':', visibleIf: (x) => !x.all }));
    }
    fields.push(str('title', 'title', 'dlg.stk.newTitle', 'Untitled'), check('keep', 'keep', 'dlg.stk.keepSource', false), check('open', 'open', 'dlg.stk.open4d', true));
    const v = await api.dialog({ title: api.tr('dlg.stk.concatTitle'), okLabel: OK(api), fields });
    if (!v) return;
    let ids = v.all ? docs.map((d) => d.docId) : [];
    if (!v.all) for (let i = 0; i < many; i++) { const id = v['image' + (i + 1)]; if (id !== undefined && id !== 'none' && ids.indexOf(id) < 0) ids.push(id); }
    if (ids.length < 2) { api.toast('err.stkNeedTwoImages'); return; }
    // images of another type than the first are left out (Concatenator: "Omitting <title> - image type not matched")
    const first = docs.find((d) => d.docId === ids[0]);
    ids = ids.filter((id) => { const d = docs.find((x) => x.docId === id); return id === ids[0] || (d.bitDepth === first.bitDepth && !!d.rgb === !!first.rgb); });
    const res = await api.run('stkConcatenate', { title: String(v.title || 'Untitled'), open4D: !!v.open }, { docId: ids[0], docIds: ids, noRoi: true, labelKey: 'op.stkConcatenate', placement: 'tab' });
    if (res && !v.keep) for (const id of ids) await api.closeDoc(id);
  }

  async function groupedZProject(api) {
    const info = api.state().doc;
    if (!info) return;
    const depth = isHyper(info) ? dimsOf(info).nZ : nSl(info);
    const v = await api.dialog({ title: api.tr('dlg.stk.groupTitle'), okLabel: OK(api), fields: [
      choice('projection', 'projection', 'dlg.stk.projectionType', 'avg', PROJ_OPTIONS), num('group', 'group', 'dlg.stk.groupSize', depth, { min: 1 })],
      validate: (x) => (depth % clampInt(x.group, 1, depth) !== 0 ? { group: 'err.stkGroup' } : null) });
    if (!v) return;
    await api.run('stkGroupedZ', { method: v.projection, group: clampInt(v.group, 1, depth) }, { docId: info.docId, noRoi: true, labelKey: 'op.stkGroupedZ', placement: 'splitRight' });
  }

  async function insert(api) {
    const st = api.state();
    const docs = docsOf(st);
    if (docs.length < 2) { api.toast('err.stkNeedTwoImages'); return; }
    const v = await api.dialog({ title: api.tr('dlg.stk.insertTitle'), okLabel: OK(api), fields: [
      { type: 'doc', id: 'source', ijKey: 'source', labelKey: 'dlg.stk.source', value: docs[1].docId }, { type: 'doc', id: 'destination', ijKey: 'destination', labelKey: 'dlg.stk.destination', value: docs[0].docId },
      num('x', 'x', 'dlg.stk.xLocation', 0), num('y', 'y', 'dlg.stk.yLocation', 0)],
      validate: (x) => (x.source === x.destination ? { destination: 'dlg.stk.sameStack' } : null) });
    if (!v) return;
    const src = docs.find((d) => d.docId === v.source), dst = docs.find((d) => d.docId === v.destination);
    if (src.bitDepth !== dst.bitDepth || !!src.rgb !== !!dst.rgb) { api.toast('err.stkInsertType'); return; }
    await api.call('stk.insert', { dstId: v.destination, srcId: v.source, x: Math.trunc(v.x), y: Math.trunc(v.y) }, { labelKey: 'cmd.stackInsert', long: true });
  }

  async function substack(api) {
    const info = api.state().doc;
    if (!info) return;
    const d = dimsOf(info);
    const multi = isHyper(info) && (d.nC > 1 || (d.nZ > 1 && d.nT > 1));
    const note = { type: 'message', id: 'hint', labelKey: 'dlg.stk.rangeHint' };
    const fields = multi
      ? [note, str('channels', 'channels', 'dlg.stk.channelsField', '1-' + d.nC), str('slices', 'slices', 'dlg.stk.slicesField', '1-' + d.nZ), str('frames', 'frames', 'dlg.stk.framesField', '1-' + d.nT)]
      : [note, str('slices', 'slices', 'dlg.stk.slicesField', ''), check('delete', 'delete', 'dlg.stk.deleteOrig', false), check('do', 'do_not', 'dlg.stk.noCreate', false)];
    const v = await api.dialog({ title: api.tr(multi ? 'dlg.stk.subsetTitle' : 'dlg.stk.substackTitle'), okLabel: OK(api), fields });
    if (!v) return;
    const params = multi ? { channels: String(v.channels), slices: String(v.slices), frames: String(v.frames) } : { slices: String(v.slices).trim() };
    await api.run('stkSubstack', params, { docId: info.docId, noRoi: true, labelKey: 'op.stkSubstack', placement: 'tab' });
    if (!multi && v.delete) await api.run('stkDeleteRange', params, { docId: info.docId, noRoi: true, labelKey: 'op.stkSubstack' });
  }

  async function montageToStack(api) {
    const info = api.state().doc;
    if (!info) return;
    // the Info property a Make Montage image carries ("xMontage=2\nyMontage=2")
    let cols = 2, rows = 2;
    try { const l = api.label(info.docId) || ''; const mx = /xMontage=(\d+)/.exec(l), my = /yMontage=(\d+)/.exec(l); if (mx && my) { cols = +mx[1]; rows = +my[1]; } } catch (_) { /* no label */ }
    const v = await api.dialog({ title: api.tr('dlg.stk.stackMakerTitle'), okLabel: OK(api), fields: [
      num('columns', 'columns', 'dlg.stk.columns', cols, { min: 1 }), num('rows', 'rows', 'dlg.stk.rows', rows, { min: 1 }), num('border', 'border', 'dlg.stk.border', 0, { min: 0 })] });
    if (!v) return;
    await api.run('stkMontageToStack', { columns: Math.trunc(v.columns), rows: Math.trunc(v.rows), border: Math.trunc(v.border) }, { docId: info.docId, noRoi: true, labelKey: 'op.stkMontageToStack', placement: 'tab' });
  }

  async function reduce(api) {
    const info = api.state().doc;
    if (!info) return;
    const hyper = isHyper(info) && dimsOf(info).nZ > 1 && dimsOf(info).nT > 1;
    const fields = [num('reduction', 'reduction', 'dlg.stk.reduction', 2, { min: 1 })];
    if (hyper) fields.push(check('reduce', 'reduce', 'dlg.stk.reduceZ', false));
    const v = await api.dialog({ title: api.tr('dlg.stk.reduceTitle'), okLabel: OK(api), fields });
    if (!v) return;
    await api.run('stkReduce', { factor: Math.trunc(v.reduction), reduceZ: hyper ? !!v.reduce : false }, { docId: info.docId, noRoi: true, labelKey: 'op.stkReduce' });
  }

  async function removeLabels(api) { const i = api.state().doc; if (i) await api.run('stkRemoveLabels', {}, { docId: i.docId, noRoi: true, labelKey: 'op.stkRemoveLabels' }); }
  async function reverse(api) { const i = api.state().doc; if (i) await api.run('stkReverse', {}, { docId: i.docId, noRoi: true, labelKey: 'op.stkReverse' }); }

  /** Set Label... (ij.plugin.StackEditor "set label"): the label of the current slice; an empty text removes it. */
  async function setLabel(api) {
    const info = api.state().doc;
    if (!info) return;
    const d = dimsOf(info), p = api.position(info.docId);
    const n = p.t * d.nC * d.nZ + p.z * d.nC + (info.rgb ? 0 : p.c) + 1;
    let cur = '';
    try { cur = api.label(info.docId) || ''; } catch (_) { cur = ''; }
    const v = await api.dialog({ title: api.tr('dlg.stk.setLabelTitle', { n }), okLabel: OK(api), fields: [str('label', 'label', 'dlg.stk.label', cur)] });
    if (!v) return;
    await api.setLabel(n, String(v.label), { docId: info.docId });
  }

  // ───────────────────────────── Image > Hyperstacks ─────────────────────────────
  async function newHyperstack(api) {
    const TYPES = [{ value: '8', labelKey: 'dlg.stk.t8' }, { value: '16', labelKey: 'dlg.stk.t16' }, { value: '32', labelKey: 'dlg.stk.t32' }, { value: 'rgb', labelKey: 'dlg.stk.tRgb' }];
    const v = await api.dialog({ title: api.tr('dlg.stk.newHyperTitle'), okLabel: OK(api), fields: [
      str('name', 'name', 'dlg.stk.name', 'HyperStack'), choice('type', 'type', 'dlg.stk.typeLabel', '8', TYPES), choice('display', 'display', 'dlg.stk.display', 'color', DISPLAY_OPTIONS),
      num('width', 'width', 'dlg.stk.width', 400, { min: 1 }), num('height', 'height', 'dlg.stk.height', 300, { min: 1 }),
      num('channels', 'channels', 'dlg.stk.nChannels', 3, { min: 1 }), num('slices', 'slices', 'dlg.stk.nSlices', 4, { min: 1 }), num('frames', 'frames', 'dlg.stk.nFrames', 5, { min: 1 }),
      check('label', 'label', 'dlg.stk.labelImages', true)] });
    if (!v) return;
    const args = { name: String(v.name || 'HyperStack'), type: v.type, display: v.display, width: Math.trunc(v.width), height: Math.trunc(v.height),
      channels: Math.trunc(v.channels), slices: Math.trunc(v.slices), frames: Math.trunc(v.frames), label: !!v.label };
    const info = await api.call('stk.newHyperstack', args, { labelKey: 'cmd.hyperNew', long: true });
    if (info) await api.adopt(info, { placement: 'tab' });
  }

  async function stackToHyperstack(api) {
    const info = api.state().doc;
    if (!info) return;
    const d = dimsOf(info), n = nSl(info);
    const hyper = isHyper(info);
    const v = await api.dialog({ title: api.tr('dlg.stk.toHyperTitle'), okLabel: OK(api), fields: [
      choice('order', 'order', 'dlg.stk.orderLabel', 'xyczt', ORDERS.map((o) => ({ value: o, label: o + (o === 'xyczt' ? ' (default)' : '') }))),
      num('channels', 'channels', 'dlg.stk.nChannels', hyper ? d.nC : 1, { min: 1 }), num('slices', 'slices', 'dlg.stk.nSlices', hyper ? d.nZ : n, { min: 1 }),
      num('frames', 'frames', 'dlg.stk.nFrames', hyper ? d.nT : 1, { min: 1 }), choice('display', 'display', 'dlg.stk.display', 'color', DISPLAY_OPTIONS)],
      validate: (x) => (Math.trunc(x.channels) * Math.trunc(x.slices) * Math.trunc(x.frames) !== n ? { channels: 'err.stkBadDimensions' } : null) });
    if (!v) return;
    await api.run('stkToHyperstack', { order: v.order, channels: Math.trunc(v.channels), slices: Math.trunc(v.slices), frames: Math.trunc(v.frames), mode: v.display },
      { docId: info.docId, noRoi: true, labelKey: 'op.stkToHyperstack' });
  }
  async function hyperToStack(api) { const i = api.state().doc; if (i) await api.run('stkHyperToStack', {}, { docId: i.docId, noRoi: true, labelKey: 'op.stkHyperToStack' }); }

  async function reduceDimensionality(api) {
    const info = api.state().doc;
    if (!info) return;
    const d = dimsOf(info);
    const v = await api.dialog({ title: api.tr('dlg.stk.reduceDimTitle'), okLabel: OK(api), fields: [
      check('channels', 'channels', 'dlg.stk.channels', d.nC > 1, { visibleIf: () => d.nC > 1 }), check('slices', 'slices', 'dlg.stk.slices', d.nZ > 1, { visibleIf: () => d.nZ > 1 }),
      check('frames', 'frames', 'dlg.stk.frames', d.nT > 1, { visibleIf: () => d.nT > 1 }), check('keep', 'keep', 'dlg.stk.keepSource', true)] });
    if (!v) return;
    const params = { channels: d.nC > 1 && !!v.channels, slices: d.nZ > 1 && !!v.slices, frames: d.nT > 1 && !!v.frames };
    await api.run(v.keep ? 'stkReduceDimNew' : 'stkReduceDim', params, { docId: info.docId, noRoi: true, labelKey: 'op.stkReduceDim', placement: v.keep ? 'tab' : undefined });
  }

  async function reorderHyperstack(api) {
    const info = api.state().doc;
    if (!info) return;
    const AX = [{ value: 'c', labelKey: 'dlg.stk.axChannels' }, { value: 'z', labelKey: 'dlg.stk.axSlices' }, { value: 't', labelKey: 'dlg.stk.axFrames' }];
    const v = await api.dialog({ title: api.tr('dlg.stk.reorderTitle'), okLabel: OK(api), fields: [
      choice('c', 'channels', 'dlg.stk.nChannels', 'c', AX), choice('z', 'slices', 'dlg.stk.nSlices', 'z', AX), choice('t', 'frames', 'dlg.stk.nFrames', 't', AX)],
      validate: (x) => (new Set([x.c, x.z, x.t]).size !== 3 ? { c: 'err.stkReorderDup' } : null) });
    if (!v) return;
    await api.run('stkReorder', { order: v.c + v.z + v.t }, { docId: info.docId, noRoi: true, labelKey: 'op.stkReorder' });
  }

  // ───────────────────────────── Image > Type (colour types) / Image > Color ─────────────────────────────
  async function eightBitColor(api) {
    const info = api.state().doc;
    if (!info) return;
    const v = await api.dialog({ title: api.tr('dlg.stk.medianTitle'), okLabel: OK(api), fields: [num('number', 'number', 'dlg.stk.numColors', 256, { min: 2, max: 256 })] });
    if (!v) return;
    const colors = clampInt(v.number, 2, 256);
    const pal = await api.compute('stk8BitPalette', { colors }, { docId: info.docId, labelKey: 'op.stk8BitColor' });
    if (!pal) return;
    const name = 'MedianCut ' + fnv(pal.table);
    await api.registerLut(name, pal.table);
    await api.run('stk8BitColor', { colors, lutName: name }, { docId: info.docId, noRoi: true, labelKey: 'op.stk8BitColor' });
  }

  /** The "Convert to RGB" dialog of a composite (slices, frames, keep) — RGB Color and Stack to RGB. */
  async function toRgb(api, opName) {
    const st = api.state();
    const info = st.doc;
    if (!info) return;
    const d = dimsOf(info);
    let params = { slices: true, frames: true }, keep = false;
    if (d.nC > 1) {
      const v = await api.dialog({ title: api.tr('dlg.stk.toRgbTitle'), okLabel: OK(api), fields: [
        { type: 'message', id: 'hint', labelKey: 'dlg.stk.createHint' },
        check('slices', 'slices', 'dlg.stk.slices', true, { visibleIf: () => d.nZ > 1, label: api.tr('dlg.stk.slices') + ' (' + d.nZ + ')' }),
        check('frames', 'frames', 'dlg.stk.frames', true, { visibleIf: () => d.nT > 1, label: api.tr('dlg.stk.frames') + ' (' + d.nT + ')' }),
        check('keep', 'keep', 'dlg.stk.keepSource', false)] });
      if (!v) return;
      params = { slices: d.nZ > 1 ? !!v.slices : false, frames: d.nT > 1 ? !!v.frames : false };
      keep = !!v.keep;
    }
    // the display the operator sees (B&C ranges, LUTs, the channels ticked in the Channels tool, the mode): the engine's copy follows
    // the page through a coalescer and is not journaled
    if (!info.rgb && Array.isArray(info.channels)) {
      params.displays = info.channels.map((c) => { const dd = c.display || {}; return { min: dd.min, max: dd.max, lut: dd.lut === undefined ? null : dd.lut, invert: !!dd.invert }; });
      if (Array.isArray(info.visible) && info.visible.length === info.channels.length) params.visible = info.visible.map((x) => x !== false);
      if (typeof info.mode === 'string') params.mode = info.mode;
    }
    const op = opName === 'stack' ? (keep ? 'stkStackToRgb' : 'stkStackToRgbInPlace') : (keep ? 'stkRgbColor' : 'stkRgbColorInPlace');
    await api.run(op, params, { docId: info.docId, noRoi: true, labelKey: 'op.stkRgbColor', placement: keep ? 'tab' : undefined });
  }

  const inPlace = (op, labelKey) => async (api) => { const i = api.state().doc; if (i) await api.run(op, {}, { docId: i.docId, noRoi: true, labelKey }); };
  async function labStack(api) {
    const i = api.state().doc;
    if (!i) return;
    const res = await api.run('stkLabStack', {}, { docId: i.docId, noRoi: true, labelKey: 'op.stkLabStack', placement: 'tab' });
    if (res) await api.closeDoc(i.docId);
  }

  async function makeComposite(api) {
    const info = api.state().doc;
    if (!info) return;
    const d = dimsOf(info);
    let mode = 'composite';
    if (!info.rgb) {
      const v = await api.dialog({ title: api.tr('dlg.stk.makeCompositeTitle'), okLabel: OK(api), fields: [choice('display', 'display', 'dlg.stk.displayLbl', 'composite', DISPLAY_OPTIONS)] });
      if (!v) return;
      mode = v.display;
    }
    await api.run('stkMakeComposite', { mode }, { docId: info.docId, noRoi: true, labelKey: 'op.stkMakeComposite' });
    void d;
  }

  // ───────────────────────────── command table ─────────────────────────────
  const STK = ['Image', 'Stacks'], ANIM = ['Image', 'Stacks', 'Animation'], TOOLS = ['Image', 'Stacks', 'Tools'], HYPER = ['Image', 'Hyperstacks'], TYPE = ['Image', 'Type'];
  const hyperOnly = (st) => idle(st) && isHyper(st.doc);
  const two = (st) => !!st && !st.busy && docsOf(st).length >= 2;
  const commands = [
    { id: 'stackAddSlice', menu: STK, order: 10, enabled: idle, run: addSlice },
    { id: 'stackDeleteSlice', menu: STK, order: 20, enabled: stackIdle, run: deleteSlice },
    { id: 'stackNextSlice', menu: STK, order: 30, shortcut: '>', keys: ['>', '.'], enabled: stackIdle, run: (api) => stepSlice(api, 1) },
    { id: 'stackPreviousSlice', menu: STK, order: 40, shortcut: '<', keys: ['<', ','], enabled: stackIdle, run: (api) => stepSlice(api, -1) },
    { id: 'stackSetSlice', menu: STK, order: 50, enabled: stackIdle, run: setSlice },
    { id: 'stackImagesToStack', menu: STK, order: 60, separatorBefore: true, long: true, enabled: (st) => !!st && !st.busy && docsOf(st).some((d) => nSl(d) === 1), run: imagesToStack },
    { id: 'stackToImages', menu: STK, order: 70, long: true, enabled: stackIdle, run: stackToImages },
    { id: 'stackReslice', menu: STK, order: 90, shortcut: '/', keys: ['/'], long: true, enabled: stackIdle, run: reslice },
    { id: 'stackZProfile', menu: STK, order: 110, enabled: stackIdle, run: zProfile },
    { id: 'stackMeasure', menu: STK, order: 120, long: true, enabled: stackIdle, run: measureStack },
    { id: 'stackLabel', menu: STK, order: 130, enabled: idle, run: labelStack },
    { id: 'stackStatistics', menu: STK, order: 140, enabled: idle, run: stackStatistics },

    { id: 'stackStartAnimation', menu: ANIM, order: 10, shortcut: '\\', keys: ['\\'], enabled: stackIdle, run: toggleAnimation },
    { id: 'stackStopAnimation', menu: ANIM, order: 20, enabled: stackIdle, run: stopAnimation },
    { id: 'stackAnimationOptions', menu: ANIM, order: 30, enabled: stackIdle, run: animationOptions },

    { id: 'stackCombine', menu: TOOLS, order: 10, long: true, enabled: two, run: combine },
    { id: 'stackConcatenate', menu: TOOLS, order: 20, long: true, enabled: two, run: concatenate },
    { id: 'stackGroupedZ', menu: TOOLS, order: 30, long: true, enabled: stackIdle, run: groupedZProject },
    { id: 'stackInsert', menu: TOOLS, order: 40, long: true, enabled: two, run: insert },
    { id: 'stackSubstack', menu: TOOLS, order: 50, enabled: stackIdle, run: substack },
    { id: 'stackMontageToStack', menu: TOOLS, order: 60, enabled: idle, run: montageToStack },
    { id: 'stackReduce', menu: TOOLS, order: 70, enabled: stackIdle, run: reduce },
    { id: 'stackRemoveLabels', menu: TOOLS, order: 80, enabled: stackIdle, run: removeLabels },
    { id: 'stackReverse', menu: TOOLS, order: 90, enabled: stackIdle, run: reverse },
    { id: 'stackSetLabel', menu: TOOLS, order: 100, enabled: stackIdle, run: setLabel },

    { id: 'hyperNew', menu: HYPER, order: 10, long: true, enabled: (st) => !!st && !st.busy, run: newHyperstack },
    { id: 'hyperToHyper', menu: HYPER, order: 20, enabled: stackIdle, run: stackToHyperstack },
    { id: 'hyperToStack', menu: HYPER, order: 30, enabled: hyperOnly, run: hyperToStack },
    { id: 'hyperReduceDim', menu: HYPER, order: 40, enabled: hyperOnly, run: reduceDimensionality },
    { id: 'hyperSubset', menu: HYPER, order: 50, enabled: hyperOnly, run: substack },
    { id: 'hyperReorder', menu: HYPER, order: 60, enabled: hyperOnly, run: reorderHyperstack },

    { id: 'typeColor8', menu: TYPE, order: 40, enabled: (st) => idle(st) && isRgb(st.doc), run: eightBitColor },
    { id: 'typeRgb', menu: TYPE, order: 50, enabled: (st) => idle(st) && !isRgb(st.doc), run: (api) => toRgb(api, 'rgb') },
    { id: 'typeRgbStack', menu: TYPE, order: 60, separatorBefore: true, enabled: (st) => idle(st) && isRgb(st.doc), run: inPlace('stkRgbStack', 'op.stkRgbStack') },
    { id: 'typeHsbStack', menu: TYPE, order: 70, enabled: (st) => idle(st) && isRgb(st.doc), run: inPlace('stkHsbStack', 'op.stkHsbStack') },
    { id: 'typeHsb32', menu: TYPE, order: 80, enabled: (st) => idle(st) && isRgb(st.doc), run: inPlace('stkHsb32', 'op.stkHsb32') },
    { id: 'typeLabStack', menu: TYPE, order: 90, enabled: (st) => idle(st) && isRgb(st.doc) && nSl(st.doc) === 1, run: labStack },

    { id: 'colorStackToRgb', menu: ['Image', 'Color'], order: 42, enabled: (st) => idle(st) && !isRgb(st.doc) && (dimsOf(st.doc).nC > 1 || nSl(st.doc) === 3), run: (api) => toRgb(api, 'stack') },
    { id: 'colorMakeComposite', menu: ['Image', 'Color'], order: 44, enabled: (st) => idle(st) && (isRgb(st.doc) || (nSl(st.doc) >= 2 && nSl(st.doc) <= 8) || dimsOf(st.doc).nC > 1), run: makeComposite }
  ];

  // The hook of the page's Z Project command (ij-app.js stackProjectCommand): a stack projects here, a single plane keeps the figure's slab projection.
  root.IJStkCmds = { zProject, montage, labelText, ORDERS };

  IJApp.extend({
    pkg: 'stk',
    commands,
    errors: {
      IJ_STK_BAD_LIST: 'err.stkBadList',
      IJ_STK_NEEDS_STACK: 'err.stkNeedsStack',
      IJ_STK_NEEDS_TWO: 'err.stkNeedTwoImages',
      IJ_STK_NEEDS_SINGLE: 'err.stkNeedsSingle',
      IJ_STK_NEEDS_HYPERSTACK: 'err.stkNeedsHyperstack',
      IJ_STK_NO_HYPERSTACK: 'err.stkNoHyperstack',
      IJ_STK_NO_5D: 'err.stkNo5d',
      IJ_STK_LAST_OF_DIMENSION: 'err.stkLastOfDimension',
      IJ_STK_BAD_DIMENSIONS: 'err.stkBadDimensions',
      IJ_STK_RGB_ONE_CHANNEL: 'err.stkRgbOneChannel',
      IJ_STK_GROUP: 'err.stkGroup',
      IJ_STK_BAD_SPACING: 'err.stkBadSpacing'
    },
    columns: [['voxels', 'Voxels', 'area'], ['volume', 'Volume', 'voxels'], ['pctVolume', '%Volume', 'volume']]
  });
})(typeof self !== 'undefined' ? self : globalThis);
