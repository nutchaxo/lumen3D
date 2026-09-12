/* ============================================================
   Lumen3D — Comparison page controller
   ============================================================
   Up to four datasets side by side, each one the real viewer page
   (viewer.html for volumes and timelapses, 2d.html for photographs)
   embedded chrome-less in an iframe and driven from here.

   The wire, all same-origin postMessage:
     panel → host   PANEL_READY   the page is mounted; carries what its toolbar
                                  offers (tools / toggles the plugins declared
                                  `contexts: ["panel"]`), its features and quality
                    PANEL_ERROR   the page could not mount its dataset
                    PANEL_DATASET the photograph changed from the pane's own nav
                    PLUGIN_STATE  a toggle lit up / went off (its own button too)
                    TOOL_CHANGED  a tool picked in the page (keyboard shortcut)
                    QUALITY_STATUS a SET_QUALITY settled
                    SYNC_*        camera / channels / exposure / z / time / slicer
                                  plane / z-stack, relayed to the siblings
                    WM_PHYSICAL_VIEW a photograph's physical view (µm per px)
                    SIDEBAR_CLOSED, REQUEST_COMPARE_STUDIO
     host → panel   PANEL_HELLO, SET_TOOL, PLUGIN_ACTIVATE, SET_QUALITY,
                    TOGGLE_SIDEBAR, TOGGLE_ZSTACK, ZSTACK_HOVER_STATE,
                    SET_CHANNEL_ACTIVE, APPLY_WORKSPACE_STATE, the SYNC_* relays,
                    WM_SET_PHYSICAL_VIEW
   ============================================================ */

