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
  let _playbackFps = 10;
  let _preloadTimer = null;
  let _preloadedTimepoints = new Set();
  let _qualityProgressUnsub = null;
  let _brickManifest = null;
  let _volumeMeasurements = [];
  let _isInitialized = false;
  let _pendingWorkspaceState = null;
  let _pendingZstackState = null; // buffered TOGGLE_ZSTACK arriving before init()
  let _pendingPluginState = null; // plugin workspace state restored before PluginRegistry.initAll() ran
  let _volumeMeasureDraft = [];
  let _channelState = [];
  let _slicePreviewTimer = null;
  let _nativeSliceAbort = null;
  let _displayState = { backgroundPreset: 'dark', backgroundColor: '#000000' };
  let _volumeSourcePreference = 'webstack';
  let _urlStatePrompt = null; // in-flight "restore this shared view?" question

  function _perf() {
    return typeof PerfTelemetry !== 'undefined' ? PerfTelemetry : null;
  }

  // ── Dataset byte source ──────────────────────────────────────────────────────
  // A published dataset is read straight from the web-served DATA_WEB tree. A
  // dataset still being imported ("staging:<type>/<folder>", admin preview only)
  // lives in the uploads/ staging root, which is deliberately NOT reachable at a
  // URL — its bytes come back through the session-gated blob proxy instead. Both
  // forms answer the same shape, `<base>/<relative path>`, so every downstream
  // URL composition (metadata fetch, brick manifest, pack files, slice stacks)
  // works unchanged: the proxy's `path` query parameter simply absorbs the tail.
  const _STAGING_PREFIX = 'staging:';

  function _datasetBase(datasetPath) {
    const p = String(datasetPath || '');
    if (!p.startsWith(_STAGING_PREFIX)) return `DATA_WEB/${p}`;
    return `api/upload.php?action=blob&ds=${encodeURIComponent(p.slice(_STAGING_PREFIX.length))}&path=`;
  }

  // The directory a dataset lives in IS its type, published or staged. A path
  // naming no known type belongs to none — guessing one would gate the plugins
  // and the header label on a lie.
  function _datasetTypeOf(datasetPath) {
    const p = String(datasetPath || '');
    const bare = p.startsWith(_STAGING_PREFIX) ? p.slice(_STAGING_PREFIX.length) : p;
    return Utils.datasetTypeOfId(bare);
  }

  async function init() {
    const initPerfId = _perf()?.start('viewer.init');
    // 1. Init core
    Theme.init();
    // Instance config first so I18n.t() sees the brand/specimen tokens.
    await InstanceConfig.load();
    // PERF: I18n.init() and Catalog.load() are independent network fetches —
    // overlap them so the boot head waits on max(), not the sum, of the two.
    // Both must still be fully resolved before Catalog.getById (below) and the
    // v0.12.45 plugin-load order downstream; do NOT fold the plugin discovery in.
    await Promise.all([I18n.init(), Catalog.load()]);
    InstanceConfig.applyHead();
    InstanceConfig.applyDom();

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
        type: _datasetTypeOf(fallbackPath),
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

    _zDisplayScale = _loadZDisplayScale();
    _volumeMeasurements = MeasurementStore.list(datasetId, 'viewer');

    // Usage telemetry: count one dataset view per browser session. Skip admin
    // previews (mode=admin) so editing a dataset doesn't inflate its view count.
    if (!isAdmin) {
      try {
        const _vk = `lumen_view_${datasetId}`;
        if (!sessionStorage.getItem(_vk)) {
          sessionStorage.setItem(_vk, '1');
          navigator.sendBeacon?.(`api/telemetry.php?action=view&id=${encodeURIComponent(datasetMeta.path || datasetId)}`);
        }
      } catch (_) { /* private mode / no beacon — ignore */ }
    }

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
    document.title = `${datasetMeta.name} — ${InstanceConfig.get('brand.name', 'Lumen3D')}`;

    // Update UI Header
    document.getElementById('dataset-title').textContent = datasetMeta.name;
    document.getElementById('dataset-subtitle').textContent =
      `${Utils.datasetTypeLabel(datasetMeta.type)} - ${Utils.formatStage(datasetMeta.stage)} - ${Utils.formatDate(datasetMeta.date)}`;
    if (typeof AnnotationManager !== 'undefined') AnnotationManager.init({ items: [] });

    // A #state= link is somebody's *saved view*, not the dataset: it reopens their
    // camera, channel curves, measurements and tool layout on top of it. Ask which
    // one is wanted. Started here and only awaited once the volume and the plugins
    // are up, so the question is answered while the bricks stream rather than after.
    _urlStatePrompt = _promptUrlState().catch(err => {
      console.warn('[ViewerApp] Shared-view prompt failed; opening the dataset as it is.', err);
      return null;
    });

    if (isLive) {
      document.getElementById('timeline-panel').classList.remove('hidden');
    }

    // ── Auto-discover & pre-load plugin modules ───────────────
    // No hardcoded manifest: discover() resolves the folder list (live endpoint
    // → generated manifest → embedded default). MUST stay fully awaited here,
    // before any UI build (tools/shaders/channels lists) — the v0.12.45 invariant.
    if (typeof PluginRegistry !== 'undefined') {
      // Isolation barrier: a total plugin-subsystem failure (registry bug, broken
      // discovery payload, quota error mid-injection) degrades to a plugin-less
      // viewer — the 3D canvas must always boot (rule 1.1). Individual plugin
      // failures are already quarantined inside the registry; this catches the rest.
      try {
        const modulePaths = await PluginRegistry.discover('js/modules');
        // Only the plugins that cover the type being shown: a plugin naming its
        // `dataTypes` is taken at its word, so the photograph-only tools stay off
        // the volume viewer. Plugins declaring nothing predate the field and were
        // written for this page, hence allowUndeclaredDataTypes.
        await PluginRegistry.loadModules('js/modules', modulePaths, {
          dataType: datasetMeta.type,
          allowUndeclaredDataTypes: true
        });
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
      } catch (err) {
        console.error('[ViewerApp] Plugin subsystem failed — booting the viewer without plugins.', err);
      }
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
        // Never broadcast camera changes while the z-stack browser holds the view
        // top-down (slice mode): that forced XY framing would corrupt other panels'
        // cameras. Its 3D notch rotates freely and syncs like any other view.
        // _isInitialized gates the boot-time chatter: fitCameraToVolume fires during
        // init(), and in Compare that framing would be pushed onto every panel already
        // on screen — see the SYNC_CHANNELS emitter for the full rationale.
        if (_isIframe && _isInitialized && !_zstackLocksCamera()) {
          // SEC-012: restrict targetOrigin to this page's origin (no wildcard leak).
          window.parent.postMessage({ type: 'SYNC_CAMERA', value: state, sourceIndex: _panelIndex }, Utils.trustedTargetOrigin());
        }
        // Fan out to subscribed sandboxed plugins (projected payload; the view moved).
        if (typeof PluginSandbox !== 'undefined') {
          PluginSandbox.emit('camera', state);
          PluginSandbox.emit('render');
        }
      });
      // Broadcast full slicer plane spec to sibling decompose panels on every change.
      // Uses onPlaneSpecChange which fires for all plane mutations (position, yaw, pitch, roll, slab, mode).
      VolumeViewer.onPlaneSpecChange?.((spec) => {
        if (_suppressSlicerSync || _zstackActive || !_isInitialized) return;
        // SEC-012: restrict targetOrigin to this page's origin (no wildcard leak).
        window.parent.postMessage({
          type: 'SYNC_SLICER_SPEC',
          spec,
          sourceIndex: _panelIndex
        }, Utils.trustedTargetOrigin());
      });
    }
    
    // ── Resolve paths + camera-restore pre-set, then KICK OFF the volume load ──
    const datasetPath = datasetMeta.path || datasetMeta.id;
    const basePath = _datasetBase(datasetPath);
    _basePath = basePath;

    // Si un état caméra sera restauré après le chargement (URL hash ou iframe pending),
    // signaler au VolumeViewer de ne PAS appeler fitCameraToVolume lors du premier load.
    // Autrement, le preview changerait le cameraZ avant la restauration de l'état sauvé,
    // et la différence de scale preview/high causerait un décalage → écran noir.
    // MUST run before the volume kick-off below.
    const hasPendingCameraState = (window.location.hash && window.location.hash.startsWith('#state='))
      || (_pendingWorkspaceState && _pendingWorkspaceState?.viewer?.camera);
    if (hasPendingCameraState && VolumeViewer.setHasLoadedVolume) {
      VolumeViewer.setHasLoadedVolume(true);
      console.log('[ViewerApp] Pre-set _hasLoadedVolume=true to skip fitCameraToVolume (state will be restored)');
    }

    // Build the ViewerContext façade for module implementations. Every member is a
    // lazy accessor, so it is safe to build HERE — before the volume exists — which
    // is what lets prepareAll() run on the real context below.
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

    // Pre-load plugin lane. A module that sets the scene's INITIAL state — the
    // orientation plugin applying the dataset's saved default view — has to do it
    // now, on an empty canvas: initAll() runs after the volume is on screen, so the
    // same rotation there would show the specimen in one pose and snap it to
    // another while the bricks stream in. A pending workspace/URL state still wins,
    // it is restored further down.
    if (typeof PluginRegistry !== 'undefined' && PluginRegistry.prepareAll) {
      PluginRegistry.prepareAll(moduleCtx);
    }

    // PERF: start brick streaming + GPU upload NOW (without awaiting) so it overlaps
    // the synchronous _bind*/ChannelPanel wiring below. The load is awaited just past
    // ChannelPanel.init, so channel state is established before any frame renders: the
    // synchronous wiring runs to completion long before the first brick fetch resolves.
    _initStabilization();

    let volumeP;
    if (isLive) {
      // BUG-032 (Rule 1.4): a malformed live dataset may lack dimensions.t (or
      // dimensions entirely) -> reject explicitly instead of throwing a raw
      // TypeError on property access.
      const totalFrames = datasetMeta.dimensions?.t;
      if (!Number.isFinite(totalFrames) || totalFrames <= 0) {
        volumeP = Promise.reject(new Error('dataset live sans dimensions.t'));
      } else {
        _playbackFps = _loadPlaybackFps();
        Timeline.init('timeline-panel', {
          totalFrames: totalFrames,
          showSpeed: false,
          showSmooth: false,
          stepped: false,
          speedToggle: true,
          speedFps: _playbackFps
        }, (state) => {
          if (Number.isFinite(state.fps) && state.fps !== _playbackFps) {
            _playbackFps = state.fps;
            _savePlaybackFps();
          }
          // Playback ticks on every animation frame (timeline.js), so this fires ~60x/s
          // while the frame index only changes a few times a second. Without this guard
          // each tick re-entered the loader and bumped _activeLoadToken, cancelling the
          // load that was still in flight — during playback a timepoint could never
          // finish loading at all.
          _requestTimepoint(basePath, Math.round(state.frame));
        });
        // Load first frame
        volumeP = _loadTimepoint(basePath, 0);
      }
    } else {
      // Load single volume
      volumeP = _loadTimepoint(basePath, null);
    }
    // Prevent an unhandled-rejection warning during the overlap window; the real
    // error handling is the awaited try/catch below.
    volumeP.catch(() => {});

    // Bind UI controls (synchronous — overlaps the in-flight volume load above)
    _bindScreenshot();
    _bindQualityControls();
    _updateQualityOptionLabels();
    _bindVolumeControls();
    _bindZScaleControls();
    _bindDisplayControls();
    _bindVisualControls();
    _bindTooling();
    _bindExportAndWorkspace();
    // slice-inspector and zstack-browser modules self-initialize in PluginRegistry.initAll().
    _bindHamburgerMenu();
    _bindSidebarCollapse();
    if (_isIframe) _bindIframeSync();
    // Initialize Channel Panel
    ChannelPanel.init('channel-container', datasetMeta, (idx, params) => {
      _channelState[idx] = { ...params };
      VolumeViewer.updateChannel(idx, params);
      window.dispatchEvent(new CustomEvent('channels-updated'));
      if (typeof PluginSandbox !== 'undefined') PluginSandbox.emit('channels-updated');
      // ChannelPanel.init() pushes every channel through this callback to seed the
      // shader uniforms. That is not an operator edit, so it must not go out on the
      // wire: in Compare the parent relays it to the panels already open, which match
      // by channel NAME and adopt the newcomer's gamma/min/max/enabled wholesale.
      // Adding a dataset whose DAPI is gamma 5.5 next to one at 1.04 turned the first
      // panel black. _isInitialized is false until init() returns.
      if (_isIframe && _isInitialized && !_suppressChannelSync) {
        // SEC-012: restrict targetOrigin to this page's origin (no wildcard leak).
        window.parent.postMessage({ type: 'SYNC_CHANNELS', sourceIndex: _panelIndex, channelIndex: idx, value: params }, Utils.trustedTargetOrigin());
      }
    });
    _initTrackingLayer();

    // Operator-attached images (annotated captures, figures). datasetMeta is already
    // merged with metadata.json at this point, so the array is the authoritative one.
    if (typeof DatasetGallery !== 'undefined') {
      DatasetGallery.init({
        sectionId: 'gallery-section',
        containerId: 'gallery-container',
        basePath: _basePath,
        items: datasetMeta.gallery,
      });
    }

    // Await the volume load kicked off above (channel state is now established).
    try {
      await volumeP;
    } catch (err) {
      _perf()?.event('viewer.init.error', { message: err?.message || String(err) });
      _showLoadingError(err);
    }
    _renderVolumeMeasurement();
    if (window.lucide) lucide.createIcons();
    _perf()?.end(initPerfId, { status: 'ok', isLive, qualityMode: _qualityMode });

    // ELE-26: workspace/zstack restore moved BELOW PluginRegistry.initAll() (further down).
    // Applying saved plugin state (chunk-debug, measure-distance, zstack-browser, …) before
    // the plugins were initialised called setState()/applyState() on an uninitialised
    // instance (null _ctx / undefined fields) — it threw and the state was silently dropped.

    // ── Module System Integration ──────────────────────────────
    if (typeof PluginRegistry !== 'undefined') {

      // Initialize all loaded modules with the context. Same isolation barrier as
      // the load phase: per-plugin init failures are quarantined by the registry;
      // a registry-level throw must still leave the viewer alive.
      try {
        // Give the sandbox lane its capability target — a NARROW adapter (INV-8),
        // never the raw moduleCtx. Installed before bindToolbarButtons so a click
        // (→ activate → capability request) always finds it ready.
        if (typeof PluginSandbox !== 'undefined') {
          PluginSandbox.bindContext({
            ui: {
              toast: moduleCtx.ui.toast,
              downloadBlob: (blob, name) => {
                if (typeof ExportManager !== 'undefined' && ExportManager.downloadBlob) ExportManager.downloadBlob(blob, name);
              }
            },
            getCanvasBlob: moduleCtx.getCanvasBlob,
            viewer: {
              setRenderMode: (m) => moduleCtx.viewer.setRenderMode(m),
              renderModes: () => PluginRegistry.listByPlacement('shaders').map(s => s.id)
            },
            channels: { getState: moduleCtx.channels.getState },
            dataset: { meta: () => datasetMeta }
          });
        }
        await PluginRegistry.initAll(moduleCtx);
        PluginRegistry.bindToolbarButtons();
        // Live trust revocation: tear down a sandboxed plugin if the operator revokes
        // its approval while this viewer is open (polls the server trustEpoch).
        if (PluginRegistry.startTrustWatch) PluginRegistry.startTrustWatch();

        // Now that every module has its ViewerContext, flush any plugin workspace
        // state that _applyWorkspaceStateNow() captured before initAll() ran.
        if (_pendingPluginState) {
          PluginRegistry.setWorkspaceState(_pendingPluginState);
          _pendingPluginState = null;
        }
      } catch (err) {
        console.error('[ViewerApp] Plugin initialisation failed — continuing without plugin tools.', err);
      }

      const toolsCount = PluginRegistry.listByPlacement('tools').length;

      const shadersCount = PluginRegistry.listByPlacement('shaders').length;
      console.log(`[ViewerApp] PluginRegistry initialized — ${toolsCount} tools, ${shadersCount} shaders`);
    }

    // ELE-26: apply saved workspace + buffered z-stack state AFTER initAll, so plugin
    // setState()/applyState() run on fully-initialised plugin instances (_ctx + fields set).
    // The URL state is applied only if the operator asked for it (_promptUrlState).
    let restoredFromUrl = false;
    const urlChoice = await _urlStatePrompt;
    _urlStatePrompt = null;
    if (urlChoice?.choice === 'restore' && urlChoice.state) {
      _applyWorkspaceStateNow(urlChoice.state);
      restoredFromUrl = true;
    } else if (urlChoice?.choice === 'fresh') {
      UrlState.clearHash();
      // hasPendingCameraState suppressed the initial fitCameraToVolume on the
      // assumption a saved camera was coming; it is not — frame the volume now.
      VolumeViewer.resetView({ resetClipping: true });
    }
    if (_pendingWorkspaceState) {
      console.log('[ViewerApp] Applying pending workspace state after init, camera:', _pendingWorkspaceState?.viewer?.camera?.cameraZ, 'measurements:', _pendingWorkspaceState?.viewer?.measurements?.length);
      _applyWorkspaceStateNow(_pendingWorkspaceState);
      _pendingWorkspaceState = null;
    }

    // The two restores above ran while _isInitialized was still false, so the plugin
    // slice of what they carried was BUFFERED by the pre-initAll guard rather than
    // applied — and the flush inside the plugin block ran before them. Left here, a
    // restored view silently lost every plugin toggle it had recorded (grid, axes,
    // orientation gizmo, chunk overlay). initAll and bindToolbarButtons are long
    // done by now, so this is the point where that buffer must be drained.
    if (_pendingPluginState && typeof PluginRegistry !== 'undefined') {
      PluginRegistry.setWorkspaceState(_pendingPluginState);
      _pendingPluginState = null;
    }

    // Apply buffered TOGGLE_ZSTACK that arrived before init() completed
    if (_pendingZstackState !== null) {
      _applyZstackState(_pendingZstackState.desired, _pendingZstackState.slice);
      _pendingZstackState = null;
    }
    
    _isInitialized = true;
    
    if (!_isIframe && typeof UrlState !== 'undefined') {
      // pristine: nothing was restored, so the workspace on screen IS the dataset —
      // no #state= is written until the operator actually changes something, and a
      // reset can therefore hand the URL back clean.
      UrlState.startSync(_getWorkspaceState, 1000, { pristine: !restoredFromUrl });
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

    // On a phone the 320 px sidebar leaves the canvas about 55 px wide — no gesture
    // can rescue a view that narrow, so the volume gets the screen first and the
    // floating reopen button brings the controls back. Tablets are wide enough to
    // show both and are left alone.
    if (window.matchMedia('(max-width: 700px)').matches) _collapse();
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
      const resp = await fetch(`${_datasetBase(datasetPath)}/metadata.json`);
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
        // Identity, byte location and type are resolved before this fetch (the
        // catalog, or the admin ?path=) and the directory is what decides them.
        // metadata.json is read for what it describes, never to re-name the
        // dataset: a staged import's file still carries the folder it was
        // packed under, which is not where the viewer is reading from.
        id: datasetMeta.id,
        path: datasetMeta.path,
        type: datasetMeta.type || meta.type,
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
      // Repaint the buffer for the quality we just switched TO. Stepping back down to
      // one already loaded shows its frames immediately instead of an empty bar.
      _stopPrefetch();
      _refreshBuffer();
      if (_basePath) {
        _loadTimepoint(_basePath, _currentTimepoint, { force: true })
          .then(() => _kickPrefetch(200))
          .catch(_showLoadingError);
      }
    });
  }

  function _updateQualityOptionLabels() {
    const select = document.getElementById('select-quality');
    if (!select) return;
    const current = _normalizeQualityParam(_qualityMode || select.value) || '512x512';

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

  // CAP-008: inverse of the option labeling in _updateQualityOptionLabels — maps a LOD
  // index back to the <select> value it is shown under (lod 0 => 'native', else the
  // power-of-two label). Used to sync the selector to the resolution actually rendered.
  function _qualityValueForLod(lod, levels) {
    if (!Array.isArray(levels) || !levels[lod] || !levels[lod].dimensions) return null;
    if (lod === 0) return 'native';
    const dims = levels[lod].dimensions;
    const maxDim = Math.max(dims.x, dims.y, dims.z);
    const labelDim = Math.pow(2, Math.round(Math.log2(maxDim)));
    return `${labelDim}x${labelDim}`;
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

    const resetWorkspaceBtn = document.getElementById('btn-reset-workspace');
    if (resetWorkspaceBtn) {
      resetWorkspaceBtn.addEventListener('click', () => {
        _confirmResetWorkspace().catch(err => console.warn('[ViewerApp] Reset dialog failed:', err));
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
      resetBtn.addEventListener('click', _resetZDisplayScale);
    }
  }

  /** Display Z override back to 1:1 (the sidebar's 1:1 button and the reset both). */
  function _resetZDisplayScale() {
    _zDisplayScale = 1.0;
    const slider = document.getElementById('slider-z-scale');
    if (slider) slider.value = 100;
    VolumeViewer.setZDisplayScale(_zDisplayScale);
    _saveZDisplayScale();
    _updateZScaleLabel();
    _updatePhysicalStatus();
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
          // Prefer the shader's own lang dictionary (plugins.<id>.title), so
          // the render-mode label translates and re-translates on switch;
          // fall back to the plugin.json name.
          const nsKey = `plugins.${s.id}.title`;
          const label = _t(nsKey, nsKey);
          if (label !== nsKey) {
            opt.textContent = label;
            opt.setAttribute('data-i18n', nsKey);
          } else {
            opt.textContent = s.name;
          }
          if (s.default) defaultId = s.id;
          renderModeSelect.appendChild(opt);
        });
        if (shaders.length > 0) {
          if (!defaultId) defaultId = _defaultRenderModeId();
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
    if (exposureSlider) {
      exposureSlider.value = _defaultExposureSliderValue();
      exposureSlider.addEventListener('input', _syncExposureFromUi);
      _syncExposureFromUi();
    }

    // --- Background preset ---
    const select = document.getElementById('select-background-preset');
    const input = document.getElementById('input-background-color');
    if (!select) return;
    select.addEventListener('change', _syncBackgroundFromUi);
    input?.addEventListener('input', _syncBackgroundFromUi);
    _syncBackgroundFromUi();
    _updateVolumeSourceStatus();
  }

  // The display controls read their own widgets rather than taking a value, so the
  // binding above and the workspace reset below drive the volume through the exact
  // same path — one place decides what a slider position means.

  /** Render mode a freshly opened dataset uses: the shader flagged default. */
  function _defaultRenderModeId() {
    if (typeof PluginRegistry === 'undefined') return null;
    const shaders = PluginRegistry.listByPlacement('shaders');
    if (!shaders.length) return null;
    return (shaders.find(s => s.default) || shaders[0]).id;
  }

  /** Exposure slider position the dataset opens at (metadata override, else 1.00×). */
  function _defaultExposureSliderValue() {
    if (datasetMeta && Number.isFinite(datasetMeta.exposure)) {
      return Math.max(20, Math.min(500, Math.round(datasetMeta.exposure * 100)));
    }
    return 100;
  }

  /** Exposure currently applied, read from the slider that owns it. */
  function _currentExposure() {
    const slider = document.getElementById('slider-exposure');
    const val = slider ? parseInt(slider.value, 10) / 100 : 1;
    return Number.isFinite(val) ? val : 1;
  }

  function _syncExposureFromUi() {
    const slider = document.getElementById('slider-exposure');
    if (!slider) return;
    const label = document.getElementById('val-exposure');
    const val = parseInt(slider.value, 10) / 100;
    if (label) label.textContent = `${val.toFixed(2)}×`;
    VolumeViewer.setExposure(val);
    // _isInitialized gates the boot-time chatter, like the SYNC_CHANNELS emitter:
    // seeding the slider from the dataset's own metadata is not an operator edit, and
    // the admin preview counted every mount as an unsaved change because of it.
    if (_isIframe && _isInitialized) {
      // DEAD-021: include sourceIndex so compare.js's routing guard can attribute the
      // message; SEC-012: restrict targetOrigin to this page's origin (no wildcard leak).
      window.parent.postMessage({ type: 'SYNC_EXPOSURE', value: val, sourceIndex: _panelIndex }, Utils.trustedTargetOrigin());
    }
  }

  function _syncBackgroundFromUi() {
    const select = document.getElementById('select-background-preset');
    if (!select) return;
    const input = document.getElementById('input-background-color');
    document.getElementById('label-background-custom')?.classList.toggle('hidden', select.value !== 'custom');
    _displayState.backgroundPreset = select.value;
    if (input) _displayState.backgroundColor = input.value || _displayState.backgroundColor;
    VolumeViewer.setBackgroundPreset(_displayState.backgroundPreset, _displayState.backgroundColor);
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

    // The Studio used to open only once the native LOD0 slice had arrived. That is
    // hundreds of MB of packs for one plane (a 3789² dataset streams ~330 MB / 3160
    // bricks for a single XY cut), so the button did nothing for minutes. Open on the
    // plane the GPU already holds — costs one render, no network — and upgrade in
    // place once the native pass lands.
    // The Z-stack browser is not the slice inspector: its plane comes from the
    // browser's cursor and trim, not from the (hidden) inspector plane.
    const preview = _zstackActive
      ? _renderStudioPreviewSlice(_zstackStudioSpec())
      : _renderStudioPreviewSlice();
    const opening = preview || getCurrentSliceResult();
    if (!opening) return;
    StudioEditor.open(opening);

    if (preview) await _upgradeStudioSliceToNative(preview);
  }

  /**
   * What the Z-stack browser shows, as a slicer plane: the cursor's slices (every
   * kept slice in 3D mode) sampled one voxel per step and MIP-projected when the slab
   * is thicker than one slice — the calibrated 2D counterpart of the slab on screen.
   */
  function _zstackStudioSpec() {
    const { z } = _zstackGetDims();
    const mod = _zstackModule();
    const range = typeof mod?.impl?.getStudioSliceRange === 'function' ? mod.impl.getStudioSliceRange() : null;
    const clampZ = (v) => Math.max(0, Math.min(z - 1, Math.round(Number(v) || 0)));
    const lo = clampZ(range ? range.lo : Math.max(0, _zstackCurrentSlice));
    const hi = Math.max(lo, clampZ(range ? range.hi : lo));
    const n = hi - lo + 1;
    return {
      mode: 'xy',
      axis: 'z',
      // Slice i spans [i/z, (i+1)/z] of the normalised depth; the plane sits at the
      // slab's centre and the samples land on the voxel centres (lo + 0.5 + k) / z.
      value: (lo + n / 2) / z,
      yaw: 0,
      pitch: 0,
      roll: 0,
      slabThickness: n,
      slabStepNorm: 1 / z,
      projection: n > 1 ? 'mip' : 'single'
    };
  }

  /**
   * The Studio's opening image: the current plane rendered from the atlas already
   * resident on the GPU, framed exactly as the native pass will frame it so the
   * upgrade is a pixel swap and every annotation keeps its coordinates.
   * With an explicit `spec` the inspector plane is left untouched (it need not even
   * be shown): the render goes through a throwaway slicer material.
   */
  function _renderStudioPreviewSlice(spec = null) {
    if (typeof VolumeSlicer === 'undefined' || !VolumeSlicer.renderHighRes) return null;
    if (!spec && !VolumeSlicer.isVisible?.()) return null;
    if (spec && (!VolumeSlicer.renderWithMaterial || !VolumeViewer.getMaterial?.())) return null;
    const dims = (typeof BrickLoader !== 'undefined' && BrickLoader.isReady?.()) ? BrickLoader.getDimensions(0) : null;
    if (!dims) return null;
    const explicitPlane = !!spec;
    if (!spec) spec = VolumeSlicer.getPlaneSpec();
    const renderRes = _nativeStudioRenderSize(spec, dims);
    const rendered = explicitPlane
      ? VolumeSlicer.renderWithMaterial(VolumeViewer.getMaterial(), spec, renderRes, _currentChannelState())
      : VolumeSlicer.renderHighRes(renderRes);
    if (!rendered) return null;
    const cropRect = _sliceContentRect(rendered);
    const canvas = _cropEmptySliceSpace(rendered, cropRect);
    return {
      canvas,
      width: canvas.width,
      height: canvas.height,
      renderRes,
      cropRect,
      // Not 'gpu-slicer': that source makes the Studio re-render the slice through
      // VolumeSlicer.recompose at the cropped width, which reframes the image and
      // would break the geometry contract with the native pass.
      source: 'studio-preview',
      quality: 'preview',
      planeSpec: spec,
      pixelSizeUm: _slicePixelSizeUm(spec, renderRes),
      physicalSizeUm: VolumeViewer.getPhysicalSize?.(),
      channelState: _currentChannelState(),
      timepoint: _currentTimepoint
    };
  }

  async function _upgradeStudioSliceToNative(preview) {
    const onCancel = () => _cancelNativeSlice();
    const label = (chunks, total) => {
      const key = 'studio.loadingNative';
      const res = (typeof I18n !== 'undefined' && I18n.t) ? I18n.t(key, { chunks, total }) : key;
      return res === key ? `Native resolution: ${chunks}/${total} chunks` : res;
    };
    StudioEditor.setLoadProgress?.({ percent: 0, label: label(0, 0), onCancel });
    try {
      const sr = await _renderNativeSliceForStudio({
        spec: preview.planeSpec,
        cropRect: preview.cropRect,
        onProgress: ({ percent, chunks, totalChunks }) => {
          StudioEditor.setLoadProgress?.({ percent, label: label(chunks, totalChunks), onCancel });
        }
      });
      if (sr && StudioEditor.isOpen?.()) StudioEditor.setSliceResult(sr);
    } catch (err) {
      if (err?.name !== 'AbortError') {
        console.warn('[ViewerApp] Native Studio slice failed; keeping the active volume resolution:', err);
        _setSliceStatus('Native HD unavailable; using active volume resolution.');
      }
    } finally {
      StudioEditor.setLoadProgress?.(null);
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
      applyWorkspaceState: _applyWorkspaceState,
      getMeasurements: () => MeasurementStore.list(datasetId, 'viewer'),
      getAnnotations: () => (typeof AnnotationManager !== 'undefined' ? AnnotationManager.all() : [])
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

  /**
   * Spacing of the slicer's slab samples along `axis`, in normalised texture units —
   * the spec's own step when it names one, otherwise the slicer's historical 1/256 of
   * the longest physical axis converted onto that axis.
   */
  function _slabStepNorm(spec, axis) {
    const requested = Number(spec.slabStepNorm);
    if (Number.isFinite(requested) && requested > 0) return requested;
    const physical = VolumeViewer.getPhysicalSize?.();
    const p = physical && physical[axis] > 0 ? physical[axis] : 0;
    const maxP = physical ? Math.max(physical.x || 0, physical.y || 0, physical.z || 0) : 0;
    return p > 0 && maxP > 0 ? (1 / 256) * (maxP / p) : 1 / 256;
  }

  function _nativeSliceBricksForSpec(spec, dims) {
    if (typeof BrickLoader === 'undefined' || !BrickLoader.getDimensions) return [];
    const slabSteps = Math.max(1, Math.min(1024, Number(spec.slabThickness) || 1));
    const projected = slabSteps > 1 && spec.projection && spec.projection !== 'single';
    const axis = spec.mode === 'xz' ? 'y' : spec.mode === 'yz' ? 'x' : (!spec.mode || spec.mode === 'xy') ? 'z' : null;
    let bricks = null;
    if (axis && !projected) {
      bricks = BrickLoader.bricksForSlab(axis, spec.value ?? 0.5, 0);
    } else if (axis) {
      // A projected slab samples (steps - 1) / 2 steps either side of the plane; every
      // brick in that depth range has to be resident at LOD0, not just the plane's own.
      // One voxel of margin each way covers the sample footprint at the ends.
      const value = Number.isFinite(+spec.value) ? +spec.value : 0.5;
      const half = (slabSteps - 1) * _slabStepNorm(spec, axis) * 0.5 + 1 / Math.max(1, dims[axis] || 1);
      const min = { x: 0, y: 0, z: 0 };
      const max = { x: 0.9999, y: 0.9999, z: 0.9999 };
      min[axis] = Math.max(0, value - half);
      max[axis] = Math.min(0.9999, value + half);
      bricks = BrickLoader.bricksForRegion(min, max, 0);
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
    const shaderSlab = projected ? ((slabSteps - 1) * _slabStepNorm(spec, 'z') * 0.5) : 0;
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

  function _copyCanvas(canvas) {
    const out = document.createElement('canvas');
    out.width = canvas.width;
    out.height = canvas.height;
    out.getContext('2d').drawImage(canvas, 0, 0);
    return out;
  }

  /** Bounding box of the non-transparent pixels, padded — null when fully empty. */
  function _sliceContentRect(canvas) {
    if (!canvas) return null;
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
    if (minX > maxX || minY > maxY) return null;

    const padding = 10;
    return {
      x: Math.max(0, minX - padding),
      y: Math.max(0, minY - padding),
      x2: Math.min(canvas.width - 1, maxX + padding),
      y2: Math.min(canvas.height - 1, maxY + padding),
      renderRes: canvas.width
    };
  }

  /**
   * Crop to `rect` when one is supplied, else to the canvas's own content box.
   * The Studio hands the preview's rect back for the native pass so both images
   * frame the exact same region: annotation coordinates then survive the swap
   * untouched (the native pass resolves faint signal the preview LOD misses, so
   * recomputing the box would shift every layer by a few pixels).
   */
  function _cropEmptySliceSpace(canvas, rect = null) {
    if (!canvas) return canvas;
    let box = rect && Number.isFinite(rect.x) ? rect : null;
    if (box && box.renderRes && box.renderRes !== canvas.width) {
      const s = canvas.width / box.renderRes;
      box = { x: box.x * s, y: box.y * s, x2: box.x2 * s, y2: box.y2 * s };
    }
    if (!box) box = _sliceContentRect(canvas);
    // Nothing to crop to (empty plane). Still copy: `canvas` is VolumeSlicer's shared
    // _hiCanvas, which the next high-res render overwrites in place.
    if (!box) return _copyCanvas(canvas);

    const minX = Math.max(0, Math.round(box.x));
    const minY = Math.max(0, Math.round(box.y));
    const maxX = Math.min(canvas.width - 1, Math.round(box.x2));
    const maxY = Math.min(canvas.height - 1, Math.round(box.y2));
    if (minX > maxX || minY > maxY) return canvas;

    const cropped = document.createElement('canvas');
    cropped.width = maxX - minX + 1;
    cropped.height = maxY - minY + 1;
    cropped.getContext('2d').drawImage(canvas, minX, minY, cropped.width, cropped.height, 0, 0, cropped.width, cropped.height);
    return cropped;
  }

  /**
   * Channels the native slice has to download. A channel the operator has switched
   * off contributes nothing to the rendered plane, and each one is a full quarter of
   * the LOD0 traffic (one WebP pack set per channel) — on a 3789² dataset that is
   * ~80 MB of packs fetched and ~800 bricks decoded for pixels the shader discards.
   */
  function _nativeSliceChannels(channelCount) {
    const state = _currentChannelState();
    const wanted = [];
    for (let c = 0; c < channelCount; c++) {
      if (!Array.isArray(state) || !state[c] || state[c].enabled !== false) wanted.push(c);
    }
    return wanted.length ? wanted : Array.from({ length: channelCount }, (_, c) => c);
  }

  async function _renderNativeSliceForStudio(options = {}) {
    if (typeof BrickLoader === 'undefined' || typeof SVRManager === 'undefined' || typeof VolumeSlicer === 'undefined') return null;
    if (!BrickLoader.isReady?.() || !VolumeSlicer.renderWithMaterial || !VolumeViewer.getRenderer?.() || !VolumeViewer.getMaterial?.()) return null;

    _cancelNativeSlice(false);
    const dims = BrickLoader.getDimensions(0);
    if (!dims) return null;
    const channels = Math.max(1, Math.min(4, Number(dims.channels) || Number(datasetMeta?.dimensions?.c) || 1));
    // The plane the preview was framed on: the inspector's, or the one handed in
    // (the Z-stack browser's slab), so the native pass swaps pixels under the same frame.
    const spec = options.spec || VolumeSlicer.getPlaneSpec();
    const bricks = _nativeSliceBricksForSpec(spec, dims);
    if (!bricks.length) return null;

    const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
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
    // Scalar transport stores one pack set per channel, so a disabled channel is a
    // whole quarter of the traffic that never reaches a pixel. RGBA transport packs
    // all four together — there is nothing to skip there.
    const wantedChannels = rgbaTransport ? null : _nativeSliceChannels(channels);
    const perBrickTasks = rgbaTransport ? 1 : wantedChannels.length;
    const tasks = [];
    for (const brick of bricks) {
      if (rgbaTransport) tasks.push({ ...brick, channel: -1, lod: 0 });
      else {
        for (const c of wantedChannels) tasks.push({ ...brick, channel: c, lod: 0 });
      }
    }

    const status = (force = false) => {
      const now = performance.now?.() || Date.now();
      if (!force && now - lastStatusAt < 250) return;
      lastStatusAt = now;
      const pct = Math.round((doneTasks / Math.max(1, tasks.length)) * 100);
      _setSliceStatus(`Rendering native HD slice: ${writtenBricks}/${bricks.length} chunks, ${pct}%`);
      onProgress?.({ percent: pct, chunks: writtenBricks, totalChunks: bricks.length });
    };

    try {
      _setSliceStatus(`Preparing native HD slice (${bricks.length} LOD0 chunks)...`);
      onProgress?.({ percent: 0, chunks: 0, totalChunks: bricks.length });
      tempSvr.init(channels, dims, renderer, tempMaterial, { targetSlots: bricks.length });
      const pendingScalar = new Map();
      const bs = dims.brickSize || 64;

      await BrickLoader.loadBrickTasks(tasks, {
        concurrency: Math.min(32, Math.max(4, Number(navigator.hardwareConcurrency) || 8)),
        cancelPrevious: false,
        preserveOrder: true,
        streamOnly: true,
        cacheResults: false,
        // Bricks the viewer already decoded are free; writing this batch back would
        // evict its working set (a slice is thousands of bricks), so read only.
        readCache: true,
        // The loader runs its own AbortController, so aborting ours is invisible to
        // it: without this hook, closing the Studio left the whole LOD0 transfer
        // running to completion in the background.
        shouldAbort: () => controller.signal.aborted,
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
            if (pending.count >= perBrickTasks) {
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
      const cropRect = options.cropRect || _sliceContentRect(rendered);
      const canvas = _cropEmptySliceSpace(rendered, cropRect);
      _setSliceStatus(`Native HD slice ready (${writtenBricks} chunks).`);
      return {
        canvas,
        width: canvas.width,
        height: canvas.height,
        renderRes,
        cropRect,
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

  // ── Shared views & workspace reset ────────────────────────────────────────────

  /**
   * Translate with an English fallback for keys a locale may not carry yet.
   * `I18n` is a top-level `const` in its own classic script: a global LEXICAL
   * binding, reachable by bare name but NEVER as `window.I18n` (CLAUDE.md §8).
   * The `window.I18n &&` guards this file used to carry were therefore always
   * false, and every string behind one silently stayed English.
   */
  function _t(key, fallback, params) {
    if (typeof I18n === 'undefined' || !I18n.t) return fallback;
    const value = I18n.t(key, params);
    return value === key ? fallback : value;
  }

  /**
   * Decide what to do with a #state= carried by the URL.
   *
   * Returns `{choice, state}` — 'restore' adopts the saved view, 'fresh' opens the
   * dataset as it ships — or null when there is nothing to decide (no hash, a
   * compare panel, an undecodable payload). Escape and the backdrop resolve to
   * 'restore': that is what such a link did before this dialog existed, so a
   * dismissed question never silently discards a colleague's shared view.
   */
  async function _promptUrlState() {
    if (_isIframe || typeof UrlState === 'undefined' || !UrlState.hasState()) return null;

    const decoded = await UrlState.decodeState(window.location.hash);
    const state = decoded ? (decoded.state || decoded) : null;
    if (!state || typeof state !== 'object') {
      UrlState.clearHash();  // a corrupt payload is not worth asking about
      return null;
    }
    if (typeof Dialog === 'undefined') return { choice: 'restore', state };

    const choice = await Dialog.ask({
      icon: 'link',
      title: _t('viewer.urlState.title', 'This link carries a saved view'),
      message: _t('viewer.urlState.message', 'The address you opened stores a workspace: camera, channel settings, tools and measurements. Open that view, or start from the dataset as it is?'),
      note: _t('viewer.urlState.note', 'Starting fresh only clears the view stored in the link — nothing in the dataset changes.'),
      dismissId: 'restore',
      options: [
        {
          id: 'restore',
          primary: true,
          variant: 'primary',
          icon: 'history',
          label: _t('viewer.urlState.restore', 'Open the saved view'),
          hint: _t('viewer.urlState.restoreHint', 'Restores the camera, channels, tools and measurements stored in the link.')
        },
        {
          id: 'fresh',
          icon: 'sparkles',
          label: _t('viewer.urlState.fresh', 'Open the dataset as new'),
          hint: _t('viewer.urlState.freshHint', 'Ignores the saved view and removes it from the address bar.')
        }
      ]
    });
    return { choice: choice || 'restore', state };
  }

  async function _confirmResetWorkspace() {
    const hasMeasurements = MeasurementStore.list(datasetId, 'viewer').length > 0;
    const answer = typeof Dialog === 'undefined' ? 'reset' : await Dialog.ask({
      icon: 'eraser',
      tone: 'danger',
      layout: 'row',
      title: _t('viewer.reset.title', 'Reset the workspace?'),
      message: _t('viewer.reset.message', 'View, tools, channels and display settings go back to how this dataset opens.'),
      note: hasMeasurements
        ? _t('viewer.reset.noteMeasurements', 'Measurements and annotations of this session are deleted. Render quality is left as it is.')
        : _t('viewer.reset.note', 'Render quality is left as it is.'),
      dismissId: 'cancel',
      options: [
        { id: 'cancel', label: _t('app.cancel', 'Cancel') },
        { id: 'reset', variant: 'danger', primary: true, label: _t('viewer.reset.confirm', 'Reset') }
      ]
    });
    if (answer !== 'reset') return;
    resetWorkspace();
  }

  /**
   * Put the viewer back to the state a freshly opened dataset has, in place — no
   * reload, and the URL loses its #state= instead of having to be edited by hand.
   *
   * Deliberately NOT reset: the render quality and the volume source. Those are
   * device/bandwidth preferences, and dropping a native-resolution session back to
   * 512³ would silently start a multi-minute re-stream. The saved workspace
   * snapshot (Download Center → "Save state") is likewise untouched: it is an
   * explicit save, not session state.
   */
  function resetWorkspace() {
    // 1. Plugins first: they own the panels and toolbar toggles, and several of
    //    them touch clipping on the way down. The viewer-level reset then wins.
    if (typeof PluginRegistry !== 'undefined' && PluginRegistry.resetAll) PluginRegistry.resetAll();
    if (typeof ToolManager !== 'undefined') ToolManager.activate('navigate');

    // 2. Camera, cube pose (back to the dataset's own default view when it has
    //    one — resetView returns to the home quaternion), clipping and cut plane.
    VolumeViewer.resetView({ resetClipping: true });
    VolumeViewer.setCutPlaneVisible(false);
    _resetClipSliders();

    // 3. Measurements + annotations.
    MeasurementStore.clear(datasetId, 'viewer');
    _volumeMeasurements = [];
    _volumeMeasureDraft = [];
    VolumeViewer.setMeasurements([]);
    _renderVolumeMeasurement();
    if (typeof AnnotationManager !== 'undefined') AnnotationManager.clear();

    // 4. Channels back to the dataset's display defaults (colour, gamma, min/max,
    //    denoise σ, visibility) — re-derived from metadata, not from a snapshot.
    ChannelPanel.reset?.();
    _channelState = ChannelPanel.getState?.() || [];

    // 5. Display: render mode, exposure, background, Z override.
    const renderModeSelect = document.getElementById('select-render-mode');
    const defaultRenderMode = _defaultRenderModeId();
    if (renderModeSelect && defaultRenderMode) {
      renderModeSelect.value = defaultRenderMode;
      PluginRegistry.activate(defaultRenderMode);
    }
    const exposureSlider = document.getElementById('slider-exposure');
    if (exposureSlider) {
      exposureSlider.value = _defaultExposureSliderValue();
      _syncExposureFromUi();
    }
    const backgroundSelect = document.getElementById('select-background-preset');
    const backgroundInput = document.getElementById('input-background-color');
    if (backgroundSelect) backgroundSelect.value = 'dark';
    if (backgroundInput) backgroundInput.value = '#000000';
    _syncBackgroundFromUi();
    _resetZDisplayScale();

    // 6. Chrome: sidebar back out (with its floating reopen button), presentation
    //    mode already dropped by its plugin.
    if (!_isIframe) {
      document.querySelector('.viewer-sidebar')?.classList.remove('sidebar-hidden');
      const reopenBtn = document.getElementById('btn-reopen-sidebar');
      if (reopenBtn) reopenBtn.style.display = 'none';
      _scheduleViewerResize();
    }

    // 7. Timelapses reopen on their first timepoint.
    if (isLive && typeof Timeline !== 'undefined' && _currentTimepoint) {
      Timeline.setFrame(0);
    }

    // 8. The URL goes back to the bare dataset link — rebaseline() drops the hash
    //    at once, then waits out the asynchronous tail of the steps above (channel
    //    notifies, a timepoint load) before deciding what "unchanged" now means, so
    //    the sync cannot re-stamp a #state= describing the reset itself.
    if (typeof UrlState !== 'undefined') UrlState.rebaseline({ settleMs: 1200 });

    if (typeof PluginSandbox !== 'undefined') PluginSandbox.emit('channels-updated');
    window.dispatchEvent(new CustomEvent('channels-updated'));
    if (typeof ExportManager !== 'undefined') {
      ExportManager.toast(_t('viewer.reset.done', 'Workspace reset'));
    }
    _perf()?.event('viewer.workspace.reset', { datasetId });
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
        // _applyWorkspaceStateNow has always restored an exposure — nothing ever
        // WROTE one, so a shared view or a saved workspace silently dropped it.
        exposure: _currentExposure(),
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
    // Only a timelapse has a playback rate; on a still volume the key would be
    // noise in the saved workspace.
    if (isLive) state.viewer.playbackFps = _playbackFps;
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
      // Same reason the boot seeding stays silent (see the SYNC_CHANNELS emitter):
      // restoring a whole state is not a per-channel operator edit. It usually IS the
      // parent's own state coming back down — the admin preview mounts with the draft
      // channels — and echoing it made the panel read its own push as an unsaved edit.
      // The callback still runs, so the shader uniforms follow; only the wire is quiet.
      _suppressChannelSync = true;
      try { ChannelPanel.setState?.(viewerState.channels, { notify: true }); }
      finally { _suppressChannelSync = false; }
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

    // Z-stack browser: the zstack-browser plugin owns the panel and restores itself
    // from state.plugins (mode, cursor, thickness, trim). A workspace saved before the
    // plugin wrote that entry only carries the viewer-level pair; it is lifted into the
    // plugin state so a single path restores both. In iframe mode (compare), the parent
    // compare.js drives the browser via TOGGLE_ZSTACK instead.
    if (!_isIframe && typeof viewerState.zstackActive === 'boolean') {
      const mod = _zstackModule();
      if (mod?.impl?.setState) {
        if (!state.plugins?.['zstack-browser']) {
          state.plugins = {
            ...(state.plugins || {}),
            'zstack-browser': { zstackActive: viewerState.zstackActive, zstackSlice: viewerState.zstackSlice }
          };
        }
      } else {
        _applyZstackState(false, null);
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

    if (isLive && Number.isFinite(viewerState.playbackFps)) {
      // The onChange callback wired at init() picks the new rate up and persists it.
      Timeline.setSpeed?.(viewerState.playbackFps);
    }

    if (isLive && Number.isFinite(viewerState.timepoint)) {
      Timeline.setFrame(viewerState.timepoint);
    } else if (_basePath && viewerState.qualityMode) {
      _loadTimepoint(_basePath, _currentTimepoint, { force: true }).catch(_showLoadingError);
    }
    _updateVolumeSourceStatus();

    // Restore plugin states. During the initial page load this runs before
    // PluginRegistry.initAll() has handed each module its ViewerContext (this._ctx
    // is still null), so a plugin's setState would throw. Defer to the deferred-apply
    // hook right after initAll(); at runtime (_isInitialized) apply immediately.
    if (state.plugins && typeof PluginRegistry !== 'undefined') {
      if (_isInitialized) {
        PluginRegistry.setWorkspaceState(state.plugins);
      } else {
        _pendingPluginState = state.plugins;
      }
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
            <input type="text" value="${Utils.escapeHtml(item.label || '')}" placeholder="${Utils.escapeHtml(_t('plugins.measure-distance.labelPlaceholder', 'Label'))}" class="form-input text-xs" style="flex: 1; min-width: 0; width: 50px; padding: 2px 4px; background: rgba(0,0,0,0.2); border: 1px solid var(--border-light); color: var(--text-primary); border-radius: 4px;" data-volume-measure-action="rename" data-measurement-id="${Utils.escapeHtml(item.id)}">
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

  // ─── 4D stabilisation ────────────────────────────────────────────────────────
  // metadata.registration carries, per timepoint, the rigid transform the tracking
  // analysis used to cancel the specimen's global motion. Applying it to the volume
  // puts images and tracks in the same frame. It is offered only when the transform
  // was verified rigid at import time (qcSummary.rigid) — a non-rigid one would
  // deform the images and is refused rather than approximated.
  let _registration = null;
  let _stabilizeVolume = false;

  // ── Background buffering ──────────────────────────────────────────────────────
  // Fills the cache for frames that are NOT on screen, so switching quality no longer
  // means playing the whole series once to make it smooth. Strictly cooperative: it
  // never runs while a display load is in flight, it yields between frames, and it
  // stops as soon as the resident window is full rather than churning its own work.
  let _pfGeneration = 0;
  let _pfRunning = false;
  let _pfTimer = null;

  function _stopPrefetch() {
    _pfGeneration++;
    if (_pfTimer) { clearTimeout(_pfTimer); _pfTimer = null; }
    VolumeViewer.cancelPreload?.();
  }

  // Backgrounding the tab freezes requestAnimationFrame, and the brick streamer awaits
  // a paint (_yieldToPaint) — a prefetch caught there never finishes. Abandon it on the
  // way out and start again on the way back in, rather than leaving a job wedged.
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) _stopPrefetch();
      else _kickPrefetch(800);
    });
  }

  /** Debounced kick — called after a frame lands and after a quality change, both of
   *  which happen in bursts. */
  function _kickPrefetch(delay = 400) {
    if (_pfTimer) clearTimeout(_pfTimer);
    _pfTimer = setTimeout(() => { _pfTimer = null; _runPrefetch(); }, delay);
  }

  async function _runPrefetch() {
    if (_pfRunning) return;
    // Never in a compare panel: compare mounts up to four iframes, each a full
    // document with its own VolumeViewer, budget and WebGL context — four
    // simultaneous prefetches of the same series would quadruple both.
    if (!isLive || _isIframe || !_basePath || document.hidden) return;
    // Bricked datasets only: the slice path has no way to load without displaying.
    if (!_brickManifest) return;
    const total = Number(datasetMeta?.dimensions?.t) || 0;
    if (total < 2) return;

    const gen = ++_pfGeneration;
    _pfRunning = true;
    try {
      const quality = _qualityMode;
      for (let step = 1; step <= total; step++) {
        if (gen !== _pfGeneration || document.hidden || quality !== _qualityMode) break;
        const t = ((_currentTimepoint || 0) + step) % total;
        if (VolumeViewer.hasCachedVolume?.(_basePath, quality, t)) continue;

        // Stop once the series fills the window it is allowed to occupy. Without this
        // the prefetcher would keep going round evicting the frames it just loaded.
        const capacity = VolumeViewer.getBufferCapacity?.(_basePath, quality) || 0;
        const resident = VolumeViewer.getCachedTimepoints?.(_basePath, quality)?.size || 0;
        if (capacity && resident >= capacity) break;

        // Let the displayed frame through first, always.
        let waited = 0;
        while (_tpInFlight && gen === _pfGeneration && waited < 10000) {
          await new Promise(r => setTimeout(r, 120));
          waited += 120;
        }
        if (gen !== _pfGeneration || document.hidden || quality !== _qualityMode) break;

        const res = await VolumeViewer.loadBrickedVolumeStream(
          _basePath, datasetMeta, t, null, { quality, preload: true });
        // 'busy' means a display load started underneath us: back off and let the
        // next kick resume, rather than fighting it frame after frame.
        if (res && res.available === false && res.reason === 'busy') break;
        if (gen !== _pfGeneration) break;
        _refreshBuffer();
        await new Promise(r => setTimeout(r, 0));   // keep the main thread breathing
      }
    } catch (err) {
      console.warn('[ViewerApp] prefetch stopped:', err?.message || err);
    } finally {
      _pfRunning = false;
    }
  }

  /** Paint the scrubber's buffer from what is ACTUALLY resident at the current
   *  quality, and tell the cache where playback is so eviction keeps the frames we
   *  are about to need. The old bar counted "timepoints ever visited", a set that is
   *  never cleared and never shrinks — so it read full while half the series had been
   *  evicted, and it never reset when the quality changed. */
  function _refreshBuffer() {
    if (!isLive || !_basePath) return;
    const total = Number(datasetMeta?.dimensions?.t) || 0;
    VolumeViewer.setPlayheadHint?.(_basePath, _qualityMode, _currentTimepoint || 0, total);
    const resident = VolumeViewer.getCachedTimepoints?.(_basePath, _qualityMode);
    if (!resident) return;
    Timeline.updateBuffer(resident);
    const capacity = VolumeViewer.getBufferCapacity?.(_basePath, _qualityMode) || 0;
    _setBufferStatus(resident.size, total, capacity);
  }

  /** Its own element: _setQualityStatus is rewritten on every single frame load, so a
   *  buffer count written there would be wiped several times a second during playback. */
  function _setBufferStatus(resident, total, capacity) {
    const el = document.getElementById('buffer-status');
    if (!el || !total) return;
    const label = _qualityLabel(_qualityMode);
    if (capacity && capacity < total) {
      el.textContent = _tt('js.bufferPartial', 'Tampon {n}/{total} · {q} — la série entière ne tient pas en mémoire ({cap} images max)')
        .replace('{n}', resident).replace('{total}', total).replace('{q}', label).replace('{cap}', capacity);
    } else {
      el.textContent = _tt('js.bufferFull', 'Tampon {n}/{total} · {q}')
        .replace('{n}', resident).replace('{total}', total).replace('{q}', label);
    }
  }

  let _trackingHandle = null;

  /** t() returns the KEY when a locale file lags behind; fall back to readable text
   *  rather than showing "js.trackingSize" in the sidebar. */
  function _tt(key, fallback) {
    const v = (typeof I18n !== 'undefined') ? I18n.t(key) : key;
    return (v && v !== key) ? v : fallback;
  }

  /** Tracked centroids as a sidebar LAYER — same shell as a channel (visibility,
   *  disclosure, status line) minus the histogram, which would mean nothing for a
   *  point cloud. Silent no-op for a dataset without tracking. */
  function _initTrackingLayer() {
    const meta = datasetMeta?.tracking;
    if (!meta?.tracksPath || typeof TrackingOverlay === 'undefined') return;

    // The overlay needs the acquisition box to place points. It is normally
    // declared by _initStabilization, but that bails when the registration was
    // rejected — and a rejected registration must not cost the operator the
    // overlay. Re-declare it with a NULL display box: passing imageBoxUnionUm here
    // would resize the cube to the stabilised sweep while the shader warp stays
    // off, stretching the volume and pushing the camera back.
    if (!VolumeViewer.getAcquisitionSpace?.() && datasetMeta?.acquisitionExtentUm?.min) {
      VolumeViewer.setStabilizationSpace?.(datasetMeta.acquisitionExtentUm, null);
    }
    const space = VolumeViewer.getAcquisitionSpace?.();
    if (!space) {
      console.warn('[ViewerApp] tracking present but no acquisitionExtentUm — layer not shown');
      return;
    }

    const ready = TrackingOverlay.init({
      volumeObject: VolumeViewer.getVolumeObject?.(),
      umToObject: VolumeViewer.umToObject,
      isInsideClip: VolumeViewer.isInsideClip,
      acqSize: space.size,
      onDirty: VolumeViewer.triggerRender
    });
    if (!ready) return;

    const style = TrackingOverlay.getStyle();
    _trackingHandle = ChannelPanel.registerLayer({
      id: 'tracking',
      title: _tt('js.trackingLayer', 'Points de suivi'),
      swatch: meta.regions?.[0]?.color || '#2ecc71',
      summary: _tt('js.trackingLoading', 'Chargement du suivi…'),
      expanded: true,
      body: () => {
        const regions = TrackingOverlay.isLoaded()
          ? TrackingOverlay.getRegions()
          : (Array.isArray(meta.regions) ? meta.regions : []);
        const legend = regions.map(r => `
          <span class="layer-legend-item">
            <span class="channel-swatch" style="background:${Utils.escapeHtml(r.color || '#888')}"></span>
            ${Utils.escapeHtml(r.name || '')}<span class="layer-legend-count">${Number(r.cells) || 0}</span>
          </span>`).join('');
        return `
          <div class="layer-row">
            <label for="tracking-size">${_tt('js.trackingSize', 'Taille (µm)')}</label>
            <input type="range" id="tracking-size" min="2" max="40" step="1" value="${style.diameterUm}">
            <output id="tracking-size-out">${style.diameterUm}</output>
          </div>
          <div class="layer-row">
            <label for="tracking-opacity">${_tt('js.trackingOpacity', 'Opacité')}</label>
            <input type="range" id="tracking-opacity" min="10" max="100" step="5" value="${Math.round(style.opacity * 100)}">
            <output id="tracking-opacity-out">${Math.round(style.opacity * 100)}%</output>
          </div>
          <div class="layer-legend">${legend}</div>`;
      },
      bind: (root) => {
        const size = root.querySelector('#tracking-size');
        const sizeOut = root.querySelector('#tracking-size-out');
        const op = root.querySelector('#tracking-opacity');
        const opOut = root.querySelector('#tracking-opacity-out');
        size?.addEventListener('input', () => {
          const v = Number(size.value);
          if (sizeOut) sizeOut.textContent = String(v);
          TrackingOverlay.setStyle({ diameterUm: v });
        });
        op?.addEventListener('input', () => {
          const v = Number(op.value);
          if (opOut) opOut.textContent = `${v}%`;
          TrackingOverlay.setStyle({ opacity: v / 100 });
        });
      },
      onVisibility: (v) => TrackingOverlay.setStyle({ visible: v })
    });

    const onTimepoint = (ev) => {
      const d = ev.detail || {};
      // Read the stabilisation flag off the EVENT, never by asking the viewer
      // again: the two can disagree for one frame while a load settles.
      if (!TrackingOverlay.hasRawCoordinates() && !d.stabilized) {
        TrackingOverlay.setStyle({ visible: false });
        _trackingHandle?.setSummary(_tt('js.trackingNoRaw',
          'Coordonnées brutes absentes : suivi masqué sur un volume non stabilisé'));
        return;
      }
      TrackingOverlay.setFrame(d.frame, { stabilized: d.stabilized });
      _trackingHandle?.setSummary(
        `${TrackingOverlay.getCount()} / ${Number(meta.cellCount) || 0} ${_tt('js.trackingCells', 'cellules')}`);
    };
    window.addEventListener('viewer-timepoint-ready', onTimepoint);
    window.addEventListener('pagehide', () => {
      window.removeEventListener('viewer-timepoint-ready', onTimepoint);
      TrackingOverlay.dispose();
    });

    TrackingOverlay.load(_basePath, meta, (p) => {
      if (p.phase === 'download') {
        _trackingHandle?.setSummary(`${_tt('js.trackingLoading', 'Chargement du suivi…')} ${Math.round(p.pct * 100)}%`);
      } else if (p.phase === 'parse' || p.phase === 'bake') {
        _trackingHandle?.setSummary(_tt('js.trackingPreparing', 'Préparation des pistes…'));
      }
    }).then(() => {
      TrackingOverlay.setFrame(_currentTimepoint || 0, { stabilized: Boolean(VolumeViewer.isStabilized?.()) });
      _trackingHandle?.refreshBody();
      _trackingHandle?.setSummary(
        `${TrackingOverlay.getCount()} / ${Number(meta.cellCount) || 0} ${_tt('js.trackingCells', 'cellules')}`);
    }).catch(err => {
      console.warn('[ViewerApp] tracking overlay failed:', err);
      _trackingHandle?.setSummary(_tt('js.trackingUnavailable', 'Suivi indisponible'));
    });
  }

  function _initStabilization() {
    _registration = null;
    _stabilizeVolume = false;
    const reg = datasetMeta?.registration;
    if (!reg || !Array.isArray(reg.transforms) || !reg.transforms.length) return;
    if (!reg.appliedToVolume) {
      console.info('[ViewerApp] registration present but not applicable to the volume:',
        reg.qcSummary?.warnings || 'see qcSummary');
      return;
    }
    const extent = datasetMeta.acquisitionExtentUm;
    if (!extent?.min || !extent?.max) {
      console.warn('[ViewerApp] registration ignored: dataset has no acquisitionExtentUm');
      return;
    }
    _registration = reg;
    VolumeViewer.setStabilizationSpace?.(extent, reg.imageBoxUnionUm || null);
    _stabilizeVolume = true;
  }

  function _transformForTimepoint(t) {
    if (!_registration) return null;
    const frame = Number.isFinite(t) ? t : 0;
    const row = _registration.transforms.find(r => r.index === frame);
    return row?.matrix || null;
  }

  function _applyStabilization(t) {
    if (!_registration) return;
    VolumeViewer.setTimepointTransform?.(_stabilizeVolume ? _transformForTimepoint(t) : null);
  }

  /** Toggle between the stabilised frame and the raw acquisition frame. */
  function setVolumeStabilized(enabled) {
    if (!_registration) return false;
    _stabilizeVolume = Boolean(enabled);
    _applyStabilization(_currentTimepoint);
    return _stabilizeVolume;
  }

  const _tpSeen = new Set();
  let _tpLoadStart = 0;
  let _tpInFlight = false;
  let _tpPending = null;

  // Serialising the LOADER was only half of it: the playback clock still advanced on
  // wall time, so a 600 ms native frame let the head run ~6 frames ahead and the loader
  // was redirected before the frame it had just finished was ever shown. Holding the
  // head closes that loop — playback runs at the speed frames actually arrive.
  //
  // Deliberately STATELESS, no in-flight counter. A load can legitimately never settle
  // (background the tab mid-stream and requestAnimationFrame freezes, while the brick
  // streamer awaits a paint), and a counter would then sit above zero for the rest of
  // the session with the gate silently disabled — the failure is invisible, which is
  // worse than the thing it guards against. Releasing on every completion can at most
  // re-open the clock early during the rare overlap of two loads (a quality switch
  // fired mid-stream), and the next tick re-arms it.
  function _holdPlayback() {
    if (typeof Timeline !== 'undefined') Timeline.setStalled?.(true);
  }
  function _releasePlayback() {
    if (typeof Timeline !== 'undefined') Timeline.setStalled?.(false);
  }

  /** Serialise timepoint loads, keeping only the LATEST request while one is running.
   *
   *  Playback asks for a new frame roughly every 100 ms; at full resolution a frame
   *  costs more than that to fetch, decode and upload. Firing each request immediately
   *  meant every frame cancelled the one still in flight, so nothing ever finished and
   *  the console filled with AbortError. Following the loader's own pace plays slower
   *  than requested but actually shows frames, and intermediate frames are dropped
   *  rather than queued so playback never falls behind the scrubber. */
  function _requestTimepoint(basePath, frame) {
    if (!Number.isFinite(frame)) return;
    if (_tpInFlight) {
      _tpPending = (frame === _currentTimepoint) ? null : frame;
      return;
    }
    if (frame === _currentTimepoint) return;
    _tpInFlight = true;
    _loadTimepoint(basePath, frame)
      .catch(_showLoadingError)
      .finally(() => {
        _tpInFlight = false;
        const next = _tpPending;
        _tpPending = null;
        if (next !== null) _requestTimepoint(basePath, next);
      });
  }

  /** Wrapper so EVERY caller holds the playhead — the quality select, the workspace
   *  restore and the initial load all reach _loadTimepoint without going through
   *  _requestTimepoint's serialisation. */
  function _loadTimepoint(basePath, t, opts = {}) {
    _holdPlayback();
    return _loadTimepointInner(basePath, t, opts).finally(_releasePlayback);
  }

  async function _loadTimepointInner(basePath, t, opts = {}) {
    _tpLoadStart = performance.now?.() || Date.now();
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
      }, { deferActivation: isQualitySwitch, hideTransition: !opts.force });
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
        }, { deferActivation: isQualitySwitch, hideTransition: !opts.force });
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
        }, { deferActivation: isQualitySwitch, hideTransition: !opts.force });
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
    _applyStabilization(t);
    // Overlays need to know which frame is ACTUALLY on screen, and in which frame
    // of reference. Emitted here rather than from the Timeline callback: that one
    // fires ~60x/s and, more importantly, fires BEFORE the volume is loaded — an
    // overlay following it would lead the image it is meant to annotate.
    window.dispatchEvent(new CustomEvent('viewer-timepoint-ready', {
      detail: { frame: Number.isFinite(t) ? t : 0, stabilized: Boolean(VolumeViewer.isStabilized?.()) }
    }));
    if (isLive) {
      // Surfaced so the cost of a scrub step can be read off the console directly
      // instead of inferred: first visit vs. revisit is the number that matters.
      const ms = Math.round((performance.now?.() || Date.now()) - _tpLoadStart);
      console.log(`[ViewerApp] timepoint ${t + 1}/${datasetMeta.dimensions?.t} ready in ${ms} ms `
        + `(${primaryQuality}, ${_tpSeen.has(t) ? 'revisit' : 'first visit'}, `
        + `${loadedTimepoints.size} visited so far)`);
      _tpSeen.add(t);
    }
    if (loader) loader.style.display = 'none';
    ChannelPanel.setHistograms(VolumeViewer.getChannelHistograms());
    _updateVolumeSourceStatus();

    // CAP-008: the atlas/VRAM cascade may have rendered a coarser LOD than requested
    // (e.g. native exceeds the GPU's atlas budget). Reflect the resolution actually
    // displayed in the selector and tell the user, requiring an explicit OK ack.
    if (result.downgraded && Number.isFinite(result.lod) && Array.isArray(_brickManifest?.levels)) {
      const actualQuality = _qualityValueForLod(result.lod, _brickManifest.levels);
      if (actualQuality && actualQuality !== primaryQuality) {
        const requestedLabel = _qualityLabel(primaryQuality);
        const actualLabel = _qualityLabel(actualQuality);
        _qualityMode = actualQuality;
        primaryQuality = actualQuality; // so the status line below shows the real resolution
        const qSelect = document.getElementById('select-quality');
        if (qSelect) qSelect.value = actualQuality;
        VolumeViewer.setQualityTarget?.(actualQuality, actualQuality);
        _showResolutionDowngradeNotice(requestedLabel, actualLabel);
      }
    }

    _setQualityStatus(`${_qualityLabel(primaryQuality)} active${result ? ` (${result.width}x${result.height}x${result.depth})` : ''}${result?.fromCache ? ' from cache' : ''}${_sliceWarning(result)}.`);
    _updatePhysicalStatus();

    // Refresh slicer material after texture upload
    if (typeof VolumeSlicer !== 'undefined') {
      const mat = VolumeViewer.getMaterial();
      if (mat) VolumeSlicer.updateMaterial(mat);
    }

    
    if (isLive) {
      _refreshBuffer();
      _kickPrefetch();
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

    // A bricked dataset has no slice stack. preloadVolume() only ever builds slice URLs,
    // so on a 4D brick dataset this preloader fired hundreds of doomed requests per
    // timepoint (preview/slices/tNNN_zNNN_c0.webp -> 404), burning the browser's
    // connection budget on nothing and, on a shared host, inviting the 429 bursts the
    // project .htaccess already documents. Warm the actual pack files instead: they are
    // 45-125 KB per timepoint here, and the switch then costs a decode, not a round-trip.
    const tpRows = _brickManifest?.timepoints;
    const run = tpRows && typeof tpRows === 'object'
      ? () => {
        const brickDir = datasetMeta?.qualities?.native?.directory || 'bricks';
        const levels = _brickManifest?.levels || [];
        const lod = _lodForQuality(_qualityMode, levels.length, levels);
        candidates.forEach(frame => {
          const key = `t${String(frame).padStart(3, '0')}`;
          const row = tpRows[key] || tpRows[String(frame)] || tpRows[frame];
          if (!row?.brickTransport) return;
          _preloadedTimepoints.add(frame);
          BrickLoader.prefetchPacks?.(
            `${basePath}/${brickDir}/${row.path || key}`, row.brickTransport, lod, 0
          )?.catch?.(() => {});   // best effort: the foreground load retries properly
        });
      }
      : () => {
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

  // Key of the in-memory "already loaded" set. `t` is a timepoint index, or null
  // when the dataset has no time axis — the sentinel below names that case, it
  // is not a dataset type.
  function _qualityKey(t, quality) {
    return `${t === null ? 'still' : t}:${quality}`;
  }

  function _qualityLabel(quality) {
    if (quality === 'native') return _t('viewer.native', 'Native');
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

  // CAP-008: dismissible notice shown when the requested resolution could not fit in GPU
  // memory and a lower LOD was rendered instead. Requires an explicit OK to acknowledge.
  function _showResolutionDowngradeNotice(requestedLabel, actualLabel) {
    document.querySelector('.res-downgrade-notice')?.remove();
    const notice = document.createElement('div');
    notice.className = 'res-downgrade-notice';
    notice.setAttribute('role', 'alertdialog');
    notice.setAttribute('aria-live', 'assertive');

    const msg = document.createElement('span');
    msg.className = 'res-downgrade-notice__msg';
    msg.textContent = _t(
      'viewer.resDowngrade',
      `Résolution ${requestedLabel} trop lourde pour la mémoire GPU — affichage en ${actualLabel}.`,
      { requested: requestedLabel, actual: actualLabel }
    );

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'res-downgrade-notice__ok';
    btn.textContent = _t('viewer.resDowngradeOk', 'OK');
    btn.addEventListener('click', () => notice.remove());

    notice.appendChild(msg);
    notice.appendChild(btn);
    document.body.appendChild(notice);
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

  // Unlike the Z scale, the playback rate says nothing about the specimen — it is
  // how fast this operator likes to watch a timelapse — so it is stored once for
  // the viewer rather than per dataset.
  const _PLAYBACK_FPS_KEY = 'iribhm.viewer.playbackFps';

  function _loadPlaybackFps() {
    try {
      const stored = parseFloat(localStorage.getItem(_PLAYBACK_FPS_KEY));
      return (Number.isFinite(stored) && stored > 0 && stored <= 60) ? stored : 10;
    } catch {
      return 10;
    }
  }

  function _savePlaybackFps() {
    try {
      localStorage.setItem(_PLAYBACK_FPS_KEY, String(_playbackFps));
    } catch {
      // localStorage can be unavailable in restrictive contexts.
    }
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
      status.textContent = I18n.t('viewer.dimPending');
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
        // A sibling panel moved its z-stack browser: open ours if needed and mirror
        // its mode, cursor, thickness and trim. The guard keeps the mirror silent.
        _suppressZstackSync = true;
        try {
          if (!_zstackActive) _applyZstackState(true, null);
          const mod = _zstackModule();
          if (mod?.impl?.applySync) mod.impl.applySync(data);
        } finally {
          _suppressZstackSync = false;
        }
      } else if (data.type === 'SYNC_SLICER_SPEC') {
        // A sibling decompose panel moved the slice-through-volume plane.
        // The 3D raymarcher has no cut-plane shader uniform, so we cannot
        // cut the volume in the main WebGL canvas. Instead:
        //   1. Activate VolumeSlicer (links GPU texture, renders 2D slice)
        //   2. Show its output as a fullscreen overlay over the WebGL canvas
        // This matches exactly what the user sees in the slice inspector sidebar.
        // The spec carries its own `visible` flag and it is authoritative: forcing the
        // overlay on for every spec meant a sibling whose plane was OFF still replaced
        // this panel's 3D volume with a flat slice. Track the position either way, so
        // the plane is already aligned when it is switched back on.
        const specVisible = data.spec?.visible !== false;
        _suppressSlicerSync = true;
        if (typeof VolumeSlicer !== 'undefined') {
          const mat = VolumeViewer.getMaterial?.();
          if (mat) VolumeSlicer.updateMaterial(mat);
          VolumeSlicer.setVisible(specVisible);
          VolumeSlicer.setPlaneSpec(data.spec);
        }
        if (specVisible) _slicerOverlayStart();
        else _slicerOverlayStop();
        _suppressSlicerSync = false;
      } else if (data.type === 'SYNC_TIME' && isLive) {
        Timeline.setFrame(data.value, false);
      }
      if (data.type === 'SYNC_CAMERA') {
        // While the z-stack browser holds the view top-down (slice mode), block camera
        // orientation sync (rotation/pan) so another panel cannot rotate the fixed
        // projection. Zoom (cameraZ) is allowed to stay consistent with the other view's scale.
        if (_zstackLocksCamera()) {
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
          if (_zstackActive || (typeof VolumeSlicer !== 'undefined' && VolumeSlicer.isVisible())) {
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
      node.textContent = I18n.t('viewer.volSourceUnavailable');
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

    if (_zstackActive && typeof VolumeSlicer !== 'undefined' && VolumeSlicer.renderWithMaterial && VolumeViewer.getMaterial?.()) {
      const { z } = _zstackGetDims();
      if (z >= 1) {
        // The browser's slab (or its whole kept range in 3D), rendered through a
        // throwaway slicer material so the inspector plane is never disturbed.
        const spec = _zstackStudioSpec();
        const dim = datasetMeta?.dimensions || {};
        const maxRes = Math.max(Number(dim.original_x) || Number(dim.x) || 1024, Number(dim.original_y) || Number(dim.y) || 1024);
        const renderRes = Math.ceil(maxRes * 1.5);
        let canvas = VolumeSlicer.renderWithMaterial(VolumeViewer.getMaterial(), spec, renderRes, _currentChannelState());

        if (canvas) {
          canvas = cropEmptySpace(canvas);
          return {
            canvas,
            width: canvas.width,
            height: canvas.height,
            renderRes: renderRes,
            source: 'zstack',
            quality: 'high',
            planeSpec: spec,
            pixelSizeUm: _slicePixelSizeUm(spec, renderRes),
            physicalSizeUm: VolumeViewer.getPhysicalSize?.(),
            channelState: _currentChannelState(),
            timepoint: _currentTimepoint
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

  // ── Z-Stack Browser ──────────────────────────────────────
  // The panel itself is the zstack-browser plugin; these are the viewer-level facts it
  // publishes through ctx._state (workspace save, Studio export, camera sync).
  let _zstackActive = false;
  // Centre of the cursor in slice mode, -1 while the browser shows the kept stack in 3D.
  let _zstackCurrentSlice = 0;
  // Prevents echo loops when a SYNC_ZSTACK_SLICE is applied in a receiving panel
  let _suppressZstackSync = false;
  // Prevents echo loops when SYNC_SLICER_SPEC triggers setPlaneSpec in a receiving panel
  let _suppressSlicerSync = false;
  // A channel state applied FROM a parent frame (or restored in bulk) must not be
  // broadcast back out of this panel.
  let _suppressChannelSync = false;

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

  function _zstackModule() {
    return typeof PluginRegistry !== 'undefined' ? PluginRegistry.getModule('zstack-browser') : null;
  }

  /** True while the browser holds the view top-down (its 3D notch rotates freely). */
  function _zstackLocksCamera() {
    if (!_zstackActive) return false;
    const mod = _zstackModule();
    return typeof mod?.impl?.isSliceMode === 'function' ? mod.impl.isSliceMode() : true;
  }

  function _applyZstackState(desired, slice = null) {
    const mod = _zstackModule();
    if (mod?.impl?.applyState) {
      mod.impl.applyState(desired, slice);
      return;
    }
    // Without the plugin nothing can drive the panel: keep it closed and the volume
    // unclipped rather than half-open a dead control.
    if (desired) console.warn('[Viewer] Z-stack browser requested but the zstack-browser plugin is not installed');
    _zstackActive = false;
    _zstackCurrentSlice = 0;
    document.getElementById('zstack-browser')?.classList.add('zstack-hidden');
    VolumeViewer.setRotationLocked(false);
    VolumeViewer.resetClipping();
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
    resetWorkspace,
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

// Boot-level safety net (defense in depth): init() is async — if any UI-build step
// throws despite the per-subsystem try/catch barriers, surface it instead of a silent
// unhandled rejection, so failures are diagnosable rather than a blank viewer.
document.addEventListener('DOMContentLoaded', () => {
  Promise.resolve(ViewerApp.init()).catch(err => console.error('[ViewerApp] boot failed:', err));
});

