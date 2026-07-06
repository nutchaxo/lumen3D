/**
 * Admin SPA — Branding & identity (white-label)
 * =============================================
 * Edits config/instance.json (via /api/site.php) without touching code: brand
 * identity, the specimen vocabulary, SEO/head text, footer, and which nav entries
 * show. Text that is naturally language-dependent (specimen noun, tagline, SEO,
 * footer copyright) is edited as a LOCALIZED field — one input per available
 * locale — matching the platform's multi-language requirement; identity fields
 * that are proper nouns (name, monogram, URLs) stay single-value.
 *
 * On save the public pages pick up the change on next load (server injects the
 * head from instance.json; InstanceConfig.applyDom fills [data-instance]).
 */

'use strict';

import { API_SITE, I18n, t, escHtml, apiFetch, apiFetchStatus, toast, el, refreshIcons } from './shared.js';
import { setUnsaved } from './bus.js';

let _cfg = {};
let _dirty = false;

function _mark(on) { _dirty = on; setUnsaved(on); const s = el('branding-save'); if (s) s.disabled = !on; }

function _locales() {
  try {
    if (I18n && I18n.getAvailableLanguages) {
      const l = I18n.getAvailableLanguages().map((x) => x.code);
      if (l.length) return l;
    }
  } catch (_) { /* fall through */ }
  return ['en', 'fr', 'es'];
}

function _get(path, dflt) {
  let v = _cfg;
  for (const seg of path.split('.')) { if (v != null && typeof v === 'object' && seg in v) v = v[seg]; else return dflt; }
  return v === undefined ? dflt : v;
}
function _set(path, val) {
  const segs = path.split('.'); let o = _cfg;
  for (let i = 0; i < segs.length - 1; i++) { if (typeof o[segs[i]] !== 'object' || o[segs[i]] == null) o[segs[i]] = {}; o = o[segs[i]]; }
  o[segs[segs.length - 1]] = val;
}

// ── Field builders ──────────────────────────────────────────────
function _textField(path, label, ph) {
  const v = _get(path, '');
  return `<label class="adm-field">
      <span class="adm-field-label">${escHtml(label)}</span>
      <input type="text" class="adm-field-input" data-path="${escHtml(path)}" value="${escHtml(typeof v === 'string' ? v : '')}" placeholder="${escHtml(ph || '')}" spellcheck="false">
    </label>`;
}

// A localizable value: rendered as one input per locale. Stored as
// { en:"…", fr:"…" } on save (empty locales dropped; falls back to en at render).
function _localizedField(path, label) {
  const raw = _get(path, '');
  const locs = _locales();
  const inputs = locs.map((code) => {
    const val = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? (raw[code] || '') : (code === locs[0] || code === 'en' ? (typeof raw === 'string' ? raw : '') : '');
    return `<div class="adm-loc-input" style="display:flex;align-items:center;gap:6px">
        <span class="adm-loc-tag" style="min-width:26px;font-size:11px;opacity:.7;text-transform:uppercase">${escHtml(code)}</span>
        <input type="text" class="adm-field-input" data-loc-path="${escHtml(path)}" data-loc="${escHtml(code)}" value="${escHtml(val)}" spellcheck="false" style="flex:1">
      </div>`;
  }).join('');
  return `<div class="adm-field">
      <span class="adm-field-label">${escHtml(label)} <span style="opacity:.5;font-weight:400">(${escHtml(t('branding.perLocale', 'multilingue'))})</span></span>
      <div style="display:flex;flex-direction:column;gap:5px">${inputs}</div>
    </div>`;
}

function _toggle(path, label) {
  const on = _get(path, true) !== false;
  return `<label class="adm-switch-row" style="display:flex;align-items:center;justify-content:space-between;padding:7px 0">
      <span>${escHtml(label)}</span>
      <input type="checkbox" data-toggle="${escHtml(path)}" ${on ? 'checked' : ''}>
    </label>`;
}

function _linksEditor() {
  const links = _get('footer.links', []) || [];
  const rows = (Array.isArray(links) ? links : []).map((lk, i) => `
      <div class="adm-link-row" data-link-idx="${i}" style="display:flex;gap:6px;margin-bottom:6px">
        <input type="text" class="adm-field-input adm-link-label" value="${escHtml(lk.label || '')}" placeholder="${escHtml(t('branding.linkLabel', 'Libellé'))}" style="flex:1">
        <input type="text" class="adm-field-input adm-link-url" value="${escHtml(lk.url || '')}" placeholder="https://…" style="flex:2">
        <button class="adm-btn adm-btn-ghost adm-btn-sm adm-link-del" title="${escHtml(t('branding.removeLink', 'Retirer'))}"><i data-lucide="x"></i></button>
      </div>`).join('');
  return `<div id="branding-links">${rows}</div>
      <button class="adm-btn adm-btn-ghost adm-btn-sm" id="branding-add-link"><i data-lucide="plus"></i> ${escHtml(t('branding.addLink', 'Ajouter un lien'))}</button>`;
}

