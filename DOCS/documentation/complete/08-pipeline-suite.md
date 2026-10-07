# 8. La fin du pipeline : métadonnées, suivi cellulaire, publication

::: chapter-intro
- Après les briques, le pipeline fabrique la **vignette**, les **histogrammes** et le fichier `metadata.json` (stade, embryon, calibration, canaux), et, pour une série temporelle, le **suivi cellulaire**.
- Le résultat est publié **« tout ou rien »** : le jeu de données déjà en ligne n'est jamais laissé à moitié remplacé, et ce que vous avez saisi à la main est conservé.
- Vous lancez tout par `RUN.bat`, puis vous copiez le dossier produit sur le serveur (FTP) ou vous le glissez dans l'onglet [Import]{.ui}.
:::

Les images de données de ce chapitre viennent du **jeu de démonstration** (embryons synthétiques générés pour cette documentation, traités par le vrai pipeline) : ce ne sont pas des données du laboratoire.

## 8.1 La vignette

La vignette est la petite image de la carte du jeu de données dans l'explorateur. Elle est faite à partir de la **première image** de l'acquisition, en prenant le niveau de résolution le plus fin dont le grand côté ne dépasse pas 1024 pixels.

Pour chaque canal, le pipeline calcule un **MIP** (le voxel le plus brillant sur toute l'épaisseur), le colorie, puis **additionne** les canaux : où deux canaux se chevauchent, les couleurs s'ajoutent.

![Trois MIP coloriés, additionnés, donnent la vignette réelle du jeu de démonstration.](img/ch08/vignette.png){width=96%}

::: tech
Couleurs de la vignette, dans l'ordre des canaux : vert, magenta, bleu, rouge, jaune, violet, cyan (rappelées en boucle). Elles n'ont pas de lien avec les couleurs choisies dans le viewer. L'image est réduite à 512 pixels pour son grand côté (interpolation de Lanczos), centrée sur un carré de fond `#080a12`, puis enregistrée en **WebP avec perte**, qualité 88 (33,6 ko ici).
:::

## 8.2 Les histogrammes

Pour chaque canal, le pipeline compte combien de voxels ont chaque valeur de gris, sur le **niveau le plus grossier** (le plus rapide à lire). Les valeurs 0 à 255 sont réparties en **64 classes** de largeur 3,98.

![Les trois histogrammes stockés dans le manifeste du jeu de démonstration (échelle logarithmique : le fond à 0 écrase tout le reste en échelle linéaire).](img/ch08/histogrammes.png){width=96%}

Ils sont rangés dans `bricks/manifest.json` (`counts`, `edges`, `total`, `max`, `mean`, `std`) ; le viewer les affiche dans le panneau des canaux (chapitre 11). Pour une série temporelle, il y en a **un jeu par image**, car le photoblanchiment changerait l'échelle d'un jeu commun.

## 8.3 `metadata.json` : la carte d'identité du jeu de données

C'est le seul endroit où sont écrits les faits sur un jeu de données ; le catalogue du site est calculé à partir de lui à chaque requête. Extrait **réel** (abrégé) du jeu de démonstration :

```json
{
  "id": "3d/Embryo-E95-Em2-Pecam1-Sox2",
  "formatVersion": 4,
  "type": "3d",
  "stage": "E9.5", "stageNumeric": 9.5, "embryo": "Em2",
  "dimensions": { "x": 768, "y": 576, "z": 112, "c": 3, "t": 1 },
  "voxel_size": { "x": 1.2, "y": 1.2, "z": 3.0 },
  "calibrationStatus": "exact",
  "channels": [ { "name": "DAPI", "color": "#3D7BFF",
                  "min": 0.0, "max": 1.0, "gamma": 1.0 }, ... ],
  "description": "Confocal imaging stack: E9.5 fixed embryo, ...",
  "volumeSources": [ { "kind": "bricks", "multiscale": true, ... } ],
  "hidden": false
}
```

| champ | ce que c'est |
|---|---|
| `id`, `type` | le type (`3d` ou `live`) et le dossier : `3d/<nom>` |
| `formatVersion` | le format de données (chapitre 7) ; écrit par le pipeline, jamais édité à la main |
| `stage`, `embryo` | lus dans le nom du fichier (section suivante) |
| `dimensions`, `voxel_size` | taille en voxels et en micromètres, lue dans le fichier Imaris |
| `calibrationStatus` | `exact` si les trois tailles de voxel sont connues, sinon `metadata-missing` : aucune échelle n'est inventée |
| `channels` | nom, couleur, fenêtre (`min`, `max`) et gamma de départ de chaque canal |
| `volumeSources` | où le viewer trouve les briques |

::: note
Pour une série temporelle (`live`), le fichier contient aussi `timeline` (nombre d'images, intervalle, horodatages) et `intensityNormalization` (la fenêtre de normalisation commune à toute la série, et un niveau de signal par image pour mesurer le photoblanchiment).
:::

### Stade et embryon, lus dans le nom du fichier

Le nom du fichier `.ims` est **interprété**. Le stade est un jeton `E…` encadré de tirets, de soulignés ou d'espaces ; l'embryon est un jeton `Em<n>`, ou, à défaut, le nombre qui suit directement un stade entier.

| nom (extrait) | stade | embryon | à remarquer |
|---|---|---|---|
| `…-E8.5-…` ou `E8,5` | E8.5 | — | point ou virgule |
| `…-E8-5-…` | E8.5 | — | tiret : confirmé par le laboratoire |
| `…-E85-…` | E8.5 | — | forme compacte |
| `…-E105-…` | E10.5 | — | deux chiffres de jour si ça commence par 1 |
| `…-E95-Em2-…` | E9.5 | Em2 | embryon explicite |
| `…-E8-1-DAPI-…` | E8 | Em1 | `-1` n'est **pas** une fraction : après un tiret, seules .25, .5 et .75 en sont |
| `…-E95-1-…` | E9.5 | Em1 | le nombre après le stade |
| `Embryo-Pecam1` | inconnu | — | aucun jeton `E…` |

::: warning
Le jeton doit être encadré de tirets, de soulignés ou d'espaces : `-E85-Em1-` est lu correctement, `E85Em1` non. Si le stade est faux, corrigez-le dans l'onglet [Datasets]{.ui} : le pipeline le conservera aux passages suivants (section 8.7).
:::

## 8.4 Le suivi cellulaire (séries temporelles)

Pour une série temporelle seulement, le pipeline cherche une **analyse de suivi** (cellules, trajectoires, divisions) et l'attache au jeu de données. Il la cherche à trois endroits, du meilleur au moins bon.

![Les trois sources possibles, du fichier le plus complet au classeur le plus fragile.](img/ch08/sources-suivi.svg){width=100%}

::: why
**Pourquoi Scene8 passe avant Excel ?** Un classeur exporté peut être périmé : sur un jeu de données réel, il contenait 155 cellules alors que le volume en comptait 172. Les objets enregistrés dans le `.ims` sont toujours à jour. Le suivi est cherché automatiquement (option `--tracking auto`) ; si quelque chose échoue, le volume est publié quand même.
:::

Le suivi apporte trois fichiers ou blocs :

- **`tracks.json`** (et sa copie compressée `tracks.json.gz`) : pour chaque cellule, son identifiant, sa région, ses positions à chaque image en **µm** (stabilisées et brutes), ses marqueurs (rouge = division, noir = fusion), sa cellule-mère et ses filles ;
- **`model.glb`** : la **surface 3D** de l'embryon à chaque image, reconstruite à partir des cellules (au moins 4 par image) ;
- dans `metadata.json`, les blocs **`tracking`** (compte de cellules, régions, origine des données) et **`registration`** (la transformation de stabilisation, ci-dessous).

::: example
**Le jeu de démonstration en temps.** 50 cellules, 4 images, 3 régions (Posterior 18, Anterior 16, Lateral 16), 1 division et 0 fusion ; `model.glb` pèse 412 ko et `tracks.json` 32,7 ko. Les positions sont numérotées à partir de 1 (comme Imaris) et recalées sur les images du volume, numérotées à partir de 0 (décalage −1).
:::

### Stabiliser : annuler les mouvements de l'embryon

Pendant des heures, l'embryon dérive et tourne un peu dans le champ. Le pipeline **le remet dans la même position** à chaque image, afin que le mouvement visible soit celui des cellules et non celui de l'échantillon.

::: analogy
**Un calque transparent.** Dessinez les cellules de l'image 1 sur un calque, puis celles de l'image 4 sur un autre. Pour les superposer, vous faites glisser le calque et vous le faites pivoter, mais vous ne l'étirez jamais : c'est exactement un mouvement « rigide ».
:::

Sur le jeu de démonstration, voici la même idée avec les vraies cellules (47 cellules présentes aux images 1 et 4, projection sur le plan x-y).

![À gauche, les cellules de l'image 4 ont dérivé ; au centre, après rotation de 7,03 ° et translation, elles se superposent à l'image 1 ; à droite, les trajectoires brutes dérivent, les stabilisées restent en place.](img/ch08/kabsch.png){width=100%}

L'algorithme utilisé s'appelle **Kabsch** (décomposition en valeurs singulières). Il choisit des **cellules de référence** (celles qui ne se divisent pas, présentes à au moins deux images) et cherche, image après image, la rotation et la translation qui les superposent au mieux ; il en faut au moins 3 en commun.

::: tech
**Les maths.** Soient P les positions stabilisées de l'image n−1 et Q les positions brutes de l'image n (cellules de référence), centrées sur leurs centres de gravité *c<sub>P</sub>* et *c<sub>Q</sub>*. On forme H = Q<sub>c</sub><sup>T</sup> P<sub>c</sub>, on la décompose en H = U S V<sup>T</sup>, puis **R = V · diag(1, 1, signe(det(V U<sup>T</sup>))) · U<sup>T</sup>** (une vraie rotation, jamais un miroir) et **t = c<sub>P</sub> − R c<sub>Q</sub>**. La transformation (R, t) est appliquée à **toutes** les cellules de l'image n. La première image est la référence.
:::

### Le bloc `registration` : appliquer la même chose aux images

Le suivi est stabilisé, mais **pas les images**. Comme le mouvement est rigide, la même transformation permet au viewer de superposer les trajectoires aux images en déplaçant simplement les coordonnées de lecture, **sans rééchantillonner** un seul voxel. Pour chaque image, le fichier garde une matrice 4 × 4, l'angle et la translation :

| image | rotation | translation (µm) | résidu (µm) |
|---|---|---|---|
| 1 | 0° | (0 ; 0 ; 0) | 4 × 10⁻¹⁴ |
| 2 | 2,33° | (−5,65 ; 5,01 ; −0,37) | 6 × 10⁻¹⁴ |
| 3 | 4,66° | (−11,09 ; 10,60 ; −1,01) | 4 × 10⁻¹⁴ |
| 4 | 7,03° | (−16,14 ; 16,39 ; −1,79) | 8 × 10⁻¹⁴ |

::: remember
**Test de rigidité.** Le pipeline vérifie que la transformation est bien rigide : le plus grand résidu doit rester **≤ 0,05 µm**. Ici il vaut 7,6 × 10⁻¹⁴ µm (zéro, à l'erreur d'arrondi près), donc la stabilisation est appliquée aux images. Si le test échouait, un avertissement l'indiquerait et elle ne serait pas appliquée.
:::

## 8.5 Publier « tout ou rien »

Un traitement dure parfois des heures. Pendant ce temps, **le jeu de données déjà en ligne continue de fonctionner** : tout est construit dans un dossier de travail privé, au même endroit du disque que `DATA_WEB`, et n'est installé qu'à la fin.

::: analogy
**La vitrine d'un magasin.** On prépare la nouvelle vitrine dans l'arrière-boutique ; on n'enlève l'ancienne qu'une fois la nouvelle entièrement montée. Si un problème survient, les clients voient toujours l'ancienne.
:::

![Les cinq temps de la publication ; `metadata.json` est écrit en dernier, c'est le point de non-retour.](img/ch08/publication.svg){width=100%}

Un **nouveau** jeu de données arrive en un seul renommage de dossier. Pour un jeu **existant**, seuls les éléments du pipeline sont remplacés (`bricks/`, `planes/`, `mips/`, la vignette, et `tracks.json`, `tracks.json.gz`, `model.glb` si un nouveau suivi existe). Tout le reste du dossier, comme `download/` ou `gallery/`, n'est jamais touché.

## 8.6 Ce que le pipeline conserve quand on retraite un jeu de données

Vous avez corrigé un nom, orienté l'embryon, ajouté des légendes dans l'administration ? Un nouveau passage du pipeline **ne l'écrase pas** : il fusionne, juste avant l'installation, les champs saisis à la main dans le nouveau `metadata.json`.

- **Identité** : `name`, `description`, `stage`, `stageNumeric`, `embryo`, `line`, `staining`, `reporter`, `tags`, `notes`, `created` ;
- **Affichage** : `hidden`, `orientation`, `orientationAxes`, `upsideDown`, `defaultView`, `exposure` ;
- **Liens et images** : `gallery`, `linkedTrackingId`, `relatedIds`, et tout champ que le nouveau passage ne produit pas (par exemple `tracking`).

Les couleurs et réglages des canaux sont aussi conservés, tant que le **nombre de canaux** n'a pas changé. À l'inverse, `formatVersion` n'est **jamais** repris : il reflète toujours la structure réellement écrite sur le disque.

::: warning
Si un plantage survient pendant l'installation (coupure de courant), le marqueur `.swap-in-progress` permet au passage suivant de **finir ou d'annuler** proprement le changement. Ne supprimez pas ce fichier à la main.
:::

## 8.7 Le dossier `download/`

Avec l'option `--with-downloads`, le pipeline prépare, **après** la publication (un échec ici ne défait donc jamais le jeu de données), un dossier de fichiers à télécharger. Contenu réel du jeu de démonstration :

```
download/
├── Embryo-E95-Em2-Pecam1-Sox2.ims               255,8 Mo  l'original
├── Embryo-E95-Em2-Pecam1-Sox2.tif               254,6 Mo  composite ImageJ
├── Embryo-E95-Em2-Pecam1-Sox2_C1_DAPI_MIP.png     368 ko  un MIP par canal
├── …_C2_Pecam1_MIP.png  …_C3_Sox2_MIP.png
├── Embryo-E95-Em2-Pecam1-Sox2_web.zip            18,4 Mo  le jeu de données web
└── README.txt                                              provenance
```

- **L'original `.ims`** est un **lien physique** (« hard link ») : il apparaît dans `download/` sans occuper de place en plus ; il n'est jamais modifié.
- **Le `.tif`** est un composite pour ImageJ/Fiji au **format natif** (8 ou 16 bits, valeurs brutes), calibré en µm, avec les couleurs et la plage d'affichage de chaque canal. Il est tiré du niveau de résolution Imaris le plus proche de 2048 pixels.
- **Les MIP en PNG** donnent un aperçu par canal (normalisation entre les 1<sup>er</sup> et 99,9<sup>e</sup> centiles).
- **Le `_web.zip`** archive le dossier servi, sans recompression (WebP et PNG le sont déjà).
- **Le `README.txt`** rappelle dimensions, tailles de voxel, canaux et comment citer le jeu de données.

Pour une série temporelle, le `.tif` et les MIP ne montrent qu'**une image** (la première) ; le `.ims` les contient toutes.

## 8.8 Les photographies 2D, en une demi-page

Les photographies (stéréomicroscope, TIFF exporté depuis un fichier Leica) ont leur **propre outil**, `2d_importer.py` : un fichier TIFF donne un dossier `2d/<nom>/`.

| fichier | rôle | jeu de démonstration |
|---|---|---|
| `image.webp` | l'image en taille native | 1920 × 1440 px, 191 ko |
| `preview.webp` | aperçu de 640 px, affiché d'abord | 10,6 ko |
| `thumbnail.webp` | vignette 512 px | 12,8 ko |
| `metadata.json` | stade, ligne, date, taille de pixel (2,0 µm ici) | écrit en dernier |

::: why
**Pourquoi WebP « avec perte » par défaut ?** Il divise la taille par environ 40 par rapport au TIFF d'origine (8,3 Mo contre 191 ko ici), avec une qualité de 90. Mais le WebP avec perte **sous-échantillonne la couleur** (la chrominance est stockée avec moitié moins de pixels). Or l'isolement de la coloration X-gal du viewer lit le **rapport bleu/rouge** pixel par pixel : sur les contours nets, ce rapport est légèrement perturbé. L'option `--lossless` conserve chaque pixel exact, au prix de fichiers plus gros.
:::

La taille de pixel n'est lue que si le TIFF déclare une unité en microns ; sinon `pixelSizeUm` reste vide et le viewer n'affiche **ni échelle ni mesure**. Le stade, le zoom et la date de dissection sont lus dans le nom du fichier, avec le même lecteur de stade que les volumes.

## 8.9 Lancer tout cela : `RUN.bat`

Le **pack Pipeline** (un dossier à décompresser sur un PC Windows) contient tout. Double-cliquez sur `RUN.bat` : il vérifie l'intégrité du pack (empreintes SHA-256), prépare Python et les bibliothèques, puis affiche un menu.

![De votre ordinateur au site : on dépose les fichiers, on lance, puis on copie ou on glisse le résultat.](img/ch08/parcours-pipeline.svg){width=100%}

| choix | ce que fait le menu |
|---|---|
| `[1]` | Preprocessing de volumes Imaris (.ims → `output\`, suivi inclus) |
| `[2]` | Analyse de tracking Imaris (Excel → `tracking\OUTPUT\`) |
| `[3]` | Import de photographies 2D (.tif → `output\2d\`) |
| `[4]` | Attacher un tracking à un dataset déjà traité |
| `[5]` | Vérifier l'environnement seulement |
| `[0]` | Quitter |

Le menu pose quelques questions (dossier des `.ims`, dossier de sortie, archives de téléchargement ou non) puis lance `run_preprocess.py`. Vous pouvez aussi l'appeler vous-même :

```
python run_preprocess.py --input input --output DATA_WEB --only "*E95*" --with-downloads
```

| option | effet |
|---|---|
| `--input` | dossier des `.ims` (non récursif, un fichier à la fois) |
| `--output` | la racine `DATA_WEB` : le résultat va dans `3d/<nom>/` ou `live/<nom>/` |
| `--only` | filtre sur le nom des fichiers (ex. `"*E8*"`) |
| `--with-downloads` | prépare aussi le dossier `download/` (plus long) |
| `--tracking` | `auto` (défaut), `off`, ou le chemin d'un fichier de suivi |

Le type est décidé tout seul : plus d'une image dans le fichier, c'est `live`, sinon `3d`. `Ctrl+C` demande confirmation avant d'arrêter, et nettoie les fichiers temporaires.

### Comment le résultat arrive sur le serveur

- **Route A, par FTP** : copiez le dossier produit (`3d\<nom>` ou `live\<nom>`) dans le `DATA_WEB` du serveur. Il apparaît aussitôt dans le catalogue, il n'y a rien à régénérer.
- **Route B, sans FTP** : dans le panneau d'administration, ouvrez l'onglet [Import]{.ui} et glissez le dossier dans la zone [Glissez un dossier ici]{.ui}. Le transfert reprend là où il s'est arrêté si vous le relancez ; ensuite, cliquez sur [Publier]{.ui}.

::: warning
Un jeu de données publié par l'onglet [Import]{.ui} est **masqué par défaut** : allez dans l'onglet [Datasets]{.ui} et activez sa visibilité pour qu'il apparaisse dans l'explorateur public (chapitre 13).
:::

::: remember
- La vignette, les histogrammes et `metadata.json` décrivent le jeu de données ; le suivi cellulaire est une **couche** d'une série temporelle, stabilisée par un mouvement rigide.
- La publication est **tout ou rien**, et ce que vous avez corrigé à la main est conservé aux retraitements.
- `RUN.bat` → choix `[1]` → dossier `output\` → FTP ou onglet [Import]{.ui}.
:::
