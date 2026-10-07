# 13. Les outils sous le capot

::: chapter-intro
- Le chapitre 12 vous a appris **à vous servir** des outils. Celui-ci ouvre le capot : **comment ils fonctionnent**, avec les chiffres et les formules du code.
- Neuf sujets : le suivi cellulaire et la stabilisation, le Studio, Comparer, la page 2D et son importeur, la frise temporelle, l'état partagé (lien, mémoire du navigateur), les algorithmes de mesure, la galerie et les jeux liés, l'orientation.
- Rien ici n'est nécessaire pour utiliser la plateforme. Chaque section se lit seule ; les encadrés *Pour les curieux* peuvent être sautés.
:::

::: note
Toutes les captures et tous les chiffres viennent du **jeu de démonstration** (embryons et photographies synthétiques générés pour cette documentation). Quand un exemple utilise des valeurs inventées pour la clarté (un budget mémoire, deux tailles de pixel), le texte le dit.
:::

## 13.1 Le suivi cellulaire dans le viewer

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

## 13.2 La stabilisation : on déplace le regard

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

## 13.3 Le Studio en profondeur

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

## 13.4 Comparer sous le capot

::: tldr
- Comparer est un **hôte** qui pilote jusqu'à quatre **vraies pages** (`viewer.html`, `2d.html`) enfermées dans des cadres, par des messages.
- Chaque page **décrit** ce qu'elle sait faire ; l'hôte en dessine les boutons. Il ne fouille jamais dans leur document.
- Un **budget mémoire commun** de 1,5 Gio est réparti entre les panneaux par un petit algorithme, et le temps est aligné par **fraction**.
:::

Le chapitre 12 (§ 12.8) a décrit la page. Voici le protocole qui la fait tenir.

### L'architecture

![Un hôte, quatre cadres, et un seul canal : les messages.](img/ch13/compare-architecture.svg){width=96%}

Chaque panneau est une **page complète** ouverte sans son en-tête (`hideHeader=true`) avec un numéro (`panelIndex`). Comme elle est chrome-less, sa barre d'outils est invisible : la page **décrit** donc sa barre à l'hôte, qui dessine les boutons dans l'en-tête du panneau.

::: why
**Pourquoi des pages entières et pas un moteur partagé ?** Parce que chaque outil, chaque raccourci, chaque réglage existe déjà dans la page. Comparer n'a **rien à réimplémenter** : un nouvel outil devient disponible dans les panneaux dès qu'il déclare qu'il sait être piloté de l'extérieur (`contexts: ["page", "panel"]`, chapitre 15).
:::

### Une poignée de main en cinq temps

![Ce qui se dit quand on ajoute un panneau.](img/ch13/compare-sequence.svg){width=92%}

1. L'hôte donne au cadre son adresse (avec `quality=512x512` pour un volume : on démarre toujours petit).
2. Dès que la page est montée, elle envoie **`PANEL_READY`** : nom, type, **barre décrite** (outils et boutons à bascule, avec leur état), fonctions (volume, photographie, frise, nombre de canaux, suivi), qualité, et **le coût de chaque qualité** en octets de mémoire graphique.
3. L'hôte répond par l'état commun : l'outil du moment, puis le rattrapage des synchronisations (voir plus bas).
4. Il règle la qualité, **un panneau à la fois**.
5. Plus tard, il envoie des **demandes** (capture, coupe pour le Studio, état…) auxquelles la page répond.

Une page qui n'envoie pas `PANEL_READY` en **180 s** est déclarée en échec ; le panneau affiche un bouton [Réessayer]{.ui} qui recharge le cadre à neuf. Une erreur après la mise en place n'ôte jamais l'état « prêt » : le volume déjà affiché est intact. Au plus **deux** panneaux chargent à la fois, les suivants font la queue.

### Le catalogue des messages

| Sens | Messages |
|---|---|
| **panneau → hôte** | `PANEL_READY`, `PANEL_ERROR`, `PANEL_DATASET`, `PLUGIN_STATE`, `TOOL_CHANGED`, `QUALITY_STATUS`, `SIDEBAR_CLOSED`, `REQUEST_COMPARE_STUDIO` |
| **synchronisations** (panneau → hôte → autres) | `SYNC_CAMERA`, `SYNC_CHANNELS`, `SYNC_EXPOSURE`, `SYNC_Z`, `SYNC_TIME`, `SYNC_SLICER_SPEC`, `SYNC_ZSTACK_SLICE`, `WM_PHYSICAL_VIEW` |
| **hôte → panneau** | `SET_TOOL`, `PLUGIN_ACTIVATE`, `SET_QUALITY`, `TOGGLE_SIDEBAR`, `TOGGLE_ZSTACK`, `SET_CHANNEL_ACTIVE`, `APPLY_WORKSPACE_STATE`, `PANEL_HELLO`, `WM_SET_PHYSICAL_VIEW` |
| **demandes** (hôte → panneau) | `REQUEST_CAPTURE`, `REQUEST_STUDIO_SLICE`, `REQUEST_WORKSPACE_STATE`, `REQUEST_CHANNEL_STATE` |
| **réponses** (panneau → hôte) | `CAPTURE`, `STUDIO_SLICE`, `WORKSPACE_STATE`, `CHANNEL_STATE` |

### Qui a le droit de parler

- **Jamais d'origine générique.** Les messages partent vers l'origine de la page (`Utils.trustedTargetOrigin()`), jamais vers `*`.
- **À la réception**, l'hôte vérifie l'origine, puis que `event.source` est bien **la fenêtre du cadre qu'il a monté** à ce numéro. Une page nichée dans un panneau, qui porterait le même numéro, est ignorée.
- Une **réponse** n'est acceptée que du panneau auquel la demande est partie, avec le bon type, **une seule fois**.

### Demandes et réponses

Chaque demande porte un `requestId` (préfixe aléatoire + compteur). La réponse le reprend. Si elle ne vient pas à temps, la demande échoue avec un code précis : `COMPARE_TIMEOUT`, `COMPARE_UNREACHABLE` (panneau fermé ou injoignable), `COMPARE_PANEL_ERROR` (la page a répondu « impossible »).

| Demande | Délai |
|---|---|
| capture, état de l'espace de travail, état des canaux | 10 s |
| coupe pour le Studio (peut rendre une coupe native) | 90 s |

Les images voyagent comme `ImageBitmap` **transférés** (pas copiés) : le panneau rend sa vue et la photographie **dans la même tâche** (son canevas WebGL ne conserve pas son image), puis la transfère. Si la réponse arrive trop tard, ses images sont libérées au lieu de fuir.

