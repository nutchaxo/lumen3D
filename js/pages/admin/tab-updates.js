/**
 * Admin SPA — Version & Update tab
 * ================================
 * Shows the installed versions, checks GitHub releases, and applies a guarded
 * one-click update (backup → download → extract → restart) with live progress.
 */

'use strict';

import { API_ADMIN, t, escHtml, apiFetch, apiFetchStatus, toast, el, refreshIcons } from './shared.js';

let _versions = null;
let _check = null;
let _polling = false;

function versionChip(labelKey, labelDef, value) {
  return `<div class="adm-vchip">
      <span class="adm-vchip-label">${escHtml(t(labelKey, labelDef))}</span>
      <span class="adm-vchip-value">${escHtml(value || '—')}</span>
    </div>`;
}

function updateBlock() {
  if (!_check) return `<div class="adm-update-state adm-checking"><span class="spinner spinner-sm"></span> ${escHtml(t('admin.checking', 'Recherche de mises à jour…'))}</div>`;
  if (_check.error) return `<div class="adm-update-state adm-warn"><i data-lucide="wifi-off"></i> ${escHtml(t('admin.checkError', 'Impossible de contacter GitHub.'))} <span class="adm-muted">${escHtml(_check.error)}</span></div>`;
  if (_check.noReleases) return `<div class="adm-update-state adm-ok"><i data-lucide="check-circle-2"></i> ${escHtml(t('admin.noReleases', 'Aucune release publiée sur GitHub pour le moment.'))}</div>`;
  if (!_check.available) return `<div class="adm-update-state adm-ok"><i data-lucide="check-circle-2"></i> ${escHtml(t('admin.upToDate', 'Vous êtes à jour.'))} <span class="adm-muted">(${escHtml(_check.latest || _check.current)})</span></div>`;

  return `
    <div class="adm-update-state adm-avail"><i data-lucide="sparkles"></i> ${escHtml(t('admin.updateAvailable', 'Mise à jour disponible'))} : <b>v${escHtml(_check.latest)}</b></div>
    ${_check.notes ? `<div class="adm-release-notes-head">${escHtml(t('admin.releaseNotes', 'Notes de version'))}</div>
      <pre class="adm-release-notes">${escHtml(_check.notes)}</pre>` : ''}
    <div class="adm-update-actions">
      <button class="adm-btn adm-btn-accent" id="btn-update"><i data-lucide="download-cloud"></i> ${escHtml(t('admin.updateNow', 'Mettre à jour maintenant'))}</button>
      ${_check.htmlUrl ? `<a class="adm-btn adm-btn-ghost" href="${escHtml(_check.htmlUrl)}" target="_blank" rel="noopener"><i data-lucide="external-link"></i> GitHub</a>` : ''}
    </div>
    <div class="adm-update-warn"><i data-lucide="shield"></i> ${escHtml(t('admin.updateWarn', 'Une sauvegarde est créée avant la mise à jour. Vos données (DATA_WEB), identifiants et statistiques sont préservés. Le serveur redémarre à la fin.'))}</div>`;
}

