/* ============================================================
   IRIBHM Microscopy Platform — Data Catalog
   ============================================================
   Loads and manages the dataset catalog. Provides filtering,
   searching, and dataset retrieval functions.
   ============================================================ */

const Catalog = (() => {
  let _datasets = [];
  let _loaded = false;

  /**
   * Load the catalog from JSON
   * @returns {Promise<void>}
   */
  async function load() {
    if (_loaded) return;
    try {
      const resp = await fetch(`./DATA_WEB/catalog.json?t=${Date.now()}`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      const datasetsArray = Array.isArray(data) ? data : (data.datasets || []);
      _datasets = datasetsArray.map(dataset => ({
        ...dataset,
        volumeSources: typeof VolumeSourceManager !== 'undefined'
          ? VolumeSourceManager.normalizeSources(dataset)
          : (dataset.volumeSources || [])
      }));
      _loaded = true;
    } catch (err) {
      console.warn('[Catalog] Failed to load catalog, using embedded data:', err);
      _datasets = _getEmbeddedCatalog();
      _loaded = true;
    }
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
      const q = filters.search.toLowerCase();
      result = result.filter(d =>
        d.name?.toLowerCase().includes(q) ||
        d.description?.toLowerCase().includes(q) ||
        d.markers?.some(m => m.toLowerCase().includes(q)) ||
        d.channels?.some(c => _channelName(c).toLowerCase().includes(q)) ||
        d.stage?.toLowerCase().includes(q) ||
        d.embryo?.toLowerCase().includes(q) ||
        d.regions?.some(r => r.toLowerCase().includes(q))
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
        (ds.linkedTrackingId && d.id === ds.linkedTrackingId) ||
        (d.linkedTrackingId && d.linkedTrackingId === ds.id) ||
        (ds.embryo && d.embryo === ds.embryo && d.stage === ds.stage) ||
        (ds.date && ds.date !== 'Unknown' && d.date === ds.date && d.stage === ds.stage) ||
        (ds.relatedIds && ds.relatedIds.includes(d.id)) ||
        (d.relatedIds && d.relatedIds.includes(ds.id))
      )
    );
  }

  function getRelationMeta(sourceId, targetId) {
    const source = getById(sourceId);
    const target = getById(targetId);
    if (!source || !target) return null;

    const explicitTrackingLink = source.linkedTrackingId === target.id || target.linkedTrackingId === source.id;
    const explicitRelated = Array.isArray(source.relatedIds) && source.relatedIds.includes(target.id)
      || Array.isArray(target.relatedIds) && target.relatedIds.includes(source.id);
    const sameEmbryoStage = Boolean(source.embryo && target.embryo && source.embryo === target.embryo && source.stage === target.stage);
    const registration = source.registration || target.registration || null;
    const qc = registration?.qcSummary || null;

    let type = 'context';
    if (explicitTrackingLink) type = 'tracking-link';
    else if (registration) type = 'registered';
    else if (explicitRelated) type = 'related';
    else if (sameEmbryoStage) type = 'same-embryo';

    return {
      type,
      registration,
      qcSummary: qc,
      calibrationAvailable: Boolean(registration?.transforms?.length),
      appliedToVolume: Boolean(registration?.appliedToVolume),
      label: _relationLabel(type),
      description: _relationDescription(type, registration, qc)
    };
  }

  /**
   * Get statistics summary
   * @returns {object}
   */
  function getStats() {
    const tracking = _datasets.filter(d => d.type === 'tracking');
    const embryos = new Set();
    _datasets.forEach(d => {
      if (d.embryo) embryos.add(`${d.stage || 'unknown'}-${d.embryo}-${d.date || ''}`);
    });
    const regions = new Set();
    tracking.forEach(d => {
      if (d.regions) d.regions.forEach(r => regions.add(r));
    });

    return {
      totalDatasets: _datasets.length,
      totalEmbryos: embryos.size,
      totalCells: tracking.reduce((sum, d) => sum + (d.nCells || 0), 0),
      totalRegions: regions.size,
      byType: _countByType()
    };
  }

  /** Counters keyed by dataset type ('3d', '2d', 'live', 'tracking'). Every known
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

  // White-label: the relation type key stays 'same-embryo' (it is only emitted for
  // datasets carrying specimen+stage metadata), but the human label uses the
  // operator's specimen noun instead of a hardcoded 'embryo'.
  function _specimenNoun() {
    try {
      if (typeof InstanceConfig !== 'undefined' && InstanceConfig.get) {
        // `specimen.singular` is localizable: the stored value is a flat string OR
        // a per-locale object, so a bare get() can hand back an object that the
        // template literals below would render as '[object Object]'.
        const v = InstanceConfig.localized
          ? InstanceConfig.localized(InstanceConfig.get('specimen.singular'))
          : InstanceConfig.get('specimen.singular');
        if (typeof v === 'string' && v) return v;
      }
    } catch (_) { /* fall through */ }
    return 'sample';
  }

  /** The displayed name of a dataset type — never the raw id, which is an
   *  internal token the operator can rename in config/instance.json. */
  function _typeLabel(type) {
    if (!type) return '';
    if (typeof Utils !== 'undefined' && Utils.datasetTypeLabel) return Utils.datasetTypeLabel(type);
    return String(type);
  }

  function _relationLabel(type) {
    return {
      // 'tracking-link' is an internal relation enum; the word shown to the
      // operator is the label of the 'tracking' DATASET TYPE.
      'tracking-link': `Linked ${_typeLabel('tracking')}`,
      registered: 'Registered',
      related: 'Related dataset',
      'same-embryo': `Same ${_specimenNoun()}/stage`,
      context: 'Context dataset'
    }[type] || 'Related dataset';
  }

  function _relationDescription(type, registration, qc) {
    if (registration) {
      const method = registration.method || 'registration';
      const median = Number.isFinite(qc?.medianRmsAfter) ? `, median RMS ${qc.medianRmsAfter.toFixed(3)}` : '';
      return `${method}${median}`;
    }
    if (type === 'tracking-link') return `${_typeLabel('tracking')} dataset linked to this acquisition.`;
    if (type === 'same-embryo') return `Matched by ${_specimenNoun()} and stage metadata.`;
    if (type === 'related') return 'Explicitly linked by dataset metadata.';
    return 'Related by experimental context.';
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

  function _stageNumber(stage) {
    if (typeof stage === 'number') return stage;
    if (!stage) return 0;
    const match = String(stage).match(/^E(\d+)(?:\.(\d+))?$/i);
    if (!match) return 0;
    if (match[2]) return parseFloat(`${match[1]}.${match[2]}`);

    const digits = match[1];
    if (digits.length <= 1) return parseFloat(digits);
    if (digits.length === 2) {
      const value = parseFloat(digits);
      return value >= 50 ? parseFloat(`${digits[0]}.${digits.slice(1)}`) : value;
    }

    const firstTwo = parseInt(digits.slice(0, 2), 10);
    if (firstTwo >= 10 && firstTwo <= 20) {
      return parseFloat(`${digits.slice(0, 2)}.${digits.slice(2)}`);
    }
    return parseFloat(`${digits[0]}.${digits.slice(1)}`);
  }

  return {
    load,
    getAll,
    getById,
    filter,
    getStages,
    getRelated,
    getRelationMeta,
    getStats,
    sort
  };
})();
