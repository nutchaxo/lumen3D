/**
 * Admin SPA — Version & Update tab
 * ================================
 * Shows installed versions, checks GitHub releases, and drives the guarded
 * self-update pipeline (dev_server.py): preflight report (plugin compatibility
 * against the TARGET version) → confirm → staged download/verify/boot-check →
 * journaled swap with health-gated restart → automatic rollback on failure.
 * The tab keeps reporting through the server restart via the public /api/health
 * probe, then surfaces the persisted outcome (done / rolled_back) for
 * acknowledgement once the operator is signed in again.
 */

'use strict';

import { API_ADMIN, t, escHtml, apiFetch, apiFetchStatus, toast, el, refreshIcons } from './shared.js';

let _versions = null;
let _check = null;
let _preflight = null;   // report shown between "Mettre à jour" and confirmation
let _polling = false;

// Server pipeline phases → i18n chip label (order = visual stepper order).
const PHASES = [
  ['preflight', 'admin.phasePreflight', 'Vérifications'],
  ['backup', 'admin.phaseBackup', 'Sauvegarde'],
  ['download', 'admin.phaseDownload', 'Téléchargement'],
  ['verify', 'admin.phaseVerify', 'Intégrité'],
  ['staging', 'admin.phaseStaging', 'Préparation'],
  ['verifying', 'admin.phaseVerifying', 'Contrôle de démarrage'],
  ['planning', 'admin.phasePlanning', 'Plan de basculement'],
  ['pivoting', 'admin.phasePivoting', 'Basculement'],
  ['restart', 'admin.phaseRestart', 'Redémarrage du serveur'],
];

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
    ${_preflight ? preflightBlock() : `
    <div class="adm-update-actions">
      <button class="adm-btn adm-btn-accent" id="btn-update"><i data-lucide="download-cloud"></i> ${escHtml(t('admin.updateNow', 'Mettre à jour maintenant'))}</button>
      ${_check.htmlUrl ? `<a class="adm-btn adm-btn-ghost" href="${escHtml(_check.htmlUrl)}" target="_blank" rel="noopener"><i data-lucide="external-link"></i> GitHub</a>` : ''}
    </div>
    <div class="adm-update-warn"><i data-lucide="shield"></i> ${escHtml(t('admin.updateWarn', 'Une sauvegarde est créée avant la mise à jour. Vos données (DATA_WEB), identifiants et statistiques sont préservés. Le serveur redémarre à la fin.'))}</div>`}`;
}

// Compat report against the TARGET version, shown before the operator confirms.
function preflightBlock() {
  const p = _preflight;
  const blocking = Array.isArray(p.blocking) ? p.blocking : [];
  const quarantine = Array.isArray(p.willQuarantine) ? p.willQuarantine : [];
  const okCount = Array.isArray(p.ok) ? p.ok.length : 0;
  return `
    <div class="adm-preflight">
      <div class="adm-release-notes-head">${escHtml(t('admin.preflightTitle', 'Vérification avant mise à jour'))} → v${escHtml(p.target || '?')}</div>
      <div class="adm-update-state adm-ok"><i data-lucide="check-circle-2"></i>
        ${escHtml(t('admin.preflightOkLabel', 'Plugins compatibles avec la nouvelle version'))} : <b>${okCount}</b></div>
      ${quarantine.length ? `
        <div class="adm-update-state adm-warn"><i data-lucide="alert-triangle"></i>
          ${escHtml(t('admin.preflightQuarantine', 'Plugins qui seront mis en quarantaine (incompatibles)'))} :
          <b>${quarantine.map(q => escHtml(q.name || q.path)).join(', ')}</b></div>
        <div class="adm-muted" style="margin:4px 0 0 26px">${escHtml(t('admin.preflightQuarantineNote', "Ils seront réactivés automatiquement dès qu'une mise à jour les rendra compatibles."))}</div>` : ''}
      ${blocking.length ? `
        <div class="adm-update-state adm-error"><i data-lucide="octagon-x"></i>
          ${escHtml(t('admin.preflightBlocking', 'Mise à jour bloquée'))} : ${blocking.map(b => escHtml(b.detail || b.reason)).join(' · ')}</div>` : ''}
      <div class="adm-update-actions">
        ${blocking.length ? '' : `<button class="adm-btn adm-btn-accent" id="btn-confirm-update"><i data-lucide="check"></i> ${escHtml(t('admin.confirmUpdate', 'Confirmer la mise à jour'))}</button>`}
        <button class="adm-btn adm-btn-ghost" id="btn-cancel-update">${escHtml(t('admin.cancel', 'Annuler'))}</button>
      </div>
    </div>`;
}

// Persisted outcome of the previous run (survives the restart), if any.
function lastOutcomeBlock(last) {
  if (!last) return '';
  const done = last.phase === 'done';
  const cls = done ? 'adm-ok' : 'adm-warn';
  const icon = done ? 'check-circle-2' : 'undo-2';
  const text = done
    ? `${t('admin.updateSucceeded', 'Mise à jour terminée avec succès. Le serveur a redémarré — reconnectez-vous.')} (v${last.target || '?'})`
    : `${t('admin.updateRolledBack', "La nouvelle version n'a pas démarré — restauration automatique effectuée. L'ancienne version fonctionne.")}${last.error ? ` — ${last.error}` : ''}`;
  return `
    <div class="adm-card" style="margin-top:18px" id="last-outcome-card">
      <div class="adm-card-head"><i data-lucide="history"></i><span>${escHtml(t('admin.lastUpdateOutcome', 'Dernière mise à jour'))}</span></div>
      <div class="adm-card-body">
        <div class="adm-update-state ${cls}"><i data-lucide="${icon}"></i> ${escHtml(text)}</div>
        <div class="adm-update-actions">
          <button class="adm-btn adm-btn-ghost adm-btn-sm" id="btn-ack-update">${escHtml(t('admin.ack', 'Compris'))}</button>
        </div>
      </div>
    </div>`;
}

function render(lastOutcome) {
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

    ${lastOutcomeBlock(lastOutcome)}

    <div class="adm-card" style="margin-top:18px">
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
        <div class="adm-phase-chips" id="phase-chips">${PHASES.map(([key, i18nKey, def]) =>
          `<span class="adm-phase-chip" data-phase="${key}">${escHtml(t(i18nKey, def))}</span>`).join('')}</div>
        <div class="adm-progress"><div class="adm-progress-bar" id="progress-bar" style="width:0%"></div></div>
        <div class="adm-progress-msg" id="progress-msg"></div>
      </div>
    </div>`;

  el('btn-recheck')?.addEventListener('click', recheck);
  el('btn-update')?.addEventListener('click', startPreflight);
  el('btn-confirm-update')?.addEventListener('click', confirmUpdate);
  el('btn-cancel-update')?.addEventListener('click', () => { _preflight = null; render(); });
  el('btn-ack-update')?.addEventListener('click', ackOutcome);
  refreshIcons(root);
}

