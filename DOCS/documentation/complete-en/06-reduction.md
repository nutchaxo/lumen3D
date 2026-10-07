# 6. Shrinking the size without losing anything important

::: chapter-intro
- An embryo of several gigabytes cannot travel over the Internet as it is: the pipeline **shrinks** it in four moves — 16 → 8 bits, a pyramid of resolutions, removal of empty bricks, **lossless** compression.
- None of these moves changes an intensity at the finest level: what you see at full resolution is **exactly** the result of the cleaning in chapter 5.
- On the demonstration dataset: **297 MB of raw voxels → 9.3 MB of bricks**, about 32 times less.
:::

All the "demo" figures in this chapter are **measured** on the synthetic embryo `Embryo-E95-Em2-Pecam1-Sox2` (768 × 576 × 112 voxels, 3 channels), published by the real pipeline (format 4).

## 6.1 The size budget in numbers

Let us first take a **big** embryo from the lab: 3789 × 3789 × 178 voxels, 4 channels. That makes 10.2 billion voxels.

| Step | Calculation | Size |
|---|---|---|
| Raw voxels, 16-bit | 10.22 G voxels × 2 bytes | **20.4 GB** |
| Converted to 8-bit | 10.22 G voxels × 1 byte | **10.2 GB** |
| + resolution pyramid | × 1.286 for this layout | **13.1 GB** |
| Real .ims file of this kind | compressed by Imaris | 14.4 GB |

The last two steps (empty bricks removed, compression) depend on the image content. Let us measure them on the demonstration dataset, step by step:

![Size budget of the demonstration dataset. The axis is logarithmic: each tick is ten times the previous one.](img-en/ch06/budget.png){width=100%}

::: keynums
**297 MB**
raw 16-bit

**149 MB**
as 8-bit

**103 MB**
non-empty bricks

**9.3 MB**
on disk
:::

::: note
The pyramid **adds** bytes (+14% here): it is the price of fast display. The gain comes from the next two steps: not storing emptiness, and compressing.
:::

## 6.2 From 16 bits to 8 bits: dividing by two

This is the window of chapter 5: a 2-byte voxel becomes a 1-byte voxel. We lose the fineness of the 65,536 levels, but the browser only shows 256: the screen cannot show more.

::: warning
This is **the only step that loses information** (the nuances above 256 levels), and it takes place in chapter 5, not here. Everything that follows in this chapter is **lossless**.
:::

## 6.3 The resolution pyramid

When you look at the whole embryo, you do not need all the voxels: the screen has only a few million pixels. The pipeline therefore prepares **several versions** of the image, smaller and smaller: the **levels**.

![The four levels of the demonstration dataset, drawn to scale (maximum-intensity projection of the DAPI channel). Same shape, fewer and fewer voxels.](img-en/ch06/pyramide.png){width=100%}

::: analogy
It is a **road map**: the map of the country for travelling, the map of the town for finding your way, the street plan for finding the door. We load only the map that is useful.
:::

### The format 4 rule

- **Level 0**: the cleaned image, **as it is** (never resampled).
- **Next level**: X and Y are **divided by 2** (rounded up) and their voxel doubles.
- **Z is divided by 2 only if** the voxel depth stays less than or equal to **1.5 times** the new XY voxel. Otherwise Z is kept.
- We stop when the longest XY side is **less than or equal to 128** voxels.

::: why
A voxel that is too "flat" or too "elongated" distorts the image. Dividing Z only when it is still comparable to XY gradually brings the voxel back towards a **cube** (this is the convention of modern biomedical image formats, such as OME-Zarr).
:::

### Computing one voxel of the next level

Each voxel of the next level is the **mean** of a 2 × 2 (× 2) block of voxels of the previous level. The computation is done in **integers**, **rounded to the nearest value, halves going up**: (sum + n ÷ 2) ÷ n, integer part, n being the number of voxels in the block.

