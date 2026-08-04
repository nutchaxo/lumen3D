# Changelog — Plateforme Web v1.43.0

## [ADDED]

### Importer un dataset depuis le navigateur, sans SFTP

Jusqu'ici, publier un dataset produit par le pipeline de préprocessing supposait un accès SFTP à l'hébergement : copier plusieurs gigaoctets à la main, dans la bonne arborescence, puis espérer que rien ne manque. Un nouvel onglet **Import** fait le travail depuis le panneau d'administration.

On glisse le dossier — `DATA_WEB` entier, un seul dossier `fixed` / `live` / `tracking`, ou un unique dataset — et le transfert part. Chaque `metadata.json` rencontré marque un dataset, à n'importe quelle profondeur, et son **type est lu dans le fichier lui-même** : un dataset déposé seul, sans dossier parent pour le nommer, est classé correctement quand même.

**Ce qui a déjà été envoyé n'est jamais renvoyé.** Le serveur tient un journal par dataset : taille de chaque fichier, taille de bloc en vigueur, et une carte de bits — un bit par bloc reçu. Reglisser le même dossier après une coupure fait repartir le transfert exactement là où il s'était arrêté, au bloc près, et saute intégralement les datasets déjà publiés. Un import abandonné dispose de **sept jours** avant que le ramasse-miettes ne libère la place; passé ce délai, tout est à refaire, et l'échéance est affichée dans l'interface.

### Un dataset éditable avant la fin de son transfert

L'ordre d'envoi n'est pas l'ordre du disque. Les fichiers sont classés par paliers et le plus petit palier part en premier : `metadata.json`, le manifest des bricks et la miniature, puis **le niveau de résolution le plus grossier, tous canaux confondus**, et seulement ensuite les niveaux intermédiaires, la résolution native et enfin le dossier `download/`.

Conséquence directe : quelques secondes après le début d'un transfert de plusieurs heures, le dataset s'ouvre déjà en basse résolution. On peut le renommer, régler les canaux, définir l'orientation et capturer sa preview pendant que le reste arrive. Les modifications ne sont pas écrasées par la suite du transfert : dès qu'un `metadata.json` est édité, il est verrouillé, et tout renvoi ultérieur de ce fichier — plan de reprise comme bloc isolé — devient sans effet.

Un dataset en cours d'import apparaît dans l'onglet **Datasets** au milieu des autres, avec son état :

| État | Ce qu'on peut en faire |
|---|---|
| **Envoi — non éditable** | visible dans la liste; formulaire verrouillé, les fichiers nécessaires à l'ouverture ne sont pas tous arrivés |
| **Envoi — éditable** | ouvrable en basse résolution, entièrement éditable |
| **Envoyé — à publier** | transfert complet, intégrité vérifiée |
| **Publié** | déplacé dans les datasets publiés (masqué de l'explorer jusqu'à activation) |
| **Interrompu** | en attente d'un nouveau dépôt du même dossier |

### Un panneau de suivi qui ne gêne rien

Le suivi du transfert est un **calque**, pas un élément de mise en page : position fixe, contexte d'empilement propre, aucune largeur réservée. L'ouvrir ou le replier ne décale rien de la page en dessous — le champ qu'on est en train de remplir ne saute pas.

