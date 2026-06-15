# Changelog 0.12.17 (Plateforme Web)

## [FIXED]
- **Correction d'une ReferenceError sur _activePointers :** Promotion de la variable `_activePointers` de la portée locale de la fonction `_setupInteraction(...)` vers la portée globale du module (`volume-viewer.js`). Cela permet à la fonction de boucle de rendu `_animate()` de lire correctement le nombre de pointeurs actifs pour ajuster dynamiquement la qualité du raymarching.
- **Cache-Busting :** Incrément du cache-buster global à `v140` dans `viewer.html` pour invalider le cache des navigateurs.
