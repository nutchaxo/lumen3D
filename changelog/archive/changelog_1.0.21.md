# Plateforme Web — v1.0.21

## [FIXED]
- **ELE-11 (RACE-002)** — `js/pages/viewer.js` : `_loadTimepoint` appliquait des effets de bord (`_brickManifest`, `_qualityMode`, sélecteur de qualité, labels) après chaque `await _loadVolumeForQuality` **sans re-vérifier le token de chargement** ; le seul contrôle de péremption arrivait trop tard. Ajout d'un helper `_isStale()`/`_bailStale()` et d'une garde après **chaque** reprise post-await (bail si périmé), l'affectation du manifest n'étant faite que si `!_isStale()`. Un switch de qualité/timepoint pendant le chargement n'altère plus l'état (UI + manifest) du chargement courant. No-op en nominal.
- Test : `tests/js/test_viewer_loadtimepoint_guard.mjs` (structurel — fichier non chargeable en headless) + `node --check`.
