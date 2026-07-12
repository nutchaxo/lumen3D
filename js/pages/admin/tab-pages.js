/**
 * Admin SPA — Pages (Elementor-style full-page visual editor, white-label)
 * ============================================================================
 * Two views:
 *
 *  1. LAUNCHER (inside the admin shell) — pick a page (built-in home/about or a
 *     custom page), see a read-only preview, and click "Edit with the editor".
 *
 *  2. EDITOR (full-screen) — the REAL page opens in an iframe (page.html?slug=…
 *     &edit=1) as a live editing surface: real navbar, footer, theme and the
 *     actual PageRenderer output, with every section / column / widget wrapped
 *     in editor chrome (hover outline, click-to-select, inline toolbar, drag to
 *     reorder, drop zones). A left sidebar holds the ELEMENTS palette and the
 *     contextual SETTINGS for the current selection. This is the Elementor model
 *     the operator asked for: you edit the page itself, full-width — not an
 *     abstract block-tree in a cramped panel.
 *
 * DATA-FLOW: this tab is the single source of truth. It holds the working model
 * (_sections) and posts it to the iframe (LUMEN_EDIT_DOC via js/core/page-edit-
 * frame.js). The frame renders + emits intents (select / drop / action / resize)
 * back; this tab mutates the model and re-posts. Draft / Publish / Revert persist
 * config/pages/<slug>.json through /api/site.php.
 *
 *   doc = { title:{loc}, published:{sections:[]}, draft:{sections:[]} }
 *   Section = { id, props:{bg,padY,fullWidth,maxWidth,gap,vAlign}, columns:[Column] }
 *   Column  = { id, width(1–12), props:{vAlign,padding}, widgets:[Widget] }
 *   Widget  = { id, type, text, props }   (same types as PageRenderer)
 *
 * Legacy flat { blocks:[] } docs migrate to one contained section / 12-unit
 * column so pages built with the old editor keep working.
 */

'use strict';

import { API_SITE, I18n, t, escHtml, apiFetch, apiFetchStatus, toast, el, refreshIcons } from './shared.js';
import { setUnsaved } from './bus.js';
import { renderFields } from './pages-controls.js';

const SPECIAL = [{ slug: 'home', builtin: true }, { slug: 'about', builtin: true }];

let _instance = {};
let _pages = [];
let _slug = null;
let _doc = { title: {}, published: { sections: [] }, draft: { sections: [] } };
let _sections = [];                 // working draft
let _sel = null;                    // { si, ci, wi } — ci/wi null = column/section scope
let _editLoc = 'en';
let _dirty = false;
let _mode = 'launcher';             // 'launcher' | 'editor'
let _side = 'elements';             // editor sidebar: 'elements' | 'settings'
let _bound = false;                 // window 'message' listener installed once
let _editorOnly = false;            // dedicated editor tab (admpan.html?editor=<slug>)
let _seeded = false;                // built-in page: showing the starter template (not yet published)
let _beforeUnloadBound = false;     // editor-tab unsaved-work guard installed once
const _langDicts = {};              // locale code → loaded i18n dict (for faithful templates)

const _id = (p) => p + Math.random().toString(36).slice(2, 9);
function _mark(on) { _dirty = on; setUnsaved(on); ['pages-save', 'pe-save'].forEach((id) => { const s = el(id); if (s) s.disabled = !on; }); }
function _locales() { try { if (I18n && I18n.getAvailableLanguages) { const l = I18n.getAvailableLanguages(); if (l.length) return l; } } catch (_) {} return [{ code: 'en', native: 'EN' }, { code: 'fr', native: 'FR' }, { code: 'es', native: 'ES' }]; }
function _lv(v) { if (v == null) return ''; if (typeof v === 'string') return v; if (typeof v === 'object') return v[_editLoc] || ''; return String(v); }

// A frame mutation just happened → mark dirty, refresh the sidebar (selection
// may have moved) and push the new model into the iframe.
function _afterMutate() { _mark(true); renderSidebar(); _syncFrame(); }

// ── Widget palette / defaults ───────────────────────────────────
const PALETTE = [
  { type: 'heading', icon: 'heading', def: 'Titre', cat: 'basics' },
  { type: 'richtext', icon: 'align-left', def: 'Texte', cat: 'basics' },
  { type: 'image', icon: 'image', def: 'Image', cat: 'basics' },
  { type: 'icon', icon: 'star', def: 'Icône', cat: 'basics' },
  { type: 'button', icon: 'mouse-pointer-click', def: 'Bouton', cat: 'basics' },
  { type: 'hero', icon: 'flag', def: 'Héros', cat: 'content' },
  { type: 'cta-banner', icon: 'megaphone', def: 'Bandeau d\'action', cat: 'content' },
  { type: 'feature-card', icon: 'badge-check', def: 'Carte icône', cat: 'content' },
  { type: 'quote', icon: 'quote', def: 'Citation', cat: 'content' },
  { type: 'gallery', icon: 'images', def: 'Galerie', cat: 'content' },
  { type: 'accordion', icon: 'chevrons-down-up', def: 'Accordéon / FAQ', cat: 'lists' },
  { type: 'timeline', icon: 'milestone', def: 'Frise chronologique', cat: 'lists' },
  { type: 'stat-grid', icon: 'bar-chart-2', def: 'Statistiques', cat: 'lists' },
  { type: 'latest-datasets', icon: 'layers', def: 'Derniers éléments', cat: 'lists' },
  { type: 'divider', icon: 'minus', def: 'Séparateur', cat: 'layout' },
  { type: 'spacer', icon: 'move-vertical', def: 'Espace', cat: 'layout' },
  { type: 'html', icon: 'code', def: 'HTML', cat: 'layout' },
];
const PALETTE_CATS = [
  ['basics', 'Bases'],
  ['content', 'Contenu'],
  ['lists', 'Listes & données'],
  ['layout', 'Structure'],
];

