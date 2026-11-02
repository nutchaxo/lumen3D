# 10. Displaying gigabytes: streaming

::: chapter-intro
- The browser **never** loads the whole volume: it downloads **bricks** (small cubes of 64³ voxels, plus a border) and keeps them in the graphics card's memory.
- A first image appears as soon as **25 %** of the bricks of the level are in place; the rest streams in without blocking the screen.
- On format 6 the picture on screen is a compressed copy (WebP Q30); exports read the lossless copy, and distance picks read the picture on screen. When the card cannot hold the level you ask for, the viewer shows a coarser one and says so.
:::

## 10.1 The loading sequence

When you open a dataset, seven steps follow one another. You do not see all of them, but they explain why the image becomes sharp **progressively**.

![From click to image: seven overlapping steps.](img-en/ch10/sequence.svg){width=100%}

::: steps
1. **Manifest.** The viewer reads the dataset's "map" (`bricks/manifest.json`): levels, brick size, pack files.
2. **Quality.** The level chosen in [Render Quality]{.ui} becomes a level of the pyramid (section 10.2).
3. **Coarse first.** On a first opening, the **coarsest** level streams first as a quick preview.
4. **Requested level.** The chosen level then streams in the background.
5. **Centre outwards.** Bricks are ranked by their distance from the centre of the volume, **measured in micrometres**, so that the thick Z voxels do not distort the "centre".
6. **Decoding.** Workers decode each brick outside the page (section 10.5).
7. **Atlas.** The decoded brick is copied to its place in the graphics card's memory (section 10.3).
:::

::: remember
The **first picture** appears when **25 %** of the bricks of the level are on the graphics card, and the loading card goes away. Redraws caused by incoming bricks are grouped: at most one every 250 ms.
:::

### Where to see progress

![The progress line of the viewer: quality, share of bricks processed and current step.](img-en/ch10/progression.png){.shot width=70%}

The percentage is the share of bricks **already processed** (placed or abandoned), not of bytes downloaded. The line disappears when the level is complete.

## 10.2 The quality controls

The [Render Quality]{.ui} panel depends on the format of the dataset (chapter 7). Three cases exist.

### Format 6 (current): a list of resolutions

On a format 6 dataset, the panel shows **one button per resolution**, finest first. Each button gives:

- the resolution's name: [Native]{.ui} (the acquisition itself), then the length of its longest XY side (512, 256…);
- its voxel grid, for example `768×576×112`;
- the **graphics memory** the level takes once loaded, for example `GPU 189 MB`.

The colour of a button says whether the card holds the level:

| Colour | Meaning |
|---|---|
| green | the card holds it, under 75 % of the budget |
| amber | close to the budget: 75 to 100 % |
| red | more than the budget: the viewer shows the next coarser level |

The **Fast loading** checkbox sits under the list:

- **On** (the default): the picture is the **WebP Q30** copy. The downloads are small.
- **Off**: the picture is the **lossless** copy of the same resolution. The downloads are bigger; the graphics memory is the same.
- The choice is kept in this browser only. Changing it reloads the current resolution.

::: note
A resolution is named after its longest XY side. If the dataset has no level of that size, the closest level **below** is taken; [Native]{.ui} is level 0 and is taken whenever the request is at least the native size. The viewer opens at **512**.
:::

The demonstration dataset has three levels:

| Level | Voxels (x × y × z) | Voxel (µm) |
|---|---|---|
| Native | 768 × 576 × 112 | 1.2 × 1.2 × 3.0 |
| 512 | 512 × 384 × 112 | 1.8 × 1.8 × 3.0 |
| 256 | 256 × 192 × 112 | 3.6 × 3.6 × 3.0 |

::: tip
If the card cannot hold the level you chose, a line under the list says so, for example "Shown at 512: the GPU does not hold Native". Nothing is lost: the level you chose is still the one you asked for.
:::

### Format 5: a list of resolutions and a list of qualities

On a format 5 dataset (section 7.11), the panel shows **two lists**: [Resolution]{.ui} and [Quality]{.ui}. Each pair of choices is one cell of the matrix, and a click loads it. A summary line gives what is on screen and its size, for example "Native · Max: 7.5 MB".

| Quality | Short name | What it guarantees |
|---|---|---|
| **Max** | Exact | every voxel as acquired |
| **Extra** | ±2 levels | no voxel moves by more than 2 of the 256 grey levels |
| **High** | ±4 levels | no voxel moves by more than 4 grey levels |
| **Medium** | WebP 80 | lossy WebP at quality 80 |
| **Low** | WebP 50 | lossy WebP at quality 50 |

The [How to choose?]{.ui} button opens a guide with **every combination**: its size, its download time and its graphics memory. The times are computed at a download speed you pick: the speed measured on this page, or a fixed one (20 Mb/s by default). The guide advises: the finest resolution shown green, at Extra; for a measurement or a figure, Max at Native.

### Formats 1 to 4: the 512, 1024 and Native select

