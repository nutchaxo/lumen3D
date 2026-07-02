# Plateforme Web — v1.0.23

## [FIXED]
- **ELE-15 (RACE-006)** — `js/pages/admpan.js` : `selectDataset` n'avait aucune garde de version. Une réponse `get()` tardive (réseau réordonné) pouvait écraser `_draft`/`_original`/`_current` avec le **mauvais dataset** si l'on changeait de sélection rapidement. Ajout d'un jeton monotone `_selectGen` : capturé en début de sélection (après le bloc dirty/confirm — un `confirm` annulé ne consomme pas de jeton), vérifié après l'`await apiFetch` (avant tout usage de la réponse et avant tout toast) → une réponse périmée est ignorée.
- Test : `tests/js/test_admpan_selectdataset_guard.mjs` (structurel — `admpan.js` est un module ES non chargeable en headless) + `node --check`.
