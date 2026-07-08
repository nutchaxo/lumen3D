# Plateforme Web — v1.0.15

## [FIXED]
- **ELE-05 (SEC-007)** — Protection **CSRF** de l'API admin (`dev_server.py` + `admpan.js`). Les actions d'écriture (`save`, `save_thumbnail`, `rebuild_catalog`) ne reposaient que sur le cookie d'auth, et `rebuild_catalog` était déclenchable en **GET** (CSRF via simple lien, le cookie `SameSite=Lax` étant envoyé sur navigation top-level). Désormais : jeton CSRF par session (renvoyé au `login` et au `status`), et exigence **POST + en-tête `X-CSRF-Token`** correspondant à la session pour toute écriture (`_authorize_write`). `admpan.js` transmet le jeton automatiquement via `apiFetch`. Rétro-compatible avec l'hébergement PHP (l'en-tête n'est émis que si le serveur a fourni un jeton).
- Test : `tests/test_dev_server_csrf.py` (`_is_write_action`, `_check_csrf`, `_authorize_write` : POST requis, jeton requis/correct).
