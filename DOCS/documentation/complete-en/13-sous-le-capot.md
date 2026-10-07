# 13. The tools under the bonnet

::: chapter-intro
- Chapter 12 taught you **how to use** the tools. This one lifts the bonnet: **how they work**, with the numbers and formulas of the code.
- Nine topics: cell tracking and stabilisation, the Studio, Compare, the 2D page and its importer, the timeline, shared state (link, browser memory), the measurement algorithms, the gallery and linked datasets, orientation.
- None of this is needed to use the platform. Each section reads on its own; the *For the curious* boxes can be skipped.
:::

::: note
Every screenshot and every figure comes from the **demo dataset** (synthetic embryos and photographs generated for this documentation). When an example uses values invented for clarity (a memory budget, two pixel sizes), the text says so.
:::

## 13.1 Cell tracking in the viewer

::: tldr
- Tracked cells are drawn as **spheres** (one per cell), read from **arrays of numbers** prepared by a *worker*.
- Frame **stabilisation** never alters a single voxel: the shader only changes **where it reads** the texture, thanks to one 4 × 4 matrix per frame.
- Five tools share **one copy** of the data through a facade named `ctx.tracking`.
:::

Chapter 8 (§ 8.4) explained how the pipeline computes the tracking and the Kabsch rotation. Chapter 12 (§ 12.9) showed the buttons. This is **the middle part**: what the viewer does with those files, frame after frame.

### From file to spheres

![The path of the tracking data, from the file to the screen.](img-en/ch13/suivi-chemin.svg){width=96%}

The `tracks.json` file is not read by the page: a **worker** (a small programme running alongside the page, § 10.5) downloads it. It tries the compressed copy `tracks.json.gz` first and decompresses it with the browser. If that copy is missing, or the server has already decompressed it, the worker quietly falls back to the plain file.

The worker draws nothing. It puts everything into **typed arrays** (fixed-size runs of numbers) that it *transfers* to the page without copying. The viewer keeps these arrays **exactly once**: the drawing, the five tools and the exports all read the same ones.

::: analogy
**A phone book and a metro map.** The JSON file is a phone book: pleasant to read, slow to leaf through. The arrays are the metro map: everything sits at a fixed address. "Where is cell 15 at frame 3?" becomes **one read in an array**, not a search.
:::

### The arrays: two families

:::: cols
::: col
**Per frame** (for drawing, 30 times a second)

| Array | Content |
|---|---|
| `posStab` | stabilised positions, frame by frame |
| `posRaw` | the same, raw |
| `cellIdx` | number of the cell in each slot |
| `counts` | number of cells per frame |
:::
::: col
**Per cell** (for analysis)

| Array | Content |
|---|---|
| `parent`, `daughterStart/Idx` | lineage (mother; list of daughters) |
| `flags`, `regionIdx` | mitosis / fusion; region |
| `firstFrame`, `lastFrame` | lifespan |
| `cellFrameSlot` | slot of the cell **at each frame** (−1 = absent) |
:::
::::

The last array is the most useful: `cellFrameSlot[cell × frames + frame]` answers "where is this cell at this frame?" in **a single read**. It is what makes selection, trajectories and instant distances possible.

::: example
On the demo dataset (50 cells, 4 frames) the worker produces 8,048 bytes of arrays from a 32,675-byte file (10,991 compressed). The frames do not all hold the same number of cells: **48, 48, 49, 49**. Free slots are never drawn; they do not stay frozen at their last position.
:::

::: tech
- **32 bits everywhere**: counters and indices are `Uint32Array` / `Int32Array`. A 16-bit array would silently overflow beyond 65,535 cells; here nothing overflows.
- Cells are identified in the file by the text of their frame ("1", "2"…, Imaris counts from 1) whereas bricks count from 0. Rather than adding 1 by hand, the worker **builds the mapping** from the file's sorted `timepoints` list.
- An incomplete or non-finite position is **skipped and counted** (`malformed`): one faulty row never hides the whole layer.
- The `cellFrameSlot` table is the only one that grows with cells × frames. It is refused beyond 2²⁸ entries (1 GiB) with a message that says why, instead of an opaque out-of-memory error.
- A lineage may designate a cell by its key, its `id` or its `track_id` (the exporter has used all three); the worker tries them in that order, then **makes the link symmetric** (mother ↔ daughters).
:::

### Why spheres and not "points"

![GPU points versus instanced spheres.](img-en/ch13/suivi-spheres.svg){width=94%}

A sphere costs a little more than a point, but its diameter is set **in micrometres** (2 to 40, 12 by default) and stays correct at any zoom. The layer is an *instanced mesh*: a single reference sphere, drawn as many times as there are cells, with one matrix per instance.

::: tech
- The spheres are **children of the volume's cube**: orbit, pan, physical proportions and the operator's Z stretch apply with no extra code.
- The world diameter is `diameter_µm × (cube scale_x / acquisition size_x in µm)`. The sphere's scale is then **divided by the cube's own scale on each axis**: without that division, the Z stretch would turn it into an ellipsoid.
- `depthTest = false`: the volume is an additive ray-marcher **without depth**; a depth test would hide every centroid behind the cube's front face.
- The test "is this sphere inside the cropped box?" is **the same** as the shader's: the layer follows the Z-stack slab and the crop sliders instead of floating over a nearly hidden volume.
- A selected cell is drawn 1.8 times larger. A cell's colour comes from its region (one colour per **cell**, not per cell and per frame: thirty times fewer bytes).
:::

### Two frames of reference, one dictionary switch

The file carries **two sets of coordinates** for each cell: stabilised (`posStab`) and raw (`posRaw`). The layer never applies the stabilisation matrix to points: it **picks the right array**.

::: warning
Applying the matrix to points that are already stabilised would send them into a third frame of reference. At frame 1 the transformation is the identity, so you would see nothing. At frame 30 of a real series the error would reach about 250 µm and look like a general alignment fault. Hence the rule: **a dictionary, not a multiplication**.
:::

- Stabilised volume on screen: the layer reads `posStab`.
- Raw volume: it reads `posRaw`.
- If the file does **not** have raw coordinates for every cell and the displayed frame is raw, the layer **hides itself** ("Raw coordinates missing: tracking hidden on a non-stabilised volume"). A plausible but wrong layer would be worse than no layer. Your own visibility setting is not touched.

### Clicking a sphere

`pick()` casts a ray through the clicked point and tests it against the mesh **as it was drawn**: a filtered (mitoses, fusions) or cropped cell is never hit, and a hidden layer cannot be clicked. The result is the cell number, or −1.

### The `ctx.tracking` facade

The five tools (trajectories, surface, inspector, charts, cell distance) never touch the mesh or the arrays directly. They go through a **facade** that the page builds.

| It provides… | Examples |
|---|---|
| data | `getData()`, `positionUm(cell, frame)`, `cellsAt(frame)`, `whenLoaded()` |
| shared state | **one** selection, **one** neighbour radius (5 to 500 µm, 55 by default) |
| services | `pick(x, y)`, `umToObject()`, `isInsideClip()`, `getCamera()` |
| events | `loaded`, `frame`, `refresh`, `selection`, `options`, `style` |

::: why
**One selection, not five.** If the inspector, the trajectories and the charts each had their own, clicking a cell would light up three different things. With the facade, a chosen cell lights up everywhere, and the neighbour radius sets the inspector, the charts and the surface density in one go.
:::

The `frame` event is emitted **after** the layer has moved: a tool that draws over the points never runs one frame ahead of them.

## 13.2 Stabilisation: moving the gaze

::: tldr
- An embryo drifts and turns for hours. Stabilisation **cancels that movement on screen**.
- The viewer manufactures no new image: the shader reads each voxel **at another address** of the texture.
- It is applied only if the pipeline has checked that the motion is **rigid**.
:::

### The principle in three pictures

![Top row: what the microscope recorded. Bottom row: what the viewer shows.](img-en/ch13/stabilisation-3-images.svg){width=90%}

The microscope always looks through the same window. If the embryo drifts, **it** moves within the window. The viewer reverses the point of view: the embryo stays put on screen, and it is **the window** (the blue square) that turns and slides around it, like a camera following the animal.

::: analogy
**A camera operator, not a set decorator.** To keep a dancer in the middle of the picture, you can redraw the scenery around them in every shot (resampling), or simply **turn the camera**. Lumen3D turns the camera: the scenery, meaning the measured voxels, is never retouched.
:::

