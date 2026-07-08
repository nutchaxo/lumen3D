/* ============================================================
   IRIBHM Microscopy Platform — UI actions (CSP-safe binding)
   ============================================================
   Wires the standard header controls via `data-action` attributes
   instead of inline `onclick=` handlers, so a strict Content-
   Security-Policy (no 'unsafe-inline') can be enforced. Loaded on
   every page; binds on DOMContentLoaded and is idempotent.

   Markup:  <button data-action="theme-toggle"> … </button>
   ============================================================ */

(function () {
  'use strict';

  // NB: use BARE names (Theme/ColorBlind/toggleDropdown), not window.X — in classic
  // scripts a top-level `const Theme = …` is a global LEXICAL binding, reachable by
  // name across scripts but NOT exposed as window.Theme. `typeof X` is ReferenceError-
  // safe and resolves that lexical binding.
  const ACTIONS = {
    'theme-toggle': () => { if (typeof Theme !== 'undefined' && Theme.toggle) Theme.toggle(); },
    'colorblind':   () => { if (typeof ColorBlind !== 'undefined' && ColorBlind.openModal) ColorBlind.openModal(); },
    'lang-dropdown': () => { if (typeof toggleDropdown !== 'undefined') toggleDropdown('lang-dropdown'); },
    'add-dataset':  () => { const b = document.getElementById('btn-add-dataset'); if (b) b.click(); },
  };

  // Event DELEGATION on document — one listener, immune to buttons being added or
  // re-rendered after load (page controllers rebuild the header/navbar), and it can
  // never double-bind. Replaces the inline onclick= handlers (CSP-safe).
  document.addEventListener('click', (e) => {
    const el = e.target && e.target.closest ? e.target.closest('[data-action]') : null;
    if (!el) return;
    const fn = ACTIONS[el.getAttribute('data-action')];
    if (fn) fn();
  });

  // Ensure Lucide icons render once the (async) CDN script has loaded, without an
  // inline `onload=` handler (previously on the lucide <script> tag in some pages).
  function renderIcons() { if (window.lucide && lucide.createIcons) lucide.createIcons(); }
  window.addEventListener('load', renderIcons);

  window.UIActions = { renderIcons };
})();
