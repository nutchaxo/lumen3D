# Plateforme Web v0.4.14

**Date :** 01 Juin 2026

### [FIXED]
- **Bug critique : Gel de la vue 3D après placement de mesures.** La boucle de rendu (`_animate`) crashait silencieusement lorsque `_updateMeasurementLabelPositions` lançait une exception non attrapée. Le `requestAnimationFrame` n'était plus rappelé et la vue se figeait définitivement. Ajout d'un `try/catch` protecteur autour de tous les appels critiques dans la boucle de rendu pour garantir que le rendu ne s'arrête **jamais**, même en cas d'erreur interne.
- **Bug : Mesures non visibles immédiatement après création.** Forçage du réveil du render loop (`_idleFrameCount = 0`) et d'un `_scheduleFrame()` dans `setMeasurements()` pour que les nouvelles mesures soient rendues sans nécessiter un autre événement utilisateur.
- **Perte de l'état URL au rechargement (compare).** Les fonctions `getWorkspaceState` et `applyWorkspaceState` n'étaient pas exposées dans l'API publique de `ViewerApp`, empêchant la fenêtre `compare.js` de récupérer l'état des iframes. Corrigé.
- **Cache navigateur empêchant le chargement des corrections.** Mise à jour systématique de tous les cache busters (`v=20260601-v5`) dans `viewer.html`, `compare.html` et l'URL d'iframe dans `compare.js` pour forcer le chargement du code corrigé.
- **Doublon de script `annotation-manager.js`.** Le fichier était chargé deux fois dans `viewer.html`, provoquant potentiellement des réinitialisations d'état. Supprimé.

### [OPTIMIZED]
- **Résilience de la boucle de rendu.** `_updateMeasurementLabelPositions` est maintenant encapsulé dans son propre `try/catch` qui log l'erreur dans la console au lieu de crasher le rendu. Les erreurs de positionnement de labels n'affectent plus la stabilité du viewer.
