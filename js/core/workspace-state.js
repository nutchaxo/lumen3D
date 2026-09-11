/* ============================================================
   IRIBHM Microscopy Platform — Workspace State
   ============================================================ */

const WorkspaceState = (() => {
  const VERSION = 2;
  const PREFIX = 'iribhm.workspace.';

  // The dataset id is baked into the storage key, so renaming the dataset types
  // would orphan every workspace an operator saved before the rename. These are
  // the two type ids that changed; the migration below rewrites the keys in place
  // and is a no-op on a browser that holds none of them.
  const LEGACY_TYPE_RENAMES = { fixed: '3d', wholemount: '2d' };
  let _migrated = false;

  function key(datasetId, scope = 'viewer') {
    return `${PREFIX}${scope}.${datasetId || 'unknown'}`;
  }

  /** Rewrite `iribhm.workspace.<scope>.<legacyType>/<folder>` keys onto the current
   *  type vocabulary. Runs at most once per page; never throws — localStorage is
   *  absent in a worker and can throw outright when site data is blocked. */
  function _migrateLegacyKeys() {
    if (_migrated) return;
    _migrated = true;
    try {
      if (typeof localStorage === 'undefined' || !localStorage) return;
      // Collect first: removing entries while walking by index shifts the indices.
      const moves = [];
      for (let i = 0; i < localStorage.length; i++) {
        const from = localStorage.key(i);
        if (!from || from.indexOf(PREFIX) !== 0) continue;
        const rest = from.slice(PREFIX.length);          // '<scope>.<type>/<folder>'
        const dot = rest.indexOf('.');
        const slash = rest.indexOf('/');
        if (dot < 0 || slash < dot) continue;
        const scope = rest.slice(0, dot);
        const legacyType = rest.slice(dot + 1, slash);
        const canonical = LEGACY_TYPE_RENAMES[legacyType];
        if (!canonical) continue;
        const datasetId = canonical + rest.slice(slash);
        moves.push({ from, to: key(datasetId, scope), datasetId });
      }
      moves.forEach(move => {
        const raw = localStorage.getItem(move.from);
        localStorage.removeItem(move.from);
        // A workspace already saved under the current id wins: it is the newer one.
        if (raw === null || localStorage.getItem(move.to) !== null) return;
        let value = raw;
        try {
          const payload = JSON.parse(raw);
          if (payload && typeof payload === 'object') {
            payload.datasetId = move.datasetId;
            value = JSON.stringify(payload);
          }
        } catch (_) { /* unparseable: carry the stored text over verbatim */ }
        localStorage.setItem(move.to, value);
      });
    } catch (_) { /* storage unavailable — nothing to migrate */ }
  }

  function save(datasetId, scope, state) {
    _migrateLegacyKeys();
    const payload = {
      version: VERSION,
      scope,
      datasetId,
      savedAt: new Date().toISOString(),
      state: _normalizeState(state, scope)
    };
    localStorage.setItem(key(datasetId, scope), JSON.stringify(payload));
    return payload;
  }

  function load(datasetId, scope) {
    _migrateLegacyKeys();
    const raw = localStorage.getItem(key(datasetId, scope));
    if (!raw) return null;
    try {
      const payload = JSON.parse(raw);
      return {
        ...payload,
        version: Number(payload?.version) || 1,
        scope: payload?.scope || scope,
        datasetId: payload?.datasetId || datasetId,
        state: _normalizeState(payload?.state || {}, payload?.scope || scope)
      };
    } catch {
      return null;
    }
  }

  function clear(datasetId, scope) {
    _migrateLegacyKeys();
    localStorage.removeItem(key(datasetId, scope));
  }

  function toBlob(payload) {
    return new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  }

  function download(payload, filename = 'workspace.json') {
    const normalized = {
      ...payload,
      version: Number(payload?.version) || VERSION,
      state: _normalizeState(payload?.state || {}, payload?.scope || 'viewer')
    };
    const url = URL.createObjectURL(toBlob(normalized));
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 500);
  }

  function _normalizeState(state, scope = 'viewer') {
    const next = state && typeof state === 'object' ? JSON.parse(JSON.stringify(state)) : {};
    const hasSections = ['ui', 'viewer', 'tracking', 'compare'].some(key => key in next);
    if (hasSections) {
      return {
        ui: next.ui || {},
        viewer: next.viewer || {},
        tracking: next.tracking || {},
        compare: next.compare || {}
      };
    }
    return _wrapLegacyState(next, scope);
  }

  function _wrapLegacyState(state, scope) {
    const wrapped = {
      ui: {},
      viewer: {},
      tracking: {},
      compare: {}
    };
    if (scope === 'viewer') wrapped.viewer = state || {};
    else if (scope === 'tracking') wrapped.tracking = state || {};
    else if (scope === 'compare') wrapped.compare = state || {};
    else wrapped.ui = state || {};
    return wrapped;
  }

  return { save, load, clear, download, toBlob, key };
})();
