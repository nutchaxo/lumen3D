/* ============================================================
   Lumen3D — Page renderer (white-label page builder)
   ============================================================
   Renders a page authored in the admin "Pages" tab (stored in
   config/pages/<slug>.json) into a container.

   DATA MODEL (v2, Elementor-style):
     source = { sections: [ Section, … ] }
     Section = { id, props:{bg,padY,fullWidth,maxWidth,gap,vAlign,style}, columns:[ Column ] }
     Column  = { id, width(1–12), props:{vAlign,padding,style}, widgets:[ Widget ] }
     Widget  = { id, type, text, props }        // the former "block"

   STYLE OBJECT (v3, per widget/column/section — props.style, all optional):
     { color, fontSize, fontWeight, lineHeight, letterSpacing, italic, uppercase, align,
       bg, bgImage, overlay, radius, borderWidth, borderColor, borderStyle, shadow, opacity,
       padTop, padRight, padBottom, padLeft, marginTop, marginBottom,
       maxWidth, minHeight }
   Compiled to sanitized inline CSS by styleCss(style, groups) — groups being
   'text' | 'surface' | 'spacing' | 'size'. The editor (tab-pages.js) writes
   these fields; the edit frame (page-edit-frame.js) reuses sectionCss/columnCss
   below so editor and live page can never drift.

   BACKWARD-COMPAT: a legacy flat source { blocks:[…] } (or a bare array) is
   normalized to a single full-width section with one 12-unit column whose
   widgets are those blocks — so old pages keep rendering (and stop showing a
   blank page). Legacy props (section.bg/padY, column.padding, hero.bg…) are
   still honored; props.style overrides them (appended last).

   Text fields are LOCALIZED objects ({en, fr, …}); _lv() picks the current
   locale (→ en → first). Rendering is injection-safe: text via textContent; the
   "html" widget is sanitized; every CSS value flows through _sanitizeCss/_n.
   CSS lives in inline styles + var() fallbacks so it renders even before the
   full stylesheet cascade and inside the CSP (no injected <style>). Classic
   IIFE singleton — bare name PageRenderer.
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
  // One CSS *value* (color, gradient, …) — never a declaration: strip anything
  // that could close the property or smuggle extra ones in.
  function _sanitizeCss(v) { return String(v == null ? '' : v).replace(/[<>;{}]/g, '').replace(/expression\s*\(/gi, '').slice(0, 200); }
  function _urlCss(u) { return String(u == null ? '' : u).replace(/["'\\<>;{}()]/g, '').slice(0, 500); }
  const ALIGN = (a) => (a === 'center' || a === 'right' ? a : 'left');
  // Numeric style field: ''/null/undefined → unset (null); else clamped number.
  function _n(v, min, max) {
    if (v === '' || v == null || typeof v === 'boolean') return null;
    const x = +v;
    if (isNaN(x)) return null;
    return Math.max(min, Math.min(max, x));
  }

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

  // ── Generic style engine (widgets, columns, sections) ──────────────────────
  const SHADOWS = { sm: '0 1px 3px rgba(0,0,0,.25)', md: '0 4px 16px rgba(0,0,0,.28)', lg: '0 14px 36px rgba(0,0,0,.38)' };
  const BORDER_STYLES = ['solid', 'dashed', 'dotted'];

  function styleCss(st, groups) {
    if (!st || typeof st !== 'object') return '';
    const has = (g) => !groups || groups.indexOf(g) !== -1;
    let c = '';
    if (has('text')) {
      if (st.color) c += `color:${_sanitizeCss(st.color)};`;
      const fs = _n(st.fontSize, 8, 220); if (fs != null) c += `font-size:${fs}px;`;
      const fw = _n(st.fontWeight, 100, 900); if (fw != null) c += `font-weight:${fw};`;
      const lh = _n(st.lineHeight, 0.7, 4); if (lh != null) c += `line-height:${lh};`;
      const ls = _n(st.letterSpacing, -5, 40); if (ls != null && ls !== 0) c += `letter-spacing:${ls}px;`;
      if (st.italic) c += 'font-style:italic;';
      if (st.uppercase) c += 'text-transform:uppercase;';
      if (st.align) c += `text-align:${ALIGN(st.align)};`;
    }
    if (has('surface')) {
      if (st.bg) c += `background:${_sanitizeCss(st.bg)};`;
      if (st.bgImage) c += `background-image:url("${_urlCss(st.bgImage)}");background-size:cover;background-position:center;`;
      const r = _n(st.radius, 0, 300); if (r != null) c += `border-radius:${r}px;`;
      const bw = _n(st.borderWidth, 0, 24);
      if (bw) c += `border:${bw}px ${BORDER_STYLES.includes(st.borderStyle) ? st.borderStyle : 'solid'} ${_sanitizeCss(st.borderColor || 'var(--border-subtle,#2a2a3a)')};`;
      if (SHADOWS[st.shadow]) c += `box-shadow:${SHADOWS[st.shadow]};`;
      const op = _n(st.opacity, 0, 100); if (op != null && op < 100) c += `opacity:${op / 100};`;
    }
    if (has('spacing')) {
      const MAP = { padTop: 'padding-top', padRight: 'padding-right', padBottom: 'padding-bottom', padLeft: 'padding-left', marginTop: 'margin-top', marginBottom: 'margin-bottom' };
      for (const k in MAP) {
        const v = _n(st[k], k.indexOf('margin') === 0 ? -200 : 0, 500);
        if (v != null) c += `${MAP[k]}:${v}px;`;
      }
    }
    if (has('size')) {
      const mw = _n(st.maxWidth, 40, 1920); if (mw != null) c += `max-width:${mw}px;margin-left:auto;margin-right:auto;`;
      const mh = _n(st.minHeight, 0, 1600); if (mh != null) c += `min-height:${mh}px;`;
    }
    return c;
  }

  // Tint layer over a bgImage/bg (style.overlay) — DOM, not CSS, so it needs a
  // positioned parent; consumers (section, hero) set position:relative.
  function overlayNode(st) {
    if (!st || typeof st !== 'object' || !st.overlay) return null;
    const r = _n(st.radius, 0, 300);
    return _el('div', `position:absolute;inset:0;pointer-events:none;background:${_sanitizeCss(st.overlay)};${r != null ? `border-radius:${r}px;` : ''}`);
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
      const p = b.props || {}, st = p.style || {};
      const wrap = _el('div', `text-align:${ALIGN(p.align || 'center')};` + styleCss(st, ['spacing', 'text']));
      const img = document.createElement('img');
      img.src = p.src || ''; img.alt = _lv(p.alt) || ''; img.loading = 'lazy';
      const h = _n(p.height, 10, 2000);
      img.style.cssText = `max-width:100%;height:${h ? h + 'px' : 'auto'};` +
        `${(h || p.fit) ? `object-fit:${p.fit === 'contain' ? 'contain' : 'cover'};` : ''}` +
        `border-radius:var(--radius-md,10px);${p.width ? 'width:' + (parseInt(p.width) || 0) + 'px;' : ''}` +
        styleCss(st, ['surface', 'size']);
      if (p.href) { const a = document.createElement('a'); a.href = p.href; a.appendChild(img); wrap.appendChild(a); }
      else wrap.appendChild(img);
      return wrap;
    },
    button(b) {
      const p = b.props || {};
      // props.style is the generic style OBJECT. The button VARIANT lives in
      // props.variant; legacy docs stored it as the props.style STRING, so fall
      // back to that when style isn't an object (migrated in the editor's
      // _sanitizeSections; this keeps un-migrated live pages correct too).
      const st = (p.style && typeof p.style === 'object') ? p.style : {};
      const variant = p.variant || (typeof p.style === 'string' ? p.style : 'accent');
      const wrap = _el('div', `text-align:${ALIGN(p.align || 'left')};margin:6px 0;` + styleCss(st, ['spacing']));
      const a = document.createElement('a');
      a.href = p.href || '#';
      a.className = 'btn ' + (variant === 'ghost' ? 'btn-ghost' : (variant === 'lg' ? 'btn-accent btn-lg' : 'btn-accent'));
      a.textContent = _lv(b.text) || 'Button';
      let extra = styleCss(st, ['text', 'surface', 'size']);
      if (p.fullWidth) extra += 'display:flex;width:100%;justify-content:center;box-sizing:border-box;';
      if (extra) a.style.cssText += ';' + extra;
      wrap.appendChild(a);
      return wrap;
    },
    divider(b) {
      const p = b.props || {};
      const th = _n(p.thickness, 1, 20) || 1;
      const wd = _n(p.width, 1, 100);
      const ls = BORDER_STYLES.includes(p.lineStyle) ? p.lineStyle : 'solid';
      return _el('hr', `border:none;border-top:${th}px ${ls} ${p.color ? _sanitizeCss(p.color) : 'var(--border-subtle,#2a2a3a)'};margin:24px auto;${wd != null ? `width:${wd}%;` : ''}`);
    },
    spacer(b) { return _el('div', `height:${Math.max(0, Math.min(400, +(b.props?.height) || 32))}px`); },
    hero(b) {
      const p = b.props || {}, st = p.style || {};
      const align = ALIGN(p.align || 'center');
      const mh = _n(st.minHeight, 0, 1600);
      const sec = _el('div', `position:relative;overflow:hidden;padding:56px 24px;text-align:${align};border-radius:var(--radius-lg,14px);` +
        `${p.bg ? 'background:' + _sanitizeCss(p.bg) + ';' : ''}` +
        (mh ? 'display:flex;flex-direction:column;justify-content:center;' : '') +
        styleCss(st));
      const ov = overlayNode(st); if (ov) sec.appendChild(ov);
      const inner = _el('div', 'position:relative;max-width:760px;margin:0 auto;' +
        (align === 'left' ? 'margin-left:0;' : align === 'right' ? 'margin-right:0;' : ''));
      const ts = _n(p.titleSize, 10, 200);
      if (_lv(b.text)) inner.appendChild(_el('h1', 'margin:0 0 14px;' + (ts ? `font-size:${ts}px;line-height:1.15;` : ''), _lv(b.text)));
      const ss = _n(p.subSize, 8, 80);
      if (_lv(p.subtitle)) inner.appendChild(_el('p', `font-size:${ss ? ss + 'px' : 'var(--text-lg,1.25rem)'};opacity:.85;margin:0 0 22px`, _lv(p.subtitle)));
      const ctas = [];
      if (p.cta && _lv(p.cta.text)) ctas.push(['btn btn-accent btn-lg', p.cta]);
      if (p.cta2 && _lv(p.cta2.text)) ctas.push(['btn btn-ghost btn-lg', p.cta2]);
      if (ctas.length) {
        const row = _el('div', `display:flex;gap:12px;flex-wrap:wrap;justify-content:${align === 'center' ? 'center' : align === 'right' ? 'flex-end' : 'flex-start'}`);
        ctas.forEach(([cls, cta]) => { const a = document.createElement('a'); a.href = cta.href || '#'; a.className = cls; a.textContent = _lv(cta.text); row.appendChild(a); });
        inner.appendChild(row);
      }
      sec.appendChild(inner);
      return sec;
    },
    gallery(b) {
      const p = b.props || {}, st = p.style || {};
      const cols = _n(p.cols, 1, 8);
      const gp = _n(p.gap, 0, 60);
      const h = _n(p.height, 40, 1000) || 160;
      const r = _n(st.radius, 0, 300);
      const grid = _el('div', `display:grid;grid-template-columns:${cols ? `repeat(${cols},1fr)` : 'repeat(auto-fill,minmax(160px,1fr))'};gap:${gp != null ? gp : 12}px`);
      (Array.isArray(p.images) ? p.images : []).forEach((im) => {
        const img = document.createElement('img');
        img.src = im.src || ''; img.alt = _lv(im.alt) || ''; img.loading = 'lazy';
        img.style.cssText = `width:100%;height:${h}px;object-fit:cover;border-radius:${r != null ? r + 'px' : 'var(--radius-md,10px)'}`;
        grid.appendChild(img);
      });
      return grid;
    },
    icon(b) {
      const p = b.props || {}, st = p.style || {};
      const wrap = _el('div', `text-align:${ALIGN(p.align || 'center')};` + styleCss(st, ['spacing', 'size']));
      const size = _n(p.size, 8, 200) || 32;
      const badge = _el('span', 'display:inline-flex;align-items:center;justify-content:center;vertical-align:middle;' + styleCss(st, ['surface', 'text']));
      const i = document.createElement('i');
      i.setAttribute('data-lucide', String(p.name || 'star').replace(/[^a-z0-9-]/gi, '').slice(0, 60) || 'star');
      i.style.cssText = `width:${size}px;height:${size}px;${p.color ? 'color:' + _sanitizeCss(p.color) + ';' : ''}`;
      badge.appendChild(i);
      wrap.appendChild(badge);
      // Lucide swaps <i data-lucide> for an inline <svg>; the node is attached
      // after this returns, so defer the scan one tick (container-scoped).
      setTimeout(() => { try { if (window.lucide && window.lucide.createIcons) lucide.createIcons({ nodes: [wrap] }); } catch (_) {} }, 0);
      return wrap;
    },
    'stat-grid'(b) {
      const p = b.props || {};
      const cols = _n(p.cols, 1, 8);
      const grid = _el('div', `display:grid;grid-template-columns:${cols ? `repeat(${cols},1fr)` : 'repeat(auto-fit,minmax(130px,1fr))'};gap:16px;text-align:center`);
      // Live sources mirror the landing's counters (Catalog.getStats()).
      const SRC = { datasetCount: 'totalDatasets', specimenCount: 'totalEmbryos', cellCount: 'totalCells', regionCount: 'totalRegions' };
      let stats0 = null;
      try { if (typeof Catalog !== 'undefined' && Catalog.getStats) stats0 = Catalog.getStats(); } catch (_) {}
      const vs = _n(p.valueSize, 10, 120);
      (Array.isArray(p.stats) ? p.stats : []).forEach((st0) => {
        const card = _el('div', `padding:20px;background:${p.cardBg ? _sanitizeCss(p.cardBg) : 'var(--bg-surface,#161622)'};border-radius:var(--radius-md,10px)`);
        let value = st0.value;
        if (SRC[st0.source]) value = stats0 ? (stats0[SRC[st0.source]] ?? 0) : (value || 0);
        card.appendChild(_el('div', `font-size:${vs ? vs + 'px' : 'var(--text-3xl,2.5rem)'};font-weight:700;color:${p.valueColor ? _sanitizeCss(p.valueColor) : 'var(--color-primary,#00A654)'}`, String(value ?? 0)));
        card.appendChild(_el('div', `opacity:.75;margin-top:4px;${p.labelColor ? 'color:' + _sanitizeCss(p.labelColor) + ';' : ''}`, _lv(st0.label)));
        grid.appendChild(card);
      });
      return grid;
    },
    'latest-datasets'(b) {
      const p = b.props || {};
      const cols = _n(p.cols, 1, 6);
      const wrap = _el('div', `display:grid;grid-template-columns:${cols ? `repeat(${cols},1fr)` : 'repeat(auto-fill,minmax(200px,1fr))'};gap:16px`);
      let list = [];
      try { if (typeof Catalog !== 'undefined' && Catalog.list) list = Catalog.list().slice(0, Math.max(1, Math.min(12, +(p.count) || 4))); } catch (_) {}
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

  // These renderers place props.style on the right inner element themselves
  // (button → the <a>, image → the <img>, …); everyone else gets it on the root.
  const SELF_STYLED = new Set(['button', 'image', 'hero', 'icon']);

  function renderWidget(w) {
    const fn = RENDERERS[w && w.type];
    if (!fn) return null;
    try {
      const node = fn(w);
      if (!node) return null;
      const st = w.props && w.props.style;
      if (st && !SELF_STYLED.has(w.type)) node.style.cssText += ';' + styleCss(st);
      const box = _el('div', 'margin:0 0 10px');
      box.appendChild(node);
      return box;
    } catch (_) { return null; }
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
    // Pin padY/gap to 0 so un-migrated legacy {blocks} pages render exactly as
    // before: the old renderSection produced `padding:NaNpx` (a precedence bug in
    // `+p.padY ?? 48`) which browsers dropped → 0. sectionCss now defaults a
    // MISSING padY to 48, so without this the same stored JSON would gain 48px
    // of vertical padding (violates the "legacy pages render identically" rule).
    if (blocks.length) return [{ props: { fullWidth: false, padY: 0, gap: 0 }, columns: [{ width: 12, widgets: blocks }] }];
    return [];
  }

  const VALIGN = (v) => ({ start: 'flex-start', center: 'center', end: 'flex-end', stretch: 'stretch' }[v] || 'stretch');

  // ── Shared section/column CSS (single source of truth for the edit frame) ──
  // The row declares row-gap only; the live renderer appends column-gap, the
  // edit frame instead materializes gaps as resize handles of exactly `gap`px.
  // Column basis subtracts the exact per-column gap share (gap·(n-1)/n) plus a
  // half-pixel of float slack — flex-grow:1 redistributes it — so n columns +
  // their gaps always fit one flex line (the old "- gap" bases plus the in-flow
  // 12px handles overflowed the line and stacked every column full-width).
  function sectionCss(p) {
    p = p || {};
    const st = p.style || {};
    const padY = _n(p.padY, 0, 600);
    const gap = _n(p.gap, 0, 80);
    const g = gap != null ? gap : 24;
    const outer = `position:relative;padding:${padY != null ? padY : 48}px 0;` +
      `${p.bg ? 'background:' + _sanitizeCss(p.bg) + ';' : ''}` + styleCss(st);
    const inner = (p.fullWidth
      ? 'width:100%;padding:0 24px;box-sizing:border-box;'
      : `max-width:${Math.max(480, Math.min(1600, +p.maxWidth || 1080))}px;margin:0 auto;padding:0 24px;box-sizing:border-box;`) +
      'position:relative';
    const row = `display:flex;flex-wrap:wrap;row-gap:${g}px;align-items:${VALIGN(p.vAlign)}`;
    return { outer, inner, row, gap: g };
  }

  function columnCss(col, gap, n) {
    const width = Math.min(12, Math.max(1, +(col && col.width) || 12));
    const pct = (width / 12) * 100;
    const share = n > 1 ? (gap * (n - 1)) / n + 0.5 : 0;
    const p = (col && col.props) || {};
    let css = `flex:1 1 calc(${pct}% - ${share.toFixed(2)}px);min-width:min(100%,240px);box-sizing:border-box;`;
    if (p.padding) css += `padding:${parseInt(p.padding) || 0}px;`;
    if (p.vAlign && ['flex-start', 'center', 'flex-end'].includes(p.vAlign)) css += `align-self:${p.vAlign};`;
    css += styleCss(p.style);
    return css;
  }

  function renderColumn(col, gap, n) {
    const el = _el('div', columnCss(col, gap, n));
    const widgets = Array.isArray(col && col.widgets) ? col.widgets : [];
    widgets.forEach((w) => { const node = renderWidget(w); if (node) el.appendChild(node); });
    if (!widgets.length) el.appendChild(_el('div', 'min-height:1px'));
    return el;
  }

  function renderSection(sec) {
    const p = (sec && sec.props) || {};
    const c = sectionCss(p);
    const outer = _el('section', c.outer);
    const ov = overlayNode(p.style); if (ov) outer.appendChild(ov);
    const inner = _el('div', c.inner);
    const row = _el('div', c.row + `;column-gap:${c.gap}px`);
    const cols = Array.isArray(sec && sec.columns) ? sec.columns : [];
    cols.forEach((col) => row.appendChild(renderColumn(col, c.gap, cols.length)));
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
    styleCss, sectionCss, columnCss, overlayNode,
    fetchSource, fetchBlocks, normalize: _normalize, lv: _lv,
    WIDGET_TYPES, BLOCK_TYPES: WIDGET_TYPES,
  };
})();
