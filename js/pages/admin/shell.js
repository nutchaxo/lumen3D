/**
 * Admin SPA — shell
 * =================
 * Auth/setup/login gating, the collapsible sidebar + hash routing, the topbar
 * (theme, language, logout) and the tab registry. Tab modules register themselves
 * and provide mount()/activate()/relabel(); the shell decides what is visible.
 */

'use strict';

import {
  I18n, Utils, API_AUTH, API_SITE, API_ADMIN, t, escHtml, apiFetch, apiFetchStatus, setCsrf,
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
  if (which === 'setup') { initWizard(); setTimeout(() => el('setup-password')?.focus(), 50); }
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

// ── Guided setup wizard (first run) ────────────────────────────
// Step 1 (account) is the ONLY mandatory step — it creates the credential + an
// authenticated session. Steps 2–4 (identity / theme / texts) then seed
// config/instance.json + config/theme.json via the authenticated site endpoint.
// The operator can Skip after step 1 (account made, defaults kept).

const MIN_PASSWORD = 8;
const WIZ_PRESETS = [
  { id: 'green',   tokens: { '--color-primary': '#00A654', '--color-primary-hover': '#1FBB6C', '--color-primary-dark': '#008A45', '--color-primary-subtle': 'rgba(0,166,84,0.15)', '--color-accent': '#00D2FF' } },
  { id: 'blue',    tokens: { '--color-primary': '#2F6BFF', '--color-primary-hover': '#5484FF', '--color-primary-dark': '#2050D0', '--color-primary-subtle': 'rgba(47,107,255,0.15)', '--color-accent': '#00D2FF' } },
  { id: 'purple',  tokens: { '--color-primary': '#7C5CFF', '--color-primary-hover': '#9B80FF', '--color-primary-dark': '#5F3FE0', '--color-primary-subtle': 'rgba(124,92,255,0.15)', '--color-accent': '#FF5CE1' } },
  { id: 'teal',    tokens: { '--color-primary': '#0FC5A8', '--color-primary-hover': '#2DD8BD', '--color-primary-dark': '#0A9E86', '--color-primary-subtle': 'rgba(15,197,168,0.15)', '--color-accent': '#2FE0FF' } },
  { id: 'orange',  tokens: { '--color-primary': '#FF7A2F', '--color-primary-hover': '#FF965A', '--color-primary-dark': '#E05F16', '--color-primary-subtle': 'rgba(255,122,47,0.15)', '--color-accent': '#FFC857' } },
  { id: 'crimson', tokens: { '--color-primary': '#E5484D', '--color-primary-hover': '#F06B6F', '--color-primary-dark': '#C0353A', '--color-primary-subtle': 'rgba(229,72,77,0.15)', '--color-accent': '#FF9CA0' } },
];

let _wizStep = 1;
let _wizUsername = 'admin';
let _wizPassword = '';
let _wizPreset = WIZ_PRESETS[0];

function setupError(msg) {
  const box = el('setup-error');
  if (!box) return;
  el('setup-error-msg').textContent = msg;
  box.style.display = msg ? 'flex' : 'none';
}

function initWizard() {
  _wizStep = 1;
  _wizPreset = WIZ_PRESETS[0];
  // Build the colour swatches once.
  const host = el('setup-swatches');
  if (host && !host.dataset.built) {
    host.dataset.built = '1';
    WIZ_PRESETS.forEach((p) => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'setup-swatch'; b.dataset.preset = p.id;
      b.style.cssText = `width:44px;height:44px;border-radius:50%;border:3px solid transparent;cursor:pointer;background:${p.tokens['--color-primary']}`;
      b.addEventListener('click', () => {
        _wizPreset = p;
        host.querySelectorAll('.setup-swatch').forEach((s) => s.style.borderColor = 'transparent');
        b.style.borderColor = 'var(--text-primary,#fff)';
      });
      host.appendChild(b);
    });
    host.querySelector('.setup-swatch').style.borderColor = 'var(--text-primary,#fff)';
  }
  renderWizStep();
}

