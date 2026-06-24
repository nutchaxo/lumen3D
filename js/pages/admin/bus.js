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
export function setDirtyGuard(fn) { _dirtyGuard = (typeof fn === 'function') ? fn : (() => false); }
export function isDirty() { try { return !!_dirtyGuard(); } catch { return false; } }

let _unsavedEl = null;
export function setUnsaved(on) {
  if (!_unsavedEl) _unsavedEl = document.getElementById('header-unsaved-wrap');
  if (_unsavedEl) _unsavedEl.style.display = on ? 'inline-flex' : 'none';
  document.title = on ? '● Admin — IRIBHM' : 'Admin — IRIBHM Microscopy Platform';
}

let _navigate = null;
export function setNavigator(fn) { _navigate = fn; }
export function navigateTo(tab) { if (typeof _navigate === 'function') _navigate(tab); }
