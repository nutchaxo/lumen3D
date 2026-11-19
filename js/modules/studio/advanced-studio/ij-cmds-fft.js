/* ij-cmds-fft.js — menu commands of package P-fft (wave 3): Process › FFT (FFT, Inverse FFT, FFT Options…, Bandpass Filter…,
 * Swap Quadrants) and Analyze › Directionality.
 *
 * Page only, runs before IJApp.mount; talks to the app through the documented extension API and to the worker through
 * the operations ij-proc-fft.js registers (fft, inverseFft, bandpass, bandpassFilter, swapQuadrants, directionality).
 *
 * Dialogs mirror ImageJ's / Fiji's (labels are theirs, see lang/en.json):
 *   FFT Options        ij.plugin.FFT.showDialog: "Display:", 'FFT ("FFT of...") window', "Raw power spectrum" (the Fast Hartley,
 *                      Complex, "Reuse window" and "Do forward transform" boxes are not offered). Kept in the settings
 *                      fft.fftWindow / fft.rawPs. FFT.doForwardTransform: "if (!(iDisplayFHT || iDisplayComplex || iDisplayRawPS))
 *                      iDisplayFFT = true" — with the raw spectrum off the FFT window is shown whatever its box says.
 *   Bandpass Filter    ij.plugin.filter.FFTFilter.showBandpassDialog (+ the all-channels box of the other filters)
 *   Directionality     Fiji's Directionality analysis v2.3.0 (fiji-dialogs.json): Method, Nbins, Histogram start / end,
 *                      Build orientation map, Display color wheel, Display table (the "Debug" box is not offered)
 * FFT, Inverse FFT, Bandpass and Directionality refuse to preview: they take seconds on a real image.
 */
