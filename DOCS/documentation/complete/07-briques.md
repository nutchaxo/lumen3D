# 7. Le découpage en briques

::: chapter-intro
- Un volume de plusieurs gigaoctets ne peut pas être chargé d'un bloc : on le découpe en **briques** (des petits cubes de 64 × 64 × 64 voxels) que le navigateur va chercher une par une.
- Chaque brique devient **une seule image WebP** (sans perte) ; les briques sont rangées dans des **paquets**, retrouvées grâce à un **index** de quelques kilo-octets.
- Deux structures annexes, `planes/` et `mips/`, rendent les coupes et les projections rapides ; le tout forme le **format de données 4**.
- Le **format 5** (section 7.11) range le même volume en une **matrice** : plusieurs résolutions × cinq compressions, plus trois copies pour couper vite.
:::

Dans ce chapitre, les images de données (mosaïque, couture, paquets…) viennent toutes du **jeu de démonstration** : l'embryon synthétique `Embryo-E95-Em2-Pecam1-Sox2` (768 × 576 × 112 voxels, 3 canaux), publié par le vrai pipeline. Ce n'est pas une donnée du laboratoire.

## 7.1 Pourquoi découper un volume ?

Un embryon typique du laboratoire fait 3789 × 3789 × 178 voxels sur 4 canaux : environ **10,2 Go** une fois réduit à 8 bits. Aucun navigateur n'avale cela d'un bloc, et vous n'en regardez à chaque instant qu'une petite partie.

::: analogy
**Une carte en ligne.** Quand vous zoomez sur une ville, le site ne télécharge pas la planète : il charge seulement les **tuiles** qui sont dans votre fenêtre, à la bonne finesse. Les briques sont les tuiles de votre embryon, avec une dimension de plus.
:::

