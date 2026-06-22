# Plateforme Web — v1.0.53

> Lot « robustesse tracking » — `timeline.js`, `tracking.js`, `tracking-viewer.js`.

## [FIXED]
- **BUG-052** — `tracking-viewer.js` `_computeVisibleMeshDensity` retournait `_globalDensityStats` codé en dur (`{min:0,max:20,p10:0,p90:10}`), ignorant la distribution réelle. Les statistiques sont désormais calculées via `_densityStats(...)` sur les densités effectivement calculées (repli sur le placeholder uniquement si vide) → normalisation couleur correcte.
- **EDGE-016** — `tracking.js` `_initTimeline` retombait sur **10 frames codées en dur**. Nouvel export `TrackingViewer.getFrameCount()` (= `timepoints.length` || `dimensions.t` || 1) ; le nombre de frames est dérivé des données et clampé à ≥ 1.
- **EDGE-040** — `timeline.js` `init` ne coercait pas les numériques (`Math.max(1, NaN)` = `NaN`). `totalFrames`/`speedValue`/`smoothValue` sont désormais coercés via `Number.isFinite` avec repli (1 / 5 / 0) — robuste quel que soit l'appelant.
- **LEAK-007** (Rule 1.2) — `tracking-viewer.js` `_initInstancedMesh`/`_attachModel` ne disposaient pas l'ancien `InstancedMesh` ni l'ancien `_glbScene` au rechargement. Disposal des géométries/matériaux/buffers d'instance + retrait du groupe de surface orphelin avant remplacement.
- **LEAK-008** (Rule 1.2) — `tracking.js` `_renderTrackingLegend` ré-ajoutait un listener `document 'click'` sans retirer le précédent lors d'un changement de mode de légende (density → uniform/region, qui retournent tôt sans atteindre le détachement). Détachement déplacé **en tête de fonction**, avant les retours anticipés.

## [OPTIMIZED]
- **PERF-025** — `timeline.js` `play()` utilisait `setInterval(50ms)` (drift, ticks en arrière-plan). Converti en boucle `requestAnimationFrame` (id dans `_playTimer`, `cancelAnimationFrame` au `pause()`) ; l'avance basée sur `dt` conserve la vitesse correcte et la boucle s'auto-throttle en onglet masqué.
- **DEAD-036** — `tracking.js` : double affectation de `dataset-subtitle` (la première `·`-séparée immédiatement écrasée) ; assignation unique conservée.

## [TESTS]
- `tests/js/test_tracking_robustness.mjs` (nouveau) — structurel + `node --check` : coercition `timeline.init` (EDGE-040), `play()` en rAF sans `setInterval`/`clearInterval` (PERF-025), `getFrameCount` exporté + usage (EDGE-016), assignation unique subtitle (DEAD-036), détachement listener avant les branches (LEAK-008), stats réelles (BUG-052), disposal mesh/GLB (LEAK-007). Non-régression : `test_tracking_clipcap_memo.mjs`, `test_tracking_surface_memo.mjs`.