::: example
Real block from the demonstration dataset: 162, 115, 92, 72, 59, 52, 40, 29. Sum = **621**. We add 4 (half of 8), then divide by 8: (621 + 4) ÷ 8 = 78.1 → **78**. Without adding 4 we would have got 77: the bias would have darkened every level.
:::

![Computing one voxel of the next level, on a real block from the demonstration dataset.](img-en/ch06/bloc.svg){width=100%}

At the edge of the volume, a block may be only 1 voxel wide: we then average **only the voxels that exist**.

### The demonstration dataset's scale

Starting voxel: 1.2 × 1.2 × 3.0 µm. For each level, the Z rule is tested with the **new** XY voxel.

| Level | Voxels (X × Y × Z) | Voxel (µm) | Z divided? |
|---|---|---|---|
| 0 | 768 × 576 × 112 | 1.2 × 1.2 × 3.0 | (base) |
| 1 | 384 × 288 × 56 | 2.4 × 2.4 × 6.0 | yes: 3.0 ≤ 1.5 × 2.4 = 3.6 |
| 2 | 192 × 144 × 28 | 4.8 × 4.8 × 12.0 | yes: 6.0 ≤ 1.5 × 4.8 = 7.2 |
| 3 | 96 × 72 × 14 | 9.6 × 9.6 × 24.0 | yes: 12.0 ≤ 1.5 × 9.6 = 14.4 |

We stop at level 3: 96 ≤ 128.

::: tech
**When Z is not divided.** For a 3789 × 3789 × 178 stack with a voxel of (0.33; 0.33; 1.876 µm) (*illustrative* voxel sizes), level 1 keeps Z: 1.876 > 1.5 × 0.66 = 0.99. Level 2 divides it: 1.876 ≤ 1.5 × 1.32 = 1.98. The result is 3789 × 3789 × 178 → 1895 × 1895 × 178 → 948 × 948 × 89 → 474 × 474 × 45 → 237 × 237 × 23 → 119 × 119 × 12 (6 levels).
:::

::: note
I rebuilt this pyramid with the pipeline's functions from the result of chapter 5, then compared it with the published bricks: **358 bricks out of 358 identical**, voxel for voxel.
:::

## 6.4 Compressing without losing anything

### Why "lossless"?

**Lossy** compression (JPEG) slightly changes the values to save space: acceptable for a holiday photo, not for a **measurement**. **Lossless** compression lets you recover every voxel identically.

### How it works, in plain words

The idea: a voxel looks like its neighbour. Rather than storing every value, we store **the difference from the neighbour**, which is small and compresses well.

![A real row of 14 voxels from the Sox2 channel (demonstration dataset). The differences are small; adding them up in order gives back the original values.](img-en/ch06/difference.svg){width=100%}

::: tech
Real compressors are subtler: they predict a voxel from several neighbours (left, above…), then code the gaps economically, the most frequent first. The principle remains this one, and it is exactly reversible.
:::

### Bricks are lossless WebP images

A 3D brick is not a 2D image. The pipeline therefore lays its 66 slices side by side in a **594 × 528 pixel mosaic** (9 columns × 8 rows; chapter 7), and saves the mosaic as **lossless WebP**.

### The measurement: four ways of saving the same brick

I took the **269 non-empty level-0 bricks** (3 channels) of the demonstration dataset and saved each 594 × 528 pixel mosaic in four ways.

![Average size of a brick. Raw: 313.6 KB. PNG (best compression): 31.3 KB. Lossless WebP (pipeline setting): 29.4 KB. JPEG quality 90: 23.8 KB, but with an error of up to 22 grey levels.](img-en/ch06/compression.png){width=90%}

