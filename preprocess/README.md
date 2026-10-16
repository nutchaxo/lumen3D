<div align="center">

# 🔬 Pipeline de Preprocessing — Lumen3D / IRIBHM

**De l'image brute du microscope `.ims` à un volume 3D fluide dans le navigateur.**

`version 0.22.0` · `Imaris HDF5 → pyramide de briques 64³ WebP` (format 4, format 5 en option) · Python (h5py · numpy · scipy · Pillow)

</div>

---

## En bref (pour tout le monde)

Un microscope confocal qui photographie un embryon de souris produit un **volume 3D énorme** : des milliers d'images empilées, **plusieurs gigaoctets**, en 16 bits. Impossible de charger ça d'un coup dans un navigateur web — ni dans la mémoire vive, ni dans la carte graphique.

Ce pipeline résout le problème en transformant ce bloc géant en quelque chose de **streamable**, un peu comme **Google Maps mais pour un embryon en 3D** :

* on **nettoie** l'image (on enlève le bruit du capteur et le fond),
* on la découpe en **petits cubes** (« briques » de 64×64×64 voxels),
* on prépare **plusieurs niveaux de zoom** (basse résolution pour la vue d'ensemble, pleine résolution quand on s'approche),
* on **compresse** chaque cube **sans aucune perte** (format 4, par défaut). Le format 5, en option, ajoute des niveaux de compression à erreur bornée ou avec perte, réservés à l'affichage : les mesures lisent toujours le niveau sans perte.

Au final, le visualiseur ne télécharge que les quelques briques **réellement visibles à l'écran**, au niveau de zoom courant. C'est ce qui permet d'explorer un volume de 14 Go à 60 images/seconde dans un onglet de navigateur.

> **Principe directeur du labo** : *zéro approximation sur la donnée scientifique.* Tout ce qui touche aux intensités est soit exact, soit explicitement documenté. La compression par défaut est **sans perte**, le débruitage ne touche **jamais** au signal biologique (seulement le fond).

---

## Le pipeline en une page

Les étapes s'enchaînent. Chacune fait une chose et la passe à la suivante :

