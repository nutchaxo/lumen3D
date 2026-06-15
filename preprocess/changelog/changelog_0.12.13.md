# Changelog v0.12.13 (Outil de Preprocessing)

## [OPTIMIZED]
* **Algorithme de seuillage du bruit de fond 2-passes (2-image_processor.py)**:
  * Implémentation du *Corner Sampling* pour estimer le plancher de bruit (noise floor) depuis les 8 coins du volume, avec le 10ème centile.
  * Soustraction du plancher avec clipping strict à zéro.
  * Création d'un masque de signal basé sur un seuil empirique (> 20.0).
  * Dilatation morphologique 3D (3 itérations) du masque pour sécuriser les bordures du signal biologique.
  * Application du filtre médian 3D en "Masked Compositing" à l'intérieur de `process_z_block` (multithreaded).
  * Le signal d'origine est conservé dans le masque, tandis que le bruit est lissé/filtré à l'extérieur.

Ces modifications assurent une drastique réduction des artefacts résiduels et limiteront efficacement le nombre de "chunks" générés par `3-chunk_packer.py`, permettant d'éviter les erreurs de saturation VRAM (Sparse Voxel Rendering) sur la Plateforme Web.
