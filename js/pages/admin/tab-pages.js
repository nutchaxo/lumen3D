/**
 * Admin SPA — Pages (block page builder, white-label)
 * ===================================================
 * Elementor-style block editor for the public pages. The operator creates
 * custom pages (rendered by page.html?slug=…, auto-added to the nav), and edits
 * their block layout: add from a palette, drag/▲▼ to reorder, edit per-block
 * settings (localized text one language at a time), with a LIVE preview iframe
 * (draft blocks are pushed to the iframe via postMessage — no disk round-trip).
 * Draft / Publish / Revert. Persists config/pages/<slug>.json via /api/site.php.
 *
 * A page doc = { title:{loc}, published:{blocks:[]}, draft:{blocks:[]} }.
 * Custom pages are also listed in config/instance.json nav.customPages so they
 * appear in the public navbar (InstanceConfig.applyNav).
 */

'use strict';

import { API_SITE, I18n, t, escHtml, apiFetch, apiFetchStatus, toast, el, refreshIcons } from './shared.js';
import { setUnsaved } from './bus.js';

// Special always-available pages (their block layout overrides the built-in one
// when published), plus operator-created custom pages loaded from instance config.
const SPECIAL = [{ slug: 'home', builtin: true }, { slug: 'about', builtin: true }];

let _instance = {};
let _pages = [];            // [{slug, label, builtin}]
let _slug = null;
let _doc = { title: {}, published: { blocks: [] }, draft: { blocks: [] } };
let _blocks = [];           // working draft blocks
let _sel = -1;              // selected block index
let _editLoc = 'en';
let _dirty = false;

function _mark(on) { _dirty = on; setUnsaved(on); const s = el('pages-save'); if (s) s.disabled = !on; const p = el('pages-publish'); if (p) p.disabled = false; }
function _locales() { try { if (I18n && I18n.getAvailableLanguages) { const l = I18n.getAvailableLanguages(); if (l.length) return l; } } catch (_) {} return [{ code: 'en', native: 'EN' }, { code: 'fr', native: 'FR' }, { code: 'es', native: 'ES' }]; }
function _lv(v) { if (v == null) return ''; if (typeof v === 'string') return v; if (typeof v === 'object') return v[_editLoc] || ''; return String(v); }
function _short(v) { const s = _lv(v).trim(); return s ? (s.length > 40 ? s.slice(0, 40) + '…' : s) : ''; }

// ── Block palette / defaults ────────────────────────────────────
const PALETTE = [
  { type: 'heading', icon: 'heading', def: 'Titre' },
  { type: 'richtext', icon: 'align-left', def: 'Texte' },
  { type: 'hero', icon: 'flag', def: 'Héros' },
  { type: 'button', icon: 'square-mouse-pointer', def: 'Bouton' },
  { type: 'image', icon: 'image', def: 'Image' },
  { type: 'gallery', icon: 'images', def: 'Galerie' },
  { type: 'stat-grid', icon: 'bar-chart-2', def: 'Statistiques' },
  { type: 'latest-datasets', icon: 'layers', def: 'Derniers datasets' },
  { type: 'divider', icon: 'minus', def: 'Séparateur' },
  { type: 'spacer', icon: 'move-vertical', def: 'Espace' },
  { type: 'html', icon: 'code', def: 'HTML' },
];