const CompareApp = (() => {
  const MAX_PANELS = 4;
  const MAX_PARALLEL_PANEL_LOADS = 2;
  const PANEL_READY_TIMEOUT_MS = 180000;
  const QUALITY_TIMEOUT_MS = 180000;
  const INITIAL_PANEL_QUALITY = '512x512';
  const QUALITY_RANK = { '256x256': 0, '512x512': 1, '1024x1024': 2, '2048x2048': 3, '4096x4096': 4, native: 5 };

  let _datasets = [];
  let _panels = [];                // [{ index, id, type, name, el, iframe, ready, … }] in grid order
  let _panelIdCounter = 0;
  let _layoutMode = 'auto';
  let _layoutWeights = {
    columns: [1, 1, 1, 1],
    rows: [1, 1, 1, 1],
    gridColumns: [1, 1],
    gridRows: [1, 1]
  };
  let _resizeNotifyTimer = null;
  let _syncOptions = { z: true, time: true, camera: true, channels: true };
  let _tool = 'navigate';
  let _qualityMode = 'auto';
  // The last relayed view of each kind, replayed to a panel that joins later so
  // it opens where the others are rather than where its own default view sits.
  const _lastSync = {};

  let _loadQueue = [];
  let _activeLoads = 0;
  let _qualityQueue = [];
  let _qualityBusy = null;         // { panel, timer } while one panel reloads

  const _modalFilter = { search: '', type: 'all' };
  // Panels opened from the URL (?add=) are the page's untouched state: the
  // #state= hash is only worth writing once the operator changes something.
  let _initialPending = 0;
  let _restoredFromUrl = false;

  // ── Boot ──────────────────────────────────────────────────

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
    Utils.populateLanguageMenu(window.switchLanguage);
    I18n.onLanguageChange(() => {
      _renderModalList();
      _renderModalTypeChips();
      // The panels follow the language on their own (storage event) and re-describe
      // their toolbar; ask once more a little later for any that were still busy.
      setTimeout(() => _broadcast({ type: 'PANEL_HELLO' }, null), 600);
    });

    _bindToolbar();
    _bindModal();
    _updateLayout();
    _bindExport();
    // Panels answer the host in messages: listen before the first one is added.
    window.addEventListener('message', _handleIframeMessage);

    if (window.lucide) lucide.createIcons();
    if (typeof StudioEditor !== 'undefined') StudioEditor.init();

    let restored = false;
    if (window.location.hash && window.location.hash.startsWith('#state=') && typeof UrlState !== 'undefined') {
      try {
        const urlState = await UrlState.decodeState(window.location.hash);
        if (urlState) {
          _applyWorkspaceState(urlState.state || urlState);
          restored = true;
        }
      } catch (err) {
        // A shared link that no longer applies must not take the page down with it.
        console.warn('[Compare] Shared state could not be restored:', err);
      }
    }
    _restoredFromUrl = restored;
    if (!restored) {
      const params = new URLSearchParams(window.location.search);
      const added = params.getAll('add').slice(0, MAX_PANELS).map(id => _addPanel(id)).filter(Boolean);
      _initialPending = added.length;
    }
    document.addEventListener('keydown', _onKeydown);

    if (typeof UrlState !== 'undefined') {
      UrlState.startSync(_getWorkspaceState, 1000, { pristine: !restored });
    }
  }

  // The chips advertise the panels' shortcuts; honour them here too, so a key
  // pressed on the host's own chrome (a select, a checkbox) reaches every panel.
  function _onKeydown(e) {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;
    if (document.getElementById('modal-select')?.classList.contains('active')) return;
    if (!document.getElementById('studio-layout')?.classList.contains('hidden')) return;
    const key = e.key.toLowerCase();
    if (key === 'escape' || key === 'v') { _setTool('navigate', null); return; }
    const chip = [...document.querySelectorAll('#compare-tool-chips [data-tool][data-shortcut]')]
      .find(b => b.dataset.shortcut === key);
    if (chip) { e.preventDefault(); _setTool(chip.dataset.tool, null); }
  }

  function _bindToolbar() {
    ['z', 'time', 'camera', 'channels'].forEach(key => {
      const cb = document.getElementById(`sync-${key}`);
      if (cb) cb.addEventListener('change', (e) => { _syncOptions[key] = e.target.checked; });
    });

    // Tool chips: navigate is static, the others come and go with the panels.
    document.getElementById('compare-tool-chips')?.addEventListener('click', (e) => {
      const chip = e.target.closest('[data-tool]');
      if (!chip || !chip.dataset.tool) return;
      _setTool(chip.dataset.tool, null);
    });

    document.getElementById('studio-scale-mode')?.addEventListener('change', () => {
      const layout = document.getElementById('studio-layout');
      if (!layout || layout.classList.contains('hidden')) return;
      // The composition is measured on the visible grid: close first (which shows
      // the grid again), then compose anew. The figure starts over; annotations
      // belong to a composition and do not survive a change of scale mode.
      StudioEditor.close();
      _openCompareStudio();
    });

    document.getElementById('btn-decompose')?.addEventListener('click', _decomposeChannels);
    document.getElementById('btn-compare-studio')?.addEventListener('click', () => _openCompareStudio());
    document.getElementById('btn-add-dataset').addEventListener('click', _openModal);
    document.getElementById('compare-layout-mode')?.addEventListener('change', (e) => {
      _layoutMode = e.target.value;
      _updateLayout();
    });
    document.getElementById('compare-quality')?.addEventListener('change', (e) => {
      _qualityMode = e.target.value;
      _scheduleQuality();
    });
  }

  function _bindExport() {
    if (typeof ExportManager === 'undefined') return;
    const ctx = {
      scope: 'compare',
      getWorkspaceState: _getWorkspaceState,
      applyWorkspaceState: _applyWorkspaceState,
      getCustomExports: _getCompareExports
    };
    ExportManager.init(ctx);
    document.getElementById('btn-export-compare')?.addEventListener('click', () => ExportManager.openDownloadCenter(ctx));
    document.getElementById('btn-save-compare-workspace')?.addEventListener('click', () => {
      if (!_getWorkspaceState()) { _toast(_t('compare.notAllReady', 'Wait for every panel to finish loading.')); return; }
      ExportManager.saveWorkspace('compare');
    });
    document.getElementById('btn-restore-compare-workspace')?.addEventListener('click', () => ExportManager.restoreWorkspace('compare'));
  }

  function _updateThemeIcon() {
    const btn = document.getElementById('theme-toggle');
    if (!btn) return;
    const icon = Theme.isDark() ? 'moon' : 'sun';
    btn.innerHTML = `<i data-lucide="${icon}" data-theme-icon></i>`;
    if (window.lucide) lucide.createIcons({ nodes: [btn] });
  }

  // ── Dataset picker ────────────────────────────────────────

  function _bindModal() {
    document.getElementById('btn-close-modal').addEventListener('click', _closeModal);
    document.getElementById('modal-select').addEventListener('click', (e) => {
      if (e.target.id === 'modal-select') _closeModal();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && document.getElementById('modal-select')?.classList.contains('active')) _closeModal();
    });
    document.getElementById('modal-search')?.addEventListener('input', (e) => {
      _modalFilter.search = e.target.value.trim().toLowerCase();
      _renderModalList();
    });
    document.getElementById('modal-type-chips')?.addEventListener('click', (e) => {
      const chip = e.target.closest('[data-type]');
      if (!chip) return;
      _modalFilter.type = chip.dataset.type;
      _renderModalTypeChips();
      _renderModalList();
    });
    document.getElementById('modal-dataset-list').addEventListener('click', (e) => {
      const card = e.target.closest('.dataset-mini-card');
      if (!card) return;
      _addPanel(card.dataset.id);
      _closeModal();
    });
    document.getElementById('modal-dataset-list').addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const card = e.target.closest('.dataset-mini-card');
      if (!card) return;
      e.preventDefault();
      card.click();
    });
    _renderModalTypeChips();
    _renderModalList();
  }

  function _renderModalTypeChips() {
    const host = document.getElementById('modal-type-chips');
    if (!host) return;
    const present = new Set(_datasets.map(d => d.type));
    const chip = (type, label) => `<button type="button" class="modal-type-chip${_modalFilter.type === type ? ' is-active' : ''}" data-type="${Utils.escapeHtml(type)}">${Utils.escapeHtml(label)}</button>`;
    host.innerHTML = chip('all', _t('compare.allTypes', 'All'))
      + Utils.DATASET_TYPES.filter(t => present.has(t)).map(t => chip(t, Utils.datasetTypeLabel(t))).join('');
  }

  function _modalMatches(d) {
    if (_modalFilter.type !== 'all' && d.type !== _modalFilter.type) return false;
    if (!_modalFilter.search) return true;
    const hay = [d.name, d.id, d.stage, d.line, d.description, ...(d.markers || [])].filter(Boolean).join(' ').toLowerCase();
    return hay.includes(_modalFilter.search);
  }

  function _renderModalList() {
    const list = document.getElementById('modal-dataset-list');
    if (!list) return;
    const shown = _datasets.filter(_modalMatches);
    if (!shown.length) {
      list.innerHTML = `<div class="modal-empty">${Utils.escapeHtml(_t('compare.noMatch', 'No dataset matches.'))}</div>`;
      return;
    }
    // SEC-014: dataset fields are catalog data — escaped before innerHTML. The
    // type pill takes the shared badge class and the operator's own type name.
    list.innerHTML = shown.map(d => `
      <div class="dataset-mini-card" data-id="${Utils.escapeHtml(d.id)}" role="button" tabindex="0">
        ${d.thumbnail ? `<img src="${Utils.escapeHtml(d.thumbnail)}" alt="" loading="lazy" decoding="async">` : ''}
        <span class="card-type ${Utils.datasetTypeBadgeClass(d.type)}">${Utils.escapeHtml(Utils.datasetTypeLabel(d.type))}</span>
        <div class="font-bold text-sm mt-1">${Utils.escapeHtml(d.name)}</div>
        <div class="text-xs text-muted mt-1">${Utils.escapeHtml(Utils.formatStage(d.stage))}</div>
      </div>
    `).join('');
  }

  function _openModal() {
    if (_panels.length >= MAX_PANELS) {
      _toast(_t('toast.maxPanels', `Maximum of ${MAX_PANELS} panels reached.`, { count: MAX_PANELS }));
      return;
    }
    document.getElementById('modal-select').classList.add('active');
    document.getElementById('modal-search')?.focus();
  }

  function _closeModal() {
    document.getElementById('modal-select').classList.remove('active');
  }

  // ── Panels ────────────────────────────────────────────────

  function _panelByIndex(index) {
    const wanted = String(index);
    return _panels.find(p => String(p.index) === wanted) || null;
  }

  function _panelSrc(dataset, index) {
    const page = Utils.datasetPage(dataset);
    const params = new URLSearchParams({ id: dataset.id, hideHeader: 'true', panelIndex: String(index) });
    if (dataset.type !== '2d') params.set('quality', INITIAL_PANEL_QUALITY);
    return `${page}?${params.toString()}`;
  }

  /**
   * @param {string} datasetId
   * @param {Object} [restore]  state to hand the panel once it loads (workspace restore)
   */
  function _addPanel(datasetId, restore = null) {
    if (_panels.length >= MAX_PANELS) return null;
    const d = Catalog.getById(datasetId);
    if (!d) {
      console.warn('[Compare] Unknown dataset, panel not added:', datasetId);
      _toast(_t('compare.unknownDataset', 'Dataset "{id}" is not in the catalog.', { id: datasetId }));
      return null;
    }
    const index = _panelIdCounter++;
    const panel = {
      index, id: d.id, type: d.type, name: d.name || d.id,
      el: null, iframe: null,
      ready: false, failed: false, readyResolve: null,
      toolbar: { tools: [], toggles: [] }, features: {}, quality: null,
      pendingState: restore?.state || null,
      pendingZstack: restore?.zstack || null,
      soloChannel: Number.isInteger(restore?.soloChannel) ? restore.soloChannel : null,
      zstackActive: false,
      timers: new Set()
    };
    _panels.push(panel);

    const el = document.createElement('div');
    el.className = 'compare-panel animate-scale-in';
    el.id = `panel-${index}`;
    // data-panel-type, not data-dataset-type: InstanceConfig.applyDom binds the latter
    // to the type's display name and would overwrite the whole panel on a language switch.
    el.dataset.panelType = d.type;
    el.innerHTML = `
      <div class="panel-header">
        <div class="panel-title-badge" title="${Utils.escapeHtml(panel.name)}">${Utils.escapeHtml(panel.name)}</div>
        <div class="panel-actions">
          <div class="panel-toggles" data-index="${index}"></div>
          <button class="btn btn-outline btn-sm bg-surface p-1 btn-settings" data-index="${index}" title="${Utils.escapeHtml(_t('js.toggleSettings', 'Toggle Settings'))}" data-i18n-title="js.toggleSettings">
            <i data-lucide="settings" class="w-4 h-4"></i>
          </button>
          <button class="btn btn-outline btn-sm bg-surface p-1 btn-close-panel" data-index="${index}" title="${Utils.escapeHtml(_t('js.closePanel', 'Close'))}" data-i18n-title="js.closePanel">
            <i data-lucide="x" class="w-4 h-4"></i>
          </button>
        </div>
      </div>
      <div class="panel-content">
        <iframe src="about:blank" class="viewer-frame" id="iframe-${index}" data-index="${index}" title="${Utils.escapeHtml(panel.name)}"></iframe>
        <div class="panel-load-state" data-index="${index}"><i data-lucide="loader-2" class="animate-spin"></i><span>${Utils.escapeHtml(_t('compare.panelQueued', 'Waiting for a load slot…'))}</span></div>
      </div>
    `;
    document.getElementById('compare-grid').appendChild(el);
    if (window.lucide) lucide.createIcons({ nodes: [el] });

    panel.el = el;
    panel.iframe = el.querySelector('iframe.viewer-frame');
    panel.iframe.dataset.src = _panelSrc(d, index);

    el.querySelector('.btn-close-panel').addEventListener('click', () => _removePanel(index));
    el.querySelector('.btn-settings').addEventListener('click', () => _toggleSidebar(index));
    el.querySelector('.panel-toggles').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-plugin]');
      if (!btn) return;
      _postTo(panel, { type: 'PLUGIN_ACTIVATE', id: btn.dataset.plugin });
    });
    // The z-stack browser folds away while the pointer is elsewhere.
    el.addEventListener('mouseenter', () => { if (panel.zstackActive) _postTo(panel, { type: 'ZSTACK_HOVER_STATE', state: true }); });
    el.addEventListener('mouseleave', () => { if (panel.zstackActive) _postTo(panel, { type: 'ZSTACK_HOVER_STATE', state: false }); });

    _updateLayout();
    _queuePanelLoad(panel);
    return panel;
  }

  function _removePanel(index) {
    const panel = _panelByIndex(index);
    if (!panel) return;
    panel.timers.forEach(t => clearTimeout(t));
    panel.timers.clear();
    panel.readyResolve?.(false);
    _panels = _panels.filter(p => p !== panel);
    _loadQueue = _loadQueue.filter(p => p !== panel);
    _qualityQueue = _qualityQueue.filter(p => p !== panel);
    if (_qualityBusy?.panel === panel) _finishQuality();
    // Navigating the frame away tears its document down at once (WebGL context,
    // decode workers, in-flight pack fetches); a detached iframe only goes when
    // the browser gets round to collecting it.
    try { if (panel.iframe) panel.iframe.src = 'about:blank'; } catch (_) { /* frame already gone */ }
    panel.el?.remove();
    if (!_panels.some(p => p.ready && p.toolbar.tools.some(t => t.tool === _tool))) _setTool('navigate', null);
    _renderToolChips();
    _updateActionButtons();
    _updateLayout();
    _scheduleQuality();
  }

  function _setTimer(panel, fn, ms) {
    const t = setTimeout(() => { panel.timers.delete(t); fn(); }, ms);
    panel.timers.add(t);
    return t;
  }

  // ── Loading ───────────────────────────────────────────────

  function _queuePanelLoad(panel) {
    if (_loadQueue.includes(panel)) return;
    _loadQueue.push(panel);
    _drainLoadQueue();
  }

  function _drainLoadQueue() {
    while (_activeLoads < MAX_PARALLEL_PANEL_LOADS && _loadQueue.length) {
      const panel = _loadQueue.shift();
      if (!panel.iframe?.dataset.src) continue;
      _activeLoads++;
      _loadPanelFrame(panel)
        .catch(err => console.warn('[Compare] Panel load did not finish cleanly:', err))
        .finally(() => {
          _activeLoads = Math.max(0, _activeLoads - 1);
          _drainLoadQueue();
        });
    }
  }

  async function _loadPanelFrame(panel) {
    const iframe = panel.iframe;
    if (!iframe?.dataset.src) return;
    const src = iframe.dataset.src;
    delete iframe.dataset.src;
    // A restored workspace goes down as soon as the document exists: the viewer
    // buffers it and skips its initial camera fit, so the saved camera is not
    // fought over by the first frame (both pages keep a module-level listener).
    iframe.addEventListener('load', () => {
      if (panel.pendingState && iframe.contentWindow) {
        _postTo(panel, { type: 'APPLY_WORKSPACE_STATE', state: panel.pendingState });
        panel.restored = true;
        panel.pendingState = null;
      }
    }, { once: true });
    _showPanelLoadState(panel, _t('compare.panelLoading', 'Loading…'));
    iframe.src = src;
    await _waitForPanelReady(panel);
    _notifyFramesResize();
  }

  function _showPanelLoadState(panel, text) {
    const node = panel.el?.querySelector('.panel-load-state');
    if (!node) return;
    if (!text) { node.hidden = true; return; }
    node.hidden = false;
    const span = node.querySelector('span');
    if (span) span.textContent = text;
  }

  function _waitForPanelReady(panel) {
    if (panel.ready || panel.failed) return Promise.resolve(panel.ready);
    return new Promise(resolve => {
      panel.readyResolve = resolve;
      _setTimer(panel, () => {
        if (!panel.ready && !panel.failed) {
          console.warn(`[Compare] Panel ${panel.index} gave no PANEL_READY within ${PANEL_READY_TIMEOUT_MS / 1000} s.`);
          resolve(false);
        }
      }, PANEL_READY_TIMEOUT_MS);
    });
  }

  function _onPanelReady(panel, data) {
    const first = !panel.ready;
    panel.ready = true;
    panel.failed = false;
    panel.toolbar = {
      tools: Array.isArray(data.toolbar?.tools) ? data.toolbar.tools : [],
      toggles: Array.isArray(data.toolbar?.toggles) ? data.toolbar.toggles : []
    };
    panel.features = data.features || {};
    panel.quality = data.quality || panel.quality;
    if (data.name) _setPanelTitle(panel, data.name);
    if (data.datasetType) { panel.type = data.datasetType; panel.el.dataset.panelType = data.datasetType; }
    _renderPanelToggles(panel);
    _renderToolChips();
    _updateActionButtons();
    _showPanelLoadState(panel, null);
    if (!first) return;

    // The host's state, now that the page listens: tool, then whatever a restore
    // or a decomposition had reserved for it, then the view the others share.
    _postTo(panel, { type: 'SET_TOOL', tool: _tool });
    if (panel.pendingZstack) {
      _postTo(panel, { type: 'TOGGLE_ZSTACK', state: true, slice: panel.pendingZstack.slice ?? null });
      panel.pendingZstack = null;
    }
    if (panel.soloChannel !== null) _postTo(panel, { type: 'SET_CHANNEL_ACTIVE', channelIndex: panel.soloChannel });
    if (!panel.restored) _replayLastSync(panel);
    panel.readyResolve?.(true);
    panel.readyResolve = null;
    _scheduleQuality();
    // The panels the URL asked for are the page's untouched state.
    if (_initialPending > 0 && --_initialPending === 0 && !_restoredFromUrl && typeof UrlState !== 'undefined') {
      UrlState.rebaseline({ settleMs: 800 });
    }
  }

  /** What the siblings currently share, pushed to a panel that joins late. */
  function _replayLastSync(panel) {
    const volume = Boolean(panel.features.volume);
    if (_syncOptions.camera) {
      if (volume && _lastSync.SYNC_CAMERA) _postTo(panel, _lastSync.SYNC_CAMERA);
      if (panel.features.photo && _lastSync.WM_PHYSICAL_VIEW) _postTo(panel, { type: 'WM_SET_PHYSICAL_VIEW', view: _lastSync.WM_PHYSICAL_VIEW.view });
    }
    if (_syncOptions.time && panel.features.timeline && _lastSync.SYNC_TIME) _postTo(panel, _lastSync.SYNC_TIME);
    if (!volume) return;
    if (_syncOptions.channels) {
      Object.values(_lastSync.channels || {}).forEach(msg => _postTo(panel, msg));
      if (_lastSync.SYNC_EXPOSURE) _postTo(panel, _lastSync.SYNC_EXPOSURE);
    }
    if (_syncOptions.z) {
      if (_lastSync.SYNC_SLICER_SPEC) _postTo(panel, _lastSync.SYNC_SLICER_SPEC);
      if (_lastSync.SYNC_Z) _postTo(panel, _lastSync.SYNC_Z);
      if (_lastSync.SYNC_ZSTACK_SLICE && _lastSync.SYNC_ZSTACK_SLICE.mode !== 'off') {
        _postTo(panel, _lastSync.SYNC_ZSTACK_SLICE);
        panel.zstackActive = true;
      }
    }
  }

  function _onPanelError(panel, message) {
    console.warn(`[Compare] Panel ${panel.index} (${panel.id}) reported an error: ${message}`);
    if (panel.ready) return;   // the volume already on screen is intact
    panel.failed = true;
    _showPanelLoadState(panel, _t('compare.panelFailed', 'Could not load this dataset.'));
    panel.readyResolve?.(false);
    panel.readyResolve = null;
    _updateActionButtons();
  }

  function _setPanelTitle(panel, name) {
    panel.name = name;
    const badge = panel.el?.querySelector('.panel-title-badge');
    if (badge) { badge.textContent = name; badge.title = name; }
    if (panel.iframe) panel.iframe.title = name;
  }

  // ── Per-panel toggles (the panel's own toolbar, drawn here) ──

  function _renderPanelToggles(panel) {
    const host = panel.el?.querySelector('.panel-toggles');
    if (!host) return;
    const toggles = [...panel.toolbar.toggles].sort((a, b) => (a.order - b.order) || String(a.id).localeCompare(String(b.id)));
    host.innerHTML = toggles.map(t => `
      <button type="button" class="panel-tool-btn ${t.active ? 'btn-solid' : 'btn-ghost'}" data-plugin="${Utils.escapeHtml(t.id)}" title="${Utils.escapeHtml(t.title || t.id)}" aria-label="${Utils.escapeHtml(t.title || t.id)}" aria-pressed="${t.active ? 'true' : 'false'}">
        <i data-lucide="${Utils.escapeHtml(t.icon || 'square')}"></i>
      </button>`).join('');
    if (window.lucide) lucide.createIcons({ nodes: [host] });
    panel.zstackActive = toggles.some(t => t.id === 'zstack-browser' && t.active);
  }

  function _onPluginState(panel, data) {
    const toggle = panel.toolbar.toggles.find(t => t.id === data.id);
    if (toggle) {
      if (typeof data.active === 'boolean') toggle.active = data.active;
      if (data.icon) toggle.icon = data.icon;
    }
    if (data.id === 'zstack-browser' && typeof data.active === 'boolean') panel.zstackActive = data.active;
    const sel = window.CSS && CSS.escape ? CSS.escape(String(data.id)) : String(data.id);
    const btn = panel.el?.querySelector(`.panel-toggles [data-plugin="${sel}"]`);
    if (!btn) return;
    if (typeof data.active === 'boolean') {
      btn.classList.toggle('btn-solid', data.active);
      btn.classList.toggle('btn-ghost', !data.active);
      btn.setAttribute('aria-pressed', data.active ? 'true' : 'false');
    }
    if (data.icon) {
      btn.innerHTML = `<i data-lucide="${Utils.escapeHtml(data.icon)}"></i>`;
      if (window.lucide) lucide.createIcons({ nodes: [btn] });
    }
  }

  // ── Tools (one for every panel) ───────────────────────────

  function _renderToolChips() {
    const host = document.getElementById('compare-tool-chips');
    if (!host) return;
    host.querySelectorAll('[data-plugin-generated]').forEach(n => n.remove());
    const byTool = new Map();
    _panels.filter(p => p.ready).forEach(p => p.toolbar.tools.forEach(t => {
      if (!t?.tool || byTool.has(t.tool)) return;
      byTool.set(t.tool, t);
    }));
    [...byTool.values()].sort((a, b) => (a.order - b.order) || String(a.tool).localeCompare(String(b.tool))).forEach(t => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn btn-icon btn-ghost tool-chip';
      btn.dataset.tool = t.tool;
      btn.dataset.pluginGenerated = '1';
      if (t.shortcut) btn.dataset.shortcut = String(t.shortcut).toLowerCase();
      const title = t.shortcut ? `${t.title} (${String(t.shortcut).toUpperCase()})` : t.title;
      btn.title = title;
      btn.setAttribute('aria-label', t.title);
      const icon = document.createElement('i');
      icon.setAttribute('data-lucide', t.icon || 'square');
      btn.appendChild(icon);
      host.appendChild(btn);
    });
    if (window.lucide) lucide.createIcons({ nodes: [host] });
    _syncToolChips();
  }

  function _syncToolChips() {
    document.querySelectorAll('#compare-tool-chips [data-tool]').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.tool === _tool);
    });
  }

  /** @param {number|null} fromIndex  the panel that picked it itself, spared the echo */
  function _setTool(tool, fromIndex) {
    _tool = tool || 'navigate';
    _syncToolChips();
    _broadcast({ type: 'SET_TOOL', tool: _tool }, fromIndex);
  }

  function _updateActionButtons() {
    const ready = _panels.filter(p => p.ready);
    const decompose = document.getElementById('btn-decompose');
    if (decompose) {
      const only = _panels.length === 1 ? _panels[0] : null;
      decompose.hidden = !(only && only.ready && only.features.volume && Number(only.features.channels) > 1);
    }
    const studio = document.getElementById('btn-compare-studio');
    if (studio) studio.disabled = ready.length === 0;
  }

  // ── Quality (volume panels) ───────────────────────────────

  function _qualityTarget() {
    if (_qualityMode !== 'auto') return _qualityMode;
    // Every volume panel counts, ready or not: four bricked volumes at 1024 would
    // not fit the GPU budget, so a burst of additions (Decompose) settles at 512
    // from the first panel instead of raising the early ones and not the late ones.
    const volumes = _panels.filter(p => p.type !== '2d').length;
    return volumes <= 2 ? '1024x1024' : '512x512';
  }

  /** Reload the volume panels one at a time towards the target quality; in auto
   *  mode a panel is only ever raised, never brought back down. */
  function _scheduleQuality() {
    const target = _qualityTarget();
    const rank = (q) => (q in QUALITY_RANK ? QUALITY_RANK[q] : -1);
    _panels.forEach(panel => {
      if (!panel.ready || !panel.features.volume || !panel.quality) return;
      const wanted = _qualityMode === 'auto' ? rank(panel.quality) < rank(target) : panel.quality !== target;
      if (!wanted) { _qualityQueue = _qualityQueue.filter(p => p !== panel); return; }
      if (_qualityBusy?.panel === panel || _qualityQueue.includes(panel)) return;
      _qualityQueue.push(panel);
    });
    _drainQualityQueue();
  }

  function _drainQualityQueue() {
    if (_qualityBusy || !_qualityQueue.length) return;
    const panel = _qualityQueue.shift();
    const target = _qualityTarget();
    _qualityBusy = { panel, target, timer: null };
    _qualityBusy.timer = _setTimer(panel, () => {
      console.warn(`[Compare] Panel ${panel.index} did not settle at ${target} within ${QUALITY_TIMEOUT_MS / 1000} s.`);
      _finishQuality();
    }, QUALITY_TIMEOUT_MS);
    _postTo(panel, { type: 'SET_QUALITY', quality: target });
  }

  function _finishQuality() {
    if (_qualityBusy) {
      const { panel, timer } = _qualityBusy;
      if (timer) { clearTimeout(timer); panel.timers.delete(timer); }
    }
    _qualityBusy = null;
    _drainQualityQueue();
  }

  function _onQualityStatus(panel, data) {
    // On an error the page reverted to what it had; the recorded quality stays.
    if (data.phase === 'ready' && data.quality) panel.quality = data.quality;
    if (_qualityBusy?.panel === panel) _finishQuality();
  }

  // ── Sidebar ───────────────────────────────────────────────

  function _toggleSidebar(index) {
    _panels.forEach(panel => {
      const btn = panel.el?.querySelector('.btn-settings');
      const isTarget = String(panel.index) === String(index);
      const next = isTarget && btn ? !btn.classList.contains('active') : false;
      if (btn) btn.classList.toggle('active', next);
      _postTo(panel, { type: 'TOGGLE_SIDEBAR', value: next });
    });
  }

  // ── Layout ────────────────────────────────────────────────

  function _updateLayout() {
    const grid = document.getElementById('compare-grid');
    const emptyState = document.getElementById('empty-state');
    const count = _panels.length;

    grid.className = `compare-grid layout-${count}`;
    grid.classList.toggle('layout-custom', _layoutMode !== 'auto');
    // The empty-state node is the grid's first child, so CSS cannot see which
    // panel is first: mark it.
    _panels.forEach((panel, i) => { if (panel.el) panel.el.toggleAttribute('data-first', i === 0); });
    _applyGridTemplates();

    emptyState.style.display = count === 0 ? 'flex' : 'none';
    document.getElementById('btn-add-dataset').disabled = count >= MAX_PANELS;
    _updateActionButtons();

    _renderSplitHandles();
    _notifyFramesResize();
  }

  function _getLayoutAxes() {
    const count = _panels.length;
    if (count <= 1 || _layoutMode === 'auto') return null;
    if (_layoutMode === 'columns') return { columns: count, rows: 1, columnKey: 'columns', rowKey: null };
    if (_layoutMode === 'rows') return { columns: 1, rows: count, columnKey: null, rowKey: 'rows' };
    const columns = Math.ceil(Math.sqrt(count));
    const rows = Math.ceil(count / columns);
    return { columns, rows, columnKey: 'gridColumns', rowKey: 'gridRows' };
  }

  function _applyGridTemplates() {
    const grid = document.getElementById('compare-grid');
    const count = _panels.length;
    grid.style.gridTemplateColumns = '';
    grid.style.gridTemplateRows = '';

    const axes = _getLayoutAxes();
    if (!axes) return;

    grid.style.gridTemplateColumns = axes.columns > 1 && axes.columnKey
      ? _weightsTemplate(axes.columnKey, axes.columns) : 'minmax(0, 1fr)';
    grid.style.gridTemplateRows = axes.rows > 1 && axes.rowKey
      ? _weightsTemplate(axes.rowKey, axes.rows) : 'minmax(0, 1fr)';

    if (count > 1 && _layoutMode === 'grid') grid.classList.add('layout-custom');
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
      for (let i = 0; i < axes.columns - 1; i++) grid.appendChild(_createSplitHandle('vertical', axes.columnKey, i));
    }
    if (axes.rows > 1 && axes.rowKey) {
      for (let i = 0; i < axes.rows - 1; i++) grid.appendChild(_createSplitHandle('horizontal', axes.rowKey, i));
    }
    _positionSplitHandles();
  }

  function _createSplitHandle(orientation, key, index) {
    const handle = document.createElement('div');
    handle.className = `compare-split-handle ${orientation}`;
    handle.dataset.weightKey = key;
    handle.dataset.index = String(index);
    handle.title = orientation === 'vertical'
      ? _t('compare.resizeCols', 'Drag to resize columns')
      : _t('compare.resizeRows', 'Drag to resize rows');
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
      _panels.forEach(panel => {
        try {
          panel.iframe?.contentWindow?.dispatchEvent(new Event('resize'));
        } catch (err) {
          // Same-origin iframes should be reachable; ignore a browser edge case.
        }
      });
    }, 80);
  }

  // ── Messages ──────────────────────────────────────────────

  function _postTo(panel, message) {
    const win = panel?.iframe?.contentWindow;
    if (!win) return;
    // SEC-012: the panels are this page's own same-origin frames — never '*'.
    try { win.postMessage(message, Utils.trustedTargetOrigin()); } catch (_) { /* frame mid-navigation */ }
  }

  function _broadcast(message, skipIndex) {
    _panels.forEach(panel => {
      if (skipIndex != null && String(panel.index) === String(skipIndex)) return;
      _postTo(panel, message);
    });
  }

  function _handleIframeMessage(event) {
    if (!Utils.isTrustedMessageOrigin(event)) return;
    const data = event.data;
    if (!data || typeof data.type !== 'string' || data.sourceIndex == null) return;
    const panel = _panelByIndex(data.sourceIndex);
    if (!panel) return;
    // Only the frame we mounted at that index speaks for it — not a frame nested
    // inside another panel that happens to carry the same index.
    if (event.source && panel.iframe?.contentWindow && event.source !== panel.iframe.contentWindow) return;

    switch (data.type) {
      case 'PANEL_READY': _onPanelReady(panel, data); break;
      case 'PANEL_ERROR': _onPanelError(panel, data.message); break;
      case 'PANEL_DATASET':
        if (data.id) panel.id = data.id;
        if (data.datasetType) panel.type = data.datasetType;
        if (data.name) _setPanelTitle(panel, data.name);
        break;
      case 'PLUGIN_STATE': _onPluginState(panel, data); break;
      case 'TOOL_CHANGED': if (data.tool && data.tool !== _tool) _setTool(data.tool, panel.index); break;
      case 'QUALITY_STATUS': _onQualityStatus(panel, data); break;
      case 'SYNC_CAMERA':
        if (!_syncOptions.camera) break;
        _lastSync.SYNC_CAMERA = data;
        _broadcast(data, panel.index);
        break;
      case 'WM_PHYSICAL_VIEW':
        // Photographs share a PHYSICAL view (µm per screen pixel + physical centre):
        // the same field at the same magnification whatever their pixel sizes.
        if (!_syncOptions.camera) break;
        _lastSync.WM_PHYSICAL_VIEW = data;
        _broadcast({ type: 'WM_SET_PHYSICAL_VIEW', view: data.view }, panel.index);
        break;
      case 'SYNC_TIME':
        if (!_syncOptions.time) break;
        _lastSync.SYNC_TIME = data;
        _broadcast(data, panel.index);
        break;
      case 'SYNC_CHANNELS':
        if (!_syncOptions.channels) break;
        _lastSync.channels = _lastSync.channels || {};
        if (data.value?.name) _lastSync.channels[data.value.name] = data;
        _broadcast(data, panel.index);
        break;
      case 'SYNC_EXPOSURE':
        if (!_syncOptions.channels) break;
        _lastSync.SYNC_EXPOSURE = data;
        _broadcast(data, panel.index);
        break;
      case 'SYNC_Z':
      case 'SYNC_ZSTACK_SLICE':
      case 'SYNC_SLICER_SPEC':
        if (!_syncOptions.z) break;
        _lastSync[data.type] = data;
        _broadcast(data, panel.index);
        break;
      case 'SIDEBAR_CLOSED': {
        const btn = panel.el?.querySelector('.btn-settings');
        if (btn) btn.classList.remove('active');
        break;
      }
      case 'REQUEST_COMPARE_STUDIO': _openCompareStudio(); break;
      default: break;
    }
  }

  // ── Decompose by channel ──────────────────────────────────

  function _decomposeChannels() {
    if (_panels.length !== 1) return;
    const panel = _panels[0];
    const app = panel.iframe?.contentWindow?.ViewerApp;
    let channels = [];
    try { channels = app?.getChannelState?.() || []; } catch (_) { channels = []; }
    if (channels.length <= 1) {
      _toast(_t('toast.noMultiChannel', 'Dataset does not have multiple channels to decompose.'));
      return;
    }

    // Each panel shows a different channel: the channel sync would undo that.
    const syncCb = document.getElementById('sync-channels');
    if (syncCb) { syncCb.checked = false; _syncOptions.channels = false; }

    panel.soloChannel = 0;
    _postTo(panel, { type: 'SET_CHANNEL_ACTIVE', channelIndex: 0 });

    const extra = Math.min(MAX_PANELS - 1, channels.length - 1);
    for (let i = 0; i < extra; i++) _addPanel(panel.id, { soloChannel: i + 1 });
    if (channels.length - 1 > extra) {
      _toast(_t('compare.channelsDropped', '{count} channel(s) left out: at most {max} panels.', { count: channels.length - 1 - extra, max: MAX_PANELS }));
    }
  }

  // ── Studio ────────────────────────────────────────────────

  function _panelSliceResult(panel) {
    const win = panel.iframe?.contentWindow;
    if (!win) return null;
    try {
      if (win.App2D?.getStudioSliceResult) return win.App2D.getStudioSliceResult();
      if (win.ViewerApp?.getCurrentSliceResult) return win.ViewerApp.getCurrentSliceResult();
    } catch (err) {
      console.warn('[Compare] Panel unavailable for the Studio', panel.index, err);
    }
    return null;
  }

  async function _openCompareStudio() {
    const grid = document.getElementById('compare-grid');
    if (!grid || typeof StudioEditor === 'undefined') return;
    const physical = document.getElementById('studio-scale-mode')?.value === 'physical';

    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));

    // ── 1. Collect slice data + names WHILE the layout is still visible ──
    const gridRect = grid.getBoundingClientRect();
    const entries = [];
    _panels.forEach(panel => {
      if (!panel.ready) return;
      const sr = _panelSliceResult(panel);
      if (!sr?.canvas) return;
      const rect = panel.el.getBoundingClientRect();
      entries.push({
        sr, panel, datasetName: panel.name,
        cx: rect.left + rect.width / 2 - gridRect.left,
        cy: rect.top + rect.height / 2 - gridRect.top
      });
    });
    if (!entries.length) {
      _toast(_t('compare.figureNotReady', 'No panel is ready for the Studio yet.'));
      return;
    }

    // ── 2. Hide the compare layout ──
    document.querySelector('.compare-layout')?.classList.add('hidden');

    // ── 3. Grid structure (cols × rows) from the panel positions ──
    const GAP = 6;
    const tolerance = gridRect.height * 0.15;
    const sorted = [...entries].sort((a, b) => a.cy - b.cy);
    const rows = [];
    sorted.forEach(entry => {
      const lastRow = rows[rows.length - 1];
      if (lastRow && Math.abs(entry.cy - lastRow[0].cy) < tolerance) lastRow.push(entry);
      else rows.push([entry]);
    });
    rows.forEach(row => row.sort((a, b) => a.cx - b.cx));
    const nRows = rows.length;
    const nCols = Math.max(...rows.map(r => r.length));

    // ── 4. Cell size ──
    // Visual size: every slice fits the same cell. Physical scale: every slice is
    // drawn at ONE µm per canvas pixel — the coarsest of the set, so nothing is
    // upsampled — and the cell is the largest physical footprint; a scale bar is
    // then true for every panel at once.
    // A photograph without a calibration cannot take part in the physical scale:
    // it is drawn at its visual size and its cell says so.
    const calibrated = (e) => Number.isFinite(Number(e.sr.pixelSizeUm?.x)) && Number(e.sr.pixelSizeUm.x) > 0;
    const pxOf = (e) => Math.max(1e-9, Number(e.sr.pixelSizeUm?.x) || 1);
    const calibratedEntries = entries.filter(calibrated);
    const targetUmPerPx = physical && calibratedEntries.length ? Math.max(...calibratedEntries.map(pxOf)) : null;
    const drawSize = (e) => {
      const srcW = e.sr.canvas.width, srcH = e.sr.canvas.height;
      if (!physical || !targetUmPerPx || !calibrated(e)) return { w: srcW, h: srcH };
      const k = pxOf(e) / targetUmPerPx;
      return { w: Math.max(1, Math.round(srcW * k)), h: Math.max(1, Math.round(srcH * k)) };
    };
    let maxSliceW = 0, maxSliceH = 0;
    entries.forEach(e => {
      const s = drawSize(e);
      maxSliceW = Math.max(maxSliceW, s.w);
      maxSliceH = Math.max(maxSliceH, s.h);
    });

    const MAX_CANVAS = 8192;
    const baseLabelH = Math.max(48, Math.round(maxSliceH * 0.04));
    const baseResLabelH = Math.max(28, Math.round(maxSliceH * 0.035));
    const neededW = nCols * maxSliceW + (nCols - 1) * GAP;
    const neededH = nRows * (maxSliceH + baseLabelH + baseResLabelH) + (nRows - 1) * GAP;
    const canvasScale = Math.min(1, MAX_CANVAS / Math.max(neededW, neededH));

    const cellW = Math.round(maxSliceW * canvasScale);
    const cellH = Math.round(maxSliceH * canvasScale);
    const labelH = Math.round(baseLabelH * canvasScale);
    const resLabelH = Math.round(baseResLabelH * canvasScale);

    // ── 5. Compose ──
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
    const combinedChannelState = [];
    let firstPixelSizeUm = { x: 1, y: 1 };

    rows.forEach((row, ri) => {
      row.forEach((entry, ci) => {
        const srcW = entry.sr.canvas.width;
        const srcH = entry.sr.canvas.height;
        const cellX = ci * (cellW + GAP);
        const cellTopY = ri * (cellH + labelH + resLabelH + GAP);

        // Label header: dataset name, left-aligned, truncated to the cell
        const fontSize = Math.max(12, Math.round(labelH * 0.45));
        ctx.save();
        ctx.fillStyle = dark ? 'rgba(255,255,255,0.85)' : 'rgba(15,23,42,0.85)';
        ctx.font = `600 ${fontSize}px Inter, Arial, sans-serif`;
        ctx.textBaseline = 'middle';
        const charWidthEst = fontSize * 0.6;
        const maxChars = Math.max(10, Math.floor((cellW - 100) / charWidthEst));
        const fullName = calibrated(entry) ? entry.datasetName : `${entry.datasetName} — ${_t('compare.uncalibrated', 'uncalibrated')}`;
        const nameText = fullName.length > maxChars ? fullName.slice(0, maxChars - 3) + '...' : fullName;
        ctx.textAlign = 'left';
        ctx.fillText(nameText, cellX + 4, cellTopY + labelH / 2);
        ctx.restore();

        // The slice, aspect preserved, centred in its cell
        const drawY = cellTopY + labelH;
        const size = drawSize(entry);
        const scaleToFit = Math.min(cellW / size.w, cellH / size.h, physical ? canvasScale : Infinity);
        const drawW = Math.max(1, Math.round(size.w * scaleToFit));
        const drawH = Math.max(1, Math.round(size.h * scaleToFit));
        const offsetX = Math.round((cellW - drawW) / 2);
        const offsetY = Math.round((cellH - drawH) / 2);
        ctx.drawImage(entry.sr.canvas, cellX + offsetX, drawY + offsetY, drawW, drawH);

        // Resolution, below the cell
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

        // The calibration of THIS rectangle of the composite: source µm/px scaled
        // by how much the source was shrunk to fit — what a scale bar dropped on
        // this panel reads.
        const pxUm = entry.sr.pixelSizeUm || { x: 1, y: 1 };
        const scaledPixelSizeUm = { x: (pxUm.x || 1) * (srcW / drawW), y: (pxUm.y || pxUm.x || 1) * (srcH / drawH) };
        if (layoutMaps.length === 0) firstPixelSizeUm = scaledPixelSizeUm;

        layoutMaps.push({
          x: cellX + offsetX, y: drawY + offsetY, w: drawW, h: drawH,
          pixelSizeUm: scaledPixelSizeUm,
          calibrated: calibrated(entry),
          channelState: entry.sr.channelState || [],
          raw: entry.sr.raw || null,
          sourceWidth: srcW,
          sourceHeight: srcH,
          iframe: entry.panel.iframe,
          sliceResult: entry.sr
        });
        if (entry.sr.channelState) combinedChannelState.push(...entry.sr.channelState);
      });
    });

    // ── 6. Open ──
    StudioEditor.open({
      canvas, width: canvasW, height: canvasH,
      source: 'compare',
      pixelSizeUm: firstPixelSizeUm,
      layoutMaps,
      channelState: combinedChannelState,
      dataset: { name: entries.map(e => e.datasetName).join(' vs ') }
    });
  }

  // ── Figure export (what is on screen, as one image) ───────

  function _getCompareExports() {
    const hasPanels = _panels.some(p => p.ready);
    const disabledTitle = _t('compare.needPanel', 'Add at least one panel first');
    return [
      { action: 'compare-figure-png', icon: 'layout-grid', label: _t('compare.figurePng', 'Compare PNG'), enabled: hasPanels, disabledTitle, handler: () => _exportCompareFigure('png') },
      { action: 'compare-figure-webp', icon: 'layout-grid', label: _t('compare.figureWebp', 'Compare WEBP'), enabled: hasPanels, disabledTitle, handler: () => _exportCompareFigure('webp') }
    ];
  }

  async function _exportCompareFigure(format = 'png') {
    try {
      const result = await _composeCompareFigure(format);
      if (!result?.blob) {
        _toast(_t('compare.figureNotReady', 'No panel is ready for the Studio yet.'));
        return null;
      }
      const suffix = format === 'webp' ? 'webp' : 'png';
      ExportManager.downloadBlob(result.blob, `${_safeName(_figureName())}_compare.${suffix}`);
      _toast(_t('compare.figureExported', 'Compare figure exported'));
      return result;
    } catch (err) {
      console.error('[Compare] Figure export failed', err);
      _toast(_t('compare.figureFailed', 'Compare figure export failed'));
      return null;
    }
  }

  async function _composeCompareFigure(format = 'png') {
    const grid = document.getElementById('compare-grid');
    if (!grid || !_panels.length) return null;

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

    _panels.forEach(panel => {
      const rect = panel.el.getBoundingClientRect();
      const x = Math.round((rect.left - gridRect.left) * scale);
      const y = Math.round((rect.top - gridRect.top) * scale);
      const w = Math.round(rect.width * scale);
      const h = Math.round(rect.height * scale);
      const title = panel.name || _t('compare.panel', 'Panel');

      ctx.fillStyle = dark ? '#111827' : '#f8fafc';
      ctx.fillRect(x, y, w, h);
      if (!_drawPanelCanvas(ctx, panel, x, y, w, h)) {
        fallbackPanels++;
        _drawPanelFallback(ctx, title, x, y, w, h, scale, dark);
      }
      _drawPanelLabel(ctx, title, x, y, w, scale, dark);
    });

    _drawFigureStamp(ctx, width, height, scale, dark);
    const mime = format === 'webp' ? 'image/webp' : 'image/png';
    const blob = await new Promise(resolve => canvas.toBlob(resolve, mime, 0.95));
    return { blob, width, height, panelCount: _panels.length, fallbackPanels, mime };
  }

  /** The canvas a panel is showing: the slice overlay when a sibling's cut plane
   *  is mirrored, the WebGL canvas of a volume, the 2D canvas of a photograph. */
  function _visiblePanelCanvas(panel) {
    const doc = panel.iframe?.contentDocument;
    if (!doc) return null;
    const overlay = doc.getElementById('slicer-sync-overlay');
    if (overlay && overlay.style.display !== 'none') {
      const c = doc.getElementById('slicer-sync-canvas');
      if (c?.width && c?.height) return c;
    }
    return doc.getElementById('webgl-canvas') || doc.getElementById('p2d-canvas') || doc.querySelector('canvas');
  }

  function _drawPanelCanvas(ctx, panel, x, y, w, h) {
    const source = _visiblePanelCanvas(panel);
    if (!source || !source.width || !source.height) return false;
    if (_sampleCanvasNonzero(source) <= 16) return false;
    try {
      // Letterbox: the panel and its canvas share an aspect ratio, but a frame
      // mid-resize may not — never stretch the science.
      const k = Math.min(w / source.width, h / source.height);
      const dw = Math.max(1, Math.round(source.width * k));
      const dh = Math.max(1, Math.round(source.height * k));
      ctx.drawImage(source, x + Math.round((w - dw) / 2), y + Math.round((h - dh) / 2), dw, dh);
      return true;
    } catch (err) {
      return false;
    }
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

  function _drawPanelFallback(ctx, title, x, y, w, h, scale, dark) {
    ctx.save();
    ctx.strokeStyle = dark ? 'rgba(255,255,255,0.16)' : 'rgba(15,23,42,0.18)';
    ctx.lineWidth = Math.max(1, scale);
    ctx.strokeRect(x + 8 * scale, y + 8 * scale, Math.max(1, w - 16 * scale), Math.max(1, h - 16 * scale));
    ctx.fillStyle = dark ? 'rgba(255,255,255,0.72)' : 'rgba(15,23,42,0.72)';
    ctx.font = `${Math.round(13 * scale)}px Inter, Arial, sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillText(_t('compare.notReady', '{name} not ready', { name: title }), x + w / 2, y + h / 2);
    ctx.restore();
  }

  function _drawPanelLabel(ctx, title, x, y, w, scale, dark = true) {
    const label = title.length > 72 ? `${title.slice(0, 69)}...` : title;
    ctx.save();
    ctx.font = `${Math.round(12 * scale)}px Inter, Arial, sans-serif`;
    const padX = 10 * scale;
    const textW = Math.min(ctx.measureText(label).width, Math.max(1, w - 24 * scale));
    const boxW = textW + padX * 2;
    const boxH = 26 * scale;
    const bx = x + 12 * scale;
    const by = y + 12 * scale;
    _roundRect(ctx, bx, by, Math.min(boxW, Math.max(1, w - 24 * scale)), boxH, 8 * scale);
    ctx.fillStyle = dark ? 'rgba(5, 8, 12, 0.78)' : 'rgba(255, 255, 255, 0.85)';
    ctx.fill();
    ctx.strokeStyle = dark ? 'rgba(255, 255, 255, 0.18)' : 'rgba(15, 23, 42, 0.18)';
    ctx.stroke();
    ctx.fillStyle = dark ? '#ffffff' : '#0f172a';
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
    // The instance's own name (white-label), never a hardcoded brand.
    const brand = (typeof InstanceConfig !== 'undefined' && InstanceConfig.get) ? InstanceConfig.get('brand.name', 'Lumen3D') : 'Lumen3D';
    const stamp = `${brand} · ${_t('compare.title', 'Comparison Mode')} · ${new Date().toISOString().slice(0, 19).replace('T', ' ')}`;
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
    const ids = _panels.map(panel => panel.id).slice(0, 4);
    return ids.length ? ids.join('_vs_') : 'compare';
  }

  function _safeName(value) {
    return String(value || 'compare').replace(/[^a-z0-9._-]+/gi, '_').replace(/^_+|_+$/g, '').slice(0, 140);
  }

  // ── Helpers ───────────────────────────────────────────────

  // Resolve a key (with optional {params}), else the literal default with the
  // same params applied, so a page without a dictionary still reads well.
  function _t(key, def, params) {
    let v = (typeof I18n !== 'undefined' && I18n.t) ? I18n.t(key, params) : key;
    if (v === key || v == null) v = def != null ? def : key;
    if (params && typeof v === 'string') v = v.replace(/\{(\w+)\}/g, (m, k) => (params[k] != null ? String(params[k]) : m));
    return v;
  }

  function _toast(text) {
    if (typeof ExportManager !== 'undefined' && typeof ExportManager.toast === 'function') {
      ExportManager.toast(text);
      return;
    }
    console.warn(`[Compare] ${text}`);
  }

  // ── Workspace ─────────────────────────────────────────────

  function _panelState(panel) {
    if (!panel.ready) return null;
    const win = panel.iframe?.contentWindow;
    if (!win) return null;
    try {
      const state = win.ViewerApp?.getWorkspaceState ? win.ViewerApp.getWorkspaceState()
        : (win.App2D?.getWorkspaceState ? win.App2D.getWorkspaceState() : null);
      if (state?.viewer && 'cache' in state.viewer) {
        // The brick cache fills on its own while a volume streams; left in, it
        // would re-stamp the URL every second. It is telemetry, not workspace.
        const { cache, ...viewer } = state.viewer;
        return { ...state, viewer };
      }
      return state;
    } catch (err) {
      console.warn('[Compare] Panel state unavailable', panel.index, err);
    }
    return null;
  }

  function _getWorkspaceState() {
    if (!_panels.length) {
      return { ui: { panelCount: 0 }, compare: { panels: [], layoutMode: _layoutMode, sync: { ..._syncOptions }, tool: _tool, quality: _qualityMode } };
    }
    const iframeStates = _panels.map(_panelState);
    // Half a comparison is not a workspace: wait for every panel.
    if (iframeStates.some(s => s === null)) return null;

    return {
      ui: { panelCount: _panels.length },
      compare: {
        panels: _panels.map(panel => panel.id),
        panelTypes: _panels.map(panel => panel.type),
        layoutMode: _layoutMode,
        layoutWeights: JSON.parse(JSON.stringify(_layoutWeights)),
        sync: { ..._syncOptions },
        tool: _tool,
        quality: _qualityMode,
        // The z-stack browser is driven from here, so its open state is recorded
        // here too; the cursor comes from the panel (−1 in the 3D notch).
        panelZstackStates: _panels.map((panel, i) => ({
          active: panel.zstackActive,
          slice: Number.isFinite(iframeStates[i]?.viewer?.zstackSlice) ? iframeStates[i].viewer.zstackSlice : 0
        })),
        panelSoloChannels: _panels.map(panel => panel.soloChannel),
        iframeStates
      }
    };
  }

  function _applyWorkspaceState(state = {}) {
    const compareState = state.compare && Object.keys(state.compare).length ? state.compare : state;
    [..._panels].forEach(panel => _removePanel(panel.index));
    _loadQueue = [];
    _qualityQueue = [];
    _qualityBusy = null;

    if (compareState.layoutMode) {
      _layoutMode = compareState.layoutMode;
      const select = document.getElementById('compare-layout-mode');
      if (select) select.value = _layoutMode;
    }
    if (compareState.layoutWeights) {
      _layoutWeights = { ..._layoutWeights, ...JSON.parse(JSON.stringify(compareState.layoutWeights)) };
    }
    if (compareState.sync) {
      _syncOptions = { ..._syncOptions, ...compareState.sync };
      Object.entries(_syncOptions).forEach(([key, value]) => {
        const cb = document.getElementById(`sync-${key}`);
        if (cb) cb.checked = Boolean(value);
      });
    }
    if (compareState.quality) {
      _qualityMode = compareState.quality;
      const select = document.getElementById('compare-quality');
      if (select) select.value = _qualityMode;
    }
    _tool = compareState.tool || 'navigate';
    _syncToolChips();

    const iframeStates = Array.isArray(compareState.iframeStates) ? compareState.iframeStates : [];
    (compareState.panels || []).slice(0, MAX_PANELS).forEach((id, i) => {
      const zEntry = Array.isArray(compareState.panelZstackStates) ? compareState.panelZstackStates[i] : null;
      // Both the legacy boolean and the {active, slice} shape restore.
      const zActive = typeof zEntry === 'boolean' ? zEntry : Boolean(zEntry?.active);
      const zSlice = zEntry && typeof zEntry === 'object' && Number.isFinite(zEntry.slice) ? zEntry.slice : 0;
      const solo = Array.isArray(compareState.panelSoloChannels) ? compareState.panelSoloChannels[i] : null;
      _addPanel(id, {
        state: iframeStates[i] || null,
        zstack: zActive ? { slice: zSlice } : null,
        soloChannel: Number.isInteger(solo) ? solo : null
      });
    });
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

// The language menu is generated from the discovered locales (Utils.populateLanguageMenu).
window.switchLanguage = window.switchLanguage || async function switchLanguage(lang) {
  await I18n.setLanguage(lang);
  Utils.closeDropdowns();
  Utils.populateLanguageMenu(window.switchLanguage);
};

document.addEventListener('DOMContentLoaded', CompareApp.init);
