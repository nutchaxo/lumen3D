# Plateforme Web — v1.0.19

## [FIXED]
Durcissement concurrence de `js/core/brick-loader.js` — trois findings RACE qui éditent les **mêmes lignes** (déclarations d'état, `init()`, `_cacheKey`) et sont donc livrés ensemble :

- **ELE-12 (RACE-003)** — Ajout d'un **token de génération** (`_generation`, incrémenté à chaque `init()`). `loadBrickTasks` capture la génération courante et abandonne ses résultats si un switch de dataset survient pendant un fetch (garde dans la boucle worker + garde avant l'écriture du cache). `init()` appelle désormais `cancelPending()` avant de muter l'état partagé. Empêche un chargement tardif d'un ancien dataset de peupler le cache du nouveau.
- **ELE-13 (RACE-004)** — `_cacheKey` préfixée par le tag de dataset (`_datasetTag`) → plus de collision dans le cache LRU partagé entre datasets (le délimiteur `|` préserve `key.split(':').pop()`).
- **ELE-17 (RACE-031)** — Le fetch de pack partagé est lié à un `AbortController` **propre au loader** (`_packFetchController`, durée de vie = pack cache, aborté uniquement à `init()`/`clearCache`) ; chaque appelant honore son propre signal via `_awaitWithSignal` (course sans empoisonner le fetch partagé). Un load périmé qui s'annule n'avorte plus les bricks du load courant.
- Test : `tests/js/test_brick_loader_concurrency.mjs` (génération périmée ignorée, clé par-dataset, isolation d'abort).
