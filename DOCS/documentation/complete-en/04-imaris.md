# 4. From the microscope to the Imaris file

::: chapter-intro
- A 3D image is a **stack of slices**; every 3D cell is called a **voxel**, and its real size in micrometres matters.
- An Imaris **.ims** file is a "file system inside a file" (HDF5): the pipeline reads only the image size, the calibration, the channel names, the clock and the full-resolution voxels.
- **Step 1** of the pipeline writes a small `meta.json` file: it computes nothing but the voxel size, and never invents a calibration that is missing.
:::

## 4.1 From pixel to voxel

A digital photo is a grid of **pixels**: each little square carries a grey value (or a colour). A confocal microscope does not take one photo, but a series of photos taken at different depths.

One point of that series is called a **voxel**: a pixel that also has a thickness. It is a small 3D box, and it is the basic unit of this whole document.

![From pixel to voxel. Here the voxel measures 1.2 × 1.2 µm in the plane and 3.0 µm in depth: this is the calibration of the demonstration dataset (synthetic embryo).](img-en/ch04/voxel.svg){width=95%}

::: analogy
Think of a **box of Lego**: a flat plate of studs is a 2D image (pixels). Stack 112 plates and every stud becomes a 3D brick: a voxel. If your plates are thicker than the width of a stud, your bricks are "stretched" in height.
:::

::: note
An **anisotropic** voxel (thicker in Z than in X and Y) is the rule in confocal imaging: changing depth costs scanning time. The pipeline allows for it at every step (see chapter 6 for the pyramid, chapter 9 for display).
:::

## 4.2 A stack of slices, several channels

The microscope scans the sample slice by slice, along the **Z** axis. The demonstration dataset has **112 slices** of 768 × 576 voxels, spaced 3.0 µm apart: the embryo is therefore 112 × 3.0 = **336 µm** thick.

![A confocal stack: 112 slices stacked along Z (diagram, figures from the demonstration dataset).](img-en/ch04/pile.svg){width=90%}

A **channel** is a complete stack recorded for a single fluorophore, that is to say a single emission colour. The demonstration dataset has **three channels**: DAPI (the nuclei), Pecam1 (the vessels) and Sox2 (the neural tissue).

![The same slice (z = 56) seen in each of the three channels, then overlaid. The images come from the demonstration dataset (synthetic embryo); each channel is stretched between 0 and its 99.9th percentile for display.](img-en/ch04/canaux.png){width=100%}

::: tldr
- 1 channel = 1 stack of slices = 1 fluorophore.
- The channels are **not mixed** in the file: each has its own 3D array.
- Colour mixing happens later, in the browser (chapter 11).
:::

## 4.3 How many grey levels? 8 or 16 bits

Every voxel carries an **integer**: the measured light intensity. The number of bits says how many values are possible.

| Depth | Possible values | Range |
|---|---|---|
| 8 bits | 2⁸ = **256** | 0 to 255 |
| 16 bits | 2¹⁶ = **65,536** | 0 to 65,535 |

The lab's Imaris files are 8-bit or 16-bit depending on the acquisition; the pipeline reads both. The demonstration dataset is **16-bit** (type `uint16`).

::: example
Two fluorescent spots measure **1,000** and **1,200** on a 16-bit scale: a gap of 200 levels, easily measurable. If we simply divided by 256 to get to 8 bits, they would become **3** and **4**: a single step apart. That is why the pipeline does not divide blindly: it first sets a suitable "window" (chapter 5).
:::

![A real profile of 60 voxels (Pecam1 channel, demonstration dataset): the blue curve keeps all its nuances in 16 bits; in orange, the same values stored in steps of 256. Here the signal is strong and the steps stay small; on a weak signal, they flatten the details.](img-en/ch04/profondeur.png){width=80%}

## 4.4 An .ims is a "hard disk inside a file"

An **.ims** file is a container in **HDF5** format. Picture a folder of folders: it holds groups (the folders), attributes (small text labels) and arrays (the voxels).

![The paths the pipeline actually reads in the .ims of the demonstration dataset. In violet: the metadata (step 1). In green: the voxels (step 2).](img-en/ch04/arbre.svg){width=100%}

