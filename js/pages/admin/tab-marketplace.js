/**
 * Admin SPA — Plugin marketplace (white-label)
 * ============================================
 * Browse the CURATED, first-party plugin catalog and install in one click.
 * Installs are ALWAYS operator-initiated (this tab), re-auth'd with the admin
 * password, verified fail-closed server-side (Ed25519 catalog + release
 * signature), and land in the SAME trust gate + sandbox as any plugin — no new
 * arbitrary-code-execution surface. Reuses /api/admin.php actions:
 * marketplace_catalog / install_plugin / uninstall_plugin (Python + PHP twins).
 */

'use strict';

import { API_ADMIN, t, escHtml, apiFetch, apiFetchStatus, toast, el, refreshIcons } from './shared.js';

let _data = { configured: false, signed: false, plugins: [] };
let _busy = false;

// A plugin's on-install trust posture: only toolbar action/toggle plugins are
// sandboxable; shaders/channels run with full in-page trust (higher bar).
function _trustBadge(p) {
  const sandboxable = p.placement === 'tools';
  return sandboxable
    ? `<span class="adm-badge adm-badge-ok" title="${escHtml(t('mkt.sandboxHint', 'Exécuté isolé (bac à sable)'))}">${escHtml(t('mkt.sandboxed', 'bac à sable'))}</span>`
    : `<span class="adm-badge adm-badge-warn" title="${escHtml(t('mkt.trustedHint', 'Confiance totale en page (shaders/canaux)'))}">${escHtml(t('mkt.fullTrust', 'confiance totale'))}</span>`;
}

function _card(p) {
  const caps = Array.isArray(p.sandboxCapabilities) ? p.sandboxCapabilities : [];
  const capHtml = caps.length
    ? `<div class="mkt-caps" style="margin-top:6px;font-size:11px;opacity:.7">${escHtml(t('mkt.caps', 'Capacités'))}: ${caps.map(escHtml).join(', ')}</div>`
    : '';
  const compatBad = p.compat === false
    ? `<span class="adm-badge adm-badge-err" title="${escHtml(p.compatReason || '')}">${escHtml(t('mkt.incompatible', 'incompatible'))}</span>` : '';
  let action;
  if (p.installed) action = `<button class="adm-btn adm-btn-ghost adm-btn-sm mkt-uninstall" data-path="${escHtml(p.placement + '/' + p.id)}"><i data-lucide="trash-2"></i> ${escHtml(t('mkt.uninstall', 'Désinstaller'))}</button>`;
  else if (p.compat === false) action = `<button class="adm-btn adm-btn-ghost adm-btn-sm" disabled>${escHtml(t('mkt.incompatible', 'incompatible'))}</button>`;
  else action = `<button class="adm-btn adm-btn-accent adm-btn-sm mkt-install" data-id="${escHtml(p.id)}"><i data-lucide="download"></i> ${escHtml(t('mkt.install', 'Installer'))}</button>`;
  return `<div class="adm-card" style="padding:16px;display:flex;flex-direction:column;gap:6px">
      <div style="display:flex;align-items:center;gap:8px">
        <i data-lucide="${escHtml(p.icon || 'puzzle')}"></i>
        <b style="flex:1">${escHtml(p.name || p.id)}</b>
        ${_trustBadge(p)} ${compatBad}
      </div>
      <div style="opacity:.65;font-size:12px">${escHtml(p.creator || '')} · ${escHtml(p.placement || '')}${p.latestVersion ? ' · v' + escHtml(p.latestVersion) : ''}</div>
      <div style="font-size:13px;opacity:.85">${escHtml(p.description || '')}</div>
      ${capHtml}
      <div style="margin-top:8px">${action}</div>
    </div>`;
}

