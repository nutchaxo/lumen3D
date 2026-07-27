# Changelog v1.29.0 (Plateforme Web)

> Durcissement issu d'un audit du panneau d'administration et de ses surfaces adjacentes. Le panneau lui-même tenait — PBKDF2, comparaison en temps constant, régénération de session, écritures de `api/site.php` étaient déjà fermés. Ce qui suit corrige les fuites **autour** du panneau, et les divergences entre le serveur PHP (production) et le serveur Python.

## [FIXED]

### Fichiers sensibles servis en statique

* **Contournement par percent-encoding.** `_is_forbidden_static` comparait le chemin **brut**, alors que `SimpleHTTPRequestHandler.translate_path` le percent-décode avant d'ouvrir le fichier. Encoder un seul caractère suffisait : `/api/admin_credential.json` renvoyait 404, `/%61pi/admin_credential.json` renvoyait **200 et le hachage PBKDF2**. Le filtre décode maintenant avant de normaliser, une surcharge de `translate_path` verrouille le système de fichiers lui-même quel que soit le chemin de code emprunté, et `do_HEAD` ne court-circuite plus le routeur (un HEAD révélait l'existence et la date de dernière modification du magasin d'identifiants — donc la date du dernier changement de mot de passe).
* **La liste de blocage ne couvrait que `api/`.** Elle couvre désormais `secrets/`, `logs/`, `backups/` et `.git/`, de façon cohérente dans `dev_server.py`, `fast_server.py`, le `.htaccess` racine et `router.php`. `secrets/` est le pire cas : il contient les **graines de signature Ed25519**, et une fuite permet de signer un plugin ou une release que *toute* installation accepte.
* **`fast_server.py` écoutait sur `0.0.0.0` en dur, sans aucun filtre** — il servait l'arbre complet, graines comprises, à tout le réseau. Loopback par défaut désormais (hôte explicite en second argument pour exposer délibérément), plus d'indexation de répertoire, même filtre que le serveur principal.
* **`router.php`** (`php -S`) comparait un chemin non normalisé : `//api/admin_credential.json` passait la liste de refus. Le chemin est normalisé avant comparaison et le refus `api/*.json` s'étend aux sous-répertoires.

### `api/datasets.php` — lectures publiques, CSRF lié à la méthode, traversée

L'authentification et le jeton CSRF étaient conditionnés à `$method === 'POST'` :

* `?action=list` et `?action=get` étaient **entièrement publics**. Le premier énumère les datasets **masqués** avec leur nom de dossier (`list_datasets()` renseigne `hidden` pour chacun ; seul le catalogue public les filtre). Le second passait `$id` directement à `dataset_dir()`, qui ne fait qu'une substitution de séparateurs — sans aucun contrôle de traversée.
* `set_visibility` restait atteignable en **GET** sans jeton : un administrateur connecté suivant un lien piégé rendait public un dataset sous embargo.

L'authentification s'exécute maintenant avant le `switch`, le CSRF est lié à l'**action** et non à la méthode (`admin_require_write()` impose POST *et* jeton), et `admin_safe_dataset()` valide tout `id` avant qu'un chemin n'en soit dérivé. Le `session_start()` nu devient `admin_session_start()`, pour hériter des paramètres de cookie durcis (HttpOnly / SameSite / Secure).

### Un plugin pouvait s'auto-attribuer son niveau de confiance

`PluginTrust.evaluate()` lisait le vouch dans `meta.trust` — or `meta` **est** le `plugin.json` du plugin dès que la découverte ne fournit pas de métadonnées riches. Un plugin approuvé en **sandbox** n'avait qu'à omettre `name`/`subtype`/`i18n` pour faire échouer `_isRichMeta()`, ce qui poussait `loadModules()` à récupérer son propre `plugin.json`, dont le champ `trust` était alors honoré comme un verdict serveur : exécution en page, avec tout le `ViewerContext`. Le hachage ne protégeait pas — le vouch et les octets étaient contrôlés par le même auteur.

Le vouch devient un canal **séparé** : `_discoveredVouch` n'est alimenté que par un point d'accès autoritatif (`/api/plugins`, `api/plugins.php`), jamais par le manifeste statique ni par un `plugin.json` ; `trust` est retiré des métadonnées quelle que soit leur provenance ; `evaluate()` reçoit le vouch en argument propre. Un vouch absent signifie « pas d'autorité de confiance ici » — seuls les plugins `bundled` vérifiés contre le manifeste de release s'exécutent.

### Verrouillage anti-force-brute et télémétrie

* **Le compteur PHP était global à l'installation** : dix échecs venant de n'importe qui verrouillaient l'opérateur (et `action=setup`) pendant 15 minutes, indéfiniment renouvelables. C'était un levier de déni de service, pas une défense. Il est maintenant indexé sur l'adresse du client, comme le budget par IP du serveur Python. `login` devient POST-only : un identifiant ne doit jamais voyager dans une URL (journaux, `Referer`), et un GET consommait du budget de verrouillage sans corps de requête.
* **La balise de télémétrie publique acceptait n'importe quel id bien formé**, existant ou non, et l'ajoutait à `api/stats.json` : n'importe qui pouvait y greffer un nombre illimité de clés inventées. Les deux jumeaux exigent désormais que le dossier existe ; un id absent ou invalide reste compté globalement.

### Les brouillons de pages n'étaient pas privés

