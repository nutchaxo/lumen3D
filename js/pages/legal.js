/* ============================================================
   Lumen3D — Legal page renderer (white-label)
   ============================================================
   Renders config/legal.json (operator-edited via the admin Legal tab)
   into a fixed layout. Text-only: titles → <h2> textContent, bodies →
   paragraphs split on blank lines, textContent (no HTML injection).
   Per-locale with English fallback; re-renders on language change.
   ============================================================ */

(function () {
  'use strict';

  let _legal = { sections: [] };

  function _lv(obj) {
    const loc = (typeof I18n !== 'undefined' && I18n.getLanguage) ? I18n.getLanguage() : 'en';
    if (obj && typeof obj === 'object') return obj[loc] || obj.en || Object.values(obj)[0] || '';
    return typeof obj === 'string' ? obj : '';
  }

  function renderSections() {
    const host = document.getElementById('legal-content');
    const empty = document.getElementById('legal-empty');
    if (!host) return;
    host.textContent = '';
    const sections = Array.isArray(_legal.sections) ? _legal.sections : [];
    let rendered = 0;
    sections.forEach((s) => {
      const title = _lv(s.title).trim();
      const body = _lv(s.body).trim();
      if (!title && !body) return;
      rendered++;
      const sec = document.createElement('section');
      sec.style.margin = '28px 0';
      if (title) {
        const h = document.createElement('h2');
        h.textContent = title;
        h.style.marginBottom = '10px';
        sec.appendChild(h);
      }
      // Split on blank lines into paragraphs; textContent keeps it injection-safe.
      body.split(/\n{2,}/).forEach((para) => {
        const p = document.createElement('p');
        p.style.whiteSpace = 'pre-wrap';
        p.style.lineHeight = '1.7';
        p.style.margin = '0 0 12px';
        p.textContent = para;
        sec.appendChild(p);
      });
      host.appendChild(sec);
    });
    if (empty) empty.style.display = rendered ? 'none' : '';
  }

  async function init() {
    if (typeof InstanceConfig !== 'undefined') { try { await InstanceConfig.load(); } catch (_) {} }
    if (typeof Theme !== 'undefined') Theme.init();
    if (typeof I18n !== 'undefined') { try { await I18n.init(); } catch (_) {} }
    if (typeof InstanceConfig !== 'undefined') { try { InstanceConfig.applyHead(); InstanceConfig.applyDom(); } catch (_) {} }

    try {
      let d = null;
      const resp = await fetch('./config/legal.json', { cache: 'no-store' });
      if (resp.ok) d = await resp.json();
      // Fresh install (no operator legal published yet) → show the shipped neutral
      // default templates so the page is useful instead of blank.
      if (!d || !Array.isArray(d.sections) || !d.sections.length) {
        try {
          const r2 = await fetch('./config/defaults/neutral/legal.json', { cache: 'no-store' });
          if (r2.ok) { const dd = await r2.json(); if (dd && Array.isArray(dd.sections) && dd.sections.length) d = dd; }
        } catch (_) {}
      }
      if (d && typeof d === 'object') _legal = d;
    } catch (_) { /* no legal content yet */ }
    renderSections();

    if (typeof I18n !== 'undefined' && I18n.onLanguageChange) {
      I18n.onLanguageChange(() => renderSections());
    }
    if (typeof Utils !== 'undefined' && Utils.populateLanguageMenu) {
      try { Utils.populateLanguageMenu((lang) => I18n.setLanguage(lang)); } catch (_) {}
    }
    if (window.lucide) lucide.createIcons();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
