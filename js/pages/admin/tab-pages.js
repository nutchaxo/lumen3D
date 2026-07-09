/**
 * Admin SPA — Pages (Elementor-style section/column/widget editor, white-label)
 * ============================================================================
 * A structured visual page builder for the public pages. The operator creates
 * custom pages (rendered by page.html?slug=…, auto-added to the nav) and edits
 * their layout as a tree of SECTIONS → COLUMNS → WIDGETS:
 *
 *   • Sections stack vertically (full-width or contained, background, padding).
 *   • Columns sit side-by-side inside a section on a 12-unit grid; the boundary
 *     between two columns is a drag handle that SNAPS to whole grid units.
 *   • Widgets live in columns; drag one from the palette into a column, or drag
 *     an existing widget to reorder / move it between columns.
 *
 * The center canvas is WYSIWYG — each widget is rendered with the real
 * PageRenderer and wrapped in editor chrome. The right panel shows contextual
 * settings for the current selection (widget / column / section / page). A live
 * preview iframe mirrors the draft via postMessage (LUMEN_PREVIEW_DOC). Draft /
 * Publish / Revert persist config/pages/<slug>.json through /api/site.php.
 *
 *   doc = { title:{loc}, published:{sections:[]}, draft:{sections:[]} }
 *   Section = { id, props:{bg,padY,fullWidth,maxWidth,gap,vAlign}, columns:[Column] }
 *   Column  = { id, width(1–12), props:{vAlign,padding}, widgets:[Widget] }
 *   Widget  = { id, type, text, props }   (same types as PageRenderer)
 *
 * Legacy flat { blocks:[] } docs are migrated to one contained section with a
 * single 12-unit column — so pages built with the old editor keep working.
 */

'use strict';

import { API_SITE, I18n, t, escHtml, apiFetch, apiFetchStatus, toast, el, refreshIcons } from './shared.js';
import { setUnsaved } from './bus.js';

const SPECIAL = [{ slug: 'home', builtin: true }, { slug: 'about', builtin: true }];

let _instance = {};
let _pages = [];
let _slug = null;
let _doc = { title: {}, published: { sections: [] }, draft: { sections: [] } };
let _sections = [];                 // working draft
let _sel = null;                    // { si, ci, wi } — ci/wi null = column/section scope
let _editLoc = 'en';
let _dirty = false;
let _showPreview = false;
let _dropHint = null;               // { si, ci } column currently under a drag

const _id = (p) => p + Math.random().toString(36).slice(2, 9);
function _mark(on) { _dirty = on; setUnsaved(on); const s = el('pages-save'); if (s) s.disabled = !on; }
function _locales() { try { if (I18n && I18n.getAvailableLanguages) { const l = I18n.getAvailableLanguages(); if (l.length) return l; } } catch (_) {} return [{ code: 'en', native: 'EN' }, { code: 'fr', native: 'FR' }, { code: 'es', native: 'ES' }]; }
function _lv(v) { if (v == null) return ''; if (typeof v === 'string') return v; if (typeof v === 'object') return v[_editLoc] || ''; return String(v); }
function _short(v) { const s = _lv(v).trim(); return s ? (s.length > 32 ? s.slice(0, 32) + '…' : s) : ''; }
function _changed() { _mark(true); _pushPreview(); }

// ── Widget palette / defaults ───────────────────────────────────
const PALETTE = [
  { type: 'heading', icon: 'heading', def: 'Titre' },
  { type: 'richtext', icon: 'align-left', def: 'Texte' },
  { type: 'hero', icon: 'flag', def: 'Héros' },
  { type: 'button', icon: 'square-mouse-pointer', def: 'Bouton' },
  { type: 'image', icon: 'image', def: 'Image' },
  { type: 'gallery', icon: 'images', def: 'Galerie' },
  { type: 'stat-grid', icon: 'bar-chart-2', def: 'Statistiques' },
  { type: 'latest-datasets', icon: 'layers', def: 'Derniers éléments' },
  { type: 'divider', icon: 'minus', def: 'Séparateur' },
  { type: 'spacer', icon: 'move-vertical', def: 'Espace' },
  { type: 'html', icon: 'code', def: 'HTML' },
];

function _newWidget(type) {
  const id = _id('w');
  switch (type) {
    case 'heading': return { id, type, text: {}, props: { level: '2', align: 'left' } };
    case 'richtext': return { id, type, text: {}, props: { align: 'left' } };
    case 'hero': return { id, type, text: {}, props: { subtitle: {}, bg: '', cta: { text: {}, href: '' } } };
    case 'button': return { id, type, text: {}, props: { href: '#', style: 'accent', align: 'left' } };
    case 'image': return { id, type, props: { src: '', alt: {}, align: 'center', width: '', href: '' } };
    case 'gallery': return { id, type, props: { images: [] } };
    case 'stat-grid': return { id, type, props: { stats: [{ label: {}, source: 'datasetCount', value: '' }] } };
    case 'latest-datasets': return { id, type, props: { count: 4 } };
    case 'divider': return { id, type, props: {} };
    case 'spacer': return { id, type, props: { height: 32 } };
    case 'html': return { id, type, props: { html: {} } };
    default: return { id, type, props: {} };
  }
}

// ── Section / column model ──────────────────────────────────────
const LAYOUTS = [
  { key: '12', widths: [12], label: '1' },
  { key: '6-6', widths: [6, 6], label: '2' },
  { key: '4-4-4', widths: [4, 4, 4], label: '3' },
  { key: '3-3-3-3', widths: [3, 3, 3, 3], label: '4' },
  { key: '8-4', widths: [8, 4], label: '⅔ ⅓' },
  { key: '4-8', widths: [4, 8], label: '⅓ ⅔' },
];
function _newColumn(width) { return { id: _id('c'), width: width || 12, props: {}, widgets: [] }; }
function _newSection(widths) {
  return { id: _id('s'), props: { bg: '', padY: 48, fullWidth: false, maxWidth: 1080, gap: 24, vAlign: 'stretch' }, columns: (widths || [12]).map(_newColumn) };
}

// Normalize any stored source (sections / flat blocks) into a sections array.
function _migrate(src) {
  if (!src || typeof src !== 'object') return [];
  if (Array.isArray(src.sections)) return JSON.parse(JSON.stringify(src.sections));
  if (Array.isArray(src.blocks) && src.blocks.length) {
    return [{ id: _id('s'), props: { fullWidth: false, padY: 40, maxWidth: 1080, gap: 24, vAlign: 'stretch', bg: '' },
      columns: [{ id: _id('c'), width: 12, props: {}, widgets: JSON.parse(JSON.stringify(src.blocks)) }] }];
  }
  return [];
}
function _sanitizeSections(list) {
  // Guarantee ids + shape so the editor never trips on a hand-edited/legacy doc.
  return (Array.isArray(list) ? list : []).map((s) => ({
    id: s.id || _id('s'),
    props: Object.assign({ bg: '', padY: 48, fullWidth: false, maxWidth: 1080, gap: 24, vAlign: 'stretch' }, s.props || {}),
    columns: (Array.isArray(s.columns) ? s.columns : [_newColumn(12)]).map((c) => ({
      id: c.id || _id('c'), width: Math.min(12, Math.max(1, +c.width || 12)), props: c.props || {},
      widgets: (Array.isArray(c.widgets) ? c.widgets : []).map((w) => Object.assign({ id: w.id || _id('w') }, w)),
    })),
  }));
}

