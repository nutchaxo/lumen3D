# Changelog 0.12.18 (Plateforme Web)

## [OPTIMIZED]
- **Élimination du goulot d'étranglement de décodage des briques (OffscreenCanvas Caching) :** Optimisation majeure du décodage d'images dans `brick-decode-worker.js` (Web Worker) et `brick-loader.js` (Main thread fallback). Auparavant, le chargement de briques de tailles hétérogènes (briques frontières de taille réduite comme 51x51x128 par rapport aux briques internes de 128x128x128) détruisait et recréait sans arrêt l'OffscreenCanvas et son contexte 2D WebGL/GPU sous-jacent. Cela prenait entre 90ms et 110ms par brique frontière. J'ai réécrit ce module pour réutiliser une unique instance de canvas : le canvas est uniquement redimensionné à la hausse si une brique plus grande se présente. Pour les briques plus petites, le canvas conserve sa taille globale, l'image est dessinée en haut à gauche et seule la région pertinente est lue via `ctx.getImageData(...)`. Cette optimisation élimine totalement les lenteurs aléatoires de 100ms sur les briques frontières.

## [FIXED]
- **Cache-Busting :** Incrément du cache-buster global à `v141` dans `viewer.html` pour invalider le cache des navigateurs.
