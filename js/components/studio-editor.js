/* ============================================================
   IRIBHM Microscopy Platform - Production Slice Studio
   ============================================================ */

const StudioEditor = (() => {
  const DOC_VERSION = 2;
  const COLORS = ['#ff4d4f', '#00d2ff', '#ffd166', '#00a654', '#9b59b6', '#ffffff'];
  const STUDIO_SLICE_SUPPRESSION = {
    floorMax: 128,
    signalThreshold: 6
  };
  const SCALEBAR_STEP = 10;
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
  let _draggedLayerId = null;
  let _history = [];
  let _future = [];
  let _studioHistograms = [];
  let _activeStudioPanelIndex = 0;

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

  function open(sliceResult) {
    if (!sliceResult?.canvas) {
      _toast(_t('toast.renderSliceFirst', 'Render a slice before opening Studio.'));
      return;
    }
    const preparedSlice = _prepareSliceForStudio(sliceResult);
    _sliceResult = preparedSlice;
    _sliceImage = preparedSlice.canvas;
    _doc = _createDocument(preparedSlice);
    _history = [];
    _future = [];
    _selectedId = null;
    _activeTool = 'select';
    _isOpen = true;
    _container.classList.remove('hidden');
    _resizeCanvas();
    _fitImageToViewport();
    _ensureDefaultScaleBarLayer();
    _pushHistory('Open Studio');
    _renderAll();
  }

  function setSliceResult(sliceResult, options = {}) {
    if (!sliceResult?.canvas) return;
    if (!_doc || !_isOpen || options.reopen) {
      open(sliceResult);
      return;
    }
    const preparedSlice = _prepareSliceForStudio(sliceResult);
    _sliceResult = preparedSlice;
    _sliceImage = preparedSlice.canvas;
    _doc.sourceSlice.width = preparedSlice.width;
    _doc.sourceSlice.height = preparedSlice.height;
    _doc.sourceSlice.source = preparedSlice.source || _doc.sourceSlice.source;
    _doc.sourceSlice.quality = preparedSlice.quality || _doc.sourceSlice.quality;
    _doc.planeSpec = _clone(preparedSlice.planeSpec || _doc.planeSpec || {});
    _doc.timepoint = preparedSlice.timepoint ?? _doc.timepoint;
    _doc.calibration.pixelSizeUm = _clone(preparedSlice.pixelSizeUm || _doc.calibration.pixelSizeUm);
    _doc.calibration.spanUm = _clone(preparedSlice.spanUm || _doc.calibration.spanUm);
    _doc.calibration.physicalSizeUm = _clone(preparedSlice.physicalSizeUm || _doc.calibration.physicalSizeUm);
    _ensureDefaultScaleBarLayer();
    _renderAll();
  }

  function close() {
    if (!_isOpen) return;
    _isOpen = false;
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
    const dataset = typeof ViewerApp !== 'undefined' && ViewerApp.getDatasetMeta
      ? ViewerApp.getDatasetMeta()
      : null;
    const channelState = sliceResult.channelState
      || (typeof ViewerApp !== 'undefined' && ViewerApp.getChannelState ? ViewerApp.getChannelState() : []);
    const pixelSizeUm = sliceResult.pixelSizeUm || { x: 1, y: 1 };
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
        pixelSizeUm: {
          x: Number(pixelSizeUm.x) || 1,
          y: Number(pixelSizeUm.y) || Number(pixelSizeUm.x) || 1
        },
        spanUm: _clone(sliceResult.spanUm || null),
        physicalSizeUm: _clone(sliceResult.physicalSizeUm || null)
      },
      layoutMaps: (sliceResult.layoutMaps || []).map(m => ({
        ..._clone({ ...m, iframe: undefined, raw: undefined, sliceResult: undefined }),
        iframe: m.iframe,
        raw: m.raw,
        sliceResult: m.sliceResult
      })),
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
      _draw();
    });
    document.getElementById('btn-studio-export-png')?.addEventListener('click', _exportPng);
    document.getElementById('btn-studio-export-json')?.addEventListener('click', _exportJson);
    document.getElementById('btn-studio-import')?.addEventListener('click', () => document.getElementById('studio-import-file')?.click());
    document.getElementById('studio-import-file')?.addEventListener('change', _importJson);

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

    if (window.I18n && window.I18n.translateDOM) window.I18n.translateDOM();
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
        _draw();
      });
      document.getElementById('studio-rotation-slider')?.addEventListener('input', (event) => {
        if (!_doc) return;
        _doc.viewport.rotation = (Number(event.target.value) || 0) * Math.PI / 180;
        document.getElementById('studio-rotation-val').textContent = `${event.target.value} deg`;
        _draw();
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
    _draw();
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

  function _renderCompareMenus() {
    document.querySelectorAll('.studio-compare-menu').forEach(el => el.remove());

    if (!_doc || !_doc.layoutMaps || _doc.layoutMaps.length <= 1) return;

    const workspace = document.getElementById('studio-workspace');
    if (!workspace) return;
    const canvasRect = _canvas.getBoundingClientRect();
    const workspaceRect = workspace.getBoundingClientRect();
    const offsetX = canvasRect.left - workspaceRect.left;
    const offsetY = canvasRect.top - workspaceRect.top;

    _doc.layoutMaps.forEach((map, index) => {
      // Position at bottom-right of this layout map cell
      const screenPt = _imageToScreen({ x: map.x + map.w, y: map.y + map.h });

      const btn = document.createElement('button');
      btn.className = 'studio-compare-menu btn btn-icon btn-sm shadow-md transition-all';
      btn.style.position = 'absolute';
      btn.style.left = `${offsetX + screenPt.x - 36}px`;
      btn.style.top = `${offsetY + screenPt.y - 36}px`;
      btn.style.zIndex = '100';
      btn.style.background = index === _activeStudioPanelIndex
        ? 'var(--color-primary, #3b82f6)' : 'var(--bg-surface, #1e1e2e)';
      btn.style.color = index === _activeStudioPanelIndex
        ? '#fff' : 'var(--text-muted, #888)';
      btn.style.border = '1px solid rgba(255,255,255,0.15)';
      btn.style.borderRadius = '6px';
      
      btn.innerHTML = '<i data-lucide="sliders-horizontal"></i>';
      btn.title = `Panel ${index + 1} channels`;
      
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        _activeStudioPanelIndex = index;
        _renderChannels();
        _renderCompareMenus();
      });

      workspace.appendChild(btn);
    });
    if (window.lucide) lucide.createIcons();
  }

  function _draw() {
    if (!_ctx || !_canvas || !_doc || !_sliceImage) return;
    const { viewport } = _doc;
    _ctx.setTransform(1, 0, 0, 1, 0, 0);
    _ctx.clearRect(0, 0, _canvas.width, _canvas.height);
    _drawWorkspaceGrid();
    _ctx.save();
    _applyImageTransform(_ctx, viewport);
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
    ctx.drawImage(_sliceImage, ix, iy, iw, ih);
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
      ctx.font = `${style.fontWeight || 700} ${style.fontSize || 18}px Inter, Arial, sans-serif`;
      ctx.textBaseline = 'top';
      ctx.textAlign = 'left';
      const pad = 5;
      const metrics = ctx.measureText(layer.text || '');
      layer.w = Math.max(20, metrics.width);
      layer.h = style.fontSize || 18;
      if (style.textBackground !== false) {
        ctx.fillStyle = 'rgba(0,0,0,0.55)';
        ctx.fillRect(layer.x - pad, layer.y - pad, layer.w + pad * 2, layer.h + pad * 2);
      }
      ctx.fillStyle = style.stroke || '#ffffff';
      ctx.fillText(layer.text || '', layer.x, layer.y);
    }
    ctx.restore();
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
    ctx.fillStyle = 'rgba(0,0,0,0.58)';
    ctx.fillRect(mx - metrics.width / 2 - 6, my - fontSize - 12, metrics.width + 12, fontSize + 8);
    ctx.fillStyle = style.stroke || '#ffffff';
    ctx.fillText(label, mx, my - 7);
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
    const box = _layerBounds(layer);
    ctx.save();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = Math.max(1, 1.5 / _doc.viewport.zoom);
    ctx.setLineDash([5 / _doc.viewport.zoom, 5 / _doc.viewport.zoom]);
    ctx.strokeRect(box.x, box.y, box.w, box.h);
    ctx.setLineDash([]);
    handles.forEach(handle => {
      ctx.fillStyle = handle.id === _hoverHandle ? '#00d2ff' : '#ffffff';
      const s = 6 / _doc.viewport.zoom;
      ctx.fillRect(handle.x - s / 2, handle.y - s / 2, s, s);
      ctx.strokeStyle = '#050607';
      ctx.strokeRect(handle.x - s / 2, handle.y - s / 2, s, s);
    });
    ctx.restore();
  }

  function _onPointerDown(event) {
    if (!_doc || !_sliceImage) return;
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
    if (event.button === 1 || event.button === 2 || event.shiftKey || _spaceDown) {
      _isPanning = true;
      _pointerStart = { x: event.clientX, y: event.clientY, panX: _doc.viewport.panX, panY: _doc.viewport.panY };
      _canvas.style.cursor = 'grabbing';
      return;
    }

    if (_activeTool === 'select') {
      const hit = _hitTest(imagePoint);
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
      const text = prompt('Text label:', 'Annotation');
      if (text) {
        _pushLayer(_newTextLayer(imagePoint, text));
        _setTool('select');
      }
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
    if (_isRotating && _rotationStart) {
      const dx = event.clientX - _rotationStart.x;
      _doc.viewport.rotation = _rotationStart.rotation + (dx * 0.008);
      const slider = document.getElementById('studio-rotation-slider');
      const deg = Math.round((_doc.viewport.rotation * 180 / Math.PI));
      if (slider) slider.value = String(((deg + 540) % 360) - 180);
      const label = document.getElementById('studio-rotation-val');
      if (label) label.textContent = `${Math.round(_doc.viewport.rotation * 180 / Math.PI)} deg`;
      _draw();
      return;
    }
    if (_isPanning && _pointerStart) {
      _doc.viewport.panX = _pointerStart.panX + (event.clientX - _pointerStart.x);
      _doc.viewport.panY = _pointerStart.panY + (event.clientY - _pointerStart.y);
      _draw();
      _renderCompareMenus();
      return;
    }
    const imagePoint = _screenToImage(_eventCanvasPoint(event));
    if (!_drawing) {
      const hit = _hitTest(imagePoint);
      _hoverHandle = hit?.handle || null;
      _canvas.style.cursor = hit?.handle ? 'nwse-resize' : hit ? 'move' : (_activeTool === 'select' ? 'default' : 'crosshair');
      _draw();
      return;
    }
    if (_drawing.type === 'angle') {
      _drawing.current = imagePoint;
      _draw();
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
      _draw();
      return;
    }
    if (_drawing.mode === 'handle') {
      const layer = _selectedLayer();
      if (layer) {
        _applyHandle(layer, _drawing.handle, imagePoint, _drawing.original);
        _updateMeasurementText(layer);
      }
      _draw();
      return;
    }
    _drawing.current = imagePoint;
    _draw();
  }

  function _onPointerUp() {
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
    if (_drawing.mode === 'move' || _drawing.mode === 'handle') {
      _pushHistory('Edit layer');
      _drawing = null;
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
    const canvasPoint = _eventCanvasPoint(event);
    const before = _screenToImage(canvasPoint);
    const zoom = _doc.viewport.zoom;
    const factor = event.deltaY > 0 ? 0.9 : 1.1;
    _doc.viewport.zoom = Math.max(0.02, Math.min(32, _doc.viewport.zoom * factor));
    const after = _screenToImage(canvasPoint);
    const dx = after.x - before.x;
    const dy = after.y - before.y;
    const cx = dx / _doc.viewport.zoom;
    const cy = dy / _doc.viewport.zoom;
    _doc.viewport.panX += cx * (_doc.viewport.zoom - zoom);
    _doc.viewport.panY += cy * (_doc.viewport.zoom - zoom);
    
    _draw();
    _renderCompareMenus();
  }

  function _onDblClick(event) {
    const point = _screenToImage(_eventCanvasPoint(event));
    const hit = _hitTest(point);
    if (!hit) return;
    const layer = _doc.layers.find(item => item.id === hit.id);
    if (!layer || layer.locked) return;
    if (layer.type === 'text') {
      const text = prompt('Edit text:', layer.text || '');
      if (text !== null) {
        layer.text = text;
        _pushHistory('Edit text');
        _renderAll();
      }
    }
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
    const tool = TOOL_KEYS[event.key.toLowerCase()];
    if (tool) _setTool(tool);
  }

  function _onKeyUp(event) {
    if (event.key === ' ') _spaceDown = false;
    if (event.key === 'Escape') {
      _drawing = null;
      _closePalette();
      _draw();
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
      if (window.I18n && window.I18n.translateDOM) window.I18n.translateDOM();
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
    _bindProperty('prop-name', 'input', value => { layer.name = value; });
    _bindProperty('prop-color', 'input', value => { layer.style.stroke = value; layer.style.fill = value; });
    _bindProperty('prop-opacity', 'input', value => { layer.style.opacity = Number(value); });
    _bindProperty('prop-thickness', 'input', value => { layer.style.strokeWidth = Number(value); });
    _bindProperty('prop-text', 'input', value => { layer.text = value; });
    _bindProperty('prop-fontsize', 'input', value => { layer.style.fontSize = Number(value); });
    _bindProperty('prop-startcap', 'change', value => { layer.style.startCap = value; });
    _bindProperty('prop-endcap', 'change', value => { layer.style.endCap = value; });
    _bindScaleBarValueProperty(layer);
    _propsContainer.querySelectorAll('input[name="prop-scalebar-unit"]').forEach(input => {
      input.addEventListener('change', () => {
        layer.unit = input.value;
        layer.value = _snapScaleBarValue(layer.value || 100);
        layer.x2 = layer.x1 + _scaleBarPixels(layer);
        layer.y2 = layer.y1;
        _updateMeasurementText(layer);
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
    
    let channels = [];
    if (_doc.layoutMaps?.length > 0) {
      const map = _doc.layoutMaps[_activeStudioPanelIndex];
      channels = map?.channelState || [];
    } else {
      channels = Array.isArray(_doc.channelState) ? _doc.channelState : [];
    }

    if (!channels.length) {
      _channelsContainer.innerHTML = '<div class="studio-empty">No channel metadata.</div>';
      return;
    }
    
    let raw = _sliceResult?.raw;
    let w = _sliceResult?.width;
    let h = _sliceResult?.height;
    if (_doc.layoutMaps?.length > 0) {
       const map = _doc.layoutMaps[_activeStudioPanelIndex];
       if (map?.raw) {
          raw = map.raw;
          w = map.sourceWidth;
          h = map.sourceHeight;
       }
    }
    _studioHistograms = _computeStudioHistograms(raw, w, h);
    
    if (typeof createChannelPanel !== 'undefined') {
      if (!window._studioChannelPanel) {
        window._studioChannelPanel = createChannelPanel();
      }
      let _recomposeRaf = null;
      window._studioChannelPanel.init('studio-channels', { dimensions: { c: channels.length }, channels }, (idx, state) => {
        if (_doc.layoutMaps?.length > 0) {
            _doc.layoutMaps[_activeStudioPanelIndex].channelState[idx] = state;
        } else {
            _doc.channelState[idx] = state;
        }
        
        const panelToUpdate = (_doc.layoutMaps?.length > 0) ? _activeStudioPanelIndex : undefined;
        if (!_recomposeRaf) {
          _recomposeRaf = requestAnimationFrame(() => {
            _recomposeRaf = null;
            _rerenderSliceFromChannels(panelToUpdate);
          });
        }
      });
      window._studioChannelPanel.setState(channels, { notify: false });
      window._studioChannelPanel.setHistograms(_studioHistograms);
    } else {
      _channelsContainer.innerHTML = '<div class="studio-empty">ChannelPanel not loaded.</div>';
    }
  }

  function _computeStudioHistograms(raw, w, h) {
    if (typeof VolumeSlicer !== 'undefined' && raw) {
      return VolumeSlicer.computeChannelHistograms({raw, width: w, height: h}, 64) || [];
    }
    if (typeof VolumeViewer !== 'undefined' && VolumeViewer.getChannelHistograms) {
      return VolumeViewer.getChannelHistograms() || [];
    }
    return [];
  }

  function _rerenderSliceFromChannels(activePanelOnly) {
    if (!_sliceResult) return;

    // In compare mode (layoutMaps), each panel uses its own iframe's VolumeSlicer
    // so we don't need a global VolumeSlicer check here.
    // For single-slice mode, we do need global VolumeSlicer.

    function cropEmptySpace(canvas) {
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const data = imgData.data;
      let minX = canvas.width, minY = canvas.height, maxX = 0, maxY = 0;

      // Optimized scan: only check rows/columns at edges to find bounds faster
      const w = canvas.width, h = canvas.height;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          if (data[(y * w + x) * 4 + 3] > 5) {
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
        }
      }

      if (minX > maxX || minY > maxY) return canvas;

      const padding = 10;
      minX = Math.max(0, minX - padding);
      minY = Math.max(0, minY - padding);
      maxX = Math.min(w - 1, maxX + padding);
      maxY = Math.min(h - 1, maxY + padding);

      const croppedWidth = maxX - minX + 1;
      const croppedHeight = maxY - minY + 1;

      const croppedCanvas = document.createElement('canvas');
      croppedCanvas.width = croppedWidth;
      croppedCanvas.height = croppedHeight;
      const croppedCtx = croppedCanvas.getContext('2d');
      croppedCtx.drawImage(canvas, minX, minY, croppedWidth, croppedHeight, 0, 0, croppedWidth, croppedHeight);
      
      return croppedCanvas;
    }

    if (_doc.layoutMaps?.length > 0) {
      // Build base image: start from current _sliceImage
      const tempCanvas = document.createElement('canvas');
      tempCanvas.width = _sliceImage.width;
      tempCanvas.height = _sliceImage.height;
      const ctx = tempCanvas.getContext('2d');
      ctx.drawImage(_sliceImage, 0, 0);

      let changed = false;

      // Determine which panels to recompose
      const indicesToUpdate = (activePanelOnly !== undefined && activePanelOnly >= 0)
        ? [activePanelOnly]
        : _doc.layoutMaps.map((_, i) => i);

      indicesToUpdate.forEach(mapIdx => {
        const map = _doc.layoutMaps[mapIdx];
        if (!map) return;
        const targetSlicer = map.iframe?.contentWindow?.VolumeSlicer
          || (typeof VolumeSlicer !== 'undefined' ? VolumeSlicer : null);
        if (!targetSlicer?.recompose) return;
        let recomposedCanvas = null;

        if (map.raw) {
           const recomposed = targetSlicer.recompose(
             { raw: map.raw, width: map.sourceWidth, height: map.sourceHeight, source: 'gpu-slicer' }, 
             map.channelState, 
             STUDIO_SLICE_SUPPRESSION
           );
           if (recomposed?.canvas) {
             recomposedCanvas = recomposed.canvas;
           }
        } else if (map.sliceResult) {
           // Use a lower resolution for interactive speed (50% of original)
           const fullRes = map.sliceResult.renderRes || map.sliceResult.width || 1024;
           const interactiveRes = (activePanelOnly !== undefined) ? Math.round(fullRes * 0.5) : fullRes;
           const recomposed = targetSlicer.recompose(
             { ...map.sliceResult, width: interactiveRes },
             map.channelState, 
             STUDIO_SLICE_SUPPRESSION
           );
           if (recomposed?.canvas) {
             const gpuCanvas = recomposed.canvas;
             // Cache crop bounds on first render — geometry never changes,
             // only pixel colors change. Recomputing every frame is both
             // slow (full pixel scan) and buggy (bounds shift when background
             // goes transparent, causing stretching).
             if (!map._cropRect) {
               const cctx = gpuCanvas.getContext('2d', { willReadFrequently: true });
               const imgData = cctx.getImageData(0, 0, gpuCanvas.width, gpuCanvas.height);
               const d = imgData.data;
               const gw = gpuCanvas.width, gh = gpuCanvas.height;
               let x0 = gw, y0 = gh, x1 = 0, y1 = 0;
               for (let y = 0; y < gh; y++) {
                 for (let x = 0; x < gw; x++) {
                   if (d[(y * gw + x) * 4 + 3] > 5) {
                     if (x < x0) x0 = x;
                     if (x > x1) x1 = x;
                     if (y < y0) y0 = y;
                     if (y > y1) y1 = y;
                   }
                 }
               }
               if (x0 <= x1 && y0 <= y1) {
                 const pad = 4;
                 // Store as normalized ratios so they work at any render resolution
                 map._cropRect = {
                   x: Math.max(0, x0 - pad) / gw,
                   y: Math.max(0, y0 - pad) / gh,
                   x2: Math.min(gw - 1, x1 + pad) / gw,
                   y2: Math.min(gh - 1, y1 + pad) / gh
                 };
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
           ctx.clearRect(map.x, map.y, map.w, map.h);
           ctx.drawImage(recomposedCanvas, map.x, map.y, map.w, map.h);
           changed = true;
        }
      });
      
      if (changed) {
        _sliceImage = tempCanvas;
        _draw();
      }
      return;
    }

    // Single-slice mode: need global VolumeSlicer
    if (typeof VolumeSlicer === 'undefined') return;
    const recomposed = VolumeSlicer.recompose?.({ ..._sliceResult, width: _sliceResult.renderRes || _sliceResult.width }, _doc.channelState, STUDIO_SLICE_SUPPRESSION);
    if (!recomposed?.canvas) return;
    const croppedRecomposed = cropEmptySpace(recomposed.canvas);
    
    _sliceResult = { ...recomposed, canvas: croppedRecomposed, width: croppedRecomposed.width, height: croppedRecomposed.height, renderRes: _sliceResult.renderRes || _sliceResult.width };
    _sliceImage = croppedRecomposed;
    _doc.sourceSlice.width = croppedRecomposed.width;
    _doc.sourceSlice.height = croppedRecomposed.height;
    _doc.calibration.pixelSizeUm = recomposed.pixelSizeUm || _doc.calibration.pixelSizeUm;
    
    _draw();
  }

  function _prepareSliceForStudio(sliceResult) {
    if (!sliceResult?.canvas || typeof VolumeSlicer === 'undefined' || typeof VolumeSlicer.recompose !== 'function') {
      return sliceResult;
    }
    try {
      const channels = Array.isArray(sliceResult.channelState) && sliceResult.channelState.length
        ? sliceResult.channelState
        : (Array.isArray(_doc?.channelState) && _doc.channelState.length
          ? _doc.channelState
          : (typeof ViewerApp !== 'undefined' && ViewerApp.getChannelState ? ViewerApp.getChannelState() : []));
      return VolumeSlicer.recompose(sliceResult, channels, STUDIO_SLICE_SUPPRESSION) || sliceResult;
    } catch (err) {
      console.warn('[StudioEditor] Failed to prepare slice:', err);
      return sliceResult;
    }
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
    if (!_doc || !_sliceResult?.defaultScaleBar) return;
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
    layer.x2 = layer.x1 + _scaleBarPixels(layer);
    layer.y2 = layer.y1;
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
      layer.unit = 'um';
      layer.value = _snapScaleBarValue(100);
      layer.x2 = layer.x1 + _scaleBarPixels(layer);
      layer.y2 = layer.y1;
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
    const box = _layerBounds(layer);
    if (['rectangle', 'ellipse', 'text'].includes(layer.type)) {
      return point.x >= box.x && point.x <= box.x + box.w && point.y >= box.y && point.y <= box.y + box.h;
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
    const box = _layerBounds(layer);
    return [
      { id: 'nw', x: box.x, y: box.y },
      { id: 'ne', x: box.x + box.w, y: box.y },
      { id: 'sw', x: box.x, y: box.y + box.h },
      { id: 'se', x: box.x + box.w, y: box.y + box.h }
    ];
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
    const box = _layerBounds(original);
    const left = handle.includes('w') ? point.x : box.x;
    const right = handle.includes('e') ? point.x : box.x + box.w;
    const top = handle.includes('n') ? point.y : box.y;
    const bottom = handle.includes('s') ? point.y : box.y + box.h;
    layer.x = Math.min(left, right);
    layer.y = Math.min(top, bottom);
    layer.w = Math.abs(right - left);
    layer.h = Math.abs(bottom - top);
  }

  function _applyScaleBarHandle(layer, handle, point, original) {
    const base = original || _clone(layer);
    const basePoints = _linePoints(base);
    const minPixels = Math.max(1, _scaleBarPixelsForValue(layer, layer.unit || 'um', SCALEBAR_STEP));

    if (handle === 'p1') {
      const right = basePoints.x2;
      layer.x1 = Math.min(point.x, right - minPixels);
      layer.y1 = base.y1;
      layer.value = _scaleBarValueFromPixels(layer, right - layer.x1);
    } else {
      layer.x1 = base.x1;
      layer.y1 = base.y1;
      layer.value = _scaleBarValueFromPixels(layer, point.x - base.x1);
    }

    const snappedLength = _scaleBarPixels(layer);
    layer.value = _snapScaleBarValue(layer.value);
    layer.x2 = layer.x1 + snappedLength;
    layer.y2 = layer.y1;
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

  function _applySnapping(layer) {
    const threshold = 7 / Math.max(0.001, _doc.viewport.zoom);
    const box = _layerBounds(layer);
    const centers = [
      { axis: 'x', value: _doc.sourceSlice.width / 2 },
      { axis: 'y', value: _doc.sourceSlice.height / 2 },
      ..._doc.guides
    ];
    centers.forEach(guide => {
      const current = guide.axis === 'x' ? box.x + box.w / 2 : box.y + box.h / 2;
      if (Math.abs(current - guide.value) <= threshold) {
        const delta = guide.value - current;
        _moveLayerTo(layer, _clone(layer), guide.axis === 'x' ? delta : 0, guide.axis === 'y' ? delta : 0);
      }
    });
  }

  function _linePoints(layer) {
    if (layer.type !== 'scalebar') return { x1: layer.x1, y1: layer.y1, x2: layer.x2, y2: layer.y2 };
    const length = _scaleBarPixels(layer);
    return { x1: layer.x1, y1: layer.y1, x2: layer.x1 + length, y2: layer.y1 };
  }

  function _scaleBarPixels(layer) {
    const px = _pixelSizeForPoint(layer.x1, layer.y1);
    const um = layer.value || 100;
    return _scaleBarPixelsForValue(layer, layer.unit || 'um', um);
  }

  function _scaleBarPixelsForValue(layer, unit, value) {
    const px = layer ? _pixelSizeForPoint(layer.x1, layer.y1).x : (_doc?.calibration?.pixelSizeUm?.x || 1);
    if (unit === 'px') return value;
    if (unit === 'mm') return (value * 1000) / px;
    if (unit === 'cm') return (value * 10000) / px;
    return value / px;
  }

  function _scaleBarValueFromPixels(layer, pixelLength) {
    const px = layer ? _pixelSizeForPoint(layer.x1, layer.y1).x : (_doc?.calibration?.pixelSizeUm?.x || 1);
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
    if (layer.type === 'distance') return `${_lineLengthUm(layer).toFixed(2)} um`;
    if (layer.type === 'angle') return `${_angleDegrees(layer).toFixed(1)} deg`;
    if (layer.type === 'scalebar') return `${_snapScaleBarValue(layer.value || 100)} ${layer.unit || 'um'}`;
    return layer.text || '';
  }

  function _updateMeasurementText(layer) {
    if (['distance', 'angle', 'scalebar'].includes(layer.type)) layer.text = _measurementLabel(layer);
  }

  function _pixelSizeForPoint(x, y) {
    if (_doc?.layoutMaps?.length) {
      const map = _doc.layoutMaps.find(m => x >= m.x && x <= m.x + m.w && y >= m.y && y <= m.y + m.h);
      if (map && map.pixelSizeUm) return map.pixelSizeUm;
    }
    return _doc?.calibration?.pixelSizeUm || { x: 1, y: 1 };
  }

  function _lineLengthUm(layer) {
    const p = _linePoints(layer);
    const px = _pixelSizeForPoint(p.x1, p.y1);
    return Math.hypot((p.x2 - p.x1) * px.x, (p.y2 - p.y1) * px.y);
  }

  function _angleDegrees(layer) {
    const px = _pixelSizeForPoint(layer.x1, layer.y1);
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

  function _layerBounds(layer) {
    if (['rectangle', 'ellipse', 'text'].includes(layer.type)) {
      return {
        x: Math.min(layer.x, layer.x + (layer.w || 0)),
        y: Math.min(layer.y, layer.y + (layer.h || 0)),
        w: Math.abs(layer.w || 1),
        h: Math.abs(layer.h || 1)
      };
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
    _future.push(_history.pop());
    _doc = _clone(_history[_history.length - 1].doc);
    _selectedId = null;
    _renderAll();
  }

  function _redo() {
    if (!_future.length) return;
    const item = _future.pop();
    _history.push(_clone(item));
    _doc = _clone(item.doc);
    _selectedId = null;
    _renderAll();
  }

  function _commitPropertyChange() {
    _pushHistory('Edit properties');
    _renderAll();
  }

  function _bindProperty(id, eventName, setter) {
    const node = document.getElementById(id);
    if (!node) return;
    node.addEventListener(eventName, event => {
      setter(event.target.value);
      _draw();
      _renderLayers();
    });
    node.addEventListener('change', _commitPropertyChange);
  }

  function _bindScaleBarValueProperty(layer) {
    const node = document.getElementById('prop-scalebar-value');
    if (!node) return;
    const applyValue = (commit) => {
      layer.value = _snapScaleBarValue(node.value);
      node.value = layer.value;
      layer.x2 = layer.x1 + _scaleBarPixels(layer);
      layer.y2 = layer.y1;
      _updateMeasurementText(layer);
      _draw();
      _renderLayers();
      if (commit) _commitPropertyChange();
    };
    node.addEventListener('input', () => applyValue(false));
    node.addEventListener('change', () => applyValue(true));
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

  async function _exportPng() {
    if (!_doc || !_sliceResult) return;
    _toast(_t('toast.renderingNative', 'Rendering native export...'));
    let source = _sliceResult;

    // ── Compare mode (layoutMaps): recompose all panels at full resolution ──
    if (_doc.layoutMaps?.length > 0) {
      // Force full-res recompose of ALL panels (not interactive = no downscale)
      _rerenderSliceFromChannels(undefined);
      // Use the current _sliceImage which now has all channel modifications applied
      source = {
        canvas: _sliceImage,
        width: _sliceImage.width,
        height: _sliceImage.height
      };
    } else {
      // ── Single-slice mode: try native export, fallback to recomposed ──
      const dataset = typeof ViewerApp !== 'undefined' && ViewerApp.getDatasetMeta ? ViewerApp.getDatasetMeta() : null;
      if (dataset && typeof VolumeSlicer !== 'undefined') {
        try {
          const maxSource = Math.max(
            Number(dataset.dimensions?.x) || _sliceResult.width,
            Number(dataset.dimensions?.y) || _sliceResult.height,
            _sliceResult.width,
            _sliceResult.height
          );
          source = await VolumeSlicer.renderNative(dataset, _doc.planeSpec, _doc.channelState, {
            timepoint: _doc.timepoint,
            physicalSizeUm: _sliceResult.physicalSizeUm,
            baseUrl: window.location.origin,
            outputSize: maxSource,
            preferredSourceKind: 'webstack'
          });
        } catch (err) {
          console.warn('[StudioEditor] Native export fallback:', err);
        }
      }
      // If channel modifications were made, use the recomposed _sliceImage
      if (_sliceImage && _sliceImage !== _sliceResult.canvas) {
        source = { ...source, canvas: _sliceImage, width: _sliceImage.width, height: _sliceImage.height };
      }
    }

    const canvas = _composeExportCanvas(source, { metadataStamp: true });
    canvas.toBlob(blob => {
      if (!blob) return;
      const name = `${_safeName(_doc.dataset?.name || 'slice')}_studio.png`;
      ExportManager?.downloadBlob?.(blob, name);
    }, 'image/png', 1);
  }

  function _composeExportCanvas(source, options = {}) {
    const canvas = document.createElement('canvas');
    canvas.width = source.width || source.canvas.width;
    canvas.height = source.height || source.canvas.height;
    const ctx = canvas.getContext('2d');
    const background = options.background || '#000000';
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
    const bits = [
      _doc.dataset?.name || 'Slice Studio',
      `${(_doc.planeSpec?.mode || 'xy').toUpperCase()} ${_doc.planeSpec?.projection || 'single'}`,
      `${source.width}x${source.height}`,
      `px ${(_doc.calibration.pixelSizeUm.x || 1).toFixed(4)} um`
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

  function _exportJson() {
    if (!_doc) return;
    const blob = new Blob([JSON.stringify(_doc, null, 2)], { type: 'application/json' });
    ExportManager?.downloadBlob?.(blob, `${_safeName(_doc.dataset?.name || 'slice')}_studio.json`);
  }

  function _importJson(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const loaded = JSON.parse(reader.result);
        _doc = _migrateDocument(loaded);
        _selectedId = null;
        _history = [];
        _future = [];
        _pushHistory('Import JSON');
        _renderAll();
      } catch (err) {
        console.warn('[StudioEditor] Invalid JSON:', err);
        _toast(_t('toast.invalidStudioJson', 'Invalid Studio JSON.'));
      } finally {
        event.target.value = '';
      }
    };
    reader.readAsText(file);
  }

  function _migrateDocument(value) {
    if (value?.version === DOC_VERSION && Array.isArray(value.layers)) return value;
    if (Array.isArray(value)) {
      const doc = _createDocument(_sliceResult);
      doc.layers = value.map(old => _migrateLayer(old)).filter(Boolean);
      return doc;
    }
    if (Array.isArray(value?.layers)) {
      return { ..._createDocument(_sliceResult), ...value, version: DOC_VERSION };
    }
    throw new Error('Unsupported Studio JSON format.');
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

  function _clone(value) {
    if (!value) return value;
    if (value.version && value.createdAt && value.layoutMaps) {
      const cloneMaps = value.layoutMaps;
      const tempDoc = { ...value, layoutMaps: undefined };
      const clonedDoc = JSON.parse(JSON.stringify(tempDoc));
      clonedDoc.layoutMaps = cloneMaps.map(m => ({
        ...JSON.parse(JSON.stringify({ ...m, iframe: undefined, raw: undefined, sliceResult: undefined })),
        iframe: m.iframe,
        raw: m.raw,
        sliceResult: m.sliceResult
      }));
      return clonedDoc;
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
    const v = (window.I18n && I18n.t) ? I18n.t(k, params) : k;
    return v === k ? def : v;
  };

  function _toast(text) {
    ExportManager?.toast?.(text);
  }

  return {
    init,
    open,
    setSliceResult,
    close,
    getDocument
  };
})();

document.addEventListener('DOMContentLoaded', () => { StudioEditor.init(); });
