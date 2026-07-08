/* ============================================================
   Lumen3D — Custom page view (white-label page builder)
   ============================================================
   Hosts an operator-created block page: reads ?slug=<page> from the
   URL, loads config/pages/<slug>.json, and renders its blocks via
   PageRenderer. ?preview=draft renders the unpublished draft (used by
   the admin "Pages" tab live preview iframe). Re-renders on language
   change so localized block text follows the switcher.
   ============================================================ */

(function () {
  'use strict';

  let _slug = '';
  let _preview = false;
  let _doc = null;

  function _loc() { try { return (typeof I18n !== 'undefined' && I18n.getLanguage) ? I18n.getLanguage() : 'en'; } catch (_) { return 'en'; } }
  function _lv(v) {
    if (v == null) return '';
    if (typeof v === 'string') return v;
    if (typeof v === 'object') { const l = _loc(); return v[l] || v.en || Object.values(v)[0] || ''; }
    return String(v);
  }

  function _blocks() {
    const src = (_preview && _doc && _doc.draft) ? _doc.draft : (_doc && _doc.published);
    return (src && Array.isArray(src.blocks)) ? src.blocks : [];
  }

  function renderPage() {
    const host = document.getElementById('page-blocks');
    const empty = document.getElementById('page-empty');
    const blocks = _blocks();
    const n = (typeof PageRenderer !== 'undefined') ? PageRenderer.render(host, blocks, { wrap: true }) : 0;
    if (empty) empty.style.display = n ? 'none' : '';
    // Title from the page doc (localized), falling back to the brand name.
    const title = _lv(_doc && _doc.title);
    if (title) document.title = title + ' — ' + (typeof InstanceConfig !== 'undefined' ? InstanceConfig.get('brand.name', 'Lumen3D') : 'Lumen3D');
  }

  async function init() {
    const params = new URLSearchParams(window.location.search);
    _slug = (params.get('slug') || '').trim();
    _preview = params.get('preview') === 'draft';
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(_slug)) { window.location.replace('index.html'); return; }

    if (typeof InstanceConfig !== 'undefined') { try { await InstanceConfig.load(); } catch (_) {} }
    if (typeof Theme !== 'undefined') Theme.init();
    if (typeof I18n !== 'undefined') { try { await I18n.init(); } catch (_) {} }
    if (typeof InstanceConfig !== 'undefined') { try { InstanceConfig.applyHead(); InstanceConfig.applyDom(); } catch (_) {} }
    if (typeof Catalog !== 'undefined' && Catalog.load) { try { await Catalog.load(); } catch (_) {} }

    try {
      const resp = await fetch(`./config/pages/${encodeURIComponent(_slug)}.json`, { cache: 'no-store' });
      if (resp.ok) _doc = await resp.json();
    } catch (_) { /* missing page → empty state */ }

    renderPage();

    if (typeof I18n !== 'undefined' && I18n.onLanguageChange) I18n.onLanguageChange(() => renderPage());
    if (typeof Utils !== 'undefined' && Utils.populateLanguageMenu) { try { Utils.populateLanguageMenu((l) => I18n.setLanguage(l)); } catch (_) {} }
    if (window.lucide) lucide.createIcons();

    // Live-preview bridge: the admin Pages tab posts updated draft blocks so the
    // iframe reflects unsaved edits without a round-trip to disk.
    window.addEventListener('message', (e) => {
      if (e.source !== window.parent) return;
      const m = e.data;
      if (m && m.type === 'LUMEN_PREVIEW_BLOCKS' && Array.isArray(m.blocks)) {
        _doc = _doc || {};
        _doc.draft = { blocks: m.blocks };
        _preview = true;
        renderPage();
      }
    });
  }

  document.addEventListener('DOMContentLoaded', init);
})();
