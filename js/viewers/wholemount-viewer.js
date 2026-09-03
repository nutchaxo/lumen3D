/* ============================================================
   Lumen3D — Wholemount Viewer
   ============================================================
   2D canvas renderer for one calibrated photograph. Owns the view
   transform (pan / zoom), the two-step image load (the small preview
   paints first, the native image is swapped in the moment it decodes),
   the scale bar, the distance measurements and the stain-isolation view.

   Coordinates — image pixels (ix, iy) reach the canvas through
       sx = ix · scale + tx        sy = iy · scale + ty
   where `scale` is CSS pixels per image pixel. A physical length L (µm)
   therefore spans  L / pixelSizeUm · scale  CSS pixels: that single
   relation is the whole calibration, for the scale bar and the picks.
   ============================================================ */

const WholemountViewer = (() => {
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
  let _textSize = 14;               // label font size, CSS px
  let _showLabels = true;

  let _pointers = new Map();
  let _gesture = null;
  let _raf = 0;

  let _onMeasurePoint = null;
  let _onLoadState = null;
  let _onViewChange = null;
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
    _isolated = null;
    _measurements = [];
    fit();
    _emitState('loading');

    _decode(spec.previewUrl)
      .then(img => { if (_swap(token, img)) _emitState('preview'); })
      .catch(() => {});
    return _decode(spec.nativeUrl)
      .then(img => { if (_swap(token, img)) _emitState('native'); })
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
    _scheduleDraw();
    return true;
  }

  // ── View transform ─────────────────────────────────────────────────────────
  function fit() {
    const w = _cssWidth(), h = _cssHeight();
    if (!_imgW || !_imgH || !w || !h) return;
    _fitScale = Math.min(w / _imgW, h / _imgH) * FIT_MARGIN;
    _view = {
      scale: _fitScale,
      tx: (w - _imgW * _fitScale) / 2,
      ty: (h - _imgH * _fitScale) / 2
    };
    _viewChanged();
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
    _viewChanged();
  }

  function _pan(dx, dy) {
    _view = { scale: _view.scale, tx: _view.tx + dx, ty: _view.ty + dy };
    _viewChanged();
  }

  function getView() { return { ..._view }; }

  function setView(view) {
    if (!view || !Number.isFinite(view.scale) || view.scale <= 0) return;
    _view = { scale: view.scale, tx: Number(view.tx) || 0, ty: Number(view.ty) || 0 };
    _viewChanged();
  }

  function _viewChanged() {
    _scheduleDraw();
    _onViewChange?.(getView());
  }

  function resize() {
    if (!_canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const w = _cssWidth(), h = _cssHeight();
    if (!w || !h) return;
    const wasFitted = Math.abs(_view.scale - _fitScale) < 1e-9;
    _canvas.width = Math.round(w * dpr);
    _canvas.height = Math.round(h * dpr);
    if (wasFitted || !_image) fit();
    else _scheduleDraw();
  }

  function _cssWidth() { return _canvas ? _canvas.clientWidth : 0; }
  function _cssHeight() { return _canvas ? _canvas.clientHeight : 0; }

  function _toImage(sx, sy) {
    return { x: (sx - _view.tx) / _view.scale, y: (sy - _view.ty) / _view.scale };
  }

  function _toCanvas(ix, iy) {
    return { x: ix * _view.scale + _view.tx, y: iy * _view.scale + _view.ty };
  }

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
  function onViewChange(cb) { _onViewChange = cb; }

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
    _drawMeasurements();
    _drawScaleBar();
  }

  function _drawImage() {
    const src = _isolate ? _isolation() : _image;
    const sw = src.naturalWidth || src.width;
    const sh = src.naturalHeight || src.height;
    _ctx.imageSmoothingEnabled = true;
    _ctx.imageSmoothingQuality = 'high';
    _ctx.drawImage(src, 0, 0, sw, sh, _view.tx, _view.ty, _imgW * _view.scale, _imgH * _view.scale);
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

  /** The current rendering (plain or isolated) at native resolution — the Studio's input. */
  function getNativeCanvas() {
    if (!_image) return null;
    const src = _isolate ? _isolation() : _image;
    const out = document.createElement('canvas');
    out.width = _imgW;
    out.height = _imgH;
    out.getContext('2d').drawImage(src, 0, 0, _imgW, _imgH);
    return out;
  }

  function _emitState(state) { _onLoadState?.(state); }

  return {
    init, dispose, load, prefetch, resize,
    fit, zoomNative, getView, setView, onViewChange,
    onMeasurePoint, onLoadState, setMeasurements, getPhysicalCalibration,
    setMeasurementTextSize, getMeasurementTextSize, setShowMeasurementLabels, onLabelMove, getPixelSizeUm,
    setIsolateStain, isIsolateStain,
    toBlob, getCanvas, getNativeCanvas
  };
})();
