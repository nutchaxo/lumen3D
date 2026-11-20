/* ij-proc-stk.js — package `stk`: Image > Stacks, Image > Hyperstacks, Image > Type, Image > Color (stack-aware parts).
 *
 * Loaded on the page AND in the worker (ij-worker.js loads it in its own try/catch: a failure here disables the package's
 * commands, it never takes the Advanced view down). Pure: no DOM; every operation is registered with IJOpRegistry.define.
 * Reference behaviour: ImageJ 1.54p (public domain), fixtures tests/fixtures/ij-stacks (tools/ij_fixtures/run4.sh).
 * Contract of the stack-aware documents: DOCS/studio-advanced/stacks/API.md.
 *
 * Vocabulary (API.md §1): a document has nC channels (nC = 1 for an RGB image: its three colour planes are the arrays of ONE
 * slice), nZ slices, nT frames. ImageJ's flat stack index (0-based here) is  n = t*nC*nZ + z*nC + c , a channel's plane list is
 * indexed pi = t*nZ + z.  Every operation below works on the flat list of SLICES: slice n = the array of storage arrays of that
 * stack position ([one array] for a grey image, [R, G, B] for an RGB one); `model(view)` reads the list, `assemble(o)` builds a
 * stack image (API.md §3) from one. Reordering, selecting, inserting and deleting slices is then a plain list operation, whatever
 * the type of the pixels, and the arrays are shared by reference (the engine never writes into an array it holds).
 *
 *   stkAddSlice stkDeleteSlice stkReverse stkReduce stkSubstack stkDeleteRange stkToHyperstack stkHyperToStack stkReduceDim
 *   stkReorder stkImagesToStack stkStackToImages stkConcatenate stkCombine stkInsert stkMontageToStack stkRemoveLabels
 *   stkZProject stkGroupedZ stkMontage stkReslice stkConvert stkRgbColor stk8BitColor stkRgbStack stkHsbStack stkHsb32 stkLabStack
 *   stkStackToRgb stkMakeComposite stkMergeRgb stkSplitRgb stkProfile stkStats
 * (the operations after the first block are in the second half of this file).
 */
