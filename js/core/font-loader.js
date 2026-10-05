/* ============================================================
   Lumen3D — non-blocking web-font stylesheet
   ============================================================
   The pages declare the Google Fonts stylesheet as a print stylesheet
   (`media="print" data-async-font`), which the browser fetches without
   holding the first paint back; this script then enables it. On a network
   that filters the font host the page therefore renders at once with the
   system fonts (font-display: swap) instead of waiting for the request to
   time out. A <noscript> twin in each page covers a browser without scripts.
   An inline `onload` would do the same job but the enforced CSP forbids it.
   ============================================================ */

(() => {
  document.querySelectorAll('link[data-async-font]').forEach((link) => { link.media = 'all'; });
})();
