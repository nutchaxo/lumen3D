/* ============================================================
   IRIBHM Microscopy Platform — Viewer Controller
   ============================================================ */

const ViewerApp = (() => {
  let datasetId;
  let datasetMeta;
  let isLive = false;
  
  // Data cache for LiveImaging buffer
  // We don't implement full buffering here due to browser limits,
  // but we load timepoints on demand and cache them.
  let loadedTimepoints = new Set();
  let _loadedQualities = new Set();

  let _isIframe = false;
  let _panelIndex = null;
  let _basePath = '';
  let _currentTimepoint = null;
  let _qualityMode = '512x512';
  let _activeLoadToken = 0;
  let _zDisplayScale = 1.0;
  let _preloadTimer = null;
  let _preloadedTimepoints = new Set();
  let _qualityProgressUnsub = null;
  let _brickManifest = null;
  let _volumeMeasurements = [];
  let _isInitialized = false;
  let _pendingWorkspaceState = null;
  let _pendingZstackState = null; // buffered TOGGLE_ZSTACK arriving before init()
  let _volumeMeasureDraft = [];
  let _channelState = [];
  let _slicePreviewTimer = null;
  let _nativeSliceAbort = null;
  let _displayState = { backgroundPreset: 'dark', backgroundColor: '#000000' };
  let _volumeSourcePreference = 'webstack';

  function _perf() {
    return typeof PerfTelemetry !== 'undefined' ? PerfTelemetry : null;
  }

  async function init() {
    const initPerfId = _perf()?.start('viewer.init');
    // 1. Init core
    Theme.init();
    await I18n.init();
    await Catalog.load();

    if (window.lucide) lucide.createIcons();
    _updateThemeIcon();
    Theme.onChange(_updateThemeIcon);

    // 2. Read dataset ID and iframe params
    const params = new URLSearchParams(window.location.search);
    datasetId = params.get('id');
    _isIframe = params.get('hideHeader') === 'true';
    _panelIndex = params.get('panelIndex');
    const requestedQuality = _normalizeQualityParam(params.get('quality'));
    if (requestedQuality) _qualityMode = requestedQuality;

    const isAdmin = params.get('mode') === 'admin';

    if (_isIframe) {
      document.body.classList.add('viewer-iframe');
      document.querySelector('.viewer-header').style.display = 'none';
      if (!isAdmin) {
        document.querySelector('.viewer-sidebar').classList.add('sidebar-hidden');
        document.addEventListener('click', (e) => {
          const sidebar = document.querySelector('.viewer-sidebar');
          if (sidebar && !sidebar.classList.contains('sidebar-hidden') && !e.target.closest('.viewer-sidebar')) {
            sidebar.classList.add('sidebar-hidden');
            // SEC-012: restrict targetOrigin to this page's origin (no wildcard leak).
            window.parent.postMessage({ type: 'SIDEBAR_CLOSED', sourceIndex: _panelIndex }, Utils.trustedTargetOrigin());
          }
        });
      }
    }
    
    if (!datasetId) {
      _perf()?.end(initPerfId, { status: 'missing-dataset-id' });
      _showLoadingError({ message: I18n.t('viewer.errNoDataset') });
      if (!_isIframe) setTimeout(() => { window.location.href = 'explorer.html'; }, 1400);
      return;
    }

    datasetMeta = Catalog.getById(datasetId);
    
    const fallbackPath = params.get('path');
    if (!datasetMeta && isAdmin && datasetId && fallbackPath) {
      datasetMeta = {
        id: datasetId,
        path: fallbackPath,
        name: datasetId,
        type: fallbackPath.split('/')[0] || 'fixed',
        volumeSources: []
      };
    }

    if (!datasetMeta) {
      _perf()?.end(initPerfId, { status: 'dataset-not-found', datasetId });
      _showLoadingError({ message: I18n.t('viewer.errNotFound') });
      if (!_isIframe) setTimeout(() => { window.location.href = 'explorer.html'; }, 1400);
      return;
    }
    try {
      await _mergeDatasetMetadata();
    } catch (err) {
      _perf()?.end(initPerfId, { status: 'invalid-metadata', datasetId });
      _showLoadingError(err);
      if (!_isIframe) setTimeout(() => { window.location.href = 'explorer.html'; }, 1400);
      return;
    }
    if (!datasetMeta.volumeSources) datasetMeta.volumeSources = [];

    if (datasetMeta.volumeSources.length === 0 && typeof VolumeSourceManager !== 'undefined') {
      datasetMeta.volumeSources = VolumeSourceManager.normalizeSources(datasetMeta);
    }

    // DeepZoom toggle visibility is now declarative: the deepzoom-2d plugin.json
    // declares requires:['deepzoom2d'], and PluginRegistry.buildToolbarButtons()
    // hides the button unless the dataset offers that source.

    _zDisplayScale = _loadZDisplayScale();
    _volumeMeasurements = MeasurementStore.list(datasetId, 'viewer');
    
    isLive = datasetMeta.type === 'live';
    _perf()?.setContext({
      scope: 'viewer',
      datasetId,
      datasetName: datasetMeta?.name || null,
      datasetType: datasetMeta?.type || null,
      dimensions: datasetMeta?.dimensions || null
    });
    _perf()?.event('viewer.dataset.ready', {
      datasetId,
      datasetType: datasetMeta?.type || null,
      qualityMode: _qualityMode
    });
    document.title = `${datasetMeta.name} - IRIBHM Microscopy`;

    // Update UI Header
    document.getElementById('dataset-title').textContent = datasetMeta.name;
    document.getElementById('dataset-subtitle').textContent =
      `${I18n.t(`explorer.${datasetMeta.type}`)} - ${Utils.formatStage(datasetMeta.stage)} - ${Utils.formatDate(datasetMeta.date)}`;
    if (typeof AnnotationManager !== 'undefined') AnnotationManager.init({ items: [] });

    if (isLive) {
      document.getElementById('timeline-panel').classList.remove('hidden');
    }

    // ── Auto-discover & pre-load plugin modules ───────────────
    // No hardcoded manifest: discover() resolves the folder list (live endpoint
    // → generated manifest → embedded default). MUST stay fully awaited here,
    // before any UI build (tools/shaders/channels lists) — the v0.12.45 invariant.
    if (typeof PluginRegistry !== 'undefined') {
      const modulePaths = await PluginRegistry.discover('js/modules');
      await PluginRegistry.loadModules('js/modules', modulePaths);
      // Generate toolbar buttons from the loaded plugins' metadata. Runs before
      // ToolManager.init (_bindTooling) so the data-tool chips exist to be wired,
      // and before bindToolbarButtons() (after initAll) wires the data-plugin-id ones.
      PluginRegistry.buildToolbarButtons({
        dataset: datasetMeta,
        groups: [
          { group: 'tools',   container: '[data-tool-group="tools"]' },
          { group: 'export',  container: '[data-tool-group="export"]' },
          { group: 'visuals', container: '[data-tool-group="visuals"]' },
          { group: 'layouts', container: '[data-tool-group="layouts"]' }
        ]
      });
    }

    // Initialize WebGL Viewer
    VolumeViewer.init('webgl-canvas');
    _qualityProgressUnsub?.();
    _qualityProgressUnsub = VolumeViewer.onQualityProgress?.(_handleQualityProgress) || null;
    // ELE-18 (EDGE-001): surface a visible status on GPU context loss/restore (Rule 1.1).
    VolumeViewer.onContextLost?.(() => _setQualityStatus('Contexte GPU perdu — rendu en pause. Rechargez la page si l\'image ne revient pas.'));
    VolumeViewer.onContextRestored?.(() => _setQualityStatus('Contexte GPU restauré — rechargez le volume pour réafficher.'));
    VolumeViewer.setZDisplayScale(_zDisplayScale, { notify: false });
    VolumeViewer.setMeasurements(_volumeMeasurements);
    if (_isIframe || true) { // Always bind onCameraChange now
      VolumeViewer.onCameraChange((state) => {
        // Never broadcast camera changes when z-stack is active:
        // _zstackShow() forces setView('xy') which would corrupt other panels' cameras.
        if (_isIframe && !_zstackActive) {
          // SEC-012: restrict targetOrigin to this page's origin (no wildcard leak).
          window.parent.postMessage({ type: 'SYNC_CAMERA', value: state, sourceIndex: _panelIndex }, Utils.trustedTargetOrigin());
        }
      });
      // Broadcast full slicer plane spec to sibling decompose panels on every change.
      // Uses onPlaneSpecChange which fires for all plane mutations (position, yaw, pitch, roll, slab, mode).
      VolumeViewer.onPlaneSpecChange?.((spec) => {
        if (_suppressSlicerSync || _zstackActive) return;
        // SEC-012: restrict targetOrigin to this page's origin (no wildcard leak).
        window.parent.postMessage({
          type: 'SYNC_SLICER_SPEC',
          spec,
          sourceIndex: _panelIndex
        }, Utils.trustedTargetOrigin());
      });
    }
    
    // Bind UI controls
    _bindScreenshot();
    _bindQualityControls();
    _updateQualityOptionLabels();
    _bindVolumeControls();
    _bindZScaleControls();
    _bindDisplayControls();
    _bindVisualControls();
    _bindTooling();
    _bindExportAndWorkspace();
    // deepzoom-2d, slice-inspector, and zstack-browser modules
    // self-initialize in PluginRegistry.initAll() below — no explicit bind calls needed.
    _bindHamburgerMenu();
    _bindSidebarCollapse();
    if (_isIframe) _bindIframeSync();
    // Initialize Channel Panel
    ChannelPanel.init('channel-container', datasetMeta, (idx, params) => {
      _channelState[idx] = { ...params };
      VolumeViewer.updateChannel(idx, params);
      window.dispatchEvent(new CustomEvent('channels-updated'));
      if (_isIframe) {
        // SEC-012: restrict targetOrigin to this page's origin (no wildcard leak).
        window.parent.postMessage({ type: 'SYNC_CHANNELS', sourceIndex: _panelIndex, channelIndex: idx, value: params }, Utils.trustedTargetOrigin());
      }
    });

    // Load Data
    const datasetPath = datasetMeta.path || datasetMeta.id;
    const basePath = `DATA_WEB/${datasetPath}`;
    _basePath = basePath;

    // Si un état caméra sera restauré après le chargement (URL hash ou iframe pending),
    // signaler au VolumeViewer de ne PAS appeler fitCameraToVolume lors du premier load.
    // Autrement, le preview changerait le cameraZ avant la restauration de l'état sauvé,
    // et la différence de scale preview/high causerait un décalage → écran noir.
    const hasPendingCameraState = (window.location.hash && window.location.hash.startsWith('#state='))
      || (_pendingWorkspaceState && _pendingWorkspaceState?.viewer?.camera);
    if (hasPendingCameraState && VolumeViewer.setHasLoadedVolume) {
      VolumeViewer.setHasLoadedVolume(true);
      console.log('[ViewerApp] Pre-set _hasLoadedVolume=true to skip fitCameraToVolume (state will be restored)');
    }

    try {
      if (isLive) {
        // BUG-032 (Rule 1.4): a malformed live dataset may lack dimensions.t (or
        // dimensions entirely) -> reject explicitly instead of throwing a raw
        // TypeError on property access.
        const totalFrames = datasetMeta.dimensions?.t;
        if (!Number.isFinite(totalFrames) || totalFrames <= 0) {
          throw new Error('dataset live sans dimensions.t');
        }
        Timeline.init('timeline-panel', {
          totalFrames: totalFrames,
          showSpeed: false,
          showSmooth: false,
          stepped: false
        }, (state) => {
          _loadTimepoint(basePath, state.frame).catch(_showLoadingError);
        });
        // Load first frame
        await _loadTimepoint(basePath, 0);
      } else {
        // Load single volume
        await _loadTimepoint(basePath, null);
      }
    } catch (err) {
      _perf()?.event('viewer.init.error', { message: err?.message || String(err) });
      _showLoadingError(err);
    }
    _renderVolumeMeasurement();
    if (window.lucide) lucide.createIcons();
    _perf()?.end(initPerfId, { status: 'ok', isLive, qualityMode: _qualityMode });

    if (window.location.hash && window.location.hash.startsWith('#state=')) {
      if (typeof UrlState !== 'undefined') {
        const urlState = await UrlState.decodeState(window.location.hash);
        if (urlState) {
          _applyWorkspaceStateNow(urlState.state || urlState);
        }
      }
    }
    if (_pendingWorkspaceState) {
      console.log('[ViewerApp] Applying pending workspace state after init, camera:', _pendingWorkspaceState?.viewer?.camera?.cameraZ, 'measurements:', _pendingWorkspaceState?.viewer?.measurements?.length);
      _applyWorkspaceStateNow(_pendingWorkspaceState);
      _pendingWorkspaceState = null;
    }

    // Apply buffered TOGGLE_ZSTACK that arrived before init() completed
    if (_pendingZstackState !== null) {
      _applyZstackState(_pendingZstackState.desired, _pendingZstackState.slice);
      _pendingZstackState = null;
    }

    // ── Module System Integration ──────────────────────────────
    if (typeof PluginRegistry !== 'undefined') {
      // Build the ViewerContext façade for module implementations
      const moduleCtx = {
        dataset: {
          getMeta: () => datasetMeta,
          getId: () => datasetId,
          getBasePath: () => _basePath
        },
        viewer: {
          getRenderer: () => VolumeViewer.getRenderer(),
          getMaterial: () => VolumeViewer.getMaterial(),
          getScene: () => VolumeViewer.getScene(),
          getCamera: () => VolumeViewer.getCamera(),
          setRenderMode: (m) => VolumeViewer.setRenderMode(m),
          setClipRange: (...args) => VolumeViewer.setClipRange(...args),
          setClipRange_z: (lo, hi) => VolumeViewer.setClipRange('z', lo, hi),
          resetClipping: () => VolumeViewer.resetClipping(),
          setGridMode: (m) => VolumeViewer.setGridMode(m),
          setAxesVisible: (v) => VolumeViewer.setAxesVisible(v),
          setVolumeVisible: (v) => VolumeViewer.setVolumeVisible(v),
          setView: (v) => VolumeViewer.setView(v),
          setRotationLocked: (v) => VolumeViewer.setRotationLocked(v),
          resize: () => VolumeViewer.resize(),
          setCutPlaneVisible: (v) => VolumeViewer.setCutPlaneVisible(v),
          setMeasurements: (m) => VolumeViewer.setMeasurements(m),
          onMeasurePoint: (cb) => VolumeViewer.onMeasurePoint(cb),
          onPlaneSpecChange: (cb) => VolumeViewer.onPlaneSpecChange(cb),
          getPhysicalCalibration: () => VolumeViewer.getPhysicalCalibration?.()
        },
        slicer: {
          init: (opts) => typeof VolumeSlicer !== 'undefined' ? VolumeSlicer.init(opts) : null,
          setVisible: (v) => typeof VolumeSlicer !== 'undefined' ? VolumeSlicer.setVisible(v) : null,
          isVisible: () => typeof VolumeSlicer !== 'undefined' ? VolumeSlicer.isVisible() : false,
          setPlaneSpec: (s) => typeof VolumeSlicer !== 'undefined' ? VolumeSlicer.setPlaneSpec(s) : null,
          getPlaneSpec: () => typeof VolumeSlicer !== 'undefined' ? VolumeSlicer.getPlaneSpec() : {},
          getPreviewCanvas: () => typeof VolumeSlicer !== 'undefined' ? VolumeSlicer.getPreviewCanvas() : null,
          updateMaterial: (m) => typeof VolumeSlicer !== 'undefined' ? VolumeSlicer.updateMaterial(m) : null
        },
        channels: {
          getState: () => ChannelPanel.getState?.() || _channelState,
          setState: (s, opts) => ChannelPanel.setState?.(s, opts)
        },
        measurements: {
          list: (scope) => MeasurementStore.list(datasetId, scope || 'viewer'),
          add: (scope, data) => MeasurementStore.add(datasetId, scope || 'viewer', data),
          update: (scope, id, patch) => MeasurementStore.update(datasetId, scope || 'viewer', id, patch),
          remove: (scope, id) => MeasurementStore.remove(datasetId, scope || 'viewer', id),
          clear: (scope) => MeasurementStore.clear(datasetId, scope || 'viewer'),
          setAll: (scope, arr) => MeasurementStore.setAll(datasetId, scope || 'viewer', arr)
        },
        ui: {
          toast: (msg) => { if (typeof ExportManager !== 'undefined') ExportManager.toast(msg); },
          scheduleResize: () => _scheduleViewerResize(),
          escapeHtml: (s) => typeof Utils !== 'undefined' ? Utils.escapeHtml(s) : s,
          createIcons: (opts) => { if (window.lucide) lucide.createIcons(opts); },
          openStudio: () => openStudio(),
          perf: () => _perf()
        },
        iframe: {
          isIframe: () => _isIframe,
          panelIndex: () => _panelIndex,
          // SEC-012: restrict targetOrigin to this page's origin (no wildcard leak).
          postMessage: (data) => window.parent.postMessage(data, Utils.trustedTargetOrigin())
        },
        workspace: {
          getState: _getWorkspaceState,
          applyState: _applyWorkspaceState
        },
        getCanvasBlob: _getFigureBlob,
        getCustomExports: _getSliceExports,
        // Shared mutable state (modules write via setters, not direct assignment)
        _state: {
          get zstackActive() { return _zstackActive; },
          set zstackActive(v) { _zstackActive = v; },
          get zstackCurrentSlice() { return _zstackCurrentSlice; },
          set zstackCurrentSlice(v) { _zstackCurrentSlice = v; },
          get suppressZstackSync() { return _suppressZstackSync; },
          set suppressZstackSync(v) { _suppressZstackSync = v; },
          get suppressSlicerSync() { return _suppressSlicerSync; },
          set suppressSlicerSync(v) { _suppressSlicerSync = v; },
          get currentTimepoint() { return _currentTimepoint; }
        }
      };

      // Initialize all loaded modules with the context
      await PluginRegistry.initAll(moduleCtx);
      PluginRegistry.bindToolbarButtons();

      const toolsCount = PluginRegistry.listByPlacement('tools').length;

      const shadersCount = PluginRegistry.listByPlacement('shaders').length;
      console.log(`[ViewerApp] PluginRegistry initialized — ${toolsCount} tools, ${shadersCount} shaders`);
    }
    
    _isInitialized = true;
    
    if (!_isIframe && typeof UrlState !== 'undefined') {
      UrlState.startSync(_getWorkspaceState, 1000);
    }
  }
  
  function _updateThemeIcon() {
    const btn = document.getElementById('theme-toggle');
    if (!btn) return;
    const icon = Theme.isDark() ? 'moon' : 'sun';
    btn.innerHTML = `<i data-lucide="${icon}" data-theme-icon></i>`;
    if (window.lucide) lucide.createIcons({ nodes: [btn] });
  }

  function _bindScreenshot() {
    // Screenshot is now handled by the 'screenshot' plugin via PluginRegistry.
    // The btn-screenshot button has data-plugin-id="screenshot" in the HTML.
    // No legacy binding needed.
  }

  function _bindHamburgerMenu() {
    const btn = document.getElementById('btn-hamburger');
    const toolbar = document.getElementById('viewer-toolbar');
    const header = document.querySelector('.viewer-header');
    if (!btn || !toolbar || !header) return;

    // ── Toggle handler ────────────────────────────────────────
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      toolbar.classList.toggle('menu-open');
    });

    document.addEventListener('click', (e) => {
      if (
        toolbar.classList.contains('menu-open') &&
        !e.target.closest('#viewer-toolbar') &&
        !e.target.closest('#btn-hamburger')
      ) {
        toolbar.classList.remove('menu-open');
      }
    });

    // Close menu when clicking any button or link inside the menu
    toolbar.addEventListener('click', (e) => {
      if (e.target.closest('.btn') || e.target.closest('a')) {
        toolbar.classList.remove('menu-open');
      }
    });

    // ── ResizeObserver: detect toolbar wrapping ───────────────
    // Strategy: temporarily un-collapse (if currently collapsed) so we can
    // measure the natural single-row height, then compare.
    //
    // Simpler, reliable approach: measure the toolbar's scrollHeight vs
    // its offsetHeight. But since the toolbar is positioned absolute when
    // collapsed, we instead probe the header's clientHeight against the
    // single-row height (56px + 2×padding-y = 56px reported by min-height).
    //
    // Algorithm:
    //  1. Remove .toolbar-collapsed temporarily so the toolbar is inline.
    //  2. Read header.scrollHeight to get its natural (unwrapped) height.
    //     - If natural height > 56px → toolbar has wrapped → collapse.
    //     - If natural height <= 56px → single row → expand.
    //  3. Re-apply class as needed.
    //
    // The 56px value comes from .viewer-header min-height. We use
    // `header.clientHeight` while collapsed is OFF to detect wrap.

    // Single-row reference: header min-height without overflow.
    // We read it once from CSS: 56px (hardcoded to match the CSS min-height).
    const SINGLE_ROW_H = 56; // px — matches .viewer-header { min-height: 56px }

    let _rafPending = false;

    function _checkWrap() {
      if (_rafPending) return;
      _rafPending = true;
      requestAnimationFrame(() => {
        _rafPending = false;

        // Temporarily remove collapse so toolbar is inline and can affect layout
        const wasCollapsed = header.classList.contains('toolbar-collapsed');
        if (wasCollapsed) header.classList.remove('toolbar-collapsed');

        // Let the browser compute layout in the current RAF,
        // read the natural height with the toolbar inline
        const naturalH = header.getBoundingClientRect().height;

        // Restore previous state before deciding what the new state should be
        if (wasCollapsed) header.classList.add('toolbar-collapsed');

        const shouldCollapse = naturalH > SINGLE_ROW_H + 4; // +4px tolerance

        if (shouldCollapse && !header.classList.contains('toolbar-collapsed')) {
          header.classList.add('toolbar-collapsed');
          toolbar.classList.remove('menu-open'); // close dropdown on collapse
        } else if (!shouldCollapse && header.classList.contains('toolbar-collapsed')) {
          header.classList.remove('toolbar-collapsed');
          toolbar.classList.remove('menu-open');
        }
      });
    }

    const ro = new ResizeObserver(() => _checkWrap());
    ro.observe(header);

    // Initial check
    _checkWrap();
  }

  function _bindSidebarCollapse() {
    const sidebar   = document.getElementById('viewer-sidebar');
    const btnClose  = document.getElementById('btn-collapse-sidebar');
    const btnReopen = document.getElementById('btn-reopen-sidebar');
    if (!sidebar || !btnClose || !btnReopen) return;

    /**
     * Collapse the sidebar:
     *  - adds .sidebar-hidden (CSS animates width → 0 + opacity → 0)
     *  - shows the floating reopen button on the canvas edge
     */
    function _collapse() {
      sidebar.classList.add('sidebar-hidden');
      btnReopen.style.display = 'flex';
      // Refresh lucide icon in the reopen button after display change
      if (window.lucide) lucide.createIcons();
    }

    /**
     * Expand the sidebar:
     *  - removes .sidebar-hidden (CSS animates width back to 320px)
     *  - hides the floating reopen button
     */
    function _expand() {
      sidebar.classList.remove('sidebar-hidden');
      btnReopen.style.display = 'none';
    }

    btnClose.addEventListener('click',  () => _collapse());
    btnReopen.addEventListener('click', () => _expand());
  }

  // Rule 1.4 — un metadata.json présent doit être structurellement cohérent ; un
  // metadata incohérent est REJETÉ (pas monté partiellement). On ne valide que ce
  // qui est présent : un champ absent reste pris dans le fallback catalogue.
  function _validateDatasetMetadata(meta, expectLive) {
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) {
      return { ok: false, reason: 'racine non-objet' };
    }
    const _posInt = (v) => Number.isFinite(v) && Number.isInteger(v) && v > 0;
    const d = meta.dimensions;
    if (d !== undefined) {
      if (!d || typeof d !== 'object' || Array.isArray(d)) return { ok: false, reason: 'dimensions non-objet' };
      if (!_posInt(d.x) || !_posInt(d.y) || !_posInt(d.z)) return { ok: false, reason: 'dimensions x/y/z invalides' };
      if (d.c !== undefined && !_posInt(d.c)) return { ok: false, reason: 'dimensions.c invalide' };
      if (d.t !== undefined && !_posInt(d.t)) return { ok: false, reason: 'dimensions.t invalide' };
    }
    // Live : le scrubber lit dimensions.t — il doit exister, dans metadata.json OU le
    // catalogue (datasetMeta n'est pas encore fusionné ici, d'où le fallback effectif).
    if (expectLive) {
      const effT = (d && _posInt(d.t)) ? d.t : datasetMeta?.dimensions?.t;
      if (!_posInt(effT)) return { ok: false, reason: 'dataset live sans dimensions.t' };
    }
    if (meta.voxel_size !== undefined) {
      const v = meta.voxel_size;
      if (!v || typeof v !== 'object' || Array.isArray(v)) return { ok: false, reason: 'voxel_size non-objet' };
      const _posNum = (x) => Number.isFinite(x) && x > 0;
      if (!_posNum(v.x) || !_posNum(v.y) || !_posNum(v.z)) return { ok: false, reason: 'voxel_size x/y/z invalides' };
    }
    if (meta.channels !== undefined) {
      if (!Array.isArray(meta.channels) || meta.channels.length === 0) return { ok: false, reason: 'channels non-tableau ou vide' };
      if (meta.channels.some((c) => !c || typeof c !== 'object')) return { ok: false, reason: 'channels contient un élément non-objet' };
      if (d && _posInt(d.c) && meta.channels.length !== d.c) return { ok: false, reason: `channels.length (${meta.channels.length}) != dimensions.c (${d.c})` };
    }
    return { ok: true };
  }

  async function _mergeDatasetMetadata() {
    // BUG-033 (Rule 1.4): metadata.json fetch may fail (no path / non-ok). The
    // catalogue fallback is acceptable ONLY if it already carries dimensions;
    // otherwise downstream calibration would compute on NaN, so abort init with
    // a clear error instead of mounting incomplete metadata.
    const _hasCatalogDims = !!datasetMeta?.dimensions
      && Number.isFinite(datasetMeta.dimensions.x)
      && Number.isFinite(datasetMeta.dimensions.y)
      && Number.isFinite(datasetMeta.dimensions.z);
    const datasetPath = datasetMeta?.path || datasetMeta?.id;
    if (!datasetPath) {
      if (!_hasCatalogDims) throw new Error('metadata.json introuvable et dimensions absentes du catalogue');
      return;
    }
    try {
      const resp = await fetch(`DATA_WEB/${datasetPath}/metadata.json`);
      if (!resp.ok) {
        if (!_hasCatalogDims) throw new Error(`metadata.json inaccessible (HTTP ${resp.status}) et dimensions absentes du catalogue`);
        return;
      }
      const meta = await resp.json();
      const expectLive = datasetMeta?.type === 'live' || meta?.type === 'live';
      const v = _validateDatasetMetadata(meta, expectLive);
      if (!v.ok) throw new Error(`metadata.json invalide : ${v.reason}`);
      datasetMeta = {
        ...datasetMeta,
        ...meta,
        dimensions: meta.dimensions || datasetMeta.dimensions,
        voxel_size: meta.voxel_size || datasetMeta.voxel_size,
        channels: datasetMeta.channels || meta.channels,
        qualities: datasetMeta.qualities || meta.qualities,
        display_defaults: meta.display_defaults || datasetMeta.display_defaults,
      };
      if (typeof VolumeSourceManager !== 'undefined') {
        datasetMeta.volumeSources = VolumeSourceManager.normalizeSources(datasetMeta);
      }
    } catch (err) {
      console.warn('[ViewerApp] Dataset metadata rejected:', err);
      throw err;   // Rule 1.4: propagate so init aborts instead of mounting partial data
    }
  }

  function _bindQualityControls() {
    const select = document.getElementById('select-quality');
    if (!select) return;
    select.addEventListener('change', () => {
      _qualityMode = _normalizeQualityParam(select.value) || '512x512';
      select.value = _qualityMode;
      VolumeViewer.setQualityTarget?.(_qualityMode, _qualityMode);
      if (_basePath) _loadTimepoint(_basePath, _currentTimepoint, { force: true }).catch(_showLoadingError);
    });
  }

  function _updateQualityOptionLabels() {
    const select = document.getElementById('select-quality');
    if (!select) return;
    const current = _normalizeQualityParam(_qualityMode || select.value) || '512x512';
    const _t = (k, def) => { const res = window.I18n ? window.I18n.t(k) : k; return res === k ? def : res; };

    const levels = Array.isArray(_brickManifest?.levels) ? _brickManifest.levels : null;
    
    if (levels && levels.length > 0) {
      select.innerHTML = '';
      levels.forEach((l, idx) => {
        const opt = document.createElement('option');
        const isNative = idx === 0;
        const dims = l.dimensions;
        const maxDim = Math.max(dims.x, dims.y, dims.z);
        // Round to nearest power of 2 for labeling, unless native
        let labelDim = Math.pow(2, Math.round(Math.log2(maxDim)));
        opt.value = isNative ? 'native' : `${labelDim}x${labelDim}`;
        const name = isNative ? _t('viewer.native', 'Native') : `${labelDim}`;
        opt.textContent = `${name} (${dims.x}x${dims.y}x${dims.z})`;
        select.appendChild(opt);
      });
    } else {
      const labels = {
        '256x256':   `256x256${_qualityDimsLabel('256x256')}`,
        '512x512':   `512x512${_qualityDimsLabel('512x512')}`,
        '1024x1024': `1024x1024${_qualityDimsLabel('1024x1024')}`,
        'native':    `${_t('viewer.native', 'Native')}${_qualityDimsLabel('native')}`
      };
      Array.from(select.options).forEach(option => {
        option.textContent = labels[option.value] || option.textContent;
      });
    }

    const options = [...select.options];
    const fallback = options.find(option => option.value === '512x512')
      || options.find(option => option.value === '256x256')
      || options[0];
    select.value = options.some(option => option.value === current) ? current : (fallback?.value || '512x512');
  }

  function _lodForQuality(quality, levelCount, levels = null) {
    const maxIdx = Math.max(0, levelCount - 1);
    if (!quality || quality === 'native') return 0;

    const lodMatch = quality.match(/^lod(\d+)$/);
    if (lodMatch) {
      return Math.min(maxIdx, parseInt(lodMatch[1], 10));
    }

    // Handle resolution keys (e.g. 256x256, 512x512, 1024x1024)
    const match = quality.match(/^(\d+)x\d+$/);
    if (match) {
      const targetSize = parseInt(match[1], 10);
      if (levels && Array.isArray(levels)) {
        let bestLod = 0;
        let minDiff = Infinity;
        for (let i = 0; i < levels.length; i++) {
          const dims = levels[i]?.dimensions;
          if (dims && dims.x && dims.y) {
            const maxDim = Math.max(dims.x, dims.y);
            const diff = Math.abs(maxDim - targetSize);
            if (diff < minDiff) {
              minDiff = diff;
              bestLod = i;
            }
          }
        }
        return bestLod;
      } else {
        // Fallback calculation based on typical levels
        if (targetSize <= 256) return maxIdx;
        if (targetSize <= 512) return Math.min(maxIdx, Math.max(0, maxIdx - 1));
        if (targetSize <= 1024) return Math.min(maxIdx, Math.max(0, maxIdx - 2));
        return 0;
      }
    }

    // Fallbacks for legacy/abstract keys
    if (quality === 'preview' || quality === 'low') return maxIdx;
    if (quality === 'balanced' || quality === 'medium') return Math.min(maxIdx, Math.max(0, maxIdx - 1));
    if (quality === 'high') return Math.min(maxIdx, Math.max(0, maxIdx - 2));
    return 0;
  }

  function _qualityDimsLabel(quality) {
    const dims = _qualityDims(quality);
    return dims ? ` (${dims.x}x${dims.y}x${dims.z})` : '';
  }

  function _qualityDims(quality) {
    const levels = Array.isArray(_brickManifest?.levels) ? _brickManifest.levels : null;
    if (levels?.length) {
      const lod = _lodForQuality(quality, levels.length, levels);
      const dims = levels[lod]?.dimensions;
      if (dims?.x && dims?.y && dims?.z) return dims;
    }
    const dims = datasetMeta?.dimensions;
    if (!dims?.x || !dims?.y || !dims?.z) return null;
    if (quality === 'native') return { x: dims.x, y: dims.y, z: dims.z };
    
    // Fallback dimension calculations
    let targetSize = 256;
    let maxZ = 56;
    if (quality === '256x256' || quality === 'preview') {
      targetSize = 256;
      maxZ = 56;
    } else if (quality === '512x512' || quality === 'balanced') {
      targetSize = 512;
      maxZ = 96;
    } else if (quality === '1024x1024' || quality === 'high') {
      targetSize = 1024;
      maxZ = 192;
    }
    
    const scale = Math.min(1, targetSize / Math.max(dims.x, dims.y));
    const isBricks = datasetMeta?.volumeSources?.some(s => s.kind === 'bricks');
    const finalZ = isBricks ? dims.z : Math.min(dims.z, maxZ);
    return {
      x: Math.max(1, Math.round(dims.x * scale)),
      y: Math.max(1, Math.round(dims.y * scale)),
      z: finalZ
    };
  }

  function _bindVolumeControls() {
    const centerBtn = document.getElementById('btn-center-sample');
    if (centerBtn) {
      centerBtn.addEventListener('click', () => {
        VolumeViewer.centerSample();
      });
    }

    const resetBtn = document.getElementById('btn-reset-view');
    if (resetBtn) {
      resetBtn.addEventListener('click', () => {
        VolumeViewer.resetView({ resetClipping: true });
        if (typeof ToolManager !== 'undefined') ToolManager.activate('navigate');
        _resetClipSliders();
      });
    }
  }

  function _bindZScaleControls() {
    const slider = document.getElementById('slider-z-scale');
    const resetBtn = document.getElementById('btn-reset-z-scale');
    if (!slider) return;

    slider.value = Math.round(_zDisplayScale * 100);
    _updateZScaleLabel();
    _updatePhysicalStatus();

    slider.addEventListener('input', (e) => {
      _zDisplayScale = _clampZDisplayScale(parseInt(e.target.value, 10) / 100);
      slider.value = Math.round(_zDisplayScale * 100);
      VolumeViewer.setZDisplayScale(_zDisplayScale);
      _saveZDisplayScale();
      _updateZScaleLabel();
      _updatePhysicalStatus();
    });

    if (resetBtn) {
      resetBtn.addEventListener('click', () => {
        _zDisplayScale = 1.0;
        slider.value = 100;
        VolumeViewer.setZDisplayScale(_zDisplayScale);
        _saveZDisplayScale();
        _updateZScaleLabel();
        _updatePhysicalStatus();
      });
    }
  }

  function _bindDisplayControls() {
    // --- Render Mode ---
    const renderModeSelect = document.getElementById('select-render-mode');
    if (renderModeSelect) {
      if (typeof PluginRegistry !== 'undefined') {
        const shaders = PluginRegistry.listByPlacement('shaders');
        renderModeSelect.innerHTML = '';
        let defaultId = null;
        shaders.forEach(s => {
          const opt = document.createElement('option');
          opt.value = s.id;
          opt.textContent = s.name;
          if (s.default) defaultId = s.id;
          renderModeSelect.appendChild(opt);
        });
        if (shaders.length > 0) {
          if (!defaultId) defaultId = shaders[0].id;
          renderModeSelect.value = defaultId;
          PluginRegistry.activate(defaultId);
        }
        renderModeSelect.addEventListener('change', () => {
          PluginRegistry.activate(renderModeSelect.value);
        });
      } else {
        renderModeSelect.addEventListener('change', () => {
          VolumeViewer.setRenderMode(parseInt(renderModeSelect.value, 10));
        });
      }
    }

    // --- Exposure slider ---
    const exposureSlider = document.getElementById('slider-exposure');
    const exposureLabel = document.getElementById('val-exposure');
    if (exposureSlider) {
      if (datasetMeta && Number.isFinite(datasetMeta.exposure)) {
        exposureSlider.value = Math.max(20, Math.min(500, Math.round(datasetMeta.exposure * 100)));
      }
      const syncExposure = () => {
        const val = parseInt(exposureSlider.value, 10) / 100;
        if (exposureLabel) exposureLabel.textContent = `${val.toFixed(2)}×`;
        VolumeViewer.setExposure(val);
        if (_isIframe) {
          // DEAD-021: include sourceIndex so compare.js's routing guard can attribute the
          // message; SEC-012: restrict targetOrigin to this page's origin (no wildcard leak).
          window.parent.postMessage({ type: 'SYNC_EXPOSURE', value: val, sourceIndex: _panelIndex }, Utils.trustedTargetOrigin());
        }
      };
      exposureSlider.addEventListener('input', syncExposure);
      syncExposure();
    }

    // --- Background preset ---
    const select = document.getElementById('select-background-preset');
    const customWrap = document.getElementById('label-background-custom');
    const input = document.getElementById('input-background-color');
    if (!select) return;
    const sync = () => {
      customWrap?.classList.toggle('hidden', select.value !== 'custom');
      _displayState.backgroundPreset = select.value;
      if (input) _displayState.backgroundColor = input.value || _displayState.backgroundColor;
      VolumeViewer.setBackgroundPreset(_displayState.backgroundPreset, _displayState.backgroundColor);
    };
    select.addEventListener('change', sync);
    input?.addEventListener('input', sync);
    sync();
    _updateVolumeSourceStatus();
  }

  function _bindVisualControls() {
    // Grid, Axes and Volume Visibility toggles are now handled
    // by their respective plugins via PluginRegistry.
    // Buttons have data-plugin-id attributes in the HTML.
    // Nothing to bind here — plugins self-register and
    // PluginRegistry.bindToolbarButtons() wires them.
  }

  function _bindTooling() {
    if (typeof ToolManager === 'undefined') return;
    const cutPanel = document.getElementById('volume-tools-panel');
    const measurePanel = document.getElementById('volume-measure-panel');

    VolumeViewer.onCutPlaneChange(_updateCutPlaneUi);
    VolumeViewer.onPlaneSpecChange(_handlePlaneSpecChange);
    VolumeViewer.onMeasurePoint(_handleVolumeMeasurePoint);
    ToolManager.init({
      defaultTool: 'navigate',
      onChange: (tool) => {
        // For the 3D viewer, 'slice' maps to 'cut' tool (plane interaction)
        const viewerTool = tool === 'slice' ? 'cut' : tool;
        VolumeViewer.setActiveTool(viewerTool);
        measurePanel?.classList.toggle('visible', tool === 'measure');
        _slicerShow(tool === 'slice');
      }
    });
    VolumeViewer.setActiveTool('navigate');

    document.getElementById('btn-close-volume-measure')?.addEventListener('click', () => {
      ToolManager.activate('navigate');
    });
    document.getElementById('btn-clear-volume-measure')?.addEventListener('click', _clearVolumeMeasurement);
    const measureList = document.getElementById('volume-measure-list');
    if (measureList) {
      measureList.addEventListener('click', _handleVolumeMeasureListClick);
      measureList.addEventListener('change', _handleVolumeMeasureListClick);
      measureList.addEventListener('input', _handleVolumeMeasureListClick);
    }
    
    window.addEventListener('volume-measurement-drag', (e) => {
      if (e.detail?.id && e.detail?.labelOffset) {
         MeasurementStore.update(datasetId, 'viewer', e.detail.id, { labelOffset: e.detail.labelOffset });
         _volumeMeasurements = MeasurementStore.list(datasetId, 'viewer');
      }
    });
    
    const toggle3D = document.getElementById('toggle-measure-3d-labels');
    if (toggle3D) {
      toggle3D.addEventListener('change', (e) => {
        if (typeof VolumeViewer !== 'undefined' && VolumeViewer.setShowMeasurementLabels) {
          VolumeViewer.setShowMeasurementLabels(e.target.checked);
        }
      });
    }

    const sizeSlider = document.getElementById('measure-text-size');
    if (sizeSlider) {
      sizeSlider.addEventListener('input', (e) => {
        if (typeof VolumeViewer !== 'undefined' && VolumeViewer.setMeasurementTextSize) {
          VolumeViewer.setMeasurementTextSize(parseInt(e.target.value, 10));
        }
      });
    }

    document.addEventListener('click', (e) => {
      if (!e.target.closest('[data-volume-measure-action="toggle-color"]') && !e.target.closest('#measure-color-popup-active')) {
        _closeMeasureColorPopup();
      }
    });

    document.getElementById('btn-studio-open')?.addEventListener('click', () => openStudio());
  }

  async function openStudio() {
    if (typeof StudioEditor === 'undefined' && !_isIframe) return;

    if (_isIframe) {
      // SEC-012: restrict targetOrigin to this page's origin (no wildcard leak).
      window.parent.postMessage({ type: 'REQUEST_COMPARE_STUDIO', sourceIndex: _panelIndex }, Utils.trustedTargetOrigin());
      return;
    }

    let sr = null;
    if (typeof VolumeSlicer !== 'undefined' && VolumeSlicer.isVisible?.()) {
      try {
        sr = await _renderNativeSliceForStudio();
      } catch (err) {
        if (err?.name !== 'AbortError') {
          console.warn('[ViewerApp] Native Studio slice failed; falling back to active GPU slice:', err);
          _setSliceStatus('Native HD unavailable; using active volume resolution.');
        }
      }
    }
    if (!sr) sr = getCurrentSliceResult();
    if (sr && typeof StudioEditor !== 'undefined') {
      StudioEditor.open(sr);
    }
  }

  function _drawScaleBar(ctx, canvasWidth, canvasHeight) {
    const physical = VolumeViewer.getPhysicalSize?.();
    if (!physical || !physical.x) return;

    const micronsPerPixel = physical.x / (datasetMeta?.dimensions?.x || canvasWidth);
    const barLengthMicrons = _niceScaleBarLength(canvasWidth * micronsPerPixel * 0.2);
    const barLengthPx = barLengthMicrons / micronsPerPixel;

    const margin = 16;
    const barHeight = 5;
    const x = canvasWidth - margin - barLengthPx;
    const y = canvasHeight - margin - barHeight - 16;

    // Bar background
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fillRect(x - 4, y - 4, barLengthPx + 8, barHeight + 24);

    // Bar
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(x, y, barLengthPx, barHeight);

    // Label
    ctx.font = 'bold 11px Inter, Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = '#ffffff';
    ctx.fillText(`${barLengthMicrons} µm`, x + barLengthPx / 2, y + barHeight + 14);
    ctx.restore();
  }

  function _niceScaleBarLength(approxMicrons) {
    const nice = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000];
    for (const n of nice) {
      if (n >= approxMicrons * 0.6) return n;
    }
    return Math.round(approxMicrons / 100) * 100 || 100;
  }

  function _bindExportAndWorkspace() {
    if (typeof ExportManager === 'undefined') return;
    ExportManager.init({
      dataset: datasetMeta,
      scope: 'viewer',
      getCanvas: () => document.getElementById('webgl-canvas'),
      getCanvasBlob: _getFigureBlob,
      getCustomExports: _getSliceExports,
      getWorkspaceState: _getWorkspaceState,
      applyWorkspaceState: _applyWorkspaceState
    });

    // btn-export (Download Center) is generated by PluginRegistry.buildToolbarButtons()
    // and wired by bindToolbarButtons() → the download-center plugin's activate(), which
    // opens the same modal with identical options (getCanvasBlob/getCustomExports are
    // exposed on the ViewerContext). The old manual addEventListener here double-wired
    // the click (the modal opened twice per press) — removed. Save/Restore/Presentation
    // are likewise handled by their plugins via data-plugin-id.
  }

  function _nudgeCutPlane(delta) {
    const state = VolumeViewer.getPlaneSpec();
    VolumeViewer.setPlaneSpec({ value: state.value + delta, visible: true });
  }

  function _updateCutPlaneUi(state = VolumeViewer.getCutPlaneState()) {

    const label = document.getElementById('cut-plane-position');
    if (label) label.textContent = `${Math.round(state.value * 100)}%`;
    const oblique = document.getElementById('slice-oblique-controls');
    oblique?.classList.add('visible');
  }

  function _setClipUi(axis, value) {
    const pct = Math.round(value * 100);
    const slider = document.getElementById(`slider-${axis}`);
    const label = document.getElementById(`val-${axis}`);
    if (slider) slider.value = pct;
    if (label) label.textContent = `${pct}%`;
  }

  function _handlePlaneSpecChange(spec) {
    const depthSlider = document.getElementById('oblique-depth-slider');
    
    if (depthSlider) depthSlider.value = (spec.value ?? 0.5) - 0.5;

    _updateSliceAngleUi(spec);

  }

  function _updateSliceAngleUi(spec = VolumeViewer.getPlaneSpec()) {
    const readout = document.getElementById('slice-angle-readout');
    if (readout) {
      readout.textContent = `Yaw ${Math.round(spec.yaw || 0)} / Pitch ${Math.round(spec.pitch || 0)} / Roll ${Math.round(spec.roll || 0)}`;
    }
    const handle = document.getElementById('slice-gizmo-handle');
    const rollHandle = document.getElementById('slice-gizmo-roll');
    const centerHandle = document.getElementById('slice-gizmo-center');
    if (handle) {
      const yaw = ((spec.yaw || 0) % 360) * Math.PI / 180;
      const pitch = Math.max(-89, Math.min(89, spec.pitch || 0));
      const radius = 31 * (1 - Math.abs(pitch) / 120);
      handle.style.left = `${44 + Math.sin(yaw) * radius}px`;
      handle.style.top = `${44 - Math.cos(yaw) * radius}px`;
    }
    if (rollHandle) {
      const roll = ((spec.roll || 0) % 360) * Math.PI / 180;
      rollHandle.style.left = `${44 + Math.sin(roll) * 36}px`;
      rollHandle.style.top = `${44 - Math.cos(roll) * 36}px`;
    }
    if (centerHandle) {
      centerHandle.style.top = `${10 + (1 - (spec.value ?? 0.5)) * 68}px`;
    }
  }

  function _cancelNativeSlice(updateStatus = true) {
    if (_nativeSliceAbort) {
      _nativeSliceAbort.abort();
      _nativeSliceAbort = null;
      if (updateStatus) _setSliceStatus('Cancelling native render...');
    }
  }

  function _slicePlaneVectors(spec = {}) {
    if (typeof THREE === 'undefined') return null;
    const yaw = THREE.MathUtils.degToRad(spec.yaw || 0);
    const pitch = THREE.MathUtils.degToRad(spec.pitch || 0);
    const roll = THREE.MathUtils.degToRad(spec.roll || 0);
    let normal;
    let right;
    let up;

    if (spec.mode === 'xz') {
      normal = new THREE.Vector3(0, 1, 0);
      right = new THREE.Vector3(1, 0, 0);
      up = new THREE.Vector3(0, 0, 1);
    } else if (spec.mode === 'yz') {
      normal = new THREE.Vector3(1, 0, 0);
      right = new THREE.Vector3(0, 1, 0);
      up = new THREE.Vector3(0, 0, 1);
    } else if (spec.mode === 'oblique') {
      const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(-pitch, -yaw, roll, 'YXZ'));
      normal = new THREE.Vector3(0, 0, 1).applyQuaternion(q).normalize();
      right = new THREE.Vector3(1, 0, 0).applyQuaternion(q).normalize();
      up = new THREE.Vector3(0, 1, 0).applyQuaternion(q).normalize();
    } else {
      normal = new THREE.Vector3(0, 0, 1);
      right = new THREE.Vector3(1, 0, 0);
      up = new THREE.Vector3(0, 1, 0);
    }

    const origin = normal.clone().multiplyScalar((spec.value ?? 0.5) - 0.5);
    return { origin, normal, right, up };
  }

  function _brickIntersectsSlicePlane(brick, dims, plane, margin) {
    const bs = dims.brickSize || 64;
    const ox = brick.bx * bs;
    const oy = brick.by * bs;
    const oz = brick.bz * bs;
    const bw = Math.min(bs, dims.x - ox);
    const bh = Math.min(bs, dims.y - oy);
    const bd = Math.min(bs, dims.z - oz);
    if (bw <= 0 || bh <= 0 || bd <= 0) return false;

    const min = new THREE.Vector3(ox / dims.x - 0.5, oy / dims.y - 0.5, oz / dims.z - 0.5);
    const max = new THREE.Vector3((ox + bw) / dims.x - 0.5, (oy + bh) / dims.y - 0.5, (oz + bd) / dims.z - 0.5);
    const center = min.clone().add(max).multiplyScalar(0.5);
    const extent = max.clone().sub(min).multiplyScalar(0.5);
    const dist = plane.normal.dot(center.sub(plane.origin));
    const radius = Math.abs(plane.normal.x) * extent.x + Math.abs(plane.normal.y) * extent.y + Math.abs(plane.normal.z) * extent.z;
    return dist - radius <= margin && dist + radius >= -margin;
  }

  function _nativeSliceBricksForSpec(spec, dims) {
    if (typeof BrickLoader === 'undefined' || !BrickLoader.getDimensions) return [];
    let bricks = null;
    if (spec.mode === 'xz') {
      bricks = BrickLoader.bricksForSlab('y', spec.value ?? 0.5, 0);
    } else if (spec.mode === 'yz') {
      bricks = BrickLoader.bricksForSlab('x', spec.value ?? 0.5, 0);
    } else if (!spec.mode || spec.mode === 'xy') {
      bricks = BrickLoader.bricksForSlab('z', spec.value ?? 0.5, 0);
    }

    if (bricks) {
      return bricks.filter(b => !BrickLoader.hasBrick || BrickLoader.hasBrick(b.bx, b.by, b.bz, 0));
    }

    const plane = _slicePlaneVectors(spec);
    if (!plane) return [];
    const allActive = BrickLoader.activeBricks?.(0) || BrickLoader.bricksForRegion(
      { x: 0, y: 0, z: 0 },
      { x: 0.9999, y: 0.9999, z: 0.9999 },
      0
    );
    const slabSteps = Math.max(1, Math.min(64, Number(spec.slabThickness) || 1));
    const shaderSlab = (spec.projection && spec.projection !== 'single')
      ? ((slabSteps - 1) * (1 / 256) * 0.5)
      : 0;
    const voxelMargin = Math.max(1 / Math.max(1, dims.x), 1 / Math.max(1, dims.y), 1 / Math.max(1, dims.z)) * 2;
    return allActive.filter(b => _brickIntersectsSlicePlane(b, dims, plane, shaderSlab + voxelMargin));
  }

  function _nativeStudioRenderSize(spec, dims) {
    let maxDim = Math.max(dims.x || 1, dims.y || 1);
    if (spec.mode === 'xz') maxDim = Math.max(dims.x || 1, dims.z || 1);
    else if (spec.mode === 'yz') maxDim = Math.max(dims.y || 1, dims.z || 1);
    return Math.max(512, Math.min(8192, Math.ceil(maxDim * 1.5)));
  }

  function _slicePixelSizeUm(spec, renderRes) {
    const physical = VolumeViewer.getPhysicalSize?.() || { x: 1, y: 1, z: 1 };
    const plane = _slicePlaneVectors(spec) || {
      right: new THREE.Vector3(1, 0, 0),
      up: new THREE.Vector3(0, 1, 0)
    };
    const pRight = new THREE.Vector3(plane.right.x * physical.x, plane.right.y * physical.y, plane.right.z * physical.z);
    const pUp = new THREE.Vector3(plane.up.x * physical.x, plane.up.y * physical.y, plane.up.z * physical.z);
    return {
      x: (1.5 * pRight.length()) / Math.max(1, renderRes),
      y: (1.5 * pUp.length()) / Math.max(1, renderRes)
    };
  }

  function _cropEmptySliceSpace(canvas) {
    if (!canvas) return canvas;
    const ctx = canvas.getContext('2d');
    const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const data = imgData.data;
    let minX = canvas.width;
    let minY = canvas.height;
    let maxX = 0;
    let maxY = 0;

    for (let y = 0; y < canvas.height; y++) {
      for (let x = 0; x < canvas.width; x++) {
        const alpha = data[(y * canvas.width + x) * 4 + 3];
        if (alpha > 5) {
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
    maxX = Math.min(canvas.width - 1, maxX + padding);
    maxY = Math.min(canvas.height - 1, maxY + padding);

    const cropped = document.createElement('canvas');
    cropped.width = maxX - minX + 1;
    cropped.height = maxY - minY + 1;
    cropped.getContext('2d').drawImage(canvas, minX, minY, cropped.width, cropped.height, 0, 0, cropped.width, cropped.height);
    return cropped;
  }

  async function _renderNativeSliceForStudio() {
    if (typeof BrickLoader === 'undefined' || typeof SVRManager === 'undefined' || typeof VolumeSlicer === 'undefined') return null;
    if (!BrickLoader.isReady?.() || !VolumeSlicer.renderWithMaterial || !VolumeViewer.getRenderer?.() || !VolumeViewer.getMaterial?.()) return null;

    _cancelNativeSlice(false);
    const dims = BrickLoader.getDimensions(0);
    if (!dims) return null;
    const channels = Math.max(1, Math.min(4, Number(dims.channels) || Number(datasetMeta?.dimensions?.c) || 1));
    const spec = VolumeSlicer.getPlaneSpec();
    const bricks = _nativeSliceBricksForSpec(spec, dims);
    if (!bricks.length) return null;

    const controller = new AbortController();
    _nativeSliceAbort = controller;

    const renderer = VolumeViewer.getRenderer();
    const sourceMaterial = VolumeViewer.getMaterial();
    const tempMaterial = sourceMaterial.clone();
    tempMaterial.defines = { ...(sourceMaterial.defines || {}) };
    if (THREE.UniformsUtils) tempMaterial.uniforms = THREE.UniformsUtils.clone(sourceMaterial.uniforms);

    const tempSvr = new SVRManager();
    let doneTasks = 0;
    let writtenBricks = 0;
    let lastStatusAt = 0;
    const rgbaTransport = BrickLoader.getTransportEncoding?.() === 'raw-rgba-gzip';
    const floorLuts = VolumeViewer.floorLutsFromManifest?.(BrickLoader.getManifest?.(), channels) || [];
    const tasks = [];
    for (const brick of bricks) {
      if (rgbaTransport) tasks.push({ ...brick, channel: -1, lod: 0 });
      else {
        for (let c = 0; c < channels; c++) tasks.push({ ...brick, channel: c, lod: 0 });
      }
    }

    const status = (force = false) => {
      const now = performance.now?.() || Date.now();
      if (!force && now - lastStatusAt < 250) return;
      lastStatusAt = now;
      const pct = Math.round((doneTasks / Math.max(1, tasks.length)) * 100);
      _setSliceStatus(`Rendering native HD slice: ${writtenBricks}/${bricks.length} chunks, ${pct}%`);
    };

    try {
      _setSliceStatus(`Preparing native HD slice (${bricks.length} LOD0 chunks)...`);
      tempSvr.init(channels, dims, renderer, tempMaterial, { targetSlots: bricks.length });
      const pendingScalar = new Map();
      const bs = dims.brickSize || 64;

      await BrickLoader.loadBrickTasks(tasks, {
        concurrency: Math.min(32, Math.max(4, Number(navigator.hardwareConcurrency) || 8)),
        cancelPrevious: false,
        preserveOrder: true,
        streamOnly: true,
        cacheResults: false,
        onBrickLoaded: ({ bx, by, bz, channel, data }) => {
          if (controller.signal.aborted) return;
          if (channel === -1) {
            const ox = bx * bs;
            const oy = by * bs;
            const oz = bz * bs;
            const bw = Math.min(bs, dims.x - ox);
            const bh = Math.min(bs, dims.y - oy);
            const bd = Math.min(bs, dims.z - oz);
            const rgba = VolumeViewer.applyRgbaBrickLuts?.(data, floorLuts, channels) || data;
            tempSvr.writeRgbaBrick(bx, by, bz, rgba, bw, bh, bd);
            writtenBricks++;
          } else {
            const key = `${bx}_${by}_${bz}`;
            let pending = pendingScalar.get(key);
            if (!pending) {
              pending = { bx, by, bz, count: 0, data: new Array(channels) };
              pendingScalar.set(key, pending);
            }
            if (!pending.data[channel]) pending.count++;
            pending.data[channel] = data;
            if (pending.count >= channels) {
              const ox = bx * bs;
              const oy = by * bs;
              const oz = bz * bs;
              const bw = Math.min(bs, dims.x - ox);
              const bh = Math.min(bs, dims.y - oy);
              const bd = Math.min(bs, dims.z - oz);
              const rgba = VolumeViewer.makeRgbaBrickFromScalarChannels?.(pending.data, floorLuts, channels, bs);
              if (rgba) tempSvr.writeRgbaBrick(bx, by, bz, rgba, bw, bh, bd);
              pendingScalar.delete(key);
              writtenBricks++;
            }
          }
          doneTasks++;
          status(false);
        },
        onProgress: () => status(false)
      });

      if (controller.signal.aborted) throw new DOMException('Native slice render cancelled', 'AbortError');
      if (!writtenBricks) return null;

      status(true);
      const renderRes = _nativeStudioRenderSize(spec, dims);
      const rendered = VolumeSlicer.renderWithMaterial(tempMaterial, spec, renderRes, _currentChannelState());
      if (!rendered) return null;
      const canvas = _cropEmptySliceSpace(rendered);
      _setSliceStatus(`Native HD slice ready (${writtenBricks} chunks).`);
      return {
        canvas,
        width: canvas.width,
        height: canvas.height,
        renderRes,
        source: 'native-slicer',
        quality: 'native',
        planeSpec: spec,
        pixelSizeUm: _slicePixelSizeUm(spec, renderRes),
        physicalSizeUm: VolumeViewer.getPhysicalSize?.(),
        channelState: _currentChannelState(),
        timepoint: _currentTimepoint,
        nativeChunks: writtenBricks
      };
    } finally {
      tempSvr.dispose?.();
      tempMaterial.dispose?.();
      if (_nativeSliceAbort === controller) _nativeSliceAbort = null;
    }
  }

  function _setSliceStatus(text) {
    const node = document.getElementById('slice-render-status');
    if (node) node.textContent = text;
  }

  function _currentChannelState() {
    return ChannelPanel.getState?.() || _channelState;
  }

  function _rotateSliceRoll(delta) {
    const spec = VolumeViewer.getPlaneSpec();
    VolumeViewer.setPlaneSpec({ mode: 'oblique', roll: (spec.roll || 0) + delta, visible: true });
  }

  function _snapSlicePlane() {
    const spec = VolumeViewer.getPlaneSpec();
    const normals = [
      { mode: 'xy', yaw: 0, pitch: 0 },
      { mode: 'xz', yaw: 0, pitch: 90 },
      { mode: 'yz', yaw: 90, pitch: 0 }
    ];
    if (spec.mode !== 'oblique') {
      VolumeViewer.setPlaneSpec({ yaw: 0, pitch: 0, roll: 0, visible: true });
      return;
    }
    const yaw = Math.round((spec.yaw || 0) / 90) * 90;
    const pitch = Math.round((spec.pitch || 0) / 45) * 45;
    const exact = normals.find(row => Math.abs(yaw - row.yaw) < 1 && Math.abs(pitch - row.pitch) < 1);
    VolumeViewer.setPlaneSpec(exact ? { mode: exact.mode, yaw: 0, pitch: 0, roll: 0, visible: true } : { yaw, pitch, roll: 0, visible: true });
  }

  function _getSliceExports() {
    const hasMeasurements = MeasurementStore.list(datasetId, 'viewer').length > 0;
    return [
      { action: 'measure-csv', icon: 'ruler', label: 'Measurements CSV', enabled: hasMeasurements, handler: () => _exportMeasurements('csv') },
      { action: 'measure-json', icon: 'braces', label: 'Measurements JSON', enabled: hasMeasurements, handler: () => _exportMeasurements('json') }
    ];
  }

  function _safeExportName() {
    return String(datasetMeta?.name || datasetMeta?.id || 'viewer').replace(/[^a-z0-9._-]+/gi, '_').replace(/^_+|_+$/g, '');
  }

  function _exportMeasurements(format) {
    const items = MeasurementStore.list(datasetId, 'viewer');
    if (!items.length) {
      ExportManager.toast?.('No measurement is available to export');
      return;
    }
    const blob = new Blob([
      format === 'csv' ? MeasurementStore.toCsv(items) : MeasurementStore.toJson(items)
    ], { type: format === 'csv' ? 'text/csv' : 'application/json' });
    ExportManager.downloadBlob(blob, `${_safeExportName()}_measurements.${format}`);
  }

  function _getWorkspaceState() {
    const state = {
      ui: {
        presentationMode: document.body.classList.contains('presentation-mode'),
        sidebarHidden: document.querySelector('.viewer-sidebar')?.classList.contains('sidebar-hidden') || false,
        activeTool: typeof ToolManager !== 'undefined' ? ToolManager.current() : 'navigate',
        display: { ..._displayState }
      },
      viewer: {
        camera: VolumeViewer.getCameraState(),
        cutPlane: VolumeViewer.getCutPlaneState(),
        planeSpec: VolumeViewer.getPlaneSpec(),
        measurements: MeasurementStore.list(datasetId, 'viewer'),
        channels: ChannelPanel.getState?.() || _channelState,
        gridMode: typeof VolumeGrid !== 'undefined' ? VolumeGrid.getGridMode() : 0,
        gridSizes: typeof VolumeGrid !== 'undefined' ? VolumeGrid.getGridSizes() : null,
        axesVisible: typeof VolumeGrid !== 'undefined' ? VolumeGrid.isAxesVisible() : false,
        axesLocalPos: (() => { if (typeof VolumeGrid === 'undefined') return null; const p = VolumeGrid.getAxesLocalPos(); return { x: p.x, y: p.y, z: p.z }; })(),
        zDisplayScale: _zDisplayScale,
        zstackActive: _zstackActive,
        zstackSlice: _zstackCurrentSlice,
        timepoint: _currentTimepoint,
        qualityMode: _qualityMode,
        volumeSourcePreference: _volumeSourcePreference,
        physicalSize: VolumeViewer.getPhysicalSize(),
        physicalCalibration: VolumeViewer.getPhysicalCalibration?.() || null,
        cache: VolumeViewer.getCacheStats()
      }
    };
    // Merge plugin states
    if (typeof PluginRegistry !== 'undefined') {
      state.plugins = PluginRegistry.getWorkspaceState();
    }
    return state;
  }

  // Public entry-point: buffer if init() hasn't completed yet
  function _applyWorkspaceState(state = {}) {
    if (!_isInitialized) {
      console.log('[ViewerApp] _applyWorkspaceState: buffering (not yet initialized)');
      _pendingWorkspaceState = state;
      return;
    }
    _applyWorkspaceStateNow(state);
  }

  // Internal: apply immediately (called by init() after volume is loaded)
  function _applyWorkspaceStateNow(state = {}) {
    const ui = state.ui || {};
    const viewerState = state.viewer && Object.keys(state.viewer).length ? state.viewer : state;

    console.log('[ViewerApp] _applyWorkspaceStateNow called', {
      hasCamera: !!viewerState.camera,
      cameraZ: viewerState.camera?.cameraZ,
      measurementCount: viewerState.measurements?.length
    });
    if (viewerState.camera) VolumeViewer.setCameraState(viewerState.camera);

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
      VolumeViewer.applyDisplayState(_displayState);
    }
    if (ui.activeTool && typeof ToolManager !== 'undefined') {
      ToolManager.activate(ui.activeTool);
    }

    if (Number.isFinite(viewerState.zDisplayScale)) {
      _zDisplayScale = _clampZDisplayScale(viewerState.zDisplayScale);
      const slider = document.getElementById('slider-z-scale');
      if (slider) slider.value = Math.round(_zDisplayScale * 100);
      VolumeViewer.setZDisplayScale(_zDisplayScale);
      _saveZDisplayScale();
      _updateZScaleLabel();
      _updatePhysicalStatus();
    }

    if (viewerState.qualityMode) {
      _qualityMode = _normalizeQualityParam(viewerState.qualityMode) || '512x512';
      const select = document.getElementById('select-quality');
      if (select) select.value = _qualityMode;
    }
    if (Number.isFinite(viewerState.exposure)) {
      const slider = document.getElementById('slider-exposure');
      if (slider) {
        slider.value = Math.max(20, Math.min(500, Math.round(viewerState.exposure * 100)));
        const exposureLabel = document.getElementById('val-exposure');
        if (exposureLabel) exposureLabel.textContent = `${viewerState.exposure.toFixed(2)}×`;
        VolumeViewer.setExposure(viewerState.exposure);
      }
    }
    if (Array.isArray(viewerState.channels)) {
      ChannelPanel.setState?.(viewerState.channels, { notify: true });
    }
    
    if (typeof viewerState.gridMode === 'number' && typeof VolumeViewer.setGridMode === 'function') {
      VolumeViewer.setGridMode(viewerState.gridMode);
    }
    if (viewerState.gridSizes && typeof VolumeGrid !== 'undefined') {
      if (viewerState.gridSizes.xy !== undefined) VolumeGrid.setGridSize('xy', viewerState.gridSizes.xy);
      if (viewerState.gridSizes.xz !== undefined) VolumeGrid.setGridSize('xz', viewerState.gridSizes.xz);
      if (viewerState.gridSizes.yz !== undefined) VolumeGrid.setGridSize('yz', viewerState.gridSizes.yz);
    }
    if (typeof viewerState.axesVisible === 'boolean' && typeof VolumeViewer.setAxesVisible === 'function') {
      VolumeViewer.setAxesVisible(viewerState.axesVisible);
    }
    if (viewerState.axesLocalPos && typeof VolumeGrid !== 'undefined' && typeof VolumeGrid.setAxesLocalPos === 'function') {
      const p = viewerState.axesLocalPos;
      if (Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)) {
        VolumeGrid.setAxesLocalPos(p.x, p.y, p.z);
      }
    }

    // Z-stack browser: restore open/closed state and current slice
    // In iframe mode (compare), the parent compare.js controls z-stack via TOGGLE_ZSTACK.
    // Only apply here in standalone viewer mode to avoid the two iframes getting each other's state.
    if (!_isIframe && typeof viewerState.zstackActive === 'boolean') {
      _zstackActive = viewerState.zstackActive;
      const btn = document.getElementById('btn-toggle-zstack');
      if (btn) {
        btn.classList.toggle('btn-solid', _zstackActive);
        btn.classList.toggle('btn-ghost', !_zstackActive);
      }
      if (_zstackActive) {
        // Z-stack was open: restore panel + go to saved slice
        _zstackShow(true);
        // Override the _zstackGoToSlice(0) already called by _zstackShow(true)
        // with the actual saved slice (with a small delay so the DOM is ready)
        if (Number.isFinite(viewerState.zstackSlice) && viewerState.zstackSlice > 0) {
          setTimeout(() => _zstackGoToSlice(viewerState.zstackSlice), 80);
        }
      } else {
        // Z-stack was closed: ensure panel is hidden, rotation unlocked and clipping is full.
        // Do NOT call _zstackShow(false) here — it calls _zstackGoToSlice(0) indirectly
        // through the normal show path which then sets a narrow clip range on the volume.
        const panel = document.getElementById('zstack-browser');
        if (panel) panel.classList.add('zstack-hidden');
        VolumeViewer.setRotationLocked(false);
        VolumeViewer.resetClipping();
        _zstackCurrentSlice = 0;
      }
    }

    if (viewerState.volumeSourcePreference) {
      _volumeSourcePreference = viewerState.volumeSourcePreference;
    }

    if (viewerState.cutPlane) {
      VolumeViewer.setCutPlane(viewerState.cutPlane.axis, viewerState.cutPlane.value, { visible: Boolean(viewerState.cutPlane.visible) });
      if (viewerState.cutPlane.visible && typeof ToolManager !== 'undefined') ToolManager.activate('cut');
    }

    if (viewerState.planeSpec) {
      VolumeViewer.setPlaneSpec(viewerState.planeSpec, { visible: Boolean(viewerState.planeSpec.visible) });
      if (viewerState.planeSpec.visible && typeof ToolManager !== 'undefined') ToolManager.activate('cut');
    }

    if (Array.isArray(viewerState.measurements)) {
      _volumeMeasurements = MeasurementStore.setAll(datasetId, 'viewer', viewerState.measurements);
      VolumeViewer.setMeasurements(_volumeMeasurements);
      _renderVolumeMeasurement();
    }

    if (isLive && Number.isFinite(viewerState.timepoint)) {
      Timeline.setFrame(viewerState.timepoint);
    } else if (_basePath && viewerState.qualityMode) {
      _loadTimepoint(_basePath, _currentTimepoint, { force: true }).catch(_showLoadingError);
    }
    _updateVolumeSourceStatus();

    // Restore plugin states
    if (state.plugins && typeof PluginRegistry !== 'undefined') {
      PluginRegistry.setWorkspaceState(state.plugins);
    }
  }

  function _resetClipSliders() {
    ['x', 'y', 'z'].forEach(axis => {
      const slider = document.getElementById(`slider-${axis}`);
      const label = document.getElementById(`val-${axis}`);
      if (slider) slider.value = 100;
      if (label) label.textContent = '100%';
      VolumeViewer.setClip(axis, 1.0);
    });
  }

  function _handleVolumeMeasurePoint(point) {
    const calibration = VolumeViewer.getPhysicalCalibration?.();
    if (calibration?.calibrationStatus === 'metadata-missing') {
      _setVolumeMeasureStatus('Physical calibration is missing for this dataset. Distance measurement needs calibrated voxel metadata.');
      return;
    }
    if (!point?.physicalUm) {
      _setVolumeMeasureStatus('No calibrated volume point was detected.');
      return;
    }
    if (_volumeMeasureDraft.length >= 2) _volumeMeasureDraft = [];
    _volumeMeasureDraft.push(point);
    if (_volumeMeasureDraft.length === 2) {
      _createVolumeMeasurement();
    }
    _renderVolumeMeasurement();
  }

  function _clearVolumeMeasurement() {
    _volumeMeasureDraft = [];
    _volumeMeasurements = MeasurementStore.clear(datasetId, 'viewer');
    VolumeViewer.setMeasurements(_volumeMeasurements);
    _renderVolumeMeasurement();
  }

  const MEASURE_PALETTE = [
    ['#FFD700', '#00FFFF', '#FF1493', '#7FFF00', '#FF4500'],
    ['#9400D3', '#00FF7F', '#FF69B4', '#1E90FF', '#FFFFFF']
  ];

  function _showMeasureColorPopup(id, anchorEl) {
    // Remove any existing popup
    _closeMeasureColorPopup();
    
    const popup = document.createElement('div');
    popup.id = 'measure-color-popup-active';
    popup.style.cssText = 'position:fixed; background:var(--bg-surface,#222); border:1px solid var(--border-color,#444); border-radius:6px; padding:6px; z-index:99999; box-shadow:0 4px 12px rgba(0,0,0,0.5); display:flex; flex-direction:column; gap:4px;';

    for (const row of MEASURE_PALETTE) {
      const rowDiv = document.createElement('div');
      rowDiv.style.cssText = 'display:flex; gap:4px;';
      for (const color of row) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.style.cssText = `width:20px; height:20px; border-radius:4px; border:1px solid rgba(255,255,255,0.15); background:${color}; padding:0; cursor:pointer; transition:transform 0.1s;`;
        btn.title = color;
        btn.onmouseover = () => btn.style.transform = 'scale(1.1)';
        btn.onmouseout = () => btn.style.transform = 'scale(1)';
        btn.onclick = (e) => {
          e.stopPropagation();
          MeasurementStore.update(datasetId, 'viewer', id, { color });
          _volumeMeasurements = MeasurementStore.list(datasetId, 'viewer');
          VolumeViewer.setMeasurements(_volumeMeasurements);
          _renderVolumeMeasurement();
          _closeMeasureColorPopup();
        };
        rowDiv.appendChild(btn);
      }
      popup.appendChild(rowDiv);
    }

    document.body.appendChild(popup);

    // Position relative to anchor button
    const rect = anchorEl.getBoundingClientRect();
    popup.style.top = `${rect.bottom + 4}px`;
    popup.style.left = `${rect.left}px`;
    
    // If popup goes off screen right, flip it
    requestAnimationFrame(() => {
      const popupRect = popup.getBoundingClientRect();
      if (popupRect.right > window.innerWidth) {
        popup.style.left = `${rect.right - popupRect.width}px`;
      }
    });
  }

  function _closeMeasureColorPopup() {
    const existing = document.getElementById('measure-color-popup-active');
    if (existing) existing.remove();
  }

  function _renderVolumeMeasurement() {
    const list = document.getElementById('volume-measure-list');
    if (list) {
      list.innerHTML = _volumeMeasurements.length
        ? _volumeMeasurements.map(item => `
          <div class="measurement-row" style="display: flex; align-items: center; gap: 4px; padding: 4px 0;">
            <button class="btn btn-ghost btn-sm measure-color-btn" type="button" data-volume-measure-action="toggle-color" data-measurement-id="${Utils.escapeHtml(item.id)}" style="padding: 0; width: 24px; height: 24px; border: none; flex-shrink: 0;">
              <span style="background:${item.color}; width:16px; height:16px; display:inline-block; border-radius:3px; border:1px solid rgba(255,255,255,0.2); vertical-align:middle;"></span>
            </button>
            <input type="text" value="${Utils.escapeHtml(item.label || '')}" placeholder="Vide" class="form-input text-xs" style="flex: 1; min-width: 0; width: 50px; padding: 2px 4px; background: rgba(0,0,0,0.2); border: 1px solid var(--border-light); color: var(--text-primary); border-radius: 4px;" data-volume-measure-action="rename" data-measurement-id="${Utils.escapeHtml(item.id)}">
            <span style="white-space: nowrap; font-size: 11px; color: var(--text-muted);">
              ${item.visible === false ? 'Hidden' : `${_fmtUm(item.distance)} µm`}
            </span>
            <span class="related-actions" style="display: flex; gap: 2px;">
              <button class="btn btn-ghost btn-sm" type="button" data-volume-measure-action="toggle" data-measurement-id="${Utils.escapeHtml(item.id)}" style="padding: 2px;">
                <i data-lucide="${item.visible === false ? 'eye-off' : 'eye'}"></i>
              </button>
              <button class="btn btn-ghost btn-sm" type="button" data-volume-measure-action="delete" data-measurement-id="${Utils.escapeHtml(item.id)}" style="padding: 2px;">
                <i data-lucide="trash-2"></i>
              </button>
            </span>
          </div>
        `).join('')
        : 'No saved measurement yet.';
      if (window.lucide) lucide.createIcons({ nodes: [list] });
    }

    if (!_volumeMeasureDraft.length) {
      _setVolumeMeasureStatus('Click two points on the embryo surface.');
      return;
    }
    if (_volumeMeasureDraft.length === 1) {
      const p = _volumeMeasureDraft[0].physicalUm;
      _setVolumeMeasureStatus(`
        <div class="metric-tile"><small>Point A</small><strong>${_fmtUm(p.x)}, ${_fmtUm(p.y)}, ${_fmtUm(p.z)} um</strong></div>
        <div class="text-xs text-muted">Click a second point to measure distance.</div>
      `);
      return;
    }
    const [a, b] = _volumeMeasureDraft.map(p => p.physicalUm);
    const distance = _distance3d(a, b);
    _setVolumeMeasureStatus(`
      <div class="metric-grid">
        <div class="metric-tile"><small>Distance</small><strong>${_fmtUm(distance)} um</strong></div>
        <div class="metric-tile"><small>Delta Z</small><strong>${_fmtUm(Math.abs(a.z - b.z))} um</strong></div>
      </div>
      <div class="text-xs text-muted">Measured between two picked surface points in calibrated physical coordinates.</div>
    `);
  }

  function _setVolumeMeasureStatus(html) {
    const node = document.getElementById('volume-measure-status');
    if (!node) return;
    node.innerHTML = html;
  }

  function _createVolumeMeasurement() {
    if (_volumeMeasureDraft.length !== 2) return null;
    const [aPoint, bPoint] = _volumeMeasureDraft;
    const MEASUREMENT_COLORS = [
      '#00FFFF', // Cyan
      '#FFD700', // Gold
      '#FF1493', // DeepPink
      '#7FFF00', // Chartreuse
      '#FF4500', // OrangeRed
      '#9400D3', // DarkViolet
      '#00FF7F', // SpringGreen
      '#FF69B4'  // HotPink
    ];
    const newColor = MEASUREMENT_COLORS[_volumeMeasurements.length % MEASUREMENT_COLORS.length];

    const measurement = MeasurementStore.add(datasetId, 'viewer', {
      scope: 'viewer',
      datasetId,
      label: `Measure ${_volumeMeasurements.length + 1}`,
      unit: 'um',
      distance: _distance3d(aPoint.physicalUm, bPoint.physicalUm),
      points: _volumeMeasureDraft.map(point => ({
        normalized: point.normalized,
        physicalUm: point.physicalUm
      })),
      timepoint: _currentTimepoint,
      color: newColor
    });
    _volumeMeasurements.push(measurement);
    _volumeMeasureDraft = [];
    VolumeViewer.setMeasurements(_volumeMeasurements);
    return measurement;
  }

  function _handleVolumeMeasureListClick(event) {
    const action = event.target.closest('[data-volume-measure-action]')?.dataset.volumeMeasureAction;
    const id = event.target.closest('[data-measurement-id]')?.dataset.measurementId;
    if (!action || !id) return;
    
    if (action === 'toggle' && event.type === 'click') {
      const item = _volumeMeasurements.find(row => row.id === id);
      if (!item) return;
      MeasurementStore.update(datasetId, 'viewer', id, { visible: item.visible === false });
      _volumeMeasurements = MeasurementStore.list(datasetId, 'viewer');
      VolumeViewer.setMeasurements(_volumeMeasurements);
      _renderVolumeMeasurement();
    }
    
    if (action === 'delete' && event.type === 'click') {
      _volumeMeasurements = MeasurementStore.remove(datasetId, 'viewer', id);
      VolumeViewer.setMeasurements(_volumeMeasurements);
      _renderVolumeMeasurement();
    }

    if (action === 'rename' && event.type === 'change') {
      const newLabel = event.target.value;
      MeasurementStore.update(datasetId, 'viewer', id, { label: newLabel });
      _volumeMeasurements = MeasurementStore.list(datasetId, 'viewer');
      VolumeViewer.setMeasurements(_volumeMeasurements);
      _renderVolumeMeasurement();
    }

    if (action === 'toggle-color' && event.type === 'click') {
      const btn = event.target.closest('[data-volume-measure-action="toggle-color"]');
      if (btn) {
        _showMeasureColorPopup(id, btn);
      }
    }
  }

  function _distance3d(a, b) {
    const dx = (a.x || 0) - (b.x || 0);
    const dy = (a.y || 0) - (b.y || 0);
    const dz = (a.z || 0) - (b.z || 0);
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  async function _loadTimepoint(basePath, t, opts = {}) {
    const perfId = _perf()?.start('viewer.timepoint.load', {
      timepoint: t,
      qualityMode: _qualityMode,
      forced: Boolean(opts.force)
    });
    _currentTimepoint = t;
    const loadToken = ++_activeLoadToken;
    // ELE-11 (RACE-002): any post-await resumption on a stale load (quality/timepoint
    // changed meanwhile) must NOT mutate _brickManifest, the quality select, or _qualityMode.
    const _isStale = () => loadToken !== _activeLoadToken;
    const _bailStale = () => { _perf()?.end(perfId, { status: 'stale', timepoint: t, quality: primaryQuality }); };
    const loader = document.getElementById('viewer-loader');
    const progressFill = document.getElementById('loader-progress');
    const loaderText = document.getElementById('loader-text');
    let primaryQuality = opts.quality || _qualityMode || '512x512';
    const qualityKey = _qualityKey(t, primaryQuality);
    const activeEntry = VolumeViewer.getSamplingVolume?.();
    const hasActiveVolume = Boolean(activeEntry && (activeEntry.textures || activeEntry.data));
    const isQualitySwitch = Boolean(hasActiveVolume && (opts.force || loadedTimepoints.has(t)));
    const useBlockingLoader = !isQualitySwitch && (opts.force || !loadedTimepoints.has(t) || !_loadedQualities.has(qualityKey));
    
    if (useBlockingLoader) {
      if (loader) loader.style.display = 'flex';
      if (loaderText) {
        loaderText.textContent = isLive
          ? `Loading Timepoint ${t + 1} (${primaryQuality})...`
          : `Loading Volume Data (${primaryQuality})...`;
      }
      progressFill.style.width = '0%';
    } else if (loader) {
      loader.style.display = 'none';
      VolumeViewer.setQualityTarget?.(primaryQuality, _qualityMode);
    }

    _setQualityStatus(`Loading ${primaryQuality}...`);
    let result;
    try {
      result = await _loadVolumeForQuality(basePath, datasetMeta, t, primaryQuality, (progress) => {
        if (loadToken === _activeLoadToken && useBlockingLoader && progressFill) {
          progressFill.style.width = `${progress * 100}%`;
        }
      }, { deferActivation: isQualitySwitch });
      if (_isStale()) { _bailStale(); return; }
      if ((!result || result.available === false) && primaryQuality === '512x512') {
        console.warn('[ViewerApp] 512x512 unavailable, falling back to 256x256:', result?.reason || 'unknown');
        primaryQuality = '256x256';
        _qualityMode = '256x256';
        const select = document.getElementById('select-quality');
        if (select) select.value = '256x256';
        VolumeViewer.setQualityTarget?.(primaryQuality, _qualityMode);
        result = await _loadVolumeForQuality(basePath, datasetMeta, t, primaryQuality, (progress) => {
          if (loadToken === _activeLoadToken && useBlockingLoader && progressFill) {
            progressFill.style.width = `${progress * 100}%`;
          }
        }, { deferActivation: isQualitySwitch });
        if (_isStale()) { _bailStale(); return; }
      }
      if (!_isStale() && result && result.manifest) {
        _brickManifest = result.manifest;
        _updateQualityOptionLabels();
      }
    } catch (err) {
      if (primaryQuality === '512x512') {
        console.warn('[ViewerApp] 512x512 failed, falling back to 256x256:', err);
        primaryQuality = '256x256';
        _qualityMode = '256x256';
        const select = document.getElementById('select-quality');
        if (select) select.value = '256x256';
        VolumeViewer.setQualityTarget?.(primaryQuality, _qualityMode);
        result = await _loadVolumeForQuality(basePath, datasetMeta, t, primaryQuality, (progress) => {
          if (loadToken === _activeLoadToken && useBlockingLoader && progressFill) {
            progressFill.style.width = `${progress * 100}%`;
          }
        }, { deferActivation: isQualitySwitch });
        if (_isStale()) { _bailStale(); return; }
      } else {
      _perf()?.end(perfId, {
        status: 'error',
        timepoint: t,
        quality: primaryQuality,
        message: err?.message || String(err)
      });
      throw err;
      }
    }

    if (_isStale()) { _bailStale(); return; }

    if (result && result.manifest) {
      _brickManifest = result.manifest;
      _updateQualityOptionLabels();
    }

    if (!result || result.available === false) {
      throw new Error(result?.reason || `Quality ${primaryQuality} unavailable`);
    }

    if (result?.stale || loadToken !== _activeLoadToken) {
      _perf()?.end(perfId, {
        status: 'stale',
        timepoint: t,
        quality: primaryQuality
      });
      return;
    }
    
    _loadedQualities.add(qualityKey);
    loadedTimepoints.add(t);
    if (loader) loader.style.display = 'none';
    ChannelPanel.setHistograms(VolumeViewer.getChannelHistograms());
    _updateVolumeSourceStatus();
    _setQualityStatus(`${_qualityLabel(primaryQuality)} active${result ? ` (${result.width}x${result.height}x${result.depth})` : ''}${result?.fromCache ? ' from cache' : ''}${_sliceWarning(result)}.`);
    _updatePhysicalStatus();

    // Refresh slicer material after texture upload
    if (typeof VolumeSlicer !== 'undefined') {
      const mat = VolumeViewer.getMaterial();
      if (mat) VolumeSlicer.updateMaterial(mat);
    }

    
    if (isLive) {
      Timeline.updateBuffer(loadedTimepoints.size);
      if (_isIframe) {
        // SEC-012: restrict targetOrigin to this page's origin (no wildcard leak).
        window.parent.postMessage({ type: 'SYNC_TIME', value: t, sourceIndex: _panelIndex }, Utils.trustedTargetOrigin());
      }
    }

    _scheduleAdjacentPreload(basePath, t);
    _perf()?.end(perfId, {
      status: 'ok',
      timepoint: t,
      quality: primaryQuality,
      fromCache: Boolean(result?.fromCache),
      width: result?.width || null,
      height: result?.height || null,
      depth: result?.depth || null,
      streamMode: result?.streamMode || 'slices'
    });
  }

  function _scheduleAdjacentPreload(basePath, t) {
    if (!isLive || !Number.isFinite(t)) return;
    if (_preloadTimer) clearTimeout(_preloadTimer);
    const total = datasetMeta.dimensions?.t || 0;
    const candidates = [t + 1, t - 1, t + 2]
      .filter(frame => frame >= 0 && frame < total)
      .filter(frame => !_preloadedTimepoints.has(frame) && !loadedTimepoints.has(frame));
    if (!candidates.length) return;

    const run = () => {
      candidates.forEach(frame => {
        _preloadedTimepoints.add(frame);
        VolumeViewer.preloadVolume(basePath, datasetMeta, frame, { quality: '256x256' })
          .then((result) => {
            if (result.successfulLoads > 0) {
              _setQualityStatus(`Nearby previews cached. ${_qualityLabel(_qualityMode)} remains the displayed target.`);
            }
          })
          .catch(err => console.warn('[ViewerApp] Timepoint preload failed:', err));
      });
    };

    _preloadTimer = window.requestIdleCallback
      ? requestIdleCallback(run, { timeout: 1800 })
      : setTimeout(run, 350);
  }

  function _sliceWarning(result) {
    if (!result?.failedLoads) return '';
    const label = result.failedLoads === 1 ? 'slice image missing' : 'slice images missing';
    return `; ${result.failedLoads} ${label}`;
  }

  function _qualityKey(t, quality) {
    return `${t === null ? 'fixed' : t}:${quality}`;
  }

  function _qualityLabel(quality) {
    if (quality === 'native') return window.I18n ? window.I18n.t('viewer.native', 'Native') : 'Native';
    return quality; // returns resolution key directly (e.g. '256x256')
  }

  function _normalizeQualityParam(value) {
    const key = String(value || '').trim().toLowerCase();
    if (key === 'preview' || key === 'low' || key === '256x256') return '256x256';
    if (key === 'balanced' || key === 'medium' || key === '512x512') return '512x512';
    if (key === 'high' || key === '1024x1024') return '1024x1024';
    if (key === '2048x2048') return '2048x2048';
    if (key === '4096x4096') return '4096x4096';
    if (key === 'native') return 'native';
    return null;
  }

  async function _loadVolumeForQuality(basePath, meta, timepoint, quality, onProgress, extraOptions = {}) {
    VolumeViewer.setQualityTarget?.(quality, _qualityMode);
    if (VolumeViewer.loadBrickedVolumeStream) {
      const streamed = await VolumeViewer.loadBrickedVolumeStream(basePath, meta, timepoint, onProgress, {
        quality,
        qualityMode: _qualityMode,
        ...extraOptions
      });
      if (streamed?.stale) {
        return streamed;
      }
      if (streamed?.available) {
        return streamed;
      }
      console.warn('[ViewerApp] Brick streaming unavailable, fallback to slices:', streamed?.reason || 'unknown');
    }
    return VolumeViewer.loadVolume(basePath, meta, timepoint, onProgress, { quality, ...extraOptions });
  }

  function _handleQualityProgress(state) {
    const panel = document.getElementById('quality-stream-progress');
    const fill = document.getElementById('quality-stream-progress-fill');
    const text = document.getElementById('quality-stream-progress-text');
    if (!panel || !fill || !text) return;
    const progress = Math.max(0, Math.min(1, Number(state?.progress) || 0));
    const active = state?.active || state?.target || '';
    const message = String(state?.message || '');
    const loading = progress < 1 && /(loading|streaming|fetching)/i.test(message);
    panel.classList.toggle('hidden', !loading);
    fill.style.width = `${Math.round(progress * 100)}%`;
    text.textContent = `${_qualityLabel(active)} ${Math.round(progress * 100)}%`;
  }

  function _setQualityStatus(text) {
    const status = document.getElementById('quality-status');
    if (status) status.textContent = text;
  }

  function _loadZDisplayScale() {
    try {
      const stored = localStorage.getItem(_zScaleStorageKey());
      const value = stored ? parseFloat(stored) : 1.0;
      return Number.isFinite(value) ? Math.max(0.25, Math.min(2.0, value)) : 1.0;
    } catch {
      return 1.0;
    }
  }

  function _saveZDisplayScale() {
    try {
      localStorage.setItem(_zScaleStorageKey(), _zDisplayScale.toFixed(2));
    } catch {
      // localStorage can be unavailable in restrictive contexts.
    }
  }

  function _zScaleStorageKey() {
    return `iribhm.viewer.zScale.${datasetId || 'unknown'}`;
  }

  function _updateZScaleLabel() {
    const label = document.getElementById('val-z-scale');
    if (label) label.textContent = `${_zDisplayScale.toFixed(2)}x`;
  }

  function _updatePhysicalStatus() {
    const status = document.getElementById('physical-size-status');
    if (!status) return;

    const physical = VolumeViewer.getPhysicalSize();
    const calibration = VolumeViewer.getPhysicalCalibration?.();
    if (!physical || !calibration) {
      status.textContent = 'Physical dimensions pending.';
      return;
    }

    const calibrationLabel = calibration.calibrationStatus === 'exact'
      ? 'Exact'
      : calibration.calibrationStatus === 'estimated'
        ? 'Estimated'
        : 'Metadata missing';
    const zDisplayed = physical.z * _zDisplayScale;
    const overrideText = Math.abs(_zDisplayScale - 1) > 1e-6
      ? `Display override: ${_zDisplayScale.toFixed(2)}x`
      : 'Display override: 1.00x';
    const active = VolumeViewer.getSamplingVolume?.();
    const activeGrid = active?.width && active?.height && active?.depth
      ? `${active.width}x${active.height}x${active.depth}`
      : '--';
    const nativeDims = _qualityDims('native');
    const nativeGrid = nativeDims ? `${nativeDims.x}x${nativeDims.y}x${nativeDims.z}` : '--';
    status.innerHTML = `
      <strong>Physical size: ${_fmtUm(physical.x)} x ${_fmtUm(physical.y)} x ${_fmtUm(zDisplayed)} &micro;m</strong><br>
      Voxel grid: active ${activeGrid}; native ${nativeGrid}<br>
      Calibration: ${calibrationLabel}; ${overrideText}; slice thickness: ${_fmtUm(physical.sliceThickness)} &micro;m
    `;
  }

  function _fmtUm(value) {
    if (!Number.isFinite(value)) return '--';
    if (value >= 100) return Math.round(value).toString();
    if (value >= 10) return value.toFixed(1);
    return value.toFixed(2);
  }

  function _bindIframeSync() {
    if (!_isIframe) return;

    // Send Z sync
    document.getElementById('slicer-position')?.addEventListener('input', (e) => {
      // SEC-012: restrict targetOrigin to this page's origin (no wildcard leak).
      window.parent.postMessage({ type: 'SYNC_Z', value: parseInt(e.target.value, 10) / 100, sourceIndex: _panelIndex }, Utils.trustedTargetOrigin());
    });

    // Send Time sync
    // The timeline scrubber uses 'input' on its range. Wait, it's a custom scrubber.
    // For now, we will rely on internal Timeline events if needed, or we just listen.

    // Listen from parent
    window.addEventListener('message', (e) => {
      if (!Utils.isTrustedMessageOrigin(e)) return;
      const data = e.data;
      if (!data || !data.type) return;

      // NOTE: APPLY_WORKSPACE_STATE is handled by the module-level listener
      // installed before init() runs (at the bottom of viewer.js). Do NOT handle
      // it here to avoid double-processing.

      if (data.sourceIndex === _panelIndex) return;

      if (data.type === 'SYNC_Z') {
        const slider = document.getElementById('slicer-position');
        if (slider) {
          const pct = Math.round(parseFloat(data.value) * 100);
          slider.value = pct;
          _setClipUi('z', data.value);
          VolumeViewer.setPlaneSpec({ value: data.value, notify: false });
        }
      } else if (data.type === 'SYNC_CHANNELS') {
        const params = data.value;
        const matchingIdx = _channelState.findIndex(ch => ch.name === params.name);
        if (matchingIdx !== -1) {
          const newState = [..._channelState];
          newState[matchingIdx] = { ...newState[matchingIdx], ...params };
          ChannelPanel.setState(newState, { notify: false });
          _channelState[matchingIdx] = { ...newState[matchingIdx] };
          VolumeViewer.updateChannel(matchingIdx, params);
        }
      } else if (data.type === 'SET_CHANNEL_ACTIVE') {
        // Support both key names: channelIndex (sent by _decomposeChannels) and value (legacy)
        const targetIdx = data.channelIndex ?? data.value;
        const newState = _channelState.map((ch, idx) => ({ ...ch, active: idx === targetIdx }));
        ChannelPanel.setState(newState, { notify: false });
        newState.forEach((ch, idx) => {
          _channelState[idx] = { ...ch };
          VolumeViewer.updateChannel(idx, ch);
        });
      } else if (data.type === 'SYNC_ZSTACK_SLICE') {
        // A sibling decompose panel navigated to a different Z slice.
        // Open z-stack browser if not already active, then go to the same slice.
        _suppressZstackSync = true;
        if (!_zstackActive) {
          _applyZstackState(true, data.sliceIndex);
        } else {
          _zstackGoToSlice(data.sliceIndex);
        }
        _suppressZstackSync = false;
      } else if (data.type === 'SYNC_SLICER_SPEC') {
        // A sibling decompose panel moved the slice-through-volume plane.
        // The 3D raymarcher has no cut-plane shader uniform, so we cannot
        // cut the volume in the main WebGL canvas. Instead:
        //   1. Activate VolumeSlicer (links GPU texture, renders 2D slice)
        //   2. Show its output as a fullscreen overlay over the WebGL canvas
        // This matches exactly what the user sees in the slice inspector sidebar.
        _suppressSlicerSync = true;
        if (typeof VolumeSlicer !== 'undefined') {
          const mat = VolumeViewer.getMaterial?.();
          if (mat) VolumeSlicer.updateMaterial(mat);
          VolumeSlicer.setVisible(true);
          VolumeSlicer.setPlaneSpec(data.spec);
        }
        _slicerOverlayStart();
        _suppressSlicerSync = false;
      } else if (data.type === 'SYNC_TIME' && isLive) {
        Timeline.setFrame(data.value, false);
      }
      if (data.type === 'SYNC_CAMERA') {
        // When z-stack browser is active, block camera orientation sync (rotation/pan)
        // to prevent the fixed top-down projection from being rotated by another panel.
        // Zoom (cameraZ) is allowed to stay consistent with the other view's scale.
        if (_zstackActive) {
          if (Number.isFinite(data.value?.cameraZ)) {
            VolumeViewer.setCameraState({ kind: 'volume', cameraZ: data.value.cameraZ });
          }
        } else {
          VolumeViewer.setCameraState(data.value);
        }
        if (Number.isFinite(data.value?.zDisplayScale)) {
          _zDisplayScale = _clampZDisplayScale(data.value.zDisplayScale);
          const slider = document.getElementById('slider-z-scale');
          if (slider) slider.value = Math.round(_zDisplayScale * 100);
          _updateZScaleLabel();
          _updatePhysicalStatus();
          _saveZDisplayScale();
        }
      }
      if (data.type === 'TOGGLE_SIDEBAR') {
        const sidebar = document.querySelector('.viewer-sidebar');
        if (data.value === true) {
          sidebar.classList.remove('sidebar-hidden');
        } else {
          sidebar.classList.add('sidebar-hidden');
        }
        _scheduleViewerResize();
      } else if (data.type === 'SET_TOOL') {
        if (typeof ToolManager !== 'undefined') {
          ToolManager.activate(data.tool);
        }
      } else if (data.type === 'TOGGLE_VISUAL') {
        if (data.visual === 'grid') {
          VolumeViewer.setGridMode?.(data.state ? 1 : 0);
        } else if (data.visual === 'axes') {
          VolumeViewer.setAxesVisible?.(!!data.state);
        }
      } else if (data.type === 'TOGGLE_ZSTACK') {
        // Handled by the early module-level listener (_applyZstackState).
        // This path runs only if the message arrives AFTER _bindIframeSync (i.e. late messages).
        // LEAK-002: z-stack mode supersedes the slicer overlay — stop its rAF loop.
        if (data.state) _slicerOverlayStop();
        _applyZstackState(!!data.state, data.slice ?? null);
      } else if (data.type === 'ZSTACK_HOVER_STATE') {
        if (_zstackActive) {
          const panel = document.getElementById('zstack-browser');
          if (panel) {
            panel.classList.toggle('zstack-hidden', !data.state);
          }
        }
      } else if (data.type === 'REQUEST_SCREENSHOT') {
        try {
          let canvas = null;
          // BUG-008: rely on DeepZoomViewer.isActive() (the dead _deepZoomActive
          // flag was never set true, making this branch inert).
          if (typeof DeepZoomViewer !== 'undefined' && DeepZoomViewer.isActive()) {
            canvas = document.querySelector('#deepzoom-container canvas');
          } else if (_zstackActive || (typeof VolumeSlicer !== 'undefined' && VolumeSlicer.isVisible())) {
            const sr = getCurrentSliceResult();
            canvas = sr?.canvas;
          }
          
          if (!canvas) {
            if (typeof VolumeViewer !== 'undefined' && VolumeViewer.getRenderer) {
              canvas = VolumeViewer.getRenderer()?.domElement;
            }
          }
          
          if (!canvas) {
            canvas = document.getElementById('webgl-canvas');
          }

          if (!canvas) {
            // SEC-012: restrict targetOrigin to this page's origin (no wildcard leak).
            window.parent.postMessage({ type: 'SCREENSHOT_RESPONSE', success: false, error: 'No active canvas found' }, Utils.trustedTargetOrigin());
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
          // SEC-012: restrict targetOrigin to this page's origin (no wildcard leak).
          window.parent.postMessage({ type: 'SCREENSHOT_RESPONSE', success: true, dataUrl }, Utils.trustedTargetOrigin());
        } catch (err) {
          // SEC-012: restrict targetOrigin to this page's origin (no wildcard leak).
          window.parent.postMessage({ type: 'SCREENSHOT_RESPONSE', success: false, error: err.message }, Utils.trustedTargetOrigin());
        }
      }
    });
  }

  function _clampZDisplayScale(value) {
    return Number.isFinite(value) ? Math.max(0.25, Math.min(2.0, value)) : 1.0;
  }

  function _showLoadingError(err) {
    console.error('[ViewerApp] Loading failed:', err);
    const loader = document.getElementById('viewer-loader');
    if (!loader) return;
    const message = Utils.escapeHtml(err?.message || err || 'Unknown loading error');
    loader.style.display = 'flex';
    loader.innerHTML = `
      <i data-lucide="alert-triangle" style="width:48px;height:48px;margin-bottom:16px;color:var(--color-error)"></i>
      <h3>Loading Error</h3>
      <p style="color:var(--text-muted);margin-top:8px;max-width:400px;text-align:center">${message}</p>
      <a href="explorer.html" class="btn btn-primary" style="margin-top:16px">Return to Explorer</a>
    `;
    if (window.lucide) lucide.createIcons();
  }

  async function _getFigureBlob(options = {}) {
    const canvas = document.getElementById('webgl-canvas');
    if (!canvas) return null;
    const resolved = typeof DisplayPresets !== 'undefined'
      ? DisplayPresets.resolve(_displayState.backgroundPreset, _displayState.backgroundColor)
      : { transparent: false, color: '#000000' };
    if (resolved.transparent) {
      return await new Promise(resolve => canvas.toBlob(resolve, options.mime || 'image/png', options.quality || 0.95));
    }
    const composed = document.createElement('canvas');
    composed.width = canvas.width;
    composed.height = canvas.height;
    const ctx = composed.getContext('2d');
    ctx.fillStyle = resolved.color;
    ctx.fillRect(0, 0, composed.width, composed.height);
    ctx.drawImage(canvas, 0, 0);
    return await new Promise(resolve => composed.toBlob(resolve, options.mime || 'image/png', options.quality || 0.95));
  }

  async function _updateVolumeSourceStatus() {
    const node = document.getElementById('volume-source-status');
    if (!node) return;
    const preferred = typeof VolumeSourceManager !== 'undefined'
      ? VolumeSourceManager.preferred(datasetMeta, _volumeSourcePreference)
      : null;
    if (!preferred) {
      node.textContent = 'Volume source: unavailable.';
      return;
    }
    node.textContent = `Display: ${preferred.label}.`;
  }

  function _scheduleViewerResize() {
    // Only call VolumeViewer.resize() — don't dispatch window resize events
    // since the ResizeObserver already handles DOM layout changes and
    // dispatching window resize would doubly update the renderer to wrong dimensions.
    [0, 80, 200].forEach(delay => setTimeout(() => VolumeViewer.resize(), delay));
  }

  function getCurrentSliceResult() {
    let result = null;

    function cropEmptySpace(canvas) {
      const ctx = canvas.getContext('2d');
      const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const data = imgData.data;
      let minX = canvas.width, minY = canvas.height, maxX = 0, maxY = 0;

      for (let y = 0; y < canvas.height; y++) {
        for (let x = 0; x < canvas.width; x++) {
          const alpha = data[(y * canvas.width + x) * 4 + 3];
          if (alpha > 5) {
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
      maxX = Math.min(canvas.width - 1, maxX + padding);
      maxY = Math.min(canvas.height - 1, maxY + padding);

      const croppedWidth = maxX - minX + 1;
      const croppedHeight = maxY - minY + 1;

      const croppedCanvas = document.createElement('canvas');
      croppedCanvas.width = croppedWidth;
      croppedCanvas.height = croppedHeight;
      const croppedCtx = croppedCanvas.getContext('2d');
      croppedCtx.drawImage(canvas, minX, minY, croppedWidth, croppedHeight, 0, 0, croppedWidth, croppedHeight);
      
      return croppedCanvas;
    }

    if (_zstackActive && typeof VolumeSlicer !== 'undefined') {
      const { z, vz } = _zstackGetDims();
      if (z >= 1) {
        const oldSpec = VolumeSlicer.getPlaneSpec();
        const value = _zstackCurrentSlice / Math.max(1, z - 1);
        const spec = { mode: 'xy', axis: 'z', value: value, yaw: 0, pitch: 0, roll: 0 };
        VolumeSlicer.setPlaneSpec(spec);

        const dim = datasetMeta?.dimensions || {};
        const maxRes = Math.max(Number(dim.original_x) || Number(dim.x) || 1024, Number(dim.original_y) || Number(dim.y) || 1024);
        const renderRes = Math.ceil(maxRes * 1.5);
        let canvas = VolumeSlicer.renderHighRes(renderRes);
        VolumeSlicer.setPlaneSpec(oldSpec);

        if (canvas) {
          canvas = cropEmptySpace(canvas);
          const physical = VolumeViewer.getPhysicalSize?.() || {x: 1, y: 1, z: 1};
          const pRight = new THREE.Vector3(1 * physical.x, 0, 0);
          const pUp = new THREE.Vector3(0, 1 * physical.y, 0);
          const pixelSizeX = (1.5 * pRight.length()) / renderRes;
          const pixelSizeY = (1.5 * pUp.length()) / renderRes;

          return {
            canvas,
            width: canvas.width,
            height: canvas.height,
            renderRes: renderRes,
            source: 'zstack',
            quality: 'high',
            planeSpec: spec,
            pixelSizeUm: { x: pixelSizeX, y: pixelSizeY },
            channelState: _currentChannelState()
          };
        }
      }
    }

    if (typeof VolumeSlicer !== 'undefined') {
      const dim = datasetMeta?.dimensions || {};
      const maxRes = Math.max(Number(dim.original_x) || Number(dim.x) || 1024, Number(dim.original_y) || Number(dim.y) || 1024);
      const renderRes = Math.ceil(maxRes * 1.5);
      let canvas = VolumeSlicer.renderHighRes(renderRes);
      if (canvas) {
        canvas = cropEmptySpace(canvas);
        const spec = VolumeSlicer.getPlaneSpec();
        const physical = VolumeViewer.getPhysicalSize?.() || {x: 1, y: 1, z: 1};
        let right = new THREE.Vector3(1, 0, 0);
        let up = new THREE.Vector3(0, 1, 0);
        if (spec.mode === 'xz') {
          right = new THREE.Vector3(1, 0, 0);
          up = new THREE.Vector3(0, 0, 1);
        } else if (spec.mode === 'yz') {
          right = new THREE.Vector3(0, 1, 0);
          up = new THREE.Vector3(0, 0, 1);
        } else if (spec.mode === 'oblique') {
          const yaw = THREE.MathUtils.degToRad(spec.yaw || 0);
          const pitch = THREE.MathUtils.degToRad(spec.pitch || 0);
          const roll = THREE.MathUtils.degToRad(spec.roll || 0);
          const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(-pitch, -yaw, roll, 'YXZ'));
          right = new THREE.Vector3(1, 0, 0).applyQuaternion(q).normalize();
          up = new THREE.Vector3(0, 1, 0).applyQuaternion(q).normalize();
        }

        const pRight = new THREE.Vector3(right.x * physical.x, right.y * physical.y, right.z * physical.z);
        const pUp = new THREE.Vector3(up.x * physical.x, up.y * physical.y, up.z * physical.z);
        const pixelSizeX = (1.5 * pRight.length()) / renderRes;
        const pixelSizeY = (1.5 * pUp.length()) / renderRes;

        return {
          canvas,
          width: canvas.width,
          height: canvas.height,
          renderRes: renderRes,
          source: 'gpu-slicer',
          quality: 'high',
          planeSpec: spec,
          pixelSizeUm: { x: pixelSizeX, y: pixelSizeY },
          channelState: _currentChannelState()
        };
      }
    }

    // BUG-008: rely on DeepZoomViewer.isActive() (the dead _deepZoomActive flag
    // was never set true, making this branch inert).
    if (typeof DeepZoomViewer !== 'undefined' && DeepZoomViewer.isActive()) {
      const canvas = document.querySelector('#deepzoom-container canvas');
      if (canvas) {
        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = canvas.width;
        tempCanvas.height = canvas.height;
        const ctx = tempCanvas.getContext('2d');
        ctx.drawImage(canvas, 0, 0);
        return {
          canvas: tempCanvas,
          width: tempCanvas.width,
          height: tempCanvas.height,
          source: 'deepzoom',
          quality: 'high',
          channelState: _currentChannelState(),
          pixelSizeUm: datasetMeta?.calibration?.pixelSizeUm || { x: 1, y: 1 }
        };
      }
    }

    // Default: 3D screenshot
    if (typeof VolumeViewer !== 'undefined' && VolumeViewer.getRenderer) {
      const renderer = VolumeViewer.getRenderer();
      if (renderer) {
        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = renderer.domElement.width;
        tempCanvas.height = renderer.domElement.height;
        const ctx = tempCanvas.getContext('2d');
        ctx.drawImage(renderer.domElement, 0, 0);
        return {
          canvas: tempCanvas,
          width: tempCanvas.width,
          height: tempCanvas.height,
          source: '3d',
          quality: '256x256',
          channelState: _currentChannelState(),
          pixelSizeUm: datasetMeta?.calibration?.pixelSizeUm || { x: 1, y: 1 }
        };
      }
    }
    
    return null;
  }

  function getSamplingVolume() {
    return VolumeViewer.getSamplingVolume();
  }

  function getDatasetMeta() {
    return datasetMeta ? JSON.parse(JSON.stringify(datasetMeta)) : null;
  }

  function getCurrentTimepoint() {
    return _currentTimepoint;
  }

  function getChannelState() {
    return _currentChannelState().map(channel => ({ ...channel }));
  }

  // ── Slice Inspector ─────────────────────────────────────

  // _initSlicer is now handled by the slice-inspector module.
  // This stub remains so workspace-restore code that calls ToolManager.activate('cut')
  // still has a valid _initSlicer reference if called before modules load.
  function _initSlicer() {
    if (typeof VolumeSlicer === 'undefined') return;
    // Delegate to module if already loaded
    const mod = typeof PluginRegistry !== 'undefined' ? PluginRegistry.getModule('slice-inspector') : null;
    if (mod) return; // module will init itself

    // Initialize slicer with renderer (material will be linked after first load)
    const r = VolumeViewer.getRenderer();
    if (r) {
      VolumeSlicer.init({ renderer: r, material: VolumeViewer.getMaterial() });
      if (VolumeViewer.getMaterial()) {
        VolumeSlicer.updateMaterial(VolumeViewer.getMaterial());
      }
    }

    // Mount preview canvas
    const mount = document.getElementById('slicer-preview-mount');
    if (mount) {
      mount.innerHTML = '';
      mount.appendChild(VolumeSlicer.getPreviewCanvas());
    }

    // Preset buttons
    document.querySelectorAll('.slicer-preset').forEach(btn => {
      btn.addEventListener('click', () => {
        const mode = btn.dataset.preset;
        document.querySelectorAll('.slicer-preset').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        _slicerSetSpec({ mode, yaw: 0, pitch: 0, roll: 0 });
        // Reset angle sliders
        _slicerSyncSlidersFromSpec();
      });
    });

    // Position slider
    _slicerBindSlider('slicer-position', 'slicer-val-pos', v => {
      _slicerSetSpec({ value: v / 100 });
    }, v => (v / 100).toFixed(2));

    // Angle sliders
    _slicerBindSlider('slicer-yaw', 'slicer-val-yaw', v => {
      _slicerSetSpec({ mode: 'oblique', yaw: v });
      _slicerSyncPresetButtons('oblique');
    }, v => `${v}°`);
    _slicerBindSlider('slicer-pitch', 'slicer-val-pitch', v => {
      _slicerSetSpec({ mode: 'oblique', pitch: v });
      _slicerSyncPresetButtons('oblique');
    }, v => `${v}°`);
    _slicerBindSlider('slicer-roll', 'slicer-val-roll', v => {
      _slicerSetSpec({ mode: 'oblique', roll: v });
      _slicerSyncPresetButtons('oblique');
    }, v => `${v}°`);

    // Slab
    _slicerBindSlider('slicer-slab', 'slicer-val-slab', v => {
      _slicerSetSpec({ slabThickness: v });
    }, v => String(v));

    // Projection mode
    document.getElementById('slicer-projection')?.addEventListener('change', e => {
      _slicerSetSpec({ projection: e.target.value });
    });

    // Open in Studio button
    document.getElementById('btn-slicer-studio')?.addEventListener('click', () => openStudio());

    // Listen to plane changes from 3D interaction → sync slicer
    VolumeViewer.onPlaneSpecChange(spec => {
      if (!VolumeSlicer.isVisible()) return;
      VolumeSlicer.setPlaneSpec(spec);
      _slicerSyncSlidersFromSpec();
      _slicerSyncPresetButtons(spec.mode);
    });
  }

  function _slicerSetSpec(partial) {
    const cur = VolumeSlicer.getPlaneSpec();
    const next = { ...cur, ...partial };
    delete next.orientation;
    delete next.normal;
    VolumeSlicer.setPlaneSpec(next);
    // Also update the 3D plane mesh
    VolumeViewer.setPlaneSpec(next, { notify: false });
  }

  function _slicerBindSlider(sliderId, labelId, onChange, format) {
    const slider = document.getElementById(sliderId);
    const label = document.getElementById(labelId);
    if (!slider) return;
    slider.addEventListener('input', () => {
      const v = Number(slider.value);
      if (label) label.textContent = format(v);
      onChange(v);
    });
  }

  function _slicerSyncSlidersFromSpec() {
    const spec = VolumeSlicer.getPlaneSpec();
    const set = (id, val, labelId, fmt) => {
      const el = document.getElementById(id);
      const lb = document.getElementById(labelId);
      if (el) el.value = val;
      if (lb) lb.textContent = fmt;
    };
    set('slicer-position', Math.round(spec.value * 100), 'slicer-val-pos', spec.value.toFixed(2));
    set('slicer-yaw', spec.yaw || 0, 'slicer-val-yaw', `${spec.yaw || 0}°`);
    set('slicer-pitch', spec.pitch || 0, 'slicer-val-pitch', `${spec.pitch || 0}°`);
    set('slicer-roll', spec.roll || 0, 'slicer-val-roll', `${spec.roll || 0}°`);
    set('slicer-slab', spec.slabThickness || 1, 'slicer-val-slab', String(spec.slabThickness || 1));
    const proj = document.getElementById('slicer-projection');
    if (proj) proj.value = spec.projection || 'single';
  }

  function _slicerSyncPresetButtons(mode) {
    document.querySelectorAll('.slicer-preset').forEach(b => {
      b.classList.toggle('active', b.dataset.preset === mode);
    });
  }

  function _slicerShow(visible) {
    const panel = document.getElementById('slice-inspector');
    if (!panel) return;
    panel.classList.toggle('hidden', !visible);
    if (typeof VolumeSlicer !== 'undefined') {
      VolumeSlicer.setVisible(visible);
      if (visible) {
        // Link material in case a volume has loaded since init
        const mat = VolumeViewer.getMaterial();
        if (mat) VolumeSlicer.updateMaterial(mat);
        // Default to center slice on first open
        const spec = VolumeSlicer.getPlaneSpec();
        if (spec.value >= 0.99 || spec.value <= 0.01) {
          _slicerSetSpec({ value: 0.5 });
          _slicerSyncSlidersFromSpec();
        }
      } else {
        // LEAK-002: tear down the slicer-sync overlay rAF loop when the slice
        // tool is turned off, otherwise the loop runs forever in the background.
        _slicerOverlayStop();
      }
    }
    // Show plane mesh in 3D
    VolumeViewer.setCutPlaneVisible(visible);
    _scheduleViewerResize();
  }

  // ── Deep Zoom 2D Mode — Delegated to js/modules/tools/deepzoom-2d/index.js ──

  // _bindDeepZoomToggle is now handled by the deepzoom-2d module.
  function _bindDeepZoomToggle() {
    // Delegated to js/modules/tools/deepzoom-2d/index.js
  }

  async function _enterDeepZoom() {
    const mod = typeof PluginRegistry !== 'undefined' ? PluginRegistry.getModule('deepzoom-2d') : null;
    if (mod?.impl?._enter) { await mod.impl._enter.call(mod.instance || mod.impl); return; }
    console.warn('[ViewerApp] deepzoom-2d module not loaded');
  }

  function _exitDeepZoom() {
    const mod = typeof PluginRegistry !== 'undefined' ? PluginRegistry.getModule('deepzoom-2d') : null;
    if (mod?.impl?._exit) { mod.impl._exit.call(mod.instance || mod.impl); return; }
  }

  function _updateDzSliceLabel() {
    const label = document.getElementById('dz-slice-label');
    if (!label || typeof DeepZoomViewer === 'undefined') return;
    label.textContent = `Z ${DeepZoomViewer.getCurrentSlice() + 1} / ${DeepZoomViewer.getSliceCount()}`;
  }


  // ── Z-Stack Browser ──────────────────────────────────────
  let _zstackActive = false;
  let _zstackCurrentSlice = 0;
  // Prevents echo loops when SYNC_ZSTACK_SLICE triggers _zstackGoToSlice in a receiving panel
  let _suppressZstackSync = false;
  // Prevents echo loops when SYNC_SLICER_SPEC triggers setPlaneSpec in a receiving panel
  let _suppressSlicerSync = false;

  // ── Slicer Sync Overlay ──────────────────────────────────
  // When a decompose-panel sibling receives SYNC_SLICER_SPEC, it can't cut
  // the 3D volume (the raymarcher shader has no cut-plane uniform). Instead
  // we overlay the VolumeSlicer's GPU-rendered 2D canvas on top of the WebGL
  // canvas — the same output as the slice inspector sidebar, fullscreen.
  let _slicerOverlayActive = false;
  let _slicerOverlayRafId  = null;

  function _ensureSlicerOverlay() {
    let overlay = document.getElementById('slicer-sync-overlay');
    if (overlay) return overlay;
    const container = document.querySelector('.viewer-canvas-container');
    if (!container) return null;
    overlay = document.createElement('div');
    overlay.id = 'slicer-sync-overlay';
    // Cover the canvas area, dark background (no data = black like the main canvas)
    overlay.style.cssText = [
      'position:absolute', 'inset:0', 'z-index:5', 'background:#000',
      'display:none', 'align-items:center', 'justify-content:center',
      'overflow:hidden'
    ].join(';');
    const canvas = document.createElement('canvas');
    canvas.id = 'slicer-sync-canvas';
    // Scale to fill the overlay while keeping the slice square
    canvas.style.cssText = 'width:100%;height:100%;object-fit:contain;image-rendering:auto;';
    overlay.appendChild(canvas);
    container.appendChild(overlay);
    return overlay;
  }

  function _slicerOverlayStart() {
    _slicerOverlayActive = true;
    const overlay = _ensureSlicerOverlay();
    if (!overlay) return;
    overlay.style.display = 'flex';
    // Cancel any previous loop
    if (_slicerOverlayRafId) { cancelAnimationFrame(_slicerOverlayRafId); _slicerOverlayRafId = null; }
    const loop = () => {
      if (!_slicerOverlayActive) return;
      if (typeof VolumeSlicer !== 'undefined') {
        const preview = VolumeSlicer.getPreviewCanvas();
        const dst = document.getElementById('slicer-sync-canvas');
        if (preview && dst) {
          // Sync canvas dimensions once (preview is 320×320)
          if (dst.width !== preview.width)  dst.width  = preview.width;
          if (dst.height !== preview.height) dst.height = preview.height;
          dst.getContext('2d')?.drawImage(preview, 0, 0);
        }
      }
      _slicerOverlayRafId = requestAnimationFrame(loop);
    };
    loop();
  }

  function _slicerOverlayStop() {
    _slicerOverlayActive = false;
    if (_slicerOverlayRafId) { cancelAnimationFrame(_slicerOverlayRafId); _slicerOverlayRafId = null; }
    const overlay = document.getElementById('slicer-sync-overlay');
    if (overlay) overlay.style.display = 'none';
  }

  function _applyZstackState(desired, slice = null) {
    // Delegate to zstack-browser module when loaded
    const mod = typeof PluginRegistry !== 'undefined' ? PluginRegistry.getModule('zstack-browser') : null;
    if (mod?.impl?.applyState) {
      mod.impl.applyState(desired, slice);
      return;
    }
    // Fallback: direct DOM manipulation before module loads
    _zstackActive = desired;
    const btn = document.getElementById('btn-toggle-zstack');
    if (btn) {
      btn.classList.toggle('btn-solid', _zstackActive);
      btn.classList.toggle('btn-ghost', !_zstackActive);
    }
    _zstackShow(_zstackActive);
    if (desired && Number.isFinite(slice) && slice > 0) {
      // ELE-14 (RACE-005): re-arm the echo guard INSIDE the deferred callback. The
      // receiver clears _suppressZstackSync synchronously (well before this 80ms
      // timer), so without this the deferred _zstackGoToSlice would re-broadcast
      // SYNC_ZSTACK_SLICE and ping-pong with the sibling panel. Restore prev to
      // keep nesting safe.
      setTimeout(() => {
        const prev = _suppressZstackSync;
        _suppressZstackSync = true;
        try { _zstackGoToSlice(slice); } finally { _suppressZstackSync = prev; }
      }, 80);
    }
  }

  // _bindZStackBrowser is now handled by the zstack-browser module.
  // This stub is kept for backward compatibility with code that may call it directly.
  function _bindZStackBrowser() {
    // Delegated to js/modules/tools/zstack-browser/index.js
  }

  function _zstackShow(visible) {
    const panel = document.getElementById('zstack-browser');
    if (!panel) return;
    panel.classList.toggle('zstack-hidden', !visible);
    if (visible) {
      // Force top-down XY view and lock rotation
      VolumeViewer.setView('xy');
      VolumeViewer.setRotationLocked(true);
      _zstackPopulateInfo();
      _zstackGoToSlice(0);
      _zstackDrawDiagram();
    } else {
      // Unlock rotation and reset clipping
      VolumeViewer.setRotationLocked(false);
      VolumeViewer.resetClipping();
      _zstackCurrentSlice = 0;
    }
    _scheduleViewerResize();
  }

  function _zstackGetDims() {
    const dims = datasetMeta?.dimensions || {};
    const vs = datasetMeta?.voxel_size || {};
    const z = Number(dims.z) || 1;
    const c = Number(dims.c) || 1;
    const vz = Number(vs.z) || 1;
    const totalRange = z > 1 ? (z - 1) * vz : vz;
    const interval = z > 1 ? vz : 0;
    return { z, c, vz, totalRange, interval };
  }

  function _zstackPopulateInfo() {
    const { z, c, vz, totalRange, interval } = _zstackGetDims();

    const set = (id, text) => { const el = document.getElementById(id); if (el) el.textContent = text; };
    set('zstack-total-slices', String(z));
    set('zstack-range', `${totalRange.toFixed(2)} µm`);
    set('zstack-interval', interval > 0 ? `${interval.toFixed(2)} µm` : '—');
    set('zstack-voxel-z', `${vz.toFixed(4)} µm`);
    set('zstack-channels', String(c));

    const slider = document.getElementById('zstack-slice-slider');
    if (slider) {
      slider.min = 0;
      slider.max = z - 1;
      slider.value = 0;
    }
  }

  function _zstackGoToSlice(index) {
    const { z, vz } = _zstackGetDims();
    const safeIndex = Math.max(0, Math.min(z - 1, index));
    _zstackCurrentSlice = safeIndex;

    const slider = document.getElementById('zstack-slice-slider');
    if (slider) slider.value = safeIndex;

    const label = document.getElementById('zstack-slice-label');
    const posLabel = document.getElementById('zstack-position-label');
    const posInfo = document.getElementById('zstack-position-info');

    if (label) label.textContent = `${safeIndex + 1} / ${z}`;
    const pos = safeIndex * vz;
    if (posLabel) posLabel.textContent = `${pos.toFixed(2)} µm`;
    if (posInfo) posInfo.textContent = `Slice ${safeIndex + 1} of ${z} — depth ${pos.toFixed(2)} µm`;

    // Show a slab of ~5 slices centered on this one so the raymarcher
    // accumulates enough color for bright, visible rendering
    const pad = 2; // 2 slices on each side = 5 total
    const loIdx = Math.max(0, safeIndex - pad);
    const hiIdx = Math.min(z, safeIndex + pad + 1);
    const lo = loIdx / z;
    const hi = hiIdx / z;
    VolumeViewer.setClipRange('z', lo, hi);

    _zstackDrawDiagram();

    // Broadcast to sibling decompose panels in compare mode.
    // _suppressZstackSync prevents echo when WE are the receiver of a SYNC_ZSTACK_SLICE.
    if (_isIframe && !_suppressZstackSync) {
      // SEC-012: restrict targetOrigin to this page's origin (no wildcard leak).
      window.parent.postMessage({
        type: 'SYNC_ZSTACK_SLICE',
        sliceIndex: safeIndex,
        sliceTotal: z,
        lo, hi,
        sourceIndex: _panelIndex
      }, Utils.trustedTargetOrigin());
    }
  }

  function _zstackNudge(delta) {
    const { z } = _zstackGetDims();
    let next = _zstackCurrentSlice + delta;
    next = Math.max(0, Math.min(z - 1, next));
    _zstackGoToSlice(next);
  }

  function _zstackDrawDiagram() {
    const canvas = document.getElementById('zstack-diagram-canvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const W = canvas.width;
    const H = canvas.height;
    ctx.clearRect(0, 0, W, H);

    const { z } = _zstackGetDims();
    if (z < 1) return;

    // Draw a straight isometric stack of planes (constant skew, no rotation)
    const maxVisible = Math.min(z, 40);
    const step = z > maxVisible ? z / maxVisible : 1;
    const planeCount = Math.min(z, maxVisible);

    const planeW = 130;
    const planeDepth = 14;
    const skewX = 20;
    const stackTop = 20;
    const stackBottom = H - 30;
    const stackRange = stackBottom - stackTop;

    // Find which visual plane is closest to _zstackCurrentSlice (exactly one)
    let closestPlane = 0;
    let closestDist = Infinity;
    for (let i = 0; i < planeCount; i++) {
      const ri = Math.round(i * step);
      const d = Math.abs(ri - _zstackCurrentSlice);
      if (d < closestDist) { closestDist = d; closestPlane = i; }
    }

    for (let i = 0; i < planeCount; i++) {
      const t = i / Math.max(1, planeCount - 1);
      const y = stackTop + t * stackRange;
      const cx = (W - planeW) / 2;
      const isSelected = (i === closestPlane);

      ctx.save();
      ctx.globalAlpha = isSelected ? 1.0 : 0.1;

      ctx.beginPath();
      ctx.moveTo(cx + skewX, y);
      ctx.lineTo(cx + planeW + skewX, y);
      ctx.lineTo(cx + planeW, y + planeDepth);
      ctx.lineTo(cx, y + planeDepth);
      ctx.closePath();

      if (isSelected) {
        ctx.fillStyle = 'rgba(80, 180, 255, 0.55)';
        ctx.strokeStyle = 'rgba(80, 200, 255, 0.95)';
        ctx.lineWidth = 2;
      } else {
        ctx.fillStyle = 'rgba(50, 90, 160, 0.3)';
        ctx.strokeStyle = 'rgba(100, 160, 220, 0.25)';
        ctx.lineWidth = 1;
      }
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }

    // Label
    ctx.save();
    ctx.font = 'bold 11px Inter, sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.textAlign = 'center';
    ctx.fillText(`Z ${_zstackCurrentSlice + 1} / ${z}`, W / 2, H - 6);
    ctx.restore();
  }

  return { 
    init,
    openStudio,
    getCurrentSliceResult,
    getSamplingVolume,
    getDatasetMeta,
    getCurrentTimepoint,
    getChannelState,
    getWorkspaceState: _getWorkspaceState,
    applyWorkspaceState: _applyWorkspaceState,
    // Exposed for early module-level TOGGLE_ZSTACK listener:
    _applyZstackState,
    _setPendingZstack: (v) => { _pendingZstackState = v; }, // v = {desired, slice}
    _isReady: () => _isInitialized
  };
})();

// Expose on window so parent frames (compare.js) can access via iframe.contentWindow
window.ViewerApp = ViewerApp;

// ─── CRITICAL: Install the APPLY_WORKSPACE_STATE listener NOW, synchronously, ───
// before ViewerApp.init() runs any awaits. compare.js sends the postMessage as
// soon as the iframe 'load' event fires (or via polling when ViewerApp is detected).
// _bindIframeSync() is called INSIDE init() after several awaits — by then the
// message may have already been delivered and lost. We install here to guarantee
// it is always caught, regardless of init() timing.
window.addEventListener('message', (e) => {
  if (!Utils.isTrustedMessageOrigin(e)) return;
  const data = e.data;
  if (!data || data.type !== 'APPLY_WORKSPACE_STATE' || !data.state) return;
  console.log('[ViewerApp] Early listener: APPLY_WORKSPACE_STATE received — routing to ViewerApp.applyWorkspaceState');
  ViewerApp.applyWorkspaceState(data.state);
});

// Early listener for TOGGLE_ZSTACK: compare.js sends this at iframe load time,
// before _bindIframeSync() (and its message listener) is set up inside init().
// If already initialized, apply immediately. Otherwise buffer inside the IIFE.
window.addEventListener('message', (e) => {
  if (!Utils.isTrustedMessageOrigin(e)) return;
  const data = e.data;
  if (!data || data.type !== 'TOGGLE_ZSTACK') return;
  const desired = !!data.state;
  const slice = data.slice ?? null;
  const payload = { desired, slice };
  // Always buffer first (safe even if init already ran)
  ViewerApp._setPendingZstack?.(payload);
  // If viewer already initialized, apply immediately; otherwise init() will consume the buffer
  if (ViewerApp._isReady?.()) {
    ViewerApp._applyZstackState?.(desired, slice);
  }
});

document.addEventListener('DOMContentLoaded', ViewerApp.init);

