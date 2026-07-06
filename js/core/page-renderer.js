/* ============================================================
   Lumen3D — Block page renderer (white-label page builder)
   ============================================================
   Renders an ordered list of content blocks (authored in the admin
   "Pages" tab, stored in config/pages/<slug>.json) into a container.
   Used by page.html (custom pages) and optionally by the landing/about
   pages when the operator has published a block layout for them.

   Text fields are LOCALIZED objects ({en, fr, …}); _lv() picks the
   current locale with an English fallback. Rendering is injection-safe:
   plain text uses textContent; the single "html" block is sanitized
   (script/style/iframe/on*-attribute stripped) since it is authored by
   the trusted operator but must not become a stored-XSS foothold.

   Classic IIFE singleton — referenced by the bare name PageRenderer.
   ============================================================ */

const PageRenderer = (() => {
  'use strict';

  function _loc() {
    try { if (typeof I18n !== 'undefined' && I18n.getLanguage) return I18n.getLanguage(); } catch (_) {}
    return 'en';
  }
  // Localized value → string (current locale → en → first). Accepts a plain string.
  function _lv(v) {
    if (v == null) return '';
    if (typeof v === 'string') return v;
    if (typeof v === 'object' && !Array.isArray(v)) { const l = _loc(); return v[l] || v.en || Object.values(v)[0] || ''; }
    return String(v);
  }

  function _el(tag, style, text) {
    const e = document.createElement(tag);
    if (style) e.style.cssText = style;
    if (text != null) e.textContent = text;
    return e;
  }

  // Minimal HTML sanitizer for the operator-authored "html" block: parse into a
  // detached document, drop dangerous elements and on*/href:javascript attributes.
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

  const ALIGN = (a) => (a === 'center' || a === 'right' ? a : (a === 'left' ? 'left' : 'left'));

  // ── Block renderers ───────────────────────────────────────────
  const RENDERERS = {
    heading(b) {
      const lvl = Math.min(3, Math.max(1, +(b.props?.level) || 2));
      const h = _el('h' + lvl, `text-align:${ALIGN(b.props?.align)};margin:0 0 12px`, _lv(b.text));
      return h;
    },
    richtext(b) {
      const wrap = _el('div', `text-align:${ALIGN(b.props?.align)}`);
      _lv(b.text).split(/\n{2,}/).forEach((para) => {
        const p = _el('p', 'line-height:1.7;margin:0 0 14px;white-space:pre-wrap', para);
        wrap.appendChild(p);
      });
      return wrap;
    },
    image(b) {
      const wrap = _el('div', `text-align:${ALIGN(b.props?.align || 'center')}`);
      const img = document.createElement('img');
      img.src = b.props?.src || '';
      img.alt = _lv(b.props?.alt) || '';
      img.style.cssText = `max-width:100%;height:auto;border-radius:var(--radius-md,10px);${b.props?.width ? 'width:' + (parseInt(b.props.width) || 0) + 'px;' : ''}`;
      if (b.props?.href) { const a = document.createElement('a'); a.href = b.props.href; a.appendChild(img); wrap.appendChild(a); }
      else wrap.appendChild(img);
      return wrap;
    },
    button(b) {
      const wrap = _el('div', `text-align:${ALIGN(b.props?.align || 'left')};margin:6px 0`);
      const a = document.createElement('a');
      a.href = b.props?.href || '#';
      a.className = 'btn ' + (b.props?.style === 'ghost' ? 'btn-ghost' : 'btn-accent');
      a.textContent = _lv(b.text) || 'Button';
      wrap.appendChild(a);
      return wrap;
    },
    divider() { return _el('hr', 'border:none;border-top:1px solid var(--border-subtle,#2a2a3a);margin:24px 0'); },
    spacer(b) { return _el('div', `height:${Math.max(0, Math.min(400, +(b.props?.height) || 32))}px`); },
    hero(b) {
      const sec = _el('section', `padding:64px 0;text-align:center;${b.props?.bg ? 'background:' + _sanitizeCss(b.props.bg) + ';' : ''}border-radius:var(--radius-lg,14px)`);
      const inner = _el('div', 'max-width:760px;margin:0 auto;padding:0 24px');
      if (_lv(b.text)) inner.appendChild(_el('h1', 'margin:0 0 14px', _lv(b.text)));
      if (_lv(b.props?.subtitle)) inner.appendChild(_el('p', 'font-size:var(--text-lg,1.25rem);opacity:.8;margin:0 0 22px', _lv(b.props.subtitle)));
      const cta = b.props?.cta;
      if (cta && _lv(cta.text)) {
        const a = document.createElement('a'); a.href = cta.href || '#'; a.className = 'btn btn-accent btn-lg'; a.textContent = _lv(cta.text);
        inner.appendChild(a);
      }
      sec.appendChild(inner);
      return sec;
    },
    gallery(b) {
      const grid = _el('div', 'display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px');
      (Array.isArray(b.props?.images) ? b.props.images : []).forEach((im) => {
        const img = document.createElement('img');
        img.src = im.src || ''; img.alt = _lv(im.alt) || '';
        img.style.cssText = 'width:100%;height:160px;object-fit:cover;border-radius:var(--radius-md,10px)';
        grid.appendChild(img);
      });
      return grid;
    },
    'stat-grid'(b) {
      const grid = _el('div', 'display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:16px;text-align:center');
      (Array.isArray(b.props?.stats) ? b.props.stats : []).forEach((st) => {
        const card = _el('div', 'padding:20px;background:var(--bg-surface,#161622);border-radius:var(--radius-md,10px)');
        let value = st.value;
        if (st.source === 'datasetCount') { try { value = (typeof Catalog !== 'undefined' && Catalog.list) ? Catalog.list().length : (value || 0); } catch (_) { value = value || 0; } }
        card.appendChild(_el('div', 'font-size:var(--text-3xl,2.5rem);font-weight:700;color:var(--color-primary,#00A654)', String(value ?? 0)));
        card.appendChild(_el('div', 'opacity:.7;margin-top:4px', _lv(st.label)));
        grid.appendChild(card);
      });
      return grid;
    },
    'latest-datasets'(b) {
      const wrap = _el('div', 'display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:16px');
      let list = [];
      try { if (typeof Catalog !== 'undefined' && Catalog.list) list = Catalog.list().slice(0, Math.max(1, Math.min(12, +(b.props?.count) || 4))); } catch (_) {}
      list.forEach((ds) => {
        const a = document.createElement('a');
        a.href = `viewer.html?id=${encodeURIComponent(ds.id)}`;
        a.className = 'card';
        a.style.cssText = 'display:block;padding:14px;background:var(--bg-surface,#161622);border-radius:var(--radius-md,10px);text-decoration:none;color:inherit';
        a.appendChild(_el('div', 'font-weight:600', ds.name || ds.id));
        if (ds.type) a.appendChild(_el('div', 'opacity:.6;font-size:var(--text-sm,.8rem);margin-top:4px', ds.type));
        wrap.appendChild(a);
      });
      if (!list.length) wrap.appendChild(_el('p', 'opacity:.5', ''));
      return wrap;
    },
    html(b) {
      const div = document.createElement('div');
      div.innerHTML = _sanitizeHtml(_lv(b.props?.html));
      return div;
    },
  };

  function _sanitizeCss(v) { return String(v).replace(/[{}<>;@]/g, '').slice(0, 120); }

  function renderBlock(b) {
    const fn = RENDERERS[b && b.type];
    if (!fn) return null;
    try {
      const node = fn(b);
      if (!node) return null;
      const block = _el('div', 'margin:0 0 8px');
      block.appendChild(node);
      return block;
    } catch (_) { return null; }
  }

  /**
   * Render blocks into `container`. Returns the number of blocks rendered.
   * opts.wrap: if true, wrap each block row in a .container for max-width.
   */
  function render(container, blocks, opts) {
    if (!container) return 0;
    container.textContent = '';
    const list = Array.isArray(blocks) ? blocks : [];
    let n = 0;
    list.forEach((b) => {
      const node = renderBlock(b);
      if (!node) return;
      n++;
      if (opts && opts.wrap) {
        const row = _el('div', 'padding:8px 0');
        const inner = _el('div', 'max-width:1080px;margin:0 auto;padding:0 24px');
        inner.appendChild(node);
        row.appendChild(inner);
        container.appendChild(row);
      } else {
        container.appendChild(node);
      }
    });
    return n;
  }

  // Fetch a page doc's PUBLISHED blocks (or draft when preview + allowed).
  async function fetchBlocks(slug, useDraft) {
    try {
      const resp = await fetch(`./config/pages/${encodeURIComponent(slug)}.json`, { cache: 'no-store' });
      if (!resp.ok) return [];
      const doc = await resp.json();
      const src = (useDraft && doc && doc.draft) ? doc.draft : (doc && doc.published);
      return (src && Array.isArray(src.blocks)) ? src.blocks : [];
    } catch (_) { return []; }
  }

  return { render, renderBlock, fetchBlocks, BLOCK_TYPES: Object.keys(RENDERERS) };
})();
