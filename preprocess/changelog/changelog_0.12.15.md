# Changelog v0.12.15 (Outil de Preprocessing)

## [OPTIMIZED]
* **Morphological Opening du masque de signal (2-image_processor.py)**:
  * Afin de contrer les pixels morts hyper-lumineux (hot pixels du capteur) qui passeraient le seuil de bruit, une ouverture morphologique 3D (`scipy.ndimage.binary_opening`, 1 itération) a été insérée juste avant la dilatation protectrice.
  * Les hot pixels isolés sont ainsi exclus du masque avant qu'ils ne soient "protégés et gonflés" par la dilatation. Ils subissent alors de plein fouet le filtre médian puis le *Window Leveling*, qui les réduisent à une valeur absolue de `0` en `uint8`.
  * Résultat : Une pureté parfaite de l'Empty Space Skipping pour l'étape de génération de briques (SVR).