(function () {
  'use strict';
  if (typeof IJApp === 'undefined' || typeof IJApp.extend !== 'function') return;

  const idle = (st) => !!st.doc && !st.busy;
  const nChan = (st) => (st.doc && Array.isArray(st.doc.channels) ? st.doc.channels.length : 0);
  const err = (code) => Object.assign(new Error(code), { code });
  const STRIPE_INDEX = { none: 0, horizontal: 1, vertical: 2 };
  const STRIPE_OPTIONS = [
    { value: 'none', labelKey: 'dlg.fft.stripeNone' },
    { value: 'horizontal', labelKey: 'dlg.fft.stripeHorizontal' },
    { value: 'vertical', labelKey: 'dlg.fft.stripeVertical' }
  ];
  const allField = (st, value) => (nChan(st) > 1 ? [{ type: 'check', id: 'all', labelKey: 'dlg.allChannels', value: value !== false }] : []);
  // FFTFilter keeps every field of its dialog in static fields: the last values come back next time, until the session ends.
  const BAND = { large: 40, small: 3, stripes: 'none', tolerance: 5, autoscale: true, saturate: true, displayFilter: false, all: true };

  // A setting, whatever the api answers (a synchronous value; the recording api of the tests answers a promise).
  function setting(api, key, dflt) {
    let v;
    try { v = api.settings.get(key); } catch (_) { v = undefined; }
    return typeof v === 'boolean' ? v : dflt;
  }
  const fftOptions = (api) => ({ fftWindow: setting(api, 'fft.fftWindow', true), rawPs: setting(api, 'fft.rawPs', false) });

  // ---- the hue wheel of the orientation map and of the colour wheel ----------------------------------------
  // Index 0 is black (a pixel without an orientation); 1..255 run through the hues (Java's Color.HSBtoRGB, s = b = 1).
  const WHEEL_LUT = 'Directionality';
  function wheelTable() {
    const t = new Uint8Array(768);
    for (let i = 1; i < 256; i++) {
      const h = (i - 1) / 255 * 6, k = Math.floor(h), f = h - k, q = 1 - f;
      const c = [[1, f, 0], [q, 1, 0], [0, 1, f], [0, q, 1], [f, 0, 1], [1, 0, q]][k % 6];
      t[i * 3] = Math.round(c[0] * 255); t[i * 3 + 1] = Math.round(c[1] * 255); t[i * 3 + 2] = Math.round(c[2] * 255);
    }
    return t;
  }
  // The 32-bit orientation values run start .. start+180; the display range leaves index 0 for "no orientation".
  const wheelDisplay = (start) => ({ min: start - 180 / 255, max: start + 180, lut: WHEEL_LUT, invert: false });
  const noOrientation = (start) => start - 180 / 255 - 1;

  // ---- Directionality outputs ------------------------------------------------------------------------------
  function plotOf(api, res, name, methodLabel) {
    const n = res.nbins, fit = res.fit;
    const fx = [], fy = [];
    const steps = Math.max(200, 4 * n);
    for (let i = 0; i <= steps; i++) {
      const xd = res.start + 180 * i / steps, xr = xd * Math.PI / 180;
      fx.push(xd); fy.push(fit.a + fit.b * Math.exp(-((xr - fit.c) * (xr - fit.c)) / (2 * fit.d * fit.d)));
    }
    const f = (v, d) => (Number.isFinite(v) ? v.toFixed(d) : '');
    return {
      title: api.tr('res.fftDirPlot', { name, method: methodLabel }), xLabel: 'Direction (°)', yLabel: 'Amount',
      series: [
        { kind: 'bars', x: res.bins, y: res.histogram, label: api.tr('res.fftHistogram') },
        { kind: 'line', x: fx, y: fy, label: api.tr('res.fftFit') }
      ],
      xRange: [res.start - 2, res.start + 182],
      csv: { columns: ['Direction (°)', 'Histogram', 'Fit'], rows: res.bins.map((b, i) => [b, res.histogram[i], fit.a + fit.b * Math.exp(-(((b * Math.PI / 180) - fit.c) ** 2) / (2 * fit.d * fit.d))]) },
      text: `Direction (°): ${f(res.direction, 2)}\nDispersion (°): ${f(res.dispersion, 2)}\nAmount: ${f(res.amount, 4)}\nGoodness: ${f(res.goodness, 4)}`
        + (res.piecesAll > res.pieces ? '\n' + api.tr('res.fftPieces', { n: res.pieces, total: res.piecesAll }) : '')
    };
  }

  // The colour wheel: the orientation of each pixel of a disc, counter-clockwise on screen, as the histogram labels it.
  function wheelImage(api, start) {
    const n = 128, c = (n - 1) / 2, R = n / 2 - 1, d = new Float32Array(n * n), below = noOrientation(start);
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const dx = x - c, dy = y - c;
        if (dx * dx + dy * dy > R * R) { d[y * n + x] = below; continue; }
        const a = Math.atan2(-dy, dx) * 180 / Math.PI;
        let t = (a - start) % 180; if (t < 0) t += 180;
        d[y * n + x] = start + t;
      }
    }
    return { name: api.tr('res.fftWheelName'), width: n, height: n, bitDepth: 32, calibration: { pixelWidth: 1, pixelHeight: 1, unit: 'pixel' }, channels: [{ name: 'Orientation', color: '#ffffff', data: d, display: wheelDisplay(start) }] };
  }

  async function runDirectionality(api) {
    const st = api.state();
    if (!st.doc) return;
    const v = await api.dialog({
      title: api.tr('dlg.fft.dirTitle'), okLabel: api.tr('dlg.ok'),
      fields: [
        { type: 'choice', id: 'method', labelKey: 'dlg.fft.method', value: 'fourier', options: [
          { value: 'fourier', labelKey: 'dlg.fft.methodFourier' }, { value: 'gradient', labelKey: 'dlg.fft.methodGradient' }] },
        { type: 'number', id: 'nbins', labelKey: 'dlg.fft.nbins', value: 90, min: 5, max: 720, step: 1, integer: true },
        { type: 'number', id: 'start', labelKey: 'dlg.fft.start', value: -90, min: -180, max: 180, step: 1, decimals: 0, units: '°' },
        // the histogram spans 180 degrees: its end follows its start
        { type: 'number', id: 'end', labelKey: 'dlg.fft.end', value: 90, decimals: 0, units: '°', enabledIf: () => false },
        { type: 'check', id: 'orientationMap', labelKey: 'dlg.fft.orientationMap', value: false, enabledIf: (x) => x.method === 'gradient' },
        { type: 'check', id: 'colorWheel', labelKey: 'dlg.fft.colorWheel', value: false },
        { type: 'check', id: 'table', labelKey: 'dlg.fft.table', value: false },
        { type: 'message', id: 'mapNote', labelKey: 'dlg.fft.mapNote', visibleIf: (x) => x.method !== 'gradient' }
      ].concat(allField(st)),
      onChange(x, set, changed) { if (changed === 'start' && Number.isFinite(x.start)) set({ end: x.start + 180 }); },
      validate(x) {
        if (!Number.isInteger(x.nbins) || x.nbins < 5 || x.nbins > 720) return { nbins: 'dlg.fft.nbinsInvalid' };
        if (!(x.start >= -180 && x.start <= 180)) return { start: 'dlg.fft.startInvalid' };
        return null;
      }
    });
    if (!v) return;
    const now = api.state();
    if (!now.doc || now.doc.docId !== st.doc.docId) return;
    const info = st.doc;
    const channels = v.all ? info.channels.map((c, i) => i) : [st.activeChannel];
    const methodKey = v.method === 'gradient' ? 'dlg.fft.methodGradient' : 'dlg.fft.methodFourier';
    const methodLabel = api.tr(methodKey);
    const wantMap = v.method === 'gradient' && !!v.orientationMap;
    const params = { method: v.method, nbins: v.nbins, start: v.start };
    const rows = [], hists = [];
    // the orientation map is built by the worker (the page never holds an image-sized array); its table must exist first
    if (wantMap) await api.registerLut(WHEEL_LUT, wheelTable());
    for (const c of channels) {
      const chName = (info.channels[c] && info.channels[c].name) || ('C' + (c + 1));
      const name = channels.length > 1 ? info.name + ' - ' + chName : info.name;
      let res, mapInfo = null;
      if (wantMap) {
        const made = await api.call('doc.dirmap.create', { docId: info.docId, channel: c, roi: now.roi || null, nbins: v.nbins, start: v.start, name: api.tr('res.fftMapName', { name: name }) },
          { labelKey: 'op.directionality', long: true });
        if (!made) return;
        res = made.result; mapInfo = made.info;
      } else {
        res = await api.compute('directionality', params, { docId: info.docId, channel: c, labelKey: 'op.directionality' });
      }
      if (!res) return;
      rows.push([chName, res.direction, res.dispersion, res.amount, res.goodness]);
      hists.push({ chName, res });
      api.openPlot(plotOf(api, res, name, methodLabel));
      if (mapInfo) await api.adopt(mapInfo, { placement: 'splitRight' });
    }
    // Fiji lists the fit of every slice in a results table (ImageJ's column names stay English)
    api.openTable(api.tr('res.fftDirResults', { name: info.name }), ['Slice', 'Direction (°)', 'Dispersion (°)', 'Amount', 'Goodness'], rows);
    if (v.table) {
      const cols = ['Direction (°)'].concat(hists.map((h) => h.chName));
      const first = hists[0].res;
      api.openTable(api.tr('res.fftDirHistograms', { name: info.name, method: methodLabel }), cols, first.bins.map((b, i) => [b].concat(hists.map((h) => h.res.histogram[i]))));
    }
    if (v.colorWheel) {
      await api.registerLut(WHEEL_LUT, wheelTable());
      await api.addDoc(wheelImage(api, v.start), { placement: 'tab' });
    }
  }

  // ---- the commands ------------------------------------------------------------------------------------------
  const commands = [
    {
      id: 'fftForward', menu: ['Process', 'FFT'], order: 10, long: true, enabled: idle,
      async run(api) {
        const st = api.state();
        if (!st.doc) return;
        const o = fftOptions(api);
        // FFT.java:275-276: with no other spectrum asked for, the FFT window is always made
        const params = { fftWindow: o.fftWindow || !o.rawPs, rawPs: o.rawPs, sourceRev: st.doc.rev };
        await api.run('fft', params, { docId: st.doc.docId, channel: st.activeChannel, labelKey: 'op.fft', placement: 'splitRight' });
      }
    },
    {
      id: 'fftInverse', menu: ['Process', 'FFT'], order: 20, long: true, enabled: idle,
      async run(api) {
        const st = api.state();
        const info = st.doc;
        if (!info) return;
        const meta = info.provenance && info.provenance.fft;
        // FFT.run: "if (fht==null && arg.equals("inverse")) IJ.error("FFT", "Frequency domain image required")"
        if (!meta || meta.kind !== 'fft') throw err('IJ_FFT_NOT_FD');
        const source = (st.docs || []).find((d) => d.docId === meta.sourceDocId);
        if (!source) throw err('IJ_FFT_SOURCE_CHANGED');
        const res = await api.run('inverseFft', {}, { docId: info.docId, docIds: [info.docId, source.docId], noRoi: true, labelKey: 'op.inverseFft', placement: 'splitRight' });
        if (!res || !res.newDocIds || !res.newDocIds.length) return;
        // FFT.doMasking: "No pixels have been set to 0 (black) or 255 (white) so filtering will not be done." (an 8-bit spectrum
        // whose mean is no longer the one FFT stored)
        const made = (api.state().docs || []).find((d) => d.docId === res.newDocIds[0]);
        if (made && made.provenance && made.provenance.fftInverse && made.provenance.fftInverse.notice) {
          await api.dialog({ title: api.tr('dlg.fft.noMaskTitle'), okLabel: api.tr('dlg.ok'), fields: [{ type: 'message', id: 'note', labelKey: 'dlg.fft.noMask' }] });
        }
      }
    },
    {
      id: 'fftOptions', menu: ['Process', 'FFT'], order: 40, enabled: (st) => !st.busy,
      async run(api) {
        const o = fftOptions(api);
        const v = await api.dialog({
          title: api.tr('dlg.fft.optionsTitle'), okLabel: api.tr('dlg.ok'),
          fields: [
            { type: 'message', id: 'display', labelKey: 'dlg.fft.display' },
            { type: 'check', id: 'fftWindow', labelKey: 'dlg.fft.fftWindow', value: o.fftWindow },
            { type: 'check', id: 'rawPs', labelKey: 'dlg.fft.rawPs', value: o.rawPs }
          ]
        });
        if (!v) return;
        api.settings.set('fft.fftWindow', !!v.fftWindow);
        api.settings.set('fft.rawPs', !!v.rawPs);
      }
    },
    {
      id: 'fftBandpass', menu: ['Process', 'FFT'], order: 50, separatorBefore: true, long: true, enabled: idle,
      async run(api) {
        const st = api.state();
        if (!st.doc) return;
        const v = await api.dialog({
          title: api.tr('dlg.fft.bandTitle'), okLabel: api.tr('dlg.ok'),
          fields: [
            { type: 'number', id: 'large', labelKey: 'dlg.fft.large', value: BAND.large, min: 0, max: 100000, step: 1, decimals: 0, unitsKey: 'dlg.pixels' },
            { type: 'number', id: 'small', labelKey: 'dlg.fft.small', value: BAND.small, min: 0, max: 100000, step: 1, decimals: 0, unitsKey: 'dlg.pixels' },
            { type: 'choice', id: 'stripes', labelKey: 'dlg.fft.stripes', value: BAND.stripes, options: STRIPE_OPTIONS },
            { type: 'number', id: 'tolerance', labelKey: 'dlg.fft.tolerance', value: BAND.tolerance, min: 0, max: 100, step: 1, decimals: 0, units: '%' },
            { type: 'check', id: 'autoscale', labelKey: 'dlg.fft.autoscale', value: BAND.autoscale },
            { type: 'check', id: 'saturate', labelKey: 'dlg.fft.saturate', value: BAND.saturate },
            { type: 'check', id: 'displayFilter', labelKey: 'dlg.fft.displayFilter', value: BAND.displayFilter }
          ].concat(allField(st, BAND.all))
        });
        if (!v) return;
        const now = api.state();
        if (!now.doc || now.doc.docId !== st.doc.docId) return;
        Object.assign(BAND, { large: v.large, small: v.small, stripes: v.stripes, tolerance: v.tolerance, autoscale: !!v.autoscale, saturate: !!v.saturate, displayFilter: !!v.displayFilter });
        if (nChan(st) > 1) BAND.all = !!v.all;
        const params = { large: v.large, small: v.small, stripes: STRIPE_INDEX[v.stripes] || 0, tolerance: v.tolerance, autoscale: !!v.autoscale, saturate: !!v.saturate };
        const res = await api.run('bandpass', params, { docId: st.doc.docId, channel: v.all ? 'all' : st.activeChannel, labelKey: 'op.bandpass' });
        // FFTFilter.filterLargeSmall: "if (displayFilter && slice==1)" the filter of the first image is shown
        if (res && v.displayFilter) await api.run('bandpassFilter', params, { docId: st.doc.docId, channel: st.activeChannel, labelKey: 'op.bandpassFilter', placement: 'splitRight' });
      }
    },
    {
      id: 'fftSwapQuadrants', menu: ['Process', 'FFT'], order: 80, enabled: idle,
      async run(api) {
        const st = api.state();
        if (!st.doc) return;
        // FFT.run("swap"): "if (imp.getWidth()==imp.getHeight()) swapQuadrants(imp.getStack()) else IJ.error(…"Image must be square")":
        // every image of the stack (here: every channel), the selection is not used
        await api.run('swapQuadrants', {}, { docId: st.doc.docId, channel: 'all', noRoi: true, labelKey: 'op.swapQuadrants' });
      }
    },
    {
      id: 'analyzeDirectionality', menu: ['Analyze'], order: 130, long: true, enabled: idle,
      run: runDirectionality
    }
  ];

  IJApp.extend({
    pkg: 'fft',
    commands,
    longCommands: ['doc.dirmap.create'],
    errors: {
      IJ_FFT_TOO_LARGE: 'err.fftTooLarge',
      IJ_FFT_NO_OUTPUT: 'err.fftNoOutput',
      IJ_FFT_SOURCE_CHANGED: 'err.fftSourceChanged',
      IJ_FFT_NOT_FD: 'err.fftNotFd',
      IJ_FFT_NOT_SQUARE: 'err.fftNotSquare',
      IJ_DIR_TOO_SMALL: 'err.dirTooSmall',
      IJ_DIR_NO_SIGNAL: 'err.dirNoSignal'
    }
  });
})();