// ── Path helpers for widget settings ────────────────────────────
function _get(o, path) { let v = o; for (const s of path.split('.')) { if (v != null && typeof v === 'object') v = v[s]; else return undefined; } return v; }
function _put(o, path, val) { const s = path.split('.'); let c = o; for (let i = 0; i < s.length - 1; i++) { if (typeof c[s[i]] !== 'object' || c[s[i]] == null) c[s[i]] = {}; c = c[s[i]]; } c[s[s.length - 1]] = val; }
function _selWidget() { if (!_sel || _sel.wi == null) return null; return _sections[_sel.si]?.columns[_sel.ci]?.widgets[_sel.wi] || null; }

// ── Field schema per widget type (reused from the flat editor) ──
function _fields(type) {
  const align = { k: 'props.align', t: 'select', l: t('pages.align', 'Alignement'), opts: [['left', '⯇ Gauche'], ['center', '≡ Centre'], ['right', 'Droite ⯈']] };
  switch (type) {
    case 'heading': return [{ k: 'text', t: 'ltext', l: t('pages.text', 'Texte') }, { k: 'props.level', t: 'select', l: t('pages.level', 'Niveau'), opts: [['1', 'H1'], ['2', 'H2'], ['3', 'H3'], ['4', 'H4']] }, align];
    case 'richtext': return [{ k: 'text', t: 'ltextarea', l: t('pages.text', 'Texte') }, align];
    case 'hero': return [{ k: 'text', t: 'ltext', l: t('pages.heroTitle', 'Titre') }, { k: 'props.subtitle', t: 'ltext', l: t('pages.heroSub', 'Sous-titre') }, { k: 'props.bg', t: 'color', l: t('pages.bg', 'Fond') }, { k: 'props.cta.text', t: 'ltext', l: t('pages.ctaText', 'Bouton') }, { k: 'props.cta.href', t: 'text', l: t('pages.ctaHref', 'Lien du bouton') }];
    case 'button': return [{ k: 'text', t: 'ltext', l: t('pages.label', 'Libellé') }, { k: 'props.href', t: 'text', l: t('pages.href', 'Lien') }, { k: 'props.style', t: 'select', l: t('pages.style', 'Style'), opts: [['accent', 'Accent'], ['ghost', 'Ghost'], ['lg', 'Grand']] }, align];
    case 'image': return [{ k: 'props.src', t: 'text', l: 'URL' }, { k: 'props.alt', t: 'ltext', l: t('pages.alt', 'Texte alt') }, { k: 'props.width', t: 'number', l: t('pages.width', 'Largeur (px)') }, { k: 'props.href', t: 'text', l: t('pages.linkOpt', 'Lien (option.)') }, align];
    case 'gallery': return [{ k: 'props.images', t: 'gallery', l: t('pages.images', 'Images') }];
    case 'stat-grid': return [{ k: 'props.stats', t: 'stats', l: t('pages.stats', 'Statistiques') }];
    case 'latest-datasets': return [{ k: 'props.count', t: 'number', l: t('pages.count', 'Nombre') }];
    case 'spacer': return [{ k: 'props.height', t: 'number', l: t('pages.height', 'Hauteur (px)') }];
    case 'html': return [{ k: 'props.html', t: 'ltextarea', l: 'HTML' }];
    default: return [];
  }
}

// ══════════════════════════════════════════════════════════════
// Render — toolbar + [palette | canvas | settings] + preview
// ══════════════════════════════════════════════════════════════
function render() {
  const root = el('pages-root');
  if (!root) return;

  const pageOpts = _pages.map((p) => `<option value="${escHtml(p.slug)}" ${p.slug === _slug ? 'selected' : ''}>${escHtml(p.builtin ? p.slug + ' ' + t('pages.builtin', '(intégrée)') : (p.label || p.slug))}</option>`).join('');
  const locOpts = _locales().map((l) => `<option value="${escHtml(l.code)}" ${l.code === _editLoc ? 'selected' : ''}>${escHtml(l.native || l.code)}</option>`).join('');
  const palette = PALETTE.map((b) => `<button class="adm-btn adm-btn-ghost adm-btn-sm pb-add" data-type="${b.type}" draggable="true" style="justify-content:flex-start;cursor:grab"><i data-lucide="${b.icon}"></i> ${escHtml(t('pages.block.' + b.type, b.def))}</button>`).join('');

  root.innerHTML = `
    <div class="adm-page-head">
      <div>
        <h2 class="adm-page-title">${escHtml(t('pages.title', 'Pages'))}</h2>
        <p class="adm-page-sub">${escHtml(t('pages.sub2', 'Construisez vos pages en sections, colonnes et widgets. Glissez-déposez, redimensionnez les colonnes, publiez.'))}</p>
      </div>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <select class="adm-field-input" id="pages-select" style="width:auto">${pageOpts}</select>
        <button class="adm-btn adm-btn-ghost adm-btn-sm" id="pages-new"><i data-lucide="plus"></i> ${escHtml(t('pages.new', 'Nouvelle page'))}</button>
        <button class="adm-btn adm-btn-ghost adm-btn-sm" id="pages-delete" title="${escHtml(t('pages.delete', 'Supprimer la page'))}"><i data-lucide="trash-2"></i></button>
        <label style="display:flex;gap:6px;align-items:center;font-size:13px">${escHtml(t('pages.lang', 'Langue'))}<select class="adm-field-input" id="pages-loc" style="width:auto">${locOpts}</select></label>
        <button class="adm-btn adm-btn-ghost adm-btn-sm" id="pages-preview-toggle"><i data-lucide="eye"></i> ${escHtml(t('pages.preview', 'Aperçu'))}</button>
        <button class="adm-btn adm-btn-ghost adm-btn-sm" id="pages-revert"><i data-lucide="rotate-ccw"></i> ${escHtml(t('pages.revert', 'Défaut'))}</button>
        <button class="adm-btn adm-btn-ghost adm-btn-sm" id="pages-save" disabled><i data-lucide="save"></i> ${escHtml(t('pages.saveDraft', 'Brouillon'))}</button>
        <button class="adm-btn adm-btn-accent adm-btn-sm" id="pages-publish"><i data-lucide="upload"></i> ${escHtml(t('pages.publish', 'Publier'))}</button>
      </div>
    </div>

    <div style="display:grid;grid-template-columns:186px 1fr 300px;gap:14px;align-items:start">
      <div class="adm-card" style="padding:12px;position:sticky;top:8px">
        <div class="adm-card-head" style="margin-bottom:8px"><i data-lucide="shapes"></i><span>${escHtml(t('pages.widgets', 'Widgets'))}</span></div>
        <p class="adm-page-sub" style="font-size:11px;margin:0 0 8px">${escHtml(t('pages.dragHint', 'Glissez dans une colonne'))}</p>
        <div style="display:flex;flex-direction:column;gap:5px">${palette}</div>
      </div>

      <div class="adm-card" style="padding:14px;min-height:420px">
        <div id="pages-canvas" class="pb-canvas"></div>
        <button class="adm-btn adm-btn-ghost pb-add-section" id="pb-add-section" style="width:100%;margin-top:12px;border-style:dashed"><i data-lucide="plus"></i> ${escHtml(t('pages.addSection', 'Ajouter une section'))}</button>
      </div>

      <div class="adm-card" style="padding:12px;position:sticky;top:8px">
        <div id="pages-settings"></div>
      </div>
    </div>

    <div class="adm-card" id="pb-preview-wrap" style="padding:0;overflow:hidden;margin-top:14px;display:${_showPreview ? 'block' : 'none'}">
      <div class="adm-card-head" style="padding:10px 14px"><i data-lucide="monitor-play"></i><span>${escHtml(t('pages.livePreview', 'Aperçu en direct'))}</span></div>
      <iframe id="pages-preview" title="preview" style="width:100%;height:560px;border:none;border-top:1px solid var(--border-subtle,#2a2a3a);background:#0d0d1a"></iframe>
    </div>`;

  el('pages-select').addEventListener('change', (e) => selectPage(e.target.value));
  el('pages-loc').addEventListener('change', (e) => { _editLoc = e.target.value; renderCanvas(); renderSettings(); });
  el('pages-new').addEventListener('click', newPage);
  el('pages-delete').addEventListener('click', deletePage);
  el('pages-save').addEventListener('click', saveDraft);
  el('pages-publish').addEventListener('click', publish);
  el('pages-revert').addEventListener('click', revert);
  el('pages-preview-toggle').addEventListener('click', togglePreview);
  el('pb-add-section').addEventListener('click', () => addSection());

  // Palette drag source (also click = append to the selected/last column).
  root.querySelectorAll('.pb-add').forEach((b) => {
    const type = b.getAttribute('data-type');
    b.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/plain', 'new:' + type); e.dataTransfer.effectAllowed = 'copy'; });
    b.addEventListener('click', () => addWidgetToSelection(type));
  });

  renderCanvas();
  renderSettings();
  if (_showPreview) _loadPreview();
  refreshIcons(root);
}

