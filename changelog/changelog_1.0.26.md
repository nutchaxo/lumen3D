# Plateforme Web — v1.0.26

## [FIXED]
- **ELE-19 (EDGE-002)** — `js/pages/viewer.js` : un `metadata.json` malformé était **silencieusement fusionné** (catch « swallow ») au lieu d'être rejeté (viole Rule 1.4). Ajout de `_validateDatasetMetadata()` (dimensions `x/y/z` entiers positifs ; `c`/`t` cohérents ; `voxel_size` positifs ; `channels` tableau d'objets ↔ `dimensions.c` ; un dataset **live** exige `t`, validé sur la dimension **effective** metadata-ou-catalogue). `_mergeDatasetMetadata` lève désormais sur metadata incohérent (et ne swallow plus) ; l'appelant (`init`) intercepte, surface l'erreur via `_showLoadingError` et redirige vers l'explorer hors-iframe. Un `metadata.json` **absent (404)** reste toléré (fallback catalogue).
- Test : `tests/js/test_viewer_metadata_validate.mjs` (structurel) + `node --check`.
