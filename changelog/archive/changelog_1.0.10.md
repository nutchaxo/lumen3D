# Plateforme Web — v1.0.10

## [FIXED]
- **ELE-09 (SEC-011)** — `dev_server.py` : blocage du service statique du répertoire serveur `api/` (qui contient `config.json` = hash du mot de passe admin). Auparavant, `GET /api/config.json` tombait dans le service de fichiers statiques et exfiltrait le secret d'authentification. Nouvelle garde `_is_forbidden_static()` (chemin normalisé : traversée, casse, backslash) renvoyant 404 ; les deux routes API réelles restent dispatchées avant la garde.
- Test : `tests/test_dev_server_static_guard.py`.
