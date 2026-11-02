# 9. The 3D viewer: Three.js and ray marching

::: chapter-intro
- Every pixel on the screen is computed by **one ray** that travels through the volume: this is **ray marching**, and it runs on the graphics card.
- **Three.js** provides the scene, the camera and the textures; the part that matters for the science (the three render modes) is **custom-written** and stays readable.
- The picture is the same while you turn the embryo and when it rests: the viewer never trades sharpness for speed. Only a very slow graphics card makes it take a slightly coarser step on the longest rays (section 9.9).
:::

## 9.1 Two brains: the processor and the graphics card

Your computer has two kinds of "brain". The **processor** (CPU) is a generalist. The **graphics card** (GPU) is specialised in a single thing: doing the same small calculation on thousands of points at once.

![One head chef against thousands of kitchen hands: the graphics card wins whenever the same gesture must be repeated millions of times.](img-en/ch09/cpu-gpu.svg){width=95%}

::: analogy
A star chef prepares one perfect plate in two minutes. To serve 2 million guests, it would take years. A thousand kitchen hands, each following **the same simple recipe**, serve the whole room in an instant. A 1,920 × 1,080 pixel screen is exactly that room.
:::

In Lumen3D, the "recipe" is called a **shader**: a small program written once and run simultaneously for every pixel. All the volume computation happens there.

## 9.2 WebGL2 and Three.js: who does what

**WebGL2** is the standard language browsers understand to talk to the graphics card. Among other things, it can handle **3D textures**: blocks of voxels stored directly in video memory. This is essential for a volume.

**Three.js** (version **0.147.0**) is a library that sits on top of WebGL2 and takes care of the "plumbing". It is **hosted on the platform's own server** (the `js/vendor/` folder), not downloaded from the Internet.

![The four layers between your mouse and the displayed pixel.](img-en/ch09/pile-logicielle.svg){width=90%}

| Provided by Three.js | Custom-written for Lumen3D |
|---|---|
| The drawing engine (the "renderer"), the scene | The ray-marching **shaders** (3 render modes) |
| The perspective camera (45° field of view) | The brick **atlas** and its page table |
| The **cube** (a six-faced box that is the starting point of the rays) | Brick **streaming** (chapter 10) |
| Matrices, quaternions, vectors | The GPU memory budget and the choice of level |
| The wrapper around 3D textures | Depth reading under the mouse (measurements) |
| The 3D model loader (cell-tracking surface) | Channels, histograms, Gaussian filter |

::: why
- **Mature and light**: Three.js is very widely used and needs no assembly tool (no "build"): one file, one browser.
- **Offline**: copied onto the server, it works without Internet.
- **Auditable**: the part that determines what you see (the rendering formulas) is lab code, commented line by line. A full game engine was not needed: it would have brought thousands of functions that are useless for microscopy.
:::

::: note
The viewer requires **WebGL2** (there is no degraded WebGL1 version). If the graphics card cannot create 3D textures, loading is refused with a clear message, never by crashing the tab.
:::

## 9.3 Ray marching, step by step

The volume is an enormous array of values. To turn it into an image, we work **pixel by pixel**. Each screen pixel casts a **ray** from the eye through the cube. We read the volume along that ray, then summarise what we met into a single colour.

![One ray per pixel: entering the cube, one sample per voxel, then combining.](img-en/ch09/lancer-de-rayons.svg){width=100%}

::: steps
1. **Start.** The pixel defines a direction: the one that leaves the eye and passes through this pixel.
2. **Entry and exit.** The shader computes where the ray enters the cube and where it leaves it (the "ray / box intersection"). Outside the cube, the pixel stays transparent.
3. **Regular step.** We advance by **one voxel** each time and read the value of every channel.
4. **Combination.** The readings are summarised into one colour, according to the render mode (section 9.6).
:::

### One sample per voxel

Moving or at rest, the viewer takes **exactly one sample per voxel length** along the ray, whatever its direction (in Fluorescence mode, one sample per voxel of depth). This guarantees that **a structure one voxel wide never slips through the net**.

