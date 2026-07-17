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

   STYLE OBJECT (v3.1, per widget/column/section — props.style, all optional):
     { color, textGradient, fontSize, fontWeight, lineHeight, letterSpacing, italic, uppercase, align,
       bg, bgImage, overlay, radius, borderWidth, borderColor, borderStyle, shadow, shadowColor, opacity,
       padTop, padRight, padBottom, padLeft, marginTop, marginBottom, marginLeft, marginRight,
       maxWidth, minHeight, hover, hideMobile, hideDesktop, css }
     color (since v1.16.2) accepts a plain color OR a gradient — a gradient is
     painted INTO the glyphs (background-clip:text). textGradient is the legacy
     v1.16.1 separate field, still honored (editor migrates it into color).
     Since v1.18.0: shadow gains a 'glow' preset (soft colored box-shadow) on top
     of sm/md/lg; shadowColor recolors sm/md/lg (keeping their offsets/blur) and
     supplies the glow color. hover ('lift'|'glow'|'zoom') adds a CSS class — no
     inline :hover is possible, so the class + its rule live in css/pages.css
     (styleClasses/applyStyleExtras below). hideMobile/hideDesktop likewise add
     responsive-visibility classes. css is a raw, sanitized inline-CSS escape
     hatch appended after everything else, regardless of which `groups` were
     requested.
   Compiled to sanitized inline CSS by styleCss(style, groups) — groups being
   'text' | 'surface' | 'spacing' | 'size' (hover/hide/css bypass the group
   filter — see styleClasses/applyStyleExtras). The editor (tab-pages.js) writes
   these fields; the edit frame (page-edit-frame.js) reuses sectionCss/
   columnCss/applyStyleExtras below so editor and live page can never drift.

   20 widget types: heading, richtext, image, button, divider, spacer, hero,
   gallery, icon, stat-grid, latest-datasets, html, feature-card, quote,
   accordion, timeline, cta-banner + (v1.18.0) badge, icon-list, profile,
   cite-block.

   BACKWARD-COMPAT: a legacy flat source { blocks:[…] } (or a bare array) is
   normalized to a single full-width section with one 12-unit column whose
   widgets are those blocks — so old pages keep rendering (and stop showing a
   blank page). Legacy props (section.bg/padY, column.padding, hero.bg…) are
   still honored; props.style overrides them (appended last). Every field
   introduced by v1.18.0 is optional and defaults to the exact pre-v1.18.0
   markup/CSS — a stored v1.17 doc renders pixel-identical.

   Text fields are LOCALIZED objects ({en, fr, …}); _lv() picks the current
   locale (→ en → first). Rendering is injection-safe: text via textContent
   (the richtext bold/italic/link mini-markup — "**bold**", "*italic*",
   "[link](url)" — is parsed into strong/em/a/text DOM nodes, never innerHTML;
   see _appendRichInline); the "html" widget is
   sanitized; every CSS value flows through _sanitizeCss/_urlCss/_n; every
   widget-authored href flows through _safeHref (refuses javascript:/
   vbscript:/data:). CSS lives in inline styles + var() fallbacks so it renders
   even before the full stylesheet cascade and inside the CSP (no injected
   <style>) — except the small set of hover/visibility rules that genuinely
   need a stylesheet (:hover, @media), which live in the static, CSP-'self'
   css/pages.css. Classic IIFE singleton — bare name PageRenderer.
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
    // Null-proto map: {constructor}, {toString}, {hasOwnProperty}… must NOT
    // resolve to inherited Object.prototype members (which would render
    // "function Object() { [native code] }" into public page text).
    const tk = Object.create(null);
    try { if (typeof InstanceConfig !== 'undefined' && InstanceConfig.tokens) Object.assign(tk, InstanceConfig.tokens()); } catch (_) {}
    // Page variables (dynamic builtins like {year}/{time} + operator-defined
    // fixed variables) — resolved after the brand tokens so they can win.
    try { if (typeof PageVars !== 'undefined' && PageVars.tokens) Object.assign(tk, PageVars.tokens()); } catch (_) {}
    if (!Object.keys(tk).length) return s;
    return s.replace(/\{(\w+)\}/g, (m, k) => (tk[k] != null ? String(tk[k]) : m));
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
  // Localized "no datasets" placeholder (I18n.t returns the key itself when a
  // string is missing, so fall back to a neutral default).
  function _emptyDatasetsLabel() {
    try {
      if (typeof I18n !== 'undefined' && I18n.t) {
        const s = I18n.t('pages.noDatasetsYet');
        if (s && s !== 'pages.noDatasetsYet') return s;
      }
    } catch (_) {}
    return 'No datasets to show yet.';
  }
  // One CSS *value* (color, gradient, …) — never a declaration: strip anything
  // that could close the property or smuggle extra ones in. 400 chars leaves
  // room for a 3-stop gradient whose stops are color-mix(...)-wrapped var()s.
  function _sanitizeCss(v) { return String(v == null ? '' : v).replace(/[<>;{}]/g, '').replace(/expression\s*\(/gi, '').slice(0, 400); }
  function _urlCss(u) { return String(u == null ? '' : u).replace(/["'\\<>;{}()]/g, '').slice(0, 500); }
  // A raw CSS *block* (props.style.css power-user escape hatch) — unlike
  // _sanitizeCss this legitimately contains `;` (it separates declarations),
  // so only the genuinely dangerous constructs are stripped.
  function _sanitizeCssBlock(v) {
    return String(v == null ? '' : v)
      .replace(/[<>{}]/g, '')
      .replace(/expression\s*\(/gi, '')
      .replace(/javascript\s*:/gi, '')
      .slice(0, 600);
  }
  // Anchor href guard for widget-authored links: never let a javascript:/
  // vbscript:/data: URI reach an href. Used by the link-accepting fields
  // introduced/extended in v1.18.0 (richtext inline links, icon-list items,
  // feature-card card-level href, quote.link). '' means "don't render this
  // link" (callers fall back to plain text).
  function _safeHref(u) {
    const s = String(u == null ? '' : u).trim();
    if (!s || /^\s*(javascript|vbscript|data)\s*:/i.test(s)) return '';
    return s;
  }
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
  // off/c split so shadowColor can recolor a preset while keeping its offsets/
  // blur (see styleCss 'surface' group below).
  const SHADOWS = {
    sm: { off: '0 1px 3px', c: 'rgba(0,0,0,.25)' },
    md: { off: '0 4px 16px', c: 'rgba(0,0,0,.28)' },
    lg: { off: '0 14px 36px', c: 'rgba(0,0,0,.38)' },
  };
  const BORDER_STYLES = ['solid', 'dashed', 'dotted'];

  // Text fill from a single value: a gradient paints INTO the glyphs
  // (background-clip:text + transparent color), anything else is a plain color.
  // Guarded — a non-gradient as background-image would be an invalid
  // declaration and color:transparent would blank the text.
  function _isGradientFill(v) { return /^(linear|radial|conic)-gradient\(/i.test(String(v == null ? '' : v).trim()); }
  function _textFillCss(v) {
    const s = String(v == null ? '' : v).trim();
    if (!s) return '';
    if (_isGradientFill(s)) {
      return `background-image:${_sanitizeCss(s)};-webkit-background-clip:text;background-clip:text;color:transparent;`;
    }
    return `color:${_sanitizeCss(s)};`;
  }
  // background-clip:text paints across the element BOX, so a full-width block
  // keeps the gradient centered on the box even when the text is aligned left
  // or right. Shrink the box onto the text and reposition it with margins.
  function _gradFitCss(align) {
    return 'width:fit-content;max-width:100%;' +
      (align === 'center' ? 'margin-left:auto;margin-right:auto;'
        : align === 'right' ? 'margin-left:auto;margin-right:0;'
        : 'margin-left:0;margin-right:auto;');
  }

  function styleCss(st, groups) {
    if (!st || typeof st !== 'object') return '';
    const has = (g) => !groups || groups.indexOf(g) !== -1;
    let c = '';
    if (has('text')) {
      // st.color accepts a plain color OR a gradient (painted into the glyphs).
      // st.textGradient is the legacy v1.16.1 field — still honored (it used to
      // win over color, and _textFillCss keeps that precedence).
      const fill = (st.textGradient && String(st.textGradient).trim()) || st.color;
      if (fill) c += _textFillCss(fill);
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
      if (st.shadow === 'glow') {
        const gc = st.shadowColor ? _sanitizeCss(st.shadowColor) : 'color-mix(in srgb, var(--color-primary,#00A654) 35%, transparent)';
        c += `box-shadow:0 8px 24px ${gc};`;
      } else if (SHADOWS[st.shadow]) {
        const sh = SHADOWS[st.shadow];
        c += `box-shadow:${sh.off} ${st.shadowColor ? _sanitizeCss(st.shadowColor) : sh.c};`;
      }
      const op = _n(st.opacity, 0, 100); if (op != null && op < 100) c += `opacity:${op / 100};`;
    }
    if (has('spacing')) {
      const MAP = { padTop: 'padding-top', padRight: 'padding-right', padBottom: 'padding-bottom', padLeft: 'padding-left', marginTop: 'margin-top', marginBottom: 'margin-bottom', marginLeft: 'margin-left', marginRight: 'margin-right' };
      for (const k in MAP) {
        const v = _n(st[k], k.indexOf('margin') === 0 ? -200 : 0, 500);
        if (v != null) c += `${MAP[k]}:${v}px;`;
      }
    }
    if (has('size')) {
      const mw = _n(st.maxWidth, 40, 1920); if (mw != null) c += `max-width:${mw}px;margin-left:auto;margin-right:auto;`;
      const mh = _n(st.minHeight, 0, 1600); if (mh != null) c += `min-height:${mh}px;`;
    }
    // Power-user raw CSS: group-independent (applied regardless of `groups`).
    if (st.css) {
      const cc = _sanitizeCssBlock(st.css);
      if (cc) c += cc;
    }
    return c;
  }

  // Hover/visibility can only be expressed with :hover / @media, which inline
  // styles can't do — these become classes resolved by the static css/pages.css.
  function styleClasses(st) {
    const classes = [];
    if (!st || typeof st !== 'object') return classes;
    if (st.hover === 'lift' || st.hover === 'glow' || st.hover === 'zoom') classes.push('pr-hov-' + st.hover);
    if (st.hideMobile) classes.push('pr-hide-mobile');
    if (st.hideDesktop) classes.push('pr-hide-desktop');
    return classes;
  }
  // Applies styleClasses() to `node` plus the inline --pr-glow custom property
  // the 'glow' hover class reads. Called on the WIDGET ROOT node (renderWidget),
  // and on the section/column root nodes (renderSection/renderColumn) — the
  // edit frame calls this too, on the section/column nodes it builds itself.
  function applyStyleExtras(node, st) {
    if (!node || !st || typeof st !== 'object') return;
    const classes = styleClasses(st);
    if (classes.length) node.classList.add(...classes);
    if (st.hover === 'glow') {
      const gc = st.shadowColor ? _sanitizeCss(st.shadowColor) : 'color-mix(in srgb, var(--color-primary,#00A654) 35%, transparent)';
      node.style.setProperty('--pr-glow', gc);
    }
  }

  // Tint layer over a bgImage/bg (style.overlay) — DOM, not CSS, so it needs a
  // positioned parent; consumers (section, hero) set position:relative.
  function overlayNode(st) {
    if (!st || typeof st !== 'object' || !st.overlay) return null;
    const r = _n(st.radius, 0, 300);
    return _el('div', `position:absolute;inset:0;pointer-events:none;background:${_sanitizeCss(st.overlay)};${r != null ? `border-radius:${r}px;` : ''}`);
  }

  // ── Shared widget-rendering helpers ─────────────────────────────────────────
  // richtext mini-markup — **bold**, *italic*, [text](url) — parsed and built
  // as DOM nodes (never innerHTML). Plain text with no markup produces exactly
  // one text node, matching the pre-v1.18.0 textContent assignment byte-for-byte.
  const _RICH_RE = /\*\*([^*]+)\*\*|\*([^*]+)\*|\[([^\]]+)\]\(([^)]+)\)/g;
  function _appendRichInline(container, text) {
    _RICH_RE.lastIndex = 0;
    let last = 0, m;
    while ((m = _RICH_RE.exec(text))) {
      if (m.index > last) container.appendChild(document.createTextNode(text.slice(last, m.index)));
      if (m[1] !== undefined) container.appendChild(_el('strong', '', m[1]));
      else if (m[2] !== undefined) container.appendChild(_el('em', '', m[2]));
      else {
        const href = _safeHref(m[4]);
        if (href) { const a = document.createElement('a'); a.href = href; a.textContent = m[3]; container.appendChild(a); }
        else container.appendChild(document.createTextNode(m[3]));
      }
      last = _RICH_RE.lastIndex;
    }
    if (last < text.length) container.appendChild(document.createTextNode(text.slice(last)));
  }

  // feature-card media box: icon | image | monogram | none. `compact` selects
  // the fixed 64×64 sizing used by the horizontal (props.layout:'h') layout;
  // compact=false (the 'v' layout / legacy default) reproduces the pre-v1.18.0
  // icon markup byte-for-byte when media is unset.
  function _featureMedia(p, compact) {
    const media = p.media || 'icon';
    if (media === 'none') return null;
    const mb = compact ? '' : 'margin-bottom:14px;';
    const flexRule = compact ? 'flex:0 0 auto;' : '';
    if (media === 'image') {
      if (!p.img) return null;
      const imgH = _n(p.imgH, 20, 800) || 96;
      const img = document.createElement('img');
      img.src = p.img; img.alt = ''; img.loading = 'lazy';
      if (p.plateBg) {
        const plateH = compact ? 64 : imgH + 32;
        const plate = _el('div', `${compact ? 'width:64px;' : 'width:100%;'}height:${plateH}px;border-radius:14px;display:flex;align-items:center;justify-content:center;padding:${compact ? '6px' : '16px'};box-sizing:border-box;${mb}${flexRule}background:${_sanitizeCss(p.plateBg)}`);
        img.style.cssText = 'max-height:100%;max-width:100%;object-fit:contain';
        plate.appendChild(img);
        return plate;
      }
      const h = compact ? 64 : imgH;
      img.style.cssText = `${compact ? 'width:64px;' : 'width:100%;'}height:${h}px;object-fit:cover;border-radius:14px;${mb}${flexRule}display:block`;
      return img;
    }
    if (media === 'monogram') {
      return _el('div', `${compact ? 'width:64px;' : 'width:100%;'}height:${compact ? 64 : 96}px;border-radius:14px;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:1.5rem;letter-spacing:.06em;${mb}${flexRule}` +
        `background:${p.monoBg ? _sanitizeCss(p.monoBg) : 'linear-gradient(135deg, var(--color-primary,#00A654), var(--color-accent,#00D2FF))'};color:${p.monoColor ? _sanitizeCss(p.monoColor) : '#fff'}`,
        String(p.monogram || '').slice(0, 4));
    }
    // icon (default)
    const iconName = String(p.icon || '').replace(/[^a-z0-9-]/gi, '').slice(0, 60);
    if (!iconName) return null;
    const isz = _n(p.iconSize, 12, 120) || 34;
    const dim = compact ? 64 : isz + 26;
    const badge = _el('div', `display:inline-flex;align-items:center;justify-content:center;width:${dim}px;height:${dim}px;${mb}${flexRule}` +
      `border-radius:${p.iconShape === 'square' ? '12px' : '50%'};` +
      `background:${p.iconBg ? _sanitizeCss(p.iconBg) : 'color-mix(in srgb, var(--color-primary,#00A654) 14%, transparent)'};`);
    const i = document.createElement('i');
    i.setAttribute('data-lucide', iconName);
    i.style.cssText = `width:${isz}px;height:${isz}px;color:${p.iconColor ? _sanitizeCss(p.iconColor) : 'var(--color-primary,#00A654)'}`;
    badge.appendChild(i);
    return badge;
  }

  // ── Widget renderers (the former block renderers; type names unchanged) ─────
  const RENDERERS = {
    heading(b) {
      const lvl = Math.min(4, Math.max(1, +(b.props?.level) || 2));
      return _el('h' + lvl, `text-align:${ALIGN(b.props?.align)};margin:0 0 12px;line-height:1.25`, _lv(b.text));
    },
    richtext(b) {
      const wrap = _el('div', `text-align:${ALIGN(b.props?.align)}`);
      // props.markup opts INTO the inline mini-markup. It defaults off because
      // stored text predating v1.18.0 may legitimately contain asterisks (a
      // figure legend like "* p<0.05, ** p<0.01" would silently lose them), so
      // only content authored against the parser gets parsed. The editor sets
      // markup:true on newly created richtext widgets.
      const markup = !!(b.props && b.props.markup);
      _lv(b.text).split(/\n{2,}/).forEach((para) => {
        const p = _el('p', 'line-height:1.7;margin:0 0 14px;white-space:pre-wrap');
        if (markup) _appendRichInline(p, para);
        else p.textContent = para;
        wrap.appendChild(p);
      });
      return wrap;
    },
    image(b) {
      const p = b.props || {}, st = p.style || {};
      const hasCaption = !!_lv(p.caption);
      const wrap = _el(hasCaption ? 'figure' : 'div', `text-align:${ALIGN(p.align || 'center')};${hasCaption ? 'margin:0;' : ''}` + styleCss(st, ['spacing', 'text']));
      const img = document.createElement('img');
      img.src = p.src || ''; img.alt = _lv(p.alt) || ''; img.loading = 'lazy';
      const h = _n(p.height, 10, 2000);
      img.style.cssText = `max-width:100%;height:${h ? h + 'px' : 'auto'};` +
        `${(h || p.fit) ? `object-fit:${p.fit === 'contain' ? 'contain' : 'cover'};` : ''}` +
        `border-radius:var(--radius-md,10px);${p.width ? 'width:' + (parseInt(p.width) || 0) + 'px;' : ''}` +
        styleCss(st, ['surface', 'size']);
      if (p.href) { const a = document.createElement('a'); a.href = p.href; a.appendChild(img); wrap.appendChild(a); }
      else wrap.appendChild(img);
      if (hasCaption) wrap.appendChild(_el('figcaption', 'font-size:.82rem;opacity:.65;margin-top:8px', _lv(p.caption)));
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
      // variant 'lg' is the legacy (pre-v1.18.0) value: 'accent' + the existing
      // btn-lg class, ignoring props.size (spec-mandated back-compat).
      let cls = 'btn ';
      if (variant === 'ghost') cls += 'btn-ghost';
      else if (variant === 'lg') cls += 'btn-accent btn-lg';
      else if (variant === 'outline') cls += '';
      else cls += 'btn-accent';
      if (variant !== 'lg' && p.size === 'lg') cls += ' btn-lg';
      a.className = cls.trim();
      const iconName = String(p.icon || '').replace(/[^a-z0-9-]/gi, '').slice(0, 60);
      const label = _lv(b.text) || 'Button';
      if (iconName) {
        const ic = document.createElement('i');
        ic.setAttribute('data-lucide', iconName);
        ic.style.cssText = 'width:16px;height:16px;flex:0 0 auto';
        const txt = document.createTextNode(label);
        a.style.cssText += ';display:inline-flex;align-items:center;gap:8px;';
        if (p.iconPos === 'right') { a.appendChild(txt); a.appendChild(ic); }
        else { a.appendChild(ic); a.appendChild(txt); }
        setTimeout(() => { try { if (window.lucide && window.lucide.createIcons) lucide.createIcons({ nodes: [a] }); } catch (_) {} }, 0);
      } else {
        a.textContent = label;
      }
      let extra = styleCss(st, ['text', 'surface', 'size']);
      if (variant === 'outline') extra += 'background:transparent;border:1px solid var(--color-primary,#00A654);color:var(--color-primary,#00A654);';
      if (p.size === 'sm' && variant !== 'lg') extra += 'padding:7px 14px;font-size:.85rem;';
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
      const wdCss = wd != null ? `width:${wd}%;` : '';
      // A gradient color can't paint a border-top, so it renders as a filled
      // bar instead of the classic <hr> when props.color is a gradient.
      if (p.color && _isGradientFill(p.color)) {
        return _el('div', `height:${th}px;background:${_sanitizeCss(p.color)};border-radius:2px;margin:24px auto;${wdCss}`);
      }
      return _el('hr', `border:none;border-top:${th}px ${ls} ${p.color ? _sanitizeCss(p.color) : 'var(--border-subtle,#2a2a3a)'};margin:24px auto;${wdCss}`);
    },
    spacer(b) { return _el('div', `height:${Math.max(0, Math.min(400, +(b.props?.height) || 32))}px`); },
    hero(b) {
      const p = b.props || {}, st = p.style || {};
      const align = ALIGN(p.align || 'center');
      const mh = _n(st.minHeight, 0, 1600);
      // The text style group must land on the inner h1/p, NOT the root div:
      // base.css pins color/font-size on h1..h6, so inherited values from the
      // root never reach the title (the "hero text color does nothing" bug).
      const sec = _el('div', `position:relative;overflow:hidden;padding:56px 24px;text-align:${align};border-radius:var(--radius-lg,14px);` +
        `${p.bg ? 'background:' + _sanitizeCss(p.bg) + ';' : ''}` +
        (mh ? 'display:flex;flex-direction:column;justify-content:center;' : '') +
        styleCss(st, ['surface', 'spacing', 'size']));
      const ov = overlayNode(st); if (ov) sec.appendChild(ov);
      // Two soft radial glows behind the content (mirrors .about-hero::before).
      if (p.glow) {
        const g1 = p.glowColor1 ? _sanitizeCss(p.glowColor1) : 'color-mix(in srgb, var(--color-primary,#00A654) 24%, transparent)';
        const g2 = p.glowColor2 ? _sanitizeCss(p.glowColor2) : 'color-mix(in srgb, var(--color-accent,#00D2FF) 20%, transparent)';
        sec.appendChild(_el('div', `position:absolute;inset:-45% -10% auto -10%;height:150%;pointer-events:none;background:radial-gradient(55% 60% at 15% 0%, ${g1}, transparent 70%), radial-gradient(50% 55% at 88% 8%, ${g2}, transparent 72%)`));
      }
      const inner = _el('div', 'position:relative;max-width:760px;margin:0 auto;' +
        (align === 'left' ? 'margin-left:0;' : align === 'right' ? 'margin-right:0;' : ''));
      // Badge pill, above the title. Renders nothing when the text is empty.
      if (p.badge && _lv(p.badge.text)) {
        const badgeColor = p.badgeColor ? _sanitizeCss(p.badgeColor) : 'var(--text-secondary,#b8b8c8)';
        const pill = _el('span', `display:inline-flex;align-items:center;gap:8px;padding:5px 14px;border-radius:999px;` +
          `border:1px solid color-mix(in srgb, var(--color-primary,#00A654) 30%, transparent);` +
          `background:color-mix(in srgb, var(--color-primary,#00A654) 10%, transparent);font-size:13px;margin:0 0 16px;color:${badgeColor}`);
        if (p.badge.dot) {
          pill.appendChild(_el('span', 'width:7px;height:7px;border-radius:50%;flex:0 0 auto;background:linear-gradient(135deg, var(--color-primary,#00A654), var(--color-accent,#00D2FF))'));
        } else if (p.badge.icon) {
          const ic = document.createElement('i');
          ic.setAttribute('data-lucide', String(p.badge.icon).replace(/[^a-z0-9-]/gi, '').slice(0, 60));
          ic.style.cssText = 'width:14px;height:14px;flex:0 0 auto';
          pill.appendChild(ic);
        }
        pill.appendChild(_el('span', '', _lv(p.badge.text)));
        inner.appendChild(pill);
        setTimeout(() => { try { if (window.lucide && window.lucide.createIcons) lucide.createIcons({ nodes: [pill] }); } catch (_) {} }, 0);
      }
      const ts = _n(p.titleSize, 10, 200);
      // Style-panel text group is the shared base; the dedicated per-part fills
      // (props.titleColor / props.subColor — color OR gradient) are appended
      // after it so each part is adjustable independently.
      const titleFill = p.titleColor || st.textGradient || st.color;
      if (_lv(b.text)) inner.appendChild(_el('h1', 'margin:0 0 14px;' + (ts ? `font-size:${ts}px;line-height:1.15;` : '') + styleCss(st, ['text']) + _textFillCss(p.titleColor) +
        (_isGradientFill(titleFill) ? _gradFitCss(align) : ''), _lv(b.text)));
      const ss = _n(p.subSize, 8, 80);
      // Subtitle follows the shared text style except size and the legacy
      // title-only textGradient field.
      const stSub = Object.assign({}, st, { fontSize: '', textGradient: '' });
      const subFill = p.subColor || st.color;
      if (_lv(p.subtitle)) inner.appendChild(_el('p', `font-size:${ss ? ss + 'px' : 'var(--text-lg,1.25rem)'};opacity:.85;margin:0 0 22px;` + styleCss(stSub, ['text']) + _textFillCss(p.subColor) +
        (_isGradientFill(subFill) ? _gradFitCss(align) : ''), _lv(p.subtitle)));
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
      const radiusCss = r != null ? r + 'px' : 'var(--radius-md,10px)';
      const grid = _el('div', `display:grid;grid-template-columns:${cols ? `repeat(${cols},1fr)` : 'repeat(auto-fill,minmax(160px,1fr))'};gap:${gp != null ? gp : 12}px`);
      (Array.isArray(p.images) ? p.images : []).forEach((im) => {
        const img = document.createElement('img');
        img.src = im.src || ''; img.alt = _lv(im.alt) || ''; img.loading = 'lazy';
        const needWrap = !!(p.zoom || p.captions);
        if (p.zoom) {
          img.className = 'pr-gal-img';
          img.style.cssText = `width:100%;height:${h}px;object-fit:cover;display:block`;
        } else {
          img.style.cssText = `width:100%;height:${h}px;object-fit:cover;border-radius:${radiusCss}`;
        }
        if (!needWrap) { grid.appendChild(img); return; }
        const cell = _el('div', p.zoom ? `overflow:hidden;border-radius:${radiusCss}` : '');
        if (p.zoom) cell.className = 'pr-hov-parent';
        cell.appendChild(img);
        if (p.captions) cell.appendChild(_el('div', 'font-size:.78rem;opacity:.6;margin-top:4px', _lv(im.alt)));
        grid.appendChild(cell);
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
      const padPx = _n(p.pad, 0, 120);
      const radiusPx = _n(p.radius, 0, 300);
      const borderCss = p.borderColor ? `border:1px solid ${_sanitizeCss(p.borderColor)};` : '';
      (Array.isArray(p.stats) ? p.stats : []).forEach((st0) => {
        // Per-stat colors override the widget-wide defaults (bg / valueColor /
        // labelColor on the item), each accepting a color OR a gradient.
        const cardBg = st0.bg || p.cardBg;
        const vFill = st0.valueColor || p.valueColor;
        const lFill = st0.labelColor || p.labelColor;
        const card = _el('div', `padding:${padPx != null ? padPx : 20}px;background:${cardBg ? _sanitizeCss(cardBg) : 'var(--bg-surface,#161622)'};border-radius:${radiusPx != null ? radiusPx + 'px' : 'var(--radius-md,10px)'};${borderCss}`);
        let value = st0.value;
        if (SRC[st0.source]) value = stats0 ? (stats0[SRC[st0.source]] ?? 0) : (value || 0);
        card.appendChild(_el('div', `font-size:${vs ? vs + 'px' : 'var(--text-3xl,2.5rem)'};font-weight:700;` +
          (vFill ? _textFillCss(vFill) + (_isGradientFill(vFill) ? _gradFitCss('center') : '') : 'color:var(--color-primary,#00A654);'), String(value ?? 0)));
        card.appendChild(_el('div', `opacity:.75;margin-top:4px;` +
          (lFill ? _textFillCss(lFill) + (_isGradientFill(lFill) ? _gradFitCss('center') : '') : ''), _lv(st0.label)));
        grid.appendChild(card);
      });
      return grid;
    },
    'latest-datasets'(b) {
      const p = b.props || {};
      const cols = _n(p.cols, 1, 6);
      const wrap = _el('div', `display:grid;grid-template-columns:${cols ? `repeat(${cols},1fr)` : 'repeat(auto-fill,minmax(200px,1fr))'};gap:16px`);
      let list = [];
      // The catalog exposes getAll() (NOT list()); mirror the landing's "featured"
      // ordering — newest first by date — then take `count`.
      try {
        if (typeof Catalog !== 'undefined' && Catalog.getAll) {
          list = [...Catalog.getAll()]
            .sort((a, c) => String(c.date || '').localeCompare(String(a.date || '')))
            .slice(0, Math.max(1, Math.min(12, +(p.count) || 4)));
        }
      } catch (_) {}
      if (!list.length) {
        wrap.style.gridTemplateColumns = '1fr';
        wrap.appendChild(_el('div', 'opacity:.55;padding:18px;text-align:center;border:1px dashed var(--border-subtle,#2a2a3a);border-radius:var(--radius-md,10px)', _emptyDatasetsLabel()));
        return wrap;
      }
      const th = _n(p.thumbHeight, 60, 320) || 120;
      const showMeta = p.showMeta !== false;
      const cardBg = p.cardBg ? _sanitizeCss(p.cardBg) : 'var(--bg-surface,#161622)';
      const borderColor = p.borderColor ? _sanitizeCss(p.borderColor) : 'var(--border-subtle,#2a2a3a)';
      const radiusN = _n(p.radius, 0, 300);
      const radiusCss = radiusN != null ? radiusN + 'px' : 'var(--radius-md,10px)';
      const titleColorCss = p.titleColor ? `;color:${_sanitizeCss(p.titleColor)}` : '';
      let needIcons = false;
      list.forEach((ds) => {
        const a = document.createElement('a');
        a.href = `viewer.html?id=${encodeURIComponent(ds.id)}`;
        a.style.cssText = `display:block;overflow:hidden;background:${cardBg};border-radius:${radiusCss};text-decoration:none;color:inherit;border:1px solid ${borderColor}`;
        if (p.hover) a.classList.add('pr-hov-lift');
        const thumb = _el('div', `height:${th}px;display:flex;align-items:center;justify-content:center;background:color-mix(in srgb, var(--color-primary,#00A654) 7%, transparent)`);
        if (ds.thumbnail) {
          const img = document.createElement('img');
          img.src = ds.thumbnail; img.alt = ds.name || ds.id; img.loading = 'lazy';
          img.style.cssText = 'width:100%;height:100%;object-fit:cover';
          thumb.appendChild(img);
        } else {
          const i = document.createElement('i');
          i.setAttribute('data-lucide', 'layers');
          i.style.cssText = 'width:30px;height:30px;color:var(--text-muted,#8a8a9a);opacity:.6';
          thumb.appendChild(i);
          needIcons = true;
        }
        a.appendChild(thumb);
        const body = _el('div', 'padding:12px 14px');
        body.appendChild(_el('div', 'font-weight:600;line-height:1.35' + titleColorCss, ds.name || ds.id));
        if (showMeta) {
          const meta = _el('div', 'display:flex;gap:10px;align-items:baseline;margin-top:5px;font-size:var(--text-sm,.8rem)');
          if (ds.type) meta.appendChild(_el('span', 'color:var(--color-primary,#00A654);font-weight:600;text-transform:uppercase;font-size:.7rem;letter-spacing:.05em', ds.type));
          let dateStr = '';
          try { dateStr = (typeof Utils !== 'undefined' && Utils.formatDate) ? Utils.formatDate(ds.date) : String(ds.date || ''); } catch (_) { dateStr = String(ds.date || ''); }
          if (dateStr) meta.appendChild(_el('span', 'opacity:.55', dateStr));
          if (meta.childNodes.length) body.appendChild(meta);
        }
        a.appendChild(body);
        wrap.appendChild(a);
      });
      if (needIcons) setTimeout(() => { try { if (window.lucide && window.lucide.createIcons) lucide.createIcons({ nodes: [wrap] }); } catch (_) {} }, 0);
      return wrap;
    },
    html(b) { const div = document.createElement('div'); div.innerHTML = _sanitizeHtml(_lv(b.props?.html)); return div; },
    'feature-card'(b) {
      const p = b.props || {};
      const align = ALIGN(p.align || 'left');
      const layout = p.layout === 'h' ? 'h' : 'v';
      // Whole-card link (v1.18.0): the card itself becomes an <a> when a valid
      // href is supplied; falls back to a plain <div> otherwise (unchanged).
      const href = p.href ? _safeHref(p.href) : '';
      const card = href ? document.createElement('a') : document.createElement('div');
      card.style.cssText = `padding:26px;background:var(--bg-surface,#161622);border-radius:var(--radius-md,12px);text-align:${align};height:100%;box-sizing:border-box` +
        (href ? ';display:block;color:inherit;text-decoration:none' : '') +
        (layout === 'h' ? ';display:flex;align-items:flex-start;gap:18px' : '');
      if (href) card.href = href;

      const mediaNode = _featureMedia(p, layout === 'h');
      if (mediaNode) setTimeout(() => { try { if (window.lucide && window.lucide.createIcons) lucide.createIcons({ nodes: [card] }); } catch (_) {} }, 0);

      const textCol = layout === 'h' ? _el('div', 'flex:1 1 auto;min-width:0;text-align:' + align) : null;
      const target = textCol || card;

      const titleSize = _n(p.titleSize, 10, 60);
      if (_lv(b.text)) target.appendChild(_el('h3', `margin:0 0 8px;font-size:${titleSize != null ? titleSize + 'px' : '1.15rem'};line-height:1.3;` +
        (p.titleColor ? `color:${_sanitizeCss(p.titleColor)}` : 'color:inherit'), _lv(b.text)));
      if (_lv(p.desc)) target.appendChild(_el('p', 'margin:0;opacity:.75;line-height:1.65;white-space:pre-wrap' +
        (p.descColor ? `;color:${_sanitizeCss(p.descColor)}` : ''), _lv(p.desc)));
      if (p.link && _lv(p.link.text)) {
        const a = document.createElement('a');
        a.href = p.link.href || '#';
        a.style.cssText = `display:inline-flex;align-items:center;gap:6px;margin-top:14px;color:${p.linkColor ? _sanitizeCss(p.linkColor) : 'var(--color-primary,#00A654)'};text-decoration:none;font-weight:600;font-size:.92rem`;
        a.textContent = _lv(p.link.text) + (p.linkArrow === false ? '' : ' →');
        target.appendChild(a);
      }

      if (layout === 'h') {
        if (mediaNode) card.appendChild(mediaNode);
        card.appendChild(textCol);
      } else if (mediaNode) {
        // Inserted first so a stored-without-media legacy card (mediaNode===null)
        // keeps appending h3/p/link directly to `card` in the exact original order.
        card.insertBefore(mediaNode, card.firstChild);
      }
      return card;
    },
    quote(b) {
      const p = b.props || {};
      const variant = (p.variant === 'card' || p.variant === 'big') ? p.variant : 'bar';
      const accent = p.accent ? _sanitizeCss(p.accent) : 'var(--color-primary,#00A654)';
      const root = _el('figure',
        variant === 'card' ? 'margin:0;position:relative;background:var(--bg-surface,#161622);border-radius:var(--radius-md,12px);padding:28px 28px 24px'
        : variant === 'big' ? 'margin:0;text-align:center;padding:8px 0'
        : `margin:0;border-left:4px solid ${accent};padding:6px 0 6px 20px`);
      if (_lv(p.label)) root.appendChild(_el('div', `font-size:.76rem;text-transform:uppercase;letter-spacing:.1em;font-weight:600;color:${accent};margin-bottom:7px`, _lv(p.label)));
      if (variant === 'card') root.appendChild(_el('div', `position:absolute;top:6px;left:16px;font-size:64px;line-height:1;font-family:Georgia,serif;color:${accent};opacity:.28;pointer-events:none`, '“'));
      if (variant === 'big') root.appendChild(_el('div', `font-size:56px;line-height:.9;font-family:Georgia,serif;color:${accent}`, '“'));
      const q = _el('blockquote', `margin:0;font-style:italic;line-height:1.7;white-space:pre-wrap;` +
        (variant === 'big' ? 'font-size:1.3rem;' : 'font-size:1.02rem;') + (variant === 'card' ? 'position:relative;' : ''), _lv(b.text));
      root.appendChild(q);
      if (_lv(p.author) || _lv(p.role) || p.avatar) {
        const cap = document.createElement('figcaption');
        cap.style.cssText = `display:flex;align-items:center;gap:11px;margin-top:16px;${variant === 'big' ? 'justify-content:center;' : ''}`;
        if (p.avatar) {
          const img = document.createElement('img');
          img.src = p.avatar; img.alt = _lv(p.author) || ''; img.loading = 'lazy';
          img.style.cssText = 'width:42px;height:42px;border-radius:50%;object-fit:cover;flex:0 0 auto';
          cap.appendChild(img);
        }
        const who = _el('div', 'text-align:left');
        if (_lv(p.author)) who.appendChild(_el('div', 'font-weight:700;font-style:normal;font-size:.95rem', _lv(p.author)));
        if (_lv(p.role)) who.appendChild(_el('div', 'opacity:.6;font-size:.82rem', _lv(p.role)));
        cap.appendChild(who);
        root.appendChild(cap);
      }
      if (p.link && _lv(p.link.text)) {
        const href = _safeHref(p.link.href);
        const linkEl = href ? document.createElement('a') : document.createElement('span');
        if (href) linkEl.href = href;
        linkEl.textContent = _lv(p.link.text);
        linkEl.style.cssText = `display:block;margin-top:10px;font-family:var(--font-mono,monospace);font-size:.78rem;color:${accent}`;
        root.appendChild(linkEl);
      }
      return root;
    },
    accordion(b) {
      const p = b.props || {};
      const items = Array.isArray(p.items) ? p.items : [];
      // `name` makes <details> mutually exclusive in modern browsers; elsewhere
      // items simply stay independently openable (graceful degradation).
      const group = p.single ? 'acc-' + String(b.id || Math.random().toString(36).slice(2, 8)).replace(/[^a-z0-9_-]/gi, '') : null;
      const accent = p.iconColor ? _sanitizeCss(p.iconColor) : 'var(--color-primary,#00A654)';
      const itemBg = p.itemBg ? _sanitizeCss(p.itemBg) : 'var(--bg-surface,#161622)';
      const borderColor = p.borderColor ? _sanitizeCss(p.borderColor) : 'var(--border-subtle,#2a2a3a)';
      const wrap = _el('div', 'display:flex;flex-direction:column;gap:10px');
      items.forEach((it, idx) => {
        const d = document.createElement('details');
        if (group) d.setAttribute('name', group);
        if (p.firstOpen && idx === 0) d.open = true;
        d.style.cssText = `background:${itemBg};border:1px solid ${borderColor};border-radius:10px;overflow:hidden`;
        const s = document.createElement('summary');
        s.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 18px;cursor:pointer;font-weight:600;list-style:none;user-select:none';
        s.appendChild(_el('span', 'flex:1', _lv(it.q)));
        const chev = _el('span', `display:inline-flex;flex:0 0 auto;color:${accent};transition:transform .18s;${d.open ? 'transform:rotate(180deg);' : ''}`);
        const ic = document.createElement('i');
        ic.setAttribute('data-lucide', 'chevron-down');
        ic.style.cssText = 'width:18px;height:18px';
        chev.appendChild(ic);
        s.appendChild(chev);
        d.appendChild(s);
        d.appendChild(_el('div', 'padding:0 18px 16px;line-height:1.65;opacity:.85;white-space:pre-wrap', _lv(it.a)));
        d.addEventListener('toggle', () => { chev.style.transform = d.open ? 'rotate(180deg)' : ''; });
        wrap.appendChild(d);
      });
      setTimeout(() => { try { if (window.lucide && window.lucide.createIcons) lucide.createIcons({ nodes: [wrap] }); } catch (_) {} }, 0);
      return wrap;
    },
    timeline(b) {
      const p = b.props || {};
      const items = Array.isArray(p.items) ? p.items : [];
      const accent = p.accent ? _sanitizeCss(p.accent) : 'var(--color-primary,#00A654)';
      const line = p.lineColor ? _sanitizeCss(p.lineColor) : 'var(--border-subtle,#2a2a3a)';
      const wrap = _el('div', 'position:relative;padding-left:30px');
      wrap.appendChild(_el('div', `position:absolute;left:9px;top:8px;bottom:8px;width:2px;border-radius:1px;background:${line}`));
      items.forEach((it, idx) => {
        const item = _el('div', `position:relative;${idx < items.length - 1 ? 'margin:0 0 26px;' : ''}`);
        item.appendChild(_el('div', `position:absolute;left:-27px;top:4px;width:12px;height:12px;border-radius:50%;background:${accent};box-shadow:0 0 0 4px color-mix(in srgb, ${accent} 22%, transparent)`));
        if (_lv(it.date)) item.appendChild(_el('div', `font-size:.76rem;font-weight:700;letter-spacing:.07em;text-transform:uppercase;color:${accent};margin-bottom:3px`, _lv(it.date)));
        if (_lv(it.title)) item.appendChild(_el('h4', 'margin:0 0 5px;font-size:1.04rem;color:inherit', _lv(it.title)));
        if (_lv(it.text)) item.appendChild(_el('p', 'margin:0;opacity:.72;line-height:1.6;white-space:pre-wrap', _lv(it.text)));
        wrap.appendChild(item);
      });
      return wrap;
    },
    'cta-banner'(b) {
      const p = b.props || {};
      const centered = p.align === 'center';
      const bg = p.bg ? _sanitizeCss(p.bg) : 'linear-gradient(135deg, var(--color-primary,#00A654) 0%, var(--color-accent,#00D2FF) 100%)';
      const root = _el('div', `position:relative;overflow:hidden;display:flex;align-items:center;gap:20px 28px;flex-wrap:wrap;padding:30px 34px;` +
        `border-radius:var(--radius-lg,14px);background:${bg};color:#fff;` +
        (centered ? 'flex-direction:column;text-align:center;justify-content:center;' : 'justify-content:space-between;'));
      const txt = _el('div', centered ? '' : 'flex:1;min-width:220px');
      if (_lv(b.text)) txt.appendChild(_el('h3', 'margin:0 0 6px;font-size:1.45rem;line-height:1.25;color:inherit', _lv(b.text)));
      if (_lv(p.subtitle)) txt.appendChild(_el('p', 'margin:0;opacity:.85;line-height:1.55', _lv(p.subtitle)));
      root.appendChild(txt);
      const mkCta = (cta, ghost) => {
        const a = document.createElement('a');
        a.href = cta.href || '#';
        a.style.cssText = ghost
          ? 'flex:0 0 auto;display:inline-block;padding:12px 24px;border-radius:10px;background:transparent;border:1px solid rgba(255,255,255,.5);color:#fff;font-weight:700;text-decoration:none;white-space:nowrap'
          : 'flex:0 0 auto;display:inline-block;padding:12px 24px;border-radius:10px;background:#fff;color:#14141f;font-weight:700;text-decoration:none;white-space:nowrap;box-shadow:0 4px 14px rgba(0,0,0,.22)';
        a.textContent = _lv(cta.text);
        return a;
      };
      const hasCta1 = p.cta && _lv(p.cta.text);
      const hasCta2 = p.cta2 && _lv(p.cta2.text);
      if (hasCta1 && hasCta2) {
        // Two buttons: group them so they wrap/center together.
        const row = _el('div', 'flex:0 0 auto;display:flex;gap:12px;flex-wrap:wrap;' + (centered ? 'justify-content:center;' : ''));
        row.appendChild(mkCta(p.cta, false));
        row.appendChild(mkCta(p.cta2, true));
        root.appendChild(row);
      } else if (hasCta1) {
        // Legacy single-CTA shape: appended directly to root, unchanged.
        root.appendChild(mkCta(p.cta, false));
      } else if (hasCta2) {
        root.appendChild(mkCta(p.cta2, true));
      }
      return root;
    },
    badge(b) {
      const p = b.props || {};
      const align = ALIGN(p.align);
      const items = Array.isArray(p.items) ? p.items : [];
      const pillBg = p.pillBg ? _sanitizeCss(p.pillBg) : 'color-mix(in srgb, var(--bg-base,#0d0d1a) 65%, transparent)';
      const pillColor = p.pillColor ? _sanitizeCss(p.pillColor) : 'var(--text-secondary,#b8b8c8)';
      const borderColor = p.borderColor ? _sanitizeCss(p.borderColor) : 'var(--border-default,#3a3a4a)';
      const size = _n(p.size, 8, 60) || 12.5;
      const gap = _n(p.gap, 0, 60);
      const gp = gap != null ? gap : 8;
      const mono = !!p.mono;
      const dot = p.dot !== false;
      const wrap = _el('div', `display:flex;flex-wrap:wrap;gap:${gp}px;justify-content:${align === 'center' ? 'center' : align === 'right' ? 'flex-end' : 'flex-start'}`);
      let needIcons = false;
      items.forEach((it) => {
        const pill = _el('span', `display:inline-flex;align-items:center;gap:7px;padding:5px 13px;border-radius:999px;border:1px solid ${borderColor};background:${pillBg};color:${pillColor};font-size:${size}px;` +
          (mono ? 'font-family:var(--font-mono,monospace);' : ''));
        const iconName = String(it.icon || '').replace(/[^a-z0-9-]/gi, '').slice(0, 60);
        if (iconName) {
          const i = document.createElement('i');
          i.setAttribute('data-lucide', iconName);
          i.style.cssText = `width:14px;height:14px;color:${pillColor};flex:0 0 auto`;
          pill.appendChild(i);
          needIcons = true;
        } else if (dot) {
          pill.appendChild(_el('span', 'width:7px;height:7px;border-radius:50%;flex:0 0 auto;background:linear-gradient(135deg, var(--color-primary,#00A654), var(--color-accent,#00D2FF))'));
        }
        pill.appendChild(_el('span', '', _lv(it.text)));
        wrap.appendChild(pill);
      });
      if (needIcons) setTimeout(() => { try { if (window.lucide && window.lucide.createIcons) lucide.createIcons({ nodes: [wrap] }); } catch (_) {} }, 0);
      return wrap;
    },
    'icon-list'(b) {
      const p = b.props || {};
      const items = Array.isArray(p.items) ? p.items : [];
      const layout = p.layout === 'h' ? 'h' : 'v';
      const iconColor = p.iconColor ? _sanitizeCss(p.iconColor) : 'var(--color-accent,#00D2FF)';
      const iconSize = _n(p.iconSize, 8, 80) || 18;
      const gap = _n(p.gap, 0, 80);
      const gp = gap != null ? gap : 12;
      const textSize = _n(p.textSize, 8, 60);
      const wrap = _el('div', `display:flex;${layout === 'h' ? 'flex-direction:row;flex-wrap:wrap;' : 'flex-direction:column;'}gap:${gp}px`);
      let needIcons = false;
      items.forEach((it) => {
        const row = _el('div', `display:flex;align-items:center;gap:10px${textSize != null ? `;font-size:${textSize}px` : ''}`);
        const iconName = String(it.icon || 'check').replace(/[^a-z0-9-]/gi, '').slice(0, 60) || 'check';
        const ic = document.createElement('i');
        ic.setAttribute('data-lucide', iconName);
        ic.style.cssText = `width:${iconSize}px;height:${iconSize}px;flex:0 0 auto;color:${iconColor}`;
        row.appendChild(ic);
        needIcons = true;
        // mailto: is a normal safe scheme; only javascript:/vbscript:/data: are refused.
        const href = it.href ? _safeHref(it.href) : '';
        if (href) {
          const a = document.createElement('a');
          a.href = href; a.textContent = _lv(it.text);
          a.style.cssText = 'color:var(--color-accent,#00D2FF);text-decoration:none';
          row.appendChild(a);
        } else {
          row.appendChild(_el('span', '', _lv(it.text)));
        }
        wrap.appendChild(row);
      });
      if (needIcons) setTimeout(() => { try { if (window.lucide && window.lucide.createIcons) lucide.createIcons({ nodes: [wrap] }); } catch (_) {} }, 0);
      return wrap;
    },
    profile(b) {
      const p = b.props || {};
      const layout = p.layout === 'v' ? 'v' : 'h';
      const mediaKind = ['monogram', 'image', 'icon', 'none'].includes(p.mediaKind) ? p.mediaKind : 'monogram';
      const mediaSize = _n(p.mediaSize, 24, 300) || 64;
      const mediaRadiusN = _n(p.mediaRadius, 0, 300);
      const mediaRadiusCss = mediaRadiusN != null ? mediaRadiusN + 'px' : '18px';
      const mediaBg = p.mediaBg ? _sanitizeCss(p.mediaBg) : 'linear-gradient(135deg, var(--color-primary,#00A654), var(--color-accent,#00D2FF))';
      const mediaColor = p.mediaColor ? _sanitizeCss(p.mediaColor) : '#fff';
      const roleColor = p.roleColor ? _sanitizeCss(p.roleColor) : 'var(--color-accent,#00D2FF)';
      const nameSize = _n(p.nameSize, 10, 80) || 22;
      const glowMedia = p.glowMedia !== false;

      const root = _el('div', layout === 'v' ? 'text-align:center' : '');
      const header = _el('div', layout === 'v' ? 'display:flex;flex-direction:column;align-items:center' : 'display:flex;align-items:center;gap:16px');

      let mediaNode = null;
      if (mediaKind === 'monogram') {
        mediaNode = _el('div', `width:${mediaSize}px;height:${mediaSize}px;border-radius:${mediaRadiusCss};display:flex;align-items:center;justify-content:center;flex:0 0 auto;font-weight:700;font-size:${mediaSize * 0.33}px;letter-spacing:.04em;background:${mediaBg};color:${mediaColor}`,
          String(p.monogram || 'AB').slice(0, 4));
      } else if (mediaKind === 'image' && p.img) {
        const img = document.createElement('img');
        img.src = p.img; img.alt = _lv(p.name) || ''; img.loading = 'lazy';
        img.style.cssText = `width:${mediaSize}px;height:${mediaSize}px;border-radius:${mediaRadiusCss};object-fit:cover;flex:0 0 auto;display:block`;
        mediaNode = img;
      } else if (mediaKind === 'icon') {
        const iconName = String(p.icon || 'user').replace(/[^a-z0-9-]/gi, '').slice(0, 60) || 'user';
        const box = _el('div', `width:${mediaSize}px;height:${mediaSize}px;border-radius:${mediaRadiusCss};display:flex;align-items:center;justify-content:center;flex:0 0 auto;background:${mediaBg};color:${mediaColor}`);
        const ic = document.createElement('i');
        ic.setAttribute('data-lucide', iconName);
        const iconPx = Math.round(mediaSize * 0.55);
        ic.style.cssText = `width:${iconPx}px;height:${iconPx}px`;
        box.appendChild(ic);
        mediaNode = box;
        setTimeout(() => { try { if (window.lucide && window.lucide.createIcons) lucide.createIcons({ nodes: [box] }); } catch (_) {} }, 0);
      }
      if (mediaNode) {
        if (glowMedia) mediaNode.style.cssText += ';box-shadow:0 8px 24px color-mix(in srgb, var(--color-primary,#00A654) 35%, transparent)';
        if (layout === 'v') mediaNode.style.cssText += ';margin:0 auto 12px';
        header.appendChild(mediaNode);
      }

      const idBlock = _el('div', '');
      if (_lv(p.name)) idBlock.appendChild(_el('div', `font-size:${nameSize}px;font-weight:700;line-height:1.1`, _lv(p.name)));
      if (_lv(p.role)) idBlock.appendChild(_el('div', `margin-top:5px;font-size:.72rem;font-weight:600;text-transform:uppercase;letter-spacing:.12em;color:${roleColor}`, _lv(p.role)));
      header.appendChild(idBlock);

      root.appendChild(header);
      if (_lv(p.desc)) root.appendChild(_el('p', 'margin-top:10px;opacity:.75;line-height:1.6;white-space:pre-wrap', _lv(p.desc)));
      return root;
    },
    'cite-block'(b) {
      const p = b.props || {};
      const mono = p.mono !== false;
      const showCopy = p.copy !== false;
      const root = _el('div', 'border:1px solid var(--border-subtle,#2a2a3a);border-radius:18px;background:var(--bg-surface,#161622);overflow:hidden');
      const header = _el('div', 'display:flex;align-items:center;justify-content:space-between;gap:10px;padding:14px 18px;border-bottom:1px solid var(--border-subtle,#2a2a3a)');
      if (_lv(p.title)) header.appendChild(_el('h3', 'font-size:.95rem;margin:0', _lv(p.title)));
      let copyBtn = null, copyLabelEl = null;
      if (showCopy) {
        copyBtn = document.createElement('button');
        copyBtn.type = 'button';
        copyBtn.style.cssText = 'display:inline-flex;align-items:center;gap:6px;height:30px;padding:0 12px;font-size:.75rem;font-weight:600;background:var(--bg-base,#0d0d1a);border:1px solid var(--border-default,#3a3a4a);border-radius:8px;cursor:pointer;color:var(--text-secondary,#b8b8c8)';
        const ic = document.createElement('i');
        ic.setAttribute('data-lucide', 'copy');
        ic.style.cssText = 'width:14px;height:14px';
        copyLabelEl = document.createElement('span');
        let copyLabel = 'Copier';
        try { if (typeof I18n !== 'undefined' && I18n.t) { const s = I18n.t('pages.w.copy'); if (s && s !== 'pages.w.copy') copyLabel = s; } } catch (_) {}
        copyLabelEl.textContent = copyLabel;
        copyBtn.appendChild(ic); copyBtn.appendChild(copyLabelEl);
        header.appendChild(copyBtn);
      }
      root.appendChild(header);

      const body = _el('div', 'padding:18px');
      body.appendChild(_el('p', `margin:0;font-size:.82rem;line-height:1.7;color:var(--text-secondary,#b8b8c8);white-space:pre-wrap;word-break:break-word;${mono ? 'font-family:var(--font-mono,monospace)' : ''}`, _lv(p.text)));

      if (copyBtn) {
        // Clipboard access can be denied inside the editor iframe — fail silent.
        copyBtn.addEventListener('click', () => {
          try {
            navigator.clipboard.writeText(_lv(p.text)).then(() => {
              const prev = copyLabelEl.textContent;
              let copiedLabel = 'Copié ✓';
              try { if (typeof I18n !== 'undefined' && I18n.t) { const s = I18n.t('pages.w.copied'); if (s && s !== 'pages.w.copied') copiedLabel = s; } } catch (_) {}
              copyLabelEl.textContent = copiedLabel;
              setTimeout(() => { copyLabelEl.textContent = prev; }, 1600);
            }).catch(() => {});
          } catch (_) {}
        });
      }

      if (_lv(p.extra)) {
        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.style.cssText = 'background:none;border:none;font-family:var(--font-mono,monospace);font-size:.75rem;color:var(--text-muted,#8a8a9a);cursor:pointer;margin-top:10px;display:inline-flex;align-items:center;gap:6px;padding:0';
        const ic2 = document.createElement('i');
        ic2.setAttribute('data-lucide', 'braces');
        ic2.style.cssText = 'width:13px;height:13px';
        const toggleLabelEl = document.createElement('span');
        toggleLabelEl.textContent = _lv(p.extraLabel) || 'BibTeX';
        toggle.appendChild(ic2); toggle.appendChild(toggleLabelEl);
        const pre = document.createElement('pre');
        pre.style.cssText = 'display:none;margin-top:10px;padding:14px;border:1px solid var(--border-subtle,#2a2a3a);border-radius:12px;background:var(--bg-base,#0d0d1a);font-family:var(--font-mono,monospace);font-size:.75rem;overflow-x:auto';
        pre.textContent = _lv(p.extra);
        toggle.addEventListener('click', () => { pre.style.display = pre.style.display === 'none' ? 'block' : 'none'; });
        body.appendChild(toggle);
        body.appendChild(pre);
      }

      root.appendChild(body);
      setTimeout(() => { try { if (window.lucide && window.lucide.createIcons) lucide.createIcons({ nodes: [root] }); } catch (_) {} }, 0);
      return root;
    },
  };

  const WIDGET_TYPES = Object.keys(RENDERERS);

  // These renderers place props.style on the right inner element themselves
  // (button → the <a>, image → the <img>, …); everyone else gets it on the root.
  const SELF_STYLED = new Set(['button', 'image', 'hero', 'icon']);

  // Text-only widgets where a gradient text fill must shrink-wrap onto the text
  // (see _gradFitCss); container widgets keep their natural full-width box.
  const GRAD_FIT = new Set(['heading', 'richtext']);

  function renderWidget(w) {
    const fn = RENDERERS[w && w.type];
    if (!fn) return null;
    try {
      const node = fn(w);
      if (!node) return null;
      const st = w.props && w.props.style;
      if (st && !SELF_STYLED.has(w.type)) {
        node.style.cssText += ';' + styleCss(st);
        const fill = st.textGradient || st.color;
        if (GRAD_FIT.has(w.type) && _isGradientFill(fill)) {
          node.style.cssText += ';' + _gradFitCss(ALIGN(st.align || (w.props && w.props.align) || 'left'));
        }
      }
      // Hover/hide classes + --pr-glow apply to the widget ROOT regardless of
      // SELF_STYLED (they're a visual affordance on the whole widget box, not
      // part of the text/surface/spacing/size groups).
      if (st) applyStyleExtras(node, st);
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
    applyStyleExtras(el, (col && col.props || {}).style);
    const widgets = Array.isArray(col && col.widgets) ? col.widgets : [];
    widgets.forEach((w) => { const node = renderWidget(w); if (node) el.appendChild(node); });
    if (!widgets.length) el.appendChild(_el('div', 'min-height:1px'));
    return el;
  }

  function renderSection(sec) {
    const p = (sec && sec.props) || {};
    const c = sectionCss(p);
    const outer = _el('section', c.outer);
    applyStyleExtras(outer, p.style);
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
    styleCss, sectionCss, columnCss, overlayNode, styleClasses, applyStyleExtras,
    fetchSource, fetchBlocks, normalize: _normalize, lv: _lv,
    WIDGET_TYPES, BLOCK_TYPES: WIDGET_TYPES,
  };
})();
