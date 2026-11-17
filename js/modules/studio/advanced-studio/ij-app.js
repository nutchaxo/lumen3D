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
const IJApp = (() => {
  'use strict';

  // ───────────────────────────── constants ─────────────────────────────

  const LUT_NAMES = ['Grays', 'Red', 'Green', 'Blue', 'Cyan', 'Magenta', 'Yellow', 'Fire', 'Ice',
    'Spectrum', '16 Colors', 'HiLo'];
  const AREA_TYPES = new Set(['rect', 'oval', 'polygon', 'freehand', 'mask']);
  const MEASURE_KEY = 'lumen3d.ij.measurements';
  const MEASURE_GROUPS = {
    area: ['area'],
    mean: ['mean'],
    stdDev: ['stdDev'],
    mode: ['mode'],
    minMax: ['min', 'max'],
    centroid: ['xCentroid', 'yCentroid'],
    center: ['xCenterOfMass', 'yCenterOfMass'],
    intDen: ['intDen', 'rawIntDen'],
    median: ['median'],
    skewness: ['skewness'],
    kurtosis: ['kurtosis']
  };
  const MEASURE_DEFAULT = ['area', 'mean', 'minMax'];
  // Result column of each statistics key, in ImageJ's column order.
  const COLUMNS = [
    ['area', 'Area'], ['mean', 'Mean'], ['stdDev', 'StdDev'], ['mode', 'Mode'], ['min', 'Min'],
    ['max', 'Max'], ['xCentroid', 'X'], ['yCentroid', 'Y'], ['xCenterOfMass', 'XM'],
    ['yCenterOfMass', 'YM'], ['intDen', 'IntDen'], ['rawIntDen', 'RawIntDen'], ['median', 'Median'],
    ['skewness', 'Skew'], ['kurtosis', 'Kurt'], ['angle', 'Angle'], ['length', 'Length']
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
    IJ_TIFF_UNSUPPORTED: 'err.tiffUnsupported',
    IJ_INCOMPLETE: 'err.incomplete',
    IJ_WORKER_CRASHED: 'err.workerCrashed',
    IJ_NO_UNDO: 'err.noUndo',
    IJ_NOT_8BIT: 'err.not8bit',
    IJ_STORAGE_FULL: 'err.storageFull',
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
    { id: 'point', labelKey: 'tool.point', icon: 'crosshair', hasOptions: true },
    { separator: true },
    { id: 'zoom', labelKey: 'tool.zoom', icon: 'zoom-in' },
    { id: 'hand', labelKey: 'tool.hand', icon: 'hand' }
  ];
  const LONG_COMMANDS = new Set(['doc.run', 'doc.project.add', 'doc.threshold', 'doc.particles',
    'doc.open', 'doc.duplicate', 'doc.exportTiff']);
  const PERSIST_MS = 1200;
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
      cmd('analyzeClearResults', ['Analyze'], { enabled: (st) => !!st.hasResults, run: (a) => a.clearResults() }),
      cmd('analyzeSetMeasurements', ['Analyze'], { enabled: always, run: (a) => a.setMeasurements() }),
      cmd('analyzeHistogram', ['Analyze'], Object.assign(sc('h'), { run: (a) => a.histogram() })),
      cmd('analyzePlotProfile', ['Analyze'], Object.assign(sc('k'), { enabled: (st) => has(st) && !!st.roi && st.roi.type === 'line', run: (a) => a.plotProfile() })),
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
    visHandler: null, menuList: [], warnUnprotected: false, warnBudget: '', warnLow: false,
    emptyEl: null, displayPatch: new Map(), displayInflight: new Map(),
    openCounter: 0, savedAt: 0
  };

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
    if (err && typeof err === 'object' && (err.name === 'AbortError' || err.cancelled)) return '';
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
    if (S.warnUnprotected) parts.push(tr('warn.unprotected'));
    if (S.warnLow) parts.push(tr('warn.lowStorage'));
    if (S.warnBudget) parts.push(S.warnBudget);
    S.shell.setWarning(parts.length ? parts.join(' ') : null);
  }

  // ───────────────────────────── worker client ─────────────────────────────

  function startWorker() {
    const p = S.ctx.plugin;
    const w = new Worker(p.assetUrl('ij-worker.js'));
    const client = { w, pending: new Map(), nextId: 1, dead: false, gen: ++S.workerGen };
    w.onmessage = (ev) => onWorkerMessage(client, ev.data);
    w.onerror = (ev) => { if (ev && ev.preventDefault) ev.preventDefault(); console.error('[advanced-studio] worker error', ev && ev.message); onWorkerCrash(client); };
    w.onmessageerror = () => onWorkerCrash(client);
    S.budgetBytes = budgetFromDevice();
    w.postMessage({ init: { scripts: [p.fileUrl('ij-core.js'), p.fileUrl('ij-analysis.js'), p.fileUrl('ij-engine.js')], budgetBytes: S.budgetBytes } });
    S.worker = client;
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
    if (m.event) { onWorkerEvent(m); return; }
    const entry = client.pending.get(m.id);
    if (!entry) return;
    client.pending.delete(m.id);
    if (m.ok) entry.resolve(m.result);
    else {
      const e = m.error || {};
      entry.reject(Object.assign(new Error(e.message || e.code || 'engine error'), { code: e.code || 'IJ_ENGINE' }));
    }
  }

  function onWorkerEvent(m) {
    switch (m.event) {
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
        if (m.sizeChanged) refreshInfo(m.docId).then(() => showDoc(m.docId)).catch(reportError);
        else S.display.invalidate(m.channels);
        scheduleToolRefresh('pixels');
        break;
      }
      case 'saved':
        S.savedAt = m.at || Date.now();
        S.warnUnprotected = false;
        showWarning();
        break;
      case 'storageError':
        S.warnUnprotected = true;
        showWarning();
        break;
      case 'budget':
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
  function onWorkerCrash(client) {
    if (client.dead) return;
    client.dead = true;
    try { client.w.terminate(); } catch (_) { /* already gone */ }
    for (const [, e] of client.pending) e.reject(Object.assign(new Error('worker crashed'), { code: 'IJ_WORKER_CRASHED' }));
    client.pending.clear();
    if (S.worker !== client || !S.mounted) return;
    S.docs.clear(); S.order = []; S.activeId = null;
    endBusy();
    recoverAfterCrash().catch((err) => console.error('[advanced-studio]', err));
  }

  async function recoverAfterCrash() {
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
  function activeChannel(info) { return S.activeCh.get((info || activeInfo()).docId) || 0; }
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
      canProject: !!(S.desc && S.desc.available)
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

  function initDisplayState(info) {
    const id = info.docId;
    const prev = S.dstate.get(id);
    const chans = (info.channels || []).map((c, i) => {
      const d = c.display || {};
      return { min: d.min, max: d.max, lut: d.lut, invert: !!d.invert, color: c.color };
    });
    S.dstate.set(id, {
      mode: (prev && prev.mode) || info.mode || 'composite',
      visible: chans.map((_, i) => (prev && prev.visible && prev.visible[i] !== undefined ? prev.visible[i] : (info.channels[i].visible !== false))),
      channels: chans
    });
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
      refreshUi();
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
    S.shell.setActiveRoi(selOf(docId));
    refreshRois();
    syncWindowMenu();
    refreshUi();
    scheduleToolRefresh('doc');
  }

  async function adoptNewDocs(ids) {
    let last = null;
    for (const id of ids || []) {
      const info = await call('doc.info', { docId: id });
      registerDoc(info, { clean: false, provenance: S.sources.get(S.activeId) || null });
      last = id;
    }
    if (last !== null) await showDoc(last);
  }

  function applyRunResult(docId, res) {
    if (!res) return;
    if (res.info) S.docs.set(docId, res.info);
    if (res.rev !== undefined) S.revs.set(docId, res.rev);
    const u = S.undo.get(docId) || { undo: 0, redo: 0 };
    S.undo.set(docId, { undo: u.undo + 1, redo: 0 });
    if (res.info) initDisplayState(res.info);
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
      call('session.putMeta', { results: S.results, rois: S.roiList.map((r) => ({ name: r.name, docId: r.docId, roi: r.roi })),
        measurements: S.measurements, windows: Array.from(S.wins.keys()) }).catch((err) => console.error('[advanced-studio] putMeta', err));
    }, PERSIST_MS);
  }

  // ───────────────────────────── operations on the active image ─────────────────────────────

  async function runOp(op, params, opts) {
    const info = activeInfo();
    if (!info) return null;
    const o = opts || {};
    const roi = o.noRoi ? null : selOf(info.docId);
    const channel = o.channel !== undefined ? o.channel : (o.all ? 'all' : activeChannel(info));
    return busy(tr('op.' + op), async () => {
      const res = await call('doc.run', { docId: info.docId, op, params: params || {}, roi, channel });
      applyRunResult(info.docId, res);
      if (res.changed && res.changed.sizeChanged) {
        S.sel.delete(info.docId);
        await showDoc(info.docId);
        if (S.display) S.display.fit();
      } else {
        if (S.display) S.display.invalidate(res.changed ? res.changed.channels : undefined);
        pushDisplay();
        refreshRois();
        scheduleToolRefresh('pixels');
      }
      if (res.newDocIds && res.newDocIds.length) await adoptNewDocs(res.newDocIds);
      return res;
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
      if (res.info) initDisplayState(res.info);
      if (res.changed && res.changed.sizeChanged) { S.sel.delete(info.docId); await showDoc(info.docId); S.display.fit(); }
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

  async function dialog(config) {
    if (!S.shell) return null;
    return S.shell.windows.dialog(config);
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
      onChange(values) {
        clearTimeout(S.previewTimer);
        if (!values) { S.previewSeq++; S.display.setPreview(null); return; }
        S.previewTimer = setTimeout(() => {
          const seq = ++S.previewSeq;
          const r = visibleRect(info);
          const level = S.display.getView().level || 0;
          call('doc.preview', { docId: info.docId, seq, op, params: buildParams(values), roi: selOf(info.docId),
            channel: values.all && allChannels ? 'all' : activeChannel(info), level,
            x0: Math.max(0, Math.floor(r.x0)), y0: Math.max(0, Math.floor(r.y0)),
            x1: Math.min(info.width, Math.ceil(r.x1)), y1: Math.min(info.height, Math.ceil(r.y1)) })
            .catch((err) => console.error('[advanced-studio] preview', err));
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
    const ok = await saveFile(safeName(info.name, '.tif'), 'image/tiff', '.tif', 'TIFF', async () => {
      const res = await call('doc.exportTiff', { docId });
      return res.bytes;
    });
    if (ok) {
      await call('doc.markSaved', { docId });
      S.cleanRev.set(docId, S.revs.get(docId));
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

  const resultColumns = () => {
    const used = new Set();
    for (const r of S.results) for (const k of Object.keys(r)) used.add(k);
    const cols = [];
    if (used.has('Label')) cols.push('Label');
    if (used.has('Ch')) cols.push('Ch');
    for (const [, name] of COLUMNS.concat(PARTICLE_COLUMNS)) if (used.has(name) && !cols.includes(name)) cols.push(name);
    return cols;
  };
  function resultsText(sep) {
    const cols = resultColumns();
    const q = (v) => {
      const s = v === undefined || v === null ? '' : String(v);
      return sep === ',' && /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const lines = [[' '].concat(cols).map(q).join(sep)];
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
        const res = await call('doc.open', { bytes: new Uint8Array(buf) }, [buf]);
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
      if (res.info) { S.docs.set(info.docId, res.info); initDisplayState(res.info); }
      if (res.rev !== undefined) S.revs.set(info.docId, res.rev);
      S.undo.set(info.docId, { undo: 0, redo: 0 });
      S.sel.delete(info.docId);
      await showDoc(info.docId);
      S.display.fit();
    });
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
    try { await call('doc.close', { docId: id }); } catch (err) { console.error('[advanced-studio]', err); }
    const key = S.sessionKeys.get(id);
    if (key) call('session.discard', { key }).catch(() => {});
    for (const m of [S.docs, S.activeCh, S.dstate, S.sel, S.prevSel, S.undo, S.cleanRev, S.revs, S.sessionKeys, S.sources]) m.delete(id);
    S.order = S.order.filter((x) => x !== id);
    S.roiList = S.roiList.filter((r) => r.docId !== id);
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
    if (!list.length) {
      await ask({ title: tr('cmd.fileRecover'), message: tr('recover.none'), options: [{ id: 'ok', label: tr('dlg.ok'), primary: true }], dismissId: 'ok' });
      return;
    }
    const fmt = (s) => {
      const n = Array.isArray(s.docs) ? s.docs.length : Number(s.docs) || 0;
      return tr('recover.item', { time: new Date(s.savedAt).toLocaleString(), n }) + (s.unsaved ? ' *' : '');
    };
    const v = await dialog({ title: tr('cmd.fileRecover'), okLabel: tr('dlg.ok'), fields: [
      { type: 'choice', id: 'key', label: tr('recover.session'), value: list[0].key, options: list.map((s) => ({ value: s.key, label: fmt(s) })) },
      { type: 'choice', id: 'action', label: tr('recover.action'), value: 'restore', options: [{ value: 'restore', label: tr('recover.restore') }, { value: 'discard', label: tr('recover.discard') }] }] });
    if (!v) return;
    if (v.action === 'discard') {
      try { await call('session.discard', { key: v.key }); setStatus(tr('recover.discarded')); } catch (err) { await reportError(err); }
      return;
    }
    await restoreSession(v.key);
  }

  async function restoreSession(key) {
    await busy(tr('op.restore'), async () => {
      const res = await call('session.restore', { key });
      let last = null;
      for (const id of res.docIds || []) {
        const info = await call('doc.info', { docId: id });
        registerDoc(info, { clean: false, sessionKey: key });
        last = id;
      }
      if (res.meta) restoreMeta(res.meta);
      if (last !== null) { await showDoc(last); S.display.fit(); }
    });
  }

  function restoreMeta(meta) {
    if (Array.isArray(meta.results)) S.results = meta.results;
    if (Array.isArray(meta.rois)) S.roiList = meta.rois.filter((r) => r && r.roi).map((r) => ({ name: r.name, docId: r.docId, roi: r.roi }));
    scheduleToolRefresh('results');
    refreshRois();
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
      row(btn(tr('cmd.stackProject'), () => zProject(), 'ij-btn-primary'), btn(tr('cmd.fileOpen'), () => openTiff()), btn(tr('cmd.fileSimple'), () => simpleView())));
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
      const mine = (res.sessions || []).filter((s) => String(s.key).startsWith(fkey + '|') && !loaded.has(s.key));
      mine.sort((a, b) => b.savedAt - a.savedAt);
      match = mine[0] || null;
    } catch (err) { console.error('[advanced-studio] session.list', err); }
    if (token !== S.enterToken) return;

    if (match) {
      const a = await ask({ title: tr('resume.title'), message: tr('resume.message', { time: new Date(match.savedAt).toLocaleString() }),
        options: [{ id: 'resume', label: tr('resume.resume'), primary: true }, { id: 'fresh', label: tr('resume.fresh') }, { id: 'cancel', label: tr('dlg.cancel') }], dismissId: 'cancel' });
      if (a === 'resume') { await restoreSession(match.key); return; }
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
      row(btn(tr('cmd.fileSimple'), () => simpleView(), 'ij-btn-primary')));
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
    let raw = null;
    try {
      const d = S.ctx.studio.getDocument();
      raw = d && ((d.sliceResult && d.sliceResult.raw) || d.raw) || null;
    } catch (_) { raw = null; }
    if (!raw || !raw.data || !raw.width || !raw.height) return null;
    const ac = Number(S.ctx.studio.getDocument && (S.ctx.studio.getDocument() || {}).activeChannel);
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
    const sessionKey = [fkey, lvDesc.level, opt.method, (opt.a) + '-' + (opt.b)].join('|');
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
      const begin = await call('doc.project.begin', { name, method: opt.method, width: session.width, height: session.height, depth,
        channels: channels.map((c) => ({ name: c.name, color: c.color })), calibration: cal, provenance });
      docId = begin.docId;
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
      const bands = Math.ceil(session.height / session.bandRows);
      const zChunk = Math.max(1, session.zChunk || 1);
      const chIdx = channels.map((c) => c.index);
      const totalPlanes = depth * bands;
      let donePlanes = 0, loadedBytes = 0, inflight = null;
      for (let bi = 0, y0 = 0; y0 < session.height; bi++, y0 += session.bandRows) {
        const y1 = Math.min(session.height, y0 + session.bandRows);
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
      registerDoc(res.info, { clean: false, provenance: S.sources.get(info.docId) || null });
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
      { type: 'number', id: 'sigma', label: tr('dlg.sigma'), value: 2, min: 0, step: 0.5, units: tr('dlg.pixels') },
      { type: 'check', id: 'scaled', label: tr('dlg.scaled', { unit: cal.unit || 'µm' }), value: false }],
    'gaussian', (v) => ({ sigma: Math.max(0, Number(v.sigma)), scaled: !!v.scaled }));
  }
  async function rank(type) {
    const names = { median: 'filterMedian', mean: 'filterMean', min: 'filterMinimum', max: 'filterMaximum' };
    await filterDialog('cmd.' + names[type], [{ type: 'number', id: 'radius', label: tr('dlg.radius'), value: 2, min: 0, step: 0.5, units: tr('dlg.pixels') }],
      'rank', (v) => ({ type, radius: Math.max(0, Number(v.radius)) }));
  }

  // ── analysis

  function measuredKeys(roi) {
    return measurementKeys(S.measurements, !!roi && roi.type === 'line');
  }
  function toRow(res, info, roi, channelIdx) {
    const out = {};
    if ((info.channels || []).length > 1) out.Ch = channelIdx + 1;
    for (const [key, col] of COLUMNS) if (res[key] !== undefined) out[col] = res[key];
    return out;
  }
  async function measureRoi(info, roi, channelIdx) {
    const res = await call('doc.stats', { docId: info.docId, roi, channel: channelIdx, measurements: measuredKeys(roi) });
    return toRow(res.row || res, info, roi, channelIdx);
  }
  async function measure() {
    const info = activeInfo();
    if (!info) return;
    await busy(tr('op.measure'), async () => {
      S.results.push(await measureRoi(info, selOf(info.docId), activeChannel(info)));
      scheduleToolRefresh('results');
      scheduleMetaPersist();
    });
    openTool('results');
  }
  function clearResults() { S.results = []; scheduleToolRefresh('results'); scheduleMetaPersist(); refreshUi(); }

  async function setMeasurements() {
    const v = await dialog({ title: tr('cmd.analyzeSetMeasurements'), okLabel: tr('dlg.ok'),
      fields: Object.keys(MEASURE_GROUPS).map((g) => ({ type: 'check', id: g, label: tr('meas.' + g), value: S.measurements.includes(g) })) });
    if (!v) return;
    S.measurements = Object.keys(MEASURE_GROUPS).filter((g) => v[g]);
    if (!S.measurements.length) S.measurements = ['area'];
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
    if (!line || line.type !== 'line') return;
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
    await busy(tr('op.particles'), async () => {
      const opts = { minSize: Math.max(0, Number(v.minSize)) / pxArea, maxSize: Math.max(0, Number(v.maxSize)) / pxArea,
        minCirc: Number(v.minCirc), maxCirc: Number(v.maxCirc), excludeEdges: !!v.exclude, includeHoles: !!v.holes,
        roi: isAreaRoi(selOf(info.docId)) ? selOf(info.docId) : null };
      const res = await call('doc.particles', { docId: info.docId, channel: activeChannel(info), opts });
      const rowsOut = (res.rows || []).map((p) => {
        const r = {};
        for (const [key, col] of PARTICLE_COLUMNS) if (p[key] !== undefined) r[col] = p[key];
        return r;
      });
      if (v.display) { S.results = S.results.concat(rowsOut); scheduleToolRefresh('results'); }
      if (v.manager) {
        (res.outlines || []).forEach((pts) => S.roiList.push({ name: roiName({ type: 'polygon', points: pts }), docId: info.docId, roi: { type: 'polygon', points: pts } }));
        refreshRois(); scheduleToolRefresh('rois');
      }
      scheduleMetaPersist();
      if (v.display) openTool('results');
      if (v.manager) openTool('roiManager');
      if (v.summarize && res.summary) {
        const s = res.summary;
        await ask({ title: tr('part.summaryTitle'), message: tr('part.summary', { count: s.count, total: num(s.totalArea, 3), avg: num(s.averageSize, 3), frac: num(s.percentArea, 2), unit }),
          options: [{ id: 'ok', label: tr('dlg.ok'), primary: true }], dismissId: 'ok' });
      }
    });
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

  const TOOL_WINDOWS = { bc: buildBC, channels: buildChannels, threshold: buildThreshold, results: buildResults, roiManager: buildRoiManager };

  function floatingWindow(id, titleKey, build) {
    if (!S.shell) return null;
    const existing = S.wins.get(id);
    if (existing) { existing.focus(); const u = S.winUpdaters.get(id); if (u) u('doc'); return existing; }
    const view = build();
    const win = S.shell.windows.floating({ id, title: tr(titleKey), content: view.el, onClose: () => {
      S.wins.delete(id); S.winUpdaters.delete(id);
      if (view.dispose) view.dispose();
      scheduleMetaPersist();
    } });
    S.wins.set(id, win);
    if (view.update) { S.winUpdaters.set(id, view.update); view.update('doc'); }
    scheduleMetaPersist();
    return win;
  }

  function openTool(id) {
    const titles = { bc: 'cmd.adjustBC', channels: 'cmd.colorChannels', threshold: 'cmd.adjustThreshold', results: 'win.results', roiManager: 'cmd.toolsRoiManager' };
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
      row(btn(tr('thr.auto'), auto), btn(tr('thr.apply'), apply, 'ij-btn-primary'), btn(tr('thr.reset'), reset), btn(tr('thr.setBtn'), setDialog)));
    // Opening the window thresholds with the default method at once, like ImageJ.
    let first = true;
    return {
      el,
      update(kind) { if (kind === 'doc' || kind === 'pixels') { refresh(first); first = false; } else if (kind === 'display') commit(); },
      dispose() { if (S.display && S.display.setThresholdOverlay) S.display.setThresholdOverlay(null); }
    };
  }
  function IJThresholdMethods() {
    return typeof IJThreshold !== 'undefined' && IJThreshold.methods ? IJThreshold.methods() : ['Default', 'Huang', 'IsoData', 'Li', 'MaxEntropy', 'Mean', 'Otsu', 'Triangle'];
  }

  // ── Results

  function buildResults() {
    const table = h('table', { class: 'ij-table' });
    const wrap = h('div', { class: 'ij-table-wrap' }, table);
    function render() {
      table.textContent = '';
      const cols = resultColumns();
      table.appendChild(h('thead', null, h('tr', null, [h('th', { text: ' ' })].concat(cols.map((c) => h('th', { text: c }))))));
      const tb = h('tbody');
      const cap = Math.min(S.results.length, 20000);
      for (let i = 0; i < cap; i++) {
        const r = S.results[i];
        tb.appendChild(h('tr', null, [h('td', { text: String(i + 1) })].concat(cols.map((c) => h('td', { text: r[c] === undefined ? '' : (typeof r[c] === 'number' ? num(r[c], 4) : String(r[c])) })))));
      }
      table.appendChild(tb);
      wrap.scrollTop = wrap.scrollHeight;
    }
    const el = h('div', { class: 'ij-panel ij-results' }, wrap,
      row(btn(tr('res.copy'), async () => { try { await navigator.clipboard.writeText(resultsText('\t')); setStatus(tr('status.copied')); } catch (err) { console.error(err); setStatus(tr('err.clipboard'), 'error'); } }),
        btn(tr('res.save'), () => saveResults()), btn(tr('res.clear'), () => clearResults())));
    return { el, update(kind) { if (kind === 'results' || kind === 'doc') render(); } };
  }

  // ── ROI Manager

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
      const done = (ok) => { if (ok && input.value.trim()) item.name = input.value.trim(); render(); scheduleMetaPersist(); };
      input.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') done(true); else if (e.key === 'Escape') done(false); });
      input.addEventListener('blur', () => done(true));
    }
    const targets = () => { const l = curList(); const sel = l.filter((r) => S.roiSelected.has(r)); return sel.length ? sel : l; };
    const el = h('div', { class: 'ij-panel ij-roimanager' }, list,
      row(btn(tr('roi.add'), () => addToManager()), btn(tr('roi.delete'), () => { const t = targets(); S.roiList = S.roiList.filter((r) => !t.includes(r)); t.forEach((r) => S.roiSelected.delete(r)); render(); refreshRois(); scheduleMetaPersist(); })),
      row(btn(tr('roi.measure'), async () => {
        const info = activeInfo(); if (!info) return;
        await busy(tr('op.measure'), async () => { for (const r of targets()) S.results.push(await measureRoi(info, r.roi, activeChannel(info))); scheduleToolRefresh('results'); scheduleMetaPersist(); });
        openTool('results');
      }), check(tr('roi.showAll'), S.showAll, (on) => { S.showAll = on; refreshRois(); })));
    return { el, update(kind) { if (kind === 'rois' || kind === 'doc') render(); } };
  }

  // ── static result windows (Histogram, Plot Profile, Show Info, Help)

  function openStaticWindow(idPrefix, title, content) {
    if (!S.shell) return;
    const id = idPrefix + '-' + (++S.openCounter);
    S.shell.windows.floating({ id, title, content });
  }

  function openHistogramWindow(info, ch, hist, stats) {
    const canvas = h('canvas', { class: 'ij-hist', width: 256, height: 128 });
    const text = ['area', 'mean', 'stdDev', 'min', 'max', 'mode'].filter((k) => stats[k] !== undefined).map((k) => tr('meas.' + k) + ': ' + num(stats[k], 4)).join('\n')
      + '\n' + tr('hist.binWidth') + ': ' + num(hist.binWidth, 4);
    const content = h('div', { class: 'ij-panel ij-histwin' }, canvas, h('pre', { class: 'ij-info-pre', text }),
      row(btn(tr('hist.list'), () => openListWindow(tr('hist.list'), ['value\tcount'].concat(Array.from(hist.counts, (c, i) => num(hist.min + i * hist.binWidth, 4) + '\t' + c)).join('\n'))),
        btn(tr('res.copy'), () => copyText(Array.from(hist.counts, (c, i) => num(hist.min + i * hist.binWidth, 4) + '\t' + c).join('\n')))));
    openStaticWindow('histogram', tr('cmd.analyzeHistogram') + ' — ' + info.name, content);
    requestAnimationFrame(() => drawHist(canvas, hist, {}));
  }

  function openProfileWindow(info, res) {
    const values = Array.from(res.values || []);
    const canvas = h('canvas', { class: 'ij-plot', width: 360, height: 180 });
    const unit = (info.calibration && info.calibration.unit) || 'px';
    const step = res.stepUm || 1;
    const csv = ['distance (' + unit + '),value'].concat(values.map((v, i) => num(i * step, 5) + ',' + v)).join('\n');
    const content = h('div', { class: 'ij-panel ij-profile' }, canvas,
      row(btn(tr('hist.list'), () => openListWindow(tr('cmd.analyzePlotProfile'), csv.replace(/,/g, '\t'))), btn(tr('res.copy'), () => copyText(csv.replace(/,/g, '\t'))),
        btn(tr('res.save'), async () => { try { await saveFile('Profile.csv', 'text/csv', '.csv', 'CSV', async () => new Blob([csv + '\n'], { type: 'text/csv' })); } catch (err) { await reportError(err); } })));
    openStaticWindow('profile', tr('cmd.analyzePlotProfile') + ' — ' + info.name, content);
    requestAnimationFrame(() => drawPlot(canvas, values, step, unit));
  }

  function drawPlot(canvas, values, step, unit) {
    const g = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height, L = 44, B = 22, T = 8, Rr = 8;
    const cs = getComputedStyle(canvas);
    const fg = cs.getPropertyValue('--text-primary').trim() || '#ccc';
    g.clearRect(0, 0, W, H);
    if (!values.length) return;
    let lo = Infinity, hi = -Infinity;
    for (const v of values) { if (v < lo) lo = v; if (v > hi) hi = v; }
    if (hi === lo) { hi = lo + 1; }
    g.strokeStyle = fg; g.fillStyle = fg; g.lineWidth = 1; g.font = '10px sans-serif';
    g.strokeRect(L + 0.5, T + 0.5, W - L - Rr, H - T - B);
    g.fillText(num(hi, 2), 2, T + 8); g.fillText(num(lo, 2), 2, H - B);
    g.fillText('0', L, H - 8); const total = (values.length - 1) * step; g.fillText(num(total, 2) + ' ' + unit, W - Rr - 60, H - 8);
    g.beginPath();
    values.forEach((v, i) => {
      const x = L + (values.length > 1 ? (i / (values.length - 1)) * (W - L - Rr) : 0);
      const y = T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
      if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
    });
    g.stroke();
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
    const paras = ['about.intro', 'about.source', 'about.depth', 'about.deviations', 'about.storage'].map((k) => h('p', { text: tr(k) }));
    openStaticWindow('about', tr('cmd.helpAbout'), h('div', { class: 'ij-panel' }, paras));
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
    const list = COMMANDS.map((c) => Object.assign({}, c, { shortcut: c.keys.length ? c.keys.slice() : null }));
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
    if (!c.enabled(snapshot())) return undefined;
    return Promise.resolve()
      .then(() => c.run(API))
      .catch((err) => reportError(err));
  }

  function refreshUi() { if (S.shell) S.shell.refreshMenus(); }

  function readPixel(x, y) {
    const info = activeInfo();
    if (!info) return Promise.resolve(null);
    return call('doc.pixel', { docId: info.docId, x, y }).then((r) => r.values);
  }

  function onToolOptions(id) {
    if (id !== 'line') return;
    dialog({ title: tr('tool.lineWidth'), okLabel: tr('dlg.ok'), fields: [{ type: 'number', id: 'w', label: tr('tool.lineWidth'), value: S.lineWidth, min: 1, max: 200, integer: true, units: tr('dlg.pixels') }] })
      .then((v) => { if (v) { S.lineWidth = Math.max(1, Math.round(Number(v.w))); S.shell.setLineWidth(S.lineWidth); } });
  }

  function onVisibility() {
    if (document.visibilityState === 'hidden' && S.worker && !S.worker.dead && S.docs.size) call('flush', {}).catch(() => {});
  }

  // The facade the commands receive.
  const API = {
    openTiff, saveTiff, savePng, saveResults, revert, recover: recoverDialog, closeImage: () => closeImage(), simpleView, closeStudio,
    undo: () => undoRedo('undo'), redo: () => undoRedo('redo'), clearSel, fillSel, invert, selectAll, selectNone, restoreSelection, makeInverse, addToManager,
    convertType, openTool, showInfo, zProject, crop, duplicate, simpleOp, zoom, zoom100, zoomToSelection, zoomFit, applyLut, setLut, invertLut,
    convertToMask, binary, math, gaussian, rank, measure, particles, clearResults, setMeasurements, histogram, plotProfile, cycleImage, showAbout, showShortcuts
  };

  // ───────────────────────────── public lifecycle ─────────────────────────────

  function mount(root, { ctx, api }) {
    S.ctx = ctx; S.api = api; S.root = root; S.leaving = null;
    if (S.appEl && S.shell) {
      // Back from the Simple view: the DOM, the worker and the documents are still here.
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
        commands: S.menuList, getState: snapshot, t: shellT,
        tools: TOOLS.map((t) => (t.separator ? t : { id: t.id, labelKey: t.labelKey })),
        onCommand, onTool: (id) => { S.tool = id; }, onToolOptions,
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

  async function canLeave(reason) {
    if (reason === 'simple') { S.leaving = 'simple'; return true; }
    const dirty = dirtyDocs();
    if (!dirty.length) { S.leaving = reason; return true; }
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
      try { await call('flush', {}); } catch (err) { console.error('[advanced-studio] flush', err); await reportError(err); return false; }
    } else if (a === 'discard') {
      for (const id of dirty) { const key = S.sessionKeys.get(id); if (key) await call('session.discard', { key }).catch(() => {}); }
      for (const id of dirty) { S.docs.delete(id); S.order = S.order.filter((x) => x !== id); }
    } else {
      return false;
    }
    S.leaving = reason;
    return true;
  }

  function unmount() {
    if (!S.mounted) return;
    if (S.leaving === 'simple' && S.display) {
      // Hidden, not torn down: the worker and the documents keep running.
      S.mounted = false;
      endPreview();
      if (S.appEl) S.appEl.style.display = 'none';
      if (S.root) S.root.classList.remove('ij-root');
      return;
    }
    dispose();
  }

  function dispose() {
    S.mounted = false;
    clearTimeout(S.persistTimer); clearTimeout(toolTimer); clearTimeout(S.previewTimer);
    if (S.loadAbort) S.loadAbort.abort();
    const w = S.worker;
    if (w && !w.dead) {
      // Snapshot what is unsaved, then stop the worker.
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
    S.display = null; S.shell = null; S.windows = null; S.appEl = null; S.host = null; S.emptyEl = null; S.menuList = [];
    for (const m of [S.docs, S.activeCh, S.dstate, S.sel, S.prevSel, S.undo, S.cleanRev, S.revs, S.sessionKeys, S.sources, S.displayPatch, S.displayInflight]) m.clear();
    S.order = []; S.activeId = null; S.roiList = []; S.roiSelected.clear(); S.results = []; S.figureKey = null; S.desc = null;
    S.leaving = null; S.busy = false; S.warnUnprotected = false; S.warnBudget = ''; S.warnLow = false;
  }

  return {
    mount, unmount, canLeave, hasUnsavedWork,
    COMMANDS, TOOLS, LUT_NAMES, ERROR_KEYS, MEASURE_GROUPS,
    // pure helpers, exposed for tests
    planLevels, mapRange, outputBitDepth, bcMath, measurementKeys, errorKey, snapshotOf: (st) => st
  };
})();
