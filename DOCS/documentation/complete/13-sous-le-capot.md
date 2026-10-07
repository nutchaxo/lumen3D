# 13. Les outils sous le capot

::: chapter-intro
- Le chapitre 12 vous a appris **à vous servir** des outils. Celui-ci ouvre le capot : **comment ils fonctionnent**, avec les chiffres et les formules du code.
- Neuf sujets : le suivi cellulaire et la stabilisation, le Studio, Comparer, la page 2D et son importeur, la frise temporelle, l'état partagé (lien, mémoire du navigateur), les algorithmes de mesure, la galerie et les jeux liés, l'orientation.
- Rien ici n'est nécessaire pour utiliser la plateforme. Chaque section se lit seule ; les encadrés *Pour les curieux* peuvent être sautés.
:::

::: note
Toutes les captures et tous les chiffres viennent du **jeu de démonstration** (embryons et photographies synthétiques générés pour cette documentation). Quand un exemple utilise des valeurs inventées pour la clarté (un budget mémoire, deux tailles de pixel), le texte le dit.
:::

## 13.1 Le suivi cellulaire dans le viewer {.page}

::: tldr
- Les cellules suivies sont dessinées comme des **sphères** (une par cellule) lues dans des **tableaux de nombres** préparés par un *worker*.
- La **stabilisation** des images n'abîme jamais un voxel : le shader change seulement **l'endroit où il lit** la texture, grâce à une matrice 4 × 4 par image.
- Cinq outils partagent **une seule copie** des données, par une façade nommée `ctx.tracking`.
:::

Le chapitre 8 (§ 8.4) a expliqué comment le pipeline calcule le suivi et la rotation de Kabsch. Le chapitre 12 (§ 12.9) a montré les boutons. Voici **le milieu** : ce que le viewer fait de ces fichiers, image après image.

### Du fichier aux sphères

![Le chemin des données de suivi, du fichier jusqu'à l'écran.](img/ch13/suivi-chemin.svg){width=96%}

Le fichier `tracks.json` n'est pas lu par la page : un **worker** (un petit programme qui tourne en parallèle de la page, § 10.5) le télécharge. Il essaie d'abord la copie compressée `tracks.json.gz`, qu'il décompresse avec le navigateur. Si elle manque, ou si le serveur l'a déjà décompressée, il retombe sans bruit sur le fichier brut.

Le worker ne dessine rien. Il range tout dans des **tableaux typés** (des suites de nombres de taille fixe) qu'il *transfère* à la page sans les copier. Le viewer garde ces tableaux **une seule fois** : le dessin, les cinq outils et les exports lisent les mêmes.

::: analogy
**Un annuaire et un plan de métro.** Le fichier JSON est un annuaire : pratique à lire, lent à feuilleter. Les tableaux sont le plan de métro : tout est à une adresse fixe. « Où est la cellule 15 à l'image 3 ? » devient **une lecture dans un tableau**, pas une recherche.
:::

### Les tableaux : deux familles

::: cols
::: col
**Par image** (pour dessiner, 30 fois par seconde)

| Tableau | Contenu |
|---|---|
| `posStab` | positions stabilisées, image par image |
| `posRaw` | les mêmes, brutes |
| `cellIdx` | numéro de la cellule de chaque emplacement |
| `counts` | nombre de cellules par image |
:::
::: col
**Par cellule** (pour analyser)

| Tableau | Contenu |
|---|---|
| `parent`, `daughterStart/Idx` | lignée (mère ; liste des filles) |
| `flags`, `regionIdx` | mitose / fusion ; région |
| `firstFrame`, `lastFrame` | durée de vie |
| `cellFrameSlot` | emplacement de la cellule **à chaque image** (−1 = absente) |
:::
:::

Le dernier tableau est le plus utile : `cellFrameSlot[cellule × images + image]` répond à « où est cette cellule à cette image ? » en **une seule lecture**. C'est lui qui rend la sélection, les trajectoires et les distances instantanées.

::: example
Sur le jeu de démonstration (50 cellules, 4 images), le worker produit 8 048 octets de tableaux, à partir d'un fichier de 32 675 octets (10 991 compressé). Les images n'ont pas toutes le même nombre de cellules : **48, 48, 49, 49**. Les emplacements libres ne sont jamais dessinés, ils ne restent pas figés à leur dernière position.
:::

