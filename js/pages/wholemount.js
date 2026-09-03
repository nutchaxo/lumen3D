/* ============================================================
   Lumen3D — Wholemount page controller
   ============================================================
   One calibrated photograph per dataset, with the whole collection a
   keystroke away: a contact-sheet browser over every `wholemount`
   dataset of the catalog, filterable by stage / line / text, opens any
   of them in place — no page reload, the preview paints from the
   browser's own cache and the native image follows.

   Plugins are opt-in here. PluginRegistry.loadModules() is asked for
   dataType 'wholemount', so only a plugin whose plugin.json declares it
   in `dataTypes` is injected. The context they receive mirrors the
   volume viewer's (dataset / viewer / measurements / ui / workspace), so
   a plugin written for both pages needs no branching.
   ============================================================ */

const WholemountApp = (() => {
  const TYPE = 'wholemount';
  const LOAD_STATE_LINGER_MS = 900;
  const STAGING_PREFIX = 'staging:';

  let _collection = [];
  let _meta = null;
  let _id = null;
  let _basePath = '';
  let _filters = { stage: 'all', line: 'all', search: '' };
  let _moduleCtx = null;
  let _stateTimer = 0;
  let _isAdmin = false;
  let _panelIndex = null;           // set when this page is one pane of a split view
  let _suppressSync = false;        // a view pushed by the parent must not echo back
  let _datasetListeners = [];

  const $ = (id) => document.getElementById(id);
  const t = (key, params) => I18n.t(key, params);
  const esc = (s) => Utils.escapeHtml(s == null ? '' : String(s));

  // ── Boot ───────────────────────────────────────────────────────────────────
  async function init() {
    await InstanceConfig.load();
    Theme.init();
    await I18n.init();
    InstanceConfig.applyHead();
    InstanceConfig.applyDom();
    await Catalog.load();
    if (window.lucide) lucide.createIcons();
    _updateThemeIcon();
    Theme.onChange(_updateThemeIcon);

    _collection = _sortedCollection();
    const params = new URLSearchParams(window.location.search);
    _isAdmin = params.get('mode') === 'admin';
    _panelIndex = params.get('panelIndex');
    if (params.get('hideHeader') === 'true') document.body.classList.add('wm-headless');
    if (_panelIndex !== null) _bindPanelSync();
    const requested = params.get('id');
    const first = await _resolveDataset(requested, params.get('path'));
    if (!first) {
      _showError(t(requested ? 'viewer.errNotFound' : 'viewer.errNoDataset'));
      return;
    }

    await _loadPlugins(first);
    WholemountViewer.init($('wholemount-canvas'));
    WholemountViewer.onLoadState(_renderLoadState);
    WholemountViewer.onViewChange(_renderZoom);
    WholemountViewer.onLabelMove((id, offset) => MeasurementStore.update(_id, 'viewer', id, { labelOffset: offset }));
    _moduleCtx = _buildModuleCtx();
    if (typeof PluginRegistry !== 'undefined') {
      await PluginRegistry.initAll(_moduleCtx);
      PluginRegistry.bindToolbarButtons();
      $('measure-section').hidden = !PluginRegistry.getModule('measure-distance');
    }
    ToolManager.init({ defaultTool: 'navigate' });
    _bindControls();
    if (_panelIndex !== null) _setSidebarHidden(true);
    _renderBrowserFilters();
    _openDataset(first, { history: 'replace' });
    $('viewer-loader')?.classList.add('hidden');
  }

  async function _loadPlugins(meta) {
    if (typeof PluginRegistry === 'undefined') return;
    try {
      const paths = await PluginRegistry.discover('js/modules');
      await PluginRegistry.loadModules('js/modules', paths, { dataType: TYPE });
      PluginRegistry.buildToolbarButtons({
        dataset: meta,
        groups: [
          { group: 'tools',   container: '[data-tool-group="tools"]' },
          { group: 'export',  container: '[data-tool-group="export"]' },
          { group: 'visuals', container: '[data-tool-group="visuals"]' },
          { group: 'layouts', container: '[data-tool-group="layouts"]' }
        ]
      });
    } catch (err) {
      console.error('[WholemountApp] Plugin subsystem failed — the page boots without plugins.', err);
    }
  }

  // Same shape as the volume viewer's module context; every accessor is lazy so
  // a dataset switch is invisible to the plugins.
  function _buildModuleCtx() {
    return {
      dataset: {
        getMeta: () => _meta,
        getId: () => _id,
        getBasePath: () => _basePath,
        getCollection: () => _collection.slice(),
        fileUrl: (ds, file) => _fileUrl(_datasetBase(ds.path), file),
        open: (id) => { const ds = Catalog.getById(id); if (ds && ds.type === TYPE) _openDataset(ds, { history: 'push' }); },
        onChange: (cb) => { _datasetListeners.push(cb); return () => { _datasetListeners = _datasetListeners.filter(f => f !== cb); }; }
      },
      viewer: {
        setMeasurements: (m) => WholemountViewer.setMeasurements(m),
        onMeasurePoint: (cb) => WholemountViewer.onMeasurePoint(cb),
        getPhysicalCalibration: () => WholemountViewer.getPhysicalCalibration(),
        resize: () => WholemountViewer.resize(),
        fit: () => WholemountViewer.fit(),
        getView: () => WholemountViewer.getView(),
        setView: (v) => WholemountViewer.setView(v),
        onViewChange: (cb) => WholemountViewer.onViewChange(cb),
        getViewport: () => WholemountViewer.getViewport(),
        getImageSize: () => WholemountViewer.getImageSize(),
        getPixelSizeUm: () => WholemountViewer.getPixelSizeUm(),
        addOverlay: (fn) => WholemountViewer.addOverlay(fn),
        redraw: () => WholemountViewer.redraw(),
        setOrientation: (o) => WholemountViewer.setOrientation(o),
        getOrientation: () => WholemountViewer.getOrientation(),
        setAdjustments: (a) => WholemountViewer.setAdjustments(a),
        getAdjustments: () => WholemountViewer.getAdjustments(),
        getPhysicalView: () => WholemountViewer.getPhysicalView(),
        setPhysicalView: (pv) => WholemountViewer.setPhysicalView(pv),
        getNativeCanvas: () => WholemountViewer.getNativeCanvas()
      },
      measurements: {
        list: (scope) => MeasurementStore.list(_id, scope || 'viewer'),
        add: (scope, data) => MeasurementStore.add(_id, scope || 'viewer', data),
        update: (scope, id, patch) => MeasurementStore.update(_id, scope || 'viewer', id, patch),
        remove: (scope, id) => MeasurementStore.remove(_id, scope || 'viewer', id),
        clear: (scope) => MeasurementStore.clear(_id, scope || 'viewer'),
        setAll: (scope, arr) => MeasurementStore.setAll(_id, scope || 'viewer', arr)
      },
      ui: {
        toast: (msg) => { if (typeof ExportManager !== 'undefined') ExportManager.toast(msg); },
        scheduleResize: () => requestAnimationFrame(() => WholemountViewer.resize()),
        escapeHtml: (s) => Utils.escapeHtml(s),
        createIcons: (opts) => { if (window.lucide) lucide.createIcons(opts); },
        getCanvas: () => WholemountViewer.getCanvas(),
        openStudio: () => _openStudio(),
        openStudioWith: (sliceResult) => { if (typeof StudioEditor !== 'undefined') StudioEditor.open(sliceResult); },
        addSidebarSection: _addSidebarSection,
        getStage: () => $('wholemount-canvas').parentElement
      },
      iframe: {
        isIframe: () => _panelIndex !== null,
        panelIndex: () => _panelIndex,
        postMessage: (data) => { if (_panelIndex !== null) window.parent.postMessage(data, Utils.trustedTargetOrigin()); }
      },
      workspace: {
        getState: _getWorkspaceState,
        applyState: _applyWorkspaceState
      },
      getCanvasBlob: (opts) => WholemountViewer.toBlob(opts),
      getCustomExports: () => [],
      _state: { get currentTimepoint() { return 0; } }
    };
  }

  // ── Dataset resolution ─────────────────────────────────────────────────────
  async function _resolveDataset(id, path) {
    // The admin panel passes the bare folder as id and the type/folder as path;
    // a published dataset is in the catalog under the latter.
    const listed = (id ? Catalog.getById(id) : null) || (path ? Catalog.getById(path) : null);
    if (listed && listed.type === TYPE) return listed;
    if (!_isAdmin || !path) return null;
    return _fetchAdminMeta(path);
  }

  // The admin panel previews datasets the public catalog does not list — a staged
  // import, a hidden dataset — through the session-gated datasets API.
  async function _fetchAdminMeta(path) {
    try {
      const resp = await fetch(`api/datasets.php?action=get&id=${encodeURIComponent(path)}`, { credentials: 'same-origin' });
      if (!resp.ok) return null;
      const meta = await resp.json();
      return meta && meta.type === TYPE ? { ...meta, id: path, path } : null;
    } catch (_) {
      return null;
    }
  }

  // Published bytes live under DATA_WEB/; a staged import is read through the
  // admin blob proxy, whose `path` query parameter takes the file name.
  function _datasetBase(path) {
    const p = String(path || '');
    if (!p.startsWith(STAGING_PREFIX)) return `DATA_WEB/${p}`;
    return `api/upload.php?action=blob&ds=${encodeURIComponent(p.slice(STAGING_PREFIX.length))}&path=`;
  }

  function _fileUrl(base, file) {
    return base.endsWith('=') ? base + encodeURIComponent(file) : `${base}/${file}`;
  }

  // ── Dataset switching ──────────────────────────────────────────────────────
  function _openDataset(meta, opts = {}) {
    _meta = meta;
    _id = meta.id;
    _basePath = _datasetBase(meta.path);
    if (!_isAdmin && _panelIndex === null) _syncUrl(opts.history);
    _renderHeader();
    _renderInfo();
    _renderGallery();
    _renderRelated();
    _initExportManager();

    WholemountViewer.setOrientation(meta.orientation2d || null);
    const image = meta.image || {};
    WholemountViewer.load({
      previewUrl: _fileUrl(_basePath, image.preview || 'preview.webp'),
      nativeUrl: _fileUrl(_basePath, image.native || 'image.webp'),
      width: image.width || meta.dimensions?.x || 1,
      height: image.height || meta.dimensions?.y || 1,
      pixelSizeUm: meta.pixelSizeUm?.x
    }).catch(() => {});

    _restoreMeasurements();
    _markActiveCard();
    _prefetchNeighbours();
    for (const cb of _datasetListeners) cb(meta);
  }

  // ── Split-view pane: this page inside another wholemount page ─────────────
  // The parent shares its PHYSICAL view (µm per screen pixel + physical centre);
  // both photographs then show the same field at the same magnification
  // whatever their pixel sizes. Each side suppresses the echo of a view it was
  // given, so the two never chase each other.
  function _bindPanelSync() {
    window.addEventListener('message', (e) => {
      if (!Utils.isTrustedMessageOrigin(e)) return;
      const type = e.data?.type;
      if (type === 'WM_SET_PHYSICAL_VIEW') {
        _suppressSync = true;
        WholemountViewer.setPhysicalView(e.data.view);
        _suppressSync = false;
      } else if (type === 'WM_OPEN_DATASET') {
        const ds = Catalog.getById(e.data.id);
        if (ds && ds.type === TYPE && ds.id !== _id) _openDataset(ds);
      }
    });
    WholemountViewer.onViewChange(() => {
      if (_suppressSync) return;
      window.parent.postMessage({ type: 'WM_PHYSICAL_VIEW', panelIndex: _panelIndex, id: _id, view: WholemountViewer.getPhysicalView() }, Utils.trustedTargetOrigin());
    });
  }

  /** A plugin panel in the sidebar, placed after the measurements. */
  function _addSidebarSection({ id, title }) {
    const body = Utils.el('div', { class: 'wm-plugin-body' });
    const section = Utils.el('div', { class: 'panel-section', id },
      Utils.el('div', { class: 'panel-title' }, Utils.el('span', {}, title)), body);
    $('viewer-sidebar').insertBefore(section, $('gallery-section'));
    return { section, body };
  }

  function _syncUrl(mode) {
    if (!mode) return;
    const url = `wholemount.html?id=${encodeURIComponent(_id)}`;
    if (mode === 'push') history.pushState({ id: _id }, '', url);
    else history.replaceState({ id: _id }, '', url);
  }

  // The store is the source of truth; the measure plugin re-reads it through
  // setState so its list and the canvas show the same items.
  function _restoreMeasurements() {
    const items = MeasurementStore.list(_id, 'viewer');
    WholemountViewer.setMeasurements(items);
    if (typeof PluginRegistry !== 'undefined') {
      PluginRegistry.setWorkspaceState({ 'measure-distance': { measurements: items } });
    }
  }

  function _prefetchNeighbours() {
    for (const ds of [_neighbour(-1), _neighbour(1)]) {
      if (!ds || ds.id === _id) continue;
      const image = ds.image || {};
      WholemountViewer.prefetch(`DATA_WEB/${ds.path}/${image.preview || 'preview.webp'}`);
      WholemountViewer.prefetch(`DATA_WEB/${ds.path}/${image.native || 'image.webp'}`);
    }
  }

  function _neighbour(delta) {
    const list = _visibleCollection();
    if (!list.length) return null;
    const idx = Math.max(0, list.findIndex(d => d.id === _id));
    return list[(idx + delta + list.length) % list.length];
  }

  function _step(delta) {
    const next = _neighbour(delta);
    if (next && next.id !== _id) _openDataset(next, { history: 'push' });
  }

  function _initExportManager() {
    if (typeof ExportManager === 'undefined') return;
    ExportManager.init({
      dataset: _meta,
      scope: 'viewer',
      getCanvas: () => WholemountViewer.getCanvas(),
      getCanvasBlob: (opts) => WholemountViewer.toBlob(opts),
      getMeasurements: () => MeasurementStore.list(_id, 'viewer'),
      getWorkspaceState: _getWorkspaceState,
      applyWorkspaceState: _applyWorkspaceState
    });
  }

  // ── Header & sidebar ───────────────────────────────────────────────────────
  function _renderHeader() {
    const brand = InstanceConfig.get('brand.name', 'Lumen3D');
    document.title = `${_meta.name || _id} — ${brand}`;
    $('dataset-title').textContent = _meta.name || _id;
    $('dataset-subtitle').textContent = [
      Utils.formatStage(_meta.stage), _meta.line, _meta.staining,
      _meta.acquisition?.dissectionDate ? Utils.formatDate(_meta.acquisition.dissectionDate) : null
    ].filter(Boolean).join(' · ');
  }

  function _renderInfo() {
    const box = $('wm-info');
    box.replaceChildren();
    for (const [label, value] of _infoRows()) {
      if (value == null || value === '') continue;
      box.append(Utils.el('dt', {}, label), Utils.el('dd', {}, String(value)));
    }
  }

  function _infoRows() {
    const acq = _meta.acquisition || {};
    const px = _meta.pixelSizeUm?.x;
    const field = _meta.physicalSizeUm;
    const zoom = acq.zoom ?? acq.zoomNominal;
    return [
      [t('wholemount.stage'), Utils.formatStage(_meta.stage)],
      [t('wholemount.line'), _meta.line],
      [t('wholemount.staining'), _meta.staining],
      [t('wholemount.dissection'), acq.dissectionDate ? Utils.formatDate(acq.dissectionDate) : null],
      [t('wholemount.zoom'), Number.isFinite(zoom) ? `×${zoom.toFixed(2)}` : null],
      [t('wholemount.pixelSize'), px ? `${px.toFixed(3)} µm/px` : t('wholemount.uncalibrated')],
      [t('wholemount.imageSize'), `${_meta.image?.width ?? _meta.dimensions?.x} × ${_meta.image?.height ?? _meta.dimensions?.y} px`],
      [t('wholemount.field'), field?.x ? `${(field.x / 1000).toFixed(2)} × ${(field.y / 1000).toFixed(2)} mm` : null],
      [t('wholemount.microscope'), acq.microscope],
      [t('wholemount.camera'), acq.camera],
      [t('wholemount.exposure'), Number.isFinite(acq.exposureMs) ? `${acq.exposureMs.toFixed(1)} ms` : null],
      [t('wholemount.gain'), Number.isFinite(acq.gain) ? acq.gain.toFixed(1) : null],
      [t('wholemount.source'), acq.sourceFile]
    ];
  }

  function _renderGallery() {
    if (typeof DatasetGallery === 'undefined') return;
    DatasetGallery.init({
      sectionId: 'gallery-section',
      containerId: 'gallery-container',
      basePath: _basePath,
      items: _meta.gallery
    });
  }

  function _renderRelated() {
    const panel = $('related-panel');
    const list = $('related-datasets');
    const related = Catalog.getRelated(_id).filter(d => d.type !== TYPE);
    panel.hidden = related.length === 0;
    list.replaceChildren(...related.map(ds => Utils.el('a', { class: 'related-link', href: Utils.datasetUrl(ds) },
      Utils.el('div', { class: 'related-link-title' }, ds.name || ds.id),
      Utils.el('div', { class: 'related-link-meta' }, `${t(`explorer.${ds.type}`)} · ${Utils.formatStage(ds.stage)}`)
    )));
  }

  function _renderLoadState(state) {
    const pill = $('wm-load-state');
    clearTimeout(_stateTimer);
    pill.hidden = false;
    pill.classList.toggle('is-error', state === 'error');
    if (state === 'native') {
      pill.textContent = t('wholemount.nativeReady');
      _stateTimer = setTimeout(() => { pill.hidden = true; }, LOAD_STATE_LINGER_MS);
      return;
    }
    pill.textContent = t({ loading: 'wholemount.loadingPreview', preview: 'wholemount.loadingNative', error: 'wholemount.loadError' }[state]);
  }

  // Zoom as a percentage of native (one image pixel per device pixel) and the
  // physical size of one screen pixel at that zoom.
  function _renderZoom(view) {
    const px = _meta?.pixelSizeUm?.x;
    const pct = Math.round(view.scale * (window.devicePixelRatio || 1) * 100);
    const perScreenPx = px ? ` · ${(px / view.scale).toFixed(2)} µm/px` : '';
    $('wm-zoom').textContent = `${pct} %${perScreenPx}`;
  }

  // ── Contact-sheet browser ──────────────────────────────────────────────────
  function _sortedCollection() {
    return Catalog.getAll()
      .filter(d => d.type === TYPE)
      .sort((a, b) => (a.stageNumeric || 0) - (b.stageNumeric || 0)
        || String(a.acquisition?.dissectionDate || '').localeCompare(String(b.acquisition?.dissectionDate || ''))
        || String(a.name).localeCompare(String(b.name)));
  }

  function _visibleCollection() {
    const q = _filters.search.trim().toLowerCase();
    return _collection.filter(d =>
      (_filters.stage === 'all' || d.stage === _filters.stage) &&
      (_filters.line === 'all' || d.line === _filters.line) &&
      (!q || [d.name, d.stage, d.line, d.staining, d.description, d.acquisition?.dissectionDate]
        .some(v => String(v || '').toLowerCase().includes(q)))
    );
  }

  function _renderBrowserFilters() {
    _renderChips($('wm-filter-stage'), 'stage', [...new Set(_collection.map(d => d.stage).filter(Boolean))]
      .sort((a, b) => _stageOf(a) - _stageOf(b)), Utils.formatStage);
    _renderChips($('wm-filter-line'), 'line', [...new Set(_collection.map(d => d.line).filter(Boolean))].sort(), s => s);
    _renderBrowserGrid();
  }

  function _stageOf(stage) {
    return _collection.find(d => d.stage === stage)?.stageNumeric || 0;
  }

  function _renderChips(container, key, values, format) {
    const chip = (value, label) => Utils.el('button', {
      type: 'button', class: `wm-chip${_filters[key] === value ? ' is-active' : ''}`,
      'data-filter': key, 'data-value': value
    }, label);
    container.replaceChildren(chip('all', t('wholemount.all')), ...values.map(v => chip(v, format(v))));
    container.parentElement.hidden = values.length < 2;
  }

  function _renderBrowserGrid() {
    const grid = $('wm-grid');
    const visible = _visibleCollection();
    $('wm-count').textContent = t('wholemount.count', { count: visible.length });
    grid.replaceChildren(...visible.map(_browserCard));
    if (!visible.length) grid.append(Utils.el('div', { class: 'wm-empty' }, t('wholemount.noPhotos')));
    _markActiveCard();
  }

  function _browserCard(ds) {
    const image = ds.image || {};
    const zoom = ds.acquisition?.zoom ?? ds.acquisition?.zoomNominal;
    const meta = [
      ds.acquisition?.dissectionDate ? Utils.formatDate(ds.acquisition.dissectionDate) : null,
      Number.isFinite(zoom) ? `×${zoom.toFixed(1)}` : null,
      ds.line
    ].filter(Boolean).join(' · ');
    return Utils.el('button', { type: 'button', class: 'wm-card', 'data-id': ds.id, title: ds.name },
      Utils.el('img', { src: `DATA_WEB/${ds.path}/${image.preview || 'preview.webp'}`, alt: ds.name, decoding: 'async' }),
      Utils.el('div', { class: 'wm-card-body' },
        Utils.el('span', { class: 'badge badge-wholemount' }, Utils.formatStage(ds.stage)),
        Utils.el('div', { class: 'wm-card-name' }, ds.name),
        Utils.el('div', { class: 'wm-card-meta' }, meta)
      ));
  }

  function _markActiveCard() {
    document.querySelectorAll('.wm-card').forEach(card => {
      const active = card.dataset.id === _id;
      card.classList.toggle('is-active', active);
      if (active && !$('wm-browser').hidden) card.scrollIntoView({ block: 'nearest' });
    });
  }

  function _setBrowserOpen(open) {
    $('wm-browser').hidden = !open;
    $('btn-browse').classList.toggle('btn-solid', open);
    $('btn-browse').classList.toggle('btn-ghost', !open);
    if (open) { _markActiveCard(); $('wm-search').focus(); }
  }

  // ── Controls ───────────────────────────────────────────────────────────────
  function _bindControls() {
    $('btn-fit').addEventListener('click', () => WholemountViewer.fit());
    $('btn-native').addEventListener('click', () => WholemountViewer.zoomNative());
    $('btn-isolate').addEventListener('click', () => _setIsolate(!WholemountViewer.isIsolateStain()));
    $('btn-browse').addEventListener('click', () => _setBrowserOpen($('wm-browser').hidden));
    $('btn-browse-close').addEventListener('click', () => _setBrowserOpen(false));
    $('btn-prev').addEventListener('click', () => _step(-1));
    $('btn-next').addEventListener('click', () => _step(1));
    $('btn-collapse-sidebar').addEventListener('click', () => _setSidebarHidden(true));
    $('btn-studio').addEventListener('click', _openStudio);
    $('measure-text-size').addEventListener('input', (e) => WholemountViewer.setMeasurementTextSize(Number(e.target.value)));
    $('toggle-measure-labels').addEventListener('change', (e) => WholemountViewer.setShowMeasurementLabels(e.target.checked));
    $('btn-hamburger').addEventListener('click', () => _setSidebarHidden(false));

    $('wm-search').addEventListener('input', (e) => { _filters.search = e.target.value; _renderBrowserGrid(); });
    $('wm-browser').addEventListener('click', _onBrowserClick);
    document.addEventListener('keydown', _onKey);
    window.addEventListener('popstate', _onPopState);
  }

  function _onBrowserClick(e) {
    const chip = e.target.closest('[data-filter]');
    if (chip) {
      _filters[chip.dataset.filter] = chip.dataset.value;
      _renderBrowserFilters();
      return;
    }
    const card = e.target.closest('.wm-card');
    if (!card) return;
    const ds = Catalog.getById(card.dataset.id);
    if (ds && ds.id !== _id) _openDataset(ds, { history: 'push' });
    _setBrowserOpen(false);
  }

  function _onKey(e) {
    if (e.target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) {
      if (e.key === 'Escape') { e.target.blur(); _setBrowserOpen(false); }
      return;
    }
    const action = {
      ArrowLeft: () => _step(-1),
      ArrowRight: () => _step(1),
      Escape: () => _setBrowserOpen(false),
      b: () => _setBrowserOpen($('wm-browser').hidden),
      f: () => WholemountViewer.fit()
    }[e.key.length === 1 ? e.key.toLowerCase() : e.key];
    if (!action) return;
    e.preventDefault();   // the search box takes focus on open; the key must not land in it
    action();
  }

  function _onPopState() {
    const id = new URLSearchParams(window.location.search).get('id');
    const ds = id ? Catalog.getById(id) : null;
    if (ds && ds.type === TYPE && ds.id !== _id) _openDataset(ds);
  }

  // The Studio annotates the photograph at native resolution; what it gets is
  // exactly what is on screen (plain or stain-isolated), calibrated in µm/px.
  function _openStudio() {
    if (typeof StudioEditor === 'undefined' || !_meta) return;
    const canvas = WholemountViewer.getNativeCanvas();
    if (!canvas) return;
    const px = _meta.pixelSizeUm?.x || 1;
    StudioEditor.open({
      canvas, width: canvas.width, height: canvas.height,
      source: 'wholemount', quality: 'native', timepoint: 0,
      pixelSizeUm: { x: px, y: _meta.pixelSizeUm?.y || px },
      dataset: _meta, channelState: []
    });
  }

  function _setIsolate(on) {
    WholemountViewer.setIsolateStain(on);
    $('btn-isolate').classList.toggle('btn-solid', on);
    $('btn-isolate').classList.toggle('btn-ghost', !on);
  }

  function _setSidebarHidden(hidden) {
    $('viewer-sidebar').classList.toggle('sidebar-hidden', hidden);
    $('btn-hamburger').hidden = !hidden;
  }

  // ── Workspace state ────────────────────────────────────────────────────────
  function _getWorkspaceState() {
    return {
      ui: { sidebarHidden: $('viewer-sidebar').classList.contains('sidebar-hidden') },
      viewer: {
        view: WholemountViewer.getView(),
        isolate: WholemountViewer.isIsolateStain(),
        measureTextSize: WholemountViewer.getMeasurementTextSize(),
        showLabels: $('toggle-measure-labels').checked,
        plugins: typeof PluginRegistry !== 'undefined' ? PluginRegistry.getWorkspaceState() : {}
      }
    };
  }

  function _applyWorkspaceState(state) {
    const v = state?.viewer || {};
    if (v.view) WholemountViewer.setView(v.view);
    if (typeof v.isolate === 'boolean') _setIsolate(v.isolate);
    if (Number.isFinite(v.measureTextSize)) {
      $('measure-text-size').value = v.measureTextSize;
      WholemountViewer.setMeasurementTextSize(v.measureTextSize);
    }
    if (typeof v.showLabels === 'boolean') {
      $('toggle-measure-labels').checked = v.showLabels;
      WholemountViewer.setShowMeasurementLabels(v.showLabels);
    }
    if (v.plugins && typeof PluginRegistry !== 'undefined') PluginRegistry.setWorkspaceState(v.plugins);
    if (typeof state?.ui?.sidebarHidden === 'boolean') _setSidebarHidden(state.ui.sidebarHidden);
  }

  // ── Chrome ─────────────────────────────────────────────────────────────────
  function _updateThemeIcon() {
    const btn = $('theme-toggle');
    if (!btn) return;
    btn.innerHTML = `<i data-lucide="${Theme.isDark() ? 'moon' : 'sun'}" style="width:20px;height:20px"></i>`;
    if (window.lucide) lucide.createIcons({ nodes: [btn] });
  }

  function _showError(message) {
    const loader = $('viewer-loader');
    if (!loader) return;
    loader.classList.remove('hidden');
    loader.replaceChildren(
      Utils.el('i', { 'data-lucide': 'alert-triangle', style: 'width:48px;height:48px;color:var(--color-danger)' }),
      Utils.el('h3', {}, t('wholemount.errorTitle')),
      Utils.el('p', { class: 'text-muted' }, message),
      Utils.el('a', { href: 'explorer.html', class: 'btn btn-primary' }, t('nav.back'))
    );
    if (window.lucide) lucide.createIcons({ nodes: [loader] });
  }

  return { init };
})();

document.addEventListener('DOMContentLoaded', WholemountApp.init);
