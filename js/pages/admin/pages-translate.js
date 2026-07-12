/**
 * Admin SPA — Pages editor « Traduire » panel
 * ============================================================================
 * Lists every localized text of the page being edited (page title + every
 * translatable field of every widget, per an EXPLICIT per-type field map —
 * nothing inferred from value shape) and lets the operator fill the value for
 * each available site language. Writes go straight into the live model
 * objects (in place); every keystroke marks the doc dirty (ctx.onChange →
 * live iframe sync) and schedules the debounced silent draft autosave
 * (ctx.requestAutosave).
 *
 * Only fields that already carry at least one non-empty value are listed —
 * a field empty in every locale is simply unused (no source to translate)
 * and would only add noise.
 */

'use strict';

import { refreshIcons } from './shared.js';

// ── Small helpers ─────────────────────────────────────────────────
function mk(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function isLocObj(v) { return v != null && typeof v === 'object' && !Array.isArray(v); }

// A field is translatable-from if any locale (or a legacy plain string) holds text.
function hasAny(v) {
  if (typeof v === 'string') return v.trim() !== '';
  if (isLocObj(v)) return Object.values(v).some((x) => typeof x === 'string' && x.trim() !== '');
  return false;
}

// Legacy plain strings render identically in every locale through the
// renderer's `en` fallback — read them as the `en` value so the panel and
// ensureLoc() stay consistent.
function readLoc(v, code) {
  if (typeof v === 'string') return code === 'en' ? v : '';
  if (isLocObj(v) && typeof v[code] === 'string') return v[code];
  return '';
}

function ensureLoc(parent, key) {
  const v = parent[key];
  if (isLocObj(v)) return v;
  const o = {};
  if (typeof v === 'string' && v.trim() !== '') o.en = v;
  parent[key] = o;
  return o;
}

function excerptOf(v, editLoc, locales) {
  let s = readLoc(v, editLoc);
  if (!s.trim()) {
    for (const l of locales) { s = readLoc(v, l.code); if (s.trim()) break; }
  }
  s = s.replace(/\s+/g, ' ').trim();
  return s.length > 40 ? s.slice(0, 40) + '…' : s;
}

// ── Explicit localized-field map per widget type ──────────────────
// Mirrors the widget schemas of tab-pages / page-renderer. `long` fields get
// a textarea per locale. Optional sub-objects (cta, cta2, link) and array
// items are only walked when present.
function widgetEntries(w) {
  const p = isLocObj(w.props) ? w.props : {};
  const out = [];
  const add = (parent, key, long) => {
    if (parent && typeof parent === 'object') out.push({ parent, key, long: !!long });
  };
  const each = (arr, fn) => {
    if (Array.isArray(arr)) arr.forEach((it) => { if (isLocObj(it)) fn(it); });
  };
  switch (w.type) {
    case 'heading':
    case 'button':
      add(w, 'text'); break;
    case 'richtext':
      add(w, 'text', true); break;
    case 'hero':
      add(w, 'text'); add(p, 'subtitle'); add(p.cta, 'text'); add(p.cta2, 'text'); break;
    case 'image':
      add(p, 'alt'); break;
    case 'gallery':
      each(p.images, (img) => add(img, 'alt')); break;
    case 'stat-grid':
      each(p.stats, (s) => add(s, 'label')); break;
    case 'feature-card':
      add(w, 'text'); add(p, 'desc', true); add(p.link, 'text'); break;
    case 'quote':
      add(w, 'text', true); add(p, 'author'); add(p, 'role'); break;
    case 'accordion':
      each(p.items, (it) => { add(it, 'q'); add(it, 'a', true); }); break;
    case 'timeline':
      each(p.items, (it) => { add(it, 'date'); add(it, 'title'); add(it, 'text', true); }); break;
    case 'cta-banner':
      add(w, 'text'); add(p, 'subtitle'); add(p.cta, 'text'); break;
    case 'html':
      add(p, 'html', true); break;
  }
  return out;
}

// ── Entry card ────────────────────────────────────────────────────
function buildCard(entry, locales, ctx, tt, updateSummary) {
  const val = () => entry.parent[entry.key];
  const missingCount = () => locales.reduce(
    (n, l) => n + (readLoc(val(), l.code).trim() === '' ? 1 : 0), 0);

  const card = mk('div', 'pbc-item');
  const head = mk('div', 'pbc-item-head');
  const title = mk('span', 'pbc-item-title');
  const warn = mk('span', 'ptr-warn', '⚠');
  warn.title = tt('pages.tr.missing', 'Traductions manquantes');
  warn.style.cssText = 'color:#f59e0b;font-size:11px;margin-right:5px';
  const label = mk('span', null, entry.label);
  const excerpt = mk('span', 'ptr-excerpt');
  excerpt.style.cssText = 'opacity:.6;font-weight:400;margin-left:6px';
  title.appendChild(warn);
  title.appendChild(label);
  title.appendChild(excerpt);
  head.appendChild(title);
  if (entry.hint) {
    const hint = mk('span', 'ptr-hint', entry.hint);
    hint.style.cssText = 'flex:0 0 auto;font-size:10.5px;opacity:.55;white-space:nowrap';
    head.appendChild(hint);
  }
  card.appendChild(head);

  const body = mk('div', 'pbc-item-body');
  body.hidden = missingCount() === 0;   // entries with a gap start open
  card.appendChild(body);
  head.addEventListener('click', () => { body.hidden = !body.hidden; });

  const refreshHead = () => {
    excerpt.textContent = excerptOf(val(), ctx.editLoc, locales);
    warn.style.display = missingCount() > 0 ? '' : 'none';
  };
  refreshHead();

  locales.forEach((l) => {
    const field = mk('label', 'adm-field');
    field.appendChild(mk('span', 'adm-field-label', `${l.native || l.code} (${l.code})`));
    const inp = entry.long ? mk('textarea', 'adm-field-input') : mk('input', 'adm-field-input');
    if (entry.long) { inp.rows = 2; inp.style.resize = 'vertical'; }
    else inp.type = 'text';
    inp.value = readLoc(val(), l.code);
    inp.addEventListener('input', () => {
      const o = ensureLoc(entry.parent, entry.key);
      o[l.code] = inp.value;
      ctx.onChange();
      ctx.requestAutosave();
      refreshHead();
      updateSummary();
    });
    field.appendChild(inp);
    body.appendChild(field);
  });

  return card;
}

// ── Entry point ───────────────────────────────────────────────────
export function renderTranslatePanel(host, ctx) {
  const tt = ctx.t || ((k, d) => d);
  const locales = (Array.isArray(ctx.locales) && ctx.locales.length)
    ? ctx.locales : [{ code: 'en', native: 'EN' }];

  host.textContent = '';
  const root = mk('div', 'ptr-panel');
  root.style.cssText = 'display:flex;flex-direction:column;gap:10px';
  host.appendChild(root);

  // Collect every translatable entry — page title first, then widgets in
  // document order.
  const entries = [];
  const push = (parent, key, label, hint, long) => {
    if (!parent || typeof parent !== 'object') return;
    if (!hasAny(parent[key])) return;
    entries.push({ parent, key, label, hint, long: !!long });
  };
  if (ctx.doc && typeof ctx.doc === 'object') {
    push(ctx.doc, 'title', tt('pages.tr.pageTitle', 'Titre de la page'), '', false);
  }
  (Array.isArray(ctx.sections) ? ctx.sections : []).forEach((sec, si) => {
    if (!sec || typeof sec !== 'object') return;
    const hint = `${tt('pages.section', 'Section')} ${si + 1}`;
    (Array.isArray(sec.columns) ? sec.columns : []).forEach((col) => {
      if (!col || typeof col !== 'object') return;
      (Array.isArray(col.widgets) ? col.widgets : []).forEach((w) => {
        if (!w || typeof w !== 'object') return;
        const label = tt('pages.block.' + w.type, w.type);
        widgetEntries(w).forEach((e) => push(e.parent, e.key, label, hint, e.long));
      });
    });
  });

  root.appendChild(mk('div', 'adm-page-sub', tt('pages.tr.hint',
    'Les traductions sont enregistrées automatiquement dans le brouillon. Publiez la page pour les mettre en ligne.')));

  if (!entries.length) {
    const empty = mk('div', 'adm-page-sub');
    empty.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:8px;padding:22px 8px;text-align:center';
    const ic = document.createElement('i');
    ic.setAttribute('data-lucide', 'languages');
    ic.style.cssText = 'width:26px;height:26px;opacity:.55';
    empty.appendChild(ic);
    empty.appendChild(mk('span', null, tt('pages.tr.empty',
      'Cette page ne contient aucun texte à traduire pour le moment.')));
    root.appendChild(empty);
    refreshIcons(root);
    return;
  }

  const summary = mk('div', 'adm-page-sub');
  summary.style.cssText = 'font-weight:600';
  root.appendChild(summary);
  const missingOf = (e) => locales.reduce(
    (n, l) => n + (readLoc(e.parent[e.key], l.code).trim() === '' ? 1 : 0), 0);
  const updateSummary = () => {
    const m = entries.reduce((n, e) => n + missingOf(e), 0);
    summary.textContent = tt('pages.tr.summary', '{n} textes · {m} traductions manquantes')
      .replace('{n}', String(entries.length))
      .replace('{m}', String(m));
  };
  updateSummary();

  const list = mk('div', 'pbc-items');
  root.appendChild(list);
  entries.forEach((e) => list.appendChild(buildCard(e, locales, ctx, tt, updateSummary)));
  refreshIcons(root);
}