::: tech
- **32 bits partout** : compteurs et indices sont des `Uint32Array` / `Int32Array`. Un tableau de 16 bits déborderait silencieusement au-delà de 65 535 cellules ; ici rien ne déborde.
- Les cellules sont repérées dans le fichier par le texte de leur image (« 1 », « 2 »…, Imaris compte à partir de 1) alors que les briques comptent à partir de 0. Plutôt que d'ajouter 1 à la main, le worker **construit la correspondance** à partir de la liste triée `timepoints` du fichier.
- Une position incomplète ou non finie est **ignorée et comptée** (`malformed`) : une ligne défectueuse ne cache jamais toute la couche.
- La table `cellFrameSlot` est la seule à croître avec le produit cellules × images. Elle est refusée au-delà de 2²⁸ entrées (1 Gio) avec un message qui dit pourquoi, au lieu d'une erreur opaque de mémoire.
- Une lignée peut désigner une cellule par sa clé, son `id` ou son `track_id` (l'exportateur a utilisé les trois) ; le worker essaie dans cet ordre, puis **rend le lien symétrique** (mère ↔ filles).
:::

### Pourquoi des sphères et pas des « points »

![Points GPU contre sphères instanciées.](img/ch13/suivi-spheres.svg){width=94%}

Une sphère coûte un peu plus qu'un point, mais le diamètre se règle **en micromètres** (2 à 40, 12 par défaut) et reste juste à tout zoom. La couche est un *maillage instancié* : une seule sphère de référence, dessinée autant de fois qu'il y a de cellules, avec une matrice par instance.

::: tech
- Les sphères sont **enfants du cube** du volume : l'orbite, le déplacement, les proportions physiques et l'étirement Z de l'opérateur s'appliquent sans code supplémentaire.
- Le diamètre monde est `diamètre_µm × (échelle_x du cube / taille_x de l'acquisition en µm)`. L'échelle de la sphère est ensuite **divisée par l'échelle propre de chaque axe** du cube : sans cette division, l'étirement Z en ferait un ellipsoïde.
- `depthTest = false` : le volume est un lancer de rayons additif **sans profondeur** ; un test de profondeur cacherait chaque centroïde derrière la face avant du cube.
- Le test « cette sphère est-elle dans la boîte rognée ? » est **le même** que celui du shader : la couche suit la tranche du Z-stack et les curseurs de rognage au lieu de flotter au-dessus d'un volume presque caché.
- Une cellule sélectionnée est dessinée 1,8 fois plus grosse. La couleur d'une cellule vient de sa région (une couleur par **cellule**, pas par cellule et par image : trente fois moins d'octets).
:::

### Deux repères, un interrupteur de dictionnaire

Le fichier porte **deux jeux de coordonnées** pour chaque cellule : stabilisées (`posStab`) et brutes (`posRaw`). La couche n'applique jamais la matrice de stabilisation à des points : elle **choisit le bon tableau**.

::: warning
Appliquer la matrice à des points déjà stabilisés les enverrait dans un troisième repère. À l'image 1 la transformation est l'identité : on ne verrait rien. À l'image 30 d'une vraie série, l'erreur atteindrait environ 250 µm, et ressemblerait à un défaut général d'alignement. D'où la règle : **un dictionnaire, pas une multiplication**.
:::

- Volume stabilisé à l'écran : la couche lit `posStab`.
- Volume brut : elle lit `posRaw`.
- Si le fichier n'a **pas** de coordonnées brutes pour toutes les cellules et que l'image affichée est brute, la couche se **masque** (« Coordonnées brutes manquantes : suivi masqué sur un volume non stabilisé »). Une couche plausible mais fausse serait pire qu'aucune couche. Votre propre réglage de visibilité n'est pas touché.

### Cliquer une sphère

`pick()` lance un rayon à travers le point cliqué et le teste contre le maillage **tel qu'il a été dessiné** : une cellule filtrée (mitoses, fusions) ou rognée n'est jamais touchée, et une couche masquée n'est pas cliquable. Le résultat est le numéro de la cellule, ou −1.

### La façade `ctx.tracking`

Les cinq outils (trajectoires, surface, inspecteur, graphiques, distance entre cellules) ne touchent jamais le maillage ni les tableaux directement. Ils passent par une **façade** que la page construit.

| Elle donne… | Exemples |
|---|---|
| des données | `getData()`, `positionUm(cellule, image)`, `cellsAt(image)`, `whenLoaded()` |
| un état partagé | **une** sélection, **un** rayon de voisinage (5 à 500 µm, 55 par défaut) |
| des services | `pick(x, y)`, `umToObject()`, `isInsideClip()`, `getCamera()` |
| des événements | `loaded`, `frame`, `refresh`, `selection`, `options`, `style` |

::: why
**Une sélection, pas cinq.** Si l'inspecteur, les trajectoires et les graphiques avaient chacun la leur, cliquer une cellule éclairerait trois choses différentes. Avec la façade, une cellule choisie s'éclaire partout, et le rayon de voisinage règle d'un coup l'inspecteur, les graphiques et la densité de la surface.
:::

