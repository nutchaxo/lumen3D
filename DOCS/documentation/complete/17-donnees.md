# 17. Les données en profondeur : fichiers, formats, migrations, import

::: chapter-intro
- Un jeu de données est **un dossier** : chaque fichier a un auteur (le pipeline, l'opérateur ou la plateforme), une raison d'être et, le plus souvent, une empreinte qui permet de le contrôler.
- Il existe **quatre formats de données**. Une mise à jour de données passe de l'un à l'autre **sur place**, par petites unités notées dans un journal, avec un échange final atomique.
- L'import dans le navigateur envoie un dossier **bloc par bloc**, vérifié et reprenable, dans une zone privée ; les fichiers qui rendent le jeu ouvrable partent en premier.
:::

Les chapitres 7 et 8 ont montré **à quoi ressemblent** les briques, `planes/`, `mips/` et `metadata.json`. Le chapitre 14 a montré **où cliquer** dans l'administration. Ce chapitre ouvre le capot : il dit **exactement** ce que contient chaque fichier, qui l'écrit, comment il change de format et comment il arrive sur le serveur.

![La carte du chapitre : trois parties, dix-huit sections.](img/ch17/carte-chapitre.svg){width=100%}

::: note
Tous les exemples chiffrés viennent des **jeux de démonstration** (synthétiques, produits par le vrai pipeline) ou d'**essais réels** faits sur des jeux de test dans un dossier temporaire. Aucune donnée du laboratoire n'est montrée.
:::

# Partie A. Les fichiers

## 17.1 Un jeu de données, un dossier : les trois arbres {.page}

Un jeu de données vit dans `DATA_WEB/<type>/<dossier>/`. Le **type** (`3d`, `2d` ou `live`) est le nom du dossier parent ; le dossier lui-même est l'identifiant du jeu : `3d/Embryo-E95-Em2-Pecam1-Sox2`.

::: analogy
**Une valise de voyage.** On l'ouvre et chaque objet a sa place : la fiche d'identité (`metadata.json`), la photo d'identité (la vignette), le contenu (les briques) et des souvenirs à emporter (`download/`). Les pastilles de couleur des figures disent **qui a rangé** quoi dans la valise.
:::

![L'arbre d'un jeu 3D : de la fiche d'identité aux briques, planes, mips et téléchargements.](img/ch17/arbre-3d.svg){width=100%}

Trois choses à remarquer dans cet arbre :

- les dossiers `bricks/`, `planes/` et `mips/` portent **une pastille bleue et une verte** : le pipeline les écrit directement (format 4) ou la plateforme les a construits par une migration (section 17.8) ;
- `gallery/` n'existe que si l'opérateur a joint des images ;
- tout `DATA_WEB/` est servi tel quel, sauf `download/` qui est **toujours** servi en pièce jointe (section 17.6).

![L'arbre d'une série temporelle : un arbre de briques par image, le suivi à la racine.](img/ch17/arbre-live.svg){width=100%}

Dans une série `live`, **chaque image** a son propre arbre : `bricks/t000/`, `bricks/t001/`… avec son `index.bin`. Les dossiers `planes/` et `mips/` suivent le même découpage (`planes/t000/`, `mips/t000/`). Le suivi cellulaire (`tracks.json`, `model.glb`) est à la racine du jeu : il décrit toute la série.

![L'arbre d'une photographie 2D : trois copies d'une image et une carte d'identité.](img/ch17/arbre-2d.svg){width=100%}

Une photographie 2D n'a ni briques ni canaux. Le fichier `image.webp` est la copie d'affichage ; le TIFF d'origine reste intact dans `download/` (c'est un lien physique : il n'occupe pas de place en double).

### Les dossiers de chantier

Pendant une opération, la plateforme construit **à côté** du jeu, puis échange. Ces dossiers temporaires portent un nom reconnaissable ; un dossier dont le nom commence par un point n'est **jamais** listé dans le catalogue.

| Nom | Créé par | Disparaît quand |
|---|---|---|
| `.planes-incoming/`, `.mips-incoming/`, `.bricks-incoming/` | une migration (assemblage) | l'échange est fait |
| `.planes-old/`, `.mips-old/`, `bricks.v2-old/` | une migration (ancien état mis de côté) | la version est montée |
| `.incoming-<jeu>-<date>/` | l'import (copie entre deux disques) | le renommage final, ou au démarrage suivant |
| `.replaced-<jeu>-<date>/` | l'import (ancien jeu remplacé) | la publication est terminée |
| `.swap-in-progress` | le pipeline (installation d'un nouveau passage) | l'installation est terminée |
| `.lumen-tmp-*` | toute écriture « tout ou rien » d'un fichier | le renommage final |

::: remember
Un fichier n'est jamais écrit « sur place » : on écrit un fichier temporaire voisin, puis on le **renomme**. Un renommage est atomique : le visiteur voit l'ancien fichier ou le nouveau, jamais la moitié de chacun.
:::

## 17.2 Qui écrit quoi : trois auteurs

Un même `metadata.json` est touché par trois auteurs. Pour que chacun respecte le travail des autres, **chaque champ a un propriétaire**.

![Le pipeline mesure, l'opérateur règle, la plateforme pose ; deux règles de fusion.](img/ch17/qui-ecrit.svg){width=100%}

### Le pipeline mesure

Le pipeline écrit tout ce qui se **mesure** dans l'acquisition : dimensions, tailles de voxel, canaux de départ, sources de volume, et pour une série : `timeline`, `intensityNormalization`, `tracking`, `registration`. Il écrit aussi la valeur de départ de champs que l'opérateur pourra corriger (nom, stade, description).

### L'opérateur règle

L'éditeur de l'administration (chapitre 14, section 14.4) envoie les champs qu'il modifie. Le serveur les **fusionne** dans le fichier existant, sous un verrou, puis impose lui-même `id`, `type`, `folderName`, `configured` et `lastModified`. La galerie est **réconciliée** avec le dossier `gallery/` : l'envoi décide de l'ordre et des légendes, le dossier décide des fichiers qui existent.

### Les vingt clés « curées »

Quand un jeu est **refait** ou **remplacé**, une liste fixe de vingt clés est protégée, dans le pipeline comme dans l'import (`CURATED_KEYS`) :

| Famille | Clés |
|---|---|
| Identité | `name`, `description`, `stage`, `stageNumeric`, `embryo`, `line`, `staining`, `reporter`, `tags`, `notes`, `created` |
| Affichage | `hidden`, `orientation`, `orientationAxes`, `upsideDown`, `defaultView`, `exposure` |
| Liens et images | `gallery`, `linkedTrackingId`, `relatedIds` |

### Deux directions de fusion

La protection ne marche pas pareil dans les deux cas, et c'est un détail qui compte.

| Situation | Qui gagne | Conséquence |
|---|---|---|
| Le **pipeline refait** un jeu publié | l'**ancien** fichier, pour les 20 clés curées | votre nom corrigé, votre orientation et votre galerie survivent |
| L'**import remplace** un jeu publié | le **nouveau** fichier ; une clé curée n'est reprise **que si le nouveau ne la contient pas** | `orientation` et `gallery` survivent ; un `name` que le nouveau fichier énonce **gagne** |

::: example
**Un essai réel** (moteur d'import, dossier temporaire). Un jeu publié a été édité : `orientation`, une galerie, un nom corrigé. On remplace par le dossier du pipeline. La réponse du serveur : `carriedKeys = [gallery, orientation]` et `carriedGallery = true`. Le nom, lui, est **revenu à celui du pipeline** : le nouveau `metadata.json` le contient, donc il l'emporte. Et `formatVersion` vaut **4** (celui du nouveau fichier), jamais l'ancien chiffre.
:::

::: warning
`formatVersion` n'est **jamais** repris de l'ancien fichier, dans aucun des deux cas : il décrit ce qui est réellement sur le disque.
:::

## 17.3 `metadata.json`, champ par champ

![Les blocs d'un metadata.json : le même squelette, trois formes.](img/ch17/metadata-blocs.svg){width=100%}

Les tableaux qui suivent donnent, pour chaque champ, **ce qu'il veut dire** (avec la valeur réelle du jeu de démonstration) et **qui l'écrit**.

### Identité et état

| Champ | Ce que c'est | Écrit par |
|---|---|---|
| `id` | `"3d/Embryo-E95-Em2-Pecam1-Sox2"` : type et dossier | pipeline ; **imposé** à chaque enregistrement |
| `type` | `3d`, `2d` ou `live` ; toujours égal au dossier parent | pipeline ; imposé |
| `name` | nom affiché | pipeline (nom du dossier) puis opérateur |
| `folderName` | nom du dossier | pipeline ; imposé |
| `stage`, `stageNumeric` | `"E9.5"` et `9.5`, lus dans le nom (chapitre 8) | pipeline ; l'éditeur recalcule `stageNumeric` quand vous changez `stage` |
| `embryo` | `"Em2"` | pipeline ; opérateur |
| `description` | phrase de départ, par exemple « Confocal imaging stack: E9.5 fixed embryo, 112 slices, 3 channels. » | pipeline ; opérateur |
| `created`, `lastModified` | dates ISO ; `created` est protégée ; `lastModified` est remise à jour à chaque enregistrement | pipeline ; plateforme |
| `configured` | `true` ; sert à décider si le jeu entre au catalogue (section 17.5) | pipeline ; imposé |
| `formatVersion` | `4` ; absent = 1 | pipeline, ou fin d'une migration |
| `hidden` | `true` = invisible du public, visible de l'administration | opérateur ; **l'import publie toujours masqué** |

### Géométrie et calibration

| Champ | Ce que c'est | Écrit par |
|---|---|---|
| `dimensions` | `{x:768, y:576, z:112, c:3, t:1}` : voxels en X, Y, Z, nombre de canaux, nombre d'images | pipeline |
| `voxel_size` | `{x:1.2, y:1.2, z:3.0}` en µm | pipeline ; l'opérateur peut la corriger à la main |
| `physicalSizeUm` | `{x:921.6, y:691.2, z:336.0, sliceThickness:3.0, voxelX, voxelY, voxelZ}` : étendue réelle en µm | pipeline |
| `optical_section_thickness_um` | `3.0` : épaisseur de coupe, déclarée **égale au pas en Z** | pipeline |
| `acquisitionExtentUm` | `{unit:"um", min:[0,0,0], max:[921.6,691.2,336]}` : la boîte d'acquisition, dans le repère d'Imaris | pipeline |
| `calibrationStatus`, `calibrationNote` | `exact` ou `metadata-missing`, avec une phrase d'explication | pipeline |

::: tech
**Pourquoi déclarer `sliceThickness` égal au pas en Z ?** Le viewer modélise la profondeur comme (D − 1) pas plus une épaisseur de coupe. Sans valeur explicite, il devine `min(pas Z, voxel X)`, ce qui sous-estime la profondeur d'un empilement anisotrope (329,50 µm au lieu des 333,87 µm qu'Imaris déclare). Or tout ce qui est enregistré dans les coordonnées d'Imaris (les cellules suivies) doit retomber sur les bons voxels.
:::

Le **statut de calibration** a deux vocabulaires : le pipeline n'écrit que `exact` ou `metadata-missing` ; le viewer recalcule son propre statut à partir de ce qu'il reçoit (`exact` seulement si une épaisseur de coupe est présente, sinon `estimated` ou `metadata-missing`, chapitre 9).

### Canaux et sources

| Champ | Ce que c'est | Écrit par |
|---|---|---|
| `channels[]` | `{name:"DAPI", color:"#3D7BFF", min:0.0, max:1.0, gamma:1.0}` ; l'éditeur y ajoute `active` | pipeline (valeurs de départ), puis opérateur |
| `volumeSources[]` | `{kind:"bricks", label, priority:-1, available:true, multiscale:true, path, manifestPath}` : où le viewer trouve les briques ; les genres connus sont `bricks` et `webstack` | pipeline |
| `thumbnail` | chemin de la vignette, ou `null` ; le catalogue le **recalcule** d'après l'existence du fichier | pipeline |

Les réglages de canal sont conservés quand un jeu est refait **tant que le nombre de canaux n'a pas changé** : avec un autre jeu de canaux, les anciens réglages appartiendraient à d'autres données.

### Réglages de l'opérateur

| Champ | Ce que c'est | Écrit par |
|---|---|---|
| `exposure` | multiplicateur d'exposition à l'ouverture (le curseur va de 20 % à 500 %, soit 0,2 à 5) | opérateur |
| `orientation` | quaternion `Q_base` : il fait passer des axes du fichier à l'anatomie (chapitre 12) | opérateur, via l'outil d'orientation |
| `orientationAxes` | `{labels:{A:"Rostral"}, hidden:["D"], defaultView:{preset, quaternion}}` : noms des bras, bras masqués, vue par défaut | opérateur |
| `upsideDown` | `true` si le fichier brut montre l'échantillon par en dessous | opérateur ([Face de l'échantillon]{.ui}) |
| `gallery[]` | `[{file, added, thumb, title, caption}]` | opérateur ; la plateforme crée la vignette |
| `relatedIds`, `linkedTrackingId` | liens entre jeux, saisis à la main ; la conversion du vocabulaire (section 17.5) les réécrit | opérateur |
| `line`, `staining`, `reporter`, `tags`, `notes` | informations libres ; `line` et `staining` sont posés par l'importeur de photographies | importeur 2D, opérateur |

### Ce qu'une série `live` ajoute

| Bloc | Contenu réel du jeu de démonstration |
|---|---|
| `timeline` | `{count:4, intervalMinutes:30.0, timestamps:["2026-05-12T09:00:00", …]}` |
| `intensityNormalization` | `{mode:"global", bounds:{c0:{bgFloor, sigMax}, c1:{…}}, signalLevels:{"t000_c0":33107.0, …}}` : la fenêtre commune de toute la série et un niveau de signal par image et par canal |
| `tracking` | `{schema:"iribhm-tracks-v1", source, tracksPath:"tracks.json", surfacePath:"model.glb", surfaceOrigin:"reconstructed", cellCount:50, timepointCount:4, mitosisCount:1, fusionCount:0, regions:[{name, cells, color}], boundsUm:{stabilized, raw}, provenance:{…}, alignment:{…}}` |
| `registration` | `{method:"tracking-procrustes", coordinateSpace:"acquisition-um", timepointOffset:-1, appliedToVolume:true, transforms:[…], qcSummary:{…}, imageBoxUnionUm:{…}}` |

::: note
**À propos de `intensityNormalization`.** Le pipeline enregistre ces niveaux « pour qu'un réglage facultatif puisse un jour compenser le photoblanchiment ». **Aucun réglage du viewer ne les lit encore** : une série dont le signal s'éteint s'affiche réellement plus sombre.
:::

Le bloc `tracking` a trois sous-blocs utiles :

- `provenance` : d'où viennent les pistes (`kind: "scene8"` = les objets Imaris à l'intérieur du `.ims`, ou `excel` = un classeur exporté), le nombre de points (`spots: 194`) et de pistes (`tracks: 48`), l'unité déclarée et sa conversion en µm (`toUm: 1.0`, `status: "native"`), le rayon des sphères, l'outil d'extraction ;
- `alignment` : le contrôle fait à l'import — `insideAcquisitionBox: 1.0` (100 % des positions tombent dans la boîte du volume), `spanRatio`, `aligned: true` ;
- `surfaceOrigin` : `exported` si le fichier `.glb` vient du logiciel de suivi, `reconstructed` si la plateforme l'a reconstruit à partir des cellules.

Le bloc `registration` dit **si la stabilisation peut être appliquée à l'image** : `appliedToVolume: true` seulement si l'ajustement des pistes est **rigide** (résidu ≤ 0,05 µm ; ici 7,6 × 10⁻¹⁴ µm). Chaque `transforms[]` donne la matrice 4 × 4 (colonne par colonne, pour `THREE.Matrix4.fromArray`), l'angle (`rotationDeg: 7.0317` à la dernière image) et le déplacement en µm. Le chapitre 8 explique le calcul ; le chapitre 12 montre ce que le viewer en fait.

### Ce qu'une photographie `2d` change

| Champ | Ce que c'est |
|---|---|
| `dimensions` | `{x:1920, y:1440, z:1, c:3, t:1}` : trois canaux couleur, jamais de profondeur |
| `pixelSizeUm`, `physicalSizeUm` | `{x:2.0, y:2.0}` µm par pixel et `{x:3840, y:2880}` µm : lus dans les balises de résolution du TIFF |
| `image` | `{native:"image.webp", width, height, preview:"preview.webp", previewWidth:640, previewHeight:480}` : noms de fichiers **fixes**, l'import les exige tels quels |
| `acquisition` | `{modality:"brightfield-stereo", sourceFile, series, dissectionDate, zoomNominal:3.2…}` : lu dans le nom du fichier et le bloc Leica |
| `line`, `staining`, `date` | `"DLL4xCD1"`, `"X-gal"`, `"2024-09-13"` |
| `orientation2d` | `{rotationDeg, flipH}` : posé par l'opérateur avec l'outil d'orientation 2D |
| `channels` | `[]` : une photographie n'a pas de canaux |

## 17.4 Les manifestes et les fichiers de description

### `bricks/manifest.json` (format 4)

C'est la table des matières des briques. Voici **tous** ses champs, avec les valeurs du jeu de démonstration 3D.

| Champ | Ce que c'est |
|---|---|
| `schema`, `version`, `formatVersion` | `"iribhm-bricks-v3"`, `3`, `4` : le lecteur choisit sa méthode d'après `schema` |
| `dataset` | nom du jeu |
| `channels` | `3` |
| `brickSize`, `apron` | `64` et `1` : cœur de 64 voxels, bordure d'un voxel (brique stockée : 66³) |
| `brickPacking` | `{mode:"grid", cols:9, rows:8, slice:66}` : la mosaïque de 66 coupes de 66² |
| `encoding` | `"webp-lossless"` |
| `levels[]` | `{level, dimensions, voxelSize, gridSize, brickCount}` par niveau ; ex. niveau 0 : `768×576×112`, voxel `1.2×1.2×3.0`, grille `12×9×2`, `269` briques présentes |
| `timepoints` | `null` pour un jeu 3D ; pour une série, une liste `[{path:"t000", index:{url, bytes, sha256}}, …]` |
| `index` | `{url:"index.bin", bytes:7846, sha256:"aea0980…"}` ; **absent** pour une série (chaque image porte le sien) |
| `histograms[]` | par canal : `counts` (64 cases), `edges` (65 bornes), `total`, `max`, `mean`, `std`, `backgroundFloor` |
| `timepointHistograms` | pour une série : les mêmes histogrammes, image par image |
| `producer`, `createdAt` | `"pipeline"` (ou un exécutant de migration) et la date |

::: tech
**Les histogrammes sont calculés sur le niveau le plus grossier** (ici `total: 96768` = 96 × 72 × 14 voxels). `backgroundFloor` vaut toujours `0` dans le fichier : c'est le viewer qui estime lui-même le plancher de bruit (chapitre 11).
:::

![Qui garantit quoi : l'empreinte du manifeste signe les plans et les MIP, celle de l'index signe les paquets.](img/ch17/empreintes.svg){width=100%}

### `index.bin`

L'index est expliqué octet par octet au chapitre 7 (section 7.6). Trois compléments :

- sa **taille est prévisible** : `12 + 16 × (nombre de niveaux) + 10 × (canaux) × (somme des cases de grille)`. Pour le jeu 3D : 12 + 16 × 4 + 10 × 3 × 259 = **7 846 octets**, exactement ce que dit le manifeste ;
- les paquets sont nommés **sans chaîne dans l'index** : le paquet *p* du niveau *k* et du canal *c* s'appelle `l{k}/c{c}/p{p:05d}.bin` ;
- l'import contrôle la longueur **exacte**, l'empreinte et la cohérence avec les niveaux du manifeste (section 17.18).

### `planes/manifest.json` et `mips/manifest.json`

Les deux ont la même forme ; `mips/` ajoute deux champs.

| Champ | Valeur réelle (`planes/`) | Sens |
|---|---|---|
| `schema` | `"lumen-planes-v1"` (`"lumen-mips-v1"`) | |
| `formatVersion` | `2` (`3`) | le format qui a introduit la structure |
| `level` | `0` | toujours le niveau natif |
| `dimensions`, `channels` | `{768, 576, 112}`, `3` | égaux à ceux des briques |
| `tileSize`, `tiles` | `512`, `{x:2, y:2}` | tuiles de 512² : 768 = 512 + 256, 576 = 512 + 64 |
| `codec` | `"png-gray8"` | PNG gris 8 bits, filtre « None » |
| `packPattern`, `headerBytes` | `"z{z}.bin"` (`"l{l}.bin"`), `160` | `16 + 12 × canaux × tuiles Y × tuiles X` |
| `layers`, `layerDepth` | (mips) `2`, `64` | une projection par couche de 64 plans |
| `source.manifestSha256` | `"6557d1fe…"` | empreinte du manifeste des briques d'où ils viennent |
| `producer`, `createdAt` | `"pipeline"` | `"pipeline"`, `"migration-browser"`, `"migration-server"` ou `"mixed"` |

![Un fichier plan réel, octet par octet : l'en-tête, la table de 12 entrées, puis des PNG.](img/ch17/pack-planes.svg){width=100%}

Un fichier `MIP` (signature `LMIP`) a **exactement la même disposition** qu'un fichier plan : le champ « z » de l'en-tête y est l'indice de la couche.

### Les briques « v2 » en cinq lignes

Avant le format 4, `bricks/manifest.json` listait **chaque brique** dans `brickTransport.brickToPack` : une clé `lod0/c0/x000_y000_z000.webp` pour une entrée `{url:"lod0/c0/pack_00.bin", offset, length}`. Les briques faisaient 64³ sans bordure, rangées en mosaïque 8 × 8 (image 512²) ; les paquets s'appelaient `lodN/cC/pack_NN.bin` ; une série avait un dictionnaire `timepoints` plutôt qu'une liste. Les migrations de la partie B transforment ces fichiers en leur équivalent moderne.

### `tracks.json`

Le suivi d'une série est dans un fichier à part (`tracks.json`, et sa copie compressée `tracks.json.gz`). Structure réelle du jeu de démonstration :

| Clé | Contenu |
|---|---|
| `schema`, `source`, `sourceId`, `generated` | `"iribhm-tracks-v1"`, nom de la source, identifiant unique, date |
| `timepoints` | `[1.0, 2.0, 3.0, 4.0]` : les numéros d'image (Imaris compte à partir de 1) |
| `cells` | un objet par cellule, indexé par son numéro (50 cellules) |
| `layout` | `{x_range, y_range, z_range}` : l'étendue des positions stabilisées |

Une cellule (la 23, qui se divise) :

```json
{ "id": "23", "track_id": 1000000023, "region": "Posterior", "color": "#2ecc71",
  "positions": { "1": [119.6, 121.3, 69.5], "2": [119.4, 121.9, 68.6] },
  "raw_positions": { "1": [119.6, 121.3, 69.5], "2": [120.3, 121.6, 69.4] },
  "parent": "", "daughters": ["24", "25"],
  "is_mitosis": true, "is_fusion": false, "markers": { "2": "red" } }
```

`positions` sont les coordonnées **stabilisées** en µm, `raw_positions` les coordonnées d'acquisition ; `parent` et `daughters` forment la **généalogie** (une mitose : une mère, deux filles qui partagent le même `track_id`). Le viewer charge ce fichier dans un Web Worker qui en fait des tableaux 32 bits compacts.

## 17.5 Le catalogue et le vocabulaire des types {.page}

### Un catalogue qui n'est pas un fichier

La liste des jeux que voit le public (`/DATA_WEB/catalog.json`) n'est **stockée nulle part** : elle est calculée à chaque requête à partir des `metadata.json`.

![Le catalogue est calculé à la demande, avec une signature faite de stat() pour rester rapide.](img/ch17/catalogue.svg){width=100%}

Les règles exactes de la construction :

- un dossier dont le nom commence par un point n'est **jamais** un jeu (c'est un chantier) ;
- un dossier **sans** `metadata.json` (traitement en cours) donne une ligne « non configurée », sans vignette — donc absente du catalogue public ;
- `id`, `path`, `type`, `folderName` sont **imposés** d'après l'emplacement ; `thumbnail` est le fichier s'il existe, `null` sinon ;
- on garde les jeux **configurés ou vignettés**, et **non masqués** ;
- l'ordre met la date la plus récente d'abord ; les jeux sans date (les volumes en ont rarement) viennent ensuite, par nom décroissant.

::: why
**Pourquoi pas un fichier ?** Autrefois, le catalogue était un fichier que seul le panneau d'administration réécrivait : un jeu copié par SFTP restait invisible jusqu'à un clic sur un bouton de régénération. Maintenant le catalogue **n'a aucune information propre** : rien à tenir à jour, donc rien à oublier.
:::

### Un vocabulaire, trois mots

Depuis la version 1.51.0, un type de jeu s'écrit **`3d`**, **`2d`** ou **`live`**, et ce même mot est à la fois le dossier sous `DATA_WEB/`, le début de l'identifiant, le champ `type`, la valeur d'un filtre d'URL… Les anciens mots (`fixed`, `wholemount`, `tracking`) n'existent plus nulle part dans le code.

![La conversion du vocabulaire : faite une fois au démarrage, par les deux serveurs.](img/ch17/migration-types.svg){width=100%}

Un déploiement ancien est converti **une seule fois**, par une passe **idempotente** (la rejouer ne change rien) lancée au démarrage de chaque serveur. Elle ne laisse **aucun marqueur** : quelques tests d'existence de dossier suffisent à savoir qu'il n'y a plus rien à faire.

::: tech
**Une passe tourne à chaque démarrage.** La réparation de l'identité d'un `metadata.json` dont `type` ou `id` contredit son dossier. Elle existe parce qu'un hébergeur PHP avait écrit, avant la 1.54.1, la charge de l'éditeur (qui ne contient pas `type`) en remplacement du fichier. Elle ne réécrit que les fichiers incohérents.
:::

Ce que **voit** l'opérateur n'est jamais le mot technique : les noms affichés (« 3D », « Photo », « Live »…) viennent de la configuration du site (chapitre 16).

## 17.6 `download/` et `gallery/`

### `download/` : les souvenirs à emporter

Ce dossier est rempli par le pipeline (option `--with-downloads`, chapitre 8). Trois règles de la plateforme le concernent :

- **tout** ce qu'il contient est servi **en pièce jointe** : un rapport HTML ou XML déposé là ne s'affiche jamais comme une page de votre site ;
- il est **exclu** des mises à jour de la plateforme et des migrations de données : on n'y touche jamais ;
- l'import n'y accepte que des extensions **de données** : `ims tif tiff png jpg jpeg webp gif zip txt md csv json pdf gz h5 hdf5`.

### `gallery/` : les images jointes

L'opérateur peut joindre des images à un jeu (captures annotées, figures). Elles vivent **dans** le dossier du jeu, pour voyager avec lui.

| Règle | Valeur |
|---|---|
| Nombre maximal | **40** images par jeu |
| Taille maximale | **8 Mio** par image |
| Formats | WebP, PNG, JPEG, GIF ; l'extension est déduite des **octets magiques**, jamais du nom envoyé |
| Vignettes | `gallery/thumbs/<fichier>.webp` (320 px au plus, jamais agrandie) pour la grille ; la visionneuse charge l'original |
| Ordre et légendes | dans `metadata.json`, clé `gallery` : `{file, added, thumb, title, caption}` |
| Légende | 400 caractères au plus ; titre 120 |

Un fichier nommé `a.php.png` dont les octets ne sont pas ceux d'un PNG est **refusé** : seuls les octets comptent.

::: warning
La galerie **ne voyage pas** avec l'import (aucune règle de la liste blanche ne l'accepte). Quand un jeu est remplacé, c'est la plateforme qui **déplace** la galerie de l'ancien dossier vers le nouveau (section 17.18).
:::

# Partie B. Les formats et les migrations

## 17.7 Les formats 1 à 4 {.page}

Un jeu publié porte un numéro de **format** (`formatVersion`). Le visiteur n'a rien à faire : le viewer lit les quatre formats. Mais les formats récents ouvrent des possibilités que les anciens n'ont pas.

![Quatre marches : chacune ajoute une structure ; une migration sait y monter.](img/ch17/formats-escalier.svg){width=100%}

Ce que débloque chaque marche :

| Format | Ce qu'il permet | Où c'est expliqué |
|---|---|---|
| 2 (`planes/`) | une coupe XY **native** du Studio lit un plan au lieu d'une couche de 64 ; les figures z-stack s'ouvrent vite | chapitres 7 et 12 |
| 3 (`mips/`) | une projection maximale de toute la pile lit une image par couche | chapitre 7 |
| 4 (briques v3) | filtrage **sans couture** entre briques, **détail local** (« Zoom detail »), atlas plus légers pour 1 ou 2 canaux, niveaux de qualité exacts | chapitres 9 et 10 |

### Ce qu'un numéro de format promet

Un jeu **ne déclare jamais une structure qu'il n'a pas**. Le pipeline écrit le plus haut format dont **toutes** les structures sont complètes sur le disque (chaque arbre d'une série compris) ; la plateforme fait de même. Si un jeu dit « format 3 » mais que `mips/` est abîmé, l'onglet [Mises à jour des données]{.ui} le propose en **réparation**.

### Une brique v2 et une brique v3

![Ce que change la migration m004, point par point.](img/ch17/v2-v3.svg){width=100%}

### Quand un niveau réduit-il aussi Z ?

Dans l'ancien format, on réduisait surtout en XY. Le format 4 applique une règle précise : le niveau natif est copié **tel quel**, puis chaque niveau divise X et Y par 2 ; il divise **aussi Z** seulement si le voxel n'est pas déjà bien plus épais en Z qu'en XY (`vz ≤ 1,5 × vxy` du niveau suivant).

![La règle de réduction en Z, sur le jeu de démonstration et sur un gros embryon anisotrope.](img/ch17/niveaux-z.svg){width=100%}

::: example
**Le gros embryon (3789 × 3789 × 257, voxel 0,43 × 0,43 × 2,06 µm).** Niveau 1 : 0,86 µm en XY ; 2,06 > 1,5 × 0,86 = 1,29, donc Z est **gardé**. Niveau 2 : 1,72 µm en XY ; 2,06 ≤ 1,5 × 1,72 = 2,58, donc Z est **réduit** (129 plans). Six niveaux au total, jusqu'à 119 × 119 × 17.
:::

La réduction est une **moyenne entière**, arrondie au plus proche (la moitié vers le haut) : `(somme + n/2) // n`. La même arithmétique est utilisée par le pipeline, Python, PHP et le navigateur : c'est ce qui rend leurs résultats **identiques voxel pour voxel**.

## 17.8 Trois migrations, un registre

Une **migration** transforme un jeu de la version *v* à la version *v + 1*. Les trois migrations forment un **registre ordonné**, identique dans trois langages.

| Identifiant | De → vers | Ce qu'elle crée | S'applique à |
|---|---|---|---|
| `m002-planes` | 1 → 2 | `planes/` : le niveau natif recoupé en plans XY | `3d`, `live` |
| `m003-layer-mips` | 2 → 3 | `mips/` : le maximum de chaque couche de 64 plans | `3d`, `live` |
| `m004-bricks-v3` | 3 → 4 | un nouvel arbre `bricks/` (66³, index binaire) | `3d`, `live` |

Chaque entrée porte un identifiant, les versions, les types concernés et un **titre et une description en quatre langues** (c'est ce que l'onglet affiche).

::: tech
**Les trois jumeaux.** Le registre existe en Python (`dataset_migrations.py`), en PHP (`api/_migrations_lib.php`, `_migrations_formats.php`, route `api/migrations.php`) et dans le navigateur (un module par migration : `js/migrations/m002-planes.js`…). Le **contrat** commun, y compris chaque octet des formats, est la spécification `DOCS/dataset-migrations/SPEC.md`. Ajouter une migration = ajouter une entrée dans les trois jumeaux, son découpage en unités, ses deux exécutants et un module navigateur ; rien d'autre ne change.
:::

### Quel jeu a besoin de quoi ?

Un jeu à la version *v* reçoit **dans l'ordre** toutes les migrations dont le « de » est ≥ *v* ; une migration ne s'applique que si le jeu est **exactement** à sa version de départ. Un jeu au format 1 reçoit donc m002, puis m003, puis m004.

L'onglet décide ainsi, pour chaque jeu **publié** de type `3d` ou `live` (les photographies 2D sont toujours « à jour » ; un jeu encore en import n'est pas concerné) :

| Constat | Ce que l'onglet propose |
|---|---|
| `formatVersion` plus bas que le courant | les migrations manquantes, dans l'ordre |
| la version annonce une structure absente ou invalide (`planes/` manquant, `mips/` abîmé…) | une **réparation** : on refait la migration qui produit cette structure |
| version 4 mais briques v3 abîmées | un **problème** (`bricks_v3_invalid`), pas une réparation : l'ancien arbre n'existe plus |
| manifeste illisible ou absent (`manifest_invalid`, `no_manifest`) | un problème signalé sur la ligne du jeu |
| série dont les images n'ont pas toutes les mêmes dimensions | refus (`trees_differ`) : m004 ne sait pas la convertir |

Avant de commencer, le serveur **refuse un travail que le disque ne peut pas contenir** (erreur 507, comme l'import) : il estime la place du résultat — environ 1,3 fois le niveau natif pour `planes/`, 5 % de la taille de `planes/` pour `mips/`, environ 1,3 fois l'ancienne pyramide pour les briques v3 — et exige qu'elle tienne à la fois dans le magasin de travail et à côté du jeu (deux fois sur un même disque), avec une réserve de 512 Mio.

### Un essai réel de bout en bout

Pour vérifier chaque affirmation de ce chapitre, un jeu **synthétique de format 1** (520 × 520 × 130 voxels, 2 canaux, du bruit aléatoire) a été converti par le vrai moteur Python, dans un dossier temporaire.

| Étape | Unités | Durée | Taille avant → après |
|---|---|---|---|
| m002 → format 2 | 24 (dont 1 vide) | 2,4 s | `planes/` : 42,0 Mo (les briques : 40,1 Mo) |
| m003 → format 3 | 24 (dont 1 vide) | 0,6 s | `mips/` : 0,70 Mo |
| m004 → format 4 | 30 | 16,3 s | `bricks/` : 40,1 Mo → 48,9 Mo |

::: warning
Ces tailles ne sont **pas représentatives** : le bruit aléatoire est incompressible, et le format 4 ajoute 9,7 % de bordure. Sur de vraies images (surtout du noir, du signal lisse), la pyramide v3 est en général plus légère. Retenez les **unités** et la **mécanique**, pas les mégaoctets.
:::

## 17.9 Les unités de travail et le journal {.page}

Convertir un jeu de 10 Go d'un seul tenant échouerait au premier incident. La plateforme le découpe donc en **unités** indépendantes.

![Une unité = une couche de 64 plans, un canal, une tuile de 512² : ici, les 24 unités du jeu de démonstration.](img/ch17/unites.svg){width=100%}

Pour m002, une unité traite **une couche de briques** (au plus 64 plans en Z), **un canal** et **une tuile** de 512 × 512 pixels (= 8 × 8 briques) : elle décode les briques correspondantes puis émet jusqu'à 64 tuiles PNG, une par plan.

::: example
**Les 24 unités du jeu 3D de démonstration.** 112 plans = 2 couches (64 + 48) ; 768 × 576 pixels = 2 × 2 tuiles ; 3 canaux. 2 × 3 × 4 = **24 unités**. Pour le jeu `live` : 4 images × 1 couche × 2 canaux × 1 tuile = **8 unités**.
:::

Les trois migrations n'ont pas la même forme d'unité :

| Migration | Clé d'unité | Ce que fait l'unité |
|---|---|---|
| m002 | `t{t}.z{bz}.c{c}.y{ty}.x{tx}` | décode les briques d'une couche, produit des tuiles PNG |
| m003 | `t{t}.l{l}.c{c}.y{ty}.x{tx}` | lit les ≤ 64 tuiles de plan d'une couche, en garde le **maximum** pixel par pixel |
| m004 | `t{t}.k{k}.c{c}.z{BZ}.y{BY}.x{BX}` | fabrique les briques v3 d'un **super-bloc 4 × 4 × 4** du niveau *k* |

Une unité dont **toutes** les briques sont absentes est **vide** : elle est comptée « faite » d'emblée et ne demande aucun travail.

### Le niveau suivant attend le précédent

Pour m004, le niveau *k + 1* se calcule à partir du niveau *k* : il ne peut donc démarrer **qu'une fois le niveau précédent complet**. Le serveur renvoie les unités **exécutables maintenant** (`runnable`) et le total restant (`pending`).

| Niveau (essai réel) | Dimensions | Unités |
|---|---|---|
| 0 | 520 × 520 × 130 | 18 |
| 1 | 260 × 260 × 65 (Z réduit) | 8 |
| 2 | 130 × 130 × 33 | 2 |
| 3 | 65 × 65 × 17 | 2 |

Au début, 18 unités sont exécutables sur 30 ; les autres attendent. Le navigateur **re-planifie par vagues** jusqu'à ce qu'il n'y en ait plus.

### La feuille de pointage

::: analogy
**Un déménagement.** Chaque unité est une **caisse**. Le déménageur coche chaque caisse livrée sur une feuille. Si le camion tombe en panne, ou si on change de camion, on repart de la dernière caisse cochée. Si une caisse est livrée deux fois, personne ne s'en aperçoit : la deuxième écrase la première.
:::

Cette feuille est le **journal**, un fichier JSON par migration et par jeu, dans `uploads/migrations/` (une zone **jamais servie**). À côté, un **magasin de tuiles** garde les résultats des unités terminées.

![Le journal d'une vraie conversion m002 et son magasin de tuiles.](img/ch17/journal-migration.svg){width=100%}

| Champ du journal | Sens |
|---|---|
| `migration`, `dataset` | quelle migration, sur quel jeu |
| `sourceManifests` | `{arbre: sha256}` du manifeste de départ de chaque arbre |
| `inputManifests` | (m003) empreinte du manifeste de `planes/` qui sert d'entrée |
| `units` | `{total, empty}` : nombre d'unités et nombre d'unités vides |
| `done` | la liste des clés d'unités terminées |
| `executors` | `{browser: n, server: n}` : qui a porté combien d'unités |
| `state` | `running`, `assembling`, `swapped` ou `failed` |
| `producer`, `assembledAt`, `assembly` | à partir de l'assemblage : qui a produit, quand, et l'avancement |
| `error`, `createdAt`, `updatedAt` | cause d'un échec ; dates |

Les propriétés qui font la solidité de ce mécanisme :

- le journal est écrit **« tout ou rien »**, sous un verrou : deux écritures simultanées ne se mélangent pas ;
- une unité **rejouée** est inoffensive : elle remplace ses propres tuiles ;
- si le **manifeste des briques change** pendant le travail (le jeu a été retraité entre-temps), le travail est invalidé (`source_changed`) : on ne mélange pas deux versions d'un même jeu ;
- un jeu supprimé en cours de route n'est **jamais recréé** par un travail qui finit.

## 17.10 Deux exécutants

Le travail de chaque unité peut être fait par **deux exécutants** qui écrivent dans **le même journal**.

![Deux voies, un seul journal : le navigateur et le serveur se partagent la liste d'unités.](img/ch17/deux-voies.svg){width=100%}

### Le navigateur

Un **Web Worker** (`js/workers/migration-worker.js`) fait tout le calcul, avec un petit module spécifique à la migration (`js/migrations/<id>.js`). Pour chaque unité :

::: steps
1. **lire** les octets d'entrée des paquets, par plages d'octets, dans **une seule requête** (`read_ranges`) ;
2. **décoder** les briques WebP sans perte, exactement comme le viewer ;
3. **recouper** et **encoder** : des tuiles PNG (m002, m003) ou des briques WebP v3 (m004) ;
4. **envoyer** le résultat en une requête (`unit_put`, 32 Mio au plus).
:::

L'onglet lance **au plus 2 workers × 2 unités** (le nombre de workers vaut la moitié des cœurs, de 1 à 2) : une unité retient jusqu'à environ 40 Mio en mémoire. Le serveur **revérifie** tout ce qu'il reçoit : chaque PNG doit commencer par la bonne signature et avoir les bonnes dimensions ; chaque brique v3 doit être du WebP sans perte de 594 × 528 pixels, les 6 cases inutilisées à zéro.

### Le serveur

L'onglet appelle `unit_run` **en boucle** ; chaque appel dure au plus 20 secondes (moins sur un hébergement qui limite le temps) et traite autant d'unités que possible. Le serveur lit lui-même les briques et écrit dans le magasin. Un « bail » de 120 secondes empêche deux appels de prendre la même unité.

::: why
**Pourquoi une boucle pilotée par le navigateur ?** Les hébergements mutualisés n'ont pas de tâche de fond : tout calcul doit tenir **dans une requête**. C'est l'onglet ouvert qui relance, d'où la consigne de ne pas le fermer.
:::

### Qui sait faire quoi : les sondes

Un exécutant n'est proposé que s'il **sait** faire l'étape. La capacité est mesurée **par migration** et **par exécutant**, par un petit essai réel.

| Raison affichée à l'écran | Code | Ce qui manque |
|---|---|---|
| le serveur ne sait pas décoder les images WebP sans perte | `no_webp_decode` | Pillow sans WebP, ou `imagecreatefromwebp` absent / fautif |
| le serveur ne sait pas encoder d'images WebP sans perte | `no_webp_lossless_encode` | PHP < 8.1 avec WebP, ou Pillow sans l'option sans perte |
| le serveur n'a pas NumPy | `no_numpy` | (Python, m004) |
| le serveur n'a pas la compression zlib | `no_zlib` | |
| le serveur autorise moins de 128 Mio de mémoire par requête | `low_memory` | |
| le serveur interrompt les requêtes après moins de 10 secondes | `exec_time_too_short` | |
| ce navigateur n'a pas de flux de compression | `no_compression_stream` | `DecompressionStream` |
| ce navigateur ne relit pas les tuiles PNG à l'identique | `no_png_codec` | |
| ce navigateur ne sait pas encoder d'images WebP sans perte | `no_webp_lossless_encode` | |

La sonde du serveur décode un minuscule WebP **intégré** et compare chaque valeur de pixel ; celle de m004 encode une brique de test puis la décode et compare **chaque voxel**. La sonde du navigateur, pour m004, vérifie qu'un `OffscreenCanvas` produit bien du WebP **sans perte** (en le relisant).

### Qui est choisi quand personne ne choisit ?

Le choix se fait **par jeu**, avant le départ, et il est **verrouillé** pendant l'exécution. L'ordre de décision :

1. le choix manuel de l'opérateur (mémorisé dans ce navigateur) ;
2. sinon le **gagnant du test de vitesse** ;
3. sinon le navigateur ;
4. sinon le serveur.

Chaque exécutant a **sa propre file** : un jeu confié au navigateur et un autre confié au serveur avancent **en parallèle** ; deux jeux confiés au même exécutant avancent l'un après l'autre. Une étape que l'exécutant choisi ne sait pas faire est confiée à l'autre, **dans la même file** : les étapes d'un jeu restent dans l'ordre.

### Le test de vitesse

![Cinq secondes, un même bloc synthétique, deux exécutants.](img/ch17/speedtest.svg){width=100%}

Le test ne lit et n'écrit **aucun jeu** : il utilise un bloc fixe livré avec la plateforme. Le **score** est le nombre de blocs convertis par seconde, multiplié par 10, mesuré sur la durée du dernier lot ou appel terminé : un lot coupé par l'échéance ne fausse pas la mesure. Si le navigateur ne termine aucun lot, il reçoit une fenêtre de plus. Le résultat est mémorisé dans ce navigateur.

### Les actions de l'API

Toutes exigent la session d'administration ; celles qui modifient exigent aussi l'en-tête anti-CSRF et la méthode POST (chapitre 19).

| Action | Rôle |
|---|---|
| `status` | tout l'état : registre, jeux, capacités du serveur |
| `plan` | crée ou reprend un travail ; renvoie les unités exécutables |
| `unit_put` | reçoit le résultat d'une unité faite par le navigateur |
| `unit_run` | fait des unités côté serveur, dans un temps borné |
| `finalize` | assemble, échange, monte la version (rappelable) |
| `cancel` | supprime journal et magasin |
| `bench` | mesure le serveur sur quelques unités (outil) |
| `speedtest`, `speedtest_put`, `speedtest_sample` | les trois morceaux du test de vitesse |
| `read_ranges` | renvoie jusqu'à 1 024 plages d'octets (32 Mio) de paquets, en une réponse |
| `store_get_many` | renvoie jusqu'à 128 briques v3 du magasin, en une réponse |
| `unit_inputs`, `store_get` | liste les entrées d'une unité ; lit une brique stockée |

## 17.11 `finalize` : l'échange et le changement de version {.page}

Quand toutes les unités sont faites, il reste à **assembler** les résultats en une structure complète, à l'**installer** et à **changer le numéro de version**. C'est le rôle de `finalize`, **toujours exécuté par le serveur**, quel qu'ait été l'exécutant des unités.

![Les cinq gestes de finalize, et ce que voit le disque à chaque instant.](img/ch17/finalize.svg){width=100%}

Deux idées font sa robustesse.

**Il est reprenable.** L'assemblage écrit les fichiers un par un dans le dossier voisin ; s'il est interrompu (limite de temps, coupure), il répond `complete: false` avec son avancement et on le **rappelle**. Il reprend où il s'était arrêté.

::: example
**Un essai réel.** Avec un budget de temps minuscule, `finalize` a répondu `{complete: false, assembly: {planes: 130, written: 0}}` : 130 plans à écrire, aucun écrit. L'appel suivant a répondu `{complete: true, formatVersion: 2}`. Le journal passait par l'état `assembling`, avec `producer: "migration-server"`.
:::

**Le changement de version est le point de validation.** Pendant tout l'assemblage et même après l'échange, l'ancien numéro reste en place. Si le serveur s'arrête entre l'échange et le changement de version, le jeu a ses **nouveaux fichiers** et l'**ancien numéro** : l'onglet le propose de nouveau, et `finalize` — idempotent — termine le travail.

### Les gestes propres à chaque migration

- **m002 et m003** : `planes/` (ou `mips/`) est renommé en `.planes-old/`, le dossier voisin le remplace, puis l'ancien est supprimé.
- **m004** : `bricks/` est échangé avec `.bricks-incoming/` ; les manifestes de `planes/` et de `mips/` — qui avaient noté l'empreinte de l'ancien manifeste — sont **re-signés** avec celle du nouveau (leurs voxels, ceux du niveau natif, n'ont pas changé) ; la version monte ; **ensuite seulement** `bricks.v2-old/` est supprimé.
- avant d'échanger, chaque structure assemblée est **relue et validée** (`assembly_invalid` sinon) ;
- la version est montée **sous le verrou de `metadata.json`**, en **fusionnant** dans le fichier courant : un enregistrement fait dans l'éditeur pendant ce temps n'est pas perdu, aucun autre champ n'est touché ;
- sans journal (perdu par un plantage), `finalize` regarde si la structure est déjà là et valide : il se contente alors de re-signer et de monter la version.

::: tech
**Pourquoi `bricks.v2-old/` reste jusqu'à la fin.** Le viewer peut encore être en train de lire l'ancien arbre quand l'échange a lieu. Les noms de fichiers des paquets v3 (`l0/c0/p00000.bin`) ne ressemblent pas à ceux de la v2 (`lod0/c0/pack_00.bin`) et le manifeste porte un `schema` différent : un lecteur ne confond jamais les deux.
:::

## 17.12 Le régulateur réseau et les hébergeurs lents

### Un incident à l'origine du régulateur

En version 1.59.1, un afflux de requêtes (deux groupes de workers, une requête par brique stockée, un test de vitesse sans borne) a conduit un hébergeur à **bannir l'adresse** de l'opérateur. Depuis, **toutes** les requêtes de l'onglet — ses appels et ceux de ses workers — passent par **un seul régulateur** (`NetGovernor`).

![Le régulateur (vraie classe, horloge virtuelle) et ce que la 1.59.3 a gagné sur la paire de jeux de test.](img/ch17/gouverneur.png){width=95%}

Ses règles, mesurées dans le code :

- **6 requêtes en vol** au plus ;
- un **seau à jetons** : on démarre à **4 requêtes par seconde** et on ne dépasse jamais **6** (la 1.59.2 allait de 10 à 16, avant que les entrées d'une unité voyagent ensemble) ;
- une requête **sans réponse**, un **429** ou un **503** : le débit est **divisé par 2** (plancher 0,5 requête par seconde) et on **retient toute nouvelle requête** pendant 5 secondes, puis 10, 20… jusqu'à 60 tant que les échecs continuent ;
- chaque réponse reçue **relève** le débit de 0,2 requête par seconde.

L'onglet le dit : « L'hébergeur répond lentement : les requêtes sont ralenties pour qu'il ne bloque pas cette adresse. »

### Environ trois requêtes par unité

Depuis la 1.59.3, une unité lit **toutes** ses plages d'entrée dans **une** réponse (`read_ranges`), ses briques de niveau *k* par paquets de 128 (`store_get_many`) et envoie son résultat en **une** requête. Mesuré sur la même paire de jeux de test (deux volumes de 2 canaux, formats 1 → 4) :

| Version | Requêtes | Débit moyen | Durée |
|---|---|---|---|
| 1.59.1 | environ 3 400 (plus de 40 par seconde) | — | — |
| 1.59.2 | 3 443 | 8 par seconde | 436 s |
| 1.59.3 | **424** | 3,7 par seconde (11 au plus dans la pire seconde) | **115 s** |

Un serveur qui ne connaît pas `read_ranges` répond « action inconnue » (400) : le worker lit alors plage par plage, à l'ancienne.

### Quand le serveur est trop lent : les octants

Sur un hébergement PHP mutualisé, une requête qui dépasse `max_execution_time` est **tuée** par l'hébergeur. Le serveur ne peut pas le savoir à l'avance ; il se protège donc.

![Une unité trop lente est découpée en 8 octants ; deux morts de requête passent la main au navigateur.](img/ch17/octants.svg){width=100%}

Avant chaque étape, le serveur appelle `set_time_limit()` ; `status.server.limits.resettable` dit si l'hôte l'honore. Puis :

1. **avant** de lancer une unité, il note `attempts[unité] + 1` dans le journal ;
2. pour m004, une unité peut être faite en **8 octants** (2 × 2 × 2 briques du super-bloc), chacun rangé et noté (`partial[unité]`) avant le suivant : l'unité est cochée quand tous y sont. Il le fait d'office tant qu'aucune unité entière du niveau n'a été chronométrée, quand la plus lente (+ 25 %) ne tiendrait pas dans le temps restant, ou après une mort de requête ;
3. une unité dont les étapes ont tué la requête **deux fois** reçoit la réponse **409 `unit_timeout`**. Le journal reste `running`, **rien n'est perdu**, et l'onglet confie cette migration au navigateur, qui n'a pas ce plafond.

### Ce que dit l'onglet quand quelque chose ne va pas

| Code | Message à l'écran |
|---|---|
| `source_changed` | le jeu de données a été retraité depuis le début de la mise à jour |
| `brick_undecodable` | une brique n'a pas pu être décodée |
| `incomplete` | certaines unités ne sont pas encore traitées |
| `no_progress` | le serveur n'a pas progressé |
| `request_failed` | une requête échoue à répétition |
| `prepare_failed` | le jeu de données n'a pas pu être lu |
| `unit_blocked` | un niveau inférieur de la pyramide n'est pas encore terminé |
| `bad_webp` | le serveur a refusé une brique convertie |
| `insufficient_disk` | espace disque insuffisant sur le serveur (requis / libre) |
| `no_executor` | ni ce navigateur ni le serveur ne peuvent exécuter cette mise à jour |
| `unit_timeout` | le serveur ne peut pas convertir une unité dans son délai |

::: remember
- Une migration = des **unités** cochées dans un **journal** ; deux exécutants, un navigateur ou un serveur, y écrivent.
- Le **dernier geste** est le changement de version, **sous le verrou** de `metadata.json` ; tant qu'il n'a pas eu lieu, rien n'est perdu.
- Le **régulateur** protège l'adresse de l'opérateur ; **trois requêtes par unité** suffisent depuis la 1.59.3.
:::

# Partie C. L'import dans le navigateur

## 17.13 Le parcours d'un import {.page}

Le chapitre 14 (section 14.3) montre l'onglet [Import]{.ui}. Voici ce qui se passe **sous** chaque geste.

![Du dossier déposé au jeu publié : six étapes, trois qui transportent des octets.](img/ch17/import-flux.svg){width=100%}

### 1. Déposer : lire le dossier

Le navigateur lit le dossier glissé avec l'interface `webkitGetAsEntry`, seule à fonctionner pour un **dossier** dans tous les navigateurs actuels. Elle ne rend qu'une centaine d'entrées par appel : on **vide** chaque dossier en boucle, sinon un jeu serait tronqué à ses cent premiers paquets. Huit fichiers sont résolus à la fois (les ouvrir un par un demanderait des minutes pour 100 000 paquets) et une borne de 400 000 entrées protège la mémoire ; ce qui n'a pas pu être lu est **compté et signalé**.

Un jeu est **reconnu** par son `metadata.json`. Son **type** vient du champ `type` de ce fichier ; à défaut, du nom du dossier parent s'il s'appelle `3d`, `2d` ou `live`. Le **nom du dossier déposé est l'identifiant du jeu** : d'où le message « Déposez le DOSSIER du dataset, pas son contenu ».

::: warning
L'import exige une **connexion sécurisée** (HTTPS, ou `localhost`) : les empreintes SHA-256 reposent sur `crypto.subtle`, que le navigateur n'offre pas en HTTP simple. Le panneau le dit une seule fois, d'emblée, plutôt que d'échouer fichier par fichier.
:::

### 2. Planifier : une requête par jeu

Pour chaque jeu, le navigateur envoie **la liste de ses fichiers avec leurs tailles** (jamais les octets). Le serveur **redérive** tout : la forme du type et du dossier, chaque chemin contre la liste blanche, et l'état de ce qui est déjà stocké ou publié. Il répond, pour chaque fichier : accepté ou refusé, palier, numéro de fichier (`fileId`), et — pour un fichier partiellement reçu — les **blocs manquants**.

Quelques garde-fous de la planification :

| Limite | Valeur |
|---|---|
| fichiers par jeu | 200 000 |
| jeux par dépôt | 200 |
| taille d'un fichier | 1 Tio |
| place à laisser libre sur le disque | 512 Mio |

Si le disque ne peut pas contenir ce qui reste à envoyer, la réponse est `insufficient_disk` **avant le moindre octet** (avec `neededBytes` et `freeBytes`) : un disque plein en cours de route bloquerait tous les autres écrivains de l'hôte. Une liste trop grosse pour la taille de requête de l'hébergeur (`post_max_size`) est signalée aussi.

### 3 et 4. Envoyer et refermer

La suite est détaillée aux sections 17.16 (blocs et journal) et 17.18 (vérifier, publier). Tout le transfert se fait dans un **Web Worker** : lire une tranche de 8 Mio et la hacher coûte des dizaines de millisecondes de calcul pur ; sur le fil principal, ce serait une image perdue à chaque bloc.

### Les actions de l'API d'import

| Action | Rôle |
|---|---|
| `limits` | taille de bloc, plafond, parallélisme, durée de grâce, type de serveur |
| `ping` | un aller-retour authentifié : distingue « réseau coupé » de « session expirée » |
| `list`, `state` | les jeux en cours d'import ; le détail d'un jeu ; **la liste lance aussi le nettoyage** |
| `plan` | planifie un jeu (ci-dessus) |
| `chunk` | reçoit un bloc |
| `file_done` | referme un fichier |
| `validate` | contrôle d'ensemble du jeu |
| `blob` | lit un fichier en cours d'import (aperçu) — sous session admin |
| `metadata`, `save_metadata`, `save_thumbnail` | l'édition pendant l'envoi |
| `publish`, `discard`, `gc` | publier, supprimer, nettoyer |

## 17.14 La liste blanche {.page}

Seul ce que **produit le pipeline** est accepté. Tout le reste est refusé **avant le premier octet**, par deux barrières successives.

![Deux barrières : la forme du chemin, puis une règle explicite par type de jeu.](img/ch17/liste-blanche.svg){width=100%}

::: why
**Pourquoi une liste fermée plutôt qu'une liste d'interdits ?** Une liste d'interdits oublie toujours quelque chose (une extension rare, un nom de périphérique Windows). Une liste de ce qui est **permis** ne peut pas oublier : ce qu'on n'a pas prévu est refusé. La zone d'arrivée est de plus **jamais servie** (chapitre 19), et la publication n'a lieu qu'après validation.
:::

Les détails des règles, tels que le moteur les applique :

- les paquets : `lod<N>/c<M>/pack_<n>.bin` (format 1 à 3) ou `l<k>/c<c>/p<NNNNN>.bin` (format 4), sous `bricks/` ou sous `bricks/tNNN/` pour une série (type `live` seulement) ;
- `planes/` et `mips/` : `manifest.json` et les paquets nommés (`zNNNNN.bin`, `lNNNNN.bin`), avec un sous-dossier `tNNN/` pour une série ;
- `download/` : un nom simple (pas de sous-dossier), jusqu'à 181 caractères, extension de **données** (liste de la section 17.6), **jugée sur sa dernière extension** ; les noms réservés de Windows (`CON`, `NUL`…) et ceux qui finissent par un point ou une espace sont refusés ;
- jamais acceptés : les fichiers `.php`, `.js`, `.htaccess`, tout fichier caché, tout chemin remontant (`..`), et les formats qu'un navigateur **exécute** à l'ouverture (HTML, SVG, XML).

::: note
Un fichier nommé `a.php.png` **passe** (sa dernière extension est `png`) : ce n'est pas une faille, car `download/` n'est jamais exécuté et toujours servi en pièce jointe. Ce qui compte, c'est que le fichier arrive dans un dossier où **rien ne s'exécute**.
:::

## 17.15 Les paliers : pourquoi un jeu est éditable avant la fin {.page}

Un jeu complet pèse des dizaines de gigaoctets, et l'envoi peut durer des heures. Les fichiers sont donc envoyés **par priorité** : les plus utiles d'abord.

![Les cinq paliers, avec les vrais octets du jeu de démonstration et un scénario de 10 Go à 5 Mo/s.](img/ch17/paliers.svg){width=100%}

| Palier | Contenu | Pourquoi dans cet ordre |
|---|---|---|
| 0 · cœur | `metadata.json`, manifeste, `index.bin`, vignette | de quoi **monter** le jeu |
| 1 · aperçu | le niveau le plus **grossier**, tous canaux (et `tracks.json` pour une série) | assez pour afficher quelque chose |
| 2 · intermédiaires | les niveaux entre le plus grossier et le natif, du plus grossier au plus fin | la qualité monte progressivement |
| 3 · natif | le niveau 0, et les images 1, 2, 3… d'une série | du travail de pleine qualité |
| 4 · le reste | `planes/`, `mips/`, `download/` | jamais nécessaires pour **ouvrir** |

Le palier d'un paquet dépend de l'**ensemble** du jeu (quel niveau est le plus grossier ?) : le serveur le recalcule donc une fois la liste complète connue. Une série ouvre sur sa **première image** ; les suivantes sont du palier 3.

::: example
**Le scénario de la figure.** Le jeu de démonstration a 47 ko de palier 0 et 32 ko de palier 1 : à l'échelle de 10 Go de briques (mêmes proportions) et à 5 Mo/s, le jeu est **ouvrable et éditable en environ 17 secondes**, toutes les qualités sauf la native sont là en 5 minutes, les briques complètes en 33 minutes. Les paliers 4, eux, peuvent durer plus longtemps que tout le reste.
:::

### Quand le jeu devient « éditable »

Le jeu passe à l'état **éditable** quand **tous** les fichiers de palier 0 et 1 sont terminés et que `metadata.json` et un fichier de montage (manifeste ou aperçu 2D) sont arrivés. Vous pouvez alors l'ouvrir en basse résolution et renommer, régler les canaux, orienter.

### Le verrou de `metadata.json`

Dès que vous **enregistrez** une édition sur un jeu en cours d'envoi, le serveur écrit votre `metadata.json` et pose un verrou (`metaLocked`). Le transfert **ne le réécrit plus** : la réception d'un nouveau bloc de `metadata.json`, ou une nouvelle planification, saute le fichier. Sans cela, la fin du transfert aurait silencieusement **effacé votre travail** en renvoyant le fichier d'origine.

## 17.16 Les blocs et le journal d'import {.page}

### Un bloc

Chaque fichier est découpé en **blocs de 8 Mio** par défaut. Le serveur peut imposer plus petit (jamais plus grand) : un hébergeur PHP limite la taille d'une requête.

![Un bloc, de la lecture à l'écriture : hachage, contrôle, écriture à son décalage exact, note au journal.](img/ch17/bloc.svg){width=100%}

| Limite de blocs | Valeur |
|---|---|
| taille par défaut | 8 Mio |
| plafond (Python) | 16 Mio |
| plancher | 256 Kio |
| hôte PHP | 80 % de `post_max_size`, et au plus le quart de `memory_limit` |
| blocs en parallèle | 4 |

Si un hébergeur refuse la taille choisie (`body_truncated`), l'interface **réduit** la taille, replanifie et dit « Taille de bloc réduite à … — relancez le dossier pour reprendre ». Les blocs déjà reçus restent valables : ils sont comptés d'après la taille **enregistrée** pour chaque fichier.

::: example
**Le chiffre de l'exemple.** Un original de 22 Gio représente 2 816 blocs de 8 Mio ; la liste de ce qui est reçu tient en 2 816 bits, soit **352 octets**. Les blocs peuvent arriver **dans le désordre et en parallèle** : chacun est écrit à son décalage exact (`indice × taille de bloc`).
:::

### Trois niveaux de contrôle

| Quand | Quoi |
|---|---|
| à chaque bloc | SHA-256 recalculé **avant** d'écrire ; longueur attendue ; le numéro de fichier correspond-il au chemin ? |
| à la fermeture d'un fichier | tous les blocs présents, taille sur disque exacte, **empreinte globale** = SHA-256 de la suite des empreintes de blocs, contenu plausible (signature WebP, JSON valide, en-tête d'index…) |
| à la validation du jeu | cohérence d'ensemble (section 17.18) |

::: why
**Pourquoi une « empreinte des empreintes » ?** Un navigateur ne sait pas hacher un fichier de 22 Gio en continu, et le relire une seconde fois doublerait le travail. L'empreinte de la **suite des empreintes de blocs** prouve la même chose — chaque bloc vérifié, dans le bon ordre, aucun manquant — **sans** relire quoi que ce soit.
:::

Quand l'envoi échoue, deux familles de pannes sont traitées différemment : une panne **du serveur** (erreur 5xx, saturation, empreinte fausse) consomme une des **6 tentatives**, avec une attente croissante de 1 à 30 secondes (± 25 %) ; une panne **du réseau** (aucune réponse) ne consomme **rien** : tout le transfert se met en attente jusqu'au retour de la connexion. Une panne de plusieurs minutes coûte du temps, jamais des fichiers.

### Le journal : trois fichiers, un format commun

![Le journal d'import : l'état de chaque fichier, la table des fichiers prévus, le journal des blocs reçus.](img/ch17/journal-import.svg){width=100%}

Ils vivent dans `uploads/state/` et portent le nom `<type>__<dossier>`. Python et PHP les lisent **et** les écrivent : **un import commencé sous un serveur reprend sous l'autre**.

| Fichier | Rôle | Réécrit |
|---|---|---|
| `.json` | l'état de chaque fichier : taille, taille de bloc, palier, nature, numéro, case par bloc (base 64), `done` | à la planification et à chaque fichier terminé |
| `.files` | la table des fichiers prévus : 16 octets d'en-tête (`LUFT`) puis 32 octets par fichier | quand un numéro change |
| `.log` | un enregistrement de **16 octets par bloc reçu** : numéro de fichier, indice de bloc, `LUC1`, CRC32 | **jamais** : on ajoute seulement |

::: tech
**Pourquoi un journal « à ajout seulement » ?** Réécrire tout le fichier JSON à chaque bloc de 8 Mio coûtait 40 ms pour 20 000 fichiers et une demi-seconde pour 200 000, **sous le verrou du jeu** : les quatre flux parallèles se faisaient la queue. Ajouter 16 octets ne coûte presque rien. Le journal est **compacté** (replié dans le `.json`, puis le `.log` est vidé) à la planification, à la fin d'un fichier et à chaque écriture du journal.
:::

Ce qui rend le journal sûr même après un plantage :

- un enregistrement n'est ajouté qu'**après** l'`fsync` des octets : un enregistrement qui survit décrit toujours des octets réellement sur le disque ;
- une queue tronquée, ou un enregistrement dont la signature ou le CRC ne correspond pas, est **ignoré** : cela coûte au pire un renvoi ;
- le numéro de fichier n'est **jamais réutilisé** : quand un fichier est replanifié (taille changée) ou remis à zéro, il reçoit un nouveau numéro, et un enregistrement écrit pour l'ancien ne peut plus tomber sur le nouveau ;
- le chemin du fichier est vérifié par une **empreinte de 16 octets** stockée dans la table : on prouve qu'un numéro désigne bien le chemin envoyé sans relire le journal.

## 17.17 Les états d'un import et la purge {.page}

![Quatre états ; un jeu abandonné est purgé au bout de sept jours, un jeu terminé jamais.](img/ch17/etats-import.svg){width=100%}

| État (code) | Libellé à l'écran | Condition |
|---|---|---|
| `uploading` | [Envoi — non éditable]{.pill .amber} | les fichiers des paliers 0 et 1 ne sont pas tous là |
| `editable` | [Envoi — éditable]{.pill .blue} | paliers 0 et 1 terminés, `metadata.json` et un fichier de montage arrivés |
| `staged` | [Envoyé — à publier]{.pill .green} | **tous** les fichiers planifiés sont terminés |
| `stalled` | [Interrompu]{.pill .grey} | aucun bloc accepté depuis 7 jours |

### La purge à sept jours

Un jeu que personne ne termine occupe du vrai disque dans la zone d'arrivée. L'opérateur a **sept jours** (604 800 secondes) pour glisser de nouveau le dossier et reprendre ; passé ce délai, le nettoyage libère ses fichiers et son journal, et l'envoi repart de zéro.

- le nettoyage tourne **à chaque affichage de la liste**, ou à la demande (action `gc`) ;
- le compte à rebours se mesure depuis la **dernière activité** (un fichier qui s'envoie pendant des heures compte comme de l'activité) ;
- un jeu **[Envoyé — à publier]{.pill .green}** n'est **jamais** purgé : il est complet et validé, il n'attend que votre clic. Le supprimer au bout d'une semaine détruirait des dizaines de gigaoctets de travail fini pour épargner un renvoi que personne n'a demandé.

### Qu'est-ce qui reste lisible pendant l'envoi ?

L'aperçu d'un jeu non publié passe par l'action `blob` : un fichier de la zone d'arrivée est servi, **sous session d'administration**, comme des octets opaques (avec `nosniff`), jamais comme un document. La zone d'arrivée n'est atteignable par **aucune adresse** ; elle est bloquée dans le serveur Python, dans le `.htaccess` racine, dans `router.php` et par un fichier d'interdiction qui lui est propre.

## 17.18 Valider, publier, remplacer {.page}

### Valider

L'action de validation relit le jeu **en entier** et vérifie qu'il forme un tout. Elle renvoie une liste de codes ; il y en a quelques dizaines, dont voici les familles.

| Code | Ce que cela veut dire |
|---|---|
| `missing_metadata`, `metadata_not_json` | pas de `metadata.json`, ou illisible |
| `metadata_type_mismatch` | le type déclaré n'est pas celui du dossier de dépôt |
| `metadata_no_dimensions`, `metadata_bad_dimensions`, `metadata_no_channels` | dimensions ou canaux invalides |
| `metadata_no_image`, `metadata_bad_image` | (2D) bloc `image` absent ou noms de fichiers non conformes |
| `missing_manifest`, `manifest_not_json` | pas de `bricks/manifest.json`, ou illisible |
| `manifest_no_levels`, `manifest_level_N_…`, `manifest_bad_brick_size`, `manifest_bad_encoding`… | manifeste incohérent (niveaux, 64 voxels, codage) |
| `missing_index:…`, `index_hash_mismatch:…` | `index.bin` absent, ou différent de l'empreinte du manifeste |
| `index_bad_magic`, `index_bad_length`, `index_shape_mismatch:…`, `index_grid_mismatch:…` | l'index n'a pas la bonne forme ou ne décrit pas les niveaux du manifeste |
| `missing_pack:<chemin>` | un paquet que l'index cite n'est pas arrivé |
| `truncated_pack:<chemin>` | un paquet est plus court que ce que l'index réclame |
| `manifest_pack_escapes` | un paquet pointe hors du dossier du jeu |
| `incomplete_files` | des fichiers planifiés ne sont pas terminés |
| `stray_files` | un fichier présent dans la zone d'arrivée n'a jamais été accepté par un plan |
| `missing_preview`, `missing_image` | (2D) une des deux copies manque ou est vide |

::: example
**Essais réels** sur le jeu de démonstration, dans un dossier temporaire. Tout est arrivé : `{ok: true}`. On **tronque** de 1 000 octets le paquet `l0/c1/p00001.bin` : `truncated_pack:l0/c1/p00001.bin`. On le **supprime** : `missing_pack:l0/c1/p00001.bin`. On **altère** `index.bin` : `index_hash_mismatch:bricks`. On dépose un fichier `stray.txt` : `stray_files`. Un bloc dont l'empreinte est fausse reçoit `422 checksum_mismatch` ; un bloc sans empreinte, `400 checksum_required`.
:::

Un paquet tronqué passe ses propres empreintes de blocs si le client n'a simplement jamais envoyé la fin : seule la validation d'ensemble l'attrape, **avant** qu'un visiteur ne voie un écran noir.

### Publier

![Valider, reprendre le travail de l'opérateur, échanger les dossiers, conclure.](img/ch17/publication.svg){width=100%}

La publication déplace le jeu validé de la zone d'arrivée vers `DATA_WEB/<type>/<dossier>/`.

- elle est **masquée par défaut** : l'opérateur décide quand le public voit le jeu ;
- c'est un **renommage** (quasi atomique) quand la zone d'arrivée et `DATA_WEB/` sont sur le même disque ; sinon, une copie dans un dossier voisin `.incoming-…` puis un renommage, pour qu'un jeu à moitié copié ne soit jamais visible sous son vrai nom ;
- avant de déplacer, les fichiers temporaires d'écriture sont balayés : ils ne voyagent jamais jusqu'au site.

### Remplacer un jeu déjà publié

Si le dossier de destination existe, la publication répond `409 already_exists`, et l'interface demande de confirmer le remplacement. Avec `overwrite`, dans l'ordre :

1. les clés curées de l'ancien fichier que le nouveau **ne contient pas** sont reprises (section 17.2) ;
2. l'ancien dossier est renommé `.replaced-<jeu>-<date>` ;
3. le nouveau est renommé à sa place ;
4. la **galerie** de l'ancien dossier (images et vignettes) est déplacée dans le nouveau, puis la liste `gallery` ne garde que les fichiers réellement présents ;
5. l'ancien dossier est supprimé, ainsi que le journal d'import.

Si le serveur s'arrête **entre les deux renommages**, au démarrage suivant `recover_publish_leftovers()` remet l'ancien jeu en place ; un `.replaced-…` dont le jeu existe est supprimé, un `.incoming-…` (copie partielle) l'est toujours.

::: note
L'interface ne **renvoie pas** un dossier dont le nom existe déjà dans `DATA_WEB/` : elle le considère comme « déjà publié » plutôt que de renvoyer des gigaoctets. Le remplacement se propose au moment de [Publier]{.ui}, quand le serveur signale que le nom existe.
:::

### Ce qu'on retient

::: remember
- Une **liste blanche fermée** : ce qui n'est pas prévu est refusé avant le premier octet ; la zone d'arrivée n'est **jamais servie**.
- Des **paliers** : les fichiers qui rendent le jeu ouvrable partent d'abord, et un jeu édité garde son `metadata.json`.
- Des **blocs hachés** et un **journal à ajout seulement** : une coupure coûte au pire un bloc, et l'import reprend sous l'un ou l'autre serveur.
- Une **publication « tout ou rien »**, masquée par défaut, qui reprend le travail de l'opérateur et la galerie.
:::

::: see
Les écrans, les boutons et le dock flottant de l'import sont dans le chapitre 14 ; la sécurité de la zone d'arrivée dans le chapitre 19 ; le contrat exact des migrations dans `DOCS/dataset-migrations/SPEC.md`.
:::
