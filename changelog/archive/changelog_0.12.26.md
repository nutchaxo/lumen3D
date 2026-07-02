# Changelog 0.12.26 (Plateforme Web)

## [ADDED]
- **Diagnostic de Performance (Bypass du Shader) :**
  - Ajout temporaire d'un bypass dans `volume-viewer.js` (début de la fonction `main` du fragment shader) pour retourner directement la couleur des coordonnées UV 3D (`fragColor = vec4(vUv, 0.8)`).
  - Cela désactive complètement le raymarching (échantillonnage de textures, calcul de luminosité et d'occlusion) afin d'isoler l'impact sur le CPU/GPU lors de la mise à jour progressive des briques.

## [FIXED]
- **Cache-Busting :** Incrément du cache-buster global à `v150` dans `viewer.html` pour invalider le cache du navigateur.
