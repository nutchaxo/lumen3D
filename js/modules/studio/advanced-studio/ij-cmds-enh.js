/* ij-cmds-enh.js — menu commands of package P-enh (enhancement and noise): Process > Noise > Add Noise / Add Specified
 * Noise / Salt and Pepper, Process > Enhance Local Contrast (CLAHE), Process > Filters > Frangi Vesselness,
 * Plugins > Analyze > Tubeness.
 *
 * Page only, runs before IJApp.mount; talks to the app through the documented extension API (IJApp.EXT_API_MEMBERS) and to
 * the worker through the registry operations of ij-proc-enh.js (addNoise, saltAndPepper, clahe, claheMask, enhDataRange,
 * tubeness, frangi). Labels and fields are Fiji's / ImageJ's text (en); the dialogs follow tests/fixtures/ij-wave3/fiji-dialogs.json:
 *   Add Noise / Salt and Pepper   no dialog (ij.plugin.filter.Filters "add": noise(25.0); SaltAndPepper.add(ip, 0.05))
 *   Add Specified Noise           Standard Deviation: 25.00   (Filters.java: addNumericField("Standard Deviation:", sd, 2))
 *   CLAHE                         blocksize 127 / histogram bins 256 / maximum slope 3.00 / mask [*None*, every open image, in
 *                                 the order Fiji lists them: a size or type that does not fit is refused when it runs] / fast
 *                                 (less accurate) / process as composite (multichannel only, true)
 * The last values of Add Specified Noise and of the CLAHE dialog are remembered (api.settings enh.*), as ImageJ keeps them in
 * static fields (Filters: sd = Prefs.getDouble(Prefs.NOISE_SD, 25.0)).
 *   Tubeness                      Sigma / Use calibration information
 *   Frangi Vesselness             Apply Gaussian at each scale: / Spacing / Scale
 *
 * The random commands draw a 31-bit seed when they run and journal it (the engine's journal and Image Info show it): ImageJ has
 * no visible seed, a replay must give the same noise. Repeat Command draws a new one, as ImageJ's does.
 * CLAHE is a display aid: the dialog says so, and a time estimate precedes a long run.
 */
