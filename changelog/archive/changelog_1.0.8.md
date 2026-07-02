# Plateforme Web — v1.0.8

## [FIXED]
- **CRIT-03 (SEC-002)** — `dev_server.py` : path traversal en **lecture**. `_get_dataset` construisait le chemin de `metadata.json` à partir du paramètre `id` sans validation. Application du validateur `_safe_dataset_dir()` (introduit en v1.0.7) au chemin de lecture, fermant la classe de vulnérabilité path-traversal de l'API admin (lecture + écriture).
- Test : `tests/test_dev_server_paths.py::TestReadGuard` (lecture valide confinée, rejet des traversées).
