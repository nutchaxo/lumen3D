/* ============================================================
   IRIBHM Microscopy Platform - Volume Source Manager
   ============================================================ */

const VolumeSourceManager = (() => {
  // EDGE-031 (Rule 1.4): the source kinds the renderer can actually mount.
  const ALLOWED_KINDS = new Set(['webstack', 'bricks', 'live']);

  function normalizeSources(dataset = null) {
    const listed = Array.isArray(dataset?.volumeSources) ? dataset.volumeSources : [];
    // EDGE-031: reject (drop + warn) entries the renderer can't handle instead of
    // normalizing them into a plausible-but-broken source — an unknown kind, or a
    // path that is present but not a string.
    const normalized = listed
      .filter((source) => {
        const kind = (source && source.kind) || 'webstack';
        if (!ALLOWED_KINDS.has(kind)) {
          console.warn(`[VolumeSourceManager] dropping volume source with unknown kind "${source && source.kind}"`);
          return false;
        }
        if (source && source.path != null && typeof source.path !== 'string') {
          console.warn('[VolumeSourceManager] dropping volume source with a non-string path');
          return false;
        }
        return true;
      })
      .map((source, index) => {
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
    if (normalized.length) return normalized;

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
