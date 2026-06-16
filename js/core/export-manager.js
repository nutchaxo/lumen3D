/* ============================================================
   IRIBHM Microscopy Platform — Export & Download Center
   ============================================================ */

const ExportManager = (() => {
  let _ctx = {};
  let _modal = null;
  let _customExports = [];

  function init(context = {}) {
    _ctx = context;
    _ensureModal();
  }

  function openDownloadCenter(context = null) {
    if (context) _ctx = { ..._ctx, ...context };
    _ensureModal();
    _ctx.dataset ||= null;
    _renderDownloads();
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
      _toast('Figure export is not available on this page');
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
      _toast('Graph export is not available on this page');
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
    _toast('Workspace saved');
    return payload;
  }

  function restoreWorkspace(scope = _ctx.scope || 'viewer') {
    const payload = WorkspaceState.load(_ctx.dataset?.id, scope);
    if (!payload) {
      _toast('No saved workspace found');
      return null;
    }
    _ctx.applyWorkspaceState?.(payload.state || {});
    _toast('Workspace restored');
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
            <h2 id="download-title">Download Center</h2>
            <p id="download-subtitle">Raw sources, web-ready assets, figures, analysis exports, and reproducible workspaces.</p>
          </div>
          <button class="btn btn-icon btn-ghost" data-export-close aria-label="Close">
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
      const action = e.target.closest('[data-export-action]')?.dataset.exportAction;
      if (action === 'canvas-png') exportCanvas({ mime: 'image/png' });
      if (action === 'canvas-webp') exportCanvas({ mime: 'image/webp' });
      if (action === 'graph-png') exportGraph('png');
      if (action === 'graph-svg') exportGraph('svg');
      if (action === 'graph-csv') exportGraph('csv');
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
      raw: 'Raw source files',
      web: 'Web-ready data',
      generated: 'Generated analysis',
      figure: 'Figures & media',
      workspace: 'Workspace'
    };
    const hasCanvas = Boolean(_ctx.getCanvas?.());
    const hasGraph = Boolean(_ctx.getGraph?.() && window.Plotly);
    _customExports = Array.isArray(_ctx.getCustomExports?.()) ? _ctx.getCustomExports() : [];

    body.innerHTML = `
      ${dataset ? `
        <section class="download-category">
          <h3>${Utils.escapeHtml(dataset.name || dataset.id || 'Dataset')}</h3>
          <div class="download-empty" style="text-align:left">
            ${Utils.escapeHtml(_datasetIntro(dataset))}
          </div>
        </section>
      ` : ''}
      <section class="export-quick-actions">
        ${_quickAction('canvas-png', 'image', 'Figure PNG', hasCanvas, 'No visible canvas here')}
        ${_quickAction('canvas-webp', 'image-down', 'Figure WebP', hasCanvas, 'No visible canvas here')}
        ${_quickAction('graph-png', 'bar-chart-2', 'Graph PNG', hasGraph, 'No visible graph here')}
        ${_quickAction('graph-svg', 'line-chart', 'Graph SVG', hasGraph, 'No visible graph here')}
        ${_quickAction('graph-csv', 'table', 'Graph CSV', hasGraph, 'No visible graph here')}
        <button class="btn btn-outline btn-sm" data-export-action="workspace-json"><i data-lucide="braces"></i> Workspace JSON</button>
        <button class="btn btn-outline btn-sm" data-export-action="save-workspace"><i data-lucide="save"></i> Save state</button>
        <button class="btn btn-outline btn-sm" data-export-action="restore-workspace"><i data-lucide="folder-open"></i> Restore state</button>
        ${_customExports.map(item => _quickAction(item.action, item.icon || 'flask-conical', item.label, item.enabled !== false, item.disabledTitle || 'Export unavailable')).join('')}
      </section>
      ${Object.keys(categoryNames).map(key => _categoryHtml(categoryNames[key], groups[key] || [])).join('')}
    `;
    if (window.lucide) lucide.createIcons({ nodes: [body, _modal] });
  }

  function _quickAction(action, icon, label, enabled, disabledTitle) {
    const disabled = enabled ? '' : `disabled title="${Utils.escapeHtml(disabledTitle)}"`;
    return `<button class="btn btn-outline btn-sm" data-export-action="${action}" ${disabled}><i data-lucide="${icon}"></i> ${label}</button>`;
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
          <div class="download-empty">No file currently available for this category.</div>
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
    const size = item.sizeBytes ? Utils.formatFileSize(item.sizeBytes) : (item.count ? `${item.count} files` : '');
    const warning = item.large ? '<span class="download-warning">large file</span>' : '';
    const primary = item.primary ? '<span class="download-warning">recommended</span>' : '';
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
    downloadBlob: _downloadBlob,
    toast: _toast,
    saveWorkspace,
    restoreWorkspace,
    _itemHtml  // exposed for unit testing (pure HTML render helper)
  };
})();
