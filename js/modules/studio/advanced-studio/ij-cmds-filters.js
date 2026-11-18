/* ij-cmds-filters.js — menu commands of package P2 (filters): Smooth / Sharpen / Find Edges, Unsharp Mask, Convolve,
 * Variance, Remove Outliers, Despeckle, Remove NaNs, Top Hat, Process > Math (Log, Exp, Square, Square Root, Reciprocal,
 * Gamma, AND, OR, XOR, NaN Background).
 *
 * Page only, runs before IJApp.mount. The commands talk to the extension API of ij-app.js (api.state / dialog / run /
 * setDisplay …) and nothing else; the operations they start are the ones ij-proc-filters.js registers
 * (IJOpRegistry, in the worker). Dialogs mirror ImageJ's: same fields, same defaults, same limits.
 *
 * What ImageJ does after the filter, and what this file does about it:
 *   - Variance / Top Hat (16 and 32 bit) call ContrastEnhancer.stretchHistogram(ip, 0.5) on the result, Convolve and
 *     NaN Background call resetMinAndMax(): the display range of the channel follows the result. Only the DISPLAY
 *     range is set (api.setDisplay: not an undo step, no pixel touched). Variance / Top Hat go through the
 *     `saturatedRange` compute of the Enhance Contrast package when this build has it; Convolve / NaN Background
 *     take the exact data range of the whole image (`fltDataRange`; 8-bit: 0..255).
 */
