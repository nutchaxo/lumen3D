/* ============================================================
   IRIBHM Microscopy Platform — Tracking Page Controller
   ============================================================ */

const TrackingApp = (() => {
  let _datasetId = null;
  let _datasetMeta = null;
  let _isIframe = false;
  let _panelIndex = null;
  let _setTimelineFrame = null;
  let _getTimelineFrame = null;
  let _updateTimelineTicks = null;
  let _displayState = { backgroundPreset: 'paper', backgroundColor: '#ffffff' };

  async function init() {
    // 1. Init core
    Theme.init();
    await I18n.init();
    await Catalog.load();

    if (window.lucide) lucide.createIcons();
    _updateThemeIcon();
    Theme.onChange(_updateThemeIcon);

    // 2. Read dataset ID
    const params = new URLSearchParams(window.location.search);
    _datasetId = params.get('id');
    _isIframe = params.get('hideHeader') === 'true';
    _panelIndex = params.get('panelIndex');

    if (_isIframe) {
      document.body.classList.add('viewer-iframe');
      document.querySelector('.viewer-header').style.display = 'none';
      document.querySelector('.viewer-sidebar').classList.add('sidebar-hidden');
      _bindIframeSync(_panelIndex);
    }

    if (!_datasetId) {
      _showError(I18n.t('viewer.errNoDataset'));
      return;
    }

    // 3. Fetch metadata
    _datasetMeta = Catalog.getById(_datasetId);
    if (!_datasetMeta) {
      _showError(I18n.t('viewer.errNotFound'));
      return;
    }
    document.title = `${_datasetMeta.name || _datasetId} - IRIBHM Tracking`;

    // 4. Update Header UI
    document.getElementById('dataset-title').textContent = _datasetMeta.name || _datasetId;
    // DEAD-036: single assignment (the first '·'-separated write was immediately overwritten).
    document.getElementById('dataset-subtitle').textContent =
      `${Utils.formatStage(_datasetMeta.stage)} - ${Utils.formatDate(_datasetMeta.date)} - Tracking`;
    _renderRelatedDatasets();

    // 5. Initialize 3D Tracking Viewer
    const basePath = `./DATA_WEB/${_datasetMeta.path}`;
    await TrackingViewer.init(document.getElementById('tracking-canvas'));
    if (_isIframe) {
      TrackingViewer.onCameraChange((state) => {
        window.parent.postMessage({ type: 'SYNC_CAMERA', value: state, sourceIndex: _panelIndex }, '*');
      });
    }
    
    // Bind UI controls
    _bindUI();
    _bindDisplayControls();

    // Load Data
    try {
      await TrackingViewer.loadData(basePath, _datasetMeta, (progress) => {
        // Handled by TrackingViewer internal loader if needed, or we hide ours
      });
      AnalysisStore.setTrackingData(TrackingViewer.getTrackData());
      ChartStudio.init('stats-graph', {
        metric: 'population',
        scale: 'linear',
        getSeriesOptions: _trackingAnalysisOptions
      });
      document.querySelector('[data-chart-metric="population"]')?.classList.add('active');
      _setChartScale('linear');
      _updateChartTitle('population');
      TrackingViewer.onCellSelect(_renderCellInspector);
      TrackingViewer.onMeasureChange(_renderTrackingMeasurement);
      _renderCellInspector(null);
      _renderTrackingMeasurement(TrackingViewer.getMeasurement());
      _renderTrackingSciencePanels();
      _renderTrackingLegend();
      _setTrackingControlsReady(true);
      document.getElementById('viewer-loader').style.display = 'none';
      
      // Initialize Timeline — EDGE-016: derive the frame count from the loaded track
      // data (TrackingViewer.getFrameCount), not a hardcoded 10; clamp to >= 1.
      const totalFrames = Math.max(1,
        (TrackingViewer.getFrameCount && TrackingViewer.getFrameCount())
        || Number(_datasetMeta.dimensions?.t) || 1);
      _initTimeline(totalFrames);
      
    } catch (e) {
      console.error(e);
      _showError(`Failed to load tracking data: ${e.message}`);
    }
  }

  function _initTimeline(totalFrames) {
    if (typeof Timeline === 'undefined') return;
    Timeline.init('timeline-panel', {
      totalFrames: totalFrames,
      showSpeed: true,
      showSmooth: true,
      stepped: true
    }, (state) => {
      TrackingViewer.setTimepoint(state.frame);
      if (state.smooth !== undefined) TrackingViewer.setSmoothing(state.smooth);
      _renderTrackingSciencePanels();
      
      if (_isIframe) {
        window.parent.postMessage({ type: 'SYNC_TIME', value: state.frame, sourceIndex: _panelIndex }, '*');
      }
    });

    _setTimelineFrame = Timeline.setFrame;
    _getTimelineFrame = Timeline.getFrame;
    _updateTimelineTicks = () => {}; // Now handled internally by Timeline component
  }

  function _bindUI() {
    // Graph toggle
    const btnGraph = document.getElementById('btn-toggle-graph');
    const panelGraph = document.getElementById('stats-panel');
    const btnCloseGraph = document.getElementById('btn-close-graph');
    const btnScaleLinear = document.getElementById('btn-chart-scale-linear');
    const btnScaleLog = document.getElementById('btn-chart-scale-log');
    
    btnGraph.addEventListener('click', () => {
      panelGraph.classList.toggle('visible');
      if (panelGraph.classList.contains('visible')) ChartStudio.render();
    });
    
    btnCloseGraph.addEventListener('click', () => {
      panelGraph.classList.remove('visible');
    });

    const gridBtn = document.getElementById('btn-toggle-grid');
    const axesBtn = document.getElementById('btn-toggle-axes');
    let gridMode = 0;
    let axesVisible = false;

    if (gridBtn) {
      gridBtn.addEventListener('click', () => {
        gridMode = (gridMode + 1) % 3;
        gridBtn.classList.toggle('btn-solid', gridMode > 0);
        gridBtn.classList.toggle('btn-ghost', gridMode === 0);
        TrackingViewer.setGridMode(gridMode);
      });
    }

    if (axesBtn) {
      axesBtn.addEventListener('click', () => {
        axesVisible = !axesVisible;
        axesBtn.classList.toggle('btn-solid', axesVisible);
        axesBtn.classList.toggle('btn-ghost', !axesVisible);
        TrackingViewer.setAxesVisible(axesVisible);
      });
    }

    btnScaleLinear?.addEventListener('click', () => _setChartScale('linear'));
    btnScaleLog?.addEventListener('click', () => _setChartScale('log'));

    // Filters
    document.getElementById('toggle-mitosis').addEventListener('change', (e) => {
      TrackingViewer.setFilter('mitosis', e.target.checked);
    });
    document.getElementById('toggle-fusion').addEventListener('change', (e) => {
      TrackingViewer.setFilter('fusion', e.target.checked);
    });
    document.getElementById('toggle-stabilized').addEventListener('change', (e) => {
      TrackingViewer.setFilter('stabilized', e.target.checked);
      ChartStudio.render();
      _renderCellInspector(TrackingViewer.getSelectedCell());
      _renderTrackingSciencePanels();
    });

    document.getElementById('toggle-velocity-field')?.addEventListener('change', (e) => {
      TrackingViewer.setVelocityFieldVisible(e.target.checked);
    });
    document.getElementById('toggle-neighbor-network')?.addEventListener('change', (e) => {
      TrackingViewer.setNeighborNetworkVisible(e.target.checked);
      _renderNeighborNetworkPanel();
    });
    document.getElementById('select-neighbor-threshold')?.addEventListener('change', (e) => {
      TrackingViewer.setNeighborThreshold(e.target.value);
      ChartStudio.render();
      _renderCellInspector(TrackingViewer.getSelectedCell());
      _renderNeighborNetworkPanel();
      _renderTrackingLegend();
    });
    document.getElementById('btn-export-neighbors')?.addEventListener('click', _exportNeighborsCsv);
    document.getElementById('btn-export-lineage')?.addEventListener('click', _exportLineageJson);

    // Surface
    const sliderOp = document.getElementById('slider-opacity');
    const valOp = document.getElementById('val-opacity');
    sliderOp.addEventListener('input', (e) => {
      valOp.textContent = `${e.target.value}%`;
      TrackingViewer.setSurfaceOpacity(parseInt(e.target.value) / 100);
    });

    document.getElementById('select-surface-color').addEventListener('change', (e) => {
      TrackingViewer.setSurfaceColorMode(_surfaceColorMode(e.target.value));
      _renderTrackingLegend();
    });
    
    // Smoothing is now handled by Timeline component.

    const btnCenter = document.getElementById('btn-center-sample');
    if (btnCenter) {
      btnCenter.addEventListener('click', () => TrackingViewer.centerSample());
    }

    // Find Cell
    const btnFind = document.getElementById('btn-find-cell');
    const inputFind = document.getElementById('input-find-cell');
    const statusFind = document.getElementById('find-cell-status');
    
    btnFind.addEventListener('click', () => {
      const val = inputFind.value.trim();
      if (!val) return;
      const found = TrackingViewer.findCell(val);
      if (found) {
        statusFind.textContent = `Found cell ${val} (Track ${found.track_id})`;
        statusFind.style.color = 'var(--color-success)';
      } else {
        statusFind.textContent = `Cell ${val} not found`;
        statusFind.style.color = 'var(--color-error)';
      }
    });
    
    inputFind.addEventListener('keyup', (e) => {
      if (e.key === 'Enter') btnFind.click();
    });

    document.querySelectorAll('[data-chart-metric]').forEach(button => {
      button.addEventListener('click', () => {
        document.querySelectorAll('[data-chart-metric]').forEach(btn => btn.classList.remove('active'));
        button.classList.add('active');
        panelGraph.classList.add('visible');
        ChartStudio.setMetric(button.dataset.chartMetric);
        _updateChartTitle(button.dataset.chartMetric);
      });
    });

    if (typeof ToolManager !== 'undefined') {
      const measurePanel = document.getElementById('tracking-measure-panel');
      const cutPanel = document.getElementById('tracking-cut-panel');
      ToolManager.init({
        defaultTool: 'navigate',
        onChange: (tool) => {
          TrackingViewer.setActiveTool(tool);
          measurePanel?.classList.toggle('visible', tool === 'measure');
          cutPanel?.classList.toggle('visible', tool === 'cut');
        }
      });
      TrackingViewer.setActiveTool('navigate');
    }

    if (typeof ExportManager !== 'undefined') {
      ExportManager.init({
        dataset: _datasetMeta,
        scope: 'tracking',
        getCanvas: () => TrackingViewer.getRenderer()?.domElement,
        getCanvasBlob: _getFigureBlob,
        getGraph: () => ChartStudio.getGraph(),
        getCustomExports: _getTrackingExports,
        getWorkspaceState: _getWorkspaceState,
        applyWorkspaceState: _applyWorkspaceState
      });
    }

    document.getElementById('btn-export')?.addEventListener('click', () => {
      ExportManager.openDownloadCenter({
        dataset: _datasetMeta,
        scope: 'tracking',
        getCanvas: () => TrackingViewer.getRenderer()?.domElement,
        getCanvasBlob: _getFigureBlob,
        getGraph: () => ChartStudio.getGraph(),
        getCustomExports: _getTrackingExports,
        getWorkspaceState: _getWorkspaceState,
        applyWorkspaceState: _applyWorkspaceState
      });
    });
    document.getElementById('btn-save-workspace')?.addEventListener('click', () => ExportManager.saveWorkspace('tracking'));
    document.getElementById('btn-restore-workspace')?.addEventListener('click', () => ExportManager.restoreWorkspace('tracking'));
    document.getElementById('btn-linked-data')?.addEventListener('click', _focusLinkedDataPanel);
    document.getElementById('btn-presentation')?.addEventListener('click', () => {
      document.body.classList.toggle('presentation-mode');
      _scheduleViewerResize();
    });
    document.getElementById('btn-close-tracking-measure')?.addEventListener('click', () => {
      if (typeof ToolManager !== 'undefined') ToolManager.activate('navigate');
    });
    document.getElementById('btn-close-tracking-cut')?.addEventListener('click', () => {
      if (typeof ToolManager !== 'undefined') ToolManager.activate('navigate');
    });
    document.getElementById('btn-clear-tracking-measure')?.addEventListener('click', () => {
      TrackingViewer.clearMeasurement();
    });
    document.querySelectorAll('[data-measure-mode]').forEach(button => {
      button.addEventListener('click', () => {
        document.querySelectorAll('[data-measure-mode]').forEach(node => node.classList.remove('active'));
        button.classList.add('active');
        TrackingViewer.setMeasurementMode(button.dataset.measureMode);
      });
    });
    document.getElementById('tracking-measure-list')?.addEventListener('click', (event) => {
      const action = event.target.closest('[data-tracking-measure-action]')?.dataset.trackingMeasureAction;
      const id = event.target.closest('[data-measurement-id]')?.dataset.measurementId;
      if (!action || !id) return;
      if (action === 'toggle') {
        const row = TrackingViewer.listMeasurements().find(item => item.id === id);
        if (!row) return;
        TrackingViewer.updateMeasurement(id, { visible: row.visible === false });
      }
      if (action === 'delete') {
        TrackingViewer.removeMeasurement(id);
      }
    });
    _bindTrackingClipControls();
  }

  function _setTrackingControlsReady(ready) {
    document.getElementById('btn-toggle-graph')?.toggleAttribute('disabled', !ready);
    document.getElementById('btn-find-cell')?.toggleAttribute('disabled', !ready);
    document.querySelectorAll('[data-chart-metric]').forEach(button => {
      button.toggleAttribute('disabled', !ready);
    });
  }

  function _bindDisplayControls() {
    const select = document.getElementById('select-background-preset');
    const customWrap = document.getElementById('label-background-custom');
    const input = document.getElementById('input-background-color');
    const pointScaleSlider = document.getElementById('slider-point-scale');
    const pointScaleVal = document.getElementById('val-point-scale');
    
    if (!select) return;
    
    if (_displayState.backgroundPreset) select.value = _displayState.backgroundPreset;
    if (input && _displayState.backgroundColor) input.value = _displayState.backgroundColor;

    const sync = () => {
      customWrap?.classList.toggle('hidden', select.value !== 'custom');
      _displayState.backgroundPreset = select.value;
      if (input) _displayState.backgroundColor = input.value || _displayState.backgroundColor;
      TrackingViewer.setBackgroundPreset(_displayState.backgroundPreset, _displayState.backgroundColor);
    };
    select.addEventListener('change', sync);
    input?.addEventListener('input', sync);
    sync();

    if (pointScaleSlider) {
      pointScaleSlider.addEventListener('input', (e) => {
        const val = parseFloat(e.target.value);
        if (pointScaleVal) pointScaleVal.textContent = val.toFixed(1) + 'x';
        TrackingViewer.setPointScale(val);
      });
    }
  }

  function _renderTrackingMeasurement(measurement) {
    const node = document.getElementById('tracking-measure-status');
    const list = document.getElementById('tracking-measure-list');
    if (!node) return;
    const draft = measurement?.draft || null;
    const rows = Array.isArray(measurement?.measurements) ? measurement.measurements : [];
    if (list) {
      list.innerHTML = rows.length
        ? rows.map((row, idx) => `
          <div class="measurement-row">
            <strong>${Utils.escapeHtml(row.label || `Measure ${idx + 1}`)}</strong>
            <span>
              ${row.status === 'out-of-frame' ? 'Out of frame' : `${_fmt(row.distance)} ${Utils.escapeHtml(row.unit || 'units')}`}<br>
              <small>${Utils.escapeHtml(row.mode === 'follow-cells' ? 'Follow cells' : 'Snapshot')}</small>
            </span>
            <span class="related-actions">
              <button class="btn btn-ghost btn-sm" type="button" data-tracking-measure-action="toggle" data-measurement-id="${Utils.escapeHtml(row.id)}">
                <i data-lucide="${row.visible === false ? 'eye-off' : 'eye'}"></i>
              </button>
              <button class="btn btn-ghost btn-sm" type="button" data-tracking-measure-action="delete" data-measurement-id="${Utils.escapeHtml(row.id)}">
                <i data-lucide="trash-2"></i>
              </button>
            </span>
          </div>
        `).join('')
        : 'No saved measurement yet.';
      if (window.lucide) lucide.createIcons({ root: list });
    }
    if (!draft || !draft.cells?.length) {
      node.innerHTML = 'Click two cells to measure their distance.';
      return;
    }
    if (draft.cells.length === 1) {
      const row = draft.cells[0];
      node.innerHTML = `
        <div class="metric-tile"><small>Cell A</small><strong>${Utils.escapeHtml(row.cell.track_id || row.id)}</strong></div>
        <div class="text-xs text-muted">Click a second cell.</div>
      `;
      return;
    }
    const [a, b] = draft.cells;
    node.innerHTML = `
      <div class="metric-grid">
        <div class="metric-tile"><small>Distance</small><strong>${_fmt(draft.distance)} units</strong></div>
        <div class="metric-tile"><small>Frame</small><strong>${_fmt(draft.timepoint)}</strong></div>
      </div>
      <div class="text-xs text-muted">
        ${Utils.escapeHtml(a.cell.track_id || a.id)} to ${Utils.escapeHtml(b.cell.track_id || b.id)} in ${document.getElementById('toggle-stabilized')?.checked ? 'stabilized' : 'raw'} coordinates.
      </div>
    `;
  }

  function _bindTrackingClipControls() {
    const apply = (patch = {}) => {
      const slider = document.getElementById('tracking-clip-position');
      const yaw = document.getElementById('tracking-clip-yaw');
      const pitch = document.getElementById('tracking-clip-pitch');
      const next = {
        ...TrackingViewer.getMeshClipSpec(),
        enabled: true,
        mode: document.querySelector('[data-clip-mode].active')?.dataset.clipMode || 'xy',
        value: (parseInt(slider?.value || '100', 10) || 0) / 100,
        yaw: parseFloat(yaw?.value || '0') || 0,
        pitch: parseFloat(pitch?.value || '0') || 0,
        ...patch
      };
      TrackingViewer.setMeshClipSpec(next);
      const label = document.getElementById('tracking-clip-pos-label');
      if (label) label.textContent = `${Math.round(next.value * 100)}%`;
    };

    document.querySelectorAll('[data-clip-mode]').forEach(button => {
      button.addEventListener('click', () => {
        document.querySelectorAll('[data-clip-mode]').forEach(node => node.classList.remove('active'));
        button.classList.add('active');
        apply({ mode: button.dataset.clipMode });
      });
    });
    document.getElementById('tracking-clip-position')?.addEventListener('input', () => apply());
    document.getElementById('tracking-clip-yaw')?.addEventListener('input', () => apply());
    document.getElementById('tracking-clip-pitch')?.addEventListener('input', () => apply());
    document.getElementById('btn-reset-tracking-clip')?.addEventListener('click', () => {
      document.querySelectorAll('[data-clip-mode]').forEach(node => node.classList.toggle('active', node.dataset.clipMode === 'xy'));
      const slider = document.getElementById('tracking-clip-position');
      const yaw = document.getElementById('tracking-clip-yaw');
      const pitch = document.getElementById('tracking-clip-pitch');
      if (slider) slider.value = 100;
      if (yaw) yaw.value = 0;
      if (pitch) pitch.value = 0;
      apply({ mode: 'xy', value: 1, yaw: 0, pitch: 0 });
    });
    document.getElementById('btn-disable-tracking-clip')?.addEventListener('click', () => {
      TrackingViewer.setMeshClipSpec({ enabled: false });
    });
  }

  function _renderCellInspector(cell, selectedId = null) {
    const node = document.getElementById('cell-inspector');
    if (!node) return;
    if (!cell) {
      node.innerHTML = 'Click a cell or search by ID.';
      return;
    }
    const id = selectedId || cell.id || cell.track_id;
    const metrics = AnalysisStore.cellMetrics(cell, _trackingAnalysisOptions()) || {};
    const neighbors = TrackingViewer.getNeighborNetworkRows(4);
    node.innerHTML = `
      <div class="metric-grid">
        <div class="metric-tile"><small>Track</small><strong>${Utils.escapeHtml(metrics.trackId || id || '--')}</strong></div>
        <div class="metric-tile"><small>Region</small><strong>${Utils.escapeHtml(metrics.region || 'Unknown')}</strong></div>
        <div class="metric-tile"><small>Mean speed</small><strong>${_fmt(metrics.meanSpeed)}</strong></div>
        <div class="metric-tile"><small>Straightness</small><strong>${_fmt(metrics.straightness)}</strong></div>
      </div>
      <div>
        <strong>Nearest neighbors</strong>
        <div class="text-xs text-muted mt-1">
          ${neighbors.length ? neighbors.map(n => `${Utils.escapeHtml(n.trackId || n.id)} (${_fmt(n.distance)})`).join(' &middot; ') : 'No neighbor at this timepoint.'}
        </div>
      </div>
      <button class="btn btn-outline btn-sm" type="button" data-export-track="${Utils.escapeHtml(id)}">
        <i data-lucide="download"></i> Export track CSV
      </button>
    `;
    node.querySelector('[data-export-track]')?.addEventListener('click', (e) => {
      const trackId = e.currentTarget.dataset.exportTrack;
      const csv = AnalysisStore.trackCsv(trackId);
      _downloadText(csv, `${_safeName(_datasetMeta.name || _datasetId)}_${trackId}_track.csv`, 'text/csv');
    });
    if (window.lucide) lucide.createIcons({ root: node });
    _renderTrackingSciencePanels();
  }

  function _renderTrackingSciencePanels() {
    _renderLineageTree();
    _renderNeighborNetworkPanel();
    _renderTrackingLegend();
  }

  function _renderTrackingLegend() {
    const node = document.getElementById('tracking-legend');
    if (!node || typeof TrackingViewer === 'undefined') return;
    // LEAK-008: detach any prior outside-click listener BEFORE the early returns, so
    // switching to a legend mode without the colormap button (uniform/region) can't
    // leave the previous density-mode document listener attached (it accumulated one
    // document listener per density re-render that wasn't followed by another density one).
    if (node._outsideClickListener) {
      document.removeEventListener('click', node._outsideClickListener);
      node._outsideClickListener = null;
    }
    const legend = TrackingViewer.getLegendState?.();
    if (!legend || legend.kind === 'uniform') {
      node.classList.add('hidden');
      node.innerHTML = '';
      return;
    }
    if (legend.kind === 'density') {
      node.classList.remove('hidden');
      const activeMap = TrackingViewer.getDensityColormap ? TrackingViewer.getDensityColormap() : 'viridis';
      const maps = TrackingViewer.getDensityColormapNames ? TrackingViewer.getDensityColormapNames() : ['viridis'];
      
      node.innerHTML = `
        <div class="viewer-legend-title">${Utils.escapeHtml(legend.title || 'Local Cell Density')}</div>
        <div class="viewer-legend-gradient" id="legend-gradient-btn" style="cursor:pointer; position:relative;" title="Click to change colormap" data-i18n-title="js.changeColormap">
          ${(legend.stops || []).map(color => `<span style="background:${Utils.escapeHtml(color)}"></span>`).join('')}
        </div>
        <div class="viewer-legend-range">${_fmt(legend.min)} -> ${_fmt(legend.max)} ${Utils.escapeHtml(legend.unit || '')}</div>
        <div id="legend-colormap-menu" style="display:none; position:absolute; bottom:calc(100% + 8px); left:0; width:100%; background:var(--bg-surface); border:1px solid var(--border-subtle); border-radius:var(--radius-md); padding:var(--space-2); box-shadow:var(--shadow-md); z-index:20; max-height:220px; overflow-y:auto; flex-direction:column; gap:4px;">
          <div style="font-size:10px; color:var(--text-muted); padding-left:24px; margin-bottom:4px; text-transform:uppercase; font-weight:600;">Select Colormap</div>
          ${maps.map(n => {
            const stops = TrackingViewer.getDensityColormapStops ? TrackingViewer.getDensityColormapStops(n) : [];
            const isSel = n === activeMap;
            // SEC-021: hover/selection via CSS state (.colormap-option[.selected]) instead
            // of inline onmouseover/onmouseout (CSP hygiene); escape the colormap name and
            // stop colors defensively even though they are internal constants.
            return `
              <div class="colormap-option${isSel ? ' selected' : ''}" data-map="${Utils.escapeHtml(n)}" style="display:flex; align-items:center; gap:8px; padding:6px; cursor:pointer; border-radius:var(--radius-sm);">
                <div style="width:12px; font-size:11px; text-align:center; color:var(--text-primary); font-weight:bold;">${isSel?'✓':''}</div>
                <div style="flex:1; display:flex; height:12px; border-radius:3px; overflow:hidden;">
                  ${stops.map(c => `<span style="flex:1; background:${Utils.escapeHtml(c)};"></span>`).join('')}
                </div>
                <div style="font-size:11px; width:54px; text-transform:capitalize; color:var(--text-secondary);">${Utils.escapeHtml(n)}</div>
              </div>
            `;
          }).join('')}
        </div>
      `;
      
      const btn = node.querySelector('#legend-gradient-btn');
      const menu = node.querySelector('#legend-colormap-menu');
      
      if (btn && menu) {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          menu.style.display = menu.style.display === 'none' ? 'flex' : 'none';
        });
        
        const outsideClickListener = (e) => {
           if (!menu.contains(e.target) && !btn.contains(e.target)) {
              menu.style.display = 'none';
           }
        };
        
        if (node._outsideClickListener) {
           document.removeEventListener('click', node._outsideClickListener);
        }
        document.addEventListener('click', outsideClickListener);
        node._outsideClickListener = outsideClickListener;
        
        menu.querySelectorAll('.colormap-option').forEach(opt => {
          opt.addEventListener('click', (e) => {
            e.stopPropagation();
            if (TrackingViewer.setDensityColormap) {
              TrackingViewer.setDensityColormap(opt.dataset.map);
              menu.style.display = 'none';
              _renderTrackingLegend();
            }
          });
        });
      }
      return;
    }
    if (legend.kind === 'region') {
      node.classList.remove('hidden');
      node.innerHTML = `
        <div class="viewer-legend-title">${Utils.escapeHtml(legend.title || 'Region Colors')}</div>
        <div class="viewer-legend-items">
          ${(legend.items || []).slice(0, 8).map(item => `
            <div class="viewer-legend-item">
              <span class="viewer-legend-swatch" style="background:${Utils.escapeHtml(item.color)}"></span>
              <span>${Utils.escapeHtml(item.label)}</span>
            </div>
          `).join('')}
        </div>
      `;
      return;
    }
    node.classList.add('hidden');
    node.innerHTML = '';
  }

  function _renderLineageTree() {
    const node = document.getElementById('lineage-tree');
    if (!node) return;
    const selected = TrackingViewer.getSelectedCell();
    const id = selected?.id || selected?.track_id;
    if (!id) {
      node.innerHTML = 'Select a cell to inspect lineage.';
      return;
    }
    const lineage = AnalysisStore.lineageForCell(id);
    if (!lineage) {
      node.innerHTML = 'No lineage data for this cell.';
      return;
    }
    const daughters = lineage.daughters || [];
    node.innerHTML = `
      ${_lineageNodeHtml('Parent', lineage.parent)}
      ${_lineageNodeHtml('Cell', lineage)}
      ${daughters.length ? daughters.map((daughter, idx) => _lineageNodeHtml(`Daughter ${idx + 1}`, daughter)).join('') : '<div class="text-xs text-muted">No daughter cell recorded.</div>'}
    `;
  }

  function _lineageNodeHtml(label, item) {
    if (!item) return `<div class="lineage-node"><span>${Utils.escapeHtml(label)}</span><span class="text-muted">None</span></div>`;
    return `
      <div class="lineage-node">
        <span>${Utils.escapeHtml(label)}</span>
        <span><strong>${Utils.escapeHtml(item.trackId || item.id || '--')}</strong><br><small>${Utils.escapeHtml(item.region || 'Unknown')}</small></span>
      </div>
    `;
  }

  function _renderNeighborNetworkPanel() {
    const node = document.getElementById('neighbor-network');
    if (!node) return;
    const selected = TrackingViewer.getSelectedCell();
    if (!selected) {
      node.innerHTML = 'Select a cell to inspect neighbors at the current frame.';
      return;
    }
    const rows = TrackingViewer.getNeighborNetworkRows(10);
    if (!rows.length) {
      node.innerHTML = 'No neighbor inside the current distance threshold.';
      return;
    }
    node.innerHTML = rows.map((row, idx) => `
      <div class="neighbor-row">
        <strong>${idx + 1}. ${Utils.escapeHtml(row.trackId || row.id)}</strong>
        <span>${_fmt(row.distance)} units<br><small>${Utils.escapeHtml(row.region || 'Unknown')}</small></span>
      </div>
    `).join('');
  }

  function _exportNeighborsCsv() {
    const selected = TrackingViewer.getSelectedCell();
    if (!selected) return;
    const rows = [['selected_track', 'timepoint', 'neighbor_track', 'neighbor_id', 'region', 'distance']];
    const selectedId = selected.track_id || selected.id;
    const timepoint = _getTimelineFrame ? _getTimelineFrame() : TrackingViewer.getCurrentTime();
    TrackingViewer.getNeighborNetworkRows(500).forEach(row => {
      rows.push([selectedId, timepoint, row.trackId || row.id, row.id, row.region, row.distance]);
    });
    _downloadText(_csv(rows), `${_safeName(_datasetMeta.name || _datasetId)}_${selectedId}_neighbors.csv`, 'text/csv');
  }

  function _exportLineageJson() {
    const selected = TrackingViewer.getSelectedCell();
    const id = selected?.id || selected?.track_id;
    if (!id) return;
    const payload = {
      version: 1,
      datasetId: _datasetId,
      exportedAt: new Date().toISOString(),
      lineage: AnalysisStore.lineageForCell(id)
    };
    _downloadText(JSON.stringify(payload, null, 2), `${_safeName(_datasetMeta.name || _datasetId)}_${id}_lineage.json`, 'application/json');
  }

  function _getTrackingExports() {
    const hasMeasurements = TrackingViewer.listMeasurements().length > 0;
    return [
      { action: 'tracking-measure-csv', icon: 'ruler', label: 'Measurements CSV', enabled: hasMeasurements, handler: () => _exportTrackingMeasurements('csv') },
      { action: 'tracking-measure-json', icon: 'braces', label: 'Measurements JSON', enabled: hasMeasurements, handler: () => _exportTrackingMeasurements('json') }
    ];
  }

  function _exportTrackingMeasurements(format) {
    const rows = TrackingViewer.listMeasurements();
    if (!rows.length) return;
    const text = format === 'csv' ? MeasurementStore.toCsv(rows) : MeasurementStore.toJson(rows);
    _downloadText(text, `${_safeName(_datasetMeta.name || _datasetId)}_measurements.${format}`, format === 'csv' ? 'text/csv' : 'application/json');
  }

  function _getWorkspaceState() {
    const selected = TrackingViewer.getSelectedCell();
    return {
      ui: {
        presentationMode: document.body.classList.contains('presentation-mode'),
        sidebarHidden: document.querySelector('.viewer-sidebar')?.classList.contains('sidebar-hidden') || false,
        activeTool: typeof ToolManager !== 'undefined' ? ToolManager.current() : 'navigate',
        linkedDataOpen: !document.getElementById('related-panel')?.classList.contains('hidden'),
        graphVisible: document.getElementById('stats-panel')?.classList.contains('visible') || false,
        display: { ..._displayState }
      },
      tracking: {
        camera: TrackingViewer.getCameraState(),
        timepoint: _getTimelineFrame ? _getTimelineFrame() : TrackingViewer.getCurrentTime(),
        selectedCell: selected?.id || selected?.track_id || null,
        graphMetric: document.querySelector('[data-chart-metric].active')?.dataset.chartMetric || 'population',
        graphScale: document.getElementById('btn-chart-scale-log')?.classList.contains('active') ? 'log' : 'linear',
        surfaceOpacity: parseInt(document.getElementById('slider-opacity')?.value || '50', 10) / 100,
        surfaceColorMode: document.getElementById('select-surface-color')?.value || 'uniform',
        smoothing: parseInt(document.getElementById('slider-smooth')?.value || '0', 10),
        measurementMode: document.querySelector('[data-measure-mode].active')?.dataset.measureMode || 'snapshot',
        measurements: TrackingViewer.listMeasurements(),
        velocityFieldVisible: document.getElementById('toggle-velocity-field')?.checked || false,
        neighborNetworkVisible: document.getElementById('toggle-neighbor-network')?.checked || false,
        neighborThreshold: parseFloat(document.getElementById('select-neighbor-threshold')?.value || '55'),
        meshClipSpec: TrackingViewer.getMeshClipSpec?.() || null
      }
    };
  }

  function _applyWorkspaceState(state = {}) {
    const ui = state.ui || {};
    const trackingState = state.tracking && Object.keys(state.tracking).length ? state.tracking : state;

    if (trackingState.camera) TrackingViewer.setCameraState(trackingState.camera);
    if (Number.isFinite(trackingState.timepoint) && _setTimelineFrame) _setTimelineFrame(trackingState.timepoint, false, true);
    if (trackingState.selectedCell) TrackingViewer.selectCell(trackingState.selectedCell);
    if (typeof ui.presentationMode === 'boolean') {
      document.body.classList.toggle('presentation-mode', ui.presentationMode);
      _scheduleViewerResize();
    }
    if (typeof ui.sidebarHidden === 'boolean') {
      document.querySelector('.viewer-sidebar')?.classList.toggle('sidebar-hidden', ui.sidebarHidden);
      _scheduleViewerResize();
    }
    if (ui.display) {
      _displayState = {
        backgroundPreset: ui.display.backgroundPreset || _displayState.backgroundPreset,
        backgroundColor: ui.display.backgroundColor || _displayState.backgroundColor
      };
      const select = document.getElementById('select-background-preset');
      const input = document.getElementById('input-background-color');
      if (select) select.value = _displayState.backgroundPreset;
      if (input) input.value = _displayState.backgroundColor;
      document.getElementById('label-background-custom')?.classList.toggle('hidden', _displayState.backgroundPreset !== 'custom');
      TrackingViewer.applyDisplayState(_displayState);
    }
    if (ui.activeTool && typeof ToolManager !== 'undefined') ToolManager.activate(ui.activeTool);
    if (ui.linkedDataOpen) _focusLinkedDataPanel();
    if (typeof ui.graphVisible === 'boolean') {
      document.getElementById('stats-panel')?.classList.toggle('visible', ui.graphVisible);
    }
    document.querySelectorAll('[data-chart-metric]').forEach(button => {
      button.classList.toggle('active', button.dataset.chartMetric === (trackingState.graphMetric || 'population'));
    });
    ChartStudio.setMetric(trackingState.graphMetric || 'population');
    _setChartScale(trackingState.graphScale || 'linear');
    if (Number.isFinite(trackingState.surfaceOpacity)) {
      const slider = document.getElementById('slider-opacity');
      const label = document.getElementById('val-opacity');
      const value = Math.round(trackingState.surfaceOpacity * 100);
      if (slider) slider.value = value;
      if (label) label.textContent = `${value}%`;
      TrackingViewer.setSurfaceOpacity(trackingState.surfaceOpacity);
    }
    if (trackingState.surfaceColorMode) {
      const select = document.getElementById('select-surface-color');
      const mode = _surfaceColorMode(trackingState.surfaceColorMode);
      if (select) select.value = mode;
      TrackingViewer.setSurfaceColorMode(mode);
      _renderTrackingLegend();
    }
    if (typeof trackingState.velocityFieldVisible === 'boolean') {
      const toggle = document.getElementById('toggle-velocity-field');
      if (toggle) toggle.checked = trackingState.velocityFieldVisible;
      TrackingViewer.setVelocityFieldVisible(trackingState.velocityFieldVisible);
    }
    if (typeof trackingState.neighborNetworkVisible === 'boolean') {
      const toggle = document.getElementById('toggle-neighbor-network');
      if (toggle) toggle.checked = trackingState.neighborNetworkVisible;
      TrackingViewer.setNeighborNetworkVisible(trackingState.neighborNetworkVisible);
    }
    if (trackingState.measurementMode) {
      document.querySelectorAll('[data-measure-mode]').forEach(button => {
        button.classList.toggle('active', button.dataset.measureMode === trackingState.measurementMode);
      });
      TrackingViewer.setMeasurementMode(trackingState.measurementMode);
    }
    if (Array.isArray(trackingState.measurements)) {
      TrackingViewer.setMeasurements(trackingState.measurements);
    }
    if (Number.isFinite(trackingState.neighborThreshold)) {
      const select = document.getElementById('select-neighbor-threshold');
      if (select) select.value = String(trackingState.neighborThreshold);
      TrackingViewer.setNeighborThreshold(trackingState.neighborThreshold);
    }
    if (trackingState.meshClipSpec) {
      TrackingViewer.setMeshClipSpec(trackingState.meshClipSpec);
      const slider = document.getElementById('tracking-clip-position');
      const yaw = document.getElementById('tracking-clip-yaw');
      const pitch = document.getElementById('tracking-clip-pitch');
      if (slider) slider.value = Math.round((trackingState.meshClipSpec.value ?? 1) * 100);
      if (yaw) yaw.value = trackingState.meshClipSpec.yaw ?? 0;
      if (pitch) pitch.value = trackingState.meshClipSpec.pitch ?? 0;
      document.getElementById('tracking-clip-pos-label').textContent = `${Math.round((trackingState.meshClipSpec.value ?? 1) * 100)}%`;
      document.querySelectorAll('[data-clip-mode]').forEach(button => {
        button.classList.toggle('active', button.dataset.clipMode === (trackingState.meshClipSpec.mode || 'xy'));
      });
    }
    _updateChartTitle(trackingState.graphMetric || document.querySelector('[data-chart-metric].active')?.dataset.chartMetric || 'population');
    ChartStudio.render();
    _renderTrackingSciencePanels();
    _renderTrackingMeasurement(TrackingViewer.getMeasurement());
  }

  function _trackingAnalysisOptions() {
    return {
      useStabilized: Boolean(document.getElementById('toggle-stabilized')?.checked),
      neighborThreshold: parseFloat(document.getElementById('select-neighbor-threshold')?.value || '55')
    };
  }

  function _surfaceColorMode(mode) {
    return ['uniform', 'density', 'region'].includes(mode) ? mode : 'uniform';
  }

  function _setChartScale(scale) {
    const next = scale === 'log' ? 'log' : 'linear';
    document.getElementById('btn-chart-scale-linear')?.classList.toggle('active', next === 'linear');
    document.getElementById('btn-chart-scale-log')?.classList.toggle('active', next === 'log');
    ChartStudio.setScale(next);
  }

  function _updateChartTitle(metric) {
    const node = document.getElementById('stats-title');
    if (!node) return;
    const labels = {
      population: 'Population Metrics',
      velocity: 'Velocity Metrics',
      neighbors: 'Neighbor Metrics',
      mitoses: 'Mitosis Metrics'
    };
    node.innerHTML = `<i data-lucide="pie-chart" class="w-4 h-4"></i> ${Utils.escapeHtml(labels[metric] || 'Population Metrics')}`;
    if (window.lucide) lucide.createIcons({ root: node });
  }

  function _fmt(value) {
    return Number.isFinite(value) ? value.toFixed(value >= 10 ? 1 : 2) : '--';
  }

  function _downloadText(text, filename, mime) {
    const blob = new Blob([text], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 500);
  }

  function _csv(rows) {
    return rows.map(row => row.map(value => `"${String(value ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
  }

  function _safeName(value) {
    return String(value || 'export').replace(/[^a-z0-9._-]+/gi, '_').replace(/^_+|_+$/g, '');
  }

  function _updateThemeIcon() {
    const btn = document.getElementById('theme-toggle');
    if (!btn) return;
    const icon = Theme.isDark() ? 'moon' : 'sun';
    btn.innerHTML = `<i data-lucide="${icon}" data-theme-icon></i>`;
    if (window.lucide) lucide.createIcons({ root: btn });
  }

  function _renderRelatedDatasets() {
    const panel = document.getElementById('related-panel');
    const list = document.getElementById('related-datasets');
    if (!panel || !list) return;

    const related = Catalog.getRelated(_datasetId);
    if (!related.length) {
      panel.classList.add('hidden');
      list.innerHTML = '';
      return;
    }

    panel.classList.remove('hidden');
    list.innerHTML = related.map(_relatedLinkHtmlV2).join('');
    list.innerHTML = list.innerHTML.replace(/\u00c2\u00b7/g, '-');
    if (window.lucide) lucide.createIcons({ root: list });
  }

  function _relatedLinkHtml(dataset) {
    const page = dataset.type === 'tracking' ? 'tracking.html' : 'viewer.html';
    const href = _relatedHref(page, dataset.id);
    const type = Utils.escapeHtml(dataset.type || 'data');
    const stage = Utils.escapeHtml(Utils.formatStage(dataset.stage));
    const date = Utils.escapeHtml(Utils.formatDate(dataset.date));
    const name = Utils.escapeHtml(dataset.name || dataset.id);
    return `
      <a class="related-link" href="${href}" title="${window.I18n ? window.I18n.t('js.open') : 'Open'} ${name}">
        <span class="related-type ${type}">${type}</span>
        <span class="related-link-title">
          <span class="related-link-name">${name}</span>
          <span class="related-link-meta">${stage} · ${date}</span>
        </span>
        <i data-lucide="arrow-right" style="width:16px;height:16px"></i>
      </a>
    `;
  }

  function _relatedLinkHtmlV2(dataset) {
    const page = dataset.type === 'tracking' ? 'tracking.html' : 'viewer.html';
    const href = _relatedHref(page, dataset.id);
    const compareHref = `compare.html?add=${encodeURIComponent(_datasetId)}&add=${encodeURIComponent(dataset.id)}`;
    const type = Utils.escapeHtml(dataset.type || 'data');
    const stage = Utils.escapeHtml(Utils.formatStage(dataset.stage));
    const date = Utils.escapeHtml(Utils.formatDate(dataset.date));
    const name = Utils.escapeHtml(dataset.name || dataset.id);
    const relation = Catalog.getRelationMeta?.(_datasetId, dataset.id);
    const relationLabel = Utils.escapeHtml(relation?.label || 'Related dataset');
    const relationInfo = Utils.escapeHtml(relation?.description || 'Related by catalog metadata.');
    const qc = relation?.qcSummary?.medianRmsAfter;
    const qcText = Number.isFinite(qc)
      ? `QC median RMS ${qc.toFixed(3)}`
      : (relation?.calibrationAvailable ? 'Calibration available' : 'Calibration metadata not available');
    return `
      <div class="related-link">
        <span class="related-type ${type}">${type}</span>
        <span class="related-link-title">
          <span class="related-link-name">${name}</span>
          <span class="related-link-meta">${stage} · ${date}</span>
          <span class="related-link-meta">${relationLabel} · ${Utils.escapeHtml(qcText)}</span>
          <span class="related-link-meta">${relationInfo}</span>
        </span>
        <span class="related-actions">
          <a class="btn btn-outline btn-sm" href="${href}" title="${window.I18n ? window.I18n.t('js.open') : 'Open'} ${name}">Open</a>
          <a class="btn btn-outline btn-sm" href="${compareHref}" title="${window.I18n ? window.I18n.t('js.compareWith') : 'Compare with'} ${name}">Compare</a>
        </span>
      </div>
    `;
  }

  function _relatedHref(page, id) {
    const params = new URLSearchParams({ id });
    if (_isIframe) {
      params.set('hideHeader', 'true');
      if (_panelIndex !== null) params.set('panelIndex', _panelIndex);
    }
    return `${page}?${params.toString()}`;
  }

  function _focusLinkedDataPanel() {
    const sidebar = document.querySelector('.viewer-sidebar');
    const panel = document.getElementById('related-panel');
    if (!sidebar || !panel) return;
    sidebar.classList.remove('sidebar-hidden');
    panel.classList.remove('hidden');
    panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    _scheduleViewerResize();
  }

  function _showError(msg) {
    const loader = document.getElementById('viewer-loader');
    if (loader) {
      const message = Utils.escapeHtml(msg);
      loader.innerHTML = `
        <i data-lucide="alert-triangle" style="width:48px;height:48px;margin-bottom:16px;color:var(--color-error)"></i>
        <h3>Error</h3>
        <p style="color:var(--text-muted);margin-top:8px">${message}</p>
        <a href="explorer.html" class="btn btn-primary" style="margin-top:16px">Return to Explorer</a>
      `;
      if (window.lucide) lucide.createIcons();
    }
  }

  function _bindIframeSync(panelIndex) {
    // We listen for SYNC_TIME
    window.addEventListener('message', (e) => {
      const data = e.data;
      if (!data || !data.type || data.sourceIndex === panelIndex) return;

      if (data.type === 'SYNC_TIME') {
        if (_setTimelineFrame) {
          _setTimelineFrame(data.value, false, false);
        } else {
          TrackingViewer.setTimepoint(data.value);
        }
      }
      if (data.type === 'SYNC_CAMERA') {
        TrackingViewer.setCameraState(data.value);
      }
      if (data.type === 'TOGGLE_SIDEBAR') {
        const sidebar = document.querySelector('.viewer-sidebar');
        if (data.value === true) {
          sidebar.classList.remove('sidebar-hidden');
        } else {
          sidebar.classList.add('sidebar-hidden');
        }
        _scheduleViewerResize();
      } else if (data.type === 'REQUEST_SCREENSHOT') {
        try {
          const canvas = TrackingViewer.getRenderer()?.domElement;
          if (!canvas) {
            window.parent.postMessage({ type: 'SCREENSHOT_RESPONSE', success: false, error: 'No active canvas found' }, '*');
            return;
          }
          const size = 512;
          const thumbCanvas = document.createElement('canvas');
          thumbCanvas.width = size;
          thumbCanvas.height = size;
          const ctx = thumbCanvas.getContext('2d');
          ctx.fillStyle = '#080a12';
          ctx.fillRect(0, 0, size, size);
          
          const sWidth = canvas.width;
          const sHeight = canvas.height;
          const scale = Math.min(size / sWidth, size / sHeight);
          const dWidth = sWidth * scale;
          const dHeight = sHeight * scale;
          const dx = (size - dWidth) / 2;
          const dy = (size - dHeight) / 2;
          
          ctx.drawImage(canvas, dx, dy, dWidth, dHeight);
          const dataUrl = thumbCanvas.toDataURL('image/webp', 0.9);
          window.parent.postMessage({ type: 'SCREENSHOT_RESPONSE', success: true, dataUrl }, '*');
        } catch (err) {
          window.parent.postMessage({ type: 'SCREENSHOT_RESPONSE', success: false, error: err.message }, '*');
        }
      }
    });
  }

  function _scheduleViewerResize() {
    [0, 80, 180, 340].forEach(delay => {
      setTimeout(() => {
        TrackingViewer.resize();
        window.dispatchEvent(new Event('resize'));
      }, delay);
    });
  }

  async function _getFigureBlob(options = {}) {
    const canvas = TrackingViewer.getRenderer()?.domElement;
    if (!canvas) return null;
    return await new Promise(resolve => canvas.toBlob(resolve, options.mime || 'image/png', options.quality || 0.95));
  }

  return { init };
})();

document.addEventListener('DOMContentLoaded', TrackingApp.init);
