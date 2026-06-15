# Changelog 0.12.22 (Plateforme Web)

## [OPTIMIZED]
- **Rendu à Résolution Dynamique Amélioré (DRS) :** Abaissement drastique du pixel ratio à une valeur fixe de `0.40` (pour la qualité 1024x1024 / native) ou `0.50` (pour les autres) pendant l'interaction active. Cela divise par 6.25 (et jusqu'à 25 fois sur les écrans Retina) le nombre de pixels évalués par le fragment shader de raymarching, évitant ainsi la saturation du GPU par le fill-rate.
- **Limitation du Taux de Rafraîchissement en Interaction (Framerate Capping) :** Limitation forcée à un maximum de `40 FPS` lors des mouvements de caméra et rotations (intervalle minimum de 25ms entre chaque frame). Sur les écrans à haut rafraîchissement (144Hz, 240Hz, etc.) où la boucle de rendu tournait sans limite, cela réduit la charge et l'échauffement du GPU en évitant de rendre des centaines de millions d'étapes de raymarching inutiles par seconde, faisant chuter drastiquement l'utilisation GPU de 100% à des valeurs très faibles.
- **Restauration Haute Définition Intelligente :** Dès que l'utilisateur relâche le pointeur, le viewer réinitialise immédiatement le pixel ratio natif de l'écran et le nombre d'étapes cibles pour restituer instantanément un rendu 3D net et haute définition de manière statique.

## [FIXED]
- **Cache-Busting :** Incrément du cache-buster global à `v146` dans `viewer.html` pour forcer le rechargement de tous les scripts 3D.
