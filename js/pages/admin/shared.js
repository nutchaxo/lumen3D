/**
 * Admin SPA — shared plumbing
 * ===========================
 * One place for i18n, the authenticated fetch wrapper (cookie session + CSRF
 * header), toasts, HTML escaping and the API route constants. Every tab module
 * imports from here so the request/i18n/toast behaviour is identical everywhere.
 *
 * i18n.js / utils.js are classic scripts: their top-level `const I18n` / `const
 * Utils` live in the global LEXICAL scope (not on window). A free reference from
 * this module resolves through the shared global environment — guarded by typeof.
 */

'use strict';

// i18n.js / utils.js declare `const I18n` / `const Utils` at the top level of a
// classic script — those live in the global LEXICAL environment, NOT on globalThis.
// A free reference from this module resolves up the scope chain to them (proven by
// the original admpan.js); `'x' in globalThis` would NOT (it only sees the global
// OBJECT). The locals MUST be named differently (`_I18n`) — naming them `I18n` would
// shadow the global and hit its own TDZ. The classic scripts run before this
// deferred module, so the bindings exist by now.
const _I18n  = (typeof I18n  !== 'undefined') ? I18n  : null;
const _Utils = (typeof Utils !== 'undefined') ? Utils : null;
export { _I18n as I18n, _Utils as Utils };

export const API_AUTH      = 'api/auth.php';
export const API_DATASETS  = 'api/datasets.php';
export const API_ADMIN     = 'api/admin.php';
export const API_TELEMETRY = 'api/telemetry.php';

// Translated string for `k`, or `def` (the original French) on miss / no I18n.
export function t(k, def, params) {
  if (!_I18n || typeof _I18n.t !== 'function') return def;
  const v = _I18n.t(k, params);
  return (v === k || v == null) ? def : v;
}

export function escHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ── CSRF + auth-failure plumbing ───────────────────────────────
let _csrf = null;
let _onUnauthorized = null;
export function setCsrf(token) { _csrf = token || null; }
export function getCsrf() { return _csrf; }
export function setUnauthorizedHandler(fn) { _onUnauthorized = fn; }

export async function apiFetch(url, options = {}) {
  try {
    const res = await fetch(url, {
      headers: {
        'Content-Type': 'application/json',
        ...(_csrf ? { 'X-CSRF-Token': _csrf } : {}),
        ...(options.headers || {}),
      },
      ...options,
    });
    if (res.status === 401) {
      if (typeof _onUnauthorized === 'function') _onUnauthorized();
      return null;
    }
    const text = await res.text();
    try { return JSON.parse(text); } catch { return null; }
  } catch (err) {
    console.error('API error:', url, err);
    return null;
  }
}

// Like apiFetch but returns { ok, status, data } so callers can branch on the
// HTTP status (e.g. 409 already_configured / last_shader).
export async function apiFetchStatus(url, options = {}) {
  try {
    const res = await fetch(url, {
      headers: {
        'Content-Type': 'application/json',
        ...(_csrf ? { 'X-CSRF-Token': _csrf } : {}),
        ...(options.headers || {}),
      },
      ...options,
    });
    if (res.status === 401 && typeof _onUnauthorized === 'function') _onUnauthorized();
    let data = null;
    try { data = JSON.parse(await res.text()); } catch { /* non-JSON */ }
    return { ok: res.ok, status: res.status, data };
  } catch (err) {
    console.error('API error:', url, err);
    return { ok: false, status: 0, data: null };
  }
}

// ── Toasts ─────────────────────────────────────────────────────
let _toastContainer = null;
export function toast(msg, type = 'success') {
  if (!_toastContainer) _toastContainer = document.getElementById('toast-container');
  if (!_toastContainer) return;
  const icons = { success: '✅', error: '❌', info: 'ℹ️', warning: '⚠️' };
  const div = document.createElement('div');
  div.className = `toast toast-${type}`;
  div.innerHTML = `<span class="toast-icon">${icons[type] || '📢'}</span><span class="toast-msg">${escHtml(msg)}</span>`;
  _toastContainer.appendChild(div);
  setTimeout(() => {
    div.classList.add('dismissing');
    setTimeout(() => div.remove(), 280);
  }, 3000);
}

// Re-render Lucide icons inside a freshly built subtree (or the whole document).
export function refreshIcons(root) {
  try {
    if (window.lucide && typeof window.lucide.createIcons === 'function') {
      window.lucide.createIcons(root ? { nodes: [root] } : undefined);
    }
  } catch (_) { /* lucide optional */ }
}

export const el = (id) => document.getElementById(id);
export function deepClone(obj) { return JSON.parse(JSON.stringify(obj)); }
