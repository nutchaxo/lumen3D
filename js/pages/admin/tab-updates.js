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
 *
 * It also carries plugin updates, because "what needs updating here?" is one
 * question, not two: the signed catalog (same source as the Catalog tab) is
 * compared against what is installed, and only plugins that are both newer AND
 * compatible with the platform in place can be updated from here.
 */

'use strict';

import { API_ADMIN, Utils, t, escHtml, apiFetch, apiFetchStatus, toast, el, refreshIcons } from './shared.js';
import { fetchPluginUpdates, runPluginUpdates, updateAffordance } from './plugin-update.js';
import { renderReleaseNotesTree } from './markdown.js';
import { describeStaleCode } from './stale-code.js';

let _versions = null;
let _check = null;
let _preflight = null;   // report shown between "Mettre à jour" and confirmation
let _notesOpen = false;  // release-note entries unfolded (titles only when false; survives re-renders)
let _notesVersion = null; // the version whose notes are shown — one pill per version the update brings
let _polling = false;
// From the confirmed apply until the update ends without a reload. Not `_polling`:
// that flag is down during the restart probe and the whole synchronous PHP apply.
// While it is set, a re-render (language switch, mount) keeps the progress card
// visible and offers no control that would start a second apply.
let _updating = false;
// Last progress painted, repainted after a re-render. `msg` is a string or a
// function returning one, so a language switch re-translates the line.
let _progress = { pct: 0, msg: '', phase: null };
let _sawPivot = false;      // the pipeline reported 'pivoting': the server is about to exit
let _targetVersion = '';      // version this run installs
let _startVersion = '';       // version running when the run began
const _bareVersion = (v) => String(v == null ? '' : v).trim().replace(/^v/i, '');
let _plugins = null;     // marketplace catalog annotated with installed/update status
let _pluginsBusy = false;
let _pipeline = null;    // downloadable processing pack: what is here vs what is published

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

// The line under the progress bar, per server phase. The server's own `message` is a
// log line in one language: the operator reads this translated one instead.
const PROGRESS_LINES = {
  starting: ['admin.updateMsgStarting', 'Préparation…'],
  preflight: ['admin.updateMsgPreflight', 'Vérifications préalables…'],
  backup: ['admin.updateMsgBackup', "Sauvegarde de l'installation…"],
  download: ['admin.updateMsgDownload', 'Téléchargement de la mise à jour…'],
  verify: ['admin.updateMsgVerify', "Vérification de l'authenticité…"],
  staging: ['admin.updateMsgStaging', 'Préparation de la nouvelle version…'],
  verifying: ['admin.updateMsgVerifying', 'Contrôle de démarrage de la nouvelle version…'],
  planning: ['admin.updateMsgPlanning', 'Préparation du basculement…'],
  pivoting: ['admin.updateMsgPivoting', 'Basculement vers la nouvelle version…'],
  error: ['admin.updateMsgError', 'Échec de la mise à jour — installation intacte.'],
};

function progressLine(s) {
  const phase = s && s.phase;
  const done = Number(s && s.done), total = Number(s && s.total);
  if (phase === 'download' && Number.isFinite(done) && Number.isFinite(total) && total > 0) {
    const size = (n) => (Utils && typeof Utils.formatFileSize === 'function') ? Utils.formatFileSize(n) : `${Math.round(n)}`;
    const vars = { done: size(done), total: size(total) };
    return t('admin.updateMsgDownloadBytes', 'Téléchargement… {done} / {total}', vars)
      .replace('{done}', vars.done).replace('{total}', vars.total);
  }
  const line = PROGRESS_LINES[phase];
  if (line) return t(line[0], line[1]);
  const chip = PHASES.find((p) => p[0] === phase);
  return chip ? t(chip[1], chip[2]) : '';
}

// Only versions that exist are shown: a chip reading "—" invites the operator to
// hunt for a number that was never going to be there.
function versionChip(labelKey, labelDef, value) {
  if (!value) return '';
  return `<div class="adm-vchip">
      <span class="adm-vchip-label">${escHtml(t(labelKey, labelDef))}</span>
      <span class="adm-vchip-value">${escHtml(value)}</span>
    </div>`;
}

function updateBlock() {
  if (!_check) return `<div class="adm-update-state adm-checking"><span class="spinner spinner-sm"></span> ${escHtml(t('admin.checking', 'Recherche de mises à jour…'))}</div>`;
  if (_check.error === 'rate_limited') {
    const msg = _check.retryAfterMin
      ? t('admin.rateLimited', "Limite de l'API GitHub atteinte. Réessayez dans {m} minute(s).", { m: _check.retryAfterMin })
      : t('admin.rateLimitedNoMin', "Limite de l'API GitHub atteinte. Réessayez dans quelques minutes.");
    return `<div class="adm-update-state adm-warn"><i data-lucide="hourglass"></i> ${escHtml(msg)}</div>`;
  }
  if (_check.error === 'tls_ca_broken') {
    return `<div class="adm-update-state adm-warn"><i data-lucide="shield-off"></i> ${escHtml(t('admin.tlsCaBroken', 'Le magasin de certificats de PHP est inutilisable sur cet hébergement : téléversez cacert.pem (https://curl.se/ca/cacert.pem) à la racine du site.'))} <span class="adm-muted">${escHtml(_check.detail || '')}</span></div>`;
  }
  if (_check.error) return `<div class="adm-update-state adm-warn"><i data-lucide="wifi-off"></i> ${escHtml(t('admin.checkError', 'Impossible de contacter GitHub.'))} <span class="adm-muted">${escHtml(_check.detail || _check.error)}</span></div>`;
  if (_check.noReleases) return `<div class="adm-update-state adm-ok"><i data-lucide="check-circle-2"></i> ${escHtml(t('admin.noReleases', 'Aucune release publiée sur GitHub pour le moment.'))}</div>`;
  if (!_check.available) return `<div class="adm-update-state adm-ok"><i data-lucide="check-circle-2"></i> ${escHtml(t('admin.upToDate', 'Vous êtes à jour.'))} <span class="adm-muted">(${escHtml(_check.latest || _check.current)})</span></div>`;

  // The release offers no archive the updater may apply (none named after the tag,
  // or no SHA256SUMS listing it): say so instead of a button that can only fail.
  if (_check.assetError) {
    return `
    <div class="adm-update-state adm-avail"><i data-lucide="sparkles"></i> ${escHtml(t('admin.updateAvailable', 'Mise à jour disponible'))} : <b>v${escHtml(_check.latest)}</b></div>
    ${notesBlock()}
    <div class="adm-update-state adm-warn"><i data-lucide="shield-alert"></i> ${escHtml(unverifiableMessage(_check.assetError))}</div>`;
  }

  return `
    <div class="adm-update-state adm-avail"><i data-lucide="sparkles"></i> ${escHtml(t('admin.updateAvailable', 'Mise à jour disponible'))} : <b>v${escHtml(_check.latest)}</b></div>
    ${notesBlock()}
    ${_updating ? '' : _preflight ? preflightBlock() : `
    <div class="adm-update-actions">
      <button class="adm-btn adm-btn-accent" id="btn-update"><i data-lucide="download-cloud"></i> ${escHtml(t('admin.updateNow', 'Mettre à jour maintenant'))}</button>
      ${_check.htmlUrl ? `<a class="adm-btn adm-btn-ghost" href="${escHtml(_check.htmlUrl)}" target="_blank" rel="noopener"><i data-lucide="external-link"></i> GitHub</a>` : ''}
    </div>
    <div class="adm-update-warn"><i data-lucide="shield"></i> ${escHtml(t('admin.updateWarn', 'Une sauvegarde est créée avant la mise à jour. Vos données (DATA_WEB), identifiants et statistiques sont préservés. Le serveur redémarre à la fin.'))}</div>`}`;
}

