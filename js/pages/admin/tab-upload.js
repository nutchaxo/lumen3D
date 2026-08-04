/**
 * Admin SPA — Import tab
 * ======================
 * Drop the folder the preprocessing pipeline produced and it goes live. The tab
 * is the *console* for an import; the transfer itself is owned by
 * upload-manager.js and runs on regardless of which tab is showing, so nothing
 * here may hold transfer state of its own.
 *
 * What the operator sees, in the order they need it:
 *   1. a dropzone that accepts DATA_WEB/, one type folder, or a single dataset;
 *   2. what was found and what was refused, BEFORE anything is sent;
 *   3. per-dataset progress with the state that matters — can I edit this yet?
 *   4. publish, once a dataset is complete and validated.
 *
 * Refused paths are shown rather than silently dropped: an operator whose dataset
 * carries an extra file should learn that the import ignored it, not discover a
 * gap later.
 */

'use strict';

import { t, escHtml, refreshIcons, toast, el } from './shared.js';
import { navigateTo } from './bus.js';
import * as Upload from './upload-manager.js';

let _host = null;
let _unsub = null;
let _dragDepth = 0;
let _busyScan = false;

// ── Mount ──────────────────────────────────────────────────────────────────────

function build() {
  _host.innerHTML = `
    <div class="adm-page-head">
      <div>
        <h2 class="adm-page-title">${escHtml(t('upl.title', 'Importer des datasets'))}</h2>
        <p class="adm-page-sub">${escHtml(t('upl.subtitle', 'Glissez le dossier produit par le pipeline de préprocessing. Le transfert reprend là où il s\'est arrêté si vous reglissez le même dossier.'))}</p>
      </div>
      <div class="adm-page-head-actions">
        <button type="button" class="adm-btn adm-btn-ghost" id="upl-refresh">
          <i data-lucide="refresh-cw"></i> ${escHtml(t('upl.refresh', 'Actualiser'))}
        </button>
      </div>
    </div>

    <div class="upl-drop" id="upl-drop" tabindex="0" role="button"
         aria-label="${escHtml(t('upl.dropAria', 'Déposer un dossier de datasets'))}">
      <i data-lucide="folder-up" class="upl-drop-icon"></i>
      <div class="upl-drop-title">${escHtml(t('upl.dropTitle', 'Glissez un dossier ici'))}</div>
      <div class="upl-drop-sub">${escHtml(t('upl.dropSub', 'DATA_WEB entier, un dossier fixed / live / tracking, ou un seul dataset — le type est détecté automatiquement.'))}</div>
      <button type="button" class="adm-btn adm-btn-accent" id="upl-pick">
        <i data-lucide="folder"></i> ${escHtml(t('upl.pick', 'Choisir un dossier'))}
      </button>
      <input type="file" id="upl-input" webkitdirectory directory multiple hidden>
    </div>

    <div class="upl-note">
      <i data-lucide="shield-check"></i>
      <span>${escHtml(t('upl.securityNote', 'Les fichiers transitent par un dossier privé, inaccessible par URL, et ne rejoignent les datasets publiés qu\'après validation complète. Seuls les fichiers attendus par la plateforme sont acceptés.'))}</span>
    </div>

    <div id="upl-body"></div>`;
  refreshIcons(_host);
  wire();
}

function wire() {
  const drop = el('upl-drop');
  const input = el('upl-input');

  el('upl-pick').addEventListener('click', () => input.click());
  drop.addEventListener('click', (e) => { if (e.target === drop || e.target.closest('.upl-drop-title, .upl-drop-icon')) input.click(); });
  drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
  input.addEventListener('change', () => {
    if (input.files && input.files.length) begin(Upload.readFileInput(input.files));
    input.value = '';
  });

  // dragenter/dragleave fire for every child element the cursor crosses, so a
  // naive toggle flickers. Counting depth keeps the highlight stable.
  ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => {
    e.preventDefault();
    if (ev === 'dragenter') _dragDepth++;
    drop.classList.add('is-over');
  }));
  drop.addEventListener('dragleave', (e) => {
    e.preventDefault();
    if (--_dragDepth <= 0) { _dragDepth = 0; drop.classList.remove('is-over'); }
  });
  drop.addEventListener('drop', async (e) => {
    e.preventDefault();
    _dragDepth = 0;
    drop.classList.remove('is-over');
    const entries = await Upload.readDataTransfer(e.dataTransfer);
    begin(entries);
  });

  el('upl-refresh').addEventListener('click', () => Upload.refreshStaged());

  _host.addEventListener('click', onBodyClick);
}

