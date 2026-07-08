# Plateforme Web v0.8.9 — 2026-06-08

## [FIXED] Suppression des chemins d'accès absolus pointant vers le disque Z:\
- **Correction** : Élimination de toutes les références absolues vers le disque `Z:\` pour éviter les erreurs d'exécution lorsque le disque réseau n'est pas monté.
- **Fichiers modifiés** :
  - `preprocess/convert_ims_batch.py` : Le chemin par défaut de `SOURCE_DIR` pointe désormais de manière relative vers le dossier `DATA` du projet.
  - `DOCS/perf_baseline.md` : Les liens pointant vers des rapports JSON absolus sur `Z:\` ont été modifiés en chemins relatifs au workspace du projet.