(function (root) {
  'use strict';
  const R = root.IJOpRegistry;
  const S = root.IJStack;
  if (!R || !S) return;

  function ijError(code, message) { const e = new Error(message || code); e.code = code; return e; }
  const bad = (msg) => ijError('IJ_BAD_ARGS', msg);
  const isInt = Number.isInteger;
  function ctorOf(bd) { return bd === 8 ? Uint8Array : bd === 16 ? Uint16Array : Float32Array; }
  const bytesOf = (bd) => (bd === 8 ? 1 : bd === 16 ? 2 : 4);
  // Java (int) of a double: NaN -> 0, saturating, truncating toward zero.
  function d2i(x) {
    if (x !== x) return 0;
    if (x >= 2147483647) return 2147483647;
    if (x <= -2147483648) return -2147483648;
    return x < 0 ? Math.ceil(x) : Math.floor(x);
  }
  const RGB_CHANNELS = [{ name: 'Red', color: '#ff0000' }, { name: 'Green', color: '#00ff00' }, { name: 'Blue', color: '#0000ff' }];

  // ------------------------------------------------------------------------------------------------
  // The slice model
  // ------------------------------------------------------------------------------------------------

  /** The stack of a view as a flat list of slices (see the header). `hyper` = ImageJ would use the hyperstack code of the
   *  plugin (the image is a hyperstack or a multichannel / composite image). */
  function model(view) {
    const rgb = !!view.rgb;
    const nZ = view.nZ || 1, nT = view.nT || 1;
    const nC = rgb ? 1 : view.channels.length;
    const ch = view.channels;
    const m = {
      W: view.width, H: view.height, bd: view.bitDepth, rgb, nC, nZ, nT, N: nC * nZ * nT, hyper: !!view.hyperstack || nC > 1, view,
      // the openAsHyperStack flag of the document (an image of one dimension is not displayed as a hyperstack whatever the flag)
      flag: !!view.hyperstack,
      calibration: view.calibration ? Object.assign({}, view.calibration) : view.calibration,
      cur: { c: view.active || 0, z: view.z || 0, t: view.t || 0 },
      arrays(n) {
        const c = n % nC, pi = (n - c) / nC;
        return rgb ? [ch[0].planes[pi], ch[1].planes[pi], ch[2].planes[pi]] : [ch[c].planes[pi]];
      },
      label(n) { return view.labels && view.labels[n] !== undefined ? view.labels[n] : null; },
      index(c, z, t) { return t * nC * nZ + z * nC + c; },
      pos(n) { const c = n % nC, pi = (n - c) / nC, z = pi % nZ; return { c, z, t: (pi - z) / nZ }; },
      // the channel descriptions (name, colour, display range / LUT) of the channels of this image
      chans() { return ch.map((x) => ({ name: x.name, color: x.color, display: x.display ? Object.assign({}, x.display) : undefined })); }
    };
    m.curN = m.index(Math.min(m.cur.c, nC - 1), m.cur.z, m.cur.t);
    return m;
  }

  /** The slice list of `m` as an array. */
  function sliceList(m) { const out = new Array(m.N); for (let n = 0; n < m.N; n++) out[n] = m.arrays(n); return out; }
  function labelList(m) { if (!m.view.labels) return null; const out = new Array(m.N); for (let n = 0; n < m.N; n++) out[n] = m.label(n); return out; }

  /** A zero slice of the type of `m` (Add Slice: ImageJ's blank plane; see addSliceFill). */
  function blankSlice(m, fill) {
    const k = m.rgb ? 3 : 1, C = ctorOf(m.bd), out = [];
    for (let i = 0; i < k; i++) { const a = new C(m.W * m.H); if (fill) a.fill(fill); out.push(a); }
    return out;
  }

  /** A stack image (API.md §3) from a flat slice list. o: { name, W, H, bd, rgb, nC, nZ, nT, slices, labels?, calibration?, hyper?,
   *  chans?, mode?, active?, provenance? }. `hyper` is the openAsHyperStack flag: the result is shown as a hyperstack only when it
   *  still has two dimensions above 1 (ImagePlus.getNDimensions() > 3), which is what the fixtures show. */
  function assemble(o) {
    const { nC, nZ, nT, slices } = o;
    const NP = nZ * nT;
    if (slices.length !== nC * NP) throw ijError('IJ_BAD_RESULT', 'slice count');
    const out = { name: o.name, width: o.W, height: o.H, bitDepth: o.bd, nZ, nT, rgb: !!o.rgb };
    out.hyperstack = !!o.hyper && ((nC > 1 ? 1 : 0) + (nZ > 1 ? 1 : 0) + (nT > 1 ? 1 : 0)) >= 2;
    if (o.calibration !== undefined) out.calibration = o.calibration;
    if (o.labels !== undefined) out.labels = o.labels;
    if (o.mode) out.mode = o.mode;
    if (o.active !== undefined) out.active = o.active;
    if (o.provenance !== undefined) out.provenance = o.provenance;
    if (o.rgb) {
      out.channels = RGB_CHANNELS.map((d, k) => ({ name: d.name, color: d.color, planes: slices.map((s) => s[k]) }));
    } else {
      out.channels = [];
      for (let c = 0; c < nC; c++) {
        const planes = new Array(NP);
        for (let t = 0; t < nT; t++) for (let z = 0; z < nZ; z++) planes[t * nZ + z] = slices[t * nC * nZ + z * nC + c][0];
        const d = o.chans && o.chans[c] ? o.chans[c] : null;
        const ch = { name: d && d.name !== undefined ? d.name : 'C' + (c + 1), color: d && d.color !== undefined ? d.color : '#ffffff', planes };
        if (d && d.display) ch.display = Object.assign({}, d.display);
        out.channels.push(ch);
      }
    }
    return out;
  }

  /** Same-image result of a slice-list step: the dimensions / labels / channel list of `m` replaced by `o`. */
  function resultOf(m, o) {
    return assemble(Object.assign({ name: m.view.name, W: m.W, H: m.H, bd: m.bd, rgb: m.rgb, hyper: m.flag, calibration: m.calibration, chans: m.chans() }, o));
  }

  const hasLabel = (labels) => !!labels && labels.some((l) => l !== null && l !== undefined);

  /** The (nZ, nT) of a PLAIN stack of `n` slices after a step: a stack that was a series of frames (nZ = 1, nT > 1) stays one, any other
   *  is a z-stack — ImageJ keeps the (c, z, t) dimensions an ImagePlus was given even when it is not shown as a hyperstack. */
  function plainDims(m, n) { return m.nT > 1 && m.nZ === 1 ? { nZ: 1, nT: n } : { nZ: n, nT: 1 }; }
  /** Calibration.scaled(): true when the image has a spatial / temporal calibration (a step that scales a spacing leaves a pixel image alone). */
  function isScaled(c) { return !!c && (c.pixelWidth !== 1 || c.pixelHeight !== 1 || c.pixelDepth !== 1 || (c.frameInterval || 0) !== 0 || (c.unit !== 'pixel' && c.unit !== 'px' && c.unit !== undefined)); }

  /** Select / insert / reorder along the three dimensions: new[c][z][t] = old[selC[c]][selZ[z]][selT[t]], a null index = a blank slice.
   *  Labels travel with the slices (a blank one has none). Used by Add / Delete Slice, Make Subset, Reduce, Reduce Dimensionality, Stack
   *  to Images of a hyperstack... Returns { slices, labels, nC, nZ, nT, chans }. */
  function reindex(m, selC, selZ, selT, blankFill) {
    const nC = selC.length, nZ = selZ.length, nT = selT.length;
    const slices = [], labels = [];
    const srcLabels = m.view.labels;
    for (let t = 0; t < nT; t++) for (let z = 0; z < nZ; z++) for (let c = 0; c < nC; c++) {
      const sc = selC[c], sz = selZ[z], st = selT[t];
      if (sc === null || sz === null || st === null) { slices.push(blankSlice(m, blankFill)); labels.push(null); continue; }
      const n = m.index(sc, sz, st);
      slices.push(m.arrays(n));
      labels.push(srcLabels ? (srcLabels[n] === undefined ? null : srcLabels[n]) : null);
    }
    const chans = m.chans();
    return { slices, labels: hasLabel(labels) ? labels : null, nC, nZ, nT, chans: selC.map((c, i) => (c === null ? { name: 'C' + (i + 1), color: '#ffffff' } : chans[c])) };
  }
  const range0 = (n) => Array.from({ length: n }, (_, i) => i);

  // ------------------------------------------------------------------------------------------------
  // Number lists ("2-4", "1,3,5", "1-8-3") of Make Substack / Make Subset (ij.plugin.SubstackMaker)
  // ------------------------------------------------------------------------------------------------

  /** SubstackMaker's grammar: a range `first-last[-increment]` (a dash after the first character) or a comma list. 1-based, inside 1..max. */
  function parseIndexList(text, max) {
    const s = String(text === undefined || text === null ? '' : text).trim();
    const intOf = (x) => { const t = String(x).trim(); if (!/^[+-]?\d+$/.test(t)) throw ijError('IJ_STK_BAD_LIST', s); return parseInt(t, 10); };
    const out = [];
    const i1 = s.indexOf('-');
    if (i1 >= 1) {
      const i2 = s.indexOf('-', i1 + 1);
      const first = intOf(s.substring(0, i1));
      const last = intOf(i2 > 0 ? s.substring(i1 + 1, i2) : s.substring(i1 + 1));
      const inc = i2 > 0 ? intOf(s.substring(i2 + 1)) : 1;
      if (first < 1 || last > max || inc < 1) throw ijError('IJ_STK_BAD_LIST', s);
      for (let i = first; i <= last; i += inc) out.push(i);
    } else {
      for (const part of s.split(',')) {
        const v = intOf(part);
        if (v < 1 || v > max) throw ijError('IJ_STK_BAD_LIST', s);
        out.push(v);
      }
    }
    if (!out.length) throw ijError('IJ_STK_BAD_LIST', s);
    return out;
  }

  // ------------------------------------------------------------------------------------------------
  // Add Slice / Delete Slice   ij.plugin.StackEditor.addSlice / deleteSlice
  // ------------------------------------------------------------------------------------------------
  // Add Slice: "ip2 = ip.duplicate(); ip2.setColor(bg)": a blank slice of the image's type filled with the background of an image
  // with an inverting LUT (white) or black. `fill` is given by the command (the inverting LUT is display state, not pixels).
  R.define('stkAddSlice', {
    kind: 'size', version: 1, stack: 'whole', rgb: 'whole', roi: 'ignore',
    validate(params) {
      if (!params || ['slice', 'channel', 'frame'].indexOf(params.add || 'slice') < 0) throw bad('add');
    },
    scratchBytes: (info) => info.width * info.height * info.channels * bytesOf(info.bitDepth) * 2,
    async run(view, params, roi, io) {
      const m = model(view);
      const what = params.add || 'slice';
      const fill = Number(params.fill) || 0;
      let selC = range0(m.nC), selZ = range0(m.nZ), selT = range0(m.nT);
      const ins = (list, cur) => { const at = params.prepend ? 0 : cur + 1; const out = list.slice(); out.splice(at, 0, null); return out; };
      if (!m.hyper) {
        // a plain stack (or a single image): the new slice follows the current one; it is a z-stack of N + 1 slices
        const N = m.N, cur = Math.min(m.curN, N - 1);
        const slices = sliceList(m), labels = labelList(m) || new Array(N).fill(null);
        const at = params.prepend ? 0 : cur + 1;
        slices.splice(at, 0, blankSlice(m, fill)); labels.splice(at, 0, null);
        return resultOf(m, Object.assign({ slices, labels: hasLabel(labels) ? labels : null, nC: 1, hyper: false, chans: m.chans().slice(0, 1), active: 0 }, plainDims(m, N + 1)));
      }
      if (what === 'channel') selC = ins(selC, Math.min(m.cur.c, m.nC - 1));
      else if (what === 'slice') selZ = ins(selZ, m.cur.z);
      else selT = ins(selT, m.cur.t);
      const r = reindex(m, selC, selZ, selT, fill);
      return resultOf(m, Object.assign(r, { hyper: true, mode: m.view.mode === 'gray' && r.nC > 1 ? 'composite' : m.view.mode, active: Math.min(m.cur.c, r.nC - 1) }));
    }
  });

  // Delete Slice: a plain stack loses the current slice and the new current one is the previous slice (StackEditor.deleteSlice:
  // "n--; if (n < 1) n = 1"); a hyperstack asks which dimension (`delete`: channel | slice | frame) and deletes the current c / z / t.
  R.define('stkDeleteSlice', {
    kind: 'size', version: 1, stack: 'whole', rgb: 'whole', roi: 'ignore',
    validate(params, info) {
      if (params && params.delete !== undefined && ['slice', 'channel', 'frame'].indexOf(params.delete) < 0) throw bad('delete');
    },
    scratchBytes: () => 0,
    async run(view, params, roi, io) {
      const m = model(view);
      const what = params.delete || 'slice';
      if (!m.hyper) {
        if (m.N < 2) throw ijError('IJ_STK_NEEDS_STACK', 'stack required');
        const cur = Math.min(m.curN, m.N - 1);
        const slices = sliceList(m), labels = labelList(m);
        slices.splice(cur, 1); if (labels) labels.splice(cur, 1);
        return resultOf(m, Object.assign({ slices, labels: hasLabel(labels) ? labels : null, nC: 1, hyper: false, chans: m.chans().slice(0, 1) }, plainDims(m, m.N - 1)));
      }
      let selC = range0(m.nC), selZ = range0(m.nZ), selT = range0(m.nT);
      const drop = (list, cur) => { if (list.length < 2) return null; const out = list.slice(); out.splice(cur, 1); return out; };
      let r;
      if (what === 'channel') r = drop(selC, Math.min(m.cur.c, m.nC - 1)), selC = r;
      else if (what === 'slice') r = drop(selZ, m.cur.z), selZ = r;
      else r = drop(selT, m.cur.t), selT = r;
      if (!r) throw ijError('IJ_STK_LAST_OF_DIMENSION', 'cannot delete the last ' + what);
      const out = reindex(m, selC, selZ, selT);
      return resultOf(m, Object.assign(out, { hyper: true, mode: m.view.mode, active: Math.min(m.cur.c, out.nC - 1) }));
    }
  });

  // ------------------------------------------------------------------------------------------------
  // Reverse   ij.plugin.StackReverser (Image > Stacks > Tools > Reverse = Flip Z): not for a hyperstack
  // ------------------------------------------------------------------------------------------------
  R.define('stkReverse', {
    kind: 'size', version: 1, stack: 'whole', rgb: 'whole', roi: 'ignore',
    scratchBytes: () => 0,
    async run(view, params, roi, io) {
      const m = model(view);
      if (m.hyper && (m.nC > 1 || (m.nZ > 1 && m.nT > 1))) throw ijError('IJ_STK_NO_HYPERSTACK', 'not for hyperstacks');
      if (m.N < 2) throw ijError('IJ_STK_NEEDS_STACK', 'stack required');
      const slices = sliceList(m).reverse();
      const labels = labelList(m); if (labels) labels.reverse();
      return resultOf(m, { slices, labels, nC: m.nC, nZ: m.nZ, nT: m.nT, hyper: m.flag });
    }
  });

  // ------------------------------------------------------------------------------------------------
  // Reduce   ij.plugin.StackReducer: keep every `factor`-th slice (a hyperstack reduces frames, or slices with `reduceZ`)
  // ------------------------------------------------------------------------------------------------
  R.define('stkReduce', {
    kind: 'size', version: 1, stack: 'whole', rgb: 'whole', roi: 'ignore',
    validate(params) { if (!params || !isInt(params.factor) || params.factor < 1) throw bad('factor'); },
    scratchBytes: () => 0,
    async run(view, params, roi, io) {
      const m = model(view);
      const f = params.factor;
      if (f === 1) return null;
      const keep = (n) => { const out = []; for (let i = 0; i < n; i += f) out.push(i); return out; };
      const cal = m.calibration ? Object.assign({}, m.calibration) : m.calibration;
      if (!m.hyper) {
        // plain stack: every f-th slice (StackReducer: "if (cal.scaled()) cal.pixelDepth *= factor" for a z-stack)
        if (m.N < 2) throw ijError('IJ_STK_NEEDS_STACK', 'stack required');
        const idx = keep(m.N);
        const slices = sliceList(m), labels = labelList(m);
        const nl = labels ? idx.map((i) => labels[i]) : null;
        if (cal && m.nT === 1 && isScaled(cal)) cal.pixelDepth *= f;
        return resultOf(m, Object.assign({ slices: idx.map((i) => slices[i]), labels: nl, nC: 1, hyper: false, chans: m.chans().slice(0, 1), calibration: cal }, plainDims(m, idx.length)));
      }
      let selC = range0(m.nC), selZ = range0(m.nZ), selT = range0(m.nT);
      // a hyperstack reduces its frames, or its slices when asked or when it has no frames to reduce
      if (params.reduceZ || m.nT === 1) { selZ = keep(m.nZ); if (cal && isScaled(cal)) cal.pixelDepth *= f; } else selT = keep(m.nT);
      const r = reindex(m, selC, selZ, selT);
      return resultOf(m, Object.assign(r, { hyper: true, mode: m.view.mode, calibration: cal, active: Math.min(m.cur.c, r.nC - 1) }));
    }
  });

  // ------------------------------------------------------------------------------------------------
  // Make Substack / Make Subset   ij.plugin.SubstackMaker
  // params { slices } (plain) or { channels, slices, frames } (hyperstack): number lists as typed in the dialog
  // ------------------------------------------------------------------------------------------------
  function substackTitle(text) {
    let t = 'Substack (' + text + ')';
    if (t.length > 25) {
      const a = t.indexOf(','), b = t.lastIndexOf(',');
      if (a >= 1 && b >= 1) t = t.substring(0, a + 1) + ' ... ' + t.substring(b);
    }
    return t;
  }
  R.define('stkSubstack', {
    kind: 'newdoc', version: 1, stack: 'whole', rgb: 'whole', roi: 'ignore',
    validate(params) { if (!params || typeof params.slices !== 'string') throw bad('slices'); },
    scratchBytes: (info) => info.width * info.height * info.channels * bytesOf(info.bitDepth),
    async run(view, params, roi, io) {
      const m = model(view);
      if (!m.hyper || (m.nC === 1 && (m.nZ === 1 || m.nT === 1))) {
        const list = parseIndexList(params.slices, m.N).map((i) => i - 1);
        const slices = sliceList(m), labels = labelList(m);
        const nl = labels ? list.map((i) => labels[i]) : null;
        return [resultOf(m, { name: substackTitle(params.slices), slices: list.map((i) => slices[i]), labels: hasLabel(nl) ? nl : null, nC: 1, nZ: list.length, nT: 1, hyper: false, chans: m.chans().slice(0, 1) })];
      }
      const selC = parseIndexList(params.channels === undefined ? '1-' + m.nC : params.channels, m.nC).map((i) => i - 1);
      const selZ = parseIndexList(params.slices, m.nZ).map((i) => i - 1);
      const selT = parseIndexList(params.frames === undefined ? '1-' + m.nT : params.frames, m.nT).map((i) => i - 1);
      const r = reindex(m, selC, selZ, selT);
      return [resultOf(m, Object.assign(r, { name: m.view.name + '-1', hyper: true, mode: m.view.mode, active: 0 }))];
    }
  });

  // The `delete` option of Make Substack: the selected slices are removed from the source (SubstackMaker "delete").
  R.define('stkDeleteRange', {
    kind: 'size', version: 1, stack: 'whole', rgb: 'whole', roi: 'ignore',
    validate(params) { if (!params || typeof params.slices !== 'string') throw bad('slices'); },
    scratchBytes: () => 0,
    async run(view, params, roi, io) {
      const m = model(view);
      if (!m.hyper || (m.nC === 1 && (m.nZ === 1 || m.nT === 1))) {
        const drop = new Set(parseIndexList(params.slices, m.N).map((i) => i - 1));
        const keepIdx = range0(m.N).filter((i) => !drop.has(i));
        if (!keepIdx.length) throw ijError('IJ_STK_BAD_LIST', 'nothing left');
        const slices = sliceList(m), labels = labelList(m);
        const nl = labels ? keepIdx.map((i) => labels[i]) : null;
        return resultOf(m, { slices: keepIdx.map((i) => slices[i]), labels: nl, nC: 1, nZ: keepIdx.length, nT: 1, hyper: false, chans: m.chans().slice(0, 1) });
      }
      const dropC = new Set(parseIndexList(params.channels === undefined ? '1-' + m.nC : params.channels, m.nC).map((i) => i - 1));
      const dropZ = new Set(parseIndexList(params.slices, m.nZ).map((i) => i - 1));
      const dropT = new Set(parseIndexList(params.frames === undefined ? '1-' + m.nT : params.frames, m.nT).map((i) => i - 1));
      // delete only the (c,z,t) boxes that are in all three sets: ImageJ removes whole planes of the dimension the lists narrow
      const keepOf = (n, drop) => range0(n).filter((i) => !drop.has(i));
      const kc = dropC.size === m.nC ? range0(m.nC) : keepOf(m.nC, dropC);
      const kz = dropZ.size === m.nZ ? range0(m.nZ) : keepOf(m.nZ, dropZ);
      const kt = dropT.size === m.nT ? range0(m.nT) : keepOf(m.nT, dropT);
      const r = reindex(m, kc, kz, kt);
      return resultOf(m, Object.assign(r, { hyper: true, mode: m.view.mode, active: 0 }));
    }
  });

  // ------------------------------------------------------------------------------------------------
  // Stack to Hyperstack / Hyperstack to Stack / Reduce Dimensionality / Re-order Hyperstack
  // ------------------------------------------------------------------------------------------------
  const ORDERS = ['xyczt', 'xyctz', 'xyzct', 'xyztc', 'xytcz', 'xytzc'];

  /** The flat index (0-based) a slice has in the source stack for the position (c, z, t) of a stack ordered `order` (HyperStackConverter:
   *  the source stack is read as c fastest, then z, then t for xyczt; the other orders permute the three loops). */
  function orderStride(order, dims) {
    // order = 'xy' + the three letters from the FASTEST to the slowest varying dimension
    const letters = order.substring(2).split('');
    const stride = {};
    let s = 1;
    for (const l of letters) { stride[l] = s; s *= dims[l]; }
    return stride;
  }

  R.define('stkToHyperstack', {
    kind: 'size', version: 1, stack: 'whole', rgb: 'whole', roi: 'ignore',
    validate(params) {
      if (!params || ORDERS.indexOf(params.order || 'xyczt') < 0) throw bad('order');
      for (const k of ['channels', 'slices', 'frames']) if (!isInt(params[k]) || params[k] < 1) throw bad(k);
      if (params.mode !== undefined && ['composite', 'color', 'gray'].indexOf(params.mode) < 0) throw bad('mode');
    },
    scratchBytes: () => 0,
    async run(view, params, roi, io) {
      const m = model(view);
      const nC = params.channels, nZ = params.slices, nT = params.frames;
      if (nC * nZ * nT !== m.N) throw ijError('IJ_STK_BAD_DIMENSIONS', 'channels x slices x frames <> stack size');
      if (m.rgb && nC > 1) throw ijError('IJ_STK_RGB_ONE_CHANNEL', 'RGB stacks are limited to one channel');
      const order = params.order || 'xyczt';
      const stride = orderStride(order, { c: nC, z: nZ, t: nT });
      const src = sliceList(m), lab = labelList(m);
      const slices = [], labels = [];
      for (let t = 0; t < nT; t++) for (let z = 0; z < nZ; z++) for (let c = 0; c < nC; c++) {
        const i = c * stride.c + z * stride.z + t * stride.t;
        slices.push(src[i]); labels.push(lab ? lab[i] : null);
      }
      const chans = [];
      const old = m.chans();
      for (let c = 0; c < nC; c++) chans.push(old[c] && nC === m.nC ? old[c] : null);
      // ImageJ (HyperStackConverter.toHyperStack): "if (c>1) new CompositeImage(imp, mode)" — a one-channel image keeps its LUT; a
      // multichannel one gets the standard channel colours red, green, blue, gray, cyan, magenta, yellow (colour mode beyond 7)
      const COLORS = ['#ff0000', '#00ff00', '#0000ff', '#ffffff', '#00ffff', '#ff00ff', '#ffff00'];
      const mode = params.mode || 'composite';
      for (let c = 0; c < nC; c++) {
        if (nC > 1 && !m.rgb) chans[c] = { name: 'C' + (c + 1), color: nC <= 7 ? COLORS[c] : '#ffffff', display: chans[c] ? chans[c].display : undefined };
        if (nC > 1 && chans[c] && chans[c].display && m.bd !== 32) { /* keep the range */ }
      }
      const cal = m.calibration ? Object.assign({}, m.calibration) : m.calibration;
      return resultOf(m, { slices, labels: hasLabel(labels) ? labels : null, nC, nZ, nT, hyper: true, chans: m.rgb ? undefined : chans,
        mode: nC > 1 ? (nC > 7 && mode === 'composite' ? 'color' : mode) : undefined, calibration: cal, active: 0 });
    }
  });

  R.define('stkHyperToStack', {
    kind: 'size', version: 1, stack: 'whole', rgb: 'whole', roi: 'ignore',
    scratchBytes: () => 0,
    async run(view, params, roi, io) {
      const m = model(view);
      if (!m.hyper) throw ijError('IJ_STK_NEEDS_HYPERSTACK', 'hyperstack required');
      // the slices keep their ImageJ order and labels; the image is no longer composite: one plain stack of N slices
      return resultOf(m, { slices: sliceList(m), labels: labelList(m), nC: 1, nZ: m.N, nT: 1, hyper: false, chans: m.chans().slice(0, 1), active: 0 });
    }
  });

  // Reduce Dimensionality: a CHECKED dimension is kept, an unchecked one is taken at the current position; `keep` = a new image.
  function reduceDim(view, params) {
    const m = model(view);
    if (!m.hyper) throw ijError('IJ_STK_NEEDS_HYPERSTACK', 'hyperstack required');
    const keepC = params.channels !== false && m.nC > 1, keepZ = params.slices !== false && m.nZ > 1, keepT = params.frames !== false && m.nT > 1;
    const curC = Math.min(m.cur.c, m.nC - 1);
    const r = reindex(m, keepC ? range0(m.nC) : [curC], keepZ ? range0(m.nZ) : [m.cur.z], keepT ? range0(m.nT) : [m.cur.t]);
    return resultOf(m, Object.assign(r, { hyper: true, mode: m.view.mode, active: keepC ? curC : 0 }));
  }
  R.define('stkReduceDim', {
    kind: 'size', version: 1, stack: 'whole', rgb: 'whole', roi: 'ignore', scratchBytes: () => 0,
    async run(view, params) { return reduceDim(view, params || {}); }
  });
  R.define('stkReduceDimNew', {
    kind: 'newdoc', version: 1, stack: 'whole', rgb: 'whole', roi: 'ignore', scratchBytes: () => 0,
    async run(view, params) { const r = reduceDim(view, params || {}); r.name = view.name + '-1'; return [r]; }
  });

  // Re-order Hyperstack ... (Fiji's HyperStackReorder): the three dimensions are exchanged; `order` = the new meaning of (c, z, t),
  // a permutation of 'czt' read as "channels become X, slices become Y, frames become Z".
  R.define('stkReorder', {
    kind: 'size', version: 1, stack: 'whole', rgb: 'whole', roi: 'ignore',
    validate(params) { if (!params || !/^[czt]{3}$/.test(params.order || '') || new Set(params.order.split('')).size !== 3) throw bad('order'); },
    scratchBytes: () => 0,
    async run(view, params) {
      const m = model(view);
      if (!m.hyper) throw ijError('IJ_STK_NEEDS_HYPERSTACK', 'hyperstack required');
      const dims = { c: m.nC, z: m.nZ, t: m.nT };
      const [a, b, c3] = params.order.split('');      // new channels = old a, new slices = old b, new frames = old c3
      const nC = dims[a], nZ = dims[b], nT = dims[c3];
      const src = sliceList(m), lab = labelList(m);
      const slices = [], labels = [];
      for (let t = 0; t < nT; t++) for (let z = 0; z < nZ; z++) for (let c = 0; c < nC; c++) {
        const o = { c: 0, z: 0, t: 0 }; o[a] = c; o[b] = z; o[c3] = t;
        const n = m.index(o.c, o.z, o.t);
        slices.push(src[n]); labels.push(lab ? lab[n] : null);
      }
      const cal = m.calibration ? Object.assign({}, m.calibration) : m.calibration;
      const chans = [];
      for (let c = 0; c < nC; c++) chans.push(a === 'c' ? m.chans()[c] : null);
      return resultOf(m, { slices, labels: hasLabel(labels) ? labels : null, nC, nZ, nT, hyper: true, chans, calibration: cal, mode: nC > 1 ? (m.view.mode === 'gray' ? 'composite' : m.view.mode) : undefined, active: 0 });
    }
  });

  // ------------------------------------------------------------------------------------------------
  // Labels   ij.ImageStack.getShortSliceLabel / Remove Slice Labels
  // ------------------------------------------------------------------------------------------------
  /** ImageStack.getShortSliceLabel(n): the label up to its first line, without a 3-letter extension, at most 60 characters; null when empty. */
  function shortLabel(label) {
    if (label === null || label === undefined) return null;
    let s = String(label);
    const nl = s.indexOf('\n');
    if (nl === 0) return null;
    if (nl > 0) s = s.substring(0, nl);
    const len = s.length;
    if (len > 4 && s.charAt(len - 4) === '.' && !/[0-9]/.test(s.charAt(len - 1))) s = s.substring(0, len - 4);
    if (s.length > 60) s = s.substring(0, 60);
    return s;
  }
  const pad4 = (n) => { let t = String(n); while (t.length < 4) t = '0' + t; return t; };

  // Remove Slice Labels (ij.plugin.StackEditor "remove"): every label of the stack is dropped.
  R.define('stkRemoveLabels', {
    kind: 'size', version: 1, stack: 'whole', rgb: 'whole', roi: 'ignore', scratchBytes: () => 0,
    async run(view) {
      const m = model(view);
      if (!view.labels) return null;
      return resultOf(m, { slices: sliceList(m), labels: null, nC: m.nC, nZ: m.nZ, nT: m.nT, hyper: m.flag, mode: view.mode, active: m.cur.c });
    }
  });

  // ------------------------------------------------------------------------------------------------
  // Images to Stack   ij.plugin.ImagesToStack
  // docIds = the images in window order (the command picks them from the title filter); params
  //   { method: 'center' | 'topleft' | 'smallest' | 'largest', name, useTitles, bicubic, fill: 'black' | 'white' }
  // ------------------------------------------------------------------------------------------------
  function viewsOf(io, view) {
    const out = [];
    for (const id of io.docIds) out.push(id === view.id ? view : io.readDoc(id));
    return out;
  }
  /** A copy of a `w x h` plane inside a `W x H` canvas at (xo, yo) filled with `fill` (ImageProcessor.insert, clipped). */
  function paste(src, w, h, W, H, xo, yo, fill, C) {
    const out = new C(W * H);
    if (fill) out.fill(fill);
    for (let y = 0; y < h; y++) {
      const dy = y + yo;
      if (dy < 0 || dy >= H) continue;
      const x0 = Math.max(0, -xo), x1 = Math.min(w, W - xo);
      if (x1 <= x0) continue;
      out.set(src.subarray(y * w + x0, y * w + x1), dy * W + xo + x0);
    }
    return out;
  }
  const WHITE = (bd, rgb) => (rgb || bd === 8 ? 255 : bd === 16 ? 65535 : 1);

  /** A plane widened to the `to` depth for a stack of mixed depths: ImagesToStack copies the values (convertToShort(false) / convertToFloat). */
  function widen(a, to) {
    if (a.constructor === ctorOf(to)) return a;
    const out = new (ctorOf(to))(a.length);
    for (let i = 0; i < a.length; i++) out[i] = a[i];
    return out;
  }

  async function resizePlane(a, w, h, bd, dw, dh, bicubic, averaging) {
    const G = root.IJGeom;
    if (!G || !G.kernels || !G.kernels.resizeImage) throw ijError('IJ_MODULE_MISSING', 'geometry package');
    return G.kernels.resizeImage(a, w, h, bd, { x: 0, y: 0, w, h }, dw, dh, bicubic ? 2 : 1, !!averaging, null);
  }

  R.define('stkImagesToStack', {
    kind: 'newdoc', version: 1, stack: 'plane', rgb: 'whole', roi: 'ignore',
    validate(params) { if (params && params.method !== undefined && ['center', 'topleft', 'smallest', 'largest'].indexOf(params.method) < 0) throw bad('method'); },
    scratchBytes: (info) => info.width * info.height * info.channels * bytesOf(info.bitDepth) * 3,
    async run(view, params, roi, io) {
      const vs = viewsOf(io, view);
      if (vs.length < 1) throw ijError('IJ_STK_NEEDS_TWO', 'an image');
      const first = vs[0];
      const rgb = !!first.rgb;
      for (const v of vs) if (!!v.rgb !== rgb) throw ijError('IJ_BAD_TYPE', 'RGB and other types cannot be mixed');
      const to = Math.max.apply(null, vs.map((v) => v.bitDepth));
      let W = 0, H = 0, w0 = Infinity, h0 = Infinity;
      for (const v of vs) { W = Math.max(W, v.width); H = Math.max(H, v.height); w0 = Math.min(w0, v.width); h0 = Math.min(h0, v.height); }
      const method = params.method || 'center';
      const different = vs.some((v) => v.width !== vs[0].width || v.height !== vs[0].height);
      const outW = !different ? first.width : (method === 'smallest' ? w0 : W), outH = !different ? first.height : (method === 'smallest' ? h0 : H);
      const slices = [], labels = [];
      const white = params.fill === 'white' ? WHITE(to, rgb) : 0;
      let k = 0;
      for (const v of vs) {
        const mm = model(v);
        for (let n = 0; n < mm.N; n++) {
          const arrs = mm.arrays(n).map((a) => widen(a, to));
          let outArrs;
          if (!different) outArrs = arrs;
          else if (method === 'center' || method === 'topleft') {
            const xo = method === 'center' ? ((outW - v.width) / 2) | 0 : 0, yo = method === 'center' ? ((outH - v.height) / 2) | 0 : 0;
            outArrs = arrs.map((a) => paste(a, v.width, v.height, outW, outH, xo, yo, white, ctorOf(to)));
          } else {
            outArrs = [];
            for (const a of arrs) outArrs.push(v.width === outW && v.height === outH ? a : await resizePlane(a, v.width, v.height, to, outW, outH, params.bicubic));
          }
          slices.push(outArrs);
          labels.push(params.useTitles ? (mm.N === 1 ? v.name : (mm.label(n) || v.name)) : (mm.N > 1 ? mm.label(n) : null));
        }
        io.check();
        await io.tick(++k / vs.length, 'op.stkImagesToStack');
      }
      const cal = first.calibration ? Object.assign({}, first.calibration) : first.calibration;
      return [assemble({ name: params.name || 'Stack', W: outW, H: outH, bd: to, rgb, nC: 1, nZ: slices.length, nT: 1, slices, labels: hasLabel(labels) ? labels : null, calibration: cal, hyper: false, chans: [{ name: 'C1', color: '#ffffff' }] })];
    }
  });

  // ------------------------------------------------------------------------------------------------
  // Stack to Images   ij.plugin.StackEditor.convertStackToImages: one image per slice, named by its short label, else title-0001
  // ------------------------------------------------------------------------------------------------
  R.define('stkStackToImages', {
    kind: 'newdoc', version: 1, stack: 'whole', rgb: 'whole', roi: 'ignore',
    scratchBytes: () => 0,
    async run(view, params, roi, io) {
      const m = model(view);
      if (m.N < 2) throw ijError('IJ_STK_NEEDS_STACK', 'stack required');
      const out = [];
      for (let n = 0; n < m.N; n++) {
        const label = shortLabel(m.label(n));
        const name = label !== null && label !== '' ? label : m.view.name + '-' + pad4(n + 1);
        const d = m.chans()[m.rgb ? 0 : n % m.nC];
        out.push(assemble({ name, W: m.W, H: m.H, bd: m.bd, rgb: m.rgb, nC: 1, nZ: 1, nT: 1, slices: [m.arrays(n)],
          calibration: m.calibration ? Object.assign({}, m.calibration) : m.calibration, hyper: false, chans: [d ? { name: d.name, color: d.color } : null] }));
      }
      return out;
    }
  });

  // ------------------------------------------------------------------------------------------------
  // Concatenate   ij.plugin.Concatenator: docIds in order; images whose type differs from the first are omitted
  // params { title, open4D } — open4D (the "open as 4D image" box) puts the images along the frames when they all have the same c and z
  // ------------------------------------------------------------------------------------------------
  R.define('stkConcatenate', {
    kind: 'newdoc', version: 1, stack: 'plane', rgb: 'whole', roi: 'ignore',
    scratchBytes: (info) => info.width * info.height * info.channels * bytesOf(info.bitDepth) * 2,
    async run(view, params, roi, io) {
      let vs = viewsOf(io, view);
      const first = vs[0];
      vs = vs.filter((v) => v === first || (v.bitDepth === first.bitDepth && !!v.rgb === !!first.rgb));
      const ms = vs.map(model);
      let W = 0, H = 0;
      for (const v of vs) { W = Math.max(W, v.width); H = Math.max(H, v.height); }
      const slices = [], labels = [];
      let k = 0;
      for (const mm of ms) {
        for (let n = 0; n < mm.N; n++) {
          let arrs = mm.arrays(n);
          if (mm.W !== W || mm.H !== H) arrs = arrs.map((a) => paste(a, mm.W, mm.H, W, H, ((W - mm.W) / 2) | 0, ((H - mm.H) / 2) | 0, 0, ctorOf(mm.bd)));
          slices.push(arrs); labels.push(mm.label(n));
        }
        io.check();
        await io.tick(++k / ms.length, 'op.stkConcatenate');
      }
      const m0 = ms[0];
      const sameC = ms.every((mm) => mm.nC === m0.nC);
      // Hyperstacks with the same channels and slices run on along the frames (Concatenator's 4D case); so do single-slice
      // series of frames and, with the "4D" box, stacks of one common size (each image becomes one frame).
      const allHyper = sameC && ms.every((mm) => mm.hyper && mm.nZ === m0.nZ);
      const seriesOfFrames = params.open4D && sameC && ms.every((mm) => mm.nZ === 1 && mm.nC === m0.nC);
      const sameStacks = params.open4D && sameC && ms.every((mm) => mm.N === m0.N);
      let nC = m0.nC, nZ, nT;
      if (allHyper) { nZ = m0.nZ; nT = ms.reduce((s, mm) => s + mm.nT, 0); }
      else if (seriesOfFrames) { nZ = 1; nT = ms.reduce((s, mm) => s + mm.nT * mm.nZ, 0); }
      else if (sameStacks) { nZ = m0.N / m0.nC; nT = ms.length; }
      else { nC = 1; nZ = slices.length; nT = 1; }
      const cal = m0.calibration ? Object.assign({}, m0.calibration) : m0.calibration;
      return [assemble({ name: params.title || 'Untitled', W, H, bd: m0.bd, rgb: m0.rgb, nC, nZ, nT, slices, labels: hasLabel(labels) ? labels : null, calibration: cal,
        hyper: allHyper || (nT > 1 && nZ > 1) || nC > 1, chans: nC > 1 ? m0.chans() : [{ name: 'C1', color: '#ffffff' }], mode: nC > 1 ? m0.view.mode : undefined })];
    }
  });

  // ------------------------------------------------------------------------------------------------
  // Combine   ij.plugin.StackCombiner: docIds = [stack1, stack2]; params { vertical }
  // ------------------------------------------------------------------------------------------------
  R.define('stkCombine', {
    kind: 'newdoc', version: 1, stack: 'plane', rgb: 'whole', roi: 'ignore',
    scratchBytes: (info) => info.width * info.height * info.channels * bytesOf(info.bitDepth) * 3,
    async run(view, params, roi, io) {
      const vs = viewsOf(io, view);
      if (vs.length !== 2) throw ijError('IJ_STK_NEEDS_TWO', 'two stacks');
      const [a, b] = vs.map(model);
      if (a.bd !== b.bd || a.rgb !== b.rgb) throw ijError('IJ_BAD_TYPE', 'the stacks must be of the same type');
      const vertical = !!params.vertical;
      const W = vertical ? Math.max(a.W, b.W) : a.W + b.W, H = vertical ? a.H + b.H : Math.max(a.H, b.H);
      const d = Math.max(a.N, b.N), C = ctorOf(a.bd), k = a.rgb ? 3 : 1;
      const slices = [];
      for (let i = 0; i < d; i++) {
        const out = [];
        for (let ch = 0; ch < k; ch++) {
          const o = new C(W * H);
          // StackCombiner.combineHorizontally / combineVertically: ip3 = ip.createProcessor(w3, h3), the two slices inserted at (0, 0) and (w1, 0) / (0, h1)
          if (i < a.N) for (let y = 0; y < a.H; y++) o.set(a.arrays(i)[ch].subarray(y * a.W, (y + 1) * a.W), y * W);
          if (i < b.N) for (let y = 0; y < b.H; y++) o.set(b.arrays(i)[ch].subarray(y * b.W, (y + 1) * b.W), vertical ? (y + a.H) * W : y * W + a.W);
          out.push(o);
        }
        slices.push(out);
        if ((i & 7) === 7) { io.check(); await io.tick((i + 1) / d, 'op.stkCombine'); }
      }
      const cal = a.calibration ? Object.assign({}, a.calibration) : a.calibration;
      return [assemble({ name: 'Combined Stacks', W, H, bd: a.bd, rgb: a.rgb, nC: 1, nZ: d, nT: 1, slices, calibration: cal, hyper: false, chans: [{ name: 'C1', color: '#ffffff' }] })];
    }
  });

  // ------------------------------------------------------------------------------------------------
  // Montage to Stack   ij.plugin.StackMaker.makeStack: params { columns, rows, border }
  // ------------------------------------------------------------------------------------------------
  R.define('stkMontageToStack', {
    kind: 'newdoc', version: 1, stack: 'plane', rgb: 'whole', roi: 'ignore',
    validate(params) {
      if (!params || !isInt(params.columns) || params.columns < 1 || !isInt(params.rows) || params.rows < 1 || (params.border !== undefined && (!isInt(params.border) || params.border < 0))) throw bad('montage');
    },
    scratchBytes: (info) => info.width * info.height * info.channels * bytesOf(info.bitDepth),
    async run(view, params, roi, io) {
      const m = model(view);
      if (m.N !== 1) throw ijError('IJ_STK_NEEDS_SINGLE', 'single image required');
      const cols = params.columns, rows = params.rows, border = params.border || 0;
      // "tileWidth = ip.getWidth()/columns; tileHeight = ip.getHeight()/rows" (int); with a border each tile is cropped at
      // (border, border, tileWidth-border-border/2, tileHeight-border-border/2) (StackProcessor.crop)
      const tw = Math.floor(m.W / cols), th = Math.floor(m.H / rows);
      const w = border > 0 ? tw - border - (border >> 1) : tw, h = border > 0 ? th - border - (border >> 1) : th;
      if (w < 1 || h < 1) throw bad('tile size');
      const ox = border > 0 ? border : 0, oy = border > 0 ? border : 0;
      const src = m.arrays(0), C = ctorOf(m.bd);
      const slices = [];
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
        slices.push(src.map((a) => {
          const o = new C(w * h);
          for (let y = 0; y < h; y++) { const so = (r * th + oy + y) * m.W + c * tw + ox; o.set(a.subarray(so, so + w), y * w); }
          return o;
        }));
      }
      // the new image has no calibration (StackMaker: "new ImagePlus(title, stack)")
      const cal = { pixelWidth: 1, pixelHeight: 1, pixelDepth: 1, unit: 'pixel' };
      return [assemble({ name: 'Stack', W: w, H: h, bd: m.bd, rgb: m.rgb, nC: 1, nZ: slices.length, nT: 1, slices, calibration: cal, hyper: false, chans: [{ name: 'C1', color: '#ffffff' }] })];
    }
  });

  // ------------------------------------------------------------------------------------------------
  // Insert   ij.plugin.StackInserter: a worker command (the destination keeps its identity and gets ONE undo step through E.commitPlanes)
  //   args { dstId, srcId, x, y } — slice i of the source is pasted into slice i of the destination (the last source slice serves the rest)
  // ------------------------------------------------------------------------------------------------
  function insertPlanes(dst, src, x, y) {
    const md = model(dst), ms = model(src);
    if (md.bd !== ms.bd || md.rgb !== ms.rgb) throw ijError('IJ_BAD_TYPE', 'the source and destination must be the same type');
    const out = [];
    // StackInserter: every slice of the destination gets slice i of the source, the last one beyond the end of a shorter source
    for (let i = 0; i < md.N; i++) {
      const da = md.arrays(i), sa = ms.arrays(Math.min(i, ms.N - 1)), p = md.pos(i);
      for (let k = 0; k < da.length; k++) {
        const o = da[k].slice();
        for (let yy = 0; yy < ms.H; yy++) {
          const dy = yy + y;
          if (dy < 0 || dy >= md.H) continue;
          const x0 = Math.max(0, -x), x1 = Math.min(ms.W, md.W - x);
          if (x1 > x0) o.set(sa[k].subarray(yy * ms.W + x0, yy * ms.W + x1), dy * md.W + x + x0);
        }
        out.push({ c: md.rgb ? k : p.c, z: p.z, t: p.t, data: o });
      }
    }
    return out;
  }
  if (typeof R.defineCommand === 'function') {
    R.defineCommand('stk.insert', {
      pkg: 'stk', long: true,
      async handler(args, E) {
        if (!args || !isInt(args.x) || !isInt(args.y)) throw bad('position');
        const dst = E.readDoc(args.dstId), src = E.readDoc(args.srcId);
        const list = insertPlanes(dst, src, args.x, args.y);
        if (!list.length) throw bad('nothing to insert');
        return Object.assign({ docId: args.dstId }, await E.commitPlanes(args.dstId, list, { labelKey: 'cmd.stackInsert' }));
      }
    });
  }

  // ------------------------------------------------------------------------------------------------
  // Z Project   ij.plugin.ZProjector  (reuses IJProject, the band streaming projector of ij-core.js, one plane per block)
  // params { start, stop (1-based slices), method: avg | max | min | sum | sd | median, allFrames }
  // ------------------------------------------------------------------------------------------------
  const PROJ_METHODS = ['avg', 'max', 'min', 'sum', 'sd', 'median'];
  const PROJ_PREFIX = { avg: 'AVG_', max: 'MAX_', min: 'MIN_', sum: 'SUM_', sd: 'STD_', median: 'MED_' };

  /** One projection of the planes `planes` (typed arrays of the depth `bd`): { data, bitDepth }. */
  function projectPlanes(planes, method, bd, W, H) {
    const P = root.IJProject;
    if (!P) throw ijError('IJ_MODULE_MISSING', 'projection');
    const pr = P.create({ method, width: W, height: H, depth: planes.length, channels: 1, inputBitDepth: bd });
    for (let z = 0; z < planes.length; z++) pr.addBlock({ channel: 0, y0: 0, rows: H, z0: z, depth: 1, data: planes[z] });
    return pr.finish()[0];
  }
  /** The 32-bit float result of a Sum / SD projection of an RGB stack scaled to bytes, as ZProjector.doRGBProjection does for the three
   *  colour projections together: they are multiplied by (float)(255 / the largest value of the three), then each is converted to 8 bits
   *  over its own [min, max] (FloatProcessor.create8BitImage). */
  function rgbFloatToBytes(fs) {
    let mx = 0;
    for (const f of fs) for (let i = 0; i < f.length; i++) if (f[i] > mx) mx = f[i];
    const scale = Math.fround(255.0 / mx);
    return fs.map((f) => {
      const g = new Float32Array(f.length);
      let mn = Infinity, hi = -Infinity;
      for (let i = 0; i < f.length; i++) { g[i] = Math.fround(f[i] * scale); if (g[i] < mn) mn = g[i]; if (g[i] > hi) hi = g[i]; }
      const sc = 255.0 / (Math.fround(hi) - Math.fround(mn));
      const out = new Uint8Array(f.length);
      for (let i = 0; i < f.length; i++) {
        let v = g[i] - Math.fround(mn);
        if (v < 0) v = 0;
        const q = d2i(v * sc + 0.5);
        out[i] = q > 255 ? 255 : q;
      }
      return out;
    });
  }

  function zProjectShape(m, params) {
    const method = params.method;
    if (PROJ_METHODS.indexOf(method) < 0) throw bad('method');
    const depth = m.hyper ? m.nZ : m.N;
    let start = isInt(params.start) ? params.start : 1, stop = isInt(params.stop) ? params.stop : depth;
    if (start < 1) start = 1;
    if (stop > depth) stop = depth;
    // start > stop: ZProjector's loop runs over no slice and the projection stays blank (zeros)
    return { method, start, stop, depth, empty: start > stop };
  }

  R.define('stkZProject', {
    kind: 'newdoc', version: 1, stack: 'whole', rgb: 'whole', roi: 'ignore',
    validate(params) {
      if (!params || PROJ_METHODS.indexOf(params.method) < 0) throw bad('method');
      for (const k of ['start', 'stop']) if (params[k] !== undefined && !isInt(params[k])) throw bad(k);
    },
    scratchBytes: (info) => info.width * info.height * info.channels * 8,
    async run(view, params, roi, io) {
      const m = model(view);
      const sh = zProjectShape(m, params);
      const { method } = sh;
      const z0 = sh.start - 1, z1 = sh.stop;
      const projectSlices = (list) => {
        if (sh.empty) { const od = root.IJProject.outputBitDepth(method, 1, m.bd); return { arrs: (m.rgb ? [0, 1, 2] : [0]).map(() => new (ctorOf(m.rgb ? 8 : od))(m.W * m.H)), bd: m.rgb ? 8 : od }; }
        // list = the slices (arrays of storage arrays) to project, in order; returns the storage arrays of the result and its bit depth
        const k = list[0].length;
        const outs = [];
        let obd = m.bd;
        for (let j = 0; j < k; j++) {
          const r = projectPlanes(list.map((s) => s[j]), method, m.bd, m.W, m.H);
          outs.push(r.data); obd = r.bitDepth;
        }
        if (m.rgb && obd === 32) return { arrs: rgbFloatToBytes(outs), bd: 8 };
        return { arrs: outs, bd: obd };
      };
      const cal = m.calibration ? Object.assign({}, m.calibration) : m.calibration;
      const name = PROJ_PREFIX[method] + m.view.name;
      let obd = m.bd, slices = [], nC = 1, nT = 1;
      if (m.hyper) {
        const frames = params.allFrames && m.nT > 1 ? range0(m.nT) : [m.cur.t];
        nC = m.nC; nT = frames.length;
        let k = 0;
        for (const t of frames) for (let c = 0; c < nC; c++) {
          const list = [];
          for (let z = z0; z < z1; z++) list.push(m.arrays(m.index(c, z, t)));
          const r = projectSlices(list);
          obd = r.bd; slices.push(r.arrs);
          io.check();
          await io.tick(++k / (frames.length * nC), 'op.stkZProject');
        }
      } else {
        const list = [];
        for (let n = z0; n < z1; n++) list.push(m.arrays(n));
        const r = projectSlices(list);
        obd = r.bd; slices = [r.arrs];
      }
      const rgb = m.rgb;
      const keepRange = obd === m.bd && !rgb && (method === 'max' || method === 'min' || method === 'avg' || method === 'median');
      const chans = m.chans().map((d) => ({ name: d.name, color: d.color, display: keepRange ? d.display : undefined }));
      return [assemble({ name, W: m.W, H: m.H, bd: rgb ? 8 : obd, rgb, nC, nZ: 1, nT, slices, calibration: cal, hyper: m.hyper && m.flag, chans: chans.slice(0, nC),
        mode: nC > 1 ? m.view.mode : undefined, active: Math.min(m.cur.c, nC - 1) })];
    }
  });

  // Grouped Z Project (ij.plugin.GroupedZProjector): the stack is cut into groups of `group` slices, each projected; the slice spacing is
  // multiplied by the group size. The group size must divide the stack size.
  R.define('stkGroupedZ', {
    kind: 'newdoc', version: 1, stack: 'whole', rgb: 'whole', roi: 'ignore',
    validate(params) {
      if (!params || PROJ_METHODS.indexOf(params.method) < 0) throw bad('method');
      if (!isInt(params.group) || params.group < 1) throw bad('group');
    },
    scratchBytes: (info) => info.width * info.height * info.channels * 8,
    async run(view, params, roi, io) {
      const m = model(view);
      const g = params.group, method = params.method;
      const depth = m.hyper ? m.nZ : m.N;
      if (depth % g !== 0) throw ijError('IJ_STK_GROUP', 'Group size must divide evenly into the stack size.');
      // GroupedZProjector (measured with 1.54p): a hyperstack is projected whole (all slices, current frame); a group of one slice gives the
      // projection of the first slice alone (the plugin hands the stack to ZProjector with start = stop = 1)
      if (m.hyper) return R.get('stkZProject').run(view, { method, start: 1, stop: depth, allFrames: false }, roi, io);
      if (g === 1) return R.get('stkZProject').run(view, { method, start: 1, stop: 1, allFrames: false }, roi, io);
      const groups = depth / g;
      const cal = m.calibration ? Object.assign({}, m.calibration) : m.calibration;
      if (cal && g > 1) cal.pixelDepth *= g;
      const slices = [];
      let obd = m.bd, k = 0;
      const nC = m.hyper ? m.nC : 1, nT = m.hyper ? m.nT : 1;
      for (let t = 0; t < nT; t++) for (let gi = 0; gi < groups; gi++) for (let c = 0; c < nC; c++) {
        const list = [];
        for (let i = gi * g; i < (gi + 1) * g; i++) list.push(m.hyper ? m.arrays(m.index(c, i, t)) : m.arrays(i));
        const outs = [];
        for (let j = 0; j < list[0].length; j++) { const r = projectPlanes(list.map((s) => s[j]), method, m.bd, m.W, m.H); outs.push(r.data); obd = r.bitDepth; }
        slices.push(m.rgb && obd === 32 ? rgbFloatToBytes(outs) : outs);
        io.check();
        await io.tick(++k / (groups * nC * nT), 'op.stkGroupedZ');
      }
      if (m.rgb && obd === 32) obd = 8;
      return [assemble({ name: PROJ_PREFIX[method] + m.view.name, W: m.W, H: m.H, bd: obd, rgb: m.rgb, nC, nZ: groups, nT, slices, calibration: cal, hyper: m.hyper && m.flag,
        chans: m.chans().slice(0, nC).map((d) => ({ name: d.name, color: d.color })), mode: nC > 1 ? m.view.mode : undefined })];
    }
  });

  // ------------------------------------------------------------------------------------------------
  // Make Montage   ij.plugin.MontageMaker.makeMontage2
  // params { columns, rows, scale, first, last, inc, border, fg?, bg? (pixel values of the foreground / background colour: only with "Use foreground color") }
  //   width = (int)(W * scale), height = (int)(H * scale)
  //   montageWidth = width*columns + (columns-1)*border, montageHeight = height*rows + (rows-1)*border
  //   tile k at x += width + border (a new row when x >= montageWidth); borders drawn as foreground rectangles between the tiles
  // The slice label (the `label` option draws text with the Java font) is not drawn here.
  // ------------------------------------------------------------------------------------------------
  /** ImageProcessor.setColor(Color.white / black) as a pixel value for a processor with the display range [min, max]. */
  function colorValue(bd, rgb, white, min, max) {
    if (rgb || bd === 8) return white ? 255 : 0;
    // Short: bestIndex 255 -> (int)(min + (max-min)); bestIndex 0 -> 0 when min > 0, else min. Float: min + (max-min)*(best/255)
    if (bd === 16) return white ? d2i(min + (max - min)) : (min > 0 ? 0 : d2i(min));
    return white ? Math.fround(min + (max - min)) : Math.fround(min);
  }
  /** MontageMaker's guess that the image has a white background: the mode of the bottom 12 rows of the current slice is >= 200 (flipped for an inverting LUT). */
  function whiteBackground(arrs, W, H, rgb, inverted) {
    const hist = new Int32Array(256);
    for (let y = Math.max(0, H - 12); y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x;
      // ColorProcessor.getHistogram: (int)(r*rw + g*gw + b*bw + 0.5) with the three weights 1/3
      const v = rgb ? d2i(arrs[0][i] * (1 / 3) + arrs[1][i] * (1 / 3) + arrs[2][i] * (1 / 3) + 0.5) : arrs[0][i];
      hist[v]++;
    }
    let mode = 0, best = -1;
    for (let v = 0; v < 256; v++) if (hist[v] > best) { best = hist[v]; mode = v; }
    const white = mode >= 200;
    return inverted ? !white : white;
  }

  R.define('stkMontage', {
    kind: 'newdoc', version: 1, stack: 'whole', rgb: 'whole', roi: 'ignore',
    validate(params) {
      if (!params) throw bad('params');
      for (const k of ['columns', 'rows']) if (!isInt(params[k]) || params[k] < 1) throw bad(k);
      if (!(params.scale > 0)) throw bad('scale');
      for (const k of ['first', 'last', 'inc', 'border']) if (!isInt(params[k]) || params[k] < (k === 'border' ? 0 : 1)) throw bad(k);
    },
    scratchBytes: (info, params) => {
      const p = params || {};
      return Math.ceil((info.width * (p.scale || 1)) * (p.columns || 1) * info.height * (p.scale || 1) * (p.rows || 1)) * bytesOf(info.bitDepth) * 3 + info.width * info.height * 8;
    },
    async run(view, params, roi, io) {
      const m = model(view);
      if (m.N < 2 && !(m.nC > 1)) throw ijError('IJ_STK_NEEDS_STACK', 'Stack required');
      if (m.hyper && m.nC > 1 && (m.nZ > 1 || m.nT > 1)) throw ijError('IJ_STK_NO_5D', '5D hyperstacks are not supported');
      const { columns, rows, scale, border, inc } = params;
      const composite = m.nC > 1;                      // one-slice composite: every channel, as displayed in its colour, is a tile
      let tiles, rgbOut;
      const bd = m.bd;
      if (composite) {
        const rr = root.IJStkRender;
        if (!rr) throw ijError('IJ_MODULE_MISSING', 'render');
        tiles = [];
        for (let c = 0; c < m.nC; c++) tiles.push(rr.renderChannel(m.arrays(c)[0], bd, m.view.channels[c].display, m.W, m.H));
        rgbOut = true;
      } else { tiles = sliceList(m); rgbOut = m.rgb; }
      const nTiles = tiles.length;
      const first = Math.max(1, params.first), last = Math.min(params.last, nTiles);
      const width = d2i(m.W * scale), height = d2i(m.H * scale);
      if (width < 1 || height < 1) throw bad('scale');
      const montageW = width * columns + (columns - 1) * border, montageH = height * rows + (rows - 1) * border;
      const K = rgbOut ? 3 : 1, C = rgbOut ? Uint8Array : ctorOf(bd);
      const disp0 = m.view.channels[0].display || { min: 0, max: 255, invert: false };
      const useFg = params.fg !== undefined && params.bg !== undefined;
      let fgV, bgV;
      if (useFg) { fgV = params.fg; bgV = params.bg; }
      else {
        let white = false;
        if (composite) white = whiteBackground(tiles[0], m.W, m.H, true, false);
        else if (bd === 8) white = whiteBackground(m.arrays(Math.min(m.curN, nTiles - 1)), m.W, m.H, m.rgb, !!disp0.invert);
        fgV = colorValue(rgbOut ? 8 : bd, rgbOut, !white, disp0.min, disp0.max);
        bgV = colorValue(rgbOut ? 8 : bd, rgbOut, white, disp0.min, disp0.max);
      }
      const out = [];
      for (let k = 0; k < K; k++) { const a = new C(montageW * montageH); const v = Array.isArray(bgV) ? bgV[k] : bgV; if (v) a.fill(v); out.push(a); }
      let x = 0, y = 0, slice = first;
      const doResize = scale !== 1;
      while (slice <= last) {
        const arrs = tiles[slice - 1];
        for (let k = 0; k < K; k++) {
          let a = arrs[k];
          if (doResize) a = await resizePlane(a, m.W, m.H, rgbOut ? 8 : bd, width, height, false, width < 200);
          for (let yy = 0; yy < height; yy++) out[k].set(a.subarray(yy * width, (yy + 1) * width), (y + yy) * montageW + x);
        }
        x += width + border;
        if (x >= montageW) { x = 0; y += height + border; if (y >= montageH) break; }
        slice += inc;
        io.check();
        await io.tick((slice - first) / Math.max(1, last - first), 'op.stkMontage');
      }
      if (border > 0) {
        for (let k = 0; k < K; k++) {
          const v = Array.isArray(fgV) ? fgV[k] : fgV;
          for (let bx = width; bx < montageW; bx += width + border) for (let yy = 0; yy < montageH; yy++) out[k].fill(v, yy * montageW + bx, yy * montageW + Math.min(montageW, bx + border));
          for (let by = height; by < montageH; by += height + border) for (let yy = by; yy < Math.min(montageH, by + border); yy++) out[k].fill(v, yy * montageW, (yy + 1) * montageW);
        }
      }
      // "if (cal.scaled()) { cal.pixelWidth /= scale; cal.pixelHeight /= scale }"
      const cal = m.calibration ? Object.assign({}, m.calibration) : m.calibration;
      if (cal && isScaled(cal)) { cal.pixelWidth /= scale; cal.pixelHeight /= scale; }
      const info = 'xMontage=' + columns + '\nyMontage=' + rows + '\n';
      return [assemble({ name: 'Montage', W: montageW, H: montageH, bd: rgbOut ? 8 : bd, rgb: rgbOut, nC: 1, nZ: 1, nT: 1, slices: [out], calibration: cal, hyper: false,
        chans: [{ name: 'C1', color: '#ffffff' }], labels: ['Montage\n' + info] })];
    }
  });

  // ------------------------------------------------------------------------------------------------
  // Rendering a channel the way ImageJ's processors show it (ImageProcessor.createImage / CompositeImage.updateImage), and the
  // conversions to RGB built on it: RGB Color, Make Montage of a composite, Merge Channels to RGB, Stack to RGB.
  // ------------------------------------------------------------------------------------------------
  const Render = (() => {
    const grays = () => { const t = new Uint8Array(768); for (let i = 0; i < 256; i++) t[i * 3] = t[i * 3 + 1] = t[i * 3 + 2] = i; return t; };
    /** The 768-entry table (r, g, b per level) of a display: its LUT, reversed when `invert`. */
    function baseTable(display) {
      const L = root.IJLuts;
      let l = display ? display.lut : null;
      let t;
      if (l && ArrayBuffer.isView(l) && l.length === 768) t = new Uint8Array(l);
      else if (l === null || l === undefined || !L) t = grays();
      else t = L.get(l);
      if (display && display.invert) {
        const r = new Uint8Array(768);
        for (let i = 0; i < 256; i++) { const j = 255 - i; r[i * 3] = t[j * 3]; r[i * 3 + 1] = t[j * 3 + 1]; r[i * 3 + 2] = t[j * 3 + 2]; }
        t = r;
      }
      return t;
    }
    /** ByteProcessor.setMinAndMax(min, max): the display range of an 8-bit image is baked into its colour model:
     *  level i < min -> entry 0; i > max -> entry 255; else entry (int)(256.0 * (i - round(min)) / (max - min)) clamped to 0..255. */
    function bakeRange(t, min, max) {
      if (min === 0 && max === 255) return t;
      if (max < min) return t;
      const imin = Math.floor(min + 0.5);
      const o = new Uint8Array(768);
      for (let i = 0; i < 256; i++) {
        let k;
        if (i < min) k = 0;
        else if (i > max) k = 255;
        else { k = d2i(256.0 * (i - imin) / (max - min)); if (k < 0) k = 0; if (k > 255) k = 255; }
        o[i * 3] = t[k * 3]; o[i * 3 + 1] = t[k * 3 + 1]; o[i * 3 + 2] = t[k * 3 + 2];
      }
      return o;
    }
    /** The 8-bit levels a 16 / 32-bit plane is shown with (ShortProcessor / FloatProcessor.create8BitImage). */
    function toByte(a, bd, display) {
      const out = new Uint8Array(a.length);
      const d = display || { min: 0, max: bd === 16 ? 65535 : 1 };
      if (bd === 16) {
        const mn = Math.floor(d.min + 0.5), mx = Math.floor(d.max + 0.5);
        const scale = 256.0 / (mx - mn + 1);
        for (let i = 0; i < a.length; i++) { let v = a[i] - mn; if (v < 0) v = 0; v = d2i(v * scale + 0.5); out[i] = v > 255 ? 255 : v; }
      } else {
        const mn = Math.fround(d.min), mx = Math.fround(d.max);
        const scale = 255.0 / (mx - mn);
        for (let i = 0; i < a.length; i++) { let v = a[i] - mn; if (v < 0) v = 0; v = d2i(v * scale + 0.5); out[i] = v > 255 ? 255 : v; }
      }
      return out;
    }
    /** One channel as RGB: its display LUT and range. */
    function renderChannel(a, bd, display, W, H) {
      const d = display || { min: 0, max: 255, lut: null, invert: false };
      let idx, t = baseTable(d);
      if (bd === 8) { idx = a; t = bakeRange(t, d.min, d.max); } else idx = toByte(a, bd, d);
      const n = W * H, r = new Uint8Array(n), g = new Uint8Array(n), b = new Uint8Array(n);
      for (let i = 0; i < n; i++) { const k = idx[i] * 3; r[i] = t[k]; g[i] = t[k + 1]; b[i] = t[k + 2]; }
      return [r, g, b];
    }
    /** Several channels summed as a composite does (each colour channel clamped at 255). */
    function renderComposite(list, W, H) {
      const n = W * H, r = new Uint8Array(n), g = new Uint8Array(n), b = new Uint8Array(n);
      for (const rgb of list) for (let i = 0; i < n; i++) {
        let v = r[i] + rgb[0][i]; r[i] = v > 255 ? 255 : v;
        v = g[i] + rgb[1][i]; g[i] = v > 255 ? 255 : v;
        v = b[i] + rgb[2][i]; b[i] = v > 255 ? 255 : v;
      }
      return [r, g, b];
    }
    return { baseTable, bakeRange, toByte, renderChannel, renderComposite, grays };
  })();
  root.IJStkRender = Render;

  const displayedAsHyper = (m) => m.flag && ((m.nC > 1 ? 1 : 0) + (m.nZ > 1 ? 1 : 0) + (m.nT > 1 ? 1 : 0)) >= 2;

  /** RGB Color of an image (ImageConverter.convertToRGB / RGBStackConverter / CompositeConverter). `params`:
   *  { slices, frames }  (of a composite: the dimensions converted, else the current plane), visible (the active channels of a composite). */
  function toRgbSlices(m, params) {
    if (m.rgb) throw ijError('IJ_BAD_TYPE', 'already RGB');
    const slices = [];
    // the display the operator saw (params.displays, set by the command or by displaySnapshot): display state is not journaled,
    // so a replay must not read the document's
    const disp = (c) => Object.assign({}, m.view.channels[c].display, Array.isArray(params.displays) && params.displays[c] ? params.displays[c] : {});
    if (m.nC === 1) {
      for (let n = 0; n < m.N; n++) slices.push(Render.renderChannel(m.arrays(n)[0], m.bd, disp(0), m.W, m.H));
      return { slices, nZ: m.nZ, nT: m.nT };
    }
    const zs = params.slices !== false && m.nZ > 1 ? range0(m.nZ) : [m.cur.z];
    const ts = params.frames !== false && m.nT > 1 ? range0(m.nT) : [m.cur.t];
    const mode = typeof params.mode === 'string' ? params.mode : m.view.mode;
    const active = Array.isArray(params.visible) ? params.visible : (Array.isArray(m.view.visible) ? m.view.visible : m.view.channels.map(() => true));
    let first = true;
    for (const t of ts) for (const z of zs) {
      const list = [];
      // Measured with 1.54p: a grayscale-mode composite converts its FIRST plane like a composite (every active channel in its LUT),
      // the following planes show the active channel in grays (RGBStackConverter switches the mode after the first plane); a colour-mode
      // composite shows the active channel in its own LUT throughout.
      if (mode === 'composite' || (mode === 'gray' && first)) {
        for (let c = 0; c < m.nC; c++) if (active[c] !== false) list.push(Render.renderChannel(m.arrays(m.index(c, z, t))[0], m.bd, disp(c), m.W, m.H));
      } else {
        const c = Math.min(m.cur.c, m.nC - 1);
        const d = mode === 'gray' ? Object.assign({}, disp(c), { lut: 'Grays', invert: false }) : disp(c);
        list.push(Render.renderChannel(m.arrays(m.index(c, z, t))[0], m.bd, d, m.W, m.H));
      }
      first = false;
      slices.push(Render.renderComposite(list, m.W, m.H));
    }
    return { slices, nZ: zs.length, nT: ts.length };
  }
  function rgbColorImage(m, params, inPlace) {
    const r = toRgbSlices(m, params);
    const cal = m.calibration ? Object.assign({}, m.calibration) : m.calibration;
    const multi = m.nC > 1;
    let labels;
    if (!multi && m.view.labels) labels = labelList(m);
    const name = inPlace ? m.view.name : (displayedAsHyper(m) ? m.view.name + '-1' : (m.nC > 1 || m.nZ * m.nT === 1 ? m.view.name + ' (RGB)' : m.view.name + '-1'));
    return assemble({ name, W: m.W, H: m.H, bd: 8, rgb: true, nC: 1, nZ: r.nZ, nT: r.nT, slices: r.slices, calibration: cal, hyper: m.flag && !!m.hyper, labels,
      chans: undefined });
  }
  /** The display state RGB Color renders through (ranges, LUTs, invert, mode, active channels), copied into the params when the
   *  caller did not give it, so the journal entry replays the picture the operator saw. */
  function displaySnapshot(view, params) {
    const p = Object.assign({}, params || {});
    if (!Array.isArray(p.displays)) p.displays = view.channels.map((ch) => { const d = ch.display || {}; return { min: d.min, max: d.max, lut: d.lut === undefined ? null : d.lut, invert: !!d.invert }; });
    if (typeof p.mode !== 'string') p.mode = view.mode;
    if (!Array.isArray(p.visible)) p.visible = Array.isArray(view.visible) ? view.visible.slice() : view.channels.map(() => true);
    return p;
  }
  R.define('stkRgbColor', {
    kind: 'newdoc', version: 1, stack: 'whole', rgb: false, roi: 'ignore', scratchBytes: (info) => info.width * info.height * 3 * Math.max(1, info.channels),
    resolve: displaySnapshot,
    async run(view, params) { return [rgbColorImage(model(view), params || {}, false)]; }
  });
  R.define('stkRgbColorInPlace', {
    kind: 'size', version: 1, stack: 'whole', rgb: false, roi: 'ignore', scratchBytes: (info) => info.width * info.height * 3 * Math.max(1, info.channels),
    resolve: displaySnapshot,
    async run(view, params) { return rgbColorImage(model(view), params || {}, true); }
  });

  // ------------------------------------------------------------------------------------------------
  // Image > Type > 8-bit / 16-bit / 32-bit   ij.process.StackConverter / ImageConverter (an RGB source goes through the luminance)
  // params { bitDepth, scale (Edit > Options > Conversions "Scale when converting"), weighted (Weighted RGB conversions), ranges: [{min, max}] per channel }
  // The display range of each channel is applied to every slice of the stack (StackConverter keeps ONE range for the whole stack).
  // ------------------------------------------------------------------------------------------------
  R.define('stkConvert', {
    kind: 'size', version: 1, stack: 'whole', rgb: 'whole', roi: 'ignore',
    validate(params) { if (!params || [8, 16, 32].indexOf(params.bitDepth) < 0) throw bad('bitDepth'); },
    resolve(view, params) {
      const p = Object.assign({}, params);
      if (!p.ranges) p.ranges = view.channels.map((ch) => ({ min: ch.display.min, max: ch.display.max }));
      return p;
    },
    scratchBytes: (info, params) => info.width * info.height * info.channels * ((params && params.bitDepth ? params.bitDepth : 32) / 8) * 2,
    async run(view, params, roi, io) {
      const m = model(view);
      const to = params.bitDepth;
      const IJOps = root.IJOps;
      const C = ctorOf(to);
      const slices = [];
      if (m.rgb) {
        // ImageConverter.convertToGray8: (int)(r*rw + g*gw + b*bw + 0.5) with the weights of Edit > Options > Conversions; 16 / 32 bits copy that
        for (let n = 0; n < m.N; n++) {
          const a = m.arrays(n);
          let o;
          if (to === 32) {
            // TypeConverter.convertRGBToFloat: (float)(r*rw + g*gw + b*bw), double weights (1/3 each, or 0.299 / 0.587 / 0.114)
            const rw = params.weighted ? 0.299 : 1 / 3, gw = params.weighted ? 0.587 : 1 / 3, bw = params.weighted ? 0.114 : 1 / 3;
            o = new Float32Array(a[0].length);
            for (let i = 0; i < o.length; i++) o[i] = a[0][i] * rw + a[1][i] * gw + a[2][i] * bw;
          } else {
            const g = S.grayPlane(a[0], a[1], a[2], !!params.weighted);
            o = new C(g.length);
            for (let i = 0; i < g.length; i++) o[i] = g[i];
          }
          slices.push([o]);
          if ((n & 7) === 7) { io.check(); await io.tick((n + 1) / m.N, 'op.stkConvert'); }
        }
        return resultOf(m, { slices, labels: labelList(m), nC: 1, nZ: m.nZ, nT: m.nT, hyper: m.flag, rgb: false, chans: [{ name: 'C1', color: '#ffffff' }], bd: to, active: 0 });
      }
      if (to === m.bd) return null;
      for (let n = 0; n < m.N; n++) {
        const c = n % m.nC, r = params.ranges && params.ranges[c] ? params.ranges[c] : { min: view.channels[c].display.min, max: view.channels[c].display.max };
        const out = IJOps.convert({ width: m.W, height: m.H, bitDepth: m.bd, data: m.arrays(n)[0] }, to, { min: r.min, max: r.max, scale: params.scale !== false });
        slices.push([out.data]);
        if ((n & 7) === 7) { io.check(); await io.tick((n + 1) / m.N, 'op.stkConvert'); }
      }
      // the display range of a converted channel is the one ImageJ's converter leaves: 8 bits 0..255, else the new data range (engine default)
      return resultOf(m, { slices, labels: labelList(m), nC: m.nC, nZ: m.nZ, nT: m.nT, hyper: m.flag, bd: to, mode: m.view.mode, active: m.cur.c, chans: m.chans().map((d) => ({ name: d.name, color: d.color })) });
    }
  });

  // ------------------------------------------------------------------------------------------------
  // RGB Stack / HSB Stack / HSB (32-bit) / Lab Stack   ij.process.ColorProcessor.getRGB / getHSB / getHSB32 + ij.plugin.Converter
  // ------------------------------------------------------------------------------------------------
  /** java.awt.Color.RGBtoHSB, every step a float (Math.fround). */
  function rgbToHsb(r, g, b, out) {
    const f = Math.fround;
    let cmax = r > g ? r : g; if (b > cmax) cmax = b;
    let cmin = r < g ? r : g; if (b < cmin) cmin = b;
    const brightness = f(cmax / 255.0);
    const saturation = cmax !== 0 ? f(f(cmax - cmin) / f(cmax)) : 0;
    let hue;
    if (saturation === 0) hue = 0;
    else {
      const redc = f(f(cmax - r) / f(cmax - cmin)), greenc = f(f(cmax - g) / f(cmax - cmin)), bluec = f(f(cmax - b) / f(cmax - cmin));
      if (r === cmax) hue = f(bluec - greenc);
      else if (g === cmax) hue = f(f(2.0 + redc) - bluec);
      else hue = f(f(4.0 + greenc) - redc);
      hue = f(hue / 6.0);
      if (hue < 0) hue = f(hue + 1.0);
    }
    out[0] = hue; out[1] = saturation; out[2] = brightness;
  }
  /** java.awt.Color.HSBtoRGB -> [r, g, b] ints. */
  function hsbToRgb(hue, saturation, brightness) {
    const f = Math.fround;
    if (saturation === 0) { const v = d2i(f(f(brightness * 255.0) + 0.5)); return [v, v, v]; }
    const h = f(f(hue - Math.floor(hue)) * 6.0);
    const fr = f(h - Math.floor(h));
    const p = f(brightness * f(1.0 - saturation));
    const q = f(brightness * f(1.0 - f(saturation * fr)));
    const t = f(brightness * f(1.0 - f(saturation * f(1.0 - fr))));
    const c = (v) => d2i(f(f(v * 255.0) + 0.5));
    switch (d2i(h)) {
      case 0: return [c(brightness), c(t), c(p)];
      case 1: return [c(q), c(brightness), c(p)];
      case 2: return [c(p), c(brightness), c(t)];
      case 3: return [c(p), c(q), c(brightness)];
      case 4: return [c(t), c(p), c(brightness)];
      default: return [c(brightness), c(p), c(q)];
    }
  }
  const D65 = [95.0429, 100.0, 108.8900];
  /** ColorSpaceConverter.RGBtoXYZ then XYZtoLAB (D65 white, sRGB), double arithmetic; the result goes to float. */
  function rgbToLab(R8, G8, B8, out) {
    const lin = (v) => { const x = v / 255.0; return (x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4)) * 100.0; };
    const r = lin(R8), g = lin(G8), b = lin(B8);
    const X = r * 0.4124 + g * 0.3576 + b * 0.1805, Y = r * 0.2126 + g * 0.7152 + b * 0.0722, Z = r * 0.0193 + g * 0.1192 + b * 0.9505;
    const fx = (t) => (t > 0.008856 ? Math.pow(t, 1.0 / 3.0) : 7.787 * t + 16.0 / 116.0);
    const x = fx(X / D65[0]), y = fx(Y / D65[1]), z = fx(Z / D65[2]);
    out[0] = Math.fround(116.0 * y - 16.0); out[1] = Math.fround(500.0 * (x - y)); out[2] = Math.fround(200.0 * (y - z));
  }

  const SPLIT_STEP = { rgb: 'op.stkRgbStack', hsb: 'op.stkHsbStack', hsb32: 'op.stkHsb32', lab: 'op.stkLabStack' };
  function splitModel(kind) {
    return {
      kind: 'size', version: 1, stack: 'whole', rgb: 'whole', roi: 'ignore',
      scratchBytes: (info) => info.width * info.height * 3 * (kind === 'rgb' || kind === 'hsb' ? 1 : 4) * 2,
      async run(view, params, roi, io) {
        const m = model(view);
        if (!m.rgb) throw ijError('IJ_BAD_TYPE', 'RGB Color required');
        if (kind === 'lab' && m.N > 1) throw ijError('IJ_BAD_TYPE', 'Supported Conversions');
        const n = m.W * m.H, hsb = new Float32Array(3), lab = new Float32Array(3);
        const names = kind === 'rgb' ? ['Red', 'Green', 'Blue'] : kind === 'lab' ? ['L*', 'a*', 'b*'] : ['Hue', 'Saturation', 'Brightness'];
        const out = [];
        for (let k = 0; k < m.N; k++) {
          const a = m.arrays(k);
          if (kind === 'rgb') { out.push([a[0], a[1], a[2]]); continue; }
          const bytes = kind !== 'hsb32' && kind !== 'lab';
          const C = bytes ? Uint8Array : Float32Array;
          const p0 = new C(n), p1 = new C(n), p2 = new C(n);
          for (let i = 0; i < n; i++) {
            if (kind === 'lab') { rgbToLab(a[0][i], a[1][i], a[2][i], lab); p0[i] = lab[0]; p1[i] = lab[1]; p2[i] = lab[2]; }
            else {
              rgbToHsb(a[0][i], a[1][i], a[2][i], hsb);
              if (bytes) { p0[i] = d2i(hsb[0] * 255.0); p1[i] = d2i(hsb[1] * 255.0); p2[i] = d2i(hsb[2] * 255.0); } else { p0[i] = hsb[0]; p1[i] = hsb[1]; p2[i] = hsb[2]; }
            }
          }
          out.push([p0, p1, p2]);
          if ((k & 3) === 3) { io.check(); await io.tick((k + 1) / m.N, SPLIT_STEP[kind]); }
        }
        const bd = kind === 'rgb' || kind === 'hsb' ? 8 : 32;
        const cal = m.calibration ? Object.assign({}, m.calibration) : m.calibration;
        let slices, nC, nZ, hyper = false, mode;
        if (m.N === 1) { slices = [[out[0][0]], [out[0][1]], [out[0][2]]]; nC = 1; nZ = 3; }
        else { // a stack: three channels (a composite) over the slices of the stack
          slices = []; nC = 3; nZ = m.N; hyper = true;
          for (let k = 0; k < m.N; k++) for (let c = 0; c < 3; c++) slices.push([out[k][c]]);
          mode = kind === 'rgb' ? 'composite' : 'gray';
        }
        if (kind === 'lab') { nC = 3; nZ = 1; slices = [[out[0][0]], [out[0][1]], [out[0][2]]]; mode = 'gray'; hyper = false; }
        const chans = nC === 3 ? [{ name: names[0], color: '#ff0000' }, { name: names[1], color: '#00ff00' }, { name: names[2], color: '#0000ff' }] : [{ name: 'C1', color: '#ffffff' }];
        const img = assemble({ name: m.view.name, W: m.W, H: m.H, bd, rgb: false, nC, nZ, nT: 1, slices, calibration: cal, hyper, mode, chans,
          labels: m.N === 1 || kind === 'lab' ? names : undefined });
        return kind === 'lab' ? [img] : img;
      }
    };
  }
  R.define('stkRgbStack', splitModel('rgb'));
  R.define('stkHsbStack', splitModel('hsb'));
  R.define('stkHsb32', splitModel('hsb32'));
  // Lab Stack opens a NEW image (ij.plugin.Converter: the Lab image is shown in a window of its own and the RGB original is closed by the command)
  R.define('stkLabStack', Object.assign(splitModel('lab'), { kind: 'newdoc' }));

  // Stack to RGB (Image > Color > Stack to RGB, ij.plugin.RGBStackConverter): a composite converts as RGB Color does; a 3-slice 8-bit stack
  // labelled Red / Green / Blue, Hue / Saturation / Brightness (or a 32-bit HSB (32-bit) one) becomes an RGB image.
  function stackToRgbImage(m, params, inPlace) {
    if (m.nC > 1 && !m.rgb) return rgbColorImage(m, params, inPlace);
    const labels = labelList(m) || [];
    const N = m.N;
    if (N !== 3 || m.rgb) throw ijError('IJ_BAD_TYPE', '2 or 3 slice stack, or composite, required');
    const n = m.W * m.H;
    const [a, b, c] = [0, 1, 2].map((i) => m.arrays(i)[0]);
    const hsb = labels[0] === 'Hue' && (m.bd === 8 || m.bd === 32);
    const R8 = new Uint8Array(n), G8 = new Uint8Array(n), B8 = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      if (hsb) {
        const h = m.bd === 8 ? a[i] / 255.0 : a[i], s = m.bd === 8 ? b[i] / 255.0 : b[i], v = m.bd === 8 ? c[i] / 255.0 : c[i];
        const q = hsbToRgb(Math.fround(h), Math.fround(s), Math.fround(v)); R8[i] = q[0]; G8[i] = q[1]; B8[i] = q[2];
      } else { R8[i] = a[i]; G8[i] = b[i]; B8[i] = c[i]; }
    }
    if (!hsb && m.bd !== 8) throw ijError('IJ_BAD_TYPE', '8-bit stack required');
    const cal = m.calibration ? Object.assign({}, m.calibration) : m.calibration;
    return assemble({ name: inPlace ? m.view.name : m.view.name + ' (RGB)', W: m.W, H: m.H, bd: 8, rgb: true, nC: 1, nZ: 1, nT: 1, slices: [[R8, G8, B8]], calibration: cal, hyper: false });
  }
  R.define('stkStackToRgb', {
    kind: 'newdoc', version: 1, stack: 'whole', rgb: false, roi: 'ignore', scratchBytes: (info) => info.width * info.height * 3 * Math.max(1, info.channels),
    resolve: displaySnapshot,
    async run(view, params) { return [stackToRgbImage(model(view), params || {}, false)]; }
  });
  R.define('stkStackToRgbInPlace', {
    kind: 'size', version: 1, stack: 'whole', rgb: false, roi: 'ignore', scratchBytes: (info) => info.width * info.height * 3 * Math.max(1, info.channels),
    resolve: displaySnapshot,
    async run(view, params) { return stackToRgbImage(model(view), params || {}, true); }
  });

  // Make Composite (Image > Color > Make Composite, ij.plugin.CompositeConverter): an RGB image becomes a 3-channel composite (labels
  // Red / Green / Blue); a stack of 2..8 slices becomes that many channels; params { mode: composite | color | gray }
  R.define('stkMakeComposite', {
    kind: 'size', version: 1, stack: 'whole', rgb: 'whole', roi: 'ignore', scratchBytes: () => 0,
    async run(view, params) {
      const m = model(view);
      const mode = params && params.mode ? params.mode : 'composite';
      const cal = m.calibration ? Object.assign({}, m.calibration) : m.calibration;
      if (m.rgb) {
        if (m.N !== 1) throw ijError('IJ_BAD_TYPE', 'RGB stacks cannot be made composite');
        const a = m.arrays(0);
        return assemble({ name: m.view.name, W: m.W, H: m.H, bd: 8, rgb: false, nC: 3, nZ: 1, nT: 1, slices: [[a[0]], [a[1]], [a[2]]], calibration: cal, hyper: false, mode: 'composite',
          labels: ['Red', 'Green', 'Blue'], chans: RGB_CHANNELS.map((d) => ({ name: d.name, color: d.color })) });
      }
      if (m.nC > 1) { if (mode === m.view.mode) return null; return resultOf(m, { slices: sliceList(m), labels: labelList(m), nC: m.nC, nZ: m.nZ, nT: m.nT, hyper: m.flag, mode, active: m.cur.c }); }
      const n = m.N;
      if (n >= 2 && n <= 8 && !m.flag) {
        const COLORS = ['#ff0000', '#00ff00', '#0000ff', '#ffffff', '#00ffff', '#ff00ff', '#ffff00', '#ffffff'];
        return resultOf(m, { slices: sliceList(m), labels: labelList(m), nC: n, nZ: 1, nT: 1, hyper: false, mode, active: 0, chans: range0(n).map((i) => ({ name: 'C' + (i + 1), color: COLORS[i] })) });
      }
      if (m.flag || m.N === 1) return resultOf(m, { slices: sliceList(m), labels: labelList(m), nC: m.nC, nZ: m.nZ, nT: m.nT, hyper: m.flag, mode: undefined });
      throw ijError('IJ_BAD_TYPE', '2-8 slice stack required');
    }
  });

  // ------------------------------------------------------------------------------------------------
  // Statistics (Image > Stacks > Statistics, ij.plugin.filter.StackStatistics) and Plot Z-axis Profile (ij.plugin.ZAxisProfiler)
  // ------------------------------------------------------------------------------------------------
  /** The region an area selection (or the bounding box of a line) covers: { x, y, w, h, data | null } clipped to the image, data = 0/1 mask. */
  function regionOf(roi, W, H) {
    const Roi = root.IJRoi;
    if (!roi || !Roi) return { x: 0, y: 0, w: W, h: H, data: null };
    if (Roi.isArea && !Roi.isArea(roi)) { const b = Roi.bounds(roi); const x0 = Math.max(0, b.x), y0 = Math.max(0, b.y), x1 = Math.min(W, b.x + b.w), y1 = Math.min(H, b.y + b.h); return { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0), data: null }; }
    const m = Roi.mask(roi, W, H);
    return { x: m.x, y: m.y, w: m.w, h: m.h, data: m.data };
  }
  /** The planes a statistics / profile op reads: the luminance (rgbWeighted) of an RGB image, else the planes of the channel. */
  function statPlanes(m, params, c) {
    const out = [];
    for (let n = 0; n < m.N; n++) {
      if (!m.rgb) { if (n % m.nC === c || m.N === m.nZ * m.nT) out.push(m.arrays(n)[0]); continue; }
      const a = m.arrays(n);
      out.push(S.grayPlane(a[0], a[1], a[2], !!params.rgbWeighted));
    }
    return out;
  }

  /** StackStatistics of the voxels of the planes inside the region: { voxels, mean, stdDev, min, max, mode, median, total }. NaN are skipped. */
  function stackStats(planes, bd, W, H, reg, thr) {
    let n = 0, sum = 0, sum2 = 0, min = Infinity, max = -Infinity;
    const values = (cb) => {
      for (const p of planes) for (let y = 0; y < reg.h; y++) {
        const row = (reg.y + y) * W + reg.x;
        for (let x = 0; x < reg.w; x++) {
          if (reg.data && !reg.data[y * reg.w + x]) continue;
          const v = p[row + x];
          if (v !== v) continue;
          if (thr && (v < thr.lower || v > thr.upper)) continue;
          cb(v);
        }
      }
    };
    values((v) => { n++; sum += v; sum2 += v * v; if (v < min) min = v; if (v > max) max = v; });
    const total = planes.length * (reg.data ? reg.data.reduce((s, v) => s + v, 0) : reg.w * reg.h);
    if (n === 0) return { voxels: 0, mean: NaN, stdDev: 0, min: 0, max: 0, mode: 0, median: null, total };
    const mean = sum / n;
    // ImageStatistics.calculateStdDev: stdDev = sqrt((n*sum2 - sum*sum)/n/(n-1))
    let sd = 0;
    if (n > 1) { sd = (n * sum2 - sum * sum) / n; sd = sd > 0 ? Math.sqrt(sd / (n - 1)) : 0; }
    let mode, median = null;
    if (bd === 8 || bd === 16) {
      const hist = new Float64Array(bd === 8 ? 256 : 65536);
      values((v) => { hist[v]++; });
      let cum = 0, i = -1;
      const half = n / 2.0;
      do { cum += hist[++i]; } while (cum <= half && i < hist.length - 1);
      median = i;
      if (bd === 8) { let mc = 0; mode = 0; for (let k = 0; k < 256; k++) if (hist[k] > mc) { mc = hist[k]; mode = k; } }
    }
    if (bd !== 8) {
      // 256 bins over [min, max] (16-bit: the upper edge is max + 1); the mode is the lower edge of the fullest bin
      const histMax = bd === 16 ? max + 1 : max;
      const bins = new Float64Array(256), scale = histMax > min ? 256 / (histMax - min) : 0;
      values((v) => { let k = d2i(scale * (v - min)); if (k > 255) k = 255; bins[k]++; });
      let mc = 0, mk = 0; for (let k = 0; k < 256; k++) if (bins[k] > mc) { mc = bins[k]; mk = k; }
      mode = min + mk * ((histMax - min) / 256);
    }
    return { voxels: n, mean, stdDev: sd, min, max, mode, median, total };
  }

  R.define('stkStats', {
    kind: 'compute', version: 1, stack: 'whole', rgb: 'whole', roi: 'mask',
    scratchBytes: (info) => info.width * info.height * 4,
    async run(view, params, roi, io) {
      const m = model(view);
      if (m.N < 2) throw ijError('IJ_STK_NEEDS_STACK', 'stack required');
      const reg = regionOf(roi, m.W, m.H);
      const planes = m.rgb ? statPlanes(m, params, 0) : sliceList(m).map((s) => s[0]);
      const st = stackStats(planes, m.rgb ? 8 : m.bd, m.W, m.H, reg, params.limit ? params.threshold : null);
      const cal = m.calibration || {};
      const vox = (cal.pixelWidth || 1) * (cal.pixelHeight || 1) * (cal.pixelDepth || 1);
      return { voxels: st.voxels, volume: st.voxels * vox, percentVolume: st.total ? st.voxels * 100.0 / st.total : 0, mean: st.mean, stdDev: st.stdDev, min: st.min, max: st.max, mode: st.mode, median: st.median,
        calibrated: isScaled(cal) && (cal.unit !== 'pixel' && cal.unit !== 'px'), unit: cal.unit };
    }
  });

  // Plot Z-axis Profile: the mean of the selection (its bounding box for a line; the whole image without one) in every slice, as float32.
  // params { dimension: 'z' | 'time' } picks z or t of a hyperstack with both; x is the slice number, or (i-1) * the spacing of a calibrated stack.
  R.define('stkProfile', {
    kind: 'compute', version: 1, stack: 'whole', rgb: 'whole', roi: 'mask',
    scratchBytes: (info) => info.width * info.height * 4,
    async run(view, params, roi, io) {
      const m = model(view);
      if (m.N < 2) throw ijError('IJ_STK_NEEDS_STACK', 'This command requires a stack.');
      const reg = regionOf(roi, m.W, m.H);
      const c = Math.min(m.cur.c, m.nC - 1);
      let dim = 'z', count = m.hyper ? m.nZ : m.N;
      if (m.hyper) {
        if (m.nZ > 1 && m.nT > 1) dim = params.dimension === 'time' ? 't' : 'z';
        else if (m.nT > 1) dim = 't';
        count = dim === 'z' ? m.nZ : m.nT;
      }
      const ys = new Float32Array(count), xs = new Array(count);
      const cal = m.calibration || {};
      const step = dim === 't' ? (cal.frameInterval || 0) : (cal.pixelDepth || 1);
      const scaled = dim === 't' ? step > 0 : (isScaled(cal) && cal.unit !== 'pixel' && cal.unit !== 'px');
      for (let i = 0; i < count; i++) {
        let arrs;
        if (!m.hyper) arrs = m.arrays(i);
        else arrs = m.arrays(dim === 'z' ? m.index(c, i, m.cur.t) : m.index(c, m.cur.z, i));
        const plane = m.rgb ? S.grayPlane(arrs[0], arrs[1], arrs[2], !!params.rgbWeighted) : arrs[0];
        const st = stackStats([plane], m.rgb ? 8 : m.bd, m.W, m.H, reg, null);
        ys[i] = st.mean;
        xs[i] = scaled ? i * step : i + 1;
        if ((i & 15) === 15) { io.check(); await io.tick((i + 1) / count, 'op.stkProfile'); }
      }
      return { title: m.view.name + '-' + reg.x + '-' + reg.y, x: xs, y: Array.from(ys), dimension: dim, xLabel: scaled ? (dim === 't' ? 'Time' : 'Z') : 'Slice', unit: scaled ? (dim === 't' ? (cal.timeUnit || 'sec') : cal.unit) : null };
    }
  });

  // ------------------------------------------------------------------------------------------------
  // Reslice   ij.plugin.Slicer.resliceRectOrLine / getSlice / getLine / getOrthoLine
  // params { output (spacing in calibrated units), start: top | left | bottom | right, flip, rotate, avoid (no interpolation), sliceCount (line selections) }
  //   A rectangle (or the whole image) is cut by parallel lines `outputZSpacing` pixels apart (Top: y0, y0 + s, ... across the width, Left: vertical
  //   lines, Bottom / Right from the other edge); a straight line by `sliceCount` parallel lines. Every output slice has one row (a column with
  //   `rotate`) per slice of the stack, resized in that direction by inputZSpacing / pixelWidth (linear interpolation) unless `avoid`.
  // ------------------------------------------------------------------------------------------------
  /** ImageProcessor.getInterpolatedPixel(x, y) of Byte / Short / Float processors: bilinear, the point clamped into [0, w-1) x [0, h-1) (w - 1.001 at the far edges). */
  function interpAt(a, W, H, x, y) {
    if (x < 0.0) x = 0.0;
    if (x >= W - 1.0) x = W - 1.001;
    if (y < 0.0) y = 0.0;
    if (y >= H - 1.0) y = H - 1.001;
    const xb = d2i(x), yb = d2i(y);
    const xf = x - xb, yf = y - yb;
    const x1 = xb + 1 < W ? xb + 1 : xb, y1 = yb + 1 < H ? yb + 1 : yb;
    const ll = a[yb * W + xb], lr = a[yb * W + x1], ul = a[y1 * W + xb], ur = a[y1 * W + x1];
    const upper = ul + xf * (ur - ul), lower = ll + xf * (lr - ll);
    return lower + yf * (upper - lower);
  }
  /** Slicer.getOrthoLine: n samples of a horizontal / vertical line starting at (x1, y1) (exact pixels). */
  function orthoLine(a, W, x1, y1, x2, y2) {
    x1 = d2i(x1); y1 = d2i(y1); x2 = d2i(x2); y2 = d2i(y2);
    const dx = x2 - x1, dy = y2 - y1;
    const n = Math.max(Math.abs(dx), Math.abs(dy));
    const out = new Float32Array(n);
    const xinc = n > 0 ? (dx / n) | 0 : 0, yinc = n > 0 ? (dy / n) | 0 : 0;
    let rx = x1, ry = y1;
    for (let i = 0; i < n; i++) { out[i] = a[ry * W + rx]; rx += xinc; ry += yinc; }
    return out;
  }
  /** Slicer.getLine: n = round(length) bilinear samples from (x1, y1) along the line. */
  function interpLine(a, W, H, x1, y1, x2, y2) {
    const dx = x2 - x1, dy = y2 - y1;
    const n = Math.round(Math.sqrt(dx * dx + dy * dy));
    const out = new Float32Array(n);
    const xinc = n > 0 ? dx / n : 0, yinc = n > 0 ? dy / n : 0;
    let rx = x1, ry = y1;
    for (let i = 0; i < n; i++) { out[i] = interpAt(a, W, H, rx, ry); rx += xinc; ry += yinc; }
    return out;
  }

  R.define('stkReslice', {
    kind: 'newdoc', version: 1, stack: 'whole', rgb: 'whole', roi: 'mask',
    validate(params) {
      if (!params || !(params.output > 0)) throw bad('output');
      if (params.start !== undefined && ['top', 'left', 'bottom', 'right'].indexOf(params.start) < 0) throw bad('start');
    },
    scratchBytes: (info) => info.width * info.height * info.channels * 8,
    async run(view, params, roi, io) {
      const m = model(view);
      const cal = m.calibration || { pixelWidth: 1, pixelHeight: 1, pixelDepth: 1, unit: 'pixel' };
      const pw = cal.pixelWidth || 1, ph = cal.pixelHeight || 1;
      const inputZ = cal.pixelDepth || 1;
      const flip = !!params.flip, rotate = !!params.rotate, avoid = !!params.avoid;
      // Slicer.showDialog: "outputZSpacing = outputZSpacing/cal.pixelWidth"; "avoid interpolation" keeps one pixel between the lines
      const isLine0 = !!roi && roi.type === 'line';
      const outPx = avoid && !isLine0 ? 1 : params.output / pw;
      const start = params.start || 'top';
      const isLine = roi && roi.type === 'line';
      const bx = roi && !isLine ? (() => { const b = root.IJRoi.bounds(roi); return { x: Math.max(0, b.x), y: Math.max(0, b.y), w: Math.min(m.W, b.x + b.w) - Math.max(0, b.x), h: Math.min(m.H, b.y + b.h) - Math.max(0, b.y) }; })() : { x: 0, y: 0, w: m.W, h: m.H };
      let x1, y1, x2, y2, xInc, yInc, nOut;
      if (isLine) {
        x1 = roi.x1; y1 = roi.y1; x2 = roi.x2; y2 = roi.y2;
        const dx = x2 - x1, dy = y2 - y1, nrm = Math.sqrt(dx * dx + dy * dy);
        xInc = nrm > 0 ? -(dy / nrm) * outPx : 0; yInc = nrm > 0 ? (dx / nrm) * outPx : 0;
        nOut = isInt(params.sliceCount) && params.sliceCount > 0 ? params.sliceCount : 1;
      } else if (start === 'top') { x1 = bx.x; y1 = bx.y; x2 = bx.x + bx.w; y2 = bx.y; xInc = 0; yInc = outPx; nOut = d2i(bx.h / outPx); }
      else if (start === 'left') { x1 = bx.x; y1 = bx.y; x2 = bx.x; y2 = bx.y + bx.h; xInc = outPx; yInc = 0; nOut = d2i(bx.w / outPx); }
      else if (start === 'bottom') { x1 = bx.x; y1 = bx.y + bx.h - 1; x2 = bx.x + bx.w; y2 = y1; xInc = 0; yInc = -outPx; nOut = d2i(bx.h / outPx); }
      else { x1 = bx.x + bx.w - 1; y1 = bx.y; x2 = x1; y2 = bx.y + bx.h; xInc = -outPx; yInc = 0; nOut = d2i(bx.w / outPx); }
      if (nOut < 1) throw ijError('IJ_STK_BAD_SPACING', 'Output Z spacing is too large');
      const G = root.IJGeom;
      const zSpacing = avoid ? 1 : inputZ / pw;
      const K = m.rgb ? 3 : 1, C = ctorOf(m.bd);
      // ByteProcessor / ShortProcessor.setf: (byte)(value + 0.5f) / (short)(value + 0.5f)
      const store = (v) => (m.bd === 32 ? v : (m.bd === 8 ? d2i(Math.fround(v + 0.5)) & 255 : d2i(Math.fround(v + 0.5)) & 65535));
      // one resliced stack: `planes` = the z planes (arrays of the channel k), returns the nOut output slice arrays
      const sliceOne = async (planes) => {
        const outs = [];
        const Sz = planes.length;
        for (let i = 0; i < nOut; i++) {
          const ax1 = x1 + i * xInc, ay1 = y1 + i * yInc, ax2 = x2 + i * xInc, ay2 = y2 + i * yInc;
          // Slicer.getSlice: "(x1==(int)x1 && y1==(int)y1 && x1==x2) || y1==y2" — a horizontal line is always read with getOrthoLine (at the truncated
          // coordinates: a fractional spacing along y repeats rows), a vertical one only at whole coordinates
          const ortho = (ax1 === d2i(ax1) && ay1 === d2i(ay1) && ax1 === ax2) || ay1 === ay2;
          let len = 0, rows = [];
          for (let z = 0; z < Sz; z++) {
            const a = planes[flip ? Sz - 1 - z : z];
            const line = ortho ? orthoLine(a, m.W, ax1, ay1, ax2, ay2) : interpLine(a, m.W, m.H, ax1, ay1, ax2, ay2);
            len = line.length; rows.push(line);
          }
          // assemble: a row per stack slice (a column with rotate)
          const ow = rotate ? Sz : len, oh = rotate ? len : Sz;
          let img = new C(ow * oh);
          for (let z = 0; z < Sz; z++) for (let k = 0; k < len; k++) {
            const v = store(rows[z][k]);
            if (rotate) img[k * Sz + z] = v; else img[z * len + k] = v;
          }
          if (zSpacing !== 1.0) {
            // ip2.setInterpolate(true); ip2.resize(...): (int)(stackSize*zSpacing) along the stack direction, bilinear, no averaging
            const nw = rotate ? d2i(Sz * zSpacing) : len, nh = rotate ? len : d2i(Sz * zSpacing);
            img = await G.kernels.resizeImage(img, ow, oh, m.bd, { x: 0, y: 0, w: ow, h: oh }, nw, nh, 1, false, null);
            outs.push({ a: img, w: nw, h: nh });
          } else outs.push({ a: img, w: ow, h: oh });
          if ((i & 3) === 3) { io.check(); await io.tick((i + 1) / nOut, 'op.stkReslice'); }
        }
        return outs;
      };
      // the stack(s) to cut: a hyperstack keeps its channels and frames (resliceHyperstack), a plain stack is one stack
      const nC = m.hyper ? m.nC : 1, nT = m.hyper ? m.nT : 1, nZin = m.hyper ? m.nZ : m.N;
      const results = [];   // [t][c] -> outs[k][i]
      for (let t = 0; t < nT; t++) for (let c = 0; c < nC; c++) {
        const perK = [];
        for (let k = 0; k < K; k++) {
          const planes = [];
          for (let z = 0; z < nZin; z++) planes.push(m.hyper ? m.arrays(m.index(c, z, t))[k] : m.arrays(z)[k]);
          perK.push(await sliceOne(planes));
        }
        results.push(perK);
      }
      const ow = results[0][0][0].w, oh = results[0][0][0].h;
      const slices = [];
      for (let t = 0; t < nT; t++) for (let i = 0; i < nOut; i++) for (let c = 0; c < nC; c++) {
        slices.push(results[t * nC + c].map((perK) => perK[i].a));
      }
      const cal2 = Object.assign({}, cal);
      // the calibration of the result: the in-slice horizontal pixel is the width (Top / Bottom) or the height (Left / Right) of the source pixel, the old
      // z spacing becomes the pixel height (the stack direction is resized to the source pixel width unless `avoid`), the spacing between the cut
      // lines (outPx pixels of the direction they step in) the new pixel depth
      const vertical = !isLine && (start === 'left' || start === 'right');
      cal2.pixelWidth = vertical ? ph : pw;
      cal2.pixelHeight = avoid ? inputZ : pw;
      cal2.pixelDepth = outPx * (isLine ? pw : (vertical ? pw : ph));
      const shortTitle = (() => { let t = m.view.name; let i = t.indexOf(' '); if (i > -1) t = t.substring(0, i); i = t.lastIndexOf('.'); if (i > 0) t = t.substring(0, i); return t; })();
      return [assemble({ name: 'Reslice of ' + shortTitle, W: ow, H: oh, bd: m.bd, rgb: m.rgb, nC, nZ: nOut, nT, slices, calibration: cal2, hyper: m.hyper && m.flag,
        chans: m.chans().slice(0, nC).map((d) => ({ name: d.name, color: d.color, display: d.display })), mode: nC > 1 ? m.view.mode : undefined })];
    }
  });

  // ------------------------------------------------------------------------------------------------
  // 8-bit Color   ij.process.MedianCut (Image > Type > 8-bit Color, "Number of colors (2-256)")
  // The palette comes from a median cut of the 15-bit (5 bits per colour) histogram of every slice of the stack: the cube holding the fewest levels is
  // split at the pixel median of its longest side, a cube's colour is the mean of the exact colours it holds, and each pixel gets the index of its
  // cube. ImageJ 1.54p then refines the map (MedianCut.improveInverseMap); that refinement is NOT reproduced, so for an image of more colours than
  // the palette the indices may differ from ImageJ's by a neighbouring entry (an image of at most `colors` distinct 15-bit colours converts losslessly).
  // ------------------------------------------------------------------------------------------------
  function medianCut(slices, nColors) {
    const HSIZE = 32768;
    const count = new Float64Array(HSIZE), rs = new Float64Array(HSIZE), gs = new Float64Array(HSIZE), bs = new Float64Array(HSIZE);
    for (const s of slices) {
      const n = s[0].length;
      for (let i = 0; i < n; i++) {
        const r = s[0][i], g = s[1][i], b = s[2][i];
        const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
        count[key]++; rs[key] += r; gs[key] += g; bs[key] += b;
      }
    }
    const keys = [];
    for (let k = 0; k < HSIZE; k++) if (count[k] > 0) keys.push(k);
    const comp = (k, d) => (d === 0 ? (k >> 10) & 31 : d === 1 ? (k >> 5) & 31 : k & 31);
    const mkCube = (lo, hi, level) => {
      let rmin = 31, rmax = 0, gmin = 31, gmax = 0, bmin = 31, bmax = 0, total = 0;
      for (let i = lo; i <= hi; i++) {
        const k = keys[i], r = comp(k, 0), g = comp(k, 1), b = comp(k, 2);
        if (r < rmin) rmin = r; if (r > rmax) rmax = r; if (g < gmin) gmin = g; if (g > gmax) gmax = g; if (b < bmin) bmin = b; if (b > bmax) bmax = b;
        total += count[k];
      }
      return { lo, hi, level, rmin, rmax, gmin, gmax, bmin, bmax, total };
    };
    const cubes = [mkCube(0, keys.length - 1, 0)];
    while (cubes.length < nColors) {
      let best = -1, lvl = 255;
      for (let k = 0; k < cubes.length; k++) if (cubes[k].lo !== cubes[k].hi && cubes[k].level < lvl) { lvl = cubes[k].level; best = k; }
      if (best < 0) break;
      const c = cubes[best];
      const lr = c.rmax - c.rmin, lg = c.gmax - c.gmin, lb = c.bmax - c.bmin;
      let dim = 0;
      if (lr >= lg && lr >= lb) dim = 0;
      if (lg >= lr && lg >= lb) dim = 1;
      if (lb >= lr && lb >= lg) dim = 2;
      const part = keys.slice(c.lo, c.hi + 1);
      // sort the colours of the cube along the longest side (ties by the other two components, a stable order)
      const order = [dim, (dim + 1) % 3, (dim + 2) % 3];
      part.sort((a, b) => { for (const d of order) { const x = comp(a, d) - comp(b, d); if (x) return x; } return 0; });
      for (let i = 0; i < part.length; i++) keys[c.lo + i] = part[i];
      let acc = 0, i = c.lo;
      for (; i <= c.hi - 1; i++) { if (acc >= c.total / 2) break; acc += count[keys[i]]; }
      const median = i;
      cubes[best] = mkCube(c.lo, median - 1, c.level + 1);
      cubes.push(mkCube(median, c.hi, c.level + 1));
    }
    const table = new Uint8Array(768);
    const index = new Uint8Array(HSIZE);
    cubes.forEach((c, ci) => {
      let n = 0, r = 0, g = 0, b = 0;
      for (let i = c.lo; i <= c.hi; i++) { const k = keys[i]; n += count[k]; r += rs[k]; g += gs[k]; b += bs[k]; index[k] = ci; }
      table[ci * 3] = d2i(r / n); table[ci * 3 + 1] = d2i(g / n); table[ci * 3 + 2] = d2i(b / n);
    });
    return { table, index, colors: cubes.length };
  }
  function medianCutOf(m, params) {
    if (!m.rgb) throw ijError('IJ_BAD_TYPE', 'RGB Color required');
    const n = params.colors;
    if (!isInt(n) || n < 2 || n > 256) throw bad('colors');
    return medianCut(sliceList(m), n);
  }
  R.define('stk8BitPalette', {
    kind: 'compute', version: 1, stack: 'whole', rgb: 'whole', roi: 'ignore', scratchBytes: (info) => info.width * info.height * 3 * 2,
    async run(view, params) { const r = medianCutOf(model(view), params); return { table: r.table, colors: r.colors }; }
  });
  R.define('stk8BitColor', {
    kind: 'size', version: 1, stack: 'whole', rgb: 'whole', roi: 'ignore', scratchBytes: (info) => info.width * info.height * 3 * 2,
    async run(view, params, roi, io) {
      const m = model(view);
      const r = medianCutOf(m, params);
      const slices = [];
      for (let k = 0; k < m.N; k++) {
        const a = m.arrays(k), out = new Uint8Array(m.W * m.H);
        for (let i = 0; i < out.length; i++) out[i] = r.index[((a[0][i] >> 3) << 10) | ((a[1][i] >> 3) << 5) | (a[2][i] >> 3)];
        slices.push([out]);
        if ((k & 7) === 7) { io.check(); await io.tick((k + 1) / m.N, 'op.stk8BitColor'); }
      }
      const lut = params.lutName || null;
      return resultOf(m, { slices, labels: labelList(m), nC: 1, nZ: m.nZ, nT: m.nT, hyper: m.flag, rgb: false, bd: 8, active: 0,
        chans: [{ name: 'C1', color: '#ffffff', display: { min: 0, max: 255, lut: lut || r.table, invert: false } }] });
    }
  });

  // ------------------------------------------------------------------------------------------------
  // Image > Hyperstacks > New Hyperstack...   ij.plugin.HyperStackMaker: a black image of the chosen type and dimensions.
  // args { name, type: '8' | '16' | '32' | 'rgb', display: composite | color | gray, width, height, channels, slices, frames, label }
  // An RGB image has no channels of its own here (its three colours are one slice), so `channels` is ignored for it. The planes of a channel are the
  // SAME zero array (every array of the engine is immutable), so a large blank stack costs one plane per channel.
  // ------------------------------------------------------------------------------------------------
  if (typeof R.defineCommand === 'function') {
    R.defineCommand('stk.newHyperstack', {
      pkg: 'stk', long: true,
      async handler(args, E) {
        const a = args || {};
        const ok = (v, max) => isInt(v) && v >= 1 && v <= max;
        if (!ok(a.width, 65535) || !ok(a.height, 65535) || !ok(a.channels, 1000) || !ok(a.slices, 100000) || !ok(a.frames, 100000)) throw bad('dimensions');
        if (['8', '16', '32', 'rgb'].indexOf(a.type) < 0) throw bad('type');
        const rgb = a.type === 'rgb', bd = rgb ? 8 : Number(a.type);
        const nC = rgb ? 1 : a.channels, nZ = a.slices, nT = a.frames, NP = nZ * nT;
        const C = ctorOf(bd), COLORS = ['#ff0000', '#00ff00', '#0000ff', '#ffffff', '#00ffff', '#ff00ff', '#ffff00'];
        const k = rgb ? 3 : nC;
        const channels = [];
        for (let c = 0; c < k; c++) {
          const blank = new C(a.width * a.height);
          const planes = new Array(NP).fill(blank);
          channels.push(rgb ? { name: RGB_CHANNELS[c].name, color: RGB_CHANNELS[c].color, planes } : { name: 'C' + (c + 1), color: nC > 1 && c < 7 ? COLORS[c] : '#ffffff', planes });
        }
        let labels;
        if (a.label) { labels = []; for (let t = 0; t < nT; t++) for (let z = 0; z < nZ; z++) for (let c = 0; c < nC; c++) labels.push('"' + (c + 1) + ',' + (z + 1) + ',' + (t + 1) + '"'); }
        const mode = nC > 1 ? (['composite', 'color', 'gray'].indexOf(a.display) >= 0 ? a.display : 'composite') : undefined;
        const image = { name: String(a.name || 'HyperStack'), width: a.width, height: a.height, bitDepth: bd, nZ, nT, rgb, labels,
          hyperstack: ((nC > 1 ? 1 : 0) + (nZ > 1 ? 1 : 0) + (nT > 1 ? 1 : 0)) >= 2, calibration: { pixelWidth: 1, pixelHeight: 1, pixelDepth: 1, unit: 'pixel' }, channels };
        if (mode) image.mode = mode;
        return E.createDoc(image, {});
      }
    });
  }

  root.IJStk = { shortLabel, insertPlanes, paste, model, sliceList, labelList, assemble, resultOf, reindex, parseIndexList, blankSlice, ORDERS, RGB_CHANNELS, ctorOf, bytesOf, d2i, ijError, range0, hasLabel };
})(typeof self !== 'undefined' ? self : globalThis);
