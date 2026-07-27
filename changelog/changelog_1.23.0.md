# Plateforme Web — v1.23.0

> **Les fichiers créés par la plateforme restent modifiables par leur propriétaire.** Sur un
> hébergement où PHP tourne sous un utilisateur système différent du compte FTP/SFTP (`www-data`,
> `apache`, pool php-fpm mutualisé), tout ce que l'installeur et le panneau créaient appartenait à
> PHP en `0755`/`0644` : l'opérateur ne pouvait plus ni téléverser dans ces dossiers ni y supprimer
> quoi que ce soit — sous POSIX, le droit de supprimer un fichier vient de son **dossier parent**, pas
> du fichier. Un `DATA_WEB/fixed/` fraîchement installé était donc « intouchable » en SFTP.
> Le décalage est maintenant **détecté** et les modes adaptés en conséquence. **À aucun moment la
> vérification n'est désactivée côté sécurité : les secrets `api/*.json` gardent `0600`.**

## [ADDED]

### Détection du décalage de propriétaire (installeur + hôte PHP + serveur Python)
- Nouveaux jumeaux `perms_owner_split` / `dir_mode` / `file_mode` / `make_dir` ([install.php](../install.php)), `admin_*` ([api/_admin_lib.php](../api/_admin_lib.php)) et `_perms_owner_split` / `_dir_mode` / `_file_mode` / `_make_dir` ([dev_server.py](../dev_server.py)).
- **Référence de comparaison** : l'installeur compare le propriétaire de `install.php` (téléversé par le compte FTP, donc c'est lui) à l'utilisateur effectif de PHP ; le runtime compare celui de la racine web. Sans `ext-posix`, une sonde (fichier créé par PHP vs fichier téléversé) donne le même verdict.
- **Modes appliqués** : décalage détecté → `0777` / `0666` pour que le propriétaire garde la main ; hôte correctement configuré (suEXEC, pool dédié) → `0755` / `0644` comme avant, rien ne change. Réglage forcé possible via `LUMEN_DIR_MODE` / `LUMEN_FILE_MODE`.
- `mkdir()` appliquant l'umask du processus (022 en général, ce qui retirait silencieusement le bit d'écriture), le mode est désormais posé **explicitement après coup, sur chaque niveau créé**.

### Réparation depuis le panneau d'administration ([js/pages/admin/tab-security.js](../js/pages/admin/tab-security.js))
- Nouvelle carte **« Permissions des fichiers »** dans l'onglet Sécurité : elle affiche l'utilisateur PHP, le propriétaire du site et les modes en vigueur, et propose **« Réparer les permissions »** — utile pour une installation créée avant cette version.
- Nouvelles actions d'API `permissions_status` (lecture) et `repair_permissions` (POST + CSRF + session, comme toute action d'écriture), implémentées **des deux côtés** : `api/admin.php` + `dev_server.py`. Le parcours ignore les liens symboliques, ne sort jamais de la racine web et préserve les secrets `api/*.json`.
- Traductions FR / EN / ES ajoutées (parité de clés vérifiée : 228 clés `admin` dans les trois fichiers).

### Diagnostic dans l'installeur ([install.php](../install.php))
- Ligne de prérequis **« Permissions des fichiers créés »** affichant les modes retenus, avec l'explication quand le décalage de propriétaire est détecté.
- Passe finale `apply_tree_modes()` à l'étape *Terminé* : filet de sécurité sur toute l'arborescence extraite, pour qu'un chemin d'écriture ajouté plus tard ne puisse pas enfermer l'opérateur hors de son propre site.

### Le panneau dit POURQUOI GitHub est injoignable ([api/_admin_lib.php](../api/_admin_lib.php), [api/admin.php](../api/admin.php), [dev_server.py](../dev_server.py), [js/pages/admin/tab-updates.js](../js/pages/admin/tab-updates.js))
- L'onglet **Mises à jour** affichait « Impossible de contacter GitHub — `unreachable` », un mot qui recouvrait trois causes très différentes : quota d'API atteint, magasin de certificats cassé, ou vraie panne réseau. `mkt_fetch_bytes` mémorise désormais le motif exact (statut HTTP, message cURL, en-têtes) et `mkt_error_payload()` le traduit en code + détail.
- **Quota GitHub reconnu** : l'API non authentifiée autorise **60 requêtes/heure et par IP** — un campus entier derrière un même NAT l'épuise vite. Les en-têtes `x-ratelimit-*` / `retry-after` sont lus et le panneau affiche « Limite de l'API GitHub atteinte, réessayez dans N minutes » au lieu d'une fausse panne. Même détection côté serveur Python (HTTP 403/429).
- **Priorité des diagnostics** : un statut HTTP reçu prime sur l'erreur TLS de la tentative cURL — sans quoi, sur un hôte au `curl.cainfo` cassé mais dont le repli par flux fonctionne, un simple 404 ou un quota dépassé était rapporté comme un problème de certificat. Vérifié sur les trois scénarios (404, DNS mort, magasin CA inutilisable, avec et sans `allow_url_fopen`).
- Le catalogue du marketplace remonte lui aussi le motif au lieu d'un `catalog_fetch_failed` nu.

## [FIXED]

- Tous les points d'écriture passent par les helpers : extraction de la release, `api/.htaccess`, `DATA_WEB/{fixed,live,tracking}` et `catalog.json` (installeur) ; `admin_write_json`, installation/désinstallation de plugins du marketplace, extraction et recopie de mise à jour, y compris la finalisation différée des fichiers `*.lumen-new` ([api/_admin_lib.php](../api/_admin_lib.php)) ; `config/*.json` + `theme.css` ([api/site.php](../api/site.php)) ; téléversements de la médiathèque ([api/media.php](../api/media.php)) ; `metadata.json` / `catalog.json` des jeux de données ([api/datasets.php](../api/datasets.php), [dev_server.py](../dev_server.py)).
- L'extraction d'un zip de plugin ignorant les modes demandés, `mkt_modes_recursive()` les réapplique après le `rename()` final.

> **À savoir (compromis assumé)** : rendre un fichier modifiable par un compte *différent* de celui de
> PHP signifie, sous POSIX, le rendre inscriptible pour « autres » — il n'existe pas de moyen pour PHP
> de changer le propriétaire ou le groupe (`chown`/`chgrp` demandent root). Sur un hébergement
> mutualisé avec d'autres locataires sur la même machine, c'est un élargissement réel de la surface
> d'attaque. C'est pourquoi ces modes ne sont appliqués **que** lorsque le décalage est constaté —
> c'est-à-dire uniquement là où l'opérateur ne pourrait autrement pas administrer son propre site — et
> qu'ils restent forçables à `0755`/`0644` par variable d'environnement. Le vrai correctif reste de
> faire tourner PHP sous le compte du site (suEXEC / pool php-fpm dédié).

### Vérifié
- Résolution des modes et des surcharges d'environnement identique côté PHP et Python (défauts `0755`/`0644`, surcharge valide acceptée, surcharge invalide ignorée), détection des secrets, création récursive de dossiers, parcours d'arborescence borné.
- `permissions_status` correctement routée et refusée sans session (`401 Not authenticated`) sur le serveur Python.
- `dev_server.py --check` OK ; lint PHP OK sur les cinq fichiers modifiés ; parité des clés de traduction FR/EN/ES.
- *Non vérifiable sur cette machine* : l'application effective des modes POSIX (Windows n'a pas de bits de permission Unix). Les chemins POSIX sont neutralisés par construction sous Windows.
