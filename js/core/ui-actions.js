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
    // landing.js / explorer.js define their own toggleDropdown; every other page (compare)
    // relies on the shared Utils one.
    'lang-dropdown': () => {
      if (typeof toggleDropdown === 'function') toggleDropdown('lang-dropdown');
      else if (typeof Utils !== 'undefined' && Utils.toggleDropdown) Utils.toggleDropdown('lang-dropdown');
    },
    'add-dataset':  () => { const b = document.getElementById('btn-add-dataset'); if (b) b.click(); },
    'nav-menu':     (el) => {
      const nav = el && el.closest ? el.closest('.navbar') : null;
      if (nav && nav.classList) setNavMenuOpen(nav, !nav.classList.contains('nav-open'));
    },
  };

  // Public navbar below the phone breakpoint (css/layout.css): the links fold into a
  // panel under the bar, opened by the `.navbar-menu-btn`. Only one class and one ARIA
  // state carry it, so a link added later (InstanceConfig.applyNav's custom pages)
  // is inside the panel without any wiring.
  function setNavMenuOpen(nav, open, returnFocus) {
    nav.classList.toggle('nav-open', !!open);
    const btn = nav.querySelector ? nav.querySelector('[data-action="nav-menu"]') : null;
    if (btn) btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (!open && returnFocus && btn && btn.focus) btn.focus();
  }

  function openNavMenus() {
    if (!document.querySelectorAll) return [];
    return Array.prototype.slice.call(document.querySelectorAll('.navbar.nav-open'));
  }

  // Event DELEGATION on document — one listener, immune to buttons being added or
  // re-rendered after load (page controllers rebuild the header/navbar), and it can
  // never double-bind. Replaces the inline onclick= handlers (CSP-safe).
  document.addEventListener('click', (e) => {
    const target = e.target;
    // An open navbar menu closes on a click outside it, and on a link inside it (the
    // link still navigates; an in-page anchor would otherwise leave the panel over it).
    openNavMenus().forEach((nav) => {
      const inside = !!(target && nav.contains && nav.contains(target));
      const onLink = inside && target.closest && target.closest('.navbar-links a');
      if (!inside || onLink) setNavMenuOpen(nav, false);
    });
    const el = target && target.closest ? target.closest('[data-action]') : null;
    if (!el) return;
    const name = el.getAttribute('data-action');
    if (!Object.prototype.hasOwnProperty.call(ACTIONS, name)) return;
    ACTIONS[name](el);
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    openNavMenus().forEach((nav) => setNavMenuOpen(nav, false, true));
  });

  // Back above the breakpoint the links are a row again: drop the open state so the
  // button's aria-expanded never describes a panel that is no longer there.
  if (typeof window.matchMedia === 'function') {
    const phone = window.matchMedia('(max-width: 900px)');
    const onBreakpoint = (q) => { if (!q.matches) openNavMenus().forEach((nav) => setNavMenuOpen(nav, false)); };
    if (phone.addEventListener) phone.addEventListener('change', onBreakpoint);
    else if (phone.addListener) phone.addListener(onBreakpoint);
  }

  // Ensure Lucide icons render once the (async) CDN script has loaded, without an
  // inline `onload=` handler (previously on the lucide <script> tag in some pages).
  function renderIcons() { if (window.lucide && lucide.createIcons) lucide.createIcons(); }
  window.addEventListener('load', renderIcons);

  // Usage telemetry: one site visit per browser tab, whichever public page the
  // visitor lands on first (sessionStorage is per tab). Not counted: the admin
  // panel, the 404 page (a mistyped URL or a crawler probe is not a visit), and any
  // page embedded in another (a Compare panel, the admin preview,
  // the page editor's frame) — its host page already counted the visit.
  function countVisit() {
    try {
      if (window.top !== window.self) return;
      const page = document.body && document.body.getAttribute('data-page');
      if (page === 'admin' || page === 'notfound') return;
      if (sessionStorage.getItem('lumen_visit')) return;
      sessionStorage.setItem('lumen_visit', '1');
      if (navigator.sendBeacon) navigator.sendBeacon('api/telemetry.php?action=visit');
    } catch (_) { /* private mode, a cross-origin top, no beacon: not counted */ }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', countVisit);
  else countVisit();

  window.UIActions = { renderIcons };
})();
