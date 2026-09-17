/**
 * Admin SPA — Release notes page
 * ==============================
 * admpan.html?changelog=1, opened from the Updates tab in its own browser tab:
 * every version the pending update brings, oldest first — the last one is the
 * version that will be installed — then the notes of every version already
 * installed, newest first. Each version, each section and each entry folds on
 * its own, so a long history stays readable. Same renderer and the same server
 * answers as the Updates tab (update_check + changelog_history).
 */

'use strict';

import { API_ADMIN, t, escHtml, apiFetch, el, refreshIcons } from './shared.js';
import { renderReleaseNotesTree } from './markdown.js';

let _check = null;     // update_check: the versions the update brings
let _history = null;   // changelog_history: what is installed
let _loading = false;

function pendingChangelogs() {
  const list = Array.isArray(_check?.changelogs)
    ? _check.changelogs.filter((c) => c && typeof c.version === 'string' && typeof c.markdown === 'string' && c.markdown.trim())
    : [];
  if (!list.length && typeof _check?.notes === 'string' && _check.notes.trim() && _check.latest && _check.available) {
    return [{ version: _check.latest, markdown: _check.notes }];
  }
  return list;
}

function versionBlock(entry, { pending = false, current = false, target = false, open = false } = {}) {
  const tags = [];
  if (target) tags.push(`<span class="adm-cl-tag adm-cl-tag--target">${escHtml(t('admin.releaseNotesTarget', 'sera installée'))}</span>`);
  else if (pending) tags.push(`<span class="adm-cl-tag adm-cl-tag--pending">${escHtml(t('admin.changelogNew', 'nouvelle'))}</span>`);
  if (current) tags.push(`<span class="adm-cl-tag adm-cl-tag--current">${escHtml(t('admin.changelogCurrent', 'installée'))}</span>`);
  return `<details class="adm-cl-version${pending ? ' is-pending' : ''}"${open ? ' open' : ''}>
      <summary><span class="adm-cl-version-name">v${escHtml(entry.version)}</span>${tags.join('')}</summary>
      <div class="adm-cl-version-body">${renderReleaseNotesTree(entry.markdown)}</div>
    </details>`;
}

function bodyBlock() {
  if (_loading) {
    return `<div class="adm-update-state"><span class="spinner spinner-sm"></span> ${escHtml(t('admin.changelogLoading', 'Chargement des notes de version…'))}</div>`;
  }
  const pending = pendingChangelogs();
  const history = Array.isArray(_history?.versions)
    ? _history.versions.filter((c) => c && typeof c.version === 'string' && typeof c.markdown === 'string')
    : [];
  if (!pending.length && !history.length) {
    return `<div class="adm-update-state adm-warn"><i data-lucide="wifi-off"></i> ${escHtml(t('admin.changelogLoadError', 'Notes de version indisponibles.'))}</div>`;
  }
  const current = _history?.current || _check?.current || null;
  const target = pending.length ? pending[pending.length - 1].version : null;
  const pendingHtml = pending.length
    ? pending.map((e) => versionBlock(e, { pending: true, target: e.version === target, open: true })).join('')
    : `<div class="adm-update-state adm-ok"><i data-lucide="check-circle-2"></i> ${escHtml(t('admin.changelogNoPending', 'Rien à installer : vous êtes à jour.'))}${current ? ` <span class="adm-muted">(v${escHtml(current)})</span>` : ''}</div>`;
  const historyHtml = history.length
    ? `<div class="adm-cl-group-head">${escHtml(t('admin.changelogInstalled', 'Versions installées'))}</div>`
      + history.map((e) => versionBlock(e, { current: e.version === current })).join('')
    : '';
  return `<div class="adm-cl-group-head">${escHtml(t('admin.changelogPending', 'Nouveau dans cette mise à jour'))}</div>${pendingHtml}${historyHtml}`;
}

function render() {
  const root = el('changelog-root');
  if (!root) return;
  root.innerHTML = `
    <div class="adm-page-head">
      <div>
        <h2 class="adm-page-title">${escHtml(t('admin.changelogTitle', 'Notes de version'))}</h2>
        <p class="adm-page-sub">${escHtml(t('admin.changelogSub', "Chaque version entre celle installée et la dernière, puis l'historique installé."))}</p>
      </div>
      <div class="adm-cl-toolbar">
        <button type="button" class="adm-btn adm-btn-ghost adm-btn-sm" id="btn-cl-expand"><i data-lucide="chevrons-up-down"></i> ${escHtml(t('admin.changelogExpandAll', 'Tout déplier'))}</button>
        <button type="button" class="adm-btn adm-btn-ghost adm-btn-sm" id="btn-cl-collapse"><i data-lucide="chevrons-down-up"></i> ${escHtml(t('admin.changelogCollapseAll', 'Tout replier'))}</button>
      </div>
    </div>
    <div id="changelog-body">${bodyBlock()}</div>`;
  el('btn-cl-expand')?.addEventListener('click', () => setAll(true));
  el('btn-cl-collapse')?.addEventListener('click', () => setAll(false));
  refreshIcons(root);
}

function setAll(open) {
  el('changelog-body')?.querySelectorAll('details').forEach((d) => { d.open = open; });
}

async function load() {
  _loading = true;
  render();
  const [check, history] = await Promise.all([
    apiFetch(`${API_ADMIN}?action=update_check`),
    apiFetch(`${API_ADMIN}?action=changelog_history`),
  ]);
  _check = check || null;
  _history = history || null;
  _loading = false;
  render();
}

export const ChangelogTab = {
  id: 'changelog',
  titleKey: 'admin.changelogTitle',
  titleDefault: 'Notes de version',
  mounted: false,
  mount() { load(); },
  activate() {},
  relabel() { render(); },
};
