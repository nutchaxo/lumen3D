/* ============================================================
   IRIBHM Microscopy Platform - Production Slice Studio
   ============================================================ */

const StudioEditor = (() => {
  const DOC_VERSION = 2;
  const COLORS = ['#ff4d4f', '#00d2ff', '#ffd166', '#00a654', '#9b59b6', '#ffffff'];
  const SCALEBAR_STEP = 10;
  // Single source for the slice backdrop: the editing surface and the exported PNG
  // must agree, otherwise the figure changes the moment it leaves the Studio.
  const EXPORT_BACKGROUND = '#000000';
  const TOOL_KEYS = {
    v: 'select',
    r: 'rectangle',
    e: 'ellipse',
    a: 'arrow',
    l: 'line',
    t: 'text',
    d: 'distance',
    g: 'angle',
    s: 'scalebar'
  };
  const TOOL_ICONS = {
    select: 'mouse-pointer-2',
    rectangle: 'square',
    ellipse: 'circle',
    arrow: 'move-right',
    line: 'minus',
    text: 'type',
    scalebar: 'ruler',
    distance: 'move-horizontal',
    angle: 'scan-line'
  };
  // Layers drawn from an (x, y, w, h) box. They rotate at draw time about the box
  // centre; every other layer is made of points and has its rotation baked into them.
  const BOX_LAYER_TYPES = ['rectangle', 'ellipse', 'text'];
  const ROTATION_SNAP_DEG = 15;
  // Rotate handle: a circle on a stem above the selection, sized in screen pixels.
  const ROTATE_HANDLE_OFFSET = 28;
  const ROTATE_HANDLE_RADIUS = 5;
  const ROTATE_HANDLE_HIT = 10;
  const TEXT_PAD = 5;
  const ROTATE_CURSOR = (() => {
    const arc = "<path d='M19 12a7 7 0 1 1-2.05-4.95'/><path d='M19 4.5v3.5h-3.5'/>";
    const svg = "<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24' fill='none' stroke-linecap='round' stroke-linejoin='round'>"
      + `<g stroke='#000' stroke-width='4'>${arc}</g><g stroke='#fff' stroke-width='2'>${arc}</g></svg>`;
    return `url("data:image/svg+xml,${encodeURIComponent(svg)}") 12 12, grab`;
  })();

  let _container = null;
  let _workspace = null;
  let _canvas = null;
  let _ctx = null;
  let _layersContainer = null;
  let _propsContainer = null;
  let _toolsContainer = null;
  let _channelsContainer = null;
  let _palette = null;
  let _minimap = null;
  let _doc = null;
  let _sliceResult = null;
  let _sliceImage = null;
  let _isOpen = false;
  let _activeTool = 'select';
  let _selectedId = null;
  let _hoverHandle = null;
  let _drawing = null;
  let _isPanning = false;
  let _isRotating = false;
  let _spaceDown = false;
  let _pointerStart = null;
  let _rotationStart = null;
  // Fingers currently on the canvas, and the two-finger navigation state they drive
  // ({ startDist, startZoom, midX, midY }, null when idle). A mouse is never in here:
  // one device, one pointer.
  const _touchPointers = new Map();
  let _viewGesture = null;
  let _draggedLayerId = null;
  let _history = [];
  let _future = [];
  let _studioHistograms = [];
  let _activeStudioPanelIndex = 0;
  // The channel widget replays every channel through its change callback while it
  // seeds itself. Those notifications are not operator edits and must not write back.
  let _channelsSeeding = false;
  let _progressEl = null;
  let _progressOnCancel = null;
  // Identifies the open document: open() and close() both move it on. A caller that
  // streams into a document (the native pass) passes the token open() returned, so a
  // pass left over from a closed document can neither draw into the next one nor
  // clear its progress bar and cancel hook.
  let _docToken = 0;
  // compare.js calls init() on top of this file's own DOMContentLoaded init: bound
  // twice, every key and pointer event ran twice (one Ctrl+Z undid two steps).
  let _eventsBound = false;
  // Bumped whenever the picture's pixels change in place (a recolour into the same
  // canvas): with the picture's identity it keys the minimap's cached thumbnail.
  let _pictureVersion = 0;
  const _minimapThumb = { canvas: null, image: null, version: -1, w: 0, h: 0 };
  // The per-cell channel buttons of a Compare figure: built once per document, moved
  // with the view (never rebuilt per pan or zoom step).
  let _compareMenuButtons = [];
  // An open run of channel edits coalesced into one history step (a slider drag);
  // closed by the panel's change / pointerup, a pause, or another history step.
  let _channelEditRun = null;
  const CHANNEL_EDIT_RUN_MS = 1000;
  // The channel panel as last built: what it shows, so a layer edit does not rebuild it.
  let _channelsShown = null;
  // A slice without raw values is re-coloured by re-rendering it through the slicer;
  // the crop window in that render is fixed once so the frame (and every annotation
  // laid on it) never moves when a channel change changes what is visible.
  let _nonRawCrop = null;
  // The slot the single slice's raw texture lives in (SliceCompositor options.slot):
  // a progressive refresh rewrites it in place instead of allocating a new texture.
  const SLICE_TEXTURE_SLOT = { name: 'studio-slice' };
  // Limits of a Studio file read back (a figure has tens of layers, not thousands).
  const IMPORT_MAX_BYTES = 5 * 1024 * 1024;
  const IMPORT_MAX_LAYERS = 2000;
  const IMPORT_MAX_POINTS = 10000;
  const IMPORT_MAX_TEXT = 2000;
  // The largest canvas the PNG export asks a browser for: 16384 px a side and 2²⁸ px
  // (Chrome's and Firefox's area cap; past it toBlob silently gives null).
  const EXPORT_MAX_SIDE = 16384;
  const EXPORT_MAX_PIXELS = 268435456;

  function init() {
    _container = document.getElementById('studio-layout');
    _workspace = document.getElementById('studio-workspace');
    _canvas = document.getElementById('studio-canvas');
    if (!_container || !_canvas) return;
    _ctx = _canvas.getContext('2d');
    _layersContainer = document.getElementById('studio-layers-list');
    _propsContainer = document.getElementById('studio-properties');
    _toolsContainer = document.querySelector('.studio-tools-grid');
    _channelsContainer = document.getElementById('studio-channels');

    _ensureToolbar();
    _ensureCommandPalette();
    _ensureMinimap();
    _bindEvents();
    _resizeCanvas();
  }

  /**
   * Opens a new document on `sliceResult`. → the document's token (see
   * setSliceResult / setLoadProgress `options.token`), or null when nothing opened.
   */
  function open(sliceResult) {
    if (!sliceResult?.canvas && !_hasRaw(sliceResult)) {
      _toast(_t('toast.renderSliceFirst', 'Render a slice before opening Studio.'));
      return null;
    }
    // A new document: the previous one's raw values and GPU textures go with it.
    _cancelChannelRecompose();
    _cancelDrawRequest();
    _resetPointerState();
    _closeTextEditor(false);
    _releaseRaw();
    _nonRawCrop = null;
    // The slice's own channel state seeds the new document.
    const preparedSlice = _prepareSliceForStudio(sliceResult, _seedChannelState(sliceResult));
    if (!preparedSlice?.canvas) {
      _toast(_t('toast.renderSliceFirst', 'Render a slice before opening Studio.'));
      return null;
    }
    // A stream still running for the previous document belongs to it alone.
    if (_isOpen) {
      const pendingCancel = _progressOnCancel;
      setLoadProgress(null);
      pendingCancel?.();
    }
    _docToken++;
    _sliceResult = preparedSlice;
    _sliceImage = preparedSlice.canvas;
    _pictureVersion++;
    _releaseScratchCanvases();
    _doc = _createDocument(preparedSlice);
    _history = [];
    _future = [];
    _channelEditRun = null;
    _channelsShown = null;
    _selectedId = null;
    _activeTool = 'select';
    // A previous session may have left the index on a cell this document has not got.
    _activeStudioPanelIndex = 0;
    _removeCompareMenus();
    _isOpen = true;
    _container.classList.remove('hidden');
    _resizeCanvas();
    _fitImageToViewport();
    // A Compare cell that carries its raw values is shown coloured from them from the
    // start, as every channel edit will colour it (a slab: per-channel projection).
    if (_doc.layoutMaps?.some(_hasRaw)) _rerenderSliceFromChannels(undefined, { rawOnly: true });
    _ensureDefaultScaleBarLayer();
    _pushHistory('Open Studio');
    _renderAll();
    return _docToken;
  }

  /** The token of the open document (0 before the first open). */
  function documentToken() {
    return _docToken;
  }

  // A caller that names a document (options.token) is heard only by that document.
  function _staleToken(options) {
    return options && options.token !== undefined && options.token !== null && options.token !== _docToken;
  }

  /**
   * Swaps the slice behind the open document. `options.imageOnly` is the progressive
   * refresh of the native pass: the same frame with more chunks native, so only the
   * picture is redrawn — layers, panels and calibration are left exactly as they are.
   * Ignored while the Studio is closed (a late refresh never re-opens it) unless
   * `options.reopen`, and when `options.token` names another document. A result of
   * another size re-scales the layers and guides to the new frame.
   */
  function setSliceResult(sliceResult, options = {}) {
    if (!sliceResult?.canvas && !_hasRaw(sliceResult)) return;
    if (options.reopen) {
      open(sliceResult);
      return;
    }
    if (!_doc || !_isOpen || _staleToken(options)) return;
    // Coloured with the DOCUMENT's channel state, never the slice's own: a refresh of
    // the native pass carries the viewer's colours and must not undo the operator's
    // edits made in the Studio since it opened.
    const previousRaw = _sliceResult?.raw || null;
    const preparedSlice = _prepareSliceForStudio(sliceResult, _doc.channelState);
    if (!preparedSlice?.canvas) return;
    if (previousRaw && previousRaw !== preparedSlice.raw && typeof SliceCompositor !== 'undefined') {
      SliceCompositor.release(previousRaw);
    }
    _sliceResult = preparedSlice;
    _sliceImage = preparedSlice.canvas;
    _pictureVersion++;
    if (options.imageOnly && preparedSlice.width === _doc.sourceSlice.width && preparedSlice.height === _doc.sourceSlice.height) {
      _draw();
      return;
    }
    const oldW = Number(_doc.sourceSlice.width) || preparedSlice.width;
    const oldH = Number(_doc.sourceSlice.height) || preparedSlice.height;
    if (preparedSlice.width !== oldW || preparedSlice.height !== oldH) {
      _rescaleDocumentGeometry(preparedSlice.width / oldW, preparedSlice.height / oldH);
    }
    const calibrated = _isCalibratedSlice(preparedSlice);
    const pixelSizeUm = preparedSlice.pixelSizeUm ? _normalizePixelSize(preparedSlice.pixelSizeUm) : null;
    for (const doc of [_doc, ..._history.map(h => h.doc), ..._future.map(h => h.doc)]) {
      if (!doc?.sourceSlice) continue;
      doc.sourceSlice.width = preparedSlice.width;
      doc.sourceSlice.height = preparedSlice.height;
      if (doc.calibration) {
        doc.calibration.calibrated = calibrated;
        if (pixelSizeUm) doc.calibration.pixelSizeUm = _clone(pixelSizeUm);
      }
    }
    _doc.sourceSlice.source = preparedSlice.source || _doc.sourceSlice.source;
    _doc.sourceSlice.quality = preparedSlice.quality || _doc.sourceSlice.quality;
    _doc.planeSpec = _clone(preparedSlice.planeSpec || _doc.planeSpec || {});
    _doc.timepoint = preparedSlice.timepoint ?? _doc.timepoint;
    _doc.calibration.spanUm = _clone(preparedSlice.spanUm || _doc.calibration.spanUm);
    _doc.calibration.physicalSizeUm = _clone(preparedSlice.physicalSizeUm || _doc.calibration.physicalSizeUm);
    _doc.layers.forEach(layer => {
      if (layer.type === 'scalebar') _setScaleBarEnd(layer);
      _updateMeasurementText(layer);
    });
    _ensureDefaultScaleBarLayer();
    _renderAll();
  }

  /**
   * The same figure handed over at another resolution: every coordinate the document
   * holds in image px is scaled by (sx, sy), so each layer and guide stays on the
   * structure it marks. Sizes in screen terms (stroke width, font size) are kept.
   */
  function _rescaleDocumentGeometry(sx, sy) {
    if (!_doc || !Number.isFinite(sx) || !Number.isFinite(sy) || sx <= 0 || sy <= 0) return;
    // The open document and every snapshot of its history: an undo after the swap
    // must bring back layers on THIS frame. The view zoom divides by the same factor
    // (screen = (image − centre)·zoom + pan), so the figure stays where it was on screen.
    for (const doc of [_doc, ..._history.map(h => h.doc), ..._future.map(h => h.doc)]) {
      if (!doc) continue;
      (doc.layers || []).forEach(layer => {
        ['x', 'x1', 'x2', 'x3', 'w'].forEach(k => { if (Number.isFinite(layer[k])) layer[k] *= sx; });
        ['y', 'y1', 'y2', 'y3', 'h'].forEach(k => { if (Number.isFinite(layer[k])) layer[k] *= sy; });
        if (Array.isArray(layer.points)) layer.points = layer.points.map(p => ({ ...p, x: p.x * sx, y: p.y * sy }));
      });
      (doc.guides || []).forEach(guide => { guide.value *= guide.axis === 'x' ? sx : sy; });
      if (doc.viewport && Number.isFinite(doc.viewport.zoom)) doc.viewport.zoom /= Math.sqrt(sx * sy);
    }
  }

  /**
   * False for a picture without a physical scale: a photograph whose file carries no
   * resolution (calibrated: false / pixelSizeUm: null), a perspective 3D capture. Its
   * distances are measured in pixels and it gets no scale bar.
   */
  function _isCalibratedSlice(slice) {
    if (!slice || slice.calibrated === false) return false;
    const x = Number(slice.pixelSizeUm?.x);
    return Number.isFinite(x) && x > 0;
  }

  /** The open single-picture document has no physical scale (see _isCalibratedSlice). */
  function _isUncalibrated() {
    return Boolean(_doc && !(_doc.layoutMaps?.length > 1) && _doc.calibration?.calibrated === false);
  }

  /**
   * Progress of a slice still streaming in behind the open document (the native-
   * resolution upgrade). `null` clears the bar. `onCancel` is invoked if the operator
   * cancels or closes the Studio, so the transfer stops instead of running on unseen.
   * `options.token` (from open()) scopes the call to that document: a pass that ends
   * after its document was closed cannot clear the bar or the cancel hook of the next.
   */
  function setLoadProgress(state, options = {}) {
    if (_staleToken(options)) return;
    if (!state) {
      _progressOnCancel = null;
      _progressEl?.remove();
      _progressEl = null;
      return;
    }
    const el = _ensureProgressEl();
    if (!el) return;
    _progressOnCancel = typeof state.onCancel === 'function' ? state.onCancel : null;
    const pct = Math.max(0, Math.min(100, Math.round(Number(state.percent) || 0)));
    el.querySelector('.studio-progress-label').textContent = state.label || '';
    el.querySelector('.studio-progress-pct').textContent = `${pct}%`;
    el.querySelector('.studio-progress-fill').style.width = `${pct}%`;
    el.querySelector('.studio-progress-cancel').hidden = !_progressOnCancel;
  }

  function _ensureProgressEl() {
    if (_progressEl?.isConnected) return _progressEl;
    const host = _workspace || _container;
    if (!host) return null;
    const el = document.createElement('div');
    el.className = 'studio-progress';
    el.innerHTML = `
      <div class="studio-progress-head">
        <span class="studio-progress-label"></span>
        <span class="studio-progress-pct"></span>
      </div>
      <div class="studio-progress-track"><div class="studio-progress-fill"></div></div>
      <button type="button" class="studio-progress-cancel"></button>`;
    const cancel = el.querySelector('.studio-progress-cancel');
    cancel.textContent = _t('studio.cancelLoad', 'Cancel');
    cancel.addEventListener('click', () => {
      const cb = _progressOnCancel;
      setLoadProgress(null);
      cb?.();
    });
    host.appendChild(el);
    _progressEl = el;
    return el;
  }

  /**
   * Closes the Studio and gives back everything the document held: the raw values and
   * their GPU textures, the Studio's own canvases (the native-size picture, a Compare
   * figure copy, the cell scratch, the minimap thumbnail), the undo history, and the
   * Compare cells' panel frames and slices. getDocument() still returns the closed
   * document, without its runtime fields.
   */
  function close() {
    if (!_isOpen) return;
    _isOpen = false;
    // A native slice may still be streaming for a document nobody is looking at.
    const pendingCancel = _progressOnCancel;
    setLoadProgress(null);
    pendingCancel?.();
    _docToken++;
    _cancelChannelRecompose();
    _cancelDrawRequest();
    _resetPointerState();
    _closeTextEditor(false);
    _releaseRaw();
    _releaseScratchCanvases();
    // The Compare figure the cells were re-coloured on is the Studio's own copy of the
    // one compare.js handed over, and the single slice's canvas is the Studio's own:
    // nothing shows either any more. The canvas compare.js handed over stays its own.
    if (_sliceImage && _sliceImage !== _sliceResult?.canvas && _sliceImage !== _sliceCanvas) {
      _sliceImage.width = 0;
      _sliceImage.height = 0;
    }
    if (_sliceCanvas) {
      _sliceCanvas.width = 0;
      _sliceCanvas.height = 0;
      _sliceCanvas = null;
    }
    _releaseMinimapThumb();
    _removeCompareMenus();
    _sliceImage = null;
    _sliceResult = null;
    _nonRawCrop = null;
    _history = [];
    _future = [];
    _channelEditRun = null;
    _channelsShown = null;
    if (_doc) _doc = _portableDocument(_doc);
    _container.classList.add('hidden');
    // If we're in the standalone viewer, we need to show the viewer elements again
    document.getElementById('webgl-canvas')?.classList.remove('hidden');
    document.getElementById('toolbar')?.classList.remove('hidden');
    document.getElementById('right-panel')?.classList.remove('hidden');
    document.querySelector('.viewer-layout')?.classList.remove('hidden');
    document.querySelector('.compare-layout')?.classList.remove('hidden');
    
    // Stop recording if active
  }

  function getDocument() {
    return _doc ? _clone(_doc) : null;
  }

  function _createDocument(sliceResult) {
    const dataset = sliceResult.dataset
      || (typeof ViewerApp !== 'undefined' && ViewerApp.getDatasetMeta ? ViewerApp.getDatasetMeta() : null);
    const channelState = sliceResult.channelState
      || (typeof ViewerApp !== 'undefined' && ViewerApp.getChannelState ? ViewerApp.getChannelState() : []);
    return {
      version: DOC_VERSION,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      dataset: dataset ? {
        id: dataset.id || null,
        name: dataset.name || null,
        type: dataset.type || null,
        path: dataset.path || null,
        dimensions: dataset.dimensions || null
      } : null,
      timepoint: sliceResult.timepoint ?? (typeof ViewerApp !== 'undefined' && ViewerApp.getCurrentTimepoint ? ViewerApp.getCurrentTimepoint() : null),
      sourceSlice: {
        width: sliceResult.width,
        height: sliceResult.height,
        source: sliceResult.source || sliceResult.quality || '256x256',
        quality: sliceResult.quality || null
      },
      planeSpec: _clone(sliceResult.planeSpec || {}),
      channelState: _clone(channelState || []),
      calibration: {
        calibrated: _isCalibratedSlice(sliceResult) || Boolean(sliceResult.layoutMaps?.length),
        pixelSizeUm: { ..._normalizePixelSize(sliceResult.pixelSizeUm) },
        spanUm: _clone(sliceResult.spanUm || null),
        physicalSizeUm: _clone(sliceResult.physicalSizeUm || null)
      },
      layoutMaps: (sliceResult.layoutMaps || []).map(m => ({
        ..._clone(_layoutMapData(m)),
        iframe: m.iframe,
        raw: m.raw,
        sliceResult: m.sliceResult
      })),
      // The Compare figure's own backdrop: a re-coloured cell is laid on it, so the
      // transparent pixels of a slice keep the colour the figure was composed on.
      layoutBackground: typeof sliceResult.layoutBackground === 'string' ? sliceResult.layoutBackground : null,
      viewport: {
        zoom: 1,
        panX: 0,
        panY: 0,
        rotation: 0
      },
      guides: [],
      groups: [],
      layers: []
    };
  }

  function _bindEvents() {
    if (_eventsBound) return;
    _eventsBound = true;
    document.getElementById('btn-close-studio')?.addEventListener('click', close);
    document.getElementById('btn-studio-open')?.addEventListener('click', () => {
      if (typeof ViewerApp !== 'undefined' && typeof ViewerApp.openStudio === 'function') {
        ViewerApp.openStudio();
        return;
      }
      if (typeof ViewerApp !== 'undefined' && ViewerApp.getCurrentSliceResult) open(ViewerApp.getCurrentSliceResult());
    });
    document.getElementById('btn-studio-reset-view')?.addEventListener('click', () => {
      _fitImageToViewport();
      _viewportChanged();
    });
    document.getElementById('btn-studio-export-png')?.addEventListener('click', _exportPng);
    document.getElementById('btn-studio-export-json')?.addEventListener('click', _exportJson);
    document.getElementById('btn-studio-import')?.addEventListener('click', () => document.getElementById('studio-import-file')?.click());
    document.getElementById('studio-import-file')?.addEventListener('change', _importJson);

    // The end of a channel control gesture closes its run of edits (one history step).
    _channelsContainer?.addEventListener('change', _endChannelEditRun);
    _channelsContainer?.addEventListener('pointerup', _endChannelEditRun);

    _toolsContainer?.addEventListener('click', (event) => {
      const button = event.target.closest('[data-studio-tool]');
      if (!button) return;
      _setTool(button.dataset.studioTool);
    });

    _canvas.addEventListener('pointerdown', _onPointerDown);
    _canvas.addEventListener('pointermove', _onPointerMove);
    _canvas.addEventListener('pointerup', _onPointerUp);
    _canvas.addEventListener('pointercancel', _onPointerUp);
    _canvas.addEventListener('pointerleave', _onPointerLeave);
    _canvas.addEventListener('contextmenu', (event) => event.preventDefault());
    _canvas.addEventListener('dblclick', _onDblClick);
    _canvas.addEventListener('wheel', _onWheel, { passive: false });

    window.addEventListener('resize', () => {
      if (_isOpen) _resizeCanvas();
    });
    window.addEventListener('keydown', _onKeyDown);
    window.addEventListener('keyup', _onKeyUp);
  }

  function _ensureToolbar() {
    if (!_toolsContainer) return;
    const required = [
      ['select', 'Select/Move', 'studio.selectMove'],
      ['rectangle', 'Rectangle', 'studio.rectangle'],
      ['ellipse', 'Ellipse', 'studio.ellipse'],
      ['arrow', 'Arrow', 'studio.arrow'],
      ['line', 'Line', 'studio.line'],
      ['text', 'Text', 'studio.text'],
      ['distance', 'Distance', 'studio.distance'],
      ['angle', 'Angle', 'studio.angle'],
      ['scalebar', 'Scale Bar', 'studio.scalebar']
    ];
    _toolsContainer.innerHTML = required.map(([tool, title, i18nKey], index) => `
      <button class="btn btn-ghost btn-sm ${index === 0 ? 'active' : ''}" data-studio-tool="${tool}" title="${title}" data-i18n-title="${i18nKey}">
        <i data-lucide="${TOOL_ICONS[tool]}"></i>
      </button>
    `).join('');

    if (typeof I18n !== 'undefined' && I18n.translateDOM) I18n.translateDOM();
    const header = document.querySelector('.studio-header-right');
    if (header && !document.getElementById('studio-undo')) {
      header.insertAdjacentHTML('afterbegin', `
        <button class="btn btn-icon btn-ghost" id="studio-command-palette-button" title="Command Palette" data-i18n-title="js.cmdPalette"><i data-lucide="command"></i></button>
        <button class="btn btn-icon btn-ghost" id="studio-undo" title="Undo" data-i18n-title="js.undo"><i data-lucide="undo-2"></i></button>
        <button class="btn btn-icon btn-ghost" id="studio-redo" title="Redo" data-i18n-title="js.redo"><i data-lucide="redo-2"></i></button>
        <div id="studio-rotation-control" style="display: flex; align-items: center; gap: 8px;">
          <button type="button" class="btn btn-icon btn-ghost btn-sm" id="studio-reset-rotation" title="Reset angle" data-i18n-title="js.resetAngle" style="width: 28px; min-width: 28px; height: 28px; padding: 0; flex-shrink: 0; cursor: pointer; pointer-events: auto;">
            <i data-lucide="rotate-ccw"></i>
          </button>
          <input type="range" id="studio-rotation-slider" min="-180" max="180" step="1" value="0" style="flex: 0 0 148px; min-width: 148px;">
          <span class="text-xs font-mono" id="studio-rotation-val" style="width: 68px; min-width: 68px; text-align: right; display: inline-block; flex-shrink: 0;">0 deg</span>
        </div>
      `);
      document.getElementById('studio-undo')?.addEventListener('click', _undo);
      document.getElementById('studio-redo')?.addEventListener('click', _redo);
      document.getElementById('studio-command-palette-button')?.addEventListener('click', _openPalette);
      document.getElementById('studio-reset-rotation')?.addEventListener('click', () => {
        if (!_doc) return;
        _doc.viewport.rotation = 0;
        const slider = document.getElementById('studio-rotation-slider');
        if (slider) slider.value = 0;
        document.getElementById('studio-rotation-val').textContent = '0 deg';
        _viewportChanged();
      });
      document.getElementById('studio-rotation-slider')?.addEventListener('input', (event) => {
        if (!_doc) return;
        _doc.viewport.rotation = (Number(event.target.value) || 0) * Math.PI / 180;
        document.getElementById('studio-rotation-val').textContent = `${event.target.value} deg`;
        _viewportChanged(true);
      });
    }
    if (window.lucide) lucide.createIcons();
  }

  function _ensureCommandPalette() {
    if (document.getElementById('studio-command-palette')) {
      _palette = document.getElementById('studio-command-palette');
      return;
    }
    _palette = document.createElement('div');
    _palette.id = 'studio-command-palette';
    _palette.className = 'studio-command-palette hidden';
    _palette.innerHTML = `
      <div class="studio-command-dialog">
        <input id="studio-command-input" class="form-input" placeholder="Type a command">
        <div id="studio-command-list" class="studio-command-list"></div>
      </div>
    `;
    document.body.appendChild(_palette);
    _palette.addEventListener('click', (event) => {
      if (event.target === _palette) _closePalette();
      const item = event.target.closest('[data-command]');
      if (item) _runCommand(item.dataset.command);
    });
    document.getElementById('studio-command-input')?.addEventListener('input', _renderPaletteCommands);
  }

  function _ensureMinimap() {
    if (!_workspace || document.getElementById('studio-minimap')) return;
    _minimap = document.createElement('canvas');
    _minimap.id = 'studio-minimap';
    _minimap.width = 180;
    _minimap.height = 120;
    _workspace.appendChild(_minimap);
  }

  function _resizeCanvas() {
    if (!_canvas) return;
    const parent = _canvas.parentElement;
    const rect = parent?.getBoundingClientRect();
    _canvas.width = Math.max(1, Math.floor(rect?.width || window.innerWidth));
    _canvas.height = Math.max(1, Math.floor(rect?.height || window.innerHeight));
    _viewportChanged();
  }

  function _fitImageToViewport() {
    if (!_doc || !_sliceImage || !_canvas) return;
    const margin = 80;
    const scale = Math.min(
      (_canvas.width - margin) / Math.max(1, _sliceImage.width),
      (_canvas.height - margin) / Math.max(1, _sliceImage.height)
    );
    _doc.viewport.zoom = Math.max(0.02, Math.min(12, scale));
    _doc.viewport.panX = _canvas.width / 2;
    _doc.viewport.panY = _canvas.height / 2;
    _doc.viewport.rotation = 0;
    const slider = document.getElementById('studio-rotation-slider');
    const label = document.getElementById('studio-rotation-val');
    if (slider) slider.value = 0;
    if (label) label.textContent = '0 deg';
  }

  function _renderAll() {
    _draw();
    _renderLayers();
    _renderProperties();
    _renderChannels();
    _syncToolButtons();
    _renderCompareMenus();
    if (window.lucide) lucide.createIcons();
  }

  function _activePanelIndex() {
    return Math.max(0, Math.min(_activeStudioPanelIndex, (_doc?.layoutMaps?.length || 1) - 1));
  }

  // The per-cell buttons are absolutely positioned from the viewport transform, so
  // every change of that transform has to move them. `defer` (a pointer or wheel
  // stream) draws once per animation frame instead of once per event.
  function _viewportChanged(defer = false) {
    if (defer) {
      _requestDraw({ menus: true });
      return;
    }
    _draw();
    if (_doc?.layoutMaps?.length > 1) _positionCompareMenus();
  }

  // ── Coalesced redraws ─────────────────────────────────────
  // Pointer and wheel events arrive faster than the screen refreshes (up to 1 kHz on
  // some mice): they ask for a draw, and one draw per animation frame serves them all.
  // A timer backstops the frame, which a hidden page never runs.
  const DRAW_BACKSTOP_MS = 64;
  const _drawRequest = { raf: 0, timer: 0, dirty: false, menus: false };

  function _requestDraw(options = {}) {
    const r = _drawRequest;
    r.dirty = true;
    if (options.menus) r.menus = true;
    if (r.raf || r.timer) return;
    if (typeof requestAnimationFrame === 'function') r.raf = requestAnimationFrame(_flushDraw);
    r.timer = setTimeout(_flushDraw, DRAW_BACKSTOP_MS);
  }

  function _flushDraw() {
    const { dirty, menus } = _drawRequest;
    _cancelDrawRequest();
    if (dirty) _draw();
    if (menus && _doc?.layoutMaps?.length > 1) _positionCompareMenus();
  }

  function _cancelDrawRequest() {
    const r = _drawRequest;
    if (r.raf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(r.raf);
    if (r.timer) clearTimeout(r.timer);
    r.raf = 0;
    r.timer = 0;
    r.dirty = false;
    r.menus = false;
  }

  function _removeCompareMenus() {
    _compareMenuButtons.forEach(btn => btn.remove?.());
    _compareMenuButtons = [];
  }

  // One button per cell, made when the document gets its cells; afterwards only its
  // place and its active colour change.
  function _renderCompareMenus() {
    if (!_doc || !_doc.layoutMaps || _doc.layoutMaps.length <= 1) {
      _removeCompareMenus();
      return;
    }
    const workspace = document.getElementById('studio-workspace');
    if (!workspace) return;
    if (_compareMenuButtons.length !== _doc.layoutMaps.length || _compareMenuButtons.some(btn => btn.parentElement && btn.parentElement !== workspace)) {
      _removeCompareMenus();
      _compareMenuButtons = _doc.layoutMaps.map((_, index) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'studio-compare-menu btn btn-icon btn-sm shadow-md transition-all';
        btn.style.position = 'absolute';
        btn.style.zIndex = '100';
        btn.style.border = '1px solid rgba(255,255,255,0.15)';
        btn.style.borderRadius = '6px';
        btn.innerHTML = '<i data-lucide="sliders-horizontal"></i>';
        btn.title = _t('studio.panelChannels', `Panel ${index + 1} channels`, { n: index + 1 });
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          _activeStudioPanelIndex = index;
          _channelEditRun = null;
          _renderChannels();
          _positionCompareMenus();
        });
        workspace.appendChild(btn);
        return btn;
      });
      if (window.lucide) lucide.createIcons();
    }
    _positionCompareMenus();
  }

  function _positionCompareMenus() {
    if (!_doc?.layoutMaps || _compareMenuButtons.length !== _doc.layoutMaps.length || !_sliceImage) return;
    const workspace = document.getElementById('studio-workspace');
    if (!workspace) return;
    const activeIndex = _activePanelIndex();
    const canvasRect = _canvas.getBoundingClientRect();
    const workspaceRect = workspace.getBoundingClientRect();
    const offsetX = canvasRect.left - workspaceRect.left;
    const offsetY = canvasRect.top - workspaceRect.top;
    _doc.layoutMaps.forEach((map, index) => {
      const btn = _compareMenuButtons[index];
      // At the bottom-right corner of the cell.
      const screenPt = _imageToScreen({ x: map.x + map.w, y: map.y + map.h });
      btn.style.left = `${offsetX + screenPt.x - 36}px`;
      btn.style.top = `${offsetY + screenPt.y - 36}px`;
      btn.style.background = index === activeIndex ? 'var(--color-primary, #3b82f6)' : 'var(--bg-surface, #1e1e2e)';
      btn.style.color = index === activeIndex ? '#fff' : 'var(--text-muted, #888)';
    });
  }

  function _draw() {
    _drawRequest.dirty = false;
    if (!_ctx || !_canvas || !_doc || !_sliceImage) return;
    const { viewport } = _doc;
    _ctx.setTransform(1, 0, 0, 1, 0, 0);
    _ctx.clearRect(0, 0, _canvas.width, _canvas.height);
    _drawWorkspaceGrid();
    _ctx.save();
    _applyImageTransform(_ctx, viewport);
    // The slicer discards empty voxels, so the slice canvas is transparent outside
    // the specimen and the workspace grid used to show through it. Lay down the same
    // opaque backdrop the exporter composites on (_composeExportCanvas), so what is
    // edited matches what is exported.
    _ctx.fillStyle = EXPORT_BACKGROUND;
    _ctx.fillRect(0, 0, _sliceImage.width, _sliceImage.height);
    _ctx.drawImage(_sliceImage, 0, 0);
    _doc.guides.forEach(guide => _drawGuide(_ctx, guide));
    _doc.layers.forEach(layer => {
      if (layer.visible === false) return;
      _drawLayer(_ctx, layer, 1);
    });
    if (_drawing) _drawDraft(_ctx);
    _drawSelection(_ctx);
    _ctx.restore();
    _drawRulers();
    _drawMinimap();
  }

  function _drawWorkspaceGrid() {
    const step = 32;
    _ctx.save();
    _ctx.fillStyle = '#050607';
    _ctx.fillRect(0, 0, _canvas.width, _canvas.height);
    _ctx.strokeStyle = 'rgba(255,255,255,0.045)';
    _ctx.lineWidth = 1;
    for (let x = 0; x < _canvas.width; x += step) {
      _ctx.beginPath();
      _ctx.moveTo(x, 0);
      _ctx.lineTo(x, _canvas.height);
      _ctx.stroke();
    }
    for (let y = 0; y < _canvas.height; y += step) {
      _ctx.beginPath();
      _ctx.moveTo(0, y);
      _ctx.lineTo(_canvas.width, y);
      _ctx.stroke();
    }
    _ctx.restore();
  }

  function _drawRulers() {
    const h = 24;
    _ctx.save();
    _ctx.setTransform(1, 0, 0, 1, 0, 0);
    _ctx.fillStyle = 'rgba(12,14,18,0.92)';
    _ctx.fillRect(0, 0, _canvas.width, h);
    _ctx.fillRect(0, 0, h, _canvas.height);
    _ctx.strokeStyle = 'rgba(255,255,255,0.14)';
    _ctx.font = '10px Inter, Arial, sans-serif';
    _ctx.fillStyle = 'rgba(255,255,255,0.62)';
    const step = _niceStep(80 / Math.max(0.001, _doc.viewport.zoom));
    for (let x = 0; x < _doc.sourceSlice.width; x += step) {
      const p = _imageToScreen({ x, y: 0 });
      if (p.x < h || p.x > _canvas.width) continue;
      _ctx.beginPath();
      _ctx.moveTo(p.x, h - 8);
      _ctx.lineTo(p.x, h);
      _ctx.stroke();
      _ctx.fillText(String(Math.round(x)), p.x + 3, 14);
    }
    for (let y = 0; y < _doc.sourceSlice.height; y += step) {
      const p = _imageToScreen({ x: 0, y });
      if (p.y < h || p.y > _canvas.height) continue;
      _ctx.beginPath();
      _ctx.moveTo(h - 8, p.y);
      _ctx.lineTo(h, p.y);
      _ctx.stroke();
      _ctx.save();
      _ctx.translate(14, p.y - 3);
      _ctx.rotate(-Math.PI / 2);
      _ctx.fillText(String(Math.round(y)), 0, 0);
      _ctx.restore();
    }
    _ctx.restore();
  }

  // The picture scaled down to the minimap, made once per picture: drawing the
  // native-size canvas into 180 × 120 px on every redraw is a full-resolution
  // resample per pointer move.
  function _minimapThumbnail(iw, ih) {
    const t = _minimapThumb;
    const w = Math.max(1, Math.round(iw));
    const h = Math.max(1, Math.round(ih));
    if (t.canvas && t.image === _sliceImage && t.version === _pictureVersion && t.w === w && t.h === h) return t.canvas;
    if (!t.canvas) t.canvas = document.createElement('canvas');
    const c = t.canvas;
    if (c.width !== w) c.width = w;
    if (c.height !== h) c.height = h;
    const ctx = c.getContext('2d');
    if (!ctx) return _sliceImage;
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(_sliceImage, 0, 0, w, h);
    t.image = _sliceImage;
    t.version = _pictureVersion;
    t.w = w;
    t.h = h;
    return c;
  }

  function _releaseMinimapThumb() {
    const t = _minimapThumb;
    if (t.canvas) {
      t.canvas.width = 0;
      t.canvas.height = 0;
    }
    t.canvas = null;
    t.image = null;
    t.version = -1;
  }

  function _drawMinimap() {
    if (!_minimap || !_doc || !_sliceImage) return;
    const ctx = _minimap.getContext('2d');
    const w = _minimap.width;
    const h = _minimap.height;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#050607';
    ctx.fillRect(0, 0, w, h);
    const scale = Math.min(w / _sliceImage.width, h / _sliceImage.height);
    const iw = _sliceImage.width * scale;
    const ih = _sliceImage.height * scale;
    const ix = (w - iw) / 2;
    const iy = (h - ih) / 2;
    ctx.globalAlpha = 0.82;
    ctx.drawImage(_minimapThumbnail(iw, ih), ix, iy, iw, ih);
    ctx.globalAlpha = 1;
    ctx.strokeStyle = '#00d2ff';
    ctx.lineWidth = 1;
    _doc.layers.forEach(layer => {
      if (layer.visible === false) return;
      const box = _layerBounds(layer);
      ctx.strokeRect(ix + box.x * scale, iy + box.y * scale, Math.max(2, box.w * scale), Math.max(2, box.h * scale));
    });
  }

  function _applyImageTransform(ctx, viewport = _doc.viewport) {
    ctx.translate(viewport.panX, viewport.panY);
    ctx.rotate(viewport.rotation);
    ctx.scale(viewport.zoom, viewport.zoom);
    ctx.translate(-_sliceImage.width / 2, -_sliceImage.height / 2);
  }

  function _drawLayer(ctx, layer, scale = 1) {
    const style = layer.style || {};
    ctx.save();
    ctx.globalAlpha = style.opacity ?? 1;
    ctx.strokeStyle = style.stroke || '#ff4d4f';
    ctx.fillStyle = style.fill || style.stroke || '#ff4d4f';
    ctx.lineWidth = Math.max(1, (style.strokeWidth || 3) * scale);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    // A text box is its measured text, and a box turns about its centre: measure first.
    if (layer.type === 'text') _measureTextLayer(ctx, layer);
    _applyLayerRotation(ctx, layer);

    if (layer.type === 'rectangle') {
      ctx.strokeRect(layer.x, layer.y, layer.w, layer.h);
      if (style.fillEnabled) {
        ctx.globalAlpha *= 0.16;
        ctx.fillRect(layer.x, layer.y, layer.w, layer.h);
      }
    } else if (layer.type === 'ellipse') {
      ctx.beginPath();
      ctx.ellipse(layer.x + layer.w / 2, layer.y + layer.h / 2, Math.abs(layer.w / 2), Math.abs(layer.h / 2), 0, 0, Math.PI * 2);
      ctx.stroke();
      if (style.fillEnabled) {
        ctx.globalAlpha *= 0.16;
        ctx.fill();
      }
    } else if (['line', 'arrow', 'distance', 'scalebar'].includes(layer.type)) {
      const p = _linePoints(layer);
      ctx.beginPath();
      ctx.moveTo(p.x1, p.y1);
      ctx.lineTo(p.x2, p.y2);
      ctx.stroke();
      _drawEndCap(ctx, p.x1, p.y1, p.x2, p.y2, style.startCap || (layer.type === 'scalebar' ? 'bar' : 'none'), style.strokeWidth || 3, true);
      _drawEndCap(ctx, p.x1, p.y1, p.x2, p.y2, style.endCap || (layer.type === 'arrow' ? 'arrow' : layer.type === 'scalebar' ? 'bar' : 'none'), style.strokeWidth || 3, false);
      if (layer.type === 'distance' || layer.type === 'scalebar') _drawLineLabel(ctx, layer, p);
    } else if (layer.type === 'angle') {
      ctx.beginPath();
      ctx.moveTo(layer.x2, layer.y2);
      ctx.lineTo(layer.x1, layer.y1);
      ctx.lineTo(layer.x3, layer.y3);
      ctx.stroke();
      _drawAngleArc(ctx, layer);
    } else if (layer.type === 'text') {
      ctx.textBaseline = 'top';
      ctx.textAlign = 'left';
      // The pad is symmetric about the box, so the background turns about the same
      // centre as the text.
      if (style.textBackground !== false) {
        ctx.fillStyle = 'rgba(0,0,0,0.55)';
        ctx.fillRect(layer.x - TEXT_PAD, layer.y - TEXT_PAD, layer.w + TEXT_PAD * 2, layer.h + TEXT_PAD * 2);
      }
      ctx.fillStyle = style.stroke || '#ffffff';
      ctx.fillText(layer.text || '', layer.x, layer.y);
    }
    ctx.restore();
  }

  // Sets the font and writes the measured box into the layer (w = text width, h = font
  // size). When the words or the font change on a turned label, the box regrows from
  // its turned top-left corner — where the first glyph sits — instead of sliding the
  // whole label along the image axes.
  function _measureTextLayer(ctx, layer) {
    const style = layer.style || {};
    ctx.font = `${style.fontWeight || 700} ${style.fontSize || 18}px Inter, Arial, sans-serif`;
    const w = Math.max(20, ctx.measureText(layer.text || '').width);
    const h = style.fontSize || 18;
    if (w === layer.w && h === layer.h) return;
    const rad = _layerRotationRad(layer);
    if (rad && Number.isFinite(layer.x) && Number.isFinite(layer.y) && Number.isFinite(layer.w) && Number.isFinite(layer.h)) {
      const box = _regrowRotatedBox({ x: layer.x, y: layer.y, w: layer.w, h: layer.h }, rad, w, h);
      layer.x = box.x;
      layer.y = box.y;
    }
    layer.w = w;
    layer.h = h;
  }

  // ctx.rotate about the box centre: T(c)·R(θ)·T(−c), the same turn _layerContains
  // undoes and _rotatedBoxCorners reproduces.
  function _applyLayerRotation(ctx, layer) {
    if (!_isBoxLayer(layer)) return;
    const rad = _layerRotationRad(layer);
    if (!rad) return;
    const c = _boxCentre(_layerBox(layer));
    ctx.translate(c.x, c.y);
    ctx.rotate(rad);
    ctx.translate(-c.x, -c.y);
  }

  function _drawEndCap(ctx, x1, y1, x2, y2, cap, width, atStart) {
    if (cap === 'none') return;
    const from = atStart ? { x: x2, y: y2 } : { x: x1, y: y1 };
    const to = atStart ? { x: x1, y: y1 } : { x: x2, y: y2 };
    const angle = Math.atan2(to.y - from.y, to.x - from.x);
    const size = Math.max(7, width * 4);
    if (cap === 'arrow') {
      ctx.beginPath();
      ctx.moveTo(to.x, to.y);
      ctx.lineTo(to.x - size * Math.cos(angle - Math.PI / 6), to.y - size * Math.sin(angle - Math.PI / 6));
      ctx.lineTo(to.x - size * Math.cos(angle + Math.PI / 6), to.y - size * Math.sin(angle + Math.PI / 6));
      ctx.closePath();
      ctx.fill();
    } else if (cap === 'bar' || cap === 'flat') {
      const p = angle + Math.PI / 2;
      ctx.beginPath();
      ctx.moveTo(to.x - Math.cos(p) * size * 0.65, to.y - Math.sin(p) * size * 0.65);
      ctx.lineTo(to.x + Math.cos(p) * size * 0.65, to.y + Math.sin(p) * size * 0.65);
      ctx.stroke();
    } else if (cap === 'dot') {
      ctx.beginPath();
      ctx.arc(to.x, to.y, Math.max(4, width * 1.6), 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function _drawLineLabel(ctx, layer, p) {
    const style = layer.style || {};
    const label = _measurementLabel(layer);
    if (!label) return;
    const fontSize = style.fontSize || 14;
    const mx = (p.x1 + p.x2) / 2;
    const my = (p.y1 + p.y2) / 2;
    ctx.save();
    ctx.font = `700 ${fontSize}px Inter, Arial, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    const metrics = ctx.measureText(label);
    // The label stays upright and sits beside the segment on its upper side, whatever
    // the segment's direction u. With n the unit normal to u pointing up (n.y ≤ 0), a
    // W×H box centred at mid + n·D clears the line when D ≥ |n.x|·W/2 + |n.y|·H/2 + gap;
    // for a horizontal segment that is the historical placement, 4 px above the line.
    const bw = metrics.width + 12;
    const bh = fontSize + 8;
    const len = Math.hypot(p.x2 - p.x1, p.y2 - p.y1);
    const ux = len > 0 ? (p.x2 - p.x1) / len : 1;
    const uy = len > 0 ? (p.y2 - p.y1) / len : 0;
    let nx = uy;
    let ny = -ux;
    if (ny > 0 || (ny === 0 && nx > 0)) {
      nx = -nx;
      ny = -ny;
    }
    const gap = Math.abs(nx) * bw / 2 + Math.abs(ny) * bh / 2 + 4;
    const cx = mx + nx * gap;
    const cy = my + ny * gap;
    ctx.fillStyle = 'rgba(0,0,0,0.58)';
    ctx.fillRect(cx - bw / 2, cy - bh / 2, bw, bh);
    ctx.fillStyle = style.stroke || '#ffffff';
    ctx.fillText(label, cx, cy + bh / 2 - 3);
    ctx.restore();
  }

  function _drawAngleArc(ctx, layer) {
    const style = layer.style || {};
    const a1 = Math.atan2(layer.y2 - layer.y1, layer.x2 - layer.x1);
    const a2 = Math.atan2(layer.y3 - layer.y1, layer.x3 - layer.x1);
    const r = Math.max(18, Math.min(_dist(layer.x1, layer.y1, layer.x2, layer.y2), _dist(layer.x1, layer.y1, layer.x3, layer.y3)) * 0.35);
    ctx.beginPath();
    ctx.arc(layer.x1, layer.y1, r, a1, a2, false);
    ctx.stroke();
    const label = `${_angleDegrees(layer).toFixed(1)} deg`;
    const mid = a1 + _angleDelta(a1, a2) / 2;
    ctx.save();
    ctx.font = `700 ${style.fontSize || 14}px Inter, Arial, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = style.stroke || '#ffffff';
    ctx.fillText(label, layer.x1 + Math.cos(mid) * (r + 18), layer.y1 + Math.sin(mid) * (r + 18));
    ctx.restore();
  }

  function _drawGuide(ctx, guide) {
    ctx.save();
    ctx.strokeStyle = 'rgba(0,210,255,0.5)';
    ctx.lineWidth = 1 / Math.max(0.001, _doc.viewport.zoom);
    ctx.setLineDash([6 / _doc.viewport.zoom, 6 / _doc.viewport.zoom]);
    ctx.beginPath();
    if (guide.axis === 'x') {
      ctx.moveTo(guide.value, 0);
      ctx.lineTo(guide.value, _doc.sourceSlice.height);
    } else {
      ctx.moveTo(0, guide.value);
      ctx.lineTo(_doc.sourceSlice.width, guide.value);
    }
    ctx.stroke();
    ctx.restore();
  }

  function _drawDraft(ctx) {
    if (!_drawing || _drawing.mode) return;
    ctx.save();
    ctx.strokeStyle = '#ffffff';
    ctx.fillStyle = '#ffffff';
    ctx.lineWidth = Math.max(1, 2 / Math.max(0.001, _doc.viewport.zoom));
    ctx.setLineDash([6 / _doc.viewport.zoom, 6 / _doc.viewport.zoom]);
    if (_drawing.type === 'angle') {
      const points = _drawing.points || [];
      if (points.length >= 1 && _drawing.current) {
        const [a, b] = points;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        if (b) {
          ctx.lineTo(b.x, b.y);
          ctx.moveTo(a.x, a.y);
        }
        ctx.lineTo(_drawing.current.x, _drawing.current.y);
        ctx.stroke();
      }
    } else if (['rectangle', 'ellipse'].includes(_drawing.type)) {
      const box = _boxFromPoints(_drawing.start, _drawing.current);
      if (_drawing.type === 'rectangle') ctx.strokeRect(box.x, box.y, box.w, box.h);
      else {
        ctx.beginPath();
        ctx.ellipse(box.x + box.w / 2, box.y + box.h / 2, Math.abs(box.w / 2), Math.abs(box.h / 2), 0, 0, Math.PI * 2);
        ctx.stroke();
      }
    } else {
      ctx.beginPath();
      ctx.moveTo(_drawing.start.x, _drawing.start.y);
      ctx.lineTo(_drawing.current.x, _drawing.current.y);
      ctx.stroke();
    }
    ctx.restore();
  }

  function _drawSelection(ctx) {
    const layer = _selectedLayer();
    if (!layer || layer.visible === false) return;
    const handles = _handlesForLayer(layer);
    const zoom = Math.max(0.001, _doc.viewport.zoom);
    // A turned box is outlined as itself (its handles turn with it); a point layer, whose
    // rotation is already in its points, by its bounds.
    const boxRad = _isBoxLayer(layer) ? _layerRotationRad(layer) : 0;
    ctx.save();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = Math.max(1, 1.5 / zoom);
    ctx.setLineDash([5 / zoom, 5 / zoom]);
    if (boxRad) {
      const corners = Object.fromEntries(_rotatedBoxCorners(_layerBox(layer), boxRad).map(c => [c.id, c]));
      ctx.beginPath();
      ['nw', 'ne', 'se', 'sw'].forEach((id, i) => {
        if (i === 0) ctx.moveTo(corners[id].x, corners[id].y);
        else ctx.lineTo(corners[id].x, corners[id].y);
      });
      ctx.closePath();
      ctx.stroke();
    } else {
      const box = _layerBounds(layer);
      ctx.strokeRect(box.x, box.y, box.w, box.h);
    }
    ctx.setLineDash([]);
    const s = 6 / zoom;
    handles.forEach(handle => {
      ctx.save();
      ctx.translate(handle.x, handle.y);
      if (boxRad) ctx.rotate(boxRad);
      ctx.fillStyle = handle.id === _hoverHandle ? '#00d2ff' : '#ffffff';
      ctx.fillRect(-s / 2, -s / 2, s, s);
      ctx.strokeStyle = '#050607';
      ctx.strokeRect(-s / 2, -s / 2, s, s);
      ctx.restore();
    });
    if (layer.locked !== true) {
      const knob = _rotationHandle(layer);
      ctx.beginPath();
      ctx.moveTo(knob.baseX, knob.baseY);
      ctx.lineTo(knob.x, knob.y);
      ctx.strokeStyle = '#ffffff';
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(knob.x, knob.y, ROTATE_HANDLE_RADIUS / zoom, 0, Math.PI * 2);
      ctx.fillStyle = _hoverHandle === 'rotate' ? '#00d2ff' : '#ffffff';
      ctx.fill();
      ctx.strokeStyle = '#050607';
      ctx.stroke();
    }
    ctx.restore();
  }

  // ── Two-finger navigation (touch) ───────────────────────────────────────────
  // Here one finger DRAWS, so navigation belongs entirely to the second: two fingers
  // move and zoom the figure, and no gesture ever produces a mark.
  function _twoFingerFrame() {
    const [a, b] = [..._touchPointers.values()];
    const rect = _canvas.getBoundingClientRect();
    return {
      dist: Math.max(1e-3, Math.hypot(b.x - a.x, b.y - a.y)),
      midX: (a.x + b.x) / 2 - rect.left,
      midY: (a.y + b.y) / 2 - rect.top
    };
  }

  // Re-anchored whenever the finger count changes: the measured pair changes with it,
  // and a stale reference spacing would make the figure jump.
  function _seedViewGesture() {
    const f = _twoFingerFrame();
    _viewGesture = { startDist: f.dist, startZoom: _doc.viewport.zoom, midX: f.midX, midY: f.midY };
  }

  // A second finger means navigation, not annotation, so whatever the first one had
  // begun is closed out cleanly: a draft shape is dropped (it only becomes a layer on
  // release anyway), while an edit already written into a layer is committed so it
  // stays undoable instead of being silently reverted. A multi-click angle in progress
  // is left alone — it already survives pointer releases by design.
  function _abandonPointerAction() {
    _isRotating = false;
    _rotationStart = null;
    _isPanning = false;
    _pointerStart = null;
    _canvas.style.cursor = 'default';
    if (!_drawing || _drawing.type === 'angle') return;
    const wasEditingLayer = (_drawing.mode === 'move' || _drawing.mode === 'handle' || _drawing.mode === 'rotate')
      && _gestureChangedLayer(_drawing);
    _drawing = null;
    if (wasEditingLayer) {
      _pushHistory('Edit layer');
      _renderAll();
    } else {
      _draw();
    }
  }

  function _onPointerDown(event) {
    if (!_doc || !_sliceImage) return;
    if (event.pointerType !== 'mouse') _touchPointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (_touchPointers.size >= 2) {
      _abandonPointerAction();
      _seedViewGesture();
      return;
    }
    try {
      _canvas.setPointerCapture?.(event.pointerId);
    } catch {
      // Synthetic QA events and some tablet drivers do not expose a capturable pointer.
    }
    const imagePoint = _screenToImage(_eventCanvasPoint(event));
    if (event.altKey && _activeTool === 'select') {
      _isRotating = true;
      _rotationStart = {
        x: event.clientX,
        y: event.clientY,
        rotation: _doc.viewport.rotation
      };
      _canvas.style.cursor = 'grabbing';
      return;
    }
    // Before the pan test: Shift is both "pan" on an empty press and "snap to 15°" while
    // turning, and a press on the rotate handle means the latter.
    if (_activeTool === 'select' && event.button === 0 && !_spaceDown) {
      const selected = _selectedLayer();
      if (selected && _hitRotationHandle(selected, imagePoint)) {
        _beginLayerRotation(selected, imagePoint);
        return;
      }
    }
    if (event.button === 1 || event.button === 2 || event.shiftKey || _spaceDown) {
      _isPanning = true;
      _pointerStart = { x: event.clientX, y: event.clientY, panX: _doc.viewport.panX, panY: _doc.viewport.panY };
      _canvas.style.cursor = 'grabbing';
      return;
    }

    if (_activeTool === 'select') {
      const hit = _hitTest(imagePoint);
      if (hit?.handle === 'rotate') {
        const target = _doc.layers.find(item => item.id === hit.id);
        if (target) {
          _beginLayerRotation(target, imagePoint);
          return;
        }
      }
      _selectedId = hit?.id || null;
      _hoverHandle = hit?.handle || null;
      const layer = _selectedLayer();
      if (layer && layer.locked !== true) {
        _drawing = {
          mode: hit?.handle ? 'handle' : 'move',
          handle: hit?.handle || null,
          start: imagePoint,
          original: _clone(layer)
        };
      }
      _renderAll();
      return;
    }

    if (_activeTool === 'text') {
      event.preventDefault?.();
      _openTextEditor(imagePoint, _t('studio.textDefault', 'Annotation'), (text) => {
        if (!text || !_doc) return;
        _pushLayer(_newTextLayer(imagePoint, text));
        _setTool('select');
      });
      return;
    }

    if (_activeTool === 'angle') {
      if (!_drawing || _drawing.type !== 'angle') {
        _drawing = { type: 'angle', points: [imagePoint], current: imagePoint };
      } else {
        _drawing.points.push(imagePoint);
        _drawing.current = imagePoint;
        if (_drawing.points.length === 3) {
          const [a, b, c] = _drawing.points;
          _pushLayer(_newAngleLayer(a, b, c));
          _drawing = null;
          _setTool('select');
        }
      }
      _draw();
      return;
    }

    _drawing = {
      mode: 'draw',
      type: _activeTool,
      start: imagePoint,
      current: imagePoint
    };
  }

  function _onPointerMove(event) {
    if (!_doc || !_sliceImage) return;
    if (_touchPointers.has(event.pointerId)) _touchPointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (_viewGesture && _touchPointers.size >= 2) {
      const f = _twoFingerFrame();
      const v = _doc.viewport;
      const zoom = Math.max(0.02, Math.min(32, _viewGesture.startZoom * (f.dist / _viewGesture.startDist)));
      // The image point under the midpoint is invariant for the whole gesture — what
      // the fingers hold stays under them. From screen = R(rot)·(image − centre)·zoom
      // + pan, pinning that point gives pan' = mid' − (mid − pan)·(zoom'/zoom): pure
      // travel when the spacing holds, anchored zoom when it changes, exact when both
      // move at once. Rotation drops out of the equation, so a rotated figure is
      // handled without a special case (and the gesture never rotates by itself —
      // that stays on the slider, where a figure's framing belongs).
      const k = zoom / v.zoom;
      v.panX = f.midX - (_viewGesture.midX - v.panX) * k;
      v.panY = f.midY - (_viewGesture.midY - v.panY) * k;
      v.zoom = zoom;
      _viewGesture.midX = f.midX;
      _viewGesture.midY = f.midY;
      _viewportChanged(true);
      return;
    }
    if (_isRotating && _rotationStart) {
      const dx = event.clientX - _rotationStart.x;
      _doc.viewport.rotation = _rotationStart.rotation + (dx * 0.008);
      const slider = document.getElementById('studio-rotation-slider');
      const deg = Math.round((_doc.viewport.rotation * 180 / Math.PI));
      if (slider) slider.value = String(((deg + 540) % 360) - 180);
      const label = document.getElementById('studio-rotation-val');
      if (label) label.textContent = `${Math.round(_doc.viewport.rotation * 180 / Math.PI)} deg`;
      _viewportChanged(true);
      return;
    }
    if (_isPanning && _pointerStart) {
      _doc.viewport.panX = _pointerStart.panX + (event.clientX - _pointerStart.x);
      _doc.viewport.panY = _pointerStart.panY + (event.clientY - _pointerStart.y);
      _viewportChanged(true);
      return;
    }
    const imagePoint = _screenToImage(_eventCanvasPoint(event));
    if (!_drawing) {
      const hit = _hitTest(imagePoint);
      const previousHandle = _hoverHandle;
      _hoverHandle = hit?.handle || null;
      const hitLayer = hit ? _doc.layers.find(item => item.id === hit.id) : null;
      const cursor = hit?.handle === 'rotate' ? ROTATE_CURSOR
        : hit?.handle ? _resizeCursor(hitLayer, hit.handle)
          : hit ? 'move' : (_activeTool === 'select' ? 'default' : 'crosshair');
      if (_canvas.style.cursor !== cursor) _canvas.style.cursor = cursor;
      const hint = hit?.handle === 'rotate'
        ? _t('studio.rotateHandleHint', 'Drag to rotate. Shift: 15° steps. [ and ] turn by 15° (Shift: 1°).')
        : '';
      if (_canvas.title !== hint) _canvas.title = hint;
      // Hovering only changes which handle is lit: nothing to repaint otherwise.
      if (previousHandle !== _hoverHandle) _requestDraw();
      return;
    }
    if (_drawing.mode === 'rotate') {
      const layer = _selectedLayer();
      if (layer) {
        // Pointer angle about the fixed centre, relative to where the drag started:
        // the handle need not sit straight above the centre (an angle layer's centroid).
        const angle = Math.atan2(imagePoint.y - _drawing.centre.y, imagePoint.x - _drawing.centre.x);
        const turned = _layerRotationDeg(_drawing.original) + (angle - _drawing.startAngle) * 180 / Math.PI;
        const target = event.shiftKey ? _snapRotationDeg(turned, ROTATION_SNAP_DEG) : Math.round(turned * 10) / 10;
        _rotateLayerFromSnapshot(layer, _drawing.original, target);
      }
      _requestDraw();
      return;
    }
    if (_drawing.type === 'angle') {
      _drawing.current = imagePoint;
      _requestDraw();
      return;
    }
    if (_drawing.mode === 'move') {
      const layer = _selectedLayer();
      if (layer) {
        const dx = imagePoint.x - _drawing.start.x;
        const dy = imagePoint.y - _drawing.start.y;
        _moveLayerTo(layer, _drawing.original, dx, dy);
        _applySnapping(layer);
      }
      _requestDraw();
      return;
    }
    if (_drawing.mode === 'handle') {
      const layer = _selectedLayer();
      if (layer) {
        _applyHandle(layer, _drawing.handle, imagePoint, _drawing.original);
        _updateMeasurementText(layer);
      }
      _requestDraw();
      return;
    }
    _drawing.current = imagePoint;
    _requestDraw();
  }

  // Whether a move / handle gesture actually changed its layer: a plain click on a
  // layer selects it, and must neither add a history step nor drop the redo stack.
  function _gestureChangedLayer(drawing) {
    if (!drawing?.original) return true;
    const layer = _doc?.layers.find(item => item.id === drawing.original.id);
    if (!layer) return true;
    return JSON.stringify(layer) !== JSON.stringify(drawing.original);
  }

  function _resetPointerState() {
    _drawing = null;
    _isPanning = false;
    _isRotating = false;
    _pointerStart = null;
    _rotationStart = null;
    _viewGesture = null;
    _touchPointers.clear();
    _spaceDown = false;
    _hoverHandle = null;
  }

  function _onPointerUp(event) {
    if (event && event.pointerId !== undefined) _touchPointers.delete(event.pointerId);
    if (_viewGesture) {
      // Down to one finger ends the gesture, and that finger stays inert until it is
      // lifted: handing it back to the active tool would draw something the user only
      // meant as navigation. A third finger lifting just re-anchors on the pair left.
      if (_touchPointers.size >= 2) { _seedViewGesture(); return; }
      _viewGesture = null;
      return;
    }
    if (_isRotating) {
      _isRotating = false;
      _rotationStart = null;
      _canvas.style.cursor = 'default';
      return;
    }
    if (_isPanning) {
      _isPanning = false;
      _pointerStart = null;
      _canvas.style.cursor = 'default';
      return;
    }
    if (!_drawing || _drawing.type === 'angle') return;
    if (_drawing.mode === 'rotate') {
      const layer = _selectedLayer();
      const turned = layer && _layerRotationDeg(layer) !== _layerRotationDeg(_drawing.original);
      _drawing = null;
      if (turned) _pushHistory('Rotate layer');
      _renderAll();
      return;
    }
    if (_drawing.mode === 'move' || _drawing.mode === 'handle') {
      const changed = _gestureChangedLayer(_drawing);
      _drawing = null;
      if (changed) _pushHistory('Edit layer');
      _renderAll();
      return;
    }
    const layer = _layerFromDraft(_drawing);
    _drawing = null;
    if (layer) {
      _pushLayer(layer);
      _setTool('select');
    } else {
      _draw();
    }
  }

  function _onPointerLeave() {
    if (_isRotating) {
      _isRotating = false;
      _rotationStart = null;
    }
    if (!_isPanning) return;
    _isPanning = false;
    _pointerStart = null;
  }

  function _onWheel(event) {
    if (!_doc) return;
    event.preventDefault();
    // The image point under the cursor P stays under it. With
    //   screen = pan + R(rot)·zoom·(image − centre),
    // holding that point fixed across zoom z₀ → z₁ gives pan' = P − (P − pan)·(z₁/z₀):
    // the rotation cancels out (the two-finger gesture uses the same relation).
    const p = _eventCanvasPoint(event);
    const v = _doc.viewport;
    const zoom = v.zoom;
    const factor = event.deltaY > 0 ? 0.9 : 1.1;
    v.zoom = Math.max(0.02, Math.min(32, zoom * factor));
    const k = v.zoom / zoom;
    v.panX = p.x - (p.x - v.panX) * k;
    v.panY = p.y - (p.y - v.panY) * k;
    _viewportChanged(true);
  }

  function _onDblClick(event) {
    const point = _screenToImage(_eventCanvasPoint(event));
    const hit = _hitTest(point);
    if (!hit || hit.handle === 'rotate') return;
    const layer = _doc.layers.find(item => item.id === hit.id);
    if (!layer || layer.locked) return;
    if (layer.type === 'text') {
      _openTextEditor({ x: layer.x, y: layer.y }, layer.text || '', (text) => {
        const target = _doc?.layers.find(item => item.id === layer.id);
        if (!target || text === (target.text || '')) return;
        target.text = text;
        _pushHistory('Edit text');
        _renderAll();
      });
    }
  }

  // ── Inline text entry ─────────────────────────────────────
  // A text field laid over the canvas where the label goes, instead of window.prompt:
  // a prompt is refused inside some embedded frames and freezes the page while open.
  // Enter or leaving the field commits, Escape cancels.
  let _textEditor = null;

  function _openTextEditor(imagePoint, initial, onCommit) {
    _closeTextEditor(true);
    const host = _workspace || _canvas?.parentElement;
    if (!host || !_doc || !_sliceImage) return;
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'form-input studio-text-input';
    input.value = String(initial ?? '').slice(0, IMPORT_MAX_TEXT);
    input.maxLength = IMPORT_MAX_TEXT;
    input.setAttribute?.('aria-label', _t('studio.textPrompt', 'Text label'));
    const screen = _imageToScreen(imagePoint);
    const canvasRect = _canvas.getBoundingClientRect();
    const hostRect = host.getBoundingClientRect();
    input.style.position = 'absolute';
    input.style.left = `${Math.max(0, canvasRect.left - hostRect.left + screen.x)}px`;
    input.style.top = `${Math.max(0, canvasRect.top - hostRect.top + screen.y)}px`;
    input.style.zIndex = '120';
    input.style.minWidth = '180px';
    let done = false;
    const finish = (commit) => {
      if (done) return;
      done = true;
      if (_textEditor?.input === input) _textEditor = null;
      const value = input.value;
      input.remove?.();
      if (commit) onCommit(value);
    };
    input.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if (event.key === 'Enter') {
        event.preventDefault();
        finish(true);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        finish(false);
      }
    });
    input.addEventListener('keyup', event => event.stopPropagation());
    host.appendChild(input);
    _textEditor = { input, finish };
    // Focused once the pointer event that asked for it is over: its default action
    // would otherwise move the focus back off the field (and commit it at once).
    setTimeout(() => {
      if (done) return;
      input.focus?.();
      input.select?.();
      input.addEventListener('blur', () => finish(true));
    }, 0);
  }

  function _closeTextEditor(commit) {
    _textEditor?.finish(commit);
    _textEditor = null;
  }

  function _onKeyDown(event) {
    if (!_isOpen || event.target?.matches('input, textarea, select')) return;
    if (event.key === ' ') {
      _spaceDown = true;
      event.preventDefault();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      _openPalette();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      if (event.shiftKey) _redo();
      else _undo();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y') {
      event.preventDefault();
      _redo();
      return;
    }
    if (event.key === 'Delete' || event.key === 'Backspace') {
      _deleteSelected();
      return;
    }
    // [ / ] turn the selection by 15°, with Shift by 1°. Shift+[ types '{' on most
    // layouts; AltGr (Ctrl+Alt on Windows) is how an AZERTY keyboard types '[' at all,
    // so only a bare Ctrl/Cmd is left to the browser.
    const rotateSign = { '[': -1, '{': -1, ']': 1, '}': 1 }[event.key];
    if (rotateSign && !((event.ctrlKey || event.metaKey) && !event.altKey)) {
      // A pointer gesture in progress owns the layer: its moves are recomputed from the
      // layer as the gesture found it (_drawing.original), which a key turn would not
      // update — the turn would be undone by the next move, or throw a handle off.
      // A pending angle draft (clicks between releases, no `mode`) is not a gesture.
      if (_drawing?.mode || _isPanning || _isRotating || _viewGesture) return;
      const fine = event.shiftKey || event.key === '{' || event.key === '}';
      if (_rotateSelectedBy(rotateSign * (fine ? 1 : ROTATION_SNAP_DEG), event.repeat)) event.preventDefault();
      return;
    }
    // A tool letter alone: Ctrl+R, Ctrl+D, Alt+… belong to the browser and the system.
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const tool = TOOL_KEYS[String(event.key || '').toLowerCase()];
    if (tool) _setTool(tool);
  }

  function _onKeyUp(event) {
    if (event.key === ' ') _spaceDown = false;
    if (event.key === 'Escape') {
      // Escape during a drag puts the layer back as it was when the drag began: the
      // gesture never reached the history, so leaving it half-applied would make the
      // next undo jump over it.
      const editing = _drawing && ['move', 'handle', 'rotate'].includes(_drawing.mode) ? _drawing : null;
      if (editing?.original && _doc) {
        const index = _doc.layers.findIndex(layer => layer.id === editing.original.id);
        if (index >= 0) _doc.layers[index] = _clone(editing.original);
      }
      _drawing = null;
      _closePalette();
      _draw();
      if (editing) _renderProperties();
    }
  }

  function _renderLayers() {
    if (!_layersContainer || !_doc) return;
    if (!_doc.layers.length) {
      _layersContainer.innerHTML = '<div class="studio-empty">No layers yet.</div>';
      return;
    }
    _layersContainer.innerHTML = [..._doc.layers].reverse().map(layer => `
      <div class="studio-layer-item ${layer.id === _selectedId ? 'active' : ''} ${layer.locked ? 'is-locked' : ''}" draggable="true" data-layer-id="${layer.id}">
        <i data-lucide="grip-vertical" class="icon"></i>
        <i data-lucide="${TOOL_ICONS[layer.type] || 'box'}" class="icon"></i>
        <span class="studio-layer-name">${_escape(layer.name || _layerName(layer))}</span>
        <button class="btn btn-icon btn-ghost btn-sm" data-layer-action="visible" title="Toggle visibility" data-i18n-title="js.toggleVis"><i data-lucide="${layer.visible === false ? 'eye-off' : 'eye'}"></i></button>
        <button class="btn btn-icon btn-ghost btn-sm" data-layer-action="lock" title="Toggle lock" data-i18n-title="js.toggleLock"><i data-lucide="${layer.locked ? 'lock' : 'unlock'}"></i></button>
      </div>
    `).join('');
    _layersContainer.querySelectorAll('.studio-layer-item').forEach(item => _bindLayerItem(item));
    if (window.lucide) lucide.createIcons({ nodes: [_layersContainer] });
  }

  function _bindLayerItem(item) {
    const layerId = item.dataset.layerId;
    item.addEventListener('click', (event) => {
      const action = event.target.closest('[data-layer-action]')?.dataset.layerAction;
      const layer = _doc.layers.find(row => row.id === layerId);
      if (!layer) return;
      if (action === 'visible') {
        layer.visible = layer.visible === false;
        _pushHistory('Toggle visibility');
      } else if (action === 'lock') {
        layer.locked = !layer.locked;
        _pushHistory('Toggle lock');
      } else {
        _selectedId = layerId;
      }
      _renderAll();
    });
    item.addEventListener('dragstart', () => {
      _draggedLayerId = layerId;
      item.classList.add('is-dragging');
    });
    item.addEventListener('dragend', () => {
      _draggedLayerId = null;
      item.classList.remove('is-dragging');
    });
    item.addEventListener('dragover', event => event.preventDefault());
    item.addEventListener('drop', () => {
      if (!_draggedLayerId || _draggedLayerId === layerId) return;
      const from = _doc.layers.findIndex(layer => layer.id === _draggedLayerId);
      const to = _doc.layers.findIndex(layer => layer.id === layerId);
      if (from < 0 || to < 0) return;
      const [moved] = _doc.layers.splice(from, 1);
      _doc.layers.splice(to, 0, moved);
      _pushHistory('Reorder layers');
      _renderAll();
    });
  }

  function _renderProperties() {
    if (!_propsContainer || !_doc) return;
    const layer = _selectedLayer();
    if (!layer) {
      const hasX = _doc.guides.some(g => g.axis === 'x');
      const hasY = _doc.guides.some(g => g.axis === 'y');
      _propsContainer.innerHTML = `
        <p class="text-xs text-muted" data-i18n="studio.selectObject">Select an object to edit properties.</p>
        <div class="studio-property-row">
          <button class="btn btn-outline btn-sm ${hasX ? 'active' : ''}" data-studio-command="add-guide-x" data-i18n="studio.guideX">Guide X</button>
          <button class="btn btn-outline btn-sm ${hasY ? 'active' : ''}" data-studio-command="add-guide-y" data-i18n="studio.guideY">Guide Y</button>
        </div>
      `;
      if (typeof I18n !== 'undefined' && I18n.translateDOM) I18n.translateDOM();
      _propsContainer.querySelectorAll('[data-studio-command]').forEach(btn => btn.addEventListener('click', () => _runCommand(btn.dataset.studioCommand)));
      return;
    }
    const style = layer.style || {};
    _propsContainer.innerHTML = `
      <label><span data-i18n="studio.propName">Name</span> <input class="form-input" id="prop-name" value="${_escape(layer.name || _layerName(layer))}"></label>
      <label><span data-i18n="studio.propColor">Color</span> <input type="color" id="prop-color" value="${style.stroke || '#ffffff'}"></label>
      <label><span data-i18n="studio.propOpacity">Opacity</span> <input type="range" id="prop-opacity" min="0" max="1" step="0.01" value="${style.opacity ?? 1}"></label>
      ${style.strokeWidth !== undefined ? `<label><span data-i18n="studio.propThickness">Thickness</span> <input type="range" id="prop-thickness" min="1" max="30" value="${style.strokeWidth || 3}"></label>` : ''}
      ${layer.text !== undefined ? `<label><span data-i18n="studio.propText">Text</span> <input class="form-input" id="prop-text" value="${_escape(layer.text || '')}"></label>` : ''}
      ${style.fontSize !== undefined ? `<label><span data-i18n="studio.propFontSize">Font Size</span> <input type="range" id="prop-fontsize" min="8" max="160" value="${style.fontSize || 24}"></label>` : ''}
      ${_rotationControl(layer)}
      ${['line', 'arrow', 'distance', 'scalebar'].includes(layer.type) ? _capControls(style) : ''}
      ${layer.type === 'scalebar' ? _scaleBarControls(layer) : ''}
      <div class="studio-property-row">
        <button class="btn btn-outline btn-sm" id="prop-align-left">Align L</button>
        <button class="btn btn-outline btn-sm" id="prop-align-center">Center</button>
        <button class="btn btn-outline btn-sm" id="prop-align-right">Align R</button>
      </div>
      <div class="studio-property-row">
        <button class="btn btn-outline btn-sm" id="prop-group">Group</button>
        <button class="btn btn-outline btn-sm" id="prop-delete"><i data-lucide="trash-2"></i></button>
      </div>
      <div class="studio-measurement-readout">${_escape(_measurementLabel(layer) || '')}</div>
    `;
    if (typeof I18n !== 'undefined' && I18n.translateDOM) I18n.translateDOM();
    _bindProperty('prop-name', 'input', value => { layer.name = value; }, { relist: true });
    _bindProperty('prop-color', 'input', value => { layer.style.stroke = value; layer.style.fill = value; });
    _bindProperty('prop-opacity', 'input', value => { layer.style.opacity = Number(value); });
    _bindProperty('prop-thickness', 'input', value => { layer.style.strokeWidth = Number(value); });
    _bindProperty('prop-text', 'input', value => { layer.text = String(value).slice(0, IMPORT_MAX_TEXT); });
    _bindProperty('prop-fontsize', 'input', value => { layer.style.fontSize = Number(value); });
    _bindProperty('prop-startcap', 'change', value => { layer.style.startCap = value; });
    _bindProperty('prop-endcap', 'change', value => { layer.style.endCap = value; });
    _bindRotationProperty(layer);
    _bindScaleBarValueProperty(layer);
    _propsContainer.querySelectorAll('input[name="prop-scalebar-unit"]').forEach(input => {
      input.addEventListener('change', () => {
        layer.unit = input.value;
        layer.value = _snapScaleBarValue(layer.value || 100);
        _setScaleBarEnd(layer);
        _updateMeasurementText(layer);
        const valueField = document.getElementById('prop-scalebar-value');
        if (valueField) valueField.value = layer.value;
        _commitPropertyChange();
      });
    });
    document.getElementById('prop-align-left')?.addEventListener('click', () => _alignSelected('left'));
    document.getElementById('prop-align-center')?.addEventListener('click', () => _alignSelected('center'));
    document.getElementById('prop-align-right')?.addEventListener('click', () => _alignSelected('right'));
    document.getElementById('prop-group')?.addEventListener('click', _groupSelected);
    document.getElementById('prop-delete')?.addEventListener('click', _deleteSelected);
    if (window.lucide) lucide.createIcons({ nodes: [_propsContainer] });
  }

  function _renderChannels() {
    if (!_channelsContainer || !_doc) return;

    const isCompare = _doc.layoutMaps?.length > 0;
    const activeMap = isCompare ? _doc.layoutMaps[_activePanelIndex()] : null;
    const channels = isCompare
      ? (activeMap?.channelState || [])
      : (Array.isArray(_doc.channelState) ? _doc.channelState : []);

    if (!channels.length) {
      _channelsShown = null;
      _channelsContainer.innerHTML = `<div class="studio-empty">${_escape(_t('studio.noChannelMeta', 'No channel metadata.'))}</div>`;
      return;
    }

    // The panel already shows these channels, of this cell, over these values (a layer
    // edit, a selection): rebuilding it would redo every control and histogram.
    const raw = isCompare ? activeMap?.raw : _sliceResult?.raw;
    // raw.version: the native pass refills one raw buffer in place, and its histograms
    // change with every refill.
    const shown = { panel: isCompare ? _activePanelIndex() : -1, raw: raw || null, rawVersion: raw?.version, json: JSON.stringify(channels) };
    if (_channelsShown && _channelsShown.panel === shown.panel && _channelsShown.raw === shown.raw
      && _channelsShown.rawVersion === shown.rawVersion && _channelsShown.json === shown.json) return;

    _studioHistograms = _computeStudioHistograms(raw, activeMap);

    if (typeof createChannelPanel !== 'undefined') {
      if (!window._studioChannelPanel) {
        window._studioChannelPanel = createChannelPanel();
      }
      _channelsSeeding = true;
      try {
        window._studioChannelPanel.init('studio-channels', { dimensions: { c: channels.length }, channels }, (idx, state) => {
          if (_channelsSeeding) return;
          const panelIdx = _doc.layoutMaps?.length > 0 ? _activePanelIndex() : -1;
          let list;
          if (panelIdx >= 0) {
            const target = _doc.layoutMaps[panelIdx];
            if (!target) return;
            if (!Array.isArray(target.channelState)) target.channelState = [];
            target.channelState[idx] = state;
            list = target.channelState;
          } else {
            _doc.channelState[idx] = state;
            list = _doc.channelState;
          }
          // The panel shows this state already.
          if (_channelsShown) _channelsShown.json = JSON.stringify(list);
          _recordChannelEdit(panelIdx);
          _scheduleChannelRecompose(panelIdx >= 0 ? panelIdx : undefined);
        });
      } finally {
        _channelsSeeding = false;
      }
      window._studioChannelPanel.setState(channels, { notify: false });
      window._studioChannelPanel.setHistograms(_studioHistograms);
      _channelsShown = shown;
    } else {
      _channelsShown = null;
      _channelsContainer.innerHTML = `<div class="studio-empty">${_escape(_t('studio.channelPanelMissing', 'ChannelPanel not loaded.'))}</div>`;
    }
  }

  /**
   * A channel edit is a step of the history like a layer edit, so undo takes back the
   * last edit whichever it was, and undoing an annotation never reverts the channels
   * set after it. A run of edits of one cell (a slider drag: one notification per
   * frame) is one step, closed by the panel's change / pointerup, a pause of
   * CHANNEL_EDIT_RUN_MS, or any other step.
   */
  function _recordChannelEdit(panelIdx) {
    if (!_doc) return;
    const now = _nowMs();
    const top = _history[_history.length - 1];
    const run = _channelEditRun;
    if (run && run.panel === panelIdx && run.entry === top && _history.length > 1 && now - run.at <= CHANNEL_EDIT_RUN_MS) {
      _doc.updatedAt = new Date().toISOString();
      top.doc = _clone(_doc);
      _future = [];
      run.at = now;
      return;
    }
    _pushHistory('Edit channels');
    _channelEditRun = { panel: panelIdx, entry: _history[_history.length - 1], at: now };
  }

  function _endChannelEditRun() {
    _channelEditRun = null;
  }

  // ── Channel edits → the picture ──────────────────────────
  // One recomposition per frame while a control is dragged, and the last state is
  // always drawn: an edit after a quiet spell is drawn at once (a click, a colour, a
  // toggle), edits inside a frame are coalesced into one trailing draw. That draw
  // waits for the next animation frame, with a timer as backstop — a hidden page
  // never runs its animation frames.
  const RECOMPOSE_FRAME_MS = 16;
  const RECOMPOSE_BACKSTOP_MS = 64;
  const _recompose = { pending: null, raf: 0, timer: 0, lastAt: -Infinity };

  function _nowMs() {
    return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  }

  /** `panelIdx` = a Compare cell; undefined = the single slice (or every cell). */
  function _scheduleChannelRecompose(panelIdx) {
    const r = _recompose;
    if (panelIdx === undefined || r.pending === 'all') r.pending = 'all';
    else (r.pending ||= new Set()).add(panelIdx);
    if (r.raf || r.timer) return;
    if (_nowMs() - r.lastAt >= RECOMPOSE_FRAME_MS) {
      _flushChannelRecompose();
      return;
    }
    if (typeof requestAnimationFrame === 'function') r.raf = requestAnimationFrame(_flushChannelRecompose);
    r.timer = setTimeout(_flushChannelRecompose, RECOMPOSE_BACKSTOP_MS);
  }

  function _flushChannelRecompose() {
    const r = _recompose;
    const pending = r.pending;
    _cancelChannelRecompose();
    if (!pending || !_doc) return;
    r.lastAt = _nowMs();
    if (pending === 'all') _rerenderSliceFromChannels(undefined);
    else pending.forEach(index => _rerenderSliceFromChannels(index));
  }

  function _cancelChannelRecompose() {
    const r = _recompose;
    if (r.raf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(r.raf);
    if (r.timer) clearTimeout(r.timer);
    r.raf = 0;
    r.timer = 0;
    r.pending = null;
  }

  // ── Raw slices (SliceCompositor) ─────────────────────────
  // A slice that carries its raw channel values (VolumeSlicer.renderRawWithMaterial)
  // is always shown coloured from them with the Studio's channel state: the same
  // pixels, frame and crop as the picture it came with, so annotations never move.
  let _sliceCanvas = null;
  let _panelCanvas = null;

  function _hasRaw(holder) {
    return typeof SliceCompositor !== 'undefined' && SliceCompositor.isRaw(holder?.raw);
  }

  /**
   * `raw` coloured with `channelState` into `target` (kept and reused); null on failure.
   * `slot`: the compositor texture slot of this picture (a refresh of the same size
   * rewrites it instead of uploading a new texture).
   */
  function _composeRaw(raw, channelState, target, slot = null) {
    try {
      const canvas = SliceCompositor.compose(raw, Array.isArray(channelState) ? channelState : [], {
        numChannels: raw.channels,
        target,
        ...(slot ? { slot } : {})
      });
      if (canvas) _pictureVersion++;
      return canvas;
    } catch (err) {
      console.warn('[StudioEditor] Slice colouring failed:', err);
      return null;
    }
  }

  // The Studio's own canvases: the single slice's picture, and the scratch a Compare
  // cell is coloured into before it is laid on the figure.
  function _ownSliceCanvas() {
    if (!_sliceCanvas) _sliceCanvas = document.createElement('canvas');
    return _sliceCanvas;
  }

  function _ownPanelCanvas() {
    if (!_panelCanvas) _panelCanvas = document.createElement('canvas');
    return _panelCanvas;
  }

  /**
   * Gives back the backing store of the Studio's own canvases once nothing shows them:
   * the Compare cell scratch (sized to the last cell coloured, ~58 MB for a 3800² crop)
   * always, the slice canvas only when it is not the picture on screen. A canvas keeps
   * its pixels until it is resized, so dropping the reference alone is not enough.
   */
  function _releaseScratchCanvases() {
    if (_panelCanvas) {
      _panelCanvas.width = 0;
      _panelCanvas.height = 0;
      _panelCanvas = null;
    }
    if (_sliceCanvas && _sliceCanvas !== _sliceImage && _sliceCanvas !== _sliceResult?.canvas) {
      _sliceCanvas.width = 0;
      _sliceCanvas.height = 0;
      _sliceCanvas = null;
    }
  }

  function _seedChannelState(sliceResult) {
    if (Array.isArray(sliceResult?.channelState)) return sliceResult.channelState;
    return (typeof ViewerApp !== 'undefined' && ViewerApp.getChannelState) ? (ViewerApp.getChannelState() || []) : [];
  }

  /**
   * Drops every raw buffer the Studio holds (the current slice, the Compare cells,
   * the undo history's cells) and frees the compositor's GPU textures. Tens of MB a
   * slice at native resolution: kept only while the document that shows them is open.
   */
  function _releaseRaw() {
    if (typeof SliceCompositor !== 'undefined') SliceCompositor.release();
    if (_sliceResult?.raw) _sliceResult = { ..._sliceResult, raw: null };
    const docs = [_doc, ..._history.map(h => h?.doc), ..._future.map(h => h?.doc)];
    docs.forEach(doc => {
      (doc?.layoutMaps || []).forEach(map => {
        if (!map) return;
        map.raw = null;
        if (map.sliceResult?.raw) map.sliceResult = { ...map.sliceResult, raw: null };
      });
    });
  }

  function _computeStudioHistograms(raw, map) {
    // The slice's own values when it carries them: the histogram of what is shown,
    // in the shape VolumeViewer.getChannelHistograms() gives the channel panel.
    if (typeof SliceCompositor !== 'undefined' && SliceCompositor.isRaw(raw)) {
      try {
        return SliceCompositor.histograms(raw, 256);
      } catch (err) {
        console.warn('[StudioEditor] Slice histograms unavailable:', err);
      }
    }
    // compare.html loads neither VolumeViewer nor VolumeSlicer, so the only histograms
    // of that panel's volume live inside the panel's own (same-origin) frame.
    if (map?.iframe) {
      try {
        const fromFrame = map.iframe.contentWindow?.ViewerApp?.getChannelHistograms?.();
        if (fromFrame?.length) return fromFrame;
      } catch (err) {
        console.warn('[StudioEditor] Panel frame histograms unavailable:', err);
      }
    }
    if (typeof VolumeViewer !== 'undefined' && VolumeViewer.getChannelHistograms) {
      return VolumeViewer.getChannelHistograms() || [];
    }
    return [];
  }

  /**
   * Re-colours the picture after a channel edit. `activePanelOnly` = the Compare cell
   * to redo (undefined: every cell). `options.rawOnly` redoes only the cells that carry
   * raw values (the opening of a Compare document).
   */
  function _rerenderSliceFromChannels(activePanelOnly, options = {}) {
    if (!_sliceResult || !_doc) return;

    if (_doc.layoutMaps?.length > 0) {
      // The figure the cells are laid on: copied once from the picture compare.js
      // handed over, then redrawn in place (a copy per drag frame of an 8k figure is
      // hundreds of MB of garbage).
      let tempCanvas = _sliceImage;
      if (!tempCanvas || tempCanvas === _sliceResult.canvas) {
        tempCanvas = document.createElement('canvas');
        tempCanvas.width = _sliceImage.width;
        tempCanvas.height = _sliceImage.height;
        tempCanvas.getContext('2d').drawImage(_sliceImage, 0, 0);
      }
      const ctx = tempCanvas.getContext('2d');

      let changed = false;

      const indicesToUpdate = (activePanelOnly !== undefined && activePanelOnly >= 0)
        ? [Math.min(activePanelOnly, _doc.layoutMaps.length - 1)]
        : _doc.layoutMaps.map((_, i) => i);

      indicesToUpdate.forEach(mapIdx => {
        const map = _doc.layoutMaps[mapIdx];
        if (!map) return;
        let recomposedCanvas = null;

        if (_hasRaw(map)) {
          // The cell's own pixels (the panel's crop, map.raw.width × height),
          // re-coloured by this page's compositor: no panel render at all.
          recomposedCanvas = _composeRaw(map.raw, map.channelState, _ownPanelCanvas());
        } else if (!options.rawOnly && map.sliceResult) {
          const targetSlicer = map.iframe?.contentWindow?.VolumeSlicer
            || (typeof VolumeSlicer !== 'undefined' ? VolumeSlicer : null);
          if (!targetSlicer?.recompose) return;
          // While editing, render the cell at the size it actually occupies in the
          // composite: anything more is thrown away by the drawImage below, anything
          // less comes back softer than the cell the operator started from.
          const fullRes = map.sliceResult.renderRes || map.sliceResult.width || 1024;
          const cellRes = Math.max(1, Math.round(Math.max(map.w, map.h)));
          const renderRes = (activePanelOnly !== undefined) ? cellRes : fullRes;
          const recomposed = targetSlicer.recompose({ ...map.sliceResult, width: renderRes }, map.channelState);
          if (recomposed?.canvas) {
            const gpuCanvas = recomposed.canvas;
            // The crop box is found once, on the first render: the geometry never
            // changes, only the colours do, and a box re-found on every frame moves
            // when a channel change makes the edge of the specimen transparent.
            if (!map._cropRect) {
              const rect = _contentRect(gpuCanvas, 4);
              if (rect) {
                const gw = gpuCanvas.width;
                const gh = gpuCanvas.height;
                // Normalised, so it holds at any render resolution.
                map._cropRect = { x: rect.x / gw, y: rect.y / gh, x2: rect.x2 / gw, y2: rect.y2 / gh };
              }
            }
            if (map._cropRect) {
              const cr = map._cropRect;
              const sx = Math.round(cr.x * gpuCanvas.width);
              const sy = Math.round(cr.y * gpuCanvas.height);
              const sw = Math.round((cr.x2 - cr.x) * gpuCanvas.width) + 1;
              const sh = Math.round((cr.y2 - cr.y) * gpuCanvas.height) + 1;
              const cropped = document.createElement('canvas');
              cropped.width = sw;
              cropped.height = sh;
              cropped.getContext('2d').drawImage(gpuCanvas, sx, sy, sw, sh, 0, 0, sw, sh);
              recomposedCanvas = cropped;
            } else {
              recomposedCanvas = gpuCanvas;
            }
          }
        }

        if (recomposedCanvas) {
          // The cell goes back to the figure's backdrop before the new colours are
          // laid on it: a slice is transparent outside the specimen.
          if (_doc.layoutBackground) {
            ctx.fillStyle = _doc.layoutBackground;
            ctx.fillRect(map.x, map.y, map.w, map.h);
          } else {
            ctx.clearRect(map.x, map.y, map.w, map.h);
          }
          ctx.drawImage(recomposedCanvas, map.x, map.y, map.w, map.h);
          changed = true;
        }
      });

      if (changed) {
        _sliceImage = tempCanvas;
        _pictureVersion++;
        _draw();
      }
      return;
    }

    if (_hasRaw(_sliceResult)) {
      // Re-coloured in place from the slice's own values: same frame and crop, so
      // every annotation keeps its coordinates (no re-render, no re-crop).
      const canvas = _composeRaw(_sliceResult.raw, _doc.channelState, _ownSliceCanvas(), SLICE_TEXTURE_SLOT);
      if (!canvas) return;
      _sliceResult = { ..._sliceResult, canvas, width: canvas.width, height: canvas.height };
      _sliceImage = canvas;
      _draw();
      return;
    }

    const recoloured = _recolourNonRawSlice(_sliceResult, _doc.channelState);
    if (!recoloured) return;
    _sliceResult = recoloured;
    _sliceImage = recoloured.canvas;
    _pictureVersion++;
    _draw();
  }

  /**
   * Bounding box {x, y, x2, y2} of the pixels of `canvas` whose alpha exceeds 5,
   * padded by `padding` px and clipped to the canvas — the box the viewer crops a
   * slice to (viewer.js _sliceContentRect, padding 10). null when nothing shows.
   */
  function _contentRect(canvas, padding) {
    const w = canvas.width;
    const h = canvas.height;
    const data = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h).data;
    let minX = w;
    let minY = h;
    let maxX = -1;
    let maxY = -1;
    for (let y = 0; y < h; y++) {
      for (let x = 0, o = y * w * 4 + 3; x < w; x++, o += 4) {
        if (data[o] > 5) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < minX || maxY < minY) return null;
    return {
      x: Math.max(0, minX - padding),
      y: Math.max(0, minY - padding),
      x2: Math.min(w - 1, maxX + padding),
      y2: Math.min(h - 1, maxY + padding)
    };
  }

  /**
   * A slice without raw values coloured with `channelState`: re-rendered through the
   * slicer at the frame it was cut from (`renderRes`), then cut to the SAME window as
   * the picture the document is laid on, whatever the new colours make visible — the
   * picture keeps its size and every annotation its place. The window is the slice's
   * own `cropRect` when it carries one; otherwise it is found once, in a render with
   * the slice's own colours (the render the viewer cropped), and kept for the
   * document. null when the slice cannot be re-rendered (only gpu-slicer / zstack
   * slices can) or the window cannot be placed.
   */
  function _recolourNonRawSlice(sliceResult, channelState) {
    if (typeof VolumeSlicer === 'undefined' || typeof VolumeSlicer.recompose !== 'function') return null;
    if (sliceResult?.source !== 'gpu-slicer' && sliceResult?.source !== 'zstack') return null;
    const renderRes = Number(sliceResult.renderRes) > 0 ? Number(sliceResult.renderRes) : null;
    const w = Number(_doc?.sourceSlice?.width) || sliceResult.width;
    const h = Number(_doc?.sourceSlice?.height) || sliceResult.height;
    if (!renderRes || !(w > 0) || !(h > 0)) return null;
    const render = (state) => {
      try {
        return VolumeSlicer.recompose({ ...sliceResult, raw: null, width: renderRes }, state)?.canvas || null;
      } catch (err) {
        console.warn('[StudioEditor] Slice re-render failed:', err);
        return null;
      }
    };
    if (!_nonRawCrop) {
      const given = sliceResult.cropRect;
      if (given && Number.isFinite(given.x) && Number.isFinite(given.y)) {
        const s = given.renderRes ? renderRes / given.renderRes : 1;
        _nonRawCrop = { x: Math.round(given.x * s), y: Math.round(given.y * s) };
      } else {
        const seed = render(Array.isArray(sliceResult.channelState) ? sliceResult.channelState : channelState);
        const rect = seed ? _contentRect(seed, 10) : null;
        if (!rect) return null;
        _nonRawCrop = { x: rect.x, y: rect.y };
      }
    }
    const frame = render(channelState);
    if (!frame) return null;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    canvas.getContext('2d').drawImage(frame, _nonRawCrop.x, _nonRawCrop.y, w, h, 0, 0, w, h);
    return { ...sliceResult, canvas, width: w, height: h, renderRes };
  }

  /**
   * The picture the Studio shows for `sliceResult`: coloured from its raw values with
   * `channelState` (the document's once one is open, the slice's own to seed a new
   * one) when it carries them. A slice without raw values is shown as it was handed
   * over when it already has those colours (always on opening), else re-coloured
   * through the slicer in the document's frame (_recolourNonRawSlice).
   */
  function _prepareSliceForStudio(sliceResult, channelState = null) {
    if (_hasRaw(sliceResult)) {
      const state = Array.isArray(channelState) ? channelState : _seedChannelState(sliceResult);
      const canvas = _composeRaw(sliceResult.raw, state, _ownSliceCanvas(), SLICE_TEXTURE_SLOT);
      if (canvas) return { ...sliceResult, canvas, width: canvas.width, height: canvas.height };
    }
    if (!sliceResult?.canvas) return sliceResult;
    const own = Array.isArray(sliceResult.channelState) ? sliceResult.channelState : null;
    if (!Array.isArray(channelState) || !own || _sameChannels(channelState, own)) return sliceResult;
    return _recolourNonRawSlice(sliceResult, channelState) || sliceResult;
  }

  function _setTool(tool) {
    _activeTool = TOOL_ICONS[tool] ? tool : 'select';
    _drawing = null;
    if (_activeTool !== 'select') _selectedId = null;
    _syncToolButtons();
    _draw();
  }

  function _syncToolButtons() {
    _toolsContainer?.querySelectorAll('[data-studio-tool]').forEach(button => {
      button.classList.toggle('active', button.dataset.studioTool === _activeTool);
    });
  }

  function _pushLayer(layer) {
    _doc.layers.push(layer);
    _selectedId = layer.id;
    _updateMeasurementText(layer);
    _pushHistory(`Add ${layer.type}`);
    _renderAll();
  }

  function _ensureDefaultScaleBarLayer() {
    if (!_doc || !_sliceResult?.defaultScaleBar || _isUncalibrated()) return;
    const existing = _doc.layers.find(layer => layer.meta?.kind === 'default-scalebar');
    if (existing) return;
    const base = _sliceResult.defaultScaleBar;
    const style = base.style || {};
    const value = _snapScaleBarValue(base.value || 100);
    const layer = {
      ..._newBaseLayer('scalebar'),
      id: `scalebar_default_${Date.now().toString(36)}`,
      name: 'Scale Bar',
      x1: base.x1,
      y1: base.y1,
      x2: base.x2,
      y2: base.y2,
      value,
      unit: base.unit || 'um',
      meta: { kind: 'default-scalebar' },
      style: {
        stroke: style.stroke || '#ffffff',
        fill: style.fill || '#ffffff',
        strokeWidth: style.strokeWidth || 2,
        fontSize: style.fontSize || 12,
        opacity: Number.isFinite(style.opacity) ? style.opacity : 1,
        startCap: style.startCap || 'bar',
        endCap: style.endCap || 'bar'
      }
    };
    _setScaleBarEnd(layer);
    _doc.layers.push(layer);
  }

  function _newBaseLayer(type) {
    const color = COLORS[_doc.layers.length % COLORS.length];
    return {
      id: `${type}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
      type,
      name: '',
      visible: true,
      locked: false,
      groupId: null,
      // Degrees, (−180, 180], clockwise on screen (image y points down).
      rotation: 0,
      style: {
        stroke: color,
        fill: color,
        strokeWidth: type === 'text' ? undefined : 2,
        fontSize: ['text', 'distance', 'angle', 'scalebar'].includes(type) ? 14 : undefined,
        opacity: 1,
        startCap: 'none',
        endCap: type === 'arrow' ? 'arrow' : 'none'
      }
    };
  }

  function _newTextLayer(point, text) {
    return {
      ..._newBaseLayer('text'),
      x: point.x,
      y: point.y,
      w: 200,
      h: 32,
      text,
      style: {
        stroke: COLORS[_doc.layers.length % COLORS.length],
        fill: COLORS[_doc.layers.length % COLORS.length],
        fontSize: 18,
        opacity: 1,
        textBackground: true
      }
    };
  }

  function _newAngleLayer(a, b, c) {
    return {
      ..._newBaseLayer('angle'),
      x1: a.x,
      y1: a.y,
      x2: b.x,
      y2: b.y,
      x3: c.x,
      y3: c.y
    };
  }

  function _layerFromDraft(draft) {
    const dx = draft.current.x - draft.start.x;
    const dy = draft.current.y - draft.start.y;
    if (Math.hypot(dx, dy) < 3 && draft.type !== 'scalebar') return null;
    if (['rectangle', 'ellipse'].includes(draft.type)) {
      const box = _boxFromPoints(draft.start, draft.current);
      return { ..._newBaseLayer(draft.type), ...box };
    }
    const layer = {
      ..._newBaseLayer(draft.type),
      x1: draft.start.x,
      y1: draft.start.y,
      x2: draft.current.x,
      y2: draft.current.y
    };
    if (draft.type === 'distance') {
      layer.style.startCap = 'none';
      layer.style.endCap = 'none';
    }
    if (draft.type === 'scalebar') {
      // Without a physical scale a bar can only count pixels.
      layer.unit = _isUncalibrated() ? 'px' : 'um';
      layer.value = _snapScaleBarValue(100);
      // A bar is laid from where it was placed; where the pointer was released says
      // nothing of its length, so it must not choose the cell that calibrates it.
      layer.x2 = layer.x1;
      layer.y2 = layer.y1;
      _setScaleBarEnd(layer);
      layer.style.startCap = 'bar';
      layer.style.endCap = 'bar';
    }
    return layer;
  }

  function _selectedLayer() {
    return _doc?.layers.find(layer => layer.id === _selectedId) || null;
  }

  function _hitTest(point) {
    if (!_doc) return null;
    // The rotate handle floats outside its layer, where another layer may lie on top.
    const selected = _activeTool === 'select' ? _selectedLayer() : null;
    if (selected && _hitRotationHandle(selected, point)) return { id: selected.id, handle: 'rotate' };
    for (let i = _doc.layers.length - 1; i >= 0; i--) {
      const layer = _doc.layers[i];
      if (layer.visible === false) continue;
      const handle = _hitHandle(layer, point);
      if (handle) return { id: layer.id, handle };
      if (_layerContains(layer, point)) return { id: layer.id, handle: null };
    }
    return null;
  }

  function _hitHandle(layer, point) {
    const hitSize = 10 / Math.max(0.001, _doc.viewport.zoom);
    return _handlesForLayer(layer).find(handle => Math.abs(point.x - handle.x) <= hitSize && Math.abs(point.y - handle.y) <= hitSize)?.id || null;
  }

  function _layerContains(layer, point) {
    if (_isBoxLayer(layer)) {
      // The pointer is brought into the box's own frame by the inverse turn R(−θ) about
      // the box centre, where the box is axis-aligned again.
      const box = _layerBox(layer);
      const local = _rotatePointAbout(point, _boxCentre(box), -_layerRotationRad(layer));
      return local.x >= box.x && local.x <= box.x + box.w && local.y >= box.y && local.y <= box.y + box.h;
    }
    if (['line', 'arrow', 'distance', 'scalebar'].includes(layer.type)) {
      const p = _linePoints(layer);
      return _distToSegment(point.x, point.y, p.x1, p.y1, p.x2, p.y2) < Math.max(7, (layer.style?.strokeWidth || 3) * 2) / _doc.viewport.zoom;
    }
    if (layer.type === 'angle') {
      return _distToSegment(point.x, point.y, layer.x1, layer.y1, layer.x2, layer.y2) < 10 / _doc.viewport.zoom
        || _distToSegment(point.x, point.y, layer.x1, layer.y1, layer.x3, layer.y3) < 10 / _doc.viewport.zoom;
    }
    return false;
  }

  function _handlesForLayer(layer) {
    if (['line', 'arrow', 'distance', 'scalebar'].includes(layer.type)) {
      const p = _linePoints(layer);
      return [{ id: 'p1', x: p.x1, y: p.y1 }, { id: 'p2', x: p.x2, y: p.y2 }];
    }
    if (layer.type === 'angle') {
      return [
        { id: 'p1', x: layer.x1, y: layer.y1 },
        { id: 'p2', x: layer.x2, y: layer.y2 },
        { id: 'p3', x: layer.x3, y: layer.y3 }
      ];
    }
    return _rotatedBoxCorners(_layerBox(layer), _layerRotationRad(layer));
  }

  // The rotate handle: a knob on a stem above the top-centre of the selection — of the
  // turned box itself for a box layer (so it turns with it), of the bounds for a point
  // layer. The stem has a constant length on screen.
  function _rotationHandle(layer) {
    const offset = ROTATE_HANDLE_OFFSET / Math.max(0.001, _doc.viewport.zoom);
    if (_isBoxLayer(layer)) {
      const box = _layerBox(layer);
      const c = _boxCentre(box);
      const rad = _layerRotationRad(layer);
      const base = _rotatePointAbout({ x: c.x, y: box.y }, c, rad);
      const knob = _rotatePointAbout({ x: c.x, y: box.y - offset }, c, rad);
      return { x: knob.x, y: knob.y, baseX: base.x, baseY: base.y };
    }
    const bounds = _layerBounds(layer);
    const x = bounds.x + bounds.w / 2;
    return { x, y: bounds.y - offset, baseX: x, baseY: bounds.y };
  }

  function _hitRotationHandle(layer, point) {
    if (!layer || !_doc || layer.locked === true || layer.visible === false) return false;
    const knob = _rotationHandle(layer);
    return Math.hypot(point.x - knob.x, point.y - knob.y) <= ROTATE_HANDLE_HIT / Math.max(0.001, _doc.viewport.zoom);
  }

  function _beginLayerRotation(layer, point) {
    const centre = _layerRotationCentre(layer);
    _selectedId = layer.id;
    _hoverHandle = 'rotate';
    _drawing = {
      mode: 'rotate',
      start: point,
      centre,
      startAngle: Math.atan2(point.y - centre.y, point.x - centre.x),
      original: _clone(layer)
    };
    _canvas.style.cursor = ROTATE_CURSOR;
    _draw();
  }

  // Resize cursor of a box handle: the handle's outward direction in the box frame,
  // turned by the layer and by the view, read to the nearest of the four cursor axes.
  function _resizeCursor(layer, handleId) {
    const id = String(handleId || '');
    if (!_isBoxLayer(layer) || !/^[ns]?[ew]?$/.test(id) || !id) return 'nwse-resize';
    const lx = id.includes('e') ? 1 : id.includes('w') ? -1 : 0;
    const ly = id.includes('s') ? 1 : id.includes('n') ? -1 : 0;
    const deg = Math.atan2(ly, lx) * 180 / Math.PI + _layerRotationDeg(layer) + (_doc.viewport.rotation || 0) * 180 / Math.PI;
    const index = ((Math.round(deg / 45) % 4) + 4) % 4;
    return ['ew-resize', 'nwse-resize', 'ns-resize', 'nesw-resize'][index];
  }

  // Centre a layer turns about: the box centre, or the mean of the defining points —
  // invariant under the turn itself, so +θ then −θ lands exactly where it started.
  function _layerRotationCentre(layer) {
    if (_isBoxLayer(layer)) return _boxCentre(_layerBox(layer));
    return _centroid(_handlesForGeometry(layer));
  }

  /**
   * Sets a layer's rotation to `targetDeg`, starting from `snapshot` (the layer as it was
   * when the gesture began, so repeated previews never accumulate float error).
   * Box layers only record the angle: they are turned when drawn. Point layers carry
   * measurements read from their points and the (possibly anisotropic) calibration, so
   * the turn is baked into the points and the labels keep reading real image geometry:
   *   line, arrow        — a rigid turn of the points about their centroid;
   *   angle              — a rigid turn in µm space about the centroid, so the angle it
   *                        measures is unchanged with anisotropic pixels;
   *   distance           — a ruler: its direction turns rigidly, its pixel length is
   *                        re-derived so the measured µm are unchanged (_rotateRuler);
   *   scale bar          — its direction IS its rotation; the pixel length along it is
   *                        the one that measures exactly its value (_scaleBarPixels).
   */
  function _rotateLayerFromSnapshot(layer, snapshot, targetDeg) {
    const target = _normalizeRotationDeg(targetDeg);
    const delta = (target - _layerRotationDeg(snapshot)) * Math.PI / 180;
    layer.rotation = target;
    if (_isBoxLayer(layer)) return;
    if (!delta) {
      // Back at the starting angle: the starting points, bit for bit.
      ['x1', 'y1', 'x2', 'y2', 'x3', 'y3'].forEach(k => { if (snapshot[k] !== undefined) layer[k] = snapshot[k]; });
      _updateMeasurementText(layer);
      return;
    }
    if (layer.type === 'scalebar') {
      // The bar turns about its middle, measured with the calibration of the cell that
      // middle lies in (a Compare figure; the document's otherwise): a bar of that length
      // centred there has its middle in that cell, which is exactly what _scaleBarCell
      // then reads back, so the stored far end stays the drawn one after the turn.
      const centre = _layerRotationCentre(snapshot);
      const u = _scaleBarDirection(layer);
      const centreCell = _doc?.layoutMaps?.length ? _nearestCell(centre.x, centre.y) : null;
      const px = centreCell?.pixelSizeUm ? _normalizePixelSize(centreCell.pixelSizeUm) : _layerPixelSize(snapshot);
      const length = _lengthInPixels(layer.unit || 'um', layer.value || 100, _umPerPixelAlong(u.x, u.y, px));
      layer.x1 = centre.x - u.x * length / 2;
      layer.y1 = centre.y - u.y * length / 2;
      layer.x2 = centre.x + u.x * length / 2;
      layer.y2 = centre.y + u.y * length / 2;
    } else if (layer.type === 'distance') {
      const turned = _rotateRuler(
        { x: snapshot.x1, y: snapshot.y1 },
        { x: snapshot.x2, y: snapshot.y2 },
        delta,
        _layerPixelSize(snapshot)
      );
      Object.assign(layer, turned);
    } else if (layer.type === 'angle') {
      // An angle is read in µm space (_angleDegrees), so it is turned there: a rigid
      // turn of the physical figure about its centroid c,
      //   p' = c + S⁻¹·R(θ)·S·(p − c),   S = diag(psx, psy),
      // keeps the angle between its arms whatever the pixel anisotropy (a rigid turn in
      // pixels would not: 90° at 1 × 2 µm/px reads 53.1° after 45°). The centroid of the
      // turned points is c again, so the calibration it is read with does not change.
      const centre = _layerRotationCentre(snapshot);
      const px = _layerPixelSize(snapshot);
      const sx = Number(px?.x) > 0 ? Number(px.x) : 1;
      const sy = Number(px?.y) > 0 ? Number(px.y) : sx;
      ['1', '2', '3'].forEach(n => {
        const v = _rotateVec((snapshot[`x${n}`] - centre.x) * sx, (snapshot[`y${n}`] - centre.y) * sy, delta);
        layer[`x${n}`] = centre.x + v.x / sx;
        layer[`y${n}`] = centre.y + v.y / sy;
      });
    } else if (['line', 'arrow'].includes(layer.type)) {
      const centre = _layerRotationCentre(snapshot);
      ['1', '2'].forEach(n => {
        const p = _rotatePointAbout({ x: snapshot[`x${n}`], y: snapshot[`y${n}`] }, centre, delta);
        layer[`x${n}`] = p.x;
        layer[`y${n}`] = p.y;
      });
    }
    _updateMeasurementText(layer);
  }

  function _applyHandle(layer, handle, point, original) {
    if (layer.type === 'scalebar') {
      _applyScaleBarHandle(layer, handle, point, original);
      return;
    }
    if (['line', 'arrow', 'distance', 'scalebar'].includes(layer.type)) {
      if (handle === 'p1') {
        layer.x1 = point.x;
        layer.y1 = point.y;
      } else {
        layer.x2 = point.x;
        layer.y2 = point.y;
      }
      return;
    }
    if (layer.type === 'angle') {
      const map = { p1: ['x1', 'y1'], p2: ['x2', 'y2'], p3: ['x3', 'y3'] };
      const keys = map[handle];
      if (keys) {
        layer[keys[0]] = point.x;
        layer[keys[1]] = point.y;
      }
      return;
    }
    // Resized in the box's own frame; the opposite corner stays put in image space.
    const box = _resizeRotatedBox(_layerBox(original), _layerRotationRad(original), handle, point);
    layer.x = box.x;
    layer.y = box.y;
    layer.w = box.w;
    layer.h = box.h;
  }

  // A scale bar is resized along its own direction u: the pointer is projected on the
  // bar's axis ((P − A)·u), never read as a raw x, so a turned bar keeps its angle.
  function _applyScaleBarHandle(layer, handle, point, original) {
    const base = original || _clone(layer);
    const basePoints = _linePoints(base);
    const u = _scaleBarDirection(base);
    const minPixels = Math.max(1, _scaleBarPixelsForValue(layer, layer.unit || 'um', SCALEBAR_STEP));

    if (handle === 'p1') {
      const along = Math.max(minPixels, (basePoints.x2 - point.x) * u.x + (basePoints.y2 - point.y) * u.y);
      layer.x1 = basePoints.x2 - u.x * along;
      layer.y1 = basePoints.y2 - u.y * along;
      layer.value = _scaleBarValueFromPixels(layer, along);
    } else {
      layer.x1 = base.x1;
      layer.y1 = base.y1;
      layer.value = _scaleBarValueFromPixels(layer, (point.x - base.x1) * u.x + (point.y - base.y1) * u.y);
    }

    layer.value = _snapScaleBarValue(layer.value);
    _setScaleBarEnd(layer);
    _updateMeasurementText(layer);
  }

  function _moveLayerTo(layer, original, dx, dy) {
    if (layer.x !== undefined) {
      layer.x = original.x + dx;
      layer.y = original.y + dy;
    }
    ['1', '2', '3'].forEach(n => {
      if (layer[`x${n}`] !== undefined) {
        layer[`x${n}`] = original[`x${n}`] + dx;
        layer[`y${n}`] = original[`y${n}`] + dy;
      }
    });
  }

  // The layer's centre snaps to the nearest guide within reach on each axis (the
  // figure's centre lines and the operator's guides): one correction per axis, both
  // measured from the same bounds and applied in a single move.
  function _applySnapping(layer) {
    const threshold = 7 / Math.max(0.001, _doc.viewport.zoom);
    const box = _layerBounds(layer);
    const centre = { x: box.x + box.w / 2, y: box.y + box.h / 2 };
    const guides = [
      { axis: 'x', value: _doc.sourceSlice.width / 2 },
      { axis: 'y', value: _doc.sourceSlice.height / 2 },
      ..._doc.guides
    ];
    const delta = { x: 0, y: 0 };
    ['x', 'y'].forEach(axis => {
      let best = null;
      guides.forEach(guide => {
        if (guide.axis !== axis || !Number.isFinite(guide.value)) return;
        const d = guide.value - centre[axis];
        if (Math.abs(d) <= threshold && (best === null || Math.abs(d) < Math.abs(best))) best = d;
      });
      if (best !== null) delta[axis] = best;
    });
    if (delta.x || delta.y) _moveLayerTo(layer, _clone(layer), delta.x, delta.y);
  }

  // A scale bar's far end is never stored as truth: it is x1 + u·L, with u its direction
  // and L the pixel length that measures its value.
  function _linePoints(layer) {
    if (layer.type !== 'scalebar') return { x1: layer.x1, y1: layer.y1, x2: layer.x2, y2: layer.y2 };
    const length = _scaleBarPixels(layer);
    const u = _scaleBarDirection(layer);
    return { x1: layer.x1, y1: layer.y1, x2: layer.x1 + u.x * length, y2: layer.y1 + u.y * length };
  }

  // The direction of a bar is its rotation: a bar is born horizontal and only ever
  // turns through a rotation, so an old document (no rotation) stays horizontal.
  function _scaleBarDirection(layer) {
    return _unitFromDeg(_layerRotationDeg(layer));
  }

  // Writes the far end back after a value, unit or rotation change, along the bar.
  function _setScaleBarEnd(layer) {
    const p = _linePoints(layer);
    layer.x2 = p.x2;
    layer.y2 = p.y2;
  }

  function _scaleBarPixels(layer) {
    return _scaleBarPixelsForValue(layer, layer.unit || 'um', layer.value || 100);
  }

  // µm per image px along the bar (see _umPerPixelAlong): psx for a horizontal bar,
  // psy for a vertical one, in between otherwise.
  function _scaleBarUmPerPixel(layer) {
    const u = _scaleBarDirection(layer);
    return _umPerPixelAlong(u.x, u.y, _layerPixelSize(layer));
  }

  function _scaleBarPixelsForValue(layer, unit, value) {
    const px = layer ? _scaleBarUmPerPixel(layer) : _pixelSizeForPoint(NaN, NaN).x;
    return _lengthInPixels(unit, value, px);
  }

  // Image px spanned by `value` `unit` at `umPerPixel` µm per px along the bar.
  function _lengthInPixels(unit, value, umPerPixel) {
    if (unit === 'px') return value;
    if (unit === 'mm') return (value * 1000) / umPerPixel;
    if (unit === 'cm') return (value * 10000) / umPerPixel;
    return value / umPerPixel;
  }

  function _scaleBarValueFromPixels(layer, pixelLength) {
    const px = layer ? _scaleBarUmPerPixel(layer) : _pixelSizeForPoint(NaN, NaN).x;
    const length = Math.max(1, Math.abs(Number(pixelLength) || 1));
    const unit = layer.unit || 'um';
    let umValue = length * px;
    if (unit === 'px') return Math.round(length);
    if (unit === 'mm') umValue = umValue / 1000;
    if (unit === 'cm') umValue = umValue / 10000;
    return _snapScaleBarValue(umValue);
  }

  function _snapScaleBarValue(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) return SCALEBAR_STEP;
    return Math.max(SCALEBAR_STEP, Math.round(numeric / SCALEBAR_STEP) * SCALEBAR_STEP);
  }

  function _measurementLabel(layer) {
    if (layer.type === 'distance') {
      return _isUncalibrated() ? `${_lineLengthUm(layer).toFixed(1)} px` : `${_lineLengthUm(layer).toFixed(2)} um`;
    }
    if (layer.type === 'angle') return `${_angleDegrees(layer).toFixed(1)} deg`;
    if (layer.type === 'scalebar') return `${_snapScaleBarValue(layer.value || 100)} ${layer.unit || 'um'}`;
    return layer.text || '';
  }

  function _updateMeasurementText(layer) {
    if (['distance', 'angle', 'scalebar'].includes(layer.type)) layer.text = _measurementLabel(layer);
  }

  /**
   * A calibration {x, y} in µm per px that every measurement can divide and multiply
   * by: each axis finite and > 0, a missing or unusable y taken as x (square pixels),
   * nothing usable at all → 1 µm/px. A calibration that is already sound is returned
   * as it is (the same object).
   */
  function _normalizePixelSize(px) {
    const x = Number(px?.x);
    const y = Number(px?.y);
    const okX = Number.isFinite(x) && x > 0;
    const okY = Number.isFinite(y) && y > 0;
    if (okX && okY && px && typeof px === 'object') return px;
    const sx = okX ? x : (okY ? y : 1);
    return { x: sx, y: okY ? y : sx };
  }

  function _pixelSizeForPoint(x, y) {
    if (_doc?.layoutMaps?.length) {
      const map = _doc.layoutMaps.find(m => x >= m.x && x <= m.x + m.w && y >= m.y && y <= m.y + m.h);
      if (map && map.pixelSizeUm) return _normalizePixelSize(map.pixelSizeUm);
    }
    // No physical scale: lengths are counted in image pixels (a volume without voxel
    // calibration still carries a nominal µm/px that is not one).
    if (_isUncalibrated()) return { x: 1, y: 1 };
    return _normalizePixelSize(_doc?.calibration?.pixelSizeUm);
  }

  /**
   * The calibration a point layer (distance, scale bar, angle, line, arrow) measures
   * with. A single slice has one. In a Compare figure every cell has its own, and the
   * layer takes the one of the cell under the middle of its stored points — the
   * midpoint of its two ends, the centroid of an angle's three — else of the nearest
   * cell (a middle in the gutter between cells). That middle is the centre every turn
   * of the layer is made about (_layerRotationCentre), so turning a layer never hands
   * it to a neighbouring cell's µm/px, as reading it under x1 did once a turn carried
   * x1 over a cell edge. A scale bar's far end is derived (x1 + u·L) but its stored copy
   * (x2, y2) is rewritten by every change of the bar (_setScaleBarEnd, the turn), so its
   * middle is read without the length it calibrates; with no stored end, x1.
   */
  function _layerPixelSize(layer) {
    if (!_doc?.layoutMaps?.length) return _pixelSizeForPoint(layer?.x1, layer?.y1);
    if (layer?.type === 'scalebar') {
      const cell = _scaleBarCell(layer);
      if (cell) return _normalizePixelSize(cell.pixelSizeUm);
    }
    const points = (layer?.type === 'angle' ? ['1', '2', '3'] : ['1', '2'])
      .map(n => ({ x: Number(layer?.[`x${n}`]), y: Number(layer?.[`y${n}`]) }))
      .filter(p => Number.isFinite(p.x) && Number.isFinite(p.y));
    const middle = points.length ? _centroid(points) : null;
    const cell = middle ? _nearestCell(middle.x, middle.y) : null;
    return cell ? _normalizePixelSize(cell.pixelSizeUm) : _pixelSizeForPoint(layer?.x1, layer?.y1);
  }

  /**
   * The Compare cell that calibrates a scale bar. Its middle x1 + u·L(c)/2 depends on the
   * length L(c) the cell's own µm/px gives, so the stored (x2, y2) — the end written with
   * the previous choice — cannot decide it: two cells of different calibration would hand
   * the bar to each other at every rewrite. The bar belongs to a cell c whose own length
   * puts the middle in c (nearest cell, gutters included); the cell of the stored middle
   * is tried first, so a bar that satisfies it keeps it (a turn about the middle, a value
   * edit). When no cell is self-consistent (a start near an edge, the cells' lengths each
   * throwing the middle into the other) the cell of the start point decides: it does not
   * move when the far end is rewritten, so the choice cannot flip back and forth.
   */
  function _scaleBarCell(layer) {
    const x1 = Number(layer?.x1);
    const y1 = Number(layer?.y1);
    if (!Number.isFinite(x1) || !Number.isFinite(y1)) return null;
    const u = _scaleBarDirection(layer);
    const unit = layer.unit || 'um';
    const value = layer.value || 100;
    const x2 = Number(layer.x2);
    const y2 = Number(layer.y2);
    const previous = Number.isFinite(x2) && Number.isFinite(y2)
      ? _nearestCell((x1 + x2) / 2, (y1 + y2) / 2)
      : _nearestCell(x1, y1);
    const candidates = [previous, ...(_doc?.layoutMaps || []).filter(m => m?.pixelSizeUm && m !== previous)];
    for (const cell of candidates) {
      if (!cell?.pixelSizeUm) continue;
      const length = _lengthInPixels(unit, value, _umPerPixelAlong(u.x, u.y, cell.pixelSizeUm));
      if (_nearestCell(x1 + u.x * length / 2, y1 + u.y * length / 2) === cell) return cell;
    }
    return _nearestCell(x1, y1);
  }

  // The calibrated Compare cell a point lies in (the first, as _pixelSizeForPoint), or
  // the nearest one: squared distance to the cell rectangle, 0 inside it.
  function _nearestCell(x, y) {
    let best = null;
    let bestDist = Infinity;
    (_doc?.layoutMaps || []).forEach(m => {
      if (!m?.pixelSizeUm) return;
      const dx = Math.max(m.x - x, 0, x - (m.x + m.w));
      const dy = Math.max(m.y - y, 0, y - (m.y + m.h));
      const dist = dx * dx + dy * dy;
      if (dist < bestDist) {
        best = m;
        bestDist = dist;
      }
    });
    return best;
  }

  function _lineLengthUm(layer) {
    const p = _linePoints(layer);
    const px = _layerPixelSize(layer);
    return Math.hypot((p.x2 - p.x1) * px.x, (p.y2 - p.y1) * px.y);
  }

  function _angleDegrees(layer) {
    const px = _layerPixelSize(layer);
    const dx1 = (layer.x2 - layer.x1) * px.x;
    const dy1 = (layer.y2 - layer.y1) * px.y;
    const dx2 = (layer.x3 - layer.x1) * px.x;
    const dy2 = (layer.y3 - layer.y1) * px.y;
    const a1 = Math.atan2(dy1, dx1);
    const a2 = Math.atan2(dy2, dx2);
    return Math.abs(_angleDelta(a1, a2)) * 180 / Math.PI;
  }

  function _angleDelta(a1, a2) {
    let delta = a2 - a1;
    while (delta > Math.PI) delta -= Math.PI * 2;
    while (delta < -Math.PI) delta += Math.PI * 2;
    return delta;
  }

  function _isBoxLayer(layer) {
    return BOX_LAYER_TYPES.includes(layer?.type);
  }

  function _layerRotationDeg(layer) {
    return _normalizeRotationDeg(layer?.rotation);
  }

  function _layerRotationRad(layer) {
    return _layerRotationDeg(layer) * Math.PI / 180;
  }

  // The unrotated box of a box layer (a negative w/h drawn right-to-left is folded).
  function _layerBox(layer) {
    return {
      x: Math.min(layer.x, layer.x + (layer.w || 0)),
      y: Math.min(layer.y, layer.y + (layer.h || 0)),
      w: Math.abs(layer.w || 1),
      h: Math.abs(layer.h || 1)
    };
  }

  // Axis-aligned bounds in image space (minimap, align, snapping): a turned box is
  // bounded as turned.
  function _layerBounds(layer) {
    if (_isBoxLayer(layer)) {
      return _rotatedBoxAabb(_layerBox(layer), _layerRotationRad(layer));
    }
    const points = _handlesForGeometry(layer);
    const xs = points.map(p => p.x);
    const ys = points.map(p => p.y);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    return { x: minX, y: minY, w: Math.max(1, maxX - minX), h: Math.max(1, maxY - minY) };
  }

  function _eventCanvasPoint(event) {
    const rect = _canvas.getBoundingClientRect();
    return {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top
    };
  }

  function _handlesForGeometry(layer) {
    if (['line', 'arrow', 'distance', 'scalebar'].includes(layer.type)) {
      const p = _linePoints(layer);
      return [{ x: p.x1, y: p.y1 }, { x: p.x2, y: p.y2 }];
    }
    if (layer.type === 'angle') {
      return [{ x: layer.x1, y: layer.y1 }, { x: layer.x2, y: layer.y2 }, { x: layer.x3, y: layer.y3 }];
    }
    return [{ x: layer.x || 0, y: layer.y || 0 }];
  }

  function _screenToImage(point) {
    const v = _doc.viewport;
    let x = point.x - v.panX;
    let y = point.y - v.panY;
    const cos = Math.cos(-v.rotation);
    const sin = Math.sin(-v.rotation);
    const rx = x * cos - y * sin;
    const ry = x * sin + y * cos;
    return {
      x: rx / v.zoom + _sliceImage.width / 2,
      y: ry / v.zoom + _sliceImage.height / 2
    };
  }

  function _imageToScreen(point) {
    const v = _doc.viewport;
    const x = point.x - _sliceImage.width / 2;
    const y = point.y - _sliceImage.height / 2;
    const cos = Math.cos(v.rotation);
    const sin = Math.sin(v.rotation);
    return {
      x: (x * cos - y * sin) * v.zoom + v.panX,
      y: (x * sin + y * cos) * v.zoom + v.panY
    };
  }

  function _pushHistory(label) {
    if (!_doc) return;
    _doc.updatedAt = new Date().toISOString();
    _history.push({ label, doc: _clone(_doc) });
    if (_history.length > 80) _history.shift();
    _future = [];
  }

  function _undo() {
    if (_history.length <= 1) return;
    const previous = _doc;
    _future.push(_history.pop());
    _doc = _clone(_history[_history.length - 1].doc);
    _selectedId = null;
    // The picture follows the channels of the document it shows again (an undone
    // import puts its colours back).
    _recolourForDocChange(previous);
    _renderAll();
  }

  function _redo() {
    if (!_future.length) return;
    // The entry undo set aside is already a copy nobody edits: it goes back as it is
    // (a JSON copy of it would stringify every Compare cell's raw buffer).
    const previous = _doc;
    const item = _future.pop();
    _history.push(item);
    _doc = _clone(item.doc);
    _selectedId = null;
    _recolourForDocChange(previous);
    _renderAll();
  }

  // One step of history for an edit made in the properties panel. The panel already
  // shows the new values: it is updated in place (the readout) rather than rebuilt, so
  // the control being used keeps the keyboard focus between two arrow presses.
  function _commitPropertyChange() {
    _pushHistory('Edit properties');
    _draw();
    _renderLayers();
    const layer = _selectedLayer();
    const readout = _propsContainer?.querySelector('.studio-measurement-readout');
    if (layer && readout) readout.textContent = _measurementLabel(layer) || '';
  }

  function _bindProperty(id, eventName, setter, options = {}) {
    const node = document.getElementById(id);
    if (!node) return;
    node.addEventListener(eventName, event => {
      setter(event.target.value);
      _requestDraw();
      // Only the name shows in the layer list.
      if (options.relist) _renderLayers();
    });
    node.addEventListener('change', _commitPropertyChange);
  }

  function _bindScaleBarValueProperty(layer) {
    const node = document.getElementById('prop-scalebar-value');
    if (!node) return;
    const applyValue = (commit) => {
      layer.value = _snapScaleBarValue(node.value);
      node.value = layer.value;
      _setScaleBarEnd(layer);
      _updateMeasurementText(layer);
      if (commit) _commitPropertyChange();
      else _requestDraw();
    };
    node.addEventListener('input', () => applyValue(false));
    node.addEventListener('change', () => applyValue(true));
  }

  // Slider and degree field drive the same angle. 'input' previews, 'change' commits one
  // step of history; every preview of one edit starts from the snapshot taken at its
  // first event, so a point layer is never turned by a sum of small float rotations.
  // A commit updates the controls where they are (never a panel rebuild, which would
  // take the keyboard focus away from the slider between two arrow presses).
  function _bindRotationProperty(layer) {
    const slider = document.getElementById('prop-rotation');
    const field = document.getElementById('prop-rotation-num');
    const reset = document.getElementById('prop-rotation-reset');
    if (!slider || !field) return;
    let snapshot = null;
    const apply = (raw, commit, source) => {
      if (layer.locked === true) return;
      const text = String(raw ?? '').trim();
      const value = Number(text);
      if (text === '' || !Number.isFinite(value)) {
        // An edit that ends on nothing usable (the field emptied, a lone '-') puts the
        // layer back as it was before its previews, and leaves no history step.
        if (!commit) return;
        if (snapshot) _rotateLayerFromSnapshot(layer, snapshot, _layerRotationDeg(snapshot));
        snapshot = null;
        _writeRotationControls(layer, slider, field);
        _draw();
        return;
      }
      if (!snapshot) snapshot = _clone(layer);
      _rotateLayerFromSnapshot(layer, snapshot, value);
      // The slider being dragged is left where the operator put it: −180 and 180 are
      // one angle, spelled 180, and writing that back throws the thumb to the far end.
      // The field is not rewritten under the operator's typing ('-' on the way to '-30').
      _writeRotationControls(layer, source === slider ? null : slider, (source !== field || commit) ? field : null);
      _draw();
      if (!commit) return;
      const turned = _layerRotationDeg(snapshot) !== _layerRotationDeg(layer);
      snapshot = null;
      if (turned) _pushHistory('Rotate layer');
    };
    slider.addEventListener('input', () => apply(slider.value, false, slider));
    slider.addEventListener('change', () => apply(slider.value, true, slider));
    field.addEventListener('input', () => apply(field.value, false, field));
    field.addEventListener('change', () => apply(field.value, true, field));
    reset?.addEventListener('click', () => apply(0, true, reset));
  }

  // The layer's angle into the rotation controls given (null = leave that one), and its
  // measurement into the readout.
  function _writeRotationControls(layer, slider, field) {
    const deg = _formatDeg(_layerRotationDeg(layer));
    if (slider) slider.value = deg;
    if (field) field.value = deg;
    const readout = _propsContainer?.querySelector('.studio-measurement-readout');
    if (readout) readout.textContent = _measurementLabel(layer) || '';
  }

  // The properties panel updated in place after a turn made elsewhere; false when the
  // panel does not show this layer's rotation controls (then it is rebuilt).
  function _syncRotationControls(layer) {
    const holder = _propsContainer?.querySelector('.studio-rotation-prop');
    if (!holder || holder.getAttribute('data-layer-id') !== String(layer.id)) return false;
    _writeRotationControls(layer, document.getElementById('prop-rotation'), document.getElementById('prop-rotation-num'));
    return true;
  }

  // Keyboard rotation. A held key repeats: the whole hold is one step of history.
  function _rotateSelectedBy(stepDeg, coalesce) {
    const layer = _selectedLayer();
    if (!layer || layer.locked === true) return false;
    _rotateLayerFromSnapshot(layer, _clone(layer), _layerRotationDeg(layer) + stepDeg);
    const top = _history[_history.length - 1];
    if (coalesce && _history.length > 1 && top?.label === 'Rotate layer' && top.layerId === layer.id) {
      _doc.updatedAt = new Date().toISOString();
      top.doc = _clone(_doc);
      _future = [];
    } else {
      _pushHistory('Rotate layer');
      _history[_history.length - 1].layerId = layer.id;
    }
    _draw();
    if (!_syncRotationControls(layer)) _renderProperties();
    return true;
  }

  function _deleteSelected() {
    if (!_doc || !_selectedId) return;
    _doc.layers = _doc.layers.filter(layer => layer.id !== _selectedId);
    _selectedId = null;
    _pushHistory('Delete layer');
    _renderAll();
  }

  function _alignSelected(mode) {
    const layer = _selectedLayer();
    if (!layer) return;
    const box = _layerBounds(layer);
    const target = mode === 'left' ? 0 : mode === 'right' ? _doc.sourceSlice.width - box.w : (_doc.sourceSlice.width - box.w) / 2;
    _moveLayerTo(layer, _clone(layer), target - box.x, 0);
    _pushHistory('Align layer');
    _renderAll();
  }

  function _groupSelected() {
    const layer = _selectedLayer();
    if (!layer) return;
    const groupId = layer.groupId || `group_${Date.now().toString(36)}`;
    if (!layer.groupId) _doc.groups.push({ id: groupId, name: `Group ${_doc.groups.length + 1}`, collapsed: false });
    layer.groupId = layer.groupId ? null : groupId;
    _pushHistory('Toggle group');
    _renderAll();
  }

  function _openPalette() {
    _palette?.classList.remove('hidden');
    _renderPaletteCommands();
    document.getElementById('studio-command-input')?.focus();
  }

  function _closePalette() {
    _palette?.classList.add('hidden');
  }

  function _renderPaletteCommands() {
    const list = document.getElementById('studio-command-list');
    const input = document.getElementById('studio-command-input');
    if (!list) return;
    const query = String(input?.value || '').toLowerCase();
    const commands = [
      ['tool-select', 'Select tool'],
      ['tool-distance', 'Distance tool'],
      ['tool-angle', 'Angle tool'],
      ['tool-scalebar', 'Scale bar tool'],
      ['fit', 'Fit image'],
      ['undo', 'Undo'],
      ['redo', 'Redo'],
      ['add-guide-x', 'Toggle vertical guide'],
      ['add-guide-y', 'Toggle horizontal guide'],
      ['export-json', 'Export JSON'],
      ['export-png', 'Export PNG']
    ].filter(([, label]) => label.toLowerCase().includes(query));
    list.innerHTML = commands.map(([id, label]) => `<button data-command="${id}">${_escape(label)}</button>`).join('');
  }

  function _runCommand(command) {
    if (command?.startsWith('tool-')) _setTool(command.replace('tool-', ''));
    if (command === 'fit') _fitImageToViewport();
    if (command === 'undo') _undo();
    if (command === 'redo') _redo();
    if (command === 'add-guide-x') _toggleGuide('x');
    if (command === 'add-guide-y') _toggleGuide('y');
    if (command === 'export-json') _exportJson();
    if (command === 'export-png') _exportPng();
    _closePalette();
    _renderAll();
  }

  function _toggleGuide(axis) {
    if (!_doc) return;
    const exists = _doc.guides.some(g => g.axis === axis);
    if (exists) {
      _doc.guides = _doc.guides.filter(g => g.axis !== axis);
      _pushHistory(`Remove guide ${axis.toUpperCase()}`);
    } else {
      _doc.guides.push({
        axis,
        value: axis === 'x' ? _doc.sourceSlice.width / 2 : _doc.sourceSlice.height / 2
      });
      _pushHistory(`Add guide ${axis.toUpperCase()}`);
    }
    // Re-render props panel so button active state updates immediately
    _renderProperties();
  }

  // The export is the picture the Studio shows, as coloured: the slice it holds is the
  // best the page produced (viewer.js upgrades it to native in place), so nothing is
  // re-rendered here.
  function _exportPng() {
    if (!_doc || !_sliceResult) return;
    // A channel edit still waiting for its frame is part of the figure being exported.
    _flushChannelRecompose();
    const width = Number(_sliceImage?.width) || Number(_sliceResult.width) || 0;
    const height = Number(_sliceImage?.height) || Number(_sliceResult.height) || 0;
    if (!(width > 0 && height > 0) || width > EXPORT_MAX_SIDE || height > EXPORT_MAX_SIDE || width * height > EXPORT_MAX_PIXELS) {
      _toast(_t('studio.exportTooLarge', `This figure is too large to export as one PNG (${width} × ${height} px).`, { w: width, h: height }));
      return;
    }
    _toast(_t('toast.renderingNative', 'Rendering native export...'));
    let source = _sliceResult;

    if (_doc.layoutMaps?.length > 0) {
      // Compare: every cell recomposed at full resolution (not the interactive,
      // cell-sized render of a drag).
      _rerenderSliceFromChannels(undefined);
      source = {
        canvas: _sliceImage,
        width: _sliceImage.width,
        height: _sliceImage.height
      };
    } else if (_sliceImage && _sliceImage !== _sliceResult.canvas) {
      // A single slice re-coloured since it was handed over.
      source = { ..._sliceResult, canvas: _sliceImage, width: _sliceImage.width, height: _sliceImage.height };
    }

    let canvas;
    try {
      canvas = _composeExportCanvas(source, { metadataStamp: true });
    } catch (err) {
      console.warn('[StudioEditor] PNG export failed:', err);
      _toast(_t('studio.exportPngFailed', 'The PNG could not be written (the browser refused a canvas this large).'));
      return;
    }
    // The export canvas is the figure at full size (256 MB at 8192²): its pixels go
    // back as soon as the encoder is done with them.
    const releaseCanvas = () => {
      canvas.width = 0;
      canvas.height = 0;
    };
    try {
      canvas.toBlob(blob => {
        releaseCanvas();
        if (!blob) {
          _toast(_t('studio.exportPngFailed', 'The PNG could not be written (the browser refused a canvas this large).'));
          return;
        }
        ExportManager?.downloadBlob?.(blob, `${_exportBaseName()}_studio.png`);
      }, 'image/png', 1);
    } catch (err) {
      releaseCanvas();
      console.warn('[StudioEditor] PNG export failed:', err);
      _toast(_t('studio.exportPngFailed', 'The PNG could not be written (the browser refused a canvas this large).'));
    }
  }

  // A composite of several panels is not "the slice" of any single dataset: it is
  // named after the figure the compare page handed over.
  function _exportBaseName() {
    const fallback = _doc?.layoutMaps?.length > 1 ? 'compare_figure' : 'slice';
    return _safeName(_doc?.dataset?.name || fallback);
  }

  function _composeExportCanvas(source, options = {}) {
    const canvas = document.createElement('canvas');
    canvas.width = source.width || source.canvas.width;
    canvas.height = source.height || source.canvas.height;
    const ctx = canvas.getContext('2d');
    const background = options.background || EXPORT_BACKGROUND;
    if (background && background !== 'transparent') {
      ctx.fillStyle = background;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    ctx.drawImage(source.canvas, 0, 0, canvas.width, canvas.height);
    const sx = canvas.width / Math.max(1, _doc.sourceSlice.width);
    const sy = canvas.height / Math.max(1, _doc.sourceSlice.height);
    ctx.save();
    ctx.scale(sx, sy);
    _doc.layers.forEach(layer => {
      if (layer.visible === false) return;
      _drawLayer(ctx, layer, 1 / Math.max(sx, sy));
    });
    ctx.restore();
    if (options.metadataStamp) _drawExportStamp(ctx, canvas.width, canvas.height, source);
    return canvas;
  }

  function _drawExportStamp(ctx, width, height, source) {
    // Each cell of a composite has its own plane and its own µm/px: stamping the
    // document's would caption the whole figure with a fact true of one cell.
    const bits = _doc.layoutMaps?.length > 1
      ? [
        _doc.dataset?.name || 'Slice Studio',
        `${source.width}x${source.height}`
      ]
      : [
        _doc.dataset?.name || 'Slice Studio',
        _planeLabel(_doc.planeSpec),
        `${source.width}x${source.height}`,
        _isUncalibrated()
          ? _t('studio.uncalibrated', 'uncalibrated')
          : `px ${_normalizePixelSize(_doc.calibration.pixelSizeUm).x.toFixed(4)} um`
      ];
    const text = bits.join(' | ');
    ctx.save();
    ctx.font = `${Math.max(12, Math.round(width / 100))}px Inter, Arial, sans-serif`;
    const pad = 10;
    const tw = Math.min(ctx.measureText(text).width, width - 2 * pad);
    ctx.fillStyle = 'rgba(0,0,0,0.62)';
    ctx.fillRect(pad, pad, tw + pad * 2, 28);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(text, pad * 2, pad + 19, width - pad * 4);
    ctx.restore();
  }

  // The plane a figure was cut in, as its caption names it. The Z-stack browser hands
  // its slab over as an oblique plane with axis 'z' and pitch 0 (viewer.js
  // _zstackStudioSpec: the XY slices only turned in their own plane, yaw 180 = seen
  // from the −Z side), so it is named XY; an inspector cut carries no such axis and
  // stays OBLIQUE.
  function _planeLabel(spec) {
    const mode = String(spec?.mode || 'xy').toLowerCase();
    const yaw = Number(spec?.yaw) || 0;
    const flatXY = mode === 'oblique' && spec?.axis === 'z' && !Number(spec?.pitch) && yaw % 180 === 0;
    return `${flatXY ? 'XY' : mode.toUpperCase()} ${spec?.projection || 'single'}`;
  }

  function _exportJson() {
    if (!_doc) return;
    let text;
    try {
      text = JSON.stringify(_portableDocument(_doc), null, 2);
    } catch (err) {
      console.warn('[StudioEditor] Studio JSON export failed:', err);
      _toast(_t('studio.exportJsonFailed', 'The Studio JSON could not be written.'));
      return;
    }
    const blob = new Blob([text], { type: 'application/json' });
    ExportManager?.downloadBlob?.(blob, `${_safeName(_doc.dataset?.name || 'slice')}_studio.json`);
  }

  function _importJson(event) {
    const input = event?.target;
    const file = input?.files?.[0];
    if (!file) return;
    if (Number(file.size) > IMPORT_MAX_BYTES) {
      if (input) input.value = '';
      _toast(_t('studio.importTooLarge', 'This file is too large to be a Studio file (over 5 MB).'));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      try {
        _importDocumentText(reader.result);
      } finally {
        if (input) input.value = '';
      }
    };
    reader.onerror = () => {
      if (input) input.value = '';
      _toast(_t('toast.invalidStudioJson', 'Invalid Studio JSON.'));
    };
    reader.readAsText(file);
  }

  // ── Studio JSON import ───────────────────────────────────
  // A Studio file holds a figure's layers, guides, groups and channel settings, never
  // its pixels, and no Compare cell's frame, raw values or panel slice (see
  // LAYOUT_RUNTIME_KEYS). It is applied to the figure that is OPEN, which keeps its
  // geometry: picture size, plane, calibration, background, Compare cell layout and
  // every cell's runtime fields. The file's channel settings are applied only where the
  // file describes the open figure — the same size, dataset (or figure name), plane and
  // timepoint (see _planImport); then the single slice when it carries raw values, and
  // each Compare cell whose rectangle is the open cell's within
  // IMPORT_MATCH_TOLERANCE_PX — and the picture is coloured with them. A file saved for
  // another figure still brings its annotations, with a warning. The file is read and
  // checked completely before anything changes; if applying it fails anyway, the
  // figure is put back as it was. The import is one step of the history: undo returns
  // to the figure before it, colours included.
  const IMPORT_MATCH_TOLERANCE_PX = 2;
  const IMPORT_SAFE_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
  const IMPORT_LAYER_TYPE = /^[a-z][a-z0-9_-]{0,31}$/i;
  const IMPORT_GEOMETRY_KEYS = ['x', 'y', 'w', 'h', 'x1', 'y1', 'x2', 'y2', 'x3', 'y3'];
  // The coordinates each kind of layer is drawn from: one a file leaves out is 0, so a
  // label or a handle never reads NaN.
  const IMPORT_REQUIRED_GEOMETRY = {
    rectangle: ['x', 'y', 'w', 'h'],
    ellipse: ['x', 'y', 'w', 'h'],
    text: ['x', 'y', 'w', 'h'],
    line: ['x1', 'y1', 'x2', 'y2'],
    arrow: ['x1', 'y1', 'x2', 'y2'],
    distance: ['x1', 'y1', 'x2', 'y2'],
    scalebar: ['x1', 'y1', 'x2', 'y2'],
    angle: ['x1', 'y1', 'x2', 'y2', 'x3', 'y3']
  };
  const IMPORT_STYLE_NUMBERS = { strokeWidth: [0, 200], fontSize: [1, 400], fontWeight: [100, 1000], opacity: [0, 1] };
  const IMPORT_STYLE_COLORS = ['stroke', 'fill'];
  const IMPORT_STYLE_FLAGS = ['textBackground', 'fillEnabled'];
  const IMPORT_CAPS = ['none', 'arrow', 'bar', 'dot'];
  const IMPORT_UNITS = ['um', 'mm', 'cm', 'px'];
  // A style value this version does not know is kept only if it is harmless wherever it
  // may be written: a flag, a finite number, or a short plain token.
  const IMPORT_STYLE_TOKEN = /^[#\w\s.,()%-]{0,64}$/;
  const IMPORT_CHANNEL_NUMBERS = ['min', 'max', 'midtone', 'gamma', 'opacity', 'denoise_sigma'];

  /** Applies the text of a Studio file to the open figure; false when nothing changed. */
  function _importDocumentText(text) {
    if (!_isOpen || !_doc || !_sliceImage) return false;
    // A channel edit still waiting for its frame belongs to the figure as it is now.
    _flushChannelRecompose();
    let plan;
    try {
      const source = String(text ?? '');
      if (source.length > IMPORT_MAX_BYTES) throw new Error('Studio JSON: the file is too large.');
      plan = _planImport(_migrateDocument(JSON.parse(source)));
    } catch (err) {
      console.warn('[StudioEditor] Invalid Studio JSON:', err);
      _toast(_t('toast.invalidStudioJson', 'Invalid Studio JSON.'));
      return false;
    }
    const before = {
      doc: _doc, history: _history, future: _future, selectedId: _selectedId,
      sliceResult: _sliceResult, sliceImage: _sliceImage
    };
    try {
      _doc = plan.doc;
      _selectedId = null;
      _drawing = null;
      _recolourForImport(plan);
      // One more step of the open figure's history (a copy, so a failure below leaves
      // it as it was): undo goes back to the figure before the import, its colours
      // included (_recolourForDocChange).
      _history = before.history.slice();
      _pushHistory('Import JSON');
      _renderAll();
    } catch (err) {
      console.warn('[StudioEditor] Studio JSON import failed; the figure is kept as it was:', err);
      const importedImage = _sliceImage;
      _doc = before.doc;
      _history = before.history;
      _future = before.future;
      _selectedId = before.selectedId;
      _sliceResult = before.sliceResult;
      _sliceImage = before.sliceImage;
      try {
        // Only a picture the import redrew IN PLACE needs its colours back; one it
        // left alone (the figure compare.js handed over, the import drawing on a copy)
        // is exact as it is, and re-rendering its cells would replace it.
        if (plan.recolourStarted && _importRedrewInPlace(before, importedImage)) {
          _recolourPicture(plan.recolourCells, plan.recolourSlice);
        }
        _renderAll();
      } catch (restoreErr) {
        console.warn('[StudioEditor] Could not redraw the figure after a failed import:', restoreErr);
      }
      // A Compare figure copy the failed import made and nothing shows any more.
      if (_doc.layoutMaps?.length && importedImage && importedImage !== _sliceImage
        && importedImage !== before.sliceImage && importedImage !== _sliceResult?.canvas) {
        importedImage.width = 0;
        importedImage.height = 0;
      }
      _toast(_t('toast.invalidStudioJson', 'Invalid Studio JSON.'));
      return false;
    }
    if (plan.mismatch) {
      _toast(_t('studio.importOtherFigure', 'This Studio file was saved for another figure: its annotations were imported, but its channel settings were applied only where the figure matches.'));
    } else if (plan.channelsKept) {
      _toast(_t('studio.importChannelsKept', 'The annotations were imported. This picture has no raw channel values to recolour, so it keeps its channel settings.'));
    }
    return true;
  }

  /**
   * Whether the failed import drew on the very canvas the figure shows again: the
   * Studio's own copy of a Compare figure (the cells are redrawn on it in place; the
   * figure compare.js handed over is only ever copied), or a single slice's picture
   * the import coloured into again (the Studio's slice canvas, or whatever canvas the
   * import's picture was).
   */
  function _importRedrewInPlace(before, importedImage) {
    if (before.doc.layoutMaps?.length) return before.sliceImage !== before.sliceResult?.canvas;
    return before.sliceImage === importedImage || (Boolean(_sliceCanvas) && before.sliceImage === _sliceCanvas);
  }

  /**
   * The document the open figure becomes with `file` (the checked content of a Studio
   * file, from _migrateDocument): the open document — geometry, calibration, viewport,
   * every Compare cell with its runtime fields by reference — carrying the file's
   * layers, guides and groups, and its channel settings where it matches. Measurements
   * are re-read against the open figure's calibration: a scale bar keeps its value, a
   * distance and an angle their points. Pure: the open document is not touched.
   *   The file is this figure when it has its size, names the same dataset (id or
   * path; the figure's name when neither side has one — a Compare figure is named by
   * its panels' datasets, in order), shows the same plane and the same timepoint, and,
   * for a Compare figure, has the same cells. A channel's name is taken from the file
   * only when both name the same dataset. Channel settings are applied to the single
   * slice only when it can be recoloured without changing its frame (it carries raw
   * values; channelsKept otherwise), and a cell or slice is recoloured only when its
   * settings actually change.
   */
  function _planImport(file) {
    const open = _doc;
    const openMaps = Array.isArray(open.layoutMaps) ? open.layoutMaps : [];
    const fileMaps = file.layoutMaps;
    const identity = _importFigureIdentity(file.dataset, open.dataset);
    let figureMatches = _sameImportSize(file.sourceSlice, open.sourceSlice)
      && identity.same
      && _sameImportPlane(file.planeSpec, open.planeSpec)
      && _sameImportTimepoint(file.timepoint, open.timepoint);
    // A single slice and a Compare composite are never the same figure.
    if (fileMaps && (fileMaps.length > 0) !== (openMaps.length > 0)) figureMatches = false;
    let mismatch = !figureMatches;
    const merge = (saved, current) => _mergeImportedChannels(saved, current, { names: identity.confirmed });

    const doc = _clone(open);
    doc.version = DOC_VERSION;
    if (file.createdAt) doc.createdAt = file.createdAt;
    doc.layers = file.layers;
    doc.guides = file.guides;
    doc.groups = file.groups;

    let recolourSlice = false;
    let channelsKept = false;
    const recolourCells = [];
    if (!openMaps.length) {
      if (figureMatches && file.channelState) {
        const merged = merge(file.channelState, open.channelState);
        if (!_sameChannels(merged, open.channelState)) {
          // Without raw values the slice is re-rendered through the slicer, a frame of
          // another size and crop than the one the annotations are laid on.
          if (_hasRaw(_sliceResult)) {
            doc.channelState = merged;
            recolourSlice = true;
          } else {
            channelsKept = true;
          }
        }
      }
    } else if (figureMatches && fileMaps) {
      if (fileMaps.length !== openMaps.length) {
        mismatch = true;
      } else {
        openMaps.forEach((cell, index) => {
          const saved = fileMaps[index];
          if (!_sameImportCell(saved, cell)) {
            mismatch = true;
            return;
          }
          if (!saved.channelState) return;
          const merged = merge(saved.channelState, cell.channelState);
          if (_sameChannels(merged, cell.channelState)) return;
          doc.layoutMaps[index].channelState = merged;
          recolourCells.push(index);
        });
      }
      if (!mismatch && file.channelState) {
        doc.channelState = merge(file.channelState, open.channelState);
      }
    }

    // Read against the open document, whose layout and calibration `doc` shares.
    doc.layers.forEach(layer => {
      if (layer.type === 'scalebar') _setScaleBarEnd(layer);
      _updateMeasurementText(layer);
    });
    return { doc, mismatch, channelsKept, recolourSlice, recolourCells, recolourStarted: false };
  }

  // The picture coloured with the current document's channels where an import applied
  // them: those Compare cells, or the single slice from its raw values (same frame).
  function _recolourForImport(plan) {
    plan.recolourStarted = plan.recolourCells.length > 0 || plan.recolourSlice;
    _recolourPicture(plan.recolourCells, plan.recolourSlice);
  }

  /** Re-colours the Compare cells `cells` (indices) or, with `slice`, the single slice, with _doc's channels. */
  function _recolourPicture(cells, slice) {
    if (_doc.layoutMaps?.length) {
      (cells || []).forEach(index => _rerenderSliceFromChannels(index));
      return;
    }
    if (!slice || !_hasRaw(_sliceResult)) return;
    const prepared = _prepareSliceForStudio(_sliceResult, _doc.channelState);
    if (!prepared?.canvas) return;
    if (prepared.width !== _doc.sourceSlice.width || prepared.height !== _doc.sourceSlice.height) return;
    _sliceResult = prepared;
    _sliceImage = prepared.canvas;
    _draw();
  }

  /**
   * After undo / redo: the picture takes the colours of the document it shows now
   * where they differ from those of `previous` — each Compare cell whose channels
   * changed, and the single slice when it carries raw values (re-coloured in place,
   * same frame; one without them keeps its picture: a re-render would re-crop it).
   */
  function _recolourForDocChange(previous) {
    if (!previous || !_doc) return;
    if (_doc.layoutMaps?.length) {
      const changed = [];
      _doc.layoutMaps.forEach((cell, index) => {
        if (!_sameChannels(cell?.channelState, previous.layoutMaps?.[index]?.channelState)) changed.push(index);
      });
      _recolourPicture(changed, false);
      return;
    }
    if (!_sameChannels(_doc.channelState, previous.channelState)) _recolourPicture(null, true);
  }

  function _sameChannels(a, b) {
    return JSON.stringify(Array.isArray(a) ? a : []) === JSON.stringify(Array.isArray(b) ? b : []);
  }

  function _sameImportSize(saved, open) {
    if (!saved) return true;
    return _nearImport(saved.width, open?.width) && _nearImport(saved.height, open?.height);
  }

  function _sameImportCell(saved, open) {
    if (!saved || !open) return false;
    if (!['x', 'y', 'w', 'h'].every(key => _nearImport(saved[key], open[key]))) return false;
    return _sameImportIdentity(
      _importIdentity(saved.dataset) || _importToken(saved.datasetId),
      _importIdentity(open.dataset) || _importToken(open.datasetId)
    );
  }

  function _nearImport(a, b) {
    const x = Number(a);
    const y = Number(b);
    return typeof a === 'number' && Number.isFinite(x) && Number.isFinite(y) && Math.abs(x - y) <= IMPORT_MATCH_TOLERANCE_PX;
  }

  // A dataset is named by its id (or path); two figures that both name one must name
  // the same.
  function _importIdentity(dataset) {
    return _importToken(dataset?.id) || _importToken(dataset?.path);
  }

  function _importToken(value) {
    return typeof value === 'string' && value ? value : null;
  }

  function _sameImportIdentity(a, b) {
    return !a || !b || a === b;
  }

  /**
   * Whether the file's figure and the open one show the same dataset: `same` false
   * when they name different ones, `confirmed` when both name the same. A figure is
   * named by its dataset's id or path; when neither side has one, by the figure's
   * name — a Compare figure has no id, and its name lists its panels' datasets in
   * order ('Em1 vs Em2'), so another pair (or the same pair swapped) with cells of the
   * same size is not taken for it. A side that names nothing makes no claim.
   */
  function _importFigureIdentity(fileDataset, openDataset) {
    const a = _importIdentity(fileDataset);
    const b = _importIdentity(openDataset);
    if (a && b) return { same: a === b, confirmed: a === b };
    if (a || b) return { same: true, confirmed: false };
    const nameA = _importToken(fileDataset?.name);
    const nameB = _importToken(openDataset?.name);
    if (nameA && nameB) return { same: nameA === nameB, confirmed: nameA === nameB };
    return { same: true, confirmed: false };
  }

  // The plane a figure shows, compared on the keys that place it; a key only one side
  // gives makes no claim. Every z-stack slab of a dataset has the same crop, so the
  // size alone does not tell slice 10 from slice 40.
  const IMPORT_PLANE_NUMBERS = { value: 1e-6, yaw: 1e-3, pitch: 1e-3, roll: 1e-3, slabThickness: 0, slabStepNorm: 1e-9 };
  const IMPORT_PLANE_ANGLES = ['yaw', 'pitch', 'roll'];

  function _sameImportPlane(saved, open) {
    if (!_isPlainObject(saved) || !_isPlainObject(open)) return true;
    for (const key of ['mode', 'axis', 'projection']) {
      if (typeof saved[key] === 'string' && typeof open[key] === 'string' && saved[key] !== open[key]) return false;
    }
    return Object.keys(IMPORT_PLANE_NUMBERS).every(key => {
      const a = saved[key];
      const b = open[key];
      if (typeof a !== 'number' || typeof b !== 'number' || !Number.isFinite(a) || !Number.isFinite(b)) return true;
      let d = a - b;
      if (IMPORT_PLANE_ANGLES.includes(key)) d = ((d % 360) + 540) % 360 - 180;
      return Math.abs(d) <= IMPORT_PLANE_NUMBERS[key];
    });
  }

  function _sameImportTimepoint(saved, open) {
    const finite = v => typeof v === 'number' && Number.isFinite(v);
    return !finite(saved) || !finite(open) || saved === open;
  }

  /**
   * The file's channel settings over the open figure's, channel by channel: the open
   * figure decides how many channels there are, a channel the file does not describe
   * (missing, null, shorter list) keeps its settings, and a setting the file gives with
   * the wrong type is ignored. A channel's name comes from the file only with
   * `options.names` (both figures name the same dataset). The numbers of a channel the
   * file describes are brought into the ranges the channel panel keeps
   * (_normalizeImportedChannel), so the picture is coloured with what the panel shows.
   */
  function _mergeImportedChannels(saved, current, options = {}) {
    const own = Array.isArray(current) ? current : [];
    const file = Array.isArray(saved) ? saved : [];
    const count = own.length || file.length;
    const merged = [];
    for (let i = 0; i < count; i++) {
      const channel = _isPlainObject(own[i]) ? _clone(own[i]) : {};
      const item = _isPlainObject(file[i]) ? file[i] : null;
      if (item) {
        const given = new Set();
        IMPORT_CHANNEL_NUMBERS.forEach(key => {
          if (typeof item[key] === 'number' && Number.isFinite(item[key])) {
            channel[key] = item[key];
            given.add(key);
          }
        });
        if (given.size) _normalizeImportedChannel(channel, given);
        if (_isImportColor(item.color)) channel.color = item.color;
        if (options.names && typeof item.name === 'string' && item.name) channel.name = item.name;
        const on = item.enabled !== undefined ? item.enabled : item.active;
        if (typeof on === 'boolean') channel.enabled = on;
        if (typeof item.expanded === 'boolean') channel.expanded = item.expanded;
        if (typeof item.filterBackground === 'boolean') channel.filterBackground = item.filterBackground;
      }
      merged.push(channel);
    }
    return merged;
  }

  /**
   * One channel's numbers as ChannelPanel.setState keeps them (the Studio's panel
   * shows what setState makes of the document; the compositor colours with the
   * document itself, so both must hold the same values): min ∈ [0, 0.99],
   * max ∈ [min + 0.01, 1], opacity ∈ [0.05, 1], denoise_sigma ≥ 0, and the midtone
   * inside the window, [min + 0.01, max − 0.01], with the gamma it implies,
   *   gamma = clamp(ln ½ / ln r, 0.18, 5.5),  r = (midtone − min) / (max − min)
   * (the panel reads a midtone first and derives the gamma; a gamma within 1e-6 of it
   * is kept as the file wrote it). A gamma the file gives without a midtone is
   * clamped to [0.18, 5.5] and, when the channel has a midtone, moves it to
   * min + ½^(1/gamma)·(max − min): pow(0, 0) = 1 made a gamma of 0 paint the whole
   * picture in the channel's colour. `given`: the numeric keys the file set.
   */
  function _normalizeImportedChannel(channel, given) {
    const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
    const num = (v, fallback) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
    const min = Math.min(clamp(num(channel.min, 0), 0, 1), 0.99);
    const max = clamp(Math.max(clamp(num(channel.max, 1), 0, 1), min + 0.01), 0, 1);
    channel.min = min;
    channel.max = max;
    if ('opacity' in channel) channel.opacity = clamp(num(channel.opacity, 1), 0.05, 1);
    if ('denoise_sigma' in channel) channel.denoise_sigma = Math.max(0, num(channel.denoise_sigma, 0));
    if (given.has('gamma') && !given.has('midtone')) {
      channel.gamma = clamp(channel.gamma, 0.18, 5.5);
      if (Number.isFinite(channel.midtone)) channel.midtone = min + Math.pow(0.5, 1 / channel.gamma) * (max - min);
    }
    if (typeof channel.midtone === 'number' && Number.isFinite(channel.midtone)) {
      const midtone = clamp(clamp(channel.midtone, 0, 1), min + 0.01, max - 0.01);
      const relative = clamp((midtone - min) / Math.max(0.001, max - min), 0, 1);
      const gamma = Math.max(0.18, Math.min(5.5, Math.log(0.5) / Math.log(clamp(relative, 0.001, 0.999))));
      channel.midtone = midtone;
      if (!(Math.abs(num(channel.gamma, NaN) - gamma) <= 1e-6 * gamma)) channel.gamma = gamma;
    } else if ('gamma' in channel) {
      channel.gamma = clamp(num(channel.gamma, 1), 0.18, 5.5);
    }
  }

  /**
   * The content of a Studio file, checked: `{ createdAt, dataset, sourceSlice,
   * planeSpec, timepoint, channelState, layoutMaps, layers, guides, groups }` (null where the file says
   * nothing). A list or an object in the wrong place, or a layer, guide, group or cell
   * that cannot be read, makes the whole file invalid; values inside an entry are
   * coerced (a non-finite coordinate → 0, an angle → (−180, 180], an unsafe id → a new
   * one). Channel settings are only type-checked here: _mergeImportedChannels reads them.
   */
  function _migrateDocument(value) {
    if (Array.isArray(value)) {
      // The first Studio files were a bare list of layers.
      return _checkImportedFile({ layers: value.map(old => (_isPlainObject(old) ? _migrateLayer(old) : old)) });
    }
    if (!_isPlainObject(value) || !Array.isArray(value.layers)) throw new Error('Unsupported Studio JSON format.');
    return _checkImportedFile(value);
  }

  function _checkImportedFile(value) {
    const given = key => value[key] !== undefined && value[key] !== null;
    const expect = (ok, what) => {
      if (!ok) throw new Error(`Studio JSON: ${what}.`);
    };
    ['layoutMaps', 'channelState', 'guides', 'groups'].forEach(key => {
      expect(!given(key) || Array.isArray(value[key]), `${key} is not a list`);
      expect(!given(key) || value[key].length <= IMPORT_MAX_LAYERS, `${key} is longer than ${IMPORT_MAX_LAYERS}`);
    });
    ['sourceSlice', 'dataset'].forEach(key => {
      expect(!given(key) || _isPlainObject(value[key]), `${key} is not an object`);
    });

    const groupIds = new Set();
    const groups = (value.groups || []).map(group => {
      expect(_isPlainObject(group), 'a group is not an object');
      const id = _importId(group.id, 'group', groupIds);
      return { id, name: typeof group.name === 'string' ? group.name : '', collapsed: group.collapsed === true };
    });
    expect(value.layers.length <= IMPORT_MAX_LAYERS, `more than ${IMPORT_MAX_LAYERS} layers`);
    const layerIds = new Set();
    let unknown = 0;
    const layers = value.layers.filter(layer => {
      expect(_isPlainObject(layer) && typeof layer.type === 'string' && IMPORT_LAYER_TYPE.test(layer.type), 'a layer has no readable type');
      // A kind of layer this Studio cannot draw would sit in the list invisible and
      // out of reach of the pointer: it is left out.
      if (Object.prototype.hasOwnProperty.call(IMPORT_REQUIRED_GEOMETRY, layer.type)) return true;
      unknown++;
      return false;
    }).map(layer => {
      const checked = _checkImportedLayer(layer, layerIds);
      if (checked.groupId !== null && !groupIds.has(checked.groupId)) checked.groupId = null;
      return checked;
    });
    if (unknown) console.warn(`[StudioEditor] ${unknown} layer(s) of a kind this Studio does not draw were left out of the import.`);
    const guides = (value.guides || []).map(guide => {
      expect(_isPlainObject(guide) && (guide.axis === 'x' || guide.axis === 'y') && Number.isFinite(guide.value), 'a guide is not readable');
      return { axis: guide.axis, value: guide.value };
    });
    const layoutMaps = given('layoutMaps')
      ? value.layoutMaps.map(cell => {
        expect(_isPlainObject(cell), 'a layout cell is not an object');
        expect(cell.channelState === undefined || cell.channelState === null || Array.isArray(cell.channelState), "a layout cell's channelState is not a list");
        return _layoutMapData(cell);
      })
      : null;
    return {
      createdAt: typeof value.createdAt === 'string' && value.createdAt ? value.createdAt : null,
      dataset: given('dataset') ? value.dataset : null,
      sourceSlice: given('sourceSlice') ? value.sourceSlice : null,
      // Only compared with the open figure's (never applied): a value that cannot be
      // read makes no claim.
      planeSpec: _isPlainObject(value.planeSpec) ? value.planeSpec : null,
      timepoint: typeof value.timepoint === 'number' && Number.isFinite(value.timepoint) ? value.timepoint : null,
      channelState: given('channelState') ? value.channelState : null,
      layoutMaps,
      layers,
      guides,
      groups
    };
  }

  // One layer of a file, as the Studio draws and lists it. The id is written into the
  // layer list's markup and compared with the dataset string of its row, so it must be
  // a unique plain token; the colours go into a colour input and a canvas style.
  function _checkImportedLayer(value, usedIds) {
    const layer = JSON.parse(JSON.stringify(value));
    layer.id = _importId(layer.id, layer.type, usedIds);
    IMPORT_GEOMETRY_KEYS.forEach(key => {
      if (!(key in layer)) return;
      const n = Number(layer[key]);
      layer[key] = layer[key] !== null && Number.isFinite(n) ? n : 0;
    });
    (IMPORT_REQUIRED_GEOMETRY[layer.type] || []).forEach(key => {
      if (!(key in layer)) layer[key] = 0;
    });
    if ('value' in layer) {
      const n = Number(layer.value);
      if (Number.isFinite(n) && n > 0) layer.value = n;
      else delete layer.value;
    }
    if ('points' in layer) {
      if (Array.isArray(layer.points)) {
        layer.points = layer.points
          .slice(0, IMPORT_MAX_POINTS)
          .filter(p => _isPlainObject(p) && Number.isFinite(Number(p.x)) && Number.isFinite(Number(p.y)))
          .map(p => ({ ...p, x: Number(p.x), y: Number(p.y) }));
      } else {
        delete layer.points;
      }
    }
    ['name', 'text'].forEach(key => {
      if (!(key in layer)) return;
      if (typeof layer[key] !== 'string') {
        layer[key] = (typeof layer[key] === 'number' && Number.isFinite(layer[key])) ? String(layer[key]) : '';
      }
      // Measured and drawn on every redraw: a label, not a document.
      if (layer[key].length > IMPORT_MAX_TEXT) layer[key] = layer[key].slice(0, IMPORT_MAX_TEXT);
    });
    if (layer.unit === 'µm') layer.unit = 'um';
    if ('unit' in layer && !IMPORT_UNITS.includes(layer.unit)) delete layer.unit;
    if ('meta' in layer && !_isPlainObject(layer.meta)) delete layer.meta;
    layer.groupId = typeof layer.groupId === 'string' && IMPORT_SAFE_ID.test(layer.groupId) ? layer.groupId : null;
    layer.visible = layer.visible !== false;
    layer.locked = layer.locked === true;
    // A document saved before layers could turn has no `rotation` (→ 0); a hand-edited
    // one may carry anything, which must never reach ctx.rotate as NaN.
    layer.rotation = _normalizeRotationDeg(layer.rotation);
    layer.style = _checkImportedStyle(layer.style);
    return layer;
  }

  function _checkImportedStyle(value) {
    const style = {};
    if (!_isPlainObject(value)) return style;
    Object.keys(value).forEach(key => {
      const v = value[key];
      if (key === '__proto__') return;
      if (IMPORT_STYLE_COLORS.includes(key)) {
        if (_isImportColor(v)) style[key] = v;
      } else if (Object.prototype.hasOwnProperty.call(IMPORT_STYLE_NUMBERS, key)) {
        const [lo, hi] = IMPORT_STYLE_NUMBERS[key];
        const n = Number(v);
        if (v !== null && v !== '' && Number.isFinite(n)) style[key] = Math.max(lo, Math.min(hi, n));
      } else if (key === 'startCap' || key === 'endCap') {
        // 'flat' is the v1.0.0 name of the bar cap (_drawCap still draws it as one).
        if (v === 'flat') style[key] = 'bar';
        else if (IMPORT_CAPS.includes(v)) style[key] = v;
      } else if (IMPORT_STYLE_FLAGS.includes(key)) {
        if (typeof v === 'boolean') style[key] = v;
      } else if (typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))
        || (typeof v === 'string' && IMPORT_STYLE_TOKEN.test(v))) {
        style[key] = v;
      }
    });
    return style;
  }

  function _importId(value, type, usedIds) {
    let id = typeof value === 'number' && Number.isFinite(value) ? String(value) : value;
    if (typeof id !== 'string' || !IMPORT_SAFE_ID.test(id) || usedIds.has(id)) {
      do {
        id = `${type}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
      } while (usedIds.has(id));
    }
    usedIds.add(id);
    return id;
  }

  function _isImportColor(value) {
    return typeof value === 'string' && (
      /^#[0-9a-f]{3,8}$/i.test(value)
      || /^rgba?\(\s*[\d.\s,%]+\)$/i.test(value)
      || /^[a-z]{3,20}$/i.test(value)
    );
  }

  function _isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  function _migrateLayer(old) {
    const layer = _newBaseLayer(old.type || 'rectangle');
    Object.assign(layer, old);
    layer.visible = old.visible !== false;
    layer.locked = Boolean(old.locked);
    layer.style = {
      stroke: old.color || old.style?.stroke || '#ffffff',
      fill: old.color || old.style?.fill || '#ffffff',
      strokeWidth: old.strokeWidth ?? old.style?.strokeWidth ?? 3,
      fontSize: old.fontSize ?? old.style?.fontSize ?? 18,
      opacity: old.opacity ?? old.style?.opacity ?? 1,
      startCap: old.startCap || old.style?.startCap || 'none',
      endCap: old.endCaps || old.style?.endCap || old.endCap || 'none'
    };
    // EDGE-019 (Rule 1.4): an imported JSON can carry NaN/Infinity/non-numeric geometry
    // (?? only guards null/undefined, not NaN) that would corrupt the canvas. Coerce
    // every numeric field to a finite value (reusing _clamp/_clamp01).
    const _num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
    layer.x = _num(layer.x, 0);
    layer.y = _num(layer.y, 0);
    layer.w = _num(layer.w, 0);
    layer.h = _num(layer.h, 0);
    if (Array.isArray(layer.points)) {
      layer.points = layer.points
        .filter(p => p && Number.isFinite(Number(p.x)) && Number.isFinite(Number(p.y)))
        .map(p => ({ ...p, x: Number(p.x), y: Number(p.y) }));
    }
    layer.style.strokeWidth = _clamp(layer.style.strokeWidth, 0, 200);
    layer.style.fontSize = _clamp(layer.style.fontSize, 1, 400);
    layer.style.opacity = _clamp01(layer.style.opacity);
    if (old.unit === 'µm') layer.unit = 'um';
    layer.rotation = _normalizeRotationDeg(old.rotation);
    return layer;
  }

  function _capControls(style) {
    const start = style.startCap || 'none';
    const end = style.endCap || 'none';
    const opts = ['none', 'arrow', 'bar', 'dot'].map(cap => `<option value="${cap}">${cap}</option>`).join('');
    return `
      <label>Start Cap <select id="prop-startcap" class="form-select">${opts.replace(`value="${start}"`, `value="${start}" selected`)}</select></label>
      <label>End Cap <select id="prop-endcap" class="form-select">${opts.replace(`value="${end}"`, `value="${end}" selected`)}</select></label>
    `;
  }

  function _rotationControl(layer) {
    const deg = _formatDeg(_layerRotationDeg(layer));
    const locked = layer.locked === true;
    const off = locked ? 'disabled' : '';
    const label = _escape(_t('studio.propRotation', 'Rotation'));
    const resetTitle = _escape(_t('studio.resetRotation', 'Reset rotation'));
    const lockedTitle = locked ? ` title="${_escape(_t('studio.rotationLocked', 'Unlock the layer to rotate it.'))}"` : '';
    return `
      <div class="studio-rotation-prop${locked ? ' is-locked' : ''}" data-layer-id="${_escape(layer.id)}"${lockedTitle}>
        <span data-i18n="studio.propRotation">${label}</span>
        <div class="studio-rotation-prop-row">
          <input type="range" id="prop-rotation" min="-180" max="180" step="1" value="${deg}" aria-label="${label}" ${off}>
          <input type="number" class="form-input" id="prop-rotation-num" min="-180" max="180" step="any" value="${deg}" aria-label="${label}" ${off}>
          <span class="studio-rotation-prop-unit" aria-hidden="true">&deg;</span>
          <button type="button" class="btn btn-icon btn-ghost btn-sm" id="prop-rotation-reset" title="${resetTitle}" data-i18n-title="studio.resetRotation" ${off}><i data-lucide="rotate-ccw"></i></button>
        </div>
      </div>
    `;
  }

  function _formatDeg(deg) {
    return String(Math.round(Number(deg) * 10) / 10 || 0);
  }

  function _scaleBarControls(layer) {
    const unit = layer.unit || 'um';
    const value = _snapScaleBarValue(layer.value || 100);
    return `
      <label>Length <input type="number" class="form-input" id="prop-scalebar-value" min="${SCALEBAR_STEP}" step="${SCALEBAR_STEP}" value="${value}"></label>
      <div class="studio-radio-row">
        ${['um', 'mm', 'cm', 'px'].map(item => `<label><input type="radio" name="prop-scalebar-unit" value="${item}" ${unit === item ? 'checked' : ''}> ${item}</label>`).join('')}
      </div>
    `;
  }

  // ── Layer rotation geometry (pure: no DOM, no document state) ─────────────────
  // Image space is y-down, so a positive angle turns clockwise on screen: the sense of
  // CanvasRenderingContext2D.rotate, which is what draws the box layers.

  // Any angle → (−180, 180], the one spelling the controls show and the JSON stores.
  function _normalizeRotationDeg(deg) {
    const n = Number(deg);
    if (!Number.isFinite(n)) return 0;
    let r = n % 360;
    if (r > 180) r -= 360;
    else if (r <= -180) r += 360;
    return r === 0 ? 0 : r;
  }

  function _snapRotationDeg(deg, step) {
    return _normalizeRotationDeg(Math.round(Number(deg) / step) * step);
  }

  // Unit vector at `deg`, exact on the four right angles (cos(π/2) is 6e-17, and a bar
  // turned by 90° must be exactly vertical).
  function _unitFromDeg(deg) {
    const r = _normalizeRotationDeg(deg);
    if (r === 0) return { x: 1, y: 0 };
    if (r === 90) return { x: 0, y: 1 };
    if (r === 180) return { x: -1, y: 0 };
    if (r === -90) return { x: 0, y: -1 };
    const rad = r * Math.PI / 180;
    return { x: Math.cos(rad), y: Math.sin(rad) };
  }

  // R(θ)·v, R(θ) = [[cos θ, −sin θ], [sin θ, cos θ]].
  function _rotateVec(x, y, rad) {
    if (!rad) return { x, y };
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    return { x: x * cos - y * sin, y: x * sin + y * cos };
  }

  // p' = c + R(θ)(p − c). With −θ it is the inverse, which takes a pointer into the
  // frame of a layer turned by θ.
  function _rotatePointAbout(p, c, rad) {
    if (!rad) return { x: p.x, y: p.y };
    const v = _rotateVec(p.x - c.x, p.y - c.y, rad);
    return { x: c.x + v.x, y: c.y + v.y };
  }

  function _boxCentre(box) {
    return { x: box.x + box.w / 2, y: box.y + box.h / 2 };
  }

  function _centroid(points) {
    const n = Math.max(1, points.length);
    return {
      x: points.reduce((sum, p) => sum + p.x, 0) / n,
      y: points.reduce((sum, p) => sum + p.y, 0) / n
    };
  }

  // Corners of an (x, y, w, h) box turned by θ about its centre, named after the corner
  // they are in the box's own frame ('se' stays the handle that grows w and h).
  function _rotatedBoxCorners(box, rad) {
    const c = _boxCentre(box);
    return [
      ['nw', box.x, box.y],
      ['ne', box.x + box.w, box.y],
      ['sw', box.x, box.y + box.h],
      ['se', box.x + box.w, box.y + box.h]
    ].map(([id, x, y]) => ({ id, ..._rotatePointAbout({ x, y }, c, rad) }));
  }

  // Axis-aligned bounds of the turned box: same centre, half-extents
  // ex = |w/2·cos θ| + |h/2·sin θ|, ey = |w/2·sin θ| + |h/2·cos θ|.
  function _rotatedBoxAabb(box, rad) {
    if (!rad) return { x: box.x, y: box.y, w: box.w, h: box.h };
    const c = _boxCentre(box);
    const cos = Math.abs(Math.cos(rad));
    const sin = Math.abs(Math.sin(rad));
    const ex = (box.w / 2) * cos + (box.h / 2) * sin;
    const ey = (box.w / 2) * sin + (box.h / 2) * cos;
    return { x: c.x - ex, y: c.y - ey, w: 2 * ex, h: 2 * ey };
  }

  // Resize of a box turned by θ, dragged by `handle` (n/s/e/w or a corner) to `point`.
  // The anchor A — the opposite corner, or the opposite edge's midpoint — must not move
  // in image space:
  //   a  = anchor in the box frame, from the centre c;   A = c + R(θ)·a
  //   d  = R(−θ)·(P − A)       the pointer seen from A along the box's own axes
  //   w' = |d.x|, h' = |d.y|   (an axis the handle does not drive keeps its size, d = 0)
  //   c' = A + R(θ)·(d/2)      the new centre, halfway from A to the pointer
  // The box is stored unturned about c': (x, y) = c' − (w', h')/2. Dragging across the
  // anchor flips the box rather than giving it a negative size.
  function _resizeRotatedBox(box, rad, handle, point) {
    const id = String(handle || '');
    const sx = id.includes('e') ? 1 : id.includes('w') ? -1 : 0;
    const sy = id.includes('s') ? 1 : id.includes('n') ? -1 : 0;
    const c = _boxCentre(box);
    const anchor = _rotatePointAbout({
      x: sx > 0 ? box.x : sx < 0 ? box.x + box.w : c.x,
      y: sy > 0 ? box.y : sy < 0 ? box.y + box.h : c.y
    }, c, rad);
    const d = _rotateVec(point.x - anchor.x, point.y - anchor.y, -rad);
    const w = sx ? Math.abs(d.x) : box.w;
    const h = sy ? Math.abs(d.y) : box.h;
    const half = _rotateVec(sx ? d.x / 2 : 0, sy ? d.y / 2 : 0, rad);
    return { x: anchor.x + half.x - w / 2, y: anchor.y + half.y - h / 2, w, h };
  }

  // The same box re-measured to (w, h) — a text layer whose words changed — regrowing
  // from its turned top-left corner: holding c + R(θ)(−w/2, −h/2) fixed gives
  // c' = c + R(θ)((w' − w)/2, (h' − h)/2).
  function _regrowRotatedBox(box, rad, w, h) {
    const d = _rotateVec((w - box.w) / 2, (h - box.h) / 2, rad);
    return { x: box.x + box.w / 2 + d.x - w / 2, y: box.y + box.h / 2 + d.y - h / 2, w, h };
  }

  // µm spanned by one image px along the unit direction (ux, uy) with pixels of
  // psx × psy µm: the step (ux, uy) px covers (ux·psx, uy·psy) µm, so L px along it
  // measure L·hypot(ux·psx, uy·psy) µm — psx for a horizontal segment, psy for a
  // vertical one. A missing psy means square pixels.
  function _umPerPixelAlong(ux, uy, px) {
    const sx = Number(px?.x) > 0 ? Number(px.x) : 1;
    const sy = Number(px?.y) > 0 ? Number(px.y) : sx;
    return Math.hypot(ux * sx, uy * sy);
  }

  // A measured segment turned by θ about its midpoint like a ruler: the direction turns
  // rigidly on screen and the pixel length is re-derived so the physical length ℓ is
  // kept, L' = ℓ / hypot(u'x·psx, u'y·psy). With square pixels L' = L (a rigid turn);
  // with anisotropic pixels a rigid turn would change the value the layer reads.
  function _rotateRuler(p1, p2, rad, px) {
    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    const length = Math.hypot(dx, dy);
    if (!(length > 0)) return { x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y };
    const um = length * _umPerPixelAlong(dx / length, dy / length, px);
    const u = _rotateVec(dx / length, dy / length, rad);
    const half = um / _umPerPixelAlong(u.x, u.y, px) / 2;
    const cx = (p1.x + p2.x) / 2;
    const cy = (p1.y + p2.y) / 2;
    return { x1: cx - u.x * half, y1: cy - u.y * half, x2: cx + u.x * half, y2: cy + u.y * half };
  }
  // ── End of layer rotation geometry ────────────────────────────────────────────

  function _layerName(layer) {
    return layer.type.charAt(0).toUpperCase() + layer.type.slice(1);
  }

  function _boxFromPoints(a, b) {
    return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) };
  }

  function _dist(x1, y1, x2, y2) {
    return Math.hypot(x2 - x1, y2 - y1);
  }

  function _clamp(value, min, max) {
    const lo = Math.min(min, max);
    const hi = Math.max(min, max);
    return Math.max(lo, Math.min(hi, Number(value) || 0));
  }

  function _clamp01(value) {
    return _clamp(value, 0, 1);
  }

  function _distToSegment(px, py, x1, y1, x2, y2) {
    const l2 = Math.pow(x2 - x1, 2) + Math.pow(y2 - y1, 2);
    if (l2 === 0) return _dist(px, py, x1, y1);
    const t = Math.max(0, Math.min(1, ((px - x1) * (x2 - x1) + (py - y1) * (y2 - y1)) / l2));
    return _dist(px, py, x1 + t * (x2 - x1), y1 + t * (y2 - y1));
  }

  function _niceStep(value) {
    const pow = Math.pow(10, Math.floor(Math.log10(Math.max(1, value))));
    const norm = value / pow;
    if (norm > 5) return 10 * pow;
    if (norm > 2) return 5 * pow;
    if (norm > 1) return 2 * pow;
    return pow;
  }

  // The fields of a Compare cell that live only as long as the page that opened the
  // Studio: the panel's frame, the cell's raw channel values (w·h·4 bytes, tens of MB
  // at native resolution) and the panel slice they came with. They are shared by
  // reference between the document and its undo history, and never go through JSON:
  // a typed array stringifies one key per byte (hundreds of MB, then a RangeError),
  // a frame does not stringify at all, and none of them can be restored from a file.
  const LAYOUT_RUNTIME_KEYS = ['iframe', 'raw', 'sliceResult'];

  function _layoutMapData(map) {
    const data = { ...map };
    LAYOUT_RUNTIME_KEYS.forEach(key => { delete data[key]; });
    return data;
  }

  function _isDocument(value) {
    return Boolean(value && value.version && value.createdAt && value.layoutMaps);
  }

  // The document as a file holds it: every cell without its runtime fields.
  function _portableDocument(doc) {
    return { ...doc, layoutMaps: (doc.layoutMaps || []).map(_layoutMapData) };
  }

  function _clone(value) {
    if (!value) return value;
    if (_isDocument(value)) {
      const clonedDoc = JSON.parse(JSON.stringify({ ...value, layoutMaps: undefined }));
      clonedDoc.layoutMaps = value.layoutMaps.map(m => ({
        ...JSON.parse(JSON.stringify(_layoutMapData(m))),
        iframe: m.iframe,
        raw: m.raw,
        sliceResult: m.sliceResult
      }));
      return clonedDoc;
    }
    // A history entry ({ label, doc }): its document through the branch above.
    if (typeof value === 'object' && _isDocument(value.doc)) {
      return { ...JSON.parse(JSON.stringify({ ...value, doc: undefined })), doc: _clone(value.doc) };
    }
    return JSON.parse(JSON.stringify(value));
  }

  function _escape(value) {
    if (typeof Utils !== 'undefined' && Utils.escapeHtml) return Utils.escapeHtml(value);
    return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[ch]));
  }

  function _safeName(value) {
    return String(value || 'export').replace(/[^a-z0-9._-]+/gi, '_').replace(/^_+|_+$/g, '').slice(0, 140);
  }

  // i18n helper: resolve key (with optional {params}), else the literal default.
  const _t = (k, def, params) => {
    // `const I18n = (…)()` is a lexical global, never a window property — the old
    // `window.I18n` guard was always false, so every Studio string fell back to its
    // English literal regardless of the selected language.
    const v = (typeof I18n !== 'undefined' && I18n.t) ? I18n.t(k, params) : k;
    return v === k ? def : v;
  };

  function _toast(text) {
    ExportManager?.toast?.(text);
  }

  return {
    init,
    open,
    setSliceResult,
    setLoadProgress,
    isOpen: () => _isOpen,
    close,
    getDocument,
    documentToken
  };
})();

document.addEventListener('DOMContentLoaded', () => { StudioEditor.init(); });
