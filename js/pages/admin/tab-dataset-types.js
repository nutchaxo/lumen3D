/**
 * Admin SPA — Dataset types (white-label)
 * =======================================
 * Renames the dataset types WITHOUT touching their ids. A type id — '3d', '2d',
 * 'live', 'tracking' — is structural: it is the directory under DATA_WEB/, the
 * first segment of every dataset id, the value in metadata.json, what
 * plugin.json declares in `dataTypes`, and the ?type= filter. It is shown
 * read-only here for exactly that reason.
 *
 * What a VISITOR reads is not structural. It is stored per locale in
 * config/instance.json under datasetTypes.<id>.{label,title} and resolved by
 * Utils.datasetTypeLabel / datasetTypeTitle, which fall back to the translated
 * default (types.<id>.* in lang/<code>.json) for every field left empty. So an
 * empty input is not "no name" — it is "keep the translated default", which is
 * why saving drops empty locales instead of storing blank strings.
 *
 * The Identity tab writes the SAME document (/api/site.php?doc=instance), so
 * save() re-reads it and merges only the datasetTypes key — a whole-document
 * POST built from this tab's stale copy would silently revert an identity edit
 * made in another tab in the meantime.
 */

'use strict';

import {
  API_SITE, API_DATASETS, I18n, Utils, t, escHtml,
  apiFetch, apiFetchStatus, toast, el, refreshIcons, deepClone,
} from './shared.js';
import { setUnsaved } from './bus.js';

let _types = {};        // the datasetTypes block being edited
let _counts = null;     // type id → number of published datasets
let _defaults = {};     // locale code → lang dictionary (for per-locale placeholders)
let _dirty = false;
let _raisedUnsaved = false;

/**
 * bus.setUnsaved drives ONE shared indicator, and the Datasets tab owns the
 * cross-tab guard (bus.setDirtyGuard) plus its own Ctrl+S handler. This tab must
 * therefore never install a dirty guard — that would REPLACE the Datasets tab's,
 * disabling its discard confirmation — and must only lower the shared indicator
 * it raised itself, or loading this tab would clear the Datasets tab's dot.
 */
function _mark(on) {
  _dirty = !!on;
  if (_dirty) { setUnsaved(true); _raisedUnsaved = true; }
  else if (_raisedUnsaved) { setUnsaved(false); _raisedUnsaved = false; }
  const s = el('dtypes-save');
  if (s) s.disabled = !_dirty;
}

function _locales() {
  try {
    if (I18n && I18n.getAvailableLanguages) {
      const l = I18n.getAvailableLanguages().map((x) => x.code);
      if (l.length) return l;
    }
  } catch (_) { /* fall through */ }
  return ['en', 'fr', 'es'];
}

function _typeList() {
  return (Utils && Array.isArray(Utils.DATASET_TYPES)) ? Utils.DATASET_TYPES : [];
}

// ── Model access (paths are "<type>.<field>") ───────────────────
function _get(path) {
  const [type, field] = path.split('.');
  const entry = _types[type];
  return (entry && typeof entry === 'object') ? entry[field] : undefined;
}

// ── Translated defaults, per locale ─────────────────────────────
// The placeholder must show what THIS locale falls back to, not what the admin
// UI happens to be displaying — so each dictionary is read directly rather than
// through I18n.t(), which only ever answers for the active language.
async function _loadDefaults() {
  if (!I18n || !I18n.loadLanguage) return;
  for (const code of _locales()) {
    if (_defaults[code] !== undefined) continue;
    try { _defaults[code] = await I18n.loadLanguage(code); } catch (_) { _defaults[code] = null; }
  }
}

function _defaultText(type, field, code) {
  const dict = _defaults[code];
  const v = dict && dict.types && dict.types[type] ? dict.types[type][field] : null;
  if (typeof v === 'string' && v) return v;
  // No dictionary for that locale — show what the platform renders today.
  if (!Utils) return field === 'label' ? type : '';
  return field === 'label' ? Utils.datasetTypeLabel(type) : Utils.datasetTypeTitle(type);
}

