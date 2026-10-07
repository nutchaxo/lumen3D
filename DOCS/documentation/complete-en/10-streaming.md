# 10. Displaying gigabytes: streaming

::: chapter-intro
- The browser **never** loads the whole volume: it downloads **bricks** (small cubes of 64³ voxels) from the centre outwards and stores them in the graphics card's memory.
- A first image appears as soon as **25%** of the bricks are in place; quality then climbs without blocking the screen.
- If graphics memory is insufficient, the viewer automatically picks a **coarser level** and tells you so.
:::

## 10.1 The loading sequence

When you open a dataset, seven steps follow one another. You do not see all of them, but they explain why the image becomes sharp **progressively**.

![From click to image: seven overlapping steps.](img-en/ch10/sequence.svg){width=100%}

::: steps
1. **Manifest.** The viewer reads the dataset's "map" (`bricks/manifest.json`): pyramid levels, brick size, pack files.
2. **Quality.** The [Render Quality]{.ui} menu is translated into a pyramid level (section 10.2).
3. **Coarse first.** On first opening, the **coarsest** level is loaded first: a few bricks, an image in the blink of an eye.
4. **Requested level.** The chosen level then loads in the background.
5. **Centre outwards.** Bricks are ranked by their distance from the centre, **measured in micrometres** (so that the large voxel thickness in Z does not distort the "centre").
6. **Decoding.** "Workers" decode each brick outside the page (section 10.5).
7. **Atlas.** The decoded brick is copied to its place in the graphics card's memory (section 10.3).
:::

::: remember
The **first image** is displayed when **25%** of the bricks of the current level are on the graphics card; the "loading" card then disappears. Redraws caused by incoming bricks are grouped (at most one every 250 ms).
:::

### Where to see progress

![The progress line at the bottom left of the viewer: quality, percentage of bricks processed and current step.](img-en/ch10/progression.png){.shot width=70%}

The percentage is the share of bricks **already processed** (placed or abandoned), not of bytes downloaded. The line disappears when the level is complete.

## 10.2 The quality menu: 512, 1024, Native

The pyramid of levels was built by the pipeline (chapter 6): each level has **4 times fewer voxels in X × Y** than the previous one. The menu picks **the finest level that remains reasonable** for the requested setting.

![The real pyramid of the E9.5 demo dataset and the rule behind the three qualities.](img-en/ch10/pyramide.svg){width=100%}

| Setting | Level chosen (format 4) |
|---|---|
| **512** (default) | the finest level whose longest XY side is **≤ 768 voxels** |
| **1024** | the finest level whose longest XY side is **≤ 1,536 voxels** |
| **Native** | always **level 0** (full resolution) |

::: example
A **fictional** dataset of 3,072 × 2,304 voxels in XY, with levels at 3,072, 1,536, 768 and 384:

- **512** → level at 768 (≤ 768); **1024** → level at 1,536 (≤ 1,536); **Native** → 3,072.

On the E9.5 demo dataset, the longest side is 768: all three settings land on level 0. The menu then **shows only one option**, with the real dimensions: [Native (768x576x112)]{.ui}.
:::

![The [Render Quality]{.ui} panel: one line per genuinely distinct level (here a single one, with its dimensions), the status line and, below it, the [Zoom detail]{.ui} selector (section 10.8).](img-en/ch10/qualite-liste.png){.shot width=45%}

::: note
The viewer opens at **512** quality. A quality change that fails leaves the previous volume on screen and puts the menu back as it was.
:::

## 10.3 The GPU atlas and the page table

A brick of 64³ voxels is too small to deserve its own texture; creating hundreds of them would be unmanageable. The viewer therefore reserves in video memory **large blocks of identical slots**: the **atlas**.

::: analogy
The atlas is a **warehouse** whose shelves are all the same size. The **page table** is the **index card** at the entrance: "brick no. 17 is on shelf 4". When the ray needs a voxel, it consults the card, then goes straight to the right shelf. If the card says "empty", it does not even move.
:::

![The atlas and its page table.](img-en/ch10/atlas.svg){width=100%}

- **One table cell per brick** of the volume: page number + slot, or "empty".
- Up to **8 atlas pages**, each 4, 8 or 16 slots per side.
- **1 to 4 channels** per voxel, one byte each: 1 channel = 1 byte per voxel, 2 channels = 2, 3 or 4 channels = 4.
- When all slots are taken, the **least recently used** one is recycled.
- The atlas is **sized before it is allocated**: no texture is ever created at random for a brick.

::: tech
A small volume stays in one piece: if the level fits in less than **512 MiB** (at 4 bytes per voxel) and within the card's limits, it is stored in **a single dense 3D texture**. The E9.5 dataset at level 0 is an example: 768 × 576 × 112 × 4 bytes ≈ **189 MiB**. The paged atlas is used only for large levels.
:::

## 10.4 The video memory budget

No browser tells you how much video memory is left. The viewer **estimates it** from the type of graphics card and, if available, the device's memory.

![The estimated budget by graphics-card type (1 GiB = 1,024 MiB).](img-en/ch10/vram.svg){width=95%}

| GPU type | Estimated budget |
|---|---|
| Software (no real graphics card) | **256 MiB** |
| Integrated (Intel, Apple…) | **0.5 to 2 GiB** depending on the device's memory |
| Dedicated (NVIDIA, Radeon…) | **4 GiB** (3 GiB if the device reports less than 8 GB) |
| Unknown | 1 or 2 GiB |

Each graphics **context loss** in the past week **halves the budget** (floor: 256 MiB). The administrator can set it by hand if needed.

### When it does not fit

Before allocating anything, the viewer computes the size of the requested level. If it exceeds the budget, it tries the **next coarser** level, and so on.

