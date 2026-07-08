# Plateforme Web — v1.0.51

## [OPTIMIZED]
- **DEAD-003 / DEAD-039** — suppression de `js/core/brick-fetch-worker.js` (162 lignes). Le worker était **entièrement mort** : jamais instancié (`grep` : aucun `new Worker(...brick-fetch-worker...)` nulle part), ses fonctions/transports gzip/raw inatteignables (`_decompressGzipResponse` jamais appelée). Le vrai chemin de fetch est main-thread (`BrickLoader._fetchPackBuffer` télécharge le pack `.bin` entier) puis décodage WebP dans le pool de decode-workers. Conserver ce worker à demi-câblé violait la règle 1.1 (pas de chemin factice dans le pipeline de streaming). `dev_server.py` n'est pas touché (son import `re` est bien utilisé).
- Mise à jour des références doc : `CLAUDE.md` §1.2 et table §2.3 ne listent plus le worker supprimé (le lien pointait vers un fichier inexistant) ; `brick-loader.js` est décrit comme fetchant les packs entiers et déléguant au pool de decode-workers.

## [TESTS]
- `tests/js/test_brick_size_64.mjs` — retrait du bloc d'assertions structurelles qui lisait `brick-fetch-worker.js` (les replis blank-brick `|| 64`) ; les assertions côté `brick-loader.js` (constante `BRICK_SIZE = 64`, estimation cache) sont conservées.
