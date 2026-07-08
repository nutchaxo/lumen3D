# Changelog 0.12.13 (Plateforme Web)

## [FIXED]
- **Correction des textures striées (Race Condition GPU) :** Suppression de l'appel à `bmp.close()` dans `brick-decode-worker.js`. La fermeture immédiate de l'ImageBitmap côté CPU détruisait la ressource de texture avant que le GPU n'ait fini d'exécuter la commande asynchrone `ctx.drawImage`, provoquant un rendu corrompu et strié dans les navigateurs Chromium.
- **Réinitialisation du Contexte Canvas :** Ajout de `ctx.clearRect` lors de la réutilisation de la même instance globale de `OffscreenCanvas` pour s'assurer qu'aucun résidu de pixel de la brique précédente ne persiste.
- **Nettoyage de viewer.html :** Réécriture propre et complète de `viewer.html` pour éliminer les fusions de scripts dupliqués et les balises HTML en double issues des précédentes modifications.