![Two ways of stabilising, and the one Lumen3D chooses.](img-en/ch13/warp-methode.svg){width=92%}

### The frames of reference, with real numbers

![Four acquisition windows (one per frame) in the embryo's frame, and the box that contains them all.](img-en/ch13/suivi-reperes.png){width=96%}

Three frames of reference are involved:

- the **raw frame**: the microscope's own; the 192 × 192 × 96 µm window is fixed;
- the **stabilised frame**: the embryo's, motionless; each frame has its own window there, rotated by 0; 2.3; 4.7; 7.0°;
- the **display box**: the smallest block that contains **all** the windows, here from (−16.3; −7.1; −2.4) to (197.9; 207.3; 96) µm.

The display box is what the geometric cube has to cover: without it, the window of frame 4 would stick out of the cube. The cube therefore grows, **without changing** its scale (the grid, the scale bar, the cutting plane and the camera framing keep relying on it).

### The shader: a chain of three changes of frame

![The point that is read goes through three frames, with the example of frame 4.](img-en/ch13/warp-chaine.svg){width=96%}

For every point where the ray takes a sample, the shader computes:

`volumeWarp = toTex · M⁻¹ · toUm`

1. `toUm` converts the object coordinate (from −½ to +½) into **stabilised micrometres**.
2. `M⁻¹` goes back to **raw micrometres**: it is the inverse of the matrix the tracking applied to the frame.
3. `toTex` converts to a **texture address** (from 0 to 1).

::: example
**Frame 4 of the demo dataset.** The exact centre of the screen (object 0; 0; 0) is (96; 96; 48) stabilised µm. After `M⁻¹` (rotation 7.03°, offset −16.14; 16.39; −1.79 µm) it becomes (101.65; 92.57; 49.89) raw µm, hence the texture address (0.529; 0.482; 0.520). A voxel slightly off-centre is read: **that is the entire "work"** of stabilisation.
:::

The matrix is computed **once per frame change** and passed to the shader as a constant. On the very first pass the shader is recompiled with the `VOLUME_WARP` option; after that, each frame only changes a number.

::: tech
- **Ray entry and exit.** The ray / box intersection is computed in the space of the **source texture** (where the acquisition box is exactly the unit cube), by `hitBoxWarped`. Sampling density therefore does not depend on how far the embryo has drifted: the image is no brighter or grainier at frame 30 than at frame 1.
- **Crop and cut.** The crop sliders, the Z-stack slab and the cutting plane act in the **display box**: you cut what you see, not the acquisition frame.
- **Safeguards.** A non-finite matrix, or one with a near-zero determinant (|det| ≤ 10⁻⁹), is **ignored**: the frame is shown undeformed and a warning appears in the console. A rigid rotation has a determinant of ±1: anything that strays from that is suspect.
- **Orbit untouched.** The warp changes neither the cube's position nor its rotation: those are the mouse controls and are saved in workspaces. Mixing a per-frame matrix into them would break both.
- **The oblique cut and the Studio** sample through the same warp (`samplingSpace`, `planeSweep`): a cut through a stabilised series shows exactly the slice of the screen.
:::

### When is it applied?

| Condition | If it is missing |
|---|---|
| `registration.appliedToVolume` is true (the rigidity test passed: residual ≤ 0.05 µm) | the image stays **raw**, only the tracking is stabilised |
| `acquisitionExtentUm` is present | same, with a warning |
| the frame's matrix is valid | that frame is shown undeformed |

The pipeline's rigidity test (chapter 8) is therefore **the only green light**. On the demo dataset the residual is 7.6 × 10⁻¹⁴ µm: stabilisation is applied.

::: note
There is **no "stabilised / raw" button** in the interface: stabilisation is on as soon as it is applicable. The switch exists in the page's API (`ViewerApp.setVolumeStabilized`); the points layer and the tools follow the change on the next frame, because they read the displayed frame of reference from the frame-ready event, never by asking again.
:::

::: warning
**On the demo dataset the image has not really drifted**: only the tracking's raw coordinates were generated with a drift (up to 23 µm, 7°). Applying stabilisation therefore shifts the volume slightly. This is why the figures in this section are **diagrams computed with the real matrices**, and not "before / after" screenshots that would suggest a visible gain.
:::

### The surface, provenance, measurements

- **The surface** `model.glb` contains one mesh **per frame**, in the raw frame and in the stabilised frame. It is a child of the cube like the spheres: the same `o = (p − A)/S − ½` places it, so orbit, Z stretch and stabilisation apply. The GLB reader is Three.js's own, **loaded on first use** with its integrity hash (SRI): the viewer page does not carry it.
- **Three colourings**: uniform, local density, region. A vertex's density is the sum of Gaussians `exp(−|v − c|² / 2σ²)` over the frame's cells, capped at 2.8 σ and stored in a uniform grid (a vertex only visits its neighbourhood), then smoothed twice over the mesh. The result is remembered as long as neither the frame, nor the neighbour radius, nor the palette changes.
- **The surface cut** uses Three.js clipping planes, which are in **world space** whereas the cube rotates: the planes are therefore re-expressed just before each draw. A solid cap closes the cut.
- **Provenance.** `tracking.surfaceOrigin` says whether the surface was **exported** by the analysis or **rebuilt** from the cells (the demo dataset's case).
- **Alignment.** On import the pipeline checks that the tracking really lies inside the volume: at least 50% of the raw positions inside the acquisition box enlarged by 10%, and a spread of at least 1% of the longest side. Otherwise it suggests the probable unit (mm, nm, m), without converting anything. The demo dataset: 100% inside, spread 0.83, `aligned: true`.
- **Units.** Positions are brought to µm on import; `tracking.provenance.unit` keeps the declared unit, the factor and its status (*native*, *converted*, *assumed*, *unknown*).
- **Measurements** of distances between cells are stored under the `tracking` scope of the measurement store, and their export notes the frame of reference (*stabilized* or *raw*).

::: remember
- Cells are **instanced spheres** read from **32-bit arrays**, in a single copy.
- Stabilisation is **a change of reading address**: `volumeWarp = toTex · M⁻¹ · toUm`.
- Nothing is resampled: it is reversible and exact.
- The only green light is the pipeline's **rigidity test**.
:::

## 13.3 The Studio in depth

::: tldr
- A Studio figure is a **document**: layers, guides, channel settings, a plane, a calibration. Never pixels in the JSON file.
- Channels are **recoloured without a new render**, with the same arithmetic as the slice shader.
- The **native** resolution arrives after opening, through a "plane" or an "atlas" path, under the protection of a document **token**.
:::

Chapter 12 (§ 12.7) showed how to annotate. Here is what happens when you click.

### The document

![The anatomy of a Studio document, and what the JSON file never contains.](img-en/ch13/studio-document.svg){width=96%}

The document fits in one object. The Studio **copies it entirely** at each history step, with two consequences: undo is instant and free of surprises, and the document must not contain large objects. In a Compare figure each cell carries three runtime fields (the raw values, the page frame, the cut): `_portableDocument()` strips them from every export, and the history copy keeps them **by reference**, not by duplication.

- **The history** keeps 80 steps. A channel change is a step like any other: undo reverts the **last** change, whatever it is, and undoing an annotation never restores the earlier channels.
- A burst of changes from one panel (a slider being dragged, one message per frame) forms **a single step**, closed by release, by a one-second pause, or by another action.
- **Layer types**: rectangle, ellipse, text, line, arrow, distance, angle, scale bar. Each layer has a unique identifier, a name, two flags (visible, locked), an optional group, a **rotation** in degrees (from −180 exclusive to 180) and a style.
- Coordinates are in **image pixels**. When the native pass replaces the preview with a larger image, every coordinate is multiplied by the size ratio: a layer stays on the structure it marks (line widths and font sizes, however, stay in screen pixels).

### The document token

![Why a late native pass cannot damage the next figure.](img-en/ch13/studio-jeton.svg){width=94%}

Opening a figure returns a **token** (a number that increases with every document). The native pass, which can last several minutes on a large volume, presents it with each of its updates. If you have closed the figure and opened another, the token no longer matches: the late image is **ignored**, and so is its progress bar.

Closing the Studio frees the native image, the history and the Compare frames, and cancels the transfer in progress.

### Rotating a layer without falsifying a measurement

A rectangle, an ellipse or a text are **turned at display time** around their centre: only the rotation is stored. A line, an arrow, a distance, an angle or a scale bar are made of **points**: the rotation is *baked* into the points, because their label is computed from them.

![A 100 µm ruler rotated on 1 × 2 µm pixels: its length in pixels is recomputed.](img-en/ch13/studio-regle.svg){width=94%}

- **Line, arrow**: rigid rotation of the points around their centre.
- **Angle**: turned in **micrometre** space (`p' = c + S⁻¹·R(θ)·S·(p − c)`, with `S` the pixel size). A rigid rotation in pixels would change the measured angle: on 1 × 2 µm pixels, a right angle turned by 45° would read 53.1°.
- **Distance**: the direction turns, the length in pixels is **recomputed** to keep the same length in µm.
- **Scale bar**: its direction *is* its rotation; the length in pixels is the one that measures exactly its value.

::: example
A 100 µm distance on 1 × 2 µm pixels. Horizontal: 100 px. At 45°: 100 / √(0.707² × 1² + 0.707² × 2²) = **63.25 px**. Vertical: **50 px**. The displayed value stays 100 µm.
:::

### Which pixel size for a layer?

A single slice has just one calibration. A **Compare figure** has **one per cell** (a panel = a cell with its rectangle and its µm/pixel). A point layer takes the calibration **of the cell that contains the middle of its points** (the nearest one, if the middle falls in a gutter). That is also the centre of its rotations: turning a layer therefore never hands it over to the neighbouring cell.

The scale bar is subtler: its middle depends on the length it takes, which depends on the cell. The Studio therefore looks for a **self-consistent** cell (whose own length puts the middle inside that same cell); failing that, the cell of the starting point decides, because it does not move when the other end is rewritten.

### Recolouring without re-rendering

![The path from raw values to colours.](img-en/ch13/studio-recolor.svg){width=96%}

When the Studio opens a slice, it receives two things: a coloured image, and the **raw values** of the channels (`raw`: four bytes per pixel, one per channel 0 to 3). The volume that produced them is a disposable atlas, gone after the pass. Recolouring therefore starts again from the raw values.

:::: cols
::: col
![XY slice of the demo dataset, viewer colours.](img-en/ch13/studio-recolor-a.png){.shot width=100%}
:::
::: col
![Same slice: DAPI off, Sox2 in orange. The layers have not moved.](img-en/ch13/studio-recolor-b.png){.shot width=100%}
:::
::::

The **compositor** (`SliceCompositor`) applies the slice shader's formula to every channel that is on: window `(raw/255 − min) / max(max − min; 10⁻⁴)`, then gamma, then `opacity × colour`, and a sum. It runs on **its own WebGL2 canvas** (the Compare page does not load Three.js), with a 256-value table per channel as a fallback.

::: tech
- The output colour is `clamp(Σ vᵢ·opacityᵢ·colourᵢ; 0; 1) × 255`, **transparent** below |rgb| < 0.005 for a single slice (the slice shader discards those fragments), **opaque** (black if nothing shows) for a slab projected as MIP or average.
- A **four-channel** slab has no spare byte to say where the volume exists: it carries a separate **coverage mask** of one byte per pixel, read from the alpha of the colour render of the same plane.
- The raw-value textures are kept within a budget of **256 MiB** (those of the masks in a separate 64 MiB budget, so that they do not evict each other). A raw of the same size is **rewritten in place** at each refinement of the native pass (`raw.version` number).
- The table fallback computes in double precision; the graphics card, in 32-bit floats, may differ by **one unit** on a byte at a rounding boundary.
:::

**The Studio's histograms do not have the same origin as the viewer's** (§ 11.5). They are computed **on the displayed slice** (up to 4 million samples, a single computation per raw), not over the whole volume. That is consistent: you set the contrast of what you see in the figure.

### The native pass

A volume of several gigabytes has no full-resolution slice "within reach". The Studio therefore works in two steps.

![From the preview to native resolution.](img-en/ch13/studio-natif.svg){width=94%}

1. **The preview**: the slice the graphics card already holds, rendered at 2048 px at most, with no network bytes at all. The Studio opens instantly.
2. **The native pass**: the viewer works out which bricks the plane crosses, fetches them at maximum resolution (level 0), and re-renders the slice in raw values **at regular intervals**.

The pass's image is framed like the preview (same region of the plane). Wherever a brick is still missing, the **preview fills the hole**: what you see is always a complete image, getting sharper and sharper. The render size is roughly **one pixel per voxel of the longest axis**, extended to the slice frame (× 1.5): from 512 to 16,384 px.

::: example
Demo dataset, 768 voxels along X: 768 × 1.5 = **1,152 px** of render. Each pixel covers 1.5 × 921.6 µm (the largest physical extent) / 1,152 = **1.2 µm**, which is exactly the voxel size: this dataset's native is as small as the preview.
:::

### Two paths for the same plane

![Why an axis-aligned plane does not need an atlas.](img-en/ch13/studio-plan-atlas.svg){width=94%}

- **"Plane" path**: for a plane aligned with an axis (XY, XZ, YZ) of an undeformed volume. For each pixel the shader reads the voxel `floor(uvw × dim)`; along the normal, the coordinate does not depend on the pixel, so the voxel planes that are read are **known in advance**. A layered 2D texture holds only those. For a MIP slab, each box of bricks is reduced to its per-channel maximum in a *worker* (`studio-plane-worker.js`), then the maxima of the bricks in a column are merged.
- **"Atlas" path**: oblique cut, stabilised series, averaged slab. A disposable 3D atlas, sized **before** it is allocated against the video-memory budget (chapter 10); if it does not fit (`SVR_OVER_BUDGET`), the level just below is tried and the progress label says so.

Where do the bytes of an XY plane come from?

| Source | When | What it saves |
|---|---|---|
| `planes/` (format 2 and later) | XY slice, level 0 | the other 63 planes of each brick |
| `mips/` (format 3 and later) | MIP slab over the whole stack | one maximum per 64-plane layer instead of 64 planes |
| bricks by byte ranges | everything else | the bricks not crossed and the whole packs |

The formats are detailed in chapter 7 (§ 7.8 and 7.9); here the Studio only **picks the most economical one** that exists, and falls back to the bricks if the folder or a file is missing.

::: tech
- **Empty brick ≠ missing brick.** A brick that the pipeline did not store (all its voxels are 0) is **zero**, never "pending": the atlas path points its entry at a single slot of zeros; the plane path marks its texels present from the start. Otherwise the preview would replace for ever every column that crosses an empty brick.
- **Progressive refinement**: at most every 0.5 s, as soon as 2% of the pass's bricks have arrived (or after 2 s regardless). A render is not restarted more often than a small multiple of the cost of the previous one.
- **Failure**: a chunk that fails twice keeps the preview's pixels and is counted (`missingChunks`). The final image is then labelled "partial native" and the Studio says so.
- **Channels switched off in the viewer**: when transport is per channel, they are not downloaded; switched on later in the Studio, they appear at preview resolution rather than black.
- **Independence**: the pass's brick batch has its own group and its own cancellation signal: a load started by the viewer does not cancel it, closing the Studio does.
:::

::: warning
**More than 256 MiB.** A thick Z-stack figure may ask for every brick of all its slices. Beyond an estimated 256 MiB, a dialogue offers three choices: load the native (with the number of MB), load the lower level (lighter), or keep the preview. The estimate goes through `planes/` and `mips/` when they exist: it can be far lower than that of the bricks, and the dialogue never offers "lighter" for more bytes.
:::

### A Z-stack figure

![The plane of a Z-stack figure is born from the screen's frame of reference.](img-en/ch13/studio-zstack.svg){width=96%}

When you open the Studio from the Z-stack browser, the plane is not the oblique-slice one: it is built so that the figure **is** the screen. The viewer asks where the screen's right and up point in the volume (`getScreenFrameInVolume`), picks the nearest **+Z** or **−Z** face (hence a yaw of 0 or 180°), then the **roll** that locks the image to the screen. The cursor's `n` slices become a slab of `n` samples, one per slice; beyond one slice, it is a MIP.

### Exporting, importing, and the limits

| | Rule |
|---|---|
| PNG | figure size, black background, **caption always burned in** (dataset · plane · size · pixel). Refused beyond 16,384 px a side or 2²⁸ pixels |
| JSON | layers, guides, channels, plane, calibration, Compare cells. Never a pixel |
| Reading a JSON | refused beyond 5 MB, 2,000 layers, 10,000 points; text limited to 2,000 characters |
| History | 80 steps |
| Channels | 4 at most (the texture is RGBA) |

**Importing a JSON** does not replace the open figure: it **applies** to it. The file is checked in full before anything changes (known layer types, numeric geometry, colours, unique identifiers).

- The open figure keeps its image, its frame, its calibration and its cells; it takes the file's **layers, guides and groups**, with the measurements re-read against the open figure's calibration (a scale bar keeps its value, a distance its points).
- It is **the same figure** if the file has the same size, names the same dataset (identifier or path), shows the same plane (within a tolerance) and the same frame of the series, and, for Compare, the same cells.
- In that case the file's **channel settings** also apply, and only if the slice can be recoloured without changing frame. Otherwise (another figure), only the **layers** go through, and a message says so.

::: remember
- A document = layers + guides + channels + plane + calibration, **without pixels**.
- Recolouring starts from the **raw values**: no new render of the volume.
- The native pass chooses **plane** or **atlas**, reads `planes/` and `mips/` when they exist, and protects itself with a **token**.
- Rotating a layer **recomputes** pixel lengths: the measurement does not move.
:::

## 13.4 Compare under the bonnet

::: tldr
- Compare is a **host** that drives up to four **real pages** (`viewer.html`, `2d.html`) locked in frames, by messages.
- Each page **describes** what it can do; the host draws the buttons. It never rummages in their document.
- A **common memory budget** of 1.5 GiB is shared between the panels by a small algorithm, and time is aligned by **fraction**.
:::

Chapter 12 (§ 12.8) described the page. Here is the protocol that holds it together.

### The architecture

![One host, four frames, and a single channel: messages.](img-en/ch13/compare-architecture.svg){width=96%}

Each panel is a **complete page** opened without its header (`hideHeader=true`) with a number (`panelIndex`). Since it is chrome-less, its toolbar is invisible: the page therefore **describes** its toolbar to the host, which draws the buttons in the panel's header.

::: why
**Why whole pages and not a shared engine?** Because every tool, every shortcut, every setting already exists in the page. Compare has **nothing to reimplement**: a new tool becomes available in the panels as soon as it declares that it can be driven from outside (`contexts: ["page", "panel"]`, chapter 15).
:::

### A five-step handshake

![What is said when a panel is added.](img-en/ch13/compare-sequence.svg){width=92%}

1. The host gives the frame its address (with `quality=512x512` for a volume: we always start small).
2. As soon as the page is mounted, it sends **`PANEL_READY`**: name, type, **described toolbar** (tools and toggle buttons, with their state), features (volume, photograph, timeline, number of channels, tracking), quality, and **the cost of each quality** in bytes of graphics memory.
3. The host answers with the common state: the current tool, then the catch-up of the synchronisations (see below).
4. It sets the quality, **one panel at a time**.
5. Later, it sends **requests** (capture, slice for the Studio, state…) that the page answers.

A page that does not send `PANEL_READY` within **180 s** is declared failed; the panel shows a [Retry]{.ui} button that reloads the frame from scratch. An error after set-up never removes the "ready" state: the volume already displayed is intact. At most **two** panels load at once; the others queue.

### The catalogue of messages

| Direction | Messages |
|---|---|
| **panel → host** | `PANEL_READY`, `PANEL_ERROR`, `PANEL_DATASET`, `PLUGIN_STATE`, `TOOL_CHANGED`, `QUALITY_STATUS`, `SIDEBAR_CLOSED`, `REQUEST_COMPARE_STUDIO` |
| **synchronisations** (panel → host → others) | `SYNC_CAMERA`, `SYNC_CHANNELS`, `SYNC_EXPOSURE`, `SYNC_Z`, `SYNC_TIME`, `SYNC_SLICER_SPEC`, `SYNC_ZSTACK_SLICE`, `WM_PHYSICAL_VIEW` |
| **host → panel** | `SET_TOOL`, `PLUGIN_ACTIVATE`, `SET_QUALITY`, `TOGGLE_SIDEBAR`, `TOGGLE_ZSTACK`, `SET_CHANNEL_ACTIVE`, `APPLY_WORKSPACE_STATE`, `PANEL_HELLO`, `WM_SET_PHYSICAL_VIEW` |
| **requests** (host → panel) | `REQUEST_CAPTURE`, `REQUEST_STUDIO_SLICE`, `REQUEST_WORKSPACE_STATE`, `REQUEST_CHANNEL_STATE` |
| **responses** (panel → host) | `CAPTURE`, `STUDIO_SLICE`, `WORKSPACE_STATE`, `CHANNEL_STATE` |

### Who may speak

- **Never a wildcard origin.** Messages go to the page's origin (`Utils.trustedTargetOrigin()`), never to `*`.
- **On receipt**, the host checks the origin, then that `event.source` really is **the window of the frame it mounted** at that number. A page nested inside a panel, carrying the same number, is ignored.
- A **response** is accepted only from the panel to which the request was sent, with the right type, **once**.

### Requests and responses

Each request carries a `requestId` (random prefix + counter). The response repeats it. If it does not arrive in time, the request fails with a precise code: `COMPARE_TIMEOUT`, `COMPARE_UNREACHABLE` (panel closed or unreachable), `COMPARE_PANEL_ERROR` (the page answered "impossible").

| Request | Timeout |
|---|---|
| capture, workspace state, channel state | 10 s |
| slice for the Studio (may render a native slice) | 90 s |

Images travel as **transferred** (not copied) `ImageBitmap`s: the panel renders its view and the photograph **in the same task** (its WebGL canvas does not keep its image), then transfers it. If the response arrives too late, its images are released instead of leaking.

### The common memory budget

The panels share **a single graphics processor**, but each believes it has all the memory to itself. "1024" may be worth a few hundred MB or more than a gigabyte depending on the dataset. Counting panels is therefore not enough: every volume **announces the price of each quality** (`qualityBytes`, atlas bytes), and the host shares out a **fixed budget of 1.5 GiB** (a constant in `compare.js`, not a measurement of your card).

![An example in three steps with three volumes (example values).](img-en/ch13/compare-qualite.svg){width=94%}

The algorithm (`CompareQuality.plan`) comes down to two loops:

1. **Lower**: as long as the total exceeds the budget, the panel that takes the most steps down one notch.
2. **Raise**: as long as a panel can go up one notch without exceeding it, the lowest goes up (on a tie, the cheapest step), without exceeding the ceiling.

::: example
Three volumes at 1024 cost 620 + 900 + 330 = 1,850 MiB, against a budget of 1,536. The biggest (900) drops to 512 (240): total 1,190. Raising it again would cost +660: 1,850 > 1,536, refused. Result: A and C at 1024, B at 512.
:::

- The **automatic ceiling** is 1024: "native" is only obtained by choosing it by hand. **Photographs have no quality** and do not count.
- A panel that has not yet priced its levels **reserves 256 MiB**.
- Raises happen **one panel at a time**: the next waits for the previous one's [`QUALITY_STATUS`]{.ui}. A panel that does not settle within **180 s** is abandoned (console message), and the level it did not reach is not requested again.
- If the card's memory made a panel go **lower** than requested, the requested level also counts as failed: otherwise the host would request it endlessly and reload the volume on every pass.
- An older page that does not price its levels follows the old **counting** rule: 1024 up to two volumes, 512 beyond, and it only goes up.
- Choosing 512, 1024 or Native by hand forces that level on every volume.

### Keeping the panels in the same place

**The camera.** Each dataset has its own `Q_base` calibration (§ 13.9). Two embryos oriented differently in their file therefore do not have the same cube pose for the same anatomical view. The panel that moves sends `Q_anat = Q_cube · Q_base⁻¹`; the receiving panel sets its cube to `Q_anat · Q_base`. While the Z-stack locks the top view, the received orientation is ignored but the zoom is kept.

![The camera is synchronised in anatomical pose, not in file pose.](img-en/ch13/compare-camera.svg){width=94%}

**Time.** Two series of different lengths are aligned on the **fraction** of their duration.

![Why the fraction, and how the echo is avoided.](img-en/ch13/compare-temps.svg){width=94%}

The rule is the same on both sides: if the lengths differ, `frame = round(fraction × (N − 1))`, otherwise the same number. It is backed by a guard: the host notes every frame it asked a panel to show (6 s window, 16 orders at most). The panel's announcement of that frame is the **response** to the order, not an operator action: it is not relayed.

**Channels** are synchronised **by name** ("Pecam1" with "Pecam1"), exposure included. **The Z plane, the oblique plane and the Z-stack slab** travel as normalised positions. **A photograph** exchanges a **physical** view (§ 13.5); an uncalibrated photo neither sends nor receives one.

Each family can be set with a switch in the header (Z-Stack, Time, Camera / view, Channels).

### A panel that arrives late

The host **remembers the last message of each family** (camera, physical view, time, each channel, exposure, Z plane, oblique plane, Z-stack) and the name of the panel that produced it. When a new panel becomes ready, `_replayLastSync` replays these messages to it: it opens where the others are, inside the stack, with the same channels switched off. If a panel is closed, what it produced is **forgotten**: a panel added later would not open on a dataset that no longer exists.

A workspace restoration replays nothing: the panel's saved state takes priority.

### The grid figure

The export (§ 12.8) composes **the visible grid** on a canvas of 2× the screen size, capped at **4096 px** a side. For each panel the host sends `REQUEST_CAPTURE`, draws the received image in its cell, and adds the title and a signature. A panel that does not answer is replaced by a grey frame with its name, and the number of stand-in panels is counted. The format is PNG or WebP (quality 0.95); the background follows the theme.

**Compare's Studio** reuses the Studio of § 13.3: one cell per panel. In **physical scale**, every calibrated panel is drawn at **a single µm per pixel**, that of the coarsest, and is never enlarged: a scale bar is true for all of them.

### The workspace

The [Save]{.ui} button stores, in the browser, the state of **every panel** plus that of the host:

`panels` · `panelTypes` · `layoutMode` · `layoutWeights` · `sync` · `tool` · `quality` · `panelZstackStates` · `panelSoloChannels` · `iframeStates`.

- The host **waits for every panel to be ready**; a failed panel is kept in the list (reopening the workspace retries it) with an empty state. Before that, the state is "not yet available" and the address is not updated.
- The **brick cache** is removed from a panel's state: it fills by itself during streaming and would change the address every second.
- On **restoration**, a panel's state is sent as soon as its document exists (the frame's `load` event), so that the viewer skips its first camera framing. An unknown quality is refused: it would never be acknowledged and would block the quality queue.
- The address (`#state=…`, § 13.7) is written only after an **operator change**: panels opened by the address itself (`?add=`) are the page's intact state, and the comparison point is taken again when they are all ready.

::: remember
- The panels are the **real pages**; the host asks, the page answers.
- Explicit origin, `event.source` checked, requests with `requestId` and timeout.
- Quality: **fixed 1.5 GiB budget**, lower the biggest then raise the lowest.
- Time: **fraction**, with an echo guard. Camera: **anatomical** pose.
:::

## 13.5 The 2D page in depth

::: tldr
- The engine is a **canvas** that you pan and zoom: three frames of reference, one scale relation.
- Display settings and stain isolation run in a **worker**, on a copy; the measured photograph is never modified.
- The importer reads the **pixel size** from the TIFF tags and the **file name** for the stage.
:::

### Three frames of reference

![Image, oriented, canvas: and the single calibration relation.](img-en/ch13/2d-reperes.svg){width=94%}

The `Viewer2D` engine does not use Three.js. It draws a 2D canvas with the transformation `sx = ox·scale + tx`. The mirror is applied **before** the rotation, around the image centre; the bounding box of the rotated image is used for framing. The angle is normalised to [−180; 180), and a "fitted" view stays fitted when the angle changes.

::: tech
- `scale` is the number of **CSS pixels per image pixel**. It is at most **32** and at least **0.25 × the fit**. The fit leaves a 2% margin on each side (factor 0.96).
- The wheel zooms around the cursor by a factor of 1.1 per 100 units; a single event never zooms by more than 3 notches, and Firefox, which counts in "lines", is converted to pixels (1 line = 33 px).
- A gesture of less than 4 pixels is a click. Two fingers make a zoom and a pan. A double-click fits. [Native resolution 1:1]{.ui} sets `scale = 1 / devicePixelRatio`: one image pixel per physical screen pixel.
- Measurement keeps the same contract as the volume's: `{ normalized, physicalUm, screen }`, with `physicalUm = pixel × pixel size`.
:::

### Loading in two steps

![The preview first, the native afterwards.](img-en/ch13/2d-chargement.svg){width=94%}

Both files are requested **together**; the first one decoded is drawn. A smaller image never replaces a larger one already on screen. When stepping with ←/→, the native request waits 150 ms for the key to settle: holding the arrow only downloads the photograph you stop on. A capture taken before the native one carries the enlarged preview: the Studio is warned (`quality: 'preview'`).

The page's loading badge distinguishes *preview*, *native*, and *native error* (the preview stays displayed).

### Display settings and isolation

![A channel's lookup table: 256 values computed once.](img-en/ch13/2d-lut.png){width=62%}

For each channel, the setting is a **table of 256 values**: `x = (v/255 · balance − ½)(1 + contrast/100) + ½ + brightness/100`, clamped to [0; 1], then `x^(1/gamma)`. Balance only applies to red and blue. Moving a slider therefore only recomputes the table, and the loop over the pixels is a simple lookup.

| Setting | Range |
|---|---|
| Brightness, Contrast | −100 to 100 |
| Gamma | 0.1 to 10 |
| Red, blue balance | 0.1 to 4 |

A value coming from a slider, a workspace file or a link is **sanitised**: unknown, ignored; out of range, brought back into range; non-numeric, refused. A booby-trapped value therefore cannot turn the photograph completely black.

::: warning
**Stain isolation takes priority over the settings**: as long as it is on, the view shows the isolation result alone. The two do not stack.
:::

**Flattening the background.** A pixel's gain is "mean illumination / local illumination". The illumination is modelled by a **quadratic surface** `c₀ + c₁x + c₂y + c₃x² + c₄y² + c₅xy` fitted by least squares on the map reduced to one eighth, keeping only the **darkest 40% of cells** (the matt background): a smooth surface cannot follow the embryo, which therefore keeps its own contrast. The gain is bounded between 0.5 and 3; a singular system gives a flat surface.

![A photograph's gain map and the resulting correction.](img-en/ch13/2d-aplatir.png){width=96%}

**Isolating the stain.** The computation comes down to four maps. The "yellow tissue" context is a local mean of `(R+G)/2 − B` at a quarter of the resolution (an 11 × 11 cell box, about 40 pixels, computed with a summed-area table, hence constant time per pixel). The stain `v` is `(B/(R+1) − 1.0) / 0.8` clamped to [0; 1], **only** if the context exceeds 5. The final pixel is a grey at 35% of its brightness, mixed with cyan `(90; 160; 255)` in proportion to `v`.

![The four maps of the computation, on the demo photograph.](img-en/ch13/2d-isolation-cartes.png){width=100%}

::: tech
- **Why this threshold of 5?** A large stained trunk pulls the local mean to 6–9; the matt background never exceeds 2 to 6. The threshold is deliberately low: a stain is blue **within** a yellow tissue.
- **The worker.** The page transfers an `ImageBitmap` (no copy), the worker draws on an `OffscreenCanvas`, applies the operations of `pixel-ops-2d.js` and returns a bitmap. The illumination and context maps depend only on the image: they are **kept** as long as the image does not change. If requests pile up (a slider being dragged), **only the most recent** is run.
- Without Worker or `OffscreenCanvas`, or if the worker crashes, the same code runs on the main thread, one job at a time. A capture takes an **exact** version for the current settings, never a stale one.
- These two operations are **display only**: measurements and the grid read the intact photograph. The Studio, for its part, receives what is on screen (isolated or adjusted, mirror and rotation included), at native resolution, calibrated in µm/pixel.
:::

### Orientation, grid, split view

- **Orientation.** The plugin drives `setOrientation({ rotationDeg, flipH })` and draws the compass (A/P); since the rotation is rigid, the scale does not change. The administrator saves the pose with the dataset (`orientation2d`), through the same messages as the 3D orientation (§ 13.9).
- **Calibrated grid.** A **1-2-5** step nearest to 120 px (coarse) or 60 px (fine), anchored on the corner of the oriented image; the labels (distance from the corner) only appear if the step exceeds 44 px. Without calibration, it says so instead of drawing nothing.
- **Scale bar.** `length = nearest 1-2-5 (120 px / px per µm)`; it only exists if the photograph is calibrated.

![The split view exchanges a physical view, not pixels.](img-en/ch13/2d-vue-physique.svg){width=94%}

The **physical view** is the pair `umPerCss = pixel size / scale` and `centerUm` (the offset of the screen centre from the photo centre, in µm). Two photos at 2.0 and 3.2 µm/px are thus at the same **real** magnification, and moving one moves the other by the same real distance.

### The collection

The contact sheet (<kbd>B</kbd> key) is sorted by stage, then dissection date, then name; it can be filtered by stage, by line and by text (name, stage, line, staining, description, date).

![The collection's contact sheet (two demo photographs).](img-en/ch13/2d-planche-contact.png){.shot width=96%}

- Once the photograph is on screen and the page is idle (400 ms), the **two neighbours** are preloaded (preview and native). Neither a Compare panel, nor the split view, nor the administration preview does so: it would multiply the downloads.
- Moving from one photo to another updates the address with the browser history (`pushState`); the Back button returns to the previous photograph without reloading the page.
- A photograph's **measurements** are kept in memory by identifier: returning to a photo restores them.

### The figure sheet

![Same physical scale, or same size: two ways of composing.](img-en/ch13/2d-planche.svg){width=94%}

In "same physical scale" mode, each photograph is brought to the selection's **coarsest pixel** (`factor = px_i / px_max`, hence never an enlargement) and one common bar holds for all. In "same size" mode, each photograph fills the same cell, with its own bar. An **uncalibrated** photo does not take part in the common scale: it is fitted into the cell and marked as such.

The Studio receives **one calibration rectangle per panel**: a bar placed on a panel reads that panel's µm/pixel, and follows it if moved to another. Limits: 6,000 px wide, 16,000 px a side, 120 megapixels (the figure is reduced to fit), 48 megapixels of decoded photographs kept between renders, 3 decodes in parallel.

### The 2D importer

![From the ImageJ export to the data folder.](img-en/ch13/2d-importeur.svg){width=94%}

`preprocess/2d_importer.py` (version 0.18.0) turns **one TIFF into one dataset**.

```
python 2d_importer.py --input <folder|file.tif> --output DATA_WEB \
    [--line DLL4xCD1] [--staining X-gal] [--only "*E8.0*"] \
    [--with-downloads] [--force] [--lossless]
```

| Option | Effect |
|---|---|
| `--line`, `--staining` | what the file does not say (line, staining) |
| `--only` | a name filter ("*E8.0*") |
| `--with-downloads` | puts the original TIFF and a `README.txt` in `download/` |
| `--force` | re-imports while **keeping** what the laboratory has corrected |
| `--lossless` | lossless WebP (larger) |

**Reading the planes.** An ImageJ hyperstack stores its pages "channel first": the first `channels=` pages form **one** composite; the following ones are other images, which are not added together. The composite is additive, exactly what ImageJ displays: `output = Σ table_c[plane_c]`, each 8-bit plane going through its 768-byte **colour table** (3 ramps of 256). Without a table, three planes are read as R, G, B and one plane as a grey. A 16-bit plane is brought down to 8 by its maximum.

**The pixel size.** ImageJ writes the resolution (tags 282 and 283) in **pixels per unit**. The importer only believes it if the description's unit is the **micron**; a pixel's size is then `1 / resolution`, in x and y (square if only the x resolution exists). Otherwise: `calibrationStatus: unknown`, no scale bar, no measurement, and the text says so.

**The Leica block.** ImageJ embeds the LAS X text. For the series that is read, the importer keeps the zoom, magnification, objective, numerical aperture, exposure (converted to ms), gain, microscope and camera. The text repeats each key per work block; the top-level line (the one for the exposure actually taken) wins, and padding "0"s never take precedence over a real value.

**The file name.** `<lif> - <stage> x<zoom> <date yymmdd> [<n> [<m>]]`. The stage goes through **the same parser as the volumes** (`E8-5`, `E8.5`, `E85` all mean E8.5), the date must be a real day, the line is read from the `.lif` name (`DLL4xCD1`). Nothing is invented: a missing part stays empty.

::: example
"DLL4xCD1 - E9.5 x3.2 240913 1.tif" gives the folder `DLL4xCD1-E95-x3.2-240913-1`, stage E9.5, zoom ×3.2, dissected on 2024-09-13, index 1. Folder: `<line>-<stage without dot>-x<zoom>-<yymmdd>-<index>`.
:::

**The files written.** `image.webp` (native, quality 90, method 6, or lossless), `preview.webp` (long side 640 px, LANCZOS, quality 80), `thumbnail.webp` (512 px square on a `#080a12` background), `metadata.json` (written **last**, atomically: a half-finished import is never mounted). Maximum side: 16,383 px (WebP's limit).

::: why
**Why `--lossless` exists.** Lossy WebP subsamples colour (4:2:0), which disturbs the per-pixel B/R ratio that stain isolation reads, especially at sharp edges. For a stain analysis, keep the photo exact.
:::

Two TIFFs that describe themselves in the same way (same line, stage, zoom, date, index) produce the same folder name: the second is **refused** with a message, rather than overwriting the first or being taken for already imported. An existing folder is not touched without `--force`.

::: remember
- Three frames of reference (image, oriented, canvas) and **one** relation: `L / pixelSizeUm × scale`.
- Settings and isolation: a **256-value table** or a computation in a **worker**, on a copy.
- Isolation takes priority over the settings; nothing measured reads them.
- The importer guesses nothing: pixel size from the TIFF tags, stage from the name, the rest from the command line.
:::

## 13.6 The timeline and live series

::: tldr
- The timeline is a **self-contained component** (`Timeline`): a clock, a track, a buffer. The viewer tells it when to wait.
- The clock never **skips** a run of frames, and never **runs ahead of** a frame that has not arrived.
- Real time is not displayed, but the interval between frames is used for speeds in µm/min.
:::

Chapter 10 (§ 10.7) explained how a series is loaded (buffer, preloading, last frame only). Here is the clock itself.

### One tick of the clock

![The five stages of a playback step.](img-en/ch13/frise-boucle.svg){width=94%}

::: example
At 10 frames per second, on a 60 Hz screen, each step lasts about 16.7 ms: the head advances by `10 × 0.0167 ≈ 0.17` frame. It takes **six steps** to change the displayed frame. A tab asleep for one second would not advance the head by 10 frames: the elapsed time is capped at **250 ms**, i.e. 2.5 frames at most.
:::

| Constant | Value |
|---|---|
| Offered speeds | 0.5 · 1 · 2 · 5 · 10 · 20 frames/s |
| Default speed | 10 frames/s |
| Maximum step | 250 ms |
| Frame-wait guard | 15 s |
| Browser key | `iribhm.viewer.playbackFps` |

A click on the speed moves to the **first speed strictly higher** than the current one, and wraps at the top. A remembered speed that is not in the list stays usable: it simply moves on to the next one.

### Waiting without blocking

A native frame may take 600 ms to stream. Without precaution, the clock would advance six frames in that time, and the loader would be sent chasing a frame nobody will see. The viewer therefore **holds the clock back** (`setStalled`) while it loads the frame it was asked for: the head no longer moves, but the loop keeps running.

::: why
**Why the 15 s guard?** A load may never finish (a background tab freezes the display, and the loader waits for a frame to draw). Without a cap, the timeline would stay frozen for ever. The viewer does not count loads in progress either: it releases the clock at **every** end of load, which at worst may free it a little early, never block it.
:::

The track is drawn at `frame / (N − 1)`. When you grab it, playback **pauses** and the frame is the one under the cursor; releasing rounds to the whole frame. The Play button reacts to the press (not the release), and stays usable from the keyboard.

The counter text is `current / last`, on three digits: "000 / 003" means frame 0 of a 4-frame series. The frames **already in memory** are drawn as bands under the track: a series fills up around the head and loses frames on the way, so a simple width would not suffice. Frame `i` occupies the interval `[i − ½; i + ½]` so that the head stays inside the band that represents it.

### Real time and normalisation

- `timeline.intervalMinutes` and `timeline.timestamps` are in `metadata.json`. **The timestamps are not displayed**, but the interval lets the inspector give a cell's speed in **µm/min** as well as µm/frame.
- The pipeline also records `intensityNormalization` (the signal levels of each channel and each frame) so that photobleaching can be **measured**. **No viewer setting uses it today**: a series that fades really does display darker.
- The component can also smooth (fractional positions) and display speed sliders; the viewer does not use them.

::: note
Two series of different lengths in Compare are aligned by **fraction** of duration (§ 13.4): "half of the series" is half of each.
:::

## 13.7 What the platform remembers: link, workspace, browser

::: tldr
- Four places: the **page's memory**, the **address**, the **browser**, the server (which remembers none of your settings).
- The address carries the whole state of a view, compressed: it **serves as a backup**.
- Every browser access is protected: with storage blocked or private browsing, the page works and forgets.
:::

![Where what you set lives.](img-en/ch13/etat-lieux.svg){width=94%}

### The `#state=` link

![From the page state to the address.](img-en/ch13/etat-hash.svg){width=96%}

Every second, the page asks `_getWorkspaceState()` for its state. It gathers three blocks: `ui` (active tool, sidebar, background), `viewer` (camera, cutting plane, measurements, channels, exposure, grid, Z stretch, Z-stack, series frame, quality, calibration…) and `plugins` (the state each tool exposes through `getState()`).

::: example
The viewer state of the demo E95 dataset, at rest: **2,580 characters** of JSON, which become **1,362 characters** once compressed (deflate) and written in base64url. The camera fits on one line: `{"kind":"volume","cameraZ":1.13,"quaternion":[0,0,0,1],"position":[0,0,0],"zDisplayScale":1}`.
:::

The state is **encoded** only if it has changed, according to a **fingerprint** (the JSON without the counters that move by themselves, like the brick cache). The dataset opened as-is is the reference: as long as nothing has changed, the address stays clean; returning exactly to the opening state cleans it. The [Reset the workspace]{.ui} button re-adopts the opening state as the new reference, after letting the end of a reload settle (two identical reads in a row, or a delay).

::: tech
- **Writing**: at most 64 KiB of text, otherwise the address is no longer updated (an old `#state=` would be more wrong than none) and the console invites you to use "Save state".
- **Reading**: 2 MiB of text at most; decompression is read in chunks and **stopped at 16 MiB** (a booby-trapped link can inflate by a factor of ~1,000).
- **Generation**: any action that invalidates the address (clearing, new reference) increments a counter; a compression that finishes afterwards **discards** its result instead of resurrecting the cleared state.
- No network call: the link contains the state, the server never sees it.
:::

When a link is opened, a dialogue asks: [Open the saved view]{.ui} or [Open the dataset as new]{.ui}. Escape and the backdrop mean "open the view" (what a link did before the question). Unreadable content is cleared without asking. In a Compare panel there is no question: the host decides.

### Browser workspaces

`WorkspaceState` stores a workspace under the key `iribhm.workspace.<scope>.<dataset identifier>` (scope: `viewer`, `compare`…), version 2, with the date. It is normalised into four blocks (`ui`, `viewer`, `tracking`, `compare`). Writing may **fail** (quota, blocked storage): the error is deliberately handed back to the caller, so that a workspace that was not saved is never announced as saved. Keys from before the renaming of the types (`fixed`, `wholemount`) are migrated once, in passing.

The viewer has **no** Save / Restore buttons: the address does that. They exist in the **Compare** page (Download Center) and in the Studio (JSON).

### What your browser keeps

| Key | Content |
|---|---|
| `iribhm-theme`, `iribhm-lang`, `iribhm-colorblind` | theme, language, colour-blind filter (shared between pages and frames by the `storage` event) |
| `iribhm.viewer.playbackFps` | timeline speed |
| `iribhm.viewer.zScale.<dataset>` | Z stretch of that dataset |
| `iribhm.workspace.<scope>.<dataset>` | a saved workspace |
| `iribhm-gallery-dock` | gallery dock state (open, wide, chip) |
| `lumen3d.vramBudgetMB` | imposed video-memory budget (operator) |
| `lumen3d.gpuContextLosses` | the last 8 graphics-context losses (one week) |
| `sessionStorage` `lumen_view_<dataset>` | a single view counted per session |

::: note
**Measurements** are not in this list: they live in the page's memory (`MeasurementStore`, a `Map` per scope and per dataset) and travel **in the link**. The administration has its own keys (`adm-theme`, `adm-upload-dock-size`, `lumen-dupd-*`), described in chapter 14.
:::

The graphics budget is worth knowing about (§ 10.4): it is **halved for each graphics-context loss** of the past week (floor 256 MiB), on that browser profile. Clearing the site data resets it.

## 13.8 Measurement and pose algorithms

::: tldr
- A measurement click reads the **depth on the GPU** in two one-pixel passes, with 16-bit precision.
- Laying a stack flat is **two rotations about the screen axes**: the stack never tumbles.
- Exporting a large image **starts over** if the volume or the settings change while it renders.
:::

### The depth under the cursor

Chapter 12 (§ 12.2) described the logic: the ray's maximum, then the first crossing of 55%. Here is the mechanism.

![The two passes of a pixel and the 16-bit encoding.](img-en/ch13/pick-encodage.svg){width=94%}

![The three sources of a point, in the order in which they are tried.](img-en/ch13/pick-ordre.svg){width=94%}

::: tech
- The render of a pixel uses **the same uniforms** as the screen: same window, channels on, crop, Z-stack slab, stabilisation, bricks. It is framed by `camera.setViewOffset` on the clicked pixel.
- The constants are `PICK_SURFACE = 0.55`, `PICK_MIN_VALUE = 0.02`, `PICK_MAX_STEPS = 4096`; the step is half a voxel (`1 / (2·nu)`), lengthened if the ray would exceed 4,096 steps.
- Under stabilisation, the encoded position is that of the **display box** (`clipBoxMin + c · clipBoxSize`); without stabilisation, that of the unit box. The decoder handles both.
- A graphics-context loss, or the absence of an active volume, removes the GPU path: the point falls back to the box, and the measurement tool **refuses** that point.
:::

### Laying the stack flat: opening the Z-stack

Chapter 12 (§ 12.4) says the stack "lays itself flat in 1.5 s". Here is the geometry, which also serves the sample side (§ 13.9).

![Two rotations about the screen axes, computed for an example.](img-en/ch13/poses-tilt.svg){width=94%}

`setView(view, options)` accepts several ways of choosing **the in-plane angle** of the view:

| `spin` | Choice |
|---|---|
| `'frame'` (default) | the in-plane rotation nearest the calibrated frame |
| `'nearest'` | the one nearest the **current** pose (the smallest movement, usually about an oblique axis) |
| `'tilt'` | **the one obtained by the two rotations** above; used by the Z-stack |
| a number | degrees counted from the frame |

The **side** (`side`) is `front`, `back` (the front pose turned a half-turn about the vertical), or `top` / `bottom`: the upper and lower faces of the specimen, resolved according to `upsideDown`. The animation is an interpolation from one end to the other, with an easing of `3t² − 2t³`; the two rotations of `'tilt'` grow together so as to read as a single gesture. A camera is notified **only once**, on arrival, so that the Compare panels see the final pose; grabbing the mouse cancels the flight.

### Exporting a very large view

The export (§ 12.6) renders the view **in tiles** of at most 2048 px (less if the graphics card cannot, down to 256 px as a last resort). To make the large image consistent, `renderViewImage`:

- takes the **starting pose** once (the one where a flight in progress lands), with the aspect ratio of the requested image;
- waits for the volume to **finish streaming**, then renders one tile per task;
- checks before **each tile** that the active volume is the same and that the display fingerprint (channels, exposure, render mode, crop, grid and axes, Z stretch) has not changed;
- otherwise **clears and starts over**, three times at most (errors `unstable` or `display-changed` afterwards);
- continues the random grain from one tile to the next (`fragCoordOffset`) so that no seam shows, and writes a transparent background through a per-pixel opacity (`exportAlpha`).

The other errors have a readable code: `busy` (an export is already running), `size`, `canvas` (the browser refuses an image that large), `gpu-memory`, `context-lost`.

## 13.9 Orientation in practice, and the sample side

::: tldr
- Three poses: **Q_base** (the frame), **Q_anat** (the anatomy on screen), **Q_cube** (the volume). Two products link them.
- The administrator never computes a quaternion: they **ask** the plugin, which answers by message.
- The **sample side** corrects an Imaris file that shows the specimen seen from below.
:::

Chapter 12 (§ 12.5) gave the theory in one sentence. Here is the complete mechanism, as the administrator handles it (chapter 14, and the administrator guide § 3.8).

![The three poses and the two quaternion products.](img-en/ch13/orientation-reperes.svg){width=94%}

### What `metadata.json` stores

| Field | Role |
|---|---|
| `orientation` | **Q_base**: the cube pose for which the anatomy coincides with the screen axes |
| `orientationAxes.labels` | the names the operator gave the six arms (empty: R1/R2, G1/G2, B1/B2) |
| `orientationAxes.hidden` | the arms that are not drawn (they are not even **built**) |
| `orientationAxes.defaultView` | the opening view: `Q_anat` (a preset and/or a quaternion) |
| `upsideDown` | the file shows the specimen seen from below |

The arms have **storage identifiers** (R/L for ±X in red, A/P for ±Y in green, V/D for ±Z in blue) that impose no nomenclature: you name them as you wish.

### The conversation between the administration and the viewer

The administration preview is the real viewer, in a frame. The panel computes **no geometry**: it sends messages to the *Orientation Axes* plugin and stores what comes back. Only one implementation of the geometry exists.

| The panel sends… | The plugin answers / does |
|---|---|
| `CALIBRATE_ORIENTATION_START` | starts again from the **saved** alignment (you refine it, you do not start over), locks the compass to the screen axes, shows it |
| `GET_ORIENTATION` | `ORIENTATION_RESULT`: the cube's current pose, to be saved as `Q_base` |
| `SET_ORIENTATION_AXES` | live preview of the arms' names and visibility |
| `APPLY_ORIENTATION_VIEW` | poses the volume and returns `ORIENTATION_VIEW_RESULT` with the `Q_anat` to store |
| `GET_ORIENTATION_VIEW` | captures the **current** pose as the default view (as `Q_anat`) |
| `SET_SAMPLE_UPSIDE_DOWN` | previews the upper face; answers `SAMPLE_SIDE_RESULT` |

::: tech
- **The six presets** are each two constraints: which anatomical direction faces the camera (the screen's +Z), which points up (+Y). The single rotation that satisfies them is obtained by building the `(right, up, facing)` basis and taking the inverse. Ventral: facing V, up A; dorsal: facing D, up A; left / right: facing L / R, up A; anterior / posterior: facing A / P, up D.
- **The default view is applied before the first brick** (`prepare()`, called between the viewer's initialisation and the first load): turning afterwards would show the volume in one pose and then snap it into another while the bricks arrive. It is recorded as the viewer's **home pose**: the [Reset view]{.ui} button returns to it, not to the file's raw axes.
- **A default view is stored as Q_anat**, a statement about the anatomy ("ventral toward me"), so refining the calibration later does not make it stale.
- When a dataset has **no** calibration, the arms start from the file's raw pose (turned over if `upsideDown`).
- The compass is driven by `Q_cube · Q_base⁻¹`; its central sphere moves by dragging, and its position is in the workspace.
:::

### The sample side

![The administration preview: 3D orientation and axes gizmo.](img-en/ch13/admin-orientation.png){.shot width=88%}

::: legend
| n | what it is |
|---|---|
| 1 | **Sample side**: two radio buttons |
| 2 | [🧭 Define orientation]{.ui}: places the axes gizmo in the preview |
| 3 | **Displayed axes**: tick, hide, rename |
| 4 | **Default view**: the dataset's opening pose |
| 5 | [📌 Use the current view]{.ui}: captures the preview's pose |
:::

A confocal stack exported from Imaris is **usually seen from below**: an inverted microscope's objective is under the specimen. The viewer calls the −Z face the "top" in that case (`upsideDown: true`), and the raw pose of an uncalibrated dataset is turned over by a **half-turn about the screen's vertical**: left and right swap, up stays up.

::: why
**Why a half-turn about the vertical and not about the file's X axis?** As soon as a calibration has tilted the file's axes on screen, a half-turn about the file's X axis looks like a diagonal tumble. About **the screen's** vertical, it is always the same gesture, whatever the pose.
:::

The administration's switch **previews** the upper face: it lays the volume flat (`'tilt'`, 1 s) facing you. That is exactly what the Z-stack browser will then show.

![After choosing "Upside down": the preview lays itself flat, the chosen face toward you (same numbered callouts).](img-en/ch13/admin-sens-echantillon.png){.shot width=88%}

- **Neither Q_base nor a default view depends on the side**: both are poses of the anatomy; the editor only stores the flag.
- The side is taken into account by the initial view of an uncalibrated dataset, the reset button, the "3d" view, the Z-stack and the Studio figures (180° yaw on the −Z face).

::: warning
A dataset whose side was switched under platform version 1.55.7 has a distorted frame (it had been turned about the file's X axis). Its orientation must be **defined again**.
:::

## 13.10 Gallery, linked datasets, thumbnail

::: tldr
- The **gallery** adds images (annotated captures, diagrams) to a dataset; their type comes from the **magic bytes**, never from the name.
- **Linked datasets** are deduced from four rules, with nothing to enter.
- The explorer's **thumbnail** is a 512 × 512 capture that the administrator chooses.
:::

### The image gallery

![The path of an image, from upload to the viewer.](img-en/ch13/galerie-chemin.svg){width=94%}

The API accepts a **raw** image body (up to the server's limit) or, historically, a `data:` URL. In both cases the type is recognised from its **magic bytes** (WebP, PNG, JPEG, GIF); the file name is only used to make a readable name (letters, digits, hyphens, 60 characters at most, numbered in case of a duplicate). A file that is too large (8 MiB), a 41st upload or content that is not an image are refused.

The 320 px **thumbnail** serves the dock's grid: forty originals must not compete for the connections the brick packs need. Without Pillow or without WebP on the server, it falls back to JPEG, or is omitted. An image for a dataset **still being imported** is refused (409): publish first.

On the page side, `DatasetGallery` builds its DOM only with `createElement`, never by concatenating text: captions are operator text and file names come from the disk.

### Linked datasets

![The four natures of a link between two datasets.](img-en/ch13/relations.svg){width=94%}

`Catalog.getRelated(id)` returns the datasets that share **the same embryo and the same stage**, **the same dissection date and the same stage**, or that a `relatedIds` designates (in either direction). `getRelationMeta` then gives the **nature** of the link, testing in this order: *registered* (a registration block exists), *related* (explicit link), *same-embryo*, *context* (the rest). The explorer shows the "Linked" badge; the 2D page and the viewer list the linked datasets of another type: a photograph points to the volume of the same embryo.

### The explorer thumbnail

![From the administration preview to thumbnail.webp.](img-en/ch13/vignette-chemin.svg){width=94%}

The [Reset the preview]{.ui} button asks the preview viewer for a capture. If a slice or the Z-stack is open, **that** is what is photographed (rendered at 1024 px); otherwise the 3D canvas. The image is placed at the centre of a 512 × 512 px square with a `#080a12` background **without distortion**, then encoded as WebP (quality 0.9). The server checks the magic bytes and a size of at most 5 MiB before writing `thumbnail.webp`.

::: see
- The format of the `planes/` and `mips/` folders, and the migration journal: chapters 7 and 17.
- The plugin system (`contexts`, `dataTypes`) and trust: chapter 15.
- The exact names of the administration screens: chapter 14 and the administrator guide.
:::

::: remember
This chapter on one page:

- **Tracking**: instanced spheres, 32-bit arrays, one shared facade.
- **Stabilisation**: `volumeWarp = toTex · M⁻¹ · toUm`; no voxel retouched.
- **Studio**: a document without pixels, recolouring from raw values, native pass plane / atlas, token.
- **Compare**: real pages, verified messages, 1.5 GiB budget, time by fraction.
- **2D**: three frames of reference, a pixel worker, an importer that guesses nothing.
- **Timeline**: clock capped at 250 ms, held back during loading.
- **State**: the link is the backup; the browser only keeps preferences.
- **Measurement**: depth read on the GPU in two 16-bit passes; poses by two rotations.
- **Orientation**: Q_base, Q_anat, Q_cube; the sample side is a half-turn about the vertical.
:::
