/* ============================================================
   IRIBHM Microscopy Platform — Comparison Page Controller
   ============================================================ */

const CompareApp = (() => {
  let _datasets = [];
  let _activePanels = []; // Array of dataset IDs
  const MAX_PANELS = 4;
  let _panelIdCounter = 0;
  let _layoutMode = 'auto';
  const MAX_PARALLEL_PANEL_LOADS = 2;
  const MAX_PARALLEL_HIGH_DETAIL = 1;
  let _panelLoadQueue = [];
  let _activePanelLoads = 0;
  let _highDetailQueue = [];
  let _activeHighDetailLoads = 0;
  let _panelQualityState = new Map();
  let _layoutWeights = {
    columns: [1, 1, 1, 1],
    rows: [1, 1, 1, 1],
    gridColumns: [1, 1],
    gridRows: [1, 1]
  };
  let _resizeNotifyTimer = null;
  
  let _syncOptions = { z: true, time: true, camera: true, channels: true };
  // Track z-stack active state per panelIndex (for compare-level save/restore)
  const _panelZstackActive = new Map();
  // Track decompose-by-channel solo assignment per panelIndex (null = not decomposed)
  const _panelSoloChannel = new Map();

  async function init() {
    Theme.init();
    await InstanceConfig.load();
    await I18n.init();
    InstanceConfig.applyHead();
    InstanceConfig.applyDom();
    await Catalog.load();

    _datasets = Catalog.getAll();
    _updateThemeIcon();
    Theme.onChange(_updateThemeIcon);

    _bindToolbar();
    _bindModal();
    _updateLayout();
    _bindExport();

    const params = new URLSearchParams(window.location.search);
    const adds = params.getAll('add');
    if (adds.length) adds.forEach(id => _addPanel(id));

    if (window.lucide) lucide.createIcons();
    if (typeof StudioEditor !== 'undefined') StudioEditor.init();

    if (window.location.hash && window.location.hash.startsWith('#state=')) {
      if (typeof UrlState !== 'undefined') {
        const urlState = await UrlState.decodeState(window.location.hash);
        if (urlState) {
          _applyWorkspaceState(urlState.state || urlState);
        }
      }
    }

    if (typeof UrlState !== 'undefined') {
      UrlState.startSync(_getWorkspaceState, 1000);
    }

    // Listen for messages from iframes for synchronization
    window.addEventListener('message', _handleIframeMessage);
  }

  function _bindToolbar() {
    // Sync options
    ['z', 'time', 'camera', 'channels'].forEach(key => {
      const cb = document.getElementById(`sync-${key}`);
      if (cb) {
        cb.addEventListener('change', (e) => {
          _syncOptions[key] = e.target.checked;
        });
      }
    });

    document.querySelectorAll('.tool-chip').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const tool = e.currentTarget.dataset.tool;
        if (!tool) return;
        document.querySelectorAll('.tool-chip').forEach(b => b.classList.remove('active'));
        e.currentTarget.classList.add('active');
        _broadcast({ type: 'SET_TOOL', tool }, null);
      });
    });

    document.getElementById('studio-scale-mode')?.addEventListener('change', () => {
      const layout = document.getElementById('studio-layout');
      if (layout && !layout.classList.contains('hidden')) {
        _openCompareStudio();
      }
    });

    document.getElementById('btn-decompose')?.addEventListener('click', _decomposeChannels);

    document.getElementById('btn-add-dataset').addEventListener('click', _openModal);
    document.getElementById('compare-layout-mode')?.addEventListener('change', (e) => {
      _layoutMode = e.target.value;
      _updateLayout();
    });
  }

  function _bindExport() {
    if (typeof ExportManager === 'undefined') return;
    ExportManager.init({
      scope: 'compare',
      getWorkspaceState: _getWorkspaceState,
      applyWorkspaceState: _applyWorkspaceState,
      getCustomExports: _getCompareExports
    });
    document.getElementById('btn-export-compare')?.addEventListener('click', () => {
      ExportManager.openDownloadCenter({
        scope: 'compare',
        getWorkspaceState: _getWorkspaceState,
        applyWorkspaceState: _applyWorkspaceState,
        getCustomExports: _getCompareExports
      });
    });
    document.getElementById('btn-save-compare-workspace')?.addEventListener('click', () => ExportManager.saveWorkspace('compare'));
    document.getElementById('btn-restore-compare-workspace')?.addEventListener('click', () => ExportManager.restoreWorkspace('compare'));
  }

  function _updateThemeIcon() {
    const btn = document.getElementById('theme-toggle');
    if (!btn) return;
    const icon = Theme.isDark() ? 'moon' : 'sun';
    btn.innerHTML = `<i data-lucide="${icon}" data-theme-icon></i>`;
    if (window.lucide) lucide.createIcons({ nodes: [btn] });
  }

  // --- Modal Logic ---

  function _bindModal() {
    document.getElementById('btn-close-modal').addEventListener('click', _closeModal);
    document.getElementById('modal-select').addEventListener('click', (e) => {
      if (e.target.id === 'modal-select') _closeModal();
    });

    const list = document.getElementById('modal-dataset-list');
    list.innerHTML = _datasets.map(d => {
      const color = d.type === 'fixed' ? '#00D2FF' : (d.type === 'live' ? '#FFA726' : '#00A654');
      // SEC-014: dataset fields (id/thumbnail/name/type) are catalog data — escape
      // before innerHTML interpolation (cf. _addPanel which already uses escapeHtml).
      return `
        <div class="dataset-mini-card" data-id="${Utils.escapeHtml(d.id)}">
          ${d.thumbnail ? `<img src="${Utils.escapeHtml(d.thumbnail)}" alt="" style="width:100%;aspect-ratio:16/9;object-fit:cover;border-radius:var(--radius-sm);margin-bottom:8px;">` : ''}
          <span class="card-type" style="background: ${color}22; color: ${color}; border: 1px solid ${color}55">${Utils.escapeHtml(String(d.type).toUpperCase())}</span>
          <div class="font-bold text-sm mt-1">${Utils.escapeHtml(d.name)}</div>
          <div class="text-xs text-muted mt-1">${Utils.formatStage(d.stage)}</div>
        </div>
      `;
    }).join('');

    list.querySelectorAll('.dataset-mini-card').forEach(card => {
      card.addEventListener('click', () => {
        _addPanel(card.dataset.id);
        _closeModal();
      });
    });
  }

  function _openModal() {
    if (_activePanels.length >= MAX_PANELS) {
      _toast(_t('toast.maxPanels', `Maximum of ${MAX_PANELS} panels reached.`, { count: MAX_PANELS }));
      return;
    }
    document.getElementById('modal-select').classList.add('active');
  }

  function _closeModal() {
    document.getElementById('modal-select').classList.remove('active');
  }

  // --- Panel Management ---

  function _addPanel(datasetId) {
    if (_activePanels.length >= MAX_PANELS) return;
    
    const panelIndex = _panelIdCounter++;
    _activePanels.push({ index: panelIndex, id: datasetId });
    
    const d = Catalog.getById(datasetId);
    if (!d) {
      _activePanels = _activePanels.filter(p => p.index !== panelIndex);
      return;
    }
    const grid = document.getElementById('compare-grid');
    
    const panel = document.createElement('div');
    panel.className = 'compare-panel animate-scale-in';
    panel.id = `panel-${panelIndex}`;
    panel.dataset.datasetType = d.type;
    
    const page = d.type === 'tracking' ? 'tracking.html' : 'viewer.html';
    const activePanelsCount = Math.max(1, _activePanels.length);
    const src = `${page}?v=20260604-v7&id=${encodeURIComponent(datasetId)}&hideHeader=true&panelIndex=${panelIndex}&quality=auto&deferHighQuality=1&panelPriority=${Math.max(0, _activePanels.length - 1)}&activePanels=${activePanelsCount}`;
    
    panel.innerHTML = `
      <div class="panel-header">
          <div class="panel-title-badge">${Utils.escapeHtml(d.name)}</div>
        <div class="panel-actions">
          <button class="btn btn-outline btn-sm bg-surface p-1 btn-settings" data-index="${panelIndex}" title="Toggle Settings" data-i18n-title="js.toggleSettings">
            <i data-lucide="settings" class="w-4 h-4"></i>
          </button>
          <button class="btn btn-outline btn-sm bg-surface p-1 btn-close-panel" data-index="${panelIndex}" title="Close" data-i18n-title="js.closePanel">
            <i data-lucide="x" class="w-4 h-4"></i>
          </button>
        </div>
      </div>
      <div class="panel-visual-tools" data-index="${panelIndex}">
        <button class="btn btn-ghost btn-xs panel-tool-btn btn-toggle-zstack" data-index="${panelIndex}" title="Toggle Z-Stack Browser">
          <i data-lucide="layers" class="w-3.5 h-3.5"></i>
        </button>
        <button class="btn btn-ghost btn-xs panel-tool-btn btn-toggle-grid" data-index="${panelIndex}" title="Toggle Grid">
          <i data-lucide="grid-3x3" class="w-3.5 h-3.5"></i>
        </button>
        <button class="btn btn-ghost btn-xs panel-tool-btn btn-toggle-axes" data-index="${panelIndex}" title="Toggle Axes">
          <i data-lucide="axis-3d" class="w-3.5 h-3.5"></i>
        </button>
      </div>
      <div class="panel-content">
        <iframe src="about:blank" data-src="${src}" class="viewer-frame" id="iframe-${panelIndex}" data-index="${panelIndex}"></iframe>
      </div>
    `;
    
    grid.appendChild(panel);
    if (window.lucide) lucide.createIcons({nodes: [panel]});
    
    // Bind buttons
    panel.querySelector('.btn-close-panel').addEventListener('click', () => _removePanel(panelIndex));
    panel.querySelector('.btn-settings').addEventListener('click', () => _toggleSidebar(panelIndex));

    // Z-Stack toggle
    const zstackBtn = panel.querySelector('.btn-toggle-zstack');
    zstackBtn.addEventListener('click', () => {
      const current = _panelZstackActive.get(panelIndex) || false;
      const next = !current;
      _panelZstackActive.set(panelIndex, next);
      zstackBtn.classList.toggle('btn-solid', next);
      zstackBtn.classList.toggle('btn-ghost', !next);
      const iframe = document.getElementById(`iframe-${panelIndex}`);
      if (iframe?.contentWindow) {
        iframe.contentWindow.postMessage({ type: 'TOGGLE_ZSTACK', state: next }, '*');
      }
    });

    // Auto-hide Z-Stack UI on hover out to save space
    panel.addEventListener('mouseenter', () => {
      if (_panelZstackActive.get(panelIndex)) {
        const iframe = document.getElementById(`iframe-${panelIndex}`);
        if (iframe?.contentWindow) {
          iframe.contentWindow.postMessage({ type: 'ZSTACK_HOVER_STATE', state: true }, '*');
        }
      }
    });
    panel.addEventListener('mouseleave', () => {
      if (_panelZstackActive.get(panelIndex)) {
        const iframe = document.getElementById(`iframe-${panelIndex}`);
        if (iframe?.contentWindow) {
          iframe.contentWindow.postMessage({ type: 'ZSTACK_HOVER_STATE', state: false }, '*');
        }
      }
    });

    // Grid toggle (cycles: off → grid → fine grid → off)
    const gridBtn = panel.querySelector('.btn-toggle-grid');
    let gridMode = 0;
    gridBtn.addEventListener('click', () => {
      gridMode = (gridMode + 1) % 3;
      gridBtn.classList.toggle('btn-solid', gridMode > 0);
      gridBtn.classList.toggle('btn-ghost', gridMode === 0);
      const iframe = document.getElementById(`iframe-${panelIndex}`);
      if (iframe?.contentWindow?.VolumeViewer) {
        iframe.contentWindow.VolumeViewer.setGridMode(gridMode);
      }
    });

    // Axes toggle
    const axesBtn = panel.querySelector('.btn-toggle-axes');
    let axesVisible = false;
    axesBtn.addEventListener('click', () => {
      axesVisible = !axesVisible;
      axesBtn.classList.toggle('btn-solid', axesVisible);
      axesBtn.classList.toggle('btn-ghost', !axesVisible);
      const iframe = document.getElementById(`iframe-${panelIndex}`);
      if (iframe?.contentWindow?.VolumeViewer) {
        iframe.contentWindow.VolumeViewer.setAxesVisible(axesVisible);
      }
    });

    _updateLayout();
    _queuePanelLoad(panelIndex);
  }

  function _removePanel(panelIndex) {
    _activePanels = _activePanels.filter(p => p.index !== panelIndex);
    _panelLoadQueue = _panelLoadQueue.filter(index => index !== panelIndex);
    _highDetailQueue = _highDetailQueue.filter(index => index !== panelIndex);
    _panelQualityState.delete(panelIndex);
    _panelZstackActive.delete(panelIndex);
    _panelSoloChannel.delete(panelIndex);
    const panel = document.getElementById(`panel-${panelIndex}`);
    if (panel) panel.remove();
    _updateLayout();
  }

  function _queuePanelLoad(panelIndex) {
    if (_panelLoadQueue.includes(panelIndex)) return;
    _panelLoadQueue.push(panelIndex);
    _drainPanelLoadQueue();
  }

  function _drainPanelLoadQueue() {
    while (_activePanelLoads < MAX_PARALLEL_PANEL_LOADS && _panelLoadQueue.length) {
      const panelIndex = _panelLoadQueue.shift();
      const panel = document.getElementById(`panel-${panelIndex}`);
      const iframe = document.getElementById(`iframe-${panelIndex}`);
      if (!panel || !iframe || !iframe.dataset.src) continue;

      _activePanelLoads++;
    _loadPanelFrame(panelIndex)
        .catch(err => console.warn('[Compare] Panel load did not finish cleanly:', err))
        .finally(() => {
          _activePanelLoads = Math.max(0, _activePanelLoads - 1);
          _drainPanelLoadQueue();
        });
    }
  }

  async function _loadPanelFrame(panelIndex) {
    const iframe = document.getElementById(`iframe-${panelIndex}`);
    if (!iframe?.dataset.src) return;
    _panelQualityState.set(panelIndex, { previewReady: false, highReady: false });
    iframe.src = iframe.dataset.src;
    delete iframe.dataset.src;
    const ready = await _waitForPanelReady(panelIndex, 180000);
    if (ready) {
      const panel = document.getElementById(`panel-${panelIndex}`);
      if (panel?.dataset.datasetType !== 'tracking') {
        _queueHighDetailLoad(panelIndex);
      }
    }
    _notifyFramesResize();
  }

  function _queueHighDetailLoad(panelIndex) {
    if (_highDetailQueue.includes(panelIndex)) return;
    const state = _panelQualityState.get(panelIndex) || {};
    if (state.highReady) return;
    _highDetailQueue.push(panelIndex);
    _drainHighDetailQueue();
  }

  function _drainHighDetailQueue() {
    while (_activeHighDetailLoads < MAX_PARALLEL_HIGH_DETAIL && _highDetailQueue.length) {
      const panelIndex = _highDetailQueue.shift();
      const iframe = document.getElementById(`iframe-${panelIndex}`);
      if (!iframe?.contentWindow) continue;
      _activeHighDetailLoads++;
      iframe.contentWindow.postMessage({ type: 'START_HIGH_DETAIL', sourceIndex: 'parent' }, '*');
      
      // Fallback timeout: if the iframe hangs and never sends high-ready or high-error
      const capturedPanelIndex = panelIndex;
      setTimeout(() => {
        const state = _panelQualityState.get(capturedPanelIndex) || {};
        if (!state.highReady) {
          console.warn(`[Compare] Panel ${capturedPanelIndex} high detail load timed out. Unblocking queue.`);
          _activeHighDetailLoads = Math.max(0, _activeHighDetailLoads - 1);
          _drainHighDetailQueue();
        }
      }, 60000);
    }
  }

  function _waitForPanelReady(panelIndex, timeoutMs) {
    const started = Date.now();
    return new Promise(resolve => {
      const tick = () => {
        const panel = document.getElementById(`panel-${panelIndex}`);
        const iframe = document.getElementById(`iframe-${panelIndex}`);
        if (!panel || !iframe) {
          resolve(true);
          return;
        }

        let ready = false;
        try {
          const doc = iframe.contentDocument;
          const loader = doc?.getElementById('viewer-loader');
          const visual = _frameVisualState(iframe);
          ready = Boolean(
            doc
            && doc.readyState === 'complete'
            && (!loader || getComputedStyle(loader).display === 'none')
            && (!visual.renderable || visual.nonzero > 16)
          );
        } catch (err) {
          ready = false;
        }

        if (ready) {
          resolve(true);
          return;
        }
        if (Date.now() - started > timeoutMs) {
          resolve(false);
          return;
        }
        setTimeout(tick, 350);
      };
      tick();
    });
  }

  function _frameVisualState(iframe) {
    if (!iframe?.contentDocument) return { renderable: false, nonzero: 0 };
    const source = iframe.contentDocument.querySelector('#webgl-canvas')
      || iframe.contentDocument.querySelector('#tracking-canvas canvas')
      || iframe.contentDocument.querySelector('canvas');
    if (!source || !source.width || !source.height) return { renderable: false, nonzero: 0 };
    return {
      renderable: true,
      nonzero: _sampleCanvasNonzero(source)
    };
  }

  function _sampleCanvasNonzero(source) {
    try {
      const probe = document.createElement('canvas');
      probe.width = 48;
      probe.height = 48;
      const ctx = probe.getContext('2d', { willReadFrequently: true });
      if (!ctx) return 0;
      ctx.clearRect(0, 0, probe.width, probe.height);
      ctx.drawImage(source, 0, 0, probe.width, probe.height);
      const data = ctx.getImageData(0, 0, probe.width, probe.height).data;
      let nonzero = 0;
      for (let i = 0; i < data.length; i += 4) {
        const rgb = data[i] + data[i + 1] + data[i + 2];
        if (rgb > 12 || data[i + 3] > 12) nonzero++;
      }
      return nonzero;
    } catch (err) {
      return 0;
    }
  }

  function _toggleSidebar(panelIndex) {
    // Send TOGGLE_SIDEBAR: true to target panel, false to all others
    document.querySelectorAll('.viewer-frame').forEach(iframe => {
      const idx = iframe.dataset.index;
      const isTarget = (idx === panelIndex.toString());
      
      // We don't know the current state easily from the parent without round-trip, 
      // so if they click the button, we assume they want to open it (or we can just send a generic toggle)
      // Actually, let's track state in parent.
      
      if (!iframe.contentWindow) return;
      
      if (isTarget) {
        const btn = document.querySelector(`.btn-settings[data-index="${idx}"]`);
        const isActive = btn.classList.contains('bg-primary');
        const nextState = !isActive;
        
        if (nextState) btn.classList.add('bg-primary', 'text-white');
        else btn.classList.remove('bg-primary', 'text-white');
        
        iframe.contentWindow.postMessage({ type: 'TOGGLE_SIDEBAR', value: nextState, sourceIndex: 'parent' }, '*');
      } else {
        const btn = document.querySelector(`.btn-settings[data-index="${idx}"]`);
        if (btn) btn.classList.remove('bg-primary', 'text-white');
        iframe.contentWindow.postMessage({ type: 'TOGGLE_SIDEBAR', value: false, sourceIndex: 'parent' }, '*');
      }
    });
  }

  function _updateLayout() {
    const grid = document.getElementById('compare-grid');
    const emptyState = document.getElementById('empty-state');
    const count = _activePanels.length;
    
    const btnDecompose = document.getElementById('btn-decompose');
    if (btnDecompose) {
      if (count === 1) btnDecompose.style.display = '';
      else btnDecompose.style.display = 'none';
    }
    
    // Update layout classes
    grid.className = `compare-grid layout-${count}`;
    grid.classList.toggle('layout-custom', _layoutMode !== 'auto');
    _applyGridTemplates();
    
    if (count === 0) {
      emptyState.style.display = 'flex';
      document.getElementById('btn-add-dataset').disabled = false;
    } else {
      emptyState.style.display = 'none';
      document.getElementById('btn-add-dataset').disabled = (count >= MAX_PANELS);
    }

    _renderSplitHandles();
    _notifyFramesResize();
  }

  function _getLayoutAxes() {
    const count = _activePanels.length;
    if (count <= 1 || _layoutMode === 'auto') return null;
    if (_layoutMode === 'columns') return { columns: count, rows: 1, columnKey: 'columns', rowKey: null };
    if (_layoutMode === 'rows') return { columns: 1, rows: count, columnKey: null, rowKey: 'rows' };
    const columns = Math.ceil(Math.sqrt(count));
    const rows = Math.ceil(count / columns);
    return { columns, rows, columnKey: 'gridColumns', rowKey: 'gridRows' };
  }

  function _applyGridTemplates() {
    const grid = document.getElementById('compare-grid');
    const count = _activePanels.length;
    grid.style.gridTemplateColumns = '';
    grid.style.gridTemplateRows = '';

    const axes = _getLayoutAxes();
    if (!axes) return;

    if (axes.columns > 1 && axes.columnKey) {
      grid.style.gridTemplateColumns = _weightsTemplate(axes.columnKey, axes.columns);
    } else {
      grid.style.gridTemplateColumns = 'minmax(0, 1fr)';
    }

    if (axes.rows > 1 && axes.rowKey) {
      grid.style.gridTemplateRows = _weightsTemplate(axes.rowKey, axes.rows);
    } else {
      grid.style.gridTemplateRows = 'minmax(0, 1fr)';
    }

    if (count > 1 && _layoutMode === 'grid') {
      grid.classList.add('layout-custom');
    }
  }

  function _weightsTemplate(key, count) {
    return _getWeights(key, count).map(value => `minmax(0, ${value}fr)`).join(' ');
  }

  function _getWeights(key, count) {
    if (!_layoutWeights[key]) _layoutWeights[key] = [];
    while (_layoutWeights[key].length < count) _layoutWeights[key].push(1);
    _layoutWeights[key] = _layoutWeights[key]
      .slice(0, Math.max(count, _layoutWeights[key].length))
      .map(value => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : 1);
    return _layoutWeights[key].slice(0, count);
  }

  function _renderSplitHandles() {
    const grid = document.getElementById('compare-grid');
    grid.querySelectorAll('.compare-split-handle').forEach(handle => handle.remove());

    const axes = _getLayoutAxes();
    if (!axes) return;

    if (axes.columns > 1 && axes.columnKey) {
      for (let i = 0; i < axes.columns - 1; i++) {
        const handle = _createSplitHandle('vertical', axes.columnKey, i);
        grid.appendChild(handle);
      }
    }

    if (axes.rows > 1 && axes.rowKey) {
      for (let i = 0; i < axes.rows - 1; i++) {
        const handle = _createSplitHandle('horizontal', axes.rowKey, i);
        grid.appendChild(handle);
      }
    }

    _positionSplitHandles();
  }

  function _createSplitHandle(orientation, key, index) {
    const handle = document.createElement('div');
    handle.className = `compare-split-handle ${orientation}`;
    handle.dataset.weightKey = key;
    handle.dataset.index = String(index);
    handle.title = orientation === 'vertical' ? 'Drag to resize columns' : 'Drag to resize rows';
    handle.addEventListener('pointerdown', _beginSplitDrag);
    return handle;
  }

  function _positionSplitHandles() {
    const axes = _getLayoutAxes();
    if (!axes) return;

    if (axes.columnKey) _positionAxisHandles(axes.columnKey, axes.columns, true);
    if (axes.rowKey) _positionAxisHandles(axes.rowKey, axes.rows, false);
  }

  function _positionAxisHandles(key, count, vertical) {
    const weights = _getWeights(key, count);
    const total = weights.reduce((sum, value) => sum + value, 0) || 1;
    let cursor = 0;
    for (let i = 0; i < count - 1; i++) {
      cursor += weights[i];
      const handle = document.querySelector(`.compare-split-handle[data-weight-key="${key}"][data-index="${i}"]`);
      if (!handle) continue;
      const pct = (cursor / total) * 100;
      if (vertical) handle.style.left = `${pct}%`;
      else handle.style.top = `${pct}%`;
    }
  }

  function _beginSplitDrag(event) {
    const handle = event.currentTarget;
    const key = handle.dataset.weightKey;
    const index = parseInt(handle.dataset.index, 10);
    const axes = _getLayoutAxes();
    if (!key || !axes || Number.isNaN(index)) return;

    const count = key === axes.columnKey ? axes.columns : axes.rows;
    const weights = _getWeights(key, count);
    const start = [...weights];
    const pairTotal = start[index] + start[index + 1];
    const grid = document.getElementById('compare-grid');
    const rect = grid.getBoundingClientRect();
    const startCoord = key === axes.columnKey ? event.clientX : event.clientY;
    const available = Math.max(1, key === axes.columnKey ? rect.width : rect.height);
    const totalWeight = weights.reduce((sum, value) => sum + value, 0) || 1;
    const minWeight = Math.min(0.35, pairTotal / 3);

    try {
      handle.setPointerCapture?.(event.pointerId);
    } catch (err) {
      // Synthetic browser-QA pointer events do not always create a capturable pointer.
    }
    handle.classList.add('is-dragging');
    document.body.classList.add('compare-dragging');
    event.preventDefault();

    const onMove = (moveEvent) => {
      const current = key === axes.columnKey ? moveEvent.clientX : moveEvent.clientY;
      const deltaWeight = ((current - startCoord) / available) * totalWeight;
      const nextA = Utils.clamp(start[index] + deltaWeight, minWeight, pairTotal - minWeight);
      const nextWeights = _getWeights(key, count);
      nextWeights[index] = nextA;
      nextWeights[index + 1] = pairTotal - nextA;
      _layoutWeights[key] = nextWeights;
      _applyGridTemplates();
      _positionSplitHandles();
      _notifyFramesResize();
    };

    const onUp = () => {
      handle.classList.remove('is-dragging');
      document.body.classList.remove('compare-dragging');
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      _notifyFramesResize();
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  }

  function _notifyFramesResize() {
    clearTimeout(_resizeNotifyTimer);
    _resizeNotifyTimer = setTimeout(() => {
      document.querySelectorAll('.viewer-frame').forEach(iframe => {
        try {
          iframe.contentWindow?.dispatchEvent(new Event('resize'));
        } catch (err) {
          // Same-origin iframes should be reachable; ignore a browser edge case.
        }
      });
    }, 80);
  }

  // --- Synchronization ---

  function _handleIframeMessage(event) {
    if (!Utils.isTrustedMessageOrigin(event)) return;
    const data = event.data;
    if (!data || !data.type || !data.sourceIndex) return;

    if (data.type === 'SYNC_Z' && _syncOptions.z) _broadcast(data, data.sourceIndex);
    else if (data.type === 'SYNC_TIME' && _syncOptions.time) _broadcast(data, data.sourceIndex);
    else if (data.type === 'SYNC_CAMERA' && _syncOptions.camera) _broadcast(data, data.sourceIndex);
    else if (data.type === 'SYNC_CHANNELS' && _syncOptions.channels) _broadcast(data, data.sourceIndex);
    else if (data.type === 'SYNC_ZSTACK_SLICE') {
      // Z-stack slice navigation from a decompose panel — broadcast to all sibling panels.
      // Each sibling will open its own z-stack browser and navigate to the same slice.
      _broadcast(data, data.sourceIndex);
    }
    else if (data.type === 'SYNC_SLICER_SPEC') {
      // Slice-through-volume plane spec from a decompose panel — broadcast to all siblings.
      // Siblings will apply the full spec (position + angles + slab) and enable the cut plane.
      _broadcast(data, data.sourceIndex);
    }
    else if (data.type === 'SIDEBAR_CLOSED') {
      const btn = document.querySelector(`.btn-settings[data-index="${data.sourceIndex}"]`);
      if (btn) btn.classList.remove('bg-primary', 'text-white');
    }
    else if (data.type === 'REQUEST_COMPARE_STUDIO') {
      _openCompareStudio();
    }
    else if (data.type === 'QUALITY_STATUS') _handlePanelQuality(data.sourceIndex, data.value || {});
  }

  function _handlePanelQuality(panelIndex, value) {
    const idx = Number(panelIndex);
    const state = { ...(_panelQualityState.get(idx) || {}) };
    if (value.phase === 'preview-ready') {
      state.previewReady = true;
      _panelQualityState.set(idx, state);
      return;
    }

    // The viewer is ready and waiting for us to trigger the high-detail load.
    // This handles the race condition where our earlier START_HIGH_DETAIL was sent
    // before the viewer's message listener was registered during its async init().
    if (value.phase === 'high-waiting') {
      state.previewReady = true;
      _panelQualityState.set(idx, state);
      const iframe = document.getElementById(`iframe-${idx}`);
      if (iframe?.contentWindow) {
        // Only send if we haven't already received a high-loading or high-ready for this panel
        if (!state.highReady && !state.highLoading) {
          if (!_highDetailQueue.includes(idx) && _activeHighDetailLoads < MAX_PARALLEL_HIGH_DETAIL) {
            _activeHighDetailLoads++;
          }
          iframe.contentWindow.postMessage({ type: 'START_HIGH_DETAIL', sourceIndex: 'parent' }, '*');
        }
      }
      return;
    }

    if (value.phase === 'high-loading') {
      state.highLoading = true;
      _panelQualityState.set(idx, state);
      return;
    }

    if (value.phase === 'high-ready' || value.phase === 'high-error') {
      state.highReady = value.phase === 'high-ready';
      state.highLoading = false;
      _panelQualityState.set(idx, state);
      _activeHighDetailLoads = Math.max(0, _activeHighDetailLoads - 1);
      _drainHighDetailQueue();
    }
  }

  function _broadcast(messageData, skipIndex) {
    document.querySelectorAll('.viewer-frame').forEach(iframe => {
      const idx = iframe.dataset.index;
      if ((skipIndex == null || idx !== skipIndex.toString()) && iframe.contentWindow) {
        iframe.contentWindow.postMessage(messageData, '*');
      }
    });
  }

  // --- Figure Export ---

  function _getCompareExports() {
    const hasPanels = _activePanels.length > 0;
    return [
      {
        action: 'compare-figure-png',
        icon: 'layout-grid',
        label: 'Compare PNG',
        enabled: hasPanels,
        disabledTitle: 'Add at least one panel first',
        handler: () => _exportCompareFigure('png')
      },
      {
        action: 'compare-figure-webp',
        icon: 'layout-grid',
        label: 'Compare WEBP',
        enabled: hasPanels,
        disabledTitle: 'Add at least one panel first',
        handler: () => _exportCompareFigure('webp')
      }
    ];
  }

  function _decomposeChannels() {
    if (_activePanels.length !== 1) return;
    const panel = _activePanels[0];
    const iframe = document.querySelector(`iframe[data-index="${panel.index}"]`);
    if (!iframe?.contentWindow?.VolumeViewer) return;
    
    const sr = iframe.contentWindow.ViewerApp.getCurrentSliceResult();
    if (!sr || !sr.channelState || sr.channelState.length <= 1) {
      _toast(_t('toast.noMultiChannel', 'Dataset does not have multiple channels to decompose.'));
      return;
    }
    
    // Disable channel sync (each panel shows a different channel)
    const syncCb = document.getElementById('sync-channels');
    if (syncCb) { syncCb.checked = false; _syncOptions.channels = false; }

    // Assign channel 0 to the source panel
    _panelSoloChannel.set(panel.index, 0);
    iframe.contentWindow.postMessage({ type: 'SET_CHANNEL_ACTIVE', channelIndex: 0 }, '*');
    
    const maxNew = Math.min(MAX_PANELS - 1, sr.channelState.length - 1);
    for (let i = 0; i < maxNew; i++) {
      _addPanel(panel.id);
      const newPanelInfo = _activePanels[_activePanels.length - 1];
      const channelIdx = i + 1;
      // Register solo channel immediately so state is saved correctly
      _panelSoloChannel.set(newPanelInfo.index, channelIdx);
      // Send SET_CHANNEL_ACTIVE when the iframe is ready
      const newIframe = document.querySelector(`iframe[data-index="${newPanelInfo.index}"]`);
      if (newIframe) {
        newIframe.addEventListener('load', () => {
          newIframe.contentWindow?.postMessage({ type: 'SET_CHANNEL_ACTIVE', channelIndex: channelIdx }, '*');
        });
      }
    }
  }

  async function _openCompareStudio() {
    const grid = document.getElementById('compare-grid');
    const panels = [...document.querySelectorAll('.compare-panel')];
    if (!grid || !panels.length || typeof StudioEditor === 'undefined') return;

    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));

    // ── 1. Collect slice data + dataset names WHILE layout is still visible ──
    const gridRect = grid.getBoundingClientRect();
    const sliceEntries = [];

    panels.forEach(panel => {
      const iframe = panel.querySelector('iframe.viewer-frame');
      if (iframe?.contentWindow && iframe.contentWindow.VolumeViewer) {
        try {
          const sr = iframe.contentWindow.ViewerApp.getCurrentSliceResult();
          if (sr && sr.canvas) {
            const rect = panel.getBoundingClientRect();
            const datasetName = panel.querySelector('.panel-title-badge')?.textContent?.trim() || 'Dataset';
            sliceEntries.push({
              sr, datasetName,
              cx: rect.left + rect.width / 2 - gridRect.left,
              cy: rect.top + rect.height / 2 - gridRect.top
            });
          }
        } catch (e) {
          console.error('[Compare] Error getting slice result', e);
        }
      }
    });

    if (!sliceEntries.length) return;

    // ── 2. Hide compare layout ──
    document.querySelector('.compare-layout')?.classList.add('hidden');

    // ── 3. Determine grid structure (cols × rows) from panel positions ──
    const GAP = 6;
    const LABEL_H = 32; // height for dataset name label above each cell
    const tolerance = gridRect.height * 0.15;

    const sorted = [...sliceEntries].sort((a, b) => a.cy - b.cy);
    const rows = [];
    sorted.forEach(entry => {
      const lastRow = rows[rows.length - 1];
      if (lastRow && Math.abs(entry.cy - lastRow[0].cy) < tolerance) {
        lastRow.push(entry);
      } else {
        rows.push([entry]);
      }
    });
    rows.forEach(row => row.sort((a, b) => a.cx - b.cx));

    const nRows = rows.length;
    const nCols = Math.max(...rows.map(r => r.length));

    // ── 4. Determine cell size ──
    let maxSliceW = 0, maxSliceH = 0;
    sliceEntries.forEach(e => {
      maxSliceW = Math.max(maxSliceW, e.sr.canvas.width);
      maxSliceH = Math.max(maxSliceH, e.sr.canvas.height);
    });

    const MAX_CANVAS = 8192;
    const baseLabelH = Math.max(48, Math.round(maxSliceH * 0.04));
    const baseResLabelH = Math.max(28, Math.round(maxSliceH * 0.035));
    
    let neededW = nCols * maxSliceW + (nCols - 1) * GAP;
    let neededH = nRows * (maxSliceH + baseLabelH + baseResLabelH) + (nRows - 1) * GAP;
    
    const canvasScale = Math.min(1, MAX_CANVAS / Math.max(neededW, neededH));
    
    const cellW = Math.round(maxSliceW * canvasScale);
    const cellH = Math.round(maxSliceH * canvasScale);
    const labelH = Math.round(baseLabelH * canvasScale);
    const resLabelH = Math.round(baseResLabelH * canvasScale);

    // ── 5. Compose canvas ──
    const canvasW = nCols * cellW + (nCols - 1) * GAP;
    const canvasH = nRows * (cellH + labelH + resLabelH) + (nRows - 1) * GAP;

    const canvas = document.createElement('canvas');
    canvas.width = canvasW;
    canvas.height = canvasH;
    const ctx = canvas.getContext('2d');
    const dark = Theme.isDark?.() !== false;
    ctx.fillStyle = dark ? '#05070b' : '#ffffff';
    ctx.fillRect(0, 0, canvasW, canvasH);

    const layoutMaps = [];
    let combinedChannelState = [];
    let firstPixelSizeUm = { x: 1, y: 1 };

    rows.forEach((row, ri) => {
      row.forEach((entry, ci) => {
        const srcW = entry.sr.canvas.width;
        const srcH = entry.sr.canvas.height;

        const cellX = ci * (cellW + GAP);
        const cellTopY = ri * (cellH + labelH + resLabelH + GAP);

        // ── Draw label header ──
        const fontSize = Math.max(12, Math.round(labelH * 0.45));
        ctx.save();
        ctx.fillStyle = dark ? 'rgba(255,255,255,0.85)' : 'rgba(15,23,42,0.85)';
        ctx.font = `600 ${fontSize}px Inter, Arial, sans-serif`;
        ctx.textBaseline = 'middle';

        // Dataset name (left-aligned)
        // Truncate based on how much width we actually have
        const charWidthEst = fontSize * 0.6;
        const maxChars = Math.max(10, Math.floor((cellW - 100) / charWidthEst));
        const nameText = entry.datasetName.length > maxChars
          ? entry.datasetName.slice(0, maxChars - 3) + '...' : entry.datasetName;
        ctx.textAlign = 'left';
        ctx.fillText(nameText, cellX + 4, cellTopY + labelH / 2);

        ctx.restore();

        // ── Draw slice (preserve aspect ratio, center in cell) ──
        const drawY = cellTopY + labelH;
        
        const scaleToFit = Math.min(cellW / srcW, cellH / srcH);
        const drawW = Math.round(srcW * scaleToFit);
        const drawH = Math.round(srcH * scaleToFit);
        const offsetX = Math.round((cellW - drawW) / 2);
        const offsetY = Math.round((cellH - drawH) / 2);

        ctx.drawImage(entry.sr.canvas, cellX + offsetX, drawY + offsetY, drawW, drawH);

        // Resolution (bottom-left, below slice cell area)
        if (srcW && srcH) {
          const resFontSize = Math.max(14, Math.round(cellH * 0.032));
          ctx.save();
          ctx.fillStyle = dark ? 'rgba(255,255,255,0.5)' : 'rgba(15,23,42,0.5)';
          ctx.font = `400 ${resFontSize}px Inter, Arial, sans-serif`;
          ctx.textBaseline = 'top';
          ctx.textAlign = 'left';
          ctx.fillText(`${srcW} × ${srcH} px`, cellX + 4, drawY + cellH + 4);
          ctx.restore();
        }

        const pxScaleX = srcW / drawW;
        const pxScaleY = srcH / drawH;
        const pxUm = entry.sr.pixelSizeUm || { x: 1, y: 1 };
        const scaledPixelSizeUm = { x: pxUm.x * pxScaleX, y: pxUm.y * pxScaleY };

        if (layoutMaps.length === 0) firstPixelSizeUm = scaledPixelSizeUm;

        // Find the panel/iframe for this entry to pass VolumeSlicer if needed
        const panelEl = Array.from(panels).find(p => {
          return (p.querySelector('.panel-title-badge')?.textContent?.trim() || 'Dataset') === entry.datasetName;
        });
        const iframe = panelEl ? panelEl.querySelector('iframe.viewer-frame') : null;

        layoutMaps.push({
          x: cellX + offsetX, y: drawY + offsetY, w: drawW, h: drawH,
          pixelSizeUm: scaledPixelSizeUm,
          channelState: entry.sr.channelState || [],
          raw: entry.sr.raw || null,
          sourceWidth: srcW,
          sourceHeight: srcH,
          iframe: iframe,
          sliceResult: entry.sr
        });

        if (entry.sr.channelState) {
          combinedChannelState.push(...entry.sr.channelState);
        }
      });
    });

    // ── 6. Open Studio ──
    StudioEditor.open({
      canvas, width: canvasW, height: canvasH,
      source: 'compare',
      pixelSizeUm: firstPixelSizeUm,
      layoutMaps,
      channelState: combinedChannelState
    });
  }

  async function _exportCompareFigure(format = 'png') {
    try {
      const result = await _composeCompareFigure(format);
      if (!result?.blob) {
        ExportManager?.toast?.('Compare figure export is not ready yet');
        return null;
      }
      const suffix = format === 'webp' ? 'webp' : 'png';
      ExportManager.downloadBlob(result.blob, `${_safeName(_figureName())}_compare.${suffix}`);
      ExportManager?.toast?.('Compare figure exported');
      return result;
    } catch (err) {
      console.error('[Compare] Figure export failed', err);
      ExportManager?.toast?.('Compare figure export failed');
      return null;
    }
  }

  async function _composeCompareFigure(format = 'png') {
    const grid = document.getElementById('compare-grid');
    const panels = [...document.querySelectorAll('.compare-panel')];
    if (!grid || !panels.length) return null;

    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));

    const gridRect = grid.getBoundingClientRect();
    const maxSide = 4096;
    const desiredScale = 2;
    const scale = Math.max(1, Math.min(desiredScale, maxSide / Math.max(gridRect.width, gridRect.height, 1)));
    const width = Math.max(1, Math.round(gridRect.width * scale));
    const height = Math.max(1, Math.round(gridRect.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    const dark = Theme.isDark?.() !== false;
    let fallbackPanels = 0;

    ctx.fillStyle = dark ? '#05070b' : '#ffffff';
    ctx.fillRect(0, 0, width, height);

    panels.forEach(panel => {
      const rect = panel.getBoundingClientRect();
      const x = Math.round((rect.left - gridRect.left) * scale);
      const y = Math.round((rect.top - gridRect.top) * scale);
      const w = Math.round(rect.width * scale);
      const h = Math.round(rect.height * scale);
      const iframe = panel.querySelector('iframe.viewer-frame');
      const title = panel.querySelector('.panel-title-badge')?.textContent?.trim() || 'Panel';

      ctx.fillStyle = dark ? '#111827' : '#f8fafc';
      ctx.fillRect(x, y, w, h);
      const drewCanvas = _drawIframeCanvas(ctx, iframe, x, y, w, h);
      if (!drewCanvas) {
        fallbackPanels++;
        _drawPanelFallback(ctx, title, x, y, w, h, scale, dark);
      }
      _drawPanelLabel(ctx, title, x, y, w, scale);
    });

    _drawFigureStamp(ctx, width, height, scale, dark);
    const mime = format === 'webp' ? 'image/webp' : 'image/png';
    const blob = await new Promise(resolve => canvas.toBlob(resolve, mime, 0.95));
    return { blob, width, height, panelCount: panels.length, fallbackPanels, mime };
  }

  function _drawIframeCanvas(ctx, iframe, x, y, w, h) {
    if (!iframe?.contentDocument) return false;
    const source = iframe.contentDocument.querySelector('#webgl-canvas')
      || iframe.contentDocument.querySelector('#tracking-canvas canvas')
      || iframe.contentDocument.querySelector('canvas');
    if (!source || !source.width || !source.height) return false;
    if (_sampleCanvasNonzero(source) <= 16) return false;
    try {
      ctx.drawImage(source, x, y, w, h);
      return true;
    } catch (err) {
      return false;
    }
  }

  function _drawPanelFallback(ctx, title, x, y, w, h, scale, dark) {
    ctx.save();
    ctx.strokeStyle = dark ? 'rgba(255,255,255,0.16)' : 'rgba(15,23,42,0.18)';
    ctx.lineWidth = Math.max(1, scale);
    ctx.strokeRect(x + 8 * scale, y + 8 * scale, Math.max(1, w - 16 * scale), Math.max(1, h - 16 * scale));
    ctx.fillStyle = dark ? 'rgba(255,255,255,0.72)' : 'rgba(15,23,42,0.72)';
    ctx.font = `${Math.round(13 * scale)}px Inter, Arial, sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillText(`${title} not ready`, x + w / 2, y + h / 2);
    ctx.restore();
  }

  function _drawPanelLabel(ctx, title, x, y, w, scale) {
    const label = title.length > 72 ? `${title.slice(0, 69)}...` : title;
    ctx.save();
    ctx.font = `${Math.round(12 * scale)}px Inter, Arial, sans-serif`;
    const padX = 10 * scale;
    const padY = 6 * scale;
    const textW = Math.min(ctx.measureText(label).width, Math.max(1, w - 24 * scale));
    const boxW = textW + padX * 2;
    const boxH = 26 * scale;
    const bx = x + 12 * scale;
    const by = y + 12 * scale;
    _roundRect(ctx, bx, by, Math.min(boxW, Math.max(1, w - 24 * scale)), boxH, 8 * scale);
    ctx.fillStyle = 'rgba(5, 8, 12, 0.78)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.18)';
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, bx + padX, by + boxH / 2, Math.max(1, w - 44 * scale));
    ctx.restore();
  }

  function _drawFigureStamp(ctx, width, height, scale, dark) {
    ctx.save();
    ctx.fillStyle = dark ? 'rgba(255,255,255,0.62)' : 'rgba(15,23,42,0.62)';
    ctx.font = `${Math.round(10 * scale)}px Inter, Arial, sans-serif`;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'bottom';
    const stamp = `IRIBHM compare | ${new Date().toISOString().slice(0, 19).replace('T', ' ')}`;
    ctx.fillText(stamp, width - 12 * scale, height - 10 * scale);
    ctx.restore();
  }

  function _roundRect(ctx, x, y, w, h, r) {
    const radius = Math.min(r, w / 2, h / 2);
    if (ctx.roundRect) {
      ctx.beginPath();
      ctx.roundRect(x, y, w, h, radius);
      return;
    }
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.lineTo(x + w - radius, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
    ctx.lineTo(x + w, y + h - radius);
    ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
    ctx.lineTo(x + radius, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
    ctx.lineTo(x, y + radius);
    ctx.quadraticCurveTo(x, y, x + radius, y);
  }

  function _figureName() {
    const ids = _activePanels.map(panel => panel.id).slice(0, 4);
    return ids.length ? ids.join('_vs_') : 'compare';
  }

  function _safeName(value) {
    return String(value || 'compare').replace(/[^a-z0-9._-]+/gi, '_').replace(/^_+|_+$/g, '').slice(0, 140);
  }

  // i18n helper: resolve key (with optional {params}), else the literal default.
  const _t = (k, def, params) => {
    const v = (window.I18n && I18n.t) ? I18n.t(k, params) : k;
    return v === k ? def : v;
  };

  function _toast(text) {
    if (typeof ExportManager !== 'undefined' && typeof ExportManager.toast === 'function') {
      ExportManager.toast(text);
      return;
    }
    console.warn(`[Compare] ${text}`);
  }

  function _getWorkspaceState() {
    let allReady = true;
    const iframeStates = _activePanels.map(panel => {
      const iframe = document.querySelector(`iframe[data-index="${panel.index}"]`);
      if (iframe && iframe.contentWindow && iframe.contentWindow.ViewerApp?.getWorkspaceState) {
        const st = iframe.contentWindow.ViewerApp.getWorkspaceState();
        console.log('[Compare] iframe', panel.index, 'getWorkspaceState result:', {
          hasViewer: !!st?.viewer,
          cameraZ: st?.viewer?.camera?.cameraZ,
          measureCount: st?.viewer?.measurements?.length
        });
        return st;
      }
      allReady = false;
      return null;
    });

    if (!allReady) {
      console.log('[Compare] _getWorkspaceState: not all iframes ready, returning null');
      return null;
    }

    return {
      ui: {
        panelCount: _activePanels.length
      },
      compare: {
        panels: _activePanels.map(panel => panel.id),
        layoutMode: _layoutMode,
        layoutWeights: JSON.parse(JSON.stringify(_layoutWeights)),
        sync: { ..._syncOptions },
        // Save z-stack state per panel at compare level (not from iframe state)
        // to avoid cross-contamination between panels on restore.
        // Include slice so the exact z-stack position is restored.
        panelZstackStates: _activePanels.map((panel, i) => ({
          active: _panelZstackActive.get(panel.index) || false,
          slice:  iframeStates[i]?.viewer?.zstackSlice || 0
        })),
        // Solo channel per panel for decompose-by-channel mode (null = not decomposed)
        panelSoloChannels: _activePanels.map(panel => _panelSoloChannel.get(panel.index) ?? null),
        iframeStates: iframeStates
      }
    };
  }

  function _applyWorkspaceState(state = {}) {
    const compareState = state.compare && Object.keys(state.compare).length ? state.compare : state;
    document.querySelectorAll('.compare-panel').forEach(panel => panel.remove());
    _activePanels = [];
    _panelLoadQueue = [];
    _highDetailQueue = [];
    _panelQualityState = new Map();
    _activePanelLoads = 0;
    _activeHighDetailLoads = 0;
    
    const iframeStates = compareState.iframeStates || [];
    console.log('[Compare] _applyWorkspaceState: panels=', compareState.panels, 'iframeStates count=', iframeStates.length, 'first has camera?', !!iframeStates[0]?.viewer?.camera);
    (compareState.panels || []).slice(0, MAX_PANELS).forEach((id, i) => {
      _addPanel(id);
      const panelInfo = _activePanels[_activePanels.length - 1];
      const iframe = document.querySelector(`iframe[data-index="${panelInfo.index}"]`);

      // Restore z-stack state via TOGGLE_ZSTACK (keeps compare.js _panelZstackActive in sync)
      const zstackEntry = Array.isArray(compareState.panelZstackStates)
        ? compareState.panelZstackStates[i]
        : null;
      // Support both legacy boolean format and new {active, slice} format
      const savedZstackActive = typeof zstackEntry === 'boolean' ? zstackEntry
        : (zstackEntry?.active || false);
      const savedZstackSlice  = typeof zstackEntry === 'object' ? (zstackEntry?.slice || 0) : 0;
      if (savedZstackActive) {
        _panelZstackActive.set(panelInfo.index, true);
        // Update button styling
        const zBtn = document.querySelector(`.btn-toggle-zstack[data-index="${panelInfo.index}"]`);
        if (zBtn) { zBtn.classList.add('btn-solid'); zBtn.classList.remove('btn-ghost'); }
      }

      // Restore decompose-by-channel solo assignment
      const savedSoloChannel = Array.isArray(compareState.panelSoloChannels)
        ? (compareState.panelSoloChannels[i] ?? null)
        : null;
      if (savedSoloChannel !== null) {
        _panelSoloChannel.set(panelInfo.index, savedSoloChannel);
      }

      if (iframe && iframeStates[i]) {
        const stateToSend = iframeStates[i];
        let sent = false;
        const trySend = () => {
          if (sent) return;
          if (iframe.contentWindow) {
            console.log('[Compare] Sending APPLY_WORKSPACE_STATE to iframe', panelInfo.index, 'camera:', stateToSend?.viewer?.camera?.cameraZ, 'measures:', stateToSend?.viewer?.measurements?.length);
            iframe.contentWindow.postMessage({ type: 'APPLY_WORKSPACE_STATE', state: stateToSend }, '*');
            // Restore z-stack state — compare.js is the authority for this
            if (savedZstackActive) {
              iframe.contentWindow.postMessage({ type: 'TOGGLE_ZSTACK', state: true, slice: savedZstackSlice }, '*');
            }
            // Restore solo channel for decompose panels
            if (savedSoloChannel !== null) {
              iframe.contentWindow.postMessage({ type: 'SET_CHANNEL_ACTIVE', channelIndex: savedSoloChannel }, '*');
            }
            sent = true;
          }
        };
        // Primary: listen for load event
        iframe.addEventListener('load', trySend);
        // Fallback: poll every 500ms in case load already fired
        const pollId = setInterval(() => {
          if (sent) { clearInterval(pollId); return; }
          // Check if iframe has ViewerApp loaded (meaning scripts ran)
          try {
            if (iframe.contentWindow && iframe.contentWindow.ViewerApp) {
              console.log('[Compare] Fallback poll detected ViewerApp ready in iframe', panelInfo.index);
              trySend();
              clearInterval(pollId);
            }
          } catch (e) { /* cross-origin, ignore */ }
        }, 500);
        // Safety: stop polling after 30s
        setTimeout(() => clearInterval(pollId), 30000);
      }
    });
    if (compareState.layoutMode) {
      _layoutMode = compareState.layoutMode;
      const select = document.getElementById('compare-layout-mode');
      if (select) select.value = _layoutMode;
    }
    if (compareState.layoutWeights) {
      _layoutWeights = {
        ..._layoutWeights,
        ...JSON.parse(JSON.stringify(compareState.layoutWeights))
      };
    }
    if (compareState.sync) {
      _syncOptions = { ..._syncOptions, ...compareState.sync };
      Object.entries(_syncOptions).forEach(([key, value]) => {
        const cb = document.getElementById(`sync-${key}`);
        if (cb) cb.checked = Boolean(value);
      });
    }
    _updateLayout();
  }

  return {
    init,
    addPanel: _addPanel,
    getWorkspaceState: _getWorkspaceState,
    applyWorkspaceState: _applyWorkspaceState,
    composeFigure: _composeCompareFigure,
    exportFigure: _exportCompareFigure,
    _handleIframeMessage  // exposed for unit testing (origin guard)
  };
})();

document.addEventListener('DOMContentLoaded', CompareApp.init);








