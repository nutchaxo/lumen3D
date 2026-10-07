# 11. Couleurs, contrastes et histogrammes

::: chapter-intro
- Chaque canal suit la même chaîne de réglages : **plancher invisible → fenêtre min / max → gamma → opacité → couleur**, puis les canaux sont combinés.
- L'**histogramme** montre comment les 256 niveaux de gris sont répartis ; ses trois poignées règlent la fenêtre et le gamma.
- Les niveaux de gris sont **relatifs** à un jeu de données : ce ne sont pas des intensités de fluorescence calibrées.
:::

## 11.1 La chaîne de traitement d'un canal

Chaque voxel est stocké sous la forme d'un **octet** (un nombre de 0 à 255). Avant de devenir un pixel coloré, il traverse sept étapes. Cinq d'entre elles sont à votre portée ; une seule est cachée.

![Le trajet d'une valeur : de l'octet stocké à la couleur du pixel.](img/ch11/chaine.svg){width=100%}

| Étape | Qui décide ? | Où la régler |
|---|---|---|
| Plancher | automatique (histogramme) | nulle part |
| Fenêtre min / max | vous | poignées gauche et droite |
| Gamma | vous | poignée du milieu |
| Opacité | vous | bouton goutte (3 valeurs) |
| Couleur | vous | pastille de couleur |
| Exposition | vous | curseur [Visibilité (exposition)]{.ui}, global |

## 11.2 L'étape cachée : le plancher du fond

Avant même que vous touchiez à un réglage, le viewer **écrase le fond** : toutes les valeurs inférieures ou égales à un seuil, le **plancher**, deviennent **0**, et les valeurs restantes sont **étirées** pour occuper toute l'échelle 0–255.

![L'effet d'un plancher de 26 (valeur réelle estimée pour le canal DAPI du jeu E9.5).](img/ch11/plancher.png){width=60%}

