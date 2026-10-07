# 18. Héberger, mettre à jour, publier une version

::: chapter-intro
- Lumen3D se sert depuis **trois sortes de serveurs** (Python, PHP, ou simples fichiers). Ce chapitre dit ce que chacun sait faire, comment il répond au navigateur et pourquoi les pages restent rapides.
- Une **mise à jour** est un colis **signé** : la plateforme refuse tout ce qu'elle ne peut pas prouver authentique, puis bascule en gardant un chemin de retour (sur Python).
- Chaque version est **testée en entier** (201 fichiers de tests), signée, puis publiée d'un coup. La plateforme marche **sans Internet**.
:::

Ce chapitre s'adresse à la personne qui **installe et entretient** le site : l'administrateur, ou la personne du service informatique qui l'aide. Les chapitres 9 à 12 expliquent ce que voit le visiteur ; celui-ci explique **la machine derrière**.

Rien ici n'oblige à écrire du code. Mais comprendre ces mécanismes permet de **diagnostiquer** un site lent, une mise à jour refusée ou un hébergeur capricieux.

::: note
Les numéros de version cités sont ceux de ce document : plateforme web **1.59.3**, pipeline **0.21.0**, format de données **4**. Le panneau d'administration en bref est au chapitre 14 ; la sécurité en général au chapitre 19.
:::

## 18.1 Trois façons de servir Lumen3D

Le navigateur parle toujours le même langage (HTTP). Ce qui change, c'est **le programme qui répond** de l'autre côté. Il en existe trois familles.

![Ce que sait faire chaque façon de servir : de la plus complète à la plus simple.](img/ch18/trois-serveurs.svg){width=100%}

::: analogy
**Un guichet de bibliothèque.** Le guichet complet (Python ou PHP) vérifie votre carte, cherche le livre, tient le registre des prêts. Un simple rayonnage en libre-service (hôte statique) vous laisse prendre un livre, mais ne tient aucun registre et ne vérifie personne.
:::

- **`dev_server.py`** : le serveur Python. Il fait **tout** (pages, catalogue, administration, import, mise à jour). C'est le serveur recommandé.
- **`fast_server.py`** : le même serveur, en **lecture seule**. Il répond comme `dev_server.py` à un visiteur, mais **toute route d'administration est refusée** (404). Il sert à mesurer les performances.
- **PHP** (dossier `api/`, `router.php`, `_serve.php`, `.htaccess`) : pour les hébergements d'université qui offrent PHP mais pas Python. Mêmes fonctions, mêmes fichiers, même mot de passe.
- **Hôte « fichiers seulement »** : possible pour regarder, mais sans administration, sans catalogue généré et sans la protection à « nonce » du chapitre 19.

### Lequel choisir ?

![L'arbre de décision d'un hébergement.](img/ch18/hebergement.svg){width=100%}

::: example
**Un laboratoire avec un poste dédié.** Il lance `python dev_server.py --dev-trust-local` : une seule commande, rien à installer, mise à jour avec retour arrière. **Une université qui ne propose que PHP** : elle dépose `install.php` (§18.14) ; Apache lit le fichier `.htaccess` fourni, qui aiguille les pages vers `_serve.php`.
:::

::: tech
**Options de `dev_server.py`** : `--host` (défaut `localhost`), `--port` (défaut `8080`), `--set-password` (changer le mot de passe administrateur en ligne de commande), `--check` (valider une installation sans ouvrir de port, §18.10), `--root` (installation à contrôler), `--dev-trust-local` (faire confiance aux plugins locaux ; **réservé au poste de développement**), `--trusted-proxy` (§18.6), `--migrate-types`, `--verbose` (journaliser chaque requête). Par défaut aucune requête n'est écrite dans la console : une écriture synchrone par requête ralentirait les réponses.

