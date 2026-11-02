# 10. Afficher des gigaoctets : le streaming

::: chapter-intro
- Le navigateur ne charge **jamais** tout le volume : il télécharge des **briques** (petits cubes de 64³ voxels) du centre vers l'extérieur et les range dans la mémoire de la carte graphique.
- Une première image apparaît dès que **25 %** des briques sont en place ; la qualité monte ensuite sans bloquer l'écran.
- Si la mémoire graphique est insuffisante, le viewer choisit tout seul un **niveau plus grossier** et vous le dit.
:::

## 10.1 La séquence de chargement

Quand vous ouvrez un jeu de données, sept étapes s'enchaînent. Vous ne les voyez pas toutes, mais elles expliquent pourquoi l'image devient nette **progressivement**.

![Du clic à l'image : sept étapes qui se chevauchent.](img/ch10/sequence.svg){width=100%}

::: steps
1. **Manifeste.** Le viewer lit le « plan » du jeu de données (`bricks/manifest.json`) : niveaux de la pyramide, taille des briques, fichiers de paquets.
2. **Qualité.** Le menu [Qualité de Rendu]{.ui} se traduit en un niveau de la pyramide (section 10.2).
3. **Gros grain d'abord.** À la première ouverture, le niveau **le plus grossier** est chargé en premier : quelques briques, une image en un clin d'œil.
4. **Niveau demandé.** Le niveau choisi se charge ensuite en arrière-plan.
5. **Du centre vers l'extérieur.** Les briques sont classées par distance au centre, **mesurée en micromètres** (pour que la forte épaisseur des voxels en Z ne fausse pas le « centre »).
6. **Décodage.** Des « ouvriers » (workers) décodent chaque brique hors de la page (section 10.5).
7. **Atlas.** La brique décodée est copiée à sa place dans la mémoire de la carte graphique (section 10.3).
:::

::: remember
La **première image** s'affiche quand **25 %** des briques du niveau en cours sont sur la carte graphique ; la carte « chargement » disparaît alors. Les redessins dus aux briques qui arrivent sont groupés (au plus un toutes les 250 ms).
:::

### Où voir la progression

![La ligne de progression en bas à gauche du viewer : qualité, pourcentage de briques traitées et étape en cours (le texte suit la langue de l'interface, par exemple « Diffusion des briques 1024x1024 (LOD…, N briques)... »).](img/ch10/progression.png){.shot width=70%}

Le pourcentage est la part des briques **déjà traitées** (déposées ou abandonnées), pas des octets téléchargés. La ligne disparaît quand le niveau est complet.

## 10.2 Le menu de qualité : résolutions et compressions

Le menu [Qualité de Rendu]{.ui}, dans la barre latérale, choisit une **résolution** (un niveau de la pyramide, chapitre 6) et, sur les formats récents, une **compression**. Ce qui s'affiche dépend du format du jeu de données.

| Format du jeu | Ce que propose le menu |
|---|---|
| 1 à 4 | une liste : 256 × 256, 512 × 512, 1024 × 1024, natif |
| 5 | deux listes, [Résolution]{.ui} et [Qualité]{.ui}, et le bouton [Comment choisir ?]{.ui} |
| 6 (**format actuel**) | la liste des [Résolutions]{.ui} et la case [Chargement rapide]{.ui} |

### Formats 1 à 4 : 512, 1024, Natif

Le viewer s'ouvre en qualité **512**. Un changement de qualité qui échoue laisse le volume précédent à l'écran et remet le menu en place.

| Réglage | Niveau retenu |
|---|---|
| **512** (défaut) | le niveau le plus fin dont le plus grand côté XY est **≤ 768 voxels** |
| **1024** | le niveau le plus fin dont le plus grand côté XY est **≤ 1 536 voxels** |
| **Natif** | toujours le **niveau 0** (pleine résolution) |

![La pyramide réelle du jeu de démonstration E9.5 et la règle des trois qualités.](img/ch10/pyramide.svg){width=100%}

::: example
Jeu **fictif** de 3 072 × 2 304 voxels en XY, niveaux à 3 072, 1 536, 768 et 384 :

- **512** → niveau à 768 (≤ 768) ; **1024** → niveau à 1 536 (≤ 1 536) ; **Natif** → 3 072.

Sur le jeu de démonstration E9.5, le plus grand côté est 768 : les trois réglages tombent sur le niveau 0. Le menu **n'affiche alors qu'une seule option** par niveau réellement distinct, avec les vraies dimensions : [Natif (768x576x112)]{.ui}.
:::

### Format 6 : les résolutions et [Chargement rapide]{.ui}

Un jeu au format 6 stocke chaque résolution **deux fois**, côte à côte : en **version sans perte** et en **WebP qualité 30** (chapitre 7).

- Le menu ne propose que les **résolutions**. Chaque ligne donne le niveau, ses dimensions et la **mémoire graphique** qu'il occupe.
- La case [Chargement rapide]{.ui}, **cochée par défaut**, choisit la version affichée :
  - **cochée** : la version WebP qualité 30, téléchargements légers ;
  - **décochée** : la version sans perte de la même résolution, téléchargements plus gros, voxels exacts.
- Le réglage est gardé dans ce navigateur seulement.
- Si la carte graphique ne tient pas la résolution choisie, le menu l'indique et le viewer affiche le niveau plus grossier.

![Le menu Qualité de Rendu d'un jeu au format 6 (capture de test) : la liste des résolutions et la case Chargement rapide.](img/ch09/quality-format6.png){.shot width=75%}

::: legend
| n | ce que c'est |
|--|----------------------|
| 1 | La liste des **résolutions** : un niveau par ligne, avec ses dimensions et la mémoire graphique (GPU) qu'il occupe. |
| 2 | Le niveau affiché, en surbrillance (ici 512). |
| 3 | La case [Chargement rapide]{.ui}, cochée : la version compressée WebP qualité 30 est affichée. |
:::

::: warning
La case ne change **pas** les exports : ils lisent toujours les voxels **sans perte**, à la résolution affichée (chapitre 12). Elle change en revanche l'image sur laquelle une distance est mesurée.
:::

### Exporter un jeu au format 6

Le [Centre de téléchargement]{.ui} propose deux exports, l'un à côté de l'autre, pour les niveaux que vous cochez :

- **[Exporter .ome.zarr.zip]{.ui}** : les voxels **sans perte**, calibrés en micromètres, lisibles par napari, Fiji ou Python ;
- **[Télécharger .q30.zip]{.ui}** : les briques d'affichage **telles quelles** (WebP qualité 30), pour les outils Lumen3D.

Un export ne demande rien de plus : il prend la résolution affichée, sans question.

### Format 5 : la matrice

Sur un jeu au format 5, la liste [Résolution]{.ui} est croisée avec la liste [Qualité]{.ui} : une case par couple. Chaque case indique le **poids à télécharger** pour ce niveau, et, une fois un téléchargement mesuré, le **temps estimé**.

![Le menu Qualité de Rendu d'un jeu au format 5 (capture de test) : deux listes et le bouton Comment choisir.](img/ch09/quality-format5.png){.shot width=75%}

::: legend
| n | ce que c'est |
|--|----------------------|
| 1 | Le bouton [Comment choisir ?]{.ui} : ouvre le guide complet (figure plus bas). |
| 2 | Le résumé de la qualité affichée : la résolution, la qualité et le poids à télécharger. |
| 3 | La qualité active, en surbrillance (ici **Extra**). |
| 4 | La liste [Qualité]{.ui} : une ligne par compression. **Low** se trouve sous **Medium**, en bas de la liste. |
:::

Les qualités portent les noms affichés suivants :

| Nom | Ce que c'est |
|---|---|
| **Max** | exacte : chaque voxel tel qu'acquis |
| **Extra** | ±2 niveaux de gris sur 256, visuellement sans perte (réglage par défaut pour explorer) |
| **High** | ±4 niveaux de gris, quasi sans perte |
| **Medium** | WebP avec perte, qualité 80 |
| **Low** | WebP avec perte, qualité 50 : le plus léger |

La couleur d'une résolution indique si la carte graphique la tient :

| Couleur | Signification |
|---|---|
| vert | moins de 75 % du budget de mémoire graphique |
| orange | entre 75 et 100 % du budget |
| rouge | au-delà du budget : le viewer affiche le niveau plus grossier suivant |

Le bouton [Comment choisir ?]{.ui} ouvre le guide complet : toutes les combinaisons, la signification des qualités et ce conseil du viewer : la résolution la plus fine affichée en vert, en qualité **Extra** ; pour une mesure ou une figure, **Max** en **Natif**.

![Le guide « Choisir la résolution et la qualité » (capture de test, format 5) : chaque combinaison, sa taille et son temps au débit mesuré.](img/ch09/howto-quality.png){.shot width=70%}

::: warning
Une qualité compressée **change les voxels affichés**, pas les données : les exports « sans perte » lisent la version sans perte au niveau affiché (format 6) ou le plus fin niveau sans perte que la carte tient (format 5, chapitres 7 et 12) ; une distance se mesure sur l'image affichée. Sur un jeu au format 5, l'export demande d'abord quelle qualité prendre.
:::

### Ce que vous choisissez reste

- La case ou la qualité choisie est gardée dans l'espace de travail, dans l'adresse de la page (par exemple `512x512@b2` ou `native@ll`) et dans ce navigateur.
- La page **Comparer** répartit la mémoire entre ses panneaux ; chaque panneau garde sa qualité.

## 10.3 L'atlas GPU et la table des pages

Une brique de 64³ voxels est trop petite pour mériter sa propre texture ; en créer des centaines serait ingérable. Le viewer réserve donc en mémoire vidéo **de grands blocs d'emplacements identiques** : l'**atlas**.

::: analogy
L'atlas est un **entrepôt** dont toutes les étagères ont la même taille. La **table des pages** est la **fiche d'index** à l'entrée : « la brique n° 17 est sur l'étagère 4 ». Quand le rayon a besoin d'un voxel, il consulte la fiche, puis va directement à la bonne étagère. Si la fiche dit « vide », il ne se déplace même pas.
:::

![L'atlas et sa table des pages.](img/ch10/atlas.svg){width=100%}

- **Une case de la table par brique** du volume : numéro de page + emplacement, ou « vide ».
- Jusqu'à **8 pages** d'atlas, de **512 Mio** au plus chacune, ou de **1 Gio** au plus quand le budget dépasse 4 Gio.
- Un voxel occupe **un octet par canal** : 1 canal = 1 octet, 2 canaux = 2 octets, 4 canaux = 4 octets. Trois canaux prennent 4 octets, ou **3 octets** quand l'atlas est scindé en deux textures (carte sans RGTC, rendu logiciel, GPU mobile).
- Quand tous les emplacements sont occupés, on **recycle le moins récemment utilisé**.
- L'atlas est **dimensionné avant d'être alloué** : jamais de texture créée au hasard par brique.

::: tech
Un volume qui tient en une seule texture 3D (ses dimensions et sa taille restent dans les limites de la carte) est stocké **d'un seul bloc**. Un volume plus grand passe par l'atlas à pages. La table des pages tient une entrée RGBA8 par brique de la grille.
:::

### La compression GPU : automatique

Quand la carte graphique le permet, le viewer garde le volume **compressé** dans sa mémoire : blocs **BC4 / BC5**, soit **0,5 octet** par voxel et par canal au lieu de 1. Pour trois canaux, cela fait environ 1,5 octet par voxel contre 4 en RGBA8, et deux fois plus d'instants tiennent en mémoire pour un timelapse. C'est automatique : il n'y a aucun réglage.

La compression n'est **pas** utilisée (le volume reste en octets bruts) quand :

- le rendu est **logiciel** (SwiftShader, llvmpipe) ;
- le GPU est un **GPU mobile** (Adreno, Mali, PowerVR, Xclipse, Immortalis, Vivante, VideoCore) ou le navigateur est **Android** ;
- la carte n'a pas l'extension RGTC, ou le navigateur est en WebGL1 ;
- la compression a déjà fait perdre le contexte graphique sur cet appareil.

::: note
L'image compressée s'écarte d'environ 1 à 2 niveaux de gris. Elle ne sert qu'à l'affichage : le Studio et les exports restent exacts.
:::

## 10.4 Le budget de mémoire vidéo

Aucun navigateur ne dit combien de mémoire vidéo il reste. Le viewer **l'estime** à partir du modèle de la carte, lu dans le nom que le navigateur donne au GPU.

- **Carte reconnue** (NVIDIA, AMD, Intel Arc, dans une table de modèles) : le budget vaut **60 %** de sa mémoire dédiée, en laissant **au moins 2 Gio** au navigateur et au reste du système, avec un minimum de 1 Gio et un plafond de **16 Gio**. Exemple : une RTX 4070 de bureau (12 Gio) donne 60 % de 12 = **7,2 Gio**.
- **Autre cas** : une estimation par classe de carte.

| Cas | Budget estimé |
|---|---|
| Carte reconnue | 60 % de sa mémoire dédiée, voir ci-dessus |
| Rendu logiciel (pas de vraie carte) | **256 Mio** |
| Intégrée (Intel, Apple, mobile) | **2 Gio** si l'appareil déclare 8 Go ou plus ; 1 Gio à partir de 4 Go ; 512 Mio sinon (1 Gio si l'appareil ne déclare pas sa mémoire) |
| Dédiée, modèle inconnu | **4 Gio** (3 Gio si l'appareil déclare moins de 8 Go) |
| Inconnue | **2 Gio** si l'appareil déclare 8 Go ou plus ; sinon 1 Gio |

Chaque **perte de contexte** graphique de la dernière semaine **divise le budget par deux**, jusqu'à quatre fois et sans descendre sous 256 Mio.

::: note
Le panneau ne propose **aucun réglage** de la mémoire graphique : le budget se détecte seul. Seuls des tests ou des outils de l'équipe peuvent le fixer.
:::

### Quand ça ne rentre pas

Avant d'allouer quoi que ce soit, le viewer calcule la taille du niveau demandé. Si elle dépasse le budget, il essaie le niveau **immédiatement plus grossier**, et ainsi de suite.

::: example
Exemple **fictif** : vous demandez **Natif** et le niveau 0 réclame 1,9 Gio pour un budget de 1 Gio : le viewer passe au niveau 1 (environ 4 fois moins), qui rentre. Un avis s'affiche :

« La résolution {demandée} dépasse la mémoire GPU disponible — affichage en {obtenue}. ({nécessaire} Mo nécessaires, {disponible} Mo disponibles pour le volume.) »
:::

Si la carte **refuse** une allocation malgré le calcul, le viewer retombe aussi sur un niveau plus grossier ; l'avis le précise : « (Le GPU a refusé l'allocation.) ». Le volume reste **toujours visible**, jamais un onglet planté.

## 10.5 Télécharger et décoder sans bloquer la page

Décoder une brique (une image WebP à défaire en voxels) est un calcul lourd. Il est confié à un **groupe d'ouvriers** (workers) qui travaillent **en parallèle de la page** : l'interface reste fluide.

- **Nombre d'ouvriers** : `min(8, nombre de cœurs − 1)`, au moins 1.
- **Décodage fidèle** : aucune gestion des couleurs du navigateur n'est appliquée ; les octets sont des **intensités mesurées**, pas des couleurs.
- **Mosaïque** : une brique de 66³ voxels est une image WebP de 594 × 528 pixels (9 × 8 tuiles de 66 × 66) ; une image d'une autre taille est refusée comme corrompue.
- **Pas de copie inutile** : les octets décodés sont transférés tels quels à la page, puis envoyés à la carte graphique.
- Un ouvrier qui plante ou se fige (30 s) est **remplacé** ; la brique est retentée jusqu'à 3 fois, puis comptée comme manquante.

::: warning
Une brique corrompue n'est **jamais** affichée : elle reste vide et le viewer le signale (par exemple : « N briques n'ont pas pu être chargées »). Un flux incomplet n'est pas gardé en mémoire : rechargez pour réessayer.
:::

## 10.6 Les paquets : un téléchargement ordonné

Les briques sont rangées dans des **paquets** (fichiers `.bin`). Télécharger un paquet entier est bien plus efficace que des milliers de petites requêtes.

- **Ordre « paquet par paquet »** : le viewer part de la brique centrale et progresse paquet après paquet ; chaque paquet est téléchargé **une seule fois** et libéré dès que ses briques sont découpées.
- **4 téléchargements de paquets au plus en même temps**, car un navigateur ouvre 6 connexions par serveur : les appels de la page ne doivent pas attendre derrière les gros fichiers.
- **Coupe précise** : pour une coupe ou une image du Studio, on demande seulement les **plages d'octets** utiles.

| Cache (octets compressés) | Taille |
|---|---|
| Paquets entiers, tant qu'un chargement en a besoin | 192 Mio |
| Plages d'octets (coupes) | 64 Mio |
| Préchargement (images voisines d'une série) | 32 Mio |

::: tech
Les briques **décodées** ne sont jamais gardées côté page : l'atlas GPU est leur seul domicile. Chaque adresse de paquet porte un cachet `?v=` (une empreinte des paquets du manifeste) ; le serveur répond alors « à garder un an » : si le jeu de données change, l'empreinte change et le navigateur retélécharge.
:::

## 10.7 Les séries temporelles

Un jeu **live** (série temporelle) contient **un arbre de briques par pas de temps**. Chaque pas de temps est chargé comme un petit volume à part entière.

![Chaque pas de temps a son arbre ; le tampon montre les images déjà en mémoire.](img/ch10/serie-temporelle.svg){width=100%}

![La frise du jeu de démonstration Demo-Lumen3D-E85-Em1-30min-2ch-4tp : lecture, vitesse, curseur de temps et barre de tampon.](img/ch10/live-page.png){.shot width=95%}

- **Lecture** : vitesses **0,5 – 1 – 2 – 5 – 10 – 20 images par seconde** (10 par défaut, mémorisée dans votre navigateur).
- **Une demande à la fois** : si vous déplacez le curseur vite, seule la **dernière** demande est servie.
- **La lecture attend l'image** : l'horloge est suspendue pendant qu'une image charge ; la lecture va à la vitesse réelle d'arrivée.
- **Tampon** : le viewer préserve en mémoire les images voisines (jusqu'à `min(768 Mio, max(128 Mio, 40 % du budget))`). La barre de la frise montre celles **réellement présentes** à la qualité courante. Un texte précise si la série ne tient pas entièrement : « Tampon n/total · qualité — la série entière ne tient pas en mémoire (… images max) ».
- **Préchargement** : pendant la lecture, les paquets des images suivantes (t+1, t+2…) sont préchargés en temps libre.

::: note
Le préchargement complet n'est possible que pour les niveaux stockés en **texture dense** : un niveau en atlas à pages n'est pas préchargé.
:::

## 10.8 Une seule qualité : celle que vous voyez

Il n'existe **pas** de zone de détail : quand vous zoomez fort, le viewer ne télécharge pas de briques plus fines dans la vue. Le volume reste à la **résolution choisie dans le menu**, et c'est cette résolution que vous voyez. Le zoom reste fluide, et l'arrêt de la caméra ne déclenche aucun téléchargement supplémentaire.

- Pour voir plus de détail, choisissez une **résolution plus fine** dans le menu. Le menu indique la mémoire graphique que coûte chaque résolution.
- Un niveau trop grand pour la carte n'est pas affiché : le viewer descend au niveau plus grossier suivant (section 10.4), et l'indique.

::: tip
Pour une **mesure** ou une **figure**, prenez la résolution **native**, en version sans perte (format 6 : case [Chargement rapide]{.ui} décochée ; format 5 : colonne **Max**). C'est sur cette image que les distances sont mesurées.
:::

## 10.9 Quand la carte graphique plante

Un navigateur peut retirer sa carte graphique à une page (pilote en difficulté, trop de mémoire demandée). Le viewer sait **repartir seul**.

![La reprise après une perte de contexte graphique.](img/ch10/perte-contexte.svg){width=100%}

Vous voyez d'abord « Contexte GPU perdu : le rendu est en pause jusqu'à ce que le navigateur le rende. », puis le volume se recharge au **budget divisé par deux** (section 10.4). Après **trois pertes en moins de 120 secondes**, le viewer ne recharge plus seul : il vous invite à choisir une qualité plus basse ou à recharger la page.

::: warning
Si la page affiche un refus de contexte 3D (WebGL), le navigateur a bloqué WebGL après un plantage du pilote. Fermez **entièrement** le navigateur (sur Android : Paramètres › Applications › Chrome › Forcer l'arrêt), puis rouvrez la page. Si cela persiste, vérifiez que l'accélération matérielle est activée.
:::

Sur mobile et sur Android, la compression GPU n'est pas utilisée (section 10.3) : ces appareils gardent le volume en octets bruts.

::: remember
- Le menu choisit une **résolution** ; sur le format 6, la case [Chargement rapide]{.ui} choisit la version compressée ou sans perte.
- Le budget de mémoire se **détecte** : 60 % de la mémoire d'une carte reconnue, avec au moins 2 Gio laissés au reste.
- Une perte de contexte divise le budget par deux ; trois pertes en 120 s arrêtent le rechargement automatique.
:::
