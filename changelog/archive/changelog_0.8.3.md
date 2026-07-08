# Changelog 0.8.3

[FIXED]
- Panneau Admin & Plateforme : Suppression des erreurs "404 Not Found" dans la console liées à la recherche préventive (auto-detect) de manifestes pour les briques 3D (`bricks/manifest.json`) et l'affichage 2D (`tiles2d/manifest.json`). Le lecteur utilise désormais exclusivement le fichier de catalogue centralisé en tant que source de vérité (avec ajout de la propriété booléenne `hasBricks` dans l'API).
- Visualisation 3D : L'erreur JS fatale déclenchée en cas de chargement partiel du volume (quand un fichier TIFF/WebP est manquant) a été transformée en avertissement (Warning) pour permettre le rendu des tranches ("slices") valides plutôt que de bloquer l'affichage. Les très nombreux logs "Failed to load slice" individuels ont été mis sous silence.
- Cache : Le script `viewer.html` référence désormais les versions corrigées de `viewer.js` et `volume-viewer.js` afin d'outrepasser les caches persistants du navigateur.