| Format | Average size | Exact? |
|---|---|---|
| Raw (uncompressed) | 313.6 KB | yes |
| PNG, level 9 optimised | 31.3 KB | yes |
| **Lossless WebP** (pipeline's choice) | **29.4 KB** | yes |
| JPEG, quality 90 | 23.8 KB | **no** |

::: warning
**JPEG is the smallest, but it is wrong.** On these bricks: a maximum error of 22 levels (out of 255), **11.7%** of voxels modified, and **1,644,202 voxels that were exactly 0 became non-zero** (2.2% of the background). Yet "exact 0" is what lets us recognise an empty brick (6.5): JPEG would destroy it.
:::

![Zoom on a brick slice (Pecam1 channel): after JPEG, faint grey halos appear around fine structures, where the original is perfectly black. The difference is amplified 8 times on the right.](img-en/ch06/jpeg_artefacts.png){width=95%}

::: why
**Why WebP rather than PNG?** On these bricks, lossless WebP is only **6% smaller** than the best PNG (29.4 versus 31.3 KB). The code gives another main reason: the browser **decodes WebP natively** and fast (`createImageBitmap`), whereas no 3D image format exists. The 2D slices of `planes/`, on the other hand, are PNG: the viewer reads them with a small home-made PNG decoder, never through the browser's canvas, whose readback is not guaranteed to be exact.
:::

::: note
The pipeline's bytes are reproducible: re-encoding the mosaics with the same settings (Pillow, lossless WebP, method 4), I got back **exactly the same bytes** as in the published files. Only the version of the WebP library matters: that is why Pillow is pinned.
:::

## 6.5 Not storing emptiness

A mouse embryo does not fill its frame. Many bricks contain only black: why store them?

**The rule (format 4):** a brick is stored **if and only if** its 64 × 64 × 64 voxel interior contains **at least one voxel ≥ 1**. No tolerance: a single faint voxel is enough to keep it.

![Level 0, Pecam1 channel, two layers of bricks. Green: stored brick. Red: empty brick, not stored. The bricks are drawn over a maximum-intensity projection of the layer.](img-en/ch06/briques_vides.png){width=100%}

The exact count, read from `index.bin` of the demonstration dataset (3 channels):

| Level | Possible bricks | Stored bricks |
|---|---|---|
| 0 | 648 (216 per channel) | **269** (DAPI 100, Pecam1 90, Sox2 79) |
| 1 | 90 | 53 |
| 2 | 27 | 24 |
| 3 | 12 | 12 |
| **Total** | **777** | **358** (46%) |

::: example
The Pecam1 channel has only **0.75%** non-zero voxels, yet **90 bricks out of 216** at level 0 are stored: a few fine vessels cross many bricks. A stored brick is not full; it contains at least one voxel.
:::

::: note
An **absent** brick is zero everywhere, including on its 1-voxel border. The viewer does not download it: empty space costs neither bytes nor transfer time (chapter 10).
:::

## 6.6 Final size: from the .ims to the published folder

![From the original file to the published folder, for the demonstration dataset. Measurements in bytes on disk (sum of the files).](img-en/ch06/taille_finale.png){width=85%}

| Content | Size |
|---|---|
| Original `.ims` file (compressed by Imaris) | 255.8 MB |
| `bricks/` (3D display) | 9.28 MB |
| `planes/` (native slices, PNG) | 8.64 MB |
| `mips/` (per-layer projections) | 0.47 MB |
| `thumbnail.webp` + `metadata.json` | 0.04 MB |
| **Published folder (excluding `download/`)** | **18.4 MB** |

::: keynums
**14×**
smaller than the .ims

**28×**
for the 3D view alone

**46%**
bricks stored
:::

::: warning
The `download/` folder (original file, TIFF, projections…) is not counted: it is not used for display. It weighs 506 MB here, because it contains the .ims.
:::

::: remember
- 16 → 8 bits is the **only** loss, decided in chapter 5; everything else is exact.
- The pyramid: X, Y ÷ 2 at each level, Z ÷ 2 only while its voxel ≤ 1.5 × the XY voxel; integer mean rounded up; stop at 128 voxels.
- **Lossless WebP** compression: JPEG is smaller but damages the values and the "exact 0".
- A brick is stored only if its interior contains a voxel ≥ 1: 358 bricks stored out of 777 possible.
:::