### Le budget mémoire commun

Les panneaux partagent **un seul processeur graphique**, mais chacun croit disposer de toute la mémoire. « 1024 » peut valoir quelques centaines de Mo ou plus d'un Go selon le jeu. Compter les panneaux ne suffit donc pas : chaque volume **annonce le prix de chaque qualité** (`qualityBytes`, octets d'atlas), et l'hôte répartit un budget **fixe de 1,5 Gio** (une constante de `compare.js`, pas une mesure de votre carte).

![Un exemple en trois temps avec trois volumes (valeurs d'exemple).](img/ch13/compare-qualite.svg){width=94%}

L'algorithme (`CompareQuality.plan`) tient en deux boucles :

1. **Abaisser** : tant que le total dépasse le budget, le panneau qui occupe le plus descend d'un cran.
2. **Remonter** : tant qu'un panneau peut monter d'un cran sans dépasser, le plus bas monte (à égalité, la marche la moins chère), sans dépasser le plafond.

::: example
Trois volumes à 1024 coûtent 620 + 900 + 330 = 1 850 Mio, pour un budget de 1 536. Le plus gros (900) passe à 512 (240) : total 1 190. Le remonter coûterait +660 : 1 850 > 1 536, refusé. Résultat : A et C à 1024, B à 512.
:::

- Le **plafond automatique** est 1024 : « natif » ne s'obtient qu'en le choisissant à la main. Les **photographies n'ont pas de qualité** et ne comptent pas.
- Un panneau qui n'a pas encore chiffré ses niveaux **réserve 256 Mio**.
- Les montées se font **un panneau à la fois** : le suivant attend le [`QUALITY_STATUS`]{.ui} du précédent. Un panneau qui ne se stabilise pas en **180 s** est abandonné (message en console), et le niveau qu'il n'a pas atteint n'est plus redemandé.
- Si la mémoire de la carte a fait descendre un panneau **plus bas** que demandé, ce niveau demandé compte aussi comme échoué : sinon l'hôte le redemanderait sans fin et rechargerait le volume à chaque passage.
- Une page ancienne, qui ne chiffre pas ses niveaux, suit l'ancienne règle par **comptage** : 1024 jusqu'à deux volumes, 512 au-delà, et elle ne fait que monter.
- Choisir 512, 1024 ou Natif à la main force ce niveau pour tous les volumes.

### Garder les panneaux au même endroit

**La caméra.** Chaque jeu a sa propre calibration `Q_base` (§ 13.9). Deux embryons orientés différemment dans leur fichier n'ont donc pas la même pose de cube pour la même vue anatomique. Le panneau qui bouge envoie `Q_anat = Q_cube · Q_base⁻¹` ; le panneau qui reçoit pose son cube à `Q_anat · Q_base`. Pendant que le Z-stack verrouille la vue de dessus, l'orientation reçue est ignorée mais le zoom est gardé.

![La caméra se synchronise en pose anatomique, pas en pose de fichier.](img/ch13/compare-camera.svg){width=94%}

**Le temps.** Deux séries de longueurs différentes s'alignent sur la **fraction** de leur durée.

![Pourquoi la fraction, et comment l'écho est évité.](img/ch13/compare-temps.svg){width=94%}

La règle est la même des deux côtés : si les longueurs diffèrent, `image = arrondi(fraction × (N − 1))`, sinon le même numéro. Elle est doublée d'une garde : l'hôte note chaque image qu'il a demandée à un panneau (fenêtre de 6 s, 16 ordres au plus). L'annonce de cette image par le panneau est la **réponse** à l'ordre, pas une action de l'opérateur : elle n'est pas relayée.

**Les canaux** se synchronisent **par nom** (« Pecam1 » avec « Pecam1 »), exposition comprise. **Le plan Z, le plan oblique et la tranche du Z-stack** voyagent en position normalisée. **Une photographie** échange une vue **physique** (§ 13.5) ; une photo non calibrée n'en envoie ni n'en reçoit.

Chaque famille est réglable par un interrupteur de l'en-tête (Plan Z, Temps, Caméra / vue, Canaux).

### Un panneau qui arrive en retard

L'hôte **mémorise le dernier message de chaque famille** (caméra, vue physique, temps, chaque canal, exposition, plan Z, plan oblique, Z-stack) et le nom du panneau qui l'a produit. Quand un nouveau panneau devient prêt, `_replayLastSync` lui rejoue ces messages : il s'ouvre là où sont les autres, dans la pile, avec les mêmes canaux éteints. Si un panneau est fermé, ce qu'il avait produit est **oublié** : un panneau ajouté plus tard ne s'ouvrirait pas sur un jeu qui n'existe plus.

Une restauration d'espace de travail ne rejoue rien : l'état sauvegardé du panneau a la priorité.

### La figure de la grille

L'export (§ 12.8) compose **la grille visible** sur un canevas de 2× la taille d'écran, plafonné à **4096 px** de côté. Pour chaque panneau l'hôte envoie `REQUEST_CAPTURE`, dessine l'image reçue dans sa cellule, ajoute le titre et une signature. Un panneau qui ne répond pas est remplacé par un cadre gris avec son nom, et le nombre de panneaux de secours est compté. Le format est PNG ou WebP (qualité 0,95) ; le fond suit le thème.

Le **Studio de Comparer** réutilise le Studio du § 13.3 : une cellule par panneau. En **échelle physique**, tous les panneaux calibrés sont dessinés à **un seul µm par pixel**, celui du plus grossier, et ne sont jamais agrandis : une barre d'échelle est vraie pour tous.

### L'espace de travail

Le bouton [Sauvegarder]{.ui} garde, dans le navigateur, l'état de **chaque panneau** plus celui de l'hôte :

`panels` · `panelTypes` · `layoutMode` · `layoutWeights` · `sync` · `tool` · `quality` · `panelZstackStates` · `panelSoloChannels` · `iframeStates`.

- L'hôte **attend que tous les panneaux soient prêts** ; un panneau en échec est gardé dans la liste (rouvrir l'espace de travail le réessaie) avec un état vide. Avant cela, l'état est « pas encore disponible » et l'adresse n'est pas mise à jour.
- Le **cache de briques** est retiré de l'état d'un panneau : il se remplit tout seul pendant le streaming et changerait l'adresse chaque seconde.
- À la **restauration**, l'état d'un panneau est envoyé dès que son document existe (événement `load` du cadre), pour que le viewer saute son premier cadrage de caméra. Une qualité inconnue est refusée : elle ne serait jamais acquittée et bloquerait la file des qualités.
- L'adresse (`#state=…`, § 13.7) n'est écrite qu'après un **changement de l'opérateur** : les panneaux ouverts par l'adresse elle-même (`?add=`) sont l'état intact de la page, et le point de comparaison est repris quand ils sont tous prêts.

::: remember
- Les panneaux sont les **vraies pages** ; l'hôte demande, la page répond.
- Origine explicite, `event.source` contrôlé, demandes avec `requestId` et délai.
- Qualité : **budget fixe de 1,5 Gio**, on abaisse le plus gros puis on remonte le plus bas.
- Temps : **fraction**, avec une garde contre l'écho. Caméra : pose **anatomique**.
:::

## 13.5 La page 2D en profondeur

::: tldr
- Le moteur est un **canevas** qu'on déplace et qu'on zoome : trois repères, une relation d'échelle.
- Réglages d'affichage et isolement du marquage tournent dans un **worker**, sur une copie ; la photographie mesurée n'est jamais modifiée.
- L'importeur lit la **taille de pixel** dans les balises du TIFF et le **nom du fichier** pour le stade.
:::

### Trois repères

![Image, orientée, canevas : et la seule relation de calibration.](img/ch13/2d-reperes.svg){width=94%}

Le moteur `Viewer2D` n'utilise pas Three.js. Il dessine un canevas 2D avec la transformation `sx = ox·scale + tx`. Le miroir est appliqué **avant** la rotation, autour du centre de l'image ; la boîte englobante de l'image tournée sert à cadrer. L'angle est normalisé dans [−180 ; 180[, et un affichage « ajusté » le reste quand l'angle change.

::: tech
- `scale` est le nombre de **pixels CSS par pixel d'image**. Il vaut au plus **32** et au moins **0,25 × l'ajustement**. L'ajustement laisse 2 % de marge de chaque côté (facteur 0,96).
- La molette zoome autour du curseur d'un facteur 1,1 par 100 unités ; un seul événement ne zoome jamais de plus de 3 crans, et Firefox, qui compte en « lignes », est ramené en pixels (1 ligne = 33 px).
- Un geste de moins de 4 pixels est un clic. Deux doigts font un zoom et un déplacement. Un double-clic ajuste. [Résolution native 1:1]{.ui} règle `scale = 1 / devicePixelRatio` : un pixel d'image par pixel d'écran physique.
- La mesure garde le même contrat que celle du volume : `{ normalized, physicalUm, screen }`, avec `physicalUm = pixel × taille du pixel`.
:::

### Le chargement en deux temps

![L'aperçu d'abord, le natif ensuite.](img/ch13/2d-chargement.svg){width=94%}

Les deux fichiers sont demandés **ensemble** ; le premier décodé est dessiné. Une image plus petite ne remplace jamais une plus grande déjà à l'écran. Au parcours ←/→, la requête du natif attend 150 ms que la touche se calme : maintenir la flèche ne télécharge que la photographie sur laquelle on s'arrête. Une capture prise avant le natif porte l'aperçu agrandi : le Studio est prévenu (`quality: 'preview'`).

La pastille de chargement de la page distingue *aperçu*, *natif*, et *erreur du natif* (l'aperçu reste affiché).

### Réglages d'affichage et isolement

![La table de correspondance d'un canal : 256 valeurs calculées une fois.](img/ch13/2d-lut.png){width=62%}

Pour chaque canal, le réglage est une **table de 256 valeurs** : `x = (v/255 · balance − ½)(1 + contraste/100) + ½ + luminosité/100`, bornée à [0 ; 1], puis `x^(1/gamma)`. La balance ne s'applique qu'au rouge et au bleu. Déplacer un curseur ne recalcule donc que la table, et la boucle sur les pixels est une simple lecture.

| Réglage | Plage |
|---|---|
| Luminosité, Contraste | −100 à 100 |
| Gamma | 0,1 à 10 |
| Balance rouge, bleu | 0,1 à 4 |

Une valeur venue d'un curseur, d'un fichier d'espace de travail ou d'un lien est **assainie** : inconnue, ignorée ; hors plage, ramenée à la plage ; non numérique, refusée. Une valeur piégée ne peut donc pas rendre la photographie toute noire.

::: warning
**L'isolement du marquage a priorité sur les réglages** : tant qu'il est allumé, la vue montre le résultat de l'isolement seul. Les deux ne se cumulent pas.
:::

**Aplatir le fond.** Le gain d'un pixel est « éclairage moyen / éclairage local ». L'éclairage est modélisé par une **surface quadratique** `c₀ + c₁x + c₂y + c₃x² + c₄y² + c₅xy` ajustée par moindres carrés sur la carte réduite au huitième, en ne gardant que les **40 % de cellules les plus sombres** (le fond mat) : une surface lisse ne peut pas suivre l'embryon, qui garde donc son propre contraste. Le gain est borné entre 0,5 et 3 ; un système singulier donne une surface plate.

![La carte de gain d'une photographie et la correction qui en résulte.](img/ch13/2d-aplatir.png){width=96%}

**Isoler le marquage.** Le calcul tient en quatre cartes. Le contexte « tissu jaune » est une moyenne locale de `(R+V)/2 − B` sur un quart de résolution (boîte de 11 × 11 cellules, environ 40 pixels, calculée avec une table d'aires cumulées, donc en temps constant par pixel). Le marquage `v` vaut `(B/(R+1) − 1,0) / 0,8` borné à [0 ; 1], **seulement** si le contexte dépasse 5. Le pixel final est un gris à 35 % de sa luminosité, mêlé de cyan `(90 ; 160 ; 255)` à proportion de `v`.

![Les quatre cartes du calcul, sur la photographie de démonstration.](img/ch13/2d-isolation-cartes.png){width=100%}

::: tech
- **Pourquoi ce seuil de 5 ?** Un tronc marqué, large, tire la moyenne locale vers 6 à 9 ; le fond mat ne dépasse jamais 2 à 6. Le seuil est bas exprès : un marquage est du bleu **dans** un tissu jaune.
- **Le worker.** La page transfère un `ImageBitmap` (pas de copie), le worker dessine sur un `OffscreenCanvas`, applique les opérations de `pixel-ops-2d.js` et renvoie un bitmap. Les cartes d'éclairage et de contexte ne dépendent que de l'image : elles sont **gardées** tant que l'image ne change pas. Si des demandes s'empilent (un curseur qu'on tire), **seule la plus récente** est lancée.
- Sans Worker ni `OffscreenCanvas`, ou si le worker tombe, le même code tourne sur le fil principal, un travail à la fois. Une capture prend une version **exacte** pour les réglages du moment, jamais une version périmée.
- Ces deux opérations sont **de l'affichage** : les mesures et la grille lisent la photographie intacte. Le Studio, lui, reçoit ce qui est à l'écran (isolé ou ajusté, miroir et rotation compris), à la résolution native, calibré en µm/pixel.
:::

### L'orientation, la grille, la vue divisée

- **Orientation.** Le plugin pilote `setOrientation({ rotationDeg, flipH })` et dessine la boussole (A/P) ; la rotation étant rigide, l'échelle ne change pas. L'administrateur enregistre la pose avec le jeu de données (`orientation2d`), par les mêmes messages que l'orientation 3D (§ 13.9).
- **Grille calibrée.** Un pas **1-2-5** le plus proche de 120 px (grand) ou 60 px (fin), ancré sur le coin de l'image orientée ; les étiquettes (distance au coin) n'apparaissent que si le pas dépasse 44 px. Sans calibration, elle l'écrit au lieu de ne rien tracer.
- **Barre d'échelle.** `longueur = 1-2-5 le plus proche (120 px / px par µm)` ; elle n'existe que si la photographie est calibrée.

![La vue divisée échange une vue physique, pas des pixels.](img/ch13/2d-vue-physique.svg){width=94%}

La **vue physique** est le couple `umPerCss = taille de pixel / scale` et `centerUm` (le décalage du centre de l'écran par rapport au centre de la photo, en µm). Deux photos à 2,0 et 3,2 µm/px sont ainsi au même grossissement **réel**, et déplacer l'une déplace l'autre de la même distance réelle.

### La collection

La planche-contact (touche <kbd>B</kbd>) est triée par stade, puis date de dissection, puis nom ; elle se filtre par stade, par lignée et par texte (nom, stade, lignée, coloration, description, date).

![La planche-contact de la collection (deux photographies de démonstration).](img/ch13/2d-planche-contact.png){.shot width=96%}

- Une fois la photographie à l'écran et la page au repos (400 ms), les **deux voisines** sont préchargées (aperçu et natif). Ni un panneau de Comparer, ni la vue divisée, ni l'aperçu de l'administration ne le font : cela multiplierait les téléchargements.
- Passer d'une photo à l'autre met à jour l'adresse avec l'historique du navigateur (`pushState`) ; le bouton Précédent ramène à la photographie d'avant sans recharger la page.
- Les **mesures** d'une photographie sont conservées en mémoire par identifiant : revenir à une photo les restaure.

### La planche de figure

![Même échelle physique, ou même taille : deux façons de composer.](img/ch13/2d-planche.svg){width=94%}

En mode « même échelle physique », chaque photographie est ramenée au **pixel le plus grossier** de la sélection (`facteur = px_i / px_max`, donc jamais d'agrandissement) et une barre commune vaut pour tout. En mode « même taille », chaque photographie remplit la même cellule, avec sa propre barre. Une photo **non calibrée** ne participe pas à l'échelle commune : elle est ajustée dans la cellule et marquée comme telle.

Le Studio reçoit **un rectangle de calibration par panneau** : une barre posée sur un panneau lit le µm/pixel de ce panneau, et le suit si on la déplace sur un autre. Limites : 6 000 px de large, 16 000 px de côté, 120 mégapixels (la figure est réduite pour y tenir), 48 mégapixels de photographies décodées gardées entre deux rendus, 3 décodages en parallèle.

### L'importeur 2D

![De l'export ImageJ au dossier de données.](img/ch13/2d-importeur.svg){width=94%}

`preprocess/2d_importer.py` (version 0.18.0) transforme **un TIFF en un jeu de données**. 

```
python 2d_importer.py --input <dossier|fichier.tif> --output DATA_WEB \
    [--line DLL4xCD1] [--staining X-gal] [--only "*E8.0*"] \
    [--with-downloads] [--force] [--lossless]
```

| Option | Effet |
|---|---|
| `--line`, `--staining` | ce que le fichier ne dit pas (ligne, coloration) |
| `--only` | un filtre de noms (« *E8.0* ») |
| `--with-downloads` | place le TIFF d'origine et un `README.txt` dans `download/` |
| `--force` | réimporte en **gardant** ce que le laboratoire a corrigé |
| `--lossless` | WebP sans perte (plus gros) |

**Lire les plans.** Un hyperstack ImageJ range ses pages « canal en premier » : les `channels=` premières pages forment **un** composite ; les suivantes sont d'autres images, qu'on n'additionne pas. Le composite est additif, exactement ce qu'ImageJ affiche : `sortie = Σ table_c[plan_c]`, chaque plan 8 bits passant par sa **table de couleur** de 768 octets (3 rampes de 256). Sans table, trois plans sont lus comme R, V, B et un plan comme un gris. Un plan de 16 bits est ramené sur 8 par son maximum.

**La taille de pixel.** ImageJ écrit la résolution (balises 282 et 283) en **pixels par unité**. L'importeur ne la croit que si l'unité de la description est le **micron** ; la taille d'un pixel vaut alors `1 / résolution`, en x et en y (carrés si seule la résolution x existe). Sinon : `calibrationStatus: unknown`, pas de barre d'échelle, pas de mesure, et le texte le dit.

**Le bloc Leica.** ImageJ embarque le texte de LAS X. Pour la série lue, l'importeur retient le zoom, le grossissement, l'objectif, l'ouverture numérique, l'exposition (convertie en ms), le gain, le microscope et la caméra. Le texte répète chaque clé par bloc de travail ; la ligne du niveau supérieur (celle de l'exposition réellement prise) l'emporte, et les « 0 » de remplissage ne passent jamais devant une vraie valeur.

**Le nom du fichier.** `<lif> - <stade> x<zoom> <date aammjj> [<n> [<m>]]`. Le stade passe par **le même analyseur que les volumes** (`E8-5`, `E8.5`, `E85` valent E8.5), la date doit être un vrai jour, la ligne se lit dans le nom du `.lif` (`DLL4xCD1`). Rien n'est inventé : une partie absente reste vide.

::: example
« DLL4xCD1 - E9.5 x3.2 240913 1.tif » donne le dossier `DLL4xCD1-E95-x3.2-240913-1`, stade E9.5, zoom ×3,2, dissection le 2024-09-13, index 1. Dossier : `<ligne>-<stade sans point>-x<zoom>-<aammjj>-<index>`.
:::

**Les fichiers écrits.** `image.webp` (natif, qualité 90, méthode 6, ou sans perte), `preview.webp` (grand côté 640 px, LANCZOS, qualité 80), `thumbnail.webp` (carré de 512 px sur fond `#080a12`), `metadata.json` (écrit **en dernier**, atomiquement : un import à moitié fait n'est jamais monté). Côté maximal : 16 383 px (limite de WebP).

::: why
**Pourquoi `--lossless` existe.** Le WebP avec perte sous-échantillonne la couleur (4:2:0), ce qui perturbe le rapport B/R par pixel que lit l'isolement du marquage, surtout aux contours nets. Pour une analyse du marquage, gardez la photo exacte.
:::

Deux TIFF qui se décriraient de la même façon (même ligne, stade, zoom, date, index) produisent le même nom de dossier : le second est **refusé** avec un message, plutôt que d'écraser le premier ou d'être pris pour déjà importé. Un dossier existant n'est pas touché sans `--force`.

::: remember
- Trois repères (image, orientée, canevas) et **une** relation : `L / pixelSizeUm × scale`.
- Réglages et isolement : **table de 256 valeurs** ou calcul en **worker**, sur une copie.
- L'isolement a priorité sur les réglages ; rien de mesuré ne les lit.
- L'importeur ne devine rien : taille de pixel des balises TIFF, stade du nom, le reste de la ligne de commande.
:::

## 13.6 La frise temporelle et les séries live

::: tldr
- La frise est un **composant autonome** (`Timeline`) : une horloge, une piste, un tampon. Le viewer lui dit quand attendre.
- L'horloge ne **saute** jamais une série d'images, et ne **court pas devant** l'image qui n'est pas arrivée.
- L'heure réelle n'est pas affichée, mais l'intervalle entre images sert aux vitesses en µm/min.
:::

Le chapitre 10 (§ 10.7) a expliqué le chargement d'une série (tampon, préchargement, dernière image seulement). Voici l'horloge elle-même.

### Un tour d'horloge

![Les cinq étapes d'un pas de lecture.](img/ch13/frise-boucle.svg){width=94%}

::: example
À 10 images par seconde, sur un écran à 60 Hz, chaque pas dure environ 16,7 ms : la tête avance de `10 × 0,0167 ≈ 0,17` image. Il faut **six pas** pour changer d'image affichée. Un onglet endormi une seconde ne ferait pas avancer la tête de 10 images : le temps écoulé est plafonné à **250 ms**, soit 2,5 images au plus.
:::

| Constante | Valeur |
|---|---|
| Vitesses proposées | 0,5 · 1 · 2 · 5 · 10 · 20 images/s |
| Vitesse par défaut | 10 images/s |
| Pas maximal | 250 ms |
| Garde de l'attente d'une image | 15 s |
| Clé du navigateur | `iribhm.viewer.playbackFps` |

Un clic sur la vitesse passe à la **première vitesse strictement supérieure** à la vitesse actuelle, et boucle au sommet. Une vitesse mémorisée qui n'est pas dans la liste reste utilisable : elle passe simplement à la suivante.

### Attendre sans bloquer

Une image native peut coûter 600 ms à streamer. Sans précaution, l'horloge avancerait de six images pendant ce temps, et le chargeur serait envoyé chasser une image que personne ne verra. Le viewer **retient donc l'horloge** (`setStalled`) pendant qu'il charge l'image qu'on lui a demandée : la tête ne bouge plus, mais la boucle continue de tourner.

::: why
**Pourquoi la garde de 15 s ?** Un chargement peut ne jamais finir (un onglet en arrière-plan fige l'affichage, et le chargeur attend une image à dessiner). Sans plafond, la frise resterait gelée pour toujours. Le viewer ne compte pas non plus les chargements en cours : il relâche l'horloge à **chaque** fin de chargement, ce qui peut au pire la libérer un peu tôt, jamais la bloquer.
:::

La piste est dessinée à `image / (N − 1)`. Quand vous la saisissez, la lecture **se met en pause** et l'image est celle sous le curseur ; relâcher arrondit à l'image entière. Le bouton Lecture réagit à l'appui (pas au relâchement), et reste utilisable au clavier.

Le texte du compteur est `courante / dernière`, sur trois chiffres : « 000 / 003 » veut dire image 0 sur une série de 4. Les images **déjà en mémoire** sont tracées en bandes sous la piste : une série se remplit autour de la tête et en perd en route, une simple largeur ne suffirait pas. L'image `i` occupe l'intervalle `[i − ½ ; i + ½]` pour que la tête reste dans la bande qui la représente.

### L'heure réelle et la normalisation

- `timeline.intervalMinutes` et `timeline.timestamps` sont dans `metadata.json`. **Les horodatages ne sont pas affichés**, mais l'intervalle permet à l'inspecteur de donner la vitesse d'une cellule en **µm/min** en plus de µm/image.
- Le pipeline enregistre aussi `intensityNormalization` (les niveaux de signal de chaque canal et de chaque image) pour pouvoir **mesurer** le photoblanchiment. **Aucun réglage du viewer ne l'utilise aujourd'hui** : une série qui s'éteint s'affiche réellement plus sombre.
- Le composant sait aussi lisser (des positions fractionnaires) et afficher des curseurs de vitesse ; le viewer ne s'en sert pas.

::: note
Deux séries de longueurs différentes dans Comparer s'alignent par **fraction** de durée (§ 13.4) : « la moitié de la série » est la moitié de chacune.
:::

## 13.7 Ce que la plateforme retient : lien, espace de travail, navigateur

::: tldr
- Quatre endroits : la **mémoire de la page**, **l'adresse**, le **navigateur**, le serveur (qui ne retient rien de vos réglages).
- L'adresse porte l'état entier d'une vue, compressé : elle **sert de sauvegarde**.
- Tout accès au navigateur est protégé : stockage bloqué ou navigation privée, la page marche et oublie.
:::

![Où vit ce que vous réglez.](img/ch13/etat-lieux.svg){width=94%}

### Le lien `#state=`

![De l'état de la page à l'adresse.](img/ch13/etat-hash.svg){width=96%}

Toutes les secondes, la page demande son état à `_getWorkspaceState()`. Celui-ci rassemble trois blocs : `ui` (outil actif, barre latérale, fond), `viewer` (caméra, plan de coupe, mesures, canaux, exposition, grille, étirement Z, Z-stack, image de la série, qualité, calibration…) et `plugins` (l'état que chaque outil expose par `getState()`).

::: example
L'état du viewer du jeu E95 de démonstration, au repos : **2 580 caractères** de JSON, qui deviennent **1 362 caractères** une fois compressés (deflate) et écrits en base64url. La caméra y tient en une ligne : `{"kind":"volume","cameraZ":1.13,"quaternion":[0,0,0,1],"position":[0,0,0],"zDisplayScale":1}`.
:::

L'état n'est **encodé** que s'il a changé, d'après une **empreinte** (le JSON sans les compteurs qui bougent seuls, comme le cache de briques). Le jeu ouvert tel quel est la référence : tant que rien n'a changé, l'adresse reste propre ; revenir exactement à l'état d'ouverture la nettoie. Le bouton [Réinitialiser l'espace de travail]{.ui} ré-adopte l'état d'ouverture comme nouvelle référence, après avoir laissé la fin d'un rechargement se stabiliser (deux lectures identiques de suite, ou un délai).

::: tech
- **Écriture** : au plus 64 Kio de texte, sinon l'adresse n'est plus mise à jour (un ancien `#state=` serait plus faux qu'aucun) et la console invite à utiliser « Save state ».
- **Lecture** : 2 Mio de texte au plus ; la décompression est lue par morceaux et **arrêtée à 16 Mio** (un lien piégé peut gonfler d'un facteur ~1 000).
- **Génération** : toute action qui invalide l'adresse (effacement, nouvelle référence) incrémente un compteur ; un calcul de compression qui finit après coup **jette** son résultat au lieu de ressusciter l'état effacé.
- Aucun appel réseau : le lien contient l'état, le serveur ne le voit jamais.
:::

À l'ouverture d'un lien, une boîte demande : [Ouvrir la vue enregistrée]{.ui} ou [Ouvrir le jeu de données à neuf]{.ui}. Échap et le fond valent « ouvrir la vue » (ce que faisait un lien avant la question). Un contenu illisible est effacé sans question. Dans un panneau de Comparer, il n'y a pas de question : c'est l'hôte qui décide.

### Les espaces de travail du navigateur

`WorkspaceState` range un espace de travail sous la clé `iribhm.workspace.<portée>.<identifiant du jeu>` (portée : `viewer`, `compare`…), version 2, avec la date. Il est normalisé en quatre blocs (`ui`, `viewer`, `tracking`, `compare`). Écrire peut **échouer** (quota, stockage bloqué) : l'erreur est rendue à l'appelant exprès, pour qu'un espace de travail qui n'a pas été enregistré ne soit jamais annoncé comme enregistré. Les clés d'avant le renommage des types (`fixed`, `wholemount`) sont migrées une fois, au passage.

Le viewer n'a **pas** de boutons Sauvegarder / Restaurer : c'est l'adresse. Ils existent dans la page **Comparer** (Centre de téléchargement) et dans le Studio (JSON).

### Ce que garde votre navigateur

| Clé | Contenu |
|---|---|
| `iribhm-theme`, `iribhm-lang`, `iribhm-colorblind` | thème, langue, filtre daltonien (partagés entre pages et cadres par l'événement `storage`) |
| `iribhm.viewer.playbackFps` | vitesse de la frise |
| `iribhm.viewer.zScale.<jeu>` | étirement Z de ce jeu |
| `iribhm.workspace.<portée>.<jeu>` | un espace de travail enregistré |
| `iribhm-gallery-dock` | état du dock de la galerie (ouvert, large, puce) |
| `lumen3d.vramBudgetMB` | budget de mémoire vidéo imposé (opérateur) |
| `lumen3d.gpuContextLosses` | les 8 dernières pertes de contexte graphique (une semaine) |
| `sessionStorage` `lumen_view_<jeu>` | une seule vue comptée par session |

::: note
Les **mesures** ne sont pas dans cette liste : elles vivent dans la mémoire de la page (`MeasurementStore`, une `Map` par portée et par jeu) et voyagent **dans le lien**. L'administration a ses propres clés (`adm-theme`, `adm-upload-dock-size`, `lumen-dupd-*`), décrites au chapitre 14.
:::

Le budget graphique mérite d'être connu (§ 10.4) : il est **divisé par deux pour chaque perte de contexte graphique** de la semaine écoulée (plancher 256 Mio), sur ce profil de navigateur. Vider les données du site le remet à zéro.

## 13.8 Algorithmes de mesure et de pose

::: tldr
- Un clic de mesure lit la **profondeur sur le GPU** en deux passes d'un pixel, avec une précision de 16 bits.
- Mettre une pile à plat, c'est **deux rotations autour des axes de l'écran** : la pile ne culbute pas.
- L'export d'une grande image **recommence** si le volume ou les réglages changent pendant son rendu.
:::

### La profondeur sous le curseur

Le chapitre 12 (§ 12.2) a décrit la logique : le maximum du rayon, puis le premier franchissement de 55 %. Voici le mécanisme.

![Les deux passes d'un pixel et le codage sur 16 bits.](img/ch13/pick-encodage.svg){width=94%}

![Les trois sources d'un point, dans l'ordre où elles sont essayées.](img/ch13/pick-ordre.svg){width=94%}

::: tech
- Le rendu d'un pixel utilise **les mêmes uniformes** que l'écran : mêmes fenêtre, canaux allumés, rognage, tranche du Z-stack, stabilisation, briques. Il est cadré par `camera.setViewOffset` sur le pixel cliqué.
- Les constantes sont `PICK_SURFACE = 0,55`, `PICK_MIN_VALUE = 0,02`, `PICK_MAX_STEPS = 4096` ; le pas est d'un demi-voxel (`1 / (2·nu)`), allongé si le rayon dépasserait 4 096 pas.
- Sous stabilisation, la position codée est celle de la **boîte d'affichage** (`clipBoxMin + c · clipBoxSize`) ; sans stabilisation, celle de la boîte unité. Le décodeur gère les deux.
- Une perte de contexte graphique, ou l'absence de volume actif, retire la voie GPU : le point retombe sur la boîte, et l'outil de mesure **refuse** ce point.
:::

### Coucher la pile : l'ouverture du Z-stack

Le chapitre 12 (§ 12.4) dit que la pile « se couche à plat en 1,5 s ». Voici la géométrie, qui sert aussi au sens de l'échantillon (§ 13.9).

![Deux rotations autour des axes de l'écran, calculées pour un exemple.](img/ch13/poses-tilt.svg){width=94%}

`setView(vue, options)` accepte plusieurs façons de choisir **l'angle dans le plan** de la vue :

| `spin` | Choix |
|---|---|
| `'frame'` (défaut) | la rotation dans le plan la plus proche du repère calibré |
| `'nearest'` | la plus proche de la pose **actuelle** (le plus petit mouvement, par un axe en général oblique) |
| `'tilt'` | **celle qu'obtiennent les deux rotations** ci-dessus ; utilisée par le Z-stack |
| un nombre | des degrés comptés depuis le repère |

La **face** (`side`) est `front`, `back` (la pose de face retournée d'un demi-tour autour de la verticale), ou `top` / `bottom` : les faces haute et basse de l'échantillon, résolues selon `upsideDown`. L'animation est une interpolation d'un bout à l'autre, avec un adoucissement `3t² − 2t³` ; les deux rotations de `'tilt'` croissent ensemble pour se lire comme un seul geste. Une caméra n'est notifiée **qu'une fois**, à l'arrivée, pour que les panneaux de Comparer voient la pose finale ; saisir la souris annule le vol.

### Exporter une très grande vue

L'export (§ 12.6) rend la vue **par tuiles** d'au plus 2048 px (moins si la carte graphique ne le permet pas, jusqu'à 256 px en dernier recours). Pour que la grande image soit cohérente, `renderViewImage` :

- prend la **pose de départ** une fois (celle où atterrit un vol en cours), avec le rapport d'aspect de l'image demandée ;
- attend que le volume ait **fini de streamer**, puis rend une tuile par tâche ;
- vérifie avant **chaque tuile** que le volume actif est le même et que l'empreinte d'affichage (canaux, exposition, mode de rendu, rognage, grille et axes, étirement Z) n'a pas changé ;
- sinon **efface et recommence**, trois fois au plus (erreurs `unstable` ou `display-changed` ensuite) ;
- continue le grain aléatoire d'une tuile à l'autre (`fragCoordOffset`) pour qu'aucune couture ne se voie, et écrit un fond transparent par une opacité par pixel (`exportAlpha`).

Les autres erreurs ont un code lisible : `busy` (un export tourne déjà), `size`, `canvas` (le navigateur refuse une image si grande), `gpu-memory`, `context-lost`.

## 13.9 L'orientation en pratique, et le sens de l'échantillon

::: tldr
- Trois poses : **Q_base** (le repère), **Q_anat** (l'anatomie à l'écran), **Q_cube** (le volume). Deux produits les relient.
- L'administrateur ne calcule jamais un quaternion : il **demande** au plugin, qui répond par message.
- Le **sens de l'échantillon** corrige un fichier Imaris qui montre l'échantillon vu de dessous.
:::

Le chapitre 12 (§ 12.5) a donné la théorie en une phrase. Voici le mécanisme complet, tel que l'administrateur le manipule (chapitre 14, et le guide de l'administrateur § 3.8).

![Les trois poses et les deux produits de quaternions.](img/ch13/orientation-reperes.svg){width=94%}

### Ce que stocke `metadata.json`

| Champ | Rôle |
|---|---|
| `orientation` | **Q_base** : la pose du cube pour laquelle l'anatomie coïncide avec les axes de l'écran |
| `orientationAxes.labels` | les noms que l'opérateur a donnés aux six bras (vide : R1/R2, G1/G2, B1/B2) |
| `orientationAxes.hidden` | les bras non dessinés (ils ne sont même **pas construits**) |
| `orientationAxes.defaultView` | la vue d'ouverture : `Q_anat` (un préréglage et/ou un quaternion) |
| `upsideDown` | le fichier montre l'échantillon vu de dessous |

Les bras ont des **identifiants de stockage** (R/L pour ±X en rouge, A/P pour ±Y en vert, V/D pour ±Z en bleu) qui n'imposent aucune nomenclature : vous les nommez comme vous voulez.

### La conversation entre l'administration et le viewer

L'aperçu de l'administration est le vrai viewer, dans un cadre. Le panneau ne calcule **aucune géométrie** : il envoie des messages au plugin *Orientation Axes* et enregistre ce qui revient. Une seule implémentation de la géométrie existe.

| Le panneau envoie… | Le plugin répond / fait |
|---|---|
| `CALIBRATE_ORIENTATION_START` | repart de l'alignement **enregistré** (on le raffine, on ne recommence pas), fige la boussole sur les axes de l'écran, l'affiche |
| `GET_ORIENTATION` | `ORIENTATION_RESULT` : la pose actuelle du cube, à enregistrer comme `Q_base` |
| `SET_ORIENTATION_AXES` | aperçu en direct des noms et de la visibilité des bras |
| `APPLY_ORIENTATION_VIEW` | pose le volume et renvoie `ORIENTATION_VIEW_RESULT` avec le `Q_anat` à stocker |
| `GET_ORIENTATION_VIEW` | capture la pose **actuelle** comme vue par défaut (en `Q_anat`) |
| `SET_SAMPLE_UPSIDE_DOWN` | prévisualise la face supérieure ; répond `SAMPLE_SIDE_RESULT` |

::: tech
- **Les six préréglages** sont chacun deux contraintes : quelle direction anatomique regarde la caméra (+Z de l'écran), laquelle pointe vers le haut (+Y). La rotation unique qui les satisfait s'obtient en construisant la base `(droite, haut, face)` et en prenant l'inverse. Ventral : face V, haut A ; dorsal : face D, haut A ; gauche / droite : face L / R, haut A ; antérieur / postérieur : face A / P, haut D.
- **La vue par défaut s'applique avant la première brique** (`prepare()`, appelé entre l'initialisation du viewer et le premier chargement) : tourner après coup montrerait le volume dans une pose puis le ferait claquer dans une autre pendant que les briques arrivent. Elle est enregistrée comme la **pose d'origine** du viewer : le bouton [Réinitialiser la vue]{.ui} y revient, et non aux axes bruts du fichier.
- **Une vue par défaut est stockée en Q_anat**, une affirmation sur l'anatomie (« ventral vers moi »), donc affiner la calibration plus tard ne la périme pas.
- Quand un jeu n'a **pas** de calibration, les bras partent de la pose brute du fichier (retournée si `upsideDown`).
- La boussole est entraînée par `Q_cube · Q_base⁻¹` ; sa sphère centrale se déplace en glissant, et sa position est dans l'espace de travail.
:::

### Le sens de l'échantillon

![L'aperçu de l'administration : orientation 3D et gizmo d'axes.](img/ch13/admin-orientation.png){.shot width=88%}

::: legend
| n | ce que c'est |
|---|---|
| 1 | **Sens de l'échantillon** : deux boutons radio |
| 2 | [🧭 Définir l'orientation]{.ui} : place le gizmo d'axes dans l'aperçu |
| 3 | **Axes affichés** : cocher, masquer, renommer |
| 4 | **Vue par défaut** : la pose d'ouverture du jeu |
| 5 | [📌 Utiliser la vue actuelle]{.ui} : capture la pose de l'aperçu |
:::

Un stack confocal exporté d'Imaris est **en général vu de dessous** : l'objectif d'un microscope inversé est sous l'échantillon. Le viewer appelle « dessus » la face −Z dans ce cas (`upsideDown: true`), et la pose brute d'un jeu non calibré est retournée d'un **demi-tour autour de la verticale de l'écran** : la gauche et la droite s'échangent, le haut reste en haut.

::: why
**Pourquoi un demi-tour autour de la verticale et pas autour de l'axe X du fichier ?** Dès qu'une calibration a incliné les axes du fichier à l'écran, un demi-tour autour de l'axe X du fichier ressemble à une culbute en diagonale. Autour de la verticale **de l'écran**, c'est toujours le même geste, quelle que soit la pose.
:::

L'interrupteur de l'administration **prévisualise** la face haute : il couche le volume (`'tilt'`, 1 s) face à vous. C'est exactement ce que montrera ensuite l'explorateur Z-stack.

![Après avoir choisi « À l'envers » : l'aperçu se couche, la face choisie vers vous (mêmes repères numérotés).](img/ch13/admin-sens-echantillon.png){.shot width=88%}

- **Ni Q_base ni une vue par défaut ne dépendent du sens** : les deux sont des poses de l'anatomie ; l'éditeur n'enregistre que le drapeau.
- Le sens est pris en compte par la vue initiale d'un jeu non calibré, le bouton de réinitialisation, la vue « 3d », le Z-stack et les figures du Studio (lacet 180° sur la face −Z).

::: warning
Un jeu dont le sens a été basculé sous la version 1.55.7 de la plateforme a un repère faussé (il avait été tourné autour de l'axe X du fichier). Il faut **définir de nouveau son orientation**.
:::

## 13.10 Galerie, jeux liés, vignette

::: tldr
- La **galerie** ajoute des images (captures annotées, schémas) à un jeu ; leur type vient des **octets magiques**, jamais du nom.
- Les **jeux liés** se déduisent de quatre règles, sans rien saisir.
- La **vignette** de l'explorateur est une capture de 512 × 512 que l'administrateur choisit.
:::

### La galerie d'images

![Le trajet d'une image, de l'envoi à la visionneuse.](img/ch13/galerie-chemin.svg){width=94%}

L'API accepte un corps d'image **brut** (jusqu'à la limite du serveur) ou, historiquement, une URL `data:`. Dans les deux cas, le type est reconnu à ses **octets magiques** (WebP, PNG, JPEG, GIF) ; le nom de fichier ne sert qu'à fabriquer un nom lisible (lettres, chiffres, tirets, 60 caractères au plus, numéroté en cas de doublon). Un fichier trop grand (8 Mio), un 41ᵉ envoi ou un contenu qui n'est pas une image sont refusés.

La **vignette** de 320 px sert la grille du dock : quarante originaux ne doivent pas se disputer les connexions dont les paquets de briques ont besoin. Sans Pillow ou sans WebP côté serveur, elle tombe sur du JPEG, ou est omise. Une image d'un jeu **en cours d'import** est refusée (409) : publiez d'abord.

Côté page, `DatasetGallery` ne construit son DOM qu'avec `createElement`, jamais en concaténant du texte : les légendes sont du texte d'opérateur et les noms de fichier viennent du disque.

### Les jeux liés

![Les quatre natures d'un lien entre deux jeux.](img/ch13/relations.svg){width=94%}

`Catalog.getRelated(id)` renvoie les jeux qui partagent **le même embryon et le même stade**, **la même date de dissection et le même stade**, ou qu'un `relatedIds` désigne (dans un sens ou dans l'autre). `getRelationMeta` donne ensuite la **nature** du lien, en testant dans cet ordre : *registered* (un bloc de recalage existe), *related* (lien explicite), *same-embryo*, *context* (le reste). L'explorateur affiche le badge « Lié » ; la page 2D et le viewer listent les jeux liés d'un autre type : une photographie renvoie vers le volume du même embryon.

### La vignette de l'explorateur

![De l'aperçu de l'administration à thumbnail.webp.](img/ch13/vignette-chemin.svg){width=94%}

Le bouton [Redéfinir la preview]{.ui} demande une capture au viewer de l'aperçu. Si une coupe ou le Z-stack est ouvert, c'est **elle** qui est photographiée (rendue à 1024 px) ; sinon le canevas 3D. L'image est posée au centre d'un carré de 512 × 512 px de fond `#080a12` **sans déformation**, puis encodée en WebP (qualité 0,9). Le serveur vérifie les octets magiques et une taille d'au plus 5 Mio avant d'écrire `thumbnail.webp`.

::: see
- Le format des dossiers `planes/` et `mips/`, et le journal des migrations : chapitres 7 et 17.
- Le système de plugins (`contexts`, `dataTypes`) et la confiance : chapitre 15.
- Les noms exacts des écrans d'administration : chapitre 14 et guide de l'administrateur.
:::

::: remember
Ce chapitre en une page :

- **Suivi** : sphères instanciées, tableaux 32 bits, une façade partagée.
- **Stabilisation** : `volumeWarp = toTex · M⁻¹ · toUm` ; aucun voxel retouché.
- **Studio** : document sans pixels, recoloration depuis les valeurs brutes, passe native plan / atlas, jeton.
- **Comparer** : vraies pages, messages vérifiés, budget 1,5 Gio, temps par fraction.
- **2D** : trois repères, worker de pixels, importeur qui ne devine rien.
- **Frise** : horloge plafonnée à 250 ms, retenue pendant le chargement.
- **État** : le lien est la sauvegarde ; le navigateur ne retient que des préférences.
- **Mesure** : profondeur lue sur le GPU en deux passes de 16 bits ; poses par deux rotations.
- **Orientation** : Q_base, Q_anat, Q_cube ; le sens de l'échantillon est un demi-tour de la verticale.
:::