// ── Field builder ───────────────────────────────────────────────
// One input per available locale, like the Identity tab's localized fields.
// Stored as { en:"…", fr:"…" }; empty locales are dropped on save.
function _localizedField(path, label, hint) {
  const raw = _get(path);
  const locs = _locales();
  const inputs = locs.map((code) => {
    const val = (raw && typeof raw === 'object' && !Array.isArray(raw))
      ? (raw[code] || '')
      : (((code === locs[0] || code === 'en') && typeof raw === 'string') ? raw : '');
    const [type, field] = path.split('.');
    return `<div class="adm-loc-input" style="display:flex;align-items:center;gap:6px">
        <span class="adm-loc-tag" style="min-width:26px;font-size:11px;opacity:.7;text-transform:uppercase">${escHtml(code)}</span>
        <input type="text" class="adm-field-input" data-loc-path="${escHtml(path)}" data-loc="${escHtml(code)}"
               value="${escHtml(val)}" placeholder="${escHtml(_defaultText(type, field, code))}"
               spellcheck="false" style="flex:1">
      </div>`;
  }).join('');
  return `<div class="adm-field">
      <span class="adm-field-label">${escHtml(label)} <span style="opacity:.5;font-weight:400">(${escHtml(t('dtypes.perLocale', 'multilingue'))})</span></span>
      <div style="display:flex;flex-direction:column;gap:5px">${inputs}</div>
      ${hint ? `<span class="adm-field-hint" style="font-size:11px;opacity:.6">${escHtml(hint)}</span>` : ''}
    </div>`;
}

// ── Render ──────────────────────────────────────────────────────
function countText(type) {
  if (!_counts) return '…';
  const n = _counts[type] || 0;
  return t('dtypes.count', `${n} dataset(s)`, { n });
}

function card(type) {
  const icon = Utils ? Utils.datasetTypeIcon(type) : 'box';
  const live = Utils ? Utils.datasetTypeLabel(type) : type;
  return `<div class="adm-card">
      <div class="adm-card-head dtype-card-head">
        <i data-lucide="${escHtml(icon)}"></i>
        <span>${escHtml(live)}</span>
        <span class="dtype-id" title="${escHtml(t('dtypes.idHint', 'Identifiant technique — dossier, id de dataset, filtres et plugins. Non modifiable.'))}">${escHtml(type)}</span>
        <span class="dtype-count" id="dtype-count-${escHtml(type)}">${escHtml(countText(type))}</span>
      </div>
      <div class="dtype-body">
        ${_localizedField(`${type}.label`, t('dtypes.short', 'Nom court'),
          t('dtypes.shortHint', 'Badges, filtres, listes. Laissez vide pour garder le nom traduit par défaut.'))}
        <details class="dtype-more">
          <summary>${escHtml(t('dtypes.long', 'Titre long (page d\'accueil)'))}</summary>
          <div class="dtype-more-body">
            ${_localizedField(`${type}.title`, t('dtypes.longLabel', 'Titre long'),
              t('dtypes.longHint', 'Titre des cartes de type sur la page d\'accueil.'))}
          </div>
        </details>
      </div>
    </div>`;
}

function render() {
  const root = el('dataset-types-root');
  if (!root) return;
  const types = _typeList();

  root.innerHTML = `
    <div class="adm-page-head">
      <div>
        <h2 class="adm-page-title">${escHtml(t('dtypes.title', 'Types de données'))}</h2>
        <p class="adm-page-sub">${escHtml(t('dtypes.sub', "Renommez ce que lisent vos visiteurs. L'identifiant technique de chaque type ne change jamais."))}</p>
      </div>
      <div style="display:flex;gap:8px">
        <button class="adm-btn adm-btn-ghost adm-btn-sm" id="dtypes-reset"><i data-lucide="rotate-ccw"></i> ${escHtml(t('dtypes.reset', 'Noms par défaut'))}</button>
        <button class="adm-btn adm-btn-accent adm-btn-sm" id="dtypes-save" ${_dirty ? '' : 'disabled'}><i data-lucide="save"></i> ${escHtml(t('dtypes.save', 'Enregistrer'))}</button>
      </div>
    </div>

    ${types.length
      ? `<div class="dtype-grid">${types.map(card).join('')}</div>`
      : `<p class="adm-page-sub">${escHtml(t('dtypes.none', 'Aucun type de dataset déclaré.'))}</p>`}`;

  root.querySelectorAll('input[data-loc-path]').forEach((inp) => {
    inp.addEventListener('input', () => _mark(true));
    inp.addEventListener('change', () => _mark(true));
  });
  el('dtypes-save')?.addEventListener('click', save);
  el('dtypes-reset')?.addEventListener('click', resetToDefaults);
  refreshIcons(root);
}