::: example
The E9.5 demo dataset is 768 × 576 × 112 voxels. A ray crossing the whole cube lengthwise (X axis) therefore takes **768 samples**. A diagonal ray, which is longer (√(768² + 576² + 112²) ≈ 966 voxels), takes **about 966**.
:::

::: tech
The step (in cube units) is `delta = 1 / (rate × nu)`, where `nu = ‖direction × (number of voxels of the level)‖` measures how many voxels the ray crosses per unit of length, and `rate = 1.0`, always. The step is therefore uniform in voxels, not in micrometres. If a ray needs more samples than the cap of the frame (between 256 and 4,096, see 9.9), the samples are spread evenly over that cap.
:::

## 9.4 Random grain against banding

With a fixed step, all neighbouring rays sample at the **same depth**. The result is **rings** ("banding"), like the contour lines of a map. They do not exist in the specimen: they are created by the calculation.

The remedy depends on the render mode:

- **Natural Fluorescence and Structure (DVR)**: the **first sample of each ray is shifted** by a random fraction of the step (a pseudo-random number computed from the pixel's position). The rings turn into a **fine grain**, which the eye averages out and ignores.
- **Fluorescence mode**: a random shift would make the brightest value flicker from one pixel to the next, and show as black pinholes inside bright structures. Its samples sit instead on fixed planes perpendicular to the view, at the same distance from the camera, so neighbouring rays read the same depth.

![Simulation of the accumulating modes: uniform sphere, one sample every 14 pixels. On the left, the rings; in the middle, the grain after random offset.](img-en/ch09/jitter.png){width=100%}

In the accumulating modes, the same random offset is used when exporting an image: it carries on from one tile to the next, with no visible seam.

## 9.5 Skipping the empty space

An embryo fills only part of its box. Bricks with no signal are not even stored (chapter 7). When a ray reaches an **absent** brick, there is nothing to read: it **jumps straight** to the exit face of that brick.

![The ray crosses three empty bricks without reading a single voxel.](img-en/ch09/saut-briques.svg){width=95%}

The jump lands on the same sample lattice as the rest of the ray: the image does not change, it is just computed faster.

::: note
An absent brick reads as **zeros**: black that costs almost nothing, not a hole in space.
:::

Inside a stored brick, the viewer also skips empty **8 × 8 × 8 voxel cells**. Each cell keeps the largest raw value of its voxels, so a ray jumps over a cell that cannot show anything with the current window. Moving a slider recomputes nothing. On a native test dataset (1,946 × 1,946 × 72 voxels), the maximum projection took 14.7 → 11.3 ms looking along Z and 44 → 32 ms from the side; timings vary by about ±20 % between runs (changelog 1.74.0).

## 9.6 The three render modes

The [Render mode]{.ui} menu (left-hand panel) offers three ways of summarising the values along a ray. Here is **the same viewpoint** of the E9.5 demo dataset (DAPI, Pecam1, Sox2), rendered three times.

:::: cols3
::: col
![[Fluorescence (Imaris-like)]{.ui}](img-en/ch09/mode-fluorescence.png){.shot}
:::
::: col
![[Natural Fluorescence]{.ui}](img-en/ch09/mode-naturelle.png){.shot}
:::
::: col
![[Structure (DVR)]{.ui}](img-en/ch09/mode-structure.png){.shot}
:::
::::

::: note
The middle and right-hand captures are lit with a higher [Visibility (exposure)]{.ui} slider (see the caption of the figure further down): at equal exposure, these two modes naturally produce a darker image.
:::

| Mode | What it does along the ray | Depth? |
|---|---|---|
| **Fluorescence** (default mode) | keeps the **strongest** value of each channel | no, everything is superimposed |
| **Natural fluorescence** | every point **glows**; what is in front **darkens** what is behind | yes |
| **Structure (DVR)** | stacks **semi-transparent** layers from front to back | yes |

### Mode 1: Fluorescence (Imaris-like)

This is the "classic" rendering of microscopy software. For **each channel separately**, the viewer keeps the **maximum value** met along the ray. The channel colours are then **added together**.

::: example
A ray crosses green at 0.85 and then magenta at 0.75. The pixel receives 0.85 of green **and** 0.75 of magenta: the magenta is not hidden by the green in front of it. Green + magenta added together give white where both are strong.
:::

::: tech
`mip = max(mip, v)` for each channel; final colour = Σ `mip_i × colour_i` × exposure. The ray stops early when **every** active channel has reached its ceiling (opacity × 0.999). A pixel whose maximum is below 0.004 stays transparent.
:::

::: note
**Changing the window costs no new march.** In this mode the viewer keeps the largest **raw** value of each channel along each ray, in one pass, then recolours that buffer in a second, cheap pass. The window, gamma, opacity, colour and channel switches only recolour. On a native test dataset (screen 1,280 × 793), a slider change costs about 1.2 ms instead of about 35 ms, and the picture stays within 3 grey levels out of 255 of the direct computation (changelog 1.75.0). The march runs again only when something that changes the maxima moves: the camera, the pose, the clip box, the bricks arriving. The buffer takes 8 bytes per screen pixel. Natural Fluorescence, Structure (DVR), image exports and the depth pick keep the single pass.
:::

### Mode 2: Natural fluorescence (emission and absorption)

Mental picture: each fluorophore is a **small lamp** glowing in its own colour, and the dense matter in front of it **filters** the light. You get relief and depth while keeping faithful colours.

::: tech
For each sample of density `d` = value of the strongest channel (if `d > 0.0025`):

- segment opacity (Beer-Lambert law): `a = 1 − exp(−absorption × delta × d)` with `absorption = 1.8`;
- emitted light: `T × emissionGain × exposure × delta × Σ v_i × colour_i` with `emissionGain = 2.2`, where `T` is the **transmittance** (the share of light not yet absorbed, from 1 down to 0);
- then `T ← T × (1 − a)`; stop when `T < 0.004`.

At the end, the **luminance** (Rec. 709 formula) is compressed with an extended Reinhard curve (white point 2.0) and the three components are multiplied by **the same ratio** ("chromaticity lock"): a very bright fluorophore stays green and never drifts to white. Only the overlap of 3 or 4 channels is lightened (by at most 50%). A saturation of 1.18 is applied at constant luminance.
:::

::: warning
The absorption is **not a measurement**: it is a display constant (1.8), independent of the specimen. It is there to give relief, not to quantify the real opacity of the tissue.
:::

### Mode 3: Structure (DVR)

DVR ("Direct Volume Rendering") stacks **semi-transparent** layers like tinted panes of glass, starting from the nearest. Once the stack is almost opaque (**97%**), the ray stops: what lies behind is no longer visible.

::: tech
For each sample of local opacity `a = max of the channels` (if `a > 0.01`):
`step = 1 − (1 − 0.05 × a)^(delta / 0.01)` then `colour += (1 − alpha) × step × local_colour` and `alpha += (1 − alpha) × step`.

The exponent makes a column of matter become opaque **according to its length**, not to the number of samples: the image does not change when the viewer lightens the step during rotation.
:::

### One ray, three answers

Imagine a ray that first meets a green cloud and then, a little further back, a magenta cloud that partly overlaps it.

![The same ray, summarised by the three modes (computed with the viewer's formulas; exposure slider 1 for mode 1, 4 for mode 2 and 3 for mode 3, as in the captures).](img-en/ch09/rayon-1d.png){width=100%}

- **Fluorescence**: we keep the strongest value of each channel, **regardless of order**.
- **Natural**: the light from the magenta cloud is somewhat **attenuated** by the green cloud in front (the transmittance falls to about 0.67).
- **Structure**: the green cloud partly **hides** the magenta; the accumulated opacity ends up around 0.68.

## 9.7 Smoothing between voxels

Between two voxels, the viewer does not show staircase steps: it **interpolates**. On **formats 4 to 6** (the bricks of the demo datasets), the graphics card blends the eight neighbouring voxels: this is **trilinear interpolation**.

So that this blending never spills from one brick into its neighbour, each brick is stored with a **1-voxel border** (66³ instead of 64³). At the boundaries between bricks the image is therefore continuous, with no seam.

::: remember
- **Formats 4 to 6**: trilinear interpolation (smooth).
- **Bricks without a border** (formats 1 to 3): the nearest voxel is displayed as it is (blocks visible when zoomed in).
:::

## 9.8 The same picture, moving or at rest

Earlier versions drew a lighter picture while you dragged the view, then a sharper one when it rested. That is gone (platform 1.74.0): **the picture does not depend on the interaction**. Every frame, moving or resting, uses the same three settings:

| Setting | Value | Why |
|---|---|---|
| Pixels per CSS pixel | the screen's density, at most **2** (`min(devicePixelRatio, 2)`) | a phone at 3× is drawn at 2×, which is already sharp |
| Samples per voxel | **1.0** | a structure one voxel wide is never skipped |
| Samples per ray | the cap of section 9.9 | one frame stays well under the graphics card's time limit |

- The only thing that can change a frame's sample count is the **watchdog** of section 9.9, and only when the graphics card measured that frame past 200 ms.
- While bricks arrive, the redraws are grouped: at most one every **250 ms**.

::: note
Nothing is drawn continuously: the viewer computes a frame only when something changes (camera, setting, arrival of bricks). During loading, redraws caused by new bricks are grouped **at most every 250 ms**.
:::

## 9.9 The safeguard against graphics-card crashes

On Windows, if a single graphics-card computation lasts more than about **2 seconds**, the system resets the card: this is a "TDR" and the screen flickers. The viewer protects itself against it.

::: tech
For every frame, the maximum number of samples per ray is `clamp(⌊k × 6 × 10⁹ / number of drawing-buffer pixels⌋, 256, 4096)`, where `k` starts at 1. Example: a 1,920 × 1,080 screen at a pixel ratio of 1 gives ⌊6 × 10⁹ / 2,073,600⌋ = **2,893** samples at most per ray; the same screen at a pixel ratio of 2 (8.3 million pixels) gives **723**.

`k` is adjusted from the frames the graphics card times (it needs the `EXT_disjoint_timer_query_webgl2` extension; without it, `k` stays at 1): a frame that takes more than 200 ms multiplies `k` by `max(0.5; 150 / duration)`, a frame under 60 ms raises it by 10 %, never above 1. A graphics context loss halves `k` (chapter 10).
:::

For you, this means that an exceptionally long ray may, on a very large screen, be sampled a little more coarsely than once per voxel. In normal use (volumes of a few hundred voxels), the ceiling is never reached.

## 9.10 True proportions: calibration and Z stretch

The cube is not drawn from the **number of voxels** but from the **real dimensions in micrometres**. Voxels are often thicker in Z than in X and Y; without correction, the embryo would look squashed.

![The file counts voxels; the screen shows micrometres. E9.5 demo dataset: voxels of 1.2 × 1.2 × 3.0 µm.](img-en/ch09/calibration.svg){width=95%}

::: example
E9.5 dataset: 768 × 576 × 112 voxels of 1.2 × 1.2 × 3.0 µm.

- X: 768 × 1.2 = **921.6 µm**; Y: 576 × 1.2 = **691.2 µm**.
- Z: (112 − 1) × 3.0 + optical section thickness 3.0 = **336 µm**.
- The longest side (X) is set to 1; the cube therefore measures **1 × 0.75 × 0.365** (336 / 921.6).
:::

The viewer sorts the calibration into three states: **exact** (voxel sizes and section thickness known), **estimated**, or **absent**. Without calibration, the 3D **scale bar** is hidden rather than wrong. This status is **recomputed by the viewer** from the metadata it receives ("exact" only if a section thickness is known); the pipeline itself writes only `exact` or `metadata-missing` (chapter 8).

In the [Physical Scale]{.ui} panel, the [Display Z override]{.ui} slider (from ×0.25 to ×2.0) stretches only the **display** in Z so that thin layers are easier to see; the [1:1]{.ui} button resets it. Measurements in µm ignore this stretch.

::: warning
The 3D scale bar is exact for whatever lies **at the depth of the specimen's centre**. The view is a perspective one: what is closer looks larger, and what is further away looks smaller.
:::