L'événement `frame` est émis **après** que la couche s'est déplacée : un outil qui dessine par-dessus les points ne devance jamais leur image d'une image.

## 13.2 La stabilisation : on déplace le regard {.page}

::: tldr
- Un embryon dérive et tourne pendant des heures. La stabilisation **annule ce mouvement à l'écran**.
- Le viewer ne fabrique aucune nouvelle image : le shader lit chaque voxel **à une autre adresse** de la texture.
- Elle ne s'applique que si le pipeline a vérifié que le mouvement est **rigide**.
:::

### Le principe en trois images

![Rangée du haut : ce qu'a enregistré le microscope. Rangée du bas : ce que montre le viewer.](img/ch13/stabilisation-3-images.svg){width=90%}

Le microscope regarde toujours par la même fenêtre. Si l'embryon dérive, **c'est lui** qui bouge dans la fenêtre. Le viewer inverse le point de vue : l'embryon reste en place à l'écran, et c'est **la fenêtre** (le carré bleu) qui tourne et glisse autour de lui, comme une caméra qui suivrait la bête.

::: analogy
**Un caméraman, pas un décorateur.** Pour garder un danseur au centre de l'image, on peut redessiner le décor autour de lui à chaque plan (rééchantillonner), ou simplement **tourner la caméra**. Lumen3D tourne la caméra : le décor, c'est-à-dire les voxels mesurés, n'est jamais retouché.
:::

![Deux façons de stabiliser, et celle que retient Lumen3D.](img/ch13/warp-methode.svg){width=92%}

### Les repères, avec les vrais chiffres

![Quatre fenêtres d'acquisition (une par image) dans le repère de l'embryon, et la boîte qui les contient toutes.](img/ch13/suivi-reperes.png){width=96%}

Trois repères sont en jeu :

- le **repère brut** : celui du microscope, la fenêtre de 192 × 192 × 96 µm est fixe ;
- le **repère stabilisé** : celui de l'embryon, immobile ; chaque image y a sa fenêtre, tournée de 0 ; 2,3 ; 4,7 ; 7,0° ;
- la **boîte d'affichage** : le plus petit pavé qui contient **toutes** les fenêtres, ici de (−16,3 ; −7,1 ; −2,4) à (197,9 ; 207,3 ; 96) µm.

La boîte d'affichage est ce que le cube géométrique doit couvrir : sans elle, la fenêtre de l'image 4 sortirait du cube. Le cube grandit donc, **sans toucher** à son échelle (la grille, la barre d'échelle, le plan de coupe et le cadrage de la caméra continuent de s'y fier).

### Le shader : une chaîne de trois changements de repère

![Le point lu passe par trois repères, avec l'exemple de l'image 4.](img/ch13/warp-chaine.svg){width=96%}

Pour chaque point où le rayon prend un échantillon, le shader fait :

`volumeWarp = toTex · M⁻¹ · toUm`

1. `toUm` convertit la coordonnée de l'objet (de −½ à +½) en **micromètres stabilisés**.
2. `M⁻¹` revient aux **micromètres bruts** : c'est l'inverse de la matrice que le suivi a appliquée à l'image.
3. `toTex` convertit en **adresse de texture** (de 0 à 1).

::: example
**Image 4 du jeu de démonstration.** Le centre exact de l'écran (objet 0 ; 0 ; 0) vaut (96 ; 96 ; 48) µm stabilisés. Après `M⁻¹` (rotation 7,03°, décalage −16,14 ; 16,39 ; −1,79 µm) il devient (101,65 ; 92,57 ; 49,89) µm bruts, donc l'adresse (0,529 ; 0,482 ; 0,520) dans la texture. On lit un voxel un peu à côté du centre : **c'est tout le « travail »** de la stabilisation.
:::

La matrice est calculée **une fois par changement d'image** et passée au shader comme une constante. Au tout premier passage, le shader est recompilé avec l'option `VOLUME_WARP` ; ensuite, chaque image ne change qu'un nombre.

::: tech
- **Entrée et sortie du rayon.** L'intersection rayon / boîte est calculée dans l'espace de la **texture source** (où la boîte d'acquisition est exactement le cube unité), par `hitBoxWarped`. Ainsi la densité d'échantillonnage ne dépend pas de la distance dont l'embryon a dérivé : l'image n'est pas plus claire ni plus grenue à l'image 30 qu'à l'image 1.
- **Rognage et coupe.** Les curseurs de rognage, la tranche du Z-stack et le plan de coupe agissent dans la **boîte d'affichage** : vous coupez ce que vous voyez, pas le repère de l'acquisition.
- **Garde-fous.** Une matrice non finie, ou de déterminant presque nul (|det| ≤ 10⁻⁹), est **ignorée** : l'image est affichée sans déformation et un avertissement apparaît en console. Une rotation rigide a un déterminant de ±1 : tout ce qui s'en écarte est suspect.
- **Orbite intacte.** Le warp ne touche ni la position ni la rotation du cube : ce sont les contrôles de la souris, ils sont enregistrés dans les espaces de travail. Mélanger une matrice par image à eux casserait les deux.
- **La coupe oblique et le Studio** échantillonnent par le même warp (`samplingSpace`, `planeSweep`) : une coupe d'une série stabilisée montre exactement la tranche de l'écran.
:::

### Quand est-elle appliquée ?

| Condition | Si elle manque |
|---|---|
| `registration.appliedToVolume` est vrai (le test de rigidité a réussi : résidu ≤ 0,05 µm) | l'image reste **brute**, seul le suivi est stabilisé |
| `acquisitionExtentUm` est présent | idem, avec un avertissement |
| la matrice de l'image est valide | cette image est affichée non déformée |

Le test de rigidité du pipeline (chapitre 8) est donc **le seul feu vert**. Sur le jeu de démonstration le résidu vaut 7,6 × 10⁻¹⁴ µm : la stabilisation est appliquée.

::: note
Il n'y a **pas de bouton** « stabilisé / brut » dans l'interface : la stabilisation est active dès qu'elle est applicable. L'interrupteur existe dans l'API de la page (`ViewerApp.setVolumeStabilized`) ; la couche de points et les outils suivent le changement à l'image suivante, car ils lisent le repère affiché dans l'événement d'image prête, jamais en le redemandant.
:::

::: warning
**Sur le jeu de démonstration, l'image n'a pas réellement dérivé** : seules les coordonnées brutes du suivi ont été générées avec une dérive (jusqu'à 23 µm, 7°). Appliquer la stabilisation décale donc légèrement le volume. C'est pourquoi les figures de cette section sont des **schémas calculés avec les vraies matrices**, et non des captures « avant / après » qui laisseraient croire à un gain visible.
:::

### La surface, la provenance, les mesures

- **La surface** `model.glb` contient un maillage **par image**, dans le repère brut et dans le repère stabilisé. Elle est enfant du cube comme les sphères : le même `o = (p − A)/S − ½` la place, donc orbite, étirement Z et stabilisation s'appliquent. Le lecteur de GLB est celui de Three.js, **chargé à la première utilisation** avec son empreinte d'intégrité (SRI) : la page du viewer ne le porte pas.
- **Trois colorations** : uniforme, densité locale, région. La densité d'un sommet est la somme de gaussiennes `exp(−|v − c|² / 2σ²)` sur les cellules de l'image, limitée à 2,8 σ et rangée dans une grille uniforme (un sommet ne visite que son voisinage), puis lissée deux fois sur le maillage. Le résultat est mémorisé tant que ni l'image, ni le rayon de voisinage, ni la palette ne changent.
- **La coupe de la surface** utilise des plans de découpe de Three.js, qui sont en **repère monde** alors que le cube tourne : les plans sont donc ré-exprimés juste avant chaque dessin. Un chapeau plein ferme la coupe.
- **La provenance.** `tracking.surfaceOrigin` dit si la surface a été **exportée** par l'analyse ou **reconstruite** à partir des cellules (c'est le cas du jeu de démonstration).
- **L'alignement.** À l'import, le pipeline vérifie que le suivi se trouve bien dans le volume : au moins 50 % des positions brutes dans la boîte d'acquisition élargie de 10 %, et un étalement d'au moins 1 % du plus grand côté. Sinon il propose l'unité probable (mm, nm, m), sans rien convertir. Le jeu de démonstration : 100 % dedans, étalement 0,83, `aligned: true`.
- **Les unités.** Les positions sont ramenées en µm à l'import ; `tracking.provenance.unit` garde l'unité déclarée, le facteur et son statut (*native*, *converted*, *assumed*, *unknown*).
- **Les mesures** de distance entre cellules sont rangées sous la portée `tracking` du magasin de mesures, et leur export note le repère (*stabilized* ou *raw*).

::: remember
- Les cellules sont des **sphères instanciées** lues dans **des tableaux 32 bits**, en un seul exemplaire.
- La stabilisation est **un changement d'adresse de lecture** : `volumeWarp = toTex · M⁻¹ · toUm`.
- Rien n'est rééchantillonné : c'est réversible et exact.
- Le seul feu vert est le **test de rigidité** du pipeline.
:::

