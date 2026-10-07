# 9. Le viewer 3D : Three.js et le lancer de rayons

::: chapter-intro
- Chaque pixel de l'écran est calculé par **un rayon** qui traverse le volume : c'est le **lancer de rayons**, exécuté par la carte graphique.
- **Three.js** fournit la scène, la caméra et les textures ; le calcul qui compte pour la science (les trois modes de rendu) est **écrit sur mesure** et reste lisible.
- Pendant que vous tournez l'embryon, la netteté baisse un instant pour garder la fluidité ; au repos, tout revient à pleine qualité.
:::

## 9.1 Deux cerveaux : le processeur et la carte graphique

Votre ordinateur possède deux types de « cerveaux ». Le **processeur** (CPU) est généraliste. La **carte graphique** (GPU) est spécialisée dans une seule chose : faire le même petit calcul sur des milliers de points à la fois.

![Un grand chef contre des milliers de commis : la carte graphique gagne dès qu'il faut répéter le même geste des millions de fois.](img/ch09/cpu-gpu.svg){width=95%}

::: analogy
Un grand chef étoilé prépare une assiette parfaite en deux minutes. Pour servir 2 millions de convives, il lui faudrait des années. Mille commis, chacun avec **la même recette simple**, servent la salle en un instant. Un écran de 1 920 × 1 080 pixels, c'est exactement cette salle.
:::

Dans Lumen3D, la « recette » s'appelle un **shader** : un petit programme écrit une fois, exécuté simultanément pour chaque pixel. Tout le calcul du volume se passe là.

## 9.2 WebGL2 et Three.js : qui fait quoi

**WebGL2** est le langage standard que les navigateurs comprennent pour parler à la carte graphique. Il sait notamment manipuler des **textures 3D** : des blocs de voxels stockés directement dans la mémoire vidéo. C'est indispensable pour un volume.

**Three.js** (version **0.147.0**) est une bibliothèque qui se place au-dessus de WebGL2 et s'occupe de la « plomberie ». Elle est **hébergée sur le serveur de la plateforme** (dossier `js/vendor/`), pas téléchargée depuis Internet.

![Les quatre couches entre votre souris et le pixel affiché.](img/ch09/pile-logicielle.svg){width=90%}

| Fournis par Three.js | Écrit sur mesure pour Lumen3D |
|---|---|
| Le moteur de dessin (le « renderer »), la scène | Les **shaders** du lancer de rayons (3 modes de rendu) |
| La caméra en perspective (angle de vue 45°) | L'**atlas** de briques et sa table des pages |
| Le **cube** (une boîte à 6 faces qui sert de point de départ aux rayons) | Le **streaming** des briques (chapitre 10) |
| Les matrices, quaternions, vecteurs | La qualité adaptative et le budget de mémoire |
| L'enveloppe des textures 3D | La lecture de profondeur sous la souris (mesures) |
| Le chargeur de modèles 3D (surface du suivi cellulaire) | Les canaux, histogrammes, filtre gaussien |

::: why
- **Mûr et léger** : Three.js est une bibliothèque très répandue, qui ne demande aucun outil d'assemblage (pas de « build ») : un fichier, un navigateur.
- **Hors ligne** : copiée sur le serveur, elle fonctionne sans Internet.
- **Auditable** : la partie qui détermine ce que vous voyez (les formules de rendu) est du code du laboratoire, commenté ligne à ligne. Un moteur de jeu complet n'était pas nécessaire : il aurait apporté des milliers de fonctions inutiles à la microscopie.
:::

::: note
Le viewer exige **WebGL2** (il n'existe pas de version dégradée en WebGL1). Si la carte graphique ne sait pas créer de textures 3D, le chargement est refusé avec un message clair, jamais par un plantage de l'onglet.
:::

## 9.3 Le lancer de rayons, pas à pas

Le volume est un énorme tableau de valeurs. Pour en faire une image, on procède **pixel par pixel**. Chaque pixel de l'écran lance un **rayon** depuis l'œil, qui traverse le cube. On lit le volume le long de ce rayon, puis on résume ce qu'on a rencontré en une seule couleur.

![Un rayon par pixel : entrée dans le cube, un échantillon par voxel, puis combinaison.](img/ch09/lancer-de-rayons.svg){width=100%}

::: steps
1. **Départ.** Le pixel désigne une direction : celle qui part de l'œil et passe par ce pixel.
2. **Entrée et sortie.** Le shader calcule où le rayon entre dans le cube et où il en sort (c'est « l'intersection rayon / boîte »). Hors du cube, le pixel reste transparent.
3. **Pas régulier.** On avance d'**un voxel** à chaque fois et on lit la valeur de chaque canal.
4. **Combinaison.** Les lectures sont résumées en une couleur, selon le mode de rendu (section 9.6).
:::

### Un échantillon par voxel

Au repos, le viewer prend **exactement un échantillon par longueur de voxel**, quelle que soit la direction du rayon. C'est ce qui garantit qu'**une structure d'un seul voxel ne passe jamais à travers les mailles du filet**.

::: example
Le jeu de démonstration E9.5 fait 768 × 576 × 112 voxels. Un rayon qui traverse tout le cube dans la longueur (axe X) fait donc **768 échantillons**. Un rayon en diagonale, plus long (√(768² + 576² + 112²) ≈ 966 voxels), en fait **environ 966**.
:::

::: tech
Le pas (en unités du cube) est `delta = 1 / (taux × nu)`, où `nu = ‖direction × (nombre de voxels du niveau)‖` mesure combien de voxels le rayon traverse par unité de longueur et `taux = 1,0` au repos. Le pas est donc uniforme en voxels, pas en micromètres. Si le rayon demandait plus de 4 096 pas, ils sont répartis plus largement (voir 9.9).
:::

## 9.4 Le grain aléatoire contre les bandes

Avec un pas fixe, tous les rayons voisins échantillonnent à la **même profondeur**. Résultat : des **anneaux** (« banding »), comme les courbes de niveau d'une carte. Ils n'existent pas dans l'échantillon : ils sont créés par le calcul.

La parade est simple : le **premier échantillon de chaque rayon est décalé** d'une fraction aléatoire du pas (un nombre pseudo-aléatoire calculé à partir de la position du pixel). Les anneaux se transforment en un **grain fin**, que l'œil moyenne et ignore.

![Simulation : sphère uniforme, un échantillon tous les 14 pixels. À gauche, les anneaux ; au milieu, le grain après décalage aléatoire.](img/ch09/jitter.png){width=100%}

Le même décalage est utilisé à l'export d'une image : il se poursuit d'une tuile à l'autre, sans couture.

## 9.5 Sauter le vide

Un embryon n'occupe qu'une partie de sa boîte. Les briques sans signal ne sont même pas stockées (chapitre 7). Quand un rayon arrive dans une brique **absente**, il n'y lit rien : il **saute directement** à la face de sortie de cette brique.

![Le rayon franchit trois briques vides sans lire un seul voxel.](img/ch09/saut-briques.svg){width=95%}

Le saut respecte le même quadrillage aléatoire que le reste du rayon : l'image ne change pas, elle est seulement calculée plus vite.

::: note
Une brique absente se lit comme des **zéros** : du noir qui ne coûte presque rien, pas un trou dans l'espace.
:::

## 9.6 Les trois modes de rendu

Le menu [Mode de rendu]{.ui} (panneau de gauche) propose trois façons de résumer les valeurs d'un rayon. Voici **le même point de vue** du jeu de démonstration E9.5 (DAPI, Pecam1, Sox2), rendu trois fois.

:::: cols3
::: col
![[Fluorescence (type Imaris)]{.ui}](img/ch09/mode-fluorescence.png){.shot}
:::
::: col
![[Fluorescence naturelle (profondeur)]{.ui}](img/ch09/mode-naturelle.png){.shot}
:::
::: col
![[Structure (DVR)]{.ui}](img/ch09/mode-structure.png){.shot}
:::
::::

::: note
Les captures du milieu et de droite sont éclairées avec un curseur [Visibilité (exposition)]{.ui} plus haut (voir la légende de la figure suivante) : ces deux modes produisent naturellement une image plus sombre à exposition égale.
:::

| Mode | Ce qu'il fait le long du rayon | Profondeur ? |
|---|---|---|
| **Fluorescence** (mode par défaut) | garde la valeur **la plus forte** de chaque canal | non, tout se superpose |
| **Fluorescence naturelle** | chaque point **brille** ; ce qui est devant **assombrit** ce qui est derrière | oui |
| **Structure (DVR)** | empile des couches **semi-transparentes** de l'avant vers l'arrière | oui |

### Mode 1 : Fluorescence (le maximum)

C'est le rendu « classique » des logiciels de microscopie. Pour **chaque canal séparément**, le viewer retient la **valeur maximale** rencontrée sur le rayon. Les couleurs des canaux sont ensuite **additionnées**.

::: example
Un rayon croise du vert à 0,85 puis du magenta à 0,75. Le pixel reçoit 0,85 de vert **et** 0,75 de magenta : le magenta n'est pas caché par le vert qui est devant. Vert + magenta additionnés donnent du blanc là où les deux sont forts.
:::

::: tech
`mip = max(mip, v)` pour chaque canal ; couleur finale = Σ `mip_i × couleur_i` × exposition. Le rayon s'arrête tôt quand **chaque** canal actif a atteint son plafond (opacité × 0,999). Un pixel dont le maximum est inférieur à 0,004 reste transparent.
:::

### Mode 2 : Fluorescence naturelle (émission et absorption)

Image mentale : chaque fluorophore est une **petite lampe** qui brille dans sa couleur, et la matière dense devant elle **filtre** la lumière. On obtient du relief et de la profondeur, tout en gardant des couleurs fidèles.

::: tech
Pour chaque échantillon de densité `d` = valeur du canal le plus fort (si `d > 0,0025`) :

- opacité du segment (loi de Beer-Lambert) : `a = 1 − exp(−absorption × delta × d)` avec `absorption = 1,8` ;
- lumière émise : `T × emissionGain × exposition × delta × Σ v_i × couleur_i` avec `emissionGain = 2,2`, où `T` est la **transmittance** (la part de lumière qui n'a pas encore été absorbée, de 1 à 0) ;
- puis `T ← T × (1 − a)` ; arrêt quand `T < 0,004`.

À la fin, la **luminance** (formule Rec. 709) est compressée par une courbe de Reinhard étendue (point blanc 2,0) et les trois composantes sont multipliées par **le même rapport** (« verrouillage de la chromaticité ») : un fluorophore très brillant reste vert, il ne vire jamais au blanc. Seul le recouvrement de 3 ou 4 canaux est éclairci (au plus 50 %). Une saturation de 1,18 est appliquée à luminance constante.
:::

::: warning
L'absorption n'est **pas une mesure** : c'est une constante d'affichage (1,8), indépendante de l'échantillon. Elle sert à donner du relief, pas à quantifier l'opacité réelle du tissu.
:::

### Mode 3 : Structure (DVR)

Le DVR (« Direct Volume Rendering ») empile des couches **semi-transparentes** comme des vitres teintées, en partant de la plus proche. Une fois la pile presque opaque (**97 %**), le rayon s'arrête : ce qui est derrière n'est plus visible.

::: tech
Pour chaque échantillon d'opacité locale `a = max des canaux` (si `a > 0,01`) :
`pas = 1 − (1 − 0,05 × a)^(delta / 0,01)` puis `couleur += (1 − alpha) × pas × couleur_locale` et `alpha += (1 − alpha) × pas`.

L'exposant fait qu'une colonne de matière opacifie **selon sa longueur**, pas selon le nombre d'échantillons : l'image ne change pas quand le viewer allège le pas pendant la rotation.
:::

### Un rayon, trois réponses

Imaginons un rayon qui rencontre d'abord un nuage vert, puis, un peu derrière, un nuage magenta qui le recouvre en partie.

![Le même rayon, résumé par les trois modes (calcul avec les formules du viewer ; curseur d'exposition 1 pour le mode 1, 4 pour le mode 2 et 3 pour le mode 3, comme sur les captures).](img/ch09/rayon-1d.png){width=100%}

- **Fluorescence** : on garde le plus fort de chaque canal, **sans tenir compte de l'ordre**.
- **Naturelle** : la lumière du nuage magenta est un peu **atténuée** par le nuage vert qui est devant (la transmittance descend à environ 0,67).
- **Structure** : le nuage vert **cache** partiellement le magenta ; l'opacité cumulée finit autour de 0,68.

## 9.7 Lisser entre les voxels

Entre deux voxels, le viewer ne montre pas des marches d'escalier : il **interpole**. Sur le **format 4** (celui de tous les jeux de démonstration), la carte graphique mélange les huit voxels voisins : c'est l'**interpolation trilinéaire**.

Pour que ce mélange ne déborde jamais d'une brique sur sa voisine, chaque brique est stockée avec **1 voxel de bordure** (66³ au lieu de 64³). Aux frontières entre briques, l'image est donc continue, sans couture.

::: remember
- **Format 4** et texture 3D complète : interpolation trilinéaire (lisse).
- **Ancien format 2**, quand l'atlas est découpé en briques : le voxel le plus proche est affiché tel quel (blocs visibles en zoom).
:::

## 9.8 Fluide quand vous bougez, net quand vous vous arrêtez

Faire tourner un volume à 60 images par seconde demande de calculer chaque image en moins de **16,7 ms**. Le viewer mesure le temps de chaque image pendant que vous glissez et **ajuste deux réglages** pour tenir ce budget.

![Pendant le glissement, la définition de l'image et le nombre d'échantillons sont réglés en continu ; dès que vous vous arrêtez, tout revient à la qualité maximale.](img/ch09/adaptatif.svg){width=100%}

| Réglage | Pendant le glissement | Au repos |
|---|---|---|
| Définition de l'image | de ×0,25 à ×1 (départ ×0,75) | 1 pixel d'écran (jusqu'à ×2) |
| Échantillons par voxel | de 0,1 à 0,75 (départ 0,35) | **1,0** |

- L'interaction est considérée comme terminée **250 ms** après le dernier mouvement.
- Si une image dépasse 1,3 × 16,7 ms, on baisse d'abord la définition, puis les échantillons ; si elle reste sous 1,1 ×, on remonte doucement.
- Le temps est mesuré par le **chronomètre de la carte graphique** quand le navigateur le propose, sinon par l'intervalle entre deux images.

::: note
Rien n'est dessiné en continu : le viewer ne calcule une image que si quelque chose change (caméra, réglage, arrivée de briques). Pendant le chargement, les redessins dus aux nouvelles briques sont groupés **toutes les 250 ms** au plus.
:::

## 9.9 Le garde-fou contre les plantages de la carte graphique

Sous Windows, si un seul calcul de la carte graphique dure plus de **2 secondes environ**, le système la réinitialise : c'est un « TDR » et l'écran clignote. Le viewer s'en protège.

::: tech
Pour une image **au repos**, le nombre maximal d'échantillons par rayon est `clamp(⌊6 × 10⁹ / nombre de pixels⌋, 256, 4096)`. Exemple : un écran de 1 920 × 1 080 donne ⌊6 × 10⁹ / 2 073 600⌋ = **2 893** échantillons au plus par rayon ; le même écran en pixels doublés (Retina, 8,3 millions de pixels) en donne 723.

Ce plafond est ajusté en cours d'usage : multiplié par `max(0,5 ; 150 / durée)` si une image au repos dépasse 200 ms, relevé de 10 % si elle reste sous 60 ms, et divisé par deux après une perte de contexte graphique (chapitre 10). Pendant un glissement, il vaut un dixième de cette valeur.
:::

Pour vous, cela signifie qu'un rayon exceptionnellement long peut, sur un très grand écran, être échantillonné un peu plus largement qu'un voxel. Dans l'usage normal (volumes de quelques centaines de voxels), le plafond n'est jamais atteint.

## 9.10 Les vraies proportions : calibration et étirement en Z

Le cube n'est pas dessiné d'après le **nombre de voxels** mais d'après les **dimensions réelles en micromètres**. Les voxels sont souvent plus épais en Z qu'en X et Y ; sans correction, l'embryon paraîtrait écrasé.

![Le fichier compte des voxels ; l'écran montre des micromètres. Jeu de démonstration E9.5 : voxels de 1,2 × 1,2 × 3,0 µm.](img/ch09/calibration.svg){width=95%}

::: example
Jeu E9.5 : 768 × 576 × 112 voxels de 1,2 × 1,2 × 3,0 µm.

- X : 768 × 1,2 = **921,6 µm** ; Y : 576 × 1,2 = **691,2 µm**.
- Z : (112 − 1) × 3,0 + épaisseur de coupe optique 3,0 = **336 µm**.
- Le plus grand côté (X) vaut 1 ; le cube mesure donc **1 × 0,75 × 0,365** (336 / 921,6).
:::

Le viewer classe la calibration en trois états : **exacte** (tailles de voxel et épaisseur de coupe connues), **estimée**, ou **absente**. Sans calibration, la **barre d'échelle** 3D est cachée plutôt que fausse.

Dans le panneau [Échelle Physique]{.ui}, le curseur [Surcharge Z]{.ui} (de ×0,25 à ×2,0) étire seulement l'**affichage** en Z pour mieux voir les couches fines ; le bouton [1:1]{.ui} le remet à zéro. Les mesures en µm ignorent cet étirement.

::: warning
La barre d'échelle 3D est exacte pour ce qui se trouve **à la profondeur du centre de l'échantillon**. La vue est en perspective : ce qui est plus près paraît plus grand, ce qui est plus loin paraît plus petit.
:::