// A release the updater refuses to apply, with the server's reason (no_release_asset,
// asset_name_mismatch, ambiguous_asset, no_checksums, zip_not_in_sums).
function unverifiableMessage(reason) {
  const base = t('admin.updateUnverifiable', "Cette version ne peut pas être vérifiée (aucune empreinte pour son archive) et n'a pas été appliquée.");
  return reason ? `${base} (${reason})` : base;
}

// Failure codes of the updater (both backends) → a sentence. The servers keep the
// technical detail (it may name files of the host) in their log; a code with no
// sentence, or a text an older server wrote, is shown as it is.
function updateErrorText(code) {
  if (!code) return '';
  return t(`admin.updateErr_${code}`, '') || String(code);
}

// "· publiée le 11 sept. 2026" beside the notes heading, when GitHub dates the release.
function publishedOn(iso) {
  if (!iso) return '';
  const date = Utils && typeof Utils.formatDate === 'function' ? Utils.formatDate(iso) : String(iso).slice(0, 10);
  return ` <span class="adm-release-notes-date">${escHtml(t('admin.publishedOn', 'publiée le {d}', { d: date }).replace('{d}', date))}</span>`;
}

/**
 * The notes of every version the update brings, oldest first — the last one is
 * the version that will be installed. A host that skipped releases reads each of
 * them, not just the newest body. A server older than the notes asset answers
 * with the body alone; it is shown as the latest version.
 */
function pendingChangelogs() {
  const list = Array.isArray(_check?.changelogs)
    ? _check.changelogs.filter((c) => c && typeof c.version === 'string' && typeof c.markdown === 'string' && c.markdown.trim())
    : [];
  if (!list.length && typeof _check?.notes === 'string' && _check.notes.trim() && _check.latest) {
    return [{ version: _check.latest, markdown: _check.notes }];
  }
  return list;
}

function notesBlock() {
  const list = pendingChangelogs();
  if (!list.length) return '';
  const target = list[list.length - 1].version;
  if (!list.some((c) => c.version === _notesVersion)) _notesVersion = target;
  const shown = list.find((c) => c.version === _notesVersion);
  const pills = list.length > 1 ? `<div class="adm-vpills" id="notes-versions">${list.map((c) =>
    `<button type="button" class="adm-vpill${c.version === _notesVersion ? ' is-active' : ''}" data-version="${escHtml(c.version)}">v${escHtml(c.version)}${
      c.version === target ? `<span class="adm-vpill-tag">${escHtml(t('admin.releaseNotesTarget', 'sera installée'))}</span>` : ''}</button>`).join('')}</div>` : '';
  const sub = list.length > 1
    ? ` <span class="adm-release-notes-date">${escHtml(t('admin.releaseNotesCount', '{n} nouvelles versions', { n: list.length }).replace('{n}', String(list.length)))}</span>`
    : publishedOn(_check.publishedAt);
  return `
    <div class="adm-release-notes-head">${escHtml(t('admin.releaseNotes', 'Notes de version'))}${sub}</div>
    ${pills}
    <div class="adm-release-notes" id="release-notes">${renderReleaseNotesTree(shown.markdown, { itemsOpen: _notesOpen })}</div>
    <div class="adm-release-notes-actions">
      <button type="button" class="adm-btn adm-btn-ghost adm-btn-sm" id="btn-notes-toggle">${notesToggleLabel()}</button>
      <a class="adm-btn adm-btn-ghost adm-btn-sm" href="admpan.html?changelog=1" target="_blank" rel="noopener"><i data-lucide="external-link"></i> ${escHtml(t('admin.releaseNotesOpenPage', 'Ouvrir dans une page'))}</a>
    </div>`;
}

function notesToggleLabel() {
  return _notesOpen
    ? `<i data-lucide="chevron-up"></i> ${escHtml(t('admin.releaseNotesLess', 'Titres seulement'))}`
    : `<i data-lucide="chevron-down"></i> ${escHtml(t('admin.releaseNotesMore', 'Afficher les détails'))}`;
}

// Titles only ⇄ every entry unfolded. The box scrolls in both states.
function toggleNotes() {
  _notesOpen = !_notesOpen;
  el('release-notes')?.querySelectorAll('details.adm-cl-item').forEach((d) => { d.open = _notesOpen; });
  const btn = el('btn-notes-toggle');
  if (btn) { btn.innerHTML = notesToggleLabel(); refreshIcons(btn); }
}

function bindUpdateBody(root) {
  root.querySelector('#btn-update')?.addEventListener('click', startPreflight);
  root.querySelector('#btn-confirm-update')?.addEventListener('click', confirmUpdate);
  root.querySelector('#btn-cancel-update')?.addEventListener('click', () => { _preflight = null; render(); });
  root.querySelector('#btn-notes-toggle')?.addEventListener('click', toggleNotes);
  root.querySelectorAll('#notes-versions .adm-vpill').forEach((b) => b.addEventListener('click', () => {
    _notesVersion = b.getAttribute('data-version');
    renderUpdateBody();
  }));
}

