# 4. Du microscope au fichier Imaris

::: chapter-intro
- Une image 3D est une **pile de coupes** ; chaque case 3D s'appelle un **voxel**, et sa taille réelle en micromètres compte.
- Le fichier **.ims** d'Imaris est un « système de fichiers dans un fichier » (HDF5) : le pipeline y lit seulement la taille de l'image, la calibration, les noms de canaux, l'horloge et les voxels en pleine résolution.
- **L'étape 1** du pipeline écrit un petit fichier `meta.json` : elle ne calcule rien d'autre que la taille du voxel, et n'invente jamais une calibration absente.
:::

## 4.1 Du pixel au voxel

Une photo numérique est une grille de **pixels** : chaque petit carré porte une valeur de gris (ou de couleur). Un microscope confocal ne fait pas une photo, mais une série de photos prises à des profondeurs différentes.

Un point de cette série s'appelle un **voxel** : un pixel qui a aussi une épaisseur. C'est une petite boîte 3D, et c'est l'unité de base de tout ce document.

![Du pixel au voxel. Ici le voxel mesure 1,2 × 1,2 µm dans le plan et 3,0 µm en profondeur : c'est la calibration du jeu de démonstration (embryon synthétique).](img/ch04/voxel.svg){width=95%}

::: analogy
Pensez à une **boîte de Lego** : une plaque plate de plots est une image 2D (pixels). Empilez 112 plaques et chaque plot devient une brique 3D : un voxel. Si vos plaques sont plus épaisses que la largeur d'un plot, vos briques sont « allongées » en hauteur.
:::

::: note
Un voxel **anisotrope** (plus épais en Z qu'en X et Y) est la règle en confocal : changer de profondeur coûte du temps de balayage. Le pipeline en tient compte à chaque étape (voir chapitre 6 pour la pyramide, chapitre 9 pour l'affichage).
:::

## 4.2 Une pile de coupes, plusieurs canaux

Le microscope balaye l'échantillon coupe par coupe, le long de l'axe **Z**. Le jeu de démonstration compte **112 coupes** de 768 × 576 voxels, espacées de 3,0 µm : l'embryon est donc épais de 112 × 3,0 = **336 µm**.

![Une pile confocale : 112 coupes empilées le long de Z (schéma, chiffres du jeu de démonstration).](img/ch04/pile.svg){width=90%}

Un **canal** est une pile complète enregistrée pour un seul fluorophore, c'est-à-dire une seule couleur d'émission. Le jeu de démonstration a **trois canaux** : DAPI (les noyaux), Pecam1 (les vaisseaux) et Sox2 (le tissu neural).

![La même coupe (z = 56) vue dans chacun des trois canaux, puis superposée. Les images viennent du jeu de démonstration (embryon synthétique) ; chaque canal est étiré entre 0 et son 99,9e percentile pour l'affichage.](img/ch04/canaux.png){width=100%}

::: tldr
- 1 canal = 1 pile de coupes = 1 fluorophore.
- Les canaux ne sont **pas mélangés** dans le fichier : chacun a son propre tableau 3D.
- Le mélange de couleurs se fait plus tard, dans le navigateur (chapitre 11).
:::

## 4.3 Combien de niveaux de gris ? 8 ou 16 bits

Chaque voxel porte un **entier** : l'intensité de lumière mesurée. Le nombre de bits dit combien de valeurs sont possibles.

| Profondeur | Valeurs possibles | Plage |
|---|---|---|
| 8 bits | 2⁸ = **256** | 0 à 255 |
| 16 bits | 2¹⁶ = **65 536** | 0 à 65 535 |

Les fichiers Imaris du laboratoire sont en 8 ou 16 bits selon l'acquisition ; le pipeline lit les deux. Le jeu de démonstration est en **16 bits** (type `uint16`).

::: example
Deux taches de fluorescence valent **1 000** et **1 200** sur une échelle 16 bits : 200 niveaux d'écart, très mesurables. Si l'on divisait simplement par 256 pour passer à 8 bits, elles deviendraient **3** et **4** : un seul cran d'écart. C'est pourquoi le pipeline ne divise pas bêtement : il règle d'abord une « fenêtre » adaptée (chapitre 5).
:::

![Un vrai profil de 60 voxels (canal Pecam1, jeu de démonstration) : la courbe bleue garde toutes ses nuances en 16 bits ; en orange, les mêmes valeurs rangées dans des marches de 256. Ici le signal est fort et les marches restent discrètes ; sur un signal faible, elles écrasent les détails.](img/ch04/profondeur.png){width=80%}

## 4.4 Un .ims est un « disque dur dans un fichier »

Un fichier **.ims** est un conteneur au format **HDF5**. Imaginez un dossier de dossiers : on y trouve des groupes (les dossiers), des attributs (de petites étiquettes de texte) et des tableaux (les voxels).

![Les chemins réellement lus par le pipeline dans le .ims du jeu de démonstration. En violet : les métadonnées (étape 1). En vert : les voxels (étape 2).](img/ch04/arbre.svg){width=100%}

::: example
Dans le fichier de démonstration, `DataSetInfo/Image` contient les attributs `X = 768`, `Y = 576`, `Z = 112`, `ExtMin0 = 0.000`, `ExtMax0 = 921.600` et `Unit = um`. Tout est écrit sous forme de **texte** : le pipeline le convertit en nombres.
:::

::: tech
Les attributs HDF5 sont parfois stockés comme tableaux d'octets ASCII ; `attr_str` (étape 1) les recolle en texte. Les tableaux de voxels sont compressés (gzip) par blocs de 16 × 64 × 64 voxels : le pipeline lit toujours des sous-boîtes, jamais plus que la taille déclarée.
:::

## 4.5 La pyramide d'Imaris : ignorée

Imaris range souvent, à côté du niveau 0 (pleine résolution), des versions réduites : `ResolutionLevel 1`, `2`… C'est sa propre pyramide, pensée pour sa propre fenêtre d'affichage. Le jeu de démonstration n'en contient pas : seul le niveau 0 existe. Un fichier réel du laboratoire en a plusieurs.

Le pipeline **n'utilise que le niveau 0**, et jamais les autres, pour le volume.

::: why
La pyramide d'Imaris est calculée sur les données **brutes**, avec ses propres tailles de blocs : elle ne correspond ni au découpage en briques de Lumen3D, ni au nettoyage du chapitre 5. Mieux vaut nettoyer le niveau 0 puis fabriquer **sa propre pyramide** à partir du résultat (chapitre 6) : chaque niveau est alors cohérent avec les autres.
:::

## 4.6 L'étape 1 : lire les métadonnées

L'étape 1 (`1-ims_metadata.py`) ouvre le .ims, lit quelques attributs et écrit `meta.json`. Elle ne touche aucun voxel.

| Champ de `meta.json` | Ce que c'est | Valeur (démo) |
|---|---|---|
| `width`, `height`, `depth` | Nombre de voxels en X, Y, Z | 768, 576, 112 |
| `n_channels` | Nombre de canaux | 3 |
| `n_timepoints` | Nombre d'images dans le temps | 1 |
| `voxel_size` | Taille d'un voxel en µm (x, y, z) | 1,2 ; 1,2 ; 3,0 |
| `extent` | Boîte de l'image en µm (min, max) | 0 → 921,6 / 691,2 / 336,0 |
| `timestamps` | Heure de chaque image | 2026-03-11 10:00:00 |
| `time_interval_minutes` | Intervalle médian entre images | vide (une seule image) |
| `channel_names` | Noms des canaux | DAPI, Pecam1, Sox2 |

::: note
Le nombre d'images détermine le **type** de dataset : une seule image donne un dataset `3d` ; plusieurs donnent un `live` (séquence temporelle). C'est l'étape 1 qui tranche.
:::

Les noms de canaux sont nettoyés : tout ce qui suit un caractère nul est supprimé, et un nom vide ou du type « ch1 » devient « Channel 1 », « Channel 2 »… Les couleurs ne viennent pas du .ims : elles sont attribuées plus tard, avec une palette fixe (chapitre 8).

## 4.7 La calibration : la taille du voxel

Le fichier ne donne pas la taille du voxel directement. Il donne la **boîte** (ExtMin / ExtMax) et le nombre de voxels. Le pipeline divise.

![Taille du voxel = (ExtMax − ExtMin) ÷ N, axe par axe. Valeurs du fichier de démonstration (embryon synthétique).](img/ch04/calibration.svg){width=100%}

::: example
Sur X : (921,6 − 0) ÷ 768 = **1,2 µm**. Sur Z : (336,0 − 0) ÷ 112 = **3,0 µm**. On divise par N (et non par N − 1), choix voulu par le code.
:::

Si l'unité du fichier n'est pas des µm, elle est d'abord convertie :

| Unité dans le fichier | Facteur vers µm |
|---|---|
| `um`, `µm`, `micron`… | × 1 |
| `nm` | × 0,001 |
| `mm` | × 1 000 |
| `m` | × 1 000 000 |

::: warning
**La calibration n'est jamais inventée.** Si `ExtMin/ExtMax` manquent ou si l'unité est inconnue, les trois tailles de voxel valent 0 et `extent` est vide ; la plateforme enregistre `calibrationStatus = metadata-missing` : aucune barre d'échelle ne sera inventée.
:::

## 4.8 L'horloge d'une séquence temporelle

Pour un film (plusieurs images), Imaris note l'heure de chaque image : `TimePoint1`, `TimePoint2`… (la numérotation commence à 1 ici, alors que les tableaux de voxels commencent à 0).

L'étape 1 convertit ces textes en dates, puis calcule l'**intervalle médian** entre images successives. La **médiane** (valeur du milieu) résiste à un retard ponctuel : une image décalée de quelques minutes ne fausse pas l'intervalle annoncé.

![Exemple sur le jeu de démonstration en séquence (4 images, une toutes les 30 minutes). L'intervalle médian, 30 minutes, devient `time_interval_minutes`.](img/ch04/horloge.svg){width=100%}

::: remember
- Le voxel = une case 3D ; sa taille vient de **(ExtMax − ExtMin) ÷ N**.
- Seul le niveau 0 du .ims est lu ; la pyramide d'Imaris est ignorée.
- Les noms de canaux, l'horloge et la calibration sont lus ; **rien n'est deviné**.
:::
