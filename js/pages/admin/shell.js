/**
 * Admin SPA — shell
 * =================
 * Auth/setup/login gating, the collapsible sidebar + hash routing, the topbar
 * (theme, language, logout) and the tab registry. Tab modules register themselves
 * and provide mount()/activate()/relabel(); the shell decides what is visible.
 */

'use strict';

import {
  I18n, Utils, API_AUTH, t, apiFetch, apiFetchStatus, setCsrf,
  setUnauthorizedHandler, toast, refreshIcons, el,
} from './shared.js';
import { isDirty, setNavigator } from './bus.js';

const _tabs = new Map();   // id -> { id, mount, activate, relabel?, titleKey, titleDefault }
let _activeTab = null;
let _appReady = false;

export function registerTab(tab) { _tabs.set(tab.id, tab); }

// ── Gates: setup / login / app ─────────────────────────────────

function showGate(which) {
  el('setup-screen').style.display = which === 'setup' ? 'flex' : 'none';
  el('login-screen').style.display = which === 'login' ? 'flex' : 'none';
  el('admin-app').style.display    = which === 'app'   ? 'flex' : 'none';
  if (which === 'login') setTimeout(() => el('login-username')?.focus(), 50);
  if (which === 'setup') setTimeout(() => el('setup-password')?.focus(), 50);
}

async function checkAuth() {
  const data = await apiFetch(`${API_AUTH}?action=status`);
  if (data?.needsSetup) { showGate('setup'); return; }
  if (data?.authenticated) { setCsrf(data.csrf); enterApp(data.username); }
  else { showGate('login'); }
}

function enterApp(username) {
  el('header-username').textContent = username || 'admin';
  showGate('app');
  _appReady = true;
  if (Utils) Utils.populateLanguageMenu?.(switchLanguage);
  refreshIcons();
  const initial = (location.hash || '#datasets').replace('#', '');
  switchTab(_tabs.has(initial) ? initial : 'datasets', true);
}

// ── Setup (first-run password creation) ────────────────────────

function setupError(msg) {
  const box = el('setup-error');
  el('setup-error-msg').textContent = msg;
  box.style.display = msg ? 'flex' : 'none';
}

async function doSetup() {
  const username = (el('setup-username').value || 'admin').trim() || 'admin';
  const p1 = el('setup-password').value || '';
  const p2 = el('setup-password2').value || '';
  setupError('');
  if (p1.length < 4) { setupError(t('admin.setupWeak', 'Mot de passe trop court (4 caractères minimum).')); return; }
  if (p1 !== p2)     { setupError(t('admin.setupMismatch', 'Les mots de passe ne correspondent pas.')); return; }

  const btn = el('btn-setup');
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner spinner-sm"></span> ${t('admin.creating', 'Création…')}`;
  const r = await apiFetchStatus(`${API_AUTH}?action=setup`, {
    method: 'POST', body: JSON.stringify({ username, password: p1 }),
  });
  btn.disabled = false;
  btn.textContent = t('admin.createPassword', 'Créer le mot de passe');

  if (r.ok && r.data?.ok) {
    setCsrf(r.data.csrf || null);
    toast(t('admin.setupDone', 'Mot de passe créé ✓'));
    enterApp(r.data.username || username);
  } else if (r.status === 409) {
    setupError(t('admin.setupExists', 'Un mot de passe existe déjà. Rechargez la page pour vous connecter.'));
  } else {
    setupError(r.data?.error === 'weak_password'
      ? t('admin.setupWeak', 'Mot de passe trop court (4 caractères minimum).')
      : t('admin.setupFailed', 'Échec de la création du mot de passe.'));
  }
}

// ── Login ──────────────────────────────────────────────────────

async function doLogin() {
  const username = (el('login-username').value || '').trim();
  const password = el('login-password').value || '';
  if (!username || !password) return;
  const err = el('login-error');
  err.style.display = 'none';
  const btn = el('btn-login');
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner spinner-sm"></span> ${t('admin.signingIn', 'Connexion…')}`;

  const data = await apiFetch(`${API_AUTH}?action=login`, {
    method: 'POST', body: JSON.stringify({ username, password }),
  });
  btn.disabled = false;
  btn.textContent = t('admin.signIn', 'Se connecter');

  if (data?.ok) {
    setCsrf(data.csrf || null);
    enterApp(username);
  } else {
    el('login-error-msg').textContent = data?.error || t('admin.badCreds', 'Identifiants incorrects.');
    err.style.display = 'flex';
    el('login-password').value = '';
    el('login-password').focus();
  }
}

async function doLogout() {
  await apiFetch(`${API_AUTH}?action=logout`, { method: 'POST', body: '{}' });
  setCsrf(null);
  _appReady = false;
  showGate('login');
}

// ── Tab routing ────────────────────────────────────────────────

