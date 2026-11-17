/* Advanced Studio — ij-app.js
 *
 * IJApp: the controller of the Advanced view. It owns the worker (every pixel
 * computation lives there, see ij-engine.js), the documents it hands back, the
 * command registry (every menu entry, in ImageJ's menu order), the tool windows
 * and the loading of the figure into a lossless image.
 *
 * The chrome (menu bar, tool bar, image window, status bar, floating windows, dialogs, pointer
 * handling, keyboard shortcuts) is ij-view.js (IJShell / IJDisplay / IJWindows); its class
 * vocabulary is listed in the header of that file and styled by ij-style.css. This file builds
 * only the content of the tool windows, with these classes (all prefixed ij-):
 *   .ij-app (full-size container of the shell)   .ij-panel (a tool window's content)
 *   .ij-row (a row of controls)   .ij-hist / .ij-plot (canvases)   .ij-lutstrip
 *   .ij-slider   .ij-readout   .ij-table-wrap / .ij-table   .ij-list / .ij-list-item(.is-selected)
 *   .ij-info-pre   .ij-banner   .ij-empty   .ij-check   .ij-rename
 *
 * ── CONTRACT WITH ij-view.js ─────────────────────────────────────────────────────────
 *   IJShell.create(appEl, { commands, getState, tools, t, onCommand(cmd, {source}), onTool,
 *     onToolOptions, onRoi(roi, {final}), onChannel, onCancel, readPixel(x, y) → Promise<number[]>,
 *     isActive, display:{ onTileError } })
 *   shell.display (IJDisplay: setTileProvider, invalidate, setPreview, setThresholdOverlay, zoomAt,
 *   fit, view100, zoomToRect, getView, renderToCanvas), shell.stage, shell.windows (dialog,
 *   floating, confirm), setImage, clearImage, setDisplayState, setActiveRoi, setRois, setStatus,
 *   setProgress({fraction, label, cancellable}), setWarning, setLineWidth, setTool, refreshMenus.
 *   The shell owns the keyboard: it matches each command's `shortcut` (a string or an array of
 *   them) and calls onCommand; this file only declares them.
 */

/* ── EXTENSION API (PLAN-wave2 §2.5) ──────────────────────────────────────────────────────────────
 * The processing packages (ij-cmds-<pkg>.js, loaded after this file and BEFORE the first mount)
 * add their menu commands with
 *
 *   IJApp.extend({ pkg, commands: [...], errors: { IJ_CODE: 'err.key' }, columns: [[key, header, afterKey]] })
 *       throws IJ_BAD_ARGS for a malformed registration (nothing is half-registered) and IJ_EXTEND_AFTER_MOUNT
 *       once the view was mounted. `measurements` (P6 only) is reserved and not read by W0.
 *   pkg         one of IJApp.PACKAGE_NAMES (the ij-proc-<pkg>.js of WORKER_SCRIPTS: bg filters seg multi geom roi
 *               coloc), once. The page disables the package's commands when its worker file failed to load.
 *
 *   command = { id, menu: ['Process', 'Filters'], order, labelKey?, shortcut?, keys?, separatorBefore?,
 *               long?, enabled?(st), run(api) }
 *     id          letters and digits only; the label is the plugin lang key `cmd.<id>` (labelKey overrides)
 *     order       position × 10 inside its (sub)menu, from the frozen table of PLAN-wave2 §1
 *     long        true = the command shows progress (informational: the busy state is entered by api.run /
 *                 api.compute themselves; Cancel reaches the worker commands of LONG_COMMANDS)
 *     enabled(st) st = { doc, docs, roi, prevRoi, busy, nDocs, canUndo, canRedo, dirty, hasResults,
 *                 canProject, threshold, activeChannel } — default: an image is open and nothing runs;
 *                 a package that failed to load disables its commands whatever enabled() says
 *     run(api)    api = the object below (every member listed in IJApp.EXT_API_MEMBERS); a command makes
 *                 its calls in any number, but only through `api`. A throw / rejection is reported to the
 *                 operator by the app (err.<name> sentence, never err.message).
 *   errors      extra error codes → plugin lang keys (`err.<name>`); a code another package mapped differently throws
 *   columns     [key, header, afterKey]: a Results column; rows given to api.addResults carry `key`; the
 *               header is what the table and the CSV show; it sits after the column `afterKey` (else at
 *               the end); keys nobody declared are appended in first-seen order
 *
 * api (frozen). Every call that needs an image takes it from `docId` (default: the active one):
 *   tr(key, params) → string                         the plugin's translation ({token} interpolation)
 *   state() → { doc, docs, roi, busy, activeChannel, threshold, measurements, lineWidth, roiList, resultsCount }
 *        doc = info of the active image | null; docs = [info] in opening order; roi = the active image's selection |
 *        null; threshold = { docId, channel, lower, upper, dark } | null — what the Threshold WINDOW holds: it is null
 *        until that window has been opened (`await api.openTool('threshold')` opens it and waits for its first
 *        automatic range); measurements = [group] ticked in Set Measurements; roiList = [{ name, docId, roi }]
 *   dialog(spec) → Promise<values | null>            spec: see IJWindows.dialog (ij-view.js) — field types
 *        number slider check choice radio string textarea doc channel message; enabledIf / visibleIf;
 *        validate(values) → { id: errKey } | null; onChange(values, set, changedId); preview:
 *        { op, params(values), channel?, roi? } (a pixel op, drawn over the image) or
 *        { compute, params(values), overlay(result, values) → items } (a compute op, drawn as overlay).
 *        A `doc` field lists the open images (filter(info) narrows them), a `channel` field the channels of
 *        the image a sibling `doc` field (docField) chose, else of the current one. `values` hold ONLY the fields
 *        that are valid and shown (an invalid or hidden field is absent, never NaN); validate / onChange run only
 *        while every field is valid. A `doc` field with no image to pick cannot be committed. null = cancelled.
 *   run(op, params, { docId, channel, roi, noRoi, docIds, labelKey, noUndo }) → Promise<{ newDocIds, changed } | null>
 *        runs a registry operation (pixel / size / newdoc) on docId, channel (a number or 'all'; default: the
 *        active one), roi (default: its selection); new images are adopted and shown by the call itself.
 *        null = NOTHING RAN: no image, another step is running, the operator declined, the step failed or was
 *        cancelled (a failure is reported to the operator by the call itself — do not report it again).
 *        A step that fits the memory only without its undo record asks the operator first.
 *   compute(op, params, { docId, docIds, channel, roi, preview, region, labelKey }) → Promise<result | null>
 *        a read-only operation; null = nothing ran (same cases as run, reported when it failed). preview:true does
 *        not enter the busy state, cancels the previous preview compute, and REJECTS with the engine error
 *        (IJ_CANCELLED when superseded) — the caller catches it.
 *   estimate(op, params, { docId, docIds, channel, roi }) → Promise<{ needBytes, fits, fitsWithoutUndo, usedBytes, budgetBytes }>
 *   preview(op, params, { docId, channel, roi }) → Promise<{ ok, tooLarge? }>   cancelPreview()
 *   overlay(items) / clearOverlay()                  items: IJDisplay.setOverlay (points, polyline, grid, rect)
 *   setRoi(roi, { docId })                           set (null clears) the selection of an image
 *   addResults(rows, { show })                       rows = [{ key: value }] appended to Results (shown unless show:false)
 *   openTable(name, columns, rows)                   a table window; columns = [header], rows = [[value]] | [{ header: value }]
 *                                                    NOT kept across a reload (the About box says so); Results are
 *   openPlot(spec)                                   a plot window (see IJPlot, ij-view.js): series lines / bars /
 *                                                    points, an image layer, line overlays, PNG and CSV export
 *   openTool(id) → Promise<boolean>                  opens (or raises) a tool window: bc channels threshold results
 *                                                    roiManager summary; other ids reject. 'threshold' resolves once
 *                                                    its first automatic range is in state().threshold
 *   setDisplay(docId, channel, { min, max, lut, invert }) → Promise   the display of one channel (a LUT name, a range):
 *                                                    not an undo step, never touches pixels; rejects for a bad image /
 *                                                    channel / range
 *   toast(key, params)                               a line in the status bar
 *   error(err)                                       reports an error as the app does (never err.message)
 *   rename(docId, name) → Promise                    renames an image (not an undo step)
 *
 * Key namespaces a package may use (the registry test scans for them): cmd. op. menu. meas. tool. res.
 * err. dlg.<prefix>. (prefix: bg→bg filters→flt seg→seg multi→multi geom→geom roi→roi coloc→coloc), and any key
 * the base dictionary already has (dlg.ok, …). The test also reads string literals that look like keys
 * (validate() messages, unitsKey, option labels), so write them as plain literals.
 */
