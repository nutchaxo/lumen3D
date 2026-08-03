/**
 * Admin SPA — Documentation tab
 * =============================
 * Lists the operator documents published in DOCS/ on GitHub, and lets the
 * operator read or download them without leaving the panel.
 *
 * There is no index file to maintain: the filename carries everything.
 *
 *     260803 - GUIDE-ADMIN - FR.pdf
 *     ^date    ^stable id    ^language
 *
 * The date versions the document (newest wins, older stay reachable), the id is
 * what makes two files the same document across versions and languages, and the
 * language lets this tab open the operator's own — falling back to English, then
 * to whatever exists. Dropping a new file in DOCS/ is the whole publish step.
 *
 * Both the listing and the file itself come through the server
 * (docs_list / docs_download): raw.githubusercontent serves documents as
 * octet-stream, so a browser would download instead of display them, and a
 * cross-origin frame would be refused by the enforced CSP anyway.
 */

'use strict';

import { API_ADMIN, I18n, t, escHtml, apiFetch, toast, el, refreshIcons } from './shared.js';

let _data = null;          // null = not loaded yet
let _loading = true;
let _preview = null;       // { file, title }
const _openVersions = new Set();   // doc ids whose version history is expanded
const _pickedLang = {};            // doc id -> language the operator selected

const LANG_NAME = {
  FR: 'Français', EN: 'English', NL: 'Nederlands', ES: 'Español',
  DE: 'Deutsch', IT: 'Italiano', PT: 'Português',
};

// A document published in one file covering several languages at once.
const MULTI = 'MULTI';

// Types the browser can display safely. HTML and SVG are absent on purpose —
// both can carry script, and the server refuses to serve them inline for the
// same reason; offering a "Read" button for them would just 404 the preview.
const INLINE_OK = new Set(['pdf', 'png', 'jpg', 'jpeg', 'txt', 'md']);
const canPreview = (v) => INLINE_OK.has(v.ext);

function langLabel(code) {
  if (code === MULTI) return t('docs.multi', 'Multilingue');
  return LANG_NAME[code] || code;
}

function uiLang() {
  try {
    if (I18n && typeof I18n.getLanguage === 'function') {
      return String(I18n.getLanguage() || 'en').slice(0, 2).toUpperCase();
    }
  } catch (_) { /* fall through */ }
  return 'EN';
}

/** The operator's own language when the document has it, else English, else
 *  whatever exists — never an empty panel because a translation is missing. */
function defaultLang(doc) {
  const langs = doc.languages || [];
  const ui = uiLang();
  if (_pickedLang[doc.id] && langs.includes(_pickedLang[doc.id])) return _pickedLang[doc.id];
  if (langs.includes(ui)) return ui;
  if (langs.includes('EN')) return 'EN';
  if (langs.includes(MULTI)) return MULTI;
  return langs[0];
}

function versionsFor(doc, lang) {
  return (doc.versions || []).filter((v) => v.lang === lang);
}

function prettyTitle(id) {
  // GUIDE-ADMIN -> Guide admin. Keeps acronyms of 2-3 letters upper-case.
  return id.split(/[-_\s]+/).map((w, i) => {
    if (w.length <= 3 && w === w.toUpperCase()) return w;
    const lower = w.toLowerCase();
    return i === 0 ? lower.charAt(0).toUpperCase() + lower.slice(1) : lower;
  }).join(' ');
}

function fmtSize(bytes) {
  if (!bytes) return '';
  const mb = bytes / 1024 / 1024;
  return mb >= 1 ? `${mb.toFixed(1)} Mo` : `${Math.round(bytes / 1024)} Ko`;
}

function fmtDate(iso) {
  try {
    const loc = (I18n && I18n.getLanguage) ? I18n.getLanguage() : 'fr';
    return new Date(iso + 'T00:00:00').toLocaleDateString(loc,
      { year: 'numeric', month: 'long', day: 'numeric' });
  } catch (_) { return iso; }
}

const docUrl = (file, inline) =>
  `${API_ADMIN}?action=docs_download&file=${encodeURIComponent(file)}${inline ? '&inline=1' : ''}`;