function _newBlock(type) {
  const id = 'b' + Math.random().toString(36).slice(2, 9);
  switch (type) {
    case 'heading': return { id, type, text: {}, props: { level: '2', align: 'left' } };
    case 'richtext': return { id, type, text: {}, props: { align: 'left' } };
    case 'hero': return { id, type, text: {}, props: { subtitle: {}, cta: { text: {}, href: '' } } };
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

// ── Field schema per block type ─────────────────────────────────
function _fields(type) {
  const align = { k: 'props.align', t: 'select', l: t('pages.align', 'Alignement'), opts: [['left', '⯇'], ['center', '≡'], ['right', '⯈']] };
  switch (type) {
    case 'heading': return [{ k: 'text', t: 'ltext', l: t('pages.text', 'Texte') }, { k: 'props.level', t: 'select', l: t('pages.level', 'Niveau'), opts: [['1', 'H1'], ['2', 'H2'], ['3', 'H3']] }, align];
    case 'richtext': return [{ k: 'text', t: 'ltextarea', l: t('pages.text', 'Texte') }, align];
    case 'hero': return [{ k: 'text', t: 'ltext', l: t('pages.heroTitle', 'Titre') }, { k: 'props.subtitle', t: 'ltext', l: t('pages.heroSub', 'Sous-titre') }, { k: 'props.bg', t: 'color', l: t('pages.bg', 'Fond') }, { k: 'props.cta.text', t: 'ltext', l: t('pages.ctaText', 'Bouton') }, { k: 'props.cta.href', t: 'text', l: t('pages.ctaHref', 'Lien du bouton') }];
    case 'button': return [{ k: 'text', t: 'ltext', l: t('pages.label', 'Libellé') }, { k: 'props.href', t: 'text', l: t('pages.href', 'Lien') }, { k: 'props.style', t: 'select', l: t('pages.style', 'Style'), opts: [['accent', 'Accent'], ['ghost', 'Ghost']] }, align];
    case 'image': return [{ k: 'props.src', t: 'text', l: 'URL' }, { k: 'props.alt', t: 'ltext', l: t('pages.alt', 'Texte alt') }, { k: 'props.width', t: 'number', l: t('pages.width', 'Largeur (px)') }, { k: 'props.href', t: 'text', l: t('pages.linkOpt', 'Lien (option.)') }, align];
    case 'gallery': return [{ k: 'props.images', t: 'gallery', l: t('pages.images', 'Images') }];
    case 'stat-grid': return [{ k: 'props.stats', t: 'stats', l: t('pages.stats', 'Statistiques') }];
    case 'latest-datasets': return [{ k: 'props.count', t: 'number', l: t('pages.count', 'Nombre') }];
    case 'spacer': return [{ k: 'props.height', t: 'number', l: t('pages.height', 'Hauteur (px)') }];
    case 'html': return [{ k: 'props.html', t: 'ltextarea', l: 'HTML' }];
    default: return [];
  }
}

function _get(o, path) { let v = o; for (const s of path.split('.')) { if (v != null && typeof v === 'object') v = v[s]; else return undefined; } return v; }
function _put(o, path, val) { const s = path.split('.'); let c = o; for (let i = 0; i < s.length - 1; i++) { if (typeof c[s[i]] !== 'object' || c[s[i]] == null) c[s[i]] = {}; c = c[s[i]]; } c[s[s.length - 1]] = val; }

// ── Rendering ───────────────────────────────────────────────────
function render() {
  const root = el('pages-root');
  if (!root) return;

  const pageOpts = _pages.map((p) => `<option value="${escHtml(p.slug)}" ${p.slug === _slug ? 'selected' : ''}>${escHtml(p.builtin ? p.slug + ' ' + t('pages.builtin', '(intégrée)') : (p.label || p.slug))}</option>`).join('');
  const locOpts = _locales().map((l) => `<option value="${escHtml(l.code)}" ${l.code === _editLoc ? 'selected' : ''}>${escHtml(l.native || l.code)}</option>`).join('');
  const palette = PALETTE.map((b) => `<button class="adm-btn adm-btn-ghost adm-btn-sm pages-add" data-type="${b.type}" style="justify-content:flex-start"><i data-lucide="${b.icon}"></i> ${escHtml(t('pages.block.' + b.type, b.def))}</button>`).join('');

  const list = _blocks.map((b, i) => `
    <div class="pages-block-item ${i === _sel ? 'sel' : ''}" data-idx="${i}" draggable="true"
         style="display:flex;align-items:center;gap:6px;padding:8px 10px;border:1px solid ${i === _sel ? 'var(--color-primary,#00A654)' : 'var(--border-subtle,#2a2a3a)'};border-radius:8px;margin-bottom:6px;cursor:pointer;background:var(--bg-surface,#161622)">
      <i data-lucide="grip-vertical" style="opacity:.4;cursor:grab"></i>
      <span style="flex:1;min-width:0"><b style="font-size:12px;text-transform:uppercase;opacity:.6">${escHtml(t('pages.block.' + b.type, b.type))}</b>
        <span style="opacity:.8"> ${escHtml(_short(b.text) || _short(b.props?.subtitle) || '')}</span></span>
      <button class="adm-icon-btn pages-up" data-idx="${i}" title="↑">▲</button>
      <button class="adm-icon-btn pages-down" data-idx="${i}" title="↓">▼</button>
      <button class="adm-icon-btn pages-del" data-idx="${i}" title="✕">✕</button>
    </div>`).join('') || `<p class="adm-page-sub">${escHtml(t('pages.noBlocks', 'Aucun bloc. Ajoutez-en depuis la palette.'))}</p>`;

  root.innerHTML = `
    <div class="adm-page-head">
      <div>
        <h2 class="adm-page-title">${escHtml(t('pages.title', 'Pages'))}</h2>
        <p class="adm-page-sub">${escHtml(t('pages.sub', "Construisez les pages publiques par blocs. Aperçu en direct, brouillon puis publication."))}</p>
      </div>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <select class="adm-field-input" id="pages-select" style="width:auto">${pageOpts}</select>
        <button class="adm-btn adm-btn-ghost adm-btn-sm" id="pages-new"><i data-lucide="plus"></i> ${escHtml(t('pages.new', 'Nouvelle page'))}</button>
        <button class="adm-btn adm-btn-ghost adm-btn-sm" id="pages-delete"><i data-lucide="trash-2"></i></button>
        <label style="display:flex;gap:6px;align-items:center;font-size:13px">${escHtml(t('pages.lang', 'Langue'))}<select class="adm-field-input" id="pages-loc" style="width:auto">${locOpts}</select></label>
        <button class="adm-btn adm-btn-ghost adm-btn-sm" id="pages-revert"><i data-lucide="rotate-ccw"></i> ${escHtml(t('pages.revert', 'Défaut'))}</button>
        <button class="adm-btn adm-btn-ghost adm-btn-sm" id="pages-save" disabled><i data-lucide="save"></i> ${escHtml(t('pages.saveDraft', 'Brouillon'))}</button>
        <button class="adm-btn adm-btn-accent adm-btn-sm" id="pages-publish"><i data-lucide="upload"></i> ${escHtml(t('pages.publish', 'Publier'))}</button>
      </div>
    </div>

    <div style="display:grid;grid-template-columns:180px 260px 1fr;gap:14px;align-items:start">
      <div class="adm-card" style="padding:12px">
        <div class="adm-card-head" style="margin-bottom:8px"><i data-lucide="shapes"></i><span>${escHtml(t('pages.palette', 'Blocs'))}</span></div>
        <div style="display:flex;flex-direction:column;gap:5px">${palette}</div>
      </div>
      <div class="adm-card" style="padding:12px">
        <div class="adm-card-head" style="margin-bottom:8px"><i data-lucide="list"></i><span>${escHtml(t('pages.layout', 'Disposition'))}</span></div>
        <div id="pages-list">${list}</div>
        <div id="pages-settings" style="margin-top:12px"></div>
      </div>
      <div class="adm-card" style="padding:0;overflow:hidden">
        <div class="adm-card-head" style="padding:10px 14px"><i data-lucide="eye"></i><span>${escHtml(t('pages.preview', 'Aperçu'))}</span></div>
        <iframe id="pages-preview" title="preview" style="width:100%;height:600px;border:none;border-top:1px solid var(--border-subtle,#2a2a3a);background:#0d0d1a"></iframe>
      </div>
    </div>`;

  el('pages-select').addEventListener('change', (e) => selectPage(e.target.value));
  el('pages-loc').addEventListener('change', (e) => { _editLoc = e.target.value; renderSettings(); });
  el('pages-new').addEventListener('click', newPage);
  el('pages-delete').addEventListener('click', deletePage);
  el('pages-save').addEventListener('click', saveDraft);
  el('pages-publish').addEventListener('click', publish);
  el('pages-revert').addEventListener('click', revert);

  root.querySelectorAll('.pages-add').forEach((b) => b.addEventListener('click', () => addBlock(b.getAttribute('data-type'))));
  _wireList(root);
  renderSettings();
  _loadPreview();
  refreshIcons(root);
}

function _wireList(root) {
  root.querySelectorAll('.pages-block-item').forEach((item) => {
    const idx = +item.getAttribute('data-idx');
    item.addEventListener('click', (e) => { if (e.target.closest('button')) return; _sel = idx; render(); });
    item.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/plain', String(idx)); });
    item.addEventListener('dragover', (e) => e.preventDefault());
    item.addEventListener('drop', (e) => { e.preventDefault(); const from = +e.dataTransfer.getData('text/plain'); _move(from, idx); });
  });
  root.querySelectorAll('.pages-up').forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); const i = +b.getAttribute('data-idx'); _move(i, i - 1); }));
  root.querySelectorAll('.pages-down').forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); const i = +b.getAttribute('data-idx'); _move(i, i + 1); }));
  root.querySelectorAll('.pages-del').forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); const i = +b.getAttribute('data-idx'); _blocks.splice(i, 1); if (_sel >= _blocks.length) _sel = _blocks.length - 1; _changed(); render(); }));
}

