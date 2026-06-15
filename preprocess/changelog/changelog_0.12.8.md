# Changelog v0.12.8

## Plateforme Web

### [FIXED]
- **Unpacking Grid 3D** : Restauration de l'algorithme d'unpacking `grid` (atlas cols x rows) au sein de `brick-decode-worker.js`. Le Worker Pool traitait par défaut toutes les images WebP comme un empilement vertical natif, causant un affichage totalement brouillé/strié sur les datasets récents packagés en mode grille.
- **Starvation du Main Thread (Lag / Freeze)** : 
  1. Implémentation d'une `Promise Queue` séquentielle à l'intérieur de chaque Web Worker. Auparavant, les workers recevaient toutes les instructions `DECODE` du `Promise.allSettled(batch)` en même temps, forçant la création concurrente de multiples `OffscreenCanvas` et `createImageBitmap` qui saturaient la mémoire et la bande passante du GPU.
  2. Réduction du nombre maximal de workers à `Math.max(1, Math.min(4, cores - 1))`. Plafonner à 4 workers (et garantir la libération d'un coeur minimum pour le navigateur) empêche le navigateur d'être asphixié (Thread Starvation) lors de très lourds transferts de briques 3D. Le thread principal garde ainsi sa fluidité pendant que les briques se chargent et se dessinent progressivement.

Ces deux correctifs critiques permettent de rétablir la fidélité géométrique des modèles tout en libérant le navigateur de la charge démentielle qu'imposait le pool de workers.
