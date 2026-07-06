/**
 * Admin SPA — Legal notice editor (white-label)
 * =============================================
 * Purely textual editor for the legal / privacy / terms sections. The layout of
 * the public legal page (legal.html) is fixed; only the section titles and bodies
 * are editable, per locale (an "editing language" selector switches which locale
 * the fields show/edit, so long legal text stays readable one language at a time).
 * Persists config/legal.json via /api/site.php.
 */

'use strict';

import { API_SITE, I18n, t, escHtml, apiFetch, apiFetchStatus, toast, el, refreshIcons } from './shared.js';
import { setUnsaved } from './bus.js';

let _legal = { sections: [] };
let _editLoc = 'en';
let _dirty = false;

function _mark(on) { _dirty = on; setUnsaved(on); const s = el('legal-save'); if (s) s.disabled = !on; }

function _locales() {
  try { if (I18n && I18n.getAvailableLanguages) { const l = I18n.getAvailableLanguages(); if (l.length) return l; } } catch (_) {}
  return [{ code: 'en', native: 'English' }, { code: 'fr', native: 'Français' }, { code: 'es', native: 'Español' }];
}

function _lv(obj, code) { return (obj && typeof obj === 'object') ? (obj[code] || '') : (typeof obj === 'string' ? obj : ''); }

function render() {
  const root = el('legal-root');
  if (!root) return;
  if (!Array.isArray(_legal.sections)) _legal.sections = [];

  const locOpts = _locales().map((l) => `<option value="${escHtml(l.code)}" ${l.code === _editLoc ? 'selected' : ''}>${escHtml(l.native || l.code)}</option>`).join('');

  const sections = _legal.sections.map((s, i) => `
    <div class="adm-card" data-sec="${i}" style="padding:16px;margin-bottom:12px">
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px">
        <input type="text" class="adm-field-input adm-sec-title" data-sec="${i}" value="${escHtml(_lv(s.title, _editLoc))}" placeholder="${escHtml(t('legal.sectionTitle', 'Titre de section'))}" style="flex:1;font-weight:600">
        <button class="adm-btn adm-btn-ghost adm-btn-sm adm-sec-del" data-sec="${i}" title="${escHtml(t('legal.removeSection', 'Supprimer'))}"><i data-lucide="trash-2"></i></button>
      </div>
      <textarea class="adm-field-input adm-sec-body" data-sec="${i}" rows="6" placeholder="${escHtml(t('legal.sectionBody', 'Texte…'))}" style="width:100%;resize:vertical;font-family:inherit">${escHtml(_lv(s.body, _editLoc))}</textarea>
    </div>`).join('');

  root.innerHTML = `
    <div class="adm-page-head">
      <div>
        <h2 class="adm-page-title">${escHtml(t('legal.title', 'Mentions légales'))}</h2>
        <p class="adm-page-sub">${escHtml(t('legal.sub', 'Texte des pages légales (mise en page fixe). Multilingue.'))}</p>
      </div>
      <div style="display:flex;gap:8px;align-items:center">
        <label style="display:flex;gap:6px;align-items:center;font-size:13px">${escHtml(t('legal.editLang', 'Langue'))}
          <select class="adm-field-input" id="legal-loc" style="width:auto">${locOpts}</select>
        </label>
        <button class="adm-btn adm-btn-ghost adm-btn-sm" id="legal-reset"><i data-lucide="rotate-ccw"></i> ${escHtml(t('legal.reset', 'Réinitialiser'))}</button>
        <button class="adm-btn adm-btn-accent adm-btn-sm" id="legal-save" disabled><i data-lucide="save"></i> ${escHtml(t('legal.save', 'Enregistrer'))}</button>
      </div>
    </div>

    <div id="legal-sections">${sections || `<p class="adm-page-sub">${escHtml(t('legal.empty', 'Aucune section. Ajoutez-en une.'))}</p>`}</div>
    <button class="adm-btn adm-btn-ghost adm-btn-sm" id="legal-add"><i data-lucide="plus"></i> ${escHtml(t('legal.addSection', 'Ajouter une section'))}</button>`;

  // Persist edits into the model for the CURRENT locale as the operator types.
  root.querySelectorAll('.adm-sec-title').forEach((inp) => inp.addEventListener('input', () => {
    const s = _legal.sections[+inp.getAttribute('data-sec')]; if (!s) return;
    if (typeof s.title !== 'object' || s.title == null) s.title = {}; s.title[_editLoc] = inp.value; _mark(true);
  }));
  root.querySelectorAll('.adm-sec-body').forEach((ta) => ta.addEventListener('input', () => {
    const s = _legal.sections[+ta.getAttribute('data-sec')]; if (!s) return;
    if (typeof s.body !== 'object' || s.body == null) s.body = {}; s.body[_editLoc] = ta.value; _mark(true);
  }));
  root.querySelectorAll('.adm-sec-del').forEach((btn) => btn.addEventListener('click', () => {
    _legal.sections.splice(+btn.getAttribute('data-sec'), 1); _mark(true); render();
  }));

  el('legal-loc').addEventListener('change', (e) => { _editLoc = e.target.value; render(); });
  el('legal-add').addEventListener('click', () => { _legal.sections.push({ title: {}, body: {} }); _mark(true); render(); });
  el('legal-save').addEventListener('click', save);
  el('legal-reset').addEventListener('click', reset);
  refreshIcons(root);
}

async function load() {
  const data = await apiFetch(`${API_SITE}?action=get&doc=legal`);
  _legal = (data && typeof data === 'object' && Array.isArray(data.sections)) ? data : { sections: [] };
  try { _editLoc = (I18n && I18n.getLanguage) ? I18n.getLanguage() : 'en'; } catch (_) { _editLoc = 'en'; }
  _mark(false);
  render();
}

async function save() {
  const r = await apiFetchStatus(`${API_SITE}?action=save&doc=legal`, { method: 'POST', body: JSON.stringify(_legal) });
  if (r.ok) { _mark(false); toast(t('legal.saved', 'Mentions légales enregistrées.'), 'success'); }
  else toast(t('legal.saveError', "Échec de l'enregistrement."), 'error');
}

async function reset() {
  if (!confirm(t('legal.resetConfirm', 'Réinitialiser les mentions légales ?'))) return;
  const r = await apiFetchStatus(`${API_SITE}?action=reset&doc=legal`, { method: 'POST', body: '{}' });
  if (r.ok) { toast(t('legal.resetDone', 'Réinitialisé.'), 'success'); await load(); }
  else toast(t('legal.saveError', "Échec de l'enregistrement."), 'error');
}

export const LegalTab = {
  id: 'legal',
  titleKey: 'admin.navLegal',
  titleDefault: 'Mentions légales',
  mounted: false,
  mount() { render(); load(); },
  activate() { load(); },
  relabel() { render(); load(); },
};