(function () {
  'use strict';
  if (typeof IJApp === 'undefined' || typeof IJApp.extend !== 'function') return;

  const pure = () => (typeof IJFiltersPkg !== 'undefined' ? IJFiltersPkg : null);
  // The page-side half of the package (kernel / bit-pattern parsing) must be there too, not only the worker's.
  const has = (st) => !!st.doc && !st.busy && !!pure();
  const is32 = (st) => has(st) && st.doc.bitDepth === 32;
  const not32 = (st) => has(st) && st.doc.bitDepth !== 32;

  const KERNEL_5X5 = '-1 -1 -1 -1 -1\n-1 -1 -1 -1 -1\n-1 -1 24 -1 -1\n-1 -1 -1 -1 -1\n-1 -1 -1 -1 -1\n';

  // The "process all channels" box exists only on an image with several channels (as the v1 dialogs).
  const allField = (st) => ((st.doc.channels || []).length > 1 ? [{ type: 'check', id: 'all', labelKey: 'dlg.allChannels', value: false }] : []);
  const channelsOf = (st, v) => (v && v.all ? st.doc.channels.map((c, i) => i) : [st.activeChannel]);
  const radiusField = (value, max) => ({ type: 'number', id: 'radius', labelKey: 'dlg.radius', value, min: 0, max, step: 0.5, decimals: 1, unitsKey: 'dlg.pixels' });

  /* Sets the display range of the channels a filter just changed (see the header). A build without the compute, or
   * an image of 8 bits (ImageJ leaves its display alone), changes nothing. */
  async function followDisplay(api, st, channels, saturated) {
    if (st.doc.bitDepth === 8) return;
    for (const c of channels) {
      const args = [{ saturated, normalize: false }, { docId: st.doc.docId, channel: c }];
      try { await api.estimate('saturatedRange', args[0], args[1]); } catch (_) { return; } // the package that owns it is not here
      const r = await api.compute('saturatedRange', args[0], args[1]);
      if (r && Number.isFinite(r.displayMin) && Number.isFinite(r.displayMax) && r.displayMin <= r.displayMax) {
        await api.setDisplay(st.doc.docId, c, { min: r.displayMin, max: r.displayMax });
      }
    }
  }

  /* resetMinAndMax() of Convolver ("final", no selection) and ImageMath.setBackgroundToNaN: the EXACT min and max of the
   * whole image (fltDataRange), not a histogram bin edge, whatever the selection. ByteProcessor.resetMinAndMax() is
   * setMinAndMax(0, 255). */
  async function resetDisplay(api, st, channels) {
    for (const c of channels) {
      if (st.doc.bitDepth === 8) { await api.setDisplay(st.doc.docId, c, { min: 0, max: 255 }); continue; }
      const r = await api.compute('fltDataRange', {}, { docId: st.doc.docId, channel: c, roi: null });
      if (r && Number.isFinite(r.min) && Number.isFinite(r.max) && r.min <= r.max) await api.setDisplay(st.doc.docId, c, { min: r.min, max: r.max });
    }
  }

  // A command with no dialog (Smooth, Sharpen, Find Edges, Despeckle, the plain Math ops): the active channel, as ImageJ does on a composite.
  async function plain(api, op, params, labelKey) {
    const st = api.state();
    if (!st.doc) return;
    await api.run(op, params, { channel: st.activeChannel, labelKey });
  }

  /* A command with a dialog: fields (+ the all-channels box), the Preview of the pixel op, then the run. `build(values)`
   * → params (pure); `validate` as the dialog's. `after(api, st, values, result)` runs when the step went through. */
  async function withDialog(api, c) {
    const st = api.state();
    if (!st.doc) return;
    const spec = {
      titleKey: c.titleKey,
      fields: c.fields(st).concat(allField(st)),
      preview: { op: c.op, params: c.build }
    };
    if (c.validate) spec.validate = c.validate;
    // The preview and the run both read the channel and the image the dialog was opened on (the dialog is non-modal).
    spec.preview.channel = (vals) => (vals.all ? 'all' : st.activeChannel);
    const v = await api.dialog(spec);
    if (!v) return;
    const now = api.state();
    if (!now.doc || now.doc.docId !== st.doc.docId) return;
    const res = await api.run(c.op, c.build(v), { docId: st.doc.docId, channel: v.all ? 'all' : st.activeChannel, labelKey: c.labelKey });
    if (res && c.after) await c.after(api, st, v, res);
  }

  const noteVariance = (st) => (st.doc.bitDepth === 32 ? [] : [{ type: 'message', id: 'note', labelKey: 'dlg.flt.varianceNote' }]);

  // ── the commands ──────────────────────────────────────────────────────────────────────────────────

  const filterCommands = [
    {
      id: 'procSmooth', menu: ['Process'], order: 10, shortcut: 'Ctrl+Shift+S', keys: ['Ctrl+Shift+S'],
      run: (api) => plain(api, 'filter3x3', { type: 'smooth' }, 'cmd.procSmooth')
    },
    { id: 'procSharpen', menu: ['Process'], order: 20, run: (api) => plain(api, 'filter3x3', { type: 'sharpen' }, 'cmd.procSharpen') },
    { id: 'procFindEdges', menu: ['Process'], order: 30, run: (api) => plain(api, 'filter3x3', { type: 'edges' }, 'cmd.procFindEdges') },

    // ── Process > Noise
    { id: 'noiseDespeckle', menu: ['Process', 'Noise'], order: 10, run: (api) => plain(api, 'rank', { type: 'median', radius: 1 }, 'cmd.noiseDespeckle') },
    {
      id: 'noiseRemoveOutliers', menu: ['Process', 'Noise'], order: 20, long: true,
      run: (api) => withDialog(api, {
        titleKey: 'cmd.noiseRemoveOutliers', op: 'rankExtra', labelKey: 'cmd.noiseRemoveOutliers',
        fields: () => [
          radiusField(2, 100),
          { type: 'number', id: 'threshold', labelKey: 'dlg.flt.threshold', value: 50, min: 0, step: 1 },
          { type: 'choice', id: 'which', labelKey: 'dlg.flt.which', value: 'outliersBright', options: [
            { value: 'outliersBright', labelKey: 'dlg.flt.bright' }, { value: 'outliersDark', labelKey: 'dlg.flt.dark' }] }
        ],
        build: (v) => ({ type: v.which, radius: v.radius, threshold: v.threshold })
      })
    },
    {
      id: 'noiseRemoveNaNs', menu: ['Process', 'Noise'], order: 30, long: true, enabled: is32,
      run: (api) => withDialog(api, {
        titleKey: 'cmd.noiseRemoveNaNs', op: 'removeNaNs', labelKey: 'cmd.noiseRemoveNaNs',
        fields: () => [radiusField(2, 100)],
        build: (v) => ({ radius: v.radius })
      })
    },

    // ── Process > Math
    {
      id: 'mathAnd', menu: ['Process', 'Math'], order: 50, enabled: not32,
      run: (api) => binaryMath(api, 'and', 'cmd.mathAnd')
    },
    { id: 'mathOr', menu: ['Process', 'Math'], order: 60, enabled: not32, run: (api) => binaryMath(api, 'or', 'cmd.mathOr') },
    { id: 'mathXor', menu: ['Process', 'Math'], order: 70, enabled: not32, run: (api) => binaryMath(api, 'xor', 'cmd.mathXor') },
    {
      id: 'mathGamma', menu: ['Process', 'Math'], order: 100,
      run: (api) => withDialog(api, {
        titleKey: 'cmd.mathGamma', op: 'math2', labelKey: 'cmd.mathGamma',
        fields: () => [{ type: 'slider', id: 'value', labelKey: 'dlg.flt.gammaValue', value: 0.5, min: 0.05, max: 5, step: 0.01 }],
        build: (v) => ({ op: 'gamma', value: v.value })
      })
    },
    { id: 'mathLog', menu: ['Process', 'Math'], order: 120, run: (api) => plain(api, 'math2', { op: 'log' }, 'cmd.mathLog') },
    { id: 'mathExp', menu: ['Process', 'Math'], order: 130, run: (api) => plain(api, 'math2', { op: 'exp' }, 'cmd.mathExp') },
    { id: 'mathSquare', menu: ['Process', 'Math'], order: 140, run: (api) => plain(api, 'math2', { op: 'sqr' }, 'cmd.mathSquare') },
    { id: 'mathSqrt', menu: ['Process', 'Math'], order: 150, run: (api) => plain(api, 'math2', { op: 'sqrt' }, 'cmd.mathSqrt') },
    { id: 'mathReciprocal', menu: ['Process', 'Math'], order: 160, enabled: is32, run: (api) => plain(api, 'math2', { op: 'reciprocal' }, 'cmd.mathReciprocal') },
    { id: 'mathNaNBackground', menu: ['Process', 'Math'], order: 170, enabled: is32, run: (api) => nanBackground(api) },

    // ── Process > Filters
    {
      id: 'filterConvolve', menu: ['Process', 'Filters'], order: 10, long: true,
      run: (api) => {
        let lastGood = null; // the preview keeps the last valid kernel while the operator is typing
        return withDialog(api, {
          titleKey: 'cmd.filterConvolve', op: 'convolve', labelKey: 'cmd.filterConvolve',
          fields: () => [
            { type: 'message', id: 'help', labelKey: 'dlg.flt.kernelHelp' },
            { type: 'textarea', id: 'kernel', labelKey: 'dlg.flt.kernel', value: KERNEL_5X5, rows: 10, monospace: true },
            { type: 'check', id: 'normalize', labelKey: 'dlg.flt.normalize', value: true }
          ],
          validate: (v) => { const k = pure().parseKernel(v.kernel); return k.error ? { kernel: k.error } : null; },
          build: (v) => {
            const k = pure().parseKernel(v.kernel);
            if (k.error) { if (lastGood) return lastGood; throw new Error('kernel'); }
            lastGood = { kernel: k.kernel, kw: k.kw, kh: k.kh, normalize: !!v.normalize };
            return lastGood;
          },
          // Convolver.setup("final"): `if (arg.equals("final")&&imp.getRoi()==null) { imp.getProcessor().resetMinAndMax(); ...`
          after: (a, st, v) => (st.roi ? null : resetDisplay(a, st, channelsOf(st, v)))
        });
      }
    },
    {
      id: 'filterUnsharp', menu: ['Process', 'Filters'], order: 70, long: true,
      run: (api) => withDialog(api, {
        titleKey: 'cmd.filterUnsharp', op: 'unsharpMask', labelKey: 'cmd.filterUnsharp',
        fields: () => [
          { type: 'number', id: 'sigma', labelKey: 'dlg.flt.unsharpSigma', value: 1, min: 0, step: 0.5, decimals: 1, unitsKey: 'dlg.pixels' },
          { type: 'number', id: 'weight', labelKey: 'dlg.flt.unsharpWeight', value: 0.6, min: 0, max: 0.99, step: 0.05, decimals: 2 }
        ],
        build: (v) => ({ sigma: v.sigma, weight: v.weight })
      })
    },
    {
      id: 'filterVariance', menu: ['Process', 'Filters'], order: 80, long: true,
      run: (api) => withDialog(api, {
        titleKey: 'cmd.filterVariance', op: 'rankExtra', labelKey: 'cmd.filterVariance',
        fields: (st) => [radiusField(2, 1000)].concat(noteVariance(st)),
        build: (v) => ({ type: 'variance', radius: v.radius }),
        after: (a, st, v) => followDisplay(a, st, channelsOf(st, v), 0.5)
      })
    },
    {
      id: 'filterTopHat', menu: ['Process', 'Filters'], order: 90, long: true,
      run: (api) => withDialog(api, {
        titleKey: 'cmd.filterTopHat', op: 'topHat', labelKey: 'cmd.filterTopHat',
        fields: () => [
          radiusField(2, 1000),
          { type: 'check', id: 'light', labelKey: 'dlg.flt.light', value: false },
          { type: 'check', id: 'dontSubtract', labelKey: 'dlg.flt.dontSubtract', value: false }
        ],
        build: (v) => ({ radius: v.radius, light: !!v.light, dontSubtract: !!v.dontSubtract }),
        after: (a, st, v) => (v.dontSubtract ? null : followDisplay(a, st, channelsOf(st, v), 0.5))
      })
    }
  ];

  /* ImageMath "AND" / "OR" / "XOR": a binary string (default "11110000"); Integer.parseInt(value, 2). */
  function binaryMath(api, op, labelKey) {
    return withDialog(api, {
      titleKey: labelKey, op: 'math2', labelKey,
      fields: () => [{ type: 'string', id: 'bits', labelKey: 'dlg.flt.binaryValue', value: '11110000' }],
      validate: (v) => (pure().parseBinary(v.bits) === null ? { bits: 'dlg.flt.binaryBad' } : null),
      build: (v) => ({ op, value: pure().parseBinary(v.bits) === null ? 0 : pure().parseBinary(v.bits) })
    });
  }

  /* ImageMath.setBackgroundToNaN: "Thresholded 32-bit float image required" — the range is the one the Threshold window
   * holds (state().threshold is null until that window has been opened). */
  // The threshold floats are 32-bit values: show them with the digits that identify a float, not a double's noise.
  const fmt = (x) => String(Number(Math.fround(x).toPrecision(7)));
  async function nanBackground(api) {
    let st = api.state();
    if (!st.doc) return;
    let th = st.threshold;
    if (!th || th.docId !== st.doc.docId) {
      await api.openTool('threshold');
      st = api.state();
      th = st.threshold;
    }
    if (!th || !st.doc || th.docId !== st.doc.docId || !(th.lower <= th.upper)) { api.error({ code: 'IJ_FLT_NO_THRESHOLD' }); return; }
    const v = await api.dialog({
      titleKey: 'cmd.mathNaNBackground',
      fields: [{ type: 'message', id: 'msg', label: api.tr('dlg.flt.nanMessage', { lower: fmt(th.lower), upper: fmt(th.upper) }) }]
    });
    if (!v) return;
    const now = api.state();
    if (!now.doc || now.doc.docId !== th.docId) return;
    const res = await api.run('nanBackground', { lower: th.lower, upper: th.upper }, { docId: th.docId, channel: th.channel, labelKey: 'cmd.mathNaNBackground' });
    if (res) await resetDisplay(api, st, [th.channel]);
  }

  IJApp.extend({
    pkg: 'filters',
    commands: filterCommands.map((c) => Object.assign({ enabled: has }, c)),
    errors: { IJ_FLT_NO_THRESHOLD: 'err.fltNoThreshold' }
  });
})();