function renderWizStep() {
  document.querySelectorAll('.setup-step').forEach((s) => { s.style.display = (+s.getAttribute('data-step') === _wizStep) ? '' : 'none'; });
  document.querySelectorAll('.setup-dot').forEach((d) => { d.style.background = (+d.getAttribute('data-step') <= _wizStep) ? 'var(--color-primary,#00A654)' : 'var(--border-subtle,#333)'; });
  const subs = { 1: t('wizard.step1sub', 'Compte administrateur'), 2: t('wizard.step2sub', 'Identité'), 3: t('wizard.step3sub', 'Thème'), 4: t('wizard.step4sub', 'Textes'), 5: t('wizard.step5sub', 'Plugins') };
  const sub = el('setup-step-sub'); if (sub) sub.textContent = subs[_wizStep] || '';
  el('setup-back').style.display = _wizStep > 1 ? '' : 'none';
  el('setup-skip').style.display = _wizStep > 1 ? '' : 'none';
  el('setup-next').textContent = _wizStep >= 5 ? t('wizard.finish', 'Terminer') : t('wizard.next', 'Suivant');
  setupError('');
}

async function wizNext() {
  if (_wizStep === 1) {
    const username = (el('setup-username').value || 'admin').trim() || 'admin';
    const p1 = el('setup-password').value || '';
    const p2 = el('setup-password2').value || '';
    if (p1.length < MIN_PASSWORD) { setupError(t('wizard.weak', `Mot de passe trop court (${MIN_PASSWORD} caractères minimum).`, { n: MIN_PASSWORD })); return; }
    if (p1 !== p2) { setupError(t('admin.setupMismatch', 'Les mots de passe ne correspondent pas.')); return; }
    const btn = el('setup-next'); btn.disabled = true; btn.innerHTML = `<span class="spinner spinner-sm"></span> ${t('admin.creating', 'Création…')}`;
    const r = await apiFetchStatus(`${API_AUTH}?action=setup`, { method: 'POST', body: JSON.stringify({ username, password: p1 }) });
    btn.disabled = false; btn.textContent = t('wizard.next', 'Suivant');
    if (r.ok && r.data?.ok) { setCsrf(r.data.csrf || null); _wizUsername = r.data.username || username; _wizPassword = p1; _wizStep = 2; renderWizStep(); }
    else if (r.status === 409) setupError(t('admin.setupExists', 'Un mot de passe existe déjà. Rechargez la page pour vous connecter.'));
    else setupError(r.data?.error === 'weak_password' ? t('wizard.weak', `Mot de passe trop court (${MIN_PASSWORD} caractères minimum).`, { n: MIN_PASSWORD }) : t('admin.setupFailed', 'Échec de la création du mot de passe.'));
    return;
  }
  if (_wizStep < 5) { _wizStep++; renderWizStep(); if (_wizStep === 5) _loadWizardPlugins(); return; }
  await finishWizard();
}

function wizBack() { if (_wizStep > 2) { _wizStep--; renderWizStep(); } else if (_wizStep === 2) { /* stay — account already created */ } }

async function finishWizard() {
  const btn = el('setup-next'); btn.disabled = true; btn.innerHTML = `<span class="spinner spinner-sm"></span> ${t('wizard.finishing', 'Finalisation…')}`;
  try {
    const inst = (await apiFetch(`${API_SITE}?action=get&doc=instance`)) || {};
    const v = (id) => (el(id)?.value || '').trim();
    const name = v('setup-name'), org = v('setup-org'), ss = v('setup-spec-s'), sp = v('setup-spec-p'), tagline = v('setup-tagline'), copyright = v('setup-copyright');
    inst.brand = inst.brand || {};
    if (name) { inst.brand.name = name; inst.brand.shortName = name; inst.brand.productName = name; inst.brand.monogram = name.replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase() || 'L3'; }
    if (org) { inst.brand.organization = org; inst.org = inst.org || {}; inst.org.name = org; }
    inst.specimen = inst.specimen || {};
    if (ss) inst.specimen.singular = ss;
    if (sp) inst.specimen.plural = sp;
    if (tagline) inst.brand.tagline = tagline;
    if (copyright) { inst.footer = inst.footer || {}; inst.footer.copyright = copyright; }
    await apiFetchStatus(`${API_SITE}?action=save&doc=instance`, { method: 'POST', body: JSON.stringify(inst) });
    if (_wizPreset && _wizPreset.tokens) await apiFetchStatus(`${API_SITE}?action=save&doc=theme`, { method: 'POST', body: JSON.stringify({ tokens: _wizPreset.tokens, dark: {}, light: {} }) });
    try { if (typeof InstanceConfig !== 'undefined') { await InstanceConfig.load(); InstanceConfig.applyHead(); InstanceConfig.applyDom(); } } catch (_) {}
  } catch (_) { /* seeding is best-effort; the account is already created */ }
  await _installWizardPlugins();
  toast(t('wizard.done', 'Installation terminée ✓'));
  enterApp(_wizUsername);
}

