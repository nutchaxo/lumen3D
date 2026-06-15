# Changelog - Outil de Preprocessing & WebGL Platform

## v0.12.1

### [ADDED]
- **Additive Blending (WebGL) :** L'accumulation des voxels utilise désormais le rendu `THREE.AdditiveBlending`. L'arrière plan du WebGL a été forcé au noir pur (`#000000, alpha: 1`). Le shader additionne directement l'intensité lumineuse des structures empilées pour créer un aspect "Néon/Fluorescent" au lieu du "crayeux/pastel" précédent.
- **Tone Mapping (WebGL) :** Ajout d'une courbe logarithmique `finalColor = log(1.0 + dvrColor * exposure * 2.5)` pour compresser les hautes lumières et éviter l'écrêtage saturé tout en préservant l'aspect luminescent (retrait de la fonction ACESFilm).

### [OPTIMIZED]
- **Filtre Médian 3D (Python) :** Ajout d'un `scipy.ndimage.median_filter` (size=3) dans le pipeline Python `2-image_processor.py`. Ce filtre permet de supprimer spécifiquement le bruit de photon (shot noise) sans altérer la netteté des arêtes biologiques (edge-preserving), évitant l'effet "flou gaussien" de l'ancien pipeline.
