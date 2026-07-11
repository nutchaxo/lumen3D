/* ============================================================
   Lumen3D — Page renderer (white-label page builder)
   ============================================================
   Renders a page authored in the admin "Pages" tab (stored in
   config/pages/<slug>.json) into a container.

   DATA MODEL (v2, Elementor-style):
     source = { sections: [ Section, … ] }
     Section = { id, props:{bg,padY,fullWidth,maxWidth,gap,vAlign}, columns:[ Column ] }
     Column  = { id, width(1–12), props:{vAlign,padding}, widgets:[ Widget ] }
     Widget  = { id, type, text, props }        // the former "block"

   BACKWARD-COMPAT: a legacy flat source { blocks:[…] } (or a bare array) is
   normalized to a single full-width section with one 12-unit column whose
   widgets are those blocks — so old pages keep rendering (and stop showing a
   blank page). This is the twin of the editor in js/pages/admin/tab-pages.js.

   Text fields are LOCALIZED objects ({en, fr, …}); _lv() picks the current
   locale (→ en → first). Rendering is injection-safe: text via textContent; the
   "html" widget is sanitized. CSS lives in inline styles + var() fallbacks so it
   renders even before the full stylesheet cascade and inside the CSP (no
   injected <style>). Classic IIFE singleton — bare name PageRenderer.
   ============================================================ */

