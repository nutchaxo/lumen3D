# 7. Cutting into bricks

::: chapter-intro
- A volume of several gigabytes cannot be loaded in one go: it is cut into **bricks** (small cubes of 64 × 64 × 64 voxels) that the browser fetches one by one.
- Each brick becomes **a single WebP image** (lossless); the bricks are stored in **packs**, and found again thanks to an **index** of a few kilobytes.
- Two side structures, `planes/` and `mips/`, make slices and projections fast; the whole forms **data format 4**.
- **Format 5** (section 7.11) stores the same volume as a **matrix**: several resolutions × five compressions, plus three copies for fast cuts.
:::

In this chapter, the data images (mosaic, seam, packs…) all come from the **demonstration dataset**: the synthetic embryo `Embryo-E95-Em2-Pecam1-Sox2` (768 × 576 × 112 voxels, 3 channels), published by the real pipeline. It is not lab data.

## 7.1 Why cut a volume?

A typical lab embryo is 3789 × 3789 × 178 voxels over 4 channels: about **10.2 GB** once reduced to 8 bits. No browser can swallow that in one go, and at any moment you are looking at only a small part of it.

::: analogy
**An online map.** When you zoom into a town, the site does not download the planet: it loads only the **tiles** that are in your window, at the right level of detail. Bricks are the tiles of your embryo, with one more dimension.
:::

![Like the tiles of a map, only the visible, non-empty bricks are downloaded.](img-en/ch07/tuiles.svg){width=100%}

Three advantages, all visible on screen:

- **the start is fast**: the first bricks arrive in a fraction of a second;
- **memory is bounded**: the graphics card receives only what it can hold (chapter 10);
- **emptiness costs nothing**: a completely black brick is never written to disk.

## 7.2 A brick: 64 useful voxels and a border

A brick covers **64 voxels** in each direction. But it is stored with **one extra voxel on each side**: 64 + 1 + 1 = **66**. This border voxel is a copy of the neighbouring voxel, taken from the next brick over.

![The core of the brick (blue) is surrounded by a one-voxel border (orange) copied from the neighbouring bricks (violet).](img-en/ch07/bordure.svg){width=100%}

::: why
**What is the border for?** To draw a smooth image, the graphics card *interpolates*: the value at a point is a weighted blend of the surrounding voxels. At the edge of a brick, the neighbour on the other side is missing. Without a border, the graphics card would have to repeat the last voxel: you would see a regular grid at the brick limits. With the border, the neighbour is there, and the image is continuous.
:::

The next figure shows it on real data: the same intensity profile, straddling the limit between two bricks (at voxels 56 to 72).

![Without a border (red) the value plateaus then jumps; with a border (green) it varies without a break. Demonstration dataset, DAPI channel.](img-en/ch07/couture.png){width=85%}

::: example
**The cost of the border.** 66³ = 287,496 voxels against 64³ = 262,144: **9.7% more** stored, in exchange for seamless images at every quality level.
:::

Two rules for edge cases:

- **outside the volume**, the border repeats the last voxel ("clamp to edge");
- an **absent brick** (empty) is zero everywhere, border included: a border is never rebuilt from the neighbouring bricks.

## 7.3 From a cube to an image: the mosaic

The browser can decode a 2D image very fast, but has no 3D image format. The trick: the brick's 66 slices are **laid flat** into a single image, like a contact sheet of 66 photos.

![The 66 slices of a brick arranged in 9 columns × 8 rows; the last 6 cells stay empty.](img-en/ch07/mosaique-schema.svg){width=100%}

Each slice is 66 × 66 pixels; the grid is therefore **9 × 66 = 594** pixels wide and **8 × 66 = 528** tall, in 8-bit greyscale. The rule is simple:

::: example
**Where is slice z'?** Column = z' modulo 9, row = z' divided by 9 (integer division).

