/* ============================================================
   IRIBHM Microscopy Platform - Volume Source Manager
   ============================================================ */

const VolumeSourceManager = (() => {
  function normalizeSources(dataset = null) {
    const listed = Array.isArray(dataset?.volumeSources) ? dataset.volumeSources : [];
    if (listed.length) {
      return listed.map((source, index) => {
        const kind = source.kind || 'webstack';
        return {
          ...source,
          kind,
          label: source.label || _label(kind),
          priority: Number.isFinite(source.priority) ? source.priority : index,
          available: source.available !== false,
          multiscale: Boolean(source.multiscale),
          path: source.path || null
        };
      }).sort((a, b) => a.priority - b.priority);
    }

    return [{
      kind: 'webstack',
      label: _label('webstack'),
      priority: 0,
      available: true,
      multiscale: false,
      path: dataset?.path ? `DATA_WEB/${dataset.path}` : null
    }];
  }

  function preferred(dataset = null, preferredKind = null) {
    const sources = normalizeSources(dataset);
    if (preferredKind) {
      const exact = sources.find(source => source.kind === preferredKind && source.available);
      if (exact) return exact;
    }
    return sources.find(source => source.available) || sources[0] || null;
  }

  function nativeSliceSource(dataset = null, preferredKind = null) {
    return preferred(dataset, preferredKind);
  }

  async function describe(dataset = null, preferredKind = null) {
    const source = preferred(dataset, preferredKind);
    if (!source) return null;
    return {
      ...source,
      ok: Boolean(source.available),
      message: source.available ? 'Volume source is available.' : 'Volume source unavailable.'
    };
  }

  function _label(kind) {
    if (kind === 'bricks') return 'Chunked bricks volume';
    if (kind === 'deepzoom2d') return '2D source tiles pyramid';
    if (kind === 'webstack') return 'Web slice stack';
    return 'Volume source';
  }

  return {
    normalizeSources,
    preferred,
    nativeSliceSource,
    describe
  };
})();