function render() {
  const root = el('marketplace-root');
  if (!root) return;

  if (!_data.configured) {
    root.innerHTML = `<div class="adm-page-head"><div><h2 class="adm-page-title">${escHtml(t('mkt.title', 'Catalogue de plugins'))}</h2>
      <p class="adm-page-sub">${escHtml(t('mkt.notConfigured', "Aucune source de catalogue configurée (_MARKETPLACE_CATALOG_URL). Le marketplace est inactif."))}</p></div></div>`;
    return;
  }

  const plugins = Array.isArray(_data.plugins) ? _data.plugins : [];
  const installed = plugins.filter((p) => p.installed);
  const available = plugins.filter((p) => !p.installed && p.compat !== false);
  const incompatible = plugins.filter((p) => !p.installed && p.compat === false);
  const grid = (arr) => `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:14px">${arr.map(_card).join('')}</div>`;
  const section = (titleKey, def, arr) => arr.length ? `<h3 style="margin:18px 0 10px">${escHtml(t(titleKey, def))} <span style="opacity:.5">(${arr.length})</span></h3>${grid(arr)}` : '';

  root.innerHTML = `
    <div class="adm-page-head">
      <div>
        <h2 class="adm-page-title">${escHtml(t('mkt.title', 'Catalogue de plugins'))}</h2>
        <p class="adm-page-sub">${escHtml(t('mkt.sub', 'Plugins first-party curés et signés. Installation en un clic, vérifiée.'))}
          ${_data.signed ? `<span class="adm-badge adm-badge-ok">${escHtml(t('mkt.signedOn', 'signature vérifiée'))}</span>` : `<span class="adm-badge adm-badge-warn" title="${escHtml(t('mkt.signedOffHint', 'Clé de signature non configurée — intégrité sha256 seule.'))}">${escHtml(t('mkt.signedOff', 'non signé'))}</span>`}</p>
      </div>
      <button class="adm-btn adm-btn-ghost adm-btn-sm" id="mkt-refresh"><i data-lucide="refresh-cw"></i> ${escHtml(t('mkt.refresh', 'Actualiser'))}</button>
    </div>
    ${_data.error ? `<div class="adm-gate-error" style="display:flex">${escHtml(t('mkt.error', 'Catalogue indisponible'))}: ${escHtml(_data.error)}</div>` : ''}
    ${section('mkt.installed', 'Installés', installed)}
    ${section('mkt.available', 'Disponibles', available)}
    ${section('mkt.incompatible2', 'Incompatibles', incompatible)}
    ${(!installed.length && !available.length && !incompatible.length && !_data.error) ? `<p class="adm-page-sub">${escHtml(t('mkt.empty', 'Aucun plugin dans le catalogue.'))}</p>` : ''}`;

  el('mkt-refresh')?.addEventListener('click', load);
  root.querySelectorAll('.mkt-install').forEach((b) => b.addEventListener('click', () => install(b.getAttribute('data-id'))));
  root.querySelectorAll('.mkt-uninstall').forEach((b) => b.addEventListener('click', () => uninstall(b.getAttribute('data-path'))));
  refreshIcons(root);
}

async function load() {
  const data = await apiFetch(`${API_ADMIN}?action=marketplace_catalog`);
  if (data) _data = data;
  render();
}

async function install(id) {
  if (_busy) return;
  const pw = prompt(t('mkt.installConfirm', "Installer ce plugin ? Confirmez avec votre mot de passe administrateur :"));
  if (!pw) return;
  _busy = true;
  toast(t('mkt.installing', 'Installation en cours (téléchargement + vérification)…'), 'info');
  const r = await apiFetchStatus(`${API_ADMIN}?action=install_plugin`, { method: 'POST', body: JSON.stringify({ id, password: pw }) });
  _busy = false;
  if (r.ok && r.data?.ok) { toast(t('mkt.installed2', 'Plugin installé et approuvé ✓'), 'success'); await load(); }
  else {
    const err = r.data?.error || 'error';
    const map = { bad_password: t('mkt.badPassword', 'Mot de passe incorrect.'), already_installed: t('mkt.alreadyInstalled', 'Déjà installé.'), incompatible: t('mkt.incompatible', 'incompatible'), install_failed: t('mkt.installFailed', "Échec de l'installation (vérification échouée)."), catalog_fetch_failed: t('mkt.catalogFail', 'Catalogue inaccessible.') };
    toast(map[err] || (t('mkt.installFailed', "Échec de l'installation.") + ' (' + err + ')'), 'error');
  }
}

async function uninstall(path) {
  if (_busy) return;
  if (!confirm(t('mkt.uninstallConfirm', 'Désinstaller ce plugin ?'))) return;
  _busy = true;
  const r = await apiFetchStatus(`${API_ADMIN}?action=uninstall_plugin`, { method: 'POST', body: JSON.stringify({ path }) });
  _busy = false;
  if (r.ok && r.data?.ok) { toast(t('mkt.uninstalled', 'Plugin désinstallé.'), 'success'); await load(); }
  else toast(r.data?.error === 'last_shader' ? t('mkt.lastShader', 'Impossible : dernier mode de rendu.') : t('mkt.uninstallFailed', 'Échec de la désinstallation.'), 'error');
}

export const MarketplaceTab = {
  id: 'marketplace',
  titleKey: 'admin.navMarketplace',
  titleDefault: 'Catalogue',
  mounted: false,
  mount() { render(); load(); },
  activate() { load(); },
  relabel() { render(); },
};
