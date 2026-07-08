# Plateforme Web — v1.0.55

> Lot « robustesse cœur divers ».

## [FIXED]
- **EDGE-031** (Rule 1.4) — `js/core/volume-source-manager.js` `normalizeSources` normalisait n'importe quelle entrée (kind inconnu, `path` non-string) en une source plausible-mais-cassée. Désormais : filtrage (drop + `console.warn`) des entrées dont le `kind` n'est pas dans `{webstack, bricks, deepzoom2d, live}` ou dont le `path` présent n'est pas une string ; repli sur la source `webstack` par défaut si plus aucune entrée valide (jamais de liste vide).
- **BUG-031** — `js/modules/tools/measure-distance/index.js` : double source de vérité — un `push` manuel dans le miroir local après `MeasurementStore.add`. Le miroir est désormais **re-lu** depuis le store (`measurements.list('viewer')`) après `add`, garantissant qu'il reflète exactement le store (qui normalise/id l'entrée).

## [OPTIMIZED]
- **BUG-069** — `js/modules/tools/orientation-axes/index.js` : `_update` (par frame) contenait un `forEach` mort à corps vide (les `THREE.Sprite` font déjà face à la caméra ; la branche hover de la sphère n'a jamais été implémentée) + un `invCam` inutilisé. Bloc supprimé (coût d'itération/GC par frame éliminé).
- **PERF-012** — `js/modules/channels/histogram/index.js` : le glissement des poignées min/max/midtone appelait `onStateChange` (mise à jour d'uniform, possible recompilation) à **chaque** `pointermove`. Coalescence en un seul `requestAnimationFrame` par frame (le clic initial s'applique immédiatement ; `pointerup` annule le rAF en attente et **flush** la valeur finale).

## [TESTS]
- `tests/js/test_misc_core_robustness.mjs` (nouveau) — `VolumeSourceManager` en `vm` : drop kind inconnu / path malformé, repli défaut, cas sans `volumeSources` (EDGE-031) ; structurel : suppression du `push` + re-lecture store (BUG-031), `forEach`/`invCam` retirés de `_update` (BUG-069), coalescence rAF + flush `pointerup` (PERF-012). `node --check`.