function renderUpdateBody() {
  const body = el('update-body');
  if (!body) return;
  body.innerHTML = updateBlock();
  bindUpdateBody(body);
  refreshIcons(body);
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

// ── Plugin updates ────────────────────────────────────────────────────────────
// The server (marketplace_catalog) already resolves both halves of the question:
// updateAvailable = a newer version exists AND it declares compatibility with the
// installed platform; updateBlocked = newer, but this platform is too old for it.

function pluginRow(p) {
  return `<div class="adm-pupd-row">
      <i data-lucide="${escHtml(p.icon || 'puzzle')}"></i>
      <span class="adm-pupd-name">${escHtml(p.name || p.id)}</span>
      ${updateAffordance(p)}
    </div>`;
}

function pluginUpdatesBlock() {
  if (_pluginsBusy) {
    return `<div class="adm-update-state adm-checking"><span class="spinner spinner-sm"></span> ${escHtml(t('admin.pluginUpdating', 'Mise à jour des plugins (téléchargement + vérification)…'))}</div>`;
  }
  if (!_plugins) {
    return `<div class="adm-update-state adm-checking"><span class="spinner spinner-sm"></span> ${escHtml(t('admin.pluginUpdatesChecking', 'Recherche de mises à jour de plugins…'))}</div>`;
  }
  if (!_plugins.configured) {
    return `<div class="adm-update-state adm-warn"><i data-lucide="plug"></i> ${escHtml(t('admin.pluginUpdatesNoCatalog', 'Aucune source de catalogue configurée : les plugins ne peuvent pas être mis à jour depuis ici.'))}</div>`;
  }
  if (_plugins.error) {
    return `<div class="adm-update-state adm-warn"><i data-lucide="wifi-off"></i> ${escHtml(t('admin.pluginUpdatesError', 'Catalogue de plugins injoignable.'))} <span class="adm-muted">${escHtml(_plugins.error)}</span></div>`;
  }
  const list = Array.isArray(_plugins.plugins) ? _plugins.plugins : [];
  const ready = list.filter((p) => p.updateAvailable);
  const blocked = list.filter((p) => p.updateBlocked);
  if (!ready.length && !blocked.length) {
    return `<div class="adm-update-state adm-ok"><i data-lucide="check-circle-2"></i> ${escHtml(t('admin.pluginUpdatesNone', 'Tous les plugins installés sont à jour.'))}</div>`;
  }
  return `
    ${ready.length ? `<div class="adm-update-state adm-avail"><i data-lucide="sparkles"></i> ${escHtml(t('admin.pluginUpdatesFound', '{n} plugin(s) à mettre à jour', { n: ready.length }).replace('{n}', ready.length))}</div>` : ''}
    <div class="adm-pupd-list">${ready.map(pluginRow).join('')}</div>
    ${ready.length > 1 ? `<div class="adm-update-actions">
        <button class="adm-btn adm-btn-accent" id="btn-pupd-all"><i data-lucide="download-cloud"></i> ${escHtml(t('admin.pluginUpdateAll', 'Tout mettre à jour'))}</button>
      </div>` : ''}
    ${blocked.length ? `
      <div class="adm-release-notes-head" style="margin-top:14px">${escHtml(t('admin.pluginUpdatesBlockedHead', 'Mises à jour qui attendent la plateforme'))}</div>
      <div class="adm-pupd-list">${blocked.map(pluginRow).join('')}</div>
      <div class="adm-muted" style="margin-top:6px">${escHtml(t('admin.pluginUpdatesBlockedNote', 'Ces versions demandent une plateforme plus récente : mettez à jour la plateforme ci-dessus, puis revenez ici.'))}</div>` : ''}`;
}

/** Repaints ONLY this card. A full render() would rebuild the progress card too,
 *  hiding a platform update that is still running. */
function renderPluginUpdates() {
  const body = el('plugin-updates-body');
  if (!body) return;
  body.innerHTML = pluginUpdatesBlock();
  bindPluginUpdates(body);
  refreshIcons(body);
}

function bindPluginUpdates(scope) {
  scope.querySelector('#btn-pupd-all')?.addEventListener('click', () => startUpdates(
    (_plugins?.plugins || []).filter((p) => p.updateAvailable).map((p) => p.id)));
  scope.querySelectorAll('.pupd-one').forEach((b) =>
    b.addEventListener('click', () => startUpdates([b.getAttribute('data-id')])));
}

async function loadPluginUpdates() {
  _plugins = null;
  renderPluginUpdates();
  // Same signed catalog as the Plugins and Catalogue tabs — one source, so the
  // three can never disagree about what version a plugin is at.
  const r = await fetchPluginUpdates();
  _plugins = { configured: r.configured, error: r.error, plugins: r.list };
  renderPluginUpdates();
}

async function startUpdates(ids) {
  const r = await runPluginUpdates(ids, {
    onBusy: (b) => { _pluginsBusy = b; renderPluginUpdates(); },
  });
  if (!r.cancelled) await loadPluginUpdates();
}

// Persisted outcome of the previous run (survives the restart), if any.
function lastOutcomeBlock(last) {
  if (!last) return '';
  const done = last.phase === 'done';
  const cls = done ? 'adm-ok' : 'adm-warn';
  const icon = done ? 'check-circle-2' : 'undo-2';
  const text = done
    ? `${t('admin.updateSucceeded', 'Mise à jour terminée avec succès. Le serveur a redémarré — reconnectez-vous.')} (v${last.target || '?'})`
    : `${t('admin.updateRolledBack', "La nouvelle version n'a pas démarré — restauration automatique effectuée. L'ancienne version fonctionne.")}${last.error && last.error !== 'health_probe_failed' ? ` — ${updateErrorText(last.error)}` : ''}`;
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

/**
 * The processing pack's own update state.
 *
 * The pack is not part of the platform: it runs on the operator's Windows station
 * and carries the preprocessing tool's version, which moves on its own cadence. So
 * a new pack can be published with no platform release behind it, and updating it
 * means downloading it again on that station — nothing happens on this server.
 */
function pipelinePackBlock() {
  if (_pipeline === null) {
    return `<div class="adm-update-state"><span class="spinner spinner-sm"></span> ${escHtml(t('admin.pipelineChecking', 'Vérification…'))}</div>`;
  }
  const upd = _pipeline.update || {};
  const local = (_pipeline.leger && _pipeline.leger.version) || (_pipeline.versions || {}).preprocess;

  if (upd.reason === 'unreachable') {
    return `<div class="adm-update-state"><i data-lucide="cloud-off"></i> ${escHtml(t('admin.pipelinePackUnreachable', 'Impossible de joindre GitHub pour vérifier le pack de traitement.'))}</div>`;
  }
  if (!upd.available) {
    return `<div class="adm-update-state adm-ok"><i data-lucide="check-circle-2"></i> ${escHtml(t('admin.pipelinePackUpToDate', 'Le pack de traitement est à jour.'))} <span class="adm-muted">(v${escHtml(local || '—')})</span></div>`;
  }

  const asset = (_pipeline.leger && _pipeline.leger.newer) || (_pipeline.complet && _pipeline.complet.newer);
  const link = asset && asset.url
    ? `<a class="adm-btn adm-btn-accent adm-btn-sm" href="${escHtml(asset.url)}" target="_blank" rel="noopener">
         <i data-lucide="download-cloud"></i> ${escHtml(t('admin.pipelinePackGet', 'Télécharger le pack'))}</a>`
    : '';
  return `
    <div class="adm-update-state adm-avail"><i data-lucide="sparkles"></i> ${escHtml(t('admin.pipelinePackAvailable', 'Nouveau pack de traitement'))} : <b>v${escHtml(upd.remote)}</b> <span class="adm-muted">(${escHtml(t('admin.pipelinePackInstalled', 'ici : v{v}', { v: upd.local || local || '—' }))})</span></div>
    <p class="adm-muted" style="margin:8px 0 12px">${escHtml(t('admin.pipelinePackHint', "Il s'installe sur le poste de traitement, pas sur ce serveur : téléchargez-le et remplacez le dossier utilisé là-bas."))}</p>
    ${link}`;
}

/** Fill `{name}` tokens whether or not the translator did it. */
function fill(text, vars) {
  let out = String(text);
  for (const [k, v] of Object.entries(vars)) out = out.split('{' + k + '}').join(String(v));
  return out;
}

let _repair = { busy: false, result: null };

/** The late files PHP could not write and the account PHP runs as. The fix itself is the
 *  banner's "Try to fix automatically" button. */
function staleRepairBlock(s) {
  const yn = (b) => (b === true ? t('admin.staleCodeYes', 'yes') : b === false ? t('admin.staleCodeNo', 'no') : '?');
  const rows = s.outdated.slice(0, 12).map((o) => {
    const owner = o.owner ? `${o.owner}${o.group ? ':' + o.group : ''}` : '?';
    // The updater replaces a file by renaming it aside, so a writable directory is enough:
    // `replaceable` is the answer the operator needs; an older probe only knows `writable`.
    const hasReplaceable = typeof o.replaceable === 'boolean';
    const w = yn(hasReplaceable ? o.replaceable : (o.exists === false ? o.dirWritable === true : o.writable === true));
    const wText = hasReplaceable
      ? fill(t('admin.staleCodeReplaceable', 'PHP can replace: {w}', { w }), { w })
      : fill(t('admin.staleCodeWritable', 'writable by PHP: {w}', { w }), { w });
    return `<li><code>${escHtml(o.path)}</code> <span class="adm-muted">— ${escHtml(o.perms || '?')}, ${escHtml(owner)}, ${escHtml(wText)}</span></li>`;
  }).join('');
  const user = s.phpUser
    ? `<p class="adm-muted" style="margin:0 0 8px;font-size:.85em">${escHtml(fill(t('admin.staleCodePhpUser', 'PHP runs as {user}.', { user: s.phpUser }), { user: s.phpUser }))}</p>` : '';
  return `
        ${rows ? `<ul style="margin:0 0 8px;padding-left:18px">${rows}</ul>` : ''}
        ${user}`;
}

const STALE_FIX_IDS = ['finish_parked', 'invalidate', 'touch', 'repair_permissions', 'opcache_reset'];

/** The steps the server reports it ran, reduced to what the card prints. */
function cleanFixActions(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const a of list) {
    if (!a || typeof a !== 'object' || !STALE_FIX_IDS.includes(a.id) || a.ran !== true) continue;
    out.push({
      id: a.id, ok: a.ok === true,
      count: Math.max(0, Number(a.count) || 0), failed: Math.max(0, Number(a.failed) || 0),
      detail: Array.isArray(a.detail) ? a.detail.filter((x) => typeof x === 'string').slice(0, 20) : [],
    });
  }
  return out;
}

/** One translated line for a step that ran. */
function staleFixLine(a) {
  const v = { count: a.count, failed: a.failed };
  const f = (key, def) => fill(t(key, def, v), v);
  switch (a.id) {
    case 'finish_parked':
      return a.failed > 0 ? f('admin.staleFixParkedLeft', 'Parked files put in place: {count}, still parked: {failed}')
        : f('admin.staleFixParked', 'Parked files put in place: {count}');
    case 'invalidate':
      if (a.ok) return f('admin.staleFixInvalidated', 'Opcache: cleared {count} files');
      return (Array.isArray(a.detail) && a.detail.includes('blocked')) ? f('admin.staleFixInvalidateBlocked', 'Opcache: the host blocks clearing it')
        : f('admin.staleFixInvalidateNone', 'Opcache: nothing to clear');
    case 'touch':
      return f('admin.staleFixTouched', 'File dates refreshed: {count} (failed: {failed})');
    case 'repair_permissions':
      return f('admin.staleFixPerms', 'Permissions repaired: {count} fixed, {failed} failed');
    case 'opcache_reset':
      return a.ok ? f('admin.staleFixReset', 'Opcache: reset') : f('admin.staleFixResetFailed', 'Opcache: the reset was refused');
    default:
      return '';
  }
}

/** What the last automatic fix did, inside the card. */
function staleRepairResult() {
  const r = _repair.result;
  if (!r) return '';
  const out = [];
  const lines = (r.actions || []).map(staleFixLine).filter(Boolean);
  if (r.reinstalled) {
    const vars = { version: r.reinstalled };
    lines.push(fill(t('admin.staleFixReinstalled', 'Version {version} reinstalled', vars), vars));
  }
  if (lines.length) {
    out.push(`<ul style="margin:0 0 8px;padding-left:18px">${lines.map((l) => `<li>${escHtml(l)}</li>`).join('')}</ul>`);
  } else if (!r.error) {
    out.push(`<p style="margin:0 0 8px">${escHtml(t('admin.staleFixNothing', 'Nothing could be fixed from here.'))}</p>`);
  }
  if (r.error) out.push(`<p style="margin:0 0 8px;color:var(--color-danger,#c0392b)">${escHtml(r.error)}</p>`);
  // The remedy paragraph already says it when the fresh read carries the touch report.
  const remedySaysWait = (() => {
    const d = describeStaleCode(_versions, { retriesExhausted: _staleExhausted, autoRecheckDone: _staleAutoUsed });
    return !!d && d.remedy === 'wait' && d.touched > 0;
  })();
  if (r.wait > 0 && !remedySaysWait) {
    const vars = { seconds: r.wait };
    const when = _staleAutoAt
      ? ' ' + fill(t('admin.staleCodeAutoRecheck', 'Automatic re-check at {time}.', { time: _staleAutoClock() }), { time: _staleAutoClock() }) : '';
    out.push(`<p class="adm-muted" style="margin:0 0 8px">${escHtml(fill(t('admin.staleCodeRemedyWaitTouched', 'The server refreshed the date of its files, so PHP re-reads them within {seconds} s. This tab re-checks by itself after that delay.', vars), vars) + when)}</p>`);
  }
  const paths = [...new Set(r.paths || [])];
  if (paths.length) {
    out.push(`<p class="adm-muted" style="margin:0 0 4px">${escHtml(t('admin.staleCodeCannotWrite', 'PHP cannot change these files, they belong to another account: upload them again by SFTP, or ask the host to give the PHP user write access to them.'))}</p>`);
    out.push(`<ul style="margin:0 0 12px;padding-left:18px">${paths.slice(0, 20).map((p) => `<li><code>${escHtml(p)}</code></li>`).join('')}</ul>`);
  }
  return out.join('');
}

/** A failed fix or reinstall call as one sentence: never the raw code. */
function repairErrorText(base, r) {
  const d = r && r.data;
  const code = d && typeof d.error === 'string' ? d.error : '';
  let why;
  if (code === 'no_update_available' || code === 'reinstall_unsupported') why = t('admin.staleCodeReinstallOutdated', 'the server refused because the process that answered still runs older code: re-check, then try again');
  else if (code === 'unverifiable_release') why = unverifiableMessage('');
  else if (code === 'reinstall_version_mismatch') {
    const latest = d && typeof d.latest === 'string' ? d.latest : '';
    const current = d && typeof d.current === 'string' ? d.current : '';
    const tuple = (v) => String(v).split('.').map((n) => parseInt(n, 10) || 0);
    const cmp = (a, b) => { const x = tuple(a), y = tuple(b); for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0); } return 0; };
    if (latest && current && cmp(latest, current) > 0) {
      why = fill(t('admin.updateErr_reinstall_version_mismatch', 'a newer version {latest} is published: run the normal update instead, it rewrites every file too', { latest }), { latest });
    } else {
      const vars = { latest: latest || '?', current: current || '?' };
      why = fill(t('admin.updateErr_reinstall_version_differs', 'the published release ({latest}) differs from the files on disk ({current}): re-check, then decide', vars), vars);
    }
  } else if (code) why = t(`admin.updateErr_${code}`, '') || t('admin.updateErr_generic', 'unexpected error: see the server log');
  else why = '';
  return `${base} (HTTP ${r ? r.status : 0}${why ? ' — ' + why : ''})`;
}

