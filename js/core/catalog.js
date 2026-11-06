/* ============================================================
   IRIBHM Microscopy Platform — Data Catalog
   ============================================================
   Loads and manages the dataset catalog. Provides filtering,
   searching, and dataset retrieval functions.
   ============================================================ */

const Catalog = (() => {
  let _datasets = [];
  let _loaded = false;
  let _inflight = null;
  let _loadError = null;

  /**
   * Load the catalog from JSON. Concurrent callers share one request; a failed load is
   * not remembered as "loaded", so the next call retries (see getLoadError()).
   * `force` refetches even when a catalog is already held (the pages' Retry button).
   * @param {{force?: boolean}} [opts]
   * @returns {Promise<void>}
   */
  function load(opts) {
    if (_loaded && !(opts && opts.force)) return Promise.resolve();
    if (!_inflight) _inflight = _fetchCatalog().finally(() => { _inflight = null; });
    return _inflight;
  }

  /**
   * Why the last load failed, or null when the catalog loaded. Lets a page say
   * "could not load" instead of "nothing here". `code`: 'http' (status = the HTTP
   * status), 'network' (status 0), 'parse' (body is not JSON), 'shape' (JSON, but
   * not a list of datasets). Carries no message text: nothing for a page to print.
   * @returns {{code: string, status: number}|null}
   */
  function getLoadError() {
    return _loadError;
  }

  async function _fetchCatalog() {
    let resp;
    try {
      // The index is generated per request from the metadata.json files, so it must be
      // revalidated each time (a dataset that was just published has to show up).
      resp = await fetch('./DATA_WEB/catalog.json', { cache: 'no-cache' });
    } catch (err) {
      return _fail('network', 0, err);
    }
    if (!resp || !resp.ok) return _fail('http', resp ? Number(resp.status) || 0 : 0, new Error(`HTTP ${resp && resp.status}`));
    let data;
    try {
      data = await resp.json();
    } catch (err) {
      return _fail('parse', resp.status, err);
    }
    const datasetsArray = Array.isArray(data) ? data : (data && data.datasets === undefined ? [] : data && data.datasets);
    if (!Array.isArray(datasetsArray)) return _fail('shape', resp.status, new Error('catalog is not a list'));
    _datasets = datasetsArray.map(dataset => ({
      ...dataset,
      volumeSources: typeof VolumeSourceManager !== 'undefined'
        ? VolumeSourceManager.normalizeSources(dataset)
        : (dataset.volumeSources || [])
    }));
    _loaded = true;
    _loadError = null;
  }

  function _fail(code, status, err) {
    console.warn('[Catalog] Failed to load catalog:', err);
    _datasets = _getEmbeddedCatalog();
    _loaded = false;
    _loadError = { code, status };
  }

  /**
   * Get all datasets
   * @returns {Array}
   */
  function getAll() {
    return _datasets;
  }

  /**
   * Get a dataset by ID
   * @param {string} id  '<type>/<folder>', e.g. '3d/Egfl7eGFP-E8-5'
   * @returns {object|null}
   */
  function getById(id) {
    const wanted = String(id || '');
    if (!wanted) return null;
    return _datasets.find(d => d.id === wanted) || null;
  }

  /**
   * Filter datasets
   * @param {object} filters - { type, stage, search, markers }
   * @returns {Array}
   */
  function filter(filters = {}) {
    let result = [..._datasets];

    if (filters.type && filters.type !== 'all') {
      result = result.filter(d => d.type === filters.type);
    }

    if (filters.stage) {
      result = result.filter(d => d.stage === filters.stage);
    }

    if (filters.search) {
      const q = String(filters.search).toLowerCase();
      result = result.filter(d =>
        String(d.name ?? '').toLowerCase().includes(q) ||
        String(d.description ?? '').toLowerCase().includes(q) ||
        d.markers?.some(m => String(m).toLowerCase().includes(q)) ||
        d.channels?.some(c => _channelName(c).toLowerCase().includes(q)) ||
        String(d.stage ?? '').toLowerCase().includes(q) ||
        String(d.embryo ?? '').toLowerCase().includes(q) ||
        d.regions?.some(r => String(typeof r === 'object' && r ? r.name : r).toLowerCase().includes(q))
      );
    }

    if (filters.markers && filters.markers.length > 0) {
      result = result.filter(d =>
        filters.markers.some(m => d.markers?.includes(m))
      );
    }

    return result;
  }

  /**
   * Get unique stages across all datasets
   * @returns {Array<string>}
   */
  function getStages() {
    const stages = new Set(_datasets.map(d => d.stage).filter(Boolean));
    return [...stages].sort((a, b) => _stageNumber(a) - _stageNumber(b));
  }

  /**
   * Get related datasets for a given dataset
   * @param {string} id - Dataset ID
   * @returns {Array}
   */
  function getRelated(id) {
    const ds = getById(id);
    if (!ds) return [];

    // Find datasets with matching embryo/stage/date or explicit relations.
    return _datasets.filter(d =>
      d.id !== id && (
        (ds.embryo && d.embryo === ds.embryo && d.stage === ds.stage) ||
        (ds.date && ds.date !== 'Unknown' && d.date === ds.date && d.stage === ds.stage) ||
        (ds.relatedIds && ds.relatedIds.includes(d.id)) ||
        (d.relatedIds && d.relatedIds.includes(ds.id))
      )
    );
  }

  /**
   * Get statistics summary
   * @returns {object}
   */
  function getStats() {
    // Cell tracking rides on a timelapse: the counts come from the `tracking`
    // block a tracked `live` dataset carries in its metadata.
    const tracked = _datasets.filter(d => d.tracking && typeof d.tracking === 'object');
    const embryos = new Set();
    _datasets.forEach(d => {
      if (d.embryo) embryos.add(`${d.stage || 'unknown'}-${d.embryo}-${d.date || ''}`);
    });
    const regions = new Set();
    tracked.forEach(d => {
      (Array.isArray(d.tracking.regions) ? d.tracking.regions : []).forEach(r => {
        const name = typeof r === 'string' ? r : r?.name;
        if (name) regions.add(name);
      });
    });

    return {
      totalDatasets: _datasets.length,
      totalEmbryos: embryos.size,
      totalCells: tracked.reduce((sum, d) => sum + (Number(d.tracking.cellCount) || 0), 0),
      totalRegions: regions.size,
      byType: _countByType()
    };
  }

  /** Counters keyed by dataset type ('3d', '2d', 'live'). Every known
   *  type is seeded at 0 so a caller can read a counter without an existence test;
   *  a type the catalog carries but Utils does not know still gets a key rather
   *  than disappearing from the totals. */
  function _countByType() {
    const counts = {};
    const known = (typeof Utils !== 'undefined' && Array.isArray(Utils.DATASET_TYPES))
      ? Utils.DATASET_TYPES : [];
    known.forEach(type => { counts[type] = 0; });
    _datasets.forEach(d => {
      if (!d.type) return;
      counts[d.type] = (counts[d.type] || 0) + 1;
    });
    return counts;
  }

  /**
   * Sort datasets
   * @param {Array} datasets
   * @param {string} sortBy - 'name', 'date', 'stage', 'type'
   * @param {boolean} ascending
   * @returns {Array}
   */
  function sort(datasets, sortBy = 'name', ascending = true) {
    const sorted = [...datasets].sort((a, b) => {
      let cmp = 0;
      switch (sortBy) {
        case 'name':
          cmp = (a.name || '').localeCompare(b.name || '');
          break;
        case 'date':
          cmp = (a.date || '').localeCompare(b.date || '');
          break;
        case 'stage':
          cmp = _stageNumber(a.stage || a.stageNumeric) - _stageNumber(b.stage || b.stageNumeric);
          break;
        case 'type':
          // Ordering by the raw type id would read '2d' < '3d' < 'live' < 'tracking',
          // an order the operator never sees; sort on the name that is displayed.
          cmp = _typeLabel(a.type).localeCompare(_typeLabel(b.type));
          break;
        default:
          cmp = 0;
      }
      return ascending ? cmp : -cmp;
    });
    return sorted;
  }

  /** The displayed name of a dataset type — never the raw id, which is an
   *  internal token the operator can rename in config/instance.json. */
  function _typeLabel(type) {
    if (!type) return '';
    if (typeof Utils !== 'undefined' && Utils.datasetTypeLabel) return Utils.datasetTypeLabel(type);
    return String(type);
  }

  /**
   * Fallback when catalog.json cannot be loaded.
   * In normal operation, catalog.json is always generated by the preprocessing pipeline.
   */
  function _getEmbeddedCatalog() {
    return [];
  }

  function _channelName(channel) {
    if (!channel) return '';
    return typeof channel === 'string' ? channel : (channel.name || '');
  }

  // The stage rule lives in Utils (loaded before this file on every page that has a catalog).
  function _stageNumber(stage) {
    if (typeof Utils !== 'undefined' && typeof Utils.stageNumber === 'function') return Utils.stageNumber(stage);
    return (typeof stage === 'number' && Number.isFinite(stage)) ? stage : 0;
  }

  return {
    load,
    getLoadError,
    getAll,
    getById,
    filter,
    getStages,
    getRelated,
    getStats,
    sort
  };
})();
