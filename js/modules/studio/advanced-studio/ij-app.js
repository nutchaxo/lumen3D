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
 *   addResults(rows, { show, replace })              rows = [{ key: value }] appended to Results (shown unless show:false);
 *                                                    replace:true empties the table first (a plugin's `new ResultsTable().show("Results")`)
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
 * not remember those), `gesture: true` (run() is called synchronously in the click / key task, BEFORE a pending floating paste is
 * committed, so the browser's user activation is still alive: the clipboard write of Copy to System; the commit follows the command)
 * and a menu path of up to three segments (every submenu must have its place in IJApp.GROUP_META).
 * run(api, { alt, shift, source }) → every command's run gets the keys held when the menu item was clicked / the shortcut pressed
 *       (ImageJ's IJ.altKeyDown() / shiftKeyDown() inside the command); `source` is 'menu' | 'key' | 'api'. runCommand(id, { alt, shift }) passes them on.
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
 *   settings { get(key), set(key, value) }  localStorage 'lumen3d.ij.prefs'; core keys conv.scale conv.weighted conv.fullRange16 misc.divZero
 *       colors.foreground colors.background colors.selection appearance.interpolate appearance.useNames (Prefs.useNamesAsLabels: the ROI
 *       Manager's Labels show the names instead of the numbers) (only the Edit package writes them); every
 *       other key lives under the package's own prefix (bg flt seg multi geom roi coloc lay thr enh fft sel io ov ana edit fiji lib)
 *   sessionData { get(pkg), set(pkg, json) }  the package's own JSON (≤ 256 KiB) in the session meta
 *   commands() → [{ id, label, path: [menu labels], shortcut, enabled }]     runCommand(id, { alt, shift }) → Promise (the command runs
 *       normally; its dialogs come back pre-filled with the last run's values ONLY when Repeat Command is the caller — never a text field, a
 *       field with `remember: false` or a default that is not the one offered last time; a command another command started does not
 *       replace the last command)     lastCommand() → { id } | null   (last command the operator ran, repeatable !== false)
 *   call(cmd, args, { transfer, labelKey, long }) → Promise<result | null>   a worker command registered by THIS package with
 *       IJOpRegistry.defineCommand (another name rejects IJ_EXT_FORBIDDEN); busy / progress / Cancel like api.run
 *   adopt(info, { placement, provenance, sessionKey }) → Promise<docId>   a document the worker created (E.createDoc)
 *   addDoc(image, { placement, hidden, provenance, sessionKey }) → Promise<docId>   image = { name, width, height, bitDepth,
 *       calibration, channels: [{ data, name, color, display? }] }; the arrays are transferred (worker doc.import)
 *   closeDoc(docId) → Promise<boolean>  (with the unsaved prompt)     view(docId) → { getView, setView, visibleRect } | null
 *   putBlob(typedArray) → Promise<blobRef>   bytes sent to the worker once; a blobRef is the object { blobRef, kind }: put it
 *       where the typed array belongs in the params of api.preview / api.run; ≤ 64 MiB; dropped with the documents using it
 *   dropBlob(blobRef | { blobRef }) → Promise<boolean>   gives a blob up (a cancelled paste): true when it was dropped; a blob a committed
 *       step already uses stays. A blob a preview refers to is PINNED (never reclaimed under memory pressure) until this call or until the
 *       preview is cancelled (api.cancelPreview); compute / estimate calls do not pin
 *   compute(op, params, { docless: true, labelKey }) → Promise<result | null>   an op whose IJOpRegistry spec says `docless: true` (a compute
 *       op that needs no image: run(null, params, null, io)); any other op keeps needing the image of `docId` / the active one
 *   setDisplayMode(docId, 'composite' | 'color' | 'gray') → Promise   the channel display mode of an image ('grayscale' is accepted for 'gray');
 *       not an undo step, never touches pixels
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
 * Stacks (DOCS/studio-advanced/stacks/API.md §7): positions are 0-based { c, z, t } (c = the active channel), pi = t * nZ + z.
 *   position(docId?) → { c, z, t }        setPosition({ c?, z?, t? }, { docId }) → Promise<info>   moves the view (sliders, tiles), then waits for the
 *       engine's current plane to follow; not an undo step      dims(docId?) → { width, height, nC, nZ, nT, nSlices, bitDepth (ImageJ's type: 24 = RGB),
 *       rgb, hyperstack }      askStack(spec?) → Promise<'all' | 'current' | null>   ImageJ's "Process all N images?" (Process Stack?), 'current' at once
 *       for a single plane, spec.stack ('all' | 'current') / spec.macro answer without a dialog      label(docId?) / setLabel(n, label, { docId }) (n =
 *       the 1-based stack index; an undo step)      animation { start, stop, toggle, running, options, setOptions } ({ docId } last; options =
 *       { fps (7), first, last, backAndForth })
 *   run(op, params, { pos, planes, stack }) forwards the plane (default: the one on screen) and the (z, t) set a pixel op runs on ('current' | 'all' |
 *       { z: [a, b], t: [a, b] }); a pixel op of spec.stack 'ask' on a stack asks `Process all N images?` unless `planes` is given. compute / estimate
 *       take `pos`. Every read (pixel, stats, histogram, profile, threshold, particles, tile) carries the plane on screen. state() adds pos and dims.
 *   addDoc(image) also takes a stack image: { nZ, nT, hyperstack, rgb, labels, mode, visible: [bool per channel], channels: [{ planes: [nZ * nT arrays], name, color, display }] }.
 *   roiManager entries and annotation items take `position`: { c, z, t } (1-based, 0 = any) or { n } (a plain stack's slice); the view draws them
 *       only on that plane. events: 'doc' kind 'position' when the plane changes.
 *
 * Fields of an IJOpRegistry op spec the app honours: `display: true` (the step resets the display range of the channels it changes, in its undo
 * step), `display: '16/32'` (the same, only on a 16 / 32-bit image), `docless: true` on a compute op (api.compute(…, { docless: true }) runs it
 * with view = null and no image open).
 *
 * Open from Library (package lib, PLAN-wave3 §4): ij-cmds-lib.js registers File › Open from Library… and its panel. The extension API has no
 * member for the Studio facade (`ctx.studio.library`), so enter() hands the page's ctx to the panel through the package's own global
 * (`IJLibPage.attach(ctx, { budget })`). The entry flow (zProject → probeFigureTiff → loadTiffProjection) offers the dataset's original TIFF
 * (`library.describe` → `tiffIndex` → `IJLibSource.tiffFacts`) as the Source of the Z Project dialog and reads it in the worker (doc.tiff.project).
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
    stackPos: [],             // Analyzer STACK_POSITION: the Ch / Slice / Frame columns (no statistics of its own)
    limit: ['minThreshold', 'maxThreshold'],
    labels: [],
    // Analyzer.doSetDialog, second group: no statistics of their own, they change how the rows are made and shown
    invertY: [],
    scientific: [],
    addToOverlay: [],
    nanEmpty: []
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
  // IJ_* codes (engine, pure modules) and loader codes → plugin lang keys.
  const ERROR_KEYS = {
    IJ_OVER_BUDGET: 'err.overBudget',
    IJ_NOT_32BIT: 'err.not32bit',
    IJ_BAD_ROI: 'err.badRoi',
    IJ_TOO_LARGE: 'err.tooLarge',
    IJ_PICTURE_TOO_LARGE: 'err.pictureTooLarge',
    IJ_TIFF_UNSUPPORTED: 'err.tiffUnsupported',
    IJ_INCOMPLETE: 'err.incomplete',
    IJ_WORKER_CRASHED: 'err.workerCrashed',
    IJ_NOTHING_TO_UNDO: 'err.noUndo',
    IJ_NOT_BINARY: 'err.not8bit',
    IJ_PARTICLES_THRESHOLD: 'dlg.ana.partNeedsThreshold',
    IJ_MODULE_MISSING: 'err.moduleMissing',
    IJ_STORAGE_QUOTA: 'err.storageFull',
    IJ_STORAGE_FAILED: 'err.storageFailed',
    IJ_EMPTY_ROI: 'err.emptyRoi',
    IJ_NEEDS_ROI: 'err.needsRoi',
    IJ_BAD_ARGS: 'err.badArgs',
    IJ_BAD_TYPE: 'err.badType',
    IJ_UNKNOWN_OP: 'err.unknownOp',
    IJ_UNKNOWN_CMD: 'err.moduleMissing',
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
    'ij-proc-edit.js', 'ij-proc-fiji.js', 'ij-proc-lib.js', 'ij-proc-stk.js'];
  const PACKAGE_FILE_RX = /^ij-proc-([a-z0-9]+)\.js$/;
  const PACKAGE_NAMES = WORKER_SCRIPTS.map((f) => PACKAGE_FILE_RX.exec(f)).filter((m) => m && m[1] !== 'shared').map((m) => m[1]);
  const ESTIMATE_MIN_FRACTION = 1 / 64; // an image under budget/64 never needs the estimate round trip
  const PERSIST_MS = 1200;
  // The events api.on knows ('ext:<name>' = what a worker command posted), the settings with their defaults, the prefix each
  // package owns in api.settings (PLAN-wave3 §1.1; the core keys belong to `edit`), ImageJ's colour names.
  const EVENT_NAMES = new Set(['activeDoc', 'roi', 'doc', 'results', 'layout', 'tool']);
  const PREFS_KEY = 'lumen3d.ij.prefs';
  const SETTING_DEFAULTS = { 'conv.scale': true, 'conv.weighted': false, 'conv.fullRange16': false, 'misc.divZero': 'Infinity', 'colors.foreground': 'white',
    'colors.background': 'black', 'colors.selection': 'yellow', 'appearance.interpolate': false, 'appearance.useNames': false };
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
  // ImageJ's type (24 for an RGB image, whose storage depth is 8): the commands that need an 8-bit image do not take a colour one
  const typeOf = (d) => (typeof IJStack !== 'undefined' ? IJStack.bitDepthOf(d) : d.bitDepth);
  const is8 = (st) => has(st) && typeOf(st.doc) === 8;
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
    cmd('fileSaveJpeg', ['File', 'SaveAs'], { run: (a) => a.saveJpeg() }),
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
    cmd('typeBit8', ['Image', 'Type'], { enabled: (st) => has(st) && typeOf(st.doc) !== 8, run: (a) => a.convertType(8) }),
    cmd('typeBit16', ['Image', 'Type'], { enabled: (st) => has(st) && typeOf(st.doc) !== 16, run: (a) => a.convertType(16) }),
    cmd('typeBit32', ['Image', 'Type'], { enabled: (st) => has(st) && typeOf(st.doc) !== 32, run: (a) => a.convertType(32) }),
    cmd('adjustBC', ['Image', 'Adjust'], Object.assign(sc('Shift+C'), { run: (a) => a.openTool('bc') })),
    cmd('adjustThreshold', ['Image', 'Adjust'], Object.assign(sc('Shift+T'), { run: (a) => a.openTool('threshold') })),
    cmd('imageInfo', ['Image'], { run: (a) => a.showInfo() }),
    cmd('colorChannels', ['Image', 'Color'], { run: (a) => a.openTool('channels') }),
    // Z Project...: on an image that is a stack it projects the stack (package stk, ZProjector); on a single plane it is the figure entry (project a slab of the Studio volume)
    cmd('stackProject', ['Image', 'Stacks'], { enabled: (st) => !st.busy && (!!st.canProject || (!!st.doc && (st.doc.nZ || 1) * (st.doc.nT || 1) > 1)), run: (a) => stackProjectCommand(a) }),
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
      cmd('analyzePlotProfile', ['Analyze'], Object.assign(sc('k'), { enabled: (st) => has(st) && !!st.roi && (st.roi.type === 'line' || st.roi.type === 'polyline' || st.roi.type === 'rect'), run: (a) => a.plotProfile() })),
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
    fileOpen: 10, fileSaveTiff: 10, fileSaveJpeg: 12, fileSavePng: 20, fileSaveResults: 30, fileRevert: 30, fileRecover: 40, fileClose: 20, fileSimple: 60, fileCloseStudio: 70,
    editUndo: 10, editRedo: 20, editClear: 30, editClearOutside: 40, editFill: 50, editInvert: 60,
    editSelectAll: 10, editSelectNone: 20, editRestoreSelection: 30, editMakeInverse: 100, editAddToManager: 240,
    typeBit8: 10, typeBit16: 20, typeBit32: 30,
    adjustBC: 10, adjustThreshold: 20,
    imageInfo: 30, colorChannels: 40, stackProject: 100, imageCrop: 80, imageDuplicate: 90,
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
  const SEPARATOR_ABOVE = new Set(['fileClose', 'fileSimple', 'editClear', 'imageCrop', 'lutFire', 'lut16Colors', 'binErode', 'analyzeHistogram', 'windowNext']);
  // Position of each submenu inside its parent list (keyed by the path of menu names).
  const GROUP_META = {
    'File/New': { order: 5 }, 'File/Import': { order: 15 }, 'File/SaveAs': { order: 25 },
    'Edit/Selection': { order: 70, separatorBefore: true }, 'Edit/Options': { order: 80 },
    'Image/Type': { order: 10 }, 'Image/Adjust': { order: 20, separatorBefore: true }, 'Image/Color': { order: 60 }, 'Image/Stacks': { order: 70 }, 'Image/Stacks/Animation': { order: 150 }, 'Image/Stacks/Tools': { order: 160 }, 'Image/Hyperstacks': { order: 75 },
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

  /**
   * ij.gui.ImageWindow.getImageSize: the size the Window menu shows after an image's title. size = bytes / 1024.0;
   * < 1024 → d2s(size, 0) + "K"; < 10000 → d2s(size / 1024, 1) + "MB"; < 1048576 → d2s(round(size / 1024), 0) + "MB";
   * else d2s(size / 1048576, 1) + "GB"; a trailing ".0" is dropped.
   */
  function imageSizeString(bytes) {
    const d2s = (n, p) => (typeof IJOv !== 'undefined' ? IJOv.d2s(n, p) : n.toFixed(p));
    const size = bytes / 1024.0;
    let s;
    if (size < 1024.0) s = d2s(size, 0) + 'K';
    else if (size < 10000.0) s = d2s(size / 1024.0, 1) + 'MB';
    else if (size < 1048576.0) s = d2s(Math.floor(size / 1024.0 + 0.5), 0) + 'MB';
    else s = d2s(size / 1048576.0, 1) + 'GB';
    return s.replace(/\.0(?=[KMG])/, '');
  }

  /** Output bit depth of a projection (PLAN §3.4 IJProject). */
  function outputBitDepth(method, depth, inputBitDepth) {
    // IJProject.outputBitDepth (ij-core.js) is the one rule: without the input depth the legacy 8-bit-source rule (max / min 8,
    // sum 16 up to 257 slices, the rest 32), with it ZProjector's (a 16-bit TIFF keeps 16 bits for max / min / average; median, sum and sd are 32-bit float).
    if (typeof IJProject !== 'undefined' && typeof IJProject.outputBitDepth === 'function') return IJProject.outputBitDepth(method, depth, inputBitDepth);
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
      // a level lists its planes (`indices`), a TIFF's page plan (IJLibSource.tiffFacts: width, height, slices) only counts them (`depth`)
      const depth = lv.indices ? lv.indices.length : (lv.depth | 0);
      return { level: lv.level, width: lv.width, height: lv.height, depth,
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
    previewSeq: 0, previewTimer: 0, previewRedo: null, pointer: null, pixelBusy: false, pixelDirty: false,
    persistTimer: 0, persistAsked: false, firstCommitDone: false,
    visHandler: null, menuList: [], unprotected: new Set(), held: new Set(), warnBudget: '', warnLow: false,
    summaryRows: [],          // one row per Analyze Particles run (the Summary window)
    locks: new Map(),         // session key → release() of the Web Lock held while this tab uses it
    emptyEl: null, displayPatch: new Map(), displayInflight: new Map(),
    openCounter: 0, savedAt: 0,
    engineBudget: 0,          // the budget the engine says it runs with (its 'budget' events)
    threshold: null,          // { docId, channel, lower, upper, dark } while the Threshold window holds one
    failedPackages: new Set(), // packages whose ij-proc file did not load in the worker
    engineOps: null,           // name → { name, kind, stack, rgb } of every op the worker has registered (engine.ops), null until it answered
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
    wand: { tolerance: 0, mode: 8 }, // the Wand tool's options (tolerance in pixel values, 4- or 8-connected)
    // stacks (PLAN stacks §2): the plane on screen is the page's; the engine is told through a coalescer, every request names it (pos)
    pos: new Map(),           // docId → { z, t } (0-based) on screen
    posSync: new Map(),       // docId → coalescer of doc.setPosition (at most one in flight, the last value wins)
    labels: new Map(),        // docId → (string|null)[nSlices] | null (none), absent = not read yet
    anim: new Map(),          // docId → { timer, dir, fps } of a running animation
    animOpts: new Map()       // docId → { fps, first, last, backAndForth, start } (Animation Options, per image like Calibration.fps)
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
    S.engineOps = null;
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

  // The commands that read or change the pixels of ONE plane of a stack: each names the plane on screen (`pos`) unless the caller did.
  // The engine's own current plane follows the page's through a coalescer, so it is never what a request relies on.
  const POS_COMMANDS = new Set(['doc.run', 'doc.preview', 'doc.estimate', 'doc.compute', 'doc.stats', 'doc.histogram', 'doc.profile',
    'doc.threshold', 'doc.particles', 'doc.pixel', 'doc.tile']);
  function call(cmdName, args, transfer, o) {
    const c = S.worker;
    if (!c || c.dead) return Promise.reject(Object.assign(new Error('worker is down'), { code: 'IJ_WORKER_CRASHED' }));
    if (args && args.pos === undefined && args.docId !== undefined && args.docId !== null && POS_COMMANDS.has(cmdName)) {
      const at = posArg(args.docId);
      if (at) args = Object.assign({}, args, { pos: at });
    }
    // A request over several documents (docIds, a Redirect-to image) names the plane the page shows for each of the OTHER ones: the
    // engine's own position follows the page through a coalescer, so a second image scrolled a moment ago could still be read at its old plane.
    if (args && POS_COMMANDS.has(cmdName) && args.posOf === undefined) {
      const others = new Set(Array.isArray(args.docIds) ? args.docIds : []);
      if (args.redirect && args.redirect.docId !== undefined && args.redirect.docId !== null) others.add(args.redirect.docId);
      others.delete(args.docId);
      const posOf = {};
      for (const id of others) { const at = posArg(id); if (at) posOf[id] = at; }
      if (Object.keys(posOf).length) args = Object.assign({}, args, { posOf });
    }
    // An RGB image is measured and filtered on its luminance: weighted (0.299 / 0.587 / 0.114) or not ((R+G+B)/3, ImageJ's default) as
    // Edit > Options > Conversions says. The reads take it as an argument, the ops that see the luminance as a parameter.
    if (args && POS_COMMANDS.has(cmdName) && args.docId !== undefined && args.docId !== null) {
      const di = S.docs.get(args.docId);
      if (di && di.rgb) {
        const weighted = settingGet('conv.weighted') === true;
        if (args.params && typeof args.params === 'object' && args.params.rgbWeighted === undefined && (cmdName === 'doc.run' || cmdName === 'doc.compute' || cmdName === 'doc.preview' || cmdName === 'doc.estimate')) args = Object.assign({}, args, { params: Object.assign({}, args.params, { rgbWeighted: weighted }) });
        else if (args.rgbWeighted === undefined && cmdName !== 'doc.pixel' && cmdName !== 'doc.tile') args = Object.assign({}, args, { rgbWeighted: weighted });
      }
    }
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
        if (client) {
          client.ready = true; clearTimeout(client.readyTimer);
          // every registered op (the engine's own and the packages') with what the page decides on: engine.ops, once per worker
          client.opsReady = call('engine.ops', {}).then((list) => {
            const m = new Map();
            for (const o of Array.isArray(list) ? list : []) m.set(o.name, o);
            S.engineOps = m;
          }).catch((err) => { console.error('[advanced-studio] engine.ops', err); });
        }
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
        { const v = viewOf(m.docId); if (m.seq === S.previewSeq && v && previewOnScreenPlane(m)) { v.setPreview(m); S.previewDocs.add(m.docId); } }
        break;
      case 'invalidate': {
        const iv = viewOf(m.docId);
        if (!iv) break;
        if (m.sizeChanged) refreshInfo(m.docId).then((info) => { S.labels.delete(m.docId); afterLayoutChange(m.docId, info); refreshView(m.docId); emit('doc', { docId: m.docId, kind: 'size' }); }).catch(reportError);
        else if (m.calibration) refreshInfo(m.docId).then(() => { S.labels.delete(m.docId); loadLabels(m.docId); if (S.shell) S.shell.updateInfo(viewInfo(m.docId)); refreshUi(); emit('doc', { docId: m.docId, kind: 'size' }); }).catch(reportError);
        else { iv.invalidate(m.channels, Array.isArray(m.planes) ? m.planes : undefined); emit('doc', { docId: m.docId, kind: 'pixels' }); }
        if (m.docId === S.activeId) scheduleToolRefresh('pixels');
        break;
      }
      case 'docCreated':
        // an image a worker-side request made (E.runOp of a macro or a package's command; a page-side doc.run carries its own answer):
        // adopted like a Duplicate, from the image it was made from, unless the page already knows it
        if (m.info && m.info.docId !== undefined && !S.docs.has(m.info.docId)) adoptNewDocs([m.info.docId], S.docs.has(m.source) ? m.source : undefined).catch(reportError);
        break;
      case 'position':
        // E.setPosition (a macro, a package's worker command): the view follows, nothing is sent back to the engine
        if (S.docs.has(m.docId)) movePlane(m.docId, { c: m.c, z: m.z, t: m.t }, { fromEngine: true });
        break;
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
  /** A stack's preview carries the plane it was computed on (`pi`); one that arrives after the view moved to another plane is stale. */
  function previewOnScreenPlane(m) {
    if (m.pi === undefined) return true;
    const info = S.docs.get(m.docId);
    if (!info) return false;
    const p = planeOf(m.docId);
    return p.t * stackDims(info).nZ + p.z === m.pi;
  }
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
      activeChannel: info ? activeChannel(info) : 0,
      // stacks: what a command's `enabled` decides on (Next Slice needs a stack, Z Project needs slices, a hyperstack command a hyperstack…)
      nSlices: info ? (info.nSlices | 0) || 1 : 0, nZ: info ? (info.nZ | 0) || 1 : 0, nT: info ? (info.nT | 0) || 1 : 0, nC: info ? (info.rgb ? 1 : (info.channels || []).length) : 0,
      rgb: !!(info && info.rgb), hyperstack: !!(info && info.hyperstack), animating: !!(info && S.anim.has(info.docId))
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
    const out = Object.assign({}, info, {
      channels: (info.channels || []).map((c, i) => Object.assign({}, c, { display: Object.assign({}, c.display || {}, d.channels[i] || {}) })),
      display: { mode: d.mode, active: S.activeCh.get(docId) || 0, visible: d.visible.slice() }
    });
    // a stack: the plane on screen is the page's (the engine's follows through the coalescer)
    if (isStackInfo(info)) { const p = planeOf(docId); out.z = p.z; out.t = p.t; out.label = sliceLabelAt(docId, p, S.activeCh.get(docId) || 0); }
    return out;
  }

  // ───────────────────────────── stacks: position, labels, animation ─────────────────────────────
  // ImageJ's StackWindow / Animator. The plane on screen belongs to the page: a slider moves the view at once (the tile requests
  // carry the plane), the engine's current plane follows through a coalescer (at most one doc.setPosition in flight, the last value
  // wins), and every request that reads or changes pixels names the plane it means (`pos`), so a late sync can never misdirect it.

  const VP = () => (typeof IJViewPure !== 'undefined' ? IJViewPure : null);
  const isStackInfo = (info) => !!info && ((info.nZ | 0) > 1 || (info.nT | 0) > 1);
  const stackDims = (info) => ({ nC: (info && info.nC) || (info && info.channels ? info.channels.length : 1) || 1, nZ: Math.max(1, (info && info.nZ) | 0 || 1), nT: Math.max(1, (info && info.nT) | 0 || 1) });

  /** { z, t } on screen (0-based), clamped into the image. */
  function planeOf(docId) {
    const info = S.docs.get(docId);
    if (!info) return { z: 0, t: 0 };
    const d = stackDims(info);
    const p = S.pos.get(docId) || { z: info.z | 0, t: info.t | 0 };
    return { z: Math.max(0, Math.min(d.nZ - 1, p.z | 0)), t: Math.max(0, Math.min(d.nT - 1, p.t | 0)) };
  }
  /** { c, z, t } on screen (api.position): c is the active channel. */
  function positionOf(docId) {
    const info = S.docs.get(docId);
    const p = planeOf(docId);
    const n = info && !info.rgb ? Math.max(1, (info.channels || []).length) : 1;
    return { c: Math.max(0, Math.min(n - 1, S.activeCh.get(docId) || 0)), z: p.z, t: p.t };
  }
  /** The `pos` a request carries: the plane on screen of a stack; undefined for a single plane (the message stays as it was). */
  function posArg(docId) {
    const info = S.docs.get(docId);
    if (!isStackInfo(info)) return undefined;
    const p = planeOf(docId);
    return { z: p.z, t: p.t };
  }
  /** The label of one plane (ImageStack.getSliceLabel): the page keeps the list the engine sent (doc.labels), read when a stack opens. */
  function sliceLabelAt(docId, p, c) {
    const list = S.labels.get(docId);
    const info = S.docs.get(docId);
    if (!list || !info) return null;
    const d = stackDims(info);
    const n = (p.t * d.nC * d.nZ) + (p.z * d.nC) + (info.rgb ? 0 : (c | 0)) + 1;
    const v = list[n - 1];
    return typeof v === 'string' && v !== '' ? v : null;
  }
  function loadLabels(docId) {
    const info = S.docs.get(docId);
    if (!info || !((info.nSlices | 0) > 1) || !S.worker || S.worker.dead) { S.labels.delete(docId); return Promise.resolve(); }
    return call('doc.labels', { docId }).then((r) => {
      if (!S.docs.has(docId)) return;
      S.labels.set(docId, r && Array.isArray(r.labels) ? r.labels : null);
      if (S.shell && S.shell.repaintSubtitle) S.shell.repaintSubtitle(docId);
    }).catch((err) => { console.error('[advanced-studio] doc.labels', err); });
  }

  /**
   * Puts the view on a plane. `how.fromShell` = the operator moved a slider (the shell already shows it); `how.fromEngine` = the
   * engine moved its current plane (E.setPosition of a macro); neither sends the engine a doc.setPosition back.
   */
  function movePlane(docId, pos, how) {
    const info = S.docs.get(docId);
    if (!info) return null;
    const h = how || {};
    const d = stackDims(info);
    const clampC = (v) => Math.max(0, Math.min((info.rgb ? 1 : Math.max(1, (info.channels || []).length)) - 1, v | 0));
    const next = { z: Math.max(0, Math.min(d.nZ - 1, (pos && pos.z !== undefined ? pos.z : planeOf(docId).z) | 0)), t: Math.max(0, Math.min(d.nT - 1, (pos && pos.t !== undefined ? pos.t : planeOf(docId).t) | 0)) };
    const was = planeOf(docId);
    S.pos.set(docId, next);
    if (pos && pos.c !== undefined && !h.fromShell && !info.rgb && clampC(pos.c) !== (S.activeCh.get(docId) || 0)) setDocDisplayMode(docId, { active: clampC(pos.c) });
    const moved = next.z !== was.z || next.t !== was.t;
    if (S.shell && !h.fromShell && S.shell.setPosition) S.shell.setPosition(docId, positionOf(docId), { keepStatus: true });
    if (!moved) return Promise.resolve(next);
    if (!h.fromEngine) syncEnginePosition(docId);
    refreshRois();
    if (docId === S.activeId) scheduleToolRefresh('pixels');
    scheduleMetaPersist();
    // an open dialog's preview was computed on the plane just left: drop it and ask again for the new one
    if (S.previewRedo && S.previewRedo.docId === docId) { clearPreviews(); S.previewRedo.run(); }
    emit('doc', { docId, kind: 'position' });
    return Promise.resolve(next);
  }
  function syncEnginePosition(docId) {
    let co = S.posSync.get(docId);
    if (!co) {
      if (!VP()) return;
      co = VP().createCoalescer(async () => {
        const p = positionOf(docId);
        if (!S.docs.has(docId) || !S.worker || S.worker.dead) return;
        const res = await call('doc.setPosition', { docId, z: p.z, t: p.t, c: p.c });
        if (res && res.info && S.docs.has(docId)) S.docs.set(docId, res.info);
      });
      S.posSync.set(docId, co);
    }
    co.request(positionOf(docId));
  }
  /** Resolves once the engine's current plane is the one on screen (a command that reads `pos`-less state waits for it). */
  function flushPosition(docId) {
    const co = S.posSync.get(docId);
    return co ? co.flush() : Promise.resolve();
  }
  /** The shell's slider / key / wheel: the view is already there. */
  function onShellPosition(pos, docId) {
    const id = docId !== undefined && docId !== null ? docId : S.activeId;
    if (id === null || !S.docs.has(id)) return;
    movePlane(id, pos, { fromShell: true });
  }

  // ── Animation (ij.plugin.Animator): Start / Stop Animation, Animation Options (speed 7 fps, first / last, back and forth) ──
  function animOptionsOf(docId) {
    const info = S.docs.get(docId);
    const o = S.animOpts.get(docId) || {};
    return VP() && info ? VP().animationPlan(info, o) : null;
  }
  function animationRunning(docId) { return S.anim.has(docId); }
  function stopAnimation(docId) {
    const a = S.anim.get(docId);
    if (!a) return false;
    clearTimeout(a.timer);
    S.anim.delete(docId);
    if (S.shell && S.shell.setRunning) S.shell.setRunning(docId, null);
    return true;
  }
  function startAnimation(docId) {
    const info = S.docs.get(docId);
    if (!info || !VP()) return false;
    const plan = animOptionsOf(docId);
    if (!plan || !plan.row || plan.row.max <= 1) return false;
    stopAnimation(docId);
    const run = { timer: 0, dir: 1, fps: plan.fps };
    S.anim.set(docId, run);
    if (S.shell && S.shell.setRunning) S.shell.setRunning(docId, plan.fps);
    // a frame waits for the tiles of the plane it shows: a view that is still loading drops frames instead of queueing them
    const tick = () => {
      if (S.anim.get(docId) !== run) return;
      const v = viewOf(docId);
      const stats = v && v.getStats ? v.getStats() : null;
      const cur = S.docs.get(docId);
      if (!cur) { stopAnimation(docId); return; }
      if (!(stats && stats.loading)) {
        const pl = animOptionsOf(docId);
        const pos = positionOf(docId);
        const value = pl.dim === 'c' ? pos.c + 1 : pl.dim === 'z' ? pos.z + 1 : pl.dim === 't' ? pos.t + 1 : pos.t * stackDims(cur).nZ + pos.z + 1;
        const nx = VP().animationNext(pl, value, run.dir);
        run.dir = nx.dir;
        const np = VP().positionFromRow(cur, pos, pl.row, nx.value);
        movePlane(docId, np, {});
      }
      run.timer = setTimeout(tick, Math.max(1, Math.round(1000 / run.fps)));
    };
    run.timer = setTimeout(tick, Math.max(1, Math.round(1000 / run.fps)));
    return true;
  }
  function toggleAnimation(docId) { return animationRunning(docId) ? (stopAnimation(docId), false) : startAnimation(docId); }
  function setAnimationOptions(docId, o) {
    const cur = S.animOpts.get(docId) || {};
    const next = Object.assign({}, cur, o || {});
    S.animOpts.set(docId, next);
    scheduleMetaPersist();
    if (animationRunning(docId)) startAnimation(docId);
    return animOptionsOf(docId);
  }

  /**
   * ImageJ's YesNoCancelDialog "Process all N images?" of a PlugInFilter with DOES_STACKS (title "Process Stack?"): Yes = every
   * plane, No = the current one, Cancel = null. A single plane answers 'current' at once; macro mode answers from `stack`.
   */
  async function askStack(info, spec) {
    const sp = spec || {};
    const planes = isStackInfo(info) ? stackDims(info).nZ * stackDims(info).nT : 1;
    if (planes <= 1) return 'current';
    // Macro mode (IJ.setupDialog): the word `stack` in the options is Yes, its ABSENCE is No — the current plane only
    if (sp.stack === 'all') return 'all';
    if (sp.stack === 'current' || sp.macro === true) return 'current';
    const r = await ask({ title: tr('dlg.processStack'), message: tr('dlg.processAll', { n: info.nSlices || planes }),
      options: [{ id: 'all', label: tr('dlg.yes'), primary: true }, { id: 'current', label: tr('dlg.no') }, { id: 'cancel', label: tr('dlg.cancel') }], dismissId: 'cancel' });
    return r === 'all' || r === 'current' ? r : null;
  }

  /**
   * Display change of one channel: the display updates at once (uniforms), the worker is told
   * with at most one request in flight per document, the newest patch winning.
   */
  function setChannelDisplay(docId, channel, patch) {
    const d = S.dstate.get(docId);
    if (!d || !d.channels[channel]) return;
    // An RGB image has ONE display range (ColorProcessor.setMinAndMax): the three colour planes move together
    const info = S.docs.get(docId);
    const range = patch && (patch.min !== undefined || patch.max !== undefined) ? Object.assign({}, patch.min !== undefined ? { min: patch.min } : null, patch.max !== undefined ? { max: patch.max } : null) : null;
    const targets = info && info.rgb && range ? [0, 1, 2].filter((i) => d.channels[i]) : [channel];
    for (const c of targets) {
      const part = c === channel ? patch : range;
      Object.assign(d.channels[c], part);
      const key = docId + ':' + c;
      S.displayPatch.set(key, Object.assign(S.displayPatch.get(key) || {}, part));
    }
    pushDisplay(docId);
    for (const c of targets) flushDisplayPatch(docId, c);
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
      // ImageCanvas draws ""+(index+1); the names only with Prefs.useNamesAsLabels
      const names = settingGet('appearance.useNames') === true;
      S.shell.setRois({ all: list.map((r, i) => Object.assign({ roi: r.roi, label: roiLabels ? (names ? r.name : String(i + 1)) : '', stroke: r.stroke, width: r.width, fill: r.fill }, r.position ? { position: r.position } : null)), showAll: S.showAll }, id);
    }
  }

  function tileProvider(docId) {
    // a stack's renderer names the plane of every tile it asks for (`pos` = { z, t }); a single image is asked as before
    return (channel, level, tx, ty, pos) => call('doc.tile', pos ? { docId, channel, level, tx, ty, pos } : { docId, channel, level, tx, ty });
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
      if (!S.labels.has(docId) && (info.nSlices | 0) > 1) loadLabels(docId);
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
    dropStaleLabels(docId, res.changed);
    commitHook();
  }
  /** The slice labels the page cached are indexed by the dimensions they were read under: a size step (Delete Slice, Reverse, a revert, the
   *  undo of either) or a metadata step (Set Label, its undo) makes them stale. A size change reloads them with the view; a metadata one here. */
  function dropStaleLabels(docId, changed) {
    if (!changed || !(changed.sizeChanged || changed.calibration || changed.labels)) return;
    S.labels.delete(docId);
    if (!changed.sizeChanged) loadLabels(docId);
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
      // `workspace`: every session open here, so resuming any one of them brings the others back with it (restoreSession)
      const msg = { key, layout, annotations, sync: syncState(), luts, ext: S.extData, workspace: keys };
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
  /**
   * The `planes` of a pixel op's request: the caller's own (`opt.planes`, api.run) or, for an op of `stack: 'ask'` on a stack,
   * ImageJ's question. undefined = nothing to say (a single plane, an op that sees one plane, a size / compute op), null = cancelled.
   */
  async function opSpecOf(op) {
    // the ops the worker registered (its own and the packages'), asked once per worker; the page's registry is the fallback
    const c = S.worker;
    if (!S.engineOps && c && c.opsReady) await c.opsReady;
    const e = S.engineOps ? S.engineOps.get(op) : null;
    if (e) return e;
    return typeof IJOpRegistry !== 'undefined' ? IJOpRegistry.get(op) : null;
  }
  /** Is the image a multichannel one shown in Composite mode (ImageJ: a CompositeImage in COMPOSITE mode)? */
  function isCompositeShown(info) {
    const n = info && !info.rgb ? (info.channels || []).length : 1;
    const d = info ? S.dstate.get(info.docId) : null;
    return n > 1 && !!d && d.mode === 'composite';
  }
  /**
   * What a pixel op runs over on a stack, decided like ImageJ's IJ.setupDialog → { planes, channel } (channel undefined = the caller's),
   * undefined = nothing to say (a single plane, an op that sees one plane, a size / compute op), null = cancelled.
   *   · the caller's own `opt.planes` stand;
   *   · a multichannel image in COMPOSITE mode is processed WHOLE — every channel, every plane — with no question (unless a macro's
   *     options contain `slice`);
   *   · otherwise "Process all N images?" (macro mode: `stack` = Yes, else No); Yes on a multichannel image means every channel too.
   */
  async function planesFor(info, op, opt) {
    if (opt.planes !== undefined) return { planes: opt.planes };
    if (!isStackInfo(info)) return undefined;
    const spec = await opSpecOf(op);
    if (!spec || spec.kind !== 'pixel' || spec.stack !== 'ask') return undefined;
    const multi = !info.rgb && (info.channels || []).length > 1;
    if (isCompositeShown(info) && opt.slice !== true) return { planes: 'all', channel: 'all' };
    const a = await askStack(info, { stack: opt.stack, macro: opt.macro });
    if (a === null) return null;
    return a === 'all' && multi ? { planes: a, channel: 'all' } : { planes: a };
  }

  async function askNoUndo(info, op, params, roi, channel, planes) {
    const nPlanes = planes === 'all' ? stackDims(info).nZ * stackDims(info).nT : 1;
    const bytes = (info.channels || []).length * info.width * info.height * bytesPerPixel(info.bitDepth) * nPlanes;
    if (bytes < (S.engineBudget || S.budgetBytes) * ESTIMATE_MIN_FRACTION) return false;
    let est = null;
    try { est = await call('doc.estimate', Object.assign({ docId: info.docId, op, params, roi, channel }, posArg(info.docId) ? { pos: posArg(info.docId) } : {}, planes !== undefined ? { planes } : {})); } catch (_) { return false; } // the run reports the real error
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
      // DOES_STACKS: which planes a pixel op runs on (ImageJ's "Process all N images?" when the caller did not say)
      const plan = await planesFor(info, op, opt);
      if (plan === null) throw Object.assign(new Error('cancelled'), { code: 'IJ_CANCELLED' });
      const planes = plan ? plan.planes : undefined;
      const runChannel = plan && plan.channel !== undefined ? plan.channel : channel;
      const noUndo = opt.noUndo === true ? true : await askNoUndo(info, op, params || {}, roi, runChannel, planes);
      const args = { docId, op, params: params || {}, roi, channel: runChannel };
      const at = opt.pos !== undefined ? opt.pos : posArg(docId);
      if (at) args.pos = at;
      if (planes !== undefined) args.planes = planes;
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
          if (dv) dv.invalidate(d.changed ? d.changed.channels : undefined, d.changed && Array.isArray(d.changed.planes) ? d.changed.planes : undefined);
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
        if (rv) rv.invalidate(ch.channels, Array.isArray(ch.planes) ? ch.planes : undefined);
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
      dropStaleLabels(info.docId, res.changed);
      const uv = viewOf(info.docId);
      if (res.changed && res.changed.sizeChanged) { if (!res.changed.sameGeometry) { S.sel.delete(info.docId); clearAnnotations(info.docId); } await showDoc(info.docId); if (uv && !res.changed.sameGeometry) uv.fit(); }
      else if (res.changed && res.changed.calibration) { S.shell.updateInfo(viewInfo(info.docId)); refreshUi(); }
      else { if (uv) uv.invalidate(res.changed ? res.changed.channels : undefined, res.changed && Array.isArray(res.changed.planes) ? res.changed.planes : undefined); pushDisplay(info.docId); }
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
    // the blobs its previews pinned (a floating paste) are reclaimable again
    if (S.worker && !S.worker.dead) call('engine.unpinBlobs', {}).catch(() => {});
  }

  /** { op | compute, params(values), ... } of a dialog spec → the preview hook the view's dialog calls. */
  function extPreviewHook(pv, info) {
    const hook = {
      onChange(values, ctl) {
        if (!values) { S.previewRedo = null; clearExtPreview(); if (ctl) ctl.note(null); return; }
        S.previewRedo = { docId: info.docId, run: () => hook.onChange(values, ctl) };
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
    return hook;
  }

  // ── Repeat Command (owner P-ana; ij.Executer: "if (!(cmd.equals("Undo")||cmd.equals("Close"))) previousCommand = cmd;") ──
  // ImageJ re-runs the command and its dialog comes back with the values the last run used (the plugins keep them in static fields). Here the
  // dialogs a command opened are remembered by command id and position; Repeat Command (and only it: Executer.java re-runs the command, a
  // command started from Find Commands or by another command computes its defaults afresh) puts them back as the pre-filled values of the
  // same dialogs. A value is NOT put back where the default is not a plain remembered setting: a field with `remember: false`, a text field
  // (titles, names: Duplicate computes a unique title each time, `remember: true` opts a text field in) and a field whose default is not the one
  // it was offered last time (a size, a title or a range derived from the image on screen).
  const REPEAT = { run: null, memory: new Map(), offered: new Map(), next: null, nested: false };
  const REPEAT_CALLER = 'procRepeatCommand';
  function prefillFields(fields, values, offered) {
    if (!values || typeof values !== 'object') return fields;
    return fields.map((f) => {
      if (!f || !f.id || !Object.prototype.hasOwnProperty.call(values, f.id)) return f;
      if (f.remember === false || ((f.type === 'string' || f.type === 'textarea') && f.remember !== true)) return f;
      if (offered && Object.prototype.hasOwnProperty.call(offered, f.id) && offered[f.id] !== f.value) return f;
      const v = values[f.id];
      switch (f.type) {
        case 'check': return typeof v === 'boolean' ? Object.assign({}, f, { value: v }) : f;
        case 'number': case 'slider': return typeof v === 'number' && Number.isFinite(v) ? Object.assign({}, f, { value: v }) : f;
        case 'string': case 'textarea': return typeof v === 'string' ? Object.assign({}, f, { value: v }) : f;
        case 'choice': case 'radio': return (f.options || []).some((o) => (o && typeof o === 'object' ? o.value : o) === v) ? Object.assign({}, f, { value: v }) : f;
        default: return f;
      }
    });
  }

  async function dialog(config) {
    if (!S.shell) return null;
    const spec = Object.assign({}, config);
    if (Array.isArray(config.fields)) spec.fields = config.fields.map(expandField);
    const rep = REPEAT.run;
    const at = rep ? rep.k++ : -1;
    if (rep && Array.isArray(spec.fields)) {
      const offered = {};
      for (const f of spec.fields) if (f && f.id && (f.value === undefined || typeof f.value !== 'object')) offered[f.id] = f.value;
      rep.offered[at] = offered;
      if (rep.replay && rep.replay[at]) spec.fields = prefillFields(spec.fields, rep.replay[at], rep.replayOffered && rep.replayOffered[at]);
    }
    const info = activeInfo();
    const ext = !!(config.preview && (config.preview.op || config.preview.compute) && !config.preview.onChange);
    if (ext) spec.preview = info ? extPreviewHook(config.preview, info) : undefined;
    try {
      const res = await S.shell.windows.dialog(spec);
      if (rep && res && typeof res === 'object') rep.list[at] = res;
      return res;
    } finally { if (ext) clearExtPreview(); }
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
    const hook = {
      onChange(values, ctl) {
        clearTimeout(S.previewTimer);
        if (!values) { S.previewRedo = null; S.previewSeq++; clearPreviews(); if (ctl) ctl.note(null); return; }
        S.previewRedo = { docId: info.docId, run: () => hook.onChange(values, ctl) };
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
    return hook;
  }
  function endPreview() {
    S.previewRedo = null;
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

  /** File › Save As › Jpeg…: the plane on screen (a stack saves its current slice, as ImageJ's JpegWriter), quality 85 (ImageJ's default,
   *  `io.jpegQuality` when set). The browser's encoder takes the rendered RGB picture, so a grey image is a grey JPEG in RGB. */
  async function saveJpeg(docId) {
    const info = docId !== undefined && docId !== null ? S.docs.get(docId) : activeInfo();
    const sv = info ? viewOf(info.docId) : null;
    if (!info || !sv || !sv.renderToCanvas) return;
    const q = Number(settingGet('io.jpegQuality'));
    const quality = (Number.isFinite(q) ? clamp(Math.round(q), 0, 100) : 85) / 100;
    try {
      await saveFile(safeName(info.name, '.jpg'), 'image/jpeg', '.jpg', 'JPEG', async () => {
        const canvas = await sv.renderToCanvas({ scale: 1 });
        return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(Object.assign(new Error('jpeg'), { code: 'IJ_PNG_FAILED' }))), 'image/jpeg', quality));
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
    push('Label');
    // Stack position (Analyzer.saveResults adds STACK_POSITION after the statistics): Ch comes with Slice / Frame, behind the columns;
    // a multichannel image measured without it keeps the channel number right after the label
    const stackPos = used.has('Slice') || used.has('Frame');
    if (!stackPos) push('Ch');
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
    if (stackPos) { push('Ch'); push('Slice'); push('Frame'); }
    for (const k of seen) push(k);
    return cols;
  }
  const resultColumns = () => resultColumnsOf(S.results);
  function columnHeader(key) {
    const e = EXTRA_COLUMNS.find((c) => c[0] === key);
    return e ? e[1] : key;
  }
  // ── P-ana (wave 3): the Results table as ImageJ shows and writes it ──────────────────────────────────────────────
  // `ANA` holds the transient state of the Results window (rows are held by identity: a sort or a delete keeps the selection right).
  const ANA = { sel: new Set(), origin: -1, find: '', plotPrev: { color: 'blue', lineWidth: 1, symbol: 'Circle' } };
  const anaSetting = (key, fallback) => { const v = settingGet(key); return v === undefined || v === null ? fallback : v; };
  /** Analyze › Set Measurements › "Decimal places (0-9)" (Analyzer.precision, default 3). */
  const anaDecimals = () => { const d = Number(anaSetting('ana.decimals', 3)); return Number.isInteger(d) ? clamp(d, 0, 9) : 3; };
  /** ResultsTable.setPrecision: "(systemMeasurements&SCIENTIFIC_NOTATION)!=0?-precision:precision". */
  const anaPrecision = () => (S.measurements.includes('scientific') ? -anaDecimals() : anaDecimals());
  /**
   * One cell as ImageJ prints it (ResultsTable.getValueAsString): a number with the table's precision (a whole number without decimals);
   * a cell nobody filled is 0, or NaN with "NaN empty cells" (ResultsTable.setNaNEmptyCells); text as it is.
   */
  function cellText(r, c) {
    const v = r[c];
    if (v === undefined || v === null) return c === 'Label' ? '' : (S.measurements.includes('nanEmpty') ? 'NaN' : '0');
    if (typeof v === 'number') return typeof IJAna !== 'undefined' ? IJAna.cellString(v, anaPrecision()) : num(v, 4);
    return String(v);
  }
  /**
   * The table as text. mode 'save' = File › Save As (Edit › Options › Input/Output: "Save_column headers", "Save_row numbers"),
   * 'copy' = Edit › Copy ("Copy_column headers" off, "Copy_row numbers" on by default; TextPanel.copySelection puts the headers
   * only in front of a selection of every row). `indices` = the rows to write (null = all).
   */
  function resultsText(sep, mode, indices) {
    const cols = resultColumns();
    const save = mode !== 'copy';
    const wantHeaders = !!anaSetting(save ? 'ana.saveHeaders' : 'ana.copyHeaders', save);
    const wantNumbers = !!anaSetting(save ? 'ana.saveRowNumbers' : 'ana.copyRowNumbers', true);
    const q = (v) => {
      const s = v === undefined || v === null ? '' : String(v);
      return sep === ',' && /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const idx = indices || S.results.map((r, i) => i);
    const lines = [];
    if (wantHeaders && (!indices || indices.length === S.results.length)) lines.push((wantNumbers ? [' '] : []).concat(cols.map(columnHeader)).map(q).join(sep));
    for (const i of idx) lines.push((wantNumbers ? [String(i + 1)] : []).concat(cols.map((c) => q(cellText(S.results[i], c)))).join(sep));
    // TextPanel.copySelection: "if (i<selEnd || selEnd>selStart) sb.append('\n');" — a copy of one single row has no trailing newline
    return lines.join('\n') + (lines.length && !(mode === 'copy' && idx.length === 1) ? '\n' : '');
  }
  /** Edit › Options › Input/Output: "File extension for tables (.csv, .tsv or .txt)" decides the delimiter of a saved table. */
  function tableFormat() {
    const ext = String(anaSetting('ana.ext', '.csv')).toLowerCase();
    const csv = ext === '.csv';
    return { ext, sep: csv ? ',' : '\t', mime: csv ? 'text/csv' : (ext === '.tsv' ? 'text/tab-separated-values' : 'text/plain'), desc: csv ? 'CSV' : (ext === '.tsv' ? 'TSV' : 'Text') };
  }

  async function saveResults() {
    const f = tableFormat();
    try {
      await saveFile('Results' + f.ext, f.mime, f.ext, f.desc, async () => new Blob([resultsText(f.sep, 'save')], { type: f.mime }));
    } catch (err) { await reportError(err); }
  }

  // ── File › Open (package io): a TIFF (also the deflate-compressed ones of the Download Center), a PNG / JPEG / GIF / BMP
  // the browser decodes, a text image, a selection (.roi), a RoiSet (.zip) or a LUT (.lut). The dispatcher asks the file's
  // extension first, then its first bytes.
  const OPEN_ACCEPT = '.tif,.tiff,.png,.jpg,.jpeg,.gif,.bmp,.txt,.roi,.zip,.lut';
  /** A picture the browser decodes → an image document: grey = one 8-bit channel C1, colour = the channels R / G / B (the naming of
   *  File › New › System Clipboard, which decodes the same way). The main thread reads the picture in bands of at most ~1 Mpx, yielding
   *  between them, and refuses one larger than 268 Mpx (a microscopy picture can be large: the bands, not a full canvas, bound the memory). */
  const PICTURE_MAX_PIXELS = 268435456;
  const pictureTooLarge = () => Object.assign(new Error('too large'), { code: 'IJ_PICTURE_TOO_LARGE' });
  async function decodeBrowserImage(bytes, name) {
    if (typeof createImageBitmap !== 'function') throw IJFileKinds.error('IJ_IO_DECODE');
    let bmp;
    try { bmp = await createImageBitmap(new Blob([bytes])); } catch (_) { throw IJFileKinds.error('IJ_IO_DECODE'); }
    try {
      const w = bmp.width, h = bmp.height;
      if (!(w > 0 && h > 0) || w * h > PICTURE_MAX_PIXELS) throw pictureTooLarge();
      const n = w * h;
      const bandH = Math.max(1, Math.min(h, Math.floor(1048576 / w)));
      let canvas;
      try {
        if (typeof OffscreenCanvas === 'function') canvas = new OffscreenCanvas(w, bandH);
        else { canvas = document.createElement('canvas'); canvas.width = w; canvas.height = bandH; }
      } catch (_) { throw pictureTooLarge(); }
      const g = canvas.getContext('2d', { willReadFrequently: true });
      if (!g) throw IJFileKinds.error('IJ_IO_DECODE');
      const R = new Uint8Array(n), G = new Uint8Array(n), B = new Uint8Array(n);
      let gray = true;
      try {
        for (let y0 = 0; y0 < h; y0 += bandH) {
          const bh = Math.min(bandH, h - y0);
          g.clearRect(0, 0, w, bandH);
          g.drawImage(bmp, 0, y0, w, bh, 0, 0, w, bh);
          const px = g.getImageData(0, 0, w, bh).data;
          const o = y0 * w;
          for (let i = 0, m = w * bh; i < m; i++) {
            const r = px[i * 4], gg = px[i * 4 + 1], b = px[i * 4 + 2];
            R[o + i] = r; G[o + i] = gg; B[o + i] = b;
            if (r !== gg || gg !== b) gray = false;
          }
          await new Promise((res) => setTimeout(res, 0));
        }
      } catch (err) { if (err && err.code) throw err; throw IJFileKinds.error('IJ_IO_DECODE'); }
      const calibration = { pixelWidth: 1, pixelHeight: 1, unit: 'px' };
      const colors = gray ? ['#ffffff'] : ['#ff0000', '#00ff00', '#0000ff'];
      const names = gray ? ['C1'] : ['Red', 'Green', 'Blue'];
      // a colour picture is a 24-bit RGB image (ImageJ's Opener); one whose pixels are all grey opens as 8-bit
      return { name, width: w, height: h, bitDepth: 8, calibration, rgb: !gray,
        channels: (gray ? [R] : [R, G, B]).map((data, i) => ({ data, name: names[i], color: colors[i], display: { min: 0, max: 255, lut: IJLuts.forColor(colors[i]), invert: false } })) };
    } finally { if (bmp.close) bmp.close(); }
  }

  /** What File › Open and Import › Text Image do with a parsed text image: a 32-bit image, display range = the finite data range. */
  function textImageOf(t, name) {
    const r = IJTextIo.floatRange(t.data);
    return { name: name || 'Untitled', width: t.width, height: t.height, bitDepth: 32, calibration: { pixelWidth: 1, pixelHeight: 1, unit: 'px' },
      channels: [{ data: t.data, name: 'C1', color: '#ffffff', display: { min: r.min, max: r.max, lut: 'Grays', invert: false } }] };
  }

  /** Imports an image a reader built and shows it as an opened file: nothing unsaved until it is edited. */
  async function openOpened(image) {
    const transfer = [];
    const channels = image.channels.map((c) => {
      const data = c.data.byteOffset === 0 && c.data.byteLength === c.data.buffer.byteLength ? c.data : c.data.slice();
      transfer.push(data.buffer);
      const ch = { data, name: c.name, color: c.color };
      if (c.display) ch.display = c.display;
      return ch;
    });
    const stack = {};
    for (const k of ['rgb', 'nZ', 'nT', 'hyperstack', 'labels', 'mode']) if (image[k] !== undefined) stack[k] = image[k];
    const res = await call('doc.import', { image: Object.assign({ name: image.name, width: image.width, height: image.height, bitDepth: image.bitDepth, calibration: image.calibration, channels }, stack), provenance: { opened: true } }, transfer);
    const id = res.info.docId;
    await call('doc.markSaved', { docId: id });
    const info = await call('doc.info', { docId: id });
    registerDoc(info, { clean: true });
    await showDoc(id);
    if (viewOf(id)) viewOf(id).fit();
    commitHook();
  }

  async function openTiffBytes(bytes, buf, base) {
    // the worker reads every TIFF, the compressed ones too (doc.open): no strip loop runs on the page
    const res = await call('doc.open', { bytes, name: base }, [buf]);
    const info = res.info;
    registerDoc(info, { clean: true });
    await showDoc(info.docId);
    if (viewOf(info.docId)) viewOf(info.docId).fit();
    commitHook();
  }

  /** A selection file goes onto the active image; a RoiSet goes into the ROI Manager. */
  async function openRoiFile(bytes, fname) {
    // RoiReader.openRoi: "if (img==null || img.getWidth()<(r.x+r.width) || img.getHeight()<(r.y+r.height)) { ip = new ByteProcessor(
    // r.x+r.width+10, r.y+r.height+10); img = new ImagePlus(name, ip); img.show(); }  img.setRoi(roi);" — a blank 8-bit image named after the
    // file. (The stroke / fill / width the file carries are those of a ROI Manager entry; a selection of the image has no style here.)
    const d = IJRoiCodec.decodeEntry(bytes, { fileName: fname });
    let info = activeInfo();
    const r = IJRoi.bounds(d.roi);
    if (!info || info.width < r.x + r.w || info.height < r.y + r.h) {
      const w = Math.max(1, r.x + r.w + 10), h = Math.max(1, r.y + r.h + 10);
      if (w * h > 128 * 1000 * 1000) throw IJFileKinds.error('IJ_IO_TOO_LARGE');
      await openOpened({ name: fname, width: w, height: h, bitDepth: 8, calibration: { pixelWidth: 1, pixelHeight: 1, unit: 'px' },
        channels: [{ data: new Uint8Array(w * h), name: 'C1', color: '#ffffff', display: { min: 0, max: 255, lut: 'Grays', invert: false } }] });
      info = activeInfo();
    }
    setSelection(info.docId, d.roi, true);
    setStatus(tr('status.roiOpened', { name: d.name || fname }));
  }
  async function openRoiSet(bytes) {
    const info = activeInfo();
    if (!info) throw IJFileKinds.error('IJ_IO_NEEDS_IMAGE');
    const list = await IJRoiCodec.decodeSet(bytes);
    for (const d of list) S.roiList.push(roiEntryFromFile(info.docId, d));
    roiListChanged();
    openTool('roiManager');
  }
  function roiEntryFromFile(docId, d) {
    const e = { name: d.label || d.name || roiName(d.roi), docId, roi: d.roi };
    if (d.stroke) e.stroke = d.stroke;
    if (d.fill) e.fill = d.fill;
    if (d.width > 0) e.width = d.width;
    if (d.position && typeof d.position === 'object') e.position = d.position;
    return e;
  }
  /** The channels a look-up table is installed on: the active one, or every channel of a multichannel image shown in Grayscale mode
   *  (LutLoader.showLut: `if (imp.isComposite() && mode == GRAYSCALE) { setMode(COLOR); for each channel setC(c); setChannelColorModel(cm) }`). */
  function lutChannelsOf(info) {
    const n = (info.channels || []).length;
    const d = S.dstate.get(info.docId);
    if (n > 1 && d && d.mode === 'gray') return Array.from({ length: n }, (_, c) => c);
    return [activeChannel(info)];
  }

  /** File › Open of a .lut: the same behaviour as File › Import › LUT (package edit). A name of a built-in table or starting with '#' gets
   *  " (LUT)", a long one is cut to 56 characters; the table replaces the channel's (an inverted look-up table is not inverted again, as
   *  LutLoader.showLut: "ip.setColorModel(cm)"); with no image open the 256 x 32 ramp image (LutLoader.createImage) shows it. */
  async function openLutFile(bytes, base, fileName) {
    if (typeof IJLutFile === 'undefined' || typeof IJLutFile.parse !== 'function') throw IJFileKinds.error('IJ_IO_UNKNOWN_FORMAT');
    const parsed = IJLutFile.parse(bytes);
    const table = parsed && parsed.table ? parsed.table : parsed;
    const reserved = IJLuts.names().concat(typeof IJEdit !== 'undefined' ? [IJEdit.LUT_RGB332, IJEdit.LUT_REDGREEN] : []);
    let name = String(base || 'LUT').trim().slice(0, 56) || 'LUT';
    if (name.charAt(0) === '#' || reserved.indexOf(name) >= 0) name += ' (LUT)';
    await registerLutExt(name, table);
    const info = activeInfo();
    if (info) {
      // LutLoader.showLut on a composite shown in Grayscale: every channel takes the table and the image switches to Color
      const all = lutChannelsOf(info);
      for (const c of all) await setDisplayExt(info.docId, c, { lut: name, invert: false });
      if (all.length > 1) await setDisplayModeExt(info.docId, 'color');
      return;
    }
    const ramp = new Uint8Array(256 * 32);
    for (let y = 0; y < 32; y++) for (let x = 0; x < 256; x++) ramp[y * 256 + x] = x;
    const title = String(fileName || name);
    const taken = Array.from(S.docs.values(), (i) => i.name);
    await addDocExt({ name: typeof IJEdit !== 'undefined' && IJEdit.makeUniqueName ? IJEdit.makeUniqueName(title, taken) : title, width: 256, height: 32, bitDepth: 8,
      calibration: { pixelWidth: 1, pixelHeight: 1, unit: 'px' },
      channels: [{ data: ramp, name: 'C1', color: '#ffffff', display: { min: 0, max: 255, lut: name, invert: false } }] }, { placement: 'tab' });
  }

  async function openFileBody(f) {
    const fname = String(f.name || '');
    const buf = await f.arrayBuffer();
    const bytes = new Uint8Array(buf);
    const base = fname.replace(/\.[A-Za-z0-9]+$/, '') || undefined;
    switch (IJFileKinds.kindOf(fname, bytes)) {
      case 'tiff': return openTiffBytes(bytes, buf, base);
      case 'image': return openOpened(await decodeBrowserImage(bytes, base || 'Untitled'));
      case 'text': return openOpened(textImageOf(await IJTextIo.parseTextImageAsync(bytes), base));
      case 'roi': return openRoiFile(bytes, fname);
      case 'zip': return openRoiSet(bytes);
      case 'lut': return openLutFile(bytes, base, fname);
      default: throw IJFileKinds.error('IJ_IO_UNKNOWN_FORMAT');
    }
  }

  // The command returns at once, as it always did: the picker may stay open for as long as the operator likes, and the command
  // must not look "running" (Repeat Command, the menu state) meanwhile. Each file is opened under its own busy step.
  function openTiff() {
    pickFileExt({ accept: OPEN_ACCEPT, multiple: true }).then(async (files) => {
      if (!files) return;
      for (const f of files) await busy(tr('op.open'), () => openFileBody(f));   // one file that fails does not stop the others
    }).catch((err) => reportError(err));
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
      S.labels.delete(info.docId);
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
    stopAnimation(id);
    for (const m of [S.docs, S.activeCh, S.dstate, S.sel, S.prevSel, S.undo, S.cleanRev, S.revs, S.sessionKeys, S.sources, S.annot, S.annotDims, S.pos, S.posSync, S.labels, S.animOpts]) m.delete(id);
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
      const wasEmpty = !winOrder().length;
      const restored = [];
      const parts = [];          // [{ key, meta, ids }] in restore order
      let last = null;
      /** One stored session: its documents registered under its own key (each session keeps its own baselines). */
      const restoreOne = async (k) => {
        let res;
        try { res = await call('session.restore', { key: k }); }
        catch (err) { if (err && err.code === 'IJ_NO_SESSION') return false; throw err; }
        // the tables an extension registered must exist before a view names one
        if (res.meta) await restoreLuts(res.meta);
        const ids = [];
        for (const id of res.docIds || []) {
          if (S.docs.has(id)) continue;
          const info = await call('doc.info', { docId: id });
          registerDoc(info, { clean: false, sessionKey: k });
          ids.push(id); restored.push(id);
          if (!info.hidden) last = id;
          count++;
        }
        if (ids.length) holdSessionLock(k);
        parts.push({ key: k, meta: res.meta || null, ids });
        warned = warned.concat(res.warnings || []);
        return true;
      };
      if (!(await restoreOne(key))) return;
      // The images opened from the library beside it come back with it: each lives in a session of its own (lib|… keys, so File ›
      // Recover still lists it alone), and every session of a workspace lists the others (persistMeta's `workspace`). Only library
      // sessions follow: another figure session (the other source of the same figure, a recovered figure) stays the operator's choice
      // in the resume question. Only the ones still stored, not open here and not held by another tab.
      const first = parts[0].meta;
      const linked = first && Array.isArray(first.workspace) ? first.workspace.filter((k) => typeof k === 'string' && k !== key && k.startsWith('lib|')) : [];
      if (linked.length) {
        let stored = [];
        try { stored = ((await call('session.list', {})).sessions || []).map((s) => s.key); } catch (err) { console.error('[advanced-studio] session.list', err); }
        const open = new Set(S.sessionKeys.values());
        const elsewhere = await sessionsHeldElsewhere();
        for (const k of linked) {
          if (!stored.includes(k) || open.has(k) || elsewhere.has(k)) continue;
          try { await restoreOne(k); } catch (err) { console.error('[advanced-studio] restore linked session', err); }
        }
      }
      // every restored image gets a view, then ONE layout over all of them (only on an empty workspace, otherwise they join as
      // tabs). Results, the ROI list and the open windows were written into the session of the image that was active, so they
      // come from whichever session carries them; the layout and sync state are the same in every session of the workspace.
      for (const id of restored) refreshView(id);
      const withLayout = parts.find((p) => p.meta && p.meta.layout) || null;
      for (const p of parts) if (p.meta) restoreMeta(p.meta, { ids: restored, applyLayout: wasEmpty && p === withLayout });
      if (last !== null) {
        const act = S.shell && S.shell.layout.active() !== null && restored.includes(S.shell.layout.active()) ? S.shell.layout.active() : last;
        await showDoc(act);
        for (const id of restored) { const rv = viewOf(id); if (rv) rv.fit(); }
      }
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
      row(btn(tr('cmd.stackProject'), () => zProject(), 'ij-btn--primary'), btn(tr('cmd.fileOpen'), () => openTiff()),
        ...(EXT.panels.has('library') && typeof IJLibPage !== 'undefined' && IJLibPage.available() ? [btn(tr('cmd.fileOpenLibrary'), () => { openPanelExt('library').catch((err) => reportError(err)); })] : []),
        btn(tr('cmd.fileSimple'), () => simpleView())));
    S.shell.workspace.appendChild(S.emptyEl);
  }
  function hideEmpty() { if (S.emptyEl) { S.emptyEl.remove(); S.emptyEl = null; } }

  /** The Open from Library panel (ij-cmds-lib.js) reaches the page's Studio facade through this handshake: the extension API of the
   *  package has no member for it. Done first in enter(), so the panel works on a figure the Advanced view cannot read too. */
  function attachLibrary() {
    try { if (typeof IJLibPage !== 'undefined' && typeof IJLibPage.attach === 'function') IJLibPage.attach(S.ctx, { budget: () => S.engineBudget || S.budgetBytes }); } catch (err) { console.error('[advanced-studio] library', err); }
  }

  async function enter() {
    const token = ++S.enterToken;
    attachLibrary();
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

    let cands = [];
    try {
      const res = await call('session.list', { datasetId: desc.datasetId });
      const loaded = new Set(S.sessionKeys.values());
      const elsewhere = await sessionsHeldElsewhere();
      const docCount = (s) => (Array.isArray(s.docs) ? s.docs.length : Number(s.docs) || 0);
      const mine = (res.sessions || []).filter((s) => String(s.key).startsWith(fkey + '|') && !loaded.has(s.key) && !elsewhere.has(s.key) && docCount(s) > 0);
      mine.sort((a, b) => b.savedAt - a.savedAt);
      // the newest session of EACH source (the figure key of the TIFF source is fkey|tiff|…, matched by the same prefix)
      const seen = new Set();
      for (const s of mine) {
        const src = typeof IJLibSource !== 'undefined' ? IJLibSource.sourceOfKey(s.key, fkey) : 'processed';
        if (!seen.has(src)) { seen.add(src); cands.push({ session: s, source: src }); }
      }
    } catch (err) { console.error('[advanced-studio] session.list', err); }
    // A worker that died meanwhile has its own recovery path (crash / failed start): nothing to add here.
    if (token !== S.enterToken || !S.worker || S.worker.dead) return;

    if (cands.length) {
      // One saved session of the processed volume: the plain question. Otherwise each row says which source made it.
      const plainRow = cands.length === 1 && cands[0].source === 'processed';
      const when = (c) => new Date(c.session.savedAt).toLocaleString();
      const resumeOptions = plainRow ? [{ id: 'resume', label: tr('resume.resume'), primary: true }]
        : cands.map((c, i) => ({ id: i === 0 ? 'resume' : 'resume' + (i + 1), primary: i === 0, label: tr('resume.resumeSource', { source: tr(c.source === 'tiff' ? 'resume.sourceTiff' : 'resume.sourceProcessed'), time: when(c) }) }));
      const a = await ask({ title: tr('resume.title'), message: plainRow ? tr('resume.message', { time: when(cands[0]) }) : tr('resume.messageMany'),
        options: [...resumeOptions, { id: 'fresh', label: tr('resume.fresh') }, { id: 'cancel', label: tr('dlg.cancel') }], dismissId: 'cancel' });
      const at = resumeOptions.findIndex((o) => o.id === a);
      if (at >= 0) {
        // A stored session that yields no document is dropped and the fresh load follows.
        if ((await restoreSession(cands[at].session.key)) > 0) return;
        await call('session.discard', { key: cands[at].session.key }).catch(() => {});
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
    // a figure the Advanced view cannot read: the library (a dataset of the site, an original TIFF) is the other way in
    const library = EXT.panels.has('library') && typeof IJLibPage !== 'undefined' && IJLibPage.available();
    S.emptyEl = h('div', { class: 'ij-empty' }, h('p', { class: 'ij-banner', text }),
      row(...(library ? [btn(tr('cmd.fileOpenLibrary'), () => { openPanelExt('library').catch((err) => reportError(err)); }, 'ij-btn--primary')] : []),
        btn(tr('cmd.fileSimple'), () => simpleView(), library ? '' : 'ij-btn--primary')));
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
    // The original TIFF of the dataset (download/), when the mounted dataset has a usable one: the Source choice (PLAN-wave3 §4)
    const tiff = await probeFigureTiff(desc);
    const fields = [];
    const rememberedMethod = settingGet('lib.method');
    const method0 = typeof IJLibSource !== 'undefined' && IJLibSource.METHODS.indexOf(rememberedMethod) >= 0 ? rememberedMethod : 'avg';
    if (multi) {
      // ZProjector's dialog order: "Start slice:", "Stop slice:", "Projection type" (ZProjector.java:295-297); the methods in ZProjector.METHODS
      // order, the one last used (lib.method) the default, Average Intensity on first use (ZProjector.java:27)
      fields.push({ type: 'number', id: 'start', label: tr('proj.start'), value: 1, min: 1, max: n0, step: 1 });
      fields.push({ type: 'number', id: 'stop', label: tr('proj.stop'), value: n0, min: 1, max: n0, step: 1 });
      fields.push({ type: 'choice', id: 'method', label: tr('proj.method'), value: method0, options: [
        { value: 'avg', label: tr('proj.avg') }, { value: 'max', label: tr('proj.max') }, { value: 'min', label: tr('proj.min') },
        { value: 'sum', label: tr('proj.sum') }, { value: 'sd', label: tr('proj.sd') }, { value: 'median', label: tr('proj.median') },
        { value: 'stack', label: tr('proj.stack') }] });
    } else {
      fields.push({ type: 'message', id: 'single', label: tr('proj.single') });
    }
    let validate = null;
    if (tiff) {
      const f = tiff.facts;
      const remembered = settingGet('lib.source');
      const fitsTiff = (m) => {
        const bits = outputBitDepth(multi ? m : 'avg', f.slices, f.bitDepth);
        return planLevels({ channels: new Array(f.channels).fill(null), levels: [{ level: 0, width: f.width, height: f.height, depth: f.slices }] }, S.budgetBytes, bits)[0].fits;
      };
      fields.push({ type: 'choice', id: 'source', label: tr('proj.source'), value: remembered === 'processed' ? 'processed' : 'tiff', options: [
        { value: 'tiff', label: tr(f.level === null ? 'proj.sourceTiffNoLevel' : 'proj.sourceTiff', { bits: f.bitDepth, w: f.width, h: f.height, n: f.slices, size: tiff.entry.sizeBytes ? mb(tiff.entry.sizeBytes) + ' MB' : '?', level: f.level === null ? '?' : f.level }) },
        { value: 'processed', label: tr('proj.sourceProcessed', { w: fine.width, h: fine.height }) }] });
      fields.push({ type: 'message', id: 'tiffNote', label: tr('proj.tiffNote'), visibleIf: (vv) => vv.source !== 'processed' });
      if (f.coarser) fields.push({ type: 'message', id: 'tiffCoarser', label: tr('proj.tiffCoarser', { w: f.width, h: f.height, W: fine.width, H: fine.height }), visibleIf: (vv) => vv.source !== 'processed' });
      validate = (vv) => (vv.source !== 'processed' && !fitsTiff(multi ? vv.method : 'avg') ? { source: 'proj.tooLarge' } : null);
    }
    // "Stack" keeps every plane: the whole stack (and the undo step beside it) must fit the memory — the chosen source and level, the chosen range
    const stackFits = (vv) => {
      const a1 = clamp(Math.round(Number(vv.start)), 1, n0), b1 = clamp(Math.round(Number(vv.stop)), a1, n0);
      if (tiff && vv.source !== 'processed') return stackBytesOfTiff(desc, tiff, a1, b1) * 2 <= S.budgetBytes;
      const lv = (desc.levels || []).find((l) => l.level === Number(vv.level));
      if (!lv) return false;
      const [lo, hi] = mapRange(a1, b1, n0, lv.indices.length);
      return (hi - lo) * lv.width * lv.height * Math.max(1, nCh) * 2 <= S.budgetBytes;
    };
    if (multi) {
      const base = validate;
      validate = (vv) => {
        const r = base ? base(vv) : null;
        if (vv.method === 'stack') return stackFits(vv) ? null : { method: 'proj.stackTooLarge' };
        return r;
      };
    }
    fields.push({ type: 'choice', id: 'level', label: tr('proj.level'), value: fits[0].level, visibleIf: tiff ? (vv) => vv.source === 'processed' : undefined, options: levels.map((l) => ({
      value: l.level, disabled: !l.fits,
      label: tr('proj.levelItem', { w: l.width, h: l.height, c: nCh, mb8: mb(l.bytes8), mb32: mb(l.bytes32) }) + (l.fits ? '' : ' — ' + tr('proj.tooLarge')) })) });
    // the bit depths of the processed volume (the note) are not the TIFF's (tiffNote)
    fields.push({ type: 'message', id: 'note', label: tr('proj.note'), visibleIf: tiff ? (vv) => vv.source === 'processed' : undefined });
    const v = await dialog({ title: tr('cmd.stackProject'), fields, okLabel: tr('dlg.ok'), validate: validate || undefined });
    if (!v) return false;
    const method = multi ? v.method : 'max';
    const a = multi ? clamp(Math.round(Number(v.start)), 1, n0) : 1;
    const b = multi ? clamp(Math.round(Number(v.stop)), a, n0) : 1;
    if (multi && method !== 'stack') settingSet('lib', 'lib.method', method);
    if (tiff) settingSet('lib', 'lib.source', v.source === 'processed' ? 'processed' : 'tiff');
    if (method === 'stack') return loadStack(desc, tiff && v.source !== 'processed' ? tiff : null, { level: Number(v.level), a, b, n0 });
    if (tiff && v.source !== 'processed') return loadTiffProjection(desc, tiff, { method: multi ? method : 'avg', a, b, n0 });
    return loadProjection(desc, { method, level: Number(v.level), a, b, n0 });
  }

  /** The original TIFF of the figure's dataset, indexed and judged (IJLibSource.tiffFacts), or null: no library, a figure that is not an
   *  XY stack, no TIFF in download/, none the stream can read or that covers the volume. Cached per figure; never delays the dialog long. */
  let tiffProbe = null;
  async function probeFigureTiff(desc) {
    // the worker half of the library (doc.tiff.project) lives in ij-proc-lib.js: a copy that failed there leaves only the volume as a source
    if (desc.axis !== 'z' || typeof IJLibSource === 'undefined' || S.failedPackages.has('lib')) return null;
    const lib = S.ctx && S.ctx.studio && S.ctx.studio.library;
    if (!lib || typeof lib.describe !== 'function') return null;
    const key = figureKeyOf(desc);
    if (tiffProbe && tiffProbe.key === key) return tiffProbe.value;
    const live = desc.timepoint !== null && desc.timepoint !== undefined;
    const work = (async () => {
      const d = await lib.describe(desc.datasetId, live ? { timepoint: desc.timepoint } : {});
      if (!d || !Array.isArray(d.tiffs) || !d.tiffs.length) return null;
      const dims = d.levels && d.levels[0] ? d.levels[0].dims : null;
      let best = null;
      for (const entry of d.tiffs.slice(0, 6)) {
        let index;
        try { index = await lib.tiffIndex(d.id, entry.file); } catch (err) { console.error('[advanced-studio] tiff index', err); continue; }
        const facts = IJLibSource.tiffFacts(index, { physicalUm: d.physicalUm, dims, live: d.type === 'live' || live, timepoint: live ? desc.timepoint : null });
        if (facts.ok && (!best || facts.width * facts.height > best.facts.width * best.facts.height)) best = { entry, index, facts, dims };
      }
      return best;
    })();
    // A probe that has not answered in 6 s is left to finish: the dialog opens without the TIFF, and the next dialog of this figure
    // (Start again) gets the settled answer; only a settled answer is cached.
    const settled = work.then((v) => { if (!tiffProbe || tiffProbe.key !== key) tiffProbe = { key, value: v }; return v; }, (err) => { console.error('[advanced-studio] figure tiff', err); return null; });
    const pending = Symbol('pending');
    setStatus(tr('proj.probing'));
    let value = null;
    try {
      value = await Promise.race([settled, new Promise((resolve) => { const t = setTimeout(() => resolve(pending), 6000); if (t && t.unref) t.unref(); })]);
    } finally { setStatus(''); }
    if (value === pending) return null;
    return value;
  }

  /** Z Project of the figure's range from the dataset's original TIFF: the TIFF planes covering the same µm, read in the worker
   *  (doc.tiff.project: Range requests, IJProject at the TIFF's bit depth). The image frame is the voxel frame (x = X, y = Y). */
  async function loadTiffProjection(desc, tiff, opt) {
    const f = tiff.facts;
    const fine = finestLevel(desc);
    // the figure's slices (1-based positions of its finest level) → level-0 voxel indices
    const ia = fine.indices[opt.a - 1], ib = fine.indices[opt.b - 1];
    const dimsK = fine.dims && fine.dims.z > 0 ? fine.dims.z : null, dims0 = tiff.dims && tiff.dims.z > 0 ? tiff.dims.z : null;
    const toL0 = (i, up) => (dimsK && dims0 && dimsK !== dims0 ? (up ? Math.ceil(((i + 1) * dims0) / dimsK) - 1 : Math.floor((i * dims0) / dimsK)) : i);
    const first = toL0(ia, false), last = Math.max(first, toL0(ib, true));
    const r = IJLibSource.tiffRangeOf(f, tiff.dims ? tiff.dims.z : last + 1, first, last);
    const depth = r.jhi - r.jlo + 1;
    const method = depth > 1 ? opt.method : 'avg';
    const fkey = figureKeyOf(desc);
    // the figure key gains |tiff: entry matches `fkey|` so a resume offers the sessions of either source
    const sessionKey = [fkey, 'tiff', tiff.entry.file, method, opt.a + '-' + opt.b, Date.now().toString(36)].join('|');
    const provenance = { source: 'figure', input: 'tiff', datasetId: desc.datasetId, datasetName: desc.datasetName, treeKey: desc.treeKey, timepoint: desc.timepoint,
      axis: desc.axis, level: f.level, method, first: ia, last: ib, tiff: { file: tiff.entry.file, etag: tiff.index.size + '-' + tiff.index.mtime }, sessionKey };
    const name = ib > ia
      ? tr('proj.name', { dataset: desc.datasetName, axis: String(desc.axis).toUpperCase(), a: ia, b: ib, method: tr('proj.' + method) })      // the method that ran: one TIFF plane is a copy ('avg')
      : tr('proj.nameSingle', { dataset: desc.datasetName, axis: String(desc.axis).toUpperCase(), a: ia });
    const calibration = f.pixelUm ? { pixelWidth: f.pixelUm.x, pixelHeight: f.pixelUm.y, unit: 'µm' } : { pixelWidth: 1, pixelHeight: 1, unit: 'pixel' };
    const ac = new AbortController();
    S.loadAbort = ac;
    beginBusy(tr('load.openTiff'));
    let docId = null, ok = false;
    try {
      const res = await call('doc.tiff.project', { url: tiff.index.url, index: tiff.index, z0: r.jlo, z1: r.jhi, frame: f.frame, method,
        channels: f.names.map((n, i) => ({ c: i, name: n, color: f.colors[i] })), name, calibration, provenance, sessionKey }, [], { long: true });
      const info = res.info;
      docId = info.docId;
      registerDoc(info, { clean: true, sessionKey, provenance });
      holdSessionLock(sessionKey);
      ok = true;
      await showDoc(docId);
      if (viewOf(docId)) viewOf(docId).fit();
      commitHook();
    } catch (err) {
      if (docId !== null && !ok) call('doc.close', { docId }).catch(() => {});
      if (S.shell && !S.docs.size) { S.shell.clearImage(); showEmpty(); }
      else if (S.activeId !== null) await showDoc(S.activeId);
      endBusy();
      S.loadAbort = null;
      await reportError(err);
      return false;
    } finally { S.loadAbort = null; }
    endBusy();
    return ok;
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

  /** The TIFF planes the figure's slices a..b (1-based, finest level) cover: IJLibSource.tiffRangeOf over the level-0 indices (as loadTiffProjection). */
  function tiffRangeOfFigure(desc, tiff, a, b) {
    const f = tiff.facts, fine = finestLevel(desc);
    const ia = fine.indices[a - 1], ib = fine.indices[b - 1];
    const dimsK = fine.dims && fine.dims.z > 0 ? fine.dims.z : null, dims0 = tiff.dims && tiff.dims.z > 0 ? tiff.dims.z : null;
    const toL0 = (i, up) => (dimsK && dims0 && dimsK !== dims0 ? (up ? Math.ceil(((i + 1) * dims0) / dimsK) - 1 : Math.floor((i * dims0) / dimsK)) : i);
    const first = toL0(ia, false), last = Math.max(first, toL0(ib, true));
    return { ia, ib, r: IJLibSource.tiffRangeOf(f, tiff.dims ? tiff.dims.z : last + 1, first, last) };
  }
  /** Bytes a stack of the figure's range holds when read from the original TIFF (every plane of every channel at the TIFF's bit depth). */
  function stackBytesOfTiff(desc, tiff, a, b) {
    const f = tiff.facts, { r } = tiffRangeOfFigure(desc, tiff, a, b);
    return (r.jhi - r.jlo + 1) * f.channels * f.width * f.height * (f.bitDepth / 8);
  }

  /** "Stack" of the entry dialog: the slices of the range as the slices of a z-stack, no projection — read from the original TIFF in the
   *  worker (doc.tiff.stack) or, for the processed volume, streamed band by band (doc.stack.*). Channels stay channels. */
  async function loadStack(desc, tiff, opt) {
    const fkey = figureKeyOf(desc);
    const ac = new AbortController();
    S.loadAbort = ac;
    beginBusy(tiff ? tr('load.openTiff') : tr('load.open'));
    let docId = null, token = null, session = null, ok = false;
    try {
      let args, command, sessionKey, provenance;
      const axis = String(desc.axis).toUpperCase();
      if (tiff) {
        const f = tiff.facts, { ia, ib, r } = tiffRangeOfFigure(desc, tiff, opt.a, opt.b);
        sessionKey = [fkey, 'tiff', tiff.entry.file, 'stack', opt.a + '-' + opt.b, Date.now().toString(36)].join('|');
        provenance = { source: 'figure', input: 'tiff', datasetId: desc.datasetId, datasetName: desc.datasetName, treeKey: desc.treeKey, timepoint: desc.timepoint,
          axis: desc.axis, level: f.level, method: 'stack', first: ia, last: ib, tiff: { file: tiff.entry.file, etag: tiff.index.size + '-' + tiff.index.mtime }, sessionKey };
        const zStep = f.vzT > 0 ? f.vzT : (f.plan.spacingUm > 0 ? f.plan.spacingUm : null);
        const calibration = f.pixelUm ? Object.assign({ pixelWidth: f.pixelUm.x, pixelHeight: f.pixelUm.y, unit: 'µm' }, zStep ? { pixelDepth: zStep } : {}) : { pixelWidth: 1, pixelHeight: 1, unit: 'pixel' };
        const name = ib > ia ? tr('proj.nameStack', { dataset: desc.datasetName, axis, a: ia, b: ib }) : tr('proj.nameSingle', { dataset: desc.datasetName, axis, a: ia });
        command = 'doc.tiff.stack';
        args = { url: tiff.index.url, index: tiff.index, z0: r.jlo, z1: r.jhi, frame: f.frame, channels: f.names.map((n, i) => ({ c: i, name: n, color: f.colors[i] })), name, calibration, provenance, sessionKey };
        const res = await call(command, args, [], { long: true });
        docId = res.info.docId;
        registerDoc(res.info, { clean: true, sessionKey, provenance });
      } else {
        const lvDesc = (desc.levels || []).find((l) => l.level === opt.level);
        if (!lvDesc) { endBusy(); S.loadAbort = null; return false; }
        const [lo, hi] = mapRange(opt.a, opt.b, opt.n0, lvDesc.indices.length);
        const depth = hi - lo;
        const channels = desc.channels || [];
        sessionKey = [fkey, lvDesc.level, 'stack', opt.a + '-' + opt.b, Date.now().toString(36)].join('|');
        provenance = { datasetId: desc.datasetId, datasetName: desc.datasetName, treeKey: desc.treeKey, timepoint: desc.timepoint,
          axis: desc.axis, level: lvDesc.level, method: 'stack', first: lvDesc.indices[lo], last: lvDesc.indices[hi - 1], sessionKey };
        const cal = { pixelWidth: lvDesc.voxelUm ? lvDesc.voxelUm[desc.uAxis] : 1, pixelHeight: lvDesc.voxelUm ? lvDesc.voxelUm[desc.vAxis] : 1, unit: 'µm' };
        if (lvDesc.voxelUm && lvDesc.voxelUm[desc.axis] > 0) cal.pixelDepth = lvDesc.voxelUm[desc.axis];
        const name = depth > 1 ? tr('proj.nameStack', { dataset: desc.datasetName, axis, a: lvDesc.indices[lo], b: lvDesc.indices[hi - 1] })
          : tr('proj.nameSingle', { dataset: desc.datasetName, axis, a: lvDesc.indices[lo] });
        session = await S.ctx.studio.source.open({ level: lvDesc.level, signal: ac.signal });
        const begin = await call('doc.stack.begin', { width: session.width, height: session.height, depth, channels: channels.map((c) => ({ name: c.name, color: c.color })), name, calibration: cal, provenance, sessionKey });
        token = begin.token;
        const bandRows = Math.max(1, session.bandRows);
        const zChunk = Math.max(1, session.zChunk || 1);
        const chIdx = channels.map((c) => c.index);
        const total = Math.ceil(session.height / bandRows) * depth;
        let done = 0;
        for (let y0 = 0; y0 < session.height; y0 += bandRows) {
          const y1 = Math.min(session.height, y0 + bandRows);
          for (let z0 = lo; z0 < hi; z0 += zChunk) {
            const z1 = Math.min(hi, z0 + zChunk);
            if (ac.signal.aborted) throw Object.assign(new Error('cancelled'), { name: 'AbortError' });
            session.assertFrame();
            const blk = await session.readBlock({ y0, y1, z0, z1, channels: chIdx, signal: ac.signal });
            const data = blk.data.map(transferable);
            await call('doc.stack.add', { token, y0, rows: blk.rows, z0: z0 - lo, depth: z1 - z0, data }, data.map((u) => u.buffer));
            done += z1 - z0;
            if (S.shell) S.shell.setProgress({ fraction: done / total, cancellable: true, label: tr('dlg.lib.progressZ', { pct: Math.round((100 * done) / total) }) });
          }
        }
        const fin = await call('doc.stack.finish', { token });
        token = null;
        docId = fin.info.docId;
        registerDoc(fin.info, { clean: true, sessionKey, provenance });
      }
      holdSessionLock(sessionKey);
      ok = true;
      await showDoc(docId);
      if (viewOf(docId)) viewOf(docId).fit();
      commitHook();
    } catch (err) {
      if (token) call('doc.stack.abort', { token }).catch(() => {});
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

  async function loadProjection(desc, opt) {
    const lvDesc = (desc.levels || []).find((l) => l.level === opt.level);
    if (!lvDesc) return false;
    const [lo, hi] = mapRange(opt.a, opt.b, opt.n0, lvDesc.indices.length);
    const depth = hi - lo;
    // ZProjector's own output depth for the 8-bit processed volume, the rule of the library route (doc.zproj.begin): one image type from both routes
    const outBits = outputBitDepth(opt.method, depth, 8);
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
      const begin = await call('doc.project.begin', { name, method: opt.method, width: session.width, height: session.height, depth, inputBitDepth: 8,
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
  const invert = () => runOp('invert', { fullRange: settingGet('conv.fullRange16') === true });
  const crop = () => runOp('crop', {}, { all: true });

  // ij.plugin.Duplicator keeps "Ignore selection" in a static field (staticIgnoreSelection) and marks every image it made with the property
  // UniqueName, which lets WindowManager.getUniqueName drop the "-1" of such a title ("cells-1" duplicates to "cells-2").
  const DUP = { ignoreSelection: false, made: new Set() };

  /**
   * Image > Duplicate… (Duplicator.run / showDialog / showHSDialog): "Title:" (the unique name of the image, WindowManager.getUniqueName),
   * "Ignore selection" (only with an area selection; forced when the selection lies outside the image) and, for a multichannel image,
   * "Channels (c):" "1-N" read as showHSDialog does (IJEdit.parseChannelRange). The copy has the selection's bounding box; the pixels of
   * the box outside a non-rectangular selection are copied too; the new image carries the selection (moved to 0, 0) unless the selection was ignored,
   * when it carries the original at its place.
   */
  async function duplicate() {
    const info = activeInfo();
    if (!info) return;
    const nCh = (info.channels || []).length;
    // Duplicator.run: a hyperstack (or a composite) asks showHSDialog, any other stack showDialog with "Duplicate stack" and "Range:"
    const dd = stackDims(info), nSl = info.nSlices || 1;
    const hs = nSl > 1 && (nCh > 1 || !!info.hyperstack || (dd.nZ > 1 && dd.nT > 1));
    const plainStack = nSl > 1 && !hs;
    const singleComposite = hs && nCh === nSl;     // "singleComposite = imp.isComposite() && nChannels==imp.getStackSize()": no "Duplicate hyperstack" box
    const roi0 = selOf(info.docId);
    const area = isAreaRoi(roi0);
    let outside = false;
    if (area && typeof IJRoi !== 'undefined') {
      const b = IJRoi.bounds(roi0);
      // "if (r.x>=imp.getWidth() || r.y>=imp.getHeight() || r.x+r.width<=0 || r.y+r.height<=0) { ignoreSelection = true; roiOutside = true; }"
      outside = b.x >= info.width || b.y >= info.height || b.x + b.w <= 0 || b.y + b.h <= 0;
    }
    const existing = shownDocs().map((id) => S.docs.get(id).name);
    const defaultTitle = typeof IJEdit !== 'undefined' ? IJEdit.uniqueName(info.name, existing, DUP.made.has(info.docId)) : info.name.replace(/(-\d+)?$/, '') + '-1';
    // Duplicator.showDialog (one channel): "Duplicate…" with "Ignore selection" when ANY selection is there, opened on the remembered value (in
    // 1.54p the `if (roiOutside) ignoreSelection = true` store is overwritten from staticIgnoreSelection before the dialog). A selection outside
    // the image is always ignored here, ticked or not: ImageJ's crop of it would be an empty 0×0 image. showHSDialog (several channels):
    // "Duplicate", "Channels (c):", no Ignore selection.
    const anySel = !!roi0;
    const fields = [{ type: 'string', id: 'title', labelKey: 'dlg.edit.dupTitle', value: defaultTitle }];
    if (nCh <= 1 && anySel) fields.push({ type: 'check', id: 'ignore', labelKey: 'dlg.edit.ignoreSelection', value: DUP.ignoreSelection });
    // showDialog (a stack): "Duplicate stack" (off unless the operator ticked it before; a macro says `duplicate`) and "Range:" "1-N";
    // showHSDialog: "Duplicate hyperstack" (not for a single composite) and "Channels (c):" / "Slices (z):" / "Frames (t):" for the dimensions longer than 1
    if (plainStack) {
      fields.push({ type: 'check', id: 'stack', labelKey: 'dlg.edit.dupStack', value: DUP.stack === true });
      fields.push({ type: 'string', id: 'range', labelKey: 'dlg.edit.dupRange', value: '1-' + nSl });
    }
    if (hs && !singleComposite) fields.push({ type: 'check', id: 'stack', labelKey: 'dlg.edit.dupHyperstack', value: DUP.stack === true });
    if (nCh > 1) fields.push({ type: 'string', id: 'channels', labelKey: 'dlg.edit.channelsRange', value: '1-' + nCh });
    if (hs && dd.nZ > 1) fields.push({ type: 'string', id: 'slices', labelKey: 'dlg.edit.slicesRange', value: '1-' + dd.nZ });
    if (hs && dd.nT > 1) fields.push({ type: 'string', id: 'frames', labelKey: 'dlg.edit.framesRange', value: '1-' + dd.nT });
    // ImageJ's range[0] throws on an empty "Channels (c):" text; here the dialog refuses it with a message
    const validate = nCh > 1 ? (vals) => (String(vals.channels === undefined || vals.channels === null ? '' : vals.channels).trim() === '' ? { channels: 'dlg.dupChannelsEmpty' } : null) : undefined;
    const spec = { title: hs ? tr('dlg.dupDialogHS') : tr('dlg.edit.dupDialog'), okLabel: tr('dlg.ok'), fields };
    if (validate) spec.validate = validate;
    const v = await dialog(spec);
    if (!v) return;
    const ignore = outside || (area && nCh <= 1 && !!v.ignore);
    if (anySel && nCh <= 1) DUP.ignoreSelection = !!v.ignore;
    let channels, range;
    const rangeOf = (text, n) => { const r = typeof IJEdit !== 'undefined' ? IJEdit.parseChannelRange(text, n) : { first: 1, last: n }; return [r.first - 1, r.last - 1]; };
    const here = positionOf(info.docId);
    if (plainStack) {
      // Duplicator.run: unticked = the slice on screen (run(imp)), ticked = "first-last" (run(imp, first, last)); "if (first<1) first=1; if (last>stackSize) last=stackSize;
      // if (first>last) {first=1; last=stackSize;}" is the range reader of showDialog
      DUP.stack = !!v.stack;
      const cur = here.t * dd.nZ + here.z;
      const r = v.stack ? rangeOf(v.range, nSl) : [cur, cur];
      range = dd.nT === 1 ? { z: r } : { t: r };
    } else if (hs) {
      // duplicateHyperstack: unticked = the plane on screen — every channel of a composite shown as one, else the channel on screen
      const all = singleComposite || !!v.stack;
      if (!singleComposite) DUP.stack = !!v.stack;
      if (all) {
        range = { c: nCh > 1 ? rangeOf(v.channels, nCh) : [0, 0], z: dd.nZ > 1 ? rangeOf(v.slices, dd.nZ) : [0, 0], t: dd.nT > 1 ? rangeOf(v.frames, dd.nT) : [0, 0] };
      } else {
        const dsm = S.dstate.get(info.docId);
        const composite = nCh > 1 && (!dsm || dsm.mode === 'composite');
        range = { c: composite ? [0, nCh - 1] : [here.c, here.c], z: [here.z, here.z], t: [here.t, here.t] };
      }
    } else if (nCh > 1 && typeof IJEdit !== 'undefined') {
      const r = IJEdit.parseChannelRange(v.channels, nCh);
      if (!(r.first === 1 && r.last === nCh)) { channels = []; for (let c = r.first - 1; c < r.last; c++) channels.push(c); }
    }
    const title = String(v.title || '').trim() || defaultTitle;
    await busy(tr('op.duplicate'), async () => {
      const roi = area && !ignore ? roi0 : null;
      const res = await call('doc.duplicate', Object.assign({ docId: info.docId, roi, channels, name: title }, range ? { range } : {}));
      registerDoc(res.info, { clean: false, provenance: S.sources.get(info.docId) || null, sessionKey: S.sessionKeys.get(info.docId) || null });
      DUP.made.add(res.info.docId);
      await showDoc(res.info.docId);
      if (viewOf(res.info.docId)) viewOf(res.info.docId).fit();
      // the selection the copy carries: "imp2.setRoi((Roi)roi.clone())" when ignored, else the cropped selection moved to (0, 0) unless it is a rectangle
      let roi2 = null;
      if (area && ignore && !outside) roi2 = roi0;
      else if (roi && roi0.type !== 'rect' && typeof IJRoi !== 'undefined') {
        const b = IJRoi.bounds(roi0);
        if (b.x >= 0 && b.y >= 0 && b.x + b.w <= info.width && b.y + b.h <= info.height) roi2 = IJRoi.translate(roi0, -b.x, -b.y);
        else { const m = IJRoi.mask(roi0, info.width, info.height); roi2 = m.w > 0 && m.h > 0 ? IJRoi.fromMask(m.data, m.w, m.h) : null; }
      }
      if (roi2) setSelection(res.info.docId, roi2, true);
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
    // a stack or an RGB image goes through the stack-aware conversion (package stk: StackConverter, RGB -> luminance); a single grey plane keeps the v1 operation
    const stk = (info.nSlices || 1) > 1 || info.rgb;
    if (stk && typeof IJOpRegistry !== 'undefined' && IJOpRegistry.get('stkConvert') && !S.failedPackages.has('stk')) {
      await runOp('stkConvert', { bitDepth: bits, scale: settingGet('conv.scale') !== false, weighted: settingGet('conv.weighted') === true }, { all: true, noRoi: true });
      return;
    }
    await runOp('convert', { bitDepth: bits, scale: settingGet('conv.scale') !== false }, { all: true, noRoi: true });
  }
  /** Image > Stacks > Z Project...: the stack of the active image (the stk package's command), else the figure's slab projection. */
  function stackProjectCommand(a) {
    const info = activeInfo();
    const hook = typeof IJStkCmds !== 'undefined' && IJStkCmds && typeof IJStkCmds.zProject === 'function' ? IJStkCmds : null;
    if (info && (info.nZ || 1) * (info.nT || 1) > 1 && hook && !S.failedPackages.has('stk')) return hook.zProject(apiFor('stk'));
    return a.zProject();
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
    // LutLoader.showLut: "ip.setColorModel(cm)" installs a fresh table: a table that was inverted (Invert LUT) is replaced, not inverted again
    const all = lutChannelsOf(info);
    for (const c of all) setChannelDisplay(info.docId, c, { lut: name, invert: false });
    if (all.length > 1) setDisplayModeExt(info.docId, 'color').catch((err) => console.error('[advanced-studio] set mode', err));
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

  // ij.plugin.Thresholder.convertStack: Convert to Mask / Make Binary / the Threshold window's Apply on a stack ask the "Convert Stack to Binary" dialog
  // (remembered between runs like the static fields of ImageJ). ops: stackToMask (in place, one undo step) / stackToMaskNew ("Create new stack": MASK_<title>).
  const THR_STACK = { method: 'Default', background: 'Default', calculate: false, list: false, create: false };
  async function convertStackToBinary(info, sopt) {
    const ch = activeChannel(info);
    const v = sopt && sopt.values ? sopt.values : await dialog({ title: tr('dlg.thr.stackTitle'), okLabel: tr('dlg.ok'), fields: [
      { type: 'choice', id: 'method', labelKey: 'dlg.thr.stackMethod', value: THR_STACK.method, options: IJThresholdMethods() },
      { type: 'choice', id: 'background', labelKey: 'dlg.thr.stackBackground', value: THR_STACK.background,
        options: [{ value: 'Default', labelKey: 'dlg.thr.bgDefault' }, { value: 'Dark', labelKey: 'dlg.thr.bgDark' }, { value: 'Light', labelKey: 'dlg.thr.bgLight' }] },
      { type: 'check', id: 'calculate', labelKey: 'dlg.thr.stackCalculate', value: THR_STACK.calculate },
      { type: 'check', id: 'only', labelKey: 'dlg.thr.stackOnly', value: false },
      { type: 'check', id: 'black', labelKey: 'dlg.thr.stackBlack', value: settingGet('thr.blackBackground') !== false },
      { type: 'check', id: 'list', labelKey: 'dlg.thr.stackList', value: THR_STACK.list },
      { type: 'check', id: 'create', labelKey: 'dlg.thr.stackCreate', value: THR_STACK.create }] });
    if (!v) return null;
    Object.assign(THR_STACK, { method: v.method, background: v.background, calculate: !!v.calculate, list: !!v.list, create: !!v.create });
    // "Prefs.blackBackground = gd.getNextBoolean()": the box is the preference of Process > Binary > Options too
    settingSet('thr', 'thr.blackBackground', !!v.black);
    // the range of the Threshold window = "imp.isThreshold()": applied to every slice as it is
    const w = S.threshold && S.threshold.docId === info.docId && S.threshold.channel === ch ? S.threshold : null;
    const params = { method: v.method, background: v.background, calculate: !!v.calculate && !v.only, only: !!v.only, black: !!v.black };
    if (w) params.threshold = { lower: w.lower, upper: w.upper };
    // "if (only) { useLocal = false; listThresholds = false; createStack = false; }"
    const create = !!v.create && !v.only;
    const run = await runExt(create ? 'stackToMaskNew' : 'stackToMask', params, { docId: info.docId, noRoi: true, channel: ch, labelKey: 'op.toMask' });
    if (run) {
      S.threshold = null;
      if (create && run.newDocIds && run.newDocIds.length && !v.black) maskLut(run.newDocIds);
      scheduleToolRefresh('threshold');
    }
    return run;
  }

  async function convertToMask(sopt) {
    const info = activeInfo();
    if (!info) return;
    // a stack of planes (z / t); the channels of a composite are not slices here, the image keeps becoming its mask
    if (isStackInfo(info) && !info.rgb) { await convertStackToBinary(info, sopt); return; }
    await busy(tr('op.toMask'), async () => {
      const ch = activeChannel(info);
      // Thresholder.run: "if (!imp.isThreshold()) autoThreshold(ip)": the range the Threshold window holds for this image and
      // channel when it holds one, else an automatic one (Default method; deviation: ImageJ's ISODATA2 also guesses the polarity).
      const w = S.threshold && S.threshold.docId === info.docId && S.threshold.channel === ch ? S.threshold : null;
      let lower, upper;
      if (w) { lower = w.lower; upper = w.upper; } else {
        const t = await call('doc.threshold', { docId: info.docId, channel: ch, method: 'Default', dark: S.thrDark !== false, roi: isAreaRoi(selOf(info.docId)) ? selOf(info.docId) : null });
        lower = t.lower; upper = t.upper;
      }
      const res = await call('doc.run', { docId: info.docId, op: 'toMask', params: { lower, upper }, roi: null, channel: ch });
      applyRunResult(info.docId, res);
      if (res.newDocIds && res.newDocIds.length) { await adoptNewDocs(res.newDocIds); maskLut(res.newDocIds); }
    });
  }
  /** Convert to Mask / Make Binary with "Black background" off: the mask keeps 255 = object and gets an INVERTING LUT
   *  (Thresholder: `if (!Prefs.blackBackground) ip.invertLut()`), so the objects are displayed black on white. */
  function maskLut(ids) {
    if (settingGet('thr.blackBackground') === false) for (const id of ids || []) setChannelDisplay(id, 0, { invert: true });
  }
  /** The Binary Options the commands of Process › Binary read (ImageJ keeps them in static fields / Prefs): iterations and count
   *  (Binary.iterations / count), Pad edges (Prefs.padEdges), Black background (Prefs.blackBackground, default TRUE as Fiji sets it).
   *  `foreground` per channel is Binary.run's rule: "fg = blackBackground ? 255 : 0; foreground = ip.isInvertedLut() ? 255 − fg : fg". */
  function binaryOptions(info) {
    // `static int iterations` of Binary.java: the run of the program = the package's session data (Binary Options writes it)
    const sessionIterations = () => { const d = S.extData && S.extData.thr; return d && Number.isInteger(d.iterations) && d.iterations >= 1 && d.iterations <= 100 ? d.iterations : 1; };
    const num = (k, lo, hi) => { const v = Math.floor(Number(settingGet(k))); return v >= lo && v <= hi ? v : lo; };
    const bb = settingGet('thr.blackBackground') !== false;
    return {
      iterations: sessionIterations(), count: num('thr.count', 1, 8), padEdges: settingGet('thr.padEdges') === true,
      foreground: (info.channels || []).map((_, c) => { const l = lutOf(info, c); const fg = bb ? 255 : 0; return l && l.invert ? 255 - fg : fg; })
    };
  }
  async function binary(op) {
    const info = activeInfo();
    if (!info) return null;
    return runOp('binary', Object.assign({ op }, binaryOptions(info)), { all: true });
  }

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
    const o = { threshold: thresholdFor(info, ch), limit: S.measurements.includes('limit'), invertY: S.measurements.includes('invertY') };
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
      out.Label = (src || info).name + stackLabelSuffix(src || info);
    }
    if (!info.rgb && (info.channels || []).length > 1) out.Ch = channelIdx + 1;   // an RGB image has no channels
    for (const [key, col] of COLUMNS) if (res[key] !== undefined) out[col] = res[key];
    // Analyzer.saveResults, STACK_POSITION: a displayed hyperstack adds Ch (more than one channel), Slice (more than one slice) and Frame
    // (more than one frame); any other image adds Slice = its current slice (1 on a single image)
    if (S.measurements.includes('stackPos')) {
      const p = positionOf(info.docId), d = stackDims(info);
      const aware = VP() ? VP().isDimensionAware(info) : (!!info.hyperstack || d.nC > 1);
      if (aware) {
        if (d.nC > 1) out.Ch = p.c + 1;
        if (d.nZ > 1) out.Slice = p.z + 1;
        if (d.nT > 1) out.Frame = p.t + 1;
      } else out.Slice = isStackInfo(info) ? p.t * d.nZ + p.z + 1 : 1;
    }
    return out;
  }
  /** Analyzer.getFileName on a stack: ':' + the short label of the current slice, else ':' + its number (1-based stack index). */
  function stackLabelSuffix(info) {
    if (!isStackInfo(info) || !S.docs.has(info.docId)) return '';
    const p = positionOf(info.docId), d = stackDims(info);
    const n = p.t * d.nC * d.nZ + p.z * d.nC + (info.rgb ? 0 : p.c) + 1;
    const label = VP() ? VP().shortSliceLabel(sliceLabelAt(info.docId, p, p.c)) : null;
    return ':' + (label ? label : String(n));
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
    const roi = selOf(info.docId);
    await busy(tr('op.measure'), async () => {
      appendResults(await measureRows(info, roi, activeChannel(info)));
      // Analyzer.run: "if ((measurements&ADD_TO_OVERLAY)!=0) addRoiToOverlay();"
      if (S.measurements.includes('addToOverlay')) anaAddToOverlay(info, roi);
    });
    openTool('results');
  }
  /**
   * Analyzer.addRoiToOverlay: the measured selection joins the overlay, named by its row ("roi.setName(""+rt.size())"), its name drawn
   * on a dark background ("overlay.setLabelColor(Color.white); overlay.drawBackgrounds(true)"). Overlay items are not undo steps.
   */
  function anaAddToOverlay(info, roi) {
    if (!roi || !S.docs.has(info.docId)) return;
    // Analyzer.addRoiToOverlay: "if (roi.getName()==null) roi.setName(""+rt.size());"
    const name = typeof roi.name === 'string' && roi.name !== '' ? roi.name : String(S.results.length);
    let b = null;
    try { b = IJRoi.bounds(roi); } catch (_) { b = null; }
    const items = [{ kind: 'roi', roi, name, stroke: null, tag: 'ana.measure' }];
    if (b) items.push({ kind: 'text', x: b.x + b.w / 2, y: b.y + b.h / 2 - 6, text: name, size: 12, color: '#ffffff', background: '#000000', align: 'center', tag: 'ana.measure' });
    annotationsApi.add(info.docId, items);
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
   * Analyze › Set Measurements (Analyzer.doSetDialog): the groups, then Limit to threshold, Display label, Invert Y coordinates,
   * Scientific notation, Add to overlay and NaN empty cells, "Redirect to:" (another image or channel the statistics are read from; the same
   * size as this image) and "Decimal places (0-9):" (3). Scientific notation and the decimals re-format the Results table at once.
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
    fields.push({ type: 'number', id: 'decimals', labelKey: 'dlg.ana.decimals', value: anaDecimals(), min: 0, max: 9, integer: true });
    const v = await dialog({ title: tr('cmd.analyzeSetMeasurements'), okLabel: tr('dlg.ok'), fields });
    if (!v) return;
    // Analyzer.setOptions: the table is re-formatted when the notation or the precision changed
    const before = anaPrecision() + '/' + S.measurements.includes('nanEmpty');
    S.measurements = Object.keys(MEASURE_GROUPS).filter((g) => v[g]);
    if (!S.measurements.length) S.measurements = ['area'];
    S.redirect = v.redirectOn && v.redirectDoc !== undefined && v.redirectDoc !== '' ? { docId: v.redirectDoc, channel: Number.isInteger(v.redirectChannel) ? v.redirectChannel : 0 } : null;
    // "int prec = (int)gd.getNextNumber(); if (prec<0) prec = 0; if (prec>9) prec = 9;"
    const prec = Number.isFinite(Number(v.decimals)) ? clamp(Math.trunc(Number(v.decimals)), 0, 9) : anaDecimals();
    settingSet('ana', 'ana.decimals', prec);
    saveMeasurements();
    if (before !== anaPrecision() + '/' + S.measurements.includes('nanEmpty')) scheduleToolRefresh('results');
    scheduleMetaPersist();
  }
  /**
   * Analyze › Histogram (ij.plugin.Histogram). An 8 / 16-bit image has 256 bins over its pixel range and no dialog; a 32-bit image asks for
   * "Bins:", "Use pixel value range" (or "X_min:" / "X_max:" and "Y_max:" "Auto"), as the dialog ImageJ shows for a 32-bit image and for Alt+Histogram
   * ("if (bitDepth==32 || IJ.altKeyDown() …) if (!showDialog(imp)) return;"). Typing a range unticks "Use pixel value range"
   * (Histogram.textValueChanged). The values are remembered for the next run (Histogram.static*).
   */
  async function histogram(hopt) {
    const info = activeInfo();
    if (!info) return;
    const ch = activeChannel(info);
    const roi = isAreaRoi(selOf(info.docId)) ? selOf(info.docId) : null;
    let bins = 256, min, max, yMax = 0;
    // Histogram.run: "if (bitDepth==32 || IJ.altKeyDown() …) showDialog" — a 16-bit image gets 256 bins over its pixel range and no dialog (the plan's
    // "16/32-bit" is wrong for 1.54p); there is no Alt key here
    if (info.bitDepth === 32) {
      const d = lutOf(info, ch) || {};
      // "if (imp.getID()!=imageID …) useImageMinAndMax = true": another image starts again from its own range (Bins and Y max stay)
      const prev = ANA.hist || null;
      const last = prev && prev.docId === info.docId ? prev : { bins: prev ? prev.bins : 256, useRange: true, yMax: prev ? prev.yMax : 'Auto' };
      const lo = Number.isFinite(d.min) ? d.min : 0, hi = Number.isFinite(d.max) ? d.max : (info.bitDepth === 16 ? 65535 : 1);
      const v = await dialog({ title: tr('cmd.analyzeHistogram'), okLabel: tr('dlg.ok'), fields: [
        { type: 'number', id: 'bins', labelKey: 'dlg.ana.histBins', value: last.bins, min: 2, max: 65536, integer: true },
        { type: 'check', id: 'useRange', labelKey: 'dlg.ana.histUseRange', value: last.useRange !== false },
        { type: 'message', id: 'or', labelKey: 'dlg.ana.histOr' },
        { type: 'number', id: 'xMin', labelKey: 'dlg.ana.histXMin', value: last.useRange === false && Number.isFinite(last.xMin) ? last.xMin : lo, step: 'any' },
        { type: 'number', id: 'xMax', labelKey: 'dlg.ana.histXMax', value: last.useRange === false && Number.isFinite(last.xMax) ? last.xMax : hi, step: 'any' },
        { type: 'string', id: 'yMax', labelKey: 'dlg.ana.histYMax', value: last.yMax === undefined ? 'Auto' : String(last.yMax) }],
      onChange: (values, set, changedId) => { if (changedId === 'xMin' || changedId === 'xMax') set({ useRange: false }); } });
      if (!v) return;
      bins = Math.max(2, Math.min(65536, Math.round(Number(v.bins))));
      ANA.hist = { docId: info.docId, bins, useRange: !!v.useRange, xMin: Number(v.xMin), xMax: Number(v.xMax), yMax: String(v.yMax) };
      if (!v.useRange) { min = Number(v.xMin); max = Number(v.xMax); }
      // "int iyMax = (int)Tools.parseDouble(yMax, 0.0);"
      const y = typeof IJAna !== 'undefined' ? IJAna.parseDouble(v.yMax) : Number(v.yMax);
      yMax = Number.isFinite(y) && y > 0 ? Math.trunc(y) : 0;
    }
    // Histogram.run: a stack asks "Include all N images?" (Yes = ij.process.StackStatistics over every slice, No = the current image, Cancel = nothing);
    // a macro answers with the word `stack` (hopt.stack = 'all' | 'current').
    let all = false;
    if (isStackInfo(info)) {
      const answer = hopt && (hopt.stack === 'all' || hopt.stack === 'current') ? hopt.stack
        : await ask({ title: tr('cmd.analyzeHistogram'), message: tr('dlg.includeAll', { n: info.nSlices }),
          options: [{ id: 'all', label: tr('dlg.yes'), primary: true }, { id: 'current', label: tr('dlg.no') }, { id: 'cancel', label: tr('dlg.cancel') }], dismissId: 'cancel' });
      if (answer !== 'all' && answer !== 'current') return;
      all = answer === 'all';
    }
    await busy(tr('op.histogram'), async () => {
      let hist;
      if (all) {
        // every plane of the channel, every channel of a multichannel image (ImageJ reads the whole stack); a worker without the package falls back to the current plane
        try { hist = await call('doc.stackHistogram', { docId: info.docId, roi, channel: (info.channels || []).length > 1 && !info.rgb ? 'all' : ch, bins, planes: 'all' }); }
        catch (err) { if (!err || err.code !== 'IJ_MODULE_MISSING') throw err; }
      }
      if (!hist) {
        const args = { docId: info.docId, roi, channel: ch, bins };
        if (min !== undefined) { args.min = min; args.max = max; }
        hist = await call('doc.histogram', args);
      }
      openHistogramWindow(info, ch, hist, { bins, yMax, roi });
    });
  }

  async function plotProfile() {
    const info = activeInfo();
    const roi = info && selOf(info.docId);
    if (!roi || !(roi.type === 'line' || roi.type === 'polyline' || roi.type === 'rect')) return;
    await busy(tr('op.profile'), async () => {
      const vertical = roi.type === 'rect' && !!anaSetting('ana.vertical', false);
      const res = await call('doc.profile', { docId: info.docId, line: roi, channel: activeChannel(info), vertical, interpolate: anaSetting('ana.interpolate', true) !== false });
      openProfileWindow(info, res, { rect: roi.type === 'rect', vertical });
    });
  }

  // ── Analyze › Analyze Particles (ij.plugin.filter.ParticleAnalyzer) ─────────────────────────────────────────────
  // ParticleAnalyzer.showStrings2: the order of the "Show:" list; each id is the lang key `dlg.ana.show<Id>`.
  const PARTICLE_SHOW = ['nothing', 'overlay', 'overlayMasks', 'outlines', 'bareOutlines', 'ellipses', 'masks', 'countMasks'];
  const PARTICLE_SHOW_KEY = { nothing: 'dlg.ana.showNothing', overlay: 'dlg.ana.showOverlay', overlayMasks: 'dlg.ana.showOverlayMasks', outlines: 'dlg.ana.showOutlines',
    bareOutlines: 'dlg.ana.showBareOutlines', ellipses: 'dlg.ana.showEllipses', masks: 'dlg.ana.showMasks', countMasks: 'dlg.ana.showCountMasks' };
  /** "private static int staticOptions = Prefs.getInt(OPTIONS,CLEAR_WORKSHEET);": the first run has only "Clear results" ticked. */
  function particleState() {
    const s = settingGet('ana.particles');
    return Object.assign({ minSize: 0, maxSize: null, minCirc: 0, maxCirc: 1, show: 'nothing', pixelUnits: false, display: false, exclude: false, clear: true,
      holes: false, summarize: false, overlay: false, manager: false, composite: false, record: false }, s && typeof s === 'object' && !Array.isArray(s) ? s : {});
  }
  // The mean columns of the Summary row (ParticleAnalyzer.addMeans), by measurement key, in ImageJ's order.
  const SUMMARY_MEAN_KEYS = ['mean', 'mode', 'perim', 'major', 'minor', 'angle', 'circularity', 'solidity', 'feret', 'feretX', 'feretY', 'feretAngle', 'minFeret', 'intDen', 'median', 'skewness', 'kurtosis'];
  const SUMMARY_HEAD = ['Slice', 'Count', 'Total Area', 'Average Size', '%Area'];
  /** A colour per particle for "Overlay Masks" (ImageJ takes the Glasbey look-up table, which this plugin does not ship): golden-angle hues. */
  function particleMaskColor(index) {
    const h6 = ((index * 137.508) % 360) / 60, s = 0.65, v = 0.95;
    const f = (n) => { const k = (n + h6) % 6; return v - v * s * Math.max(0, Math.min(k, 4 - k, 1)); };
    const hex = (x) => ('0' + Math.round(x * 255).toString(16)).slice(-2);
    return '#' + hex(f(5)) + hex(f(3)) + hex(f(1)) + '99';
  }

  /** The `Label` suffix and the Stack position columns of a row measured on plane `p` ({ z, t }, 0-based) of a stack (Analyzer.getFileName / saveResults). */
  function stackRowParts(info, p, ch) {
    const d = stackDims(info);
    const n = p.t * d.nC * d.nZ + p.z * d.nC + (info.rgb ? 0 : ch) + 1;
    const label = VP() ? VP().shortSliceLabel(sliceLabelAt(info.docId, { z: p.z, t: p.t }, ch)) : null;
    const cols = {};
    if (S.measurements.includes('stackPos')) {
      const aware = VP() ? VP().isDimensionAware(info) : (!!info.hyperstack || d.nC > 1);
      if (aware) {
        if (d.nC > 1) cols.Ch = ch + 1;
        if (d.nZ > 1) cols.Slice = p.z + 1;
        if (d.nT > 1) cols.Frame = p.t + 1;
      } else cols.Slice = p.t * d.nZ + p.z + 1;
    }
    return { suffix: ':' + (label ? label : String(n)), cols };
  }

  /** The Roi position (ImageJ's Roi.setPosition) of something found on plane at ({ z, t }): { position } for a stack, {} otherwise. */
  function positionFor(info, ch, at) {
    const vp = VP();
    const dsm = S.dstate.get(info.docId);
    const position = vp && at ? vp.roiPositionFor(info, { c: ch, z: at.z, t: at.t }, dsm ? dsm.mode : undefined) : null;
    return position ? { position } : {};
  }

  async function particles(popt) {
    const info = activeInfo();
    if (!info) return;
    const cal = info.calibration || {};
    const pw = cal.pixelWidth > 0 ? cal.pixelWidth : 1, ph = cal.pixelHeight > 0 ? cal.pixelHeight : 1;
    const unit = cal.unit || 'pixel';
    const scaled = pw !== 1 || ph !== 1 || !/^pixels?$/i.test(unit);
    const st = particleState();
    const A = typeof IJAna !== 'undefined' ? IJAna : null;
    const stored = { minSize: st.minSize, maxSize: st.maxSize === null || st.maxSize === undefined ? Infinity : st.maxSize };
    const fields = [{ type: 'string', id: 'size', label: tr('dlg.ana.partSize', { units: unit + '^2' }), value: A ? A.sizeText(stored.minSize, stored.maxSize, st.pixelUnits ? 1 : pw * ph) : '0-Infinity' }];
    if (scaled) fields.push({ type: 'check', id: 'pixelUnits', labelKey: 'dlg.ana.partPixelUnits', value: !!st.pixelUnits });
    fields.push({ type: 'string', id: 'circularity', labelKey: 'dlg.ana.partCirc', value: (A ? A.circText(st.minCirc, st.maxCirc) : '0.00-1.00') });
    fields.push({ type: 'choice', id: 'show', labelKey: 'dlg.ana.partShow', value: PARTICLE_SHOW.includes(st.show) ? st.show : 'nothing', options: PARTICLE_SHOW.map((id) => ({ value: id, labelKey: PARTICLE_SHOW_KEY[id] })) });
    for (const [id, key] of [['display', 'dlg.ana.partDisplay'], ['exclude', 'dlg.ana.partExclude'], ['clear', 'dlg.ana.partClear'], ['holes', 'dlg.ana.partHoles'], ['summarize', 'dlg.ana.partSummarize'],
      ['overlay', 'dlg.ana.partOverlay'], ['manager', 'dlg.ana.partManager'], ['composite', 'dlg.ana.partComposite'], ['record', 'dlg.ana.partRecord']]) {
      fields.push({ type: 'check', id, labelKey: key, value: !!st[id] });
    }
    const v = await dialog({ title: tr('cmd.analyzeParticles'), okLabel: tr('dlg.ok'), fields });
    if (!v) return;
    // ParticleAnalyzer.showDialog: lenient parsing, never a refusal
    const pixelUnits = scaled ? !!v.pixelUnits : !!st.pixelUnits;
    const lim = A ? A.particleSettings(v.size, v.circularity, pixelUnits ? 1 : pw * ph) : { minSize: 0, maxSize: Infinity, minCirc: 0, maxCirc: 1 };
    const opt = { display: !!v.display, exclude: !!v.exclude, clear: !!v.clear, holes: !!v.holes, summarize: !!v.summarize, overlay: !!v.overlay, manager: !!v.manager,
      composite: !!v.composite, record: !!v.record, show: PARTICLE_SHOW.includes(v.show) ? v.show : 'nothing' };
    settingSet('ana', 'ana.particles', Object.assign({ minSize: lim.minSize, maxSize: Number.isFinite(lim.maxSize) ? lim.maxSize : null, minCirc: lim.minCirc, maxCirc: lim.maxCirc, pixelUnits }, opt));
    // "if ((options&DISPLAY_SUMMARY)!=0) Analyzer.setMeasurements(Analyzer.getMeasurements()|AREA);"
    if (opt.summarize && !S.measurements.includes('area')) { S.measurements = S.measurements.concat('area'); saveMeasurements(); }
    // analyze(): "if (showOverlay && showChoice==NOTHING) showChoice = OVERLAY_OUTLINES;" — an Overlay choice builds the overlay, any other choice the image
    const overlayMode = opt.show === 'overlay' || opt.show === 'overlayMasks' || (opt.overlay && opt.show === 'nothing');
    const maskedOverlay = opt.show === 'overlayMasks';
    // ParticleAnalyzer.showDialog ends with IJ.setupDialog(imp, flags): a stack asks "Process all N images?" (Yes = every slice, one set of rows per slice;
    // No = the slice on screen; Cancel = nothing). A macro answers with the word `stack`.
    let planeList = null;       // null = the plane on screen, else [{ z, t }] of the slices analysed
    if (isStackInfo(info)) {
      const answer = await askStack(info, { stack: popt && popt.stack, macro: popt && popt.macro });
      if (answer === null) return;
      if (answer === 'all') {
        const d = stackDims(info);
        planeList = [];
        for (let t = 0; t < d.nT; t++) for (let z = 0; z < d.nZ; z++) planeList.push({ z, t });
      }
    }
    let summary = null;
    const summaries = [];
    // particleImage and the Invert Y option live in ij-proc-ana.js: when its worker copy failed to load they are skipped with a message
    const anaFailed = S.failedPackages.has('ana');
    await busy(tr('op.particles'), async () => {
      const roi = isAreaRoi(selOf(info.docId)) ? selOf(info.docId) : null;
      const ch = activeChannel(info);
      const analysis = { minSize: lim.minSize, minCirc: lim.minCirc, maxCirc: lim.maxCirc, excludeEdges: opt.exclude, includeHoles: opt.holes };
      if (Number.isFinite(lim.maxSize)) analysis.maxSize = lim.maxSize;
      // "if (showChoice==ELLIPSES) measurements |= ELLIPSE;"
      const groups = S.measurements.slice();
      if (opt.show === 'ellipses' && !groups.includes('ellipse')) groups.push('ellipse');
      const keys = measurementKeys(groups, false);
      const mo = measureOptions(info, ch);
      // ParticleAnalyzer.setThresholdLevels: the threshold range of the image, else a binary image (refused with ImageJ's message for any other)
      const pthr = thresholdFor(info, ch);
      const askParticles = (at) => call('doc.particles', Object.assign({ docId: info.docId, channel: ch, opts: Object.assign({ roi }, analysis), keys, redirect: mo.redirect,
        invertY: S.measurements.includes('invertY') && !anaFailed, composite: opt.composite && !opt.holes, threshold: pthr, requireBinary: !pthr }, at ? { pos: at } : {}));
      let res;
      const outlinePlane = [];     // the slice each outline belongs to (overlay items and Manager rows carry it)
      if (!planeList) res = await askParticles(null);
      else {
        res = { rows: [], outlines: [], summary: null };
        const parts = [];
        for (const at of planeList) {
          const part = await askParticles(at);
          parts.push({ at, part });
          for (const row of part.rows || []) res.rows.push(Object.assign({ __at: at }, row));
          for (const o of part.outlines || []) { res.outlines.push(o); outlinePlane.push(at); }
        }
        res.parts = parts;
      }
      // The table the rows go to (ParticleAnalyzer.java:566-576): "Display results" off while a Results window is open measures into a private table
      // — unless "Clear results" is ticked, which clears and closes the window and uses the system table. The system table keeps the rows even
      // when nothing shows them. `rowBase` = rt.size() before the first particle: what the labels, Count Masks levels and overlay names count from.
      const resultsOpen = S.wins.has('results');
      if (opt.clear && !opt.display && resultsOpen) { const rw = S.wins.get('results'); if (rw && rw.close) rw.close(); }
      const intoTable = opt.display || opt.clear || !resultsOpen;
      const rowBase = intoTable && !opt.clear ? S.results.length - (hasSummary() ? 4 : 0) : 0;
      // Analyzer.saveResults: the columns Set Measurements ticked, in ImageJ's column order; then "XStart" / "YStart" when the starts are recorded
      const wanted = new Set(keys);
      const rowsOut = (res.rows || []).map((p) => {
        const r = {};
        const sp = p.__at ? stackRowParts(info, p.__at, ch) : null;
        if (S.measurements.includes('labels')) r.Label = info.name + (sp ? sp.suffix : '');
        if ((info.channels || []).length > 1) r.Ch = ch + 1;
        for (const [key, col] of COLUMNS) if (wanted.has(key) && p[key] !== undefined) r[col] = p[key];
        if (sp) Object.assign(r, sp.cols);
        if (opt.record) { r.XStart = p.xStart; r.YStart = p.yStart; }
        return r;
      });
      // "if (resetCounter && slice==1 && rt.size()>0) Analyzer.resetCounter()": the table is emptied before the first particle, shown or not
      if (opt.clear) { S.results = []; ANA.sel.clear(); scheduleToolRefresh('results'); scheduleMetaPersist(); refreshUi(); }
      if (intoTable) appendResults(rowsOut);
      if ((res.rows || []).length === 0 && opt.display) setStatus(tr('dlg.ana.partNone'));
      // ParticleAnalyzer.updateSliceSummary: Count, Total Area, Average Size, %Area, then the mean of every measured column. ImageJ reads the table
      // through "float[] areas = rt.getColumn(AREA)" (columns are doubles, getColumn casts to float) and sums / averages those floats in a double
      // (FloatStatistics.mean): Math.fround of each cell, a double accumulator. %Area is the exact pixel ratio of the analysis: up to 1 ULP of a
      // float away from ImageJ's "sum*100.0/totalArea" computed over the float areas.
      if (opt.summarize && planeList) {
        // a stack: ParticleAnalyzer.updateSliceSummary runs once per slice, "Slice" = the label of the slice (else the title and its number)
        for (const { at, part } of res.parts) {
          if (!part.summary) continue;
          const rows = part.rows || [];
          let areaSum = 0;
          for (const p of rows) areaSum += Math.fround(p.area);
          const sp = stackRowParts(info, at, ch);
          const row = { Slice: sp.suffix.slice(1), Count: part.summary.count, 'Total Area': areaSum, 'Average Size': rows.length ? areaSum / rows.length : 0, '%Area': part.summary.percentArea };
          for (const [key, col] of COLUMNS) {
            if (!wanted.has(key) || SUMMARY_MEAN_KEYS.indexOf(key) < 0) continue;
            let sum = 0, n = 0;
            for (const p of rows) if (typeof p[key] === 'number') { sum += Math.fround(p[key]); n++; }
            row[col] = n ? sum / n : NaN;
          }
          summaries.push(row);
        }
      } else if (opt.summarize && res.summary) {
        const s = res.summary;
        let areaSum = 0;
        for (const p of res.rows || []) areaSum += Math.fround(p.area);
        const cnt = (res.rows || []).length;
        const row = { Slice: info.name, Count: s.count, 'Total Area': areaSum, 'Average Size': cnt ? areaSum / cnt : 0, '%Area': s.percentArea };
        for (const [key, col] of COLUMNS) {
          if (!wanted.has(key) || SUMMARY_MEAN_KEYS.indexOf(key) < 0) continue;
          let sum = 0, n = 0;
          for (const p of res.rows || []) if (typeof p[key] === 'number') { sum += Math.fround(p[key]); n++; }
          row[col] = n ? sum / n : NaN;
        }
        summary = row;
      }
      const outlines = res.outlines || [];
      // Add to Manager (ParticleAnalyzer.addToRoiManager: the manager is reset first when "Clear results" is ticked)
      if (opt.manager) {
        if (opt.clear) { S.roiList = []; S.roiSelected.clear(); }
        outlines.forEach((pts, i) => {
          const maskRoi = res.rows && res.rows[i] && res.rows[i].maskRoi;
          const roi2 = maskRoi || { type: 'polygon', points: pts, traced: true };
          S.roiList.push(Object.assign({ name: roiLabel(roi2, i + 1), docId: info.docId, roi: roi2 }, planeList ? positionFor(info, ch, outlinePlane[i]) : {}));
        });
        refreshRois(); scheduleToolRefresh('rois');
      }
      // the overlay (showResults(): the overlay is set only when there are particles); the particles are named by their row when the results are displayed
      if (overlayMode && outlines.length) {
        const items = [];
        outlines.forEach((pts, i) => {
          const maskRoi = res.rows && res.rows[i] && res.rows[i].maskRoi;
          const item = { kind: 'roi', roi: maskRoi || { type: 'polygon', points: pts, traced: true }, stroke: '#00ffff', tag: 'ana.particles' };
          if (planeList) Object.assign(item, positionFor(info, ch, outlinePlane[i]));
          // "if (showResults) roi2.setName(""+count)" with count = rt.size()
          if (opt.display) item.name = String(rowBase + i + 1);
          if (maskedOverlay) item.fill = particleMaskColor(i + 5);
          items.push(item);
          if (opt.display) {
            const b = outlineBounds(pts);
            items.push({ kind: 'text', x: b.x + b.w / 2, y: b.y + b.h / 2 - 4, text: String(rowBase + i + 1), size: 9, color: '#ffffff', align: 'center', tag: 'ana.particles' });
          }
        });
        annotationsApi.set(info.docId, items, { tag: 'ana.particles' });
      }
      // the "Show:" image
      if (!overlayMode && opt.show !== 'nothing' && anaFailed) setStatus(tr('warn.packageFailed', { pkg: 'ana' }));
      else if (!overlayMode && opt.show !== 'nothing') {
        const imageParams = { show: opt.show, opts: analysis, threshold: pthr, rowOffset: rowBase, composite: opt.composite && !opt.holes };
        if (planeList) { const d = stackDims(info); imageParams.planes = planeList.map((p) => p.t * d.nZ + p.z); }
        const run = await call('doc.run', { docId: info.docId, op: 'particleImage', params: imageParams, roi, channel: ch });
        applyRunResult(info.docId, run);
        if (run && run.newDocIds && run.newDocIds.length) {
          await adoptNewDocs(run.newDocIds, info.docId);
          // Outlines: "ip.drawString(s)" — the numbers are text items of the new image (the browser's font, not Java's)
          if (opt.show === 'outlines' && outlines.length) {
            const labels = outlines.map((pts, i) => {
              const b = outlineBounds(pts);
              return { kind: 'text', x: b.x + b.w / 2, y: b.y + b.h / 2 - 4, text: String(rowBase + i + 1), size: 9, color: '#ff0000', align: 'center', tag: 'ana.particles' };
            });
            annotationsApi.set(run.newDocIds[0], labels, { tag: 'ana.particles' });
          }
        }
      }
      scheduleMetaPersist();
    });
    if (opt.display) openTool('results');
    if (opt.manager) openTool('roiManager');
    // ImageJ shows a "Summary" table window, one row per run: never a modal that holds the busy state.
    if (summaries.length) {
      for (const row of summaries) S.summaryRows.push(row);
      openTool('summary');
      scheduleToolRefresh('summary');
    }
    if (summary) {
      S.summaryRows.push(summary);
      openTool('summary');
      scheduleToolRefresh('summary');
    }
  }
  /** The integer bounding rectangle of a traced outline (Roi.getBounds). */
  function outlineBounds(pts) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of pts) { if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0]; if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1]; }
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  /** RoiManager.getLabel(imp, roi, n) with n >= 0 (what ParticleAnalyzer's "Add to Manager" calls): "{xc = yc; yc=n;}" → "nnnn-yyyy", the particle number then the y centre. */
  function roiLabel(roi, n) {
    let b = { x: 0, y: 0, w: 0, h: 0 };
    if (typeof IJRoi !== 'undefined') { try { b = IJRoi.bounds(roi); } catch (_) { /* unnamed position */ } }
    const xc = Math.max(0, Math.trunc(b.y + Math.trunc(b.h / 2))), yc = Math.max(0, n);
    const digits = Math.max(4, String(xc).length, String(yc).length);
    return String(yc).padStart(digits, '0').slice(-digits) + '-' + String(xc).padStart(digits, '0').slice(-digits);
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
    S.roiList.push(Object.assign({ name: roiName(roi), docId: info.docId, roi }, currentRoiPosition(info)));
    refreshRois(); scheduleToolRefresh('rois'); scheduleMetaPersist();
  }
  /** RoiManager.select / restore on a stack: the plane an entry is tied to ({ c?, z?, t? } 0-based), null when it is tied to none. */
  function planeOfRoiPosition(info, p) {
    if (!p || !isStackInfo(info) && !(info && (info.nC | 0) > 1)) return null;
    const d = stackDims(info);
    const out = {};
    // `n` = the ImageJ stack index (Roi.getPosition): the channel, slice and frame it stands for
    if (p.n > 0 && p.n <= d.nC * d.nZ * d.nT) { const q = VP() ? VP().positionOfIndex(d, p.n) : null; if (q) { out.z = q.z; out.t = q.t; if (d.nC > 1) out.c = q.c; } }
    if (p.c > 0 && p.c <= d.nC) out.c = p.c - 1;
    if (p.z > 0 && p.z <= d.nZ) out.z = p.z - 1;
    if (p.t > 0 && p.t <= d.nT) out.t = p.t - 1;
    return Object.keys(out).length ? out : null;
  }
  /** RoiManager "Associate 'Show All' ROIs with slices" (its default): an entry added on a stack records the plane on screen. */
  function currentRoiPosition(info) {
    const vp = VP();
    const dsm = S.dstate.get(info.docId);
    const position = vp && (isStackInfo(info) || stackDims(info).nC > 1) ? vp.roiPositionFor(info, positionOf(info.docId), dsm ? dsm.mode : undefined) : null;
    return position ? { position } : {};
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
        const hh = await call('doc.histogram', { docId: info.docId, roi: null, channel: activeChannel(info), bins: 256, stats: false });
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
      // an RGB image is one 24-bit picture: its red / green / blue planes are not channels to toggle
      if (info.rgb) { body.appendChild(h('p', { text: tr('chan.rgb') })); return; }
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
    const T = { method: 'Default', dark: S.thrDark !== false, mode: 'red', lower: 0, upper: 255, overlayDoc: null, hist16: settingGet('thr.hist16') === true };
    const canvas = h('canvas', { class: 'ij-hist', width: 256, height: 80 });
    const readout = h('div', { class: 'ij-readout' });
    let hist = null, token = 0;
    // ThresholdAdjuster.java:221 (Prefs.get(SIXTEEN_BIT)), :941 (Prefs.set): the "16-bit histogram" box is remembered
    const hist16Row = check(tr('dlg.thr.hist16'), T.hist16, (on) => { T.hist16 = on; settingSet('thr', 'thr.hist16', on); auto(); });
    hist16Row.style.display = 'none';
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
        // "16-bit histogram" (ThresholdAdjuster.java:232, used :621 for 16-bit images): the full 65 536-bin histogram
        const lutC = lutOf(info, activeChannel(info));
        const r = await call('doc.threshold', { docId: info.docId, channel: activeChannel(info), method: T.method, dark: T.dark, roi,
          histogram16: T.hist16 && info.bitDepth === 16, invertedLut: !!(lutC && lutC.invert) });
        T.lower = r.lower; T.upper = r.upper; commit();
      } catch (err) { reportError(err); }
    }
    async function refresh(autoToo) {
      const info = activeInfo();
      if (!info) return;
      const my = ++token;
      try {
        const hh = await call('doc.histogram', { docId: info.docId, roi: null, channel: activeChannel(info), bins: 256, stats: false });
        if (my !== token) return;
        hist = hh;
        hist16Row.style.display = info.bitDepth === 16 ? '' : 'none'; // only a 16-bit image has a 16-bit histogram
      } catch (err) { console.error('[advanced-studio] histogram', err); }
      if (autoToo) await auto(); else commit();
    }
    async function apply() {
      const info = activeInfo();
      if (!info) return;
      // Thresholder: a stack asks "Convert Stack to Binary" (the window's range is applied to every slice)
      if (isStackInfo(info) && !info.rgb) { await convertStackToBinary(info); return; }
      const res = await runOp('toMask', { lower: T.lower, upper: T.upper }, { noRoi: true });
      if (res && res.newDocIds) maskLut(res.newDocIds);
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
      hist16Row,
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

  // ── Results ──────────────────────────────────────────────────────────────────────────────────────────────────────

  const RESULTS_CAP = 20000;
  const SELECTED_ROW_BG = 'var(--color-accent-subtle, var(--bg-active))';
  /** The row (tr) a click landed on, through the cells' parents. */
  function rowElOf(target) {
    let n = target;
    while (n && String(n.tagName).toUpperCase() !== 'TR') n = n.parentNode;
    return n && n.__row ? n : null;
  }
  /** The text of a row as TextPanel searches it ("Find…": the displayed line, row number first). */
  function rowLine(i) {
    const cols = resultColumns();
    return [String(i + 1)].concat(cols.map((c) => cellText(S.results[i], c))).join('\t');
  }

  /**
   * Window › Results: Analyze › Measure, Analyze Particles and the other measuring commands write here. A small menu bar (File / Edit / Results,
   * ij.text.TextWindow) works on the table; clicking a row selects it (Shift extends, Ctrl toggles), Edit › Clear deletes the selected rows
   * (with none selected it is Analyze › Clear Results), Copy honours Edit › Options › Input/Output.
   */
  function buildResults() {
    const table = h('table', { class: 'ij-table' });
    const note = h('p', { class: 'ij-banner' });
    note.hidden = true;
    const wrap = h('div', { class: 'ij-table-wrap' }, table);
    // shownCols starts as null so the first render always builds the table, even an empty one
    // (no rows = no columns = '' would otherwise skip the build and leave tbody null).
    let shown = 0, shownCols = null, tbody = null, firstRef = null, trs = [];
    function applySelection() {
      for (const tr of trs) {
        const on = ANA.sel.has(tr.__row);
        tr.style.background = on ? SELECTED_ROW_BG : '';
        if (tr.setAttribute) tr.setAttribute('aria-selected', on ? 'true' : 'false');
      }
    }
    // Only the rows added since the last refresh are built; a full rebuild happens when the
    // columns or the number format change or the table was cleared / replaced.
    function render() {
      const cols = resultColumns();
      const sig = cols.join('\u0001') + '|' + anaPrecision() + '|' + S.measurements.includes('nanEmpty');
      if (sig !== shownCols || S.results.length < shown || (firstRef !== null && S.results[0] !== firstRef)) {
        table.textContent = '';
        table.appendChild(h('thead', null, h('tr', null, [h('th', { text: ' ' })].concat(cols.map((c) => h('th', { text: columnHeader(c) }))))));
        tbody = h('tbody');
        tbody.addEventListener('click', onRowClick);
        table.appendChild(tbody);
        shown = 0; shownCols = sig; trs = [];
      }
      firstRef = S.results.length ? S.results[0] : null;
      const cap = Math.min(S.results.length, RESULTS_CAP);
      const frag = document.createDocumentFragment ? document.createDocumentFragment() : tbody;
      for (let i = shown; i < cap; i++) {
        const r = S.results[i];
        const tr = h('tr', null, [h('td', { text: String(i + 1) })].concat(cols.map((c) => h('td', { text: cellText(r, c) }))));
        tr.__row = r;
        trs.push(tr);
        frag.appendChild(tr);
      }
      if (frag !== tbody) tbody.appendChild(frag);
      shown = Math.max(shown, cap);
      for (const r of Array.from(ANA.sel)) if (S.results.indexOf(r) < 0) ANA.sel.delete(r);
      applySelection();
      note.hidden = S.results.length <= RESULTS_CAP;
      note.textContent = note.hidden ? '' : tr('res.capped', { shown: RESULTS_CAP, total: S.results.length });
      wrap.scrollTop = wrap.scrollHeight;
    }
    /** TextPanel.select / extendSelection, with Ctrl added for a row at a time. */
    function onRowClick(e) {
      const el = rowElOf(e && e.target);
      if (!el) return;
      const i = S.results.indexOf(el.__row);
      if (i < 0) return;
      if (e.shiftKey && ANA.origin >= 0 && ANA.origin < S.results.length) {
        const a = Math.min(ANA.origin, i), b = Math.max(ANA.origin, i);
        if (!(e.ctrlKey || e.metaKey)) ANA.sel.clear();
        for (let k = a; k <= b; k++) ANA.sel.add(S.results[k]);
      } else if (e.ctrlKey || e.metaKey) {
        if (ANA.sel.has(el.__row)) ANA.sel.delete(el.__row); else ANA.sel.add(el.__row);
        ANA.origin = i;
      } else {
        ANA.sel.clear(); ANA.sel.add(el.__row); ANA.origin = i;
      }
      applySelection();
    }
    const selectedIndices = () => { const out = []; S.results.forEach((r, i) => { if (ANA.sel.has(r)) out.push(i); }); return out; };
    const tableChanged = () => { scheduleToolRefresh('results'); scheduleMetaPersist(); refreshUi(); };

    // Edit › Select All / Copy / Cut / Clear (TextPanel.selectAll, copySelection, cutSelection, doClear / clearSelection)
    const selectAll = () => { for (const r of S.results) ANA.sel.add(r); ANA.origin = 0; applySelection(); };
    const copy = async () => {
      const sel = selectedIndices();
      await copyText(resultsText('\t', 'copy', sel.length ? sel : null));
    };
    const deleteRows = (indices) => {
      const drop = new Set(indices.map((i) => S.results[i]));
      S.results = S.results.filter((r) => !drop.has(r));
      for (const r of drop) ANA.sel.delete(r);
      ANA.origin = -1;
      tableChanged();
    };
    const cut = async () => { await copy(); const sel = selectedIndices(); deleteRows(sel.length ? sel : S.results.map((r, i) => i)); };
    const clear = () => { const sel = selectedIndices(); if (sel.length) deleteRows(sel); else clearResults(); };

    // TextPanel.find: "for (int i=first; i<iRowCount; i++) if (line.contains(s)) { setSelection(i, i); … }"; Find Next starts after the selection
    function findFrom(text, first) {
      for (let i = first; i < S.results.length; i++) {
        if (rowLine(i).indexOf(text) >= 0) {
          ANA.sel.clear(); ANA.sel.add(S.results[i]); ANA.origin = i;
          applySelection();
          if (trs[i] && typeof trs[i].scrollIntoView === 'function') trs[i].scrollIntoView({ block: 'nearest' });
          return true;
        }
      }
      setStatus(tr('res.notFound', { text }));
      return false;
    }
    async function find() {
      const v = await dialog({ title: tr('res.find'), okLabel: tr('dlg.ok'), fields: [{ type: 'string', id: 'find', labelKey: 'dlg.ana.resFind', value: ANA.find }] });
      if (!v || !v.find) return;
      ANA.find = String(v.find);
      findFrom(ANA.find, 0);
    }
    function findNext() {
      if (!ANA.find) return find();
      const sel = selectedIndices();
      const first = sel.length ? sel[sel.length - 1] + 1 : 0;
      if (first >= S.results.length) { setStatus(tr('res.notFound', { text: ANA.find })); return undefined; }
      return findFrom(ANA.find, first);
    }

    // File › Rename… / Duplicate… (TextPanel.rename / duplicate): the table becomes a window of its own
    const stringRows = () => S.results.map((r) => resultColumns().map((c) => cellText(r, c)));
    const titleOf = (name) => (name.endsWith('-1') || name.endsWith('-2') ? name.slice(0, -2) : name);
    function newTitle(old) { const t2 = titleOf(old), t3 = t2 + '-1'; return t3 === old ? t2 + '-2' : t3; }
    async function duplicate() {
      const v = await dialog({ title: tr('res.duplicate'), okLabel: tr('dlg.ok'), fields: [{ type: 'string', id: 'title', labelKey: 'dlg.ana.resTitle', value: newTitle('Results') }] });
      if (!v || !String(v.title).trim()) return;
      const name = String(v.title) === 'Results' ? 'Results2' : String(v.title);
      openTable(name, resultColumns().map(columnHeader), stringRows());
    }
    async function rename() {
      const v = await dialog({ title: tr('res.rename'), okLabel: tr('dlg.ok'), fields: [{ type: 'string', id: 'title', labelKey: 'dlg.ana.resTitle', value: newTitle('Results') }] });
      if (!v || !String(v.title).trim() || String(v.title) === 'Results') return;
      // "if (title.equals("Results")) { … Analyzer.setResultsTable(null); Analyzer.resetCounter(); }" — the system table is empty afterwards
      openTable(String(v.title), resultColumns().map(columnHeader), stringRows());
      S.results = []; ANA.sel.clear();
      tableChanged();
    }
    // Results › Sort… (TextPanel.sort: "Column:" the headers after Label; ResultsTable.sort(column))
    async function sortTable() {
      const cols = resultColumns().filter((c) => c !== 'Label');
      if (!cols.length) return;
      const v = await dialog({ title: tr('dlg.ana.sortTitle'), okLabel: tr('dlg.ok'), fields: [
        { type: 'choice', id: 'column', labelKey: 'dlg.ana.resColumn', value: cols[0], options: cols.map((c) => ({ value: c, label: columnHeader(c) })) }] });
      if (!v) return;
      const order = typeof IJAna !== 'undefined' ? IJAna.sortOrder(S.results, v.column, S.measurements.includes('nanEmpty')) : S.results.map((r, i) => i);
      const rows = S.results;
      S.results = order.map((i) => rows[i]);
      ANA.origin = -1;
      tableChanged();
    }
    // Results › Plot… (PlotContentsDialog "Plot From Table": X (--- = the row number), Y, colour, line width, symbol, label)
    const SYMBOLS = ['Line', 'Connected Circles', 'Filled', 'Bar', 'Separated Bars', 'Circle', 'Box', 'Triangle', '+', 'Diamond', 'X', 'Dot'];
    async function plotTable() {
      const cols = resultColumns().filter((c) => c !== 'Label' && S.results.some((r) => typeof r[c] === 'number'));
      if (!cols.length) return;
      const colOptions = cols.map((c) => ({ value: c, label: columnHeader(c) }));
      const v = await dialog({ title: tr('res.plot'), okLabel: tr('dlg.ok'), fields: [
        { type: 'choice', id: 'table', labelKey: 'dlg.ana.plotTable', value: 'Results', options: [{ value: 'Results', label: 'Results' }] },
        // PlotContentsDialog: "previousColumns = {1, 1, 0, 0}" (x: the first column of the list that starts with "---", y: the second of the list without it),
        // "previousColor="blue" … previousSymbol="Circle"", "previousLineWidth = 1"; OK keeps the colour, width and symbol for the next plot
        { type: 'choice', id: 'x', labelKey: 'dlg.ana.plotX', value: cols[0], options: [{ value: '---', label: '---' }].concat(colOptions) },
        { type: 'choice', id: 'y', labelKey: 'dlg.ana.plotY', value: cols[Math.min(1, cols.length - 1)], options: colOptions },
        { type: 'string', id: 'color', labelKey: 'dlg.ana.plotColor', value: ANA.plotPrev.color },
        { type: 'number', id: 'lineWidth', labelKey: 'dlg.ana.plotLineWidth', value: ANA.plotPrev.lineWidth, min: 0, step: 'any' },
        { type: 'choice', id: 'symbol', labelKey: 'dlg.ana.plotSymbol', value: ANA.plotPrev.symbol, options: SYMBOLS.map((s) => ({ value: s, label: s })) },
        { type: 'string', id: 'label', labelKey: 'dlg.ana.plotLabel', value: '' }] });
      if (!v) return;
      ANA.plotPrev = { color: String(v.color), lineWidth: Number.isFinite(Number(v.lineWidth)) ? Number(v.lineWidth) : 1, symbol: String(v.symbol) };
      const ys = S.results.map((r) => (typeof r[v.y] === 'number' ? r[v.y] : 0));
      const xs = v.x === '---' ? ys.map((y, i) => i) : S.results.map((r) => (typeof r[v.x] === 'number' ? r[v.x] : 0));
      const color = cssColorOf(v.color) || undefined;
      const kindOf = { Line: 'line', 'Connected Circles': 'line', Filled: 'line', Bar: 'bars', 'Separated Bars': 'bars' }[v.symbol] || 'points';
      const label = v.label || columnHeader(v.y);
      const series = [{ kind: kindOf, x: xs, y: ys, color, label }];
      if (v.symbol === 'Connected Circles') series.push({ kind: 'points', x: xs, y: ys, color, label });
      // "new Plot("Plot of "+title, "x", "y")" then "plot.setXYLabels(data[0]==null ? "x" : x heading, y heading)": the table is the "Results" window
      const xName = v.x === '---' ? 'x' : columnHeader(v.x);
      openPlot({ title: 'Plot of Results', xLabel: xName, yLabel: columnHeader(v.y), series,
        csv: { columns: [xName, columnHeader(v.y)], rows: xs.map((x, i) => [x, ys[i]]) } });
    }
    const menus = {
      file: [['res.saveAs', () => saveResults()], ['res.rename', rename], ['res.duplicate', duplicate]],
      edit: [['res.cut', cut], ['res.copy', copy], ['res.clearRows', clear], ['res.selectAll', selectAll], ['res.find', find], ['res.findNext', findNext]],
      results: [['cmd.analyzeClearResults', () => clearResults()], ['cmd.analyzeSummarize', () => summarize()], ['cmd.analyzeDistribution', () => distribution()],
        ['cmd.analyzeSetMeasurements', () => setMeasurements()], ['res.sort', sortTable], ['res.plot', plotTable], ['res.options', () => runCommandExt('optInputOutput')]]
    };
    const sub = h('div', { class: 'ij-row' });
    let openMenu = null;
    function showMenu(id) {
      sub.textContent = '';
      openMenu = openMenu === id ? null : id;
      if (!openMenu) return;
      for (const [key, fn] of menus[id]) sub.appendChild(btn(tr(key), () => { Promise.resolve(fn()).catch((err) => reportError(err)); }));
    }
    const bar = h('div', { class: 'ij-menubar-mini' },
      h('button', { type: 'button', text: tr('res.menuFile'), on: { click: () => showMenu('file') } }),
      h('button', { type: 'button', text: tr('res.menuEdit'), on: { click: () => showMenu('edit') } }),
      h('button', { type: 'button', text: tr('res.menuResults'), on: { click: () => showMenu('results') } }));
    const el = h('div', { class: 'ij-panel ij-results' }, bar, sub, h('p', { class: 'ij-note', text: tr('res.help') }), wrap, note,
      row(btn(tr('res.copy'), () => { copy().catch((err) => console.error(err)); }),
        btn(tr('res.save'), () => saveResults()), btn(tr('res.clear'), () => clearResults())));
    return { el, update(kind) { if (kind === 'results' || kind === 'doc') render(); } };
  }

  // ── Particle Summary (one row per Analyze Particles run, like ImageJ's Summary window)

  function buildSummary() {
    const table = h('table', { class: 'ij-table' });
    function render() {
      // Slice, Count, Total Area, Average Size, %Area, then the mean columns the runs added (ParticleAnalyzer.addMeans)
      const extra = [];
      for (const r of S.summaryRows) for (const k of Object.keys(r)) if (SUMMARY_HEAD.indexOf(k) < 0 && extra.indexOf(k) < 0) extra.push(k);
      const cols = SUMMARY_HEAD.concat(extra);
      table.textContent = '';
      table.appendChild(h('thead', null, h('tr', null, cols.map((c) => h('th', { text: c })))));
      const tb = h('tbody');
      for (const r of S.summaryRows) tb.appendChild(h('tr', null, cols.map((c) => h('td', { text: cellText(r, c) }))));
      table.appendChild(tb);
    }
    const el = h('div', { class: 'ij-panel ij-summary' }, h('div', { class: 'ij-table-wrap' }, table),
      row(btn(tr('res.clear'), () => { S.summaryRows = []; render(); })));
    return { el, update(kind) { if (kind === 'summary' || kind === 'doc' || kind === 'results') render(); } };
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

  // owner: P-io (wave 3) — ImageJ's ROI Manager (ij/plugin/frame/RoiManager.java:136-143): the list with its column of buttons
  // (Add [t], Update, Delete, Rename…, Measure, Deselect, Properties…, Flatten [F], More »), the Show All and Labels
  // checkboxes, and the "More »" popup (addPopupMenu, :177-200) in ImageJ's order. The list shown is the one of the active
  // image; it is S.roiList, the list api.roiManager serves. Entries carry name, docId, roi and the optional style
  // { stroke, width, fill } the views draw.
  let roiLabels = false;     // the Labels checkbox (RoiManager.labelsCheckbox: off at start)

  const cloneRoi = (roi) => IJRoi.translate(roi, 0, 0);
  /** String.compareToIgnoreCase: each UTF-16 unit upper-cased, then lower-cased, before it is compared. */
  function compareIgnoreCase(a, b) {
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) {
      let c1 = a.charCodeAt(i), c2 = b.charCodeAt(i);
      if (c1 === c2) continue;
      const u1 = String.fromCharCode(c1).toUpperCase(), u2 = String.fromCharCode(c2).toUpperCase();
      c1 = u1.length === 1 ? u1.charCodeAt(0) : c1; c2 = u2.length === 1 ? u2.charCodeAt(0) : c2;
      if (c1 === c2) continue;
      const l1 = String.fromCharCode(c1).toLowerCase(), l2 = String.fromCharCode(c2).toLowerCase();
      c1 = l1.length === 1 ? l1.charCodeAt(0) : c1; c2 = l2.length === 1 ? l2.charCodeAt(0) : c2;
      if (c1 !== c2) return c1 - c2;
    }
    return a.length - b.length;
  }
  /** Colors.colorToString / Colors.decode of the Properties dialog: a name, "#rrggbb" or "none"; a fill may carry an alpha
   * first ("#aarrggbb"). → css ('#rrggbb' | '#rrggbbaa') | null (none) | undefined (not a colour). */
  function parseStyleColor(text, fill) {
    const s = String(text == null ? '' : text).trim().toLowerCase();
    if (s === '' || s === 'none') return null;
    const rgb = parseColorValue(s);
    if (rgb) { const css = '#' + rgb.map((x) => x.toString(16).padStart(2, '0')).join(''); return fill ? css + 'ff' : css; }
    const m = /^#?([0-9a-f]{2})?([0-9a-f]{6})$/.exec(s);
    if (!m) return undefined;
    return fill ? '#' + m[2] + (m[1] || 'ff') : '#' + m[2];
  }
  function styleColorText(css, fill) {
    if (!css) return 'none';
    const rgb = css.slice(0, 7);
    const alpha = fill && css.length === 9 ? css.slice(7) : 'ff';
    if (alpha !== 'ff') return '#' + alpha + rgb.slice(1);        // ImageJ writes a translucent colour as "#aarrggbb"
    for (const [name, v] of Object.entries(COLOR_NAMES)) if (rgb === '#' + v.map((x) => x.toString(16).padStart(2, '0')).join('')) return name;
    return rgb;
  }
  /** Area to Line (ImageJ's RoiManager.multiPlot): the outline of an area selection as a closed segmented line. */
  function areaToLineRoi(roi) {
    const pts = IJRoiCodec.xyPolygon(roi).points;
    return pts.length ? { type: 'polyline', points: pts.concat([pts[0]]) } : roi;
  }

  function buildRoiManager() {
    const list = h('div', { class: 'ij-list is-multi', attrs: { role: 'listbox', 'aria-multiselectable': 'true' } });
    list.style.flex = '1 1 auto'; list.style.minWidth = '150px';
    let anchor = -1;
    const curList = () => { const i = activeInfo(); return i ? S.roiList.filter((r) => r.docId === i.docId) : []; };
    const selectedList = () => curList().filter((r) => S.roiSelected.has(r));
    /** RoiManager.getIndexes: the selected entries, or all of them when none is selected. */
    const targets = () => { const s = selectedList(); return s.length ? s : curList(); };
    const note = (key, params) => ask({ title: tr('roi.title'), message: tr(key, params), options: [{ id: 'ok', label: tr('dlg.ok'), primary: true }], dismissId: 'ok' });
    const needImage = async () => { const i = activeInfo(); if (!i) await note('roi.errNoImage'); return i; };

    const checkBox = (text, on, onChange) => {
      const input = h('input', { type: 'checkbox', checked: !!on, on: { change: (e) => onChange(e.target.checked) } });
      return { input, el: h('label', { class: 'ij-check' }, input, h('span', { text })) };
    };
    const showAllBox = checkBox(tr('roi.showAll'), S.showAll, (on) => { S.showAll = on; refreshRois(); });
    const labelsBox = checkBox(tr('roi.labels'), roiLabels, (on) => { roiLabels = on; refreshRois(); });

    /** RoiManager.restore: the entry becomes the selection of the active image (a selection entirely outside it is centred). */
    function restoreRoi(item) {
      const info = activeInfo();
      if (!info) return;
      let roi = cloneRoi(item.roi);
      if (roi.type !== 'point') {
        const b = IJRoi.bounds(roi);
        if (b.x >= info.width || b.y >= info.height || b.x + b.w < 0 || b.y + b.h < 0) roi = IJRoi.translate(roi, Math.trunc((info.width - b.w) / 2) - b.x, Math.trunc((info.height - b.h) / 2) - b.y);
      }
      // an entry tied to a plane takes the view there first (RoiManager.restore: "imp.setPosition(c, z, t)")
      const plane = planeOfRoiPosition(info, item.position);
      if (plane) movePlane(info.docId, plane, {});
      setSelection(info.docId, roi, true);
    }
    function selectionChanged() {
      render(); refreshRois();
      const s = selectedList();
      if (s.length === 1) restoreRoi(s[0]);
    }
    function pick(item, i, e) {
      const items = curList();
      if (e.shiftKey && anchor >= 0 && anchor < items.length) {
        if (!(e.ctrlKey || e.metaKey)) S.roiSelected.clear();
        for (let k = Math.min(anchor, i); k <= Math.max(anchor, i); k++) S.roiSelected.add(items[k]);
      } else if (e.ctrlKey || e.metaKey) {
        if (S.roiSelected.has(item)) S.roiSelected.delete(item); else S.roiSelected.add(item);
        anchor = i;
      } else { S.roiSelected.clear(); S.roiSelected.add(item); anchor = i; }
      selectionChanged();
    }
    function render() {
      list.textContent = '';
      curList().forEach((item, i) => {
        const on = S.roiSelected.has(item);
        const row = h('div', { class: 'ij-list-row' + (on ? ' is-selected' : ''), text: item.name, attrs: { role: 'option', tabindex: '0', 'aria-selected': String(on) },
          on: { click: (e) => pick(item, i, e), dblclick: () => rename(item, row) } });
        list.appendChild(row);
      });
      showAllBox.input.checked = !!S.showAll;
      labelsBox.input.checked = roiLabels;
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

    // ── the buttons
    async function doUpdate() {                        // RoiManager.update(true)
      const info = await needImage();
      if (!info) return;
      const roi = selOf(info.docId);
      if (!roi) { await note('roi.errNoSelection'); return; }
      const sel = selectedList();
      if (!sel.length && !S.showAll) { await note('roi.errOne'); return; }
      if (sel.length) sel[0].roi = Object.assign(cloneRoi(roi), { name: sel[0].name });
      roiListChanged(); render();
    }
    async function doDelete() {                        // RoiManager.delete(false)
      const items = curList();
      if (!items.length) { await note('roi.errEmpty'); return; }
      let t = selectedList();
      if (!t.length) {
        const a = await ask({ title: tr('roi.title'), message: tr('roi.deleteAll'),
          options: [{ id: 'yes', label: tr('roi.yes'), primary: true }, { id: 'no', label: tr('roi.no') }, { id: 'cancel', label: tr('dlg.cancel') }], dismissId: 'cancel' });
        if (a !== 'yes') return;
        t = items;
      }
      S.roiList = S.roiList.filter((r) => !t.includes(r));
      for (const r of t) S.roiSelected.delete(r);
      roiListChanged(); render();
    }
    async function doRename() {                        // RoiManager.rename(null): the first selected entry
      const sel = selectedList();
      if (!sel.length) { await note('roi.errOne'); return; }
      const item = sel[0];
      const v = await dialog({ title: tr('roi.title'), okLabel: tr('dlg.ok'), fields: [{ type: 'string', id: 'name', labelKey: 'dlg.io.renameAs', value: item.name }],
        validate: (x) => (String(x.name || '').trim() ? null : { name: 'dlg.io.nameEmpty' }) });
      if (!v || String(v.name).trim() === item.name) return;
      item.name = String(v.name).trim();
      roiListChanged(); render();
    }
    async function doMeasure() {
      const info = await needImage();
      if (!info) return;
      const t = targets();
      if (!t.length) return;
      await busy(tr('op.measure'), async () => {
        const rows = [];
        for (const r of t) for (const row of await measureRows(info, r.roi, activeChannel(info))) rows.push(row);
        appendResults(rows);
      });
      if (t.length > 1) setSelection(info.docId, null, true);   // "if (indexes.length>1) imp.deleteRoi()"
      openTool('results');
    }
    function doDeselect() { S.roiSelected.clear(); anchor = -1; render(); refreshRois(); }
    async function doProperties() {                    // RoiManager.setProperties → RoiProperties (name, stroke colour, width, fill colour)
      const t = targets();
      if (!t.length) return;
      const items = curList();
      const first = t[0];
      const isLineOnly = t.every((r) => r.roi.type === 'line' || r.roi.type === 'polyline' || r.roi.type === 'angle');
      const fields = [];
      if (t.length === 1) fields.push({ type: 'string', id: 'name', labelKey: 'dlg.io.rpName', value: first.name });
      else fields.push({ type: 'message', id: 'range', value: tr('dlg.io.rpRange', { range: (items.indexOf(t[0]) + 1) + '-' + (items.indexOf(t[t.length - 1]) + 1) }) });
      const stroke0 = first.stroke || (!first.fill ? cssColorOf(settingGet('colors.selection')) : null);
      const w0 = first.width > 0 ? first.width : 0;
      fields.push({ type: 'string', id: 'stroke', labelKey: 'dlg.io.rpStroke', value: styleColorText(stroke0, false) });
      fields.push({ type: 'number', id: 'width', labelKey: 'dlg.io.rpWidth', value: w0, min: 0, step: 1, decimals: Number.isInteger(w0) ? 0 : 1 });
      if (!isLineOnly) fields.push({ type: 'string', id: 'fill', labelKey: 'dlg.io.rpFill', value: styleColorText(t.length === 1 ? first.fill : null, true) });
      const v = await dialog({ title: tr('dlg.io.rpTitle'), okLabel: tr('dlg.ok'), fields,
        validate: (x) => {
          const bad = {};
          if (parseStyleColor(x.stroke, false) === undefined) bad.stroke = 'dlg.io.badColor';
          if (x.fill !== undefined && parseStyleColor(x.fill, true) === undefined) bad.fill = 'dlg.io.badColor';
          return Object.keys(bad).length ? bad : null;
        } });
      if (!v) return;
      if (t.length === items.length && t.length > 1) {   // "Apply changes to all N selections?"
        const a = await ask({ title: tr('roi.title'), message: tr('roi.applyAll', { n: t.length }),
          options: [{ id: 'ok', label: tr('dlg.ok'), primary: true }, { id: 'cancel', label: tr('dlg.cancel') }], dismissId: 'cancel' });
        if (a !== 'ok') return;
      }
      const stroke = parseStyleColor(v.stroke, false);
      const fill = v.fill !== undefined ? parseStyleColor(v.fill, true) : undefined;
      const width = Number(v.width);
      for (const item of t) {
        if (stroke) item.stroke = stroke;
        if (width > 0) item.width = width; else delete item.width;
        if (fill !== undefined) { if (fill) item.fill = fill; else delete item.fill; }
      }
      if (t.length === 1 && v.name !== undefined && String(v.name).trim()) t[0].name = String(v.name).trim();
      roiListChanged(); render();
    }

    // ── the More » popup
    async function drawOrFill(mode) {                  // RoiManager.drawOrFill: the foreground colour; a line is drawn, never filled
      const info = await needImage();
      if (!info) return;
      const t = targets();
      if (!t.length) return;
      setSelection(info.docId, null, true);             // imp.deleteRoi()
      const ch = activeChannel(info);
      // RoiManager.java:1481-1482 "if (mode==FILL&&(type==Roi.POLYLINE||type==Roi.FREELINE||type==Roi.ANGLE)) mode = DRAW;" changes the
      // loop's own variable: once a line is met every later entry is drawn too. (ImageJ also takes ONE snapshot / undo step for the whole
      // run, :1473-1474 "ip.snapshot(); Undo.setup(Undo.FILTER, imp)"; here each entry is a step of its own — the extension API has no
      // single-undo batch.)
      let m = mode;
      for (const item of t) {
        if (m === 'fill' && (item.roi.type === 'polyline' || item.roi.type === 'angle')) m = 'draw';
        const value = fillValue(info, ch, true);
        // the draw op takes the outline as its `shape` parameter: the engine hands a pixel op no selection of its own here (the
        // selection was just deleted)
        const r = m === 'fill'
          ? await runExt('fill', { value }, { docId: info.docId, channel: ch, roi: item.roi, labelKey: 'op.fill' })
          : await runExt('draw', { value, lineWidth: item.width > 1 ? Math.round(item.width) : 1, shape: item.roi }, { docId: info.docId, channel: ch, roi: item.roi, labelKey: 'op.roiDraw' });
        if (!r) break;
      }
      if (S.showAll) { S.showAll = false; refreshRois(); render(); }   // "if (showAllCheckbox.getState()) runCommand("show none")"
    }
    async function combineOp(op) {                     // RoiManager.combine / and / xor: the selected entries (all when none), a selection of the image
      const info = await needImage();
      if (!info) return;
      const t = targets();
      if (t.length < 2) { await note(t.length === 0 ? 'roi.errEmpty' : 'roi.errMoreThanOne'); return; }
      const res = await compute('roiSetOp', { op, rois: t.map((r) => r.roi) }, { docId: info.docId, roi: null, channel: 0, labelKey: 'op.roiSetOp' });
      if (!res) return;
      setSelection(info.docId, res.roi || null, true);
    }
    async function doSplit() {                         // RoiManager.split: every outline of the composite selection becomes an entry
      const info = await needImage();
      if (!info) return;
      const sel = selOf(info.docId);
      if (!sel || sel.type !== 'mask') { await note('roi.errComposite'); return; }
      const res = await compute('roiSetOp', { op: 'split', rois: [sel] }, { docId: info.docId, roi: null, channel: 0, labelKey: 'op.roiSetOp' });
      if (!res || !res.rois) return;
      for (const roi of res.rois) S.roiList.push({ name: roiName(roi), docId: info.docId, roi });
      roiListChanged(); render();
    }
    async function doMultiPlot() {                     // RoiManager.multiPlot: one profile per entry in one plot
      const info = await needImage();
      if (!info) return;
      const t = targets();
      if (!t.length) return;
      const cal = info.calibration || {};
      const xinc = cal.pixelWidth || 1;
      const unit = !cal.unit || cal.unit === 'px' ? 'pixels' : cal.unit;
      await busy(tr('op.profile'), async () => {
        const named = ['#0000ff', '#00ff00', '#ff00ff', '#ff0000', '#00ffff', '#ffff00'];   // blue green magenta red cyan yellow
        const inc = 150.0 / t.length;
        const series = [];
        for (let i = 0; i < t.length; i++) {
          let roi = t[i].roi;
          if (isAreaRoi(roi) && roi.type !== 'rect') roi = areaToLineRoi(roi);
          const res = await profileExt(info.docId, roi, activeChannel(info));
          const y = Array.from(res.values);
          const g = Math.trunc(i * inc).toString(16).padStart(2, '0');
          series.push({ kind: 'line', x: y.map((_, j) => j * xinc), y, color: t.length > named.length ? '#' + g + g + g : named[i], label: t[i].name });
        }
        openPlot({ title: tr('roi.profilesTitle'), xLabel: tr('roi.distance', { unit }), yLabel: tr('roi.value'), series });
      });
      if (t.length > 1) setSelection(info.docId, null, true);   // IJ.run("Select None")
    }
    function doSort() {                                // RoiManager.sort: Tools.rank(labels), String.compareToIgnoreCase, stable
      if (!S.roiList.length) return;
      S.roiList = S.roiList.slice().sort((a, b) => compareIgnoreCase(a.name, b.name));
      S.roiSelected.clear();
      roiListChanged(); render();
    }
    async function doOpen() {                          // RoiManager.open: .roi files and RoiSet .zip archives, added to the list
      const files = await pickFileExt({ accept: '.roi,.zip', multiple: true });
      if (!files) return;
      const info = await needImage();
      if (!info) return;
      await busy(tr('op.open'), async () => {
        for (const f of files) {
          const bytes = new Uint8Array(await f.arrayBuffer());
          const name = String(f.name || '');
          const kind = IJFileKinds.kindOf(name, bytes);
          if (kind === 'zip') { for (const d of await IJRoiCodec.decodeSet(bytes)) S.roiList.push(roiEntryFromFile(info.docId, d)); }
          else if (kind === 'roi') S.roiList.push(roiEntryFromFile(info.docId, IJRoiCodec.decodeEntry(bytes, { fileName: name })));
          else throw IJFileKinds.error('IJ_IO_UNKNOWN_FORMAT');
        }
        roiListChanged(); render();
      });
    }
    async function doSave() {                          // RoiManager.save: one entry → .roi, several (or none selected) → a RoiSet .zip
      const t = targets();
      if (!curList().length) { await note('roi.errListEmpty'); return; }
      const style = (r) => ({ roi: r.roi, name: r.name, stroke: r.stroke, fill: r.fill, width: r.width, position: r.position });
      try {
        if (t.length > 1) await saveFile('RoiSet.zip', 'application/zip', '.zip', 'ZIP', async () => new Blob([IJRoiCodec.encodeSet(t.map(style))], { type: 'application/zip' }));
        else await saveFile(safeName(t[0].name, '.roi'), 'application/octet-stream', '.roi', 'ROI', async () => new Blob([IJRoiCodec.encode(t[0].roi, style(t[0]))], { type: 'application/octet-stream' }));
      } catch (err) { await reportError(err); }
    }
    const MORE = [
      ['roi.open', doOpen], ['roi.save', doSave], ['roi.fill', () => drawOrFill('fill')], ['roi.draw', () => drawOrFill('draw')],
      ['roi.and', () => combineOp('and')], ['roi.or', () => combineOp('or')], ['roi.xor', () => combineOp('xor')], ['roi.split', doSplit],
      ['roi.multiMeasure', () => multiMeasure(targets())], ['roi.multiPlot', doMultiPlot], ['roi.sort', doSort]
    ];
    const popup = h('div', { class: 'ij-menu-panel', hidden: true, attrs: { role: 'menu' } },
      MORE.map(([key, fn]) => h('button', { type: 'button', class: 'ij-menu-item', attrs: { role: 'menuitem' }, text: tr(key), on: { click: () => { popup.hidden = true; fn(); } } })));
    const more = btn(tr('roi.more'), () => { popup.hidden = !popup.hidden; }, 'ij-btn-more');
    const flatten = h('button', { type: 'button', class: 'ij-btn', text: tr('roi.flatten'), disabled: true });   // Image > Overlay > Flatten is not part of this view

    const column = h('div', { class: 'ij-btn-col' },
      btn(tr('roi.addT'), () => addToManager()), btn(tr('roi.update'), doUpdate), btn(tr('roi.delete'), doDelete), btn(tr('roi.rename'), doRename),
      btn(tr('roi.measure'), doMeasure), btn(tr('roi.deselect'), doDeselect), btn(tr('roi.properties'), doProperties), flatten, more, popup, showAllBox.el, labelsBox.el);
    const el = h('div', { class: 'ij-panel ij-roimanager' }, row(list, column));
    render();
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

  /**
   * ij.gui.HistogramPlot: the histogram window. The bar height is scaled to the modal count, "if ((newMaxCount>(maxCount2 * 2)) && (maxCount2 != 0))
   * newMaxCount = (int)(maxCount2 * 1.5);" — a modal bin more than twice the second one is cut off — or to "Y_max"; "Log" adds the logarithmic plot
   * ("drawLogPlot: y = HIST_HEIGHT*Math.log(histogram[i])/max", gray) behind the linear one; "List" opens the values, "Copy" puts them on the clipboard.
   */
  function openHistogramWindow(info, ch, hist, o) {
    if (!S.shell || typeof IJPlot === 'undefined') return null;
    const opt = o || {};
    const counts = Array.from(hist.counts);
    const st = hist.stats || null;
    const binW = hist.binWidth > 0 ? hist.binWidth : 1;
    const xs = counts.map((c, i) => hist.min + i * binW);
    let mode = 0, second = 0;
    counts.forEach((c, i) => { if (c > counts[mode]) mode = i; });
    counts.forEach((c, i) => { if (i !== mode && c > second) second = c; });
    let top = counts.length ? counts[mode] : 0;
    if (top > second * 2 && second !== 0) top = Math.trunc(second * 1.5);
    if (opt.yMax > 0) top = opt.yMax;
    if (top === 0) top = 1;
    const cal = info.calibration || {};
    // HistogramWindow.java:260: "digits = cal.calibrated()||stats.binSize!=1.0?decimalPlaces:0" (this plugin has no density calibration)
    const digits = binW !== 1 ? anaDecimals() : 0;
    const fmt = (v) => (typeof IJAna !== 'undefined' ? IJAna.d2s(v, digits) : num(v, digits));
    // the window's own numbers: HistogramPlot.d2s (whole number: no decimals, else 3 significant digits within 8)
    const hn = (v) => (typeof IJAna !== 'undefined' ? IJAna.histNumber(v) : num(v, 3));
    const text = [];
    if (st) {
      // "String modeCount = " (" + stats.maxCount + ")"; … if (mcount>1) modeCount=modeCount+"*"; if (modeCount.length()>12) modeCount = "";"
      let modeCount = ' (' + st.maxCount + ')';
      let atMax = 0;
      for (let i = 0; i < counts.length && atMax <= 1; i++) if (counts[i] === st.maxCount) atMax++;
      if (atMax > 1) modeCount += '*';
      if (modeCount.length > 12) modeCount = '';
      text.push(tr('hist.statCount', { v: String(st.n) }), tr('hist.statMean', { v: hn(st.mean) }), tr('hist.statStdDev', { v: hn(st.stdDev) }),
        tr('hist.statMode', { v: hn(st.dmode), n: modeCount }), tr('hist.statMin', { v: hn(st.min) }), tr('hist.statMax', { v: hn(st.max) }));
    }
    // "showBins = binWidth!=1.0": the bin lines are drawn only then
    if (Math.abs(binW) !== 1) text.push(tr('hist.statBins', { v: hn(counts.length) }), tr('hist.statBinWidth', { v: hn(Math.abs(binW)) }));
    const name = String(info.name || '').replace(/\.[A-Za-z0-9]{1,4}$/, '');
    const title = tr('hist.title', { name });
    const canvas = h('canvas', { class: 'ij-plot', width: 360, height: 220 });
    const wrap = h('div', { class: 'ij-plot-wrap' }, canvas);
    let logOn = false, observer = null, drawn = false;
    const clipped = counts.map((c) => Math.min(c, top));
    const logged = counts.map((c) => (c === 0 || top <= 1 ? 0 : Math.min(top, top * Math.log(c) / Math.log(top))));
    const specNow = () => ({ title, xLabel: tr('hist.value'), yLabel: tr('hist.count'), yRange: [0, top],
      series: (logOn ? [{ kind: 'bars', x: xs, y: logged, color: '#808080', label: tr('hist.logLabel') }] : []).concat([{ kind: 'bars', x: xs, y: clipped, color: '#000000', label: tr('hist.count') }]) });
    const redraw = () => {
      const dpr = typeof window !== 'undefined' && window.devicePixelRatio ? Math.max(1, Math.min(3, window.devicePixelRatio)) : 1;
      const w = Math.max(160, wrap.clientWidth || 360), hh = Math.max(120, wrap.clientHeight || 220);
      canvas.width = Math.round(w * dpr); canvas.height = Math.round(hh * dpr);
      canvas.style.width = w + 'px'; canvas.style.height = hh + 'px';
      try { IJPlot.draw(canvas, specNow(), Object.assign(plotTheme(canvas), { dpr, lut: () => null })); drawn = true; } catch (err) { console.error('[advanced-studio] plot', err); }
    };
    // HistogramWindow.getResultsTable: "index" (only when the bin width is not 1), "value" | "bin start", "count" — ImageJ's own English column names
    const binned = binW !== 1;
    const listHead = (binned ? ['index'] : []).concat(binned ? 'bin start' : 'value', 'count');
    const rows = () => counts.map((c, i) => (binned ? [String(i)] : []).concat(fmt(xs[i]), String(c)));
    // copyToClipboard: "d2s(value, digits)+"\t"+histogram[i]+"\n"" — no heading, every line ends with a newline
    const listText = () => counts.map((c, i) => fmt(xs[i]) + '\t' + c + '\n').join('');
    const csvText = () => tableText(listHead, counts.map((c, i) => (binned ? [i] : []).concat(num(xs[i], 6), c)), ',');
    const buttons = row(
      btn(tr('hist.list'), () => openTable(title, listHead, rows())),
      btn(tr('res.copy'), () => copyText(listText())),
      btn(tr('hist.log'), () => { logOn = !logOn; redraw(); }),
      btn(tr('plot.saveCsv'), async () => { try { await saveFile(safeName(title, '.csv'), 'text/csv', '.csv', 'CSV', async () => new Blob([csvText()], { type: 'text/csv' })); } catch (err) { await reportError(err); } }),
      btn(tr('plot.savePng'), async () => {
        try {
          await saveFile(safeName(title, '.png'), 'image/png', '.png', 'PNG', async () => new Promise((resolve, reject) =>
            canvas.toBlob((b) => (b ? resolve(b) : reject(Object.assign(new Error('png'), { code: 'IJ_PNG_FAILED' }))), 'image/png')));
        } catch (err) { await reportError(err); }
      }));
    const content = h('div', { class: 'ij-panel ij-plotwin' }, wrap, h('pre', { class: 'ij-info-pre', text: text.join('\n') }), buttons);
    const win = S.shell.windows.floating({ id: 'plot-' + (++S.openCounter), title, content, onClose: () => { if (observer) { try { observer.disconnect(); } catch (_) { /* gone */ } } syncWindowMenu(); } });
    syncWindowMenu();
    if (typeof ResizeObserver !== 'undefined') { observer = new ResizeObserver(() => { if (drawn) redraw(); }); observer.observe(wrap); }
    requestAnimationFrame(redraw);
    return win;
  }

  /**
   * ProfilePlot.getPlot: "Distance (unit)" against the value, titled "Plot of <title>"; Edit › Options › Plots "Fixed y-axis scale" sets the y range
   * ("plot.setLimits(a[0],a[1],fixedMin,fixedMax)").
   */
  function openProfileWindow(info, res, o) {
    const opt = o || {};
    const values = Array.from(res.values || []);
    const cal = info.calibration || {};
    const unit = cal.unit || 'px';
    const step = res.stepUm || 1;
    const xs = values.map((v, i) => i * step);
    const dist = tr('plot.distance') + ' (' + unit + ')';
    const name = String(info.name || '').replace(/\.[A-Za-z0-9]{1,4}$/, '');
    const spec = { title: tr('plot.profileTitle', { name }), xLabel: dist, yLabel: tr('plot.value'),
      series: [{ kind: 'line', x: xs, y: values, label: tr('plot.value') }],
      csv: { columns: [dist, tr('plot.value')], rows: values.map((v, i) => [num(xs[i], 5), v]) } };
    if (anaSetting('ana.fixedScale', false) === true) {
      let lo = Number(anaSetting('ana.ymin', 0)), hi = Number(anaSetting('ana.ymax', 0));
      if (lo > hi) { const t = lo; lo = hi; hi = t; }
      if (lo !== 0 || hi !== 0) spec.yRange = [lo, hi];
    }
    if (opt.rect) spec.text = tr(opt.vertical ? 'plot.rowAverage' : 'plot.columnAverage');
    openPlot(spec);
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
      // ImageJ's type: 24 for an RGB image (its three colour planes are not channels), the storage depth otherwise
      tr('info.depth', { bits: typeof info.bitDepthIJ === 'number' ? info.bitDepthIJ : info.bitDepth }),
      tr('info.channels', { n: info.rgb ? 1 : (info.channels || []).length }),
      tr('info.pixel', { w: num(cal.pixelWidth || 1, 5), h: num(cal.pixelHeight || 1, 5), unit: cal.unit || 'px' })];
    // a stack: its dimensions, the voxel depth and frame interval, the plane on screen and its label (ImageJ's ImageInfo)
    if (isStackInfo(info)) {
      const d = stackDims(info), p = positionOf(info.docId), label = sliceLabelAt(info.docId, p, p.c);
      lines.push(tr('info.stack', { n: (info.rgb ? 1 : d.nC) * d.nZ * d.nT, c: info.rgb ? 1 : d.nC, z: d.nZ, t: d.nT }));
      if (d.nZ > 1 && cal.pixelDepth > 0) lines.push(tr('info.voxelDepth', { d: num(cal.pixelDepth, 5), unit: cal.unit || 'px' }));
      if (d.nT > 1 && cal.frameInterval > 0) lines.push(tr('info.frameInterval', { v: num(cal.frameInterval, 5), unit: cal.timeUnit || 'sec' }));
      lines.push(tr('info.position', { c: p.c + 1, nc: info.rgb ? 1 : d.nC, z: p.z + 1, nz: d.nZ, t: p.t + 1, nt: d.nT }));
      if (label) lines.push(tr('info.sliceLabel', { label }));
    }
    (info.channels || []).forEach((c, i) => { if (info.rgb) return; const d = lutOf(info, i) || {}; lines.push(tr('info.channel', { n: i + 1, name: c.name || '', min: num(d.min), max: num(d.max), lut: typeof d.lut === 'string' ? d.lut : (c.color || '') })); });
    if (src) {
      lines.push('', tr('info.source', { dataset: src.datasetName || src.datasetId, level: src.level, axis: String(src.axis).toUpperCase(), a: src.first, b: src.last, method: tr('proj.' + src.method) }));
      if (src.timepoint !== null && src.timepoint !== undefined) lines.push(tr('info.timepoint', { t: src.timepoint }));
    }
    lines.push('', tr('info.lossless'), tr('info.undo', { budget: mb(S.budgetBytes) }));
    openStaticWindow('info', tr('cmd.imageInfo'), h('div', { class: 'ij-panel' }, h('pre', { class: 'ij-info-pre', text: lines.join('\n') })));
  }

  const ABOUT_DEVIATIONS = ['about.dev.autoLocalPhansalkar', 'about.dev.autoLi16', 'about.dev.autoStack', 'about.dev.skeleton', 'about.dev.coloc', 'about.dev.selection',
    'about.dev.traced', 'about.dev.plot', 'about.dev.particles', 'about.dev.directionality', 'about.dev.invertLut', 'about.dev.log'];
  function showAbout() {
    const para = (k) => h('p', { text: tr(k) });
    const families = ['about.famDisplay', 'about.famSelect', 'about.famBackground', 'about.famFilters', 'about.famBinary', 'about.famMulti', 'about.famGeometry', 'about.famMeasure', 'about.famColoc',
      'about.famThreshold', 'about.famEnhance', 'about.famFft', 'about.famSelOps', 'about.famEdit', 'about.famFiji', 'about.famFiles']
      .map((k) => h('li', { text: tr(k) }));
    // every deviation that stays (ORCHESTRATOR-DECISIONS), then the Fiji tools' own list (about.fijiDeviations)
    const limits = ABOUT_DEVIATIONS.map((k) => h('li', { text: tr(k) }));
    limits.push(h('li', { text: tr('about.fijiDeviations') }));
    openStaticWindow('about', tr('cmd.helpAbout'), h('div', { class: 'ij-panel ij-about' }, [
      para('about.intro'), para('about.source'), para('about.depth'),
      h('h4', { text: tr('about.familiesTitle') }), h('ul', null, families),
      h('h4', { text: tr('about.missingTitle') }), para('about.missing'),
      para('about.deviations'), para('about.storage'), para('about.tables'),
      h('h4', { text: tr('about.thisTitle') }), para('about.resultsWindow'), para('about.pixelSource'),
      h('h4', { text: tr('about.limitsTitle') }), h('ul', { class: 'ij-about-limits' }, limits)
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
      if (info) list.push({ id: 'winImg' + id, menu: ['Window'], label: info.name + ' ' + imageSizeString(info.width * info.height * (info.channels || []).length * bytesPerPixel(info.bitDepth)), order: 60 + k / 1000, separatorBefore: k === 0,
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
  function onCommand(c, ev) {
    if (!c || typeof c.run !== 'function') return undefined;
    if (c.pkg && S.failedPackages.has(c.pkg)) return undefined;
    if (!c.enabled(snapshot())) return undefined;
    // ImageJ's Executer remembers what ran (except Undo and Close) so Repeat Command can run it again
    // (a command another command started, REPEAT.run set, is not the one the operator chose: Executer's previousCommand is the menu command)
    if (c.repeatable !== false && !c.dynamic && !REPEAT.nested) S.lastCommand = c.id;
    // the dialogs of this run: pre-filled from the last run when the command is repeated, remembered for the next repeat
    REPEAT.nested = false;
    const replaying = REPEAT.next && REPEAT.next.id === c.id;
    const outer = REPEAT.run;
    const run = { id: c.id, list: [], offered: [], k: 0, replay: replaying ? REPEAT.next.list : null, replayOffered: replaying ? REPEAT.next.offered : null, done: false };
    REPEAT.next = null;
    REPEAT.run = run;
    // run(api, { alt, shift, source }): the keys held at the menu click / shortcut (IJ.altKeyDown() and IJ.shiftKeyDown() of the command)
    const mods = { alt: !!(ev && ev.alt), shift: !!(ev && ev.shift), source: ev && typeof ev.source === 'string' ? ev.source : 'menu' };
    const start = () => c.run(c.ext ? apiFor(c.pkg) : API, mods);
    let chain;
    if (c.gesture) {
      // a command that needs the user activation of the click (the clipboard write of Copy to System): run() starts in this very task,
      // BEFORE the floating paste is committed (an await first would lose the gesture)
      let first;
      try { first = Promise.resolve(start()); } catch (err) { first = Promise.reject(err); }
      chain = first.then((v) => flushPending().then(() => v), (err) => flushPending().then(() => { throw err; }));
    } else {
      chain = Promise.resolve()
        .then(() => flushPending())       // a floating paste is committed before anything else runs
        .then(start);
    }
    return chain
      .catch((err) => reportError(err))
      .then(() => {
        // dialogs opened later outside a command (Results menus, histogram window, ROI Manager) belong to no run
        run.done = true;
        if (REPEAT.run === run) REPEAT.run = outer && !outer.done ? outer : null;
        // a dialog the operator cancelled leaves the remembered values as they were (ImageJ's statics change on OK only)
        if (!run.list.some(Boolean) || c.repeatable === false || c.dynamic) return;
        const mem = REPEAT.memory.get(c.id) || [];
        const off = REPEAT.offered.get(c.id) || [];
        run.list.forEach((v, i) => { if (v) { mem[i] = v; off[i] = run.offered[i]; } });
        REPEAT.memory.set(c.id, mem);
        REPEAT.offered.set(c.id, off);
      });
  }

  function refreshUi() { if (S.shell) S.shell.refreshMenus(); }

  function readPixel(x, y, docId) {
    const info = docId !== undefined && docId !== null ? S.docs.get(docId) : activeInfo();
    if (!info) return Promise.resolve(null);
    const pos = posArg(info.docId);
    return call('doc.pixel', pos ? { docId: info.docId, x, y, pos } : { docId: info.docId, x, y }).then((r) => r.values);
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
    openTiff, saveTiff, savePng, saveJpeg, saveResults, revert, recover: recoverDialog, closeImage: () => closeImage(), simpleView, closeStudio,
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
    return Object.assign({}, info, { mode: d.mode, visible: d.visible.slice(), channels: info.channels.map((c, i) => {
      const s = d.channels[i];
      return s ? Object.assign({}, c, { display: Object.assign({}, c.display, { min: s.min, max: s.max, lut: s.lut, invert: !!s.invert }) }) : c;
    }) });
  }

  function stateForApi() {
    const info = activeInfo();
    return {
      doc: liveInfo(info), docs: shownDocs().map((id) => liveInfo(S.docs.get(id))), roi: info ? selOf(info.docId) : null, busy: S.busy,
      activeChannel: info ? activeChannel(info) : 0, threshold: S.threshold, measurements: S.measurements.slice(), lineWidth: S.lineWidth,
      roiList: S.roiList.map((r) => ({ name: r.name, docId: r.docId, roi: r.roi })), resultsCount: S.results.length,
      pos: info ? positionOf(info.docId) : null, dims: info ? dimsExt(info.docId) : null
    };
  }

  function docOf(o) {
    const id = o && o.docId !== undefined ? o.docId : S.activeId;
    const info = id !== null && id !== undefined ? S.docs.get(id) : null;
    return info || null;
  }

  async function compute(op, params, o) {
    const opt = o || {};
    if (opt.docless === true) {
      // an op that declares `docless` (IJOpRegistry spec): no image needed, run() gets view = null
      if (S.busy) return null;
      return busy(opt.labelKey ? tr(opt.labelKey) : tr('op.' + op), () => call('doc.compute', { docId: null, op, params: params || {}, roi: null, channel: null }));
    }
    const info = docOf(opt);
    if (!info) return null;
    const args = { docId: info.docId, op, params: params || {}, roi: opt.roi !== undefined ? opt.roi : selOf(info.docId),
      channel: opt.channel !== undefined ? opt.channel : activeChannel(info) };
    if (Array.isArray(opt.docIds) && opt.docIds.length) args.docIds = opt.docIds;
    if (opt.pos) args.pos = opt.pos;
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
    const args = { docId: info.docId, op, params: params || {}, roi: opt.roi !== undefined ? opt.roi : selOf(info.docId),
      channel: opt.channel !== undefined ? opt.channel : activeChannel(info) };
    if (opt.pos) args.pos = opt.pos;
    if (opt.planes !== undefined) args.planes = opt.planes;
    return call('doc.estimate', args);
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
    S.results = (o && o.replace ? [] : S.results).concat(rows.map((r) => Object.assign({}, r)));
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

  // ── stacks: api.position / setPosition / dims / askStack / label / setLabel / animation (API.md §7) ──
  function stackDocId(o) {
    const id = o && o.docId !== undefined && o.docId !== null ? o.docId : S.activeId;
    if (id === null || id === undefined || !S.docs.has(id)) throw extError('no such image');
    return id;
  }
  function positionExt(docId) {
    const id = stackDocId({ docId });
    return positionOf(id);
  }
  /** Moves the view (and the engine's current plane) to { c, z, t } (0-based, clamped); not an undo step. Resolves with the engine's info. */
  async function setPositionExt(pos, o) {
    const id = stackDocId(o);
    if (!pos || typeof pos !== 'object') throw extError('setPosition: { c, z, t }');
    for (const k of ['c', 'z', 't']) if (pos[k] !== undefined && !Number.isFinite(pos[k])) throw extError('setPosition: ' + k);
    await movePlane(id, pos, {});
    await flushPosition(id);
    return S.docs.get(id);
  }
  function dimsExt(docId) {
    const id = stackDocId({ docId });
    const info = S.docs.get(id);
    const d = stackDims(info);
    return { width: info.width, height: info.height, nC: info.rgb ? 1 : d.nC, nZ: d.nZ, nT: d.nT, nSlices: (info.rgb ? 1 : d.nC) * d.nZ * d.nT,
      bitDepth: typeof info.bitDepthIJ === 'number' ? info.bitDepthIJ : info.bitDepth, rgb: !!info.rgb, hyperstack: !!info.hyperstack };
  }
  function labelExt(docId) {
    const id = stackDocId({ docId });
    return sliceLabelAt(id, planeOf(id), S.activeCh.get(id) || 0);
  }
  /** Slice label `n` (ImageJ's 1-based stack index) of an image: an undo step of its own (doc.setLabel). */
  async function setLabelExt(n, label, o) {
    const id = stackDocId(o);
    if (!Number.isInteger(n) || n < 1) throw extError('setLabel: n');
    const res = await call('doc.setLabel', { docId: id, n, label: label === undefined ? null : label });
    applyRunResult(id, res);
    S.labels.delete(id);
    await loadLabels(id);
    if (S.shell) S.shell.updateInfo(viewInfo(id));
    scheduleMetaPersist();
    refreshUi();
    emit('doc', { docId: id, kind: 'size' });
    return res ? res.info : null;
  }
  const animationApi = Object.freeze({
    start: (o) => startAnimation(stackDocId(o)),
    stop: (o) => stopAnimation(stackDocId(o)),
    toggle: (o) => toggleAnimation(stackDocId(o)),
    running: (o) => animationRunning(stackDocId(o)),
    /** { dim, first, last, fps, loop, backAndForth, n } of the image's Animation Options */
    options: (o) => animOptionsOf(stackDocId(o)),
    setOptions: (opts, o) => setAnimationOptions(stackDocId(o), opts)
  });

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
    // an RGB image has one display range: the three colour planes move together (ColorProcessor.setMinAndMax)
    const range = {};
    if (p.min !== undefined) range.min = p.min;
    if (p.max !== undefined) range.max = p.max;
    const targets = info.rgb && Object.keys(range).length ? [0, 1, 2].filter((i) => d.channels[i]) : [channel];
    for (const c of targets) Object.assign(d.channels[c], c === channel ? p : range);
    pushDisplay(docId);
    if (docId === S.activeId) scheduleToolRefresh('display');
    emit('doc', { docId, kind: 'display' });
    for (const c of targets) await call('doc.setDisplay', Object.assign({ docId, channel: c }, c === channel ? p : range));
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
    if (key === 'appearance.useNames') refreshRois();
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
    // the plane of a stack the item belongs to ({ c, z, t } 1-based, 0 = any, or { n } of a plain stack): drawn only there
    if (raw.position !== undefined && raw.position !== null) {
      const p = raw.position;
      if (typeof p !== 'object' || ['c', 'z', 't', 'n'].some((k) => p[k] !== undefined && !(Number.isInteger(p[k]) && p[k] >= 0))) throw extError('annotation position');
      out.position = { c: p.c | 0, z: p.z | 0, t: p.t | 0 };
      if (p.n > 0) out.position.n = p.n;
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
  function runCommandExt(id, o) {
    const c = COMMANDS.find((x) => x.id === id);
    if (!c) throw extError('runCommand: ' + String(id));
    // the command runs normally; only Repeat Command brings the dialogs back with the values of the last run
    REPEAT.next = REPEAT.run && REPEAT.run.id === REPEAT_CALLER ? { id, list: REPEAT.memory.get(id) || null, offered: REPEAT.offered.get(id) || null } : null;
    REPEAT.nested = !!REPEAT.run;
    const p = onCommand(c, { source: 'api', alt: !!(o && o.alt), shift: !!(o && o.shift) });
    REPEAT.next = null;
    REPEAT.nested = false;
    return Promise.resolve(p);
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
    const out = await busy(label, () => call(cmd, args || {}, opt.transfer, { long: opt.long === true || spec.long === true }));
    // a worker command that committed an undo step on an open image (E.commitPlanes) answers { docId, changed }: the page re-reads that image's info (undo depth)
    if (out && typeof out === 'object' && out.changed && out.docId !== undefined && S.docs.has(out.docId)) { await refreshInfo(out.docId); refreshUi(); }
    return out;
  }

  const placementOf = (placement) => (placement ? { placement, anchor: S.activeId !== null ? S.activeId : undefined } : undefined);
  /** A document the worker created (E.createDoc): view, tab, menu entry and session wiring. */
  async function adoptExt(info, o) {
    const opt = o || {};
    if (!info || info.docId === undefined || info.docId === null) throw extError('adopt: info');
    const fresh = await call('doc.info', { docId: info.docId });
    if (!S.docs.has(fresh.docId)) {
      registerDoc(fresh, { clean: false, provenance: opt.provenance || null, sessionKey: opt.sessionKey || (fresh.provenance && fresh.provenance.sessionKey) || null });
      const lockKey = opt.sessionKey || (fresh.provenance && fresh.provenance.sessionKey);
      if (lockKey) holdSessionLock(lockKey);          // a second tab's Recover must not restore a session that is being edited here
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
    // A stack image (API.md §3): a channel holds `planes` (nZ * nT arrays, pi = t * nZ + z) instead of one `data`
    const own = (a) => { const d = a.byteOffset === 0 && a.byteLength === a.buffer.byteLength ? a : a.slice(); transfer.push(d.buffer); return d; };
    const channels = image.channels.map((c) => {
      const stacked = !!(c && Array.isArray(c.planes));
      if (!c || (stacked ? !c.planes.length || !c.planes.every((p) => ArrayBuffer.isView(p)) : !ArrayBuffer.isView(c.data))) throw extError('addDoc: channel data');
      const ch = stacked ? { planes: c.planes.map(own), name: c.name, color: c.color } : { data: own(c.data), name: c.name, color: c.color };
      if (c.display) ch.display = c.display;
      return ch;
    });
    const img = { name: image.name, width: image.width, height: image.height, bitDepth: image.bitDepth, calibration: image.calibration, channels };
    for (const k of ['nZ', 'nT', 'hyperstack', 'rgb', 'labels', 'mode', 'visible']) if (image[k] !== undefined) img[k] = image[k];
    const res = await call('doc.import', { image: img, provenance: opt.provenance, sessionKey: opt.sessionKey, hidden: !!opt.hidden }, transfer);
    registerDoc(res.info, { clean: false, provenance: opt.provenance || null, sessionKey: opt.sessionKey || null });
    if (opt.sessionKey) holdSessionLock(opt.sessionKey);
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

  /** api.setDisplayMode: composite / color / gray (ImageJ's CompositeImage modes) of one image; the engine keeps it with the document. */
  async function setDisplayModeExt(docId, mode) {
    needDoc(docId);
    const m = mode === 'grayscale' ? 'gray' : mode;
    if (m !== 'composite' && m !== 'color' && m !== 'gray') throw extError('setDisplayMode: mode');
    const d = S.dstate.get(docId);
    if (!d) throw extError('setDisplayMode: image');
    if (d.mode === m) return;
    d.mode = m;
    pushDisplay(docId);
    if (docId === S.activeId) scheduleToolRefresh('display');
    emit('doc', { docId, kind: 'display' });
    await call('doc.setDisplay', { docId, mode: m });
    scheduleMetaPersist();
  }

  /** api.dropBlob: the page will not use this blob any more (a cancelled paste). A blob a committed step already uses stays. */
  async function dropBlobExt(ref) {
    const r = ref && typeof ref === 'object' ? ref.blobRef : ref;
    if (typeof r !== 'string' || !r) throw extError('dropBlob: a blobRef');
    const res = await call('engine.dropBlob', { blobRef: r });
    return !!(res && res.dropped);
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
    // ByteProcessor.setMinAndMax installs a LUT stretched over the display range, and getBestIndex searches that one (IJOv.burnValue).
    if (info.bitDepth === 8 && typeof IJOv !== 'undefined') return IJOv.burnValue(rgb, 8, table, isDefaultTable, { min: st.min, max: st.max });
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
    const res = await call('doc.profile', { docId, line: roi, channel: Number.isInteger(channel) ? channel : activeChannel(info),
      vertical: !!anaSetting('ana.vertical', false), interpolate: anaSetting('ana.interpolate', true) !== false });
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
    // the plane the entry belongs to: { c, z, t } (1-based, 0 = any) or { n } (a plain stack's slice)
    if (e.position !== undefined && e.position !== null) {
      const p = e.position;
      if (typeof p !== 'object' || ['c', 'z', 't', 'n'].some((k) => p[k] !== undefined && !(Number.isInteger(p[k]) && p[k] >= 0))) throw extError('roiManager: position');
      out.position = { c: p.c | 0, z: p.z | 0, t: p.t | 0 }; if (p.n > 0) out.position.n = p.n;
    }
    return out;
  }
  function roiListChanged() { refreshRois(); scheduleToolRefresh('rois'); scheduleMetaPersist(); }
  const roiManagerApi = Object.freeze({
    list() { return S.roiList.map((r) => { const o = { name: r.name, docId: r.docId, roi: r.roi }; for (const k of ['stroke', 'width', 'fill', 'position']) if (r[k] !== undefined) o[k] = r[k]; return o; }); },
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
    dropBlob: dropBlobExt,
    setDisplayMode: setDisplayModeExt,
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
    roiManager: roiManagerApi,
    // stacks (DOCS/studio-advanced/stacks/API.md §7)
    position: positionExt,
    setPosition: setPositionExt,
    dims: dimsExt,
    askStack: (spec) => { const info = docOf(spec) || activeInfo(); return info ? askStack(info, spec) : Promise.resolve(null); },
    label: labelExt,
    setLabel: setLabelExt,
    animation: animationApi
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
      if (raw.gesture !== undefined && typeof raw.gesture !== 'boolean') throw extError('extend: gesture of ' + raw.id);
      if (typeof raw.run !== 'function') throw extError('extend: run of ' + raw.id);
      if (!(typeof raw.order === 'number' && isFinite(raw.order))) throw extError('extend: order of ' + raw.id);
      if (raw.enabled !== undefined && typeof raw.enabled !== 'function') throw extError('extend: enabled of ' + raw.id);
      known.add(raw.id);
      const keys = Array.isArray(raw.keys) && raw.keys.length ? raw.keys.slice() : (raw.shortcut ? [raw.shortcut] : []);
      const enabled = typeof raw.enabled === 'function' ? raw.enabled : has;
      built.push({
        id: raw.id, menu: raw.menu.slice(), labelKey: raw.labelKey || ('cmd.' + raw.id), shortcut: raw.shortcut || keys[0] || null, keys,
        order: raw.order, pkg: spec.pkg, long: !!raw.long, gesture: raw.gesture === true, ext: true, separatorBefore: !!raw.separatorBefore, repeatable: raw.repeatable !== false,
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
        onChannel: (c, docId, mode) => { const i = docId !== undefined && docId !== null ? S.docs.get(docId) : activeInfo(); if (i) setDocDisplayMode(i.docId, mode ? { active: c, mode } : { active: c }); },
        onPosition: onShellPosition, onAnimate: (docId, a) => { if (a === 'toggle') toggleAnimation(docId); },
        sliceLabel: (docId, p) => (S.docs.has(docId) ? sliceLabelAt(docId, { z: p.z, t: p.t }, p.c) : null),
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
    attachLibrary();                 // the entry screen offers Open from Library… only when the page has a library
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
    // a floating paste still pending owns a timer and blob refs: its own cancel stops them (before the worker goes)
    cancelPending();
    REPEAT.run = null; REPEAT.next = null; REPEAT.nested = false;
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
    S.previewDocs.clear(); S.overlayDocs.clear(); S.previewRedo = null; S.placing = false;
    for (const id of Array.from(S.anim.keys())) stopAnimation(id);
    for (const m of [S.docs, S.activeCh, S.dstate, S.sel, S.prevSel, S.undo, S.cleanRev, S.revs, S.sessionKeys, S.sources, S.displayPatch, S.displayInflight, S.pos, S.posSync, S.labels, S.animOpts]) m.clear();
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
    imageSizeString, planLevels, mapRange, mvox, projectionProgress, outputBitDepth, bcMath, measurementKeys, errorKey, snapshotOf: (st) => st, workerInit, distributionHistogram, distributionDefaultColumn, COLUMNS, PARTICLE_COLUMNS
  };
})();