/** Reinstall `version` (pinned: a server must not install a newer release in its place).
 *  Fills `result`; answers 'reload' when another version landed and the page must reload. */
async function reinstallStale(version, result) {
  const u = await apiFetchStatus(`${API_ADMIN}?action=update_apply`, {
    method: 'POST', body: JSON.stringify({ reinstall: true, version }) });
  const ud = u && u.data;
  if (!(u && u.ok && ud && ud.ok)) {
    result.error = repairErrorText(t('admin.staleCodeReinstallFailed', 'The reinstall failed.'), u);
  } else if (ud.applied && String(ud.applied) !== String(version)) {
    // Another version landed: the running admin JS is outdated, reload as an update does.
    const applied = String(ud.applied);
    toast(t('admin.updateApplied', 'Mise à jour appliquée (v{v}) — rechargement…', { v: applied }).replace('{v}', applied), 'success');
    setTimeout(() => location.reload(), 2000);
    return 'reload';
  } else if (Number(ud.pendingFinalize) > 0) {
    result.error = t('admin.staleCodeReinstallPending', 'Some files could not be replaced and are parked beside their target: finish the update by renaming them, or upload them again by SFTP.');
  } else if (ud.reinstalled === true) {
    result.reinstalled = String(version);
  } else {
    result.error = repairErrorText(t('admin.staleCodeReinstallFailed', 'The reinstall failed.'), { status: u.status, data: null });
  }
  return null;
}

