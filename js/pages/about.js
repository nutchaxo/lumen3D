/* ============================================================
   Lumen3D — About page
   ============================================================
   Since v1.25.0 this page has no static content of its own: it renders
   a page-builder document, exactly like page.html does for custom pages.

     • the operator's published config/pages/about.json when there is one
       (?preview=draft renders the draft instead, and the admin preview
       iframe pushes live docs over postMessage);
     • otherwise the built-in default from js/core/page-templates.js — the
       same document the admin Pages editor seeds, so "what you edit" and
       "what visitors see" cannot drift.

   Widget text is localized ({en, fr, …}) and resolved at render time, so a
   language switch re-renders rather than reloads.
   ============================================================ */

const AboutApp = (() => {
  let _source = null;      // the doc currently on screen (re-rendered on language change)

  async function init() {
    Theme.init();
    await InstanceConfig.load();
    await I18n.init();
    InstanceConfig.applyHead();
    InstanceConfig.applyDom();
    // Counters and dataset widgets read Catalog.getStats() at render time —
    // load before the first render so they never animate up from a stale zero.
    await Catalog.load();
    _updateThemeIcon();
    Theme.onChange(_updateThemeIcon);
    if (window.lucide) lucide.createIcons();
    await _renderPage();
    document.body.classList.add('loaded');
  }

  function _render(source) {
    const host = document.getElementById('about-blocks');
    if (!host || typeof PageRenderer === 'undefined') return;
    _source = source;
    PageRenderer.renderSource(host, source, { wrap: true });
    try { if (typeof PageBackground !== 'undefined') PageBackground.apply(source && source.background); } catch (_) {}
  }

  function _defaultSource() {
    if (typeof PageTemplates === 'undefined') return { sections: [] };
    return { sections: PageTemplates.build('about') };
  }

  async function _renderPage() {
    if (typeof PageRenderer === 'undefined') return;
    const preview = new URLSearchParams(location.search).get('preview') === 'draft';
    window.addEventListener('message', (e) => {
      if (e.source !== window.parent) return;
      const m = e.data;
      if (m && m.type === 'LUMEN_PREVIEW_DOC' && m.source) _render(m.source);
      else if (m && m.type === 'LUMEN_PREVIEW_BLOCKS' && Array.isArray(m.blocks)) _render({ blocks: m.blocks });
    });
    let published = { sections: [] };
    try { published = await PageRenderer.fetchSource('about', preview); } catch (_) {}
    const has = (published.sections && published.sections.length) || (published.blocks && published.blocks.length);
    _render(has ? published : _defaultSource());
    if (typeof I18n !== 'undefined' && I18n.onLanguageChange) {
      I18n.onLanguageChange(() => { if (_source) _render(_source); });
    }
  }

  function _updateThemeIcon() {
    const btn = document.getElementById('theme-toggle');
    if (!btn) return;
    const icon = Theme.isDark() ? 'moon' : 'sun';
    btn.innerHTML = `<i data-lucide="${icon}" data-theme-icon></i>`;
    if (window.lucide) lucide.createIcons({ nodes: [btn] });
  }

  return { init };
})();

document.addEventListener('DOMContentLoaded', AboutApp.init);