// ── rendering ───────────────────────────────────────────────────
function previewBlock() {
  if (!_preview) return '';
  return `
    <div class="adm-card" style="margin-bottom:18px">
      <div class="adm-card-head">
        <i data-lucide="book-open"></i><span>${escHtml(_preview.title)}</span>
        <span style="margin-left:auto;display:flex;gap:8px">
          <a class="adm-btn adm-btn-ghost adm-btn-sm" href="${escHtml(docUrl(_preview.file, true))}"
             target="_blank" rel="noopener"><i data-lucide="external-link"></i> ${escHtml(t('docs.newTab', 'Nouvel onglet'))}</a>
          <button class="adm-btn adm-btn-ghost adm-btn-sm" id="docs-close-preview">
            <i data-lucide="x"></i> ${escHtml(t('docs.close', 'Fermer'))}</button>
        </span>
      </div>
      <div class="adm-card-body" style="padding:0">
        <!-- Deliberately NOT sandboxed. The guarantee lives on the server:
             docs_download only answers "inline" for pdf/png/jpg/txt/md, and
             serves text as text/plain — so nothing that reaches this frame can
             execute in our origin. A sandbox here would add nothing and risks
             breaking the browser's built-in PDF viewer, which is the whole
             point of the preview. -->
        <iframe src="${escHtml(docUrl(_preview.file, true))}" title="${escHtml(_preview.title)}"
                style="width:100%;height:72vh;border:0;display:block;background:#fff"></iframe>
      </div>
    </div>`;
}

function versionRows(doc, lang) {
  const vs = versionsFor(doc, lang);
  if (vs.length <= 1) {
    return `<p class="adm-page-sub" style="margin:6px 0 0">${escHtml(t('docs.onlyVersion', 'Une seule version publiée.'))}</p>`;
  }
  return vs.slice(1).map((v) => `
      <div style="display:flex;align-items:center;gap:10px;padding:5px 0;border-top:1px solid var(--adm-border,#2a2a3a)">
        <span style="font-family:'JetBrains Mono',monospace;font-size:12px;opacity:.75">${escHtml(v.date)}</span>
        <span class="adm-page-sub" style="margin:0;flex:1">${escHtml(fmtSize(v.size))}</span>
        ${canPreview(v) ? `
        <button class="adm-btn adm-btn-ghost adm-btn-sm docs-view" data-file="${escHtml(v.file)}"
                data-title="${escHtml(prettyTitle(doc.id) + ' — ' + v.date)}">
          <i data-lucide="eye"></i> ${escHtml(t('docs.view', 'Lire'))}</button>` : ''}
        <a class="adm-btn adm-btn-ghost adm-btn-sm" href="${escHtml(docUrl(v.file, false))}" download>
          <i data-lucide="download"></i></a>
      </div>`).join('');
}

function card(doc) {
  const lang = defaultLang(doc);
  const vs = versionsFor(doc, lang);
  const cur = vs[0];
  if (!cur) return '';
  const open = _openVersions.has(doc.id);
  const older = versionsFor(doc, lang).length - 1;

  const chips = (doc.languages || []).map((L) => `
      <button class="adm-btn ${L === lang ? 'adm-btn-accent' : 'adm-btn-ghost'} adm-btn-sm docs-lang"
              data-doc="${escHtml(doc.id)}" data-lang="${escHtml(L)}">${escHtml(langLabel(L))}</button>`).join('');

  return `
    <div class="adm-card" style="margin-bottom:14px">
      <div class="adm-card-head">
        <i data-lucide="file-text"></i><span>${escHtml(prettyTitle(doc.id))}</span>
        <span class="adm-card-count">${escHtml(cur.ext.toUpperCase())}</span>
      </div>
      <div class="adm-card-body">
        <p class="adm-page-sub" style="margin:0 0 10px">
          ${escHtml(t('docs.updated', 'Mis à jour le'))} <b>${escHtml(fmtDate(cur.date))}</b>
          ${cur.size ? ' · ' + escHtml(fmtSize(cur.size)) : ''}
        </p>
        ${(doc.languages || []).length > 1 ? `
          <div style="margin-bottom:10px">
            <span class="adm-page-sub" style="margin:0 8px 0 0">${escHtml(t('docs.language', 'Langue'))}</span>
            <span style="display:inline-flex;gap:6px;flex-wrap:wrap">${chips}</span>
          </div>` : ''}
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          ${canPreview(cur) ? `
          <button class="adm-btn adm-btn-accent adm-btn-sm docs-view" data-file="${escHtml(cur.file)}"
                  data-title="${escHtml(prettyTitle(doc.id))}">
            <i data-lucide="eye"></i> ${escHtml(t('docs.view', 'Lire'))}</button>` : ''}
          <a class="adm-btn adm-btn-ghost adm-btn-sm" href="${escHtml(docUrl(cur.file, false))}" download>
            <i data-lucide="download"></i> ${escHtml(t('docs.download', 'Télécharger'))}</a>
          ${older > 0 ? `
            <button class="adm-btn adm-btn-ghost adm-btn-sm docs-hist" data-doc="${escHtml(doc.id)}">
              <i data-lucide="history"></i> ${escHtml(t('docs.older', 'Versions précédentes'))} (${older})</button>` : ''}
        </div>
        ${open ? `<div style="margin-top:10px">${versionRows(doc, lang)}</div>` : ''}
      </div>
    </div>`;
}