| slice z' | column | row | top-left corner (px) |
|---|---|---|---|
| 0 | 0 | 0 | (0; 0) |
| 1 | 1 | 0 | (66; 0) |
| 8 | 8 | 0 | (528; 0) |
| 9 | 0 | 1 | (0; 66) |
| 65 | 2 | 7 | (132; 462) |
:::

For a voxel (x', y', z') of the 66³ brick, its pixel in the image is: **column = (z' mod 9) × 66 + x'**, **row = (z' div 9) × 66 + y'**. Interior voxel number *i* sits at index *i* + 1, because of the border.

Here is a real brick from the demonstration dataset, **as it is stored**, next to its 3D cube.

![Brick (7, 5, 0) of the Sox2 channel: the decoded WebP image, with the numbers of a few slices, and the reconstructed cube.](img-en/ch07/mosaique.png){width=100%}

::: note
The first slices are black because the demonstration embryo occupies only the bottom of this brick. Cells 66 to 71 (the last 6, bottom right) are always empty: 72 places for 66 slices.
:::

### One image per channel

Each channel has its **own** bricks: brick (7, 5, 0) exists in three independent copies (DAPI, Pecam1, Sox2). The browser assembles them in colour at the last moment. A sparse channel, like Pecam1 here, gives a much smaller image.

![The three channels of the same brick: same geometry, different contents and weights.](img-en/ch07/canaux.png){width=92%}

::: tech
**Encoding.** Each mosaic is saved as *lossless* WebP (Pillow library, `lossless=True`, quality 75, method 4): the voxel read back is identical to the voxel written. A brick is kept only if its 64³ interior contains **at least one voxel ≥ 1**; otherwise it is "absent" (length 0 in the index). This rule is computed channel by channel.
:::

## 7.4 The brick grid of each level

Chapter 6 built the resolution pyramid. At each level, the volume is cut into a **grid** of bricks: the number of voxels divided by 64, rounded up.

| level | voxels (x, y, z) | brick grid | stored bricks (3 channels) |
|---|---|---|---|
| 0 | 768 × 576 × 112 | 12 × 9 × 2 | 269 |
| 1 | 384 × 288 × 56 | 6 × 5 × 1 | 53 |
| 2 | 192 × 144 × 28 | 3 × 3 × 1 | 24 |
| 3 | 96 × 72 × 14 | 2 × 2 × 1 | 12 |

The level-0 grid has 12 × 9 × 2 = 216 cells per channel, but only 100 (DAPI), 90 (Pecam1) and 79 (Sox2) contain signal: the other corners are empty.

![The brick grid of each level for one layer and one channel: in grey, the bricks that were never written.](img-en/ch07/niveaux.png){width=92%}

## 7.5 Packs: boxes of 64 bricks

Thousands of small files would be slow to serve. The bricks of the same level and the same channel are therefore grouped into **packs**: `bricks/l0/c1/p00000.bin` is the first pack of level 0, channel 1.

![A pack holds whole super-blocks of 4 × 4 × 4 bricks: a cut crosses few packs.](img-en/ch07/superblocs.svg){width=100%}

The filling rules:

- bricks are sorted into **super-blocks of 4 × 4 × 4** neighbouring bricks;
- a pack contains **whole super-blocks**, at most **64 bricks** or **16 MiB**;
- if a single super-block exceeds the limit, it is split in brick order.

::: analogy
**A house move.** You pack boxes room by room (the super-blocks), not at random into the lorries. When you look for "everything in the kitchen", you only need to open one lorry.
:::

In the demonstration dataset, level 0 of the Pecam1 channel fits in **two packs** (blue and orange below): the black lines are the super-block limits.

![Which bricks are in which pack, for the two layers of level 0 (Pecam1 channel).](img-en/ch07/paquets.png){width=85%}

## 7.6 The index and the manifest

To fetch a brick, the browser must know **which pack** it is in, **where it starts** and **how much it weighs**. These three numbers are in `bricks/index.bin`, a small binary file: **10 bytes per brick cell**.

![An index.bin file: a header, one row per level, then a 10-byte entry per brick cell.](img-en/ch07/index-bin.svg){width=100%}