async function loadVersions() {
  const v = await apiFetch(`${API_ADMIN}?action=version`);
  if (v) _versions = v;
}

async function loadCheck() {
  _check = null;
  _preflight = null;
  render();
  const c = await apiFetch(`${API_ADMIN}?action=update_check`);
  _check = c || { error: 'no_response' };
  const dot = el('nav-update-dot');
  if (dot) dot.style.display = _check.available ? 'inline-block' : 'none';
  // Surface the persisted outcome of a previous run (idle → state.last).
  const s = await apiFetch(`${API_ADMIN}?action=update_status`);
  render(s?.phase === 'idle' ? s.last : null);
}

function recheck() { loadCheck(); }

async function ackOutcome() {
  await apiFetchStatus(`${API_ADMIN}?action=update_ack`, { method: 'POST', body: '{}' });
  el('last-outcome-card')?.remove();
}

/** Step 1 — no mutation: fetch the compat report against the target version. */
async function startPreflight() {
  const btn = el('btn-update');
  if (btn) btn.disabled = true;
  const p = await apiFetch(`${API_ADMIN}?action=update_preflight&target=${encodeURIComponent(_check?.latest || '')}`);
  if (!p) {
    toast(t('admin.updateFailed', 'Échec du lancement de la mise à jour.'), 'error');
    if (btn) btn.disabled = false;
    return;
  }
  _preflight = p;
  render();
}

