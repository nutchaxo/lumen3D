/**
 * Admin SPA — dataset trash
 * =========================
 * The Delete button of the Datasets tab never erases anything: the server moves the
 * dataset's folder to uploads/trash/ (dataset_trash.py / api/_trash_lib.php) and
 * reclaims it 60 days later. Every deletion is its own trash entry, so the same
 * name can go to the trash any number of times (delete, re-upload, delete again…).
 * This module owns the confirmation, the API calls and the trash dialog.
 */

'use strict';

import { API_DATASETS, t, escHtml, apiFetchStatus, toast, refreshIcons } from './shared.js';

const post = (action, query, body) => apiFetchStatus(
  `${API_DATASETS}?action=${action}${query || ''}`,
  { method: 'POST', body: JSON.stringify(body || {}) });

let _retentionDays = 60;
let _dialog = null;
let _onChange = () => {};

function fmtBytes(n) {
  if (!Number.isFinite(n) || n < 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

function fmtDate(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString();
}

export async function fetchTrash() {
  const res = await apiFetchStatus(`${API_DATASETS}?action=trash_list`);
  if (!res.ok || !Array.isArray(res.data?.entries)) return null;
  if (Number.isFinite(res.data.retentionDays)) _retentionDays = res.data.retentionDays;
  return res.data.entries;
}

/** Ask, then move one published dataset to the trash. Resolves true when it went. */
export async function moveToTrash(ds) {
  const name = ds.name || ds.folderName || ds.id;
  const msg = t('admin.confirmDeleteDataset',
    `Supprimer « ${name} » ?\n\nIl est déplacé dans la corbeille et supprimé définitivement après ${_retentionDays} jours. Vous pouvez le restaurer d'ici là.`,
    { name, days: _retentionDays });
  if (!confirm(msg)) return false;
  const res = await post('delete', `&id=${encodeURIComponent(ds.id)}`);
  if (res.ok && res.data?.ok) {
    toast(t('admin.datasetDeleted', 'Dataset déplacé dans la corbeille ✓'));
    return true;
  }
  const code = res.data?.error;
  const reason = code === 'busy'
    ? t('admin.deleteBusy', 'le dossier est utilisé par un autre processus (conversion en cours ?)')
    : code === 'use_import_discard'
      ? t('admin.deleteUseImport', 'un import en cours se supprime depuis l\'onglet Import')
      : (code || t('admin.unknownError', 'Inconnue'));
  toast(t('admin.datasetDeleteError', `Suppression impossible : ${reason}`, { reason }), 'error');
  return false;
}

// ── Dialog ─────────────────────────────────────────────────────

function ensureDialog() {
  if (_dialog) return _dialog;
  _dialog = document.createElement('dialog');
  _dialog.className = 'adm-trash-dialog';
  _dialog.setAttribute('aria-labelledby', 'adm-trash-title');
  _dialog.addEventListener('click', (e) => {
    if (e.target === _dialog) _dialog.close();          // backdrop
    const btn = e.target.closest('[data-trash-act]');
    if (btn) onAction(btn);
  });
  document.body.appendChild(_dialog);
  return _dialog;
}

function row(e) {
  const days = Number.isFinite(e.daysLeft) ? e.daysLeft : _retentionDays;
  const left = t('admin.trashDaysLeft', `${days} j restants`, { days });
  const meta = [e.id, fmtBytes(e.bytes)].filter(Boolean).join(' · ');
  return `
    <li class="adm-trash-row${days <= 7 ? ' is-soon' : ''}" data-trash-id="${escHtml(e.trashId)}">
      <div class="adm-trash-info">
        <div class="adm-trash-name">${escHtml(e.name || e.folder)}</div>
        <div class="adm-trash-meta">${escHtml(meta)}</div>
        <div class="adm-trash-meta">${escHtml(t('admin.trashDeletedOn', `Supprimé le ${fmtDate(e.deletedAt)}`, { date: fmtDate(e.deletedAt) }))} · <span class="adm-trash-left">${escHtml(left)}</span></div>
      </div>
      <button type="button" class="adm-btn adm-btn-ghost adm-btn-sm" data-trash-act="restore">${escHtml(t('admin.trashRestore', 'Restaurer'))}</button>
      <button type="button" class="adm-btn adm-btn-ghost adm-btn-sm adm-trash-danger" data-trash-act="purge" title="${escHtml(t('admin.trashPurgeTitle', 'Supprimer définitivement'))}"><i data-lucide="trash-2"></i></button>
    </li>`;
}

async function render() {
  const dlg = ensureDialog();
  const entries = await fetchTrash();
  const body = entries === null
    ? `<p class="adm-trash-empty">${escHtml(t('admin.trashLoadFailed', 'Impossible de charger la corbeille.'))}</p>`
    : entries.length
      ? `<ul class="adm-trash-list">${entries.map(row).join('')}</ul>`
      : `<p class="adm-trash-empty">${escHtml(t('admin.trashEmpty', 'La corbeille est vide.'))}</p>`;
  dlg.innerHTML = `
    <div class="adm-trash-head">
      <h2 id="adm-trash-title">${escHtml(t('admin.trash', 'Corbeille'))}</h2>
      <button type="button" class="adm-btn adm-btn-ghost adm-btn-sm" data-trash-act="close" aria-label="${escHtml(t('admin.close', 'Fermer'))}">✕</button>
    </div>
    <p class="adm-trash-intro">${escHtml(t('admin.trashIntro', `Les datasets supprimés sont conservés ${_retentionDays} jours puis effacés définitivement. Un même nom peut apparaître plusieurs fois : chaque suppression est conservée séparément.`, { days: _retentionDays }))}</p>
    <div class="adm-trash-body">${body}</div>
    <div class="adm-trash-foot">
      <button type="button" class="adm-btn adm-btn-ghost adm-btn-sm adm-trash-danger" data-trash-act="empty"${entries && entries.length ? '' : ' disabled'}>${escHtml(t('admin.trashEmptyAll', 'Vider la corbeille'))}</button>
      <button type="button" class="adm-btn adm-btn-accent adm-btn-sm" data-trash-act="close">${escHtml(t('admin.close', 'Fermer'))}</button>
    </div>`;
  refreshIcons(dlg);
  return entries;
}

async function onAction(btn) {
  const act = btn.dataset.trashAct;
  if (act === 'close') { _dialog.close(); return; }
  const li = btn.closest('[data-trash-id]');
  const trashId = li?.dataset.trashId;
  btn.disabled = true;

  if (act === 'restore') {
    let res = await post('trash_restore', '', { trashId });
    if (res.status === 409 && res.data?.error === 'exists') {
      const folder = res.data.folder, suggested = res.data.suggested;
      const q = t('admin.trashRestoreExists',
        `Un dataset « ${folder} » existe déjà (il a peut-être été réimporté). Restaurer celui de la corbeille sous le nom « ${suggested} » ?`,
        { folder, suggested });
      if (!confirm(q)) { btn.disabled = false; return; }
      res = await post('trash_restore', '', { trashId, folder: suggested });
    }
    if (res.ok && res.data?.ok) {
      toast(t('admin.trashRestored', `Restauré : ${res.data.id} ✓`, { id: res.data.id }));
      _onChange();
      await render();
    } else {
      const reason = res.data?.error || t('admin.unknownError', 'Inconnue');
      toast(t('admin.trashRestoreError', `Restauration impossible : ${reason}`, { reason }), 'error');
      btn.disabled = false;
    }
    return;
  }

  if (act === 'purge') {
    const name = li?.querySelector('.adm-trash-name')?.textContent || '';
    if (!confirm(t('admin.trashConfirmPurge',
      `Supprimer définitivement « ${name} » ? Cette action est irréversible.`, { name }))) {
      btn.disabled = false; return;
    }
    const res = await post('trash_purge', '', { trashId });
    if (res.ok && res.data?.ok) { _onChange(); await render(); }
    else { toast(t('admin.trashPurgeError', 'Suppression définitive impossible.'), 'error'); btn.disabled = false; }
    return;
  }

  if (act === 'empty') {
    if (!confirm(t('admin.trashConfirmEmpty',
      'Vider la corbeille ? Tous les datasets qu\'elle contient seront supprimés définitivement.'))) {
      btn.disabled = false; return;
    }
    const res = await post('trash_empty');
    if (res.ok && res.data?.ok) { _onChange(); await render(); }
    else { toast(t('admin.trashPurgeError', 'Suppression définitive impossible.'), 'error'); btn.disabled = false; }
  }
}

/** Open the trash dialog; `onChange` runs after a restore (the list must reload). */
export async function openTrash({ onChange } = {}) {
  _onChange = onChange || (() => {});
  const dlg = ensureDialog();
  await render();
  if (!dlg.open) dlg.showModal();
}
