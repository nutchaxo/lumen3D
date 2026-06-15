# Outil de Preprocessing v0.11.5 — 2026-06-08

## [FIXED] Nettoyage automatique des briques obsolètes
- **Changement** : Ajout d'une étape de nettoyage automatique du sous-dossier `bricks/` dans `run_preprocess.py` avant de démarrer un nouveau traitement sur un dataset existant.
- **Bénéfice** : Évite de conserver d'anciens fichiers packs obsolètes sur le disque lorsque la limite de chunks par pack (`CHUNKS_PER_PACK`) ou les paramètres de découpage changent entre deux exécutions successives.
