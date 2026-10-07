# 5. Nettoyer l'image : retirer le bruit de fond

::: chapter-intro
- Le pipeline traite **chaque canal séparément** en cinq temps : mesurer le fond, mesurer le blanc, protéger le signal, lisser le fond, puis convertir de 16 à 8 bits.
- Tout est calculé **à partir de voxels de référence** (les 8 coins, un voxel sur 4) : aucune valeur n'est choisie à la main, et rien n'est « embelli » ni inventé.
- Résultat : un fond **exactement noir (0)**, un signal intact, et des valeurs 8 bits **relatives** à chaque canal. Le .ims original reste la seule source quantitative.
:::

Ce chapitre suit **l'ordre exact du code** (`2-image_processor.py`). Toutes les images viennent du jeu de démonstration (embryon synthétique), canal DAPI, coupe z = 56 ; elles sont calculées avec les fonctions du pipeline lui-même.

![Les cinq temps du nettoyage d'un canal.](img/ch05/chaine.svg){width=100%}

## 5.1 Pourquoi nettoyer ?

Une caméra de microscope n'est jamais parfaitement noire : même sans échantillon, chaque voxel affiche un petit nombre aléatoire (le **bruit de caméra**). Dans le jeu de démonstration, il oscille autour de 2 600 sur une échelle de 0 à 65 535.

Dans le navigateur, le rendu **cumule** la lumière le long de chaque rayon. Un fond de 2 600 répété sur 112 coupes finit en brouillard gris qui masque l'embryon.

::: analogy
C'est une **salle de cinéma avec un écran jamais tout à fait noir** : les lumières de secours éclairent la salle. Le nettoyage règle le « noir » de l'écran sur le niveau de la salle, pour que seul le film reste visible.
:::

## 5.2 Étape A : mesurer le fond (`bg_floor`)

Où trouver du fond pur, sans embryon ? **Dans les coins** du volume : l'embryon est au centre, rien n'y touche. Le pipeline prélève **8 cubes**, un par coin, de **32 voxels de côté au maximum**.

![Les 8 cubes de coin (schéma). Dans le jeu de démonstration, la pile ne compte que 112 coupes : le côté vaut min(32, X÷4, Y÷4, Z÷4) = 28 voxels, soit 8 × 28³ = 175 616 voxels de référence.](img/ch05/coins.svg){width=90%}

Puis : **`bg_floor` = 99e percentile de ces voxels.** Le percentile est la valeur sous laquelle se trouvent 99 % des voxels. Ici :

- la plupart des voxels de coin valent entre 1 500 et 4 000 ;
- 99 % sont **inférieurs à 4 524** ;
- c'est `bg_floor` : le plafond du bruit de caméra.

![À gauche : les 175 616 voxels des 8 coins forment une « cloche » de bruit ; la ligne rouge est leur 99e percentile. À droite : tout le volume (1 voxel sur 4, échelle logarithmique) ; le gros pic à gauche est le fond, la longue traîne est le signal (jeu de démonstration, canal DAPI).](img/ch05/histogramme.png){width=100%}

::: example
Par construction, 1 % des voxels de coin dépassent `bg_floor` (mesuré : 1,0005 %). Le plus fort voxel de coin vaut 6 238. Un voxel de valeur 3 000 est donc du bruit probable ; un voxel de valeur 20 000 est du signal presque certain.
:::

::: why
**Pourquoi les coins ?** Parce que ce sont des voxels sans embryon, sûrs. Le code a testé d'autres règles (5e puis 20e percentile, 10e percentile des coins) avant de retenir le 99e percentile des 8 coins : il couvre presque tout le bruit sans toucher le signal.
:::

::: warning
Si un coin touche l'échantillon (coupe serrée, mosaïque de tuiles), `bg_floor` peut être trop haut et couper du signal faible. Le pipeline l'**avertit** dans son journal (« corner noise well above the volume median ») mais ne change rien : il ne corrige pas en silence.
:::

## 5.3 Étape A (suite) : mesurer le blanc (`sig_max`)

Pour le haut de l'échelle, on regarde **tout le volume**, mais en ne lisant **qu'un voxel sur 4** dans chaque direction (indices 0, 4, 8…). Ça économise 63 voxels sur 64 sans changer la statistique.

![Échantillonnage du point blanc : 1/64 des voxels suffisent.](img/ch05/echantillon.svg){width=95%}

**`sig_max` = 99,9e percentile de ces voxels** : on **sature** (met à blanc) les 0,1 % les plus brillants. Dans le jeu de démonstration : **sig_max = 33 663**.

::: tldr
- `bg_floor` = 4 524 : tout ce qui est en dessous est du fond.
- `sig_max` = 33 663 : tout ce qui est au-dessus devient blanc.
- La fenêtre utile est donc **[4 524 ; 33 663]**, pas [0 ; 65 535].
:::

## 5.4 Le masque : protéger le vrai signal

Avant de lisser le fond, il faut **repérer le signal** pour ne pas le lisser. Trois opérations, appliquées en 3D sur tous les voxels.

**1. Seuil.** Un voxel est « signal » s'il est **plus grand que 1,1 × `bg_floor`** (10 % au-dessus de la valeur du plancher). Ici : 1,1 × 4 523,85 = **4 976**.

**2. Ouverture** (1 itération) : une érosion puis une dilatation. Elle supprime les petits objets isolés (pixels chauds, grains de bruit).

**3. Dilatation × 3** : le masque est élargi de 3 voxels pour garder la décroissance naturelle de la fluorescence autour des cellules.

![Les trois étapes du masque sur la coupe z = 56. Ligne du bas : zoom. En rouge, les voxels retirés par l'ouverture (4 748 dans cette coupe) ; en bleu, ceux ajoutés par la dilatation.](img/ch05/masque.png){width=100%}

::: keynums
**11,77 %**
voxels > seuil

**11,32 %**
après ouverture

**13,92 %**
masque final
:::

### Qu'est-ce qu'un « voisin » ?

L'érosion et la dilatation regardent les voisins d'un voxel. Le pipeline utilise la **croix à 6 voisins** : les deux voisins en X, en Y et en Z, qui partagent une face. Les diagonales ne comptent pas.

![L'élément structurant : la croix 3D à 6 voisins (réglage par défaut de scipy, non modifié par le pipeline).](img/ch05/croix.svg){width=90%}

### L'ouverture en miniature

![Mini-grille 7 × 7. Le bloc de 4 × 4 pixels survit (ses coins sont un peu arrondis), le pixel chaud isolé disparaît. Calculé avec scipy.](img/ch05/ouverture.svg){width=100%}

::: example
Sur la grille : 17 pixels allumés au départ (16 de signal + 1 chaud) ; après l'ouverture il en reste **12** : le pixel chaud et les 4 coins du bloc sont partis. Le vrai signal est protégé par la dilatation qui suit (×3).
:::

::: why
L'ouverture est faite **avant** la dilatation. Dans l'ordre inverse, un pixel chaud serait « protégé » et même **agrandi** par la dilatation. Ici, il reste hors du masque, donc il sera écrasé par la médiane.
:::

## 5.5 La médiane, hors du masque seulement

Pour chaque voxel, le pipeline calcule la **médiane du cube 3 × 3 × 3** autour de lui (27 valeurs). Puis :

- **dans le masque** → on garde la valeur **originale**, intacte ;
- **hors du masque** → on la remplace par la **médiane**.

Résultat : le signal reste net, le fond est lissé.

![Médiane contre moyenne sur 9 valeurs (exemple 2D) : un pixel chaud à 52 000 est écrasé par la médiane (2 990), mais fait grimper la moyenne à 8 404.](img/ch05/mediane.svg){width=100%}

::: analogy
La **médiane**, c'est le salaire « du milieu » d'une rue : un milliardaire qui emménage ne la change pas. La **moyenne**, elle, explose. C'est pourquoi un filtre médian écrase un pixel chaud sans brouiller les contours.
:::

## 5.6 La fenêtre : de 16 à 8 bits

Dernière opération, voxel par voxel. La formule exacte du code :

::: example
**u8 = tronqué( 255 × (clip(v, bg, sig) − bg) ÷ (sig − bg) )**

*v* est la valeur du voxel (originale dans le masque, médiane en dehors) ; *bg* = `bg_floor` ; *sig* = `sig_max` ; *clip* ramène *v* entre *bg* et *sig*. « Tronqué » veut dire que l'on jette les décimales (pas d'arrondi).
:::

![La fenêtre : plat à 0 sous `bg_floor`, plat à 255 au-dessus de `sig_max`, linéaire entre les deux. Les points orange sont les micro-exemples ci-dessous.](img/ch05/fenetre.png){width=85%}

::: example
Avec bg = 4 523,85 et sig = 33 662,57 (donc sig − bg = 29 138,72) :

- v = 4 000 → sous le plancher → **0** ;
- v = 10 000 → 255 × 5 476,15 ÷ 29 138,72 = 47,9 → **47** ;
- v = 20 000 → 255 × 15 476,15 ÷ 29 138,72 = 135,4 → **135** ;
- v = 40 000 → au-dessus du blanc → **255**.
:::

::: note
La conversion est **linéaire**, sans courbe gamma. Tout voxel ≤ `bg_floor` devient **exactement 0** : le fond est un noir parfait, ce qui permet de ne stocker aucune brique vide (chapitre 6). Dans le jeu de démonstration, **88,2 %** des voxels du canal DAPI valent 0 après nettoyage.
:::

## 5.7 Avant et après

![Même coupe avant (voxels bruts affichés de 0 à `sig_max`) et après nettoyage. En bas : zoom sur le bord de l'embryon. Le grain gris du fond a disparu ; les noyaux sont intacts (jeu de démonstration).](img/ch05/avant_apres.png){width=100%}

Regardez le zoom : à gauche du bord, le fond gris granuleux est devenu noir pur ; à droite, les noyaux brillants ont la même forme et le même contraste.

## 5.8 Ce qui a été essayé, puis abandonné

Le pipeline a connu des méthodes plus sophistiquées, retirées à la version 0.12.0 :

| Méthode | Pourquoi abandonnée |
|---|---|
| Seuil d'Otsu | Soustraction du masque : créait de **gros blobs colorés** artificiels |
| Noise2Void (réseau de neurones) | Même résultat artefactuel ; l'embryon perdait sa texture naturelle |

::: why
Choix actuel : le pipeline **ne retire que le fond global de la caméra** et garde les intensités natives du microscope. Pas de réseau de neurones, pas de correction de champ plat. Un test sur un jeu de référence a retrouvé les 97 empreintes SHA-256 des paquets de production, octet pour octet.
:::

## 5.9 Séries temporelles : une seule fenêtre

Pour un film (plusieurs images), faut-il une fenêtre par image ? **Non : une seule pour toute la série**, pour chaque canal. Sinon l'image « clignote ».

![Schéma (chiffres illustratifs). Un fluorophore s'éteint (photoblanchiment). Si chaque image est étirée sur sa propre fenêtre, l'écran reste constant alors que le signal s'effondre : c'est faux. Avec une fenêtre unique, l'écran baisse comme le signal réel.](img/ch05/serie_temporelle.png){width=85%}

Comment la fenêtre unique est-elle mesurée ?

- jusqu'à **8 images** échantillonnées (régulièrement espacées, toujours la première et la dernière) ;
- `bg_floor` = 99e percentile des coins de toutes ces images réunies ;
- `sig_max` = 99,9e percentile **des seuls voxels au-dessus de `bg_floor`**, s'il y en a au moins **1 000**.

::: why
Dans une série éparse, le signal ne couvre que ~0,4 % des voxels : le 99,9e percentile du volume entier tomberait **dans le fond** et ferait saturer 15 % du vrai signal. En ne classant que les voxels au-dessus du fond, la part saturée tombe à environ 0,06 % (mesures du journal de version 0.15.0).
:::

Le photoblanchiment est **mesuré, jamais effacé** : le pipeline enregistre un niveau de signal par image et par canal (99,9e percentile du brut) dans `metadata.json`. Le viewer peut proposer une compensation facultative et réversible.

## 5.10 Gros volumes : par tuiles, sans changer le résultat

Un canal de 3789 × 3789 × 178 voxels représente 2,56 milliards de voxels, soit 10,2 Go en flottants 32 bits : il ne tient pas en mémoire. Le pipeline le lit donc **par tuiles** d'au plus **24 millions de voxels** (marge comprise).

![Découpage en tuiles. La marge de 5 voxels fournit aux calculs de bord (ouverture, dilatations) les voisins qui leur manquent ; seul le cœur est écrit.](img/ch05/tuiles.svg){width=100%}

Pourquoi 5 voxels ? L'érosion (1) + la dilatation de l'ouverture (1) + les 3 dilatations (3) propagent l'influence d'un voxel sur 5 voxels de distance. La médiane en demande 1 (couvert par la même marge).

::: example
**Vérifié sur le jeu de démonstration** (3 canaux) : découpé en 4 tuiles (réglage par défaut), puis en **256 tuiles** (0,5 M de voxels), le volume 8 bits est **identique octet pour octet** au calcul d'un seul bloc, et à celui du dataset publié par le pipeline (coupes z = 0, 30, 56 et 100).
:::

## 5.11 Ce que cela change pour vous

::: warning
Les valeurs 8 bits sont **relatives**, pas absolues. Chaque canal a sa propre fenêtre [`bg_floor` ; `sig_max`] ; 128 sur DAPI et 128 sur Pecam1 ne représentent pas la même quantité de lumière. Ne comparez pas d'intensités entre canaux ni entre datasets.
:::

- Dans une **série temporelle**, les valeurs sont comparables entre images **d'un même canal** (fenêtre unique).
- Le fichier **.ims original** n'est jamais modifié ; c'est la source pour toute mesure d'intensité. Il peut être téléchargé depuis le dossier `download/` si le dataset a été publié avec ses fichiers d'origine.
- Un signal **très faible** (sous 1,1 × `bg_floor`) ou réduit à un voxel isolé peut être effacé : c'est le prix d'un fond parfaitement noir. Dans le masque, en revanche, les valeurs d'origine sont gardées.

::: remember
1. `bg_floor` = 99e percentile de 8 cubes de coin ; `sig_max` = 99,9e percentile d'un voxel sur 4.
2. Masque = seuil 1,1 × `bg_floor` → ouverture → dilatation × 3.
3. Médiane 3 × 3 × 3 **hors masque** ; le signal reste intact.
4. 8 bits = fenêtre linéaire [`bg_floor` ; `sig_max`] → [0 ; 255], tronquée ; fond = 0 exact.
5. Une seule fenêtre pour tout un film ; les tuiles ne changent pas le résultat.
:::