// ── Canvas (WYSIWYG) ────────────────────────────────────────────
function renderCanvas() {
  const canvas = el('pages-canvas');
  if (!canvas) return;
  canvas.textContent = '';
  if (!_sections.length) {
    const empty = document.createElement('p');
    empty.className = 'adm-page-sub';
    empty.style.cssText = 'text-align:center;padding:40px 0';
    empty.textContent = t('pages.emptyCanvas', 'Page vide — ajoutez une section pour commencer.');
    canvas.appendChild(empty);
    return;
  }
  _sections.forEach((sec, si) => canvas.appendChild(_sectionEl(sec, si)));
}

function _ctrlBtn(icon, title, onClick) {
  const b = document.createElement('button');
  b.className = 'adm-icon-btn';
  b.title = title;
  b.style.cssText = 'width:24px;height:24px;display:inline-flex;align-items:center;justify-content:center;padding:0';
  b.innerHTML = `<i data-lucide="${icon}" style="width:14px;height:14px"></i>`;
  b.addEventListener('click', (e) => { e.stopPropagation(); onClick(e); });
  return b;
}

function _sectionEl(sec, si) {
  const selSec = _sel && _sel.si === si && _sel.ci == null;
  const wrap = document.createElement('div');
  wrap.className = 'pb-section';
  wrap.style.cssText = `border:1px solid ${selSec ? 'var(--color-primary,#00A654)' : 'var(--border-subtle,#2a2a3a)'};border-radius:10px;margin-bottom:12px;background:var(--bg-surface,#161622)`;

  // Section header / toolbar
  const head = document.createElement('div');
  head.style.cssText = 'display:flex;align-items:center;gap:6px;padding:6px 8px;border-bottom:1px solid var(--border-subtle,#2a2a3a);cursor:pointer';
  head.addEventListener('click', () => { _sel = { si, ci: null, wi: null }; renderCanvas(); renderSettings(); });
  const label = document.createElement('span');
  label.style.cssText = 'flex:1;font-size:11px;text-transform:uppercase;letter-spacing:.04em;opacity:.6';
  label.innerHTML = `<i data-lucide="rows-3" style="width:13px;height:13px;vertical-align:-2px"></i> ${escHtml(t('pages.section', 'Section'))} ${si + 1} · ${sec.columns.length} ${escHtml(t('pages.cols', 'col.'))}`;
  head.appendChild(label);
  head.appendChild(_ctrlBtn('chevron-up', t('pages.moveUp', 'Monter'), () => moveSection(si, -1)));
  head.appendChild(_ctrlBtn('chevron-down', t('pages.moveDown', 'Descendre'), () => moveSection(si, 1)));
  head.appendChild(_ctrlBtn('columns-2', t('pages.addColumn', 'Ajouter une colonne'), () => addColumn(si)));
  head.appendChild(_ctrlBtn('copy', t('pages.duplicate', 'Dupliquer'), () => duplicateSection(si)));
  head.appendChild(_ctrlBtn('trash-2', t('pages.delete', 'Supprimer'), () => deleteSection(si)));
  wrap.appendChild(head);

  // Columns row
  const row = document.createElement('div');
  row.style.cssText = 'display:flex;align-items:stretch;padding:10px;gap:0';
  sec.columns.forEach((col, ci) => {
    if (ci > 0) row.appendChild(_resizeHandle(si, ci));
    row.appendChild(_columnEl(sec, si, col, ci));
  });
  wrap.appendChild(row);
  return wrap;
}

function _resizeHandle(si, ci) {
  // Drag boundary between column (ci-1) and column (ci); snaps to 12-grid units.
  const h = document.createElement('div');
  h.style.cssText = 'flex:0 0 10px;cursor:col-resize;display:flex;align-items:center;justify-content:center;align-self:stretch';
  h.title = t('pages.resizeCols', 'Glisser pour redimensionner (aligné sur 12 colonnes)');
  h.innerHTML = '<div style="width:3px;border-radius:2px;height:36px;background:var(--border-strong,#3a3a4a)"></div>';
  h.addEventListener('pointerdown', (e) => _startResize(e, si, ci));
  return h;
}

function _startResize(e, si, ci) {
  e.preventDefault(); e.stopPropagation();
  const sec = _sections[si];
  const left = sec.columns[ci - 1], right = sec.columns[ci];
  const row = e.target.closest('div').parentElement;   // the columns row
  const rowW = row.getBoundingClientRect().width || 1;
  const startX = e.clientX;
  const startLeft = left.width, pairTotal = left.width + right.width;
  const unitPx = rowW / 12;
  const onMove = (ev) => {
    const dxUnits = Math.round((ev.clientX - startX) / unitPx);   // SNAP to whole units
    let lw = Math.min(pairTotal - 1, Math.max(1, startLeft + dxUnits));
    left.width = lw; right.width = pairTotal - lw;
    _liveWidths(si);
  };
  const onUp = () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    _changed(); renderCanvas(); renderSettings();
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
}

