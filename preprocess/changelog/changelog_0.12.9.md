# Changelog v0.12.9

## Outil de Preprocessing

### [OPTIMIZED]
- **Mipmapping standardisé (Puissances de deux carrées)** : Modification du script `2-image_processor.py` pour générer des niveaux LOD intermédiaires (Level >= 1) strictement carrés et à des résolutions de puissances de deux (`256x256`, `512x512`, `1024x1024`, etc.).
- **Conservation de la résolution native** : La résolution native originale (`Level 0`) est préservée sans modification (non carrée et non puissance de deux), assurant une fidélité géométrique maximale en zoom maximal.
- **Préservation des tranches Z** : Le nombre total de coupes Z (`D`) est maintenu identique sur tous les niveaux LOD pour éviter toute distorsion spatiale le long de l'axe vertical lors du zoom ou de la rotation.
