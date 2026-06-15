# Changelog - Outil de Preprocessing

## v0.12.3

### [OPTIMIZED]
- **Suppression absolue du Bruit de fond (Floor Crushing) :** Modification de la logique de normalisation Python (`2-image_processor.py`). Au lieu de simplement diviser par le maximum (`p_max`), le pipeline calcule le 5ème centile des pixels les plus sombres (`p_min = percentile(5.0)`) et le soustrait globalement. 
- **Prévention d'accumulation Additive :** Cette opération force l'espace vide à valoir *strictement* `0` (au lieu d'un bruit résiduel à `1` ou `2`). En mode WebGL *Additive Blending*, cela empêche l'addition du bruit de fond sur 100 tranches Z, garantissant un noir inter-cellulaire pur, même en haute résolution.
