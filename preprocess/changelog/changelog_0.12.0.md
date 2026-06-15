# Changelog - Outil de Preprocessing & WebGL Platform

## v0.12.0

### [ADDED]
- **Imaris Transfer Function (WebGL) :** L'échantillonnage de la couleur par le shader `volume-viewer.js` n'utilise plus d'interpolation `smoothstep` (qui modifiait les tons de manière non linéaire), mais suit la formule académique utilisée par les moteurs SOTA SOT (comme Imaris) : une clamp linéaire stricte combinée à une puissance (Gamma). L'opacité est désormais calculée exactement via `A_sample = ((V - Min)/(Max - Min))^Gamma`.

### [OPTIMIZED]
- **Raw SOTA Pipeline :** Le script de preprocessing Python conserve les données 16-bits native du microscope et ne détruit plus le signal biologique avec du Deep Learning. Il se contente d'éliminer le fond global de la caméra (Dark Point) et de projeter linéairement la pure intensité vers une échelle 8-bits, maximisant la précision structurelle du rendu. 
- **Vitesse Éclair :** L'abandon du réseau de neurones permet un "cuisage" (`baking`) du volume et de sa pyramide de niveaux de détails (LOD) en quelques secondes.

### [FIXED]
- **Artefacts d'Otsu et Convolution :** Le retrait du filtre de Noise2Void et de la soustraction de masque Otsu résout complètement le problème des "blobs" géants et colorés. L'embryon et son bruit physiologique reprennent leur forme naturelle et réaliste de nuage de points.
