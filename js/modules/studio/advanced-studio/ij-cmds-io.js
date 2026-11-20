/* ij-cmds-io.js — menu commands of package P-io (io), PLAN-wave3 §1.2 / §1.5 / §5. Runs on the page only, before IJApp.mount; talks
 * to the app through the documented extension API (IJApp.EXT_API_MEMBERS) and to the worker through the registry operations of
 * ij-proc-io.js (xyCoordinates, textImage); the codecs (IJRoiCodec, IJTextIo) are page-pure.
 *
 *   File › Import › Text Image…           ij.plugin.TextReader          a tab / comma / space separated text becomes a 32-bit image
 *   File › Save As › Text Image…          ij.io.TextEncoder             the active channel as tab-separated text, 3 decimals for a 32-bit image
 *   File › Save As › Selection…           ij.plugin.filter.RoiWriter    the selection as an ImageJ .roi file
 *   File › Save As › XY Coordinates…      ij.plugin.filter.XYWriter     the vertices of the selection, no dialog
 *   Analyze › Tools › Save XY Coordinates…  ij.plugin.XYCoordinates     every non-background pixel (or the pixels of an area selection)
 *
 * File › Open (the dispatcher: TIFF, PNG / JPEG / GIF / BMP, text image, .roi, RoiSet .zip, .lut) and the ROI Manager window are
 * part of ij-app.js (openTiff, buildRoiManager). The choice a user makes in a file picker comes back as the file's bytes only: the
 * name typed in a save picker is not known to the page, so ImageJ's "the selection takes the name it was saved under" is not done.
 */
