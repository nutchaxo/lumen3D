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
import { renderFields, renderGroups } from './pages-controls.js';
import { renderTranslatePanel } from './pages-translate.js';
import { renderVariablesPanel } from './pages-variables.js';

const SPECIAL = [{ slug: 'home', builtin: true }, { slug: 'about', builtin: true }];

let _instance = {};
let _pages = [];
let _slug = null;
let _doc = { title: {}, published: { sections: [] }, draft: { sections: [] } };
let _sections = [];                 // working draft
let _background = null;             // working draft page background { preset, params } | null
let _sel = null;                    // { si, ci, wi } — ci/wi null = column/section scope
let _editLoc = 'en';
let _dirty = false;
let _mode = 'launcher';             // 'launcher' | 'editor'
let _side = 'elements';             // editor sidebar: 'elements' | 'settings'
let _previewDevice = 'desktop';     // editor canvas width: 'desktop' | 'tablet' | 'mobile'
let _settingsTab = 'content';       // settings-panel mode tab: 'content' | 'style' | 'advanced' — persists across selections
let _bound = false;                 // window 'message' listener installed once
let _editorOnly = false;            // dedicated editor tab (admpan.html?editor=<slug>)
let _seeded = false;                // built-in page: showing the starter template (not yet published)
let _beforeUnloadBound = false;     // editor-tab unsaved-work guard installed once
const _langDicts = {};              // locale code → loaded i18n dict (for faithful templates)

const _id = (p) => p + Math.random().toString(36).slice(2, 9);
let _editGen = 0;                   // bumped on every edit — lets an in-flight autosave know if newer edits arrived
function _mark(on) { if (on) _editGen++; _dirty = on; setUnsaved(on); ['pages-save', 'pe-save'].forEach((id) => { const s = el(id); if (s) s.disabled = !on; }); _updateSaveChip(); }
function _locales() { try { if (I18n && I18n.getAvailableLanguages) { const l = I18n.getAvailableLanguages(); if (l.length) return l; } } catch (_) {} return [{ code: 'en', native: 'EN' }, { code: 'fr', native: 'FR' }, { code: 'es', native: 'ES' }]; }
function _lv(v) { if (v == null) return ''; if (typeof v === 'string') return v; if (typeof v === 'object') return v[_editLoc] || ''; return String(v); }

// A frame mutation just happened → mark dirty, snapshot for undo, refresh the
// sidebar (selection may have moved), push the model into the iframe, and
// schedule a debounced draft autosave.
function _afterMutate() { _mark(true); _histPush(); renderSidebar(); _syncFrame(); _requestAutosave(); }

// ── Undo / redo history ─────────────────────────────────────────
// Bounded snapshot stack of the working model (JSON strings so structuredClone
// isn't needed and equality is a cheap string compare). Structural ops push
// immediately via _afterMutate; text/field edits push debounced so a burst of
// typing collapses into a single history entry.
const _HIST_MAX = 60;
let _history = [];
let _histIndex = -1;
let _histTimer = null;
let _lastSavedAt = null;
function _snap() { return JSON.stringify({ s: _sections, b: _background }); }
function _histReset() { _history = [_snap()]; _histIndex = 0; clearTimeout(_histTimer); _histTimer = null; _updateHistButtons(); }
function _histPush() {
  const snap = _snap();
  if (_history[_histIndex] === snap) return;   // nothing actually changed
  _history = _history.slice(0, _histIndex + 1);
  _history.push(snap);
  if (_history.length > _HIST_MAX) _history.shift();
  _histIndex = _history.length - 1;
  _updateHistButtons();
}
function _histPushDebounced() { clearTimeout(_histTimer); _histTimer = setTimeout(() => { _histTimer = null; _histPush(); }, 450); }
function _flushHist() { if (_histTimer) { clearTimeout(_histTimer); _histTimer = null; _histPush(); } }
function _histRestore(snap) {
  let o; try { o = JSON.parse(snap); } catch (_) { return; }
  _sections = Array.isArray(o.s) ? o.s : [];
  _background = o.b || null;
  _sel = null;
  _mark(true); _requestAutosave();
  renderSidebar(); _syncFrame();
  _updateHistButtons();
}
function undo() { _flushHist(); if (_histIndex <= 0) return; _histIndex--; _histRestore(_history[_histIndex]); }
function redo() { if (_histIndex >= _history.length - 1) return; _histIndex++; _histRestore(_history[_histIndex]); }
function _updateHistButtons() {
  const u = el('pe-undo'), r = el('pe-redo');
  if (u) u.disabled = _histIndex <= 0;
  if (r) r.disabled = _histIndex >= _history.length - 1;
}

// ── Save-status chip ────────────────────────────────────────────
function _fmtTime(d) { try { return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); } catch (_) { return ''; } }
function _updateSaveChip() {
  const c = el('pe-status'); if (!c) return;
  if (_dirty) { c.textContent = '● ' + t('pages.unsaved', 'Non enregistré'); c.style.color = 'var(--color-warning,#e6a817)'; }
  else if (_lastSavedAt) { c.textContent = '✓ ' + t('pages.savedAt', 'Enregistré') + ' ' + _fmtTime(_lastSavedAt); c.style.color = 'var(--text-muted,#8a8a9a)'; }
  else { c.textContent = ''; }
}

// ── Editor keyboard shortcuts (active only in editor mode) ───────
let _keysBound = false;
function _onKey(e) {
  if (_mode !== 'editor') return;
  const mod = e.ctrlKey || e.metaKey;
  const tag = (e.target && e.target.tagName) || '';
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(tag) || (e.target && e.target.isContentEditable);
  const k = (e.key || '').toLowerCase();
  if (mod && !e.shiftKey && k === 'z') { e.preventDefault(); undo(); return; }
  if (mod && ((e.shiftKey && k === 'z') || k === 'y')) { e.preventDefault(); redo(); return; }
  if (mod && k === 's') { e.preventDefault(); saveDraft(); return; }
  if (mod && k === 'd') { if (_sel && _sel.wi != null) { e.preventDefault(); duplicateWidget(_sel.si, _sel.ci, _sel.wi); } return; }
  if (mod && k === 'c' && !typing) { if (_sel && _sel.wi != null) { e.preventDefault(); _copyWidget(); } return; }
  if (mod && k === 'v' && !typing) { e.preventDefault(); _pasteWidget(); return; }
  if (!typing && (e.key === 'Delete' || e.key === 'Backspace')) {
    if (_sel && _sel.wi != null) { e.preventDefault(); deleteWidget(_sel.si, _sel.ci, _sel.wi); }
    return;
  }
  if (e.key === 'Escape' && !typing) { if (_sel) { _sel = null; renderSidebar(); _syncFrame(); } }
}

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
  { type: 'badge', icon: 'tag', def: 'Badges', cat: 'basics' },
  { type: 'icon-list', icon: 'list-checks', def: 'Liste à icônes', cat: 'lists' },
  { type: 'profile', icon: 'contact', def: 'Profil', cat: 'content' },
  { type: 'cite-block', icon: 'clipboard-copy', def: 'Citation copiable', cat: 'content' },
  { type: 'tabs', icon: 'panels-top-left', def: 'Onglets', cat: 'lists' },
  { type: 'counter', icon: 'timer', def: 'Compteur animé', cat: 'content' },
  { type: 'video', icon: 'video', def: 'Vidéo', cat: 'content' },
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
    case 'richtext': return { id, type, text: {}, props: { align: 'left', markup: true } };
    case 'hero': return { id, type, text: {}, props: { subtitle: {}, bg: '', align: 'center', titleSize: '', titleColor: '', subSize: '', subColor: '', cta: { text: {}, href: '' }, cta2: { text: {}, href: '' }, badge: { text: {}, icon: '', dot: true }, badgeColor: '', glow: false, glowColor1: '', glowColor2: '' } };
    case 'button': return { id, type, text: {}, props: { href: '#', variant: 'accent', align: 'left', fullWidth: false, icon: '', iconPos: 'left', size: '' } };
    case 'image': return { id, type, props: { src: '', alt: {}, align: 'center', width: '', height: '', fit: '', href: '', caption: {} } };
    case 'icon': return { id, type, props: { name: 'star', size: 48, color: '', align: 'center' } };
    case 'gallery': return { id, type, props: { images: [], cols: '', height: '', gap: '', zoom: false, captions: false } };
    case 'stat-grid': return { id, type, props: { stats: [{ label: {}, source: 'datasetCount', value: '' }], cols: '', cardBg: '', valueColor: '', valueSize: '', labelColor: '', borderColor: '', radius: '', pad: '' } };
    case 'latest-datasets': return { id, type, props: { count: 4, cols: '', thumbHeight: '', showMeta: true, cardBg: '', borderColor: '', radius: '', titleColor: '', hover: false } };
    case 'divider': return { id, type, props: { color: '', thickness: '', width: '', lineStyle: 'solid' } };
    case 'spacer': return { id, type, props: { height: 32 } };
    case 'html': return { id, type, props: { html: {} } };
    case 'feature-card': return { id, type, text: {}, props: { icon: 'sparkles', iconSize: 34, iconColor: '', iconBg: '', iconShape: 'round', desc: {}, link: { text: {}, href: '' }, align: 'left', media: 'icon', href: '' } };
    case 'quote': return { id, type, text: {}, props: { author: {}, role: {}, avatar: '', variant: 'bar', accent: '', label: {}, link: { text: {}, href: '' } } };
    case 'accordion': return { id, type, props: { items: [{ q: {}, a: {} }, { q: {}, a: {} }], single: true, firstOpen: true, iconColor: '', itemBg: '', borderColor: '' } };
    case 'timeline': return { id, type, props: { items: [{ date: {}, title: {}, text: {} }, { date: {}, title: {}, text: {} }], accent: '', lineColor: '' } };
    case 'cta-banner': return { id, type, text: {}, props: { subtitle: {}, bg: '', align: 'left', cta: { text: {}, href: 'explorer.html' }, cta2: { text: {}, href: '' } } };
    case 'badge': return { id, type, props: { items: [{ text: {}, icon: '' }], align: 'left', dot: true, mono: false, size: '', gap: '', pillBg: '', pillColor: '', borderColor: '' } };
    case 'icon-list': return { id, type, props: { items: [{ icon: 'check', text: {}, href: '' }], layout: 'v', iconColor: '', iconSize: '', gap: '', textSize: '' } };
    case 'profile': return { id, type, props: { name: {}, role: {}, desc: {}, mediaKind: 'monogram', monogram: 'AB', img: '', icon: 'user', mediaBg: '', mediaColor: '', mediaSize: '', mediaRadius: '', roleColor: '', nameSize: '', layout: 'h', glowMedia: true } };
    case 'cite-block': return { id, type, props: { title: {}, text: {}, mono: true, copy: true, extraLabel: {}, extra: {} } };
    case 'tabs': return { id, type, props: { items: [{ label: {}, content: {} }, { label: {}, content: {} }], accent: '' } };
    case 'counter': return { id, type, text: {}, props: { value: '100', prefix: '', suffix: '', size: '', color: '', align: 'center' } };
    case 'video': return { id, type, text: {}, props: { src: '', poster: '', width: '', align: 'center', autoplay: false, loop: false } };
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

