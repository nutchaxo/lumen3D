# Changelog v0.12.45 — Fix ordre d'initialisation des plugins

## [FIXED]
- **Ordre de chargement du PluginRegistry** : Les modules étaient initialisés après la génération de l'interface utilisateur. La méthode `PluginRegistry.loadModules()` a été remontée au tout début du flux d'initialisation de `viewer.js`. 
- **Conséquence** : Les interfaces dépendantes d'une liste dynamique (comme le panneau des canaux pour les histogrammes et le menu déroulant des Render Modes) peuvent maintenant interroger correctement les métadonnées (`listByPlacement`) et afficher les éléments sans erreur.
