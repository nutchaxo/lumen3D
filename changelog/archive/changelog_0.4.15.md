# Plateforme Web v0.4.15

**Date :** 04 Juin 2026

### [FIXED]
- **Bug critique : `ReferenceError: dragMode is not defined`.** En refactorant `_updateMeasurementLabelPositions` (v0.4.14), la variable `dragMode` — locale au handler pointer — n'était plus accessible depuis la fonction interne `_updateMeasurementLabelPositionsInner`. Cela provoquait une erreur à chaque frame de rendu quand des mesures étaient présentes, empêchant le positionnement correct des labels et spammant la console. Corrigé en utilisant `_draggedLabelSprite != null` (variable module-scoped) comme indicateur de drag actif.
- **Camera sync cassé en mode mesure (vue split).** La rotation de l'embryon 3D en mode mesure (drag avec `moved >= 6`) ne notifiait jamais `_notifyCameraChange()`, car le `pointerup` handler court-circuitait vers le mode mesure avant d'atteindre le code de notification. Les autres vues dans le mode compare ne se synchronisaient plus. Corrigé en ajoutant `_notifyCameraChange()` après un drag significatif en mode mesure.
- **Restauration de l'état URL des iframes (compare).** Race condition sur l'envoi du `postMessage('APPLY_WORKSPACE_STATE')` : le `load` event de l'iframe pouvait se déclencher avant l'attachement du listener, ou après un délai imprévisible. Implémenté un mécanisme double : listener `load` + polling fallback (500ms) qui vérifie la disponibilité de `ViewerApp` dans l'iframe, avec timeout de sécurité (30s).

### [OPTIMIZED]
- **Logging diagnostique temporaire.** Ajout de logs `[Compare]`, `[ViewerApp]`, `[VolumeViewer]` aux points critiques de la chaîne de sauvegarde/restauration d'état pour tracer les erreurs de timing. À supprimer après validation.
