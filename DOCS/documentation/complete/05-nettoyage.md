# 5. Nettoyer l'image : retirer le bruit de fond

::: chapter-intro
- Le pipeline traite **chaque canal séparément** en cinq temps : mesurer le fond, mesurer le blanc, protéger le signal, lisser le fond, puis convertir de 16 à 8 bits.
- Tout est calculé **à partir de voxels de référence** (les 8 coins, un voxel sur 4) : aucune valeur n'est choisie à la main, et rien n'est « embelli » ni inventé.
- Résultat : un fond **exactement noir (0)**, un signal intact, et des valeurs 8 bits **relatives** à chaque canal. Le .ims original reste la seule source quantitative.
:::

Après une vue d'ensemble et un exemple complet (§ 5.2 et 5.3), ce chapitre suit **l'ordre exact du code** (`2-image_processor.py`), étape A à E. Toutes les images viennent du jeu de démonstration (embryon synthétique), canal DAPI, coupe z = 56 ; elles sont calculées avec les fonctions du pipeline lui-même.

![Les cinq temps du nettoyage d'un canal.](img/ch05/chaine.svg){width=100%}

## 5.1 Pourquoi nettoyer ?

Une caméra de microscope n'est jamais parfaitement noire : même sans échantillon, chaque voxel affiche un petit nombre aléatoire (le **bruit de caméra**). Dans le jeu de démonstration, il oscille autour de 2 600 sur une échelle de 0 à 65 535.

Dans le navigateur, le rendu **cumule** la lumière le long de chaque rayon. Un fond de 2 600 répété sur 112 coupes finit en brouillard gris qui masque l'embryon.

::: analogy
C'est une **salle de cinéma avec un écran jamais tout à fait noir** : les lumières de secours éclairent la salle. Le nettoyage règle le « noir » de l'écran sur le niveau de la salle, pour que seul le film reste visible.
:::

## 5.2 L'idée en une page

Tout le nettoyage se résume à **une seule question**, posée à chaque voxel : *fait-il partie de l'embryon ?*

![Le destin d'un voxel. Les pourcentages sont mesurés sur tout le volume du jeu de démonstration (canal DAPI).](img/ch05/destin.svg){width=100%}

:::: cols
::: col
**OUI** (il est dans le « masque ») :

- on **ne touche à rien** ;
- sa valeur d'origine est simplement convertie en 8 bits.
:::
::: col
**NON** (il est hors du masque) :

- on le **remplace par la médiane** de ses 27 voisins ;
- cette valeur est presque toujours sous le plancher, donc il devient **0**.
:::
::::

::: keynums
**85,1 %**
fond déjà sous le plancher

**1,0 %**
pics de bruit au-dessus du plancher

**13,9 %**
dans le masque : gardés tels quels
:::

Pour répondre à la question, le pipeline a besoin de **deux repères** et d'**une carte** :

| Question | Réponse du pipeline | Nom dans le code |
|---|---|---|
| À quel niveau commence le vrai signal ? | 99 % du bruit des 8 coins est en dessous | **plancher** (`bg_floor`) |
| À quel niveau mettre le blanc ? | 99,9 % de tous les voxels sont en dessous | **plafond** (`sig_max`) |
| Où est l'embryon ? | les voxels nettement au-dessus du plancher, sans les points isolés, avec un halo | **masque** |
| Que faire du reste ? | remplacer chaque voxel par la médiane de ses voisins | **médiane** |
| Comment passer en 8 bits ? | plancher → 0, plafond → 255, une droite entre les deux | **fenêtre** |

::: analogy
Pensez à un **correcteur de copies** qui doit effacer les taches d'encre d'une feuille. Il ne touche pas aux lignes écrites (le masque). Une tache isolée (un point) est effacée. Pour savoir ce qu'est une tache, il regarde autour : si tout autour est blanc, c'est une tache ; si c'est au milieu d'un mot, c'est de l'écriture.
:::

## 5.3 Un exemple complet, voxel par voxel

Prenons **19 voxels alignés**, avec les vrais repères du jeu de démonstration (plancher 4 524, plafond 33 663). On y a placé un **pic de bruit** (4 700), un **pixel chaud** (9 000) et une **cellule** entourée de son halo.

![Les six étapes, ligne par ligne. Exemple en une dimension pour qu'on puisse lire chaque nombre ; le pipeline applique exactement les mêmes règles en 3D.](img/ch05/profil_etapes.svg){width=100%}

Lisez la figure de haut en bas :

::: steps
1. **Valeurs brutes.** Les cases encadrées de rouge dépassent le plancher. Il y en a 8 : le pic de bruit, le pixel chaud, la cellule et le bord du halo (4 800).
2. **Seuil.** On ne garde comme « signal certain » que ce qui dépasse **1,1 × plancher = 4 976**. Le pic de bruit (4 700) et le bord du halo (4 800) ne passent pas ; le pixel chaud (9 000) passe.
3. **Ouverture.** Le pixel chaud est **seul** : il est retiré (✗). La cellule, assez large, reste.
4. **Dilatation × 3.** Le masque s'élargit de **3 voxels de chaque côté** de la cellule (+). Le halo, y compris le 4 800, est maintenant protégé.
5. **Médiane.** Hors du masque, chaque voxel prend la valeur du milieu de ses voisins. Le pic de bruit 4 700 devient **2 900** ; le pixel chaud 9 000 devient **3 300**. Dans le masque (vert), rien ne change.
6. **Fenêtre.** Tout ce qui est sous 4 524 devient **0**. La cellule va de 12 à 187 ; le halo à 4 800 donne **2** (il est gardé, très sombre).
:::

::: example
**Et sans masque ni médiane ?** (dernière ligne de la figure) La fenêtre seule laisserait passer le pic de bruit (**1**) et le pixel chaud (**39**) : deux points gris parasites sur fond noir. C'est tout l'intérêt du masque et de la médiane.
:::

## 5.4 Étape A : le plancher (`bg_floor`)

Où trouver du fond pur, sans embryon ? **Dans les coins** du volume : l'embryon est au centre, rien n'y touche. Le pipeline prélève **8 cubes**, un par coin, de **32 voxels de côté au maximum**.

![Les 8 cubes de coin (schéma). Dans le jeu de démonstration, la pile ne compte que 112 coupes : le côté vaut min(32, X÷4, Y÷4, Z÷4) = 28 voxels, soit 8 × 28³ = 175 616 voxels de référence.](img/ch05/coins.svg){width=90%}

Puis : **plancher = 99e percentile de ces voxels**, c'est-à-dire la valeur sous laquelle se trouvent 99 % d'entre eux.

::: example
On range les 175 616 voxels de coin du plus petit au plus grand. Le voxel qui se trouve aux 99 % de la file vaut **4 524** : c'est le plancher.

- la moyenne du bruit est d'environ 2 600 ;
- 99 % du bruit est **sous 4 524** ;
- 1 % du bruit le **dépasse** (le plus fort voxel de coin vaut 6 238).
:::

![À gauche : les voxels des 8 coins forment une « cloche » de bruit ; la ligne rouge est leur 99e percentile. À droite : tout le volume (1 voxel sur 4, échelle logarithmique) ; le gros pic à gauche est le fond, la longue traîne est le signal (jeu de démonstration, canal DAPI).](img/ch05/histogramme.png){width=100%}

::: why
**Pourquoi le 99e et pas le maximum ?** Le maximum dépend d'un seul voxel, le plus extrême : il varie beaucoup d'une acquisition à l'autre et couperait du signal faible. Le 99e percentile est stable ; le 1 % de bruit qui le dépasse est traité ensuite par le masque et la médiane. Le code a testé d'autres règles (5e puis 20e percentile, 10e percentile des coins) avant de retenir celle-ci.
:::

::: warning
Si un coin touche l'échantillon (coupe serrée, mosaïque de tuiles), le plancher peut être trop haut et couper du signal faible. Le pipeline l'**écrit dans son journal** (« corner noise well above the volume median ») mais ne change rien : il ne corrige jamais en silence.
:::

## 5.5 Étape B : le plafond (`sig_max`)

Pour le haut de l'échelle, on regarde **tout le volume**, mais en ne lisant **qu'un voxel sur 4** dans chaque direction (indices 0, 4, 8…). On lit ainsi 1 voxel sur 64, sans changer la statistique.

![Échantillonnage du point blanc : 1/64 des voxels suffisent.](img/ch05/echantillon.svg){width=95%}

**Plafond = 99,9e percentile de ces voxels** : les 0,1 % les plus brillants seront affichés en blanc (« saturés »). Dans le jeu de démonstration : **33 663**.

::: tldr
- Plancher = 4 524 : ce qui est en dessous deviendra 0.
- Plafond = 33 663 : ce qui est au-dessus deviendra 255.
- La plage utile est donc **[4 524 ; 33 663]**, et non [0 ; 65 535].
:::

## 5.6 Étape C : le masque, ou « où est l'embryon ? »

Le masque est une **carte oui / non** de la taille du volume : *oui* = ce voxel appartient à l'embryon (ou à son halo), on n'y touchera pas. Il se construit en trois gestes.

**1. Seuil : plus de 1,1 × plancher.** Ici 1,1 × 4 523,85 = **4 976**.

::: why
**Pourquoi 10 % au-dessus du plancher ?** Par définition, 1 % du bruit dépasse le plancher. Avec 10 % de marge, il n'en reste que **0,2 %** (mesuré dans les coins du jeu de démonstration) : cinq fois moins de bruit pris pour du signal.
:::

**2. Ouverture : retirer les points isolés.** C'est une **érosion** (on « ronge » 1 voxel sur tout le pourtour) suivie d'une **dilatation** (on « rend » 1 voxel). Un objet assez épais retrouve sa forme ; un point isolé, rongé entièrement à la première étape, ne revient pas.

**3. Dilatation × 3 : ajouter un halo.** Le masque est élargi de **3 voxels** tout autour. La fluorescence ne s'arrête pas net au bord d'une cellule : elle décroît. Le halo protège cette décroissance (et du signal faible tout proche) de la médiane.

![Les trois gestes du masque sur la coupe z = 56. Ligne du bas : zoom. En rouge, les voxels retirés par l'ouverture ; en bleu, ceux ajoutés par la dilatation.](img/ch05/masque.png){width=100%}

::: keynums
**11,77 %**
voxels au-dessus du seuil

**11,32 %**
après l'ouverture

**13,92 %**
masque final (avec halo)
:::

::: example
**Le halo en micromètres.** Avec les voxels du jeu de démonstration (1,2 × 1,2 × 3,0 µm), 3 voxels représentent **3,6 µm** en X et en Y, et **9 µm** en Z. Comme la dilatation se fait par faces, le halo est un peu plus étroit en diagonale (forme de losange).
:::

### Qu'est-ce qu'un « voisin » ?

L'érosion et la dilatation regardent les voisins d'un voxel. Le pipeline utilise la **croix à 6 voisins** : les deux voisins en X, en Y et en Z, qui partagent une face. Les diagonales ne comptent pas.

![L'élément structurant : la croix 3D à 6 voisins (réglage par défaut de scipy, non modifié par le pipeline).](img/ch05/croix.svg){width=90%}

### L'ouverture en miniature

![Mini-grille 7 × 7. Le bloc de 4 × 4 pixels survit (ses coins sont un peu arrondis), le pixel chaud isolé disparaît. Calculé avec scipy.](img/ch05/ouverture.svg){width=100%}

::: example
Sur la grille : 17 pixels allumés au départ (16 de signal + 1 chaud) ; après l'ouverture il en reste **12** : le pixel chaud et les 4 coins du bloc sont partis. Les coins du bloc reviennent ensuite grâce à la dilatation × 3.
:::

::: why
L'ouverture est faite **avant** la dilatation. Dans l'ordre inverse, un pixel chaud serait « protégé » et même **agrandi** par la dilatation. Ici, il reste hors du masque, donc il sera écrasé par la médiane.
:::

## 5.7 Étape D : la médiane, hors du masque seulement

Pour chaque voxel **hors du masque**, le pipeline prend les **27 voxels** du petit cube 3 × 3 × 3 qui l'entoure, les range dans l'ordre, et garde **celui du milieu** (le 14e). Dans le masque, la valeur d'origine est gardée.

![Médiane contre moyenne sur 9 valeurs (exemple 2D) : un pixel chaud à 52 000 est écrasé par la médiane (2 990), mais fait grimper la moyenne à 8 404.](img/ch05/mediane.svg){width=100%}

::: analogy
La **médiane**, c'est le salaire « du milieu » d'une rue : un milliardaire qui emménage ne la change pas. La **moyenne**, elle, explose. C'est pourquoi un filtre médian écrase un pixel chaud sans inventer de valeur nouvelle.
:::

**À quoi sert-elle vraiment ?** À traiter le **1 % de bruit qui dépasse le plancher**. Sans elle, ces voxels deviendraient de petits points gris dans le fond noir.

::: keynums
**341 674**
points de bruit visibles avec la fenêtre seule

**10 069**
avec masque + médiane

**− 97 %**
de points parasites
:::

::: note
Les 10 069 voxels qui restent (0,02 % du volume) ont une médiane au-dessus du plancher : ce sont des **zones faibles mais étendues**, où plus de la moitié des 27 voisins dépassent le plancher. Un point isolé, lui, ne survit jamais : ses voisins sont du fond.
:::

## 5.8 Étape E : la fenêtre, de 16 à 8 bits

Dernière opération, voxel par voxel, la même pour tout le volume. La formule exacte du code :

::: example
**u8 = tronqué( 255 × (clip(v, plancher, plafond) − plancher) ÷ (plafond − plancher) )**

*v* est la valeur du voxel (d'origine dans le masque, médiane en dehors) ; *clip* ramène *v* entre le plancher et le plafond ; « tronqué » veut dire que l'on jette les décimales (pas d'arrondi).
:::

![La fenêtre : plat à 0 sous le plancher, plat à 255 au-dessus du plafond, linéaire entre les deux. Les points orange sont les micro-exemples ci-dessous.](img/ch05/fenetre.png){width=85%}

::: example
Avec plancher = 4 523,85 et plafond = 33 662,57 (écart : 29 138,72) :

- v = 4 000 → sous le plancher → **0** ;
- v = 10 000 → 255 × 5 476,15 ÷ 29 138,72 = 47,9 → **47** ;
- v = 20 000 → 255 × 15 476,15 ÷ 29 138,72 = 135,4 → **135** ;
- v = 40 000 → au-dessus du plafond → **255**.
:::

::: note
La conversion est **linéaire**, sans courbe gamma. Tout voxel ≤ plancher devient **exactement 0** : le fond est un noir parfait, ce qui permet de ne stocker aucune brique vide (chapitre 6). Dans le jeu de démonstration, **88,2 %** des voxels du canal DAPI valent 0 après nettoyage.
:::

## 5.9 Sur de vraies images

### Une ligne au bord de l'embryon

![En haut, les valeurs brutes le long d'une ligne : vert = dans le masque (valeur gardée), orange = hors masque (la médiane, qui remplace la valeur). Bande verte = masque. En bas, le résultat 8 bits.](img/ch05/profil_reel.png){width=100%}

- **À gauche et à droite** (fond) : les valeurs brutes oscillent entre 1 000 et 4 000 ; la médiane (orange) les lisse autour de 2 600 ; résultat **0**.
- **Au centre** (tissu) : la bande verte couvre le tissu **et ses 3 voxels de halo** ; les valeurs sont gardées, et le creux sombre du milieu reste un creux.

### Une ligne dans une zone faible

![Même lecture, dans une zone où le tissu est à peine au-dessus du bruit (axes agrandis). Pointillé rouge : ce que donnerait la fenêtre seule.](img/ch05/profil_faible.png){width=100%}

- Seuls les pics qui forment un **petit amas** (au moins quelques voxels dans les 3 directions) entrent dans le masque et sont gardés.
- Les pics étroits (vers x = 405–412), même à 7 000, sont **retirés** : le pointillé rouge montre ce qu'on aurait vu sans médiane.

### La carte des destins

![À gauche le brut, au milieu ce que devient chaque voxel, à droite le résultat. Dans une zone faible, le masque (vert) ne garde que les amas ; l'orange est écrasé par la médiane ; le rouge, rare, survit à la médiane.](img/ch05/destin_carte.png){width=100%}

## 5.10 Taille minimale d'un objet

Conséquence directe de l'ouverture et de la médiane : **un objet trop fin est effacé, même s'il est très brillant.**

![Barres de section carrée, à 20 000 (brillant) ou 6 000 (faible). Les sections 1 × 1 et 2 × 2 disparaissent ; à partir de 3 × 3, l'objet est gardé intact, même faible.](img/ch05/epaisseur.png){width=100%}

| Forme de l'objet (en voxels) | Résultat | Pourquoi |
|---|---|---|
| point isolé, fil de 1 × 1, feuille de 1 d'épaisseur | **effacé** | l'ouverture le retire ; la médiane de ses 27 voisins est du fond |
| fil de 2 × 2, petit cube 2 × 2 × 2 | **effacé** | même raison : moins de 14 voisins sur 27 sont brillants |
| feuille de 2 d'épaisseur | gardé | l'ouverture le retire, mais la médiane reste brillante (18 voisins sur 27) |
| au moins 3 voxels dans chaque direction | **gardé intact** | il contient une croix complète : il entre dans le masque |

::: warning
**Ordre de grandeur : environ 3 voxels dans chaque direction.** Avec les voxels du jeu de démonstration (1,2 × 1,2 × 3,0 µm), cela fait **3,6 µm en X et en Y et 9 µm en Z**. Un objet présent sur une ou deux coupes seulement risque donc d'être effacé, quelle que soit sa brillance. Faites le calcul avec **vos** tailles de voxel ; en cas de doute, comparez avec le `.ims` d'origine. En pratique, le flou optique du microscope étale la plupart des objets sur plusieurs voxels, et un objet fin **collé** à un objet épais (à moins de 3 voxels) est protégé par le halo.
:::

## 5.11 Avant et après

![Même coupe avant (voxels bruts affichés de 0 au plafond) et après nettoyage. En bas : zoom sur le bord de l'embryon. Le grain gris du fond a disparu ; les noyaux sont intacts (jeu de démonstration).](img/ch05/avant_apres.png){width=100%}

Regardez le zoom : à gauche du bord, le fond gris granuleux est devenu noir pur ; à droite, les noyaux brillants ont la même forme et le même contraste.

## 5.12 Ce qui a été essayé, puis abandonné

Le pipeline a connu des méthodes plus sophistiquées, retirées à la version 0.12.0 :

| Méthode | Pourquoi abandonnée |
|---|---|
| Seuil d'Otsu | Soustraction du masque : créait de **gros blobs colorés** artificiels |
| Noise2Void (réseau de neurones) | Même résultat artefactuel ; l'embryon perdait sa texture naturelle |

::: why
Choix actuel : le pipeline **ne retire que le fond global de la caméra** et garde les intensités natives du microscope. Pas de réseau de neurones, pas de correction de champ plat. Un test sur un jeu de référence a retrouvé les 97 empreintes SHA-256 des paquets de production, octet pour octet.
:::

## 5.13 Séries temporelles : une seule fenêtre

Pour un film (plusieurs images), faut-il une fenêtre par image ? **Non : une seule pour toute la série**, pour chaque canal. Sinon l'image « clignote ».

![Schéma (chiffres illustratifs). Un fluorophore s'éteint (photoblanchiment). Si chaque image est étirée sur sa propre fenêtre, l'écran reste constant alors que le signal s'effondre : c'est faux. Avec une fenêtre unique, l'écran baisse comme le signal réel.](img/ch05/serie_temporelle.png){width=85%}

Comment la fenêtre unique est-elle mesurée ?

- jusqu'à **8 images** échantillonnées (régulièrement espacées, toujours la première et la dernière) ;
- `bg_floor` = 99e percentile des coins de toutes ces images réunies ;
- `sig_max` = 99,9e percentile **des seuls voxels au-dessus de `bg_floor`**, s'il y en a au moins **1 000**.

::: why
Dans une série éparse, le signal ne couvre que ~0,4 % des voxels : le 99,9e percentile du volume entier tomberait **dans le fond** et ferait saturer 15 % du vrai signal. En ne classant que les voxels au-dessus du fond, la part saturée tombe à environ 0,06 % (mesures du journal de version 0.15.0).
:::

Le photoblanchiment est **mesuré, jamais effacé** : le pipeline enregistre un niveau de signal par image et par canal (99,9e percentile du brut) dans `metadata.json`. Aucun réglage du viewer n'utilise encore ces niveaux : une série qui s'éteint s'affiche donc réellement plus sombre, et rien ne la « rattrape » à l'écran.

## 5.14 Gros volumes : par tuiles, sans changer le résultat

Un canal de 3789 × 3789 × 178 voxels représente 2,56 milliards de voxels, soit 10,2 Go en flottants 32 bits : il ne tient pas en mémoire. Le pipeline le lit donc **par tuiles** d'au plus **24 millions de voxels** (marge comprise).

![Découpage en tuiles. La marge de 5 voxels fournit aux calculs de bord (ouverture, dilatations) les voisins qui leur manquent ; seul le cœur est écrit.](img/ch05/tuiles.svg){width=100%}

Pourquoi 5 voxels ? L'érosion (1) + la dilatation de l'ouverture (1) + les 3 dilatations (3) propagent l'influence d'un voxel sur 5 voxels de distance. La médiane en demande 1 (couvert par la même marge).

::: example
**Vérifié sur le jeu de démonstration** (3 canaux) : découpé en 4 tuiles (réglage par défaut), puis en **256 tuiles** (0,5 M de voxels), le volume 8 bits est **identique octet pour octet** au calcul d'un seul bloc, et à celui du dataset publié par le pipeline (coupes z = 0, 30, 56 et 100).
:::

## 5.15 Ce que cela change pour vous

::: warning
Les valeurs 8 bits sont **relatives**, pas absolues. Chaque canal a sa propre fenêtre [`bg_floor` ; `sig_max`] ; 128 sur DAPI et 128 sur Pecam1 ne représentent pas la même quantité de lumière. Ne comparez pas d'intensités entre canaux ni entre datasets.
:::

- Dans une **série temporelle**, les valeurs sont comparables entre images **d'un même canal** (fenêtre unique).
- Le fichier **.ims original** n'est jamais modifié ; c'est la source pour toute mesure d'intensité. Il peut être téléchargé depuis le dossier `download/` si le dataset a été publié avec ses fichiers d'origine.
- Peuvent être effacés : un signal **très faible** (sous 1,1 × `bg_floor`) qui ne forme pas une zone étendue, et tout objet **plus fin qu'environ 3 voxels** dans une direction, même brillant (§ 5.10). C'est le prix d'un fond parfaitement noir. Dans le masque, en revanche, les valeurs d'origine sont gardées.

::: remember
1. `bg_floor` = 99e percentile de 8 cubes de coin ; `sig_max` = 99,9e percentile d'un voxel sur 4.
2. Masque = seuil 1,1 × `bg_floor` → ouverture (retire les points isolés) → dilatation × 3 (halo).
3. Médiane 3 × 3 × 3 **hors masque** ; le signal reste intact. Un objet de moins de ~3 voxels d'épaisseur est effacé.
4. 8 bits = fenêtre linéaire [`bg_floor` ; `sig_max`] → [0 ; 255], tronquée ; fond = 0 exact.
5. Une seule fenêtre pour tout un film ; les tuiles ne changent pas le résultat.
:::