// Update only the flex-basis of a section's columns during a live resize drag.
function _liveWidths(si) {
  const secEl = el('pages-canvas').children[si];
  if (!secEl) return;
  const row = secEl.querySelector(':scope > div:last-child');
  const cols = row.querySelectorAll(':scope > .pb-col');
  _sections[si].columns.forEach((c, i) => { if (cols[i]) cols[i].style.flexBasis = `calc(${(c.width / 12) * 100}% - 12px)`; });
}

function _columnEl(sec, si, col, ci) {
  const selCol = _sel && _sel.si === si && _sel.ci === ci && _sel.wi == null;
  const c = document.createElement('div');
  c.className = 'pb-col';
  c.dataset.si = si; c.dataset.ci = ci;
  const active = _dropHint && _dropHint.si === si && _dropHint.ci === ci;
  c.style.cssText = `flex:1 1 calc(${(col.width / 12) * 100}% - 12px);min-width:60px;box-sizing:border-box;margin:0 6px;` +
    `border:1px dashed ${active ? 'var(--color-primary,#00A654)' : (selCol ? 'var(--color-primary,#00A654)' : 'var(--border-subtle,#2a2a3a)')};` +
    `border-radius:8px;padding:8px;min-height:60px;background:${active ? 'color-mix(in srgb,var(--color-primary,#00A654) 12%,transparent)' : 'transparent'}`;

  // Column mini-header (width badge + select + remove)
  const ch = document.createElement('div');
  ch.style.cssText = 'display:flex;align-items:center;gap:4px;margin-bottom:6px';
  const badge = document.createElement('span');
  badge.style.cssText = 'font-size:10px;opacity:.5;flex:1';
  badge.textContent = `${col.width}/12`;
  badge.addEventListener('click', (e) => { e.stopPropagation(); _sel = { si, ci, wi: null }; renderCanvas(); renderSettings(); });
  ch.appendChild(badge);
  if (sec.columns.length > 1) ch.appendChild(_ctrlBtn('x', t('pages.removeColumn', 'Retirer la colonne'), () => removeColumn(si, ci)));
  c.appendChild(ch);

  // Widgets
  col.widgets.forEach((w, wi) => c.appendChild(_widgetEl(w, si, ci, wi)));
  if (!col.widgets.length) {
    const dz = document.createElement('div');
    dz.style.cssText = 'text-align:center;opacity:.4;font-size:12px;padding:14px 0';
    dz.textContent = t('pages.dropHere', '＋ Glissez un widget ici');
    c.appendChild(dz);
  }

  // Column as a drop target
  c.addEventListener('dragover', (e) => { e.preventDefault(); if (!_dropHint || _dropHint.si !== si || _dropHint.ci !== ci) { _dropHint = { si, ci }; _paintDrop(); } });
  c.addEventListener('dragleave', (e) => { if (!c.contains(e.relatedTarget)) { if (_dropHint && _dropHint.si === si && _dropHint.ci === ci) { _dropHint = null; _paintDrop(); } } });
  c.addEventListener('drop', (e) => { e.preventDefault(); _dropHint = null; _handleDrop(e, si, ci, col.widgets.length); });
  return c;
}

function _paintDrop() {
  document.querySelectorAll('#pages-canvas .pb-col').forEach((c) => {
    const active = _dropHint && +c.dataset.si === _dropHint.si && +c.dataset.ci === _dropHint.ci;
    c.style.background = active ? 'color-mix(in srgb,var(--color-primary,#00A654) 12%,transparent)' : 'transparent';
    c.style.borderColor = active ? 'var(--color-primary,#00A654)' : c.style.borderColor;
  });
}

function _widgetEl(w, si, ci, wi) {
  const sel = _sel && _sel.si === si && _sel.ci === ci && _sel.wi === wi;
  const box = document.createElement('div');
  box.className = 'pb-widget';
  box.draggable = true;
  box.style.cssText = `position:relative;border:1px solid ${sel ? 'var(--color-primary,#00A654)' : 'transparent'};border-radius:8px;margin-bottom:8px;padding:4px`;
  box.addEventListener('click', (e) => { e.stopPropagation(); _sel = { si, ci, wi }; renderCanvas(); renderSettings(); });
  box.addEventListener('dragstart', (e) => { e.stopPropagation(); e.dataTransfer.setData('text/plain', `move:${si}:${ci}:${wi}`); e.dataTransfer.effectAllowed = 'move'; });
  // insert-before target
  box.addEventListener('dragover', (e) => { e.preventDefault(); e.stopPropagation(); if (!_dropHint || _dropHint.si !== si || _dropHint.ci !== ci) { _dropHint = { si, ci }; _paintDrop(); } });
  box.addEventListener('drop', (e) => { e.preventDefault(); e.stopPropagation(); _dropHint = null; _handleDrop(e, si, ci, wi); });

  // Toolbar (always visible so no :hover CSS is needed)
  const bar = document.createElement('div');
  bar.style.cssText = 'position:absolute;top:2px;right:2px;display:flex;gap:2px;z-index:2;background:var(--bg-elevated,#1a1a28);border-radius:6px;padding:2px';
  bar.appendChild(_ctrlBtn('copy', t('pages.duplicate', 'Dupliquer'), () => duplicateWidget(si, ci, wi)));
  bar.appendChild(_ctrlBtn('trash-2', t('pages.delete', 'Supprimer'), () => deleteWidget(si, ci, wi)));
  box.appendChild(bar);

  const tag = document.createElement('div');
  tag.style.cssText = 'font-size:9px;text-transform:uppercase;letter-spacing:.05em;opacity:.45;margin-bottom:2px';
  tag.textContent = t('pages.block.' + w.type, w.type);
  box.appendChild(tag);

  // WYSIWYG render (inert — clicks select the box, not the inner links)
  const view = document.createElement('div');
  view.style.cssText = 'pointer-events:none';
  try {
    if (typeof PageRenderer !== 'undefined') { const n = PageRenderer.renderWidget(w); if (n) view.appendChild(n); }
  } catch (_) {}
  if (!view.childNodes.length) { view.style.cssText = 'opacity:.6;font-size:12px;padding:6px'; view.textContent = _short(w.text) || t('pages.block.' + w.type, w.type); }
  box.appendChild(view);
  return box;
}

