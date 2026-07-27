# Plateforme Web — v1.22.2

> **Diagnostic du magasin de certificats dans l'installeur.** Suite de la v1.22.1 : sur un hébergement
> où `php.ini` désigne un fichier CA absent **et** où aucun magasin système n'est lisible depuis PHP
> (typiquement un `open_basedir` qui masque `/etc/ssl`), la réparation automatique n'a rien à se mettre
> sous la dent. L'installeur affichait alors un laconique `network` — le vrai diagnostic était perdu
> dans le repli vers le *stream wrapper*. Il dit désormais ce qui bloque et comment le débloquer.

## [FIXED]

### La cause TLS n'est plus masquée par le repli ([install.php](../install.php))
- `http_get_small` conserve l'erreur cURL de type « magasin de certificats inutilisable » quand le repli *stream wrapper* échoue à son tour (son erreur générique `network` écrasait le diagnostic). L'écran de prérequis affiche donc `tls_ca_broken` et son message actionnable — au lieu d'envoyer l'opérateur chercher un pare-feu qui n'a rien à se reprocher.

## [ADDED]

### Ligne de prérequis « Certificats CA » ([install.php](../install.php))
- Nouvelle ligne de diagnostic dans la liste de vérification, **non bloquante** par construction (OpenSSL peut détenir un magasin par défaut invisible depuis PHP, et `open_basedir` fausse `is_readable()`) :
  - ✓ + `php.ini` — la configuration de l'hôte est saine ;
  - ✓ + chemin du bundle — `php.ini` est cassé mais un magasin utilisable a été trouvé (c'est la réparation v1.22.1 qui opère) ;
  - ? + indice — rien de trouvé : l'indice indique de téléverser `cacert.pem` (https://curl.se/ca/cacert.pem) à côté de `install.php`.
- Les indices de prérequis peuvent désormais s'afficher aussi sur un état « inconnu » (`hintAlways`), pas seulement sur un échec franc.

> **Note d'exploitation** : `cacert.pem` déposé à la racine web sert aussi **après** l'installation — `api/_admin_lib.php` le cherche au même endroit (`admin_ca_probe`) pour le catalogue de plugins et les mises à jour. Le conserver sur ces hébergements.

### Documentation ([README.md](../README.md))
- Nouvelle section d'installation **« Deploy on a Shared PHP Host (`install.php`) »** (Quick Start §2, les suivantes sont renumérotées) : déroulé du wizard, puis un encart de dépannage complet du faux diagnostic « Cannot reach the GitHub API » — symptôme exact, cause (`curl.cainfo` cassé, `open_basedir` masquant `/etc/ssl`), réparation automatique v1.22.1, marche à suivre manuelle (`cacert.pem` à la racine web), et l'avertissement de **conserver le fichier après l'installation** pour le marketplace et les mises à jour.

### Vérifié
- Hôte simulé sans aucun magasin (`php -d curl.cainfo=/usr/share/php/cacert.pem`, avec et sans `allow_url_fopen`) : l'installeur remonte `tls_ca_broken` et la ligne « Certificats CA » passe en « inconnu + indice ».
- Le même hôte avec `cacert.pem` déposé : ligne ✓ (chemin affiché) et lecture réussie de la release GitHub v1.22.1 **avec `allow_url_fopen=0`**, donc purement via le cURL réparé.