Here are the real bytes of the demonstration dataset, decoded by hand: the header, then brick (7, 5, 0) of each channel.

| what we read | bytes (hexadecimal) | decoded value |
|---|---|---|
| start of the file | `4c 42 49 58` | "LBIX" (the signature) |
| levels · channels | `04 00` · `03 00` | 4 levels · 3 channels |
| level 0 | `0c 00 00 00  09 00 00 00  02 00 00 00  06 00 00 00` | grid 12 × 9 × 2, 6 packs |
| brick (7, 5, 0), DAPI | `01 00  ce d3 07 00  c0 94 02 00` | pack 1, start 512,974, length 169,152 |
| brick (7, 5, 0), Pecam1 | `01 00  88 1c 01 00  a2 30 00 00` | pack 1, start 72,840, length 12,450 |
| brick (7, 5, 0), Sox2 | `00 00  a0 e2 03 00  74 7a 01 00` | pack 0, start 254,624, length 96,884 |

::: tech
**Reading a number.** The bytes are "little-endian": `c0 94 02 00` is read backwards, `0x000294c0` = 169,152. A length of **0** means "absent brick" (the pack and the start are then 0 too). This file is 12 + 4 × 16 + 7,770 = **7,846 bytes**; on a large embryo, the former JSON manifest weighed 7.6 MB against 233 KB for the binary index.
:::

Next to the index, `bricks/manifest.json` describes the brick set in plain text. Real excerpt (abridged):

```json
{"schema":"iribhm-bricks-v3", "formatVersion":4, "channels":3,
 "brickSize":64, "apron":1,
 "brickPacking":{"mode":"grid","cols":9,"rows":8,"slice":66},
 "encoding":"webp-lossless",
 "levels":[{"level":0, "dimensions":{"x":768,"y":576,"z":112},
            "voxelSize":{"x":1.2,"y":1.2,"z":3.0},
            "gridSize":{"x":12,"y":9,"z":2}, "brickCount":269}, ...],
 "index":{"url":"index.bin", "bytes":7846, "sha256":"aea09808…"},
 "histograms":[...]}
```

The index's `sha256` signature is checked before use: a tampered index is refused. The `histograms` feed the contrast sliders (chapters 8 and 11).

## 7.7 The tree of a published dataset

Here is the real content of the demonstration dataset's folder (abridged; sizes are those on disk).

```
3d/Embryo-E95-Em2-Pecam1-Sox2/
├── metadata.json            1.8 KB   the dataset's facts
├── thumbnail.webp          33.6 KB   the thumbnail
├── bricks/                  9.3 MB   the bricks (format 4)
│   ├── manifest.json        3.7 KB
│   ├── index.bin            7.8 KB
│   ├── l0/ c0/ p00000.bin  1.4 MB    level 0, channel 0
│   │       │   p00001.bin  3.9 MB
│   │       c1/ …  c2/ …
│   └── l1/ l2/ l3/ …                 coarser levels
├── planes/                  8.6 MB   one file per Z plane
│   ├── manifest.json
│   └── z00000.bin … z00111.bin       (112 files)
├── mips/                  473 KB     one file per layer of 64 planes
│   ├── manifest.json
│   └── l00000.bin  l00001.bin
└── download/                         (see chapter 8)
```

::: note
The levels break down as follows: level 0 = 7.9 MB, level 1 = 1.1 MB, level 2 = 0.18 MB, level 3 = 0.03 MB. The coarse levels are tiny: that is why a first image appears almost instantly.
:::

## 7.8 `planes/`: an XY slice without reading 64 planes

Bricks are cubes. To display **one** XY slice at full resolution (for example for a Studio figure), you would have to read all the bricks of the layer, that is **64 planes of data** to use just one.

The `planes/` folder therefore holds level 0 **re-cut plane by plane**: one `zNNNNN.bin` file per Z plane (`z00000.bin`, `z00001.bin`…). Each plane is cut into **512 × 512** pixel tiles, saved as lossless PNG; a completely black tile takes no bytes at all.

