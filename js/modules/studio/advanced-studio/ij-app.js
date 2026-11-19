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
 *     onToolOptions, onRoi(roi, {final, docId}), onChannel(index, docId), onCancel, readPixel(x, y, docId) → Promise<number[]>,
 *     isActive, onActivate(docId), onCloseImage(docId), onLayoutChange(kind), display:{ onTileError, onViewChange } })
 *   shell.layout (IJLayout: add(docId, {placement:'tab'|'splitRight'|'gridWithSource'|'float', anchor, docIds}), remove,
 *   activate, view, views, order, tile, cascade, showAll, putBehind, minimize, restore, float, dock, maximize,
 *   serialize, restoreFrom, clear, setTabInfo, onChange, onActivate, onClose), shell.view(docId) / activeView()
 *   (IJView, ONE per open image: setTileProvider, invalidate, setPreview, setThresholdOverlay, setOverlay,
 *   setAnnotations, setCursorMark, zoomAt, fit, view100, zoomToRect, getView, setView, visibleRect,
 *   renderToCanvas), shell.workspace, shell.windows (dialog, floating, confirm, list), setImage(info, {placement}),
 *   removeImage, clearImage, setDisplayState(state, docId), setActiveRoi(roi, docId), setRois(r, docId), setStatus,
 *   setProgress({fraction, label, cancellable}), setWarning, setLineWidth, setTool, refreshMenus.
 *   There is no "the display": every use goes through viewOf(docId) / activeView() below.
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
 * ── Wave 3 additions (PLAN-wave3 §2.5 / §2.6) ─────────────────────────────────────────────────────────────────
 * IJApp.extend also takes
 *   panels: { <id>: { titleKey, build(el, papi) → { refresh?(kind), dispose? }, persist?, defaultSize?: { w, h } } }
 *       a resizable tool window whose content `build` fills (`papi` = the package's api); `refresh(kind)` is called with the
 *       kinds of the tool windows (doc pixels display selection rois results summary layout); `persist` = reopened after
 *       a reload. Ids are global (a built-in tool window id is refused).
 *   tools: [{ id, labelKey, icon?, cursor?, hidden?, after?, onPointer(api, { type: 'down'|'move'|'up'|'cancel', docId, x, y,
 *       button, shift, alt, ctrl }) }]   a toolbar tool (x, y in image coordinates); `hidden` = no button until api.setTool(id);
 *       `after` = the tool id it follows
 *   longCommands: ['doc.tiff.project', …]   worker commands Cancel may target
 * a command also takes `repeatable` (default true; false only for Repeat itself, Undo and Close: ImageJ's Executer does
 * not remember those) and a menu path of up to three segments (every submenu must have its place in IJApp.GROUP_META).
 * New api members (each package gets its OWN api object: `call`, `settings.set` and `sessionData` know their package):
 *   openPanel(id, { focus }) → Promise<boolean>      closePanel(id)       a registered panel as a tool window
 *   on(event, fn) → off()   events: 'activeDoc' docId · 'roi' { docId, roi, final } · 'doc' { docId, kind: 'opened' | 'pixels' |
 *       'size' (dimensions, channel layout or calibration) | 'display' | 'renamed' | 'closed' } · 'results' · 'layout' kind ·
 *       'tool' id · 'ext:<name>' (an event a worker command posted with E.postEvent). Listeners are dropped when the view
 *       is torn down (the Simple view only hides it: they stay).
 *   annotations { get(docId) → { visible, items } (a copy), set(docId, items, { tag }) (replace all, or only the items of
 *       `tag`), add(docId, items), remove(docId, { tag } | { ids }), setVisible(docId, true | false | 'toggle') }
 *       persistent per-document overlay items (PLAN-wave3 §2.5): { id, kind: 'roi' | 'text' | 'shapes' | 'rect' | 'marker', … }
 *       in image coordinates; not undo steps; stored in the session meta; cleared (with a warning) by a size change
 *   settings { get(key), set(key, value) }  localStorage 'lumen3d.ij.prefs'; core keys conv.scale conv.fullRange16 misc.divZero
 *       colors.foreground colors.background colors.selection appearance.interpolate (only the Edit package writes them); every
 *       other key lives under the package's own prefix (bg flt seg multi geom roi coloc lay thr enh fft sel io ov ana edit fiji lib)
 *   sessionData { get(pkg), set(pkg, json) }  the package's own JSON (≤ 256 KiB) in the session meta
 *   commands() → [{ id, label, path: [menu labels], shortcut, enabled }]     runCommand(id) → Promise (the command runs
 *       normally, its dialog appears pre-filled)     lastCommand() → { id } | null   (last run command with repeatable !== false)
 *   call(cmd, args, { transfer, labelKey, long }) → Promise<result | null>   a worker command registered by THIS package with
 *       IJOpRegistry.defineCommand (another name rejects IJ_EXT_FORBIDDEN); busy / progress / Cancel like api.run
 *   adopt(info, { placement, provenance, sessionKey }) → Promise<docId>   a document the worker created (E.createDoc)
 *   addDoc(image, { placement, hidden, provenance, sessionKey }) → Promise<docId>   image = { name, width, height, bitDepth,
 *       calibration, channels: [{ data, name, color, display? }] }; the arrays are transferred (worker doc.import)
 *   closeDoc(docId) → Promise<boolean>  (with the unsaved prompt)     view(docId) → { getView, setView, visibleRect } | null
 *   putBlob(typedArray) → Promise<blobRef>   bytes sent to the worker once; a blobRef is the object { blobRef, kind }: put it
 *       where the typed array belongs in the params of api.preview / api.run; ≤ 64 MiB; dropped with the documents using it
 *   setPending({ labelKey, commit() → Promise, cancel() }) / clearPending()   one transient state (a floating paste): commit
 *       runs before any other command, an image switch or Enter; cancel on Escape; the status bar shows labelKey
 *   setTool(id)   setThreshold(docId, channel, { lower, upper, dark }) → Promise   drives the Threshold window
 *   colorValue(docId, channel, 'foreground' | 'background') → number   ImageJ's setColor on a grey image (see colorValueOf)
 *   registerLut(name, Uint8Array(768)) → Promise   page + worker registry, kept in the session meta
 *   pickFile({ accept, multiple }) → Promise<File[] | null>    saveFile(suggestedName, mime, ext, descKey, produce) → Promise<boolean>
 *   copyText(text) → Promise (rejects with the browser's error)   renderPng(docId, { rect }) → Promise<Blob> (as displayed)
 *   profile(docId, roi, channel) → Promise<{ values, step }>   (worker doc.profile)
 *   roiManager { list() → [{ name, docId, roi, stroke?, width?, fill? }], add(entries), set(list), select(indices), selected() → [i] }
 *   run(op, params, { …, placement })  placement 'tab' | 'splitRight' | 'gridWithSource' | 'float' for the images the step creates
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
    'ij-proc-bg.js', 'ij-proc-filters.js', 'ij-proc-seg.js', 'ij-proc-multi.js', 'ij-proc-geom.js', 'ij-proc-roi.js', 'ij-proc-coloc.js',
    'ij-proc-thr.js', 'ij-proc-enh.js', 'ij-proc-fft.js', 'ij-proc-sel.js', 'ij-proc-io.js', 'ij-proc-ov.js', 'ij-proc-ana.js',
    'ij-proc-edit.js', 'ij-proc-fiji.js', 'ij-proc-lib.js'];
  const PACKAGE_FILE_RX = /^ij-proc-([a-z0-9]+)\.js$/;
  const PACKAGE_NAMES = WORKER_SCRIPTS.map((f) => PACKAGE_FILE_RX.exec(f)).filter((m) => m && m[1] !== 'shared').map((m) => m[1]);
  const ESTIMATE_MIN_FRACTION = 1 / 64; // an image under budget/64 never needs the estimate round trip
  const PERSIST_MS = 1200;
  // The events api.on knows ('ext:<name>' = what a worker command posted), the settings with their defaults, the prefix each
  // package owns in api.settings (PLAN-wave3 §1.1; the core keys belong to `edit`), ImageJ's colour names.
  const EVENT_NAMES = new Set(['activeDoc', 'roi', 'doc', 'results', 'layout', 'tool']);
  const PREFS_KEY = 'lumen3d.ij.prefs';
  const SETTING_DEFAULTS = { 'conv.scale': true, 'conv.fullRange16': false, 'misc.divZero': 'Infinity', 'colors.foreground': 'white',
    'colors.background': 'black', 'colors.selection': 'yellow', 'appearance.interpolate': false };
  const CORE_SETTING_PREFIXES = ['conv', 'misc', 'colors', 'appearance'];
  const PKG_PREFIX = { bg: 'bg', filters: 'flt', seg: 'seg', multi: 'multi', geom: 'geom', roi: 'roi', coloc: 'coloc', lay: 'lay', thr: 'thr', enh: 'enh',
    fft: 'fft', sel: 'sel', io: 'io', ov: 'ov', ana: 'ana', edit: 'edit', fiji: 'fiji', lib: 'lib' };
  // ij.gui.Toolbar / Colors.java: java.awt.Color constants (orange = 255,200,0; pink = 255,175,175; grays 128 / 192 / 64)
  const COLOR_NAMES = { red: [255, 0, 0], green: [0, 255, 0], blue: [0, 0, 255], magenta: [255, 0, 255], cyan: [0, 255, 255], yellow: [255, 255, 0],
    orange: [255, 200, 0], black: [0, 0, 0], white: [255, 255, 255], gray: [128, 128, 128], lightgray: [192, 192, 192], darkgray: [64, 64, 64],
    pink: [255, 175, 175] };
  const BLOB_BYTES_MAX = 64 * 1048576;
  const ANNOTATION_KINDS = ['roi', 'text', 'shapes', 'rect', 'marker'];
  const ANNOTATIONS_MAX = 100000;       // per image, in memory; the session meta keeps 10 000 (the engine says when it dropped them)
  const EXT_DATA_MAX = 256 * 1024;
  const GRID_MEMORY_FRACTION = 0.5;     // a Split Channels grid warns about memory above this share of the engine's budget
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
    return Object.assign({ id, menu, labelKey: 'cmd.' + id, shortcut: null, keys: [], enabled: has, repeatable: true,
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
    cmd('fileClose', ['File'], { repeatable: false, run: (a) => a.closeImage() }),
    cmd('fileSimple', ['File'], { enabled: always, run: (a) => a.simpleView() }),
    cmd('fileCloseStudio', ['File'], { enabled: always, run: (a) => a.closeStudio() }),

    // ── Edit
    cmd('editUndo', ['Edit'], Object.assign(sc('Ctrl+Z'), { repeatable: false, enabled: (st) => has(st) && !!st.canUndo, run: (a) => a.undo() })),
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
      cmd('toolsSyncWindows', ['Analyze', 'Tools'], { enabled: (st) => st.nDocs > 0, run: (a) => a.syncWindows() }),

      // ── Window (ImageJ's fixed items, then the open tool windows and the images, see buildMenuList)
      cmd('windowShowAll', ['Window'], Object.assign(sc(']'), { enabled: (st) => st.nDocs > 0, run: (a) => a.showAll() })),
      cmd('windowPutBehind', ['Window'], { enabled: (st) => st.nDocs > 0, run: (a) => a.putBehind() }),
      cmd('windowCascade', ['Window'], { enabled: (st) => st.nDocs > 0, run: (a) => a.cascade() }),
      cmd('windowTile', ['Window'], { enabled: (st) => st.nDocs > 0, run: (a) => a.tile() }),
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
    fileOpen: 10, fileSaveTiff: 10, fileSavePng: 20, fileSaveResults: 30, fileRevert: 30, fileRecover: 40, fileClose: 20, fileSimple: 60, fileCloseStudio: 70,
    editUndo: 10, editRedo: 20, editClear: 30, editClearOutside: 40, editFill: 50, editInvert: 60,
    editSelectAll: 10, editSelectNone: 20, editRestoreSelection: 30, editMakeInverse: 100, editAddToManager: 240,
    typeBit8: 10, typeBit16: 20, typeBit32: 30,
    adjustBC: 10, adjustThreshold: 20,
    imageInfo: 30, colorChannels: 40, stackProject: 20, imageCrop: 80, imageDuplicate: 90,
    transformFlipH: 10, transformFlipV: 20, transformRotateRight: 30, transformRotateLeft: 40,
    zoomIn: 10, zoomOut: 20, zoomOriginal: 30, zoomToSelection: 40, zoomFit: 50,
    lutInvert: 10, lutApply: 20, lutFire: 30, lutGrays: 40, lutIce: 50, lutSpectrum: 60, lutRed: 80, lutGreen: 90, lutBlue: 100, lutCyan: 110,
    lutMagenta: 120, lutYellow: 130, lut16Colors: 150, lutHiLo: 160,
    binMask: 10, binErode: 20, binDilate: 30, binOpen: 40, binClose: 50, binFillHoles: 70,
    mathAdd: 10, mathSubtract: 20, mathMultiply: 30, mathDivide: 40, mathMin: 80, mathMax: 90, mathSet: 110, mathAbs: 180,
    filterGaussian: 20, filterMedian: 30, filterMean: 40, filterMinimum: 50, filterMaximum: 60,
    analyzeMeasure: 10, analyzeParticles: 20, analyzeSummarize: 30, analyzeDistribution: 40, analyzeClearResults: 50, analyzeSetMeasurements: 60, analyzeHistogram: 80, analyzePlotProfile: 90,
    toolsRoiManager: 50, toolsSyncWindows: 80,
    windowShowAll: 10, windowPutBehind: 20, windowCascade: 30, windowTile: 40, windowResults: 50, windowRoiManager: 51, windowNext: 70, windowPrevious: 80,
    helpAbout: 10, helpShortcuts: 20
  };
  // ImageJ's separators (IJ_Props.txt); the rows other packages own are theirs (PLAN-wave3 §1.2).
  const SEPARATOR_ABOVE = new Set(['fileClose', 'fileSimple', 'editClear', 'imageInfo', 'imageCrop', 'lutFire', 'lut16Colors', 'binErode', 'analyzeHistogram', 'windowNext']);
  // Position of each submenu inside its parent list (keyed by the path of menu names).
  const GROUP_META = {
    'File/New': { order: 5 }, 'File/Import': { order: 15 }, 'File/SaveAs': { order: 25 },
    'Edit/Selection': { order: 70, separatorBefore: true }, 'Edit/Options': { order: 80 },
    'Image/Type': { order: 10 }, 'Image/Adjust': { order: 20 }, 'Image/Color': { order: 60 }, 'Image/Stacks': { order: 70 },
    'Image/Transform': { order: 110 }, 'Image/Zoom': { order: 120 }, 'Image/Overlay': { order: 125 },
    'Image/LookupTables': { order: 130, separatorBefore: true },
    'Process/Noise': { order: 60 }, 'Process/Binary': { order: 70, separatorBefore: true }, 'Process/Math': { order: 80 },
    'Process/FFT': { order: 85 }, 'Process/Filters': { order: 90 },
    'Analyze/Tools': { order: 110 }, 'Analyze/Colocalization': { order: 120, separatorBefore: true },
    'Analyze/LocalThickness': { order: 140 }, 'Analyze/Skeleton': { order: 150 },
    'Plugins/Analyze': { order: 10 }, 'Plugins/Analyze/CellCounter': { order: 10 }, 'Plugins/Process': { order: 20 }, 'Plugins/Utilities': { order: 30 }
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
    ctx: null, api: null, root: null, appEl: null, shell: null, windows: null,
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
    tileCacheBytes: 0,        // the worker tile cache last asked for (engine.configure)
    previewDocs: new Set(),   // images whose view shows a pixel preview
    overlayDocs: new Set(),   // images whose view shows transient overlay items
    placing: false,           // the app itself is placing / activating a view (the layout's activation echo is ignored)
    extWindowSeq: 0,
    lastToolReady: null,      // promise of the tool window opened last (its first update)
    redirect: null,           // Set Measurements › Redirect to: { docId, channel } | null (not kept across a reload, as ImageJ)
    listeners: new Map(),     // api.on: event → Set<fn>
    annot: new Map(),         // docId → { visible, items } (persistent annotations, PLAN-wave3 §2.5)
    annotDims: new Map(),     // docId → { w, h } the annotations were made for
    annotSeq: 0,
    hidden: new Set(),        // documents kept in the session without a view or a menu entry (api.addDoc hidden)
    sync: { cursor: true, imageCoords: true, scaling: false, docs: new Set() },   // Synchronize Windows
    syncBound: new Map(),     // docId → off() of its view-change listener
    syncing: false,           // a relayed view change is being applied (the echo guard)
    pending: null,            // api.setPending: { labelKey, commit, cancel }
    lastCommand: null,        // id of the last run command with repeatable !== false
    extData: {},              // package → JSON (api.sessionData)
    luts: new Map(),          // look-up tables registered through api.registerLut: name → Uint8Array(768)
    engineUsed: 0,            // bytes the engine says it holds (its 'budget' events)
    lastActiveEmitted: null,  // the document 'activeDoc' last announced
    keyHandler: null,         // the capture-phase Enter / Escape listener of a pending state
    wand: { tolerance: 0, mode: 8 } // the Wand tool's options (tolerance in pixel values, 4- or 8-connected)
  };

  // ───────────────────────────── extension registry ─────────────────────────────
  const EXTRA_COLUMNS = [];            // [key, header, afterKey] declared through extend({ columns })
  const EXT = { packages: new Map(), measurements: {}, panels: new Map(), tools: new Map() };
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
  // Millions of voxels for the projection's progress label: one decimal below 10 M (a 0.26 M
  // plane must not read "1"), whole numbers above, grouped digits in the active language.
  function mvox(voxels, lang) {
    const m = voxels / 1e6;
    const small = m < 10;
    const v = small ? Math.round(m * 10) / 10 : Math.round(m);
    try {
      return v.toLocaleString(lang || undefined, small ? { minimumFractionDigits: 1, maximumFractionDigits: 1 } : { maximumFractionDigits: 0 });
    } catch (_) { return String(v); }
  }

  /** Label parameters + real fraction of one projection step. `loaded` counts bytes = channel values
   *  (one per channel per voxel), so voxels = loaded / channels; the fraction is weighted by the
   *  values read, so the last, shorter band agrees with the voxel count and ends at exactly 1. */
  function projectionProgress(o) {
    const est = o.width * o.height * o.depth * o.channels;
    const fraction = est ? Math.min(1, o.loaded / est) : o.donePlanes / o.totalPlanes;
    return { fraction, pct: Math.round(fraction * 100),
      mv: mvox(o.loaded / o.channels, o.lang), total: est ? mvox(est / o.channels, o.lang) : '?' };
  }

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

  function call(cmdName, args, transfer, o) {
    const c = S.worker;
    if (!c || c.dead) return Promise.reject(Object.assign(new Error('worker is down'), { code: 'IJ_WORKER_CRASHED' }));
    const id = c.nextId++;
    const p = new Promise((resolve, reject) => {
      c.pending.set(id, { resolve, reject, cmd: cmdName, long: !!(o && o.long) });
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
        { const v = viewOf(m.docId); if (m.seq === S.previewSeq && v) { v.setPreview(m); S.previewDocs.add(m.docId); } }
        break;
      case 'invalidate': {
        const iv = viewOf(m.docId);
        if (!iv) break;
        if (m.sizeChanged) refreshInfo(m.docId).then((info) => { afterLayoutChange(m.docId, info); refreshView(m.docId); emit('doc', { docId: m.docId, kind: 'size' }); }).catch(reportError);
        else if (m.calibration) refreshInfo(m.docId).then(() => { if (S.shell) S.shell.updateInfo(viewInfo(m.docId)); refreshUi(); emit('doc', { docId: m.docId, kind: 'size' }); }).catch(reportError);
        else { iv.invalidate(m.channels); emit('doc', { docId: m.docId, kind: 'pixels' }); }
        if (m.docId === S.activeId) scheduleToolRefresh('pixels');
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
        if (m.usedBytes >= 0) S.engineUsed = m.usedBytes;
        S.warnBudget = m.budgetBytes && m.usedBytes / m.budgetBytes >= 0.9 ? tr('warn.budget', { pct: Math.round((m.usedBytes / m.budgetBytes) * 100) }) : '';
        showWarning();
        break;
      default:
        // an event a package's worker command posted (E.postEvent): handed to the listeners of api.on('ext:<name>')
        if (typeof m.event === 'string' && m.event.indexOf('ext:') === 0) emit(m.event, m);
        break;
    }
  }

  function cancelRunning() {
    if (S.loadAbort) S.loadAbort.abort();
    const c = S.worker;
    if (!c) return;
    for (const [id, e] of c.pending) if (LONG_COMMANDS.has(e.cmd) || e.long) call('cancel', { targetId: id }).catch(() => {});
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

  // One view per open image (shell.layout owns them); every use of "the display" goes through these.
  const viewOf = (docId) => (S.shell && docId !== null && docId !== undefined ? S.shell.view(docId) : null);
  const activeView = () => viewOf(S.activeId);
  const allViews = () => (S.shell ? S.shell.layout.views() : []);
  /** The open images in visual order (tabs, then floating windows, then minimised ones). */
  function winOrder() {
    const ord = S.shell ? S.shell.layout.order().filter((id) => S.docs.has(id) && !S.hidden.has(id)) : [];
    for (const id of S.order) if (S.docs.has(id) && !S.hidden.has(id) && !ord.includes(id)) ord.push(id);
    return ord;
  }
  /** Pixel previews are cleared on the views that show one, never on the others. */
  function clearPreviews() { for (const id of S.previewDocs) { const v = viewOf(id); if (v) v.setPreview(null); } S.previewDocs.clear(); }
  function clearOverlays() { for (const id of S.overlayDocs) { const v = viewOf(id); if (v) v.setOverlay(null); } S.overlayDocs.clear(); }
  /** Transient overlay items go on the view of `docId` only. */
  function setOverlayFor(docId, items) {
    clearOverlays();
    const v = viewOf(docId);
    if (v && items) { v.setOverlay(items); S.overlayDocs.add(docId); S.overlayDoc = docId; }
  }
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
  function dirtyDocs() { return S.order.filter((id) => S.docs.has(id) && !S.hidden.has(id) && isDirty(id)); }
  /** The images the operator sees (a hidden one has no view, no tab, no menu entry and is no choice of a dialog). */
  const shownDocs = () => S.order.filter((id) => S.docs.has(id) && !S.hidden.has(id));

  function snapshot() {
    const info = activeInfo();
    const u = info ? S.undo.get(info.docId) || { undo: 0, redo: 0 } : { undo: 0, redo: 0 };
    return {
      doc: info, roi: info ? selOf(info.docId) : null, prevRoi: info ? S.prevSel.get(info.docId) || null : null,
      busy: S.busy, nDocs: shownDocs().length,
      canUndo: info ? (info.undoDepth !== undefined ? info.undoDepth > 0 : u.undo > 0) : false,
      canRedo: info ? (info.redoDepth !== undefined ? info.redoDepth > 0 : u.redo > 0) : false,
      dirty: info ? isDirty(info.docId) : false,
      hasResults: S.results.length > 0,
      canProject: !!(S.desc && S.desc.available),
      docs: shownDocs().map((id) => S.docs.get(id)),
      threshold: S.threshold,
      activeChannel: info ? activeChannel(info) : 0
    };
  }

  function registerDoc(info, { clean = true, sessionKey = null, provenance = null } = {}) {
    const id = info.docId;
    const isNew = !S.docs.has(id);
    S.docs.set(id, info);
    if (info.hidden) S.hidden.add(id);
    S.annotDims.set(id, { w: info.width, h: info.height });
    if (!S.order.includes(id)) S.order.push(id);
    S.undo.set(id, { undo: 0, redo: 0 });
    const rev = info.rev !== undefined ? info.rev : 0;
    S.revs.set(id, rev);
    if (clean) S.cleanRev.set(id, rev);
    if (sessionKey) S.sessionKeys.set(id, sessionKey);
    if (provenance) S.sources.set(id, provenance);
    initDisplayState(info);
    if (!S.activeCh.has(id)) S.activeCh.set(id, 0);
    if (isNew) emit('doc', { docId: id, kind: 'opened' });
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
    // overlays belong to the pixel grid they were made on: another size drops them (PLAN-wave3 §2.5)
    const was = S.annotDims.get(docId);
    S.annotDims.set(docId, { w: info.width, h: info.height });
    if (was && (was.w !== info.width || was.h !== info.height)) clearAnnotations(docId);
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
  function pushDisplay(docId) {
    const id = docId !== undefined && docId !== null ? docId : S.activeId;
    if (!S.shell || id === null) return;
    const st = displayStateFor(id);
    if (st) S.shell.setDisplayState(st, id);
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
    pushDisplay(docId);
    const key = docId + ':' + channel;
    S.displayPatch.set(key, Object.assign(S.displayPatch.get(key) || {}, patch));
    flushDisplayPatch(docId, channel);
    if (docId === S.activeId) scheduleToolRefresh('display');
    emit('doc', { docId, kind: 'display' });
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
    pushDisplay(docId);
    call('doc.setDisplay', Object.assign({ docId }, patch)).catch((err) => console.error('[advanced-studio] setDisplay', err));
    if (docId === S.activeId) scheduleToolRefresh('display');
    emit('doc', { docId, kind: 'display' });
  }

  /** fromShell: the pointer drew it (the shell already shows it); otherwise the shell is told. */
  function setSelection(docId, roi, final, fromShell) {
    const cur = S.sel.get(docId) || null;
    if (cur && (!roi || final !== false)) S.prevSel.set(docId, cur);
    if (roi) S.sel.set(docId, roi); else S.sel.delete(docId);
    if (!fromShell && S.shell) S.shell.setActiveRoi(roi || null, docId);
    if (docId === S.activeId) {
      // The menus' enabled state depends on whether there is a selection and of which kind: a
      // pointer move that only reshapes it (draw / move / resize, final === false) changes neither.
      if (final !== false || !cur || !roi || cur.type !== roi.type) refreshUi();
      scheduleToolRefresh('selection');
    }
    emit('roi', { docId, roi: roi || null, final: final !== false });
  }

  function refreshRois() {
    if (!S.shell) return;
    for (const id of S.order) {
      if (!viewOf(id)) continue;
      const list = S.roiList.filter((r) => r.docId === id);
      S.shell.setRois({ all: list.map((r) => ({ roi: r.roi, label: r.name, stroke: r.stroke, width: r.width, fill: r.fill })), showAll: S.showAll }, id);
    }
  }

  function tileProvider(docId) {
    return (channel, level, tx, ty) => call('doc.tile', { docId, channel, level, tx, ty });
  }

  /**
   * Makes sure `docId` has its own view (created on first call, placed as `place` says: { placement, anchor, docIds })
   * and brings it up to date with the engine's info. Does NOT activate it (a worker invalidate of a background tab
   * must not steal the focus); showDoc does.
   */
  function refreshView(docId, place) {
    const info = S.docs.get(docId);
    if (!info || !S.shell || S.hidden.has(docId)) return null;
    hideEmpty();
    S.placing = true;
    try { S.shell.setImage(viewInfo(docId), place || {}); } finally { S.placing = false; }
    const v = viewOf(docId);
    if (v) {
      v.setTileProvider(tileProvider(docId));
      S.shell.setActiveRoi(selOf(docId), docId);
      pushDisplay(docId);
      if (typeof v.setInterpolate === 'function') v.setInterpolate(!!settingGet('appearance.interpolate'));
      const ar = S.annot.get(docId);
      if (ar && typeof v.setAnnotations === 'function') v.setAnnotations(ar.items, ar.visible);
    }
    refreshRois();
    syncRebind();
    return v;
  }

  /** What follows an activation, whoever caused it (a tab click, a menu entry, showDoc). */
  function afterActivate(docId) {
    if (!S.docs.has(docId)) return;
    const changed = S.activeId !== docId;
    S.activeId = docId;
    hideEmpty();
    syncWindowMenu();
    refreshUi();
    scheduleToolRefresh('doc');
    if (changed) {
      // a floating state (a paste) is committed before another image takes over
      if (S.pending) flushPending();
      if (S.lastActiveEmitted !== docId) { S.lastActiveEmitted = docId; emit('activeDoc', docId); }
    }
  }

  /** The view of `docId` is refreshed and becomes the active one. */
  async function showDoc(docId, place) {
    const info = S.docs.get(docId);
    if (!info || !S.shell || S.hidden.has(docId)) return;
    const v = refreshView(docId, place);
    if (!v) return;
    S.placing = true;
    try { S.shell.layout.activate(docId); } finally { S.placing = false; }
    afterActivate(docId);
  }

  /** New images made from `fromId` (default: the active one) take its provenance and session; the last is shown. */
  async function adoptNewDocs(ids, fromId, placement) {
    let last = null;
    const from = fromId !== undefined && fromId !== null ? fromId : S.activeId;
    const got = [];
    for (const id of ids || []) {
      const info = await call('doc.info', { docId: id });
      registerDoc(info, { clean: false, provenance: S.sources.get(from) || null, sessionKey: S.sessionKeys.get(from) || null });
      got.push(id);
      last = id;
    }
    // Every new image gets a view; placement 'gridWithSource' puts them all, with the source, in one grid.
    const place = placement ? { placement, anchor: from, docIds: got } : {};
    for (const id of got) refreshView(id, place);
    if (placement === 'gridWithSource' && S.docs.has(from)) {
      await showDoc(from);
      // a grid keeps the source open beside its copies: when memory is getting full, say that closing it frees some
      if (S.engineBudget > 0 && S.engineUsed / S.engineBudget >= GRID_MEMORY_FRACTION) setStatus(tr('status.gridMemory'));
    } else if (last !== null) await showDoc(last);
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
    S.persistTimer = setTimeout(persistMeta, PERSIST_MS);
  }

  /** Tool windows worth reopening after a reload: the built-in ones and the panels that asked for it. */
  function persistedWindows() {
    return Array.from(S.wins.keys()).filter((id) => Object.prototype.hasOwnProperty.call(TOOL_WINDOWS, id) || (EXT.panels.has(id) && EXT.panels.get(id).spec.persist === true));
  }

  /**
   * The UI state belongs to the sessions of the images being edited; with no stored session there is nothing to attach it
   * to (a meta write must never create a session without a document). The layout, the sync state, the registered
   * look-up tables and the packages' data go into EVERY touched session (restore filters them by the restored images);
   * the annotations into the session of the image they belong to; Results, the ROI list and the open windows into the
   * session of the active image only (they are added to what is already open, a second copy would double them).
   */
  function persistMeta() {
    if (!S.worker || S.worker.dead) return;
    const keys = Array.from(new Set(S.sessionKeys.values()));
    if (!keys.length) return;
    const primary = (S.activeId !== null && S.sessionKeys.get(S.activeId)) || keys[0];
    const layout = S.shell ? S.shell.layout.serialize() : null;
    const luts = {};
    for (const [name, table] of S.luts) luts[name] = Array.from(table);
    for (const key of keys) {
      const annotations = {};
      for (const id of S.order) if (S.sessionKeys.get(id) === key && S.annot.has(id) && S.annot.get(id).items.length) annotations[id] = { visible: S.annot.get(id).visible, items: S.annot.get(id).items };
      const msg = { key, layout, annotations, sync: syncState(), luts, ext: S.extData };
      if (key === primary) {
        msg.results = S.results;
        msg.rois = S.roiList.map((r) => { const o = { name: r.name, docId: r.docId, roi: r.roi }; for (const k of ['stroke', 'width', 'fill']) if (r[k] !== undefined) o[k] = r[k]; return o; });
        msg.measurements = S.measurements;
        msg.windows = persistedWindows();
      }
      call('session.putMeta', msg).then((res) => {
        // what the engine could not keep (too large) is said once; the rest was stored
        if (res && Array.isArray(res.dropped) && res.dropped.length && !S.metaWarned) { S.metaWarned = true; setStatus(tr('warn.metaTooLarge')); }
      }).catch((err) => console.error('[advanced-studio] putMeta', err));
    }
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
          const dv = viewOf(docId);
          if (dv) dv.invalidate(d.changed ? d.changed.channels : undefined);
          commitHook();
          refreshUi();
        }
        throw err;
      }
      applyRunResult(docId, res);
      const ch = res.changed || {};
      const active = docId === S.activeId;
      const rv = viewOf(docId);
      if (ch.sizeChanged) {
        // Same geometry (a channel reorder): the selection, the overlays and the view stay.
        if (!ch.sameGeometry) { S.sel.delete(docId); clearAnnotations(docId); }
        refreshView(docId);
        if (rv && !ch.sameGeometry) rv.fit();
        if (active) scheduleToolRefresh('doc');
      } else if (ch.calibration) {
        // metadata only: the selection and the view stay
        if (S.shell) S.shell.updateInfo(viewInfo(docId));
        refreshUi();
      } else {
        if (rv) rv.invalidate(ch.channels);
        pushDisplay(docId);
        if (active) { refreshRois(); scheduleToolRefresh('pixels'); }
      }
      if (!(res.newDocIds && res.newDocIds.length)) emit('doc', { docId, kind: ch.sizeChanged || ch.calibration ? 'size' : 'pixels' });
      if (res.newDocIds && res.newDocIds.length) await adoptNewDocs(res.newDocIds, docId, opt.placement);
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
      const uv = viewOf(info.docId);
      if (res.changed && res.changed.sizeChanged) { if (!res.changed.sameGeometry) { S.sel.delete(info.docId); clearAnnotations(info.docId); } await showDoc(info.docId); if (uv && !res.changed.sameGeometry) uv.fit(); }
      else if (res.changed && res.changed.calibration) { S.shell.updateInfo(viewInfo(info.docId)); refreshUi(); }
      else { if (uv) uv.invalidate(res.changed ? res.changed.channels : undefined); pushDisplay(info.docId); }
      scheduleToolRefresh('pixels');
      scheduleMetaPersist();
      emit('doc', { docId: info.docId, kind: res.changed && (res.changed.sizeChanged || res.changed.calibration) ? 'size' : 'pixels' });
    });
  }

  /** The value Fill (white = the foreground colour) and Clear (the background colour) write: ImageJ's setColor, see colorValueOf. */
  function fillValue(info, channel, white) {
    return colorValueOf(info.docId, channel, white ? 'foreground' : 'background');
  }

  // ── dialogs: the field types the engine of the packages need, resolved against the open images ──

  function docOptions(filter) {
    const out = [];
    for (const id of S.order) {
      const info = S.docs.get(id);
      if (!info || S.hidden.has(id)) continue;
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
    clearPreviews(); clearOverlays();
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
          if ((region.x1 - region.x0) * (region.y1 - region.y0) > PREVIEW_COMPUTE_PIXELS) { clearOverlays(); note(tr('dlg.previewZoomIn')); return; }
          note(null);
          compute(pv.compute, params, { docId: info.docId, channel, roi, region, preview: true }).then((res) => {
            if (seq !== S.previewSeq || res === null || res === undefined) return;
            const items = typeof pv.overlay === 'function' ? pv.overlay(res, values) : null;
            setOverlayFor(info.docId, items);
          }).catch((err) => { if (!err || (err.code !== 'IJ_CANCELLED' && err.code !== 'IJ_SUPERSEDED')) console.error('[advanced-studio] compute preview', err); });
          return;
        }
        S.previewTimer = setTimeout(() => {
          const level = (viewOf(info.docId) ? viewOf(info.docId).getView().level : 0) || 0;
          call('doc.preview', { docId: info.docId, seq, op: pv.op, params, roi, channel, level, x0: region.x0, y0: region.y0, x1: region.x1, y1: region.y1 })
            .then(() => note(null))
            .catch((err) => { if (err && err.code === 'IJ_PREVIEW_TOO_LARGE') { clearPreviews(); note(tr('dlg.previewZoomIn')); } else console.error('[advanced-studio] preview', err); });
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
    const v = viewOf(info.docId);
    return v ? v.visibleRect() : { x0: 0, y0: 0, x1: info.width, y1: info.height };
  }
  function previewHooks(op, buildParams, info, allChannels) {
    return {
      onChange(values, ctl) {
        clearTimeout(S.previewTimer);
        if (!values) { S.previewSeq++; clearPreviews(); if (ctl) ctl.note(null); return; }
        S.previewTimer = setTimeout(() => {
          const seq = ++S.previewSeq;
          const r = visibleRect(info);
          const level = (viewOf(info.docId) ? viewOf(info.docId).getView().level : 0) || 0;
          call('doc.preview', { docId: info.docId, seq, op, params: buildParams(values), roi: selOf(info.docId),
            channel: values.all && allChannels ? 'all' : activeChannel(info), level,
            x0: Math.max(0, Math.floor(r.x0)), y0: Math.max(0, Math.floor(r.y0)),
            x1: Math.min(info.width, Math.ceil(r.x1)), y1: Math.min(info.height, Math.ceil(r.y1)) })
            .then(() => { if (ctl && seq === S.previewSeq) ctl.note(null); })
            .catch((err) => {
              if (err && err.code === 'IJ_PREVIEW_TOO_LARGE' && ctl) { clearPreviews(); if (seq === S.previewSeq) ctl.note(tr('dlg.previewZoomIn')); }
              else console.error('[advanced-studio] preview', err);
            });
        }, 90);
      }
    };
  }
  function endPreview() {
    clearTimeout(S.previewTimer);
    S.previewSeq++;
    clearPreviews();
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

  async function savePng(docId) {
    const info = docId !== undefined && docId !== null ? S.docs.get(docId) : activeInfo();
    const sv = info ? viewOf(info.docId) : null;
    if (!info || !sv || !sv.renderToCanvas) return;
    try {
      await saveFile(safeName(info.name, '.png'), 'image/png', '.png', 'PNG', async () => {
        const canvas = await sv.renderToCanvas({ scale: 1 });
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
        if (viewOf(info.docId)) viewOf(info.docId).fit();
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
      if (viewOf(info.docId)) viewOf(info.docId).fit();
    });
  }

  /** Drop every local trace of a document (the engine has been told, or is gone). */
  function forgetDoc(id) {
    const key = S.sessionKeys.get(id);
    for (const m of [S.docs, S.activeCh, S.dstate, S.sel, S.prevSel, S.undo, S.cleanRev, S.revs, S.sessionKeys, S.sources, S.annot, S.annotDims]) m.delete(id);
    S.unprotected.delete(id); S.held.delete(id); S.hidden.delete(id);
    S.order = S.order.filter((x) => x !== id);
    S.roiList = S.roiList.filter((r) => r.docId !== id);
    if (S.redirect && S.redirect.docId === id) S.redirect = null;
    if (S.sync.docs.delete(id)) syncRebind();
    if (key && !Array.from(S.sessionKeys.values()).includes(key)) releaseSessionLock(key);
    emit('doc', { docId: id, kind: 'closed' });
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
    const wasActive = S.activeId === id;
    const next = S.shell ? S.shell.layout.neighbour(id) : null;
    S.previewDocs.delete(id); S.overlayDocs.delete(id);
    forgetDoc(id);
    if (S.shell) { S.placing = true; try { S.shell.removeImage(id); } finally { S.placing = false; } }
    if (wasActive) {
      S.activeId = null;
      if (S.order.length) await showDoc(next !== null && S.docs.has(next) ? next : S.order[S.order.length - 1]);
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
      // the tables an extension registered must exist before a view names one
      if (res.meta) await restoreLuts(res.meta);
      let last = null;
      const wasEmpty = !winOrder().length;
      const restored = [];
      for (const id of res.docIds || []) {
        const info = await call('doc.info', { docId: id });
        registerDoc(info, { clean: false, sessionKey: key });
        restored.push(id);
        if (!info.hidden) last = id;
        count++;
      }
      if (count) holdSessionLock(key);
      // every restored image gets a view; the stored layout is applied only on an empty workspace, otherwise they join as tabs
      for (const id of restored) refreshView(id);
      if (res.meta) restoreMeta(res.meta, { ids: restored, applyLayout: wasEmpty });
      if (last !== null) {
        const act = S.shell && S.shell.layout.active() !== null && restored.includes(S.shell.layout.active()) ? S.shell.layout.active() : last;
        await showDoc(act);
        for (const id of restored) { const rv = viewOf(id); if (rv) rv.fit(); }
      }
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
  function restoreMeta(meta, o) {
    const opt = o || {};
    if (opt.applyLayout && meta.layout && S.shell) {
      S.placing = true;
      try { S.shell.layout.restoreFrom(meta.layout, winOrder()); } finally { S.placing = false; }
    }
    // the tool windows the session had open come back (the id list is data from storage: only known windows and panels)
    if (Array.isArray(meta.windows)) {
      for (const id of meta.windows) {
        if (S.wins.has(id)) continue;
        try {
          if (Object.prototype.hasOwnProperty.call(TOOL_WINDOWS, id)) openTool(id);
          else if (EXT.panels.has(id) && EXT.panels.get(id).spec.persist === true) openPanelExt(id, { focus: false }).catch((err) => console.error('[advanced-studio] reopen', err));
        } catch (err) { console.error('[advanced-studio] reopen', err); }
      }
    }
    if (Array.isArray(meta.results)) S.results = S.results.concat(meta.results);
    if (Array.isArray(meta.rois)) {
      const known = new Set(S.roiList.map((r) => r.docId + '|' + r.name));
      for (const r of meta.rois) {
        if (!r || !r.roi) continue;
        const k = r.docId + '|' + r.name;
        if (known.has(k)) continue;
        known.add(k);
        const entry = { name: r.name, docId: r.docId, roi: r.roi };
        for (const s of ['stroke', 'width', 'fill']) if (r[s] !== undefined) entry[s] = r[s];
        S.roiList.push(entry);
      }
    }
    // persistent annotations of the restored images (data from storage: every item is checked again)
    if (meta.annotations && typeof meta.annotations === 'object' && !Array.isArray(meta.annotations)) {
      for (const id of Object.keys(meta.annotations)) {
        if (!S.docs.has(id) || (opt.ids && !opt.ids.includes(id))) continue;
        const rec = meta.annotations[id];
        if (!rec || !Array.isArray(rec.items)) continue;
        try {
          const items = [];
          for (const raw of rec.items.slice(0, ANNOTATIONS_MAX)) { try { items.push(Object.assign(cleanAnnotation(raw), { id: annotationId(raw, items) })); } catch (err) { console.error('[advanced-studio] annotation dropped', err); } }
          S.annot.set(id, { visible: rec.visible !== false, items });
          pushAnnotations(id, false);
        } catch (err) { console.error('[advanced-studio] annotations', err); }
      }
    }
    if (meta.sync && typeof meta.sync === 'object') applySyncState(meta.sync);
    if (meta.ext && typeof meta.ext === 'object' && !Array.isArray(meta.ext)) {
      for (const pkg of Object.keys(meta.ext)) if (PKG_PREFIX[pkg] !== undefined && S.extData[pkg] === undefined) S.extData[pkg] = meta.ext[pkg];
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
    if (!S.shell || S.emptyEl) return;
    S.emptyEl = h('div', { class: 'ij-empty' },
      h('p', { class: 'ij-banner', text: tr('empty.message') }),
      row(btn(tr('cmd.stackProject'), () => zProject(), 'ij-btn--primary'), btn(tr('cmd.fileOpen'), () => openTiff()), btn(tr('cmd.fileSimple'), () => simpleView())));
    S.shell.workspace.appendChild(S.emptyEl);
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
    if (!S.shell) return;
    S.emptyEl = h('div', { class: 'ij-empty' }, h('p', { class: 'ij-banner', text }),
      row(btn(tr('cmd.fileSimple'), () => simpleView(), 'ij-btn--primary')));
    S.shell.workspace.appendChild(S.emptyEl);
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
        // the placeholder lives in the view of the document being built (its own tab)
        fake.docId = docId;
        S.shell.setImage(fake, {});
        if (viewOf(docId)) viewOf(docId).setTileProvider(prov);
        hideEmpty();
      }
      // Progress counts the lossless voxels delivered, so its total is the voxels the read
      // delivers — not session.estimateBytes(), which counts the compressed bytes fetched and is
      // smaller. See projectionProgress.
      const bands = Math.ceil(session.height / bandRows);
      const zChunk = Math.max(1, session.zChunk || 1);
      const chIdx = channels.map((c) => c.index);
      const totalPlanes = depth * bands;
      const lang = (S.ctx && S.ctx.i18n && typeof S.ctx.i18n.getLanguage === 'function') ? S.ctx.i18n.getLanguage() : undefined;
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
          const pg = projectionProgress({ width: session.width, height: session.height, depth, channels: channels.length, loaded: loadedBytes, donePlanes, totalPlanes, lang });
          if (S.shell) {
            S.shell.setProgress({ fraction: pg.fraction, cancellable: true, label: tr('load.status', { pct: pg.pct, band: bi + 1, bands,
              z0: lvDesc.indices[z0], z1: lvDesc.indices[z1 - 1], mv: pg.mv, total: pg.total }) });
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
      if (viewOf(docId)) viewOf(docId).fit();
      commitHook();
    } catch (err) {
      if (docId !== null && !ok) call('doc.close', { docId }).catch(() => {});
      if (S.shell && docId !== null && !ok && S.shell.view(docId)) { S.placing = true; try { S.shell.removeImage(docId); } finally { S.placing = false; } }
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
      if (viewOf(res.info.docId)) viewOf(res.info.docId).fit();
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
    const v = activeView();
    if (!v) return;
    const g = v.getView();
    v.zoomAt(g.viewportWidth / 2, g.viewportHeight / 2, dir);
  }
  const zoom100 = () => { const v = activeView(); if (v) v.view100(); };
  const zoomFit = () => { const v = activeView(); if (v) v.fit(); };
  function zoomToSelection() {
    const info = activeInfo();
    const roi = info && selOf(info.docId);
    const v = activeView();
    if (!roi || !v || typeof IJRoi === 'undefined') return;
    v.zoomToRect(IJRoi.bounds(roi));
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
    const ord = winOrder();
    if (ord.length < 2) return;
    const i = ord.indexOf(S.activeId);
    const next = ord[(i + dir + ord.length) % ord.length];
    showDoc(next);
  }

  function simpleView() { S.leaving = 'simple'; return S.api.exit(); }
  function closeStudio() { return S.api.close(); }

  // ───────────────────────────── tool windows ─────────────────────────────

  const TOOL_WINDOWS = { bc: buildBC, channels: buildChannels, threshold: buildThreshold, results: buildResults, roiManager: buildRoiManager, summary: buildSummary, sync: buildSync };

  /** `o` = { width, height } of a window opened for the first time (a size the operator chose is kept by the shell). */
  function floatingWindow(id, titleKey, build, o) {
    if (!S.shell) return null;
    const existing = S.wins.get(id);
    if (existing) { existing.focus(); const u = S.winUpdaters.get(id); S.lastToolReady = Promise.resolve(u ? u('doc') : undefined); return existing; }
    const view = build();
    const spec = { id, title: tr(titleKey), content: view.el, onClose: () => {
      S.wins.delete(id); S.winUpdaters.delete(id);
      if (view.dispose) view.dispose();
      scheduleMetaPersist();
      syncWindowMenu();
    } };
    if (o && o.width > 0) spec.width = o.width;
    const win = S.shell.windows.floating(spec);
    if (o && o.height > 0 && win && win.el && win.el.style && !win.el.style.height) win.el.style.height = o.height + 'px';
    S.wins.set(id, win);
    S.lastToolReady = Promise.resolve(view.update ? view.update('doc') : undefined);
    if (view.update) S.winUpdaters.set(id, view.update);
    scheduleMetaPersist();
    syncWindowMenu();
    return win;
  }

  function openTool(id) {
    const titles = { bc: 'cmd.adjustBC', channels: 'cmd.colorChannels', threshold: 'cmd.adjustThreshold', results: 'win.results', roiManager: 'cmd.toolsRoiManager', summary: 'part.summaryTitle', sync: 'cmd.toolsSyncWindows' };
    if ((id === 'bc' || id === 'channels' || id === 'threshold') && !activeInfo()) return;
    floatingWindow(id, titles[id], TOOL_WINDOWS[id]);
  }

  let toolTimer = 0;
  function scheduleToolRefresh(kind) {
    if (kind === 'results') emit('results');
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
    const T = { method: 'Default', dark: S.thrDark !== false, mode: 'red', lower: 0, upper: 255, overlayDoc: null };
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
      // the overlay is drawn on the view of the image the window works on, and only there
      if (T.overlayDoc !== undefined && T.overlayDoc !== null && (!info || T.overlayDoc !== info.docId)) { const ov = viewOf(T.overlayDoc); if (ov) ov.setThresholdOverlay(null); T.overlayDoc = null; }
      if (info && viewOf(info.docId)) { viewOf(info.docId).setThresholdOverlay({ channel: activeChannel(info), lower: T.lower, upper: T.upper, mode: T.mode }); T.overlayDoc = info.docId; }
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
      if (T.overlayDoc !== null && T.overlayDoc !== undefined && viewOf(T.overlayDoc)) viewOf(T.overlayDoc).setThresholdOverlay(null);
      T.overlayDoc = null;
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
      // 'setRange' (api.setThreshold): the range, and the polarity when given, are set from outside
      update(kind, payload) {
        if (kind === 'setRange' && payload) {
          T.lower = payload.lower; T.upper = payload.upper;
          if (payload.dark !== undefined) { T.dark = !!payload.dark; S.thrDark = T.dark; }
          commit();
          return undefined;
        }
        if (kind === 'doc' || kind === 'pixels') { const p = refresh(first); first = false; return p; } else if (kind === 'display') commit();
        return undefined;
      },
      dispose() { S.threshold = null; if (T.overlayDoc !== null && T.overlayDoc !== undefined && viewOf(T.overlayDoc)) viewOf(T.overlayDoc).setThresholdOverlay(null); T.overlayDoc = null; }
    };
  }
  function IJThresholdMethods() {
    return typeof IJThreshold !== 'undefined' && IJThreshold.methods ? IJThreshold.methods() : ['Default', 'Huang', 'IsoData', 'Li', 'MaxEntropy', 'Mean', 'Otsu', 'Triangle'];
  }

  // ── Synchronize Windows (ij.plugin.frame.SyncWindows, the part this port keeps: cursor, zoom and pan)

  function buildSync() {
    const list = h('div', { class: 'ij-list is-multi', attrs: { role: 'group' } });
    function docsNow() { return shownDocs().map((id) => S.docs.get(id)); }
    function renderDocs() {
      list.textContent = '';
      for (const info of docsNow()) {
        list.appendChild(h('div', { class: 'ij-list-row' }, check(info.name, S.sync.docs.has(info.docId), (on) => {
          if (on) S.sync.docs.add(info.docId); else S.sync.docs.delete(info.docId);
          syncRebind(); scheduleMetaPersist();
          if (on) syncViews(info.docId);
        })));
      }
    }
    const setFlag = (k) => (on) => { S.sync[k] = on; scheduleMetaPersist(); };
    const el = h('div', { class: 'ij-panel ij-sync' },
      check(tr('sync.cursor'), S.sync.cursor, setFlag('cursor')),
      check(tr('sync.imageCoords'), S.sync.imageCoords, setFlag('imageCoords')),
      check(tr('sync.scaling'), S.sync.scaling, setFlag('scaling')),
      list,
      row(btn(tr('sync.all'), () => { for (const i of docsNow()) S.sync.docs.add(i.docId); syncRebind(); renderDocs(); scheduleMetaPersist(); if (S.activeId !== null) syncViews(S.activeId); }),
        btn(tr('sync.none'), () => { S.sync.docs.clear(); syncRebind(); renderDocs(); scheduleMetaPersist(); for (const v of allViews()) if (v.setCursorMark) v.setCursorMark(null); })));
    renderDocs();
    return { el, update(kind) { if (kind === 'doc' || kind === 'layout') renderDocs(); } };
  }

  function syncWindows() { openTool('sync'); }

  // ── Results

  const RESULTS_CAP = 20000;
  function buildResults() {
    const table = h('table', { class: 'ij-table' });
    const note = h('p', { class: 'ij-banner' });
    note.hidden = true;
    const wrap = h('div', { class: 'ij-table-wrap' }, table);
    // shownCols starts as null so the first render always builds the table, even an empty one
    // (no rows = no columns = '' would otherwise skip the build and leave tbody null).
    let shown = 0, shownCols = null, tbody = null, firstRef = null;
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
    S.shell.windows.floating({ id, title, content, onClose: () => syncWindowMenu() });
    syncWindowMenu();
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
    const win = S.shell.windows.floating({ id, title, content, onClose: () => { if (observer) { try { observer.disconnect(); } catch (_) { /* gone */ } } syncWindowMenu(); } });
    syncWindowMenu();
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
    const tableWin = S.shell.windows.floating({ id: 'table-' + (++S.openCounter), title, content, onClose: () => syncWindowMenu() });
    syncWindowMenu();
    return tableWin;
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

  /** The command list the shell reads: the registry (shortcuts = every key), then the dynamic Window rows. */
  function buildMenuList() {
    const open = (id) => S.wins.has(id);
    const list = COMMANDS
      // Results and ROI Manager open the window while it is closed; an open one is listed by its own row below
      .filter((c) => !((c.id === 'windowResults' && open('results')) || (c.id === 'windowRoiManager' && open('roiManager'))))
      .map((c) => Object.assign({}, c, {
        shortcut: c.keys.length ? c.keys.slice() : null,
        // a package that did not load: its commands stay in the menus, greyed, with a tooltip
        unavailable: c.pkg ? () => S.failedPackages.has(c.pkg) : undefined
      }));
    // ImageJ: the open non-image windows come BEFORE the images, after a separator (Menus.insertWindowMenuItem)
    const tools = S.shell ? S.shell.windows.list().filter((w) => w.win && (typeof w.win.isOpen !== 'function' || w.win.isOpen())) : [];
    let firstTool = true;
    const staticRows = list.filter((c) => c.id === 'windowResults' || c.id === 'windowRoiManager');
    tools.forEach((w, k) => {
      list.push({ id: 'winTool' + w.id, menu: ['Window'], label: w.title, order: 52 + k / 1000, separatorBefore: firstTool && !staticRows.length,
        enabled: () => true, run: () => { if (w.win && w.win.focus) w.win.focus(); }, shortcut: null, keys: [], dynamic: true, repeatable: false });
      firstTool = false;
    });
    if (staticRows.length) staticRows[0].separatorBefore = true;
    const ord = winOrder();
    ord.forEach((id, k) => {
      const info = S.docs.get(id);
      if (info) list.push({ id: 'winImg' + id, menu: ['Window'], label: info.name + ' ' + info.width + 'x' + info.height, order: 60 + k / 1000, separatorBefore: k === 0,
        enabled: () => true, run: () => showDoc(id), shortcut: null, keys: [], dynamic: true, repeatable: false });
    });
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
    // ImageJ's Executer remembers what ran (except Undo and Close) so Repeat Command can run it again
    if (c.repeatable !== false && !c.dynamic) S.lastCommand = c.id;
    return Promise.resolve()
      .then(() => flushPending())       // a floating paste is committed before anything else runs
      .then(() => c.run(c.ext ? apiFor(c.pkg) : API))
      .catch((err) => reportError(err));
  }

  function refreshUi() { if (S.shell) S.shell.refreshMenus(); }

  function readPixel(x, y, docId) {
    const info = docId !== undefined && docId !== null ? S.docs.get(docId) : activeInfo();
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

  // Window › Show All / Put Behind / Cascade / Tile: the workspace layout does the work (ij-layout.js).
  function layoutOp(name) { if (S.shell && S.shell.layout && typeof S.shell.layout[name] === 'function') S.shell.layout[name](); }
  const showAll = () => layoutOp('showAll');
  const putBehind = () => layoutOp('putBehind');
  const cascade = () => layoutOp('cascade');
  const tile = () => layoutOp('tile');

  // The facade the commands receive.
  const API = {
    openTiff, saveTiff, savePng, saveResults, revert, recover: recoverDialog, closeImage: () => closeImage(), simpleView, closeStudio,
    undo: () => undoRedo('undo'), redo: () => undoRedo('redo'), clearSel, fillSel, invert, selectAll, selectNone, restoreSelection, makeInverse, addToManager,
    convertType, openTool, showInfo, zProject, crop, duplicate, simpleOp, zoom, zoom100, zoomToSelection, zoomFit, applyLut, setLut, invertLut,
    convertToMask, binary, math, gaussian, rank, measure, particles, clearResults, setMeasurements, histogram, plotProfile, cycleImage, showAbout, showShortcuts,
    summarize, distribution, showAll, putBehind, cascade, tile, syncWindows
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
      doc: liveInfo(info), docs: shownDocs().map((id) => liveInfo(S.docs.get(id))), roi: info ? selOf(info.docId) : null, busy: S.busy,
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
    if (!info || !viewOf(info.docId)) return { ok: false };
    const seq = ++S.previewSeq;
    const r = visibleRect(info);
    try {
      await call('doc.preview', { docId: info.docId, seq, op, params: params || {}, roi: opt.roi !== undefined ? opt.roi : selOf(info.docId),
        channel: opt.channel !== undefined ? opt.channel : activeChannel(info), level: viewOf(info.docId).getView().level || 0,
        x0: Math.max(0, Math.floor(r.x0)), y0: Math.max(0, Math.floor(r.y0)), x1: Math.min(info.width, Math.ceil(r.x1)), y1: Math.min(info.height, Math.ceil(r.y1)) });
    } catch (err) {
      if (err && err.code === 'IJ_PREVIEW_TOO_LARGE') { clearPreviews(); return { ok: false, tooLarge: true }; }
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
      if (S.shell) S.shell.updateInfo(viewInfo(docId));
      syncWindowMenu();
      scheduleMetaPersist();
      emit('doc', { docId, kind: 'renamed' });
      return res ? res.info : null;
    } catch (err) { await reportError(err); return null; }
  }

  const TOOL_IDS = ['bc', 'channels', 'threshold', 'results', 'roiManager', 'summary', 'sync'];

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
    pushDisplay(docId);
    if (docId === S.activeId) scheduleToolRefresh('display');
    emit('doc', { docId, kind: 'display' });
    await call('doc.setDisplay', Object.assign({ docId, channel }, p));
    scheduleMetaPersist();
  }

  // ───────────────────────────── extension API, wave 3 (PLAN-wave3 §2.5, §2.6) ─────────────────────────────

  function forbidden(msg) { return Object.assign(new Error(msg), { code: 'IJ_EXT_FORBIDDEN' }); }
  function needDoc(docId) {
    if (docId === null || docId === undefined || !S.docs.has(docId)) throw extError('no such image');
    return S.docs.get(docId);
  }

  // ── events ──
  function emit(event, payload) {
    const set = S.listeners.get(event);
    if (!set || !set.size) return;
    for (const fn of Array.from(set)) { try { fn(payload); } catch (err) { console.error('[advanced-studio] listener ' + event, err); } }
  }
  function on(event, fn) {
    if (typeof fn !== 'function' || typeof event !== 'string' || !(EVENT_NAMES.has(event) || /^ext:[A-Za-z][A-Za-z0-9.]*$/.test(event))) throw extError('on: ' + String(event));
    let set = S.listeners.get(event);
    if (!set) { set = new Set(); S.listeners.set(event, set); }
    set.add(fn);
    return () => { const s = S.listeners.get(event); if (s) s.delete(fn); };
  }

  // ── settings (localStorage 'lumen3d.ij.prefs') ──
  let prefsCache = null;
  function readPrefs() {
    if (prefsCache) return prefsCache;
    let o = null;
    try { o = JSON.parse(localStorage.getItem(PREFS_KEY) || 'null'); } catch (_) { o = null; }
    prefsCache = o && typeof o === 'object' && !Array.isArray(o) ? o : {};
    return prefsCache;
  }
  function settingGet(key) {
    const p = readPrefs();
    return typeof key === 'string' && Object.prototype.hasOwnProperty.call(p, key) ? p[key] : SETTING_DEFAULTS[key];
  }
  /** [r, g, b] of an ImageJ colour name or '#rrggbb'; null when it is neither. */
  function parseColorValue(v) {
    if (typeof v !== 'string') return null;
    const k = v.trim().toLowerCase();
    if (Object.prototype.hasOwnProperty.call(COLOR_NAMES, k)) return COLOR_NAMES[k].slice();
    const m = /^#?([0-9a-f]{6})$/.exec(k);
    if (!m) return null;
    const n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const cssColorOf = (v) => { const c = parseColorValue(v); return c ? '#' + c.map((x) => (x < 16 ? '0' : '') + x.toString(16)).join('') : null; };
  function settingSet(pkg, key, value) {
    if (typeof key !== 'string' || !/^[a-z][A-Za-z0-9]*(\.[A-Za-z0-9_]+)+$/.test(key)) throw extError('settings.set: key');
    const prefix = key.slice(0, key.indexOf('.'));
    const own = pkg ? PKG_PREFIX[pkg] : undefined;
    if (!(prefix === own || (pkg === 'edit' && CORE_SETTING_PREFIXES.indexOf(prefix) >= 0))) throw forbidden('settings.set: ' + key + ' is not a setting of package ' + String(pkg));
    let text;
    try { text = JSON.stringify(value); } catch (_) { text = undefined; }
    if (text === undefined || text.length > 65536) throw extError('settings.set: value');
    const p = readPrefs();
    p[key] = JSON.parse(text);
    try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch (_) { /* a per-viewer convenience only */ }
    if (key === 'appearance.interpolate') for (const v of allViews()) if (typeof v.setInterpolate === 'function') v.setInterpolate(!!p[key]);
    if (key === 'colors.selection') { const css = cssColorOf(p[key]); if (css) for (const v of allViews()) if (typeof v.setSelectionColor === 'function') v.setSelectionColor(css); }
  }

  // ── session data of a package ──
  function sessionDataGet(pkg, p) {
    if (!pkg || p !== pkg) throw forbidden('sessionData: only the data of the package itself');
    const v = S.extData[pkg];
    return v === undefined ? null : JSON.parse(JSON.stringify(v));
  }
  function sessionDataSet(pkg, p, json) {
    if (!pkg || p !== pkg) throw forbidden('sessionData: only the data of the package itself');
    if (json === null || json === undefined) { delete S.extData[pkg]; scheduleMetaPersist(); return; }
    let text;
    try { text = JSON.stringify(json); } catch (_) { text = undefined; }
    if (text === undefined || text.length > EXT_DATA_MAX) throw extError('sessionData: value (JSON, at most 256 KiB)');
    S.extData[pkg] = JSON.parse(text);
    scheduleMetaPersist();
  }

  // ── persistent annotations (PLAN-wave3 §2.5) ──
  const HEX6 = /^#[0-9a-fA-F]{6}$/;
  const HEX8 = /^#[0-9a-fA-F]{8}$/;
  const finiteNumber = (v) => typeof v === 'number' && isFinite(v);

  function cloneRoiPlain(roi) {
    const o = Object.assign({}, roi);
    if (roi.points) o.points = roi.points.map((p) => [p[0], p[1]]);
    if (roi.rle) o.rle = Array.from(roi.rle);
    return o;
  }
  function numberList(v, multiple, what) {
    if (v === undefined) return [];
    if (!Array.isArray(v) || v.length % multiple !== 0 || !v.every(finiteNumber)) throw extError('annotation ' + what);
    return v.slice();
  }
  /** A validated, normalised copy of an annotation item (no id yet). */
  function cleanAnnotation(raw) {
    if (!raw || typeof raw !== 'object' || ANNOTATION_KINDS.indexOf(raw.kind) < 0) throw extError('annotation kind');
    const out = { kind: raw.kind };
    const color = (v, what, nullable, rgba, fallback) => {
      if ((v === undefined || v === null) && (nullable || fallback !== undefined)) return v === undefined && fallback !== undefined ? fallback : null;
      if (typeof v !== 'string' || !(rgba ? HEX8 : HEX6).test(v)) throw extError('annotation ' + what);
      return v;
    };
    const nonNeg = (v, what, fallback) => {
      if (v === undefined && fallback !== undefined) return fallback;
      if (!finiteNumber(v) || v < 0) throw extError('annotation ' + what);
      return v;
    };
    const coord = (v, what) => { if (!finiteNumber(v)) throw extError('annotation ' + what); return v; };
    switch (raw.kind) {
      case 'roi':
        if (typeof IJRoi !== 'undefined') IJRoi.validate(raw.roi); else if (!raw.roi || typeof raw.roi !== 'object') throw extError('annotation roi');
        out.roi = cloneRoiPlain(raw.roi);
        out.stroke = color(raw.stroke, 'stroke', true, false);
        out.width = nonNeg(raw.width, 'width', 0);
        out.fill = color(raw.fill, 'fill', true, true);
        if (raw.name !== undefined) { if (typeof raw.name !== 'string' || raw.name.length > 255) throw extError('annotation name'); out.name = raw.name; }
        break;
      case 'text':
        out.x = coord(raw.x, 'x'); out.y = coord(raw.y, 'y');
        if (typeof raw.text !== 'string' || raw.text.length > 4000) throw extError('annotation text');
        out.text = raw.text;
        if (raw.size !== undefined && !(finiteNumber(raw.size) && raw.size > 0)) throw extError('annotation size');
        out.size = raw.size === undefined ? 12 : raw.size;
        out.color = color(raw.color, 'color', false, false, '#ffffff');
        out.background = color(raw.background, 'background', true, false);
        out.bold = !!raw.bold; out.serif = !!raw.serif;
        if (raw.align !== undefined && ['left', 'center', 'right'].indexOf(raw.align) < 0) throw extError('annotation align');
        out.align = raw.align || 'left';
        break;
      case 'shapes':
        out.lines = numberList(raw.lines, 4, 'lines'); out.circles = numberList(raw.circles, 3, 'circles'); out.points = numberList(raw.points, 2, 'points');
        out.stroke = color(raw.stroke, 'stroke', false, false, '#ffff00');
        out.width = nonNeg(raw.width, 'width', 0);
        break;
      case 'rect':
        out.x = coord(raw.x, 'x'); out.y = coord(raw.y, 'y'); out.w = nonNeg(raw.w, 'w'); out.h = nonNeg(raw.h, 'h');
        out.fill = color(raw.fill, 'fill', false, true, '#ffff0040');
        break;
      default: // marker
        out.x = coord(raw.x, 'x'); out.y = coord(raw.y, 'y');
        if (!Number.isInteger(raw.type) || raw.type < 1 || raw.type > 8) throw extError('annotation marker type');
        out.type = raw.type;
        out.color = color(raw.color, 'color', false, false, '#ffff00');
        out.label = !!raw.label;
        break;
    }
    if (raw.tag !== undefined && raw.tag !== null) {
      if (typeof raw.tag !== 'string' || !raw.tag || raw.tag.length > 64) throw extError('annotation tag');
      out.tag = raw.tag;
    }
    return out;
  }
  /** The id of an item: the one it came with when it is free, else a new one. */
  function annotationId(raw, taken) {
    const id = raw && typeof raw.id === 'string' && raw.id && raw.id.length <= 64 ? raw.id : null;
    if (id) { const m = /^a(\d+)$/.exec(id); if (m) S.annotSeq = Math.max(S.annotSeq, Number(m[1])); }
    if (id && !taken.some((t) => t.id === id)) return id;
    return 'a' + (++S.annotSeq);
  }
  function annotRec(docId) {
    let r = S.annot.get(docId);
    if (!r) { r = { visible: true, items: [] }; S.annot.set(docId, r); }
    return r;
  }
  function pushAnnotations(docId, persist) {
    const v = viewOf(docId);
    const r = S.annot.get(docId);
    if (v && typeof v.setAnnotations === 'function') v.setAnnotations(r ? r.items : [], r ? r.visible : true);
    if (persist !== false) scheduleMetaPersist();
  }
  function clearAnnotations(docId) {
    const r = S.annot.get(docId);
    if (!r || !r.items.length) return;
    r.items = [];
    pushAnnotations(docId);
    setStatus(tr('warn.annotationsCleared'));
  }
  function prepareAnnotations(items, existing, tag) {
    if (!Array.isArray(items)) throw extError('annotations: items');
    const fresh = [];
    for (const raw of items) {
      const it = cleanAnnotation(raw);
      if (tag !== undefined) it.tag = tag;
      it.id = annotationId(raw, existing.concat(fresh));
      fresh.push(it);
    }
    return fresh;
  }
  function annotationTag(t) {
    if (typeof t !== 'string' || !t || t.length > 64) throw extError('annotations: tag');
    return t;
  }
  const annotationsApi = Object.freeze({
    get(docId) {
      needDoc(docId);
      const r = S.annot.get(docId) || { visible: true, items: [] };
      return { visible: r.visible, items: JSON.parse(JSON.stringify(r.items)) };
    },
    set(docId, items, o) {
      needDoc(docId);
      const tag = o && o.tag !== undefined ? annotationTag(o.tag) : undefined;
      const rec = annotRec(docId);
      const kept = tag === undefined ? [] : rec.items.filter((it) => it.tag !== tag);
      const fresh = prepareAnnotations(items, kept, tag);
      if (kept.length + fresh.length > ANNOTATIONS_MAX) throw extError('annotations: too many items');
      rec.items = kept.concat(fresh);
      pushAnnotations(docId);
    },
    add(docId, items) {
      needDoc(docId);
      const rec = annotRec(docId);
      const fresh = prepareAnnotations(items, rec.items, undefined);
      if (rec.items.length + fresh.length > ANNOTATIONS_MAX) throw extError('annotations: too many items');
      rec.items = rec.items.concat(fresh);
      pushAnnotations(docId);
    },
    remove(docId, sel) {
      needDoc(docId);
      const rec = S.annot.get(docId);
      if (sel && sel.tag !== undefined) { const t = annotationTag(sel.tag); if (rec) rec.items = rec.items.filter((it) => it.tag !== t); }
      else if (sel && Array.isArray(sel.ids)) { const ids = new Set(sel.ids); if (rec) rec.items = rec.items.filter((it) => !ids.has(it.id)); }
      else throw extError('annotations.remove: { tag } or { ids }');
      pushAnnotations(docId);
    },
    setVisible(docId, v) {
      needDoc(docId);
      const rec = annotRec(docId);
      rec.visible = v === 'toggle' ? !rec.visible : !!v;
      pushAnnotations(docId);
    }
  });

  // ── Synchronize Windows (cursor, zoom and pan; IJ1 SyncWindows, the part that applies to a 2D multichannel image) ──
  const syncState = () => ({ cursor: S.sync.cursor, imageCoords: S.sync.imageCoords, scaling: S.sync.scaling, docs: Array.from(S.sync.docs) });
  function applySyncState(m) {
    S.sync.cursor = m.cursor !== false; S.sync.imageCoords = m.imageCoords !== false; S.sync.scaling = !!m.scaling;
    if (Array.isArray(m.docs)) for (const id of m.docs) if (S.docs.has(id) && !S.hidden.has(id)) S.sync.docs.add(id);
    syncRebind();
    scheduleToolRefresh('doc');
  }
  /** One view-change listener per synchronised image; a closed one is dropped. */
  function syncRebind() {
    for (const [id, off] of Array.from(S.syncBound)) {
      if (!S.sync.docs.has(id) || !viewOf(id)) { try { off(); } catch (_) { /* gone */ } S.syncBound.delete(id); }
    }
    for (const id of S.sync.docs) {
      if (S.syncBound.has(id)) continue;
      const v = viewOf(id);
      if (v && typeof v.onViewChange === 'function') S.syncBound.set(id, v.onViewChange((p) => { if (p && p.user === false) return; syncViews(id); }));
    }
  }
  const pixelWidthOf = (id) => { const c = S.docs.get(id) && S.docs.get(id).calibration; return c && c.pixelWidth > 0 ? c.pixelWidth : 1; };
  const pixelHeightOf = (id) => { const c = S.docs.get(id) && S.docs.get(id).calibration; return c && c.pixelHeight > 0 ? c.pixelHeight : 1; };
  /** The pointer over a view is drawn as a crosshair in the other synchronised views. */
  function syncCursor(docId, x, y, sx, sy) {
    if (!S.sync.cursor || !S.sync.docs.has(docId)) return;
    for (const id of S.sync.docs) {
      if (id === docId) continue;
      const v = viewOf(id);
      if (!v || typeof v.setCursorMark !== 'function') continue;
      if (x === null || x === undefined) { v.setCursorMark(null); continue; }
      let tx, ty;
      if (S.sync.imageCoords) {
        // the same image pixel; with "Image scaling" the same place in micrometres
        tx = S.sync.scaling ? (x * pixelWidthOf(docId)) / pixelWidthOf(id) : x;
        ty = S.sync.scaling ? (y * pixelHeightOf(docId)) / pixelHeightOf(id) : y;
      } else {
        // the same offset from the top-left corner of the view, in screen pixels
        const g = v.getView();
        tx = (sx - g.ox) / g.zoom; ty = (sy - g.oy) / g.zoom;
      }
      v.setCursorMark(tx, ty);
    }
  }
  /** A zoom or pan of one view moves the others to the same place (an echo guard: the target's own change is ignored). */
  function syncViews(fromId) {
    if (S.syncing || !S.sync.docs.has(fromId)) return;
    const src = viewOf(fromId);
    if (!src) return;
    const g = src.getView();
    if (!(g.zoom > 0)) return;
    const near = (a, b, tol) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(a), Math.abs(b));
    S.syncing = true;
    try {
      for (const id of S.sync.docs) {
        if (id === fromId) continue;
        const v = viewOf(id);
        if (!v || typeof v.setView !== 'function') continue;
        const cur = v.getView();
        let zoom = g.zoom, ox = g.ox, oy = g.oy;
        if (S.sync.imageCoords) {
          // the top-left corner of the source view, in image coordinates, becomes the one of the target
          const kx = S.sync.scaling ? pixelWidthOf(fromId) / pixelWidthOf(id) : 1;
          const ky = S.sync.scaling ? pixelHeightOf(fromId) / pixelHeightOf(id) : 1;
          zoom = g.zoom / kx;           // the same physical size on screen
          ox = -((-g.ox / g.zoom) * kx) * zoom; oy = -((-g.oy / g.zoom) * ky) * zoom;
        }
        if (near(cur.zoom, zoom, 1e-6) && near(cur.ox, ox, 1e-6) && near(cur.oy, oy, 1e-6)) continue;
        v.setView({ zoom, ox, oy }, { source: 'sync' });
      }
    } finally { S.syncing = false; }
  }

  // ── the pending (floating) state: a paste ──
  function setPendingExt(p) {
    if (!p || typeof p.labelKey !== 'string' || typeof p.commit !== 'function' || typeof p.cancel !== 'function') throw extError('setPending');
    if (S.pending) { const old = S.pending; S.pending = null; try { old.cancel(); } catch (err) { console.error('[advanced-studio] pending cancel', err); } }
    S.pending = { labelKey: p.labelKey, commit: p.commit, cancel: p.cancel };
    setStatus(tr(p.labelKey));
  }
  function clearPending() { S.pending = null; }
  /** commit() of the pending state, once; a failure is reported. */
  async function flushPending() {
    const p = S.pending;
    if (!p) return;
    S.pending = null;
    try { await p.commit(); } catch (err) { await reportError(err); }
  }
  function cancelPending() {
    const p = S.pending;
    if (!p) return false;
    S.pending = null;
    try { p.cancel(); } catch (err) { console.error('[advanced-studio] pending cancel', err); }
    return true;
  }
  /** Enter commits and Escape cancels the pending state, unless the focus is in a text field. */
  function onPendingKey(e) {
    if (!S.pending || !e || (e.key !== 'Enter' && e.key !== 'Escape')) return;
    const t = e.target;
    const typing = t && t.tagName && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable === true);
    if (typing) return;
    if (e.preventDefault) e.preventDefault();
    if (e.stopPropagation) e.stopPropagation();
    if (e.key === 'Enter') flushPending(); else cancelPending();
  }

  // ── panels, tools ──
  async function openPanelExt(id, o) {
    const p = EXT.panels.get(id);
    if (!p) throw extError('openPanel: ' + String(id));
    if (!S.shell) return false;
    if (S.failedPackages.has(p.pkg)) { setStatus(tr('warn.packageFailed', { pkg: p.pkg })); return false; }
    const focus = !o || o.focus !== false;
    if (S.wins.has(id)) { if (focus) S.wins.get(id).focus(); return true; }
    try {
      floatingWindow(id, p.spec.titleKey, () => {
        const el = h('div', { class: 'ij-panel ij-panel-ext' });
        const inst = p.spec.build(el, apiFor(p.pkg)) || {};
        return {
          el,
          update: typeof inst.refresh === 'function' ? (kind) => { try { return inst.refresh(kind); } catch (err) { console.error('[advanced-studio] panel ' + id, err); return undefined; } } : undefined,
          dispose: typeof inst.dispose === 'function' ? () => { try { inst.dispose(); } catch (err) { console.error('[advanced-studio] panel ' + id, err); } } : undefined
        };
      }, p.spec.defaultSize ? { width: p.spec.defaultSize.w, height: p.spec.defaultSize.h } : null);
    } catch (err) { await reportError(err); return false; }
    return S.wins.has(id);
  }
  function closePanelExt(id) {
    if (!EXT.panels.has(id)) throw extError('closePanel: ' + String(id));
    const w = S.wins.get(id);
    if (w) w.close();
  }
  function onExtToolPointer(docId, evt) {
    const t = EXT.tools.get(S.tool);
    if (!t || S.failedPackages.has(t.pkg)) return;
    const fail = (err) => { if (evt.type === 'move') console.error('[advanced-studio] tool ' + t.spec.id, err); else reportError(err); };
    try {
      const r = t.spec.onPointer(apiFor(t.pkg), Object.assign({ docId }, evt));
      if (r && typeof r.catch === 'function') r.catch(fail);
    } catch (err) { fail(err); }
  }
  function setToolExt(id) {
    if (!TOOLS.some((t) => !t.separator && t.id === id)) throw extError('setTool: ' + String(id));
    if (!S.shell) return;
    S.shell.setTool(id);
    S.tool = id;
    emit('tool', id);
  }

  // ── commands ──
  const menuLabel = (seg) => { const v = tr('menu.' + seg); return v === 'menu.' + seg ? seg : v; };
  function commandsExt() {
    const st = snapshot();
    return COMMANDS.filter((c) => !c.pkg || !S.failedPackages.has(c.pkg)).map((c) => {
      let enabled = false;
      try { enabled = !!c.enabled(st) && !(c.pkg && S.failedPackages.has(c.pkg)); } catch (_) { enabled = false; }
      return { id: c.id, label: tr(c.labelKey), path: c.menu.map(menuLabel), shortcut: c.shortcut || null, enabled };
    });
  }
  function runCommandExt(id) {
    const c = COMMANDS.find((x) => x.id === id);
    if (!c) throw extError('runCommand: ' + String(id));
    return Promise.resolve(onCommand(c));
  }
  const lastCommandExt = () => (S.lastCommand ? { id: S.lastCommand } : null);

  /** api.call: a worker command the CALLING package registered (the registry records the package). */
  async function callExt(pkg, cmd, args, o) {
    const opt = o || {};
    const reg = typeof IJOpRegistry !== 'undefined' ? IJOpRegistry : null;
    const spec = reg && typeof reg.getCommand === 'function' && typeof cmd === 'string' ? reg.getCommand(cmd) : null;
    if (!pkg || !spec || spec.pkg !== pkg) throw forbidden('call: ' + String(cmd) + ' is not a worker command of package ' + String(pkg));
    if (S.failedPackages.has(pkg)) throw Object.assign(new Error('package failed'), { code: 'IJ_MODULE_MISSING' });
    const label = opt.labelKey ? tr(opt.labelKey) : tr('op.working');
    return busy(label, () => call(cmd, args || {}, opt.transfer, { long: opt.long === true || spec.long === true }));
  }

  const placementOf = (placement) => (placement ? { placement, anchor: S.activeId !== null ? S.activeId : undefined } : undefined);
  /** A document the worker created (E.createDoc): view, tab, menu entry and session wiring. */
  async function adoptExt(info, o) {
    const opt = o || {};
    if (!info || info.docId === undefined || info.docId === null) throw extError('adopt: info');
    const fresh = await call('doc.info', { docId: info.docId });
    if (!S.docs.has(fresh.docId)) {
      registerDoc(fresh, { clean: false, provenance: opt.provenance || null, sessionKey: opt.sessionKey || (fresh.provenance && fresh.provenance.sessionKey) || null });
    }
    if (!fresh.hidden) await showDoc(fresh.docId, placementOf(opt.placement));
    commitHook();
    return fresh.docId;
  }
  /** An image the page built: the arrays travel to the worker (doc.import), which keeps its baseline. */
  async function addDocExt(image, o) {
    const opt = o || {};
    if (!image || typeof image !== 'object' || !Array.isArray(image.channels) || !image.channels.length) throw extError('addDoc: image');
    const transfer = [];
    const channels = image.channels.map((c) => {
      if (!c || !ArrayBuffer.isView(c.data)) throw extError('addDoc: channel data');
      const data = c.data.byteOffset === 0 && c.data.byteLength === c.data.buffer.byteLength ? c.data : c.data.slice();
      transfer.push(data.buffer);
      const ch = { data, name: c.name, color: c.color };
      if (c.display) ch.display = c.display;
      return ch;
    });
    const res = await call('doc.import', {
      image: { name: image.name, width: image.width, height: image.height, bitDepth: image.bitDepth, calibration: image.calibration, channels },
      provenance: opt.provenance, sessionKey: opt.sessionKey, hidden: !!opt.hidden
    }, transfer);
    registerDoc(res.info, { clean: false, provenance: opt.provenance || null, sessionKey: opt.sessionKey || null });
    if (!res.info.hidden) await showDoc(res.info.docId, placementOf(opt.placement));
    commitHook();
    return res.info.docId;
  }
  async function closeDocExt(docId) {
    if (!S.docs.has(docId)) return false;
    await closeImage(docId);
    return !S.docs.has(docId);
  }
  function viewExt(docId) {
    const v = viewOf(docId);
    if (!v) return null;
    return { getView: () => v.getView(), setView: (s) => v.setView(s), visibleRect: () => v.visibleRect() };
  }
  async function putBlobExt(data) {
    if (!ArrayBuffer.isView(data) || data instanceof DataView) throw extError('putBlob: a typed array');
    if (data.byteLength > BLOB_BYTES_MAX) throw Object.assign(new Error('blob too large'), { code: 'IJ_TOO_LARGE' });
    const copy = data.slice();      // the caller keeps its array; the copy is what travels
    const res = await call('engine.putBlob', { data: copy }, [copy.buffer]);
    return Object.freeze({ blobRef: res.blobRef, kind: res.kind });
  }

  /** api.setThreshold: the Threshold window, opened for this image and channel, takes the range (and the polarity). */
  async function setThresholdExt(docId, channel, o) {
    const info = S.docs.get(docId);
    if (!info || S.hidden.has(docId) || !Number.isInteger(channel) || !(info.channels || [])[channel]) throw extError('setThreshold: image or channel');
    const lower = Number(o && o.lower), upper = Number(o && o.upper);
    if (!isFinite(lower) || !isFinite(upper) || lower > upper) throw extError('setThreshold: range');
    if (S.activeId !== docId) await showDoc(docId);
    setDocDisplayMode(docId, { active: channel });
    await openToolExt('threshold');
    const u = S.winUpdaters.get('threshold');
    if (!u) throw extError('setThreshold: the Threshold window did not open');
    await u('setRange', { lower, upper, dark: o && o.dark !== undefined ? !!o.dark : undefined });
  }

  /**
   * ImageJ's setColor of a grey image, for the colour of Edit › Options › Colors (colors.foreground / colors.background):
   * the index of the entry of the channel's look-up table nearest to the colour (ImageProcessor.getBestIndex: the squared RGB
   * distance, first minimum wins, a non-grey colour weighted by the RGB weights — 1/3 each — when the table is the default
   * one), then
   *   8-bit   ByteProcessor.setColor       fgColor = getBestIndex(color)
   *   16-bit  ShortProcessor.setColor      if (bestIndex>0 && getMin()==0.0 && getMax()==0.0) value = bestIndex
   *                                        else if (bestIndex==0 && getMin()>0.0 && (color.getRGB()&0xffffff)==0) value = 0
   *                                        else value = (int)(getMin() + (getMax()-getMin())*(bestIndex/255.0))
   *   32-bit  FloatProcessor.setColor      the same with (float): fillColor = (float)(getMin() + (getMax()-getMin())*(bestIndex/255.0))
   * getMin() / getMax() are the display range of the channel. The one place Fill and Clear read their value from.
   */
  function colorValueOf(docId, channel, which) {
    const info = S.docs.get(docId);
    if (!info || !Number.isInteger(channel) || !(info.channels || [])[channel]) throw extError('colorValue: image or channel');
    if (which !== 'foreground' && which !== 'background') throw extError('colorValue: foreground or background');
    const rgb = parseColorValue(settingGet('colors.' + which)) || (which === 'foreground' ? [255, 255, 255] : [0, 0, 0]);
    const d = S.dstate.get(docId);
    const st = d && d.channels[channel] ? d.channels[channel] : { min: 0, max: 255, lut: 'Grays', invert: false };
    let table;
    try { table = IJLuts.get(st.lut || 'Grays'); } catch (_) { table = IJLuts.get('Grays'); }
    if (st.invert) { const r = new Uint8Array(768); for (let i = 0; i < 256; i++) { const j = 255 - i; r[i * 3] = table[j * 3]; r[i * 3 + 1] = table[j * 3 + 1]; r[i * 3 + 2] = table[j * 3 + 2]; } table = r; }
    const isDefaultTable = (!st.lut || st.lut === 'Grays') && !st.invert;
    let r1 = rgb[0], g1 = rgb[1], b1 = rgb[2];
    if (!(r1 === g1 && g1 === b1) && isDefaultTable) {
      const w = 1 / 3;
      r1 = Math.floor(3 * r1 * w + 0.5); g1 = Math.floor(3 * g1 * w + 0.5); b1 = Math.floor(3 * b1 * w + 0.5);
    }
    let best = 0, minDistance = Infinity;
    for (let i = 0; i < 256; i++) {
      const dr = table[i * 3] - r1, dg = table[i * 3 + 1] - g1, db = table[i * 3 + 2] - b1;
      const dist = dr * dr + dg * dg + db * db;
      if (dist < minDistance) { minDistance = dist; best = i; }
      if (minDistance === 0) break;
    }
    if (info.bitDepth === 8) return best;
    const min = Number(st.min), max = Number(st.max);
    const black = rgb[0] === 0 && rgb[1] === 0 && rgb[2] === 0;
    if (best > 0 && min === 0 && max === 0) return best;
    if (best === 0 && min > 0 && black) return 0;
    const v = min + (max - min) * (best / 255.0);
    return info.bitDepth === 16 ? Math.trunc(v) : Math.fround(v);
  }

  // ── look-up tables ──
  async function registerLutExt(name, table) {
    if (typeof IJLuts === 'undefined' || typeof IJLuts.register !== 'function') throw extError('registerLut: unavailable');
    if (!ArrayBuffer.isView(table) || !table.constructor || table.constructor.name !== 'Uint8Array' || table.length !== 768) throw extError('registerLut: a Uint8Array of 768 bytes');
    IJLuts.register(name, table);
    // a table registered again under a known name must be uploaded again
    try { if (S.shell && S.shell.renderer && S.shell.renderer.dropLut) S.shell.renderer.dropLut(name); } catch (e) { console.error('[advanced-studio] dropLut', e); }
    S.luts.set(name, new Uint8Array(table));
    await call('engine.registerLut', { name, table: new Uint8Array(table) });
    scheduleMetaPersist();
  }
  /** Tables of a stored session come back before any view names one. */
  async function restoreLuts(meta) {
    if (!meta || !meta.luts || typeof meta.luts !== 'object') return;
    for (const name of Object.keys(meta.luts)) {
      const arr = meta.luts[name];
      if (!Array.isArray(arr) || arr.length !== 768 || S.luts.has(name)) continue;
      try { await registerLutExt(name, Uint8Array.from(arr)); } catch (err) { console.error('[advanced-studio] look-up table', err); }
    }
  }

  // ── files, clipboard, picture, profile ──
  function pickFileExt(o) {
    const opt = o || {};
    return new Promise((resolve) => {
      const input = h('input', { type: 'file' });
      if (opt.accept) input.accept = String(opt.accept);
      if (opt.multiple) input.multiple = true;
      let done = false;
      const finish = (v) => { if (!done) { done = true; resolve(v); } };
      input.addEventListener('change', () => { const f = Array.from(input.files || []); finish(f.length ? f : null); });
      input.addEventListener('cancel', () => finish(null));
      input.click();
    });
  }
  async function saveFileExt(suggestedName, mime, ext, descKey, produce) {
    if (typeof produce !== 'function') throw extError('saveFile: produce');
    return saveFile(String(suggestedName), String(mime), String(ext), descKey ? tr(descKey) : String(ext), produce);
  }
  async function copyTextExt(text) {
    await navigator.clipboard.writeText(String(text));
    setStatus(tr('status.copied'));
  }
  async function renderPngExt(docId, o) {
    const v = viewOf(docId);
    if (!v || typeof v.renderToCanvas !== 'function') throw extError('renderPng: no view');
    const full = await v.renderToCanvas({ scale: 1 });
    let canvas = full;
    const r = o && o.rect;
    if (r && finiteNumber(r.x) && finiteNumber(r.y) && r.w > 0 && r.h > 0 && typeof document !== 'undefined') {
      canvas = document.createElement('canvas');
      canvas.width = Math.round(r.w); canvas.height = Math.round(r.h);
      canvas.getContext('2d').drawImage(full, Math.round(r.x), Math.round(r.y), canvas.width, canvas.height, 0, 0, canvas.width, canvas.height);
    }
    return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(Object.assign(new Error('png'), { code: 'IJ_PNG_FAILED' }))), 'image/png'));
  }
  async function profileExt(docId, roi, channel) {
    const info = needDoc(docId);
    const res = await call('doc.profile', { docId, line: roi, channel: Number.isInteger(channel) ? channel : activeChannel(info) });
    return Object.assign({}, res, { step: res && res.step !== undefined ? res.step : (res ? res.stepUm : undefined) });
  }

  // ── ROI Manager ──
  function roiEntryOf(e) {
    if (!e || typeof e !== 'object' || !e.roi) throw extError('roiManager: roi');
    if (typeof IJRoi !== 'undefined') IJRoi.validate(e.roi);
    const docId = e.docId !== undefined ? e.docId : S.activeId;
    if (docId === null || docId === undefined || !S.docs.has(docId)) throw extError('roiManager: image');
    const out = { name: typeof e.name === 'string' && e.name ? e.name : roiName(e.roi), docId, roi: e.roi };
    for (const k of ['stroke', 'fill']) {
      if (e[k] === undefined || e[k] === null) continue;
      if (typeof e[k] !== 'string' || !(HEX6.test(e[k]) || HEX8.test(e[k]))) throw extError('roiManager: ' + k);
      out[k] = e[k];
    }
    if (e.width !== undefined && e.width !== null) { if (!finiteNumber(e.width) || e.width < 0) throw extError('roiManager: width'); out.width = e.width; }
    return out;
  }
  function roiListChanged() { refreshRois(); scheduleToolRefresh('rois'); scheduleMetaPersist(); }
  const roiManagerApi = Object.freeze({
    list() { return S.roiList.map((r) => { const o = { name: r.name, docId: r.docId, roi: r.roi }; for (const k of ['stroke', 'width', 'fill']) if (r[k] !== undefined) o[k] = r[k]; return o; }); },
    add(entries) {
      const list = (Array.isArray(entries) ? entries : [entries]).map(roiEntryOf);
      for (const e of list) S.roiList.push(e);
      roiListChanged();
    },
    set(entries) {
      if (!Array.isArray(entries)) throw extError('roiManager.set: a list');
      const list = entries.map(roiEntryOf);
      S.roiList = list;
      S.roiSelected.clear();
      roiListChanged();
    },
    select(indices) {
      if (!Array.isArray(indices)) throw extError('roiManager.select: indices');
      S.roiSelected.clear();
      for (const i of indices) if (Number.isInteger(i) && i >= 0 && i < S.roiList.length) S.roiSelected.add(S.roiList[i]);
      roiListChanged();
    },
    selected() { const out = []; S.roiList.forEach((r, i) => { if (S.roiSelected.has(r)) out.push(i); }); return out; }
  });

  const EXT_API = Object.freeze({
    tr: (key, params) => tr(key, params),
    state: stateForApi,
    dialog,
    run: (op, params, o) => runExt(op, params, o),
    compute,
    estimate: estimateOp,
    preview: previewOp,
    cancelPreview: () => clearExtPreview(),
    overlay: (items) => { setOverlayFor(S.activeId, items); },
    clearOverlay: () => { clearOverlays(); },
    setRoi: (roi, o) => { const id = o && o.docId !== undefined ? o.docId : S.activeId; if (id !== null && S.docs.has(id)) setSelection(id, roi || null, true); },
    addResults: addResultRows,
    openTable,
    openPlot,
    toast: (key, params) => setStatus(tr(key, params)),
    error: (err) => reportError(err),
    rename: renameDoc,
    setDisplay: setDisplayExt,
    openTool: openToolExt,
    // wave 3
    openPanel: openPanelExt,
    closePanel: closePanelExt,
    on,
    annotations: annotationsApi,
    settings: Object.freeze({ get: settingGet, set: (k, v) => settingSet(null, k, v) }),
    sessionData: Object.freeze({ get: (p) => sessionDataGet(null, p), set: (p, j) => sessionDataSet(null, p, j) }),
    commands: commandsExt,
    runCommand: runCommandExt,
    lastCommand: lastCommandExt,
    call: (cmd, args, o) => callExt(null, cmd, args, o),
    adopt: adoptExt,
    putBlob: putBlobExt,
    setPending: setPendingExt,
    clearPending,
    addDoc: addDocExt,
    closeDoc: closeDocExt,
    view: viewExt,
    setTool: setToolExt,
    setThreshold: setThresholdExt,
    colorValue: colorValueOf,
    registerLut: registerLutExt,
    pickFile: pickFileExt,
    saveFile: saveFileExt,
    copyText: copyTextExt,
    renderPng: renderPngExt,
    profile: profileExt,
    roiManager: roiManagerApi
  });
  /** The api a package's command, panel or tool receives: the same members, with `call`, `settings.set` and `sessionData` bound to the package. */
  const API_BY_PKG = new Map();
  function apiFor(pkg) {
    const key = pkg || '';
    let a = API_BY_PKG.get(key);
    if (!a) {
      a = Object.freeze(Object.assign({}, EXT_API, {
        call: (cmd, args, o) => callExt(pkg, cmd, args, o),
        settings: Object.freeze({ get: settingGet, set: (k, v) => settingSet(pkg, k, v) }),
        sessionData: Object.freeze({ get: (p) => sessionDataGet(pkg, p), set: (p, j) => sessionDataSet(pkg, p, j) })
      }));
      API_BY_PKG.set(key, a);
    }
    return a;
  }
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
      if (!Array.isArray(raw.menu) || !raw.menu.length || raw.menu.length > 3 || !raw.menu.every((x) => typeof x === 'string' && x)) throw extError('extend: menu of ' + raw.id);
      if (raw.repeatable !== undefined && typeof raw.repeatable !== 'boolean') throw extError('extend: repeatable of ' + raw.id);
      if (typeof raw.run !== 'function') throw extError('extend: run of ' + raw.id);
      if (!(typeof raw.order === 'number' && isFinite(raw.order))) throw extError('extend: order of ' + raw.id);
      if (raw.enabled !== undefined && typeof raw.enabled !== 'function') throw extError('extend: enabled of ' + raw.id);
      known.add(raw.id);
      const keys = Array.isArray(raw.keys) && raw.keys.length ? raw.keys.slice() : (raw.shortcut ? [raw.shortcut] : []);
      const enabled = typeof raw.enabled === 'function' ? raw.enabled : has;
      built.push({
        id: raw.id, menu: raw.menu.slice(), labelKey: raw.labelKey || ('cmd.' + raw.id), shortcut: raw.shortcut || keys[0] || null, keys,
        order: raw.order, pkg: spec.pkg, long: !!raw.long, ext: true, separatorBefore: !!raw.separatorBefore, repeatable: raw.repeatable !== false,
        enabled: (st) => !S.failedPackages.has(spec.pkg) && !!enabled(st), run: raw.run
      });
    }
    // panels (tool windows the package fills), tools (toolbar entries) and the worker commands Cancel may reach: all checked
    // before anything is registered, like the commands
    const panels = [];
    if (spec.panels !== undefined) {
      if (!spec.panels || typeof spec.panels !== 'object' || Array.isArray(spec.panels)) throw extError('extend: panels');
      for (const id of Object.keys(spec.panels)) {
        const p = spec.panels[id];
        if (!/^[A-Za-z][A-Za-z0-9]*$/.test(id) || Object.prototype.hasOwnProperty.call(TOOL_WINDOWS, id) || EXT.panels.has(id) || panels.some((q) => q.id === id)) throw extError('extend: panel id ' + id);
        if (!p || typeof p.titleKey !== 'string' || !p.titleKey || typeof p.build !== 'function') throw extError('extend: panel ' + id);
        if (p.persist !== undefined && typeof p.persist !== 'boolean') throw extError('extend: panel persist ' + id);
        if (p.defaultSize !== undefined && !(p.defaultSize && typeof p.defaultSize === 'object' && finiteNumber(p.defaultSize.w) && finiteNumber(p.defaultSize.h) && p.defaultSize.w > 0 && p.defaultSize.h > 0)) throw extError('extend: panel defaultSize ' + id);
        panels.push({ id, spec: p });
      }
    }
    const tools = [];
    if (spec.tools !== undefined) {
      if (!Array.isArray(spec.tools)) throw extError('extend: tools');
      const taken = new Set(TOOLS.filter((t) => !t.separator).map((t) => t.id));
      for (const t of spec.tools) {
        if (!t || typeof t.id !== 'string' || !/^[A-Za-z][A-Za-z0-9]*$/.test(t.id) || taken.has(t.id)) throw extError('extend: tool id');
        if (typeof t.labelKey !== 'string' || !t.labelKey || typeof t.onPointer !== 'function') throw extError('extend: tool ' + t.id);
        for (const k of ['icon', 'cursor', 'after']) if (t[k] !== undefined && typeof t[k] !== 'string') throw extError('extend: tool ' + k + ' of ' + t.id);
        if (t.hidden !== undefined && typeof t.hidden !== 'boolean') throw extError('extend: tool hidden ' + t.id);
        if (t.after !== undefined && !taken.has(t.after)) throw extError('extend: tool after ' + t.after);
        taken.add(t.id);
        tools.push(t);
      }
    }
    const longCommands = [];
    if (spec.longCommands !== undefined) {
      if (!Array.isArray(spec.longCommands)) throw extError('extend: longCommands');
      for (const n of spec.longCommands) {
        if (typeof n !== 'string' || !/^[a-z][A-Za-z0-9]*(\.[A-Za-z][A-Za-z0-9]*)+$/.test(n)) throw extError('extend: longCommands ' + String(n));
        longCommands.push(n);
      }
    }
    const errors = spec.errors && typeof spec.errors === 'object' ? spec.errors : {};
    for (const code of Object.keys(errors)) {
      if (!/^[A-Z][A-Z0-9_]*$/.test(code) || typeof errors[code] !== 'string' || !/^err\.[A-Za-z0-9]+$/.test(errors[code])) throw extError('extend: error ' + code);
      if (ERROR_KEYS[code] !== undefined && ERROR_KEYS[code] !== errors[code]) throw extError('extend: error ' + code + ' is already mapped');
    }
    const cols = Array.isArray(spec.columns) ? spec.columns : [];
    for (const c of cols) if (!Array.isArray(c) || typeof c[0] !== 'string' || typeof c[1] !== 'string' || (c[2] !== undefined && typeof c[2] !== 'string')) throw extError('extend: columns');
    for (const c of built) COMMANDS.push(c);
    for (const p of panels) EXT.panels.set(p.id, { pkg: spec.pkg, spec: p.spec });
    for (const t of tools) {
      const def = { id: t.id, labelKey: t.labelKey, icon: t.icon, cursor: t.cursor, hidden: !!t.hidden, ext: true, pkg: spec.pkg };
      let at = TOOLS.length;
      if (t.after !== undefined) { const k = TOOLS.findIndex((x) => !x.separator && x.id === t.after); if (k >= 0) at = k + 1; }
      TOOLS.splice(at, 0, def);
      EXT.tools.set(t.id, { pkg: spec.pkg, spec: t });
    }
    for (const n of longCommands) LONG_COMMANDS.add(n);
    Object.assign(ERROR_KEYS, errors);
    for (const c of cols) EXTRA_COLUMNS.push(c.slice(0, 3));
    if (spec.measurements) EXT.measurements[spec.pkg] = spec.measurements;
    EXT.packages.set(spec.pkg, { commands: built.map((c) => c.id), panels: panels.map((p) => p.id), tools: tools.map((t) => t.id) });
  }

  // ───────────────────────────── public lifecycle ─────────────────────────────

  function mount(root, { ctx, api }) {
    extensionsLocked = true;
    prefsCache = null;
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
      for (const v of allViews()) v.resize();
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
        tools: TOOLS.map((t) => (t.separator ? t : { id: t.id, labelKey: t.labelKey, icon: t.icon, cursor: t.cursor, hidden: t.hidden, ext: t.ext })),
        onCommand, onTool: (id) => { S.tool = id; emit('tool', id); }, onToolPointer: onExtToolPointer, onCursor: syncCursor,
        onMenuOpen: (name) => { if (name === 'Window') syncWindowMenu(); }, onToolOptions, onWand: (x, y, mods) => wandAt(x, y, mods).catch((err) => reportError(err)),
        onRoi: (roi, o) => { const i = o && o.docId !== undefined && o.docId !== null ? S.docs.get(o.docId) : activeInfo(); if (i) setSelection(i.docId, roi, !o || o.final !== false, true); },
        onChannel: (c, docId) => { const i = docId !== undefined && docId !== null ? S.docs.get(docId) : activeInfo(); if (i) setDocDisplayMode(i.docId, { active: c }); },
        onCancel: cancelRunning, readPixel, isActive: () => S.mounted,
        onActivate: (docId) => { if (!S.placing) afterActivate(docId); },
        onCloseImage: (docId) => { closeImage(docId).catch((err) => reportError(err)); },
        onLayoutChange: (kind) => { onLayoutChange(kind); },
        display: { onTileError: (err) => console.error('[advanced-studio] tile', err) }
      });
      S.windows = S.shell.windows;
      // Enter commits and Escape cancels a floating state (api.setPending); in the capture phase, before the shell's own keys
      S.keyHandler = onPendingKey;
      S.appEl.addEventListener('keydown', S.keyHandler, true);
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

  /** A tab moved, a window floated, a divider was released: the layout is stored, and the worker's tile cache follows the number of visible views. */
  function onLayoutChange(kind) {
    if (!S.shell || kind === 'tabinfo') return;
    scheduleMetaPersist();
    emit('layout', kind);
    scheduleToolRefresh('layout');
    if (kind === 'activate') return;
    if (typeof IJRenderSched === 'undefined') return;
    const visible = allViews().filter((v) => v._visible && v._visible()).length;
    const bytes = IJRenderSched.workerTileCacheBytes(visible, S.engineBudget || S.budgetBytes);
    if (S.tileCacheBytes === bytes) return;
    S.tileCacheBytes = bytes;
    if (S.worker && !S.worker.dead) call('engine.configure', { tileCacheBytes: bytes }).catch(() => { /* an engine without the command keeps its default */ });
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
    if (S.leaving === 'simple' && S.shell) {
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
    if (S.keyHandler && S.appEl) { try { S.appEl.removeEventListener('keydown', S.keyHandler, true); } catch (_) { /* gone */ } }
    S.keyHandler = null;
    for (const [, off] of S.syncBound) { try { off(); } catch (_) { /* the view is gone */ } }
    S.syncBound.clear();
    try { if (S.shell) S.shell.destroy(); } catch (err) { console.error('[advanced-studio] shell destroy', err); }
    if (S.appEl) S.appEl.remove();
    if (S.root) S.root.classList.remove('ij-root');
    for (const key of Array.from(S.locks.keys())) releaseSessionLock(key);
    S.shell = null; S.windows = null; S.appEl = null; S.emptyEl = null; S.menuList = [];
    S.previewDocs.clear(); S.overlayDocs.clear(); S.placing = false;
    for (const m of [S.docs, S.activeCh, S.dstate, S.sel, S.prevSel, S.undo, S.cleanRev, S.revs, S.sessionKeys, S.sources, S.displayPatch, S.displayInflight]) m.clear();
    S.order = []; S.activeId = null; S.roiList = []; S.roiSelected.clear(); S.results = []; S.summaryRows = []; S.figureKey = null; S.desc = null;
    S.threshold = null; S.previewCompute = 0; S.redirect = null;
    // the extension state belongs to the session that is gone (listeners are dropped here, not when the Simple view merely hides the page)
    S.listeners.clear(); S.annot.clear(); S.annotDims.clear(); S.hidden.clear(); S.pending = null; S.lastCommand = null; S.extData = {}; S.luts.clear();
    S.sync = { cursor: true, imageCoords: true, scaling: false, docs: new Set() }; S.syncing = false; S.metaWarned = false; S.lastActiveEmitted = null; S.engineUsed = 0;
    S.leaving = null; S.busy = false; S.unprotected.clear(); S.held.clear(); S.warnBudget = ''; S.warnLow = false;
  }

  return {
    mount, unmount, release, canLeave, hasUnsavedWork,
    COMMANDS, TOOLS, LUT_NAMES, ERROR_KEYS, MEASURE_GROUPS,
    extend, EXT_API_MEMBERS, apiFor, WORKER_SCRIPTS, PACKAGE_NAMES, GROUP_META, ORDER, EXTRA_COLUMNS, resultColumnsOf, columnHeader,
    // pure helpers, exposed for tests
    planLevels, mapRange, mvox, projectionProgress, outputBitDepth, bcMath, measurementKeys, errorKey, snapshotOf: (st) => st, workerInit, distributionHistogram, distributionDefaultColumn, COLUMNS, PARTICLE_COLUMNS
  };
})();
