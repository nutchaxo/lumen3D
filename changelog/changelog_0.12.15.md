# Changelog 0.12.15 (Plateforme Web)

## [OPTIMIZED]
- **Optimisation de la boucle de Raymarching (Shader de Rendu 3D) :** Modification du fragment shader dans `volume-viewer.js` pour suivre de manière précise le paramètre de distance `t` (parcours de rayon), y compris lors des sauts ("leaping" d'espace vide et vérification d'occupance). Cela permet d'interrompre le calcul immédiatement dès que le rayon quitte les limites de la boîte ou de la zone découpée, au lieu de continuer à boucler inutilement jusqu'à 512 itérations. Cette correction résout la surcharge GPU de 100% observée lors du rendu.

## [FIXED]
- **Correction définitive des textures striées (Chromium) :** Suppression complète des appels à `close()` sur les instances d'ImageBitmap (`bmp.close()` dans `brick-decode-worker.js` et `img.close()` dans `brick-loader.js`). Dans Chromium, libérer immédiatement le ImageBitmap après l'appel synchrone `ctx.getImageData(...)` causait une corruption des buffers de texture sous-jacents encore référencés par le compositeur du navigateur, d'où l'apparition des stries horizontales.
- **Cache-Busting :** Passage du paramètre de version à `v138` dans `viewer.html` pour forcer le navigateur à recharger les scripts mis à jour.
