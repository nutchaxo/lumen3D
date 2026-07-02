# Plateforme Web — v1.0.7

## [FIXED]
- **CRIT-02 (SEC-001)** — `dev_server.py` : path traversal en **écriture**. Le paramètre `id` (`<type>/<folder>`) était utilisé sans validation pour construire des chemins disque dans `_save_dataset` et `save_thumbnail`, permettant l'écriture de `metadata.json` et de bytes base64 arbitraires **hors périmètre**. Ajout d'un validateur `_safe_dataset_dir()` (type ∈ {`fixed`,`live`,`tracking`}, folder = composant de chemin unique et sûr `^[A-Za-z0-9_][A-Za-z0-9._-]*$`, et confinement du chemin résolu sous `DATA_WEB/<type>`) appliqué aux deux chemins d'écriture. Extraction de `_save_thumbnail_bytes()` pour testabilité.
- Test : `tests/test_dev_server_paths.py` (rejet des traversées, écritures valides confinées).