**Versions minimales** : Python 3.10 (le README l'indique) ; PHP 8.1, version testée par l'intégration continue avec les extensions `zip`, `mbstring`, `sodium` et `gd`. L'installeur `install.php` n'exige, lui, que PHP 7.4 pour démarrer.
:::

## 18.2 Le trajet d'une requête

Un visiteur demande une adresse. Le serveur Python range cette demande dans **une des six catégories** ci-dessous, dans cet ordre. Dès que l'une convient, il s'arrête.

![Les six destinations d'une requête GET sur le serveur Python.](img/ch18/chemin-requete.svg){width=92%}

- Le **catalogue** et les **sondes** sont des réponses fabriquées, jamais des fichiers.
- Les chemins **interdits** reçoivent un 404, **même si le fichier existe** : on ne confirme pas qu'il est là.
- Les pages `.html` passent par un traitement à part : un code secret neuf (le « nonce ») est inséré dans chaque page à chaque chargement (chapitre 19).
- Tout le reste est un **fichier statique** : briques, scripts, images.

### Le catalogue n'est pas un fichier

L'adresse `DATA_WEB/catalog.json` **n'existe pas sur le disque**. Le serveur la fabrique à la demande en lisant les fiches `metadata.json` de chaque dossier de `DATA_WEB/3d`, `2d` et `live`.

- Sont listés les jeux **configurés ou dotés d'une vignette**, et **non masqués**.
- Tri par date décroissante ; un jeu sans date passe **en dernier**.
- Résultat mémorisé, avec une empreinte (ETag) ; la liste n'est recalculée que si une fiche a changé (le disque n'est consulté qu'une fois toutes les 2 secondes au plus).

::: example
**Ajouter un jeu à la main.** Vous copiez un dossier terminé dans `DATA_WEB/3d/` : à la prochaine visite, il apparaît dans l'Explorateur. Rien à régénérer. Sur un hôte PHP, c'est `api/catalog.php` qui fait le même travail, appelé par une règle de réécriture du `.htaccess`.
:::

::: tech
**Sur Apache, la réécriture est indispensable** : sans le module `mod_rewrite`, l'adresse du catalogue répond 404, et les pages HTML sortent sans la protection à nonce. Le fichier `.htaccess` fourni protège chaque directive par `<IfModule …>`, car une directive d'un module non chargé ferait tomber **tout le site** en erreur 500. Il n'emploie jamais `Options` (qui exige un droit que beaucoup de mutualisés n'accordent pas) : les listes de dossiers sont refusées par une règle de réécriture.
:::

### La sonde de santé

L'adresse `/api/health` répond une ligne de JSON minimale : `{ok, web, server, trustEpoch}` (et `lastUpdate` juste après une mise à jour). Elle est **publique** et ne dit que ce qui l'est déjà (la version sur GitHub).

Elle sert à deux choses : le superviseur de mise à jour (§18.11) l'interroge pour savoir si la version neuve vit, et vous pouvez la confier à un outil de supervision. **Les hôtes PHP n'ont pas cette sonde.**

## 18.3 Le cache HTTP : ne rien retélécharger pour rien

Un jeu de données pèse des gigaoctets ; la plateforme, une trentaine de scripts. Sans cache, chaque visite repartirait de zéro. Le serveur dit donc au navigateur **combien de temps garder** chaque fichier.

::: analogy
**Le frigo et l'étiquette.** Un yaourt porte une date : jusqu'à cette date, inutile de le redemander au magasin. Un journal du matin, lui, doit être **revérifié** : « est-ce toujours celui d'aujourd'hui ? ». Le cache HTTP, c'est ce jeu d'étiquettes.
:::

![Le tableau de décision : une règle par type de fichier, selon la présence d'un ?v=.](img/ch18/cache.svg){width=100%}

### Trois règles à retenir

::: steps
1. **Une adresse « versionnée » ne change jamais de contenu.** Si elle porte `?v=…`, le navigateur la garde sans redemander : **1 an** pour un paquet de briques, **7 jours** pour un script ou un style.
2. **Tout le reste est « no-cache + ETag ».** Le navigateur garde le fichier, mais le **redemande** avec l'empreinte qu'il possède ; le serveur répond « 304, inchangé » **sans renvoyer les octets**.
3. **Une page HTML n'est jamais gardée** (`no-store`) : son code secret change à chaque chargement.
:::

### D'où vient le `?v=` ?

- **Les paquets de briques** : le chargeur (chapitre 10) ajoute `?v=` suivi d'une empreinte de la **liste des paquets** du manifeste. Retraiter un jeu sous le même nom change les paquets, donc **les adresses** : on ne peut jamais relire d'anciens voxels par mégarde.
- **Les scripts et styles** : au moment de la publication d'une version, l'outil de fabrication ajoute `?v=<numéro de version>` à chaque lien local, et regroupe les scripts d'une page en **un seul fichier** (`js/bundle/<page>.js?v=<empreinte>`).
- **Le thème** (`config/theme.css`) : son `?v=` est la date de dernière modification du fichier, pour qu'un changement de couleurs apparaisse **tout de suite** malgré le cache.

::: why
**Pourquoi un tel soin pour un script ?** Certains hébergeurs limitent le nombre de requêtes par adresse : une trentaine de scripts redemandés à chaque page peuvent déclencher une erreur 429 (« trop de requêtes ») et empêcher le viewer de démarrer. Les adresses versionnées évitent ces redemandes.
:::

### Ce que voit un navigateur, d'une visite à l'autre

![Première visite, puis visites suivantes : ce qui est redemandé.](img/ch18/chargement.svg){width=100%}

Voici des réponses **réellement mesurées** sur le serveur Python de démonstration (jeu synthétique) :

| Requête | `Cache-Control` | Remarque |
|---|---|---|
| `viewer.html` | `no-store` | page + nonce neuf |
| `js/core/utils.js` | `no-cache` | ETag `…-gz` (version compressée) |
| `js/core/utils.js?v=1.59.3` | `public, max-age=604800, immutable` | 7 jours |
| `…/bricks/manifest.json` | `no-cache` | gzip : 1 151 octets |
| `…/p00000.bin` | `no-cache` | 1 383 748 octets |
| `…/p00000.bin?v=abc` | `public, max-age=31536000, immutable` | 1 an |
| `/api/health` | `no-store, no-cache, must-revalidate` | 66 octets |

::: warning
**Sans `?v=`, un paquet est revalidé, pas gardé un an.** Une longue durée sur une adresse que rien ne change aurait servi les **anciens voxels** après un retraitement : une erreur scientifique silencieuse. C'est pourquoi la règle « 1 an » exige la preuve (`?v=`) que l'adresse est neuve.
:::

::: tech
**Les deux backends appliquent la même table**, dans `dev_server.py` (`_static_cache_policy`) et dans le `.htaccess` racine (variables d'environnement posées par `mod_rewrite` quand la requête contient `v=`). Un test compare les deux (`tests/test_backend2_twins_parity.php`).

**Une différence à connaître pour les images et polices** : le serveur Python les répond `no-cache` + ETag ; Apache, via le `.htaccess`, leur donne 7 jours. L'ETag Python se compose de la date de modification et de la taille (`"18dc4a43bc302352-4a17-gz"` : le suffixe `-gz` distingue la version compressée).
:::

## 18.4 Compression et plages d'octets

### gzip : des fichiers texte plus légers

Un manifeste de briques peut peser des dizaines de Mo de JSON : compressé, il en pèse sept fois moins. Le serveur compresse donc à la volée les fichiers **texte** : `.json`, `.js`, `.mjs`, `.css`, `.svg`, `.txt`, `.csv`, `.md`.

- Seuil : au moins **1 Kio** (et au plus 256 Mio) ; niveau 6.
- Le résultat est **mémorisé** (budget 96 Mio) et ne se refait que si le fichier change.
- Pas de compression quand le navigateur demande une **plage** d'octets, ni pour les fichiers de `download/` (qui sortent toujours en pièce jointe).
- Les **paquets de briques ne sont jamais compressés** : ce sont déjà des images WebP.

Sur Apache, la compression est confiée au module `mod_deflate` (JSON, HTML, CSS, JS, SVG), toujours pas aux paquets.

### Les plages d'octets : n'en demander qu'un morceau

Pour afficher une **coupe** du volume, le viewer n'a pas besoin de tout un paquet de 16 Mio : il en demande seulement quelques tronçons (chapitre 10). Le navigateur écrit alors un en-tête `Range: bytes=…`.

![Une plage, plusieurs plages, une plage absurde : les réponses du serveur.](img/ch18/ranges.svg){width=100%}

::: analogy
**Photocopier quelques pages d'un livre.** Plutôt que d'emporter tout le volume, on demande « les pages 1 à 3 et 200 à 210 ». Le serveur répond avec exactement ces pages, chacune étiquetée de sa position dans le livre.
:::

Le serveur Python gère les **trois cas** de la norme HTTP (RFC 9110) :

- **Une plage** : réponse `206` avec `Content-Range: bytes 0-99/1383748`. Une plage « les N derniers octets » (`bytes=-N`) est comprise.
- **Plusieurs plages** (`bytes=0-99, 500-599`) : une seule réponse `206` de type `multipart/byteranges`, **un aller-retour** au lieu de deux. Les plages qui se touchent sont fusionnées ; au-delà de **64 plages** distinctes (ou si l'en-tête est mal formé), le serveur renvoie le **fichier entier** (`200`), ce que la norme permet.
- **Une plage hors du fichier** : `416` avec `Content-Range: bytes */<taille>`.

::: example
**Vérifié sur le jeu de démonstration.** Sur un paquet de 1 383 748 octets : `bytes=0-99` répond `206` de 100 octets ; `bytes=0-99, 500-599` répond `206 multipart/byteranges` de 473 octets au total (deux fois 100 octets, plus les en-têtes de partie) ; `bytes=99999999-` répond `416`.
:::

::: tech
`If-Range` est respecté (une plage n'est servie que si l'ETag ou la date correspondent encore). Les requêtes à plage ne comptent **pas** comme un téléchargement dans les statistiques. Côté Apache, le serveur HTTP gère les plages lui-même, avec ses propres limites (`MaxRanges`). Le chargeur de briques a, de son côté, une **solution de repli** par hébergeur quand les plages multiples ne sont pas comprises (chapitre 10).
:::

## 18.5 Les dossiers fermés et les fichiers-garde

Un site web sert des fichiers ; mais tous ne doivent pas sortir. Les mots de passe, les graines de signature, les imports non validés **ne doivent jamais** être téléchargeables.

![Quels dossiers sont servis, lesquels sont toujours refusés.](img/ch18/dossiers.svg){width=100%}

::: analogy
**Les portes d'un bâtiment public.** Le hall est ouvert à tous ; les bureaux sont fermés à clé ; la salle des archives a **plusieurs serrures différentes**, pour que l'oubli d'une seule ne laisse pas entrer.
:::

### Quatre verrous pour `uploads/`

Les octets importés (chapitre 14) ne sont pas encore validés. Quatre barrières **indépendantes** les protègent : la liste des racines interdites du serveur Python, le `.htaccess` racine, le routeur `router.php`, et un `.htaccess` « tout refuser » écrit dans le dossier lui-même. La prévisualisation d'un jeu en cours d'import passe par une adresse d'API qui exige la session administrateur.

### Les fichiers-garde « lumen-guard v2 »

Deux dossiers servis (`DATA_WEB/` et `js/`) reçoivent un `.htaccess` qui **interdit l'exécution de scripts** : même si quelqu'un y dépose un `.php` malveillant, il ne s'exécutera pas. `uploads/` et la médiathèque ont leur propre garde.

Chaque garde porte la marque `lumen-guard v2`. Le serveur ne **récrit** un garde que si cette marque manque : les deux serveurs (Python et PHP) ne se disputent donc jamais le même fichier pour un simple espace en trop.

::: why
**Pourquoi `DATA_WEB/` a-t-il besoin d'un garde ?** Parce que ce dossier est à la fois **servi** au public et **ouvert en écriture** à l'opérateur (par FTP ou par l'import). Un fichier piégé y serait la porte d'entrée idéale. Le garde est récrit à l'exécution : une mise à jour ne le livre jamais (`DATA_WEB` lui échappe, §18.13).
:::

::: tech
**Détails du routeur PHP.** `router.php` (pour `php -S`) refuse tous les `api/*.json` et les `api/_*.php`, les dossiers `secrets/ logs/ backups/ uploads/ .git`, tout nom commençant par un point (sauf `.well-known`) et les `*.lumen-old|new|backup`. Il calcule le chemin **sans** `parse_url()` : une adresse commençant par deux barres obliques (`//api/admin_credential.json`) fait lire à `parse_url()` « api » comme un nom de site, et le fichier de mot de passe sortait avec un `200`. Le chemin est donc découpé à la main, décodé, normalisé, puis comparé aux règles. Les fichiers parqués par une mise à jour (`*.lumen-old`) seraient servis comme du texte et publieraient l'ancien code : d'où leur interdiction.

**Permissions des fichiers.** Les fichiers créés par le serveur héritent des **droits du dossier racine** : `0770/0660` sur un mutualisé où le serveur web et votre compte FTP partagent un groupe, `0755/0644` ailleurs. Si le serveur tourne sous un autre utilisateur que le propriétaire, des droits d'écriture de groupe sont ajoutés pour que le propriétaire garde la main (FTP, suppression). Surcharge : `LUMEN_DIR_MODE` et `LUMEN_FILE_MODE` (valeurs octales). Les secrets de `api/` gardent des droits restrictifs.
:::

## 18.6 Derrière un proxy, limites de débit et verrou de session

### Le proxy inverse et l'adresse du visiteur

Beaucoup d'instituts placent un **proxy inverse** (Nginx, Apache…) devant le serveur : il gère le HTTPS et transmet les requêtes. Problème : Lumen3D ne voit plus que **l'adresse du proxy**.

![Sans déclaration, tous les visiteurs partagent l'adresse du proxy et un seul compteur de connexion.](img/ch18/proxy.svg){width=100%}

- **Déclarer le proxy** : `--trusted-proxy 10.0.0.2` (option répétable, adresses ou réseaux), la variable `LUMEN_TRUSTED_PROXIES="ip,réseau"`, ou le fichier `api/trusted-proxies.json` (`{"proxies":[…]}`), que **les deux serveurs** lisent.
- **Pourquoi lire la liste par la droite ?** Chaque proxy **ajoute** l'adresse qu'il voit. Tout ce qui est à gauche a pu être écrit par le visiteur : on ne s'y fie pas.
- **Cookie sécurisé** : la session reçoit l'attribut `Secure` si un proxy déclaré annonce du HTTPS (`X-Forwarded-Proto`), ou si `LUMEN_COOKIE_SECURE=1` le force.

### Les limites de débit

| Où | Limite | Pour quoi faire |
|---|---|---|
| Connexion admin | 10 échecs / 15 min / adresse, plafond global de 200 | contrer les essais en masse |
| Compteurs publics (`telemetry`) | seau à jetons : 60 d'avance puis 1/s par adresse ; 600 puis 20/s pour tous ; GET refusé | empêcher de gonfler les statistiques |
| Import, mises à jour de données | régulateur du navigateur (chapitre 17) | ne pas faire bannir l'adresse de l'opérateur |
| GitHub (admin) | réponse mémorisée 5 minutes | 60 demandes/heure par adresse sans compte |

### Le verrou de session PHP

Sur PHP, **une session est un fichier verrouillé** tant qu'une requête s'en sert. Deux requêtes d'un même administrateur se **mettent en file**. Or l'onglet *Mises à jour* lance trois vérifications vers GitHub : l'onglet *Datasets* attendait derrière elles.

![Avant : les requêtes font la queue. Maintenant : la session est lue puis libérée.](img/ch18/verrou-session.svg){width=100%}

::: remember
**Règle du code** : tout point d'entrée qui ne fait que **lire** la session la libère aussitôt (`session_write_close()`). Seule la connexion la garde, parce qu'elle l'écrit. Un nouveau point d'entrée PHP doit suivre la même règle.
:::

## 18.7 Exploiter un serveur au quotidien

| Besoin | Où regarder |
|---|---|
| Le site répond-il ? | `/api/health` (Python) |
| Journaux du serveur | dossier `logs/` (le serveur relancé par une mise à jour écrit `dev-server-<horodatage>.log`) |
| Une mise à jour a échoué | `logs/update-pivot-*.log`, `backups/pivot-journal.json`, `backups/last-update.json` |
| Sauvegardes avant mise à jour | `backups/backup-<version>-<date>.zip` (les 3 plus récentes) |
| Changer le mot de passe | onglet *Sécurité*, ou `python dev_server.py --set-password` |
| Valider une installation | `python dev_server.py --check` |

::: tip
**Avant de bricoler, lancez `--check`.** Cette commande vérifie, sans ouvrir de port, que les fichiers essentiels sont là, que `dev_server.py` se compile, que les fichiers de langue sont lisibles et que la version est cohérente. Code de sortie 0 = tout va bien ; 1 = un problème (un rapport JSON dit lequel).
:::

## 18.8 Mettre à jour la plateforme : le principe

Une mise à jour se déclenche depuis [Système › Mises à jour]{.ui}. L'administrateur voit l'état, clique, et la plateforme fait le reste.

![L'onglet Mises à jour de l'administration (jeu de démonstration, à jour).](img/ch18/maj-onglet.png){.shot width=100%}

::: legend
| n | ce que c'est |
|---|---|
| 1 | [Versions installées]{.ui} : plateforme web et pipeline de préprocessing |
| 2 | [Mise à jour GitHub]{.ui} : « Vous êtes à jour », ou la mise à jour disponible |
| 3 | [Mises à jour des plugins]{.ui} |
| 4 | [Pack de traitement]{.ui} : le logiciel de préparation des données |
| 5 | [Vérifier]{.ui} : redemande l'état à GitHub |
:::

### Quatre numéros, quatre rôles

![Les numéros de version que l'on croise.](img/ch18/versions.svg){width=100%}

- La **plateforme** n'a **pas** de constante de version : c'est le **nom du fichier de changelog le plus récent** (`changelog_1.59.3.md`). Publier = créer ce fichier.
- Le **serveur Python** a sa propre version (`0.16.0`), qui **dérive volontairement** : elle suit l'outil serveur, pas la plateforme.
- Le **pipeline** (0.21.0) est un autre logiciel, qui s'installe sur le poste de traitement.

### Comment la plateforme apprend qu'une version existe

1. Elle interroge GitHub : `releases/latest` du dépôt de la plateforme (écrit en dur dans le code, jamais saisi par l'utilisateur). La réponse est **gardée 5 minutes**.
2. Elle compare avec sa version. Si la plus récente est strictement plus grande, une mise à jour est **disponible**.
3. Elle cherche **exactement** les éléments nécessaires dans la version GitHub.

::: tldr
Éléments d'une version : `lumen3d-web-<version>.zip` (la plateforme), `SHA256SUMS` (la liste d'empreintes), `SHA256SUMS.sig` (la signature de cette liste), `lumen3d-release-notes.json` (toutes les notes de version), et les **packs de traitement** nommés d'après la version **du pipeline**.
:::

::: tech
**Le nom du pack porte la version du pipeline**, ce qui permet à l'onglet *Pipeline* de comparer le pack installé et le pack publié **sans rien télécharger**, donc de proposer une mise à jour du pipeline sans mise à jour de la plateforme.

**Les notes de version** : chaque version embarque les changelogs de **toutes** les versions (niveau plat de `changelog/`, pas l'archive). Un site en retard de plusieurs versions lit ainsi les notes de chacune de celles qu'il va absorber, sans appeler GitHub une fois par version. Rendu : un arbre repliable par version (titre en gras de chaque entrée), aussi disponible en page seule (`admpan.html?changelog=1`).

**Limite de GitHub** : sans compte, 60 demandes par heure et par adresse. Derrière un NAT d'université, elle s'épuise vite : le panneau affiche alors « trop de demandes » avec le délai, au lieu d'un « 403 » trompeur.
:::

## 18.9 La signature : prouver qu'un colis est authentique

Un colis qui arrive par Internet pourrait avoir été **remplacé en chemin**. Lumen3D n'installe donc rien qu'il ne puisse prouver : l'archive doit correspondre à une liste d'empreintes, et cette liste doit porter la signature de l'éditeur.

::: analogy
**Un sceau de cire sur une lettre.** Seul l'éditeur possède le sceau (la clé privée). Tout le monde peut **vérifier** qu'une lettre le porte (la clé publique, connue de votre serveur), mais personne ne peut en fabriquer un faux.
:::

![La chaîne : liste d'empreintes, signature Ed25519, clé publique épinglée, puis extraction.](img/ch18/signatures.svg){width=100%}

### Deux contrôles, dans cet ordre

::: steps
1. **La signature** (algorithme Ed25519) est vérifiée sur les **octets exacts** de `SHA256SUMS`, avec la clé publique que votre serveur connaît déjà.
2. **L'empreinte SHA-256 de l'archive**, recalculée, doit égaler **sa ligne** dans `SHA256SUMS`. Une archive absente de la liste est refusée.
:::

Le mot « **fail-closed** » (échec fermé) résume la règle : au moindre doute, la porte reste fermée. La mise à jour **s'arrête** et affiche la raison. Sans signature valide, rien n'est installé.

### Où vit la clé publique ?

Dans **trois constantes**, qui doivent être identiques : le serveur Python (`_RELEASE_PUBKEY_HEX`), l'installeur (`install.php`) et le code PHP d'administration (`LUMEN_RELEASE_PUBKEY`). La clé **privée** n'existe que dans le secret `LUMEN_SIGNING_KEY` de GitHub.

::: warning
**Pourquoi la clé est « dans le code » et non « dans le colis ».** Une clé livrée avec le colis serait celle du faussaire. La clé épinglée est donc posée dans le **code source du dépôt**, et voyage dans chaque version. Un serveur n'accepte que la clé qu'il connaît.
:::

::: tech
**Changer de clé (rotation).** La version qui **introduit** la nouvelle clé doit encore être signée avec l'**ancienne** : le serveur la vérifie avec la clé qu'il connaît, puis installe le code qui épingle la nouvelle. Seules les versions suivantes sont signées avec la nouvelle. L'outil `tools/gen_signing_key.py` affiche une paire de clés (il n'écrit rien sur disque). **Le catalogue de plugins a sa propre paire de clés** (chapitre 15) : jamais la même graine pour les deux.

**Sur PHP**, la signature est vérifiée par la bibliothèque **libsodium** (`sodium_crypto_sign_verify_detached`) ; sur Python, par un vérificateur Ed25519 écrit en Python pur (`ed25519_pure.py`, RFC 8032), qui n'exige rien de plus que la bibliothèque standard. Une clé laissée vide dégraderait la vérification en « SHA-256 seul » avec un avertissement ; la clé est aujourd'hui renseignée.
:::

## 18.10 La mise à jour sur un serveur Python : huit étapes

Tant que le serveur n'a pas basculé, **l'installation en cours n'est pas touchée**. La mise à jour se déroule dans un fil d'exécution du serveur **vivant**, qui continue de répondre aux visiteurs.

![Huit étapes ; seule la dernière modifie le site.](img/ch18/maj-chaine.svg){width=100%}

| Étape | Ce qui est fait | Ce qui l'arrête |
|---|---|---|
| 1 Vérifications | même volume, espace libre ≥ max(3 × l'archive, 300 Mo), `backups/` inscriptible | un basculement précédent non réconcilié |
| 2 Sauvegarde | zip de tout ce que la version gère (les chemins protégés, §18.13, sont exclus) ; relu après écriture | un fichier illisible : la sauvegarde **abandonne** |
| 3 Téléchargement | taille comparée à celle annoncée | archive tronquée |
| 4 Authenticité | signature puis SHA-256 (§18.9) ; archive intacte (`testzip`) | tout doute |
| 5 Préparation | extraction sûre dans un dossier à part | entrée suspecte (voir ci-dessous) |
| 6 Démarrage à blanc | `dev_server.py --check` **sur l'arbre neuf** | un fichier essentiel manque |
| 7 Plan + journal | liste des fichiers à poser et à retirer, écrite sur disque | — |
| 8 Basculement | un superviseur détaché prend la main (§18.11) | — |

::: warning
**Une version qui contient `api/plugin-trust.json` est refusée.** Ce fichier liste les plugins que l'opérateur a approuvés : une version malveillante pourrait sinon **pré-approuver** un plugin piégé. De même, la version stagée doit porter **exactement** la version annoncée, et chaque fichier doit correspondre à l'empreinte inscrite dans son `version.json`.
:::

::: tech
**Extraction sûre.** Chaque entrée de l'archive est contrôlée avant extraction : chemin absolu, lettre de lecteur, antislash ou `..` sont refusés (une archive reçue d'Internet est une entrée non fiable). Un nettoyage garde les **3** dernières sauvegardes et supprime les dossiers temporaires périmés.

**Quatre approches avaient été comparées** à la conception (journal en place, checkout git, superviseur permanent, échange par préparation) : la dernière a été retenue parce que **le site n'est touché que par des renommages**, jamais par une copie en place. Une interruption à mi-parcours laissait sinon un arbre mi-ancien mi-neuf, impossible à démarrer.
:::

## 18.11 Le basculement et le retour arrière

Le serveur qui a préparé la mise à jour ne peut pas se remplacer lui-même : ses fichiers sont **en cours d'utilisation**. Il lance donc un **superviseur** : une **copie** de `dev_server.py`, placée dans un dossier temporaire privé, qui ne tient aucun fichier de l'installation.

![Le basculement, étape par étape, avec sa branche de retour arrière.](img/ch18/pivot.svg){width=100%}

::: analogy
**Le déménagement bleu-vert.** On monte le nouvel appartement à côté de l'ancien, on vérifie que l'eau et l'électricité marchent, et seulement alors on y emménage. Si quelque chose cloche, on retourne dans l'ancien, resté intact.
:::

### Les cinq temps

1. Le serveur actuel **cesse d'écouter** (une seconde après avoir laissé partir les réponses en cours).
2. Le superviseur attend que **le port se libère** (30 s au plus).
3. Il **échange** les fichiers par **renommages**, chacun noté dans le journal. Aucun octet n'est copié : tout est quasi instantané.
4. Il **lance le serveur neuf**.
5. Il **interroge `/api/health`** toutes les demi-secondes pendant 30 s. Succès = la sonde répond avec **la version cible**.

### Si la sonde échoue

Le superviseur arrête le serveur neuf, marque le journal « rolling_back » **avant** d'agir, applique les renommages **à l'envers**, relance l'ancien serveur et le sonde à son tour. Le panneau affiche alors : « La nouvelle version n'a pas démarré — restauration automatique effectuée. L'ancienne version fonctionne. »

::: example
**Un renommage à deux temps.** Pour remplacer `viewer.html` : l'ancien passe dans un dossier miroir (`old/`), puis le neuf prend sa place. À chaque pas, le superviseur **regarde le disque** (et non sa mémoire) : s'il est interrompu et relancé, il reprend **exactement** là où il s'était arrêté. Le retour arrière est sûr à **n'importe quel** état intermédiaire.
:::

### Et si le superviseur meurt aussi ?

Au prochain démarrage, le serveur trouve le **journal**. Il n'avance que si **tout** est prouvé : phase « applied » ou « done », version égale à la cible **et** chaque fichier avec la bonne empreinte. Dans **tout** autre cas, il revient en arrière. La version seule ne suffit pas à conclure : ce n'est qu'un fichier parmi des milliers.

::: tech
**Détails Windows** qui ont façonné le design : un processus serveur verrouille son dossier de travail (le superviseur tourne depuis le dossier temporaire) ; les antivirus posent des verrous passagers sur les fichiers frais (le renommage est retenté jusqu'à 10 fois) ; le serveur est relancé en processus **détaché**. Une adresse d'écoute `0.0.0.0` n'est pas joignable : la sonde utilise `127.0.0.1`. Sinon chaque mise à jour sur `--host 0.0.0.0` aurait été annulée à tort.

**Fichiers de suivi** : `backups/pivot-journal.json` (phases `planned` → `applying` → `applied` → `done` ; ou `rolling_back`), `logs/update-pivot-<horodatage>.log`, et `backups/last-update.json`, le « dernier résultat » que le panneau lit après le redémarrage (`done` ou `rolled_back`). Les tests `tests/test_update_pivot.py` et `tests/test_update_reconcile.py` couvrent l'application complète, la restauration, le rejeu après un crash partiel et le double retour arrière.
:::

## 18.12 La mise à jour sur un hébergement PHP

Un hôte PHP **se met aussi à jour**, mais autrement : PHP n'a pas de serveur qui tourne en continu, donc rien à redémarrer. Tout se passe dans **une seule requête**, du clic à la réponse.

![Les deux façons de se mettre à jour, côte à côte.](img/ch18/deux-mises-a-jour.svg){width=100%}

::: warning
**Pas de retour arrière automatique sur PHP.** Une mise à jour PHP qui échoue à mi-parcours ne se « défait » pas toute seule. Elle est conçue pour qu'**on puisse simplement la relancer** : la copie est idempotente, et les notes de version (`changelog/`) sont copiées **en dernier**, de sorte qu'un échec laisse l'**ancienne** version déclarée et qu'une nouvelle tentative soit autorisée.
:::

### Le déroulement

1. **Verrou** : une seule mise à jour à la fois (un second clic reçoit « mise à jour en cours »).
2. **Version cible** : même recherche que sur Python ; seule l'archive nommée `lumen3d-web-<version>.zip` est acceptée.
3. **Authenticité** : même double contrôle (signature libsodium, SHA-256).
4. **Extraction** dans un dossier de travail **sous la racine du site** (même disque : un renommage y est instantané ; hors du site, il échouait sur certains mutualisés).
5. **Contrôles de l'archive** : au plus 5 000 entrées, 128 Mio décompressés, aucun chemin suspect (`..`, `.`, vide, antislash, lecteur).
6. **Pose des fichiers** : chaque ancien fichier est **parqué** (`.lumen-old`) puis remplacé ; les chemins protégés sont sautés (§18.13).
7. **Ménage** : anciens fichiers retirés, cache de code PHP (opcache) invalidé pour que la **nouvelle** version réponde dès la requête suivante.

### Les cas particuliers

- **Fichier occupé** (Windows) : le fichier neuf est parqué en `.lumen-new` et terminé à une requête ultérieure.
- **`.htaccess` racine** : le bloc `LUMEN3D` est **réécrit**, mais **vos lignes** (`AddHandler`, `RewriteBase`, `php_value`…) sont gardées, et une copie `.lumen-backup` est conservée. Sans cela, une mise à jour pouvait faire servir le PHP **comme du texte**.
- **Fichiers retirés** : sur PHP, seule une courte liste est supprimée (`api/config.php`, un ancien fichier qui contenait une empreinte de mot de passe). Il n'y a pas de comparaison des `version.json`.

::: tech
Le temps d'exécution est étendu à 600 s. Les fichiers propres à Python (`dev_server.py`, `fast_server.py`, `ed25519_pure.py`, `start.bat`) sont **sautés** sur un hôte PHP. Le dossier `js/modules/` n'est jamais écrasé (un plugin installé n'est pas dans la version).
:::

## 18.13 Ce qu'une mise à jour ne touche jamais

Une version **remplace le code**, jamais **vos données ni votre travail**.

![À gauche ce qui est intouchable, à droite ce que la mise à jour remplace.](img/ch18/protege.svg){width=100%}

- La liste des chemins protégés est dans `_UPDATE_PROTECT` (Python) et `admin_update_protected()` (PHP). Les deux sont des **jumeaux**.
- Dans `config/`, seuls les fichiers que l'opérateur modifie sont protégés ; `config/defaults/` fait partie de la version et **reste** mis à jour.
- Les **suppressions** sont calculées sur Python par différence entre les deux `version.json` (l'ancien et le neuf) : un fichier livré avant mais plus maintenant est supprimé ; **un fichier inconnu des deux** (que vous avez ajouté) n'est jamais touché.

### Les plugins pendant une mise à jour

Avant de basculer, l'onglet *Mises à jour* fait un **pré-vol** : il demande quels plugins installés seraient **incompatibles** avec la version cible (champ `platformCompat` de chaque plugin, chapitre 15).

- Un plugin incompatible est **mis de côté** (« quarantaine ») après la bascule, pas supprimé : son dossier reste en place.
- Dès qu'une mise à jour du plugin, ou de la plateforme, le rend compatible, il est **réactivé automatiquement** à la découverte suivante.
- Un seul cas **bloque** la mise à jour : si **plus aucun mode de rendu** ne resterait disponible (le viewer ne pourrait plus rien afficher).

::: remember
**Un plugin qui plante ne fait jamais tomber le viewer.** Le registre isole chaque plugin (essai/capture par plugin, plus une barrière globale) : le canevas 3D démarre toujours, même si tout le sous-système de plugins échoue.
:::

## 18.14 Première installation : `install.php`

Pour un hébergement vide, **un seul fichier** suffit : on dépose `install.php` dans un dossier web vide et on l'ouvre dans un navigateur.

![Les six étapes de l'installeur.](img/ch18/installeur.svg){width=100%}

- Il télécharge **la dernière version** du dépôt de la plateforme, **vérifie** la signature et l'empreinte (§18.9), extrait, puis demande de créer le **compte administrateur** (8 caractères minimum).
- Le téléchargement se fait **par tranches** (8 Mio ou 10 s) avec reprise, pour survivre aux limites de temps des hébergements mutualisés. L'extraction se fait par lots de 200 entrées.
- À la fin, il écrit `.install-lock` et **propose de se supprimer**. S'il trouve un compte administrateur ou ce verrou, il **refuse de tourner** : on ne peut pas le rejouer pour écraser un site vivant.

::: tech
Garde-fous supplémentaires : dépôt GitHub **codé en dur** (aucune adresse n'est saisie) ; chaque entrée de l'archive contrôlée (pas de traversée, de lien symbolique, de chemin absolu) ; **bombes zip** bornées (20 000 entrées, 500 Mo décompressés, archive ≤ 512 Mo) ; `install.php` ne s'écrase jamais lui-même ; jeton anti-falsification sur chaque requête ; état dans `.install-state.json` (sans secret, supprimé à la fin). Le fichier du compte est créé en **création exclusive** et au même format que celui des deux serveurs.
:::

## 18.15 Publier une version (pour l'éditeur)

Cette section décrit la chaîne côté **éditeur** : la personne qui fait évoluer la plateforme. Elle montre pourquoi la version qui arrive chez vous a de bonnes chances d'être correcte.

![De l'idée à votre serveur : tout le chemin d'une version.](img/ch18/release-pipeline.svg){width=100%}

::: steps
1. **Écrire le changelog.** Créer `changelog/changelog_X.Y.Z.md` : **c'est le numéro de la version**. Sections `[ADDED]`, `[OPTIMIZED]`, `[FIXED]`, `[CHANGED]` ; une entrée par puce, `- **Titre court**: ce qui change et pourquoi`. Le panneau d'administration n'affiche que le titre en gras en mode replié.
2. **Contrôler en local** : `python tests/run_all.py -j 4`, `python tools/check_version.py --tag vX.Y.Z`, `python dev_server.py --check`.
3. **Taguer** : `python tools/make_release.py` (ou `--dry-run` pour simuler). Il vérifie le changelog, refuse un arbre sale ou une autre branche que `main`, pose l'étiquette `vX.Y.Z` et **pousse l'étiquette**.
4. **La CI prend le relais** : elle ne publie que si **tout** passe (§18.16).
:::

### Ce que fait le job « release »

- **Refus sans clé** : sans le secret `LUMEN_SIGNING_KEY`, il s'arrête : jamais de version non signée.
- **Packs de traitement** : le pack complet est fabriqué **avant** le zip, pour que son empreinte figure dans la liste signée. Le pack léger est copié depuis l'arbre.
- **Zip « curé »** : fabriqué depuis une **liste blanche** de fichiers (tout ce qui n'y est pas est exclu, donc la documentation, les outils ou les données ne fuient jamais par accident). Horodatage fixe : deux fabrications donnent les mêmes octets.
- **Signature** de `SHA256SUMS`, puis **re-vérification** contre la clé épinglée du code : on refuse une version que les serveurs refuseraient.
- **Publication en trois temps** : la version est créée en **brouillon**, reçoit **tous** ses fichiers, **puis** est publiée. Un site qui interroge « la dernière version » ne voit donc jamais une version sans son zip.

::: why
**Pourquoi la CI crée la version, et pas `make_release.py` ?** Une version créée à la main apparaîtrait d'abord **sans fichiers** : le programme de mise à jour se rabattrait alors sur le zip « source » automatique de GitHub, **invérifiable**. On laisse donc la création à la CI.
:::

### Deux autres formes de publication

| | Plateforme | Plugin de la plateforme | Plugin tiers |
|---|---|---|---|
| Version | nouveau `changelog_X.Y.Z.md` | `plugin.json` → `version` | idem (indicatif) |
| Publier | `make_release.py` → CI | `publish_plugin.py <dossier> --push` | déposer le dossier |
| Appliquer | admin → Mises à jour | admin → Catalogue | approuver (empreinte) |
| Signature | Ed25519 de la version | Ed25519 du catalogue (autre clé) | hors périmètre |

Les plugins de la plateforme ne **partent pas** avec la version : ils sont publiés dans le **catalogue signé** et installés à la demande (chapitre 15). Leur publication est effective au passage de `dev` à `main`, car le catalogue est lu sur `main`.

## 18.16 La suite de tests : ce qui garde la porte

Une version n'est signée **que si** la suite de tests est entièrement verte. Cette suite se lance par **une seule commande**.

![201 fichiers de tests, trois langages.](img/ch18/tests.svg){width=100%}

::: keynums
:::: keynums
::: keynum
**201**
fichiers de tests
:::
::: keynum
**124**
Node (viewer, workers, protocoles)
:::
::: keynum
**55**
Python (serveur, pipeline, import)
:::
::: keynum
**22**
PHP (serveur jumeau)
:::
::::
:::

- `python tests/run_all.py` découvre tous les fichiers `tests/test_*.py|js|php` et `tests/js/test_*.mjs`, et lance **chacun dans son propre processus**.
- **`--strict-skips`** : un test qui ne peut pas s'exécuter (une extension PHP manquante) doit le dire, et ce mode le compte comme un **échec**. Un test ne peut donc pas s'arrêter de tourner sans que personne ne le voie.
- **`--check-clean`** : un test qui **salit le dépôt** (fichier créé ou modifié) échoue. Tout doit se passer dans des dossiers temporaires.

::: why
**Pourquoi tester les « jumeaux » avec les mêmes vecteurs ?** Plusieurs règles existent en **deux ou trois langages** (compatibilité de version, empreinte de confiance, import, notes de version). Un même fichier de cas est joué par Python, PHP et JavaScript : s'ils divergent, un test échoue. Par exemple, `tests/compat-vector.json` contient 42 cas.
:::

### L'intégration continue, à chaque modification

Deux flux GitHub : **`ci.yml`** (à chaque envoi de code sur `main` ou `dev`, et pour toute demande de fusion) et **`release.yml`** (à chaque étiquette `v*`). Ils enchaînent :

| Contrôle | Ce qu'il garantit |
|---|---|
| `check_version.py` | l'étiquette est égale au changelog le plus récent ; pas de doublon ni de fichier mal nommé |
| `dev_server.py --check` | une installation neuve démarre à blanc |
| suite complète | aucun comportement ne s'est dégradé |
| pas d'`allow-same-origin` | un bac à sable de plugin ne perd jamais son isolement |
| pas de `eval()` / `new Function()` | le code reste compatible avec la politique de sécurité stricte |
| pas de `<script src="http…">` | aucune bibliothèque ne vient d'Internet |

## 18.17 Travailler sans Internet

Lumen3D a été conçu pour un **réseau fermé**. Tout ce dont le **visiteur** a besoin est dans le dossier du site.

![Ce qui marche hors ligne, et ce qui demande Internet.](img/ch18/hors-ligne.svg){width=100%}

| Bibliothèque | Version | Fichier |
|---|---|---|
| Three.js | 0.147.0 | `js/vendor/three.min.js` (+ chargeurs GLTF et OrbitControls) |
| Lucide | 0.344.0 | `js/vendor/lucide.min.js` |
| Plotly | 2.27.0 | `js/vendor/plotly.min.js` (chargé seulement à l'ouverture d'un graphique) |

- Chaque bibliothèque est vérifiée par une **empreinte d'intégrité (SRI)** : si un octet change, le navigateur la refuse. Le dossier `js/vendor/` est protégé des conversions de fin de ligne pour que l'empreinte reste valable.
- La politique de sécurité n'autorise **aucun script étranger** : ajouter une balise `<script src="https://…">` casserait la page, et l'intégration continue le refuse.
- **Seule exception côté visiteur** : les polices (Google Fonts). Elles sont déclarées pour se charger **en arrière-plan** : sur un réseau qui les filtre, la page s'affiche aussitôt avec les polices du système.
- **Côté administrateur** : GitHub n'est contacté que pour chercher une version, la télécharger et lire le catalogue de plugins. **Un visiteur ne contacte jamais GitHub.**

::: example
**Un réseau d'institut sans sortie.** Le viewer, l'Explorateur, l'import et les mises à jour de **données** marchent. Seul l'onglet *Mises à jour* de l'administration affichera « injoignable » ; pour mettre à jour, déposez la version à la main (ou faites-le depuis un poste connecté).
:::

## 18.18 Que faire si… ?

| Symptôme | Cause probable | Que faire |
|---|---|---|
| Mise à jour refusée : « Cette version ne peut pas être vérifiée » | archive absente de `SHA256SUMS`, ou signature invalide | ne rien forcer ; prévenir l'éditeur |
| Mise à jour « restauration automatique effectuée » | la version neuve n'a pas répondu à `/api/health` en 30 s | lire `logs/update-pivot-*.log` |
| « Le serveur ne répond plus » après une mise à jour | basculement long ou crash | vérifier `logs/`, puis recharger ; le serveur réconcilie seul au démarrage |
| Après une mise à jour PHP, une page est cassée | copie interrompue | **relancer** la mise à jour (idempotente) |
| Un plugin a disparu après une mise à jour | son `platformCompat` ne couvre plus la version | onglet *Plugins* : mise à jour du plugin |
| Erreur 429 sur le viewer | l'hébergeur limite les requêtes par adresse | vérifier que les adresses `?v=` sont servies (cache) |
| Tout le monde est bloqué à la connexion | proxy non déclaré (une seule adresse vue) | `--trusted-proxy` (§18.6) |
| L'administration PHP est lente | verrou de session | vérifier que le code est à jour (§18.6) |
| Sans HTTPS, l'import refuse de démarrer | le navigateur exige un contexte sûr pour le calcul d'empreintes | HTTPS, ou `localhost` |
| Un nouveau jeu n'apparaît pas | fiche masquée, ou ni configurée ni vignette | éditer la fiche (chapitre 14) |

::: remember
- Trois serveurs : **Python** (tout), **PHP** (tout, sans retour arrière auto), **fichiers** (lecture seule).
- Un **`?v=`** dit au navigateur « cette adresse ne change jamais » : paquets 1 an, scripts 7 jours ; tout le reste se **revalide** (304).
- Une version se **prouve** (signature Ed25519 épinglée + SHA-256), se **teste** (201 fichiers) et se **bascule** avec filet de sécurité.
- Vos **données, mots de passe et personnalisations** ne sont jamais touchés par une mise à jour.
:::

::: see
- Chapitre 10 : le chargeur de briques, les plages d'octets en pratique et le `?v=` des paquets.
- Chapitre 14 : l'onglet *Import*, l'édition d'un jeu et les écrans de l'administration.
- Chapitre 15 : plugins, confiance, bac à sable et catalogue signé.
- Chapitre 19 : mot de passe, politique de sécurité (nonce) et fiabilité.
- Détails de conception : `DOCS/update-system/` (technique, publication, cheminement).
:::
