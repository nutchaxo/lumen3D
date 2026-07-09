<div align="center">

# 🔬 Pipeline de Preprocessing — Lumen3D / IRIBHM

**De l'image brute du microscope `.ims` à un volume 3D fluide dans le navigateur.**

`version 0.14.1` · `Imaris HDF5 → briques 64³ WebP` · Python (h5py · numpy · scipy · Pillow)

</div>

---

## En bref (pour tout le monde)

Un microscope confocal qui photographie un embryon de souris produit un **volume 3D énorme** : des milliers d'images empilées, **plusieurs gigaoctets**, en 16 bits. Impossible de charger ça d'un coup dans un navigateur web — ni dans la mémoire vive, ni dans la carte graphique.

Ce pipeline résout le problème en transformant ce bloc géant en quelque chose de **streamable**, un peu comme **Google Maps mais pour un embryon en 3D** :

* on **nettoie** l'image (on enlève le bruit du capteur et le fond),
* on la découpe en **petits cubes** (« briques » de 64×64×64 voxels),
* on prépare **plusieurs niveaux de zoom** (basse résolution pour la vue d'ensemble, pleine résolution quand on s'approche),
* on **compresse** chaque cube sans aucune perte.

Au final, le visualiseur ne télécharge que les quelques briques **réellement visibles à l'écran**, au niveau de zoom courant. C'est ce qui permet d'explorer un volume de 14 Go à 60 images/seconde dans un onglet de navigateur.

> **Principe directeur du labo** : *zéro approximation sur la donnée scientifique.* Tout ce qui touche aux intensités est soit exact, soit explicitement documenté. La compression est **sans perte**, le débruitage ne touche **jamais** au signal biologique (seulement le fond).

---

## Le pipeline en une page

Cinq scripts s'enchaînent. Chacun fait une chose et la passe au suivant :