// ── Drag/drop resolution ────────────────────────────────────────
function _handleDrop(e, si, ci, index) {
  const data = e.dataTransfer.getData('text/plain') || '';
  const col = _sections[si]?.columns[ci];
  if (!col) return;
  if (data.startsWith('new:')) {
    const w = _newWidget(data.slice(4));
    col.widgets.splice(index, 0, w);
    _sel = { si, ci, wi: index };
  } else if (data.startsWith('move:')) {
    const [, fsi, fci, fwi] = data.split(':').map((x, i) => i === 0 ? x : +x);
    const from = _sections[fsi]?.columns[fci];
    if (!from) return;
    const [w] = from.widgets.splice(fwi, 1);
    if (!w) return;
    let target = index;
    if (fsi === si && fci === ci && fwi < index) target--;   // account for the removed item
    col.widgets.splice(target, 0, w);
    _sel = { si, ci, wi: target };
  } else return;
  _changed(); renderCanvas(); renderSettings();
}

// ── Structural ops ──────────────────────────────────────────────
function addSection(widths) {
  _sections.push(_newSection(widths));
  // Select the SECTION (not a column) so its layout picker + settings are
  // immediately visible — the operator usually chooses the column layout first.
  _sel = { si: _sections.length - 1, ci: null, wi: null };
  _changed(); renderCanvas(); renderSettings();
}
function deleteSection(si) { if (!confirm(t('pages.delSectionConfirm', 'Supprimer cette section ?'))) return; _sections.splice(si, 1); _sel = null; _changed(); renderCanvas(); renderSettings(); }
function duplicateSection(si) { const clone = JSON.parse(JSON.stringify(_sections[si])); clone.id = _id('s'); clone.columns.forEach((c) => { c.id = _id('c'); c.widgets.forEach((w) => w.id = _id('w')); }); _sections.splice(si + 1, 0, clone); _changed(); renderCanvas(); }
function moveSection(si, dir) { const to = si + dir; if (to < 0 || to >= _sections.length) return; const [s] = _sections.splice(si, 1); _sections.splice(to, 0, s); _sel = { si: to, ci: null, wi: null }; _changed(); renderCanvas(); renderSettings(); }
function addColumn(si) { const sec = _sections[si]; if (sec.columns.length >= 6) { toast(t('pages.maxCols', 'Maximum 6 colonnes.'), 'warning'); return; } sec.columns.push(_newColumn(Math.max(1, Math.round(12 / (sec.columns.length + 1))))); _rebalance(sec); _changed(); renderCanvas(); }
function removeColumn(si, ci) { const sec = _sections[si]; if (sec.columns.length <= 1) return; const [dead] = sec.columns.splice(ci, 1); if (dead.widgets.length && sec.columns[0]) sec.columns[0].widgets.push(...dead.widgets); _rebalance(sec); _sel = null; _changed(); renderCanvas(); renderSettings(); }
function _rebalance(sec) { const n = sec.columns.length; const base = Math.floor(12 / n); let rem = 12 - base * n; sec.columns.forEach((c) => { c.width = base + (rem-- > 0 ? 1 : 0); }); }
function duplicateWidget(si, ci, wi) { const col = _sections[si].columns[ci]; const clone = JSON.parse(JSON.stringify(col.widgets[wi])); clone.id = _id('w'); col.widgets.splice(wi + 1, 0, clone); _changed(); renderCanvas(); }
function deleteWidget(si, ci, wi) { _sections[si].columns[ci].widgets.splice(wi, 1); _sel = null; _changed(); renderCanvas(); renderSettings(); }
function addWidgetToSelection(type) {
  let si = _sel ? _sel.si : _sections.length - 1;
  if (si < 0) { addSection(); si = 0; }
  const ci = (_sel && _sel.ci != null) ? _sel.ci : 0;
  const col = _sections[si].columns[ci] || _sections[si].columns[0];
  col.widgets.push(_newWidget(type));
  _sel = { si, ci: _sections[si].columns.indexOf(col), wi: col.widgets.length - 1 };
  _changed(); renderCanvas(); renderSettings();
}

// ══════════════════════════════════════════════════════════════
// Settings panel (contextual: widget / column / section / page)
// ══════════════════════════════════════════════════════════════
function renderSettings() {
  const host = el('pages-settings');
  if (!host) return;
  const w = _selWidget();
  if (w) return _widgetSettings(host, w);
  if (_sel && _sel.ci != null) return _columnSettings(host, _sections[_sel.si], _sel.si, _sel.ci);
  if (_sel && _sel.si != null) return _sectionSettings(host, _sections[_sel.si], _sel.si);
  return _pageSettings(host);
}

function _panelHead(title, icon) { return `<div class="adm-card-head" style="margin:0 0 10px"><i data-lucide="${icon}"></i><span>${escHtml(title)}</span></div>`; }

function _pageSettings(host) {
  const isCustom = !SPECIAL.some((s) => s.slug === _slug);
  const pg = isCustom ? (Array.isArray(_instance?.nav?.customPages) ? _instance.nav.customPages.find((p) => p.slug === _slug) : null) : null;
  host.innerHTML = _panelHead(t('pages.pageSettings', 'Page'), 'file') +
    `<label class="adm-field"><span class="adm-field-label">${escHtml(t('pages.pageTitle', 'Titre de la page'))} (${escHtml(_editLoc)})</span><input type="text" class="adm-field-input" id="pb-page-title" value="${escHtml(_lv(_doc.title))}"></label>` +
    (isCustom
      ? `<label class="adm-field" style="flex-direction:row;justify-content:space-between;align-items:center"><span class="adm-field-label" style="margin:0">${escHtml(t('pages.showInMenu', 'Visible dans le menu'))}</span><input type="checkbox" id="pb-page-show" ${(!pg || pg.show !== false) ? 'checked' : ''}></label>`
      : `<p class="adm-page-sub" style="font-size:12px">${escHtml(t('pages.builtinNavHint', 'La visibilité des pages intégrées se règle dans l\'onglet Identité (Navigation).'))}</p>`) +
    `<p class="adm-page-sub" style="font-size:12px;margin-top:10px">${escHtml(t('pages.selectHint', 'Cliquez une section, une colonne ou un widget pour l\'éditer.'))}</p>`;
  el('pb-page-title').addEventListener('input', (e) => { if (typeof _doc.title !== 'object' || !_doc.title) _doc.title = {}; _doc.title[_editLoc] = e.target.value; _mark(true); });
  el('pb-page-show')?.addEventListener('change', (e) => _setPageVisibility(_slug, e.target.checked));
  refreshIcons(host);
}

async function _setPageVisibility(slug, show) {
  const pg = (_instance.nav && Array.isArray(_instance.nav.customPages)) ? _instance.nav.customPages.find((p) => p.slug === slug) : null;
  if (!pg) return;
  pg.show = show;
  const r = await apiFetchStatus(`${API_SITE}?action=save&doc=instance`, { method: 'POST', body: JSON.stringify(_instance) });
  if (r.ok) {
    try { if (typeof InstanceConfig !== 'undefined') await InstanceConfig.load(); } catch (_) {}
    toast(show ? t('pages.pageShown', 'Page affichée dans le menu.') : t('pages.pageHidden', 'Page masquée du menu.'), 'success');
  } else toast(t('pages.saveError', "Échec de l'enregistrement."), 'error');
}

