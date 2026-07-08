# Plateforme Web — v1.0.33

## [FIXED]
- **ELE-26 (BUG-005)** — `js/viewers/volume-viewer.js` : `_seedTexturesFromActiveAsync` ne rappelait pas `onDone()` sur sa branche d'**abort** (switch dataset/timepoint pendant le seed). Or `loadBrickedVolumeStream` fait `await new Promise(resolve => _seedTexturesFromActiveAsync(..., resolve))` → la Promise restait **suspendue à vie**, bloquant le chemin de streaming primaire. `onDone()` est désormais appelé sur **toutes** les branches de sortie, y compris l'abort.
- Test : `tests/js/test_volume_viewer_seed_promise.mjs` (structurel : la branche d'abort résout la Promise ; `onDone()` sur chaque sortie) + `node --check`.
