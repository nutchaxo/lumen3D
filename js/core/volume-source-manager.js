/* ============================================================
   IRIBHM Microscopy Platform - Volume Source Manager
   ============================================================ */

const VolumeSourceManager = (() => {
  // EDGE-031 (Rule 1.4): the source kinds the renderer can actually mount. A
  // timelapse is a 'bricks' source with one brick tree per timepoint.
  const ALLOWED_KINDS = new Set(['webstack', 'bricks']);

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
      .map((source, index) => ({ source, index }))
      // Sources with an explicit priority come first, by priority; the others keep
      // their listed order after them (a positional index is not a priority).
      .sort((a, b) => {
        const pa = Number.isFinite(a.source.priority) ? a.source.priority : Infinity;
        const pb = Number.isFinite(b.source.priority) ? b.source.priority : Infinity;
        return pa === pb ? a.index - b.index : (pa < pb ? -1 : 1);
      })
      .map(({ source }, rank) => {
        const kind = source.kind || 'webstack';
        return {
          ...source,
          kind,
          label: source.label || _label(kind),
          priority: rank,
          available: source.available !== false,
          multiscale: Boolean(source.multiscale),
          path: source.path || null
        };
      });
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

  /** The source to display: the preferred kind when available, else the first
   *  available one; null when none is available. */
  function preferred(dataset = null, preferredKind = null) {
    const sources = normalizeSources(dataset);
    if (preferredKind) {
      const exact = sources.find(source => source.kind === preferredKind && source.available);
      if (exact) return exact;
    }
    return sources.find(source => source.available) || null;
  }

  /** True when the dataset has a slice stack (`preview/slices/`, `slices/`) to read: an
   *  available 'webstack' source. A dataset that lists only 'bricks' sources has no
   *  slice file at all, and a slice URL built for it is a guaranteed 404 — a burst of
   *  hundreds of them per timepoint, which a shared host's firewall answers with a ban.
   *  A dataset that lists nothing is a legacy slice-stack dataset (normalizeSources). */
  function hasSliceStack(dataset = null) {
    return normalizeSources(dataset).some(source => source.kind === 'webstack' && source.available);
  }

  function _label(kind) {
    if (kind === 'bricks') return 'Chunked bricks volume';
    if (kind === 'webstack') return 'Web slice stack';
    return 'Volume source';
  }

  return {
    normalizeSources,
    preferred,
    hasSliceStack
  };
})();
