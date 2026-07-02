# Plateforme Web v0.8.13 — 2026-06-08

## [ADDED] Rendu Progressif Ultra-Fluide par Briques (WebGL2 texSubImage3D)
- **Mises à jour GPU partielles** : Remplacement des ré-uploads complets de textures 3D (qui bloquaient le thread d'affichage pour les volumes géants) par l'utilisation de `gl.texSubImage3D` et des configurations de stockage de pixels WebGL2 (`gl.UNPACK_ROW_LENGTH` et offsets).
- **Affichage dynamique** : Les briques s'affichent "au fur et à mesure" dès leur téléchargement, avec un coût de téléversement GPU inférieur à 0.1ms par brique, garantissant une fluidité parfaite pendant toute la phase de streaming.

## [ADDED] Raymarching Dynamique (Interaction 60 FPS)
- **Réduction de charge en mouvement** : Pendant que l'utilisateur manipule l'embryon (clic et glisser), le nombre d'étapes de Raymarching est automatiquement réduit à 35 pour soulager la carte graphique et maintenir 60 FPS, même à la résolution *Native*.
- **Restauration automatique** : Dès que l'interaction s'arrête, la qualité maximale (150 étapes) est instantanément réappliquée pour fournir un rendu final d'une netteté absolue.

## [OPTIMIZED] Suppression du Freeze Initial (Bypass Seeding CPU)
- **Suppression du loop CPU** : Retrait de l'interpolation tridimensionnelle JS de seeding (`_seedTexturesFromActive`) qui exécutait plus de 268 millions d'itérations bloquantes pour le volume natif.
- **Allocation anticipée** : Appel explicite à `renderer.initTexture` dès la création des textures pour allouer l'espace GPU à l'avance sans interrompre le premier rendu.