function _sectionSettings(host, sec, si) {
  const p = sec.props;
  host.innerHTML = _panelHead(`${t('pages.section', 'Section')} ${si + 1}`, 'rows-3') + `
    <label class="adm-field"><span class="adm-field-label">${escHtml(t('pages.layout', 'Disposition'))}</span>
      <div style="display:flex;gap:5px;flex-wrap:wrap">${LAYOUTS.map((L) => `<button class="adm-btn adm-btn-ghost adm-btn-sm pb-layout" data-w="${L.widths.join('-')}" title="${L.widths.join(' / ')}">${escHtml(L.label)}</button>`).join('')}</div></label>
    <label class="adm-field" style="flex-direction:row;justify-content:space-between;align-items:center"><span class="adm-field-label" style="margin:0">${escHtml(t('pages.fullWidth', 'Pleine largeur'))}</span><input type="checkbox" id="pb-fw" ${p.fullWidth ? 'checked' : ''}></label>
    <label class="adm-field"><span class="adm-field-label">${escHtml(t('pages.maxWidth', 'Largeur max (px)'))}</span><input type="number" class="adm-field-input" id="pb-mw" value="${escHtml(String(p.maxWidth || 1080))}" ${p.fullWidth ? 'disabled' : ''}></label>
    <label class="adm-field"><span class="adm-field-label">${escHtml(t('pages.padY', 'Marge verticale (px)'))}</span><input type="number" class="adm-field-input" id="pb-py" value="${escHtml(String(p.padY ?? 48))}"></label>
    <label class="adm-field"><span class="adm-field-label">${escHtml(t('pages.gap', 'Espace entre colonnes (px)'))}</span><input type="number" class="adm-field-input" id="pb-gap" value="${escHtml(String(p.gap ?? 24))}"></label>
    <label class="adm-field"><span class="adm-field-label">${escHtml(t('pages.vAlign', 'Alignement vertical'))}</span><select class="adm-field-input" id="pb-va">${[['stretch', '↕'], ['start', '↑'], ['center', '↔'], ['end', '↓']].map(([v, l]) => `<option value="${v}" ${p.vAlign === v ? 'selected' : ''}>${l} ${v}</option>`).join('')}</select></label>
    <label class="adm-field"><span class="adm-field-label">${escHtml(t('pages.bg', 'Fond (CSS)'))}</span><input type="text" class="adm-field-input" id="pb-bg" value="${escHtml(p.bg || '')}" placeholder="#111 / linear-gradient(…)"></label>
    <div style="display:flex;gap:6px;margin-top:10px">
      <button class="adm-btn adm-btn-ghost adm-btn-sm" id="pb-sec-dup"><i data-lucide="copy"></i> ${escHtml(t('pages.duplicate', 'Dupliquer'))}</button>
      <button class="adm-btn adm-btn-ghost adm-btn-sm" id="pb-sec-del"><i data-lucide="trash-2"></i> ${escHtml(t('pages.delete', 'Supprimer'))}</button>
    </div>`;
  const upd = (fn) => { fn(); _changed(); renderCanvas(); };
  host.querySelectorAll('.pb-layout').forEach((b) => b.addEventListener('click', () => {
    const widths = b.getAttribute('data-w').split('-').map(Number);
    upd(() => { const old = sec.columns; sec.columns = widths.map((wd, i) => old[i] ? Object.assign(old[i], { width: wd }) : _newColumn(wd)); if (old.length > widths.length) { const extra = old.slice(widths.length).flatMap((c) => c.widgets); sec.columns[sec.columns.length - 1].widgets.push(...extra); } });
    renderSettings();
  }));
  el('pb-fw').addEventListener('change', (e) => { upd(() => p.fullWidth = e.target.checked); renderSettings(); });
  el('pb-mw').addEventListener('input', (e) => upd(() => p.maxWidth = +e.target.value || 1080));
  el('pb-py').addEventListener('input', (e) => upd(() => p.padY = Math.max(0, +e.target.value || 0)));
  el('pb-gap').addEventListener('input', (e) => upd(() => p.gap = Math.max(0, +e.target.value || 0)));
  el('pb-va').addEventListener('change', (e) => upd(() => p.vAlign = e.target.value));
  el('pb-bg').addEventListener('input', (e) => upd(() => p.bg = e.target.value));
  el('pb-sec-dup').addEventListener('click', () => duplicateSection(si));
  el('pb-sec-del').addEventListener('click', () => deleteSection(si));
  refreshIcons(host);
}

function _columnSettings(host, sec, si, ci) {
  const col = sec.columns[ci];
  host.innerHTML = _panelHead(`${t('pages.column', 'Colonne')} ${ci + 1} · ${col.width}/12`, 'columns-2') + `
    <label class="adm-field"><span class="adm-field-label">${escHtml(t('pages.colWidth', 'Largeur (unités /12)'))}</span><input type="range" min="1" max="12" step="1" id="pb-cw" value="${col.width}"><span class="adm-page-sub" id="pb-cw-val">${col.width}/12</span></label>
    <label class="adm-field"><span class="adm-field-label">${escHtml(t('pages.vAlign', 'Alignement vertical'))}</span><select class="adm-field-input" id="pb-cva">${[['', '—'], ['flex-start', '↑'], ['center', '↔'], ['flex-end', '↓']].map(([v, l]) => `<option value="${v}" ${(col.props?.vAlign || '') === v ? 'selected' : ''}>${l} ${v || 'auto'}</option>`).join('')}</select></label>
    <label class="adm-field"><span class="adm-field-label">${escHtml(t('pages.colPad', 'Padding interne (px)'))}</span><input type="number" class="adm-field-input" id="pb-cpad" value="${escHtml(String(col.props?.padding || 0))}"></label>
    <div style="display:flex;gap:6px;margin-top:10px">
      <button class="adm-btn adm-btn-ghost adm-btn-sm" id="pb-col-add"><i data-lucide="plus"></i> ${escHtml(t('pages.addColumn', 'Colonne'))}</button>
      ${sec.columns.length > 1 ? `<button class="adm-btn adm-btn-ghost adm-btn-sm" id="pb-col-del"><i data-lucide="trash-2"></i> ${escHtml(t('pages.removeColumn', 'Retirer'))}</button>` : ''}
    </div>`;
  el('pb-cw').addEventListener('input', (e) => {
    // adjust this column, compensate the next (or previous) so the row still fits ~12
    const nv = +e.target.value; const other = sec.columns[ci + 1] || sec.columns[ci - 1];
    if (other) { const total = col.width + other.width; other.width = Math.max(1, total - nv); }
    col.width = nv; el('pb-cw-val').textContent = nv + '/12'; _changed(); renderCanvas();
  });
  el('pb-cva').addEventListener('change', (e) => { col.props = col.props || {}; col.props.vAlign = e.target.value; _changed(); });
  el('pb-cpad').addEventListener('input', (e) => { col.props = col.props || {}; col.props.padding = Math.max(0, +e.target.value || 0); _changed(); renderCanvas(); });
  el('pb-col-add').addEventListener('click', () => addColumn(si));
  el('pb-col-del')?.addEventListener('click', () => removeColumn(si, ci));
  refreshIcons(host);
}

