# Plateforme Web — v1.0.12

## [FIXED]
- **ELE-01 (SEC-003)** — `js/pages/viewer.js` : les trois listeners `postMessage` (sync intra-panneau ; `APPLY_WORKSPACE_STATE` ; `TOGGLE_ZSTACK`) traitaient `e.data` **sans vérifier `e.origin`**, acceptant des messages de n'importe quelle fenêtre (pilotage/injection d'état cross-origin). Ajout d'un garde d'origine same-origin via le nouveau helper `Utils.isTrustedMessageOrigin(e)` (`js/core/utils.js`), appliqué aux trois listeners.
- Test : `tests/js/test_utils_origin.mjs`.