| # | Script | Ce qu'il fait, en clair |
|---|---|---|
| 1 | `1-ims_metadata.py` | **Lit la fiche d'identité** du volume (taille, nombre de canaux et de timepoints, taille d'un voxel en µm, étendue physique, noms des marqueurs fluorescents). |
| 2 | `2-image_processor.py` | **Nettoie, normalise et encode** : estime le fond, le supprime, lisse le bruit *sans flouter les cellules*, ramène le 16 bits en 8 bits, fabrique la pyramide de zooms et encode les briques de chaque timepoint dès qu'il est prêt. |
| — | `build_thumbnail()` | **Fabrique la vignette** (une projection colorée pour l'aperçu dans le catalogue). |
| 3 | `3-chunk_packer.py` | **Écrit les manifestes** des arbres de briques, des plans XY et des maximums par couche, ainsi que l'index binaire des briques. |
| 4 | `4-catalog_generator.py` | **Écrit les fiches finales** (`metadata.json`, histogrammes) que la plateforme lit, en conservant la curation du labo déjà publiée. |
| 5 | `tracking_sources.py` + `5-tracking_importer.py` | **Rattache le suivi cellulaire** d'un timelapse, s'il existe : trajectoires, lignage (mitoses/fusions) et transformation de stabilisation. Automatique — voir [§2.4](#24-le-suivi-cellulaire-tracking--rattachement-automatique). |

Les fichiers ne vont dans `DATA_WEB` qu'à la fin, d'un seul bloc : voir [§2.5](#25-publication-dun-dataset-tout-ou-rien).

```
  <dataset>.ims  (Imaris HDF5, uint16, multi-Go)
        │
        ▼
 ┌──────────────────────┐
 │ 1-ims_metadata.py    │  lit les attributs HDF5, convertit l'étendue en µm
 └──────────┬───────────┘
            ▼  meta.json  {width,height,depth,n_channels,n_timepoints,voxel_size,extent,channel_names}
 ┌──────────────────────┐
 │ 2-image_processor.py │  par timepoint × canal : fond, masque, médian, window leveling,
 │                      │  niveaux de la pyramide, puis encodage des briques du timepoint
 └──────────┬───────────┘
            ▼  staging/bricks/, staging/planes/, staging/mips/   (temp/t*_c*_lod*.bin : transitoires)
 ┌──────────────────────┐
 │ build_thumbnail()    │  MIP fausses couleurs → thumbnail.webp
 └──────────┬───────────┘
            ▼
 ┌──────────────────────┐
 │ 3-chunk_packer.py    │  manifestes des arbres, index.bin des briques
 └──────────┬───────────┘
            ▼
 ┌──────────────────────┐
 │ 4-catalog_generator. │  histogrammes + metadata.json (curation publiée conservée)
 └──────────┬───────────┘
            │  (timelapses uniquement, si une analyse de tracking existe)
 ┌──────────────────────┐
 │ tracking_sources.py  │  .imaris_track  |  objets Imaris du .ims  |  .xls/.xlsx
 │ 5-tracking_importer  │  -> trajectoires + lignage + stabilisation
 └──────────┬───────────┘
            ▼  tracks.json(.gz), model.glb + blocs "tracking"/"registration"
 ┌──────────────────────┐
 │ publication          │  renommages puis metadata.json en dernier
 └──────────┬───────────┘
            ▼  DATA_WEB/3d/<nom>/  (ou DATA_WEB/live/<nom>/ pour un timelapse)

  Le dossier temp/ (.temp_preprocess_<nom>) est supprimé en fin de traitement.
  catalog.json racine est ensuite régénéré dynamiquement par dev_server.py (scan des metadata.json).
```

---

## Glossaire express

| Terme | Définition courte |
|---|---|
| **Voxel** | Pixel en 3D — l'unité élémentaire du volume. Sa taille physique (en µm) vient de l'étendue déclarée dans le fichier Imaris. |
| **Canal** | Une longueur d'onde / un marqueur fluorescent (ex. DAPI = noyaux, Pecam1 = vaisseaux). Traité indépendamment. |
| **Brique** *(brick)* | Petit cube de **64³ voxels** — l'unité de streaming. Stockée avec une bordure d'un voxel (66³) depuis le format 4. Le viewer ne charge que les briques visibles. |
| **LOD** *(Level Of Detail)* | Niveau de la pyramide de zoom. LOD0 = pleine résolution ; chaque niveau suivant est plus petit en X/Y (et en Z selon les règles de §6.1). |
| **Format** | Version du layout produit, inscrite dans `metadata.json` (`formatVersion`) : 4 par défaut, 5 en option (voir §10). |
| **ESS** *(Empty Space Skipping)* | On ne stocke **pas** les briques vides (que du fond noir). Énorme économie de mémoire/VRAM. |
| **Window Leveling** | Étirement linéaire des intensités entre un point noir et un point blanc — la conversion 16 bits → 8 bits. |
| **MIP** *(Maximum Intensity Projection)* | Projette le volume sur un plan en gardant le voxel le plus brillant — sert à la vignette, et aux maximums par couche (`mips/`). |
| **Mosaïque** | Les tranches d'une brique rangées dans **une seule image 2D**, pour être décodées par le navigateur d'un coup : grille 9×8 de tranches de 66² au format 4 (594×528), grille 8×8 de 64² au format 2. |
| **Pack** | Un gros fichier `.bin` qui contient des briques compressées bout à bout (au lieu de milliers de petits fichiers). |
| **Plans XY** *(`planes/`)* | Les coupes natives XY, une par z, en tuiles 512² PNG : elles servent aux coupes natives du Studio. |

---

## Table des matières
1. [Prérequis & environnement](#1-prérequis--environnement)
2. [Exécution : lanceur autonome `.bat` ou CLI](#2-exécution)
3. [Contrat d'entrée : structure du fichier `.ims` (Imaris HDF5)](#3-contrat-dentrée--structure-du-fichier-ims-imaris-hdf5)
4. [Carte des fichiers](#4-carte-des-fichiers)
5. [Étape 1 — Extraction des métadonnées](#5-étape-1--extraction-des-métadonnées-1-ims_metadatapy)
6. [Étape 2 — Traitement & débruitage](#6-étape-2--traitement--débruitage-2-image_processorpy)
7. [Étape intermédiaire — Vignette MIP](#7-étape-intermédiaire--vignette-mip)
8. [Étape 3 — Manifestes, index & encodage des briques](#8-étape-3--manifestes-index--encodage-des-briques-3-chunk_packerpy)
9. [Étape 4 — Histogrammes & `metadata.json`](#9-étape-4--histogrammes--metadatajson-4-catalog_generatorpy)
10. [Formats de sortie (référence)](#10-formats-de-sortie-référence)
11. [Pourquoi ces choix de conception ?](#11-pourquoi-ces-choix-de-conception-)
12. [Déterminisme & reproductibilité exacte](#12-déterminisme--reproductibilité-exacte)
13. [Table de référence des paramètres](#13-table-de-référence-des-paramètres)
14. [Checklist « recréer de zéro »](#14-checklist--recréer-de-zéro-)

---

## 1. Prérequis & environnement

> 🚀 **Avec le lanceur `run_preprocess.bat` ([§2.1](#2-exécution)), vous n'avez rien à installer** : il fournit lui‑même un Python local **et** les dépendances. Les prérequis ci‑dessous ne concernent que l'usage **manuel** (CLI §2.2 ou réimplémentation).

* **Python 3.12** : version du lanceur (`build_launcher.py:PY_VERSION`) et version avec laquelle les tests du pipeline ont été exécutés.
* Dépendances Python, **versions épinglées** dans [`requirements.txt`](requirements.txt) (deux machines doivent produire les mêmes octets à partir du même `.ims`) :

  | Paquet | Version | Usage |
  |---|---|---|
  | `h5py` | 3.16.0 | lecture du conteneur HDF5 `.ims` |
  | `numpy` | 2.5.1 | tout le calcul vectorisé |
  | `scipy` | 1.16.0 | `scipy.ndimage.median_filter`, `binary_opening`, `binary_dilation` |
  | `Pillow` | 11.1.0 | encodage **WebP** (briques sans perte, colonnes avec perte du format 5), vignette, plans XY en PNG |
  | `tqdm` | 4.67.1 | barres de progression |

  ```bash
  pip install -r requirements.txt
  ```

  ⚠️ `scikit-image` n'est **pas** nécessaire : seul `scipy.ndimage` est utilisé pour la morphologie et le médian.

* **Dépendances optionnelles** :
  * suivi cellulaire extrait d'un `.ims` ou d'un classeur `.xls`/`.xlsx` ([§2.4](#24-le-suivi-cellulaire-tracking--rattachement-automatique)) : `pandas`, `xlrd` (`.xls`) ou `openpyxl` (`.xlsx`), `orjson` ;
  * `tifffile` — uniquement pour l'export **OME‑TIFF** du dossier `download/` (option `--with-downloads`, [§2.2](#22-en-ligne-de-commande-cli)). Le lanceur `.bat` l'installe **automatiquement à la demande** si l'option est choisie ; en usage CLI manuel, `pip install tifffile`.
* **RAM** : l'étape 2 ne charge **plus un canal entier**. Elle lit le `.ims` par **tuiles** dont le budget est `LUMEN_PREPROCESS_TILE_MVOX` millions de voxels, halo compris (24 par défaut) ; chaque worker garde ~600 Mo pour sa tuile. Le pic dépend donc du nombre de workers et du budget de tuile, pas de la taille du volume.
* **CPU** : l'étape 2 (médian, encodage) et l'étape 3 (WebP) parallélisent sur un `ProcessPoolExecutor` de `worker_count()` : un worker par cœur logique (61 au plus sous Windows), plafonné par `LUMEN_PREPROCESS_WORKERS`. Le résultat est **indépendant** du nombre de cœurs (voir §12).

---

## 2. Exécution

Deux façons de lancer le pipeline : le **lanceur autonome `.bat`** (zéro installation — recommandé) ou la **ligne de commande** (pour scripter / réimplémenter).

### 2.1. Lanceur autonome `run_preprocess.bat` *(recommandé)*

> **Un seul fichier suffit.** Le `.bat` est **auto‑suffisant** : on peut le copier **seul** sur n'importe quel PC Windows — même **sans Python et sans le dépôt** — et il met tout en place. Les **scripts du pipeline** y sont **embarqués** (encodés en base64) : `run_preprocess.py`, `1-`→`4-`, les modules d'écriture `planes_writer.py`, `mips_writer.py` et `bricks_v3_writer.py`, l'importeur de photographies `2d_importer.py`, le suivi cellulaire (`5-tracking_importer.py`, `tracking_sources.py`) et l'outil optionnel de bundles `download/` (`build_download_bundles.py`). S'il n'y a pas de Python, il en **télécharge et installe un, en local**.

**Utilisation : double‑cliquer sur [`run_preprocess.bat`](run_preprocess.bat).** Il déroule **5 étapes** automatiques :

| Étape | Ce qu'il fait |
|---|---|
| **[1/5]** Scripts | Extrait les scripts embarqués (décodage `certutil`, intégrité vérifiée par **SHA‑256**). S'ils sont **déjà présents** à côté du `.bat`, ils sont **conservés** (on peut donc exécuter une version modifiée). |
| **[2/5]** Python | Détection en cascade : runtime local `.runtime\python` → Python **système** (`py -3`/`python`/`python3`) → sinon **propose d'installer** un **Python 3.12.8** embarquable (téléchargé depuis python.org dans `.runtime\python`, avec `pip`). Isolé, **sans droits admin**, supprimable. |
| **[3/5]** Dépendances | Vérifie `numpy`/`Pillow`/`h5py`/`scipy`/`tqdm` (par import, aux versions épinglées) et **propose de les installer** via `pip`. |
| **[4/5]** Paramètres | Demande d'abord le **type de données** — `[1]` volumes Imaris `.ims`, `[2]` photographies 2D `.tif` — puis les questions de la chaîne choisie (voir ci‑dessous), affiche un **récapitulatif**, demande confirmation. |
| **[5/5]** Exécution | Lance le pipeline avec une **interface colorée** et la **progression en temps réel**. `Ctrl+C` demande une **confirmation** avant d'arrêter (arrêt propre — voir « Orchestration interne » plus bas). |

Les **4 questions** de l'étape [4/5], chaîne `[1]` **volumes Imaris** :

| Question | Quoi saisir |
|---|---|
| Dossier des `.ims` | Le chemin du dossier d'entrée. Validé : il doit exister, et le **nombre de `.ims`** trouvés est affiché. |
| Dossier de sortie `DATA_WEB` | **Entrée** ⏎ = valeur par défaut `..\DATA_WEB`. Ou un autre chemin. |
| Filtre optionnel *(glob)* | Ex. `*E8*` pour ne traiter que certains embryons. **Entrée** ⏎ = tous les fichiers. |
| Générer aussi `download/` ? | `o` / **N** (défaut : non). Si `o`, `tifffile` est installé au besoin et `--with-downloads` est passé au pipeline (archive `_web.zip`, `.ims` original, OME‑TIFF, MIP par canal, `README.txt`). **Lourd** : relit le `.ims`. |

> **Note** : le lanceur ne propose pas le **format 5** : il produit le format 4, défaut de `run_preprocess.py`. Le format 5 se lance en ligne de commande ([§2.2](#22-en-ligne-de-commande-cli)). Le suivi cellulaire est tenté à chaque timelapse, comme en ligne de commande ; l'extraction depuis un `.ims` ou un classeur demande les paquets optionnels de [§1](#1-prérequis--environnement), que le lanceur n'installe pas : sans eux le volume est publié sans trajectoires.

Chaîne `[2]` **photographies 2D** (appelle `2d_importer.py`, une image = un dataset, aucune brique) :

| Question | Quoi saisir |
|---|---|
| Dossier des `.tif` | Le chemin du dossier d'entrée. Validé : il doit exister, et le **nombre de `.tif`** trouvés est affiché. |
| Dossier de sortie `DATA_WEB` | **Entrée** ⏎ = valeur par défaut `..\DATA_WEB`. Les datasets atterrissent dans `DATA_WEB\2d\` (type `2d`). |
| Coloration | **Entrée** ⏎ = `X-gal`. Écrit tel quel dans `metadata.json`. |
| Lignée | **Entrée** ⏎ = lue dans le nom du `.lif` (ex. `DLL4xCD1`). |
| Copier le TIFF d'origine dans `download/` ? | `o` / **N**. Si `o`, l'original est **lié** (hardlink, 0 octet de plus) dans `download/` avec un `README.txt` de provenance. |
| Réimporter les datasets déjà présents ? | `o` / **N**. Passe `--force` : les mesures sont rafraîchies, la **curation du labo est conservée** (nom, stade, description, galerie…). |

**Modes en ligne de commande** (optionnels) :

```bat
run_preprocess.bat                      :: mode interactif (défaut)
run_preprocess.bat --check              :: vérifie scripts + Python + dépendances, puis quitte
run_preprocess.bat --extract [dossier]  :: reconstruit juste les .py embarqués
run_preprocess.bat --force-local        :: ignore le Python système, utilise/installe le Python local
run_preprocess.bat --help
```

> ✅ **Portable** : aucun chemin absolu (tout est résolu via `%~dp0`). Le dossier `.runtime\` (Python local) est créé **à côté du `.bat`** ; il est isolé et se supprime sans risque pour repartir de zéro.
> ⚠️ **Ne pas éditer le `.bat` à la main** : il est **généré** — voir [§2.3](#23-régénérer-le-lanceur-build_launcherpy).

### 2.2. En ligne de commande (CLI)

Pour scripter, automatiser, ou tourner sous Linux/macOS. C'est exactement ce que le `.bat` appelle en interne :

```bash
python run_preprocess.py --input <dossier_des_ims> --output <DATA_WEB> [--only "<glob>"] [--with-downloads] [--format 4|5] [--tracking auto|off|FICHIER]
```

| Argument | Obligatoire | Rôle |
|---|---|---|
| `--input`  | oui | Dossier contenant un ou plusieurs `.ims` (recherche **non récursive** : `input_dir.glob("*.ims")`). |
| `--output` | oui | Racine `DATA_WEB` de la plateforme. La sortie ira dans `<output>/3d/<nom_du_ims_sans_extension>/`, ou dans `<output>/live/<nom>/` si le fichier a plusieurs timepoints. |
| `--only`   | non | Filtre `fnmatch` sur le **nom de fichier** (ex. `"*Em7*"` ou le nom exact). Sans lui : tous les `.ims`. |
| `--with-downloads` | non | Après chaque dataset publié, construit aussi son dossier `download/` via `tools/build_download_bundles.py` (archive `_web.zip`, `.ims` original en hardlink, OME‑TIFF calibré, MIP PNG par canal, `README.txt`). Étape lourde : relit le `.ims`. Nécessite `tifffile`. |
| `--format` | non | `4` (défaut) : pyramide de briques v3, plans XY et maximums par couche. `5` : matrice résolution × compression (SPEC Part III, [§10.7](#107-format-5)). Le viewer lit le format 5 depuis la version 1.64 de la plateforme. |
| `--tracking` | non | `auto` (défaut) cherche l'analyse de suivi cellulaire des timelapses, `off` la saute, un **chemin** impose ce fichier. Voir [§2.4](#24-le-suivi-cellulaire-tracking--rattachement-automatique). |

Exemple réel (1 dataset) :

```bash
python run_preprocess.py \
  --input  "D:/RAW_DATA/done" \
  --output "C:/.../WebPlatform/DATA_WEB" \
  --only   "Egfl7eGFP-E8-Em7-18112025-GFP555-Pecam1-10x-2xzoom-4avg.ims"
```

> Sur Windows, si `python` est intercepté par l'alias Microsoft Store, utiliser le launcher `py`.

**Orchestration interne** (`run_preprocess.py`) :
* **Un dataset à la fois**, en boucle séquentielle dans `main` (pour économiser la RAM ; le parallélisme est *intra*‑dataset, en pools de processus — voir [§11](#11-pourquoi-ces-choix-de-conception-)). Un dataset en échec est signalé, le lot continue, et le récapitulatif final liste les échecs.
* Le **nom du dataset** = nom du fichier sans `.ims`. S'il n'est pas utilisable tel quel dans une URL, il est **slugifié** — sauf si un dataset publié porte déjà le nom brut, qui reste alors son dossier. Deux fichiers qui donneraient le même dossier : le second est refusé et nommé.
* Le **type** suit l'acquisition : `live` si le fichier a plus d'un timepoint, `3d` sinon. Le dossier parent *est* le type.
* `temp_dir = <output>/.temp_preprocess_<nom>` : recréé à neuf à chaque run, **supprimé en fin de traitement** (même en cas d'erreur). Le dataset est préparé dans `temp_dir/stage/<type>/<nom>/`, puis publié ([§2.5](#25-publication-dun-dataset-tout-ou-rien)).
* Ordre des étapes : **1 → 2 → vignette → 3 → 4**, puis le **tracking** (uniquement si `n_timepoints > 1`, [§2.4](#24-le-suivi-cellulaire-tracking--rattachement-automatique)), puis la **publication**, et enfin — **uniquement si `--with-downloads`** — `build_download_bundles.py`, qui vient après la publication (le dataset existe déjà). Chaque étape tourne dans un **sous‑processus isolé** (`subprocess.Popen`, nouveau groupe de processus : `CREATE_NEW_PROCESS_GROUP` Windows / `start_new_session` POSIX).
* **Arrêt propre sur `Ctrl+C`** : l'orchestrateur intercepte `SIGINT` et **demande confirmation**. *Refus* → le traitement **reprend** sans perte (l'étape en cours n'a pas reçu le signal) ; *confirmation* → l'étape **et tout son pool de workers** sont arrêtés (`taskkill /F /T` / `killpg`), les `.temp_preprocess_*` nettoyés, sortie en code **130**.

### 2.3. Régénérer le lanceur (`build_launcher.py`)

Le `.bat` est **généré**, jamais écrit à la main. Après toute modification d'un script `.py` ou du template, régénère‑le :

```bash
python build_launcher.py
```

* [`build_launcher.py`](build_launcher.py) lit le template [`launcher_template.bat.in`](launcher_template.bat.in), y injecte la configuration (la version est lue dans `run_preprocess.py:__version__`, la version de Python embarquable, la liste `SCRIPTS`, les dépendances épinglées) et **ré‑embarque** les scripts en base64 (blocs `#<index>#…`, 76 caractères/ligne).
* L'**ordre d'embarquement est figé** : `run_preprocess.py` est l'index 0 et la liste `SCRIPTS` suit dans son ordre ; le `.bat` extrait le bloc *N* pour le *N*ᵉ nom de cette liste. L'outil `build_download_bundles.py` (tiré de `../tools/`) est embarqué à l'index qui suit la liste.
* Sortie en **ASCII + CRLF** (ce que `cmd.exe` préfère).
* **Attention** : `format5.py` (racine du dépôt) est importé par `3-chunk_packer.py` et `4-catalog_generator.py`. Il doit donc figurer dans `SCRIPTS` pour que le lanceur autonome fonctionne ; avant de régénérer, vérifiez cette liste.

### 2.4. Le suivi cellulaire (tracking) — rattachement automatique

Un `.ims` de timelapse s'accompagne presque toujours d'une analyse de suivi cellulaire faite dans Imaris. Elle arrive sous **trois formes** selon ce que l'opérateur a exporté, et le pipeline prend celle qui est là — dans cet ordre de préférence :

| # | Source | D'où elle vient |
|---|---|---|
| 1 | `<nom>.imaris_track` **à côté du `.ims`** (ou dans un dossier `<nom>/`) | Sortie du pipeline de tracking (`tracking/SCRIPTS/Analysis.py`). La plus riche : analyse finie, surfaces `<nom>.glb` comprises. |
| 2 | **le `.ims` lui‑même** | Imaris range ses objets Spots/Tracks dans `Scene8/Content`. Rien à poser à côté du volume, rien à ne pas perdre. |
| 3 | `<nom>.xls` / `<nom>.xlsx` **à côté du `.ims`** | Le classeur « export statistics on all tabs » d'Imaris. Sa feuille `Position` porte une ligne par spot et par timepoint. |

Les sources 2 et 3 sont des **observations brutes** : positions, appartenance aux pistes et classification, mais ni identité cellulaire à travers une division, ni lignage, ni stabilisation. [`tracking_sources.py`](tracking_sources.py) les normalise en une table plate puis appelle **le code d'analyse du labo lui‑même** (`Analysis.py` : `CellIDAssigner`, `stabilize_coordinates`) — un dataset doit donner le même résultat qu'il passe par le pipeline de tracking ou par ce raccourci. Le conteneur reconstitué est écrit dans le dossier temporaire, jamais dans `DATA_WEB`.

Détails qui comptent :

* **Base de temps** — Imaris numérote les frames à partir de **1** dans tous ses exports, mais à partir de **0** dans `Scene8`. La lecture de `Scene8` ajoute 1, ce qui aligne les trois sources sur la convention attendue par `5-tracking_importer.py --timepoint-offset -1`.
* **Classification** — le nom de la colonne (ou du groupe de labels) est choisi par le biologiste : `Region`, `Set 1`, `Point Locations`, `Endothelial cells`… On prend donc, dans le classeur, la **seule colonne que ce n'est pas Imaris qui a écrite**, et dans `Scene8`, le groupe de labels qui couvre le plus d'objets — en préférant celui appliqué aux spots à celui appliqué aux pistes. Si `Scene8` n'a **aucune** classification mais qu'un classeur voisin en a une, elle est reprise en appariant les **identifiants d'objets** (les ids Imaris désignent les mêmes spots dans les deux fichiers).
* **Unités** — les positions exprimées en mm, nm ou m sont converties en µm avec la **même table** que l'étendue du volume (étape 1). Une unité inconnue n'est jamais devinée : les coordonnées sont gardées telles quelles et le document le signale.
* **Surfaces** — `model.glb` est celui exporté à côté du conteneur. À défaut (sources 2 et 3, ou conteneur sans `.glb`), il est **reconstruit** avec le code de surface du labo (`tracking_sources.build_surface_glb`) et la même disposition de nœuds.
* **Un échec ne fait jamais échouer le volume** : le dataset est déjà complet et exploitable, le tracking est une surcouche. Le message dit ce qui manque.
* **Dépendances** : `pandas`, plus `xlrd` (`.xls`) ou `openpyxl` (`.xlsx`), plus `orjson`. Le pack téléchargeable les installe ; un `pip install -r requirements.txt` **non**, elles y sont commentées. Un `.imaris_track` déjà prêt n'en demande aucune.

Le rattachement se fait dans le dossier de préparation, **avant la publication** ; un nouveau tracking remplace l'ensemble précédent (`tracks.json`, `tracks.json.gz`, `model.glb`).

Rattacher à la main (dataset déjà traité, ou pour imposer une analyse précise) — les trois formes sont acceptées :

```bash
python 5-tracking_importer.py <fichier.imaris_track|fichier.ims|fichier.xls> DATA_WEB/live/<nom> [--glb <surface.glb>] [--timepoint-offset -1] [--no-gzip] [--no-surface]
```

`--no-surface` n'écrit pas de `model.glb` quand la source n'en apporte pas ; `--no-gzip` n'écrit pas `tracks.json.gz`.

Voir ce qui serait détecté, sans rien écrire :

```bash
python tracking_sources.py <fichier.ims> --list
```

### 2.5. Publication d'un dataset (tout ou rien)

Le dossier de préparation est publié d'un seul bloc (`run_preprocess.publish_dataset`) :

* **Dataset nouveau** : un seul renommage du dossier de préparation vers `DATA_WEB`.
* **Dataset existant** : les entrées produites par le pipeline (`bricks/`, `planes/`, `mips/`, `thumbnail.webp` et, si un nouveau tracking est attaché, `tracks.json`, `tracks.json.gz`, `model.glb`) sont renommées en `.pre-swap`, les nouvelles sont installées, puis **`metadata.json` est remplacé en dernier** : c'est le point de validation.
* Un échec avant ce point remet tout en place. Un arrêt brutal est **terminé ou annulé** au run suivant grâce au marqueur `.swap-in-progress` (empreinte du `metadata.json` à installer) : un dataset publié ne mélange jamais deux runs.
* `download/`, `gallery/` et tout fichier posé par l'opérateur ne sont **jamais touchés**.
* La curation de la version publiée est **réappliquée au dernier moment** : l'opérateur a pu la modifier pendant le run.
* Un `planes/` ou `mips/` que le nouveau run ne produit pas est **supprimé** avec le swap, pour ne pas citer un ancien manifeste.

---

## 3. Contrat d'entrée : structure du fichier `.ims` (Imaris HDF5)

Un `.ims` est un conteneur **HDF5** (un format de fichier scientifique hiérarchique, comme un système de fichiers à l'intérieur d'un fichier). Le pipeline lit cette arborescence (les chunks HDF5 sont typiquement compressés **gzip**) :

```
/DataSetInfo/
    Image/                       (attributs, valeurs stockées en tableaux d'octets ASCII)
        X, Y, Z                  → width, height, depth  (entiers en texte)
        Unit                     → unité de l'étendue (um, nm, mm, m…)
        ExtMin0, ExtMax0         → étendue physique en X
        ExtMin1, ExtMax1         → étendue physique en Y
        ExtMin2, ExtMax2         → étendue physique en Z
    Channel 0/, Channel 1/, …    (un groupe par canal)
        Name                     → nom du canal (ex. "DAPI"), nettoyé (voir §5)
/DataSet/
    ResolutionLevel 0/           (on n'utilise QUE le niveau 0, pleine résolution)
        TimePoint 0/             (datasets "3d" : 1 seul timepoint)
            Channel 0/Data       → tableau 3D uint16, shape (Zpad, Ypad, Xpad)
            Channel 1/Data       …
        TimePoint 1/ …           (si timelapse)
    ResolutionLevel 1..N/        (pyramide native d'Imaris — IGNORÉE, on régénère nos propres LOD)
```

Détails importants :
* Le tableau `Data` peut être **paddé** (ex. dims réelles 178×3789×3789 mais `Data.shape = (184, 3840, 3840)` à cause du chunking HDF5). On recadre toujours via `ds[:D, :H, :W]` avec `(D,H,W)` issus des attributs `Z,Y,X`.
* Ordre des axes du `Data` : **(Z, Y, X)** (C‑order). `dtype = uint16`.
* `width = X`, `height = Y`, `depth = Z`.
* **Voxel** : `voxel_x = (ExtMax0 - ExtMin0) / X`, idem Y/Z, l'étendue étant d'abord convertie en µm selon `Unit` (§5). Arrondi à 6 décimales.
* TimePoints triés par l'entier final (`"TimePoint 12"` → 12). Canaux idem (`"Channel 3"` → 3).

> **Pourquoi ignorer la pyramide native d'Imaris ?** Imaris stocke déjà des niveaux de résolution, mais ils ne correspondent ni à notre format de briques, ni à notre nettoyage. On régénère tout à partir du `ResolutionLevel 0` (la donnée brute) pour garder la **maîtrise totale** de la qualité et de la géométrie.

---

## 4. Carte des fichiers

| Fichier | Rôle | Entrée | Sortie |
|---|---|---|---|
| [`run_preprocess.bat`](run_preprocess.bat) | **Lanceur autonome** Windows (scripts embarqués, Python local au besoin, install deps, saisie guidée). **Généré — ne pas éditer.** | double‑clic | extrait + appelle `run_preprocess.py` |
| [`build_launcher.py`](build_launcher.py) | **Générateur** du `.bat` (ré‑embarque les scripts en base64, injecte la version et les dépendances). | les `.py` embarqués + `../tools/build_download_bundles.py` + le template | `run_preprocess.bat` |
| [`launcher_template.bat.in`](launcher_template.bat.in) | Template du lanceur (logique batch + emplacements `@@@…@@@`). | — | — |
| [`run_preprocess.py`](run_preprocess.py) | Orchestrateur : étapes, dossier de préparation, publication atomique, curation, vignette. `__version__` du pipeline. | `--input`, `--output`, `--only`, `--with-downloads`, `--format`, `--tracking` | appelle 1→4 (+ tracking et download optionnels) ; publie dans `DATA_WEB` |
| [`requirements.txt`](requirements.txt) | Dépendances Python épinglées (pour `pip install -r`, usage manuel). | — | — |
| [`1-ims_metadata.py`](1-ims_metadata.py) | Lit les attributs HDF5, convertit l'étendue en µm. | `<ims>`, `<out.json>` | `meta.json` |
| [`2-image_processor.py`](2-image_processor.py) | Débruitage, normalisation 8 bits, pyramide, encodage des briques par timepoint. | `<ims>`, `<meta.json>`, `<temp>`, `--pack-into`, `--format` | `temp/t*_c*_lod*.bin` (transitoires), `temp/pack_t*.json`, `<stage>/bricks/`, `<stage>/planes/`, `<stage>/mips/` |
| [`3-chunk_packer.py`](3-chunk_packer.py) | Manifestes des arbres (briques, plans, MIP) et `index.bin` ; encode les briques d'un timepoint qui ne l'a pas été à l'étape 2. | `<temp>`, `<out_dir>` | `out/bricks/manifest.json`, `out/bricks/index.bin` (format 4) |
| [`bricks_v3_writer.py`](bricks_v3_writer.py) | **Format 4** : pyramide v3 (niveaux, bordure d'un voxel, mosaïque 9×8, packs, `index.bin`, manifeste). Copie autonome de l'arithmétique de la migration `m004`. | — (module) | — |
| [`planes_writer.py`](planes_writer.py) | Plans XY natifs (`planes/`) : une pile de tuiles 512² PNG par z. | — (module) | `planes/` |
| [`mips_writer.py`](mips_writer.py) | Maximums par couche de 64 plans (`mips/`). | — (module) | `mips/` |
| [`../format5.py`](../format5.py) | **Format 5** : matrice résolution × compression (SPEC Part III). Un seul fichier, partagé avec la plateforme (migration `m005`) ; le pack en embarque une copie identique. | — (module) | arbre de briques format 5 |
| [`4-catalog_generator.py`](4-catalog_generator.py) | Histogrammes manquants, `formatVersion`, `metadata.json`, curation. | `<temp>`, `<out_dir>`, `--existing`, `--display-name` | `out/metadata.json` |
| [`tracking_sources.py`](tracking_sources.py) | Détecte et normalise l'analyse de tracking d'un volume ([§2.4](#24-le-suivi-cellulaire-tracking--rattachement-automatique)). Bibliothèque, plus CLI de diagnostic. | `<ims\|xls\|imaris_track>`, `--list`, `--out`, `--glb` | un conteneur `.imaris_track` (dans `temp/`) |
| [`5-tracking_importer.py`](5-tracking_importer.py) | Écrit le tracking dans le dataset et y injecte la transformation de stabilisation. | `<source>`, `<dataset_dir>`, `--glb`, `--timepoint-offset`, `--no-gzip`, `--no-surface` | `out/tracks.json(.gz)`, `out/model.glb`, blocs `tracking`/`registration` dans `metadata.json` |
| [`2d_importer.py`](2d_importer.py) | Chaîne indépendante : un TIFF de photographie → un dataset de type `2d` (aucune brique). | `--input`, `--output`, `--only`, `--line`, `--staining`, `--with-downloads`, `--force`, `--lossless` | `DATA_WEB/2d/<nom>/{image,preview,thumbnail}.webp` + `metadata.json` |
| [`../tools/build_download_bundles.py`](../tools/build_download_bundles.py) | **Optionnel** (`--with-downloads`) — construit le dossier `download/` d'un dataset. Résolu par `run_preprocess.py` dans `../tools/` ou à côté de lui. | `--data-web`, `--raw-dir`, `--dataset`, `--ims` | `3d/<nom>/download/` (`_web.zip`, `.ims`, OME‑TIFF, MIP, `README.txt`) |
| [`../tools/convert_dataset.py`](../tools/convert_dataset.py) | **Outil annexe** : convertit un dataset **déjà publié** vers le dernier format, avec l'exécuteur Python du serveur (migrations `m002` à `m005`). Hors pipeline. | `<DATA_WEB>/<type>/<dossier>`, `--to`, `--list` | le dossier converti |
| [`../tools/bench_brick_codecs.py`](../tools/bench_brick_codecs.py) | **Outil annexe** : benchmark des codecs des colonnes du format 5 sur des briques publiées. | `<dataset>…`, `--out`, `--m6` | tableau de mesures |
| [`changelog/`](changelog/) | Historique versionné de l'outil. | — | — |

---

## 5. Étape 1 — Extraction des métadonnées (`1-ims_metadata.py`)

> **En clair** : avant de toucher aux pixels, on lit la « fiche technique » du volume — combien de voxels, combien de canaux, quelle taille réelle fait un voxel en micromètres, et comment s'appellent les marqueurs. Tout le reste du pipeline en dépend.

**Appel :** `python 1-ims_metadata.py <input.ims> <output.json>`

**Algorithme :**
1. Ouvrir le HDF5. Lire `DataSetInfo/Image` → `X,Y,Z` (entiers), `ExtMin{0,1,2}`/`ExtMax{0,1,2}` (flottants), `Unit`. Les attributs Imaris sont des **tableaux d'octets ASCII** → décodés via un helper `attr_str` (gère `bytes`, `np.bytes_`, `np.ndarray` de caractères).
2. **Calibration** : l'étendue est convertie en µm par la table `UNIT_TO_UM` (µm, nm, mm, m et leurs variantes ; une autre unité désactive la calibration). Puis `voxel = (ExtMax − ExtMin) / dim`, arrondi `round(.,6)`. *(C'est la calibration physique : elle rend les mesures de distance dans le viewer exactes en µm.)*
3. **Calibration non déclarée** : si l'unité est inconnue ou si une extrémité manque, `voxel_size` vaut **0** et `extent` vaut `null`. Jamais un voxel de 1/N µm étiqueté « exact ».
4. Énumérer `DataSet/ResolutionLevel 0/TimePoint *` (triés) → `n_timepoints`. Sur le 1ᵉʳ timepoint, énumérer `Channel *` → `n_channels`. Pour un timelapse, l'horodatage de chaque frame donne `timestamps` et l'intervalle médian `time_interval_minutes`.
5. Noms de canaux : `DataSetInfo/Channel i` attribut `Name`. Nettoyage : on coupe au 1ᵉʳ `\x00` (`re.sub(r'\x00.*','',name)`), `strip()`. Si vide **ou** si ça matche `^ch(annel)?\s*\d+$` (insensible casse) → fallback `"Channel {i+1}"`.

**Sortie `meta.json`** (exemple) :
```json
{
  "width": 3789, "height": 3789, "depth": 178,
  "n_channels": 4, "n_timepoints": 1,
  "voxel_size": { "x": 0.430366, "y": 0.430366, "z": 2.057107 },
  "extent": { "unit": "um", "min": [0.0, 0.0, 0.0], "max": [1630.66, 1630.66, 366.17] },
  "channel_names": ["DAPI", "eGFP", "GFP", "Pecam1"]
}
```

---

## 6. Étape 2 — Traitement & débruitage (`2-image_processor.py`)

> **En clair** : c'est le cœur scientifique. L'image brute du microscope contient du **bruit de capteur** et un **fond diffus** qui parasitent la visualisation. Cette étape sépare le *signal biologique* (l'embryon) du *fond*, lisse uniquement le fond (sans jamais flouter les cellules), puis « étire » les intensités pour exploiter toute la plage 8 bits. Enfin elle fabrique la pyramide de zooms et encode les briques, timepoint par timepoint. C'est l'étape la plus lourde (RAM + CPU).

**Appel :** `python 2-image_processor.py <input.ims> <meta.json> <temp_dir> [--pack-into <dossier_de_preparation>] [--format 4|5]`

Avec `--pack-into`, chaque timepoint est encodé dans le dossier de préparation dès que ses canaux sont levellés, puis ses fichiers `.bin` sont supprimés : le disque temporaire ne contient jamais plus d'une frame. `--format 2` (héritage, [§8.3](#83-format-2-héritage)) n'est pas proposé par `run_preprocess.py`.

### 6.1. Détermination des niveaux LOD

Le format de sortie détermine la pyramide. Le **niveau 0 est toujours la résolution native** `W×H×D`, non carrée et non puissance de 2 : fidélité maximale.

* **Format 4 (défaut)** — `v3.level_ladder` : chaque niveau divise **X et Y par deux** (arrondi supérieur) ; l'axe **Z** n'est divisé que si le voxel reste proche d'un cube, soit `vz ≤ 1,5 · max(vx′, vy′)` où `vx′`, `vy′` sont les voxels XY du niveau d'arrivée (doublés). Les niveaux sont ajoutés tant que le plus grand côté XY dépasse **128** voxels. Chaque niveau est la **moyenne entière** de blocs 2×2(×2) du niveau précédent, arrondie à la moitié supérieure ; les blocs de bord ne moyennent que les voxels existants.
* **Format 5** — `format5.level_ladder` : les cibles sont `T = 256·2ᵏ` strictement inférieures à `max(X,Y)` ; le grand côté XY d'un niveau vaut `T`, l'autre est dérivé pour garder le rapport d'aspect. Chaque niveau est la **moyenne d'aire exacte** du niveau 0. **Z n'est jamais réduit.**
* **Format 2** (héritage) — carrés `256·2ᵏ` plus petits que `max(W,H)`, inversés (LOD1 = le plus grand), Z conservé, sous‑échantillonnage bilinéaire PIL.

```python
# Format 2 (héritage) : LOD carrés, du plus grand au plus petit
curr = 256; target_dims = []
while curr < max(W,H): target_dims.append(curr); curr *= 2
target_dims.reverse()      # ex. W=H=3789 → [2048, 1024, 512, 256]
```

> **Pourquoi limiter la réduction de Z ?** Un stack confocal est déjà *grossier* en Z (peu de tranches, espacées de plusieurs µm) alors qu'il est fin en X/Y. Réduire Z quand le voxel est déjà très anisotrope détruirait le peu de détail axial existant et déformerait l'embryon lors des rotations. Au format 4, Z ne descend donc qu'en restant proche d'un cube ; au format 5, Z n'est jamais réduit.

### 6.2. Traitement, **par timepoint × par canal**

Le canal n'est **jamais tenu entier en mémoire** : il est lu depuis le `.ims` **par tuiles** (`plan_tiles`), chacune levellée indépendamment et écrite dans le LOD0. Chaque tuile est lue avec un **halo de 5 voxels** : l'ouverture (une érosion puis une dilatation), la dilatation de 3 itérations et le médian 3×3×3 ne lisent, au total, pas plus de 5 voxels au‑delà du cœur. Le résultat est donc **identique** à un traitement du volume entier, quel que soit le découpage.

**Step 1 — Estimation des bornes (Corner Sampling).**
* `corner_size = max(1, min(32, W//4, H//4, D//4))`.
* On extrait les **8 coins** du volume (cubes `corner_size³`).
* `bg_floor = percentile(coins, 99.0)` — le **plancher de bruit** : 99ᵉ centile du fond caméra pur (les coins ne contiennent jamais d'embryon).
* `sig_max = percentile(vol[::4,::4,::4], 99.9)` — le **point blanc** : 99.9ᵉ centile du volume **sous‑échantillonné ×4** (rapide, peu de RAM ; sature le 0.1 % le plus lumineux).
* **Timelapse** : une **fenêtre unique par canal** pour toute la série. Les coins et l'échantillon de signal sont mis en commun sur jusqu'à **8 timepoints** répartis dans la série (premier et dernier compris). `bg_floor` est le 99ᵉ centile des coins mis en commun ; `sig_max` est le 99.9ᵉ centile des seuls voxels au‑dessus de `bg_floor` (au moins 1000 voxels, sinon celui de tout le volume). Un signal épars ne se retrouve donc pas écrasé par le fond.

> **Pourquoi échantillonner les coins ?** L'embryon est toujours centré : les 8 coins du volume sont donc un échantillon **propre et non biaisé** du bruit pur du capteur, sans qu'on ait besoin d'un seuil fixe arbitraire.
> **Pourquoi le 99ᵉ centile (et pas la moyenne) ?** Pour être robuste aux pics de bruit : on place le point noir juste **au‑dessus** de la quasi‑totalité du fond, garantissant qu'il s'effondrera à 0.
> **Pourquoi une fenêtre commune à toute une série ?** Une fenêtre par frame ferait scintiller la série : à mesure que le spécimen blanchit, chaque frame réétirerait un signal qui s'éteint. Une fenêtre unique laisse les frames s'assombrir autant que le spécimen. Le blanchiment est **signalé** dans `metadata.json`, jamais corrigé dans les voxels.

**Step 2 — Masque de signal** (opérations 3D, par tuile avec son halo) :
```python
mask = vol > (bg_floor * 1.1)               # seuil 10 % au-dessus du plancher
mask = binary_opening(mask, iterations=1)   # éjecte les hot-pixels isolés
mask = binary_dilation(mask, iterations=3)  # protège le fondu fluorescent autour du signal
```
* Structure morphologique : **défaut scipy** = `generate_binary_structure(3, 1)` (croix 6‑connexe).

> **Pourquoi ouverture *puis* dilatation ?** L'**ouverture** retire les pixels morts hyper‑lumineux **isolés** (hot‑pixels du capteur) : sinon ils seraient pris pour du signal et « protégés ». Une fois retirés du masque, ils subiront le médian + le window leveling et tomberont à 0. La **dilatation** (×3) élargit ensuite le masque autour du vrai signal pour préserver le **fondu fluorescent naturel** des bords — on ne veut jamais que le filtre morde dans une cellule.

**Step 3 — Filtrage médian masqué + Window Leveling** (par tuile, en parallèle) :
```python
smoothed  = median_filter(vol, size=3)                  # médian 3D 3×3×3 (mode 'reflect')
composite = np.where(mask, vol, smoothed)               # signal net DANS le masque, fond lissé DEHORS
clean     = np.clip(composite, bg_floor, sig_max)
norm      = (clean - bg_floor) / (sig_max - bg_floor)   # garde-fou : si sig_max<=bg_floor → sig_max = bg_floor+1
block_u8  = (norm * 255.0).astype(uint8)                # troncature (pas d'arrondi)
```
* Conséquence : tout voxel `≤ bg_floor` devient **0 absolu** en `uint8`.
* Des avertissements signalent une fenêtre quasi nulle (signal très épars) ou un bruit de coin anormal ; ils ne modifient jamais la fenêtre.

> **Pourquoi un médian *masqué* et pas un flou global ?** Un flou (gaussien ou médian) appliqué partout abîmerait les **arêtes des cellules**. Ici, le masque protège le signal : on garde le signal **net** là où il compte, et on ne lisse que le **fond bruité**. C'est du débruitage *edge‑preserving*.
> **Pourquoi un filtre médian (et pas gaussien) ?** Le médian supprime le *shot‑noise* (grains isolés) tout en préservant les contours — un gaussien, lui, étalerait tout. C'est un choix assumé depuis la v0.12.1.
> **Pourquoi écraser le fond à exactement 0 ?** Le visualiseur additionne les intensités sur des centaines de tranches Z (*additive blending*). Un fond résiduel à 1 ou 2 s'accumulerait en un **voile gris**. Un 0 absolu = vide parfaitement noir, **et** ça permet à l'étape 3 de jeter les briques vides (ESS).

**Step 4 — Niveaux de la pyramide** : chaque niveau est calculé à partir du précédent, selon le format (§6.1) — moyenne entière arrondie (format 4), moyenne d'aire exacte (format 5), ou sous‑échantillonnage bilinéaire X/Y (format 2).

**Step 5 — Encodage du timepoint** (formats 4 et 5) : les briques, les plans XY et les maximums par couche de ce timepoint sont écrits dans le dossier de préparation ; `pack_t{t}.json` en garde le bilan. Seuls restent ensuite le niveau le plus grossier (histogrammes) et, pour le premier timepoint, le niveau de la vignette.

### 6.3. Sorties de l'étape 2 (dans `temp_dir`)
* `t{t:03d}_c{c}_lod{N}.bin` — **volume `uint8` brut, sans en‑tête**, C‑order, shape `(D, H_lod, W_lod)`. Un fichier par (timepoint, canal, niveau). **Transitoire** : supprimé une fois le timepoint encodé, sauf le niveau le plus grossier et, pour `t000`, celui de la vignette.
* `pack_t{t:03d}.json` — bilan de l'encodage du timepoint (format et arbre produits).
* `processing_meta.json` :
  ```json
  {
    "lod_levels": [
      {"lod":0,"width":3789,"height":3789,"depth":178,"voxelSize":{"x":0.430366,"y":0.430366,"z":2.057107},"halveZ":false},
      {"lod":1,"width":1895,"height":1895,"depth":178,"voxelSize":{"x":0.860732,"y":0.860732,"z":2.057107},"halveZ":false}
    ],
    "voxel_size": {...}, "channel_names": [...],
    "width": 3789, "height": 3789, "depth": 178,
    "n_channels": 4, "n_timepoints": 1, "datasetFormat": 4,
    "extent": {...}, "timestamps": null, "time_interval_minutes": null,
    "normalization": { "mode": "per-volume", "bounds": {"c0": {"bgFloor": …, "sigMax": …}}, "signalLevels": {…} }
  }
  ```
  `normalization` décrit la fenêtre (`global` pour un timelapse, `per-volume` sinon) et le niveau de signal propre à chaque frame, rapporté dans `metadata.json` ([§9](#9-étape-4--histogrammes--metadatajson-4-catalog_generatorpy)).

---

## 7. Étape intermédiaire — Vignette MIP

> **En clair** : la petite image d'aperçu que tu vois dans le catalogue. On « aplatit » le volume en gardant le point le plus brillant le long de Z, on colore chaque canal, et on superpose le tout.

Fonction `build_thumbnail()` **dans `run_preprocess.py`** (pas un script séparé), appelée entre l'étape 2 et l'étape 3.

* Choix du LOD source : **premier niveau de la pyramide dont le plus grand côté XY est ≤ 1024** (`thumbnail_lod`), lu pour le premier timepoint ; sa profondeur Z est celle du niveau lui‑même.
* Pour chaque canal : charge `temp/t000_c{C}_lod{target}.bin` (`np.fromfile`, reshape `(D,h,w)`), calcule la **MIP** `vol.max(axis=0)`.
* Composite **fausses couleurs additif** : pour le canal *i*, `composite += (mip/255) × THUMB_COLORS[i % 7]` (RGB), puis `clip(0,255) → uint8`.
* `THUMB_COLORS` = `[(0,255,102),(255,61,255),(47,107,255),(255,48,48),(255,255,0),(255,0,255),(0,255,255)]`.
* Redimensionne pour tenir dans **512×512** (LANCZOS, ratio préservé), centre sur un fond carré `(8,10,18)` (`#080A12`).
* Enregistre `thumbnail.webp` (dans la préparation, puis `3d/<nom>/` ou `live/<nom>/`) en `WEBP quality=88 method=6`.

---

## 8. Étape 3 — Manifestes, index & encodage des briques (`3-chunk_packer.py`)

> **En clair** : les briques sont déjà encodées quand cette étape commence (étape 2, timepoint par timepoint). Cette étape écrit les **index** qui permettent au viewer de retrouver chaque brique et de la décoder, ainsi que les manifestes des autres arbres (plans XY, maximums par couche). C'est là qu'on décide quelles briques vides sont jetées, et comment les briques sont rangées dans les gros fichiers.

**Appel :** `python 3-chunk_packer.py <temp_dir> <output_dir>`. Le format est lu dans `processing_meta.json` : 5 → `build_packs_v5`, 4 → `build_packs_v3`, absent ou 2 → héritage.

### 8.1. Format 4 (défaut)

1. **Niveaux** : ceux de l'étape 2 (§6.1, pyramide v3).
2. **Briques de 66³** : chaque brique est une cellule **64³** plus une **bordure d'un voxel** prise chez les voisins (*clamp‑to‑edge* hors du volume). Les 66 tranches sont rangées dans une **mosaïque 9 × 8** (`594 × 528`, niveaux de gris), encodée en **WebP sans perte** (qualité Pillow 75, méthode 4). Les 6 cases en trop restent à zéro.
3. **Empty‑space skipping exact** : une brique est stockée **si et seulement si** un voxel de son cœur 64³ vaut au moins 1. Il n'y a ni seuil d'occupation, ni dilatation : le signal faible est conservé.
4. **Packs** : les briques d'un niveau et d'un canal sont regroupées par **super‑blocs 4×4×4** entiers, sans jamais couper un super‑bloc entre deux packs ; un pack contient au plus **64 briques ou 16 MiB** (`l{k}/c{c}/p{NNNNN}.bin`). Un pack est la concaténation brute des flux WebP.
5. **`index.bin`** (magic `LBIX`, version 1) : l'index **binaire** de chaque emplacement de brique (pack, décalage, longueur), par niveau et par canal, dans l'ordre `bz, by, bx`. Une brique absente vaut `(0, 0, 0)`. Il remplace le manifeste JSON à liste de briques, qui pesait 7,6 Mo sur un embryon de 3789² (contre 233 ko pour l'index).
6. **Manifeste** `bricks/manifest.json` (schéma `iribhm-bricks-v3`, [§10.2](#102-bricksmanifestjson)) : `sha256` et taille de l'index, histogrammes, niveaux.
7. **Plans et maximums** : `planes/` et `mips/` écrivent leurs manifestes, qui citent le `sha256` du manifeste des briques.

Le même arbre est produit par la migration `m004-bricks-v3` de la plateforme : les deux implémentations sont tenues ensemble par un test de parité (`tests/test_v3_pipe_parity.py`).

### 8.2. Format 5

Avec `--format 5`, `format5.write_tree` produit les niveaux, les colonnes et les index à partir du LOD0 de chaque timepoint. Chaque brique est encodée dans **cinq colonnes** : `ll` (sans perte), `b2` et `b4` (quantification à erreur bornée de 2 et 4 niveaux de gris, stockée en indices plus une table de correspondance), `q80` et `q50` (WebP avec perte sur une grille de 80 px, avec un octet de zone morte). Les plans `xy/`, `xz/`, `yz/` et les briques de coupe `cuts/` sont produits dans l'arbre des briques. Le détail et la norme sont dans [SPEC.md](../DOCS/dataset-migrations/SPEC.md) (Partie III), et [§10.7](#107-format-5) en résume la disposition.

### 8.3. Format 2 (héritage)

Format 2 (`2-image_processor.py --format 2`, conservé pour les tests de migration) : briques 64³ **sans bordure**, mosaïque 8×8 en `512²`, packs de **128 briques** (`pack_NN.bin`), manifeste `iribhm-bricks-v2` avec `brickToPack`. Une brique n'est gardée que si elle contient un voxel **supérieur à 5** (le plancher que le viewer n'affiche pas) **et** si son taux de voxels non nuls dépasse `0,0005` (`LUMEN_ESS_MIN_OCCUPANCY` le change). Le format 2 n'est donc pas une sortie de production.

---

## 9. Étape 4 — Histogrammes & `metadata.json` (`4-catalog_generator.py`)

> **En clair** : on écrit les deux « fiches » que la plateforme lit. Les **histogrammes** d'intensité (pour régler les curseurs de contraste) et le **`metadata.json`** (dimensions, calibration physique, couleurs des canaux, stade de l'embryon, et la version du format).

**Appel :** `python 4-catalog_generator.py <temp_dir> <output_dir> [--existing <metadata.json publié>] [--display-name <nom>]`

1. **Histogrammes** : calculés par l'étape 3 pour **chaque timepoint**, sur le LOD **le plus petit** (`lod_levels[-1]`) : 64 bins sur `[0, 255]`, avec `counts`, `edges`, `total`, `max`, `mean`, `std`, `backgroundFloor = 0`. Ils sont écrits dans `bricks/manifest.json` (`histograms`, et `timepointHistograms` pour un timelapse). Cette étape ne les complète que si le manifeste n'en contient pas (manifeste plus ancien).
2. **Calibration physique** : `physicalSizeUm = {x, y, z}` = étendue physique par axe, plus `sliceThickness = (Zmax − Zmin) / D`. Le pas en Z est déclaré égal à l'épaisseur de tranche car, sans valeur explicite, le viewer estime une épaisseur plus faible qu'Imaris pour un stack anisotrope — ce qui fausse toute donnée de suivi recalée. `calibrationStatus = "exact"` si les 3 voxels sont déclarés, sinon `"metadata-missing"` avec une note ; aucune valeur n'est inventée.
3. **Parsing du nom de dossier** (mêmes règles que `2d_importer.py`) :
   * Stade : `E<jour>`, avec une fraction facultative écrite `E8.5`, `E8,5`, `E8-5` (tirets 25, 5 et 75 seulement) ou compacte `E85` ; une compacte à deux chiffres commençant par `1` lit deux chiffres de jour (`E105` = E10.5). Sans stade : `("Unknown", 0.0)`.
   * Embryon : un token explicite `Em<n>` s'il existe ; sinon le nombre qui suit immédiatement un stade entier (`E8-1-…` = embryon 1). `E8-5` ne donne pas d'embryon. Sinon `null`.
4. **Canaux** : couleur par défaut depuis `COLORS = ["#00FF00","#00AAFF","#FF00FF","#FF0000","#FFFF00","#00FFFF"]`, `min=0, max=1, gamma=1`.
5. **Type et format** : le type est le nom du dossier parent (`3d` ou `live`), `id = "<type>/<nom>"`. `formatVersion` = le plus haut format dont **toutes** les structures sont présentes et citent le manifeste actuel : 5 (arbre v5 + plans + MIP), 4 (arbre v3 + plans + MIP), 3, 2, sinon 1. Un dataset ne se déclare jamais d'un format qu'il n'a pas.
6. **Timelapse** : `timeline` (nombre de timepoints, intervalle, horodatages) et `intensityNormalization` (mode, bornes de la fenêtre, niveau de signal de chaque frame). Le blanchiment est **rapporté** pour un réglage d'affichage réversible, jamais inscrit dans les voxels.
7. **Curation** : avec `--existing` (par défaut le `metadata.json` publié), `merge_volume_metadata` garde ce que le labo a choisi (`CURATED_KEYS` : nom, description, stade, embryon, ligne, marquage, reporter, masqué, galerie, étiquettes, notes, date, orientation, axes d'orientation, face de l'échantillon, vue par défaut, exposition, lien de suivi, datasets liés). Les réglages par canal sont gardés si le nombre de canaux n'a pas changé. Une calibration saisie à la main est gardée quand la nouvelle est absente, sauf s'il s'agit d'un placeholder 1/N.
8. Écrit `output_dir/metadata.json` (voir §10.1) de façon atomique.

> Les réglages d'affichage (`gamma`, `min`, `max`, `active`, couleurs ajustées, `exposure`, `orientation`) sont ensuite **éditables via le panneau admin** (`admpan.js` → API `dev_server.py`), qui réécrit `metadata.json`. Le générateur ne produit que les valeurs par défaut.

---

## 10. Formats de sortie (référence)

Arborescence finale d'un dataset `3d` au format 4 (un dataset `live` a le même plan, avec une arborescence par timepoint, §10.8) :

```
DATA_WEB/3d/<nom>/
├── metadata.json          # config dataset (formatVersion, dims, voxels, canaux, volumeSources, curation)
├── thumbnail.webp         # vignette MIP fausses couleurs 512²
├── bricks/
│   ├── manifest.json      # iribhm-bricks-v3 : niveaux, index, histogrammes
│   ├── index.bin          # index binaire LBIX de chaque emplacement de brique
│   └── l0/c0/p00000.bin, p00001.bin, …  l0/c1/…  …  l1/…  …  (un sous-dossier par niveau et par canal)
├── planes/                # plans XY natifs : manifest.json + z00000.bin … (tuiles 512² PNG)
├── mips/                  # maximums par couche de 64 plans : manifest.json + l0.bin … (LMIP)
└── download/              # OPTIONNEL (--with-downloads) : _web.zip, .ims original,
                           #   TIFF composite ImageJ/Fiji calibré, MIP PNG par canal,
                           #   README.txt
```

### 10.1. `metadata.json`
```json
{
  "id": "3d/<nom>", "formatVersion": 4, "name": "<nom>", "type": "3d",
  "stage": "E8", "stageNumeric": 8.0, "embryo": "Em7",
  "dimensions": { "x": 3789, "y": 3789, "z": 178, "c": 4, "t": 1 },
  "voxel_size": { "x": 0.430366, "y": 0.430366, "z": 2.057107 },
  "physicalSizeUm": { "x": 1630.66, "y": 1630.66, "z": 366.17,
                      "sliceThickness": 2.057107, "voxelX": 0.430366, "voxelY": 0.430366, "voxelZ": 2.057107 },
  "optical_section_thickness_um": 2.057107,
  "acquisitionExtentUm": { "unit": "um", "min": [0.0, 0.0, 0.0], "max": [1630.66, 1630.66, 366.17] },
  "calibrationStatus": "exact", "calibrationNote": "Voxel metadata was successfully extracted.",
  "channels": [ { "name": "DAPI", "color": "#00FF00", "min": 0.0, "max": 1.0, "gamma": 1.0 }, … ],
  "created": "<ISO>", "lastModified": "<ISO>", "configured": true,
  "folderName": "<nom>",
  "description": "Confocal imaging stack: E8 fixed embryo, 178 slices, 4 channels.",
  "thumbnail": "DATA_WEB/3d/<nom>/thumbnail.webp",
  "volumeSources": [ {
    "kind": "bricks", "label": "Chunked bricks (64³)", "priority": -1,
    "available": true, "multiscale": true,
    "path": "DATA_WEB/3d/<nom>",
    "manifestPath": "DATA_WEB/3d/<nom>/bricks/manifest.json"
  } ]
}
```
Un timelapse ajoute `timeline` et `intensityNormalization` ([§9](#9-étape-4--histogrammes--metadatajson-4-catalog_generatorpy)) ; une acquisition suivie ajoute `tracking` et `registration` ([§2.4](#24-le-suivi-cellulaire-tracking--rattachement-automatique)).

### 10.2. `bricks/manifest.json`

Format 4 (`iribhm-bricks-v3`) :
```json
{
  "schema": "iribhm-bricks-v3", "version": 3, "formatVersion": 4,
  "dataset": "<nom>", "channels": 4, "brickSize": 64, "apron": 1,
  "brickPacking": { "mode": "grid", "cols": 9, "rows": 8, "slice": 66 },
  "encoding": "webp-lossless",
  "levels": [ {
    "level": 0,
    "dimensions": { "x": 3789, "y": 3789, "z": 178 },
    "voxelSize": { "x": 0.430366, "y": 0.430366, "z": 2.057107 },
    "gridSize": { "x": 60, "y": 60, "z": 3 },
    "brickCount": 2043
  }, … ],
  "index": { "url": "index.bin", "bytes": 233000, "sha256": "<sha256>" },
  "timepoints": null,
  "histograms": [ { "counts":[…64…], "edges":[…65…], "total":…, "max":…,
                    "mean":…, "std":…, "backgroundFloor":0 }, … ],
  "producer": "pipeline",
  "createdAt": "<ISO>"
}
```
* `brickCount` d'un niveau = briques **stockées** (pas la grille complète), tous canaux et tous arbres cumulés.
* Un **timelapse** n'a pas de `index` à la racine : `timepoints` liste `{ "path": "t000", "index": { "url": "t000/index.bin", "bytes", "sha256" } }`, et `timepointHistograms` donne les histogrammes par frame.
* Le manifeste est écrit en JSON compact.

### 10.3. Format binaire d'un pack et `index.bin`

* **Pack** (`l{k}/c{c}/p{NNNNN}.bin`) : concaténation **brute** de flux WebP sans perte, sans en‑tête ni séparateur.
* **`index.bin`** (little‑endian) : en‑tête `LBIX`, version `1`, nombre de niveaux, nombre de canaux ; pour chaque niveau `gx, gy, gz, packCount` (4 × u32) ; puis, pour chaque niveau et chaque canal, une entrée par brique de la grille — `pack` (u16), `offset` (u32), `length` (u32), dans l'ordre `bz, by, bx`. `length = 0` = brique absente.
* Lecture d'une brique : `pack`/`offset`/`length` lus dans l'index, puis `data[offset : offset+length]` dans le pack, décodé en WebP.

### 10.4. Format d'une brique (mosaïque WebP)
* Image **594×528**, niveaux de gris, **WebP sans perte**.
* C'est une **mosaïque 9×8** de 66 tranches de 66² : la tranche `s` (0..65) occupe la colonne `s % 9` et la ligne `s // 9`, soit l'origine `(col·66, row·66)`.
* **Reconstruction** côté viewer : la brique `66³` est lue à partir de cette grille ; sa cellule centrale `64³` (décalage d'un voxel) est la brique utile.
* La bordure est prise chez les voisins, ou répétée au bord du volume.

Format 2 (héritage) : mosaïque 8×8 de tranches 64², image `512×512`, manifeste `brickToPack`.

### 10.5. Plans XY (`planes/`)
Un fichier par z (`z00000.bin`, 5 chiffres) : en‑tête `LPLN`, puis des tuiles 512² **PNG en niveaux de gris** (filtre None, sans chunk auxiliaire). Un voxel d'une brique que le manifeste ne liste pas (ESS) vaut 0, donc plans et briques ne se contredisent jamais. Le manifeste (`lumen-planes-v1`) cite le `sha256` du manifeste des briques. Ce sont les coupes natives XY du Studio.

### 10.6. Maximums par couche (`mips/`)
Pour chaque couche de 64 plans (`l{k}.bin`, en‑tête `LMIP`) et chaque canal : le maximum voxel à voxel des plans de la couche, en résolution native XY, empaqueté comme les plans. Manifeste `lumen-mips-v1`.

### 10.7. Format 5
`--format 5` (SPEC Part III, §14) : `bricks/manifest.json` en `iribhm-bricks-v5` (`formatVersion` 5). Pour chaque niveau :
* **colonnes** `ll`, `b2`, `b4`, `q80`, `q50` (`ll` sans perte ; `b2` et `b4` à erreur bornée ; `q80` et `q50` avec perte), chacune dans son dossier `l{k}/{col}/c{c}/` et indexée par `index/{col}.bin` ;
* **plans** `xy/l{k}/`, `xz/l{k}/c{c}/`, `yz/l{k}/c{c}/` dans l'arbre des briques ;
* **coupes** `cuts/l{k}/` : briques de 32 × 32 × bz, groupées par super‑blocs 8×8×8.

Le niveau 0 des plans XY reste dans `planes/`. Les niveaux suivent la matrice `256·2ᵏ` de [§6.1](#61-détermination-des-niveaux-lod). La norme est dans `DOCS/dataset-migrations/SPEC.md`, Partie III.

### 10.8. Fichiers temporaires et arbres `live`
* `t{t:03d}_c{c}_lod{N}.bin` et `pack_t{t:03d}.json` : transitoires (§6.3).
* `processing_meta.json` : §6.3.
* Un dataset `live` range chaque arbre dans un sous‑dossier par timepoint : `bricks/t000/`, `planes/t000/`, `mips/t000/`, etc., chacun avec son `index.bin`.

---

## 11. Pourquoi ces choix de conception ?

Les justifications des paramètres *scientifiques* sont dans les étapes ci‑dessus (corner sampling, médian masqué, fond à 0…). Voici les grands choix d'**architecture** :

* **Pourquoi découper en briques (et streamer) ?** Un volume de 14 Go ne tient ni en RAM ni en VRAM. En le découpant, le viewer ne charge que les briques **visibles au zoom courant**, et libère les autres. C'est la seule façon d'avoir du 60 FPS sur des volumes multi‑Go dans un navigateur.

* **Pourquoi des briques de 64³, avec une bordure ?** 64³ est le compromis : assez **petit** pour un *Empty Space Skipping* fin et une pagination GPU efficace ; assez **grand** pour amortir le coût par brique. La **bordure d'un voxel** (66³) permet au viewer de filtrer au bord d'une brique sans couture, car le voisin est déjà présent dans la brique. Les 66 tranches se rangent dans une grille **9×8** de 72 cases (6 restent vides).

* **Pourquoi mosaïquer en une image 2D ?** Les navigateurs savent décoder des **images 2D** nativement et très vite (WebP via `createImageBitmap`, sur le GPU), mais n'ont **pas** de format d'image 3D. En rangeant les tranches d'une brique dans une seule image 2D, le navigateur décode tout un cube en **une seule passe**.

* **Pourquoi WebP sans perte (et pas JPEG ou PNG) ?** Donnée scientifique → **aucune perte tolérée** (JPEG corromprait les intensités). À qualité égale (sans perte), WebP est **bien plus compact** que PNG et se décode nativement dans le navigateur. Les colonnes avec perte du format 5 existent pour l'**affichage** ; ce qui se mesure lit toujours la colonne sans perte.

* **Pourquoi regrouper en packs par super‑blocs ?** Des milliers de petits fichiers = des milliers de requêtes HTTP = latence catastrophique. Un **pack** + un index `offset/length` ramène plusieurs briques en une requête. Un super‑bloc 4×4×4 entier reste dans un même pack, si bien qu'une coupe XZ ou YZ lit peu de packs.

* **Pourquoi un index binaire ?** Le manifeste JSON à liste de briques pesait 7,6 Mo sur un embryon de 3789² ; l'index binaire en pèse 233 ko, et le viewer le lit sans parser de texte.

* **Pourquoi un dataset à la fois, mais parallélisé en interne ?** Un seul canal pèse déjà ~10 Go en `float32` si on le tient entier, et plusieurs datasets simultanés feraient exploser la RAM. La parallélisation **par tuiles** (étape 2) et **par briques** (étape 3) sature les cœurs CPU **sans** multiplier les gros tampons mémoire.

* **Pourquoi publier d'un seul bloc ?** Un dataset publié ne doit jamais mêler les fichiers de deux runs, et une coupure en cours de route ne doit jamais le laisser incohérent ([§2.5](#25-publication-dun-dataset-tout-ou-rien)).

---

## 12. Déterminisme & reproductibilité exacte

Le pipeline est **déterministe** ; un même `.ims` redonne la **même donnée** :

* **Percentiles** (`np.percentile`) : déterministes, calculés sur des échantillons dont l'ordre et le découpage sont fixés.
* **Masque** (`binary_opening`/`binary_dilation`) : calculé par tuiles avec un **halo de 5 voxels** ; le résultat est identique au calcul sur le volume entier, quel que soit le budget de tuile (`LUMEN_PREPROCESS_TILE_MVOX`).
* **Médian par tuiles** : le halo donne à chaque voxel de cœur ses vrais voisins ; le résultat est **identique quel que soit le découpage**, donc **indépendant du nombre de cœurs**.
* **Niveaux de la pyramide** : moyennes en **arithmétique entière** (format 4 : `(somme + n//2) // n`), donc exactes et sans dépendance à l'ordre de calcul.
* **`executor.map`** préserve l'ordre des tuiles, des blocs et des briques.
* **WebP sans perte** : les données **décodées** sont toujours identiques. Les **octets** du `.webp` (et donc les hashes des packs) ne sont byte‑identiques que **pour une même version de libwebp** (embarquée dans Pillow) et les mêmes paramètres d'encodage (qualité 75, méthode 4 pour les briques). Pour une reproduction *byte‑à‑byte*, figer la version de Pillow (`requirements.txt`) ; pour une reproduction *scientifique* (valeurs des voxels), n'importe quelle version convient.
* **Parité avec la plateforme** : les formats 4 et 5 produits ici sont censés être **identiques** aux migrations `m004` et `m005` de la plateforme, qui partagent l'arithmétique ; des tests de parité du dépôt les tiennent ensemble.
* **Troncature `uint8`** : `(norm*255).astype(uint8)` tronque (≠ arrondi) — à respecter dans toute réimplémentation.

---

## 13. Table de référence des paramètres

| Paramètre | Valeur | Où | Effet |
|---|---|---|---|
| `bg_floor` (plancher de bruit) | **99ᵉ centile** des 8 coins (un timepoint) ; des coins de **toute la série** (timelapse) | `2-image_processor.py` Step 1 | point noir / seuil de fond |
| `corner_size` | `max(1, min(32, W//4, H//4, D//4))` | Step 1 | taille des cubes de coin |
| `sig_max` (point blanc) | **99.9ᵉ centile** de `vol[::4,::4,::4]` (un timepoint) ; des voxels au‑dessus de `bg_floor` (timelapse, si ≥ 1000) | Step 1 | saturation haute |
| Seuil du masque | `vol > bg_floor * 1.1` | Step 2 | sépare signal / fond |
| Ouverture morpho | `binary_opening(iterations=1)` | Step 2 | retire hot‑pixels isolés |
| Dilatation morpho | `binary_dilation(iterations=3)` | Step 2 | protège les bords du signal |
| Médian | `median_filter(size=3)` (3×3×3, `reflect`) | Step 3 | lisse le fond hors masque |
| Halo de tuile | **5 voxels** (`MASK_HALO`) | Step 2 | tuiles identiques au volume entier |
| Budget de tuile | **24 Mvoxels** (`DEFAULT_TILE_MVOX`), halo compris ; `LUMEN_PREPROCESS_TILE_MVOX` | `2-image_processor.py` | RAM par worker (~600 Mo par défaut) |
| Niveaux, format 4 | `level_ladder` : X, Y ÷ 2 ; Z ÷ 2 si `vz ≤ 1,5·max(vx′,vy′)` ; arrêt quand le grand côté ≤ **128** | `bricks_v3_writer.py` | pyramide v3 |
| Niveaux, format 5 | cibles `256·2ᵏ` < `max(X,Y)` ; **Z jamais réduit** | `format5.py` | matrice résolution × compression |
| Moyenne de niveau | entière, arrondie à la moitié supérieure (format 4) ; aire exacte (format 5) | `bricks_v3_writer.py`, `format5.py` | mipmapping |
| Taille de brique | `BRICK = 64` (cœur), stockée en **66³** (`APRON = 1`) | `bricks_v3_writer.py` | briques 64³ + bordure |
| Mosaïque | `9 × 8` tranches de 66² → **594 × 528** | `bricks_v3_writer.py` | empaquetage 2D |
| Encodage briques | **WebP sans perte** (qualité 75, méthode 4) | `bricks_v3_writer.py` | aucune perte |
| Packs | super‑blocs `4×4×4`, **≤ 64 briques ou 16 MiB** | `bricks_v3_writer.py` | taille des `.bin` |
| Index | `index.bin` (`LBIX`, version 1) | `bricks_v3_writer.py` | localisation binaire des briques |
| Seuil « cœur » ESS | **un voxel ≥ 1** dans le cœur 64³ (format 4) | `bricks_v3_writer.py` | Empty Space Skipping |
| Dilatation de briques | **aucune** | `bricks_v3_writer.py` | — |
| Plans XY | tuiles **512²** PNG niveaux de gris, un paquet par z | `planes_writer.py` | coupes natives |
| MIP par couche | **64** plans par couche | `mips_writer.py` | z‑stack natif |
| Histogrammes | 64 bins, range `(0,255)`, sur le LOD le plus petit, par timepoint | `3-chunk_packer.py` | aperçu d'intensité |
| Vignette | MIP fausses couleurs, LOD ≤ 1024 px, 512², WebP q=88 m=6 | `run_preprocess.py` | thumbnail |
| Parallélisme datasets | **séquentiel** (un dataset à la fois) | `run_preprocess.py` | RAM bornée |
| Parallélisme interne | `ProcessPoolExecutor(worker_count())` | étapes 2 & 3 | par tuiles / par briques |
| Nombre de workers | un par cœur logique, **61 au plus** sous Windows ; `LUMEN_PREPROCESS_WORKERS` | `run_preprocess.py` | taille des pools |

---

## 14. Checklist « recréer de zéro »

Pour réimplémenter et obtenir le **même résultat** (format 4) :

1. **Lire** le `.ims` comme HDF5 ; récupérer `X,Y,Z`, extents + `Unit` (convertis en µm), noms de canaux, timepoints (§3, §5). Recadrer `Data` à `(D,H,W)`.
2. **Par timepoint et par canal**, lire le volume **par tuiles** avec un halo de 5 voxels. Calculer `bg_floor` (99ᵉ centile des 8 coins) et `sig_max` (99.9ᵉ centile du volume `[::4]`) — ou, pour un timelapse, les bornes communes de la série (§6.2).
3. Construire le **masque** : `vol > bg_floor*1.1`, `binary_opening(1)`, `binary_dilation(3)` (structure 6‑connexe par défaut).
4. **Médian masqué** : `where(mask, vol, median_filter(vol, size=3))`, puis **window leveling** `clip(.,bg_floor,sig_max)`, `(.-bg_floor)/(sig_max-bg_floor)*255`, `astype(uint8)` (**troncature**).
5. Générer la **pyramide** (§6.1) : format 4 = `level_ladder` (X/Y ÷ 2, Z conditionnel, arrêt à 128), moyennes entières arrondies ; le LOD0 reste natif.
6. **Encoder les briques** : `66³` (64³ + bordure clamp‑to‑edge), mosaïque `9×8` → `594×528`, WebP sans perte (q75, m4) ; ne garder que les briques dont le cœur a un voxel ≥ 1 ; grouper par super‑blocs 4×4×4 en packs (≤ 64 briques ou 16 MiB) ; indexer dans `index.bin` ; hasher `sha256`.
7. Écrire `bricks/manifest.json` (schéma `iribhm-bricks-v3`, §10.2), **histogrammes** (64 bins) par timepoint, `planes/` et `mips/` (§10.5, §10.6), puis `metadata.json` (§9, §10.1) et `thumbnail.webp` (MIP fausses couleurs).
8. Publier le dossier de préparation d'un seul bloc (§2.5).
9. Respecter les détails de §12 (déterminisme : halo, troncature, ordre, WebP sans perte).

> Toute modification d'un paramètre de §13 **change la donnée de sortie** → bumper la version (`run_preprocess.py:__version__`) et ajouter un `changelog/changelog_X.Y.Z.md` (sections `[ADDED]`/`[OPTIMIZED]`/`[FIXED]`).

---

<div align="center">
<sub>Morgan CLIMENT — Lumen3D Microscopy Platform (développé pour l'IRIBHM · ULB) · pipeline de preprocessing v0.22.0</sub>
</div>
