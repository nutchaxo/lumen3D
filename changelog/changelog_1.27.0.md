# Changelog v1.27.0 (Plateforme Web)

## [FIXED]
* **Un dataset déposé par SFTP apparaît enfin tout seul.** Ajouter un dataset, c'est déposer un dossier contenant un `metadata.json` — c'est la méthode documentée, et c'est ce que fait un upload SFTP. Sur le serveur Python ça marchait, parce que `GET DATA_WEB/catalog.json` est intercepté et reconstruit à la volée. **Sur un hôte PHP — la cible de déploiement réelle — `catalog.json` était un fichier statique que seul `rebuild_catalog()` réécrivait, et il ne tournait qu'à l'enregistrement d'un dataset depuis le panneau d'admin.** Le dataset restait donc invisible dans l'explorateur jusqu'à ce que quelqu'un clique « Régénérer catalog.json », sans le moindre message pour l'indiquer.

## [OPTIMIZED]
* **Le catalogue est calculé, plus stocké** ([api/catalog.php](api/catalog.php), routé depuis `.htaccess` et `router.php`). Il ne contenait aucune information propre : chaque champ est soit recopié du `metadata.json` du dataset (nom, canaux, stage, embryon, dimensions, voxels…), soit dérivé (`physicalSizeUm` = dimensions × voxel_size), soit déduit du dossier (`thumbnail` si le fichier existe, `volumeSources` en sondant `bricks/manifest.json`). Une copie persistée d'une projection pure ne pouvait être juste que par accident — et sur PHP c'était même une projection **avec perte**, la liste de clés étant figée.
  * Supprime la classe de bugs entière plutôt que de la contourner par de l'invalidation de cache — laquelle ne peut de toute façon pas être fiable ici : `filemtime` a une résolution d'une seconde, donc deux changements dans la même seconde sont indiscernables (constaté en test : retirer puis remettre un dossier dans la même seconde passait inaperçu).
  * Coût mesuré : **3,6–6,7 ms** pour 16 datasets (34 Ko de payload). Les ~215 ms observés en HTTP local sont l'overhead du serveur intégré `php -S` sous Windows — un endpoint PHP trivial met déjà 205–223 ms sur le même serveur. Le serveur Python garde son cache sur mtime (PERF-035) ; si l'instance atteint un jour des centaines de datasets, le cache est à remettre **là**, pas dans un fichier que l'opérateur peut désynchroniser.
  * `api/datasets.php` devient incluable comme bibliothèque (`LUMEN_DATASETS_LIB`) : en ce mode il n'émet pas d'en-têtes JSON, n'ouvre pas de session d'admin et n'exécute pas son routeur. Aucune collision de fonctions avec `admin.php` ni `_admin_lib.php` (vérifié).
  * `api/admin.php` (onglet Stats) construisait les noms d'affichage en lisant le fichier ; il appelle maintenant le générateur, sinon un dataset ajouté depuis la dernière régénération s'afficherait sous son identifiant brut.
  * Sans `mod_rewrite`, la règle est absente et Apache sert le `DATA_WEB/catalog.json` statique s'il existe : périmé, exactement comme avant, jamais pire. (Vérifié actif sur l'instance de production — les pages y reçoivent bien un nonce CSP par requête, donc `_serve.php` s'exécute.)

## [VERIFIED]
Contre le serveur PHP réel, **`DATA_WEB/catalog.json` entièrement supprimé du disque** :
* GET → 200, 16 datasets, `fixed` + `live`, sans aucun fichier de catalogue.
* Un dossier de dataset déposé à chaud apparaît **à la requête suivante** (17 entrées), et disparaît de même une fois retiré.
* Rien ne recrée le fichier.
* Le serveur Python sert toujours le même catalogue avec le fichier absent (16 entrées).
* La branche d'enrichissement des noms de `admin.php` résout bien les 16 noms, dataset `live` compris.

## [REMOVED]
* **Le bouton « 🔄 Régénérer catalog.json » disparaît du panneau d'admin**, ainsi que la section « Catalogue » qui l'entourait. Il écrivait un fichier que plus personne ne lit — le garder aurait entretenu l'idée qu'une étape manuelle reste nécessaire, ce qui était précisément la source de confusion.
* **La sauvegarde d'un dataset et la mise à jour d'une vignette ne déclenchent plus de reconstruction du catalogue.** Ces deux actions enchaînaient un `POST ?action=rebuild_catalog` et pouvaient afficher un avertissement « catalogue non régénéré » désormais dénué de sens. Une requête réseau de moins à chaque enregistrement.
* Les 10 clés i18n devenues orphelines sont retirées des trois langues (parité vérifiée : 1378 clés, jeux identiques en `en`/`fr`/`es`).
* L'endpoint `POST ?action=rebuild_catalog` est conservé : il écrit toujours un `catalog.json` sur disque, ce qui reste utile aux bundles d'export et à un hôte purement statique.