function render() {
  const root = el('updates-root');
  if (!root) return;
  const v = _versions || {};
  root.innerHTML = `
    <div class="adm-page-head">
      <div>
        <h2 class="adm-page-title">${escHtml(t('admin.updatesTitle', 'Version & mises à jour'))}</h2>
        <p class="adm-page-sub">${escHtml(t('admin.updatesSub', 'Suivi de version et mise à jour automatique depuis GitHub.'))}</p>
      </div>
      <button class="adm-btn adm-btn-ghost adm-btn-sm" id="btn-recheck"><i data-lucide="refresh-cw"></i> ${escHtml(t('admin.checkUpdates', 'Vérifier'))}</button>
    </div>

    <div class="adm-card">
      <div class="adm-card-head"><i data-lucide="tag"></i><span>${escHtml(t('admin.currentVersion', 'Versions installées'))}</span></div>
      <div class="adm-card-body adm-vchips">
        ${versionChip('admin.webPlatform', 'Plateforme Web', v.web ? `v${v.web}` : null)}
        ${versionChip('admin.devServer', 'Serveur de dev', v.devServer ? `v${v.devServer}` : null)}
        ${versionChip('admin.preprocess', 'Préprocessing', v.preprocess ? `v${v.preprocess}` : null)}
      </div>
    </div>

    <div class="adm-card" style="margin-top:18px">
      <div class="adm-card-head"><i data-lucide="cloud-download"></i><span>${escHtml(t('admin.githubUpdate', 'Mise à jour GitHub'))}</span>
        <span class="adm-card-count adm-muted">${escHtml((v.repo) || '')}</span></div>
      <div class="adm-card-body" id="update-body">${updateBlock()}</div>
    </div>

    <div class="adm-card adm-progress-card" id="progress-card" style="display:none;margin-top:18px">
      <div class="adm-card-head"><i data-lucide="loader"></i><span>${escHtml(t('admin.updating', 'Mise à jour en cours'))}</span></div>
      <div class="adm-card-body">
        <div class="adm-progress"><div class="adm-progress-bar" id="progress-bar" style="width:0%"></div></div>
        <div class="adm-progress-msg" id="progress-msg"></div>
      </div>
    </div>`;

  el('btn-recheck')?.addEventListener('click', recheck);
  el('btn-update')?.addEventListener('click', startUpdate);
  refreshIcons(root);
}

async function loadVersions() {
  const v = await apiFetch(`${API_ADMIN}?action=version`);
  if (v) _versions = v;
}

async function loadCheck() {
  _check = null;
  render();
  const c = await apiFetch(`${API_ADMIN}?action=update_check`);
  _check = c || { error: 'no_response' };
  const dot = el('nav-update-dot');
  if (dot) dot.style.display = _check.available ? 'inline-block' : 'none';
  render();
}

function recheck() { loadCheck(); }

async function startUpdate() {
  if (!confirm(t('admin.updateConfirm', 'Lancer la mise à jour ? Le serveur sera redémarré et vous devrez vous reconnecter.'))) return;
  const r = await apiFetchStatus(`${API_ADMIN}?action=update_apply`, { method: 'POST', body: '{}' });
  if (!(r.ok && r.data?.ok)) {
    toast(r.data?.error === 'no_update_available'
      ? t('admin.upToDate', 'Vous êtes à jour.')
      : t('admin.updateFailed', 'Échec du lancement de la mise à jour.'), 'error');
    return;
  }
  el('progress-card').style.display = 'block';
  el('btn-update') && (el('btn-update').disabled = true);
  pollStatus();
}

async function pollStatus() {
  if (_polling) return;
  _polling = true;
  let misses = 0;
  const tick = async () => {
    const s = await apiFetch(`${API_ADMIN}?action=update_status`);
    if (!s) {
      // Server likely restarting (re-exec). After a few misses, reload to re-login.
      misses++;
      setProgress(96, t('admin.updateRestart', 'Redémarrage du serveur…'));
      if (misses > 6) { location.reload(); return; }
      setTimeout(tick, 1500);
      return;
    }
    misses = 0;
    setProgress(s.pct || 0, s.message || '');
    if (s.phase === 'error') {
      _polling = false;
      toast(t('admin.updateFailed', 'Échec de la mise à jour.') + (s.error ? ` (${s.error})` : ''), 'error');
      el('btn-update') && (el('btn-update').disabled = false);
      return;
    }
    if (s.phase === 'done') {
      setProgress(100, t('admin.updateDone', 'Terminé. Redémarrage…'));
      // The server re-execs ~1.5s after 'done'; reload shortly after to re-login.
      setTimeout(() => location.reload(), 3500);
      return;
    }
    setTimeout(tick, 1000);
  };
  tick();
}

function setProgress(pct, msg) {
  const bar = el('progress-bar'), m = el('progress-msg');
  if (bar) bar.style.width = `${Math.max(0, Math.min(100, pct))}%`;
  if (m) m.textContent = msg || '';
}

export const UpdatesTab = {
  id: 'updates',
  titleKey: 'admin.navUpdates',
  titleDefault: 'Mises à jour',
  mounted: false,
  mount() { render(); loadVersions().then(render); loadCheck(); },
  activate() {},
  relabel() { render(); },
};
