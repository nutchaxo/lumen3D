# Changelog - Outil de Preprocessing

## v0.11.7

### [OPTIMIZED]
- **Denoising (Noise2Void) Smoothing:** Modifié la prédiction N2V pour "blender" le signal de sortie (60% débruité, 40% original). Ceci restaure la structure naturelle et évite le rendu plastique "trop lisse".
- **Dynamic Range (Percentiles):** Ajusté la plage de clipping de `[0.0, 99.9]` à `[0.05, 99.5]`. Saturation des 0.5% de pixels les plus brillants pour remonter les tons moyens et rendre les couleurs beaucoup plus vibrantes.
- **Background Removal:** Rétabli la soustraction de bruit `dark-field` de BaSiC à 100% et augmenté le seuil de coupure du masque d'Otsu (de x0.2 à x0.5) pour bloquer la neige résiduelle aux bordures des images.
