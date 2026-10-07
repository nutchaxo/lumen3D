# 5. Cleaning the image: removing the background noise

::: chapter-intro
- The pipeline processes **each channel separately** in five stages: measure the background, measure the white point, protect the signal, smooth the background, then convert from 16 to 8 bits.
- Everything is computed **from reference voxels** (the 8 corners, one voxel in 4): no value is chosen by hand, and nothing is "prettified" or invented.
- Result: a background of **exactly black (0)**, an intact signal, and 8-bit values that are **relative** to each channel. The original .ims remains the only quantitative source.
:::

This chapter follows the **exact order of the code** (`2-image_processor.py`). All the images come from the demonstration dataset (synthetic embryo), DAPI channel, slice z = 56; they are computed with the pipeline's own functions.

![The five stages of cleaning a channel.](img-en/ch05/chaine.svg){width=100%}

## 5.1 Why clean?

A microscope camera is never perfectly black: even with no sample, every voxel shows a small random number (the **camera noise**). In the demonstration dataset it hovers around 2,600 on a scale from 0 to 65,535.

In the browser, rendering **accumulates** light along each ray. A background of 2,600 repeated over 112 slices ends up as a grey fog that hides the embryo.

::: analogy
It is a **cinema with a screen that is never quite black**: the emergency lights illuminate the room. Cleaning sets the screen's "black" to the level of the room, so that only the film remains visible.
:::

## 5.2 Stage A: measuring the background (`bg_floor`)

Where can we find pure background, with no embryo? **In the corners** of the volume: the embryo is in the centre, and nothing touches the corners. The pipeline takes **8 cubes**, one per corner, with sides of **at most 32 voxels**.

![The 8 corner cubes (diagram). In the demonstration dataset the stack has only 112 slices: the side is min(32, X÷4, Y÷4, Z÷4) = 28 voxels, i.e. 8 × 28³ = 175,616 reference voxels.](img-en/ch05/coins.svg){width=90%}

Then: **`bg_floor` = 99th percentile of these voxels.** The percentile is the value below which 99% of the voxels lie. Here:

- most corner voxels lie between 1,500 and 4,000;
- 99% are **below 4,524**;
- that is `bg_floor`: the ceiling of the camera noise.

![Left: the 175,616 voxels of the 8 corners form a noise "bell"; the red line is their 99th percentile. Right: the whole volume (1 voxel in 4, logarithmic scale); the big peak on the left is the background, the long tail is the signal (demonstration dataset, DAPI channel).](img-en/ch05/histogramme.png){width=100%}

::: example
By construction, 1% of the corner voxels exceed `bg_floor` (measured: 1.0005%). The brightest corner voxel is 6,238. A voxel of value 3,000 is therefore probably noise; a voxel of value 20,000 is almost certainly signal.
:::

::: why
**Why the corners?** Because they are voxels with no embryo, so they are safe. The code tried other rules (5th then 20th percentile, 10th percentile of the corners) before settling on the 99th percentile of the 8 corners: it covers almost all the noise without touching the signal.
:::

::: warning
If a corner touches the sample (tight crop, tile mosaic), `bg_floor` can be too high and cut weak signal. The pipeline **warns** about it in its log ("corner noise well above the volume median") but changes nothing: it does not correct silently.
:::

## 5.3 Stage A (continued): measuring the white point (`sig_max`)

For the top of the scale, we look at the **whole volume**, but reading **only one voxel in 4** in each direction (indices 0, 4, 8…). This saves 63 voxels out of 64 without changing the statistic.

![Sampling the white point: 1/64 of the voxels is enough.](img-en/ch05/echantillon.svg){width=95%}

**`sig_max` = 99.9th percentile of these voxels**: we **saturate** (set to white) the brightest 0.1%. In the demonstration dataset: **sig_max = 33,663**.

::: tldr
- `bg_floor` = 4,524: everything below it is background.
- `sig_max` = 33,663: everything above it becomes white.
- The useful window is therefore **[4,524; 33,663]**, not [0; 65,535].
:::

## 5.4 The mask: protecting the real signal