// Merge two i18n keys into "**Label** Description" per locale (richtext mini-
// markup bold) — used by the About template's "data provenance" line.
function _tplBold(labelKey, descKey) {
  const lab = _tpl(labelKey) || {};
  const desc = _tpl(descKey) || {};
  const codes = new Set([...Object.keys(lab), ...Object.keys(desc)]);
  const out = {};
  codes.forEach((c) => { out[c] = `**${lab[c] || lab.en || ''}** ${desc[c] || desc.en || ''}`; });
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
        { type: 'hero', text: hero, props: { subtitle: _tpl('landing.heroSubtitle'), bg: '', glow: true, cta: { text: _tpl('landing.exploreBtn'), href: 'explorer.html' } } },
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
    if (!title) return null;   // dicts not loaded → caller uses the minimal template
    // Faithful 1:1 reproduction of about.html (SPEC §5.4) — instance-specific
    // content (names, thesis, DOI, e-mails, address, citations) is hardcoded
    // ({en:'…'}); every string with an i18n key uses _tpl so the editor mirrors
    // the live page across every available locale.
    // Fresh object per call — two columns must never share the same style
    // reference (editing one column's padding would otherwise silently mutate
    // the other's too).
    const cardStyle = () => ({ bg: 'var(--bg-surface)', radius: 22, borderWidth: 1, borderColor: 'var(--border-subtle)', shadow: 'md', padTop: 32, padRight: 32, padBottom: 32, padLeft: 32, hover: 'lift' });
    return _sanitizeSections([
      // 1 — Hero (badge = subtitle eyebrow, transparent bg + radius 0 so it sits
      // flush inside the surface section, exactly like .about-hero).
      { props: { fullWidth: false, padY: 72, maxWidth: 1080, gap: 24, vAlign: 'stretch', bg: 'var(--bg-surface)' }, columns: [{ width: 12, widgets: [
        { type: 'hero', text: title, props: {
          badge: { text: _tpl('about.subtitle'), dot: true },
          subtitle: _tpl('about.description'), align: 'left', glow: true, bg: '',
          style: { radius: 0 },
        } },
      ] }] },
      // 2 — Creator & scientific context, two card columns.
      { props: { fullWidth: false, padY: 56, maxWidth: 1080, gap: 24, vAlign: 'stretch', bg: '' }, columns: [
        { width: 6, props: { style: cardStyle() }, widgets: [
          { type: 'profile', props: { name: { en: 'Morgan Climent' }, role: _tpl('about.creatorRole'), monogram: 'MC' } },
          { type: 'richtext', text: _tpl('about.creatorDesc'), props: {} },
          { type: 'richtext', text: _tpl('about.aiAssisted'), props: { style: { fontSize: 11, uppercase: true, letterSpacing: 1, color: 'var(--text-muted)' } } },
          { type: 'badge', props: { items: [{ text: { en: 'Claude' } }, { text: { en: 'Gemini' } }, { text: { en: 'ChatGPT' } }], mono: true, dot: false } },
          { type: 'button', text: _tpl('about.githubBtn'), props: { href: 'https://github.com/nutchaxo/lumen3D', icon: 'github', variant: 'accent' } },
        ] },
        { width: 6, props: { style: cardStyle() }, widgets: [
          { type: 'heading', text: _tpl('about.contextTitle'), props: { level: '2', align: 'left' } },
          { type: 'richtext', text: _tpl('about.contextDesc'), props: {} },
          { type: 'quote', text: { en: 'Origin and flow-mediated remodeling of the murine and human extraembryonic circulation systems' }, props: {
            label: _tpl('about.thesisLabel'),
            author: { en: 'Kristof Van Schoor — IRIBHM, Université libre de Bruxelles' },
            variant: 'bar',
            link: { text: { en: 'Front. Physiol. 2024 · DOI 10.3389/fphys.2024.1395006' }, href: 'https://doi.org/10.3389/fphys.2024.1395006' },
            style: { bg: 'color-mix(in srgb, var(--color-accent) 7%, var(--bg-base))', radius: 16, borderWidth: 1, borderColor: 'color-mix(in srgb, var(--color-accent) 28%, var(--border-subtle))', padTop: 20, padRight: 20, padBottom: 20, padLeft: 24 },
          } },
          { type: 'richtext', text: _tplBold('about.dataLabel', 'about.dataDesc'), props: { markup: true } },
        ] },
      ] },
      // 3 — Institutions: heading + 3 logo/monogram cards.
      { props: { fullWidth: false, padY: 56, maxWidth: 1080, gap: 24, vAlign: 'stretch', bg: 'var(--bg-surface)' }, columns: [{ width: 12, widgets: [
        { type: 'heading', text: _tpl('about.institutionsTitle'), props: { level: '2', align: 'center' } },
        { type: 'richtext', text: _tpl('about.institutionsDesc'), props: { align: 'center' } },
      ] }] },
      { props: { fullWidth: false, padY: 8, maxWidth: 1080, gap: 24, vAlign: 'stretch', bg: 'var(--bg-surface)' }, columns: [
        { width: 4, widgets: [{ type: 'feature-card', text: { en: 'Université libre de Bruxelles' }, props: { media: 'image', img: 'assets/logos/ulb.svg', plateBg: '#FFFFFF', imgH: 74, align: 'center', href: 'https://www.ulb.be', style: { hover: 'lift' } } }] },
        { width: 4, widgets: [{ type: 'feature-card', text: { en: 'IRIBHM — Jacques E. Dumont' }, props: { media: 'image', img: 'assets/logos/iribhm.webp', plateBg: '#FFFFFF', imgH: 60, align: 'center', href: 'https://www.iribhm.org/', style: { hover: 'lift' } } }] },
        { width: 4, widgets: [{ type: 'feature-card', text: { en: 'Migeotte Lab — I. Migeotte (PI)' }, props: { media: 'monogram', monogram: 'IM', align: 'center', href: 'https://www.iribhm.org/research-labs/i-migeotte', style: { hover: 'lift' } } }] },
      ] },
      // 4 — Catalog stats.
      { props: { fullWidth: false, padY: 56, maxWidth: 1080, gap: 24, vAlign: 'stretch', bg: '' }, columns: [{ width: 12, widgets: [
        { type: 'heading', text: _tpl('about.statsTitle'), props: { level: '2', align: 'center' } },
        { type: 'stat-grid', props: { cols: '', stats: [
          { label: _tpl('landing.statsDatasets'), source: 'datasetCount', value: '' },
          { label: _tpl('landing.statsEmbryos'), source: 'specimenCount', value: '' },
          { label: _tpl('landing.statsCells'), source: 'cellCount', value: '' },
          { label: _tpl('landing.statsRegions'), source: 'regionCount', value: '' },
        ], borderColor: 'var(--border-subtle)', radius: 16, valueColor: 'linear-gradient(135deg, var(--color-primary) 0%, var(--color-accent) 100%)' } },
      ] }] },
      // 5 — Explore / quick access.
      { props: { fullWidth: false, padY: 56, maxWidth: 1080, gap: 24, vAlign: 'stretch', bg: 'var(--bg-surface)' }, columns: [{ width: 12, widgets: [
        { type: 'heading', text: _tpl('about.exploreTitle'), props: { level: '2', align: 'center' } },
        { type: 'richtext', text: _tpl('about.exploreDesc'), props: { align: 'center' } },
      ] }] },
      { props: { fullWidth: false, padY: 8, maxWidth: 1080, gap: 24, vAlign: 'stretch', bg: 'var(--bg-surface)' }, columns: [
        { width: 4, widgets: [{ type: 'feature-card', text: _tpl('about.linkExploreTitle'), props: { icon: 'layout-grid', desc: _tpl('about.linkExploreDesc'), link: { text: _tpl('about.open'), href: 'explorer.html' }, align: 'left', style: { hover: 'lift', radius: 18, borderWidth: 1, borderColor: 'var(--border-subtle)' } } }] },
        { width: 4, widgets: [{ type: 'feature-card', text: _tpl('about.linkCompareTitle'), props: { icon: 'columns-2', desc: _tpl('about.linkCompareDesc'), link: { text: _tpl('about.open'), href: 'compare.html' }, align: 'left', style: { hover: 'lift', radius: 18, borderWidth: 1, borderColor: 'var(--border-subtle)' } } }] },
        { width: 4, widgets: [{ type: 'feature-card', text: _tpl('about.linkDownloadTitle'), props: { icon: 'download', desc: _tpl('about.linkDownloadDesc'), link: { text: _tpl('about.open'), href: 'explorer.html' }, align: 'left', style: { hover: 'lift', radius: 18, borderWidth: 1, borderColor: 'var(--border-subtle)' } } }] },
      ] },
      // 6 — How to cite.
      { props: { fullWidth: false, padY: 56, maxWidth: 1080, gap: 24, vAlign: 'stretch', bg: '' }, columns: [{ width: 12, widgets: [
        { type: 'heading', text: _tpl('about.cite'), props: { level: '2', align: 'center' } },
        { type: 'richtext', text: _tpl('about.citeIntro'), props: { align: 'center' } },
      ] }] },
      { props: { fullWidth: false, padY: 8, maxWidth: 1080, gap: 24, vAlign: 'stretch', bg: '' }, columns: [
        { width: 6, widgets: [{ type: 'cite-block', props: {
          title: _tpl('about.citePlatform'),
          text: { en: 'Climent, M. (2026). Lumen3D — IRIBHM Microscopy Platform [Computer software]. Institut de Recherche Interdisciplinaire en Biologie humaine et moléculaire (IRIBHM), Université libre de Bruxelles. https://github.com/nutchaxo/lumen3D' },
        } }] },
        { width: 6, widgets: [{ type: 'cite-block', props: {
          title: _tpl('about.citePublication'),
          text: { en: 'Van Schoor, K., Bruet, E., Vincent Jones, E. A., & Migeotte, I. (2024). Origin and flow-mediated remodeling of the murine and human extraembryonic circulation systems. Frontiers in Physiology, 15, 1395006. https://doi.org/10.3389/fphys.2024.1395006' },
          extraLabel: { en: 'BibTeX' },
          extra: { en: '@article{vanschoor2024extraembryonic,\n  author  = {Van Schoor, Kristof and Bruet, Emmanuel and Vincent Jones, Elizabeth Anne and Migeotte, Isabelle},\n  title   = {Origin and flow-mediated remodeling of the murine and human extraembryonic circulation systems},\n  journal = {Frontiers in Physiology},\n  volume  = {15},\n  pages   = {1395006},\n  year    = {2024},\n  doi     = {10.3389/fphys.2024.1395006}\n}' },
        } }] },
      ] },
      // 7 — Contact.
      { props: { fullWidth: false, padY: 56, maxWidth: 1080, gap: 24, vAlign: 'stretch', bg: 'var(--bg-surface)' }, columns: [{ width: 12, widgets: [
        { type: 'heading', text: _tpl('about.contact'), props: { level: '2', align: 'center' } },
      ] }] },
      { props: { fullWidth: false, padY: 8, maxWidth: 1080, gap: 24, vAlign: 'stretch', bg: 'var(--bg-surface)' }, columns: [{ width: 12, props: {
        style: { bg: 'var(--bg-surface)', borderWidth: 1, borderColor: 'var(--border-subtle)', radius: 20, padTop: 24, padRight: 24, padBottom: 24, padLeft: 24, maxWidth: 640 },
      }, widgets: [
        { type: 'richtext', text: _tpl('about.contactDesc'), props: {} },
        { type: 'icon-list', props: { items: [
          { icon: 'user', text: { en: 'Isabelle Migeotte (PI) — isabelle.migeotte@ulb.be' }, href: 'mailto:isabelle.migeotte@ulb.be' },
          { icon: 'building-2', text: { en: 'IRIBHM — iribhm@ulb.be' }, href: 'mailto:iribhm@ulb.be' },
          { icon: 'map-pin', text: { en: 'Campus Erasme, Route de Lennik 808, 1070 Bruxelles, Belgique' }, href: '' },
        ] } },
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

// ── Field descriptors (rendered by pages-controls.js → renderFields/renderGroups) ─
// Click-first: sliders for every numeric value, segmented buttons for enums,
// the rich color/gradient picker (grad:true) for backgrounds, the Lucide icon
// picker for icons, and the repeatable items editor for lists.
//
// Split Contenu/Style/Avancé (v1.18.0): text/links/items/data → _contentGroups
// (Contenu tab); colors/shapes/layout specific to a widget → _styleGroupsSpecific
// (Style tab, ahead of the generic Texte/Fond & bordure groups); spacing/size/
// hover/visibility/custom-CSS → _advancedGroups (Avancé tab, shared by widget/
// section/column). Field descriptors are rebuilt fresh on every render (never
// cached at module scope) so t()'s labels track the active admin language.
const ALIGN_OPTS = [['left', '', 'align-left'], ['center', '', 'align-center'], ['right', '', 'align-right']];
function _alignField() { return { k: 'props.align', t: 'seg', l: t('pages.align', 'Alignement'), opts: ALIGN_OPTS }; }
function _colsField(max) { return { k: 'props.cols', t: 'slider', l: t('pages.colsAuto', 'Colonnes (auto si vide)'), min: 1, max: max || 8, ph: 'auto', dv: 3 }; }

function _contentGroups(type) {
  const content = t('pages.grp.content', 'Contenu');
  switch (type) {
    case 'heading': return [{ title: content, icon: 'file-text', fields: [
      { k: 'text', t: 'ltext', l: t('pages.text', 'Texte') },
      { k: 'props.level', t: 'seg', l: t('pages.level', 'Niveau'), opts: [['1', 'H1'], ['2', 'H2'], ['3', 'H3'], ['4', 'H4']] },
    ] }];
    case 'richtext': return [{ title: content, icon: 'file-text', fields: [
      { k: 'text', t: 'ltextarea', l: t('pages.text', 'Texte') },
      { k: 'props.markup', t: 'check', l: t('pages.markup', 'Mise en forme') + ' — ' + t('pages.richtextHint', '**gras**, *italique*, [lien](url)') },
    ] }];
    case 'image': return [{ title: content, icon: 'file-text', fields: [
      { k: 'props.src', t: 'media', l: t('pages.image', 'Image') },
      { k: 'props.alt', t: 'ltext', l: t('pages.alt', 'Texte alt') },
      { k: 'props.caption', t: 'ltext', l: t('pages.imgCaption', 'Légende') },
      { k: 'props.href', t: 'text', l: t('pages.linkOpt', 'Lien (option.)') },
    ] }];
    case 'icon': return [{ title: content, icon: 'file-text', fields: [
      { k: 'props.name', t: 'icon', l: t('pages.iconName', 'Icône') },
    ] }];
    case 'button': return [{ title: content, icon: 'file-text', fields: [
      { k: 'text', t: 'ltext', l: t('pages.label', 'Libellé') },
      { k: 'props.href', t: 'text', l: t('pages.href', 'Lien') },
      { k: 'props.icon', t: 'icon', l: t('pages.btn.icon', 'Icône') },
      { k: 'props.iconPos', t: 'seg', l: t('pages.btn.iconPos', "Position de l'icône"), opts: [['left', t('pages.btn.iconLeft', 'Gauche')], ['right', t('pages.btn.iconRight', 'Droite')]] },
    ] }];
    case 'hero': return [
      { title: t('pages.grp.badge', 'Badge'), icon: 'badge-check', fields: [
        { k: 'props.badge.text', t: 'ltext', l: t('pages.hero.badgeText', 'Texte du badge') },
        { k: 'props.badge.icon', t: 'icon', l: t('pages.hero.badgeIcon', 'Icône du badge') },
        { k: 'props.badge.dot', t: 'check', l: t('pages.hero.badgeDot', 'Pastille') },
      ] },
      { title: content, icon: 'file-text', fields: [
        { k: 'text', t: 'ltext', l: t('pages.heroTitle', 'Titre') },
        { k: 'props.subtitle', t: 'ltext', l: t('pages.heroSub', 'Sous-titre') },
      ] },
      { title: t('pages.grp.buttons', 'Boutons'), icon: 'mouse-pointer-click', fields: [
        { k: 'props.cta.text', t: 'ltext', l: t('pages.ctaText', 'Bouton') },
        { k: 'props.cta.href', t: 'text', l: t('pages.ctaHref', 'Lien du bouton') },
        { k: 'props.cta2.text', t: 'ltext', l: t('pages.cta2Text', 'Bouton secondaire') },
        { k: 'props.cta2.href', t: 'text', l: t('pages.cta2Href', 'Lien du bouton secondaire') },
      ] },
    ];
    case 'gallery': return [{ title: t('pages.grp.items', 'Éléments'), icon: 'images', fields: [
      { k: 'props.images', t: 'items', l: t('pages.images', 'Images'),
        item: [{ k: 'src', t: 'media', l: t('pages.image', 'Image') }, { k: 'alt', t: 'ltext', l: t('pages.alt', 'Texte alt') }],
        mk: () => ({ src: '', alt: {} }), addLabel: t('pages.addImage', 'Ajouter une image'),
        summary: (im) => (im.src || '').split('/').pop() },
      { k: 'props.captions', t: 'check', l: t('pages.gal.captions', 'Légendes') },
      { k: 'props.zoom', t: 'check', l: t('pages.gal.zoom', 'Zoom au survol') },
    ] }];
    case 'stat-grid': {
      const SRCOPTS = [['datasetCount', t('pages.srcDatasets', 'Jeux de données')], ['specimenCount', t('pages.srcSpecimen', 'Spécimens')], ['cellCount', t('pages.srcCells', 'Cellules')], ['regionCount', t('pages.srcRegions', 'Régions')], ['custom', t('pages.custom', 'Fixe')]];
      const LIVE = ['datasetCount', 'specimenCount', 'cellCount', 'regionCount'];
      return [{ title: t('pages.grp.items', 'Éléments'), icon: 'bar-chart-2', fields: [
        { k: 'props.stats', t: 'items', l: t('pages.stats', 'Statistiques'),
          item: [
            { k: 'label', t: 'ltext', l: t('pages.statLabel', 'Libellé') },
            { k: 'source', t: 'select', l: t('pages.statSource', 'Source'), opts: SRCOPTS, refresh: true },
            { k: 'value', t: 'text', l: t('pages.statValue', 'Valeur fixe'), ph: '123', dis: (it) => LIVE.includes(it.source) },
            { k: 'bg', t: 'color', grad: true, l: t('pages.statBg', 'Fond de cet encart') },
            { k: 'valueColor', t: 'color', grad: true, l: t('pages.valueColor', 'Couleur des valeurs') },
            { k: 'labelColor', t: 'color', l: t('pages.labelColor', 'Couleur des libellés') },
          ],
          mk: () => ({ label: {}, source: 'custom', value: '', bg: '', valueColor: '', labelColor: '' }), addLabel: t('pages.addStat', 'Ajouter une stat'),
          summary: (st, lv) => lv(st.label) },
      ] }];
    }
    case 'latest-datasets': return [{ title: content, icon: 'layers', fields: [
      { k: 'props.count', t: 'slider', l: t('pages.count', 'Nombre'), min: 1, max: 12, dv: 4 },
      { k: 'props.showMeta', t: 'check', l: t('pages.showMeta', 'Afficher type et date') },
    ] }];
    case 'divider': return [];
    case 'spacer': return [{ title: content, icon: 'move-vertical', fields: [
      { k: 'props.height', t: 'slider', l: t('pages.height', 'Hauteur'), min: 4, max: 400, dv: 32 },
    ] }];
    case 'html': return [{ title: content, icon: 'code', fields: [{ k: 'props.html', t: 'ltextarea', l: 'HTML' }] }];
    case 'feature-card': return [
      { title: t('pages.grp.media', 'Média'), icon: 'image', fields: [
        { k: 'props.media', t: 'seg', l: t('pages.fc.media', 'Média'), refresh: true, opts: [
          ['icon', t('pages.fc.mediaIcon', 'Icône')], ['image', t('pages.fc.mediaImage', 'Image')],
          ['monogram', t('pages.fc.mediaMono', 'Monogramme')], ['none', t('pages.fc.mediaNone', 'Aucun')],
        ] },
        { k: 'props.icon', t: 'icon', l: t('pages.iconName', 'Icône'), showIf: (o) => ((o.props || {}).media || 'icon') === 'icon' },
        { k: 'props.img', t: 'media', l: t('pages.fc.img', 'Image'), showIf: (o) => (o.props || {}).media === 'image' },
        { k: 'props.monogram', t: 'text', l: t('pages.fc.monogram', 'Monogramme'), showIf: (o) => (o.props || {}).media === 'monogram' },
      ] },
      { title: content, icon: 'file-text', fields: [
        { k: 'text', t: 'ltext', l: t('pages.heroTitle', 'Titre') },
        { k: 'props.desc', t: 'ltextarea', l: t('pages.text', 'Texte') },
        { k: 'props.href', t: 'text', l: t('pages.fc.cardHref', 'Lien de la carte') },
        { k: 'props.link.text', t: 'ltext', l: t('pages.fc.linkText', 'Lien (libellé)') },
        { k: 'props.link.href', t: 'text', l: t('pages.href', 'Lien') },
      ] },
    ];
    case 'quote': return [{ title: content, icon: 'quote', fields: [
      { k: 'props.label', t: 'ltext', l: t('pages.qt.label', 'Étiquette (eyebrow)') },
      { k: 'text', t: 'ltextarea', l: t('pages.qt.text', 'Citation') },
      { k: 'props.author', t: 'ltext', l: t('pages.qt.author', 'Auteur') },
      { k: 'props.role', t: 'ltext', l: t('pages.qt.role', 'Rôle / affiliation') },
      { k: 'props.avatar', t: 'media', l: t('pages.qt.avatar', 'Photo (option.)') },
      { k: 'props.link.text', t: 'ltext', l: t('pages.qt.linkText', 'Lien (libellé)') },
      { k: 'props.link.href', t: 'text', l: t('pages.qt.linkHref', 'Lien (URL)') },
    ] }];
    case 'accordion': return [{ title: t('pages.grp.items', 'Éléments'), icon: 'chevrons-down-up', fields: [
      { k: 'props.items', t: 'items', l: t('pages.ac.items', 'Questions / sections'),
        item: [{ k: 'q', t: 'ltext', l: t('pages.ac.q', 'Titre / question') }, { k: 'a', t: 'ltextarea', l: t('pages.ac.a', 'Contenu / réponse') }],
        mk: () => ({ q: {}, a: {} }), addLabel: t('pages.ac.add', 'Ajouter une question'),
        summary: (it, lv) => lv(it.q) },
      { k: 'props.single', t: 'check', l: t('pages.ac.single', 'Une seule ouverte à la fois') },
      { k: 'props.firstOpen', t: 'check', l: t('pages.ac.firstOpen', 'Première ouverte par défaut') },
    ] }];
    case 'timeline': return [{ title: t('pages.grp.items', 'Éléments'), icon: 'milestone', fields: [
      { k: 'props.items', t: 'items', l: t('pages.tl.items', 'Étapes'),
        item: [
          { k: 'date', t: 'ltext', l: t('pages.tl.date', 'Date / étiquette') },
          { k: 'title', t: 'ltext', l: t('pages.heroTitle', 'Titre') },
          { k: 'text', t: 'ltextarea', l: t('pages.text', 'Texte') },
        ],
        mk: () => ({ date: {}, title: {}, text: {} }), addLabel: t('pages.tl.add', 'Ajouter une étape'),
        summary: (it, lv) => lv(it.title) || lv(it.date) },
    ] }];
    case 'cta-banner': return [{ title: content, icon: 'megaphone', fields: [
      { k: 'text', t: 'ltext', l: t('pages.heroTitle', 'Titre') },
      { k: 'props.subtitle', t: 'ltext', l: t('pages.heroSub', 'Sous-titre') },
      { k: 'props.cta.text', t: 'ltext', l: t('pages.ctaText', 'Bouton') },
      { k: 'props.cta.href', t: 'text', l: t('pages.ctaHref', 'Lien du bouton') },
      { k: 'props.cta2.text', t: 'ltext', l: t('pages.cta2Text', 'Bouton secondaire') },
      { k: 'props.cta2.href', t: 'text', l: t('pages.cta2Href', 'Lien du bouton secondaire') },
    ] }];
    case 'badge': return [{ title: t('pages.grp.items', 'Éléments'), icon: 'tag', fields: [
      { k: 'props.items', t: 'items', l: t('pages.bd.items', 'Badges'),
        item: [{ k: 'text', t: 'ltext', l: t('pages.label', 'Libellé') }, { k: 'icon', t: 'icon', l: t('pages.iconName', 'Icône') }],
        mk: () => ({ text: {}, icon: '' }), addLabel: t('pages.bd.addItem', 'Ajouter un badge'),
        summary: (it, lv) => lv(it.text) },
    ] }];
    case 'icon-list': return [{ title: t('pages.grp.items', 'Éléments'), icon: 'list-checks', fields: [
      { k: 'props.items', t: 'items', l: t('pages.il.items', 'Éléments'),
        item: [
          { k: 'icon', t: 'icon', l: t('pages.iconName', 'Icône') },
          { k: 'text', t: 'ltext', l: t('pages.label', 'Libellé') },
          { k: 'href', t: 'text', l: t('pages.href', 'Lien') },
        ],
        mk: () => ({ icon: 'check', text: {}, href: '' }), addLabel: t('pages.il.addItem', 'Ajouter un élément'),
        summary: (it, lv) => lv(it.text) },
    ] }];
    case 'profile': return [{ title: content, icon: 'contact', fields: [
      { k: 'props.name', t: 'ltext', l: t('pages.pf.name', 'Nom') },
      { k: 'props.role', t: 'ltext', l: t('pages.pf.role', 'Rôle') },
      { k: 'props.desc', t: 'ltextarea', l: t('pages.pf.desc', 'Description') },
      { k: 'props.mediaKind', t: 'seg', l: t('pages.pf.mediaKind', 'Média'), refresh: true, opts: [
        ['monogram', t('pages.fc.mediaMono', 'Monogramme')], ['image', t('pages.fc.mediaImage', 'Image')],
        ['icon', t('pages.fc.mediaIcon', 'Icône')], ['none', t('pages.fc.mediaNone', 'Aucun')],
      ] },
      { k: 'props.monogram', t: 'text', l: t('pages.pf.monogram', 'Monogramme'), showIf: (o) => ((o.props || {}).mediaKind || 'monogram') === 'monogram' },
      { k: 'props.img', t: 'media', l: t('pages.pf.image', 'Image'), showIf: (o) => (o.props || {}).mediaKind === 'image' },
      { k: 'props.icon', t: 'icon', l: t('pages.iconName', 'Icône'), showIf: (o) => (o.props || {}).mediaKind === 'icon' },
    ] }];
    case 'cite-block': return [{ title: content, icon: 'clipboard-copy', fields: [
      { k: 'props.title', t: 'ltext', l: t('pages.cb.title', 'Titre') },
      { k: 'props.text', t: 'ltextarea', l: t('pages.cb.text', 'Texte de la citation') },
      { k: 'props.extraLabel', t: 'ltext', l: t('pages.cb.extraLabel', 'Libellé du bloc repliable') },
      { k: 'props.extra', t: 'ltextarea', l: t('pages.cb.extra', 'Contenu repliable (BibTeX…)') },
    ] }];
    case 'tabs': return [{ title: t('pages.grp.items', 'Éléments'), icon: 'panels-top-left', fields: [
      { k: 'props.items', t: 'items', l: t('pages.tabs.items', 'Onglets'),
        item: [{ k: 'label', t: 'ltext', l: t('pages.tabs.label', 'Titre de l\'onglet') }, { k: 'content', t: 'ltextarea', l: t('pages.tabs.content', 'Contenu') }],
        mk: () => ({ label: {}, content: {} }), addLabel: t('pages.tabs.add', 'Ajouter un onglet'),
        summary: (it, lv) => lv(it.label) }] }];
    case 'counter': return [{ title: content, icon: 'timer', fields: [
      { k: 'props.value', t: 'text', l: t('pages.cnt.value', 'Valeur cible'), ph: '100' },
      { k: 'props.prefix', t: 'text', l: t('pages.cnt.prefix', 'Préfixe'), ph: '' },
      { k: 'props.suffix', t: 'text', l: t('pages.cnt.suffix', 'Suffixe'), ph: '%, +, k…' },
      { k: 'text', t: 'ltext', l: t('pages.cnt.label', 'Libellé') },
    ] }];
    case 'video': return [{ title: content, icon: 'video', fields: [
      { k: 'props.src', t: 'text', l: t('pages.vid.src', 'Vidéo (fichier .mp4/.webm ou lien YouTube/Vimeo)') },
      { k: 'props.poster', t: 'media', l: t('pages.vid.poster', 'Image d\'aperçu (poster)') },
    ] }];
    default: return [];
  }
}

// Widget-specific Style groups (colors / shapes / layout) — rendered BEFORE the
// generic Texte / Fond & bordure groups (see _styleGroupsFor).
function _styleGroupsSpecific(type) {
  const align = _alignField();
  switch (type) {
    case 'heading':
    case 'richtext':
      return [{ title: t('pages.grp.format', 'Mise en forme'), icon: 'align-left', fields: [align] }];
    case 'image':
      return [{ title: t('pages.grp.layout', 'Mise en page'), icon: 'layout-grid', fields: [
        { k: 'props.width', t: 'slider', l: t('pages.width', 'Largeur'), min: 40, max: 1200, step: 10, ph: 'auto', dv: 400 },
        { k: 'props.height', t: 'slider', l: t('pages.imgHeight', 'Hauteur'), min: 40, max: 1000, step: 10, ph: 'auto', dv: 300 },
        { k: 'props.fit', t: 'seg', l: t('pages.imgFit', 'Cadrage'), opts: [['', 'Auto'], ['cover', t('pages.fitCover', 'Remplir')], ['contain', t('pages.fitContain', 'Contenir')]] },
        align,
      ] }];
    case 'icon':
      return [{ title: t('pages.grp.layout', 'Mise en page'), icon: 'sliders-horizontal', fields: [
        { k: 'props.size', t: 'slider', l: t('pages.iconSize', 'Taille'), min: 12, max: 160, dv: 48 },
        { k: 'props.color', t: 'color', l: t('pages.stroke', 'Couleur') },
        align,
      ] }];
    case 'button':
      return [{ title: t('pages.grp.buttons', 'Boutons'), icon: 'mouse-pointer-click', fields: [
        { k: 'props.variant', t: 'seg', l: t('pages.style', 'Style'), opts: [['accent', 'Accent'], ['ghost', 'Ghost'], ['outline', t('pages.btn.outline', 'Contour')]] },
        { k: 'props.size', t: 'seg', l: t('pages.btn.size', 'Taille'), opts: [['sm', 'S'], ['', 'M'], ['lg', 'L']] },
        { k: 'props.fullWidth', t: 'check', l: t('pages.fullWidthBtn', 'Pleine largeur') },
        align,
      ] }];
    case 'hero':
      return [
        { title: t('pages.grp.colors', 'Couleurs'), icon: 'palette', fields: [
          { k: 'props.titleSize', t: 'slider', l: t('pages.titleSize', 'Taille du titre'), min: 16, max: 160, ph: 'auto', dv: 44 },
          { k: 'props.titleColor', t: 'color', grad: true, l: t('pages.titleColor', 'Couleur du titre') },
          { k: 'props.subSize', t: 'slider', l: t('pages.subSize', 'Taille du sous-titre'), min: 10, max: 60, ph: 'auto', dv: 20 },
          { k: 'props.subColor', t: 'color', grad: true, l: t('pages.subColor', 'Couleur du sous-titre') },
          { k: 'props.badgeColor', t: 'color', l: t('pages.hero.badgeColor', 'Couleur du badge') },
          { k: 'props.bg', t: 'color', grad: true, l: t('pages.bg', 'Fond') },
          { k: 'props.style.overlay', t: 'color', grad: true, l: t('pages.overlay', 'Voile (couleur sur le fond)') },
          align,
        ] },
        { title: t('pages.grp.glow', 'Halo décoratif'), icon: 'sparkles', fields: [
          { k: 'props.glow', t: 'check', l: t('pages.hero.glow', 'Halo décoratif') },
          { k: 'props.glowColor1', t: 'color', l: t('pages.hero.glowC1', 'Couleur du halo 1') },
          { k: 'props.glowColor2', t: 'color', l: t('pages.hero.glowC2', 'Couleur du halo 2') },
        ] },
      ];
    case 'gallery':
      return [{ title: t('pages.grp.layout', 'Mise en page'), icon: 'layout-grid', fields: [
        _colsField(8),
        { k: 'props.height', t: 'slider', l: t('pages.imgHeight', 'Hauteur'), min: 60, max: 600, step: 10, ph: 'auto', dv: 160 },
        { k: 'props.gap', t: 'slider', l: t('pages.hgap', 'Espacement'), min: 0, max: 40, ph: 'auto', dv: 12 },
      ] }];
    case 'stat-grid':
      return [
        { title: t('pages.grp.layout', 'Mise en page'), icon: 'layout-grid', fields: [_colsField(8)] },
        { title: t('pages.grp.colors', 'Couleurs'), icon: 'palette', fields: [
          { k: 'props.cardBg', t: 'color', grad: true, l: t('pages.cardBg', 'Fond des cartes') },
          { k: 'props.borderColor', t: 'color', l: t('pages.sg.border', 'Bordure des cartes') },
          { k: 'props.radius', t: 'slider', l: t('pages.sg.radius', 'Arrondi des cartes'), min: 0, max: 40, ph: 'auto', dv: 10 },
          { k: 'props.pad', t: 'slider', l: t('pages.sg.pad', 'Padding des cartes'), min: 0, max: 60, ph: 'auto', dv: 20 },
          { k: 'props.valueColor', t: 'color', grad: true, l: t('pages.valueColor', 'Couleur des valeurs') },
          { k: 'props.valueSize', t: 'slider', l: t('pages.valueSize', 'Taille des valeurs'), min: 14, max: 90, ph: 'auto', dv: 40 },
          { k: 'props.labelColor', t: 'color', l: t('pages.labelColor', 'Couleur des libellés') },
        ] },
      ];
    case 'latest-datasets':
      return [
        { title: t('pages.grp.layout', 'Mise en page'), icon: 'layout-grid', fields: [
          _colsField(6),
          { k: 'props.thumbHeight', t: 'slider', l: t('pages.thumbHeight', 'Hauteur des vignettes'), min: 60, max: 320, step: 10, ph: '120', dv: 120 },
        ] },
        { title: t('pages.grp.colors', 'Couleurs'), icon: 'palette', fields: [
          { k: 'props.cardBg', t: 'color', grad: true, l: t('pages.ld.cardBg', 'Fond des cartes') },
          { k: 'props.borderColor', t: 'color', l: t('pages.ld.border', 'Bordure des cartes') },
          { k: 'props.radius', t: 'slider', l: t('pages.ld.radius', 'Arrondi'), min: 0, max: 40, ph: 'auto', dv: 10 },
          { k: 'props.titleColor', t: 'color', l: t('pages.ld.titleColor', 'Couleur des titres') },
          { k: 'props.hover', t: 'check', l: t('pages.ld.hover', 'Lévitation au survol') },
        ] },
      ];
    case 'divider':
      return [{ title: t('pages.grp.colors', 'Couleurs'), icon: 'palette', fields: [
        { k: 'props.color', t: 'color', grad: true, l: t('pages.stroke', 'Couleur') },
        { k: 'props.thickness', t: 'slider', l: t('pages.thickness', 'Épaisseur'), min: 1, max: 12, dv: 1 },
        { k: 'props.width', t: 'slider', l: t('pages.widthPct', 'Largeur'), min: 5, max: 100, step: 5, unit: '%', ph: '100', dv: 100 },
        { k: 'props.lineStyle', t: 'seg', l: t('pages.lineStyle', 'Trait'), opts: [['solid', t('pages.lineSolid', 'Plein')], ['dashed', t('pages.lineDashed', 'Tirets')], ['dotted', t('pages.lineDotted', 'Points')]] },
      ] }];
    case 'feature-card':
      return [
        { title: t('pages.grp.layout', 'Mise en page'), icon: 'layout-grid', fields: [
          { k: 'props.layout', t: 'seg', l: t('pages.layout', 'Disposition'), opts: [['v', t('pages.fc.layoutV', 'Verticale')], ['h', t('pages.fc.layoutH', 'Horizontale')]] },
          align,
        ] },
        { title: t('pages.grp.icon', 'Icône'), icon: 'star', fields: [
          { k: 'props.iconSize', t: 'slider', l: t('pages.iconSize', 'Taille'), min: 14, max: 96, dv: 34, showIf: (o) => ((o.props || {}).media || 'icon') === 'icon' },
          { k: 'props.iconColor', t: 'color', l: t('pages.fc.iconColor', "Couleur de l'icône"), showIf: (o) => ((o.props || {}).media || 'icon') === 'icon' },
          { k: 'props.iconBg', t: 'color', grad: true, l: t('pages.fc.iconBg', "Fond de l'icône"), showIf: (o) => ((o.props || {}).media || 'icon') === 'icon' },
          { k: 'props.iconShape', t: 'seg', l: t('pages.fc.iconShape', 'Forme'), opts: [['round', t('pages.fc.round', 'Rond')], ['square', t('pages.fc.square', 'Carré')]], showIf: (o) => ((o.props || {}).media || 'icon') === 'icon' },
        ] },
        { title: t('pages.grp.media', 'Média'), icon: 'image', fields: [
          { k: 'props.imgH', t: 'slider', l: t('pages.fc.imgH', "Hauteur de l'image"), min: 20, max: 800, ph: 'auto', dv: 96, showIf: (o) => (o.props || {}).media === 'image' },
          { k: 'props.plateBg', t: 'color', grad: true, l: t('pages.fc.plateBg', 'Fond de plaque'), showIf: (o) => (o.props || {}).media === 'image' },
          { k: 'props.monoBg', t: 'color', grad: true, l: t('pages.fc.monoBg', 'Fond du monogramme'), showIf: (o) => (o.props || {}).media === 'monogram' },
          { k: 'props.monoColor', t: 'color', l: t('pages.fc.monoColor', 'Couleur du monogramme'), showIf: (o) => (o.props || {}).media === 'monogram' },
        ] },
        { title: t('pages.grp.colors', 'Couleurs'), icon: 'palette', fields: [
          { k: 'props.titleColor', t: 'color', grad: true, l: t('pages.fc.titleColor', 'Couleur du titre') },
          { k: 'props.titleSize', t: 'slider', l: t('pages.fc.titleSize', 'Taille du titre'), min: 10, max: 60, ph: 'auto', dv: 18 },
          { k: 'props.descColor', t: 'color', grad: true, l: t('pages.fc.descColor', 'Couleur du texte') },
          { k: 'props.linkColor', t: 'color', grad: true, l: t('pages.fc.linkColor', 'Couleur du lien') },
          { k: 'props.linkArrow', t: 'check', l: t('pages.fc.linkArrow', "Flèche du lien") },
        ] },
      ];
    case 'quote':
      return [
        { title: t('pages.grp.layout', 'Mise en page'), icon: 'layout-grid', fields: [
          { k: 'props.variant', t: 'seg', l: t('pages.style', 'Style'), opts: [['bar', t('pages.qt.bar', 'Barre')], ['card', t('pages.qt.card', 'Carte')], ['big', t('pages.big', 'Grand')]] },
        ] },
        { title: t('pages.grp.colors', 'Couleurs'), icon: 'palette', fields: [
          { k: 'props.accent', t: 'color', l: t('pages.qt.accent', "Couleur d'accent") },
        ] },
      ];
    case 'accordion':
      return [{ title: t('pages.grp.colors', 'Couleurs'), icon: 'palette', fields: [
        { k: 'props.iconColor', t: 'color', l: t('pages.ac.chevron', 'Couleur du chevron') },
        { k: 'props.itemBg', t: 'color', grad: true, l: t('pages.ac.itemBg', 'Fond des éléments') },
        { k: 'props.borderColor', t: 'color', l: t('pages.ac.border', 'Bordure') },
      ] }];
    case 'timeline':
      return [{ title: t('pages.grp.colors', 'Couleurs'), icon: 'palette', fields: [
        { k: 'props.accent', t: 'color', l: t('pages.tl.accent', 'Couleur des points') },
        { k: 'props.lineColor', t: 'color', l: t('pages.tl.line', 'Couleur de la ligne') },
      ] }];
    case 'cta-banner':
      return [
        { title: t('pages.grp.colors', 'Couleurs'), icon: 'palette', fields: [
          { k: 'props.bg', t: 'color', grad: true, l: t('pages.bg', 'Fond') },
        ] },
        { title: t('pages.grp.layout', 'Mise en page'), icon: 'layout-grid', fields: [
          { k: 'props.align', t: 'seg', l: t('pages.align', 'Alignement'), opts: [['left', '', 'align-left'], ['center', '', 'align-center']] },
        ] },
      ];
    case 'badge':
      return [{ title: t('pages.grp.badge', 'Badge'), icon: 'tag', fields: [
        { k: 'props.dot', t: 'check', l: t('pages.bd.dot', 'Pastille colorée') },
        { k: 'props.mono', t: 'check', l: t('pages.bd.mono', 'Police mono') },
        { k: 'props.size', t: 'slider', l: t('pages.bd.size', 'Taille du texte'), min: 8, max: 30, step: 0.5, ph: 'auto', dv: 12.5 },
        { k: 'props.gap', t: 'slider', l: t('pages.bd.gap', 'Espacement'), min: 0, max: 40, ph: 'auto', dv: 8 },
        { k: 'props.pillBg', t: 'color', grad: true, l: t('pages.bd.pillBg', 'Fond des badges') },
        { k: 'props.pillColor', t: 'color', l: t('pages.bd.pillColor', 'Texte des badges') },
        { k: 'props.borderColor', t: 'color', l: t('pages.bd.border', 'Bordure') },
        align,
      ] }];
    case 'icon-list':
      return [{ title: t('pages.grp.layout', 'Mise en page'), icon: 'layout-grid', fields: [
        { k: 'props.layout', t: 'seg', l: t('pages.il.layout', 'Disposition'), opts: [['v', t('pages.il.v', 'Vertical')], ['h', t('pages.il.h', 'Horizontal')]] },
        { k: 'props.iconColor', t: 'color', l: t('pages.il.iconColor', 'Couleur des icônes') },
        { k: 'props.iconSize', t: 'slider', l: t('pages.il.iconSize', 'Taille des icônes'), min: 8, max: 80, ph: 'auto', dv: 18 },
        { k: 'props.gap', t: 'slider', l: t('pages.il.gap', 'Espacement'), min: 0, max: 80, ph: 'auto', dv: 12 },
      ] }];
    case 'profile':
      return [{ title: t('pages.grp.layout', 'Mise en page'), icon: 'layout-grid', fields: [
        { k: 'props.layout', t: 'seg', l: t('pages.layout', 'Disposition'), opts: [['h', t('pages.fc.layoutH', 'Horizontale')], ['v', t('pages.fc.layoutV', 'Verticale')]] },
        { k: 'props.mediaSize', t: 'slider', l: t('pages.pf.mediaSize', 'Taille du média'), min: 24, max: 200, ph: 'auto', dv: 64 },
        { k: 'props.mediaRadius', t: 'slider', l: t('pages.pf.mediaRadius', 'Arrondi du média'), min: 0, max: 100, ph: 'auto', dv: 18 },
        { k: 'props.mediaBg', t: 'color', grad: true, l: t('pages.pf.mediaBg', 'Fond du média') },
        { k: 'props.mediaColor', t: 'color', l: t('pages.pf.mediaColor', 'Couleur du média') },
        { k: 'props.glowMedia', t: 'check', l: t('pages.pf.glow', 'Ombre lumineuse') },
        { k: 'props.roleColor', t: 'color', l: t('pages.pf.roleColor', 'Couleur du rôle') },
        { k: 'props.nameSize', t: 'slider', l: t('pages.pf.nameSize', 'Taille du nom'), min: 10, max: 80, ph: 'auto', dv: 22 },
      ] }];
    case 'cite-block':
      return [{ title: t('pages.grp.format', 'Mise en forme'), icon: 'type', fields: [
        { k: 'props.mono', t: 'check', l: t('pages.cb.mono', 'Police mono') },
        { k: 'props.copy', t: 'check', l: t('pages.cb.copyBtn', 'Bouton copier') },
      ] }];
    case 'tabs':
      return [{ title: t('pages.grp.colors', 'Couleurs'), icon: 'palette', fields: [
        { k: 'props.accent', t: 'color', l: t('pages.tabs.accent', 'Couleur de l\'onglet actif') },
      ] }];
    case 'counter':
      return [{ title: t('pages.grp.layout', 'Mise en page'), icon: 'layout-grid', fields: [
        { k: 'props.size', t: 'slider', l: t('pages.cnt.size', 'Taille du nombre'), min: 20, max: 200, ph: 'auto', dv: 48 },
        { k: 'props.color', t: 'color', grad: true, l: t('pages.cnt.color', 'Couleur du nombre') },
        align,
      ] }];
    case 'video':
      return [{ title: t('pages.grp.layout', 'Mise en page'), icon: 'layout-grid', fields: [
        { k: 'props.width', t: 'slider', l: t('pages.width', 'Largeur'), min: 120, max: 1600, step: 10, ph: 'auto', dv: 640 },
        { k: 'props.autoplay', t: 'check', l: t('pages.vid.autoplay', 'Lecture auto (muet, fichier local)') },
        { k: 'props.loop', t: 'check', l: t('pages.vid.loop', 'Boucle') },
        align,
      ] }];
    default:
      return [];
  }
}

// Widget Style tab = widget-specific groups, then the generic Texte/Fond & bordure.
function _styleGroupsFor(w) { return [..._styleGroupsSpecific(w.type), ..._genericStyleGroups('widget')]; }

// ── Style panel (generic, shared by widget / column / section scopes) ────────
// Every field writes props.style.* — compiled to inline CSS by
// PageRenderer.styleCss; the live page and the edit frame render it identically.
// Spacing/size/opacity moved to _advancedGroups (v1.18.0) — only Texte and
// Fond & bordure remain generic Style groups (shadow is now the 'shadow' control).
function _genericStyleGroups(scope) {
  const surface = [
    { k: 'props.style.bg', t: 'color', grad: true, l: t('pages.st.bg', 'Fond') },
    { k: 'props.style.bgImage', t: 'media', l: t('pages.st.bgImage', 'Image de fond') },
    { k: 'props.style.radius', t: 'slider', l: t('pages.st.radius', 'Arrondi'), min: 0, max: 100, ph: 'auto', dv: 12 },
    { k: 'props.style.borderWidth', t: 'slider', l: t('pages.st.borderWidth', 'Bordure'), min: 0, max: 12, ph: '0', dv: 1 },
    { k: 'props.style.borderColor', t: 'color', l: t('pages.st.borderColor', 'Couleur de bordure') },
    { k: 'props.style.borderStyle', t: 'seg', l: t('pages.st.borderStyle', 'Style de bordure'), opts: [['solid', t('pages.lineSolid', 'Plein')], ['dashed', t('pages.lineDashed', 'Tirets')], ['dotted', t('pages.lineDotted', 'Points')]] },
    { t: 'shadow', k: 'props.style.shadow', colorKey: 'props.style.shadowColor', l: t('pages.st.shadow', 'Ombre') },
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
  ];
}

// Avancé tab (widget / section / column, identical shape): linked spacing grids,
// max-width/min-height, hover + opacity, responsive visibility, raw CSS escape hatch.
function _advancedGroups(scope) {
  return [
    { title: t('pages.grp.spacing', 'Espacement'), icon: 'move', fields: [
      { t: 'spacing', l: t('pages.st.padding', 'Padding'), keys: { top: 'props.style.padTop', right: 'props.style.padRight', bottom: 'props.style.padBottom', left: 'props.style.padLeft' }, min: 0, max: 300 },
      { t: 'spacing', l: t('pages.st.margin', 'Marge'), keys: { top: 'props.style.marginTop', right: 'props.style.marginRight', bottom: 'props.style.marginBottom', left: 'props.style.marginLeft' }, min: -200, max: 500 },
    ] },
    { title: t('pages.st.size', 'Taille'), icon: 'scaling', fields: [
      { k: 'props.style.maxWidth', t: 'slider', l: t('pages.st.maxWidth', 'Largeur max'), min: 100, max: 1600, step: 10, ph: 'auto', dv: 800 },
      { k: 'props.style.minHeight', t: 'slider', l: t('pages.st.minHeight', 'Hauteur min'), min: 0, max: 1000, step: 10, ph: 'auto', dv: 0 },
    ] },
    { title: t('pages.grp.effects', 'Effets'), icon: 'sparkles', fields: [
      { k: 'props.style.hover', t: 'seg', l: t('pages.st.hover', 'Effet au survol'), opts: [['', t('pages.st.hovNone', 'Aucun')], ['lift', t('pages.st.hovLift', 'Lévitation')], ['glow', t('pages.st.hovGlow', 'Halo')], ['zoom', t('pages.st.hovZoom', 'Zoom')]] },
      { k: 'props.style.opacity', t: 'slider', l: t('pages.st.opacity', 'Opacité'), min: 0, max: 100, step: 5, unit: '%', ph: '100', dv: 100 },
    ] },
    { title: t('pages.grp.visibility', 'Visibilité'), icon: 'eye-off', fields: [
      { k: 'props.style.hideMobile', t: 'check', l: t('pages.st.hideMobile', 'Masquer sur mobile') },
      { k: 'props.style.hideDesktop', t: 'check', l: t('pages.st.hideDesktop', 'Masquer sur ordinateur') },
    ] },
    { title: t('pages.grp.customCss', 'CSS personnalisé'), icon: 'code', fields: [
      { k: 'props.style.css', t: 'text', l: t('pages.st.customCss', 'CSS inline'), ph: 'letter-spacing:2px; text-shadow:…', hint: t('pages.st.customCssHint', "Déclarations CSS appliquées à l'élément.") },
    ] },
  ];
}

// ── Control context: model writes → dirty + live iframe sync; custom gradient
// presets persist in the PUBLIC instance doc (config/instance.json → editor.*),
// so they follow the site (any browser / operator), not one browser profile.
function _ctlCtx() {
  return {
    loc: _editLoc,
    onChange() { _mark(true); _syncFrame(); _histPushDebounced(); _requestAutosave(); },
    gradients: { get: _gradPresets, save: _saveGradPresets },
  };
}
function _gradPresets() {
  return (_instance && _instance.editor && Array.isArray(_instance.editor.gradientPresets)) ? _instance.editor.gradientPresets : [];
}
async function _saveGradPresets(list) {
  if (!_instance || typeof _instance !== 'object' || Array.isArray(_instance)) _instance = {};
  _instance.editor = (_instance.editor && typeof _instance.editor === 'object') ? _instance.editor : {};
  _instance.editor.gradientPresets = (Array.isArray(list) ? list : []).slice(0, 40);
  await _reconcileInstance();   // don't clobber a concurrent Identity save
  try {
    const r = await apiFetchStatus(`${API_SITE}?action=save&doc=instance`, { method: 'POST', body: JSON.stringify(_instance) });
    if (!r.ok) toast(t('pages.saveError', "Échec de l'enregistrement."), 'error');
    else toast(t('pages.pc.presetSaved', 'Préréglages de dégradés mis à jour.'), 'success');
  } catch (_) {}
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
  const isBuiltin = SPECIAL.some((s) => s.slug === _slug);
  const revertLabel = isBuiltin ? t('pages.revert', 'Défaut') : t('pages.discardDraft', 'Annuler brouillon');
  const revertTitle = isBuiltin ? t('pages.revertTitle', 'Réinitialiser au modèle par défaut') : t('pages.discardDraftTitle', 'Annuler les modifications non publiées');
  root.style.cssText = 'position:fixed;inset:0;z-index:2000;background:var(--bg-base,#0d0d1a);display:flex;flex-direction:column';
  root.innerHTML = `
    <div style="display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid var(--border-subtle,#2a2a3a);flex-wrap:wrap">
      <button class="adm-btn adm-btn-ghost adm-btn-sm" id="pe-exit"><i data-lucide="arrow-left"></i> ${escHtml(t('pages.exitEditor', 'Quitter'))}</button>
      <strong style="font-size:14px;display:inline-flex;align-items:center;gap:6px"><i data-lucide="layout-template"></i> ${escHtml(t('pages.editorTitle', 'Éditeur de page'))}</strong>
      <select class="adm-field-input" id="pe-select" style="width:auto;min-width:160px">${_pageOptions()}</select>
      <label style="display:flex;gap:6px;align-items:center;font-size:13px">${escHtml(t('pages.lang', 'Langue'))}<select class="adm-field-input" id="pe-loc" style="width:auto">${_locOptions()}</select></label>
      <button class="adm-btn adm-btn-ghost adm-btn-sm" id="pe-undo" title="${escHtml(t('pages.undo', 'Annuler') + ' (Ctrl+Z)')}" disabled><i data-lucide="undo-2"></i></button>
      <button class="adm-btn adm-btn-ghost adm-btn-sm" id="pe-redo" title="${escHtml(t('pages.redo', 'Rétablir') + ' (Ctrl+Shift+Z)')}" disabled><i data-lucide="redo-2"></i></button>
      <span style="display:inline-flex;gap:2px;margin-left:2px">
        <button class="adm-btn adm-btn-sm adm-btn-ghost" id="pe-dev-desktop" title="${escHtml(t('pages.dev.desktop', 'Bureau'))}"><i data-lucide="monitor"></i></button>
        <button class="adm-btn adm-btn-sm adm-btn-ghost" id="pe-dev-tablet" title="${escHtml(t('pages.dev.tablet', 'Tablette'))}"><i data-lucide="tablet"></i></button>
        <button class="adm-btn adm-btn-sm adm-btn-ghost" id="pe-dev-mobile" title="${escHtml(t('pages.dev.mobile', 'Mobile'))}"><i data-lucide="smartphone"></i></button>
      </span>
      <span style="flex:1"></span>
      <span id="pe-status" style="font-size:11px;white-space:nowrap;opacity:.9"></span>
      <a class="adm-btn adm-btn-ghost adm-btn-sm" id="pe-open" target="_blank" rel="noopener" href="${escHtml(_viewUrl())}"><i data-lucide="external-link"></i> ${escHtml(t('pages.openTab', 'Ouvrir'))}</a>
      <button class="adm-btn adm-btn-ghost adm-btn-sm" id="pe-revert" title="${escHtml(revertTitle)}"><i data-lucide="rotate-ccw"></i> ${escHtml(revertLabel)}</button>
      <button class="adm-btn adm-btn-ghost adm-btn-sm" id="pe-save" ${_dirty ? '' : 'disabled'}><i data-lucide="save"></i> ${escHtml(t('pages.saveDraft', 'Brouillon'))}</button>
      <button class="adm-btn adm-btn-accent adm-btn-sm" id="pe-publish"><i data-lucide="upload"></i> ${escHtml(t('pages.publish', 'Publier'))}</button>
    </div>
    <div style="flex:1;display:flex;min-height:0">
      <div id="pages-side" style="width:340px;flex:0 0 340px;border-right:1px solid var(--border-subtle,#2a2a3a);padding:12px;overflow:auto"></div>
      <div id="pages-frame-wrap" style="flex:1;min-width:0;position:relative;overflow:auto;background:var(--bg-base,#0d0d1a)">
        <iframe id="pages-frame" title="editor" src="${escHtml(_editUrl())}" style="width:100%;height:100%;border:none;display:block;background:var(--bg-base,#0d0d1a)"></iframe>
      </div>
    </div>`;
  el('pe-exit').addEventListener('click', exitEditor);
  el('pe-select').addEventListener('change', (e) => selectPage(e.target.value));
  el('pe-loc').addEventListener('change', (e) => { _editLoc = e.target.value; renderSidebar(); _syncFrame(); });
  el('pe-revert').addEventListener('click', revert);
  el('pe-undo').addEventListener('click', undo);
  el('pe-redo').addEventListener('click', redo);
  el('pe-save').addEventListener('click', saveDraft);
  el('pe-publish').addEventListener('click', publish);
  ['desktop', 'tablet', 'mobile'].forEach((d) => el('pe-dev-' + d).addEventListener('click', () => { _previewDevice = d; _applyPreviewDevice(); }));
  renderSidebar();
  refreshIcons(root);
  _updateHistButtons();
  _updateSaveChip();
  _applyPreviewDevice();
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

// ── Responsive device preview (constrain the iframe canvas width) ─
const _DEV_W = { desktop: '100%', tablet: '820px', mobile: '390px' };
function _applyPreviewDevice() {
  const f = _frameEl();
  if (f) {
    const w = _DEV_W[_previewDevice] || '100%';
    f.style.width = w;
    f.style.maxWidth = '100%';
    f.style.margin = _previewDevice === 'desktop' ? '0' : '0 auto';
    f.style.boxShadow = _previewDevice === 'desktop' ? 'none' : '0 0 0 1px var(--border-subtle,#2a2a3a)';
  }
  ['desktop', 'tablet', 'mobile'].forEach((d) => {
    const b = el('pe-dev-' + d);
    if (b) { b.classList.toggle('adm-btn-accent', d === _previewDevice); b.classList.toggle('adm-btn-ghost', d !== _previewDevice); }
  });
}

// ── Iframe bridge ───────────────────────────────────────────────
function _frameEl() { return el('pages-frame'); }
function _frameLabels() {
  return {
    section: t('pages.section', 'Section'), moveUp: t('pages.moveUp', 'Monter'), moveDown: t('pages.moveDown', 'Descendre'),
    moveLeft: t('pages.moveLeft', 'Vers la gauche'), moveRight: t('pages.moveRight', 'Vers la droite'), column: t('pages.column', 'Colonne'),
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
  try { f.contentWindow.postMessage({ type: 'LUMEN_EDIT_DOC', sections: _sections, background: _background, sel: _sel, editLoc: _editLoc, messages: _frameLabels(), hasTemplate: _hasTemplateFor(_slug) }, '*'); } catch (_) {}
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
    case 'dupColumn': duplicateColumn(sel.si, sel.ci); break;
    case 'moveColumn': moveColumn(sel.si, sel.ci, arg); break;
    case 'dupWidget': duplicateWidget(sel.si, sel.ci, sel.wi); break;
    case 'delWidget': deleteWidget(sel.si, sel.ci, sel.wi); break;
    case 'setText': _applySetText(sel, arg); break;
  }
}

// Inline on-canvas text edit: the frame double-clicks a title/label, edits it in
// place (contenteditable) and posts the new plain text for the current locale.
// The parent owns the model (one-way data flow), so it writes w.text here.
function _applySetText(sel, arg) {
  const w = _sections[sel.si] && _sections[sel.si].columns[sel.ci] && _sections[sel.si].columns[sel.ci].widgets[sel.wi];
  if (!w) return;
  if (typeof w.text !== 'object' || w.text == null) w.text = {};
  w.text[_editLoc] = (arg && arg.value != null) ? String(arg.value) : '';
  _afterMutate();
}

// ── Sidebar: Elements palette + contextual Settings ─────────────
function renderSidebar() {
  const host = el('pages-side');
  if (!host) return;
  const TABS = [
    ['elements', 'shapes', t('pages.elements', 'Éléments')],
    ['settings', 'sliders-horizontal', t('pages.settings', 'Réglages')],
    ['bg', 'wallpaper', t('pages.bgTab', 'Fond')],
    ['translate', 'languages', t('pages.trTab', 'Traduire')],
    ['vars', 'braces', t('pages.vrTab', 'Variables')],
  ];
  const tab = ([id, icon, label]) => `<button class="adm-btn ${_side === id ? 'adm-btn-accent' : 'adm-btn-ghost'} adm-btn-sm" data-side="${id}" title="${escHtml(label)}" style="flex:1;flex-direction:column;gap:3px;padding:7px 2px"><i data-lucide="${icon}"></i><span style="font-size:9.5px;line-height:1">${escHtml(label)}</span></button>`;
  host.innerHTML = `<div style="display:flex;gap:4px;margin-bottom:12px">${TABS.map(tab).join('')}</div><div id="pages-side-body"></div>`;
  host.querySelectorAll('[data-side]').forEach((b) => b.addEventListener('click', () => { _side = b.getAttribute('data-side'); renderSidebar(); }));
  const body = el('pages-side-body');
  if (_side === 'elements') _renderPalette(body);
  else if (_side === 'bg') _renderBackgroundPanel(body);
  else if (_side === 'translate') {
    renderTranslatePanel(body, {
      sections: _sections, doc: _doc, locales: _locales(), editLoc: _editLoc,
      onChange: () => { _mark(true); _syncFrame(); _histPushDebounced(); },
      requestAutosave: _requestAutosave, t,
    });
  } else if (_side === 'vars') {
    renderVariablesPanel(body, { instance: _instance, saveInstance: _saveInstanceDoc, t });
  } else { body.innerHTML = '<div id="pages-settings"></div>'; renderSettings(); }
  refreshIcons(host);
}

// Silent debounced draft autosave (used by the Traduire panel: translations
// are many small edits — saving each one immediately would spam the API).
let _autosaveTimer = null;
function _cancelAutosave() { clearTimeout(_autosaveTimer); _autosaveTimer = null; }
function _requestAutosave() {
  clearTimeout(_autosaveTimer);
  _autosaveTimer = setTimeout(async () => {
    if (!_doc || typeof _doc !== 'object' || Array.isArray(_doc)) _doc = _emptyDoc();
    _doc.draft = _draftSource();
    _doc.published = _doc.published || { sections: [] };
    // Capture the edit generation at serialize time: edits made DURING the
    // network round-trip aren't in this payload, so only clear the dirty flag
    // if nothing changed since (else the beforeunload guard would disarm with
    // unsaved edits still pending).
    const gen = _editGen;
    const r = await apiFetchStatus(`${API_SITE}?action=save&doc=pages/${encodeURIComponent(_slug)}`, { method: 'POST', body: JSON.stringify(_doc) });
    if (r.ok && _editGen === gen) { _lastSavedAt = new Date(); _mark(false); }
  }, 1200);
}

// The editor tab holds a single _instance snapshot for its whole lifetime and
// never re-fetches; a concurrent Identity (tab-branding) save in another tab
// would be clobbered by a full-snapshot POST. Before persisting our own keys,
// pull in concurrent changes to the keys THIS tab does not own — keeping the
// live _instance object identity stable (the Variables panel holds it by ref).
const _INSTANCE_OWNED = new Set(['variables', 'editor']);
async function _reconcileInstance() {
  try {
    const d = await apiFetch(`${API_SITE}?action=get&doc=instance`);
    if (d && typeof d === 'object' && !Array.isArray(d)) {
      for (const k of Object.keys(d)) if (!_INSTANCE_OWNED.has(k)) _instance[k] = d[k];
    }
  } catch (_) { /* offline / first-run → keep our snapshot */ }
}

async function _saveInstanceDoc() {
  if (!_instance || typeof _instance !== 'object' || Array.isArray(_instance)) _instance = {};
  await _reconcileInstance();
  const r = await apiFetchStatus(`${API_SITE}?action=save&doc=instance`, { method: 'POST', body: JSON.stringify(_instance) });
  if (r.ok) { try { if (typeof InstanceConfig !== 'undefined') await InstanceConfig.load(); } catch (_) {} }
  return r.ok;
}

// The draft/published SOURCE object: sections + optional page background.
function _draftSource() {
  const src = { sections: _sections };
  if (_background && _background.preset) src.background = _background;
  return src;
}

// ── Fond (page background) panel ───────────────────────────────
const BG_PARAM_LABELS = {
  color: 'Couleur', color2: 'Couleur 2', count: 'Quantité', size: 'Taille', speed: 'Vitesse',
  opacity: 'Opacité', amplitude: 'Amplitude', spacing: 'Espacement', radius: 'Rayon',
  linkDist: 'Distance de liaison', length: 'Longueur', intensity: 'Intensité',
  frequency: 'Fréquence', depth: 'Profondeur', thickness: 'Épaisseur',
};
function _bgPresets() {
  try { if (typeof PageBackground !== 'undefined' && Array.isArray(PageBackground.PRESETS)) return PageBackground.PRESETS; } catch (_) {}
  return [];
}
function _renderBackgroundPanel(body) {
  const presets = _bgPresets();
  body.innerHTML = `
    <p class="adm-page-sub" style="font-size:12px;margin:0 0 10px">${escHtml(t('pages.bgHint', 'Un fond animé discret derrière toute la page. Respecte automatiquement « réduire les animations ».'))}</p>
    <div id="pb-bg-grid" style="display:grid;grid-template-columns:1fr 1fr;gap:6px"></div>
    <div id="pb-bg-params" style="margin-top:12px"></div>`;
  const grid = el('pb-bg-grid');
  const cur = _background && _background.preset;
  const mkTile = (key, label, badge, icon) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'adm-btn adm-btn-sm ' + ((cur || '') === key ? 'adm-btn-accent' : 'adm-btn-ghost');
    b.style.cssText = 'flex-direction:column;gap:3px;padding:9px 4px;justify-content:center';
    const ic = document.createElement('i');
    ic.setAttribute('data-lucide', icon);
    b.appendChild(ic);
    const sp = document.createElement('span');
    sp.style.cssText = 'font-size:10.5px;line-height:1.15';
    sp.textContent = label;
    b.appendChild(sp);
    if (badge) {
      const bd = document.createElement('span');
      bd.style.cssText = 'font-size:8.5px;letter-spacing:.06em;text-transform:uppercase;opacity:.6';
      bd.textContent = badge;
      b.appendChild(bd);
    }
    return b;
  };
  const none = mkTile('', t('pages.bgNone', 'Aucun fond'), '', 'circle-slash-2');
  none.addEventListener('click', () => { _background = null; _mark(true); _syncFrame(); _renderBackgroundPanel(body); refreshIcons(body); });
  grid.appendChild(none);
  const ICONS = { drift: 'sparkles', waves: 'waves', aurora: 'cloud-sun', stars: 'star', grid: 'grip', constellation: 'share-2', orbs: 'circle-dot', ripples: 'radio', flow: 'wind', spotlight: 'sun' };
  presets.forEach((ps) => {
    const tile = mkTile(ps.key, t('pages.bgpreset.' + ps.key, ps.name), ps.mode === 'mouse' ? t('pages.bgMouse', 'Souris') : t('pages.bgPassive', 'Passif'), ICONS[ps.key] || 'sparkles');
    tile.addEventListener('click', () => {
      _background = { preset: ps.key, params: {} };
      _mark(true); _syncFrame();
      _renderBackgroundPanel(body); refreshIcons(body);
    });
    grid.appendChild(tile);
  });
  const paramsBox = el('pb-bg-params');
  if (cur) {
    const ps = presets.find((x) => x.key === cur);
    if (ps && Array.isArray(ps.params) && ps.params.length) {
      const head = document.createElement('div');
      head.className = 'adm-field-label';
      head.style.cssText = 'margin-bottom:8px';
      head.textContent = t('pages.bgParams', 'Paramètres') + ' — ' + t('pages.bgpreset.' + ps.key, ps.name);
      paramsBox.appendChild(head);
      const form = document.createElement('div');
      form.style.cssText = 'display:flex;flex-direction:column;gap:10px';
      _background.params = (_background.params && typeof _background.params === 'object') ? _background.params : {};
      const fields = ps.params.map((pd) => ({
        k: 'params.' + pd.k,
        t: pd.t === 'color' ? 'color' : 'slider',
        grad: !!pd.grad,
        l: t('pages.bgp.' + pd.lk, BG_PARAM_LABELS[pd.lk] || pd.lk),
        min: pd.min, max: pd.max, step: pd.step, unit: pd.unit, dv: pd.dv,
        ph: pd.t === 'color' ? undefined : String(pd.dv),
      }));
      renderFields(form, _background, fields, _ctlCtx());
      paramsBox.appendChild(form);
    }
  }
  refreshIcons(body);
}

function _renderPalette(body) {
  const seedNote = _seeded
    ? `<div style="font-size:11.5px;line-height:1.45;padding:8px 10px;margin:0 0 10px;border:1px solid var(--color-primary,#2F6BFF);border-radius:8px;background:color-mix(in srgb,var(--color-primary,#2F6BFF) 10%,transparent)">${escHtml(t('pages.seedNotice', 'Modèle de départ — la page publiée garde sa mise en page intégrée tant que vous ne publiez pas cette version.'))}</div>`
    : '';
  body.innerHTML = `${seedNote}<p class="adm-page-sub" style="font-size:12px;margin:0 0 8px">${escHtml(t('pages.dragOrClick', 'Cliquez ou glissez un élément dans la page.'))}</p>` +
    `<input type="search" id="pages-palette-search" class="adm-field-input" autocomplete="off" placeholder="${escHtml(t('pages.searchWidgets', 'Rechercher un élément…'))}" style="margin:0 0 10px">` +
    `<div id="pages-palette"></div>`;
  const wrap = el('pages-palette');
  const build = (q) => {
    q = (q || '').trim().toLowerCase();
    wrap.textContent = '';
    let any = false;
    PALETTE_CATS.forEach(([cat, catDef]) => {
      const items = PALETTE.filter((b) => b.cat === cat && (!q || t('pages.block.' + b.type, b.def).toLowerCase().includes(q) || b.type.includes(q)));
      if (!items.length) return;
      any = true;
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
        // Keyboard path: pointerdown never fires for Enter/Space, so add the widget
        // directly (no double-add — the mouse click-to-add lives in the pointerup
        // branch of _startPaletteDrag, which a keyboard activation never triggers).
        btn.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); addWidgetToSelection(b.type); } });
        grid.appendChild(btn);
      });
      wrap.appendChild(grid);
    });
    if (!any) { const none = document.createElement('p'); none.className = 'adm-page-sub'; none.style.cssText = 'font-size:12px'; none.textContent = t('pages.noWidgetMatch', 'Aucun élément.'); wrap.appendChild(none); }
    refreshIcons(wrap);
  };
  build('');
  const search = el('pages-palette-search');
  if (search) search.addEventListener('input', (e) => build(e.target.value));
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
  // Reconcile BEFORE mutating: nav is not an owned key, so pull the fresh copy
  // in first, then set our one flag on it — otherwise reconcile would overwrite
  // the change we just made.
  await _reconcileInstance();
  const pg = (_instance.nav && Array.isArray(_instance.nav.customPages)) ? _instance.nav.customPages.find((p) => p.slug === slug) : null;
  if (!pg) return;
  pg.show = show;
  const r = await apiFetchStatus(`${API_SITE}?action=save&doc=instance`, { method: 'POST', body: JSON.stringify(_instance) });
  if (r.ok) {
    try { if (typeof InstanceConfig !== 'undefined') await InstanceConfig.load(); } catch (_) {}
    toast(show ? t('pages.pageShown', 'Page affichée dans le menu.') : t('pages.pageHidden', 'Page masquée du menu.'), 'success');
  } else toast(t('pages.saveError', "Échec de l'enregistrement."), 'error');
}

// ── Settings-panel chrome: header (icon+title+actions), breadcrumbs, mode tabs ─
// Shared by widget / section / column so the three settings panels have
// visually identical structure (SPEC §5.1: "même structure 3 onglets").
function _proHead(icon, title, actions) {
  const acts = (actions || []).map(([key, label, ic]) => `<button type="button" class="pbc-mini" data-headact="${escHtml(key)}" title="${escHtml(label)}"><i data-lucide="${ic}"></i></button>`).join('');
  return `<div class="pbc-head"><span class="pbc-head-icon"><i data-lucide="${icon}"></i></span><span class="pbc-head-title">${escHtml(title)}</span><span class="pbc-head-actions">${acts}</span></div>`;
}
function _bindHeadActions(host, handlers) {
  host.querySelectorAll('[data-headact]').forEach((b) => b.addEventListener('click', () => { const fn = handlers[b.getAttribute('data-headact')]; if (fn) fn(); }));
}

// Breadcrumb trail: "Section N › Colonne N › Widget". Every crumb is clickable
// (including the current one — a no-op re-select), so the operator can jump
// back up to the section/column from a deeply nested widget.
function _crumbItems(si, ci, wi) {
  const items = [];
  if (si != null && _sections[si]) items.push({ sel: { si, ci: null, wi: null }, label: `${t('pages.section', 'Section')} ${si + 1}` });
  if (ci != null && _sections[si] && _sections[si].columns[ci]) items.push({ sel: { si, ci, wi: null }, label: `${t('pages.column', 'Colonne')} ${ci + 1}` });
  if (wi != null) {
    const w = _sections[si]?.columns[ci]?.widgets[wi];
    items.push({ sel: { si, ci, wi }, label: w ? t('pages.block.' + w.type, w.type) : '' });
  }
  return items;
}
function _crumbsHtml(si, ci, wi) {
  const items = _crumbItems(si, ci, wi);
  return `<div class="pbc-crumbs">${items.map((it, i) => (i > 0 ? '<span class="pbc-crumbs-sep">›</span>' : '') + `<button type="button" data-crumb="${i}">${escHtml(it.label)}</button>`).join('')}</div>`;
}
function _bindCrumbs(host, si, ci, wi) {
  const items = _crumbItems(si, ci, wi);
  host.querySelectorAll('[data-crumb]').forEach((btn) => {
    const idx = +btn.getAttribute('data-crumb');
    btn.addEventListener('click', () => { const it = items[idx]; if (!it) return; _sel = it.sel; _side = 'settings'; renderSidebar(); _syncFrame(); });
  });
}

// Contenu / Style / Avancé mode tabs. State is module-level (_settingsTab) so
// it survives re-selecting a different widget/section/column.
const _SETTINGS_TABS = [['content', 'pencil'], ['style', 'brush'], ['advanced', 'settings-2']];
function _tabsHtml() {
  return `<div class="pbc-tabs" role="tablist">${_SETTINGS_TABS.map(([id, icon]) => `<button type="button" role="tab" aria-selected="${_settingsTab === id ? 'true' : 'false'}" class="${_settingsTab === id ? 'on' : ''}" data-tab="${id}"><i data-lucide="${icon}"></i><span>${escHtml(t('pages.tab.' + id, id))}</span></button>`).join('')}</div>`;
}
function _bindTabs(host) {
  host.querySelectorAll('[data-tab]').forEach((btn) => btn.addEventListener('click', () => { _settingsTab = btn.getAttribute('data-tab'); renderSettings(); }));
}

// Renders the active tab's body into `host`. `contentFn(host, ctx)` overrides
// the Contenu tab for section/column (which mix custom controls — layout
// picker, width slider — with plain field groups); widgets always use the
// generic _contentGroups(type). Style/Avancé are always renderGroups-driven.
function _drawTabBody(host, obj, scope, ctx, contentFn) {
  if (!host) return;
  host.textContent = '';
  const groupCtx = Object.assign({}, ctx, { groupKey: (scope === 'widget' ? obj.type : scope) + '|' + _settingsTab });
  if (_settingsTab === 'content') {
    if (contentFn) contentFn(host, groupCtx);
    else renderGroups(host, obj, _contentGroups(obj.type), groupCtx);
  } else if (_settingsTab === 'style') {
    renderGroups(host, obj, scope === 'widget' ? _styleGroupsFor(obj) : _genericStyleGroups(scope), groupCtx);
  } else {
    renderGroups(host, obj, _advancedGroups(scope), groupCtx);
  }
}

// Section Contenu tab: layout picker (column-count buttons) + the section-wide
// fields (fullWidth/maxWidth/padY/gap/vAlign/bg) — not a plain field group
// because the layout buttons rebuild `sec.columns` rather than writing a path.
function _sectionContentBody(host, sec, ctx) {
  const layoutBox = document.createElement('div');
  layoutBox.className = 'adm-field';
  layoutBox.innerHTML = `<span class="adm-field-label">${escHtml(t('pages.layout', 'Disposition'))}</span>` +
    `<div style="display:flex;gap:5px;flex-wrap:wrap">${LAYOUTS.map((L) => `<button type="button" class="adm-btn adm-btn-ghost adm-btn-sm pb-layout" data-w="${L.widths.join('-')}" title="${L.widths.join(' / ')}">${escHtml(L.label)}</button>`).join('')}</div>`;
  host.appendChild(layoutBox);
  layoutBox.querySelectorAll('.pb-layout').forEach((btn) => btn.addEventListener('click', () => {
    const widths = btn.getAttribute('data-w').split('-').map(Number);
    const old = sec.columns;
    sec.columns = widths.map((wd, i) => (old[i] ? Object.assign(old[i], { width: wd }) : _newColumn(wd)));
    if (old.length > widths.length) { const extra = old.slice(widths.length).flatMap((c) => c.widgets); sec.columns[sec.columns.length - 1].widgets.push(...extra); }
    _mark(true); renderSettings(); _syncFrame();
  }));
  const fbox = document.createElement('div');
  fbox.style.cssText = 'display:flex;flex-direction:column;gap:10px;margin-top:10px';
  host.appendChild(fbox);
  renderFields(fbox, sec, [
    { k: 'props.fullWidth', t: 'check', l: t('pages.fullWidth', 'Pleine largeur') },
    { k: 'props.maxWidth', t: 'slider', l: t('pages.maxWidth', 'Largeur max'), min: 480, max: 1600, step: 20, dv: 1080 },
    { k: 'props.padY', t: 'slider', l: t('pages.padY', 'Marge verticale'), min: 0, max: 240, dv: 48 },
    { k: 'props.gap', t: 'slider', l: t('pages.gap', 'Espace entre colonnes'), min: 0, max: 80, dv: 24 },
    { k: 'props.vAlign', t: 'seg', l: t('pages.vAlign', 'Alignement vertical'), opts: [['stretch', t('pages.va.stretch', 'Étiré')], ['start', t('pages.va.start', 'Haut')], ['center', t('pages.va.center', 'Centre')], ['end', t('pages.va.end', 'Bas')]] },
    { k: 'props.bg', t: 'color', grad: true, l: t('pages.bg', 'Fond') },
  ], ctx);
  refreshIcons(host);
}

// Column Contenu tab: width slider (rebalances the sibling column) + vAlign +
// inner padding + "Turn into a card" preset button.
function _columnContentBody(host, sec, si, ci, col, ctx) {
  const wrap = document.createElement('label');
  wrap.className = 'adm-field';
  wrap.innerHTML = `<span class="adm-field-label">${escHtml(t('pages.colWidth', 'Largeur (unités /12)'))}</span>` +
    `<input type="range" min="1" max="12" step="1" class="pbc-range" id="pb-cw"><span class="adm-page-sub" id="pb-cw-val">${col.width}/12</span>`;
  host.appendChild(wrap);
  const rng = wrap.querySelector('#pb-cw');
  const valEl = wrap.querySelector('#pb-cw-val');
  rng.value = col.width;
  rng.addEventListener('input', () => {
    const nv = +rng.value;
    const other = sec.columns[ci + 1] || sec.columns[ci - 1];
    if (other) { const total = col.width + other.width; other.width = Math.max(1, total - nv); }
    col.width = nv;
    if (valEl) valEl.textContent = nv + '/12';
    _mark(true); _syncFrame();
  });
  const fbox = document.createElement('div');
  fbox.style.cssText = 'display:flex;flex-direction:column;gap:10px;margin-top:10px';
  host.appendChild(fbox);
  renderFields(fbox, col, [
    { k: 'props.vAlign', t: 'seg', l: t('pages.vAlign', 'Alignement vertical'), opts: [['', 'Auto'], ['flex-start', t('pages.va.start', 'Haut')], ['center', t('pages.va.center', 'Centre')], ['flex-end', t('pages.va.end', 'Bas')]] },
    { k: 'props.padding', t: 'slider', l: t('pages.colPad', 'Padding interne'), min: 0, max: 80, dv: 0 },
  ], ctx);
  const cardBtn = document.createElement('button');
  cardBtn.type = 'button';
  cardBtn.className = 'adm-btn adm-btn-ghost adm-btn-sm';
  cardBtn.style.cssText = 'width:100%;justify-content:center;margin-top:4px';
  cardBtn.innerHTML = `<i data-lucide="sparkles"></i> ${escHtml(t('pages.cardPreset', 'Transformer en carte'))}`;
  cardBtn.addEventListener('click', () => {
    col.props.style = Object.assign({}, col.props.style, {
      bg: 'var(--bg-surface)', radius: 12, borderWidth: 1, borderColor: 'var(--border-subtle)',
      shadow: 'sm', padTop: 24, padRight: 24, padBottom: 24, padLeft: 24,
    });
    _mark(true); renderSettings(); _syncFrame();
  });
  host.appendChild(cardBtn);
  refreshIcons(host);
}

function _sectionSettings(host, sec, si) {
  host.innerHTML = _proHead('rows-3', `${t('pages.section', 'Section')} ${si + 1}`, [
    ['dup', t('pages.duplicate', 'Dupliquer'), 'copy'],
    ['del', t('pages.delete', 'Supprimer'), 'trash-2'],
  ]) + _crumbsHtml(si, null, null) + _tabsHtml() + `<div id="pbc-tabbody" style="margin-top:12px"></div>`;
  _bindHeadActions(host, { dup: () => duplicateSection(si), del: () => deleteSection(si) });
  _bindCrumbs(host, si, null, null);
  _bindTabs(host);
  const ctx = _ctlCtx();
  _drawTabBody(el('pbc-tabbody'), sec, 'section', ctx, (h, gctx) => _sectionContentBody(h, sec, gctx));
  refreshIcons(host);
}

function _columnSettings(host, sec, si, ci) {
  const col = sec.columns[ci];
  col.props = col.props || {};
  const actions = [];
  if (sec.columns.length > 1) actions.push(['del', t('pages.removeColumn', 'Retirer'), 'trash-2']);
  actions.push(['add', t('pages.addColumn', 'Colonne'), 'plus']);
  host.innerHTML = _proHead('columns-2', `${t('pages.column', 'Colonne')} ${ci + 1} · ${col.width}/12`, actions) +
    _crumbsHtml(si, ci, null) + _tabsHtml() + `<div id="pbc-tabbody" style="margin-top:12px"></div>`;
  _bindHeadActions(host, { del: () => removeColumn(si, ci), add: () => addColumn(si) });
  _bindCrumbs(host, si, ci, null);
  _bindTabs(host);
  const ctx = _ctlCtx();
  _drawTabBody(el('pbc-tabbody'), col, 'column', ctx, (h, gctx) => _columnContentBody(h, sec, si, ci, col, gctx));
  refreshIcons(host);
}

function _widgetSettings(host, b) {
  const pal = PALETTE.find((p) => p.type === b.type);
  host.innerHTML = _proHead(pal ? pal.icon : 'square', t('pages.block.' + b.type, b.type), [
    ['dup', t('pages.duplicate', 'Dupliquer'), 'copy'],
    ['del', t('pages.delete', 'Supprimer'), 'trash-2'],
  ]) + _crumbsHtml(_sel.si, _sel.ci, _sel.wi) + _tabsHtml() + `<div id="pbc-tabbody" style="margin-top:12px"></div>`;
  _bindHeadActions(host, { dup: () => duplicateWidget(_sel.si, _sel.ci, _sel.wi), del: () => deleteWidget(_sel.si, _sel.ci, _sel.wi) });
  _bindCrumbs(host, _sel.si, _sel.ci, _sel.wi);
  _bindTabs(host);
  const ctx = _ctlCtx();
  _drawTabBody(el('pbc-tabbody'), b, 'widget', ctx);
  refreshIcons(host);
}

// (Field rendering + wiring live in pages-controls.js → renderFields/renderGroups.)

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
function duplicateColumn(si, ci) { const sec = _sections[si]; if (!sec) return; if (sec.columns.length >= 6) { toast(t('pages.maxCols', 'Maximum 6 colonnes.'), 'warning'); return; } const clone = JSON.parse(JSON.stringify(sec.columns[ci])); clone.id = _id('c'); (clone.widgets || []).forEach((w) => (w.id = _id('w'))); sec.columns.splice(ci + 1, 0, clone); _rebalance(sec); _sel = { si, ci: ci + 1, wi: null }; _afterMutate(); }
function moveColumn(si, ci, dir) { const sec = _sections[si]; if (!sec) return; const to = ci + dir; if (to < 0 || to >= sec.columns.length) return; const [c] = sec.columns.splice(ci, 1); sec.columns.splice(to, 0, c); _sel = { si, ci: to, wi: null }; _afterMutate(); }
function _rebalance(sec) { const n = sec.columns.length; const base = Math.floor(12 / n); let rem = 12 - base * n; sec.columns.forEach((c) => { c.width = base + (rem-- > 0 ? 1 : 0); }); }
function duplicateWidget(si, ci, wi) { const col = _sections[si].columns[ci]; const clone = JSON.parse(JSON.stringify(col.widgets[wi])); clone.id = _id('w'); col.widgets.splice(wi + 1, 0, clone); _sel = { si, ci, wi: wi + 1 }; _afterMutate(); }
function deleteWidget(si, ci, wi) { _sections[si].columns[ci].widgets.splice(wi, 1); _sel = { si, ci, wi: null }; _afterMutate(); }
// ── Copy / paste widgets (sessionStorage clipboard → survives the per-page
// editor-tab reload, so it works across pages) ──────────────────
const _CLIP_KEY = 'lumenWidgetClip';
function _copyWidget() {
  const w = _selWidget(); if (!w) return;
  try { sessionStorage.setItem(_CLIP_KEY, JSON.stringify(w)); toast(t('pages.copied', 'Élément copié.'), 'success'); } catch (_) {}
}
function _pasteWidget() {
  let w = null; try { w = JSON.parse(sessionStorage.getItem(_CLIP_KEY) || 'null'); } catch (_) {}
  if (!w || !w.type) return;
  let si = _sel ? _sel.si : _sections.length - 1;
  if (si == null || si < 0 || !_sections[si]) return;
  const ci = (_sel && _sel.ci != null) ? _sel.ci : 0;
  const col = _sections[si].columns[ci] || _sections[si].columns[0];
  if (!col) return;
  const realCi = _sections[si].columns.indexOf(col);
  const clone = JSON.parse(JSON.stringify(w)); clone.id = _id('w');
  const at = (_sel && _sel.wi != null && _sel.si === si && _sel.ci === realCi) ? _sel.wi + 1 : col.widgets.length;
  col.widgets.splice(at, 0, clone);
  _sel = { si, ci: realCi, wi: at };
  _side = 'settings';
  _afterMutate();
}

function addWidgetToSelection(type) {
  let si = _sel ? _sel.si : _sections.length - 1;
  if (si == null || si < 0) { _sections.push(_newSection()); si = _sections.length - 1; }
  const ci = (_sel && _sel.ci != null) ? _sel.ci : 0;
  const col = _sections[si].columns[ci] || _sections[si].columns[0];
  const realCi = _sections[si].columns.indexOf(col);
  // Insert just AFTER the selected widget (mirrors duplicateWidget + the drop
  // index) rather than always appending at column end — click-add and drag-add
  // now place widgets consistently.
  const at = (_sel && _sel.wi != null && _sel.si === si && _sel.ci === realCi) ? _sel.wi + 1 : col.widgets.length;
  col.widgets.splice(at, 0, _newWidget(type));
  _sel = { si, ci: realCi, wi: at };
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
  // A pending translate-panel autosave must not fire across a page switch:
  // at fire time it would persist the NEW page's just-loaded state (for a
  // built-in page, that silently writes the seeded template as its draft).
  clearTimeout(_autosaveTimer);
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
  _background = (src && src.background && typeof src.background === 'object' && src.background.preset)
    ? JSON.parse(JSON.stringify(src.background)) : null;
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
  _lastSavedAt = null;
  _mark(false);
  _histReset();
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
  // Add to nav HIDDEN (show:false): an empty page must not leak into the public
  // menu before it has published content — publish() reveals it. Read-reconcile
  // first so a concurrent Identity edit isn't clobbered.
  await _reconcileInstance();
  _instance.nav = _instance.nav || {};
  _instance.nav.customPages = Array.isArray(_instance.nav.customPages) ? _instance.nav.customPages : [];
  _instance.nav.customPages.push({ slug, label: { [_editLoc]: label }, show: false });
  await apiFetchStatus(`${API_SITE}?action=save&doc=instance`, { method: 'POST', body: JSON.stringify(_instance) });
  try { if (typeof InstanceConfig !== 'undefined') await InstanceConfig.load(); } catch (_) {}
  _buildPageList();
  toast(t('pages.created', 'Page créée. Elle apparaîtra dans le menu après publication.'), 'success');
  await selectPage(slug);
  enterEditor();
}

// First publish of a custom page flips its nav entry from hidden to visible.
// No-op for built-ins (their visibility lives in Identity → Navigation) and for
// pages already visible. Read-reconcile so a concurrent Identity edit survives.
async function _revealPageInNav(slug) {
  if (SPECIAL.some((s) => s.slug === slug)) return;
  try {
    await _reconcileInstance();
    const list = (_instance.nav && Array.isArray(_instance.nav.customPages)) ? _instance.nav.customPages : null;
    const pg = list ? list.find((p) => p.slug === slug) : null;
    if (!pg || pg.show !== false) return;
    pg.show = true;
    await apiFetchStatus(`${API_SITE}?action=save&doc=instance`, { method: 'POST', body: JSON.stringify(_instance) });
    try { if (typeof InstanceConfig !== 'undefined') await InstanceConfig.load(); } catch (_) {}
    _buildPageList();
  } catch (_) { /* non-fatal: the page is published, just not yet linked */ }
}

async function deletePage() {
  const page = _pages.find((p) => p.slug === _slug);
  if (!page || page.builtin) { toast(t('pages.cantDeleteBuiltin', 'Les pages intégrées ne peuvent pas être supprimées (réinitialisez-les).'), 'warning'); return; }
  if (!confirm(t('pages.deleteConfirm', 'Supprimer cette page ?'))) return;
  // Real delete: unlink config/pages/<slug>.json. The old action=reset only
  // rewrote it to {}, leaving the page publicly reachable at page.html?slug=
  // forever and accumulating orphan files invisible to the admin.
  const d = await apiFetchStatus(`${API_SITE}?action=delete&doc=pages/${encodeURIComponent(_slug)}`, { method: 'POST', body: '{}' });
  if (!d.ok) { toast(t('pages.saveError', "Échec de l'enregistrement."), 'error'); return; }
  // Read-reconcile before rewriting instance.json so a concurrent branding/nav
  // edit in another tab isn't clobbered by our stale snapshot.
  await _reconcileInstance();
  _instance.nav = _instance.nav || {};
  _instance.nav.customPages = (Array.isArray(_instance.nav.customPages) ? _instance.nav.customPages : []).filter((p) => p.slug !== _slug);
  await apiFetchStatus(`${API_SITE}?action=save&doc=instance`, { method: 'POST', body: JSON.stringify(_instance) });
  try { if (typeof InstanceConfig !== 'undefined') await InstanceConfig.load(); } catch (_) {}
  _buildPageList();
  toast(t('pages.deleted', 'Page supprimée.'), 'success');
  await selectPage('home');
}

async function saveDraft() {
  _cancelAutosave();   // this IS the save — a late debounced one would be redundant/racing
  if (!_doc || typeof _doc !== 'object' || Array.isArray(_doc)) _doc = _emptyDoc();
  _doc.draft = _draftSource();
  _doc.published = _doc.published || { sections: [] };
  const r = await apiFetchStatus(`${API_SITE}?action=save&doc=pages/${encodeURIComponent(_slug)}`, { method: 'POST', body: JSON.stringify(_doc) });
  if (r.ok) { _lastSavedAt = new Date(); _mark(false); toast(t('pages.draftSaved', 'Brouillon enregistré.'), 'success'); }
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
  // Cancel any pending translate autosave: it serialized an OLD _doc (with the
  // pre-publish `published` block) and would, if it landed after this publish,
  // overwrite the freshly-published doc wholesale.
  _cancelAutosave();
  const btn = el('pe-publish');
  if (btn) { btn.disabled = true; btn.innerHTML = `<span class="spinner spinner-sm"></span> ${escHtml(t('pages.publishing', 'Publication…'))}`; }
  if (!_doc || typeof _doc !== 'object' || Array.isArray(_doc)) _doc = _emptyDoc();
  _doc.draft = _draftSource();
  const s = await apiFetchStatus(`${API_SITE}?action=save&doc=pages/${encodeURIComponent(_slug)}`, { method: 'POST', body: JSON.stringify(_doc) });
  if (!s.ok) { _restorePublishBtn(btn); toast(t('pages.saveError', "Échec de l'enregistrement."), 'error'); return; }
  const r = await apiFetchStatus(`${API_SITE}?action=publish&doc=pages/${encodeURIComponent(_slug)}`, { method: 'POST', body: '{}' });
  if (r.ok) {
    _lastSavedAt = new Date();
    _mark(false); _doc.published = JSON.parse(JSON.stringify(_draftSource())); _seeded = false; renderSidebar();
    await _revealPageInNav(_slug);   // first publish of a custom page → make it visible in the menu
    toast(t('pages.published', 'Page publiée ✓'), 'success');
    if (btn) { btn.disabled = false; btn.innerHTML = `<i data-lucide="check"></i> ${escHtml(t('pages.publishedBtn', 'Publié ✓'))}`; try { refreshIcons(btn.parentElement || document); } catch (_) {} setTimeout(() => _restorePublishBtn(btn), 2600); }
  } else { _restorePublishBtn(btn); toast(t('pages.saveError', "Échec de l'enregistrement."), 'error'); }
}

async function revert() {
  const isBuiltin = SPECIAL.some((s) => s.slug === _slug);
  _cancelAutosave();   // a late autosave would re-write the draft we're about to reset
  if (isBuiltin) {
    // Built-in home/about have a shipped default template to fall back to.
    if (!confirm(t('pages.revertConfirm', 'Réinitialiser cette page à son état par défaut ?'))) return;
    const r = await apiFetchStatus(`${API_SITE}?action=reset&doc=pages/${encodeURIComponent(_slug)}`, { method: 'POST', body: '{}' });
    if (r.ok) { toast(t('pages.reverted', 'Réinitialisée.'), 'success'); await selectPage(_slug); }
    else toast(t('pages.saveError', "Échec de l'enregistrement."), 'error');
    return;
  }
  // Custom page: "revert" DISCARDS THE UNPUBLISHED DRAFT and returns to the
  // published version. A custom page has NO default template, so the old
  // action=reset wiped published content too (unrecoverable data loss). Restore
  // from _doc.published purely client-side, then persist draft==published.
  if (!confirm(t('pages.discardDraftConfirm', 'Annuler les modifications non publiées et revenir à la version publiée ?'))) return;
  const pub = (_doc && _doc.published && typeof _doc.published === 'object') ? _doc.published : { sections: [] };
  _sections = _sanitizeSections(_migrate(pub));
  _background = (pub.background && typeof pub.background === 'object' && pub.background.preset) ? JSON.parse(JSON.stringify(pub.background)) : null;
  _sel = null; _seeded = false;
  if (!_doc || typeof _doc !== 'object' || Array.isArray(_doc)) _doc = _emptyDoc();
  _doc.draft = JSON.parse(JSON.stringify(pub));
  const r = await apiFetchStatus(`${API_SITE}?action=save&doc=pages/${encodeURIComponent(_slug)}`, { method: 'POST', body: JSON.stringify(_doc) });
  _mark(false);
  renderSidebar(); _syncFrame();
  if (r.ok) toast(t('pages.draftDiscarded', 'Modifications annulées.'), 'success');
  else toast(t('pages.saveError', "Échec de l'enregistrement."), 'error');
}

async function load() {
  if (!_bound) { window.addEventListener('message', _onMessage); _bound = true; }
  // Guard unsaved edits on reload/close/back for BOTH the dedicated editor tab
  // AND the in-shell fallback editor (was previously bound only in the ?editor=
  // tab branch, so a popup-blocked in-shell session lost work silently).
  if (!_beforeUnloadBound) {
    _beforeUnloadBound = true;
    window.addEventListener('beforeunload', (e) => { if (_dirty) { e.preventDefault(); e.returnValue = ''; } });
  }
  if (!_keysBound) { _keysBound = true; window.addEventListener('keydown', _onKey); }
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
