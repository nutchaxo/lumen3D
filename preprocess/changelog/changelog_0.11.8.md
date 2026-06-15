# Changelog - Outil de Preprocessing

## v0.11.8

### [OPTIMIZED]
- **GPU Acceleration (PyTorch/CUDA) :** L'entraînement Noise2Void (N2V) a été migré sur GPU (`cuda`). L'entraînement est désormais sérieux (100 époques) avec extraction d'un millier de patchs aléatoires au lieu d'une passe symbolique sur CPU.
- **Robust Background Subtraction :** Suppression complète de l'étape de division `Flat-field` (qui générait des artefacts "blobs" explosifs dans le fond). Remplacement par un `Dark-field` ultra robuste utilisant un clipping au `2ème percentile` du volume, lissé géométriquement pour soustraire le bruit de capteur et les pixels morts.

### [FIXED]
- **Mathematical Correction of Dynamic Range :** Le calcul de la plage de normalisation dynamique (percentiles `p_lo`/`p_hi`) est désormais exécuté **strictement** sur les voxels à l'intérieur du masque binaire (`vol_final[mask]`) pour ne plus être biaisé par le noir absolu du fond ou les artefacts externes.
- **Intelligent Anti-Hole Masking :** Le nettoyage morphologique du masque Otsu a été consolidé avec du `binary_fill_holes` et un `binary_closing` de rayon large pour garantir que l'embryon complet soit conservé.
