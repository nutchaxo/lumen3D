/* ============================================================
   IRIBHM Microscopy Platform - Measurement Store
   ============================================================ */

const MeasurementStore = (() => {
  const _state = new Map();

  function key(datasetId, scope = 'viewer') {
    return `${scope}:${datasetId || 'unknown'}`;
  }

  function list(datasetId, scope = 'viewer') {
    return _clone(_state.get(key(datasetId, scope)) || []);
  }

  function setAll(datasetId, scope = 'viewer', items = []) {
    const normalized = Array.isArray(items) ? items.map(_normalize) : [];
    _state.set(key(datasetId, scope), normalized);
    return list(datasetId, scope);
  }

  function add(datasetId, scope = 'viewer', item = {}) {
    const items = _state.get(key(datasetId, scope)) || [];
    const next = _normalize(item);
    items.push(next);
    _state.set(key(datasetId, scope), items);
    return _clone(next);
  }

  function update(datasetId, scope = 'viewer', measurementId, patch = {}) {
    const items = _state.get(key(datasetId, scope)) || [];
    const index = items.findIndex(item => item.id === measurementId);
    if (index < 0) return null;
    items[index] = _normalize({ ...items[index], ...patch, id: items[index].id });
    _state.set(key(datasetId, scope), items);
    return _clone(items[index]);
  }

  function remove(datasetId, scope = 'viewer', measurementId) {
    const items = _state.get(key(datasetId, scope)) || [];
    const next = items.filter(item => item.id !== measurementId);
    _state.set(key(datasetId, scope), next);
    return list(datasetId, scope);
  }

  function clear(datasetId, scope = 'viewer') {
    _state.set(key(datasetId, scope), []);
    return [];
  }

  function toCsv(items = []) {
    const rows = [[
      'id',
      'scope',
      'dataset_id',
      'label',
      'type',
      'mode',
      'timepoint',
      'visible',
      'distance',
      'unit',
      'point_a',
      'point_b',
      'cell_a',
      'cell_b',
      'status',
      'created_at'
    ]];
    (items || []).forEach(item => {
      rows.push([
        item.id,
        item.scope || '',
        item.datasetId || '',
        item.label || '',
        item.type || '',
        item.mode || '',
        item.timepoint ?? '',
        item.visible !== false,
        item.distance ?? '',
        item.unit || '',
        JSON.stringify(item.points?.[0] || item.pointA || null),
        JSON.stringify(item.points?.[1] || item.pointB || null),
        item.cells?.[0] || item.cellA || '',
        item.cells?.[1] || item.cellB || '',
        item.status || '',
        item.createdAt || ''
      ]);
    });
    return rows.map(row => row.map(value => `"${String(value ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
  }

  function toJson(items = []) {
    return JSON.stringify({ version: 1, measurements: items || [] }, null, 2);
  }

  function _normalize(item = {}) {
    const type = item.type || 'distance';
    const scope = item.scope || 'viewer';
    const label = typeof item.label === 'string' ? item.label : `${scope === 'tracking' ? 'Track' : 'Measure'} ${String(item.id || '').slice(-4) || '1'}`;
    return {
      id: item.id || _id(),
      datasetId: item.datasetId || null,
      scope,
      type,
      mode: item.mode || (scope === 'tracking' ? 'snapshot' : 'snapshot'),
      label,
      color: item.color || '#ff4d4f',
      visible: item.visible !== false,
      timepoint: Number.isFinite(item.timepoint) ? item.timepoint : null,
      distance: Number.isFinite(item.distance) ? item.distance : null,
      unit: item.unit || 'units',
      status: item.status || 'ok',
      createdAt: item.createdAt || new Date().toISOString(),
      points: Array.isArray(item.points) ? _clone(item.points) : [],
      cells: Array.isArray(item.cells) ? [...item.cells] : [],
      labelOffset: item.labelOffset || null,
      metadata: item.metadata && typeof item.metadata === 'object' ? _clone(item.metadata) : {}
    };
  }

  function _id() {
    return `m_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  }

  function _clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  return {
    key,
    list,
    setAll,
    add,
    update,
    remove,
    clear,
    toCsv,
    toJson
  };
})();
