# 8. The end of the pipeline: metadata, cell tracking, publication

::: chapter-intro
- After the bricks, the pipeline makes the **thumbnail**, the **histograms** and the `metadata.json` file (stage, embryo, calibration, channels), and, for a time series, the **cell tracking**.
- The result is published **"all or nothing"**: the dataset already online is never left half-replaced, and what you entered by hand is kept.
- You launch everything with `RUN.bat`, then copy the folder it produces to the server (FTP) or drag it into the [Import]{.ui} tab.
:::

The data images in this chapter come from the **demonstration dataset** (synthetic embryos generated for this documentation, processed by the real pipeline): they are not lab data.

## 8.1 The thumbnail

The thumbnail is the small image on the dataset's card in the explorer. It is made from the **first image** of the acquisition, using the finest resolution level whose long side does not exceed 1024 pixels.

For each channel, the pipeline computes a **MIP** (the brightest voxel across the whole thickness), colours it, then **adds** the channels: where two channels overlap, the colours add up.

![Three coloured MIPs, added together, give the real thumbnail of the demonstration dataset.](img-en/ch08/vignette.png){width=96%}

::: tech
Thumbnail colours, in channel order: green, magenta, blue, red, yellow, violet, cyan (repeating). They have no link with the colours chosen in the viewer. The image is reduced to 512 pixels on its long side (Lanczos interpolation), centred on a square of `#080a12` background, then saved as **lossy WebP**, quality 88 (33.6 KB here).
:::

## 8.2 The histograms

For each channel, the pipeline counts how many voxels have each grey value, on the **coarsest level** (the fastest to read). The values 0 to 255 are spread over **64 bins** of width 3.98.