function _move(from, to) {
  if (to < 0 || to >= _blocks.length || from === to) return;
  const [b] = _blocks.splice(from, 1); _blocks.splice(to, 0, b); _sel = to; _changed(); render();
}

function addBlock(type) { _blocks.push(_newBlock(type)); _sel = _blocks.length - 1; _changed(); render(); }

function renderSettings() {
  const host = el('pages-settings');
  if (!host) return;
  const b = _blocks[_sel];
  if (!b) { host.innerHTML = ''; return; }
  const fields = _fields(b.type);
  const rows = fields.map((f) => _fieldHtml(b, f)).join('');
  host.innerHTML = `<div class="adm-card" style="padding:12px;background:var(--bg-elevated,#1a1a28)">
      <div class="adm-field-label" style="margin-bottom:8px">${escHtml(t('pages.block.' + b.type, b.type))}</div>${rows || `<p class="adm-page-sub">${escHtml(t('pages.noSettings', 'Pas de réglages.'))}</p>`}</div>`;
  _wireFields(host, b, fields);
  refreshIcons(host);
}

function _fieldHtml(b, f) {
  const val = _get(b, f.k);
  if (f.t === 'ltext') return `<label class="adm-field"><span class="adm-field-label">${escHtml(f.l)}</span><input type="text" class="adm-field-input" data-f="${escHtml(f.k)}" data-lt="1" value="${escHtml(_lv(val))}"></label>`;
  if (f.t === 'ltextarea') return `<label class="adm-field"><span class="adm-field-label">${escHtml(f.l)}</span><textarea class="adm-field-input" data-f="${escHtml(f.k)}" data-lt="1" rows="4" style="resize:vertical">${escHtml(_lv(val))}</textarea></label>`;
  if (f.t === 'select') return `<label class="adm-field"><span class="adm-field-label">${escHtml(f.l)}</span><select class="adm-field-input" data-f="${escHtml(f.k)}">${f.opts.map(([v, lab]) => `<option value="${escHtml(v)}" ${String(val) === v ? 'selected' : ''}>${escHtml(lab)}</option>`).join('')}</select></label>`;
  if (f.t === 'color') return `<label class="adm-field" style="flex-direction:row;justify-content:space-between;align-items:center"><span class="adm-field-label" style="margin:0">${escHtml(f.l)}</span><input type="text" class="adm-field-input" data-f="${escHtml(f.k)}" value="${escHtml(typeof val === 'string' ? val : '')}" placeholder="#… / transparent" style="width:160px"></label>`;
  if (f.t === 'number') return `<label class="adm-field"><span class="adm-field-label">${escHtml(f.l)}</span><input type="number" class="adm-field-input" data-f="${escHtml(f.k)}" value="${escHtml(val != null ? String(val) : '')}"></label>`;
  if (f.t === 'gallery') return `<div class="adm-field"><span class="adm-field-label">${escHtml(f.l)}</span><div id="pages-gallery"></div><button class="adm-btn adm-btn-ghost adm-btn-sm" id="pages-gallery-add"><i data-lucide="plus"></i> ${escHtml(t('pages.addImage', 'Ajouter une image'))}</button></div>`;
  if (f.t === 'stats') return `<div class="adm-field"><span class="adm-field-label">${escHtml(f.l)}</span><div id="pages-stats"></div><button class="adm-btn adm-btn-ghost adm-btn-sm" id="pages-stats-add"><i data-lucide="plus"></i> ${escHtml(t('pages.addStat', 'Ajouter une stat'))}</button></div>`;
  return `<label class="adm-field"><span class="adm-field-label">${escHtml(f.l)}</span><input type="text" class="adm-field-input" data-f="${escHtml(f.k)}" value="${escHtml(typeof val === 'string' ? val : (val != null ? String(val) : ''))}"></label>`;
}