(function () {
  'use strict';
  if (typeof IJApp === 'undefined' || typeof IJApp.extend !== 'function') return;

  const idle = (st) => !!(st && st.doc) && !st.busy;
  const hasRoi = (st) => idle(st) && !!st.roi;
  const baseName = (name) => String(name || 'Untitled').replace(/\.[A-Za-z0-9]{1,5}$/, '') || 'Untitled';
  // the file name a save picker proposes: no path separators, no characters a file system refuses
  const fileName = (name, ext) => baseName(name).replace(/[\\/:*?"<>|]+/g, '_') + ext;
  const toBlob = (pages, type) => new Blob(pages, { type });
  const AREA = new Set(['rect', 'oval', 'polygon', 'freehand', 'mask']);
  // Analyzer.getPrecision(): "Decimal places" of Set Measurements, negated when Scientific notation is ticked
  const analyzerDecimals = (api) => { const d = Number(api.settings.get('ana.decimals')); return Number.isInteger(d) ? Math.max(0, Math.min(9, d)) : 3; };
  const analyzerPrecision = (api, st) => (st && Array.isArray(st.measurements) && st.measurements.includes('scientific') ? -1 : 1) * analyzerDecimals(api);
  // XYCoordinates keeps "invertY" in a static field: it survives from one run to the next
  let lastInvertY = false;

  const commands = [
    {
      // TextReader.run: "Open Text Image..." — always a 32-bit image
      id: 'fileImportTextImage', menu: ['File', 'Import'], order: 20,
      enabled: (st) => !!st && !st.busy,
      async run(api) {
        const files = await api.pickFile({ accept: '.txt,.csv,.tsv,.text,text/plain', multiple: false });
        if (!files || !files.length) return;
        const f = files[0];
        const bytes = new Uint8Array(await f.arrayBuffer());
        const t = await IJTextIo.parseTextImageAsync(bytes);       // tokenized in slices: the page stays responsive
        const r = IJTextIo.floatRange(t.data);
        await api.addDoc({
          name: baseName(f.name), width: t.width, height: t.height, bitDepth: 32, calibration: { pixelWidth: 1, pixelHeight: 1, unit: 'px' },
          channels: [{ data: t.data, name: 'C1', color: '#ffffff', display: { min: r.min, max: r.max, lut: 'Grays', invert: false } }]
        }, { placement: 'tab' });
      }
    },
    {
      // FileSaver.saveAsText (FileSaver.java:577-595): the picker proposes <title>.csv, a ".csv" path is written comma separated, and
      // the number of decimals is Analyzer.getPrecision() (negative = scientific). PLAN §5's "tab-separated" is the TextEncoder default
      // only; the 1.54p save command proposes .csv.
      id: 'fileSaveTextImage', menu: ['File', 'SaveAs'], order: 15, long: true,
      enabled: (st) => idle(st),
      async run(api) {
        const st = api.state();
        const info = st.doc;
        if (!info) return;
        const channel = st.activeChannel;
        const precision = analyzerPrecision(api, st);
        await api.saveFile(fileName(info.name, '.csv'), 'text/csv', '.csv', 'dlg.io.textFile', async () => {
          const res = await api.compute('textImage', { precision, delimiter: ',' }, { docId: info.docId, channel, roi: null, labelKey: 'op.textImage' });
          if (!res) throw Object.assign(new Error('cancelled'), { code: 'IJ_CANCELLED' });
          return toBlob(res.pages, 'text/csv');
        });
      }
    },
    {
      // RoiWriter.saveRoi: DOES_ALL+ROI_REQUIRED
      id: 'fileSaveSelection', menu: ['File', 'SaveAs'], order: 24,
      enabled: (st) => hasRoi(st),
      async run(api) {
        const st = api.state();
        const roi = st.roi;
        if (!roi || !st.doc) return;
        const name = roi.name || st.doc.name;
        await api.saveFile(fileName(name, '.roi'), 'application/octet-stream', '.roi', 'dlg.io.roiFile', async () => toBlob([IJRoiCodec.encode(roi, { name: roi.name })], 'application/octet-stream'));
      }
    },
    {
      // XYWriter.saveXYCoordinates: DOES_ALL+ROI_REQUIRED+NO_CHANGES, no dialog
      id: 'fileSaveXY', menu: ['File', 'SaveAs'], order: 26,
      enabled: (st) => hasRoi(st),
      async run(api) {
        const st = api.state();
        const roi = st.roi;
        if (!roi || !st.doc) return;
        const text = IJTextIo.xyWriterText(roi, st.doc.calibration);
        await api.saveFile(fileName(st.doc.name, '.txt'), 'text/plain', '.txt', 'dlg.io.xyFile', async () => toBlob([text], 'text/plain'));
      }
    },
    {
      // XYCoordinates.run: an area selection skips the dialog and saves its pixels; else every non-background pixel
      id: 'toolsSaveXY', menu: ['Analyze', 'Tools'], order: 10, long: true,
      enabled: (st) => idle(st),
      async run(api) {
        const st = api.state();
        const info = st.doc;
        if (!info) return;
        const channel = st.activeChannel;
        const roi = st.roi && AREA.has(st.roi.type) ? st.roi : null;
        if (roi) {
          await api.saveFile(fileName(info.name, '.csv'), 'text/csv', '.csv', 'dlg.io.csvFile', async () => {
            // the selection table's precision: ResultsTable.d2s with max(3, Analyzer precision) (ResultsTable.java:88-91)
            const res = await api.compute('xyCoordinates', { mode: 'selection', precision: Math.max(3, analyzerDecimals(api)) }, { docId: info.docId, channel, roi, labelKey: 'op.xyCoordinates' });
            if (!res) throw Object.assign(new Error('cancelled'), { code: 'IJ_CANCELLED' });
            return toBlob(res.pages, 'text/csv');
          });
          return;
        }
        // XYCoordinates.run: "imp.deleteRoi()" — a line or point selection is removed before the dialog
        if (st.roi) api.setRoi(null, { docId: info.docId });
        // the dialog proposes the value of the pixel in the upper left corner
        const probe = await api.compute('xyCoordinates', { mode: 'probe' }, { docId: info.docId, channel, roi: null, labelKey: 'op.xyCoordinates' });
        if (!probe) return;
        const bg = probe.background;
        // addNumericField("Background value:", background, digits): the default is shown with `digits` decimals and, when the text is
        // left alone, GenericDialog.getNextNumber returns the EXACT default (GenericDialog.java:1199-1204) — a float 0.12345678 or
        // a NaN corner is not turned into 0. A number field cannot hold NaN, so only that case is a text field.
        const digits = Number.isInteger(bg) ? 0 : 4;
        const proposed = bg !== bg ? 'NaN' : IJJava.d2s(bg, digits);
        const v = await api.dialog({
          title: api.tr('dlg.io.xyTitle'), okLabel: api.tr('dlg.ok'),
          fields: [
            { type: 'message', id: 'note', labelKey: 'dlg.io.xyNote' },
            bg === bg
              ? { type: 'number', id: 'background', labelKey: 'dlg.io.background', value: bg, step: 1, decimals: digits }
              : { type: 'string', id: 'background', labelKey: 'dlg.io.background', value: proposed },
            { type: 'check', id: 'invertY', labelKey: 'dlg.io.invertY', value: lastInvertY }
          ]
        });
        if (!v) return;
        lastInvertY = !!v.invertY;
        // unchanged text = the exact pixel value (null: the engine reads pixel (0, 0) itself); typed text = Double.parseDouble
        // the unchanged text parses back to Number(proposed) (4 decimals of the pixel): that is "left alone"; anything else is the user's number
        const typed = typeof v.background === 'number' ? v.background : IJJava.parseDouble(String(v.background === undefined ? '' : v.background).trim());
        const unchanged = typeof v.background === 'number' ? typed === Number(proposed) : String(v.background).trim() === proposed;
        const background = unchanged ? null : typed;
        const params = { mode: 'points', background, invertY: lastInvertY };
        await api.saveFile(fileName(info.name, '.txt'), 'text/plain', '.txt', 'dlg.io.xyFile', async () => {
          const res = await api.compute('xyCoordinates', params, { docId: info.docId, channel, roi: null, labelKey: 'op.xyCoordinates' });
          if (!res) throw Object.assign(new Error('cancelled'), { code: 'IJ_CANCELLED' });
          return toBlob(res.pages, 'text/plain');
        });
      }
    }
  ];

  IJApp.extend({
    pkg: 'io',
    commands,
    errors: {
      IJ_IO_UNKNOWN_FORMAT: 'err.ioUnknownFormat',
      IJ_IO_BAD_ROI: 'err.ioBadRoi',
      IJ_IO_ZIP_BAD: 'err.ioZipBad',
      IJ_IO_ZIP_NO_ROI: 'err.ioZipNoRoi',
      IJ_IO_ZIP_DEFLATE: 'err.ioZipDeflate',
      IJ_IO_TEXT_RAGGED: 'err.ioTextRagged',
      IJ_IO_TEXT_EMPTY: 'err.ioTextEmpty',
      IJ_IO_TOO_LARGE: 'err.ioTooLarge',
      IJ_IO_NEEDS_IMAGE: 'err.ioNeedsImage',
      IJ_IO_NEEDS_COMPOSITE: 'err.ioNeedsComposite',
      IJ_IO_DECODE: 'err.ioDecode'
    }
  });
})();
