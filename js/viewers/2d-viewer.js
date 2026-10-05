/* ============================================================
   Lumen3D — 2D Viewer
   ============================================================
   2D canvas renderer for one calibrated photograph. Owns the view
   transform (pan / zoom), the two-step image load (the small preview
   paints first, the native image is swapped in the moment it decodes),
   the scale bar, the distance measurements and the stain-isolation view.

   Coordinates — three frames:
     image    (ix, iy)  pixels of the photograph as stored;
     oriented (ox, oy)  the image after the optional mirror + rotation, in the
                        bounding box of the rotated rectangle (screen-aligned);
     canvas   (sx, sy)  CSS pixels:  sx = ox · scale + tx,  sy = oy · scale + ty.
   Rotation is a rigid transform, so `scale` stays CSS pixels per image pixel
   and a physical length L (µm) spans  L / pixelSizeUm · scale  CSS pixels in
   every frame: that single relation is the whole calibration, for the scale
   bar, the grid, the picks and the linked views.
   ============================================================ */

const Viewer2D = (() => {
  const FIT_MARGIN = 0.96;          // fitted view leaves a 2 % border on each side
  const MIN_ZOOM_OUT = 0.25;        // never smaller than a quarter of the fitted view
  const MAX_SCALE = 32;             // CSS pixels per image pixel
  const WHEEL_STEP = 1.1;           // zoom factor per 100 wheel units
  const DRAG_THRESHOLD_PX = 4;      // below this a pointer gesture is a click
  const SCALE_BAR_TARGET_PX = 120;  // the bar picks the 1-2-5 length nearest to this
  const WHEEL_LINE_PX = 33;         // one wheel "line" (Firefox reports notches in lines) in pixels
  const WHEEL_MAX_DELTA_PX = 300;   // one wheel event never zooms by more than 3 notches
  const NATIVE_DEFER_MS = 150;      // stepping through a collection: the native image waits for the key to settle
  const PIXEL_WORKER_URL = 'js/workers/pixel-2d-worker.js';

  let _canvas = null;
  let _ctx = null;
  let _container = null;
  let _resizeObserver = null;

  let _image = null;                // what is drawable now: preview, then native
  let _hasNative = false;           // the native image.webp has decoded (it may be _image, or the preview when that is the larger)
  let _imageGen = 0;                // bumped whenever _image changes: a processed copy is only valid for its generation
  let _loadImgs = [];               // the Image objects of the load in flight, released when it is superseded
  let _nativeTimer = 0;
  let _imgW = 0;                    // declared native size — known before any byte
  let _imgH = 0;
  let _pixelSizeUm = null;
  let _loadToken = 0;

  let _view = { scale: 1, tx: 0, ty: 0 };
  let _fitScale = 1;
  let _isolate = false;
  let _measurements = [];
  let _labelRects = [];             // canvas-space hit boxes of the labels drawn last frame
  let _orient = { rotationDeg: 0, flipH: false };
  let _adjust = null;               // null = raw photograph; else the full adjustment set
  let _proc = null;                 // { key, gen, img } processed rendering (adjusted / isolated) of _image
  let _procPending = null;          // the latest request while a job runs — only the newest is ever started
  let _procRunning = null;
  let _procBusy = false;
  let _procWaiters = [];
  let _pixelWorker = null;
  let _pixelWorkerBroken = false;
  let _pixelCalls = new Map();
  let _pixelCallId = 0;
  let _mainCache = { gen: -1 };     // maps kept for the main-thread path (no worker, or a synchronous export)
  let _bgColor = '#000';            // canvas backdrop, read from the container's style when it can change
  let _overlays = [];               // plugin painters, drawn between the image and the measurements
  let _textSize = 14;               // label font size, CSS px
  let _showLabels = true;

  let _pointers = new Map();
  let _gesture = null;
  let _raf = 0;

  let _onMeasurePoint = null;
  let _onLoadState = null;
  let _viewListeners = [];
  let _onLabelMove = null;

  // ── Lifecycle ──────────────────────────────────────────────────────────────
  function init(canvasEl) {
    _canvas = canvasEl;
    _ctx = canvasEl.getContext('2d');
    _container = canvasEl.parentElement;
    _bindPointer();
    _canvas.addEventListener('wheel', _onWheel, { passive: false });
    _canvas.addEventListener('dblclick', () => fit());
    _resizeObserver = new ResizeObserver(() => resize());
    _resizeObserver.observe(_container);
    if (typeof Theme !== 'undefined' && Theme.onChange) Theme.onChange(() => { _readBackground(); _scheduleDraw(); });
    _readBackground();
    resize();
  }

  function dispose() {
    _loadToken++;
    _cancelLoad();
    _resizeObserver?.disconnect();
    _image = null;
    _hasNative = false;
    _dropProcessed();
    _pixelWorker?.terminate();
    _pixelWorker = null;
    // A terminated worker never answers: settle its calls, or the processing loop
    // would wait on them forever and no later adjustment would ever be applied.
    const calls = [..._pixelCalls.values()];
    _pixelCalls.clear();
    calls.forEach(c => c.reject(new Error('2D viewer disposed')));
    _measurements = [];
  }

  /** The backdrop colour comes from the stylesheet; reading it forces a style
   *  recalculation, so it is read when the theme or the size changes, not per frame. */
  function _readBackground() {
    if (_container) _bgColor = getComputedStyle(_container).backgroundColor || '#000';
  }

  /**
   * Start showing a photograph. The preview and the native image are fetched
   * together; whichever decodes first is painted, and a later, smaller image
   * never replaces a larger one already on screen.
   * `deferNative` holds the (multi-MB) native request back for a moment: a
   * collection stepped through with a held arrow key only ever downloads the
   * photograph the key settled on.
   * @returns {Promise<void>} resolves once the native image is on screen
   */
  function load(spec) {
    const token = ++_loadToken;
    _cancelLoad();
    _imgW = spec.width;
    _imgH = spec.height;
    _pixelSizeUm = Number.isFinite(spec.pixelSizeUm) && spec.pixelSizeUm > 0 ? spec.pixelSizeUm : null;
    _image = null;
    _imageGen++;
    _hasNative = false;
    _dropProcessed();
    _measurements = [];
    _readBackground();
    fit();
    _emitState('loading');

    _decode(spec.previewUrl)
      .then(img => { if (_swap(token, img)) _emitState('preview'); })
      .catch(() => {});
    return new Promise((resolve, reject) => {
      const start = () => {
        _nativeTimer = 0;
        if (token !== _loadToken) { resolve(); return; }
        _decode(spec.nativeUrl).then(img => {
          if (token !== _loadToken) return;
          // The native bytes are in even when _swap keeps a larger preview: the
          // capture is as good as it gets, so it is not "preview" any more.
          _swap(token, img);
          _hasNative = true;
          _emitState('native');
        }).then(resolve, err => {
          if (token !== _loadToken) { resolve(); return; }   // superseded: its failure is not news
          // A native image that fails while the preview is up is its own state:
          // the pill must not keep saying "loading native".
          _emitState(_image ? 'nativeError' : 'error');
          reject(err);
        });
      };
      if (spec.deferNative) _nativeTimer = setTimeout(start, NATIVE_DEFER_MS);
      else start();
    });
  }

  /** Warm the browser cache so the next photograph paints from memory. */
  function prefetch(url) {
    if (!url) return;
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
  }

  function _decode(url) {
    const img = new Image();
    img.decoding = 'async';
    _loadImgs.push(img);
    img.src = url;
    if (typeof img.decode === 'function') return img.decode().then(() => img);
    return new Promise((resolve, reject) => {
      img.onload = () => resolve(img);
      img.onerror = reject;
    });
  }

  /** Stop what the previous load still has in flight: an emptied `src` aborts the
   *  transfer, so superseded photographs do not queue behind the current one. */
  function _cancelLoad() {
    clearTimeout(_nativeTimer);
    _nativeTimer = 0;
    for (const img of _loadImgs) {
      if (img !== _image && !img.complete) { try { img.removeAttribute('src'); } catch (_) { /* detached */ } }
    }
    _loadImgs = [];
  }

  function _swap(token, img) {
    if (token !== _loadToken) return false;
    if (_image && img.naturalWidth < _image.naturalWidth) return false;
    _image = img;
    _imageGen++;
    _scheduleDraw();
    return true;
  }

  /** True once the native image is what is drawn — a capture taken before that
   *  holds the 640 px preview upscaled, not the photograph's own pixels. */
  function hasNative() { return _hasNative; }

  // ── View transform ─────────────────────────────────────────────────────────
  function fit(reason) {
    const w = _cssWidth(), h = _cssHeight();
    if (!_imgW || !_imgH || !w || !h) return;
    const o = _orientedSize();
    _fitScale = Math.min(w / o.w, h / o.h) * FIT_MARGIN;
    _view = {
      scale: _fitScale,
      tx: (w - o.w * _fitScale) / 2,
      ty: (h - o.h * _fitScale) / 2
    };
    _viewChanged(reason || 'fit');
  }

  /** One image pixel per device pixel. */
  function zoomNative() {
    const dpr = window.devicePixelRatio || 1;
    _zoomAround(1 / dpr, _cssWidth() / 2, _cssHeight() / 2);
  }

  function _zoomAround(scale, cx, cy) {
    const next = Math.max(_fitScale * MIN_ZOOM_OUT, Math.min(MAX_SCALE, scale));
    const k = next / _view.scale;
    _view = {
      scale: next,
      tx: cx - (cx - _view.tx) * k,
      ty: cy - (cy - _view.ty) * k
    };
    _viewChanged('user');
  }

  function _pan(dx, dy) {
    _view = { scale: _view.scale, tx: _view.tx + dx, ty: _view.ty + dy };
    _viewChanged('user');
  }

  function getView() { return { ..._view }; }

  function setView(view, reason) {
    if (!view || !Number.isFinite(view.scale) || view.scale <= 0) return;
    // A value from a shared link or a workspace file obeys the same zoom range as the wheel.
    const scale = Math.max(_fitScale * MIN_ZOOM_OUT, Math.min(MAX_SCALE, view.scale));
    _view = { scale, tx: Number(view.tx) || 0, ty: Number(view.ty) || 0 };
    _viewChanged(reason || 'set');
  }

  /**
   * `reason` tells a listener WHO moved the view: 'user' (pointer, wheel,
   * pinch, the native-zoom button), 'fit', 'resize', 'set', 'physical',
   * 'orientation'. A linked panel forwards only 'user', so a pane fitting
   * itself on load or on a layout change does not re-frame the others.
   */
  function _viewChanged(reason) {
    _scheduleDraw();
    const view = getView();
    for (const cb of _viewListeners) cb(view, reason);
  }

  function getViewport() { return { width: _cssWidth(), height: _cssHeight() }; }

  function resize() {
    if (!_canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const w = _cssWidth(), h = _cssHeight();
    if (!w || !h) return;
    const wasFitted = Math.abs(_view.scale - _fitScale) < 1e-9;
    // Assigning a canvas size clears it and reallocates the backing store, even
    // to the same value: a drag-resize in Compare fires this on every frame.
    const bw = Math.round(w * dpr), bh = Math.round(h * dpr);
    if (_canvas.width !== bw) _canvas.width = bw;
    if (_canvas.height !== bh) _canvas.height = bh;
    _readBackground();
    if (wasFitted || !_image) fit('resize');
    else _scheduleDraw();
  }

  function _cssWidth() { return _canvas ? _canvas.clientWidth : 0; }
  function _cssHeight() { return _canvas ? _canvas.clientHeight : 0; }

  function _toImage(sx, sy) {
    return _fromOriented((sx - _view.tx) / _view.scale, (sy - _view.ty) / _view.scale);
  }

  function _toCanvas(ix, iy) {
    const o = _toOriented(ix, iy);
    return _orientedToCanvas(o.x, o.y);
  }

  function _orientedToCanvas(ox, oy) {
    return { x: ox * _view.scale + _view.tx, y: oy * _view.scale + _view.ty };
  }

  function _canvasToOriented(sx, sy) {
    return { x: (sx - _view.tx) / _view.scale, y: (sy - _view.ty) / _view.scale };
  }

  // ── Orientation: mirror, then rotate about the image centre ────────────────
  function _theta() { return _orient.rotationDeg * Math.PI / 180; }

  /** Bounding box of the rotated photograph, in image pixels. */
  function _orientedSize() {
    const c = Math.abs(Math.cos(_theta())), s = Math.abs(Math.sin(_theta()));
    return { w: _imgW * c + _imgH * s, h: _imgW * s + _imgH * c };
  }

  function _toOriented(ix, iy) {
    const th = _theta(), o = _orientedSize();
    let x = ix - _imgW / 2;
    const y = iy - _imgH / 2;
    if (_orient.flipH) x = -x;
    return { x: x * Math.cos(th) - y * Math.sin(th) + o.w / 2, y: x * Math.sin(th) + y * Math.cos(th) + o.h / 2 };
  }

  function _fromOriented(ox, oy) {
    const th = _theta(), o = _orientedSize();
    const xr = ox - o.w / 2, yr = oy - o.h / 2;
    let x = xr * Math.cos(th) + yr * Math.sin(th);
    const y = -xr * Math.sin(th) + yr * Math.cos(th);
    if (_orient.flipH) x = -x;
    return { x: x + _imgW / 2, y: y + _imgH / 2 };
  }

  /**
   * @param {{rotationDeg?:number, flipH?:boolean}|null} o — null resets.
   * A fitted view stays fitted (the bounding box changes with the angle).
   */
  function setOrientation(o) {
    const deg = Number(o?.rotationDeg) || 0;
    const next = { rotationDeg: ((deg + 180) % 360 + 360) % 360 - 180, flipH: Boolean(o?.flipH) };
    const wasFitted = Math.abs(_view.scale - _fitScale) < 1e-9;
    _orient = next;
    if (wasFitted) fit('orientation');
    else _viewChanged('orientation');
  }

  function getOrientation() { return { ..._orient }; }

  // ── Pointer gestures: drag = pan, two pointers = pinch, tap = pick ─────────
  function _bindPointer() {
    _canvas.addEventListener('pointerdown', _onPointerDown);
    _canvas.addEventListener('pointermove', _onPointerMove);
    _canvas.addEventListener('pointerup', _onPointerUp);
    _canvas.addEventListener('pointercancel', _onPointerUp);
  }

  function _local(e) {
    const rect = _canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  function _onPointerDown(e) {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    _canvas.setPointerCapture(e.pointerId);
    _pointers.set(e.pointerId, _local(e));
    const p = _local(e);
    const label = _showLabels && _pointers.size === 1 ? _labelAt(p) : null;
    _gesture = { startX: p.x, startY: p.y, lastX: p.x, lastY: p.y, moved: false, pinch: null, label };
    if (_pointers.size === 2) _gesture.pinch = _pinchState();
  }

  function _onPointerMove(e) {
    if (!_gesture || !_pointers.has(e.pointerId)) return;
    const p = _local(e);
    _pointers.set(e.pointerId, p);
    if (_pointers.size >= 2) { _applyPinch(); return; }
    if (!_gesture.moved && Math.hypot(p.x - _gesture.startX, p.y - _gesture.startY) < DRAG_THRESHOLD_PX) return;
    _gesture.moved = true;
    const dx = p.x - _gesture.lastX, dy = p.y - _gesture.lastY;
    if (_gesture.label) _moveLabel(_gesture.label, dx / _view.scale, dy / _view.scale);
    else _pan(dx, dy);
    _gesture.lastX = p.x;
    _gesture.lastY = p.y;
  }

  function _onPointerUp(e) {
    const wasTap = _gesture && !_gesture.moved && !_gesture.pinch && _pointers.size === 1;
    if (_gesture?.label && _gesture.moved) _commitLabel(_gesture.label);
    _pointers.delete(e.pointerId);
    if (_pointers.size === 0) {
      if (wasTap && e.type === 'pointerup') _pick(_local(e));
      _gesture = null;
    } else {
      _gesture.pinch = _pointers.size === 2 ? _pinchState() : null;
    }
  }

  function _pinchState() {
    const [a, b] = [..._pointers.values()];
    return { dist: Math.hypot(a.x - b.x, a.y - b.y), scale: _view.scale };
  }

  function _applyPinch() {
    const pinch = _gesture.pinch || (_gesture.pinch = _pinchState());
    const [a, b] = [..._pointers.values()];
    const dist = Math.hypot(a.x - b.x, a.y - b.y);
    if (!pinch.dist || !dist) return;
    _gesture.moved = true;
    _zoomAround(pinch.scale * dist / pinch.dist, (a.x + b.x) / 2, (a.y + b.y) / 2);
  }

  function _onWheel(e) {
    e.preventDefault();
    const p = _local(e);
    // deltaY is in pixels, lines or pages depending on the browser and device
    // (Firefox's mouse wheel reports 3 lines per notch): bring it to pixels.
    let dy = e.deltaY;
    if (e.deltaMode === 1) dy *= WHEEL_LINE_PX;
    else if (e.deltaMode === 2) dy *= _cssHeight() || 600;
    dy = Math.max(-WHEEL_MAX_DELTA_PX, Math.min(WHEEL_MAX_DELTA_PX, dy));
    _zoomAround(_view.scale * Math.pow(WHEEL_STEP, -dy / 100), p.x, p.y);
  }

  function _pick(p) {
    if (!_onMeasurePoint || typeof ToolManager === 'undefined' || ToolManager.current() !== 'measure') return;
    const img = _toImage(p.x, p.y);
    if (img.x < 0 || img.y < 0 || img.x > _imgW || img.y > _imgH) return;
    _onMeasurePoint({
      normalized: { x: img.x / _imgW, y: img.y / _imgH, z: 0 },
      physicalUm: _pixelSizeUm ? { x: img.x * _pixelSizeUm, y: img.y * _pixelSizeUm, z: 0 } : null,
      screen: p
    });
  }

  // ── Measurements & calibration (same contract as VolumeViewer) ─────────────
  function onMeasurePoint(cb) { _onMeasurePoint = cb; }
  function onLoadState(cb) { _onLoadState = cb; }
  /** @param {(view:{scale:number,tx:number,ty:number}, reason:string)=>void} cb @returns {Function} unsubscribe */
  function onViewChange(cb) {
    _viewListeners.push(cb);
    return () => { _viewListeners = _viewListeners.filter(f => f !== cb); };
  }

  function setMeasurements(list) {
    _measurements = Array.isArray(list) ? list : [];
    _scheduleDraw();
  }

  function setMeasurementTextSize(size) {
    if (Number.isFinite(size) && size > 0) { _textSize = size; _scheduleDraw(); }
  }

  function setShowMeasurementLabels(on) {
    _showLabels = Boolean(on);
    _scheduleDraw();
  }

  function getMeasurementTextSize() { return _textSize; }
  function getPixelSizeUm() { return _pixelSizeUm; }
  function getImageSize() { return { width: _imgW, height: _imgH }; }

  // ── Overlays: plugin painters run after the image, before the measurements ─
  /** @param {(ctx:CanvasRenderingContext2D, helpers:object)=>void} fn @returns {Function} remove */
  function addOverlay(fn) {
    _overlays.push(fn);
    _scheduleDraw();
    return () => { _overlays = _overlays.filter(f => f !== fn); _scheduleDraw(); };
  }

  function redraw() { _scheduleDraw(); }

  function _overlayHelpers() {
    return {
      toCanvas: _toCanvas, toImage: _toImage,
      orientedToCanvas: _orientedToCanvas, canvasToOriented: _canvasToOriented,
      scale: _view.scale, tx: _view.tx, ty: _view.ty,
      pixelSizeUm: _pixelSizeUm, width: _cssWidth(), height: _cssHeight(),
      image: { width: _imgW, height: _imgH }, oriented: _orientedSize(), orientation: { ..._orient },
      label: _label, niceLength: _niceLength, formatUm: _formatUm
    };
  }

  function _drawOverlays() {
    if (!_overlays.length) return;
    const helpers = _overlayHelpers();
    for (const fn of _overlays) {
      _ctx.save();
      try { fn(_ctx, helpers); } catch (err) { console.warn('[Viewer2D] overlay failed', err); }
      _ctx.restore();
    }
  }

  // ── Physical view: what a linked panel shares ──────────────────────────────
  /**
   * The view as physical quantities: µm per CSS pixel, and the physical offset
   * of the canvas centre from the photograph's centre. Two photographs with
   * different pixel sizes given the same physical view show the same field at
   * the same magnification, centred on the same anatomical point.
   * An uncalibrated photograph has no physical quantity to share: it neither
   * reports a physical view (null) nor applies one.
   */
  function getPhysicalView() {
    if (!_pixelSizeUm) return null;     // without a calibration there is no physical quantity to share
    const o = _orientedSize(), px = _pixelSizeUm;
    const ox = (_cssWidth() / 2 - _view.tx) / _view.scale;
    const oy = (_cssHeight() / 2 - _view.ty) / _view.scale;
    return { umPerCss: px / _view.scale, centerUm: { x: (ox - o.w / 2) * px, y: (oy - o.h / 2) * px } };
  }

  function setPhysicalView(pv) {
    if (!pv || !(pv.umPerCss > 0) || !_pixelSizeUm) return;
    const o = _orientedSize(), px = _pixelSizeUm;
    const scale = px / pv.umPerCss;
    const ox = o.w / 2 + (pv.centerUm?.x || 0) / px;
    const oy = o.h / 2 + (pv.centerUm?.y || 0) / px;
    setView({ scale, tx: _cssWidth() / 2 - ox * scale, ty: _cssHeight() / 2 - oy * scale }, 'physical');
  }

  // ── Display adjustments (non-destructive, display only) ────────────────────
  const ADJUST_DEFAULT = { brightness: 0, contrast: 0, gamma: 1, wbRed: 1, wbBlue: 1, flatten: false };
  const ADJUST_RANGE = {
    brightness: [-100, 100], contrast: [-100, 100], gamma: [0.1, 10], wbRed: [0.1, 4], wbBlue: [0.1, 4]
  };

  /**
   * Partial update; the defaults mean "raw photograph". Values come from a
   * slider, a workspace file or a shared link: unknown keys are dropped and a
   * value that is not a finite number is ignored (one in excess is clamped), so
   * a crafted value cannot turn the look-up table into NaN and the picture black.
   */
  function setAdjustments(partial) {
    const clean = {};
    for (const [key, value] of Object.entries(partial || {})) {
      if (key === 'flatten') clean.flatten = Boolean(value);
      else if (ADJUST_RANGE[key] && typeof value === 'number' && Number.isFinite(value)) {
        clean[key] = Math.max(ADJUST_RANGE[key][0], Math.min(ADJUST_RANGE[key][1], value));
      }
    }
    const next = { ...ADJUST_DEFAULT, ...(_adjust || {}), ...clean };
    const isDefault = Object.keys(ADJUST_DEFAULT).every(k => next[k] === ADJUST_DEFAULT[k]);
    _adjust = isDefault ? null : next;
    _scheduleDraw();
  }

  function getAdjustments() { return { ...ADJUST_DEFAULT, ...(_adjust || {}) }; }

  // ── Processed rendering: adjustments and stain isolation ───────────────────
  // The per-pixel loops (PixelOps2D) run in a worker on an ImageBitmap that is
  // transferred, never copied through the page. While a job runs the previous
  // result — or the raw photograph — stays on screen; if requests pile up (a
  // slider drag) only the newest is ever started, so the cost follows the
  // pointer's pauses, not its speed. Without Worker / OffscreenCanvas the same
  // maths runs on the main thread, one job at a time, as it always did.

  /** What the display needs on top of the raw photograph, or null for nothing. */
  function _wantedProcessing() {
    if (_isolate) return { key: 'isolate', job: { kind: 'isolate' } };
    if (_adjust) return { key: 'adjust:' + JSON.stringify(_adjust), job: { kind: 'adjust', adjust: { ..._adjust } } };
    return null;
  }

  function _closeImg(img) { if (img && typeof img.close === 'function') img.close(); }

  function _dropProcessed() {
    if (_proc && _proc.img !== _image) _closeImg(_proc.img);
    _proc = null;
    _procPending = null;
  }

  /** The drawable source for the current settings. Starts a job when the cached
   *  rendering is missing or stale and meanwhile returns the last one. */
  function _displaySource() {
    const want = _wantedProcessing();
    if (!want || !_image) {
      if (_proc) _dropProcessed();
      return _image;
    }
    if (!_proc || _proc.key !== want.key || _proc.gen !== _imageGen) _requestProcessing(want);
    return _proc ? _proc.img : _image;
  }

  function _requestProcessing(want) {
    for (const queued of [_procPending, _procRunning]) {
      if (queued && queued.key === want.key && queued.gen === _imageGen) return;
    }
    _procPending = { ...want, gen: _imageGen };
    if (!_procBusy) _pumpProcessing();
  }

  async function _pumpProcessing() {
    _procBusy = true;
    try {
      while (_procPending) {
        const req = _procPending;
        _procPending = null;
        const image = _image;
        if (!image || req.gen !== _imageGen) continue;
        if (_proc && _proc.key === req.key && _proc.gen === req.gen) continue;
        _procRunning = req;
        let img = null;
        try { img = await _runProcessing(req, image); }
        catch (err) { console.warn('[Viewer2D] pixel processing failed, showing the photograph as stored.', err); }
        if (req.gen !== _imageGen || image !== _image) { _closeImg(img); continue; }
        // A failed job is remembered as "the raw photograph" for this key, so the
        // draw loop does not ask for it again until the settings change.
        if (_proc && _proc.img !== _image) _closeImg(_proc.img);
        _proc = { key: req.key, gen: req.gen, img: img || image };
        _scheduleDraw();
      }
    } finally {
      _procBusy = false;
      _procRunning = null;
      const waiters = _procWaiters;
      _procWaiters = [];
      waiters.forEach(fn => fn());
    }
  }

  function _runProcessing(req, image) {
    const worker = _getPixelWorker();
    if (!worker) {
      return new Promise((resolve, reject) => {
        setTimeout(() => { try { resolve(_processSync(req, image, req.gen)); } catch (err) { reject(err); } }, 0);
      });
    }
    return createImageBitmap(image).then(bitmap => new Promise((resolve, reject) => {
      const id = ++_pixelCallId;
      _pixelCalls.set(id, { resolve, reject });
      worker.postMessage({ id, imageId: req.gen, job: req.job, bitmap }, [bitmap]);
    })).catch(err => {
      // The worker died or cannot decode here: do this one on the main thread.
      if (_pixelWorkerBroken) return _processSync(req, image, req.gen);
      throw err;
    });
  }

  function _getPixelWorker() {
    if (_pixelWorker) return _pixelWorker;
    if (_pixelWorkerBroken || typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined'
        || typeof createImageBitmap === 'undefined') return null;
    try {
      _pixelWorker = new Worker(PIXEL_WORKER_URL);
    } catch (_) {
      _pixelWorkerBroken = true;
      return null;
    }
    _pixelWorker.onmessage = (e) => {
      const call = _pixelCalls.get(e.data.id);
      if (!call) { _closeImg(e.data.bitmap); return; }
      _pixelCalls.delete(e.data.id);
      if (e.data.error) call.reject(new Error(e.data.error));
      else call.resolve(e.data.bitmap);
    };
    _pixelWorker.onerror = () => {
      _pixelWorkerBroken = true;
      const calls = [..._pixelCalls.values()];
      _pixelCalls.clear();
      _pixelWorker?.terminate();
      _pixelWorker = null;
      calls.forEach(c => c.reject(new Error('pixel worker failed')));
    };
    return _pixelWorker;
  }

  /** The same job on the calling thread: the fallback, and the synchronous answer
   *  a capture needs when the worker has not delivered yet. Returns a canvas. */
  function _processSync(req, image, gen) {
    if (typeof PixelOps2D === 'undefined') throw new Error('PixelOps2D not loaded');
    const w = image.naturalWidth, h = image.naturalHeight;
    const off = document.createElement('canvas');
    off.width = w;
    off.height = h;
    const octx = off.getContext('2d', { willReadFrequently: true });
    octx.drawImage(image, 0, 0);
    const frame = octx.getImageData(0, 0, w, h);
    if (_mainCache.gen !== gen) _mainCache = { gen };
    const sample = (sw, sh) => {
      const small = document.createElement('canvas');
      small.width = sw;
      small.height = sh;
      const sctx = small.getContext('2d', { willReadFrequently: true });
      sctx.drawImage(image, 0, 0, sw, sh);
      return sctx.getImageData(0, 0, sw, sh).data;
    };
    PixelOps2D.run(req.job, frame.data, w, h, sample, _mainCache);
    octx.putImageData(frame, 0, 0);
    return off;
  }

  /** Resolves once the rendering for the current settings has landed. */
  function whenProcessed() {
    _displaySource();
    if (!_procBusy && !_procPending) return Promise.resolve();
    return new Promise(resolve => _procWaiters.push(resolve));
  }

  /** The source for a capture: exact for the current settings, never a stale one. */
  function _exactSource() {
    const want = _wantedProcessing();
    if (!want || !_image) return _image;
    if (_proc && _proc.key === want.key && _proc.gen === _imageGen) return _proc.img;
    try { return _processSync({ ...want, gen: _imageGen }, _image, _imageGen); }
    catch (_) { return _image; }
  }

  // ── Stain isolation ────────────────────────────────────────────────────────
  // The maths (and its rationale) lives in PixelOps2D.applyIsolation.
  function setIsolateStain(on) {
    _isolate = Boolean(on);
    _scheduleDraw();
  }

  function isIsolateStain() { return _isolate; }

  /**
   * Label placement. `labelOffset` is {x, y} in IMAGE pixels from the default
   * anchor (the segment's midpoint), so a placed label stays glued to the
   * same spot of the photograph at every zoom. The drop is reported through
   * onLabelMove so the page can persist it with the measurement.
   */
  function onLabelMove(cb) { _onLabelMove = cb; }

  function _labelAt(p) {
    for (let i = _labelRects.length - 1; i >= 0; i--) {
      const r = _labelRects[i];
      if (p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h) return r.id;
    }
    return null;
  }

  function _moveLabel(id, dx, dy) {
    const m = _measurements.find(item => item.id === id);
    if (!m) return;
    const o = m.labelOffset || { x: 0, y: 0 };
    m.labelOffset = { x: (o.x || 0) + dx, y: (o.y || 0) + dy };
    _scheduleDraw();
  }

  function _commitLabel(id) {
    const m = _measurements.find(item => item.id === id);
    if (m && m.labelOffset) _onLabelMove?.(id, { ...m.labelOffset });
  }

  function getPhysicalCalibration() {
    const exact = _pixelSizeUm !== null;
    return {
      xUm: exact ? _imgW * _pixelSizeUm : null,
      yUm: exact ? _imgH * _pixelSizeUm : null,
      zUm: 0,
      voxelXUm: _pixelSizeUm, voxelYUm: _pixelSizeUm, voxelZUm: 0,
      calibrationStatus: exact ? 'exact' : 'metadata-missing',
      calibrationNote: exact ? 'Pixel size read from the acquisition metadata.' : 'No pixel size in the metadata.'
    };
  }

  // ── Drawing ────────────────────────────────────────────────────────────────
  function _scheduleDraw() {
    if (_raf) return;
    _raf = requestAnimationFrame(_draw);
  }

  function _draw() {
    _raf = 0;
    if (!_ctx) return;
    const dpr = window.devicePixelRatio || 1;
    _ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    _ctx.fillStyle = _bgColor;
    _ctx.fillRect(0, 0, _cssWidth(), _cssHeight());
    if (_image) _drawImage();
    _drawOverlays();
    _drawMeasurements();
    _drawScaleBar();
  }

  function _drawImage() {
    const src = _displaySource();
    const sw = src.naturalWidth || src.width;
    const sh = src.naturalHeight || src.height;
    const o = _orientedSize();
    _ctx.imageSmoothingEnabled = true;
    _ctx.imageSmoothingQuality = 'high';
    _ctx.save();
    _ctx.translate(_view.tx + o.w / 2 * _view.scale, _view.ty + o.h / 2 * _view.scale);
    _ctx.scale(_view.scale, _view.scale);
    _ctx.rotate(_theta());
    if (_orient.flipH) _ctx.scale(-1, 1);
    _ctx.drawImage(src, 0, 0, sw, sh, -_imgW / 2, -_imgH / 2, _imgW, _imgH);
    _ctx.restore();
  }

  function _drawMeasurements() {
    _labelRects = [];
    for (const m of _measurements) {
      if (!m || m.visible === false || !Array.isArray(m.points) || m.points.length < 2) continue;
      // A stored measurement is data: one malformed entry must not take the frame (and the scale bar) down.
      const n0 = m.points[0]?.normalized, n1 = m.points[1]?.normalized;
      if (!n0 || !n1 || !Number.isFinite(n0.x) || !Number.isFinite(n0.y) || !Number.isFinite(n1.x) || !Number.isFinite(n1.y)) continue;
      const a = _toCanvas(n0.x * _imgW, n0.y * _imgH);
      const b = _toCanvas(n1.x * _imgW, n1.y * _imgH);
      _ctx.lineWidth = 2;
      _ctx.strokeStyle = m.color || '#00FFFF';
      _ctx.fillStyle = m.color || '#00FFFF';
      _ctx.beginPath();
      _ctx.moveTo(a.x, a.y);
      _ctx.lineTo(b.x, b.y);
      _ctx.stroke();
      for (const p of [a, b]) {
        _ctx.beginPath();
        _ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
        _ctx.fill();
      }
      if (!_showLabels) continue;
      const o = m.labelOffset || { x: 0, y: 0 };
      const cx = (a.x + b.x) / 2 + (o.x || 0) * _view.scale;
      const cy = (a.y + b.y) / 2 - _textSize + (o.y || 0) * _view.scale;
      const text = m.label ? `${m.label}: ${_formatUm(m.distance)}` : _formatUm(m.distance);
      _labelRects.push({ id: m.id, ..._label(text, cx, cy, m.color || '#00FFFF', _textSize) });
    }
  }

  function _drawScaleBar() {
    if (!_pixelSizeUm) return;
    const cssPerUm = _view.scale / _pixelSizeUm;
    const lengthUm = _niceLength(SCALE_BAR_TARGET_PX / cssPerUm);
    const px = lengthUm * cssPerUm;
    const x = 16, y = _cssHeight() - 22;
    _ctx.lineWidth = 4;
    _ctx.strokeStyle = 'rgba(0,0,0,0.6)';
    _ctx.beginPath(); _ctx.moveTo(x, y); _ctx.lineTo(x + px, y); _ctx.stroke();
    _ctx.lineWidth = 2;
    _ctx.strokeStyle = '#fff';
    _ctx.beginPath(); _ctx.moveTo(x, y); _ctx.lineTo(x + px, y); _ctx.stroke();
    _label(_formatUm(lengthUm), x + px / 2, y - 12, '#fff');
  }

  /** Nearest 1-2-5 × 10ⁿ at or below the target length. */
  function _niceLength(target) {
    const exp = Math.pow(10, Math.floor(Math.log10(target)));
    const m = target / exp;
    return (m >= 5 ? 5 : m >= 2 ? 2 : 1) * exp;
  }

  /** Draws a boxed label centred on (cx, cy); returns its canvas-space box. */
  function _label(text, cx, cy, color, size = 12) {
    _ctx.font = `600 ${size}px Inter, system-ui, sans-serif`;
    _ctx.textAlign = 'center';
    _ctx.textBaseline = 'middle';
    const w = _ctx.measureText(text).width + size * 0.8;
    const h = size * 1.5;
    _ctx.fillStyle = 'rgba(0,0,0,0.65)';
    _ctx.fillRect(cx - w / 2, cy - h / 2, w, h);
    _ctx.fillStyle = color;
    _ctx.fillText(text, cx, cy);
    return { x: cx - w / 2, y: cy - h / 2, w, h };
  }

  function _formatUm(v) {
    if (!Number.isFinite(v)) return '—';
    return v >= 1000 ? `${(v / 1000).toFixed(v >= 10000 ? 1 : 2)} mm` : `${v.toFixed(v >= 100 ? 0 : 1)} µm`;
  }

  // ── Export ─────────────────────────────────────────────────────────────────
  function toBlob(options = {}) {
    if (!_canvas) return Promise.resolve(null);
    // A capture shows the settings as they are now, not the last rendering that landed.
    return whenProcessed().then(() => {
      _draw();
      return new Promise(resolve => _canvas.toBlob(resolve, options.mime || 'image/png', options.quality || 0.95));
    });
  }

  function getCanvas() { return _canvas; }

  /** What is on screen (adjusted / isolated, mirrored, rotated) at native resolution — the Studio's input. */
  function getNativeCanvas() {
    if (!_image) return null;
    const src = _exactSource();
    const o = _orientedSize();
    const out = document.createElement('canvas');
    out.width = Math.round(o.w);
    out.height = Math.round(o.h);
    const c = out.getContext('2d');
    c.translate(out.width / 2, out.height / 2);
    c.rotate(_theta());
    if (_orient.flipH) c.scale(-1, 1);
    c.drawImage(src, 0, 0, src.naturalWidth || src.width, src.naturalHeight || src.height, -_imgW / 2, -_imgH / 2, _imgW, _imgH);
    return out;
  }

  function _emitState(state) { _onLoadState?.(state); }

  return {
    init, dispose, load, prefetch, resize, hasNative,
    fit, zoomNative, getView, setView, onViewChange, getViewport, getImageSize,
    setOrientation, getOrientation, setAdjustments, getAdjustments,
    addOverlay, redraw, getPhysicalView, setPhysicalView,
    onMeasurePoint, onLoadState, setMeasurements, getPhysicalCalibration,
    setMeasurementTextSize, getMeasurementTextSize, setShowMeasurementLabels, onLabelMove, getPixelSizeUm,
    setIsolateStain, isIsolateStain,
    toBlob, getCanvas, getNativeCanvas, whenProcessed
  };
})();

// A top-level const is not a window property; the Compare page and the split-view host read this pane's viewer through iframe.contentWindow.
window.Viewer2D = Viewer2D;
