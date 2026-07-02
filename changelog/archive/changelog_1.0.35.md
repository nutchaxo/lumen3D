# Plateforme Web — v1.0.35

## [OPTIMIZED]
- **ELE-28 (PERF-002)** — `js/viewers/tracking-viewer.js` : `_updateClipCap` reconstruisait intégralement le cap de coupe (parcours **par triangle** `_collectPlaneSegments` + allocation/dispose GPU) à **chaque** frame de scrub. Mémoïsation via `_clipCapSignature` (spec du plan : `enabled`/`mode`/`value`/`yaw`/`pitch`/`color`/`opacity` + `_clipSpan()` + ensemble trié des variantes de surface visibles). Le cap n'est reconstruit que si la signature change (sinon le cap existant est correct). Désactivation gérée explicitement (`'disabled'`) avec reconstruction forcée à la réactivation. Rendu inchangé.
- Test : `tests/js/test_tracking_clipcap_memo.mjs` (structurel : signature complète, garde mémo avant le parcours par triangle et `_buildClipPlane`) + `node --check`.
