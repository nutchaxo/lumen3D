# 5. Cleaning the image: removing the background noise

::: chapter-intro
- The pipeline processes **each channel separately** in five stages: measure the background, measure the white point, protect the signal, smooth the background, then convert from 16 to 8 bits.
- Everything is computed **from reference voxels** (the 8 corners, one voxel in 4): no value is chosen by hand, and nothing is "prettified" or invented.
- Result: a background of **exactly black (0)**, an intact signal, and 8-bit values that are **relative** to each channel. The original .ims remains the only quantitative source.
:::

After an overview and a complete example (§ 5.2 and 5.3), this chapter follows the **exact order of the code** (`2-image_processor.py`), stages A to E. All the images come from the demonstration dataset (synthetic embryo), DAPI channel, slice z = 56; they are computed with the pipeline's own functions.

![The five stages of cleaning a channel.](img-en/ch05/chaine.svg){width=100%}

## 5.1 Why clean?

A microscope camera is never perfectly black: even with no sample, every voxel shows a small random number (the **camera noise**). In the demonstration dataset it hovers around 2,600 on a scale from 0 to 65,535.

In the browser, rendering **accumulates** light along each ray. A background of 2,600 repeated over 112 slices ends up as a grey fog that hides the embryo.

::: analogy
It is a **cinema with a screen that is never quite black**: the emergency lights illuminate the room. Cleaning sets the screen's "black" to the level of the room, so that only the film remains visible.
:::

## 5.2 The idea on one page

All of the cleaning comes down to **a single question**, asked of every voxel: *is it part of the embryo?*

![The fate of a voxel. The percentages are measured over the whole volume of the demonstration dataset (DAPI channel).](img-en/ch05/destin.svg){width=100%}

:::: cols
::: col
**YES** (it is inside the "mask"):

- **nothing is touched**;
- its original value is simply converted to 8 bits.
:::
::: col
**NO** (it is outside the mask):

- it is **replaced by the median** of its 27 neighbours;
- that value is almost always below the floor, so it becomes **0**.
:::
::::

::: keynums
**85.1 %**
background already below the floor

**1.0 %**
noise peaks above the floor

**13.9 %**
inside the mask: kept as they are
:::

To answer the question, the pipeline needs **two landmarks** and **one map**:

| Question | The pipeline's answer | Name in the code |
|---|---|---|
| At what level does the real signal start? | 99 % of the noise of the 8 corners is below it | **floor** (`bg_floor`) |
| At what level should white be set? | 99.9 % of all the voxels are below it | **ceiling** (`sig_max`) |
| Where is the embryo? | the voxels clearly above the floor, without isolated points, plus a halo | **mask** |
| What to do with the rest? | replace each voxel by the median of its neighbours | **median** |
| How to go to 8 bits? | floor → 0, ceiling → 255, a straight line in between | **window** |

::: analogy
Think of a **proofreader** who must remove ink spots from a page. The written lines (the mask) are left alone. An isolated spot is erased. To decide what a spot is, the proofreader looks around it: if everything around is white, it is a spot; if it sits in the middle of a word, it is writing.
:::

## 5.3 A complete example, voxel by voxel

Take **19 voxels in a row**, with the real landmarks of the demonstration dataset (floor 4,524, ceiling 33,663). They hold a **noise peak** (4,700), a **hot pixel** (9,000) and a **cell** surrounded by its halo.

![The six stages, row by row. A one-dimensional example so that every number can be read; the pipeline applies exactly the same rules in 3D.](img-en/ch05/profil_etapes.svg){width=100%}

Read the figure from top to bottom:

::: steps
1. **Raw values.** The cells framed in red are above the floor. There are 8: the noise peak, the hot pixel, the cell and the edge of the halo (4,800).
2. **Threshold.** Only what is above **1.1 × floor = 4,976** counts as "certain signal". The noise peak (4,700) and the edge of the halo (4,800) do not pass; the hot pixel (9,000) does.
3. **Opening.** The hot pixel is **alone**: it is removed (✗). The cell, wide enough, stays.
4. **Dilation × 3.** The mask grows by **3 voxels on each side** of the cell (+). The halo, including the 4,800, is now protected.
5. **Median.** Outside the mask, each voxel takes the middle value of its neighbours. The 4,700 noise peak becomes **2,900**; the 9,000 hot pixel becomes **3,300**. Inside the mask (green), nothing changes.
6. **Window.** Everything below 4,524 becomes **0**. The cell goes from 12 to 187; the halo at 4,800 gives **2** (it is kept, very dark).
:::

::: example
**And without mask or median?** (last row of the figure) The window alone would let the noise peak (**1**) and the hot pixel (**39**) through: two stray grey dots on a black background. That is the whole point of the mask and the median.
:::

## 5.4 Stage A: the floor (`bg_floor`)

Where can pure background, with no embryo, be found? **In the corners** of the volume: the embryo is in the centre and touches none of them. The pipeline takes **8 cubes**, one per corner, **at most 32 voxels** on a side.

![The 8 corner cubes (diagram). In the demonstration dataset the stack has only 112 slices: the side is min(32, X÷4, Y÷4, Z÷4) = 28 voxels, i.e. 8 × 28³ = 175,616 reference voxels.](img-en/ch05/coins.svg){width=90%}

Then: **floor = 99th percentile of these voxels**, i.e. the value below which 99 % of them lie.

::: example
Line up the 175,616 corner voxels from smallest to largest. The voxel at 99 % of the queue is **4,524**: that is the floor.

- the noise averages about 2,600;
- 99 % of the noise is **below 4,524**;
- 1 % of the noise **exceeds** it (the strongest corner voxel is 6,238).
:::

![Left: the voxels of the 8 corners form a "bell" of noise; the red line is their 99th percentile. Right: the whole volume (one voxel in 4, log scale); the big peak on the left is the background, the long tail is the signal (demonstration dataset, DAPI channel).](img-en/ch05/histogramme.png){width=100%}

::: why
**Why the 99th and not the maximum?** The maximum depends on a single voxel, the most extreme one: it varies a lot from one acquisition to the next and would cut off faint signal. The 99th percentile is stable; the 1 % of noise above it is handled afterwards by the mask and the median. The code tried other rules (5th then 20th percentile, 10th percentile of the corners) before settling on this one.
:::

::: warning
If a corner touches the sample (tight crop, tile mosaic), the floor can be too high and cut off faint signal. The pipeline **writes it in its log** ("corner noise well above the volume median") but changes nothing: it never corrects silently.
:::

## 5.5 Stage B: the ceiling (`sig_max`)

For the top of the scale, the **whole volume** is looked at, but reading **only one voxel in 4** in each direction (indices 0, 4, 8…). That reads 1 voxel in 64 without changing the statistics.

![Sampling the white point: 1/64 of the voxels is enough.](img-en/ch05/echantillon.svg){width=95%}

**Ceiling = 99.9th percentile of these voxels**: the brightest 0.1 % will be shown white ("saturated"). In the demonstration dataset: **33,663**.

::: tldr
- Floor = 4,524: whatever is below will become 0.
- Ceiling = 33,663: whatever is above will become 255.
- The useful range is therefore **[4,524; 33,663]**, not [0; 65,535].
:::

## 5.6 Stage C: the mask, or "where is the embryo?"

The mask is a **yes / no map** the size of the volume: *yes* = this voxel belongs to the embryo (or to its halo) and will not be touched. It is built in three moves.

**1. Threshold: above 1.1 × floor.** Here 1.1 × 4,523.85 = **4,976**.

::: why
**Why 10 % above the floor?** By definition, 1 % of the noise exceeds the floor. With a 10 % margin, only **0.2 %** is left (measured in the corners of the demonstration dataset): five times less noise mistaken for signal.
:::

