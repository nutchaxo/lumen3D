# Changelog 0.12.23 (Plateforme Web)

## [OPTIMIZED]
- **Optimisation des Shaders de Projection de Grille (VolumeGrid) :** Correction d'un goulot d'étranglement majeur où la grille de référence spatiale et les axes continuaient de projeter des rayons avec 100 à 150 étapes (steps) par pixel pendant les interactions, même lorsque le shader du volume principal était réduit à 24-48 étapes. Propagation dynamique de l'état d'interaction (`isInteractingNow`) et du nombre réduit d'étapes aux instances de `ShaderMaterial` de la grille spatiale (`VolumeGrid`). Cela supprime les calculs redondants à haute intensité sur le GPU pendant les rotations.

## [FIXED]
- **Cache-Busting :** Incrément du cache-buster global à `v147` dans `viewer.html` pour invalider le cache des fichiers JavaScript associés.
