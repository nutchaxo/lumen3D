/* ============================================================
   IRIBHM Microscopy Platform — Export & Download Center
   ============================================================ */

const ExportManager = (() => {
  let _ctx = {};
  let _modal = null;
  let _customExports = [];
  // File-explorer state for the per-dataset download folder. `token` guards
  // against out-of-order responses when the user clicks through folders quickly.
  const _explorer = { path: '', token: 0, data: null };

  // Lucide icon name per file extension — purely cosmetic, falls back to 'file'.
  const _EXT_ICONS = {
    png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', bmp: 'image', svg: 'image',
    tif: 'layers', tiff: 'layers',
    ims: 'box', nrrd: 'box', nii: 'box', mha: 'box', mhd: 'box', vtk: 'box',
    h5: 'database', hdf5: 'database', zarr: 'database', npy: 'binary', npz: 'binary', bin: 'binary',
    csv: 'table', tsv: 'table', xls: 'table', xlsx: 'table',
    json: 'braces', xml: 'code', yaml: 'code', yml: 'code',
    txt: 'file-text', md: 'file-text', pdf: 'file-text',
    zip: 'file-archive', gz: 'file-archive', tar: 'file-archive', tgz: 'file-archive', '7z': 'file-archive', rar: 'file-archive',
    glb: 'shapes', gltf: 'shapes', obj: 'shapes', ply: 'shapes', stl: 'shapes',
    mp4: 'video', webm: 'video', mov: 'video', avi: 'video'
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
      if (action === 'canvas-png') exportCanvas({ mime: 'image/png' });
      if (action === 'canvas-webp') exportCanvas({ mime: 'image/webp' });
      if (action === 'graph-png') exportGraph('png');
      if (action === 'graph-svg') exportGraph('svg');
      if (action === 'graph-csv') exportGraph('csv');
      if (action === 'measures-csv') exportMeasures('csv');
      if (action === 'measures-json') exportMeasures('json');
      if (action === 'metadata-json') exportMetadata();
      if (action === 'annotations-json') exportAnnotations();
      if (action === 'workspace-json') exportWorkspace();
      if (action === 'save-workspace') saveWorkspace();
      if (action === 'restore-workspace') restoreWorkspace();
      const custom = _customExports.find(item => item.action === action);
      if (custom?.handler) custom.handler();
    });
  }

  function _renderDownloads() {
    const body = document.getElementById('download-body');
    if (!body) return;
    const dataset = _ctx.dataset || null;
    const groups = DownloadManifest.byCategory(dataset);
    const categoryNames = {
      raw: _t('download.catRaw', 'Raw source files'),
      web: _t('download.catWeb', 'Web-ready data'),
      generated: _t('download.catGenerated', 'Generated analysis'),
      figure: _t('download.catFigure', 'Figures & media'),
      workspace: _t('download.catWorkspace', 'Workspace')
    };
    const hasCanvas = Boolean(_ctx.getCanvas?.());
    const hasGraph = Boolean(_ctx.getGraph?.() && window.Plotly);
    _customExports = Array.isArray(_ctx.getCustomExports?.()) ? _ctx.getCustomExports() : [];
    const measures = _safeList(_ctx.getMeasurements);
    const annotations = _safeList(_ctx.getAnnotations);

    body.innerHTML = `
      ${dataset ? `
        <section class="download-category">
          <h3>${Utils.escapeHtml(dataset.name || dataset.id || 'Dataset')}</h3>
          <div class="download-empty" style="text-align:left">
            ${Utils.escapeHtml(_datasetIntro(dataset))}
          </div>
        </section>
      ` : ''}
      ${dataset ? `
        <section class="download-category">
          <h3>${_t('download.filesTitle', 'Dataset files')}</h3>
          <div id="download-explorer" class="dl-explorer">${_explorerLoadingHtml()}</div>
        </section>
      ` : ''}
      <section class="download-category">
        <h3>${_t('download.generatedTitle', 'Generated exports')}</h3>
        <div class="export-quick-actions">
          ${_quickAction('canvas-png', 'image', _t('download.figurePng','Figure PNG'), hasCanvas, _t('download.noCanvas','No visible canvas here'))}
          ${_quickAction('canvas-webp', 'image-down', _t('download.figureWebp','Figure WebP'), hasCanvas, _t('download.noCanvas','No visible canvas here'))}
          ${_quickAction('graph-png', 'bar-chart-2', _t('download.graphPng','Graph PNG'), hasGraph, _t('download.noGraph','No visible graph here'))}
          ${_quickAction('graph-svg', 'line-chart', _t('download.graphSvg','Graph SVG'), hasGraph, _t('download.noGraph','No visible graph here'))}
          ${_quickAction('graph-csv', 'table', _t('download.graphCsv','Graph CSV'), hasGraph, _t('download.noGraph','No visible graph here'))}
          ${_quickAction('measures-csv', 'ruler', _t('download.measuresCsv','Measurements CSV'), measures.length > 0, _t('download.noMeasures','No measurements to export'))}
          ${_quickAction('measures-json', 'ruler', _t('download.measuresJson','Measurements JSON'), measures.length > 0, _t('download.noMeasures','No measurements to export'))}
          ${_quickAction('metadata-json', 'braces', _t('download.metadataJson','Metadata JSON'), Boolean(dataset), _t('download.noMetadata','No metadata available'))}
          ${_quickAction('annotations-json', 'map-pin', _t('download.annotationsJson','Annotations JSON'), annotations.length > 0, _t('download.noAnnotations','No annotations to export'))}
          <button class="btn btn-outline btn-sm" data-export-action="workspace-json"><i data-lucide="braces"></i> ${_t('download.workspaceJson', 'Workspace JSON')}</button>
          <button class="btn btn-outline btn-sm" data-export-action="save-workspace"><i data-lucide="save"></i> ${_t('download.saveState', 'Save state')}</button>
          <button class="btn btn-outline btn-sm" data-export-action="restore-workspace"><i data-lucide="folder-open"></i> ${_t('download.restoreState', 'Restore state')}</button>
          ${_customExports.map(item => _quickAction(item.action, item.icon || 'flask-conical', item.label, item.enabled !== false, item.disabledTitle || _t('download.exportUnavailable', 'Export unavailable'))).join('')}
        </div>
      </section>
      ${Object.keys(categoryNames).map(key => _categoryHtml(categoryNames[key], groups[key] || [])).join('')}
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
    return `<div class="download-empty">${_t('download.explorerLoading', 'Loading files…')}</div>`;
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
      container.innerHTML = `<div class="download-empty">${_t('download.explorerEmpty', 'No downloadable files provided for this dataset.')}</div>`;
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
      container.innerHTML = `<div class="download-empty">${_t('download.explorerError', 'File listing is unavailable (platform server required).')}</div>`;
      return;
    }
    _explorer.data = data;
    container.innerHTML = _explorerHtml(data);
    if (window.lucide) lucide.createIcons({ nodes: [container] });
  }

  function _explorerHtml(data) {
    if (!data || data.available === false) {
      return `<div class="download-empty">${_t('download.explorerEmpty', 'No downloadable files provided for this dataset.')}</div>`;
    }
    const entries = Array.isArray(data.entries) ? data.entries : [];
    const crumbs = _breadcrumbHtml(data.path || '');
    if (!entries.length) {
      return `${crumbs}<div class="download-empty">${_t('download.explorerFolderEmpty', 'This folder is empty.')}</div>`;
    }
    return `${crumbs}<div class="download-list">${entries.map(_explorerRow).join('')}</div>`;
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

  function _explorerRow(entry) {
    if (!entry || typeof entry !== 'object') return '';
    const name = Utils.escapeHtml(entry.name || '');
    if (entry.kind === 'dir') {
      const count = Number.isFinite(entry.count)
        ? `<span>${_t('download.itemCount', `${entry.count} items`, { count: entry.count })}</span>`
        : '';
      return `
        <a class="download-item dl-folder" href="#" role="button" data-explorer-nav="${Utils.escapeHtml(entry.path || '')}">
          <span class="download-format"><i data-lucide="folder"></i></span>
          <span class="download-main">
            <strong>${name}</strong>
            <small>${_t('download.folder', 'Folder')}</small>
          </span>
          <span class="download-meta">${count}<i data-lucide="chevron-right"></i></span>
        </a>
      `;
    }
    const ext = String(entry.ext || _formatFromName(entry.name) || 'FILE').toUpperCase();
    const size = Number.isFinite(entry.sizeBytes) ? `<span>${Utils.formatFileSize(entry.sizeBytes)}</span>` : '';
    const href = entry.href || entry.path || '#';
    return `
      <a class="download-item" href="${Utils.escapeHtml(href)}" download>
        <span class="download-format"><i data-lucide="${_iconForExt(ext)}"></i> ${Utils.escapeHtml(ext)}</span>
        <span class="download-main">
          <strong>${name}</strong>
          <small>${Utils.escapeHtml(entry.path || entry.name || '')}</small>
        </span>
        <span class="download-meta">${size}<i data-lucide="download"></i></span>
      </a>
    `;
  }

  function _formatFromName(name) {
    const m = String(name || '').match(/\.([a-z0-9]+)$/i);
    return m ? m[1].toUpperCase() : 'FILE';
  }

  function _iconForExt(ext) {
    return _EXT_ICONS[String(ext || '').toLowerCase()] || 'file';
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

  function _categoryHtml(title, items) {
    const sorted = [...items].sort((a, b) => {
      if (a.primary !== b.primary) return a.primary ? -1 : 1;
      if (a.kind !== b.kind) return a.kind === 'bundle' ? -1 : 1;
      return String(a.label || '').localeCompare(String(b.label || ''));
    });
    if (!items.length) {
      return `
        <section class="download-category">
          <h3>${title}</h3>
          <div class="download-empty">${_t('download.noFile', 'No file currently available for this category.')}</div>
        </section>
      `;
    }
    return `
      <section class="download-category">
        <h3>${title}</h3>
        <div class="download-list">
          ${sorted.map(_itemHtml).join('')}
        </div>
      </section>
    `;
  }

  function _itemHtml(item) {
    const size = item.sizeBytes ? Utils.formatFileSize(item.sizeBytes) : (item.count ? _t('download.files', `${item.count} files`, { count: item.count }) : '');
    const warning = item.large ? `<span class="download-warning">${_t('download.largeFile', 'large file')}</span>` : '';
    const primary = item.primary ? `<span class="download-warning">${_t('download.recommended', 'recommended')}</span>` : '';
    const kind = item.kind || (item.directory ? 'directory' : 'file');
    const attrs = item.directory
      ? 'target="_blank" rel="noopener"'
      : 'download';
    return `
      <a class="download-item ${item.directory ? 'is-directory' : ''} ${kind === 'bundle' ? 'is-bundle' : ''}" href="${Utils.escapeHtml(item.path)}" ${attrs}>
        <span class="download-format">${Utils.escapeHtml(item.format || 'FILE')}</span>
        <span class="download-main">
          <strong>${Utils.escapeHtml(item.label)}</strong>
          <small>${Utils.escapeHtml(item.description || item.path)}</small>
        </span>
        <span class="download-meta">${primary}${warning}${size ? `<span>${size}</span>` : ''}</span>
      </a>
    `;
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
    _itemHtml,        // exposed for unit testing (pure HTML render helper)
    _explorerRow,     // exposed for unit testing (file/folder row render helper)
    _breadcrumbHtml,  // exposed for unit testing (breadcrumb render helper)
    _iconForExt       // exposed for unit testing (extension → icon map)
  };
})();