/** "Try to fix automatically": the server applies every correction it can (parked files,
 *  opcache, file dates, permissions), the tab reinstalls the version when the server asks
 *  for it, then asks again whether the code is fresh. One click is one run. */
async function fixStale() {
  if (_repair.busy || _updating || _versionsLoading) return;
  _repair = { busy: true, result: null };
  cancelStaleAuto();
  _staleAutoUsed = false;   // like a manual re-check, a fix rearms the automatic one
  render();
  const result = { actions: [], reinstalled: null, error: null, paths: [], wait: 0 };
  let next = 'manual';
  try {
    const r = await apiFetchStatus(`${API_ADMIN}?action=stale_fix`, { method: 'POST', body: '{}' });
    const d = r && r.data;
    if (!r || !r.ok || !d || d.error || typeof d.next !== 'string') {
      result.error = repairErrorText(t('admin.staleFixFailed', 'The automatic fix could not run.'), r);
    } else {
      result.actions = cleanFixActions(d.actions);
      for (const a of result.actions) if (a.id === 'repair_permissions' && !a.ok) result.paths.push(...a.detail);
      next = d.next;
      if (next === 'wait') result.wait = Math.max(0, Number(d.waitSeconds) || 0);
      if (next === 'reinstall') {
        const version = typeof d.filesVersion === 'string' && d.filesVersion ? d.filesVersion : (describeStaleCode(_versions)?.files || '');
        if (version && (await reinstallStale(version, result)) === 'reload') {
          _repair = { busy: false, result: null };
          render();
          return;
        }
      }
    }
  } catch (e) {
    console.error('stale code fix failed', e);
    result.error = t('admin.staleFixFailed', 'The automatic fix could not run.');
  }
  _repair = { busy: true, result };
  render();
  await loadVersions({ keepResult: true });
  // The dates were refreshed: PHP re-reads within `wait` s. The fresh read arms the timer
  // itself when it still sees the server's own report; otherwise it is armed here.
  if (next === 'wait' && result.wait > 0 && describeStaleCode(_versions)) armStaleAuto(result.wait + 5);
  const stillStale = describeStaleCode(_versions, { retriesExhausted: _staleExhausted, autoRecheckDone: _staleAutoUsed }) !== null;
  _repair = { ..._repair, busy: false };
  if (!stillStale && !result.error) toast(t('admin.staleFixDone', 'The server now runs the new code.'), 'success');
  render();
}

