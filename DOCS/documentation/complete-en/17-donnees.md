# 17. Data in depth: files, formats, migrations, import

::: chapter-intro
- A dataset is **a folder**: every file has an author (the pipeline, the operator or the platform), a reason to exist and, most of the time, a fingerprint that lets you check it.
- There are **four data formats**. A data update moves a dataset from one to the next **in place**, in small units recorded in a journal, with a final atomic swap.
- The browser import sends a folder **block by block**, verified and resumable, into a private area; the files that make the dataset openable go first.
:::

Chapters 7 and 8 showed **what** bricks, `planes/`, `mips/` and `metadata.json` look like. Chapter 14 showed **where to click** in the administration panel. This chapter lifts the bonnet: it says **exactly** what each file contains, who writes it, how it changes format and how it reaches the server.

![The chapter map: three parts, eighteen sections.](img-en/ch17/carte-chapitre.svg){width=100%}

::: note
Every worked number comes from the **demonstration datasets** (synthetic, produced by the real pipeline) or from **real trials** run on test datasets in a temporary folder. No laboratory data is shown.
:::

## 17.1 One dataset, one folder: the three trees

A dataset lives in `DATA_WEB/<type>/<folder>/`. The **type** (`3d`, `2d` or `live`) is the name of the parent folder; the folder itself is the dataset's identifier: `3d/Embryo-E95-Em2-Pecam1-Sox2`.

::: analogy
**A travel suitcase.** Open it and every item has its place: the identity card (`metadata.json`), the passport photo (the thumbnail), the contents (the bricks) and some souvenirs to take away (`download/`). The coloured dots in the figures tell you **who packed** what.
:::

![The tree of a 3D dataset: from the identity card to the bricks, planes, mips and downloads.](img-en/ch17/arbre-3d.svg){width=100%}

Three things to notice in this tree:

- the `bricks/`, `planes/` and `mips/` folders carry **a blue and a green dot**: the pipeline writes them directly (format 4), or the platform built them through a migration (section 17.8);
- `gallery/` exists only if the operator attached images;
- all of `DATA_WEB/` is served as it stands, except `download/`, which is **always** served as an attachment (section 17.6).

![The tree of a time series: one brick tree per frame, tracking at the root.](img-en/ch17/arbre-live.svg){width=100%}

In a `live` series, **each frame** has its own tree: `bricks/t000/`, `bricks/t001/`… each with its `index.bin`. The `planes/` and `mips/` folders follow the same split (`planes/t000/`, `mips/t000/`). Cell tracking (`tracks.json`, `model.glb`) sits at the root of the dataset: it describes the whole series.

![The tree of a 2D photograph: three copies of one image and an identity card.](img-en/ch17/arbre-2d.svg){width=100%}

A 2D photograph has neither bricks nor channels. The file `image.webp` is the display copy; the original TIFF stays untouched in `download/` (it is a hard link: it takes no extra space).

### Work-in-progress folders

During an operation the platform builds **next to** the dataset, then swaps. These temporary folders have recognisable names; a folder whose name starts with a dot is **never** listed in the catalogue.

| Name | Created by | Disappears when |
|---|---|---|
| `.planes-incoming/`, `.mips-incoming/`, `.bricks-incoming/` | a migration (assembly) | the swap is done |
| `.planes-old/`, `.mips-old/`, `bricks.v2-old/` | a migration (previous state set aside) | the version is raised |
| `.incoming-<dataset>-<date>/` | the import (copy between two disks) | the final rename, or the next start-up |
| `.replaced-<dataset>-<date>/` | the import (old dataset being replaced) | publication is finished |
| `.swap-in-progress` | the pipeline (installing a new run) | the installation is finished |
| `.lumen-tmp-*` | any "all or nothing" file write | the final rename |

::: remember
A file is never written "in place": a neighbouring temporary file is written, then **renamed**. A rename is atomic: the visitor sees the old file or the new one, never half of each.
:::

## 17.2 Who writes what: three authors

A single `metadata.json` is touched by three authors. So that each respects the others' work, **every field has an owner**.

![The pipeline measures, the operator tunes, the platform stamps; two merge rules.](img-en/ch17/qui-ecrit.svg){width=100%}

### The pipeline measures

The pipeline writes everything that can be **measured** in the acquisition: dimensions, voxel sizes, initial channels, volume sources and, for a series, `timeline`, `intensityNormalization`, `tracking` and `registration`. It also writes the starting value of fields the operator may correct (name, stage, description).

### The operator tunes

The administration editor (chapter 14, section 14.4) sends the fields it modifies. The server **merges** them into the existing file, under a lock, then imposes `id`, `type`, `folderName`, `configured` and `lastModified` itself. The gallery is **reconciled** with the `gallery/` folder: the submission decides the order and the captions, the folder decides which files exist.

### The twenty "curated" keys

When a dataset is **rebuilt** or **replaced**, a fixed list of twenty keys is protected, both in the pipeline and in the import (`CURATED_KEYS`):

| Family | Keys |
|---|---|
| Identity | `name`, `description`, `stage`, `stageNumeric`, `embryo`, `line`, `staining`, `reporter`, `tags`, `notes`, `created` |
| Display | `hidden`, `orientation`, `orientationAxes`, `upsideDown`, `defaultView`, `exposure` |
| Links and images | `gallery`, `linkedTrackingId`, `relatedIds` |

### Two merge directions

The protection does not work the same way in the two cases, and the difference matters.

| Situation | Who wins | Consequence |
|---|---|---|
| The **pipeline rebuilds** a published dataset | the **old** file, for the 20 curated keys | your corrected name, your orientation and your gallery survive |
| The **import replaces** a published dataset | the **new** file; a curated key is carried over **only if the new file does not contain it** | `orientation` and `gallery` survive; a `name` that the new file states **wins** |

::: example
**A real trial** (import engine, temporary folder). A published dataset had been edited: `orientation`, a gallery, a corrected name. It was replaced with the pipeline's folder. The server's answer: `carriedKeys = [gallery, orientation]` and `carriedGallery = true`. The name, on the other hand, **went back to the pipeline's**: the new `metadata.json` contains it, so it wins. And `formatVersion` is **4** (the new file's value), never the old number.
:::

::: warning
`formatVersion` is **never** carried over from the old file, in either case: it describes what is really on disk.
:::

## 17.3 `metadata.json`, field by field

![The blocks of a metadata.json: the same skeleton, three shapes.](img-en/ch17/metadata-blocs.svg){width=100%}

The tables below give, for each field, **what it means** (with the real value from the demonstration dataset) and **who writes it**.

### Identity and state

| Field | What it is | Written by |
|---|---|---|
| `id` | `"3d/Embryo-E95-Em2-Pecam1-Sox2"`: type and folder | pipeline; **imposed** at every save |
| `type` | `3d`, `2d` or `live`; always equal to the parent folder | pipeline; imposed |
| `name` | displayed name | pipeline (folder name), then operator |
| `folderName` | folder name | pipeline; imposed |
| `stage`, `stageNumeric` | `"E9.5"` and `9.5`, read from the name (chapter 8) | pipeline; the editor recomputes `stageNumeric` when you change `stage` |
| `embryo` | `"Em2"` | pipeline; operator |
| `description` | starting sentence, for example "Confocal imaging stack: E9.5 fixed embryo, 112 slices, 3 channels." | pipeline; operator |
| `created`, `lastModified` | ISO dates; `created` is protected; `lastModified` is refreshed at every save | pipeline; platform |
| `configured` | `true`; decides whether the dataset enters the catalogue (section 17.5) | pipeline; imposed |
| `formatVersion` | `4`; absent = 1 | pipeline, or the end of a migration |
| `hidden` | `true` = invisible to the public, visible in the administration panel | operator; **the import always publishes hidden** |

