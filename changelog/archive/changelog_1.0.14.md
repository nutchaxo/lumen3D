# Plateforme Web — v1.0.14

## [FIXED]
- **ELE-04 (SEC-006)** — Contrôle d'origine sur les listeners `postMessage` du panneau admin :
  - `js/pages/admpan.js` : garde same-origin **inline** (`e.origin !== window.location.origin`) en tête du listener `message` (admpan.js est un module ES sans `Utils` global).
  - `js/modules/tools/orientation-axes/index.js` : garde `Utils.isTrustedMessageOrigin(e)` dans `_onMessage`, et réponse `ORIENTATION_RESULT` ciblée sur `e.origin` au lieu du wildcard `'*'` (fuite cross-origin).
- Test : `tests/js/test_orientation_axes_origin.mjs` (garde + cible de réponse). `node --check` OK sur les deux fichiers.
