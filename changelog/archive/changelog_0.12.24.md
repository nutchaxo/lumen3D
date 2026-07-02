# Changelog 0.12.24 (Plateforme Web)

## [OPTIMIZED]
- **Optimisation Algorithmique du Raymarching (Fragment Shader) :**
  - **Pas Dynamique Adaptatif :** La taille de l'intervalle d'échantillonnage (`delta`) est désormais proportionnelle à la longueur réelle du segment de rayon traversant le cube (`rayLength = bounds.y - bounds.x`), au lieu d'être un pas fixe basé sur $1.0$. Cela garantit un nombre maximal de boucles de raymarching constant et optimal, empêchant les boucles de s'éterniser inutilement.
  - **Capping Strict des Boucles :** Réduction de la limite absolue de la boucle de raymarching à 256 itérations au lieu de 512, et interruption immédiate (`if (i >= maxSteps) break;`) dès que la cible de qualité interactive ou statique est atteinte.
  - **Sélection Intelligente de Canal :** Introduction de conditions de compilation (`#if ENABLE_CHANNEL_X`) et de branches d'exécution dynamique basées sur `renderMode` afin d'éviter d'échantillonner des canaux inactifs ou d'effectuer des calculs inutiles pour le mode MIP en mode DVR (et inversement).
  - **Élimination des Fonctions Lourdes :** Évitement de l'appel coûteux à la fonction exponentielle `pow` dans le fragment shader lorsque la valeur gamma du canal est égale à $1.0$.
- **Sommeil Immédiat de la Boucle de Rendu (Idle Loop) :** Correction de la boucle `requestAnimationFrame` qui continuait à tourner en arrière-plan même lorsque le modèle était statique. Le thread graphique s'endort désormais instantanément dès que `_needsRender`, la caméra et le volume ne changent plus, réduisant la charge GPU en veille à 0%.

## [FIXED]
- **Cache-Busting :** Incrément du cache-buster global à `v148` dans `viewer.html`.