::: example
In the demonstration file, `DataSetInfo/Image` contains the attributes `X = 768`, `Y = 576`, `Z = 112`, `ExtMin0 = 0.000`, `ExtMax0 = 921.600` and `Unit = um`. Everything is written as **text**: the pipeline converts it to numbers.
:::

::: tech
HDF5 attributes are sometimes stored as arrays of ASCII bytes; `attr_str` (step 1) glues them back into text. The voxel arrays are compressed (gzip) in blocks of 16 × 64 × 64 voxels: the pipeline always reads sub-boxes, never more than the declared size.
:::

## 4.5 Imaris's pyramid: ignored

Imaris often stores, next to level 0 (full resolution), reduced versions: `ResolutionLevel 1`, `2`… This is its own pyramid, designed for its own display window. The demonstration dataset has none: only level 0 exists. A real lab file has several.

The pipeline **uses only level 0**, and never the others, for the volume.

::: why
Imaris's pyramid is computed on the **raw** data, with its own block sizes: it matches neither Lumen3D's brick layout nor the cleaning of chapter 5. It is better to clean level 0 and then build **your own pyramid** from the result (chapter 6): every level is then consistent with the others.
:::

## 4.6 Step 1: reading the metadata

Step 1 (`1-ims_metadata.py`) opens the .ims, reads a few attributes and writes `meta.json`. It touches no voxel.

| `meta.json` field | What it is | Value (demo) |
|---|---|---|
| `width`, `height`, `depth` | Number of voxels in X, Y, Z | 768, 576, 112 |
| `n_channels` | Number of channels | 3 |
| `n_timepoints` | Number of images over time | 1 |
| `voxel_size` | Size of one voxel in µm (x, y, z) | 1.2; 1.2; 3.0 |
| `extent` | Image box in µm (min, max) | 0 → 921.6 / 691.2 / 336.0 |
| `timestamps` | Time of each image | 2026-03-11 10:00:00 |
| `time_interval_minutes` | Median interval between images | empty (single image) |
| `channel_names` | Channel names | DAPI, Pecam1, Sox2 |

::: note
The number of images determines the dataset **type**: a single image gives a `3d` dataset; several give a `live` one (time series). Step 1 makes that call.
:::

Channel names are cleaned: everything after a null character is removed, and an empty name or one like "ch1" becomes "Channel 1", "Channel 2"… Colours do not come from the .ims: they are assigned later, from a fixed palette (chapter 8).

## 4.7 Calibration: the voxel size

The file does not give the voxel size directly. It gives the **box** (ExtMin / ExtMax) and the number of voxels. The pipeline divides.

![Voxel size = (ExtMax − ExtMin) ÷ N, axis by axis. Values from the demonstration file (synthetic embryo).](img-en/ch04/calibration.svg){width=100%}

::: example
On X: (921.6 − 0) ÷ 768 = **1.2 µm**. On Z: (336.0 − 0) ÷ 112 = **3.0 µm**. We divide by N (not by N − 1), a deliberate choice in the code.
:::

If the file's unit is not µm, it is converted first:

| Unit in the file | Factor to µm |
|---|---|
| `um`, `µm`, `micron`… | × 1 |
| `nm` | × 0.001 |
| `mm` | × 1,000 |
| `m` | × 1,000,000 |

::: warning
**The calibration is never invented.** If `ExtMin/ExtMax` are missing or the unit is unknown, the three voxel sizes are 0 and `extent` is empty; the platform records `calibrationStatus = metadata-missing`: no scale bar will be made up.
:::

## 4.8 The clock of a time series

For a movie (several images), Imaris notes the time of each image: `TimePoint1`, `TimePoint2`… (numbering starts at 1 here, whereas the voxel arrays start at 0).

Step 1 converts these texts into dates, then computes the **median interval** between successive images. The **median** (middle value) resists a one-off delay: an image that is a few minutes late does not distort the announced interval.

![Example on the time-series demonstration dataset (4 images, one every 30 minutes). The median interval, 30 minutes, becomes `time_interval_minutes`.](img-en/ch04/horloge.svg){width=100%}

::: remember
- The voxel = one 3D cell; its size comes from **(ExtMax − ExtMin) ÷ N**.
- Only level 0 of the .ims is read; Imaris's pyramid is ignored.
- Channel names, the clock and the calibration are read; **nothing is guessed**.
:::
