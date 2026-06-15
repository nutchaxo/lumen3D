# Changelog v0.12.14 (Outil de Preprocessing)

## [OPTIMIZED]
* **Refonte de l'algorithme de seuillage 16-bits (2-image_processor.py)**:
  * Application d'une approche 3 étapes directement sur le flux Float32 issu du 16-bits natif.
  * **Étape 1**: Estimation du plancher de bruit (bg_floor) via le 99ème centile de 8 coins (Corner Sampling), et du signal maximum (sig_max) via le 99.9ème centile du volume global.
  * **Étape 2**: *Selective Masked Median Filtering*. Création d'un masque booléen sur `vol > bg_floor * 1.1`, suivi d'une dilatation morphologique 3D de 3 itérations. Le filtrage médian s'opère en "Masked Compositing" à l'intérieur des blocs z pour préserver les cellules non floutées et lisser le fond vide.
  * **Étape 3**: *Min-Max Scaling unifié*. Conversion ultra-optimisée vers 8-bits par "Window Leveling" mathématique de l'intervalle `[bg_floor, sig_max]` vers `[0, 255]`. Tout pixel lissé inférieur ou égal à `bg_floor` est converti en un 0 absolu en `uint8`.

Ces optimisations vectorisées garantissent que `3-chunk_packer.py` peut exclure totalement le vide de ses métadonnées sans provoquer le moindre artefact visuel, réduisant massivement les besoins en RAM et VRAM du visualiseur.
