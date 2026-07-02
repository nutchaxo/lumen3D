# Changelog Plateforme Web - v1.0.3

### [FIXED]
- **Viewer** : Le bouton de l'outil `orientation-axes` dans la barre d'outils s'allume (reste enfoncé) correctement lorsqu'il est actif.
- **Viewer** : Le toggle du plugin force désormais un rafraîchissement immédiat (`requestRender`) de la scène 3D sans avoir besoin de manipuler l'embryon.
- **Viewer** : Ajout d'une sphère de déplacement visible au centre du triple axe au survol (hover) pour indiquer que l'on peut drag-and-drop.
- **Viewer** : Pendant le déplacement interactif du triple axe, la rotation principale de l'embryon est maintenant désactivée (bloquée) pour éviter des mouvements conflictuels.
