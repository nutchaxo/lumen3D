# Changelog 0.12.19 (Plateforme Web)

## [OPTIMIZED]
- **Throttling et Batching du Rendu pendant le Chargement (Streaming GPU) :** Correction d'un problème majeur où la plateforme redessinait le volume 3D à 60 FPS sur le thread principal pour chaque brique chargée individuellement (ce qui signifiait des milliers de rendus 3D redondants pour les 3 697 briques du volume). J'ai activé la fonction `markTextureDirty` pour qu'elle utilise correctement les constantes de batching préconfigurées `BRICK_TEXTURE_UPDATE_MS` (ex: 650ms pour le 1024x1024) et `BRICK_TEXTURE_UPDATE_OPS` (ex: 16 briques). Le volume 3D n'est maintenant redessiné que par lots, et un rendu final haute qualité est déclenché à la fin. Cela réduit le nombre total de frames dessinées de 3697 à moins de 150 lors de la phase de chargement, ce qui supprime totalement la saturation GPU à 100% lors du streaming.

## [FIXED]
- **Cache-Busting :** Incrément du cache-buster global à `v142` dans `viewer.html` pour invalider le cache des navigateurs.
