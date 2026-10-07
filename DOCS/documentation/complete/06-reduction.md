# 6. Réduire la taille sans rien perdre d'important

::: chapter-intro
- Un embryon de plusieurs gigaoctets ne passe pas sur Internet tel quel : le pipeline le **réduit** en quatre mouvements — 16 → 8 bits, pyramide de résolutions, suppression des briques vides, compression **sans perte**.
- Aucun de ces mouvements ne modifie une intensité du niveau le plus fin : ce que vous voyez à pleine résolution est **exactement** le résultat du nettoyage du chapitre 5.
- Sur le jeu de démonstration : **297 Mo de voxels bruts → 9,3 Mo de briques**, soit environ 32 fois moins.
:::

Tous les chiffres « démo » de ce chapitre sont **mesurés** sur l'embryon synthétique `Embryo-E95-Em2-Pecam1-Sox2` (768 × 576 × 112 voxels, 3 canaux), publié par le vrai pipeline (format 4).

## 6.1 Le budget de taille en chiffres

Prenons d'abord un **gros** embryon du laboratoire : 3789 × 3789 × 178 voxels, 4 canaux. Cela fait 10,2 milliards de voxels.

| Étape | Calcul | Taille |
|---|---|---|
| Voxels bruts, 16 bits | 10,22 G voxels × 2 octets | **20,4 Go** |
| Convertis en 8 bits | 10,22 G voxels × 1 octet | **10,2 Go** |
| + pyramide de résolutions | × 1,286 pour ce découpage | **13,1 Go** |
| Fichier .ims réel de ce type | compressé par Imaris | 14,4 Go |

Les deux dernières étapes (briques vides retirées, compression) dépendent du contenu de l'image. Mesurons-les sur le jeu de démonstration, étape par étape :

![Budget de taille du jeu de démonstration. L'axe est logarithmique : chaque graduation vaut dix fois la précédente.](img/ch06/budget.png){width=100%}

::: keynums
**297 Mo**
16 bits bruts

**149 Mo**
en 8 bits

**103 Mo**
briques non vides

**9,3 Mo**
sur le disque
:::

::: note
La pyramide **ajoute** des octets (+14 % ici) : elle est le prix de l'affichage rapide. Le gain vient des deux étapes suivantes : ne pas stocker le vide, et compresser.
:::

## 6.2 De 16 bits à 8 bits : diviser par deux

C'est la fenêtre du chapitre 5 : un voxel de 2 octets devient un voxel d'1 octet. On perd la finesse des 65 536 niveaux, mais le navigateur n'en affiche que 256 : l'écran ne sait pas montrer plus.

::: warning
C'est **la seule étape qui perd de l'information** (les nuances au-dessus de 256 niveaux), et elle a lieu au chapitre 5, pas ici. Tout ce qui suit dans ce chapitre est **sans perte**.
:::

## 6.3 La pyramide de résolutions

Quand vous regardez l'embryon entier, vous n'avez pas besoin de tous les voxels : l'écran ne compte que quelques millions de pixels. Le pipeline prépare donc **plusieurs versions** de l'image, de plus en plus petites : les **niveaux**.

![Les quatre niveaux du jeu de démonstration, dessinés à l'échelle (projection de l'intensité maximale du canal DAPI). Même forme, de moins en moins de voxels.](img/ch06/pyramide.png){width=100%}

::: analogy
C'est une **carte routière** : la carte du pays pour voyager, la carte de la ville pour se repérer, le plan de la rue pour trouver la porte. On ne charge que la carte utile.
:::

### La règle du format 4

- **Niveau 0** : l'image nettoyée, **telle quelle** (jamais rééchantillonnée).
- **Niveau suivant** : X et Y sont **divisés par 2** (arrondi vers le haut) et leur voxel double.
- **Z est divisé par 2 seulement si** la profondeur du voxel reste inférieure ou égale à **1,5 fois** le nouveau voxel en XY. Sinon Z est gardé.
- On s'arrête quand le plus grand côté en XY est **inférieur ou égal à 128** voxels.

::: why
Un voxel trop « plat » ou trop « allongé » déforme l'image. Diviser Z seulement quand il est encore comparable à XY ramène peu à peu le voxel vers un **cube** (c'est la convention des formats d'images biomédicales modernes, comme OME-Zarr).
:::

### Le calcul d'un voxel du niveau suivant

Chaque voxel du niveau suivant est la **moyenne** d'un bloc de 2 × 2 (× 2) voxels du niveau précédent. Le calcul se fait en **nombres entiers**, **arrondi à la valeur la plus proche, la moitié vers le haut** : (somme + n ÷ 2) ÷ n, partie entière, n étant le nombre de voxels du bloc.