**2. Opening: removing isolated points.** It is an **erosion** ("nibble" 1 voxel all around) followed by a **dilation** ("give back" 1 voxel). A thick enough object gets its shape back; an isolated point, entirely nibbled away at the first step, does not come back.

**3. Dilation × 3: adding a halo.** The mask is widened by **3 voxels** all around. Fluorescence does not stop sharply at a cell's edge: it fades. The halo protects that fade (and faint signal right next to it) from the median.

![The three moves of the mask on slice z = 56. Bottom row: zoom. In red, the voxels removed by the opening; in blue, those added by the dilation.](img-en/ch05/masque.png){width=100%}

::: keynums
**11.77 %**
voxels above the threshold

**11.32 %**
after the opening

**13.92 %**
final mask (with halo)
:::

::: example
**The halo in micrometres.** With the voxels of the demonstration dataset (1.2 × 1.2 × 3.0 µm), 3 voxels are **3.6 µm** in X and Y and **9 µm** in Z. Because the dilation works through faces, the halo is a little narrower along diagonals (a diamond shape).
:::

### What is a "neighbour"?

Erosion and dilation look at a voxel's neighbours. The pipeline uses the **6-neighbour cross**: the two neighbours in X, in Y and in Z, which share a face. Diagonals do not count.

![The structuring element: the 6-neighbour 3D cross (scipy's default setting, not changed by the pipeline).](img-en/ch05/croix.svg){width=90%}

### Opening in miniature

![A 7 × 7 mini-grid. The 4 × 4 block survives (its corners slightly rounded), the isolated hot pixel disappears. Computed with scipy.](img-en/ch05/ouverture.svg){width=100%}

::: example
On the grid: 17 pixels lit at the start (16 of signal + 1 hot); after the opening **12** remain: the hot pixel and the 4 corners of the block are gone. The block's corners come back with the dilation × 3.
:::

::: why
The opening is done **before** the dilation. In the reverse order, a hot pixel would be "protected" and even **enlarged** by the dilation. Here it stays outside the mask, so it will be crushed by the median.
:::

## 5.7 Stage D: the median, outside the mask only

For each voxel **outside the mask**, the pipeline takes the **27 voxels** of the small 3 × 3 × 3 cube around it, sorts them, and keeps **the middle one** (the 14th). Inside the mask, the original value is kept.

![Median versus mean on 9 values (2D example): a 52,000 hot pixel is crushed by the median (2,990), but drives the mean up to 8,404.](img-en/ch05/mediane.svg){width=100%}

::: analogy
The **median** is the "middle" salary of a street: a billionaire moving in does not change it. The **mean** explodes. That is why a median filter crushes a hot pixel without inventing any new value.
:::

**What is it really for?** To deal with the **1 % of noise that exceeds the floor**. Without it, those voxels would become small grey dots on the black background.

::: keynums
**341,674**
visible noise dots with the window alone

**10,069**
with mask + median

**− 97 %**
stray dots
:::

::: note
The 10,069 voxels left (0.02 % of the volume) have a median above the floor: they are **faint but extended areas**, where more than half of the 27 neighbours are above the floor. An isolated point never survives: its neighbours are background.
:::

## 5.8 Stage E: the window, from 16 to 8 bits

The last operation, voxel by voxel, the same for the whole volume. The exact formula of the code:

::: example
**u8 = truncate( 255 × (clip(v, floor, ceiling) − floor) ÷ (ceiling − floor) )**

*v* is the voxel's value (original inside the mask, median outside); *clip* brings *v* back between the floor and the ceiling; "truncate" means the decimals are dropped (no rounding).
:::

![The window: flat at 0 below the floor, flat at 255 above the ceiling, linear in between. The orange points are the micro-examples below.](img-en/ch05/fenetre.png){width=85%}

::: example
With floor = 4,523.85 and ceiling = 33,662.57 (difference: 29,138.72):

- v = 4,000 → below the floor → **0**;
- v = 10,000 → 255 × 5,476.15 ÷ 29,138.72 = 47.9 → **47**;
- v = 20,000 → 255 × 15,476.15 ÷ 29,138.72 = 135.4 → **135**;
- v = 40,000 → above the ceiling → **255**.
:::

::: note
The conversion is **linear**, with no gamma curve. Any voxel ≤ floor becomes **exactly 0**: the background is a perfect black, which makes it possible to store no empty brick at all (chapter 6). In the demonstration dataset, **88.2 %** of the DAPI channel's voxels are 0 after cleaning.
:::

## 5.9 On real images

### A line at the edge of the embryo

![Top, the raw values along a line: green = inside the mask (value kept), orange = outside the mask (the median, which replaces the value). Green band = mask. Bottom, the 8-bit result.](img-en/ch05/profil_reel.png){width=100%}

- **Left and right** (background): the raw values swing between about 1,000 and 4,000; the median (orange) smooths them around 2,600; result **0**.
- **In the centre** (tissue): the green band covers the tissue **and its 3-voxel halo**; the values are kept, and the dark dip in the middle stays a dip.

### A line through a faint area

![Same reading, in an area where the tissue is barely above the noise (enlarged axes). Red dotted line: what the window alone would give.](img-en/ch05/profil_faible.png){width=100%}

- Only the peaks that form a **small cluster** (at least a few voxels in all 3 directions) enter the mask and are kept.
- Narrow peaks (around x = 405–412), even at 7,000, are **removed**: the red dotted line shows what would have been seen without the median.

### The map of fates

![Left the raw slice, centre what becomes of each voxel, right the result. In a faint area the mask (green) keeps only the clusters; orange is crushed by the median; red, rare, survives the median.](img-en/ch05/destin_carte.png){width=100%}

## 5.10 Minimum size of an object

A direct consequence of the opening and the median: **an object that is too thin is erased, even if it is very bright.**

![Bars with a square cross-section, at 20,000 (bright) or 6,000 (faint). The 1 × 1 and 2 × 2 cross-sections disappear; from 3 × 3 on, the object is kept intact, even when faint.](img-en/ch05/epaisseur.png){width=100%}

| Shape of the object (in voxels) | Result | Why |
|---|---|---|
| isolated point, 1 × 1 thread, sheet 1 voxel thick | **erased** | the opening removes it; the median of its 27 neighbours is background |
| 2 × 2 thread, small 2 × 2 × 2 cube | **erased** | same reason: fewer than 14 of the 27 neighbours are bright |
| sheet 2 voxels thick | kept | the opening removes it, but the median stays bright (18 neighbours out of 27) |
| at least 3 voxels in every direction | **kept intact** | it holds a complete cross: it enters the mask |

::: warning
**Order of magnitude: about 3 voxels in every direction.** With the voxels of the demonstration dataset (1.2 × 1.2 × 3.0 µm), that is **3.6 µm in X and Y and 9 µm in Z**. An object present on only one or two slices is therefore at risk of being erased, however bright. Do the calculation with **your** voxel sizes; when in doubt, compare with the original `.ims`. In practice the microscope's optical blur spreads most objects over several voxels, and a thin object **touching** a thick one (within 3 voxels) is protected by the halo.
:::

## 5.11 Before and after

![The same slice before (raw voxels displayed from 0 to the ceiling) and after cleaning. Bottom: zoom on the edge of the embryo. The grey grain of the background has disappeared; the nuclei are intact (demonstration dataset).](img-en/ch05/avant_apres.png){width=100%}

Look at the zoom: left of the edge, the grainy grey background has become pure black; on the right, the bright nuclei have the same shape and the same contrast.

## 5.12 What was tried, then abandoned

The pipeline once had more sophisticated methods, removed in version 0.12.0:

| Method | Why abandoned |
|---|---|
| Otsu threshold | Mask subtraction: created artificial **large coloured blobs** |
| Noise2Void (neural network) | Same artefactual result; the embryo lost its natural texture |

::: why
Current choice: the pipeline **removes only the camera's global background** and keeps the microscope's native intensities. No neural network, no flat-field correction. A test on a reference dataset recovered the 97 SHA-256 fingerprints of the production packs, byte for byte.
:::

## 5.13 Time series: a single window

For a movie (several images), should there be one window per image? **No: a single one for the whole series**, for each channel. Otherwise the image "flickers".

![Diagram (illustrative figures). A fluorophore fades (photobleaching). If each image is stretched over its own window, the screen stays constant while the signal collapses: that is wrong. With a single window, the screen dims like the real signal.](img-en/ch05/serie_temporelle.png){width=85%}

How is the single window measured?

- up to **8 images** are sampled (evenly spaced, always including the first and the last);
- `bg_floor` = 99th percentile of the corners of all these images together;
- `sig_max` = 99.9th percentile of **only the voxels above `bg_floor`**, if there are at least **1,000** of them.

::: why
In a sparse series, the signal covers only ~0.4% of the voxels: the 99.9th percentile of the whole volume would fall **inside the background** and saturate 15% of the real signal. By ranking only the voxels above the background, the saturated share falls to about 0.06% (measurements from the version 0.15.0 log).
:::

Photobleaching is **measured, never erased**: the pipeline records one signal level per image and per channel (99.9th percentile of the raw data) in `metadata.json`. No viewer setting uses these levels yet: a fading series therefore really does look darker, and nothing "catches it up" on screen.

## 5.14 Large volumes: in tiles, without changing the result

A channel of 3789 × 3789 × 178 voxels is 2.56 billion voxels, i.e. 10.2 GB as 32-bit floats: it does not fit in memory. The pipeline therefore reads it **in tiles** of at most **24 million voxels** (margin included).

![Tiling. The 5-voxel margin gives the edge computations (opening, dilations) the neighbours they lack; only the core is written.](img-en/ch05/tuiles.svg){width=100%}

Why 5 voxels? The erosion (1) + the dilation of the opening (1) + the 3 dilations (3) spread a voxel's influence over 5 voxels of distance. The median needs 1 (covered by the same margin).

::: example
**Verified on the demonstration dataset** (3 channels): cut into 4 tiles (the default setting), then into **256 tiles** (0.5 M voxels), the 8-bit volume is **byte-for-byte identical** to the single-block computation, and to the dataset published by the pipeline (slices z = 0, 30, 56 and 100).
:::

## 5.15 What this means for you

::: warning
8-bit values are **relative**, not absolute. Each channel has its own window [`bg_floor`; `sig_max`]; 128 on DAPI and 128 on Pecam1 do not represent the same quantity of light. Do not compare intensities between channels or between datasets.
:::

- In a **time series**, values are comparable between images **of the same channel** (single window).
- The **original .ims file** is never modified; it is the source for any intensity measurement. It can be downloaded from the `download/` folder if the dataset was published with its original files.
- What can be erased: a **very weak** signal (below 1.1 × `bg_floor`) that does not form an extended area, and any object **thinner than about 3 voxels** in one direction, even a bright one (§ 5.10). That is the price of a perfectly black background. Inside the mask, however, the original values are kept.

::: remember
1. `bg_floor` = 99th percentile of 8 corner cubes; `sig_max` = 99.9th percentile of one voxel in 4.
2. Mask = threshold 1.1 × `bg_floor` → opening (removes isolated points) → dilation × 3 (halo).
3. 3 × 3 × 3 median **outside the mask**; the signal stays intact. An object less than ~3 voxels thick is erased.
4. 8 bits = linear window [`bg_floor`; `sig_max`] → [0; 255], truncated; background = exact 0.
5. One window for a whole movie; tiling does not change the result.
:::
