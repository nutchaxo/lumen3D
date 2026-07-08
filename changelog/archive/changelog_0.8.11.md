# Plateforme Web v0.8.11 — 2026-06-08

## [ADDED] Visualisation par Résolutions Physiques de Rendu
- **Transition** : Remplacement des mots-clés abstraits de qualité (`preview`, `balanced`, `high`) par les résolutions explicites (`256x256`, `512x512`, `1024x1024`) dans les contrôles UI et les chargeurs internes.
- **Transparence** : Les dimensions physiques exactes du dataset correspondant à la résolution sélectionnée sont affichées à côté du libellé dans le menu déroulant.
- **Sélection dynamique de niveau (LOD)** : Le calcul de l'index de niveau de détail (LOD) se fait dynamiquement dans le visualiseur en faisant correspondre la taille cible aux dimensions réelles des niveaux déclarées dans le manifest du dataset.

## [OPTIMIZED] Rendu et Chargement Progressif
- **Optimisation** : Chargement initial progressif en `256x256` puis basculement transparent en tâche de fond vers la résolution de travail par défaut `512x512`.
- **Compatibilité** : Gestion automatique de compatibilité ascendante pour toutes les configurations, états sauvegardés d'espace de travail ou paramètres URL utilisant les anciennes clés.