![The three histograms stored in the demonstration dataset's manifest (logarithmic scale: the background at 0 would flatten everything else on a linear scale).](img-en/ch08/histogrammes.png){width=96%}

They are stored in `bricks/manifest.json` (`counts`, `edges`, `total`, `max`, `mean`, `std`); the viewer shows them in the channel panel (chapter 11). For a time series there is **one set per image**, because photobleaching would change the scale of a shared set.

## 8.3 `metadata.json`: the dataset's identity card

This is the only place where the facts about a dataset are written; the site's catalogue is computed from it on every request. **Real** excerpt (abridged) from the demonstration dataset:

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

| field | what it is |
|---|---|
| `id`, `type` | the type (`3d` or `live`) and the folder: `3d/<name>` |
| `formatVersion` | the data format (chapter 7); written by the pipeline, never edited by hand |
| `stage`, `embryo` | read from the file name (next section) |
| `dimensions`, `voxel_size` | size in voxels and in micrometres, read from the Imaris file |
| `calibrationStatus` | `exact` if the three voxel sizes are known, otherwise `metadata-missing`: no scale is invented |
| `channels` | name, colour, window (`min`, `max`) and starting gamma of each channel |
| `volumeSources` | where the viewer finds the bricks |

::: note
For a time series (`live`), the file also contains `timeline` (number of images, interval, timestamps) and `intensityNormalization` (the normalisation window shared by the whole series, and one signal level per image to measure photobleaching; the viewer does not use it yet, see chapter 5).
:::

::: note
The pipeline writes **all** the channels of the original file; the viewer **displays only the first four** (limit of the RGBA graphics texture, chapter 11).
:::

### Stage and embryo, read from the file name

The `.ims` file name is **interpreted**. The stage is an `E…` token surrounded by hyphens, underscores or spaces; the embryo is an `Em<n>` token or, failing that, the number that directly follows a whole-number stage.

| name (excerpt) | stage | embryo | note |
|---|---|---|---|
| `…-E8.5-…` or `E8,5` | E8.5 | — | point or comma |
| `…-E8-5-…` | E8.5 | — | hyphen: confirmed by the lab |
| `…-E85-…` | E8.5 | — | compact form |
| `…-E105-…` | E10.5 | — | two-digit day if it starts with 1 |
| `…-E95-Em2-…` | E9.5 | Em2 | explicit embryo |
| `…-E8-1-DAPI-…` | E8 | Em1 | `-1` is **not** a fraction: after a hyphen, only .25, .5 and .75 count as one |
| `…-E95-1-…` | E9.5 | Em1 | the number after the stage |
| `Embryo-Pecam1` | unknown | — | no `E…` token |

::: warning
The token must be surrounded by hyphens, underscores or spaces: `-E85-Em1-` is read correctly, `E85Em1` is not. If the stage is wrong, correct it in the [Datasets]{.ui} tab: the pipeline will keep it on later runs (section 8.6).
:::

## 8.4 Cell tracking (time series)

For a time series only, the pipeline looks for a **tracking analysis** (cells, trajectories, divisions) and attaches it to the dataset. It looks in three places, from best to least good.

![The three possible sources, from the most complete file to the most fragile workbook.](img-en/ch08/sources-suivi.svg){width=100%}

::: why
**Why does Scene8 come before Excel?** An exported workbook can be out of date: on a real dataset it held 155 cells while the volume counted 172. The objects stored in the `.ims` are always up to date. Tracking is looked for automatically (option `--tracking auto`); if something fails, the volume is published anyway.
:::

Tracking brings three files or blocks:

- **`tracks.json`** (and its compressed copy `tracks.json.gz`): for each cell, its identifier, its region, its positions at each image in **µm** (stabilised and raw), its markers (red = division, black = fusion), its mother cell and its daughters;
- **`model.glb`**: the embryo's **3D surface** at each image, rebuilt from the cells (at least 4 per image);
- in `metadata.json`, the **`tracking`** block (cell count, regions, data origin) and the **`registration`** block (the stabilisation transform, below).

::: example
**The demonstration dataset over time.** 50 cells, 4 images, 3 regions (Posterior 18, Anterior 16, Lateral 16), 1 division and 0 fusions; `model.glb` weighs 412 KB and `tracks.json` 32.7 KB. Positions are numbered from 1 (as in Imaris) and aligned to the volume's images, numbered from 0 (offset −1).
:::

### Stabilising: cancelling the embryo's movements

Over hours, the embryo drifts and rotates a little in the field. The pipeline **puts it back in the same position** at each image, so that the visible movement is that of the cells and not that of the sample.

::: analogy
**A transparent sheet.** Draw the cells of image 1 on one sheet, and those of image 4 on another. To overlay them, you slide the sheet and rotate it, but you never stretch it: that is exactly a "rigid" motion.
:::

On the demonstration dataset, here is the same idea with the real cells (47 cells present in images 1 and 4, projected onto the x-y plane).

![Left, the cells of image 4 have drifted; centre, after a rotation of 7.03° and a translation, they overlay those of image 1; right, the raw trajectories drift, the stabilised ones stay in place.](img-en/ch08/kabsch.png){width=100%}

The algorithm used is called **Kabsch** (singular value decomposition). It chooses **reference cells** (those that do not divide, present in at least two images) and looks, image after image, for the rotation and translation that best overlay them; at least 3 in common are needed.

::: tech
**The maths.** Let P be the stabilised positions of image n−1 and Q the raw positions of image n (reference cells), centred on their centroids *c<sub>P</sub>* and *c<sub>Q</sub>*. We form H = Q<sub>c</sub><sup>T</sup> P<sub>c</sub>, decompose it as H = U S V<sup>T</sup>, then **R = V · diag(1, 1, sign(det(V U<sup>T</sup>))) · U<sup>T</sup>** (a true rotation, never a mirror) and **t = c<sub>P</sub> − R c<sub>Q</sub>**. The transform (R, t) is applied to **all** the cells of image n. The first image is the reference.
:::

### The `registration` block: applying the same thing to the images

The tracking is stabilised, but **the images are not**. Since the motion is rigid, the same transform lets the viewer overlay the trajectories on the images simply by shifting the reading coordinates, **without resampling** a single voxel. For each image, the file keeps a 4 × 4 matrix, the angle and the translation:

| image | rotation | translation (µm) | residual (µm) |
|---|---|---|---|
| 1 | 0° | (0; 0; 0) | 4 × 10⁻¹⁴ |
| 2 | 2.33° | (−5.65; 5.01; −0.37) | 6 × 10⁻¹⁴ |
| 3 | 4.66° | (−11.09; 10.60; −1.01) | 4 × 10⁻¹⁴ |
| 4 | 7.03° | (−16.14; 16.39; −1.79) | 8 × 10⁻¹⁴ |

::: remember
**Rigidity test.** The pipeline checks that the transform really is rigid: the largest residual must stay **≤ 0.05 µm**. Here it is 7.6 × 10⁻¹⁴ µm (zero, to within rounding error), so the stabilisation is applied to the images. If the test failed, a warning would say so and it would not be applied.
:::

## 8.5 Publishing "all or nothing"

A run sometimes lasts hours. Meanwhile, **the dataset already online keeps working**: everything is built in a private working folder, on the same disk location as `DATA_WEB`, and is installed only at the end.

::: analogy
**A shop window.** You prepare the new window in the back room; you take the old one out only once the new one is completely set up. If a problem occurs, customers still see the old one.
:::

![The five stages of publication; `metadata.json` is written last, it is the point of no return.](img-en/ch08/publication.svg){width=100%}

A **new** dataset arrives in a single folder rename. For an **existing** one, only the pipeline's own items are replaced (`bricks/`, `planes/`, `mips/`, the thumbnail, and `tracks.json`, `tracks.json.gz`, `model.glb` if a new tracking exists). Everything else in the folder, such as `download/` or `gallery/`, is never touched.

## 8.6 What the pipeline keeps when you reprocess a dataset

Did you correct a name, orient the embryo, add captions in the administration? A new pipeline run **does not overwrite it**: just before installation, it merges the fields entered by hand into the new `metadata.json`.

- **Identity**: `name`, `description`, `stage`, `stageNumeric`, `embryo`, `line`, `staining`, `reporter`, `tags`, `notes`, `created`;
- **Display**: `hidden`, `orientation`, `orientationAxes`, `upsideDown`, `defaultView`, `exposure`;
- **Links and images**: `gallery`, `linkedTrackingId`, `relatedIds`, and any field the new run does not produce (for example `tracking`).

Channel colours and settings are also kept, as long as the **number of channels** has not changed. Conversely, `formatVersion` is **never** carried over: it always reflects the structure actually written on disk.

::: warning
If a crash occurs during installation (power cut), the `.swap-in-progress` marker lets the next run **finish or cleanly undo** the change. Do not delete this file by hand.
:::

## 8.7 The `download/` folder

With the `--with-downloads` option, the pipeline prepares, **after** publication (so a failure here never undoes the dataset), a folder of files to download. Real content of the demonstration dataset:

```
download/
├── Embryo-E95-Em2-Pecam1-Sox2.ims               255.8 MB  the original
├── Embryo-E95-Em2-Pecam1-Sox2.tif               254.6 MB  ImageJ composite
├── Embryo-E95-Em2-Pecam1-Sox2_C1_DAPI_MIP.png     368 KB  one MIP per channel
├── …_C2_Pecam1_MIP.png  …_C3_Sox2_MIP.png
├── Embryo-E95-Em2-Pecam1-Sox2_web.zip            18.4 MB  the web dataset
└── README.txt                                              provenance
```

- **The original `.ims`** is a **hard link**: it appears in `download/` without taking any extra space; it is never modified.
- **The `.tif`** is an ImageJ/Fiji composite in the **native format** (8 or 16 bits, raw values), calibrated in µm, with each channel's colour and display range. It is taken from the Imaris resolution level closest to 2048 pixels.
- **The PNG MIPs** give a per-channel preview (normalised between the 1st and 99.9th percentiles).
- **The `_web.zip`** archives the served folder, without recompression (WebP and PNG already are).
- **The `README.txt`** recalls dimensions, voxel sizes, channels and how to cite the dataset.

For a time series, the `.tif` and the MIPs show only **one image** (the first); the `.ims` contains them all.

## 8.8 2D photographs, in half a page

Photographs (stereomicroscope, TIFF exported from a Leica file) have their **own tool**, `2d_importer.py`: one TIFF file gives one `2d/<name>/` folder.

| file | role | demonstration dataset |
|---|---|---|
| `image.webp` | the image at native size | 1920 × 1440 px, 191 KB |
| `preview.webp` | 640 px preview, displayed first | 10.6 KB |
| `thumbnail.webp` | 512 px thumbnail | 12.8 KB |
| `metadata.json` | stage, line, date, pixel size (2.0 µm here) | written last |

::: why
**Why "lossy" WebP by default?** It divides the size by about 40 compared with the original TIFF (8.3 MB against 191 KB here), at a quality of 90. But lossy WebP **subsamples colour** (chrominance is stored with half as many pixels). Now the viewer's X-gal stain isolation reads the **blue/red ratio** pixel by pixel: on sharp edges, this ratio is slightly disturbed. The `--lossless` option keeps every pixel exact, at the price of bigger files.
:::

The pixel size is read only if the TIFF declares a unit in microns; otherwise `pixelSizeUm` stays empty and the viewer shows **neither scale nor measurement**. The stage, zoom and dissection date are read from the file name, with the same stage reader as the volumes.

## 8.9 Launching all this: `RUN.bat`

The **Pipeline pack** (a folder to unzip on a Windows PC) contains everything. Double-click `RUN.bat`: it checks the pack's integrity (SHA-256 fingerprints), prepares Python and the libraries, then shows a menu.

![From your computer to the site: you drop the files, run, then copy or drag the result.](img-en/ch08/parcours-pipeline.svg){width=100%}

| choice | what the menu does |
|---|---|
| `[1]` | Preprocessing of Imaris volumes (.ims → `output\`, tracking included) |
| `[2]` | Imaris tracking analysis (Excel → `tracking\OUTPUT\`) |
| `[3]` | Import of 2D photographs (.tif → `output\2d\`) |
| `[4]` | Attach a tracking to an already processed dataset |
| `[5]` | Check the environment only |
| `[0]` | Quit |

The menu asks a few questions (folder of the `.ims` files, output folder, download archives or not) then launches `run_preprocess.py`. You can also call it yourself:

```
python run_preprocess.py --input input --output DATA_WEB --only "*E95*" --with-downloads
```

| option | effect |
|---|---|
| `--input` | folder of the `.ims` files (not recursive, one file at a time) |
| `--output` | the `DATA_WEB` root: the result goes to `3d/<name>/` or `live/<name>/` |
| `--only` | filter on file names (e.g. `"*E8*"`) |
| `--with-downloads` | also prepares the `download/` folder (slower) |
| `--tracking` | `auto` (default), `off`, or the path of a tracking file |

The type is decided automatically: more than one image in the file means `live`, otherwise `3d`. `Ctrl+C` asks for confirmation before stopping, and cleans up the temporary files.

### How the result reaches the server

- **Route A, by FTP**: copy the produced folder (`3d\<name>` or `live\<name>`) into the server's `DATA_WEB`. It appears in the catalogue at once; there is nothing to regenerate.
- **Route B, without FTP**: in the admin panel, open the [Import]{.ui} tab and drag the folder into the [Drop a folder here]{.ui} area. The transfer picks up where it stopped if you restart it; then click [Publish]{.ui}.

::: warning
A dataset published through the [Import]{.ui} tab is **hidden by default**: go to the [Datasets]{.ui} tab and turn its visibility on so that it appears in the public explorer (chapter 14).
:::

::: remember
- The thumbnail, the histograms and `metadata.json` describe the dataset; cell tracking is a **layer** of a time series, stabilised by a rigid motion.
- Publication is **all or nothing**, and what you corrected by hand is kept on reprocessing.
- `RUN.bat` → choice `[1]` → `output\` folder → FTP or the [Import]{.ui} tab.
:::
