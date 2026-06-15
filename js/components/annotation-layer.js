/* ============================================================
   IRIBHM Microscopy Platform — Annotation Layer
   ============================================================
   2D annotation overlay on slice canvas.
   Supports rectangles, arrows/lines, and text labels,
   linked to the cut plane coordinates.
   ============================================================ */

const AnnotationLayer = (() => {
  let _canvas = null;
  let _ctx = null;
  let _annotations = [];
  let _activeTool = 'select'; // select | rectangle | arrow | label
  let _drawing = null;
  let _selectedIndex = -1;
  let _planeSpec = null;
  let _onChange = null;

  const COLORS = ['#ff4d4f', '#00d2ff', '#ffd166', '#00a654', '#9b59b6', '#ff6b6b'];
  let _colorIndex = 0;

  function init(canvasId, options = {}) {
    _canvas = document.getElementById(canvasId);
    if (!_canvas) return;
    _ctx = _canvas.getContext('2d');
    _onChange = options.onChange || null;

    _canvas.addEventListener('pointerdown', _onPointerDown);
    _canvas.addEventListener('pointermove', _onPointerMove);
    _canvas.addEventListener('pointerup', _onPointerUp);
    _canvas.addEventListener('pointerleave', _onPointerUp);
    _canvas.addEventListener('dblclick', _onDblClick);
  }

  function setTool(tool) {
    _activeTool = ['select', 'rectangle', 'arrow', 'label'].includes(tool) ? tool : 'select';
  }

  function setPlaneSpec(spec) {
    _planeSpec = spec ? { ...spec } : null;
  }

  function getAnnotations() {
    return _annotations.map(a => ({ ...a }));
  }

  function setAnnotations(list = []) {
    _annotations = Array.isArray(list) ? list.map(a => ({ ...a })) : [];
    _draw();
  }

  function clear() {
    _annotations = [];
    _selectedIndex = -1;
    _draw();
    _notify();
  }

  function removeSelected() {
    if (_selectedIndex >= 0 && _selectedIndex < _annotations.length) {
      _annotations.splice(_selectedIndex, 1);
      _selectedIndex = -1;
      _draw();
      _notify();
    }
  }

  // ── Drawing ──────────────────────────────────────────────

  function _draw() {
    if (!_ctx || !_canvas) return;
    _ctx.clearRect(0, 0, _canvas.width, _canvas.height);
    const w = _canvas.width;
    const h = _canvas.height;

    _annotations.forEach((ann, idx) => {
      const isSelected = idx === _selectedIndex;
      const baseScale = Math.max(1, w / 500);
      
      _ctx.save();
      _ctx.strokeStyle = ann.color || COLORS[idx % COLORS.length];
      _ctx.fillStyle = ann.color || COLORS[idx % COLORS.length];
      _ctx.lineWidth = (isSelected ? 3 : 2) * baseScale;
      _ctx.globalAlpha = isSelected ? 1.0 : 0.85;

      if (ann.type === 'rectangle') {
        _ctx.setLineDash(isSelected ? [6, 3] : []);
        _ctx.strokeRect(ann.x * w, ann.y * h, ann.w * w, ann.h * h);
        _ctx.globalAlpha = 0.08;
        _ctx.fillRect(ann.x * w, ann.y * h, ann.w * w, ann.h * h);
      }

      if (ann.type === 'arrow') {
        _drawArrow(
          _ctx,
          ann.x1 * w, ann.y1 * h,
          ann.x2 * w, ann.y2 * h,
          isSelected
        );
      }

      if (ann.label) {
        const lx = ann.type === 'rectangle'
          ? (ann.x + ann.w / 2) * w
          : ann.type === 'arrow'
            ? (ann.x1 + ann.x2) / 2 * w
            : (ann.x || 0.5) * w;
        const ly = ann.type === 'rectangle'
          ? ann.y * h - 6
          : ann.type === 'arrow'
            ? (ann.y1 + ann.y2) / 2 * h - 6
            : (ann.y || 0.5) * h;

        const fontSize = Math.max(12, Math.round(14 * baseScale));
        _ctx.globalAlpha = 1;
        _ctx.font = `bold ${fontSize}px Inter, Arial, sans-serif`;
        _ctx.textAlign = 'center';
        const textWidth = _ctx.measureText(ann.label).width + 12 * baseScale;
        const boxHeight = fontSize + 8 * baseScale;
        
        _ctx.fillStyle = 'rgba(0,0,0,0.6)';
        _ctx.fillRect(lx - textWidth / 2, ly - boxHeight + 4 * baseScale, textWidth, boxHeight);
        _ctx.fillStyle = ann.color || '#ffffff';
        _ctx.fillText(ann.label, lx, ly);
      }

      _ctx.restore();
    });

    // Draw in-progress shape
    if (_drawing) {
      _ctx.save();
      _ctx.strokeStyle = '#ffffff';
      _ctx.lineWidth = 2;
      _ctx.setLineDash([5, 4]);
      _ctx.globalAlpha = 0.7;

      if (_drawing.type === 'rectangle') {
        const x = Math.min(_drawing.startX, _drawing.currentX);
        const y = Math.min(_drawing.startY, _drawing.currentY);
        const rw = Math.abs(_drawing.currentX - _drawing.startX);
        const rh = Math.abs(_drawing.currentY - _drawing.startY);
        _ctx.strokeRect(x * w, y * h, rw * w, rh * h);
      }

      if (_drawing.type === 'arrow') {
        _drawArrow(
          _ctx,
          _drawing.startX * w, _drawing.startY * h,
          _drawing.currentX * w, _drawing.currentY * h,
          false
        );
      }

      _ctx.restore();
    }
  }

  function _drawArrow(ctx, x1, y1, x2, y2, selected) {
    const headLen = 12;
    const angle = Math.atan2(y2 - y1, x2 - x1);

    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();

    // Arrowhead
    ctx.beginPath();
    ctx.moveTo(x2, y2);
    ctx.lineTo(
      x2 - headLen * Math.cos(angle - Math.PI / 6),
      y2 - headLen * Math.sin(angle - Math.PI / 6)
    );
    ctx.lineTo(
      x2 - headLen * Math.cos(angle + Math.PI / 6),
      y2 - headLen * Math.sin(angle + Math.PI / 6)
    );
    ctx.closePath();
    ctx.fill();
  }

  // ── Interaction ──────────────────────────────────────────

  function _normPoint(event) {
    if (!_canvas) return null;
    const rect = _canvas.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (event.clientX - rect.left) / Math.max(1, rect.width))),
      y: Math.max(0, Math.min(1, (event.clientY - rect.top) / Math.max(1, rect.height)))
    };
  }

  function _onPointerDown(event) {
    const p = _normPoint(event);
    if (!p) return;

    if (_activeTool === 'select') {
      _selectedIndex = _hitTest(p);
      _draw();
      return;
    }

    if (_activeTool === 'label') {
      // Create a label annotation at click position
      const label = prompt('Enter annotation label:');
      if (label) {
        _annotations.push({
          type: 'label',
          x: p.x,
          y: p.y,
          label,
          color: _nextColor(),
          planeSpec: _planeSpec ? { ..._planeSpec } : null,
          createdAt: new Date().toISOString()
        });
        _draw();
        _notify();
      }
      return;
    }

    _canvas.setPointerCapture?.(event.pointerId);
    _drawing = {
      type: _activeTool,
      startX: p.x,
      startY: p.y,
      currentX: p.x,
      currentY: p.y
    };
    _draw();
  }

  function _onPointerMove(event) {
    if (!_drawing) return;
    const p = _normPoint(event);
    if (!p) return;
    _drawing.currentX = p.x;
    _drawing.currentY = p.y;
    _draw();
  }

  function _onPointerUp() {
    if (!_drawing) return;

    if (_drawing.type === 'rectangle') {
      const x = Math.min(_drawing.startX, _drawing.currentX);
      const y = Math.min(_drawing.startY, _drawing.currentY);
      const w = Math.abs(_drawing.currentX - _drawing.startX);
      const h = Math.abs(_drawing.currentY - _drawing.startY);
      if (w > 0.01 && h > 0.01) {
        _annotations.push({
          type: 'rectangle',
          x, y, w, h,
          label: '',
          color: _nextColor(),
          planeSpec: _planeSpec ? { ..._planeSpec } : null,
          createdAt: new Date().toISOString()
        });
      }
    }

    if (_drawing.type === 'arrow') {
      const dx = Math.abs(_drawing.currentX - _drawing.startX);
      const dy = Math.abs(_drawing.currentY - _drawing.startY);
      if (dx > 0.01 || dy > 0.01) {
        _annotations.push({
          type: 'arrow',
          x1: _drawing.startX,
          y1: _drawing.startY,
          x2: _drawing.currentX,
          y2: _drawing.currentY,
          label: '',
          color: _nextColor(),
          planeSpec: _planeSpec ? { ..._planeSpec } : null,
          createdAt: new Date().toISOString()
        });
      }
    }

    _drawing = null;
    _draw();
    _notify();
  }

  function _onDblClick(event) {
    const p = _normPoint(event);
    if (!p) return;
    const idx = _hitTest(p);
    if (idx < 0) return;
    const label = prompt('Edit label:', _annotations[idx].label || '');
    if (label !== null) {
      _annotations[idx].label = label;
      _draw();
      _notify();
    }
  }

  function _hitTest(point) {
    for (let i = _annotations.length - 1; i >= 0; i--) {
      const ann = _annotations[i];
      if (ann.type === 'rectangle') {
        if (point.x >= ann.x && point.x <= ann.x + ann.w &&
            point.y >= ann.y && point.y <= ann.y + ann.h) return i;
      }
      if (ann.type === 'arrow') {
        const dist = _pointToLineDistance(
          point.x, point.y,
          ann.x1, ann.y1, ann.x2, ann.y2
        );
        if (dist < 0.025) return i;
      }
      if (ann.type === 'label') {
        if (Math.abs(point.x - ann.x) < 0.04 && Math.abs(point.y - ann.y) < 0.03) return i;
      }
    }
    return -1;
  }

  function _pointToLineDistance(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const lenSq = dx * dx + dy * dy;
    if (lenSq < 1e-9) return Math.hypot(px - x1, py - y1);
    const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / lenSq));
    const closestX = x1 + t * dx;
    const closestY = y1 + t * dy;
    return Math.hypot(px - closestX, py - closestY);
  }

  function _nextColor() {
    const color = COLORS[_colorIndex % COLORS.length];
    _colorIndex++;
    return color;
  }

  function _notify() {
    if (_onChange) _onChange(_annotations);
  }

  /**
   * Render annotations onto an export canvas (for embedding in PNG output).
   */
  function renderToCanvas(targetCanvas, width, height) {
    const ctx = targetCanvas.getContext('2d');
    _annotations.forEach(ann => {
      ctx.save();
      ctx.strokeStyle = ann.color || '#ff4d4f';
      ctx.fillStyle = ann.color || '#ff4d4f';
      ctx.lineWidth = 2;
      ctx.globalAlpha = 0.9;

      if (ann.type === 'rectangle') {
        ctx.strokeRect(ann.x * width, ann.y * height, ann.w * width, ann.h * height);
      }
      if (ann.type === 'arrow') {
        _drawArrow(ctx, ann.x1 * width, ann.y1 * height, ann.x2 * width, ann.y2 * height, false);
      }
      if (ann.label) {
        const lx = ann.type === 'rectangle'
          ? (ann.x + ann.w / 2) * width
          : ann.type === 'arrow'
            ? (ann.x1 + ann.x2) / 2 * width
            : (ann.x || 0.5) * width;
        const ly = ann.type === 'rectangle'
          ? ann.y * height - 4
          : ann.type === 'arrow'
            ? (ann.y1 + ann.y2) / 2 * height - 4
            : (ann.y || 0.5) * height;

        const baseScale = Math.max(1, width / 500);
        const fontSize = Math.max(12, Math.round(14 * baseScale));
        ctx.font = `bold ${fontSize}px Inter, Arial, sans-serif`;
        ctx.textAlign = 'center';
        const tw = ctx.measureText(ann.label).width + 12 * baseScale;
        const boxHeight = fontSize + 8 * baseScale;
        
        ctx.fillStyle = 'rgba(0,0,0,0.6)';
        ctx.fillRect(lx - tw / 2, ly - boxHeight + 4 * baseScale, tw, boxHeight);
        ctx.fillStyle = ann.color || '#ffffff';
        ctx.fillText(ann.label, lx, ly);
      }
      ctx.restore();
    });
  }

  return {
    init,
    setTool,
    setPlaneSpec,
    getAnnotations,
    setAnnotations,
    clear,
    removeSelected,
    renderToCanvas,
    redraw: _draw
  };
})();
