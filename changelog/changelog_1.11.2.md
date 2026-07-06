# Plateforme Web — v1.11.2

> **Correctif critique — écritures admin `/api/site.php` (serveur Python).** Toutes les
> sauvegardes du panneau admin (thème, identité, pages, mentions légales) renvoyaient **405 Method
> Not Allowed** sur le serveur `dev_server.py` : la route `/api/site.php` avait été ajoutée au
> dispatch **GET** en v1.8.0 mais **pas au dispatch POST** (le `replace_all` d'origine ne ciblait que
> la variante GET). Détecté par un test end-to-end en navigateur, connecté. L'hôte **PHP** n'était
> **pas** affecté (`api/site.php` est routé directement par le serveur web, indépendamment de la méthode).

## [FIXED]
- **`POST /api/site.php` — route manquante dans `do_POST`** ([dev_server.py](../dev_server.py)) — `/api/site.php` ajouté au tuple de routes de `do_POST` (il n'était que dans `do_GET`). Sans ce correctif, `save`/`reset`/`publish` de tout document de config (`instance`/`theme`/`legal`/`pages/<slug>`) échouaient en 405 côté `dev_server.py`, rendant les onglets Apparence / Identité / Pages / Mentions légales incapables d'enregistrer. Les tests unitaires de v1.8.0 appelaient les fonctions directement (hors HTTP) et ne couvraient donc pas le routage — désormais validé de bout en bout en navigateur (login → save Identité multilingue → save Thème + régénération `theme.css` → publication d'une page par blocs → install marketplace, tous OK).

## Notes
- **Vérification end-to-end (instance isolée, navigateur connecté)** : sauvegarde Identité (`brand.name` + `specimen` par locale fusionné correctement), sauvegarde Thème (override `--color-primary` + rampe dérivée hover/dark/subtle écrite dans `config/theme.css`), constructeur de pages (ajout de bloc + publication → `config/pages/home.json`), et **installation marketplace via l'UI** (téléchargement + vérif signature + extraction + approbation → carte passe à « Désinstaller »). Aucune erreur.
- L'hôte PHP restait fonctionnel (routage direct du fichier `.php`) ; ce correctif concerne uniquement le serveur de développement Python.

[Versioning] Plateforme Web → v1.11.2. changelog_1.11.2.md généré.
