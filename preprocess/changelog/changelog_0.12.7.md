# Changelog 0.12.7 (Plateforme Web)

## [OPTIMIZED]
- **Worker Pool Architecture:** Remplacement du Web Worker unique de décodage par un *Worker Pool* (jusqu'à 8 threads concurrents selon les cœurs CPU) via `brick-decode-worker.js`. 
- **Parallélisation du WebP :** Les 8192 chunks de la résolution 1024 (qui prenaient ~60 secondes à être décodés séquentiellement) sont désormais distribués dynamiquement sur tous les cœurs du processeur, divisant le temps de chargement par ~8.
- **Optimisation du Cache Réseau :** Les requêtes `fetch` des paquets binaires (Packs) ont été rapatriées sur le Main Thread pour garantir un seul téléchargement par paquet (via `_packCache`), évitant que plusieurs Workers ne téléchargent le même fichier simultanément. Seule la charge CPU (le décodage) est transférée au Worker Pool.

## [FIXED]
- **Résolution des lenteurs de Streaming :** Confirmation via logs que le goulet d'étranglement n'était pas le bus GPU (`texSubImage3D` s'exécutant en 0.1ms) mais la queue d'événements du Worker unique. Le problème de chargement extrêmement lent des LODs supérieurs est résolu.
