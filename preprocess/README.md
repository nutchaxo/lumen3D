# Pipeline de Preprocessing — Lumen3D / IRIBHM

> Transforme un volume de microscopie confocale **Imaris `.ims`** (HDF5, multi‑gigaoctets, 16 bits) en un dataset **streamable par briques 64³** consommable par la plateforme web (`DATA_WEB/fixed/<dataset>/`).
>
> **Version courante : `0.13.0`** (`run_preprocess.py:__version__`). Changelogs : [`changelog/`](changelog/). Ce document décrit l'algorithme **exact** : il est conçu pour être auto‑suffisant — on doit pouvoir réimplémenter le pipeline de zéro et obtenir un résultat **scientifiquement identique** (et byte‑identique sous réserve des mêmes versions de libwebp/Pillow — voir §11).

---

## Table des matières
1. [Vue d'ensemble & flux de données](#1-vue-densemble--flux-de-données)
2. [Prérequis & environnement](#2-prérequis--environnement)
3. [Exécution (CLI)](#3-exécution-cli)
4. [Contrat d'entrée : structure du fichier `.ims` (Imaris HDF5)](#4-contrat-dentrée--structure-du-fichier-ims-imaris-hdf5)
5. [Carte des fichiers](#5-carte-des-fichiers)
6. [Étape 1 — Extraction des métadonnées (`1-ims_metadata.py`)](#6-étape-1--extraction-des-métadonnées-1-ims_metadatapy)
7. [Étape 2 — Traitement & débruitage (`2-image_processor.py`)](#7-étape-2--traitement--débruitage-2-image_processorpy)
8. [Étape intermédiaire — Vignette MIP (`run_preprocess.py:build_thumbnail`)](#8-étape-intermédiaire--vignette-mip)
9. [Étape 3 — Découpe en briques & packs (`3-chunk_packer.py`)](#9-étape-3--découpe-en-briques--packs-3-chunk_packerpy)
10. [Étape 4 — Histogrammes & `metadata.json` (`4-catalog_generator.py`)](#10-étape-4--histogrammes--metadatajson-4-catalog_generatorpy)
11. [Formats de sortie (référence)](#11-formats-de-sortie-référence)
12. [Déterminisme & reproductibilité exacte](#12-déterminisme--reproductibilité-exacte)
13. [Table de référence des paramètres](#13-table-de-référence-des-paramètres)
14. [Checklist « recréer de zéro »](#14-checklist--recréer-de-zéro-)

---

## 1. Vue d'ensemble & flux de données

Le pipeline est orchestré par `run_preprocess.py`, qui appelle **4 scripts numérotés** en sous‑processus, plus une étape vignette inline. Un dataset est traité à la fois (un `.ims` → un dossier `fixed/<nom>/`).

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

## 2. Prérequis & environnement

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

  > ⚠️ `scikit-image` n'est **plus** nécessaire (les imports Otsu/morphologie skimage de l'ancienne version ont été supprimés en v0.13.0). Seul `scipy.ndimage` est utilisé pour la morphologie/le médian.

* **RAM** : l'étape 2 charge **tout le volume d'un canal en `float32`** (`D×H×W×4` octets). Ex. 3789×3789×178 ≈ **10.2 Go/canal**, pic ~32 Go avec masque + blocs + sortie. Prévoir large (machine de référence : 128 Go / 20 cœurs).
* **CPU** : l'étape 2 (médian) et l'étape 3 (WebP) parallélisent sur `os.cpu_count()` via `ProcessPoolExecutor`. Le résultat est **indépendant** du nombre de cœurs (voir §12).

---

## 3. Exécution (CLI)

```bash
python run_preprocess.py --input <dossier_des_ims> --output <DATA_WEB> [--only "<glob>"]
```

| Argument | Obligatoire | Rôle |
|---|---|---|
| `--input`  | oui | Dossier contenant un ou plusieurs `.ims` (recherche **non récursive** : `input_dir.glob("*.ims")`). |
| `--output` | oui | Racine `DATA_WEB` de la plateforme. La sortie ira dans `<output>/fixed/<nom_du_ims_sans_extension>/`. |
| `--only`   | non | Filtre `fnmatch` sur le **nom de fichier** (ex. `"*Em7*"` ou le nom exact). Sans lui : tous les `.ims`. |

Exemple réel (1 dataset) :

```bash
python run_preprocess.py \
  --input  "D:/RAW_DATA/done" \
  --output "C:/.../WebPlatform/DATA_WEB" \
  --only   "Egfl7eGFP-E8-Em7-18112025-GFP555-Pecam1-10x-2xzoom-4avg.ims"
```

> Sur Windows, si `python` est intercepté par l'alias Microsoft Store, utiliser le launcher `py`.

**Orchestration interne** (`run_preprocess.py`) :
* `ThreadPoolExecutor(max_workers=1)` → **un dataset à la fois** (pour économiser la RAM ; le parallélisme est *intra*‑dataset).
* Le **nom du dataset** = `Path(ims).stem` (nom du fichier sans `.ims`).
* `temp_dir = <output>/.temp_preprocess_<nom>` : recréé à neuf à chaque run, **supprimé dans le `finally`** (même en cas d'erreur).
* `dataset_output_dir = <output>/fixed/<nom>` : si un `bricks/` existe déjà, il est supprimé avant de régénérer.
* Ordre des étapes : **1 → 2 → vignette → 3 → 4**.

---

## 4. Contrat d'entrée : structure du fichier `.ims` (Imaris HDF5)

Un `.ims` est un conteneur **HDF5**. Le pipeline lit cette arborescence (les chunks HDF5 sont typiquement compressés **gzip**) :

```
/DataSetInfo/
    Image/                       (attributs, valeurs stockées en tableaux d'octets ASCII)
        X, Y, Z                  → width, height, depth  (entiers en texte)
        ExtMin0, ExtMax0         → étendue physique en X (µm)
        ExtMin1, ExtMax1         → étendue physique en Y
        ExtMin2, ExtMax2         → étendue physique en Z
    Channel 0/, Channel 1/, …    (un groupe par canal)
        Name                     → nom du canal (ex. "DAPI"), nettoyé (voir §6)
/DataSet/
    ResolutionLevel 0/           (on n'utilise QUE le niveau 0, pleine résolution)
        TimePoint 0/             (datasets "fixed" : 1 seul timepoint)
            Channel 0/Data       → tableau 3D uint16, shape (Zpad, Ypad, Xpad)
            Channel 1/Data       …
        TimePoint 1/ …           (si timelapse)
    ResolutionLevel 1..N/        (pyramide native d'Imaris — IGNORÉE, on régénère nos propres LOD)
```

Détails importants :
* Le tableau `Data` peut être **paddé** (ex. dims réelles 178×3789×3789 mais `Data.shape = (184, 3840, 3840)` à cause du chunking). On recadre toujours via `ds[:D, :H, :W]` avec `(D,H,W)` issus des attributs `Z,Y,X`.
* Ordre des axes du `Data` : **(Z, Y, X)** (C‑order). `dtype = uint16`.
* `width = X`, `height = Y`, `depth = Z`.
* **Voxel** : `voxel_x = (ExtMax0 - ExtMin0) / X`, idem Y/Z. Arrondi à 6 décimales.
* TimePoints triés par l'entier final (`"TimePoint 12"` → 12). Canaux idem (`"Channel 3"` → 3).

---

## 5. Carte des fichiers

| Fichier | Rôle | Entrée | Sortie |
|---|---|---|---|
| [`run_preprocess.py`](run_preprocess.py) | Orchestrateur + vignette. `__version__` du pipeline. | `--input`, `--output`, `--only` | appelle 1→4 ; écrit `thumbnail.webp` |
| [`1-ims_metadata.py`](1-ims_metadata.py) | Lit les attributs HDF5. | `<ims>`, `<out.json>` | `meta.json` |
| [`2-image_processor.py`](2-image_processor.py) | Débruitage + normalisation 8‑bits + pyramide LOD. | `<ims>`, `<meta.json>`, `<temp>` | `temp/t*_c*_lod*.bin`, `temp/processing_meta.json` |
| [`3-chunk_packer.py`](3-chunk_packer.py) | Découpe 64³, mosaïque, WebP lossless, packs. | `<temp>`, `<out_dir>` | `out/bricks/manifest.json`, `out/bricks/lod*/c*/pack_*.bin` |
| [`4-catalog_generator.py`](4-catalog_generator.py) | Histogrammes + `metadata.json`. | `<temp>`, `<out_dir>` | `out/metadata.json` (+ histogrammes injectés dans `manifest.json`) |
| [`changelog/`](changelog/) | Historique versionné de l'outil. | — | — |

---

## 6. Étape 1 — Extraction des métadonnées (`1-ims_metadata.py`)

**Appel :** `python 1-ims_metadata.py <input.ims> <output.json>`

**Algorithme :**
1. Ouvrir le HDF5. Lire `DataSetInfo/Image` → `X,Y,Z` (entiers), `ExtMin{0,1,2}`/`ExtMax{0,1,2}` (flottants). Les attributs Imaris sont des **tableaux d'octets ASCII** → décodés via un helper `attr_str` (gère `bytes`, `np.bytes_`, `np.ndarray` de caractères).
2. `voxel = (ExtMax − ExtMin) / dim`, arrondi `round(.,6)`.
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

## 7. Étape 2 — Traitement & débruitage (`2-image_processor.py`)

> **C'est l'étape lourde et scientifiquement critique.** Algorithme « masked‑median » reconstruit fidèlement des versions 0.12.13→0.12.15, restauré en v0.13.0. Aucune approximation : voir le code, chaque transformation est explicite.

**Appel :** `python 2-image_processor.py <input.ims> <meta.json> <temp_dir>`

### 7.1. Détermination des niveaux LOD
* **LOD 0** = résolution native `W×H×D` (non carrée, non puissance de 2 — fidélité maximale).
* LOD ≥ 1 : carrés en puissances de 2. On construit `target_dims` en partant de **256** et en doublant tant que `< max(W,H)`, puis on **inverse** :
  ```python
  curr = 256; target_dims = []
  while curr < max(W,H): target_dims.append(curr); curr *= 2
  target_dims.reverse()      # ex. W=H=3789 → [2048, 1024, 512, 256]
  ```
  → LOD1=2048², LOD2=1024², LOD3=512², LOD4=256².
* **La profondeur `D` (axe Z) est conservée identique sur tous les LOD** (jamais sous‑échantillonnée en Z), pour éviter toute distorsion verticale.

### 7.2. Traitement, **par timepoint × par canal**
On lit le volume natif entier : `vol = ds[:D,:H,:W].astype(float32)` (axes `(D,H,W)`).

**Step 1 — Estimation des bornes (Corner Sampling).**
* `corner_size = max(1, min(32, W//4, H//4, D//4))`.
* On extrait les **8 coins** du volume (cubes `corner_size³`), on les concatène.
* `bg_floor = percentile(coins, 99.0)` — le **plancher de bruit** : 99ᵉ centile du fond caméra pur (les coins ne contiennent pas d'embryon).
* `sig_max = percentile(vol[::4,::4,::4], 99.9)` — le **point blanc** : 99.9ᵉ centile du volume **sous‑échantillonné ×4** (rapide, peu de RAM ; sature le 0.1 % le plus lumineux).

**Step 2 — Masque de signal** (opérations 3D sur tout le volume) :
```python
mask = vol > (bg_floor * 1.1)          # seuil 10 % au-dessus du plancher
mask = binary_opening(mask, iterations=1)   # éjecte les hot-pixels isolés
mask = binary_dilation(mask, iterations=3)  # protège le fondu fluorescent autour du signal
```
* Structure morphologique : **défaut scipy** = `generate_binary_structure(3, 1)` (croix 6‑connexe).
* `binary_opening` (érosion puis dilatation, 1 itération) supprime les pixels morts hyper‑lumineux **isolés** : retirés du masque, ils subiront le médian + le window leveling et finiront à `0`.
* `binary_dilation` ×3 élargit le masque de 3 voxels pour ne **jamais** flouter les bords biologiques.

**Step 3 — Filtrage médian masqué + Window Leveling** (parallèle par blocs Z) :
* Découpage Z : `z_chunk_size = max(4, D // (cpu_count*2))`. Pour chaque bloc `[z_start, z_end)` on ajoute un **halo de ±1 tranche** (`halo_lo/halo_hi = 1` sauf aux bords du volume) afin que le médian 3D voie de vrais voisins aux jointures.
* Chaque bloc (`block_data`, `block_mask`, avec halo) part dans un worker `process_z_block` :
  ```python
  smoothed  = median_filter(block_data, size=3)        # médian 3D 3×3×3 (mode 'reflect')
  composite = np.where(block_mask, block_data, smoothed)  # signal net DANS le masque, fond lissé DEHORS
  clean     = np.clip(composite, bg_floor, sig_max)
  norm      = (clean - bg_floor) / (sig_max - bg_floor)   # garde-fou : si sig_max<=bg_floor → sig_max = bg_floor+1
  block_u8  = (norm * 255.0).astype(uint8)             # troncature (pas d'arrondi)
  # on retire le halo avant réassemblage
  ```
* Conséquence : tout voxel `≤ bg_floor` devient **0 absolu** en `uint8` → vide pur garanti pour l'ESS du packer.
* Réassemblage dans `vol_u8` `(D,H,W) uint8`.

**Step 4 — Export des LOD** (par tranche Z) :
* LOD0 : on écrit `vol_u8[z].tobytes()` brut.
* LOD ≥ 1 : `PIL.Image.fromarray(slice, 'L').resize((w,h), BILINEAR)` puis `.tobytes()`. **Downscale 2D bilinéaire X/Y uniquement**, Z préservé.
* Chaque LOD a son propre fichier ouvert en écriture ; on **concatène** les `D` tranches.

### 7.3. Sorties de l'étape 2 (dans `temp_dir`)
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

## 8. Étape intermédiaire — Vignette MIP

Fonction `build_thumbnail()` **dans `run_preprocess.py`** (pas un script séparé), appelée entre l'étape 2 et l'étape 3.

* Choix du LOD source : premier LOD avec `max(width,height) ≤ 1024` (vitesse).
* Pour chaque canal : charge `temp/t000_c{C}_lod{target}.bin` (`np.fromfile`, reshape `(D,h,w)`), calcule la **MIP** `vol.max(axis=0)`.
* Composite **fausses couleurs additif** : pour le canal *i*, `composite += (mip/255) × THUMB_COLORS[i % 7]` (RGB), puis `clip(0,255) → uint8`.
* `THUMB_COLORS` = `[(0,255,102),(255,61,255),(47,107,255),(255,48,48),(255,255,0),(255,0,255),(0,255,255)]`.
* Redimensionne pour tenir dans **512×512** (LANCZOS, ratio préservé), centre sur un fond carré `(8,10,18)` (`#080A12`).
* Enregistre `fixed/<nom>/thumbnail.webp` en `WEBP quality=88 method=6`.

---

## 9. Étape 3 — Découpe en briques & packs (`3-chunk_packer.py`)

**Appel :** `python 3-chunk_packer.py <temp_dir> <output_dir>`

Constantes : `BRICK_SIZE = 64`, `CHUNKS_PER_PACK = 128`, mosaïque `8×8` (= 512²).

**Pour chaque LOD** (lu depuis `processing_meta.json`) :

1. **Grille de briques** : `nx = ceil(W/64)`, `ny`, `nz`. Pour chaque brique `(bx,by,bz)` on note `min=[ox,oy,oz]`, `max=[ox+ew,oy+eh,oz+ed]` (bord tronqué), `validVoxelCount = ew·eh·ed`.

2. **Empty Space Skipping (ESS), 2 passes :**
   * **Cœur** : une brique est « core » si, pour **au moins un canal**, `max(brique) > BACKGROUND_THRESHOLD` (= **0** ; rappel : l'étape 2 a mis le vide à 0 absolu). Lecture via `np.memmap` du `.bin` du canal.
   * **Dilatation 26‑voisins** : on ajoute aux cœurs toutes les briques voisines (fenêtre `3×3×3` en indices de briques) → `active_coords`. Cela préserve les fondus fluorescents naturels. → `active_chunks_grid`.

3. **Encodage, par canal × par brique active :**
   * Lire le sous‑volume `64³` (zero‑paddé si bord).
   * `occ = count_nonzero / validVoxelCount`. **Si `occ ≤ 0.0005` → brique vide, ignorée** (non écrite).
   * Sinon : **mosaïque 512²** — la tranche `z` (0..63) va en `mosaic[(z//8)*64:(z//8+1)*64, (z%8)*64:(z%8+1)*64]` (grille 8×8, *row‑major*).
   * **Encodage `WebP lossless`** (`PIL Image.save(buf, "WEBP", lossless=True)`), niveaux de gris (mode L).
   * Écriture **append** dans `pack_{NN}.bin` (≤ 128 briques/pack ; rollover quand plein). On mémorise `offset` et `length` de chaque brique.
   * `occupancy_union[brique] = max sur les canaux` (pour le manifest).

4. **Hash** : `sha256` de chaque pack terminé → `packHashes`.

**Sortie :** `output_dir/bricks/`
* `lod{N}/c{C}/pack_{NN}.bin` — concaténation brute de flux WebP (sans séparateur ; on extrait via offset+length).
* `manifest.json` — voir §11.2 (les `histograms` y sont **vides** ici, remplis à l'étape 4).

---

## 10. Étape 4 — Histogrammes & `metadata.json` (`4-catalog_generator.py`)

**Appel :** `python 4-catalog_generator.py <temp_dir> <output_dir>`

1. **Histogrammes** (sur le LOD **le plus petit** = `lod_levels[-1]`, pour la vitesse/RAM) : pour chaque canal, `np.histogram(vol_uint8, bins=64, range=(0,255))` → `counts` (64), `edges` (65), plus `total`, `max`, `mean`, `std`, `backgroundFloor=0`. **Injectés dans `bricks/manifest.json`** (champ `histograms`).
2. **Calibration physique** : `physicalSizeUm = {x: W·vx, y: H·vy, z: D·vz, sliceThickness: vz, voxelX/Y/Z}`. `calibrationStatus = "exact"` si les 3 voxels sont non nuls, sinon `"metadata-missing"`.
3. **Parsing du nom de dossier** :
   * Stade : regex `-(E(\d(?:\.?\d+)?))($|-)` puis `^(E…)` → `display` (`"E8"`, ou `"E8.5"`) et `numeric` (`8.0` / `8.5`). Sinon `("Unknown", 0.0)`.
   * Embryon : `-(Em\d+)-` → ex. `"Em7"`, sinon `null`.
4. **Canaux** : couleur par défaut depuis `COLORS = ["#00FF00","#00AAFF","#FF00FF","#FF0000","#FFFF00","#00FFFF"]`, `min=0, max=1, gamma=1`.
5. Écrit `output_dir/metadata.json` (voir §11.1).

> Les réglages d'affichage (`gamma`, `min`, `max`, `active`, couleurs ajustées, `exposure`, `orientation`) sont ensuite **éditables via le panneau admin** (`admpan.js` → API `dev_server.py`), qui réécrit `metadata.json`. Le générateur ne produit que les valeurs par défaut.

---

## 11. Formats de sortie (référence)

Arborescence finale d'un dataset :

```
DATA_WEB/fixed/<nom>/
├── metadata.json          # config dataset (dims, voxels, canaux, volumeSources)
├── thumbnail.webp         # vignette MIP fausses couleurs 512²
└── bricks/
    ├── manifest.json      # index des briques + packs + histogrammes
    ├── lod0/c0/pack_00.bin, pack_01.bin, …
    ├── lod0/c1/…  …  (un sous-dossier par canal)
    ├── lod1/…  lod2/…  lod3/…  lod4/…
```

### 11.1. `metadata.json`
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

### 11.2. `bricks/manifest.json`
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

### 11.3. Format binaire d'un pack (`pack_{NN}.bin`)
Concaténation **brute** de jusqu'à 128 images **WebP‑lossless**, sans en‑tête ni séparateur. Extraction d'une brique : `data[offset : offset+length]` (depuis `brickToPack`), puis décodage WebP.

### 11.4. Format d'une brique (mosaïque WebP)
* Image **512×512**, niveaux de gris, **WebP lossless**.
* C'est une **mosaïque 8×8** des 64 tranches d'une brique 64³ :
  * tranche `z` (0..63) → tuile `(row = z//8, col = z%8)` placée en `[row*64:(row+1)*64, col*64:(col+1)*64]`.
  * **Reconstruction** côté viewer : `brique[z] = mosaic[(z//8)*64:(z//8+1)*64, (z%8)*64:(z%8+1)*64]`.
* Briques de bord : zero‑paddées à 64³ avant mosaïque.

### 11.5. Fichiers temporaires (supprimés en fin de run)
* `t{t:03d}_c{c}_lod{N}.bin` : volume `uint8` brut, C‑order `(D, H_lod, W_lod)`, sans en‑tête.
* `processing_meta.json` : voir §7.3.

---

## 12. Déterminisme & reproductibilité exacte

Le pipeline est **déterministe** ; un même `.ims` redonne la **même donnée** :

* **Percentiles** (`np.percentile`) : déterministes.
* **Masque** (`binary_opening`/`binary_dilation`) : calculés sur le volume **entier** avant tout découpage → indépendants du parallélisme.
* **Médian par blocs** : grâce au **halo ±1**, chaque tranche de sortie est calculée avec ses vrais voisins ; le résultat est **identique quel que soit `z_chunk_size`**, donc **indépendant du nombre de cœurs**. (C'est ce qui a permis de vérifier une reproduction byte‑identique : **97/97 hashes SHA‑256** des packs identiques entre deux machines/exécutions — voir [`changelog_0.13.0.md`](changelog/changelog_0.13.0.md).)
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

1. **Lire** le `.ims` comme HDF5 ; récupérer `X,Y,Z`, extents, noms de canaux (§4, §6). Recadrer `Data` à `(D,H,W)`.
2. **Par canal**, charger le volume `float32`. Calculer `bg_floor` (99ᵉ centile des 8 coins) et `sig_max` (99.9ᵉ centile du volume `[::4]`).
3. Construire le **masque** : `vol > bg_floor*1.1`, `binary_opening(1)`, `binary_dilation(3)` (structure 6‑connexe par défaut).
4. **Médian masqué** : `where(mask, vol, median_filter(vol, size=3))` (avec halo si découpé), puis **window leveling** `clip(.,bg_floor,sig_max)`, `(.-bg_floor)/(sig_max-bg_floor)*255`, `astype(uint8)` (**troncature**).
5. Générer la **pyramide LOD** : LOD0 natif ; LOD≥1 = carrés `256,512,…<max(W,H)` (inversés), downscale **bilinéaire X/Y**, **Z conservé**.
6. **Découper en 64³**, ESS (`core: max>0` + dilatation 26‑voisins ; rejet `occ≤0.0005`), **mosaïquer 8×8 → 512²**, encoder **WebP lossless**, empaqueter (128/pack), indexer `offset/length`, hasher `sha256`.
7. Écrire `manifest.json` (schema `iribhm-bricks-v2`, §11.2), **histogrammes** (64 bins) injectés, `metadata.json` (§11.1), `thumbnail.webp` (MIP fausses couleurs).
8. Respecter les détails de §12 (déterminisme : halo, troncature, ordre, WebP lossless).

> Toute modification d'un paramètre de §13 **change la donnée de sortie** → bumper la version (`run_preprocess.py:__version__`) et ajouter un `changelog/changelog_X.Y.Z.md` (sections `[ADDED]`/`[OPTIMIZED]`/`[FIXED]`).