function _widgetSettings(host, b) {
  const fields = _fields(b.type);
  host.innerHTML = _panelHead(t('pages.block.' + b.type, b.type), 'settings-2') +
    (fields.map((f) => _fieldHtml(b, f)).join('') || `<p class="adm-page-sub">${escHtml(t('pages.noSettings', 'Pas de réglages.'))}</p>`);
  _wireFields(host, b, fields);
  refreshIcons(host);
}

function _fieldHtml(b, f) {
  const val = _get(b, f.k);
  if (f.t === 'ltext') return `<label class="adm-field"><span class="adm-field-label">${escHtml(f.l)}</span><input type="text" class="adm-field-input" data-f="${escHtml(f.k)}" data-lt="1" value="${escHtml(_lv(val))}"></label>`;
  if (f.t === 'ltextarea') return `<label class="adm-field"><span class="adm-field-label">${escHtml(f.l)}</span><textarea class="adm-field-input" data-f="${escHtml(f.k)}" data-lt="1" rows="4" style="resize:vertical">${escHtml(_lv(val))}</textarea></label>`;
  if (f.t === 'select') return `<label class="adm-field"><span class="adm-field-label">${escHtml(f.l)}</span><select class="adm-field-input" data-f="${escHtml(f.k)}">${f.opts.map(([v, lab]) => `<option value="${escHtml(v)}" ${String(val) === v ? 'selected' : ''}>${escHtml(lab)}</option>`).join('')}</select></label>`;
  if (f.t === 'color') return `<label class="adm-field" style="flex-direction:row;justify-content:space-between;align-items:center"><span class="adm-field-label" style="margin:0">${escHtml(f.l)}</span><input type="text" class="adm-field-input" data-f="${escHtml(f.k)}" value="${escHtml(typeof val === 'string' ? val : '')}" placeholder="#… / transparent" style="width:150px"></label>`;
  if (f.t === 'number') return `<label class="adm-field"><span class="adm-field-label">${escHtml(f.l)}</span><input type="number" class="adm-field-input" data-f="${escHtml(f.k)}" value="${escHtml(val != null ? String(val) : '')}"></label>`;
  if (f.t === 'gallery') return `<div class="adm-field"><span class="adm-field-label">${escHtml(f.l)}</span><div id="pages-gallery"></div><button class="adm-btn adm-btn-ghost adm-btn-sm" id="pages-gallery-add"><i data-lucide="plus"></i> ${escHtml(t('pages.addImage', 'Image'))}</button></div>`;
  if (f.t === 'stats') return `<div class="adm-field"><span class="adm-field-label">${escHtml(f.l)}</span><div id="pages-stats"></div><button class="adm-btn adm-btn-ghost adm-btn-sm" id="pages-stats-add"><i data-lucide="plus"></i> ${escHtml(t('pages.addStat', 'Stat'))}</button></div>`;
  return `<label class="adm-field"><span class="adm-field-label">${escHtml(f.l)}</span><input type="text" class="adm-field-input" data-f="${escHtml(f.k)}" value="${escHtml(typeof val === 'string' ? val : (val != null ? String(val) : ''))}"></label>`;
}

function _wireFields(host, b, _fields2) {
  const redraw = () => { renderCanvas(); };
  host.querySelectorAll('[data-f]').forEach((inp) => {
    inp.addEventListener('input', () => {
      const path = inp.getAttribute('data-f');
      if (inp.getAttribute('data-lt')) { let obj = _get(b, path); if (typeof obj !== 'object' || obj == null) { obj = {}; _put(b, path, obj); } obj[_editLoc] = inp.value; }
      else _put(b, path, inp.value);
      _changed(); redraw();
    });
  });
  const gwrap = host.querySelector('#pages-gallery');
  if (gwrap) {
    const imgs = (b.props.images = Array.isArray(b.props.images) ? b.props.images : []);
    const draw = () => {
      gwrap.innerHTML = imgs.map((im, i) => `<div style="display:flex;gap:6px;margin-bottom:5px"><input type="text" class="adm-field-input g-src" data-i="${i}" value="${escHtml(im.src || '')}" placeholder="URL" style="flex:1"><button class="adm-icon-btn g-del" data-i="${i}">✕</button></div>`).join('');
      gwrap.querySelectorAll('.g-src').forEach((s) => s.addEventListener('input', () => { imgs[+s.getAttribute('data-i')].src = s.value; _changed(); renderCanvas(); }));
      gwrap.querySelectorAll('.g-del').forEach((d) => d.addEventListener('click', () => { imgs.splice(+d.getAttribute('data-i'), 1); _changed(); draw(); renderCanvas(); }));
    };
    draw();
    host.querySelector('#pages-gallery-add').addEventListener('click', () => { imgs.push({ src: '', alt: {} }); _changed(); draw(); renderCanvas(); });
  }
  const swrap = host.querySelector('#pages-stats');
  if (swrap) {
    const stats = (b.props.stats = Array.isArray(b.props.stats) ? b.props.stats : []);
    const draw = () => {
      swrap.innerHTML = stats.map((st, i) => `<div style="display:flex;gap:6px;margin-bottom:5px;align-items:center">
          <input type="text" class="adm-field-input s-label" data-i="${i}" value="${escHtml(_lv(st.label))}" placeholder="${escHtml(t('pages.statLabel', 'Libellé'))}" style="flex:1">
          <select class="adm-field-input s-src" data-i="${i}" style="width:auto"><option value="datasetCount" ${st.source === 'datasetCount' ? 'selected' : ''}>#</option><option value="custom" ${st.source !== 'datasetCount' ? 'selected' : ''}>${escHtml(t('pages.custom', 'Fixe'))}</option></select>
          <input type="text" class="adm-field-input s-val" data-i="${i}" value="${escHtml(st.value != null ? String(st.value) : '')}" placeholder="123" style="width:60px" ${st.source === 'datasetCount' ? 'disabled' : ''}>
          <button class="adm-icon-btn s-del" data-i="${i}">✕</button></div>`).join('');
      swrap.querySelectorAll('.s-label').forEach((s) => s.addEventListener('input', () => { const st = stats[+s.getAttribute('data-i')]; if (typeof st.label !== 'object' || st.label == null) st.label = {}; st.label[_editLoc] = s.value; _changed(); renderCanvas(); }));
      swrap.querySelectorAll('.s-src').forEach((s) => s.addEventListener('change', () => { stats[+s.getAttribute('data-i')].source = s.value; _changed(); draw(); renderCanvas(); }));
      swrap.querySelectorAll('.s-val').forEach((s) => s.addEventListener('input', () => { stats[+s.getAttribute('data-i')].value = s.value; _changed(); renderCanvas(); }));
      swrap.querySelectorAll('.s-del').forEach((d) => d.addEventListener('click', () => { stats.splice(+d.getAttribute('data-i'), 1); _changed(); draw(); renderCanvas(); }));
    };
    draw();
    host.querySelector('#pages-stats-add').addEventListener('click', () => { stats.push({ label: {}, source: 'custom', value: '' }); _changed(); draw(); renderCanvas(); });
  }
}

