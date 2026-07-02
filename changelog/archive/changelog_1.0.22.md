# Plateforme Web — v1.0.22

## [FIXED]
- **ELE-14 (RACE-005)** — Boucle d'écho `SYNC_ZSTACK_SLICE` entre panneaux de comparaison. `applyState` planifiait `setTimeout(() => _goToSlice(slice), 80)` ; or le récepteur réinitialise `suppressZstackSync` de façon **synchrone** bien avant ce timer → le `_goToSlice` différé re-diffusait et ping-pongait avec le panneau voisin. Le callback différé **ré-arme** désormais le garde (`suppressZstackSync = true`) le temps de son exécution puis restaure l'état précédent (imbrication sûre). Corrigé dans le module `js/modules/tools/zstack-browser/index.js` (chemin de production) **et** le fallback IIFE de `js/pages/viewer.js`.
- Test : `tests/js/test_zstack_echo.mjs` (vm + faux timers : le différé ne re-diffuse pas, un changement local diffuse une fois) + `node --check`.
