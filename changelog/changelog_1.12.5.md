# Plateforme Web — v1.12.5

> **Correctifs d'installation sur hébergement PHP mutualisé en sous-dossier.** Trois problèmes remontés
> d'un vrai test (`/tools/webplatform/` sur un hébergeur PHP) : pages « Not found », fichiers Python/Windows
> déballés inutilement, et sélecteur de plugins absent. La plateforme fonctionne désormais aussi bien à la
> racine du domaine qu'installée dans un sous-dossier.

## [FIXED]
- **Pages « Not found » quand la plateforme est installée dans un sous-dossier** ([_serve.php](../_serve.php), [router.php](../router.php), [api/_html_server.php](../api/_html_server.php)) — `_serve.php` passait à `lumen_serve_html` le **chemin complet** de la requête (`/tools/webplatform/index.html`), ce qui faisait chercher `<sous-dossier>/<sous-dossier>/index.html` → 404 sur toutes les pages. Nouveau résolveur **pur et testé** `lumen_request_rel($_SERVER, $appDir)` qui retire le préfixe du sous-dossier (via `dirname(SCRIPT_NAME)`, avec repli `DOCUMENT_ROOT`↔dossier d'app) avant de résoudre. `_serve.php` et `router.php` l'utilisent. La plateforme marche maintenant à la racine **ou** dans n'importe quel sous-dossier.
- **Fichiers Python/Windows déballés sur un hôte PHP** ([install.php](../install.php)) — l'archive de release est universelle (Python + PHP) ; l'installateur (qui ne tourne que sur PHP) **n'extrait plus** `dev_server.py`, `fast_server.py`, `ed25519_pure.py` ni `start.bat` (inutilisables sur PHP + exposition de source serveur). Il conserve `router.php`/`_serve.php`/`.htaccess`/`api/`/`LICENCE` et tous les assets web. Nouveau garde `is_php_host_skip()`.
- **Sélecteur de plugins vide sur hébergement mutualisé** ([api/_admin_lib.php](../api/_admin_lib.php)) — `mkt_fetch_bytes` n'utilisait que `file_get_contents(url)` (nécessite `allow_url_fopen`, souvent **désactivé** en mutualisé). Désormais **cURL en priorité** (comme `install.php`), repli sur le wrapper de flux, cap mémoire via `CURLOPT_WRITEFUNCTION`. Le catalogue signé se charge donc sur les hôtes où seul cURL est disponible. (Le sélecteur de plugins vit dans l'assistant du panneau admin — il n'apparaissait pas tant que les pages HTML renvoyaient « Not found ».)

## [ADDED]
- **Tests pérennes de service en sous-dossier** ([tests/test_serve_subdir.php](../tests/test_serve_subdir.php)) — `lumen_request_rel` (racine, sous-dossier `/tools/webplatform/`, `SCRIPT_NAME` = html ou `_serve.php`, repli `DOCUMENT_ROOT`, requête avec query, garde traversal) + un rendu complet `lumen_serve_html` à travers un sous-dossier simulé (injection du nonce, `{{SITE}}` résolu).

[Versioning] Plateforme Web → v1.12.5. changelog_1.12.5.md généré.
