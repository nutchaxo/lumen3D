# 19. Sécurité et fiabilité

::: chapter-intro
- Lumen3D protège le panneau d'administration, le code exécuté dans les pages et les fichiers déposés. Chaque protection a une **raison simple**.
- Aucune donnée d'étude n'est envoyée à un tiers et la plateforme fonctionne **hors ligne**.
- La fiabilité repose sur des publications **tout ou rien** et sur une suite d'environ **200 fichiers de tests** qui bloque toute version défectueuse.
- Un tableau unique, « **Que se passe-t-il si… ?** » (sections 19.8 à 19.12), liste chaque panne prévue et le repli qui l'attend.
:::

## 19.1 Le mot de passe administrateur

Il n'existe **aucun mot de passe par défaut** : le premier visiteur du panneau crée le compte (8 caractères minimum), et cette création ne peut jamais écraser un compte existant.

![Du mot de passe à l'empreinte, et les protections contre les essais répétés.](img/ch19/mot-de-passe.svg){width=100%}

::: analogy
**Une empreinte digitale.** Le serveur garde l'empreinte de votre mot de passe, pas le mot de passe. Avec une empreinte on peut reconnaître la bonne personne, mais on ne peut pas refabriquer le doigt.
:::

- L'empreinte est calculée par **PBKDF2-HMAC-SHA256**, avec un sel propre au compte et 600 000 tours : volontairement lent pour décourager les essais en masse.
- Après **10 échecs** en 15 minutes depuis une même adresse, l'accès est bloqué 15 minutes. Les échecs sont comptés **avant** la vérification, et un mauvais identifiant coûte le même temps qu'un mauvais mot de passe.
- Une session dure **8 heures**. Changer le mot de passe ferme toutes les autres sessions.
- Toute modification passe aussi par un jeton anti-falsification (CSRF).

## 19.2 La politique de sécurité du contenu (CSP)

::: analogy
**Une liste d'invités à l'entrée.** À chaque chargement de page, le serveur tire un code secret (le « nonce ») et le remet aux scripts du site. Le navigateur ne laisse entrer que ceux qui le présentent.
:::

![Le nonce, une liste d'invités renouvelée à chaque chargement.](img/ch19/csp.svg){width=100%}

La politique est **appliquée** (et non simplement observée). Les bibliothèques (Three.js, Lucide, Plotly) sont hébergées par le site lui-même : aucun script ne vient d'ailleurs.

## 19.3 Les fichiers importés ne sont jamais servis

![Le trajet d'un fichier importé jusqu'à sa publication.](img/ch19/import-prive.svg){width=100%}

- Les fichiers arrivent dans `uploads/`, un dossier **inaccessible par URL** (quatre verrous indépendants).
- Une **liste blanche** refuse avant écriture tout ce que le pipeline ne produit pas : pas de `.php`, de `.js`, de fichier caché, de chemin remontant (`..`).
- Seule une **publication explicite**, après validation, déplace le dataset vers `DATA_WEB/`. Ce dossier interdit l'exécution de scripts.

## 19.4 Les plugins : confiance et cage

![Niveaux de confiance, approbation liée à une empreinte, bac à sable.](img/ch19/plugins.svg){width=100%}

::: why
Un plugin est du code. Le laisser entrer sans contrôle serait comme donner un double des clés à un inconnu. Par défaut, un plugin non reconnu **n'est pas chargé**.
:::

- Votre approbation est liée au **contenu exact** du plugin (empreinte) : modifié, il perd sa confiance.
- Un plugin déclare aussi avec quelles versions de la plateforme il est compatible : en cas de doute, il est écarté.

## 19.5 Versions et catalogue signés

::: analogy
**Un sceau de cire.** Seul l'éditeur possède le sceau (la clé privée). Tout le monde peut vérifier qu'une lettre le porte (clé publique), mais personne ne peut en fabriquer un faux.
:::

![La chaîne de confiance d'une mise à jour : signature, vérification, refus.](img/ch19/signatures.svg){width=100%}

- La signature est une **Ed25519**. La clé publique est **intégrée au code** du serveur : une clé fournie avec le téléchargement ne serait pas fiable.
- Une version sans signature valable est **refusée** : le programme de mise à jour n'applique que l'archive nommée d'après la version et listée dans la liste signée.
- Le catalogue de plugins a **sa propre clé** et un numéro de série croissant, pour qu'on ne puisse pas réinstaller une ancienne version corrigée depuis.

## 19.6 Vos données restent chez vous

- **Aucune donnée d'étude** n'est envoyée à un tiers.
- **Hors ligne** : tout le code est hébergé sur le serveur. Seules les polices Google Fonts sont chargées à distance. GitHub n'est contacté que par l'administrateur, pour vérifier les mises à jour.
- Les statistiques sont de simples compteurs (visites, vues, téléchargements). Ce qui est **conservé** : un total global, un total par jour et un total par jeu de données (avec la date de dernière vue), dans `api/stats.json`. Rien n'y est lié à une personne.
- L'adresse du visiteur ne sert qu'**en mémoire**, pour limiter le débit : elle est réduite à l'un de 4 096 emplacements d'une table de « jetons » (60 comptages en rafale par adresse, puis 1 par seconde ; 600 en rafale pour tout le site, puis 20 par seconde). Elle n'est écrite nulle part.

## 19.7 Fiabilité

| Risque | Protection |
|---|---|
| Une mise à jour casse le site (serveur Python) | bascule vérifiée par une sonde de santé, **retour automatique**, sauvegarde préalable |
| Une mise à jour échoue (hébergement PHP) | vérifications SHA-256 et signature **avant** de toucher aux fichiers ; pas de retour automatique, mais la copie est **rejouable** sans dégât (chapitre 18) |
| Une publication s'interrompt | **tout ou rien** : le pipeline construit tout à l'écart et publie par un renommage ; une interruption est rattrapée au lancement suivant |
| Une coupure réseau pendant un import | reprise au bloc près |
| Une brique corrompue | signalée et ignorée, jamais envoyée à la carte graphique |
| Une régression dans le code | environ **200 fichiers de tests** doivent passer avant chaque version |

::: remember
Chaque version est **testée en entier** avant d'être signée et publiée. Une version qui échoue aux tests ne peut tout simplement pas sortir.
:::

## 19.8 Que se passe-t-il si… ? {.page}

::: chapter-intro
- Une plateforme fiable n'est pas une plateforme où rien ne tombe en panne : c'est une plateforme où **chaque panne a un plan**.
- Cette partie les passe toutes en revue : ce que fait Lumen3D, ce que vous voyez, ce que vous avez à faire.
- Quatre familles : **l'image** (briques, carte graphique), **les données** (import, migration, métadonnées), **le serveur** (mise à jour, accès) et **le navigateur**.
:::

Trois principes guident tous les replis. Ils expliquent pourquoi la réponse est presque toujours « le reste continue ».

:::: cards
::: card
#### Dégrader, pas planter
Moins de détail vaut mieux qu'un onglet figé. On passe au niveau plus grossier, on écarte la brique douteuse, on affiche un message.
:::
::: card
#### Tout ou rien
Une publication, une conversion ou une mise à jour s'applique **en entier** ou pas du tout. Jamais de moitié de dataset en ligne.
:::
::: card
#### Reprendre, pas recommencer
Les opérations longues tiennent un **journal** : après une coupure, elles reprennent là où elles en étaient.
:::
::::

::: analogy
**Une ceinture, des bretelles et un gilet.** Chaque risque a son filet de sécurité, et souvent deux : la brique corrompue est retentée *puis* écartée ; le serveur est testé avant *puis* après la bascule.
:::

## 19.9 À l'écran : briques, workers et métadonnées

Une brique traverse trois étapes (réseau, décodage, carte graphique). Chacune a son repli.

![Les trois étapes d'une brique et le repli de chacune.](img/ch19/replis-brique.svg){width=100%}

| Si… | Ce que fait Lumen3D | Ce que vous voyez ou devez faire |
|---|---|---|
| Une **brique est corrompue** (décodage impossible, taille inattendue) | Elle est **signalée** (`onBrickError`) et **jamais livrée** à la carte graphique ; 3 essais, avec 0,5 s puis 1 s d'attente | Le reste du volume s'affiche. Rien à faire |
| Un **pack ne répond plus** (rien ne passe pendant 30 s) | Le téléchargement est abandonné, puis retenté (3 essais) | Une barre de progression qui repart. Rien à faire |
| Une brique est **absente du fichier** d'index | Ce n'est pas une panne : une brique entièrement vide n'est pas stockée, c'est un volume de zéros (chapitre 7) | Rien : c'est du vide |
| Un **worker de décodage plante** ou se fige plus de 30 s | Il est remplacé (3 fois au plus) et sa tâche repart ; sans worker, le décodage se fait dans la page | Un léger ralentissement, jamais un onglet figé |
| Un **autre jeu est ouvert** pendant un chargement | Le lot de téléchargement en cours est annulé (raison `dataset-switch`), sans erreur | Rien : l'ancien jeu cesse simplement d'être chargé |
| Le jeu change de dossier de briques en cours de route | Les tâches planifiées sur l'ancien dossier sont refusées (`BRICKS_MOUNT_CHANGED`) plutôt que mélangées | Rien : le chargement est replanifié |
| La carte graphique n'offre **pas les textures 3D** (WebGL2 absent) | Refus **avec un message** ; l'onglet ne plante pas | Utilisez un navigateur ou un ordinateur récent |
| Le fichier de **métadonnées est mal formé** | Il est **rejeté en entier**, jamais monté en partie : racine qui n'est pas un objet, dimensions x/y/z invalides, nombre de canaux incohérent, tailles de voxel invalides… | Un message donne la raison ; l'administrateur corrige le jeu |
| Un **bloc facultatif** est mal formé (stabilisation, suivi cellulaire, galerie…) | Ce bloc seul est **écarté avec un avertissement** ; le jeu se monte sans cette fonction | Le volume s'affiche, sans la couche concernée |
| Le jeu a **plus de 4 canaux** | Le pipeline les a tous écrits ; le viewer en dessine **quatre** (texture RGBA) et le dit au montage | Les quatre premiers canaux sont visibles |
| La **calibration est absente** | Pas de barre d'échelle 3D ; une mesure de distance 3D est **refusée** ; dans le Studio, les mesures se font en pixels. Aucune échelle n'est inventée (chapitres 9 et 12) | L'échelle n'apparaît pas |
| Vous cliquez **à côté du spécimen** pour mesurer | Le point tombe sur la boîte englobante, rien de visible dessous : il est **refusé** avec une notice | Cliquez sur la structure elle-même |
| Un **panneau de Comparer** n'arrive pas à s'ouvrir | Son erreur (`PANEL_ERROR`) est affichée sur lui seul, avec un bouton **Réessayer** ; l'enregistrement et le lien n'attendent pas ce panneau | Les autres panneaux continuent |
| Un **plugin** est non reconnu, modifié ou incompatible | Il n'est **pas chargé** (mis en quarantaine) ; les autres plugins ne sont pas touchés | Le bouton n'apparaît pas (chapitres 15 et 19.4) |
| Un **lien `#state=`** est trop gros ou altéré | Il n'est pas appliqué (au-delà de 2 Mio de texte, ou 16 Mio une fois décompressé, il est refusé) ; la page s'ouvre sur sa vue normale | Le lien ne restaure rien ; la page fonctionne |
| Le **stockage du navigateur est bloqué** (navigation privée) | Toute lecture ou écriture est protégée : la page fonctionne, simplement sans mémoire | Thème, langue, réglages ne sont pas retenus |

::: tech
Le plafond de **2 Mio** de texte et de **16 Mio** décompressés, comme celui de **64 Kio** écrits dans l'adresse, protègent contre une « bombe de décompression » : un petit lien qui s'étendrait en gigaoctets. Voir l'annexe B pour toutes les mémoires du navigateur.
:::

## 19.10 La carte graphique : mémoire pleine et contexte perdu

La mémoire de la carte graphique est le seul vrai plafond dur. Lumen3D la **planifie avant** de s'en servir (chapitre 10), mais une carte peut quand même refuser, ou se réinitialiser en pleine image.

![Perte du contexte graphique : un seul rechargement automatique, puis un garde-fou.](img/ch19/perte-contexte.svg){width=100%}

| Si… | Ce que fait Lumen3D | Ce que vous voyez ou devez faire |
|---|---|---|
| Le niveau demandé **dépasse le budget** de mémoire | Il n'est pas alloué : refus `SVR_OVER_BUDGET`, passage au niveau **plus grossier** suivant | Un message d'état dit que le niveau n'a pas pu être alloué et que le suivant est essayé |
| La carte **refuse une allocation** malgré le budget | Refus `SVR_ALLOC_FAILED` ; le budget est plafonné **sous la taille ayant échoué** pour toute la session, puis niveau plus grossier | Même message ; une qualité plus basse s'affiche |
| **Aucun niveau** ne tient | Le chargement est déclaré indisponible (mémoire insuffisante à tous les niveaux) | Fermez d'autres onglets, ou choisissez une qualité plus basse |
| Le **contexte WebGL est perdu** (pilote, veille, trop de mémoire) | Textures libérées, flux arrêtés ; le budget est **divisé par deux** (plancher 256 Mio), mémorisé une semaine | Un message d'état : le contexte graphique est perdu, en attente de son retour |
| Le contexte est **rendu** | Le dernier affichage est rechargé avec le budget réduit | Un message d'état : contexte restauré, rechargement avec un budget plus bas |
| **3 pertes en moins de 120 s** | Le rechargement automatique **s'arrête** (sinon la boucle bloquerait le GPU) | Choisissez une qualité plus basse ou rechargez la page |
| Une image au repos est **trop longue** (plus de 200 ms) | Le plafond d'échantillons par rayon est réduit (chapitre 9) ; une perte de contexte le divise par deux | L'image est un peu moins fine, la vue reste fluide |
| Vous voulez **forcer un budget** | Réglage de l'opérateur : la clé `lumen3d.vramBudgetMB` du navigateur remplace l'estimation | Annexe B |

::: why
**Pourquoi diviser le budget ?** Une perte de contexte vient souvent d'un pilote qui coupe une image trop longue ou d'une mémoire saturée. Recharger avec la même demande referait la même erreur : on demande donc **moins** la fois suivante.
:::

## 19.11 Imports, conversions et métadonnées

Un import de plusieurs gigaoctets dure des heures : la coupure est la règle, pas l'exception. Tout repose sur un **journal** (chapitre 17).

![Pendant un import : quatre pannes, quatre réactions.](img/ch19/coupure-import.svg){width=100%}

| Si… | Ce que fait Lumen3D | Ce que vous voyez ou devez faire |
|---|---|---|
| Le **réseau est coupé** pendant un import | Le transfert passe en attente (sans compter d'échec), sonde le réseau (2 s, puis jusqu'à 15 s) et reprend seul | Le message « Connexion perdue : le transfert reprendra tout seul dès que le réseau revient », puis la reprise |
| Le serveur répond **5xx, 429** ou une somme de contrôle fausse | Jusqu'à **6 essais**, attente de 1 s doublée jusqu'à 30 s | Si tout échoue : fichier en échec, bouton **Réessayer** |
| La **session expire** pendant l'import | Arrêt net, avec le message « Session expirée — reconnectez-vous puis reglissez le dossier » | Reconnectez-vous et reglissez : reprise **au morceau près** |
| Le **disque est plein** | Avant d'écrire, le besoin est comparé à la place libre ; en cours de route, erreur 507 avec « besoin / libre » | Libérez de la place puis reprenez |
| Vous **fermez l'onglet** en plein import | Le journal du serveur garde les morceaux reçus (carte binaire des morceaux) | Reglissez le dossier : seuls les morceaux manquants repartent |
| Un morceau est **envoyé deux fois**, ou dans le désordre | Écrit à sa position exacte ; renvoyé, il est sans effet | Rien |
| Un fichier est **interdit** (`.php`, `.js`, fichier caché, chemin avec `..`) | Refusé **avant** toute écriture, par la liste blanche | Le fichier est listé comme refusé |
| Un **dossier de type inconnu** est déposé, ou le type annoncé ne correspond pas au dossier | Refusé (`metadata_type_mismatch`, `metadata_bad_type`) ; l'éditeur dit « type invalide » | Seuls `3d`, `2d` et `live` existent (chapitre 17) |
| Un **pack est tronqué** ou manquant | La publication est **refusée** : l'index des briques doit pointer dans des packs assez longs (`incomplete_files`) | Terminez le transfert, puis publiez |
| Un **fichier inattendu** traîne dans l'espace d'attente | Publication refusée (`stray_files`) plutôt que de l'emporter dans le site | Supprimez-le ou refaites l'import |
| `metadata.json` est **absente, illisible ou invalide** | Publication refusée avec la liste des erreurs (`missing_metadata`, `metadata_no_dimensions`, `metadata_bad_dimensions`…) | Corrigez dans l'éditeur du jeu |
| Un **manifeste** annonce une brique ≠ 64 ou des niveaux dans le désordre | Refusé à l'import, par les deux serveurs | Refaites passer le pipeline |
| Le dataset source **change pendant une conversion** | Le travail est invalidé (`source_changed`) plutôt que de mélanger deux versions | Relancez la conversion |
| Une conversion est **interrompue** (onglet fermé, serveur redémarré) | Le journal et le stock de tuiles sont communs au navigateur et au serveur : reprise au même point, même avec l'autre exécutant | Rouvrez l'onglet [Mises à jour des données]{.ui} |
| La **finalisation** d'une conversion est interrompue | Elle est reprenable (`complete:false` tant qu'elle n'est pas finie), puis remplace l'ancien contenu d'un seul geste | Relancez : elle se termine |
| Une **unité tue deux fois la requête** (hôte à temps limité) | Réponse `unit_timeout` : cette conversion bascule sur le navigateur ; les autres unités gardent leur progrès | Rien : le travail continue |
| L'**hôte ne répond plus** ou refuse (429, 503) | Le régulateur de requêtes divise son rythme et fait une pause (5 s, doublée jusqu'à 60 s) | Une conversion plus lente, jamais d'inondation |
| Le serveur **ne sait pas décoder le WebP** ou le navigateur ne sait pas l'encoder sans perte | Une sonde de capacité le détecte ; l'autre exécutant est proposé | Un message dans l'onglet |
| Le **pipeline est interrompu** en pleine publication | Le marqueur `.swap-in-progress` permet au lancement suivant de **terminer ou d'annuler** l'échange | Relancez le pipeline |
| Un jeu est **republié** par-dessus un jeu existant | Les réglages du laboratoire (masqué, orientation, galerie, stade corrigé…) sont **conservés** | Rien à refaire |

::: example
**Une coupure de 20 minutes.** Vous importez un embryon de 8 Go. À 60 %, le Wi-Fi tombe. Le transfert passe en « hors ligne », sonde toutes les 2 à 15 s, puis reprend seul au retour du réseau : **aucun fichier n'est perdu** et aucun essai n'est compté. Si vous aviez fermé l'ordinateur, il suffirait de reglisser le dossier.
:::

## 19.12 Serveur : mises à jour, accès et limites d'hébergement

| Si… | Ce que fait Lumen3D | Ce que vous voyez ou devez faire |
|---|---|---|
| La **nouvelle version ne démarre pas** (serveur Python) | Contrôle à blanc avant la bascule ; après la bascule, sonde `/api/health` (≈ 30 s) ; échec : **retour automatique** à l'ancienne version | Un état « annulée » dans l'onglet Mises à jour |
| Le **serveur s'arrête** pendant la bascule | Un journal reste ; au démarrage suivant, il est soit terminé (version cible atteinte), soit **entièrement défait** | Relancez le serveur |
| La mise à jour échoue sur un **hébergement PHP** | **Pas de retour automatique** : la copie est rejouable sans dégât, un fichier occupé est mis de côté (`.lumen-new`) puis terminé à la requête suivante | Relancez la mise à jour |
| Deux administrateurs **lancent la mise à jour ensemble** | La seconde demande est refusée (`update_in_progress`) | Attendez la fin de la première |
| Le **téléchargement est tronqué** | La taille annoncée est vérifiée, la somme SHA-256 aussi : erreur et abandon | Relancez |
| La **place manque** pour mettre à jour | Le contrôle préalable (même volume, espace disque, dossier de sauvegardes) refuse avant de toucher à rien | Libérez de la place |
| La version **n'est pas signée**, ou la signature est fausse | Elle est **refusée** ; seule l'archive nommée d'après la version et listée dans la liste signée est appliquée | Un refus (`unverifiable_release`) dont la raison est affichée dans l'onglet Mises à jour |
| Le **catalogue de plugins est plus ancien** que le dernier vu | Refusé (numéro de série décroissant : `catalog_rollback`) | Aucun plugin n'est installé depuis ce catalogue |
| Un **plugin devient incompatible** après une mise à jour | Il est mis de côté et réactivé quand une version compatible existe | Voir l'onglet Plugins |
| Vous tapez **dix mauvais mots de passe** | Blocage de 15 minutes pour cette adresse ; les échecs sont comptés avant la vérification | Attendez, ou utilisez le bon mot de passe |
| Votre **session d'administration expire** (8 h) | Les modifications non enregistrées du formulaire sont **conservées** à l'écran | Reconnectez-vous, puis enregistrez |
| Un compteur de visite est **inondé** de requêtes | Deux seaux de jetons (par adresse et global) ignorent l'excédent ; un GET ne compte pas | Rien |
| L'hébergement **limite le temps ou la mémoire** de PHP | Chaque étape de conversion règle son délai ; les grosses unités sont coupées en 8 octants ; les corps de requête sont plafonnés (32 Mio par unité) | Une conversion plus lente, jamais corrompue |
| **Pas d'Internet** | Tout fonctionne : les bibliothèques sont locales ; seules les polices (repli sur celles du système) et les contrôles GitHub de l'administrateur en ont besoin | Mises à jour et catalogue indisponibles |

::: warning
Les replis **protègent**, ils ne **réparent** pas tout. Un pack effacé du disque, une base de métadonnées modifiée à la main, ou un hébergement sans espace libre demandent une action humaine : la plateforme refuse proprement et vous dit pourquoi, c'est tout.
:::

## 19.13 Ce qu'il faut retenir

::: remember
- **Image** : une brique douteuse est écartée, jamais affichée de travers ; la carte graphique est ménagée avant d'être sollicitée.
- **Données** : on publie en entier ou pas du tout ; les opérations longues se **reprennent**.
- **Serveur** : Python revient seul à l'ancienne version ; PHP se relance sans risque, mais à la main.
- **Aucune coupure** (réseau, onglet, session) ne fait perdre un import commencé.
:::