// ── First-run plugin picker (installs the selected first-party plugins) ─────────
const _PLACEMENT_LABEL = () => ({
  shaders: t('wizard.plShaders', 'Rendu'), channels: t('wizard.plChannels', 'Canaux'), tools: t('wizard.plTools', 'Outils'),
});

async function _loadWizardPlugins() {
  const host = el('setup-plugins');
  if (!host) return;
  host.innerHTML = `<div class="adm-loading" style="padding:10px"><span class="spinner spinner-sm"></span> ${escHtml(t('wizard.pluginsLoading', 'Chargement du catalogue…'))}</div>`;
  const data = await apiFetch(`${API_ADMIN}?action=marketplace_catalog`);
  const plugins = (data && Array.isArray(data.plugins)) ? data.plugins : [];
  if (!plugins.length) {
    host.innerHTML = `<p class="adm-page-sub" style="padding:6px">${escHtml(t('wizard.pluginsNone', 'Catalogue indisponible — vous pourrez installer des plugins plus tard depuis l\'onglet Catalogue.'))}</p>`;
    return;
  }
  const labels = _PLACEMENT_LABEL();
  const byPlace = {};
  plugins.forEach((p) => { (byPlace[p.placement] = byPlace[p.placement] || []).push(p); });
  host.innerHTML = ['shaders', 'channels', 'tools'].filter((pl) => byPlace[pl]).map((pl) => `
    <div style="margin-bottom:10px">
      <div style="font-size:11px;text-transform:uppercase;opacity:.6;margin:4px 0 3px">${escHtml(labels[pl] || pl)}</div>
      ${byPlace[pl].map((p) => {
        const disabled = p.compat === false;
        const checked = !disabled && (p.recommended || p.installed);
        return `<label style="display:flex;align-items:center;gap:8px;padding:3px 0;cursor:${disabled ? 'not-allowed' : 'pointer'};opacity:${disabled ? '.5' : '1'}">
          <input type="checkbox" class="wiz-plugin" value="${escHtml(p.id)}" ${checked ? 'checked' : ''} ${disabled ? 'disabled' : ''}>
          <span style="flex:1">${escHtml(p.name || p.id)}${disabled ? ' <span style="opacity:.6">(' + escHtml(t('mkt.incompatible', 'incompatible')) + ')</span>' : ''}</span>
        </label>`;
      }).join('')}
    </div>`).join('');
}

async function _installWizardPlugins() {
  const boxes = [...document.querySelectorAll('#setup-plugins .wiz-plugin:checked')];
  if (!boxes.length) return;
  const prog = el('setup-plugins-progress');
  if (prog) prog.style.display = '';
  let done = 0, failed = 0;
  for (let i = 0; i < boxes.length; i++) {
    if (prog) prog.textContent = `${t('wizard.installing2', 'Installation des plugins…')} (${i + 1}/${boxes.length})`;
    const r = await apiFetchStatus(`${API_ADMIN}?action=install_plugin`, { method: 'POST', body: JSON.stringify({ id: boxes[i].value, password: _wizPassword }) });
    if ((r.ok && r.data?.ok) || r.data?.error === 'already_installed') done++; else failed++;
  }
  if (prog) prog.textContent = t('wizard.installedN', '{n} plugin(s) installé(s).', { n: done }) + (failed ? ` (${failed} ${t('wizard.failed', 'échoué(s)')})` : '');
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
  el('setup-next')?.addEventListener('click', wizNext);
  el('setup-back')?.addEventListener('click', wizBack);
  el('setup-skip')?.addEventListener('click', finishWizard);
  el('setup-password2')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') wizNext(); });

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
  // Instance config first so I18n.t() sees the brand/specimen tokens and the
  // admin head/brand reflect the operator's identity. InstanceConfig is a
  // global-lexical binding from the classic instance-config.js loaded before
  // this module (same access path as I18n/Utils).
  if (typeof InstanceConfig !== 'undefined') { try { await InstanceConfig.load(); } catch (_) {} }
  if (I18n?.init) { try { await I18n.init(); } catch (_) {} }
  if (typeof InstanceConfig !== 'undefined') {
    try { InstanceConfig.applyHead(); InstanceConfig.applyDom(); } catch (_) {}
  }
  setUnauthorizedHandler(() => { if (_appReady) showGate('login'); });
  setNavigator(switchTab);
  applyTheme(loadTheme());
  applyCollapsed(loadCollapsed());
  bindChrome();
  refreshIcons();
  await checkAuth();
}
