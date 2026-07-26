# Plateforme Web — v1.22.1

> **Installation et mises à jour sur un hébergement dont le magasin de certificats PHP est cassé.**
> Sur certains hébergements mutualisés (constaté à l'ULB), `php.ini` désigne un fichier CA qui
> n'existe pas (`curl.cainfo = /usr/share/php/cacert.pem`). cURL abandonne **avant même d'ouvrir la
> connexion** — « *error setting certificate file* » — et l'installeur conclut à tort que le serveur
> n'a pas d'accès sortant (« Impossible de joindre l'API GitHub »). L'installeur et le panneau
> d'administration réparent désormais eux‑mêmes le magasin de certificats. **La vérification du
> certificat n'est jamais désactivée.**

## [FIXED]

### Installeur — magasin de certificats réparé automatiquement ([install.php](../install.php))
- **Détection** : si `curl.cainfo` ou `openssl.cafile` pointe vers un fichier absent, le magasin par défaut est considéré inutilisable (`ca_ini_broken`).
- **Réparation** : `ca_probe()` cherche un vrai jeu de certificats — `cacert.pem` déposé à côté de `install.php` (échappatoire pour l'opérateur), puis les emplacements standard des distributions (`/etc/ssl/certs/ca-certificates.crt` Debian/Ubuntu, `/etc/pki/tls/certs/ca-bundle.crt` RHEL, `/etc/ssl/ca-bundle.pem` SUSE, `/etc/ssl/cert.pem` Alpine/BSD, FreeBSD), à défaut un `capath`. Le chemin trouvé est passé explicitement à cURL (`CURLOPT_CAINFO`/`CURLOPT_CAPATH`) et au contexte de flux (`cafile`/`capath`).
- **Repli en cascade** : sur une erreur TLS de type « magasin inutilisable » (et **seulement** dans ce cas — une panne réseau reste une panne réseau), l'appel est rejoué avec le bundle détecté, puis via le *stream wrapper* si `allow_url_fopen` est actif (OpenSSL a ses propres chemins par défaut). S'applique à l'appel API GitHub **et** au téléchargement de l'archive (`http_get_small`, `download_tick`).
- **Message d'erreur actionnable** : quand tout échoue, le code d'erreur dédié `tls_ca_broken` remplace « vérifiez la connectivité sortante » et explique quoi faire (téléverser `cacert.pem` depuis `https://curl.se/ca/cacert.pem` à côté de `install.php`, ou faire corriger `curl.cainfo` par l'hébergeur). FR + EN.
- `cacert.pem` est ignoré par le contrôle « le dossier n'est pas vide ».

### Panneau d'administration — mêmes réparations côté hôte PHP ([api/_admin_lib.php](../api/_admin_lib.php), [api/admin.php](../api/admin.php))
- `mkt_fetch_bytes` (catalogue du marketplace, installation de plugins, vérification et application des mises à jour) applique la même détection/réparation (`admin_ca_*`, jumelles des helpers de l'installeur) et rejoue l'appel avec le bundle détecté avant de retomber sur le *stream wrapper*. Sans cela, un hébergement mal configuré affichait un marketplace vide et « aucune mise à jour disponible » sans raison visible.
- **Vérification de mise à jour** (`update_check`) : passe par `mkt_fetch_bytes` au lieu d'un `file_get_contents()` direct — elle fonctionne donc aussi quand `allow_url_fopen` est désactivé (cas fréquent en mutualisé) et bénéficie de la réparation CA.

### Vérifié
- Reproduction fidèle de la panne ULB (`php -d curl.cainfo=/usr/share/php/cacert.pem -d allow_url_fopen=0`) : cURL brut échoue avec l'erreur exacte de la capture, le client corrigé récupère et lit la release GitHub (HTTP 200) via le bundle détecté. Sans aucun bundle disponible, l'installeur affiche bien `tls_ca_broken` au lieu d'un faux diagnostic réseau.