function render() {
  const root = el('docs-root');
  if (!root) return;

  const head = `
    <div class="adm-page-head">
      <div>
        <h2 class="adm-page-title">${escHtml(t('docs.title', 'Documentation'))}</h2>
        <p class="adm-page-sub">${escHtml(t('docs.sub', 'Les guides et procédures publiés pour cette plateforme. Toujours à jour : ils sont récupérés depuis le dépôt, pas depuis cette installation.'))}</p>
      </div>
      <button class="adm-btn adm-btn-ghost adm-btn-sm" id="docs-refresh">
        <i data-lucide="refresh-cw"></i> ${escHtml(t('docs.refresh', 'Actualiser'))}</button>
    </div>`;

  if (_loading) {
    root.innerHTML = head + `<div class="adm-loading"><span class="spinner spinner-lg"></span></div>`;
    el('docs-refresh')?.addEventListener('click', () => load(true));
    refreshIcons(root);
    return;
  }

  const err = _data && _data.error;
  const ERRS = {
    rate_limited: t('docs.errRate', "Limite de l'API GitHub atteinte. Réessayez dans quelques minutes."),
    unreachable: t('docs.errNet', 'Impossible de contacter GitHub pour lire la liste des documents.'),
    tls_ca_broken: t('docs.errTls', "Le magasin de certificats de PHP est inutilisable sur cet hébergement : téléversez cacert.pem à la racine du site."),
    no_folder: t('docs.errFolder', "Le dossier DOCS/ n'existe pas encore dans le dépôt."),
  };

  const docs = (_data && _data.docs) || [];
  let bodyHtml;
  if (err) {
    bodyHtml = `<div class="adm-update-state adm-warn"><i data-lucide="wifi-off"></i>
        ${escHtml(ERRS[err] || err)} ${_data.detail ? `<span class="adm-muted">${escHtml(_data.detail)}</span>` : ''}</div>`;
  } else if (!docs.length) {
    bodyHtml = `<div class="adm-empty" style="text-align:center;padding:44px 24px;opacity:.85">
        <i data-lucide="book-open" style="width:40px;height:40px;opacity:.5"></i>
        <p style="margin:14px 0 4px;font-weight:600">${escHtml(t('docs.emptyTitle', 'Aucun document publié'))}</p>
        <p class="adm-page-sub" style="margin:0">${escHtml(t('docs.emptyHint', 'Déposez un fichier nommé « 260803 - GUIDE-ADMIN - FR.pdf » dans le dossier DOCS/ du dépôt : il apparaîtra ici.'))}</p>
      </div>`;
  } else {
    bodyHtml = docs.map(card).join('');
  }

  const skipped = (_data && _data.skipped) || [];
  const skipHtml = skipped.length ? `
      <div class="adm-update-state adm-warn" style="margin-top:14px">
        <i data-lucide="alert-triangle"></i>
        ${escHtml(t('docs.skipped', 'Fichiers ignorés (nom non conforme)'))} :
        <span class="adm-muted">${escHtml(skipped.join(' · '))}</span>
      </div>` : '';

  root.innerHTML = head + previewBlock() + bodyHtml + skipHtml;

  el('docs-refresh')?.addEventListener('click', () => load(true));
  el('docs-close-preview')?.addEventListener('click', () => { _preview = null; render(); });
  root.querySelectorAll('.docs-view').forEach((b) => b.addEventListener('click', () => {
    _preview = { file: b.dataset.file, title: b.dataset.title };
    render();
    el('docs-root')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }));
  root.querySelectorAll('.docs-lang').forEach((b) => b.addEventListener('click', () => {
    _pickedLang[b.dataset.doc] = b.dataset.lang;
    _preview = null;                 // the open preview belonged to the old language
    render();
  }));
  root.querySelectorAll('.docs-hist').forEach((b) => b.addEventListener('click', () => {
    const id = b.dataset.doc;
    if (_openVersions.has(id)) _openVersions.delete(id); else _openVersions.add(id);
    render();
  }));
  refreshIcons(root);
}

async function load(force) {
  _loading = true;
  render();
  _data = await apiFetch(`${API_ADMIN}?action=docs_list${force ? '&refresh=1' : ''}`);
  _loading = false;
  if (!_data) toast(t('docs.loadError', 'Impossible de charger la liste des documents.'), 'error');
  render();
}

export const DocsTab = {
  id: 'docs',
  titleKey: 'admin.navDocs',
  titleDefault: 'Documentation',
  mounted: false,
  mount() { load(false); },
  activate() { if (!_data) load(false); },
  relabel() { render(); },
};
