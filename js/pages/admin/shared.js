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

// Translated string for `k`, or `def` on miss / no I18n.
export function t(k, def, params) {
  if (!_I18n || typeof _I18n.t !== 'function') return def;
  const v = _I18n.t(k, params);
  return (v === k || v == null) ? def : v;
}

// A byte count for display, in the page language's units (admin.storageUnits) and
// number format: one decimal below 100 of a unit, none for bytes or from 100 up.
export function fmtBytes(n) {
  n = Number(n);
  if (!Number.isFinite(n) || n < 0) return '—';
  const units = t('admin.storageUnits', 'B|KB|MB|GB|TB').split('|');
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  const digits = i === 0 || n >= 100 ? 0 : 1;
  let locale;
  try { locale = _I18n && typeof _I18n.getLanguage === 'function' ? _I18n.getLanguage() : undefined; } catch { locale = undefined; }
  let num;
  try { num = n.toLocaleString(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits }); }
  catch { num = n.toFixed(digits); }
  return `${num} ${units[i]}`;
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
// Holders of their own copy of the token (the import worker) follow a sign-in or a
// renewal through this: a copy left behind gets every write refused with a 403.
const _csrfListeners = new Set();
export function setCsrf(token) {
  const next = token || null;
  if (next === _csrf) return;
  _csrf = next;
  _csrfListeners.forEach((fn) => { try { fn(next); } catch (err) { console.error('CSRF listener:', err); } });
}
export function getCsrf() { return _csrf; }
export function onCsrfChange(fn) { _csrfListeners.add(fn); return () => _csrfListeners.delete(fn); }
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

// A write refused for its CSRF token (another tab signed in again and rotated it)
// is retried ONCE with the current token when the body can be re-sent as is.
// Streams, Blobs and raw buffers are never replayed.
function _isCsrfRefusal(status, text) {
  return status === 403 && /csrf/i.test(text);
}

function _replayable(options) {
  const b = options && options.body;
  return b === undefined || b === null || typeof b === 'string';
}

let _csrfRefresh = null;
// 'renewed' | 'signed-out' | 'failed'
function _refreshCsrf() {
  if (!_csrfRefresh) {
    _csrfRefresh = (async () => {
      try {
        const res = await fetch(`${API_AUTH}?action=status`, { credentials: 'same-origin' });
        const data = JSON.parse(await res.text());
        if (data && data.authenticated && data.csrf) { setCsrf(data.csrf); return 'renewed'; }
        if (data && data.authenticated === false) return 'signed-out';
      } catch { /* offline or non-JSON: nothing to renew */ }
      return 'failed';
    })().finally(() => { _csrfRefresh = null; });
  }
  return _csrfRefresh;
}
/** Ask the server for the session's current token: 'renewed' | 'signed-out' | 'failed'. */
export function refreshCsrf() { return _refreshCsrf(); }

let _csrfNoticeAt = 0;
function _csrfLostNotice() {
  const now = Date.now();
  if (now - _csrfNoticeAt < 5000) return;
  _csrfNoticeAt = now;
  try { toast(t('admin.sessionChanged', 'Your session changed in another tab. Reload this page and try again.'), 'error'); } catch { /* no DOM: the caller still sees the 403 */ }
}

// A 401 that refuses the password a sensitive action re-asks for (change
// password, plugin approval, catalog install/update) while the session stays
// valid: the caller paints the refusal, the panel must not fall to the login gate.
const REAUTH_REFUSALS = new Set(['bad_password', 'bad_current']);

function _isSessionLoss(status, data) {
  return status === 401 && !(data && typeof data === 'object' && REAUTH_REFUSALS.has(data.error));
}

function _parseJson(text) {
  try { return JSON.parse(text); } catch { return undefined; }
}

async function _request(url, options) {
  let res = await fetch(url, _requestInit(options));
  let text = await res.text();
  if (_isCsrfRefusal(res.status, text)) {
    if (_replayable(options)) {
      const before = _csrf;
      const state = await _refreshCsrf();
      if (state === 'signed-out') {
        if (typeof _onUnauthorized === 'function') _onUnauthorized();
        return { res, text };
      }
      if (state === 'renewed' && _csrf !== before) {
        res = await fetch(url, _requestInit(options));
        text = await res.text();
      }
    }
    if (_isCsrfRefusal(res.status, text)) _csrfLostNotice();
  }
  return { res, text };
}