`config/pages/<slug>.json` est servi statiquement à tout visiteur et contenait le bloc `draft` en ligne. « Publier » n'était donc pas une frontière de confidentialité : n'importe qui pouvait lire du contenu non publié et, l'éditeur enregistrant automatiquement environ chaque seconde, **suivre l'opérateur en train d'écrire** en interrogeant cette URL.

Les brouillons vivent maintenant dans `api/page-drafts/<slug>.json`, refusé par trois mécanismes indépendants (`api/.htaccess`, `router.php`, le filtre statique Python), écrit en `0600`. Le document public ne garde que le contenu publié ; `site.php` et le serveur Python ne renvoient le brouillon qu'à une session authentifiée ; publication, réinitialisation et suppression suivent le brouillon. Une migration unique déplace les documents antérieurs au découpage, au démarrage (Python) ou à la première requête `api/*.php` (PHP) — sans quoi la copie publique continuerait de fuir jusqu'à la prochaine édition de cette page.

**La migration ne détruit jamais un brouillon qu'elle n'a pas pu ranger.** La copie publique en est l'unique exemplaire : si l'écriture sous `api/` échoue (dossier en lecture seule, disque plein), la page est laissée intacte et le marqueur n'est pas posé, donc la migration réessaie au démarrage suivant. Corriger une fuite de confidentialité ne justifie pas d'effacer le travail non publié de l'opérateur.

Enfin, `api/page-drafts` et `secrets` rejoignent les deux listes de protection de mise à jour, pour qu'une mise à jour ne les écrase pas.

## [VERIFIED]

Sur le serveur Python réel, sondes rejouées avant/après :

| Requête | Avant | Après |
|---|---|---|
| `/%61pi/admin_credential.json` | **200 — hachage PBKDF2 complet** | 404 |
| `/secrets/marketplace-signing-seed.hex` | **200 — graine de signature Ed25519** | 404 |
| `/logs/`, `/.git/config` | 200 (index de répertoire) | 404 |
| `HEAD /api/admin_credential.json` | 200 + taille + date | 404 |

Non-régression exercée dans le navigateur, pas seulement lue : explorateur (16 datasets), viewer 4D sur le dataset réel (volume rendu, `isStabilized() === true`, timeline 000/029), **17 plugins chargés, 0 en quarantaine**, et plus aucun champ `trust` dans les métadonnées côté client. Rendu d'une page publiée conforme ; un `?preview=draft` anonyme retombe sur le contenu publié sans fuite. Suite de tests : 94 tests, seul subsiste l'échec d'isolation préexistant de `test_max_version_from_changelog` (identique sur l'arbre non patché).

**Ce qui n'est pas vérifié à l'exécution** : les jumeaux PHP (`datasets.php`, `auth.php`, `telemetry.php`, `site.php`, `_admin_lib.php`, `router.php`) — aucun interpréteur PHP sur la machine de développement. Ils ont été relus ligne à ligne, les fonctions appelées existent, et les 17 dossiers de datasets réels passent la nouvelle validation d'`id` ; mais le panneau d'administration doit être ouvert une fois après déploiement pour confirmer.

## [NOTE]

Le premier démarrage (`api/admin_credential.json` absent) laisse toujours
`?action=setup` accessible sans authentification : sur une instance déployée mais
dont le compte n'a pas encore été créé, un tiers peut réclamer le compte
administrateur, et l'opérateur se retrouve verrouillé dehors (la création est
exclusive, sa propre tentative répondrait `409 already_configured`).

Écart de sécurité connu et **délibérément conservé** — le compte est créé dans les
minutes qui suivent l'installation, la fenêtre est jugée acceptable. À reprendre si
le modèle de déploiement change : jeton de configuration à usage unique écrit sur
disque à l'installation et exigé par `action=setup` (`hash_equals`), plus arrêt de
l'exposition publique de `needsSetup`.

## [FIXED] — vérification PHP à l'exécution

Les jumeaux PHP ont finalement été exercés (PHP 8.3.31 via `php -S router.php`, cf.
`.claude/launch.json`), et non seulement relus. Cela a révélé que **`router.php`
n'était pas corrigé** : la normalisation était appliquée *après* `parse_url()`, qui
lit le premier segment d'un chemin commençant par deux barres obliques comme une
**autorité**. `//api/admin_credential.json` renvoyait donc `host='api'`,
`path='/admin_credential.json'` — aucune règle ne matchait, `php -S` recollait les
barres et **servait le hachage PBKDF2 avec un 200**. Trois barres étaient pires
encore : `parse_url()` retourne `false` et toutes les règles voyaient un chemin vide.

Le chemin est désormais dérivé sans `parse_url()` : découpage de la requête brute sur
`?` (pour qu'un `%3F` encodé reste dans le chemin), puis décodage, puis normalisation.
Vérifié en direct : `//api/`, `///api/`, `////api/`, `/./api/`, `/x/../api/`,
`/api%2f`, `//secrets/`, `//api/page-drafts/` → tous 403 ; routes d'API, pages,
assets, `DATA_WEB/*/metadata.json` et pages publiées → 200. Verrouillé par
`tests/test_router_deny.php` (25 cas).

Le reste de la surface PHP a été confirmé à l'exécution : `datasets.php` refuse
`list`, `get`, `set_visibility` et la traversée sans session (401/400) ; `auth.php`
refuse un `login` en GET (405) ; `site.php?action=get` public ne rend pas de
brouillon ; `_admin_lib.php`, `secrets/` et `.git/` sont refusés. Les 5 suites PHP et
les 22 suites Python passent.
