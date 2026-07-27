# Changelog v1.28.0 (Plateforme Web)

> Les volumes mono-canal occupaient quatre fois la mémoire nécessaire. En 4D, c'est ce qui empêchait la série de tenir en VRAM.

## [OPTIMIZED]
* **Texture R8 pour les datasets mono-canal.** Un volume à un seul canal ne remplit que la composante R, mais la texture 3D était systématiquement allouée en RGBA8 : **trois quarts de remplissage**, soit 58 Mio au lieu de 15 Mio par timepoint sur la série de référence — et réalloués à chaque changement de frame.
  * **Aucun changement de shader nécessaire** : échantillonner une texture `RedFormat` renvoie `vec4(r, 0, 0, 1)`, le canal 0 lit `val.r`, et les canaux 1 à 3 sont **retirés à la compilation** parce que `_recompileShaderForActiveChannels` conditionne `ENABLE_CHANNEL_n` à `numChannels > n`. C'est le seul vrai piège de ce changement : sans ce garde-fou, l'alpha à 1,0 aurait peint tout le volume en blanc.
  * **Aucun nouveau chemin de code** : la lecture scalaire existait déjà. `_writeBrick` branche sur `_isRgbaTexture`, `_extractTextureRegionData` calcule `stride = rgba ? 4 : 1`, `_compactScalarBrickData` est là, et `_computeChannelHistograms` a sa branche non-RGBA. Il ne restait qu'à choisir le bon format à l'allocation.
  * Exclu quand les bricks arrivent entrelacées RGBA (`raw-rgba-gzip`), transport qui écrit les quatre composantes d'un coup via `_writeRgbaBrick`.
* **La limite du cache GPU mesure l'empreinte réelle d'une entrée** au lieu de supposer 4 octets par voxel. Cette hypothèse sous-estimait d'un facteur quatre le nombre de timepoints mono-canal qui tiennent, et continuait donc d'évincer des frames qui avaient toute la place de rester.

## [VERIFIED]
Contre le dataset réel, dans le navigateur, volet affiché :

| Mesure | Avant | Après |
|---|---|---|
| Tampon par timepoint | 60 817 408 o (RGBA) | **15 204 352 o** — exactement 512×512×58, `RedFormat` |
| Revisites pendant la lecture | aucune gratuite, ~181 ms | **166 revisites à 1 ms de médiane** |
| Frames avancées sur la fenêtre de test | 80 | **133** |
| Premières visites | 63 à ~181 ms | 29 à ~156 ms — un seul passage suffit |
| `AbortError` | 0 | 0 |

Les 30 timepoints tiennent désormais en mémoire : après un premier passage complet, la lecture ne coûte plus qu'un échange de texture.

**Non-régression** vérifiée sur un dataset `fixed` à 4 canaux (3789×3789×125) : `bytesPerVoxel = 4`, format RGBA inchangé, rendu couleur correct (DAPI / GFP / Dextran), aucune erreur.

Vérifié aussi que la stabilisation 4D reste active et correcte avec la texture R8 (`isStabilized() === true`, rendu conforme).
