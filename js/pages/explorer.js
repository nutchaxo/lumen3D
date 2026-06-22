/* ============================================================
   IRIBHM Microscopy Platform — Explorer Logic
   ============================================================ */

const Explorer = (() => {
  let _currentView = 'grid'; // 'grid' or 'list'
  let _filters = {
    type: 'all',
    stage: 'all',
    search: ''
  };
  let _sortBy = 'name_asc';

  /**
   * Initialize the Explorer
   */
  async function init() {
    // Init core systems
    Theme.init();
    await I18n.init();
    await Catalog.load();
    document.title = 'Data Explorer - IRIBHM Microscopy';
    if (typeof ExportManager !== 'undefined') ExportManager.init({ scope: 'explorer' });

    _updateThemeIcon();
    Theme.onChange(_updateThemeIcon);

    // Read URL params
    const params = new URLSearchParams(window.location.search);
    if (params.has('type')) {
      const type = params.get('type');
      if (['fixed', 'live', 'tracking'].includes(type)) {
        _filters.type = type;
        const radio = document.querySelector(`input[name="filter-type"][value="${type}"]`);
        if (radio) radio.checked = true;
      }
    }

    // Populate dynamic filters
    _populateStageFilter();

    // Bind event listeners
    _bindEvents();

    // Initial render
    _render();

    if (window.lucide) lucide.createIcons();
    document.body.classList.add('loaded');
  }

  function _updateThemeIcon() {
    const btn = document.getElementById('theme-toggle');
    if (!btn) return;
    const icon = Theme.isDark() ? 'moon' : 'sun';
    btn.innerHTML = `<i data-lucide="${icon}" style="width:20px;height:20px"></i>`;
    if (window.lucide) lucide.createIcons({ nodes: [btn] });
  }

  function _populateStageFilter() {
    const stages = Catalog.getStages();
    const group = document.getElementById('filter-stage-group');
    if (!group || stages.length === 0) return;

    stages.forEach(stage => {
      const label = Utils.el('label', { class: 'filter-option' });
      const input = Utils.el('input', { type: 'radio', name: 'filter-stage', value: stage });
      const span = Utils.el('span', {}, Utils.formatStage(stage));
      label.appendChild(input);
      label.appendChild(span);
      group.appendChild(label);
    });
  }

  function _bindEvents() {
    // View Toggles
    const btnGrid = document.getElementById('btn-view-grid');
    const btnList = document.getElementById('btn-view-list');

    btnGrid?.addEventListener('click', () => {
      _currentView = 'grid';
      btnGrid.classList.add('active');
      btnList.classList.remove('active');
      _render();
    });

    btnList?.addEventListener('click', () => {
      _currentView = 'list';
      btnList.classList.add('active');
      btnGrid.classList.remove('active');
      _render();
    });

    // Search Input
    const searchInput = document.getElementById('search-input');
    searchInput?.addEventListener('input', Utils.debounce((e) => {
      _filters.search = e.target.value.trim();
      _render();
    }, 300));

    // Radio Filters
    document.querySelectorAll('input[type="radio"]').forEach(radio => {
      radio.addEventListener('change', (e) => {
        const name = e.target.name;
        const value = e.target.value;
        if (name === 'filter-type') _filters.type = value;
        if (name === 'filter-stage') _filters.stage = value;
        _render();
      });
    });

    // Sort Select
    const sortSelect = document.getElementById('sort-select');
    sortSelect?.addEventListener('change', (e) => {
      _sortBy = e.target.value;
      _render();
    });

    // Clear Filters
    document.getElementById('btn-clear-filters')?.addEventListener('click', () => {
      _filters = { type: 'all', stage: 'all', search: '' };
      if (searchInput) searchInput.value = '';
      document.querySelector('input[name="filter-type"][value="all"]').checked = true;
      document.querySelector('input[name="filter-stage"][value="all"]').checked = true;
      _render();
    });

    document.getElementById('dataset-container')?.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-download-id]');
      const compare = e.target.closest('[data-compare-id]');
      if (btn) {
        e.preventDefault();
        e.stopPropagation();
        const dataset = Catalog.getById(btn.dataset.downloadId);
        ExportManager.openDownloadCenter({ dataset, scope: 'explorer' });
      }
      if (compare) {
        e.preventDefault();
        e.stopPropagation();
        window.location.href = `compare.html?add=${encodeURIComponent(compare.dataset.compareId)}`;
      }
    });
    document.getElementById('dataset-container')?.addEventListener('keydown', (e) => {
      if (!['Enter', ' '].includes(e.key)) return;
      if (!e.target.closest('[data-download-id], [data-compare-id]')) return;
      e.preventDefault();
      e.target.click();
    });
  }

  function _render() {
    const container = document.getElementById('dataset-container');
    const resultsCount = document.getElementById('results-count');
    if (!container) return;

    // Filter
    let filtered = Catalog.filter({
      type: _filters.type !== 'all' ? _filters.type : null,
      stage: _filters.stage !== 'all' ? _filters.stage : null,
      search: _filters.search
    });

    // Sort
    const [sortField, sortDir] = _sortBy.split('_');
    filtered = Catalog.sort(filtered, sortField, sortDir === 'asc');

    // Update count
    if (resultsCount) {
      resultsCount.textContent = I18n.t('explorer.resultsCount', { count: filtered.length });
    }

    // Render HTML
    if (filtered.length === 0) {
      container.className = 'empty-state';
      container.innerHTML = `
        <i data-lucide="search-x"></i>
        <h3>${I18n.t('app.noResults')}</h3>
        <p style="margin-top:var(--space-2)">Try adjusting your filters or search query.</p>
      `;
    } else {
      container.className = _currentView === 'grid' ? 'dataset-grid' : 'dataset-list';
      // PERF-028: single innerHTML write. The meta separator is emitted as an
      // HTML entity (&middot;) at the source so it renders correctly regardless
      // of charset handling, removing the former second-pass mojibake repair.
      container.innerHTML = filtered.map(d => _currentView === 'grid' ? _createGridCard(d) : _createListCard(d)).join('');
    }

    if (window.lucide) lucide.createIcons({ nodes: [container] });
  }

  function _createGridCard(dataset) {
    const typeLabels = { fixed: I18n.t('explorer.fixed'), live: I18n.t('explorer.live'), tracking: I18n.t('explorer.tracking') };
    const typeClass = { fixed: 'badge-fixed', live: 'badge-live', tracking: 'badge-tracking' };
    const typeIcons = { fixed: 'layers', live: 'video', tracking: 'git-branch' };

    const stageDisplay = Utils.formatStage(dataset.stage);
    const dateDisplay = Utils.formatDate(dataset.date);

    const metaItems = [];
    if (stageDisplay !== '—') metaItems.push(`<span>${stageDisplay}</span>`);
    if (dateDisplay !== '—') metaItems.push(`<span>${dateDisplay}</span>`);
    if (dataset.nCells) metaItems.push(`<span>${dataset.nCells} ${I18n.t('tracking.cells').toLowerCase()}</span>`);

    const gradients = {
      fixed: 'linear-gradient(135deg, #00D2FF22, #0F346044)',
      live: 'linear-gradient(135deg, #FFA72622, #16213E44)',
      tracking: 'linear-gradient(135deg, #00A65422, #1A1A2E44)'
    };

    return `
      <a href="${_datasetUrl(dataset)}" class="card animate-fade-in-up" style="text-decoration:none;color:inherit;animation-duration:0.3s;">
        <div class="card-image" style="background: ${gradients[dataset.type] || gradients.fixed}; display:flex; align-items:center; justify-content:center;">
          ${_datasetPreview(dataset, typeIcons)}
        </div>
        <div class="card-body">
          <div style="display:flex;align-items:center;gap:var(--space-2);margin-bottom:var(--space-2)">
            <span class="badge badge-dot ${typeClass[dataset.type]}">${typeLabels[dataset.type]}</span>
            ${_availabilityBadges(dataset)}
          </div>
          <div class="card-title">${Utils.escapeHtml(dataset.name)}</div>
          <div class="card-subtitle">${Utils.escapeHtml(dataset.description || '')}</div>
          <div class="card-meta">${metaItems.join('<span style="opacity:0.3">&middot;</span>')}</div>
        </div>
        <div class="card-actions dataset-card-actions">
          <span class="btn btn-primary btn-sm"><i data-lucide="eye"></i> View</span>
          <span class="btn btn-outline btn-sm" role="button" tabindex="0" data-compare-id="${Utils.escapeHtml(dataset.id)}"><i data-lucide="columns-3"></i> Compare</span>
          <span class="btn btn-outline btn-sm" role="button" tabindex="0" data-download-id="${Utils.escapeHtml(dataset.id)}"><i data-lucide="download"></i> Download</span>
        </div>
      </a>
    `;
  }

  function _createListCard(dataset) {
    const typeLabels = { fixed: I18n.t('explorer.fixed'), live: I18n.t('explorer.live'), tracking: I18n.t('explorer.tracking') };
    const typeClass = { fixed: 'badge-fixed', live: 'badge-live', tracking: 'badge-tracking' };
    const typeIcons = { fixed: 'layers', live: 'video', tracking: 'git-branch' };

    const stageDisplay = Utils.formatStage(dataset.stage);
    const dateDisplay = Utils.formatDate(dataset.date);

    const gradients = {
      fixed: 'linear-gradient(135deg, #00D2FF22, #0F346044)',
      live: 'linear-gradient(135deg, #FFA72622, #16213E44)',
      tracking: 'linear-gradient(135deg, #00A65422, #1A1A2E44)'
    };

    return `
      <a href="${_datasetUrl(dataset)}" class="dataset-list-item animate-fade-in" style="animation-duration:0.3s;">
        <div class="dataset-list-icon" style="background: ${gradients[dataset.type] || gradients.fixed};">
          ${dataset.thumbnail ? `<img src="${dataset.thumbnail}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:inherit">` : `<i data-lucide="${typeIcons[dataset.type]}" style="color:var(--text-muted);opacity:0.6"></i>`}
        </div>
        <div class="dataset-list-content">
          <div style="display:flex;align-items:center;gap:var(--space-2);margin-bottom:var(--space-1)">
            <span class="badge badge-dot ${typeClass[dataset.type]}" style="font-size:10px;padding:2px 6px;">${typeLabels[dataset.type]}</span>
            <span style="font-size:var(--text-sm);color:var(--text-secondary);">${stageDisplay !== '—' ? stageDisplay + ' &middot; ' : ''}${dateDisplay}</span>
            ${_availabilityBadges(dataset)}
          </div>
          <div class="dataset-list-title">${Utils.escapeHtml(dataset.name)}</div>
          <div style="font-size:var(--text-sm);color:var(--text-secondary);">${Utils.escapeHtml(dataset.description || '')}</div>
        </div>
        <div style="display:flex;align-items:center;padding:0 var(--space-4);">
          <span class="btn btn-primary btn-sm">View</span>
          <span class="btn btn-outline btn-sm" role="button" tabindex="0" data-compare-id="${Utils.escapeHtml(dataset.id)}">Compare</span>
          <span class="btn btn-outline btn-sm" role="button" tabindex="0" data-download-id="${Utils.escapeHtml(dataset.id)}">Download</span>
        </div>
      </a>
    `;
  }

  function _datasetUrl(dataset) {
    const page = dataset.type === 'tracking' ? 'tracking.html' : 'viewer.html';
    return `${page}?id=${encodeURIComponent(dataset.id)}`;
  }

  function _datasetPreview(dataset, typeIcons) {
    if (dataset.thumbnail) {
      return `<img src="${dataset.thumbnail}" alt="">`;
    }
    return `<i data-lucide="${typeIcons[dataset.type]}" style="width:48px;height:48px;color:var(--text-muted);opacity:0.4"></i>`;
  }

  function _availabilityBadges(dataset) {
    const downloads = dataset.downloads || [];
    const hasRaw = downloads.some(item => item.category === 'raw');
    const hasTracking = dataset.type === 'tracking' || Boolean(dataset.tracksPath || dataset.modelPath);
    const hasLinked = (Catalog.getRelated?.(dataset.id) || []).length > 0;
    const badges = [];
    if (hasLinked) badges.push('<span class="availability-badge">Linked</span>');
    if (hasRaw) badges.push('<span class="availability-badge">Raw</span>');
    if (dataset.path) badges.push('<span class="availability-badge">Web</span>');
    if (hasTracking) badges.push('<span class="availability-badge">Tracking</span>');
    return badges.join('');
  }

  function refresh() {
    _render();
  }

  return { init, refresh };
})();

// DEAD-035: global name retained for the inline HTML onclick handlers; the
// implementation lives once in Utils (shared by landing + explorer).
window.toggleDropdown = window.toggleDropdown || function toggleDropdown(id) {
  Utils.toggleDropdown(id);
};

window.switchLanguage = window.switchLanguage || async function switchLanguage(lang) {
  await I18n.setLanguage(lang);
  Utils.closeDropdowns(); // DEAD-035: shared dropdown-close step
  // Page-specific: re-render the dataset grid in the new language
  Explorer.refresh();
};

// Bootstrap
document.addEventListener('DOMContentLoaded', Explorer.init);
