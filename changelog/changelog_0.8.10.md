# Plateforme Web v0.8.10 — 2026-06-08

## [OPTIMIZED] Catalogue dynamique à la volée
- **Changement** : Remplacement de l'index statique `catalog.json` global par une génération dynamique effectuée directement par `dev_server.py`. Le serveur scanne désormais les répertoires `fixed/`, `live/`, et `tracking/` sous `DATA_WEB` et agrège les métadonnées `metadata.json` locales pour éviter tout risque de corruption ou de désynchronisation.
- **Optimisation de cache** : Les fichiers JSON, JSONL et scripts JS sont servis avec des en-têtes de cache désactivés (`no-store, no-cache`) pour garantir que les nouveaux datasets apparaissent immédiatement sans rechargement forcé.

## [FIXED] Résolution de bugs de requêtes
- **Correction** : Interception robuste des appels d'URI `/DATA_WEB/catalog.json` avec paramètres de requête (query string) pour le rafraîchissement d'index.
