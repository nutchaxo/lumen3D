# Plateforme Web v0.4.16

**Date :** 04 Juin 2026

### [FIXED]
- **Bug critique : `_draggedLabelSprite is not defined` (deuxième occurrence).** La refactorisation en `_updateMeasurementLabelPositionsInner` avait sorti la logique hors de la closure `_setupInteraction` où `_draggedLabelSprite` est déclaré. La correction définitive : fusionner en une seule fonction `_updateMeasurementLabelPositions(finalizeDrag, activeDraggedSprite)` qui accepte le sprite actif en paramètre explicite — aucune dépendance de closure. Les appelants (`_animate`, `_setupInteraction pointermove`, `_setupInteraction pointerup`) passent la référence appropriée.
- **Labels de mesure non déplaçables.** Le `pointermove` lors du drag passait `activeDraggedSprite = null` (argument omis), ce qui mettait l'`effectiveRadius` du sprite à sa valeur normale et la répulsion le combattait. Corrigé : le `pointermove` passe `_draggedLabelSprite` explicitement.
- **Camera sync en mode mesure (suite).** L'ajout du `_notifyCameraChange()` pour les drags en mode mesure était correct mais l'ordre des `else if` permettait que le cas `moved >= 6` soit ignoré. Vérifié et consolidé.
- **État URL non restauré au rechargement (cause racine identifiée et corrigée).** Le listener `APPLY_WORKSPACE_STATE` dans `_bindIframeSync()` était installé APRÈS plusieurs `await` dans `init()`. Le postMessage de `compare.js` arrivait avant que le listener existe, et était perdu. Correction : installation d'un listener global **synchrone** au niveau module (avant tout `await`), qui tamponne l'état dans `_pendingWorkspaceState` si `_isInitialized` est encore `false`. `init()` applique ce tampon après le chargement du volume via `_applyWorkspaceStateNow()`.
- **Duplication `Utils`/`I18n` dans compare.** (En cours d'investigation — probable doublon de script tag dans `compare.html`.)

### [OPTIMIZED]
- **Architecture `_applyWorkspaceState` clarifiée.** Séparation entre la fonction publique (buffer si non-initialisé) et `_applyWorkspaceStateNow` (interne, utilisé par `init()` après chargement du volume).
