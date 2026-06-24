/* ============================================================
   IRIBHM Microscopy Platform — Export & Download Center
   ============================================================ */

const ExportManager = (() => {
  let _ctx = {};
  let _modal = null;
  let _customExports = [];   // page-supplied exports (tracking measures, compare figures) — non-viewer scopes
  // File-explorer state for the per-dataset download folder. `token` guards
  // against out-of-order responses when the user clicks through folders quickly.
  const _explorer = { path: '', token: 0, data: null };

  // Per-extension file-type [lucide-icon, category]. The category drives the
  // icon colour (CSS `.dl-row[data-cat]`) so each type reads at a glance, like a
  // real file explorer. Unknown extensions fall back to a neutral file glyph.
  const _FILE_TYPES = {
    png: ['file-image', 'image'], jpg: ['file-image', 'image'], jpeg: ['file-image', 'image'],
    gif: ['file-image', 'image'], webp: ['file-image', 'image'], bmp: ['file-image', 'image'],
    svg: ['file-image', 'image'], tif: ['file-image', 'image'], tiff: ['file-image', 'image'],
    ims: ['box', 'volume'], nrrd: ['box', 'volume'], nii: ['box', 'volume'], mha: ['box', 'volume'],
    mhd: ['box', 'volume'], vtk: ['box', 'volume'],
    h5: ['database', 'volume'], hdf5: ['database', 'volume'], zarr: ['database', 'volume'],
    npy: ['binary', 'volume'], npz: ['binary', 'volume'], bin: ['binary', 'volume'],
    csv: ['file-spreadsheet', 'table'], tsv: ['file-spreadsheet', 'table'],
    xls: ['file-spreadsheet', 'table'], xlsx: ['file-spreadsheet', 'table'],
    json: ['file-json', 'data'], xml: ['file-code', 'data'], yaml: ['file-code', 'data'], yml: ['file-code', 'data'],
    txt: ['file-text', 'doc'], md: ['file-text', 'doc'], pdf: ['file-text', 'doc'],
    zip: ['file-archive', 'archive'], gz: ['file-archive', 'archive'], tar: ['file-archive', 'archive'],
    tgz: ['file-archive', 'archive'], '7z': ['file-archive', 'archive'], rar: ['file-archive', 'archive'],
    glb: ['shapes', 'model'], gltf: ['shapes', 'model'], obj: ['shapes', 'model'], ply: ['shapes', 'model'], stl: ['shapes', 'model'],
    mp4: ['file-video', 'video'], webm: ['file-video', 'video'], mov: ['file-video', 'video'], avi: ['file-video', 'video']
  };

  function init(context = {}) {
    _ctx = context;
    _ensureModal();
  }

  function openDownloadCenter(context = null) {
    if (context) _ctx = { ..._ctx, ...context };
    _ensureModal();
    _ctx.dataset ||= null;
    _renderDownloads();
    _loadExplorer('');  // populate the file explorer at the download/ root
    _modal.classList.add('active');
    document.body.classList.add('modal-open');
  }

  function close() {
    if (!_modal) return;
    _modal.classList.remove('active');
    document.body.classList.remove('modal-open');
  }

  async function exportCanvas(options = {}) {
    if (_ctx.getCanvasBlob) {
      const blob = await _ctx.getCanvasBlob(options);
      if (!blob) return;
      const mime = options.mime || 'image/png';
      const extension = mime === 'image/webp' ? 'webp' : 'png';
      const name = _safeName(_ctx.dataset?.name || _ctx.dataset?.id || 'figure');
      _downloadBlob(blob, `${name}_figure.${extension}`);
      return;
    }
    const canvas = _ctx.getCanvas?.();
    if (!canvas) {
      _toast(_t('toast.figureUnavailable', 'Figure export is not available on this page'));
      return;
    }
    const mime = options.mime || 'image/png';
    const extension = mime === 'image/webp' ? 'webp' : 'png';
    const name = _safeName(_ctx.dataset?.name || _ctx.dataset?.id || 'figure');
    const blob = await new Promise(resolve => canvas.toBlob(resolve, mime, options.quality || 0.95));
    if (!blob) return;
    _downloadBlob(blob, `${name}_figure.${extension}`);
  }

  async function exportGraph(format = 'png') {
    const graph = _ctx.getGraph?.();
    if (!graph || !window.Plotly) {
      _toast(_t('toast.graphUnavailable', 'Graph export is not available on this page'));
      return;
    }
    if (format === 'csv') {
      const csv = _plotlyCsv(graph);
      _downloadBlob(new Blob([csv], { type: 'text/csv' }), `${_safeName(_ctx.dataset?.name || 'graph')}_graph.csv`);
      return;
    }

    const dataUrl = await Plotly.toImage(graph, {
      format: format === 'svg' ? 'svg' : 'png',
      width: Math.max(800, graph.clientWidth || 800),
      height: Math.max(500, graph.clientHeight || 500),
      scale: 2
    });
    _downloadUrl(dataUrl, `${_safeName(_ctx.dataset?.name || 'graph')}_graph.${format}`);
  }

  function exportWorkspace(scope = _ctx.scope || 'viewer') {
    const payload = {
      version: 1,
      scope,
      datasetId: _ctx.dataset?.id,
      exportedAt: new Date().toISOString(),
      dataset: _datasetSummary(),
      citation: _citationBlock(),
      state: _ctx.getWorkspaceState?.() || {}
    };
    WorkspaceState.download(payload, `${_safeName(_ctx.dataset?.name || 'workspace')}_workspace.json`);
  }

  function saveWorkspace(scope = _ctx.scope || 'viewer') {
    const payload = WorkspaceState.save(_ctx.dataset?.id, scope, _ctx.getWorkspaceState?.() || {});
    _toast(_t('toast.workspaceSaved', 'Workspace saved'));
    return payload;
  }

  function restoreWorkspace(scope = _ctx.scope || 'viewer') {
    const payload = WorkspaceState.load(_ctx.dataset?.id, scope);
    if (!payload) {
      _toast(_t('toast.noWorkspace', 'No saved workspace found'));
      return null;
    }
    _ctx.applyWorkspaceState?.(payload.state || {});
    _toast(_t('toast.workspaceRestored', 'Workspace restored'));
    return payload;
  }

  function _ensureModal() {
    if (_modal) return;
    _modal = document.createElement('div');
    _modal.className = 'export-modal-overlay';
    _modal.innerHTML = `
      <div class="export-modal" role="dialog" aria-modal="true" aria-labelledby="download-title">
        <div class="export-modal-header">
          <div>
            <h2 id="download-title">${_t('download.title', 'Download Center')}</h2>
            <p id="download-subtitle">${_t('download.subtitle', 'Raw sources, web-ready assets, figures, analysis exports, and reproducible workspaces.')}</p>
          </div>
          <button class="btn btn-icon btn-ghost" data-export-close aria-label="${_t('app.close', 'Close')}">
            <i data-lucide="x"></i>
          </button>
        </div>
        <div class="export-modal-body" id="download-body"></div>
      </div>
    `;
    document.body.appendChild(_modal);
    _modal.addEventListener('click', (e) => {
      if (e.target === _modal || e.target.closest('[data-export-close]')) close();
      if (e.target.closest('[data-disabled="true"], [disabled]')) {
        e.preventDefault();
        return;
      }
      // File-explorer navigation (folder rows + breadcrumb) — never a download.
      const nav = e.target.closest('[data-explorer-nav]');
      if (nav) {
        e.preventDefault();
        _loadExplorer(nav.getAttribute('data-explorer-nav') || '');
        return;
      }
      const action = e.target.closest('[data-export-action]')?.dataset.exportAction;
      if (!action) return;
      if (action === 'measures-csv') exportMeasures('csv');
      else if (action === 'canvas-png') exportCanvas({ mime: 'image/png' });
      else if (action === 'canvas-webp') exportCanvas({ mime: 'image/webp' });
      else if (action === 'graph-png') exportGraph('png');
      else if (action === 'graph-svg') exportGraph('svg');
      else if (action === 'graph-csv') exportGraph('csv');
      else if (action === 'workspace-json') exportWorkspace();
      else if (action === 'save-workspace') saveWorkspace();
      else if (action === 'restore-workspace') restoreWorkspace();
      else { const custom = _customExports.find(item => item.action === action); if (custom?.handler) custom.handler(); }
    });
  }

  function _renderDownloads() {
    const body = document.getElementById('download-body');
    if (!body) return;
    const dataset = _ctx.dataset || null;
    const scope = _ctx.scope || 'viewer';

    // The file explorer over the dataset's download/ folder is a per-dataset
    // experience (viewer / explorer). Tracking and Compare have no download
    // folder to browse, so they keep the export-buttons modal (figures, graph,
    // workspace, page-supplied custom exports) — their Download Centers must not
    // regress when the viewer's is simplified.
    if (scope !== 'viewer' && scope !== 'explorer') {
      _renderGeneratedExports(body, dataset);
      return;
    }

    if (!dataset) {
      body.innerHTML = `<div class="dl-empty">${_t('download.noDataset', 'Open a dataset to browse its downloadable files.')}</div>`;
      return;
    }

    const measures = _safeList(_ctx.getMeasurements);
    body.innerHTML = `
      <div class="dl-head">
        <div class="dl-head-title">${Utils.escapeHtml(dataset.name || dataset.id || 'Dataset')}</div>
        <div class="dl-head-sub">${Utils.escapeHtml(_datasetIntro(dataset))}</div>
      </div>
      <section class="dl-section">
        <div class="dl-section-head">
          <h3>${_t('download.filesTitle', 'Dataset files')}</h3>
          ${measures.length ? `<button class="dl-measures-btn" data-export-action="measures-csv" title="${_t('download.measuresCsv', 'Measurements CSV')}"><i data-lucide="file-spreadsheet"></i><span>${_t('download.measuresCsv', 'Measurements CSV')}</span></button>` : ''}
        </div>
        <div id="download-explorer" class="dl-explorer">${_explorerLoadingHtml()}</div>
      </section>
    `;
    if (window.lucide) lucide.createIcons({ nodes: [body, _modal] });
  }

  // Tracking / Compare Download Center: the export-buttons modal. Figures and
  // graph exports gate on availability; page-supplied custom exports (e.g.
  // tracking measurements CSV/JSON, compare composite figures) are surfaced via
  // _ctx.getCustomExports so those pages keep their exports.
  function _renderGeneratedExports(body, dataset) {
    const hasCanvas = Boolean(_ctx.getCanvas?.());
    const hasGraph = Boolean(_ctx.getGraph?.() && window.Plotly);
    const measures = _safeList(_ctx.getMeasurements);
    _customExports = Array.isArray(_ctx.getCustomExports?.()) ? _ctx.getCustomExports() : [];
    body.innerHTML = `
      ${dataset ? `<div class="dl-head"><div class="dl-head-title">${Utils.escapeHtml(dataset.name || dataset.id || 'Dataset')}</div><div class="dl-head-sub">${Utils.escapeHtml(_datasetIntro(dataset))}</div></div>` : ''}
      <section class="dl-section">
        <div class="dl-section-head"><h3>${_t('download.generatedTitle', 'Generated exports')}</h3></div>
        <div class="export-quick-actions">
          ${_quickAction('canvas-png', 'image', _t('download.figurePng', 'Figure PNG'), hasCanvas, _t('download.noCanvas', 'No visible canvas here'))}
          ${_quickAction('canvas-webp', 'image-down', _t('download.figureWebp', 'Figure WebP'), hasCanvas, _t('download.noCanvas', 'No visible canvas here'))}
          ${_quickAction('graph-png', 'bar-chart-2', _t('download.graphPng', 'Graph PNG'), hasGraph, _t('download.noGraph', 'No visible graph here'))}
          ${_quickAction('graph-svg', 'line-chart', _t('download.graphSvg', 'Graph SVG'), hasGraph, _t('download.noGraph', 'No visible graph here'))}
          ${_quickAction('graph-csv', 'table', _t('download.graphCsv', 'Graph CSV'), hasGraph, _t('download.noGraph', 'No visible graph here'))}
          ${measures.length ? _quickAction('measures-csv', 'file-spreadsheet', _t('download.measuresCsv', 'Measurements CSV'), true, '') : ''}
          <button class="btn btn-outline btn-sm" data-export-action="workspace-json"><i data-lucide="braces"></i> ${_t('download.workspaceJson', 'Workspace JSON')}</button>
          <button class="btn btn-outline btn-sm" data-export-action="save-workspace"><i data-lucide="save"></i> ${_t('download.saveState', 'Save state')}</button>
          <button class="btn btn-outline btn-sm" data-export-action="restore-workspace"><i data-lucide="folder-open"></i> ${_t('download.restoreState', 'Restore state')}</button>
          ${_customExports.map(item => _quickAction(item.action, item.icon || 'flask-conical', item.label, item.enabled !== false, item.disabledTitle || _t('download.exportUnavailable', 'Export unavailable'))).join('')}
        </div>
      </section>
    `;
    if (window.lucide) lucide.createIcons({ nodes: [body, _modal] });
  }

  function _quickAction(action, icon, label, enabled, disabledTitle) {
    const disabled = enabled ? '' : `disabled title="${Utils.escapeHtml(disabledTitle)}"`;
    return `<button class="btn btn-outline btn-sm" data-export-action="${action}" ${disabled}><i data-lucide="${icon}"></i> ${label}</button>`;
  }

  function _safeList(getter) {
    if (typeof getter !== 'function') return [];
    try {
      const v = getter();
      return Array.isArray(v) ? v : [];
    } catch (_) {
      return [];
    }
  }

  // ── Dataset file explorer (DATA_WEB/<dataset>/download/) ────────────────────

  function _explorerLoadingHtml() {
    return `<div class="dl-empty">${_t('download.explorerLoading', 'Loading files…')}</div>`;
  }

  // Fetch one directory listing from the platform server. Tries the rewrite-free
  // route first, then the explicit .php (PHP/legacy hosts) — mirrors the hybrid
  // strategy used for plugin/language discovery. Throws if neither responds, so
  // the caller can show a graceful "server required" state on static-only hosts.
  async function _fetchDownloads(dataset, subpath) {
    const qs = `dataset=${encodeURIComponent(dataset)}&path=${encodeURIComponent(subpath || '')}`;
    const candidates = [`api/downloads?${qs}`, `api/downloads.php?${qs}`];
    for (const url of candidates) {
      try {
        const resp = await fetch(url, { cache: 'no-store' });
        if (!resp.ok) continue;
        return await resp.json();
      } catch (_) { /* try next candidate */ }
    }
    throw new Error('downloads endpoint unavailable');
  }

  async function _loadExplorer(subpath = '') {
    const container = document.getElementById('download-explorer');
    if (!container) return;
    _explorer.path = subpath;
    const dsPath = _ctx.dataset?.path || _ctx.dataset?.id;
    if (!dsPath) {
      container.innerHTML = `<div class="dl-empty">${_t('download.explorerEmpty', 'No downloadable files provided for this dataset.')}</div>`;
      return;
    }
    container.innerHTML = _explorerLoadingHtml();
    const token = ++_explorer.token;
    let data = null;
    let failed = false;
    try {
      data = await _fetchDownloads(dsPath, subpath);
    } catch (_) {
      failed = true;
    }
    if (token !== _explorer.token) return;  // a newer navigation superseded this one
    if (failed) {
      container.innerHTML = `<div class="dl-empty">${_t('download.explorerError', 'File listing is unavailable (platform server required).')}</div>`;
      return;
    }
    _explorer.data = data;
    container.innerHTML = _explorerHtml(data);
    if (window.lucide) lucide.createIcons({ nodes: [container] });
  }

  function _explorerHtml(data) {
    if (!data || data.available === false) {
      return `<div class="dl-empty">${_t('download.explorerEmpty', 'No downloadable files provided for this dataset.')}</div>`;
    }
    const entries = Array.isArray(data.entries) ? data.entries : [];
    const bar = `<div class="dl-bar">${_breadcrumbHtml(data.path || '')}</div>`;
    if (!entries.length) {
      return `${bar}<div class="dl-empty">${_t('download.explorerFolderEmpty', 'This folder is empty.')}</div>`;
    }
    return `${bar}<div class="dl-list">${entries.map(_explorerRow).join('')}</div>`;
  }

  function _breadcrumbHtml(path) {
    const segs = String(path || '').split('/').filter(Boolean);
    const crumbs = [`<a class="dl-crumb" href="#" data-explorer-nav=""><i data-lucide="folder"></i> ${_t('download.filesRoot', 'download')}</a>`];
    let acc = '';
    segs.forEach(seg => {
      acc = acc ? `${acc}/${seg}` : seg;
      crumbs.push(`<span class="dl-crumb-sep">/</span><a class="dl-crumb" href="#" data-explorer-nav="${Utils.escapeHtml(acc)}">${Utils.escapeHtml(seg)}</a>`);
    });
    return `<nav class="dl-breadcrumb">${crumbs.join('')}</nav>`;
  }

  // A compact, single-line explorer row (real file-explorer feel). Folder rows
  // navigate (data-explorer-nav); file rows are real download anchors (`download`
  // kept LAST so the markup ends in `download>`). Every interpolated field is
  // escaped. The data-cat attribute drives the per-type icon colour in CSS.
  function _explorerRow(entry) {
    if (!entry || typeof entry !== 'object') return '';
    const name = Utils.escapeHtml(entry.name || '');
    if (entry.kind === 'dir') {
      const count = Number.isFinite(entry.count)
        ? `<span class="dl-row-meta">${_t('download.itemCount', `${entry.count} items`, { count: entry.count })}</span>`
        : '';
      return `<a class="dl-row dl-row-folder" data-cat="folder" role="button" data-explorer-nav="${Utils.escapeHtml(entry.path || '')}" href="#">`
        + `<i class="dl-ico" data-lucide="folder"></i>`
        + `<span class="dl-row-name">${name}</span>${count}`
        + `<i class="dl-row-chev" data-lucide="chevron-right"></i></a>`;
    }
    const ext = String(entry.ext || _formatFromName(entry.name) || 'FILE').toUpperCase();
    const size = Number.isFinite(entry.sizeBytes) ? `<span class="dl-row-meta">${Utils.formatFileSize(entry.sizeBytes)}</span>` : '';
    const href = entry.href || entry.path || '#';
    return `<a class="dl-row dl-row-file" data-cat="${_catForExt(ext)}" title="${name}" href="${Utils.escapeHtml(href)}" download>`
      + `<i class="dl-ico" data-lucide="${_iconForExt(ext)}"></i>`
      + `<span class="dl-row-name">${name}</span>`
      + `<span class="dl-row-ext">${Utils.escapeHtml(ext)}</span>${size}`
      + `<i class="dl-row-dl" data-lucide="download"></i></a>`;
  }

  function _formatFromName(name) {
    const m = String(name || '').match(/\.([a-z0-9]+)$/i);
    return m ? m[1].toUpperCase() : 'FILE';
  }

  function _iconForExt(ext) {
    return _FILE_TYPES[String(ext || '').toLowerCase()]?.[0] || 'file';
  }

  function _catForExt(ext) {
    return _FILE_TYPES[String(ext || '').toLowerCase()]?.[1] || 'default';
  }

  // ── Generated exports (measurements / metadata / annotations) ──────────────

  function exportMeasures(format = 'csv') {
    const items = _safeList(_ctx.getMeasurements);
    if (!items.length) {
      _toast(_t('download.noMeasures', 'No measurements to export'));
      return;
    }
    const name = _safeName(_ctx.dataset?.name || _ctx.dataset?.id || 'measurements');
    if (format === 'csv') {
      const csv = (typeof MeasurementStore !== 'undefined' && MeasurementStore.toCsv)
        ? MeasurementStore.toCsv(items)
        : '';
      _downloadBlob(new Blob([csv], { type: 'text/csv' }), `${name}_measurements.csv`);
    } else {
      const json = (typeof MeasurementStore !== 'undefined' && MeasurementStore.toJson)
        ? MeasurementStore.toJson(items)
        : JSON.stringify({ version: 1, measurements: items }, null, 2);
      _downloadBlob(new Blob([json], { type: 'application/json' }), `${name}_measurements.json`);
    }
  }

  function exportMetadata() {
    const dataset = _ctx.dataset;
    if (!dataset) {
      _toast(_t('download.noMetadata', 'No metadata available'));
      return;
    }
    const payload = {
      version: 1,
      exportedAt: new Date().toISOString(),
      dataset,
      citation: _citationBlock()
    };
    const name = _safeName(dataset.name || dataset.id || 'metadata');
    _downloadBlob(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }), `${name}_metadata.json`);
  }

  function exportAnnotations() {
    const items = _safeList(_ctx.getAnnotations);
    if (!items.length) {
      _toast(_t('download.noAnnotations', 'No annotations to export'));
      return;
    }
    const name = _safeName(_ctx.dataset?.name || _ctx.dataset?.id || 'annotations');
    const json = JSON.stringify({ version: 1, annotations: items }, null, 2);
    _downloadBlob(new Blob([json], { type: 'application/json' }), `${name}_annotations.json`);
  }

  function _plotlyCsv(graph) {
    const traces = graph.data || graph._fullData || [];
    const rows = [['trace', 'x', 'y']];
    traces.forEach((trace, idx) => {
      const xs = trace.x || [];
      const ys = trace.y || [];
      const name = trace.name || `trace_${idx + 1}`;
      for (let i = 0; i < Math.max(xs.length, ys.length); i++) {
        rows.push([name, xs[i] ?? '', ys[i] ?? '']);
      }
    });
    return rows.map(row => row.map(value => `"${String(value).replace(/"/g, '""')}"`).join(',')).join('\n');
  }

  function _downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    _downloadUrl(url, filename);
    setTimeout(() => URL.revokeObjectURL(url), 500);
  }

  function _downloadUrl(url, filename) {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
  }

  function _safeName(value) {
    return String(value || 'export').replace(/[^a-z0-9._-]+/gi, '_').replace(/^_+|_+$/g, '');
  }

  function _datasetSummary() {
    const dataset = _ctx.dataset;
    if (!dataset) return null;
    return {
      id: dataset.id || null,
      name: dataset.name || null,
      type: dataset.type || null,
      stage: dataset.stage || null,
      date: dataset.date || null,
      path: dataset.path || null,
      markers: dataset.markers || [],
      dimensions: dataset.dimensions || null,
      voxelSize: dataset.voxel_size || null,
      linkedTrackingId: dataset.linkedTrackingId || null,
      registration: dataset.registration ? {
        method: dataset.registration.method || null,
        appliedToVolume: Boolean(dataset.registration.appliedToVolume),
        coordinateSpace: dataset.registration.coordinateSpace || null,
        qcSummary: dataset.registration.qcSummary || null
      } : null
    };
  }

  function _citationBlock() {
    const dataset = _ctx.dataset;
    if (!dataset) return null;
    const parts = [
      dataset.name || dataset.id || 'Untitled dataset',
      dataset.stage ? `stage ${dataset.stage}` : null,
      dataset.date || null,
      'IRIBHM Microscopy Platform'
    ].filter(Boolean);
    return `${parts.join(', ')}. Cite the IRIBHM Microscopy Platform, the dataset workspace export, and the original experiment or publication when available. Workspace export generated ${new Date().toISOString()}.`;
  }

  function _datasetIntro(dataset) {
    const bits = [
      dataset.type || null,
      dataset.stage || null,
      dataset.date || null
    ].filter(Boolean);
    return `${bits.join(' | ')}${dataset.description ? ` | ${dataset.description}` : ''}`;
  }

  // i18n helper: resolve a key, falling back to the literal English default
  // when I18n is absent or the key is unknown (keeps toasts robust on any page).
  // `params` are forwarded to I18n.t for {placeholder} substitution and are also
  // applied to the fallback default, so counts resolve even with no I18n.
  function _t(key, def, params) {
    let v = (typeof I18n !== 'undefined' && I18n.t) ? I18n.t(key, params) : key;
    if (v === key || v == null) v = (def != null ? def : key);
    if (params && typeof v === 'string') {
      v = v.replace(/\{(\w+)\}/g, (m, k) => (params[k] != null ? String(params[k]) : m));
    }
    return v;
  }

  function _toast(text) {
    let node = document.querySelector('.app-toast');
    if (!node) {
      node = document.createElement('div');
      node.className = 'app-toast';
      document.body.appendChild(node);
    }
    node.textContent = text;
    node.classList.add('visible');
    setTimeout(() => node.classList.remove('visible'), 1800);
  }

  return {
    init,
    openDownloadCenter,
    close,
    exportCanvas,
    exportGraph,
    exportWorkspace,
    exportMeasures,
    exportMetadata,
    exportAnnotations,
    downloadBlob: _downloadBlob,
    toast: _toast,
    saveWorkspace,
    restoreWorkspace,
    _explorerRow,     // exposed for unit testing (file/folder row render helper)
    _breadcrumbHtml,  // exposed for unit testing (breadcrumb render helper)
    _iconForExt,      // exposed for unit testing (extension → icon map)
    _catForExt        // exposed for unit testing (extension → colour category)
  };
})();