async function begin(entries) {
  if (_busyScan) return;
  if (!entries || !entries.length) {
    toast(t('upl.errEmpty', 'Aucun fichier détecté dans ce dépôt.'), 'error');
    return;
  }
  _busyScan = true;
  render();
  const r = await Upload.startImport(entries);
  _busyScan = false;
  if (!r.ok) {
    toast(Upload.getState().error || t('upl.errPlan', 'Le serveur a refusé le plan d\'import.'), 'error');
  } else if (r.nothingToDo) {
    toast(t('upl.nothingToDo', 'Tout est déjà envoyé — rien à transférer.'));
  }
  render();
}

// ── Actions ────────────────────────────────────────────────────────────────────

async function onBodyClick(e) {
  const btn = e.target.closest('[data-upl-action]');
  if (!btn) return;
  const action = btn.dataset.uplAction;
  const key = btn.dataset.key;

  if (action === 'pause') { Upload.pause(); return; }
  if (action === 'resume') { Upload.resume(); return; }
  if (action === 'cancel') {
    if (confirm(t('upl.confirmCancel', 'Arrêter le transfert ? Les fichiers déjà envoyés sont conservés et le transfert reprendra si vous reglissez le dossier.'))) Upload.cancelAll();
    return;
  }
  if (action === 'edit') { navigateTo('datasets'); return; }
  if (action === 'validate') {
    btn.disabled = true;
    const v = await Upload.validate(key);
    btn.disabled = false;
    if (v && v.ok) toast(t('upl.validOk', 'Dataset valide ✓'));
    else toast(t('upl.validFail', 'Validation échouée : {errors}', { errors: (v?.errors || []).join(', ') }), 'error');
    return;
  }
  if (action === 'publish' || action === 'publish-overwrite') {
    btn.disabled = true;
    const r = await Upload.publish(key, { overwrite: action === 'publish-overwrite' });
    btn.disabled = false;
    if (r.ok && r.data?.ok) {
      toast(t('upl.published', 'Dataset publié ✓ (masqué de l\'explorer — activez-le dans l\'onglet Datasets)'));
    } else if (r.data?.error === 'already_exists') {
      if (confirm(t('upl.confirmOverwrite', 'Un dataset publié porte déjà ce nom. Le remplacer ?'))) {
        const r2 = await Upload.publish(key, { overwrite: true });
        toast(r2.ok && r2.data?.ok ? t('upl.published', 'Dataset publié ✓ (masqué de l\'explorer — activez-le dans l\'onglet Datasets)')
                                   : t('upl.errPublishShort', 'Publication refusée.'), r2.ok ? 'success' : 'error');
      }
    } else {
      toast(t('upl.errPublish', 'Publication refusée : {reason}', { reason: (r.data?.errors || [r.data?.error]).join(', ') }), 'error');
    }
    return;
  }
  if (action === 'discard') {
    if (!confirm(t('upl.confirmDiscard', 'Supprimer définitivement les fichiers déjà envoyés pour ce dataset ?'))) return;
    await Upload.discard(key);
    toast(t('upl.discarded', 'Import supprimé.'));
  }
}

// ── Render ─────────────────────────────────────────────────────────────────────

function render() {
  const body = el('upl-body');
  if (!body) return;
  const s = Upload.getState();
  const staged = (s.staged || []).filter((d) => !s.datasets.some((x) => x.key === d.key));

  if (_busyScan || s.phase === 'scanning' || s.phase === 'planning') {
    body.innerHTML = `<div class="adm-loading" style="padding:24px">
      <span class="spinner"></span> ${escHtml(s.phase === 'planning'
        ? t('upl.statusPlanning', 'Analyse et vérification…')
        : t('upl.statusScanning', 'Lecture du dossier…'))}</div>`;
    return;
  }

  const sections = [];
  if (s.datasets.length || staged.length) sections.push(renderGlobal(s));
  if (s.datasets.length) sections.push(renderList(t('upl.current', 'Import en cours'), s.datasets));
  if (staged.length) sections.push(renderList(t('upl.pending', 'Imports en attente'), staged.map(serverRow)));
  if (s.rejected.length) sections.push(renderRejected(s.rejected));
  if (!sections.length) sections.push(renderEmpty());

  body.innerHTML = sections.join('');
  refreshIcons(body);
}

function renderEmpty() {
  return `<div class="upl-empty">
    <i data-lucide="inbox"></i>
    <p>${escHtml(t('upl.empty', 'Aucun import en cours. Déposez un dossier pour commencer.'))}</p>
  </div>`;
}