![Bytes read for slice z = 30 of the three channels: 5,078 KB through the bricks against 94 KB through planes/ (54 times less).](img-en/ch07/planes_octets.png){width=70%}

::: example
**The demonstration dataset's figure.** The XY slice z = 30 of the three channels takes 5,078,326 bytes via the bricks of layer 0, against **94,053 bytes** via `planes/z00030.bin`. On a large lab embryo, a slice like this represented about 190 MB, i.e. 40 seconds at 5 MB/s.
:::

The result is **pixel for pixel identical** to the bricks, which remain the fallback. `planes/` is used only for XY slices; the 3D view and the XZ, YZ and oblique slices still use the bricks. Price: about 1.3 times the size of the native level on disk.

::: tech
A plane file starts with a `LPLN` header (16 bytes), followed by a table (8-byte offset + 4-byte length per tile and per channel), then greyscale PNGs, "None" filter, zlib level 6. The browser decodes them with its own PNG decoder (never by reading a canvas, which is not guaranteed to be exact).
:::

## 7.9 `mips/`: the maximum of a layer of 64 planes

A **maximum-intensity projection** (MIP) keeps, for each pixel, the brightest value met along Z. For a thick stack, computing it on demand would read every plane.

The `mips/` folder therefore keeps a ready-made copy **for each layer of 64 planes** (`l00000.bin` = planes 0 to 63, `l00001.bin` = planes 64 to 111…), at full XY resolution.

![A slice (left) and the MIP of the 64-plane layer (right). Demonstration dataset, DAPI channel.](img-en/ch07/mip_couche.png){width=85%}

For an arbitrary thickness, the Studio combines: the **MIPs of the layers entirely contained** in the thickness, and the **individual planes** at the two ends.

![A thickness of 220 planes: 3 layer MIPs + 28 end planes, i.e. 31 images instead of 220, with an identical result.](img-en/ch07/mips-schema.svg){width=100%}

## 7.10 Data formats 1 to 5

Over the versions, the file organisation has evolved. Each dataset carries a number, `formatVersion`, in its `metadata.json`. Format **5** is the current format (platform 1.65).

| format | what it adds | migration |
|---|---|---|
| 1 | bricks only (v2: 64³ without border, 8 × 8 mosaic, one JSON manifest) | — |
| 2 | `planes/`: fast XY slices | `m002-planes` |
| 3 | `mips/`: MIP per layer of 64 planes | `m003-layer-mips` |
| 4 | v3 bricks: 66³ border, 9 × 8 mosaic, packs in super-blocks, `index.bin` | `m004-bricks-v3` |
| 5 | the **matrix**: levels at 256 · 2^k^ that keep every slice, **five compressions** per level, three copies for fast cuts (section 7.11) | `m005-matrix` |

The pipeline (version 0.22.0) writes **format 4 by default**, and format 5 on request (`--format 5`). A dataset published in format 4, or older, is not lost: the platform knows how to upgrade it, up to 5.

### "Data updates"

Like a software update, the [Data updates]{.ui} tab of the admin panel (chapter 17) detects the datasets that are behind and converts them **in place**, one by one. The native level is kept voxel for voxel: nothing is recomputed from the original.

:::: cards
::: card
#### In this browser

Your browser does the work (WebP decoding and encoding) and sends the files to the server. On a PHP host, it is the **only** way to reach format 5.
:::
::: card
#### On the server

The server converts by itself, if its hosting can do it (a Python server for format 5).
:::
::: card
#### Pause and resume

The work is cut into small units noted in a journal: you can pause, close, resume, even changing who does the work.
:::
::::

## 7.11 Format 5: a resolution × compression matrix

::: tldr
- The same volume is stored **several times**: at several **resolutions** (the rows) and in **five compressions** (the columns). The visitor picks a cell.
- The reduced levels **keep every slice**; their long side is exactly 4096, 2048, 1024, 512 or 256.
- Three **re-cut copies** (XY, XZ / YZ, oblique) make the Studio's cuts fast, and everything that **measures** always reads the voxels **losslessly**.
:::

