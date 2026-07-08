# Plateforme Web - v0.4.9

## [OPTIMIZED]
- **Correction du Daltonisme (Daltonization) :** Remplacement des matrices de simulation SVG (qui se contentaient d'imiter la perte de vision daltonienne) par de véritables matrices de correction colorimétrique (*Daltonization*).
  - Ces nouvelles matrices calculées décalent mathématiquement les informations des axes de couleurs problématiques (comme le contraste rouge/vert) vers des spectres perceptibles (bleu/jaune) pour aider les utilisateurs à différencier les éléments.
  - Ajout de l'attribut `color-interpolation-filters="linearRGB"` sur les filtres pour garantir une interpolation précise de l'intensité lumineuse et une exactitude mathématique lors de la correction.
  - Désormais, les filtres d'anomalie/anopie (Protanopie vs Deuteranopie) ne produiront plus un rendu identique, car l'algorithme corrige les couleurs en fonction de la déficience exacte (la compensation sur le rouge différera de la compensation sur le vert) plutôt que de les dégrader de la même manière.
