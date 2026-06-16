# Plateforme Web — v1.0.13

## [FIXED]
- **ELE-03 (SEC-005)** — `js/pages/compare.js` : `_handleIframeMessage` traitait `event.data` **sans vérifier `event.origin`**, acceptant les messages de n'importe quelle fenêtre. Ajout du garde `Utils.isTrustedMessageOrigin(event)` en tête du handler (réutilise le helper introduit en v1.0.12).
- Test : `tests/js/test_compare_origin.mjs` (garde vérifié avant lecture de `event.data` via getter-spy).