(function () {
  'use strict';
  if (typeof IJApp === 'undefined' || typeof IJApp.extend !== 'function') return;

  const pure = () => (typeof IJEnhPkg !== 'undefined' ? IJEnhPkg : null);
  const has = (st) => !!st.doc && !st.busy && !!pure();
  const nChan = (info) => (info && Array.isArray(info.channels) ? info.channels.length : 0);

  /* A fresh seed for one run: 31 random bits, never zero-length (journaled with the step, so a replay is exact). */
  function newSeed() {
    try {
      if (typeof crypto !== 'undefined' && crypto.getRandomValues) { const a = new Uint32Array(1); crypto.getRandomValues(a); return a[0] & 0x7fffffff; }
    } catch (_) { /* fall through */ }
    return Math.floor(Math.random() * 2147483647);
  }

  const pref = (api, key, ok, dflt) => { try { const v = api.settings.get(key); return ok(v) ? v : dflt; } catch (_) { return dflt; } };
  const remember = (api, key, v) => { try { api.settings.set(key, v); } catch (_) { /* a per-viewer convenience only */ } };
  const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

  // The "process all channels" box exists only on an image with several channels (as the other packages' dialogs).
  const allField = (st) => (nChan(st.doc) > 1 ? [{ type: 'check', id: 'all', labelKey: 'dlg.allChannels', value: false }] : []);


  /* ImageJ asks "Process all N images?" (IJ.setupDialog) of a command with no dialog of its own too: Add Noise and Salt and Pepper on an
   * image with several channels offer the same choice; null = cancelled. */
  async function askAllChannels(api, st, titleKey) {
    if (nChan(st.doc) < 2) return false;
    const v = await api.dialog({ titleKey, fields: allField(st) });
    if (!v) return null;
    const now = api.state();
    if (!now.doc || now.doc.docId !== st.doc.docId) return null;
    return !!v.all;
  }

  async function addNoise(api, sd, all, labelKey) {
    const st = api.state();
    if (!st.doc) return;
    // ShortProcessor.noise / FloatProcessor.noise end with resetMinAndMax(): the op's display '16/32' does that inside the undo step
    await api.run('addNoise', { seed: newSeed(), sd }, { docId: st.doc.docId, channel: all ? 'all' : st.activeChannel, labelKey });
  }

  const timeText = (api, seconds) => (seconds < 90 ? api.tr('dlg.enh.seconds', { n: Math.max(1, Math.round(seconds)) }) : api.tr('dlg.enh.minutes', { n: Math.round(seconds / 60) }));

  const commands = [
    // ── Process > Noise
    {
      id: 'noiseAdd', menu: ['Process', 'Noise'], order: 5, long: true,
      async run(api) {
        const st = api.state();
        if (!st.doc) return;
        const all = await askAllChannels(api, st, 'cmd.noiseAdd');
        if (all === null) return;
        await addNoise(api, 25.0, all, 'cmd.noiseAdd');
      }
    },
    {
      id: 'noiseAddSpecified', menu: ['Process', 'Noise'], order: 6, long: true,
      async run(api) {
        const st = api.state();
        if (!st.doc) return;
        const v = await api.dialog({
          titleKey: 'dlg.enh.noiseTitle',
          fields: [{ type: 'number', id: 'sd', labelKey: 'dlg.enh.sd', value: pref(api, 'enh.noiseSd', (x) => isNum(x) && x >= 0 && x <= pure().NOISE_MAX_SD, 25), min: 0, max: pure().NOISE_MAX_SD, step: 1, decimals: 2 }].concat(allField(st))
        });
        if (!v) return;
        const now = api.state();
        if (!now.doc || now.doc.docId !== st.doc.docId) return;
        // an 8 / 16-bit pixel is redrawn until it stays in range (no bound in ImageJ): a huge sd announces its time first
        const E = pure(), chans = v.all ? nChan(st.doc) : 1;
        const secs = E.noiseSeconds(st.doc.width, st.doc.height, Math.max(1, chans), st.doc.bitDepth, v.sd);
        if (secs >= 10) {
          const go = await api.dialog({ titleKey: 'dlg.enh.noiseTitle', fields: [{ type: 'message', id: 'estimate', label: api.tr('dlg.enh.noiseEstimate', { time: timeText(api, secs) }) }] });
          if (!go) return;
        }
        remember(api, 'enh.noiseSd', v.sd);
        await addNoise(api, v.sd, !!v.all, 'cmd.noiseAddSpecified');
      }
    },
    {
      id: 'noiseSaltPepper', menu: ['Process', 'Noise'], order: 7, long: true,
      enabled: (st) => has(st) && st.doc.bitDepth === 8,   // DOES_8G + DOES_8C
      async run(api) {
        const st = api.state();
        if (!st.doc) return;
        const all = await askAllChannels(api, st, 'cmd.noiseSaltPepper');
        if (all === null) return;
        await api.run('saltAndPepper', { seed: newSeed(), percent: 0.05 }, { docId: st.doc.docId, channel: all ? 'all' : st.activeChannel, labelKey: 'cmd.noiseSaltPepper' });
      }
    },

    // ── Process > Enhance Local Contrast (CLAHE)
    {
      id: 'procCLAHE', menu: ['Process'], order: 130, separatorBefore: true, long: true,
      async run(api) {
        const st = api.state();
        const info = st.doc;
        if (!info) return;
        const E = pure();
        // the mask choices: every open image in Fiji's order (the image itself and a 16-bit one are listed too); a size or a bit depth that
        // cannot be a mask is refused when the command runs (IJ_ENH_MASK_SIZE / IJ_ENH_MASK_TYPE)
        const masks = st.docs || [];
        const multi = nChan(info) > 1;
        const big = info.width * info.height > E.CLAHE_SLOW_MAX_PIXELS;
        const v = await api.dialog({
          titleKey: 'dlg.enh.claheTitle',
          fields: [
            { type: 'number', id: 'blocksize', labelKey: 'dlg.enh.blocksize', value: pref(api, 'enh.claheBlocksize', (x) => Number.isInteger(x) && x >= 3 && x <= 100001, 127), min: 3, max: 100001, step: 2, integer: true },
            { type: 'number', id: 'bins', labelKey: 'dlg.enh.bins', value: pref(api, 'enh.claheBins', (x) => Number.isInteger(x) && x >= 2 && x <= 256, 256), min: 2, max: 256, step: 1, integer: true },
            { type: 'number', id: 'slope', labelKey: 'dlg.enh.slope', value: pref(api, 'enh.claheSlope', (x) => isNum(x) && x >= 1 && x <= 100, 3), min: 1, max: 100, step: 0.5, decimals: 2 },
            { type: 'choice', id: 'mask', labelKey: 'dlg.enh.mask', value: 'none', options: [{ value: 'none', labelKey: 'dlg.enh.maskNone' }].concat(masks.map((d) => ({ value: d.docId, label: d.name }))) },
            { type: 'check', id: 'fast', labelKey: 'dlg.enh.fast', value: pref(api, 'enh.claheFast', (x) => typeof x === 'boolean', true) },
            { type: 'check', id: 'composite', labelKey: 'dlg.enh.composite', value: pref(api, 'enh.claheComposite', (x) => typeof x === 'boolean', true), visibleIf: () => multi },
            { type: 'message', id: 'note', labelKey: 'dlg.enh.claheNote' }
          ],
          validate: (x) => (!x.fast && big ? { fast: 'err.enhClaheSlowTooLarge' } : null)
        });
        if (!v) return;
        const now = api.state();
        if (!now.doc || now.doc.docId !== info.docId) return;
        remember(api, 'enh.claheBlocksize', v.blocksize); remember(api, 'enh.claheBins', v.bins); remember(api, 'enh.claheSlope', v.slope);
        remember(api, 'enh.claheFast', !!v.fast);
        if (multi) remember(api, 'enh.claheComposite', v.composite !== false);
        const chans = multi && v.composite !== false ? info.channels.length : 1;
        const params = { blocksize: v.blocksize, bins: v.bins, slope: v.slope, fast: !!v.fast };
        // a long run announces its time first
        const secs = E.claheSeconds(info.width, info.height, chans, params);
        if (secs >= 10) {
          const go = await api.dialog({ titleKey: 'dlg.enh.claheTitle', fields: [{ type: 'message', id: 'estimate', label: api.tr('dlg.enh.claheEstimate', { time: timeText(api, secs) }) }] });
          if (!go) return;
        }
        if (v.mask !== 'none' && v.mask !== undefined) {
          const m = await api.compute('claheMask', { maskDocId: v.mask }, { docId: info.docId, docIds: v.mask === info.docId ? [info.docId] : [info.docId, v.mask], channel: 0, labelKey: 'cmd.procCLAHE' });
          if (!m) return;
          params.mask = await api.putBlob(m.data);
        }
        await api.run('clahe', params, { docId: info.docId, channel: chans > 1 ? 'all' : st.activeChannel, noRoi: true, labelKey: 'cmd.procCLAHE' });
      }
    },

    // ── Process > Filters > Frangi Vesselness
    {
      id: 'pluginsFrangi', menu: ['Process', 'Filters'], order: 900, separatorBefore: true, long: true,
      async run(api) {
        const st = api.state();
        const info = st.doc;
        if (!info) return;
        const E = pure();
        const v = await api.dialog({
          titleKey: 'dlg.enh.frangiTitle',
          fields: [
            { type: 'check', id: 'doGauss', labelKey: 'dlg.enh.frangiGauss', value: false },
            { type: 'string', id: 'spacing', labelKey: 'dlg.enh.spacing', value: '1, 1' },
            { type: 'message', id: 'spacingNote', labelKey: 'dlg.enh.spacingNote' },
            { type: 'string', id: 'scales', labelKey: 'dlg.enh.scales', value: '2, 5' },
            { type: 'message', id: 'scalesNote', labelKey: 'dlg.enh.scalesNote' },
            { type: 'message', id: 'channelNote', labelKey: 'dlg.enh.activeChannelNote', visibleIf: () => nChan(info) > 1 }
          ],
          validate(x) {
            const out = {};
            const sp = E.parseSpacing(x.spacing, 2);
            if (!sp || sp.some((s) => !(s > 0))) out.spacing = 'dlg.enh.spacingBad';
            const sc = E.parseNumberList(x.scales, true);
            if (!sc || sc.length > E.MAX_SCALES || sc.some((s) => s < 1 || s > E.MAX_SCALE)) out.scales = 'dlg.enh.scalesBad';
            return Object.keys(out).length ? out : null;
          }
        });
        if (!v) return;
        const now = api.state();
        if (!now.doc || now.doc.docId !== info.docId) return;
        const params = { doGauss: !!v.doGauss, spacing: E.parseSpacing(v.spacing, 2), scales: E.parseNumberList(v.scales, true) };
        await api.run('frangi', params, { docId: info.docId, channel: st.activeChannel, noRoi: true, labelKey: 'cmd.pluginsFrangi', placement: 'splitRight' });
      }
    },

    // ── Plugins > Analyze > Tubeness
    {
      id: 'pluginsTubeness', menu: ['Plugins', 'Analyze'], order: 20, long: true,
      async run(api) {
        const st = api.state();
        const info = st.doc;
        if (!info) return;
        // "The default value for sigma is the minimum voxel separation": the smaller pixel size of a calibrated image, else 1
        const cal = info.calibration || {};
        const calibrated = !!cal.unit && cal.unit !== 'pixel' && cal.unit !== 'px' && cal.pixelWidth > 0 && cal.pixelHeight > 0;
        const sigma0 = calibrated ? Math.min(cal.pixelWidth, cal.pixelHeight) : 1;
        const v = await api.dialog({
          titleKey: 'dlg.enh.tubenessTitle',
          fields: [
            { type: 'number', id: 'sigma', labelKey: 'dlg.enh.sigma', value: Number(sigma0.toPrecision(6)), min: 0.0001, max: 100, step: 0.1, decimals: 4 },
            { type: 'message', id: 'sigmaNote', labelKey: 'dlg.enh.sigmaNote' },
            { type: 'check', id: 'useCalibration', labelKey: 'dlg.enh.useCalibration', value: true },
            { type: 'message', id: 'channelNote', labelKey: 'dlg.enh.activeChannelNote', visibleIf: () => nChan(info) > 1 }
          ]
        });
        if (!v) return;
        const now = api.state();
        if (!now.doc || now.doc.docId !== info.docId) return;
        await api.run('tubeness', { sigma: v.sigma, useCalibration: !!v.useCalibration }, { docId: info.docId, channel: st.activeChannel, noRoi: true, labelKey: 'cmd.pluginsTubeness', placement: 'splitRight' });
      }
    }
  ];

  IJApp.extend({
    pkg: 'enh',
    commands: commands.map((c) => Object.assign({ enabled: has }, c)),
    errors: {
      IJ_ENH_CLAHE_SLOW_TOO_LARGE: 'err.enhClaheSlowTooLarge',
      IJ_ENH_MASK_SIZE: 'err.enhMaskSize',
      IJ_ENH_MASK_TYPE: 'err.enhMaskType'
    }
  });
})();
