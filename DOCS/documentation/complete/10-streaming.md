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

![La ligne de progression en bas à gauche du viewer : qualité, pourcentage de briques traitées et étape en cours (le texte de cette ligne est en anglais, même quand l'interface est en français).](img/ch10/progression.png){.shot width=70%}

Le pourcentage est la part des briques **déjà traitées** (déposées ou abandonnées), pas des octets téléchargés. La ligne disparaît quand le niveau est complet.

## 10.2 Le menu de qualité : 512, 1024, Natif

La pyramide de niveaux a été fabriquée par le pipeline (chapitre 6) : chaque niveau a **4 fois moins de voxels en X × Y** que le précédent. Le menu choisit **le plus fin des niveaux qui reste raisonnable** pour le réglage demandé.

![La pyramide réelle du jeu de démonstration E9.5 et la règle des trois qualités.](img/ch10/pyramide.svg){width=100%}

| Réglage | Niveau retenu (format 4) |
|---|---|
| **512** (défaut) | le niveau le plus fin dont le plus grand côté XY est **≤ 768 voxels** |
| **1024** | le niveau le plus fin dont le plus grand côté XY est **≤ 1 536 voxels** |
| **Natif** | toujours le **niveau 0** (pleine résolution) |

::: example
Jeu **fictif** de 3 072 × 2 304 voxels en XY, niveaux à 3 072, 1 536, 768 et 384 :

- **512** → niveau à 768 (≤ 768) ; **1024** → niveau à 1 536 (≤ 1 536) ; **Natif** → 3 072.

Sur le jeu de démonstration E9.5, le plus grand côté est 768 : les trois réglages tombent sur le niveau 0. Le menu **n'affiche alors qu'une seule option**, avec les vraies dimensions : [Natif (768x576x112)]{.ui}.
:::

![Le panneau [Qualité de Rendu]{.ui} : une seule ligne par niveau réellement distinct (ici une seule, avec ses dimensions), la ligne d'état (« 512x512 actif ») et, dessous, le sélecteur [Détail au zoom]{.ui} (section 10.8).](img/ch10/qualite-liste.png){.shot width=45%}

::: note
Le viewer s'ouvre en qualité **512**. Un changement de qualité qui échoue laisse le volume précédent à l'écran et remet le menu en place.
:::

## 10.3 L'atlas GPU et la table des pages

Une brique de 64³ voxels est trop petite pour mériter sa propre texture ; en créer des centaines serait ingérable. Le viewer réserve donc en mémoire vidéo **de grands blocs d'emplacements identiques** : l'**atlas**.

::: analogy
L'atlas est un **entrepôt** dont toutes les étagères ont la même taille. La **table des pages** est la **fiche d'index** à l'entrée : « la brique n° 17 est sur l'étagère 4 ». Quand le rayon a besoin d'un voxel, il consulte la fiche, puis va directement à la bonne étagère. Si la fiche dit « vide », il ne se déplace même pas.
:::

![L'atlas et sa table des pages.](img/ch10/atlas.svg){width=100%}

- **Une case de la table par brique** du volume : numéro de page + emplacement, ou « vide ».
- Jusqu'à **8 pages** d'atlas, de 4, 8 ou 16 emplacements de côté.
- **1 à 4 canaux** par voxel, un octet chacun : 1 canal = 1 octet par voxel, 2 canaux = 2, 3 ou 4 canaux = 4.
- Quand tous les emplacements sont occupés, on **recycle le moins récemment utilisé**.
- L'atlas est **dimensionné avant d'être alloué** : jamais de texture créée au hasard par brique.

::: tech
Un petit volume reste d'un seul tenant : si le niveau tient dans moins de **512 Mio** (en 4 octets par voxel) et dans les limites de la carte, il est stocké dans **une seule texture 3D** dense. Le jeu E9.5 au niveau 0 en est un exemple : 768 × 576 × 112 × 4 octets ≈ **189 Mio**. L'atlas à pages ne sert que pour les gros niveaux.
:::

## 10.4 Le budget de mémoire vidéo

Aucun navigateur ne dit combien de mémoire vidéo il reste. Le viewer **l'estime** d'après le type de carte graphique et, si disponible, la mémoire de l'appareil.

![Le budget estimé selon le type de carte graphique (1 Gio = 1 024 Mio).](img/ch10/vram.svg){width=95%}

| Type de GPU | Budget estimé |
|---|---|
| Logiciel (pas de vraie carte graphique) | **256 Mio** |
| Intégrée (Intel, Apple…) | de **0,5 à 2 Gio** selon la mémoire de l'appareil |
| Dédiée (NVIDIA, Radeon…) | **4 Gio** (3 Gio si l'appareil déclare moins de 8 Go) |
| Inconnue | 1 ou 2 Gio |

Chaque **perte de contexte** graphique de la dernière semaine **divise le budget par deux** (plancher : 256 Mio). L'administrateur peut le fixer à la main si besoin.

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

## 10.8 Le mode « Détail au zoom »

Vous zoomez fort sur une zone : les voxels du niveau choisi deviennent plus gros que l'écran n'en a besoin, l'image paraît floue. Le mode [Détail au zoom]{.ui} charge alors **des briques plus fines, seulement dans la zone visible**.

![Le niveau choisi partout (bleu), et des briques plus fines uniquement dans la vue (vert).](img/ch10/roi.svg){width=95%}

| Option | Effet |
|---|---|
| [Automatique]{.ui} | actif si le budget mémoire dépasse **1 Gio** |
| [Activé]{.ui} | actif même sous 1 Gio |
| [Désactivé]{.ui} | jamais |

- **Déclencheur** : un voxel du niveau courant couvre **plus de 1,5 pixel d'écran**.
- Le niveau retenu est **le plus grossier** des niveaux plus fins qui descend sous 1,5 pixel par voxel (le moins d'octets possible).
- Le chargement démarre **350 ms** après que la caméra s'est arrêtée, 8 briques à la fois, **les plus grosses et les plus centrales d'abord**. Il utilise au plus 768 Mio et 75 % de la mémoire restante.
- À la frontière de la zone fine, l'image passe d'un niveau à l'autre **à une face de brique**, sans fondu.

::: warning
Le mode n'existe que pour le **format 4** (briques à bordure). Il est suspendu pendant qu'un volume se charge et dès que vous appliquez un **flou gaussien** à un canal (chapitre 11), car des briques brutes sur un canal flou donneraient une autre image.
:::

Le texte d'état affiche, selon le cas : « Détail : N briques du niveau L visibles », « Détail : chargement de x sur y briques du niveau L », ou « Détail indisponible : mémoire GPU insuffisante ».


## 10.9 Quand la carte graphique plante

Un navigateur peut retirer sa carte graphique à une page (pilote en difficulté, trop de mémoire demandée). Le viewer sait **repartir seul**.

![La reprise après une perte de contexte graphique.](img/ch10/perte-contexte.svg){width=100%}

Vous voyez d'abord « Contexte GPU perdu : le rendu est en pause jusqu'à ce que le navigateur le rende. », puis le volume se recharge en plus léger. Après **trois pertes en moins de 120 secondes**, il s'arrête et vous invite à choisir une qualité plus basse ou à recharger la page.
