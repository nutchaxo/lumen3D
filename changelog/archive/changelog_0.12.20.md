# Changelog 0.12.20 (Plateforme Web)

## [OPTIMIZED]
- **Optimisation du Seeding Asynchrone des Textures (Transition de Qualité) :** Réduction de l'impact CPU de la fonction `_seedTexturesFromActiveAsync` lors des changements de qualité (ex. de preview 256x256 vers haute résolution 1024x1024). L'algorithme d'interpolation 3D par plus proche voisin a été optimisé en limitant la taille de traitement à 4 tranches (slices) par frame (au lieu de 16) afin de maintenir l'exécution sous le budget d'une frame d'affichage (16,6 ms) et de laisser le thread principal disponible. De plus, l'accès aux tableaux typés a été optimisé par l'utilisation de vues de sous-tableaux (`subarray()`) évitant les surcoûts d'indexation globaux répétés.

## [FIXED]
- **Cache-Busting :** Incrément du cache-buster global à `v143` dans `viewer.html` pour invalider le cache des navigateurs.
