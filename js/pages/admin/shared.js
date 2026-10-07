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
export const API_SITE      = 'api/site.php';   // white-label config (instance/theme/pages/legal)
export const API_MEDIA     = 'api/media.php';  // media library (operator image uploads)
export const API_UPLOAD    = 'api/upload.php'; // dataset import (staging, chunked + resumable)

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

// The CSRF header and JSON content type are the base; a caller's own headers are
// layered on top instead of replacing the whole object.
function _requestInit(options) {
  const { headers, ...rest } = options || {};
  return {
    ...rest,
    headers: {
      'Content-Type': 'application/json',
      ...(_csrf ? { 'X-CSRF-Token': _csrf } : {}),
      ...(headers || {}),
    },
  };
}

export async function apiFetch(url, options = {}) {
  try {
    const res = await fetch(url, _requestInit(options));
    if (res.status === 401) {
      if (typeof _onUnauthorized === 'function') _onUnauthorized();
      return null;
    }
    const text = await res.text();
    if (!res.ok) console.warn('API: HTTP', res.status, url);
    try {
      return JSON.parse(text);
    } catch {
      // A non-JSON body (PHP warning, HTML error page, empty 200) used to vanish
      // here, leaving only "impossible de charger" and nothing to diagnose.
      console.error('API: non-JSON response', res.status, url, text.slice(0, 300));
      return null;
    }
  } catch (err) {
    console.error('API error:', url, err);
    return null;
  }
}

// Like apiFetch but returns { ok, status, data, rev } so callers can branch on the
// HTTP status (e.g. 409 already_configured / last_shader / stale). `rev` is the
// site-doc revision an admin read of api/site.php carries (X-Lumen-Rev), null
// elsewhere: sent back as ?rev= on a save, it turns a lost update into a 409.
export async function apiFetchStatus(url, options = {}) {
  try {
    const res = await fetch(url, _requestInit(options));
    if (res.status === 401 && typeof _onUnauthorized === 'function') _onUnauthorized();
    let data = null;
    try { data = JSON.parse(await res.text()); } catch { /* non-JSON */ }
    const rev = (res.headers && typeof res.headers.get === 'function') ? res.headers.get('X-Lumen-Rev') : null;
    return { ok: res.ok, status: res.status, data, rev: rev || null };
  } catch (err) {
    console.error('API error:', url, err);
    return { ok: false, status: 0, data: null, rev: null };
  }
}

// ── localStorage that never throws (blocked site data, some private modes) ──
export function storageGet(key) {
  try { return localStorage.getItem(key); } catch (_) { return null; }
}
export function storageSet(key, value) {
  try { localStorage.setItem(key, value); return true; } catch (_) { return false; }
}

// Minimum length of an admin password, enforced here AND by the server.
export const MIN_PASSWORD = 8;

/**
 * Text for a refused password attempt (login, or a password re-check): the
 * servers answer a code, never a sentence. Null when `data` is not a refusal
 * of that kind.
 */
export function throttleText(data) {
  const code = data && data.error;
  if (code === 'too_many_attempts') {
    const s = Number(data.retryAfter);
    return Number.isFinite(s) && s > 0
      ? t('admin.tooManyAttemptsIn', 'Too many attempts. Try again in {min} min.', { min: Math.max(1, Math.ceil(s / 60)) })
      : t('admin.tooManyAttempts', 'Too many attempts. Try again later.');
  }
  if (code === 'lockout_store_unavailable') return t('admin.lockoutStore', 'Sign-in is unavailable: the server cannot record attempts. Check the permissions of the api/ folder.');
  return null;
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

/**
 * Ask for the admin password in a real dialog (masked field, password-manager
 * friendly) instead of window.prompt(), which echoes the typed text.
 * Resolves the password, or null when the operator cancels.
 */
export function askPassword(message) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'upl-exit';
    overlay.setAttribute('role', 'alertdialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.innerHTML = `
      <form class="upl-exit-card" autocomplete="on">
        <h3 class="upl-exit-title">${escHtml(t('admin.reauthTitle', 'Confirmation requise'))}</h3>
        <p class="upl-exit-body">${escHtml(message)}</p>
        <input type="password" class="adm-field-input" name="password" autocomplete="current-password" style="width:100%;margin-top:14px">
        <div class="upl-exit-actions">
          <button type="button" class="adm-btn adm-btn-ghost" data-act="cancel">${escHtml(t('admin.cancel', 'Annuler'))}</button>
          <button type="submit" class="adm-btn adm-btn-accent">${escHtml(t('admin.confirm', 'Confirmer'))}</button>
        </div>
      </form>`;
    const input = overlay.querySelector('input');
    const previous = document.activeElement;
    const close = (value) => {
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
      try { previous?.focus?.(); } catch (_) { /* element gone */ }
      resolve(value);
    };
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); close(null); } };
    overlay.querySelector('form').addEventListener('submit', (e) => { e.preventDefault(); close(input.value || null); });
    overlay.querySelector('[data-act="cancel"]').addEventListener('click', () => close(null));
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(overlay);
    setTimeout(() => input.focus(), 20);
  });
}