| # | Script | Ce qu'il fait, en clair |
|---|---|---|
| 1 | `1-ims_metadata.py` | **Lit la fiche d'identité** du volume (taille, nombre de canaux, taille d'un voxel en µm, noms des marqueurs fluorescents). |
| 2 | `2-image_processor.py` | **Nettoie et normalise** : estime le fond, le supprime, lisse le bruit *sans flouter les cellules*, ramène le 16 bits en 8 bits, et fabrique la pyramide de zooms. |
| — | `build_thumbnail()` | **Fabrique la vignette** (une projection colorée pour l'aperçu dans le catalogue). |
| 3 | `3-chunk_packer.py` | **Découpe en briques 64³**, jette les briques vides, compresse en WebP, et regroupe tout en gros paquets. |
| 4 | `4-catalog_generator.py` | **Écrit les fiches finales** (`metadata.json`, histogrammes) que la plateforme lit pour afficher et calibrer le dataset. |

```
  <dataset>.ims  (Imaris HDF5, uint16, multi-Go)
        │
        ▼
 ┌──────────────────────┐
 │ 1-ims_metadata.py    │  lit les attributs HDF5
 └──────────┬───────────┘
            ▼  meta.json  {width,height,depth,n_channels,n_timepoints,voxel_size,channel_names}
 ┌──────────────────────┐
 │ 2-image_processor.py │  débruitage masked-median + window leveling + pyramide LOD
 └──────────┬───────────┘
            ▼  temp/t000_c{C}_lod{N}.bin  (volumes uint8 bruts, par canal × par LOD)
            ▼  temp/processing_meta.json
 ┌──────────────────────┐
 │ build_thumbnail()    │  MIP fausses couleurs → thumbnail.webp
 └──────────┬───────────┘
            ▼
 ┌──────────────────────┐
 │ 3-chunk_packer.py    │  64³ → mosaïque 512² → WebP lossless → packs .bin + manifest.json
 └──────────┬───────────┘
            ▼  fixed/<nom>/bricks/{manifest.json, lod{N}/c{C}/pack_{NN}.bin}
 ┌──────────────────────┐
 │ 4-catalog_generator. │  histogrammes (injectés dans manifest) + metadata.json
 └──────────┬───────────┘
            ▼  fixed/<nom>/metadata.json   (+ histogrammes dans bricks/manifest.json)

  Le dossier temp/ (.temp_preprocess_<nom>) est supprimé en fin de traitement.
  catalog.json racine est ensuite régénéré dynamiquement par dev_server.py (scan des metadata.json).
```

---

## Glossaire express

| Terme | Définition courte |
|---|---|
| **Voxel** | Pixel en 3D — l'unité élémentaire du volume. Sa taille physique (en µm) vient des métadonnées Imaris. |
| **Canal** | Une longueur d'onde / un marqueur fluorescent (ex. DAPI = noyaux, Pecam1 = vaisseaux). Traité indépendamment. |
| **Brique** *(brick)* | Petit cube de **64³ voxels** — l'unité de streaming. Le viewer ne charge que les briques visibles. |
| **LOD** *(Level Of Detail)* | Niveau de la pyramide de zoom. LOD0 = pleine résolution ; chaque LOD suivant est deux fois plus petit en X/Y. |
| **ESS** *(Empty Space Skipping)* | On ne stocke **pas** les briques vides (que du fond noir). Énorme économie de mémoire/VRAM. |
| **Window Leveling** | Étirement linéaire des intensités entre un point noir et un point blanc — la conversion 16 bits → 8 bits. |
| **MIP** *(Maximum Intensity Projection)* | Projette le volume sur un plan en gardant le voxel le plus brillant — sert à la vignette. |
| **Mosaïque** | Les 64 tranches d'une brique rangées en grille 8×8 dans **une seule image 2D** (512²), pour être décodées par le navigateur. |
| **Pack** | Un gros fichier `.bin` qui contient ~128 briques compressées bout à bout (au lieu de milliers de petits fichiers). |

---

## Table des matières
1. [Prérequis & environnement](#1-prérequis--environnement)
2. [Exécution : lanceur autonome `.bat` ou CLI](#2-exécution)
3. [Contrat d'entrée : structure du fichier `.ims` (Imaris HDF5)](#3-contrat-dentrée--structure-du-fichier-ims-imaris-hdf5)
4. [Carte des fichiers](#4-carte-des-fichiers)
5. [Étape 1 — Extraction des métadonnées](#5-étape-1--extraction-des-métadonnées-1-ims_metadatapy)
6. [Étape 2 — Traitement & débruitage](#6-étape-2--traitement--débruitage-2-image_processorpy)
7. [Étape intermédiaire — Vignette MIP](#7-étape-intermédiaire--vignette-mip)
8. [Étape 3 — Découpe en briques & packs](#8-étape-3--découpe-en-briques--packs-3-chunk_packerpy)
9. [Étape 4 — Histogrammes & `metadata.json`](#9-étape-4--histogrammes--metadatajson-4-catalog_generatorpy)
10. [Formats de sortie (référence)](#10-formats-de-sortie-référence)
11. [Pourquoi ces choix de conception ?](#11-pourquoi-ces-choix-de-conception-)
12. [Déterminisme & reproductibilité exacte](#12-déterminisme--reproductibilité-exacte)
13. [Table de référence des paramètres](#13-table-de-référence-des-paramètres)
14. [Checklist « recréer de zéro »](#14-checklist--recréer-de-zéro-)

---

## 1. Prérequis & environnement

> 🚀 **Avec le lanceur `run_preprocess.bat` ([§2.1](#2-exécution)), vous n'avez rien à installer** : il fournit lui‑même un Python local **et** les dépendances. Les prérequis ci‑dessous ne concernent que l'usage **manuel** (CLI §2.2 ou réimplémentation).

* **Python ≥ 3.10** (testé 3.14.3 sur Windows).
* Dépendances Python :

  | Paquet | Usage |
  |---|---|
  | `h5py` | lecture du conteneur HDF5 `.ims` |
  | `numpy` | tout le calcul vectorisé |
  | `scipy` | `scipy.ndimage.median_filter`, `binary_opening`, `binary_dilation` |
  | `Pillow` (PIL) | redimensionnement bilinéaire des LOD, encodage **WebP lossless**, vignette |
  | `tqdm` | barres de progression |

  ```bash
  pip install h5py numpy scipy Pillow tqdm
  ```

  (Un [`requirements.txt`](requirements.txt) est fourni pour `pip install -r` — il liste exactement ces 5 paquets, comme la constante `DEPS` du lanceur. 💡 Ou laissez le lanceur **`run_preprocess.bat`** ([§2.1](#2-exécution)) fournir Python **et** ces dépendances pour vous.)

  > ⚠️ `scikit-image` n'est **plus** nécessaire (les imports Otsu/morphologie skimage de l'ancienne version ont été supprimés en v0.13.0). Seul `scipy.ndimage` est utilisé pour la morphologie/le médian.

* **Dépendance optionnelle** : `tifffile` — uniquement pour l'export **OME‑TIFF** du dossier `download/` (option `--with-downloads`, [§2.2](#22-en-ligne-de-commande-cli)). Le lanceur `.bat` l'installe **automatiquement à la demande** si l'option est choisie ; en usage CLI manuel, `pip install tifffile`.
* **RAM** : l'étape 2 charge **tout le volume d'un canal en `float32`** (`D×H×W×4` octets). Ex. 3789×3789×178 ≈ **10.2 Go/canal**, pic ~32 Go avec masque + blocs + sortie. Prévoir large (machine de référence : 128 Go / 20 cœurs).
* **CPU** : l'étape 2 (médian) et l'étape 3 (WebP) parallélisent sur `os.cpu_count()` via `ProcessPoolExecutor`. Le résultat est **indépendant** du nombre de cœurs (voir §12).

---

## 2. Exécution

Deux façons de lancer le pipeline : le **lanceur autonome `.bat`** (zéro installation — recommandé) ou la **ligne de commande** (pour scripter / réimplémenter).

### 2.1. Lanceur autonome `run_preprocess.bat` *(recommandé)*

> **Un seul fichier suffit.** Le `.bat` est **auto‑suffisant** : on peut le copier **seul** sur n'importe quel PC Windows — même **sans Python et sans le dépôt** — et il met tout en place. Les **6 scripts** — les 5 du pipeline (`run_preprocess.py` + `1-`→`4-`) plus l'outil optionnel de bundles `download/` (`build_download_bundles.py`) — y sont **embarqués** (encodés en base64) ; s'il n'y a pas de Python, il en **télécharge et installe un, en local**.

**Utilisation : double‑cliquer sur [`run_preprocess.bat`](run_preprocess.bat).** Il déroule **5 étapes** automatiques :

| Étape | Ce qu'il fait |
|---|---|
| **[1/5]** Scripts | Extrait les **6 scripts** embarqués (les 5 du pipeline + `build_download_bundles.py`, décodage `certutil`, intégrité vérifiée par **SHA‑256**). S'ils sont **déjà présents** à côté du `.bat`, ils sont **conservés** (on peut donc exécuter une version modifiée). |
| **[2/5]** Python | Détection en cascade : runtime local `.runtime\python` → Python **système** (`py -3`/`python`/`python3`) → sinon **propose d'installer** un **Python 3.12.8 embarquable** (téléchargé depuis python.org dans `.runtime\python`, avec `pip`). Isolé, **sans droits admin**, supprimable. |
| **[3/5]** Dépendances | Vérifie `numpy`/`Pillow`/`h5py`/`scipy`/`tqdm` (par import) et **propose de les installer** via `pip`. |
| **[4/5]** Paramètres | Pose **4 questions** (voir ci‑dessous), affiche un **récapitulatif**, demande confirmation. |
| **[5/5]** Exécution | Lance le pipeline avec une **interface colorée** et la **progression en temps réel**. `Ctrl+C` demande une **confirmation** avant d'arrêter (arrêt propre — voir « Orchestration interne » plus bas). |

Les **4 questions** de l'étape [4/5] :

| Question | Quoi saisir |
|---|---|
| Dossier des `.ims` | Le chemin du dossier d'entrée. Validé : il doit exister, et le **nombre de `.ims`** trouvés est affiché. |
| Dossier de sortie `DATA_WEB` | **Entrée** ⏎ = valeur par défaut `..\DATA_WEB`. Ou un autre chemin. |
| Filtre optionnel *(glob)* | Ex. `*E8*` pour ne traiter que certains embryons. **Entrée** ⏎ = tous les fichiers. |
| Générer aussi `download/` ? | `o` / **N** (défaut : non). Si `o`, `tifffile` est installé au besoin et `--with-downloads` est passé au pipeline (archive `_web.zip`, `.ims` original, OME‑TIFF, MIP par canal, `README.txt`). **Lourd** : relit le `.ims`. |

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
python run_preprocess.py --input <dossier_des_ims> --output <DATA_WEB> [--only "<glob>"] [--with-downloads]
```

| Argument | Obligatoire | Rôle |
|---|---|---|
| `--input`  | oui | Dossier contenant un ou plusieurs `.ims` (recherche **non récursive** : `input_dir.glob("*.ims")`). |
| `--output` | oui | Racine `DATA_WEB` de la plateforme. La sortie ira dans `<output>/fixed/<nom_du_ims_sans_extension>/`. |
| `--only`   | non | Filtre `fnmatch` sur le **nom de fichier** (ex. `"*Em7*"` ou le nom exact). Sans lui : tous les `.ims`. |
| `--with-downloads` | non | Après chaque dataset, construit aussi son dossier `download/` via `tools/build_download_bundles.py` (archive `_web.zip`, `.ims` original en hardlink, OME‑TIFF calibré, MIP PNG par canal, `README.txt`). Étape lourde : relit le `.ims`. Nécessite `tifffile`. |

Exemple réel (1 dataset) :

```bash
python run_preprocess.py \
  --input  "D:/RAW_DATA/done" \
  --output "C:/.../WebPlatform/DATA_WEB" \
  --only   "Egfl7eGFP-E8-Em7-18112025-GFP555-Pecam1-10x-2xzoom-4avg.ims"
```

> Sur Windows, si `python` est intercepté par l'alias Microsoft Store, utiliser le launcher `py`.

**Orchestration interne** (`run_preprocess.py`) :
* **Un dataset à la fois**, en boucle séquentielle sur le thread principal (pour économiser la RAM ; le parallélisme est *intra*‑dataset — voir [§11](#11-pourquoi-ces-choix-de-conception-)).
* Le **nom du dataset** = `Path(ims).stem` (nom du fichier sans `.ims`).
* `temp_dir = <output>/.temp_preprocess_<nom>` : recréé à neuf à chaque run, **supprimé en fin de traitement** (même en cas d'erreur).
* `dataset_output_dir = <output>/fixed/<nom>` : si un `bricks/` existe déjà, il est supprimé avant de régénérer.
* Ordre des étapes : **1 → 2 → vignette → 3 → 4**, puis — **uniquement si `--with-downloads`** — `build_download_bundles.py` **après l'étape 4** (pour que `metadata.json` existe déjà). Chaque étape tourne dans un **sous‑processus isolé** (`subprocess.Popen`, nouveau groupe de processus : `CREATE_NEW_PROCESS_GROUP` Windows / `start_new_session` POSIX).
* **Arrêt propre sur `Ctrl+C`** : l'orchestrateur intercepte `SIGINT` et **demande confirmation**. *Refus* → le traitement **reprend** sans perte (l'étape en cours n'a pas reçu le signal) ; *confirmation* → l'étape **et tout son pool de workers** sont arrêtés (`taskkill /F /T` / `killpg`), les `.temp_preprocess_*` nettoyés, sortie en code **130**.

### 2.3. Régénérer le lanceur (`build_launcher.py`)

Le `.bat` est **généré**, jamais écrit à la main. Après toute modification d'un script `.py` ou du template, régénère‑le :

```bash
python build_launcher.py
```

* [`build_launcher.py`](build_launcher.py) lit le template [`launcher_template.bat.in`](launcher_template.bat.in), y injecte la configuration (la version est lue dans `run_preprocess.py:__version__`, la version de Python embarquable, la liste des scripts) et **ré‑embarque** les **6 scripts** en base64 (blocs `#<index>#…`, 76 caractères/ligne).
* L'**ordre d'embarquement est figé** (`run_preprocess.py` = index 0, puis `1-`→`4-` en index 1‑4, et `build_download_bundles.py` en **index 5**, tiré de `../tools/`) : le `.bat` extrait le bloc *N* pour le *N*ᵉ nom de sa liste interne.
* Sortie en **ASCII + CRLF** (ce que `cmd.exe` préfère).

---

## 3. Contrat d'entrée : structure du fichier `.ims` (Imaris HDF5)

Un `.ims` est un conteneur **HDF5** (un format de fichier scientifique hiérarchique, comme un système de fichiers à l'intérieur d'un fichier). Le pipeline lit cette arborescence (les chunks HDF5 sont typiquement compressés **gzip**) :

```
/DataSetInfo/
    Image/                       (attributs, valeurs stockées en tableaux d'octets ASCII)
        X, Y, Z                  → width, height, depth  (entiers en texte)
        ExtMin0, ExtMax0         → étendue physique en X (µm)
        ExtMin1, ExtMax1         → étendue physique en Y
        ExtMin2, ExtMax2         → étendue physique en Z
    Channel 0/, Channel 1/, …    (un groupe par canal)
        Name                     → nom du canal (ex. "DAPI"), nettoyé (voir §5)
/DataSet/
    ResolutionLevel 0/           (on n'utilise QUE le niveau 0, pleine résolution)
        TimePoint 0/             (datasets "fixed" : 1 seul timepoint)
            Channel 0/Data       → tableau 3D uint16, shape (Zpad, Ypad, Xpad)
            Channel 1/Data       …
        TimePoint 1/ …           (si timelapse)
    ResolutionLevel 1..N/        (pyramide native d'Imaris — IGNORÉE, on régénère nos propres LOD)
```

Détails importants :
* Le tableau `Data` peut être **paddé** (ex. dims réelles 178×3789×3789 mais `Data.shape = (184, 3840, 3840)` à cause du chunking HDF5). On recadre toujours via `ds[:D, :H, :W]` avec `(D,H,W)` issus des attributs `Z,Y,X`.
* Ordre des axes du `Data` : **(Z, Y, X)** (C‑order). `dtype = uint16`.
* `width = X`, `height = Y`, `depth = Z`.
* **Voxel** : `voxel_x = (ExtMax0 - ExtMin0) / X`, idem Y/Z. Arrondi à 6 décimales.
* TimePoints triés par l'entier final (`"TimePoint 12"` → 12). Canaux idem (`"Channel 3"` → 3).

> **Pourquoi ignorer la pyramide native d'Imaris ?** Imaris stocke déjà des niveaux de résolution, mais ils ne correspondent ni à notre format de briques, ni à notre nettoyage. On régénère tout à partir du `ResolutionLevel 0` (la donnée brute) pour garder la **maîtrise totale** de la qualité et de la géométrie.

---

## 4. Carte des fichiers

| Fichier | Rôle | Entrée | Sortie |
|---|---|---|---|
| [`run_preprocess.bat`](run_preprocess.bat) | **Lanceur autonome** Windows (scripts embarqués, Python local au besoin, install deps, saisie guidée). **Généré — ne pas éditer.** | double‑clic | extrait + appelle `run_preprocess.py` |
| [`build_launcher.py`](build_launcher.py) | **Générateur** du `.bat` (ré‑embarque les scripts en base64, injecte la version). | les 5 `.py` + `../tools/build_download_bundles.py` + le template | `run_preprocess.bat` |
| [`launcher_template.bat.in`](launcher_template.bat.in) | Template du lanceur (logique batch + emplacements `@@@…@@@`). | — | — |
| [`run_preprocess.py`](run_preprocess.py) | Orchestrateur + vignette. `__version__` du pipeline. | `--input`, `--output`, `--only`, `--with-downloads` | appelle 1→4 (+ download optionnel) ; écrit `thumbnail.webp` |
| [`requirements.txt`](requirements.txt) | Dépendances Python épinglées (pour `pip install -r`, usage manuel). | — | — |
| [`1-ims_metadata.py`](1-ims_metadata.py) | Lit les attributs HDF5. | `<ims>`, `<out.json>` | `meta.json` |
| [`2-image_processor.py`](2-image_processor.py) | Débruitage + normalisation 8‑bits + pyramide LOD. | `<ims>`, `<meta.json>`, `<temp>` | `temp/t*_c*_lod*.bin`, `temp/processing_meta.json` |
| [`3-chunk_packer.py`](3-chunk_packer.py) | Découpe 64³, mosaïque, WebP lossless, packs. | `<temp>`, `<out_dir>` | `out/bricks/manifest.json`, `out/bricks/lod*/c*/pack_*.bin` |
| [`4-catalog_generator.py`](4-catalog_generator.py) | Histogrammes + `metadata.json`. | `<temp>`, `<out_dir>` | `out/metadata.json` (+ histogrammes injectés dans `manifest.json`) |
| [`../tools/build_download_bundles.py`](../tools/build_download_bundles.py) | **Optionnel** (`--with-downloads`) — construit le dossier `download/` d'un dataset. Embarqué à l'**index 5** du lanceur ; résolu par `run_preprocess.py` dans `../tools/` ou à côté de lui. | `--data-web`, `--raw-dir`, `--datasets` | `fixed/<nom>/download/` (`_web.zip`, `.ims`, OME‑TIFF, MIP, `README.txt`) |
| [`changelog/`](changelog/) | Historique versionné de l'outil. | — | — |

---

## 5. Étape 1 — Extraction des métadonnées (`1-ims_metadata.py`)

> **En clair** : avant de toucher aux pixels, on lit la « fiche technique » du volume — combien de voxels, combien de canaux, quelle taille réelle fait un voxel en micromètres, et comment s'appellent les marqueurs. Tout le reste du pipeline en dépend.

**Appel :** `python 1-ims_metadata.py <input.ims> <output.json>`

**Algorithme :**
1. Ouvrir le HDF5. Lire `DataSetInfo/Image` → `X,Y,Z` (entiers), `ExtMin{0,1,2}`/`ExtMax{0,1,2}` (flottants). Les attributs Imaris sont des **tableaux d'octets ASCII** → décodés via un helper `attr_str` (gère `bytes`, `np.bytes_`, `np.ndarray` de caractères).
2. `voxel = (ExtMax − ExtMin) / dim`, arrondi `round(.,6)`. *(C'est la calibration physique : elle rend les mesures de distance dans le viewer exactes en µm.)*
3. Énumérer `DataSet/ResolutionLevel 0/TimePoint *` (triés) → `n_timepoints`. Sur le 1ᵉʳ timepoint, énumérer `Channel *` → `n_channels`.
4. Noms de canaux : `DataSetInfo/Channel i` attribut `Name`. Nettoyage : on coupe au 1ᵉʳ `\x00` (`re.sub(r'\x00.*','',name)`), `strip()`. Si vide **ou** si ça matche `^ch(annel)?\s*\d+$` (insensible casse) → fallback `"Channel {i+1}"`.

**Sortie `meta.json` :**
```json
{
  "width": 3789, "height": 3789, "depth": 178,
  "n_channels": 4, "n_timepoints": 1,
  "voxel_size": { "x": 0.430366, "y": 0.430366, "z": 2.057107 },
  "channel_names": ["DAPI", "eGFP", "GFP", "Pecam1"]
}
```

---

## 6. Étape 2 — Traitement & débruitage (`2-image_processor.py`)

> **En clair** : c'est le cœur scientifique. L'image brute du microscope contient du **bruit de capteur** et un **fond diffus** qui parasitent la visualisation. Cette étape sépare le *signal biologique* (l'embryon) du *fond*, lisse uniquement le fond (sans jamais flouter les cellules), puis « étire » les intensités pour exploiter toute la plage 8 bits. Enfin elle fabrique la pyramide de zooms. C'est l'étape la plus lourde (RAM + CPU).

**Appel :** `python 2-image_processor.py <input.ims> <meta.json> <temp_dir>`

### 6.1. Détermination des niveaux LOD
* **LOD 0** = résolution native `W×H×D` (non carrée, non puissance de 2 — fidélité maximale).
* LOD ≥ 1 : carrés en puissances de 2. On construit `target_dims` en partant de **256** et en doublant tant que `< max(W,H)`, puis on **inverse** :
  ```python
  curr = 256; target_dims = []
  while curr < max(W,H): target_dims.append(curr); curr *= 2
  target_dims.reverse()      # ex. W=H=3789 → [2048, 1024, 512, 256]
  ```
  → LOD1=2048², LOD2=1024², LOD3=512², LOD4=256².
* **La profondeur `D` (axe Z) est conservée identique sur tous les LOD** (jamais sous‑échantillonnée en Z).

> **Pourquoi garder la résolution Z sur tous les niveaux ?** Un stack confocal est déjà *grossier* en Z (peu de tranches, espacées de plusieurs µm) alors qu'il est fin en X/Y. Réduire le Z détruirait le peu de détail axial existant et déformerait l'embryon lors des rotations. On ne sous‑échantillonne donc **que** le plan X/Y.

### 6.2. Traitement, **par timepoint × par canal**
On lit le volume natif entier : `vol = ds[:D,:H,:W].astype(float32)` (axes `(D,H,W)`).

**Step 1 — Estimation des bornes (Corner Sampling).**
* `corner_size = max(1, min(32, W//4, H//4, D//4))`.
* On extrait les **8 coins** du volume (cubes `corner_size³`), on les concatène.
* `bg_floor = percentile(coins, 99.0)` — le **plancher de bruit** : 99ᵉ centile du fond caméra pur (les coins ne contiennent jamais d'embryon).
* `sig_max = percentile(vol[::4,::4,::4], 99.9)` — le **point blanc** : 99.9ᵉ centile du volume **sous‑échantillonné ×4** (rapide, peu de RAM ; sature le 0.1 % le plus lumineux).

> **Pourquoi échantillonner les coins ?** L'embryon est toujours centré : les 8 coins du volume sont donc un échantillon **propre et non biaisé** du bruit pur du capteur, sans qu'on ait besoin d'un seuil fixe arbitraire.
> **Pourquoi le 99ᵉ centile (et pas la moyenne) ?** Pour être robuste aux pics de bruit : on place le point noir juste **au‑dessus** de la quasi‑totalité du fond, garantissant qu'il s'effondrera à 0.
> **Pourquoi des centiles plutôt qu'un seuil fixe ?** Chaque acquisition a un gain/une exposition différents. Les centiles s'adaptent automatiquement (auto‑leveling) : le pipeline marche sur n'importe quel `.ims` sans réglage manuel.

**Step 2 — Masque de signal** (opérations 3D sur tout le volume) :
```python
mask = vol > (bg_floor * 1.1)               # seuil 10 % au-dessus du plancher
mask = binary_opening(mask, iterations=1)   # éjecte les hot-pixels isolés
mask = binary_dilation(mask, iterations=3)  # protège le fondu fluorescent autour du signal
```
* Structure morphologique : **défaut scipy** = `generate_binary_structure(3, 1)` (croix 6‑connexe).

> **Pourquoi ouverture *puis* dilatation ?** L'**ouverture** retire les pixels morts hyper‑lumineux **isolés** (hot‑pixels du capteur) : sinon ils seraient pris pour du signal et « protégés ». Une fois retirés du masque, ils subiront le médian + le window leveling et tomberont à 0. La **dilatation** (×3) élargit ensuite le masque autour du vrai signal pour préserver le **fondu fluorescent naturel** des bords — on ne veut jamais que le filtre morde dans une cellule.

**Step 3 — Filtrage médian masqué + Window Leveling** (parallèle par blocs Z) :
* Découpage Z : `z_chunk_size = max(4, D // (cpu_count*2))`. Chaque bloc `[z_start, z_end)` reçoit un **halo de ±1 tranche** afin que le médian 3D voie de vrais voisins aux jointures.
* Chaque bloc (`block_data`, `block_mask`, avec halo) part dans un worker `process_z_block` :
  ```python
  smoothed  = median_filter(block_data, size=3)           # médian 3D 3×3×3 (mode 'reflect')
  composite = np.where(block_mask, block_data, smoothed)  # signal net DANS le masque, fond lissé DEHORS
  clean     = np.clip(composite, bg_floor, sig_max)
  norm      = (clean - bg_floor) / (sig_max - bg_floor)   # garde-fou : si sig_max<=bg_floor → sig_max = bg_floor+1
  block_u8  = (norm * 255.0).astype(uint8)                # troncature (pas d'arrondi)
  # on retire le halo avant réassemblage
  ```
* Conséquence : tout voxel `≤ bg_floor` devient **0 absolu** en `uint8`.

> **Pourquoi un médian *masqué* et pas un flou global ?** Un flou (gaussien ou médian) appliqué partout abîmerait les **arêtes des cellules**. Ici, le masque protège le signal : on garde le signal **net** là où il compte, et on ne lisse que le **fond bruité**. C'est du débruitage *edge‑preserving*.
> **Pourquoi un filtre médian (et pas gaussien) ?** Le médian supprime le *shot‑noise* (grains isolés) tout en préservant les contours — un gaussien, lui, étalerait tout. C'est un choix assumé depuis la v0.12.1.
> **Pourquoi écraser le fond à exactement 0 ?** Le visualiseur additionne les intensités sur des centaines de tranches Z (*additive blending*). Un fond résiduel à 1 ou 2 s'accumulerait en un **voile gris**. Un 0 absolu = vide parfaitement noir, **et** ça permet à l'étape 3 de jeter les briques vides (ESS).

**Step 4 — Export des LOD** (par tranche Z) :
* LOD0 : on écrit `vol_u8[z].tobytes()` brut.
* LOD ≥ 1 : `PIL.Image.fromarray(slice, 'L').resize((w,h), BILINEAR)` puis `.tobytes()`. **Downscale 2D bilinéaire X/Y uniquement**, Z préservé.

### 6.3. Sorties de l'étape 2 (dans `temp_dir`)
* `t{t:03d}_c{c}_lod{N}.bin` — **volume `uint8` brut, sans en‑tête**, C‑order, shape `(D, H_lod, W_lod)`. Un fichier par (timepoint, canal, LOD).
* `processing_meta.json` :
  ```json
  {
    "lod_levels": [ {"lod":0,"width":3789,"height":3789,"depth":178}, {"lod":1,"width":2048,...}, ... ],
    "voxel_size": {...}, "channel_names": [...],
    "width": 3789, "height": 3789, "depth": 178,
    "n_channels": 4, "n_timepoints": 1
  }
  ```

---

## 7. Étape intermédiaire — Vignette MIP

> **En clair** : la petite image d'aperçu que tu vois dans le catalogue. On « aplatit » le volume en gardant le point le plus brillant le long de Z, on colore chaque canal, et on superpose le tout.

Fonction `build_thumbnail()` **dans `run_preprocess.py`** (pas un script séparé), appelée entre l'étape 2 et l'étape 3.

* Choix du LOD source : premier LOD avec `max(width,height) ≤ 1024` (vitesse).
* Pour chaque canal : charge `temp/t000_c{C}_lod{target}.bin` (`np.fromfile`, reshape `(D,h,w)`), calcule la **MIP** `vol.max(axis=0)`.
* Composite **fausses couleurs additif** : pour le canal *i*, `composite += (mip/255) × THUMB_COLORS[i % 7]` (RGB), puis `clip(0,255) → uint8`.
* `THUMB_COLORS` = `[(0,255,102),(255,61,255),(47,107,255),(255,48,48),(255,255,0),(255,0,255),(0,255,255)]`.
* Redimensionne pour tenir dans **512×512** (LANCZOS, ratio préservé), centre sur un fond carré `(8,10,18)` (`#080A12`).
* Enregistre `fixed/<nom>/thumbnail.webp` en `WEBP quality=88 method=6`.

---

## 8. Étape 3 — Découpe en briques & packs (`3-chunk_packer.py`)

> **En clair** : on prend les volumes nettoyés et on les débite en petits cubes de 64³. On **jette les cubes vides** (ils ne contiennent que du noir), on **compresse** les autres sans perte, et on les **regroupe** en gros fichiers pour éviter des milliers de petites requêtes réseau.

**Appel :** `python 3-chunk_packer.py <temp_dir> <output_dir>`

Constantes : `BRICK_SIZE = 64`, `CHUNKS_PER_PACK = 128`, mosaïque `8×8` (= 512²).

**Pour chaque LOD** (lu depuis `processing_meta.json`) :

1. **Grille de briques** : `nx = ceil(W/64)`, `ny`, `nz`. Pour chaque brique `(bx,by,bz)` on note `min=[ox,oy,oz]`, `max=[ox+ew,oy+eh,oz+ed]` (bord tronqué), `validVoxelCount = ew·eh·ed`.

2. **Empty Space Skipping (ESS), 2 passes :**
   * **Cœur** : une brique est « core » si, pour **au moins un canal**, `max(brique) > BACKGROUND_THRESHOLD` (= **0** ; rappel : l'étape 2 a mis le vide à 0 absolu). Lecture via `np.memmap` du `.bin` du canal.
   * **Dilatation 26‑voisins** : on ajoute aux cœurs toutes les briques voisines (fenêtre `3×3×3` en indices de briques) → `active_coords`. → `active_chunks_grid`.

   > **Pourquoi dilater les briques actives ?** Pour garder une marge autour du signal et éviter une **coupure brutale** visible (le fluorescent s'estompe progressivement ; on conserve une couronne de briques au cas où).

3. **Encodage, par canal × par brique active :**
   * Lire le sous‑volume `64³` (zero‑paddé si bord).
   * `occ = count_nonzero / validVoxelCount`. **Si `occ ≤ 0.0005` → brique vide, ignorée** (non écrite).
   * Sinon : **mosaïque 512²** — la tranche `z` (0..63) va en `mosaic[(z//8)*64:(z//8+1)*64, (z%8)*64:(z%8+1)*64]` (grille 8×8, *row‑major*).
   * **Encodage `WebP lossless`** (`PIL Image.save(buf, "WEBP", lossless=True)`), niveaux de gris (mode L).
   * Écriture **append** dans `pack_{NN}.bin` (≤ 128 briques/pack ; rollover quand plein). On mémorise `offset` et `length` de chaque brique.
   * `occupancy_union[brique] = max sur les canaux` (pour le manifest).

4. **Hash** : `sha256` de chaque pack terminé → `packHashes` (sert au contrôle d'intégrité côté viewer).

**Sortie :** `output_dir/bricks/`
* `lod{N}/c{C}/pack_{NN}.bin` — concaténation brute de flux WebP (sans séparateur ; on extrait via offset+length).
* `manifest.json` — voir §10.2 (les `histograms` y sont **vides** ici, remplis à l'étape 4).

---

## 9. Étape 4 — Histogrammes & `metadata.json` (`4-catalog_generator.py`)

> **En clair** : on écrit les deux « fiches » que la plateforme lit. Les **histogrammes** d'intensité (pour régler les curseurs de contraste) et le **`metadata.json`** (dimensions, calibration physique, couleurs des canaux, stade de l'embryon).

**Appel :** `python 4-catalog_generator.py <temp_dir> <output_dir>`

1. **Histogrammes** (sur le LOD **le plus petit** = `lod_levels[-1]`, pour la vitesse/RAM) : pour chaque canal, `np.histogram(vol_uint8, bins=64, range=(0,255))` → `counts` (64), `edges` (65), plus `total`, `max`, `mean`, `std`, `backgroundFloor=0`. **Injectés dans `bricks/manifest.json`**.
2. **Calibration physique** : `physicalSizeUm = {x: W·vx, y: H·vy, z: D·vz, sliceThickness: vz, voxelX/Y/Z}`. `calibrationStatus = "exact"` si les 3 voxels sont non nuls, sinon `"metadata-missing"`.
3. **Parsing du nom de dossier** :
   * Stade : regex `-(E(\d(?:\.?\d+)?))($|-)` puis `^(E…)` → `display` (`"E8"`, ou `"E8.5"`) et `numeric` (`8.0` / `8.5`). Sinon `("Unknown", 0.0)`.
   * Embryon : `-(Em\d+)-` → ex. `"Em7"`, sinon `null`.
4. **Canaux** : couleur par défaut depuis `COLORS = ["#00FF00","#00AAFF","#FF00FF","#FF0000","#FFFF00","#00FFFF"]`, `min=0, max=1, gamma=1`.
5. Écrit `output_dir/metadata.json` (voir §10.1).

> Les réglages d'affichage (`gamma`, `min`, `max`, `active`, couleurs ajustées, `exposure`, `orientation`) sont ensuite **éditables via le panneau admin** (`admpan.js` → API `dev_server.py`), qui réécrit `metadata.json`. Le générateur ne produit que les valeurs par défaut.

---

## 10. Formats de sortie (référence)

Arborescence finale d'un dataset :

```
DATA_WEB/fixed/<nom>/
├── metadata.json          # config dataset (dims, voxels, canaux, volumeSources)
├── thumbnail.webp         # vignette MIP fausses couleurs 512²
├── bricks/
│   ├── manifest.json      # index des briques + packs + histogrammes
│   ├── lod0/c0/pack_00.bin, pack_01.bin, …
│   ├── lod0/c1/…  …  (un sous-dossier par canal)
│   └── lod1/…  lod2/…  lod3/…  lod4/…
└── download/              # OPTIONNEL (--with-downloads) : _web.zip, .ims original,
                           #   OME-TIFF calibré, MIP PNG par canal, README.txt
```

### 10.1. `metadata.json`
```json
{
  "id": "fixed/<nom>", "name": "<nom>", "type": "fixed",
  "stage": "E8", "stageNumeric": 8.0, "embryo": "Em7",
  "dimensions": { "x": 3789, "y": 3789, "z": 178, "c": 4, "t": 1 },
  "voxel_size": { "x": 0.430366, "y": 0.430366, "z": 2.057107 },
  "physicalSizeUm": { "x": 1630.65, "y": 1630.65, "z": 366.16,
                      "sliceThickness": 2.057107, "voxelX": 0.430366, "voxelY": 0.430366, "voxelZ": 2.057107 },
  "calibrationStatus": "exact", "calibrationNote": "…",
  "channels": [ { "name": "DAPI", "color": "#00FF00", "min": 0.0, "max": 1.0, "gamma": 1.0 }, … ],
  "created": "<ISO>", "lastModified": "<ISO>", "configured": true,
  "folderName": "<nom>",
  "description": "Confocal imaging stack: E8 fixed embryo, 178 slices, 4 channels.",
  "thumbnail": "DATA_WEB/fixed/<nom>/thumbnail.webp",
  "volumeSources": [ {
    "kind": "bricks", "label": "Chunked bricks (64³)", "priority": -1,
    "available": true, "multiscale": true,
    "path": "DATA_WEB/fixed/<nom>",
    "manifestPath": "DATA_WEB/fixed/<nom>/bricks/manifest.json"
  } ]
}
```

### 10.2. `bricks/manifest.json`
```json
{
  "version": 2, "schema": "iribhm-bricks-v2",
  "dataset": "<nom>", "datasetType": "fixed",
  "channels": 4, "brickSize": 64,
  "brickPacking": { "mode": "grid", "cols": 8, "rows": 8 },
  "voxelSize": { "x": …, "y": …, "z": … },
  "createdAt": "<ISO>",
  "levels": [ {
    "level": 0, "scale": 1.0,
    "dimensions": { "x": 3789, "y": 3789, "z": 178 },
    "brickSize": 64, "gridSize": { "x": 60, "y": 60, "z": 3 },
    "brickCount": 10800,                          // total grille (actives + inactives)
    "chunks": [ { "id": "bz_by_bx", "min": [..], "max": [..],
                  "occupiedRatio": 0.1234, "nonEmpty": true }, … ],  // uniquement les briques actives
    "nonEmptyCount": 2043
  }, … ],
  "histograms": [ { "counts":[…64…], "edges":[…65…], "total":…, "max":…,
                    "mean":…, "std":…, "backgroundFloor":0 }, … ],  // rempli par l'étape 4
  "hashes": {}, "timepoints": null,
  "brickTransport": {
    "mode": "packs", "encoding": "webp-lossless", "packSize": 128,
    "brickToPack": {
      "lod0/c0/x012_y034_z001.webp": { "url": "lod0/c0/pack_00.bin", "offset": 0, "length": 5123 }, …
    },
    "packHashes": { "lod0/c0/pack_00.bin": "<sha256>", … }
  }
}
```
* **Clé brique** : `lod{lod}/c{canal}/x{bx:03d}_y{by:03d}_z{bz:03d}.webp` (indices de **briques**, pas de voxels).
* **`id` de chunk** dans `levels.chunks` : `"{bz}_{by}_{bx}"`.
* `scale = 1 / 2**level`.

> **Pourquoi deux fichiers JSON séparés ?** `manifest.json` décrit **comment récupérer** la donnée (index des briques, packs, hash) — c'est le *transport*. `metadata.json` décrit **comment l'interpréter et l'afficher** (dimensions, canaux, couleurs, calibration) — c'est la *présentation*. Séparer les deux permet de régler l'affichage (admin) sans retoucher la donnée.

### 10.3. Format binaire d'un pack (`pack_{NN}.bin`)
Concaténation **brute** de jusqu'à 128 images **WebP‑lossless**, sans en‑tête ni séparateur. Extraction d'une brique : `data[offset : offset+length]` (depuis `brickToPack`), puis décodage WebP.

### 10.4. Format d'une brique (mosaïque WebP)
* Image **512×512**, niveaux de gris, **WebP lossless**.
* C'est une **mosaïque 8×8** des 64 tranches d'une brique 64³ :
  * tranche `z` (0..63) → tuile `(row = z//8, col = z%8)` placée en `[row*64:(row+1)*64, col*64:(col+1)*64]`.
  * **Reconstruction** côté viewer : `brique[z] = mosaic[(z//8)*64:(z//8+1)*64, (z%8)*64:(z%8+1)*64]`.
* Briques de bord : zero‑paddées à 64³ avant mosaïque.

### 10.5. Fichiers temporaires (supprimés en fin de run)
* `t{t:03d}_c{c}_lod{N}.bin` : volume `uint8` brut, C‑order `(D, H_lod, W_lod)`, sans en‑tête.
* `processing_meta.json` : voir §6.3.

---

## 11. Pourquoi ces choix de conception ?

Les justifications des paramètres *scientifiques* sont dans les étapes ci‑dessus (corner sampling, médian masqué, fond à 0…). Voici les grands choix d'**architecture** :

* **Pourquoi découper en briques (et streamer) ?** Un volume de 14 Go ne tient ni en RAM ni en VRAM. En le découpant, le viewer ne charge que les briques **visibles au zoom courant**, et libère les autres. C'est la seule façon d'avoir du 60 FPS sur des volumes multi‑Go dans un navigateur.

* **Pourquoi des briques de 64³ précisément ?** C'est le compromis idéal : assez **petites** pour un *Empty Space Skipping* fin et une pagination GPU efficace (64³ en `uint8` = 256 Ko) ; assez **grandes** pour amortir le coût par brique. Et surtout, **64 tranches se rangent exactement** dans une grille 8×8 → une mosaïque 2D carrée parfaite.

* **Pourquoi mosaïquer en une image 2D (512²) ?** Les navigateurs savent décoder des **images 2D** nativement et très vite (WebP via `createImageBitmap`, sur le GPU), mais n'ont **pas** de format d'image 3D. En rangeant les 64 tranches d'une brique dans une seule image 2D, le navigateur décode tout un cube en **une seule passe**.

* **Pourquoi WebP *lossless* (et pas JPEG ou PNG) ?** Donnée scientifique → **aucune perte tolérée** (JPEG corromprait les intensités). À qualité égale (sans perte), WebP est **bien plus compact** que PNG et se décode nativement dans le navigateur.

* **Pourquoi regrouper ~128 briques par pack ?** Des milliers de petits fichiers `.webp` = des milliers de requêtes HTTP = latence catastrophique + surcharge du système de fichiers. Un **pack** + un index `offset/length` = **une seule requête** ramène 128 briques.

* **Pourquoi un dataset à la fois, mais parallélisé en interne ?** Un seul canal pèse déjà ~10 Go en `float32`. Traiter plusieurs datasets simultanément ferait exploser la RAM. À l'inverse, la parallélisation **par blocs Z** (étape 2) et **par briques** (étape 3) sature les cœurs CPU **sans** multiplier les gros tampons mémoire.

---

## 12. Déterminisme & reproductibilité exacte

Le pipeline est **déterministe** ; un même `.ims` redonne la **même donnée** :

* **Percentiles** (`np.percentile`) : déterministes.
* **Masque** (`binary_opening`/`binary_dilation`) : calculés sur le volume **entier** avant tout découpage → indépendants du parallélisme.
* **Médian par blocs** : grâce au **halo ±1**, chaque tranche de sortie est calculée avec ses vrais voisins ; le résultat est **identique quel que soit `z_chunk_size`**, donc **indépendant du nombre de cœurs**. (Vérifié : **97/97 hashes SHA‑256** des packs identiques entre deux exécutions — voir [`changelog_0.13.0.md`](changelog/changelog_0.13.0.md).)
* **`executor.map`** préserve l'ordre des blocs/briques.
* **WebP lossless** : *sans perte* → la donnée **décodée** est toujours identique. Les **octets** du `.webp` (et donc les `packHashes`) ne sont byte‑identiques que **pour une même version de libwebp** (embarquée dans Pillow). Pour une reproduction *byte‑à‑byte*, figer la version de Pillow ; pour une reproduction *scientifique* (valeurs des voxels), n'importe quelle version convient.
* **Troncature `uint8`** : `(norm*255).astype(uint8)` tronque (≠ arrondi) — à respecter dans toute réimplémentation.

---

## 13. Table de référence des paramètres

| Paramètre | Valeur | Où | Effet |
|---|---|---|---|
| `bg_floor` (plancher de bruit) | **99ᵉ centile** des 8 coins | `2-image_processor.py` Step 1 | point noir / seuil de fond |
| `corner_size` | `max(1, min(32, W//4, H//4, D//4))` | Step 1 | taille des cubes de coin |
| `sig_max` (point blanc) | **99.9ᵉ centile** de `vol[::4,::4,::4]` | Step 1 | saturation haute |
| Seuil du masque | `vol > bg_floor * 1.1` | Step 2 | sépare signal / fond |
| Ouverture morpho | `binary_opening(iterations=1)` | Step 2 | retire hot‑pixels isolés |
| Dilatation morpho | `binary_dilation(iterations=3)` | Step 2 | protège les bords du signal |
| Médian | `median_filter(size=3)` (3×3×3, `reflect`) | Step 3 | lisse le fond hors masque |
| Halo Z | `±1` tranche | Step 3 | pas de couture entre blocs |
| Taille de brique | `BRICK_SIZE = 64` | `3-chunk_packer.py` | briques 64³ |
| Mosaïque | `8 × 8` → `512²` | `3-chunk_packer.py` | empaquetage 2D des 64 tranches |
| Briques par pack | `CHUNKS_PER_PACK = 128` | `3-chunk_packer.py` | taille des `.bin` |
| Seuil « cœur » ESS | `max(brique) > 0` | `3-chunk_packer.py` | détection signal |
| Dilatation de briques | 26‑voisins (`3×3×3`) | `3-chunk_packer.py` | halo de briques actives |
| Seuil brique vide | `occ ≤ 0.0005` → ignorée | `3-chunk_packer.py` | Empty Space Skipping |
| Encodage briques | **WebP lossless** | `3-chunk_packer.py` | aucune perte |
| LOD de base | doublement depuis **256** jusqu'à `< max(W,H)` | `2-image_processor.py` | pyramide carrée |
| Profondeur Z | **constante** sur tous les LOD | `2-image_processor.py` | pas de distorsion Z |
| Downscale LOD | bilinéaire (PIL) X/Y | `2-image_processor.py` Step 4 | mipmapping |
| Histogrammes | 64 bins, range `(0,255)`, sur LOD le + petit | `4-catalog_generator.py` | aperçu d'intensité |
| Vignette | MIP fausses couleurs, 512², WebP q=88 m=6 | `run_preprocess.py` | thumbnail |
| Parallélisme datasets | `ThreadPoolExecutor(max_workers=1)` | `run_preprocess.py` | 1 dataset à la fois |
| Parallélisme interne | `ProcessPoolExecutor(os.cpu_count())` | étapes 2 & 3 | par blocs Z / par briques |

---

## 14. Checklist « recréer de zéro »

Pour réimplémenter et obtenir le **même résultat** :

1. **Lire** le `.ims` comme HDF5 ; récupérer `X,Y,Z`, extents, noms de canaux (§3, §5). Recadrer `Data` à `(D,H,W)`.
2. **Par canal**, charger le volume `float32`. Calculer `bg_floor` (99ᵉ centile des 8 coins) et `sig_max` (99.9ᵉ centile du volume `[::4]`).
3. Construire le **masque** : `vol > bg_floor*1.1`, `binary_opening(1)`, `binary_dilation(3)` (structure 6‑connexe par défaut).
4. **Médian masqué** : `where(mask, vol, median_filter(vol, size=3))` (avec halo si découpé), puis **window leveling** `clip(.,bg_floor,sig_max)`, `(.-bg_floor)/(sig_max-bg_floor)*255`, `astype(uint8)` (**troncature**).
5. Générer la **pyramide LOD** : LOD0 natif ; LOD≥1 = carrés `256,512,…<max(W,H)` (inversés), downscale **bilinéaire X/Y**, **Z conservé**.
6. **Découper en 64³**, ESS (`core: max>0` + dilatation 26‑voisins ; rejet `occ≤0.0005`), **mosaïquer 8×8 → 512²**, encoder **WebP lossless**, empaqueter (128/pack), indexer `offset/length`, hasher `sha256`.
7. Écrire `manifest.json` (schema `iribhm-bricks-v2`, §10.2), **histogrammes** (64 bins) injectés, `metadata.json` (§10.1), `thumbnail.webp` (MIP fausses couleurs).
8. Respecter les détails de §12 (déterminisme : halo, troncature, ordre, WebP lossless).

> Toute modification d'un paramètre de §13 **change la donnée de sortie** → bumper la version (`run_preprocess.py:__version__`) et ajouter un `changelog/changelog_X.Y.Z.md` (sections `[ADDED]`/`[OPTIMIZED]`/`[FIXED]`).

---

<div align="center">
<sub>IRIBHM · ULB — Lumen3D Microscopy Platform · pipeline de preprocessing v0.14.1</sub>
</div>
