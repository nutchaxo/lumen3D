# Plateforme Web — v1.0.20

## [FIXED]
- **ELE-10 (RACE-001)** — `js/viewers/volume-viewer.js` : `loadVolume` (chemin slices) publiait l'entry (`_activateVolumeEntry` : rebind des uniforms du material + recadrage caméra) puis poussait des uploads GPU **avant** la garde de péremption finale (trop tardive). Ajout de deux gardes `loadId !== _loadCounter` : (1) avant la publication de l'entry, (2) dans le `finally` par-slice (gate des uploads/progress). Un chargement périmé (switch dataset/timepoint/qualité) ne s'applique plus au mauvais dataset. Gardes no-op en nominal.
- Test : `tests/js/test_volume_viewer_loadguard.mjs` (structurel — fichier non chargeable en headless) + `node --check`.
