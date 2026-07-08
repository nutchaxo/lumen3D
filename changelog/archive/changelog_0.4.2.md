# Changelog v0.4.2

## [FIXED]
- Correction d'une erreur bloquant le chargement des datasets dans les iframes (`TypeError: Cannot read properties of null (reading 'addEventListener')`). L'ID du slider Z (`slicer-position`) est maintenant correctement ciblé et l'écouteur d'événement est protégé par un chaînage optionnel (`?.`) dans `viewer.js` pour la synchronisation du mode Compare.
- Restauration de la fonction `_decomposeChannels()` dans `compare.js` qui causait l'échec de l'initialisation du mode Compare.