function _wireFields(host, b, fields) {
  host.querySelectorAll('[data-f]').forEach((inp) => {
    inp.addEventListener('input', () => {
      const path = inp.getAttribute('data-f');
      if (inp.getAttribute('data-lt')) {
        let obj = _get(b, path); if (typeof obj !== 'object' || obj == null) { obj = {}; _put(b, path, obj); }
        obj[_editLoc] = inp.value;
      } else {
        _put(b, path, inp.value);
      }
      _changed(); _refreshListLabels();
    });
  });
  // Gallery widget
  const gwrap = host.querySelector('#pages-gallery');
  if (gwrap) {
    const imgs = (b.props.images = Array.isArray(b.props.images) ? b.props.images : []);
    const draw = () => {
      gwrap.innerHTML = imgs.map((im, i) => `<div style="display:flex;gap:6px;margin-bottom:5px"><input type="text" class="adm-field-input g-src" data-i="${i}" value="${escHtml(im.src || '')}" placeholder="URL" style="flex:1"><button class="adm-icon-btn g-del" data-i="${i}">✕</button></div>`).join('');
      gwrap.querySelectorAll('.g-src').forEach((s) => s.addEventListener('input', () => { imgs[+s.getAttribute('data-i')].src = s.value; _changed(); }));
      gwrap.querySelectorAll('.g-del').forEach((d) => d.addEventListener('click', () => { imgs.splice(+d.getAttribute('data-i'), 1); _changed(); draw(); }));
    };
    draw();
    host.querySelector('#pages-gallery-add').addEventListener('click', () => { imgs.push({ src: '', alt: {} }); _changed(); draw(); });
  }
  // Stats widget
  const swrap = host.querySelector('#pages-stats');
  if (swrap) {
    const stats = (b.props.stats = Array.isArray(b.props.stats) ? b.props.stats : []);
    const draw = () => {
      swrap.innerHTML = stats.map((st, i) => `<div style="display:flex;gap:6px;margin-bottom:5px;align-items:center">
          <input type="text" class="adm-field-input s-label" data-i="${i}" value="${escHtml(_lv(st.label))}" placeholder="${escHtml(t('pages.statLabel', 'Libellé'))}" style="flex:1">
          <select class="adm-field-input s-src" data-i="${i}" style="width:auto"><option value="datasetCount" ${st.source === 'datasetCount' ? 'selected' : ''}>#datasets</option><option value="custom" ${st.source !== 'datasetCount' ? 'selected' : ''}>${escHtml(t('pages.custom', 'Fixe'))}</option></select>
          <input type="text" class="adm-field-input s-val" data-i="${i}" value="${escHtml(st.value != null ? String(st.value) : '')}" placeholder="123" style="width:70px" ${st.source === 'datasetCount' ? 'disabled' : ''}>
          <button class="adm-icon-btn s-del" data-i="${i}">✕</button></div>`).join('');
      swrap.querySelectorAll('.s-label').forEach((s) => s.addEventListener('input', () => { const st = stats[+s.getAttribute('data-i')]; if (typeof st.label !== 'object' || st.label == null) st.label = {}; st.label[_editLoc] = s.value; _changed(); }));
      swrap.querySelectorAll('.s-src').forEach((s) => s.addEventListener('change', () => { stats[+s.getAttribute('data-i')].source = s.value; _changed(); draw(); }));
      swrap.querySelectorAll('.s-val').forEach((s) => s.addEventListener('input', () => { stats[+s.getAttribute('data-i')].value = s.value; _changed(); }));
      swrap.querySelectorAll('.s-del').forEach((d) => d.addEventListener('click', () => { stats.splice(+d.getAttribute('data-i'), 1); _changed(); draw(); }));
    };
    draw();
    host.querySelector('#pages-stats-add').addEventListener('click', () => { stats.push({ label: {}, source: 'custom', value: '' }); _changed(); draw(); });
  }
}

