# Plateforme Web — v1.0.27

## [FIXED]
- **ELE-21 (EDGE-004)** — `js/core/brick-loader.js` : `init()` montait n'importe quel manifest sans validation (viole Rule 1.4). Ajout de `_validateManifest()` (`levels` non vide ; chaque level a `level >= 0`, `dimensions.x/y/z` positives, `brickSize` entier positif ; `channels >= 1` ; `brickTransport.encoding` ∈ encodages connus) appelé en **tête d'`init()`, AVANT toute mutation d'état** — cohérent avec les invariants RACE (un manifest rejeté ne corrompt pas le dataset déjà monté). N'inspecte PAS l'occupation (`nonEmpty`/`occupiedRatio`) → l'Empty-Space-Skipping (ELE-20) est préservé.
  - Companion (`js/viewers/volume-viewer.js`) : `loadBrickedVolumeStream` enveloppe `BrickLoader.init` → un manifest rejeté **dégrade** en `{ available: false, reason }` (Rule 1.1) au lieu d'un throw opaque.
  - Le test de concurrence (ELE-12/13/17) est mis à jour pour utiliser un manifest minimal valide (son `{levels:[]}` est désormais rejeté).
- Test : `tests/js/test_brick_loader_manifest_validate.mjs` (valide monte, 9 malformés rejetés, rejet sans mutation d'un dataset déjà monté) + non-régression `test_brick_loader_concurrency.mjs` + `node --check`.
