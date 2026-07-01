# Changelog v0.13.0 (Outil de Preprocessing)

## [FIXED]
* **Restauration du débruitage par masque (régression depuis la v1.0.0) :** Le code livré de `2-image_processor.py` ne contenait plus que l'auto-levels simplifié (point noir = médiane des coins, étirement linéaire) ; toute l'étape de seuillage/débruitage documentée jusqu'en v0.12.15 avait disparu sans changelog (les imports `scikit-image`/`scipy` étaient devenus morts, et le commentaire « pas de filtre médian » trahissait le retrait). L'algorithme complet est rétabli et figé ci-dessous.

## [OPTIMIZED]
* **Algorithme de seuillage 16-bits en 3 étapes (`2-image_processor.py`)** — recomposé fidèlement depuis les v0.12.13 → v0.12.15 :
  * **Étape 1 — Corner Sampling.** `bg_floor` = **99ᵉ centile** des 8 coins du volume (fond caméra pur, sans embryon) ; `sig_max` = **99.9ᵉ centile** du volume sous-échantillonné (`[::4,::4,::4]`).
  * **Étape 2 — Masque de signal.** Masque booléen `vol > bg_floor * 1.1`, puis **`binary_opening`** (1 itération) pour éjecter les hot-pixels isolés du capteur, puis **`binary_dilation`** (3 itérations) pour protéger le fondu fluorescent naturel autour du signal biologique.
  * **Étape 3 — Masked Median Filtering + Window Leveling.** Filtre médian 3D (`size=3`) appliqué en *Masked Compositing* : le signal d'origine est **conservé net** à l'intérieur du masque, le fond est **lissé** à l'extérieur (suppression du shot-noise sans flouter les cellules). Mise à l'échelle `[bg_floor, sig_max] → [0, 255]` ; tout voxel `≤ bg_floor` devient un `0` absolu.
* **Parallélisme avec halo Z :** le filtrage médian tourne sur `ProcessPoolExecutor` par blocs Z, chaque bloc transportant un halo de ±1 tranche en Z afin d'éliminer toute couture (seam) à la frontière des blocs.

## [VERIFIED]
* **Reproduction bit-à-bit de la donnée de production.** Re-traitement complet de `Egfl7eGFP-E8-Em7-18112025-GFP555-Pecam1-10x-2xzoom-4avg.ims` (3789×3789×178, 4 canaux, 14.4 GB) avec ce code restauré : les **97/97 hashes SHA-256** des packs de briques et les histogrammes coïncident **exactement** avec le dataset déjà déployé dans `DATA_WEB/`. Preuve que la donnée de production avait bien été générée avec ce pipeline masked-median — seul le *code* avait régressé vers l'auto-levels simplifié, jamais la donnée. Couverture du masque mesurée : 9.14 % / 7.25 % / 4.92 % / 8.31 % (canaux 0→3).

## [NOTE]
* Conséquence en aval : l'espace vide étant ramené à `0` absolu, `3-chunk_packer.py` exclut bien plus de briques de fond (meilleur Empty Space Skipping), réduisant la pression RAM/VRAM du visualiseur SVR — sans la moindre perte de fidélité sur l'embryon.
* Otsu / Noise2Void **ne sont pas** restaurés : ils avaient été retirés délibérément en v0.12.0 (« blobs géants colorés ») et n'ont jamais été réintroduits dans l'algorithme final.
