# 12. Les outils, un par un

::: chapter-intro
- Ce chapitre est le **mode d'emploi** de chaque bouton du viewer, de la page Comparer, de la frise temporelle et de la page 2D.
- Chaque outil suit le même plan : **à quoi il sert**, **comment l'utiliser**, **ce qu'il fait vraiment** (en mots simples) et **ses limites**.
- Toutes les captures montrent le **jeu de démonstration** (embryons synthétiques générés pour cette documentation, pas des données réelles du laboratoire).
:::

## 12.1 La barre d'outils d'un coup d'œil

Survolez un bouton : une info-bulle donne son nom. La barre est rangée en **cinq groupes** (Outils, Exporter, Visuels, Dispositions, Aide). Quand la fenêtre est étroite ou le titre très long, elle se replie derrière le bouton ☰.

![La barre d'outils du viewer, numérotée (jeu de démonstration).](img/ch12/barre-outils.png){.shot width=100%}

:::::: cols
::::: col
::: legend
| n | ce que c'est |
|---|---|
| 1 | [Naviguer]{.ui} (<kbd>V</kbd> ou <kbd>Échap</kbd>) |
| 2 | [Couper à travers le volume]{.ui} (<kbd>C</kbd>) |
| 3 | [Mesurer la distance]{.ui} (<kbd>M</kbd>) |
| 4 | [Centre de téléchargement]{.ui} |
| 5 | Capture en « bac à sable » (plugin de démonstration) |
| 6 | [Capture d'ecran]{.ui} |
| 7 | [Basculer la Grille (Aucune / Normale / Fine)]{.ui} |
| 8 | [Basculer les Axes]{.ui} |
| 9 | [Basculer les axes d'orientation]{.ui} |
| 10 | [Masquer / Afficher le Volume 3D (conserver les projections)]{.ui} |
| 11 | [Débogage des chunks (arêtes des bricks)]{.ui} |
:::
:::::
::::: col
::: legend
| n | ce que c'est |
|---|---|
| 12 | [Mode présentation]{.ui} |
| 13 | [Décomposer par canal]{.ui} |
| 14 | [Explorateur Z-Stack]{.ui} |
| 15 | [Aide et méthodes]{.ui} |
| 16 | [Filtres daltonisme]{.ui} |
| 17 | [Changer le theme]{.ui} (clair / sombre) |
| 18 | [Centrer l'échantillon]{.ui} |
| 19 | [Réinitialiser la vue]{.ui} |
| 20 | [Exporter la vue 3D en PNG]{.ui} |
| 21 | [Réinitialiser l'espace de travail (vue, outils, mesures)]{.ui} |
| 22 | Le panneau [Canaux]{.ui} (voir le chapitre 11) |
:::
:::::
::::::

::: note
**Votre barre peut être différente.** Les outils sont des *plugins* installés par l'administrateur depuis le catalogue (chapitre 13). Dix-sept boutons sont recommandés par défaut ; le débogage des chunks, la capture « bac à sable » et les outils 2D sont optionnels. Les outils de suivi cellulaire n'apparaissent que sur une série temporelle suivie.
:::

### Je veux… → j'utilise…

| Je veux… | J'utilise… | Raccourci |
|---|---|---|
| Mesurer une distance en µm | [Mesurer la distance]{.ui} | <kbd>M</kbd> |
| Voir une coupe, même oblique | [Couper à travers le volume]{.ui} | <kbd>C</kbd> |
| Feuilleter les plans un par un | [Explorateur Z-Stack]{.ui} | — |
| Savoir où est l'avant de l'embryon | [Basculer les axes d'orientation]{.ui} | — |
| Une figure annotée pour un article | Le Studio (§ 12.7) | — |
| Une image 3D très grande ou transparente | [Exporter la vue 3D en PNG]{.ui} | — |
| Une capture rapide de l'écran | [Capture d'ecran]{.ui} | — |
| Un panneau par canal | [Décomposer par canal]{.ui} | — |
| Récupérer le fichier d'origine | [Centre de téléchargement]{.ui} | — |
| Comparer deux embryons | La page Comparer (§ 12.8) | — |
| Suivre des cellules dans le temps | Les cinq outils de suivi (§ 12.9) | <kbd>I</kbd>, <kbd>D</kbd> |
| Partager ce que je vois | Copier l'adresse de la page (§ 12.11) | — |

## 12.2 Mesurer une distance {.page}

::: tldr
- **À quoi ça sert** : connaître en micromètres la distance entre deux points du volume.
- Le point ne se pose pas « au hasard » : il se place sur **la première structure vive** sous votre curseur.
- Un clic dans le vide est **refusé**.
:::

![Deux points (1, 2), le segment et la liste des mesures. Jeu de démonstration, 204,8 µm.](img/ch12/mesure-distance.png){.shot width=100%}

::: legend
| n | ce que c'est |
|---|---|
| 1, 2 | Les points A et B posés par vos deux clics |
| 3 | La liste : couleur, nom modifiable, valeur, œil (masquer), poubelle |
| 4 | Case [Valeurs 3D]{.ui} : affiche ou non l'étiquette dans la vue, avec son curseur de taille |
| 5 | La consigne du panneau [Mesure de Distance]{.ui} |
:::

::: steps
1. Appuyez sur <kbd>M</kbd> (ou cliquez la règle). Le panneau [Mesure de Distance]{.ui} s'ouvre.
2. Cliquez le point A sur une partie **visible** de l'échantillon.
3. Cliquez le point B : la distance et l'écart en Z s'affichent, un segment coloré apparaît.
4. Un troisième clic commence une nouvelle mesure. Glissez pour tourner l'embryon sans poser de point.
:::

### Comment le point est trouvé

Le viewer ne garde **aucune copie** du volume en mémoire centrale : il interroge la carte graphique. Pour votre clic, il refait un mini-rendu d'**un seul pixel** avec exactement les mêmes réglages que l'écran (fenêtre, gamma, canaux allumés, rognage).

![Le point mesuré est la première structure qui atteint 55 % du maximum affiché.](img/ch12/pick.svg){width=92%}

::: tech
Deux passes le long du rayon. Passe 1 : le maximum affiché `m`. Passe 2 : le premier point où la valeur affichée atteint `max(0,02 ; 0,55 × m)`, interpolé entre les deux échantillons qui encadrent le seuil. Le plancher 0,02 empêche de « mesurer » du bruit quand tout est presque noir. Conséquence : **éteindre un canal ou changer sa fenêtre déplace le point** (vous mesurez ce que vous voyez).
:::

::: warning
Un clic sans structure dessous (fond noir) est **refusé** : [Aucune structure sous le curseur : cliquez sur une partie visible de l'échantillon.]{.ui} Sans calibration physique dans les métadonnées, la mesure est aussi refusée. Sur une **paroi de la grille** (§ 12.5), le point est posé sur la paroi, pas sur l'échantillon.
:::

### Le calcul, avec de vrais nombres

Les coordonnées normalisées (0 à 1) sont converties en micromètres avec la taille physique du volume (nombre de voxels × taille de voxel). Puis, sur les coordonnées **physiques** :

`d = √( (Δx)² + (Δy)² + (Δz)² )`

::: example
Les points de la capture : A = (498,5 ; 163,4 ; 211,1) µm et B = (639,3 ; 311,9 ; 203,2) µm. Les écarts valent Δx = 140,8, Δy = 148,5, Δz = 8,0 µm. Donc d = √(19 838 + 22 043 + 63) = √41 944 ≈ **204,8 µm**, la valeur affichée.
:::

![Pourquoi on ne peut pas « compter les voxels » : Z est 2,5 fois plus long.](img/ch12/voxels.svg){width=92%}

::: why
Le jeu de démonstration a des voxels de 1,2 × 1,2 × 3,0 µm. Compter les voxels comme s'ils étaient cubiques sous-estime ici de 20 % une distance en biais. Le viewer fait toujours le calcul en µm, jamais en voxels.
:::

**Où sont gardées les mesures ?** Uniquement **en mémoire de la page** : fermer l'onglet les efface. Pour les conserver, copiez l'adresse de la page (elles voyagent dans le lien, § 12.11) ou téléchargez [Mesures CSV]{.ui} dans le Centre de téléchargement.

### La barre d'échelle de la vue 3D

Allumez la grille (bouton 7) : une barre d'échelle apparaît en bas à droite, avec une longueur « ronde » (règle **1-2-5** : 1, 2, 5, 10, 20, 50, 100 µm…). Elle vise environ 20 % de la largeur de la vue, entre 60 et 200 pixels.

![La grille et la barre d'échelle (1) : 100 µm. Le bouton de la grille est le 2.](img/ch12/grille-echelle.png){.shot width=88%}

À cause de la **perspective**, un objet lointain paraît plus petit : la barre n'est exacte qu'à la profondeur du **centre de l'échantillon**.

![Même longueur, trois profondeurs : la barre vaut pour le plan central.](img/ch12/perspective.svg){width=92%}

::: tech
µm par pixel = 2·tan(champ/2) · profondeur · (taille physique X / échelle du cube) / hauteur de la vue en pixels. La barre est masquée sans calibration ou si la grille est éteinte.
:::

## 12.3 La coupe oblique {.page}

::: tldr
- **À quoi ça sert** : voir une tranche plane du volume, droite ou inclinée, au lieu de la vue d'ensemble.
- Pendant l'outil, **les deux vues échangent leur place** : la coupe prend tout l'écran, le 3D devient une petite fenêtre.
- On ne peut pas l'utiliser en même temps que l'explorateur Z-Stack.
:::

![Coupe XY au milieu du volume (jeu de démonstration).](img/ch12/coupe-oblique.png){.shot width=100%}

::: legend
| n | ce que c'est |
|---|---|
| 1 | La coupe, calculée par la carte graphique, avec les couleurs de vos canaux |
| 2 | Barre d'échelle exacte de la coupe (200 µm ici) |
| 3 | Le volume en miniature : on y déplace le plan |
| 4 | Préréglages [XY]{.ui}, [XZ]{.ui}, [YZ]{.ui} |
| 5 | [Position]{.ui} du plan, puis [Lacet]{.ui}, [Tangage]{.ui}, [Roulis]{.ui} |
| 6 | [Épaisseur]{.ui} : nombre d'échantillons dans la tranche |
| 7 | [Projection]{.ui} : [Unique]{.ui}, [MIP]{.ui} ou [Moyenne]{.ui} |
| 8 | Bouton vers le Studio (§ 12.7) |
:::

::: steps
1. Appuyez sur <kbd>C</kbd> : un plan translucide apparaît, la coupe remplit l'écran.
2. Choisissez un préréglage, ou déplacez le plan dans la miniature (molette sur le plan : 2 % du volume par cran).
3. Les curseurs [Lacet]{.ui}, [Tangage]{.ui}, [Roulis]{.ui} rendent le plan **oblique**.
4. Épaississez la tranche et choisissez comment l'écraser : une seule coupe, le plus clair (MIP) ou la moyenne.
:::

::: tech
La coupe lit le **même atlas** que la vue 3D, donc mêmes fenêtres, gamma et couleurs. Le plan est la rotation Ry(−lacet)·Rx(−tangage)·Rz(roulis) dans le repère aux proportions physiques ; comme les voxels sont plus longs en Z, la normale du plan est corrigée (n_tex ∝ S⁻¹·n). Pendant que vous déplacez le plan, l'image fait 1024 px ; une fois immobile (160 ms), elle est affinée jusqu'à 2048 px. Une épaisseur compte en échantillons (au plus 1024), pas en µm.
:::

::: warning
Les préréglages XY/XZ/YZ suivent les axes **du fichier**, pas ceux de l'embryon, sauf si le jeu de données a été calibré (§ 12.5).
:::

## 12.4 L'explorateur Z-Stack {.page}

::: tldr
- **À quoi ça sert** : feuilleter les plans de la pile comme dans un logiciel de microscopie.
- À l'ouverture, la pile **se couche à plat** en 1,5 s, face supérieure vers vous.
- Le curseur peut montrer une coupe, plusieurs coupes (une « épaisseur ») ou toute la pile en 3D.
:::

![Z-stack ouvert en mode 3D : toutes les coupes conservées.](img/ch12/zstack-3d.png){.shot width=100%}

::: legend
| n | ce que c'est |
|---|---|
| 1 | Schéma de la pile (cliquer un plan = aller à cette coupe) |
| 2 | Le **cran 3D** : curseur ici = toutes les coupes en 3D, rotation libre |
| 3 | La **piste** : une position par coupe (coupe 1 en haut) |
| 4 | Les deux **triangles de rognage** : masquent les coupes du dessus / du dessous |
| 5 | Résumé : [Les 112 coupes sont conservées]{.ui} |
| 6 | [Infos de pile]{.ui} : tranches, étendue, intervalle, voxel Z |
:::

::: steps
1. Cliquez [Explorateur Z-Stack]{.ui} : la pile se couche à plat.
2. Tirez le curseur du cran 3D **vers le bas** dans la piste : la vue se verrouille de dessus sur la coupe choisie.
3. Tirez un **bord** du curseur (ou le bouton [Épaisseur]{.ui}) pour montrer plusieurs coupes à la fois.
4. Ramenez le curseur dans le cran pour revenir au 3D de toutes les coupes conservées.
:::

![Mode coupe : 12 coupes (59 à 70), soit 36 µm.](img/ch12/zstack-coupe.png){.shot width=100%}

::: legend
| n | ce que c'est |
|---|---|
| 1 | Le curseur : sa hauteur = le nombre de coupes montrées |
| 2 | [59–70 / 112]{.ui} : coupes affichées sur le total (flèches pour avancer) |
| 3 | [Épaisseur]{.ui} : 12 coupes, soit 36,00 µm (12 × 3 µm) |
| 4 | [Rotation]{.ui} 0–360° : tourne les coupes à l'écran |
| 5 | Position : de 174,00 à 207,00 µm de profondeur |
| 6 | Ouvrir cette tranche dans le Studio |
:::

::: tech
Une seule opération rogne le volume en Z : `setClipRange_z` avec l'intervalle `[début / z ; (fin+1) / z]`. Le calcul de rendu se confine à cette boîte et corrige l'émission (« gain de tranche mince ») pour qu'une coupe unique ne soit pas noire. Profondeur = indice × taille de voxel Z (3 µm ici). Au clavier, curseur sélectionné : ↑ ↓ une coupe, PageHaut/PageBas 10 % de la pile, Début = cran 3D, Fin = dernière coupe, + / − épaisseur.
:::

**Échantillon « à l'envers ».** Certains fichiers Imaris montrent l'échantillon vu de dessous. L'administrateur l'indique dans les métadonnées (`upsideDown`) : la « face supérieure » est alors la face −Z, et le Z-stack, ainsi que les figures du Studio, la présentent du bon côté. La calibration d'orientation n'en dépend pas.

## 12.5 Les axes d'orientation, la grille et les affichages {.page}

::: tldr
- **Axes d'orientation** : une boussole de l'embryon (R1/R2, G1/G2, B1/B2).
- **Grille** : trois murs gradués avec projections ; **Axes** : un repère XYZ déplaçable.
- **Volume** : masque le volume 3D en gardant les projections.
:::

### Les axes d'orientation

![La boussole : rouge R1/R2 (±X), vert G1/G2 (±Y), bleu B1/B2 (±Z).](img/ch12/orientation.png){.shot width=88%}

Chaque bras a un **nom court** (R1, R2, G1, G2, B1, B2). L'administrateur peut les renommer (« Antérieur », « Dorsal »…) ou en masquer. Glissez la petite sphère centrale pour déplacer la boussole ; sa position est conservée dans l'espace de travail.

::: analogy
**Une calibration d'orientation, c'est un geste de la main.** Le microscope enregistre l'embryon dans l'orientation où il était posé, pas « tête en haut ». La calibration dit : « pour remettre l'embryon à l'endroit, faites tourner le fichier d'**un** mouvement, autour de **cet** axe, de **tant** de degrés ». L'ordinateur range ce geste sous forme de quatre nombres (un *quaternion*). Vous n'avez rien à régler : l'administrateur la fait une fois, dans le panneau d'administration.
:::

**La vue par défaut** est une pose de l'embryon (par exemple « face ventrale, antérieur en haut ») enregistrée avec le jeu de données : elle est appliquée **avant** le chargement de la première brique, et le bouton [Réinitialiser la vue]{.ui} y revient. Les préréglages proposés sont ventral, dorsal, gauche, droite, antérieur, postérieur.

::: tech
Le fichier a sa rotation `Q_base` (axes du fichier → axes anatomiques). La boussole est dessinée avec `Q_anat = Q_cube · Q_base⁻¹`, et une vue par défaut est stockée sous la forme `Q_anat`, appliquée en `Q_cube = Q_anat · Q_base`. La calibration n'est modifiable que depuis l'administration (aperçu ↔ viewer par messages) ; un visiteur ne peut ni la changer, ni enregistrer une vue par défaut.
:::

### La grille, les axes, le volume

![Le volume masqué : il ne reste que la grille et ses projections (bouton 1).](img/ch12/projections.png){.shot width=88%}

- **Grille** (7) : un clic fait défiler *Aucune → Normale (10 divisions) → Fine (40) → Aucune*. Les trois murs montrent une **projection** du volume avec le même mode de rendu. Une poignée orange redimensionne un mur (double-clic : retour).
- **Axes** (8) : un repère XYZ coloré, à ne pas confondre avec la boussole. Glissez sa sphère pour le déplacer.
- **Volume** (10) : cache le volume ray-marché ; la grille, les axes, les mesures et le suivi restent.

## 12.6 Capture, export, présentation, téléchargement, canaux, chunks {.page}

::: tldr
- Trois façons d'obtenir une image : [Capture d'ecran]{.ui} (rapide), [Exporter la vue 3D en PNG]{.ui} (grande taille), le Studio (figure annotée).
- Le [Centre de téléchargement]{.ui} ne donne pas des captures : il donne les **fichiers** du jeu de données.
:::

### Capture d'écran et export de la vue 3D

La **capture** (bouton 6) enregistre en un clic ce qui est à l'écran, au format PNG (`<jeu>_screenshot.png`), à la résolution de l'écran.

L'**export de la vue 3D** (bouton 20) refait le rendu **à n'importe quelle taille**.

:::::: cols
::::: col
![La fenêtre d'export (2). Le bouton 1 l'ouvre.](img/ch12/export-vue.png){.shot width=100%}
:::::
::::: col
- [Taille]{.ui} : [Écran]{.ui}, 2×, 4×, [Personnalisé]{.ui} (largeur de 16 à 16 384 px).
- [Arrière-plan]{.ui} : comme affiché, [Transparent]{.ui}, noir, blanc.
- [Barre d'échelle]{.ui} : désactivée sans calibration (elle compterait des voxels, pas des µm).
- Fichier : `<jeu>_3d_<L>x<H>.png`.
:::::
::::::

::: tech
Une carte graphique ne sait pas dessiner d'un coup une image géante. Le viewer attend la fin du chargement, puis rend la vue **par tuiles** d'au plus 2048 px (chacune est une fenêtre du champ de vision, une tuile par tâche pour ne pas figer la page) avec le nombre de pas d'un rendu au repos. Le fond transparent écrit une opacité par pixel `a = max(opacité, max(canaux))` ; sur noir, il redonne l'écran. Si l'affichage change pendant le rendu, il recommence (3 essais). Plafond : 16 384 px de côté, 268 mégapixels.
:::

### Mode présentation

Le bouton 12 masque l'interface pour que le volume remplisse l'écran : utile pour projeter ou filmer. Même bouton pour revenir.

### Centre de téléchargement

![Les fichiers du dossier `download/` d'un jeu de données (jeu de démonstration).](img/ch12/centre-telechargement.png){.shot width=86%}

Dans le viewer, il affiche une **liste de fichiers** : le fichier Imaris d'origine, le TIFF calibré, les projections par canal (PNG), l'archive web, un fichier README. Ils n'existent que si le pipeline a été lancé avec les téléchargements (chapitre 8). Ces fichiers sont toujours servis en **pièce jointe**. S'il y a des mesures, un bouton [Mesures CSV]{.ui} apparaît (colonnes : étiquette, type, distance, unité, point A, point B…).

### Décomposer par canal

![Un vignette par canal : DAPI, Pecam1, Sox2.](img/ch12/decomposer.png){.shot width=88%}

Chaque canal allumé reçoit sa **vignette** (le même volume, avec ce canal seul). Cliquer une vignette permet de régler ce canal dans le panneau de gauche ([Terminé]{.ui} pour sortir, [Revenir à l'original]{.ui}). Les trois boutons (1) choisissent la disposition ; [Export]{.ui} (2) écrit un PNG `decomposition_<disposition>_<date>.png`. Chaque vignette est rendue à la taille du volume (512 à 4096 px) et le viewer refuse une image trop grande pour la carte graphique (« Trop de vues pour une seule image »).

### Débogage des chunks

![Les briques de 64³ voxels dessinées en jaune ; survol de l'une d'elles.](img/ch12/chunk-debug.png){.shot width=100%}

L'outil le plus pédagogique du chapitre 7 : il **dessine les arêtes de chaque brique non vide** du niveau affiché. Survolez une brique : son identifiant, sa taille (ici 64×64×48 voxels, 76,8 × 76,8 × 144 µm), sa taille stockée (66³ avec une bordure d'un voxel), son fichier de pack et son niveau de détail. Clic : copie ces informations. <kbd>Ctrl</kbd> + molette : parcourt les briques superposées sous le curseur.

## 12.7 Le Studio : annoter et exporter une figure {.page}

::: tldr
- **À quoi ça sert** : fabriquer une figure de publication à partir d'une coupe (barre d'échelle, flèches, mesures, texte).
- Il s'ouvre **tout de suite** sur un aperçu, puis recharge la coupe à la **résolution native**.
- Les canaux se **recolorient** dans le Studio sans refaire le rendu du volume.
:::

![Le Slice Studio avec un rectangle tourné de 20°, une flèche, une distance, une barre d'échelle.](img/ch12/studio.png){.shot width=100%}

::: legend
| n | ce que c'est |
|---|---|
| 1 | Outils : sélection, rectangle, ellipse, flèche, ligne, texte, distance, angle, barre d'échelle |
| 2 | Calques (réordonner, masquer, verrouiller) |
| 3 | Une mesure de distance : 399,68 µm (étiquette calculée en µm) |
| 4 | [Propriétés]{.ui} du calque choisi : nom, couleur, opacité, épaisseur, [Rotation]{.ui} (−180 à 180°) |
| 5 | [Canaux]{.ui} : couleur, min/max, gamma, on/off, avec leurs histogrammes |
| 6 | [Importer JSON]{.ui} / [Sauvegarder JSON]{.ui} |
| 7 | [Exporter PNG]{.ui} |
| 8 | Rotation de la **vue** (affichage seulement) |
| 9 | Mini-carte |
:::

::: steps
1. Dans la coupe oblique ou le Z-stack, cliquez le bouton d'ouverture du Studio.
2. Annotez : chaque outil a une lettre (tableau § 12.10). Une barre d'échelle est posée à l'ouverture si le volume est calibré.
3. Recolorez les canaux si besoin (colonne de droite).
4. [Exporter PNG]{.ui} pour l'image, [Sauvegarder JSON]{.ui} pour pouvoir reprendre plus tard.
:::

### Les calques

- **Distance** : l'étiquette vaut `√((Δx·px_x)² + (Δy·px_y)²)` µm, avec la taille de pixel de la figure. **Angle** : trois clics, calculé en µm. **Barre d'échelle** : sa longueur (µm, mm, cm ou px) est convertie en pixels.
- **Rotation d'un calque** : un rectangle, une ellipse ou un texte tourne autour de son centre ; une ligne, une flèche ou une distance voient leurs points tournés (la distance garde sa valeur en µm). Curseur, champ, poignée au-dessus de la sélection (<kbd>Maj</kbd> = pas de 15°), ou <kbd>[</kbd> / <kbd>]</kbd>.
- L'historique garde 80 étapes (<kbd>Ctrl</kbd>+<kbd>Z</kbd>).

### La passe « native »

L'aperçu (au plus 2048 px) vient de la carte graphique. La passe native va chercher les **voxels de la résolution maximale** pour ce plan précis, et remplace l'image pendant qu'elle arrive. Une barre indique octets, chunks et temps restant, avec [S'arrêter ici]{.ui}.

- Une coupe **XY** d'un jeu de format 2 ou plus lit le dossier `planes/` : uniquement les voxels du plan.
- Un plan **oblique** ou un volume ancien passe par les briques (lectures d'octets ciblées, § 10).
- Une brique absente parce que vide est comptée comme **zéro**, jamais comme « manquante ».
- Si une figure demande plus de 256 Mo, une boîte propose natif, résolution réduite ou aperçu.

::: note
Sur le jeu de démonstration (768 × 576 px), le natif est aussi petit que l'aperçu : la barre de progression n'a presque rien à charger. Elle prend tout son sens sur un volume de plusieurs gigaoctets.
:::

### Exports et limites

- **PNG** : taille native, fond noir, avec une **ligne de légende toujours incrustée** en haut à gauche (jeu | plan | taille | pixel). Refusé au-delà de 16 384 px de côté ou 2²⁸ pixels.
- **JSON** (`<jeu>_studio.json`) : calques, repères, canaux, plan, calibration. **Jamais de pixels.** À l'import, un fichier de plus de **5 Mo**, 2 000 calques ou 10 000 points est refusé ; un fichier d'une autre figure n'applique que les calques.
- Au-delà de 4 canaux, seuls les 4 premiers sont montrés. Sans calibration : pas de barre d'échelle, mesures en pixels.

## 12.8 La page Comparer {.page}

::: tldr
- **À quoi ça sert** : afficher jusqu'à **quatre** jeux de données côte à côte, en gardant les vues synchronisées.
- Chaque panneau est la **vraie page** du viewer (ou de la page 2D) : mêmes outils, mêmes raccourcis.
- Une mémoire graphique unique est **partagée** entre les panneaux (qualité automatique).
:::

![Trois panneaux : deux volumes et une photographie. (1) ajouter, (2) outils communs, (8) synchronisations.](img/ch12/comparer.png){.shot width=100%}

::: legend
| n | ce que c'est |
|---|---|
| 1 | [Ajouter un jeu de données]{.ui} (recherche, filtre par type) |
| 2 | Outils communs : ce qu'offrent les pages ouvertes |
| 3 | [Studio]{.ui} : une figure avec tous les panneaux |
| 4 | [Exporter]{.ui} : figure PNG / WebP de la grille |
| 5 | [Sauvegarder]{.ui} / [Restaurer]{.ui} l'espace de travail |
| 6 | Disposition : Auto, colonnes, lignes, grille (gouttières réglables) |
| 7 | Qualité : auto, 512, 1024, natif |
| 8 | SYNC : [Plan Z]{.ui}, [Temps]{.ui}, [Caméra / vue]{.ui}, [Canaux]{.ui} |
| 9 | Le nom du jeu de données du panneau |
| 10 | Les boutons à bascule **décrits par la page** de ce panneau |
:::

### Ce qui est synchronisé

| Option | Ce qui voyage entre panneaux |
|---|---|
| [Plan Z]{.ui} | coupe du Z-stack, plan de la coupe oblique |
| [Temps]{.ui} | position dans la série, **en fraction** (frame = fraction × (N − 1)) : 100 images et 10 images restent alignées |
| [Caméra / vue]{.ui} | angle de vue 3D (corrigé de la calibration de chacun) ; pour une photographie, l'échelle physique |
| [Canaux]{.ui} | état et exposition, **par nom de canal** |

Un panneau ajouté tard est « rattrapé » : il reçoit la dernière caméra, le dernier temps, etc.

### La mémoire partagée

::: analogy
**Un buffet à budget fixe.** La carte graphique offre 1,5 Gio pour tous les panneaux. Chaque volume dit ce que coûte chaque qualité. Le viewer rabaisse le plus gourmand tant que le total dépasse, puis remonte le plus modeste tant que ça rentre, sans dépasser 1024 en automatique.
:::

Les panneaux démarrent en 512 ; la montée de qualité se fait **un panneau à la fois** (délai de 180 s). Choisir 512/1024/Natif à la main force le niveau.

### Décomposer, figure, espace de travail

![Un volume à trois canaux, [Décomposer]{.ui} : trois panneaux, un canal chacun. La synchro [Canaux]{.ui} (1) a été décochée automatiquement.](img/ch12/comparer-decomposer.png){.shot width=100%}

- **Décomposer** n'apparaît que s'il y a **un seul** panneau volumique de plusieurs canaux : il le clone en panneaux (4 au plus), un canal chacun, en gardant temps et caméra synchrones.
- **Studio** : une figure avec tous les panneaux, en [Taille Visuelle]{.ui} ou en [Échelle Physique]{.ui} (une seule échelle en µm/px pour tous, jamais sur-échantillonnée).
- **Exporter** compose la grille visible (4096 px de côté au plus).
- **Sauvegarder** garde l'espace de travail dans le navigateur ; **Restaurer** le recharge. L'adresse de la page contient aussi l'état (`#state=…`).

## 12.9 La frise temporelle et le suivi cellulaire {.page}

::: tldr
- Une **série temporelle** (type *Live*) ajoute une frise en bas de l'écran pour la lire.
- Si elle a un suivi cellulaire, **cinq outils** s'ajoutent : trajectoires, surface, inspecteur, distance entre cellules, graphiques.
- Exemple : le jeu de démonstration de 4 images avec suivi (50 cellules).
:::

![La frise : lecture (1), vitesse (2), compteur (3), piste (4) ; et la couche [Points de suivi]{.ui} (5).](img/ch12/timeline.png){.shot width=100%}

::: legend
| n | ce que c'est |
|---|---|
| 1 | Lecture / pause |
| 2 | Vitesse : un clic fait défiler 0,5 → 1 → 2 → 5 → 10 → 20 img/s |
| 3 | Compteur : image en cours / dernière image (000 / 003 = 4 images) |
| 4 | Piste : glisser pour aller à une image ; la bande indique les images déjà chargées |
| 5 | Couche de points de suivi : taille, opacité, mitoses, fusions, légende par région |
:::

- La lecture saute des images plutôt que de les empiler ; l'horloge **attend** l'image si elle n'est pas arrivée (jusqu'à 15 s).
- Les images suivantes sont préchargées. [Tampon 4/4 · 512×512]{.ui} indique ce qui tient en mémoire.
- Il n'y a pas d'horloge en minutes sur la frise : l'affichage est en numéro d'image.

![Sur cette série, la barre est repliée : le menu ☰ regroupe les outils de suivi (1 à 5).](img/ch12/suivi-menu.png){.shot width=60%}

::: legend
| n | ce que c'est |
|---|---|
| 1 | [Inspecter une cellule]{.ui} (<kbd>I</kbd>) |
| 2 | [Distance entre cellules]{.ui} (<kbd>D</kbd>) |
| 3 | [Graphiques de suivi]{.ui} |
| 4 | [Trajectoires]{.ui} |
| 5 | [Surface de suivi]{.ui} |
:::

### Trajectoires et surface

![Les sections [Surface de suivi]{.ui} (2) et [Trajectoires]{.ui} (1) dans la colonne de gauche, à la dernière image.](img/ch12/suivi-trajectoires.png){.shot width=100%}

- **Trajectoires** : longueur de la trace (0 = toutes les images), chemin à venir, opacité, couleur par **région** ou par **vitesse** (bleu lent → rouge rapide, échelle fixe sur toute la série).
- **Surface de suivi** : la surface du tissu (`model.glb`) dans le volume, colorée en uniforme, par **densité cellulaire** ou par région, avec une palette au choix et un **plan de coupe** (XY, XZ, YZ ou oblique).

::: tech
Densité locale d'un sommet : somme de gaussiennes `exp(−|v−c|²/2σ²)` sur les cellules de l'image courante, avec σ = 0,52 × rayon de voisinage, borné entre 8 et 54 µm, puis deux lissages sur le maillage. Vitesse d'un segment : |Δposition| en µm / Δt.
:::

::: warning
Sur le jeu de démonstration, les cellules se déplacent de quelques micromètres seulement entre deux images : aucun trait n'était lisible dans nos captures en rendu logiciel. Les curseurs et le résumé s'appliquent bien ; essayez sur une série réelle.
:::

### Inspecter une cellule

![Cellule 15 sélectionnée (1). Colonne de gauche : identifiant (2), métriques (3), voisines (4).](img/ch12/suivi-inspecteur.png){.shot width=100%}

::: steps
1. Appuyez sur <kbd>I</kbd>, puis cliquez une sphère (ou tapez son numéro et [Trouver]{.ui}).
2. Lisez les tuiles : piste, région, images, vitesse moyenne, longueur du trajet, déplacement net, rectitude, évènement.
3. Explorez le lignage (mère, filles) et les **voisines** à moins de 35, 55, 85 ou 120 µm.
:::

::: tech
Longueur du trajet = Σ |p(f+1) − p(f)| ; déplacement net = |p(dernière) − p(première)| ; **rectitude = déplacement / longueur** (1 = ligne droite). Vitesse moyenne = longueur / durée, en µm/image, et en µm/min si l'intervalle est connu. Ici 4,35 µm de trajet pour 4,04 µm de déplacement : rectitude 0,93.
:::

Boutons d'export : [CSV de la piste]{.ui}, [CSV des voisines]{.ui}, [JSON du lignage]{.ui}.

### Distance entre cellules et graphiques

:::::: cols
::::: col
![Deux cellules (1, 2) et le panneau (3) : 41,6 µm.](img/ch12/suivi-distance.png){.shot width=100%}
:::::
::::: col
![Population par région (jeu de démonstration).](img/ch12/suivi-graphiques.png){.shot width=100%}
:::::
::::::

- **Distance entre cellules** (<kbd>D</kbd>) : cliquez deux cellules suivies. Mode [Instantané]{.ui} (positions gardées) ou [Suivre les cellules]{.ui} (relue à chaque image ; « Hors image » si l'une disparaît). Formule : √(Δx² + Δy² + Δz²) en µm.
- **Graphiques de suivi** : [Population]{.ui}, [Vitesse]{.ui}, [Voisines]{.ui}, [Mitoses]{.ui}, échelle [Linéaire]{.ui} ou [Log]{.ui}, une courbe par région.

## 12.10 La page 2D : les photographies {.page}

::: tldr
- **À quoi ça sert** : afficher une photographie calibrée (stéréomicroscope, ici X-gal), la mesurer et la comparer.
- Le moteur est plus simple qu'en 3D : un canevas qu'on déplace et qu'on zoome.
- **Isoler le marquage** est une aide visuelle : rien de ce qui est mesuré ne la lit.
:::

![La page 2D (1 à 17 : les boutons ; 18 : barre d'échelle ; 19 : zoom et µm/px ; 20 : fiche du spécimen).](img/ch12/2d-barre.png){.shot width=100%}

::: legend
| n | ce que c'est |
|---|---|
| 1, 2 | [Naviguer]{.ui}, [Mesurer la distance]{.ui} |
| 3 | [Ouvrir dans le Studio (annoter)]{.ui} |
| 4, 5, 6 | Téléchargement, [Constructeur de planche]{.ui}, capture |
| 7, 8 | [Ajuster à l'écran (F)]{.ui}, [Résolution native 1:1]{.ui} |
| 9 | [Isoler le marquage]{.ui} |
| 10, 11, 12 | [Grille calibrée]{.ui}, [Réglages d'affichage]{.ui}, [Orientation]{.ui} |
| 13, 14, 15 | Photographie précédente, parcourir la collection, suivante |
| 16, 17 | Mode présentation, [Vue divisée]{.ui} |
:::

- **Navigation** : molette pour zoomer autour du curseur, glisser pour déplacer, double-clic pour ajuster. Le zoom va de 0,25 × l'ajustement à 32 pixels d'écran par pixel d'image.
- **Chargement en deux temps** : un aperçu (≈ 640 px) puis l'image native.
- **Barre d'échelle** en bas à gauche, valeur 1-2-5, calculée avec la taille de pixel (ici 2,000 µm/px). Sans calibration : [Non calibré]{.ui}.
- [Parcourir la collection]{.ui} (<kbd>B</kbd>) ouvre une planche-contact filtrable par stade et lignée.

![Une mesure : 1,58 mm (1,576 mm dans la liste).](img/ch12/2d-mesure.png){.shot width=88%}

La mesure est `√(Δx² + Δy²) × taille de pixel` : la photographie est plane, il n'y a pas de Z. Les étiquettes se déplacent à la souris.

### Isoler le marquage (X-gal)

![Avant (à gauche) et après (à droite) : le marquage bleu ressort, le reste devient gris sombre.](img/ch12/2d-avant-apres.png){.shot width=100%}

Le X-gal rend un pixel plus **bleu** que le tissu voisin. Mais le fond mat porte aussi des grains bleutés. Pour ne pas les allumer, l'outil exige que le bleu soit **à l'intérieur d'un tissu jaune**.

![Le calcul, pixel par pixel.](img/ch12/xgal.svg){width=96%}

::: tech
Constantes du code : rapport bas 1,0, haut 1,8 ; contexte à 1/4 de résolution, flou de rayon 5 (≈ 40 px), seuil 5. Luminosité = 0,299 R + 0,587 V + 0,114 B. Le tout tourne dans un *worker* (la page reste fluide), seule la dernière requête est traitée, la carte de contexte est gardée tant que l'image ne change pas. L'outil est réglé pour du X-gal sur tissu jaune : d'autres colorations ou fonds peuvent être mal détectés.
:::

### Affichage, grille, orientation

:::::: cols
::::: col
![[Réglages d'affichage]{.ui}.](img/ch12/2d-affichage.png){.shot width=100%}
:::::
::::: col
![[Grille calibrée]{.ui} (200 µm).](img/ch12/2d-grille.png){.shot width=100%}
:::::
::::::

- **Réglages d'affichage** : [Luminosité]{.ui}, [Contraste]{.ui}, [Gamma]{.ui}, balance [Rouge]{.ui}/[Bleu]{.ui}, [Aplatir le fond (vignettage)]{.ui}. *Affichage seulement* : les mesures lisent la photo intacte. Par canal : `x = (v/255 · balance − ½)(1 + contraste/100) + ½ + luminosité/100`, puis `x^(1/gamma)`.
- **Aplatir le fond** : une surface lissée (quadratique) est ajustée sur les 40 % de pixels les plus sombres (le fond) et le gain correspondant est appliqué, entre 0,5 et 3.
- **Grille calibrée** : un clic = aucune → large (≈ 120 px) → fine (≈ 60 px), pas en 1-2-5 µm.

![[Orientation]{.ui} : rotation de 25°, boussole A (antérieur) / P (postérieur).](img/ch12/2d-orientation.png){.shot width=88%}

L'**orientation** tourne l'image sans changer l'échelle (rotation, ±90°, miroir). L'administrateur enregistre la pose avec le jeu de données ; elle est réappliquée à chaque ouverture.

### Vue divisée et planche de figure

![[Vue divisée]{.ui} : deux embryons au **même grossissement physique**.](img/ch12/2d-vue-divisee.png){.shot width=100%}

La vue divisée échange une vue **physique** (µm par pixel d'écran + position) entre les deux côtés : deux photos prises à des zooms différents sont à la même échelle, et déplacer l'une déplace l'autre de la même distance réelle.

![Le [Constructeur de planche]{.ui} : liste (1), options (2), aperçu (3), export (4).](img/ch12/2d-planche.png){.shot width=100%}

La planche assemble plusieurs photographies en un PNG : **même échelle physique** (une barre commune, chaque image est ramenée au pixel le plus grossier, jamais agrandie) ou **même taille d'image** (une barre par panneau). Limites : 6000 px de large, 120 mégapixels. Elle s'ouvre aussi dans le Studio.

## 12.11 Raccourcis clavier et partage d'une vue {.page}

::: tldr
- Les raccourcis sont ignorés quand vous tapez dans un champ.
- **Partager une vue** = copier l'adresse de la page : l'état est dans le lien.
:::

:::::: cols
::::: col
**Viewer 3D**

| Touche | Action |
|---|---|
| <kbd>V</kbd> / <kbd>Échap</kbd> | Naviguer |
| <kbd>C</kbd> | Coupe |
| <kbd>M</kbd> | Mesurer |
| <kbd>I</kbd> | Inspecter une cellule |
| <kbd>D</kbd> | Distance entre cellules |

**Page 2D**

| Touche | Action |
|---|---|
| ← / → | Photo précédente / suivante |
| <kbd>B</kbd> | Planche-contact |
| <kbd>F</kbd> | Ajuster à l'écran |
:::::
::::: col
**Studio**

| Touche | Action |
|---|---|
| <kbd>V</kbd> <kbd>R</kbd> <kbd>E</kbd> | Sélection, rectangle, ellipse |
| <kbd>A</kbd> <kbd>L</kbd> <kbd>T</kbd> | Flèche, ligne, texte |
| <kbd>D</kbd> <kbd>G</kbd> <kbd>S</kbd> | Distance, angle, barre d'échelle |
| <kbd>Espace</kbd> | Déplacer (maintenu) |
| <kbd>Ctrl</kbd>+<kbd>K</kbd> | Palette de commandes |
| <kbd>Ctrl</kbd>+<kbd>Z</kbd> / <kbd>Ctrl</kbd>+<kbd>Maj</kbd>+<kbd>Z</kbd> | Annuler / rétablir |
| <kbd>Suppr</kbd> | Supprimer le calque |
| <kbd>[</kbd> / <kbd>]</kbd> | Tourner de −15° / +15° |

**Souris** : clic gauche glissé = tourner ; <kbd>Maj</kbd> ou clic droit/milieu = déplacer ; molette = zoom.
:::::
::::::

### Partager une vue

La page écrit toutes les secondes son état dans l'adresse (`#state=…`, compressé) : caméra, canaux, outil actif, plan de coupe, **mesures**, image de la série, qualité, réglages des outils. Copiez simplement l'adresse.

- Celui qui ouvre le lien voit : [Ce lien contient une vue enregistrée]{.ui} avec [Ouvrir la vue enregistrée]{.ui} ou [Ouvrir le jeu de données à neuf]{.ui}.
- [Réinitialiser l'espace de travail]{.ui} (bouton 21) remet vue, outils, canaux et mesures à l'état d'ouverture ; la **qualité** n'est pas modifiée.
- Le viewer n'a pas de bouton « Sauvegarder » : c'est l'adresse qui sert de sauvegarde. La page Comparer, elle, a [Sauvegarder]{.ui} / [Restaurer]{.ui} (§ 12.8).

::: remember
- Une mesure est calculée en **µm** sur ce que **vous voyez** ; un clic dans le vide est refusé.
- Coupe oblique et Z-stack s'excluent l'un l'autre.
- Le Studio exporte au natif ; son JSON ne contient jamais de pixels.
- Comparer = les vraies pages dans des cadres, avec un budget mémoire partagé.
- « Isoler le marquage » est une aide visuelle, pas une mesure.
:::
