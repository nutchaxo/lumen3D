/* Applies the saved theme before first paint. Loaded as a tiny blocking classic
   script in <head> (after the stylesheets): the pages ship data-theme="dark" and
   theme.js only runs at the end of <body>, so a returning light-theme visitor would
   otherwise see a dark flash. Storage may be blocked (private windows, policy): then
   the page keeps its default and theme.js decides. Never bundled (see build_release.py). */
(function () {
  // The admin panel keeps its own preference (data-theme-key="adm-theme").
  const script = document.currentScript;
  const key = (script && script.getAttribute('data-theme-key')) || 'iribhm-theme';
  try {
    if (localStorage.getItem(key) === 'light') {
      document.documentElement.setAttribute('data-theme', 'light');
    }
  } catch (_) { /* blocked storage: keep the default */ }
  // A Compare panel opens with its sidebar folded (the host's settings button opens it).
  // Said before the first paint, so the sidebar never shows open and slides shut while the
  // page loads; viewer.js drops the class once the sidebar carries its own.
  try {
    const q = new URLSearchParams(window.location.search);
    if (q.get('hideHeader') === 'true' && q.get('panelIndex') !== null && q.get('mode') !== 'admin') {
      document.documentElement.classList.add('panel-boot');
    }
  } catch (_) { /* no location: not a panel */ }
})();
