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

## 13.3 Le Studio en profondeur {.page}

::: tldr
- Une figure du Studio est un **document** : des calques, des repères, des réglages de canaux, un plan, une calibration. Jamais de pixels dans le fichier JSON.
- Les canaux se **recolorent sans nouveau rendu**, avec la même arithmétique que le shader de coupe.
- La résolution **native** arrive après l'ouverture, par un chemin « plan » ou « atlas », sous la protection d'un **jeton** de document.
:::

Le chapitre 12 (§ 12.7) a montré comment annoter. Voici ce qui se passe quand vous cliquez.

### Le document

![L'anatomie d'un document du Studio, et ce que le fichier JSON ne contient jamais.](img/ch13/studio-document.svg){width=96%}

Le document tient en un objet. Le Studio le **copie entièrement** à chaque étape de l'historique, avec deux conséquences : l'annulation est instantanée et sans surprise, et le document ne doit pas contenir de gros objets. Dans une figure de Comparer, chaque cellule porte trois champs d'exécution (les valeurs brutes, le cadre de page, la coupe) : `_portableDocument()` les retire de chaque export, et la copie d'historique les garde **par référence**, pas par duplication.

- **L'historique** garde 80 étapes. Une modification de canal est une étape comme une autre : annuler défait la **dernière** modification, quelle qu'elle soit, et défaire une annotation ne remet jamais les canaux d'avant.
- Une rafale de modifications d'un même panneau (un curseur qu'on tire, un message par image) forme **une seule étape**, close par le relâchement, par une pause d'une seconde, ou par une autre action.
- **Types de calques** : rectangle, ellipse, texte, ligne, flèche, distance, angle, barre d'échelle. Chaque calque a un identifiant unique, un nom, deux drapeaux (visible, verrouillé), un groupe éventuel, une **rotation** en degrés (de −180 exclus à 180) et un style.
- Les coordonnées sont en **pixels de l'image**. Quand la passe native remplace l'aperçu par une image plus grande, chaque coordonnée est multipliée par le rapport des tailles : un calque reste sur la structure qu'il marque (les épaisseurs et corps de police, eux, restent en pixels d'écran).

### Le jeton de document

![Pourquoi une passe native tardive ne peut pas abîmer la figure suivante.](img/ch13/studio-jeton.svg){width=94%}

L'ouverture d'une figure renvoie un **jeton** (un numéro qui augmente à chaque document). La passe native, qui peut durer plusieurs minutes sur un gros volume, le présente à chacune de ses mises à jour. Si vous avez fermé la figure et en avez ouvert une autre, le jeton ne correspond plus : l'image tardive est **ignorée**, sa barre de progression aussi.

Fermer le Studio libère l'image native, l'historique et les cadres de Comparer, et annule le transfert en cours.

### Tourner un calque sans fausser une mesure

Un rectangle, une ellipse ou un texte **tournent à l'affichage** autour de leur centre : seule la rotation est enregistrée. Une ligne, une flèche, une distance, un angle ou une barre d'échelle sont faits de **points** : la rotation est *cuite* dans les points, parce que leur étiquette se calcule à partir d'eux.

![Une règle de 100 µm tournée sur des pixels de 1 × 2 µm : sa longueur en pixels est recalculée.](img/ch13/studio-regle.svg){width=94%}

