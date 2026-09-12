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

  let _canvas = null;
  let _ctx = null;
  let _container = null;
  let _resizeObserver = null;

  let _image = null;                // what is drawable now: preview, then native
  let _hasNative = false;           // the native image.webp has decoded and is what _image holds
  let _isolated = null;             // cached stain-isolation rendering of _image
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
  let _adjusted = null;             // cached adjusted rendering of _image
  let _flatMap = null;              // cached background map used by the flatten option
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
    resize();
  }

  function dispose() {
    _loadToken++;
    _resizeObserver?.disconnect();
    _image = null;
    _hasNative = false;
    _isolated = null;
    _measurements = [];
  }

  /**
   * Start showing a photograph. The preview and the native image are fetched
   * together; whichever decodes first is painted, and a later, smaller image
   * never replaces a larger one already on screen.
   * @returns {Promise<void>} resolves once the native image is on screen
   */
  function load(spec) {
    const token = ++_loadToken;
    _imgW = spec.width;
    _imgH = spec.height;
    _pixelSizeUm = Number.isFinite(spec.pixelSizeUm) && spec.pixelSizeUm > 0 ? spec.pixelSizeUm : null;
    _image = null;
    _hasNative = false;
    _isolated = null;
    _adjusted = null;
    _flatMap = null;
    _measurements = [];
    fit();
    _emitState('loading');

    _decode(spec.previewUrl)
      .then(img => { if (_swap(token, img)) _emitState('preview'); })
      .catch(() => {});
    return _decode(spec.nativeUrl)
      .then(img => { if (_swap(token, img)) { _hasNative = true; _emitState('native'); } })
      .catch(err => {
        if (token === _loadToken && !_image) _emitState('error');
        throw err;
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
    img.src = url;
    if (typeof img.decode === 'function') return img.decode().then(() => img);
    return new Promise((resolve, reject) => {
      img.onload = () => resolve(img);
      img.onerror = reject;
    });
  }

  function _swap(token, img) {
    if (token !== _loadToken) return false;
    if (_image && img.naturalWidth < _image.naturalWidth) return false;
    _image = img;
    _isolated = null;
    _adjusted = null;
    _flatMap = null;
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
    _view = { scale: view.scale, tx: Number(view.tx) || 0, ty: Number(view.ty) || 0 };
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
    _canvas.width = Math.round(w * dpr);
    _canvas.height = Math.round(h * dpr);
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
    _zoomAround(_view.scale * Math.pow(WHEEL_STEP, -e.deltaY / 100), p.x, p.y);
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
   */
  function getPhysicalView() {
    const o = _orientedSize(), px = _pixelSizeUm || 1;
    const ox = (_cssWidth() / 2 - _view.tx) / _view.scale;
    const oy = (_cssHeight() / 2 - _view.ty) / _view.scale;
    return { umPerCss: px / _view.scale, centerUm: { x: (ox - o.w / 2) * px, y: (oy - o.h / 2) * px } };
  }

  function setPhysicalView(pv) {
    if (!pv || !(pv.umPerCss > 0)) return;
    const o = _orientedSize(), px = _pixelSizeUm || 1;
    const scale = px / pv.umPerCss;
    const ox = o.w / 2 + (pv.centerUm?.x || 0) / px;
    const oy = o.h / 2 + (pv.centerUm?.y || 0) / px;
    setView({ scale, tx: _cssWidth() / 2 - ox * scale, ty: _cssHeight() / 2 - oy * scale }, 'physical');
  }

  // ── Display adjustments (non-destructive, display only) ────────────────────
  const ADJUST_DEFAULT = { brightness: 0, contrast: 0, gamma: 1, wbRed: 1, wbBlue: 1, flatten: false };
  const FLAT_SCALE = 8;             // background map resolution
  const FLAT_BACKGROUND_FRACTION = 0.4;   // the darkest 40 % of cells define the illumination model

  /** Partial update; the defaults mean "raw photograph" and free the cache. */
  function setAdjustments(partial) {
    const next = { ...ADJUST_DEFAULT, ...(_adjust || {}), ...(partial || {}) };
    const isDefault = Object.keys(ADJUST_DEFAULT).every(k => next[k] === ADJUST_DEFAULT[k]);
    _adjust = isDefault ? null : next;
    _adjusted = null;
    _scheduleDraw();
  }

  function getAdjustments() { return { ...ADJUST_DEFAULT, ...(_adjust || {}) }; }

  /**
   * Per-channel look-up:  x = v/255 · whiteBalance
   *                       x = (x − ½)·(1 + contrast/100) + ½ + brightness/100
   *                       x = clamp(x)^(1/gamma)
   * The flatten option first divides each pixel by the local background — a
   * grey opening (min then max filter) with a window wider than the specimen,
   * which estimates the illumination fall-off without touching the embryo —
   * so a vignetted background becomes even before the curve is applied.
   */
  function _adjustedImage() {
    if (_adjusted) return _adjusted;
    const w = _image.naturalWidth, h = _image.naturalHeight;
    const off = document.createElement('canvas');
    off.width = w;
    off.height = h;
    const octx = off.getContext('2d', { willReadFrequently: true });
    octx.drawImage(_image, 0, 0);
    const frame = octx.getImageData(0, 0, w, h);
    const lut = _channelLuts();
    const flat = _adjust.flatten ? _flattenMap(w, h) : null;
    const d = frame.data;
    for (let y = 0, i = 0; y < h; y++) {
      const row = flat ? (y / FLAT_SCALE | 0) * flat.w : 0;
      for (let x = 0; x < w; x++, i += 4) {
        const gain = flat ? flat.gain[row + (x / FLAT_SCALE | 0)] : 1;
        d[i] = lut.r[Math.min(255, d[i] * gain) | 0];
        d[i + 1] = lut.g[Math.min(255, d[i + 1] * gain) | 0];
        d[i + 2] = lut.b[Math.min(255, d[i + 2] * gain) | 0];
      }
    }
    octx.putImageData(frame, 0, 0);
    _adjusted = off;
    return off;
  }

  function _channelLuts() {
    const a = _adjust;
    const k = 1 + a.contrast / 100, br = a.brightness / 100, g = 1 / Math.max(0.1, a.gamma);
    const build = (wb) => {
      const lut = new Uint8ClampedArray(256);
      for (let v = 0; v < 256; v++) {
        const x = _unit(((v / 255) * wb - 0.5) * k + 0.5 + br);
        lut[v] = Math.round(Math.pow(x, g) * 255);
      }
      return lut;
    };
    return { r: build(a.wbRed), g: build(1), b: build(a.wbBlue) };
  }

  /**
   * gain(x, y) = mean illumination / local illumination, on a coarse map.
   * The illumination is modelled as a quadratic surface fitted by least squares
   * to the DARK cells only (the lower part of the luminance distribution, i.e.
   * the matte background) — a smooth model cannot follow the embryo, so the
   * specimen keeps its own contrast while the vignette is levelled.
   */
  function _flattenMap(w, h) {
    if (_flatMap) return _flatMap;
    const cw = Math.ceil(w / FLAT_SCALE), ch = Math.ceil(h / FLAT_SCALE);
    const small = document.createElement('canvas');
    small.width = cw;
    small.height = ch;
    const sctx = small.getContext('2d', { willReadFrequently: true });
    sctx.drawImage(_image, 0, 0, cw, ch);
    const px = sctx.getImageData(0, 0, cw, ch).data;
    const lum = new Float32Array(cw * ch);
    for (let i = 0; i < cw * ch; i++) lum[i] = 0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2];
    const cutoff = _percentile(lum, FLAT_BACKGROUND_FRACTION);
    const coef = _fitQuadratic(lum, cw, ch, cutoff);
    const gain = new Float32Array(cw * ch);
    let mean = 0;
    for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) mean += _quadratic(coef, x / cw, y / ch);
    mean /= cw * ch;
    for (let y = 0; y < ch; y++) {
      for (let x = 0; x < cw; x++) {
        gain[y * cw + x] = Math.max(0.5, Math.min(3, mean / Math.max(1, _quadratic(coef, x / cw, y / ch))));
      }
    }
    _flatMap = { gain, w: cw, h: ch };
    return _flatMap;
  }

  function _percentile(values, fraction) {
    const sorted = Float32Array.from(values).sort();
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
  }

  function _quadratic(c, x, y) {
    return c[0] + c[1] * x + c[2] * y + c[3] * x * x + c[4] * y * y + c[5] * x * y;
  }

  /** Least-squares fit of z = c0 + c1·x + c2·y + c3·x² + c4·y² + c5·xy over cells with z ≤ cutoff. */
  function _fitQuadratic(lum, cw, ch, cutoff) {
    const n = 6, ata = Array.from({ length: n }, () => new Float64Array(n)), atb = new Float64Array(n);
    for (let y = 0; y < ch; y++) {
      for (let x = 0; x < cw; x++) {
        const z = lum[y * cw + x];
        if (z > cutoff) continue;
        const u = x / cw, v = y / ch, row = [1, u, v, u * u, v * v, u * v];
        for (let i = 0; i < n; i++) {
          atb[i] += row[i] * z;
          for (let j = 0; j < n; j++) ata[i][j] += row[i] * row[j];
        }
      }
    }
    return _solve(ata, atb);
  }

  /** Gaussian elimination with partial pivoting; a singular system yields a flat surface. */
  function _solve(a, b) {
    const n = b.length, m = a.map((row, i) => [...row, b[i]]);
    for (let col = 0; col < n; col++) {
      let pivot = col;
      for (let r = col + 1; r < n; r++) if (Math.abs(m[r][col]) > Math.abs(m[pivot][col])) pivot = r;
      if (Math.abs(m[pivot][col]) < 1e-12) return [b[0] / Math.max(1, a[0][0]), 0, 0, 0, 0, 0];
      [m[col], m[pivot]] = [m[pivot], m[col]];
      for (let r = 0; r < n; r++) {
        if (r === col) continue;
        const f = m[r][col] / m[col][col];
        for (let c = col; c <= n; c++) m[r][c] -= f * m[col][c];
      }
    }
    return m.map((row, i) => row[n] / row[i]);
  }

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

  // ── Stain isolation ────────────────────────────────────────────────────────
  function setIsolateStain(on) {
    _isolate = Boolean(on);
    _scheduleDraw();
  }

  function isIsolateStain() { return _isolate; }

  /**
   * Stain isolation — a display aid, nothing measured reads it.
   *
   * X-gal lowers red and green far more than blue, so a stained pixel has
   * B/R well above 1 (measured 2 to 4 in the densest cores) while unstained
   * tissue sits near 0.6. The term is gated by a TISSUE CONTEXT — the local
   * mean of "yellowness" (R+G)/2 − B over a ~40 px window — because the
   * matte background carries blue speckles that would otherwise light up: a
   * stain is something blue INSIDE yellow tissue. The gate is low (5) on
   * purpose: a wide stained trunk drags the local mean down to 6–9 while
   * the background never exceeds 2–6. The specimen is painted in dimmed grey
   * and the stain in cyan.
   */
  const ISO_RATIO_LO = 1.0, ISO_RATIO_HI = 1.8;   // B/R mapped to 0..1
  const ISO_CTX_SCALE = 4, ISO_CTX_RADIUS = 5;    // context map: ¼ res, 5-cell box ≈ 40 px
  const ISO_CTX_MIN = 5;                          // tissue-context gate

  function _isolation() {
    if (_isolated) return _isolated;
    const w = _image.naturalWidth, h = _image.naturalHeight;
    const off = document.createElement('canvas');
    off.width = w;
    off.height = h;
    const octx = off.getContext('2d', { willReadFrequently: true });
    octx.drawImage(_image, 0, 0);
    const frame = octx.getImageData(0, 0, w, h);
    const ctxMap = _tissueContext(w, h);
    const d = frame.data;
    for (let y = 0, i = 0; y < h; y++) {
      const row = (y / ISO_CTX_SCALE | 0) * ctxMap.w;
      for (let x = 0; x < w; x++, i += 4) {
        const r = d[i], g = d[i + 1], b = d[i + 2];
        const lum = 0.299 * r + 0.587 * g + 0.114 * b;
        const tissue = ctxMap.data[row + (x / ISO_CTX_SCALE | 0)];
        const v = tissue > ISO_CTX_MIN ? _unit((b / (r + 1) - ISO_RATIO_LO) / (ISO_RATIO_HI - ISO_RATIO_LO)) : 0;
        const grey = lum * 0.35 * (1 - v);
        d[i] = grey + v * 90;
        d[i + 1] = grey + v * 160;
        d[i + 2] = grey + v * 255;
      }
    }
    octx.putImageData(frame, 0, 0);
    _isolated = off;
    return off;
  }

  function _unit(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

  /** Box-blurred yellowness at 1/ISO_CTX_SCALE resolution (summed-area table). */
  function _tissueContext(w, h) {
    const cw = Math.ceil(w / ISO_CTX_SCALE), ch = Math.ceil(h / ISO_CTX_SCALE);
    const small = document.createElement('canvas');
    small.width = cw;
    small.height = ch;
    const sctx = small.getContext('2d', { willReadFrequently: true });
    sctx.drawImage(_image, 0, 0, cw, ch);
    const px = sctx.getImageData(0, 0, cw, ch).data;
    const sat = new Float32Array((cw + 1) * (ch + 1));
    for (let y = 1; y <= ch; y++) {
      let run = 0;
      for (let x = 1; x <= cw; x++) {
        const i = ((y - 1) * cw + (x - 1)) * 4;
        run += Math.max(0, (px[i] + px[i + 1]) / 2 - px[i + 2]);
        sat[y * (cw + 1) + x] = sat[(y - 1) * (cw + 1) + x] + run;
      }
    }
    const data = new Float32Array(cw * ch);
    const r = ISO_CTX_RADIUS, stride = cw + 1;
    for (let y = 0; y < ch; y++) {
      const y0 = Math.max(0, y - r), y1 = Math.min(ch, y + r + 1);
      for (let x = 0; x < cw; x++) {
        const x0 = Math.max(0, x - r), x1 = Math.min(cw, x + r + 1);
        const sum = sat[y1 * stride + x1] - sat[y0 * stride + x1] - sat[y1 * stride + x0] + sat[y0 * stride + x0];
        data[y * cw + x] = sum / ((y1 - y0) * (x1 - x0));
      }
    }
    return { data, w: cw, h: ch };
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
    _ctx.fillStyle = getComputedStyle(_container).backgroundColor || '#000';
    _ctx.fillRect(0, 0, _cssWidth(), _cssHeight());
    if (_image) _drawImage();
    _drawOverlays();
    _drawMeasurements();
    _drawScaleBar();
  }

  function _displaySource() {
    if (_isolate) return _isolation();
    return _adjust ? _adjustedImage() : _image;
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
      if (m.visible === false || !Array.isArray(m.points) || m.points.length < 2) continue;
      const a = _toCanvas(m.points[0].normalized.x * _imgW, m.points[0].normalized.y * _imgH);
      const b = _toCanvas(m.points[1].normalized.x * _imgW, m.points[1].normalized.y * _imgH);
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
    _draw();
    return new Promise(resolve => _canvas.toBlob(resolve, options.mime || 'image/png', options.quality || 0.95));
  }

  function getCanvas() { return _canvas; }

  /** What is on screen (adjusted / isolated, mirrored, rotated) at native resolution — the Studio's input. */
  function getNativeCanvas() {
    if (!_image) return null;
    const src = _displaySource();
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
    toBlob, getCanvas, getNativeCanvas
  };
})();

// A top-level const is not a window property; the Compare page and the split-view host read this pane's viewer through iframe.contentWindow.
window.Viewer2D = Viewer2D;