Trois tailles, un clic entre chacune : le **panneau** (une ligne par dataset, avec publier / éditer / supprimer), la **barre** (pourcentage, vitesse, temps restant) et la **bulle** (un anneau de progression dans le coin, comme une bulle d'aide). La taille choisie est mémorisée. Le suivi reste visible et le transfert continue quel que soit l'onglet affiché.

Quitter la page pendant un transfert déclenche un avertissement : sur une navigation interne au panneau (déconnexion, lien vers l'explorer) c'est un vrai calque, avec mise en pause explicite; sur une fermeture ou un rechargement, seule la boîte de dialogue du navigateur est possible, et le transfert est mis en pause avant qu'elle ne s'affiche. Dans les deux cas rien n'est perdu : tout bloc acquitté est déjà sur le disque.

### Vitesse

Tout le chemin des octets vit dans un **Web Worker** — lecture des tranches, empreinte SHA-256, envoi. Le fil principal ne touche jamais aux données : la preview 3D garde sa fluidité pendant qu'un dataset de plusieurs gigaoctets part en arrière-plan (règle 1.2).

Les blocs partent en **8 Mio bruts dans le corps de la requête**, pas encodés en base64 dans du JSON : l'encodage aurait coûté +33 % sur le réseau et fait passer plusieurs mégaoctets par `json_decode` à chaque bloc. Tous les paramètres voyagent dans l'URL. Quatre blocs circulent en parallèle, tirés d'une file unique — la parallélisation porte sur les **blocs** et non sur les fichiers, si bien qu'un unique fichier de 22 Go sature le lien aussi bien qu'une rafale de petits paquets. Les blocs peuvent donc arriver dans le désordre : le serveur écrit chacun à son décalage exact.

Sur hébergement PHP, la taille de bloc est **négociée** au lieu d'être supposée : `api/upload.php?action=limits` annonce 80 % du plus petit de `post_max_size` et d'un quart de `memory_limit`. Un corps dépassant `post_max_size` est purement et simplement jeté par PHP, sans erreur exploitable — le transfert semblerait bloqué sans raison. Les sessions PHP sont refermées (`session_write_close`) dès l'authentification décidée, sinon leur verrou exclusif sérialiserait les envois parallèles et l'import tournerait à la vitesse d'un seul flux.

## [FIXED]

### Rien d'inattendu n'entre, et ce qui entre n'est pas joignable

Les octets déposés par un navigateur atterrissent dans un dossier `uploads/` **jamais servi** : bloqué dans `dev_server.py:_FORBIDDEN_ROOTS`, dans le `.htaccess` racine, dans `router.php`, et par son propre `.htaccess` en refus total. La preview d'un dataset en cours d'import passe par `api/upload.php?action=blob`, qui exige une session administrateur et répond en `application/octet-stream` avec `nosniff` — c'est la seule sortie possible avant publication.

L'admission suit une **liste blanche fermée** : uniquement les fichiers que le pipeline produit (`metadata.json`, `thumbnail.webp`, `bricks/manifest.json`, `bricks/lodN/cM/pack_NN.bin`, les variantes par pas de temps `bricks/tNNN/…`, et `download/` avec extensions autorisées). Tout le reste — `.php`, `.js`, `.htaccess`, fichier caché, chemin remontant — n'a aucune règle correspondante et est refusé avant le moindre octet écrit, puis listé dans l'interface pour que l'opérateur sache ce qui a été ignoré.

L'intégrité est vérifiée à trois profondeurs : chaque bloc porte une empreinte SHA-256 contrôlée **avant** l'écriture; un fichier terminé doit correspondre à la taille annoncée et à la racine des empreintes calculée côté client; un dataset complet doit voir son index `brickTransport.brickToPack` résoudre dans des packs réellement présents et assez longs. Un pack tronqué est arrêté ici, pas découvert plus tard devant un rendu noir.

`DATA_WEB/` reçoit enfin son propre `.htaccess` : le dossier est servi par construction, c'est donc le seul endroit à la fois inscriptible et joignable. Moteur PHP coupé, gestionnaires de script retirés, `Options -Indexes -ExecCGI`. Il est réécrit au démarrage par les deux serveurs, car `DATA_WEB` est protégé du système de mise à jour et ne recevrait jamais ce fichier autrement.

### Trois défauts trouvés à l'exécution

* **Une URL relative dans un Worker ne pointe pas où l'on croit.** `fetch('api/upload.php')` s'y résout par rapport au *script du worker*, pas au document : chaque bloc partait vers `/js/workers/api/upload.php`. L'adresse transmise au worker est désormais absolue, résolue sur `document.baseURI` — ce qui règle du même coup les installations en sous-dossier.
* **Une seconde importation dans la même session dépassait 100 %.** Le compteur global s'appuyait sur le total cumulé du worker, qui couvre toute sa durée de vie, alors que la cible est propre à chaque import. Les compteurs par dataset font maintenant foi et le global en découle; un dossier redéposé pendant un transfert fusionne dans le modèle au lieu de le remplacer.
* **`api/datasets.php?action=list` était une erreur fatale sur PHP.** La bibliothèque d'import n'était chargée que dans la branche traitant les identifiants `staging:`, jamais atteinte par `list`. Invisible à `php -l` comme à la lecture du fichier : il a fallu exécuter le jumeau PHP pour la voir. `tests/test_upload_php.php` charge désormais `datasets.php` en mode bibliothèque et vérifie que les symboles sont là.

Un dernier défaut a été pris avant d'atteindre l'exécution : l'éditeur renvoie tel quel ce que le serveur lui a donné, champs calculés compris (`staging`, `stagingState`, …). Sans filtrage ils étaient écrits dans `metadata.json` et **survivaient à la publication**, laissant un dataset publié marqué « en cours d'import » à vie.

### Relecture complète : dix défauts de plus

Une seconde passe sur l'ensemble du code, méthodique, a sorti dix problèmes que la première n'avait pas vus. Aucun n'est théorique.

**Ce qui aurait fait perdre du travail**

* **Le ramasse-miettes effaçait des datasets terminés.** La règle des sept jours visait les transferts *interrompus*; elle s'appliquait aussi à un dataset complet, validé, n'attendant qu'un clic sur Publier. Une semaine d'absence et des dizaines de gigaoctets de travail achevé disparaissaient. Un dataset à l'état *Envoyé — à publier* est désormais exempté, et il n'affiche plus de compte à rebours qu'il n'aurait pas honoré.
* **Un fichier en échec ne pouvait plus jamais repartir.** Après quatre tentatives infructueuses, il restait enregistré dans le worker; reglisser le dossier pour le relancer — la promesse même de la reprise sur échec — ne faisait plus rien du tout. Idem après une expiration de session.
* **Un fichier disparu du dossier bloquait la publication à vie.** Si le pipeline était relancé et n'émettait plus un niveau de résolution, son entrée inachevée restait au journal et « fichiers incomplets » refusait la publication en nommant un fichier que l'opérateur n'avait plus. Les entrées inachevées absentes du nouveau dépôt sont maintenant retirées, avec leurs octets partiels; les entrées **terminées** sont conservées.

**Ce qui affichait faux**

* Un **manifest sans dimensions par niveau** passait l'import, annonçait « intégrité vérifiée », puis était refusé par le viewer au montage. La validation serveur reprend maintenant les règles du chargeur de bricks : un dataset que la plateforme ne sait pas ouvrir n'est pas un dataset valide.
* Les **paliers n'étaient pas recalculés** sur un second dépôt : un fichier déjà terminé gardait son ancien rang, ce qui faussait le test « est-ce ouvrable ? ».
* Un `metadata.json` **édité puis reglissé** faisait dépasser 100 % (la taille éditée comptée face aux tailles locales).
* Les **bits de bourrage** du dernier octet de la carte de réception pouvaient gonfler le total; ils sont masqués à la lecture.

**Ce qui gênait l'usage**

* **Les deux vues reconstruisaient tout leur DOM six fois par seconde**, pendant des heures. Lucide recréait chaque icône à chaque fois, la liste dépliée des fichiers ignorés se refermait toute seule, une sélection de texte était détruite en continu. Les reconstructions sont désormais réservées aux vrais changements de structure — mesuré : **6 au lieu de plusieurs centaines** sur un transfert de 80 Mo en dix-huit fichiers — le reste étant écrit directement dans les nœuds existants.
* **Un dossier lâché à côté de la zone de dépôt** faisait ouvrir le fichier par le navigateur : la page d'administration disparaissait, transfert en cours compris. Les dépôts hors zone sont maintenant absorbés.
* **Les notifications se superposaient au panneau de suivi** (même coin bas-droit). Elles s'écartent tant qu'il est visible.
* Le bouton **Éditer** menait à l'onglet Datasets sans y ouvrir le dataset. Il l'ouvre, et lève le filtre s'il masquait la ligne.
* Deux **doublons d'écouteurs** : un changement de langue rebranchait le gestionnaire de l'onglet Import (un clic sur Publier publiait deux fois), et une reconnexion rebranchait celui du panneau (un repli n'avait plus d'effet).
* Le panneau flottant se montrait **par-dessus l'écran de connexion** en cas d'expiration de session, et passait au-dessus du tiroir mobile.
* Un **worker en échec n'était jamais remplacé** : toute tentative ultérieure réutilisait l'instance morte, sans issue autre que recharger la page.
* La zone de dépôt était un `role="button"` **contenant un bouton** — imbrication invalide, inutilisable au lecteur d'écran.
* Déposer le *contenu* d'un dataset au lieu de son dossier échouait sans explication; le message dit maintenant précisément quoi faire.

### Couverture

`tests/test_upload_staging.py` (39 cas), `tests/test_upload_api.py` (16 cas de bout en bout sur un vrai serveur HTTP : authentification, CSRF, corps binaire brut, proxy de lecture, garde statique) et `tests/test_upload_php.php` pour le jumeau. Chaque défaut ci-dessus a son test de non-régression. Le format du journal est commun aux deux serveurs et un test croisé le fixe : un import commencé sous Python reprend tel quel sous PHP, et réciproquement.