function _refreshListLabels() {
  document.querySelectorAll('.pages-block-item').forEach((item) => {
    const b = _blocks[+item.getAttribute('data-idx')];
    const span = item.querySelector('span > span');
    if (b && span) span.textContent = ' ' + (_short(b.text) || _short(b.props?.subtitle) || '');
  });
}

function _changed() { _mark(true); _pushPreview(); }

// ── Preview iframe ──────────────────────────────────────────────
function _previewUrl() {
  // Built-in pages preview through the REAL page (so the operator sees the actual
  // landing/about chrome + the default content when no blocks are published);
  // custom pages preview through the generic page.html host.
  if (_slug === 'home') return 'index.html?preview=draft';
  if (_slug === 'about') return 'about.html?preview=draft';
  return `page.html?slug=${encodeURIComponent(_slug || 'home')}&preview=draft`;
}
function _loadPreview() {
  const frame = el('pages-preview');
  if (!frame) return;
  frame.src = _previewUrl();
  frame.onload = () => _pushPreview();
}
function _pushPreview() {
  const frame = el('pages-preview');
  try { frame.contentWindow.postMessage({ type: 'LUMEN_PREVIEW_BLOCKS', blocks: _blocks }, '*'); } catch (_) {}
}

// ── Page management ─────────────────────────────────────────────
function _buildPageList() {
  const custom = (Array.isArray(_instance?.nav?.customPages) ? _instance.nav.customPages : []).map((p) => ({ slug: p.slug, label: (p.label && (p.label[_editLoc] || p.label.en)) || p.slug, builtin: false }));
  _pages = [...SPECIAL.map((s) => ({ slug: s.slug, builtin: true })), ...custom];
}