// Counts land after the first paint: write them into the existing nodes instead
// of re-rendering, which would discard whatever the operator is typing.
function paintCounts() {
  _typeList().forEach((type) => {
    const node = el(`dtype-count-${type}`);
    if (node) node.textContent = countText(type);
  });
}

// ── Collect / save ──────────────────────────────────────────────
function _collect() {
  const root = el('dataset-types-root');
  if (!root) return;
  const next = {};
  root.querySelectorAll('input[data-loc-path]').forEach((inp) => {
    const [type, field] = (inp.getAttribute('data-loc-path') || '').split('.');
    const code = inp.getAttribute('data-loc');
    const value = (inp.value || '').trim();
    if (!type || !field || !code || !value) return;   // empty ⇒ keep the translated default
    const entry = (next[type] = next[type] || {});
    const bucket = (entry[field] = entry[field] || {});
    bucket[code] = value;
  });
  _types = next;   // a type with neither label nor title simply disappears
}

async function save() {
  _collect();
  const btn = el('dtypes-save');
  if (btn) btn.disabled = true;

  const fresh = await apiFetch(`${API_SITE}?action=get&doc=instance`);
  if (!fresh || typeof fresh !== 'object') {
    if (btn) btn.disabled = false;
    toast(t('dtypes.saveError', "Échec de l'enregistrement."), 'error');
    return;
  }
  fresh.datasetTypes = _types;

  const r = await apiFetchStatus(`${API_SITE}?action=save&doc=instance`, {
    method: 'POST', body: JSON.stringify(fresh),
  });
  if (!r.ok) {
    if (btn) btn.disabled = false;
    toast(t('dtypes.saveError', "Échec de l'enregistrement."), 'error');
    return;
  }
  _mark(false);
  // Re-read the live config so the badges, filters and titles this panel renders
  // show the new names immediately, not after a reload.
  try {
    if (typeof InstanceConfig !== 'undefined') { await InstanceConfig.load(); InstanceConfig.applyDom(); }
  } catch (_) { /* the document is saved either way */ }
  render();
  paintCounts();
  toast(t('dtypes.saved', 'Noms des types enregistrés.'), 'success');
}

function resetToDefaults() {
  if (!confirm(t('dtypes.resetConfirm', 'Rétablir les noms traduits par défaut pour tous les types ?'))) return;
  const root = el('dataset-types-root');
  if (!root) return;
  root.querySelectorAll('input[data-loc-path]').forEach((inp) => { inp.value = ''; });
  _mark(true);
}

// ── Load ────────────────────────────────────────────────────────
async function load() {
  await _loadDefaults();
  const data = await apiFetch(`${API_SITE}?action=get&doc=instance`);
  const block = (data && typeof data === 'object' && data.datasetTypes && typeof data.datasetTypes === 'object')
    ? data.datasetTypes : {};
  _types = deepClone(block);
  _mark(false);
  render();
  loadCounts();
}

async function loadCounts() {
  const data = await apiFetch(`${API_DATASETS}?action=list`);
  if (!data || !Array.isArray(data.datasets)) return;
  const counts = {};
  // A staged dataset is not published yet — counting it here would promise the
  // operator content the public catalog does not have.
  data.datasets.forEach((ds) => {
    if (ds && !ds.staging && ds.type) counts[ds.type] = (counts[ds.type] || 0) + 1;
  });
  _counts = counts;
  paintCounts();
}

export const DatasetTypesTab = {
  id: 'dataset-types',
  titleKey: 'dtypes.nav',
  titleDefault: 'Types de données',
  mounted: false,
  mount() { render(); load(); },
  activate() { if (_dirty) paintCounts(); else load(); },
  // A language switch changes every placeholder and the live label in each card
  // head; keep whatever is being typed rather than reloading over it.
  relabel() { if (_dirty) _collect(); render(); paintCounts(); },
};
