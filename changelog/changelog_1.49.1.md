# Changelog v1.49.1 (Plateforme Web)

## [FIXED]
* **Une photographie whole-mount restait sur « Chargement… » avec `ReferenceError: getPhysicalCalibration is not defined`.** Dans la 1.49.0, la réécriture de l'aplatissement du fond dans `js/viewers/wholemount-viewer.js` a supprimé par erreur les dix fonctions qui suivaient (placement des étiquettes, calibration physique, isolation du marquage). Le fichier restait syntaxiquement valide, mais l'objet exporté par le module référençait une fonction absente : le visualiseur ne se construisait pas et la page ne démarrait jamais. Les fonctions sont restaurées à l'identique de la 1.48.1.

  Garde-fou ajouté : `tests/js/test_iife_exports.mjs` évalue les singletons sans dépendance DOM (visualiseur whole-mount, magasin de mesures, résolveur de compatibilité) dans une machine virtuelle Node et vérifie que chaque export résout vers une fonction, ce que `node --check` ne fait pas.