function _newWidget(type) {
  const id = _id('w');
  switch (type) {
    case 'heading': return { id, type, text: {}, props: { level: '2', align: 'left' } };
    case 'richtext': return { id, type, text: {}, props: { align: 'left' } };
    case 'hero': return { id, type, text: {}, props: { subtitle: {}, bg: '', align: 'center', titleSize: '', titleColor: '', subSize: '', subColor: '', cta: { text: {}, href: '' }, cta2: { text: {}, href: '' } } };
    case 'button': return { id, type, text: {}, props: { href: '#', variant: 'accent', align: 'left', fullWidth: false } };
    case 'image': return { id, type, props: { src: '', alt: {}, align: 'center', width: '', height: '', fit: '', href: '' } };
    case 'icon': return { id, type, props: { name: 'star', size: 48, color: '', align: 'center' } };
    case 'gallery': return { id, type, props: { images: [], cols: '', height: '', gap: '' } };
    case 'stat-grid': return { id, type, props: { stats: [{ label: {}, source: 'datasetCount', value: '' }], cols: '', cardBg: '', valueColor: '', valueSize: '', labelColor: '' } };
    case 'latest-datasets': return { id, type, props: { count: 4, cols: '' } };
    case 'divider': return { id, type, props: { color: '', thickness: '', width: '', lineStyle: 'solid' } };
    case 'spacer': return { id, type, props: { height: 32 } };
    case 'html': return { id, type, props: { html: {} } };
    case 'feature-card': return { id, type, text: {}, props: { icon: 'sparkles', iconSize: 34, iconColor: '', iconBg: '', iconShape: 'round', desc: {}, link: { text: {}, href: '' }, align: 'left' } };
    case 'quote': return { id, type, text: {}, props: { author: {}, role: {}, avatar: '', variant: 'bar', accent: '' } };
    case 'accordion': return { id, type, props: { items: [{ q: {}, a: {} }, { q: {}, a: {} }], single: true, firstOpen: true, iconColor: '' } };
    case 'timeline': return { id, type, props: { items: [{ date: {}, title: {}, text: {} }, { date: {}, title: {}, text: {} }], accent: '', lineColor: '' } };
    case 'cta-banner': return { id, type, text: {}, props: { subtitle: {}, bg: '', align: 'left', cta: { text: {}, href: 'explorer.html' } } };
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
  return (Array.isArray(list) ? list : []).map((s) => ({
    id: s.id || _id('s'),
    props: Object.assign({ bg: '', padY: 48, fullWidth: false, maxWidth: 1080, gap: 24, vAlign: 'stretch' }, s.props || {}),
    columns: (Array.isArray(s.columns) ? s.columns : [_newColumn(12)]).map((c) => ({
      id: c.id || _id('c'), width: Math.min(12, Math.max(1, +c.width || 12)), props: c.props || {},
      widgets: (Array.isArray(c.widgets) ? c.widgets : []).map((w) => {
        const nw = Object.assign({ id: w.id || _id('w') }, w);
        // Legacy buttons kept the variant in props.style (a string); the generic
        // style panel now owns props.style (an object), so move it to props.variant
        // — otherwise the first style edit would clobber the variant and vice-versa.
        if (nw.type === 'button' && nw.props && typeof nw.props.style === 'string') {
          nw.props = Object.assign({}, nw.props, { variant: nw.props.variant || nw.props.style });
          delete nw.props.style;
        }
        // v1.16.1 stored text gradients in a separate style.textGradient field;
        // since v1.16.2 style.color holds either a color or a gradient (one
        // unified picker). Fold the legacy field in (it used to win over color).
        if (nw.props && nw.props.style && typeof nw.props.style === 'object' && nw.props.style.textGradient) {
          const stl = Object.assign({}, nw.props.style, { color: nw.props.style.textGradient });
          delete stl.textGradient;
          nw.props = Object.assign({}, nw.props, { style: stl });
        }
        return nw;
      }),
    })),
  }));
}

// Starter layouts for the built-in pages (home/about) — their real default is
// static HTML, so there are no blocks to load; this gives an editable start.
//
// The RICH template mirrors the actual landing/about page: it reuses the very
// same localized strings (landing.* / about.*, with {specimen}/{brand} tokens
// that PageRenderer interpolates) across every available locale, so opening the
// editor shows content faithful to what visitors see (and publishing it makes
// the live page render exactly that). Falls back to a minimal template if the
// locale dictionaries aren't loaded yet.
function _defaultTemplate(slug) {
  if (slug !== 'home' && slug !== 'about') return [];
  return _richTemplate(slug) || _minimalTemplate(slug);
}

// Multi-locale text object for an i18n key, read from the pre-loaded dicts.
function _tpl(key) {
  const out = {};
  for (const code of Object.keys(_langDicts)) {
    const v = key.split('.').reduce((o, k) => (o && o[k] !== undefined ? o[k] : undefined), _langDicts[code]);
    if (typeof v === 'string') out[code] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

function _richTemplate(slug) {
  if (slug === 'home') {
    const hero = _tpl('landing.heroTitle');
    if (!hero) return null;   // dicts not loaded → caller uses the minimal template
    const typeCol = (titleKey, descKey, type) => ({ width: 4, widgets: [
      { type: 'heading', text: _tpl(titleKey), props: { level: '3', align: 'left' } },
      { type: 'richtext', text: _tpl(descKey), props: { align: 'left' } },
      { type: 'button', text: _tpl('landing.viewCollection'), props: { href: 'explorer.html?type=' + type, style: 'ghost', align: 'left' } },
    ] });
    return _sanitizeSections([
      { props: { fullWidth: false, padY: 72, maxWidth: 1080, gap: 24, vAlign: 'stretch', bg: '' }, columns: [{ width: 12, widgets: [
        { type: 'hero', text: hero, props: { subtitle: _tpl('landing.heroSubtitle'), bg: '', cta: { text: _tpl('landing.exploreBtn'), href: 'explorer.html' } } },
      ] }] },
      { props: { fullWidth: false, padY: 24, maxWidth: 1080, gap: 24, vAlign: 'stretch', bg: '' }, columns: [{ width: 12, widgets: [
        { type: 'stat-grid', props: { stats: [
          { label: _tpl('landing.statsDatasets'), source: 'datasetCount', value: '' },
          { label: _tpl('landing.statsEmbryos'), source: 'specimenCount', value: '' },
          { label: _tpl('landing.statsCells'), source: 'cellCount', value: '' },
          { label: _tpl('landing.statsRegions'), source: 'regionCount', value: '' },
        ] } },
      ] }] },
      { props: { fullWidth: false, padY: 32, maxWidth: 1080, gap: 24, vAlign: 'stretch', bg: '' }, columns: [{ width: 12, widgets: [
        { type: 'heading', text: _tpl('landing.typesTitle'), props: { level: '2', align: 'center' } },
        { type: 'richtext', text: _tpl('landing.typesSubtitle'), props: { align: 'center' } },
      ] }] },
      { props: { fullWidth: false, padY: 8, maxWidth: 1080, gap: 24, vAlign: 'stretch', bg: '' }, columns: [
        typeCol('landing.fixedTitle', 'landing.fixedDesc', 'fixed'),
        typeCol('landing.liveTitle', 'landing.liveDesc', 'live'),
        typeCol('landing.trackingTitle', 'landing.trackingDesc', 'tracking'),
      ] },
      { props: { fullWidth: false, padY: 40, maxWidth: 1080, gap: 24, vAlign: 'stretch', bg: '' }, columns: [{ width: 12, widgets: [
        { type: 'heading', text: _tpl('landing.featuredTitle'), props: { level: '2', align: 'center' } },
        { type: 'latest-datasets', props: { count: 3 } },
      ] }] },
    ]);
  }
  if (slug === 'about') {
    const title = _tpl('about.title');
    if (!title) return null;
    return _sanitizeSections([
      { props: { fullWidth: false, padY: 56, maxWidth: 860, gap: 24, vAlign: 'stretch', bg: '' }, columns: [{ width: 12, widgets: [
        { type: 'heading', text: title, props: { level: '1', align: 'left' } },
        { type: 'richtext', text: _tpl('about.description'), props: { align: 'left' } },
      ] }] },
      { props: { fullWidth: false, padY: 16, maxWidth: 860, gap: 24, vAlign: 'stretch', bg: '' }, columns: [{ width: 12, widgets: [
        { type: 'heading', text: _tpl('about.statsTitle'), props: { level: '2', align: 'left' } },
        { type: 'stat-grid', props: { stats: [
          { label: _tpl('landing.statsDatasets'), source: 'datasetCount', value: '' },
          { label: _tpl('landing.statsEmbryos'), source: 'specimenCount', value: '' },
        ] } },
      ] }] },
      { props: { fullWidth: false, padY: 16, maxWidth: 860, gap: 24, vAlign: 'stretch', bg: '' }, columns: [{ width: 12, widgets: [
        { type: 'heading', text: _tpl('about.contextTitle'), props: { level: '2', align: 'left' } },
        { type: 'richtext', text: _tpl('about.contextDesc'), props: { align: 'left' } },
      ] }] },
    ]);
  }
  return null;
}

function _minimalTemplate(slug) {
  if (slug === 'home') {
    return _sanitizeSections([
      { props: { fullWidth: false, padY: 64, maxWidth: 1080, gap: 24, vAlign: 'stretch', bg: '' }, columns: [{ width: 12, widgets: [
        { type: 'hero', text: { en: 'Welcome', fr: 'Bienvenue', es: 'Bienvenido' }, props: { subtitle: { en: 'Explore your 3D imaging datasets in the browser.', fr: 'Explorez vos jeux de données d\'imagerie 3D dans le navigateur.', es: 'Explora tus conjuntos de datos de imagen 3D en el navegador.' }, bg: '', cta: { text: { en: 'Explore data', fr: 'Explorer les données', es: 'Explorar datos' }, href: 'explorer.html' } } },
      ] }] },
      { props: { fullWidth: false, padY: 32, maxWidth: 1080, gap: 24, vAlign: 'stretch', bg: '' }, columns: [{ width: 12, widgets: [
        { type: 'heading', text: { en: 'Latest datasets', fr: 'Derniers jeux de données', es: 'Últimos conjuntos de datos' }, props: { level: '2', align: 'center' } },
        { type: 'latest-datasets', props: { count: 4 } },
      ] }] },
    ]);
  }
  if (slug === 'about') {
    return _sanitizeSections([
      { props: { fullWidth: false, padY: 48, maxWidth: 840, gap: 24, vAlign: 'stretch', bg: '' }, columns: [{ width: 12, widgets: [
        { type: 'heading', text: { en: 'About', fr: 'À propos', es: 'Acerca de' }, props: { level: '1', align: 'left' } },
        { type: 'richtext', text: { en: 'Describe your platform, your team, and how to get in touch.\n\nEdit this text, add sections and widgets, then publish.', fr: 'Décrivez votre plateforme, votre équipe et comment vous contacter.\n\nModifiez ce texte, ajoutez des sections et des widgets, puis publiez.', es: 'Describe tu plataforma, tu equipo y cómo contactar.\n\nEdita este texto, añade secciones y widgets, y publica.' }, props: { align: 'left' } },
      ] }] },
    ]);
  }
  return [];
}
function _hasTemplateFor(slug) { return _defaultTemplate(slug).length > 0; }
function loadDefaultTemplate() {
  const tpl = _defaultTemplate(_slug);
  if (!tpl.length) return;
  _sections = tpl; _sel = { si: 0, ci: null, wi: null }; _side = 'settings';
  _afterMutate();
}

function _selWidget() { if (!_sel || _sel.wi == null) return null; return _sections[_sel.si]?.columns[_sel.ci]?.widgets[_sel.wi] || null; }

// ── Field descriptors (rendered by pages-controls.js → renderFields) ────────
// Click-first: sliders for every numeric value, segmented buttons for enums,
// the rich color/gradient picker (grad:true) for backgrounds, the Lucide icon
// picker for icons, and the repeatable items editor for lists.
const ALIGN_OPTS = [['left', '', 'align-left'], ['center', '', 'align-center'], ['right', '', 'align-right']];
function _fields(type) {
  const align = { k: 'props.align', t: 'seg', l: t('pages.align', 'Alignement'), opts: ALIGN_OPTS };
  const cols = (max) => ({ k: 'props.cols', t: 'slider', l: t('pages.colsAuto', 'Colonnes (auto si vide)'), min: 1, max: max || 8, ph: 'auto', dv: 3 });
  switch (type) {
    case 'heading': return [
      { k: 'text', t: 'ltext', l: t('pages.text', 'Texte') },
      { k: 'props.level', t: 'seg', l: t('pages.level', 'Niveau'), opts: [['1', 'H1'], ['2', 'H2'], ['3', 'H3'], ['4', 'H4']] },
      align,
    ];
    case 'richtext': return [{ k: 'text', t: 'ltextarea', l: t('pages.text', 'Texte') }, align];
    case 'hero': return [
      { k: 'text', t: 'ltext', l: t('pages.heroTitle', 'Titre') },
      { k: 'props.titleSize', t: 'slider', l: t('pages.titleSize', 'Taille du titre'), min: 16, max: 160, ph: 'auto', dv: 44 },
      { k: 'props.titleColor', t: 'color', grad: true, l: t('pages.titleColor', 'Couleur du titre') },
      { k: 'props.subtitle', t: 'ltext', l: t('pages.heroSub', 'Sous-titre') },
      { k: 'props.subSize', t: 'slider', l: t('pages.subSize', 'Taille du sous-titre'), min: 10, max: 60, ph: 'auto', dv: 20 },
      { k: 'props.subColor', t: 'color', grad: true, l: t('pages.subColor', 'Couleur du sous-titre') },
      { k: 'props.bg', t: 'color', grad: true, l: t('pages.bg', 'Fond') },
      { k: 'props.style.overlay', t: 'color', grad: true, l: t('pages.overlay', 'Voile (couleur sur le fond)') },
      { k: 'props.align', t: 'seg', l: t('pages.align', 'Alignement'), opts: ALIGN_OPTS },
      { k: 'props.cta.text', t: 'ltext', l: t('pages.ctaText', 'Bouton') },
      { k: 'props.cta.href', t: 'text', l: t('pages.ctaHref', 'Lien du bouton') },
      { k: 'props.cta2.text', t: 'ltext', l: t('pages.cta2Text', 'Bouton secondaire') },
      { k: 'props.cta2.href', t: 'text', l: t('pages.cta2Href', 'Lien du bouton secondaire') },
    ];
    case 'button': return [
      { k: 'text', t: 'ltext', l: t('pages.label', 'Libellé') },
      { k: 'props.href', t: 'text', l: t('pages.href', 'Lien') },
      { k: 'props.variant', t: 'seg', l: t('pages.style', 'Style'), opts: [['accent', 'Accent'], ['ghost', 'Ghost'], ['lg', t('pages.big', 'Grand')]] },
      { k: 'props.fullWidth', t: 'check', l: t('pages.fullWidthBtn', 'Pleine largeur') },
      align,
    ];
    case 'image': return [
      { k: 'props.src', t: 'text', l: 'URL' },
      { k: 'props.alt', t: 'ltext', l: t('pages.alt', 'Texte alt') },
      { k: 'props.width', t: 'slider', l: t('pages.width', 'Largeur'), min: 40, max: 1200, step: 10, ph: 'auto', dv: 400 },
      { k: 'props.height', t: 'slider', l: t('pages.imgHeight', 'Hauteur'), min: 40, max: 1000, step: 10, ph: 'auto', dv: 300 },
      { k: 'props.fit', t: 'seg', l: t('pages.imgFit', 'Cadrage'), opts: [['', 'Auto'], ['cover', t('pages.fitCover', 'Remplir')], ['contain', t('pages.fitContain', 'Contenir')]] },
      { k: 'props.href', t: 'text', l: t('pages.linkOpt', 'Lien (option.)') },
      align,
    ];
    case 'icon': return [
      { k: 'props.name', t: 'icon', l: t('pages.iconName', 'Icône') },
      { k: 'props.size', t: 'slider', l: t('pages.iconSize', 'Taille'), min: 12, max: 160, dv: 48 },
      { k: 'props.color', t: 'color', l: t('pages.stroke', 'Couleur') },
      align,
    ];
    case 'gallery': return [
      { k: 'props.images', t: 'items', l: t('pages.images', 'Images'),
        item: [{ k: 'src', t: 'text', l: 'URL' }, { k: 'alt', t: 'ltext', l: t('pages.alt', 'Texte alt') }],
        mk: () => ({ src: '', alt: {} }), addLabel: t('pages.addImage', 'Ajouter une image'),
        summary: (im) => (im.src || '').split('/').pop() },
      cols(8),
      { k: 'props.height', t: 'slider', l: t('pages.imgHeight', 'Hauteur'), min: 60, max: 600, step: 10, ph: 'auto', dv: 160 },
      { k: 'props.gap', t: 'slider', l: t('pages.hgap', 'Espacement'), min: 0, max: 40, ph: 'auto', dv: 12 },
    ];
    case 'stat-grid': {
      const SRCOPTS = [['datasetCount', t('pages.srcDatasets', 'Jeux de données')], ['specimenCount', t('pages.srcSpecimen', 'Spécimens')], ['cellCount', t('pages.srcCells', 'Cellules')], ['regionCount', t('pages.srcRegions', 'Régions')], ['custom', t('pages.custom', 'Fixe')]];
      const LIVE = ['datasetCount', 'specimenCount', 'cellCount', 'regionCount'];
      return [
        { k: 'props.stats', t: 'items', l: t('pages.stats', 'Statistiques'),
          item: [
            { k: 'label', t: 'ltext', l: t('pages.statLabel', 'Libellé') },
            { k: 'source', t: 'select', l: t('pages.statSource', 'Source'), opts: SRCOPTS, refresh: true },
            { k: 'value', t: 'text', l: t('pages.statValue', 'Valeur fixe'), ph: '123', dis: (it) => LIVE.includes(it.source) },
          ],
          mk: () => ({ label: {}, source: 'custom', value: '' }), addLabel: t('pages.addStat', 'Ajouter une stat'),
          summary: (st, lv) => lv(st.label) },
        cols(8),
        { k: 'props.cardBg', t: 'color', grad: true, l: t('pages.cardBg', 'Fond des cartes') },
        { k: 'props.valueColor', t: 'color', l: t('pages.valueColor', 'Couleur des valeurs') },
        { k: 'props.valueSize', t: 'slider', l: t('pages.valueSize', 'Taille des valeurs'), min: 14, max: 90, ph: 'auto', dv: 40 },
        { k: 'props.labelColor', t: 'color', l: t('pages.labelColor', 'Couleur des libellés') },
      ];
    }
    case 'latest-datasets': return [
      { k: 'props.count', t: 'slider', l: t('pages.count', 'Nombre'), min: 1, max: 12, dv: 4 },
      cols(6),
    ];
    case 'divider': return [
      { k: 'props.color', t: 'color', l: t('pages.stroke', 'Couleur') },
      { k: 'props.thickness', t: 'slider', l: t('pages.thickness', 'Épaisseur'), min: 1, max: 12, dv: 1 },
      { k: 'props.width', t: 'slider', l: t('pages.widthPct', 'Largeur'), min: 5, max: 100, step: 5, unit: '%', ph: '100', dv: 100 },
      { k: 'props.lineStyle', t: 'seg', l: t('pages.lineStyle', 'Trait'), opts: [['solid', t('pages.lineSolid', 'Plein')], ['dashed', t('pages.lineDashed', 'Tirets')], ['dotted', t('pages.lineDotted', 'Points')]] },
    ];
    case 'spacer': return [{ k: 'props.height', t: 'slider', l: t('pages.height', 'Hauteur'), min: 4, max: 400, dv: 32 }];
    case 'html': return [{ k: 'props.html', t: 'ltextarea', l: 'HTML' }];
    case 'feature-card': return [
      { k: 'props.icon', t: 'icon', l: t('pages.iconName', 'Icône') },
      { k: 'props.iconSize', t: 'slider', l: t('pages.iconSize', 'Taille'), min: 14, max: 96, dv: 34 },
      { k: 'props.iconColor', t: 'color', l: t('pages.fc.iconColor', 'Couleur de l\'icône') },
      { k: 'props.iconBg', t: 'color', grad: true, l: t('pages.fc.iconBg', 'Fond de l\'icône') },
      { k: 'props.iconShape', t: 'seg', l: t('pages.fc.iconShape', 'Forme'), opts: [['round', t('pages.fc.round', 'Rond')], ['square', t('pages.fc.square', 'Carré')]] },
      { k: 'text', t: 'ltext', l: t('pages.heroTitle', 'Titre') },
      { k: 'props.desc', t: 'ltextarea', l: t('pages.text', 'Texte') },
      { k: 'props.link.text', t: 'ltext', l: t('pages.fc.linkText', 'Lien (libellé)') },
      { k: 'props.link.href', t: 'text', l: t('pages.href', 'Lien') },
      align,
    ];
    case 'quote': return [
      { k: 'text', t: 'ltextarea', l: t('pages.qt.text', 'Citation') },
      { k: 'props.author', t: 'ltext', l: t('pages.qt.author', 'Auteur') },
      { k: 'props.role', t: 'ltext', l: t('pages.qt.role', 'Rôle / affiliation') },
      { k: 'props.avatar', t: 'text', l: t('pages.qt.avatar', 'Photo (URL, option.)') },
      { k: 'props.variant', t: 'seg', l: t('pages.style', 'Style'), opts: [['bar', t('pages.qt.bar', 'Barre')], ['card', t('pages.qt.card', 'Carte')], ['big', t('pages.big', 'Grand')]] },
      { k: 'props.accent', t: 'color', l: t('pages.qt.accent', 'Couleur d\'accent') },
    ];
    case 'accordion': return [
      { k: 'props.items', t: 'items', l: t('pages.ac.items', 'Questions / sections'),
        item: [{ k: 'q', t: 'ltext', l: t('pages.ac.q', 'Titre / question') }, { k: 'a', t: 'ltextarea', l: t('pages.ac.a', 'Contenu / réponse') }],
        mk: () => ({ q: {}, a: {} }), addLabel: t('pages.ac.add', 'Ajouter une question'),
        summary: (it, lv) => lv(it.q) },
      { k: 'props.single', t: 'check', l: t('pages.ac.single', 'Une seule ouverte à la fois') },
      { k: 'props.firstOpen', t: 'check', l: t('pages.ac.firstOpen', 'Première ouverte par défaut') },
      { k: 'props.iconColor', t: 'color', l: t('pages.ac.chevron', 'Couleur du chevron') },
    ];
    case 'timeline': return [
      { k: 'props.items', t: 'items', l: t('pages.tl.items', 'Étapes'),
        item: [
          { k: 'date', t: 'ltext', l: t('pages.tl.date', 'Date / étiquette') },
          { k: 'title', t: 'ltext', l: t('pages.heroTitle', 'Titre') },
          { k: 'text', t: 'ltextarea', l: t('pages.text', 'Texte') },
        ],
        mk: () => ({ date: {}, title: {}, text: {} }), addLabel: t('pages.tl.add', 'Ajouter une étape'),
        summary: (it, lv) => lv(it.title) || lv(it.date) },
      { k: 'props.accent', t: 'color', l: t('pages.tl.accent', 'Couleur des points') },
      { k: 'props.lineColor', t: 'color', l: t('pages.tl.line', 'Couleur de la ligne') },
    ];
    case 'cta-banner': return [
      { k: 'text', t: 'ltext', l: t('pages.heroTitle', 'Titre') },
      { k: 'props.subtitle', t: 'ltext', l: t('pages.heroSub', 'Sous-titre') },
      { k: 'props.cta.text', t: 'ltext', l: t('pages.ctaText', 'Bouton') },
      { k: 'props.cta.href', t: 'text', l: t('pages.ctaHref', 'Lien du bouton') },
      { k: 'props.bg', t: 'color', grad: true, l: t('pages.bg', 'Fond') },
      { k: 'props.align', t: 'seg', l: t('pages.align', 'Alignement'), opts: [['left', '', 'align-left'], ['center', '', 'align-center']] },
    ];
    default: return [];
  }
}

// ── Style panel (generic, shared by widget / column / section scopes) ────────
// Every field writes props.style.* — compiled to inline CSS by
// PageRenderer.styleCss; the live page and the edit frame render it identically.
function _styleGroups(scope) {
  const surface = [
    { k: 'props.style.bg', t: 'color', grad: true, l: t('pages.st.bg', 'Fond') },
    { k: 'props.style.bgImage', t: 'text', l: t('pages.st.bgImage', 'Image de fond (URL)') },
    { k: 'props.style.radius', t: 'slider', l: t('pages.st.radius', 'Arrondi'), min: 0, max: 100, ph: 'auto', dv: 12 },
    { k: 'props.style.borderWidth', t: 'slider', l: t('pages.st.borderWidth', 'Bordure'), min: 0, max: 12, ph: '0', dv: 1 },
    { k: 'props.style.borderColor', t: 'color', l: t('pages.st.borderColor', 'Couleur de bordure') },
    { k: 'props.style.borderStyle', t: 'seg', l: t('pages.st.borderStyle', 'Style de bordure'), opts: [['solid', t('pages.lineSolid', 'Plein')], ['dashed', t('pages.lineDashed', 'Tirets')], ['dotted', t('pages.lineDotted', 'Points')]] },
    { k: 'props.style.shadow', t: 'seg', l: t('pages.st.shadow', 'Ombre'), opts: [['', '—'], ['sm', 'S'], ['md', 'M'], ['lg', 'L']] },
    { k: 'props.style.opacity', t: 'slider', l: t('pages.st.opacity', 'Opacité'), min: 0, max: 100, step: 5, unit: '%', ph: '100', dv: 100 },
  ];
  if (scope === 'section') surface.splice(2, 0, { k: 'props.style.overlay', t: 'color', grad: true, l: t('pages.overlay', 'Voile (couleur sur le fond)') });
  return [
    { title: t('pages.st.text', 'Texte'), icon: 'type', fields: [
      { k: 'props.style.color', t: 'color', grad: true, l: t('pages.st.textColor', 'Couleur du texte') },
      { k: 'props.style.fontSize', t: 'slider', l: t('pages.st.fontSize', 'Taille'), min: 8, max: 160, ph: 'auto', dv: 16 },
      { k: 'props.style.fontWeight', t: 'slider', l: t('pages.st.fontWeight', 'Graisse'), min: 100, max: 900, step: 100, unit: '', ph: 'auto', dv: 400 },
      { k: 'props.style.lineHeight', t: 'slider', l: t('pages.st.lineHeight', 'Interligne'), min: 0.8, max: 2.6, step: 0.05, unit: '×', ph: 'auto', dv: 1.5 },
      { k: 'props.style.letterSpacing', t: 'slider', l: t('pages.st.letterSpacing', 'Espac. lettres'), min: -3, max: 12, step: 0.5, ph: '0', dv: 0 },
      { k: 'props.style.align', t: 'seg', l: t('pages.align', 'Alignement'), opts: [['', 'Auto'], ...ALIGN_OPTS] },
      { k: 'props.style.italic', t: 'check', l: t('pages.st.italic', 'Italique') },
      { k: 'props.style.uppercase', t: 'check', l: t('pages.st.uppercase', 'Majuscules') },
    ] },
    { title: t('pages.st.surface', 'Fond & bordure'), icon: 'paint-bucket', fields: surface },
    { title: t('pages.st.spacing', 'Espacement'), icon: 'move', fields: [
      { k: 'props.style.padTop', t: 'slider', l: t('pages.st.padTop', 'Padding haut'), min: 0, max: 160, ph: 'auto', dv: 0 },
      { k: 'props.style.padBottom', t: 'slider', l: t('pages.st.padBottom', 'Padding bas'), min: 0, max: 160, ph: 'auto', dv: 0 },
      { k: 'props.style.padLeft', t: 'slider', l: t('pages.st.padLeft', 'Padding gauche'), min: 0, max: 160, ph: 'auto', dv: 0 },
      { k: 'props.style.padRight', t: 'slider', l: t('pages.st.padRight', 'Padding droite'), min: 0, max: 160, ph: 'auto', dv: 0 },
      { k: 'props.style.marginTop', t: 'slider', l: t('pages.st.marginTop', 'Marge haut'), min: -100, max: 200, ph: 'auto', dv: 0 },
      { k: 'props.style.marginBottom', t: 'slider', l: t('pages.st.marginBottom', 'Marge bas'), min: -100, max: 200, ph: 'auto', dv: 0 },
    ] },
    { title: t('pages.st.size', 'Taille'), icon: 'scaling', fields: [
      { k: 'props.style.maxWidth', t: 'slider', l: t('pages.st.maxWidth', 'Largeur max'), min: 100, max: 1600, step: 10, ph: 'auto', dv: 800 },
      { k: 'props.style.minHeight', t: 'slider', l: t('pages.st.minHeight', 'Hauteur min'), min: 0, max: 1000, step: 10, ph: 'auto', dv: 0 },
    ] },
  ];
}

// Mount the Style accordion groups into `host` (DOM-built via renderFields).
function _mountStyleGroups(host, obj, scope, ctx) {
  const box = document.createElement('div');
  box.style.cssText = 'margin-top:12px;border-top:1px solid var(--adm-border,rgba(255,255,255,.07));padding-top:10px';
  const head = document.createElement('div');
  head.className = 'adm-field-label';
  head.style.cssText = 'margin-bottom:8px;display:flex;align-items:center;gap:6px';
  head.innerHTML = `<i data-lucide="brush"></i>${escHtml(t('pages.st.title', 'Style'))}`;
  box.appendChild(head);
  _styleGroups(scope).forEach((g) => {
    const det = document.createElement('details');
    det.style.cssText = 'margin-bottom:8px;border:1px solid var(--adm-border,rgba(255,255,255,.07));border-radius:8px;padding:6px 9px';
    const sum = document.createElement('summary');
    sum.style.cssText = 'cursor:pointer;font-size:12.5px;font-weight:600;display:flex;align-items:center;gap:7px;user-select:none;list-style:none';
    sum.innerHTML = `<i data-lucide="${g.icon}" style="width:13px;height:13px"></i>${escHtml(g.title)}`;
    det.appendChild(sum);
    const bodyBox = document.createElement('div');
    bodyBox.style.cssText = 'margin-top:8px;display:flex;flex-direction:column;gap:10px';
    renderFields(bodyBox, obj, g.fields, ctx);
    det.appendChild(bodyBox);
    box.appendChild(det);
  });
  host.appendChild(box);
}

// ── Control context: model writes → dirty + live iframe sync; custom gradient
// presets persist in the PUBLIC instance doc (config/instance.json → editor.*),
// so they follow the site (any browser / operator), not one browser profile.
function _ctlCtx() {
  return {
    loc: _editLoc,
    onChange() { _mark(true); _syncFrame(); },
    gradients: { get: _gradPresets, save: _saveGradPresets },
  };
}
function _gradPresets() {
  return (_instance && _instance.editor && Array.isArray(_instance.editor.gradientPresets)) ? _instance.editor.gradientPresets : [];
}
function _saveGradPresets(list) {
  if (!_instance || typeof _instance !== 'object' || Array.isArray(_instance)) _instance = {};
  _instance.editor = (_instance.editor && typeof _instance.editor === 'object') ? _instance.editor : {};
  _instance.editor.gradientPresets = (Array.isArray(list) ? list : []).slice(0, 40);
  apiFetchStatus(`${API_SITE}?action=save&doc=instance`, { method: 'POST', body: JSON.stringify(_instance) })
    .then((r) => { if (!r.ok) toast(t('pages.saveError', "Échec de l'enregistrement."), 'error'); else toast(t('pages.pc.presetSaved', 'Préréglages de dégradés mis à jour.'), 'success'); })
    .catch(() => {});
}

// ══════════════════════════════════════════════════════════════
// Top-level view dispatch
// ══════════════════════════════════════════════════════════════
function render() {
  const root = el('pages-root');
  if (!root) return;
  if (_mode === 'editor') renderEditor();
  else renderLauncher();
}

function _pageOptions() {
  return _pages.map((p) => `<option value="${escHtml(p.slug)}" ${p.slug === _slug ? 'selected' : ''}>${escHtml(p.builtin ? p.slug + ' ' + t('pages.builtin', '(intégrée)') : (p.label || p.slug))}</option>`).join('');
}
function _locOptions() {
  return _locales().map((l) => `<option value="${escHtml(l.code)}" ${l.code === _editLoc ? 'selected' : ''}>${escHtml(l.native || l.code)}</option>`).join('');
}
function _editUrl() { return `page.html?slug=${encodeURIComponent(_slug || 'home')}&edit=1`; }
function _viewUrl() {
  if (_slug === 'home') return 'index.html';
  if (_slug === 'about') return 'about.html';
  return `page.html?slug=${encodeURIComponent(_slug || 'home')}`;
}

// ── Launcher (inside the admin shell) ───────────────────────────
function renderLauncher() {
  const root = el('pages-root');
  root.style.cssText = '';
  root.innerHTML = `
    <div class="adm-page-head">
      <div>
        <h2 class="adm-page-title">${escHtml(t('pages.title', 'Pages'))}</h2>
        <p class="adm-page-sub">${escHtml(t('pages.launcherSub', 'Choisissez une page et ouvrez l\'éditeur visuel pour la modifier comme une vraie page web.'))}</p>
      </div>
    </div>
    <div class="adm-card" style="padding:16px;display:flex;flex-direction:column;gap:14px">
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <select class="adm-field-input" id="pages-select" style="width:auto;min-width:200px">${_pageOptions()}</select>
        <button class="adm-btn adm-btn-ghost adm-btn-sm" id="pages-new"><i data-lucide="plus"></i> ${escHtml(t('pages.new', 'Nouvelle page'))}</button>
        <button class="adm-btn adm-btn-ghost adm-btn-sm" id="pages-delete"><i data-lucide="trash-2"></i> ${escHtml(t('pages.delete', 'Supprimer'))}</button>
        <label style="display:flex;gap:6px;align-items:center;font-size:13px">${escHtml(t('pages.lang', 'Langue'))}<select class="adm-field-input" id="pages-loc" style="width:auto">${_locOptions()}</select></label>
        <span style="flex:1"></span>
        <button class="adm-btn adm-btn-accent" id="pages-edit"><i data-lucide="pencil-ruler"></i> ${escHtml(t('pages.editWith', 'Modifier avec l\'éditeur'))}</button>
      </div>
      <div style="border:1px solid var(--border-subtle,#2a2a3a);border-radius:12px;overflow:hidden">
        <div class="adm-card-head" style="padding:8px 12px;border-bottom:1px solid var(--border-subtle,#2a2a3a);display:flex;align-items:center;gap:8px;margin:0">
          <i data-lucide="eye"></i><span>${escHtml(t('pages.preview', 'Aperçu'))}</span>
          <span style="flex:1"></span>
          <span class="adm-page-sub" style="font-size:11px;margin:0">${escHtml(t('pages.launcherHint', 'Cliquez « Modifier » pour éditer cette page'))}</span>
        </div>
        <iframe id="pages-view" title="preview" src="${escHtml(_viewUrl())}" style="width:100%;height:520px;border:none;display:block;background:var(--bg-base,#0d0d1a);pointer-events:none"></iframe>
      </div>
    </div>`;
  el('pages-select').addEventListener('change', (e) => selectPage(e.target.value));
  el('pages-new').addEventListener('click', newPage);
  el('pages-delete').addEventListener('click', deletePage);
  el('pages-loc').addEventListener('change', (e) => { _editLoc = e.target.value; });
  el('pages-edit').addEventListener('click', enterEditor);
  refreshIcons(root);
}

// ── Editor (full-screen: sidebar + iframe of the real page) ─────
function renderEditor() {
  const root = el('pages-root');
  root.style.cssText = 'position:fixed;inset:0;z-index:2000;background:var(--bg-base,#0d0d1a);display:flex;flex-direction:column';
  root.innerHTML = `
    <div style="display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid var(--border-subtle,#2a2a3a);flex-wrap:wrap">
      <button class="adm-btn adm-btn-ghost adm-btn-sm" id="pe-exit"><i data-lucide="arrow-left"></i> ${escHtml(t('pages.exitEditor', 'Quitter'))}</button>
      <strong style="font-size:14px;display:inline-flex;align-items:center;gap:6px"><i data-lucide="layout-template"></i> ${escHtml(t('pages.editorTitle', 'Éditeur de page'))}</strong>
      <select class="adm-field-input" id="pe-select" style="width:auto;min-width:160px">${_pageOptions()}</select>
      <label style="display:flex;gap:6px;align-items:center;font-size:13px">${escHtml(t('pages.lang', 'Langue'))}<select class="adm-field-input" id="pe-loc" style="width:auto">${_locOptions()}</select></label>
      <span style="flex:1"></span>
      <a class="adm-btn adm-btn-ghost adm-btn-sm" id="pe-open" target="_blank" rel="noopener" href="${escHtml(_viewUrl())}"><i data-lucide="external-link"></i> ${escHtml(t('pages.openTab', 'Ouvrir'))}</a>
      <button class="adm-btn adm-btn-ghost adm-btn-sm" id="pe-revert"><i data-lucide="rotate-ccw"></i> ${escHtml(t('pages.revert', 'Défaut'))}</button>
      <button class="adm-btn adm-btn-ghost adm-btn-sm" id="pe-save" ${_dirty ? '' : 'disabled'}><i data-lucide="save"></i> ${escHtml(t('pages.saveDraft', 'Brouillon'))}</button>
      <button class="adm-btn adm-btn-accent adm-btn-sm" id="pe-publish"><i data-lucide="upload"></i> ${escHtml(t('pages.publish', 'Publier'))}</button>
    </div>
    <div style="flex:1;display:flex;min-height:0">
      <div id="pages-side" style="width:300px;flex:0 0 300px;border-right:1px solid var(--border-subtle,#2a2a3a);padding:12px;overflow:auto"></div>
      <div style="flex:1;min-width:0;position:relative;background:var(--bg-base,#0d0d1a)">
        <iframe id="pages-frame" title="editor" src="${escHtml(_editUrl())}" style="width:100%;height:100%;border:none;display:block;background:var(--bg-base,#0d0d1a)"></iframe>
      </div>
    </div>`;
  el('pe-exit').addEventListener('click', exitEditor);
  el('pe-select').addEventListener('change', (e) => selectPage(e.target.value));
  el('pe-loc').addEventListener('change', (e) => { _editLoc = e.target.value; renderSidebar(); _syncFrame(); });
  el('pe-revert').addEventListener('click', revert);
  el('pe-save').addEventListener('click', saveDraft);
  el('pe-publish').addEventListener('click', publish);
  renderSidebar();
  refreshIcons(root);
  // The iframe posts LUMEN_EDIT_READY once page-edit-frame.js is initialised;
  // _onMessage answers with the current doc — no need to sync here.
}

function enterEditor() {
  // Elementor model: the editor lives in its OWN TAB (admpan.html?editor=<slug>)
  // — a dedicated full-window surface, not an overlay inside the admin shell.
  // Popup blocked → fall back to the in-shell full-screen editor.
  const w = window.open(`admpan.html?editor=${encodeURIComponent(_slug || 'home')}`, '_blank');
  if (w) return;
  _mode = 'editor'; _sel = null; _side = 'elements'; render();
}
function exitEditor() {
  if (_editorOnly) {
    if (_dirty && !confirm(t('pages.exitUnsaved', 'Modifications non enregistrées. Quitter sans publier ?'))) return;
    _dirty = false;                                     // let beforeunload proceed silently
    window.close();                                     // script-opened tab → closes
    setTimeout(() => { location.href = 'admpan.html#pages'; }, 250);  // direct-URL tab → back to admin
    return;
  }
  _mode = 'launcher'; const root = el('pages-root'); if (root) root.style.cssText = ''; render();
}

// ── Iframe bridge ───────────────────────────────────────────────
function _frameEl() { return el('pages-frame'); }
function _frameLabels() {
  return {
    section: t('pages.section', 'Section'), moveUp: t('pages.moveUp', 'Monter'), moveDown: t('pages.moveDown', 'Descendre'),
    addColumn: t('pages.addColumn', 'Ajouter une colonne'), settings: t('pages.settings', 'Réglages'),
    duplicate: t('pages.duplicate', 'Dupliquer'), delete: t('pages.delete', 'Supprimer'),
    resizeCols: t('pages.resizeCols', 'Glisser pour redimensionner'), dropHere: t('pages.dropHere', '＋ Glissez un élément ici'),
    drag: t('pages.drag', 'Déplacer'), addSection: t('pages.addSection', '＋ Ajouter une section'),
    emptyTitle: t('pages.emptyTitle', 'Page vierge'), emptyBody: t('pages.emptyBody', 'Ajoutez une section, puis glissez des éléments depuis le panneau de gauche.'),
    startFromDefault: t('pages.startFromDefault', 'Partir d\'un modèle'),
  };
}
function _syncFrame() {
  const f = _frameEl();
  if (!f || !f.contentWindow) return;
  try { f.contentWindow.postMessage({ type: 'LUMEN_EDIT_DOC', sections: _sections, sel: _sel, editLoc: _editLoc, messages: _frameLabels(), hasTemplate: _hasTemplateFor(_slug) }, '*'); } catch (_) {}
}
function _postFrame(msg) { const f = _frameEl(); if (f && f.contentWindow) try { f.contentWindow.postMessage(msg, '*'); } catch (_) {} }

function _onMessage(e) {
  const f = _frameEl();
  if (!f || e.source !== f.contentWindow) return;
  const m = e.data;
  if (!m || typeof m !== 'object') return;
  switch (m.type) {
    case 'LUMEN_EDIT_READY': _syncFrame(); break;
    case 'LUMEN_EDIT_SELECT': _sel = m.sel; _side = 'settings'; renderSidebar(); _syncFrame(); break;
    case 'LUMEN_EDIT_DROP': _applyDrop(m.target, m.payload); break;
    case 'LUMEN_EDIT_RESIZE': _applyResize(m.si, m.ci, m.leftWidth); break;
    case 'LUMEN_EDIT_ACTION': _applyAction(m.action, m.sel, m.arg); break;
  }
}

function _applyDrop(target, payload) {
  const col = _sections[target.si]?.columns[target.ci];
  if (!col) return;
  if (payload.kind === 'new') {
    const w = _newWidget(payload.wtype);
    col.widgets.splice(target.index, 0, w);
    _sel = { si: target.si, ci: target.ci, wi: target.index };
  } else if (payload.kind === 'move') {
    const from = payload.from;
    const fc = _sections[from.si]?.columns[from.ci];
    if (!fc) return;
    const [w] = fc.widgets.splice(from.wi, 1);
    if (!w) return;
    let idx = target.index;
    if (from.si === target.si && from.ci === target.ci && from.wi < idx) idx--;
    col.widgets.splice(idx, 0, w);
    _sel = { si: target.si, ci: target.ci, wi: idx };
  } else return;
  _side = 'settings';
  _afterMutate();
}

function _applyResize(si, ci, leftWidth) {
  const sec = _sections[si];
  if (!sec) return;
  const left = sec.columns[ci - 1], right = sec.columns[ci];
  if (!left || !right) return;
  const total = left.width + right.width;
  left.width = Math.min(total - 1, Math.max(1, leftWidth));
  right.width = total - left.width;
  _afterMutate();
}

function _applyAction(action, sel, arg) {
  switch (action) {
    case 'addSection': addSection(); break;
    case 'loadDefault': loadDefaultTemplate(); break;
    case 'dupSection': duplicateSection(sel.si); break;
    case 'delSection': deleteSection(sel.si); break;
    case 'moveSection': moveSection(sel.si, arg); break;
    case 'addColumn': addColumn(sel.si); break;
    case 'delColumn': removeColumn(sel.si, sel.ci); break;
    case 'dupWidget': duplicateWidget(sel.si, sel.ci, sel.wi); break;
    case 'delWidget': deleteWidget(sel.si, sel.ci, sel.wi); break;
  }
}

// ── Sidebar: Elements palette + contextual Settings ─────────────
function renderSidebar() {
  const host = el('pages-side');
  if (!host) return;
  const tab = (id, icon, label) => `<button class="adm-btn ${_side === id ? 'adm-btn-accent' : 'adm-btn-ghost'} adm-btn-sm" data-side="${id}" style="flex:1"><i data-lucide="${icon}"></i> ${escHtml(label)}</button>`;
  host.innerHTML = `<div style="display:flex;gap:6px;margin-bottom:12px">${tab('elements', 'shapes', t('pages.elements', 'Éléments'))}${tab('settings', 'sliders-horizontal', t('pages.settings', 'Réglages'))}</div><div id="pages-side-body"></div>`;
  host.querySelectorAll('[data-side]').forEach((b) => b.addEventListener('click', () => { _side = b.getAttribute('data-side'); renderSidebar(); }));
  const body = el('pages-side-body');
  if (_side === 'elements') _renderPalette(body);
  else { body.innerHTML = '<div id="pages-settings"></div>'; renderSettings(); }
  refreshIcons(host);
}

function _renderPalette(body) {
  const seedNote = _seeded
    ? `<div style="font-size:11.5px;line-height:1.45;padding:8px 10px;margin:0 0 10px;border:1px solid var(--color-primary,#2F6BFF);border-radius:8px;background:color-mix(in srgb,var(--color-primary,#2F6BFF) 10%,transparent)">${escHtml(t('pages.seedNotice', 'Modèle de départ — la page publiée garde sa mise en page intégrée tant que vous ne publiez pas cette version.'))}</div>`
    : '';
  body.innerHTML = `${seedNote}<p class="adm-page-sub" style="font-size:12px;margin:0 0 10px">${escHtml(t('pages.dragOrClick', 'Cliquez ou glissez un élément dans la page.'))}</p><div id="pages-palette"></div>`;
  const wrap = el('pages-palette');
  PALETTE_CATS.forEach(([cat, catDef]) => {
    const items = PALETTE.filter((b) => b.cat === cat);
    if (!items.length) return;
    const h = document.createElement('div');
    h.className = 'pbc-cat';
    h.textContent = t('pages.cat.' + cat, catDef);
    wrap.appendChild(h);
    const grid = document.createElement('div');
    grid.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:6px';
    items.forEach((b) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'adm-btn adm-btn-ghost adm-btn-sm';
      btn.style.cssText = 'justify-content:flex-start;cursor:grab;touch-action:none';
      btn.innerHTML = `<i data-lucide="${b.icon}"></i> ${escHtml(t('pages.block.' + b.type, b.def))}`;
      btn.addEventListener('pointerdown', (e) => _startPaletteDrag(e, b.type, btn));
      grid.appendChild(btn);
    });
    wrap.appendChild(grid);
  });
  refreshIcons(body);
}

// Pointer-based drag from the (parent) palette into the (iframe) page. Native
// HTML5 drag-drop across the frame boundary is unreliable, so we drive it
// ourselves: a floating ghost follows the pointer; while over the iframe we
// forward frame-local coords so the frame paints a drop indicator; on release
// over the iframe we tell it to drop, otherwise we just append to the selection.
// setPointerCapture is what lets the ghost cross INTO the iframe: without it
// the frame's document swallows every pointermove the moment the cursor
// leaves the sidebar, freezing the ghost against the panel edge.
function _startPaletteDrag(e, type, btn) {
  e.preventDefault();
  try { btn.setPointerCapture(e.pointerId); } catch (_) {}
  const frame = _frameEl();
  const label = btn ? btn.textContent.trim() : type;
  const ghost = document.createElement('div');
  ghost.textContent = label;
  ghost.style.cssText = 'position:fixed;z-index:3000;display:none;pointer-events:none;padding:6px 10px;background:var(--color-primary,#2F6BFF);color:#fff;border-radius:6px;font-size:12px;box-shadow:0 6px 16px rgba(0,0,0,.35)';
  document.body.appendChild(ghost);
  const startX = e.clientX, startY = e.clientY;
  let moved = false;
  const over = (ev) => { if (!frame) return null; const r = frame.getBoundingClientRect(); return ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top && ev.clientY <= r.bottom ? r : null; };
  const move = (ev) => {
    if (!moved && Math.hypot(ev.clientX - startX, ev.clientY - startY) < 5) return;   // click jitter ≠ drag
    moved = true;
    ghost.style.display = 'block';
    ghost.style.left = (ev.clientX + 10) + 'px';
    ghost.style.top = (ev.clientY + 10) + 'px';
    const r = over(ev);
    if (r) _postFrame({ type: 'LUMEN_EDIT_DRAGMOVE', x: ev.clientX - r.left, y: ev.clientY - r.top });
    else _postFrame({ type: 'LUMEN_EDIT_DRAGCLEAR' });
  };
  const finish = (ev, cancelled) => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', cancel);
    ghost.remove();
    const r = (!cancelled && ev) ? over(ev) : null;
    if (r && moved) _postFrame({ type: 'LUMEN_EDIT_DROP_AT', x: ev.clientX - r.left, y: ev.clientY - r.top, payload: { kind: 'new', wtype: type } });
    else { _postFrame({ type: 'LUMEN_EDIT_DRAGCLEAR' }); if (!moved && !cancelled) addWidgetToSelection(type); }
  };
  const up = (ev) => finish(ev, false);
  const cancel = () => finish(null, true);
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', cancel);
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
    `<p class="adm-page-sub" style="font-size:12px;margin-top:10px">${escHtml(t('pages.selectHint', 'Cliquez une section, une colonne ou un widget dans la page pour l\'éditer.'))}</p>`;
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
  host.innerHTML = _panelHead(`${t('pages.section', 'Section')} ${si + 1}`, 'rows-3') + `
    <label class="adm-field"><span class="adm-field-label">${escHtml(t('pages.layout', 'Disposition'))}</span>
      <div style="display:flex;gap:5px;flex-wrap:wrap">${LAYOUTS.map((L) => `<button class="adm-btn adm-btn-ghost adm-btn-sm pb-layout" data-w="${L.widths.join('-')}" title="${L.widths.join(' / ')}">${escHtml(L.label)}</button>`).join('')}</div></label>
    <div id="pb-sfields" style="display:flex;flex-direction:column;gap:10px;margin-top:10px"></div>
    <div id="pb-sstyle"></div>
    <div style="display:flex;gap:6px;margin-top:10px">
      <button class="adm-btn adm-btn-ghost adm-btn-sm" id="pb-sec-dup"><i data-lucide="copy"></i> ${escHtml(t('pages.duplicate', 'Dupliquer'))}</button>
      <button class="adm-btn adm-btn-ghost adm-btn-sm" id="pb-sec-del"><i data-lucide="trash-2"></i> ${escHtml(t('pages.delete', 'Supprimer'))}</button>
    </div>`;
  const upd = (fn) => { fn(); _mark(true); _syncFrame(); };
  host.querySelectorAll('.pb-layout').forEach((b) => b.addEventListener('click', () => {
    const widths = b.getAttribute('data-w').split('-').map(Number);
    upd(() => { const old = sec.columns; sec.columns = widths.map((wd, i) => old[i] ? Object.assign(old[i], { width: wd }) : _newColumn(wd)); if (old.length > widths.length) { const extra = old.slice(widths.length).flatMap((c) => c.widgets); sec.columns[sec.columns.length - 1].widgets.push(...extra); } });
    renderSettings();
  }));
  const ctx = _ctlCtx();
  renderFields(el('pb-sfields'), sec, [
    { k: 'props.fullWidth', t: 'check', l: t('pages.fullWidth', 'Pleine largeur') },
    { k: 'props.maxWidth', t: 'slider', l: t('pages.maxWidth', 'Largeur max'), min: 480, max: 1600, step: 20, dv: 1080 },
    { k: 'props.padY', t: 'slider', l: t('pages.padY', 'Marge verticale'), min: 0, max: 240, dv: 48 },
    { k: 'props.gap', t: 'slider', l: t('pages.gap', 'Espace entre colonnes'), min: 0, max: 80, dv: 24 },
    { k: 'props.vAlign', t: 'seg', l: t('pages.vAlign', 'Alignement vertical'), opts: [['stretch', t('pages.va.stretch', 'Étiré')], ['start', t('pages.va.start', 'Haut')], ['center', t('pages.va.center', 'Centre')], ['end', t('pages.va.end', 'Bas')]] },
    { k: 'props.bg', t: 'color', grad: true, l: t('pages.bg', 'Fond') },
  ], ctx);
  _mountStyleGroups(el('pb-sstyle'), sec, 'section', ctx);
  el('pb-sec-dup').addEventListener('click', () => duplicateSection(si));
  el('pb-sec-del').addEventListener('click', () => deleteSection(si));
  refreshIcons(host);
}

function _columnSettings(host, sec, si, ci) {
  const col = sec.columns[ci];
  host.innerHTML = _panelHead(`${t('pages.column', 'Colonne')} ${ci + 1} · ${col.width}/12`, 'columns-2') + `
    <label class="adm-field"><span class="adm-field-label">${escHtml(t('pages.colWidth', 'Largeur (unités /12)'))}</span><input type="range" min="1" max="12" step="1" id="pb-cw" value="${col.width}" class="pbc-range"><span class="adm-page-sub" id="pb-cw-val">${col.width}/12</span></label>
    <div id="pb-cfields" style="display:flex;flex-direction:column;gap:10px;margin-top:6px"></div>
    <button class="adm-btn adm-btn-ghost adm-btn-sm" id="pb-col-card" style="width:100%;justify-content:center;margin-top:10px"><i data-lucide="sparkles"></i> ${escHtml(t('pages.cardPreset', 'Transformer en carte'))}</button>
    <div id="pb-cstyle"></div>
    <div style="display:flex;gap:6px;margin-top:10px">
      <button class="adm-btn adm-btn-ghost adm-btn-sm" id="pb-col-add"><i data-lucide="plus"></i> ${escHtml(t('pages.addColumn', 'Colonne'))}</button>
      ${sec.columns.length > 1 ? `<button class="adm-btn adm-btn-ghost adm-btn-sm" id="pb-col-del"><i data-lucide="trash-2"></i> ${escHtml(t('pages.removeColumn', 'Retirer'))}</button>` : ''}
    </div>`;
  el('pb-cw').addEventListener('input', (e) => {
    const nv = +e.target.value; const other = sec.columns[ci + 1] || sec.columns[ci - 1];
    if (other) { const total = col.width + other.width; other.width = Math.max(1, total - nv); }
    col.width = nv; el('pb-cw-val').textContent = nv + '/12'; _mark(true); _syncFrame();
  });
  const ctx = _ctlCtx();
  col.props = col.props || {};
  renderFields(el('pb-cfields'), col, [
    { k: 'props.vAlign', t: 'seg', l: t('pages.vAlign', 'Alignement vertical'), opts: [['', 'Auto'], ['flex-start', t('pages.va.start', 'Haut')], ['center', t('pages.va.center', 'Centre')], ['flex-end', t('pages.va.end', 'Bas')]] },
    { k: 'props.padding', t: 'slider', l: t('pages.colPad', 'Padding interne'), min: 0, max: 80, dv: 0 },
  ], ctx);
  _mountStyleGroups(el('pb-cstyle'), col, 'column', ctx);
  el('pb-col-card').addEventListener('click', () => {
    col.props = col.props || {};
    col.props.style = Object.assign({}, col.props.style, {
      bg: 'var(--bg-surface)', radius: 12, borderWidth: 1, borderColor: 'var(--border-subtle)',
      shadow: 'sm', padTop: 24, padRight: 24, padBottom: 24, padLeft: 24,
    });
    _mark(true); renderSettings(); _syncFrame();
  });
  el('pb-col-add').addEventListener('click', () => addColumn(si));
  el('pb-col-del')?.addEventListener('click', () => removeColumn(si, ci));
  refreshIcons(host);
}

function _widgetSettings(host, b) {
  const fields = _fields(b.type);
  host.innerHTML = _panelHead(t('pages.block.' + b.type, b.type), 'settings-2') +
    `<div id="pb-wfields" style="display:flex;flex-direction:column;gap:10px"></div>
    <div id="pb-wstyle"></div>
    <div style="display:flex;gap:6px;margin-top:12px">
      <button class="adm-btn adm-btn-ghost adm-btn-sm" id="pb-w-dup"><i data-lucide="copy"></i> ${escHtml(t('pages.duplicate', 'Dupliquer'))}</button>
      <button class="adm-btn adm-btn-ghost adm-btn-sm" id="pb-w-del"><i data-lucide="trash-2"></i> ${escHtml(t('pages.delete', 'Supprimer'))}</button>
    </div>`;
  const ctx = _ctlCtx();
  const fbox = el('pb-wfields');
  if (fields.length) renderFields(fbox, b, fields, ctx);
  else fbox.innerHTML = `<p class="adm-page-sub">${escHtml(t('pages.noSettings', 'Pas de réglages.'))}</p>`;
  _mountStyleGroups(el('pb-wstyle'), b, 'widget', ctx);
  el('pb-w-dup').addEventListener('click', () => duplicateWidget(_sel.si, _sel.ci, _sel.wi));
  el('pb-w-del').addEventListener('click', () => deleteWidget(_sel.si, _sel.ci, _sel.wi));
  refreshIcons(host);
}

// (Field rendering + wiring live in pages-controls.js → renderFields.)

// ── Structural ops (all end in _afterMutate → sidebar + frame sync) ─────
function addSection(widths) {
  _sections.push(_newSection(widths));
  _sel = { si: _sections.length - 1, ci: null, wi: null };
  _side = 'settings';
  _afterMutate();
}
function deleteSection(si) { if (!confirm(t('pages.delSectionConfirm', 'Supprimer cette section ?'))) return; _sections.splice(si, 1); _sel = null; _afterMutate(); }
function duplicateSection(si) { const clone = JSON.parse(JSON.stringify(_sections[si])); clone.id = _id('s'); clone.columns.forEach((c) => { c.id = _id('c'); c.widgets.forEach((w) => w.id = _id('w')); }); _sections.splice(si + 1, 0, clone); _sel = { si: si + 1, ci: null, wi: null }; _afterMutate(); }
function moveSection(si, dir) { const to = si + dir; if (to < 0 || to >= _sections.length) return; const [s] = _sections.splice(si, 1); _sections.splice(to, 0, s); _sel = { si: to, ci: null, wi: null }; _afterMutate(); }
function addColumn(si) { const sec = _sections[si]; if (sec.columns.length >= 6) { toast(t('pages.maxCols', 'Maximum 6 colonnes.'), 'warning'); return; } sec.columns.push(_newColumn(Math.max(1, Math.round(12 / (sec.columns.length + 1))))); _rebalance(sec); _afterMutate(); }
function removeColumn(si, ci) { const sec = _sections[si]; if (sec.columns.length <= 1) return; const [dead] = sec.columns.splice(ci, 1); if (dead.widgets.length && sec.columns[0]) sec.columns[0].widgets.push(...dead.widgets); _rebalance(sec); _sel = { si, ci: null, wi: null }; _afterMutate(); }
function _rebalance(sec) { const n = sec.columns.length; const base = Math.floor(12 / n); let rem = 12 - base * n; sec.columns.forEach((c) => { c.width = base + (rem-- > 0 ? 1 : 0); }); }
function duplicateWidget(si, ci, wi) { const col = _sections[si].columns[ci]; const clone = JSON.parse(JSON.stringify(col.widgets[wi])); clone.id = _id('w'); col.widgets.splice(wi + 1, 0, clone); _sel = { si, ci, wi: wi + 1 }; _afterMutate(); }
function deleteWidget(si, ci, wi) { _sections[si].columns[ci].widgets.splice(wi, 1); _sel = { si, ci, wi: null }; _afterMutate(); }
function addWidgetToSelection(type) {
  let si = _sel ? _sel.si : _sections.length - 1;
  if (si == null || si < 0) { _sections.push(_newSection()); si = _sections.length - 1; }
  const ci = (_sel && _sel.ci != null) ? _sel.ci : 0;
  const col = _sections[si].columns[ci] || _sections[si].columns[0];
  col.widgets.push(_newWidget(type));
  _sel = { si, ci: _sections[si].columns.indexOf(col), wi: col.widgets.length - 1 };
  _side = 'settings';
  _afterMutate();
}

// ── Page management + persistence ───────────────────────────────
function _buildPageList() {
  const custom = (Array.isArray(_instance?.nav?.customPages) ? _instance.nav.customPages : []).map((p) => ({ slug: p.slug, label: (p.label && (p.label[_editLoc] || p.label.en)) || p.slug, builtin: false }));
  _pages = [...SPECIAL.map((s) => ({ slug: s.slug, builtin: true })), ...custom];
}

function _emptyDoc() { return { title: {}, published: { sections: [] }, draft: { sections: [] } }; }

async function selectPage(slug) {
  _slug = slug;
  const data = await apiFetch(`${API_SITE}?action=get&doc=pages/${encodeURIComponent(slug)}`);
  // A MISSING doc comes back as [] on PHP hosts (site.php) and {} on the Python
  // dev server. `typeof [] === 'object'`, so without the Array guard _doc became
  // an ARRAY — then `_doc.draft = …` set a named property that JSON.stringify
  // silently drops (arrays serialize indices only), so save persisted `[]` and
  // every edit vanished on reload. Always normalize to a real doc object.
  _doc = (data && typeof data === 'object' && !Array.isArray(data)) ? data : _emptyDoc();
  const src = (_doc.draft && (Array.isArray(_doc.draft.sections) || Array.isArray(_doc.draft.blocks))) ? _doc.draft : (_doc.published || {});
  _sections = _sanitizeSections(_migrate(src));
  // Built-in pages (home/about) default to static HTML — nothing stored as
  // sections. Showing "blank" would be wrong (the real page is anything but):
  // seed the editable starter template so the surface opens with content. Not
  // marked dirty — nothing changes until the operator saves/publishes.
  _seeded = false;
  if (!_sections.length) {
    const tpl = _defaultTemplate(slug);
    if (tpl.length) { _sections = tpl; _seeded = true; }
  }
  _sel = null;
  _mark(false);
  if (_editorOnly) {
    try { history.replaceState(null, '', `admpan.html?editor=${encodeURIComponent(slug)}`); } catch (_) {}
  }
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
  enterEditor();
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
  if (!_doc || typeof _doc !== 'object' || Array.isArray(_doc)) _doc = _emptyDoc();
  _doc.draft = { sections: _sections };
  _doc.published = _doc.published || { sections: [] };
  const r = await apiFetchStatus(`${API_SITE}?action=save&doc=pages/${encodeURIComponent(_slug)}`, { method: 'POST', body: JSON.stringify(_doc) });
  if (r.ok) { _mark(false); toast(t('pages.draftSaved', 'Brouillon enregistré.'), 'success'); }
  else toast(t('pages.saveError', "Échec de l'enregistrement."), 'error');
}

function _restorePublishBtn(btn) {
  if (!btn) return;
  btn.disabled = false;
  btn.innerHTML = `<i data-lucide="upload"></i> ${escHtml(t('pages.publish', 'Publier'))}`;
  try { refreshIcons(btn.parentElement || document); } catch (_) {}
}

async function publish() {
  // Publishing is a deliberate click and one-click-revertible ("Défaut"); no
  // blocking confirm (an earlier seed-confirm made a cancelled dialog look like
  // "Publish does nothing"). Give clear in-button feedback since the toast is
  // easy to miss in the full-window editor.
  const btn = el('pe-publish');
  if (btn) { btn.disabled = true; btn.innerHTML = `<span class="spinner spinner-sm"></span> ${escHtml(t('pages.publishing', 'Publication…'))}`; }
  if (!_doc || typeof _doc !== 'object' || Array.isArray(_doc)) _doc = _emptyDoc();
  _doc.draft = { sections: _sections };
  const s = await apiFetchStatus(`${API_SITE}?action=save&doc=pages/${encodeURIComponent(_slug)}`, { method: 'POST', body: JSON.stringify(_doc) });
  if (!s.ok) { _restorePublishBtn(btn); toast(t('pages.saveError', "Échec de l'enregistrement."), 'error'); return; }
  const r = await apiFetchStatus(`${API_SITE}?action=publish&doc=pages/${encodeURIComponent(_slug)}`, { method: 'POST', body: '{}' });
  if (r.ok) {
    _mark(false); _doc.published = { sections: JSON.parse(JSON.stringify(_sections)) }; _seeded = false; renderSidebar();
    toast(t('pages.published', 'Page publiée ✓'), 'success');
    if (btn) { btn.disabled = false; btn.innerHTML = `<i data-lucide="check"></i> ${escHtml(t('pages.publishedBtn', 'Publié ✓'))}`; try { refreshIcons(btn.parentElement || document); } catch (_) {} setTimeout(() => _restorePublishBtn(btn), 2600); }
  } else { _restorePublishBtn(btn); toast(t('pages.saveError', "Échec de l'enregistrement."), 'error'); }
}

async function revert() {
  if (!confirm(t('pages.revertConfirm', 'Réinitialiser cette page à son état par défaut ?'))) return;
  const r = await apiFetchStatus(`${API_SITE}?action=reset&doc=pages/${encodeURIComponent(_slug)}`, { method: 'POST', body: '{}' });
  if (r.ok) { toast(t('pages.reverted', 'Réinitialisée.'), 'success'); await selectPage(_slug); }
  else toast(t('pages.saveError', "Échec de l'enregistrement."), 'error');
}

async function load() {
  if (!_bound) { window.addEventListener('message', _onMessage); _bound = true; }
  const inst = await apiFetch(`${API_SITE}?action=get&doc=instance`);
  _instance = (inst && typeof inst === 'object') ? inst : {};
  try { _editLoc = (I18n && I18n.getLanguage) ? I18n.getLanguage() : 'en'; } catch (_) { _editLoc = 'en'; }
  // Pre-load every available locale's dict so the built-in-page starter template
  // can mirror the real landing/about strings in all languages (see _richTemplate).
  try {
    for (const l of _locales()) {
      if (!_langDicts[l.code] && I18n && I18n.loadLanguage) { try { _langDicts[l.code] = await I18n.loadLanguage(l.code); } catch (_) {} }
    }
  } catch (_) {}
  _buildPageList();
  // Dedicated editor tab: admpan.html?editor=<slug> boots straight into the
  // full-window editor for that page (the shell hides its sidebar/topbar).
  const eslug = new URLSearchParams(location.search).get('editor');
  if (eslug && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(eslug)) {
    _editorOnly = true;
    _mode = 'editor';
    _slug = _pages.some((p) => p.slug === eslug) ? eslug : 'home';
    // Dedicated editor tab owns the window → guard against losing unsaved work on
    // close/reload (the in-shell editor kept it in SPA memory; a tab can't).
    if (!_beforeUnloadBound) {
      _beforeUnloadBound = true;
      window.addEventListener('beforeunload', (e) => { if (_dirty) { e.preventDefault(); e.returnValue = ''; } });
    }
  }
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