/** Warning shown when the code the server executes differs from its files. Not shown
 *  while an update runs: the process is about to be replaced and the numbers are moving. */
function staleCodeBlock() {
  if (_updating) return '';
  const s = describeStaleCode(_versions, { retriesExhausted: _staleExhausted, autoRecheckDone: _staleAutoUsed });
  if (!s) return '';
  const vars = { code: s.code ?? '?', files: s.files, seconds: s.waitSeconds, details: s.details };
  const remedyText = {
    parked: ['admin.staleCodeRemedyParked', 'Update files are parked beside their target ({files}): rename each *.lumen-new file over its target, then re-check.'],
    restart: ['admin.staleCodeRemedyRestart', 'Restart the server (stop and start dev_server.py), then re-check.'],
    recheck: ['admin.staleCodeRemedyRecheck', 'The server has just dropped its cached code. Re-check: the next request runs the new files.'],
    wait: s.touched > 0
      ? ['admin.staleCodeRemedyWaitTouched', 'The server refreshed the date of its files, so PHP re-reads them within {seconds} s. This tab re-checks by itself after that delay.']
      : ['admin.staleCodeRemedyWait', 'PHP re-reads changed files every {seconds} s. Wait that long, then re-check.'],
    touch: ['admin.staleCodeRemedyTouch', 'PHP only re-reads a file whose date changed, and the server could not change the date of its files. Upload api/_admin_lib.php and the other api/*.php files again by SFTP, making sure the files get a new date (turn off "preserve timestamps" in your SFTP client, or open and re-save the file in your host\'s file manager). Or ask your host to restart PHP. Then re-check.'],
    touchNoEffect: ['admin.staleCodeRemedyTouchNoEffect', 'The server refreshed the date of its files and waited {seconds} s, but PHP still runs the old code. Upload the api/*.php files again by SFTP, or ask your host to restart PHP, then re-check.'],
    incomplete: ['admin.staleCodeRemedyIncomplete', 'Run the update again (Verify, then update) so that every file reaches version {code}.'],
    reupload: ['admin.staleCodeRemedyReupload', 'Upload the files of version {files} again over the existing ones (the api/ folder first), or ask your host to restart PHP, then re-check.'],
    opcache: ['admin.staleCodeRemedyOpcache', 'Restart PHP or ask your host to clear opcache, then re-check.'],
    processes: ['admin.staleCodeRemedyProcesses', 'PHP dropped its cached copy, but other PHP processes of the host still hold the old one. Each is cleared when it next answers. If the warning stays, ask your host to restart PHP.'],
    permissions: s.reinstall
      ? ['admin.staleCodeRemedyPermissionsReinstall', 'Some files of version {files} could not be written by PHP, so their old versions are still in place. “Try to fix automatically” repairs their permissions and reinstalls the version from here.']
      : ['admin.staleCodeRemedyPermissions', 'Some files of version {files} could not be written by PHP, so their old versions are still in place. Use “Try to fix automatically” to repair their permissions, then upload version {files} again over them (the api/ folder first) if the warning stays.'],
  }[s.remedy];
  // t() interpolates {files} itself, so the parked list must be in the params it receives.
  const remedyVars = s.remedy === 'parked' ? { ...vars, files: (s.parked || []).join(', ') } : vars;
  const remedy = fill(t(remedyText[0], remedyText[1], remedyVars), remedyVars);
  const bodyKey = s.remedy === 'incomplete' ? ['admin.staleCodeBodyNewer', 'The server code is version {code} but its files are only version {files}: an update stopped half-way. Plugin installs are refused until this is fixed.']
    : s.code ? ['admin.staleCodeBody', 'The server still runs the code of version {code} while its files are version {files}. Plugin installs are refused until this is fixed.']
      : ['admin.staleCodeBodyOlder', 'The server still runs code older than its files (version {files}). Plugin installs are refused until this is fixed.'];
  const body = fill(t(bodyKey[0], bodyKey[1], vars), vars);
  const autoText = s.autoRecheckSeconds > 0 && _staleAutoAt
    ? fill(t('admin.staleCodeAutoRecheck', 'Automatic re-check at {time}.', { time: _staleAutoClock() }), { time: _staleAutoClock() }) : '';
  const details = s.details ? fill(t('admin.staleCodeDetails', 'Details for your host: {details}', vars), vars) : '';
  return `
    <div class="adm-card" style="margin-top:18px" id="stale-code-card">
      <div class="adm-card-body">
        <div class="adm-update-state adm-warn" role="status"><i data-lucide="alert-triangle"></i> <b>${escHtml(t('admin.staleCodeTitle', 'The server runs older code than its files'))}</b></div>
        <p style="margin:8px 0">${escHtml(body)}</p>
        <p class="adm-muted" style="margin:8px 0 ${details ? '4px' : '12px'}">${escHtml(remedy)}${autoText ? ' ' + escHtml(autoText) : ''}</p>
        ${details ? `<p class="adm-muted" style="margin:0 0 12px;font-size:.85em">${escHtml(details)}</p>` : ''}
        ${s.repairable ? staleRepairBlock(s) : ''}
        ${staleRepairResult()}
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          ${s.fixable ? `<button class="adm-btn adm-btn-sm" id="btn-stale-autofix"${_repair.busy || _versionsLoading ? ' disabled' : ''}>${_repair.busy
    ? `<span class="spinner spinner-sm"></span> ${escHtml(t('admin.staleFixRunning', 'Fixing…'))}`
    : `<i data-lucide="wrench"></i> ${escHtml(t('admin.staleFixButton', 'Try to fix automatically'))}`}</button>` : ''}
          <button class="adm-btn adm-btn-ghost adm-btn-sm" id="btn-stale-recheck"${_repair.busy || _versionsLoading ? ' disabled' : ''}><i data-lucide="refresh-cw"></i> ${escHtml(t('admin.staleCodeRecheck', 'Re-check'))}</button>
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
      ${_updating ? '' : `<button class="adm-btn adm-btn-ghost adm-btn-sm" id="btn-recheck"><i data-lucide="refresh-cw"></i> ${escHtml(t('admin.checkUpdates', 'Vérifier'))}</button>`}
    </div>

    ${staleCodeBlock()}

    ${lastOutcomeBlock(lastOutcome)}

    <div class="adm-card" style="margin-top:18px">
      <div class="adm-card-head"><i data-lucide="tag"></i><span>${escHtml(t('admin.currentVersion', 'Versions installées'))}</span></div>
      <div class="adm-card-body adm-vchips">
        ${versionChip('admin.webPlatform', 'Plateforme Web', v.web ? `v${v.web}` : null)}
        ${versionChip('admin.preprocess', 'Pipeline de préprocessing', v.preprocess ? `v${v.preprocess}` : null)}
      </div>
    </div>

    <div class="adm-card" style="margin-top:18px">
      <div class="adm-card-head"><i data-lucide="cloud-download"></i><span>${escHtml(t('admin.githubUpdate', 'Mise à jour GitHub'))}</span>
        <span class="adm-card-count adm-muted">${escHtml((v.repo) || '')}</span></div>
      <div class="adm-card-body" id="update-body">${updateBlock()}</div>
    </div>

    <div class="adm-card" style="margin-top:18px">
      <div class="adm-card-head"><i data-lucide="puzzle"></i><span>${escHtml(t('admin.pluginUpdates', 'Mises à jour des plugins'))}</span></div>
      <div class="adm-card-body" id="plugin-updates-body">${pluginUpdatesBlock()}</div>
    </div>

    <div class="adm-card" style="margin-top:18px">
      <div class="adm-card-head"><i data-lucide="workflow"></i><span>${escHtml(t('admin.pipelinePackUpdates', 'Pack de traitement'))}</span></div>
      <div class="adm-card-body" id="pipeline-pack-body">${pipelinePackBlock()}</div>
    </div>

    <div class="adm-card adm-progress-card" id="progress-card" style="display:${_updating ? 'block' : 'none'};margin-top:18px">
      <div class="adm-card-head"><i data-lucide="loader"></i><span>${escHtml(t('admin.updating', 'Mise à jour en cours'))}</span></div>
      <div class="adm-card-body">
        <div class="adm-phase-chips" id="phase-chips">${PHASES.map(([key, i18nKey, def]) =>
          `<span class="adm-phase-chip" data-phase="${key}">${escHtml(t(i18nKey, def))}</span>`).join('')}</div>
        <div class="adm-progress"><div class="adm-progress-bar" id="progress-bar" style="width:0%"></div></div>
        <div class="adm-progress-msg" id="progress-msg"></div>
      </div>
    </div>`;

  el('btn-recheck')?.addEventListener('click', recheck);
  el('btn-stale-recheck')?.addEventListener('click', recheck);
  el('btn-stale-autofix')?.addEventListener('click', fixStale);
  el('btn-ack-update')?.addEventListener('click', ackOutcome);
  bindUpdateBody(root);
  bindPluginUpdates(root);
  refreshIcons(root);
  if (_updating) paintProgress();
}