### Geometry and calibration

| Field | What it is | Written by |
|---|---|---|
| `dimensions` | `{x:768, y:576, z:112, c:3, t:1}`: voxels in X, Y, Z, number of channels, number of frames | pipeline |
| `voxel_size` | `{x:1.2, y:1.2, z:3.0}` in µm | pipeline; the operator may correct it by hand |
| `physicalSizeUm` | `{x:921.6, y:691.2, z:336.0, sliceThickness:3.0, voxelX, voxelY, voxelZ}`: real extent in µm | pipeline |
| `optical_section_thickness_um` | `3.0`: section thickness, declared **equal to the Z step** | pipeline |
| `acquisitionExtentUm` | `{unit:"um", min:[0,0,0], max:[921.6,691.2,336]}`: the acquisition box, in Imaris's coordinate frame | pipeline |
| `calibrationStatus`, `calibrationNote` | `exact` or `metadata-missing`, with a one-sentence explanation | pipeline |

::: tech
**Why declare `sliceThickness` equal to the Z step?** The viewer models depth as (D − 1) steps plus one section thickness. Without an explicit value it guesses `min(Z step, voxel X)`, which underestimates the depth of an anisotropic stack (329.50 µm instead of the 333.87 µm Imaris declares). Yet everything recorded in Imaris's coordinates (the tracked cells) must land on the right voxels.
:::

The **calibration status** has two vocabularies: the pipeline writes only `exact` or `metadata-missing`; the viewer recomputes its own status from what it receives (`exact` only if a section thickness is present, otherwise `estimated` or `metadata-missing`, chapter 9).

### Channels and sources

| Field | What it is | Written by |
|---|---|---|
| `channels[]` | `{name:"DAPI", color:"#3D7BFF", min:0.0, max:1.0, gamma:1.0}`; the editor adds `active` | pipeline (starting values), then operator |
| `volumeSources[]` | `{kind:"bricks", label, priority:-1, available:true, multiscale:true, path, manifestPath}`: where the viewer finds the bricks; the known kinds are `bricks` and `webstack` | pipeline |
| `thumbnail` | path of the thumbnail, or `null`; the catalogue **recomputes** it from whether the file exists | pipeline |

Channel settings are kept when a dataset is rebuilt **as long as the number of channels has not changed**: with a different set of channels, the old settings would belong to other data.

### Operator settings

| Field | What it is | Written by |
|---|---|---|
| `exposure` | exposure multiplier at opening (the slider runs from 20 % to 500 %, i.e. 0.2 to 5) | operator |
| `orientation` | quaternion `Q_base`: it takes the file's axes to the anatomy (chapter 12) | operator, via the orientation tool |
| `orientationAxes` | `{labels:{A:"Rostral"}, hidden:["D"], defaultView:{preset, quaternion}}`: arm names, hidden arms, default view | operator |
| `upsideDown` | `true` if the raw file shows the sample from below | operator ([Sample side]{.ui}) |
| `gallery[]` | `[{file, added, thumb, title, caption}]` | operator; the platform creates the thumbnail |
| `relatedIds`, `linkedTrackingId` | links between datasets, entered by hand; the vocabulary conversion (section 17.5) rewrites them | operator |
| `line`, `staining`, `reporter`, `tags`, `notes` | free information; `line` and `staining` are set by the photograph importer | 2D importer, operator |

### What a `live` series adds

| Block | Real content of the demonstration dataset |
|---|---|
| `timeline` | `{count:4, intervalMinutes:30.0, timestamps:["2026-05-12T09:00:00", …]}` |
| `intensityNormalization` | `{mode:"global", bounds:{c0:{bgFloor, sigMax}, c1:{…}}, signalLevels:{"t000_c0":33107.0, …}}`: the common window of the whole series and one signal level per frame and channel |
| `tracking` | `{schema:"iribhm-tracks-v1", source, tracksPath:"tracks.json", surfacePath:"model.glb", surfaceOrigin:"reconstructed", cellCount:50, timepointCount:4, mitosisCount:1, fusionCount:0, regions:[{name, cells, color}], boundsUm:{stabilized, raw}, provenance:{…}, alignment:{…}}` |
| `registration` | `{method:"tracking-procrustes", coordinateSpace:"acquisition-um", timepointOffset:-1, appliedToVolume:true, transforms:[…], qcSummary:{…}, imageBoxUnionUm:{…}}` |

::: note
**About `intensityNormalization`.** The pipeline records these levels "so that an optional setting can one day compensate for photobleaching". **No viewer setting reads them yet**: a series whose signal fades really does display darker.
:::

The `tracking` block has three useful sub-blocks:

- `provenance`: where the tracks come from (`kind: "scene8"` = the Imaris objects inside the `.ims`, or `excel` = an exported workbook), the number of points (`spots: 194`) and tracks (`tracks: 48`), the declared unit and its conversion to µm (`toUm: 1.0`, `status: "native"`), the sphere radius, the extraction tool;
- `alignment`: the check made at import — `insideAcquisitionBox: 1.0` (100 % of the positions fall inside the volume's box), `spanRatio`, `aligned: true`;
- `surfaceOrigin`: `exported` if the `.glb` file comes from the tracking software, `reconstructed` if the platform rebuilt it from the cells.

The `registration` block says **whether the stabilisation can be applied to the image**: `appliedToVolume: true` only if the fit of the tracks is **rigid** (residual ≤ 0.05 µm; here 7.6 × 10⁻¹⁴ µm). Each `transforms[]` entry gives the 4 × 4 matrix (column by column, for `THREE.Matrix4.fromArray`), the angle (`rotationDeg: 7.0317` at the last frame) and the displacement in µm. Chapter 8 explains the calculation; chapter 12 shows what the viewer does with it.

### What a `2d` photograph changes

| Field | What it is |
|---|---|
| `dimensions` | `{x:1920, y:1440, z:1, c:3, t:1}`: three colour channels, never any depth |
| `pixelSizeUm`, `physicalSizeUm` | `{x:2.0, y:2.0}` µm per pixel and `{x:3840, y:2880}` µm: read from the TIFF's resolution tags |
| `image` | `{native:"image.webp", width, height, preview:"preview.webp", previewWidth:640, previewHeight:480}`: **fixed** file names, the import demands them as they are |
| `acquisition` | `{modality:"brightfield-stereo", sourceFile, series, dissectionDate, zoomNominal:3.2…}`: read from the file name and the Leica block |
| `line`, `staining`, `date` | `"DLL4xCD1"`, `"X-gal"`, `"2024-09-13"` |
| `orientation2d` | `{rotationDeg, flipH}`: set by the operator with the 2D orientation tool |
| `channels` | `[]`: a photograph has no channels |

## 17.4 Manifests and description files

### `bricks/manifest.json` (format 4)

This is the table of contents of the bricks. Here are **all** its fields, with the values of the 3D demonstration dataset.

| Field | What it is |
|---|---|
| `schema`, `version`, `formatVersion` | `"iribhm-bricks-v3"`, `3`, `4`: the reader picks its method from `schema` |
| `dataset` | dataset name |
| `channels` | `3` |
| `brickSize`, `apron` | `64` and `1`: a 64-voxel core with a one-voxel border (stored brick: 66³) |
| `brickPacking` | `{mode:"grid", cols:9, rows:8, slice:66}`: the mosaic of 66 slices of 66² |
| `encoding` | `"webp-lossless"` |
| `levels[]` | `{level, dimensions, voxelSize, gridSize, brickCount}` per level; e.g. level 0: `768×576×112`, voxel `1.2×1.2×3.0`, grid `12×9×2`, `269` bricks present |
| `timepoints` | `null` for a 3D dataset; for a series, a list `[{path:"t000", index:{url, bytes, sha256}}, …]` |
| `index` | `{url:"index.bin", bytes:7846, sha256:"aea0980…"}`; **absent** for a series (each frame carries its own) |
| `histograms[]` | per channel: `counts` (64 bins), `edges` (65 bounds), `total`, `max`, `mean`, `std`, `backgroundFloor` |
| `timepointHistograms` | for a series: the same histograms, frame by frame |
| `producer`, `createdAt` | `"pipeline"` (or a migration executor) and the date |

::: tech
**The histograms are computed on the coarsest level** (here `total: 96768` = 96 × 72 × 14 voxels). `backgroundFloor` is always `0` in the file: the viewer estimates the noise floor itself (chapter 11).
:::

![Who guarantees what: the manifest's fingerprint signs the planes and MIPs, the index's fingerprint signs the packs.](img-en/ch17/empreintes.svg){width=100%}

### `index.bin`

The index is explained byte by byte in chapter 7 (section 7.6). Three additions:

- its **size is predictable**: `12 + 16 × (number of levels) + 10 × (channels) × (sum of the grid cells)`. For the 3D dataset: 12 + 16 × 4 + 10 × 3 × 259 = **7,846 bytes**, exactly what the manifest says;
- packs are named **without any string in the index**: pack *p* of level *k* and channel *c* is called `l{k}/c{c}/p{p:05d}.bin`;
- the import checks the **exact** length, the fingerprint and the consistency with the manifest's levels (section 17.18).

### `planes/manifest.json` and `mips/manifest.json`

Both have the same shape; `mips/` adds two fields.

| Field | Real value (`planes/`) | Meaning |
|---|---|---|
| `schema` | `"lumen-planes-v1"` (`"lumen-mips-v1"`) | |
| `formatVersion` | `2` (`3`) | the format that introduced the structure |
| `level` | `0` | always the native level |
| `dimensions`, `channels` | `{768, 576, 112}`, `3` | equal to those of the bricks |
| `tileSize`, `tiles` | `512`, `{x:2, y:2}` | 512² tiles: 768 = 512 + 256, 576 = 512 + 64 |
| `codec` | `"png-gray8"` | 8-bit grey PNG, "None" filter |
| `packPattern`, `headerBytes` | `"z{z}.bin"` (`"l{l}.bin"`), `160` | `16 + 12 × channels × Y tiles × X tiles` |
| `layers`, `layerDepth` | (mips) `2`, `64` | one projection per layer of 64 planes |
| `source.manifestSha256` | `"6557d1fe…"` | fingerprint of the bricks manifest they come from |
| `producer`, `createdAt` | `"pipeline"` | `"pipeline"`, `"migration-browser"`, `"migration-server"` or `"mixed"` |

![A real plane file, byte by byte: the header, the table of 12 entries, then the PNGs.](img-en/ch17/pack-planes.svg){width=100%}

A `MIP` file (signature `LMIP`) has **exactly the same layout** as a plane file: its header's "z" field holds the layer index.

### "v2" bricks in five lines

Before format 4, `bricks/manifest.json` listed **every brick** in `brickTransport.brickToPack`: a key `lod0/c0/x000_y000_z000.webp` for an entry `{url:"lod0/c0/pack_00.bin", offset, length}`. Bricks were 64³ with no border, arranged in an 8 × 8 mosaic (512² image); packs were called `lodN/cC/pack_NN.bin`; a series had a `timepoints` dictionary rather than a list. The migrations of part B turn these files into their modern equivalent.

### `tracks.json`

A series' tracking lives in a separate file (`tracks.json`, and its compressed copy `tracks.json.gz`). Real structure from the demonstration dataset:

| Key | Content |
|---|---|
| `schema`, `source`, `sourceId`, `generated` | `"iribhm-tracks-v1"`, source name, unique identifier, date |
| `timepoints` | `[1.0, 2.0, 3.0, 4.0]`: the frame numbers (Imaris counts from 1) |
| `cells` | one object per cell, indexed by its number (50 cells) |
| `layout` | `{x_range, y_range, z_range}`: the extent of the stabilised positions |

One cell (number 23, which divides):

```json
{ "id": "23", "track_id": 1000000023, "region": "Posterior", "color": "#2ecc71",
  "positions": { "1": [119.6, 121.3, 69.5], "2": [119.4, 121.9, 68.6] },
  "raw_positions": { "1": [119.6, 121.3, 69.5], "2": [120.3, 121.6, 69.4] },
  "parent": "", "daughters": ["24", "25"],
  "is_mitosis": true, "is_fusion": false, "markers": { "2": "red" } }
```

`positions` are the **stabilised** coordinates in µm, `raw_positions` the acquisition coordinates; `parent` and `daughters` form the **lineage** (a mitosis: one mother, two daughters that share the same `track_id`). The viewer loads this file in a Web Worker that turns it into compact 32-bit arrays.

## 17.5 The catalogue and the type vocabulary

### A catalogue that is not a file

The list of datasets the public sees (`/DATA_WEB/catalog.json`) is **stored nowhere**: it is computed on every request from the `metadata.json` files.

![The catalogue is computed on demand, with a signature made of stat() calls to stay fast.](img-en/ch17/catalogue.svg){width=100%}

The exact rules of the construction:

- a folder whose name starts with a dot is **never** a dataset (it is a work-in-progress folder);
- a folder **without** `metadata.json` (processing under way) gives an "unconfigured" row, with no thumbnail — so it is absent from the public catalogue;
- `id`, `path`, `type` and `folderName` are **imposed** from the location; `thumbnail` is the file if it exists, `null` otherwise;
- datasets that are **configured or have a thumbnail**, and that are **not hidden**, are kept;
- the most recent date comes first; datasets without a date (volumes rarely have one) follow, by descending name.

::: why
**Why not a file?** The catalogue used to be a file that only the administration panel rewrote: a dataset copied over SFTP stayed invisible until someone clicked a regenerate button. Now the catalogue **holds no information of its own**: nothing to keep up to date, so nothing to forget.
:::

### One vocabulary, three words

Since version 1.51.0 a dataset type is written **`3d`**, **`2d`** or **`live`**, and that same word is at once the folder under `DATA_WEB/`, the start of the identifier, the `type` field, the value of a URL filter… The old words (`fixed`, `wholemount`, `tracking`) no longer exist anywhere in the code.

![The vocabulary conversion: done once at start-up, by both servers.](img-en/ch17/migration-types.svg){width=100%}

An old deployment is converted **once**, by an **idempotent** pass (replaying it changes nothing) run at the start of each server. It leaves **no marker**: a few folder-existence tests are enough to know there is nothing left to do.

::: tech
**One pass runs at every start-up.** It repairs the identity of a `metadata.json` whose `type` or `id` contradicts its folder. It exists because, before 1.54.1, a PHP host had written the editor's payload (which does not contain `type`) in place of the file. It rewrites only the inconsistent files.
:::

What the operator **sees** is never the technical word: the displayed names ("3D", "Photo", "Live"…) come from the site configuration (chapter 16).

## 17.6 `download/` and `gallery/`

### `download/`: the souvenirs

This folder is filled by the pipeline (option `--with-downloads`, chapter 8). Three platform rules concern it:

- **everything** in it is served **as an attachment**: an HTML or XML report dropped there never displays as a page of your site;
- it is **excluded** from platform updates and data migrations: it is never touched;
- the import accepts only **data** extensions there: `ims tif tiff png jpg jpeg webp gif zip txt md csv json pdf gz h5 hdf5`.

### `gallery/`: attached images

The operator can attach images to a dataset (annotated captures, figures). They live **inside** the dataset's folder, so they travel with it.

| Rule | Value |
|---|---|
| Maximum number | **40** images per dataset |
| Maximum size | **8 MiB** per image |
| Formats | WebP, PNG, JPEG, GIF; the extension is deduced from the **magic bytes**, never from the name sent |
| Thumbnails | `gallery/thumbs/<file>.webp` (320 px at most, never enlarged) for the grid; the viewer loads the original |
| Order and captions | in `metadata.json`, key `gallery`: `{file, added, thumb, title, caption}` |
| Caption | 400 characters at most; title 120 |

A file named `a.php.png` whose bytes are not those of a PNG is **refused**: only the bytes count.

::: warning
The gallery **does not travel** with the import (no rule of the allowlist accepts it). When a dataset is replaced, it is the platform that **moves** the gallery from the old folder to the new one (section 17.18).
:::

## 17.7 Formats 1 to 4

A published dataset carries a **format** number (`formatVersion`). The visitor has nothing to do: the viewer reads all four formats. But the recent formats open possibilities the old ones lack.

![Four steps: each adds a structure; a migration knows how to climb to it.](img-en/ch17/formats-escalier.svg){width=100%}

What each step unlocks:

| Format | What it allows | Where it is explained |
|---|---|---|
| 2 (`planes/`) | a **native** XY cut in the Studio reads one plane instead of a layer of 64; z-stack figures open fast | chapters 7 and 12 |
| 3 (`mips/`) | a maximum projection of the whole stack reads one image per layer | chapter 7 |
| 4 (v3 bricks) | **seamless** filtering between bricks, **local detail** ("Zoom detail"), lighter atlases for 1 or 2 channels, exact quality levels | chapters 9 and 10 |

### What a format number promises

A dataset **never declares a structure it does not have**. The pipeline writes the highest format whose structures are **all** complete on disk (every tree of a series included); the platform does the same. If a dataset says "format 3" but `mips/` is damaged, the [Data updates]{.ui} tab offers it for **repair**.

### A v2 brick and a v3 brick

![What migration m004 changes, point by point.](img-en/ch17/v2-v3.svg){width=78%}

### When does a level also reduce Z?

In the old format, reduction was mostly in XY. Format 4 applies a precise rule: the native level is copied **as it is**, then each level divides X and Y by 2; it **also** divides Z only if the voxel is not already much thicker in Z than in XY (`vz ≤ 1.5 × vxy` of the next level).

![The Z-reduction rule, on the demonstration dataset and on a large anisotropic embryo.](img-en/ch17/niveaux-z.svg){width=100%}

::: example
**The large embryo (3789 × 3789 × 257, voxel 0.43 × 0.43 × 2.06 µm).** Level 1: 0.86 µm in XY; 2.06 > 1.5 × 0.86 = 1.29, so Z is **kept**. Level 2: 1.72 µm in XY; 2.06 ≤ 1.5 × 1.72 = 2.58, so Z is **reduced** (129 planes). Six levels in all, down to 119 × 119 × 17.
:::

The reduction is an **integer mean**, rounded to the nearest (halves round up): `(sum + n/2) // n`. The same arithmetic is used by the pipeline, Python, PHP and the browser: that is what makes their results **identical voxel for voxel**.

## 17.8 Three migrations, one registry

A **migration** transforms a dataset from version *v* to version *v + 1*. The three migrations form an **ordered registry**, identical in three languages.

| Identifier | From → to | What it creates | Applies to |
|---|---|---|---|
| `m002-planes` | 1 → 2 | `planes/`: the native level re-cut into XY planes | `3d`, `live` |
| `m003-layer-mips` | 2 → 3 | `mips/`: the maximum of each layer of 64 planes | `3d`, `live` |
| `m004-bricks-v3` | 3 → 4 | a new `bricks/` tree (66³, binary index) | `3d`, `live` |

Each entry carries an identifier, the versions, the types concerned and a **title and a description in four languages** (this is what the tab displays).

::: tech
**The three twins.** The registry exists in Python (`dataset_migrations.py`), in PHP (`api/_migrations_lib.php`, `_migrations_formats.php`, route `api/migrations.php`) and in the browser (one module per migration: `js/migrations/m002-planes.js`…). The shared **contract**, including every byte of the formats, is the specification `DOCS/dataset-migrations/SPEC.md`. Adding a migration = adding an entry in the three twins, its split into units, its two executors and a browser module; nothing else changes.
:::

### Which dataset needs what?

A dataset at version *v* receives, **in order**, every migration whose "from" is ≥ *v*; a migration applies only if the dataset is **exactly** at its starting version. A format 1 dataset therefore gets m002, then m003, then m004.

For each **published** `3d` or `live` dataset (2D photographs are always "up to date"; a dataset still being imported is not concerned), the tab decides as follows:

| Finding | What the tab offers |
|---|---|
| `formatVersion` lower than the current one | the missing migrations, in order |
| the version announces a structure that is absent or invalid (`planes/` missing, `mips/` damaged…) | a **repair**: the migration that produces that structure is redone |
| version 4 but damaged v3 bricks | a **problem** (`bricks_v3_invalid`), not a repair: the old tree no longer exists |
| unreadable or missing manifest (`manifest_invalid`, `no_manifest`) | a problem flagged on the dataset's row |
| a series whose frames do not all have the same dimensions | refusal (`trees_differ`): m004 cannot convert it |

Before starting, the server **refuses a job the disk cannot hold** (error 507, like the import): it estimates the space needed for the result — about 1.3 times the native level for `planes/`, 5 % of the size of `planes/` for `mips/`, about 1.3 times the old pyramid for v3 bricks — and requires it to fit both in the working store and next to the dataset (twice on a single disk), with a 512 MiB reserve.

### A real end-to-end trial

To check every claim in this chapter, a **synthetic format 1** dataset (520 × 520 × 130 voxels, 2 channels, random noise) was converted by the real Python engine in a temporary folder.

| Step | Units | Time | Size before → after |
|---|---|---|---|
| m002 → format 2 | 24 (1 of them empty) | 2.4 s | `planes/`: 42.0 MB (the bricks: 40.1 MB) |
| m003 → format 3 | 24 (1 of them empty) | 0.6 s | `mips/`: 0.70 MB |
| m004 → format 4 | 30 | 16.3 s | `bricks/`: 40.1 MB → 48.9 MB |

::: warning
These sizes are **not representative**: random noise cannot be compressed, and format 4 adds 9.7 % of border. On real images (mostly black, with smooth signal) the v3 pyramid is generally lighter. Remember the **units** and the **mechanics**, not the megabytes.
:::

## 17.9 Work units and the journal

Converting a 10 GB dataset in one piece would fail at the first incident. The platform therefore cuts it into independent **units**.

![One unit = one layer of 64 planes, one channel, one 512² tile: here, the 24 units of the demonstration dataset.](img-en/ch17/unites.svg){width=100%}

For m002, a unit processes **one layer of bricks** (at most 64 planes in Z), **one channel** and **one tile** of 512 × 512 pixels (= 8 × 8 bricks): it decodes the matching bricks, then emits up to 64 PNG tiles, one per plane.

::: example
**The 24 units of the 3D demonstration dataset.** 112 planes = 2 layers (64 + 48); 768 × 576 pixels = 2 × 2 tiles; 3 channels. 2 × 3 × 4 = **24 units**. For the `live` dataset: 4 frames × 1 layer × 2 channels × 1 tile = **8 units**.
:::

The three migrations do not have the same unit shape:

| Migration | Unit key | What the unit does |
|---|---|---|
| m002 | `t{t}.z{bz}.c{c}.y{ty}.x{tx}` | decodes the bricks of a layer, produces PNG tiles |
| m003 | `t{t}.l{l}.c{c}.y{ty}.x{tx}` | reads the ≤ 64 plane tiles of a layer, keeps the **maximum** pixel by pixel |
| m004 | `t{t}.k{k}.c{c}.z{BZ}.y{BY}.x{BX}` | builds the v3 bricks of a **4 × 4 × 4 super-block** of level *k* |

A unit whose bricks are **all** absent is **empty**: it is counted "done" from the start and needs no work.

### The next level waits for the previous one

For m004, level *k + 1* is computed from level *k*: it can therefore start **only once the previous level is complete**. The server returns the units that are **runnable now** (`runnable`) and the total remaining (`pending`).

| Level (real trial) | Dimensions | Units |
|---|---|---|
| 0 | 520 × 520 × 130 | 18 |
| 1 | 260 × 260 × 65 (Z reduced) | 8 |
| 2 | 130 × 130 × 33 | 2 |
| 3 | 65 × 65 × 17 | 2 |

At the start, 18 units out of 30 are runnable; the others wait. The browser **re-plans in waves** until none are left.

### The tally sheet

::: analogy
**A house move.** Each unit is a **box**. The mover ticks each delivered box on a sheet. If the van breaks down, or you switch vans, you start again from the last ticked box. If a box is delivered twice, nobody notices: the second one overwrites the first.
:::

This sheet is the **journal**, one JSON file per migration and per dataset, in `uploads/migrations/` (an area that is **never served**). Next to it, a **tile store** keeps the results of finished units.

![The journal of a real m002 conversion and its tile store.](img-en/ch17/journal-migration.svg){width=100%}

| Journal field | Meaning |
|---|---|
| `migration`, `dataset` | which migration, on which dataset |
| `sourceManifests` | `{tree: sha256}` of each tree's starting manifest |
| `inputManifests` | (m003) fingerprint of the `planes/` manifest used as input |
| `units` | `{total, empty}`: number of units and number of empty units |
| `done` | the list of keys of finished units |
| `executors` | `{browser: n, server: n}`: who carried how many units |
| `state` | `running`, `assembling`, `swapped` or `failed` |
| `producer`, `assembledAt`, `assembly` | from assembly on: who produced, when, and the progress |
| `error`, `createdAt`, `updatedAt` | cause of a failure; dates |

The properties that make this mechanism solid:

- the journal is written **"all or nothing"**, under a lock: two simultaneous writes do not mix;
- a **replayed** unit is harmless: it replaces its own tiles;
- if the **bricks manifest changes** during the work (the dataset was reprocessed meanwhile), the work is invalidated (`source_changed`): two versions of the same dataset are never mixed;
- a dataset deleted along the way is **never recreated** by a job that finishes.

## 17.10 Two executors

The work of each unit can be done by **two executors** that write into **the same journal**.

![Two lanes, one journal: the browser and the server share the list of units.](img-en/ch17/deux-voies.svg){width=100%}

### The browser

A **Web Worker** (`js/workers/migration-worker.js`) does all the computing, with a small module specific to the migration (`js/migrations/<id>.js`). For each unit:

::: steps
1. **read** the input bytes from the packs, by byte ranges, in **a single request** (`read_ranges`);
2. **decode** the lossless WebP bricks, exactly as the viewer does;
3. **re-cut** and **encode**: PNG tiles (m002, m003) or v3 WebP bricks (m004);
4. **send** the result in one request (`unit_put`, 32 MiB at most).
:::

The tab launches **at most 2 workers × 2 units** (the number of workers is half the cores, from 1 to 2): a unit holds up to about 40 MiB in memory. The server **re-checks** everything it receives: each PNG must start with the right signature and have the right dimensions; each v3 brick must be a lossless WebP of 594 × 528 pixels, with the 6 unused cells at zero.

### The server

The tab calls `unit_run` **in a loop**; each call lasts at most 20 seconds (less on a host that limits time) and processes as many units as it can. The server itself reads the bricks and writes into the store. A 120-second "lease" prevents two calls from taking the same unit.

::: why
**Why a loop driven by the browser?** Shared hosts have no background task: every computation must fit **inside one request**. It is the open tab that restarts it, hence the instruction not to close it.
:::

### Who can do what: the probes

An executor is offered only if it **knows how** to do the step. The capability is measured **per migration** and **per executor**, by a small real trial.

| Reason shown on screen | Code | What is missing |
|---|---|---|
| the server cannot decode lossless WebP images | `no_webp_decode` | Pillow without WebP, or `imagecreatefromwebp` absent / faulty |
| the server cannot encode lossless WebP images | `no_webp_lossless_encode` | PHP < 8.1 with WebP, or Pillow without the lossless option |
| the server has no NumPy | `no_numpy` | (Python, m004) |
| the server has no zlib compression | `no_zlib` | |
| the server allows less than 128 MiB of memory per request | `low_memory` | |
| the server stops requests after less than 10 seconds | `exec_time_too_short` | |
| this browser has no compression streams | `no_compression_stream` | `DecompressionStream` |
| this browser does not round-trip PNG tiles exactly | `no_png_codec` | |
| this browser cannot encode lossless WebP images | `no_webp_lossless_encode` | |

The server's probe decodes a tiny **built-in** WebP and compares every pixel value; the m004 one encodes a test brick, then decodes it and compares **every voxel**. The browser's probe, for m004, checks that an `OffscreenCanvas` really produces **lossless** WebP (by reading it back).

### Who is chosen when nobody chooses?

The choice is made **per dataset**, before the start, and it is **locked** while the job runs. The order of decision:

1. the operator's manual choice (remembered in this browser);
2. otherwise the **speed-test winner**;
3. otherwise the browser;
4. otherwise the server.

Each executor has **its own queue**: a dataset given to the browser and another given to the server move forward **in parallel**; two datasets given to the same executor go one after the other. A step the chosen executor cannot do is handed to the other, **in the same queue**: a dataset's steps stay in order.

### The speed test

![Five seconds, one synthetic block, two executors.](img-en/ch17/speedtest.svg){width=100%}

The test reads and writes **no dataset**: it uses a fixed block shipped with the platform. The **score** is the number of blocks converted per second, multiplied by 10, measured over the duration of the last completed batch or call: a batch cut off by the deadline does not skew the measurement. If the browser completes no batch, it is given one more window. The result is remembered in this browser.

### The API actions

All of them require the administration session; those that modify something also require the anti-CSRF header and the POST method (chapter 19).

| Action | Role |
|---|---|
| `status` | the whole state: registry, datasets, server capabilities |
| `plan` | creates or resumes a job; returns the runnable units |
| `unit_put` | receives the result of a unit done by the browser |
| `unit_run` | does units on the server side, in a bounded time |
| `finalize` | assembles, swaps, raises the version (can be called again) |
| `cancel` | deletes journal and store |
| `bench` | measures the server on a few units (tool) |
| `speedtest`, `speedtest_put`, `speedtest_sample` | the three pieces of the speed test |
| `read_ranges` | returns up to 1,024 byte ranges (32 MiB) of packs, in one answer |
| `store_get_many` | returns up to 128 v3 bricks from the store, in one answer |
| `unit_inputs`, `store_get` | lists a unit's inputs; reads one stored brick |

## 17.11 `finalize`: the swap and the version change

When all units are done, what remains is to **assemble** the results into a complete structure, **install** it and **change the version number**. That is the job of `finalize`, **always run by the server**, whichever executor did the units.

![The five moves of finalize, and what the disk looks like at each moment.](img-en/ch17/finalize.svg){width=100%}

Two ideas make it robust.

**It is resumable.** Assembly writes the files one by one into the neighbouring folder; if it is interrupted (time limit, power cut), it answers `complete: false` with its progress and you **call it again**. It resumes where it stopped.

::: example
**A real trial.** With a tiny time budget, `finalize` answered `{complete: false, assembly: {planes: 130, written: 0}}`: 130 planes to write, none written. The next call answered `{complete: true, formatVersion: 2}`. The journal went through the `assembling` state, with `producer: "migration-server"`.
:::

**The version change is the commit point.** Throughout assembly, and even after the swap, the old number stays in place. If the server stops between the swap and the version change, the dataset has its **new files** and the **old number**: the tab offers it again, and `finalize` — idempotent — finishes the job.

### The moves specific to each migration

- **m002 and m003**: `planes/` (or `mips/`) is renamed to `.planes-old/`, the neighbouring folder replaces it, then the old one is deleted.
- **m004**: `bricks/` is swapped with `.bricks-incoming/`; the manifests of `planes/` and `mips/` — which had noted the fingerprint of the old manifest — are **re-signed** with the new one's (their voxels, those of the native level, have not changed); the version goes up; **only then** is `bricks.v2-old/` deleted.
- before swapping, every assembled structure is **re-read and validated** (`assembly_invalid` otherwise);
- the version is raised **under the lock of `metadata.json`**, by **merging** into the current file: a save made in the editor meanwhile is not lost, and no other field is touched;
- without a journal (lost in a crash), `finalize` checks whether the structure is already there and valid: it then just re-signs and raises the version.

::: tech
**Why `bricks.v2-old/` stays until the end.** The viewer may still be reading the old tree when the swap happens. The file names of v3 packs (`l0/c0/p00000.bin`) look nothing like those of v2 (`lod0/c0/pack_00.bin`) and the manifest carries a different `schema`: a reader never confuses the two.
:::

## 17.12 The network governor and slow hosts

### An incident behind the governor

In version 1.59.1, a flood of requests (two groups of workers, one request per stored brick, an unbounded speed test) led a host to **ban the operator's address**. Since then, **all** the tab's requests — its own calls and those of its workers — go through **a single governor** (`NetGovernor`).

![The governor (real class, virtual clock) and what 1.59.3 gained on the test pair of datasets.](img-en/ch17/gouverneur.png){width=95%}

Its rules, measured in the code:

- **6 requests in flight** at most;
- a **token bucket**: it starts at **4 requests per second** and never exceeds **6** (1.59.2 ran from 10 to 16, before a unit's inputs travelled together);
- a request with **no answer**, a **429** or a **503**: the rate is **halved** (floor 0.5 request per second) and **every new request is held** for 5 seconds, then 10, 20… up to 60 as long as the failures continue;
- each answer received **raises** the rate by 0.2 request per second.

The tab says so: "The host is answering slowly: requests are paced down so that it does not block this address."

### About three requests per unit

Since 1.59.3, a unit reads **all** its input ranges in **one** answer (`read_ranges`), its level-*k* bricks in groups of 128 (`store_get_many`) and sends its result in **one** request. Measured on the same pair of test datasets (two 2-channel volumes, formats 1 → 4):

| Version | Requests | Average rate | Duration |
|---|---|---|---|
| 1.59.1 | about 3,400 (over 40 per second) | — | — |
| 1.59.2 | 3,443 | 8 per second | 436 s |
| 1.59.3 | **424** | 3.7 per second (11 at most in the worst second) | **115 s** |

A server that does not know `read_ranges` answers "unknown action" (400): the worker then reads range by range, the old way.

### When the server is too slow: octants

On a shared PHP host, a request that exceeds `max_execution_time` is **killed** by the host. The server cannot know in advance, so it protects itself.

![A unit that is too slow is split into 8 octants; two request deaths hand over to the browser.](img-en/ch17/octants.svg){width=100%}

Before each step, the server calls `set_time_limit()`; `status.server.limits.resettable` says whether the host honours it. Then:

1. **before** starting a unit, it writes `attempts[unit] + 1` in the journal;
2. for m004, a unit can be done in **8 octants** (2 × 2 × 2 bricks of the super-block), each stored and noted (`partial[unit]`) before the next: the unit is ticked when all are in. It does this automatically as long as no whole unit of the level has been timed, when the slowest (+ 25 %) would not fit in the remaining time, or after a request death;
3. a unit whose steps have killed the request **twice** gets the answer **409 `unit_timeout`**. The journal stays `running`, **nothing is lost**, and the tab hands this migration to the browser, which has no such ceiling.

### What the tab says when something goes wrong

| Code | Message on screen |
|---|---|
| `source_changed` | the dataset was re-processed since the update started |
| `brick_undecodable` | a brick could not be decoded |
| `incomplete` | some units are not done yet |
| `no_progress` | the server made no progress |
| `request_failed` | a request keeps failing |
| `prepare_failed` | the dataset could not be read |
| `unit_blocked` | a lower level of the pyramid is not complete yet |
| `bad_webp` | the server refused a converted brick |
| `insufficient_disk` | not enough disk space on the server (needed / free) |
| `no_executor` | neither this browser nor the server can run this update |
| `unit_timeout` | the server cannot convert one unit within its time limit |

::: remember
- A migration = **units** ticked in a **journal**; two executors, a browser or a server, write into it.
- The **last move** is the version change, **under the lock** of `metadata.json`; until it has happened, nothing is lost.
- The **governor** protects the operator's address; **three requests per unit** have been enough since 1.59.3.
:::

## 17.13 The course of an import

Chapter 14 (section 14.3) shows the [Import]{.ui} tab. Here is what happens **underneath** each gesture.

![From the dropped folder to the published dataset: six steps, three of which carry bytes.](img-en/ch17/import-flux.svg){width=100%}

### 1. Drop: reading the folder

The browser reads the dragged folder with the `webkitGetAsEntry` interface, the only one that works for a **folder** in all current browsers. It returns only about a hundred entries per call: each folder is **drained** in a loop, otherwise a dataset would be cut off at its first hundred packs. Eight files are resolved at a time (opening them one by one would take minutes for 100,000 packs) and a limit of 400,000 entries protects memory; whatever could not be read is **counted and reported**.

A dataset is **recognised** by its `metadata.json`. Its **type** comes from the `type` field of that file; failing that, from the name of the parent folder if it is called `3d`, `2d` or `live`. The **name of the dropped folder is the dataset's identifier**: hence the message "Drop the dataset FOLDER, not its contents".

::: warning
The import requires a **secure connection** (HTTPS, or `localhost`): the SHA-256 fingerprints rely on `crypto.subtle`, which the browser does not offer over plain HTTP. The panel says so once, up front, rather than failing file by file.
:::

### 2. Plan: one request per dataset

For each dataset, the browser sends **the list of its files with their sizes** (never the bytes). The server **re-derives** everything: the shape of the type and folder, each path against the allowlist, and the state of what is already stored or published. For each file it answers: accepted or refused, tier, file number (`fileId`), and — for a partially received file — the **missing blocks**.

A few safeguards of the planning step:

| Limit | Value |
|---|---|
| files per dataset | 200,000 |
| datasets per drop | 200 |
| size of one file | 1 TiB |
| space to leave free on the disk | 512 MiB |

If the disk cannot hold what remains to be sent, the answer is `insufficient_disk` **before a single byte** (with `neededBytes` and `freeBytes`): a disk that fills up along the way would block every other writer on the host. A list too large for the host's request size (`post_max_size`) is reported too.

### 3 and 4. Send and close

The rest is detailed in sections 17.16 (blocks and journal) and 17.18 (verify, publish). The whole transfer happens in a **Web Worker**: reading an 8 MiB slice and hashing it costs tens of milliseconds of pure computation; on the main thread, that would be a lost frame for every block.

### The import API actions

| Action | Role |
|---|---|
| `limits` | block size, ceiling, parallelism, grace period, server type |
| `ping` | one authenticated round trip: tells "network cut" from "session expired" |
| `list`, `state` | the datasets being imported; the detail of one dataset; **the list also triggers the clean-up** |
| `plan` | plans a dataset (above) |
| `chunk` | receives a block |
| `file_done` | closes a file |
| `validate` | overall check of the dataset |
| `blob` | reads a file being imported (preview) — under the admin session |
| `metadata`, `save_metadata`, `save_thumbnail` | editing during the transfer |
| `publish`, `discard`, `gc` | publish, delete, clean up |

## 17.14 The allowlist

Only what the **pipeline produces** is accepted. Everything else is refused **before the first byte**, by two successive barriers.

![Two barriers: the shape of the path, then an explicit rule per dataset type.](img-en/ch17/liste-blanche.svg){width=78%}

::: why
**Why a closed list rather than a list of prohibitions?** A blocklist always forgets something (a rare extension, a Windows device name). A list of what is **allowed** cannot forget: whatever was not anticipated is refused. The landing area is also **never served** (chapter 19), and publication happens only after validation.
:::

The details of the rules, as the engine applies them:

- packs: `lod<N>/c<M>/pack_<n>.bin` (formats 1 to 3) or `l<k>/c<c>/p<NNNNN>.bin` (format 4), under `bricks/` or under `bricks/tNNN/` for a series (type `live` only);
- `planes/` and `mips/`: `manifest.json` and the named packs (`zNNNNN.bin`, `lNNNNN.bin`), with a `tNNN/` sub-folder for a series;
- `download/`: a plain name (no sub-folder), up to 181 characters, a **data** extension (list in section 17.6), **judged on its last extension**; Windows reserved names (`CON`, `NUL`…) and names ending in a dot or a space are refused;
- never accepted: `.php`, `.js` and `.htaccess` files, any hidden file, any path going up (`..`), and the formats a browser **executes** when opened (HTML, SVG, XML).

::: note
A file named `a.php.png` **passes** (its last extension is `png`): this is not a hole, because `download/` is never executed and always served as an attachment. What matters is that the file lands in a folder where **nothing executes**.
:::

## 17.15 Tiers: why a dataset is editable before the end

A complete dataset weighs tens of gigabytes, and the upload can last hours. Files are therefore sent **by priority**: the most useful first.

![The five tiers, with the real bytes of the demonstration dataset and a scenario of 10 GB at 5 MB/s.](img-en/ch17/paliers.svg){width=100%}

| Tier | Content | Why in this order |
|---|---|---|
| 0 · core | `metadata.json`, manifest, `index.bin`, thumbnail | enough to **mount** the dataset |
| 1 · preview | the **coarsest** level, all channels (and `tracks.json` for a series) | enough to display something |
| 2 · intermediate | the levels between the coarsest and the native, from coarsest to finest | quality rises progressively |
| 3 · native | level 0, and frames 1, 2, 3… of a series | full-quality work |
| 4 · the rest | `planes/`, `mips/`, `download/` | never needed to **open** |

A pack's tier depends on the **whole** dataset (which level is the coarsest?): the server therefore recomputes it once the full list is known. A series opens on its **first frame**; the following ones are tier 3.

::: example
**The figure's scenario.** The demonstration dataset has 47 kB of tier 0 and 32 kB of tier 1: scaled to 10 GB of bricks (same proportions) at 5 MB/s, the dataset is **openable and editable in about 17 seconds**, every quality except native is there in 5 minutes, the complete bricks in 33 minutes. Tier 4 may take longer than everything else.
:::

### When the dataset becomes "editable"

The dataset moves to the **editable** state when **all** the tier 0 and 1 files are finished and `metadata.json` and a mounting file (manifest or 2D preview) have arrived. You can then open it at low resolution and rename it, adjust the channels, orient it.

### The lock on `metadata.json`

As soon as you **save** an edit on a dataset being uploaded, the server writes your `metadata.json` and sets a lock (`metaLocked`). The transfer **no longer rewrites it**: receiving a new block of `metadata.json`, or a new planning pass, skips the file. Without this, the end of the transfer would silently have **erased your work** by sending the original file back.

## 17.16 Blocks and the import journal

### A block

Each file is cut into **8 MiB blocks** by default. The server may impose a smaller size (never larger): a PHP host limits the size of a request.

![A block, from reading to writing: hashing, check, writing at its exact offset, note in the journal.](img-en/ch17/bloc.svg){width=84%}

| Block limit | Value |
|---|---|
| default size | 8 MiB |
| ceiling (Python) | 16 MiB |
| floor | 256 KiB |
| PHP host | 80 % of `post_max_size`, and at most a quarter of `memory_limit` |
| blocks in parallel | 4 |

If a host refuses the chosen size (`body_truncated`), the interface **reduces** the size, re-plans and says "Block size reduced to … — drop the folder again to resume". Blocks already received remain valid: they are counted from the size **recorded** for each file.

::: example
**The example's figure.** A 22 GiB original represents 2,816 blocks of 8 MiB; the list of what has been received fits in 2,816 bits, i.e. **352 bytes**. Blocks may arrive **out of order and in parallel**: each is written at its exact offset (`index × block size`).
:::

### Three levels of checking

| When | What |
|---|---|
| at every block | SHA-256 recomputed **before** writing; expected length; does the file number match the path? |
| when a file is closed | all blocks present, exact size on disk, **global fingerprint** = SHA-256 of the sequence of block fingerprints, plausible content (WebP signature, valid JSON, index header…) |
| at dataset validation | overall consistency (section 17.18) |

::: why
**Why a "fingerprint of fingerprints"?** A browser cannot hash a 22 GiB file as a stream, and re-reading it a second time would double the work. The fingerprint of the **sequence of block fingerprints** proves the same thing — every block verified, in the right order, none missing — **without** re-reading anything.
:::

When the upload fails, two families of failures are handled differently: a **server** failure (5xx error, saturation, wrong fingerprint) uses up one of the **6 attempts**, with a growing wait of 1 to 30 seconds (± 25 %); a **network** failure (no answer) uses up **nothing**: the whole transfer goes on hold until the connection returns. An outage of several minutes costs time, never files.

### The journal: three files, one shared format

![The import journal: the state of each file, the table of planned files, the log of received blocks.](img-en/ch17/journal-import.svg){width=88%}

They live in `uploads/state/` and are named `<type>__<folder>`. Python and PHP both read **and** write them: **an import started under one server resumes under the other**.

| File | Role | Rewritten |
|---|---|---|
| `.json` | the state of each file: size, block size, tier, kind, number, one cell per block (base 64), `done` | at planning and at every finished file |
| `.files` | the table of planned files: 16 header bytes (`LUFT`) then 32 bytes per file | when a number changes |
| `.log` | one **16-byte record per received block**: file number, block index, `LUC1`, CRC32 | **never**: append only |

::: tech
**Why an "append-only" journal?** Rewriting the whole JSON file at every 8 MiB block cost 40 ms for 20,000 files and half a second for 200,000, **under the dataset's lock**: the four parallel streams queued behind each other. Appending 16 bytes costs almost nothing. The journal is **compacted** (folded into the `.json`, then the `.log` is emptied) at planning, at the end of a file and at every journal write.
:::

What keeps the journal safe even after a crash:

- a record is appended only **after** the `fsync` of the bytes: a record that survives always describes bytes really on disk;
- a truncated tail, or a record whose signature or CRC does not match, is **ignored**: at worst this costs one resend;
- the file number is **never reused**: when a file is re-planned (size changed) or reset, it receives a new number, and a record written for the old one can no longer land on the new one;
- the file's path is checked by a **16-byte fingerprint** stored in the table: this proves that a number designates the path that was sent without re-reading the journal.

## 17.17 Import states and the purge

![Four states; an abandoned dataset is purged after seven days, a finished one never.](img-en/ch17/etats-import.svg){width=100%}

| State (code) | Label on screen | Condition |
|---|---|---|
| `uploading` | [Uploading — not editable]{.pill .amber} | the tier 0 and 1 files are not all there |
| `editable` | [Uploading — editable]{.pill .blue} | tiers 0 and 1 finished, `metadata.json` and a mounting file arrived |
| `staged` | [Uploaded — ready to publish]{.pill .green} | **all** planned files are finished |
| `stalled` | [Interrupted]{.pill .grey} | no block accepted for 7 days |

### The seven-day purge

A dataset that nobody finishes occupies real disk in the landing area. The operator has **seven days** (604,800 seconds) to drop the folder again and resume; after that, the clean-up frees its files and its journal, and the upload starts again from scratch.

- the clean-up runs **every time the list is displayed**, or on demand (action `gc`);
- the countdown is measured from the **last activity** (a file uploading for hours counts as activity);
- a dataset in the **[Uploaded — ready to publish]{.pill .green}** state is **never** purged: it is complete and validated, and it is only waiting for your click. Deleting it after a week would destroy tens of gigabytes of finished work to spare a resend nobody asked for.

### What stays readable during the upload?

The preview of an unpublished dataset goes through the `blob` action: a file from the landing area is served, **under the administration session**, as opaque bytes (with `nosniff`), never as a document. The landing area is reachable by **no address**; it is blocked in the Python server, in the root `.htaccess`, in `router.php` and by a deny file of its own.

## 17.18 Validate, publish, replace

### Validate

The validation action re-reads the **entire** dataset and checks that it forms a whole. It returns a list of codes; there are a few dozen, and here are their families.

| Code | What it means |
|---|---|
| `missing_metadata`, `metadata_not_json` | no `metadata.json`, or unreadable |
| `metadata_type_mismatch` | the declared type is not that of the drop folder |
| `metadata_no_dimensions`, `metadata_bad_dimensions`, `metadata_no_channels` | invalid dimensions or channels |
| `metadata_no_image`, `metadata_bad_image` | (2D) `image` block absent or file names not conforming |
| `missing_manifest`, `manifest_not_json` | no `bricks/manifest.json`, or unreadable |
| `manifest_no_levels`, `manifest_level_N_…`, `manifest_bad_brick_size`, `manifest_bad_encoding`… | inconsistent manifest (levels, 64 voxels, encoding) |
| `missing_index:…`, `index_hash_mismatch:…` | `index.bin` absent, or different from the manifest's fingerprint |
| `index_bad_magic`, `index_bad_length`, `index_shape_mismatch:…`, `index_grid_mismatch:…` | the index has the wrong shape or does not describe the manifest's levels |
| `missing_pack:<path>` | a pack that the index cites has not arrived |
| `truncated_pack:<path>` | a pack is shorter than what the index requires |
| `manifest_pack_escapes` | a pack points outside the dataset's folder |
| `incomplete_files` | planned files are not finished |
| `stray_files` | a file present in the landing area was never accepted by a plan |
| `missing_preview`, `missing_image` | (2D) one of the two copies is missing or empty |

::: example
**Real trials** on the demonstration dataset, in a temporary folder. Everything arrived: `{ok: true}`. The pack `l0/c1/p00001.bin` is **truncated** by 1,000 bytes: `truncated_pack:l0/c1/p00001.bin`. It is **deleted**: `missing_pack:l0/c1/p00001.bin`. `index.bin` is **altered**: `index_hash_mismatch:bricks`. A file `stray.txt` is dropped in: `stray_files`. A block with a wrong fingerprint gets `422 checksum_mismatch`; a block with no fingerprint, `400 checksum_required`.
:::

A truncated pack passes its own block fingerprints if the client simply never sent the end: only the overall validation catches it, **before** a visitor sees a black screen.

### Publish

![Validate, carry over the operator's work, swap the folders, conclude.](img-en/ch17/publication.svg){width=100%}

Publication moves the validated dataset from the landing area to `DATA_WEB/<type>/<folder>/`.

- it is **hidden by default**: the operator decides when the public sees the dataset;
- it is a **rename** (almost atomic) when the landing area and `DATA_WEB/` are on the same disk; otherwise, a copy into a neighbouring `.incoming-…` folder followed by a rename, so that a half-copied dataset is never visible under its real name;
- before moving, temporary write files are swept away: they never travel to the site.

### Replacing an already published dataset

If the destination folder exists, publication answers `409 already_exists`, and the interface asks for confirmation of the replacement. With `overwrite`, in order:

1. the curated keys of the old file that the new one **does not contain** are carried over (section 17.2);
2. the old folder is renamed `.replaced-<dataset>-<date>`;
3. the new one is renamed into its place;
4. the **gallery** of the old folder (images and thumbnails) is moved into the new one, then the `gallery` list keeps only the files actually present;
5. the old folder is deleted, together with the import journal.

If the server stops **between the two renames**, at the next start-up `recover_publish_leftovers()` puts the old dataset back in place; a `.replaced-…` whose dataset exists is deleted, and an `.incoming-…` (partial copy) always is.

::: note
The interface does **not resend** a folder whose name already exists in `DATA_WEB/`: it treats it as "already published" rather than resending gigabytes. Replacement is offered at the moment of [Publish]{.ui}, when the server reports that the name exists.
:::

### What to take away

::: remember
- A **closed allowlist**: whatever is not anticipated is refused before the first byte; the landing area is **never served**.
- **Tiers**: the files that make the dataset openable go first, and an edited dataset keeps its `metadata.json`.
- **Hashed blocks** and an **append-only journal**: a cut costs at worst one block, and the import resumes under either server.
- An **"all or nothing" publication**, hidden by default, which carries over the operator's work and the gallery.
:::

::: see
The screens, buttons and floating dock of the import are in chapter 14; the security of the landing area is in chapter 19; the exact contract of the migrations is in `DOCS/dataset-migrations/SPEC.md`.
:::
