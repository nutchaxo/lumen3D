/* ============================================================
   IRIBHM Microscopy Platform — Workspace State
   ============================================================ */

const WorkspaceState = (() => {
  const VERSION = 2;

  function key(datasetId, scope = 'viewer') {
    return `iribhm.workspace.${scope}.${datasetId || 'unknown'}`;
  }

  function save(datasetId, scope, state) {
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
