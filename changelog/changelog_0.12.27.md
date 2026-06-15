# Changelog 0.12.27 (Plateforme Web)

## [ADDED]
- **Optimisation de la Fluidité de Rendu durant le Streaming :**
  - Suite aux tests de diagnostic révélant un blocage GPU lors du raymarching pendant le chargement des briques, introduction de l'état `_isStreamingBricks` géré via un bloc `try...finally` robuste.
  - Durant le chargement progressif des briques, la qualité de rendu (le nombre d'échantillons `steps` et le ratio de pixels `pixelRatio`) est temporairement abaissée, réduisant le coût du raymarching de plus de 10x et éliminant les gels d'interface (stalls WebGL).
  - Dès que le chargement se termine (succès, annulation ou erreur), la qualité maximale d'affichage statique est instantanément restaurée.

## [OPTIMIZED]
- **Algorithme Dynamic LOD (Auto Mode) :**
  - Refonte de la sélection dynamique de la résolution au zoom dans `_preferredAutoQuality()`.
  - Au lieu de chercher la plus proche distance absolue (ce qui nécessitait un zoom très important avant de changer de niveau), le système choisit désormais le premier niveau de résolution suffisant (`maxDim >= targetSize`), ce qui rend la transition vers les résolutions supérieures (dont native) beaucoup plus réactive et alignée sur la perception visuelle de l'utilisateur.

## [FIXED]
- **Shader 3D :** Restauration complète du raymarching 3D (le bypass temporaire de diagnostic a été retiré).
- **Cache-Busting :** Incrément du cache-buster global à `v151` dans `viewer.html`.
