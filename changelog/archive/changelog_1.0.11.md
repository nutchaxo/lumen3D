# Plateforme Web — v1.0.11

## [FIXED]
- **ELE-02 (SEC-004)** — `js/core/export-manager.js` : `_itemHtml` interpolait `item.path` **brut** dans l'attribut `href`, permettant une évasion d'attribut / injection HTML dans le Download Center (les autres champs étaient déjà échappés). Échappement via `Utils.escapeHtml(item.path)`.
- Mise en place du **harnais de test JS** (`tests/js/harness.mjs`, Node `vm`) pour charger et tester les modules IIFE navigateur sans navigateur ; `_itemHtml` exposé pour le test unitaire.
- Test : `tests/js/test_export_manager.mjs`.