Before smoothing the background, we must **find the signal** so as not to smooth it. Three operations, applied in 3D to all the voxels.

**1. Threshold.** A voxel is "signal" if it is **greater than 1.1 × `bg_floor`** (10% above the floor value). Here: 1.1 × 4,523.85 = **4,976**.

**2. Opening** (1 iteration): an erosion followed by a dilation. It removes small isolated objects (hot pixels, grains of noise).

**3. Dilation × 3**: the mask is widened by 3 voxels to keep the natural fall-off of fluorescence around cells.

![The three steps of the mask on slice z = 56. Bottom row: zoom. In red, the voxels removed by the opening (4,748 in this slice); in blue, those added by the dilation.](img-en/ch05/masque.png){width=100%}

::: keynums
**11.77%**
voxels > threshold

**11.32%**
after opening

**13.92%**
final mask
:::

### What is a "neighbour"?

Erosion and dilation look at a voxel's neighbours. The pipeline uses the **6-neighbour cross**: the two neighbours along X, Y and Z, which share a face. Diagonals do not count.

![The structuring element: the 3D cross with 6 neighbours (scipy's default setting, not changed by the pipeline).](img-en/ch05/croix.svg){width=90%}

### Opening in miniature

![A 7 × 7 mini-grid. The 4 × 4 pixel block survives (its corners are slightly rounded), the isolated hot pixel disappears. Computed with scipy.](img-en/ch05/ouverture.svg){width=100%}

::: example
On the grid: 17 pixels are lit at the start (16 of signal + 1 hot); after the opening **12** remain: the hot pixel and the 4 corners of the block are gone. The real signal is protected by the dilation that follows (×3).
:::

::: why
The opening is done **before** the dilation. In the opposite order, a hot pixel would be "protected" and even **enlarged** by the dilation. Here it stays outside the mask, so it will be crushed by the median.
:::

## 5.5 The median, outside the mask only

For each voxel, the pipeline computes the **median of the 3 × 3 × 3 cube** around it (27 values). Then:

- **inside the mask** → we keep the **original** value, untouched;
- **outside the mask** → we replace it with the **median**.

Result: the signal stays sharp, the background is smoothed.

![Median versus mean over 9 values (2D example): a hot pixel at 52,000 is crushed by the median (2,990), but pushes the mean up to 8,404.](img-en/ch05/mediane.svg){width=100%}

::: analogy
The **median** is the "middle" salary of a street: a billionaire moving in does not change it. The **mean** explodes. That is why a median filter crushes a hot pixel without blurring the outlines.
:::

## 5.6 The window: from 16 to 8 bits

The last operation, voxel by voxel. The exact formula from the code:

::: example
**u8 = truncate( 255 × (clip(v, bg, sig) − bg) ÷ (sig − bg) )**

*v* is the voxel value (original inside the mask, median outside); *bg* = `bg_floor`; *sig* = `sig_max`; *clip* brings *v* back between *bg* and *sig*. "Truncate" means we drop the decimals (no rounding).
:::

![The window: flat at 0 below `bg_floor`, flat at 255 above `sig_max`, linear in between. The orange dots are the micro-examples below.](img-en/ch05/fenetre.png){width=85%}

::: example
With bg = 4,523.85 and sig = 33,662.57 (so sig − bg = 29,138.72):

- v = 4,000 → below the floor → **0**;
- v = 10,000 → 255 × 5,476.15 ÷ 29,138.72 = 47.9 → **47**;
- v = 20,000 → 255 × 15,476.15 ÷ 29,138.72 = 135.4 → **135**;
- v = 40,000 → above the white point → **255**.
:::

::: note
The conversion is **linear**, with no gamma curve. Every voxel ≤ `bg_floor` becomes **exactly 0**: the background is a perfect black, which makes it possible to store no empty bricks at all (chapter 6). In the demonstration dataset, **88.2%** of the DAPI channel's voxels are 0 after cleaning.
:::

## 5.7 Before and after

![The same slice before (raw voxels displayed from 0 to `sig_max`) and after cleaning. Bottom: zoom on the edge of the embryo. The grey grain of the background has gone; the nuclei are intact (demonstration dataset).](img-en/ch05/avant_apres.png){width=100%}

Look at the zoom: to the left of the edge, the grainy grey background has become pure black; to the right, the bright nuclei have the same shape and the same contrast.

## 5.8 What was tried, then abandoned

The pipeline once had more sophisticated methods, removed in version 0.12.0:

| Method | Why abandoned |
|---|---|
| Otsu threshold | Mask subtraction: created artificial **large coloured blobs** |
| Noise2Void (neural network) | Same artefactual result; the embryo lost its natural texture |

::: why
Current choice: the pipeline **removes only the camera's global background** and keeps the microscope's native intensities. No neural network, no flat-field correction. A test on a reference dataset recovered the 97 SHA-256 fingerprints of the production packs, byte for byte.
:::

## 5.9 Time series: a single window

For a movie (several images), should there be one window per image? **No: a single one for the whole series**, for each channel. Otherwise the image "flickers".

![Diagram (illustrative figures). A fluorophore fades (photobleaching). If each image is stretched over its own window, the screen stays constant while the signal collapses: that is wrong. With a single window, the screen dims like the real signal.](img-en/ch05/serie_temporelle.png){width=85%}

How is the single window measured?

- up to **8 images** are sampled (evenly spaced, always including the first and the last);
- `bg_floor` = 99th percentile of the corners of all these images together;
- `sig_max` = 99.9th percentile of **only the voxels above `bg_floor`**, if there are at least **1,000** of them.

::: why
In a sparse series, the signal covers only ~0.4% of the voxels: the 99.9th percentile of the whole volume would fall **inside the background** and saturate 15% of the real signal. By ranking only the voxels above the background, the saturated share falls to about 0.06% (measurements from the version 0.15.0 log).
:::

Photobleaching is **measured, never erased**: the pipeline records one signal level per image and per channel (99.9th percentile of the raw data) in `metadata.json`. The viewer can offer an optional, reversible compensation.

## 5.10 Large volumes: in tiles, without changing the result

A channel of 3789 × 3789 × 178 voxels is 2.56 billion voxels, i.e. 10.2 GB as 32-bit floats: it does not fit in memory. The pipeline therefore reads it **in tiles** of at most **24 million voxels** (margin included).

![Tiling. The 5-voxel margin gives the edge computations (opening, dilations) the neighbours they lack; only the core is written.](img-en/ch05/tuiles.svg){width=100%}

Why 5 voxels? The erosion (1) + the dilation of the opening (1) + the 3 dilations (3) spread a voxel's influence over 5 voxels of distance. The median needs 1 (covered by the same margin).

::: example
**Verified on the demonstration dataset** (3 channels): cut into 4 tiles (the default setting), then into **256 tiles** (0.5 M voxels), the 8-bit volume is **byte-for-byte identical** to the single-block computation, and to the dataset published by the pipeline (slices z = 0, 30, 56 and 100).
:::

## 5.11 What this means for you

::: warning
8-bit values are **relative**, not absolute. Each channel has its own window [`bg_floor`; `sig_max`]; 128 on DAPI and 128 on Pecam1 do not represent the same quantity of light. Do not compare intensities between channels or between datasets.
:::

- In a **time series**, values are comparable between images **of the same channel** (single window).
- The **original .ims file** is never modified; it is the source for any intensity measurement. It can be downloaded from the `download/` folder if the dataset was published with its original files.
- A **very weak** signal (below 1.1 × `bg_floor`) or one reduced to an isolated voxel can be erased: that is the price of a perfectly black background. Inside the mask, however, the original values are kept.

::: remember
1. `bg_floor` = 99th percentile of 8 corner cubes; `sig_max` = 99.9th percentile of one voxel in 4.
2. Mask = threshold 1.1 × `bg_floor` → opening → dilation × 3.
3. 3 × 3 × 3 median **outside the mask**; the signal stays intact.
4. 8 bits = linear window [`bg_floor`; `sig_max`] → [0; 255], truncated; background = exact 0.
5. One window for a whole movie; tiling does not change the result.
:::