- **Ligne, flèche** : rotation rigide des points autour de leur centre.
- **Angle** : tourné dans l'espace des **micromètres** (`p' = c + S⁻¹·R(θ)·S·(p − c)`, avec `S` la taille de pixel). Une rotation rigide en pixels changerait l'angle mesuré : sur des pixels de 1 × 2 µm, un angle droit tourné de 45° se lirait 53,1°.
- **Distance** : la direction tourne, la longueur en pixels est **recalculée** pour garder la même longueur en µm.
- **Barre d'échelle** : sa direction *est* sa rotation ; la longueur en pixels est celle qui mesure exactement sa valeur.

::: example
Distance de 100 µm sur des pixels de 1 × 2 µm. Horizontale : 100 px. À 45° : 100 / √(0,707² × 1² + 0,707² × 2²) = **63,25 px**. Verticale : **50 px**. La valeur affichée reste 100 µm.
:::

### Quelle taille de pixel pour un calque ?

Une coupe simple n'a qu'une calibration. Une **figure de Comparer** en a une **par cellule** (un panneau = une cellule avec son rectangle et son µm/pixel). Un calque de points prend la calibration **de la cellule qui contient le milieu de ses points** (la plus proche, si le milieu tombe dans une gouttière). C'est aussi le centre de ses rotations : tourner un calque ne le confie donc jamais à la cellule voisine.

La barre d'échelle est plus subtile : son milieu dépend de la longueur qu'elle prend, qui dépend de la cellule. Le Studio cherche donc une cellule **cohérente** (dont la longueur propre place le milieu dans cette même cellule) ; à défaut, c'est la cellule du point de départ qui décide, car elle ne bouge pas quand l'autre bout est réécrit.

### Recolorer sans refaire le rendu

![Le chemin des valeurs brutes aux couleurs.](img/ch13/studio-recolor.svg){width=96%}

Quand le Studio ouvre une coupe, il reçoit deux choses : une image colorée, et les **valeurs brutes** des canaux (`raw` : quatre octets par pixel, un par canal 0 à 3). Le volume qui les a produites est un atlas jetable, disparu après la passe. La recoloration repart donc des valeurs brutes.

:::: cols
::: col
![Coupe XY du jeu de démonstration, couleurs du viewer.](img/ch13/studio-recolor-a.png){.shot width=100%}
:::
::: col
![Même coupe : DAPI éteint, Sox2 en orange. Les calques n'ont pas bougé.](img/ch13/studio-recolor-b.png){.shot width=100%}
:::
::::

Le **compositeur** (`SliceCompositor`) applique à chaque canal allumé la formule du shader de coupe : fenêtre `(brut/255 − min) / max(max − min ; 10⁻⁴)`, puis gamma, puis `opacité × couleur`, et somme. Il tourne sur **son propre canevas WebGL2** (la page Comparer ne charge pas Three.js), avec une table de 256 valeurs par canal en repli.

::: tech
- La couleur de sortie est `clamp(Σ vᵢ·opacitéᵢ·couleurᵢ ; 0 ; 1) × 255`, **transparente** sous |rgb| < 0,005 pour une coupe simple (le shader de coupe écarte ces fragments), **opaque** (noire si rien ne s'affiche) pour une tranche projetée en MIP ou en moyenne.
- Une tranche de **quatre canaux** n'a pas d'octet libre pour dire où le volume existe : elle porte à part un **masque de couverture** d'un octet par pixel, lu sur l'alpha du rendu en couleur du même plan.
- Les textures des valeurs brutes sont gardées dans un budget de **256 Mio** (celles des masques dans un budget séparé de 64 Mio, pour qu'ils ne s'évincent pas). Un raw de même taille est **réécrit sur place** à chaque raffinement de la passe native (numéro `raw.version`).
- Le repli sur table calcule en double précision ; la carte graphique, en flottants 32 bits, peut différer d'**une unité** sur un octet à une frontière d'arrondi.
:::

**Les histogrammes du Studio n'ont pas la même origine que ceux du viewer** (§ 11.5). Ils sont calculés **sur la coupe affichée** (jusqu'à 4 millions d'échantillons, un seul calcul par raw), pas sur tout le volume. C'est cohérent : vous réglez le contraste de ce que vous voyez dans la figure.

### La passe native

Un volume de plusieurs gigaoctets n'a pas de coupe « à portée de main » en pleine résolution. Le Studio fait donc deux temps.

![De l'aperçu à la résolution native.](img/ch13/studio-natif.svg){width=94%}

1. **L'aperçu** : la coupe que la carte graphique tient déjà, rendue en 2048 px au plus, sans aucun octet de réseau. Le Studio s'ouvre à l'instant.
2. **La passe native** : le viewer calcule quelles briques le plan traverse, les récupère à la résolution maximale (niveau 0), et re-rend la coupe en valeurs brutes **à intervalles réguliers**.

L'image de la passe est cadrée comme l'aperçu (même région du plan). Là où une brique manque encore, l'**aperçu comble le trou** : ce que vous voyez est toujours une image complète, de plus en plus nette. La taille de rendu est environ **un pixel par voxel de l'axe le plus long**, étendue au cadre de la coupe (× 1,5) : de 512 à 16 384 px.

::: example
Jeu de démonstration, 768 voxels sur X : 768 × 1,5 = **1 152 px** de rendu. Chaque pixel couvre 1,5 × 921,6 µm (la plus grande extension physique) / 1 152 = **1,2 µm**, c'est-à-dire exactement la taille du voxel : le natif de ce jeu est aussi petit que l'aperçu.
:::

### Deux chemins pour le même plan

![Pourquoi un plan axial n'a pas besoin d'atlas.](img/ch13/studio-plan-atlas.svg){width=94%}

- **Chemin « plan »** : pour un plan aligné sur un axe (XY, XZ, YZ) d'un volume non déformé. Le shader lit, pour chaque pixel, le voxel `floor(uvw × dim)` ; le long de la normale, la coordonnée ne dépend pas du pixel, donc les plans de voxels lus sont **connus d'avance**. Une texture 2D à couches ne contient que ceux-là. Pour une tranche MIP, chaque boîte de briques est réduite à son maximum par canal dans un *worker* (`studio-plane-worker.js`) puis les maxima des briques d'une colonne sont fusionnés.
- **Chemin « atlas »** : coupe oblique, série stabilisée, tranche en moyenne. Un atlas 3D jetable, dimensionné **avant** d'être alloué contre le budget de mémoire vidéo (chapitre 10) ; s'il ne rentre pas (`SVR_OVER_BUDGET`), le niveau juste en dessous est essayé et l'étiquette de progression le dit.

D'où viennent les octets d'un plan XY ?

| Source | Quand | Ce qu'elle épargne |
|---|---|---|
| `planes/` (format 2 et plus) | coupe XY, niveau 0 | les 63 autres plans de chaque brique |
| `mips/` (format 3 et plus) | tranche MIP sur toute la pile | un maximum par couche de 64 plans au lieu de 64 plans |
| briques par plages d'octets | tout le reste | les briques non traversées et les paquets entiers |

Les formats sont détaillés au chapitre 7 (§ 7.8 et 7.9) ; ici, le Studio ne fait que **choisir le plus économe** qui existe, et retombe sur les briques si le dossier ou un fichier manque.

::: tech
- **Brique vide ≠ brique manquante.** Une brique que le pipeline n'a pas stockée (tous ses voxels valent 0) est du **zéro**, jamais « en attente » : le chemin atlas pointe son entrée sur un seul emplacement de zéros ; le chemin plan marque ses texels présents d'emblée. Sinon l'aperçu remplacerait pour toujours chaque colonne qui traverse une brique vide.
- **Raffinement progressif** : au plus toutes les 0,5 s, dès que 2 % des briques de la passe sont arrivées (ou après 2 s quoi qu'il arrive). Un rendu n'est pas relancé plus souvent qu'un petit multiple du coût du précédent.
- **Échec** : un morceau qui échoue deux fois garde les pixels de l'aperçu et est compté (`missingChunks`). L'image finale est alors étiquetée « native partielle » et le Studio le dit.
- **Canaux éteints dans le viewer** : quand le transport est par canal, ils ne sont pas téléchargés ; allumés ensuite dans le Studio, ils s'affichent à la résolution de l'aperçu plutôt qu'en noir.
- **Indépendance** : le lot de briques de la passe a son propre groupe et son propre signal d'annulation : un chargement lancé par le viewer ne l'annule pas, fermer le Studio l'annule.
:::

::: warning
**Plus de 256 Mio.** Une figure de Z-stack épaisse peut réclamer chaque brique de toutes ses coupes. Au-delà de 256 Mio estimés, une boîte propose trois choix : charger le natif (avec le nombre de Mo), charger le niveau inférieur (plus léger), ou garder l'aperçu. L'estimation passe par `planes/` et `mips/` quand ils existent : elle peut être très inférieure à celle des briques, et la boîte ne propose jamais « plus léger » pour plus d'octets.
:::

### La figure d'un Z-stack

![Le plan d'une figure de Z-stack naît du repère de l'écran.](img/ch13/studio-zstack.svg){width=96%}

Quand vous ouvrez le Studio depuis l'explorateur Z-stack, le plan n'est pas celui de la coupe oblique : il est construit pour que la figure **soit** l'écran. Le viewer demande où pointent la droite et le haut de l'écran dans le volume (`getScreenFrameInVolume`), choisit la face **+Z** ou **−Z** (donc un lacet de 0 ou 180°) la plus proche, puis le **roulis** qui cale l'image sur l'écran. Les `n` coupes du curseur deviennent une tranche de `n` échantillons, un par coupe ; au-delà d'une coupe, c'est un MIP.

### Exporter, importer, et les limites

| | Règle |
|---|---|
| PNG | taille de la figure, fond noir, **légende toujours incrustée** (jeu · plan · taille · pixel). Refusé au-delà de 16 384 px de côté ou 2²⁸ pixels |
| JSON | calques, repères, canaux, plan, calibration, cellules de Comparer. Jamais de pixel |
| Lecture d'un JSON | refus au-delà de 5 Mo, 2 000 calques, 10 000 points ; texte limité à 2 000 caractères |
| Historique | 80 étapes |
| Canaux | 4 au plus (la texture est RGBA) |

**Importer un JSON** ne remplace pas la figure ouverte : il l'**applique**. Le fichier est vérifié en entier avant tout changement (types de calques connus, géométrie numérique, couleurs, identifiants uniques).

- La figure ouverte garde son image, son cadre, sa calibration et ses cellules ; elle prend les **calques, repères et groupes** du fichier, avec les mesures relues contre la calibration de la figure ouverte (une barre d'échelle garde sa valeur, une distance ses points).
- C'est **la même figure** si le fichier a la même taille, nomme le même jeu (identifiant ou chemin), montre le même plan (à une tolérance près) et la même image de la série, et, pour Comparer, les mêmes cellules.
- Dans ce cas les **réglages de canaux** du fichier s'appliquent aussi, et seulement si la coupe peut être recolorée sans changer de cadre. Sinon (autre figure), seuls les **calques** passent, et un message l'indique.

::: remember
- Un document = calques + repères + canaux + plan + calibration, **sans pixels**.
- La recoloration part des **valeurs brutes** : aucun nouveau rendu du volume.
- La passe native choisit **plan** ou **atlas**, lit `planes/` et `mips/` quand ils existent, et se protège par un **jeton**.
- Une rotation de calque **recalcule** les longueurs en pixels : la mesure ne bouge pas.
:::