const PageRenderer = (() => {
  'use strict';

  function _loc() {
    try { if (typeof I18n !== 'undefined' && I18n.getLanguage) return I18n.getLanguage(); } catch (_) {}
    return 'en';
  }
  // White-label token substitution ({brand}, {specimen}, {specimenPlural}, …),
  // mirroring I18n.t() so authored widget text and the built-in-page starter
  // templates read the operator's identity instead of a baked-in domain noun —
  // and so the editor iframe shows exactly what the live site renders.
  function _interp(s) {
    if (typeof s !== 'string' || s.indexOf('{') === -1) return s;
    let tk = null;
    try { if (typeof InstanceConfig !== 'undefined' && InstanceConfig.tokens) tk = InstanceConfig.tokens(); } catch (_) {}
    if (!tk) return s;
    return s.replace(/\{(\w+)\}/g, (m, k) => (k in tk && tk[k] != null ? String(tk[k]) : m));
  }
  function _lv(v) {
    let s;
    if (v == null) s = '';
    else if (typeof v === 'string') s = v;
    else if (typeof v === 'object' && !Array.isArray(v)) { const l = _loc(); s = v[l] || v.en || Object.values(v)[0] || ''; }
    else s = String(v);
    return _interp(s);
  }
  function _el(tag, style, text) {
    const e = document.createElement(tag);
    if (style) e.style.cssText = style;
    if (text != null) e.textContent = text;
    return e;
  }
  function _sanitizeCss(v) { return String(v == null ? '' : v).replace(/[<>]/g, '').replace(/expression\s*\(/gi, '').slice(0, 200); }
  const ALIGN = (a) => (a === 'center' || a === 'right' ? a : 'left');

  function _sanitizeHtml(html) {
    const tpl = document.createElement('template');
    tpl.innerHTML = String(html || '');
    const BAD = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'LINK', 'META', 'BASE', 'FORM']);
    const walk = (node) => {
      [...node.children].forEach((child) => {
        if (BAD.has(child.tagName)) { child.remove(); return; }
        [...child.attributes].forEach((a) => {
          const n = a.name.toLowerCase();
          if (n.startsWith('on')) child.removeAttribute(a.name);
          else if ((n === 'href' || n === 'src') && /^\s*javascript:/i.test(a.value)) child.removeAttribute(a.name);
        });
        walk(child);
      });
    };
    walk(tpl.content);
    return tpl.innerHTML;
  }

  // ── Widget renderers (the former block renderers; type names unchanged) ─────
  const RENDERERS = {
    heading(b) {
      const lvl = Math.min(4, Math.max(1, +(b.props?.level) || 2));
      return _el('h' + lvl, `text-align:${ALIGN(b.props?.align)};margin:0 0 12px;line-height:1.25`, _lv(b.text));
    },
    richtext(b) {
      const wrap = _el('div', `text-align:${ALIGN(b.props?.align)}`);
      _lv(b.text).split(/\n{2,}/).forEach((para) => wrap.appendChild(_el('p', 'line-height:1.7;margin:0 0 14px;white-space:pre-wrap', para)));
      return wrap;
    },
    image(b) {
      const wrap = _el('div', `text-align:${ALIGN(b.props?.align || 'center')}`);
      const img = document.createElement('img');
      img.src = b.props?.src || ''; img.alt = _lv(b.props?.alt) || ''; img.loading = 'lazy';
      img.style.cssText = `max-width:100%;height:auto;border-radius:var(--radius-md,10px);${b.props?.width ? 'width:' + (parseInt(b.props.width) || 0) + 'px;' : ''}`;
      if (b.props?.href) { const a = document.createElement('a'); a.href = b.props.href; a.appendChild(img); wrap.appendChild(a); }
      else wrap.appendChild(img);
      return wrap;
    },
    button(b) {
      const wrap = _el('div', `text-align:${ALIGN(b.props?.align || 'left')};margin:6px 0`);
      const a = document.createElement('a');
      a.href = b.props?.href || '#';
      a.className = 'btn ' + (b.props?.style === 'ghost' ? 'btn-ghost' : (b.props?.style === 'lg' ? 'btn-accent btn-lg' : 'btn-accent'));
      a.textContent = _lv(b.text) || 'Button';
      wrap.appendChild(a);
      return wrap;
    },
    divider() { return _el('hr', 'border:none;border-top:1px solid var(--border-subtle,#2a2a3a);margin:24px 0'); },
    spacer(b) { return _el('div', `height:${Math.max(0, Math.min(400, +(b.props?.height) || 32))}px`); },
    hero(b) {
      const sec = _el('div', `padding:56px 24px;text-align:center;border-radius:var(--radius-lg,14px);${b.props?.bg ? 'background:' + _sanitizeCss(b.props.bg) + ';' : ''}`);
      const inner = _el('div', 'max-width:760px;margin:0 auto');
      if (_lv(b.text)) inner.appendChild(_el('h1', 'margin:0 0 14px', _lv(b.text)));
      if (_lv(b.props?.subtitle)) inner.appendChild(_el('p', 'font-size:var(--text-lg,1.25rem);opacity:.8;margin:0 0 22px', _lv(b.props.subtitle)));
      const cta = b.props?.cta;
      if (cta && _lv(cta.text)) { const a = document.createElement('a'); a.href = cta.href || '#'; a.className = 'btn btn-accent btn-lg'; a.textContent = _lv(cta.text); inner.appendChild(a); }
      sec.appendChild(inner);
      return sec;
    },
    gallery(b) {
      const grid = _el('div', 'display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:12px');
      (Array.isArray(b.props?.images) ? b.props.images : []).forEach((im) => {
        const img = document.createElement('img');
        img.src = im.src || ''; img.alt = _lv(im.alt) || ''; img.loading = 'lazy';
        img.style.cssText = 'width:100%;height:160px;object-fit:cover;border-radius:var(--radius-md,10px)';
        grid.appendChild(img);
      });
      return grid;
    },
    'stat-grid'(b) {
      const grid = _el('div', 'display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:16px;text-align:center');
      // Live sources mirror the landing's counters (Catalog.getStats()).
      const SRC = { datasetCount: 'totalDatasets', specimenCount: 'totalEmbryos', cellCount: 'totalCells', regionCount: 'totalRegions' };
      let stats0 = null;
      try { if (typeof Catalog !== 'undefined' && Catalog.getStats) stats0 = Catalog.getStats(); } catch (_) {}
      (Array.isArray(b.props?.stats) ? b.props.stats : []).forEach((st) => {
        const card = _el('div', 'padding:20px;background:var(--bg-surface,#161622);border-radius:var(--radius-md,10px)');
        let value = st.value;
        if (SRC[st.source]) value = stats0 ? (stats0[SRC[st.source]] ?? 0) : (value || 0);
        card.appendChild(_el('div', 'font-size:var(--text-3xl,2.5rem);font-weight:700;color:var(--color-primary,#00A654)', String(value ?? 0)));
        card.appendChild(_el('div', 'opacity:.7;margin-top:4px', _lv(st.label)));
        grid.appendChild(card);
      });
      return grid;
    },
    'latest-datasets'(b) {
      const wrap = _el('div', 'display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:16px');
      let list = [];
      try { if (typeof Catalog !== 'undefined' && Catalog.list) list = Catalog.list().slice(0, Math.max(1, Math.min(12, +(b.props?.count) || 4))); } catch (_) {}
      list.forEach((ds) => {
        const a = document.createElement('a');
        a.href = `viewer.html?id=${encodeURIComponent(ds.id)}`;
        a.style.cssText = 'display:block;padding:14px;background:var(--bg-surface,#161622);border-radius:var(--radius-md,10px);text-decoration:none;color:inherit';
        a.appendChild(_el('div', 'font-weight:600', ds.name || ds.id));
        if (ds.type) a.appendChild(_el('div', 'opacity:.6;font-size:var(--text-sm,.8rem);margin-top:4px', ds.type));
        wrap.appendChild(a);
      });
      return wrap;
    },
    html(b) { const div = document.createElement('div'); div.innerHTML = _sanitizeHtml(_lv(b.props?.html)); return div; },
  };

  const WIDGET_TYPES = Object.keys(RENDERERS);

  function renderWidget(w) {
    const fn = RENDERERS[w && w.type];
    if (!fn) return null;
    try { const node = fn(w); if (!node) return null; const box = _el('div', 'margin:0 0 10px'); box.appendChild(node); return box; }
    catch (_) { return null; }
  }

  // ── Normalization: accept sections / flat blocks / bare array ──────────────
  function _normalize(source) {
    let src = source;
    if (Array.isArray(src)) src = { blocks: src };
    src = src || {};
    if (Array.isArray(src.sections) && src.sections.length) return src.sections;
    const blocks = Array.isArray(src.blocks) ? src.blocks
      : (src.draft && Array.isArray(src.draft.blocks)) ? src.draft.blocks
      : (src.published && Array.isArray(src.published.blocks)) ? src.published.blocks : [];
    if (blocks.length) return [{ props: { fullWidth: false }, columns: [{ width: 12, widgets: blocks }] }];
    return [];
  }

  const VALIGN = (v) => ({ start: 'flex-start', center: 'center', end: 'flex-end', stretch: 'stretch' }[v] || 'stretch');

  function renderColumn(col, gap) {
    const width = Math.min(12, Math.max(1, +(col && col.width) || 12));
    const pct = (width / 12) * 100;
    // flex-wrap + min-width → columns stack on narrow viewports (no media query,
    // CSP-safe). basis = target %, minus the row gap so widths stay exact.
    const el = _el('div', `flex:1 1 calc(${pct}% - ${gap}px);min-width:min(100%, 240px);` +
      `box-sizing:border-box;${col?.props?.padding ? 'padding:' + (parseInt(col.props.padding) || 0) + 'px;' : ''}`);
    const widgets = Array.isArray(col && col.widgets) ? col.widgets : [];
    widgets.forEach((w) => { const n = renderWidget(w); if (n) el.appendChild(n); });
    if (!widgets.length) el.appendChild(_el('div', 'min-height:1px'));
    return el;
  }

  function renderSection(sec) {
    const p = (sec && sec.props) || {};
    const outer = _el('section', `position:relative;padding:${Math.max(0, +p.padY ?? 48)}px 0;` +
      `${p.bg ? 'background:' + _sanitizeCss(p.bg) + ';' : ''}`);
    const gap = Math.max(0, Math.min(80, +p.gap ?? 24));
    const inner = _el('div', p.fullWidth
      ? 'width:100%;padding:0 24px;box-sizing:border-box'
      : `max-width:${Math.max(480, Math.min(1600, +p.maxWidth || 1080))}px;margin:0 auto;padding:0 24px;box-sizing:border-box`);
    const row = _el('div', `display:flex;flex-wrap:wrap;gap:${gap}px;align-items:${VALIGN(p.vAlign)}`);
    const cols = Array.isArray(sec && sec.columns) ? sec.columns : [];
    cols.forEach((c) => row.appendChild(renderColumn(c, gap)));
    inner.appendChild(row);
    outer.appendChild(inner);
    return outer;
  }

  /**
   * Render a page source into `container`. Accepts the v2 {sections} model, the
   * legacy {blocks} / {draft} / {published} shapes, or a bare blocks array.
   * Returns the number of sections rendered (0 → caller shows an empty state).
   * `opts.wrap` is accepted for backward-compat (sections already self-wrap).
   */
  function renderSource(container, source, _opts) {
    if (!container) return 0;
    container.textContent = '';
    const sections = _normalize(source);
    sections.forEach((s) => container.appendChild(renderSection(s)));
    return sections.length;
  }

  // Backward-compat: render(container, blocks[], {wrap}) — used by landing/about.
  function render(container, blocks, opts) { return renderSource(container, { blocks: Array.isArray(blocks) ? blocks : [] }, opts); }

  // Fetch a page doc's published (or draft) SOURCE object ({sections} or {blocks}).
  async function fetchSource(slug, useDraft) {
    try {
      const resp = await fetch(`./config/pages/${encodeURIComponent(slug)}.json`, { cache: 'no-store' });
      if (!resp.ok) return { sections: [] };
      const doc = await resp.json();
      const src = (useDraft && doc && doc.draft) ? doc.draft : (doc && doc.published) || {};
      return src && typeof src === 'object' ? src : { sections: [] };
    } catch (_) { return { sections: [] }; }
  }

  // Legacy helper kept for callers that expect an array of blocks/sections.
  async function fetchBlocks(slug, useDraft) {
    const src = await fetchSource(slug, useDraft);
    if (Array.isArray(src.sections) && src.sections.length) return src.sections;
    return Array.isArray(src.blocks) ? src.blocks : [];
  }

  return {
    render, renderSource, renderWidget, renderSection,
    fetchSource, fetchBlocks, normalize: _normalize, lv: _lv,
    WIDGET_TYPES, BLOCK_TYPES: WIDGET_TYPES,
  };
})();