let _staleTries = 0;
let _staleExhausted = false;
// The automatic re-check of a stale banner whose remedy is "wait" (the server refreshed
// the date of its files): one timer, once per manual re-check, ended by a newer read.
let _staleAutoTimer = null;
let _staleAutoAt = 0;
let _staleAutoUsed = false;

function _staleAutoClock() {
  const d = new Date(_staleAutoAt);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function cancelStaleAuto() {
  if (_staleAutoTimer !== null) clearTimeout(_staleAutoTimer);
  _staleAutoTimer = null;
  _staleAutoAt = 0;
}

/** Arms the automatic re-check when the banner says PHP will re-read its files by
 *  itself. Called after every versions read; a read that is not the newest one, an
 *  armed timer, or an automatic re-check already made (until a manual one) does nothing. */
function scheduleStaleAuto(gen) {
  if (gen !== _versionsGen || _staleAutoUsed || _staleAutoTimer !== null) return;
  const s = describeStaleCode(_versions, { retriesExhausted: _staleExhausted, autoRecheckDone: _staleAutoUsed });
  if (!s || s.autoRecheckSeconds <= 0) return;
  armStaleAuto(s.autoRecheckSeconds);
}

/** One automatic re-check after `seconds`, unless a newer read (manual re-check, fix)
 *  took over meanwhile. No-op while one is already armed. */
function armStaleAuto(seconds) {
  if (_staleAutoTimer !== null || !(seconds > 0)) return;
  const gen = _versionsGen;
  _staleAutoAt = Date.now() + seconds * 1000;
  _staleAutoTimer = setTimeout(() => {
    _staleAutoTimer = null;
    _staleAutoAt = 0;
    if (gen !== _versionsGen || _updating || _repair.busy) return;
    _staleAutoUsed = true;
    loadVersions().then(() => render());
  }, seconds * 1000);
}
let _versionsGen = 0;
let _versionsLoading = false;
const STALE_RETRIES = 4;
const STALE_RETRY_MS = 1500;

/** Reads the versions and, while the server says it just dropped its cached code, asks
 *  again. One run at a time: a newer call supersedes a running loop (its generation ends it). */
async function loadVersions(opts = {}) {
  const gen = ++_versionsGen;
  cancelStaleAuto();
  _staleTries = 0; _staleExhausted = false;
  const v = await apiFetch(`${API_ADMIN}?action=version`);
  if (gen !== _versionsGen) return;
  if (v) _versions = v;
  let s = describeStaleCode(_versions, { retriesExhausted: false, autoRecheckDone: _staleAutoUsed });
  if (s && s.retry) {
    _versionsLoading = true;
    render();
    let answers = 0;
    let lost = false;
    try {
      while (s && s.retry && _staleTries < STALE_RETRIES) {
        _staleTries++;
        await new Promise((r) => setTimeout(r, STALE_RETRY_MS));
        if (gen !== _versionsGen) return;
        const again = await apiFetch(`${API_ADMIN}?action=version`);
        if (gen !== _versionsGen) return;
        if (!again) { lost = true; break; }   // no answer: the old reading says nothing new
        answers++;
        _versions = again;
        s = describeStaleCode(_versions, { retriesExhausted: false, autoRecheckDone: _staleAutoUsed });
      }
    } finally {
      if (gen === _versionsGen) _versionsLoading = false;
    }
    // Still "the server just acted" after every answered attempt: other PHP processes hold the old code.
    if (s && s.retry && !lost && answers >= STALE_RETRIES) _staleExhausted = true;
  }
  // A repair report belongs to the card it was shown in: it survives only the re-check
  // that follows the repair while the banner is still up.
  if (!(opts.keepResult && s)) _repair = { ..._repair, result: null };
  scheduleStaleAuto(gen);
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

async function loadPipelinePack() {
  _pipeline = null;
  const p = await apiFetch(`${API_ADMIN}?action=pipeline_info`);
  _pipeline = p || { update: { reason: 'unreachable' } };
  const body = el('pipeline-pack-body');
  if (body) {
    body.innerHTML = pipelinePackBlock();
    refreshIcons(body);
  }
}

function recheck() {
  if (_updating) return;
  // A running repair or retry loop owns the versions read: the GitHub checks still run.
  if (!(_repair.busy || _versionsLoading)) {
    _repair = { ..._repair, result: null };
    _staleAutoUsed = false;   // a manual re-check rearms the automatic one
    loadVersions().then(() => render());
  }
  loadCheck(); loadPluginUpdates(); loadPipelinePack();
}

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
  if (_updating) return;
  _updating = true;
  _progress = { pct: 0, msg: () => progressLine({ phase: 'starting' }), phase: null };
  const btn = el('btn-confirm-update');
  if (btn) { btn.disabled = true; btn.innerHTML = `<span class="spinner spinner-sm"></span> ${escHtml(t('admin.updating', 'Mise à jour…'))}`; }
  const r = await apiFetchStatus(`${API_ADMIN}?action=update_apply`, { method: 'POST', body: '{}' });
  if (!(r.ok && r.data?.ok)) {
    _updating = false;
    // A re-render during the request replaced the preflight block: draw it again
    // so Confirm / Cancel are back, whichever node the operator now sees.
    render();
    toast(r.data?.error === 'no_update_available'
      ? t('admin.upToDate', 'Vous êtes à jour.')
      : r.data?.error === 'unverifiable_release'
        ? unverifiableMessage(r.data.reason)
        : t('admin.updateFailed', 'Échec du lancement de la mise à jour.') + (r.data?.error ? ` (${updateErrorText(r.data.error)})` : ''), 'error');
    return;
  }
  // Synchronous apply (PHP hosts): the whole download→verify→swap ran inside this
  // one request and `applied` carries the landed version. Reload to pick up the
  // fresh HTML (whose ?v=<version> asset URLs bust the browser cache).
  if (r.data.applied) {
    _preflight = null;
    const applied = r.data.applied;
    const appliedMsg = () => t('admin.updateApplied', 'Mise à jour appliquée (v{v}) — rechargement…', { v: applied }).replace('{v}', applied);
    _progress = { pct: 100, msg: appliedMsg, phase: null };
    render();
    toast(appliedMsg(), 'success');
    setTimeout(() => location.reload(), 2000);
    return;
  }
  _targetVersion = _bareVersion(_check?.latest);
  _startVersion = _bareVersion(_check?.current);
  _sawPivot = false;
  _preflight = null;
  render();
  pollStatus();
}

/** Records the progress (msg: a string, or a function giving it in the current
 *  language) and paints it. The phase chips keep the last phase reported. */
function setProgress(pct, msg, phase) {
  _progress = { pct, msg, phase: phase || _progress.phase };
  paintProgress();
}

function paintProgress() {
  const { pct, msg, phase } = _progress;
  const text = typeof msg === 'function' ? msg() : msg;
  const bar = el('progress-bar'), m = el('progress-msg');
  if (bar) bar.style.width = `${Math.max(0, Math.min(100, Number(pct) || 0))}%`;
  if (m) m.textContent = text || '';
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
  let misses = 0;
  const tick = async () => {
    const s = await apiFetch(`${API_ADMIN}?action=update_status`);
    if (!s) {
      // One empty answer proves nothing (a dropped request, a 5xx page, an expired
      // session all look the same). The server really restarting means it keeps
      // not answering: only then switch to the restart probe.
      if (++misses < 4) { setTimeout(tick, 1500); return; }
      _polling = false; pollRestart(); return;
    }
    misses = 0;
    setProgress(s.pct || 0, () => progressLine(s), s.phase);
    if (s.phase === 'error') {
      _polling = false;
      _updating = false;
      toast(t('admin.updateFailed', 'Échec de la mise à jour.') + (s.error ? ` (${updateErrorText(s.error)})` : ''), 'error');
      loadCheck();
      return;
    }
    if (s.phase === 'pivoting') { _sawPivot = true; _polling = false; pollRestart(); return; }
    setTimeout(tick, 1000);
  };
  tick();
}

function pollRestart() {
  setProgress(93, () => t('admin.updateRestart', 'Redémarrage du serveur…'), 'restart');
  const deadline = Date.now() + 120000;
  const probe = async () => {
    try {
      const resp = await fetch('api/health', { cache: 'no-store' });
      if (resp.ok) {
        const h = await resp.json();
        if (h?.ok) {
          const rolledBack = h.lastUpdate?.phase === 'rolled_back';
          // A server that answers is not proof the update landed: the OLD process
          // answers too while it is still downloading or verifying. Success needs
          // the new version, or (target unknown) a version change / the pivot.
          const nowV = _bareVersion(h.web);
          const landed = _targetVersion ? nowV === _targetVersion
                                        : (_sawPivot || (_startVersion && nowV !== _startVersion));
          if (!rolledBack && !landed) { if (Date.now() < deadline) { setTimeout(probe, 1500); return; } }
          const done = !rolledBack && landed;
          const web = h.web;
          setProgress(100,
            done ? () => `${t('admin.updateSucceeded', 'Mise à jour terminée avec succès. Le serveur a redémarré — reconnectez-vous.')} (v${web})`
                 : () => t('admin.updateRolledBack', "La nouvelle version n'a pas démarré — restauration automatique effectuée. L'ancienne version fonctionne."),
            done ? undefined : 'restart');
          setTimeout(() => location.reload(), 2500);
          return;
        }
      }
    } catch (_) { /* server still down — keep probing */ }
    if (Date.now() > deadline) {
      _polling = false;
      _updating = false;
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
  mount() { render(); loadVersions().then(() => render()); loadCheck(); loadPluginUpdates(); loadPipelinePack(); },
  activate() {},
  relabel() { render(); },
};