export async function apiFetch(url, options = {}) {
  try {
    const { res, text } = await _request(url, options);
    const data = _parseJson(text);
    if (_isSessionLoss(res.status, data)) {
      if (typeof _onUnauthorized === 'function') _onUnauthorized();
      return null;
    }
    if (!res.ok) console.warn('API: HTTP', res.status, url);
    if (data === undefined) {
      // A non-JSON body (PHP warning, HTML error page, empty 200) used to vanish
      // here, leaving only "impossible de charger" and nothing to diagnose.
      console.error('API: non-JSON response', res.status, url, text.slice(0, 300));
      return null;
    }
    return data;
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
    const { res, text } = await _request(url, options);
    const parsed = _parseJson(text);
    const data = parsed === undefined ? null : parsed;
    if (_isSessionLoss(res.status, data) && typeof _onUnauthorized === 'function') _onUnauthorized();
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
// The visible stack (#toast-container) is not a live region: a screen reader hears a
// toast through two announcers present since page load (#toast-status polite,
// #toast-alert assertive for failures), because a region created or filled in the same
// tick is not announced reliably. Each message is a child of its announcer for as long
// as its toast is on screen, so two toasts in a row are both read and the same text
// twice is read twice.
// A success/info/warning toast stays long enough to be read (≈ 60 ms a character,
// 3–8 s, the timer paused while hovered or focused); an error stays until dismissed.
const TOAST_MIN_MS = 3000;
const TOAST_MAX_MS = 8000;
const TOAST_MS_PER_CHAR = 60;
const TOAST_MAX_VISIBLE = 5;
let _toastSeq = 0;

export function toastDuration(msg, type = 'success') {
  if (type === 'error') return Infinity;
  const len = String(msg == null ? '' : msg).length;
  return Math.min(TOAST_MAX_MS, Math.max(TOAST_MIN_MS, TOAST_MS_PER_CHAR * len));
}

export function toast(msg, type = 'success') {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const text = String(msg == null ? '' : msg);
  const icons = { success: '✅', error: '❌', info: 'ℹ️', warning: '⚠️' };
  const id = `toast-msg-${++_toastSeq}`;

  const div = document.createElement('div');
  div.className = `toast toast-${type}`;
  // The announcer carries the words for assistive technology; the visible copy is
  // hidden from it so the message is not read twice, and still names the close button.
  div.innerHTML = `<span class="toast-icon" aria-hidden="true">${icons[type] || '📢'}</span>`
    + `<span class="toast-msg" id="${id}" aria-hidden="true">${escHtml(text)}</span>`
    + `<button type="button" class="toast-close" aria-describedby="${id}"`
    + ` aria-label="${escHtml(t('admin.toastClose', 'Dismiss notification'))}">`
    + `<span aria-hidden="true">✕</span></button>`;
  container.appendChild(div);

  const announcer = document.getElementById(type === 'error' ? 'toast-alert' : 'toast-status');
  let spoken = null;
  if (announcer) {
    spoken = document.createElement('p');
    spoken.textContent = text;
    announcer.appendChild(spoken);
  }

  let timer = null;
  let remaining = toastDuration(text, type);
  let startedAt = 0;
  let gone = false;
  let hovered = false;
  let focused = false;

  const dismiss = () => {
    if (gone) return;
    gone = true;
    if (timer) { clearTimeout(timer); timer = null; }
    if (spoken) spoken.remove();
    div.classList.add('dismissing');
    setTimeout(() => div.remove(), 280);
  };
  const start = () => {
    if (gone || timer || !Number.isFinite(remaining)) return;
    startedAt = Date.now();
    timer = setTimeout(dismiss, remaining);
  };
  const pause = () => {
    if (!timer) return;
    clearTimeout(timer);
    timer = null;
    remaining = Math.max(1000, remaining - (Date.now() - startedAt));
  };
  const resume = () => { if (!hovered && !focused) start(); };

  div.querySelector('.toast-close').addEventListener('click', dismiss);
  div.addEventListener('mouseenter', () => { hovered = true; pause(); });
  div.addEventListener('mouseleave', () => { hovered = false; resume(); });
  div.addEventListener('focusin', () => { focused = true; pause(); });
  div.addEventListener('focusout', (e) => {
    if (e && e.relatedTarget && div.contains(e.relatedTarget)) return;
    focused = false;
    resume();
  });
  div._lumenDismiss = dismiss;
  start();

  // Sticky errors must not pile up past the screen: the oldest toast leaves first.
  const live = Array.from(container.children).filter((n) => !n.classList.contains('dismissing'));
  for (let i = 0; i < live.length - TOAST_MAX_VISIBLE; i++) {
    if (typeof live[i]._lumenDismiss === 'function') live[i]._lumenDismiss();
    else live[i].remove();
  }
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

// ── Modal dialogs ──────────────────────────────────────────────
// Left reachable while a dialog is open: they announce or report, they never act
// on the page behind it.
const MODAL_KEEP_LIVE = new Set(['toast-container', 'toast-status', 'toast-alert', 'upload-dock-status']);
const MODAL_SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'LINK', 'TEMPLATE', 'NOSCRIPT']);
// Element → number of open dialogs holding it inert. A node the page made inert on
// its own is never touched, and a node stays inert until the last dialog holding it
// lets go (one dialog can open over another).
const _inertHolds = new Map();
let _modalSeq = 0;

function _holdInert(node) {
  const n = _inertHolds.get(node);
  if (n) { _inertHolds.set(node, n + 1); return true; }
  if (node.hasAttribute('inert')) return false;
  node.setAttribute('inert', '');
  _inertHolds.set(node, 1);
  return true;
}

function _dropInert(node) {
  const n = _inertHolds.get(node) || 0;
  if (n > 1) { _inertHolds.set(node, n - 1); return; }
  _inertHolds.delete(node);
  node.removeAttribute('inert');
}

/** A document-unique id for a dialog's title or description. */
export function modalId(prefix) { return `${prefix}-${++_modalSeq}`; }

/**
 * Make an open overlay behave as a modal dialog: named by `labelledBy` (and
 * `describedBy`), everything else on the page inert while it is open — a click, Tab
 * and a screen reader's cursor stop at its edge — and focus moved inside and kept
 * there (Utils.trapFocus; `initialFocus`, else its first control).
 * Returns release({ restore = true }): the page comes back, then focus returns to
 * what held it before the dialog opened. Escape stays the caller's.
 */
export function modalize(overlay, { labelledBy = null, describedBy = null, initialFocus = null, container = null } = {}) {
  if (labelledBy) overlay.setAttribute('aria-labelledby', labelledBy);
  if (describedBy) overlay.setAttribute('aria-describedby', describedBy);
  const body = document.body;
  let branch = overlay;
  while (branch.parentNode && branch.parentNode !== body) branch = branch.parentNode;
  const held = [];
  for (const node of Array.from(body.children)) {
    if (node === branch || MODAL_KEEP_LIVE.has(node.id) || MODAL_SKIP_TAGS.has(node.tagName)) continue;
    if (_holdInert(node)) held.push(node);
  }
  const box = container || overlay;
  let releaseTrap = null;
  if (_Utils && typeof _Utils.trapFocus === 'function') {
    releaseTrap = _Utils.trapFocus(box, { initialFocus });
  } else if (initialFocus && typeof initialFocus.focus === 'function') {
    initialFocus.focus();
  }
  let released = false;
  return function release({ restore = true } = {}) {
    if (released) return;
    released = true;
    // The page first: the element focus goes back to is in it, and an inert node
    // refuses focus.
    held.forEach(_dropInert);
    if (releaseTrap) releaseTrap({ restore });
  };
}

/**
 * Ask for the admin password in a real dialog (masked field, password-manager
 * friendly) instead of window.prompt(), which echoes the typed text.
 * Resolves the password, or null when the operator cancels.
 */
export function askPassword(message) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    const titleId = modalId('adm-reauth-title');
    const bodyId = modalId('adm-reauth-body');
    overlay.className = 'upl-exit';
    overlay.setAttribute('role', 'alertdialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.innerHTML = `
      <form class="upl-exit-card" autocomplete="on">
        <h3 class="upl-exit-title" id="${titleId}">${escHtml(t('admin.reauthTitle', 'Confirmation requise'))}</h3>
        <p class="upl-exit-body" id="${bodyId}">${escHtml(message)}</p>
        <input type="password" class="adm-field-input" name="password" autocomplete="current-password" style="width:100%;margin-top:14px"
               aria-label="${escHtml(t('admin.password', 'Mot de passe'))}">
        <div class="upl-exit-actions">
          <button type="button" class="adm-btn adm-btn-ghost" data-act="cancel">${escHtml(t('admin.cancel', 'Annuler'))}</button>
          <button type="submit" class="adm-btn adm-btn-accent">${escHtml(t('admin.confirm', 'Confirmer'))}</button>
        </div>
      </form>`;
    const input = overlay.querySelector('input');
    let release = null;
    const close = (value) => {
      document.removeEventListener('keydown', onKey, true);
      if (release) release();
      overlay.remove();
      resolve(value);
    };
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); close(null); } };
    overlay.querySelector('form').addEventListener('submit', (e) => { e.preventDefault(); close(input.value || null); });
    overlay.querySelector('[data-act="cancel"]').addEventListener('click', () => close(null));
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(overlay);
    release = modalize(overlay, { labelledBy: titleId, describedBy: bodyId, initialFocus: input });
  });
}