function render() {
  const root = el('branding-root');
  if (!root) return;

  root.innerHTML = `
    <div class="adm-page-head">
      <div>
        <h2 class="adm-page-title">${escHtml(t('branding.title', 'Identité & personnalisation'))}</h2>
        <p class="adm-page-sub">${escHtml(t('branding.sub', "Nom de l'instance, terminologie, SEO, pied de page et navigation — sans code."))}</p>
      </div>
      <div style="display:flex;gap:8px">
        <button class="adm-btn adm-btn-ghost adm-btn-sm" id="branding-reset"><i data-lucide="rotate-ccw"></i> ${escHtml(t('branding.reset', 'Réinitialiser'))}</button>
        <button class="adm-btn adm-btn-accent adm-btn-sm" id="branding-save" disabled><i data-lucide="save"></i> ${escHtml(t('branding.save', 'Enregistrer'))}</button>
      </div>
    </div>

    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:18px;align-items:start">
      <div class="adm-card" style="padding:18px">
        <div class="adm-card-head"><i data-lucide="badge"></i><span>${escHtml(t('branding.identity', 'Identité'))}</span></div>
        ${_textField('brand.name', t('branding.name', "Nom de l'instance"))}
        ${_textField('brand.shortName', t('branding.shortName', 'Nom court'))}
        ${_textField('brand.productName', t('branding.productName', 'Nom du produit'))}
        ${_textField('brand.monogram', t('branding.monogram', 'Monogramme (2–3 car.)'))}
        ${_textField('brand.logoEmoji', t('branding.logoEmoji', 'Emoji logo'))}
        ${_textField('brand.organization', t('branding.organization', 'Organisation'))}
        ${_textField('org.url', t('branding.orgUrl', "Lien de l'organisation"), 'https://…')}
      </div>

      <div class="adm-card" style="padding:18px">
        <div class="adm-card-head"><i data-lucide="tag"></i><span>${escHtml(t('branding.terminology', 'Terminologie'))}</span></div>
        <p class="adm-page-sub" style="margin:0 0 8px">${escHtml(t('branding.specimenHint', "Le nom de l'objet imagé (échantillon, organe, embryon…)."))}</p>
        ${_localizedField('specimen.singular', t('branding.specimenSingular', 'Singulier'))}
        ${_localizedField('specimen.plural', t('branding.specimenPlural', 'Pluriel'))}
      </div>

      <div class="adm-card" style="padding:18px">
        <div class="adm-card-head"><i data-lucide="megaphone"></i><span>${escHtml(t('branding.taglineSeo', 'Accroche & SEO'))}</span></div>
        ${_localizedField('brand.tagline', t('branding.tagline', 'Accroche'))}
        ${_localizedField('seo.description', t('branding.seoDesc', 'Description (SEO)'))}
        ${_localizedField('seo.keywords', t('branding.seoKeywords', 'Mots-clés (SEO)'))}
      </div>

      <div class="adm-card" style="padding:18px">
        <div class="adm-card-head"><i data-lucide="panel-bottom"></i><span>${escHtml(t('branding.footer', 'Pied de page'))}</span></div>
        ${_localizedField('footer.copyright', t('branding.copyright', 'Mention de copyright'))}
        <div class="adm-field-label" style="margin:10px 0 6px">${escHtml(t('branding.links', 'Liens'))}</div>
        ${_linksEditor()}
      </div>

      <div class="adm-card" style="padding:18px">
        <div class="adm-card-head"><i data-lucide="menu"></i><span>${escHtml(t('branding.nav', 'Navigation'))}</span></div>
        ${_toggle('nav.showExplorer', t('branding.navExplorer', 'Afficher « Explorer »'))}
        ${_toggle('nav.showCompare', t('branding.navCompare', 'Afficher « Comparer »'))}
        ${_toggle('nav.showTracking', t('branding.navTracking', 'Afficher « Suivi »'))}
        ${_toggle('nav.showAbout', t('branding.navAbout', 'Afficher « À propos »'))}
        ${_toggle('nav.showLegal', t('branding.navLegal', 'Afficher « Mentions légales »'))}
      </div>
    </div>`;

  // Wire inputs → mark dirty
  root.querySelectorAll('input, select').forEach((inp) => {
    inp.addEventListener('input', () => _mark(true));
    inp.addEventListener('change', () => _mark(true));
  });
  // Links add/remove
  const linksWrap = el('branding-links');
  el('branding-add-link').addEventListener('click', () => {
    const div = document.createElement('div');
    div.className = 'adm-link-row';
    div.style.cssText = 'display:flex;gap:6px;margin-bottom:6px';
    div.innerHTML = `<input type="text" class="adm-field-input adm-link-label" placeholder="${escHtml(t('branding.linkLabel', 'Libellé'))}" style="flex:1">
        <input type="text" class="adm-field-input adm-link-url" placeholder="https://…" style="flex:2">
        <button class="adm-btn adm-btn-ghost adm-btn-sm adm-link-del"><i data-lucide="x"></i></button>`;
    linksWrap.appendChild(div);
    div.querySelector('.adm-link-del').addEventListener('click', () => { div.remove(); _mark(true); });
    div.querySelectorAll('input').forEach((i) => i.addEventListener('input', () => _mark(true)));
    refreshIcons(div);
    _mark(true);
  });
  root.querySelectorAll('.adm-link-del').forEach((btn) => btn.addEventListener('click', () => { btn.closest('.adm-link-row').remove(); _mark(true); }));

  el('branding-save').addEventListener('click', save);
  el('branding-reset').addEventListener('click', reset);
  refreshIcons(root);
}

