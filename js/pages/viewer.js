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

  /**
   * `p` when it names a dataset the way the catalog does — '<type>/<folder>' or
   * 'staging:<type>/<folder>', one known type, one folder segment — else null. The
   * path is spliced into the data URL (DATA_WEB/<path>/…, or the staging proxy's
   * query): a '..' segment, a second slash or a backslash would reach any same-origin
   * file the browser resolves it to.
   */
  function _safeDatasetPath(p) {
    const s = String(p ?? '');
    const bare = s.startsWith(_STAGING_PREFIX) ? s.slice(_STAGING_PREFIX.length) : s;
    const slash = bare.indexOf('/');
    if (slash <= 0) return null;
    const type = bare.slice(0, slash);
    const folder = bare.slice(slash + 1);
    if (!folder || folder === '.' || folder === '..' || /[\\/?#%\u0000-\u001f]/.test(folder)) return null;
    const known = typeof Utils.isDatasetType === 'function' ? Utils.isDatasetType(type) : /^[a-z0-9]+$/.test(type);
    return known ? s : null;
  }

  // metadata.json fetched as soon as the URL names the dataset, in parallel with the
  // instance config, the translations, the catalog and the plugin discovery (it used
  // to wait for all of them): { path, promise → { ok, status, meta, error } }.
  let _prefetchedMeta = null;

  function _fetchDatasetMetadata(datasetPath) {
    return fetch(`${_datasetBase(datasetPath)}/metadata.json`)
      .then(async (resp) => {
        if (!resp.ok) return { ok: false, status: resp.status, meta: null, error: null };
        try {
          return { ok: true, status: resp.status, meta: await resp.json(), error: null };
        } catch (err) {
          return { ok: false, status: resp.status, meta: null, error: err };
        }
      })
      .catch(err => ({ ok: false, status: 0, meta: null, error: err }));
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
    // 1. The URL first: a hosting page must hear of a failure (PANEL_ERROR) from the
    // first await on, and the dataset's own files can be asked for right away.
    const params = new URLSearchParams(window.location.search);
    datasetId = params.get('id');
    _isIframe = params.get('hideHeader') === 'true';
    _panelIndex = params.get('panelIndex');
    const requestedQuality = _normalizeQualityParam(params.get('quality'));
    if (requestedQuality) _qualityMode = requestedQuality;

    const isAdmin = params.get('mode') === 'admin';
    const fallbackPath = isAdmin ? _safeDatasetPath(params.get('path')) : null;

    // Started now, awaited where they are needed: the plugin list and the dataset's
    // metadata.json do not depend on the instance config, the translations or the
    // catalog, and the first brick used to wait for all four in a row.
    const discoverP = (typeof PluginRegistry !== 'undefined')
      ? PluginRegistry.discover('js/modules').catch(err => ({ error: err }))
      : null;
    const earlyPath = fallbackPath || _safeDatasetPath(datasetId);
    _prefetchedMeta = earlyPath ? { path: earlyPath, promise: _fetchDatasetMetadata(earlyPath) } : null;

    // 2. Init core
    Theme.init();
    // Instance config first so I18n.t() sees the brand/specimen tokens.
    await InstanceConfig.load();
    // I18n.init() and Catalog.load() are independent network fetches: overlapped, so
    // the boot head waits on the slowest of them (and of the two fetches above), not
    // on their sum. Both are resolved before Catalog.getById (below), and the plugins
    // are still loaded before any UI is built (the v0.12.45 invariant).
    await Promise.all([I18n.init(), Catalog.load()]);
    InstanceConfig.applyHead();
    InstanceConfig.applyDom();

    if (window.lucide) lucide.createIcons();
    _updateThemeIcon();
    Theme.onChange(_updateThemeIcon);

    if (_isIframe) {
      document.body.classList.add('viewer-iframe');
      document.querySelector('.viewer-header').style.display = 'none';
      // The host's settings button opens and closes the sidebar. No click-outside
      // close: a tool mounted in the sidebar (the cell inspector) needs the very
      // canvas clicks that used to shut it.
      if (!isAdmin) document.querySelector('.viewer-sidebar').classList.add('sidebar-hidden');
    }
    
    if (!datasetId) {
      _perf()?.end(initPerfId, { status: 'missing-dataset-id' });
      _showLoadingError({ message: I18n.t('viewer.errNoDataset') });
      if (!_isIframe) setTimeout(() => { window.location.href = 'explorer.html'; }, 1400);
      return;
    }

    datasetMeta = Catalog.getById(datasetId);
    if (datasetMeta && !_safeDatasetPath(datasetMeta.path || datasetMeta.id)) datasetMeta = null;

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
        const discovered = await discoverP;
        if (discovered?.error) throw discovered.error;
        const modulePaths = discovered;
        // Only the plugins that cover the type being shown: a plugin naming its
        // `dataTypes` is taken at its word, so the photograph-only tools stay off
        // the volume viewer. Plugins declaring nothing predate the field and were
        // written for this page, hence allowUndeclaredDataTypes.
        // Embedded chrome-less (a Compare panel, the admin preview), the page keeps
        // only the plugins that declared they can be driven from outside.
        await PluginRegistry.loadModules('js/modules', modulePaths, {
          dataType: datasetMeta.type,
          allowUndeclaredDataTypes: true,
          context: _isIframe ? 'panel' : 'page'
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
    // Every reader of this canvas renders it in its own task first (renderNow, the
    // canvas's toBlob/toDataURL hooks, getCaptureCanvas for a host page), so the
    // drawing buffer need not be kept between frames.
    VolumeViewer.init('webgl-canvas', { preserveDrawingBuffer: false });
    // The slice on screen ⇔ the two renders swapped (_setSliceStage): one listener
    // serves the tool, a sibling's SYNC_SLICER_SPEC and the Z-stack browser alike.
    if (typeof VolumeSlicer !== 'undefined' && VolumeSlicer.onVisibleChange) VolumeSlicer.onVisibleChange(_setSliceStage);
    // The calibration is a dataset fact the core owns (_baseQuaternion): the
    // axis-aligned views — the z-stack browser locking the view top-down — spin
    // the acquisition planes into the frame the operator defined instead of the
    // raw orientation of the file.
    VolumeViewer.setFrameQuaternion?.(_baseQuaternion());
    // Which way up the raw file shows the sample (metadata.upsideDown): the raw pose
    // and the face the z-stack browser looks at follow it. Before prepareAll, so a
    // default view still wins.
    VolumeViewer.setSampleUpsideDown?.(datasetMeta?.upsideDown === true);
    _qualityProgressUnsub?.();
    _qualityProgressUnsub = VolumeViewer.onQualityProgress?.(_handleQualityProgress) || null;
    // ELE-18 (EDGE-001): surface a visible status on GPU context loss/restore (Rule 1.1).
    VolumeViewer.onContextLost?.(() => _setQualityStatus(_t('viewer.gpuLost', 'GPU context lost: rendering is paused until the browser gives it back.')));
    VolumeViewer.onContextRestored?.((info) => {
      if (!info?.reloading || !info.reload) {
        _setQualityStatus(_t('viewer.gpuRestored', 'GPU context restored.'));
        return;
      }
      _setQualityStatus(_t('viewer.gpuReloading', 'GPU context restored: reloading the volume…'));
      Promise.resolve(info.reload)
        .then(() => _setQualityStatus(_t('viewer.gpuRestored', 'GPU context restored.')))
        .catch((err) => _setQualityStatus(_tf('viewer.gpuReloadFailed', 'GPU context restored, but the volume could not be reloaded: {message}', { message: String(err?.message || err) })));
    });
    VolumeViewer.setZDisplayScale(_zDisplayScale, { notify: false });
    _refreshTrackingVisuals();
    VolumeViewer.setMeasurements(_volumeMeasurements);
    {
      VolumeViewer.onCameraChange((state) => {
        // Never broadcast camera changes while the z-stack browser holds the view
        // top-down (slice mode): that forced XY framing would corrupt other panels'
        // cameras. Its 3D notch rotates freely and syncs like any other view.
        // _isInitialized gates the boot-time chatter: fitCameraToVolume fires during
        // init(), and in Compare that framing would be pushed onto every panel already
        // on screen — see the SYNC_CHANNELS emitter for the full rationale.
        if (_isIframe && _isInitialized && !_zstackLocksCamera()) {
          _postToHost({ type: 'SYNC_CAMERA', value: _cameraStateForSiblings(state) });
        }
        // Fan out to subscribed sandboxed plugins (projected payload; the view moved).
        if (typeof PluginSandbox !== 'undefined') {
          PluginSandbox.emit('camera', state);
          PluginSandbox.emit('render');
        }
      });
      // Broadcast full slicer plane spec to sibling decompose panels on every change.
      // Uses onPlaneSpecChange which fires for all plane mutations (position, yaw, pitch, roll, slab, mode).
      // A page that is not embedded has no sibling to tell (window.parent === window:
      // every plane-drag frame used to post the spec to itself).
      VolumeViewer.onPlaneSpecChange?.((spec) => {
        if (!_isIframe || _suppressSlicerSync || _zstackActive || !_isInitialized) return;
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
        setClipRange: (...args) => { VolumeViewer.setClipRange(...args); _refreshTrackingVisuals(); },
        setClipRange_z: (lo, hi) => { VolumeViewer.setClipRange('z', lo, hi); _refreshTrackingVisuals(); },
        resetClipping: () => { VolumeViewer.resetClipping(); _refreshTrackingVisuals(); },
        setGridMode: (m) => VolumeViewer.setGridMode(m),
        setAxesVisible: (v) => VolumeViewer.setAxesVisible(v),
        setVolumeVisible: (v) => VolumeViewer.setVolumeVisible(v),
        setView: (v, o) => VolumeViewer.setView(v, o),
        setRotationLocked: (v) => VolumeViewer.setRotationLocked(v),
        resize: () => VolumeViewer.resize(),
        setCutPlaneVisible: (v) => VolumeViewer.setCutPlaneVisible(v),
        setPlaneSpec: (s, o) => VolumeViewer.setPlaneSpec(s, o),
        getPlaneSpec: () => VolumeViewer.getPlaneSpec(),
        setMeasurements: (m) => VolumeViewer.setMeasurements(m),
        onMeasurePoint: (cb) => VolumeViewer.onMeasurePoint(cb),
        onPlaneSpecChange: (cb) => VolumeViewer.onPlaneSpecChange(cb),
        getPhysicalCalibration: () => VolumeViewer.getPhysicalCalibration?.(),
        // Render the view now: a plugin reading the WebGL canvas calls it in the same task.
        renderNow: () => VolumeViewer.renderNow?.() || false
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
        perf: () => _perf(),
        getCanvas: () => document.getElementById('webgl-canvas'),
        getCanvasContainer: () => document.querySelector('.viewer-canvas-container'),
        addSidebarSection: (def) => _addPluginSidebarSection(def),
        addCanvasPanel: (def) => _addPluginCanvasPanel(def),
        downloadText: (text, filename, mime) => _downloadText(text, filename, mime)
      },
      // The exclusive tool mux (navigate / measure / cut / slice / a plugin's own
      // tool). A plugin declaring subtype 'tool' gets its chip from the toolbar
      // builder; it learns it became current (or stopped being) through onChange.
      tools: {
        current: () => (typeof ToolManager !== 'undefined' ? ToolManager.current() : 'navigate'),
        activate: (tool) => { if (typeof ToolManager !== 'undefined') ToolManager.activate(tool); },
        onChange: (cb) => {
          if (typeof cb !== 'function') return () => {};
          _toolListeners.push(cb);
          return () => { _toolListeners = _toolListeners.filter(fn => fn !== cb); };
        }
      },
      // Cell tracking of a timelapse — the ONE copy of the packed tracks lives in
      // the overlay; plugins read positions, pick cells, share a selection and a
      // few analysis options through this façade, and follow it by events.
      tracking: _trackingFacade(),
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
      getCustomExports: _getAllCustomExports,
      getGraph: _getPluginGraph,
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
    _noticeExtraChannels();

    // Operator-attached images (annotated captures, figures). datasetMeta is already
    // merged with metadata.json at this point, so the array is the authoritative one.
    if (typeof DatasetGallery !== 'undefined') {
      DatasetGallery.init({
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
    _bindHost();

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
      // The host keeps a highlighted settings button per panel: tell it.
      _postToHost({ type: 'SIDEBAR_CLOSED' });
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

  // Bounds of a volume the platform can stream: 64³ bricks, at most 2^20 voxels an
  // axis; four channels are drawn (the shader's and the atlas's RGBA), more are
  // accepted and said so at mount.
  const MAX_VOXELS_PER_AXIS = 1 << 20;
  const MAX_CHANNELS = 64;

  /**
   * Rule 1.4 — a metadata.json must be structurally sound; an unsound one is REJECTED
   * (never mounted partially). Only what is present is checked: a missing field keeps
   * the catalog's value. → { ok, reason }
   */
  function _validateDatasetMetadata(meta, expectLive) {
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) {
      return { ok: false, reason: 'the root is not an object' };
    }
    const _posInt = (v) => Number.isFinite(v) && Number.isInteger(v) && v > 0;
    const _axis = (v) => _posInt(v) && v <= MAX_VOXELS_PER_AXIS;
    const d = meta.dimensions;
    if (d !== undefined) {
      if (!d || typeof d !== 'object' || Array.isArray(d)) return { ok: false, reason: 'dimensions is not an object' };
      if (!_axis(d.x) || !_axis(d.y) || !_axis(d.z)) return { ok: false, reason: 'dimensions x/y/z invalid' };
      if (d.c !== undefined && !(_posInt(d.c) && d.c <= MAX_CHANNELS)) return { ok: false, reason: 'dimensions.c invalid' };
      if (d.t !== undefined && !_posInt(d.t)) return { ok: false, reason: 'dimensions.t invalid' };
    }
    // A timelapse's scrubber reads dimensions.t: it must exist, in metadata.json OR the
    // catalog (datasetMeta is not merged yet, hence the effective fallback).
    if (expectLive) {
      const effT = (d && _posInt(d.t)) ? d.t : datasetMeta?.dimensions?.t;
      if (!_posInt(effT)) return { ok: false, reason: 'live dataset without dimensions.t' };
    }
    if (meta.voxel_size !== undefined) {
      const v = meta.voxel_size;
      if (!v || typeof v !== 'object' || Array.isArray(v)) return { ok: false, reason: 'voxel_size is not an object' };
      const _posNum = (x) => Number.isFinite(x) && x > 0;
      if (!_posNum(v.x) || !_posNum(v.y) || !_posNum(v.z)) return { ok: false, reason: 'voxel_size x/y/z invalid' };
    }
    if (meta.channels !== undefined) {
      if (!Array.isArray(meta.channels) || meta.channels.length === 0) return { ok: false, reason: 'channels is not a non-empty array' };
      if (meta.channels.length > MAX_CHANNELS) return { ok: false, reason: `${meta.channels.length} channels` };
      if (meta.channels.some((c) => !c || typeof c !== 'object')) return { ok: false, reason: 'channels holds a non-object' };
      if (d && _posInt(d.c) && meta.channels.length !== d.c) return { ok: false, reason: `channels.length (${meta.channels.length}) != dimensions.c (${d.c})` };
    }
    return { ok: true };
  }

  /**
   * The optional blocks the viewer reads, checked one by one: a malformed block is
   * dropped with a warning (the dataset mounts without that feature — no
   * stabilisation, no tracking layer, no gallery) instead of feeding NaN matrices or
   * a path out of the dataset folder to the code that uses it. → the names dropped.
   */
  function _dropMalformedBlocks(meta) {
    const dropped = [];
    const finite3 = (a) => Array.isArray(a) && a.length === 3 && a.every(Number.isFinite);
    const drop = (key) => { delete meta[key]; dropped.push(key); };
    if (meta.registration !== undefined) {
      const reg = meta.registration;
      const ok = reg && typeof reg === 'object' && (reg.transforms === undefined || (Array.isArray(reg.transforms)
        && reg.transforms.every(r => r && Number.isInteger(r.index) && Array.isArray(r.matrix) && r.matrix.length === 16 && r.matrix.every(Number.isFinite))));
      if (!ok) drop('registration');
    }
    if (meta.acquisitionExtentUm !== undefined) {
      const e = meta.acquisitionExtentUm;
      if (!(e && finite3(e.min) && finite3(e.max) && e.max.every((v, i) => v > e.min[i]))) drop('acquisitionExtentUm');
    }
    if (meta.tracking !== undefined) {
      const t = meta.tracking;
      const path = t && typeof t === 'object' ? t.tracksPath : null;
      // A path inside the dataset folder: relative, no '..' segment, no scheme.
      const okPath = path === undefined || path === null
        || (typeof path === 'string' && path.length < 512
          && !/(^|[\\/])\.\.([\\/]|$)/.test(path) && !/^([a-z][a-z0-9+.-]*:|[\\/])/i.test(path));
      if (!(t && typeof t === 'object' && okPath)) drop('tracking');
    }
    if (meta.qualities !== undefined && !(meta.qualities && typeof meta.qualities === 'object' && !Array.isArray(meta.qualities))) drop('qualities');
    if (meta.gallery !== undefined && !Array.isArray(meta.gallery)) drop('gallery');
    if (dropped.length) console.warn(`[ViewerApp] metadata.json: malformed block(s) ignored: ${dropped.join(', ')}`);
    return dropped;
  }

  async function _mergeDatasetMetadata() {
    // BUG-033 (Rule 1.4): without a path the catalog row is all there is, acceptable
    // only if it carries the dimensions (calibration would compute on NaN otherwise).
    const _hasCatalogDims = !!datasetMeta?.dimensions
      && Number.isFinite(datasetMeta.dimensions.x)
      && Number.isFinite(datasetMeta.dimensions.y)
      && Number.isFinite(datasetMeta.dimensions.z);
    const datasetPath = datasetMeta?.path || datasetMeta?.id;
    if (!datasetPath) {
      if (!_hasCatalogDims) throw new Error(_t('viewer.errMetadataMissing', 'metadata.json not found and no dimensions in the catalog'));
      return;
    }
    try {
      // The fetch init() started from the URL, when it asked for this very dataset.
      const fetched = await (_prefetchedMeta && _prefetchedMeta.path === datasetPath
        ? _prefetchedMeta.promise
        : _fetchDatasetMetadata(datasetPath));
      _prefetchedMeta = null;
      if (!fetched.ok) {
        if (fetched.error) throw fetched.error;
        // A published dataset without its metadata.json (404 and the like) is broken,
        // whatever the catalog still lists; a staged import, or a server that failed
        // this once (5xx, no answer), may be read from the catalog row alone.
        const staged = String(datasetPath).startsWith(_STAGING_PREFIX);
        const transient = fetched.status === 0 || fetched.status >= 500;
        if (!(staged || transient) || !_hasCatalogDims) {
          throw new Error(_tf('viewer.errMetadataHttp', 'metadata.json unavailable (HTTP {status})', { status: fetched.status }));
        }
        return;
      }
      const meta = fetched.meta;
      const expectLive = datasetMeta?.type === 'live' || meta?.type === 'live';
      const v = _validateDatasetMetadata(meta, expectLive);
      if (!v.ok) throw new Error(_tf('viewer.errMetadataInvalid', 'Invalid metadata.json: {reason}', { reason: v.reason }));
      _dropMalformedBlocks(meta);
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
    select.addEventListener('change', () => { _setQualityMode(select.value); });
  }

  /**
   * Switch the displayed quality and reload the current timepoint at it — the
   * sidebar select and a hosting page (SET_QUALITY) share this one door.
   * @returns {Promise<void>} settles once the volume is on screen at that quality
   */
  /**
   * The quality the page now targets, without loading anything: the select, the
   * viewer's target, the background buffering (stopped, and its "already warmed"
   * memo forgotten — it was warmed at the previous level).
   */
  function _applyQualityMode(value) {
    const select = document.getElementById('select-quality');
    _qualityMode = _normalizeQualityParam(value) || '512x512';
    _showQualityInSelect(select, _qualityMode);
    VolumeViewer.setQualityTarget?.(_qualityMode, _qualityMode);
    _stopPrefetch();
    _preloadedTimepoints.clear();
    // Repaint the buffer for the quality we just switched TO. Stepping back down to
    // one already loaded shows its frames immediately instead of an empty bar.
    _refreshBuffer();
  }

  function _setQualityMode(value) {
    const select = document.getElementById('select-quality');
    const previous = _qualityMode;
    _applyQualityMode(value);
    if (!_basePath) return Promise.resolve({ ok: true });
    return _loadTimepoint(_basePath, _currentTimepoint, { force: true })
      .then((result) => { _kickPrefetch(200); return result; })
      .catch(err => {
        // The volume already on screen is intact: say so in the status line and
        // fall back to the quality it is at, rather than covering it with the
        // fatal-error card meant for a dataset that never mounted.
        console.warn('[ViewerApp] Quality switch failed:', err);
        _qualityMode = previous;
        _showQualityInSelect(select, previous);
        VolumeViewer.setQualityTarget?.(previous, previous);
        _setQualityStatus(`${_qualityLabel(previous)} — ${String(err?.message || err)}`);
        throw err;
      });
  }

  /** True when the mounted brick manifest is a v3 tree (SPEC §13.3) — the renderer's own test. */
  function _isV3BrickManifest(manifest = _brickManifest) {
    return Boolean(manifest) && (manifest.schema === 'iribhm-bricks-v3' || manifest.version === 3);
  }

  // The quality keys the select may offer, in order of preference when several land on
  // one level (native always wins level 0; 512, the default, before the others). A v3
  // tree offers the presets of SPEC §13.7; a v2 tree every power-of-two key, each level
  // reached by one of them shown once.
  const QUALITY_KEYS_V3 = ['native', '512x512', '1024x1024'];
  const QUALITY_KEYS_V2 = ['native', '512x512', '1024x1024', '256x256', '2048x2048', '4096x4096'];

  /**
   * The renderer's answer for `keys` on the mounted tree (VolumeViewer.getQualityLevels:
   * [{ key, value, level, dims, voxelSize }]) — the one quality → level rule of the page,
   * so the select, its labels, the Compare footprints and every load agree with what
   * the renderer really loads, on a v2 and on a v3 tree. null without a manifest.
   */
  function _rendererQualityLevels(keys) {
    if (typeof VolumeViewer === 'undefined' || typeof VolumeViewer.getQualityLevels !== 'function') return null;
    let out = null;
    try {
      out = VolumeViewer.getQualityLevels(keys, Array.isArray(_brickManifest?.levels) ? _brickManifest : null);
    } catch (err) {
      out = null;
    }
    return Array.isArray(out) && out.length ? out : null;
  }

  /**
   * The qualities the select offers: [{ value, lod, dims: {x, y, z} }], one per level
   * the renderer reaches, finest first — or null before a bricked dataset is mounted.
   */
  function _qualityLevels() {
    const resolved = _rendererQualityLevels(_isV3BrickManifest() ? QUALITY_KEYS_V3 : QUALITY_KEYS_V2);
    if (!resolved) return null;
    const byLevel = new Map();
    for (const e of resolved) {
      const value = _normalizeQualityParam(e?.value ?? e?.key);
      const lod = Number(e?.level);
      const dims = e?.dims;
      if (!value || !Number.isInteger(lod) || lod < 0 || byLevel.has(lod)) continue;
      if (!dims || !(Number(dims.x) > 0 && Number(dims.y) > 0 && Number(dims.z) > 0)) continue;
      byLevel.set(lod, { value, lod, dims: { x: Number(dims.x), y: Number(dims.y), z: Number(dims.z) } });
    }
    const out = [...byLevel.values()].sort((a, b) => a.lod - b.lod);
    return out.length ? out : null;
  }

  function _updateQualityOptionLabels() {
    const select = document.getElementById('select-quality');
    if (!select) return;
    const current = _normalizeQualityParam(_qualityMode || select.value) || '512x512';

    const offered = _qualityLevels();
    if (offered && offered.length > 0) {
      select.innerHTML = '';
      offered.forEach(({ value, dims }) => {
        const opt = document.createElement('option');
        opt.value = value;
        const name = value === 'native' ? _t('viewer.native', 'Native') : value.split('x')[0];
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
    // A quality not offered under its own key (it lands on the level of another one)
    // shows as the option of that level.
    const sameLevel = offered ? _qualityValueForLod(_lodForQuality(current)) : null;
    const fallback = options.find(option => option.value === '512x512')
      || options.find(option => option.value === '256x256')
      || options[0];
    select.value = options.some(option => option.value === current)
      ? current
      : (sameLevel && options.some(option => option.value === sameLevel) ? sameLevel : (fallback?.value || '512x512'));
  }

  /**
   * Shows `quality` in the select: its own option, else the option of the level it loads
   * (a host or a URL may ask for "1024x1024" where that level is offered as "native").
   */
  function _showQualityInSelect(select, quality) {
    if (!select) return;
    const options = [...(select.options || [])];
    if (options.some(o => o.value === quality)) { select.value = quality; return; }
    const same = _qualityValueForLod(_lodForQuality(quality));
    if (same && options.some(o => o.value === same)) select.value = same;
    else select.value = quality;
  }

  // CAP-008: inverse of the option labeling in _updateQualityOptionLabels — maps a LOD
  // index back to the <select> value it is shown under. Used to sync the selector to the
  // resolution actually rendered. null for a level no offered quality reaches.
  function _qualityValueForLod(lod) {
    const offered = _qualityLevels();
    const hit = offered ? offered.find(o => o.lod === Number(lod)) : null;
    return hit ? hit.value : null;
  }

  /** The level the renderer loads for `quality` on the mounted tree (0 = native when it cannot say). */
  function _lodForQuality(quality) {
    const resolved = _rendererQualityLevels([quality]);
    const lod = Number(resolved?.[0]?.level);
    return Number.isInteger(lod) && lod >= 0 ? lod : 0;
  }

  function _qualityDimsLabel(quality) {
    const dims = _qualityDims(quality);
    return dims ? ` (${dims.x}x${dims.y}x${dims.z})` : '';
  }

  function _qualityDims(quality) {
    const levels = Array.isArray(_brickManifest?.levels) ? _brickManifest.levels : null;
    if (levels?.length) {
      const lod = _lodForQuality(quality);
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

    _bindDetailControls();
    _bindViewExport();
  }

  // ── Zoom detail (the renderer's region of interest) ───────────────────────────
  // Past the quality's resolution the renderer streams the finer bricks in view into a
  // second atlas; the select sets its mode (auto / on / off) and the line under it says
  // what it is doing (VolumeViewer.getDetailStatus().message, already translated).
  const DETAIL_MODES = ['auto', 'on', 'off'];

  function _renderDetailStatus(status) {
    const line = document.getElementById('detail-status');
    if (line) line.textContent = String(status?.message || '');
    const select = document.getElementById('select-detail-mode');
    if (select && DETAIL_MODES.includes(status?.mode) && select.value !== status.mode) select.value = status.mode;
  }

  function _bindDetailControls() {
    const select = document.getElementById('select-detail-mode');
    if (typeof VolumeViewer === 'undefined' || typeof VolumeViewer.setDetailMode !== 'function') {
      select?.closest('label')?.classList.add('hidden');
      return;
    }
    if (select) {
      select.addEventListener('change', () => {
        const mode = DETAIL_MODES.includes(select.value) ? select.value : 'auto';
        _renderDetailStatus({ ...(VolumeViewer.getDetailStatus?.() || {}), mode: VolumeViewer.setDetailMode(mode) });
      });
    }
    if (typeof VolumeViewer.onDetailStatus === 'function') VolumeViewer.onDetailStatus(_renderDetailStatus);
    else _renderDetailStatus(VolumeViewer.getDetailStatus?.());
  }

  // ── 3D view export (PNG) ─────────────────────────────────────────────────────────
  // A core feature, always there (the screenshot plugin is installed on demand): the
  // current 3D view rendered off screen by VolumeViewer.renderViewImage at the screen's
  // size or larger, over a chosen background, with a scale bar drawn for the exported
  // pixel size. Not offered in an embedded page (a Compare panel, the admin preview):
  // the Compare page has its own figure export.

  // What a 2D canvas reliably holds in current browsers: 16384 px a side, 2^28 px.
  const VIEW_EXPORT_LIMITS = { maxSide: 16384, maxArea: 268435456 };
  let _viewExportAbort = null; // AbortController of the export in flight

  function _bindViewExport() {
    const btn = document.getElementById('btn-export-view');
    const pop = document.getElementById('view-export-popover');
    if (!btn || !pop) return;
    if (_isIframe) {
      btn.classList.add('hidden');
      btn.setAttribute('aria-hidden', 'true');
      pop.remove();
      return;
    }
    const widthInput = document.getElementById('view-export-width');
    const goBtn = document.getElementById('btn-view-export-go');
    const cancelBtn = document.getElementById('btn-view-export-cancel');
    const closeBtn = document.getElementById('btn-view-export-close');
    const isOpen = () => !pop.classList.contains('hidden');

    // Open, the popover closes on Escape and on a press outside it — except while an
    // export runs, when only Escape (which cancels it) or Cancel end it.
    const onOutside = (e) => {
      if (_viewExportAbort) return;
      if (pop.contains(e.target) || btn.contains(e.target)) return;
      close(false);
    };
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      _viewExportAbort?.abort();
      close(true);
    };
    const onResize = () => _refreshViewExport();

    function open() {
      pop.classList.remove('hidden');
      btn.setAttribute('aria-expanded', 'true');
      btn.classList.add('active');
      if (!_viewExportAbort) _setViewExportStatus('');
      _refreshViewExport();
      document.addEventListener('pointerdown', onOutside, true);
      document.addEventListener('keydown', onKey, true);
      window.addEventListener('resize', onResize);
      (pop.querySelector('input[name="view-export-size"]:checked') || goBtn)?.focus();
    }

    function close(restoreFocus) {
      if (!isOpen()) return;
      pop.classList.add('hidden');
      btn.setAttribute('aria-expanded', 'false');
      btn.classList.remove('active');
      document.removeEventListener('pointerdown', onOutside, true);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', onResize);
      if (restoreFocus) btn.focus();
    }

    // While an export runs the button leaves the popover open: its progress stays visible.
    btn.addEventListener('click', () => {
      if (!isOpen()) open();
      else if (!_viewExportAbort) close(true);
    });
    closeBtn?.addEventListener('click', () => {
      _viewExportAbort?.abort();
      close(true);
    });
    pop.addEventListener('change', (e) => {
      if (e.target?.name === 'view-export-size' && e.target.value === 'custom') widthInput?.focus();
      _refreshViewExport();
    });
    widthInput?.addEventListener('input', () => {
      const custom = pop.querySelector('input[name="view-export-size"][value="custom"]');
      if (custom) custom.checked = true;
      _refreshViewExport();
    });
    goBtn?.addEventListener('click', () => { _runViewExport(); });
    cancelBtn?.addEventListener('click', () => { _viewExportAbort?.abort(); });
    if (typeof I18n !== 'undefined' && I18n.onLanguageChange) {
      I18n.onLanguageChange(() => { if (isOpen()) _refreshViewExport(); });
    }
  }

  /** _t, with the params also filled into the English fallback. */
  function _viewExportText(key, fallback, params) {
    let text = _t(key, fallback, params);
    if (params) Object.keys(params).forEach((p) => { text = text.split(`{${p}}`).join(String(params[p])); });
    return text;
  }

  function _viewExportChoice(name) {
    return document.querySelector(`#view-export-popover input[name="${name}"]:checked`)?.value || '';
  }

  /**
   * The size asked for: the view's drawing buffer in device pixels ('screen'), a
   * multiple of it, or a width (16 px at least) whose height follows the view's aspect.
   */
  function _viewExportRequestedSize(choice, base, customWidth) {
    const bw = Math.max(1, Math.round(Number(base?.width) || 1));
    const bh = Math.max(1, Math.round(Number(base?.height) || 1));
    if (choice === 'custom') {
      const w = Math.max(16, Math.round(Number(customWidth) || bw));
      return { width: w, height: Math.max(1, Math.round(w * bh / bw)) };
    }
    const k = choice === '4' ? 4 : choice === '2' ? 2 : 1;
    return { width: bw * k, height: bh * k };
  }

  /**
   * The largest image of the requested aspect a 2D canvas holds: one factor
   * s = min(1, maxSide/w, maxSide/h, √(maxArea/(w·h))) on both sides, floored so no
   * limit is exceeded. `clamped` tells the dialog to say so.
   */
  function _clampExportSize(width, height, limits) {
    const lim = limits || VIEW_EXPORT_LIMITS;
    const w = Math.max(1, Math.round(Number(width) || 1));
    const h = Math.max(1, Math.round(Number(height) || 1));
    const s = Math.min(1, lim.maxSide / w, lim.maxSide / h, Math.sqrt(lim.maxArea / (w * h)));
    if (s >= 1) return { width: w, height: h, clamped: false };
    let cw = Math.min(lim.maxSide, Math.max(1, Math.floor(w * s + 1e-9)));
    let ch = Math.min(lim.maxSide, Math.max(1, Math.floor(h * s + 1e-9)));
    while (cw * ch > lim.maxArea) {
      if (cw >= ch) cw -= 1; else ch -= 1;
    }
    return { width: cw, height: ch, clamped: true };
  }

  /** '#rrggbb' to composite under the render, or null for a transparent PNG. 'display'
   *  follows the sidebar's background preset exactly as _getFigureBlob resolves it. */
  function _viewExportBackground(choice) {
    if (choice === 'transparent') return null;
    if (choice === 'black') return '#000000';
    if (choice === 'white') return '#ffffff';
    const resolved = typeof DisplayPresets !== 'undefined'
      ? DisplayPresets.resolve(_displayState.backgroundPreset, _displayState.backgroundColor)
      : { transparent: false, color: '#000000' };
    return resolved.transparent ? null : resolved.color;
  }

  /**
   * The exported scale bar, laid out as the on-screen one (#viewer-scale-bar,
   * VolumeGrid._updateScaleBar) would be on a screen k = height / cssHeight times
   * denser: its target length is the screen's — a fifth of the view width, within
   * 60–200 CSS px — times k, snapped to 1-2-5 µm, and its margin (20 px), text (12 px),
   * rule (2 px) and gap (4 px) scale by k too, so the bar keeps its place and
   * proportion in the picture whatever the export size.
   * umPerPx is µm per OUTPUT pixel, VolumeViewer.micronsPerPixel(height): the same
   * camera spans the same world height at the specimen depth over H pixels instead of
   * cssHeight, i.e. the on-screen µm per CSS px divided by k. The bar is then
   * lengthUm / umPerPx output pixels long. null without a calibration.
   */
  function _exportScaleBarLayout(opts) {
    const { width, height, cssWidth, cssHeight, umPerPx } = opts || {};
    if (!(umPerPx > 0) || !(width > 0) || !(height > 0)) return null;
    const k = cssHeight > 0 ? height / cssHeight : 1;
    const viewCssWidth = cssWidth > 0 ? cssWidth : width / k;
    const targetPx = k * Math.min(200, Math.max(60, viewCssWidth * 0.2));
    const lengthUm = Utils.niceScaleLength(targetPx * umPerPx);
    if (!(lengthUm > 0)) return null;
    const barPx = lengthUm / umPerPx;
    const margin = 20 * k;
    const thickness = Math.max(1, 2 * k);
    return {
      lengthUm,
      label: Utils.formatMicrons(lengthUm),
      barPx,
      x: width - margin - barPx,
      y: height - margin - thickness,
      thickness,
      gap: 4 * k,
      fontPx: Math.max(8, 12 * k),
      margin,
      scale: k
    };
  }

  /** Bar colours for the export background: white with a dark halo (the screen's own)
   *  on a dark or transparent background, black with a light halo on a light one —
   *  Rec. 709 luma of the sRGB value above one half counts as light. */
  function _exportScaleBarColors(background) {
    const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(background || ''));
    const luma = m
      ? (0.2126 * parseInt(m[1], 16) + 0.7152 * parseInt(m[2], 16) + 0.0722 * parseInt(m[3], 16)) / 255
      : 0;
    return luma > 0.5
      ? { fill: '#000000', shadow: 'rgba(255, 255, 255, 0.85)' }
      : { fill: '#ffffff', shadow: 'rgba(0, 0, 0, 1)' };
  }

  function _drawExportScaleBar(canvas, layout, background) {
    const ctx = canvas?.getContext('2d');
    if (!ctx || !layout) return;
    const colors = _exportScaleBarColors(background);
    const k = layout.scale;
    ctx.save();
    // The on-screen bar's text-shadow (1px 1px 2px), scaled with the picture.
    ctx.shadowColor = colors.shadow;
    ctx.shadowOffsetX = k;
    ctx.shadowOffsetY = k;
    ctx.shadowBlur = 2 * k;
    ctx.fillStyle = colors.fill;
    ctx.fillRect(layout.x, layout.y, layout.barPx, layout.thickness);
    ctx.font = `600 ${layout.fontPx}px Inter, system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    // Centred on the bar, but kept inside the picture when the label outgrows the bar.
    const textWidth = ctx.measureText(layout.label).width;
    const cx = Math.min(layout.x + layout.barPx / 2, canvas.width - layout.margin / 2 - textWidth / 2);
    ctx.fillText(layout.label, cx, layout.y - layout.gap);
    ctx.restore();
  }

  function _viewExportFileName(name, width, height) {
    const safe = String(name || '').replace(/[^a-z0-9._-]+/gi, '_').replace(/^_+|_+$/g, '') || 'view';
    return `${safe}_3d_${width}x${height}.png`;
  }

  /** What the dialog asks for right now. null before the 3D view exists. */
  function _viewExportPlan() {
    const base = VolumeViewer.getViewSize?.();
    if (!base) return null;
    const widthInput = document.getElementById('view-export-width');
    const choice = _viewExportChoice('view-export-size');
    const requested = _viewExportRequestedSize(choice, base, widthInput?.value);
    const size = _clampExportSize(requested.width, requested.height, VIEW_EXPORT_LIMITS);
    const calibrated = (VolumeViewer.micronsPerPixel?.(size.height) || 0) > 0;
    return {
      base,
      choice,
      size,
      background: _viewExportBackground(_viewExportChoice('view-export-bg')),
      calibrated,
      scaleBar: calibrated && Boolean(document.getElementById('view-export-scalebar')?.checked)
    };
  }

  function _refreshViewExport() {
    const plan = _viewExportPlan();
    const dims = document.getElementById('view-export-dims');
    const widthInput = document.getElementById('view-export-width');
    if (!plan) {
      if (dims) dims.textContent = '—';
      return;
    }
    if (dims) {
      dims.textContent = _viewExportText('exportView.dims', '{width} × {height} px', {
        width: plan.size.width, height: plan.size.height
      });
    }
    // Off the custom choice the field shows the width the choice gives, so picking
    // "Custom" starts from the size on display.
    if (widthInput && plan.choice !== 'custom') widthInput.value = String(plan.size.width);
    document.getElementById('view-export-clamp')?.classList.toggle('hidden', !plan.size.clamped);
    const scaleBarInput = document.getElementById('view-export-scalebar');
    if (scaleBarInput) scaleBarInput.disabled = !plan.calibrated;
    document.getElementById('view-export-scalebar-note')?.classList.toggle('hidden', plan.calibrated);
  }

  function _setViewExportStatus(text, options = {}) {
    const box = document.getElementById('view-export-status');
    const label = document.getElementById('view-export-status-text');
    const fill = document.getElementById('view-export-fill');
    if (!box || !label) return;
    const fraction = Number.isFinite(options.fraction) ? Math.max(0, Math.min(1, options.fraction)) : null;
    box.classList.toggle('hidden', !text);
    box.classList.toggle('is-error', options.tone === 'error');
    label.textContent = text || '';
    fill?.parentElement?.classList.toggle('hidden', fraction === null);
    if (fill && fraction !== null) fill.style.width = `${Math.round(fraction * 100)}%`;
  }

  function _setViewExportBusy(busy) {
    const pop = document.getElementById('view-export-popover');
    if (!pop) return;
    pop.classList.toggle('is-busy', busy);
    pop.querySelectorAll('fieldset').forEach((fieldset) => { fieldset.disabled = busy; });
    const goBtn = document.getElementById('btn-view-export-go');
    const cancelBtn = document.getElementById('btn-view-export-cancel');
    goBtn?.classList.toggle('hidden', busy);
    cancelBtn?.classList.toggle('hidden', !busy);
    // The pose is snapshotted for the tiles; a drag meanwhile would only confuse.
    document.querySelector('.viewer-canvas-container')?.classList.toggle('view-exporting', busy);
    if (!pop.classList.contains('hidden')) (busy ? cancelBtn : goBtn)?.focus();
  }

  function _viewExportErrorText(err, width, height) {
    switch (err?.code) {
      case 'busy':
        return _viewExportText('exportView.errBusy', 'An export is already running.');
      case 'no-view':
      case 'size':
        return _viewExportText('exportView.errNoView', 'The 3D view is not ready yet.');
      case 'canvas':
        return _viewExportText('exportView.errCanvas', 'The browser could not allocate a {width} × {height} image. Choose a smaller size.', { width, height });
      case 'gpu-memory':
        return _viewExportText('exportView.errGpu', 'Not enough GPU memory to render the image, even in small tiles. Choose a smaller size or close other tabs.');
      case 'context-lost':
        return _viewExportText('exportView.errContext', 'The GPU context was lost during the export. Reload the page and try again.');
      case 'unstable':
        return _viewExportText('exportView.errUnstable', 'The volume kept changing during the export. Try again once it has finished loading.');
      case 'display-changed':
        return _viewExportText('exportView.errDisplayChanged', 'The display settings changed during every attempt. Leave the channel and view controls alone until the export finishes.');
      case 'encode':
        return _viewExportText('exportView.errEncode', 'The browser could not encode a PNG this large. Choose a smaller size.');
      default:
        return _viewExportText('exportView.errGeneric', 'Export failed: {message}', { message: err?.message || String(err) });
    }
  }

  async function _runViewExport() {
    if (_viewExportAbort) return;
    const plan = _viewExportPlan();
    if (!plan || typeof VolumeViewer.renderViewImage !== 'function') {
      _setViewExportStatus(_viewExportText('exportView.errNoView', 'The 3D view is not ready yet.'), { tone: 'error' });
      return;
    }
    const { width, height } = plan.size;
    const controller = new AbortController();
    _viewExportAbort = controller;
    _setViewExportBusy(true);
    // One frame of a timelapse: playback would swap the volume under the tiles.
    if (isLive && typeof Timeline !== 'undefined' && Timeline.pause) Timeline.pause();
    let canvas = null;
    try {
      canvas = await VolumeViewer.renderViewImage({
        width,
        height,
        background: plan.background,
        signal: controller.signal,
        onProgress: (p) => {
          if (p.phase === 'waiting') {
            _setViewExportStatus(_viewExportText('exportView.waiting', 'Waiting for the volume to finish loading… {percent}%', {
              percent: Math.round((p.progress || 0) * 100)
            }), { fraction: p.progress || 0 });
          } else if (p.phase === 'render') {
            _setViewExportStatus(_viewExportText('exportView.progressTile', 'Rendering tile {tile}/{tiles}…', {
              tile: p.tile, tiles: p.tiles
            }), { fraction: (p.tile - 1) / p.tiles });
          }
        }
      });
      if (plan.scaleBar) {
        _drawExportScaleBar(canvas, _exportScaleBarLayout({
          width,
          height,
          cssWidth: plan.base.cssWidth,
          cssHeight: plan.base.cssHeight,
          umPerPx: canvas.exportInfo?.micronsPerPixel || 0
        }), plan.background);
      }
      _setViewExportStatus(_viewExportText('exportView.encoding', 'Encoding PNG ({width} × {height} px)…', { width, height }), { fraction: 1 });
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
      if (controller.signal.aborted) {
        const aborted = new Error('View export cancelled');
        aborted.name = 'AbortError';
        throw aborted;
      }
      if (!blob) {
        const failed = new Error('PNG encoding failed');
        failed.code = 'encode';
        throw failed;
      }
      const fileName = _viewExportFileName(datasetMeta?.name || datasetMeta?.id, width, height);
      if (typeof ExportManager !== 'undefined' && ExportManager.downloadBlob) {
        ExportManager.downloadBlob(blob, fileName);
      } else {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = fileName;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 500);
      }
      _setViewExportStatus(_viewExportText('exportView.saved', 'Saved {file}', { file: fileName }));
    } catch (err) {
      if (err?.name === 'AbortError') {
        _setViewExportStatus(_viewExportText('exportView.cancelled', 'Export cancelled.'));
      } else {
        console.error('[ViewerApp] 3D view export failed:', err);
        _setViewExportStatus(_viewExportErrorText(err, width, height), { tone: 'error' });
      }
    } finally {
      if (canvas) { canvas.width = 0; canvas.height = 0; }
      _viewExportAbort = null;
      _setViewExportBusy(false);
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
      _refreshTrackingVisuals();
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
    _refreshTrackingVisuals();
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
    if (_isIframe && _isInitialized && !_suppressChannelSync) {
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
        // The slice tool and the Z-stack browser both own the clip box and the
        // main view: opening one closes the other (the browser's side lives in its
        // plugin). Closed first, so its resetClipping cannot undo the plane below.
        if (tool === 'slice' && _zstackActive) _applyZstackState(false, null);
        // For the 3D viewer, 'slice' maps to 'cut' tool (plane interaction)
        const viewerTool = tool === 'slice' ? 'cut' : tool;
        VolumeViewer.setActiveTool(viewerTool);
        measurePanel?.classList.toggle('visible', tool === 'measure');
        _slicerShow(tool === 'slice');
        _toolListeners.forEach(fn => { try { fn(tool); } catch (err) { console.warn('[ViewerApp] tool listener failed:', err); } });
        // A tool picked here (keyboard shortcut) becomes the host's tool for every
        // panel; one the host pushed down (SET_TOOL) is not echoed back.
        if (_isIframe && _isInitialized && !_suppressToolSync) _postToHost({ type: 'TOOL_CHANGED', tool });
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

  // The Studio opens on a picture of at most this many pixels a side, rendered from
  // the atlas already on the GPU (the native pass then streams the full-size one): a
  // native-frame preview of a 5735² dataset was a 75 Mpx render, read back and
  // scanned in JS before anything showed.
  const STUDIO_PREVIEW_MAX = 2048;
  // A z-stack figure whose native pass would download more than this asks first.
  const STUDIO_CONFIRM_BYTES = 256 * 1024 * 1024;
  let _studioOpening = false;
  let _nativePassSeq = 0;

  async function openStudio() {
    if (typeof StudioEditor === 'undefined' && !_isIframe) return;

    if (_isIframe) {
      // SEC-012: restrict targetOrigin to this page's origin (no wildcard leak).
      window.parent.postMessage({ type: 'REQUEST_COMPARE_STUDIO', sourceIndex: _panelIndex }, Utils.trustedTargetOrigin());
      return;
    }

    // A second press while the first one is still rendering its preview would open a
    // second document and start a second native pass on top of the first.
    if (_studioOpening) return;
    _studioOpening = true;
    let preview = null;
    let token = null;
    try {
      // The Studio used to open only once the native LOD0 slice had arrived — minutes
      // of packs for one plane. It opens on the plane the GPU already holds (one render,
      // no network) and upgrades in place once the native pass lands. The Z-stack
      // browser is not the slice inspector: its plane comes from the browser's cursor
      // and trim, not from the (hidden) inspector plane.
      preview = await _renderStudioPreviewSlice(_zstackActive ? _zstackStudioSpec() : null);
      const opening = preview || getCurrentSliceResult();
      if (!opening) return;
      token = StudioEditor.open(opening);
    } finally {
      _studioOpening = false;
    }
    if (preview && token !== null && token !== undefined) await _upgradeStudioSliceToNative(preview, token);
  }

  /**
   * What the Z-stack browser shows, as a slicer plane: the cursor's slices (every
   * kept slice in 3D mode) sampled one voxel per step and MIP-projected when the slab
   * is thicker than one slice — the calibrated 2D counterpart of the slab on screen,
   * turned and faced the way the screen shows it (see _zstackFlatPose).
   *   A stabilised timelapse (VolumeViewer.getClipSpace().warped): the browser's range
   * [lo/z, (hi+1)/z] acts in the DISPLAY box (the shader's clipBoxMin/Size), so the
   * slab on screen is the object slab [z0, z1] = min.z + [lo, hi + 1]/z · size.z, and
   * the slicer samples it through the same warp (VolumeSlicer: texCoord = volumeWarp·p).
   * There the plane's value sweeps the display box too (VolumeSlicer.planeSweep: an
   * axis plane at object min.z + value·size.z on +Z, max.z − value·size.z on −Z), so
   * the slab centre c_o = (z0 + z1)/2 = min.z + c·size.z is reached by the very value
   * of the unwarped spec, c on +Z and 1 − c on −Z — always inside [0, 1], so the
   * slicer's clamp and a later setPlaneSpec leave it where it is. The samples cut the
   * slab into N = round((z1 − z0)·z) equal parts and sit at their centres, (z1 − z0)/N
   * apart: about one acquisition slice (1/z object unit is one voxel depth in µm,
   * however the rigid warp turns it), a MIP as soon as N > 1. With size.z = 1 and
   * min.z = −½ it is the unwarped spec, term for term.
   */
  function _zstackStudioSpec() {
    const { z } = _zstackGetDims();
    const mod = _zstackModule();
    const range = typeof mod?.impl?.getStudioSliceRange === 'function' ? mod.impl.getStudioSliceRange() : null;
    const clampZ = (v) => Math.max(0, Math.min(z - 1, Math.round(Number(v) || 0)));
    const lo = clampZ(range ? range.lo : Math.max(0, _zstackCurrentSlice));
    const hi = Math.max(lo, clampZ(range ? range.hi : lo));
    const n = hi - lo + 1;
    // Slice i spans [i/z, (i+1)/z] of the normalised depth; the plane sits at the
    // slab's centre and the samples land on the voxel centres (lo + 0.5 + k) / z.
    const c = (lo + n / 2) / z;
    const pose = _zstackFlatPose(VolumeViewer.getScreenFrameInVolume?.());
    const clip = VolumeViewer.getClipSpace?.();
    const zMin = Number(clip?.min?.z);
    const zSize = Number(clip?.size?.z);
    if (clip?.warped && Number.isFinite(zMin) && zSize > 0) {
      // The display-box slab (see above), sampled evenly through the warp.
      const z0 = zMin + (lo / z) * zSize;
      const z1 = zMin + ((hi + 1) / z) * zSize;
      const steps = Math.max(1, Math.min(1024, Math.round((z1 - z0) * z)));
      return {
        mode: 'oblique',
        axis: 'z',
        value: pose.back ? 1 - c : c,
        yaw: pose.back ? 180 : 0,
        pitch: 0,
        roll: pose.roll,
        slabThickness: steps,
        slabStepNorm: (z1 - z0) / steps,
        projection: steps > 1 ? 'mip' : 'single'
      };
    }
    return {
      mode: 'oblique',
      axis: 'z',
      // The slicer puts the plane at texture depth ½ + normal.z·(value − ½): c on the
      // +Z normal, 1 − value on the −Z one. The slab's samples sit symmetrically about
      // the plane, so both faces read the same slices.
      value: pose.back ? 1 - c : c,
      yaw: pose.back ? 180 : 0,
      pitch: 0,
      roll: pose.roll,
      slabThickness: n,
      slabStepNorm: 1 / z,
      projection: n > 1 ? 'mip' : 'single'
    };
  }

  /**
   * The flat pose of a Z-stack figure nearest what the screen shows: the +Z face
   * (yaw 0) or the −Z face (yaw 180, the mirror image), pitch 0, and an in-plane
   * roll, in VolumeSlicer's oblique convention.
   *   The slicer's plane is R = Ry(−yaw)·Rx(−pitch)·Rz(roll) (Euler (−pitch, −yaw,
   *   roll, 'YXZ')) with canvas right = R·X, canvas up = R·Y, normal = R·Z, in the
   *   physically proportioned volume frame (VolumeViewer.getScreenFrameInVolume).
   *   front: right = ( cos r, sin r, 0), up = (−sin r, cos r, 0), normal = +Z;
   *   back:  Ry(π)(x, y, z) = (−x, y, −z), so right = (−cos r, sin r, 0),
   *          up = (sin r, cos r, 0), normal = −Z.
   *   The one nearest the screen frame M = [r̂ û n̂] (n̂ = r̂ × û, normalised)
   *   maximises tr(Rᵀ·M) — for unit quaternions tr(R₁ᵀR₂) = 4⟨q₁, q₂⟩² − 1, the
   *   nearness setView's spin 'nearest' uses:
   *   front: (r̂x + ûy)·cos r + (r̂y − ûx)·sin r + n̂z, largest at r = atan2(r̂y − ûx, r̂x + ûy);
   *   back:  (ûy − r̂x)·cos r + (r̂y + ûx)·sin r − n̂z, largest at r = atan2(r̂y + ûx, ûy − r̂x);
   *   the face with the larger maximum wins, the front on a tie.
   * With the stack laid flat (the browser's slice mode, Rz(θ)·[Ry(π)] in the
   * frame), M is one of these rotations and the figure is exactly the screen — e.g.
   * the pose Rz(φ) puts the screen's right on (cos φ, −sin φ, 0) and gives r = −φ.
   * A free 3D pose (the browser's 3D mode) gets the flat pose nearest it.
   * @param {{right: {x,y,z}, up: {x,y,z}}|null} frame
   * @returns {{back: boolean, roll: number}} roll in degrees; no frame ⇒ the raw
   *   voxel frame (front, roll 0)
   */
  function _zstackFlatPose(frame) {
    const r = frame?.right;
    const u = frame?.up;
    const finite = (v) => v && [v.x, v.y, v.z].every(Number.isFinite);
    if (!finite(r) || !finite(u)) return { back: false, roll: 0 };
    const nx = r.y * u.z - r.z * u.y;
    const ny = r.z * u.x - r.x * u.z;
    const nz = r.x * u.y - r.y * u.x;
    const nzUnit = nz / (Math.hypot(nx, ny, nz) || 1);
    const frontScore = Math.hypot(r.x + u.y, r.y - u.x) + nzUnit;
    const backScore = Math.hypot(u.y - r.x, r.y + u.x) - nzUnit;
    const back = backScore > frontScore;
    const roll = back ? Math.atan2(r.y + u.x, u.y - r.x) : Math.atan2(r.y - u.x, r.x + u.y);
    return { back, roll: (roll * 180) / Math.PI };
  }

  /**
   * The plane `spec` samples through `material` (the live volume material by
   * default), as plain numbers (StudioPlaneOps.plainGeometry), and the warp of a
   * stabilised timelapse (16 numbers, column-major; null unwarped).
   */
  function _studioGeometry(spec, material = VolumeViewer.getMaterial?.()) {
    const space = VolumeSlicer.samplingSpace ? VolumeSlicer.samplingSpace(material || null) : null;
    const g = VolumeSlicer.planeGeometry(spec, VolumeViewer.getPhysicalSize?.(), space);
    return {
      geom: StudioPlaneOps.plainGeometry(g),
      warp: space?.warp?.elements ? Array.from(space.warp.elements) : null
    };
  }

  /** False when the volume carries no physical calibration (its "µm" are voxel counts). */
  function _studioCalibrated() {
    const phys = VolumeViewer.getPhysicalSize?.();
    const cal = VolumeViewer.getPhysicalCalibration?.();
    return !(cal?.calibrationStatus === 'metadata-missing' || phys?.calibrationStatus === 'metadata-missing' || phys?.mode === 'metadata-missing');
  }

  // ── Studio plane worker ──────────────────────────────────────────────────────
  // The MIP reductions of the native pass and the slab footprints, off the main
  // thread; StudioPlaneOps on the main thread when no worker can run.
  let _planeWorker = null;
  let _planeWorkerFailed = false;
  let _planeJobSeq = 0;
  const _planeJobs = new Map();

  function _planeWorkerInstance() {
    if (_planeWorker || _planeWorkerFailed || typeof Worker === 'undefined') return _planeWorker;
    try {
      _planeWorker = new Worker('js/workers/studio-plane-worker.js');
      _planeWorker.onmessage = (e) => {
        const job = _planeJobs.get(e.data?.id);
        if (!job) return;
        _planeJobs.delete(e.data.id);
        if (e.data.error) job.reject(new Error(e.data.error));
        else job.resolve(e.data);
      };
      _planeWorker.onerror = (err) => {
        console.warn('[ViewerApp] Studio plane worker failed; computing on the main thread.', err?.message || err);
        _planeWorkerFailed = true;
        _planeWorker?.terminate?.();
        _planeWorker = null;
        const jobs = [..._planeJobs.values()];
        _planeJobs.clear();
        jobs.forEach(job => job.retry());
      };
    } catch (err) {
      _planeWorkerFailed = true;
      _planeWorker = null;
    }
    return _planeWorker;
  }

  /** Runs `msg` in the plane worker (transferring `transfer`), or `fallback()` here
   *  (also when the worker dies, for a job whose data was not transferred). */
  function _planeJob(msg, transfer, fallback) {
    const worker = _planeWorkerInstance();
    if (!worker) return Promise.resolve().then(fallback);
    return new Promise((resolve, reject) => {
      const id = ++_planeJobSeq;
      // A job whose data went to a worker that died cannot be run again here.
      const retry = fallback
        ? () => Promise.resolve().then(fallback).then(resolve, reject)
        : () => reject(new Error('Studio plane worker lost'));
      _planeJobs.set(id, { resolve, reject, retry });
      try {
        worker.postMessage({ ...msg, id }, transfer);
      } catch (err) {
        _planeJobs.delete(id);
        retry();
      }
    });
  }

  /** The footprint of a projected slab over `win` of a renderRes frame (StudioPlaneOps.coverageMask). */
  function _studioCoverageMask(geom, renderRes, win, warp) {
    const params = { geometry: geom, renderRes, window: { x: win.x, y: win.y, w: win.w, h: win.h }, warp };
    return _planeJob({ op: 'coverage', ...params }, [], () => ({ mask: StudioPlaneOps.coverageMask(geom, renderRes, params.window, warp) }))
      .then(r => r.mask)
      .catch(err => {
        console.warn('[ViewerApp] Slab footprint unavailable; the Studio draws the slab opaque over its crop.', err);
        return null;
      });
  }

  /** Per-channel max of a brick box over the voxel planes `keep` (a MIP slab tile). */
  function _reducePlaneTile(data, box, axis, keep) {
    const job = { box: { ...box }, axis, keep: Array.from(keep) };
    if (!_planeWorkerInstance()) return Promise.resolve().then(() => StudioPlaneOps.reduceMax(data, job.box, axis, job.keep));
    // The worker takes the buffer itself (the composed brick is this pass's alone).
    const own = data.byteOffset === 0 && data.byteLength === data.buffer.byteLength ? data : data.slice();
    return _planeJob({ op: 'reduce', data: own.buffer, ...job }, [own.buffer], null)
      .then(r => ({ data: r.data instanceof Uint8Array ? r.data : new Uint8Array(r.data), w: r.w, h: r.h }));
  }

  /**
   * The Studio's opening picture: the plane rendered from the atlas already resident
   * on the GPU, as raw channel values (the Studio colours them), at most
   * STUDIO_PREVIEW_MAX px a side. Its crop is the plane's footprint on the volume,
   * computed from the geometry (StudioPlaneOps.cropRect) — no full-frame render, read
   * back and scanned in JS to find it. The native pass frames the same footprint at
   * its own resolution and the Studio re-scales the layers drawn meanwhile.
   * With an explicit `spec` the inspector plane is left untouched (it need not even
   * be shown).
   */
  async function _renderStudioPreviewSlice(spec = null) {
    if (typeof VolumeSlicer === 'undefined' || !VolumeSlicer.renderRawWithMaterial || typeof StudioPlaneOps === 'undefined') return null;
    if (!spec && !VolumeSlicer.isVisible?.()) return null;
    const material = VolumeViewer.getMaterial?.();
    if (!material) return null;
    const dims = (typeof BrickLoader !== 'undefined' && BrickLoader.isReady?.()) ? BrickLoader.getDimensions(0) : null;
    if (!dims) return null;
    if (!spec) spec = VolumeSlicer.getPlaneSpec();
    const nativeRes = _nativeStudioRenderSize(spec, dims);
    const renderRes = Math.min(nativeRes, STUDIO_PREVIEW_MAX);
    const { geom, warp } = _studioGeometry(spec, material);
    const cropRect = StudioPlaneOps.cropRect(geom, renderRes, warp);
    const win = cropRect ? _sliceWindowForRect(cropRect, renderRes) : null;
    if (!win) return null;
    const channelState = _currentChannelState();
    let raw = null;
    let canvas = null;
    try {
      raw = VolumeSlicer.renderRawWithMaterial(material, spec, renderRes, { window: win });
      if (!raw) {
        // No raw values: the colours as rendered (the Studio cannot re-colour them).
        const colour = VolumeSlicer.renderWithMaterial(material, spec, renderRes, channelState, { window: win });
        if (colour) canvas = _copyCanvas(colour);
      }
    } finally {
      VolumeSlicer.releaseHiPass?.();
    }
    if (!raw && !canvas) return null;
    // A four-channel slab has no spare byte for its footprint (channel 3 is data).
    if (_needsCoverageMask(raw)) _withCoverageMask(raw, await _studioCoverageMask(geom, renderRes, win, warp));
    return {
      canvas,
      width: win.w,
      height: win.h,
      renderRes,
      nativeRes,
      cropRect,
      raw,
      // Not 'gpu-slicer': that source makes the Studio re-render the slice through
      // VolumeSlicer.recompose, while this picture is re-coloured from its raw values.
      source: 'studio-preview',
      quality: 'preview',
      planeSpec: spec,
      pixelSizeUm: _slicePixelSizeUm(spec, renderRes),
      calibrated: _studioCalibrated(),
      physicalSizeUm: VolumeViewer.getPhysicalSize?.(),
      channelState,
      timepoint: _currentTimepoint
    };
  }

  function _nativeLabel(dims, progress = {}) {
    const native = _t('viewer.native', 'Native');
    const res = `${native} ${dims.x} × ${dims.y}`;
    // Before the pass has counted its chunks there is nothing to count down.
    if (!(progress.totalChunks > 0)) return res;
    const mb = (bytes) => {
      const v = Math.max(0, Number(bytes) || 0) / 1e6;
      return v < 10 ? v.toFixed(1) : String(Math.round(v));
    };
    let eta = '';
    const seconds = Number(progress.etaSeconds);
    if (Number.isFinite(seconds) && seconds > 0) {
      eta = seconds >= 90
        ? _tf('studio.etaMinutes', '~{m} min left', { m: Math.round(seconds / 60) })
        : _tf('studio.etaSeconds', '~{s} s left', { s: Math.max(1, Math.round(seconds)) });
    }
    const text = _tf('studio.loadingStage', '{res}: {chunks}/{total} chunks · {done}/{size} MB · {eta}', {
      res,
      chunks: progress.chunks || 0,
      total: progress.totalChunks || 0,
      done: mb(progress.bytesDone || 0),
      size: mb(progress.bytesTotal || 0),
      eta
    });
    return text.replace(/\s*·\s*$/, '');
  }

  /**
   * A crop rect ({x, y, x2, y2, renderRes}, inclusive pixel bounds) of one frame
   * expressed in a frame of `renderRes` px — the same region of the plane, every
   * bound scaled by k = renderRes / rect.renderRes and rounded outwards. null when
   * there is no rect.
   */
  function _scaleCropRect(rect, renderRes) {
    if (!rect || !(Number(rect.renderRes) > 0) || !(renderRes > 0)) return null;
    if (rect.renderRes === renderRes) return { ...rect };
    const k = renderRes / rect.renderRes;
    return {
      x: Math.max(0, Math.floor(rect.x * k)),
      y: Math.max(0, Math.floor(rect.y * k)),
      x2: Math.min(renderRes - 1, Math.ceil((rect.x2 + 1) * k) - 1),
      y2: Math.min(renderRes - 1, Math.ceil((rect.y2 + 1) * k) - 1),
      renderRes
    };
  }

  /** _t with the params filled into the English fallback too. */
  function _tf(key, fallback, params) {
    let text = _t(key, fallback, params);
    if (params) Object.keys(params).forEach((p) => { text = text.split(`{${p}}`).join(String(params[p])); });
    return text;
  }

  /** Bricks and bytes the native pass would load for `spec` at `lod` (no network). */
  function _nativePassEstimate(spec, lod) {
    const dims = BrickLoader.getDimensions(lod);
    if (!dims) return null;
    const plan = _nativePassPlan(spec, dims, lod, null);
    if (!plan) return null;
    const channels = Math.max(1, Math.min(4, Number(dims.channels) || Number(datasetMeta?.dimensions?.c) || 1));
    const rgbaTransport = BrickLoader.getTransportEncoding?.() === 'raw-rgba-gzip';
    const wanted = rgbaTransport ? [-1] : _nativeSliceChannels(channels);
    const tasks = [];
    for (const b of plan.bricks) for (const c of wanted) tasks.push({ bx: b.bx, by: b.by, bz: b.bz, lod, channel: c, region: b.region });
    return { bricks: plan.bricks.length, bytes: BrickLoader.estimateTaskBytes?.(tasks) || 0, dims };
  }

  /**
   * A z-stack figure over many slices needs every LOD0 brick of them (the browser's
   * 3D mode keeps the whole stack: gigabytes on the largest datasets). Above
   * STUDIO_CONFIRM_BYTES the operator chooses: native, the next level down, or the
   * preview as it is. → the level to load, or null to keep the preview.
   */
  async function _confirmLargeNativePass(spec) {
    if (!_zstackActive || !(Number(spec?.slabThickness) > 1)) return 0;
    const native = _nativePassEstimate(spec, 0);
    // A format-2 tree reads the slab's planes instead of its bricks.
    const planes = native ? await _planesPassEstimate(spec) : null;
    if (native && planes) native.bytes = planes.bytes;
    if (!native || native.bytes <= STUDIO_CONFIRM_BYTES || typeof Dialog === 'undefined') return 0;
    const levels = Array.isArray(_brickManifest?.levels) ? _brickManifest.levels.length : (BrickLoader.getManifest?.()?.levels?.length || 1);
    let lower = levels > 1 ? _nativePassEstimate(spec, 1) : null;
    // Through the planes the native picture can cost less than the next level's bricks:
    // offering the smaller picture for more bytes would be no choice at all.
    if (lower && !(lower.bytes < native.bytes)) lower = null;
    const mb = (b) => String(Math.max(1, Math.round(b / 1e6)));
    const options = [
      { id: 'native', primary: !lower, variant: lower ? undefined : 'primary', label: _tf('studio.bigPassNative', 'Load native ({mb} MB)', { mb: mb(native.bytes) }) }
    ];
    if (lower) {
      options.push({
        id: 'lower', primary: true, variant: 'primary',
        label: _tf('studio.bigPassLower', 'Load at {x} × {y} ({mb} MB)', { x: lower.dims.x, y: lower.dims.y, mb: mb(lower.bytes) })
      });
    }
    options.push({ id: 'keep', label: _t('studio.bigPassKeep', 'Keep the preview') });
    const choice = await Dialog.ask({
      icon: 'layers',
      title: _t('studio.bigPassTitle', 'Large native figure'),
      message: planes && planes.layers > 0
        ? _tf('studio.bigPassMessageMips', 'This figure projects {n} slices: its native picture reads {layers} stored layer projections and {planes} stored planes, about {mb} MB ({tiles} image tiles).', {
          n: Number(spec.slabThickness) || 1, mb: mb(native.bytes), layers: planes.layers, planes: planes.planes, tiles: planes.tiles
        })
        : planes
        ? _tf('studio.bigPassMessagePlanes', 'This figure projects {n} slices: its native picture reads {planes} stored planes, about {mb} MB ({tiles} image tiles).', {
          n: Number(spec.slabThickness) || 1, mb: mb(native.bytes), planes: planes.planes, tiles: planes.tiles
        })
        : _tf('studio.bigPassMessage', 'This figure projects {n} slices: its native picture needs every brick of them, about {mb} MB ({bricks} bricks).', {
          n: Number(spec.slabThickness) || 1, mb: mb(native.bytes), bricks: native.bricks
        }),
      note: _t('studio.bigPassNote', 'Trim the stack with the z-stack browser\'s handles to load fewer slices.'),
      dismissId: 'keep',
      options
    });
    if (choice === 'native') return 0;
    if (choice === 'lower' && lower) return 1;
    return null;
  }

  /**
   * Upgrades the Studio's picture to native in one pass: the preview stands in
   * wherever a chunk is still on its way, so *Stop here* keeps the picture as it is.
   * `token` (StudioEditor.open's) scopes every progress and picture update to the
   * document it was opened for. A level the GPU cannot hold (the 3D atlas of an
   * oblique cut over budget) is retried one level down, and labelled so.
   */
  async function _upgradeStudioSliceToNative(preview, token) {
    if (typeof BrickLoader === 'undefined' || !BrickLoader.isReady?.()) return;
    const dims0 = BrickLoader.getDimensions(0);
    if (!dims0) return;
    const scoped = { token };
    const spec = preview.planeSpec;
    let lod = await _confirmLargeNativePass(spec);
    if (lod === null || !StudioEditor.isOpen?.() || (StudioEditor.documentToken && StudioEditor.documentToken() !== token)) return;

    _cancelNativeSlice(false);
    const controller = new AbortController();
    _nativeSliceAbort = controller;
    const owns = () => _nativeSliceAbort === controller;
    const onCancel = () => { if (owns()) _cancelNativeSlice(); else controller.abort(); };
    const renderRes = Number(preview.nativeRes) > 0 ? preview.nativeRes : _nativeStudioRenderSize(spec, dims0);
    const levels = BrickLoader.getManifest?.()?.levels?.length || (Array.isArray(_brickManifest?.levels) ? _brickManifest.levels.length : 1);
    let downgradeNote = '';
    const label = (dims, progress) => `${_nativeLabel(dims, progress)}${downgradeNote}`;
    StudioEditor.setLoadProgress?.({ percent: 0, label: label(BrickLoader.getDimensions(lod) || dims0), onCancel }, scoped);
    let missing = 0;
    try {
      let sr = null;
      for (;;) {
        const dims = BrickLoader.getDimensions(lod) || dims0;
        try {
          sr = await _renderNativeSliceForStudio({
            spec,
            renderRes,
            // The preview's crop at the native frame's scale: the picture the Studio swaps
            // in frames the same region, so the layers drawn meanwhile scale with it.
            cropRect: _scaleCropRect(preview.cropRect, renderRes),
            lod,
            controller,
            fallback: { canvas: preview.canvas, raw: preview.raw || null, rect: preview.cropRect },
            onProgress: (progress) => {
              StudioEditor.setLoadProgress?.({ percent: progress.percent, label: label(dims, progress), onCancel }, scoped);
            },
            // Chunks land one after the other, as they do in the 3D view: every partial
            // picture is the same frame with more of it native and the preview elsewhere.
            onPartial: (partial) => {
              if (StudioEditor.isOpen?.()) StudioEditor.setSliceResult(partial, { imageOnly: true, token });
            }
          });
          break;
        } catch (err) {
          const overBudget = err?.code === 'SVR_OVER_BUDGET' || err?.code === 'SVR_ALLOC_FAILED';
          if (!overBudget || lod + 1 >= levels || controller.signal.aborted) throw err;
          lod += 1;
          const lower = BrickLoader.getDimensions(lod);
          console.warn(`[ViewerApp] Native Studio pass does not fit the GPU (${err.message}); retrying at level ${lod}.`);
          downgradeNote = ` · ${_tf('studio.nativeDowngraded', 'GPU memory: {x} × {y}', { x: lower?.x || '?', y: lower?.y || '?' })}`;
          StudioEditor.setLoadProgress?.({ percent: 0, label: label(lower || dims0), onCancel }, scoped);
        }
      }
      if (sr && StudioEditor.isOpen?.()) {
        StudioEditor.setSliceResult(sr, { token });
        missing = Number(sr.missingChunks) || 0;
      }
    } catch (err) {
      if (err?.name !== 'AbortError') {
        console.warn('[ViewerApp] Native Studio slice failed; keeping the picture so far:', err);
        _setSliceStatus(_t('studio.nativeFailed', 'Native resolution unavailable; the picture so far is kept.'));
      }
    } finally {
      if (owns()) _nativeSliceAbort = null;
      StudioEditor.setLoadProgress?.(null, scoped);
    }
    if (missing > 0 && StudioEditor.isOpen?.()) {
      StudioEditor.setLoadProgress?.({
        percent: 100,
        label: _tf('studio.nativeMissing', 'Native resolution: {missing} chunks could not be loaded and stay at preview resolution.', { missing })
      }, scoped);
      setTimeout(() => StudioEditor.setLoadProgress?.(null, scoped), 8000);
    }
  }

  function _bindExportAndWorkspace() {
    if (typeof ExportManager === 'undefined') return;
    ExportManager.init({
      dataset: datasetMeta,
      scope: 'viewer',
      getCanvas: () => document.getElementById('webgl-canvas'),
      renderNow: () => VolumeViewer.renderNow?.(),
      getCanvasBlob: _getFigureBlob,
      getCustomExports: _getAllCustomExports,
      getGraph: _getPluginGraph,
      getWorkspaceState: _getWorkspaceState,
      applyWorkspaceState: _applyWorkspaceState,
      getMeasurements: () => MeasurementStore.list(datasetId, 'viewer')
    });

    // btn-export (Download Center) is generated by PluginRegistry.buildToolbarButtons()
    // and wired by bindToolbarButtons() → the download-center plugin's activate(), which
    // opens the same modal with identical options (getCanvasBlob/getCustomExports are
    // exposed on the ViewerContext). The old manual addEventListener here double-wired
    // the click (the modal opened twice per press) — removed. Save/Restore/Presentation
    // are likewise handled by their plugins via data-plugin-id.
  }

  function _updateCutPlaneUi(state = VolumeViewer.getCutPlaneState()) {

    const label = document.getElementById('cut-plane-position');
    if (label) label.textContent = `${Math.round(state.value * 100)}%`;
    const oblique = document.getElementById('slice-oblique-controls');
    oblique?.classList.add('visible');
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
      if (updateStatus) _setSliceStatus(_t('studio.nativeCancelling', 'Cancelling the native render…'));
    }
  }

  /**
   * The LOD0 bricks the Studio's native pass has to load for `spec` into a 3D atlas
   * (oblique cuts, stabilised timelapses, slabs the plane path cannot reproduce),
   * each with the voxel box of it the shader can sample (`region`; null = the whole
   * brick).
   *
   * The test runs in texture space against the very plane the slicer samples
   * (VolumeSlicer.planeGeometry). The physical anisotropy tilts an oblique plane
   * away from its yaw/pitch/roll normal, and testing bricks against that untilted
   * normal left out the bricks the far ends of the cut actually cross — the black
   * bands of an oblique native slice. A brick is kept when its box comes within the
   * slab's half-thickness of the plane, plus one voxel along the normal for the
   * shader's floor() to a voxel index. Along an axis-aligned plane the sampled
   * voxels of a brick are a short run of planes, so only those are decoded and
   * uploaded: the voxel floor(c·dim), and its neighbour only when c·dim lies within
   * SLACK voxel of their common face — where the GPU's float32 product may floor to
   * either side. (A whole voxel of slack each way pulled a second brick layer in at
   * one plane position in 32 and doubled that cut's download.)
   */
  function _nativeSliceBricksForSpec(spec, dims, lod = 0) {
    if (typeof BrickLoader === 'undefined' || !BrickLoader.activeBricks) return [];
    if (typeof VolumeSlicer === 'undefined' || !VolumeSlicer.planeGeometry) return [];
    // A stabilised timelapse samples the texture at W·x (VOLUME_WARP): the plane the
    // shader reads is the affine image of the cube plane, and planeGeometry gives its
    // centre, normal (L⁻ᵀ·m) and slab half-thickness in texture space. The live
    // material is the one the native pass clones for its throwaway atlas, right after.
    const space = VolumeSlicer.samplingSpace ? VolumeSlicer.samplingSpace(VolumeViewer.getMaterial?.() || null) : null;
    const geom = VolumeSlicer.planeGeometry(spec, VolumeViewer.getPhysicalSize?.(), space);
    const n = geom.normal;
    const nc = geom.center;
    const bs = dims.brickSize || 64;
    const dx = Math.max(1, dims.x || 1);
    const dy = Math.max(1, dims.y || 1);
    const dz = Math.max(1, dims.z || 1);
    const tolerance = geom.halfThickness + Math.abs(n.x) / dx + Math.abs(n.y) / dy + Math.abs(n.z) / dz;
    // float32 keeps a texture coordinate to ~6e-8: a few 1e-4 voxel on the longest axes.
    const SLACK = 4e-3;

    const axis = Math.abs(n.x) > 0.999999 ? 'x' : Math.abs(n.y) > 0.999999 ? 'y' : Math.abs(n.z) > 0.999999 ? 'z' : null;
    let axisRange = null;
    if (axis) {
      const dim = axis === 'x' ? dx : axis === 'y' ? dy : dz;
      const c = nc[axis];
      const h = geom.halfThickness;
      // The shader reads voxel floor(uvw · dim), clamped to the volume.
      const v0 = Math.max(0, Math.floor((c - h) * dim - SLACK));
      const v1 = Math.min(dim - 1, Math.floor((c + h) * dim + SLACK));
      if (v1 < v0) return [];
      axisRange = { v0, v1 };
    }
    // A stabilised timelapse: the registration's rotation leans the texture-space
    // normal off every axis (a Kabsch-stabilised series always carries some), so the
    // branch above never applies, yet a nearly flat cut still reads a short run of
    // voxels of each brick along the axis k the normal leans on most. A sample u of
    // the slab lies within T = halfThickness of the plane, n·(u − center) ∈ [−T, T], so
    //   n_k·u_k ∈ [n·center − T − S_hi, n·center + T − S_lo],
    // [S_lo, S_hi] the range of Σ_{j≠k} n_j·u_j over the brick's footprint (widened by
    // one voxel on each side of each other axis, for floor()); that run of u_k, one
    // voxel of slack each way, is the brick's region. An unwarped oblique cut keeps
    // whole bricks, as before.
    const dimOf = { x: dx, y: dy, z: dz };
    const lean = !axis && geom.warped
      ? ['y', 'z'].reduce((best, k) => (Math.abs(n[k]) > Math.abs(n[best]) ? k : best), 'x')
      : null;
    const leanOthers = lean ? ['x', 'y', 'z'].filter(k => k !== lean) : null;
    const planeAt = lean ? n.x * nc.x + n.y * nc.y + n.z * nc.z : 0;
    const anx = Math.abs(n.x);
    const any = Math.abs(n.y);
    const anz = Math.abs(n.z);

    const bricks = [];
    for (const b of BrickLoader.activeBricks(lod)) {
      const ox = b.bx * bs;
      const oy = b.by * bs;
      const oz = b.bz * bs;
      const bw = Math.min(bs, dims.x - ox);
      const bh = Math.min(bs, dims.y - oy);
      const bd = Math.min(bs, dims.z - oz);
      if (bw <= 0 || bh <= 0 || bd <= 0) continue;
      let region = null;
      if (axisRange) {
        const o = axis === 'x' ? ox : axis === 'y' ? oy : oz;
        const extent = axis === 'x' ? bw : axis === 'y' ? bh : bd;
        const lo = Math.max(0, axisRange.v0 - o);
        const hi = Math.min(extent - 1, axisRange.v1 - o);
        if (hi < lo) continue;
        region = { x0: 0, x1: bw, y0: 0, y1: bh, z0: 0, z1: bd };
        region[axis + '0'] = lo;
        region[axis + '1'] = hi + 1;
      } else {
        // The brick box (texture units) against the slab: |n·(centre − c)| ≤ Σ|n_k|·half-extent_k + tolerance.
        const ex = bw / (2 * dx);
        const ey = bh / (2 * dy);
        const ez = bd / (2 * dz);
        const cx = ox / dx + ex;
        const cy = oy / dy + ey;
        const cz = oz / dz + ez;
        const dist = Math.abs(n.x * (cx - nc.x) + n.y * (cy - nc.y) + n.z * (cz - nc.z));
        if (dist > anx * ex + any * ey + anz * ez + tolerance) continue;
        if (lean) {
          const o = { x: ox, y: oy, z: oz };
          const e = { x: bw, y: bh, z: bd };
          let sLo = 0;
          let sHi = 0;
          for (const j of leanOthers) {
            const a = n[j] * (o[j] - 1) / dimOf[j];
            const c = n[j] * (o[j] + e[j] + 1) / dimOf[j];
            sLo += Math.min(a, c);
            sHi += Math.max(a, c);
          }
          const h = geom.halfThickness;
          const u0 = (planeAt - h - sHi) / n[lean];
          const u1 = (planeAt + h - sLo) / n[lean];
          const dim = dimOf[lean];
          const lo = Math.max(0, Math.floor(Math.min(u0, u1) * dim) - 1 - o[lean]);
          const hi = Math.min(e[lean] - 1, Math.floor(Math.max(u0, u1) * dim) + 1 - o[lean]);
          if (hi < lo) continue;
          if (lo > 0 || hi < e[lean] - 1) {
            region = { x0: 0, x1: bw, y0: 0, y1: bh, z0: 0, z1: bd };
            region[lean + '0'] = lo;
            region[lean + '1'] = hi + 1;
          }
        }
      }
      bricks.push({ bx: b.bx, by: b.by, bz: b.bz, region });
    }
    return bricks;
  }

  function _nativeStudioRenderSize(spec, dims) {
    let maxDim = Math.max(dims.x || 1, dims.y || 1);
    if (spec.mode === 'xz') maxDim = Math.max(dims.x || 1, dims.z || 1);
    else if (spec.mode === 'yz') maxDim = Math.max(dims.y || 1, dims.z || 1);
    // About one render pixel per voxel of the longest axis: the frame spans
    // getPlaneExtentUnits() longest-axis lengths — 1.5, or more for a stabilised
    // timelapse whose display box needs a larger frame (VolumeSlicer.frameExtent).
    // The slicer renders it in tiles and only the crop is read back, so the frame is
    // not held to a render-target size: 8192 used to decimate the 5735² datasets to
    // 0.95 px per voxel. 16384 px is the canvas side browsers reliably draw.
    const units = typeof VolumeSlicer !== 'undefined' && VolumeSlicer.getPlaneExtentUnits
      ? VolumeSlicer.getPlaneExtentUnits(VolumeViewer.getMaterial?.())
      : 1.5;
    return Math.max(512, Math.min(16384, Math.ceil(maxDim * units)));
  }

  // A capture for the Compare Studio: about one render pixel per voxel of the longest
  // in-plane axis across the slicer frame (1.5 units, wider on a stabilised timelapse),
  // within the 16384 px a canvas side reliably holds.
  function _captureRenderRes(maxRes) {
    const units = typeof VolumeSlicer !== 'undefined' && VolumeSlicer.getPlaneExtentUnits
      ? VolumeSlicer.getPlaneExtentUnits(VolumeViewer.getMaterial?.())
      : 1.5;
    return Math.min(16384, Math.ceil(maxRes * (Number(units) > 0 ? Number(units) : 1.5)));
  }

  /**
   * µm per pixel of a slicer render at `renderRes` px — the same for every plane
   * and along both axes. The slicer draws 2·EXTENT quad units across the frame and
   * a quad unit along the unit in-plane direction v is the texture step v ⊙ maxP/p
   * (VolumeSlicer.planeGeometry), i.e. the physical length |v ⊙ maxP/p ⊙ p| = maxP:
   * the pixel is 2·EXTENT·maxP / renderRes, square, whatever the plane — the length
   * the slice stage's scale bar uses. (Weighting v by p instead only equals that
   * along the longest axis: an XZ cut's vertical and a non-square XY cut's short
   * axis came out short by p_axis / maxP.) A missing axis counts as 1, as in
   * planeGeometry. 2·EXTENT is the frame of the volume material on screen: larger
   * for a stabilised timelapse (VolumeSlicer.frameExtent), same formula.
   */
  function _slicePixelSizeUm(_spec, renderRes) {
    const physical = VolumeViewer.getPhysicalSize?.() || null;
    const axis = (v) => (Number(v) > 0 ? Number(v) : 1);
    const maxP = Math.max(axis(physical?.x), axis(physical?.y), axis(physical?.z));
    const units = typeof VolumeSlicer !== 'undefined' && VolumeSlicer.getPlaneExtentUnits
      ? VolumeSlicer.getPlaneExtentUnits(VolumeViewer.getMaterial?.())
      : 1.5;
    const um = (units * maxP) / Math.max(1, renderRes);
    return { x: um, y: um };
  }

  function _copyCanvas(canvas) {
    const out = document.createElement('canvas');
    out.width = canvas.width;
    out.height = canvas.height;
    out.getContext('2d').drawImage(canvas, 0, 0);
    return out;
  }

  /**
   * The frame window {x, y, w, h} a crop rect ({x, y, x2, y2, renderRes}, inclusive
   * pixel bounds) cuts out of a `size` px frame — null when the rect is unusable or
   * drawn at another size.
   */
  function _sliceWindowForRect(rect, size) {
    if (!rect || !Number.isFinite(rect.x) || !Number.isFinite(rect.x2)) return null;
    if (rect.renderRes && rect.renderRes !== size) return null;
    const minX = Math.max(0, Math.round(rect.x));
    const minY = Math.max(0, Math.round(rect.y));
    const maxX = Math.min(size - 1, Math.round(rect.x2));
    const maxY = Math.min(size - 1, Math.round(rect.y2));
    if (minX > maxX || minY > maxY) return null;
    return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
  }

  /**
   * The raw channel values (VolumeSlicer.renderRawWithMaterial) of `spec` at
   * `renderRes`, cut to exactly the window `cropRect` gives the colour render (null
   * cropRect: the whole frame). The Studio colours them with its own channel state
   * (SliceCompositor). null when they cannot be rendered: the picture then keeps the
   * colours it was rendered with. A slab's raw (the z-stack browser's MIP, an
   * inspector MIP / average) carries `projected` (and `coverage`) from the slicer
   * itself, so the Studio draws it opaque like the colour picture. `colour` is that
   * colour picture (same crop): a slab of four channels has no spare byte for its
   * footprint, so it gets `coverageMask` from the colour picture's alpha
   * (_sliceCoverageMask) and the Studio keeps the pixels off the volume transparent,
   * as the colour picture does.
   */
  function _studioRawFor(spec, renderRes, cropRect, colour = null) {
    if (typeof SliceCompositor === 'undefined' || typeof VolumeSlicer === 'undefined' || !VolumeSlicer.renderRawWithMaterial) return null;
    const material = VolumeViewer.getMaterial?.();
    if (!material || !spec) return null;
    const win = cropRect ? _sliceWindowForRect(cropRect, renderRes) : null;
    if (cropRect && !win) return null;
    let raw;
    try {
      raw = VolumeSlicer.renderRawWithMaterial(material, spec, renderRes, { window: win });
    } catch (err) {
      console.warn('[ViewerApp] Raw slice values unavailable; the Studio keeps the rendered colours.', err);
      return null;
    }
    if (_needsCoverageMask(raw)) _withCoverageMask(raw, _sliceCoverageMask(colour, raw.width, raw.height));
    return raw;
  }

  /** A projected slab whose raw has no footprint of its own (four channels: no channel 3 to spare). */
  function _needsCoverageMask(raw) {
    return Boolean(raw && raw.projected === true && raw.coverage !== true);
  }

  /**
   * Sets `mask` as `raw.coverageMask` when the raw needs one and the mask is one byte
   * per pixel of it (the same crop); `raw` is returned either way. Without a mask
   * the Studio draws a four-channel slab opaque over its whole crop.
   */
  function _withCoverageMask(raw, mask) {
    if (!_needsCoverageMask(raw)) return raw;
    if (ArrayBuffer.isView(mask) && mask.BYTES_PER_ELEMENT === 1 && mask.length === raw.width * raw.height) {
      raw.coverageMask = mask;
    }
    return raw;
  }

  /**
   * The footprint of a slab on the volume, read from the COLOUR render of the same
   * plane, frame and crop — no extra GPU render: the slicer's colour path writes a
   * slab opaque exactly where one of its samples lies in the volume (hits > 0) and
   * discards elsewhere, over a target cleared to alpha 0, so the picture's alpha is 0
   * or 255 and is the coverage. → Uint8Array(width·height), 255 covered / 0 not, rows
   * top-down like a raw; null when `canvas` is not width × height or cannot be read.
   * Read in bands of rows: a native crop is tens of megapixels, and one getImageData
   * would hold four bytes per pixel of it at once.
   */
  function _sliceCoverageMask(canvas, width, height) {
    if (!canvas || canvas.width !== width || canvas.height !== height || !(width > 0 && height > 0)) return null;
    // 4 Mpx a band (16 MB of RGBA): a handful of readbacks for a native crop.
    const BAND_ROWS = Math.max(1, Math.floor((1 << 22) / width));
    try {
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      const mask = new Uint8Array(width * height);
      for (let y0 = 0; y0 < height; y0 += BAND_ROWS) {
        const rows = Math.min(BAND_ROWS, height - y0);
        const px = ctx.getImageData(0, y0, width, rows).data;
        for (let i = 0, o = y0 * width, n = rows * width; i < n; i++, o++) {
          if (px[i * 4 + 3] >= 128) mask[o] = 255;
        }
      }
      return mask;
    } catch (err) {
      console.warn('[ViewerApp] Slab footprint unavailable; the Studio draws the slab opaque over its crop.', err);
      return null;
    }
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

  // ── Brick frames (v2 64³, v3 66³ with a 1-voxel border, SPEC §13.2) ────────────

  /**
   * The frame the mounted tree delivers its bricks in: { apron: 0, stride: 64 } for a
   * v2 tree, { apron: 1, stride: 66 } for a v3 one, whose stored voxel s of an axis is
   * the volume voxel 64·b − 1 + s (BrickLoader.getFormat).
   */
  function _nativeBrickFrame() {
    const fmt = typeof BrickLoader !== 'undefined' && BrickLoader.getFormat ? BrickLoader.getFormat() : null;
    const apron = Number(fmt?.apron) === 1 ? 1 : 0;
    return { apron, stride: 64 + 2 * apron };
  }

  /**
   * The box of brick `brick` a native task asks the loader for. `region` is a box of
   * the brick's INTERIOR (voxels [0, 64) of each axis, null = every interior voxel
   * inside the volume) — the frame the page's brick pickers and both backends work in.
   * v2: that box. v3: the same voxels in the stored 66³ frame (+1 on every bound), so
   * the loader decodes and hands over exactly them; with `border` the box grows by the
   * 1-voxel border on each side ([x0, x1 + 2) in the stored frame — the voxels a 66³
   * atlas slot holds around them; null = the whole stored brick, the loader cutting it
   * to the voxels in [−1, dimension]).
   */
  function _nativeLoaderRegion(brick, region, dims, frame, border = false) {
    if (!frame || !frame.apron) return region || null;
    if (border && !region) return null;
    const bs = 64;
    const a = frame.apron;
    // The interior voxels inside the volume: past its far face the stored frame holds
    // a clamped copy of the last voxel, which is no voxel of the brick's own.
    const ext = {
      x: Math.min(bs, dims.x - brick.bx * bs),
      y: Math.min(bs, dims.y - brick.by * bs),
      z: Math.min(bs, dims.z - brick.bz * bs)
    };
    const src = region || { x0: 0, x1: ext.x, y0: 0, y1: ext.y, z0: 0, z1: ext.z };
    const r = {
      x0: src.x0, x1: Math.min(src.x1, ext.x),
      y0: src.y0, y1: Math.min(src.y1, ext.y),
      z0: src.z0, z1: Math.min(src.z1, ext.z)
    };
    if (border) return { x0: r.x0, x1: r.x1 + 2 * a, y0: r.y0, y1: r.y1 + 2 * a, z0: r.z0, z1: r.z1 + 2 * a };
    return { x0: r.x0 + a, x1: r.x1 + a, y0: r.y0 + a, y1: r.y1 + a, z0: r.z0 + a, z1: r.z1 + a };
  }

  /** A box the loader delivered (stored frame) back in the interior frame; null stays null (a whole v2 brick). */
  function _nativeInteriorRegion(region, frame) {
    if (!frame || !frame.apron || !region) return region || null;
    const a = frame.apron;
    return { x0: region.x0 - a, x1: region.x1 - a, y0: region.y0 - a, y1: region.y1 - a, z0: region.z0 - a, z1: region.z1 - a };
  }

  // ── Format-2 planes/ (the native level re-cut into XY planes, SPEC §3/§8) ──────
  const _planeTrees = new Map();   // planes base → Promise<PlaneLoader tree | null>

  /**
   * The planes/ directory of the brick tree on screen: <ds>/planes, or
   * <ds>/planes/tNNN for the timepoint of a timelapse. null when the dataset does not
   * claim format 2, or is a staging preview (its bytes come through the blob proxy,
   * whose `path` query cannot carry the packs' `?v=`).
   */
  function _planesBaseOnScreen() {
    if (typeof PlaneLoader === 'undefined' || typeof PlaneCodec === 'undefined') return null;
    if (!(Number(datasetMeta?.formatVersion) >= 2)) return null;
    if (!_basePath || !_basePath.startsWith('DATA_WEB/')) return null;
    const tps = _brickManifest?.timepoints;
    if (tps && typeof tps === 'object') {
      const tp = Number.isFinite(Number(_currentTimepoint)) ? Number(_currentTimepoint) : 0;
      const key = `t${String(tp).padStart(3, '0')}`;
      const row = tps[key] ?? tps[String(tp)] ?? tps[tp];
      return row ? `${_basePath}/planes/${row.path || key}` : null;
    }
    return `${_basePath}/planes`;
  }

  /** The opened planes tree on screen (once per tree), or null — never throws. */
  function _planesTreeOnScreen(dims0) {
    const base = _planesBaseOnScreen();
    if (!base || !dims0) return Promise.resolve(null);
    let p = _planeTrees.get(base);
    if (!p) {
      const brickDir = datasetMeta?.qualities?.native?.directory || 'bricks';
      p = PlaneLoader.open(base, {
        dimensions: { x: dims0.x, y: dims0.y, z: dims0.z },
        channels: Number(dims0.channels) > 0 ? Number(dims0.channels) : null,
        sourceManifestUrl: `${_basePath}/${brickDir}/manifest.json`
      }).catch((err) => {
        console.warn(`[ViewerApp] ${base} is not usable; the Studio reads the bricks.`, err?.message || err);
        return null;
      });
      _planeTrees.set(base, p);
    }
    return p;
  }

  /**
   * The format-3 mips/ tree beside the planes on screen (SPEC §12: per brick layer
   * the per-channel maximum over its 64 planes), opened once per tree, or null —
   * never throws. Same directory rule as planes/ (mips/, mips/tNNN).
   */
  function _mipsTreeOnScreen(dims0) {
    if (!(Number(datasetMeta?.formatVersion) >= 3) || !PlaneLoader.openMips) return Promise.resolve(null);
    const planesBase = _planesBaseOnScreen();
    if (!planesBase || !dims0) return Promise.resolve(null);
    const base = planesBase.replace(/\/planes(\/|$)/, '/mips$1');
    if (base === planesBase) return Promise.resolve(null);
    let p = _planeTrees.get(base);
    if (!p) {
      const brickDir = datasetMeta?.qualities?.native?.directory || 'bricks';
      p = PlaneLoader.openMips(base, {
        dimensions: { x: dims0.x, y: dims0.y, z: dims0.z },
        channels: Number(dims0.channels) > 0 ? Number(dims0.channels) : null,
        sourceManifestUrl: `${_basePath}/${brickDir}/manifest.json`
      }).catch((err) => {
        console.warn(`[ViewerApp] ${base} is not usable; the Studio reads the planes.`, err?.message || err);
        return null;
      });
      _planeTrees.set(base, p);
    }
    return p;
  }

  /**
   * The slab [z0, z1) a MIP plan reads when it samples EVERY plane of it (the z-stack
   * figures: one sample per slice) — the only case a layer MIP may stand for its 64
   * planes (SPEC §12) — else null.
   */
  function _mipsSlabOf(plan) {
    if (!plan || !plan.reduced || plan.axis !== 'z' || !Array.isArray(plan.voxels) || !plan.voxels.length) return null;
    const v = plan.voxels;
    const z0 = v[0];
    const z1 = v[v.length - 1] + 1;
    if (z1 - z0 !== v.length) return null;
    for (let i = 1; i < v.length; i++) if (v[i] !== v[i - 1] + 1) return null;
    return { z0, z1 };
  }

  /**
   * What a MIP slab costs through the layer MIPs: { bytes, tiles, layers, planes }
   * (headers sampled), or null when the slab has no whole layer in it.
   */
  async function _mipsSlabEstimate(planesTree, mipsTree, slab, chans, rect, opts = {}) {
    const split = PlaneLoader.planSlabMax(slab.z0, slab.z1, planesTree.dimensions.z);
    if (!split.layers.length) return null;
    const a = await mipsTree.estimate(split.layers, chans, rect, { ...opts, sample: Math.min(16, split.layers.length) });
    const b = split.planes.length
      ? await planesTree.estimate(split.planes, chans, rect, { ...opts, sample: Math.min(16, split.planes.length) })
      : { bytes: 0, tiles: 0 };
    return { bytes: a.bytes + b.bytes, tiles: a.tiles + b.tiles, layers: split.layers.length, planes: split.planes.length };
  }

  /** A pass the planes can serve: an XY plane (or MIP slab) of the plane path at LOD0. */
  function _planesServePass(passPlan, lod) {
    return lod === 0 && passPlan?.path === 'plane' && Boolean(passPlan.plan) && !passPlan.plan.empty && passPlan.plan.axis === 'z';
  }

  /**
   * What the planes would fetch for the native pass of `spec`: { bytes, tiles, planes }
   * (an estimate from a sample of plane headers), or null when the planes cannot serve it.
   */
  async function _planesPassEstimate(spec) {
    try {
      const dims = BrickLoader.getDimensions(0);
      if (!dims) return null;
      const passPlan = _nativePassPlan(spec, dims, 0, null);
      if (!_planesServePass(passPlan, 0)) return null;
      const tree = await _planesTreeOnScreen(dims);
      if (!tree) return null;
      const channels = Math.min(4, Math.max(1, Number(dims.channels) || Number(datasetMeta?.dimensions?.c) || 1));
      const chans = BrickLoader.getTransportEncoding?.() === 'raw-rgba-gzip'
        ? Array.from({ length: channels }, (_, c) => c)
        : _nativeSliceChannels(channels);
      const rect = { x0: 0, y0: 0, x1: dims.x, y1: dims.y };
      // A whole-stack figure of a format-3 tree reads one layer MIP per 64 planes.
      const slab = _mipsSlabOf(passPlan.plan);
      const mips = slab ? await _mipsTreeOnScreen(dims) : null;
      if (mips) {
        try {
          const viaMips = await _mipsSlabEstimate(tree, mips, slab, chans, rect);
          if (viaMips) return viaMips;
        } catch (err) { /* the planes estimate below */ }
      }
      const est = await tree.estimate(passPlan.plan.voxels, chans, rect, { sample: 16 });
      return { bytes: est.bytes, tiles: est.tiles, planes: passPlan.plan.voxels.length, layers: 0 };
    } catch (err) {
      return null;
    }
  }

  /**
   * How the native pass of `spec` at `lod` gets its voxels: 'plane' — an axis-aligned
   * plane of an unwarped volume read from a 2D array texture of exactly the voxel
   * planes it samples (StudioPlaneOps.planePlan; one plane: ~0.1 GiB of VRAM where the
   * atlas took 1–7 GiB), or 'atlas' — a throwaway 3D atlas of the bricks
   * _nativeSliceBricksForSpec picks (oblique cuts, stabilised timelapses, an average
   * slab, a slab sample on a voxel face).
   *   options.plane    false keeps the atlas (no raw output to read the plane into)
   *   options.reduced  false refuses a MIP plane: without a fallback picture the
   *                    shader shows a slab short of a brick that failed from the bricks
   *                    it has, which the reduced plane cannot.
   */
  function _nativePassPlan(spec, dims, lod, options = null) {
    const allowPlane = options?.plane !== false;
    const allowReduced = options?.reduced !== false;
    const bs = dims.brickSize || 64;
    if (allowPlane && typeof StudioPlaneOps !== 'undefined' && VolumeSlicer.createPlaneVolume) {
      const { geom } = _studioGeometry(spec);
      const plan = geom && !geom.warped ? StudioPlaneOps.planePlan(geom, dims, BrickLoader.activeBricks(lod), bs) : null;
      if (plan && plan.empty) return { path: 'plane', plan, bricks: [] };
      if (plan && (!plan.reduced || allowReduced)) return { path: 'plane', plan, bricks: plan.bricks };
    }
    return { path: 'atlas', plan: null, bricks: _nativeSliceBricksForSpec(spec, dims, lod) };
  }

  /**
   * The throwaway 3D atlas of an atlas pass: a copy of the volume material (so the
   * slicer reads this atlas, not the one on screen) and an SVRManager sized for
   * `bricks` within the VRAM budget — over it, init throws err.code SVR_OVER_BUDGET /
   * SVR_ALLOC_FAILED and the caller tries the next level down. The bricks level `lod`
   * does not store (ESS-dropped) point at one slot of zeros: they ARE zero voxels, not
   * bricks still on their way, so the preview never stands in for them (a MIP slab
   * crosses some in most columns of a specimen).
   */
  function _atlasNativeBackend(dims, channels, bricks, lod) {
    const renderer = VolumeViewer.getRenderer();
    const sourceMaterial = VolumeViewer.getMaterial();
    const tempMaterial = sourceMaterial.clone();
    tempMaterial.defines = { ...(sourceMaterial.defines || {}) };
    if (THREE.UniformsUtils) tempMaterial.uniforms = THREE.UniformsUtils.clone(sourceMaterial.uniforms);
    // A stabilised timelapse: the pass samples the timepoint on screen in the frame on
    // screen. The define copy above carries VOLUME_WARP; the warp and the display box
    // are copies of the ones on screen now (the brick picker just read the same
    // material), frozen for the pass — the slicer reads its sampling space from THIS
    // material (VolumeSlicer.samplingSpace), so plane, bricks and render agree.
    for (const k of ['volumeWarp', 'clipBoxMin', 'clipBoxSize']) {
      const v = sourceMaterial.uniforms?.[k]?.value;
      if (v?.clone && tempMaterial.uniforms) tempMaterial.uniforms[k] = { value: v.clone() };
    }
    const bs = dims.brickSize || 64;
    // A v3 tree: an atlas whose slots hold the stored 66³ (SVRManager reports `apron`
    // 1, its material sampling slot origin + 1 + local voxel) takes the bricks with
    // their border; any other atlas takes the 64³ interiors, as from a v2 tree.
    const frame = _nativeBrickFrame();
    const tempSvr = new SVRManager();
    try {
      tempSvr.init(channels, dims, renderer, tempMaterial, { targetSlots: bricks.length + 1, apron: frame.apron });
    } catch (err) {
      tempSvr.dispose?.();
      tempMaterial.dispose?.();
      throw err;
    }
    const apron = frame.apron && Number(tempSvr.apron) === frame.apron ? frame.apron : 0;
    if (BrickLoader.hasBrick) tempSvr.pointEmptyBricks((bx, by, bz) => !BrickLoader.hasBrick(bx, by, bz, lod));
    return {
      kind: 'atlas',
      material: tempMaterial,
      plane: null,
      apron,
      /**
       * A composed brick box (whole interior bricks come with no region). With `apron`
       * the box is in the stored 66³ frame (null = the whole stored brick, cut to the
       * volume). → bricks written.
       */
      write(brick, data, region) {
        if (apron) {
          const s = bs + 2 * apron;
          const r = region || {
            x0: 0, x1: Math.min(s, dims.x - brick.bx * bs + 2 * apron),
            y0: 0, y1: Math.min(s, dims.y - brick.by * bs + 2 * apron),
            z0: 0, z1: Math.min(s, dims.z - brick.bz * bs + 2 * apron)
          };
          return tempSvr.writeRgbaBrickRegion(brick.bx, brick.by, brick.bz, data, r.x0, r.y0, r.z0, r.x1 - r.x0, r.y1 - r.y0, r.z1 - r.z0) ? 1 : 0;
        }
        const r = region || {
          x0: 0, x1: Math.min(bs, dims.x - brick.bx * bs),
          y0: 0, y1: Math.min(bs, dims.y - brick.by * bs),
          z0: 0, z1: Math.min(bs, dims.z - brick.bz * bs)
        };
        return tempSvr.writeRgbaBrickRegion(brick.bx, brick.by, brick.bz, data, r.x0, r.y0, r.z0, r.x1 - r.x0, r.y1 - r.y0, r.z1 - r.z0) ? 1 : 0;
      },
      /** Uploads the GPU refused since the last check (their page entries are cleared). → bricks lost. */
      flush() {
        return (tempSvr.flushUploadErrors?.() || []).length;
      },
      dispose() {
        tempSvr.dispose?.();
        tempMaterial.dispose?.();
      }
    };
  }

  /**
   * The plane texture of a plane pass (VolumeSlicer.createPlaneVolume). One plane: a
   * brick's voxel plane(s) are cut out of its box here (a 64 × 64 copy) and uploaded
   * as they land. A MIP slab: each brick box is reduced to its per-channel maximum in
   * the plane worker, the column's bricks are max-ed together, and the column is
   * uploaded — and marked present — once all of them are in. → throws err.code
   * PLANE_UNSUPPORTED / PLANE_ALLOC_FAILED (the caller falls back to the atlas).
   */
  function _planeNativeBackend(plan, dims, channels) {
    const plane = VolumeSlicer.createPlaneVolume({
      axis: plan.axis, dims, layers: plan.layers, layerBase: plan.layerBase, reduced: plan.reduced, brickSize: plan.bs
    });
    // The channel count is all the raw shader takes from the volume material here.
    const numChannels = Number(VolumeViewer.getMaterial?.()?.uniforms?.numChannels?.value);
    const material = { defines: {}, uniforms: { numChannels: { value: Number.isFinite(numChannels) && numChannels > 0 ? numChannels : channels } } };
    const columns = new Map();
    for (const [key, col] of plan.columns) columns.set(key, { ...col, got: 0, tile: null });
    // A column (and layer) no brick of the plan fills is made of ESS-dropped bricks:
    // zero voxels, which the texture already holds (WebGL zero-initialises storage).
    // Present from the start, or the preview would stand in for it for good.
    const awaited = new Set();
    if (plan.reduced) for (const key of plan.columns.keys()) awaited.add(`${key}_0`);
    else for (const b of plan.bricks) for (const lo of b.layerOffsets || []) awaited.add(`${b.column}_${lo.layer}`);
    const cu = Math.ceil(plane.width / plan.bs);
    const cv = Math.ceil(plane.height / plan.bs);
    for (let layer = 0; layer < plane.layers; layer++) {
      for (let bv = 0; bv < cv; bv++) {
        for (let bu = 0; bu < cu; bu++) {
          if (!awaited.has(`${bu}_${bv}_${layer}`)) plane.setPresent(bu, bv, layer, true);
        }
      }
    }
    return {
      kind: 'plane',
      material,
      plane,
      write(brick, data, region) {
        const box = StudioPlaneOps.boxOf(region, plan.bs);
        const place = StudioPlaneOps.tilePlacement(brick, box, plan.axis, plan.bs);
        const col = columns.get(brick.column);
        if (!col) return 0;
        if (!plan.reduced) {
          for (const lo of brick.layerOffsets || []) {
            const tile = StudioPlaneOps.extractLayer(data, box, plan.axis, lo.offset);
            if (!plane.upload(place.u0, place.v0, tile.w, tile.h, lo.layer, tile.data)) return 0;
            plane.setPresent(col.bu, col.bv, lo.layer, true);
          }
          return 1;
        }
        return _reducePlaneTile(data, box, plan.axis, brick.keep).then((tile) => {
          if (!col.tile) col.tile = tile.data;
          else {
            const acc = col.tile;
            const t = tile.data;
            for (let i = 0; i < acc.length; i++) if (t[i] > acc[i]) acc[i] = t[i];
          }
          col.got += 1;
          if (col.got < col.need) return 0;
          const ok = plane.upload(place.u0, place.v0, tile.w, tile.h, 0, col.tile);
          col.tile = null;
          if (!ok) return 0;
          plane.setPresent(col.bu, col.bv, 0, true);
          return col.need;
        });
      },
      /** Tiles the GPU refused since the last check (marked absent again). → bricks lost. */
      flush() {
        let lost = 0;
        for (const t of plane.flushErrors()) {
          if (!plan.reduced) lost += 1;
          else {
            const col = [...columns.values()].find(c => c.bu === t.bu && c.bv === t.bv);
            lost += col ? col.need : 1;
          }
        }
        return lost;
      },
      dispose() {
        plane.dispose();
        columns.clear();
      }
    };
  }

  /**
   * Renders `options.spec` (the inspector plane by default) at the resolution of
   * brick level `options.lod` (LOD0 = native) in a frame of `options.renderRes` px,
   * cut to the plane's footprint on the volume (`options.cropRect`, else computed
   * from the geometry). The bricks the plane reads stream in through their own loader
   * batch (own group and signal: a viewer stream started meanwhile cannot cancel or
   * drop them), composed and floor-LUT'ed in the decode workers, into a plane texture
   * or a throwaway 3D atlas (_nativePassPlan). `options.onPartial` receives a picture
   * of the same frame every few hundred milliseconds while chunks land,
   * `options.fallback` ({ raw, canvas, rect }: the Studio preview and ITS crop rect)
   * standing in wherever a chunk is still missing. A chunk that fails for good (the
   * failed channels are retried once, alone) keeps those preview pixels in the final
   * picture: `missingChunks` = bricks − bricks written, and such a picture is labelled
   * 'native-partial', never 'native'. In raw mode every picture is raw channel values
   * (`raw`, one buffer refilled in place, `canvas` null).
   * `options.controller` is the caller's AbortController (else one of its own).
   * Throws err.code SVR_OVER_BUDGET / SVR_ALLOC_FAILED when the atlas does not fit.
   */
  async function _renderNativeSliceForStudio(options = {}) {
    if (typeof BrickLoader === 'undefined' || typeof SVRManager === 'undefined' || typeof VolumeSlicer === 'undefined' || typeof StudioPlaneOps === 'undefined') return null;
    if (!BrickLoader.isReady?.() || !VolumeSlicer.renderWithMaterial || !VolumeViewer.getRenderer?.() || !VolumeViewer.getMaterial?.()) return null;

    const controller = options.controller || new AbortController();
    if (!options.controller) {
      _cancelNativeSlice(false);
      _nativeSliceAbort = controller;
    }
    const lod = Math.max(0, Math.floor(Number(options.lod) || 0));
    const dims = BrickLoader.getDimensions(lod);
    if (!dims) return null;
    const channelCount = Math.max(1, Number(dims.channels) || Number(datasetMeta?.dimensions?.c) || 1);
    // The shader and the atlas carry four channels: a fifth is not shown (said at mount).
    const channels = Math.min(4, channelCount);
    // The plane the preview was framed on: the inspector's, or the one handed in
    // (the Z-stack browser's slab), so the native pass swaps pixels under the same frame.
    const spec = options.spec || VolumeSlicer.getPlaneSpec();
    const sourceMaterial = VolumeViewer.getMaterial();
    const renderRes = Number(options.renderRes) > 0 ? Math.round(options.renderRes) : _nativeStudioRenderSize(spec, dims);
    const { geom, warp } = _studioGeometry(spec, sourceMaterial);
    const cropRect = options.cropRect || StudioPlaneOps.cropRect(geom, renderRes, warp);
    const sliceWindow = cropRect ? _sliceWindowForRect(cropRect, renderRes) : null;
    if (!sliceWindow) return null;

    // Raw mode: the pass reads back the sampled channel values, not colours, and the
    // Studio colours them with its own channel state (SliceCompositor) — an edit made
    // in the Studio survives every refresh. The preview's raw values stand in for the
    // chunks still missing, and for the channels the pass does not download (off in
    // the viewer): switched on in the Studio they show at preview resolution instead
    // of black. The preview is looked up by frame position, at its own resolution.
    const previewRaw = options.fallback?.raw && typeof SliceCompositor !== 'undefined' && SliceCompositor.isRaw(options.fallback.raw)
      ? options.fallback.raw : null;
    const previewCanvas = options.fallback?.canvas || null;
    const fallbackRect = options.fallback?.rect || options.cropRect || null;
    const rawMode = Boolean(typeof SliceCompositor !== 'undefined' && VolumeSlicer.renderRawWithMaterial && (previewRaw || !previewCanvas));
    const rawFallback = rawMode && previewRaw && fallbackRect ? { raw: previewRaw, rect: fallbackRect } : null;
    const colourFallback = !rawMode && previewCanvas && fallbackRect ? { canvas: previewCanvas, rect: fallbackRect } : null;

    const rgbaTransport = BrickLoader.getTransportEncoding?.() === 'raw-rgba-gzip';
    const floorLuts = (VolumeViewer.floorLutsFromManifest?.(BrickLoader.getManifest?.(), channels) || []).slice(0, channels);
    // Scalar transport stores one pack set per channel, so a disabled channel is a
    // whole quarter of the traffic that never reaches a pixel. RGBA transport packs
    // all four together — there is nothing to skip there.
    const wantedChannels = rgbaTransport ? null : _nativeSliceChannels(channels);
    const previewOnlyChannels = wantedChannels
      ? Array.from({ length: channels }, (_, c) => c).filter(c => !wantedChannels.includes(c))
      : [];
    const channelState = _currentChannelState();

    let passPlan = _nativePassPlan(spec, dims, lod, { plane: rawMode, reduced: Boolean(rawFallback) });
    let backend = null;
    if (passPlan.path === 'plane' && passPlan.bricks.length) {
      try {
        backend = _planeNativeBackend(passPlan.plan, dims, channels);
      } catch (err) {
        console.warn('[ViewerApp] Plane texture unavailable; the native pass uses a 3D atlas.', err?.message || err);
        passPlan = { path: 'atlas', plan: null, bricks: _nativeSliceBricksForSpec(spec, dims, lod) };
      }
    }
    const bricks = passPlan.bricks;
    if (!bricks.length) {
      backend?.dispose?.();
      return null;
    }
    if (!backend) backend = _atlasNativeBackend(dims, channels, bricks, lod);
    const brickFrame = _nativeBrickFrame();
    let borderFrame = Boolean(backend.apron);
    // An XY cut of a format-2 tree reads its planes/: the voxels of the plane alone,
    // not the 64 slices of every brick it crosses (any failure: the bricks, below).
    const planesTree = backend.plane && _planesServePass(passPlan, lod)
      ? await _planesTreeOnScreen(BrickLoader.getDimensions(0))
      : null;
    // A whole-stack MIP of a format-3 tree reads one layer MIP per 64 planes inside
    // the slab (and the planes of the partial layers at its ends): pixel for pixel the
    // maximum over every plane (any failure: every plane, then the bricks).
    const mipsSlab = planesTree ? _mipsSlabOf(passPlan.plan) : null;
    const mipsTree = mipsSlab && PlaneLoader.planSlabMax(mipsSlab.z0, mipsSlab.z1, planesTree.dimensions.z).layers.length
      ? await _mipsTreeOnScreen(BrickLoader.getDimensions(0))
      : null;

    const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
    const onPartial = typeof options.onPartial === 'function' ? options.onPartial : null;
    const now = () => performance.now?.() || Date.now();
    const brickByKey = new Map(bricks.map(b => [`${b.bx}_${b.by}_${b.bz}`, b]));
    const partials = new Map();
    const pendingWrites = new Set();
    let written = 0;
    // Chunks of the pass: bricks, or the non-empty plane tiles of a planes pass.
    let chunkTotal = bricks.length;
    // Plane-texture uploads the GPU refused, seen by a progressive refresh.
    let gpuLost = 0;
    let fraction = 0;
    let lastStatusAt = 0;
    let bytesTotal = 0;
    let bytesDone = 0;
    let startedAt = now();
    let lastBrickAt = 0;
    let rawOut = null;
    // A four-channel slab's footprint (no spare channel for it), computed once in the
    // plane worker for this frame: geometry alone, the same for every picture.
    let coverageMask = null;
    const needsMask = rawMode && geom.projected && !(Number(sourceMaterial.uniforms?.numChannels?.value) < 4);
    const maskReady = needsMask
      ? _studioCoverageMask(geom, renderRes, sliceWindow, warp).then(m => { coverageMask = m; })
      : Promise.resolve();

    const status = (force = false) => {
      const t = now();
      if (!force && t - lastStatusAt < 250) return;
      lastStatusAt = t;
      const pct = Math.round(fraction * 100);
      // An estimate once a few seconds and a few percent of the bytes are in.
      const elapsed = t - startedAt;
      let etaSeconds = null;
      if (elapsed > 2000 && bytesTotal > 0 && bytesDone > 0.03 * bytesTotal && bytesDone < bytesTotal) {
        etaSeconds = ((bytesTotal - bytesDone) * elapsed) / bytesDone / 1000;
      }
      _setSliceStatus(_tf('studio.nativeStatus', 'Native slice: {done}/{total} chunks, {pct}%', { done: written, total: chunkTotal, pct }));
      onProgress?.({ percent: pct, chunks: written, totalChunks: chunkTotal, bytesDone, bytesTotal, etaSeconds, lod, dims });
    };

    // → { canvas, raw }: raw alone in raw mode (the Studio colours it; the same buffer
    // refilled at every refresh), a canvas otherwise.
    const renderSlice = () => {
      if (rawMode) {
        const raw = VolumeSlicer.renderRawWithMaterial(backend.material, spec, renderRes, {
          window: sliceWindow, fallbackRaw: rawFallback, fallbackChannels: previewOnlyChannels, plane: backend.plane, out: rawOut
        });
        if (raw) {
          rawOut = raw;
          return { canvas: null, raw };
        }
        if (backend.plane) return null;
      }
      const rendered = VolumeSlicer.renderWithMaterial(
        backend.material, spec, renderRes, channelState, { fallback: colourFallback, window: sliceWindow }
      );
      // The slicer's canvas is overwritten by its next render: keep a copy.
      return rendered ? { canvas: _copyCanvas(rendered), raw: null } : null;
    };
    const sliceResult = (picture, extra) => ({
      canvas: picture.canvas,
      raw: _withCoverageMask(picture.raw, coverageMask),
      width: picture.canvas ? picture.canvas.width : picture.raw.width,
      height: picture.canvas ? picture.canvas.height : picture.raw.height,
      renderRes,
      cropRect,
      source: 'native-slicer',
      quality: 'native-partial',
      lod,
      planeSpec: spec,
      pixelSizeUm: _slicePixelSizeUm(spec, renderRes),
      calibrated: _studioCalibrated(),
      physicalSizeUm: VolumeViewer.getPhysicalSize?.(),
      channelState,
      timepoint: _currentTimepoint,
      nativeChunks: written,
      totalChunks: chunkTotal,
      ...extra
    });

    // The progressive picture is re-rendered at most every PARTIAL_MIN_MS, and never
    // more often than a few times the previous render's own cost.
    const PARTIAL_MIN_MS = 500;
    // A refresh is worth its render once a couple of percent of the chunks are new,
    // or after two seconds regardless (the first pack of a slow host).
    let PARTIAL_MIN_CHUNKS = Math.max(1, Math.ceil(bricks.length / 50));
    let partialTimer = null;
    let lastPartialAt = now();
    let lastPartialCost = 0;
    let writtenSinceRender = 0;
    const renderPartial = () => {
      if (!onPartial || controller.signal.aborted || !writtenSinceRender) return;
      if (needsMask && !coverageMask) return;
      const t0 = now();
      const lost = backend.flush();
      written -= lost;
      gpuLost += lost;
      const picture = renderSlice();
      if (!picture) return;
      lastPartialAt = now();
      writtenSinceRender = 0;
      onPartial(sliceResult(picture, { partial: true }));
      // The Studio's compose of the picture counts in the refresh's cost.
      lastPartialCost = now() - t0;
    };
    const partialTick = () => {
      partialTimer = null;
      if (controller.signal.aborted || !writtenSinceRender) return;
      if (writtenSinceRender >= PARTIAL_MIN_CHUNKS || now() - lastPartialAt >= 2000) renderPartial();
      else partialTimer = setTimeout(partialTick, 250);
    };
    const schedulePartial = () => {
      if (!onPartial || partialTimer || controller.signal.aborted) return;
      const interval = Math.max(PARTIAL_MIN_MS, lastPartialCost * 4);
      const wait = Math.max(0, interval - (now() - lastPartialAt));
      partialTimer = setTimeout(partialTick, wait);
    };
    const cancelPartial = () => {
      if (partialTimer) { clearTimeout(partialTimer); partialTimer = null; }
    };

    const commit = (brick, data, region) => {
      let res;
      try {
        res = backend.write(brick, data, region);
      } catch (err) {
        console.warn('[ViewerApp] Native Studio chunk could not be written:', err);
        return;
      }
      const done = (n) => {
        if (!(n > 0) || controller.signal.aborted) return;
        written += n;
        writtenSinceRender += n;
        schedulePartial();
      };
      if (res && typeof res.then === 'function') {
        const p = res.then(done, (err) => console.warn('[ViewerApp] Native Studio chunk could not be reduced:', err))
          .finally(() => pendingWrites.delete(p));
        pendingWrites.add(p);
      } else {
        done(Number(res) || 0);
      }
    };

    // A composed row: one brick, its channels interleaved, floor LUT applied (in a
    // decode worker). A brick some of whose channels failed is held until the retry
    // brings them — only those are downloaded again.
    const onBrickLoaded = (row) => {
      if (controller.signal.aborted || !row?.data) return;
      const key = `${row.bx}_${row.by}_${row.bz}`;
      const brick = brickByKey.get(key);
      if (!brick) return;
      const got = Array.isArray(row.channels) ? row.channels : [];
      for (const c of got) bytesDone += BrickLoader.taskBytes?.({ lod, channel: c, bx: row.bx, by: row.by, bz: row.bz, region: brick.region || null }) || 0;
      bytesDone = Math.min(bytesTotal || bytesDone, bytesDone);
      lastBrickAt = now();
      let data = row.data;
      const held = partials.get(key);
      if (held) {
        const voxels = Math.floor(held.data.length / 4);
        for (const c of got) {
          if (c < 0 || c > 3) continue;
          for (let i = 0, o = c; i < voxels; i++, o += 4) held.data[o] = data[o];
          held.missing.delete(c);
        }
        if (held.missing.size) return;
        partials.delete(key);
        data = held.data;
      } else if (Array.isArray(row.failedChannels) && row.failedChannels.length) {
        partials.set(key, { data, missing: new Set(row.failedChannels) });
        return;
      }
      // The backends work in the interior frame, a 66³-slot atlas in the stored one.
      commit(brick, data, borderFrame ? (row.region || null) : _nativeInteriorRegion(row.region || null, brickFrame));
      status(false);
    };
    // A v3 tree (SPEC §13.2): every task asks for the interior voxels it needs in the
    // stored 66³ frame — a one-voxel plane of each brick for an XZ / YZ cut, the
    // loader merging the bricks' byte runs of each pack into multi-range requests.
    const tasksFor = (pairs) => pairs.map(({ brick, channel }) => ({
      bx: brick.bx, by: brick.by, bz: brick.bz, lod, channel,
      region: _nativeLoaderRegion(brick, brick.region || null, dims, brickFrame, borderFrame)
    }));
    const loadOptions = (group) => ({
      group,
      signal: controller.signal,
      concurrency: Math.min(32, Math.max(4, Number(navigator.hardwareConcurrency) || 8)),
      // The runs of a pack this plane needs, not the whole pack (a cut across the
      // stack needs a few bricks of many packs).
      byteRanges: true,
      streamOnly: true,
      compose: { channels, luts: floorLuts, components: 4, cropToVolume: true },
      onBrickLoaded,
      onProgress: (f) => { fraction = f; status(false); }
    });
    const throwIfAborted = (summary) => {
      // A batch cancelled by anything but this pass (the dataset was switched) is
      // just as unusable as one the operator stopped.
      if (controller.signal.aborted || summary?.cancelled) {
        throw new DOMException('Native slice render cancelled', 'AbortError');
      }
    };

    /**
     * The planes pass: the plane texture filled from the planes/ tree — layer i of a
     * single plane from plane z = layerBase + i, layer 0 of a MIP slab from the
     * per-channel maximum over every voxel plane the slab samples (plan.voxels), the
     * floor LUTs applied to the stored values as the brick compose does. Each band of
     * tile rows is uploaded as it is decoded and its brick columns marked present, so
     * the shader reads exactly the texels the bricks path writes. → a slice result,
     * or throws (the caller then reads the bricks).
     */
    const planesPass = async (tree, mips = null) => {
      const plan = passPlan.plan;
      const bs = plan.bs;
      const plane = backend.plane;
      if (tree.tileSize % bs !== 0) throw new Error(`tile size ${tree.tileSize} is not a multiple of the brick size ${bs}`);
      const chans = wantedChannels || Array.from({ length: channels }, (_, c) => c);
      const rect = { x0: 0, y0: 0, x1: dims.x, y1: dims.y };
      const compose = { components: 4, slots: chans, luts: chans.map(c => floorLuts[c] || null) };
      const signal = controller.signal;
      const onBytes = (n) => {
        bytesDone += n;
        if (bytesDone > bytesTotal) bytesTotal = bytesDone;
        lastBrickAt = now();
        fraction = bytesTotal > 0 ? bytesDone / bytesTotal : 0;
        status(false);
      };
      const onTiles = (n) => {
        if (!(n > 0) || signal.aborted) return;
        written += n;
        // A MIP slab's texture is filled once every plane is in: nothing to refresh before.
        if (!plan.reduced) {
          writtenSinceRender += n;
          schedulePartial();
        }
        status(false);
      };
      const cu = Math.ceil(plane.width / bs);
      const upload = (layer) => (band) => {
        if (signal.aborted) return;
        if (!plane.upload(0, band.y0, band.width, band.height, layer, band.rgba)) throw new Error('the GPU refused a band of the plane texture');
        const bv1 = Math.floor((band.y0 + band.height - 1) / bs);
        for (let bv = Math.floor(band.y0 / bs); bv <= bv1; bv++) {
          for (let bu = 0; bu < cu; bu++) plane.setPresent(bu, bv, layer, true);
        }
      };

      const est = mips
        ? await _mipsSlabEstimate(tree, mips, mipsSlab, chans, rect, { signal, onBytes })
        : await tree.estimate(plan.voxels, chans, rect, { signal, onBytes, sample: plan.reduced ? 16 : 0 });
      if (!est) throw new Error('no whole brick layer in the slab');
      throwIfAborted(null);
      chunkTotal = Math.max(1, est.tiles);
      PARTIAL_MIN_CHUNKS = Math.max(1, Math.ceil(chunkTotal / 50));
      bytesTotal = Math.max(bytesDone, est.bytes);
      startedAt = now();
      onProgress?.({ percent: 0, chunks: 0, totalChunks: chunkTotal, bytesDone, bytesTotal, etaSeconds: null, lod, dims });
      if (mips) {
        await PlaneLoader.loadSlabMax(tree, mips, mipsSlab.z0, mipsSlab.z1, chans, rect, {
          signal, compose, bands: true, onBand: upload(0), onBytes, onTiles, concurrency: 3
        });
      } else if (plan.reduced) {
        await tree.loadRegionMax(plan.voxels, chans, rect, { signal, compose, bands: true, onBand: upload(0), onBytes, onTiles, concurrency: 3 });
      } else {
        for (const z of plan.voxels) {
          await tree.loadRegion(z, chans, rect, { signal, compose, bands: true, onBand: upload(z - plan.layerBase), onBytes, onTiles });
          throwIfAborted(null);
        }
      }
      await maskReady;
      throwIfAborted(null);
      cancelPartial();
      gpuLost += backend.flush();
      if (gpuLost) throw new Error(`the GPU refused ${gpuLost} band(s) of the plane texture`);
      written = chunkTotal;
      bytesTotal = bytesDone;
      fraction = 1;
      status(true);
      const picture = renderSlice();
      if (backend.flush()) throw new Error('the GPU refused part of the plane texture');
      if (!picture) return null;
      _setSliceStatus(_tf('studio.nativeReady', 'Native slice ready ({n} chunks).', { n: chunkTotal }));
      return sliceResult(picture, {
        quality: 'native',
        missingChunks: 0,
        path: mips ? 'mips' : 'planes',
        bytesTotal,
        elapsedMs: now() - startedAt,
        netMs: lastBrickAt ? Math.max(1, lastBrickAt - startedAt) : 0
      });
    };

    // A failed source, from scratch, on a fresh plane texture.
    const restartOnFreshPlane = () => {
      cancelPartial();
      const used = backend;
      backend = null;
      used.dispose();
      backend = _planeNativeBackend(passPlan.plan, dims, channels);
      borderFrame = false;
      written = 0;
      writtenSinceRender = 0;
      gpuLost = 0;
      fraction = 0;
      bytesDone = 0;
      lastBrickAt = 0;
      chunkTotal = bricks.length;
      PARTIAL_MIN_CHUNKS = Math.max(1, Math.ceil(bricks.length / 50));
    };

    try {
      if (planesTree) {
        // mips/ + planes/, then planes/ alone, then the bricks.
        for (const mips of mipsTree ? [mipsTree, null] : [null]) {
          try {
            const result = await planesPass(planesTree, mips);
            if (result) return result;
          } catch (err) {
            if (controller.signal.aborted || err?.name === 'AbortError') throw new DOMException('Native slice render cancelled', 'AbortError');
            console.warn(mips
              ? '[ViewerApp] Native Studio pass: mips/ failed; reading every plane instead.'
              : '[ViewerApp] Native Studio pass: planes/ failed; reading the bricks instead.', err?.message || err);
          }
          restartOnFreshPlane();
        }
      }
      _setSliceStatus(_tf('studio.nativePreparing', 'Preparing the native slice ({n} chunks)…', { n: bricks.length }));
      const pairs = [];
      for (const brick of bricks) {
        if (rgbaTransport) pairs.push({ brick, channel: -1 });
        else for (const c of wantedChannels) pairs.push({ brick, channel: c });
      }
      const tasks = tasksFor(pairs);
      bytesTotal = BrickLoader.estimateTaskBytes?.(tasks) || 0;
      startedAt = now();
      onProgress?.({ percent: 0, chunks: 0, totalChunks: bricks.length, bytesDone: 0, bytesTotal, etaSeconds: null, lod, dims });
      const group = `studio-native-${++_nativePassSeq}`;
      const first = await BrickLoader.loadBrickTasks(tasks, loadOptions(group));
      throwIfAborted(first?.summary);

      // A fetch or decode that failed for good (the loader already retried each one)
      // left holes: one calm pass for exactly those (brick, channel) pairs once the
      // rush is over, before deciding they are missing.
      const failedPairs = (first?.summary?.failed || [])
        .map(f => ({ brick: brickByKey.get(`${f.bx}_${f.by}_${f.bz}`), channel: f.channel }))
        .filter(p => p.brick);
      if (failedPairs.length) {
        const retry = await BrickLoader.loadBrickTasks(tasksFor(failedPairs), loadOptions(`${group}-retry`));
        throwIfAborted(retry?.summary);
      }
      await Promise.all([...pendingWrites]);
      await maskReady;
      throwIfAborted(null);
      cancelPartial();
      written -= backend.flush();
      if (!written) return null;

      fraction = 1;
      status(true);
      const picture = renderSlice();
      written -= backend.flush();
      if (!picture) return null;
      // A brick that never made it keeps the preview's pixels in the final picture (a
      // softer patch beats a hole) and is reported.
      const missing = Math.max(0, bricks.length - written);
      _setSliceStatus(missing > 0
        ? _tf('studio.nativeReadyMissing', 'Native slice ready ({n} chunks; {missing} kept at the previous resolution).', { n: written, missing })
        : _tf('studio.nativeReady', 'Native slice ready ({n} chunks).', { n: written }));
      // netMs: the transfer alone (first request to last brick), the measure of the link.
      return sliceResult(picture, {
        quality: missing > 0 ? 'native-partial' : (lod === 0 ? 'native' : `lod${lod}`),
        missingChunks: missing,
        path: passPlan.path,
        bytesTotal,
        elapsedMs: now() - startedAt,
        netMs: lastBrickAt ? Math.max(1, lastBrickAt - startedAt) : 0
      });
    } finally {
      cancelPartial();
      partials.clear();
      backend?.dispose();
      // The shared slicer programs and tile pass are this pass's to release only while
      // no other pass has taken over.
      if (_nativeSliceAbort === controller || !_nativeSliceAbort) VolumeSlicer.releaseForeign?.();
      if (!options.controller && _nativeSliceAbort === controller) _nativeSliceAbort = null;
    }
  }

  function _setSliceStatus(text) {
    const node = document.getElementById('slice-render-status');
    if (node) node.textContent = text;
  }

  function _currentChannelState() {
    return ChannelPanel.getState?.() || _channelState;
  }

  function _getSliceExports() {
    const hasMeasurements = MeasurementStore.list(datasetId, 'viewer').length > 0;
    return [
      { action: 'measure-csv', icon: 'ruler', label: _t('viewer.exportMeasuresCsv', 'Measurements CSV'), enabled: hasMeasurements, handler: () => _exportMeasurements('csv') },
      { action: 'measure-json', icon: 'braces', label: _t('viewer.exportMeasuresJson', 'Measurements JSON'), enabled: hasMeasurements, handler: () => _exportMeasurements('json') }
    ];
  }

  /** The viewer's own exports followed by whatever the plugins offer through their
   *  `getExports()` hook (cell-distance measurements, neighbour tables, …). */
  function _getAllCustomExports() {
    const own = _getSliceExports();
    if (typeof PluginRegistry === 'undefined' || !PluginRegistry.collect) return own;
    const extra = PluginRegistry.collect('getExports')
      .flatMap(list => (Array.isArray(list) ? list : []))
      .filter(item => item && typeof item === 'object' && item.action && typeof item.handler === 'function');
    return own.concat(extra);
  }

  /** A plugin's on-screen chart (Plotly node) for the Download Center's graph
   *  exports; null when no plugin shows one. */
  function _getPluginGraph() {
    if (typeof PluginRegistry === 'undefined' || !PluginRegistry.collect) return null;
    return PluginRegistry.collect('getGraph')[0] || null;
  }

  function _downloadText(text, filename, mime) {
    const blob = new Blob([String(text ?? '')], { type: mime || 'text/plain' });
    if (typeof ExportManager !== 'undefined' && ExportManager.downloadBlob) {
      ExportManager.downloadBlob(blob, filename);
      return;
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 500);
  }

  // ── Plugin-mounted UI ──────────────────────────────────────────────────────────
  // A marketplace plugin cannot rely on markup in viewer.html (it is not shipped
  // with the page), so it asks for its surface here: a section in the sidebar, or
  // a floating panel over the canvas. Both return a handle that owns the node.

  function _addPluginSidebarSection(def = {}) {
    const sidebar = document.getElementById('viewer-sidebar');
    if (!sidebar || !def.id) return null;
    const safeId = String(def.id).replace(/[^A-Za-z0-9_-]/g, '');
    document.getElementById(`plugin-section-${safeId}`)?.remove();
    const root = document.createElement('div');
    root.className = 'panel-section plugin-section';
    root.id = `plugin-section-${safeId}`;
    const title = document.createElement('div');
    title.className = 'panel-title';
    const label = document.createElement('span');
    label.textContent = def.title || '';
    title.appendChild(label);
    const body = document.createElement('div');
    body.className = 'plugin-section-body';
    body.innerHTML = def.html || '';
    root.appendChild(title);
    root.appendChild(body);
    if (def.hidden) root.hidden = true;
    sidebar.appendChild(root);
    if (window.lucide) lucide.createIcons({ nodes: [root] });
    const handle = {
      root, body,
      setTitle(text) { label.textContent = text; },
      setHtml(html) { body.innerHTML = html; if (window.lucide) lucide.createIcons({ nodes: [body] }); },
      show() { root.hidden = false; },
      hide() { root.hidden = true; },
      remove() { root.remove(); }
    };
    if (typeof def.bind === 'function') def.bind(body, handle);
    return handle;
  }

  function _addPluginCanvasPanel(def = {}) {
    const container = document.querySelector('.viewer-canvas-container');
    if (!container || !def.id) return null;
    const safeId = String(def.id).replace(/[^A-Za-z0-9_-]/g, '');
    document.getElementById(`plugin-panel-${safeId}`)?.remove();
    const root = document.createElement('div');
    root.className = `scientific-panel ${def.className || ''}`.trim();
    root.id = `plugin-panel-${safeId}`;
    if (def.style) root.style.cssText = def.style;
    root.innerHTML = def.html || '';
    container.appendChild(root);
    if (window.lucide) lucide.createIcons({ nodes: [root] });
    const handle = {
      root,
      setHtml(html) { root.innerHTML = html; if (window.lucide) lucide.createIcons({ nodes: [root] }); },
      show() { root.classList.add('visible'); },
      hide() { root.classList.remove('visible'); },
      toggle(force) { return root.classList.toggle('visible', force); },
      isVisible() { return root.classList.contains('visible'); },
      remove() { root.remove(); }
    };
    if (typeof def.bind === 'function') def.bind(root, handle);
    return handle;
  }

  function _safeExportName() {
    return String(datasetMeta?.name || datasetMeta?.id || 'viewer').replace(/[^a-z0-9._-]+/gi, '_').replace(/^_+|_+$/g, '');
  }

  function _exportMeasurements(format) {
    const items = MeasurementStore.list(datasetId, 'viewer');
    if (!items.length) {
      ExportManager.toast?.(_t('viewer.exportMeasuresNone', 'No measurement is available to export'));
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

    // 3. Measurements.
    MeasurementStore.clear(datasetId, 'viewer');
    _volumeMeasurements = [];
    _volumeMeasureDraft = [];
    VolumeViewer.setMeasurements([]);
    _renderVolumeMeasurement();

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
      _refreshTrackingVisuals();
      _saveZDisplayScale();
      _updateZScaleLabel();
      _updatePhysicalStatus();
    }

    // The quality is applied with the load that follows (end of this function): the
    // select, the viewer's target and the buffering all move with it.
    const restoredQuality = viewerState.qualityMode ? _normalizeQualityParam(viewerState.qualityMode) : null;
    const qualityChanged = Boolean(restoredQuality && restoredQuality !== _qualityMode);
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

    // 'slice' is the ToolManager name of the cut tool (the chip is data-tool="slice";
    // 'cut' is only what VolumeViewer calls it): a saved open plane reopens the tool,
    // and with it the stage. Silent in a panel — the host owns the shared tool.
    const reopenSliceTool = () => {
      if (typeof ToolManager === 'undefined') return;
      _suppressToolSync = true;
      try { ToolManager.activate('slice'); } finally { _suppressToolSync = false; }
    };
    if (viewerState.cutPlane) {
      VolumeViewer.setCutPlane(viewerState.cutPlane.axis, viewerState.cutPlane.value, { visible: Boolean(viewerState.cutPlane.visible) });
      if (viewerState.cutPlane.visible) reopenSliceTool();
    }

    if (viewerState.planeSpec) {
      VolumeViewer.setPlaneSpec(viewerState.planeSpec, { visible: Boolean(viewerState.planeSpec.visible) });
      if (viewerState.planeSpec.visible) reopenSliceTool();
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

    const restoredFrame = isLive && Number.isFinite(viewerState.timepoint) ? viewerState.timepoint : null;
    if (restoredFrame !== null && restoredFrame !== _currentTimepoint) {
      // Another frame: its load (Timeline → _requestTimepoint) runs at the restored quality.
      if (qualityChanged) _applyQualityMode(restoredQuality);
      Timeline.setFrame(restoredFrame);
    } else if (_basePath && qualityChanged) {
      // The same frame (or no time axis): reloaded at the restored quality — on a
      // timelapse the Timeline would see an unchanged frame and load nothing.
      if (restoredFrame !== null) Timeline.setFrame(restoredFrame, true, false);
      _setQualityMode(restoredQuality).catch(_showLoadingError);
    } else if (restoredFrame !== null) {
      Timeline.setFrame(restoredFrame, true, false);
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
      _refreshTrackingVisuals();
    });
  }

  function _handleVolumeMeasurePoint(point) {
    const calibration = VolumeViewer.getPhysicalCalibration?.();
    if (calibration?.calibrationStatus === 'metadata-missing') {
      _setVolumeMeasureStatus(Utils.escapeHtml(_t('viewer.measureNoCalibration', 'Physical calibration is missing for this dataset. Distance measurement needs calibrated voxel metadata.')));
      return;
    }
    if (!point?.physicalUm) {
      _setVolumeMeasureStatus(Utils.escapeHtml(_t('viewer.measureNoPoint', 'No calibrated volume point was detected.')));
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
              <span style="background:${_safeMeasureColor(item.color)}; width:16px; height:16px; display:inline-block; border-radius:3px; border:1px solid rgba(255,255,255,0.2); vertical-align:middle;"></span>
            </button>
            <input type="text" value="${Utils.escapeHtml(item.label || '')}" placeholder="${Utils.escapeHtml(_t('plugins.measure-distance.labelPlaceholder', 'Label'))}" class="form-input text-xs" style="flex: 1; min-width: 0; width: 50px; padding: 2px 4px; background: rgba(0,0,0,0.2); border: 1px solid var(--border-light); color: var(--text-primary); border-radius: 4px;" data-volume-measure-action="rename" data-measurement-id="${Utils.escapeHtml(item.id)}">
            <span style="white-space: nowrap; font-size: 11px; color: var(--text-muted);">
              ${item.visible === false ? Utils.escapeHtml(_t('viewer.measureHidden', 'Hidden')) : `${_fmtUm(item.distance)} µm`}
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
        : Utils.escapeHtml(_t('viewer.measureNone', 'No saved measurement yet.'));
      if (window.lucide) lucide.createIcons({ nodes: [list] });
    }

    if (!_volumeMeasureDraft.length) {
      _setVolumeMeasureStatus(Utils.escapeHtml(_t('viewer.measureHint', 'Click two points on the specimen surface.')));
      return;
    }
    if (_volumeMeasureDraft.length === 1) {
      const p = _volumeMeasureDraft[0].physicalUm;
      _setVolumeMeasureStatus(`
        <div class="metric-tile"><small>${Utils.escapeHtml(_t('viewer.measurePointA', 'Point A'))}</small><strong>${_fmtUm(p.x)}, ${_fmtUm(p.y)}, ${_fmtUm(p.z)} µm</strong></div>
        <div class="text-xs text-muted">${Utils.escapeHtml(_t('viewer.measureSecond', 'Click a second point to measure distance.'))}</div>
      `);
      return;
    }
    const [a, b] = _volumeMeasureDraft.map(p => p.physicalUm);
    const distance = _distance3d(a, b);
    _setVolumeMeasureStatus(`
      <div class="metric-grid">
        <div class="metric-tile"><small>${Utils.escapeHtml(_t('viewer.measureDistance', 'Distance'))}</small><strong>${_fmtUm(distance)} µm</strong></div>
        <div class="metric-tile"><small>${Utils.escapeHtml(_t('viewer.measureDeltaZ', 'Delta Z'))}</small><strong>${_fmtUm(Math.abs(a.z - b.z))} µm</strong></div>
      </div>
      <div class="text-xs text-muted">${Utils.escapeHtml(_t('viewer.measureNote', 'Measured between two picked surface points in calibrated physical coordinates.'))}</div>
    `);
  }

  /** A stored colour as CSS: #rgb … #rrggbbaa only (it may come from a shared #state= link). */
  function _safeMeasureColor(color) {
    return /^#[0-9a-f]{3,8}$/i.test(String(color || '')) ? String(color) : '#ff4d4f';
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
      label: _tf('viewer.measureLabel', 'Measure {n}', { n: _volumeMeasurements.length + 1 }),
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
  // puts images and tracks in the same frame. It is applied only when the transform
  // was verified rigid at import time (qcSummary.rigid) — a non-rigid one would
  // deform the images and is refused rather than approximated. ViewerApp.
  // setVolumeStabilized(false) shows the raw acquisition frame instead.
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
  // A kick that found a run still unwinding (a quality switch stops it, but its
  // in-flight frame finishes first): honoured by that run on its way out.
  let _pfRekick = false;

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
    if (_pfRunning) {
      _pfRekick = true;
      return;
    }
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
      if (_pfRekick) {
        _pfRekick = false;
        _kickPrefetch(200);
      }
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
      el.textContent = _tt('js.bufferPartial', 'Buffer {n}/{total} · {q} — the whole series does not fit in memory ({cap} frames max)')
        .replace('{n}', resident).replace('{total}', total).replace('{q}', label).replace('{cap}', capacity);
    } else {
      el.textContent = _tt('js.bufferFull', 'Buffer {n}/{total} · {q}')
        .replace('{n}', resident).replace('{total}', total).replace('{q}', label);
    }
  }

  let _trackingHandle = null;
  let _toolListeners = [];

  // Shared with the tracking plugins through ctx.tracking: ONE selection (the
  // overlay highlights it, the inspector describes it, the trails brighten it),
  // ONE set of analysis options (the neighbour radius feeds the inspector, the
  // charts and the surface density alike), and one "loaded" promise.
  let _trackingSelected = -1;
  let _trackingOptions = { neighborThresholdUm: 55 };
  let _trackingReadyResolve = null;
  const _trackingReady = new Promise(resolve => { _trackingReadyResolve = resolve; });

  function _trackingEmit(name, detail) {
    window.dispatchEvent(new CustomEvent(`tracking-${name}`, { detail: detail || {} }));
  }

  /** Re-place the tracked points after a change that moves them without a frame
   *  change (clip sliders, Z display scale, Z-stack slab) and tell the plugins. */
  function _refreshTrackingVisuals() {
    if (typeof TrackingOverlay === 'undefined' || !TrackingOverlay.isLoaded()) return;
    TrackingOverlay.refresh();
    _trackingEmit('refresh', { frame: TrackingOverlay.getFrame(), stabilized: TrackingOverlay.isStabilizedFrame() });
  }

  function _trackingFacade() {
    const ov = () => (typeof TrackingOverlay !== 'undefined' ? TrackingOverlay : null);
    return {
      isAvailable: () => Boolean(datasetMeta?.tracking?.tracksPath),
      getMeta: () => datasetMeta?.tracking || null,
      isLoaded: () => Boolean(ov()?.isLoaded()),
      /** Resolves with the packed tables once tracks.json is in, null when the
       *  dataset has no tracking or it failed to load. */
      whenLoaded: () => _trackingReady,
      getData: () => ov()?.getData() || null,
      getFrame: () => (ov()?.getFrame() ?? (_currentTimepoint || 0)),
      isStabilized: () => Boolean(ov()?.isStabilizedFrame()),
      positionUm: (c, f, opts, out) => ov()?.positionUm(c, f, opts, out) ?? null,
      positionObject: (c, f, out, opts) => ov()?.positionObject(c, f, out, opts) ?? null,
      cellsAt: (f) => ov()?.cellsAt(f) || [],
      umToObject: (v, out) => VolumeViewer.umToObject?.(v, out) || null,
      getAcquisitionSpace: () => VolumeViewer.getAcquisitionSpace?.() || null,
      isInsideClip: (o) => (VolumeViewer.isInsideClip ? VolumeViewer.isInsideClip(o) : true),
      getVolumeObject: () => VolumeViewer.getVolumeObject?.() || null,
      getCamera: () => VolumeViewer.getCamera?.() || null,
      getRenderer: () => VolumeViewer.getRenderer?.() || null,
      triggerRender: () => VolumeViewer.triggerRender?.(),
      pick: (clientX, clientY) => {
        const o = ov();
        if (!o) return -1;
        return o.pick(clientX, clientY, VolumeViewer.getCamera?.(), VolumeViewer.getRenderer?.()?.domElement);
      },
      getSelected: () => _trackingSelected,
      select: (c) => {
        const next = (Number.isInteger(c) && c >= 0) ? c : -1;
        if (next === _trackingSelected) return _trackingSelected;
        _trackingSelected = ov()?.setSelected(next) ?? next;
        _trackingEmit('selection', { cell: _trackingSelected });
        return _trackingSelected;
      },
      getOptions: () => ({ ..._trackingOptions }),
      setOptions: (patch = {}) => {
        const next = { ..._trackingOptions };
        if (Number.isFinite(patch.neighborThresholdUm)) {
          next.neighborThresholdUm = Math.max(5, Math.min(500, Number(patch.neighborThresholdUm)));
        }
        _trackingOptions = next;
        _trackingEmit('options', { ..._trackingOptions });
        return { ..._trackingOptions };
      },
      getStyle: () => ov()?.getStyle() || null,
      setStyle: (patch) => { ov()?.setStyle(patch); _trackingEmit('style', ov()?.getStyle() || {}); },
      /** Subscribe to 'loaded' | 'frame' | 'refresh' | 'selection' | 'options' |
       *  'style'; returns the unsubscribe function. */
      on: (name, cb) => {
        if (typeof cb !== 'function') return () => {};
        const type = `tracking-${name}`;
        const fn = (ev) => cb(ev.detail || {});
        window.addEventListener(type, fn);
        return () => window.removeEventListener(type, fn);
      }
    };
  }

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
    if (!meta?.tracksPath || typeof TrackingOverlay === 'undefined') { _trackingReadyResolve(null); return; }

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
      _trackingReadyResolve(null);
      return;
    }

    const ready = TrackingOverlay.init({
      volumeObject: VolumeViewer.getVolumeObject?.(),
      umToObject: VolumeViewer.umToObject,
      isInsideClip: VolumeViewer.isInsideClip,
      acqSize: space.size,
      onDirty: VolumeViewer.triggerRender
    });
    if (!ready) { _trackingReadyResolve(null); return; }

    const style = TrackingOverlay.getStyle();
    _trackingHandle = ChannelPanel.registerLayer({
      id: 'tracking',
      title: _tt('js.trackingLayer', 'Tracking points'),
      swatch: meta.regions?.[0]?.color || '#2ecc71',
      summary: _tt('js.trackingLoading', 'Loading tracking…'),
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
            <label for="tracking-size">${_tt('js.trackingSize', 'Size (µm)')}</label>
            <input type="range" id="tracking-size" min="2" max="40" step="1" value="${style.diameterUm}">
            <output id="tracking-size-out">${style.diameterUm}</output>
          </div>
          <div class="layer-row">
            <label for="tracking-opacity">${_tt('js.trackingOpacity', 'Opacity')}</label>
            <input type="range" id="tracking-opacity" min="10" max="100" step="5" value="${Math.round(style.opacity * 100)}">
            <output id="tracking-opacity-out">${Math.round(style.opacity * 100)}%</output>
          </div>
          <div class="layer-row layer-row-toggles">
            <label class="layer-toggle"><input type="checkbox" id="tracking-show-mitosis" ${style.showMitosis ? 'checked' : ''}> ${_tt('js.trackingMitoses', 'Mitoses')}</label>
            <label class="layer-toggle"><input type="checkbox" id="tracking-show-fusion" ${style.showFusion ? 'checked' : ''}> ${_tt('js.trackingFusions', 'Fusions')}</label>
          </div>
          <div class="layer-legend">${legend}</div>`;
      },
      bind: (root) => {
        const size = root.querySelector('#tracking-size');
        const sizeOut = root.querySelector('#tracking-size-out');
        const op = root.querySelector('#tracking-opacity');
        const opOut = root.querySelector('#tracking-opacity-out');
        const mitosis = root.querySelector('#tracking-show-mitosis');
        const fusion = root.querySelector('#tracking-show-fusion');
        size?.addEventListener('input', () => {
          const v = Number(size.value);
          if (sizeOut) sizeOut.textContent = String(v);
          TrackingOverlay.setStyle({ diameterUm: v });
          _trackingEmit('style', TrackingOverlay.getStyle());
        });
        op?.addEventListener('input', () => {
          const v = Number(op.value);
          if (opOut) opOut.textContent = `${v}%`;
          TrackingOverlay.setStyle({ opacity: v / 100 });
          _trackingEmit('style', TrackingOverlay.getStyle());
        });
        // The event flags hide a whole class of cells: the plugins drawing trails
        // or arrows for them follow the same switch through the style event.
        mitosis?.addEventListener('change', () => {
          TrackingOverlay.setStyle({ showMitosis: mitosis.checked });
          _trackingEmit('style', TrackingOverlay.getStyle());
        });
        fusion?.addEventListener('change', () => {
          TrackingOverlay.setStyle({ showFusion: fusion.checked });
          _trackingEmit('style', TrackingOverlay.getStyle());
        });
      },
      onVisibility: (v) => { TrackingOverlay.setStyle({ visible: v }); _trackingEmit('style', TrackingOverlay.getStyle()); }
    });

    const onTimepoint = (ev) => {
      const d = ev.detail || {};
      // Read the stabilisation flag off the EVENT, never by asking the viewer
      // again: the two can disagree for one frame while a load settles.
      if (!TrackingOverlay.hasRawCoordinates() && !d.stabilized) {
        // The page hides it (the operator's own visibility setting is left alone).
        if (TrackingOverlay.setAutoHidden) TrackingOverlay.setAutoHidden(true);
        else TrackingOverlay.setStyle({ visible: false });
        _trackingHandle?.setSummary(_tt('js.trackingNoRaw',
          'Raw coordinates missing: tracking hidden on an unstabilised volume'));
        return;
      }
      TrackingOverlay.setAutoHidden?.(false);
      TrackingOverlay.setFrame(d.frame, { stabilized: d.stabilized });
      _trackingHandle?.setSummary(
        `${TrackingOverlay.getCount()} / ${Number(meta.cellCount) || 0} ${_tt('js.trackingCells', 'cells')}`);
      // Emitted AFTER the overlay moved: a plugin drawing on top of the points
      // must never lead them by a frame.
      if (TrackingOverlay.isLoaded()) _trackingEmit('frame', { frame: d.frame, stabilized: Boolean(d.stabilized) });
    };
    window.addEventListener('viewer-timepoint-ready', onTimepoint);
    window.addEventListener('pagehide', () => {
      window.removeEventListener('viewer-timepoint-ready', onTimepoint);
      TrackingOverlay.dispose();
    });

    TrackingOverlay.load(_basePath, meta, (p) => {
      if (p.phase === 'download') {
        _trackingHandle?.setSummary(`${_tt('js.trackingLoading', 'Loading tracking…')} ${Math.round(p.pct * 100)}%`);
      } else if (p.phase === 'parse' || p.phase === 'bake') {
        _trackingHandle?.setSummary(_tt('js.trackingPreparing', 'Preparing tracks…'));
      }
    }).then((data) => {
      const stabilized = Boolean(VolumeViewer.isStabilized?.());
      TrackingOverlay.setFrame(_currentTimepoint || 0, { stabilized });
      if (_trackingSelected >= 0) TrackingOverlay.setSelected(_trackingSelected);
      _trackingHandle?.refreshBody();
      _trackingHandle?.setSummary(
        `${TrackingOverlay.getCount()} / ${Number(meta.cellCount) || 0} ${_tt('js.trackingCells', 'cells')}`);
      _trackingReadyResolve(data);
      _trackingEmit('loaded', { cellTotal: data.cellTotal, frameCount: data.frameCount });
      _trackingEmit('frame', { frame: _currentTimepoint || 0, stabilized });
    }).catch(err => {
      console.warn('[ViewerApp] tracking overlay failed:', err);
      _trackingHandle?.setSummary(_tt('js.trackingUnavailable', 'Tracking unavailable'));
      _trackingReadyResolve(null);
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
  function _requestTimepoint(basePath, frame, origin = 'user', remount = false) {
    if (!Number.isFinite(frame)) return;
    if (_tpInFlight) {
      _tpPending = (frame === _currentTimepoint && !remount) ? null : { frame, origin, remount };
      return;
    }
    if (frame === _currentTimepoint && !remount) return;
    _tpInFlight = true;
    let remountFrame = null;
    _loadTimepoint(basePath, frame, { origin })
      .catch((err) => {
        _showLoadingError(err);
        // The frame of _currentTimepoint is the last one shown: the scrubber goes back
        // to it, and asking for the failed frame again is a new request, not a no-op.
        if (isLive && typeof Timeline !== 'undefined' && Number.isFinite(_currentTimepoint)) {
          Timeline.setFrame(_currentTimepoint, true, false);
          // A frame streamed in place of the one on screen takes that one down first
          // (VolumeViewer frees it for the budget check): put it back (from the cache).
          if (!remount && _currentTimepoint !== frame && !_hasMountedVolume()) remountFrame = _currentTimepoint;
        }
      })
      .finally(() => {
        _tpInFlight = false;
        const next = _tpPending;
        _tpPending = null;
        if (next !== null) _requestTimepoint(basePath, next.frame, next.origin, next.remount);
        else if (remountFrame !== null) _requestTimepoint(basePath, remountFrame, 'sync', true);
      });
  }

  /** Wrapper so EVERY caller holds the playhead — the quality select, the workspace
   *  restore and the initial load all reach _loadTimepoint without going through
   *  _requestTimepoint's serialisation. */
  function _loadTimepoint(basePath, t, opts = {}) {
    _holdPlayback();
    return _loadTimepointInner(basePath, t, opts).finally(_releasePlayback);
  }

  /**
   * Loads timepoint `t` (null for a volume without a time axis) at the page's quality.
   * → { ok: true, quality } once it is on screen, undefined when a later load took
   * over (nothing of this one is applied). `_currentTimepoint` moves to `t` only then:
   * a frame that fails or is superseded leaves the frame on screen the current one.
   * opts: force (reload at a new quality), quality, origin ('sync': asked by a sibling
   * panel's SYNC_TIME — its arrival is not news for the siblings).
   */
  async function _loadTimepointInner(basePath, t, opts = {}) {
    _tpLoadStart = performance.now?.() || Date.now();
    const perfId = _perf()?.start('viewer.timepoint.load', {
      timepoint: t,
      qualityMode: _qualityMode,
      forced: Boolean(opts.force)
    });
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
    const hasActiveVolume = _hasMountedVolume();
    const isQualitySwitch = Boolean(hasActiveVolume && (opts.force || loadedTimepoints.has(t)));
    const useBlockingLoader = !isQualitySwitch && (opts.force || !loadedTimepoints.has(t) || !_loadedQualities.has(qualityKey));

    if (useBlockingLoader) {
      _showLoaderProgress();
      if (loaderText) {
        loaderText.removeAttribute('data-i18n');
        loaderText.textContent = isLive
          ? _tf('viewer.loadingTimepoint', 'Loading timepoint {n} ({quality})…', { n: (Number(t) || 0) + 1, quality: _qualityLabel(primaryQuality) })
          : _tf('viewer.loadingVolume', 'Loading volume data ({quality})…', { quality: _qualityLabel(primaryQuality) });
      }
      if (progressFill) progressFill.style.width = '0%';
    } else if (loader) {
      loader.style.display = 'none';
      VolumeViewer.setQualityTarget?.(primaryQuality, _qualityMode);
    }
    const onLoadProgress = (progress) => {
      if (loadToken === _activeLoadToken && useBlockingLoader && progressFill) {
        progressFill.style.width = `${progress * 100}%`;
      }
    };

    _setQualityStatus(_tf('viewer.loadingQuality', 'Loading {quality}…', { quality: _qualityLabel(primaryQuality) }));
    // A first open shows the coarsest level as soon as it is complete and streams the
    // asked one behind it: the loader card goes as soon as there is a picture.
    const firstPicture = useBlockingLoader ? {
      coarseFirst: true,
      onFirstPicture: () => {
        if (loadToken === _activeLoadToken && loader) loader.style.display = 'none';
      }
    } : {};
    let result;
    try {
      result = await _loadVolumeForQuality(basePath, datasetMeta, t, primaryQuality, onLoadProgress,
        { deferActivation: isQualitySwitch, hideTransition: !opts.force, ...firstPicture });
      if (_isStale()) { _bailStale(); return; }
      if ((!result || result.available === false) && !result?.stale && primaryQuality === '512x512') {
        console.warn('[ViewerApp] 512x512 unavailable, falling back to 256x256:', result?.reason || 'unknown');
        const requested = primaryQuality;
        primaryQuality = '256x256';
        _qualityMode = '256x256';
        const select = document.getElementById('select-quality');
        if (select) select.value = '256x256';
        VolumeViewer.setQualityTarget?.(primaryQuality, _qualityMode);
        _showResolutionDowngradeNotice(_qualityLabel(requested), _qualityLabel(primaryQuality));
        result = await _loadVolumeForQuality(basePath, datasetMeta, t, primaryQuality, onLoadProgress,
          { deferActivation: isQualitySwitch, hideTransition: !opts.force });
        if (_isStale()) { _bailStale(); return; }
      }
      if (!_isStale() && result && result.manifest) {
        _brickManifest = result.manifest;
        _updateQualityOptionLabels();
      }
    } catch (err) {
      // A load that lost the race says nothing about the quality it asked for.
      if (_isStale()) { _bailStale(); return; }
      if (primaryQuality === '512x512' && err?.name !== 'AbortError') {
        console.warn('[ViewerApp] 512x512 failed, falling back to 256x256:', err);
        const requested = primaryQuality;
        primaryQuality = '256x256';
        _qualityMode = '256x256';
        const select = document.getElementById('select-quality');
        if (select) select.value = '256x256';
        VolumeViewer.setQualityTarget?.(primaryQuality, _qualityMode);
        _showResolutionDowngradeNotice(_qualityLabel(requested), _qualityLabel(primaryQuality));
        result = await _loadVolumeForQuality(basePath, datasetMeta, t, primaryQuality, onLoadProgress,
          { deferActivation: isQualitySwitch, hideTransition: !opts.force });
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

    if (result?.stale || loadToken !== _activeLoadToken) {
      _perf()?.end(perfId, {
        status: 'stale',
        timepoint: t,
        quality: primaryQuality
      });
      return;
    }

    if (!result || result.available === false) {
      throw new Error(result?.reason || _tf('viewer.qualityUnavailable', 'Quality {quality} unavailable', { quality: _qualityLabel(primaryQuality) }));
    }

    _currentTimepoint = t;
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
      const actualQuality = _qualityValueForLod(result.lod);
      if (actualQuality && actualQuality !== primaryQuality) {
        const requestedLabel = _qualityLabel(primaryQuality);
        const actualLabel = _qualityLabel(actualQuality);
        _qualityMode = actualQuality;
        primaryQuality = actualQuality; // so the status line below shows the real resolution
        const qSelect = document.getElementById('select-quality');
        if (qSelect) qSelect.value = actualQuality;
        VolumeViewer.setQualityTarget?.(actualQuality, actualQuality);
        _showResolutionDowngradeNotice(requestedLabel, actualLabel, result);
      }
    }

    const grid = result ? ` (${result.width}x${result.height}x${result.depth})` : '';
    _setQualityStatus(`${(result?.fromCache
      ? _tf('viewer.qualityActiveCached', '{quality} active{grid} from cache', { quality: _qualityLabel(primaryQuality), grid })
      : _tf('viewer.qualityActive', '{quality} active{grid}', { quality: _qualityLabel(primaryQuality), grid }))}${_sliceWarning(result)}.`);
    _updatePhysicalStatus();

    // Refresh slicer material after texture upload
    if (typeof VolumeSlicer !== 'undefined') {
      const mat = VolumeViewer.getMaterial();
      if (mat) VolumeSlicer.updateMaterial(mat);
      if (_sliceStaged) _updateSliceStageResolution();
    }

    if (isLive) {
      _refreshBuffer();
      _kickPrefetch();
      // The boot frame is not an operator action (same rule as the camera and the
      // channels): a panel added late must not drag its siblings back to frame 0. Nor
      // is a frame a sibling asked for: told back, the host would relay it to the
      // sender, which then re-derives its own frame from it — a longer timelapse could
      // only rest on the frames the shorter one can represent.
      if (_isIframe && _isInitialized && opts.origin !== 'sync') {
        const total = Number(datasetMeta?.dimensions?.t) || 0;
        _postToHost({ type: 'SYNC_TIME', value: t, total, fraction: total > 1 ? t / (total - 1) : 0 });
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
    return { ok: true, quality: primaryQuality };
  }

  // The pending warm-up of adjacent frames: an idle callback or a timeout, cancelled
  // by the API that made it (the two count their handles apart).
  let _preloadIdle = false;

  function _cancelAdjacentPreload() {
    if (!_preloadTimer) return;
    if (_preloadIdle && typeof cancelIdleCallback === 'function') cancelIdleCallback(_preloadTimer);
    else clearTimeout(_preloadTimer);
    _preloadTimer = null;
  }

  /**
   * The manifest of one timepoint tree of a v3 timelapse (SPEC §13.3): the shared
   * manifest with that row's `index` and no `timepoints`, mounted at bricks/<row.path>.
   * The row's index url is written relative to bricks/ ("t000/index.bin"); the loader
   * resolves it against the tree it mounts, so it is re-expressed relative to that
   * tree ("index.bin"). null for a v2 row or a malformed one.
   */
  function _v3TimepointManifest(manifest, row) {
    if (!_isV3BrickManifest(manifest) || !row || typeof row !== 'object' || !row.index || typeof row.index.url !== 'string') return null;
    const path = String(row.path || '').replace(/^\/+|\/+$/g, '');
    let url = row.index.url.replace(/^\/+/, '');
    if (path && url.startsWith(`${path}/`)) url = url.slice(path.length + 1);
    return { ...manifest, timepoints: null, index: { ...row.index, url } };
  }

  function _scheduleAdjacentPreload(basePath, t) {
    if (!isLive || _isIframe || !Number.isFinite(t)) return;
    _cancelAdjacentPreload();
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
    const work = tpRows && typeof tpRows === 'object'
      ? () => {
        const brickDir = datasetMeta?.qualities?.native?.directory || 'bricks';
        const lod = _lodForQuality(_qualityMode);
        candidates.forEach(frame => {
          const key = `t${String(frame).padStart(3, '0')}`;
          const row = tpRows[key] || tpRows[String(frame)] || tpRows[frame];
          // v2: the row's own brickTransport; v3: the shared manifest with the row's index.
          const transport = row?.brickTransport || _v3TimepointManifest(_brickManifest, row);
          if (!transport) return;
          _preloadedTimepoints.add(frame);
          BrickLoader.prefetchPacks?.(
            `${basePath}/${brickDir}/${row.path || key}`, transport, lod, 0
          )?.catch?.(() => {});   // best effort: the foreground load retries properly
        });
      }
      : () => {
        candidates.forEach(frame => {
          _preloadedTimepoints.add(frame);
          VolumeViewer.preloadVolume(basePath, datasetMeta, frame, { quality: '256x256' })
            .then((result) => {
              if (result.successfulLoads > 0) {
                _setQualityStatus(_tf('viewer.nearbyCached', 'Nearby previews cached. {quality} remains the displayed target.', { quality: _qualityLabel(_qualityMode) }));
              }
            })
            .catch(err => console.warn('[ViewerApp] Timepoint preload failed:', err));
        });
      };
    const run = () => { _preloadTimer = null; work(); };

    _preloadIdle = typeof window.requestIdleCallback === 'function';
    _preloadTimer = _preloadIdle
      ? window.requestIdleCallback(run, { timeout: 1800 })
      : setTimeout(run, 350);
  }

  function _sliceWarning(result) {
    const bricks = Number(result?.missingBricks) || 0;
    if (bricks > 0) {
      return `; ${bricks === 1
        ? _t('viewer.brickMissingOne', '1 brick could not be loaded')
        : _tf('viewer.brickMissingMany', '{n} bricks could not be loaded', { n: bricks })}`;
    }
    if (!result?.failedLoads) return '';
    return `; ${result.failedLoads === 1
      ? _t('viewer.sliceMissingOne', '1 slice image missing')
      : _tf('viewer.sliceMissingMany', '{n} slice images missing', { n: result.failedLoads })}`;
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
    const loading = progress < 1 && state?.streaming === true;
    panel.classList.toggle('hidden', !loading);
    fill.style.width = `${Math.round(progress * 100)}%`;
    text.textContent = `${_qualityLabel(active)} ${Math.round(progress * 100)}%${message ? ` · ${message}` : ''}`;
  }

  function _setQualityStatus(text) {
    const status = document.getElementById('quality-status');
    if (!status) return;
    // Live text from now on: the language switch must not reset it to the default line.
    status.removeAttribute('data-i18n');
    status.textContent = text;
  }

  // CAP-008: dismissible notice shown when the requested resolution could not fit in GPU
  // memory and a lower LOD was rendered instead. Requires an explicit OK to acknowledge.
  function _showResolutionDowngradeNotice(requestedLabel, actualLabel, result = null) {
    let text = _tf(
      'viewer.resDowngrade',
      '{requested} resolution exceeds available GPU memory — displaying {actual} instead.',
      { requested: requestedLabel, actual: actualLabel }
    );
    const mb = (b) => String(Math.round(Number(b) / (1024 * 1024)));
    if (Number(result?.neededBytes) > 0 && Number(result?.budgetBytes) > 0) {
      text += ` ${_tf('viewer.resDowngradeBytes', '({needed} MB needed, {budget} MB available for the volume.)', { needed: mb(result.neededBytes), budget: mb(result.budgetBytes) })}`;
    } else if (result?.downgradeReason === 'alloc-failed') {
      text += ` ${_t('viewer.resDowngradeRefused', '(The GPU refused the allocation.)')}`;
    }
    _showViewerNotice(text);
  }

  /** A dismissible notice over the viewer, acknowledged with OK (one at a time). */
  function _showViewerNotice(text) {
    document.querySelector('.res-downgrade-notice')?.remove();
    const notice = document.createElement('div');
    notice.className = 'res-downgrade-notice';
    notice.setAttribute('role', 'alertdialog');
    notice.setAttribute('aria-live', 'assertive');

    const msg = document.createElement('span');
    msg.className = 'res-downgrade-notice__msg';
    msg.textContent = text;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'res-downgrade-notice__ok';
    btn.textContent = _t('viewer.resDowngradeOk', 'OK');
    btn.addEventListener('click', () => notice.remove());

    notice.appendChild(msg);
    notice.appendChild(btn);
    document.body.appendChild(notice);
  }

  /** A dataset of more than four channels mounts with its first four (the renderer's RGBA). */
  function _noticeExtraChannels() {
    const count = Number(datasetMeta?.dimensions?.c) || (Array.isArray(datasetMeta?.channels) ? datasetMeta.channels.length : 0);
    if (count > 4) {
      _showViewerNotice(_tf('viewer.channelsBeyondFour', 'This dataset has {n} channels: the viewer and the Studio show the first 4.', { n: count }));
    }
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
      ? _t('viewer.calExact', 'Exact')
      : calibration.calibrationStatus === 'estimated'
        ? _t('viewer.calEstimated', 'Estimated')
        : _t('viewer.calMissing', 'Metadata missing');
    const zDisplayed = physical.z * _zDisplayScale;
    const overrideText = _tf('viewer.displayOverride', 'Display override: {k}x', { k: _zDisplayScale.toFixed(2) });
    const active = VolumeViewer.getSamplingVolume?.();
    const activeGrid = active?.width && active?.height && active?.depth
      ? `${active.width}x${active.height}x${active.depth}`
      : '--';
    const nativeDims = _qualityDims('native');
    const nativeGrid = nativeDims ? `${nativeDims.x}x${nativeDims.y}x${nativeDims.z}` : '--';
    const esc = (v) => Utils.escapeHtml(String(v));
    status.innerHTML = `
      <strong>${esc(_tf('viewer.physicalSize', 'Physical size: {x} x {y} x {z} µm', { x: _fmtUm(physical.x), y: _fmtUm(physical.y), z: _fmtUm(zDisplayed) }))}</strong><br>
      ${esc(_tf('viewer.voxelGrid', 'Voxel grid: active {active}; native {native}', { active: activeGrid, native: nativeGrid }))}<br>
      ${esc(_tf('viewer.calibrationLine', 'Calibration: {cal}; {override}; slice thickness: {t} µm', { cal: calibrationLabel, override: overrideText, t: _fmtUm(physical.sliceThickness) }))}
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

    // Listen from parent — the hosting page alone: the same origin is not enough (an
    // opener, another tab or a plugin frame of the site shares it).
    window.addEventListener('message', (e) => {
      if (!Utils.isTrustedMessageOrigin(e) || e.source !== window.parent || window.parent === window) return;
      const data = e.data;
      if (!data || typeof data !== 'object' || typeof data.type !== 'string') return;
      try {
        _handleHostMessage(data);
      } catch (err) {
        console.warn(`[ViewerApp] Host message ${data.type} failed:`, err);
      }
    });
  }

  /** One message from the hosting page (already checked: its origin and its window). */
  function _handleHostMessage(data) {
    // NOTE: APPLY_WORKSPACE_STATE is handled by the module-level listener
    // installed before init() runs (at the bottom of viewer.js). Do NOT handle
    // it here to avoid double-processing.

    // A relay of this panel's own message (the URL index is a string, a host may send a number).
    if (data.sourceIndex !== undefined && data.sourceIndex !== null && String(data.sourceIndex) === String(_panelIndex)) return;

    if (_answerHostRequest(data)) return;

    if (data.type === 'SYNC_Z') {
      const value = parseFloat(data.value);
      if (Number.isFinite(value)) {
        _suppressSlicerSync = true;
        try {
          VolumeViewer.setPlaneSpec({ value }, { notify: false });
          // The staged slice follows the sibling's slider, not only the 3D plane.
          if (typeof VolumeSlicer !== 'undefined' && VolumeSlicer.isVisible()) {
            VolumeSlicer.setPlaneSpec({ value });
            _slicerSyncSlidersFromSpec();
          } else {
            const slider = document.getElementById('slicer-position');
            if (slider) slider.value = Math.round(value * 100);
          }
        } finally {
          _suppressSlicerSync = false;
        }
      }
    } else if (data.type === 'SYNC_CHANNELS') {
      const params = data.value;
      if (!params || typeof params !== 'object' || typeof params.name !== 'string') return;
      const matchingIdx = _channelState.findIndex(ch => ch.name === params.name);
      if (matchingIdx !== -1) {
        // Only the settings this channel already has, of the same kind — nothing a
        // sibling's message invents rides into the channel state.
        const current = _channelState[matchingIdx] || {};
        const patch = {};
        for (const [k, v] of Object.entries(params)) {
          if (k === 'name' || !Object.prototype.hasOwnProperty.call(current, k)) continue;
          const kind = typeof current[k];
          if (kind === 'number' ? Number.isFinite(v) : (kind === 'boolean' || kind === 'string') && typeof v === kind) patch[k] = v;
        }
        const newState = [..._channelState];
        newState[matchingIdx] = { ...current, ...patch };
        ChannelPanel.setState(newState, { notify: false });
        // What the panel accepted (clamped, re-derived), not the raw message.
        const applied = ChannelPanel.getState?.()?.[matchingIdx] || newState[matchingIdx];
        _channelState[matchingIdx] = { ...applied };
        VolumeViewer.updateChannel(matchingIdx, applied);
      }
    } else if (data.type === 'SYNC_EXPOSURE') {
      // A sibling panel moved its exposure: follow it, silently.
      const slider = document.getElementById('slider-exposure');
      if (slider && Number.isFinite(Number(data.value))) {
        slider.value = Math.max(20, Math.min(500, Math.round(Number(data.value) * 100)));
        _suppressChannelSync = true;
        try { _syncExposureFromUi(); } finally { _suppressChannelSync = false; }
      }
    } else if (data.type === 'SET_CHANNEL_ACTIVE') {
      if (!Number.isInteger(Number(data.channelIndex ?? data.value))) return;
      // Support both key names: channelIndex (sent by _decomposeChannels) and value (legacy)
      // The panel's visibility flag is `enabled` (ChannelPanel); `active` is the
      // legacy metadata spelling it only falls back to, so writing it here left
      // every decomposed panel showing every channel.
      const targetIdx = Number(data.channelIndex ?? data.value);
      const newState = _channelState.map((ch, idx) => ({ ...ch, enabled: idx === targetIdx }));
      ChannelPanel.setState(newState, { notify: false });
      newState.forEach((ch, idx) => {
        _channelState[idx] = { ...ch };
        VolumeViewer.updateChannel(idx, ch);
      });
      window.dispatchEvent(new CustomEvent('channels-updated'));
    } else if (data.type === 'SYNC_ZSTACK_SLICE') {
      // A sibling panel moved its z-stack browser: open ours if needed and mirror
      // its mode, cursor, thickness and trim — or close ours when it closed. The
      // guard keeps the mirror silent.
      _suppressZstackSync = true;
      try {
        if (data.mode === 'off') {
          if (_zstackActive) _applyZstackState(false, null);
        } else {
          if (!_zstackActive) _applyZstackState(true, null);
          const mod = _zstackModule();
          if (mod?.impl?.applySync) mod.impl.applySync(data);
        }
      } finally {
        _suppressZstackSync = false;
      }
    } else if (data.type === 'SYNC_SLICER_SPEC') {
      // A sibling panel moved the slice-through-volume plane. The 3D plane mesh
      // follows it and the slice goes on the stage (VolumeSlicer visibility →
      // _setSliceStage), exactly as when this panel's own tool is open — the
      // raymarcher has no cut-plane uniform, the slicer is the only way to show
      // the cut. The spec's `visible` flag is authoritative: a sibling whose plane
      // is OFF must not replace this panel's volume with a flat slice, but the
      // position is tracked either way so the plane is aligned when it comes
      // back. While this panel's own tool is open it decides for itself. The
      // stage and the Z-stack browser exclude each other.
      const spec = data.spec && typeof data.spec === 'object' ? data.spec : {};
      const specVisible = spec.visible !== false;
      const ownTool = typeof ToolManager !== 'undefined' && ToolManager.current() === 'slice';
      if (specVisible && _zstackActive) _applyZstackState(false, null);
      _suppressSlicerSync = true;
      try {
        VolumeViewer.setPlaneSpec(spec, { notify: false, visible: specVisible || ownTool });
        if (typeof VolumeSlicer !== 'undefined') {
          const mat = VolumeViewer.getMaterial?.();
          if (mat) VolumeSlicer.updateMaterial(mat);
          VolumeSlicer.setPlaneSpec(spec);
          if (!ownTool) VolumeSlicer.setVisible(specVisible);
          if (VolumeSlicer.isVisible()) {
            _slicerSyncSlidersFromSpec();
            _slicerSyncPresetButtons(VolumeSlicer.getPlaneSpec().mode);
          }
        }
      } finally {
        _suppressSlicerSync = false;
      }
    } else if (data.type === 'SYNC_TIME' && isLive) {
      // Timelapses of different lengths align by elapsed fraction, not by index.
      const mine = Number(datasetMeta?.dimensions?.t) || 0;
      const theirs = Number(data.total) || 0;
      const frame = (mine > 1 && theirs > 1 && theirs !== mine && Number.isFinite(Number(data.fraction)))
        ? Math.round(Number(data.fraction) * (mine - 1))
        : Number(data.value);
      // The frame a sibling is on: moved to silently, and its arrival is not posted back.
      if (Number.isFinite(frame) && _basePath && typeof Timeline !== 'undefined') {
        // A frame this series has (a sibling's index is not checked against our length).
        const own = mine > 0 ? Math.max(0, Math.min(mine - 1, Math.round(frame))) : Math.max(0, Math.round(frame));
        Timeline.setFrame(own, true, false);
        _requestTimepoint(_basePath, own, 'sync');
      }
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
        VolumeViewer.setCameraState(_cameraStateFromSibling(data.value));
      }
      if (Number.isFinite(data.value?.zDisplayScale)) {
        // Mirrored for the session only: persisting it would stamp a sibling's
        // anisotropy correction onto THIS dataset for every future visit.
        _zDisplayScale = _clampZDisplayScale(data.value.zDisplayScale);
        const slider = document.getElementById('slider-z-scale');
        if (slider) slider.value = Math.round(_zDisplayScale * 100);
        _updateZScaleLabel();
        _updatePhysicalStatus();
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
      _applyHostTool(data.tool);
    } else if (data.type === 'PANEL_HELLO') {
      // The host asks for the panel's description (again): answer once ready.
      if (_isInitialized) _postPanelReady();
    } else if (data.type === 'PLUGIN_ACTIVATE') {
      _activateHostPlugin(data.id);
    } else if (data.type === 'SET_QUALITY') {
      // Always answered: the host stages one panel at a time and waits for this reply.
      const quality = _normalizeQualityParam(data.quality);
      if (!quality) {
        _postToHost({ type: 'QUALITY_STATUS', quality: _qualityMode, requested: String(data.quality ?? ''), phase: 'error', message: 'unknown quality' });
      } else if (quality === _qualityMode && _loadedQualities.has(_qualityKey(_currentTimepoint, quality))) {
        _postToHost({ type: 'QUALITY_STATUS', quality, phase: 'ready' });
      } else {
        // Up or down alike: the volume is reloaded at that level.
        Promise.resolve(_setQualityMode(quality))
          // A load that a later one superseded (a timeline tick) did not show the level yet.
          // `quality` is the level on screen: lower than `requested` when the GPU budget
          // made the viewer settle on a coarser one (downgraded) — asking again would
          // only reload the same coarser level.
          .then((result) => _postToHost({
            type: 'QUALITY_STATUS', quality: _qualityMode, requested: quality,
            downgraded: Boolean(result?.ok && _qualityMode !== quality),
            phase: result?.ok ? 'ready' : 'superseded'
          }))
          .catch((err) => _postToHost({ type: 'QUALITY_STATUS', quality, phase: 'error', message: String(err?.message || err) }));
      }
    } else if (data.type === 'SET_SAMPLE_UPSIDE_DOWN') {
      // The admin editor's sample-side switch, on its preview: lay the volume
      // flat with the face the flag names as the top toward the camera — what the
      // z-stack browser will show — so the operator picks the side by looking.
      VolumeViewer.setSampleUpsideDown?.(data.value === true, { preview: true });
    } else if (data.type === 'TOGGLE_VISUAL') {
      if (data.visual === 'grid') {
        VolumeViewer.setGridMode?.(data.state ? 1 : 0);
      } else if (data.visual === 'axes') {
        VolumeViewer.setAxesVisible?.(!!data.state);
      }
    } else if (data.type === 'TOGGLE_ZSTACK') {
      // Handled by the early module-level listener (_applyZstackState).
      // This path runs only if the message arrives AFTER _bindIframeSync (i.e. late messages).
      // The browser closes the slice tool itself (mutual exclusion, in its plugin).
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
          // A 512 px thumbnail: rendered at 1024, never at the native frame size.
          const sr = getCurrentSliceResult({ raw: false, maxRes: 1024 });
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
          window.parent.postMessage({ type: 'SCREENSHOT_RESPONSE', sourceIndex: _panelIndex, success: false, error: 'No active canvas found' }, Utils.trustedTargetOrigin());
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
        
        if (canvas === VolumeViewer.getRenderer?.()?.domElement) VolumeViewer.renderNow?.();
        ctx.drawImage(canvas, dx, dy, dWidth, dHeight);
        const dataUrl = thumbCanvas.toDataURL('image/webp', 0.9);
        // SEC-012: restrict targetOrigin to this page's origin (no wildcard leak).
        window.parent.postMessage({ type: 'SCREENSHOT_RESPONSE', sourceIndex: _panelIndex, success: true, dataUrl }, Utils.trustedTargetOrigin());
      } catch (err) {
        // SEC-012: restrict targetOrigin to this page's origin (no wildcard leak).
        window.parent.postMessage({ type: 'SCREENSHOT_RESPONSE', sourceIndex: _panelIndex, success: false, error: err.message }, Utils.trustedTargetOrigin());
      }
    }
  }

  // ── Anatomical camera sync ────────────────────────────────
  // Each dataset carries its own calibration Q_base (metadata.orientation): the
  // cube pose at which the specimen sits in the lab's anatomical frame. Two
  // embryos calibrated differently therefore hold DIFFERENT raw cube quaternions
  // for the same anatomical view. A panel shares its pose in the anatomical
  // frame, Q_anat = Q_cube · Q_base⁻¹, and a sibling re-expresses it in its own
  // frame, Q_cube' = Q_anat · Q_base'. Same dataset twice (Decompose) ⇒ Q_base
  // equal ⇒ the raw pose round-trips unchanged. Uncalibrated ⇒ identity.
  function _baseQuaternion() {
    const v = datasetMeta?.orientation;
    if (typeof THREE === 'undefined' || !v) return null;
    const a = Array.isArray(v) ? v : (typeof v === 'object' ? [v.x, v.y, v.z, v.w !== undefined ? v.w : 1] : null);
    if (!a || a.length !== 4 || !a.every(Number.isFinite)) return null;
    const q = new THREE.Quaternion(a[0], a[1], a[2], a[3]);
    return q.lengthSq() < 1e-8 ? null : q.normalize();
  }

  function _cameraStateForSiblings(state) {
    if (!state || !Array.isArray(state.quaternion) || typeof THREE === 'undefined') return state;
    const base = _baseQuaternion() || new THREE.Quaternion();
    const anat = new THREE.Quaternion().fromArray(state.quaternion).multiply(base.clone().invert());
    return { ...state, anatQuaternion: anat.toArray() };
  }

  function _cameraStateFromSibling(value) {
    if (!value || !Array.isArray(value.anatQuaternion) || typeof THREE === 'undefined') return value;
    const base = _baseQuaternion() || new THREE.Quaternion();
    const q = new THREE.Quaternion().fromArray(value.anatQuaternion).multiply(base);
    return { ...value, quaternion: q.toArray() };
  }

  // ── Hosted panel (Compare page) ────────────────────────────
  // The host cannot see this page's toolbar (the header is hidden), so it is
  // told what the toolbar offers (PANEL_READY / describeToolbar), drives the
  // toggles (PLUGIN_ACTIVATE) and tools (SET_TOOL), and hears every state change
  // back (PLUGIN_STATE / TOOL_CHANGED). Only a page with a panel index has a host.
  let _suppressToolSync = false;

  function _postToHost(msg, transfer) {
    if (!_isIframe || _panelIndex === null) return;
    // SEC-012: restrict targetOrigin to this page's origin (no wildcard leak).
    const message = { ...msg, sourceIndex: _panelIndex };
    if (Array.isArray(transfer) && transfer.length) window.parent.postMessage(message, Utils.trustedTargetOrigin(), transfer);
    else window.parent.postMessage(message, Utils.trustedTargetOrigin());
  }

  // ── Requests of the host (Compare) ─────────────────────────
  // The host never calls into this document: it asks (REQUEST_*, with a requestId)
  // and this page answers in its own message with the same requestId (ok: false and
  // an error when it cannot). Pictures travel as ImageBitmaps (transferred), data as
  // plain structured-cloneable values.

  /** A JSON-safe copy (no function, no DOM node): what a state or a slice description may carry across. */
  function _plainForHost(value) {
    return value === undefined ? null : JSON.parse(JSON.stringify(value));
  }

  /**
   * A slice result as the host can receive it: the picture as `bitmap` (an
   * ImageBitmap to transfer), the raw channel values kept as typed arrays, the
   * histograms of the volume for a cell without raw, everything else JSON-safe.
   * → Promise<{ result, transfer }> | null without a picture.
   */
  function _sliceResultForHost(sr) {
    if (!sr?.canvas || typeof createImageBitmap !== 'function') return null;
    const { canvas, raw, ...rest } = sr;
    // The slice canvases here are copies (_copyCanvas), not the WebGL view: they
    // keep their pixels while the bitmap is made.
    return createImageBitmap(canvas).then((bitmap) => {
      const result = _plainForHost(rest);
      result.bitmap = bitmap;
      if (raw && ArrayBuffer.isView(raw.data)) {
        result.raw = {
          data: raw.data, width: raw.width, height: raw.height, channels: raw.channels,
          projected: raw.projected === true, coverage: raw.coverage === true
        };
        if (ArrayBuffer.isView(raw.coverageMask)) result.raw.coverageMask = raw.coverageMask;
      } else {
        result.raw = null;
      }
      let histograms = null;
      try { histograms = VolumeViewer.getChannelHistograms?.() || null; } catch (err) { histograms = null; }
      result.histograms = histograms ? _plainForHost(histograms) : null;
      return { result, transfer: [bitmap] };
    });
  }

  /** Answers one REQUEST_* of the host; false for any other message. */
  function _answerHostRequest(data) {
    if (!data || typeof data.type !== 'string' || !data.type.startsWith('REQUEST_') || data.type === 'REQUEST_SCREENSHOT') return false;
    const requestId = typeof data.requestId === 'string' ? data.requestId : null;
    if (!requestId) return true;
    const failure = (err) => String(err?.message || err || 'unavailable');
    if (data.type === 'REQUEST_CAPTURE') {
      // The WebGL drawing buffer is not kept between frames: render and snapshot it
      // in this very task (createImageBitmap copies the canvas when it is called).
      let pending = null;
      try {
        const canvas = getCaptureCanvas();
        if (canvas && canvas.width && canvas.height && typeof createImageBitmap === 'function') pending = createImageBitmap(canvas);
      } catch (err) {
        _postToHost({ type: 'CAPTURE', requestId, ok: false, error: failure(err) });
        return true;
      }
      if (!pending) {
        _postToHost({ type: 'CAPTURE', requestId, ok: false, error: 'nothing to capture' });
        return true;
      }
      pending.then(
        (bitmap) => _postToHost({ type: 'CAPTURE', requestId, ok: true, bitmap, width: bitmap.width, height: bitmap.height }, [bitmap]),
        (err) => _postToHost({ type: 'CAPTURE', requestId, ok: false, error: failure(err) })
      );
      return true;
    }
    if (data.type === 'REQUEST_STUDIO_SLICE') {
      let pending = null;
      try {
        pending = _sliceResultForHost(getCurrentSliceResult());
      } catch (err) {
        _postToHost({ type: 'STUDIO_SLICE', requestId, ok: false, error: failure(err) });
        return true;
      }
      if (!pending) {
        _postToHost({ type: 'STUDIO_SLICE', requestId, ok: false, error: 'no slice to hand over' });
        return true;
      }
      pending.then(
        ({ result, transfer }) => _postToHost({ type: 'STUDIO_SLICE', requestId, ok: true, result }, transfer),
        (err) => _postToHost({ type: 'STUDIO_SLICE', requestId, ok: false, error: failure(err) })
      );
      return true;
    }
    if (data.type === 'REQUEST_WORKSPACE_STATE') {
      try {
        _postToHost({ type: 'WORKSPACE_STATE', requestId, ok: true, state: _isInitialized ? _plainForHost(_getWorkspaceState()) : null });
      } catch (err) {
        _postToHost({ type: 'WORKSPACE_STATE', requestId, ok: false, error: failure(err) });
      }
      return true;
    }
    if (data.type === 'REQUEST_CHANNEL_STATE') {
      try {
        _postToHost({ type: 'CHANNEL_STATE', requestId, ok: true, channels: _plainForHost(getChannelState()) });
      } catch (err) {
        _postToHost({ type: 'CHANNEL_STATE', requestId, ok: false, error: failure(err) });
      }
      return true;
    }
    return false;
  }

  function _postPanelReady() {
    if (!_isIframe || _panelIndex === null) return;
    const toolbar = (typeof PluginRegistry !== 'undefined' && PluginRegistry.describeToolbar)
      ? PluginRegistry.describeToolbar()
      : { tools: [], toggles: [] };
    _postToHost({
      type: 'PANEL_READY',
      id: datasetId,
      name: datasetMeta?.name || datasetId,
      datasetType: datasetMeta?.type || null,
      toolbar,
      features: {
        volume: true,
        timeline: Boolean(isLive),
        channels: _channelState.length,
        tracking: Boolean(datasetMeta?.tracking?.tracksPath),
        // GPU bytes each quality's atlas would take, for the host's quality staging.
        qualityBytes: _qualityBytes()
      },
      quality: _qualityMode,
      tool: typeof ToolManager !== 'undefined' ? ToolManager.current() : 'navigate'
    });
  }

  /**
   * The GPU bytes each quality of the select would allocate
   * ({ '512x512': n, '1024x1024': n, native: n, … }), as the viewer plans its volume
   * (VolumeViewer.getQualityFootprints). null before a bricked dataset is mounted.
   */
  function _qualityBytes() {
    const select = document.getElementById('select-quality');
    const offered = select ? [...select.options].map(o => o.value) : ['512x512', '1024x1024', 'native'];
    const footprints = VolumeViewer.getQualityFootprints?.(offered);
    if (footprints?.qualities) {
      const out = {};
      for (const [quality, fp] of Object.entries(footprints.qualities)) {
        if (Number(fp?.bytes) > 0) out[quality] = Number(fp.bytes);
      }
      if (Object.keys(out).length) return out;
    }
    const levels = Array.isArray(_brickManifest?.levels) ? _brickManifest.levels : null;
    if (!levels?.length || typeof BrickLoader === 'undefined' || typeof SVRManager === 'undefined' || !SVRManager.planAtlas) return null;
    const renderer = VolumeViewer.getRenderer?.();
    const max3D = Math.max(64, renderer?.capabilities?.max3DTextureSize || 2048);
    // Without the viewer's footprints: the level's non-empty bricks, one slot each — 66³ on
    // a bordered (v3) tree, and R8 / RG8 texels for 1–2 channel data, as the atlas is built.
    const format = BrickLoader.getFormat?.() || null;
    const brickSize = Number(format?.brickStride) || 64;
    const channels = Number(format?.channels) || Number(_brickManifest?.channels) || 4;
    const components = channels <= 1 ? 1 : (channels === 2 ? 2 : 4);
    const out = {};
    for (const quality of offered) {
      const lod = _lodForQuality(quality);
      const count = BrickLoader.activeBrickCount?.(lod);
      if (!(count > 0)) continue;
      const plan = SVRManager.planAtlas(count, { max3D, brickSize, components });
      if (plan && plan.bytes > 0) out[quality] = plan.bytes;
    }
    return Object.keys(out).length ? out : null;
  }

  function _bindHost() {
    if (!_isIframe || _panelIndex === null) return;
    if (typeof PluginRegistry !== 'undefined' && PluginRegistry.onToolbarState) {
      PluginRegistry.onToolbarState(({ id, active, icon }) => _postToHost({ type: 'PLUGIN_STATE', id, active, icon }));
    }
    // Button titles travel in the panel's language: re-describe on a switch.
    if (typeof I18n !== 'undefined' && I18n.onLanguageChange) I18n.onLanguageChange(() => _postPanelReady());
    _postPanelReady();
  }

  /** The host's tool for every panel; one this page does not offer falls back to navigate. */
  function _applyHostTool(tool) {
    if (typeof ToolManager === 'undefined') return;
    const wanted = String(tool || 'navigate');
    const sel = window.CSS && CSS.escape ? CSS.escape(wanted) : wanted;
    const available = wanted === 'navigate' || Boolean(document.querySelector(`[data-tool="${sel}"]`));
    _suppressToolSync = true;
    try { ToolManager.activate(available ? wanted : 'navigate'); }
    finally { _suppressToolSync = false; }
  }

  /** A toggle/action of the panel's toolbar, pressed from the host. */
  function _activateHostPlugin(id) {
    if (typeof PluginRegistry === 'undefined' || !id) return;
    if (id === 'zstack-browser') {
      // The browser has page-level side effects (slice tool closed, camera lock)
      // that TOGGLE_ZSTACK already sequences: same door, same order.
      _applyZstackState(!_zstackActive, null);
      return;
    }
    const entry = PluginRegistry.getModule(id);
    if (!entry) return;
    const result = PluginRegistry.activate(id);
    if (entry.meta?.subtype === 'toggle' && result) {
      PluginRegistry.syncToolbarButton(id, { active: !!result.active, icon: result.icon });
    }
  }

  function _clampZDisplayScale(value) {
    return Number.isFinite(value) ? Math.max(0.25, Math.min(2.0, value)) : 1.0;
  }

  /** Is a volume on screen (a failed frame of a timelapse leaves the previous one up)? */
  function _hasMountedVolume() {
    const entry = VolumeViewer.getSamplingVolume?.();
    return Boolean(entry && (entry.textures || entry.data));
  }

  /** The loader's progress view (spinner, label, bar), its error card hidden. */
  function _showLoaderProgress() {
    const loader = document.getElementById('viewer-loader');
    if (!loader) return;
    loader.style.display = 'flex';
    document.getElementById('loader-body')?.classList.remove('hidden');
    const card = document.getElementById('loader-error');
    if (card) {
      card.classList.add('hidden');
      card.replaceChildren();
    }
  }

  /**
   * A load failed. With a volume already on screen (a timelapse frame, a restore, a
   * quality switch) it stays there and the status line says what failed. With none,
   * the loader shows the error card — in its own element, so the progress bar and the
   * label every later load writes to are still there.
   */
  function _showLoadingError(err) {
    console.error('[ViewerApp] Loading failed:', err);
    const text = String(err?.message || err || _t('viewer.errUnknown', 'Unknown loading error'));
    if (_isInitialized && _hasMountedVolume()) {
      const loader = document.getElementById('viewer-loader');
      if (loader) loader.style.display = 'none';
      _setQualityStatus(_tf('viewer.loadFailedKept', 'Loading failed: {message}. The volume on screen is kept.', { message: text }));
      return;
    }
    _postToHost({ type: 'PANEL_ERROR', message: text });
    const loader = document.getElementById('viewer-loader');
    if (!loader) return;
    loader.style.display = 'flex';
    document.getElementById('loader-body')?.classList.add('hidden');
    let card = document.getElementById('loader-error');
    if (!card) {
      card = document.createElement('div');
      card.id = 'loader-error';
      card.className = 'viewer-loader-error';
      card.setAttribute('role', 'alert');
      loader.appendChild(card);
    }
    const icon = document.createElement('i');
    icon.setAttribute('data-lucide', 'alert-triangle');
    icon.className = 'viewer-loader-error__icon';
    const title = document.createElement('h3');
    title.textContent = _t('viewer.loadingError', 'Loading error');
    const message = document.createElement('p');
    message.className = 'viewer-loader-error__message';
    message.textContent = text;
    card.replaceChildren(icon, title, message);
    if (!_isIframe) {
      const back = document.createElement('a');
      back.href = 'explorer.html';
      back.className = 'btn btn-primary viewer-loader-error__back';
      back.textContent = _t('viewer.backToExplorer', 'Return to Explorer');
      card.appendChild(back);
    }
    card.classList.remove('hidden');
    if (window.lucide) lucide.createIcons({ nodes: [card] });
  }

  async function _getFigureBlob(options = {}) {
    // On the stage the slice is what the screen shows: capture it, at its sharpest.
    let canvas = null;
    if (_sliceStaged && typeof VolumeSlicer !== 'undefined') {
      VolumeSlicer.flushPreview?.();
      canvas = VolumeSlicer.getPreviewCanvas();
    }
    canvas = canvas || document.getElementById('webgl-canvas');
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
    if (canvas.id === 'webgl-canvas') VolumeViewer.renderNow?.();
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
    node.textContent = _tf('viewer.volSourceDisplay', 'Display: {label}.', { label: preferred.label });
  }

  function _scheduleViewerResize() {
    // Only call VolumeViewer.resize() — don't dispatch window resize events
    // since the ResizeObserver already handles DOM layout changes and
    // dispatching window resize would doubly update the renderer to wrong dimensions.
    [0, 80, 200].forEach(delay => setTimeout(() => VolumeViewer.resize(), delay));
  }

  /**
   * The slice on screen for the Studio (the Compare page's, the fallback of
   * openStudio) or a thumbnail: the z-stack browser's slab when it is open, else the
   * inspector plane, framed on the plane's footprint on the volume (cropRect, from the
   * geometry, at renderRes) and rendered for that window alone. `options.raw === false`
   * skips the raw channel values (one more render) that let the Studio re-colour the
   * picture — a thumbnail needs the colours alone; `options.maxRes` caps the frame
   * (a 512 px thumbnail has no use for a native-size render).
   */
  function getCurrentSliceResult(options = {}) {
    const withRaw = options?.raw !== false;
    const maxRes = Number(options?.maxRes) > 0 ? Math.round(Number(options.maxRes)) : 0;
    const dim = datasetMeta?.dimensions || {};
    const maxDim = Math.max(Number(dim.original_x) || Number(dim.x) || 1024, Number(dim.original_y) || Number(dim.y) || 1024);

    const capture = (spec, source) => {
      const material = VolumeViewer.getMaterial?.();
      if (!material || !spec || typeof StudioPlaneOps === 'undefined') return null;
      const full = _captureRenderRes(maxDim);
      const renderRes = maxRes ? Math.min(full, maxRes) : full;
      const { geom, warp } = _studioGeometry(spec, material);
      const cropRect = StudioPlaneOps.cropRect(geom, renderRes, warp);
      const win = cropRect ? _sliceWindowForRect(cropRect, renderRes) : null;
      if (!win) return null;
      const channelState = _currentChannelState();
      try {
        const rendered = VolumeSlicer.renderWithMaterial(material, spec, renderRes, channelState, { window: win });
        if (!rendered) return null;
        const canvas = _copyCanvas(rendered);
        return {
          canvas,
          width: canvas.width,
          height: canvas.height,
          renderRes,
          cropRect,
          raw: withRaw ? _studioRawFor(spec, renderRes, cropRect, canvas) : null,
          source,
          quality: 'high',
          planeSpec: spec,
          pixelSizeUm: _slicePixelSizeUm(spec, renderRes),
          calibrated: _studioCalibrated(),
          physicalSizeUm: VolumeViewer.getPhysicalSize?.(),
          channelState,
          timepoint: _currentTimepoint
        };
      } finally {
        VolumeSlicer.releaseHiPass?.();
      }
    };

    if (typeof VolumeSlicer !== 'undefined' && VolumeSlicer.renderWithMaterial) {
      // The browser's slab (or its whole kept range in 3D), rendered through the shared
      // slicer program so the inspector plane is never disturbed.
      if (_zstackActive && _zstackGetDims().z >= 1) {
        const result = capture(_zstackStudioSpec(), 'zstack');
        if (result) return result;
      }
      const result = capture(VolumeSlicer.getPlaneSpec(), 'gpu-slicer');
      if (result) return result;
    }

    // Default: 3D screenshot
    if (typeof VolumeViewer !== 'undefined' && VolumeViewer.getRenderer) {
      const renderer = VolumeViewer.getRenderer();
      if (renderer) {
        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = renderer.domElement.width;
        tempCanvas.height = renderer.domElement.height;
        const ctx = tempCanvas.getContext('2d');
        VolumeViewer.renderNow?.();
        ctx.drawImage(renderer.domElement, 0, 0);
        return {
          canvas: tempCanvas,
          width: tempCanvas.width,
          height: tempCanvas.height,
          source: '3d',
          quality: '256x256',
          channelState: _currentChannelState(),
          // A perspective view has no single pixel size: no scale bar, distances in px.
          pixelSizeUm: null,
          calibrated: false
        };
      }
    }

    return null;
  }

  /**
   * The canvas this page shows — the staged slice while the slice tool is open, else
   * the WebGL view — ready to be read by the CALLER in its current task: the WebGL
   * view is rendered now, its drawing buffer is not kept between frames. A host page
   * (Compare) calls this synchronously through the same-origin frame and draws the
   * canvas before returning to its event loop.
   */
  function getCaptureCanvas() {
    if (_sliceStaged && typeof VolumeSlicer !== 'undefined') {
      VolumeSlicer.flushPreview?.();
      const slice = VolumeSlicer.getPreviewCanvas?.();
      if (slice?.width && slice?.height) return slice;
    }
    const canvas = document.getElementById('webgl-canvas');
    if (!canvas || typeof VolumeViewer === 'undefined' || !VolumeViewer.renderNow?.()) return null;
    return canvas;
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

  function _slicerSetSpec(partial) {
    const cur = VolumeSlicer.getPlaneSpec();
    const next = { ...cur, ...partial };
    delete next.orientation;
    delete next.normal;
    VolumeSlicer.setPlaneSpec(next);
    // Also update the 3D plane mesh
    VolumeViewer.setPlaneSpec(next, { notify: false });
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
      // Visibility drives the stage: the slicer's canvas takes the canvas area and
      // the WebGL canvas moves into the inspector's square (_setSliceStage).
      VolumeSlicer.setVisible(visible);
      if (visible) {
        // Link material in case a volume has loaded since init
        const mat = VolumeViewer.getMaterial();
        if (mat) VolumeSlicer.updateMaterial(mat);
        // The 3D plane is the plane of record (a restored workspace, a sibling's
        // SYNC_Z, the browser's reset all wrote it while the tool was off): the
        // slicer adopts it, with a plane parked on a face brought back to the middle.
        const spec = VolumeViewer.getPlaneSpec();
        const parked = !(spec.value > 0.01 && spec.value < 0.99);
        _slicerSetSpec({
          mode: spec.mode,
          value: parked ? 0.5 : spec.value,
          yaw: spec.yaw, pitch: spec.pitch, roll: spec.roll,
          slabThickness: spec.slabThickness,
          projection: spec.projection
        });
        _slicerSyncSlidersFromSpec();
        _slicerSyncPresetButtons(spec.mode);
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

  // ── Slice stage ──────────────────────────────────────────
  // While the slice is on screen the two renders trade places: the slicer's
  // canvas fills the canvas area (the "stage") and the WebGL canvas moves into
  // the inspector's square, where the plane is still dragged in 3D. A canvas
  // re-parented inside one document keeps its context; VolumeViewer.resize()
  // follows the new parent. Driven by VolumeSlicer's visibility, which every
  // door shares: the tool, a sibling's SYNC_SLICER_SPEC, the Z-stack browser.
  let _sliceStaged = false;
  let _sliceStageObserver = null;
  // Camera distance before the swap: resize() may push the camera back so the
  // volume fits the square; a distance the user did not touch comes back.
  let _sliceStageCamera = null;

  function _setSliceStage(on) {
    on = Boolean(on);
    if (on === _sliceStaged) return;
    const stage = document.getElementById('slice-stage');
    const mount = document.getElementById('slicer-preview-mount');
    const gl = document.getElementById('webgl-canvas');
    const slice = typeof VolumeSlicer !== 'undefined' ? VolumeSlicer.getPreviewCanvas() : null;
    if (!stage || !mount || !gl || !slice) return;
    _sliceStaged = on;
    document.body.classList.toggle('slice-staged', on);
    if (on) {
      const cam = { z: VolumeViewer.getCameraState?.()?.cameraZ, touched: false, unsub: null };
      cam.unsub = VolumeViewer.onCameraChange?.(() => { cam.touched = true; }) || null;
      _sliceStageCamera = cam;
      stage.appendChild(slice);
      stage.classList.remove('hidden');
      mount.appendChild(gl);
      if (window.ResizeObserver) {
        _sliceStageObserver = new ResizeObserver(() => _updateSliceStageResolution());
        _sliceStageObserver.observe(stage);
      }
      _updateSliceStageResolution();
    } else {
      _sliceStageObserver?.disconnect();
      _sliceStageObserver = null;
      stage.classList.add('hidden');
      stage.parentElement?.insertBefore(gl, stage);
      mount.appendChild(slice);
      VolumeSlicer.setPreviewResolution();
      const cam = _sliceStageCamera;
      _sliceStageCamera = null;
      const restore = () => {
        if (cam && !cam.touched && Number.isFinite(cam.z)) VolumeViewer.setCameraState({ kind: 'volume', cameraZ: cam.z });
      };
      restore();
      // The inspector panel closes with a 250 ms width transition; resize() fits the
      // volume to that interim, narrower layout and can push the camera back again.
      // Restore once more after it, still only if the user has not taken the camera.
      setTimeout(() => { restore(); cam?.unsub?.(); }, 320);
    }
    _scheduleViewerResize();
  }

  /** The stage renders at its displayed size in device pixels (1024 while dragging). */
  function _updateSliceStageResolution() {
    if (!_sliceStaged || typeof VolumeSlicer === 'undefined') return;
    const stage = document.getElementById('slice-stage');
    if (!stage) return;
    const side = Math.min(stage.clientWidth, stage.clientHeight);
    if (!(side > 0)) return;
    const device = Math.round(side * Math.min(window.devicePixelRatio || 1, 2));
    VolumeSlicer.setPreviewResolution(Math.min(device, 1024), device > 1024 ? device : 0);
    _updateSliceStageScale(side);
  }

  /**
   * Scale bar of the staged slice. The slicer draws 2·EXTENT cube units across its
   * square and, after its anisotropy scaling, one cube unit is the longest physical
   * axis: the square spans getPlaneExtentUnits() × max(x, y, z) µm whatever the
   * plane's orientation, so the bar is exact — unlike the 3D bar, which depends on
   * the perspective depth and is hidden meanwhile. Hidden when the size is unknown.
   */
  function _updateSliceStageScale(sideCss) {
    const bar = document.getElementById('slice-stage-scale');
    if (!bar) return;
    const phys = VolumeViewer.getPhysicalSize?.();
    // Without calibration the "physical" size is a voxel count: no bar rather than a lie.
    const calibrated = phys && phys.calibrationStatus !== 'metadata-missing' && phys.mode !== 'metadata-missing';
    const maxUm = calibrated ? Math.max(Number(phys.x) || 0, Number(phys.y) || 0, Number(phys.z) || 0) : 0;
    const units = typeof VolumeSlicer !== 'undefined' && VolumeSlicer.getPlaneExtentUnits ? VolumeSlicer.getPlaneExtentUnits() : 0;
    if (!(maxUm > 0) || !(units > 0) || !(sideCss > 0)) { bar.classList.add('hidden'); return; }
    const umPerPx = (units * maxUm) / sideCss;
    // Nearest 1-2-5 × 10ⁿ at or below a fifth of the slice.
    const lengthUm = Utils.niceScaleLength(sideCss * 0.2 * umPerPx);
    if (!(lengthUm > 0)) { bar.classList.add('hidden'); return; }
    bar.style.width = `${Math.max(20, Math.round(lengthUm / umPerPx))}px`;
    bar.textContent = Utils.formatMicrons(lengthUm);
    bar.classList.remove('hidden');
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

  /** An exception out of init(): the operator sees it, a hosting page hears of it. */
  function _bootFailed(err) {
    let shown = false;
    try {
      _showLoadingError(err);
      shown = true;
    } finally {
      // _showLoadingError posts PANEL_ERROR itself before the volume is mounted; when
      // it threw, a host still waiting for PANEL_READY must not wait out its timeout.
      if (!shown && !_isInitialized) _postToHost({ type: 'PANEL_ERROR', message: String(err?.message || err) });
    }
  }

  return {
    init,
    openStudio,
    getCurrentSliceResult,
    getCaptureCanvas,
    getSamplingVolume,
    getDatasetMeta,
    getCurrentTimepoint,
    getChannelState,
    getWorkspaceState: _getWorkspaceState,
    applyWorkspaceState: _applyWorkspaceState,
    getChannelHistograms: () => (typeof VolumeViewer !== 'undefined' && VolumeViewer.getChannelHistograms ? VolumeViewer.getChannelHistograms() : null),
    resetWorkspace,
    // Stabilised timelapse ⇄ raw acquisition frame (false when there is no registration).
    setVolumeStabilized,
    _bootFailed,
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
// Both early listeners hear the hosting page alone (a Compare panel, the admin
// preview): same origin is not enough, and a top-level viewer has no host.
const _fromViewerHost = (e) => Utils.isTrustedMessageOrigin(e) && window.parent !== window && e.source === window.parent;

window.addEventListener('message', (e) => {
  if (!_fromViewerHost(e)) return;
  const data = e.data;
  if (!data || data.type !== 'APPLY_WORKSPACE_STATE' || !data.state || typeof data.state !== 'object' || Array.isArray(data.state)) return;
  console.log('[ViewerApp] Early listener: APPLY_WORKSPACE_STATE received — routing to ViewerApp.applyWorkspaceState');
  ViewerApp.applyWorkspaceState(data.state);
});

// Early listener for TOGGLE_ZSTACK: compare.js sends this at iframe load time,
// before _bindIframeSync() (and its message listener) is set up inside init().
// If already initialized, apply immediately. Otherwise buffer inside the IIFE.
window.addEventListener('message', (e) => {
  if (!_fromViewerHost(e)) return;
  const data = e.data;
  if (!data || data.type !== 'TOGGLE_ZSTACK') return;
  const desired = !!data.state;
  const slice = data.slice ?? null;
  const payload = { desired, slice };
  // Before init() is through, buffer for it to consume; afterwards the message
  // handler of _bindIframeSync applies it (with the slicer-overlay teardown), so
  // it must not be applied twice from here.
  if (!ViewerApp._isReady?.()) ViewerApp._setPendingZstack?.(payload);
});

// Boot-level safety net (defense in depth): init() is async — if any UI-build step
// throws despite the per-subsystem try/catch barriers, surface it instead of a silent
// unhandled rejection, so failures are diagnosable rather than a blank viewer.
document.addEventListener('DOMContentLoaded', () => {
  Promise.resolve()
    .then(() => ViewerApp.init())
    .catch((err) => {
      console.error('[ViewerApp] boot failed:', err);
      // A hosting page (Compare) waits for PANEL_READY: tell it, and the operator.
      ViewerApp._bootFailed?.(err);
    });
});