function switchTab(id, force = false) {
  if (!_tabs.has(id)) id = 'datasets';
  if (!force && id === _activeTab) { closeMobileSidebar(); return; }

  // Guard: leaving the datasets editor with unsaved changes.
  if (!force && _activeTab === 'datasets' && id !== 'datasets' && isDirty()) {
    const ok = confirm(t('admin.confirmDiscard', 'Modifications non sauvegardées. Continuer sans sauvegarder ?'));
    if (!ok) return;
  }

  _activeTab = id;
  if (location.hash !== `#${id}`) {
    // Avoid feedback loop with the hashchange listener.
    history.replaceState(null, '', `#${id}`);
  }

  document.querySelectorAll('.adm-nav-item[data-tab]').forEach((b) =>
    b.classList.toggle('active', b.dataset.tab === id));
  document.querySelectorAll('.adm-tabpanel').forEach((p) =>
    p.classList.toggle('active', p.dataset.tab === id));

  const tab = _tabs.get(id);
  const titleEl = el('topbar-tab-title');
  if (titleEl && tab) {
    titleEl.setAttribute('data-i18n', tab.titleKey);
    titleEl.textContent = t(tab.titleKey, tab.titleDefault);
  }

  if (tab) {
    if (!tab.mounted) { try { tab.mount?.(); } catch (e) { console.error(e); } tab.mounted = true; }
    try { tab.activate?.(); } catch (e) { console.error(e); }
  }
  closeMobileSidebar();
  refreshIcons();
}

// ── Sidebar collapse + mobile drawer ───────────────────────────

function loadCollapsed() { return localStorage.getItem('adm-sidebar-collapsed') === '1'; }
function applyCollapsed(on) {
  el('adm-sidebar').classList.toggle('collapsed', on);
  const ic = el('collapse-icon');
  if (ic) { ic.setAttribute('data-lucide', on ? 'panel-left-open' : 'panel-left-close'); refreshIcons(); }
  localStorage.setItem('adm-sidebar-collapsed', on ? '1' : '0');
}
function toggleCollapsed() { applyCollapsed(!el('adm-sidebar').classList.contains('collapsed')); }

function openMobileSidebar() {
  el('adm-sidebar').classList.add('open');
  el('sidebar-overlay').classList.add('show');
}
function closeMobileSidebar() {
  el('adm-sidebar').classList.remove('open');
  el('sidebar-overlay').classList.remove('show');
}

// ── Theme ──────────────────────────────────────────────────────

function loadTheme() { return localStorage.getItem('adm-theme') || 'dark'; }
function applyTheme(mode) {
  document.documentElement.setAttribute('data-theme', mode);
  const ic = el('theme-icon');
  if (ic) { ic.setAttribute('data-lucide', mode === 'light' ? 'sun' : 'moon'); refreshIcons(); }
  localStorage.setItem('adm-theme', mode);
}
function toggleTheme() { applyTheme(loadTheme() === 'light' ? 'dark' : 'light'); }

// ── Language ───────────────────────────────────────────────────

async function switchLanguage(lang) {
  if (!I18n || !I18n.setLanguage) return;
  await I18n.setLanguage(lang);   // re-applies data-i18n* across the DOM
  if (Utils) { Utils.closeDropdowns?.(); Utils.populateLanguageMenu?.(switchLanguage); }
  el('lang-dropdown')?.classList.remove('open');
  // Refresh the active tab's JS-built (inline-t) content.
  const tab = _tabs.get(_activeTab);
  try { (tab?.relabel || tab?.activate)?.(); } catch (_) {}
  // Topbar title key may need re-translation.
  const titleEl = el('topbar-tab-title');
  if (titleEl && tab) titleEl.textContent = t(tab.titleKey, tab.titleDefault);
  refreshIcons();
}

// ── Wiring ─────────────────────────────────────────────────────

function bindChrome() {
  // Gates
  el('btn-login')?.addEventListener('click', doLogin);
  el('login-password')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
  el('login-username')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') el('login-password').focus(); });
  el('btn-setup')?.addEventListener('click', doSetup);
  el('setup-password2')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSetup(); });

  // Nav
  document.querySelectorAll('.adm-nav-item[data-tab]').forEach((b) =>
    b.addEventListener('click', () => switchTab(b.dataset.tab)));
  window.addEventListener('hashchange', () => {
    if (!_appReady) return;
    const id = (location.hash || '#datasets').replace('#', '');
    if (_tabs.has(id)) switchTab(id);
  });

  // Sidebar / mobile
  el('btn-collapse')?.addEventListener('click', toggleCollapsed);
  el('btn-mobile-menu')?.addEventListener('click', openMobileSidebar);
  el('sidebar-overlay')?.addEventListener('click', closeMobileSidebar);

  // Topbar
  el('btn-theme')?.addEventListener('click', toggleTheme);
  el('btn-logout')?.addEventListener('click', doLogout);

  // Language dropdown open/close
  const dd = el('lang-dropdown');
  el('btn-lang')?.addEventListener('click', (e) => { e.stopPropagation(); dd?.classList.toggle('open'); });
  document.addEventListener('click', (e) => { if (dd && !dd.contains(e.target)) dd.classList.remove('open'); });
}

export async function boot() {
  if (I18n?.init) { try { await I18n.init(); } catch (_) {} }
  setUnauthorizedHandler(() => { if (_appReady) showGate('login'); });
  setNavigator(switchTab);
  applyTheme(loadTheme());
  applyCollapsed(loadCollapsed());
  bindChrome();
  refreshIcons();
  await checkAuth();
}
