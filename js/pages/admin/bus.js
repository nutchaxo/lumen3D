/**
 * Admin SPA — shell/tab bus
 * =========================
 * A tiny dependency-free bridge so tab modules and the shell can talk without a
 * circular import (shell imports tabs; tabs only import this). Carries the
 * unsaved-changes indicator, the cross-tab "unsaved" guard, and programmatic
 * navigation.
 */

'use strict';

let _dirtyGuard = () => false;
let _dirtyDiscard = null;
export function setDirtyGuard(fn, discard) {
  _dirtyGuard = (typeof fn === 'function') ? fn : (() => false);
  _dirtyDiscard = (typeof discard === 'function') ? discard : null;
}
export function isDirty() { try { return !!_dirtyGuard(); } catch { return false; } }

// The operator answered "continue without saving": the pending edits have to be
// dropped for real. Without this the owning tab keeps its dirty flag, so the very
// next navigation asks the same question again — forever.
export function discardDirty() { try { _dirtyDiscard?.(); } catch (e) { console.error(e); } }

let _unsavedEl = null;
export function setUnsaved(on) {
  if (!_unsavedEl) _unsavedEl = document.getElementById('header-unsaved-wrap');
  if (_unsavedEl) _unsavedEl.style.display = on ? 'inline-flex' : 'none';
  document.title = on ? '● Admin — IRIBHM' : 'Admin — IRIBHM Microscopy Platform';
}

let _navigate = null;
export function setNavigator(fn) { _navigate = fn; }
export function navigateTo(tab) { if (typeof _navigate === 'function') _navigate(tab); }