::: analogy
A **photo library** keeps each picture in several sizes and several qualities: the thumbnail to browse, the original to print. Format 5 does the same with a volume: you **look** at a light version, you **measure** and **export** from the original.
:::

The principle: **disk is spent; the network and the graphics card are not.** What is displayed may be compressed with loss, as long as the picture is not visibly altered; what measures reads the original.

### The rows: levels that keep every slice

![The levels of the same demonstration dataset in format 4 and in format 5 (real dimensions).](img-en/f5/niveaux.svg){width=95%}

- **Level 0** is the native volume, never resampled.
- The other levels have an XY long side of **exactly** 256, 512, 1024, 2048 or 4096 voxels: every one of these powers of two smaller than the native size is made. A 5192 × 5192 × 312 dataset therefore has six rows: native, 4096, 2048, 1024, 512, 256.
- **Z is never reduced**: every level keeps the 312 slices (here 112). In format 4, the coarse levels lost slices.
- Each voxel of a level is the **exact area average** of the native voxels it covers, in integers, rounded once. Each level is computed **directly from the native level**, never from another level.

::: example
To go from 768 to 512 voxels, one reduced voxel covers 1.5 native voxels. The pipeline cuts the line into whole pieces (768 × 512 units), counts how much of each reduced voxel every native voxel covers, and takes the weighted average: reduced voxel 0 takes all of native voxel 0 and half of voxel 1. No voxel is forgotten or counted twice.
:::

### The columns: five compressions

| column | on screen | what is guaranteed | size (relative to "lossless") |
|---|---|---|---|
| **Lossless** (`ll`) | [Lossless]{.ui} | every voxel exact (as in format 4) | 1 |
| **±2** (`b2`) | [±2]{.ui} | no voxel moves by more than **2** out of 255 | 0.62 to 0.82 |
| **±4** (`b4`) | [±4]{.ui} | no voxel moves by more than **4** | 0.50 to 0.69 |
| **Light** (`q80`) | [Light]{.ui} | lossy WebP, quality 80 (no bound; ≈ 36 dB) | 0.35 to 0.61 |
| **Very light** (`q50`) | [Very light]{.ui} | lossy WebP, quality 50 (≈ 31–33 dB) | 0.22 to 0.40 |

Sizes measured on 1,673 native bricks of three of the lab's embryos (specification, § 14.11).

![The same real brick in the five compressions: top, the middle slice; bottom, the difference from the original, multiplied by 16 to be visible.](img-en/f5/colonnes.png){width=100%}

::: example
**Read the figure.** On this dense brick (164 KB lossless), ±2 weighs 102 KB and changes no voxel by more than 2; "Very light" weighs 37 KB (4.4 times less) but a voxel can be off by 35. By eye, the five top slices are almost identical: that is the promise of the light columns. To measure, the platform **never** uses them (section "What measures reads the original").
:::

#### ±2 and ±4: "bins" of values