::: example
Bloc réel du jeu de démonstration : 162, 115, 92, 72, 59, 52, 40, 29. Somme = **621**. On ajoute 4 (la moitié de 8), puis on divise par 8 : (621 + 4) ÷ 8 = 78,1 → **78**. Sans l'ajout de 4, on aurait obtenu 77 : le biais aurait assombri chaque niveau.
:::

![Le calcul d'un voxel du niveau suivant, sur un bloc réel du jeu de démonstration.](img/ch06/bloc.svg){width=100%}

Au bord du volume, un bloc peut n'avoir que 1 voxel de large : on ne moyenne alors **que les voxels qui existent**.

### L'échelle du jeu de démonstration

Voxel de départ : 1,2 × 1,2 × 3,0 µm. Pour chaque niveau, la règle de Z est testée avec le **nouveau** voxel XY.

| Niveau | Voxels (X × Y × Z) | Voxel (µm) | Z divisé ? |
|---|---|---|---|
| 0 | 768 × 576 × 112 | 1,2 × 1,2 × 3,0 | (base) |
| 1 | 384 × 288 × 56 | 2,4 × 2,4 × 6,0 | oui : 3,0 ≤ 1,5 × 2,4 = 3,6 |
| 2 | 192 × 144 × 28 | 4,8 × 4,8 × 12,0 | oui : 6,0 ≤ 1,5 × 4,8 = 7,2 |
| 3 | 96 × 72 × 14 | 9,6 × 9,6 × 24,0 | oui : 12,0 ≤ 1,5 × 9,6 = 14,4 |

On s'arrête au niveau 3 : 96 ≤ 128.

::: tech
**Quand Z n'est pas divisé.** Pour une pile 3789 × 3789 × 178 avec un voxel (0,33 ; 0,33 ; 1,876 µm) (tailles de voxel *illustratives*), le niveau 1 garde Z : 1,876 > 1,5 × 0,66 = 0,99. Le niveau 2 le divise : 1,876 ≤ 1,5 × 1,32 = 1,98. Le résultat est 3789 × 3789 × 178 → 1895 × 1895 × 178 → 948 × 948 × 89 → 474 × 474 × 45 → 237 × 237 × 23 → 119 × 119 × 12 (6 niveaux).
:::

::: note
J'ai reconstruit cette pyramide avec les fonctions du pipeline à partir du résultat du chapitre 5, puis comparé aux briques publiées : **358 briques sur 358 identiques**, voxel pour voxel.
:::

## 6.4 Compresser sans rien perdre

### Pourquoi « sans perte » ?

Une compression **avec perte** (JPEG) change légèrement les valeurs pour gagner de la place : acceptable pour une photo de vacances, pas pour une **mesure**. Une compression **sans perte** permet de retrouver chaque voxel à l'identique.

### Comment ça marche, en clair

L'idée : un voxel ressemble à son voisin. Plutôt que de ranger chaque valeur, on range **la différence avec le voisin**, qui est petite et se compresse bien.

![Une vraie ligne de 14 voxels du canal Sox2 (jeu de démonstration). Les différences sont petites ; en les additionnant dans l'ordre, on retrouve les valeurs d'origine.](img/ch06/difference.svg){width=100%}

::: tech
Les compresseurs réels sont plus fins : ils prédisent un voxel à partir de plusieurs voisins (gauche, haut…), puis codent économiquement les écarts, les plus fréquents en premier. Le principe reste celui-ci, et il est exactement réversible.
:::

### Les briques sont des images WebP sans perte

Une brique 3D n'est pas une image 2D. Le pipeline range donc ses 66 coupes côte à côte dans une **mosaïque 594 × 528 pixels** (9 colonnes × 8 lignes ; chapitre 7), et enregistre la mosaïque en **WebP sans perte**.

### La mesure : quatre façons d'enregistrer la même brique

J'ai pris les **269 briques non vides du niveau 0** (3 canaux) du jeu de démonstration et enregistré chaque mosaïque de 594 × 528 pixels de quatre façons.

![Taille moyenne d'une brique. Brut : 313,6 Ko. PNG (meilleure compression) : 31,3 Ko. WebP sans perte (réglage du pipeline) : 29,4 Ko. JPEG qualité 90 : 23,8 Ko, mais avec une erreur allant jusqu'à 22 niveaux de gris.](img/ch06/compression.png){width=90%}

| Format | Taille moyenne | Exact ? |
|---|---|---|
| Brut (non compressé) | 313,6 Ko | oui |
| PNG, niveau 9 optimisé | 31,3 Ko | oui |
| **WebP sans perte** (choix du pipeline) | **29,4 Ko** | oui |
| JPEG, qualité 90 | 23,8 Ko | **non** |

::: warning
**JPEG est le plus petit, mais il est faux.** Sur ces briques : erreur maximale de 22 niveaux (sur 255), **11,7 %** des voxels modifiés, et **1 644 202 voxels qui valaient exactement 0 sont devenus non nuls** (2,2 % du fond). Or le « 0 exact » est ce qui permet de reconnaître une brique vide (6.5) : JPEG le détruirait.
:::

![Zoom sur une coupe de brique (canal Pecam1) : après JPEG, de faibles halos gris apparaissent autour des structures fines, là où l'original est parfaitement noir. La différence est amplifiée 8 fois à droite.](img/ch06/jpeg_artefacts.png){width=95%}

::: why
**Pourquoi WebP plutôt que PNG ?** Sur ces briques, WebP sans perte est seulement **6 % plus petit** que le meilleur PNG (29,4 contre 31,3 Ko). Le code donne une autre raison principale : le navigateur **décode WebP nativement** et vite (`createImageBitmap`), alors qu'il n'existe aucun format d'image 3D. Les tranches 2D de `planes/`, elles, sont en PNG : le viewer les lit avec un petit décodeur PNG maison, jamais via le canevas du navigateur, dont la lecture n'est pas garantie exacte.
:::

::: note
Les octets du pipeline sont reproductibles : en recodant les mosaïques avec les mêmes réglages (Pillow, WebP sans perte, méthode 4), j'ai retrouvé **exactement les mêmes octets** que dans les fichiers publiés. Seule la version de la bibliothèque WebP compte : c'est pourquoi Pillow est épinglé.
:::

## 6.5 Ne pas stocker le vide

Un embryon de souris ne remplit pas son cadre. Beaucoup de briques ne contiennent que du noir : à quoi bon les enregistrer ?

**La règle (format 4) :** une brique est stockée **si et seulement si** son intérieur de 64 × 64 × 64 voxels contient **au moins un voxel ≥ 1**. Pas de tolérance : un seul voxel faible suffit à la garder.

![Niveau 0, canal Pecam1, deux couches de briques. Vert : brique stockée. Rouge : brique vide, non stockée. Les briques sont tracées sur une projection de l'intensité maximale de la couche.](img/ch06/briques_vides.png){width=100%}

Le comptage exact, lu dans `index.bin` du jeu de démonstration (3 canaux) :

| Niveau | Briques possibles | Briques stockées |
|---|---|---|
| 0 | 648 (216 par canal) | **269** (DAPI 100, Pecam1 90, Sox2 79) |
| 1 | 90 | 53 |
| 2 | 27 | 24 |
| 3 | 12 | 12 |
| **Total** | **777** | **358** (46 %) |

::: example
Le canal Pecam1 n'a que **0,75 %** de voxels non nuls, mais **90 briques sur 216** du niveau 0 sont stockées : quelques vaisseaux fins traversent beaucoup de briques. Une brique stockée n'est pas pleine ; elle contient au moins un voxel.
:::

::: note
Une brique **absente** vaut zéro partout, y compris sur son bord de 1 voxel. Le viewer ne la télécharge pas : l'espace vide ne coûte ni octets, ni temps de transfert (chapitre 10).
:::

## 6.6 Taille finale : du .ims au dossier publié

![Du fichier d'origine au dossier publié, pour le jeu de démonstration. Mesures en octets sur le disque (somme des fichiers).](img/ch06/taille_finale.png){width=85%}

| Contenu | Taille |
|---|---|
| Fichier `.ims` d'origine (compressé par Imaris) | 255,8 Mo |
| `bricks/` (affichage 3D) | 9,28 Mo |
| `planes/` (coupes natives, PNG) | 8,64 Mo |
| `mips/` (projections par couche) | 0,47 Mo |
| `thumbnail.webp` + `metadata.json` | 0,04 Mo |
| **Dossier publié (hors `download/`)** | **18,4 Mo** |

::: keynums
**14×**
plus petit que le .ims

**28×**
pour la seule vue 3D

**46 %**
briques stockées
:::

::: warning
Le dossier `download/` (fichier d'origine, TIFF, projections…) n'est pas compté : il ne sert pas à l'affichage. Il pèse 506 Mo ici, car il contient le .ims.
:::

::: remember
- 16 → 8 bits est la **seule** perte, décidée au chapitre 5 ; tout le reste est exact.
- La pyramide : X, Y ÷ 2 à chaque niveau, Z ÷ 2 seulement tant que son voxel ≤ 1,5 × le voxel XY ; moyenne entière arrondie vers le haut ; arrêt à 128 voxels.
- Compression **WebP sans perte** : JPEG est plus petit mais abîme les valeurs et le « 0 exact ».
- Une brique est stockée seulement si son intérieur contient un voxel ≥ 1 : 358 briques stockées sur 777 possibles.
:::
