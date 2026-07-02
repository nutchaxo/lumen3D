# Plateforme Web — v1.0.49

> Lot « viewer/compare : postMessage, gardes & code mort » — `js/pages/viewer.js` + `js/pages/compare.js` + `js/core/utils.js`. Specs d'édition viewer.js produites par un workflow parallèle (3 agents), appliquées verbatim et vérifiées (`node --check` + structurel). 12 findings.

## [FIXED]
- **SEC-012** — toutes les émissions `window.parent.postMessage(payload, '*')` de `viewer.js` (13 sites) utilisaient un `targetOrigin` joker, fuyant potentiellement l'état d'étude vers une fenêtre parente arbitraire. Nouveau helper `Utils.trustedTargetOrigin()` (= `window.location.origin`, sibling de `isTrustedMessageOrigin` ajouté pour SEC-003) ; tous les sites postent désormais vers l'origine exacte (les iframes Compare/Admin sont strictement same-origin). Zéro joker restant.
- **DEAD-021** — l'émission `SYNC_EXPOSURE` (viewer.js) ne portait pas de `sourceIndex` (et le consommateur réel est `admpan.js:751`, pas `compare.js`). Ajout de `sourceIndex: _panelIndex` + `targetOrigin` durci → message bien formé, l'admin continue de recevoir l'exposition. *(Note : l'émission n'est PAS morte — `admpan.js` l'écoute ; vérifié avant toute suppression.)*
- **BUG-030** — `ReferenceError` sur `bar` (non déclaré) dans `_drawSliceScaleOverlay` : résolu mécaniquement par la suppression de la chaîne morte DEAD-013.
- **BUG-008** — `_deepZoomActive` n'était jamais mis à `true`, rendant inertes les branches DeepZoom de `getCurrentSliceResult`/`REQUEST_SCREENSHOT`. Remplacé par `DeepZoomViewer.isActive()` (source de vérité réelle) ; flag mort retiré.
- **BUG-032** (Rule 1.4) — le chemin dataset `live` lisait `dimensions.t` sans garde → `TypeError` sur un dataset live malformé. Garde `Number.isFinite(totalFrames) && > 0` + rejet explicite.
- **BUG-033** (Rule 1.4) — `_mergeDatasetMetadata` montait des metadata incomplètes en silence quand le fetch échouait et que les dimensions manquaient. Throw explicite (« dimensions absentes du catalogue ») → init aborte au lieu de monter un dataset à calibration NaN.
- **LEAK-002** (Rule 1.2) — `_slicerOverlayStop()` n'était jamais appelé → la boucle rAF d'overlay de slice tournait à vie. Désormais appelée quand le slicer est masqué / sur les branches de fin de sync.

## [OPTIMIZED]
- **DEAD-001** — cinq fonctions (`_lodForQuality`, `_qualityDimsLabel`, `_qualityDims`, `_bindVolumeControls`, `_bindZScaleControls`) étaient définies **deux fois à l'identique** ; seconde copie supprimée (~130 lignes).
- **DEAD-002** — `_bindSliceGizmo` (gizmo 3D complet : `WebGLRenderer`/scène/géométries/matériaux/listeners dédiés, ~217 lignes) défini mais jamais appelé. Supprimé (zéro appelant vérifié).
- **DEAD-013** — chaîne de rendu de slice 2D morte (`_drawSliceResult`/`_drawSliceOverlay`/`_drawSliceScaleOverlay`) supprimée ; `_setSliceStatus` conservé.
- **DEAD-015** — assignations dupliquées copy-paste retirées (double `volumeSources` ; double `dataset-subtitle` dont la première était écrasée).
- **DEAD-020** — `compare.js` `_setPanelLoadState` était un no-op total appelé depuis 7 sites. Fonction + tous les appels supprimés.

## [TESTS]
- `tests/js/test_viewer_postmessage_deadcode.mjs` (nouveau) — `Utils.trustedTargetOrigin` en `vm` ; structurel viewer.js/compare.js : zéro joker postMessage + usage du helper (SEC-012), `SYNC_EXPOSURE` porte `sourceIndex` (DEAD-021), fonctions/chaînes mortes absentes (DEAD-001/002/013) et `_setSliceStatus` conservé, `_slicerOverlayStop` appelé (LEAK-002), `DeepZoomViewer.isActive()` + flag mort retiré (BUG-008), gardes dims live (BUG-032) et metadata (BUG-033), `_setPanelLoadState` totalement retiré (DEAD-020). `node --check`.
- `tests/js/test_viewer_metadata_validate.mjs` — fenêtre de slice élargie (1600→2400) : BUG-033 a allongé `_mergeDatasetMetadata`, l'invariant `throw err;` (ELE-19) reste vérifié.
