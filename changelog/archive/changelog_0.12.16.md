# Changelog 0.12.16 (Plateforme Web)

## [OPTIMIZED]
- **Qualité dynamique du Raymarching (Progressive Refinement) :** Réduction dynamique du nombre d'étapes (steps) de raymarching durant les interactions utilisateur (rotation, zoom tactile par pincement, défilement de la molette) à une valeur comprise entre 24 et 48 steps (au lieu des 100 à 150 habituels). Dès que l'interaction s'arrête (relâchement du pointeur ou inactivité de défilement), la plateforme rétablit instantanément le nombre d'étapes maximal configuré et planifie un unique rendu de haute qualité. Cette optimisation soulage considérablement le GPU durant les phases d'exploration active tout en préservant une qualité d'image parfaite au repos.
- **Support des gestes tactiles et de la molette :** Détection globale et unifiée des interactions à deux doigts (pinch zoom) et de la molette de la souris pour basculer automatiquement en mode de rendu optimisé à faible latence.

## [FIXED]
- **Cache-Busting :** Passage du paramètre de version à `v139` dans `viewer.html` pour forcer le navigateur à recharger les scripts mis à jour.