Older datasets keep a select with **512x512**, **1024x1024** and **Native**. Each preset reaches the finest level whose longest XY side is at most **1.5 times** the preset: 512 reaches a level of at most 768 voxels, 1024 a level of at most 1,536. Native is always level 0. On the E9.5 demonstration dataset in format 4, all three presets reach level 0, so the select shows a single option.

### What the exports read

| Output | What it reads |
|---|---|
| Distance measurements | the picture on screen; its precision is the voxel size of the displayed level (chapter 12) |
| Plugins that compute a number through `ctx.data` | always the lossless copy of the native level (chapters 12 and 15), whatever is on screen |
| 3D view image (the export button of the view) | format 6: the lossless level on screen, with no question. Format 5: a choice, **Lossless** (the finest level the card holds) or **Current quality** |
| Studio figure and Decompose export | the same rule as the 3D view image |
| Download Center | **Download .q30.zip** (format 6): the display bricks as stored; the OME-Zarr export: the lossless bricks |

::: warning
A lossy copy **changes the displayed voxels**, not the data. A display setting never skews a measurement.
:::

## 10.3 The GPU atlas and the page table

A brick of 64³ voxels is too small to deserve its own texture; creating hundreds of them would be unmanageable. The viewer therefore reserves in video memory **large blocks of identical slots**: the **atlas**.

::: analogy
The atlas is a **warehouse** whose shelves are all the same size. The **page table** is the **index card** at the entrance: "brick no. 17 is on shelf 4". When the ray needs a voxel, it consults the card, then goes straight to the right shelf. If the card says "empty", it does not even move.
:::

![The atlas and its page table.](img-en/ch10/atlas.svg){width=100%}

- **One table cell per brick** of the volume: page number and slot, or "empty".
- Up to **8 atlas pages**. Each page is a cube of 4, 8 or 16 slots per side. A page is at most **512 MiB**, or **1 GiB** when the budget exceeds 4 GiB.
- **Channels, uncompressed**: one channel takes 1 byte per voxel; two channels take 2 bytes; three channels take 3 bytes, as two textures (RG8 and R8), when that fits in four pages, and 4 bytes otherwise; four channels take 4 bytes (RGBA8).
- When every slot is taken, the **least recently used** one is recycled.
- The atlas is **sized before it is allocated**: no texture is ever created at random for a brick.

::: tech
A small level stays in one piece. If it is under **512 MiB** at 4 bytes per voxel (1 byte for a single channel), and each side is within the card's 3D texture limit, it is stored as **one dense 3D texture**. The E9.5 demonstration dataset at native resolution is an example: 768 × 576 × 112 × 4 bytes ≈ **189 MiB**. The paged atlas is used for larger levels.
:::

### Compression: automatic

Where the card supports it, every bricked volume is kept **compressed**: RGTC blocks (BC4 for one channel, BC5 for two, BC5 with BC4 for three or four channels). That is **0.5 byte per voxel and channel** instead of 1. Three channels take 1.5 bytes per voxel against 4 for RGBA8: on a native lab volume (E85), 288 MB against 702 MB, a reduction of 59 % (changelog 1.71.0).

The compressed copy is a lossy display copy. The Studio's native pass and the measurements stay exact.

There is no setting: the viewer tests the card when a page loads, and **refuses compression** in these cases:

| Case | Why |
|---|---|
| no WebGL2, or no RGTC support | the card cannot read these textures |
| a software renderer (SwiftShader, llvmpipe) | it emulates the textures and loses the context |
| a phone or tablet GPU (Adreno, Mali, PowerVR, Xclipse, Immortalis, Vivante, VideoCore), or any Android browser | the RGTC emulation broke a real atlas on an Adreno 740 tablet |
| the context was lost while a compressed atlas was on the card | this device is not given compression again in this browser |

Without compression, the atlas takes the uncompressed sizes of the previous section. This is why a phone's budget is a smaller number (section 10.4).

## 10.4 The GPU memory budget: automatic

No browser tells you how much graphics memory is left. The viewer **estimates** the budget, the memory the volume may take, from the name of the card and the device's memory. There is no setting for it.

| Graphics card | Budget used |
|---|---|
| a known model (NVIDIA, Radeon, Intel Arc) | 60 % of its memory, at most 2 GiB less than the card, between 1 and 16 GiB |
| software rendering | **256 MiB** |
| integrated, phones and tablets | 2 GiB with 8 GB or more of device memory, 1 GiB from 4 GB, otherwise 512 MiB |
| dedicated, model not known | **4 GiB** (3 GiB if the device reports less than 8 GB) |
| unknown | 2 GiB with 8 GB or more, otherwise 1 GiB |

Each **graphics context loss** in the last seven days halves the budget, up to four halvings and never below 256 MiB. A refused allocation lowers it below the size that failed, for the rest of the session. The formula and an example are in chapter 2 (section 2.8).

### When it does not fit

Before allocating anything, the viewer computes the size of the requested level. If it exceeds the budget, it tries the **next coarser** level, and so on.

::: example
**Fictional** example: you ask for **Native** and level 0 needs 1.9 GiB for a budget of 1 GiB. The viewer moves to level 1, about four times smaller, which fits. A notice appears:

"{requested} resolution exceeds available GPU memory — displaying {actual} instead. ({needed} MB needed, {budget} MB available for the volume.)"
:::

If the card **refuses** an allocation despite the calculation, the viewer also falls back to a coarser level, and the notice adds "(The GPU refused the allocation.)". The volume on screen always stays visible: the tab does not crash.

## 10.5 Downloading and decoding without blocking the page

Decoding a brick (a WebP image to be unpacked into voxels) is heavy work. It is handed to a **pool of workers** that run **alongside the page**: the interface stays smooth.

- **Number of workers**: `min(8, number of cores − 1)`, at least 1.
- **Faithful decoding**: no browser colour management is applied; the bytes are **measured intensities**, not colours.
- **Mosaic**: a 66³-voxel brick is a WebP image of 594 × 528 pixels (9 × 8 tiles of 66 × 66). An image of any other size is rejected as corrupt.
- **No needless copying**: the decoded bytes are transferred to the page, then sent to the graphics card.
- A worker that crashes or stops answering for 30 s is **replaced**. A brick is tried up to **3 times**, then counted as missing.

::: warning
A corrupt brick is **never** displayed: it stays empty and the viewer reports it (for example: "N bricks could not be loaded"). An incomplete stream is not kept in memory: reload to try again.
:::

## 10.6 Packs: an ordered download

Bricks are stored in **packs** (`.bin` files). Downloading a whole pack is far more efficient than thousands of small requests.

- **Pack by pack**: the viewer starts from the central brick and moves on pack after pack. Each pack is downloaded **once** and released as soon as its bricks are cut out.
- **At most 4 pack downloads at the same time**, because a browser opens 6 connections per server: the page's own calls must not wait behind big files.
- **Precise cuts**: for a slice or a Studio image, only the useful **byte ranges** are requested.

| Cache (compressed bytes) | Size |
|---|---|
| Whole packs, while a load still needs them | 192 MiB |
| Byte ranges (slices) | 64 MiB |
| Prefetch (neighbouring frames of a series) | 32 MiB |

::: tech
**Decoded** bricks are never kept on the page side: the GPU atlas is their only home. Each pack address carries a `?v=` stamp, a fingerprint of the manifest's packs, and the server answers "keep for one year". If the dataset changes, the fingerprint changes and the browser downloads again.
:::

## 10.7 Time series

A **live** dataset (time series) contains **one brick tree per timepoint**. Each timepoint is loaded as a small volume in its own right.

![Each timepoint has its own tree; the buffer shows the frames already in memory.](img-en/ch10/serie-temporelle.svg){width=100%}

![The timeline of the Demo-Lumen3D-E85-Em1-30min-2ch-4tp demo dataset: playback, speed, time slider and buffer bar.](img-en/ch10/live-page.png){.shot width=95%}

- **Playback**: speeds of **0.5 – 1 – 2 – 5 – 10 – 20 frames per second**. The default is 10, and your choice is remembered in this browser.
- **One request at a time**: if you move the slider quickly, only the **last** request is served.
- **Playback waits for the frame**: the clock stops while a frame loads, so playback runs at the real speed of arrival.
- **Buffer**: the viewer keeps neighbouring frames in memory, up to `min(768 MiB, max(128 MiB, 40 % of the graphics budget))`. The timeline bar shows those **actually present** at the current quality. If the series does not fit entirely, a text says so: "Buffer n/total · quality — the whole series does not fit in memory".
- **Prefetch**: during playback, the packs of the following frames (t+1, t+2…) are loaded in spare time.

::: note
The **native** level is not kept in the cache, because its atlas is too large for it. Its frames are therefore not prefetched; the other levels are.
:::

## 10.8 The whole level stays in memory

Earlier versions had a *zoom detail* mode, which loaded finer bricks only where you zoomed in. It was **removed in platform 1.72.0**. The quality you choose is now the one shown: the whole level stays in memory, and the graphics budget (section 10.4) decides which level that is. Zooming in never changes the level by itself.

## 10.9 When the graphics card crashes

A browser can take the graphics card away from a page: a struggling driver, or too much memory requested. The viewer knows how to **restart on its own**.

![Recovery after a graphics context loss.](img-en/ch10/perte-contexte.svg){width=100%}

You first see "GPU context lost: rendering is paused until the browser gives it back." When the card returns, the volume reloads at a smaller budget (half the previous one, see section 10.4), and the status line says "GPU context restored: reloading the volume…". After **three losses within 120 seconds**, the viewer stops reloading by itself and says: "The GPU reset 3 times in a row: the volume is not reloaded automatically. Choose a lower quality or reload the page."

::: tip
**On a phone or a tablet.** Compression is refused there (section 10.3), so the same level takes more graphics memory than it would compressed, and the budget is the smaller estimate of section 10.4. If a phone or Android browser loses its 3D context, the status line explains it as above. If the page cannot get a 3D context at all, it shows: "This browser refused to give the page a 3D (WebGL) context." On Android, close the browser completely (Settings › Apps › Chrome › Force stop) and open the page again.
:::