function renderGlobal(s) {
  const pct = s.totalBytes > 0 ? Math.min(100, (s.sentBytes / s.totalBytes) * 100) : 0;
  const working = Upload.isBusy();
  const paused = Upload.isPaused();
  return `
    <section class="upl-global">
      <div class="upl-global-row">
        <div class="upl-global-stat">
          <span class="upl-stat-label">${escHtml(t('upl.progress', 'Progression'))}</span>
          <span class="upl-stat-value">${Math.round(pct)} %</span>
        </div>
        <div class="upl-global-stat">
          <span class="upl-stat-label">${escHtml(t('upl.transferred', 'Transféré'))}</span>
          <span class="upl-stat-value">${escHtml(Upload.formatBytes(s.sentBytes))} <small>/ ${escHtml(Upload.formatBytes(s.totalBytes))}</small></span>
        </div>
        <div class="upl-global-stat">
          <span class="upl-stat-label">${escHtml(t('upl.speed', 'Vitesse'))}</span>
          <span class="upl-stat-value">${escHtml(working ? Upload.formatSpeed(s.speed) : '—')}</span>
        </div>
        <div class="upl-global-stat">
          <span class="upl-stat-label">${escHtml(t('upl.remaining', 'Temps restant'))}</span>
          <span class="upl-stat-value">${escHtml(working ? Upload.formatDuration(s.etaS) : '—')}</span>
        </div>
        <div class="upl-global-actions">
          ${working ? `<button type="button" class="adm-btn adm-btn-ghost" data-upl-action="pause"><i data-lucide="pause"></i> ${escHtml(t('upl.pause', 'Pause'))}</button>` : ''}
          ${paused ? `<button type="button" class="adm-btn adm-btn-accent" data-upl-action="resume"><i data-lucide="play"></i> ${escHtml(t('upl.resume', 'Reprendre'))}</button>` : ''}
          ${(working || paused) ? `<button type="button" class="adm-btn adm-btn-ghost" data-upl-action="cancel"><i data-lucide="x"></i> ${escHtml(t('upl.stop', 'Arrêter'))}</button>` : ''}
        </div>
      </div>
      <div class="upl-progress"><div class="upl-progress-fill" style="width:${pct.toFixed(1)}%"></div></div>
      ${s.error ? `<div class="upl-error"><i data-lucide="alert-triangle"></i> ${escHtml(s.error)}</div>` : ''}
    </section>`;
}

function serverRow(d) {
  return {
    key: d.key, type: d.type, folder: d.folder, name: d.name, state: d.state,
    totalBytes: d.totalBytes, receivedBytes: d.receivedBytes,
    fileCount: d.fileCount, doneCount: d.doneCount, error: null,
    published: d.publishedExists, expiresInS: d.expiresInS, rejected: d.rejected || [],
  };
}

function renderList(title, rows) {
  return `<section class="upl-section">
    <h3 class="upl-section-title">${escHtml(title)}</h3>
    <div class="upl-cards">${rows.map(card).join('')}</div>
  </section>`;
}

function card(d) {
  const pct = d.totalBytes > 0 ? Math.min(100, (d.receivedBytes / d.totalBytes) * 100) : 0;
  const info = stateInfo(d.state);
  const canEdit = d.state === Upload.DS_EDITABLE || d.state === Upload.DS_STAGED;
  const canPublish = d.state === Upload.DS_STAGED;
  return `
    <article class="upl-card${d.error ? ' has-error' : ''}">
      <div class="upl-card-head">
        <div class="upl-card-id">
          <span class="upl-card-name" title="${escHtml(d.key)}">${escHtml(d.name || d.folder)}</span>
          <span class="upl-card-type">${escHtml(d.type)}</span>
        </div>
        <span class="upl-state upl-state-${info.cls}" title="${escHtml(info.hint)}">${escHtml(info.label)}</span>
      </div>
      <div class="upl-progress upl-progress-sm"><div class="upl-progress-fill" style="width:${pct.toFixed(1)}%"></div></div>
      <div class="upl-card-meta">
        <span>${escHtml(Upload.formatBytes(d.receivedBytes))} / ${escHtml(Upload.formatBytes(d.totalBytes))}</span>
        <span>${d.doneCount}/${d.fileCount} ${escHtml(t('upl.files', 'fichiers'))}</span>
        ${d.published ? `<span class="upl-warn">${escHtml(t('upl.alreadyPublished', 'déjà publié'))}</span>` : ''}
        ${d.state === Upload.DS_STALLED && d.expiresInS != null
          ? `<span class="upl-warn">${escHtml(t('upl.expires', 'purge dans {d}', { d: Upload.formatDuration(d.expiresInS) }))}</span>` : ''}
      </div>
      <p class="upl-card-hint">${escHtml(info.hint)}</p>
      ${d.error ? `<div class="upl-card-err"><i data-lucide="alert-triangle"></i> ${escHtml(d.error)}</div>` : ''}
      ${(d.rejected || []).length ? `<details class="upl-card-rejected">
        <summary>${escHtml(t('upl.nRejected', '{n} fichier(s) ignoré(s)', { n: d.rejected.length }))}</summary>
        <ul>${d.rejected.slice(0, 30).map((r) => `<li><code>${escHtml(r.path)}</code> — ${escHtml(rejectReason(r.reason))}</li>`).join('')}</ul>
      </details>` : ''}
      <div class="upl-card-actions">
        ${canEdit ? `<button type="button" class="adm-btn adm-btn-ghost adm-btn-sm" data-upl-action="edit" data-key="${escHtml(d.key)}"><i data-lucide="pencil"></i> ${escHtml(t('upl.edit', 'Éditer'))}</button>` : ''}
        ${canPublish ? `<button type="button" class="adm-btn adm-btn-ghost adm-btn-sm" data-upl-action="validate" data-key="${escHtml(d.key)}"><i data-lucide="shield-check"></i> ${escHtml(t('upl.validate', 'Vérifier'))}</button>` : ''}
        ${canPublish ? `<button type="button" class="adm-btn adm-btn-accent adm-btn-sm" data-upl-action="publish" data-key="${escHtml(d.key)}"><i data-lucide="check-circle"></i> ${escHtml(t('upl.publish', 'Publier'))}</button>` : ''}
        ${d.state !== 'published' ? `<button type="button" class="adm-btn adm-btn-ghost adm-btn-sm upl-btn-danger" data-upl-action="discard" data-key="${escHtml(d.key)}"><i data-lucide="trash-2"></i> ${escHtml(t('upl.discard', 'Supprimer'))}</button>` : ''}
      </div>
    </article>`;
}