![Comme les tuiles d'une carte, seules les briques visibles et non vides sont téléchargées.](img/ch07/tuiles.svg){width=100%}

Trois avantages, tous visibles à l'écran :

- **le début est rapide** : les premières briques arrivent en une fraction de seconde ;
- **la mémoire est bornée** : la carte graphique ne reçoit que ce qu'elle peut loger (chapitre 10) ;
- **le vide ne coûte rien** : une brique entièrement noire n'est jamais écrite sur le disque.

## 7.2 Une brique : 64 voxels utiles et une bordure

Une brique couvre **64 voxels** dans chaque direction. Mais elle est stockée avec **un voxel de plus de chaque côté** : 64 + 1 + 1 = **66**. Ce voxel de bordure est une copie du voxel voisin, pris dans la brique d'à côté.

![Le cœur de la brique (bleu) est entouré d'une bordure d'un voxel (orange) copiée sur les briques voisines (violet).](img/ch07/bordure.svg){width=100%}

::: why
**À quoi sert la bordure ?** Pour dessiner une image lisse, la carte graphique *interpole* : la valeur à un point est un mélange pondéré des voxels qui l'entourent. Au bord d'une brique, il manque le voisin de l'autre côté. Sans bordure, la carte graphique devrait répéter le dernier voxel : on verrait un quadrillage régulier à la limite des briques. Avec la bordure, le voisin est là, et l'image est continue.
:::

La figure suivante le montre sur de vraies données : le même profil d'intensité, à cheval sur la limite entre deux briques (en voxels 56 à 72).

![Sans bordure (rouge) la valeur fait un palier puis saute ; avec bordure (vert) elle varie sans coupure. Jeu de démonstration, canal DAPI.](img/ch07/couture.png){width=85%}

::: example
**Le surcoût de la bordure.** 66³ = 287 496 voxels contre 64³ = 262 144 : **9,7 % de plus** stockés, en échange d'images sans couture à tous les niveaux de qualité.
:::

Deux règles pour les cas limites :

- **hors du volume**, la bordure répète le dernier voxel (« clamp to edge ») ;
- une **brique absente** (vide) vaut zéro partout, bordure comprise : on ne reconstruit jamais une bordure à partir des voisines.

## 7.3 D'un cube à une image : la mosaïque

Le navigateur sait décoder une image 2D très vite, mais n'a pas de format d'image 3D. L'astuce : la brique de 66 coupes est **posée à plat** en une seule image, comme une planche-contact de 66 photos.

![Les 66 coupes d'une brique rangées en 9 colonnes × 8 lignes ; les 6 dernières cases restent vides.](img/ch07/mosaique-schema.svg){width=100%}

Chaque coupe fait 66 × 66 pixels ; la grille fait donc **9 × 66 = 594** pixels de large et **8 × 66 = 528** de haut, en niveaux de gris 8 bits. La règle est simple :

::: example
**Où est la coupe z' ?** Colonne = z' modulo 9, ligne = z' divisé par 9 (division entière).

| coupe z' | colonne | ligne | coin haut-gauche (px) |
|---|---|---|---|
| 0 | 0 | 0 | (0 ; 0) |
| 1 | 1 | 0 | (66 ; 0) |
| 8 | 8 | 0 | (528 ; 0) |
| 9 | 0 | 1 | (0 ; 66) |
| 65 | 2 | 7 | (132 ; 462) |
:::

Pour un voxel (x', y', z') de la brique de 66³, son pixel dans l'image est : **colonne = (z' mod 9) × 66 + x'**, **ligne = (z' div 9) × 66 + y'**. Le voxel intérieur numéro *i* est à l'indice *i* + 1, à cause de la bordure.

Voici une vraie brique du jeu de démonstration, **telle qu'elle est stockée**, à côté de son cube en 3D.

![La brique (7, 5, 0) du canal Sox2 : l'image WebP décodée, avec les numéros de quelques coupes, et le cube reconstitué.](img/ch07/mosaique.png){width=100%}

::: note
Les premières coupes sont noires parce que l'embryon de démonstration n'occupe que le bas de cette brique. Les cases 66 à 71 (les 6 dernières, en bas à droite) sont toujours vides : 72 places pour 66 coupes.
:::

### Une image par canal

Chaque canal a ses **propres** briques : la brique (7, 5, 0) existe en trois exemplaires indépendants (DAPI, Pecam1, Sox2). Le navigateur les assemble en couleur au dernier moment. Un canal peu dense, comme Pecam1 ici, donne une image beaucoup plus petite.

![Les trois canaux de la même brique : même géométrie, contenus et poids différents.](img/ch07/canaux.png){width=92%}

::: tech
**Encodage.** Chaque mosaïque est enregistrée en WebP *sans perte* (bibliothèque Pillow, `lossless=True`, qualité 75, méthode 4) : le voxel relu est identique au voxel écrit. Une brique n'est conservée que si son intérieur 64³ contient **au moins un voxel ≥ 1** ; sinon elle est « absente » (longueur 0 dans l'index). Cette règle est calculée canal par canal.
:::

## 7.4 La grille de briques de chaque niveau

Le chapitre 6 a construit la pyramide de résolutions. À chaque niveau, le volume est découpé en une **grille** de briques : on arrondit au supérieur le nombre de voxels divisé par 64.

| niveau | voxels (x, y, z) | grille de briques | briques stockées (3 canaux) |
|---|---|---|---|
| 0 | 768 × 576 × 112 | 12 × 9 × 2 | 269 |
| 1 | 384 × 288 × 56 | 6 × 5 × 1 | 53 |
| 2 | 192 × 144 × 28 | 3 × 3 × 1 | 24 |
| 3 | 96 × 72 × 14 | 2 × 2 × 1 | 12 |

La grille du niveau 0 compte 12 × 9 × 2 = 216 cases par canal, mais seules 100 (DAPI), 90 (Pecam1) et 79 (Sox2) contiennent du signal : les autres coins sont vides.

![La grille de briques de chaque niveau pour une couche et un canal : en gris, les briques jamais écrites.](img/ch07/niveaux.png){width=92%}

## 7.5 Les paquets : des boîtes de 64 briques

Des milliers de petits fichiers seraient lents à servir. Les briques d'un même niveau et d'un même canal sont donc regroupées dans des **paquets** : `bricks/l0/c1/p00000.bin` est le premier paquet du niveau 0, canal 1.

![Un paquet contient des super-blocs entiers de 4 × 4 × 4 briques : une coupe croise peu de paquets.](img/ch07/superblocs.svg){width=100%}

Les règles de remplissage :

- les briques sont classées par **super-blocs de 4 × 4 × 4** briques voisines ;
- un paquet contient des **super-blocs entiers**, au plus **64 briques** ou **16 Mio** ;
- si un seul super-bloc dépasse la limite, il est coupé dans l'ordre des briques.

::: analogy
**Un déménagement.** On range les cartons pièce par pièce (les super-blocs), pas au hasard dans les camions. Quand vous cherchez « tout ce qui est dans la cuisine », il suffit d'ouvrir un camion.
:::

Dans le jeu de démonstration, le niveau 0 du canal Pecam1 tient dans **deux paquets** (en bleu et orange ci-dessous) : les traits noirs sont les limites des super-blocs.

![Quelles briques dans quel paquet, pour les deux couches du niveau 0 (canal Pecam1).](img/ch07/paquets.png){width=85%}

## 7.6 L'index et le manifeste

Pour récupérer une brique, le navigateur doit savoir **dans quel paquet** elle est, **où elle commence** et **combien elle pèse**. Ces trois nombres sont dans `bricks/index.bin`, un petit fichier binaire : **10 octets par case de brique**.

![Un fichier index.bin : un en-tête, une ligne par niveau, puis une entrée de 10 octets par case de brique.](img/ch07/index-bin.svg){width=100%}

Voici les octets réels du jeu de démonstration, décodés à la main : l'en-tête, puis la brique (7, 5, 0) de chaque canal.

| ce que l'on lit | octets (hexadécimal) | valeur décodée |
|---|---|---|
| début du fichier | `4c 42 49 58` | « LBIX » (la signature) |
| niveaux · canaux | `04 00` · `03 00` | 4 niveaux · 3 canaux |
| niveau 0 | `0c 00 00 00  09 00 00 00  02 00 00 00  06 00 00 00` | grille 12 × 9 × 2, 6 paquets |
| brique (7, 5, 0), DAPI | `01 00  ce d3 07 00  c0 94 02 00` | paquet 1, début 512 974, longueur 169 152 |
| brique (7, 5, 0), Pecam1 | `01 00  88 1c 01 00  a2 30 00 00` | paquet 1, début 72 840, longueur 12 450 |
| brique (7, 5, 0), Sox2 | `00 00  a0 e2 03 00  74 7a 01 00` | paquet 0, début 254 624, longueur 96 884 |

::: tech
**Lecture d'un nombre.** Les octets sont en « petit-boutiste » : `c0 94 02 00` se lit à l'envers, `0x000294c0` = 169 152. Une longueur de **0** signifie « brique absente » (le paquet et le début valent alors aussi 0). Ce fichier fait 12 + 4 × 16 + 7 770 = **7 846 octets** ; sur un grand embryon, l'ancien manifeste JSON pesait 7,6 Mo contre 233 ko pour l'index binaire.
:::

À côté de l'index, `bricks/manifest.json` décrit le jeu de briques en clair. Extrait réel (abrégé) :

```json
{"schema":"iribhm-bricks-v3", "formatVersion":4, "channels":3,
 "brickSize":64, "apron":1,
 "brickPacking":{"mode":"grid","cols":9,"rows":8,"slice":66},
 "encoding":"webp-lossless",
 "levels":[{"level":0, "dimensions":{"x":768,"y":576,"z":112},
            "voxelSize":{"x":1.2,"y":1.2,"z":3.0},
            "gridSize":{"x":12,"y":9,"z":2}, "brickCount":269}, ...],
 "index":{"url":"index.bin", "bytes":7846, "sha256":"aea09808…"},
 "histograms":[...]}
```

La signature `sha256` de l'index est vérifiée avant usage : un index altéré est refusé. Les `histograms` servent aux curseurs de contraste (chapitres 8 et 11).

## 7.7 L'arbre d'un jeu de données publié

Voici le contenu réel du dossier du jeu de démonstration (abrégé ; les tailles sont celles du disque).

```
3d/Embryo-E95-Em2-Pecam1-Sox2/
├── metadata.json            1,8 ko   les faits du jeu de données
├── thumbnail.webp          33,6 ko   la vignette
├── bricks/                  9,3 Mo   les briques (format 4)
│   ├── manifest.json        3,7 ko
│   ├── index.bin            7,8 ko
│   ├── l0/ c0/ p00000.bin  1,4 Mo    niveau 0, canal 0
│   │       │   p00001.bin  3,9 Mo
│   │       c1/ …  c2/ …
│   └── l1/ l2/ l3/ …                 niveaux plus grossiers
├── planes/                  8,6 Mo   un fichier par plan Z
│   ├── manifest.json
│   └── z00000.bin … z00111.bin       (112 fichiers)
├── mips/                  473 ko     un fichier par couche de 64 plans
│   ├── manifest.json
│   └── l00000.bin  l00001.bin
└── download/                         (voir chapitre 8)
```

::: note
Les niveaux se répartissent ainsi : niveau 0 = 7,9 Mo, niveau 1 = 1,1 Mo, niveau 2 = 0,18 Mo, niveau 3 = 0,03 Mo. Les niveaux grossiers sont minuscules : c'est pourquoi une première image apparaît presque instantanément.
:::

## 7.8 `planes/` : une coupe XY sans lire 64 plans

Les briques sont des cubes. Pour afficher **une** coupe XY à pleine résolution (par exemple pour une figure du Studio), il faudrait lire toutes les briques de la couche, soit **64 plans de données** pour n'en utiliser qu'un.

Le dossier `planes/` contient donc le niveau 0 **redécoupé plan par plan** : un fichier `zNNNNN.bin` par plan Z (`z00000.bin`, `z00001.bin`…). Chaque plan est coupé en tuiles de **512 × 512** pixels, enregistrées en PNG sans perte ; une tuile entièrement noire n'occupe aucun octet.

![Octets lus pour la coupe z = 30 des trois canaux : 5 078 ko par les briques contre 94 ko par planes/ (54 fois moins).](img/ch07/planes_octets.png){width=70%}

::: example
**Le chiffre du jeu de démonstration.** La coupe XY z = 30 des trois canaux demande 5 078 326 octets via les briques de la couche 0, contre **94 053 octets** via `planes/z00030.bin`. Sur un grand embryon du laboratoire, une coupe de ce genre représentait environ 190 Mo, soit 40 secondes à 5 Mo/s.
:::

Le résultat est **pixel pour pixel identique** à celui des briques, qui restent la solution de repli. `planes/` ne sert qu'aux coupes XY ; la vue 3D, les coupes XZ, YZ et obliques utilisent toujours les briques. Prix : environ 1,3 fois la taille du niveau natif sur le disque.

::: tech
Un fichier plan commence par un en-tête `LPLN` (16 octets), suivi d'une table (décalage 8 octets + longueur 4 octets par tuile et par canal), puis des PNG en niveaux de gris, filtre « None », compression zlib niveau 6. Le navigateur les décode avec son propre décodeur PNG (jamais par lecture d'un canevas, qui n'est pas garantie exacte).
:::

## 7.9 `mips/` : le maximum d'une couche de 64 plans

Une **projection d'intensité maximale** (MIP) garde, pour chaque pixel, la valeur la plus brillante rencontrée le long de Z. Pour un empilement épais, la calculer à la demande lirait tous les plans.

Le dossier `mips/` en garde donc une copie toute faite **pour chaque couche de 64 plans** (`l00000.bin` = plans 0 à 63, `l00001.bin` = plans 64 à 111…), à la pleine résolution XY.

![Une coupe (à gauche) et le MIP de la couche de 64 plans (à droite). Jeu de démonstration, canal DAPI.](img/ch07/mip_couche.png){width=85%}

Pour une épaisseur quelconque, le Studio combine : les **MIP des couches entièrement contenues** dans l'épaisseur, et les **plans individuels** des deux extrémités.

![Épaisseur de 220 plans : 3 MIP de couches + 28 plans d'extrémité, soit 31 images au lieu de 220, avec un résultat identique.](img/ch07/mips-schema.svg){width=100%}

## 7.10 Les formats de données 1 à 5

Au fil des versions, l'organisation des fichiers a évolué. Chaque jeu de données porte un numéro, `formatVersion`, dans son `metadata.json`. Le format **5** est le format actuel (plateforme 1.65).

| format | ce qu'il ajoute | migration |
|---|---|---|
| 1 | briques seules (v2 : 64³ sans bordure, mosaïque 8 × 8, un manifeste JSON) | — |
| 2 | `planes/` : coupes XY rapides | `m002-planes` |
| 3 | `mips/` : MIP par couche de 64 plans | `m003-layer-mips` |
| 4 | briques v3 : bordure 66³, mosaïque 9 × 8, paquets en super-blocs, `index.bin` | `m004-bricks-v3` |
| 5 | la **matrice** : des niveaux à 256 · 2^k^ qui gardent toutes les tranches, **cinq compressions** par niveau, trois copies pour couper vite (section 7.11) | `m005-matrix` |

Le pipeline (version 0.22.0) écrit **le format 4 par défaut**, et le format 5 sur demande (`--format 5`). Un jeu publié en format 4, ou plus ancien, n'est pas perdu : la plateforme sait le mettre à niveau, jusqu'au 5.

### « Mises à jour des données »

Comme une mise à jour de logiciel, l'onglet [Mises à jour des données]{.ui} du panneau d'administration (chapitre 17) détecte les jeux de données en retard et les convertit **sur place**, un par un. Le niveau natif est conservé voxel pour voxel : rien n'est recalculé à partir de l'original.

:::: cards
::: card
#### Dans ce navigateur

Votre navigateur fait le travail (décodage et encodage WebP) et envoie les fichiers au serveur. Sur un hébergement PHP, c'est **la seule** façon de passer au format 5.
:::
::: card
#### Sur le serveur

Le serveur convertit lui-même, si son hébergement sait le faire (serveur Python pour le format 5).
:::
::: card
#### Pause et reprise

Le travail est découpé en petites unités notées dans un journal : on peut mettre en pause, fermer, reprendre, même en changeant d'exécutant.
:::
::::

## 7.11 Le format 5 : une matrice résolution × compression

::: tldr
- Le même volume est rangé **plusieurs fois** : à plusieurs **résolutions** (les lignes) et dans **cinq compressions** (les colonnes). Le visiteur choisit sa case.
- Les niveaux réduits **gardent toutes les tranches** ; leur grand côté vaut exactement 4096, 2048, 1024, 512 ou 256.
- Trois **copies recoupées** (XY, XZ / YZ, oblique) rendent les coupes du Studio rapides, et tout ce qui **mesure** lit toujours les voxels **sans perte**.
:::

::: analogy
Une **photothèque** garde chaque photo en plusieurs tailles et plusieurs qualités : la vignette pour feuilleter, l'original pour imprimer. Le format 5 fait de même avec un volume : on **regarde** dans une version légère, on **mesure** et on **exporte** dans l'original.
:::

Le principe : **le disque est dépensé, le réseau et la carte graphique ne le sont pas.** Ce qui s'affiche peut être compressé avec perte, tant que l'image n'est pas visiblement altérée ; ce qui mesure lit l'original.

### Les lignes : des niveaux qui gardent toutes les tranches

![Les niveaux du même jeu de démonstration en format 4 et en format 5 (dimensions réelles).](img/f5/niveaux.svg){width=95%}

- Le **niveau 0** est le volume natif, jamais rééchantillonné.
- Les autres niveaux ont pour grand côté XY **exactement** 256, 512, 1024, 2048 ou 4096 voxels : toutes ces puissances de deux plus petites que le natif sont faites. Un jeu de 5192 × 5192 × 312 voxels a donc six lignes : natif, 4096, 2048, 1024, 512, 256.
- **Z n'est jamais réduit** : chaque niveau garde les 312 tranches (ici 112). En format 4, les niveaux grossiers perdaient des tranches.
- Chaque voxel d'un niveau est la **moyenne exacte de la surface** des voxels natifs qu'il recouvre, en nombres entiers, arrondie une seule fois. Chaque niveau est calculé **directement depuis le natif**, jamais depuis un autre niveau.

::: example
Pour passer de 768 à 512 voxels, un voxel réduit recouvre 1,5 voxel natif. Le pipeline découpe la ligne en morceaux entiers (768 × 512 unités), compte combien chaque voxel natif recouvre de chaque voxel réduit, et fait la moyenne pondérée : le voxel réduit 0 prend tout le voxel natif 0 et la moitié du voxel 1. Aucun voxel n'est oublié ni compté deux fois.
:::

### Les colonnes : cinq compressions

| colonne | à l'écran | ce qui est garanti | taille (par rapport à « sans perte ») |
|---|---|---|---|
| **Sans perte** (`ll`) | [Sans perte]{.ui} | chaque voxel exact (comme le format 4) | 1 |
| **±2** (`b2`) | [±2]{.ui} | aucun voxel ne bouge de plus de **2** sur 255 | 0,62 à 0,82 |
| **±4** (`b4`) | [±4]{.ui} | aucun voxel ne bouge de plus de **4** | 0,50 à 0,69 |
| **Légère** (`q80`) | [Légère]{.ui} | WebP avec perte, qualité 80 (pas de borne ; ≈ 36 dB) | 0,35 à 0,61 |
| **Très légère** (`q50`) | [Très légère]{.ui} | WebP avec perte, qualité 50 (≈ 31–33 dB) | 0,22 à 0,40 |

Tailles mesurées sur 1 673 briques natives de trois embryons du laboratoire (spécification, § 14.11).

![La même vraie brique dans les cinq compressions : en haut la tranche du milieu, en bas l'écart avec l'original, multiplié par 16 pour être visible.](img/f5/colonnes.png){width=100%}

::: example
**Lisez la figure.** Sur cette brique dense (164 Ko sans perte), ±2 pèse 102 Ko et ne change aucun voxel de plus de 2 ; « Très légère » pèse 37 Ko (4,4 fois moins) mais un voxel peut s'écarter de 35. À l'œil, les cinq tranches du haut sont presque identiques : c'est la promesse des colonnes légères. Pour mesurer, la plateforme ne les utilise **jamais** (section « Ce qui mesure lit l'original »).
:::

#### ±2 et ±4 : des « casiers » de valeurs

![La colonne ±2 : les valeurs sont rangées par casiers de 5 ; le viewer affiche le centre du casier.](img/f5/quantif.svg){width=100%}

- La valeur **0 reste seule** dans son casier : le fond reste exactement noir, les briques vides restent vides.
- Les autres valeurs sont groupées par 5 (±2) ou par 9 (±4) ; on stocke **le numéro du casier**, sans perte. Moins de valeurs différentes → l'image se compresse mieux.
- Le manifeste porte la table « casier → valeur » ; le viewer l'applique **en même temps** que son réglage d'affichage, sans calcul en plus.

#### Légère et Très légère : du WebP avec perte, mais surveillé

1. **Une zone morte.** Une compression avec perte « bave » : quelques voxels du fond noir prennent de petites valeurs. L'encodeur, qui connaît l'original, choisit un seuil τ (de 0 à 12) sous lequel tout redevient 0, et l'écrit dans **un octet** à la fin de la brique.
2. **Jamais plus lourde qu'une colonne fidèle.** Sur une brique presque vide, l'image avec perte peut peser plus que l'image sans perte. L'encodeur garde alors la plus petite des trois : l'image avec perte, l'image ±4 ou l'image sans perte. L'octet final dit laquelle (0 à 12 = τ ; 254 = ±4 ; 255 = sans perte).
3. **Une mosaïque au pas de 80.** Le WebP avec perte travaille par blocs de 16 pixels. Au pas de 66, un bloc chevaucherait deux tranches voisines et les mélangerait. Au pas de 80, chaque tranche de 66 pixels est centrée avec 7 pixels de marge : aucun bloc ne touche deux tranches.

![Pourquoi les colonnes avec perte rangent les tranches tous les 80 pixels.](img/f5/grille80.svg){width=100%}

::: example
**Mesuré sur le canal DAPI du jeu de démonstration** (100 briques natives, colonne Très légère) : sans zone morte, 3,9 % des voxels noirs deviennent non nuls ; avec elle, 1,8 %. Et 12 briques sur 100 sont rangées en ±4 plutôt qu'en WebP avec perte, parce que c'était plus petit.
:::

::: why
**Pourquoi pas AVIF ou JPEG XL ?** AVIF donne le même compromis taille / qualité que WebP à quelques pour cent près, encode deux fois plus lentement et n'a pas d'encodeur dans les navigateurs, qui ne pourraient donc pas faire la conversion. JPEG XL n'est pas décodé par Chrome ni Firefox par défaut (octobre 2026). Mesures : spécification § 14.3.
:::

### Trois copies pour couper vite

Une coupe tirée des briques de 64³ télécharge bien plus qu'elle n'affiche : une coupe XY d'un voxel d'épaisseur lit 64 tranches. Le format 5 ajoute, **à chaque niveau**, trois copies recoupées, toutes **sans perte** :

![Les trois copies de coupe, et ce qu'elles économisent.](img/f5/coupes.svg){width=100%}

| coupe | lue dans | ce qui est lu |
|---|---|---|
| XY | `planes/` (natif) ou `xy/` (niveaux réduits) | **un** plan |
| XZ ou YZ | `xz/` ou `yz/` : des paquets de 64 lignes recoupées | une ligne : trois petites lectures par canal |
| oblique | `cuts/` : des petites briques de 32 × 32 × *bz* voxels, sans bordure | seulement celles que le plan traverse |

*bz* est choisi pour que la petite brique soit à peu près cubique **en micromètres** : 32 × 32 × 16 sur le jeu de démonstration (voxel 1,2 × 1,2 × 3 µm), 32 × 32 × 4 sur un embryon à 0,344 × 0,344 × 3 µm.

::: example
**Mesuré sur un embryon de 1946² × 72 voxels** (plateforme 1.64) : une coupe oblique native a téléchargé **23 Mo en 15 requêtes** au lieu de 60 Mo en 30 par les briques, et chaque image est identique voxel pour voxel.
:::

### Ce qui mesure lit l'original

Toute mesure, tout plugin qui rend un nombre, et tout export « natif » lit la colonne **sans perte du niveau natif**, quelle que soit la case affichée (chapitre 12 et 15). Un réglage d'affichage léger ne fausse donc jamais un chiffre.

### L'arbre d'un jeu au format 5

![Le dossier `bricks/` du jeu de démonstration après conversion, avec les tailles réelles.](img/f5/arbre.svg){width=100%}

- Tout ce que le format 5 ajoute vit **dans** `bricks/` : un seul manifeste (`iribhm-bricks-v5`) le décrit, et un seul renommage l'installe.
- `bricks/index/ll.bin`, `b2.bin`… : un index par colonne (même structure que l'`index.bin` du format 4). Le viewer lit l'index « sans perte » à l'ouverture, les autres seulement quand on choisit leur colonne.
- Les paquets de la colonne sans perte du niveau 0 **sont** ceux du format 4 : la migration les relie (lien physique) au lieu de les recoder.
- `planes/` et `mips/` ne changent pas : ils contiennent déjà le niveau natif.

::: warning
**La place disque augmente beaucoup** : sur le jeu de démonstration, 9 Mo de briques en format 4 deviennent environ 80 Mo en format 5 (dont 28 Mo de copies XZ / YZ). C'est voulu : ce qui coûte, c'est ce que chaque visiteur télécharge et ce que sa carte graphique garde, et cela, le format 5 le réduit. Vérifiez l'espace libre de l'hébergement avant de convertir de gros jeux.
:::

::: remember
- Une brique = 64³ voxels utiles + 1 voxel de bordure = **66³**, stockée en **une image WebP sans perte** de 594 × 528 pixels (9 × 8 coupes).
- Les briques sont dans des **paquets** (super-blocs de 4 × 4 × 4) ; `index.bin` donne paquet, début et longueur de chacune (10 octets par brique).
- `planes/` accélère les coupes XY, `mips/` les projections.
- Format actuel = **5** : des niveaux à 256 · 2^k^ qui gardent toutes les tranches, cinq compressions par niveau (sans perte, ±2, ±4, légère, très légère), trois copies recoupées pour les coupes ; tout ce qui mesure lit la colonne sans perte du natif.
:::