/** Step 2 — the operator confirmed with the report in view: launch the pipeline. */
async function confirmUpdate() {
  const r = await apiFetchStatus(`${API_ADMIN}?action=update_apply`, { method: 'POST', body: '{}' });
  if (!(r.ok && r.data?.ok)) {
    toast(r.data?.error === 'no_update_available'
      ? t('admin.upToDate', 'Vous êtes à jour.')
      : t('admin.updateFailed', 'Échec du lancement de la mise à jour.'), 'error');
    return;
  }
  _preflight = null;
  render();
  el('progress-card').style.display = 'block';
  el('btn-update') && (el('btn-update').disabled = true);
  pollStatus();
}

function setProgress(pct, msg, phase) {
  const bar = el('progress-bar'), m = el('progress-msg');
  if (bar) bar.style.width = `${Math.max(0, Math.min(100, pct))}%`;
  if (m) m.textContent = msg || '';
  if (phase) {
    const order = PHASES.map(p => p[0]);
    const idx = order.indexOf(phase);
    document.querySelectorAll('#phase-chips .adm-phase-chip').forEach((chip) => {
      const ci = order.indexOf(chip.dataset.phase);
      chip.classList.toggle('is-current', ci === idx);
      chip.classList.toggle('is-done', idx >= 0 && ci >= 0 && ci < idx);
    });
  }
}

/** Poll the pipeline. From 'pivoting' on, the server stops answering (it exits
 *  for the swap) — switch to the public /api/health probe, which the NEW (or
 *  restored) server answers, then report the persisted outcome. */
async function pollStatus() {
  if (_polling) return;
  _polling = true;
  const tick = async () => {
    const s = await apiFetch(`${API_ADMIN}?action=update_status`);
    if (!s) { _polling = false; pollRestart(); return; }
    setProgress(s.pct || 0, s.message || '', s.phase);
    if (s.phase === 'error') {
      _polling = false;
      toast(t('admin.updateFailed', 'Échec de la mise à jour.') + (s.error ? ` (${s.error})` : ''), 'error');
      el('btn-update') && (el('btn-update').disabled = false);
      loadCheck();
      return;
    }
    if (s.phase === 'pivoting') { _polling = false; pollRestart(); return; }
    setTimeout(tick, 1000);
  };
  tick();
}

function pollRestart() {
  setProgress(93, t('admin.updateRestart', 'Redémarrage du serveur…'), 'restart');
  const deadline = Date.now() + 120000;
  const probe = async () => {
    try {
      const resp = await fetch('api/health', { cache: 'no-store' });
      if (resp.ok) {
        const h = await resp.json();
        if (h?.ok) {
          const done = h.lastUpdate?.phase !== 'rolled_back';
          setProgress(100,
            done ? `${t('admin.updateSucceeded', 'Mise à jour terminée avec succès. Le serveur a redémarré — reconnectez-vous.')} (v${h.web})`
                 : t('admin.updateRolledBack', "La nouvelle version n'a pas démarré — restauration automatique effectuée. L'ancienne version fonctionne."),
            done ? undefined : 'restart');
          setTimeout(() => location.reload(), 2500);
          return;
        }
      }
    } catch (_) { /* server still down — keep probing */ }
    if (Date.now() > deadline) {
      setProgress(0, t('admin.updateTimeout', 'Le serveur ne répond plus. Vérifiez logs/update-pivot-*.log puis rechargez la page.'));
      return;
    }
    setTimeout(probe, 1500);
  };
  probe();
}

export const UpdatesTab = {
  id: 'updates',
  titleKey: 'admin.navUpdates',
  titleDefault: 'Mises à jour',
  mounted: false,
  mount() { render(); loadVersions().then(() => render()); loadCheck(); },
  activate() {},
  relabel() { render(); },
};