::: example
**Fictional** example: you ask for **Native** and level 0 needs 1.9 GiB for a budget of 1 GiB: the viewer moves to level 1 (about 4 times smaller), which fits. A notice appears:

"{requested} resolution exceeds available GPU memory — displaying {actual} instead. ({needed} MB needed, {budget} MB available for the volume.)"
:::

If the card **refuses** an allocation despite the calculation, the viewer also falls back to a coarser level; the notice says so: "(The GPU refused the allocation.)". The volume **always stays visible**, never a crashed tab.

## 10.5 Downloading and decoding without blocking the page

Decoding a brick (a WebP image to be unpacked into voxels) is heavy work. It is handed to a **pool of workers** that run **alongside the page**: the interface stays smooth.

- **Number of workers**: `min(8, number of cores − 1)`, at least 1.
- **Faithful decoding**: no browser colour management is applied; the bytes are **measured intensities**, not colours.
- **Mosaic**: a 66³-voxel brick is a WebP image of 594 × 528 pixels (9 × 8 tiles of 66 × 66); an image of any other size is rejected as corrupt.
- **No needless copying**: the decoded bytes are transferred as they are to the page, then sent to the graphics card.
- A worker that crashes or freezes (30 s) is **replaced**; the brick is retried up to 3 times, then counted as missing.

::: warning
A corrupt brick is **never** displayed: it stays empty and the viewer reports it (for example: "N bricks could not be loaded"). An incomplete stream is not kept in memory: reload to try again.
:::

## 10.6 Packs: an ordered download

Bricks are stored in **packs** (`.bin` files). Downloading a whole pack is far more efficient than thousands of small requests.

- **"Pack by pack" order**: the viewer starts from the central brick and moves on pack after pack; each pack is downloaded **only once** and released as soon as its bricks are cut out.
- **At most 4 pack downloads at the same time**, because a browser opens 6 connections per server: the page's own calls must not wait behind big files.
- **Precise cuts**: for a slice or a Studio image, only the useful **byte ranges** are requested.

| Cache (compressed bytes) | Size |
|---|---|
| Whole packs, while a load still needs them | 192 MiB |
| Byte ranges (slices) | 64 MiB |
| Prefetch (neighbouring frames of a series) | 32 MiB |

::: tech
**Decoded** bricks are never kept on the page side: the GPU atlas is their only home. Each pack address carries a `?v=` stamp (a fingerprint of the manifest's packs); the server then answers "keep for one year": if the dataset changes, the fingerprint changes and the browser downloads again.
:::

## 10.7 Time series

A **live** dataset (time series) contains **one brick tree per timepoint**. Each timepoint is loaded as a small volume in its own right.

![Each timepoint has its own tree; the buffer shows the frames already in memory.](img-en/ch10/serie-temporelle.svg){width=100%}

![The timeline of the Demo-Lumen3D-E85-Em1-30min-2ch-4tp demo dataset: playback, speed, time slider and buffer bar.](img-en/ch10/live-page.png){.shot width=95%}

- **Playback**: speeds of **0.5 – 1 – 2 – 5 – 10 – 20 frames per second** (10 by default, remembered in your browser).
- **One request at a time**: if you move the slider quickly, only the **last** request is served.
- **Playback waits for the frame**: the clock is suspended while a frame loads; playback runs at the real speed of arrival.
- **Buffer**: the viewer keeps neighbouring frames in memory (up to `min(768 MiB, max(128 MiB, 40% of the budget))`). The timeline bar shows those **actually present** at the current quality. A text says so if the series does not fit entirely: "Buffer n/total · quality — the whole series does not fit in memory (… frames max)".
- **Prefetch**: during playback, the packs of the following frames (t+1, t+2…) are prefetched in spare time.

::: note
Full prefetching is only possible for levels stored as a **dense texture**: a level held in a paged atlas is not prefetched.
:::

## 10.8 The "Zoom detail" mode

You zoom in hard on an area: the voxels of the chosen level become larger than the screen needs, and the image looks blurred. The [Zoom detail]{.ui} mode then loads **finer bricks, only in the visible area**.

![The chosen level everywhere (blue), and finer bricks only in the view (green).](img-en/ch10/roi.svg){width=95%}

| Option | Effect |
|---|---|
| [Automatic]{.ui} | active if the memory budget exceeds **1 GiB** |
| [On]{.ui} | active even below 1 GiB |
| [Off]{.ui} | never |

- **Trigger**: a voxel of the current level covers **more than 1.5 screen pixels**.
- The level chosen is **the coarsest** of the finer levels that drops below 1.5 pixels per voxel (the fewest bytes possible).
- Loading starts **350 ms** after the camera has stopped, 8 bricks at a time, **the largest and most central first**. It uses at most 768 MiB and 75% of the remaining memory.
- At the boundary of the fine area, the image switches from one level to the other **at a brick face**, with no cross-fade.

::: warning
The mode exists only for **format 4** (bricks with a border). It is suspended while a volume is loading and as soon as you apply a **Gaussian blur** to a channel (chapter 11), because raw bricks on a blurred channel would give a different image.
:::

The status text shows, depending on the case: "Detail: N bricks of level L in view", "Detail: loading x of y bricks of level L", or "Detail unavailable: not enough GPU memory left".


## 10.9 When the graphics card crashes

A browser can take the graphics card away from a page (a struggling driver, too much memory requested). The viewer knows how to **restart on its own**.

![Recovery after a graphics context loss.](img-en/ch10/perte-contexte.svg){width=100%}

You first see "GPU context lost: rendering is paused until the browser gives it back.", then the volume reloads in a lighter form. After **three losses within 120 seconds**, it stops and invites you to choose a lower quality or reload the page.