![The ±2 column: values are grouped in bins of 5; the viewer shows the bin's centre.](img-en/f5/quantif.svg){width=100%}

- The value **0 stays alone** in its bin: the background stays exactly black, empty bricks stay empty.
- The other values are grouped by 5 (±2) or by 9 (±4); **the bin number** is stored, losslessly. Fewer distinct values → the image compresses better.
- The manifest carries the "bin → value" table; the viewer applies it **together with** its display setting, at no extra cost.

#### Light and Very light: lossy WebP, but watched

1. **A dead zone.** A lossy compression "bleeds": a few voxels of the black background take small values. The encoder, which knows the original, chooses a threshold τ (0 to 12) below which everything goes back to 0, and writes it in **one byte** at the end of the brick.
2. **Never heavier than a faithful column.** On an almost empty brick, the lossy image can weigh more than the lossless one. The encoder then keeps the smallest of three: the lossy image, the ±4 image or the lossless image. The final byte says which (0 to 12 = τ; 254 = ±4; 255 = lossless).
3. **A mosaic on an 80-pixel pitch.** Lossy WebP works in blocks of 16 pixels. On a 66 pitch, a block would straddle two neighbouring slices and mix them. On an 80 pitch, each 66-pixel slice is centred with a 7-pixel margin: no block touches two slices.

![Why the lossy columns place the slices every 80 pixels.](img-en/f5/grille80.svg){width=100%}

::: example
**Measured on the DAPI channel of the demonstration dataset** (100 native bricks, Very light column): without the dead zone, 3.9 % of the black voxels become non-zero; with it, 1.8 %. And 12 bricks out of 100 are stored as ±4 rather than lossy WebP, because that was smaller.
:::

::: why
**Why not AVIF or JPEG XL?** AVIF gives the same size / quality trade-off as WebP within a few percent, encodes twice as slowly and has no encoder in browsers, which therefore could not do the conversion. JPEG XL is not decoded by Chrome or Firefox by default (October 2026). Measurements: specification § 14.3.
:::

### Three copies for fast cuts

A cut drawn from 64³ bricks downloads far more than it shows: an XY cut one voxel thick reads 64 slices. Format 5 adds, **at every level**, three re-cut copies, all **lossless**:

![The three cut copies, and what they save.](img-en/f5/coupes.svg){width=100%}

| cut | read from | what is read |
|---|---|---|
| XY | `planes/` (native) or `xy/` (reduced levels) | **one** plane |
| XZ or YZ | `xz/` or `yz/`: packs of 64 re-cut rows | one row: three small reads per channel |
| oblique | `cuts/`: small bricks of 32 × 32 × *bz* voxels, without border | only those the plane crosses |

*bz* is chosen so that the small brick is roughly cubic **in micrometres**: 32 × 32 × 16 on the demonstration dataset (1.2 × 1.2 × 3 µm voxel), 32 × 32 × 4 on an embryo at 0.344 × 0.344 × 3 µm.

::: example
**Measured on a 1946² × 72-voxel embryo** (platform 1.64): a native oblique cut downloaded **23 MB in 15 requests** instead of 60 MB in 30 through the bricks, and every picture is identical voxel for voxel.
:::

### What measures reads the original

Every measurement, every plugin that reports a number and every "native" export reads the **lossless column of the native level**, whatever cell is displayed (chapters 12 and 15). A light display setting therefore never skews a number.

### The tree of a format-5 dataset

![The `bricks/` folder of the demonstration dataset after conversion, with real sizes.](img-en/f5/arbre.svg){width=100%}

- Everything format 5 adds lives **inside** `bricks/`: one manifest (`iribhm-bricks-v5`) describes it, and one rename installs it.
- `bricks/index/ll.bin`, `b2.bin`…: one index per column (same structure as format 4's `index.bin`). The viewer reads the lossless index when the dataset opens, the others only when their column is chosen.
- The packs of the lossless column of level 0 **are** those of format 4: the migration links them (hard link) instead of re-encoding them.
- `planes/` and `mips/` do not change: they already hold the native level.

::: warning
**Disk use grows a lot**: on the demonstration dataset, 9 MB of bricks in format 4 become about 80 MB in format 5 (28 MB of which are XZ / YZ copies). That is intended: what costs is what each visitor downloads and what their graphics card keeps, and format 5 reduces that. Check the free space of the host before converting large datasets.
:::

::: remember
- A brick = 64³ useful voxels + 1 border voxel = **66³**, stored as **one lossless WebP image** of 594 × 528 pixels (9 × 8 slices).
- The bricks are in **packs** (4 × 4 × 4 super-blocks); `index.bin` gives the pack, start and length of each (10 bytes per brick).
- `planes/` speeds up XY slices, `mips/` projections.
- Current format = **5**: levels at 256 · 2^k^ that keep every slice, five compressions per level (lossless, ±2, ±4, light, very light), three re-cut copies for cuts; everything that measures reads the lossless column of the native level.
:::