function renderRejected(rejected) {
  return `<section class="upl-section">
    <h3 class="upl-section-title">${escHtml(t('upl.rejectedTitle', 'Fichiers ignorés'))}</h3>
    <p class="adm-page-sub">${escHtml(t('upl.rejectedSub', 'Seuls les fichiers produits par le pipeline sont acceptés. Tout le reste est refusé avant le moindre octet écrit.'))}</p>
    <ul class="upl-rejected">
      ${rejected.slice(0, 100).map((r) => `<li><code>${escHtml(r.path)}</code> — ${escHtml(rejectReason(r.reason))}</li>`).join('')}
    </ul>
    ${rejected.length > 100 ? `<p class="adm-page-sub">${escHtml(t('upl.andMore', '… et {n} de plus', { n: rejected.length - 100 }))}</p>` : ''}
  </section>`;
}

function rejectReason(reason) {
  const map = {
    not_allowed: t('upl.rjNotAllowed', 'type de fichier non attendu par la plateforme'),
    unsafe_path: t('upl.rjUnsafe', 'chemin refusé'),
    bad_size: t('upl.rjSize', 'taille invalide'),
    outside_dataset: t('upl.rjOutside', 'hors d\'un dossier de dataset (pas de metadata.json)'),
    invalid_dataset: t('upl.rjDataset', 'nom ou type de dataset invalide'),
  };
  return map[reason] || reason;
}

function stateInfo(state) {
  switch (state) {
    case Upload.DS_UPLOADING:
      return { cls: 'uploading', label: t('upl.stUploading', 'Envoi — non éditable'),
               hint: t('upl.hintUploading', 'Les fichiers indispensables à l\'ouverture ne sont pas encore tous arrivés.') };
    case Upload.DS_EDITABLE:
      return { cls: 'editable', label: t('upl.stEditable', 'Envoi — éditable'),
               hint: t('upl.hintEditable', 'Ouvrable en basse résolution : vous pouvez déjà le renommer, régler les canaux et définir la preview pendant que le reste arrive.') };
    case Upload.DS_STAGED:
      return { cls: 'staged', label: t('upl.stStaged', 'Envoyé — à publier'),
               hint: t('upl.hintStaged', 'Transfert complet et intégrité vérifiée. Publiez-le pour le déplacer vers les datasets publiés.') };
    case Upload.DS_STALLED:
      return { cls: 'stalled', label: t('upl.stStalled', 'Interrompu'),
               hint: t('upl.hintStalled', 'Reglissez le même dossier pour reprendre là où le transfert s\'est arrêté.') };
    case 'published':
      return { cls: 'published', label: t('upl.stPublished', 'Publié'),
               hint: t('upl.hintPublished', 'Déplacé vers les datasets publiés, masqué de l\'explorer public jusqu\'à ce que vous l\'activiez.') };
    default:
      return { cls: 'uploading', label: state || '—', hint: '' };
  }
}

export const UploadTab = {
  id: 'upload',
  titleKey: 'admin.navUpload',
  titleDefault: 'Import',
  mounted: false,
  mount() {
    _host = document.getElementById('upload-root');
    if (!_host) return;
    build();
    if (_unsub) _unsub();
    _unsub = Upload.subscribe(render);
    Upload.refreshStaged();
    render();
  },
  activate() { if (_host) { Upload.refreshStaged(); render(); } },
  relabel() { if (_host) { build(); render(); } },
};
