/**
 * Admin SPA — plugin update mechanics, shared by three tabs
 * =========================================================
 * Updating a plugin is offered from wherever the operator happens to be looking
 * at plugins — Mises à jour, Plugins, Catalogue — so the rules live here once
 * instead of in three copies that would drift.
 *
 * The signed catalog (marketplace_catalog) is the single source: the server
 * already resolves `updateAvailable` (a newer version exists AND it declares
 * compatibility with the installed platform) and `updateBlocked` (newer, but this
 * platform is too old). A caller never re-derives either from version strings.
 */

'use strict';

import { API_ADMIN, t, escHtml, apiFetch, apiFetchStatus, toast } from './shared.js';

let _busy = false;   // module-wide: two tabs must not swap plugin folders at once

export function isBusy() { return _busy; }

/**
 * Catalog fetch, reshaped for merging into any plugin list.
 * Returns { configured, error, byPath: {'<placement>/<id>': entry}, list: [...] }.
 */
export async function fetchPluginUpdates() {
  const data = await apiFetch(`${API_ADMIN}?action=marketplace_catalog`);
  if (!data) return { configured: true, error: 'no_response', byPath: {}, list: [] };
  const list = Array.isArray(data.plugins) ? data.plugins : [];
  const byPath = {};
  for (const p of list) {
    if (p.placement && p.id) byPath[`${p.placement}/${p.id}`] = p;
  }
  return { configured: !!data.configured, error: data.error || null, byPath, list };
}

export function pluginUpdateErrorText(err) {
  const map = {
    bad_password: t('mkt.badPassword', 'Mot de passe incorrect.'),
    not_installed: t('admin.pluginNotInstalled', "Ce plugin n'est plus installé."),
    incompatible: t('admin.pluginUpdateBlocked', 'Nécessite une plateforme plus récente'),
    install_failed: t('admin.pluginUpdateFailed', 'Échec de la mise à jour (vérification échouée).'),
    catalog_fetch_failed: t('mkt.catalogFail', 'Catalogue inaccessible.'),
  };
  return map[err] || `${t('admin.pluginUpdateFailed', 'Échec de la mise à jour.')} (${err})`;
}

/** The `v1.0.0 → v1.1.0` pair, or the blocked badge, for one catalog entry. */
export function updateAffordance(entry, { withButton = true } = {}) {
  if (!entry) return '';
  const from = entry.installedVersion ? `v${entry.installedVersion}` : '?';
  const to = entry.latestVersion ? `v${entry.latestVersion}` : '?';
  const versions = `<span class="adm-pupd-ver">${escHtml(from)} <i data-lucide="arrow-right"></i> <b>${escHtml(to)}</b></span>`;
  if (entry.updateBlocked) {
    return `${versions}<span class="adm-badge adm-badge-warn" title="${escHtml(entry.compatReason || '')}">${escHtml(t('admin.pluginUpdateBlocked', 'Nécessite une plateforme plus récente'))}</span>`;
  }
  if (!entry.updateAvailable) return '';
  return `${versions}${withButton
    ? `<button class="adm-btn adm-btn-accent adm-btn-sm pupd-one" data-id="${escHtml(entry.id)}"><i data-lucide="download"></i> ${escHtml(t('admin.pluginUpdateOne', 'Mettre à jour'))}</button>`
    : ''}`;
}

async function updateOne(id, password) {
  const r = await apiFetchStatus(`${API_ADMIN}?action=update_plugin`, {
    method: 'POST', body: JSON.stringify({ id, password }),
  });
  return { ok: !!(r.ok && r.data?.ok), error: r.data?.error || 'error', version: r.data?.version };
}

/**
 * Update one or several plugins. One password prompt covers the whole batch — the
 * operator authorised the act, not each individual file swap.
 * `onBusy` lets the calling tab repaint while the batch runs.
 * Resolves { done, lastError, cancelled }.
 */
export async function runPluginUpdates(ids, { onBusy } = {}) {
  if (_busy || !ids || !ids.length) return { done: 0, lastError: null, cancelled: true };
  const pw = prompt(t('admin.pluginUpdateConfirm', 'Mettre à jour ce(s) plugin(s) ? Confirmez avec votre mot de passe administrateur :'));
  if (!pw) return { done: 0, lastError: null, cancelled: true };

  _busy = true;
  if (onBusy) onBusy(true);
  toast(t('admin.pluginUpdating', 'Mise à jour des plugins (téléchargement + vérification)…'), 'info');

  let done = 0;
  let lastError = null;
  for (const id of ids) {
    const r = await updateOne(id, pw);
    if (r.ok) done += 1;
    else {
      lastError = r.error;
      if (r.error === 'bad_password') break;   // the rest would fail identically
    }
  }

  _busy = false;
  if (onBusy) onBusy(false);
  if (done) toast(t('admin.pluginUpdated', '{n} plugin(s) mis à jour ✓', { n: done }).replace('{n}', done), 'success');
  if (lastError) toast(pluginUpdateErrorText(lastError), 'error');
  return { done, lastError, cancelled: false };
}
