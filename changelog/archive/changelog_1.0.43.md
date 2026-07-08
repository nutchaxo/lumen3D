# Plateforme Web — v1.0.43

> Lot « robustesse du slicer & code mort » — `js/viewers/volume-slicer.js` + `js/core/aabb-intersector.js`. Gardes défensives locales (Rule 1.4) sur la spécification de plan de coupe + nettoyage d'un uniform mort et d'un commentaire d'en-tête périmé.

## [FIXED]
- **EDGE-009** (Rule 1.4) — `volume-slicer.js` + `aabb-intersector.js` : un `yaw/pitch/roll` valant `Infinity` (ou une chaîne tronquée non numérique) traversait `yaw || 0` (NaN est falsy → 0, mais `Infinity || 0 = Infinity`) et alimentait l'`Euler → quaternion` / `Math.sin` → normal/right/up **dégénérés** (NaN/Inf), `hypot(NaN,…) || 1` normalisant par 1 propageait le NaN dans l'équation de plan. `setPlaneSpec` assainit désormais les angles (`Number.isFinite` → 0 sinon) ; `planeFromSpec` (oblique) borne les angles et retombe sur le plan xy si la normale est dégénérée.
- **EDGE-034** — `volume-slicer.js` : `setPlaneSpec` faisait un `Object.assign` sans bornage → `value=2.5` décalait le plan **hors du cube [0,1]**, et `value || 0.5` réécrivait un `0` légitime en `0.5`. `value` est désormais clampé à `[0,1]`, `slabThickness` à `[1,64]`, et `_computePlaneVectors` lit `spec.value` directement.
- **EDGE-035** — `volume-slicer.js` `_syncUniforms` : la garde `getPhysicalSize() || {1,1,1}` n'attrapait qu'un retour nul, pas un objet avec une dimension à 0 (metadata `scaleInfo` malformée) → `maxP/0 = ∞` (ou `0/0 = NaN`) en uniforms. Toute dimension physique non positive est remplacée par 1 avant division.

## [OPTIMIZED]
- **DEAD-017** — `volume-slicer.js` : suppression de l'uniform `volumeScale` (déclaré dans le fragment shader + câblé en JS, jamais référencé dans le corps GLSL — slot d'uniform gaspillé).
- **DEAD-031** — `volume-slicer.js` : l'en-tête prétendait partager une « DataTexture3D » avec le renderer principal ; le rendu passe en réalité par les pages d'atlas SVR (`svrAtlas0..7` + `pageTable`, repli sur `svrAtlas0` en texture 3D simple quand `ENABLE_SVR` est off). Commentaire corrigé.

## [TESTS]
- `tests/js/test_slicer_robustness.mjs` (nouveau) — `aabb-intersector` chargé en `vm` : `planeFromSpec` reste fini pour `yaw=Infinity/NaN`/non-numérique et `value` hors borne, et résout toujours une normale unitaire pour un oblique valide (non-régression) ; assertions structurelles du clamp `value`/angles dans `setPlaneSpec` (EDGE-009/034), de la garde de dimension physique (EDGE-035), de la suppression totale de `volumeScale` (DEAD-017) et de l'en-tête corrigé (DEAD-031). `node --check` sur les deux fichiers.