// ── Preview ─────────────────────────────────────────────────────
function togglePreview() { _showPreview = !_showPreview; const w = el('pb-preview-wrap'); if (w) w.style.display = _showPreview ? 'block' : 'none'; if (_showPreview) _loadPreview(); }
function _previewUrl() {
  if (_slug === 'home') return 'index.html?preview=draft';
  if (_slug === 'about') return 'about.html?preview=draft';
  return `page.html?slug=${encodeURIComponent(_slug || 'home')}&preview=draft`;
}
function _loadPreview() { const f = el('pages-preview'); if (!f) return; if (f.src.indexOf(_previewUrl()) < 0) f.src = _previewUrl(); f.onload = () => _pushPreview(); _pushPreview(); }
function _pushPreview() { if (!_showPreview) return; const f = el('pages-preview'); try { f.contentWindow.postMessage({ type: 'LUMEN_PREVIEW_DOC', source: { sections: _sections } }, '*'); } catch (_) {} }

// ── Page management + persistence ───────────────────────────────
function _buildPageList() {
  const custom = (Array.isArray(_instance?.nav?.customPages) ? _instance.nav.customPages : []).map((p) => ({ slug: p.slug, label: (p.label && (p.label[_editLoc] || p.label.en)) || p.slug, builtin: false }));
  _pages = [...SPECIAL.map((s) => ({ slug: s.slug, builtin: true })), ...custom];
}

async function selectPage(slug) {
  _slug = slug;
  const data = await apiFetch(`${API_SITE}?action=get&doc=pages/${encodeURIComponent(slug)}`);
  _doc = (data && typeof data === 'object') ? data : { title: {}, published: { sections: [] }, draft: { sections: [] } };
  const src = (_doc.draft && (Array.isArray(_doc.draft.sections) || Array.isArray(_doc.draft.blocks))) ? _doc.draft : (_doc.published || {});
  _sections = _sanitizeSections(_migrate(src));
  _sel = null;
  _mark(false);
  render();
}

async function newPage() {
  const raw = prompt(t('pages.newPrompt', "Identifiant de la page (lettres, chiffres, tirets) :"));
  if (!raw) return;
  const slug = raw.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(slug)) { toast(t('pages.badSlug', 'Identifiant invalide.'), 'error'); return; }
  if (_pages.some((p) => p.slug === slug)) { toast(t('pages.dupSlug', 'Cette page existe déjà.'), 'error'); return; }
  const label = prompt(t('pages.newLabel', 'Libellé dans le menu :'), slug) || slug;
  await apiFetchStatus(`${API_SITE}?action=save&doc=pages/${encodeURIComponent(slug)}`, { method: 'POST', body: JSON.stringify({ title: { [_editLoc]: label }, published: { sections: [] }, draft: { sections: [] } }) });
  _instance.nav = _instance.nav || {};
  _instance.nav.customPages = Array.isArray(_instance.nav.customPages) ? _instance.nav.customPages : [];
  _instance.nav.customPages.push({ slug, label: { [_editLoc]: label }, show: true });
  await apiFetchStatus(`${API_SITE}?action=save&doc=instance`, { method: 'POST', body: JSON.stringify(_instance) });
  try { if (typeof InstanceConfig !== 'undefined') await InstanceConfig.load(); } catch (_) {}
  _buildPageList();
  toast(t('pages.created', 'Page créée.'), 'success');
  await selectPage(slug);
}

async function deletePage() {
  const page = _pages.find((p) => p.slug === _slug);
  if (!page || page.builtin) { toast(t('pages.cantDeleteBuiltin', 'Les pages intégrées ne peuvent pas être supprimées (réinitialisez-les).'), 'warning'); return; }
  if (!confirm(t('pages.deleteConfirm', 'Supprimer cette page ?'))) return;
  await apiFetchStatus(`${API_SITE}?action=reset&doc=pages/${encodeURIComponent(_slug)}`, { method: 'POST', body: '{}' });
  _instance.nav.customPages = (_instance.nav.customPages || []).filter((p) => p.slug !== _slug);
  await apiFetchStatus(`${API_SITE}?action=save&doc=instance`, { method: 'POST', body: JSON.stringify(_instance) });
  try { if (typeof InstanceConfig !== 'undefined') await InstanceConfig.load(); } catch (_) {}
  _buildPageList();
  toast(t('pages.deleted', 'Page supprimée.'), 'success');
  await selectPage('home');
}

async function saveDraft() {
  _doc.draft = { sections: _sections };
  _doc.published = _doc.published || { sections: [] };
  const r = await apiFetchStatus(`${API_SITE}?action=save&doc=pages/${encodeURIComponent(_slug)}`, { method: 'POST', body: JSON.stringify(_doc) });
  if (r.ok) { _mark(false); toast(t('pages.draftSaved', 'Brouillon enregistré.'), 'success'); }
  else toast(t('pages.saveError', "Échec de l'enregistrement."), 'error');
}

async function publish() {
  _doc.draft = { sections: _sections };
  const s = await apiFetchStatus(`${API_SITE}?action=save&doc=pages/${encodeURIComponent(_slug)}`, { method: 'POST', body: JSON.stringify(_doc) });
  if (!s.ok) { toast(t('pages.saveError', "Échec de l'enregistrement."), 'error'); return; }
  const r = await apiFetchStatus(`${API_SITE}?action=publish&doc=pages/${encodeURIComponent(_slug)}`, { method: 'POST', body: '{}' });
  if (r.ok) { _mark(false); _doc.published = { sections: JSON.parse(JSON.stringify(_sections)) }; toast(t('pages.published', 'Page publiée ✓'), 'success'); }
  else toast(t('pages.saveError', "Échec de l'enregistrement."), 'error');
}

async function revert() {
  if (!confirm(t('pages.revertConfirm', 'Réinitialiser cette page à son état par défaut ?'))) return;
  const r = await apiFetchStatus(`${API_SITE}?action=reset&doc=pages/${encodeURIComponent(_slug)}`, { method: 'POST', body: '{}' });
  if (r.ok) { toast(t('pages.reverted', 'Réinitialisée.'), 'success'); await selectPage(_slug); }
  else toast(t('pages.saveError', "Échec de l'enregistrement."), 'error');
}

async function load() {
  const inst = await apiFetch(`${API_SITE}?action=get&doc=instance`);
  _instance = (inst && typeof inst === 'object') ? inst : {};
  try { _editLoc = (I18n && I18n.getLanguage) ? I18n.getLanguage() : 'en'; } catch (_) { _editLoc = 'en'; }
  _buildPageList();
  await selectPage(_slug || 'home');
}

export const PagesTab = {
  id: 'pages',
  titleKey: 'admin.navPages',
  titleDefault: 'Pages',
  mounted: false,
  mount() { load(); },
  activate() { load(); },
  relabel() { render(); },
};
