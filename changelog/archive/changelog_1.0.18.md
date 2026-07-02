# Plateforme Web — v1.0.18

## [FIXED]
- **ELE-16 (RACE-007)** — `js/core/brick-decode-worker.js` : le worker ne gérait que les messages `DECODE` ; `cancelPending()` postait `{type:'CANCEL'}` (`brick-loader.js`) **sans effet** → des décodages périmés (dataset/qualité/timepoint abandonné) revenaient quand même. Ajout d'une **époque d'annulation** : `CANCEL` incrémente l'époque ; tout job en file ou en vol d'une époque antérieure est ignoré (garde au début de `processDecode` et avant chaque `postMessage`). Le décodage CPU n'étant pas interruptible en plein vol, on supprime le résultat plutôt que de l'interrompre. Comportement nominal inchangé (époque reste 0).
- Test : `tests/js/test_brick_decode_cancel.mjs` (CANCEL en file et en vol via harnais `vm`).