::: tech
Le plancher `f` est estimé à partir de l'histogramme du jeu de données : on cherche le premier niveau où le cumul atteint **la case 0 + 20 % des voxels non nuls**, on prend le bord supérieur de cette case, on ajoute 2 et on borne le résultat entre **6 et 48**. Ensuite : `valeur' = 0` si `valeur ≤ f`, sinon `arrondi((valeur − f) × 255 / (255 − f))`.
:::

::: example
Plancher de 26 (DAPI) : un voxel stocké à **120** devient (120 − 26) × 255 / 229 ≈ **105** ; un voxel à 20 devient **0**. Pour le jeu E9.5 les planchers estimés sont 26 (DAPI), 10 (Pecam1) et 22 (Sox2).
:::

::: note
Les valeurs que vous lisez sur les poignées (Min 0, Max 255…) sont déjà **après** ce plancher. Vous ne le voyez jamais, mais il explique pourquoi le fond est si propre.
:::

## 11.3 La fenêtre min / max et le gamma

La **fenêtre** choisit quelle portion de l'échelle devient « du noir au plein éclat ». Les valeurs sous **Min** deviennent noires, celles au-dessus de **Max** saturent, entre les deux le passage est **linéaire**.

Le **gamma** courbe ensuite cette échelle : un gamma inférieur à 1 **éclaircit** les tons faibles (utile pour des signaux ténus), un gamma supérieur à 1 les **assombrit**.

![À gauche, la fenêtre min 20 / max 220 ; à droite, l'effet du gamma 0,5 / 1 / 2.](img/ch11/courbes.png){width=100%}

::: example
Un voxel de valeur **120**, avec Min = 20, Max = 220, gamma = 0,5 et opacité = 70 % :

1. Fenêtre : (120 − 20) / (220 − 20) = **0,5**
2. Gamma : 0,5 puissance 0,5 = **0,707**
3. Opacité : 0,707 × 0,7 = **0,495**
4. Couleur : sur un canal vert (0 ; 1 ; 0), le voxel contribue (0 ; **0,495** ; 0), avant l'exposition.
:::

### La poignée du milieu

La poignée du milieu ne règle pas le gamma directement : elle désigne le niveau (**dans la fenêtre**) qui doit s'afficher à **50 %**. Le viewer en déduit le gamma, borné entre **0,18 et 5,5** :

`gamma = ln 0,5 / ln m`, où `m` est la position relative de la poignée entre Min et Max.

::: example
Poignée au quart de la fenêtre (m = 0,25) : gamma = ln 0,5 / ln 0,25 = **0,5**. Avec Min = 20 et Max = 220, ce quart correspond à la valeur 20 + 0,25 × 200 = **70** : une valeur de 70 s'affiche à 50 %. Poignée au milieu (m = 0,5) : gamma = 1.
:::

## 11.4 Le panneau d'un canal

Chaque canal a sa carte dans le panneau [Canaux]{.ui}. La ligne de résumé (par exemple `0-255 | gamma 1.00 | 70%`) rappelle la fenêtre, le gamma et l'opacité même quand la carte est repliée.

![La carte d'un canal dépliée (DAPI, jeu de démonstration E9.5).](img/ch11/panneau-canaux.png){.shot width=100%}

*(numéros : voir la légende ci-dessous.)*

::: legend
| n | ce que c'est |
|---|---|
| 1 | case à cocher (afficher / masquer le canal) et nom du canal, modifiable |
| 2 | boutons : [Isoler le canal]{.ui} (Solo), opacité (goutte), couleur (pastille) |
| 3 | histogramme, avec les trois poignées : Min (gauche), gamma (milieu), Max (droite) |
| 4 | valeurs lues : Min, Gamma, Max |
| 5 | boutons de réglage rapide : Auto, Soft, Contrast, Reset (voir ci-dessous) |
| 6 | curseur [Flou gaussien σ]{.ui} (section 11.7) |
:::

## 11.5 Les histogrammes

Un **histogramme** compte combien de voxels ont chaque valeur. Celui du panneau a **64 colonnes** (4 niveaux de gris par colonne).

- Il est calculé **par le pipeline**, sur le **niveau le plus grossier** de la pyramide, et enregistré dans le manifeste. Le navigateur ne le recalcule pas.
- Il porte sur **tous** les voxels, fond compris : c'est pourquoi la première colonne est énorme (86 à 97 % des voxels du jeu E9.5).
- Dans une **série temporelle**, chaque pas de temps a son propre histogramme ; le panneau le suit quand vous changez d'image.
- Il représente les **octets stockés** (avant le plancher et la fenêtre).

![Les histogrammes réels des trois canaux du jeu de démonstration E9.5. En haut : les comptes bruts. En bas : ce que dessine le panneau. Les traits pointillés marquent la plage choisie par [Auto]{.ui}.](img/ch11/histogrammes.png){width=100%}

### Comment le panneau dessine l'histogramme

Une colonne géante au niveau 0 écraserait tout le reste. Le panneau applique donc trois règles :

- échelle **linéaire**, normalisée par la colonne la plus haute ;
- les **4 % de colonnes les plus basses** (les 3 premières sur 64) sont **plafonnées à 1,35 fois** la plus haute colonne qui les suit ;
- les « trous en peigne » (une colonne sous 20 % de ses deux voisines) sont comblés par la moyenne de ses voisines, pour masquer un artefact de décodage du WebP.

::: note
La case [Ignorer le fond]{.ui} ne change que le **dessin** : elle multiplie les colonnes affichées par (i / 63)² pour aplatir la bosse du fond. Elle **ne modifie pas l'image**.
:::

## 11.6 Les boutons de réglage rapide

Les boutons sous l'histogramme posent d'un coup Min, Max et le milieu. Ils s'appellent **Auto**, **Soft**, **Contrast** et **Reset** dans le panneau (texte anglais affiché tel quel, même en interface française).

| Bouton | Min | Max | Gamma obtenu |
|---|---|---|---|
| **Auto** | percentile 0,5 % | percentile 99,5 % | 1 (milieu de la fenêtre) |
| **Soft** | 5 | 240 | 0,83 |
| **Contrast** | 20 | 209 | 1,22 |
| **Reset** | 0 | 255 | 1 |

::: tech
**Auto** parcourt l'histogramme (64 colonnes) : Min = dernière colonne dont le cumul reste ≤ 0,5 % des voxels, Max = fin de la dernière colonne dont le cumul reste ≤ 99,5 %. Sans histogramme : Min 0,01 et Max 0,98 (sur 1). Les presets sont exprimés sur l'échelle 0–1 : Soft = 0,02 / 0,94 avec milieu à 0,42 ; Contrast = 0,08 / 0,82 avec milieu à 0,5 ; Reset = 0 / 1 / 0,5.
:::

::: example
**Auto** sur le jeu E9.5 donne Max = 80 pour DAPI, 36 pour Pecam1 et 92 pour Sox2, et Min = 0 : comme 86 à 97 % des voxels sont du fond, le 0,5 % inférieur est entièrement dans la première colonne. [Reset]{.ui} remet 0 / 255.
:::

::: warning
Auto reflète la **distribution de tous les voxels**, fond compris. Sur un signal rare, il peut placer Max très bas : l'image sature alors volontairement. Gardez un œil sur l'histogramme et ajustez les poignées à la main si besoin.
:::

## 11.7 Couleurs, opacité, exposition, solo

### Couleur : une addition de lumières

La couleur d'un canal est un simple **multiplicateur RVB**. Les canaux sont **additionnés**, comme des projecteurs : là où deux canaux sont forts, les couleurs se mélangent, puis tout dépassement de 1 est coupé à l'écran.

![Mélanges additifs : vert + magenta donne du blanc.](img/ch11/melange.svg){width=95%}

- Le sélecteur propose **27 couleurs** : trois lignes (vives, claires, foncées) de neuf teintes.
- Par défaut (sans couleur dans les métadonnées) : vert, bleu clair, magenta, rouge.
- Le menu des **simulations de déficiences de la vision des couleurs** de l'en-tête applique un filtre à l'écran entier : il sert à vérifier qu'une figure reste lisible, il ne change pas les données.

::: tip
Évitez le rouge et le vert côte à côte pour des figures destinées à un public large : choisissez plutôt vert et magenta, qui restent distincts pour la plupart des déficiences.
:::

### Opacité, exposition, solo

- **Opacité** : le bouton goutte fait défiler **70 %, 42 %, 100 %**. C'est un multiplicateur d'intensité (0,7 ; 0,42 ; 1), pas une absorption physique.
- **Exposition** : le curseur [Visibilité (exposition)]{.ui} (de 20 à 500 %, soit ×0,2 à ×5) multiplie la couleur finale ; dans le mode naturel, il multiplie l'émission.
- **Solo** : [Isoler le canal]{.ui} n'affiche que ce canal ; un deuxième clic ([Afficher tous les canaux]{.ui}) restaure l'état précédent.
- Un jeu à **plus de 4 canaux** n'en montre que **4** (limite de la texture graphique).

## 11.8 Le flou gaussien

Le curseur [Flou gaussien σ]{.ui} (de 0 à 5, par pas de 0,1) lisse le bruit **d'un canal**. L'effet est appliqué **au relâchement** du curseur ; ramener σ à 0 restaure le canal d'origine. Le réglage ne modifie que l'affichage.

![Plan par plan, avec plusieurs ouvriers ; deux méthodes de calcul selon σ.](img/ch11/flou.svg){width=100%}

::: remember
- **2D dans le plan** : chaque plan Z est flouté séparément, jamais d'un plan à l'autre.
- σ est en **voxels du niveau affiché**.
- Calcul par un groupe de **jusqu'à 4 ouvriers**, hors de la page ; une bulle indique que le calcul est en cours.
:::

:::: cols
::: col
![Canal Sox2 seul, σ = 0.](img/ch11/flou-avant.png){.shot}
:::
::: col
![Même zone, σ = 2,0.](img/ch11/flou-apres.png){.shot}
:::
::::

::: warning
Le flou n'est disponible que si le niveau affiché tient dans **une seule texture dense**. Pour un gros niveau stocké en atlas, le curseur est grisé avec le message : « Indisponible à cette qualité (atlas de briques creux) : choisissez une qualité inférieure pour utiliser le flou. » Utiliser le flou désactive aussi le mode [Détail au zoom]{.ui} (chapitre 10).
:::

## 11.9 Garde-fou : ce que les niveaux de gris veulent dire

::: warning
**Les niveaux de gris affichés sont relatifs, pas calibrés.** Le pipeline a ramené les intensités d'origine (12 ou 16 bits) sur 0–255, entre un fond estimé (99e percentile des coins du volume) et un signal maximal (99,9e percentile) ; le viewer y ajoute son plancher. Une valeur de 120 ne correspond donc à **aucun nombre de photons**.
:::

- Comparer **deux canaux** d'un même jeu est délicat : chacun est étiré sur sa propre échelle.
- Comparer **deux jeux de données** par leurs niveaux de gris n'est pas valable, même avec les mêmes réglages.
- Dans une **série temporelle**, la même fenêtre est partagée par tous les pas de temps d'un canal : les variations d'intensité dans le temps restent comparables entre elles.
- Pour une **mesure quantitative**, retournez aux données d'origine (fichier Imaris).
