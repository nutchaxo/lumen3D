/**
 * Admin SPA — shell/tab bus
 * =========================
 * A tiny dependency-free bridge so tab modules and the shell can talk without a
 * circular import (shell imports tabs; tabs only import this). Carries the
 * unsaved-changes indicator, the per-tab "unsaved" guards, and programmatic
 * navigation.
 */

'use strict';

// id -> { dirty(): boolean, discard(): void }. Every editing tab registers its own
// entry, so leaving a tab asks about THAT tab's edits and the header indicator
// reflects all of them (one shared boolean used to hide a dirty tab behind another
// tab's clean state).
const _guards = new Map();
const _flags = new Map();   // id -> boolean, set through setUnsaved(on, id)

export function registerDirtyGuard(id, fn, discard) {
  _guards.set(id, {
    dirty: (typeof fn === 'function') ? fn : (() => false),
    discard: (typeof discard === 'function') ? discard : null,
  });
  _bindBeforeUnload();
}

// Single-slot form kept for callers that predate the registry.
export function setDirtyGuard(fn, discard) { registerDirtyGuard('default', fn, discard); }

function _guardDirty(g) { try { return !!g.dirty(); } catch { return false; } }

/** Is `id` (or, without an id, any registered tab) holding unsaved edits? */
export function isDirty(id) {
  if (id != null) {
    const g = _guards.get(id);
    return g ? _guardDirty(g) : false;
  }
  for (const g of _guards.values()) if (_guardDirty(g)) return true;
  return false;
}

// The operator answered "continue without saving": the pending edits have to be
// dropped for real. Without this the owning tab keeps its dirty flag, so the very
// next navigation asks the same question again — forever.
export function discardDirty(id) {
  const list = id != null ? [_guards.get(id)] : [..._guards.values()];
  for (const g of list) {
    if (!g || !g.discard || !_guardDirty(g)) continue;
    try { g.discard(); } catch (e) { console.error(e); }
  }
}

let _unsavedEl = null;
let _baseTitle = null;
export function setUnsaved(on, id = 'default') {
  if (!_unsavedEl) _unsavedEl = document.getElementById('header-unsaved-wrap');
  if (on) _flags.set(id, true); else _flags.delete(id);
  const any = _flags.size > 0 || isDirty();
  if (_unsavedEl) _unsavedEl.style.display = any ? 'inline-flex' : 'none';
  // The server-injected title carries the operator's brand; keep it and only
  // prefix the marker.
  if (_baseTitle === null) _baseTitle = document.title.replace(/^● /, '');
  document.title = any ? `● ${_baseTitle}` : _baseTitle;
}

let _unloadBound = false;
function _bindBeforeUnload() {
  if (_unloadBound) return;
  _unloadBound = true;
  window.addEventListener('beforeunload', (e) => {
    if (!isDirty()) return;
    e.preventDefault();
    e.returnValue = '';
  });
}

// Ctrl/Cmd+S for the tab `id`: fires only while that tab is the visible one, so a
// shortcut armed by one editor never saves (or swallows the browser dialog for)
// another. `fn` may return false to leave the browser default alone.
const _saveBound = new Set();
export function bindTabSave(id, fn) {
  if (_saveBound.has(id)) return;
  _saveBound.add(id);
  document.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
    if (e.key !== 's' && e.key !== 'S') return;
    if (!document.querySelector(`.adm-tabpanel.active[data-tab="${id}"]`)) return;
    if (fn(e) !== false) e.preventDefault();
  });
}

let _navigate = null;
export function setNavigator(fn) { _navigate = fn; }
export function navigateTo(tab) { if (typeof _navigate === 'function') _navigate(tab); }

// "Open this dataset in the editor" from the import console / dock. The Datasets
// module is loaded on first use, so the request is parked until it registers.
let _datasetOpener = null;
let _pendingDataset = null;
export function setDatasetOpener(fn) {
  _datasetOpener = (typeof fn === 'function') ? fn : null;
  if (_datasetOpener && _pendingDataset) { const id = _pendingDataset; _pendingDataset = null; _datasetOpener(id); }
}
export function openDataset(id) {
  navigateTo('datasets');
  if (_datasetOpener) _datasetOpener(id); else _pendingDataset = id;
}
