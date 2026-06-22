# Plateforme Web — v1.0.48

> Lot « gardes & code mort du renderer 3D » — `js/viewers/volume-viewer.js` (cœur du viewer). Spécifications d'édition produites par un workflow parallèle (4 agents), appliquées verbatim et vérifiées (`node --check` + structurel). 14 findings.

## [FIXED]
- **BUG-006** — `_draggedLabelSprite` était une **variable globale implicite** (affectée sans `let`). Déclarée au scope module à côté de `_activeDragSprite`.
- **BUG-007** — `_renderMeasurements` levait une exception si `item.distance` était absent/non fini (mesure dégénérée ou partiellement restaurée). Affiche un em-dash au lieu de crasher (Rule 1.4) ; les distances finies gardent le format exact.
- **EDGE-026** — la couleur d'un canal était parsée (`parseInt` sur hex) sans validation → uniform `NaN` sur entrée malformée. Validée contre `/^#[0-9a-fA-F]{6}$/` ; entrée invalide ignorée + avertie.
- **EDGE-027** (Rule 1.4) — `loadVolume` allouait le buffer monolithique sans vérifier les dimensions → `Uint8Array` de taille `NaN`/0 (corruption silencieuse) ou sur-allocation multi-Go. Garde de finitude/positivité ajoutée **avant** toute allocation (surface un statut, ferme le span perf, throw).
- **BUG-027** — `setView`/`resetView` réinitialisaient la rotation à l'identité même sous `_rotationLocked` (+ `setView` manquait une garde de nullité de `cube`). Reorientation désormais ignorée quand verrouillé ; reset position/clipping préservé.
- **BUG-029** — `setCameraState` appliquait `quaternion`/`position` sans validation. Vérifie tableaux longueur 4 tous finis, `lengthSq > 1e-8`, et **normalise** avant copie → un quaternion stocké dégénéré ne corrompt plus la transform.
- **BUG-038** — le `roll` n'était appliqué qu'en mode oblique ; ignoré en xy/xz/yz. Post-multiplication par un quaternion de roll autour de la normale (`+Z` local) dans les branches orthogonales.
- **BUG-011** (Rule 1.1) — l'appel `loadBrickTasks` ne câblait pas `onBrickError` → une brick droppée disparaissait silencieusement. Compteur `failedBricks` par chargement + statut « qualité dégradée » via `_emitQualityState` quand des bricks échouent (le rendu dégrade toujours gracieusement, mais l'utilisateur est informé). Complète le travail loader du lot streaming (v1.0.42).

## [OPTIMIZED]
- **PERF-004** — un `new THREE.Raycaster()` était alloué à chaque pointermove/pointerdown (4 sites). Réutilisation de l'instance module unique `_raycaster` (+ `_pointer`) — usage synchrone, jamais retenu. Une seule allocation subsiste (au constructeur).
- **PERF-020** — le hover lançait un raycast axes/grille à chaque mouvement même hors mode utile. Gardé sur `VolumeGrid.isAxesVisible() || getGridMode() > 0`.
- **DEAD-027** — branche morte `dims.gridSize?.x` dans `_orderBricksForStreaming` (`getDimensions()` ne renvoie jamais `gridSize`). Préfixes retirés.
- **DEAD-029** — suppression du `_seedTexturesFromActive` **synchrone** mort (la variante async est la voie vivante) et de `_intersectGizmo` (gizmo de rotation supprimé) — zéro appelant vérifié sur tout le dépôt. La copie `_updateGridsAndAxes` de `tracking-viewer.js` est intacte.
- **DEAD-030** — double appel identique `_raycaster.setFromCamera(...)` dans `pickVolumePoint` ; doublon retiré.
- **LEAK-023** (Rule 1.2) — les `requestAnimationFrame` de la boucle de seed LOD n'étaient pas trackés/annulables. `_seedRafId` stocké et `cancelAnimationFrame` sur les chemins d'abort (`loadVolume`, `loadBrickedVolumeStream`) → plus de frame de seed orpheline après un switch.

## [TESTS]
- `tests/js/test_volume_viewer_guards.mjs` (nouveau) — assertions structurelles des 14 correctifs (déclaration unique `_draggedLabelSprite`, garde distance, hex couleur, garde dims, Raycaster unique, gate hover, lock rotation, quaternion validé/normalisé, roll ortho, branches mortes retirées, async seed conservé, rAF annulable, `onBrickError` câblé) + `node --check`.