async function selectPage(slug) {
  _slug = slug;
  const data = await apiFetch(`${API_SITE}?action=get&doc=pages/${encodeURIComponent(slug)}`);
  _doc = (data && typeof data === 'object') ? data : {};
  const draft = (_doc.draft && Array.isArray(_doc.draft.blocks)) ? _doc.draft.blocks : ((_doc.published && Array.isArray(_doc.published.blocks)) ? _doc.published.blocks : []);
  _blocks = JSON.parse(JSON.stringify(draft));
  _sel = _blocks.length ? 0 : -1;
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
  // Create the page doc (empty) + register it in instance.nav.customPages.
  await apiFetchStatus(`${API_SITE}?action=save&doc=pages/${encodeURIComponent(slug)}`, { method: 'POST', body: JSON.stringify({ title: { [_editLoc]: label }, published: { blocks: [] }, draft: { blocks: [] } }) });
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
  // Reset the doc to empty and remove from nav (the file stays but is unlinked/empty).
  await apiFetchStatus(`${API_SITE}?action=reset&doc=pages/${encodeURIComponent(_slug)}`, { method: 'POST', body: '{}' });
  _instance.nav.customPages = (_instance.nav.customPages || []).filter((p) => p.slug !== _slug);
  await apiFetchStatus(`${API_SITE}?action=save&doc=instance`, { method: 'POST', body: JSON.stringify(_instance) });
  try { if (typeof InstanceConfig !== 'undefined') await InstanceConfig.load(); } catch (_) {}
  _buildPageList();
  toast(t('pages.deleted', 'Page supprimée.'), 'success');
  await selectPage('home');
}

async function saveDraft() {
  _doc.draft = { blocks: _blocks };
  _doc.published = _doc.published || { blocks: [] };
  const r = await apiFetchStatus(`${API_SITE}?action=save&doc=pages/${encodeURIComponent(_slug)}`, { method: 'POST', body: JSON.stringify(_doc) });
  if (r.ok) { _mark(false); toast(t('pages.draftSaved', 'Brouillon enregistré.'), 'success'); }
  else toast(t('pages.saveError', "Échec de l'enregistrement."), 'error');
}

async function publish() {
  _doc.draft = { blocks: _blocks };
  const s = await apiFetchStatus(`${API_SITE}?action=save&doc=pages/${encodeURIComponent(_slug)}`, { method: 'POST', body: JSON.stringify(_doc) });
  if (!s.ok) { toast(t('pages.saveError', "Échec de l'enregistrement."), 'error'); return; }
  const r = await apiFetchStatus(`${API_SITE}?action=publish&doc=pages/${encodeURIComponent(_slug)}`, { method: 'POST', body: '{}' });
  if (r.ok) { _mark(false); _doc.published = { blocks: JSON.parse(JSON.stringify(_blocks)) }; toast(t('pages.published', 'Page publiée.'), 'success'); }
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