const IJApp = (() => {
  'use strict';

  // ───────────────────────────── constants ─────────────────────────────

  const LUT_NAMES = ['Grays', 'Red', 'Green', 'Blue', 'Cyan', 'Magenta', 'Yellow', 'Fire', 'Ice',
    'Spectrum', '16 Colors', 'HiLo'];
  const AREA_TYPES = new Set(['rect', 'oval', 'polygon', 'freehand', 'mask']);
  const MEASURE_KEY = 'lumen3d.ij.measurements';
  // owner: P6 (wave 2) — MEASURE_GROUPS, COLUMNS, PARTICLE_COLUMNS, resultColumnsOf, setMeasurements,
  // onToolOptions and the ROI Manager window are the measurement code; no other package edits this file.
  const MEASURE_GROUPS = {
    area: ['area'],
    mean: ['mean'],
    stdDev: ['stdDev'],
    mode: ['mode'],
    minMax: ['min', 'max'],
    centroid: ['xCentroid', 'yCentroid'],
    center: ['xCenterOfMass', 'yCenterOfMass'],
    perimeter: ['perim'],
    rect: ['bx', 'by', 'bw', 'bh'],
    ellipse: ['major', 'minor', 'angle'],
    shape: ['circularity', 'aspectRatio', 'roundness', 'solidity'],
    feret: ['feret', 'feretX', 'feretY', 'feretAngle', 'minFeret'],
    intDen: ['intDen', 'rawIntDen'],
    median: ['median'],
    skewness: ['skewness'],
    kurtosis: ['kurtosis'],
    areaFraction: ['areaFraction'],
    limit: ['minThreshold', 'maxThreshold'],
    labels: []
  };
  const MEASURE_DEFAULT = ['area', 'mean', 'minMax'];
  // Result column of each statistics key, in ImageJ's column order (ResultsTable: Area Mean StdDev Mode Min Max X Y XM YM
  // Perim. BX BY Width Height Major Minor Angle Circ. Feret IntDen Median Skew Kurt %Area RawIntDen … FeretX FeretY
  // FeretAngle MinFeret AR Round Solidity MinThr MaxThr; Length is a column of the line measurements).
  const COLUMNS = [
    ['area', 'Area'], ['mean', 'Mean'], ['stdDev', 'StdDev'], ['mode', 'Mode'], ['min', 'Min'],
    ['max', 'Max'], ['xCentroid', 'X'], ['yCentroid', 'Y'], ['xCenterOfMass', 'XM'],
    ['yCenterOfMass', 'YM'], ['perim', 'Perim.'], ['bx', 'BX'], ['by', 'BY'], ['bw', 'Width'], ['bh', 'Height'],
    ['major', 'Major'], ['minor', 'Minor'], ['angle', 'Angle'], ['circularity', 'Circ.'], ['feret', 'Feret'],
    ['intDen', 'IntDen'], ['median', 'Median'], ['skewness', 'Skew'], ['kurtosis', 'Kurt'], ['areaFraction', '%Area'],
    ['rawIntDen', 'RawIntDen'], ['feretX', 'FeretX'], ['feretY', 'FeretY'], ['feretAngle', 'FeretAngle'], ['minFeret', 'MinFeret'],
    ['aspectRatio', 'AR'], ['roundness', 'Round'], ['solidity', 'Solidity'], ['minThreshold', 'MinThr'], ['maxThreshold', 'MaxThr'],
    ['length', 'Length']
  ];
  const PARTICLE_COLUMNS = [
    ['area', 'Area'], ['perimeter', 'Perim.'], ['circularity', 'Circ.'], ['bx', 'BX'], ['by', 'BY'],
    ['bw', 'Width'], ['bh', 'Height'], ['xCentroid', 'X'], ['yCentroid', 'Y']
  ];
  // A particle row also carries the image measurements Set Measurements asks for (ImageJ
  // measures every particle's mask): these follow the particle's own columns, in COLUMNS order.
  const PARTICLE_MEASURE_KEYS = ['mean', 'stdDev', 'mode', 'min', 'max', 'xCenterOfMass', 'yCenterOfMass',
    'intDen', 'rawIntDen', 'median', 'skewness', 'kurtosis', 'major', 'minor', 'angle', 'aspectRatio', 'roundness', 'solidity',
    'feret', 'feretX', 'feretY', 'feretAngle', 'minFeret', 'areaFraction', 'minThreshold', 'maxThreshold'];
  const SUMMARY_COLUMNS = ['Image', 'Count', 'Total Area', 'Average Size', '%Area'];
  // IJ_* codes (engine, pure modules) and loader codes → plugin lang keys.
  const ERROR_KEYS = {
    IJ_OVER_BUDGET: 'err.overBudget',
    IJ_NOT_32BIT: 'err.not32bit',
    IJ_BAD_ROI: 'err.badRoi',
    IJ_TOO_LARGE: 'err.tooLarge',
    IJ_TIFF_UNSUPPORTED: 'err.tiffUnsupported',
    IJ_INCOMPLETE: 'err.incomplete',
    IJ_WORKER_CRASHED: 'err.workerCrashed',
    IJ_NOTHING_TO_UNDO: 'err.noUndo',
    IJ_NOT_BINARY: 'err.not8bit',
    IJ_MODULE_MISSING: 'err.moduleMissing',
    IJ_STORAGE_QUOTA: 'err.storageFull',
    IJ_STORAGE_FAILED: 'err.storageFailed',
    IJ_EMPTY_ROI: 'err.emptyRoi',
    IJ_NEEDS_ROI: 'err.needsRoi',
    IJ_BAD_ARGS: 'err.badArgs',
    IJ_BAD_TYPE: 'err.badType',
    IJ_UNKNOWN_OP: 'err.unknownOp',
    IJ_ROI_TOO_COMPLEX: 'err.roiTooComplex',
    IJ_SIZE_MISMATCH: 'err.sizeMismatch',
    STUDIO_NOT_SUPPORTED: 'err.notSupported',
    NO_LEVEL: 'err.noLevel',
    STUDIO_FRAME_LOST: 'err.frameLost',
    NO_DATASET: 'err.noDataset',
    PLUGIN_SCRIPT_FAILED: 'err.scriptFailed'
  };
  const TOOLS = [
    { id: 'rect', labelKey: 'tool.rect', icon: 'square' },
    { id: 'oval', labelKey: 'tool.oval', icon: 'circle' },
    { id: 'polygon', labelKey: 'tool.polygon', icon: 'pentagon' },
    { id: 'freehand', labelKey: 'tool.freehand', icon: 'pen-tool' },
    { id: 'line', labelKey: 'tool.line', icon: 'minus', hasOptions: true },
    { id: 'polyline', labelKey: 'tool.polyline', icon: 'activity' },
    { id: 'angle', labelKey: 'tool.angle', icon: 'triangle' },
    { id: 'point', labelKey: 'tool.point', icon: 'crosshair', hasOptions: true },
    { id: 'wand', labelKey: 'tool.wand', icon: 'wand', hasOptions: true },
    { separator: true },
    { id: 'zoom', labelKey: 'tool.zoom', icon: 'zoom-in' },
    { id: 'hand', labelKey: 'tool.hand', icon: 'hand' }
  ];
  // The worker protocol commands Cancel may target (a menu command's own `long` flag only says "shows progress").
  const LONG_COMMANDS = new Set(['doc.run', 'doc.project.add', 'doc.threshold', 'doc.particles',
    'doc.open', 'doc.duplicate', 'doc.exportTiff', 'doc.compute']);
  // The files the worker loads, in order: the first four are mandatory, every ij-proc-<pkg>.js other than
  // ij-proc-shared.js is a package loaded in its own try/catch (ij-worker.js).
  const WORKER_SCRIPTS = ['ij-core.js', 'ij-analysis.js', 'ij-proc-shared.js', 'ij-engine.js',
    'ij-proc-bg.js', 'ij-proc-filters.js', 'ij-proc-seg.js', 'ij-proc-multi.js', 'ij-proc-geom.js', 'ij-proc-roi.js', 'ij-proc-coloc.js'];
  const PACKAGE_FILE_RX = /^ij-proc-([a-z0-9]+)\.js$/;
  const PACKAGE_NAMES = WORKER_SCRIPTS.map((f) => PACKAGE_FILE_RX.exec(f)).filter((m) => m && m[1] !== 'shared').map((m) => m[1]);
  const ESTIMATE_MIN_FRACTION = 1 / 64; // an image under budget/64 never needs the estimate round trip
  const PERSIST_MS = 1200;
  const PREVIEW_COMPUTE_PIXELS = 4e6;  // a compute preview runs at level 0 on a visible region of at most this
  const WORKER_READY_MS = 20000;
  const GIB = 1024 * 1024 * 1024;

  // ───────────────────────────── command registry ─────────────────────────────
  // enabled(state): state = { doc (info|null), roi, prevRoi, busy, nDocs, canUndo, canRedo,
  // dirty, hasResults, canProject }.

  const has = (st) => !!st.doc && !st.busy;
  const hasArea = (st) => has(st) && isAreaRoi(st.roi);
  const is8 = (st) => has(st) && st.doc.bitDepth === 8;
  const always = () => true;
  function isAreaRoi(roi) { return !!roi && AREA_TYPES.has(roi.type); }

  function cmd(id, menu, extra) {
    return Object.assign({ id, menu, labelKey: 'cmd.' + id, shortcut: null, keys: [], enabled: has,
      run: () => {} }, extra || {});
  }
  const sc = (shortcut, keys) => ({ shortcut, keys: keys || [shortcut] });

  const COMMANDS = [
    // ── File
    cmd('fileOpen', ['File'], { enabled: (st) => !st.busy, run: (a) => a.openTiff() }),
    cmd('fileSaveTiff', ['File', 'SaveAs'], Object.assign(sc('Ctrl+S'), { run: (a) => a.saveTiff() })),
    cmd('fileSavePng', ['File', 'SaveAs'], { run: (a) => a.savePng() }),
    cmd('fileSaveResults', ['File', 'SaveAs'], { enabled: (st) => !st.busy && !!st.hasResults, run: (a) => a.saveResults() }),
    cmd('fileRevert', ['File'], { enabled: (st) => has(st) && !!st.dirty, run: (a) => a.revert() }),
    cmd('fileRecover', ['File'], { enabled: (st) => !st.busy, run: (a) => a.recover() }),
    cmd('fileClose', ['File'], { run: (a) => a.closeImage() }),
    cmd('fileSimple', ['File'], { enabled: always, run: (a) => a.simpleView() }),
    cmd('fileCloseStudio', ['File'], { enabled: always, run: (a) => a.closeStudio() }),

    // ── Edit
    cmd('editUndo', ['Edit'], Object.assign(sc('Ctrl+Z'), { enabled: (st) => has(st) && !!st.canUndo, run: (a) => a.undo() })),
    cmd('editRedo', ['Edit'], Object.assign(sc('Ctrl+Shift+Z', ['Ctrl+Shift+Z', 'Ctrl+Y']), { enabled: (st) => has(st) && !!st.canRedo, run: (a) => a.redo() })),
    cmd('editClear', ['Edit'], { enabled: hasArea, run: (a) => a.clearSel(false) }),
    cmd('editClearOutside', ['Edit'], { enabled: hasArea, run: (a) => a.clearSel(true) }),
    cmd('editFill', ['Edit'], { run: (a) => a.fillSel() }),
    cmd('editInvert', ['Edit'], Object.assign(sc('Shift+I'), { run: (a) => a.invert() })),
    cmd('editSelectAll', ['Edit', 'Selection'], Object.assign(sc('Ctrl+A'), { run: (a) => a.selectAll() })),
    cmd('editSelectNone', ['Edit', 'Selection'], Object.assign(sc('Shift+A'), { enabled: (st) => has(st) && !!st.roi, run: (a) => a.selectNone() })),
    cmd('editRestoreSelection', ['Edit', 'Selection'], Object.assign(sc('Shift+E'), { enabled: (st) => has(st) && !!st.prevRoi, run: (a) => a.restoreSelection() })),
    cmd('editMakeInverse', ['Edit', 'Selection'], { enabled: hasArea, run: (a) => a.makeInverse() }),
    cmd('editAddToManager', ['Edit', 'Selection'], Object.assign(sc('t'), { enabled: (st) => has(st) && !!st.roi, run: (a) => a.addToManager() })),

    // ── Image
    cmd('typeBit8', ['Image', 'Type'], { enabled: (st) => has(st) && st.doc.bitDepth !== 8, run: (a) => a.convertType(8) }),
    cmd('typeBit16', ['Image', 'Type'], { enabled: (st) => has(st) && st.doc.bitDepth !== 16, run: (a) => a.convertType(16) }),
    cmd('typeBit32', ['Image', 'Type'], { enabled: (st) => has(st) && st.doc.bitDepth !== 32, run: (a) => a.convertType(32) }),
    cmd('adjustBC', ['Image', 'Adjust'], Object.assign(sc('Shift+C'), { run: (a) => a.openTool('bc') })),
    cmd('adjustThreshold', ['Image', 'Adjust'], Object.assign(sc('Shift+T'), { run: (a) => a.openTool('threshold') })),
    cmd('imageInfo', ['Image'], { run: (a) => a.showInfo() }),
    cmd('colorChannels', ['Image', 'Color'], { run: (a) => a.openTool('channels') }),
    cmd('stackProject', ['Image', 'Stacks'], { enabled: (st) => !st.busy && !!st.canProject, run: (a) => a.zProject() }),
    cmd('imageCrop', ['Image'], Object.assign(sc('Shift+X'), { enabled: hasArea, run: (a) => a.crop() })),
    cmd('imageDuplicate', ['Image'], Object.assign(sc('Shift+D'), { run: (a) => a.duplicate() })),
    cmd('transformFlipH', ['Image', 'Transform'], { run: (a) => a.simpleOp('flipH', {}) }),
    cmd('transformFlipV', ['Image', 'Transform'], { run: (a) => a.simpleOp('flipV', {}) }),
    cmd('transformRotateRight', ['Image', 'Transform'], { run: (a) => a.simpleOp('rotate90', { dir: 'right' }) }),
    cmd('transformRotateLeft', ['Image', 'Transform'], { run: (a) => a.simpleOp('rotate90', { dir: 'left' }) }),
    cmd('zoomIn', ['Image', 'Zoom'], Object.assign(sc('+'), { run: (a) => a.zoom(1) })),
    cmd('zoomOut', ['Image', 'Zoom'], Object.assign(sc('-'), { run: (a) => a.zoom(-1) })),
    cmd('zoomOriginal', ['Image', 'Zoom'], { run: (a) => a.zoom100() }),
    cmd('zoomToSelection', ['Image', 'Zoom'], { enabled: hasArea, run: (a) => a.zoomToSelection() }),
    cmd('zoomFit', ['Image', 'Zoom'], { run: (a) => a.zoomFit() }),
    cmd('lutApply', ['Image', 'LookupTables'], { enabled: (st) => has(st) && st.doc.bitDepth !== 32, run: (a) => a.applyLut() })
  ].concat(LUT_NAMES.map((name) => cmd('lut' + name.replace(/\s+/g, ''), ['Image', 'LookupTables'],
    { lut: name, run: (a) => a.setLut(name) })))
    .concat([
      cmd('lutInvert', ['Image', 'LookupTables'], { run: (a) => a.invertLut() }),

      // ── Process
      cmd('binMask', ['Process', 'Binary'], { run: (a) => a.convertToMask() }),
      cmd('binFillHoles', ['Process', 'Binary'], { enabled: is8, run: (a) => a.binary('fillHoles') }),
      cmd('binErode', ['Process', 'Binary'], { enabled: is8, run: (a) => a.binary('erode') }),
      cmd('binDilate', ['Process', 'Binary'], { enabled: is8, run: (a) => a.binary('dilate') }),
      cmd('binOpen', ['Process', 'Binary'], { enabled: is8, run: (a) => a.binary('open') }),
      cmd('binClose', ['Process', 'Binary'], { enabled: is8, run: (a) => a.binary('close') }),
      cmd('mathAdd', ['Process', 'Math'], { run: (a) => a.math('add') }),
      cmd('mathSubtract', ['Process', 'Math'], { run: (a) => a.math('subtract') }),
      cmd('mathMultiply', ['Process', 'Math'], { run: (a) => a.math('multiply') }),
      cmd('mathDivide', ['Process', 'Math'], { run: (a) => a.math('divide') }),
      cmd('mathMin', ['Process', 'Math'], { run: (a) => a.math('min') }),
      cmd('mathMax', ['Process', 'Math'], { run: (a) => a.math('max') }),
      cmd('mathAbs', ['Process', 'Math'], { run: (a) => a.simpleOp('math', { op: 'abs', value: 0 }) }),
      cmd('mathSet', ['Process', 'Math'], { run: (a) => a.math('set') }),
      cmd('filterGaussian', ['Process', 'Filters'], { run: (a) => a.gaussian() }),
      cmd('filterMedian', ['Process', 'Filters'], { run: (a) => a.rank('median') }),
      cmd('filterMean', ['Process', 'Filters'], { run: (a) => a.rank('mean') }),
      cmd('filterMinimum', ['Process', 'Filters'], { run: (a) => a.rank('min') }),
      cmd('filterMaximum', ['Process', 'Filters'], { run: (a) => a.rank('max') }),

      // ── Analyze
      cmd('analyzeMeasure', ['Analyze'], Object.assign(sc('m'), { run: (a) => a.measure() })),
      cmd('analyzeParticles', ['Analyze'], { enabled: is8, run: (a) => a.particles() }),
      cmd('analyzeSummarize', ['Analyze'], { enabled: (st) => !st.busy && !!st.hasResults, run: (a) => a.summarize() }),
      cmd('analyzeDistribution', ['Analyze'], { enabled: (st) => !st.busy && !!st.hasResults, run: (a) => a.distribution() }),
      cmd('analyzeClearResults', ['Analyze'], { enabled: (st) => !!st.hasResults, run: (a) => a.clearResults() }),
      cmd('analyzeSetMeasurements', ['Analyze'], { enabled: always, run: (a) => a.setMeasurements() }),
      cmd('analyzeHistogram', ['Analyze'], Object.assign(sc('h'), { run: (a) => a.histogram() })),
      cmd('analyzePlotProfile', ['Analyze'], Object.assign(sc('k'), { enabled: (st) => has(st) && !!st.roi && (st.roi.type === 'line' || st.roi.type === 'polyline'), run: (a) => a.plotProfile() })),
      cmd('toolsRoiManager', ['Analyze', 'Tools'], { enabled: always, run: (a) => a.openTool('roiManager') }),

      // ── Window
      cmd('windowResults', ['Window'], { enabled: always, run: (a) => a.openTool('results') }),
      cmd('windowRoiManager', ['Window'], { enabled: always, run: (a) => a.openTool('roiManager') }),
      cmd('windowNext', ['Window'], { enabled: (st) => st.nDocs > 1, run: (a) => a.cycleImage(1) }),
      cmd('windowPrevious', ['Window'], { enabled: (st) => st.nDocs > 1, run: (a) => a.cycleImage(-1) }),

      // ── Help
      cmd('helpAbout', ['Help'], { enabled: always, run: (a) => a.showAbout() }),
      cmd('helpShortcuts', ['Help'], { enabled: always, run: (a) => a.showShortcuts() })
    ]);

  // Menu positions (PLAN-wave2 §1): `order` = position × 10 inside the (sub)menu, `—` = separator above.
  // A package command uses the same scale; a submenu's own position is in GROUP_META.
  const ORDER = {
    fileOpen: 10, fileSaveTiff: 10, fileSavePng: 20, fileSaveResults: 30, fileRevert: 30, fileRecover: 40, fileClose: 50, fileSimple: 60, fileCloseStudio: 70,
    editUndo: 10, editRedo: 20, editClear: 30, editClearOutside: 40, editFill: 50, editInvert: 60,
    editSelectAll: 10, editSelectNone: 20, editRestoreSelection: 30, editMakeInverse: 110, editAddToManager: 120,
    typeBit8: 10, typeBit16: 20, typeBit32: 30,
    adjustBC: 10, adjustThreshold: 20,
    imageInfo: 30, colorChannels: 40, stackProject: 10, imageCrop: 80, imageDuplicate: 90,
    transformFlipH: 10, transformFlipV: 20, transformRotateRight: 30, transformRotateLeft: 40,
    zoomIn: 10, zoomOut: 20, zoomOriginal: 30, zoomToSelection: 40, zoomFit: 50,
    lutApply: 10, lutGrays: 20, lutRed: 30, lutGreen: 40, lutBlue: 50, lutCyan: 60, lutMagenta: 70, lutYellow: 80, lutFire: 90, lutIce: 100,
    lutSpectrum: 110, lut16Colors: 120, lutHiLo: 130, lutInvert: 140,
    binMask: 10, binErode: 20, binDilate: 30, binOpen: 40, binClose: 50, binFillHoles: 70,
    mathAdd: 10, mathSubtract: 20, mathMultiply: 30, mathDivide: 40, mathMin: 80, mathMax: 90, mathSet: 110, mathAbs: 180,
    filterGaussian: 20, filterMedian: 30, filterMean: 40, filterMinimum: 50, filterMaximum: 60,
    analyzeMeasure: 10, analyzeParticles: 20, analyzeSummarize: 30, analyzeDistribution: 40, analyzeClearResults: 50, analyzeSetMeasurements: 60, analyzeHistogram: 80, analyzePlotProfile: 90,
    toolsRoiManager: 10,
    windowResults: 10, windowRoiManager: 20, windowNext: 30, windowPrevious: 40,
    helpAbout: 10, helpShortcuts: 20
  };
  const SEPARATOR_ABOVE = new Set(['editClear', 'editAddToManager', 'imageInfo', 'imageCrop', 'colorChannels', 'binErode', 'analyzeHistogram']);
  // Position of each submenu inside its parent list (keyed by the path of menu names).
  const GROUP_META = {
    'File/SaveAs': { order: 20 },
    'Edit/Selection': { order: 70, separatorBefore: true },
    'Image/Type': { order: 10 }, 'Image/Adjust': { order: 20 }, 'Image/Color': { order: 60 }, 'Image/Stacks': { order: 70 },
    'Image/Transform': { order: 110 }, 'Image/Zoom': { order: 120, separatorBefore: true }, 'Image/LookupTables': { order: 130 },
    'Process/Noise': { order: 60 }, 'Process/Binary': { order: 70, separatorBefore: true }, 'Process/Math': { order: 80 },
    'Process/Filters': { order: 90 },
    'Analyze/Tools': { order: 110 }
  };
  for (const c of COMMANDS) {
    if (ORDER[c.id] !== undefined) c.order = ORDER[c.id];
    if (SEPARATOR_ABOVE.has(c.id)) c.separatorBefore = true;
  }

  // ───────────────────────────── pure helpers (also used by tests) ─────────────────────────────

  const bytesPerPixel = (bitDepth) => (bitDepth === 8 ? 1 : bitDepth === 16 ? 2 : 4);

  /** Output bit depth of a projection (PLAN §3.4 IJProject). */
  function outputBitDepth(method, depth) {
    if (method === 'max' || method === 'min') return 8;
    if (method === 'sum') return depth <= 257 ? 16 : 32;
    return 32;
  }

  /**
   * The levels offered by the Z Project dialog, finest first: pixels, the in-memory size
   * of the result at 8 and at 32 bits (the method decides which applies), and whether
   * the result at 32 bits plus one undo step fits the engine's budget. `fits` is judged
   * for `outBits`.
   */
  function planLevels(desc, budgetBytes, outBits) {
    const nCh = (desc.channels || []).length || 1;
    const rows = (desc.levels || []).map((lv) => {
      const px = lv.width * lv.height;
      const bytes8 = px * nCh;
      const bytes = px * nCh * bytesPerPixel(outBits);
      return { level: lv.level, width: lv.width, height: lv.height, depth: (lv.indices || []).length,
        bytes8, bytes32: px * nCh * 4, bytes, fits: bytes * 2 <= budgetBytes };
    });
    rows.sort((a, b) => b.width * b.height - a.width * a.height);
    return rows;
  }

  /** Slice range 1-based [a, b] on the finest level → [lo, hi) positions at a level of `n` planes. */
  function mapRange(a, b, n0, n) {
    const lo = Math.max(0, Math.min(n - 1, Math.floor(((a - 1) * n) / n0)));
    const hi = Math.max(lo + 1, Math.min(n, Math.ceil((b * n) / n0)));
    return [lo, hi];
  }

  /**
   * ImageJ ContrastAdjuster slider arithmetic (ContrastAdjuster.java): both sliders run
   * 0..range; brightness is the window centre read against the default range, contrast
   * the default range over the window width, split in two halves around the middle.
   */
  const bcMath = {
    range: 256,
    brightnessToPos(min, max, defMin, defMax) {
      const level = min + (max - min) / 2;
      return bcMath.range * (1 - (level - defMin) / (defMax - defMin));
    },
    contrastToPos(min, max, defMin, defMax) {
      const mid = bcMath.range / 2;
      const w = max - min;
      if (w <= 0) return bcMath.range;
      const c = (defMax - defMin) / w;
      return c > 1 ? bcMath.range - mid / c : c * mid;
    },
    fromBrightness(pos, min, max, defMin, defMax) {
      const center = defMin + (defMax - defMin) * ((bcMath.range - pos) / bcMath.range);
      const w = max - min;
      return { min: center - w / 2, max: center + w / 2 };
    },
    fromContrast(pos, min, max, defMin, defMax) {
      const mid = bcMath.range / 2;
      const center = min + (max - min) / 2;
      const range = defMax - defMin;
      let slope;
      if (pos <= mid) slope = pos / mid;
      else slope = mid / (bcMath.range - pos);
      if (slope > 0) return { min: center - (0.5 * range) / slope, max: center + (0.5 * range) / slope };
      return { min, max };
    }
  };

  function measurementKeys(groups, isLine) {
    const keys = [];
    for (const g of groups) for (const k of MEASURE_GROUPS[g] || []) keys.push(k);
    if (isLine) keys.push('length', 'angle');
    return keys;
  }

  /** The key of the error → plugin lang key ('' when the code is not one of ours). */
  function errorKey(err) {
    const code = err && typeof err === 'object' ? err.code : null;
    return code && ERROR_KEYS[code] ? ERROR_KEYS[code] : '';
  }

  // ───────────────────────────── module state ─────────────────────────────

  const S = {
    ctx: null, api: null, root: null, appEl: null, shell: null, display: null, host: null, windows: null,
    mounted: false, worker: null, workerGen: 0, budgetBytes: 0,
    docs: new Map(),          // docId → info
    order: [],                // docIds in opening order
    activeId: null,
    activeCh: new Map(),      // docId → active channel
    dstate: new Map(),        // docId → { mode, active, visible[], channels[{min,max,lut,invert}] }
    sel: new Map(),           // docId → roi
    prevSel: new Map(),
    undo: new Map(),          // docId → { undo, redo }
    cleanRev: new Map(),      // docId → rev of the last save / load
    revs: new Map(),
    sessionKeys: new Map(),
    sources: new Map(),       // docId → provenance
    roiList: [], roiSelected: new Set(), showAll: false,
    results: [], measurements: loadMeasurements(),
    wins: new Map(), winUpdaters: new Map(),
    tool: 'rect', lineWidth: 1,
    busy: false, busyLabel: '', loadAbort: null,
    leaving: null, figureKey: null, desc: null, enterToken: 0,
    previewSeq: 0, previewTimer: 0, pointer: null, pixelBusy: false, pixelDirty: false,
    persistTimer: 0, persistAsked: false, firstCommitDone: false,
    visHandler: null, menuList: [], unprotected: new Set(), held: new Set(), warnBudget: '', warnLow: false,
    summaryRows: [],          // one row per Analyze Particles run (the Summary window)
    locks: new Map(),         // session key → release() of the Web Lock held while this tab uses it
    emptyEl: null, displayPatch: new Map(), displayInflight: new Map(),
    openCounter: 0, savedAt: 0,
    engineBudget: 0,          // the budget the engine says it runs with (its 'budget' events)
    threshold: null,          // { docId, channel, lower, upper, dark } while the Threshold window holds one
    failedPackages: new Set(), // packages whose ij-proc file did not load in the worker
    previewCompute: 0,        // request id of the running compute preview
    overlayDoc: null,         // the image the overlay items belong to
    extWindowSeq: 0,
    lastToolReady: null,      // promise of the tool window opened last (its first update)
    redirect: null,           // Set Measurements › Redirect to: { docId, channel } | null (not kept across a reload, as ImageJ)
    wand: { tolerance: 0, mode: 8 } // the Wand tool's options (tolerance in pixel values, 4- or 8-connected)
  };

  // ───────────────────────────── extension registry ─────────────────────────────
  const EXTRA_COLUMNS = [];            // [key, header, afterKey] declared through extend({ columns })
  const EXT = { packages: new Map(), measurements: {} };
  let extensionsLocked = false;


  function loadMeasurements() {
    try {
      const raw = JSON.parse(localStorage.getItem(MEASURE_KEY) || 'null');
      if (Array.isArray(raw)) return raw.filter((g) => MEASURE_GROUPS[g]);
    } catch (_) { /* storage unavailable: the default applies */ }
    return MEASURE_DEFAULT.slice();
  }
  function saveMeasurements() {
    try { localStorage.setItem(MEASURE_KEY, JSON.stringify(S.measurements)); } catch (_) { /* per-viewer convenience only */ }
  }

  // ───────────────────────────── small utilities ─────────────────────────────

  function tr(key, params) {
    const c = S.ctx;
    if (c && c.i18n && typeof c.i18n.t === 'function') {
      const v = c.i18n.t(key, params);
      if (typeof v === 'string' && v && v !== key && !v.endsWith('.' + key)) return v;
      if (key.indexOf('.') < 0) {
        const m = c.i18n.t('menu.' + key, params);
        if (typeof m === 'string' && m && m !== 'menu.' + key && !m.endsWith('.menu.' + key)) return m;
      }
    }
    return key;
  }

  /** The shell's t(key, fallback): view.menu.<Name> reads menu.<Name>, other keys read the plugin lang. */
  function shellT(key, fb) {
    if (typeof key !== 'string') return fb;
    let k = key;
    if (k.startsWith('view.menu.')) k = 'menu.' + k.slice(10);
    const v = tr(k);
    return v === k ? fb : v;
  }

  function h(tag, props) {
    const e = document.createElement(tag);
    if (props) {
      for (const k of Object.keys(props)) {
        const v = props[k];
        if (v === null || v === undefined || v === false) continue;
        if (k === 'class') e.className = v;
        else if (k === 'text') e.textContent = v;
        else if (k === 'on') { for (const ev of Object.keys(v)) e.addEventListener(ev, v[ev]); }
        else if (k === 'attrs') { for (const a of Object.keys(v)) e.setAttribute(a, v[a]); }
        else e[k] = v;
      }
    }
    for (let i = 2; i < arguments.length; i++) {
      const kids = Array.isArray(arguments[i]) ? arguments[i] : [arguments[i]];
      for (const kid of kids) {
        if (kid === null || kid === undefined || kid === false) continue;
        e.appendChild(typeof kid === 'string' ? document.createTextNode(kid) : kid);
      }
    }
    return e;
  }
  const btn = (label, onClick, cls) => h('button', { type: 'button', class: 'ij-btn' + (cls ? ' ' + cls : ''), text: label, on: { click: onClick } });
  const row = (...kids) => h('div', { class: 'ij-row' }, ...kids);
  const num = (v, d = 2) => (Number.isFinite(v) ? String(Math.round(v * 10 ** d) / 10 ** d) : String(v));
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const mb = (bytes) => Math.max(1, Math.round(bytes / 1048576));

  function transferable(u8) {
    if (u8.byteOffset === 0 && u8.byteLength === u8.buffer.byteLength) return u8;
    return u8.slice();
  }

  function pad4(n) { return String(Math.max(0, Math.round(n))).padStart(4, '0'); }

  function budgetFromDevice() {
    const dm = typeof navigator !== 'undefined' ? Number(navigator.deviceMemory) : NaN;
    if (!Number.isFinite(dm) || dm <= 0) return GIB;
    return clamp(Math.floor((dm * GIB) / 4), 512 * 1048576, 2 * GIB);
  }

  async function ask(config) {
    if (typeof Dialog === 'undefined') return config.dismissId || null;
    return Dialog.ask(config);
  }

  // ───────────────────────────── errors ─────────────────────────────

  function errorText(err) {
    if (err && typeof err === 'object' && (err.name === 'AbortError' || err.cancelled || err.code === 'IJ_CANCELLED')) return '';
    const key = errorKey(err);
    if (key) return tr(key);
    if (typeof Utils !== 'undefined' && typeof Utils.friendlyErrorText === 'function') {
      const t = Utils.friendlyErrorText(err, {});
      if (t) return t;
    }
    return tr('err.unknown');
  }

  /** Never err.message in the DOM: log it, show the sentence. */
  async function reportError(err) {
    console.error('[advanced-studio]', err);
    const text = errorText(err);
    if (!text) { setStatus(tr('status.cancelled')); return; }
    setStatus(text);
    await ask({ title: tr('err.title'), message: text, options: [{ id: 'ok', label: tr('dlg.ok'), primary: true }], dismissId: 'ok' });
  }

  function setStatus(text) { if (S.shell) S.shell.setStatus(text || ''); }

  function showWarning() {
    if (!S.shell) return;
    const parts = [];
    if (S.held.size) parts.push(tr('warn.held'));
    if (S.unprotected.size) parts.push(tr('warn.unprotected'));
    if (S.warnLow) parts.push(tr('warn.lowStorage'));
    if (S.warnBudget) parts.push(S.warnBudget);
    S.shell.setWarning(parts.length ? parts.join(' ') : null);
  }

  // ───────────────────────────── worker client ─────────────────────────────

  function startWorker() {
    const p = S.ctx.plugin;
    // A bootstrap built from the verified bytes when the host offers it; the on-disk file otherwise.
    const w = new Worker(typeof p.workerUrl === 'function' ? p.workerUrl('ij-worker.js') : p.assetUrl('ij-worker.js'));
    const client = { w, pending: new Map(), nextId: 1, dead: false, ready: false, readyTimer: 0, gen: ++S.workerGen };
    // The engine announces itself with 'ready'; a worker that never does (failed script load that
    // raised no error event, out of memory) would leave every call pending for ever.
    client.readyTimer = setTimeout(() => { if (!client.ready) onWorkerCrash(client, 'PLUGIN_SCRIPT_FAILED'); }, WORKER_READY_MS);
    if (client.readyTimer && client.readyTimer.unref) client.readyTimer.unref();
    w.onmessage = (ev) => onWorkerMessage(client, ev.data);
    w.onerror = (ev) => { if (ev && ev.preventDefault) ev.preventDefault(); console.error('[advanced-studio] worker error', ev && ev.message); onWorkerCrash(client); };
    w.onmessageerror = () => onWorkerCrash(client);
    S.budgetBytes = budgetFromDevice();
    S.failedPackages.clear();
    w.postMessage({ init: Object.assign(workerInit(p), { budgetBytes: S.budgetBytes }) });
    S.worker = client;
  }

  /** WORKER_SCRIPTS as the worker takes them: the mandatory scripts, then the packages (each loaded in its own try/catch). */
  function workerInit(p) {
    const scripts = [], packages = [];
    for (const f of WORKER_SCRIPTS) {
      const m = PACKAGE_FILE_RX.exec(f);
      if (m && m[1] !== 'shared') packages.push({ pkg: m[1], url: p.fileUrl(f) });
      else scripts.push(p.fileUrl(f));
    }
    return { scripts, packages };
  }

  function call(cmdName, args, transfer) {
    const c = S.worker;
    if (!c || c.dead) return Promise.reject(Object.assign(new Error('worker is down'), { code: 'IJ_WORKER_CRASHED' }));
    const id = c.nextId++;
    const p = new Promise((resolve, reject) => {
      c.pending.set(id, { resolve, reject, cmd: cmdName });
      try { c.w.postMessage({ id, cmd: cmdName, args: args || {} }, transfer || []); }
      catch (err) { c.pending.delete(id); reject(err); }
    });
    p.reqId = id;
    return p;
  }

  function onWorkerMessage(client, m) {
    if (!m || client.dead) return;
    if (m.event) { onWorkerEvent(m, client); return; }
    const entry = client.pending.get(m.id);
    if (!entry) return;
    client.pending.delete(m.id);
    if (m.ok) entry.resolve(m.result);
    else {
      const e = m.error || {};
      entry.reject(Object.assign(new Error(e.message || e.code || 'engine error'), { code: e.code || 'IJ_ENGINE', details: e.details || null }));
    }
  }

  function onWorkerEvent(m, client) {
    switch (m.event) {
      case 'ready':
        if (client) { client.ready = true; clearTimeout(client.readyTimer); }
        break;
      case 'initError':
        // The worker is alive but deaf (its scripts failed): same recovery as a crash.
        console.error('[advanced-studio] worker init failed', m.code);
        if (client) onWorkerCrash(client, 'PLUGIN_SCRIPT_FAILED');
        break;
      case 'progress':
        if (S.busy && S.shell) {
          const step = m.stepKey ? tr(m.stepKey) : '';
          S.shell.setProgress({ fraction: m.fraction, label: step && step !== m.stepKey ? step : S.busyLabel, cancellable: true });
        }
        break;
      case 'preview':
        if (m.seq === S.previewSeq && m.docId === S.activeId && S.display) S.display.setPreview(m);
        break;
      case 'invalidate': {
        if (m.docId !== S.activeId || !S.display) break;
        if (m.sizeChanged) refreshInfo(m.docId).then((info) => { afterLayoutChange(m.docId, info); return showDoc(m.docId); }).catch(reportError);
        else if (m.calibration) refreshInfo(m.docId).then(() => { if (S.shell) S.shell.updateInfo(viewInfo(m.docId)); refreshUi(); }).catch(reportError);
        else S.display.invalidate(m.channels);
        scheduleToolRefresh('pixels');
        break;
      }
      case 'packageFailed':
        // The package's ops are gone from the worker: its commands are disabled and say why.
        if (m.pkg) { S.failedPackages.add(String(m.pkg)); setStatus(tr('warn.packageFailed', { pkg: String(m.pkg) })); syncWindowMenu(); }
        break;
      case 'saved':
        S.savedAt = m.at || Date.now();
        // One document's snapshot never clears another's failure.
        if (m.docId !== undefined && m.docId !== null) S.unprotected.delete(m.docId); else S.unprotected.clear();
        showWarning();
        break;
      case 'storageError':
        // A restored image held back (its stored session could not be replayed): its own sentence, not "the browser refused".
        if (m.code === 'IJ_REPLAY_HELD' && m.docId) { S.held.add(m.docId); showWarning(); break; }
        S.unprotected.add(m.docId !== undefined && m.docId !== null ? m.docId : '*');
        showWarning();
        break;
      case 'budget':
        if (m.budgetBytes > 0) S.engineBudget = m.budgetBytes;
        S.warnBudget = m.budgetBytes && m.usedBytes / m.budgetBytes >= 0.9 ? tr('warn.budget', { pct: Math.round((m.usedBytes / m.budgetBytes) * 100) }) : '';
        showWarning();
        break;
      default: break;
    }
  }

  function cancelRunning() {
    if (S.loadAbort) S.loadAbort.abort();
    const c = S.worker;
    if (!c) return;
    for (const [id, e] of c.pending) if (LONG_COMMANDS.has(e.cmd)) call('cancel', { targetId: id }).catch(() => {});
  }

  /** The worker died (crash, failed script load, out of memory): every document it held is gone from memory. */
  function onWorkerCrash(client, code) {
    if (client.dead) return;
    client.dead = true;
    clearTimeout(client.readyTimer);
    try { client.w.terminate(); } catch (_) { /* already gone */ }
    for (const [, e] of client.pending) e.reject(Object.assign(new Error('worker crashed'), { code: code || 'IJ_WORKER_CRASHED' }));
    client.pending.clear();
    if (S.worker !== client || !S.mounted) return;
    S.docs.clear(); S.order = []; S.activeId = null;
    S.unprotected.clear(); S.held.clear(); showWarning();
    endBusy();
    recoverAfterCrash(code).catch((err) => console.error('[advanced-studio]', err));
  }

  async function recoverAfterCrash(code) {
    if (code === 'PLUGIN_SCRIPT_FAILED') {
      // A worker that cannot start would only fail again: say so, offer the Simple view.
      if (S.shell) S.shell.clearImage();
      refreshUi();
      await ask({ title: tr('err.title'), message: tr('err.scriptFailed'), options: [{ id: 'ok', label: tr('dlg.ok'), primary: true }], dismissId: 'ok' });
      if (S.mounted) { S.leaving = 'simple'; await S.api.exit(); }
      return;
    }
    startWorker();
    if (S.shell) S.shell.clearImage();
    refreshUi();
    const choice = await ask({ title: tr('crash.title'), message: tr('crash.message'),
      options: [{ id: 'recover', label: tr('crash.recover'), primary: true }, { id: 'later', label: tr('crash.later') }], dismissId: 'later' });
    if (choice === 'recover') await recoverDialog();
    if (!S.docs.size) showEmpty();
  }

  // ───────────────────────────── busy / progress ─────────────────────────────

  function beginBusy(label) {
    S.busy = true; S.busyLabel = label;
    if (S.shell) S.shell.setProgress({ fraction: null, label, cancellable: true });
    refreshUi();
  }
  function endBusy() {
    S.busy = false; S.busyLabel = '';
    if (S.shell) S.shell.setProgress(null);
    refreshUi();
  }
  async function busy(label, fn) {
    if (S.busy) return null;
    beginBusy(label);
    try { return await fn(); }
    catch (err) { await reportError(err); return null; }
    finally { endBusy(); }
  }

  // ───────────────────────────── documents ─────────────────────────────

  function activeInfo() { return S.activeId !== null ? S.docs.get(S.activeId) || null : null; }
  function activeChannel(info) {
    const i = info || activeInfo();
    const n = (i.channels || []).length;
    return Math.max(0, Math.min(Math.max(0, n - 1), S.activeCh.get(i.docId) || 0));
  }
  const selOf = (docId) => S.sel.get(docId) || null;

  /** The engine knows (revision ≠ revision at the last save); the local count is the fallback. */
  function isDirty(docId) {
    const info = S.docs.get(docId);
    if (info && typeof info.unsaved === 'boolean') return info.unsaved;
    const rev = S.revs.get(docId);
    return rev !== undefined && rev !== S.cleanRev.get(docId);
  }
  function dirtyDocs() { return S.order.filter((id) => S.docs.has(id) && isDirty(id)); }

  function snapshot() {
    const info = activeInfo();
    const u = info ? S.undo.get(info.docId) || { undo: 0, redo: 0 } : { undo: 0, redo: 0 };
    return {
      doc: info, roi: info ? selOf(info.docId) : null, prevRoi: info ? S.prevSel.get(info.docId) || null : null,
      busy: S.busy, nDocs: S.docs.size,
      canUndo: info ? (info.undoDepth !== undefined ? info.undoDepth > 0 : u.undo > 0) : false,
      canRedo: info ? (info.redoDepth !== undefined ? info.redoDepth > 0 : u.redo > 0) : false,
      dirty: info ? isDirty(info.docId) : false,
      hasResults: S.results.length > 0,
      canProject: !!(S.desc && S.desc.available),
      docs: S.order.map((id) => S.docs.get(id)).filter(Boolean),
      threshold: S.threshold,
      activeChannel: info ? activeChannel(info) : 0
    };
  }

  function registerDoc(info, { clean = true, sessionKey = null, provenance = null } = {}) {
    const id = info.docId;
    S.docs.set(id, info);
    if (!S.order.includes(id)) S.order.push(id);
    S.undo.set(id, { undo: 0, redo: 0 });
    const rev = info.rev !== undefined ? info.rev : 0;
    S.revs.set(id, rev);
    if (clean) S.cleanRev.set(id, rev);
    if (sessionKey) S.sessionKeys.set(id, sessionKey);
    if (provenance) S.sources.set(id, provenance);
    initDisplayState(info);
    if (!S.activeCh.has(id)) S.activeCh.set(id, 0);
  }

  /** The local display state of a document, from the engine's info (`fresh`: nothing of the old state is kept). */
  function initDisplayState(info, fresh) {
    const id = info.docId;
    const prev = fresh ? null : S.dstate.get(id);
    const chans = (info.channels || []).map((c, i) => {
      const d = c.display || {};
      return { min: d.min, max: d.max, lut: d.lut, invert: !!d.invert, color: c.color };
    });
    S.dstate.set(id, {
      mode: (prev && prev.mode) || info.mode || 'composite',
      visible: chans.map((_, i) => (prev && prev.visible && prev.visible[i] !== undefined ? prev.visible[i]
        : (Array.isArray(info.visible) && info.visible[i] !== undefined ? !!info.visible[i] : (info.channels[i].visible !== false)))),
      channels: chans
    });
  }

  /**
   * The channels of a document changed (count, order, shape — an Arrange, a crop, an undo of one): the
   * active channel is clamped, the display state is rebuilt from the engine's, and the display patches
   * still waiting for the old indices are dropped (they would land on another channel).
   */
  function afterLayoutChange(docId, info) {
    const n = (info.channels || []).length;
    const act = Number.isInteger(info.active) ? info.active : (S.activeCh.get(docId) || 0);
    S.activeCh.set(docId, Math.max(0, Math.min(Math.max(0, n - 1), act)));
    initDisplayState(info, true);
    for (const k of Array.from(S.displayPatch.keys())) if (k.startsWith(docId + ':')) S.displayPatch.delete(k);
  }

  async function refreshInfo(docId) {
    const info = await call('doc.info', { docId });
    S.docs.set(docId, info);
    if (info.rev !== undefined) S.revs.set(docId, info.rev);
    return info;
  }

  function displayStateFor(docId) {
    const d = S.dstate.get(docId);
    if (!d) return null;
    return { mode: d.mode, active: S.activeCh.get(docId) || 0, visible: d.visible.slice(),
      channels: d.channels.map((c) => ({ min: c.min, max: c.max, lut: c.lut, invert: c.invert })) };
  }
  function pushDisplay() {
    if (!S.shell || S.activeId === null) return;
    const st = displayStateFor(S.activeId);
    if (st) S.shell.setDisplayState(st);
  }

  /** The image description the display takes: the engine's info with the local display state. */
  function viewInfo(docId) {
    const info = S.docs.get(docId);
    const d = S.dstate.get(docId);
    if (!info || !d) return info || null;
    return Object.assign({}, info, {
      channels: (info.channels || []).map((c, i) => Object.assign({}, c, { display: Object.assign({}, c.display || {}, d.channels[i] || {}) })),
      display: { mode: d.mode, active: S.activeCh.get(docId) || 0, visible: d.visible.slice() }
    });
  }

  /**
   * Display change of one channel: the display updates at once (uniforms), the worker is told
   * with at most one request in flight per document, the newest patch winning.
   */
  function setChannelDisplay(docId, channel, patch) {
    const d = S.dstate.get(docId);
    if (!d || !d.channels[channel]) return;
    Object.assign(d.channels[channel], patch);
    if (docId === S.activeId) pushDisplay();
    const key = docId + ':' + channel;
    S.displayPatch.set(key, Object.assign(S.displayPatch.get(key) || {}, patch));
    flushDisplayPatch(docId, channel);
    if (docId === S.activeId) scheduleToolRefresh('display');
  }
  function flushDisplayPatch(docId, channel) {
    const key = docId + ':' + channel;
    if (S.displayInflight.get(key)) return;
    const patch = S.displayPatch.get(key);
    if (!patch) return;
    S.displayPatch.delete(key);
    S.displayInflight.set(key, true);
    call('doc.setDisplay', Object.assign({ docId, channel }, patch))
      .catch((err) => console.error('[advanced-studio] setDisplay', err))
      .then(() => { S.displayInflight.delete(key); flushDisplayPatch(docId, channel); });
  }
  function setDocDisplayMode(docId, patch) {
    const d = S.dstate.get(docId);
    if (!d) return;
    if (patch.mode) d.mode = patch.mode;
    if (patch.visible) d.visible = patch.visible.slice();
    if (patch.active !== undefined) S.activeCh.set(docId, patch.active);
    if (docId === S.activeId) pushDisplay();
    call('doc.setDisplay', Object.assign({ docId }, patch)).catch((err) => console.error('[advanced-studio] setDisplay', err));
    if (docId === S.activeId) scheduleToolRefresh('display');
  }

  /** fromShell: the pointer drew it (the shell already shows it); otherwise the shell is told. */
  function setSelection(docId, roi, final, fromShell) {
    const cur = S.sel.get(docId) || null;
    if (cur && (!roi || final !== false)) S.prevSel.set(docId, cur);
    if (roi) S.sel.set(docId, roi); else S.sel.delete(docId);
    if (docId === S.activeId) {
      if (!fromShell && S.shell) S.shell.setActiveRoi(roi || null);
      // The menus' enabled state depends on whether there is a selection and of which kind: a
      // pointer move that only reshapes it (draw / move / resize, final === false) changes neither.
      if (final !== false || !cur || !roi || cur.type !== roi.type) refreshUi();
      scheduleToolRefresh('selection');
    }
  }

  function refreshRois() {
    if (!S.shell) return;
    const info = activeInfo();
    const list = info ? S.roiList.filter((r) => r.docId === info.docId) : [];
    S.shell.setRois({ all: list.map((r) => ({ roi: r.roi, label: r.name })), showAll: S.showAll });
  }

  function tileProvider(docId) {
    return (channel, level, tx, ty) => call('doc.tile', { docId, channel, level, tx, ty });
  }

  async function showDoc(docId) {
    const info = S.docs.get(docId);
    if (!info || !S.shell) return;
    S.activeId = docId;
    hideEmpty();
    S.display.setTileProvider(tileProvider(docId));
    S.shell.setImage(viewInfo(docId));
    S.display.setThresholdOverlay(null);
    S.display.setPreview(null);
    if (S.display.setOverlay) S.display.setOverlay(null);
    S.shell.setActiveRoi(selOf(docId));
    refreshRois();
    syncWindowMenu();
    refreshUi();
    scheduleToolRefresh('doc');
  }

  /** New images made from `fromId` (default: the active one) take its provenance and session; the last is shown. */
  async function adoptNewDocs(ids, fromId) {
    let last = null;
    const from = fromId !== undefined && fromId !== null ? fromId : S.activeId;
    for (const id of ids || []) {
      const info = await call('doc.info', { docId: id });
      registerDoc(info, { clean: false, provenance: S.sources.get(from) || null, sessionKey: S.sessionKeys.get(from) || null });
      last = id;
    }
    if (last !== null) await showDoc(last);
  }

  function applyRunResult(docId, res) {
    if (!res) return;
    const prev = S.docs.get(docId);
    if (res.info) S.docs.set(docId, res.info);
    if (res.rev !== undefined) S.revs.set(docId, res.rev);
    // A step that only made new images is no undo step of the one it read.
    if (!(res.newDocIds && res.newDocIds.length)) {
      const u = S.undo.get(docId) || { undo: 0, redo: 0 };
      S.undo.set(docId, { undo: u.undo + 1, redo: 0 });
    }
    if (res.info) {
      const layout = (res.changed && res.changed.sizeChanged) || (prev && (prev.channels || []).length !== (res.info.channels || []).length);
      if (layout) afterLayoutChange(docId, res.info); else initDisplayState(res.info);
    }
    commitHook();
  }

  /** After the first committed change: ask the browser to keep the storage, and check the room. */
  function commitHook() {
    scheduleMetaPersist();
    if (S.firstCommitDone) return;
    S.firstCommitDone = true;
    try {
      if (navigator.storage && navigator.storage.persist && !S.persistAsked) {
        S.persistAsked = true;
        navigator.storage.persist().catch(() => {});
      }
      if (navigator.storage && navigator.storage.estimate) {
        navigator.storage.estimate().then((e) => {
          const info = activeInfo();
          const need = info ? info.width * info.height * (info.channels || []).length * bytesPerPixel(info.bitDepth) * 2 : 0;
          if (e && e.quota && e.quota - (e.usage || 0) < need) { S.warnLow = true; showWarning(); }
        }).catch(() => {});
      }
    } catch (_) { /* storage API absent: the engine reports storageError if it matters */ }
  }

  function scheduleMetaPersist() {
    clearTimeout(S.persistTimer);
    S.persistTimer = setTimeout(() => {
      if (!S.worker || S.worker.dead) return;
      // The UI state belongs to the session of the image being edited; with no stored session
      // there is nothing to attach it to (a meta write must never create a document-less session).
      const key = (S.activeId !== null && S.sessionKeys.get(S.activeId)) || Array.from(S.sessionKeys.values())[0];
      if (!key) return;
      call('session.putMeta', { key, results: S.results, rois: S.roiList.map((r) => ({ name: r.name, docId: r.docId, roi: r.roi })),
        measurements: S.measurements, windows: Array.from(S.wins.keys()) }).catch((err) => console.error('[advanced-studio] putMeta', err));
    }, PERSIST_MS);
  }

  // ───────────────────────────── operations on the active image ─────────────────────────────

  /** The v1 entry: an operation on the active image (opts.all = every channel, opts.channel, opts.noRoi). */
  async function runOp(op, params, opts) {
    const info = activeInfo();
    if (!info) return null;
    const o = opts || {};
    const channel = o.channel !== undefined ? o.channel : (o.all ? 'all' : activeChannel(info));
    return runExt(op, params, { docId: info.docId, noRoi: o.noRoi, channel });
  }

  /**
   * When an operation fits the memory only without its undo record, ask once ("run without undo for
   * this step?"). Cheap images skip the estimate. Resolves true = run with noUndo; a refusal cancels.
   */
  async function askNoUndo(info, op, params, roi, channel) {
    const bytes = (info.channels || []).length * info.width * info.height * bytesPerPixel(info.bitDepth);
    if (bytes < (S.engineBudget || S.budgetBytes) * ESTIMATE_MIN_FRACTION) return false;
    let est = null;
    try { est = await call('doc.estimate', { docId: info.docId, op, params, roi, channel }); } catch (_) { return false; } // the run reports the real error
    if (!est || est.fits || !est.fitsWithoutUndo) return false;
    const a = await ask({ title: tr('noUndo.title'), message: tr('noUndo.message'),
      options: [{ id: 'go', label: tr('noUndo.run'), primary: true }, { id: 'cancel', label: tr('dlg.cancel') }], dismissId: 'cancel' });
    if (a !== 'go') throw Object.assign(new Error('cancelled'), { code: 'IJ_CANCELLED' });
    return true;
  }

  /** Runs a registry operation and brings the page up to date. → { newDocIds, changed } | null (failed: reported). */
  async function runExt(op, params, o) {
    const opt = o || {};
    const docId = opt.docId !== undefined ? opt.docId : S.activeId;
    const info = docId !== null && docId !== undefined ? S.docs.get(docId) : null;
    if (!info) return null;
    const roi = opt.noRoi ? null : (opt.roi !== undefined ? opt.roi : selOf(docId));
    const channel = opt.channel !== undefined ? opt.channel : activeChannel(info);
    const label = opt.labelKey ? tr(opt.labelKey) : tr('op.' + op);
    return busy(label, async () => {
      const noUndo = opt.noUndo === true ? true : await askNoUndo(info, op, params || {}, roi, channel);
      const args = { docId, op, params: params || {}, roi, channel };
      if (Array.isArray(opt.docIds) && opt.docIds.length) args.docIds = opt.docIds;
      if (noUndo) args.noUndo = true;
      let res;
      try { res = await call('doc.run', args); }
      catch (err) {
        // A run without undo that was cancelled half-way changed the channels it had finished: the engine
        // says so with the document's info, and the page follows (its history is gone with it).
        const d = err && err.details;
        if (d && d.info) {
          S.docs.set(docId, d.info);
          if (d.info.rev !== undefined) S.revs.set(docId, d.info.rev);
          S.undo.set(docId, { undo: 0, redo: 0 });
          initDisplayState(d.info);
          if (docId === S.activeId && S.display) S.display.invalidate(d.changed ? d.changed.channels : undefined);
          commitHook();
          refreshUi();
        }
        throw err;
      }
      applyRunResult(docId, res);
      const ch = res.changed || {};
      const active = docId === S.activeId;
      if (ch.sizeChanged) {
        // Same geometry (a channel reorder): the selection and the view stay.
        if (!ch.sameGeometry) S.sel.delete(docId);
        if (active) { await showDoc(docId); if (S.display && !ch.sameGeometry) S.display.fit(); }
      } else if (ch.calibration) {
        // metadata only: the selection and the view stay
        if (active && S.shell) S.shell.updateInfo(viewInfo(docId));
        refreshUi();
      } else if (active) {
        if (S.display) S.display.invalidate(ch.channels);
        pushDisplay();
        refreshRois();
        scheduleToolRefresh('pixels');
      }
      if (res.newDocIds && res.newDocIds.length) await adoptNewDocs(res.newDocIds, docId);
      return { newDocIds: res.newDocIds || [], changed: ch };
    });
  }

  async function undoRedo(kind) {
    const info = activeInfo();
    if (!info) return;
    await busy(tr('op.' + kind), async () => {
      const res = await call('doc.' + kind, { docId: info.docId });
      if (res.info) S.docs.set(info.docId, res.info);
      if (res.rev !== undefined) S.revs.set(info.docId, res.rev);
      const u = S.undo.get(info.docId) || { undo: 0, redo: 0 };
      S.undo.set(info.docId, kind === 'undo' ? { undo: Math.max(0, u.undo - 1), redo: u.redo + 1 } : { undo: u.undo + 1, redo: Math.max(0, u.redo - 1) });
      if (res.info) { if (res.changed && res.changed.sizeChanged) afterLayoutChange(info.docId, res.info); else initDisplayState(res.info); }
      if (res.changed && res.changed.sizeChanged) { if (!res.changed.sameGeometry) S.sel.delete(info.docId); await showDoc(info.docId); if (!res.changed.sameGeometry) S.display.fit(); }
      else if (res.changed && res.changed.calibration) { S.shell.updateInfo(viewInfo(info.docId)); refreshUi(); }
      else { S.display.invalidate(res.changed ? res.changed.channels : undefined); pushDisplay(); }
      scheduleToolRefresh('pixels');
      scheduleMetaPersist();
    });
  }

  function fillValue(info, channel, white) {
    if (!white) return 0;
    if (info.bitDepth === 8) return 255;
    if (info.bitDepth === 16) return 65535;
    const d = S.dstate.get(info.docId);
    return d && d.channels[channel] && Number.isFinite(d.channels[channel].max) ? d.channels[channel].max : 1;
  }

  // ── dialogs: the field types the engine of the packages need, resolved against the open images ──

  function docOptions(filter) {
    const out = [];
    for (const id of S.order) {
      const info = S.docs.get(id);
      if (!info) continue;
      let keep = true;
      if (typeof filter === 'function') { try { keep = !!filter(info); } catch (err) { console.error('[advanced-studio] doc filter', err); keep = false; } }
      if (keep) out.push({ value: id, label: info.name });
    }
    // an empty list would be an invalid field: say so instead
    return out.length ? out : [{ value: '', label: tr('dlg.noDocuments'), disabled: true }];
  }
  function channelOptions(info) {
    return (info && info.channels || []).map((c, i) => ({ value: i, label: (i + 1) + (c.name ? ': ' + c.name : '') }));
  }
  function expandField(f) {
    if (!f || typeof f !== 'object') return f;
    if (f.type === 'doc') {
      const options = docOptions(f.filter);
      const value = f.value !== undefined && options.some((o) => o.value === f.value) ? f.value : (options.some((o) => o.value === S.activeId) ? S.activeId : options[0].value);
      return Object.assign({}, f, { options, value });
    }
    if (f.type === 'channel') {
      const out = Object.assign({}, f);
      if (f.docField) {
        out.optionsByDoc = {};
        for (const id of S.order) if (S.docs.get(id)) out.optionsByDoc[String(id)] = channelOptions(S.docs.get(id));
        out.options = out.optionsByDoc[String(S.activeId)] || [{ value: 0, label: '1' }];
      } else {
        out.options = channelOptions(activeInfo());
        if (!out.options.length) out.options = [{ value: 0, label: '1' }];
      }
      if (out.value === undefined) out.value = activeInfo() ? activeChannel(activeInfo()) : 0;
      return out;
    }
    return f;
  }

  function clearExtPreview() {
    clearTimeout(S.previewTimer);
    S.previewSeq++;
    if (S.display) { S.display.setPreview(null); if (S.display.setOverlay) S.display.setOverlay(null); }
    if (S.previewCompute && S.worker && !S.worker.dead) call('cancel', { targetId: S.previewCompute }).catch(() => {});
    S.previewCompute = 0;
  }

  /** { op | compute, params(values), ... } of a dialog spec → the preview hook the view's dialog calls. */
  function extPreviewHook(pv, info) {
    return {
      onChange(values, ctl) {
        if (!values) { clearExtPreview(); if (ctl) ctl.note(null); return; }
        clearTimeout(S.previewTimer);
        const seq = ++S.previewSeq;
        const note = (text) => { if (ctl && seq === S.previewSeq) ctl.note(text); };
        let params;
        try { params = pv.params(values); } catch (err) { console.error('[advanced-studio] preview params', err); return; }
        const channel = typeof pv.channel === 'function' ? pv.channel(values) : (pv.channel !== undefined ? pv.channel : (values.all ? 'all' : activeChannel(info)));
        const roi = pv.roi === false ? null : selOf(info.docId);
        const r = visibleRect(info);
        const region = { x0: Math.max(0, Math.floor(r.x0)), y0: Math.max(0, Math.floor(r.y0)), x1: Math.min(info.width, Math.ceil(r.x1)), y1: Math.min(info.height, Math.ceil(r.y1)) };
        if (pv.compute) {
          // A non-local result (Find Maxima) is only previewed at level 0 over a region of at most ~4 Mpx.
          if ((region.x1 - region.x0) * (region.y1 - region.y0) > PREVIEW_COMPUTE_PIXELS) { if (S.display && S.display.setOverlay) S.display.setOverlay(null); note(tr('dlg.previewZoomIn')); return; }
          note(null);
          compute(pv.compute, params, { docId: info.docId, channel, roi, region, preview: true }).then((res) => {
            if (seq !== S.previewSeq || res === null || res === undefined) return;
            const items = typeof pv.overlay === 'function' ? pv.overlay(res, values) : null;
            if (S.display && S.display.setOverlay) { S.overlayDoc = info.docId; S.display.setOverlay(items); }
          }).catch((err) => { if (!err || (err.code !== 'IJ_CANCELLED' && err.code !== 'IJ_SUPERSEDED')) console.error('[advanced-studio] compute preview', err); });
          return;
        }
        S.previewTimer = setTimeout(() => {
          const level = S.display.getView().level || 0;
          call('doc.preview', { docId: info.docId, seq, op: pv.op, params, roi, channel, level, x0: region.x0, y0: region.y0, x1: region.x1, y1: region.y1 })
            .then(() => note(null))
            .catch((err) => { if (err && err.code === 'IJ_PREVIEW_TOO_LARGE') { S.display.setPreview(null); note(tr('dlg.previewZoomIn')); } else console.error('[advanced-studio] preview', err); });
        }, 90);
      }
    };
  }

  async function dialog(config) {
    if (!S.shell) return null;
    const spec = Object.assign({}, config);
    if (Array.isArray(config.fields)) spec.fields = config.fields.map(expandField);
    const info = activeInfo();
    const ext = !!(config.preview && (config.preview.op || config.preview.compute) && !config.preview.onChange);
    if (ext) spec.preview = info ? extPreviewHook(config.preview, info) : undefined;
    try { return await S.shell.windows.dialog(spec); }
    finally { if (ext) clearExtPreview(); }
  }

  function channelField(info, value) {
    return (info.channels || []).length > 1 ? [{ type: 'check', id: 'all', label: tr('dlg.allChannels'), value: !!value }] : [];
  }

  // Previews: the engine renders the visible region of the image with the dialog's parameters.
  /** Level-0 rectangle on screen, from the display's view (screen = image · zoom + origin). */
  function visibleRect(info) {
    const v = S.display.getView();
    const z = v.zoom || 1;
    return { x0: clamp(-v.ox / z, 0, info.width), y0: clamp(-v.oy / z, 0, info.height),
      x1: clamp((v.viewportWidth - v.ox) / z, 0, info.width), y1: clamp((v.viewportHeight - v.oy) / z, 0, info.height) };
  }
  function previewHooks(op, buildParams, info, allChannels) {
    return {
      onChange(values, ctl) {
        clearTimeout(S.previewTimer);
        if (!values) { S.previewSeq++; S.display.setPreview(null); if (ctl) ctl.note(null); return; }
        S.previewTimer = setTimeout(() => {
          const seq = ++S.previewSeq;
          const r = visibleRect(info);
          const level = S.display.getView().level || 0;
          call('doc.preview', { docId: info.docId, seq, op, params: buildParams(values), roi: selOf(info.docId),
            channel: values.all && allChannels ? 'all' : activeChannel(info), level,
            x0: Math.max(0, Math.floor(r.x0)), y0: Math.max(0, Math.floor(r.y0)),
            x1: Math.min(info.width, Math.ceil(r.x1)), y1: Math.min(info.height, Math.ceil(r.y1)) })
            .then(() => { if (ctl && seq === S.previewSeq) ctl.note(null); })
            .catch((err) => {
              if (err && err.code === 'IJ_PREVIEW_TOO_LARGE' && ctl) { S.display.setPreview(null); if (seq === S.previewSeq) ctl.note(tr('dlg.previewZoomIn')); }
              else console.error('[advanced-studio] preview', err);
            });
        }, 90);
      }
    };
  }
  function endPreview() {
    clearTimeout(S.previewTimer);
    S.previewSeq++;
    if (S.display) S.display.setPreview(null);
  }

  async function filterDialog(titleKey, fields, op, buildParams) {
    const info = activeInfo();
    if (!info) return;
    const all = (info.channels || []).length > 1;
    const f = fields.concat(channelField(info, false));
    let values = null;
    try {
      values = await dialog({ title: tr(titleKey), fields: f, preview: previewHooks(op, buildParams, info, all), okLabel: tr('dlg.ok') });
    } finally { endPreview(); }
    if (!values) return;
    await runOp(op, buildParams(values), { channel: values.all && all ? 'all' : undefined });
  }

  // ───────────────────────────── files ─────────────────────────────

  function safeName(name, ext) {
    const base = String(name || 'image').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').replace(/\s+/g, ' ').trim() || 'image';
    return base.replace(/\.(tif|tiff|png|csv)$/i, '') + ext;
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = h('a', { href: url, download: filename });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }

  /**
   * The picker opens first (it needs the click's user activation); the bytes are produced after.
   * Returns false when the operator cancelled.
   */
  async function saveFile(suggested, mime, ext, desc, produce) {
    let handle = null;
    if (typeof window !== 'undefined' && typeof window.showSaveFilePicker === 'function') {
      try {
        handle = await window.showSaveFilePicker({ suggestedName: suggested, types: [{ description: desc, accept: { [mime]: [ext] } }] });
      } catch (err) {
        if (err && err.name === 'AbortError') return false;
        if (!err || (err.name !== 'SecurityError' && err.name !== 'NotAllowedError' && err.name !== 'TypeError')) throw err;
        handle = null;
      }
    }
    const data = await produce();
    const blob = data instanceof Blob ? data : new Blob([data], { type: mime });
    if (handle) {
      const w = await handle.createWritable();
      await w.write(blob);
      await w.close();
    } else {
      downloadBlob(blob, suggested);
    }
    return true;
  }

  async function saveDocTiff(docId) {
    const info = S.docs.get(docId);
    if (!info) return false;
    // The file holds the revision the engine exported: that revision, never the current one, is
    // what gets marked saved (an operation may commit while the picker or the write is open).
    let savedRev;
    const ok = await saveFile(safeName(info.name, '.tif'), 'image/tiff', '.tif', 'TIFF', async () => {
      const res = await call('doc.exportTiff', { docId });
      savedRev = res.rev;
      return res.bytes;
    });
    if (ok) {
      await call('doc.markSaved', savedRev === undefined ? { docId } : { docId, rev: savedRev });
      S.cleanRev.set(docId, savedRev === undefined ? S.revs.get(docId) : savedRev);
      await refreshInfo(docId);
      refreshUi();
      setStatus(tr('status.saved', { name: info.name }));
    }
    return ok;
  }

  async function saveTiff() {
    if (S.activeId === null) return;
    try { await saveDocTiff(S.activeId); } catch (err) { await reportError(err); }
  }

  async function savePng() {
    const info = activeInfo();
    if (!info || !S.display || !S.display.renderToCanvas) return;
    try {
      await saveFile(safeName(info.name, '.png'), 'image/png', '.png', 'PNG', async () => {
        const canvas = await S.display.renderToCanvas({ scale: 1 });
        return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(Object.assign(new Error('png'), { code: 'IJ_PNG_FAILED' }))), 'image/png'));
      });
    } catch (err) { await reportError(err); }
  }

  /**
   * The columns of a result set: Label, Ch, the ImageJ columns in ImageJ's order, the columns packages
   * declared (each right after the column it names, declaration order kept), then every other key in
   * first-seen order. A row property is the column's KEY; v1 columns use their header as key.
   */
  function resultColumnsOf(rows) {
    const used = new Set(), seen = [];
    for (const r of rows) for (const k of Object.keys(r)) if (!used.has(k)) { used.add(k); seen.push(k); }
    const cols = [];
    const push = (k) => { if (used.has(k) && !cols.includes(k)) cols.push(k); };
    push('Label'); push('Ch');
    for (const [, name] of COLUMNS.concat(PARTICLE_COLUMNS)) push(name);
    const lastAfter = new Map();
    for (const [key, , after] of EXTRA_COLUMNS) {
      if (!used.has(key) || cols.includes(key)) continue;
      const at = after ? cols.indexOf(after) : -1;
      if (at < 0) { cols.push(key); continue; }
      const pos = Math.max(at, lastAfter.has(after) ? cols.indexOf(lastAfter.get(after)) : at) + 1;
      cols.splice(pos, 0, key);
      lastAfter.set(after, key);
    }
    for (const k of seen) push(k);
    return cols;
  }
  const resultColumns = () => resultColumnsOf(S.results);
  function columnHeader(key) {
    const e = EXTRA_COLUMNS.find((c) => c[0] === key);
    return e ? e[1] : key;
  }
  function resultsText(sep) {
    const cols = resultColumns();
    const q = (v) => {
      const s = v === undefined || v === null ? '' : String(v);
      return sep === ',' && /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const lines = [[' '].concat(cols.map(columnHeader)).map(q).join(sep)];
    S.results.forEach((r, i) => lines.push([String(i + 1)].concat(cols.map((c) => q(r[c]))).join(sep)));
    return lines.join('\n') + '\n';
  }

  async function saveResults() {
    try {
      await saveFile('Results.csv', 'text/csv', '.csv', 'CSV', async () => new Blob([resultsText(',')], { type: 'text/csv' }));
    } catch (err) { await reportError(err); }
  }

  function openTiff() {
    const input = h('input', { type: 'file', accept: '.tif,.tiff,image/tiff' });
    input.addEventListener('change', async () => {
      const f = input.files && input.files[0];
      if (!f) return;
      await busy(tr('op.open'), async () => {
        const buf = await f.arrayBuffer();
        const res = await call('doc.open', { bytes: new Uint8Array(buf), name: String(f.name || '').replace(/\.tiff?$/i, '') || undefined }, [buf]);
        const info = res.info;
        registerDoc(info, { clean: true });
        await showDoc(info.docId);
        S.display.fit();
        commitHook();
      });
    });
    input.click();
  }

  async function revert() {
    const info = activeInfo();
    if (!info) return;
    const a = await ask({ title: tr('cmd.fileRevert'), message: tr('revert.message', { name: info.name }),
      options: [{ id: 'revert', label: tr('cmd.fileRevert'), variant: 'danger' }, { id: 'cancel', label: tr('dlg.cancel'), primary: true }], dismissId: 'cancel' });
    if (a !== 'revert') return;
    await busy(tr('op.revert'), async () => {
      const res = await call('doc.revert', { docId: info.docId });
      if (res.info) { S.docs.set(info.docId, res.info); afterLayoutChange(info.docId, res.info); }
      if (res.rev !== undefined) S.revs.set(info.docId, res.rev);
      S.undo.set(info.docId, { undo: 0, redo: 0 });
      S.sel.delete(info.docId);
      await showDoc(info.docId);
      S.display.fit();
    });
  }

  /** Drop every local trace of a document (the engine has been told, or is gone). */
  function forgetDoc(id) {
    const key = S.sessionKeys.get(id);
    for (const m of [S.docs, S.activeCh, S.dstate, S.sel, S.prevSel, S.undo, S.cleanRev, S.revs, S.sessionKeys, S.sources]) m.delete(id);
    S.unprotected.delete(id); S.held.delete(id);
    S.order = S.order.filter((x) => x !== id);
    S.roiList = S.roiList.filter((r) => r.docId !== id);
    if (S.redirect && S.redirect.docId === id) S.redirect = null;
    if (key && !Array.from(S.sessionKeys.values()).includes(key)) releaseSessionLock(key);
  }

  async function closeImage(docId) {
    const id = docId !== undefined ? docId : S.activeId;
    const info = S.docs.get(id);
    if (!info) return;
    if (isDirty(id)) {
      const a = await ask({ title: tr('close.title', { name: info.name }), message: tr('close.message', { name: info.name }),
        options: [{ id: 'save', label: tr('leave.save'), primary: true }, { id: 'discard', label: tr('leave.discard'), variant: 'danger' }, { id: 'cancel', label: tr('dlg.cancel') }], dismissId: 'cancel' });
      if (a === 'save') { let ok = false; try { ok = await saveDocTiff(id); } catch (err) { await reportError(err); } if (!ok) return; }
      else if (a !== 'discard') return;
    }
    // The engine drops this document's own stored records (a saved or discarded one has nothing
    // left to protect). The session key is shared by every image derived from the projection, so
    // it is never discarded here: that would erase the stored state of the siblings.
    try { await call('doc.close', { docId: id, discard: true }); } catch (err) { console.error('[advanced-studio]', err); }
    forgetDoc(id);
    if (S.activeId === id) {
      S.activeId = null;
      if (S.order.length) await showDoc(S.order[S.order.length - 1]);
      else { if (S.shell) S.shell.clearImage(); showEmpty(); }
    }
    syncWindowMenu();
    scheduleToolRefresh('doc');
  }

  async function recoverDialog() {
    let list = [];
    try { list = (await call('session.list', {})).sessions || []; } catch (err) { await reportError(err); return; }
    // The sessions this very view has open are not "saved work to recover": discarding one would
    // remove the baseline its live images still rely on.
    const open = new Set(S.sessionKeys.values());
    const elsewhere = await sessionsHeldElsewhere();
    list = list.filter((s) => !open.has(s.key) && !elsewhere.has(s.key));
    if (!list.length) {
      await ask({ title: tr('cmd.fileRecover'), message: tr('recover.none'), options: [{ id: 'ok', label: tr('dlg.ok'), primary: true }], dismissId: 'ok' });
      return;
    }
    const fmt = (s) => {
      const n = Array.isArray(s.docs) ? s.docs.length : Number(s.docs) || 0;
      const names = Array.isArray(s.names) && s.names.length ? ' ' + s.names.join(', ') : '';
      return tr('recover.item', { time: new Date(s.savedAt).toLocaleString(), n }) + names + (s.unsaved ? ' *' : '');
    };
    const v = await dialog({ title: tr('cmd.fileRecover'), okLabel: tr('dlg.ok'), fields: [
      { type: 'choice', id: 'key', label: tr('recover.session'), value: list[0].key, options: list.map((s) => ({ value: s.key, label: fmt(s) })) },
      { type: 'choice', id: 'action', label: tr('recover.action'), value: 'restore', options: [{ value: 'restore', label: tr('recover.restore') }, { value: 'discard', label: tr('recover.discard') }, { value: 'discardAll', label: tr('recover.discardAll') }] }] });
    if (!v) return;
    if (v.action === 'discardAll') {
      try { for (const s of list) await call('session.discard', { key: s.key }); setStatus(tr('recover.discarded')); } catch (err) { await reportError(err); }
      return;
    }
    if (v.action === 'discard') {
      try { await call('session.discard', { key: v.key }); setStatus(tr('recover.discarded')); } catch (err) { await reportError(err); }
      return;
    }
    if (!(await restoreSession(v.key))) setStatus(tr('recover.nothing'));
  }

  /**
   * Restores a stored session. Resolves to the number of documents it brought back (0 = nothing
   * restorable, the caller falls back to the fresh load); a replay that stopped early or a
   * document without a stored baseline is said, never silently dropped.
   */
  async function restoreSession(key) {
    let count = 0;
    let warned = [];
    await busy(tr('op.restore'), async () => {
      let res;
      try { res = await call('session.restore', { key }); }
      catch (err) { if (err && err.code === 'IJ_NO_SESSION') return; throw err; }
      let last = null;
      for (const id of res.docIds || []) {
        const info = await call('doc.info', { docId: id });
        registerDoc(info, { clean: false, sessionKey: key });
        last = id; count++;
      }
      if (count) holdSessionLock(key);
      if (res.meta) restoreMeta(res.meta);
      if (last !== null) { await showDoc(last); S.display.fit(); }
      warned = res.warnings || [];
    });
    if (warned.length) {
      const stopped = warned.filter((w) => w.code === 'IJ_REPLAY_STOPPED' && !w.held).length;
      const held = warned.filter((w) => w.code === 'IJ_REPLAY_STOPPED' && w.held).length;
      const lost = warned.filter((w) => w.code === 'IJ_NO_BASELINE').length;
      const lines = [];
      if (stopped) lines.push(tr('recover.partial', { n: stopped }));
      if (held) lines.push(tr('recover.held', { n: held }));
      if (lost) lines.push(tr('recover.noBaseline', { n: lost }));
      if (lines.length) {
        setStatus(lines.join(' '));
        await ask({ title: tr('cmd.fileRecover'), message: lines.join('\n'), options: [{ id: 'ok', label: tr('dlg.ok'), primary: true }], dismissId: 'ok' });
      }
    }
    return count;
  }

  /** Results and selections of the restored session are added to the ones already here, not swapped for them. */
  function restoreMeta(meta) {
    if (Array.isArray(meta.results)) S.results = S.results.concat(meta.results);
    if (Array.isArray(meta.rois)) {
      const known = new Set(S.roiList.map((r) => r.docId + '|' + r.name));
      for (const r of meta.rois) {
        if (!r || !r.roi) continue;
        const k = r.docId + '|' + r.name;
        if (known.has(k)) continue;
        known.add(k);
        S.roiList.push({ name: r.name, docId: r.docId, roi: r.roi });
      }
    }
    scheduleToolRefresh('results');
    scheduleToolRefresh('rois');
    refreshRois();
  }

  // ── one tab per session: a Web Lock held while this tab works on a stored session ──

  function locksApi() { return typeof navigator !== 'undefined' && navigator.locks && typeof navigator.locks.request === 'function' ? navigator.locks : null; }
  function holdSessionLock(key) {
    const locks = locksApi();
    if (!locks || S.locks.has(key)) return;
    let release = null;
    const held = new Promise((r) => { release = r; });
    S.locks.set(key, release);
    locks.request('lumen3d-ij:' + key, { ifAvailable: true }, (lock) => (lock ? held : null)).catch(() => {});
  }
  function releaseSessionLock(key) {
    const r = S.locks.get(key);
    if (r) { S.locks.delete(key); r(); }
  }
  /** Keys of the stored sessions another tab is working on. */
  async function sessionsHeldElsewhere() {
    const locks = locksApi();
    const out = new Set();
    if (!locks || typeof locks.query !== 'function') return out;
    try {
      const q = await locks.query();
      for (const l of q.held || []) if (typeof l.name === 'string' && l.name.startsWith('lumen3d-ij:')) out.add(l.name.slice('lumen3d-ij:'.length));
    } catch (_) { /* no answer: nothing is hidden */ }
    for (const k of S.locks.keys()) out.delete(k);
    return out;
  }

  // ───────────────────────────── entering: describe, resume, Z Project ─────────────────────────────

  function figureKeyOf(desc) {
    const lv = finestLevel(desc);
    const idx = lv ? lv.indices : [];
    return [desc.datasetId, desc.treeKey, desc.timepoint === null || desc.timepoint === undefined ? '' : desc.timepoint, desc.axis,
      idx.length ? idx[0] + '-' + idx[idx.length - 1] : ''].join('|');
  }
  function finestLevel(desc) {
    let best = null;
    for (const lv of desc.levels || []) if (!best || lv.width * lv.height > best.width * best.height) best = lv;
    return best;
  }

  function showEmpty() {
    if (!S.host || S.emptyEl) return;
    S.emptyEl = h('div', { class: 'ij-empty' },
      h('p', { class: 'ij-banner', text: tr('empty.message') }),
      row(btn(tr('cmd.stackProject'), () => zProject(), 'ij-btn--primary'), btn(tr('cmd.fileOpen'), () => openTiff()), btn(tr('cmd.fileSimple'), () => simpleView())));
    S.host.appendChild(S.emptyEl);
  }
  function hideEmpty() { if (S.emptyEl) { S.emptyEl.remove(); S.emptyEl = null; } }

  async function enter() {
    const token = ++S.enterToken;
    let desc = null;
    try { desc = S.ctx.studio.source.describe(); } catch (err) { console.error('[advanced-studio] describe', err); }
    if (!desc || !desc.available) {
      S.desc = null;
      showUnavailable(desc);
      return;
    }
    S.desc = desc;
    refreshUi();
    const fkey = figureKeyOf(desc);
    if (S.docs.size && S.figureKey === fkey) return;
    S.figureKey = fkey;

    let match = null;
    try {
      const res = await call('session.list', { datasetId: desc.datasetId });
      const loaded = new Set(S.sessionKeys.values());
      const elsewhere = await sessionsHeldElsewhere();
      const docCount = (s) => (Array.isArray(s.docs) ? s.docs.length : Number(s.docs) || 0);
      const mine = (res.sessions || []).filter((s) => String(s.key).startsWith(fkey + '|') && !loaded.has(s.key) && !elsewhere.has(s.key) && docCount(s) > 0);
      mine.sort((a, b) => b.savedAt - a.savedAt);
      match = mine[0] || null;
    } catch (err) { console.error('[advanced-studio] session.list', err); }
    // A worker that died meanwhile has its own recovery path (crash / failed start): nothing to add here.
    if (token !== S.enterToken || !S.worker || S.worker.dead) return;

    if (match) {
      const a = await ask({ title: tr('resume.title'), message: tr('resume.message', { time: new Date(match.savedAt).toLocaleString() }),
        options: [{ id: 'resume', label: tr('resume.resume'), primary: true }, { id: 'fresh', label: tr('resume.fresh') }, { id: 'cancel', label: tr('dlg.cancel') }], dismissId: 'cancel' });
      if (a === 'resume') {
        // A stored session that yields no document is dropped and the fresh load follows.
        if ((await restoreSession(match.key)) > 0) return;
        await call('session.discard', { key: match.key }).catch(() => {});
      } else
      if (a !== 'fresh') { if (!S.docs.size) { S.leaving = 'simple'; await S.api.exit(); } return; }
    }
    const done = await zProject();
    if (!done && !S.docs.size) { S.leaving = 'simple'; await S.api.exit(); }
  }

  function showUnavailable(desc) {
    hideEmpty();
    const key = (desc && desc.reasonKey) || 'studioAdvanced.notSupported';
    let text = key;
    if (typeof I18n !== 'undefined' && I18n.t) text = I18n.t(key);
    if (!S.host) return;
    S.emptyEl = h('div', { class: 'ij-empty' }, h('p', { class: 'ij-banner', text }),
      row(btn(tr('cmd.fileSimple'), () => simpleView(), 'ij-btn--primary')));
    S.host.appendChild(S.emptyEl);
  }

  /** The Z Project dialog, then the streamed load. Resolves true when an image was loaded. */
  async function zProject() {
    const desc = S.ctx.studio.source.describe();
    if (!desc || !desc.available) { showUnavailable(desc); return false; }
    S.desc = desc;
    const fine = finestLevel(desc);
    const n0 = fine ? fine.indices.length : 1;
    const multi = n0 > 1;
    const levels = planLevels(desc, S.budgetBytes, 8);
    const fits = levels.filter((l) => l.fits);
    if (!fits.length) { await reportError(Object.assign(new Error('no level fits'), { code: 'IJ_OVER_BUDGET' })); return false; }
    const nCh = (desc.channels || []).length;
    const fields = [];
    if (multi) {
      fields.push({ type: 'choice', id: 'method', label: tr('proj.method'), value: 'max', options: [
        { value: 'max', label: tr('proj.max') }, { value: 'min', label: tr('proj.min') }, { value: 'sum', label: tr('proj.sum') },
        { value: 'avg', label: tr('proj.avg') }, { value: 'sd', label: tr('proj.sd') }, { value: 'median', label: tr('proj.median') }] });
      fields.push({ type: 'number', id: 'start', label: tr('proj.start'), value: 1, min: 1, max: n0, step: 1 });
      fields.push({ type: 'number', id: 'stop', label: tr('proj.stop'), value: n0, min: 1, max: n0, step: 1 });
    } else {
      fields.push({ type: 'message', id: 'single', label: tr('proj.single') });
    }
    fields.push({ type: 'choice', id: 'level', label: tr('proj.level'), value: fits[0].level, options: levels.map((l) => ({
      value: l.level, disabled: !l.fits,
      label: tr('proj.levelItem', { w: l.width, h: l.height, c: nCh, mb8: mb(l.bytes8), mb32: mb(l.bytes32) }) + (l.fits ? '' : ' — ' + tr('proj.tooLarge')) })) });
    fields.push({ type: 'message', id: 'note', label: tr('proj.note') });
    const v = await dialog({ title: tr('cmd.stackProject'), fields, okLabel: tr('dlg.ok') });
    if (!v) return false;
    const method = multi ? v.method : 'max';
    const a = multi ? clamp(Math.round(Number(v.start)), 1, n0) : 1;
    const b = multi ? clamp(Math.round(Number(v.stop)), a, n0) : 1;
    return loadProjection(desc, { method, level: Number(v.level), a, b, n0 });
  }

  /** Greyscale placeholder from the Studio's own picture, shown until the first band is in. */
  function placeholderProvider(info) {
    // The Studio's own raw atlas values (the document is a JSON clone and never carries them).
    let raw = null, ac = NaN;
    try {
      const st = S.ctx.studio;
      const got = typeof st.getSliceRaw === 'function' ? st.getSliceRaw() : null;
      raw = got && got.raw ? got.raw : got;
      ac = Number(got && got.activeChannel !== undefined ? got.activeChannel : (st.getDocument() || {}).activeChannel);
    } catch (_) { raw = null; }
    if (!raw || !raw.data || !raw.width || !raw.height) return null;
    const c = Number.isInteger(ac) ? Math.min(3, Math.max(0, ac)) : 0;
    return (channel, level, tx, ty) => {
      const f = 1 << level;
      const x0 = tx * 1024 * f, y0 = ty * 1024 * f;
      const w = Math.max(1, Math.min(1024, Math.ceil((info.width - x0) / f)));
      const hh = Math.max(1, Math.min(1024, Math.ceil((info.height - y0) / f)));
      const out = new Uint8Array(w * hh);
      for (let j = 0; j < hh; j++) {
        const ry = Math.min(raw.height - 1, Math.floor(((y0 + (j + 0.5) * f) / info.height) * raw.height));
        for (let i = 0; i < w; i++) {
          const rx = Math.min(raw.width - 1, Math.floor(((x0 + (i + 0.5) * f) / info.width) * raw.width));
          out[j * w + i] = raw.data[(ry * raw.width + rx) * 4 + c];
        }
      }
      return Promise.resolve({ width: w, height: hh, bitDepth: 8, data: out });
    };
  }

  async function loadProjection(desc, opt) {
    const lvDesc = (desc.levels || []).find((l) => l.level === opt.level);
    if (!lvDesc) return false;
    const [lo, hi] = mapRange(opt.a, opt.b, opt.n0, lvDesc.indices.length);
    const depth = hi - lo;
    const outBits = outputBitDepth(opt.method, depth);
    const here = planLevels(desc, S.budgetBytes, outBits).find((l) => l.level === lvDesc.level);
    if (!here || !here.fits) { await reportError(Object.assign(new Error('level over budget'), { code: 'IJ_OVER_BUDGET' })); return false; }
    const channels = desc.channels || [];
    const cal = { pixelWidth: lvDesc.voxelUm ? lvDesc.voxelUm[desc.uAxis] : 1, pixelHeight: lvDesc.voxelUm ? lvDesc.voxelUm[desc.vAxis] : 1, unit: 'µm' };
    const fkey = figureKeyOf(desc);
    // One session per load: "Start again from the data" must not pour its images into the
    // session it declined (that one stays whole in File › Recover). Entry matches by the
    // `fkey|` prefix, so the trailing load stamp changes nothing there.
    const sessionKey = [fkey, lvDesc.level, opt.method, (opt.a) + '-' + (opt.b), Date.now().toString(36)].join('|');
    const provenance = { datasetId: desc.datasetId, datasetName: desc.datasetName, treeKey: desc.treeKey, timepoint: desc.timepoint,
      axis: desc.axis, level: lvDesc.level, method: opt.method, first: lvDesc.indices[lo], last: lvDesc.indices[hi - 1], sessionKey };
    const name = depth > 1
      ? tr('proj.name', { dataset: desc.datasetName, axis: String(desc.axis).toUpperCase(), a: lvDesc.indices[lo], b: lvDesc.indices[hi - 1], method: tr('proj.' + opt.method) })
      : tr('proj.nameSingle', { dataset: desc.datasetName, axis: String(desc.axis).toUpperCase(), a: lvDesc.indices[lo] });

    const ac = new AbortController();
    S.loadAbort = ac;
    beginBusy(tr('load.open'));
    let session = null, docId = null, ok = false;
    try {
      session = await S.ctx.studio.source.open({ level: lvDesc.level, signal: ac.signal });
      // The band decides the peak of a median / sd accumulator (P * depth for P = rows * width):
      // the engine fits it to the budget and says which band to stream with.
      const begin = await call('doc.project.begin', { name, method: opt.method, width: session.width, height: session.height, depth,
        channels: channels.map((c) => ({ name: c.name, color: c.color })), calibration: cal, provenance, bandRows: session.bandRows });
      docId = begin.docId;
      const bandRows = Math.max(1, Math.min(session.bandRows, Number.isInteger(begin.bandRows) && begin.bandRows > 0 ? begin.bandRows : session.bandRows));
      const prov = placeholderProvider({ width: session.width, height: session.height });
      if (prov && S.shell) {
        const fake = { docId: -1, name, width: session.width, height: session.height, bitDepth: 8, channels: channels.map((c) => ({ name: c.name, color: c.color, display: { min: 0, max: 255, lut: c.color } })), calibration: cal };
        S.display.setTileProvider(prov);
        S.shell.setImage(fake);
        hideEmpty();
      }
      // Progress counts the lossless voxels delivered, so its total is the voxels the read
      // delivers (w·h·planes·channels bytes) — not session.estimateBytes(), which counts the
      // compressed bytes fetched and is smaller.
      const est = session.width * session.height * depth * channels.length;
      const bands = Math.ceil(session.height / bandRows);
      const zChunk = Math.max(1, session.zChunk || 1);
      const chIdx = channels.map((c) => c.index);
      const totalPlanes = depth * bands;
      let donePlanes = 0, loadedBytes = 0, inflight = null;
      for (let bi = 0, y0 = 0; y0 < session.height; bi++, y0 += bandRows) {
        const y1 = Math.min(session.height, y0 + bandRows);
        for (let z0 = lo; z0 < hi; z0 += zChunk) {
          const z1 = Math.min(hi, z0 + zChunk);
          if (ac.signal.aborted) throw Object.assign(new Error('cancelled'), { name: 'AbortError' });
          session.assertFrame();
          const blk = await session.readBlock({ y0, y1, z0, z1, channels: chIdx, signal: ac.signal });
          if (inflight) await inflight;
          const adds = [];
          for (let ci = 0; ci < chIdx.length; ci++) {
            const data = transferable(blk.data[ci]);
            loadedBytes += data.byteLength;
            adds.push(call('doc.project.add', { docId, channel: ci, y0, rows: blk.rows, z0: z0 - lo, depth: z1 - z0, data }, [data.buffer]));
          }
          inflight = Promise.all(adds);
          donePlanes += z1 - z0;
          const fraction = donePlanes / totalPlanes;
          if (S.shell) {
            S.shell.setProgress({ fraction, cancellable: true, label: tr('load.status', { pct: Math.round(fraction * 100), band: bi + 1, bands,
              z0: lvDesc.indices[z0], z1: lvDesc.indices[z1 - 1], mb: mb(loadedBytes), total: est ? mb(est) : '?' }) });
          }
        }
      }
      if (inflight) await inflight;
      const fin = await call('doc.project.finish', { docId });
      const info = fin.info;
      registerDoc(info, { clean: true, sessionKey, provenance });
      holdSessionLock(sessionKey);
      ok = true;
      await showDoc(docId);
      S.display.fit();
      commitHook();
    } catch (err) {
      if (docId !== null && !ok) call('doc.close', { docId }).catch(() => {});
      if (S.shell && !S.docs.size) { S.shell.clearImage(); showEmpty(); }
      else if (S.activeId !== null) await showDoc(S.activeId);
      endBusy();
      S.loadAbort = null;
      if (session) { try { session.release(); } catch (_) { /* idempotent */ } }
      session = null;
      await reportError(err);
      return false;
    } finally {
      if (session) { try { session.release(); } catch (_) { /* idempotent */ } }
      S.loadAbort = null;
    }
    endBusy();
    return ok;
  }

  // ───────────────────────────── command implementations ─────────────────────────────

  async function simpleOp(op, params) { await runOp(op, params, { all: op === 'flipH' || op === 'flipV' || op === 'rotate90' }); }

  function selectAll() {
    const info = activeInfo();
    if (info) setSelection(info.docId, { type: 'rect', x: 0, y: 0, w: info.width, h: info.height }, true);
  }
  function selectNone() { const info = activeInfo(); if (info) setSelection(info.docId, null, true); }
  function restoreSelection() {
    const info = activeInfo();
    const p = info && S.prevSel.get(info.docId);
    if (p) setSelection(info.docId, p, true);
  }
  function makeInverse() {
    const info = activeInfo();
    const roi = info && selOf(info.docId);
    if (!roi || typeof IJRoi === 'undefined') return;
    try { setSelection(info.docId, IJRoi.inverse(roi, info.width, info.height), true); } catch (err) { reportError(err); }
  }

  function clearSel(outside) {
    const info = activeInfo();
    if (!info) return;
    return runOp(outside ? 'clearOutside' : 'clear', { value: fillValue(info, activeChannel(info), false) });
  }
  function fillSel() {
    const info = activeInfo();
    if (!info) return;
    return runOp('fill', { value: fillValue(info, activeChannel(info), true) });
  }
  const invert = () => runOp('invert', {});
  const crop = () => runOp('crop', {}, { all: true });

  async function duplicate() {
    const info = activeInfo();
    if (!info) return;
    let all = true;
    if ((info.channels || []).length > 1) {
      const v = await dialog({ title: tr('cmd.imageDuplicate'), okLabel: tr('dlg.ok'), fields: [{ type: 'check', id: 'all', label: tr('dlg.allChannels'), value: true }] });
      if (!v) return;
      all = !!v.all;
    }
    await busy(tr('op.duplicate'), async () => {
      const roi = isAreaRoi(selOf(info.docId)) ? selOf(info.docId) : null;
      const res = await call('doc.duplicate', { docId: info.docId, roi, channels: all ? undefined : [activeChannel(info)], name: info.name.replace(/(-\d+)?$/, '') + '-1' });
      registerDoc(res.info, { clean: false, provenance: S.sources.get(info.docId) || null, sessionKey: S.sessionKeys.get(info.docId) || null });
      await showDoc(res.info.docId);
      S.display.fit();
      commitHook();
    });
  }

  async function convertType(bits) {
    const info = activeInfo();
    if (!info) return;
    const lossy = bits < info.bitDepth;
    if (lossy) {
      const a = await ask({ title: tr('type.title', { bits }), message: tr('type.lossy', { bits }),
        options: [{ id: 'ok', label: tr('dlg.ok'), primary: true }, { id: 'cancel', label: tr('dlg.cancel') }], dismissId: 'cancel' });
      if (a !== 'ok') return;
    }
    await runOp('convert', { bitDepth: bits, scale: true }, { all: true, noRoi: true });
  }

  function zoom(dir) {
    if (!S.display || !S.host) return;
    S.display.zoomAt(S.host.clientWidth / 2, S.host.clientHeight / 2, dir);
  }
  const zoom100 = () => { if (S.display) S.display.view100(); };
  const zoomFit = () => { if (S.display) S.display.fit(); };
  function zoomToSelection() {
    const info = activeInfo();
    const roi = info && selOf(info.docId);
    if (!roi || !S.display || typeof IJRoi === 'undefined') return;
    S.display.zoomToRect(IJRoi.bounds(roi));
  }

  function lutOf(info, ch) { const d = S.dstate.get(info.docId); return d && d.channels[ch] ? d.channels[ch] : null; }
  function setLut(name) {
    const info = activeInfo();
    if (!info) return;
    setChannelDisplay(info.docId, activeChannel(info), { lut: name });
  }
  function invertLut() {
    const info = activeInfo();
    if (!info) return;
    const c = lutOf(info, activeChannel(info));
    setChannelDisplay(info.docId, activeChannel(info), { invert: !(c && c.invert) });
  }
  async function applyLut() {
    const info = activeInfo();
    if (!info || info.bitDepth === 32) return;
    const c = lutOf(info, activeChannel(info));
    if (!c) return;
    await runOp('applyLut', { min: c.min, max: c.max }, {});
  }

  async function convertToMask() {
    const info = activeInfo();
    if (!info) return;
    await busy(tr('op.toMask'), async () => {
      const ch = activeChannel(info);
      const t = await call('doc.threshold', { docId: info.docId, channel: ch, method: 'Default', dark: S.thrDark !== false, roi: isAreaRoi(selOf(info.docId)) ? selOf(info.docId) : null });
      const res = await call('doc.run', { docId: info.docId, op: 'toMask', params: { lower: t.lower, upper: t.upper }, roi: null, channel: ch });
      applyRunResult(info.docId, res);
      if (res.newDocIds && res.newDocIds.length) await adoptNewDocs(res.newDocIds);
    });
  }
  const binary = (op) => runOp('binary', { op }, { all: true });

  async function math(kind) {
    const info = activeInfo();
    if (!info) return;
    const v = await dialog({ title: tr('cmd.math' + kind[0].toUpperCase() + kind.slice(1)), okLabel: tr('dlg.ok'), fields:
      [{ type: 'number', id: 'value', label: tr('dlg.value'), value: kind === 'multiply' || kind === 'divide' ? 1 : 25, step: 'any' }].concat(channelField(info, false)) });
    if (!v) return;
    await runOp('math', { op: kind, value: Number(v.value) }, { channel: v.all ? 'all' : undefined });
  }

  async function gaussian() {
    const info = activeInfo();
    if (!info) return;
    const cal = info.calibration || {};
    await filterDialog('cmd.filterGaussian', [
      { type: 'number', id: 'sigma', label: tr('dlg.sigma'), value: 2, min: 0.01, step: 0.5, units: tr('dlg.pixels') },
      { type: 'check', id: 'scaled', label: tr('dlg.scaled', { unit: cal.unit || 'µm' }), value: false }],
    'gaussian', (v) => ({ sigma: Math.max(0.01, Number(v.sigma)), scaled: !!v.scaled }));
  }
  async function rank(type) {
    const names = { median: 'filterMedian', mean: 'filterMean', min: 'filterMinimum', max: 'filterMaximum' };
    await filterDialog('cmd.' + names[type], [{ type: 'number', id: 'radius', label: tr('dlg.radius'), value: 2, min: 0, step: 0.5, units: tr('dlg.pixels') }],
      'rank', (v) => ({ type, radius: Math.max(0, Number(v.radius)) }));
  }

  // ── analysis

  function measuredKeys(roi) {
    if (roi && roi.type === 'angle') return ['angle'];
    return measurementKeys(S.measurements, !!roi && (roi.type === 'line' || roi.type === 'polyline'));
  }
  /** What the Threshold window holds for this image and channel (the range %Area and "Limit to threshold" read), or null. */
  function thresholdFor(info, ch) {
    const t = S.threshold;
    return t && t.docId === info.docId && t.channel === ch ? { lower: t.lower, upper: t.upper } : null;
  }
  /** The arguments of doc.stats beyond the keys: the threshold, Limit to threshold, Redirect to. */
  function measureOptions(info, ch) {
    const o = { threshold: thresholdFor(info, ch), limit: S.measurements.includes('limit') };
    if (S.redirect) {
      const rinfo = S.docs.get(S.redirect.docId);
      // a redirect image closed, or whose channel Arrange Channels dropped, is no longer a target
      if (!rinfo || !(S.redirect.channel < (rinfo.channels || []).length)) S.redirect = null;
      else {
        o.redirect = { docId: S.redirect.docId, channel: S.redirect.channel };
        // Analyzer.getRedirectStats reads the redirect image's own threshold
        o.threshold = thresholdFor(rinfo, S.redirect.channel);
      }
    }
    return o;
  }
  function toRow(res, info, roi, channelIdx) {
    const out = {};
    if (S.measurements.includes('labels')) {
      const src = S.redirect && S.docs.get(S.redirect.docId);
      out.Label = (src || info).name;
    }
    if ((info.channels || []).length > 1) out.Ch = channelIdx + 1;
    for (const [key, col] of COLUMNS) if (res[key] !== undefined) out[col] = res[key];
    return out;
  }
  /** Results rows of one selection: one row, but a row per point of a multi-point selection. */
  async function measureRows(info, roi, channelIdx) {
    const res = await call('doc.stats', Object.assign({ docId: info.docId, roi, channel: channelIdx, measurements: measuredKeys(roi) }, measureOptions(info, channelIdx)));
    const list = res.rows || [res.row || res];
    return list.map((r) => toRow(r, info, roi, channelIdx));
  }
  async function measureRoi(info, roi, channelIdx) { return (await measureRows(info, roi, channelIdx))[0]; }

  // Analyze > Summarize appends Mean / SD / Min / Max rows; the next measurement removes them ("clearSummary").
  const SUMMARY_LABELS = ['Mean', 'SD', 'Min', 'Max'];
  function hasSummary() {
    const n = S.results.length;
    return n >= 4 && SUMMARY_LABELS.every((l, i) => S.results[n - 4 + i].Label === l);
  }
  function appendResults(rows) {
    if (hasSummary()) S.results = S.results.slice(0, -4);
    S.results = S.results.concat(rows);
    scheduleToolRefresh('results');
    scheduleMetaPersist();
    refreshUi();
  }
  async function measure() {
    const info = activeInfo();
    if (!info) return;
    await busy(tr('op.measure'), async () => {
      appendResults(await measureRows(info, selOf(info.docId), activeChannel(info)));
    });
    openTool('results');
  }
  function clearResults() { S.results = []; scheduleToolRefresh('results'); scheduleMetaPersist(); refreshUi(); }

  /** Analyzer.summarize: Mean, SD ("(sum2-sum*sum/n)/(n-1)"), Min, Max of every column; a missing cell counts as 0 (ImageJ's table). */
  function summarize() {
    const rows = S.results, n = rows.length;
    if (n < 2 || hasSummary()) return;
    const cols = resultColumns().filter((c) => c !== 'Label');
    const out = SUMMARY_LABELS.map((l) => ({ Label: l }));
    for (const c of cols) {
      let min = Infinity, max = -Infinity, sum = 0, sum2 = 0;
      for (const r of rows) {
        const v = typeof r[c] === 'number' ? r[c] : 0;
        if (v < min) min = v;
        if (v > max) max = v;
        sum += v; sum2 += v * v;
      }
      out[0][c] = sum / n; out[1][c] = Math.sqrt((sum2 - sum * sum / n) / (n - 1)); out[2][c] = min; out[3][c] = max;
    }
    S.results = rows.concat(out);
    scheduleToolRefresh('results'); scheduleMetaPersist(); refreshUi();
    openTool('results');
  }

  /**
   * Analyze > Distribution (ij.plugin.Distribution): a frequency histogram of one Results column. Automatic binning is
   * Scott's rule, "binWidth = (float)(3.49 * sd * (float)Math.pow(count, -1.0/3.0)); nBins = floor((max-min)/binWidth + .5)"
   * (at least 2); a given range keeps only the values inside it, "index = (int)(scale*(v-histMin))", the last value in the last bin.
   */
  function distributionHistogram(data, auto, nBinsIn, range) {
    const fr = Math.fround, count = data.length;
    let min = Infinity, max = -Infinity, total = 0;
    for (let i = 0; i < count; i++) { total = fr(total + data[i]); if (data[i] < min) min = data[i]; if (data[i] > max) max = data[i]; }
    const ave = fr(total / count);
    let varSum = 0;
    for (let i = 0; i < count; i++) { const d = fr(data[i] - ave); varSum = fr(varSum + fr(d * d)); }
    const variance = count > 1 ? fr(varSum / (count - 1)) : 0, sd = fr(Math.sqrt(variance));
    let nBins = nBinsIn, histMin = range ? range[0] : 0, histMax = range ? range[1] : 0;
    if (auto) {
      const binWidth = fr(3.49 * sd * fr(Math.pow(count, -1.0 / 3.0)));
      nBins = Math.floor(((max - min) / binWidth) + 0.5);
      if (!(nBins >= 2)) nBins = 2;
      histMin = 0; histMax = 0;
    }
    const fixed = histMin !== 0 || histMax !== 0;
    if (!fixed) { histMin = min; histMax = max; }
    const scale = nBins / (histMax - histMin);
    const counts = new Array(nBins).fill(0);
    for (let i = 0; i < count; i++) {
      const v = data[i];
      if (v < histMin || v > histMax) continue;
      let idx = Math.trunc(scale * (v - histMin));
      if (idx >= nBins) idx = nBins - 1;
      if (idx < 0) idx = 0;
      counts[idx]++;
    }
    const binSize = (histMax - histMin) / nBins;
    return { counts, nBins, histMin, histMax, binSize, count, mean: ave, sd, min, max };
  }

  // ij.plugin.Distribution: `static String parameter = "Area"`; else the first measurement column that is not Ch / Label.
  function distributionDefaultColumn(cols) {
    if (cols.includes('Area')) return 'Area';
    return cols.find((c) => c !== 'Ch' && c !== 'Label') || cols[0];
  }

  async function distribution() {
    const cols = resultColumns().filter((c) => c !== 'Label' && S.results.some((r) => typeof r[c] === 'number'));
    if (!S.results.length || !cols.length) return;
    const last = S.distribution || {};
    const v = await dialog({ title: tr('cmd.analyzeDistribution'), okLabel: tr('dlg.ok'),
      fields: [
        { type: 'choice', id: 'parameter', label: tr('dlg.roi.distParameter'), options: cols.map((c) => ({ value: c, label: columnHeader(c) })), value: cols.includes(last.parameter) ? last.parameter : distributionDefaultColumn(cols) },
        { type: 'message', id: 'points', value: tr('dlg.roi.distPoints', { n: S.results.length }) },
        { type: 'check', id: 'auto', labelKey: 'dlg.roi.distAuto', value: last.auto !== false },
        { type: 'number', id: 'bins', labelKey: 'dlg.roi.distBins', value: last.bins || 10, min: 1, max: 100000, integer: true, enabledIf: (x) => !x.auto },
        { type: 'string', id: 'range', labelKey: 'dlg.roi.distRange', value: last.range || '0-0', enabledIf: (x) => !x.auto }],
      validate: (x) => {
        if (x.auto) return null;
        const m = /^\s*(-?[0-9.]+(?:e-?[0-9]+)?)\s*[-,]\s*(-?[0-9.]+(?:e-?[0-9]+)?)\s*$/i.exec(String(x.range));
        return m && isFinite(Number(m[1])) && isFinite(Number(m[2])) ? null : { range: 'dlg.roi.distRangeBad' };
      } });
    if (!v) return;
    S.distribution = { parameter: v.parameter, auto: !!v.auto, bins: v.bins, range: v.range };
    const data = Float32Array.from(S.results.map((r) => (typeof r[v.parameter] === 'number' ? r[v.parameter] : 0)));
    let range = null;
    if (!v.auto) {
      const m = /^\s*(-?[0-9.]+(?:e-?[0-9]+)?)\s*[-,]\s*(-?[0-9.]+(?:e-?[0-9]+)?)\s*$/i.exec(String(v.range));
      range = m ? [Number(m[1]), Number(m[2])] : [0, 0];
    }
    const h = distributionHistogram(data, !!v.auto, Math.max(1, Math.round(Number(v.bins))), range);
    const name = columnHeader(v.parameter);
    const xs = h.counts.map((c, i) => h.histMin + i * h.binSize);
    openPlot({ title: tr('plot.distTitle', { name }), xLabel: name, yLabel: tr('hist.count'),
      series: [{ kind: 'bars', x: xs, y: h.counts, label: tr('hist.count') }],
      text: [tr('plot.distCount', { n: h.count }), tr('plot.distMean', { v: num(h.mean, 4) }), tr('plot.distSd', { v: num(h.sd, 4) }),
        tr('plot.distMin', { v: num(h.min, 4) }), tr('plot.distMax', { v: num(h.max, 4) }), tr('plot.distBins', { n: h.nBins, w: num(h.binSize, 4) })].join('\n'),
      csv: { columns: [tr('plot.distBinStart'), tr('hist.count')], rows: h.counts.map((c, i) => [num(xs[i], 6), c]) } });
  }

  /**
   * Analyze > Set Measurements: the groups, Limit to threshold, Display label and Redirect to (another image or channel
   * the statistics are read from; the same size as this image).
   */
  async function setMeasurements() {
    const info = activeInfo();
    const red = S.redirect && S.docs.has(S.redirect.docId) ? S.redirect : null;
    const fields = Object.keys(MEASURE_GROUPS).map((g) => ({ type: 'check', id: g, label: tr('meas.' + g), value: S.measurements.includes(g) }));
    const others = S.order.map((id) => S.docs.get(id)).filter(Boolean);
    if (info && others.length) {
      const same = (d) => d.width === info.width && d.height === info.height;
      fields.push({ type: 'check', id: 'redirectOn', labelKey: 'dlg.roi.redirect', value: !!red });
      fields.push({ type: 'doc', id: 'redirectDoc', labelKey: 'dlg.roi.redirectImage', filter: same, value: red ? red.docId : undefined, enabledIf: (x) => !!x.redirectOn });
      fields.push({ type: 'channel', id: 'redirectChannel', labelKey: 'dlg.roi.redirectChannel', docField: 'redirectDoc', value: red ? red.channel : 0, enabledIf: (x) => !!x.redirectOn });
    }
    const v = await dialog({ title: tr('cmd.analyzeSetMeasurements'), okLabel: tr('dlg.ok'), fields });
    if (!v) return;
    S.measurements = Object.keys(MEASURE_GROUPS).filter((g) => v[g]);
    if (!S.measurements.length) S.measurements = ['area'];
    S.redirect = v.redirectOn && v.redirectDoc !== undefined && v.redirectDoc !== '' ? { docId: v.redirectDoc, channel: Number.isInteger(v.redirectChannel) ? v.redirectChannel : 0 } : null;
    saveMeasurements();
    scheduleMetaPersist();
  }

  async function histogram() {
    const info = activeInfo();
    if (!info) return;
    const ch = activeChannel(info);
    await busy(tr('op.histogram'), async () => {
      const roi = isAreaRoi(selOf(info.docId)) ? selOf(info.docId) : null;
      const hist = await call('doc.histogram', { docId: info.docId, roi, channel: ch, bins: 256 });
      const stats = await call('doc.stats', { docId: info.docId, roi, channel: ch, measurements: ['area', 'mean', 'stdDev', 'min', 'max', 'mode'] });
      openHistogramWindow(info, ch, hist, stats.row || stats);
    });
  }

  async function plotProfile() {
    const info = activeInfo();
    const line = info && selOf(info.docId);
    if (!line || (line.type !== 'line' && line.type !== 'polyline')) return;
    await busy(tr('op.profile'), async () => {
      const res = await call('doc.profile', { docId: info.docId, line, channel: activeChannel(info) });
      openProfileWindow(info, res);
    });
  }

  async function particles() {
    const info = activeInfo();
    if (!info) return;
    const cal = info.calibration || {};
    const unit = cal.unit || 'µm';
    const pxArea = (cal.pixelWidth || 1) * (cal.pixelHeight || 1);
    const v = await dialog({ title: tr('cmd.analyzeParticles'), okLabel: tr('dlg.ok'), fields: [
      { type: 'number', id: 'minSize', label: tr('part.minSize'), value: 0, min: 0, step: 'any', units: unit + '²' },
      { type: 'number', id: 'maxSize', label: tr('part.maxSize'), value: 1e9, min: 0, step: 'any', units: unit + '²' },
      { type: 'number', id: 'minCirc', label: tr('part.minCirc'), value: 0, min: 0, max: 1, step: 0.05 },
      { type: 'number', id: 'maxCirc', label: tr('part.maxCirc'), value: 1, min: 0, max: 1, step: 0.05 },
      { type: 'check', id: 'exclude', label: tr('part.exclude'), value: false },
      { type: 'check', id: 'holes', label: tr('part.holes'), value: false },
      { type: 'check', id: 'display', label: tr('part.display'), value: true },
      { type: 'check', id: 'manager', label: tr('part.manager'), value: false },
      { type: 'check', id: 'summarize', label: tr('part.summarize'), value: true }] });
    if (!v) return;
    let summary = null;
    await busy(tr('op.particles'), async () => {
      const opts = { minSize: Math.max(0, Number(v.minSize)) / pxArea, maxSize: Math.max(0, Number(v.maxSize)) / pxArea,
        minCirc: Number(v.minCirc), maxCirc: Number(v.maxCirc), excludeEdges: !!v.exclude, includeHoles: !!v.holes,
        roi: isAreaRoi(selOf(info.docId)) ? selOf(info.docId) : null };
      const res = await call('doc.particles', { docId: info.docId, channel: activeChannel(info), opts, keys: measuredKeys(null), redirect: measureOptions(info, activeChannel(info)).redirect });
      // The particle's own columns, then the image measurements Set Measurements ticked.
      const wanted = new Set(measuredKeys(null));
      const rowsOut = (res.rows || []).map((p) => {
        const r = {};
        if ((info.channels || []).length > 1) r.Ch = activeChannel(info) + 1;
        for (const [key, col] of PARTICLE_COLUMNS) if (p[key] !== undefined) r[col] = p[key];
        for (const key of PARTICLE_MEASURE_KEYS) {
          if (!wanted.has(key) || p[key] === undefined) continue;
          const col = COLUMNS.find((c) => c[0] === key)[1];
          if (r[col] === undefined) r[col] = p[key];
        }
        return r;
      });
      if (v.display) appendResults(rowsOut);
      if (v.manager) {
        // traced: a particle outline is a pixel-edge polygon, so its perimeter is the traced one
        // (ImageJ's Wand ROI), the same number the particle row reports.
        (res.outlines || []).forEach((pts) => S.roiList.push({ name: roiName({ type: 'polygon', points: pts }), docId: info.docId, roi: { type: 'polygon', points: pts, traced: true } }));
        refreshRois(); scheduleToolRefresh('rois');
      }
      scheduleMetaPersist();
      if (v.display) openTool('results');
      if (v.manager) openTool('roiManager');
      if (v.summarize && res.summary) summary = res.summary;
    });
    // ImageJ shows a "Summary" table window, one row per run: never a modal that holds the busy state.
    if (summary) {
      S.summaryRows.push({ Image: info.name, Count: summary.count, 'Total Area': summary.totalArea, 'Average Size': summary.averageSize, '%Area': summary.percentArea });
      openTool('summary');
      scheduleToolRefresh('summary');
    }
  }

  function roiName(roi) {
    let b = { x: 0, y: 0, w: 0, h: 0 };
    if (typeof IJRoi !== 'undefined') { try { b = IJRoi.bounds(roi); } catch (_) { /* unnamed position */ } }
    return pad4(b.y + b.h / 2) + '-' + pad4(b.x + b.w / 2);
  }
  function addToManager() {
    const info = activeInfo();
    const roi = info && selOf(info.docId);
    if (!roi) return;
    S.roiList.push({ name: roiName(roi), docId: info.docId, roi });
    refreshRois(); scheduleToolRefresh('rois'); scheduleMetaPersist();
  }

  function cycleImage(dir) {
    if (S.order.length < 2) return;
    const i = S.order.indexOf(S.activeId);
    const next = S.order[(i + dir + S.order.length) % S.order.length];
    showDoc(next);
  }

  function simpleView() { S.leaving = 'simple'; return S.api.exit(); }
  function closeStudio() { return S.api.close(); }

  // ───────────────────────────── tool windows ─────────────────────────────

  const TOOL_WINDOWS = { bc: buildBC, channels: buildChannels, threshold: buildThreshold, results: buildResults, roiManager: buildRoiManager, summary: buildSummary };

  function floatingWindow(id, titleKey, build) {
    if (!S.shell) return null;
    const existing = S.wins.get(id);
    if (existing) { existing.focus(); const u = S.winUpdaters.get(id); S.lastToolReady = Promise.resolve(u ? u('doc') : undefined); return existing; }
    const view = build();
    const win = S.shell.windows.floating({ id, title: tr(titleKey), content: view.el, onClose: () => {
      S.wins.delete(id); S.winUpdaters.delete(id);
      if (view.dispose) view.dispose();
      scheduleMetaPersist();
    } });
    S.wins.set(id, win);
    S.lastToolReady = Promise.resolve(view.update ? view.update('doc') : undefined);
    if (view.update) S.winUpdaters.set(id, view.update);
    scheduleMetaPersist();
    return win;
  }

  function openTool(id) {
    const titles = { bc: 'cmd.adjustBC', channels: 'cmd.colorChannels', threshold: 'cmd.adjustThreshold', results: 'win.results', roiManager: 'cmd.toolsRoiManager', summary: 'part.summaryTitle' };
    if ((id === 'bc' || id === 'channels' || id === 'threshold') && !activeInfo()) return;
    floatingWindow(id, titles[id], TOOL_WINDOWS[id]);
  }

  let toolTimer = 0;
  function scheduleToolRefresh(kind) {
    clearTimeout(toolTimer);
    const pending = scheduleToolRefresh.kinds || (scheduleToolRefresh.kinds = new Set());
    pending.add(kind);
    toolTimer = setTimeout(() => {
      const kinds = Array.from(pending); pending.clear();
      for (const [, update] of S.winUpdaters) for (const k of kinds) { try { update(k); } catch (err) { console.error('[advanced-studio] tool update', err); } }
    }, 60);
  }

  // Histogram drawing shared by B&C, Threshold and the Histogram window.
  function drawHist(canvas, hist, opts) {
    const g = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;
    g.clearRect(0, 0, W, H);
    const cs = getComputedStyle(canvas);
    g.fillStyle = cs.getPropertyValue('--text-secondary').trim() || '#888';
    if (!hist || !hist.counts) return;
    const counts = hist.counts;
    let max = 0, second = 0;
    for (let i = 0; i < counts.length; i++) { const c = counts[i]; if (c > max) { second = max; max = c; } else if (c > second) second = c; }
    const hmax = max > second * 2 && second > 0 ? second * 1.5 : max;
    const n = counts.length;
    for (let i = 0; i < n; i++) {
      const x = Math.floor((i * W) / n), x2 = Math.max(x + 1, Math.floor(((i + 1) * W) / n));
      const hh = hmax > 0 ? Math.min(H, Math.round((counts[i] / hmax) * (H - 2))) : 0;
      g.fillRect(x, H - hh, x2 - x, hh);
    }
    if (opts && opts.lines) {
      g.strokeStyle = cs.getPropertyValue('--color-accent').trim() || '#0cf';
      g.lineWidth = 1;
      for (const v of opts.lines) {
        const x = clamp(((v - hist.min) / (hist.max - hist.min || 1)) * W, 0, W - 1) + 0.5;
        g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke();
      }
    }
    if (opts && opts.band) {
      g.fillStyle = 'rgba(255,0,0,0.25)';
      const x1 = clamp(((opts.band[0] - hist.min) / (hist.max - hist.min || 1)) * W, 0, W);
      const x2 = clamp(((opts.band[1] - hist.min) / (hist.max - hist.min || 1)) * W, 0, W);
      g.fillRect(x1, 0, Math.max(1, x2 - x1), H);
    }
  }
  function lutStrip(canvas, info, ch) {
    const g = canvas.getContext('2d');
    const c = lutOf(info, ch);
    let table = null;
    try {
      if (typeof IJLuts !== 'undefined' && c) {
        const name = typeof c.lut === 'string' ? c.lut : '';
        table = LUT_NAMES.includes(name) ? IJLuts.get(name) : IJLuts.fromColor(name || c.color || '#ffffff');
      }
    } catch (_) { table = null; }
    for (let i = 0; i < 256; i++) {
      const k = c && c.invert ? 255 - i : i;
      g.fillStyle = table ? 'rgb(' + table[k * 3] + ',' + table[k * 3 + 1] + ',' + table[k * 3 + 2] + ')' : 'rgb(' + k + ',' + k + ',' + k + ')';
      g.fillRect(Math.floor((i * canvas.width) / 256), 0, Math.ceil(canvas.width / 256), canvas.height);
    }
  }

  function slider(min, max, step, value, onInput, cls) {
    return h('input', { type: 'range', class: 'ij-slider' + (cls ? ' ' + cls : ''), min, max, step, value, on: { input: (e) => onInput(Number(e.target.value)) } });
  }
  function labelled(text, control) { return h('label', { class: 'ij-field' }, h('span', { class: 'ij-field-label', text }), control); }
  function check(text, checked, onChange) {
    return h('label', { class: 'ij-check' }, h('input', { type: 'checkbox', checked: !!checked, on: { change: (e) => onChange(e.target.checked) } }), h('span', { text }));
  }
  function selectEl(options, value, onChange) {
    const sel = h('select', { on: { change: (e) => onChange(e.target.value) } }, options.map((o) => h('option', { value: o.value, text: o.label })));
    sel.value = String(value);
    return sel;
  }

  // ── Brightness / Contrast

  function buildBC() {
    const canvas = h('canvas', { class: 'ij-hist', width: 256, height: 80 });
    const lut = h('canvas', { class: 'ij-lutstrip', width: 256, height: 8 });
    const readout = h('div', { class: 'ij-readout' });
    let hist = null, def = { min: 0, max: 255 }, autoThr = 0, token = 0;
    const R = bcMath.range;

    const cur = () => { const i = activeInfo(); return i ? lutOf(i, activeChannel(i)) : null; };
    const minS = slider(0, R, 1, 0, (p) => setRange(posToValue(p), null));
    const maxS = slider(0, R, 1, R, (p) => setRange(null, posToValue(p)));
    const briS = slider(0, R, 1, R / 2, (p) => { const c = cur(); if (!c) return; const r = bcMath.fromBrightness(p, c.min, c.max, def.min, def.max); setRange(r.min, r.max, 'b'); });
    const conS = slider(0, R, 1, R / 2, (p) => { const c = cur(); if (!c) return; const r = bcMath.fromContrast(p, c.min, c.max, def.min, def.max); setRange(r.min, r.max, 'c'); });
    const posToValue = (p) => def.min + (p / R) * (def.max - def.min);
    const valueToPos = (v) => clamp(((v - def.min) / (def.max - def.min || 1)) * R, 0, R);

    function setRange(min, max, source) {
      const info = activeInfo(), c = cur();
      if (!info || !c) return;
      let lo = min === null ? c.min : min, hi = max === null ? c.max : max;
      if (info.bitDepth === 8 || info.bitDepth === 16) { lo = Math.round(lo); hi = Math.round(hi); }
      if (min !== null && lo > hi) hi = lo;
      if (max !== null && hi < lo) lo = hi;
      setChannelDisplay(info.docId, activeChannel(info), { min: lo, max: hi });
      sync(source);
    }
    function sync(skip) {
      const c = cur();
      if (!c) return;
      if (skip !== 'min') minS.value = valueToPos(c.min);
      maxS.value = valueToPos(c.max);
      if (skip !== 'b') briS.value = bcMath.brightnessToPos(c.min, c.max, def.min, def.max);
      if (skip !== 'c') conS.value = bcMath.contrastToPos(c.min, c.max, def.min, def.max);
      readout.textContent = num(c.min) + ' – ' + num(c.max);
      drawHist(canvas, hist, { lines: [c.min, c.max] });
      const info = activeInfo(); if (info) lutStrip(lut, info, activeChannel(info));
    }
    async function refresh() {
      const info = activeInfo();
      if (!info) return;
      const my = ++token;
      try {
        const hh = await call('doc.histogram', { docId: info.docId, roi: null, channel: activeChannel(info), bins: 256 });
        if (my !== token) return;
        hist = hh;
        def = info.bitDepth === 8 ? { min: 0, max: 255 } : { min: hh.min, max: hh.max };
        if (def.max <= def.min) def.max = def.min + 1;
      } catch (err) { console.error('[advanced-studio] histogram', err); }
      sync();
    }
    async function auto() {
      const info = activeInfo(), c = cur();
      if (!info || !c || !hist || typeof IJOps === 'undefined') return;
      // IJOps.autoContrast takes the previous click's threshold (0 on the first) and does
      // ImageJ's halving itself; it reads the bin counts, mapped back through min/binWidth.
      let count = 0; for (let i = 0; i < hist.counts.length; i++) count += hist.counts[i];
      const r = IJOps.autoContrast(hist.counts, count, autoThr, { histMin: hist.min, binWidth: hist.binWidth || 1, dataMin: hist.min, dataMax: hist.max });
      if (r && Number.isFinite(r.min) && Number.isFinite(r.max)) { autoThr = r.nextAutoThreshold; setRange(r.min, r.max); }
    }
    async function setDialog() {
      const c = cur();
      if (!c) return;
      const v = await dialog({ title: tr('bc.set'), okLabel: tr('dlg.ok'), fields: [
        { type: 'number', id: 'min', label: tr('bc.min'), value: c.min, step: 'any' }, { type: 'number', id: 'max', label: tr('bc.max'), value: c.max, step: 'any' }] });
      if (v) setRange(Number(v.min), Number(v.max));
    }
    const el = h('div', { class: 'ij-panel ij-bc' }, canvas, lut, readout,
      labelled(tr('bc.min'), minS), labelled(tr('bc.max'), maxS), labelled(tr('bc.brightness'), briS), labelled(tr('bc.contrast'), conS),
      row(btn(tr('bc.auto'), auto), btn(tr('bc.reset'), () => { autoThr = 0; setRange(def.min, def.max); }), btn(tr('bc.setBtn'), setDialog), btn(tr('bc.apply'), () => applyLut())));
    return { el, update(kind) { if (kind === 'display') sync(); else if (kind === 'doc' || kind === 'pixels') refresh(); } };
  }

  // ── Channels

  function buildChannels() {
    const body = h('div', { class: 'ij-panel ij-channels' });
    function render() {
      body.textContent = '';
      const info = activeInfo();
      if (!info) return;
      const d = S.dstate.get(info.docId);
      const act = activeChannel(info);
      body.appendChild(labelled(tr('chan.mode'), selectEl([
        { value: 'composite', label: tr('chan.composite') }, { value: 'color', label: tr('chan.color') }, { value: 'gray', label: tr('chan.grayscale') }],
      d.mode, (m) => { setDocDisplayMode(info.docId, { mode: m }); })));
      (info.channels || []).forEach((c, i) => {
        body.appendChild(row(
          h('input', { type: 'radio', name: 'ij-active-channel', checked: i === act, attrs: { 'aria-label': tr('chan.active') }, on: { change: () => { setDocDisplayMode(info.docId, { active: i }); } } }),
          check(c.name || ('C' + (i + 1)), d.visible[i] !== false, (on) => { const vis = d.visible.slice(); vis[i] = on; setDocDisplayMode(info.docId, { visible: vis }); }),
          selectEl(LUT_NAMES.map((n) => ({ value: n, label: n })).concat([{ value: '', label: '—' }]), typeof d.channels[i].lut === 'string' && LUT_NAMES.includes(d.channels[i].lut) ? d.channels[i].lut : '',
            (n) => { if (n) setChannelDisplay(info.docId, i, { lut: n }); })));
      });
    }
    return { el: body, update(kind) { if (kind === 'doc' || kind === 'display') render(); } };
  }

  // ── Threshold

  function buildThreshold() {
    const T = { method: 'Default', dark: S.thrDark !== false, mode: 'red', lower: 0, upper: 255 };
    const canvas = h('canvas', { class: 'ij-hist', width: 256, height: 80 });
    const readout = h('div', { class: 'ij-readout' });
    let hist = null, token = 0;
    const R = 255;
    const toValue = (p) => (hist ? hist.min + (p / R) * (hist.max - hist.min) : p);
    const toPos = (v) => (hist ? clamp(((v - hist.min) / (hist.max - hist.min || 1)) * R, 0, R) : v);
    const loS = slider(0, R, 1, 0, (p) => { T.lower = toValue(p); if (T.lower > T.upper) T.upper = T.lower; commit(); });
    const hiS = slider(0, R, 1, R, (p) => { T.upper = toValue(p); if (T.upper < T.lower) T.lower = T.upper; commit(); });
    function commit() {
      const info = activeInfo();
      loS.value = toPos(T.lower); hiS.value = toPos(T.upper);
      readout.textContent = num(T.lower) + ' – ' + num(T.upper);
      drawHist(canvas, hist, { band: [T.lower, T.upper] });
      if (info && S.display && S.display.setThresholdOverlay) S.display.setThresholdOverlay({ channel: activeChannel(info), lower: T.lower, upper: T.upper, mode: T.mode });
      // What api.state().threshold reads: the window's current range, on the image and channel it was made for.
      S.threshold = info ? { docId: info.docId, channel: activeChannel(info), lower: T.lower, upper: T.upper, dark: T.dark } : null;
    }
    async function auto() {
      const info = activeInfo();
      if (!info) return;
      try {
        const roi = isAreaRoi(selOf(info.docId)) ? selOf(info.docId) : null;
        const r = await call('doc.threshold', { docId: info.docId, channel: activeChannel(info), method: T.method, dark: T.dark, roi });
        T.lower = r.lower; T.upper = r.upper; commit();
      } catch (err) { reportError(err); }
    }
    async function refresh(autoToo) {
      const info = activeInfo();
      if (!info) return;
      const my = ++token;
      try {
        const hh = await call('doc.histogram', { docId: info.docId, roi: null, channel: activeChannel(info), bins: 256 });
        if (my !== token) return;
        hist = hh;
      } catch (err) { console.error('[advanced-studio] histogram', err); }
      if (autoToo) await auto(); else commit();
    }
    async function apply() {
      const info = activeInfo();
      if (!info) return;
      await runOp('toMask', { lower: T.lower, upper: T.upper }, { noRoi: true });
    }
    function reset() {
      S.threshold = null;
      if (S.display && S.display.setThresholdOverlay) S.display.setThresholdOverlay(null);
      if (hist) { T.lower = hist.min; T.upper = hist.max; }
      loS.value = 0; hiS.value = R;
      readout.textContent = '';
      drawHist(canvas, hist, {});
    }
    async function setDialog() {
      const v = await dialog({ title: tr('thr.set'), okLabel: tr('dlg.ok'), fields: [
        { type: 'number', id: 'lower', label: tr('thr.lower'), value: T.lower, step: 'any' }, { type: 'number', id: 'upper', label: tr('thr.upper'), value: T.upper, step: 'any' }] });
      if (v) { T.lower = Number(v.lower); T.upper = Math.max(T.lower, Number(v.upper)); commit(); }
    }
    const el = h('div', { class: 'ij-panel ij-threshold' }, canvas, readout, labelled(tr('thr.lower'), loS), labelled(tr('thr.upper'), hiS),
      row(selectEl(IJThresholdMethods().map((m) => ({ value: m, label: m })), T.method, (m) => { T.method = m; auto(); }),
        selectEl([{ value: 'red', label: tr('thr.red') }, { value: 'bw', label: tr('thr.bw') }, { value: 'overunder', label: tr('thr.overUnder') }], T.mode, (m) => { T.mode = m; commit(); })),
      check(tr('thr.dark'), T.dark, (on) => { T.dark = on; S.thrDark = on; auto(); }),
      row(btn(tr('thr.auto'), auto), btn(tr('thr.apply'), apply, 'ij-btn--primary'), btn(tr('thr.reset'), reset), btn(tr('thr.setBtn'), setDialog)));
    // Opening the window thresholds with the default method at once, like ImageJ.
    let first = true;
    return {
      el,
      // 'doc' answers a promise that settles once the first automatic threshold is in S.threshold.
      update(kind) { if (kind === 'doc' || kind === 'pixels') { const p = refresh(first); first = false; return p; } else if (kind === 'display') commit(); return undefined; },
      dispose() { S.threshold = null; if (S.display && S.display.setThresholdOverlay) S.display.setThresholdOverlay(null); }
    };
  }
  function IJThresholdMethods() {
    return typeof IJThreshold !== 'undefined' && IJThreshold.methods ? IJThreshold.methods() : ['Default', 'Huang', 'IsoData', 'Li', 'MaxEntropy', 'Mean', 'Otsu', 'Triangle'];
  }

  // ── Results

  const RESULTS_CAP = 20000;
  function buildResults() {
    const table = h('table', { class: 'ij-table' });
    const note = h('p', { class: 'ij-banner' });
    note.hidden = true;
    const wrap = h('div', { class: 'ij-table-wrap' }, table);
    let shown = 0, shownCols = '', tbody = null, firstRef = null;
    const cell = (r, c) => h('td', { text: r[c] === undefined ? '' : (typeof r[c] === 'number' ? num(r[c], 4) : String(r[c])) });
    // Only the rows added since the last refresh are built; a full rebuild happens when the
    // columns change or the table was cleared / replaced.
    function render() {
      const cols = resultColumns();
      const sig = cols.join('\u0001');
      if (sig !== shownCols || S.results.length < shown || (firstRef !== null && S.results[0] !== firstRef)) {
        table.textContent = '';
        table.appendChild(h('thead', null, h('tr', null, [h('th', { text: ' ' })].concat(cols.map((c) => h('th', { text: columnHeader(c) }))))));
        tbody = h('tbody');
        table.appendChild(tbody);
        shown = 0; shownCols = sig;
      }
      firstRef = S.results.length ? S.results[0] : null;
      const cap = Math.min(S.results.length, RESULTS_CAP);
      const frag = document.createDocumentFragment ? document.createDocumentFragment() : tbody;
      for (let i = shown; i < cap; i++) {
        const r = S.results[i];
        frag.appendChild(h('tr', null, [h('td', { text: String(i + 1) })].concat(cols.map((c) => cell(r, c)))));
      }
      if (frag !== tbody) tbody.appendChild(frag);
      shown = Math.max(shown, cap);
      note.hidden = S.results.length <= RESULTS_CAP;
      note.textContent = note.hidden ? '' : tr('res.capped', { shown: RESULTS_CAP, total: S.results.length });
      wrap.scrollTop = wrap.scrollHeight;
    }
    const el = h('div', { class: 'ij-panel ij-results' }, wrap, note,
      row(btn(tr('res.copy'), async () => { try { await navigator.clipboard.writeText(resultsText('\t')); setStatus(tr('status.copied')); } catch (err) { console.error(err); setStatus(tr('err.clipboard'), 'error'); } }),
        btn(tr('res.save'), () => saveResults()), btn(tr('res.clear'), () => clearResults())));
    return { el, update(kind) { if (kind === 'results' || kind === 'doc') render(); } };
  }

  // ── Particle Summary (one row per Analyze Particles run, like ImageJ's Summary window)

  function buildSummary() {
    const table = h('table', { class: 'ij-table' });
    function render() {
      table.textContent = '';
      table.appendChild(h('thead', null, h('tr', null, SUMMARY_COLUMNS.map((c) => h('th', { text: c })))));
      const tb = h('tbody');
      for (const r of S.summaryRows) tb.appendChild(h('tr', null, SUMMARY_COLUMNS.map((c) => h('td', { text: typeof r[c] === 'number' ? num(r[c], 4) : String(r[c] === undefined ? '' : r[c]) }))));
      table.appendChild(tb);
    }
    const el = h('div', { class: 'ij-panel ij-summary' }, h('div', { class: 'ij-table-wrap' }, table),
      row(btn(tr('res.clear'), () => { S.summaryRows = []; render(); })));
    return { el, update(kind) { if (kind === 'summary' || kind === 'doc') render(); } };
  }

  /**
   * ROI Manager › Multi Measure (RoiManager.multiMeasure): every selection of the list on every channel. "One row per
   * channel": a row per channel whose columns are the measurements of each selection, "head + suffix" with the suffix the
   * selection's number (or "(name)" for a named one); otherwise a row per selection and channel. The table replaces Results
   * unless "Append results" is ticked.
   */
  async function multiMeasure(list) {
    const info = activeInfo();
    if (!info || !list.length) return;
    const nCh = (info.channels || []).length;
    const v = await dialog({ title: tr('roi.multiMeasure'), okLabel: tr('dlg.ok'), fields: [
      ...(nCh > 1 ? [{ type: 'check', id: 'all', label: tr('roi.measureAllChannels', { n: nCh }), value: true }] : []),
      { type: 'check', id: 'oneRow', label: tr('roi.oneRowPerChannel'), value: true },
      { type: 'check', id: 'append', label: tr('roi.appendResults'), value: false },
      { type: 'message', id: 'note', value: tr('roi.multiNote') }] });
    if (!v) return;
    const channels = v.all === false || nCh <= 1 ? [activeChannel(info)] : info.channels.map((c, i) => i);
    await busy(tr('op.measure'), async () => {
      const out = [];
      for (const ch of channels) {
        const row = {};
        if (S.measurements.includes('labels')) row.Label = info.name;
        if (nCh > 1 && v.oneRow) row.Ch = ch + 1;
        let n = 0;
        for (const item of list) {
          n++;
          const rows = await measureRows(info, item.roi, ch);
          if (!v.oneRow) { for (const r of rows) out.push(r); continue; }
          const name = item.name && item.name.length > 0 && (item.name.length < 9 || !/^[0-9]/.test(item.name)) ? '(' + item.name + ')' : String(n);
          const r0 = rows[0] || {};
          for (const k of Object.keys(r0)) if (k !== 'Label' && k !== 'Ch') row[k + name] = r0[k];
        }
        if (v.oneRow) out.push(row);
      }
      if (v.append) appendResults(out); else { S.results = out; scheduleToolRefresh('results'); scheduleMetaPersist(); refreshUi(); }
    });
    openTool('results');
  }

  // ── ROI Manager

  // owner: P6 (wave 2)
  function buildRoiManager() {
    const list = h('div', { class: 'ij-list', attrs: { role: 'listbox' } });
    function curList() { const i = activeInfo(); return i ? S.roiList.filter((r) => r.docId === i.docId) : []; }
    function render() {
      list.textContent = '';
      for (const item of curList()) {
        const li = h('div', { class: 'ij-list-item' + (S.roiSelected.has(item) ? ' is-selected' : ''), attrs: { role: 'option', tabindex: '0' }, text: item.name, on: {
          click: (e) => { if (!e.ctrlKey && !e.metaKey && !e.shiftKey) S.roiSelected.clear(); if (S.roiSelected.has(item)) S.roiSelected.delete(item); else S.roiSelected.add(item); const i = activeInfo(); if (i) setSelection(i.docId, item.roi, true); render(); refreshRois(); },
          dblclick: () => rename(item, li) } });
        list.appendChild(li);
      }
    }
    function rename(item, li) {
      const input = h('input', { type: 'text', class: 'ij-rename', value: item.name });
      li.textContent = ''; li.appendChild(input); input.focus(); input.select();
      // Removing the focused input fires blur, which would re-enter done(true) after an Escape.
      let finished = false;
      const done = (ok) => { if (finished) return; finished = true; if (ok && input.value.trim()) item.name = input.value.trim(); render(); scheduleMetaPersist(); };
      input.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') done(true); else if (e.key === 'Escape') done(false); });
      input.addEventListener('blur', () => done(true));
    }
    const targets = () => { const l = curList(); const sel = l.filter((r) => S.roiSelected.has(r)); return sel.length ? sel : l; };
    const el = h('div', { class: 'ij-panel ij-roimanager' }, list,
      row(btn(tr('roi.add'), () => addToManager()), btn(tr('roi.delete'), () => { const t = targets(); S.roiList = S.roiList.filter((r) => !t.includes(r)); t.forEach((r) => S.roiSelected.delete(r)); render(); refreshRois(); scheduleMetaPersist(); })),
      row(btn(tr('roi.measure'), async () => {
        const info = activeInfo(); if (!info) return;
        await busy(tr('op.measure'), async () => {
          const rows = [];
          for (const r of targets()) for (const row of await measureRows(info, r.roi, activeChannel(info))) rows.push(row);
          appendResults(rows);
        });
        openTool('results');
      }), btn(tr('roi.multiMeasure'), () => multiMeasure(targets())), check(tr('roi.showAll'), S.showAll, (on) => { S.showAll = on; refreshRois(); })));
    return { el, update(kind) { if (kind === 'rois' || kind === 'doc') render(); } };
  }

  // ── static result windows (Histogram, Plot Profile, Show Info, Help)

  function openStaticWindow(idPrefix, title, content) {
    if (!S.shell) return;
    const id = idPrefix + '-' + (++S.openCounter);
    S.shell.windows.floating({ id, title, content });
  }

  // ── the generic windows of the extension API ────────────────────────────────────────────────────

  function plotTheme(canvas) {
    const cs = typeof getComputedStyle === 'function' ? getComputedStyle(canvas) : null;
    const v = (name, fb) => (cs && cs.getPropertyValue(name).trim()) || fb;
    return { fg: v('--text-primary', '#ccc'), grid: 'rgba(128,128,128,0.35)', bg: '' };
  }

  function tableText(columns, rows, sep) {
    const q = (v) => {
      const t = v === undefined || v === null ? '' : String(v);
      return sep === ',' && /[",\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
    };
    return [columns.map(q).join(sep)].concat(rows.map((r) => Array.from(r, q).join(sep))).join('\n') + '\n';
  }

  /** A plot window: spec of IJPlot (ij-view.js) + optional `text` (a note under the plot). → the window | null. */
  function openPlot(spec) {
    if (!S.shell || !spec || typeof IJPlot === 'undefined') return null;
    const canvas = h('canvas', { class: 'ij-plot', width: 360, height: 220 });
    const wrap = h('div', { class: 'ij-plot-wrap' }, canvas);
    let observer = null, drawn = false;
    const redraw = () => {
      const dpr = typeof window !== 'undefined' && window.devicePixelRatio ? Math.max(1, Math.min(3, window.devicePixelRatio)) : 1;
      const w = Math.max(160, wrap.clientWidth || 360), hh = Math.max(120, wrap.clientHeight || 220);
      canvas.width = Math.round(w * dpr); canvas.height = Math.round(hh * dpr);
      canvas.style.width = w + 'px'; canvas.style.height = hh + 'px';
      try {
        IJPlot.draw(canvas, spec, Object.assign(plotTheme(canvas), { dpr, lut: (name) => { try { return IJLuts.get(name); } catch (_) { return null; } } }));
        drawn = true;
      } catch (err) { console.error('[advanced-studio] plot', err); }
    };
    const csv = () => IJPlot.csvText(spec);
    const title = spec.title ? String(spec.title) : tr('plot.title');
    const buttons = row(
      btn(tr('hist.list'), () => openListWindow(title, csv().replace(/,/g, '\t'))),
      btn(tr('res.copy'), () => copyText(csv().replace(/,/g, '\t'))),
      btn(tr('plot.saveCsv'), async () => { try { await saveFile(safeName(title, '.csv'), 'text/csv', '.csv', 'CSV', async () => new Blob([csv()], { type: 'text/csv' })); } catch (err) { await reportError(err); } }),
      btn(tr('plot.savePng'), async () => {
        try {
          await saveFile(safeName(title, '.png'), 'image/png', '.png', 'PNG', async () => new Promise((resolve, reject) =>
            canvas.toBlob((b) => (b ? resolve(b) : reject(Object.assign(new Error('png'), { code: 'IJ_PNG_FAILED' }))), 'image/png')));
        } catch (err) { await reportError(err); }
      }));
    const content = h('div', { class: 'ij-panel ij-plotwin' }, wrap, spec.text ? h('pre', { class: 'ij-info-pre', text: String(spec.text) }) : null, buttons);
    const id = 'plot-' + (++S.openCounter);
    const win = S.shell.windows.floating({ id, title, content, onClose: () => { if (observer) { try { observer.disconnect(); } catch (_) { /* gone */ } } } });
    if (typeof ResizeObserver !== 'undefined') { observer = new ResizeObserver(() => { if (drawn) redraw(); }); observer.observe(wrap); }
    requestAnimationFrame(redraw);
    return win;
  }

  /** A table window: Copy (tab separated) and Save (CSV). Not kept across a reload. columns = [header], rows = [[value]] | [{ header: value }]. */
  function openTable(name, columns, rows) {
    if (!S.shell || !Array.isArray(columns)) return null;
    const cols = columns.map(String);
    const data = (rows || []).map((r) => (Array.isArray(r) ? r : cols.map((c) => r && r[c])));
    const table = h('table', { class: 'ij-table' });
    table.appendChild(h('thead', null, h('tr', null, cols.map((c) => h('th', { text: c })))));
    const body = h('tbody');
    const cap = Math.min(data.length, RESULTS_CAP);
    for (let i = 0; i < cap; i++) body.appendChild(h('tr', null, data[i].map((v) => h('td', { text: typeof v === 'number' ? num(v, 4) : (v === undefined || v === null ? '' : String(v)) }))));
    table.appendChild(body);
    const title = String(name || tr('table.title'));
    const content = h('div', { class: 'ij-panel ij-tablewin' }, h('div', { class: 'ij-table-wrap' }, table),
      data.length > cap ? h('p', { class: 'ij-banner', text: tr('res.capped', { shown: cap, total: data.length }) }) : null,
      row(btn(tr('res.copy'), () => copyText(tableText(cols, data, '\t'))),
        btn(tr('res.save'), async () => { try { await saveFile(safeName(title, '.csv'), 'text/csv', '.csv', 'CSV', async () => new Blob([tableText(cols, data, ',')], { type: 'text/csv' })); } catch (err) { await reportError(err); } })));
    return S.shell.windows.floating({ id: 'table-' + (++S.openCounter), title, content });
  }

  function openHistogramWindow(info, ch, hist, stats) {
    const counts = Array.from(hist.counts);
    const xs = counts.map((c, i) => hist.min + i * hist.binWidth);
    const text = ['area', 'mean', 'stdDev', 'min', 'max', 'mode'].filter((k) => stats[k] !== undefined).map((k) => tr('meas.' + k) + ': ' + num(stats[k], 4)).join('\n')
      + '\n' + tr('hist.binWidth') + ': ' + num(hist.binWidth, 4);
    openPlot({ title: tr('cmd.analyzeHistogram') + ' — ' + info.name, xLabel: tr('hist.value'), yLabel: tr('hist.count'),
      series: [{ kind: 'bars', x: xs, y: counts, label: tr('hist.count') }], text,
      csv: { columns: [tr('hist.value'), tr('hist.count')], rows: counts.map((c, i) => [num(xs[i], 4), c]) } });
  }

  function openProfileWindow(info, res) {
    const values = Array.from(res.values || []);
    const unit = (info.calibration && info.calibration.unit) || 'px';
    const step = res.stepUm || 1;
    const xs = values.map((v, i) => i * step);
    const dist = tr('plot.distance') + ' (' + unit + ')';
    openPlot({ title: tr('cmd.analyzePlotProfile') + ' — ' + info.name, xLabel: dist, yLabel: tr('plot.value'),
      series: [{ kind: 'line', x: xs, y: values, label: tr('plot.value') }],
      csv: { columns: [dist, tr('plot.value')], rows: values.map((v, i) => [num(xs[i], 5), v]) } });
  }

  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); setStatus(tr('status.copied')); }
    catch (err) { console.error('[advanced-studio] clipboard', err); setStatus(tr('err.clipboard'), 'error'); }
  }
  function openListWindow(title, text) {
    openStaticWindow('list', title, h('div', { class: 'ij-panel' }, h('pre', { class: 'ij-info-pre', text })));
  }

  function showInfo() {
    const info = activeInfo();
    if (!info) return;
    const cal = info.calibration || {};
    const src = S.sources.get(info.docId);
    const lines = [info.name, '',
      tr('info.size', { w: info.width, h: info.height }),
      tr('info.depth', { bits: info.bitDepth }),
      tr('info.channels', { n: (info.channels || []).length }),
      tr('info.pixel', { w: num(cal.pixelWidth || 1, 5), h: num(cal.pixelHeight || 1, 5), unit: cal.unit || 'px' })];
    (info.channels || []).forEach((c, i) => { const d = lutOf(info, i) || {}; lines.push(tr('info.channel', { n: i + 1, name: c.name || '', min: num(d.min), max: num(d.max), lut: typeof d.lut === 'string' ? d.lut : (c.color || '') })); });
    if (src) {
      lines.push('', tr('info.source', { dataset: src.datasetName || src.datasetId, level: src.level, axis: String(src.axis).toUpperCase(), a: src.first, b: src.last, method: tr('proj.' + src.method) }));
      if (src.timepoint !== null && src.timepoint !== undefined) lines.push(tr('info.timepoint', { t: src.timepoint }));
    }
    lines.push('', tr('info.lossless'), tr('info.undo', { budget: mb(S.budgetBytes) }));
    openStaticWindow('info', tr('cmd.imageInfo'), h('div', { class: 'ij-panel' }, h('pre', { class: 'ij-info-pre', text: lines.join('\n') })));
  }

  function showAbout() {
    const para = (k) => h('p', { text: tr(k) });
    const families = ['about.famDisplay', 'about.famSelect', 'about.famBackground', 'about.famFilters', 'about.famBinary', 'about.famMulti', 'about.famGeometry', 'about.famMeasure', 'about.famColoc']
      .map((k) => h('li', { text: tr(k) }));
    openStaticWindow('about', tr('cmd.helpAbout'), h('div', { class: 'ij-panel ij-about' }, [
      para('about.intro'), para('about.source'), para('about.depth'),
      h('h4', { text: tr('about.familiesTitle') }), h('ul', null, families),
      h('h4', { text: tr('about.missingTitle') }), para('about.missing'),
      para('about.deviations'), para('about.storage'), para('about.tables')
    ]));
  }

  function showShortcuts() {
    const rows = COMMANDS.filter((c) => c.shortcut).map((c) => h('tr', null, h('td', { text: tr(c.labelKey) }), h('td', { class: 'ij-menu-shortcut', text: (c.keys || [c.shortcut]).join(', ') })));
    rows.push(h('tr', null, h('td', { text: tr('help.space') }), h('td', { class: 'ij-menu-shortcut', text: 'Space' })));
    rows.push(h('tr', null, h('td', { text: tr('help.escape') }), h('td', { class: 'ij-menu-shortcut', text: 'Esc' })));
    openStaticWindow('shortcuts', tr('cmd.helpShortcuts'), h('div', { class: 'ij-panel' }, h('table', { class: 'ij-table' }, h('tbody', null, rows))));
  }

  // ───────────────────────────── shell wiring, keyboard ─────────────────────────────

  /** The command list the shell reads: the registry (shortcuts = every key), then one entry per open image. */
  function buildMenuList() {
    const list = COMMANDS.map((c) => Object.assign({}, c, {
      shortcut: c.keys.length ? c.keys.slice() : null,
      // a package that did not load: its commands stay in the menus, greyed, with a tooltip
      unavailable: c.pkg ? () => S.failedPackages.has(c.pkg) : undefined
    }));
    for (const id of S.order) {
      const info = S.docs.get(id);
      if (info) list.push({ id: 'winImg' + id, menu: ['Window'], label: info.name, separatorBefore: id === S.order[0], enabled: () => true, run: () => showDoc(id), shortcut: null });
    }
    return list;
  }
  /** The shell keeps this array by reference: refill it in place and rebuild the menus. */
  function syncWindowMenu() {
    const fresh = buildMenuList();
    S.menuList.length = 0;
    for (const c of fresh) S.menuList.push(c);
    refreshUi();
  }

  /** The shell ignores the result; it is a promise so a caller (the tests) can wait for the command. */
  function onCommand(c) {
    if (!c || typeof c.run !== 'function') return undefined;
    if (c.pkg && S.failedPackages.has(c.pkg)) return undefined;
    if (!c.enabled(snapshot())) return undefined;
    return Promise.resolve()
      .then(() => c.run(c.ext ? EXT_API : API))
      .catch((err) => reportError(err));
  }

  function refreshUi() { if (S.shell) S.shell.refreshMenus(); }

  function readPixel(x, y) {
    const info = activeInfo();
    if (!info) return Promise.resolve(null);
    return call('doc.pixel', { docId: info.docId, x, y }).then((r) => r.values);
  }

  // owner: P6 (wave 2)
  function onToolOptions(id) {
    if (id === 'wand') {
      dialog({ title: tr('tool.wand'), okLabel: tr('dlg.ok'), fields: [
        { type: 'number', id: 'tolerance', labelKey: 'dlg.roi.wandTolerance', value: S.wand.tolerance, min: 0, step: 'any' },
        { type: 'radio', id: 'mode', labelKey: 'dlg.roi.wandMode', value: String(S.wand.mode), options: [{ value: '8', labelKey: 'dlg.roi.wand8' }, { value: '4', labelKey: 'dlg.roi.wand4' }] }] })
        .then((v) => { if (v) S.wand = { tolerance: Math.max(0, Number(v.tolerance)), mode: String(v.mode) === '4' ? 4 : 8 }; });
      return;
    }
    if (id !== 'line') return;
    dialog({ title: tr('tool.lineWidth'), okLabel: tr('dlg.ok'), fields: [{ type: 'number', id: 'w', label: tr('tool.lineWidth'), value: S.lineWidth, min: 1, max: 200, integer: true, units: tr('dlg.pixels') }] })
      .then((v) => { if (v) { S.lineWidth = Math.max(1, Math.round(Number(v.w))); S.shell.setLineWidth(S.lineWidth); } });
  }

  function onVisibility() {
    if (document.visibilityState !== 'hidden' || !S.worker || S.worker.dead || !S.docs.size) return;
    call('flush', {}).then((res) => {
      if (res && res.ok === false) { S.unprotected.add('*'); showWarning(); }
    }).catch(() => {});
  }

  /**
   * The Wand tool (ij.gui.Wand.autoOutline through IJ.doWand): the click traces the pixels of the same value (± the
   * tolerance) that touch it, 4- or 8-connected; while the Threshold window holds a range for this channel the thresholded
   * pixels are traced instead (ImageJ: "if (!ip.isThreshold() ...) autoOutline(x, y, tolerance, mode) else autoOutline(x, y,
   * lower, upper, mode)"). The outline is a traced polygon selection (holes stay inside it).
   */
  /** Roi.update(add, subtract) of the Wand: the new outline joins ("add", Shift) or leaves ("subtract", Alt) the selection that
   *  was there — a mask selection; "if (add) previousRoi.add(this) else if (subtract) previousRoi.subtract(this)". */
  function combineWithPrevious(prev, next, add, W, H) {
    const a = IJRoi.mask(prev, W, H), b = IJRoi.mask(next, W, H);
    const x0 = add ? Math.min(a.w ? a.x : b.x, b.w ? b.x : a.x) : a.x, y0 = add ? Math.min(a.w ? a.y : b.y, b.w ? b.y : a.y) : a.y;
    const x1 = add ? Math.max(a.x + a.w, b.x + b.w) : a.x + a.w, y1 = add ? Math.max(a.y + a.h, b.y + b.h) : a.y + a.h;
    const w = x1 - x0, h = y1 - y0;
    if (!(w > 0 && h > 0)) return null;
    const full = new Uint8Array(w * h);
    for (let j = 0; j < a.h; j++) for (let i = 0; i < a.w; i++) if (a.data[j * a.w + i]) full[(a.y - y0 + j) * w + a.x - x0 + i] = 1;
    for (let j = 0; j < b.h; j++) for (let i = 0; i < b.w; i++) if (b.data[j * b.w + i]) { const cx = b.x - x0 + i, cy = b.y - y0 + j; if (cx >= 0 && cy >= 0 && cx < w && cy < h) full[cy * w + cx] = add ? 1 : 0; }
    const roi = IJRoi.fromMask(full, w, h);
    if (!(roi.w > 0 && roi.h > 0)) return null;
    return IJRoi.translate(roi, x0, y0);
  }
  async function wandAt(x, y, mods) {
    const info = activeInfo();
    if (!info || S.busy || !Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= info.width || y >= info.height) return null;
    // the operation lives in ij-proc-roi.js: without it the click says why nothing happens instead of failing with IJ_UNKNOWN_OP
    if (S.failedPackages.has('roi')) { setStatus(tr('warn.packageFailed', { pkg: 'roi' })); return null; }
    const ch = activeChannel(info);
    const params = { x, y, tolerance: S.wand.tolerance, connectivity: S.wand.mode };
    const thr = thresholdFor(info, ch);
    if (thr) { params.lower = thr.lower; params.upper = thr.upper; }
    const res = await compute('wand', params, { docId: info.docId, channel: ch, roi: null, labelKey: 'op.wand' });
    if (!res || !res.points || res.points.length < 3) return null;
    const outline = { type: 'polygon', points: res.points, traced: true };
    const prev = selOf(info.docId);
    if (mods && (mods.shift || mods.alt) && prev && IJRoi.isArea(prev)) {
      const merged = combineWithPrevious(prev, outline, !!mods.shift, info.width, info.height);
      if (merged) { setSelection(info.docId, merged, true); return res.points.length; }
      if (!mods.shift) { setSelection(info.docId, null, true); return res.points.length; }
    }
    setSelection(info.docId, outline, true);
    return res.points.length;
  }

  // The facade the commands receive.
  const API = {
    openTiff, saveTiff, savePng, saveResults, revert, recover: recoverDialog, closeImage: () => closeImage(), simpleView, closeStudio,
    undo: () => undoRedo('undo'), redo: () => undoRedo('redo'), clearSel, fillSel, invert, selectAll, selectNone, restoreSelection, makeInverse, addToManager,
    convertType, openTool, showInfo, zProject, crop, duplicate, simpleOp, zoom, zoom100, zoomToSelection, zoomFit, applyLut, setLut, invertLut,
    convertToMask, binary, math, gaussian, rank, measure, particles, clearResults, setMeasurements, histogram, plotProfile, cycleImage, showAbout, showShortcuts,
    summarize, distribution
  };

  // ───────────────────────────── extension API ─────────────────────────────

  /** The image info with the display the operator sees: the stored info keeps the display of the last engine answer, which a
   *  display change (Invert LUT, B&C, api.setDisplay) does not refresh. */
  function liveInfo(info) {
    const d = info ? S.dstate.get(info.docId) : null;
    if (!d || !Array.isArray(info.channels)) return info;
    return Object.assign({}, info, { channels: info.channels.map((c, i) => {
      const s = d.channels[i];
      return s ? Object.assign({}, c, { display: Object.assign({}, c.display, { min: s.min, max: s.max, lut: s.lut, invert: !!s.invert }) }) : c;
    }) });
  }

  function stateForApi() {
    const info = activeInfo();
    return {
      doc: liveInfo(info), docs: S.order.map((id) => S.docs.get(id)).filter(Boolean).map(liveInfo), roi: info ? selOf(info.docId) : null, busy: S.busy,
      activeChannel: info ? activeChannel(info) : 0, threshold: S.threshold, measurements: S.measurements.slice(), lineWidth: S.lineWidth,
      roiList: S.roiList.map((r) => ({ name: r.name, docId: r.docId, roi: r.roi })), resultsCount: S.results.length
    };
  }

  function docOf(o) {
    const id = o && o.docId !== undefined ? o.docId : S.activeId;
    const info = id !== null && id !== undefined ? S.docs.get(id) : null;
    return info || null;
  }

  async function compute(op, params, o) {
    const opt = o || {};
    const info = docOf(opt);
    if (!info) return null;
    const args = { docId: info.docId, op, params: params || {}, roi: opt.roi !== undefined ? opt.roi : selOf(info.docId),
      channel: opt.channel !== undefined ? opt.channel : activeChannel(info) };
    if (Array.isArray(opt.docIds) && opt.docIds.length) args.docIds = opt.docIds;
    if (opt.region) args.region = opt.region;
    if (opt.preview) {
      // Previews queue behind each other on the document: the previous one is cancelled first.
      if (S.previewCompute) call('cancel', { targetId: S.previewCompute }).catch(() => {});
      const p = call('doc.compute', args);
      S.previewCompute = p.reqId;
      try { return await p; } finally { if (S.previewCompute === p.reqId) S.previewCompute = 0; }
    }
    if (S.busy) return null; // another step is running: nothing is started
    return busy(opt.labelKey ? tr(opt.labelKey) : tr('op.' + op), () => call('doc.compute', args));
  }

  async function estimateOp(op, params, o) {
    const opt = o || {};
    const info = docOf(opt);
    if (!info) return null;
    return call('doc.estimate', { docId: info.docId, op, params: params || {}, roi: opt.roi !== undefined ? opt.roi : selOf(info.docId),
      channel: opt.channel !== undefined ? opt.channel : activeChannel(info) });
  }

  /** The pixel preview of an operation over what is on screen: { ok:true } | { ok:false, tooLarge:true }. */
  async function previewOp(op, params, o) {
    const opt = o || {};
    const info = docOf(opt);
    if (!info || !S.display) return { ok: false };
    const seq = ++S.previewSeq;
    const r = visibleRect(info);
    try {
      await call('doc.preview', { docId: info.docId, seq, op, params: params || {}, roi: opt.roi !== undefined ? opt.roi : selOf(info.docId),
        channel: opt.channel !== undefined ? opt.channel : activeChannel(info), level: S.display.getView().level || 0,
        x0: Math.max(0, Math.floor(r.x0)), y0: Math.max(0, Math.floor(r.y0)), x1: Math.min(info.width, Math.ceil(r.x1)), y1: Math.min(info.height, Math.ceil(r.y1)) });
    } catch (err) {
      if (err && err.code === 'IJ_PREVIEW_TOO_LARGE') { S.display.setPreview(null); return { ok: false, tooLarge: true }; }
      throw err;
    }
    return { ok: true };
  }

  function addResultRows(rows, o) {
    if (!Array.isArray(rows) || !rows.length) return;
    S.results = S.results.concat(rows.map((r) => Object.assign({}, r)));
    scheduleToolRefresh('results');
    scheduleMetaPersist();
    refreshUi();
    if (!o || o.show !== false) openTool('results');
  }

  async function renameDoc(docId, name) {
    try {
      const res = await call('doc.rename', { docId, name });
      if (res && res.info) S.docs.set(docId, res.info);
      if (docId === S.activeId && S.shell) S.shell.updateInfo(viewInfo(docId));
      syncWindowMenu();
      scheduleMetaPersist();
      return res ? res.info : null;
    } catch (err) { await reportError(err); return null; }
  }

  const TOOL_IDS = ['bc', 'channels', 'threshold', 'results', 'roiManager', 'summary'];

  /** api.openTool(id): opens (or raises) a tool window; for 'threshold' it resolves once S.threshold holds the first automatic range. */
  async function openToolExt(id) {
    if (TOOL_IDS.indexOf(id) < 0) throw extError('openTool: ' + String(id));
    S.lastToolReady = null;
    openTool(id);
    if (S.lastToolReady) { try { await S.lastToolReady; } catch (err) { console.error('[advanced-studio] tool window', err); } }
    return S.wins.has(id);
  }

  /** api.setDisplay(docId, channel, { min, max, lut, invert }): the display of one channel (not an undo step, not a pixel change). */
  async function setDisplayExt(docId, channel, patch) {
    const info = docId !== undefined && docId !== null ? S.docs.get(docId) : null;
    const d = info ? S.dstate.get(docId) : null;
    if (!info || !d || !Number.isInteger(channel) || !d.channels[channel]) throw extError('setDisplay: image or channel');
    const p = {};
    for (const k of ['min', 'max']) if (patch && patch[k] !== undefined) { if (typeof patch[k] !== 'number' || !isFinite(patch[k])) throw extError('setDisplay: ' + k); p[k] = patch[k]; }
    if (p.min !== undefined && p.max !== undefined && p.min > p.max) throw extError('setDisplay: min > max');
    if (patch && patch.lut !== undefined) p.lut = patch.lut;
    if (patch && patch.invert !== undefined) p.invert = !!patch.invert;
    Object.assign(d.channels[channel], p);
    if (docId === S.activeId) { pushDisplay(); scheduleToolRefresh('display'); }
    await call('doc.setDisplay', Object.assign({ docId, channel }, p));
    scheduleMetaPersist();
  }

  const EXT_API = Object.freeze({
    tr: (key, params) => tr(key, params),
    state: stateForApi,
    dialog,
    run: (op, params, o) => runExt(op, params, o),
    compute,
    estimate: estimateOp,
    preview: previewOp,
    cancelPreview: () => clearExtPreview(),
    overlay: (items) => { if (S.display && S.display.setOverlay) { S.overlayDoc = S.activeId; S.display.setOverlay(items); } },
    clearOverlay: () => { if (S.display && S.display.setOverlay) S.display.setOverlay(null); },
    setRoi: (roi, o) => { const id = o && o.docId !== undefined ? o.docId : S.activeId; if (id !== null && S.docs.has(id)) setSelection(id, roi || null, true); },
    addResults: addResultRows,
    openTable,
    openPlot,
    toast: (key, params) => setStatus(tr(key, params)),
    error: (err) => reportError(err),
    rename: renameDoc,
    setDisplay: setDisplayExt,
    openTool: openToolExt
  });
  const EXT_API_MEMBERS = Object.keys(EXT_API);

  function extError(msg) { return Object.assign(new Error(msg), { code: 'IJ_BAD_ARGS' }); }

  /** IJApp.extend — see the header of this file. Throws on a malformed registration, never half-registers. */
  function extend(spec) {
    if (extensionsLocked) throw Object.assign(new Error('IJApp.extend after mount'), { code: 'IJ_EXTEND_AFTER_MOUNT' });
    if (!spec || typeof spec.pkg !== 'string' || !/^[a-z][a-z0-9]*$/.test(spec.pkg)) throw extError('extend: pkg');
    // The page disables a failed package by the name its ij-proc-<pkg>.js file reports: a pkg that names no
    // such file could never be disabled.
    if (PACKAGE_NAMES.indexOf(spec.pkg) < 0) throw extError('extend: ' + spec.pkg + ' is not a package of WORKER_SCRIPTS');
    if (EXT.packages.has(spec.pkg)) throw extError('extend: package ' + spec.pkg + ' is already registered');
    const known = new Set(COMMANDS.map((c) => c.id));
    const built = [];
    for (const raw of spec.commands || []) {
      if (!raw || typeof raw.id !== 'string' || !/^[A-Za-z0-9]+$/.test(raw.id)) throw extError('extend: command id');
      if (known.has(raw.id)) throw extError('extend: duplicate command ' + raw.id);
      if (!Array.isArray(raw.menu) || !raw.menu.length || !raw.menu.every((x) => typeof x === 'string' && x)) throw extError('extend: menu of ' + raw.id);
      if (typeof raw.run !== 'function') throw extError('extend: run of ' + raw.id);
      if (!(typeof raw.order === 'number' && isFinite(raw.order))) throw extError('extend: order of ' + raw.id);
      if (raw.enabled !== undefined && typeof raw.enabled !== 'function') throw extError('extend: enabled of ' + raw.id);
      known.add(raw.id);
      const keys = Array.isArray(raw.keys) && raw.keys.length ? raw.keys.slice() : (raw.shortcut ? [raw.shortcut] : []);
      const enabled = typeof raw.enabled === 'function' ? raw.enabled : has;
      built.push({
        id: raw.id, menu: raw.menu.slice(), labelKey: raw.labelKey || ('cmd.' + raw.id), shortcut: raw.shortcut || keys[0] || null, keys,
        order: raw.order, pkg: spec.pkg, long: !!raw.long, ext: true, separatorBefore: !!raw.separatorBefore,
        enabled: (st) => !S.failedPackages.has(spec.pkg) && !!enabled(st), run: raw.run
      });
    }
    const errors = spec.errors && typeof spec.errors === 'object' ? spec.errors : {};
    for (const code of Object.keys(errors)) {
      if (!/^[A-Z][A-Z0-9_]*$/.test(code) || typeof errors[code] !== 'string' || !/^err\.[A-Za-z0-9]+$/.test(errors[code])) throw extError('extend: error ' + code);
      if (ERROR_KEYS[code] !== undefined && ERROR_KEYS[code] !== errors[code]) throw extError('extend: error ' + code + ' is already mapped');
    }
    const cols = Array.isArray(spec.columns) ? spec.columns : [];
    for (const c of cols) if (!Array.isArray(c) || typeof c[0] !== 'string' || typeof c[1] !== 'string' || (c[2] !== undefined && typeof c[2] !== 'string')) throw extError('extend: columns');
    for (const c of built) COMMANDS.push(c);
    Object.assign(ERROR_KEYS, errors);
    for (const c of cols) EXTRA_COLUMNS.push(c.slice(0, 3));
    if (spec.measurements) EXT.measurements[spec.pkg] = spec.measurements;
    EXT.packages.set(spec.pkg, { commands: built.map((c) => c.id) });
  }

  // ───────────────────────────── public lifecycle ─────────────────────────────

  function mount(root, { ctx, api }) {
    extensionsLocked = true;
    S.ctx = ctx; S.api = api; S.root = root;
    if (S.appEl && S.shell) {
      // Back from the Simple view: the DOM, the worker and the documents are still here, provided
      // the worker lives and the figure is the one they were made from. Otherwise start afresh
      // (dispose stores what is unsaved: it stays recoverable).
      let same = false;
      try { same = !!(S.worker && !S.worker.dead && S.figureKey !== null && figureKeyOf(ctx.studio.source.describe()) === S.figureKey); } catch (_) { same = false; }
      if (!same) { S.leaving = null; dispose(); }
    }
    S.leaving = null;
    if (S.appEl && S.shell) {
      S.mounted = true;
      root.classList.add('ij-root');
      S.appEl.style.display = '';
      S.display.resize();
      enter().catch((err) => reportError(err));
      return;
    }
    root.classList.add('ij-root');
    S.appEl = h('div', { class: 'ij-app' });
    root.appendChild(S.appEl);
    S.mounted = true;
    S.firstCommitDone = false;
    try {
      startWorker();
      S.menuList = buildMenuList();
      S.shell = IJShell.create(S.appEl, {
        commands: S.menuList, getState: snapshot, t: shellT, menuGroups: GROUP_META,
        tools: TOOLS.map((t) => (t.separator ? t : { id: t.id, labelKey: t.labelKey })),
        onCommand, onTool: (id) => { S.tool = id; }, onToolOptions, onWand: (x, y, mods) => wandAt(x, y, mods).catch((err) => reportError(err)),
        onRoi: (roi, o) => { const i = activeInfo(); if (i) setSelection(i.docId, roi, !o || o.final !== false, true); },
        onChannel: (c) => { const i = activeInfo(); if (i) setDocDisplayMode(i.docId, { active: c }); },
        onCancel: cancelRunning, readPixel, isActive: () => S.mounted,
        display: { onTileError: (err) => console.error('[advanced-studio] tile', err) }
      });
      S.display = S.shell.display;
      S.host = S.shell.stage;
      S.windows = S.shell.windows;
    } catch (err) {
      console.error('[advanced-studio] mount', err);
      dispose();
      throw err;
    }
    S.visHandler = onVisibility;
    document.addEventListener('visibilitychange', S.visHandler);
    showEmpty();
    enter().catch((err) => reportError(err));
  }

  function hasUnsavedWork() { return dirtyDocs().length > 0; }

  /**
   * Closes documents in the engine, discarding their stored records: the operator saved them,
   * discarded them, or they never changed. Whatever stays open in the engine is flushed again
   * when the view is disposed, so a discarded document must really be gone from it.
   */
  async function discardDocs(ids) {
    for (const id of ids) {
      try { await call('doc.close', { docId: id, discard: true }); } catch (err) { console.error('[advanced-studio]', err); }
      forgetDoc(id);
    }
  }

  async function canLeave(reason) {
    if (reason === 'simple') { S.leaving = 'simple'; return true; }
    const dirty = dirtyDocs();
    let keep = false;
    if (dirty.length) {
      const a = await ask({ title: tr('leave.title'), message: tr('leave.message', { n: dirty.length }), layout: 'row',
        options: [{ id: 'save', label: tr('leave.save'), primary: true }, { id: 'keep', label: tr('leave.keep'), hint: tr('leave.keepHint') },
          { id: 'discard', label: tr('leave.discard'), variant: 'danger' }, { id: 'cancel', label: tr('dlg.cancel') }], dismissId: 'cancel' });
      if (a === 'save') {
        for (const id of dirty) {
          let ok = false;
          try { ok = await saveDocTiff(id); } catch (err) { await reportError(err); }
          if (!ok) return false;
        }
      } else if (a === 'keep') {
        // Keeping is only true when the engine says every document reached the storage.
        let res = null;
        try { res = await call('flush', {}); } catch (err) { console.error('[advanced-studio] flush', err); await reportError(err); return false; }
        if (res && res.ok === false) {
          S.unprotected.add('*'); showWarning();
          await ask({ title: tr('leave.keepFailedTitle'), message: tr('leave.keepFailed'), options: [{ id: 'ok', label: tr('dlg.ok'), primary: true }], dismissId: 'ok' });
          return false;
        }
        keep = true;
      } else if (a === 'discard') {
        await discardDocs(dirty);
      } else {
        return false;
      }
    }
    // Everything saved, discarded or untouched leaves no stored session behind; only 'keep' does.
    await discardDocs(S.order.filter((id) => S.docs.has(id) && !(keep && isDirty(id))));
    S.leaving = reason;
    return true;
  }

  function unmount() {
    if (!S.mounted) {
      // Hidden by the Simple view and now closed or replaced (canLeave said so): nothing to show, release it.
      if (S.appEl && S.leaving && S.leaving !== 'simple') dispose();
      return;
    }
    if (S.leaving === 'simple' && S.display) {
      // Hidden, not torn down: the worker and the documents keep running.
      S.mounted = false;
      endPreview();
      // A modal left open would keep swallowing the keyboard of the Simple view.
      if (S.shell && typeof S.shell.windows.hasModal === 'function' && S.shell.windows.hasModal()) S.shell.windows.closeAll();
      if (S.appEl) S.appEl.style.display = 'none';
      if (S.root) S.root.classList.remove('ij-root');
      return;
    }
    dispose();
  }

  /** The Studio closed or replaced its document while this view was hidden: free the worker, the GL context and the documents. */
  function release() {
    if (!S.appEl && !S.worker) return;
    S.leaving = 'close';
    dispose();
  }

  function dispose() {
    S.mounted = false;
    clearTimeout(S.persistTimer); clearTimeout(toolTimer); clearTimeout(S.previewTimer);
    if (S.loadAbort) S.loadAbort.abort();
    const w = S.worker;
    if (w && !w.dead) {
      // Snapshot what is unsaved, then stop the worker.
      clearTimeout(w.readyTimer);
      Promise.race([call('flush', {}).catch(() => {}), new Promise((r) => setTimeout(r, 2000))]).then(() => { w.dead = true; try { w.w.terminate(); } catch (_) { /* gone */ } });
    }
    S.worker = null;
    for (const [, win] of S.wins) { try { if (win && win.close) win.close(); } catch (_) { /* already closed */ } }
    S.wins.clear(); S.winUpdaters.clear();
    if (S.visHandler) document.removeEventListener('visibilitychange', S.visHandler);
    S.visHandler = null;
    try { if (S.shell) S.shell.destroy(); } catch (err) { console.error('[advanced-studio] shell destroy', err); }
    if (S.appEl) S.appEl.remove();
    if (S.root) S.root.classList.remove('ij-root');
    for (const key of Array.from(S.locks.keys())) releaseSessionLock(key);
    S.display = null; S.shell = null; S.windows = null; S.appEl = null; S.host = null; S.emptyEl = null; S.menuList = [];
    for (const m of [S.docs, S.activeCh, S.dstate, S.sel, S.prevSel, S.undo, S.cleanRev, S.revs, S.sessionKeys, S.sources, S.displayPatch, S.displayInflight]) m.clear();
    S.order = []; S.activeId = null; S.roiList = []; S.roiSelected.clear(); S.results = []; S.summaryRows = []; S.figureKey = null; S.desc = null;
    S.threshold = null; S.previewCompute = 0; S.redirect = null;
    S.leaving = null; S.busy = false; S.unprotected.clear(); S.held.clear(); S.warnBudget = ''; S.warnLow = false;
  }

  return {
    mount, unmount, release, canLeave, hasUnsavedWork,
    COMMANDS, TOOLS, LUT_NAMES, ERROR_KEYS, MEASURE_GROUPS,
    extend, EXT_API_MEMBERS, WORKER_SCRIPTS, PACKAGE_NAMES, GROUP_META, ORDER, EXTRA_COLUMNS, resultColumnsOf, columnHeader,
    // pure helpers, exposed for tests
    planLevels, mapRange, outputBitDepth, bcMath, measurementKeys, errorKey, snapshotOf: (st) => st, workerInit, distributionHistogram, distributionDefaultColumn, COLUMNS, PARTICLE_COLUMNS
  };
})();