function _collect() {
  const root = el('branding-root');
  // Single-value text fields
  root.querySelectorAll('input[data-path]').forEach((inp) => _set(inp.getAttribute('data-path'), inp.value.trim()));
  // Localized fields → { code: value } (drop empties; guarantee a string if all empty)
  const locMap = {};
  root.querySelectorAll('input[data-loc-path]').forEach((inp) => {
    const p = inp.getAttribute('data-loc-path'); const code = inp.getAttribute('data-loc');
    (locMap[p] = locMap[p] || {})[code] = inp.value.trim();
  });
  Object.entries(locMap).forEach(([p, obj]) => {
    const cleaned = {}; Object.entries(obj).forEach(([c, v]) => { if (v) cleaned[c] = v; });
    _set(p, Object.keys(cleaned).length ? cleaned : '');
  });
  // Toggles
  root.querySelectorAll('input[data-toggle]').forEach((inp) => _set(inp.getAttribute('data-toggle'), inp.checked));
  // Footer links
  const links = [];
  root.querySelectorAll('.adm-link-row').forEach((row) => {
    const label = row.querySelector('.adm-link-label').value.trim();
    const url = row.querySelector('.adm-link-url').value.trim();
    if (label || url) links.push({ label, url });
  });
  _set('footer.links', links);
}

async function save() {
  _collect();
  const r = await apiFetchStatus(`${API_SITE}?action=save&doc=instance`, { method: 'POST', body: JSON.stringify(_cfg) });
  if (r.ok) {
    _mark(false);
    // Re-apply to the current admin chrome (brand emoji/monogram bindings).
    try { if (typeof InstanceConfig !== 'undefined') { await InstanceConfig.load(); InstanceConfig.applyDom(); } } catch (_) {}
    toast(t('branding.saved', 'Identité enregistrée.'), 'success');
  } else {
    toast(t('branding.saveError', "Échec de l'enregistrement."), 'error');
  }
}

async function reset() {
  if (!confirm(t('branding.resetConfirm', "Réinitialiser l'identité aux valeurs par défaut ? Le contenu métier sera retiré."))) return;
  const r = await apiFetchStatus(`${API_SITE}?action=reset&doc=instance`, { method: 'POST', body: '{}' });
  if (r.ok) {
    toast(t('branding.resetDone', 'Identité réinitialisée.'), 'success');
    await load();
  } else {
    toast(t('branding.saveError', "Échec de l'enregistrement."), 'error');
  }
}

async function load() {
  const data = await apiFetch(`${API_SITE}?action=get&doc=instance`);
  _cfg = (data && typeof data === 'object') ? data : {};
  _mark(false);
  render();
}

export const BrandingTab = {
  id: 'branding',
  titleKey: 'admin.navBranding',
  titleDefault: 'Identité',
  mounted: false,
  mount() { render(); load(); },
  activate() { load(); },
  relabel() { render(); load(); },
};
